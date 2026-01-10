@echo off
title TSW HUD Dashboard
cd /d "%~dp0"
echo.
echo ========================================
echo   TSW HUD Dashboard
echo ========================================
echo.

REM Check if runtime exists (embedded Node.js)
if exist "runtime\node.exe" (
    echo Starting server with embedded Node.js...
    echo.
    
    REM Set NODE_PATH so embedded node finds the runtime node_modules
    set "NODE_PATH=%~dp0runtime\node_modules"
    
    "runtime\node.exe" "server.js"
) else (
    REM Fall back to system Node.js
    echo Starting server with system Node.js...
    echo.
    
    if not exist "node_modules" (
        echo Installing dependencies...
        call npm install
        echo.
    )
    
    node server.js
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error starting server. Press any key to exit.
    pause >nul
)
