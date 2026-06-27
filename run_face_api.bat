@echo off
title Face Recognition API
:loop
python face_recognition_api.py
echo.
echo [Supervisor] Face Recognition API crashed or exited. Restarting in 5 seconds...
ping 127.0.0.1 -n 6 >nul
goto loop
