@echo off
setlocal
set "PATH=C:\Users\Didis\AppData\Local\Programs\REA;%PATH%"
cd /d "%~dp0"

:: Start Backend (port 5200) if not already running
netstat -ano | findstr ":5200 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    start "House Control Backend" /min cmd /c "set PATH=C:\Users\Didis\AppData\Local\Programs\REA;%PATH% && node server\index.mjs"
    timeout /t 1 /nobreak >nul
)

:: Start Vite Web UI (port 5199) if not already running
netstat -ano | findstr ":5199 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    start "House Control Web UI" /min cmd /c "set PATH=C:\Users\Didis\AppData\Local\Programs\REA;%PATH% && cd /d "%~dp0web" && npm run dev"
    timeout /t 2 /nobreak >nul
)

:: Open House Control in default browser
start "" "http://localhost:5199/"
