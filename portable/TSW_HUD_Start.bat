@echo off
title TSW HUD Dashboard
cd /d "%~dp0"
echo.
echo ========================================
echo   TSW HUD Dashboard
echo ========================================
echo.
echo Starting server...
echo.

"node\node.exe" "app\server.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error starting server. Press any key to exit.
    pause >nul
)
