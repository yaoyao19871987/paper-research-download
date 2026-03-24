@echo off
setlocal

set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "DEBUG_PORT=9222"
set "TARGET_URL=https://kns.cnki.net/kns8s/AdvSearch?type=expert"

if not exist "%CHROME_EXE%" (
  echo Chrome not found: %CHROME_EXE%
  exit /b 1
)

echo.
echo Close all Chrome windows first if you want to reuse the same login session.
echo Then this window will start Chrome in debug mode on port %DEBUG_PORT%.
echo.
pause

start "" "%CHROME_EXE%" --remote-debugging-port=%DEBUG_PORT% "%TARGET_URL%"

echo.
echo Chrome debug mode launch requested.
echo Opened target: %TARGET_URL%
echo Debugger address: 127.0.0.1:%DEBUG_PORT%
echo.
endlocal
