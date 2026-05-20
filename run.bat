@echo off
setlocal enabledelayedexpansion

echo ==========================================
echo    SD Image Sorter - Starting...
echo ==========================================
echo.

cd /d "%~dp0"
set "ROOT_DIR=%CD%"

REM -- Package-local runtime paths
set "DATA_DIR=%ROOT_DIR%\data"
set "UPDATE_DIR=%ROOT_DIR%\update"
set "TMP_DIR=%DATA_DIR%\tmp"
set "CACHE_DIR=%DATA_DIR%\cache"
set "MODELS_DIR=%DATA_DIR%\models"
set "FAVORITES_DIR=%DATA_DIR%\favorites"
set "CONFIG_DIR=%DATA_DIR%\config"
set "STATE_DIR=%DATA_DIR%\state"
set "THUMBNAIL_DIR=%DATA_DIR%\thumbnails"

for %%D in ("%DATA_DIR%" "%UPDATE_DIR%" "%TMP_DIR%" "%CACHE_DIR%" "%MODELS_DIR%" "%FAVORITES_DIR%" "%CONFIG_DIR%" "%STATE_DIR%" "%THUMBNAIL_DIR%") do (
    if not exist "%%~D" mkdir "%%~D"
)

set "SD_IMAGE_SORTER_LAUNCHER=run.bat"
set "SD_IMAGE_SORTER_DATA_DIR=%DATA_DIR%"
set "SD_IMAGE_SORTER_CONFIG_DIR=%CONFIG_DIR%"
set "SD_IMAGE_SORTER_STATE_DIR=%STATE_DIR%"
set "SD_IMAGE_SORTER_TMP_DIR=%TMP_DIR%"
set "SD_IMAGE_SORTER_UPDATE_DIR=%UPDATE_DIR%"
set "SD_IMAGE_SORTER_THUMBNAIL_DIR=%THUMBNAIL_DIR%"
set "SD_IMAGE_SORTER_DB_PATH=%DATA_DIR%\images.db"
set "SD_IMAGE_SORTER_FAVORITES_PATH=%FAVORITES_DIR%"
set "SD_IMAGE_SORTER_WD14_MODEL_DIR=%MODELS_DIR%\wd14-tagger"
set "SD_IMAGE_SORTER_YOLO_MODEL_DIR=%MODELS_DIR%\yolo"
set "SD_IMAGE_SORTER_CLIP_MODEL_DIR=%MODELS_DIR%\clip"
set "SD_IMAGE_SORTER_ARTIST_MODEL_DIR=%MODELS_DIR%\artist"
set "SD_IMAGE_SORTER_SAM3_MODEL_DIR=%MODELS_DIR%\sam3"
set "SD_IMAGE_SORTER_NUDENET_MODEL_DIR=%MODELS_DIR%\nudenet"
set "SD_IMAGE_SORTER_TORIIGATE_MODEL_DIR=%MODELS_DIR%\toriigate"
set "SD_IMAGE_SORTER_CACHE_DIR=%CACHE_DIR%"
set "HF_HOME=%DATA_DIR%\hf"
set "TRANSFORMERS_CACHE=%DATA_DIR%\hf\transformers"
set "XDG_CACHE_HOME=%CACHE_DIR%"
set "TORCH_HOME=%DATA_DIR%\torch"
set "PIP_CACHE_DIR=%DATA_DIR%\pip-cache"
set "TEMP=%TMP_DIR%"
set "TMP=%TMP_DIR%"

REM -- If the user requested a lightweight runtime reset from Feature Setup,
REM -- consume that request before activating Python. Never delete data/, models, or DB.
set "VENV_REBUILD_MARKER=%STATE_DIR%\rebuild-core-venv.json"
if exist "!VENV_REBUILD_MARKER!" (
    echo [INFO] Lightweight runtime rebuild requested.
    echo        Removing backend\venv only; user data, models, cache settings, and images.db stay untouched.
    if exist "backend\venv" (
        rmdir /s /q "backend\venv"
        if exist "backend\venv" (
            echo [ERROR] Could not remove backend\venv.
            echo         Close every SD Image Sorter / Python window, then run run.bat again.
            pause
            exit /b 1
        )
    )
    if exist "backend\.requirements_hash" del "backend\.requirements_hash" >nul 2>&1
    del "!VENV_REBUILD_MARKER!" >nul 2>&1
    echo        Runtime environment will be recreated with the selected dependency mode.
    echo.
)

REM -- Find Python
set "PYTHON_CMD="

