@echo off
echo ============================================
echo WhatsApp Attendance Tracking System
echo ============================================
echo.
echo [INFO] Starting Face Recognition API...
start "Face Recognition API" run_face_api.bat

echo [INFO] Waiting for Face Recognition API to start (5 seconds)...
ping 127.0.0.1 -n 6 >nul

echo [INFO] Starting Node.js Server...
npm start
