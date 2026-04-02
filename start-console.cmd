@echo off
cd /d "%~dp0"
start "paper-download console" cmd /k "cd /d ""%~dp0"" && npm run console"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8787
