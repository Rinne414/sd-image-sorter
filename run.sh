#!/bin/bash

echo "=========================================="
echo "   SD Image Sorter - Starting..."
echo "=========================================="
echo

# Change to script directory
cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

# ── Package-local runtime paths ──────────────────────────────────
DATA_DIR="${ROOT_DIR}/data"
UPDATE_DIR="${ROOT_DIR}/update"
TMP_DIR="${DATA_DIR}/tmp"
CACHE_DIR="${DATA_DIR}/cache"
MODELS_DIR="${DATA_DIR}/models"
FAVORITES_DIR="${DATA_DIR}/favorites"
CONFIG_DIR="${DATA_DIR}/config"
THUMBNAIL_DIR="${DATA_DIR}/thumbnails"

mkdir -p "${DATA_DIR}" "${UPDATE_DIR}" "${TMP_DIR}" "${CACHE_DIR}" "${MODELS_DIR}" "${FAVORITES_DIR}" "${CONFIG_DIR}" "${THUMBNAIL_DIR}"

export SD_IMAGE_SORTER_LAUNCHER="run.sh"
export SD_IMAGE_SORTER_DATA_DIR="${DATA_DIR}"
export SD_IMAGE_SORTER_CONFIG_DIR="${CONFIG_DIR}"
export SD_IMAGE_SORTER_TMP_DIR="${TMP_DIR}"
export SD_IMAGE_SORTER_UPDATE_DIR="${UPDATE_DIR}"
export SD_IMAGE_SORTER_THUMBNAIL_DIR="${THUMBNAIL_DIR}"
export SD_IMAGE_SORTER_DB_PATH="${DATA_DIR}/images.db"
export SD_IMAGE_SORTER_FAVORITES_PATH="${FAVORITES_DIR}"
export SD_IMAGE_SORTER_WD14_MODEL_DIR="${MODELS_DIR}/wd14-tagger"
export SD_IMAGE_SORTER_YOLO_MODEL_DIR="${MODELS_DIR}/yolo"
export SD_IMAGE_SORTER_CLIP_MODEL_DIR="${MODELS_DIR}/clip"
export SD_IMAGE_SORTER_ARTIST_MODEL_DIR="${MODELS_DIR}/artist"
export SD_IMAGE_SORTER_SAM3_MODEL_DIR="${MODELS_DIR}/sam3"
export SD_IMAGE_SORTER_NUDENET_MODEL_DIR="${MODELS_DIR}/nudenet"
export SD_IMAGE_SORTER_TORIIGATE_MODEL_DIR="${MODELS_DIR}/toriigate"
export SD_IMAGE_SORTER_CACHE_DIR="${CACHE_DIR}"
export HF_HOME="${DATA_DIR}/hf"
export TRANSFORMERS_CACHE="${DATA_DIR}/hf/transformers"
export XDG_CACHE_HOME="${CACHE_DIR}"
export TORCH_HOME="${DATA_DIR}/torch"
export PIP_CACHE_DIR="${DATA_DIR}/pip-cache"
export TMPDIR="${TMP_DIR}"
export TEMP="${TMP_DIR}"
export TMP="${TMP_DIR}"

# ── Check if Python is available ─────────────────────────────────
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
else
    echo "[ERROR] Python is not installed or not in PATH."
    echo "        Please install Python 3.9+ from https://python.org"
    exit 1
fi

# ── Check Python version (must be >= 3.9) ────────────────────────
PY_VER=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 9 ]; }; then
    echo "[ERROR] Python $PY_VER is too old. Python 3.9 or higher is required."
    echo "        Please upgrade from https://python.org"
    exit 1
fi

echo "[OK] Python $PY_VER detected."
echo

# ── Detect first run ────────────────────────────────────────────
FIRST_RUN=0
if [ ! -d "backend/venv" ]; then
    FIRST_RUN=1
fi

# ── First-run welcome message ───────────────────────────────────
if [ "$FIRST_RUN" -eq 1 ]; then
    echo "=========================================="
    echo "  Welcome to SD Image Sorter!"
    echo "=========================================="
    echo
    echo "  This tool helps you manage your Stable"
    echo "  Diffusion images with:"
    echo
    echo "    - Gallery browsing with metadata"
    echo "    - AI-powered auto-tagging"
    echo "    - Smart sorting (manual + auto)"
    echo "    - Built-in censor editor"
    echo
    echo "  Setting up for the first time..."
    echo "  This only needs to happen once."
    echo "=========================================="
    echo
