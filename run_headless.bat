@echo off
cd /d "D:\Whatsapp Attendance Tracking"
node supervisor.js > server_stdout.log 2> server_stderr.log
