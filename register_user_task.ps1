$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c "D:\Whatsapp Attendance Tracking\run_all.bat"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
Register-ScheduledTask -TaskName "AttendanceServerUser" -Action $action -Trigger $trigger -Force
Write-Host "Scheduled task registered successfully"
