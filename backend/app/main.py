import csv
import html
import io
import logging
import os
import threading
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from . import dedup as dedup_mod
from . import gemini_ai as gemini_mod
from . import scanner as scanner_mod
from .config import THUMB_DIR, get_gemini_api_key, save_gemini_api_key
from .database import db_session, init_db
from .dedup import (
    apply_auto_select_rule,
    run_burst_dedup,
    run_exact_dedup,
    run_visual_dedup,
)
from .gemini_ai import (
    analyze_duplicate_group,
    copilot_chat,
    escape_like,
    run_semantic_dedup,
    validate_gemini_model,
)
from .safety import execute_safe_removal, restore_quarantined_files
from .media_utils import open_image_preview
from .scanner import run_scan

logger = logging.getLogger(__name__)

ALLOWED_LOCAL_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}

app = FastAPI(title="LuminaDedup Studio API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_LOCAL_ORIGINS),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin and origin not in ALLOWED_LOCAL_ORIGINS:
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})
        sec_fetch_site = request.headers.get("sec-fetch-site")
        if sec_fetch_site == "cross-site":
            return JSONResponse(status_code=403, content={"detail": "Cross-site requests are blocked"})
        if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
            if request.headers.get("x-requested-with") != "LuminaDedup":
                return JSONResponse(status_code=403, content={"detail": "Missing required X-Requested-With header"})

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    )
    return response


@app.on_event("startup")
def on_startup() -> None:
    init_db()


# ---------- Request Models ----------
# 🛡️ Sentinel: Enforce strict input bounds and enum literals on API payloads to prevent
# O(N^2) memory exhaustion (semantic_limit), unbounded AI token/billing abuse, and silent mode fallback.

class ScanRequest(BaseModel):
    paths: list[str] = Field(..., min_length=1, max_length=50)
    extract_exif: bool = True
    reset_before_scan: bool = False


class DedupRunRequest(BaseModel):
    approach: Literal["exact", "visual", "burst", "semantic"]
    max_distance: int = Field(5, ge=0, le=16)
    burst_seconds: float = Field(3.0, ge=0.0, le=3600.0, allow_inf_nan=False)
    folder_filter: Optional[str] = Field(None, max_length=500)
    semantic_threshold: float = Field(0.92, ge=0.5, le=1.0, allow_inf_nan=False)
    semantic_limit: int = Field(200, ge=2, le=2000)


class DecisionRequest(BaseModel):
    file_id: int = Field(..., ge=1)
    decision: Literal["keep", "remove", "undecided"]


class AutoSelectRequest(BaseModel):
    rule: str  # keep_largest | keep_highest_res | keep_oldest | keep_newest | keep_cleanest_path | keep_in_folder
    approach: Optional[str] = None
    group_id: Optional[int] = None
    reference_folder: Optional[str] = Field(None, max_length=500)


class ExecuteRemovalRequest(BaseModel):
    file_ids: Optional[list[int]] = None
    use_marked_remove: bool = False
    approach: Optional[str] = None
    mode: Literal["quarantine", "trash"] = "quarantine"


class RestoreRequest(BaseModel):
    file_ids: Optional[list[int]] = None
    batch_id: Optional[str] = Field(None, max_length=128)


class AIAnalyzeRequest(BaseModel):
    model: str = "gemini-3.8-flash"
    auto_apply: bool = False


class CopilotRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    previous_interaction_id: Optional[str] = Field(None, max_length=256)
    model: str = "gemini-4-argon"


class SettingsRequest(BaseModel):
    gemini_api_key: str = Field(..., max_length=256)


# ---------- Health & Settings ----------

@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "gemini_configured": bool(get_gemini_api_key())}


@app.get("/api/settings")
def get_settings() -> dict:
    key = get_gemini_api_key()
    masked = f"{key[:6]}...{key[-4:]}" if len(key) > 12 else ("configured" if key else "")
    return {"gemini_configured": bool(key), "gemini_key_masked": masked}


@app.post("/api/settings")
def update_settings(req: SettingsRequest) -> dict:
    try:
        save_gemini_api_key(req.gemini_api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"gemini_configured": bool(get_gemini_api_key())}


# ---------- Library Stats, Folders & Extensions ----------

