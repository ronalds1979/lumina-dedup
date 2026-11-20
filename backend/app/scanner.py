import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional
from PIL import Image, ExifTags

from .config import ALL_MEDIA_EXTENSIONS, PHOTO_EXTENSIONS, VIDEO_EXTENSIONS
from .database import db_session
from . import media_utils  # noqa: F401 - applies Image.MAX_IMAGE_PIXELS guard

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


def _walk_media(root_path: str):
    stack = [root_path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    name_lower = entry.name.lower()
                    if entry.is_dir(follow_symlinks=False):
                        if name_lower not in IGNORED_DIRS and not name_lower.startswith("."):
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
                root = str(Path(raw_root).resolve())
                if not os.path.isdir(root):
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
    except Exception as exc:
        scan_progress.phase = "error"
        scan_progress.error = str(exc)
        scan_progress.message = f"Scan failed: {exc}"
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
