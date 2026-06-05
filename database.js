const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DB_PATH = path.join(__dirname, 'data.json');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const EXCEL_PATH = path.join(__dirname, 'Attendance_Payroll.xlsx');

// Default Database Schema with elegant seed data
const DEFAULT_DB = {
  employees: [],
  sites: [
    {
      id: "site_a",
      name: "Site A (Main Yard)",
      description: "Primary warehouse and logistic yard",
      createdAt: new Date().toISOString()
    },
    {
      id: "site_b",
      name: "Site B (North Construction)",
      description: "Residential construction zone block B",
      createdAt: new Date().toISOString()
    }
  ],
  attendance: [],
  settings: {
    whatsappGroupName: "Onsite Attendance Group",
    shiftStartTime: "08:00",
    shiftEndTime: "17:00",
    standardFullDayHours: 8.0,
    standardHalfDayHours: 4.0,
    basicRatio: 0.50,
    daRatio: 0.25,
    allowancesRatio: 0.25,
    overtimeRateMultiplier: 1.00,
    travelTimePaidRatio: 0.50,
    lopDeductionRate: 1.00,
    pfContributionRate: 12.00,
    esicContributionRate: 0.75,
    ptDeductionStandard: 200.00
  },
  pending_messages: [],
  selfies: [],
  holidays: [],
  processed_message_ids: [],
  cctvCameras: []
};

class Database {
  constructor() {
    this.init();
    this.isSyncingExcel = false;
    this.pendingExcelSync = false;
  }

  // Initialize DB file
  init() {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    if (!fs.existsSync(DB_PATH)) {
      this.writeAtomic(DEFAULT_DB);
    } else {
      try {
        // Test read
        JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      } catch (err) {
        console.error("Corrupted database file. Attempting recovery from backups...", err);
        this.recoverFromBackup() || this.writeAtomic(DEFAULT_DB);
      }
    }

    // Auto-seed exactly the 12 user-provided calendar holidays if missing, empty, or outdated
    const db = this.read();
    if (!db.holidays || db.holidays.length === 0 || db.holidays.some(h => h.name === "Mannam Jayanthi" || h.name === "Maundy Thursday")) {
      db.holidays = [
        { "date": "2026-01-26", "name": "Republic Day" },
        { "date": "2026-03-20", "name": "Ramzan" },
        { "date": "2026-04-03", "name": "Good Friday" },
        { "date": "2026-04-15", "name": "Vishu" },
        { "date": "2026-08-12", "name": "Karkidaka Vavu" },
        { "date": "2026-08-15", "name": "Independence Day" },
        { "date": "2026-08-24", "name": "Onam Celebration" },
        { "date": "2026-08-25", "name": "First Onam" },
        { "date": "2026-08-26", "name": "Thiruvonam" },
        { "date": "2026-10-02", "name": "Gandhi Jayanti" },
        { "date": "2026-10-20", "name": "Pooja (Mahanavami)" },
        { "date": "2026-12-25", "name": "Christmas Day" }
      ];
      this.writeAtomic(db);
      console.log(`[Database Init] Seeding calendar with exactly ${db.holidays.length} holidays from the company calendar.`);
    }
    
    // Ensure processed_message_ids array exists in existing databases
    if (!db.processed_message_ids) {
      db.processed_message_ids = [];
      this.writeAtomic(db);
    }
    
    // Perform initial Excel compilation on boot
    this.syncToExcel();
  }

  // Read DB safely
  read() {
    try {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error("Error reading database:", err);
      return DEFAULT_DB;
    }
  }

  // Write DB atomically to prevent corruption
  writeAtomic(data) {
    const tempPath = `${DB_PATH}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tempPath, DB_PATH);
      
      // Perform automated periodic backup (10% chance on write to avoid bloat)
      if (Math.random() < 0.1) {
        this.createBackup(data);
      }
      return true;
    } catch (err) {
      console.error("Atomic database write failed:", err);
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
      return false;
    }
  }

  // Create a database backup file
  createBackup(data) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(BACKUPS_DIR, `data-${timestamp}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(data, null, 2), 'utf8');
      
      // Rotate backups: keep only last 5 files
      const files = fs.readdirSync(BACKUPS_DIR)
        .map(f => ({ name: f, path: path.join(BACKUPS_DIR, f), time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime }))
        .sort((a, b) => b.time - a.time);
      
