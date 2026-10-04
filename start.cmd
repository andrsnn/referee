@echo off
rem Start Referee in a minimised window. Settings come from config.json or REFEREE_* env vars.
cd /d "%~dp0"
start "referee" /min cmd /c "node server.mjs >> server.log 2>&1"
echo referee starting, see server.log
