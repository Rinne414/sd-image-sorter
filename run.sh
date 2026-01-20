#!/bin/bash

echo "=========================================="
echo "   SD Image Sorter - Starting..."
echo "=========================================="
echo

# Change to script directory
cd "$(dirname "$0")"

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    if ! command -v python &> /dev/null; then
        echo "ERROR: Python is not installed or not in PATH"
        echo "Please install Python 3.9+ from https://python.org"
        exit 1
    fi
    PYTHON_CMD="python"
else
    PYTHON_CMD="python3"
fi

echo "Using Python: $($PYTHON_CMD --version)"
echo

# Check if dependencies are installed
if [ ! -d "backend/venv" ]; then
    echo "First run detected. Setting up virtual environment..."
    echo
    $PYTHON_CMD -m venv backend/venv
    source backend/venv/bin/activate
    pip install -r backend/requirements.txt
else
    source backend/venv/bin/activate
fi

echo
echo "Starting server..."
echo
echo "========================================"
echo "  Open your browser to:"
echo "  http://localhost:8000"
echo "========================================"
echo
echo "Press Ctrl+C to stop the server."
echo

cd backend
$PYTHON_CMD main.py
