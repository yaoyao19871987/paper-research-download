@echo off
setlocal

set "ROOT=D:\Code\paper-download\python-scraper\cnkiLRspider"
set "TOPIC_FILE=%ROOT%\topic.txt"

set "CNKI_BROWSER=chrome"
set "CNKI_DEBUGGER_ADDRESS=127.0.0.1:9222"
set "CNKI_VERIFY_TIMEOUT=1800"

cd /d "%ROOT%"

if "%~1"=="" (
  python research_pipeline.py --topic-file "%TOPIC_FILE%"
) else (
  python research_pipeline.py %*
)

endlocal
