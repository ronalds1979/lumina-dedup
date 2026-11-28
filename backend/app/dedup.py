import hashlib
import logging
import os
import re
import threading
import time
from bisect import bisect_right
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import islice
from typing import Optional

import imagehash
from PIL import Image

from .database import db_session
from .media_utils import HASHABLE_PHOTO_EXTENSIONS, open_image_preview
from .scanner import TaskProgress

logger = logging.getLogger(__name__)
dedup_progress = TaskProgress()
_dedup_lock = threading.Lock()

CHUNK_SIZE = 65536
STEM_CLEAN_RE = re.compile(r"(?:\s*\(\d+\)|[-_\s](?:copy|edited|edit|dup|duplicate|\d+))$", re.IGNORECASE)


def _compute_partial_hash(path: str, size: int) -> Optional[str]:
    try:
        h = hashlib.blake2b(digest_size=16)
        with open(path, "rb") as f:
            if size <= CHUNK_SIZE * 3:
                while chunk := f.read(CHUNK_SIZE):
                    h.update(chunk)
            else:
                h.update(f.read(CHUNK_SIZE))
                f.seek(size // 2)
                h.update(f.read(CHUNK_SIZE))
                f.seek(max(0, size - CHUNK_SIZE))
                h.update(f.read(CHUNK_SIZE))
        return h.hexdigest()
    except OSError:
        return None


def _compute_sha256(path: str) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _compute_visual_hashes(path: str, ext: str = "") -> tuple[Optional[str], Optional[str], Optional[int], Optional[int]]:
    try:
        with open_image_preview(path, ext=ext, grayscale_draft=(256, 256)) as img:
            w, h = img.size
            gray = img if img.mode == "L" else img.convert("L")
            ph = str(imagehash.phash(gray))
            dh = str(imagehash.dhash(gray))
            return ph, dh, w, h
    except Exception:
        return None, None, None, None


def _build_hash_bands(max_distance: int) -> list[tuple[int, int]]:
    """Partition 64 bits into max(4, min(8, max_distance + 1)) disjoint (shift, mask) bands."""
    num_bands = max(4, min(8, max_distance + 1))
    base_bits, rem = divmod(64, num_bands)
    bands: list[tuple[int, int]] = []
    shift = 0
    for idx in range(num_bands):
        width = base_bits + (1 if idx < rem else 0)
        bands.append((shift, (1 << width) - 1))
        shift += width
    return bands


def run_exact_dedup() -> None:
    with _dedup_lock:
        if dedup_progress.running and dedup_progress.phase != "starting":
            return
        dedup_progress.reset(
            phase="exact_size_filter",
            message="Finding files with matching byte sizes...",
        )

    try:
        with db_session() as conn:
            # Clear previous exact groups
            conn.execute("DELETE FROM duplicate_groups WHERE approach = 'exact'")
            candidates = conn.execute(
                """
                SELECT id, path, size, partial_hash, sha256
                FROM media_files
                WHERE status = 'active' AND size > 0 AND size IN (
                    SELECT size FROM media_files WHERE status = 'active' AND size > 0
                    GROUP BY size HAVING COUNT(*) > 1
                )
                """
            ).fetchall()

        need_partial = [dict(r) for r in candidates if not r["partial_hash"]]
        dedup_progress.phase = "partial_hashing"
        dedup_progress.total = len(need_partial)
        dedup_progress.processed = 0
        dedup_progress.message = f"Computing fast partial hashes for {len(need_partial):,} size-matching files..."

        if need_partial:
            updates = []
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(_compute_partial_hash, r["path"], r["size"]): r["id"] for r in need_partial}
                for idx, fut in enumerate(as_completed(futures), 1):
                    fid = futures[fut]
                    ph = fut.result()
                    if ph:
                        updates.append((ph, fid))
                    if idx % 100 == 0 or idx == len(need_partial):
                        dedup_progress.processed = idx
                    if len(updates) >= 1000:
                        with db_session() as conn:
                            conn.executemany("UPDATE media_files SET partial_hash = ? WHERE id = ?", updates)
                        updates.clear()
            if updates:
                with db_session() as conn:
                    conn.executemany("UPDATE media_files SET partial_hash = ? WHERE id = ?", updates)

        with db_session() as conn:
            partial_collisions = conn.execute(
                """
                SELECT id, path, size, partial_hash, sha256
                FROM media_files
                WHERE status = 'active' AND partial_hash IS NOT NULL AND (size, partial_hash) IN (
                    SELECT size, partial_hash FROM media_files
                    WHERE status = 'active' AND partial_hash IS NOT NULL
                    GROUP BY size, partial_hash HAVING COUNT(*) > 1
                )
                """
            ).fetchall()

        need_full = [dict(r) for r in partial_collisions if not r["sha256"]]
        dedup_progress.phase = "full_sha256"
        dedup_progress.total = len(need_full)
        dedup_progress.processed = 0
        dedup_progress.message = f"Verifying full SHA-256 for {len(need_full):,} candidate files..."

        if need_full:
            updates = []
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = {pool.submit(_compute_sha256, r["path"]): r["id"] for r in need_full}
                for idx, fut in enumerate(as_completed(futures), 1):
                    fid = futures[fut]
                    sha = fut.result()
                    if sha:
                        updates.append((sha, fid))
                    if idx % 50 == 0 or idx == len(need_full):
                        dedup_progress.processed = idx
                    if len(updates) >= 500:
                        with db_session() as conn:
                            conn.executemany("UPDATE media_files SET sha256 = ? WHERE id = ?", updates)
                        updates.clear()
            if updates:
                with db_session() as conn:
                    conn.executemany("UPDATE media_files SET sha256 = ? WHERE id = ?", updates)

        # Build exact groups
        dedup_progress.phase = "grouping"
        dedup_progress.message = "Creating exact duplicate groups..."
        now = time.time()
        with db_session() as conn:
            rows = conn.execute(
                """
                SELECT id, folder, ext, size, sha256
                FROM media_files
                WHERE status = 'active' AND sha256 IS NOT NULL AND sha256 IN (
                    SELECT sha256 FROM media_files
                    WHERE status = 'active' AND sha256 IS NOT NULL
                    GROUP BY sha256 HAVING COUNT(*) > 1
                )
                ORDER BY sha256, path
                """
            ).fetchall()

            grouped: dict[str, list] = defaultdict(list)
            for r in rows:
                grouped[r["sha256"]].append(r)

            for sha, items in grouped.items():
                total_sz = sum(x["size"] for x in items)
                reclaimable = total_sz - max(x["size"] for x in items)
                cur = conn.execute(
                    """
                    INSERT INTO duplicate_groups (
                        approach, signature, file_count, total_size, reclaimable_size,
                        primary_folder, primary_ext, created_at
                    ) VALUES ('exact', ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (sha, len(items), total_sz, reclaimable, items[0]["folder"], items[0]["ext"], now),
                )
                gid = cur.lastrowid
                conn.executemany(
                    "INSERT INTO duplicate_group_members (group_id, file_id, similarity) VALUES (?, ?, 1.0)",
                    [(gid, x["id"]) for x in items],
                )

        dedup_progress.phase = "completed"
        dedup_progress.message = f"Exact dedup complete: {len(grouped):,} duplicate groups found."
        dedup_progress.finished_at = time.time()
        dedup_progress.running = False
    except Exception:
        # 🛡️ Sentinel: Log internal exception server-side without leaking SQLite/OS details via /api/dedup/status
        logger.exception("Exact deduplication failed")
        dedup_progress.phase = "error"
        dedup_progress.error = "Exact deduplication failed. Check server logs for details."
        dedup_progress.message = "Exact deduplication failed. Check server logs for details."
        dedup_progress.finished_at = time.time()
        dedup_progress.running = False


def run_visual_dedup(max_distance: int = 5) -> None:
    """
    Perceptual visual deduplication using 64-bit dHash & pHash.
    Uses 4x 16-bit band bucketing (Pigeonhole Principle) for O(N) candidate lookup
    so it scales cleanly to 285,000+ photos.
    """
    with _dedup_lock:
        if dedup_progress.running and dedup_progress.phase != "starting":
            return
        dedup_progress.reset(
            phase="visual_hashing",
            message="Checking photos needing perceptual hashes...",
        )

    try:
        ext_placeholders = ",".join("?" for _ in HASHABLE_PHOTO_EXTENSIONS)
        with db_session() as conn:
            conn.execute("DELETE FROM duplicate_groups WHERE approach = 'visual'")
            need_hash = conn.execute(
                f"""
                SELECT id, path, ext FROM media_files
                WHERE status = 'active' AND media_type = 'photo'
                  AND (phash IS NULL OR dhash IS NULL)
                  AND ext IN ({ext_placeholders})
                """,
                tuple(sorted(HASHABLE_PHOTO_EXTENSIONS)),
            ).fetchall()

        dedup_progress.total = len(need_hash)
        dedup_progress.processed = 0
        dedup_progress.message = f"Computing perceptual hashes (pHash + dHash) for {len(need_hash):,} photos..."

        if need_hash:
            updates = []
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(_compute_visual_hashes, r["path"], r["ext"]): r["id"] for r in need_hash}
                for idx, fut in enumerate(as_completed(futures), 1):
                    fid = futures[fut]
                    ph, dh, w, h = fut.result()
                    if ph and dh:
                        updates.append((ph, dh, w, h, fid))
                    if idx % 100 == 0 or idx == len(need_hash):
                        dedup_progress.processed = idx
                    if len(updates) >= 1000:
                        with db_session() as conn:
                            conn.executemany(
                                """
                                UPDATE media_files
                                SET phash = ?, dhash = ?,
                                    width = COALESCE(width, ?),
                                    height = COALESCE(height, ?)
                                WHERE id = ?
                                """,
                                updates,
                            )
                        updates.clear()
            if updates:
                with db_session() as conn:
                    conn.executemany(
                        """
                        UPDATE media_files
                        SET phash = ?, dhash = ?,
                            width = COALESCE(width, ?),
                            height = COALESCE(height, ?)
                        WHERE id = ?
                        """,
                        updates,
                    )

        dedup_progress.phase = "visual_clustering"
        dedup_progress.message = "Clustering visually similar photos..."

        with db_session() as conn:
            photos = conn.execute(
                """
                SELECT id, folder, ext, size, phash, dhash
                FROM media_files
                WHERE status = 'active' AND media_type = 'photo' AND phash IS NOT NULL AND dhash IS NOT NULL
                """
            ).fetchall()

        # Multi-index Pigeonhole Principle band bucketing on phash (zero misses for Hamming <= 7)
        bands = _build_hash_bands(max_distance)
        items = []
        phs: list[int] = []
        dhs: list[int] = []
        buckets: list[dict[int, list[int]]] = [defaultdict(list) for _ in bands]
        for r in photos:
            try:
                ph_int = int(r["phash"], 16)
                dh_int = int(r["dhash"], 16)
            except ValueError:
                continue
            cur_idx = len(items)
            items.append((r["id"], r["folder"], r["ext"], r["size"], ph_int, dh_int))
            phs.append(ph_int)
            dhs.append(dh_int)
            for b, (shift, mask) in enumerate(bands):
                buckets[b][(ph_int >> shift) & mask].append(cur_idx)

        parent = list(range(len(items)))

        def find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        # Compare only within matching bands, capping pathological all-black/all-white buckets
        max_bucket_size = max(2000, len(items) // 50)
        for i in range(len(items)):
            ph_i = phs[i]
            dh_i = dhs[i]
            seen_candidates: set[int] = set()
            for b, (shift, mask) in enumerate(bands):
                cand_list = buckets[b][(ph_i >> shift) & mask]
                if len(cand_list) > max_bucket_size:
                    continue
                start = bisect_right(cand_list, i)
                for j in islice(cand_list, start, None):
                    if j in seen_candidates:
                        continue
                    seen_candidates.add(j)
                    if (ph_i ^ phs[j]).bit_count() <= max_distance:
                        if (dh_i ^ dhs[j]).bit_count() <= max_distance + 2:
                            union(i, j)

        clusters: dict[int, list[int]] = defaultdict(list)
        for i in range(len(items)):
            clusters[find(i)].append(i)

        now = time.time()
        group_count = 0
        with db_session() as conn:
            for root_i, member_indices in clusters.items():
                if len(member_indices) < 2:
                    continue
                group_count += 1
                anchor_ph = items[member_indices[0]][4]
                total_sz = sum(items[idx][3] for idx in member_indices)
                max_sz = max(items[idx][3] for idx in member_indices)
                reclaimable = total_sz - max_sz
                cur = conn.execute(
                    """
                    INSERT INTO duplicate_groups (
                        approach, signature, file_count, total_size, reclaimable_size,
                        primary_folder, primary_ext, created_at
                    ) VALUES ('visual', ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        hex(anchor_ph),
                        len(member_indices),
                        total_sz,
                        reclaimable,
                        items[member_indices[0]][1],
                        items[member_indices[0]][2],
                        now,
                    ),
                )
                gid = cur.lastrowid
                member_rows = []
                for idx in member_indices:
                    dist = (anchor_ph ^ items[idx][4]).bit_count()
                    sim = round(max(0.0, 1.0 - dist / 64.0), 3)
                    member_rows.append((gid, items[idx][0], sim))
                conn.executemany(
                    "INSERT INTO duplicate_group_members (group_id, file_id, similarity) VALUES (?, ?, ?)",
                    member_rows,
                )

        dedup_progress.phase = "completed"
        dedup_progress.message = f"Visual dedup complete: {group_count:,} similar groups found."
        dedup_progress.finished_at = time.time()
        dedup_progress.running = False
    except Exception:
        # 🛡️ Sentinel: Log internal exception server-side without leaking SQLite/OS details via /api/dedup/status
        logger.exception("Visual deduplication failed")
        dedup_progress.phase = "error"
        dedup_progress.error = "Visual deduplication failed. Check server logs for details."
        dedup_progress.message = "Visual deduplication failed. Check server logs for details."
        dedup_progress.finished_at = time.time()
        dedup_progress.running = False


