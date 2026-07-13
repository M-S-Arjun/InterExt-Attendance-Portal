@echo off
cd /d "D:\Whatsapp Attendance Tracking"
set PATH=C:\Program Files\nodejs;%PATH%
node supervisor.js > server_stdout.log 2> server_stderr.log
