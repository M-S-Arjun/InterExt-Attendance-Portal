@echo off
REM WhatsApp Attendance Tracking - Complete Startup Script
REM This script starts both the Face Recognition API and Node.js server

echo.
echo ============================================
echo WhatsApp Attendance Tracking System
echo ============================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found in PATH
    echo Please install Python 3.9+ from https://www.python.org/
    echo Make sure to check "Add Python to PATH" during installation
    pause
    exit /b 1
)

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Python and Node.js detected
echo.

REM Check if requirements are installed
echo Checking Python dependencies...
python -c "import insightface" >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Installing Python dependencies from requirements.txt...
    pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install Python dependencies
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
) else (
    echo [OK] Python dependencies already installed
)

echo.
echo ============================================
echo Starting Services...
echo ============================================
echo.

REM Start Face Recognition API in new window
echo [INFO] Starting Face Recognition API (Python Flask server)...
start "Face Recognition API" cmd /k "python face_recognition_api.py"

REM Wait for API to start
echo [INFO] Waiting for Face Recognition API to start (5 seconds)...
timeout /t 5

REM Verify API is running
python -c "import requests; requests.get('http://localhost:5000/health')" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Face Recognition API is running on http://localhost:5000
) else (
    echo [WARNING] Could not verify Face Recognition API is running
    echo Please check the API window for errors
)

echo.

REM Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] Installing Node.js dependencies (npm install)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install Node.js dependencies
        pause
        exit /b 1
    )
    echo [OK] Node.js dependencies installed
) else (
    echo [OK] Node.js dependencies already installed
)

echo.
echo [INFO] Starting Node.js Server...
echo.
echo ============================================
echo System started successfully!
echo ============================================
echo.
echo WebUI: http://localhost:3000
echo Face API: http://localhost:5000
echo.
echo Camera Attendance: Use "Camera Attendance" tab to record events
echo Face Recognition: Use "Recognize Face" button with employee photos
echo.
echo Press Ctrl+C to stop the server (other window must be closed manually)
echo ============================================
echo.

REM Start Node.js server
npm start
