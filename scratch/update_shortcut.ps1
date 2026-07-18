$sh = New-Object -ComObject WScript.Shell
$shortcut = $sh.CreateShortcut('C:\Users\New\Desktop\Antigravity.lnk')
$shortcut.TargetPath = 'D:\Whatsapp Attendance Tracking\dist\Antigravity Attendance System-win32-x64\Antigravity Attendance System.exe'
$shortcut.WorkingDirectory = 'D:\Whatsapp Attendance Tracking\dist\Antigravity Attendance System-win32-x64'
$shortcut.Save()
Write-Host "Desktop shortcut updated successfully!"
