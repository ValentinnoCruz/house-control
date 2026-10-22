@echo off
setlocal
set "PATH=C:\Users\Didis\AppData\Local\Programs\REA;%PATH%"
cd /d "%~dp0"

echo Starting House Control (Govee LAN Backend + 3D Web UI)...
start "House Control Backend" /min cmd /c "node server\index.mjs"
timeout /t 1 /nobreak >nul
start "" "http://localhost:5199/"
cd web
call npm run dev