REM Try common user-managed Python locations first
for %%P in (
    "%USERPROFILE%\Anaconda3\python.exe"
    "%USERPROFILE%\miniconda3\python.exe"
    "C:\ProgramData\Anaconda3\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
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
echo         Please install Python 3.12+ from https://python.org
echo.
pause
exit /b 1

:found_python
echo [OK] Found Python: !PYTHON_CMD!

REM -- Check Python version (>= 3.12)
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
    echo [ERROR] Python !PY_VER! is too old. Python 3.12+ required.
    pause
    exit /b 1
)
if !PY_MAJOR! EQU 3 if !PY_MINOR! LSS 12 (
    echo [ERROR] Python !PY_VER! is too old. Python 3.12+ required.
    pause
    exit /b 1
)

echo [OK] Python !PY_VER!
echo.

REM -- Detect first run
set FIRST_RUN=0
if not exist "backend\venv\Scripts\python.exe" set FIRST_RUN=1
set NEED_INSTALL=0
set NEW_HASH=
set OLD_HASH=
set "INSTALL_REQUIREMENTS=backend\requirements-core.txt"
set "INSTALL_MODE_LABEL=core runtime dependencies"
if "!SD_IMAGE_SORTER_INSTALL_FULL_AI!"=="1" (
    set "INSTALL_REQUIREMENTS=backend\requirements.txt"
    set "INSTALL_MODE_LABEL=full AI runtime dependencies"
)

if !FIRST_RUN! EQU 1 (
    echo ==========================================
    echo   First run - setting up environment...
    echo   Lightweight setup installs core runtime first.
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
    set NEED_INSTALL=1
) else (
    if not exist "backend\.requirements_hash" (
        set NEED_INSTALL=1
    ) else (
        where certutil >nul 2>&1
        if errorlevel 1 (
            echo [INFO] certutil not found. Refreshing dependencies to stay in sync.
            set NEED_INSTALL=1
        ) else (
            for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "!INSTALL_REQUIREMENTS!" MD5 ^| findstr /r /v "hash of file CertUtil"') do (
                if not defined NEW_HASH set "NEW_HASH=%%H"
            )
            set "NEW_HASH=!NEW_HASH: =!"
            set /p OLD_HASH=<backend\.requirements_hash
            if /I not "!NEW_HASH!"=="!OLD_HASH!" (
                echo [INFO] !INSTALL_REQUIREMENTS! changed. Updating dependencies...
                set NEED_INSTALL=1
            )
        )
    )
)

if !NEED_INSTALL! EQU 0 (
    backend\venv\Scripts\python.exe -c "import fastapi, PIL, numpy, onnxruntime" >nul 2>&1
    if errorlevel 1 (
        echo [INFO] Python runtime packages look incomplete. Reinstalling dependencies...
        set NEED_INSTALL=1
    )
)

if !NEED_INSTALL! EQU 1 (
    REM -- Probe the fastest reachable PyPI mirror BEFORE installing.
    REM    Uses stdlib only because httpx is not available yet.
    REM    Saves 10-25 minutes on the ~1.5 GB requirements.txt download for
    REM    users behind slow paths to pypi.org's Fastly CDN.
    set "PIP_INDEX_URL=https://pypi.org/simple"
    set "MIRROR_PROBE_OUT=!TMP_DIR!\pip-index-url-!RANDOM!.tmp"
    "!PYTHON_CMD!" backend\mirror_probe_stdlib.py > "!MIRROR_PROBE_OUT!" 2>nul
    if exist "!MIRROR_PROBE_OUT!" (
        set /p PIP_INDEX_URL=<"!MIRROR_PROBE_OUT!"
        del "!MIRROR_PROBE_OUT!" >nul 2>&1
    )
    if not defined PIP_INDEX_URL set "PIP_INDEX_URL=https://pypi.org/simple"
    echo [Info] PyPI mirror selected: !PIP_INDEX_URL!
    echo.

    echo [INFO] Preparing Python build tools for source-only packages...
    backend\venv\Scripts\python.exe backend\launcher_pip.py install --index-url "!PIP_INDEX_URL!" --extra-index-url https://pypi.org/simple setuptools wheel
    if errorlevel 1 (
        echo [ERROR] Failed to install Python build tools.
        pause
        exit /b 1
    )
    echo [2/3] Installing !INSTALL_MODE_LABEL!...
    if /I "!INSTALL_REQUIREMENTS!"=="backend\requirements-core.txt" (
        echo       Heavy AI packages install later only when you click Prepare/Download for that feature.
    ) else (
        echo       Full AI mode may take 10-20 minutes and download large GPU/runtime packages.
    )
    backend\venv\Scripts\python.exe backend\launcher_pip.py install --no-build-isolation --index-url "!PIP_INDEX_URL!" --extra-index-url https://pypi.org/simple -r "!INSTALL_REQUIREMENTS!"
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    if not defined NEW_HASH (
        where certutil >nul 2>&1
        if not errorlevel 1 (
            for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "!INSTALL_REQUIREMENTS!" MD5 ^| findstr /r /v "hash of file CertUtil"') do (
                if not defined NEW_HASH set "NEW_HASH=%%H"
            )
            set "NEW_HASH=!NEW_HASH: =!"
        )
    )
    if defined NEW_HASH (
        > backend\.requirements_hash echo !NEW_HASH!
    )
    echo       Done.
    echo.
)

