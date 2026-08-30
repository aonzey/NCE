@echo off
rem NCE local one-click server launcher
rem URL: http://127.0.0.1:8080
setlocal enabledelayedexpansion
set "PY=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
set "PORT=8080"
cd /d "E:\english_project\NCE"

rem ---- Clean up stale processes listening on the port ----
echo Checking port %PORT% for stale processes ...
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    if not "%%p"=="0" (
        set "FOUND=1"
        echo Killing stale PID %%p ...
        taskkill /PID %%p /F >nul 2>&1
    )
)
if not defined FOUND (
    echo Port %PORT% is free.
) else (
    rem Wait ~1s so the OS releases the port (ping works in cmd and Git Bash)
    ping -n 2 127.0.0.1 >nul
    echo Stale processes cleaned.
)

echo Starting NCE local server at http://127.0.0.1:%PORT% ...
start "" http://127.0.0.1:%PORT%
rem Custom server sends Cache-Control: no-cache so browser never serves stale js/css
"%PY%" tools\server.py %PORT%
