# PowerShell Auto-Deployment Script for InterExt Attendance System
# Executes via Windows Task Scheduler to keep local repository in sync with GitHub

$workingDir = "D:\Whatsapp Attendance Tracking"
Set-Location $workingDir

# Fetch latest commits from remote
git fetch origin main

$local = git rev-parse HEAD
$remote = git rev-parse @{u}

if ($local -ne $remote) {
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Output "[$time] New updates detected on GitHub. Deploying..."
    
    # Perform git pull
    git pull origin main
    
    # Check if package.json was modified
    $diff = git diff --name-only $local $remote
    if ($diff -contains "package.json") {
        Write-Output "[$time] package.json changed. Re-installing dependencies..."
        npm install --production
    }
    
    # Restart all processes under PM2
    pm2 restart all
    Write-Output "[$time] Deployment complete. Services reloaded."
}
