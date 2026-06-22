#!/bin/bash
# InterExt Attendance Portal - Cloud VPS Auto-Deployment Script
# Instructions: Run 'chmod +x deploy.sh' on the server to make it executable.

echo "=========================================================="
echo "⚡ Starting InterExt Attendance Portal Auto-Deployment ⚡"
echo "=========================================================="

# 1. Pull latest codes from GitHub
echo "[1/3] Pulling updated code from Git repository..."
git pull origin main

# 2. Shut down existing containers
echo "[2/3] Stopping active Docker containers..."
docker compose down

# 3. Build and launch updated Docker container
echo "[3/3] Rebuilding and launching containers in background..."
docker compose up -d --build

echo ""
echo "=========================================================="
echo "✅ Deployment Completed Successfully! Status active. ✅"
echo "=========================================================="
pm2 list 2>/dev/null || true # Output state list if pm2 is present
docker compose ps
