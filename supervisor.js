const { spawn } = require('child_process');
const path = require('path');

function startServer() {
  console.log(`[Supervisor] Starting server.js at ${new Date().toISOString()}...`);
  
  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    console.log(`[Supervisor] server.js exited with code ${code} at ${new Date().toISOString()}.`);
    console.log('[Supervisor] Restarting server in 5 seconds...');
    setTimeout(startServer, 5000);
  });

  child.on('error', (err) => {
    console.error('[Supervisor] Failed to start child process:', err);
    console.log('[Supervisor] Retrying in 5 seconds...');
    setTimeout(startServer, 5000);
  });
}

startServer();
