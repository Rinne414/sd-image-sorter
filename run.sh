#!/bin/bash

echo "=========================================="
echo "   SD Image Sorter - Starting..."
echo "=========================================="
echo

# Change to script directory
cd "$(dirname "$0")"

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

if [ "$FIRST_RUN" -eq 1 ]; then
    echo "[3/3] Starting server..."
else
    echo "Starting server..."
fi
echo

echo "=========================================="
echo "  SD Image Sorter is running!"
echo
echo "  Opening browser to:"
echo "    http://localhost:8000"
echo
echo "  Press Ctrl+C to stop the server."
echo "=========================================="
echo

# ── Auto-open browser after a short delay ────────────────────────
(
    sleep 2
    if [ "$(uname)" = "Darwin" ]; then
        open "http://localhost:8000" 2>/dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "http://localhost:8000" 2>/dev/null
    elif command -v wslview &> /dev/null; then
        wslview "http://localhost:8000" 2>/dev/null
    fi
) &

# ── Start the server ─────────────────────────────────────────────
cd backend
$PYTHON_CMD main.py
