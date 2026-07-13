$taskName = 'AttendanceServer'
$batFile = 'D:\Whatsapp Attendance Tracking\run_server_loop.bat'

# Remove old task if exists
schtasks /Delete /TN $taskName /F 2>$null

# Register new task: runs at logon, highest privileges, no time limit
schtasks /Create /TN $taskName /TR ('cmd.exe /c "' + $batFile + '"') /SC ONLOGON /RL HIGHEST /F

Write-Host "Scheduled task '$taskName' registered."

# Start it immediately
schtasks /Run /TN $taskName
Write-Host "Task started."