@app.get("/api/stats")
def get_stats() -> dict:
    with db_session() as conn:
        active = conn.execute(
            """
            SELECT COUNT(*) as total_files,
                   COALESCE(SUM(size), 0) as total_bytes,
                   COALESCE(SUM(CASE WHEN media_type='photo' THEN 1 ELSE 0 END), 0) as photo_count,
                   COALESCE(SUM(CASE WHEN media_type='video' THEN 1 ELSE 0 END), 0) as video_count,
                   COUNT(DISTINCT folder) as folder_count
            FROM media_files WHERE status = 'active'
            """
        ).fetchone()

        quarantined = conn.execute(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(size), 0) as bytes FROM media_files WHERE status = 'quarantined'"
        ).fetchone()

        approaches = conn.execute(
            """
            SELECT approach, COUNT(*) as group_count,
                   COALESCE(SUM(file_count), 0) as member_count,
                   COALESCE(SUM(reclaimable_size), 0) as reclaimable_bytes
            FROM duplicate_groups
            GROUP BY approach
            """
        ).fetchall()

        marked = conn.execute(
            """
            SELECT COUNT(DISTINCT gm.file_id) as cnt, COALESCE(SUM(m.size), 0) as bytes
            FROM duplicate_group_members gm
            JOIN media_files m ON m.id = gm.file_id
            WHERE gm.decision = 'remove' AND m.status = 'active'
            """
        ).fetchone()

        roots = conn.execute("SELECT * FROM scan_roots ORDER BY last_scanned_at DESC").fetchall()

    return {
        "library": dict(active),
        "quarantined": dict(quarantined),
        "marked_for_removal": dict(marked),
        "approaches": {r["approach"]: dict(r) for r in approaches},
        "scan_roots": [dict(r) for r in roots],
    }


