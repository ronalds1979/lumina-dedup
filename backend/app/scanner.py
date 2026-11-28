import logging
import os
import stat
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional
from PIL import Image, ExifTags

from .config import ALL_MEDIA_EXTENSIONS, BASE_DIR, DATA_DIR, DEFAULT_QUARANTINE_DIR, PHOTO_EXTENSIONS, VIDEO_EXTENSIONS
from .database import db_session
from . import media_utils  # noqa: F401 - applies Image.MAX_IMAGE_PIXELS guard

logger = logging.getLogger(__name__)

IGNORED_DIRS = {
    ".lumina_quarantine",
    ".lumina_data",
    "$recycle.bin",
    "system volume information",
    ".git",
    "node_modules",
    "__pycache__",
}

EXIF_DATE_TAG = 36867  # DateTimeOriginal
EXIF_MODEL_TAG = 272   # Model


def _protected_dirs() -> list[Path]:
    dirs = [BASE_DIR.resolve(), DATA_DIR.resolve(), DEFAULT_QUARANTINE_DIR.resolve()]
    dirs.extend(
        Path(os.environ[k]).resolve()
        for k in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData")
        if os.environ.get(k)
    )
    return dirs


def _is_system_root(resolved: Path) -> bool:
    if len(resolved.parts) > 1:
        return False
    if not resolved.drive:
        return True
    sys_drive = (
        os.environ.get("SystemDrive")
        or Path(os.environ.get("SystemRoot", "C:\\Windows")).drive
    ).rstrip("\\/").upper()
    return bool(sys_drive) and resolved.drive.rstrip("\\/").upper() == sys_drive


def validate_scan_root(raw_path: str) -> str:
    """Validate a user-supplied scan root against UNC leaks, reparse traversal, and protected dirs."""
    # 🛡️ Sentinel: Block UNC/device paths before os.path/stat calls to prevent SMB Net-NTLM leaks
    p = (raw_path or "").strip()
    if not p or p.startswith(("\\\\", "//")):
        raise ValueError(f"Network or device paths are not allowed: {raw_path}")
    if os.name == "nt" and len(p) == 2 and p[0].isalpha() and p[1] == ":":
        p = p + "\\"
    if os.path.islink(p):
        raise ValueError(f"Symlink scan roots are not allowed: {raw_path}")
    try:
        lst = os.lstat(p)
    except OSError as exc:
        raise ValueError(f"Invalid scan directory: {raw_path}") from exc
    reparse_attr = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    if stat.S_ISLNK(lst.st_mode) or (reparse_attr and (getattr(lst, "st_file_attributes", 0) & reparse_attr)):
        raise ValueError(f"Reparse-point scan roots are not allowed: {raw_path}")
    resolved = Path(p).resolve()
    if not resolved.is_dir():
        raise ValueError(f"Non-directory paths are not allowed: {raw_path}")
    if _is_system_root(resolved):
        raise ValueError(f"System drive root cannot be scanned directly; choose a subfolder: {raw_path}")
    protected = _protected_dirs()
    if any(resolved == b or resolved.is_relative_to(b) for b in protected):
        raise ValueError(f"Protected system or application directory cannot be scanned: {raw_path}")
    return str(resolved)


@dataclass
class TaskProgress:
    running: bool = False
    phase: str = "idle"
    message: str = ""
    processed: int = 0
    total: int = 0
    current_path: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0
    error: Optional[str] = None

    def reset(self, phase: str, message: str) -> None:
        self.running = True
        self.phase = phase
        self.message = message
        self.processed = 0
        self.total = 0
        self.current_path = ""
        self.started_at = time.time()
        self.finished_at = 0.0
        self.error = None

    def to_dict(self) -> dict:
        d = asdict(self)
        elapsed = (self.finished_at or time.time()) - self.started_at if self.started_at else 0.0
        d["elapsed_seconds"] = round(max(0.0, elapsed), 2)
        d["rate_per_sec"] = round(self.processed / elapsed, 1) if elapsed > 0.2 and self.processed > 0 else 0.0
        return d


scan_progress = TaskProgress()
_scan_lock = threading.Lock()


def _extract_image_meta(path: str) -> tuple[Optional[int], Optional[int], Optional[str], Optional[str]]:
    try:
        with Image.open(path) as img:
            width, height = img.size
            exif_date = None
            camera_model = None
            exif = img.getexif()
            if exif:
                raw_date = exif.get(EXIF_DATE_TAG) or exif.get(306)
                if raw_date:
                    exif_date = str(raw_date).strip()
                raw_model = exif.get(EXIF_MODEL_TAG)
                if raw_model:
                    camera_model = str(raw_model).strip()[:80]
            return width, height, exif_date, camera_model
    except Exception:
        return None, None, None, None


def _is_reparse_dir(path: str) -> bool:
    """Detect Windows NTFS junctions and reparse points that DirEntry.is_dir(follow_symlinks=False) treats as dirs."""
    is_junction = getattr(os.path, "isjunction", None)
    if os.path.islink(path) or (callable(is_junction) and is_junction(path)):
        return True
    reparse_attr = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    if reparse_attr:
        try:
            return bool(getattr(os.lstat(path), "st_file_attributes", 0) & reparse_attr)
        except OSError:
            return True
    return False


