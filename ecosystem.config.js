module.exports = {
  apps: [
    {
      name: 'attendance',
      script: 'server.js',
      cwd: 'D:\\Whatsapp Attendance Tracking',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      restart_delay: 5000,       // Wait 5s before restarting
      min_uptime: '10s',         // Must be up at least 10s to count as stable
      max_restarts: 100,         // Allow up to 100 restarts
      kill_timeout: 8000,        // Give 8s for graceful shutdown before force-kill
      listen_timeout: 30000,     // Wait up to 30s for the app to start
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      out_file: 'D:\\Whatsapp Attendance Tracking\\pm2_attendance.log',
      error_file: 'D:\\Whatsapp Attendance Tracking\\pm2_attendance_error.log',
    }
  ]
};
