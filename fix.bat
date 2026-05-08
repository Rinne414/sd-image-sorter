@echo off
setlocal enabledelayedexpansion

echo ==========================================
echo    SD Image Sorter - Fix / Diagnostics
echo ==========================================
echo.

cd /d "%~dp0"
set "ROOT_DIR=%CD%"

REM -- fix.bat is intentionally not a launcher. Normal startup self-healing belongs in run.bat / run-portable.bat.
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
echo.
echo [Info] fix.bat is for rare repair/diagnostics only.
echo [Info] It does NOT start the app and does NOT choose a replacement startup port.
echo [Info] Normal startup port self-healing is inside run.bat / run-portable.bat.
echo.

echo [1/5] App version and package path
"!PYTHON_CMD!" -c "import sys; sys.path.insert(0, 'backend'); from app_info import APP_VERSION; print('[fix] Version:', APP_VERSION); print('[fix] Package:', r'%ROOT_DIR%')"
echo.

echo [2/5] Localhost port diagnostic
"!PYTHON_CMD!" backend\launcher_port.py --diagnose --format text
if errorlevel 1 (
    echo [fix] Port diagnostic reported an error.
)
echo.

echo [3/5] Windows excluded TCP port ranges ^(diagnostic only^)
netsh interface ipv4 show excludedportrange protocol=tcp 2>nul
if errorlevel 1 (
    echo [fix] Could not query IPv4 excluded port ranges. This is only diagnostic.
)
echo.

echo [4/5] Repair ONNX Runtime package state
"!PYTHON_CMD!" backend\repair_onnxruntime.py --auto
if errorlevel 1 (
    echo [WARN] ONNX Runtime repair reported a problem.
)
echo.

echo [5/5] Repair PyTorch / SAM3 runtime package state
"!PYTHON_CMD!" backend\repair_torch_runtime.py --auto
if errorlevel 1 (
    echo [WARN] PyTorch / SAM3 repair reported a problem.
)
echo.

echo [Info] Startup readiness snapshot
"!PYTHON_CMD!" backend\model_health.py --startup
echo.

echo ==========================================
echo   Fix / diagnostics finished.
echo   Now start normally with %SD_IMAGE_SORTER_LAUNCHER%.
echo   If startup still fails, send the full output above.
echo ==========================================
pause
exit /b 0