fi

# ── Create venv if needed ───────────────────────────────────────
if [ "$FIRST_RUN" -eq 1 ]; then
    echo "[1/3] Creating Python virtual environment..."
    $PYTHON_CMD -m venv backend/venv
    if [ $? -ne 0 ]; then
        echo "[ERROR] Failed to create virtual environment."
        echo "        On Debian/Ubuntu, you may need: sudo apt install python3-venv"
        exit 1
    fi
    echo "      Done."
    echo
fi

# ── Activate venv ───────────────────────────────────────────────
source backend/venv/bin/activate

# ── Check if dependencies need installing/updating ──────────────
NEED_INSTALL=0

# On first run, always install
if [ "$FIRST_RUN" -eq 1 ]; then
    NEED_INSTALL=1
fi

# Check if requirements.txt changed since last install
if [ "$NEED_INSTALL" -eq 0 ]; then
    if [ ! -f "backend/.requirements_hash" ]; then
        NEED_INSTALL=1
    else
        # Generate current hash
        if command -v md5sum &> /dev/null; then
            NEW_HASH=$(md5sum backend/requirements.txt | awk '{print $1}')
        elif command -v md5 &> /dev/null; then
            NEW_HASH=$(md5 -q backend/requirements.txt)
        else
            # Fallback: always reinstall if no hash tool available
            NEED_INSTALL=1
        fi

        if [ "$NEED_INSTALL" -eq 0 ]; then
            OLD_HASH=$(cat backend/.requirements_hash)
            if [ "$NEW_HASH" != "$OLD_HASH" ]; then
                echo "[INFO] requirements.txt has changed since last install."
                NEED_INSTALL=1
            fi
        fi
    fi
fi

# ── Install/update dependencies ─────────────────────────────────
if [ "$NEED_INSTALL" -eq 1 ]; then
    if [ "$FIRST_RUN" -eq 1 ]; then
        echo "[2/3] Installing dependencies..."
    else
        echo "[INFO] Updating dependencies..."
    fi
    echo "      This may take 5-10 minutes on first run."
    echo "      Please be patient, large AI models are being downloaded."
    echo

    pip install -r backend/requirements.txt
    if [ $? -ne 0 ]; then
        echo
        echo "[ERROR] Failed to install dependencies."
        echo "        Check your internet connection and try again."
        exit 1
    fi

    # Save requirements hash for future change detection
    if command -v md5sum &> /dev/null; then
        md5sum backend/requirements.txt | awk '{print $1}' > backend/.requirements_hash
    elif command -v md5 &> /dev/null; then
        md5 -q backend/requirements.txt > backend/.requirements_hash
    fi

    echo
    echo "      Dependencies installed successfully."
    echo
else
    echo "[OK] Dependencies are up to date."
    echo
fi

echo "[Info] Checking ONNX Runtime package state..."
backend/venv/bin/python backend/repair_onnxruntime.py --auto || {
    echo "[WARN] Could not auto-repair ONNX Runtime package state."
    echo "       The app can still start, but WD14 tagging may stay on CPU."
}
echo

echo "[Info] Checking startup readiness..."
backend/venv/bin/python backend/model_health.py --startup
echo

if [ "$FIRST_RUN" -eq 1 ]; then
    echo "[3/3] Starting server..."
else
    echo "Starting server..."
fi
echo

# Honor SD_IMAGE_SORTER_PORT override for the browser URL; default 8487.
APP_PORT="${SD_IMAGE_SORTER_PORT:-8487}"
APP_URL="http://localhost:${APP_PORT}"

echo "=========================================="
echo "  SD Image Sorter is running!"
echo
echo "  Opening browser to:"
echo "    ${APP_URL}"
echo
echo "  Press Ctrl+C to stop the server."
echo "=========================================="
echo

# ── Auto-open browser after a short delay ────────────────────────
(
    sleep 2
    if [ "$(uname)" = "Darwin" ]; then
        open "${APP_URL}" 2>/dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "${APP_URL}" 2>/dev/null
    elif command -v wslview &> /dev/null; then
        wslview "${APP_URL}" 2>/dev/null
    fi
) &

# ── Start the server ─────────────────────────────────────────────
cd backend
$PYTHON_CMD main.py