def _walk_media(root_path: str):
    protected_norm = {os.path.normcase(str(d)) for d in _protected_dirs()}
    stack = [root_path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    name_lower = entry.name.lower()
                    if entry.is_dir(follow_symlinks=False):
                        # 🛡️ Sentinel: Skip nested NTFS junctions/reparse points and protected dirs to prevent root escape and cyclic loops
                        if (
                            name_lower not in IGNORED_DIRS
                            and not name_lower.startswith(".")
                            and os.path.normcase(os.path.abspath(entry.path)) not in protected_norm
                            and not _is_reparse_dir(entry.path)
                        ):
                            stack.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        ext = os.path.splitext(name_lower)[1]
                        if ext in ALL_MEDIA_EXTENSIONS:
                            yield entry, ext
        except (PermissionError, OSError):
            continue


EXIF_ELIGIBLE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".tif", ".bmp"}


def _flush_pending_meta(
    pending: list[tuple[int, str, str, str, str, str, int, float, bool]],
    pool: Optional[ThreadPoolExecutor],
    batch: list[tuple],
    now: float,
) -> None:
    if not pending:
        return
    if pool is not None:
        meta_indices = [idx for idx, item in enumerate(pending) if item[8]]
        meta_results: dict[int, tuple[Optional[int], Optional[int], Optional[str], Optional[str]]] = {}
        if meta_indices:
            paths = [pending[idx][1] for idx in meta_indices]
            for idx, res in zip(meta_indices, pool.map(_extract_image_meta, paths)):
                meta_results[idx] = res
        for idx, (root_id, full_path, folder, filename, ext, media_type, size, mtime, _) in enumerate(pending):
            width, height, exif_date, camera_model = meta_results.get(idx, (None, None, None, None))
            batch.append((
                root_id, full_path, folder, filename, ext, media_type,
                size, mtime, width, height, exif_date, camera_model, now,
            ))
    else:
        for root_id, full_path, folder, filename, ext, media_type, size, mtime, _ in pending:
            batch.append((
                root_id, full_path, folder, filename, ext, media_type,
                size, mtime, None, None, None, None, now,
            ))
    pending.clear()
    if len(batch) >= 2000:
        _flush_batch(batch)
        batch.clear()


def run_scan(paths: list[str], extract_exif: bool = True) -> None:
    with _scan_lock:
        if scan_progress.running and scan_progress.phase != "starting":
            return
        scan_progress.reset(phase="scanning", message="Discovering media files...")

    try:
        now = time.time()
        batch: list[tuple] = []
        pending: list[tuple[int, str, str, str, str, str, int, float, bool]] = []
        total_files = 0
        total_bytes = 0

        pool = ThreadPoolExecutor(max_workers=8) if extract_exif else None
        try:
            for raw_root in paths:
                try:
                    root = validate_scan_root(raw_root)
                except ValueError:
                    continue

                with db_session() as conn:
                    conn.execute(
                        """
                        INSERT INTO scan_roots (path, last_scanned_at)
                        VALUES (?, ?)
                        ON CONFLICT(path) DO UPDATE SET last_scanned_at=excluded.last_scanned_at
                        """,
                        (root, now),
                    )
                    root_id = conn.execute("SELECT id FROM scan_roots WHERE path = ?", (root,)).fetchone()["id"]

                root_count = 0
                root_bytes = 0

                for entry, ext in _walk_media(root):
                    try:
                        stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue

                    size = stat.st_size
                    mtime = stat.st_mtime
                    full_path = entry.path
                    folder = os.path.dirname(full_path)
                    filename = entry.name
                    media_type = "photo" if ext in PHOTO_EXTENSIONS else "video"
                    needs_exif = extract_exif and media_type == "photo" and ext in EXIF_ELIGIBLE_EXTENSIONS

                    pending.append((
                        root_id, full_path, folder, filename, ext, media_type,
                        size, mtime, needs_exif,
                    ))

                    total_files += 1
                    total_bytes += size
                    root_count += 1
                    root_bytes += size

                    if len(pending) >= 256:
                        _flush_pending_meta(pending, pool, batch, now)

                    if total_files % 25 == 0 or total_files == 1:
                        scan_progress.processed = total_files
                        scan_progress.current_path = folder
                        scan_progress.message = f"Indexed {total_files:,} media files..."

                _flush_pending_meta(pending, pool, batch, now)
                if batch:
                    _flush_batch(batch)
                    batch.clear()

                with db_session() as conn:
                    conn.execute(
                        "UPDATE scan_roots SET file_count = ?, total_bytes = ?, last_scanned_at = ? WHERE id = ?",
                        (root_count, root_bytes, time.time(), root_id),
                    )
        finally:
            if pool is not None:
                pool.shutdown(wait=True)

        scan_progress.processed = total_files
        scan_progress.total = total_files
        scan_progress.phase = "completed"
        scan_progress.message = f"Scan complete: {total_files:,} media files indexed."
        scan_progress.finished_at = time.time()
        scan_progress.running = False
    except Exception:
        # 🛡️ Sentinel: Log internal exception server-side without exposing raw OS/SQLite error strings via /api/scan/status
        logger.exception("Folder scan failed")
        scan_progress.phase = "error"
        scan_progress.error = "Folder scan failed. Check server logs for details."
        scan_progress.message = "Folder scan failed. Check server logs for details."
        scan_progress.finished_at = time.time()
        scan_progress.running = False


def _flush_batch(batch: list[tuple]) -> None:
    with db_session() as conn:
        conn.executemany(
            """
            INSERT INTO media_files (
                root_id, path, folder, filename, ext, media_type,
                size, mtime, width, height, exif_date, camera_model, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                size=excluded.size,
                mtime=excluded.mtime,
                width=COALESCE(excluded.width, media_files.width),
                height=COALESCE(excluded.height, media_files.height),
                exif_date=COALESCE(excluded.exif_date, media_files.exif_date),
                camera_model=COALESCE(excluded.camera_model, media_files.camera_model),
                updated_at=excluded.updated_at
            """,
            batch,
        )
