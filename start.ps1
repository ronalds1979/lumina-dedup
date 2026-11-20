Write-Host "Starting LuminaDedup Studio..." -ForegroundColor Cyan
$env:PYTHONPATH = "C:\sourcecode\lumina-dedup\backend"
Start-Process "http://127.0.0.1:8000"
C:\sourcecode\lumina-dedup\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir C:\sourcecode\lumina-dedup\backend
