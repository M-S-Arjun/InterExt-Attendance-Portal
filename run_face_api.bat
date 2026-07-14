@echo off
cd /d "D:\Whatsapp Attendance Tracking"
:loop
python face_recognition_api.py > face_api_stdout.log 2> face_api_stderr.log
echo.
echo [Supervisor] Face Recognition API crashed or exited. Restarting in 5 seconds...
ping 127.0.0.1 -n 6 >nul
goto loop
