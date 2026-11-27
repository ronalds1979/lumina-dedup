## 2026-11-22 - Unbounded Request Payloads Leading to O(N^2) Memory DoS & Unintended Removal Mode Fallback
**Vulnerability:** FastAPI Pydantic request models in `backend/app/main.py` accepted unbounded `semantic_limit`, `max_distance`, `burst_seconds`, `semantic_threshold`, `CopilotRequest.message`, `ScanRequest.paths`, and unvalidated `ExecuteRemovalRequest.mode` strings.
**Learning:** `run_semantic_dedup` computes an `O(N^2)` cosine similarity matrix (`vecs @ vecs.T`) and issues one Gemini embedding call per file, so an unbounded `semantic_limit` causes both memory exhaustion and API cost abuse; likewise, `execute_safe_removal` used `if mode == "trash": ... else:` which silently quarantined files on any unknown mode string.
**Prevention:** Always define explicit Pydantic `Field(...)` bounds (including `allow_inf_nan=False` on floats) and `Literal[...]` enums on FastAPI request schemas.

## 2026-11-23 - UNC/SMB Credential Leakage & Unvalidated Scan Roots
**Vulnerability:** `POST /api/scan` (`backend/app/main.py`) and `run_scan` (`backend/app/scanner.py`) passed raw paths directly to `os.path.isdir()` and `Path.resolve()`, allowing Windows UNC paths (`\\host\share`), symlink/reparse roots, drive roots, OS directories, and `.lumina_data` / `.lumina_quarantine` to be scanned and indexed.
**Learning:** On Windows, calling `os.path.isdir()` or `os.lstat()` on a UNC path initiates an outbound SMB connection (leaking Net-NTLMv2 credentials), and `IGNORED_DIRS` inside `_walk_media()` only filters child subdirectories rather than the scan root itself.
**Prevention:** Validate scan roots before any `stat`/`resolve` call via `validate_scan_root()` to reject UNC/device prefixes, symlinks/reparse points, the OS system drive root (`C:\` / `/`), and protected system or application directories, while allowing secondary/external media drive roots (such as `D:\`) and skipping protected directories during traversal.

## 2026-11-24 - Missing Host Header Validation Enabling DNS Rebinding
**Vulnerability:** `security_middleware` in `backend/app/main.py` validated `Origin` and `Sec-Fetch-Site` on `/api/*`, but did not validate the `Host` header, allowing an attacker origin that DNS-rebinds to `127.0.0.1:8000` to perform same-origin `GET` requests (omitting `Origin`, sending `Sec-Fetch-Site: same-origin`) and exfiltrate private media and library metadata.
**Learning:** On an unauthenticated `127.0.0.1` server, `Origin` and `Sec-Fetch-Site` checks alone do not stop DNS rebinding because same-origin `GET` requests bypass both checks.
**Prevention:** Enforce a strict local `Host` header allowlist (`localhost`, `127.0.0.1`, `[::1]`, rejecting missing or duplicate `Host` headers) across all routes at the outermost middleware layer.

## 2026-11-26 - Unbounded Clustering Query in Semantic Dedup & Nested NTFS Junction Traversal
**Vulnerability:** `run_semantic_dedup` bounded its initial embedding candidate query with `LIMIT ?`, but its second clustering `SELECT ... WHERE embedding IS NOT NULL` omitted `LIMIT ?`, loading all historically embedded rows into an `O(N^2)` matrix; additionally, `_walk_media` used `DirEntry.is_dir(follow_symlinks=False)` which returns `True` for NTFS directory junctions on Windows.
**Learning:** Bounding only the incremental work queue leaves downstream aggregation queries vulnerable once state accumulates in SQLite, and Python's `follow_symlinks=False` on `DirEntry.is_dir` does not block NTFS junctions unless `os.path.isjunction` / `FILE_ATTRIBUTE_REPARSE_POINT` is checked.
**Prevention:** Apply explicit `LIMIT ?` and vector byte-length checks directly to similarity-clustering queries, and check `_is_reparse_dir()` on every traversed subdirectory.

## 2026-11-27 - os.path.islink() Bypass via NTFS Junctions in Safety & Media Endpoints
**Vulnerability:** `safety.py` (`execute_safe_removal`, `restore_quarantined_files`) and `main.py` (`/api/media/{file_id}/thumb`, `/api/media/{file_id}/raw`) used `os.path.islink()` alone without checking NTFS junctions/reparse points across the path lineage or blocking UNC paths before `os.path.exists()`.
**Learning:** `os.path.islink()` returns `False` for Windows NTFS directory junctions and parent-folder reparse points, allowing quarantined/restored or served paths to traverse outside intended directories if a path or ancestor folder is replaced by a junction.
**Prevention:** Use a unified `is_unsafe_local_path()` guard checking UNC/device prefixes first and walking the full path lineage for `islink`, `isjunction`, and `FILE_ATTRIBUTE_REPARSE_POINT`.