      if (files.length > 5) {
        for (let i = 5; i < files.length; i++) {
          fs.unlinkSync(files[i].path);
        }
      }
    } catch (err) {
      console.error("Backup creation failed:", err);
    }
  }

  // Recover from latest backup if main db corrupted
  recoverFromBackup() {
    try {
      if (!fs.existsSync(BACKUPS_DIR)) return false;
      const files = fs.readdirSync(BACKUPS_DIR)
        .map(f => ({ name: f, path: path.join(BACKUPS_DIR, f), time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime }))
        .sort((a, b) => b.time - a.time);

      for (const file of files) {
        try {
          const raw = fs.readFileSync(file.path, 'utf8');
          const parsed = JSON.parse(raw);
          this.writeAtomic(parsed);
          console.log(`Recovered database from backup: ${file.name}`);
          return true;
        } catch (e) {
          // Keep trying older backups
        }
      }
    } catch (err) {
      console.error("Backup recovery failed:", err);
    }
    return false;
  }

  // --- Employees Table ---
  getEmployees() {
    return (this.read().employees || []).filter(e => e && e.id && e.name);
  }

  saveEmployee(employee) {
    const db = this.read();
    const index = db.employees.findIndex(e => e.id === employee.id);
    
    if (index >= 0) {
      db.employees[index] = { ...db.employees[index], ...employee };
    } else {
      employee.id = employee.id || `emp_${Date.now()}`;
      employee.status = employee.status || 'active';
      employee.createdAt = employee.createdAt || new Date().toISOString();
      employee.dailyRate = Number(employee.dailyRate) || 0.0;
      employee.hourlyRate = Number(employee.hourlyRate) || 0.0;
      db.employees.push(employee);
    }
    
    this.writeAtomic(db);
    this.syncToExcelAsync();
    return employee;
  }

  deleteEmployee(id) {
    const db = this.read();
    db.employees = db.employees.filter(e => e.id !== id);
    this.writeAtomic(db);
    this.syncToExcelAsync();
  }

  // --- Sites Table ---
  getSites() {
    return (this.read().sites || []).filter(s => s && s.id && s.name);
  }

  saveSite(site) {
    const db = this.read();
    const index = db.sites.findIndex(s => s.id === site.id);
    
    if (index >= 0) {
      db.sites[index] = { ...db.sites[index], ...site };
    } else {
      site.id = site.id || `site_${Date.now()}`;
      site.createdAt = site.createdAt || new Date().toISOString();
      db.sites.push(site);
    }
    
    this.writeAtomic(db);
    this.syncToExcelAsync();
    return site;
  }

  deleteSite(id) {
    const db = this.read();
    db.sites = db.sites.filter(s => s.id !== id);
    this.writeAtomic(db);
    this.syncToExcelAsync();
  }

  // --- Settings Table ---
  getSettings() {
    return this.read().settings;
  }

  saveSettings(newSettings) {
    const db = this.read();
    
    // If the group name has changed, clear the stale group ID
    if (newSettings.whatsappGroupName !== undefined && newSettings.whatsappGroupName !== db.settings.whatsappGroupName) {
      db.settings.whatsappGroupId = "";
    }
    
    db.settings = { ...db.settings, ...newSettings };
    // Coerce settings numbers
    db.settings.standardFullDayHours = Number(db.settings.standardFullDayHours) || 8.0;
    db.settings.standardHalfDayHours = Number(db.settings.standardHalfDayHours) || 4.0;
    db.settings.basicRatio = Number(db.settings.basicRatio) !== undefined && !isNaN(Number(db.settings.basicRatio)) ? Number(db.settings.basicRatio) : 0.50;
    db.settings.daRatio = Number(db.settings.daRatio) !== undefined && !isNaN(Number(db.settings.daRatio)) ? Number(db.settings.daRatio) : 0.25;
    db.settings.allowancesRatio = Number(db.settings.allowancesRatio) !== undefined && !isNaN(Number(db.settings.allowancesRatio)) ? Number(db.settings.allowancesRatio) : 0.25;
    db.settings.overtimeRateMultiplier = Number(db.settings.overtimeRateMultiplier) !== undefined && !isNaN(Number(db.settings.overtimeRateMultiplier)) ? Number(db.settings.overtimeRateMultiplier) : 1.00;
    db.settings.travelTimePaidRatio = Number(db.settings.travelTimePaidRatio) !== undefined && !isNaN(Number(db.settings.travelTimePaidRatio)) ? Number(db.settings.travelTimePaidRatio) : 0.50;
    db.settings.lopDeductionRate = Number(db.settings.lopDeductionRate) !== undefined && !isNaN(Number(db.settings.lopDeductionRate)) ? Number(db.settings.lopDeductionRate) : 1.00;
    db.settings.pfContributionRate = Number(db.settings.pfContributionRate) !== undefined && !isNaN(Number(db.settings.pfContributionRate)) ? Number(db.settings.pfContributionRate) : 12.00;
    db.settings.esicContributionRate = Number(db.settings.esicContributionRate) !== undefined && !isNaN(Number(db.settings.esicContributionRate)) ? Number(db.settings.esicContributionRate) : 0.75;
    db.settings.ptDeductionStandard = Number(db.settings.ptDeductionStandard) !== undefined && !isNaN(Number(db.settings.ptDeductionStandard)) ? Number(db.settings.ptDeductionStandard) : 200.00;
    this.writeAtomic(db);
    this.syncToExcelAsync();
    return db.settings;
  }

  // --- Pending Messages Table ---
  getPendingMessages() {
    return this.read().pending_messages || [];
  }

  savePendingMessage(msg) {
    const db = this.read();
    msg.id = msg.id || `msg_${Date.now()}`;
    msg.timestamp = msg.timestamp || new Date().toISOString();
    
    if (!db.pending_messages) db.pending_messages = [];
    
    // De-duplicate by timestamp + text
    const exists = db.pending_messages.some(m => m.messageText === msg.messageText && m.sender === msg.sender);
    if (!exists) {
      db.pending_messages.push(msg);
      this.writeAtomic(db);
    }
    return msg;
  }

  deletePendingMessage(id) {
    const db = this.read();
    db.pending_messages = (db.pending_messages || []).filter(m => m.id !== id);
    this.writeAtomic(db);
  }

  // --- Processed Message IDs ---
  getProcessedMessageIds() {
    return this.read().processed_message_ids || [];
  }

  saveProcessedMessageId(id) {
    const db = this.read();
    if (!db.processed_message_ids) db.processed_message_ids = [];
    if (!db.processed_message_ids.includes(id)) {
      db.processed_message_ids.push(id);
      this.writeAtomic(db);
    }
  }

  saveProcessedMessageIds(ids) {
    const db = this.read();
    if (!db.processed_message_ids) db.processed_message_ids = [];
    let updated = false;
    for (const id of ids) {
      if (!db.processed_message_ids.includes(id)) {
        db.processed_message_ids.push(id);
        updated = true;
      }
    }
    if (updated) {
      this.writeAtomic(db);
    }
  }

  // --- Attendance Table with dynamic absenteeism & shift calculations ---
  
  // Calculate attendance hours and wages based on checkIn, checkOut, and employee rates
  calculateShift(employee, checkInTime, checkOutTime, record = null) {
    const settings = this.getSettings();
    const F = settings.standardFullDayHours; // Full Day Limit (e.g. 8)
    const h = settings.standardHalfDayHours; // Half Day Limit (e.g. 4)
    
    let dailyRate = Number(employee.dailyRate) || 0.0;
    let hourlyRate = Number(employee.hourlyRate) || 0.0;
    
    // Check if shift falls on a holiday (excluding Sundays)
    try {
      const checkInDate = new Date(checkInTime);
      const dateStr = checkInDate.toISOString().split('T')[0];
      const isSunday = checkInDate.getDay() === 0;
      const db = this.read();
      const holidays = db.holidays || [];
      const isHoliday = holidays.some(hol => hol.date === dateStr);
      
      const isOfficeStaff = employee.modeOfWork && employee.modeOfWork.toLowerCase().trim() === 'office staff';
      if (isHoliday && !isSunday && isOfficeStaff) {
        dailyRate = dailyRate * 2.0;
        hourlyRate = hourlyRate * 2.0;
      }
    } catch (e) {
      console.error("Failed to evaluate holiday rate multiplier:", e);
    }
    
    const checkIn = new Date(checkInTime);
    const checkOut = new Date(checkOutTime);
    
    // Total decimal hours worked
    let diffMs = checkOut - checkIn;
    
    // Deduct lunch break duration if both lunchOut and lunchIn are populated
    if (record && record.lunchOut && record.lunchIn) {
      const lOut = new Date(record.lunchOut);
      const lIn = new Date(record.lunchIn);
      const lunchDiffMs = lIn - lOut;
      if (lunchDiffMs > 0) {
        diffMs -= lunchDiffMs;
      }
    }
    
    const durationMinutes = Math.max(0, Math.floor(diffMs / 60000));
    const totalHours = Number((durationMinutes / 60).toFixed(2));
    
    let regularHours = 0.0;
    let otHours = 0.0;
    let extraHours = 0.0;
    let isHalfDay = false;
    let isFullDay = false;
    let calculatedWage = 0.0;
    
    const isOfficeStaff = employee.modeOfWork && employee.modeOfWork.toLowerCase().trim() === 'office staff';
    
    if (totalHours >= F) {
      // Full Day + Overtime
      isFullDay = true;
      regularHours = F;
      if (isOfficeStaff) {
        otHours = 0.0;
        calculatedWage = dailyRate;
      } else {
        const exactOT = totalHours - F;
        if (exactOT > 0) {
          const otMinutes = Math.round(exactOT * 60);
          if (otMinutes < 50) {
            otHours = 0.0;
          } else {
            const hoursPart = Math.floor(otMinutes / 60);
            const minutesPart = otMinutes % 60;
            otHours = minutesPart >= 50 ? hoursPart + 1.0 : hoursPart * 1.0;
          }
        } else {
          otHours = 0.0;
        }
        calculatedWage = Number((dailyRate + (otHours * (dailyRate / 10.0))).toFixed(2));
      }
    } else if (totalHours >= h) {
      // Half Day + Extra Hours
      isHalfDay = true;
      regularHours = h;
      if (isOfficeStaff) {
        extraHours = 0.0;
        calculatedWage = Number((dailyRate * 0.5).toFixed(2));
      } else {
        extraHours = Number((totalHours - h).toFixed(2));
        calculatedWage = Number(((dailyRate * 0.5) + (extraHours * hourlyRate)).toFixed(2));
      }
    } else {
      // Under Half-Day (Hourly rate)
      regularHours = totalHours;
      calculatedWage = Number((totalHours * hourlyRate).toFixed(2));
    }
    
    return {
      durationMinutes,
      totalHours,
      regularHours,
      otHours,
      extraHours,
      isHalfDay,
      isFullDay,
      calculatedWage
    };
  }

  // Get raw records in database
  getRawAttendance() {
    return this.read().attendance;
  }

  // Get attendance sheet for a specific date (YYYY-MM-DD)
  // Cross-references with active employees to dynamically add "Absent" entries
  getAttendanceForDate(dateStr) {
    const db = this.read();
    const employees = db.employees.filter(e => e.status === 'active');
    const logs = db.attendance.filter(log => log.date === dateStr);
    
    // Map out employees already logged
    const loggedMap = new Map();
    logs.forEach(log => {
      loggedMap.set(log.employeeId, log);
    });

    const fullSheet = [];

    // Process all active employees
    employees.forEach(emp => {
      if (loggedMap.has(emp.id)) {
        // Return existing record
        fullSheet.push(loggedMap.get(emp.id));
      } else {
        // Dynamically compute Absent record
        fullSheet.push({
          id: `abs_${emp.id}_${dateStr}`,
          employeeId: emp.id,
          employeeName: emp.name,
          siteName: "—",
          date: dateStr,
          checkIn: null,
          checkOut: null,
          duration: 0,
          regularHours: 0.0,
          otHours: 0.0,
          extraHours: 0.0,
          isHalfDay: false,
          isFullDay: false,
          calculatedWage: 0.0,
          messageText: "",
          status: "absent"
        });
      }
    });

    return fullSheet;
  }

  // Get attendance range for reporting/export
  getAttendanceForRange(startDateStr, endDateStr) {
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    const list = [];
    
    // Loop over each day in range
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const dailySheet = this.getAttendanceForDate(dateStr);
      list.push(...dailySheet);
    }
    
    return list;
  }

  // Camera attendance events are kept separately from the primary attendance sheet
  getCameraEvents() {
    const db = this.read();
    if (!db.cameraEvents) {
      db.cameraEvents = [];
      this.writeAtomic(db);
    }
    return db.cameraEvents;
  }

  saveCameraEvent(event) {
    const db = this.read();
    if (!db.cameraEvents) db.cameraEvents = [];

    // Ensure event metadata
    event.id = event.id || `cam_${Date.now()}`;
    event.employeeName = event.employeeName || '';
    event.eventType = event.eventType || 'entry';
    event.siteName = event.siteName || 'Office';
    event.timestamp = event.timestamp || new Date().toISOString();
    event.date = event.date || event.timestamp.split('T')[0];
    event.status = event.status || 'recorded';
    event.createdAt = event.createdAt || new Date().toISOString();

    // Save optional image bytes to a camera uploads folder
    if (event.imageBase64 && event.imageFilename) {
      try {
        const uploadsDir = path.join(__dirname, 'public', 'uploads', 'camera');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const cleanFilename = event.imageFilename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const filename = `${event.id}_${cleanFilename}`;
        const filepath = path.join(uploadsDir, filename);
        const buffer = Buffer.from(event.imageBase64, 'base64');
        fs.writeFileSync(filepath, buffer);
        event.imageUrl = `/uploads/camera/${filename}`;
      } catch (imgErr) {
        console.warn('[CameraEvent] Failed to save attached image:', imgErr.message);
      }
    }

    const existingIndex = db.cameraEvents.findIndex(e => e.id === event.id);
    if (existingIndex >= 0) {
      db.cameraEvents[existingIndex] = { ...db.cameraEvents[existingIndex], ...event };
    } else {
      db.cameraEvents.push(event);
    }

    this.writeAtomic(db);
    return event;
  }

  // CCTV camera management
  getCctvCameras() {
    const db = this.read();
    if (!db.cctvCameras) {
      db.cctvCameras = [];
      this.writeAtomic(db);
    }
    return db.cctvCameras;
  }

  saveCctvCamera(camera) {
    const db = this.read();
    if (!db.cctvCameras) db.cctvCameras = [];

    camera.id = camera.id || `cctv_${Date.now()}`;
    camera.name = camera.name || 'CCTV Camera';
    camera.source = camera.source || '';
    camera.siteId = camera.siteId || '';
    camera.eventType = camera.eventType || 'auto'; // 'entry', 'exit', or 'auto'
    camera.status = camera.status !== undefined ? camera.status : 'inactive'; // 'active' or 'inactive'
    camera.updatedAt = new Date().toISOString();

    const existingIndex = db.cctvCameras.findIndex(c => c.id === camera.id);
    if (existingIndex >= 0) {
      db.cctvCameras[existingIndex] = { ...db.cctvCameras[existingIndex], ...camera };
    } else {
      camera.createdAt = new Date().toISOString();
      db.cctvCameras.push(camera);
    }

    this.writeAtomic(db);
    return camera;
  }

  deleteCctvCamera(id) {
    const db = this.read();
    if (!db.cctvCameras) return false;

    const initialLength = db.cctvCameras.length;
    db.cctvCameras = db.cctvCameras.filter(c => c.id !== id);
    
    if (db.cctvCameras.length !== initialLength) {
      this.writeAtomic(db);
      return true;
    }
    return false;
  }

  // Save/Update attendance log
  // Handles manual adjustments and triggers shift calculations
  saveAttendance(record) {
    const db = this.read();
    const employee = db.employees.find(e => e.id === record.employeeId);
    
    if (!employee) {
      throw new Error(`Employee with ID ${record.employeeId} not found.`);
    }

    // Set defaults
    record.id = record.id || `att_${Date.now()}`;
    record.employeeName = employee.name;
    record.date = record.date || new Date().toISOString().split('T')[0];
    record.regularHours = Number(record.regularHours) || 0.0;
    record.otHours = Number(record.otHours) || 0.0;
    record.extraHours = Number(record.extraHours) || 0.0;
    record.isHalfDay = record.isHalfDay === true || record.isHalfDay === 'true';
    record.isFullDay = record.isFullDay === true || record.isFullDay === 'true';
    record.calculatedWage = Number(record.calculatedWage) || 0.0;
    record.travelHours = Number(record.travelHours) || 0.0;

    // Check if check-out time is supplied and check-in exists. If so, calculate math if not explicitly overridden by manual edit
    if (record.checkIn && record.checkOut && !record.isManualOverride) {
      const shiftMath = this.calculateShift(employee, record.checkIn, record.checkOut, record);
      record.duration = shiftMath.durationMinutes;
      record.regularHours = shiftMath.regularHours;
      record.otHours = shiftMath.otHours;
      record.extraHours = shiftMath.extraHours;
      record.isHalfDay = shiftMath.isHalfDay;
      record.isFullDay = shiftMath.isFullDay;
      record.calculatedWage = shiftMath.calculatedWage;
      record.status = "completed";
    } else if (record.checkIn && !record.checkOut) {
      // Active check-in
      record.duration = 0;
      record.regularHours = 0.0;
      record.otHours = 0.0;
      record.extraHours = 0.0;
      record.isHalfDay = false;
      record.isFullDay = false;
      record.calculatedWage = 0.0;
      record.status = "checked-in";
    }

    // Insert or update
    const index = db.attendance.findIndex(a => a.id === record.id || (a.employeeId === record.employeeId && a.date === record.date));
    if (index >= 0) {
      db.attendance[index] = { ...db.attendance[index], ...record };
    } else {
      db.attendance.push(record);
    }

    this.writeAtomic(db);
    this.syncToExcelAsync();
    return record;
  }

  // Check-in or Check-out directly by employee name & site name (from parser)
  // Handles linking or flags it
  recordSingleFromWhatsApp(parsedData, rawText, messageTimestamp = null) {
    let db = this.read();
    
    // Auto-registration from text messages is disabled to prevent message text/phrases (e.g., "Good morning") from creating garbage employee profiles.
    // Any unrecognized names will go to the Exception Resolution Board for manual review and mapping.

    if (!parsedData.isSuccess) {
      // Flag message for manual admin review
      return this.savePendingMessage({
        sender: parsedData.rawSender || "Unknown",
        messageText: rawText,
        reason: parsedData.reason || "Unable to extract details",
        extractedName: parsedData.extractedName,
        extractedSite: parsedData.extractedSite,
        extractedAction: parsedData.extractedAction,
        extractedTime: parsedData.extractedTime
      });
    }

    const employee = (db.employees || []).find(e => e && e.id === parsedData.matchedEmployeeId);
    const site = (db.sites || []).find(s => s && s.id === parsedData.matchedSiteId) || { name: parsedData.extractedSite || "Main Site" };
    
    if (!employee) {
      return this.savePendingMessage({
        sender: parsedData.rawSender || "Unknown",
        messageText: rawText,
        reason: "Worker name unrecognized in directory",
        extractedName: parsedData.extractedName,
        extractedSite: site.name,
        extractedAction: parsedData.extractedAction,
        extractedTime: parsedData.extractedTime
      });
    }

    const todayStr = messageTimestamp
      ? new Date(messageTimestamp).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    
    // Determine target attendance log date from the parsed timestamps (or fallback to today)
    let targetDateStr = todayStr;
    if (parsedData.checkInTime) {
      targetDateStr = parsedData.checkInTime.split('T')[0];
    } else if (parsedData.checkOutTime) {
      targetDateStr = parsedData.checkOutTime.split('T')[0];
    }

    const existingLogIndex = db.attendance.findIndex(a => a.employeeId === employee.id && a.date === targetDateStr);

    // Dynamic timestamp helpers to align defaults with the target date
    const getFallbackTimestamp = () => {
      const fallbackBase = messageTimestamp ? new Date(messageTimestamp) : new Date();
      const timePart = fallbackBase.toTimeString().split(' ')[0]; // HH:MM:SS
      try {
        return new Date(`${targetDateStr}T${timePart}`).toISOString();
      } catch (e) {
        return fallbackBase.toISOString();
      }
    };

    if (parsedData.extractedAction === 'completed') {
      // Option 1 Completed Range (Both times supplied in single text)
      const record = {
        employeeId: employee.id,
        employeeName: employee.name,
        siteName: site.name,
        date: targetDateStr,
        checkIn: parsedData.checkInTime,
        checkOut: parsedData.checkOutTime,
        messageText: rawText,
        status: "completed",
        travelHours: parsedData.travelHours || 0.0
      };
      return this.saveAttendance(record);
    } else if (parsedData.extractedAction === 'leave') {
      // Record clean Leave log
      const targetDate = parsedData.leaveDate || targetDateStr;
      const record = {
        employeeId: employee.id,
        employeeName: employee.name,
        siteName: site.name || "—",
        date: targetDate,
        checkIn: null,
        checkOut: null,
        duration: 0,
        regularHours: 0.0,
        otHours: 0.0,
        extraHours: 0.0,
        isHalfDay: false,
        isFullDay: false,
        calculatedWage: 0.0,
        messageText: rawText,
        status: "leave",
        travelHours: 0.0
      };
      return this.saveAttendance(record);
    } else if (parsedData.extractedAction === 'in') {
      // Create new check-in
      const record = {
        employeeId: employee.id,
        employeeName: employee.name,
        siteName: site.name,
        date: targetDateStr,
        checkIn: parsedData.checkInTime || getFallbackTimestamp(),
        checkOut: null,
        messageText: rawText,
        status: "checked-in",
        travelHours: parsedData.travelHours || 0.0
      };
      return this.saveAttendance(record);
    } else if (parsedData.extractedAction === 'out') {
      const timestamp = parsedData.checkOutTime || getFallbackTimestamp();
      if (existingLogIndex >= 0) {
        const existing = db.attendance[existingLogIndex];
        // Apply check-out
        existing.checkOut = timestamp;
        existing.messageText += ` | ${rawText}`;
        if (parsedData.travelHours) {
          existing.travelHours = (existing.travelHours || 0.0) + parsedData.travelHours;
        }
        return this.saveAttendance(existing);
      } else {
        // Checked out without checking in! Mark as flagged/pending review
        return this.savePendingMessage({
          sender: parsedData.rawSender || "Unknown",
          messageText: rawText,
          reason: "Checked out without matching check-in",
          extractedName: employee.name,
          extractedSite: site.name,
          extractedAction: "out",
          extractedTime: parsedData.extractedTime,
          extractedDate: targetDateStr
        });
      }
    }
  }

  // Handles both single items and supervisor list items
  recordFromWhatsApp(parsedData, rawText, messageTimestamp = null) {
    if (parsedData.isList) {
      // Option 2: Supervisor Consolidated Line List
      const logs = [];
      parsedData.items.forEach(item => {
        try {
          const logged = this.recordSingleFromWhatsApp(item, item.originalLineText || rawText, messageTimestamp);
          if (logged) logs.push(logged);
        } catch (e) {
          console.error("Failed to log worker line from list:", e);
        }
      });
      return logs;
    } else {
      // Standard Single check-in/out range text
      return this.recordSingleFromWhatsApp(parsedData, rawText, messageTimestamp);
    }
  }

  // Auto-close outstanding check-ins from previous days
  autoCloseOutstandingShifts() {
    const db = this.read();
    const settings = this.getSettings();
    const todayStr = new Date().toISOString().split('T')[0];
    
    // Find all attendance records from previous days that are still "checked-in"
    const pendingLogs = db.attendance.filter(log => log.date < todayStr && log.status === 'checked-in');
    
    if (pendingLogs.length === 0) return 0;
    
    let closedCount = 0;
    pendingLogs.forEach(log => {
      const employee = db.employees.find(e => e.id === log.employeeId);
      if (!employee) return;
      
      // Auto checkout at the scheduled shiftEndTime
      const endTime = settings.shiftEndTime || "17:00";
      const autoCheckoutTimestamp = `${log.date}T${endTime}:00.000Z`;
      
      log.checkOut = autoCheckoutTimestamp;
      log.messageText = log.messageText ? `${log.messageText} | [System Auto-Checkout: Missed check-out]` : "[System Auto-Checkout: Missed check-out]";
      
      const index = db.attendance.findIndex(a => a.id === log.id);
      if (index >= 0) {
        try {
          const shiftMath = this.calculateShift(employee, log.checkIn, log.checkOut, log);
          db.attendance[index] = {
            ...db.attendance[index],
            checkOut: log.checkOut,
            duration: shiftMath.durationMinutes,
            regularHours: shiftMath.regularHours,
            otHours: shiftMath.otHours,
            extraHours: shiftMath.extraHours,
            isHalfDay: shiftMath.isHalfDay,
            isFullDay: shiftMath.isFullDay,
            calculatedWage: shiftMath.calculatedWage,
            messageText: log.messageText,
            status: "completed"
          };
          closedCount++;
        } catch (e) {
          console.error(`Failed to auto-close shift for ${employee.name}:`, e);
        }
      }
    });
    
    if (closedCount > 0) {
      this.writeAtomic(db);
      this.syncToExcel();
      console.log(`[Auto-Closeout] Successfully finalized ${closedCount} active check-ins from previous days.`);
    }
    return closedCount;
  }

  // --- Asynchronous Background Excel Sync Queue ---
  syncToExcelAsync() {
    if (this.isSyncingExcel) {
      this.pendingExcelSync = true;
      return;
    }
    
    this.isSyncingExcel = true;
    
    setTimeout(() => {
      try {
        this.syncToExcel();
      } catch (err) {
        console.error("[Excel Sync Async] Background compilation failed:", err);
      } finally {
        this.isSyncingExcel = false;
        if (this.pendingExcelSync) {
          this.pendingExcelSync = false;
          this.syncToExcelAsync();
        }
      }
    }, 50);
  }

  // --- Live Excel Compile Engine ---
  syncToExcel() {
    console.log("[Excel Sync] Recompiling Attendance_Payroll.xlsx...");
    try {
      const db = this.read();
      
      // Find all unique dates logged in attendance (ascending order chronologically)
      const uniqueDates = Array.from(new Set(db.attendance.map(a => a.date)))
        .sort((a, b) => a.localeCompare(b));
      
      // If no unique dates logged but employees exist, log at least today's absent list
      if (uniqueDates.length === 0) {
        uniqueDates.push(new Date().toISOString().split('T')[0]);
      }

      const excelRows = [];

      uniqueDates.forEach(dateStr => {
        // Fetch completed dynamic attendance sheet for that date (includes Absent/Excused)
        const dailySheet = this.getAttendanceForDate(dateStr);
        
        // Sort alphabetically by worker name
        dailySheet.sort((a, b) => a.employeeName.localeCompare(b.employeeName));

        dailySheet.forEach(row => {
          let dayName = "—";
          try {
            // Compute Weekday Name
            dayName = new Date(row.date).toLocaleDateString('en-US', { weekday: 'long' });
          } catch(e) {}

          const inStr = row.checkIn ? new Date(row.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : "—";
          let outStr = "—";
          if (row.checkOut) {
            outStr = new Date(row.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          } else if (row.status === 'checked-in') {
            outStr = "Currently Checked-In";
          }

          const hoursDecimal = row.status === 'absent' || row.status === 'leave' ? 0.0 : Number((row.duration / 60).toFixed(2));

          excelRows.push({
            "Date": row.date,
            "Day of Week": dayName,
            "Worker Name": row.employeeName,
            "Duty Status": row.status.toUpperCase(),
            "Work Site Location": row.siteName,
            "Check-In Time": inStr,
            "Check-Out Time": outStr,
            "Total Hours Worked": hoursDecimal,
            "Full-Day Payout Credits": row.isFullDay ? 1 : 0,
            "Half-Day Payout Credits": row.isHalfDay ? 1 : 0,
            "Extra Hours (Post Half-Day)": row.extraHours || 0.0,
            "Overtime Hours (Post Full-Day)": row.otHours || 0.0,
            "Travel Hours Paid": row.travelHours || 0.0,
            "Calculated Wages (₹)": row.calculatedWage || 0.0,
            "WhatsApp Text Source": row.messageText || "—",
            "Administrative Notes": row.notes || (row.status === 'absent' ? "Auto-Marked Absent (Missing text)" : "")
          });
        });
      });

      // Write compiled data using SheetJS
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
      
      // Atomic Excel file update
      const tempExcelPath = `${EXCEL_PATH}.tmp`;
      XLSX.writeFile(wb, tempExcelPath, { bookType: 'xlsx' });
      
      if (fs.existsSync(EXCEL_PATH)) {
        fs.unlinkSync(EXCEL_PATH);
      }
      fs.renameSync(tempExcelPath, EXCEL_PATH);
      console.log(`[Excel Sync] Spreadsheet updated successfully at: ${EXCEL_PATH}`);
      return true;
    } catch (err) {
      console.error("[Excel Sync] Sync failed:", err);
      return false;
    }
  }

  // --- Monthly Payroll summary and persistence ---
  getPayrollAdjustments(monthStr) {
    const db = this.read();
    if (!db.payroll) return [];
    return db.payroll.filter(p => p && p.month === monthStr);
  }

  savePayrollAdjustment(adj) {
    const db = this.read();
    if (!db.payroll) db.payroll = [];
    
    // Ensure unique ID by combining employeeId and month
    const id = `pay_${adj.employeeId}_${adj.month}`;
    adj.id = id;
    
    const index = db.payroll.findIndex(p => p.id === id);
    if (index >= 0) {
      db.payroll[index] = { ...db.payroll[index], ...adj };
    } else {
      db.payroll.push(adj);
    }
    
    this.writeAtomic(db);
    return adj;
  }

  getMonthlySalarySheet(startDate, endDate = null) {
    if (!endDate) {
      // It's a monthStr (e.g. "2026-03")
      const monthStr = startDate;
      const parts = monthStr.split('-');
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]);
      const numDays = new Date(year, month, 0).getDate();
      startDate = `${monthStr}-01`;
      endDate = `${monthStr}-${String(numDays).padStart(2, '0')}`;
    }
    const monthStr = startDate.substring(0, 7);
    const db = this.read();
    const employees = (db.employees || []).filter(e => e && e.status === 'active');
    const adjs = this.getPayrollAdjustments(monthStr);
    const settings = this.getSettings();

    // Default configuration factors
    const basicRatio = settings.basicRatio !== undefined ? Number(settings.basicRatio) : 0.50;
    const daRatio = settings.daRatio !== undefined ? Number(settings.daRatio) : 0.25;
    const allowancesRatio = settings.allowancesRatio !== undefined ? Number(settings.allowancesRatio) : 0.25;
    const overtimeRateMultiplier = settings.overtimeRateMultiplier !== undefined ? Number(settings.overtimeRateMultiplier) : 1.00;
    const lopDeductionRate = settings.lopDeductionRate !== undefined ? Number(settings.lopDeductionRate) : 1.00;
    const pfContributionRate = settings.pfContributionRate !== undefined ? Number(settings.pfContributionRate) : 12.00;
    const esicContributionRate = settings.esicContributionRate !== undefined ? Number(settings.esicContributionRate) : 0.75;
    const ptDeductionStandard = settings.ptDeductionStandard !== undefined ? Number(settings.ptDeductionStandard) : 200.00;
    
    const attendanceLogs = this.getAttendanceForRange(startDate, endDate);
    
    return employees.map(emp => {
      // Find saved adjustments
      const adj = adjs.find(a => a.employeeId === emp.id) || {};
      
      const isOfficeStaff = emp.modeOfWork && emp.modeOfWork.toLowerCase().trim() === 'office staff';
      const isDailyWageWorker = !isOfficeStaff;
      
      const defaultStdDays = isOfficeStaff ? 30 : 26;
      
      // Count present days from logs
      const empLogs = attendanceLogs.filter(log => log.employeeId === emp.id);
      const presentCount = empLogs.filter(log => log.status === 'completed' || log.status === 'checked-in').length;
      
      // Default std working days (for daily wage workers, default standard working days is the actual days present)
      const stdWorkingDays = adj.stdWorkingDays !== undefined ? Number(adj.stdWorkingDays) : (isDailyWageWorker ? presentCount : defaultStdDays);
      
      let actualSalary = 0.0;
      let basic = 0.0;
      let da = 0.0;
      let allowances = 0.0;
      let dailyRate = 0.0;
      let dailyBasic = 0.0;
      let dailyDa = 0.0;
      let dailyAllowances = 0.0;
      let lopDays = 0;
      let lopAmount = 0.0;
      let workingDays = 0;
      let amount = 0.0;

      if (isDailyWageWorker) {
        dailyRate = Number(emp.dailyRate) || 0.0;
        workingDays = stdWorkingDays; // standard working days input represents present days
        amount = Number((dailyRate * workingDays).toFixed(2));
      } else {
        actualSalary = Number(emp.monthlyWage) || (Number(emp.dailyRate) * stdWorkingDays) || 0.0;
        basic = Number((actualSalary * basicRatio).toFixed(2));
        da = Number((actualSalary * daRatio).toFixed(2));
        allowances = Number((actualSalary * allowancesRatio).toFixed(2));
        
        dailyRate = Number((actualSalary / stdWorkingDays).toFixed(2));
        dailyBasic = Number((basic / stdWorkingDays).toFixed(2));
        dailyDa = Number((da / stdWorkingDays).toFixed(2));
        dailyAllowances = Number((allowances / stdWorkingDays).toFixed(2));
        
        const absentCount = empLogs.filter(log => log.status === 'absent').length;
        lopDays = adj.lopDays !== undefined ? Number(adj.lopDays) : absentCount;
        lopAmount = Number((lopDays * dailyRate * lopDeductionRate).toFixed(2));
        workingDays = Number((stdWorkingDays - lopDays).toFixed(2));
        amount = Number((actualSalary * (workingDays / stdWorkingDays)).toFixed(2));
      }
      
      const hourlyRate = Number(emp.hourlyRate) || Number((dailyRate / 8.0).toFixed(2)) || 0.0;
      
      // OT Hours: Sum of otHours from logs (unless overridden)
      let defaultOtHours = 0.0;
      if (!isOfficeStaff) {
        empLogs.forEach(log => {
          if (log.status === 'completed' && log.otHours > 0) {
            defaultOtHours += Number(log.otHours);
          }
        });
      }
      
      const otHours = adj.otHours !== undefined ? Number(adj.otHours) : Number(defaultOtHours.toFixed(2));
      const otPayout = isDailyWageWorker
        ? Number((otHours * (dailyRate / 10.0)).toFixed(2))
        : Number((otHours * hourlyRate * overtimeRateMultiplier).toFixed(2));
      
      // Travel Time Hours
      let defaultTravelHours = 0.0;
      empLogs.forEach(log => {
        if (log.travelHours) {
          defaultTravelHours += Number(log.travelHours);
        }
      });
      const travelTimeHours = adj.travelTimeHours !== undefined ? Number(adj.travelTimeHours) : Number(defaultTravelHours.toFixed(2));
      const travelTimePayout = Number((travelTimeHours * hourlyRate).toFixed(2));
      
      // Extra Days
      const extraDays = adj.extraDays !== undefined ? Number(adj.extraDays) : 0.0;
      const extraDaysAmount = Number((extraDays * dailyRate).toFixed(2));
      
      // Missing Days
      const missingDays = adj.missingDays !== undefined ? Number(adj.missingDays) : 0.0;
      const missingDaysAmount = Number((missingDays * dailyRate).toFixed(2));
      
      // Holiday Days Worked
      let defaultHolidayDaysWorked = 0;
      if (isOfficeStaff) {
        empLogs.forEach(log => {
          if (log.status === 'completed' || log.status === 'checked-in') {
            const dateStr = log.date;
            try {
              const isSunday = new Date(dateStr).getDay() === 0;
              const isHoliday = (db.holidays || []).some(h => h.date === dateStr);
              if (isHoliday && !isSunday) {
                defaultHolidayDaysWorked++;
              }
            } catch(e) {}
          }
        });
      }
      
      const holidayDaysWorked = isDailyWageWorker ? 0 : (adj.holidayDaysWorked !== undefined ? Number(adj.holidayDaysWorked) : defaultHolidayDaysWorked);
      const holidayBonus = isDailyWageWorker ? 0.00 : Number((holidayDaysWorked * dailyRate).toFixed(2));
      
      // Earned Salary = amount + OT(Amount) + Travel Time( Amount) + Extra days Amount + Missing days(Amount) + Holiday Bonus
      const earnedSalary = Number((amount + otPayout + travelTimePayout + extraDaysAmount + missingDaysAmount + holidayBonus).toFixed(2));
      
      // Deductions (Advance Paid)
      const salaryAdvance = adj.salaryAdvance !== undefined ? Number(adj.salaryAdvance) : 0.0;
      
      // Net Salary = Earned Salary (Gross Payable) - Advance Paid
      const netSalary = Number((earnedSalary - salaryAdvance).toFixed(2));
      
      return {
        employeeId: emp.id,
        employeeName: emp.name,
        userId: emp.userId || "—",
        modeOfWork: emp.modeOfWork || "—",
        actualSalary,
        basic,
        dailyBasic,
        da,
        dailyDa,
        allowances,
        dailyAllowances,
        stdWorkingDays,
        lopDays,
        lopAmount,
        workingDays,
        amount,
        otHours,
        otPayout,
        travelTimeHours,
        travelTimePayout,
        extraDays,
        extraDaysAmount,
        missingDays,
        missingDaysAmount,
        earnedSalary,
        holidayDaysWorked,
        holidayBonus,
        salaryAdvance,
        netSalary,
        company: emp.paymentMode || "—",
        notes: adj.notes || "",
        dailyRate
      };
    });
  }

  // --- Holidays Collection CRUD ---
  getHolidays() {
    const db = this.read();
    if (!db.holidays) {
      db.holidays = [];
      this.writeAtomic(db);
    }
    return db.holidays;
  }

  saveHoliday(holiday) {
    const db = this.read();
    if (!db.holidays) db.holidays = [];
    
    // De-duplicate / update by date
    const index = db.holidays.findIndex(h => h.date === holiday.date);
    if (index >= 0) {
      db.holidays[index] = { ...db.holidays[index], ...holiday };
    } else {
      db.holidays.push(holiday);
    }
    
    // Sort chronologically
    db.holidays.sort((a, b) => a.date.localeCompare(b.date));
    
    this.writeAtomic(db);
    this.syncToExcelAsync();
    return holiday;
  }

  deleteHoliday(date) {
    const db = this.read();
    if (!db.holidays) return;
    
    db.holidays = db.holidays.filter(h => h.date !== date);
    this.writeAtomic(db);
    this.syncToExcelAsync();
  }

  // --- Selfie Verification Array ---
  getSelfies() {
    const db = this.read();
    if (!db.selfies) {
      db.selfies = [];
      this.writeAtomic(db);
    }
    return db.selfies;
  }

  saveSelfie(selfie) {
    const db = this.read();
    if (!db.selfies) db.selfies = [];
    
    const index = db.selfies.findIndex(s => s.id === selfie.id);
    if (index >= 0) {
      db.selfies[index] = { ...db.selfies[index], ...selfie };
    } else {
      selfie.id = selfie.id || `selfie_${Date.now()}`;
      selfie.createdAt = new Date().toISOString();
      db.selfies.push(selfie);
    }
    this.writeAtomic(db);
    return selfie;
  }

  async verifyAndSaveSelfie(messageId, senderPhone, caption, base64Data, mimetype, msgTimestamp) {
    const db = this.read();
    if (!db.selfies) db.selfies = [];

    let buffer = Buffer.from(base64Data, 'base64');
    let ext = mimetype.split('/')[1] || 'jpg';
    let activeMime = mimetype;
    
    if (mimetype.toLowerCase().includes('heic') || mimetype.toLowerCase().includes('heif') || ext.toLowerCase() === 'heic' || ext.toLowerCase() === 'heif') {
      try {
        console.log(`[Selfie Verifier] HEIC image detected. Converting to JPEG on-the-fly...`);
        const heicConvert = require('heic-convert');
        const jpegBuffer = await heicConvert({
          buffer: buffer,
          format: 'JPEG',
          quality: 0.8
        });
        buffer = jpegBuffer;
        ext = 'jpeg';
        activeMime = 'image/jpeg';
        console.log(`[Selfie Verifier] HEIC image successfully converted to JPEG.`);
      } catch (convErr) {
        console.error(`[Selfie Verifier] Failed to convert HEIC to JPEG:`, convErr.message);
      }
    }
    
    // 1. Save the selfie file to static folder
    const selfieDir = path.join(__dirname, 'public', 'uploads', 'selfies');
    if (!fs.existsSync(selfieDir)) {
      fs.mkdirSync(selfieDir, { recursive: true });
    }
    
    // Clean messageId for filename
    const cleanMsgId = messageId.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${cleanMsgId}.${ext}`;
    const filepath = path.join(selfieDir, filename);
    fs.writeFileSync(filepath, buffer);
    const imageUrl = `/uploads/selfies/${filename}`;

    // 2. Parse EXIF data using exif-parser
    let exifGPS = null;
    let exifDateTime = null;
    let status = "warning_no_exif";
    let distance = null;
    let timeDiffMinutes = null;
    
    try {
      const ExifParser = require('exif-parser');
      const parser = ExifParser.create(buffer);
      const result = parser.parse();
      const tags = result.tags;
      
      if (tags) {
        // Extract GPS coordinates
        if (tags.GPSLatitude !== undefined && tags.GPSLongitude !== undefined) {
          exifGPS = {
            latitude: Number(tags.GPSLatitude),
            longitude: Number(tags.GPSLongitude)
          };
        }
        
        // Extract original datetime taken (timezone-correct local conversion)
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
      console.warn("[Selfie Verifier] EXIF metadata extraction failed:", e.message);
    }

    // 3. Match Employee
    let emp = db.employees.find(e => e.phone && e.phone.replace(/\D/g, '') === senderPhone.replace(/\D/g, ''));
    
    // If not found by phone, try to match by parsed caption name
    if (caption) {
      const parser = require('./parser');
      const parseResult = parser.parse(caption, senderPhone);
      if (parseResult && parseResult.matchedEmployee) {
        emp = parseResult.matchedEmployee;
      }
    }

    const employeeId = emp ? emp.id : `unknown_${senderPhone}`;
    const employeeName = emp ? emp.name : `Phone: +${senderPhone}`;

    // 4. Match closest Work Site
    let siteName = "—";
    let siteId = "";
    let closestSite = null;
    
    // Parse site from caption if possible
    let parsedSiteName = "";
    if (caption) {
      const parser = require('./parser');
      const parseResult = parser.parse(caption, senderPhone);
      if (parseResult && parseResult.items && parseResult.items[0]) {
        parsedSiteName = parseResult.items[0].extractedSite;
      } else if (parseResult && parseResult.extractedSite) {
        parsedSiteName = parseResult.extractedSite;
      }
    }

    // Match registered sites in DB
    if (exifGPS) {
      let minDistance = Infinity;
      db.sites.forEach(s => {
        if (s.latitude !== undefined && s.longitude !== undefined && s.latitude !== null && s.longitude !== null) {
          const dist = this.getHaversineDistance(exifGPS.latitude, exifGPS.longitude, s.latitude, s.longitude);
          if (dist < minDistance) {
            minDistance = dist;
            closestSite = s;
          }
        }
      });
      
      if (closestSite) {
        distance = Number(minDistance.toFixed(1)); // round to 1 decimal place (meters)
        if (minDistance <= 200) {
          siteId = closestSite.id;
          siteName = closestSite.name;
        }
      }
    }
    
    // Fall back to caption matched site if no coordinates matched or no GPS coordinates present
    if (!closestSite && parsedSiteName) {
      const site = db.sites.find(s => s.name.toLowerCase().trim() === parsedSiteName.toLowerCase().trim());
      if (site) {
        siteId = site.id;
        siteName = site.name;
      } else {
        siteName = parsedSiteName;
      }
    } else if (!closestSite && emp && emp.siteId) {
      const site = db.sites.find(s => s.name.toLowerCase().trim() === emp.siteId.toLowerCase().trim());
      if (site) {
        siteId = site.id;
        siteName = site.name;
      }
    }

    // 5. Run Geo and Time validation algorithms
    const receivedTime = new Date(msgTimestamp || Date.now());
    
    if (exifDateTime) {
      const photoTime = new Date(exifDateTime);
      timeDiffMinutes = Number((Math.abs(receivedTime - photoTime) / 60000).toFixed(1));
    }

    if (exifGPS && closestSite) {
      // Geo check (limit: 200 meters)
      const isWithinBounds = distance <= 200;
      
      // Time check (limit: 15 minutes between click and send)
      const isRealTime = exifDateTime ? timeDiffMinutes <= 15 : true;
      
      if (!isWithinBounds) {
        status = "flagged_location";
      } else if (!isRealTime) {
        status = "flagged_time";
      } else {
        status = "verified";
      }
    } else if (exifGPS) {
      // Coordinates extracted but no registered sites have coordinates to match
      status = "verified";
    }

    // 6. Assemble Selfie record
    let adminNotes = "";
    if (exifGPS && closestSite) {
      if (distance > 200) {
        adminNotes = `[FLAGGED LOCATION] Off-Site Check-In! Closest registered site is ${closestSite.name} (${Math.round(distance)}m away).`;
      } else if (exifDateTime && timeDiffMinutes > 15) {
        adminNotes = `[FLAGGED TIME] Photo was clicked earlier (Gap: ${timeDiffMinutes} mins).`;
      } else {
        adminNotes = `Checked in via WhatsApp. GPS verified (${Math.round(distance)}m distance).`;
      }
    } else if (exifGPS) {
      adminNotes = `Checked in via WhatsApp. GPS coordinates extracted (${exifGPS.latitude.toFixed(5)}, ${exifGPS.longitude.toFixed(5)}).`;
    } else {
      adminNotes = `[WARNING] Selfie check-in: Missing EXIF metadata.`;
    }

    const selfieRecord = {
      id: `selfie_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      employeeId,
      employeeName,
      messageId,
      imageUrl,
      timestamp: receivedTime.toISOString(),
      exifDateTime,
      exifGPS,
      siteId,
      siteName,
      distance,
      timeDiffMinutes,
      status,
      adminNotes
    };

    db.selfies.push(selfieRecord);
    this.writeAtomic(db);

    // 7. Auto-check-in to attendance database if VERIFIED!
    if (status === "verified" && emp) {
      const parserObj = require('./parser');
      const mockResult = {
        isSuccess: true,
        isList: false,
        extractedName: emp.name,
        extractedSite: siteName || emp.siteId || "Main Site",
        extractedAction: "in",
        matchedEmployee: emp
      };
      
      this.recordFromWhatsApp(mockResult, caption || `Selfie check-in at ${siteName}`, msgTimestamp);
    } else if (emp) {
      // If flagged, still record attendance but mark with a warning in notes!
      const parserObj = require('./parser');
      const warningNote = status === "flagged_location" 
        ? `[FLAGGED SELFIE] Mismatch Location (Distance: ${distance}m)`
        : (status === "flagged_time" ? `[FLAGGED SELFIE] Photo Clicked Earlier (Gap: ${timeDiffMinutes} mins)` : `[WARNING] Selfie check-in: Missing EXIF Data`);
      
      const mockResult = {
        isSuccess: true,
        isList: false,
        extractedName: emp.name,
        extractedSite: siteName || emp.siteId || "Main Site",
        extractedAction: "in",
        matchedEmployee: emp
      };
      
      const record = this.recordFromWhatsApp(mockResult, caption || `Selfie check-in at ${siteName}`, msgTimestamp);
      
      // Update the record's notes specifically to highlight the flag
      const dbRead = this.read();
      const recIndex = dbRead.attendance.findIndex(a => a.id === record.id);
      if (recIndex >= 0) {
        dbRead.attendance[recIndex].notes = warningNote;
        dbRead.attendance[recIndex].isManualOverride = false; // still alert admin
        this.writeAtomic(dbRead);
        this.syncToExcelAsync();
      }
    }

    return selfieRecord;
  }

  async applyLocationPinToRecentSelfie(senderPhone, latitude, longitude, msgTimestamp = null) {
    const db = this.read();
    if (!db.selfies) return null;
    
    // Find closest employee
    let emp = db.employees.find(e => e.phone && e.phone.replace(/\D/g, '') === senderPhone.replace(/\D/g, ''));
    const employeeId = emp ? emp.id : `unknown_${senderPhone}`;
    
    // Search selfies within last 5 minutes or next 5 minutes
    const locationTime = msgTimestamp ? new Date(msgTimestamp) : new Date();
    const matchingSelfies = db.selfies.filter(s => {
      if (s.employeeId !== employeeId) return false;
      const selfieTime = new Date(s.timestamp);
      const diffMs = Math.abs(selfieTime.getTime() - locationTime.getTime());
      return diffMs <= 5 * 60 * 1000; // 5 minutes window
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    
    if (matchingSelfies.length === 0) {
      console.log(`[Location Pin Matcher] No recent selfie found for +${senderPhone} in a 5-minute window to attach location pin.`);
      return null;
    }
    
    const selfie = matchingSelfies[0];
    
    // Update the selfie with the GPS coordinates from the location message
    selfie.exifGPS = {
      latitude: Number(latitude),
      longitude: Number(longitude)
    };
    
    // Re-evaluate matched site, distance, and status
    let siteName = selfie.siteName || "-";
    let siteId = selfie.siteId || "";
    let distance = null;
    
    // If we have registered sites with GPS, let's find the matched one
    if (db.sites && db.sites.length > 0) {
      let closestSite = null;
      let minDistance = Infinity;
      
      db.sites.forEach(site => {
        if (site.latitude && site.longitude) {
          const dist = this.getHaversineDistance(latitude, longitude, site.latitude, site.longitude);
          if (dist < minDistance) {
            minDistance = dist;
            closestSite = site;
          }
        }
      });
      
      if (closestSite) {
        siteId = closestSite.id;
        siteName = closestSite.name;
        distance = minDistance;
      }
    }
    
    selfie.siteId = siteId;
    selfie.siteName = siteName;
    selfie.distance = distance;
    
    // Set status based on 200m geofence
    if (distance !== null && distance <= 200) {
      selfie.status = "verified";
    } else {
      selfie.status = "flagged_location";
    }
    
    // Update administrative notes
    selfie.adminNotes = `GPS attached via WhatsApp location pin. Matched ${siteName} (${Math.round(distance || 0)}m).`;
    
    // Write back to DB
    const idx = db.selfies.findIndex(s => s.id === selfie.id);
    if (idx >= 0) {
      db.selfies[idx] = selfie;
    }
    this.writeAtomic(db);
    
    // Auto check-in to attendance database if VERIFIED!
    if (selfie.status === "verified" && emp) {
      const parserObj = require('./parser');
      const mockResult = {
        isSuccess: true,
        isList: false,
        extractedName: emp.name,
        extractedSite: siteName || emp.siteId || "Main Site",
        extractedAction: "in",
        matchedEmployee: emp
      };
      
      const record = this.recordFromWhatsApp(mockResult, `Selfie GPS verified via WhatsApp Location Pin`);
      
      // Update matching attendance notes
      const dbRead = this.read();
      const recIndex = dbRead.attendance.findIndex(a => a.id === record.id);
      if (recIndex >= 0) {
        dbRead.attendance[recIndex].notes = `[SELFIE VERIFIED] GPS match via location pin (Distance: ${Math.round(distance)}m)`;
        dbRead.attendance[recIndex].isManualOverride = true; // verified
        this.writeAtomic(dbRead);
        this.syncToExcelAsync();
      }
    } else if (emp) {
      // If flagged, update matching attendance notes
      const targetDate = selfie.timestamp.split('T')[0];
      const recIndex = db.attendance.findIndex(a => a.employeeId === emp.id && a.date === targetDate);
      if (recIndex >= 0) {
        db.attendance[recIndex].notes = `[FLAGGED SELFIE] Location Mismatch via Location Pin (${Math.round(distance)}m)`;
        db.attendance[recIndex].isManualOverride = false;
        this.writeAtomic(db);
        this.syncToExcelAsync();
      }
    }
    
    return selfie;
  }

  getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in meters
  }
}

module.exports = new Database();
