@echo off
setlocal
cd /d %~dp0
if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install
)
echo Starting live human-captcha mode...
call npm.cmd run live
pause
