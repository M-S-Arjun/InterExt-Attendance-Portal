#!/bin/bash

# WhatsApp Attendance Tracking - Complete Startup Script
# This script starts both the Face Recognition API and Node.js server

echo ""
echo "============================================"
echo "WhatsApp Attendance Tracking System"
echo "============================================"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python 3 not found"
    echo "Please install Python 3.9+ from https://www.python.org/"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "[OK] Python and Node.js detected"
echo ""

# Check if requirements are installed
echo "Checking Python dependencies..."
if ! python3 -c "import insightface" 2>/dev/null; then
    echo "[INFO] Installing Python dependencies from requirements.txt..."
    pip3 install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo "[ERROR] Failed to install Python dependencies"
        exit 1
    fi
    echo "[OK] Dependencies installed"
else
    echo "[OK] Python dependencies already installed"
fi

echo ""
echo "============================================"
echo "Starting Services..."
echo "============================================"
echo ""

# Start Face Recognition API in background
echo "[INFO] Starting Face Recognition API (Python Flask server)..."
python3 face_recognition_api.py > face_api.log 2>&1 &
FACE_API_PID=$!
echo "[INFO] Face API PID: $FACE_API_PID"

# Wait for API to start
echo "[INFO] Waiting for Face Recognition API to start (5 seconds)..."
sleep 5

# Verify API is running
if curl -s http://localhost:5000/health > /dev/null; then
    echo "[OK] Face Recognition API is running on http://localhost:5000"
else
    echo "[WARNING] Could not verify Face Recognition API is running"
    echo "Check face_api.log for errors"
fi

echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing Node.js dependencies (npm install)..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] Failed to install Node.js dependencies"
        kill $FACE_API_PID
        exit 1
    fi
    echo "[OK] Node.js dependencies installed"
else
    echo "[OK] Node.js dependencies already installed"
fi

echo ""
echo "============================================"
echo "System started successfully!"
echo "============================================"
echo ""
echo "WebUI: http://localhost:3000"
echo "Face API: http://localhost:5000"
echo ""
echo "Camera Attendance: Use 'Camera Attendance' tab to record events"
echo "Face Recognition: Use 'Recognize Face' button with employee photos"
echo ""
echo "Press Ctrl+C to stop all services"
echo "============================================"
echo ""

# Trap Ctrl+C to clean up
trap "kill $FACE_API_PID; exit" INT

# Start Node.js server
npm start
