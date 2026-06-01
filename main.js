const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

// Flag to track if the server has started
let serverStarted = false;
const PORT = process.env.PORT || 3000;

// Programmatically start the Express server by importing/running server.js
try {
  console.log('[Electron Main] Starting background Express server...');
  require('./server.js');
  serverStarted = true;
} catch (err) {
  console.error('[Electron Main] Failed to boot Express server:', err.message);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, 'public', 'icon-512.png'),
    title: 'Antigravity Attendance & Payroll System',
    autoHideMenuBar: true, // Hides the classic browser-like top menu for a premium standalone app look
    backgroundColor: '#09090b', // Sleek dark theme matching our CSS background
    show: false, // Don't show until the page starts loading
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Retry loading URL until Express server is up and listening
  const serverUrl = `http://localhost:${PORT}`;
  let retries = 0;
  const maxRetries = 50; // 10 seconds total

  function loadAppUrl() {
    http.get(serverUrl, (res) => {
      console.log(`[Electron Main] Backend is ready. Loading URL: ${serverUrl}`);
      mainWindow.loadURL(serverUrl);
      mainWindow.once('ready-to-show', () => {
        mainWindow.show();
      });
    }).on('error', (err) => {
      retries++;
      if (retries < maxRetries) {
        console.log(`[Electron Main] Backend port ${PORT} not ready yet. Retrying in 200ms... (Attempt ${retries}/${maxRetries})`);
        setTimeout(loadAppUrl, 200);
      } else {
        console.error(`[Electron Main] Express server failed to respond on port ${PORT} after 10 seconds.`);
        mainWindow.loadURL(`data:text/html;charset=utf-8,
          <html>
            <body style="background-color: #09090b; color: #f4f4f5; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; margin: 0; padding: 20px;">
              <h2 style="color: #ef4444;">Server Connection Timeout</h2>
              <p style="color: #a1a1aa; max-width: 400px; margin-bottom: 20px;">The background attendance database server could not be started or is currently blocked on port ${PORT}.</p>
              <button onclick="window.location.reload()" style="background-color: #ff6b00; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer;">Retry Booting Server</button>
            </body>
          </html>
        `);
        mainWindow.show();
      }
    });
  }

  loadAppUrl();

  // Open external links (like exported downloads or browser integrations) in the default system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Ensure single instance lock so running multiple executables doesn't create duplicate server instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[Electron Main] Another instance is already running. Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the existing window if someone tries to open another one
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', createWindow);

  app.on('window-all-closed', () => {
    // Gracefully clean up all background threads on Windows/Mac
    console.log('[Electron Main] Desktop window closed. Terminating background threads...');
    
    // Explicitly shut down WhatsApp Client Puppeteer instances to avoid orphan processes
    try {
      const whatsapp = require('./whatsapp');
      if (whatsapp && typeof whatsapp.logout === 'function') {
        whatsapp.logout();
      }
    } catch (e) {
      console.warn('[Electron Main] Could not trigger clean WhatsApp logout:', e.message);
    }

    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });

  // Ensure process terminates completely on Windows when app exits
  app.on('will-quit', () => {
    console.log('[Electron Main] Will Quit - Triggering final process exit.');
    process.exit(0);
  });
}
