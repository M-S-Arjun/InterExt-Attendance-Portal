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

const FACE_RECOGNITION_MIN_CONFIDENCE = 0.51;

function getLocalDateString(dateInput = new Date()) {
  const d = new Date(dateInput);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseTargetDateFromQuery(query, referenceDate = new Date()) {
  const cleanQuery = query.toLowerCase().trim();
  
  // Yesterday
  if (cleanQuery.includes('yesterday') || cleanQuery.includes('yestoday') || cleanQuery.includes('yestrday')) {
    const yesterday = new Date(referenceDate);
    yesterday.setDate(referenceDate.getDate() - 1);
    return { dateStr: getLocalDateString(yesterday), label: 'yesterday' };
  }
  
  // Today
  if (cleanQuery.includes('today') || cleanQuery.includes('toddy') || cleanQuery.includes('tody')) {
    return { dateStr: getLocalDateString(referenceDate), label: 'today' };
  }

  // Day before yesterday
  if (cleanQuery.includes('day before yesterday')) {
    const dby = new Date(referenceDate);
    dby.setDate(referenceDate.getDate() - 2);
    return { dateStr: getLocalDateString(dby), label: 'day before yesterday' };
  }
  
  // Look for direct date matches in query: YYYY-MM-DD
  const yyyymmddRegex = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/;
  const matchYmd = cleanQuery.match(yyyymmddRegex);
  if (matchYmd) {
    const y = parseInt(matchYmd[1], 10);
    const m = String(matchYmd[2]).padStart(2, '0');
    const d = String(matchYmd[3]).padStart(2, '0');
    return { dateStr: `${y}-${m}-${d}`, label: `on ${y}-${m}-${d}` };
  }

  // Look for DD-MM-YYYY or DD/MM/YYYY or DD-MM-YY
  const ddmmyyyyRegex = /(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})/;
  const matchDmy = cleanQuery.match(ddmmyyyyRegex);
  if (matchDmy) {
    const d = String(matchDmy[1]).padStart(2, '0');
    const m = String(matchDmy[2]).padStart(2, '0');
    let y = matchDmy[3];
    if (y.length === 2) {
      y = '20' + y;
    }
    return { dateStr: `${y}-${m}-${d}`, label: `on ${d}-${m}-${y}` };
  }

  // Look for month names and days, e.g. "june 25", "25th june", "july 1st", "1 july"
  const monthsList = [
    { name: 'january', abbr: 'jan', val: 0 },
    { name: 'february', abbr: 'feb', val: 1 },
    { name: 'march', abbr: 'mar', val: 2 },
    { name: 'april', abbr: 'apr', val: 3 },
    { name: 'may', abbr: 'may', val: 4 },
    { name: 'june', abbr: 'jun', val: 5 },
    { name: 'july', abbr: 'jul', val: 6 },
    { name: 'august', abbr: 'aug', val: 7 },
    { name: 'september', abbr: 'sep', val: 8 },
    { name: 'october', abbr: 'oct', val: 9 },
    { name: 'november', abbr: 'nov', val: 10 },
    { name: 'december', abbr: 'dec', val: 11 }
  ];

  for (const mObj of monthsList) {
    if (cleanQuery.includes(mObj.name) || cleanQuery.includes(mObj.abbr)) {
      const dayMatches = cleanQuery.match(/\b(\d{1,2})(st|nd|rd|th)?\b/g);
      if (dayMatches) {
        for (const dm of dayMatches) {
          const dayNum = parseInt(dm, 10);
          if (dayNum >= 1 && dayNum <= 31) {
            const target = new Date(referenceDate);
            target.setMonth(mObj.val);
            target.setDate(dayNum);
            if (target > referenceDate) {
              target.setFullYear(referenceDate.getFullYear() - 1);
            }
            const monthName = target.toLocaleDateString('en-US', { month: 'long' });
            return { dateStr: getLocalDateString(target), label: `on ${dayNum} ${monthName}` };
          }
        }
      }
    }
  }

  // Weekdays (e.g. "on monday", "last tuesday")
  const weekdays = {
    sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
    thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
  };
  for (const [dayName, dayVal] of Object.entries(weekdays)) {
    if (cleanQuery.includes(dayName)) {
      const target = new Date(referenceDate);
      const currentDay = referenceDate.getDay();
      let diff = currentDay - dayVal;
      if (diff <= 0) {
        diff += 7;
      }
      target.setDate(referenceDate.getDate() - diff);
      return { dateStr: getLocalDateString(target), label: `last ${dayName}` };
    }
  }

  return { dateStr: getLocalDateString(referenceDate), label: 'today' };
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

// Disable caching for API endpoints to prevent stale data retrieval on manual/automatic refresh
app.use('/api', (req, res, next) => {
  res.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.header("Pragma", "no-cache");
  res.header("Expires", "0");
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
    reqPath.startsWith('/uploads') ||
    reqPath === '/api/face/cctv-event' ||
    reqPath.startsWith('/api/debug')
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

// Serve static files with long cache for immutable assets (JS libs, icons, images)
// These files don't change between requests so browsers should cache them aggressively.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',              // Cache static assets for 7 days
  etag: true,               // Enable ETag for validation
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML files must not be cached so refreshed UI is always served
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    // Large immutable JS/CSS/image bundles: cache for 7 days
    else if (
      filePath.endsWith('.js') ||
      filePath.endsWith('.css') ||
      filePath.endsWith('.png') ||
      filePath.endsWith('.jpg') ||
      filePath.endsWith('.ico') ||
      filePath.endsWith('.woff2') ||
      filePath.endsWith('.woff')
    ) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    }
  }
}));

// --- Server-side in-memory response cache for expensive read-only endpoints ---
const _responseCache = new Map(); // key -> { data, ts }
function getCached(key, ttlMs, producer) {
  const hit = _responseCache.get(key);
  if (hit && (Date.now() - hit.ts) < ttlMs) return hit.data;
  const data = producer();
  _responseCache.set(key, { data, ts: Date.now() });
  return data;
}
function invalidateCache(...keys) {
  keys.forEach(k => _responseCache.delete(k));
}

// Serve Employee Mobile Self-Service Portal at /mobile
app.use('/mobile', express.static(path.join(__dirname, 'mobile_dist')));
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile_dist', 'index.html'));
});

// --- Employee Mobile App Authentication & APIs ---

// Active Employee Session Cache
const activeEmployeeSessions = new Map();

function requireEmployeeAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const employeeToken = cookies['employee_token'];
  if (employeeToken && activeEmployeeSessions.has(employeeToken)) {
    req.employeeId = activeEmployeeSessions.get(employeeToken);
    return next();
  }
  
  // Custom header authorization fallback for native mobile requests
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (activeEmployeeSessions.has(token)) {
      req.employeeId = activeEmployeeSessions.get(token);
      return next();
    }
  }

  res.status(401).json({ error: "Unauthorized. Employee login required." });
}

