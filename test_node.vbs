Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\Whatsapp Attendance Tracking"
WshShell.Run "cmd.exe /c run_node_supervisor.bat", 0, false
