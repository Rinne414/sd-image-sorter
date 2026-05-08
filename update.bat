@echo off
setlocal enabledelayedexpansion

echo ==========================================
echo    SD Image Sorter - Update Tool
echo ==========================================
echo.

cd /d "%~dp0"
set "ROOT_DIR=%CD%"

REM -- Package-local runtime paths, kept in sync with run.bat / run-portable.bat
set "DATA_DIR=%ROOT_DIR%\data"
set "UPDATE_DIR=%ROOT_DIR%\update"
set "TMP_DIR=%DATA_DIR%\tmp"
set "CACHE_DIR=%DATA_DIR%\cache"
set "MODELS_DIR=%DATA_DIR%\models"
set "FAVORITES_DIR=%DATA_DIR%\favorites"
set "CONFIG_DIR=%DATA_DIR%\config"
set "THUMBNAIL_DIR=%DATA_DIR%\thumbnails"

for %%D in ("%DATA_DIR%" "%UPDATE_DIR%" "%TMP_DIR%" "%CACHE_DIR%" "%MODELS_DIR%" "%FAVORITES_DIR%" "%CONFIG_DIR%" "%THUMBNAIL_DIR%") do (
    if not exist "%%~D" mkdir "%%~D"
)

set "SD_IMAGE_SORTER_LAUNCHER=run.bat"
if exist "%ROOT_DIR%\run-portable.bat" set "SD_IMAGE_SORTER_LAUNCHER=run-portable.bat"
set "SD_IMAGE_SORTER_DATA_DIR=%DATA_DIR%"
set "SD_IMAGE_SORTER_CONFIG_DIR=%CONFIG_DIR%"
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

set "PYTHON_CMD="
if exist "%ROOT_DIR%\python\python.exe" (
    set "PYTHON_CMD=%ROOT_DIR%\python\python.exe"
    set "PYTHON_DIR=%ROOT_DIR%\python"
    set "PATH=!PYTHON_DIR!;!PYTHON_DIR!\Scripts;!PYTHON_DIR!\Lib\site-packages;%PATH%"
    echo [OK] Using embedded Python: !PYTHON_CMD!
    goto :found_python
)

if exist "%ROOT_DIR%\backend\venv\Scripts\python.exe" (
    set "PYTHON_CMD=%ROOT_DIR%\backend\venv\Scripts\python.exe"
    echo [OK] Using local venv Python: !PYTHON_CMD!
    goto :found_python
)

for %%C in (python python3 py) do (
    %%C --version >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_CMD=%%C"
        echo [OK] Using PATH Python: !PYTHON_CMD!
        goto :found_python
    )
)

echo [ERROR] Python runtime not found.
echo         Run run.bat once to create backend\venv, or re-download the portable package.
echo.
pause
exit /b 1

:found_python
if not exist "%ROOT_DIR%\backend\update_cli.py" (
    echo [ERROR] Missing backend\update_cli.py. This package is incomplete.
    echo         Please re-download SD Image Sorter.
    pause
    exit /b 1
)

echo.
echo [Info] This updater works even when the web UI cannot open.
echo [Info] Close any running SD Image Sorter window before applying an update.
echo [Info] Use update.bat --check-only to check without downloading or applying.
echo [Info] It will check GitHub, download a verified package, apply it, then relaunch when possible.
echo.
"!PYTHON_CMD!" backend\update_cli.py %*
set "UPDATE_EXIT=!ERRORLEVEL!"

echo.
if not "!UPDATE_EXIT!"=="0" (
    echo ==========================================
    echo   Update failed. Error output above.
    echo ==========================================
    pause
    exit /b !UPDATE_EXIT!
)

echo ==========================================
echo   Update finished.
echo ==========================================
pause
exit /b 0