if "!SD_IMAGE_SORTER_INSTALL_FULL_AI!"=="1" (
    echo [Info] Checking Windows ONNX Runtime package state...
    backend\venv\Scripts\python.exe backend\repair_onnxruntime.py --auto
    if errorlevel 1 (
        echo [WARN] Could not auto-repair ONNX Runtime package state.
        echo        The app can still start, but WD14 tagging may stay on CPU.
    )
) else (
    echo [Info] Skipping Windows ONNX GPU repair for lightweight startup.
    echo        WD14 can still run on CPU; set SD_IMAGE_SORTER_INSTALL_FULL_AI=1 for GPU runtime repair.
)
echo.

if "!SD_IMAGE_SORTER_INSTALL_FULL_AI!"=="1" (
    echo [Info] Checking Windows PyTorch / SAM3 runtime package state...
    backend\venv\Scripts\python.exe backend\repair_torch_runtime.py --auto
    if errorlevel 1 (
        echo [WARN] Could not auto-repair PyTorch / SAM3 runtime package state.
        echo        The app can still start, but SAM3 and CUDA Torch features may stay unavailable.
    )
) else (
    echo [Info] Skipping Windows PyTorch / SAM3 repair for lightweight startup.
    echo        Set SD_IMAGE_SORTER_INSTALL_FULL_AI=1 or use Model Manager Prepare when needed.
)
echo.

echo [Info] Checking startup readiness...
backend\venv\Scripts\python.exe backend\model_health.py --startup
echo.

REM -- Honor SD_IMAGE_SORTER_PORT override for the browser URL; default 8487.
set "APP_PORT=!SD_IMAGE_SORTER_PORT!"
if "!APP_PORT!"=="" set "APP_PORT=8487"
set "PORT_ENV_FILE=!TEMP!\sd-image-sorter-port-!RANDOM!.tmp"
backend\venv\Scripts\python.exe backend\launcher_port.py --format cmd > "!PORT_ENV_FILE!"
set "PORT_CHECK_EXIT=!ERRORLEVEL!"
for /f "usebackq tokens=1,* delims==" %%A in ("!PORT_ENV_FILE!") do (
    set "%%A=%%B"
)
del "!PORT_ENV_FILE!" >nul 2>&1
if "!SD_IMAGE_SORTER_PORT_STATUS!"=="" (
    echo [ERROR] Could not check localhost port availability.
    pause
    exit /b 1
)
if /I "!SD_IMAGE_SORTER_PORT_STATUS!"=="error" (
    echo [ERROR] !SD_IMAGE_SORTER_PORT_MESSAGE!
    echo.
    echo If Windows reserved port !APP_PORT!, either reboot or run:
    echo   netsh interface ipv4 show excludedportrange protocol=tcp
    echo Then choose another port, for example:
    echo   set SD_IMAGE_SORTER_PORT=8587
    echo   run.bat
    pause
    exit /b 1
)
if not "!PORT_CHECK_EXIT!"=="0" (
    echo [ERROR] Could not check localhost port availability.
    pause
    exit /b 1
)
set "APP_PORT=!SD_IMAGE_SORTER_PORT!"
set "APP_URL_HOST=!SD_IMAGE_SORTER_URL_HOST!"
if "!APP_URL_HOST!"=="" set "APP_URL_HOST=127.0.0.1"
if /I "!SD_IMAGE_SORTER_PORT_STATUS!"=="changed" (
    echo [WARN] !SD_IMAGE_SORTER_PORT_MESSAGE!
)
set "APP_URL=http://!APP_URL_HOST!:!APP_PORT!"

echo.
echo ==========================================
echo   SD Image Sorter is running!
echo.
echo   Open browser: !APP_URL!
echo   Press Ctrl+C to stop the server.
echo ==========================================
echo.

REM -- Open browser and start server
start "" !APP_URL!

cd backend
call venv\Scripts\activate.bat 2>nul
python main.py --port !APP_PORT!
set "SERVER_EXIT_CODE=!ERRORLEVEL!"

echo.
if "!SERVER_EXIT_CODE!"=="0" (
    echo Server stopped normally.
) else (
    echo [ERROR] Server exited with code !SERVER_EXIT_CODE!.
    echo         If startup failed immediately, check whether another SD Image Sorter window is already using port !APP_PORT!.
    echo         You can run fix.bat for port/runtime diagnostics.
)
pause
