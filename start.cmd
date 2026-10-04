@echo off
rem Start Art Director in a minimised window. Settings come from config.json or ARTDIR_* env vars.
cd /d "%~dp0"
start "artdirector" /min cmd /c "node server.mjs >> server.log 2>&1"
echo artdirector starting, see server.log
