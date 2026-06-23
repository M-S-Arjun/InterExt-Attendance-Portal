require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Synchonous process cleanup for production-grade reliability
try {
  if (process.platform === 'win32') {
    console.log("[Process Cleanup] Scanning and terminating orphan Chrome processes...");
    const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name = 'chrome.exe'\\" | ForEach-Object { if ($_.CommandLine -like '*wwebjs_auth*' -or $_.CommandLine -like '*puppeteer*') { Stop-Process -Id $_.ProcessId -Force } }"`;
    execSync(psCommand, { stdio: 'ignore' });
    console.log("[Process Cleanup] Completed scanning and terminating orphan Chrome processes.");
  }
} catch (err) {
  console.warn("[Process Cleanup] Warning: Could not execute Chrome cleanup on boot:", err.message);
}

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const XLSX = require('xlsx');
const database = require('./database');
const whatsapp = require('./whatsapp');
const bcrypt = require('bcryptjs');

const FACE_RECOGNITION_MIN_CONFIDENCE = 0.52;

function getLocalDateString(dateInput = new Date()) {
  const d = new Date(dateInput);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// In-memory stack to store resolved/deleted exception actions for the undo function
const undoStack = [];
const redoStack = [];

// In-memory rolling cache of the last 20 messages for the realtime dashboard feed
const recentMessages = [];

function addToRecentMessages(type, data) {
  if (type === 'parsed') {
    // Attempt to locate and upgrade the corresponding raw message in the cache
    const existing = recentMessages.find(m => 
      m.sender === data.sender && 
      m.timestamp === data.timestamp &&
      m.messageText === data.messageText
    );
    if (existing) {
      existing.type = 'parsed';
      existing.parseResult = data.parseResult;
      existing.loggedRecord = data.loggedRecord;
      return;
    }
  }

  // Otherwise, push new
  const msgObj = {
    type: type,
    ...data
  };
  
  // Prevent duplicate raw insertions
  const isDuplicateRaw = type === 'raw' && recentMessages.some(m =>
    m.sender === data.sender &&
    m.timestamp === data.timestamp &&
    m.messageText === data.messageText
  );
  if (isDuplicateRaw) return;

  recentMessages.push(msgObj);
  if (recentMessages.length > 20) {
    recentMessages.shift();
  }
}

// Seed recent messages from database (pending messages and recent attendance logs) on startup
try {
  const db = database.read();
  const seeded = [];
  
  // 1. Add pending messages
  if (db.pending_messages) {
    db.pending_messages.forEach(msg => {
      seeded.push({
        type: 'raw',
        sender: msg.sender,
        messageText: msg.messageText,
        timestamp: msg.timestamp || new Date().toISOString()
      });
    });
  }

  // 2. Add attendance logs that have source messages
  if (db.attendance) {
    db.attendance.forEach(log => {
      if (log.messageText) {
        const emp = (db.employees || []).find(e => e && (e.id === log.employeeId || e.name === log.employeeName));
        const senderPhone = emp && emp.phone ? emp.phone : (log.employeeName || 'System');
        seeded.push({
          type: 'parsed',
          sender: senderPhone,
          messageText: log.messageText,
          timestamp: log.checkIn || log.checkOut || (log.date + 'T12:00:00.000Z'),
          parseResult: {
            isSuccess: true,
            extractedAction: log.checkOut ? 'out' : 'in',
            extractedSite: log.siteName || 'Main Site'
          }
        });
      }
    });
  }

  // Sort by timestamp descending
  seeded.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Take the last 20 messages and push them (oldest first to preserve rolling push order)
  const initialBatch = seeded.slice(0, 20).reverse();
  initialBatch.forEach(msg => {
    recentMessages.push(msg);
  });
  console.log(`[Recent Cache] Seeded rolling cache with ${recentMessages.length} messages from database history.`);
} catch (err) {
  console.error("[Recent Cache] Failed to seed recent messages from DB:", err);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Enable permissive CORS for mobile Capacitor origins (capacitor://localhost or http://localhost)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Memory-based cache for active admin sessions (zero-dependency session security)
const activeSessions = new Set();

// Simple helper to parse cookies from headers
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Allowed public assets/endpoints
const publicPaths = [
  '/login',
  '/api/admin/login',
  '/style.css',
  '/lucide.min.js',
  '/logo.jpg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/sw.js',
  '/favicon.ico'
];

function requireAdminAuth(req, res, next) {
  const reqPath = req.path;
  
  // 1. Allow explicit public paths and worker app endpoints
  if (
    publicPaths.includes(reqPath) ||
    reqPath.startsWith('/mobile') ||
    reqPath.startsWith('/checkin') ||
    reqPath.startsWith('/api/checkin') ||
    reqPath.startsWith('/api/employee') ||
    reqPath === '/api/face/cctv-event'
  ) {
    return next();
  }
  
  // 2. Extract and verify session token against active session cache
  const cookies = parseCookies(req.headers.cookie);
  const adminToken = cookies['admin_token'];
  
  if (adminToken && activeSessions.has(adminToken)) {
    return next();
  }
  
  // 3. Reject API requests with 401
  if (req.xhr || req.headers.accept?.includes('json') || reqPath.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized. Admin login required.' });
  }
  
  // 4. Redirect standard browser page loads to login screen
  res.redirect('/login');
}

app.use(requireAdminAuth);

// GET /login route
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// POST /api/admin/login endpoint
app.post('/api/admin/login', (req, res) => {
  try {
    const { password } = req.body;
    const db = database.read();
    const settings = db.settings || {};
    const expectedPassword = settings.adminPassword || 'admin123';
    
    // Check if expectedPassword is a bcrypt hash.
    // Bcrypt hashes start with $2a$ or $2b$ and have a length of 60.
    const isHash = typeof expectedPassword === 'string' && expectedPassword.startsWith('$2a$');
    const passwordMatch = isHash ? bcrypt.compareSync(password, expectedPassword) : (password === expectedPassword);
    
    if (passwordMatch) {
      // Generate a secure session token
      const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
      activeSessions.add(sessionToken);
      
      // Set a cookie (lasts 30 days)
      res.cookie('admin_token', sessionToken, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false });
      return res.json({ success: true });
    }
    
    res.status(401).json({ error: 'Invalid admin password.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/logout endpoint
app.post('/api/admin/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const adminToken = cookies['admin_token'];
  if (adminToken) {
    activeSessions.delete(adminToken);
  }
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve Employee Mobile Self-Service Portal at /mobile
app.use('/mobile', express.static(path.join(__dirname, 'mobile_dist')));
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile_dist', 'index.html'));
});

// --- Express REST API Routes ---

// WhatsApp Connection Status
app.get('/api/status', (req, res) => {
  res.json({
    status: whatsapp.status,
    qr: whatsapp.qrCodeDataUrl,
    activeChats: whatsapp.activeChats
  });
});

// Debug endpoint to capture a screenshot of the WhatsApp Web page running in Puppeteer
app.get('/api/debug/whatsapp-screenshot', async (req, res) => {
  try {
    if (!whatsapp.client) {
      return res.status(400).send("WhatsApp client is not initialized.");
    }
    if (!whatsapp.client.pupPage) {
      return res.status(400).send("WhatsApp Puppeteer page (pupPage) is not available.");
    }
    const screenshotPath = path.join(__dirname, 'whatsapp_screenshot.png');
    await whatsapp.client.pupPage.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Debug] WhatsApp Web page screenshot saved to: ${screenshotPath}`);
    res.send(`Screenshot successfully saved to: ${screenshotPath}`);
  } catch (err) {
    console.error("[Debug] Failed to capture WhatsApp screenshot:", err);
    res.status(500).send(`Error capturing screenshot: ${err.message}`);
  }
});

// System General Analytics
app.get('/api/stats', (req, res) => {
  const todayStr = getLocalDateString();
  const employees = database.getEmployees();
  const activeEmpCount = employees.filter(e => e.status === 'active').length;
  const attendanceToday = database.getAttendanceForDate(todayStr);
  
  const presentCount = attendanceToday.filter(a => a.status === 'checked-in' || a.status === 'completed' || a.status === 'late' || a.status === 'Late Check-in' || a.status === 'Early Check-out' || a.status === 'half-day leave').length;
  const halfDayCount = attendanceToday.filter(a => a.isHalfDay === true || a.isHalfDay === 'true' || a.status === 'half-day leave').length;
  const lateCount = attendanceToday.filter(a => a.status === 'Late Check-in' || a.status === 'late' || a.isLate === true || a.isLate === 'true').length;
  const earlyCount = attendanceToday.filter(a => a.status === 'Early Check-out' || a.isEarlyCheckout === true || a.isEarlyCheckout === 'true').length;
  const leaveCount = attendanceToday.filter(a => a.status === 'leave').length;
  const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
  const pendingCount = database.getPendingMessages().length;

  res.json({
    totalEmployees: activeEmpCount,
    presentToday: presentCount,
    halfDayToday: halfDayCount,
    lateCheckInToday: lateCount,
    earlyCheckOutToday: earlyCount,
    leaveToday: leaveCount,
    absentToday: absentCount,
    pendingExceptions: pendingCount
  });
});

// Force Refresh Active Groups
app.post('/api/chats/refresh', async (req, res) => {
  const chats = await whatsapp.refreshChats();
  res.json(chats);
});

