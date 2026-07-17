'use strict';
const { spawn } = require('child_process');

let restartCount = 0;
let lastRestartTime = 0;

function getRestartDelay() {
  const now = Date.now();
  // Reset backoff if the last crash was more than 2 minutes ago (stable run)
  if (now - lastRestartTime > 120000) {
    restartCount = 0;
  }
  lastRestartTime = now;
  restartCount++;
  // Exponential backoff capped at 30 seconds
  const delay = Math.min(5000 * Math.pow(1.5, Math.min(restartCount - 1, 6)), 30000);
  return Math.round(delay);
}

function startServer() {
  console.log(`[Supervisor] Starting server.js at ${new Date().toISOString()} (restart #${restartCount})...`);

  let child;
  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
  } catch (spawnErr) {
    console.error('[Supervisor] Failed to spawn server.js:', spawnErr.message);
    const delay = getRestartDelay();
    console.log(`[Supervisor] Retrying in ${delay}ms...`);
    setTimeout(startServer, delay);
    return;
  }

  child.stdout.on('data', (data) => {
    try { process.stdout.write(data); } catch (e) {}
  });
  child.stdout.on('error', (err) => {
    console.error('[Supervisor] child.stdout error:', err.message);
  });

  child.stderr.on('data', (data) => {
    try { process.stderr.write(data); } catch (e) {}
  });
  child.stderr.on('error', (err) => {
    console.error('[Supervisor] child.stderr error:', err.message);
  });

  child.on('close', (code, signal) => {
    console.log(`[Supervisor] server.js exited (code=${code}, signal=${signal}) at ${new Date().toISOString()}.`);
    const delay = getRestartDelay();
    console.log(`[Supervisor] Restarting server in ${delay}ms... (restart #${restartCount})`);
    setTimeout(startServer, delay);
  });

  child.on('error', (err) => {
    console.error('[Supervisor] Child process error:', err.message);
    const delay = getRestartDelay();
    console.log(`[Supervisor] Retrying in ${delay}ms...`);
    setTimeout(startServer, delay);
  });
}

// Prevent supervisor itself from ever dying
process.on('uncaughtException', (err) => {
  console.error('[Supervisor] Uncaught exception (supervisor will keep running):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Supervisor] Unhandled rejection (supervisor will keep running):', reason);
});

// Ignore SIGTERM/SIGINT so supervisor stays alive even if child dies
process.on('SIGTERM', () => {
  console.log('[Supervisor] Received SIGTERM - ignoring to stay alive.');
});

console.log(`[Supervisor] Watchdog started at ${new Date().toISOString()}`);
startServer();
