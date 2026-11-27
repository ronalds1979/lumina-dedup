import os
import shutil
import stat
import time
import uuid
from pathlib import Path
from typing import Optional
from send2trash import send2trash

from .config import DEFAULT_QUARANTINE_DIR
from .database import db_session


def is_unsafe_local_path(path: str) -> bool:
    """Reject UNC/device paths and symlinks/NTFS junctions/reparse points across the path lineage."""
    # 🛡️ Sentinel: Block UNC/device prefixes before lstat/exists and detect NTFS junctions across parent dirs
    if not path or not isinstance(path, str) or "\x00" in path:
        return True
    normalized = path.replace("/", "\\")
    if normalized.startswith(("\\\\", "\\??\\")):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    reparse_attr = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    curr = os.path.abspath(path)
    visited: set[str] = set()
    while curr and curr not in visited:
        visited.add(curr)
        if os.path.islink(curr) or (callable(is_junction) and is_junction(curr)):
            return True
        if reparse_attr:
            try:
                if getattr(os.lstat(curr), "st_file_attributes", 0) & reparse_attr:
                    return True
            except OSError:
                pass
        parent = os.path.dirname(curr)
        if parent == curr:
            break
        curr = parent
    return False


def _safe_relative_dest(original_path: str, batch_dir: Path) -> Path:
    p = Path(original_path)
    drive = p.drive.replace(":", "") if p.drive else "root"
    parts = [part for part in p.parts if part not in (p.anchor, p.drive, "\\", "/")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError(f"Unsafe path traversal segment in original_path: {original_path}")
    dest = batch_dir / drive / Path(*parts)
    if not dest.resolve().is_relative_to(batch_dir.resolve()):
        raise ValueError(f"Destination escapes quarantine directory: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        stem = dest.stem
        ext = dest.suffix
        dest = dest.with_name(f"{stem}_{uuid.uuid4().hex[:6]}{ext}")
    return dest


def execute_safe_removal(
    file_ids: list[int],
    mode: str = "quarantine",
    quarantine_root: Optional[str] = None,
) -> dict:
    """
    Safely removes marked files either to Quarantine (reversible inside app)
    or OS Recycle Bin (via send2trash). Never permanently deletes directly.
    """
    if not file_ids:
        return {"batch_id": None, "moved_count": 0, "reclaimed_bytes": 0, "errors": []}

    batch_id = f"batch_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    q_root = Path(quarantine_root) if quarantine_root else DEFAULT_QUARANTINE_DIR
    batch_dir = q_root / batch_id
    now = time.time()

    moved_count = 0
    reclaimed_bytes = 0
    errors: list[dict] = []

    with db_session() as conn:
        # 🛡️ Sentinel: Chunk SQLite IN (...) lookups to stay well below SQLITE_MAX_VARIABLE_NUMBER (32766)
        rows = []
        for idx in range(0, len(file_ids), 500):
            chunk = file_ids[idx : idx + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows.extend(
                conn.execute(
                    f"SELECT id, path, size, status FROM media_files WHERE id IN ({placeholders}) AND status = 'active'",
                    chunk,
                ).fetchall()
            )

        for r in rows:
            fid = r["id"]
            orig = r["path"]
            sz = r["size"]
            if is_unsafe_local_path(orig):
                errors.append({"file_id": fid, "path": orig, "error": "Refusing to remove unsafe or reparse-point path"})
                continue
            if not os.path.exists(orig):
                errors.append({"file_id": fid, "path": orig, "error": "File not found on disk"})
                continue

            try:
                if mode == "trash":
                    send2trash(orig)
                    conn.execute(
                        "UPDATE media_files SET status = 'trashed', updated_at = ? WHERE id = ?",
                        (now, fid),
                    )
                    conn.execute(
                        """
                        INSERT INTO action_logs (batch_id, file_id, action, original_path, dest_path, size, created_at)
                        VALUES (?, ?, 'trash', ?, NULL, ?, ?)
                        """,
                        (batch_id, fid, orig, sz, now),
                    )
                else:
                    dest = _safe_relative_dest(orig, batch_dir)
                    shutil.move(orig, str(dest))
                    conn.execute(
                        "UPDATE media_files SET status = 'quarantined', quarantine_path = ?, updated_at = ? WHERE id = ?",
                        (str(dest), now, fid),
                    )
                    conn.execute(
                        """
                        INSERT INTO action_logs (batch_id, file_id, action, original_path, dest_path, size, created_at)
                        VALUES (?, ?, 'quarantine', ?, ?, ?, ?)
                        """,
                        (batch_id, fid, orig, str(dest), sz, now),
                    )
                moved_count += 1
                reclaimed_bytes += sz
            except Exception as exc:
                errors.append({"file_id": fid, "path": orig, "error": str(exc)})

    return {
        "batch_id": batch_id,
        "mode": mode,
        "moved_count": moved_count,
        "reclaimed_bytes": reclaimed_bytes,
        "errors": errors,
    }


def restore_quarantined_files(file_ids: Optional[list[int]] = None, batch_id: Optional[str] = None) -> dict:
    """Restores quarantined files back to their exact original paths."""
    restored = 0
    restored_bytes = 0
    errors: list[dict] = []
    now = time.time()

    with db_session() as conn:
        if batch_id:
            rows = conn.execute(
                """
                SELECT m.id, m.path, m.quarantine_path, m.size
                FROM action_logs a
                JOIN media_files m ON m.id = a.file_id
                WHERE a.batch_id = ? AND m.status = 'quarantined'
                """,
                (batch_id,),
            ).fetchall()
        elif file_ids:
            rows = []
            for idx in range(0, len(file_ids), 500):
                chunk = file_ids[idx : idx + 500]
                placeholders = ",".join("?" for _ in chunk)
                rows.extend(
                    conn.execute(
                        f"SELECT id, path, quarantine_path, size FROM media_files WHERE id IN ({placeholders}) AND status = 'quarantined'",
                        chunk,
                    ).fetchall()
                )
        else:
            return {"restored": 0, "restored_bytes": 0, "errors": []}

        quarantine_base = DEFAULT_QUARANTINE_DIR.resolve()
        restore_batch = f"restore_{int(now)}_{uuid.uuid4().hex[:6]}"
        for r in rows:
            fid = r["id"]
            orig = r["path"]
            qpath = r["quarantine_path"]
            if not qpath or not os.path.exists(qpath):
                errors.append({"file_id": fid, "path": orig, "error": "Quarantined file missing"})
                continue
            if is_unsafe_local_path(qpath) or is_unsafe_local_path(orig):
                errors.append({"file_id": fid, "path": orig, "error": "Refusing to restore unsafe or reparse-point path"})
                continue
            if os.path.lexists(orig):
                errors.append({"file_id": fid, "path": orig, "error": "Refusing to overwrite existing destination file"})
                continue
            if not Path(qpath).resolve().is_relative_to(quarantine_base):
                errors.append({"file_id": fid, "path": orig, "error": "Quarantine path outside quarantine root"})
                continue
            try:
                os.makedirs(os.path.dirname(orig), exist_ok=True)
                shutil.move(qpath, orig)
                conn.execute(
                    "UPDATE media_files SET status = 'active', quarantine_path = NULL, updated_at = ? WHERE id = ?",
                    (now, fid),
                )
                conn.execute(
                    """
                    INSERT INTO action_logs (batch_id, file_id, action, original_path, dest_path, size, created_at)
                    VALUES (?, ?, 'restore', ?, ?, ?, ?)
                    """,
                    (restore_batch, fid, orig, qpath, r["size"], now),
                )
                restored += 1
                restored_bytes += r["size"]
            except Exception as exc:
                errors.append({"file_id": fid, "path": orig, "error": str(exc)})

    return {"restored": restored, "restored_bytes": restored_bytes, "errors": errors}