// Dynamic scan and re-evaluate WhatsApp logs
app.post('/api/whatsapp/refresh', async (req, res) => {
  try {
    if (whatsapp.status !== 'ready') {
      return res.status(400).json({ error: 'WhatsApp client is not ready. Please verify connection.' });
    }
    console.log('[API] Triggering WhatsApp logs refresh and re-evaluation...');
    const result = await whatsapp.refreshWhatsAppLogs();
    
    // Broadcast WebSockets to sync UI elements
    io.emit('attendance_updated');
    io.emit('pending_updated');
    io.emit('stats_updated');
    
    res.json({ success: true, clearedCount: result.clearedCount });
  } catch (err) {
    console.error('[API] WhatsApp logs refresh failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger a WhatsApp client reconnect (logout + reinitialize)
app.post('/api/whatsapp/reconnect', async (req, res) => {
  try {
    console.log('[API] Received request to reconnect WhatsApp client...');
    // Attempt a graceful logout first
    try {
      await whatsapp.logout();
      console.log('[API] WhatsApp client logged out successfully.');
    } catch (e) {
      console.warn('[API] WhatsApp logout attempt failed (continuing):', e.message);
    }

    // Reinitialize after short delay to allow resources to free
    setTimeout(() => {
      try {
        whatsapp.initialize();
        console.log('[API] WhatsApp reinitialization triggered.');
      } catch (e) {
        console.error('[API] Failed to reinitialize WhatsApp client:', e.message);
      }
    }, 1000);

    res.json({ ok: true, message: 'Reconnection attempt started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a WhatsApp client logout (delete session and reset)
app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    console.log('[API] Received request to logout WhatsApp client...');
    await whatsapp.logout();
    console.log('[API] WhatsApp client logged out successfully.');
    // Reinitialize to get a fresh QR code
    setTimeout(() => {
      try {
        whatsapp.initialize();
        console.log('[API] WhatsApp reinitialization after logout triggered.');
      } catch (e) {
        console.error('[API] Failed to reinitialize WhatsApp client:', e.message);
      }
    }, 1000);
    res.json({ ok: true, message: 'Logged out successfully, reinitializing...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settings CRUD
app.get('/api/settings', (req, res) => {
  res.json(database.getSettings());
});

app.post('/api/settings', (req, res) => {
  const settingsData = { ...req.body };
  
  if (settingsData.adminPassword) {
    settingsData.adminPassword = bcrypt.hashSync(settingsData.adminPassword, 10);
  }
  
  // Format the group names list cleanly (comma-separated, trimmed)
  if (settingsData.whatsappGroupName) {
    settingsData.whatsappGroupName = settingsData.whatsappGroupName
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
      .join(', ');
  } else {
    settingsData.whatsappGroupName = "ATTENDANCE";
  }

  const settings = database.saveSettings(settingsData);
  if (whatsapp && typeof whatsapp.resolveGroupIds === 'function') {
    whatsapp.resolveGroupIds().catch(err => console.error("Error resolving group IDs live:", err));
  } else if (whatsapp && typeof whatsapp.resolveGroupId === 'function') {
    whatsapp.resolveGroupId().catch(err => console.error("Error resolving group ID live:", err));
  }
  res.json(settings);
});

// Employees CRUD
app.get('/api/employees', (req, res) => {
  res.json(database.getEmployees());
});

app.post('/api/employees', (req, res) => {
  try {
    const employeeData = { ...req.body };
    const id = employeeData.id || `emp_${Date.now()}`;
    employeeData.id = id;

    // Handle Profile Photo Upload
    if (employeeData.profilePhotoBase64) {
      const uploadsDir = path.join(__dirname, 'public', 'uploads', 'profiles');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      let ext = 'png';
      const mimeMatch = employeeData.profilePhotoBase64.match(/^data:([a-zA-Z0-9.+\/-]+);base64,/);
      if (mimeMatch) {
        const mimeType = mimeMatch[1];
        if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') ext = 'jpg';
        else if (mimeType === 'image/webp') ext = 'webp';
        else if (mimeType === 'image/gif') ext = 'gif';
      }
      
      const base64Data = employeeData.profilePhotoBase64.replace(/^data:[a-zA-Z0-9.+\/-]+;base64,/, '');
      const filename = `${id}_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64Data, 'base64'));
      employeeData.profilePhoto = `/uploads/profiles/${filename}`;
      delete employeeData.profilePhotoBase64;

      // Clean up old profile photo if editing
      const existingEmployees = database.getEmployees();
      const existing = existingEmployees.find(e => e.id === id);
      if (existing && existing.profilePhoto) {
        const oldPath = path.join(__dirname, 'public', existing.profilePhoto);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch (e) {}
        }
      }
    }

    // Handle Identity Documents Upload
    const docFields = [
      { base64Key: 'aadhaarPhotoBase64', pathKey: 'aadhaarPhoto', prefix: 'aadhaar' },
      { base64Key: 'panPhotoBase64', pathKey: 'panPhoto', prefix: 'pan' },
      { base64Key: 'drivingLicensePhotoBase64', pathKey: 'drivingLicensePhoto', prefix: 'dl' }
    ];

    docFields.forEach(field => {
      if (employeeData[field.base64Key]) {
        const docDir = path.join(__dirname, 'public', 'uploads', 'documents');
        if (!fs.existsSync(docDir)) {
          fs.mkdirSync(docDir, { recursive: true });
        }
        
        let ext = 'png';
        const mimeMatch = employeeData[field.base64Key].match(/^data:([a-zA-Z0-9.+\/-]+);base64,/);
        if (mimeMatch) {
          const mimeType = mimeMatch[1];
          if (mimeType === 'application/pdf') ext = 'pdf';
          else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') ext = 'jpg';
          else if (mimeType === 'image/webp') ext = 'webp';
          else if (mimeType === 'image/gif') ext = 'gif';
        }
        
        const base64Data = employeeData[field.base64Key].replace(/^data:[a-zA-Z0-9.+\/-]+;base64,/, '');
        const filename = `${field.prefix}_${id}_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(docDir, filename), Buffer.from(base64Data, 'base64'));
        employeeData[field.pathKey] = `/uploads/documents/${filename}`;
        delete employeeData[field.base64Key];

        // Clean up old document file if editing
        const existingEmployees = database.getEmployees();
        const existing = existingEmployees.find(e => e.id === id);
        if (existing && existing[field.pathKey]) {
          const oldPath = path.join(__dirname, 'public', existing[field.pathKey]);
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (e) {}
          }
        }
      }
    });

    const emp = database.saveEmployee(employeeData);
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/employees/:id', (req, res) => {
  database.deleteEmployee(req.params.id);
  res.json({ success: true });
});

// Sites CRUD
app.get('/api/sites', (req, res) => {
  res.json(database.getSites());
});

app.post('/api/sites', (req, res) => {
  try {
    const site = database.saveSite(req.body);
    res.json(site);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sites/:id', (req, res) => {
  database.deleteSite(req.params.id);
  res.json({ success: true });
});

// Holidays CRUD
app.get('/api/holidays', (req, res) => {
  res.json(database.getHolidays());
});

app.post('/api/holidays', (req, res) => {
  try {
    const holiday = database.saveHoliday(req.body);
    res.json(holiday);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/holidays/:date', (req, res) => {
  try {
    database.deleteHoliday(req.params.date);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attendance Management
app.get('/api/attendance', (req, res) => {
  const { date, startDate, endDate } = req.query;
  
  if (startDate && endDate) {
    return res.json(database.getAttendanceForRange(startDate, endDate));
  }
  
  const targetDate = date || getLocalDateString();
  res.json(database.getAttendanceForDate(targetDate));
});

// Save or manual edit attendance log
app.post('/api/attendance/save', (req, res) => {
  try {
    const record = database.saveAttendance(req.body);
    io.emit('attendance_updated', record);
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Camera attendance events
app.get('/api/attendance/camera/events', (req, res) => {
  const { employeeId, date, limit, search } = req.query;
  let events = database.getCameraEvents() || [];

  if (employeeId) {
    events = events.filter(e => e.employeeId === employeeId);
  }
  if (date) {
    events = events.filter(e => e.date === date);
  }
  if (search) {
    const q = search.toLowerCase();
    events = events.filter(e => 
      (e.employeeName && e.employeeName.toLowerCase().includes(q)) ||
      (e.siteName && e.siteName.toLowerCase().includes(q)) ||
      (e.eventType && e.eventType.toLowerCase().includes(q)) ||
      (e.status && e.status.toLowerCase().includes(q))
    );
  }

  // Sort descending by timestamp
  events = [...events].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (limit) {
    const parsedLimit = parseInt(limit, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      events = events.slice(0, parsedLimit);
    }
  } else if (!employeeId && !date && !search) {
    // Default to latest 500 events to prevent massive payload size (13.3MB -> ~300KB)
    events = events.slice(0, 500);
  }

  const sanitized = events.map(e => {
    const { imageBase64, ...rest } = e;
    return rest;
  });
  res.json(sanitized);
});

app.post('/api/attendance/camera', (req, res) => {
  try {
    const { employeeId, eventType, siteName, timestamp, imageBase64, imageFilename } = req.body;
    if (!employeeId || !eventType || !timestamp) {
      return res.status(400).json({ error: 'employeeId, eventType, and timestamp are required.' });
    }

    const db = database.read();
    const employee = (db.employees || []).find(e => e.id === employeeId);
    if (!employee) {
      return res.status(400).json({ error: 'Employee not found.' });
    }

    const eventDate = getLocalDateString(timestamp);
    const cameraEvent = {
      employeeId,
      employeeName: employee.name,
      eventType: eventType === 'exit' ? 'exit' : 'entry',
      siteName: siteName || 'Office',
      timestamp: new Date(timestamp).toISOString(),
      date: eventDate,
      imageBase64,
      imageFilename,
      status: 'recorded'
    };
    const savedEvent = database.saveCameraEvent(cameraEvent);

    const attendanceDate = eventDate;
    const attendanceEntry = {
      employeeId,
      employeeName: employee.name,
      date: attendanceDate,
      siteName: cameraEvent.siteName,
      messageText: `Camera ${cameraEvent.eventType} event`,
      punches: [{
        time: cameraEvent.timestamp,
        type: eventType === 'exit' ? 'out' : 'in',
        siteName: cameraEvent.siteName,
        messageText: `Camera ${cameraEvent.eventType} event`,
        source: 'CCTV'
      }]
    };

    const existingAttendance = (db.attendance || []).find(a => a.employeeId === employeeId && a.date === attendanceDate);
    if (eventType === 'entry') {
      attendanceEntry.checkIn = cameraEvent.timestamp;
      if (existingAttendance && existingAttendance.checkOut) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkOut = existingAttendance.checkOut;
      }
    } else {
      // exit event
      if (existingAttendance && existingAttendance.checkIn) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkIn = existingAttendance.checkIn;
      } else {
        attendanceEntry.checkIn = cameraEvent.timestamp;
      }
      attendanceEntry.checkOut = cameraEvent.timestamp;
    }

    const savedAttendance = database.saveAttendance(attendanceEntry);
    io.emit('attendance_updated', savedAttendance);
    res.json({ cameraEvent: savedEvent, attendance: savedAttendance });
  } catch (err) {
    console.error('[API] Camera attendance save failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Face Recognition Integration (via Python service)
const FACE_RECOGNITION_SERVICE = process.env.FACE_RECOGNITION_URL || 'http://localhost:5000';

// Health check for face recognition service
app.get('/api/face/health', async (req, res) => {
  try {
    const response = await fetch(`${FACE_RECOGNITION_SERVICE}/health`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[API] Face recognition service error:', err.message);
    res.status(503).json({ error: 'Face recognition service unavailable' });
  }
});

// Resolve face ID (folder name) to employee database record
function resolveEmployeeFromFaceId(faceId, employees) {
  if (!faceId || !employees) return null;

  // 1. Direct ID match
  let employee = employees.find(e => e.id === faceId);
  if (employee) return employee;

  // 2. Custom mapping overrides for known anomalies
  const customFaceMappings = {
    "akash_rana": "emp_2058",       // Akash Rana
    "alex_gigi": "emp_2087",        // Alex Gigi
    "anandhu_sunil": "emp_2029",   // Anandhu Sunil
    "james_t_m": "emp_2038",        // James Tm
    "prasanth_em": "emp_2025",      // Prasanth E.M
    "ratheesh_ks": "emp_2048",      // Ratheesh K S
    "pratheesh_ks": "emp_1002",     // Pratheesh K S
    "pratheesh_k_s": "emp_1002",    // Pratheesh K S
    "rebeesh_ks": "emp_1004",       // Rebeesh K S
    "shinod_n_t": "emp_2001"        // Shinodh N T
  };

  const mappedId = customFaceMappings[faceId];
  if (mappedId) {
    employee = employees.find(e => e.id === mappedId);
    if (employee) return employee;
  }

  // 3. Robust clean name matching
  employee = employees.find(e => {
    if (!e.name) return false;
    const cleanDbName = e.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').trim();
    const cleanInputName = faceId.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').trim();
    
    // Check exact matches first
    if (cleanDbName === cleanInputName || cleanDbName.replace(/_/g, '') === cleanInputName.replace(/_/g, '')) {
      return true;
    }
    
    // Check if input name is a complete word segment of the DB name (e.g. "anandhu" matches "anandhu_sunil")
    const dbWords = cleanDbName.split('_');
    const inputWords = cleanInputName.split('_');
    
    // If input name is just one word, check if it's one of the DB words
    if (inputWords.length === 1 && dbWords.includes(inputWords[0])) {
      return true;
    }
    
    return false;
  });

  return employee;
}

// Recognize face from camera image
app.post('/api/face/recognize', async (req, res) => {
  try {
    const { imageBase64, threshold, latitude, longitude, employeeId, createException } = req.body;
    
    if (!imageBase64) {
      return res.status(400).json({ success: false, status: "rejected", message: 'imageBase64 required' });
    }
    
    const db = database.read();
    
    // 1. Get claimed employee if employeeId is provided
    let claimedEmployee = null;
    if (employeeId) {
      claimedEmployee = db.employees.find(e => e.id === employeeId);
    }
    
    let data;
    try {
      const response = await fetch(`${FACE_RECOGNITION_SERVICE}/api/face/recognize`, {
        method: 'POST',
        body: JSON.stringify({
          image: imageBase64,
          threshold: threshold || 0.52
        }),
        headers: { 'Content-Type': 'application/json' }
      });
      data = await response.json();
    } catch (fetchErr) {
      console.error('[API] Face recognition service fetch failed:', fetchErr.message);
      // Fallback: If service is down, but we have a claimed employee, create a pending exception!
      if (claimedEmployee) {
        const exceptionId = `pending_selfie_${Date.now()}`;
        const timestamp = new Date().toISOString();
        const eventDate = timestamp.split('T')[0];
        
        let action = 'in';
        const existingAttendance = (db.attendance || []).find(
          a => a.employeeId === claimedEmployee.id && a.date === eventDate
        );
        if (existingAttendance && existingAttendance.checkIn && existingAttendance.status !== 'absent') {
          action = 'out';
        }
        
        let imageUrl = "";
        try {
          const uploadsDir = path.join(__dirname, 'public', 'uploads', 'camera');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          const filename = `pending_${exceptionId}.jpg`;
          fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(imageBase64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64'));
          imageUrl = `/uploads/camera/${filename}`;
        } catch (imgErr) {}
        
        // Geofencing
        let siteName = 'Webcam Scan';
        if (latitude && longitude && db.sites && db.sites.length > 0) {
          let minDistance = Infinity;
          let closestSite = null;
          db.sites.forEach(site => {
            if (site.latitude && site.longitude) {
              const dist = database.getHaversineDistance(latitude, longitude, site.latitude, site.longitude);
              if (dist < minDistance) {
                minDistance = dist;
                closestSite = site;
              }
            }
          });
          if (closestSite && minDistance <= 200) siteName = closestSite.name;
        }

        database.savePendingMessage({
          id: exceptionId,
          type: "selfie_verification",
          sender: claimedEmployee.name,
          extractedName: claimedEmployee.name,
          extractedSite: siteName,
          extractedAction: action,
          timestamp: timestamp,
          reason: "Face service offline (manual fallback)",
          imageUrl: imageUrl,
          latitude: latitude ? Number(latitude) : null,
          longitude: longitude ? Number(longitude) : null,
          messageText: `Selfie verification pending admin approval`
        });
        io.emit('pending_updated');
        
        return res.json({
          success: true,
          status: "pending_review",
          message: "Face service offline. Verification submitted and pending admin approval."
        });
      }
      
      return res.status(503).json({
        success: false,
        status: "rejected",
        message: "Face recognition service unavailable"
      });
    }

    // 2. Process results
    let isConfident = false;
    let matchedEmployee = null;
    let matchConfidence = 0;
    let matchReason = "No matching face recognized";

    if (data.success && data.matched && data.matches && data.matches.length > 0) {
      // Find highest confidence match
      const bestMatch = data.matches[0];
      matchConfidence = bestMatch.confidence;
      
      // Look up employee
      matchedEmployee = resolveEmployeeFromFaceId(bestMatch.employee_id, db.employees);

      if (matchedEmployee) {
        if (claimedEmployee) {
          // If claimed employee matches matched employee and confidence >= configured threshold
          if (claimedEmployee.id === matchedEmployee.id) {
            if (matchConfidence >= FACE_RECOGNITION_MIN_CONFIDENCE) {
              isConfident = true;
            } else {
              matchReason = `Low match confidence (${(matchConfidence * 100).toFixed(0)}%)`;
            }
          } else {
            matchReason = `Claimed name mismatch (Matched: ${matchedEmployee.name} with ${(matchConfidence * 100).toFixed(0)}% confidence)`;
          }
        } else {
          // Auto-identify mode
          if (matchConfidence >= FACE_RECOGNITION_MIN_CONFIDENCE) {
            isConfident = true;
          } else {
            matchReason = `Low match confidence (${(matchConfidence * 100).toFixed(0)}%)`;
          }
        }
      }
    }

    // 3. Handle Confident Auto-Marking
    if (isConfident && matchedEmployee) {
      const employee = matchedEmployee;
      const now = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
      const timestamp = now.toISOString();
      const eventDate = timestamp.split('T')[0];
      
      const existingAttendance = (db.attendance || []).find(
        a => a.employeeId === employee.id && a.date === eventDate
      );
      
      const localHour = now.getHours();
      const isLunchHour = (localHour === 13);

      const isLateCheckInPendingScan = existingAttendance && existingAttendance.status === 'late' && !existingAttendance.scannedCheckIn;

      const isScanLateTime = (() => {
        if (!employee.shiftStart) return false;
        const [sh, sm] = employee.shiftStart.split(':').map(Number);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const shiftStartMinutes = sh * 60 + sm;
        return nowMinutes > shiftStartMinutes; // sharp time
      })();

      const isLateCheckIn = isLateCheckInPendingScan || ((!existingAttendance || existingAttendance.status === 'absent') && isScanLateTime);
      
      let eventType = 'entry';
      const attendanceEntry = {
        employeeId: employee.id,
        employeeName: employee.name,
        date: eventDate,
        siteName: 'Webcam Scan',
        facialRecognitionMatch: true,
        matchConfidence: matchConfidence,
        latitude: latitude ? Number(latitude) : undefined,
        longitude: longitude ? Number(longitude) : undefined,
        verificationMethod: 'Face Recognition',
        notes: 'Face recognized'
      };

      if (existingAttendance) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkIn = existingAttendance.checkIn;
        attendanceEntry.checkOut = existingAttendance.checkOut || null;
        attendanceEntry.lunchOut = existingAttendance.lunchOut || null;
        attendanceEntry.lunchIn = existingAttendance.lunchIn || null;
        attendanceEntry.travelHours = existingAttendance.travelHours || 0.0;
        attendanceEntry.notes = existingAttendance.notes || "";
        attendanceEntry.status = existingAttendance.status;
        attendanceEntry.isLate = existingAttendance.isLate || isLateCheckIn;
        attendanceEntry.isHospitalCase = existingAttendance.isHospitalCase;
        attendanceEntry.hospitalHours = existingAttendance.hospitalHours;
        attendanceEntry.scannedCheckIn = existingAttendance.scannedCheckIn;
      }

      if (existingAttendance && existingAttendance.checkIn && existingAttendance.status !== 'absent' && !isLateCheckInPendingScan) {
        if (existingAttendance.status === 'completed' || existingAttendance.status === 'leave') {
          return res.status(400).json({
            success: false,
            status: "rejected",
            message: "Attendance already completed or marked leave for today"
          });
        }
        
        let lastEventTime = new Date(existingAttendance.checkIn);
        if (existingAttendance.lunchIn) {
          lastEventTime = new Date(existingAttendance.lunchIn);
        } else if (existingAttendance.lunchOut) {
          lastEventTime = new Date(existingAttendance.lunchOut);
        }
        
        const diffSeconds = (now - lastEventTime) / 1000;
        if (diffSeconds < 30) {
          return res.status(400).json({
            success: false,
            status: "rejected",
            message: "Duplicate scan detected. Please wait 30 seconds."
          });
        }
        
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkIn = existingAttendance.checkIn;
        
        if (existingAttendance.lunchOut && existingAttendance.lunchIn) {
          eventType = 'exit';
          attendanceEntry.lunchOut = existingAttendance.lunchOut;
          attendanceEntry.lunchIn = existingAttendance.lunchIn;
          attendanceEntry.checkOut = timestamp;
        } else if (existingAttendance.lunchOut && !existingAttendance.lunchIn) {
          eventType = 'lunch-in';
          attendanceEntry.lunchOut = existingAttendance.lunchOut;
          attendanceEntry.lunchIn = timestamp;
        } else if (!existingAttendance.lunchOut && isLunchHour) {
          eventType = 'lunch-out';
          attendanceEntry.lunchOut = timestamp;
        } else {
          eventType = 'exit';
          attendanceEntry.checkOut = timestamp;
        }
      } else {
        eventType = 'entry';
        attendanceEntry.checkIn = timestamp;
        if (isLateCheckIn) {
          attendanceEntry.isLate = true;
          attendanceEntry.scannedCheckIn = true;
          attendanceEntry.status = "Late Check-in";
        }
      }
      
      // Geofencing verification
      let siteName = 'Webcam Scan';
      let distance = null;
      let closestSite = null;
      
      if (latitude && longitude && db.sites && db.sites.length > 0) {
        let minDistance = Infinity;
        db.sites.forEach(site => {
          if (site.latitude && site.longitude) {
            const dist = database.getHaversineDistance(latitude, longitude, site.latitude, site.longitude);
            if (dist < minDistance) {
              minDistance = dist;
              closestSite = site;
            }
          }
        });
        
        if (closestSite) {
          distance = minDistance;
          if (minDistance <= 200) {
            siteName = closestSite.name;
          } else {
            siteName = `Off-Site (${closestSite.name})`;
          }
        }
      }
      
      attendanceEntry.siteName = siteName;
      if (distance !== null && distance > 200) {
        attendanceEntry.notes = `[FLAGGED LOCATION] Off-Site Scan (${Math.round(distance)}m)`;
      }
      
      // Save camera event
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      const savedEvent = database.saveCameraEvent({
        employeeId: employee.id,
        employeeName: employee.name,
        eventType: eventType,
        siteName: siteName,
        timestamp: timestamp,
        date: eventDate,
        imageBase64: cleanBase64,
        imageFilename: 'webcam_scan.jpg',
        status: 'recognized',
        latitude: latitude ? Number(latitude) : undefined,
        longitude: longitude ? Number(longitude) : undefined,
        adminNotes: distance !== null && distance > 200 
          ? `[FLAGGED LOCATION] Off-Site Scan (${Math.round(distance)}m away from ${closestSite?.name})`
          : `Face recognized on site. Distance: ${distance ? Math.round(distance) : 0}m`
      });
      
      attendanceEntry.messageText = `Face recognized - auto ${eventType}`;
      attendanceEntry.punches = [{
        time: timestamp,
        type: eventType === 'exit' ? 'out' : 'in',
        siteName: siteName,
        messageText: `Face recognized - auto ${eventType}`,
        source: 'Selfie'
      }];
      const savedAttendance = database.saveAttendance(attendanceEntry);
      
      io.emit('attendance_updated', savedAttendance);
      io.emit('camera_event_recorded', savedEvent);
      
      return res.json({
        success: true,
        status: "accepted",
        employee_id: employee.id,
        message: `Attendance marked successfully for: ${employee.name}`,
        recognized: true,
        employee: { id: employee.id, name: employee.name },
        confidence: matchConfidence,
        attendance: savedAttendance,
        eventType: eventType
      });
    }

    // Check if exception logging is requested (e.g. from employee selfie check-in portal)
    if (!createException) {
      return res.json({
        success: true,
        recognized: false,
        status: "rejected",
        message: matchReason
      });
    }

    // 4. Handle Low-Confidence Exception Creation
    const exceptionId = `pending_selfie_${Date.now()}`;
    const now = new Date();
    const timestamp = now.toISOString();
    const eventDate = timestamp.split('T')[0];
    
    // Choose which employee profile to log against in the dropdown
    const targetEmployee = claimedEmployee || matchedEmployee;
    const targetName = targetEmployee ? targetEmployee.name : "Unknown Worker";
    
    // Calculate proposed action (Transition)
    let action = 'in';
    if (targetEmployee) {
      const existingAttendance = (db.attendance || []).find(
        a => a.employeeId === targetEmployee.id && a.date === eventDate
      );
      if (existingAttendance && existingAttendance.checkIn && existingAttendance.status !== 'absent') {
        action = 'out';
      }
    }
    
    // Save image to uploads/camera
    let imageUrl = "";
    try {
      const uploadsDir = path.join(__dirname, 'public', 'uploads', 'camera');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      const filename = `pending_${exceptionId}.jpg`;
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(cleanBase64, 'base64'));
      imageUrl = `/uploads/camera/${filename}`;
    } catch (imgErr) {
      console.warn('[Selfie Exception] Failed to save selfie image:', imgErr.message);
    }
    
    // Geofencing verification for site name
    let siteName = 'Webcam Scan';
    if (latitude && longitude && db.sites && db.sites.length > 0) {
      let minDistance = Infinity;
      let closestSite = null;
      db.sites.forEach(site => {
        if (site.latitude && site.longitude) {
          const dist = database.getHaversineDistance(latitude, longitude, site.latitude, site.longitude);
          if (dist < minDistance) {
            minDistance = dist;
            closestSite = site;
          }
        }
      });
      if (closestSite) {
        if (minDistance <= 200) {
          siteName = closestSite.name;
        } else {
          siteName = `Off-Site (${closestSite.name})`;
        }
      }
    }

    const pendingMsg = {
      id: exceptionId,
      type: "selfie_verification",
      sender: targetName,
      extractedName: targetName,
      extractedSite: siteName,
      extractedAction: action,
      timestamp: timestamp,
      reason: matchReason,
      imageUrl: imageUrl,
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      messageText: `Selfie verification pending admin approval`
    };

    database.savePendingMessage(pendingMsg);
    io.emit('pending_updated');

    return res.json({
      success: true,
      status: "pending_review",
      message: `Selfie verification submitted. Pending admin review due to: ${matchReason}.`
    });

  } catch (err) {
    console.error('[API] Face recognition error:', err);
    res.status(500).json({ success: false, status: "rejected", message: err.message });
  }
});

// Get face recognition embeddings info
app.get('/api/face/embeddings-info', async (req, res) => {
  try {
    const response = await fetch(`${FACE_RECOGNITION_SERVICE}/api/face/embeddings`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[API] Face embeddings info error:', err.message);
    res.status(503).json({ error: 'Face recognition service unavailable' });
  }
});

// Train face recognition model
app.post('/api/face/train', async (req, res) => {
  try {
    let imagesDir = req.body.imagesDir;
    if (!imagesDir) {
      imagesDir = path.join(__dirname, 'uploads', 'face_training');
      console.log('[API] Using default face training directory:', imagesDir);
    }
    
    const formData = new URLSearchParams();
    formData.append('images_dir', imagesDir);
    
    const response = await fetch(`${FACE_RECOGNITION_SERVICE}/api/face/train`, {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[API] Face training error:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// Load face embeddings
app.post('/api/face/load-embeddings', async (req, res) => {
  try {
    const { filePath } = req.body;
    
    const formData = new URLSearchParams();
    if (filePath) formData.append('file_path', filePath);
    
    const response = await fetch(`${FACE_RECOGNITION_SERVICE}/api/face/load-embeddings`, {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[API] Face load embeddings error:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// GET Unknown Detections
app.get('/api/unknown-detections', (req, res) => {
  try {
    const detections = database.getUnknownDetections();
    res.json(detections);
  } catch (err) {
    console.error('[API] Get unknown detections failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST Restore/Save Unknown Detection
app.post('/api/unknown-detections', (req, res) => {
  try {
    const event = req.body;
    const db = database.read();
    if (!db.unknownDetections) db.unknownDetections = [];
    
    // Check if it already exists
    const index = db.unknownDetections.findIndex(e => e.id === event.id);
    if (index === -1) {
      db.unknownDetections.push(event);
      database.writeAtomic(db);
      io.emit('unknown_detection_updated', event);
    }
    res.json({ success: true, detection: event });
  } catch (err) {
    console.error('[API] Restore unknown detection failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE Unknown Detection
app.delete('/api/unknown-detections/:id', (req, res) => {
  try {
    const success = database.deleteUnknownDetection(req.params.id);
    if (success) {
      io.emit('unknown_detection_deleted', req.params.id);
      res.json({ success: true, message: 'Detection deleted.' });
    } else {
      res.status(404).json({ error: 'Detection not found.' });
    }
  } catch (err) {
    console.error('[API] Delete unknown detection failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST Assign Unknown Detection to Employee and Trigger retrain
// POST Assign Unknown Detection to Employee and Trigger retrain
app.post('/api/unknown-detections/assign', async (req, res) => {
  try {
    const { detectionId, employeeId, registerAttendance, eventType } = req.body;
    if (!detectionId || !employeeId) {
      return res.status(400).json({ error: 'detectionId and employeeId are required.' });
    }

    const db = database.read();
    const employee = db.employees.find(e => e.id === employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const detections = database.getUnknownDetections();
    const detection = detections.find(d => d.id === detectionId);
    if (!detection) {
      return res.status(404).json({ error: 'Detection record not found.' });
    }

    if (!detection.rawFaceUrl) {
      return res.status(400).json({ error: 'Detection has no raw face image for training.' });
    }

    const rawFacePath = path.join(__dirname, 'public', detection.rawFaceUrl);
    if (!fs.existsSync(rawFacePath)) {
      return res.status(404).json({ error: 'Raw face image file missing on disk.' });
    }

    // 1. Manually allot attendance if requested
    if (registerAttendance) {
      let resolvedEventType = eventType || 'auto';
      if (resolvedEventType === 'auto') {
        const camName = detection.cameraName || '';
        if (camName.toLowerCase().includes('entrance') || camName.toLowerCase().includes('entry')) {
          resolvedEventType = 'entry';
        } else {
          resolvedEventType = 'exit';
        }
      }

      const timestamp = detection.timestamp || new Date().toISOString();
      const eventDate = timestamp.split('T')[0];
      
      const existingAttendance = (db.attendance || []).find(
        a => a.employeeId === employee.id && a.date === eventDate
      );
      
      const now = new Date(timestamp);
      const isScanLateTime = (() => {
        if (!employee.shiftStart) return false;
        const [sh, sm] = employee.shiftStart.split(':').map(Number);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const shiftStartMinutes = sh * 60 + sm;
        return nowMinutes > shiftStartMinutes;
      })();
      
      const isLateCheckInPendingScan = existingAttendance && existingAttendance.status === 'late' && !existingAttendance.scannedCheckIn;
      const isLateCheckIn = isLateCheckInPendingScan || (!existingAttendance && isScanLateTime);
      
      let punches = [];
      if (existingAttendance) {
        if (existingAttendance.punches && existingAttendance.punches.length > 0) {
          punches = [...existingAttendance.punches];
        } else {
          if (existingAttendance.checkIn) {
            punches.push({
              time: existingAttendance.checkIn,
              type: 'in',
              siteName: existingAttendance.siteName || '—',
              messageText: existingAttendance.messageText || 'Check-In',
              source: existingAttendance.scannedCheckIn ? 'Selfie' : 'WhatsApp'
            });
          }
          if (existingAttendance.checkOut) {
            punches.push({
              time: existingAttendance.checkOut,
              type: 'out',
              siteName: existingAttendance.siteName || '—',
              messageText: existingAttendance.messageText || 'Check-Out',
              source: existingAttendance.scannedCheckIn ? 'Selfie' : 'WhatsApp'
            });
          }
        }
      }
      
      const newPunchType = resolvedEventType === 'entry' ? 'in' : 'out';
      
      punches.push({
        time: timestamp,
        type: newPunchType,
        siteName: detection.cameraName || 'CCTV Camera',
        messageText: `CCTV Face manually resolved (${detection.confidence ? (detection.confidence * 100).toFixed(0) : '100'}%)`,
        source: 'CCTV',
        videoUrl: detection.videoUrl || ''
      });
      
      const uniquePunches = [];
      const seen = new Set();
      const DEDUPE_WINDOW_MS = 8 * 1000;
      
      punches.forEach(p => {
        const t = new Date(p.time).getTime();
        const bucket = Math.floor(t / DEDUPE_WINDOW_MS) * DEDUPE_WINDOW_MS;
        const key = `${bucket}_${p.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniquePunches.push(p);
        }
      });
      
      uniquePunches.sort((a, b) => new Date(a.time) - new Date(b.time));
      
      let finalCheckIn = null;
      let finalCheckOut = null;
      const ins = uniquePunches.filter(p => p.type === 'in');
      if (ins.length > 0) finalCheckIn = ins[0].time;
      
      if (uniquePunches.length > 0) {
        const lastPunch = uniquePunches[uniquePunches.length - 1];
        if (lastPunch.type === 'in') {
          finalCheckOut = null;
        } else {
          finalCheckOut = lastPunch.time;
        }
      }
      
      let finalLunchOut = null;
      let finalLunchIn = null;
      for (let i = 0; i < uniquePunches.length; i++) {
        const p = uniquePunches[i];
        const pDate = new Date(p.time);
        const pHour = pDate.getHours();
        if (p.type === 'out' && pHour === 13 && !finalLunchOut) {
          finalLunchOut = p.time;
          for (let j = i + 1; j < uniquePunches.length; j++) {
            if (uniquePunches[j].type === 'in') {
              finalLunchIn = uniquePunches[j].time;
              break;
            }
          }
        }
      }
      
      const attendanceEntry = {
        employeeId: employee.id,
        employeeName: employee.name,
        date: eventDate,
        siteName: detection.siteName || 'Office',
        messageText: '',
        facialRecognitionMatch: true,
        matchConfidence: detection.confidence || 1.0,
        punches: uniquePunches,
        checkIn: finalCheckIn,
        checkOut: finalCheckOut,
        lunchOut: finalLunchOut,
        lunchIn: finalLunchIn,
        travelHours: existingAttendance ? (existingAttendance.travelHours || 0.0) : 0.0,
        notes: existingAttendance ? (existingAttendance.notes || "") : "",
        status: existingAttendance ? existingAttendance.status : "",
        isLate: existingAttendance ? (existingAttendance.isLate || isLateCheckIn) : isLateCheckIn,
        isHospitalCase: existingAttendance ? existingAttendance.isHospitalCase : false,
        hospitalHours: existingAttendance ? existingAttendance.hospitalHours : 0.0,
        scannedCheckIn: existingAttendance ? existingAttendance.scannedCheckIn : false
      };
      
      if (existingAttendance) {
        attendanceEntry.id = existingAttendance.id;
        if (existingAttendance.messageText) {
          attendanceEntry.messageText = existingAttendance.messageText + ` | CCTV Face manually resolved - auto ${resolvedEventType}`;
        } else {
          attendanceEntry.messageText = `CCTV Face manually resolved - auto ${resolvedEventType}`;
        }
      } else {
        if (isLateCheckIn) {
          attendanceEntry.isLate = true;
          attendanceEntry.scannedCheckIn = true;
          attendanceEntry.status = "Late Check-in";
        }
        attendanceEntry.messageText = `CCTV Face manually resolved - auto ${resolvedEventType}`;
      }
      
      const cameraEvent = {
        id: `cctv_log_${Date.now()}`,
        employeeId: employee.id,
        employeeName: employee.name,
        eventType: resolvedEventType,
        siteName: detection.siteName || 'Office',
        timestamp: timestamp,
        date: eventDate,
        imageUrl: detection.imageUrl || '',
        imageFilename: 'cctv_frame.jpg',
        status: 'manually_resolved',
        confidence: detection.confidence || 1.0,
        videoUrl: detection.videoUrl || ''
      };
      
      const savedEvent = database.saveCameraEvent(cameraEvent);
      const savedAttendance = database.saveAttendance(attendanceEntry);
      
      io.emit('attendance_updated', savedAttendance);
      io.emit('camera_event_recorded', savedEvent);
      console.log(`[API] Manually recorded camera event and attendance for employee: ${employee.name}`);
    }

    // Clean name for directory format (matches face recognition python service formatting)
    const cleanName = employee.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    const employeeTrainingDir = path.join(__dirname, 'uploads', 'face_training', cleanName);

    if (!fs.existsSync(employeeTrainingDir)) {
      fs.mkdirSync(employeeTrainingDir, { recursive: true });
    }

    // Copy raw face image into employee's training folder
    const targetFilename = `cctv_${Date.now()}.jpg`;
    const targetPath = path.join(employeeTrainingDir, targetFilename);
    fs.copyFileSync(rawFacePath, targetPath);
    console.log(`[API] Assigned CCTV face crop to employee "${employee.name}" at: ${targetPath}`);

    // Trigger face retraining
    const imagesDir = path.join(__dirname, 'uploads', 'face_training');
    const formData = new URLSearchParams();
    formData.append('images_dir', imagesDir);
    formData.append('force', 'false'); // Don't force retrain everyone
    formData.append('employee_id', cleanName); // Only retrain this employee

    // Call Python face training service
    let retrainSuccess = false;
    try {
      const response = await fetch(`${FACE_RECOGNITION_SERVICE}/api/face/train`, {
        method: 'POST',
        body: formData,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const retrainResult = await response.json();
      retrainSuccess = retrainResult.success;
      console.log('[API] Retraining results:', retrainResult);
    } catch (trainErr) {
      console.error('[API] Retraining trigger failed:', trainErr.message);
    }

    // Delete the unknown detection record now that it is resolved
    database.deleteUnknownDetection(detectionId);
    io.emit('unknown_detection_deleted', detectionId);

    res.json({
      success: true,
      message: `Successfully assigned face to ${employee.name} and triggered model retraining.`,
      retrainSuccess
    });

  } catch (err) {
    console.error('[API] Assign unknown detection error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET CCTV Cameras list
app.get('/api/cctv', async (req, res) => {
  try {
    const cameras = database.getCctvCameras();
    
    // Fetch running status from Python microservice
    try {
      const statusResp = await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/status`);
      if (statusResp.ok) {
        const data = await statusResp.json();
        const activeCams = data.cameras || {};
        cameras.forEach(cam => {
          if (activeCams[cam.id]) {
            cam.running = activeCams[cam.id].running;
          } else {
            cam.running = false;
          }
        });
      }
    } catch (err) {
      console.warn(`[API] Failed to get CCTV running status from python: ${err.message}`);
      cameras.forEach(cam => { cam.running = false; });
    }
    
    res.json(cameras);
  } catch (err) {
    console.error('[API] Get CCTV cameras failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST Add/Edit CCTV Camera config
app.post('/api/cctv', async (req, res) => {
  try {
    const cameraData = req.body;
    if (!cameraData.name || !cameraData.source) {
      return res.status(400).json({ error: 'Camera Name and Stream Source are required.' });
    }
    
    const savedCamera = database.saveCctvCamera(cameraData);
    
    // If active, sync start to python microservice background thread
    if (savedCamera.status === 'active') {
      try {
        const db = database.read();
        const site = (db.sites || []).find(s => s.id === savedCamera.siteId);
        const siteName = site ? site.name : 'Office';
        
        await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            camera_id: savedCamera.id,
            name: savedCamera.name,
            source: savedCamera.source,
            site_name: siteName,
            event_type: savedCamera.eventType,
            threshold: 0.52
          })
        });
      } catch (err) {
        console.warn(`[API] Failed to start CCTV stream thread in python: ${err.message}`);
      }
    } else {
      // Stop background thread
      try {
        await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ camera_id: savedCamera.id })
        });
      } catch (err) {
        console.warn(`[API] Failed to stop CCTV stream thread in python: ${err.message}`);
      }
    }
    
    res.json(savedCamera);
  } catch (err) {
    console.error('[API] Save CCTV camera failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE CCTV Camera config
app.delete('/api/cctv/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Stop thread in python service
    try {
      await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera_id: id })
      });
    } catch (err) {
      console.warn(`[API] Failed to stop CCTV stream thread in python on deletion: ${err.message}`);
    }
    
    const success = database.deleteCctvCamera(id);
    if (success) {
      res.json({ success: true, message: 'CCTV camera deleted.' });
    } else {
      res.status(404).json({ error: 'CCTV camera not found.' });
    }
  } catch (err) {
    console.error('[API] Delete CCTV camera failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET CCTV Live MJPEG Stream proxy
app.get('/api/cctv/stream/:id', (req, res) => {
  const camera_id = req.params.id;
  const targetUrl = `${FACE_RECOGNITION_SERVICE}/api/cctv/stream/${camera_id}`;
  
  const proxyReq = http.get(targetUrl, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[Proxy Error] Failed to stream from face recognition api: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send('Streaming error');
    }
  });

  req.on('close', () => {
    proxyReq.destroy();
  });
});


// POST CCTV Stream test source
app.post('/api/cctv/test', async (req, res) => {
  try {
    const { source } = req.body;
    if (!source) {
      return res.status(400).json({ error: 'Stream Source is required to test connection.' });
    }
    res.json({ success: true, message: 'Stream connection configuration accepted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST CCTV Event Webhook (called by python thread)
app.post('/api/face/cctv-event', async (req, res) => {
  try {
    const {
      employee_id,
      confidence,
      camera_id,
      camera_name,
      site_name,
      event_type,
      image_base64,
      raw_face_base64,
      video_url
    } = req.body;
    
    const db = database.read();
    
    if (employee_id === 'unknown') {
      // Persist raw face crop so admin assignment can retrain embeddings.
      let rawFaceUrl = "";
      try {
        if (raw_face_base64 && typeof raw_face_base64 === 'string' && raw_face_base64.trim().length > 0) {
          const uploadsDir = path.join(__dirname, 'public', 'uploads', 'face_training', 'raw_faces');
          if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
          }

          // raw_face_base64 is already a pure base64 of JPG in your python code
          const clean = raw_face_base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
          const filename = `unknown_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
          const targetPath = path.join(uploadsDir, filename);
          fs.writeFileSync(targetPath, Buffer.from(clean, 'base64'));

          rawFaceUrl = `/uploads/face_training/raw_faces/${filename}`;
        }
      } catch (faceSaveErr) {
        console.warn('[CCTV Unknown] Failed to persist raw face crop:', faceSaveErr.message);
      }

      const unknownEvent = {
        cameraName: camera_name || 'CCTV Camera',
        siteName: site_name || 'Office',
        timestamp: new Date().toISOString(),
        confidence: confidence || 0.0,
        imageBase64: image_base64,
        rawFaceUrl,
        videoUrl: video_url || ''
      };

      const saved = database.saveUnknownDetection(unknownEvent);
      io.emit('unknown_detection_updated', saved);
      return res.json({ success: true, status: 'unknown_logged', detection: saved });
    }

    
    let employee = resolveEmployeeFromFaceId(employee_id, db.employees || []);
    
    if (!employee) {
      console.warn(`[CCTV Event] Match "${employee_id}" not found in database.`);
      return res.status(404).json({ error: 'Employee not found.' });
    }
    
    const now = new Date();
    const timestamp = now.toISOString();
    const eventDate = timestamp.split('T')[0];
    
    // Determine action check-in or check-out
    const existingAttendance = (db.attendance || []).find(
      a => a.employeeId === employee.id && a.date === eventDate
    );
    
    const localHour = now.getHours();
    
    let resolvedEventType = event_type;
    if (resolvedEventType === 'auto') {
      if (camera_name && (camera_name.toLowerCase().includes('entrance') || camera_name.toLowerCase().includes('entry'))) {
        resolvedEventType = 'entry';
      } else {
        resolvedEventType = 'exit';
      }
    }

    const isLateCheckInPendingScan = existingAttendance && existingAttendance.status === 'late' && !existingAttendance.scannedCheckIn;

    const isScanLateTime = (() => {
      if (!employee.shiftStart) return false;
      const [sh, sm] = employee.shiftStart.split(':').map(Number);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const shiftStartMinutes = sh * 60 + sm;
      return nowMinutes > shiftStartMinutes; // sharp time
    })();

    const isLateCheckIn = isLateCheckInPendingScan || (!existingAttendance && isScanLateTime);

    // Initialize or load punches array
    let punches = [];
    if (existingAttendance) {
      if (existingAttendance.punches && existingAttendance.punches.length > 0) {
        punches = [...existingAttendance.punches];
      } else {
        if (existingAttendance.checkIn) {
          punches.push({
            time: existingAttendance.checkIn,
            type: 'in',
            siteName: existingAttendance.siteName || '—',
            messageText: existingAttendance.messageText || 'Check-In',
            source: existingAttendance.scannedCheckIn ? 'Selfie' : 'WhatsApp'
          });
        }
        if (existingAttendance.checkOut) {
          punches.push({
            time: existingAttendance.checkOut,
            type: 'out',
            siteName: existingAttendance.siteName || '—',
            messageText: existingAttendance.messageText || 'Check-Out',
            source: existingAttendance.scannedCheckIn ? 'Selfie' : 'WhatsApp'
          });
        }
      }
    }

    // Determine the punch type of the new CCTV event
    const newPunchType = resolvedEventType === 'entry' ? 'in' : 'out';
    
    // Add the new punch
    punches.push({
      time: timestamp,
      type: newPunchType,
      siteName: site_name || camera_name || 'CCTV Camera',
      messageText: `CCTV Face recognized (${confidence ? (confidence * 100).toFixed(1) : '100'}%)`,
      source: 'CCTV',
      videoUrl: video_url || ''
    });

    // De-duplicate punches (tolerant) to preserve multiple exit/entry punches.
    // If CCTV fires the same event repeatedly within a few seconds, keep only one.
    const uniquePunches = [];
    const seen = new Set();
    const DEDUPE_WINDOW_MS = 8 * 1000; // 8 seconds tolerance


    punches.forEach(p => {
      const t = new Date(p.time).getTime();
      const bucket = Math.floor(t / DEDUPE_WINDOW_MS) * DEDUPE_WINDOW_MS;
      const key = `${bucket}_${p.type}`;

      if (!seen.has(key)) {
        seen.add(key);
        uniquePunches.push(p);
      }
    });

    // Sort punches chronologically
    uniquePunches.sort((a, b) => new Date(a.time) - new Date(b.time));
    
    // Calculate checkIn, checkOut, lunchIn, lunchOut based on punches
    let finalCheckIn = null;
    let finalCheckOut = null;
    
    const ins = uniquePunches.filter(p => p.type === 'in');
    if (ins.length > 0) {
      finalCheckIn = ins[0].time;
    }
    
    if (uniquePunches.length > 0) {
      const lastPunch = uniquePunches[uniquePunches.length - 1];
      if (lastPunch.type === 'in') {
        // If the last punch is an 'in', it means they are currently checked in (active)
        finalCheckOut = null;
      } else {
        // If the last punch is an 'out', it means they are currently checked out
        finalCheckOut = lastPunch.time;
      }
    }
    
    // Calculate lunch break
    let finalLunchOut = null;
    let finalLunchIn = null;
    for (let i = 0; i < uniquePunches.length; i++) {
      const p = uniquePunches[i];
      const pDate = new Date(p.time);
      const pHour = pDate.getHours();
      
      if (p.type === 'out' && pHour === 13 && !finalLunchOut) {
        finalLunchOut = p.time;
        for (let j = i + 1; j < uniquePunches.length; j++) {
          if (uniquePunches[j].type === 'in') {
            finalLunchIn = uniquePunches[j].time;
            break;
          }
        }
      }
    }

    const attendanceEntry = {
      employeeId: employee.id,
      employeeName: employee.name,
      date: eventDate,
      siteName: site_name || camera_name || 'CCTV Camera',
      messageText: '',
      facialRecognitionMatch: true,
      matchConfidence: confidence,
      punches: uniquePunches,
      checkIn: finalCheckIn,
      checkOut: finalCheckOut,
      lunchOut: finalLunchOut,
      lunchIn: finalLunchIn,
      travelHours: existingAttendance ? (existingAttendance.travelHours || 0.0) : 0.0,
      notes: existingAttendance ? (existingAttendance.notes || "") : "",
      status: existingAttendance ? existingAttendance.status : "",
      isLate: existingAttendance ? (existingAttendance.isLate || isLateCheckIn) : isLateCheckIn,
      isHospitalCase: existingAttendance ? existingAttendance.isHospitalCase : false,
      hospitalHours: existingAttendance ? existingAttendance.hospitalHours : 0.0,
      scannedCheckIn: existingAttendance ? existingAttendance.scannedCheckIn : false
    };

    if (existingAttendance) {
      attendanceEntry.id = existingAttendance.id;
    } else {
      if (isLateCheckIn) {
        attendanceEntry.isLate = true;
        attendanceEntry.scannedCheckIn = true;
        attendanceEntry.status = "Late Check-in";
      }
    }
    
    // 1. Record camera event log
    const cameraEvent = {
      id: `cctv_log_${Date.now()}`,
      employeeId: employee.id,
      employeeName: employee.name,
      eventType: resolvedEventType,
      siteName: site_name || 'CCTV Camera',
      timestamp: timestamp,
      date: eventDate,
      imageBase64: image_base64,
      imageFilename: 'cctv_frame.jpg',
      status: req.body.status || 'recognized',
      confidence: confidence,
      videoUrl: video_url || ''
    };
    
    const savedEvent = database.saveCameraEvent(cameraEvent);
    
    // 2. Record attendance entry
    if (existingAttendance && existingAttendance.messageText) {
      attendanceEntry.messageText = existingAttendance.messageText + ` | CCTV Face recognized - auto ${resolvedEventType}`;
    } else {
      attendanceEntry.messageText = `CCTV Face recognized - auto ${resolvedEventType}`;
    }
    
    const savedAttendance = database.saveAttendance(attendanceEntry);
    io.emit('attendance_updated', savedAttendance);
    io.emit('camera_event_recorded', savedEvent);
    
    res.json({ success: true, cameraEvent: savedEvent, attendance: savedAttendance });
  } catch (err) {
    console.error('[API] CCTV event webhook failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resolve Exception Board (Unparsed Message)
app.get('/api/pending', (req, res) => {
  res.json(database.getPendingMessages());
});

app.post('/api/pending/resolve', (req, res) => {
  try {
    const { messageId, employeeId, employeeName, siteId, siteName, action, time, date } = req.body;

    let createdEmployeeId = null;
    let createdSiteId = null;

    const db = database.read();
    let emp = employeeId ? db.employees.find(e => e.id === employeeId) : null;
    const normalizedEmployeeName = employeeName ? employeeName.trim() : "";
    const normalizedSiteName = siteName ? siteName.trim() : "";

    if (!emp && normalizedEmployeeName) {
      emp = db.employees.find(e => e.name.toLowerCase() === normalizedEmployeeName.toLowerCase());
    }

    if (!emp && normalizedEmployeeName) {
      // Auto-register new custom worker if not found
      const defaultSiteId = siteId || (db.sites[0] ? db.sites[0].id : null);
      emp = database.saveEmployee({
        name: normalizedEmployeeName,
        phone: "",
        status: "active",
        dailyRate: 120,
        hourlyRate: 20,
        siteId: defaultSiteId || "site_a"
      });
      createdEmployeeId = emp.id;
    }

    let site = siteId ? db.sites.find(s => s.id === siteId) : null;
    if (!site && normalizedSiteName) {
      site = db.sites.find(s => s.name.toLowerCase() === normalizedSiteName.toLowerCase());
    }
    if (!site && normalizedSiteName) {
      site = database.saveSite({
        name: normalizedSiteName,
        description: "Custom site created via exception resolver"
      });
      createdSiteId = site.id;
    }

    const pendingMsg = db.pending_messages.find(m => m.id === messageId);
    if (!emp) return res.status(400).json({ error: "Employee name is required." });

    const targetSiteName = site ? site.name : (normalizedSiteName || "Main Site");
    const targetDate = date || getLocalDateString();
    const timestamp = time ? new Date(`${targetDate}T${time}`).toISOString() : new Date().toISOString();

    let record = {};
    const existingIndex = db.attendance.findIndex(a => a.employeeId === emp.id && a.date === targetDate);
    
    let originalAttendanceRecord = null;
    let attendanceRevertType = 'create';

    if (existingIndex >= 0) {
      originalAttendanceRecord = JSON.parse(JSON.stringify(db.attendance[existingIndex]));
      attendanceRevertType = 'update';
    }

    if (action === 'in') {
      const resolvedSource = (pendingMsg && pendingMsg.type === 'selfie_verification') ? 'Selfie' : 'WhatsApp';
      record = {
        employeeId: emp.id,
        employeeName: emp.name,
        siteName: targetSiteName,
        date: targetDate,
        checkIn: timestamp,
        checkOut: null,
        messageText: pendingMsg ? `[RESOLVED] ${pendingMsg.messageText}` : "Manual check-in",
        status: "checked-in",
        punches: [{
          time: timestamp,
          type: 'in',
          siteName: targetSiteName,
          messageText: pendingMsg ? `[RESOLVED] ${pendingMsg.messageText}` : "Manual check-in",
          source: resolvedSource
        }]
      };
    } else {
      const resolvedSource = (pendingMsg && pendingMsg.type === 'selfie_verification') ? 'Selfie' : 'WhatsApp';
      if (existingIndex >= 0) {
        record = db.attendance[existingIndex];
        record.checkOut = timestamp;
        record.messageText += pendingMsg ? ` | [RESOLVED] ${pendingMsg.messageText}` : " | Manual check-out";
        if (!record.punches) record.punches = [];
        const exists = record.punches.some(p => p.time === timestamp && p.type === 'out');
        if (!exists) {
          record.punches.push({
            time: timestamp,
            type: 'out',
            siteName: targetSiteName,
            messageText: pendingMsg ? `[RESOLVED] ${pendingMsg.messageText}` : "Manual check-out",
            source: resolvedSource
          });
        }
      } else {
        const defaultCheckIn = new Date(`${targetDate}T08:00:00`).toISOString();
        record = {
          employeeId: emp.id,
          employeeName: emp.name,
          siteName: targetSiteName,
          date: targetDate,
          checkIn: defaultCheckIn,
          checkOut: timestamp,
          messageText: pendingMsg ? `[RESOLVED OUT ONLY] ${pendingMsg.messageText}` : "Manual out-only",
          status: "completed",
          punches: [
            {
              time: defaultCheckIn,
              type: 'in',
              siteName: targetSiteName,
              messageText: "Default Check-In on Resolve",
              source: resolvedSource
            },
            {
              time: timestamp,
              type: 'out',
              siteName: targetSiteName,
              messageText: pendingMsg ? `[RESOLVED OUT ONLY] ${pendingMsg.messageText}` : "Manual out-only",
              source: resolvedSource
            }
          ]
        };
      }
    }

    const saved = database.saveAttendance(record);
    database.deletePendingMessage(messageId);

    // Track resolve action for undo
    undoStack.push({
      type: 'resolve',
      payload: {
        messageId,
        employeeId,
        employeeName,
        siteId,
        siteName,
        action,
        time,
        date: targetDate
      },
      pendingMessage: pendingMsg ? { ...pendingMsg } : null,
      createdEmployeeId,
      createdSiteId,
      attendanceRevert: {
        type: attendanceRevertType,
        date: targetDate,
        employeeId: emp.id,
        originalRecord: originalAttendanceRecord
      }
    });
    if (undoStack.length > 10) {
      undoStack.shift();
    }
    // Clear redoStack on any new action
    redoStack.length = 0;

    io.emit('attendance_updated', saved);
    io.emit('pending_updated');

    res.json({ success: true, record: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pending/:id', (req, res) => {
  try {
    const db = database.read();
    const pendingMsg = db.pending_messages.find(m => m.id === req.params.id);
    if (pendingMsg) {
      undoStack.push({
        type: 'delete',
        payload: { id: req.params.id },
        pendingMessage: { ...pendingMsg },
        createdEmployeeId: null,
        createdSiteId: null,
        attendanceRevert: null
      });
      if (undoStack.length > 10) {
        undoStack.shift();
      }
      // Clear redoStack on any new action
      redoStack.length = 0;
    }
    database.deletePendingMessage(req.params.id);
    io.emit('pending_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to undo the last resolved or deleted exception
app.post('/api/pending/undo', (req, res) => {
  try {
    if (undoStack.length === 0) {
      return res.status(400).json({ error: "No actions to undo." });
    }

    const lastAction = undoStack.pop();
    const db = database.read();

    // 1. Restore the pending message
    if (lastAction.pendingMessage) {
      const exists = db.pending_messages.some(m => m.id === lastAction.pendingMessage.id);
      if (!exists) {
        db.pending_messages.push(lastAction.pendingMessage);
      }
    }

    // 2. Revert employee auto-registration if created during this action
    if (lastAction.createdEmployeeId) {
      db.employees = db.employees.filter(e => e.id !== lastAction.createdEmployeeId);
    }

    // 3. Revert site auto-registration if created during this action
    if (lastAction.createdSiteId) {
      db.sites = db.sites.filter(s => s.id !== lastAction.createdSiteId);
    }

    // 4. Revert attendance record changes
    if (lastAction.attendanceRevert) {
      const { type, date, employeeId, originalRecord } = lastAction.attendanceRevert;
      if (type === 'create') {
        db.attendance = db.attendance.filter(a => !(a.employeeId === employeeId && a.date === date));
      } else if (type === 'update') {
        const index = db.attendance.findIndex(a => a.employeeId === employeeId && a.date === date);
        if (index >= 0) {
          if (originalRecord) {
            db.attendance[index] = originalRecord;
          } else {
            db.attendance.splice(index, 1);
          }
        }
      }
    }

    // Save changes back to database
    database.writeAtomic(db);
    database.syncToExcelAsync();

    // Push the undone action onto the redo stack
    redoStack.push(lastAction);
    if (redoStack.length > 10) {
      redoStack.shift();
    }

    // Emit live socket updates to refresh UI immediately
    io.emit('attendance_updated');
    io.emit('pending_updated');

    res.json({ success: true, undoneAction: lastAction.type });
  } catch (err) {
    console.error("[Undo Engine] Failed to undo action:", err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to redo the last undone action
app.post('/api/pending/redo', (req, res) => {
  try {
    if (redoStack.length === 0) {
      return res.status(400).json({ error: "No actions to redo." });
    }

    const lastAction = redoStack.pop();

    if (lastAction.type === 'resolve') {
      const { messageId, employeeId, employeeName, siteId, siteName, action, time, date } = lastAction.payload;

      let createdEmployeeId = null;
      let createdSiteId = null;

      const db = database.read();
      let emp = employeeId ? db.employees.find(e => e.id === employeeId) : null;
      const normalizedEmployeeName = employeeName ? employeeName.trim() : "";
      const normalizedSiteName = siteName ? siteName.trim() : "";

      if (!emp && normalizedEmployeeName) {
        emp = db.employees.find(e => e.name.toLowerCase() === normalizedEmployeeName.toLowerCase());
      }

      if (!emp && normalizedEmployeeName) {
        // Auto-register new custom worker if not found
        const defaultSiteId = siteId || (db.sites[0] ? db.sites[0].id : null);
        emp = database.saveEmployee({
          name: normalizedEmployeeName,
          phone: "",
          status: "active",
          dailyRate: 120,
          hourlyRate: 20,
          siteId: defaultSiteId || "site_a"
        });
        createdEmployeeId = emp.id;
      }

      let site = siteId ? db.sites.find(s => s.id === siteId) : null;
      if (!site && normalizedSiteName) {
        site = db.sites.find(s => s.name.toLowerCase() === normalizedSiteName.toLowerCase());
      }
      if (!site && normalizedSiteName) {
        site = database.saveSite({
          name: normalizedSiteName,
          description: "Custom site created via exception resolver"
        });
        createdSiteId = site.id;
      }

      const pendingMsg = db.pending_messages.find(m => m.id === messageId);
      if (!emp) return res.status(400).json({ error: "Employee name is required." });

      const targetSiteName = site ? site.name : (normalizedSiteName || "Main Site");
      const targetDate = date || getLocalDateString();
      const timestamp = time ? new Date(`${targetDate}T${time}`).toISOString() : new Date().toISOString();

      let record = {};
      const existingIndex = db.attendance.findIndex(a => a.employeeId === emp.id && a.date === targetDate);
      
      let originalAttendanceRecord = null;
      let attendanceRevertType = 'create';

      if (existingIndex >= 0) {
        originalAttendanceRecord = JSON.parse(JSON.stringify(db.attendance[existingIndex]));
        attendanceRevertType = 'update';
      }

      if (action === 'in') {
        record = {
          employeeId: emp.id,
          employeeName: emp.name,
          siteName: targetSiteName,
          date: targetDate,
          checkIn: timestamp,
          checkOut: null,
          messageText: pendingMsg ? `[RESOLVED] ${pendingMsg.messageText}` : "Manual check-in",
          status: "checked-in"
        };
      } else {
        if (existingIndex >= 0) {
          record = db.attendance[existingIndex];
          record.checkOut = timestamp;
          record.messageText += pendingMsg ? ` | [RESOLVED] ${pendingMsg.messageText}` : " | Manual check-out";
        } else {
          const defaultCheckIn = new Date(`${targetDate}T08:00:00`).toISOString();
          record = {
            employeeId: emp.id,
            employeeName: emp.name,
            siteName: targetSiteName,
            date: targetDate,
            checkIn: defaultCheckIn,
            checkOut: timestamp,
            messageText: pendingMsg ? `[RESOLVED OUT ONLY] ${pendingMsg.messageText}` : "Manual out-only",
            status: "completed"
          };
        }
      }

      const saved = database.saveAttendance(record);
      database.deletePendingMessage(messageId);

      // Push back to undoStack
      undoStack.push({
        type: 'resolve',
        payload: lastAction.payload,
        pendingMessage: pendingMsg ? { ...pendingMsg } : (lastAction.pendingMessage ? { ...lastAction.pendingMessage } : null),
        createdEmployeeId,
        createdSiteId,
        attendanceRevert: {
          type: attendanceRevertType,
          date: targetDate,
          employeeId: emp.id,
          originalRecord: originalAttendanceRecord
        }
      });
      if (undoStack.length > 10) {
        undoStack.shift();
      }

      io.emit('attendance_updated', saved);
      io.emit('pending_updated');

      res.json({ success: true, redoneAction: 'resolve' });

    } else if (lastAction.type === 'delete') {
      const messageId = lastAction.payload.id;
      database.deletePendingMessage(messageId);

      // Push back to undoStack
      undoStack.push(lastAction);
      if (undoStack.length > 10) {
        undoStack.shift();
      }

      io.emit('pending_updated');
      res.json({ success: true, redoneAction: 'delete' });
    } else {
      res.status(400).json({ error: "Unknown action type" });
    }
  } catch (err) {
    console.error("[Redo Engine] Failed to redo action:", err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to check if undo/redo is available
app.get('/api/pending/undo/status', (req, res) => {
  res.json({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    lastActionType: undoStack.length > 0 ? undoStack[undoStack.length - 1].type : null
  });
});

// Endpoint to retrieve recent messages rolling cache
app.get('/api/messages/recent', (req, res) => {
  res.json(recentMessages);
});

// --- Selfie Verification Board APIs ---
app.get('/api/selfies', (req, res) => {
  if (!database.read().selfies) {
    return res.json([]);
  }
  res.json(database.getSelfies().sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
});

app.post('/api/selfies/verify', (req, res) => {
  try {
    const { id, adminNotes } = req.body;
    const db = database.read();
    if (!db.selfies) db.selfies = [];
    
    const selfie = db.selfies.find(s => s.id === id);
    if (!selfie) {
      return res.status(404).json({ error: "Selfie record not found" });
    }
    
    selfie.status = 'verified';
    if (adminNotes !== undefined) selfie.adminNotes = adminNotes;
    database.writeAtomic(db);
    
    // Also trigger attendance check-in update if matched worker exists!
    const emp = db.employees.find(e => e.id === selfie.employeeId);
    if (emp) {
      const parserObj = require('./parser');
      const mockResult = {
        isSuccess: true,
        isList: false,
        extractedName: emp.name,
        extractedSite: selfie.siteName || emp.siteId || "Main Site",
        extractedAction: "in",
        matchedEmployee: emp,
        checkInTime: selfie.timestamp,
        source: 'Selfie'
      };
      
      const loggedRecord = database.recordFromWhatsApp(mockResult, `Selfie manually verified by Admin: ${adminNotes || ''}`);
      io.emit('attendance_updated', loggedRecord);
    }
    
    io.emit('selfie_updated', selfie);
    res.json(selfie);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/selfies/reject', (req, res) => {
  try {
    const { id, adminNotes } = req.body;
    const db = database.read();
    if (!db.selfies) db.selfies = [];
    
    const selfie = db.selfies.find(s => s.id === id);
    if (!selfie) {
      return res.status(404).json({ error: "Selfie record not found" });
    }
    
    selfie.status = 'rejected';
    if (adminNotes !== undefined) selfie.adminNotes = adminNotes;
    database.writeAtomic(db);
    
    // If rejected, update associated attendance notes if exists
    const emp = db.employees.find(e => e.id === selfie.employeeId);
    if (emp) {
      const targetDate = selfie.timestamp.split('T')[0];
      const recIndex = db.attendance.findIndex(a => a.employeeId === emp.id && a.date === targetDate);
      if (recIndex >= 0) {
        db.attendance[recIndex].notes = `[REJECTED SELFIE] ${adminNotes || 'Location invalid'}`;
        database.writeAtomic(db);
        database.syncToExcelAsync();
        io.emit('attendance_updated', db.attendance[recIndex]);
      }
    }
    
    io.emit('selfie_updated', selfie);
    res.json(selfie);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Employee Mobile Self-Service APIs ---

app.post('/api/employee/login', (req, res) => {
  try {
    const { employeeId, passcode } = req.body;
    if (!employeeId || !passcode) {
      return res.status(400).json({ error: "Employee ID and passcode are required." });
    }
    const db = database.read();
    
    // Normalize login lookup
    const cleanId = String(employeeId).trim().toLowerCase();
    const cleanPass = String(passcode).trim();
    
    const employee = db.employees.find(e => {
      if (!e) return false;
      const matchId = String(e.id).toLowerCase() === cleanId;
      const matchUserId = String(e.userId || '').toLowerCase() === cleanId;
      const matchPhone = String(e.phone || '').includes(cleanId);
      return matchId || matchUserId || matchPhone;
    });

    if (!employee) {
      return res.status(401).json({ error: "Invalid employee ID or phone number." });
    }

    if (String(employee.passcode || '1234') !== cleanPass) {
      return res.status(401).json({ error: "Incorrect passcode." });
    }

    res.json(employee);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/employee/attendance', (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) {
      return res.status(400).json({ error: "employeeId is required" });
    }
    const db = database.read();
    const list = db.attendance.filter(a => a && a.employeeId === employeeId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/employee/payroll', (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) {
      return res.status(400).json({ error: "employeeId is required" });
    }
    const db = database.read();
    const list = (db.payroll || []).filter(p => p && p.employeeId === employeeId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/employee/loans', (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) {
      return res.status(400).json({ error: "employeeId is required" });
    }
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    res.json(employee.loans || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin Loan Management APIs ---

app.post('/api/employees/:id/loans', (req, res) => {
  try {
    const { id } = req.params;
    const { amount, purpose, monthlyInstallment } = req.body;
    
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Valid loan amount is required." });
    }
    
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === id);
    if (!employee) {
      return res.status(404).json({ error: "Employee record not found" });
    }
    
    if (!employee.loans) employee.loans = [];
    
    const newLoan = {
      id: `loan_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      amount: parseFloat(amount),
      balance: parseFloat(amount),
      purpose: purpose || "General loan",
      monthlyInstallment: parseFloat(monthlyInstallment) || 0.0,
      status: "active",
      createdAt: new Date().toISOString(),
      repayments: []
    };
    
    employee.loans.push(newLoan);
    database.writeAtomic(db);
    database.syncToExcelAsync();
    
    res.status(201).json(newLoan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees/:id/loans/:loanId/repayments', (req, res) => {
  try {
    const { id, loanId } = req.params;
    const { amount, remarks } = req.body;
    
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Valid repayment amount is required." });
    }
    
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === id);
    if (!employee) {
      return res.status(404).json({ error: "Employee record not found" });
    }
    
    if (!employee.loans) employee.loans = [];
    const loan = employee.loans.find(l => l.id === loanId);
    if (!loan) {
      return res.status(404).json({ error: "Loan record not found" });
    }
    
    const payAmt = parseFloat(amount);
    loan.balance = Math.max(0.0, Number((loan.balance - payAmt).toFixed(2)));
    if (loan.balance <= 0) {
      loan.status = "fully-paid";
    }
    
    loan.repayments.push({
      date: getLocalDateString(),
      amount: payAmt,
      remarks: remarks || "Cash payment"
    });
    
    database.writeAtomic(db);
    database.syncToExcelAsync();
    
    res.json(loan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- MPA Page Routes ---
app.get('/dashboard', (req, res) => {
  res.redirect('/');
});
const mpaPages = [
  'logs', 'punches', 'travel', 'profiles', 'employees',
  'payroll', 'welders', 'selfies', 'camera', 'unknown',
  'sites', 'holidays', 'settings'
];
mpaPages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});


// --- On-Site Mobile Web Check-In Portal Routes ---
app.get('/checkin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

app.post('/api/checkin/web', async (req, res) => {
  try {
    const { employeeId, base64Data, latitude, longitude, mimetype } = req.body;
    
    if (!employeeId || !base64Data || !latitude || !longitude) {
      return res.status(400).json({ error: "Missing required check-in fields." });
    }
    
    const db = database.read();
    
    // Find matched Employee
    const emp = db.employees.find(e => e.id === employeeId);
    if (!emp) {
      return res.status(404).json({ error: "Employee record not found" });
    }
    
    let buffer = Buffer.from(base64Data, 'base64');
    let ext = mimetype.split('/')[1] || 'jpg';
    if (ext.includes(';')) ext = ext.split(';')[0];
    
    let activeMime = mimetype;
    if (mimetype.toLowerCase().includes('heic') || mimetype.toLowerCase().includes('heif') || ext.toLowerCase() === 'heic' || ext.toLowerCase() === 'heif') {
      try {
        console.log(`[Web Check-In] HEIC image detected. Converting to JPEG on-the-fly...`);
        const heicConvert = require('heic-convert');
        const jpegBuffer = await heicConvert({
          buffer: buffer,
          format: 'JPEG',
          quality: 0.8
        });
        buffer = jpegBuffer;
        ext = 'jpeg';
        activeMime = 'image/jpeg';
        console.log(`[Web Check-In] HEIC image successfully converted to JPEG.`);
      } catch (convErr) {
        console.error(`[Web Check-In] Failed to convert HEIC to JPEG:`, convErr.message);
      }
    }
    
    // 1. Save image to static folder
    const selfieDir = path.join(__dirname, 'public', 'uploads', 'selfies');
    if (!fs.existsSync(selfieDir)) {
      fs.mkdirSync(selfieDir, { recursive: true });
    }
    
    const filename = `web_${employeeId}_${Date.now()}.${ext}`;
    const filepath = path.join(selfieDir, filename);
    fs.writeFileSync(filepath, buffer);
    const imageUrl = `/uploads/selfies/${filename}`;
    
    // 2. Parse EXIF data from uploaded Base64 photo to extract actual capture time!
    let exifGPS = null;
    let exifDateTime = null;
    
    try {
      const ExifParser = require('exif-parser');
      const parser = ExifParser.create(buffer);
      const result = parser.parse();
      const tags = result.tags;
      
      if (tags) {
        if (tags.GPSLatitude !== undefined && tags.GPSLongitude !== undefined) {
          exifGPS = {
            latitude: Number(tags.GPSLatitude),
            longitude: Number(tags.GPSLongitude)
          };
        }
        
        let dateSecs = tags.DateTimeOriginal || tags.ModifyDate || tags.CreateDate;
        if (dateSecs) {
          const utcDate = new Date(dateSecs * 1000);
          const year = utcDate.getUTCFullYear();
          const month = utcDate.getUTCMonth();
          const date = utcDate.getUTCDate();
          const hours = utcDate.getUTCHours();
          const minutes = utcDate.getUTCMinutes();
          const seconds = utcDate.getUTCSeconds();
          
          const localDate = new Date(year, month, date, hours, minutes, seconds);
          exifDateTime = localDate.toISOString();
        }
      }
    } catch (e) {
      console.warn("[Web Check-In] EXIF metadata extraction failed:", e.message);
    }
    
    // 3. Geofence matching (using the browser's hardware GPS, which is highly accurate)
    let siteName = "—";
    let siteId = "";
    let distance = null;
    let closestSite = null;
    
    if (db.sites && db.sites.length > 0) {
      let minDistance = Infinity;
      
      db.sites.forEach(site => {
        if (site.latitude && site.longitude) {
          const dist = database.getHaversineDistance(latitude, longitude, site.latitude, site.longitude);
          if (dist < minDistance) {
            minDistance = dist;
            closestSite = site;
          }
        }
      });
      
      if (closestSite) {
        distance = minDistance;
        if (minDistance <= 200) {
          siteId = closestSite.id;
          siteName = closestSite.name;
        }
      }
    }
    
    // 4. Time offset (anti-spoofing) checking
    const receivedTime = new Date();
    let timeDiffMinutes = 0;
    
    if (exifDateTime) {
      const photoTime = new Date(exifDateTime);
      timeDiffMinutes = Number((Math.abs(receivedTime - photoTime) / 60000).toFixed(1));
    }
    
    // 5. Evaluate Status
    let status = "flagged_location";
    let isWithinBounds = distance !== null && distance <= 200;
    
    // Time check: if EXIF datetime is present, gap must be <= 15 minutes!
    let isRealTime = exifDateTime ? timeDiffMinutes <= 15 : true;
    
    // Anti-Spoofing GPS Verification: If photo has EXIF GPS, compare it to the browser's GPS!
    let isGpsSpoofed = false;
    if (exifGPS) {
      const gpsMismatchDist = database.getHaversineDistance(latitude, longitude, exifGPS.latitude, exifGPS.longitude);
      if (gpsMismatchDist > 150) { // More than 150 meters mismatch between photo capture and submission!
        isGpsSpoofed = true;
      }
    }
    
    if (!isWithinBounds) {
      status = "flagged_location";
    } else if (!isRealTime) {
      status = "flagged_time";
    } else if (isGpsSpoofed) {
      status = "flagged_location"; // Spoofed GPS location!
    } else {
      status = "verified";
    }
    
    let adminNotes = `Checked in via Mobile Web Portal. GPS verified (${Math.round(distance || 0)}m distance).`;
    if (!isWithinBounds) {
      adminNotes = `[FLAGGED LOCATION] Off-Site Check-In! Closest registered site is ${closestSite ? closestSite.name : 'none'} (${Math.round(distance || 0)}m away).`;
    } else if (isGpsSpoofed) {
      adminNotes = `[SPOOFING SUSPECTED] Geolocation mismatch! Photo EXIF coordinates differ from browser coordinates.`;
    } else if (!isRealTime) {
      adminNotes = `[FLAGGED TIME] Photo was clicked earlier (Gap: ${timeDiffMinutes} mins).`;
    }
    
    // 6. Assemble selfie record
    const selfieRecord = {
      id: `selfie_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      employeeId: emp.id,
      employeeName: emp.name,
      messageId: `web_checkin_${Date.now()}`,
      imageUrl,
      timestamp: receivedTime.toISOString(),
      exifDateTime: exifDateTime || receivedTime.toISOString(), // Fall back to live time if no EXIF
      exifGPS: exifGPS || { latitude: Number(latitude), longitude: Number(longitude) },
      siteId,
      siteName,
      distance: distance !== null ? Number(distance.toFixed(1)) : null,
      timeDiffMinutes: Number(timeDiffMinutes.toFixed(1)),
      status,
      adminNotes
    };
    
    if (!db.selfies) db.selfies = [];
    db.selfies.push(selfieRecord);
    database.writeAtomic(db);
    
    // 7. Auto-check-in to attendance database if VERIFIED
    if (status === "verified") {
      const parserObj = require('./parser');
      const mockResult = {
        isSuccess: true,
        isList: false,
        extractedName: emp.name,
        extractedSite: siteName || emp.siteId || "Main Site",
        extractedAction: "in",
        matchedEmployee: emp
      };
      
      const loggedRecord = database.recordFromWhatsApp(mockResult, `Web check-in at ${siteName}`);
      io.emit('attendance_updated', loggedRecord);
    } else {
      // Flagged location/time
      const parserObj = require('./parser');
      const mockResult = {
        isSuccess: true,
        isList: false,
        extractedName: emp.name,
        extractedSite: siteName || emp.siteId || "Main Site",
        extractedAction: "in",
        matchedEmployee: emp
      };
      const record = database.recordFromWhatsApp(mockResult, `Web check-in at ${siteName}`);
      
      const dbRead = database.read();
      const recIndex = dbRead.attendance.findIndex(a => a.id === record.id);
      if (recIndex >= 0) {
        let warningNote = `[FLAGGED SELFIE] Web Geofence Mismatch (${Math.round(distance)}m)`;
        if (!isRealTime) {
          warningNote = `[FLAGGED SELFIE] Photo Clicked Earlier (Gap: ${timeDiffMinutes} mins)`;
        } else if (isGpsSpoofed) {
          warningNote = `[FLAGGED SELFIE] GPS coordinates spoofed!`;
        }
        
        dbRead.attendance[recIndex].notes = warningNote;
        dbRead.attendance[recIndex].isManualOverride = false;
        database.writeAtomic(dbRead);
        database.syncToExcelAsync();
        io.emit('attendance_updated', dbRead.attendance[recIndex]);
      }
    }
    
    // Emit WebSocket notifications
    io.emit('selfie_received', selfieRecord);
    io.emit('stats_updated');
    
    res.json(selfieRecord);
  } catch (err) {
    console.error("Web check-in error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Monthly Salary Payroll Routes ---
app.get('/api/payroll', (req, res) => {
  const { month, startDate, endDate } = req.query;
  if (startDate && endDate) {
    return res.json(database.getMonthlySalarySheet(startDate, endDate));
  }
  const targetMonth = month || new Date().toISOString().substring(0, 7); // e.g. "2026-03"
  res.json(database.getMonthlySalarySheet(targetMonth));
});

// Welders Weekly Report Routes
app.get('/api/welders-weekly', (req, res) => {
  const { friday } = req.query;
  if (!friday) {
    // Return all available unique Fridays in logs (sorted latest first)
    const db = database.read();
    const uniqueDates = Array.from(new Set(db.attendance.map(a => a.date)));
    const fridays = uniqueDates.filter(d => {
      try {
        return new Date(d).getDay() === 5; // Friday is 5
      } catch (e) {
        return false;
      }
    }).sort((a, b) => b.localeCompare(a));
    return res.json({ fridays });
  }
  
  try {
    const reportData = database.getWeldersWeeklyReportData(friday);
    res.json({ success: true, friday, data: reportData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/export/welders-weekly/excel', async (req, res) => {
  const { friday } = req.query;
  if (!friday) {
    return res.status(400).send("Friday date parameter is required.");
  }
  
  try {
    const reportData = database.getWeldersWeeklyReportData(friday);
    if (!reportData || reportData.length === 0) {
      return res.status(404).send("No report data found for the selected Friday.");
    }
    
    // Sort welders alphabetically
    reportData.sort((a, b) => a.welderName.localeCompare(b.welderName));
    
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    
    // 1. Build Attendance Sheet
    const wsAtt = workbook.addWorksheet("Weekly Attendance");
    
    const dayNames = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
    // Build headers for attendance
    const attHeaders = ["Welder ID", "Welder Name"];
    reportData[0].dailyDetails.forEach((d, idx) => {
      attHeaders.push(`${dayNames[idx]} (${d.date})`);
    });
    attHeaders.push("Total Hours", "Days Present");
    
    wsAtt.addRow(attHeaders);
    
    reportData.forEach(w => {
      const row = [w.welderId || "—", w.welderName];
      w.dailyDetails.forEach(d => {
        if (d.status === "ABSENT") {
          row.push("ABSENT");
        } else if (d.status === "LEAVE") {
          row.push("LEAVE");
        } else {
          row.push(`${d.status} (${d.hours} hrs)`);
        }
      });
      row.push(w.totalHours, w.totalPresentDays);
      wsAtt.addRow(row);
    });
    
    // Auto-fit attendance column widths
    wsAtt.columns.forEach(col => {
      let maxLen = 0;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const valStr = cell.value ? String(cell.value) : '';
        if (valStr.length > maxLen) {
          maxLen = valStr.length;
        }
      });
      col.width = Math.max(12, maxLen + 3);
    });
    wsAtt.views = [{ showGridLines: true }];
    
    // Style attendance header
    const attHeaderRow = wsAtt.getRow(1);
    attHeaderRow.height = 24;
    attHeaderRow.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF475569' } // Darker slate grey for attendance
      };
    });
    
    // 2. Build Weekly Payroll Summary Sheet
    const wsSummary = workbook.addWorksheet("Weekly Payroll Summary");
    
    const summaryHeaders = [
      "User ID", "Employee Name", "Daily Rate", "Weekly Regular Wage", 
      "Weekly Overtime Pay", "Weekly Travel Pay", "Total Weekly Earnings"
    ];
    
    wsSummary.addRow(summaryHeaders);
    
    reportData.forEach(w => {
      wsSummary.addRow([
        w.welderId || "—",
        w.welderName,
        w.dailyRate,
        w.weeklyRegularWage,
        w.weeklyOtPay,
        w.weeklyTravelPay,
        w.totalWeeklyEarnings
      ]);
    });
    
    const lastSummaryDataRow = reportData.length + 1;
    const totalSummaryRowIndex = reportData.length + 2;
    
    // Add total row
    const totalSummaryRowObj = wsSummary.addRow([]);
    totalSummaryRowObj.getCell(1).value = "Total";
    totalSummaryRowObj.getCell(7).value = { formula: `=SUM(G2:G${lastSummaryDataRow})` };
    
    // Auto-fit summary column widths
    wsSummary.columns.forEach(col => {
      let maxLen = 0;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const valStr = cell.value ? String(cell.value) : '';
        if (valStr.length > maxLen) {
          maxLen = valStr.length;
        }
      });
      col.width = Math.max(12, maxLen + 3);
    });
    
    // Style summary header row (row 1)
    const summaryHeaderRow = wsSummary.getRow(1);
    summaryHeaderRow.height = 28;
    summaryHeaderRow.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' } // Dark slate slate/blue #1E293B
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    
    // Style data and total rows in Weekly Payroll Summary
    wsSummary.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      
      const isTotalRow = (rowNum === totalSummaryRowIndex);
      row.height = isTotalRow ? 24 : 22;
      
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (isTotalRow) {
          cell.font = { name: 'Segoe UI', size: 10, bold: true };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          
          if (colNum === 1) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          }
          
          if (colNum === 7) {
            cell.numFormat = '"₹"#,##0.00';
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF15803D' } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF0FDF4' }
            };
          }
          
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF94A3B8' } },
            bottom: { style: 'double', color: { argb: 'FF1E293B' } }
          };
        } else {
          cell.font = { name: 'Segoe UI', size: 10 };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          
          // Left-align User ID (1) and Name (2)
          if (colNum === 1 || colNum === 2) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          }
          
          // Currency / Number formatting for financial columns (col 3 to 7)
          const currencyCols = [3, 4, 5, 6, 7];
          if (currencyCols.includes(colNum)) {
            const val = Number(cell.value);
            if (!isNaN(val) && cell.value !== "—" && cell.value !== "") {
              cell.numFormat = '"₹"#,##0.00';
            }
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
          }
          
          // Total Weekly Earnings payout cell (Col 7)
          if (colNum === 7) {
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF15803D' } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF0FDF4' }
            };
          }
          
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };
        }
      });
    });
    
    wsSummary.views = [{ showGridLines: true }];
    
    // 3. Build Weekly Payroll Detail Sheet (Monthly Format)
    const wsDetail = workbook.addWorksheet("Weekly Payroll Detail");
    
    const detailHeaders = [
      "Mode of Work", "User ID", "Employee Name", "Basic", "DA", "Other Allowances", 
      "Monthly Wages", "Actual Working days", "Days Worked", "Daily Wages", "LOP Days", "LOP Amount", 
      "OT Hours", "OT Amount", "Travel Time(hrs)", "Travel Time Amount", 
      "Extra Days", "Extra Day Amount", "Missing Days", "Missing Days Amount", 
      "Holidays", "Holiday Amount", "Gross Payable", "Advance Paid", "Net Payable", "Company"
    ];
    
    wsDetail.addRow(detailHeaders);
    
    reportData.forEach(w => {
      wsDetail.addRow([
        w.modeOfWork || "—",
        w.welderId || "—",
        w.welderName,
        "—", // Basic
        "—", // DA
        "—", // Other Allowances
        "—", // Monthly Wages
        "—", // Actual Working days
        w.totalPresentDays, // Days Worked
        w.dailyRate, // Daily Wages
        "—", // LOP Days
        "—", // LOP Amount
        w.totalOtHours, // OT Hours
        w.weeklyOtPay, // OT Amount
        w.totalTravelHours, // Travel Time(hrs)
        w.weeklyTravelPay, // Travel Time Amount
        "—", // Extra Days
        "—", // Extra Day Amount
        "—", // Missing Days
        "—", // Missing Days Amount
        "—", // Holidays
        "—", // Holiday Amount
        w.totalWeeklyEarnings, // Gross Payable
        0.0, // Advance Paid
        w.totalWeeklyEarnings, // Net Payable
        w.company || "—"
      ]);
    });
    
    const lastDetailDataRow = reportData.length + 1;
    const totalDetailRowIndex = reportData.length + 2;
    
    // Add total row
    const totalDetailRowObj = wsDetail.addRow([]);
    totalDetailRowObj.getCell(1).value = "Total";
    totalDetailRowObj.getCell(25).value = { formula: `=SUM(Y2:Y${lastDetailDataRow})` };
    totalDetailRowObj.getCell(26).value = "";
    
    // Auto-fit detail column widths
    wsDetail.columns.forEach(col => {
      let maxLen = 0;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const valStr = cell.value ? String(cell.value) : '';
        if (valStr.length > maxLen) {
          maxLen = valStr.length;
        }
      });
      col.width = Math.max(12, maxLen + 3);
    });
    
    // Style detail header row (row 1)
    const detailHeaderRow = wsDetail.getRow(1);
    detailHeaderRow.height = 28;
    detailHeaderRow.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' } // Dark slate slate/blue #1E293B
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    
    // Style data and total rows in Weekly Payroll Detail
    wsDetail.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      
      const isTotalRow = (rowNum === totalDetailRowIndex);
      row.height = isTotalRow ? 24 : 22;
      
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (isTotalRow) {
          cell.font = { name: 'Segoe UI', size: 10, bold: true };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          
          if (colNum === 1) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          }
          
          if (colNum === 25) {
            cell.numFormat = '"₹"#,##0.00';
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF15803D' } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF0FDF4' }
            };
          }
          
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF94A3B8' } },
            bottom: { style: 'double', color: { argb: 'FF1E293B' } }
          };
        } else {
          cell.font = { name: 'Segoe UI', size: 10 };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          
          // Left-align User ID (2) and Name (3)
          if (colNum === 2 || colNum === 3) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          }
          
          // Currency / Number formatting for financial columns
          const currencyCols = [4, 5, 6, 7, 10, 12, 14, 16, 18, 20, 22, 23, 24, 25];
          if (currencyCols.includes(colNum)) {
            const val = Number(cell.value);
            if (!isNaN(val) && cell.value !== "—" && cell.value !== "") {
              cell.numFormat = '"₹"#,##0.00';
            }
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
          }
          
          // Net Salary payout cell (Col 25)
          if (colNum === 25) {
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF15803D' } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF0FDF4' }
            };
          }
          
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };
        }
      });
    });
    
    wsDetail.views = [{ showGridLines: true }];
    
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Welders_Weekly_Report_${friday}.xlsx`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send("Excel export failed: " + err.message);
  }
});
app.post('/api/payroll/save', (req, res) => {
  try {
    const adj = database.savePayrollAdjustment(req.body);
    res.json({ success: true, adjustment: adj });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Wage-Ready Payroll Export (CSV Generator)
app.get('/api/export', (req, res) => {
  const { startDate, endDate } = req.query;
  
  if (!startDate || !endDate) {
    return res.status(400).send("Both startDate and endDate query parameters are required.");
  }

  try {
    const list = database.getAttendanceForRange(startDate, endDate);
    
    // Sort chronologically (ascending) and alphabetically by name (ascending)
    list.sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
    
    // CSV Columns Header
    let csvContent = "Date,Worker Name,Status,Work Site,Check-In,Check-Out,Total Hours,Full Day Credits,Half Day Credits,Extra Hours (Half-Day),Overtime Hours (Full-Day),Calculated Wage (₹),Message Source,Notes\n";
    
    list.forEach(row => {
      const date = row.date;
      const name = `"${row.employeeName.replace(/"/g, '""')}"`;
      const status = row.status.toUpperCase();
      const site = `"${row.siteName.replace(/"/g, '""')}"`;
      const inTime = row.checkIn ? new Date(row.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—";
      const outTime = row.checkOut ? new Date(row.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—";
      
      const totalHours = row.status === 'absent' ? 0.0 : Number((row.duration / 60).toFixed(2));
      const fullDay = row.isFullDay ? 1 : 0;
      const halfDay = row.isHalfDay ? 1 : 0;
      const extra = row.extraHours || 0.0;
      const ot = row.otHours || 0.0;
      const wage = row.calculatedWage || 0.0;
      const rawText = row.messageText ? `"${row.messageText.replace(/"/g, '""').replace(/\n/g, ' ')}"` : "—";
      
      let note = "";
      if (row.status === 'absent') note = "Absent";
      else if (row.isManualOverride) note = "Manual Overridden Entry";
      else if (row.isFullDay && ot > 0) note = "Standard Shift Completed + OT";
      else if (row.isHalfDay) note = "Half-Day Credit + Extra Hours";
      else if (row.status === 'completed' && !row.isHalfDay && !row.isFullDay) note = "Hourly Pay (Under Half-Day)";
      else if (row.status === 'checked-in') note = "Currently Checked-In (No checkout yet)";
      
      csvContent += `${date},${name},${status},${site},${inTime},${outTime},${totalHours},${fullDay},${halfDay},${extra},${ot},${wage},${rawText},"${note}"\n`;
    });

    const fileDateStr = getLocalDateString();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Attendance_Payroll_Export_${startDate}_to_${endDate}_generated_${fileDateStr}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// Premium Wage-Ready Payroll Export (Excel .xlsx Generator)
app.get('/api/export/excel', (req, res) => {
  const { startDate, endDate, search, status, site } = req.query;
  
  if (!startDate || !endDate) {
    return res.status(400).send("Both startDate and endDate query parameters are required.");
  }

  try {
    let list = database.getAttendanceForRange(startDate, endDate);
    
    // Apply Excel-like filters matching frontend live view
    if (status) {
      list = list.filter(row => row.status.toLowerCase() === status.toLowerCase());
    }
    if (site) {
      list = list.filter(row => row.siteName.toLowerCase() === site.toLowerCase());
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(row => {
        const hoursDecimal = row.status === 'absent' || row.status === 'leave' ? 0.0 : Number((row.duration / 60).toFixed(2));
        let shiftSummary = "—";
        if (row.status === 'completed') {
          if (row.isFullDay) {
            shiftSummary = row.otHours > 0 ? `Full Shift + ${row.otHours} hr OT` : "Full-Day Shift";
          } else if (row.isHalfDay) {
            shiftSummary = row.extraHours > 0 ? `Half Day + ${row.extraHours} hr Ext` : "Half-Day Shift";
          } else {
            shiftSummary = "Hourly Credit";
          }
        } else if (row.status === 'checked-in') {
          shiftSummary = "On Active Duty";
        }

        return (
          row.employeeName.toLowerCase().includes(q) ||
          (row.userId && row.userId.toLowerCase().includes(q)) ||
          row.siteName.toLowerCase().includes(q) ||
          row.status.toLowerCase().includes(q) ||
          shiftSummary.toLowerCase().includes(q) ||
          row.date.includes(q) ||
          hoursDecimal.toString().includes(q)
        );
      });
    }
    
    // Sort chronologically (ascending) and alphabetically by name (ascending)
    list.sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
    
    const excelRows = [];
    
    list.forEach(row => {
      let dayName = "—";
      try {
        dayName = new Date(row.date).toLocaleDateString('en-US', { weekday: 'long' });
      } catch(e) {}

      const inTimeStr = row.checkIn ? new Date(row.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : "—";
      let outTimeStr = "—";
      if (row.checkOut) {
        outTimeStr = new Date(row.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      } else if (row.status === 'checked-in') {
        outTimeStr = "Currently Checked-In";
      }

      const hoursDecimal = row.status === 'absent' || row.status === 'leave' ? 0.0 : Number((row.duration / 60).toFixed(2));

      let note = "";
      if (row.status === 'absent') note = "Absent";
      else if (row.isManualOverride) note = "Manual Overridden Entry";
      else if (row.isFullDay && (row.otHours || 0) > 0) note = "Standard Shift Completed + OT";
      else if (row.isHalfDay) note = "Half-Day Credit + Extra Hours";
      else if (row.status === 'completed' && !row.isHalfDay && !row.isFullDay) note = "Hourly Pay (Under Half-Day)";
      else if (row.status === 'checked-in') note = "Currently Checked-In (No checkout yet)";

      excelRows.push({
        "Date": row.date,
        "Day of Week": dayName,
        "Worker Name": row.employeeName,
        "Duty Status": row.status.toUpperCase(),
        "Work Site Location": row.siteName,
        "Check-In Time": inTimeStr,
        "Check-Out Time": outTimeStr,
        "Total Hours Worked": hoursDecimal,
        "Full-Day Payout Credits": row.isFullDay ? 1 : 0,
        "Half-Day Payout Credits": row.isHalfDay ? 1 : 0,
        "Extra Hours (Post Half-Day)": row.extraHours || 0.0,
        "Overtime Hours (Post Full-Day)": row.otHours || 0.0,
        "Travel Hours Paid": row.travelHours || 0.0,
        "Calculated Wages (₹)": row.calculatedWage || 0.0,
        "WhatsApp Text Source": row.messageText || "—",
        "Administrative Notes": note
      });
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelRows);
    
    // Auto-fit column widths for premium feel!
    if (excelRows.length > 0) {
      const columns = Object.keys(excelRows[0]);
      ws['!cols'] = columns.map(col => {
        const maxCharLen = Math.max(
          col.length,
          ...excelRows.map(row => String(row[col] || '').length)
        );
        return { wch: Math.max(12, maxCharLen + 2) };
      });
    }

    XLSX.utils.book_append_sheet(wb, ws, "Attendance & Wages");
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    const fileDateStr = getLocalDateString();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Attendance_Payroll_Export_${startDate}_to_${endDate}_generated_${fileDateStr}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// Premium Monthly Salary Sheet Excel (.xlsx) Exporter
app.get('/api/export/payroll/excel', async (req, res) => {
  const { month, startDate, endDate, search, mode } = req.query;
  let targetMonth = month || new Date().toISOString().substring(0, 7);

  try {
    let list;
    if (startDate && endDate) {
      list = database.getMonthlySalarySheet(startDate, endDate);
      targetMonth = `${startDate}_to_${endDate}`;
    } else {
      list = database.getMonthlySalarySheet(targetMonth);
    }
    
    // Apply filters matching the live UI view exactly!
    if (mode) {
      list = list.filter(row => row.modeOfWork && row.modeOfWork.toLowerCase().trim() === mode.toLowerCase().trim());
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(row => 
        row.employeeName.toLowerCase().includes(q) ||
        (row.userId && row.userId.toLowerCase().includes(q)) ||
        (row.modeOfWork && row.modeOfWork.toLowerCase().includes(q))
      );
    }
    
    // Group & Sort: Daily Wages Staff first, then Welders, then Office Staff, and finally by User ID
    function getCategoryGroup(modeOfWork) {
      const mode = (modeOfWork || '').toLowerCase();
      if (mode.includes('daily') && mode.includes('wages')) {
        return 1; // Daily Wages Staff
      } else if (mode.includes('welder')) {
        return 2; // Welders
      } else if (mode.includes('office')) {
        return 3; // Office Staff
      } else {
        return 4; // Others
      }
    }

    list.sort((a, b) => {
      const groupA = getCategoryGroup(a.modeOfWork);
      const groupB = getCategoryGroup(b.modeOfWork);
      if (groupA !== groupB) {
        return groupA - groupB;
      }
      const idA = a.userId || "";
      const idB = b.userId || "";
      return idA.localeCompare(idB, undefined, { numeric: true, sensitivity: 'base' });
    });
    
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Salary Sheet ${targetMonth}`);
    
    // Exact Headers as per requested monthly payroll order (removed "No")
    const headers = [
      "Mode of Work", "User ID", "Employee Name", "Basic", "DA", "Other Allowances", 
      "Monthly Wages", "Actual Working days", "Days Worked", "Daily Wages", "LOP Days", "LOP Amount", 
      "OT Hours", "OT Amount", "Travel Time(hrs)", "Travel Time Amount", 
      "Extra Days", "Extra Day Amount", "Missing Days", "Missing Days Amount", 
      "Holidays", "Holiday Amount", "Gross Payable", "Advance Paid", "Net Payable", "Company"
    ];
    
    worksheet.addRow(headers);
    
    // Add row data
    list.forEach((row) => {
      const isOfficeStaff = row.modeOfWork && row.modeOfWork.toLowerCase().trim() === 'office staff';
      const isDaily = !isOfficeStaff;
      
      worksheet.addRow([
        row.modeOfWork || "—",
        row.userId || "—",
        row.employeeName,
        isDaily ? "—" : row.basic,
        isDaily ? "—" : row.da,
        isDaily ? "—" : row.allowances,
        isDaily ? "—" : row.actualSalary,
        isDaily ? "—" : row.stdWorkingDays,
        row.workingDays,
        row.dailyRate,
        isDaily ? "—" : row.lopDays,
        isDaily ? "—" : row.lopAmount,
        row.otHours,
        row.otPayout,
        row.travelTimeHours,
        row.travelTimePayout,
        row.extraDays,
        row.extraDaysAmount,
        row.missingDays,
        row.missingDaysAmount,
        isDaily ? "—" : (row.holidayDaysWorked || 0),
        isDaily ? "—" : (row.holidayBonus || 0.0),
        row.earnedSalary,
        row.salaryAdvance || 0.0,
        row.netSalary,
        row.company || "—"
      ]);
    });

    const lastDataRow = list.length + 1; // data starts at row 2, ends at list.length + 1
    const totalRowIndex = list.length + 2;

    // Append summary row
    const totalRowObj = worksheet.addRow([]);
    totalRowObj.getCell(1).value = "Total";
    totalRowObj.getCell(25).value = { formula: `=SUM(Y2:Y${lastDataRow})` };
    totalRowObj.getCell(26).value = "";
    
    // Auto-fit column widths for premium feel!
    worksheet.columns.forEach(col => {
      let maxLen = 0;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const valStr = cell.value ? String(cell.value) : '';
        if (valStr.length > maxLen) {
          maxLen = valStr.length;
        }
      });
      col.width = Math.max(12, maxLen + 3);
    });
    
    // Style header row (row 1)
    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      
      // Default header fill: dark slate/blue (#1E293B)
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' }
      };
      
      // Border lines
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    
    // Style data and total rows
    worksheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      
      const isTotalRow = (rowNum === totalRowIndex);
      row.height = isTotalRow ? 24 : 22;
      
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (isTotalRow) {
          cell.font = { name: 'Segoe UI', size: 10, bold: true };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          
          if (colNum === 1) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          }
          
          if (colNum === 25) {
            cell.numFormat = '"₹"#,##0.00';
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF15803D' } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF0FDF4' }
            };
          }
          
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF94A3B8' } },
            bottom: { style: 'double', color: { argb: 'FF1E293B' } }
          };
        } else {
          cell.font = { name: 'Segoe UI', size: 10 };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          
          // Left-align User ID (2) and Name (3)
          if (colNum === 2 || colNum === 3) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          }
          
          // Currency / Number formatting for financial columns
          const currencyCols = [4, 5, 6, 7, 10, 12, 14, 16, 18, 20, 22, 23, 24, 25];
          if (currencyCols.includes(colNum)) {
            cell.numFormat = '"₹"#,##0.00';
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
          }
          
          // Elegant light green background and bold green text for the Net Salary payout cell (Col 25)!
          if (colNum === 25) {
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF15803D' } };
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF0FDF4' }
            };
          }
          
          // Thin gray grid borders for all cells
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };
        }
      });
    });
    
    // Force active gridlines explicitly in the viewer
    worksheet.views = [{ showGridLines: true }];
    
    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Salary_Sheet_Export_${targetMonth}_generated_${getLocalDateString()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// --- Socket.io Handlers ---
io.on('connection', (socket) => {
  console.log(`Web client connected (Socket ID: ${socket.id})`);
  
  // Instantly send current states on handshake
  socket.emit('whatsapp_status', whatsapp.status);
  socket.emit('whatsapp_chats', whatsapp.activeChats);
  if (whatsapp.qrCodeDataUrl) {
    socket.emit('whatsapp_qr', whatsapp.qrCodeDataUrl);
  }

  socket.on('disconnect', () => {
    console.log(`Web client disconnected (Socket ID: ${socket.id})`);
  });
});

// Connect WhatsApp Client manager events to socket streamer
whatsapp.on('status', async (status) => {
  io.emit('whatsapp_status', status);
  
  if (status === 'ready') {
    try {
      const client = whatsapp.client;
      const db = database.read();
      let dbUpdated = false;

      if (db.pending_messages) {
        const lidsToResolve = [];
        for (const msg of db.pending_messages) {
          if (msg.sender && msg.sender.length >= 14 && msg.sender.length <= 15 && /^\d+$/.test(msg.sender)) {
            const lidJid = msg.sender + '@lid';
            if (!lidsToResolve.includes(lidJid)) {
              lidsToResolve.push(lidJid);
            }
          }
        }

        if (lidsToResolve.length > 0) {
          console.log(`[Self-Healing] Bulk resolving ${lidsToResolve.length} LIDs for pending messages...`);
          const mappingsMap = {};
          
          try {
            if (client && typeof client.getContactLidAndPhone === 'function') {
              const mappings = await client.getContactLidAndPhone(lidsToResolve);
              if (mappings && mappings.length > 0) {
                mappings.forEach(m => {
                  if (m.lid && m.pn) {
                    const cleanLid = m.lid.split('@')[0];
                    const cleanPn = m.pn.split('@')[0].replace(/\D/g, '');
                    mappingsMap[cleanLid] = cleanPn;
                  }
                });
              }
            }
          } catch (e) {
            console.warn("[Self-Healing] Bulk LID mapping query failed:", e.message);
          }

          // Fallback to sequential getContactById only for those that didn't resolve in bulk
          for (const lidJid of lidsToResolve) {
            const cleanLid = lidJid.split('@')[0];
            if (!mappingsMap[cleanLid]) {
              try {
                const contact = await client.getContactById(lidJid);
                if (contact && contact.number) {
                  mappingsMap[cleanLid] = contact.number;
                }
              } catch (e) {}
            }
          }

          // Apply mapping
          for (const msg of db.pending_messages) {
            if (msg.sender && mappingsMap[msg.sender]) {
              const resolvedPhone = mappingsMap[msg.sender];
              console.log(`[Self-Healing] Resolved pending sender LID ${msg.sender} -> ${resolvedPhone}`);
              whatsapp.lidToPhoneMap[msg.sender] = resolvedPhone;
              msg.sender = resolvedPhone;
              dbUpdated = true;
            }
          }
        }
      }

      if (dbUpdated) {
        database.writeAtomic(db);
        database.syncToExcelAsync();
        
        // Update memory cache
        recentMessages.forEach(msg => {
          if (whatsapp.lidToPhoneMap[msg.sender]) {
            msg.sender = whatsapp.lidToPhoneMap[msg.sender];
          }
        });

        io.emit('pending_updated');
        io.emit('attendance_updated');
        console.log("[Self-Healing] Completed resolution and database sync for pending LIDs.");
      }
    } catch (err) {
      console.error("[Self-Healing] Error resolving pending message LIDs on ready:", err);
    }
  }
});

whatsapp.on('qr', (dataUrl) => {
  io.emit('whatsapp_qr', dataUrl);
});

whatsapp.on('chats_updated', (chats) => {
  io.emit('whatsapp_chats', chats);
});

whatsapp.on('message_received', (data) => {
  addToRecentMessages('parsed', data);
  io.emit('whatsapp_message', data);
  // Broadcast update metrics
  io.emit('stats_updated');
});

whatsapp.on('selfie_received', (selfie) => {
  io.emit('selfie_received', selfie);
  io.emit('stats_updated'); // refresh dashboard counts
});

// Also stream raw messages (unfiltered) to connected clients for realtime feed
whatsapp.on('raw_message', (data) => {
  try {
    const settings = database.getSettings();
    if (!settings || !data) return;

    const targetGroupIds = (settings.whatsappGroupId || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    const targetGroupNames = (settings.whatsappGroupName || '')
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(Boolean);

    // Prefer matching by explicit groupId if the admin has saved it (robust against renames)
    if (targetGroupIds.length > 0 && data.groupId) {
      if (targetGroupIds.includes(data.groupId)) {
        addToRecentMessages('raw', data);
        io.emit('whatsapp_raw', data);
      }
      return;
    }

    // Fallback: match by group name (case-insensitive)
    if (targetGroupNames.length > 0 && data.groupName) {
      if (targetGroupNames.includes(data.groupName.trim().toLowerCase())) {
        addToRecentMessages('raw', data);
        io.emit('whatsapp_raw', data);
      }
    }
    // Otherwise ignore (personal chats or other groups)
  } catch (err) {
    console.error('Error while filtering raw_message for broadcast:', err);
  }
});

// Self-healing LID resolver listener to clean database and memory cache
whatsapp.on('lid_mappings_updated', (mappings) => {
  try {
    console.log("[Self-Healing] Received updated LID mappings. Healing database and cache...");
    const db = database.read();
    let dbUpdated = false;

    // 1. Heal pending messages
    if (db.pending_messages) {
      db.pending_messages.forEach(msg => {
        if (mappings[msg.sender]) {
          console.log(`[Self-Healing] Healing pending message sender: ${msg.sender} -> ${mappings[msg.sender]}`);
          msg.sender = mappings[msg.sender];
          dbUpdated = true;
        }
      });
    }

    if (dbUpdated) {
      database.writeAtomic(db);
      database.syncToExcelAsync();
    }

    // 2. Heal recentMessages memory cache
    recentMessages.forEach(msg => {
      if (mappings[msg.sender]) {
        msg.sender = mappings[msg.sender];
      }
    });

    // Notify clients to refresh
    io.emit('pending_updated');
    io.emit('attendance_updated');
  } catch (err) {
    console.error("[Self-Healing] Error running database healing:", err);
  }
});

// AI Query Endpoint
// Levenshtein distance helper for spelling tolerance
function levenshteinDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[len1][len2];
}

// Typo-tolerant keyword matching function
function hasFuzzyKeyword(query, keywords, threshold = 2) {
  const cleanQuery = query.toLowerCase().trim();
  const words = cleanQuery.split(/\s+/).map(w => w.replace(/[^\w]/g, ''));
  for (const word of words) {
    if (word.length < 3) continue;
    for (const keyword of keywords) {
      if (word.includes(keyword) || keyword.includes(word)) {
        return true;
      }
      if (levenshteinDistance(word, keyword) <= threshold) {
        return true;
      }
    }
  }
  return false;
}

// AI Query Endpoint
app.post('/api/ai/query', (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const cleanQuery = query.toLowerCase().trim();
    const todayStr = getLocalDateString();
    
    // Read current database state
    const db = database.read();
    const employees = db.employees || [];
    const dailyLogs = database.getAttendanceForDate(todayStr) || [];
    
    let steps = [];
    let responseText = "";

    // Helper functions for statuses
    const isPresent = (status) => ['checked-in', 'completed', 'late', 'Late Check-in', 'Early Check-out', 'half-day leave'].includes(status);
    const isLeave = (status) => status === 'leave';
    const isAbsent = (status) => status === 'absent';

    // Define semantic keyword maps for intents
    const presentKeywords = ['present', 'presnt', 'attendance', 'atendance', 'here', 'marked', 'presents'];
    const absentKeywords = ['absent', 'absnt', 'missing', 'absentees', 'away', 'show', 'turned', 'absents'];
    const leaveKeywords = ['leave', 'leve', 'leaves', 'vacation', 'holiday', 'holidays', 'off', 'sick'];
    const payrollKeywords = ['payable', 'payabel', 'payroll', 'salary', 'salry', 'wage', 'wages', 'earnings', 'payout', 'payouts', 'amount', 'pay'];
    const cctvKeywords = ['cctv', 'camera', 'cam', 'cams', 'stream', 'feeds', 'video', 'feed', 'cameras', 'camra'];
    const helpKeywords = ['help', 'guide', 'use', 'check-in', 'clock-in', 'install', 'download', 'website', 'portal', 'features'];

    // 1. Intent: Present Count / Present List
    if (hasFuzzyKeyword(cleanQuery, presentKeywords) && !hasFuzzyKeyword(cleanQuery, absentKeywords)) {
      steps = [
        "Checking today's attendance records...",
        "Identifying marked 'Present' entries...",
        "Counting staff present today...",
        "Putting it all together..."
      ];
      
      const presentLogs = dailyLogs.filter(log => isPresent(log.status));
      const count = presentLogs.length;
      
      if (count === 0) {
        responseText = `**No staff members are marked present today yet.**`;
      } else {
        const names = presentLogs.map(log => log.employeeName);
        let nameList = "";
        if (names.length <= 10) {
          nameList = names.join(", ");
        } else {
          nameList = names.slice(0, 10).join(", ") + ` and ${names.length - 10} others`;
        }
        responseText = `**${count} staff members are present today.**\n\nPresent: ${nameList}.`;
      }
    }
    // 2. Intent: Absent / Who didn't show up
    else if (hasFuzzyKeyword(cleanQuery, absentKeywords) || cleanQuery.includes("didn't show up") || cleanQuery.includes("did not show up") || cleanQuery.includes("no show")) {
      steps = [
        "Checking today's attendance records...",
        "Filtering absent employees...",
        "Compiling absent list...",
        "Putting it all together..."
      ];
      
      // Filter active employees
      const activeEmployees = employees.filter(emp => emp.status === 'active');
      // Find who is absent or not in logs
      const presentIds = new Set(dailyLogs.filter(log => isPresent(log.status)).map(log => log.employeeId));
      const leaveIds = new Set(dailyLogs.filter(log => isLeave(log.status)).map(log => log.employeeId));
      
      const absentEmployees = activeEmployees.filter(emp => !presentIds.has(emp.id) && !leaveIds.has(emp.id));
      const count = absentEmployees.length;
      
      if (count === 0) {
        responseText = `**Everyone showed up today! No staff members are absent.**`;
      } else {
        const names = absentEmployees.map(emp => emp.name);
        let nameList = "";
        if (names.length <= 10) {
          nameList = names.join(", ");
        } else {
          nameList = names.slice(0, 10).join(", ") + ` and ${names.length - 10} others`;
        }
        responseText = `**${count} staff members didn't show up today.**\n\nAbsent: ${nameList}.`;
      }
    }
    // 3. Intent: Leave count / Who is on leave
    else if (hasFuzzyKeyword(cleanQuery, leaveKeywords)) {
      steps = [
        "Checking today's leave records...",
        "Identifying approved leaves...",
        "Putting it all together..."
      ];
      
      const leaveLogs = dailyLogs.filter(log => isLeave(log.status));
      const count = leaveLogs.length;
      
      if (count === 0) {
        responseText = `**No staff members are on leave today.**`;
      } else {
        const names = leaveLogs.map(log => log.employeeName);
        let nameList = "";
        if (names.length <= 10) {
          nameList = names.join(", ");
        } else {
          nameList = names.slice(0, 10).join(", ") + ` and ${names.length - 10} others`;
        }
        responseText = `**${count} staff members are on leave today.**\n\nOn Leave: ${nameList}.`;
      }
    }
    // 4. Intent: Payroll / Payable this month
    else if (hasFuzzyKeyword(cleanQuery, payrollKeywords)) {
      const monthStr = today.toISOString().substring(0, 7); // e.g. "2026-06"
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const currentMonthName = monthNames[today.getMonth()] + " " + today.getFullYear();
      
      steps = [
        "Fetching monthly payroll records...",
        "Calculating wage details and deductions...",
        "Aggregating net payable salary...",
        "Putting it all together..."
      ];
      
      const payrollData = database.getMonthlySalarySheet(monthStr);
      const totalPayable = payrollData.summary ? payrollData.summary.totalPayable : 0;
      const totalAdvances = payrollData.summary ? (payrollData.summary.totalAdvances || 0) : 0;
      const totalNetPayable = payrollData.summary ? payrollData.summary.totalNetPayable : 0;
      
      responseText = `**Total net payable salary for this month (${currentMonthName}) is ₹${totalNetPayable.toLocaleString('en-IN')}.**\n\n**Breakdown:**\n• Gross Wages: ₹${totalPayable.toLocaleString('en-IN')}\n• Deductions/Advances: ₹${totalAdvances.toLocaleString('en-IN')}\n• Net Payable: ₹${totalNetPayable.toLocaleString('en-IN')}`;
    }
    // 5. Intent: CCTV camera status
    else if (hasFuzzyKeyword(cleanQuery, cctvKeywords)) {
      steps = [
        "Querying active CCTV stream threads...",
        "Checking camera connection status...",
        "Putting it all together..."
      ];
      
      const cameras = db.cctvCameras || [];
      const activeCount = cameras.filter(c => c.status !== 'inactive').length;
      
      responseText = `**CCTV System Status:**\n\nCurrently, there are **${activeCount} active camera feed(s)** configured in the workspace:\n` +
                     cameras.map(c => `• **${c.name}**: ${c.eventType.toUpperCase()} feed (${c.source})`).join("\n");
    }
    // 6. Intent: Help / Website FAQ
    else if (hasFuzzyKeyword(cleanQuery, helpKeywords) || cleanQuery.includes("how to") || cleanQuery.includes("features")) {
      steps = [
        "Searching website user manual...",
        "Gathering platform guidelines...",
        "Putting it all together..."
      ];
      responseText = `Here is a guide on how to navigate and use the **InterExt Attendance Portal**:\n\n` +
                     `1. **CCTV Attendance**: Real-time entry/exit logs are automatically marked by the AI streams under the **Camera Attendance** tab. No manual log required!\n` +
                     `2. **Master Sheet Logs**: Navigate to **Attendance Log** to manually edit shifts, wages, and download comprehensive summaries.\n` +
                     `3. **Payroll Settings**: View monthly breakdowns of gross salary, salary advances, and net payable payouts under the **Payroll** tab.\n` +
                     `4. **Android APK Download**: Download the companion Android Face Check-In App from the **Settings** panel link.\n` +
                     `5. **Chatbot Commands**: You can query me anytime for present lists, absentees, leaves, and payroll breakdown totals!`;
    }
    // Default fallback
    else {
      steps = [
        "Analyzing search parameters...",
        "Putting it all together..."
      ];
      responseText = `Hello! I'm **InterExt AI**, your dedicated virtual assistant. I didn't quite catch that, but I can help you with details about the attendance tracker!\n\nTry asking me:\n` +
                     `• *How many staff members are present today?* (or "presnt count")\n` +
                     `• *Who is absent today?* (or "absnt list")\n` +
                     `• *Are any employees on leave?*\n` +
                     `• *What is the net payable payroll amount?*\n` +
                     `• *Show CCTV stream status*\n` +
                     `• *How to use the website portal?*`;
    }

    res.json({
      success: true,
      steps: steps,
      response: responseText
    });
  } catch (err) {
    console.error("[AI Chatbot] Error resolving query:", err);
    res.status(500).json({ error: "Internal server error: " + err.message });
  }
});

// Catch errors and log to ensure 24/7 unbreakable keep-alive
process.on('uncaughtException', (err) => {
  console.error("[CRITICAL] Uncaught exception inside server process:", err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("[CRITICAL] Unhandled promise rejection at:", promise, "reason:", reason);
});

let isShuttingDownServer = false;
const gracefulServerShutdown = async (signal) => {
  if (isShuttingDownServer) return;
  isShuttingDownServer = true;
  console.log(`\n[Process Shutdown] Server received signal: ${signal}. Shutting down services gracefully...`);
  try {
    await whatsapp.destroy();
    console.log("[Process Shutdown] Server graceful shutdown complete.");
  } catch (err) {
    console.error("[Process Shutdown] Error during server shutdown:", err.message);
  }
  if (signal === 'SIGUSR2') {
    process.kill(process.pid, 'SIGUSR2');
  } else {
    process.exit(0);
  }
};

process.once('SIGINT', () => gracefulServerShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulServerShutdown('SIGTERM'));
process.once('SIGUSR2', () => gracefulServerShutdown('SIGUSR2'));

// Boot systems
server.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`  Attendance Dashboard running at: http://localhost:${PORT}`);
  console.log(`=============================================================`);
  console.log(`\n⚡ 24/7 CONTINUOUS MONITORING ACTIVATED ⚡`);
  console.log(`  • Health Check: Every 2 minutes`);
  console.log(`  • KeepAlive Ping: Every 3 minutes`);
  console.log(`  • Stale Session Detection: After 25 minutes of inactivity`);
  console.log(`  • Auto-Reconnect: On any connection failure`);
  console.log(`  \n🔒 CRITICAL: Keep this process running 24/7!`);
  console.log(`  Use PM2 to keep the server alive: npm install -g pm2 && pm2 start server.js --name attendance`);
  console.log(``);
  
  // Start WhatsApp Client integration
  whatsapp.initialize();

  // Auto-start active CCTV camera streams on boot
  try {
    const cameras = database.getCctvCameras();
    const db = database.read();
    const activeCams = cameras.filter(cam => cam.status === 'active');
    
    activeCams.forEach(async (cam) => {
      try {
        const site = (db.sites || []).find(s => s.id === cam.siteId);
        const siteName = site ? site.name : 'Office';
        
        console.log(`[CCTV Boot] Starting stream thread for active camera: ${cam.name}`);
        await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            camera_id: cam.id,
            name: cam.name,
            source: cam.source,
            site_name: siteName,
            event_type: cam.eventType,
            threshold: 0.52
          })
        });
      } catch (err) {
        console.warn(`[CCTV Boot] Failed to auto-start stream for ${cam.name}: ${err.message}`);
      }
    });
  } catch (err) {
    console.error("[CCTV Boot] Failed to auto-start cameras list:", err);
  }

  // Run initial daily closeout sweep to finalize any outstanding shifts from previous days
  try {
    const closed = database.autoCloseOutstandingShifts();
    if (closed > 0) {
      console.log(`[Startup Sweep] Finalized ${closed} outstanding shifts.`);
    }
  } catch (e) {
    console.error("Initial daily closeout failed:", e);
  }

  // Schedule daily closeout sweep once every hour
  setInterval(() => {
    try {
      const closed = database.autoCloseOutstandingShifts();
      if (closed > 0) {
        io.emit('stats_updated');
        io.emit('attendance_updated');
        console.log(`[Hourly Sweep] Auto-closed ${closed} outstanding shifts.`);
      }
    } catch (e) {
      console.error("Scheduled closeout sweep failed:", e);
    }
  }, 60 * 60 * 1000); // 1 hour

  // ── Python API Watchdog ─────────────────────────────────────────────────────
  // Polls every 15 seconds. If the Python API was offline and just came back,
  // or if fewer cameras are running than should be, re-sends start commands.
  let _apiWasOffline = false;
  setInterval(async () => {
    try {
      const resp = await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/status`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) { _apiWasOffline = true; return; }
      const statusData = await resp.json();
      const runningIds = new Set(Object.keys(statusData.cameras || {}));

      const cameras = database.getCctvCameras();
      const db = database.read();
      const activeCams = cameras.filter(cam => cam.status === 'active');
      const missingCams = activeCams.filter(cam => !runningIds.has(cam.id));

      if (_apiWasOffline || missingCams.length > 0) {
        if (_apiWasOffline) {
          console.log('[API Watchdog] Python API came back online — re-starting all cameras...');
        } else {
          console.log(`[API Watchdog] ${missingCams.length} camera(s) missing — re-starting them...`);
        }
        _apiWasOffline = false;

        for (const cam of missingCams.length > 0 ? missingCams : activeCams) {
          try {
            const site = (db.sites || []).find(s => s.id === cam.siteId);
            const siteName = site ? site.name : 'Office';
            await fetch(`${FACE_RECOGNITION_SERVICE}/api/cctv/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                camera_id: cam.id,
                name: cam.name,
                source: cam.source,
                site_name: siteName,
                event_type: cam.eventType,
                threshold: 0.52
              }),
              signal: AbortSignal.timeout(5000)
            });
            console.log(`[API Watchdog] Restarted camera: ${cam.name}`);
          } catch (e) {
            console.warn(`[API Watchdog] Failed to restart ${cam.name}: ${e.message}`);
          }
        }
      }
    } catch (err) {
      // API is down/unreachable
      if (!_apiWasOffline) {
        console.warn('[API Watchdog] Python API is offline. Will retry...');
      }
      _apiWasOffline = true;
    }
  }, 15 * 1000); // every 15 seconds
  // ───────────────────────────────────────────────────────────────────────────
});

