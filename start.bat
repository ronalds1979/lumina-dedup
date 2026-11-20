@echo off
echo Starting LuminaDedup Studio on http://127.0.0.1:8000 ...
set PYTHONPATH=C:\sourcecode\lumina-dedup\backend
start "" "http://127.0.0.1:8000"
C:\sourcecode\lumina-dedup\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir C:\sourcecode\lumina-dedup\backend