def run_burst_dedup(window_seconds: float = 3.0) -> None:
    """
    Groups photos in the same folder taken within `window_seconds` OR sharing
    duplicate filename copy patterns (e.g. 'IMG_100 (1).jpg', 'IMG_100-edited.jpg').
    """
    with _dedup_lock:
        if dedup_progress.running and dedup_progress.phase != "starting":
            return
        dedup_progress.reset(
            phase="burst_clustering",
            message="Analyzing bursts and copy-pattern filenames...",
        )

    try:
        with db_session() as conn:
            conn.execute("DELETE FROM duplicate_groups WHERE approach = 'burst'")
            rows = conn.execute(
                """
                SELECT id, folder, filename, ext, size, mtime
                FROM media_files
                WHERE status = 'active'
                ORDER BY folder, mtime
                """
            ).fetchall()

        # Group by normalized stem within folder
        stem_groups: dict[tuple[str, str], list] = defaultdict(list)
        for r in rows:
            stem = os.path.splitext(r["filename"])[0]
            clean_stem = STEM_CLEAN_RE.sub("", stem).lower()
            stem_groups[(r["folder"], clean_stem)].append(r)

        # Also group time-adjacent photos in the same folder
        by_folder: dict[str, list] = defaultdict(list)
        for r in rows:
            by_folder[r["folder"]].append(r)

        clusters: list[list] = []
        used_ids: set[int] = set()

        for (_, _), grp in stem_groups.items():
            if len(grp) >= 2:
                clusters.append(grp)
                for item in grp:
                    used_ids.add(item["id"])

        for folder, flist in by_folder.items():
            current_burst: list = []
            for item in flist:
                if item["id"] in used_ids:
                    continue
                if not current_burst:
                    current_burst = [item]
                elif abs(item["mtime"] - current_burst[-1]["mtime"]) <= window_seconds:
                    current_burst.append(item)
                else:
                    if len(current_burst) >= 2:
                        clusters.append(current_burst)
                    current_burst = [item]
            if len(current_burst) >= 2:
                clusters.append(current_burst)

        now = time.time()
        with db_session() as conn:
            for idx, grp in enumerate(clusters):
                total_sz = sum(x["size"] for x in grp)
                reclaimable = total_sz - max(x["size"] for x in grp)
                cur = conn.execute(
                    """
                    INSERT INTO duplicate_groups (
                        approach, signature, file_count, total_size, reclaimable_size,
                        primary_folder, primary_ext, created_at
                    ) VALUES ('burst', ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"burst-{idx}",
                        len(grp),
                        total_sz,
                        reclaimable,
                        grp[0]["folder"],
                        grp[0]["ext"],
                        now,
                    ),
                )
                gid = cur.lastrowid
                conn.executemany(
                    "INSERT INTO duplicate_group_members (group_id, file_id, similarity) VALUES (?, ?, 0.9)",
                    [(gid, x["id"]) for x in grp],
                )

        dedup_progress.phase = "completed"
        dedup_progress.message = f"Burst & pattern clustering complete: {len(clusters):,} groups found."
        dedup_progress.finished_at = time.time()
        dedup_progress.running = False
    except Exception:
        # 🛡️ Sentinel: Log internal exception server-side without leaking SQLite/OS details via /api/dedup/status
        logger.exception("Burst clustering failed")
        dedup_progress.phase = "error"
        dedup_progress.error = "Burst clustering failed. Check server logs for details."
        dedup_progress.message = "Burst clustering failed. Check server logs for details."
        dedup_progress.finished_at = time.time()
        dedup_progress.running = False


def apply_auto_select_rule(
    rule: str,
    approach: Optional[str] = None,
    group_id: Optional[int] = None,
    reference_folder: Optional[str] = None,
) -> int:
    """
    Applies a deterministic keep/remove rule across matching groups.
    Rules: 'keep_largest', 'keep_highest_res', 'keep_oldest', 'keep_newest',
           'keep_cleanest_path', 'keep_in_folder'
    """
    ref_norm: Optional[str] = None
    if rule == "keep_in_folder":
        if not reference_folder or not reference_folder.strip():
            raise ValueError("reference_folder is required for keep_in_folder rule")
        ref_norm = os.path.normcase(os.path.abspath(reference_folder.strip())).rstrip("\\/") + os.sep

    with db_session() as conn:
        where_clauses = ["m.status = 'active'"]
        params: list = []
        if approach:
            where_clauses.append("g.approach = ?")
            params.append(approach)
        if group_id is not None:
            where_clauses.append("g.id = ?")
            params.append(group_id)

        rows = conn.execute(
            f"""
            SELECT gm.group_id, m.id, m.path, m.folder, m.filename, m.size, m.mtime, m.width, m.height
            FROM duplicate_groups g
            JOIN duplicate_group_members gm ON gm.group_id = g.id
            JOIN media_files m ON m.id = gm.file_id
            WHERE {' AND '.join(where_clauses)}
            """,
            params,
        ).fetchall()

        by_group: dict[int, list] = defaultdict(list)
        for r in rows:
            by_group[r["group_id"]].append(r)

        def path_score(r):
            fn = r["filename"].lower()
            penalty = 0
            if "copy" in fn or "(" in fn or "whatsapp" in r["path"].lower() or "thumb" in r["path"].lower():
                penalty += 1000
            return (penalty, len(r["path"]), -r["size"])

        updates: list[tuple[str, int, int]] = []
        for gid, members in by_group.items():
            if len(members) < 2:
                continue

            if rule == "keep_in_folder" and ref_norm:
                in_ref = [
                    m for m in members
                    if (os.path.normcase(os.path.abspath(m["folder"])).rstrip("\\/") + os.sep).startswith(ref_norm)
                ]
                if not in_ref:
                    continue
                keeper = max(in_ref, key=lambda r: (r["size"], -len(r["path"])))
            elif rule == "keep_largest":
                keeper = max(members, key=lambda r: (r["size"], -len(r["path"])))
            elif rule == "keep_highest_res":
                keeper = max(members, key=lambda r: ((r["width"] or 0) * (r["height"] or 0), r["size"]))
            elif rule == "keep_oldest":
                keeper = min(members, key=lambda r: (r["mtime"], len(r["path"])))
            elif rule == "keep_newest":
                keeper = max(members, key=lambda r: (r["mtime"], r["size"]))
            elif rule == "keep_cleanest_path":
                keeper = min(members, key=path_score)
            else:
                # 🛡️ Sentinel: Reject unrecognized rules instead of silently marking files for removal
                raise ValueError(f"Unsupported auto-select rule: {rule}")

            keeper_id = keeper["id"]
            for m in members:
                decision = "keep" if m["id"] == keeper_id else "remove"
                updates.append((decision, gid, m["id"]))

        if updates:
            conn.executemany(
                "UPDATE duplicate_group_members SET decision = ? WHERE group_id = ? AND file_id = ?",
                updates,
            )
        return len(updates)
