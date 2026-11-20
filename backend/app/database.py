import sqlite3
from contextlib import contextmanager
from typing import Iterator
from .config import DB_PATH


def _configure_connection(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA cache_size=-65536;")
    conn.execute("PRAGMA foreign_keys=ON;")


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30.0)
    _configure_connection(conn)
    return conn


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db_session() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS scan_roots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                last_scanned_at REAL,
                file_count INTEGER DEFAULT 0,
                total_bytes INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS media_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                root_id INTEGER REFERENCES scan_roots(id) ON DELETE CASCADE,
                path TEXT UNIQUE NOT NULL,
                folder TEXT NOT NULL,
                filename TEXT NOT NULL,
                ext TEXT NOT NULL,
                media_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime REAL NOT NULL,
                width INTEGER,
                height INTEGER,
                exif_date TEXT,
                camera_model TEXT,
                partial_hash TEXT,
                sha256 TEXT,
                phash TEXT,
                dhash TEXT,
                embedding BLOB,
                status TEXT NOT NULL DEFAULT 'active',
                quarantine_path TEXT,
                updated_at REAL
            );

            CREATE INDEX IF NOT EXISTS idx_media_folder ON media_files(folder);
            CREATE INDEX IF NOT EXISTS idx_media_ext ON media_files(ext);
            CREATE INDEX IF NOT EXISTS idx_media_size ON media_files(size);
            CREATE INDEX IF NOT EXISTS idx_media_type ON media_files(media_type);
            CREATE INDEX IF NOT EXISTS idx_media_status ON media_files(status);
            CREATE INDEX IF NOT EXISTS idx_media_partial ON media_files(partial_hash);
            CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media_files(sha256);
            CREATE INDEX IF NOT EXISTS idx_media_phash ON media_files(phash);
            CREATE INDEX IF NOT EXISTS idx_media_dhash ON media_files(dhash);
            CREATE INDEX IF NOT EXISTS idx_media_mtime ON media_files(mtime);

            CREATE TABLE IF NOT EXISTS duplicate_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                approach TEXT NOT NULL,
                signature TEXT NOT NULL,
                file_count INTEGER NOT NULL,
                total_size INTEGER NOT NULL,
                reclaimable_size INTEGER NOT NULL,
                primary_folder TEXT,
                primary_ext TEXT,
                ai_analyzed INTEGER DEFAULT 0,
                ai_best_file_id INTEGER,
                ai_confidence TEXT,
                ai_summary TEXT,
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_groups_approach ON duplicate_groups(approach);
            CREATE INDEX IF NOT EXISTS idx_groups_reclaimable ON duplicate_groups(reclaimable_size DESC);
            CREATE INDEX IF NOT EXISTS idx_groups_folder ON duplicate_groups(primary_folder);
            CREATE INDEX IF NOT EXISTS idx_groups_ext ON duplicate_groups(primary_ext);

            CREATE TABLE IF NOT EXISTS duplicate_group_members (
                group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
                file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
                similarity REAL DEFAULT 1.0,
                decision TEXT DEFAULT 'undecided',
                ai_score INTEGER,
                ai_reason TEXT,
                PRIMARY KEY (group_id, file_id)
            );

            CREATE INDEX IF NOT EXISTS idx_members_file ON duplicate_group_members(file_id);

            CREATE TABLE IF NOT EXISTS action_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                file_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                original_path TEXT NOT NULL,
                dest_path TEXT,
                size INTEGER NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_actions_batch ON action_logs(batch_id);
            CREATE INDEX IF NOT EXISTS idx_actions_created ON action_logs(created_at DESC);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
