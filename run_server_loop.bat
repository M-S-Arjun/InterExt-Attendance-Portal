@echo off
cd /d "D:\Whatsapp Attendance Tracking"
set PATH=C:\Program Files\nodejs;%PATH%
:loop
node server.js >> server_stdout.log 2>> server_stderr.log
echo [Supervisor] server.js exited. Restarting in 5 seconds... >> server_stdout.log
timeout /t 5 /nobreak > nul
goto loop