// Employee Login Endpoint
app.post('/api/employee/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Employee ID and password are required." });
    }
    const db = database.read();
    const employee = db.employees.find(e => e && e.userId === username);
    if (!employee) {
      return res.status(401).json({ error: "Invalid Employee ID or password." });
    }
    
    let isValid = false;
    if (!employee.password) {
      isValid = (password === "1234");
    } else {
      isValid = bcrypt.compareSync(password, employee.password);
    }
    
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Employee ID or password." });
    }

    if (employee.status !== 'active') {
      return res.status(401).json({ error: "Access denied. Employee profile is inactive." });
    }
    
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeEmployeeSessions.set(token, employee.id);
    
    res.cookie('employee_token', token, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
    res.json({
      success: true,
      token: token,
      employee: {
        id: employee.id,
        userId: employee.userId,
        name: employee.name,
        designation: employee.designation || "Staff"
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee Change Password Endpoint
app.post('/api/employee/change-password', requireEmployeeAuth, (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "Old and new passwords are required." });
    }
    
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === req.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }
    
    let isValid = false;
    const currentPasscode = String(employee.passcode || '1234');
    if (oldPassword === currentPasscode) {
      isValid = true;
    } else if (employee.password && bcrypt.compareSync(oldPassword, employee.password)) {
      isValid = true;
    }
    
    if (!isValid) {
      return res.status(400).json({ error: "Incorrect current password." });
    }
    
    employee.password = bcrypt.hashSync(newPassword, 10);
    employee.passcode = String(newPassword).trim();
    database.writeAtomic(db);
    database.syncToExcelAsync();
    
    res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee Dashboard combined data Endpoint
app.get('/api/employee/dashboard-data', requireEmployeeAuth, (req, res) => {
  try {
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === req.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }

    const todayStr = getLocalDateString();
    
    // Fetch employee attendance logs (full history)
    const fullAttendanceLogs = (db.attendance || []).filter(
      a => a.employeeId === employee.id
    );
    fullAttendanceLogs.sort((a, b) => b.date.localeCompare(a.date));
    
    const currentMonthPrefix = new Date().toISOString().substring(0, 7);
    const currentMonthLogs = fullAttendanceLogs.filter(a => a.date.startsWith(currentMonthPrefix));
    
    // Helper function to check if a status is present
    const isPresent = (status, checkIn) => ['checked-in', 'completed', 'Late Check-in', 'Early Check-out', 'half-day leave'].includes(status) || (status === 'late' && checkIn);

    // Sum worked days, late days, OT hours for current month
    const workedDays = currentMonthLogs.filter(a => isPresent(a.status, a.checkIn)).length;
    const lateDays = currentMonthLogs.filter(a => a.isLate === true || a.status === 'late' || a.status === 'Late Check-in').length;
    const otHoursSum = currentMonthLogs.reduce((sum, a) => sum + (Number(a.otHours) || 0), 0);
    
    // Active loans and balance
    const loans = employee.loans || [];
    const activeLoans = loans.filter(l => l.status === 'active');
    const totalLoanBalance = activeLoans.reduce((sum, l) => sum + (Number(l.balance) || 0), 0);
    
    // Leaves summary
    const leaveApplications = employee.leaveApplications || [];
    const approvedLeavesCount = leaveApplications.filter(l => l.status === 'approved').length;
    // Also include daily attendance marked as 'leave'
    const markedLeavesCount = (db.attendance || []).filter(
      a => a.employeeId === employee.id && a.status === 'leave' && a.date.startsWith(currentMonthPrefix)
    ).length;
    const totalLeavesTaken = approvedLeavesCount + markedLeavesCount;
    const leavesAllowed = 15;
    const leavesRemaining = Math.max(0, leavesAllowed - totalLeavesTaken);
    
    // Fetch payslips (monthly salary sheet calculations)
    // Generate payslip details dynamically for ALL distinct months the employee has logs or payroll records
    const payslips = [];
    const uniqueMonths = new Set();
    
    // Scan attendance for months
    (db.attendance || []).forEach(a => {
      if (a.employeeId === employee.id && a.date) {
        uniqueMonths.add(a.date.substring(0, 7));
      }
    });
    
    // Scan past payroll adjustments
    (db.payroll || []).forEach(p => {
      if (p.employeeId === employee.id && p.month) {
        uniqueMonths.add(p.month);
      }
    });

    // Add current month prefix
    uniqueMonths.add(currentMonthPrefix);
    
    // Sort months descending (newest first)
    const sortedMonths = Array.from(uniqueMonths).sort((a, b) => b.localeCompare(a));
    
    for (const mStr of sortedMonths) {
      const parts = mStr.split('-');
      if (parts.length !== 2) continue;
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]);
      const d = new Date(year, month - 1, 1);
      const mName = d.toLocaleString('default', { month: 'long', year: 'numeric' });
      
      const salarySheet = database.getMonthlySalarySheet(mStr) || [];
      const empRecord = salarySheet.find(r => r.employeeId === employee.id || r.id === employee.id);
      
      if (empRecord) {
        payslips.push({
          period: mName,
          monthStr: mStr,
          daysWorked: empRecord.workingDays !== undefined ? empRecord.workingDays : 0,
          grossSalary: empRecord.earnedSalary || 0,
          deductions: empRecord.salaryAdvance || 0,
          netSalary: empRecord.netSalary || 0,
          dailyRate: empRecord.dailyRate || employee.dailyRate || 0,
          monthlyWage: employee.monthlyWage || 0,
          otHours: empRecord.otHours || 0,
          otPayout: empRecord.otPayout || 0,
          pfDeduction: empRecord.pfDeduction || 0,
          esicDeduction: empRecord.esicDeduction || 0,
          ptDeduction: empRecord.ptDeduction || 0,
          lopDays: empRecord.lopDays || 0,
          lopAmount: empRecord.lopAmount || 0,
          designation: employee.designation || "Staff"
        });
      }
    }

    // Calculate current month's estimated salary
    const isOfficeStaff = employee.modeOfWork && employee.modeOfWork.toLowerCase().trim() === 'office staff';
    const isDailyWageWorker = !isOfficeStaff;
    const stdWorkingDays = isOfficeStaff ? 30 : 26;
    
    let estimatedSalary = 0;
    const dailyRate = Number(employee.dailyRate) || 0;
    const monthlyWage = Number(employee.monthlyWage) || 0;
    const hourlyRate = Number(employee.hourlyRate) || (dailyRate / 8);
    const otPayout = otHoursSum * hourlyRate;
    
    if (isDailyWageWorker) {
      estimatedSalary = (dailyRate * workedDays) + otPayout;
    } else {
      if (employee.fixedSalary === true || employee.fixedSalary === 'true' || employee.salaryLocked === true) {
        estimatedSalary = monthlyWage + otPayout;
      } else {
        const fraction = Math.min(1, workedDays / stdWorkingDays);
        estimatedSalary = (monthlyWage * fraction) + otPayout;
      }
    }
    
    // Deduct active loan installments due this month if any
    const monthlyDeductions = activeLoans.reduce((sum, l) => sum + (Number(l.monthlyInstallment) || 0), 0);
    estimatedSalary = Math.max(0, Math.round(estimatedSalary - monthlyDeductions));

    // Clone employee object and remove sensitive credentials
    const employeeInfo = { ...employee };
    delete employeeInfo.passcode;

    res.json({
      success: true,
      employee: employeeInfo,
      stats: {
        workedDays,
        lateDays,
        otHours: otHoursSum,
        totalLoanBalance,
        leavesAllowed,
        leavesTaken: totalLeavesTaken,
        leavesRemaining,
        estimatedSalary
      },
      attendance: fullAttendanceLogs,
      loans: loans,
      leaves: leaveApplications,
      payslips: payslips
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee Monthly Attendance History Endpoint
app.get('/api/employee/attendance-month', requireEmployeeAuth, (req, res) => {
  try {
    const { month } = req.query; // YYYY-MM
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Valid month string (YYYY-MM) is required." });
    }
    
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === req.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }
    
    const attendanceLogs = (db.attendance || []).filter(
      a => a.employeeId === employee.id && a.date.startsWith(month)
    );
    
    attendanceLogs.sort((a, b) => b.date.localeCompare(a.date));
    
    const isPresent = (status, checkIn) => ['checked-in', 'completed', 'Late Check-in', 'Early Check-out', 'half-day leave'].includes(status) || (status === 'late' && checkIn);
    
    const workedDays = attendanceLogs.filter(a => isPresent(a.status, a.checkIn)).length;
    const lateDays = attendanceLogs.filter(a => a.isLate === true || a.status === 'late' || a.status === 'Late Check-in').length;
    const otHoursSum = attendanceLogs.reduce((sum, a) => sum + (Number(a.otHours) || 0), 0);
    
    res.json({
      success: true,
      attendance: attendanceLogs,
      stats: {
        workedDays,
        lateDays,
        otHours: otHoursSum
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee Apply Leave Endpoint
app.post('/api/employee/apply-leave', requireEmployeeAuth, (req, res) => {
  try {
    const { startDate, endDate, reason } = req.body;
    if (!startDate || !endDate || !reason) {
      return res.status(400).json({ error: "Start date, end date, and reason are required." });
    }
    
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === req.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }
    
    if (!employee.leaveApplications) {
      employee.leaveApplications = [];
    }
    
    const newLeave = {
      id: `leave_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      startDate,
      endDate,
      reason,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    
    employee.leaveApplications.push(newLeave);
    database.writeAtomic(db);
    database.syncToExcelAsync();
    
    res.status(201).json({ success: true, leave: newLeave });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee Update Profile Endpoint
app.post('/api/employee/update-profile', requireEmployeeAuth, (req, res) => {
  try {
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === req.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }

    const updates = req.body;
    
    // Safety check: Only allow updates on these specific personal/document fields
    const allowedFields = [
      'phone', 'dob', 'joiningDate', 'emergencyContact', 'bloodGroup', 'address',
      'aadhaar', 'pan', 'drivingLicense'
    ];

    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        employee[field] = updates[field];
      }
    });

    // Handle Profile Photo Upload
    if (updates.profilePhotoBase64) {
      const uploadsDir = path.join(__dirname, 'public', 'uploads', 'profiles');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      let ext = 'png';
      const mimeMatch = updates.profilePhotoBase64.match(/^data:([a-zA-Z0-9.+\/-]+);base64,/);
      if (mimeMatch) {
        const mimeType = mimeMatch[1];
        if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') ext = 'jpg';
        else if (mimeType === 'image/webp') ext = 'webp';
      }
      
      const base64Data = updates.profilePhotoBase64.replace(/^data:[a-zA-Z0-9.+\/-]+;base64,/, '');
      const filename = `${employee.id}_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64Data, 'base64'));
      
      // Clean up old photo
      if (employee.profilePhoto) {
        const oldPath = path.join(__dirname, 'public', employee.profilePhoto);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch (e) {}
        }
      }
      employee.profilePhoto = `/uploads/profiles/${filename}`;
    }

    // Handle Document Scans Upload
    const docFields = [
      { base64Key: 'aadhaarPhotoBase64', pathKey: 'aadhaarPhoto', prefix: 'aadhaar' },
      { base64Key: 'panPhotoBase64', pathKey: 'panPhoto', prefix: 'pan' },
      { base64Key: 'drivingLicensePhotoBase64', pathKey: 'drivingLicensePhoto', prefix: 'dl' }
    ];

    docFields.forEach(field => {
      if (updates[field.base64Key]) {
        const docDir = path.join(__dirname, 'public', 'uploads', 'documents');
        if (!fs.existsSync(docDir)) {
          fs.mkdirSync(docDir, { recursive: true });
        }
        
        let ext = 'png';
        const mimeMatch = updates[field.base64Key].match(/^data:([a-zA-Z0-9.+\/-]+);base64,/);
        if (mimeMatch) {
          const mimeType = mimeMatch[1];
          if (mimeType === 'application/pdf') ext = 'pdf';
          else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') ext = 'jpg';
          else if (mimeType === 'image/webp') ext = 'webp';
        }
        
        const base64Data = updates[field.base64Key].replace(/^data:[a-zA-Z0-9.+\/-]+;base64,/, '');
        const filename = `${field.prefix}_${employee.id}_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(docDir, filename), Buffer.from(base64Data, 'base64'));
        
        // Clean up old file
        if (employee[field.pathKey]) {
          const oldPath = path.join(__dirname, 'public', employee[field.pathKey]);
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (e) {}
          }
        }
        employee[field.pathKey] = `/uploads/documents/${filename}`;
      }
    });

    database.writeAtomic(db);
    database.syncToExcelAsync();

    // Remove passcode for clean response
    const saved = { ...employee };
    delete saved.passcode;

    res.json({ success: true, employee: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee Check-In Endpoint
app.post('/api/employee/checkin', requireEmployeeAuth, (req, res) => {
  try {
    const { imageBase64, latitude, longitude } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "Selfie photo is required." });
    }
    
    const db = database.read();
    const employee = db.employees.find(e => e && e.id === req.employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }
    
    const now = new Date();
    const timestamp = now.toISOString();
    const eventDate = timestamp.split('T')[0];
    
    // Check if already checked in / out today
    const existingAttendance = (db.attendance || []).find(
      a => a.employeeId === employee.id && a.date === eventDate
    );
    
    const localHour = now.getHours();
    const isLunchHour = (localHour === 13);
    
    // Calculate if late check-in
    const { shiftStart } = database.getEmployeeShiftForDate(employee, eventDate);
    const [sh, sm] = (shiftStart || "09:00").split(':').map(Number);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const shiftStartMinutes = sh * 60 + sm;
    const isScanLateTime = nowMinutes > shiftStartMinutes;
    
    const isLateCheckInPendingScan = existingAttendance && existingAttendance.status === 'late' && !existingAttendance.scannedCheckIn;
    const isLateCheckIn = isLateCheckInPendingScan || ((!existingAttendance || existingAttendance.status === 'absent') && isScanLateTime);
    
    let eventType = 'entry';
    const attendanceEntry = {
      employeeId: employee.id,
      employeeName: employee.name,
      date: eventDate,
      siteName: 'Mobile Scan',
      facialRecognitionMatch: true, // Native face tracking done locally
      matchConfidence: 1.0,
      latitude: latitude ? Number(latitude) : undefined,
      longitude: longitude ? Number(longitude) : undefined,
      verificationMethod: 'Mobile Face Detection',
      notes: 'Face detected locally'
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
        return res.status(400).json({ error: "Attendance already completed or marked leave for today." });
      }
      
      let lastEventTime = new Date(existingAttendance.checkIn);
      if (existingAttendance.lunchIn) {
        lastEventTime = new Date(existingAttendance.lunchIn);
      } else if (existingAttendance.lunchOut) {
        lastEventTime = new Date(existingAttendance.lunchOut);
      }
      
      const diffSeconds = (now - lastEventTime) / 1000;
      if (diffSeconds < 30) {
        return res.status(400).json({ error: "Duplicate scan. Please wait 30 seconds." });
      }
      
      if (existingAttendance.lunchOut && existingAttendance.lunchIn) {
        eventType = 'exit';
        attendanceEntry.checkOut = timestamp;
      } else if (existingAttendance.lunchOut && !existingAttendance.lunchIn) {
        eventType = 'lunch-in';
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
    let siteName = 'Mobile Scan';
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
      attendanceEntry.notes = `[FLAGGED LOCATION] Off-Site Scan (${Math.round(distance)}m) ${attendanceEntry.notes}`;
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
      imageFilename: 'mobile_selfie.jpg',
      isConfidence: true,
      matchConfidence: 1.0,
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      status: "approved"
    });
    
    // Update or add attendance record
    database.saveAttendance(attendanceEntry);
    
    // Notify dashboard clients
    io.emit('attendance_updated');
    io.emit('stats_updated');
    io.emit('new_camera_event', savedEvent);
    
    res.json({
      success: true,
      status: eventType === 'entry' ? 'checked-in' : (eventType === 'exit' ? 'completed' : eventType),
      message: `Selfie Attendance accepted (${eventType === 'entry' ? 'Checked In' : (eventType === 'exit' ? 'Checked Out' : eventType)})`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Debug endpoint to list all available group chats and names
app.get('/api/debug/chats', async (req, res) => {
  try {
    if (!whatsapp.client) return res.status(400).send("WhatsApp client is not initialized.");
    console.log("[Debug API] Fetching all chats...");
    const chats = await whatsapp.client.getChats();
    const groupChats = chats.filter(c => c.isGroup).map(c => ({
      id: c.id._serialized,
      name: c.name,
      unreadCount: c.unreadCount
    }));
    res.json({ success: true, count: groupChats.length, groups: groupChats });
  } catch (err) {
    console.error("[Debug API] Failed to fetch chats:", err);
    res.json({ success: false, message: err.message, stack: err.stack });
  }
});

// Debug endpoint to find chats by typing in UI and extracting results
app.get('/api/debug/search-ui', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).send("Missing q query parameter.");
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Puppeteer page not available.");
    }
    const page = whatsapp.client.pupPage;
    console.log(`[Debug API] Searching UI for: "${query}"`);
    
    // Find and click the search box natively to trigger event handlers
    const searchSelector = 'input.html-input';
    await page.waitForSelector(searchSelector, { timeout: 5000 });
    await page.click(searchSelector);
    
    // Select all and delete (ensure it's clean)
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    
    // Type query
    await page.keyboard.type(query);
    
    // Wait for search results
    await new Promise(r => setTimeout(r, 6000));
    
    // Take screenshot
    const screenshotPath = path.join(__dirname, 'whatsapp_search_results.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`[Debug API] Search UI screenshot saved to: ${screenshotPath}`);
    
    // Extract titles and JIDs from DOM
    const DOMResults = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span[title]'));
      const items = [];
      spans.forEach(span => {
        const title = span.getAttribute('title');
        let parent = span.parentElement;
        let jid = null;
        while (parent && parent !== document.body) {
          if (parent.hasAttribute('data-jid')) {
            jid = parent.getAttribute('data-jid');
            break;
          }
          // Search all attributes of parent for JID
          for (let i = 0; i < parent.attributes.length; i++) {
            const attr = parent.attributes[i];
            const val = attr.value || '';
            const match = val.match(/(\d+[-@\w.]+g\.us|\d+@c\.us)/);
            if (match) {
              jid = match[0];
              break;
            }
          }
          if (jid) break;
          
          const html = parent.outerHTML || '';
          const match = html.match(/(\d+[-@\w.]+g\.us|\d+@c\.us)/);
          if (match) {
            jid = match[0];
            break;
          }
          parent = parent.parentElement;
        }
        if (title) {
          items.push({ title, jid });
        }
      });
      return items;
    });

    res.json({ success: true, count: DOMResults.length, results: DOMResults, screenshot: screenshotPath });
  } catch (err) {
    console.error("[Debug API] Search UI failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint to open a chat and extract its active JID from message DOM containers
app.get('/api/debug/select-chat', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Puppeteer page not available.");
    }
    const page = whatsapp.client.pupPage;
    console.log(`[Debug API] Selecting ATTENDANCE chat...`);
    
    // Find and click the search box natively to trigger event handlers
    const searchSelector = 'input.html-input';
    await page.waitForSelector(searchSelector, { timeout: 5000 });
    await page.click(searchSelector);
    
    // Select all and delete (ensure it's clean)
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    
    // Type query
    await page.keyboard.type("ATTENDANCE");
    
    // Wait for search results
    await new Promise(r => setTimeout(r, 6000));
    
    // Click the result titled "ATTENDANCE"
    // Click the result titled "ATTENDANCE"
    const clickedInfo = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('span[title]')).find(s => s.getAttribute('title') === 'ATTENDANCE');
      if (span) {
        let parent = span.parentElement;
        while (parent && parent !== document.body) {
          if (parent.getAttribute('role') === 'row' || parent.getAttribute('role') === 'listitem' || parent.classList.contains('_ak72')) {
            parent.setAttribute('data-target-click-debug', 'true');
            return { success: true };
          }
          parent = parent.parentElement;
        }
        span.setAttribute('data-target-click-debug', 'true');
        return { success: true };
      }
      return { success: false, error: 'Span not found' };
    });
    
    if (!clickedInfo.success) {
      return res.json({ success: false, message: clickedInfo.error });
    }
    
    // Simulate real native click on the marked element
    await page.click('[data-target-click-debug="true"]');
    
    // Wait for chat to open
    await new Promise(r => setTimeout(r, 6000));
    
    // Capture screenshot
    const screenshotPath = path.join(__dirname, 'whatsapp_active_chat.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`[Debug API] Active chat screenshot saved to: ${screenshotPath}`);
    
    // Try to extract JID of active chat
    let activeChatJID = await page.evaluate(() => {
      const msgContainers = Array.from(document.querySelectorAll('div[data-id]'));
      for (let container of msgContainers) {
        const dataId = container.getAttribute('data-id');
        if (dataId) {
          const match = dataId.match(/(\d+[-@\w.]+g\.us|\d+@c\.us)/);
          if (match) {
            return match[0];
          }
        }
      }
      const mainHeader = document.querySelector('header');
      if (mainHeader) {
        const html = mainHeader.outerHTML || '';
        const match = html.match(/(\d+[-@\w.]+g\.us|\d+@c\.us)/);
        if (match) return match[0];
      }
      return null;
    });

    if (!activeChatJID) {
      console.log("[Debug API] Normal JID extraction failed. Attempting ReactProps scan...");
      activeChatJID = await page.evaluate(() => {
        function searchObj(obj, depth = 0) {
          if (depth > 6 || !obj) return null;
          if (typeof obj === 'string') {
            if ((obj.endsWith('@g.us') || obj.includes('@g.us')) && !obj.includes('status')) {
              const m = obj.match(/(\d+@g\.us)/);
              if (m) return m[1];
            }
            return null;
          }
          if (typeof obj === 'object') {
            for (const key in obj) {
              try {
                const res = searchObj(obj[key], depth + 1);
                if (res) return res;
              } catch (e) {}
            }
          }
          return null;
        }

        const elements = Array.from(document.querySelectorAll('*'));
        for (const el of elements) {
          const text = el.textContent || '';
          if (text === 'ATTENDANCE' || el.getAttribute('title') === 'ATTENDANCE') {
            for (const key of Object.keys(el)) {
              if (key.startsWith('__react')) {
                const jid = searchObj(el[key]);
                if (jid) return jid;
              }
            }
            let parent = el.parentElement;
            for (let i = 0; i < 4 && parent; i++) {
              for (const key of Object.keys(parent)) {
                if (key.startsWith('__react')) {
                  const jid = searchObj(parent[key]);
                  if (jid) return jid;
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        return null;
      });
    }

    res.json({ success: true, activeChatJID, screenshot: screenshotPath });
  } catch (err) {
    console.error("[Debug API] Select chat failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint to dump React props of ATTENDANCE elements
app.get('/api/debug/dump-react-props', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Puppeteer page not available.");
    }
    const page = whatsapp.client.pupPage;
    const dump = await page.evaluate(() => {
      const results = [];
      const span = Array.from(document.querySelectorAll('*')).find(el => el.textContent === 'ATTENDANCE' || (el.getAttribute && el.getAttribute('title') === 'ATTENDANCE'));
      if (span) {
        let parent = span;
        let depth = 0;
        while (parent && depth < 20) {
          const keys = Object.keys(parent).filter(k => k.startsWith('__react'));
          for (const key of keys) {
            const fiber = parent[key];
            const foundJids = [];
            const seen = new Set();
            function scan(obj, path = '', scanDepth = 0) {
              if (scanDepth > 12 || !obj || seen.has(obj)) return;
              seen.add(obj);
              if (typeof obj === 'object') {
                if (obj.id && typeof obj.id === 'string' && (obj.id.endsWith('@g.us') || obj.id.endsWith('@c.us'))) {
                  foundJids.push({ path: path + '.id', jid: obj.id });
                } else if (obj.id && typeof obj.id === 'object' && obj.id._serialized) {
                  foundJids.push({ path: path + '.id._serialized', jid: obj.id._serialized });
                }
                for (const k in obj) {
                  try {
                    scan(obj[k], path + '.' + k, scanDepth + 1);
                  } catch (e) {}
                }
              }
            }
            scan(fiber, key, 0);
            if (foundJids.length > 0) {
              results.push({ depth, key, foundJids });
            }
          }
          parent = parent.parentElement;
          depth++;
        }
      }
      return results;
    });
    res.json(dump);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to list all chats from the client API
app.get('/api/debug/list-all-chats', async (req, res) => {
  try {
    if (!whatsapp.client) {
      return res.status(400).send("WhatsApp client not available.");
    }
    const chats = await whatsapp.client.getChats();
    const filtered = chats.filter(c => c.name && c.name.toUpperCase().includes('ATTENDANCE'));
    res.json({
      success: true,
      count: filtered.length,
      chats: filtered.map(c => ({
        id: c.id._serialized,
        name: c.name,
        isGroup: c.isGroup
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/api/debug/dump-messages', async (req, res) => {
  try {
    if (!whatsapp.client) return res.status(400).send("WhatsApp client is not initialized.");
    const chat = await whatsapp.client.getChatById('120363419060820327@g.us');
    if (!chat) return res.status(404).send("Chat not found.");
    const messages = await chat.fetchMessages({ limit: 50 });
    res.json({
      success: true,
      name: chat.name,
      messages: messages.map(m => ({
        id: m.id._serialized,
        timestamp: m.timestamp,
        author: m.author,
        body: m.body,
        isSystem: m.isSystem,
        type: m.type
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/api/debug/inspect-chat', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Page not available.");
    }
    const result = await whatsapp.client.pupPage.evaluate(async () => {
      try {
        const jid = '120363428399550159@g.us';
        if (!window.WWebJS || !window.WWebJS.getChat) {
          return { error: 'window.WWebJS or window.WWebJS.getChat not loaded yet.' };
        }
        const chat = await window.WWebJS.getChat(jid);
        if (!chat) return { found: false, error: 'Chat not found' };
        return {
          found: true,
          name: chat.name,
          id: chat.id._serialized || chat.id,
          isGroup: chat.isGroup
        };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/reload', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Puppeteer page not available.");
    }
    console.log("[Debug API] Reloading WhatsApp Web page...");
    await whatsapp.client.pupPage.reload({ waitUntil: 'networkidle2' });
    res.send("Page successfully reloaded.");
  } catch (err) {
    res.status(500).send(`Failed to reload page: ${err.message}`);
  }
});

app.get('/api/debug/my-info', (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.info) {
      return res.status(400).send("Client info not available yet.");
    }
    res.json({
      pushname: whatsapp.client.info.pushname,
      wid: whatsapp.client.info.wid
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/close-modal', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Puppeteer page not available.");
    }
    const page = whatsapp.client.pupPage;
    console.log("[Debug API] Attempting to close modals...");
    
    // Press Escape key multiple times
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 1000));
    
    // Try to find and click any close buttons or "Continue" buttons
    await page.evaluate(() => {
      // Find buttons containing X or Continue or Close
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const ariaLabel = btn.getAttribute('aria-label') || '';
        if (
          text.toLowerCase().includes('continue') ||
          text.toLowerCase().includes('close') ||
          text.toLowerCase().includes('dismiss') ||
          ariaLabel.toLowerCase().includes('close') ||
          ariaLabel.toLowerCase().includes('dismiss')
        ) {
          btn.click();
          console.log("Clicked button:", text, ariaLabel);
        }
      }
    });

    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: 'whatsapp_screenshot.png' });
    res.send("Attempted to close modals. Check screenshot.");
  } catch (err) {
    res.status(500).send(`Error closing modal: ${err.message}`);
  }
});

app.post('/api/debug/eval-page', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).json({ error: "Page not available." });
    }
    const { js } = req.body;
    console.log("[Debug API] Evaluating JS on page:", js);
    const result = await whatsapp.client.pupPage.evaluate(async (code) => {
      try {
        const fn = new Function('return (' + code + ')');
        const res = await fn();
        return { success: true, result: res };
      } catch (e) {
        return { success: false, error: e.message, stack: e.stack };
      }
    }, js);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Debug endpoint to find the search box selectors in WhatsApp Web
app.get('/api/debug/find-search-box', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.client.pupPage) {
      return res.status(400).send("Puppeteer page not available.");
    }
    const page = whatsapp.client.pupPage;
    const elements = await page.evaluate(() => {
      const contentEditables = Array.from(document.querySelectorAll('div[contenteditable="true"]')).map((el, i) => ({
        index: i,
        tagName: el.tagName,
        className: el.className,
        id: el.id,
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        innerHTML: el.innerHTML.slice(0, 100)
      }));
      const placeholderSearches = Array.from(document.querySelectorAll('*')).filter(el => {
        const ph = el.getAttribute && el.getAttribute('placeholder');
        return ph && ph.toLowerCase().includes('search');
      }).map(el => ({
        tagName: el.tagName,
        className: el.className,
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label')
      }));
      return { contentEditables, placeholderSearches };
    });
    res.json(elements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// System General Analytics
app.get('/api/stats', (req, res) => {
  // Cache stats for 8 seconds — fast enough for near-real-time updates, avoids hammering DB on every poll
  const stats = getCached('stats', 8000, () => {
    const todayStr = getLocalDateString();
    const employees = database.getEmployees();
    const activeEmpCount = employees.filter(e => e.status === 'active').length;
    const attendanceToday = database.getAttendanceForDate(todayStr);

    const presentCount = attendanceToday.filter(a => ['checked-in', 'completed', 'Late Check-in', 'Early Check-out', 'half-day leave'].includes(a.status) || (a.status === 'late' && a.checkIn)).length;
    const halfDayCount = attendanceToday.filter(a => a.isHalfDay === true || a.isHalfDay === 'true' || a.status === 'half-day leave').length;
    const lateCount = attendanceToday.filter(a => a.status === 'Late Check-in' || a.status === 'late' || a.isLate === true || a.isLate === 'true').length;
    const earlyCount = attendanceToday.filter(a => a.status === 'Early Check-out' || a.isEarlyCheckout === true || a.isEarlyCheckout === 'true').length;
    const leaveCount = attendanceToday.filter(a => a.status === 'leave').length;
    const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
    const pendingCount = database.getPendingMessages().length;

    return {
      totalEmployees: activeEmpCount,
      presentToday: presentCount,
      halfDayToday: halfDayCount,
      lateCheckInToday: lateCount,
      earlyCheckOutToday: earlyCount,
      leaveToday: leaveCount,
      absentToday: absentCount,
      pendingExceptions: pendingCount
    };
  });
  res.json(stats);
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

// ==========================================================================
// TRAVEL TIME LOG API — Returns all attendance records with travelHours > 0
// Supports optional ?month=YYYY-MM filter
// ==========================================================================
app.get('/api/travel', (req, res) => {
  try {
    const { month } = req.query;
    const db = database.read();
    let logs = (db.attendance || []).filter(log =>
      log && log.date && log.travelHours && Number(log.travelHours) > 0
    );
    if (month) {
      logs = logs.filter(log => log.date.startsWith(month));
    }
    // Sort by date ascending
    logs.sort((a, b) => a.date.localeCompare(b.date));
    return res.json(logs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Attendance Management
app.get('/api/attendance', (req, res) => {
  const { date, startDate, endDate, onlyTravel } = req.query;
  
  if (startDate && endDate) {
    if (onlyTravel === 'true') {
      try {
        const db = database.read();
        const start = new Date(startDate);
        const end = new Date(endDate);
        const filtered = (db.attendance || []).filter(log => {
          if (!log || !log.date || !log.travelHours || Number(log.travelHours) <= 0) return false;
          const d = new Date(log.date);
          return d >= start && d <= end;
        });
        return res.json(filtered);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
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

// Import biometric attendance from Excel file (Base64)
app.post('/api/attendance/import-biometric', async (req, res) => {
  try {
    const { fileBase64 } = req.body;
    if (!fileBase64) {
      return res.status(400).json({ error: 'fileBase64 is required.' });
    }

    const buffer = Buffer.from(fileBase64, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    // raw: false formats cells according to Excel formats (string representations)
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'The uploaded Excel file is empty.' });
    }

    // Auto-detect columns in the first 15 rows with robust default fallbacks
    let colUserId = -1;
    let colName = -1;
    let colShift = -1;
    let inCols = [];
    let outCols = [];

    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const row = rows[i];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const val = row[c] ? row[c].toString().toLowerCase().trim() : '';
        if (!val) continue;

        if (colUserId === -1 && (val === 'user id' || val === 'emp code' || val === 'userid' || val === 'empcode' || val === 'user_id' || val === 'id' || val === 'run by:' || val.includes('user'))) {
          if (val !== 'run by:' && !val.includes('run by')) {
            colUserId = c;
          }
        }
        if (colName === -1 && (val === 'name' || val === 'user name' || val === 'employee name' || val === 'username' || val.includes('name'))) {
          if (!val.includes('run by')) {
            colName = c;
          }
        }
        if (colShift === -1 && (val === 'shift' || val.includes('shift'))) {
          colShift = c;
        }

        if (val.startsWith('in-') || val === 'in' || val.includes('in-spfid') || val.includes('check-in') || val.includes('checkin') || val === 'in1' || val === 'in2') {
          if (!inCols.includes(c)) inCols.push(c);
        } else if (val.startsWith('out-') || val === 'out' || val.includes('out-spfid') || val.includes('check-out') || val.includes('checkout') || val === 'out1' || val === 'out2') {
          if (!outCols.includes(c)) outCols.push(c);
        }
      }
    }

    // Apply fallbacks based on typical biometric Excel report structures (Column B=User ID, C=Name, D=Shift, E=In1, F=Out1, G=In2, H=Out2)
    if (colUserId === -1) colUserId = 1;
    if (colName === -1) colName = 2;
    if (colShift === -1) colShift = 3;

    inCols.sort((a, b) => a - b);
    outCols.sort((a, b) => a - b);

    if (inCols.length === 0) {
      inCols = [4, 6];
    }
    if (outCols.length === 0) {
      outCols = [5, 7];
    }

    let colIn1 = inCols[0];
    let colOut1 = outCols[0];
    let colIn2 = inCols.length > 1 ? inCols[1] : (outCols[0] + 1); // fallback index if not detected
    let colOut2 = outCols.length > 1 ? outCols[1] : (colIn2 + 1);

    const db = database.read();
    const employees = db.employees || [];
    let currentDateStr = null;
    let importedCount = 0;
    const unrecognizedEmployeesMap = new Map();
    const importedRecords = [];

    // Robust time parser to support string hours and numeric fractional day representations
    const parseTime = (val) => {
      if (!val) return null;
      
      const s = val.toString().trim();
      const match = s.match(/^(\d{1,2}):(\d{2})/);
      if (match) {
        const h = match[1].padStart(2, '0');
        const m = match[2];
        return `${h}:${m}:00`;
      }
      
      if (typeof val === 'number') {
        const totalMinutes = Math.round(val * 24 * 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const h = hours.toString().padStart(2, '0');
        const m = minutes.toString().padStart(2, '0');
        return `${h}:${m}:00`;
      }
      
      return null;
    };

    database.startTransaction();

    try {
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length === 0) continue;

        const cell0 = row[0] ? row[0].toString().trim() : '';

        // 1. Date Header Detection
        if (cell0) {
          // Matches DD/MM/YYYY, DD-MM-YYYY
          let dateMatch = cell0.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
          if (dateMatch) {
            const day = dateMatch[1];
            const month = dateMatch[2];
            const year = dateMatch[3];
            currentDateStr = `${year}-${month}-${day}`;
            continue;
          }
          
          dateMatch = cell0.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
          if (dateMatch) {
            const year = dateMatch[1];
            const month = dateMatch[2];
            const day = dateMatch[3];
            currentDateStr = `${year}-${month}-${day}`;
            continue;
          }

          // Handle native JavaScript Date object parsed by xlsx
          if (row[0] instanceof Date) {
            const d = row[0];
            const y = d.getFullYear();
            const m = (d.getMonth() + 1).toString().padStart(2, '0');
            const dy = d.getDate().toString().padStart(2, '0');
            currentDateStr = `${y}-${m}-${dy}`;
            continue;
          }
        }

        // 2. Data Row Identification (Starts with numeric biometric User ID in detected User ID column)
        const userIdVal = row[colUserId] ? row[colUserId].toString().trim() : '';
        if (!userIdVal) continue;

        const userIdMatch = userIdVal.match(/^\d+$/);
        if (userIdMatch && currentDateStr) {
          const userId = userIdVal;
          const empName = row[colName] ? row[colName].toString().trim() : '';

          // Look up worker in registry
          let employee = employees.find(e => e.userId && e.userId.toString().trim() === userId);
          if (!employee) {
            employee = employees.find(e => e.id === `emp_${userId}`);
          }
          if (!employee && empName) {
            employee = employees.find(e => e.name && e.name.toLowerCase().trim() === empName.toLowerCase());
          }

          if (!employee) {
            unrecognizedEmployeesMap.set(userId, { userId, name: empName || 'Unknown Name' });
            continue;
          }

          // Parse raw punch times
          const in1 = parseTime(row[colIn1]);
          const out1 = parseTime(row[colOut1]);
          const in2 = parseTime(row[colIn2]);
          const out2 = parseTime(row[colOut2]);

          const punches = [];
          const createPunchTimeStr = (timeStr) => {
            const [h, m, s] = timeStr.split(':').map(Number);
            const [yr, mo, dy] = currentDateStr.split('-').map(Number);
            const utcDate = new Date(Date.UTC(yr, mo - 1, dy, h, m, s || 0));
            utcDate.setMinutes(utcDate.getMinutes() - 330); // Convert IST to UTC (IST is UTC + 5:30)
            return utcDate.toISOString();
          };

          if (in1) punches.push({ time: createPunchTimeStr(in1), type: 'in', siteName: 'INTEREXT OFFICE', messageText: 'Biometric Punching Machine', source: 'Biometric' });
          if (out1) punches.push({ time: createPunchTimeStr(out1), type: 'out', siteName: 'INTEREXT OFFICE', messageText: 'Biometric Punching Machine', source: 'Biometric' });
          if (in2) punches.push({ time: createPunchTimeStr(in2), type: 'in', siteName: 'INTEREXT OFFICE', messageText: 'Biometric Punching Machine', source: 'Biometric' });
          if (out2) punches.push({ time: createPunchTimeStr(out2), type: 'out', siteName: 'INTEREXT OFFICE', messageText: 'Biometric Punching Machine', source: 'Biometric' });

          if (punches.length === 0) continue;

          // Earliest punch is check-in, latest is check-out (if it's an out type)
          const sortedPunches = punches.sort((a, b) => new Date(a.time) - new Date(b.time));
          const checkIn = sortedPunches[0].time;
          let checkOut = null;
          if (sortedPunches.length > 1) {
            const last = sortedPunches[sortedPunches.length - 1];
            if (last.type === 'out') {
              checkOut = last.time;
            }
          }

          const attendanceRecord = {
            employeeId: employee.id,
            employeeName: employee.name,
            date: currentDateStr,
            checkIn: checkIn,
            checkOut: checkOut,
            punches: sortedPunches,
            source: 'INTEREXT OFFICE'
          };

          database.saveAttendance(attendanceRecord);
          importedCount++;
          importedRecords.push({
            userId,
            name: employee.name,
            date: currentDateStr,
            checkIn: in1 || '',
            checkOut: out1 || ''
          });
        }
      }

      database.commitTransaction();
      
      // Notify client-side listeners that attendance logs have changed
      io.emit('attendance_updated');
      
      res.json({
        success: true,
        importedCount,
        unrecognized: Array.from(unrecognizedEmployeesMap.values()),
        importedRecords
      });
    } catch (dbErr) {
      database.isBatching = false;
      database.batchDb = null;
      throw dbErr;
    }
  } catch (err) {
    console.error('[API] Biometric import failed:', err.message);
    res.status(500).json({ error: err.message });
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

app.post('/api/attendance/camera/edit', (req, res) => {
  try {
    const { id, employeeId } = req.body;
    if (!id || !employeeId) {
      return res.status(400).json({ error: 'id and employeeId are required.' });
    }

    const db = database.read();
    
    // Find the camera event
    const eventIndex = (db.cameraEvents || []).findIndex(e => e.id === id);
    if (eventIndex === -1) {
      return res.status(404).json({ error: 'Camera event not found.' });
    }

    const event = db.cameraEvents[eventIndex];
    const oldEmpId = event.employeeId;
    const oldEmpName = event.employeeName;
    const eventTime = event.timestamp;
    const eventDate = event.date;
    const eventType = event.eventType;
    const siteName = event.siteName || 'Office';

    // Find the new employee
    const newEmployee = (db.employees || []).find(emp => emp.id === employeeId);
    if (!newEmployee) {
      return res.status(404).json({ error: 'New employee not found.' });
    }

    // 1. Update the camera event record
    event.employeeId = employeeId;
    event.employeeName = newEmployee.name;
    event.status = 'corrected';
    database.saveCameraEvent(event);

    // 2. Remove the punch from the old employee's attendance record
    const oldAttendance = (db.attendance || []).find(a => a.employeeId === oldEmpId && a.date === eventDate);
    if (oldAttendance) {
      // Filter out this camera punch
      const targetTimeStr = new Date(eventTime).getTime();
      oldAttendance.punches = (oldAttendance.punches || []).filter(p => {
        // Keep punch if it's not a CCTV punch around the same timestamp
        const pTimeStr = new Date(p.time).getTime();
        const timeDiff = Math.abs(pTimeStr - targetTimeStr);
        return !(p.source === 'CCTV' && timeDiff < 5000); // 5 seconds margin
      });

      // Recalculate checkIn / checkOut / status / hours for the old employee
      if (oldAttendance.punches.length === 0) {
        // No punches left, delete the attendance record
        db.attendance = db.attendance.filter(a => a.id !== oldAttendance.id);
        database.writeAtomic(db);
        io.emit('attendance_updated', { id: oldAttendance.id, status: 'deleted', employeeId: oldEmpId, date: eventDate });
      } else {
        // Recalculate checkIn / checkOut from remaining punches
        const inPunches = oldAttendance.punches.filter(p => p.type === 'in');
        const outPunches = oldAttendance.punches.filter(p => p.type === 'out');
        
        if (inPunches.length > 0) {
          inPunches.sort((a,b) => new Date(a.time) - new Date(b.time));
          oldAttendance.checkIn = inPunches[0].time;
        } else {
          const sorted = [...oldAttendance.punches].sort((a,b) => new Date(a.time) - new Date(b.time));
          oldAttendance.checkIn = sorted[0].time;
        }

        if (outPunches.length > 0) {
          outPunches.sort((a,b) => new Date(b.time) - new Date(a.time));
          oldAttendance.checkOut = outPunches[0].time;
        } else {
          oldAttendance.checkOut = null;
        }

        database.saveAttendance(oldAttendance);
        io.emit('attendance_updated', oldAttendance);
      }
    }

    // 3. Add the punch to the new employee's attendance record
    const attendanceEntry = {
      employeeId,
      employeeName: newEmployee.name,
      date: eventDate,
      siteName: siteName,
      messageText: `Camera ${eventType} event (corrected)`,
      punches: [{
        time: eventTime,
        type: eventType === 'exit' ? 'out' : 'in',
        siteName: siteName,
        messageText: `Camera ${eventType} event`,
        source: 'CCTV'
      }]
    };

    const existingAttendance = (db.attendance || []).find(a => a.employeeId === employeeId && a.date === eventDate);
    if (eventType === 'entry') {
      attendanceEntry.checkIn = eventTime;
      if (existingAttendance) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkOut = existingAttendance.checkOut;
        
        // Merge punches
        const punches = existingAttendance.punches || [];
        const targetTimeStr = new Date(eventTime).getTime();
        const hasDuplicate = punches.some(p => p.source === 'CCTV' && Math.abs(new Date(p.time).getTime() - targetTimeStr) < 5000);
        if (!hasDuplicate) {
          punches.push(attendanceEntry.punches[0]);
        }
        attendanceEntry.punches = punches;
      }
    } else {
      // exit event
      if (existingAttendance) {
        attendanceEntry.id = existingAttendance.id;
        attendanceEntry.checkIn = existingAttendance.checkIn;
        
        // Merge punches
        const punches = existingAttendance.punches || [];
        const targetTimeStr = new Date(eventTime).getTime();
        const hasDuplicate = punches.some(p => p.source === 'CCTV' && Math.abs(new Date(p.time).getTime() - targetTimeStr) < 5000);
        if (!hasDuplicate) {
          punches.push(attendanceEntry.punches[0]);
        }
        attendanceEntry.punches = punches;
      } else {
        attendanceEntry.checkIn = eventTime;
      }
      attendanceEntry.checkOut = eventTime;
    }

    const savedAttendance = database.saveAttendance(attendanceEntry);
    io.emit('attendance_updated', savedAttendance);

    res.json({ success: true, cameraEvent: event, attendance: savedAttendance });
  } catch (err) {
    console.error('[CameraEdit] Failed to edit camera event:', err);
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
          threshold: threshold || 0.51
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
        const { shiftStart } = database.getEmployeeShiftForDate(employee, eventDate);
        if (!shiftStart) return false;
        const [sh, sm] = shiftStart.split(':').map(Number);
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

// GET Unknown Detections - with optional date filter and pagination
app.get('/api/unknown-detections', (req, res) => {
  try {
    const { date, page, limit } = req.query;
    let detections = database.getUnknownDetections();

    // Filter by date if provided (format: YYYY-MM-DD)
    if (date) {
      detections = detections.filter(d => d.date === date);
    }

    // Sort newest first
    detections = detections.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const pageSize = parseInt(limit, 10) || 100;
    const totalCount = detections.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const offset = (pageNum - 1) * pageSize;
    const paginated = detections.slice(offset, offset + pageSize);

    res.json({ detections: paginated, totalCount, totalPages, page: pageNum, pageSize });
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
        const { shiftStart } = database.getEmployeeShiftForDate(employee, eventDate);
        if (!shiftStart) return false;
        const [sh, sm] = shiftStart.split(':').map(Number);
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

    // Delete the unknown detection record immediately so UI updates instantly
    database.deleteUnknownDetection(detectionId);
    io.emit('unknown_detection_deleted', detectionId);

    // Respond immediately before retraining (retraining can take 10-30s)
    res.json({
      success: true,
      message: `Successfully assigned face to ${employee.name}. Model retraining started in background.`,
      retrainSuccess: true
    });

    // Trigger face retraining asynchronously (fire-and-forget)
    const imagesDir = path.join(__dirname, 'uploads', 'face_training');
    const formData = new URLSearchParams();
    formData.append('images_dir', imagesDir);
    formData.append('force', 'false');
    formData.append('employee_id', cleanName);

    fetch(`${FACE_RECOGNITION_SERVICE}/api/face/train`, {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }).then(r => r.json()).then(retrainResult => {
      console.log('[API] Async retraining complete:', retrainResult);
    }).catch(trainErr => {
      console.error('[API] Async retraining failed:', trainErr.message);
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
            threshold: savedCamera.threshold || 0.38
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


// GET CCTV Static Frame Snapshot proxy (resolves browser HTTP/1.1 connection exhaustion)
app.get('/api/cctv/snapshot/:id', (req, res) => {
  const camera_id = req.params.id;
  const targetUrl = `${FACE_RECOGNITION_SERVICE}/api/cctv/snapshot/${camera_id}`;
  
  const proxyReq = http.get(targetUrl, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[Proxy Error] Failed to get snapshot from face recognition api: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send('Snapshot error');
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

    // Deduplication check: prevent duplicate logs for the same employee, event type within 2 minutes
    const existingEvent = (db.cameraEvents || []).find(e => {
      if (e.employeeId !== employee.id || e.eventType !== resolvedEventType) return false;
      const diffMs = Math.abs(now.getTime() - new Date(e.timestamp).getTime());
      return diffMs < 120000; // 2 minutes window
    });
    if (existingEvent) {
      console.log(`[CCTV Event] Ignoring duplicate event for ${employee.name} (${resolvedEventType}) within 2 minutes.`);
      return res.json({ success: true, status: 'ignored_duplicate', cameraEvent: existingEvent });
    }

    const isLateCheckInPendingScan = existingAttendance && existingAttendance.status === 'late' && !existingAttendance.scannedCheckIn;

    const isScanLateTime = (() => {
      const { shiftStart } = database.getEmployeeShiftForDate(employee, eventDate);
      if (!shiftStart) return false;
      const [sh, sm] = shiftStart.split(':').map(Number);
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
      if (isLateCheckIn && newPunchType === 'in') {
        attendanceEntry.scannedCheckIn = true;
        attendanceEntry.status = "Late Check-in";
      }
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
  // Support pagination: ?page=1&limit=50 (default first 50, newest first)
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200); // cap at 200
  const all = database.getPendingMessages();
  // Newest first
  const sorted = [...all].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const start = (page - 1) * limit;
  const items = sorted.slice(start, start + limit);
  res.json({ items, total: all.length, page, limit, pages: Math.ceil(all.length / limit) });
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

    if (employee.status !== 'active') {
      return res.status(401).json({ error: "Access denied. Employee profile is inactive." });
    }

    let isPassValid = false;
    if (String(employee.passcode || '1234') === cleanPass) {
      isPassValid = true;
    } else if (employee.password && bcrypt.compareSync(cleanPass, employee.password)) {
      isPassValid = true;
    }

    if (!isPassValid) {
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
    const db = database.read();
    const uniqueDates = Array.from(new Set(db.attendance.map(a => a.date)));
    const reportDates = [];
    uniqueDates.forEach(dStr => {
      try {
        const d = new Date(dStr);
        const dayOfWeek = d.getUTCDay();
        if (dayOfWeek === 6) { // Saturday
          const dateNum = d.getUTCDate();
          const satIndex = Math.ceil(dateNum / 7);
          if (satIndex === 1 || satIndex === 3 || satIndex === 5) {
            reportDates.push(dStr);
          }
        } else if (dayOfWeek === 5) { // Friday
          const nextSat = new Date(d.getTime());
          nextSat.setUTCDate(nextSat.getUTCDate() + 1);
          const dateNum = nextSat.getUTCDate();
          const satIndex = Math.ceil(dateNum / 7);
          if (satIndex !== 1 && satIndex !== 3 && satIndex !== 5) {
            reportDates.push(dStr);
          }
        }
      } catch (e) {}
    });
    const uniqueReportDates = Array.from(new Set(reportDates)).sort((a, b) => b.localeCompare(a));
    return res.json({ fridays: uniqueReportDates });
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
    
    const reportDate = new Date(friday);
    const isSat = reportDate.getUTCDay() === 6;
    const dayNames = isSat
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
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

// Premium Travel Logs Export (Excel .xlsx Generator)
app.get('/api/export/travel/excel', (req, res) => {
  const { month, search } = req.query;

  try {
    const db = database.read();
    let logs = (db.attendance || []).filter(log =>
      log && log.date && log.travelHours && Number(log.travelHours) > 0
    );

    // Apply active month filter matching frontend live view
    if (month) {
      logs = logs.filter(log => log.date.startsWith(month));
    }

    // Apply active search filter matching frontend live view
    if (search) {
      const q = search.toLowerCase();
      logs = logs.filter(log =>
        log.employeeName.toLowerCase().includes(q) ||
        (log.siteName || '').toLowerCase().includes(q) ||
        (log.messageText || '').toLowerCase().includes(q)
      );
    }

    const employees = db.employees || [];
    const travelRatio = db.settings && db.settings.travelTimePaidRatio !== undefined
      ? Number(db.settings.travelTimePaidRatio)
      : 0.50;

    const getEmployeeShiftHours = (emp, dateStr = null) => {
      let F = 8.0;
      const { shiftStart, shiftEnd } = database.getEmployeeShiftForDate(emp, dateStr);
      if (shiftStart && shiftEnd) {
        try {
          const [startH, startM] = shiftStart.split(':').map(Number);
          const [endH, endM] = shiftEnd.split(':').map(Number);
          let shiftMinutes = (endH * 60 + endM) - (startH * 60 + startM);
          if (shiftMinutes < 0) shiftMinutes += 24 * 60;
          const shiftHours = shiftMinutes / 60;
          F = shiftHours >= 9.0 ? shiftHours - 1.0 : shiftHours;
        } catch (err) {}
      }
      return F;
    };

    const getHourlyRate = (emp) => {
      if (!emp) return 0;
      if (emp.hourlyRate) return Number(emp.hourlyRate);
      const shiftF = getEmployeeShiftHours(emp);
      if (emp.dailyRate) return Number((Number(emp.dailyRate) / shiftF).toFixed(2));
      const actualSalary = Number(emp.monthlyWage) || 0.0;
      const stdWorkingDays = Number(emp.stdWorkingDays) || 30;
      return Number((actualSalary / stdWorkingDays / shiftF).toFixed(2));
    };

    // 1. Generate Daily Logs sheet rows
    const dailyRows = [];
    logs.forEach(log => {
      const emp = employees.find(e => e.id === log.employeeId);
      const stated = Number(log.travelHours);
      const paid = Number((stated * travelRatio).toFixed(2));
      const rate = getHourlyRate(emp);
      const payout = Number((paid * rate).toFixed(2));

      dailyRows.push({
        "Date": log.date,
        "Employee Name": log.employeeName,
        "Designation": emp ? (emp.designation || 'Worker') : '—',
        "Work Site": log.siteName || '—',
        "Stated Hours": stated,
        "Paid Hours": paid,
        "Hourly Rate (₹/hr)": rate,
        "Travel Payout (₹)": payout,
        "WhatsApp Message Source": log.messageText || '—'
      });
    });

    // 2. Generate Monthly Summary sheet rows
    const summaryMap = {};
    logs.forEach(log => {
      const emp = employees.find(e => e.id === log.employeeId);
      const logMonth = log.date.substring(0, 7);
      const key = `${log.employeeId}__${logMonth}`;
      
      const stated = Number(log.travelHours);
      const paid = Number((stated * travelRatio).toFixed(2));
      const rate = getHourlyRate(emp);
      const payout = Number((paid * rate).toFixed(2));

      if (!summaryMap[key]) {
        summaryMap[key] = {
          employeeName: log.employeeName,
          designation: emp ? (emp.designation || 'Worker') : '—',
          month: logMonth,
          totalStated: 0,
          totalPaid: 0,
          hourlyRate: rate,
          totalPayout: 0,
          sites: new Set()
        };
      }
      const item = summaryMap[key];
      item.totalStated += stated;
      item.totalPaid += paid;
      item.totalPayout += payout;
      if (log.siteName && log.siteName !== '—' && log.siteName !== '-') {
        log.siteName.split('/').map(s => s.trim()).filter(Boolean).forEach(s => item.sites.add(s));
      }
    });

    const summaryRows = Object.values(summaryMap).map(row => {
      const [y, mo] = row.month.split('-').map(Number);
      const monthLabel = new Date(y, mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
      const sitesArr = Array.from(row.sites);
      const sitesStr = sitesArr.length > 0 ? sitesArr.join(', ') : '—';

      return {
        "Employee Name": row.employeeName,
        "Designation": row.designation,
        "Month": monthLabel,
        "Visited Work Sites": sitesStr,
        "Total Stated Hours": Number(row.totalStated.toFixed(2)),
        "Total Paid Hours": Number(row.totalPaid.toFixed(2)),
        "Hourly Rate (₹/hr)": Number(row.hourlyRate.toFixed(2)),
        "Total Travel Payout (₹)": Number(row.totalPayout.toFixed(2))
      };
    });

    // Sort summary chronologically (descending month) and alphabetically (ascending employee)
    summaryRows.sort((a, b) => {
      const mc = b.Month.localeCompare(a.Month);
      return mc !== 0 ? mc : a["Employee Name"].localeCompare(b["Employee Name"]);
    });

    // Sort daily chronologically (descending date) and alphabetically (ascending employee)
    dailyRows.sort((a, b) => b.Date.localeCompare(a.Date) || a["Employee Name"].localeCompare(b["Employee Name"]));

    const wb = XLSX.utils.book_new();
    const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    const wsDaily = XLSX.utils.json_to_sheet(dailyRows);

    // Auto-fit column widths
    const autofitColumns = (ws, rows) => {
      if (rows.length > 0) {
        const columns = Object.keys(rows[0]);
        ws['!cols'] = columns.map(col => {
          const maxCharLen = Math.max(
            col.length,
            ...rows.map(row => String(row[col] || '').length)
          );
          return { wch: Math.max(12, maxCharLen + 2) };
        });
      }
    };

    autofitColumns(wsSummary, summaryRows);
    autofitColumns(wsDaily, dailyRows);

    XLSX.utils.book_append_sheet(wb, wsSummary, "Monthly Travel Summary");
    XLSX.utils.book_append_sheet(wb, wsDaily, "Daily Travel Logs");

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileDateStr = getLocalDateString();
    
    let filename = `Travel_Time_Logs_Export_${fileDateStr}.xlsx`;
    if (month) {
      filename = `Travel_Time_Logs_Export_${month}_generated_${fileDateStr}.xlsx`;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
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
function hasFuzzyKeyword(query, keywords) {
  const cleanQuery = query.toLowerCase().trim();
  
  // 1. Direct substring check on the whole query first (handles missing spaces)
  for (const keyword of keywords) {
    if (cleanQuery.includes(keyword)) {
      return true;
    }
  }
  
  // 2. Word-by-word edit distance check for spelling typos
  const words = cleanQuery.split(/\s+/).map(w => w.replace(/[^\w]/g, ''));
  for (const word of words) {
    if (word.length < 3) continue;
    
    // Safeguard to prevent common words from matching unrelated keywords
    if (['worked', 'worker', 'hours', 'month', 'site', 'today'].includes(word)) {
      for (const keyword of keywords) {
        if (word === keyword) return true;
      }
      continue;
    }

    for (const keyword of keywords) {
      // Calculate max allowed distance based on word/keyword length to prevent false matches
      const minLen = Math.min(word.length, keyword.length);
      let allowedDistance = 2;
      if (minLen <= 3) allowedDistance = 0; // Short words must match exactly
      else if (minLen === 4) allowedDistance = 1; // 4-letter words can have max 1 typo
      
      if (levenshteinDistance(word, keyword) <= allowedDistance) {
        return true;
      }
    }
  }
  return false;
}

// AI Query Endpoint
app.post('/api/ai/query', async (req, res) => {
  try {
    const { query, history } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const cleanQuery = query.toLowerCase().trim();
    const today = new Date();
    const todayStr = getLocalDateString(today);
    
    // Parse target date and its label
    const targetDateObj = parseTargetDateFromQuery(cleanQuery, today);
    const targetDateStr = targetDateObj.dateStr;
    const dateLabel = targetDateObj.label; // e.g. "today", "yesterday", "last monday", "on 25-06-2026"

    const db = database.read();
    const employees = db.employees || [];
    
    // Load attendance logs for the target date
    const dailyLogs = database.getAttendanceForDate(targetDateStr) || [];

    // Check for Gemini API key (from process env or settings)
    const apiKey = process.env.GEMINI_API_KEY || (db.settings && db.settings.geminiApiKey);
    if (apiKey) {
      try {
        const todayObj = new Date(today);
        const prevMonthObj = new Date(todayObj.getFullYear(), todayObj.getMonth() - 1, 1);
        const startOfPrevMonth = getLocalDateString(prevMonthObj);
        
        // 1. Clean employees (active only)
        const cleanEmployees = (db.employees || [])
          .filter(e => e && e.status === 'active')
          .map(e => ({
            id: e.id,
            name: e.name,
            designation: e.designation || 'Staff',
            modeOfWork: e.modeOfWork || '—',
            dailyRate: e.dailyRate || 0,
            shiftStart: e.shiftStart || '09:00',
            shiftEnd: e.shiftEnd || '18:00',
            customShifts: e.customShifts || null
          }));

        // 2. Fetch logs for range (strip base64 images for token efficiency)
        const rawLogs = database.getAttendanceForRange(startOfPrevMonth, todayStr) || [];
        const cleanLogs = rawLogs.map(log => ({
          employeeId: log.employeeId,
          employeeName: log.employeeName,
          date: log.date,
          checkIn: log.checkIn,
          checkOut: log.checkOut,
          status: log.status,
          duration: log.duration || 0,
          regularHours: log.regularHours || 0,
          otHours: log.otHours || 0,
          isLate: !!log.isLate,
          isHalfDay: !!log.isHalfDay,
          calculatedWage: log.calculatedWage || 0,
          siteName: log.siteName || '—'
        }));

        // 3. Clean holidays
        const cleanHolidays = db.holidays || [];

        // 4. Construct lightweight context
        const context = {
          currentDate: todayStr,
          currentDayOfWeek: today.toLocaleDateString('en-US', { weekday: 'long' }),
          targetDateQuery: targetDateStr,
          targetDateLabel: dateLabel,
          employees: cleanEmployees,
          attendanceLogs: cleanLogs,
          holidays: cleanHolidays
        };

        const systemInstruction = `You are InterExt AI v1.0, the virtual assistant for the InterExt Attendance & Payroll Portal.
Your task is to analyze the user's query and the provided database context to answer their question correctly.
The user may make typos or grammatical errors (e.g. "presnt count", "salry summary", "who worked most hours"). Understand their intent and answer correctly.
If the user asks about "yesterday", "today", "tomorrow", a specific date, or a weekday, resolve it accurately relative to Today's date and Today's day of week.

Context:
- Today's date: ${context.currentDate}
- Today's day of week: ${context.currentDayOfWeek}
- Date queried by user (pre-parsed target date): ${context.targetDateQuery} (${context.targetDateLabel})
- Employee Directory: ${JSON.stringify(context.employees)}
- Attendance Logs (from ${startOfPrevMonth} to ${todayStr}): ${JSON.stringify(context.attendanceLogs)}
- Company Holidays: ${JSON.stringify(context.holidays)}

Instructions:
1. Think step-by-step to compute the answer (e.g., if asked for present count yesterday or on a specific day, filter logs for that day where status is completed/checked-in/Late Check-in/etc. If asked for payroll summary, sum calculated wages/advances for all employees in the month. If asked for top performers, aggregate working hours per employee and rank them).
2. Format your response in clean Markdown.
3. Be professional, friendly, and concise.
4. Output a JSON object containing:
   - "steps": An array of strings describing your analytical/thinking steps (2-4 steps).
   - "response": Your markdown formatted answer.

JSON Schema:
{
  "steps": ["step 1", "step 2"],
  "response": "Your markdown answer"
}`;

        // Build chat history contents for Gemini API (memory retention)
        const contents = [];
        if (history && Array.isArray(history) && history.length > 0) {
          history.forEach(h => {
            contents.push({
              role: h.role === 'model' ? 'model' : 'user',
              parts: [{ text: h.text }]
            });
          });
        } else {
          contents.push({
            role: 'user',
            parts: [{ text: `User Query: "${query}"` }]
          });
        }

        const requestBody = {
          contents: contents,
          systemInstruction: {
            parts: [
              {
                text: systemInstruction
              }
            ]
          },
          generationConfig: {
            responseMimeType: "application/json"
          }
        };

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          throw new Error(`Gemini API returned status: ${response.status} ${response.statusText}`);
        }

        const responseData = await response.json();
        const rawJsonText = responseData.candidates[0].content.parts[0].text;
        const result = JSON.parse(rawJsonText);
        
        return res.json({
          success: true,
          steps: result.steps || ["Query analyzed.", "Result generated."],
          response: result.response
        });
      } catch (geminiErr) {
        console.error("[AI Chatbot] Gemini API execution failed. Falling back to local classifier...", geminiErr);
        // Fall back to local classifier below
      }
    }

    // Local Fallback Classifier Path
    let steps = [];
    let responseText = "";

    // Helper functions for statuses
    const isPresent = (status, checkIn) => ['checked-in', 'completed', 'Late Check-in', 'Early Check-out', 'half-day leave'].includes(status) || (status === 'late' && checkIn);
    const isLeave = (status) => status === 'leave';
    const isAbsent = (status) => status === 'absent';

    // Define semantic keyword maps for intents
    const presentKeywords = ['present', 'presnt', 'attendance', 'atendance', 'here', 'marked', 'presents'];
    const absentKeywords = ['absent', 'absnt', 'missing', 'absentees', 'away', 'show', 'turned', 'absents'];
    const leaveKeywords = ['leave', 'leve', 'leaves', 'vacation', 'off', 'sick'];
    const payrollKeywords = ['payable', 'payabel', 'payroll', 'salary', 'salry', 'wage', 'wages', 'earnings', 'payout', 'payouts', 'amount', 'pay'];
    const cctvKeywords = ['cctv', 'camera', 'cam', 'cams', 'stream', 'feeds', 'video', 'feed', 'cameras', 'camra'];
    const helpKeywords = ['help', 'guide', 'use', 'check-in', 'clock-in', 'install', 'download', 'website', 'portal', 'features'];
    const excelKeywords = ['excel', 'excl', 'export', 'sheet', 'download', 'xlsx', 'report', 'file', 'spreadsheet'];
    
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const startOfMonthStr = `${year}-${month}-01`;

    // Find last report ending date (Friday or Saturday depending on week of the month)
    let lastReportDate = new Date(today);
    let foundReportDate = false;
    for (let i = 0; i < 14; i++) {
      const d = new Date(today.getTime());
      d.setDate(today.getDate() - i);
      const dayOfWeek = d.getUTCDay();
      if (dayOfWeek === 6) { // Saturday
        const dateNum = d.getUTCDate();
        const satIndex = Math.ceil(dateNum / 7);
        if (satIndex === 1 || satIndex === 3 || satIndex === 5) {
          lastReportDate = d;
          foundReportDate = true;
          break;
        }
      } else if (dayOfWeek === 5) { // Friday
        const nextSat = new Date(d.getTime());
        nextSat.setUTCDate(nextSat.getUTCDate() + 1);
        const dateNum = nextSat.getUTCDate();
        const satIndex = Math.ceil(dateNum / 7);
        if (satIndex !== 1 && satIndex !== 3 && satIndex !== 5) {
          lastReportDate = d;
          foundReportDate = true;
          break;
        }
      }
    }
    const lastFridayStr = getLocalDateString(lastReportDate);

    const isExcelRequested = hasFuzzyKeyword(cleanQuery, excelKeywords);
    
    let excelSuffixText = "";
    if (isExcelRequested) {
      excelSuffixText = `\n\n📊 **Excel Export Options:**\n` +
                        `• **[Download Attendance Log (Excel)](/api/export/excel?startDate=${startOfMonthStr}&endDate=${todayStr})**\n` +
                        `• **[Download Payroll Sheet (Excel)](/api/export/payroll/excel?startDate=${startOfMonthStr}&endDate=${todayStr})**\n` +
                        `• **[Download Welders Weekly Report (Excel)](/api/export/welders-weekly/excel?friday=${lastFridayStr})**\n` +
                        `*(Configured for date range: ${startOfMonthStr} to ${todayStr})*`;
    }

    // First: Check if the query is referring to a specific employee
    let matchedEmp = null;
    for (const emp of employees) {
      if (emp.name && cleanQuery.includes(emp.name.toLowerCase())) {
        matchedEmp = emp;
        break;
      }
    }
    
    // Fallback to fuzzy name lookup if name matches a specific word
    if (!matchedEmp) {
      const nameExclusions = ['who', 'the', 'and', 'for', 'are', 'was', 'day', 'out', 'late', 'work', 'pay', 'off', 'absent', 'leave', 'cctv', 'status', 'summary', 'today', 'month', 'week', 'year', 'excel', 'sheet', 'salary', 'payroll', 'wages', 'wage', 'payout', 'payouts', 'amount', 'present', 'absentees', 'leaves', 'holiday', 'holidays', 'camera', 'cams', 'stream', 'feeds', 'video', 'feed', 'website', 'portal', 'help', 'guide', 'use', 'report', 'xlsx', 'export', 'here', 'marked', 'presnt', 'atendance'];
      const queryWords = cleanQuery.split(/\s+/).map(w => w.replace(/[^\w]/g, ''));
      for (const word of queryWords) {
        if (word.length >= 3 && !nameExclusions.includes(word)) {
          matchedEmp = employees.find(e => e.name && e.name.toLowerCase().split(/\s+/).includes(word));
          if (matchedEmp) break;
        }
      }
    }

    // 0. Intent: Specific employee lookup (Highest priority to prevent keyword overlaps)
    if (matchedEmp) {
      steps = [
        `Searching registry for '${matchedEmp.name}'...`,
        "Retrieving shift and designation profiles...",
        "Aggregating monthly payroll ledger...",
        "Putting it all together..."
      ];

      const monthStr = today.toISOString().substring(0, 7);
      const startOfMonth = `${monthStr}-01`;
      const monthlyLogs = database.getAttendanceForRange(startOfMonth, todayStr) || [];
      const empLogs = monthlyLogs.filter(log => log.employeeId === matchedEmp.id);
      
      const presentCount = empLogs.filter(log => isPresent(log.status, log.checkIn)).length;
      const lateCount = empLogs.filter(log => log.isLate || log.status === 'late' || log.status === 'Late Check-in').length;
      const totalHours = empLogs.reduce((sum, log) => sum + ((log.duration || 0) / 60), 0);
      
      const payrollData = database.getMonthlySalarySheet(monthStr) || [];
      const payrollRow = payrollData.find(r => r.employeeId === matchedEmp.id) || {};

      const targetDateLog = dailyLogs.find(log => log.employeeId === matchedEmp.id);
      let targetDateStatus = "Absent / Not Checked In";
      if (targetDateLog) {
        if (targetDateLog.status === 'leave') targetDateStatus = "On Leave";
        else if (targetDateLog.status === 'late') targetDateStatus = "Late (Informed)";
        else if (targetDateLog.status === 'Late Check-in') targetDateStatus = `Late Check-in (Arrived at ${targetDateLog.checkIn ? new Date(targetDateLog.checkIn).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'unknown'})`;
        else if (targetDateLog.status === 'checked-in') targetDateStatus = `Checked In (Arrived at ${targetDateLog.checkIn ? new Date(targetDateLog.checkIn).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'unknown'})`;
        else if (targetDateLog.status === 'completed') targetDateStatus = `Completed Shift (Checked out at ${targetDateLog.checkOut ? new Date(targetDateLog.checkOut).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'unknown'})`;
        else if (targetDateLog.status === 'Early Check-out') targetDateStatus = `Early Check-out (Checked out at ${targetDateLog.checkOut ? new Date(targetDateLog.checkOut).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'unknown'})`;
      }
      
      // Direct Answer Helper based on query context
      let directAnswer = "";
      if (cleanQuery.includes("present") || cleanQuery.includes("here") || cleanQuery.includes("attend") || cleanQuery.includes("check")) {
        const isPresentOnDate = ['Checked In', 'Late Check-in', 'Completed Shift', 'Early Check-out'].some(s => targetDateStatus.startsWith(s));
        if (isPresentOnDate) {
          directAnswer = `✅ **Yes**, **${matchedEmp.name}** was **present** ${dateLabel}. (Status: *${targetDateStatus}*)`;
        } else if (targetDateStatus === 'Late (Informed)') {
          directAnswer = `⏳ **No**, **${matchedEmp.name}** did not check in ${dateLabel}. They were marked as **Late (Informed)**.`;
        } else if (targetDateStatus === 'On Leave') {
          directAnswer = `🌴 **No**, **${matchedEmp.name}** was not present ${dateLabel}. They were **On Leave**.`;
        } else {
          directAnswer = `❌ **No**, **${matchedEmp.name}** was not present ${dateLabel}. (Status: *${targetDateStatus}*)`;
        }
      } else if (cleanQuery.includes("absent") || cleanQuery.includes("missing") || cleanQuery.includes("not in") || cleanQuery.includes("not here")) {
        const isPresentOnDate = ['Checked In', 'Late Check-in', 'Completed Shift', 'Early Check-out'].some(s => targetDateStatus.startsWith(s));
        if (isPresentOnDate) {
          directAnswer = `❌ **No**, **${matchedEmp.name}** was not absent ${dateLabel}. They were **present** (Status: *${targetDateStatus}*).`;
        } else {
          directAnswer = `✅ **Yes**, **${matchedEmp.name}** was **absent/not in** ${dateLabel}. (Status: *${targetDateStatus}*)`;
        }
      } else if (cleanQuery.includes("leave") || cleanQuery.includes("off") || cleanQuery.includes("vacation")) {
        if (targetDateStatus === 'On Leave') {
          directAnswer = `🌴 **Yes**, **${matchedEmp.name}** was **on leave** ${dateLabel}.`;
        } else {
          directAnswer = `❌ **No**, **${matchedEmp.name}** was not on leave ${dateLabel}. (Status: *${targetDateStatus}*)`;
        }
      } else if (cleanQuery.includes("late")) {
        if (targetDateStatus.startsWith('Late Check-in') || targetDateStatus === 'Late (Informed)') {
          directAnswer = `⏰ **Yes**, **${matchedEmp.name}** was marked as **late** ${dateLabel}. (Status: *${targetDateStatus}*)`;
        } else {
          directAnswer = `✅ **No**, **${matchedEmp.name}** was not marked late ${dateLabel}. (Status: *${targetDateStatus}*)`;
        }
      } else if (cleanQuery.includes("phone") || cleanQuery.includes("contact") || cleanQuery.includes("mobile") || cleanQuery.includes("number")) {
        if (matchedEmp.phone) {
          directAnswer = `📞 The phone number of **${matchedEmp.name}** is **+${matchedEmp.phone}**.`;
        } else {
          directAnswer = `📞 There is no phone number listed in the registry for **${matchedEmp.name}**.`;
        }
      } else if (cleanQuery.includes("salary") || cleanQuery.includes("wage") || cleanQuery.includes("pay")) {
        const monthlyAmount = matchedEmp.monthlyWage || 0;
        const dailyAmount = matchedEmp.dailyRate || 0;
        directAnswer = `💰 The salary/wages of **${matchedEmp.name}** is **₹${monthlyAmount.toLocaleString('en-IN')}/month** (or **₹${dailyAmount.toFixed(2)}/day**).`;
      }

      if (directAnswer) {
        responseText = directAnswer;
      } else {
        responseText = `👤 **Employee Profile: ${matchedEmp.name}**\n\n` +
                       `• **Designation**: ${matchedEmp.designation || 'Staff'} (${matchedEmp.modeOfWork || 'Office Staff'})\n` +
                       `• **Phone Number**: ${matchedEmp.phone ? '+' + matchedEmp.phone : 'Not Available'}\n` +
                       `• **Wages**: ₹${(matchedEmp.dailyRate || 0).toFixed(2)}/day (or ₹${(matchedEmp.monthlyWage || 0).toLocaleString('en-IN')}/month)\n` +
                       `• **Standard Shift**: ${matchedEmp.shiftStart || '09:00'} to ${matchedEmp.shiftEnd || '18:00'}${matchedEmp.customShifts ? ' (Has Day Customizations)' : ''}\n` +
                       `• **Status**: ${matchedEmp.status.toUpperCase()}\n` +
                       `• **Attendance ${dateLabel}**: ${targetDateStatus}\n\n` +
                       `📊 **Monthly Stats (${today.toLocaleString('default', { month: 'long', year: 'numeric' })}):**\n` +
                       `• **Days Present**: ${presentCount} days\n` +
                       `• **Hours Worked**: ${totalHours.toFixed(2)} hours\n` +
                       `• **Late Days**: ${lateCount} days\n` +
                       `• **Net Salary (after advances)**: ₹${(payrollRow.netSalary || 0).toLocaleString('en-IN')}`;
      }
    }
    // 1. Intent: Present Count / Present List
    else if (hasFuzzyKeyword(cleanQuery, presentKeywords) && !hasFuzzyKeyword(cleanQuery, absentKeywords) && !cleanQuery.includes("late") && !cleanQuery.includes("summary")) {
      steps = [
        `Checking attendance records for ${dateLabel}...`,
        "Identifying marked 'Present' entries...",
        "Compiling complete present list...",
        "Putting it all together..."
      ];
      
      const presentLogs = dailyLogs.filter(log => isPresent(log.status, log.checkIn));
      const count = presentLogs.length;
      
      if (count === 0) {
        responseText = `**No staff members were marked present ${dateLabel}.**` + excelSuffixText;
      } else {
        const listItems = presentLogs.map((log, index) => `${index + 1}. **${log.employeeName}** (Status: ${log.status || 'Present'})`);
        responseText = `**${count} staff members were present ${dateLabel}:**\n\n` + listItems.join("\n") + excelSuffixText;
      }
    }
    // 2. Intent: Absent / Who didn't show up
    else if (hasFuzzyKeyword(cleanQuery, absentKeywords) || cleanQuery.includes("didn't show up") || cleanQuery.includes("did not show up") || cleanQuery.includes("no show")) {
      steps = [
        `Checking attendance records for ${dateLabel}...`,
        "Filtering absent employees...",
        "Compiling complete absent list...",
        "Putting it all together..."
      ];
      
      const activeEmployees = employees.filter(emp => emp.status === 'active');
      const presentIds = new Set(dailyLogs.filter(log => isPresent(log.status, log.checkIn)).map(log => log.employeeId));
      const leaveIds = new Set(dailyLogs.filter(log => isLeave(log.status)).map(log => log.employeeId));
      
      const absentEmployees = activeEmployees.filter(emp => !presentIds.has(emp.id) && !leaveIds.has(emp.id));
      const count = absentEmployees.length;
      
      if (count === 0) {
        responseText = `**Everyone showed up ${dateLabel}! No staff members were absent.**` + excelSuffixText;
      } else {
        const listItems = absentEmployees.map((emp, index) => `${index + 1}. **${emp.name}**`);
        responseText = `**${count} staff members didn't show up ${dateLabel} (absent):**\n\n` + listItems.join("\n") + excelSuffixText;
      }
    }
    // 3. Intent: Leave count / Who is on leave
    else if (hasFuzzyKeyword(cleanQuery, leaveKeywords)) {
      steps = [
        `Checking leave records for ${dateLabel}...`,
        "Identifying approved leaves...",
        "Compiling leave list...",
        "Putting it all together..."
      ];
      
      const leaveLogs = dailyLogs.filter(log => isLeave(log.status));
      const count = leaveLogs.length;
      
      if (count === 0) {
        responseText = `**No staff members were on leave ${dateLabel}.**` + excelSuffixText;
      } else {
        const listItems = leaveLogs.map((log, index) => `${index + 1}. **${log.employeeName}**`);
        responseText = `**${count} staff members were on leave ${dateLabel}:**\n\n` + listItems.join("\n") + excelSuffixText;
      }
    }
    // 4. Intent: Late arrivals on target date
    else if (cleanQuery.includes("late") && !cleanQuery.includes("month") && !cleanQuery.includes("rank")) {
      steps = [
        `Checking attendance records for ${dateLabel}...`,
        "Identifying late entries...",
        "Compiling late list...",
        "Putting it all together..."
      ];
      const lateLogs = dailyLogs.filter(log => log.isLate || log.status === 'late' || log.status === 'Late Check-in');
      const count = lateLogs.length;
      if (count === 0) {
        responseText = `**No staff members were marked late ${dateLabel}.**` + excelSuffixText;
      } else {
        const listItems = lateLogs.map((log, index) => `${index + 1}. **${log.employeeName}** (${log.checkIn ? 'scanned at ' + new Date(log.checkIn).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'informed late'})`);
        responseText = `**${count} staff members arrived late ${dateLabel}:**\n\n` + listItems.join("\n") + excelSuffixText;
      }
    }
    // 5. Intent: Payroll / Payable this month
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
      
      const payrollData = database.getMonthlySalarySheet(monthStr) || [];
      const totalPayable = payrollData.reduce((sum, r) => sum + (Number(r.earnedSalary) || 0), 0);
      const totalAdvances = payrollData.reduce((sum, r) => sum + (Number(r.salaryAdvance) || 0), 0);
      const totalNetPayable = payrollData.reduce((sum, r) => sum + (Number(r.netSalary) || 0), 0);
      
      responseText = `**Total net payable salary for this month (${currentMonthName}) is ₹${totalNetPayable.toLocaleString('en-IN')}.**\n\n**Breakdown:**\n• Gross Wages: ₹${totalPayable.toLocaleString('en-IN')}\n• Deductions/Advances: ₹${totalAdvances.toLocaleString('en-IN')}\n• Net Payable: ₹${totalNetPayable.toLocaleString('en-IN')}` + excelSuffixText;
    }
    // 6. Intent: Top performers / worked most hours
    else if (cleanQuery.includes("top performer") || cleanQuery.includes("most hours") || cleanQuery.includes("worked most") || cleanQuery.includes("best performer")) {
      steps = [
        "Fetching attendance logs for this month...",
        "Aggregating working hours per employee...",
        "Sorting in descending order...",
        "Putting it all together..."
      ];
      const monthStr = today.toISOString().substring(0, 7);
      const startOfMonth = `${monthStr}-01`;
      const monthlyLogs = database.getAttendanceForRange(startOfMonth, todayStr) || [];
      const hoursMap = {};
      monthlyLogs.forEach(log => {
        if (log.employeeId && log.duration) {
          hoursMap[log.employeeId] = (hoursMap[log.employeeId] || 0) + (log.duration / 60);
        }
      });
      const sortedPerformers = Object.entries(hoursMap)
        .map(([id, hours]) => {
          const emp = employees.find(e => e.id === id);
          return { name: emp ? emp.name : 'Unknown', hours: Number(hours.toFixed(2)) };
        })
        .sort((a, b) => b.hours - a.hours)
        .slice(0, 5);

      if (sortedPerformers.length === 0) {
        responseText = `**No working hours recorded for this month yet.**`;
      } else {
        const listItems = sortedPerformers.map((p, index) => `${index + 1}. **${p.name}**: ${p.hours} hours`);
        responseText = `🏆 **Top Performers (Most Hours Worked this Month):**\n\n` + listItems.join("\n");
      }
    }
    // 7. Intent: Overtime rankings this month
    else if (cleanQuery.includes("overtime rankings") || cleanQuery.includes("ot rankings") || cleanQuery.includes("most ot") || cleanQuery.includes("overtime this month")) {
      steps = [
        "Fetching monthly attendance records...",
        "Aggregating overtime hours per employee...",
        "Sorting rankings...",
        "Putting it all together..."
      ];
      const monthStr = today.toISOString().substring(0, 7);
      const startOfMonth = `${monthStr}-01`;
      const monthlyLogs = database.getAttendanceForRange(startOfMonth, todayStr) || [];
      const otMap = {};
      monthlyLogs.forEach(log => {
        if (log.employeeId && log.otHours) {
          otMap[log.employeeId] = (otMap[log.employeeId] || 0) + Number(log.otHours);
        }
      });
      const sortedOt = Object.entries(otMap)
        .map(([id, ot]) => {
          const emp = employees.find(e => e.id === id);
          return { name: emp ? emp.name : 'Unknown', ot: Number(ot.toFixed(2)) };
        })
        .filter(p => p.ot > 0)
        .sort((a, b) => b.ot - a.ot)
        .slice(0, 5);

      if (sortedOt.length === 0) {
        responseText = `**No overtime hours recorded for this month yet.**`;
      } else {
        const listItems = sortedOt.map((p, index) => `${index + 1}. **${p.name}**: ${p.ot} OT hours`);
        responseText = `⚡ **Overtime Rankings (Current Month):**\n\n` + listItems.join("\n");
      }
    }
    // 8. Intent: Late arrivals this month
    else if (cleanQuery.includes("late this month") || cleanQuery.includes("late arrivals this month") || cleanQuery.includes("who was late this month")) {
      steps = [
        "Fetching monthly attendance records...",
        "Aggregating late arrivals...",
        "Sorting rankings...",
        "Putting it all together..."
      ];
      const monthStr = today.toISOString().substring(0, 7);
      const startOfMonth = `${monthStr}-01`;
      const monthlyLogs = database.getAttendanceForRange(startOfMonth, todayStr) || [];
      const lateMap = {};
      monthlyLogs.forEach(log => {
        if (log.employeeId && (log.isLate || log.status === 'late' || log.status === 'Late Check-in')) {
          lateMap[log.employeeId] = (lateMap[log.employeeId] || 0) + 1;
        }
      });
      const sortedLate = Object.entries(lateMap)
        .map(([id, lates]) => {
          const emp = employees.find(e => e.id === id);
          return { name: emp ? emp.name : 'Unknown', lates: lates };
        })
        .sort((a, b) => b.lates - a.lates)
        .slice(0, 5);

      if (sortedLate.length === 0) {
        responseText = `**No late arrivals recorded for this month.**`;
      } else {
        const listItems = sortedLate.map((p, index) => `${index + 1}. **${p.name}**: ${p.lates} late arrivals`);
        responseText = `⏰ **Late Arrival Rankings (Current Month):**\n\n` + listItems.join("\n");
      }
    }
    // 9. Intent: Target Date Summary
    else if (cleanQuery.includes("summary") || cleanQuery.includes("stats") || cleanQuery.includes("headcount")) {
      steps = [
        `Analyzing attendance logs for ${dateLabel}...`,
        "Aggregating headcount metrics...",
        "Putting it all together..."
      ];
      const activeEmployees = employees.filter(emp => emp.status === 'active');
      const presentLogs = dailyLogs.filter(log => isPresent(log.status, log.checkIn));
      const leaveLogs = dailyLogs.filter(log => isLeave(log.status));
      const lateLogs = dailyLogs.filter(log => log.isLate || log.status === 'late' || log.status === 'Late Check-in');
      const absentCount = activeEmployees.length - presentLogs.length - leaveLogs.length;

      responseText = `📋 **Attendance Summary for ${dateLabel} (${targetDateStr}):**\n\n` +
                     `• **Total Active Staff**: ${activeEmployees.length}\n` +
                     `• **Present**: ${presentLogs.length} workers\n` +
                     `• **Absent**: ${Math.max(0, absentCount)} workers\n` +
                     `• **On Leave**: ${leaveLogs.length} workers\n` +
                     `• **Late Arrivals**: ${lateLogs.length} workers`;
    }
    // 10. Intent: Employee Count
    else if (cleanQuery.includes("employee count") || cleanQuery.includes("how many staff") || cleanQuery.includes("how many employees") || cleanQuery.includes("total employees")) {
      steps = [
        "Checking database employee registry...",
        "Counting active personnel...",
        "Putting it all together..."
      ];
      const activeCount = employees.filter(e => e.status === 'active').length;
      responseText = `👥 **Total Active Staff Count:**\n\nThere are currently **${activeCount} active employees** registered in the database.`;
    }
    // 11. Intent: Upcoming holidays
    else if (cleanQuery.includes("holiday") || cleanQuery.includes("holidays") || cleanQuery.includes("calendar")) {
      steps = [
        "Checking company holiday registry...",
        "Filtering upcoming calendar dates...",
        "Putting it all together..."
      ];
      const upcomingHolidays = (db.holidays || [])
        .filter(h => h.date >= todayStr)
        .sort((a, b) => a.date.localeCompare(b.date));

      if (upcomingHolidays.length === 0) {
        responseText = `**No upcoming holidays registered for the rest of the year.**`;
      } else {
        const listItems = upcomingHolidays.map(h => `• **${h.date}**: ${h.name}`);
        responseText = `📅 **Upcoming Holidays:**\n\n` + listItems.join("\n");
      }
    }
    // 12. Intent: Excel Exporter link request
    else if (isExcelRequested) {
      steps = [
        "Generating Excel export endpoints...",
        "Formatting spreadsheet download paths...",
        "Putting it all together..."
      ];
      responseText = `Here are the Excel download links compiled according to your needs:\n\n` +
                     `• **[Download Attendance Log (Excel)](/api/export/excel?startDate=${startOfMonthStr}&endDate=${todayStr})**\n` +
                     `• **[Download Payroll Sheet (Excel)](/api/export/payroll/excel?startDate=${startOfMonthStr}&endDate=${todayStr})**\n` +
                     `• **[Download Welders Weekly Report (Excel)](/api/export/welders-weekly/excel?friday=${lastFridayStr})**\n\n` +
                     `*(The date range has been pre-configured for you from ${startOfMonthStr} to ${todayStr})*`;
    }
    // 13. Intent: CCTV camera status
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
    // 13. Intent: Help / FAQs
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
    // 14. Default fallback help response
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
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use. Another server instance may be running. Exiting to allow PM2 to clean up and restart...`);
    process.exit(1);
  } else {
    console.error('[FATAL] Server error:', err);
    process.exit(1);
  }
});

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
            threshold: cam.threshold || 0.38
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
                threshold: cam.threshold || 0.38
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

