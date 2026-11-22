# Bolt's Journal — Critical Performance Learnings

## 2026-11-23 - Batch Paginated Group Member Lookups in SQLite
**Learning:** `GET /api/groups` (`backend/app/main.py`) ran an N+1 SQLite JOIN per group (50–100 separate queries per page) while also opening a fresh SQLite connection with 5 PRAGMAs per request.
**Action:** Batch-fetch paginated child records with a single `WHERE gm.group_id IN (...)` query grouped in Python (`members_by_group`) rather than looping per parent row.
