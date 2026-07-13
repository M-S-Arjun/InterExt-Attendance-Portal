@echo off
cd /d "D:\Whatsapp Attendance Tracking"
start "" /b cmd.exe /c run_face_api.bat
start "" /b cmd.exe /c run_node_supervisor.bat
