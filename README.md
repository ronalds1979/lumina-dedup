# LuminaDedup Studio

A local-first, high-performance **Photo & Video Deduplication Studio** built for **285,000+ media files**, combining deterministic hashing, perceptual visual clustering, and Google Gemini AI.

## Key Features
- **Built for 285K+ Scale**: Streaming SQLite WAL catalog, 3-tier exact hashing (size → 192KB partial BLAKE2b → full SHA-256), and $O(N)$ 8-band perceptual hash bucketing.
- **4 Deduplication Approaches**:
  1. **Exact Duplicates** (SHA-256 byte-for-byte)
  2. **Visual / Near-Duplicates** (`pHash` + `dHash` for resized, recompressed, or WhatsApp/export copies)
  3. **Burst & Pattern Clusters** (time-window bursts & `(1)` / `-copy` / `-edited` filenames)
  4. **Gemini Semantic AI** (`gemini-embedding-2` multimodal embeddings for cropped/edited matches)
- **Gemini AI Integration**:
  - **Gemini: Pick Best** (`gemini-3.8-flash` via Interactions API): Compares candidate photos side-by-side and scores sharpness, focus, exposure, and originality.
  - **Gemini Cleanup Copilot** (`gemini-4-argon` stateful Interactions API): Library-aware assistant that helps plan safe folder-by-folder cleanup.
- **Intuitive Ordering & Inspection**: Order duplicate groups or all indexed files by **Folder**, **File Extension**, **Size**, **Reclaimable Space**, or **Date Modified**.
- **100% Safe Removal & Undo**: Never permanently deletes directly — moves marked files to a reversible **Safe Quarantine** (one-click Restore) or the **OS Recycle Bin** (`send2trash`).

## Quick Start
Run the single-command launcher (opens at `http://127.0.0.1:8000`):
```powershell
.\start.ps1
```
Or run backend + frontend in dev mode:
```powershell
# Terminal 1 (Backend)
C:\sourcecode\lumina-dedup\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir C:\sourcecode\lumina-dedup\backend

# Terminal 2 (Frontend)
cd C:\sourcecode\lumina-dedup\frontend
npm.cmd run dev
```
