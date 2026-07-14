Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\Whatsapp Attendance Tracking"
WshShell.Run "cmd.exe /c ""D:\Whatsapp Attendance Tracking\run_all.bat""", 0, false