@app.get("/api/folders")
def list_folders(
    sort_by: str = Query("bytes", pattern="^(folder|count|bytes)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(200, ge=1, le=2000),
) -> list[dict]:
    sort_col = {"folder": "folder", "count": "file_count", "bytes": "total_bytes"}[sort_by]
    direction = "ASC" if order == "asc" else "DESC"
    with db_session() as conn:
        rows = conn.execute(
            f"""
            SELECT folder,
                   COUNT(*) as file_count,
                   COALESCE(SUM(size), 0) as total_bytes,
                   SUM(CASE WHEN media_type='photo' THEN 1 ELSE 0 END) as photos,
                   SUM(CASE WHEN media_type='video' THEN 1 ELSE 0 END) as videos
            FROM media_files
            WHERE status = 'active'
            GROUP BY folder
            ORDER BY {sort_col} {direction}
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/extensions")
def list_extensions() -> list[dict]:
    with db_session() as conn:
        rows = conn.execute(
            """
            SELECT ext,
                   media_type,
                   COUNT(*) as file_count,
                   COALESCE(SUM(size), 0) as total_bytes
            FROM media_files
            WHERE status = 'active'
            GROUP BY ext, media_type
            ORDER BY total_bytes DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- Scanning & Deduplication ----------

def _clear_active_index() -> int:
    with db_session() as conn:
        cnt = conn.execute("SELECT COUNT(*) FROM media_files WHERE status = 'active'").fetchone()[0]
        conn.execute("DELETE FROM duplicate_group_members")
        conn.execute("DELETE FROM duplicate_groups")
        conn.execute("DELETE FROM media_files WHERE status = 'active'")
        conn.execute("DELETE FROM scan_roots")
    return cnt


@app.post("/api/index/reset")
def reset_index() -> dict:
    if scanner_mod.scan_progress.running or dedup_mod.dedup_progress.running or gemini_mod.semantic_progress.running:
        raise HTTPException(status_code=409, detail="Cannot reset index while a scan or dedup job is running.")
    cleared = _clear_active_index()
    return {"cleared_files": cleared}


@app.post("/api/scan")
def start_scan(req: ScanRequest) -> dict:
    if scanner_mod.scan_progress.running:
        raise HTTPException(status_code=409, detail="A scan is already running.")
    valid_paths = [p for p in req.paths if os.path.isdir(p)]
    if not valid_paths:
        raise HTTPException(status_code=400, detail="No valid directory paths provided.")
    if req.reset_before_scan:
        _clear_active_index()
    scanner_mod.scan_progress.reset(phase="starting", message="Starting folder scan...")
    t = threading.Thread(target=run_scan, args=(valid_paths, req.extract_exif), daemon=True)
    t.start()
    return {"started": True, "paths": valid_paths, "reset": req.reset_before_scan}


@app.get("/api/scan/status")
def get_scan_status() -> dict:
    return scanner_mod.scan_progress.to_dict()


@app.post("/api/dedup/run")
def start_dedup(req: DedupRunRequest) -> dict:
    if req.approach == "semantic":
        if gemini_mod.semantic_progress.running:
            raise HTTPException(status_code=409, detail="Semantic dedup is already running.")
        gemini_mod.semantic_progress.reset(phase="starting", message="Starting Gemini Semantic dedup...")
        t = threading.Thread(
            target=run_semantic_dedup,
            args=(req.folder_filter, req.semantic_threshold, req.semantic_limit),
            daemon=True,
        )
        t.start()
        return {"started": True, "approach": "semantic"}

    if dedup_mod.dedup_progress.running:
        raise HTTPException(status_code=409, detail="A deduplication job is already running.")

    dedup_mod.dedup_progress.reset(phase="starting", message=f"Starting {req.approach} detection...")
    if req.approach == "exact":
        t = threading.Thread(target=run_exact_dedup, daemon=True)
    elif req.approach == "visual":
        t = threading.Thread(target=run_visual_dedup, args=(req.max_distance,), daemon=True)
    elif req.approach == "burst":
        t = threading.Thread(target=run_burst_dedup, args=(req.burst_seconds,), daemon=True)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown approach: {req.approach}")

    t.start()
    return {"started": True, "approach": req.approach}


@app.get("/api/dedup/status")
def get_dedup_status() -> dict:
    return {
        "local": dedup_mod.dedup_progress.to_dict(),
        "semantic": gemini_mod.semantic_progress.to_dict(),
    }


# ---------- Duplicate Groups & Ordering ----------

@app.get("/api/groups")
def list_groups(
    approach: str = Query("exact", pattern="^(exact|visual|burst|semantic|all)$"),
    sort_by: str = Query("reclaimable", pattern="^(folder|ext|size|reclaimable|file_count)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    folder: Optional[str] = None,
    ext: Optional[str] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> dict:
    sort_map = {
        "folder": "primary_folder",
        "ext": "primary_ext",
        "size": "total_size",
        "reclaimable": "reclaimable_size",
        "file_count": "file_count",
    }
    sort_col = sort_map[sort_by]
    direction = "ASC" if order == "asc" else "DESC"

    where = ["1=1"]
    params: list = []
    if approach != "all":
        where.append("g.approach = ?")
        params.append(approach)
    if folder:
        where.append("g.primary_folder LIKE ? ESCAPE '\\'")
        params.append(f"{escape_like(folder)}%")
    if ext:
        where.append("g.primary_ext = ?")
        params.append(ext.lower())
    if search:
        esc_search = escape_like(search)
        where.append(
            "EXISTS (SELECT 1 FROM duplicate_group_members gm JOIN media_files m ON m.id = gm.file_id "
            "WHERE gm.group_id = g.id AND (m.filename LIKE ? ESCAPE '\\' OR m.folder LIKE ? ESCAPE '\\'))"
        )
        params.extend([f"%{esc_search}%", f"%{esc_search}%"])

    where_sql = " AND ".join(where)
    offset = (page - 1) * page_size

    with db_session() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) as cnt FROM duplicate_groups g WHERE {where_sql}",
            params,
        ).fetchone()["cnt"]

        groups = conn.execute(
            f"""
            SELECT g.*
            FROM duplicate_groups g
            WHERE {where_sql}
            ORDER BY {sort_col} {direction}, g.id ASC
            LIMIT ? OFFSET ?
            """,
            (*params, page_size, offset),
        ).fetchall()

        # ⚡ Bolt: Batch-fetch all page group members in a single SQLite JOIN instead of N+1 queries per group
        members_by_group: dict[int, list[dict]] = {}
        group_ids = [g["id"] for g in groups]
        if group_ids:
            placeholders = ",".join("?" for _ in group_ids)
            member_rows = conn.execute(
                f"""
                SELECT gm.group_id, m.id, m.path, m.folder, m.filename, m.ext, m.media_type,
                       m.size, m.mtime, m.width, m.height, m.exif_date, m.camera_model, m.status,
                       gm.similarity, gm.decision, gm.ai_score, gm.ai_reason
                FROM duplicate_group_members gm
                JOIN media_files m ON m.id = gm.file_id
                WHERE gm.group_id IN ({placeholders})
                ORDER BY m.size DESC, m.path ASC
                """,
                group_ids,
            ).fetchall()
            for m in member_rows:
                m_dict = dict(m)
                gid = m_dict.pop("group_id")
                members_by_group.setdefault(gid, []).append(m_dict)

        result_groups = []
        for g in groups:
            g_dict = dict(g)
            g_dict["members"] = members_by_group.get(g["id"], [])
            result_groups.append(g_dict)

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "groups": result_groups,
    }


@app.post("/api/groups/{group_id}/decision")
def set_member_decision(group_id: int, req: DecisionRequest) -> dict:
    if req.decision not in {"keep", "remove", "undecided"}:
        raise HTTPException(status_code=400, detail="Invalid decision")
    with db_session() as conn:
        conn.execute(
            "UPDATE duplicate_group_members SET decision = ? WHERE group_id = ? AND file_id = ?",
            (req.decision, group_id, req.file_id),
        )
    return {"ok": True}


@app.post("/api/groups/auto-select")
def auto_select(req: AutoSelectRequest) -> dict:
    try:
        updated = apply_auto_select_rule(
            req.rule,
            approach=req.approach,
            group_id=req.group_id,
            reference_folder=req.reference_folder,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"updated_members": updated, "rule": req.rule}


def _safe_csv_field(value: object) -> str:
    text = "" if value is None else str(value)
    if not text:
        return text
    stripped = text.lstrip()
    if text[0] in ("=", "+", "-", "@", "\t", "\r", "\n") or (stripped and stripped[0] in ("=", "+", "-", "@")):
        return "'" + text
    return text


@app.get("/api/export/csv")
def export_csv_report(
    scope: str = Query("groups", pattern="^(groups|quarantine)$"),
    approach: str = Query("all", pattern="^(exact|visual|burst|semantic|all)$"),
):
    buf = io.StringIO()
    writer = csv.writer(buf)

    with db_session() as conn:
        if scope == "quarantine":
            writer.writerow(["batch_id", "action", "original_path", "quarantine_path", "size_bytes", "timestamp"])
            rows = conn.execute(
                "SELECT batch_id, action, original_path, dest_path, size, created_at FROM action_logs ORDER BY created_at DESC LIMIT 100000"
            ).fetchall()
            for r in rows:
                writer.writerow([
                    _safe_csv_field(r["batch_id"]),
                    _safe_csv_field(r["action"]),
                    _safe_csv_field(r["original_path"]),
                    _safe_csv_field(r["dest_path"] or ""),
                    r["size"],
                    r["created_at"],
                ])
            filename = "lumina_quarantine_report.csv"
        else:
            writer.writerow([
                "group_id", "approach", "file_id", "decision", "similarity",
                "filename", "folder", "ext", "size_bytes", "width", "height", "path"
            ])
            where = "1=1"
            params: list = []
            if approach != "all":
                where = "g.approach = ?"
                params.append(approach)
            rows = conn.execute(
                f"""
                SELECT g.id as group_id, g.approach, m.id as file_id, gm.decision, gm.similarity,
                       m.filename, m.folder, m.ext, m.size, m.width, m.height, m.path
                FROM duplicate_groups g
                JOIN duplicate_group_members gm ON gm.group_id = g.id
                JOIN media_files m ON m.id = gm.file_id
                WHERE {where}
                ORDER BY g.reclaimable_size DESC, g.id ASC, m.size DESC
                LIMIT 200000
                """,
                params,
            ).fetchall()
            for r in rows:
                writer.writerow([
                    r["group_id"],
                    _safe_csv_field(r["approach"]),
                    r["file_id"],
                    _safe_csv_field(r["decision"]),
                    r["similarity"],
                    _safe_csv_field(r["filename"]),
                    _safe_csv_field(r["folder"]),
                    _safe_csv_field(r["ext"]),
                    r["size"],
                    r["width"] or "",
                    r["height"] or "",
                    _safe_csv_field(r["path"]),
                ])
            filename = f"lumina_duplicates_{approach}.csv"

    return Response(
        content=buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


# ---------- All Files Explorer (Ordered by Folder, Extension, Size) ----------

@app.get("/api/files")
def list_files(
    sort_by: str = Query("size", pattern="^(folder|ext|size|mtime|filename)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    folder: Optional[str] = None,
    ext: Optional[str] = None,
    media_type: Optional[str] = None,
    status: str = Query("active", pattern="^(active|quarantined|trashed|all)$"),
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> dict:
    sort_col = {"folder": "folder", "ext": "ext", "size": "size", "mtime": "mtime", "filename": "filename"}[sort_by]
    direction = "ASC" if order == "asc" else "DESC"

    where = ["1=1"]
    params: list = []
    if status != "all":
        where.append("status = ?")
        params.append(status)
    if folder:
        where.append("folder LIKE ? ESCAPE '\\'")
        params.append(f"{escape_like(folder)}%")
    if ext:
        where.append("ext = ?")
        params.append(ext.lower())
    if media_type in {"photo", "video"}:
        where.append("media_type = ?")
        params.append(media_type)
    if search:
        esc_search = escape_like(search)
        where.append("(filename LIKE ? ESCAPE '\\' OR folder LIKE ? ESCAPE '\\')")
        params.extend([f"%{esc_search}%", f"%{esc_search}%"])

    where_sql = " AND ".join(where)
    offset = (page - 1) * page_size

    with db_session() as conn:
        total = conn.execute(f"SELECT COUNT(*) as cnt FROM media_files WHERE {where_sql}", params).fetchone()["cnt"]
        rows = conn.execute(
            f"""
            SELECT id, path, folder, filename, ext, media_type, size, mtime,
                   width, height, exif_date, camera_model, status, quarantine_path
            FROM media_files
            WHERE {where_sql}
            ORDER BY {sort_col} {direction}, filename ASC
            LIMIT ? OFFSET ?
            """,
            (*params, page_size, offset),
        ).fetchall()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "files": [dict(r) for r in rows],
    }


# ---------- Media Thumbnails & Full Preview ----------

@app.get("/api/media/{file_id}/thumb")
def get_thumbnail(file_id: int):
    with db_session() as conn:
        row = conn.execute("SELECT path, quarantine_path, status, ext, media_type FROM media_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="File not found")

    actual_path = row["quarantine_path"] if row["status"] == "quarantined" and row["quarantine_path"] else row["path"]
    if not actual_path or os.path.islink(actual_path) or not os.path.exists(actual_path):
        raise HTTPException(status_code=404, detail="Media missing on disk")

    thumb_path = THUMB_DIR / f"{file_id}.jpg"
    if thumb_path.exists():
        return FileResponse(str(thumb_path), media_type="image/jpeg", headers={"X-Content-Type-Options": "nosniff"})

    if row["media_type"] == "photo":
        try:
            with open_image_preview(actual_path, ext=row["ext"]) as img:
                rgb = img.convert("RGB")
                rgb.thumbnail((360, 360), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                rgb.save(buf, format="JPEG", quality=80)
                data = buf.getvalue()
                thumb_path.write_bytes(data)
                return Response(content=data, media_type="image/jpeg", headers={"X-Content-Type-Options": "nosniff"})
        except Exception:
            pass

    # Clean SVG placeholder for videos or unsupported RAW formats
    label = html.escape(row["ext"].upper().lstrip("."))
    media_label = html.escape(row["media_type"].upper())
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">'
        f'<rect width="320" height="240" fill="#18181b"/>'
        f'<text x="160" y="115" text-anchor="middle" fill="#a1a1aa" font-family="sans-serif" font-size="22" font-weight="bold">{label}</text>'
        f'<text x="160" y="145" text-anchor="middle" fill="#71717a" font-family="sans-serif" font-size="13">{media_label}</text>'
        f'</svg>'
    )
    return Response(content=svg, media_type="image/svg+xml", headers={"X-Content-Type-Options": "nosniff"})


@app.get("/api/media/{file_id}/raw")
def get_raw_media(file_id: int):
    with db_session() as conn:
        row = conn.execute("SELECT path, quarantine_path, status FROM media_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="File not found")
    actual_path = row["quarantine_path"] if row["status"] == "quarantined" and row["quarantine_path"] else row["path"]
    if not actual_path or os.path.islink(actual_path) or not os.path.exists(actual_path):
        raise HTTPException(status_code=404, detail="Media missing on disk")
    return FileResponse(actual_path, headers={"X-Content-Type-Options": "nosniff"})


# ---------- Safe Quarantine, Trash & Undo ----------

@app.post("/api/safety/execute")
def execute_removal(req: ExecuteRemovalRequest) -> dict:
    file_ids = req.file_ids or []
    if req.use_marked_remove:
        with db_session() as conn:
            if req.approach and req.approach != "all":
                rows = conn.execute(
                    """
                    SELECT DISTINCT gm.file_id
                    FROM duplicate_group_members gm
                    JOIN duplicate_groups g ON g.id = gm.group_id
                    JOIN media_files m ON m.id = gm.file_id
                    WHERE gm.decision = 'remove' AND m.status = 'active' AND g.approach = ?
                    """,
                    (req.approach,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT DISTINCT gm.file_id
                    FROM duplicate_group_members gm
                    JOIN media_files m ON m.id = gm.file_id
                    WHERE gm.decision = 'remove' AND m.status = 'active'
                    """
                ).fetchall()
            file_ids = [r["file_id"] for r in rows]

    return execute_safe_removal(file_ids, mode=req.mode)


@app.get("/api/safety/quarantine")
def list_quarantine() -> dict:
    with db_session() as conn:
        files = conn.execute(
            """
            SELECT id, path, quarantine_path, filename, ext, size, updated_at
            FROM media_files
            WHERE status = 'quarantined'
            ORDER BY updated_at DESC
            LIMIT 500
            """
        ).fetchall()
        logs = conn.execute(
            """
            SELECT batch_id, action, COUNT(*) as file_count, SUM(size) as total_bytes, MAX(created_at) as created_at
            FROM action_logs
            GROUP BY batch_id, action
            ORDER BY created_at DESC
            LIMIT 50
            """
        ).fetchall()
    return {
        "quarantined_files": [dict(f) for f in files],
        "batches": [dict(l) for l in logs],
    }


@app.post("/api/safety/restore")
def restore_files(req: RestoreRequest) -> dict:
    return restore_quarantined_files(file_ids=req.file_ids, batch_id=req.batch_id)


# ---------- Gemini AI Endpoints ----------

@app.post("/api/ai/analyze-group/{group_id}")
def ai_analyze_group(group_id: int, req: AIAnalyzeRequest) -> dict:
    try:
        return analyze_duplicate_group(group_id, model=req.model, auto_apply=req.auto_apply)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        logger.exception("Gemini analysis failed for group %s", group_id)
        raise HTTPException(status_code=500, detail="Gemini analysis failed. Check server logs for details.")


@app.post("/api/ai/batch-analyze")
def ai_batch_analyze(
    approach: str = Query("visual"),
    limit: int = Query(5, ge=1, le=20),
    model: str = Query("gemini-3.8-flash"),
    auto_apply: bool = Query(True),
) -> dict:
    try:
        validate_gemini_model(model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    with db_session() as conn:
        groups = conn.execute(
            """
            SELECT id FROM duplicate_groups
            WHERE approach = ? AND ai_analyzed = 0
            ORDER BY reclaimable_size DESC
            LIMIT ?
            """,
            (approach, limit),
        ).fetchall()

    results = []
    errors = []
    for g in groups:
        try:
            res = analyze_duplicate_group(g["id"], model=model, auto_apply=auto_apply)
            results.append(res)
        except Exception:
            logger.exception("Gemini batch analysis failed for group %s", g["id"])
            errors.append({"group_id": g["id"], "error": "Analysis failed"})
    return {"analyzed": len(results), "results": results, "errors": errors}


@app.post("/api/ai/copilot")
def ai_copilot(req: CopilotRequest) -> dict:
    try:
        return copilot_chat(
            message=req.message,
            previous_interaction_id=req.previous_interaction_id,
            model=req.model,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        logger.exception("Gemini Copilot request failed")
        raise HTTPException(status_code=500, detail="Gemini Copilot request failed. Check server logs for details.")


# Serve built frontend if present
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="static")
