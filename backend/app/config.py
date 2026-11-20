import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / ".lumina_data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

ENV_PATH = BASE_DIR / ".env"
load_dotenv(ENV_PATH)

DB_PATH = DATA_DIR / "lumina_dedup.db"
THUMB_DIR = DATA_DIR / "thumbnails"
THUMB_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_QUARANTINE_DIR = BASE_DIR / ".lumina_quarantine"

PHOTO_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif",
    ".bmp", ".tiff", ".tif", ".gif", ".raw", ".cr2",
    ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".avif"
}

VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv",
    ".webm", ".m4v", ".3gp", ".ts", ".mts", ".m2ts", ".mpg", ".mpeg"
}

ALL_MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS


def get_gemini_api_key() -> str:
    load_dotenv(ENV_PATH, override=True)
    return os.getenv("GEMINI_API_KEY", "").strip()


def save_gemini_api_key(api_key: str) -> None:
    api_key = api_key.strip()
    if any(c in api_key for c in "\r\n\0"):
        raise ValueError("Invalid API key: newline or null characters are not allowed.")
    os.environ["GEMINI_API_KEY"] = api_key
    lines = []
    if ENV_PATH.exists():
        lines = [
            line for line in ENV_PATH.read_text(encoding="utf-8").splitlines()
            if not line.startswith("GEMINI_API_KEY=")
        ]
    if api_key:
        lines.append(f"GEMINI_API_KEY={api_key}")
    ENV_PATH.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
