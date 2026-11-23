## 2026-11-22 - Unbounded Request Payloads Leading to O(N^2) Memory DoS & Unintended Removal Mode Fallback
**Vulnerability:** FastAPI Pydantic request models in `backend/app/main.py` accepted unbounded `semantic_limit`, `max_distance`, `burst_seconds`, `semantic_threshold`, `CopilotRequest.message`, `ScanRequest.paths`, and unvalidated `ExecuteRemovalRequest.mode` strings.
**Learning:** `run_semantic_dedup` computes an `O(N^2)` cosine similarity matrix (`vecs @ vecs.T`) and issues one Gemini embedding call per file, so an unbounded `semantic_limit` causes both memory exhaustion and API cost abuse; likewise, `execute_safe_removal` used `if mode == "trash": ... else:` which silently quarantined files on any unknown mode string.
**Prevention:** Always define explicit Pydantic `Field(...)` bounds (including `allow_inf_nan=False` on floats) and `Literal[...]` enums on FastAPI request schemas.

## 2026-11-23 - UNC/SMB Credential Leakage & Unvalidated Scan Roots
**Vulnerability:** `POST /api/scan` (`backend/app/main.py`) and `run_scan` (`backend/app/scanner.py`) passed raw paths directly to `os.path.isdir()` and `Path.resolve()`, allowing Windows UNC paths (`\\host\share`), symlink/reparse roots, drive roots, OS directories, and `.lumina_data` / `.lumina_quarantine` to be scanned and indexed.
**Learning:** On Windows, calling `os.path.isdir()` or `os.lstat()` on a UNC path initiates an outbound SMB connection (leaking Net-NTLMv2 credentials), and `IGNORED_DIRS` inside `_walk_media()` only filters child subdirectories rather than the scan root itself.
**Prevention:** Validate scan roots before any `stat`/`resolve` call via `validate_scan_root()` to reject UNC/device prefixes, symlinks/reparse points, bare drive roots, and protected system or application directories.
