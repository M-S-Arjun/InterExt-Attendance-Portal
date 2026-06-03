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

app.use(express.static(path.join(__dirname, 'public')));

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
  const todayStr = new Date().toISOString().split('T')[0];
  const employees = database.getEmployees();
  const activeEmpCount = employees.filter(e => e.status === 'active').length;
  const attendanceToday = database.getAttendanceForDate(todayStr);
  
  const presentCount = attendanceToday.filter(a => a.status === 'checked-in' || a.status === 'completed').length;
  const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
  const pendingCount = database.getPendingMessages().length;

  res.json({
    totalEmployees: activeEmpCount,
    presentToday: presentCount,
    absentToday: absentCount,
    pendingExceptions: pendingCount
  });
});

// Force Refresh Active Groups
app.post('/api/chats/refresh', async (req, res) => {
  const chats = await whatsapp.refreshChats();
  res.json(chats);
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

// Settings CRUD
app.get('/api/settings', (req, res) => {
  res.json(database.getSettings());
});

app.post('/api/settings', (req, res) => {
  const settings = database.saveSettings(req.body);
  if (whatsapp && typeof whatsapp.resolveGroupId === 'function') {
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
    const emp = database.saveEmployee(req.body);
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
  
  const targetDate = date || new Date().toISOString().split('T')[0];
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
  const events = database.getCameraEvents();
  const sorted = [...events].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(sorted);
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

    const eventDate = new Date(timestamp).toISOString().split('T')[0];
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

// Recognize face from camera image
app.post('/api/face/recognize', async (req, res) => {
  try {
    const { imageBase64, threshold, latitude, longitude } = req.body;
    
    if (!imageBase64) {
      return res.status(400).json({ success: false, status: "rejected", message: 'imageBase64 required' });
    }
    
    const formData = new URLSearchParams();
    formData.append('image_base64', imageBase64);
    if (threshold) formData.append('threshold', threshold);

    
    let data;
    try {
      const response = await fetch(`${FACE_RECOGNITION_SERVICE}/api/face/recognize`, {
        method: 'POST',
        body: formData,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      data = await response.json();
    } catch (fetchErr) {
      console.error('[API] Face recognition service fetch failed:', fetchErr.message);
      return res.status(503).json({
        success: false,
        status: "rejected",
        message: "Face recognition service unavailable"
      });
    }
    
    if (data.success && data.matched) {
      // Face recognized - auto-create attendance event
      const db = database.read();
      let employee = db.employees?.find(e => e.id === data.employee_id);
      if (!employee) {
        // Fallback: match by directory name format (lowercase with underscores)
        employee = db.employees?.find(e => {
          if (!e.name) return false;
          const cleanDbName = e.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').trim();
          const cleanInputName = data.employee_id.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').trim();
          return cleanDbName === cleanInputName || 
                 cleanDbName.replace(/_/g, '') === cleanInputName.replace(/_/g, '') || 
                 cleanDbName.includes(cleanInputName) || 
                 cleanInputName.includes(cleanDbName);
        });
      }
      
      if (employee) {
        const now = new Date();
        const timestamp = now.toISOString();
        const eventDate = timestamp.split('T')[0];
        
        // Determine if this is check-in or check-out based on existing attendance
        const existingAttendance = (db.attendance || []).find(
          a => a.employeeId === employee.id && a.date === eventDate
        );
        
        // Duplicate attendance prevention
        if (existingAttendance) {
          if (existingAttendance.status === 'completed' || existingAttendance.status === 'leave') {
            return res.status(400).json({
              success: false,
              status: "rejected",
              message: "Attendance already completed or marked leave for today"
            });
          }
          // If check-in exists, we're performing a check-out. Prevent duplicate double-clicks within 30s.
          if (existingAttendance.checkIn) {
            const checkInTime = new Date(existingAttendance.checkIn);
            const diffSeconds = (now - checkInTime) / 1000;
            if (diffSeconds < 30) {
              return res.status(400).json({
                success: false,
                status: "rejected",
                message: "Duplicate scan detected. Please wait 30 seconds."
              });
            }
          }
        }
        
        const eventType = existingAttendance && existingAttendance.checkIn ? 'exit' : 'entry';
        
        // Geofencing verification
        let siteName = 'Webcam Scan';
        let siteId = '';
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
              siteId = closestSite.id;
              siteName = closestSite.name;
            } else {
              siteName = `Off-Site (${closestSite.name})`;
            }
          }
        }
        
        // Save webcam recognition as a camera event log
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
        
        const attendanceEntry = {
          employeeId: employee.id,
          employeeName: employee.name,
          date: eventDate,
          siteName: siteName,
          messageText: `Face recognized - auto ${eventType}`,
          facialRecognitionMatch: true,
          matchConfidence: data.confidence,
          latitude: latitude ? Number(latitude) : undefined,
          longitude: longitude ? Number(longitude) : undefined,
          verificationMethod: 'Face Recognition',
          notes: distance !== null && distance > 200 
            ? `[FLAGGED LOCATION] Off-Site Scan (${Math.round(distance)}m)` 
            : `Face recognized`
        };
        
        if (eventType === 'entry') {
          attendanceEntry.checkIn = timestamp;
          if (existingAttendance?.checkOut) {
            attendanceEntry.id = existingAttendance.id;
            attendanceEntry.checkOut = existingAttendance.checkOut;
          }
        } else {
          if (existingAttendance?.checkIn) {
            attendanceEntry.id = existingAttendance.id;
            attendanceEntry.checkIn = existingAttendance.checkIn;
          }
          attendanceEntry.checkOut = timestamp;
        }
        
        const savedAttendance = database.saveAttendance(attendanceEntry);
        io.emit('attendance_updated', savedAttendance);
        io.emit('camera_event_recorded', savedEvent);
        
        return res.json({
          success: true,
          status: "accepted",
          employee_id: employee.id,
          message: "Attendance marked successfully",
          // Keep compatibility fields
          recognized: true,
          employee: { id: employee.id, name: employee.name },
          confidence: data.confidence,
          attendance: savedAttendance,
          eventType: eventType
        });
      }
    }
    
    // Handle specific validation/model errors returned by python Flask service
    const errorMessage = data.error || "Face not recognized";
    return res.json({
      success: false,
      status: "rejected",
      message: errorMessage
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
    const { imagesDir } = req.body;
    
    if (!imagesDir) {
      return res.status(400).json({ error: 'imagesDir required' });
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

// GET CCTV Cameras list
app.get('/api/cctv', (req, res) => {
  try {
    const cameras = database.getCctvCameras();
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
            threshold: 0.55
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
    const { employee_id, confidence, camera_id, camera_name, site_name, event_type, image_base64 } = req.body;
    
    const db = database.read();
    let employee = db.employees?.find(e => e.id === employee_id);
    if (!employee) {
      // Fallback fuzzy resolver
      employee = db.employees?.find(e => {
        if (!e.name) return false;
        const cleanDbName = e.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').trim();
        const cleanInputName = employee_id.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').trim();
        return cleanDbName === cleanInputName || 
               cleanDbName.replace(/_/g, '') === cleanInputName.replace(/_/g, '') || 
               cleanDbName.includes(cleanInputName) || 
               cleanInputName.includes(cleanDbName);
      });
    }
    
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
    
    let resolvedEventType = event_type;
    if (resolvedEventType === 'auto') {
      resolvedEventType = existingAttendance && existingAttendance.checkIn ? 'exit' : 'entry';
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
      status: 'recognized'
    };
    
    const savedEvent = database.saveCameraEvent(cameraEvent);
    
    // 2. Record attendance entry
    const attendanceEntry = {
      employeeId: employee.id,
      employeeName: employee.name,
      date: eventDate,
      siteName: site_name || 'CCTV Camera',
      messageText: `CCTV Face recognized - auto ${resolvedEventType}`,
      facialRecognitionMatch: true,
      matchConfidence: confidence
    };
    
    if (resolvedEventType === 'entry') {
      attendanceEntry.checkIn = timestamp;
      if (existingAttendance?.checkOut) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkOut = existingAttendance.checkOut;
      }
    } else {
      if (existingAttendance?.checkIn) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkIn = existingAttendance.checkIn;
      }
      attendanceEntry.checkOut = timestamp;
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
    const targetDate = date || new Date().toISOString().split('T')[0];
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
      const targetDate = date || new Date().toISOString().split('T')[0];
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
        matchedEmployee: emp
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
  const { month } = req.query;
  const targetMonth = month || new Date().toISOString().substring(0, 7); // e.g. "2026-03"
  res.json(database.getMonthlySalarySheet(targetMonth));
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

    const fileDateStr = new Date().toISOString().split('T')[0];
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
    
    const fileDateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Attendance_Payroll_Export_${startDate}_to_${endDate}_generated_${fileDateStr}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// Premium Monthly Salary Sheet Excel (.xlsx) Exporter
app.get('/api/export/payroll/excel', async (req, res) => {
  const { month, search, mode } = req.query;
  const targetMonth = month || new Date().toISOString().substring(0, 7);

  try {
    let list = database.getMonthlySalarySheet(targetMonth);
    
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
    
    // Sort alphabetically by worker name
    list.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
    
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Salary Sheet ${targetMonth}`);
    
    // Exact Headers as per Excel screenshot with Holiday Days and Holiday Bonus
    const headers = [
      "No", "Employee ID", "Name", "Std Working days", "Basic", "DA", "Other Allowances", 
      "Gross Salary", "Working Days", "amount", "LOP(Day)", "LOP( Amount)", 
      "OT(Hrs)", "OT(Amount)", "Travel Time(Hrs)", "Travel Time( Amount)", 
      "Extra days", "Extra days Amount", "Missing days", "Missing days(Amount)", 
      "Holiday Days", "Holiday Bonus (₹)", "Earned Salary", "PF", "ESIC", "PT", "Net Salary"
    ];
    
    worksheet.addRow(headers);
    
    // Add row data
    list.forEach((row, idx) => {
      worksheet.addRow([
        idx + 1,
        row.userId || "—",
        row.employeeName,
        row.stdWorkingDays,
        row.basic,
        row.da,
        row.allowances,
        row.actualSalary,
        row.workingDays,
        row.amount,
        row.lopDays,
        row.lopAmount,
        row.otHours,
        row.otPayout,
        row.travelTimeHours,
        row.travelTimePayout,
        row.extraDays,
        row.extraDaysAmount,
        row.missingDays,
        row.missingDaysAmount,
        row.holidayDaysWorked || 0,
        row.holidayBonus || 0.0,
        row.earnedSalary,
        row.pf || 0,
        row.esic || 0,
        row.pt || 0,
        row.netSalary
      ]);
    });
    
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
    
    // Style data rows
    worksheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      
      row.height = 22;
      row.eachCell((cell, colNum) => {
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        
        // Left-align employee ID (2) and Name (3)
        if (colNum === 2 || colNum === 3) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
        
        // Currency / Number formatting for financial columns
        const currencyCols = [5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 21, 22, 23, 24, 25];
        if (currencyCols.includes(colNum)) {
          cell.numFormat = '"₹"#,##0.00';
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
        }
        
        // Elegant light green background and bold green text for the Net Salary payout cell!
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
      });
    });
    
    // Force active gridlines explicitly in the viewer
    worksheet.views = [{ showGridLines: true }];
    
    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Salary_Sheet_Export_${targetMonth}_generated_${new Date().toISOString().split('T')[0]}.xlsx"`);
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
        for (const msg of db.pending_messages) {
          // Check if sender looks like a LID (e.g. 14 or 15-digit numeric string)
          if (msg.sender && msg.sender.length >= 14 && msg.sender.length <= 15 && /^\d+$/.test(msg.sender)) {
            const lidJid = msg.sender + '@lid';
            console.log(`[Self-Healing] Resolving JID for pending message sender LID: ${lidJid}...`);
            let resolvedPhone = null;

            try {
              if (client && typeof client.getContactLidAndPhone === 'function') {
                const mappings = await client.getContactLidAndPhone([lidJid]);
                if (mappings && mappings.length > 0 && mappings[0].pn) {
                  resolvedPhone = mappings[0].pn.split('@')[0];
                }
              }
            } catch (e) {}

            if (!resolvedPhone) {
              try {
                const contact = await client.getContactById(lidJid);
                if (contact && contact.number) {
                  resolvedPhone = contact.number;
                }
              } catch (e) {}
            }

            if (resolvedPhone) {
              console.log(`[Self-Healing] Resolved pending sender LID ${msg.sender} -> ${resolvedPhone}`);
              
              // Map in server memory cache mapping table
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

    // Prefer matching by explicit groupId if the admin has saved it (robust against renames)
    if (settings.whatsappGroupId && data.groupId) {
      if (settings.whatsappGroupId === data.groupId) {
        addToRecentMessages('raw', data);
        io.emit('whatsapp_raw', data);
      }
      return;
    }

    // Fallback: match by group name (case-insensitive)
    if (settings.whatsappGroupName && data.groupName) {
      if (data.groupName.trim().toLowerCase() === settings.whatsappGroupName.trim().toLowerCase()) {
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

// Catch errors and log to ensure 24/7 unbreakable keep-alive
process.on('uncaughtException', (err) => {
  console.error("[CRITICAL] Uncaught exception inside server process:", err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("[CRITICAL] Unhandled promise rejection at:", promise, "reason:", reason);
});

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
});

