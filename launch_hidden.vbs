Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd.exe /c run_face_api.bat", 0, false
WScript.Sleep 5000
WshShell.Run "cmd.exe /c ""node supervisor.js > server_stdout.log 2> server_stderr.log""", 0, false
