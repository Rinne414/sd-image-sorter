@echo off
setlocal enabledelayedexpansion

echo ==========================================
echo    SD Image Sorter - Starting...
echo ==========================================
echo.

cd /d "%~dp0"

REM ── Find Python ────────────────────────────────────────────────
set "PYTHON_CMD="

REM Try common Anaconda locations first
for %%P in (
    "D:\Anaconda\python.exe"
    "C:\Users\%USERNAME%\Anaconda3\python.exe"
    "C:\ProgramData\Anaconda3\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python39\python.exe"
) do (
    if exist %%P (
        set "PYTHON_CMD=%%~P"
        goto :found_python
    )
)

REM Try PATH as fallback
for %%C in (python python3 py) do (
    %%C --version >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_CMD=%%C"
        goto :found_python
    )
)

echo.
echo [ERROR] Python is not installed or not in PATH.
echo         Please install Python 3.9+ from https://python.org
echo.
pause
exit /b 1

:found_python
echo [OK] Found Python: !PYTHON_CMD!

REM ── Check Python version (>= 3.9) ─────────────────────────────
set "PY_VER="
set "PY_MAJOR=0"
set "PY_MINOR=0"

for /f "tokens=2" %%v in ('"!PYTHON_CMD!" --version 2^>^&1') do set "PY_VER=%%v"

if not defined PY_VER (
    echo [ERROR] Could not determine Python version.
    pause
    exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ("!PY_VER!") do (
    set "PY_MAJOR=%%a"
    set "PY_MINOR=%%b"
)

if !PY_MAJOR! LSS 3 (
    echo [ERROR] Python !PY_VER! is too old. Python 3.9+ required.
    pause
    exit /b 1
)
if !PY_MAJOR! EQU 3 if !PY_MINOR! LSS 9 (
    echo [ERROR] Python !PY_VER! is too old. Python 3.9+ required.
    pause
    exit /b 1
)

echo [OK] Python !PY_VER!
echo.

REM ── Detect first run ──────────────────────────────────────────
set FIRST_RUN=0
if not exist "backend\venv\Scripts\python.exe" set FIRST_RUN=1

if !FIRST_RUN! EQU 1 (
    echo ==========================================
    echo   First run - setting up environment...
    echo   This may take 5-10 minutes.
    echo ==========================================
    echo.

    echo [1/3] Creating virtual environment...
    "!PYTHON_CMD!" -m venv backend\venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo       Done.
    echo.

    echo [2/3] Installing dependencies...
    backend\venv\Scripts\pip.exe install -r backend\requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo       Done.
    echo.

    echo [3/3] Starting server...
) else (
    echo Starting server...
)

echo.
echo ==========================================
echo   SD Image Sorter is running!
echo.
echo   Open browser: http://localhost:8000
echo   Press Ctrl+C to stop the server.
echo ==========================================
echo.

REM ── Open browser and start server ─────────────────────────────
start "" http://localhost:8000

cd backend
call venv\Scripts\activate.bat 2>nul
python main.py

echo.
echo Server stopped.
pause
