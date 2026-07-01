const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DB_PATH = path.join(__dirname, 'data.json');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const EXCEL_PATH = path.join(__dirname, 'Attendance_Payroll.xlsx');

function getLocalDateString(dateInput = new Date()) {
  const d = new Date(dateInput);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
    whatsappGroupName: "ATTENDANCE",
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
    this.dbCache = null;
    this.isSyncingExcel = false;
    this.pendingExcelSync = false;
    this.isBatching = false;
    this.batchDb = null;
    this.init();
  }

  startTransaction() {
    this.isBatching = true;
    this.batchDb = this.read();
    console.log("[Database] Started batch update transaction (in-memory caching active).");
  }

  commitTransaction() {
    if (this.isBatching && this.batchDb) {
      this.isBatching = false;
      this.writeAtomic(this.batchDb);
      this.batchDb = null;
      console.log("[Database] Committed batch update transaction (disk write finalized).");
      this.syncToExcelAsync();
    }
  }

  // Initialize DB file
  init() {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    if (!fs.existsSync(DB_PATH)) {
      this.dbCache = DEFAULT_DB;
      this.writeAtomic(DEFAULT_DB);
    } else {
      try {
        // Load and cache
        this.dbCache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      } catch (err) {
        console.error("Corrupted database file. Attempting recovery from backups...", err);
        if (this.recoverFromBackup()) {
          // loaded by recoverFromBackup
        } else {
          this.dbCache = DEFAULT_DB;
          this.writeAtomic(DEFAULT_DB);
        }
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
    if (this.isBatching && this.batchDb) {
      return this.batchDb;
    }
    if (this.dbCache) {
      return this.dbCache;
    }
    try {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      this.dbCache = JSON.parse(data);
      return this.dbCache;
    } catch (err) {
      console.error("Error reading database:", err);
      return DEFAULT_DB;
    }
  }

  // Write DB atomically to prevent corruption
  writeAtomic(data) {
    this.dbCache = data; // Keep cache updated
    if (this.isBatching) {
      this.batchDb = data;
      return true;
    }
    const tempPath = `${DB_PATH}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      
      let retries = 5;
      while (retries > 0) {
        try {
          fs.renameSync(tempPath, DB_PATH);
          break;
        } catch (renameErr) {
          retries--;
          if (retries === 0) throw renameErr;
          // Synchronous sleep/wait for 50ms
          const start = Date.now();
          while (Date.now() - start < 50) {}
        }
      }
      
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

  toTitleCase(name) {
    if (!name) return "";
    return name
      .toString()
      .trim()
      .toLowerCase()
      .replace(/(?:^|\s|\(|-|\.|\[|\/)([a-z])/g, function(match) {
        return match.toUpperCase();
      });
  }

  // --- Employees Table ---
  getEmployees() {
    return (this.read().employees || []).filter(e => e && e.id && e.name);
  }

  saveEmployee(employee) {
    if (employee && employee.name) {
      employee.name = this.toTitleCase(employee.name);
    }
    const db = this.read();
    const index = db.employees.findIndex(e => e.id === employee.id);
    
    let saved;
    if (index >= 0) {
      db.employees[index] = { ...db.employees[index], ...employee };
      if (db.employees[index].name) {
        db.employees[index].name = this.toTitleCase(db.employees[index].name);
      }
      saved = db.employees[index];
    } else {
      employee.id = employee.id || `emp_${Date.now()}`;
      employee.status = employee.status || 'active';
      employee.createdAt = employee.createdAt || new Date().toISOString();
      employee.dailyRate = Number(employee.dailyRate) || 0.0;
      employee.hourlyRate = Number(employee.hourlyRate) || 0.0;
      db.employees.push(employee);
      saved = employee;
    }
    
    this.writeAtomic(db);
    this.syncToExcelAsync();
    return saved;
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
    msg.id = msg.id || `msg_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    // Use provided timestamp (actual WhatsApp message send time) — fall back to now only if not supplied
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

  clearProcessedAndPendingMessages(msgIdsToClear, matchedMessages) {
    const db = this.read();
    let updated = false;

    if (db.processed_message_ids && msgIdsToClear.length > 0) {
      const initialLength = db.processed_message_ids.length;
      db.processed_message_ids = db.processed_message_ids.filter(id => !msgIdsToClear.includes(id));
      if (db.processed_message_ids.length !== initialLength) {
        updated = true;
      }
    }

    if (db.pending_messages && matchedMessages.length > 0) {
      const initialLength = db.pending_messages.length;
      db.pending_messages = db.pending_messages.filter(pendingMsg => {
        const isMatch = matchedMessages.some(m => 
          m.id === pendingMsg.id || 
          (m.sender === pendingMsg.sender && m.body === pendingMsg.messageText)
        );
        return !isMatch;
      });
      if (db.pending_messages.length !== initialLength) {
        updated = true;
      }
    }

    if (updated) {
      this.writeAtomic(db);
    }
    return updated;
  }


  getHospitalUsageForMonth(employeeId, monthStr, excludeDate = null, db = null) {
    const activeDb = db || this.read();
    const monthLogs = (activeDb.attendance || []).filter(log => 
      log.employeeId === employeeId && 
      log.date.startsWith(monthStr) && 
      log.date !== excludeDate &&
      log.isHospitalCase === true
    );
    
    let days = 0;
    let hours = 0;
    monthLogs.forEach(log => {
      days += 1;
      hours += Number(log.hospitalHours || 0);
    });
    
    return { days, hours };
  }

  // --- Attendance Table with dynamic absenteeism & shift calculations ---
  
  calculateShift(employee, checkInTime, checkOutTime, record = null) {
    const settings = this.getSettings();
    let F = settings.standardFullDayHours || 8.0; // Full Day Limit (e.g. 8)
    let h = settings.standardHalfDayHours || 4.0; // Half Day Limit (e.g. 4)
    
    let overtimeBaseHours = F;
    
    if (employee.shiftStart && employee.shiftEnd) {
      try {
        const [startH, startM] = employee.shiftStart.split(':').map(Number);
        const [endH, endM] = employee.shiftEnd.split(':').map(Number);
        let shiftMinutes = (endH * 60 + endM) - (startH * 60 + startM);
        if (shiftMinutes < 0) shiftMinutes += 24 * 60;
        const shiftHours = shiftMinutes / 60;
        
        F = shiftHours >= 9.0 ? shiftHours - 1.0 : shiftHours;
        h = F / 2.0;
        overtimeBaseHours = shiftHours;
      } catch (err) {
        console.warn(`[calculateShift] Failed to parse custom shift times for ${employee.name}:`, err.message);
      }
    }
    
    let dailyRate = Number(employee.dailyRate) || 0.0;
    let hourlyRate = Number(employee.hourlyRate) || 0.0;
    if (hourlyRate === 0 && F > 0 && dailyRate > 0) {
      hourlyRate = Number((dailyRate / F).toFixed(2));
    }
    let isInvalidDate = false;
    const checkInStr = String(checkInTime || "");
    const checkOutStr = String(checkOutTime || "");
    const customHoursMatch = checkInStr.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*work/i) ||
                             checkOutStr.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)?\s*work/i);

    // Check if shift falls on a holiday (excluding Sundays)
    if (!customHoursMatch) {
      try {
        const checkInDate = new Date(checkInTime);
        if (!isNaN(checkInDate.getTime())) {
          const dateStr = getLocalDateString(checkInDate);
          const isSunday = checkInDate.getDay() === 0;
          const db = this.read();
          const holidays = db.holidays || [];
          const isHoliday = holidays.some(hol => hol.date === dateStr);
          
          const isOfficeStaff = employee.modeOfWork && employee.modeOfWork.toLowerCase().trim() === 'office staff';
          if (isHoliday && !isSunday && isOfficeStaff) {
            dailyRate = dailyRate * 2.0;
            hourlyRate = hourlyRate * 2.0;
          }
        }
      } catch (e) {
        console.error("Failed to evaluate holiday rate multiplier:", e);
      }
    }
    
    let totalHours = 0.0;
    let durationMinutes = 0;

    if (customHoursMatch) {
      totalHours = parseFloat(customHoursMatch[1]);
      durationMinutes = Math.round(totalHours * 60);
      isInvalidDate = true;
    }



    if (!isInvalidDate) {
      try {
        const checkIn = new Date(checkInTime);
        const checkOut = new Date(checkOutTime);
        
        if (!isNaN(checkIn.getTime()) && !isNaN(checkOut.getTime())) {
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

          // Add hospital hours if this is an exempt hospital case
          if (record && record.isHospitalExempt && record.hospitalHours) {
            diffMs += Number(record.hospitalHours) * 3600000;
          }
          
          durationMinutes = Math.max(0, Math.floor(diffMs / 60000));
          totalHours = Number((durationMinutes / 60).toFixed(2));
        }
      } catch (err) {
        console.error("Error parsing dates in calculateShift:", err);
      }
    }
    
    let regularHours = 0.0;
    let otHours = 0.0;
    let extraHours = 0.0;
    let isHalfDay = false;
    let isFullDay = false;
    let calculatedWage = 0.0;
    
    const isOfficeStaff = employee.modeOfWork && employee.modeOfWork.toLowerCase().trim() === 'office staff';
    const isEligible = employee.otEligible !== undefined ? (employee.otEligible === true || employee.otEligible === 'true') : !isOfficeStaff;
    
    const forceHalfDay = record && record.status === 'half-day leave';
    if (totalHours >= F && !forceHalfDay) {
      // Full Day + Overtime
      isFullDay = true;
      regularHours = F;
      if (!isEligible) {
        otHours = 0.0;
        calculatedWage = dailyRate;
      } else {
        const exactOT = totalHours - overtimeBaseHours;
        const graceHours = (Number(employee.otGraceMinutes) || 0) / 60;
        const billableOT = exactOT - graceHours;
        if (billableOT > 0) {
          const otMinutes = Math.round(billableOT * 60);
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
        calculatedWage = Number((dailyRate + (otHours * hourlyRate)).toFixed(2));
      }
    } else if (totalHours >= h || forceHalfDay) {
      // Half Day + Extra Hours
      isHalfDay = true;
      regularHours = h;
      if (!isEligible) {
        extraHours = 0.0;
        calculatedWage = Number((dailyRate * 0.5).toFixed(2));
      } else {
        extraHours = Math.max(0.0, Number((totalHours - h).toFixed(2)));
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
  getAttendanceForDate(dateStr, db = null) {
    const activeDb = db || this.read();
    const employees = (activeDb.employees || []).filter(e => e && e.status === 'active');
    const logs = (activeDb.attendance || []).filter(log => log && log.date === dateStr);
    
    // Map out employees already logged
    const loggedMap = new Map();
    logs.forEach(log => {
      if (log && log.employeeId) {
        loggedMap.set(log.employeeId, log);
      }
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
    
    const db = this.read();
    
    // Loop over each day in range safely in UTC
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const dailySheet = this.getAttendanceForDate(dateStr, db);
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
    event.id = event.id || `cam_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
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
      delete event.imageBase64;
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

  getUnknownDetections() {
    const db = this.read();
    if (!db.unknownDetections) {
      db.unknownDetections = [];
      this.writeAtomic(db);
    }
    return db.unknownDetections;
  }

  saveUnknownDetection(event) {
    const db = this.read();
    if (!db.unknownDetections) db.unknownDetections = [];

    event.id = event.id || `unk_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    event.cameraName = event.cameraName || 'CCTV Camera';
    event.siteName = event.siteName || 'Office';
    event.timestamp = event.timestamp || new Date().toISOString();
    event.date = event.date || event.timestamp.split('T')[0];
    event.confidence = event.confidence || 0.0;
    event.createdAt = event.createdAt || new Date().toISOString();

    if (event.imageBase64) {
      try {
        const uploadsDir = path.join(__dirname, 'public', 'uploads', 'camera');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const filename = `${event.id}.jpg`;
        const filepath = path.join(uploadsDir, filename);
        const buffer = Buffer.from(event.imageBase64, 'base64');
        fs.writeFileSync(filepath, buffer);
        event.imageUrl = `/uploads/camera/${filename}`;
        delete event.imageBase64;
      } catch (imgErr) {
        console.warn('[UnknownDetection] Failed to save attached image:', imgErr.message);
      }
    }

    if (event.raw_face_base64) {
      try {
        const uploadsDir = path.join(__dirname, 'public', 'uploads', 'camera');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const filename = `raw_${event.id}.jpg`;
        const filepath = path.join(uploadsDir, filename);
        const buffer = Buffer.from(event.raw_face_base64, 'base64');
        fs.writeFileSync(filepath, buffer);
        event.rawFaceUrl = `/uploads/camera/${filename}`;
        delete event.raw_face_base64;
      } catch (imgErr) {
        console.warn('[UnknownDetection] Failed to save raw face image:', imgErr.message);
      }
    }

    const existingIndex = db.unknownDetections.findIndex(e => e.id === event.id);
    if (existingIndex >= 0) {
      db.unknownDetections[existingIndex] = { ...db.unknownDetections[existingIndex], ...event };
    } else {
      db.unknownDetections.push(event);
    }

    this.writeAtomic(db);
    return event;
  }

  deleteUnknownDetection(id) {
    const db = this.read();
    if (!db.unknownDetections) return false;
    const index = db.unknownDetections.findIndex(e => e.id === id);
    if (index >= 0) {
      const event = db.unknownDetections[index];
      if (event.imageUrl) {
        try {
          const filepath = path.join(__dirname, 'public', event.imageUrl);
          if (fs.existsSync(filepath)) {
            // Keep files on disk to support TransactionManager undo deletes
            // fs.unlinkSync(filepath);
          }
        } catch(e) {}
      }
      if (event.rawFaceUrl) {
        try {
          const filepath = path.join(__dirname, 'public', event.rawFaceUrl);
          if (fs.existsSync(filepath)) {
            // Keep files on disk to support TransactionManager undo deletes
            // fs.unlinkSync(filepath);
          }
        } catch(e) {}
      }
      db.unknownDetections.splice(index, 1);
      this.writeAtomic(db);
      return true;
    }
    return false;
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

    camera.id = camera.id || `cctv_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    camera.name = camera.name || 'CCTV Camera';
    camera.source = camera.source || '';
    camera.siteId = camera.siteId || '';
    camera.eventType = camera.eventType || 'auto'; // 'entry', 'exit', or 'auto'
    camera.status = camera.status !== undefined ? camera.status : 'inactive'; // 'active' or 'inactive'
    camera.invertDirection = camera.invertDirection !== undefined ? !!camera.invertDirection : false;
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

  ensurePunches(record) {
    if (!record.punches) {
      record.punches = [];
    }
    
    // Auto-resolve source for any existing punches that lack one
    record.punches.forEach(p => {
      if (!p.source) {
        if (record.source === 'MANUAL' || record.source === 'Manual' || record.isManualOverride) {
          p.source = record.source || 'MANUAL';
        } else if (p.messageText && (p.messageText.includes('CCTV') || p.messageText.includes('Camera') || p.messageText.includes('Face recognized') || p.messageText.includes('CCTV Face recognized'))) {
          p.source = 'CCTV';
        } else if (p.messageText && (p.messageText.includes('Selfie') || p.messageText.includes('Geofence') || p.messageText.includes('selfie') || p.messageText.includes('Webcam Scan'))) {
          p.source = 'Selfie';
        } else if (p.messageText && (p.messageText.includes('Manually') || p.messageText.includes('Manual') || p.messageText.includes('Admin'))) {
          p.source = 'Manual';
        } else {
          p.source = 'WhatsApp';
        }
      }
    });

    // Add checkIn if not present
    if (record.checkIn) {
      const exists = record.punches.some(p => p.time === record.checkIn && p.type === 'in');
      if (!exists) {
        let source = 'WhatsApp';
        if (record.source === 'MANUAL' || record.source === 'Manual' || record.isManualOverride) {
          source = record.source || 'MANUAL';
        } else if (record.verificationMethod === 'Face Recognition' || (record.messageText && (record.messageText.includes('CCTV') || record.messageText.includes('Camera') || record.messageText.includes('Face recognized')))) {
          if (record.siteName && record.siteName.includes('Webcam Scan')) {
            source = 'Selfie';
          } else {
            source = 'CCTV';
          }
        } else if (record.messageText && (record.messageText.includes('Selfie') || record.messageText.includes('Geofence') || record.messageText.includes('Webcam Scan'))) {
          source = 'Selfie';
        }
        record.punches.push({
          time: record.checkIn,
          type: 'in',
          siteName: record.siteName || '—',
          messageText: record.messageText || '',
          source: source
        });
      }
    }
    
    // Add checkOut if not present
    if (record.checkOut) {
      const exists = record.punches.some(p => p.time === record.checkOut && p.type === 'out');
      if (!exists) {
        let source = 'WhatsApp';
        if (record.source === 'MANUAL' || record.source === 'Manual' || record.isManualOverride) {
          source = record.source || 'MANUAL';
        } else if (record.verificationMethod === 'Face Recognition' || (record.messageText && (record.messageText.includes('CCTV') || record.messageText.includes('Camera') || record.messageText.includes('Face recognized')))) {
          if (record.siteName && record.siteName.includes('Webcam Scan')) {
            source = 'Selfie';
          } else {
            source = 'CCTV';
          }
        } else if (record.messageText && (record.messageText.includes('Selfie') || record.messageText.includes('Geofence') || record.messageText.includes('Webcam Scan'))) {
          source = 'Selfie';
        }
        record.punches.push({
          time: record.checkOut,
          type: 'out',
          siteName: record.siteName || '—',
          messageText: record.messageText || '',
          source: source
        });
      }
    }
    
    // Filter out auto-checkout punches
    record.punches = record.punches.filter(p => !p.messageText || !p.messageText.includes('System Auto-Checkout'));
    
    // Sort punches chronologically
    record.punches.sort((a, b) => new Date(a.time) - new Date(b.time));
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
    record.id = record.id || `att_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    record.employeeName = employee.name;
    record.date = record.date || getLocalDateString();

    // Manual override forces punches to exactly matching new times
    if (record.isManualOverride) {
      record.punches = [];
      if (record.checkIn) {
        record.punches.push({ time: record.checkIn, type: 'in', siteName: record.siteName || '—', messageText: 'Manually Entered Check-In' });
      }
      if (record.checkOut) {
        record.punches.push({ time: record.checkOut, type: 'out', siteName: record.siteName || '—', messageText: 'Manually Entered Check-Out' });
      }
    }
    this.ensurePunches(record);

    // Smart Multi-Shift Merging:
    // If a record for the same employee and date already exists under a different ID, merge them.
    const existingIndex = db.attendance.findIndex(a => a.employeeId === record.employeeId && a.date === record.date);
    if (existingIndex >= 0) {
      const existing = db.attendance[existingIndex];
      if (existing.id !== record.id) {
        // Skip merge if existing has manual override
        if (existing.isManualOverride && !record.isManualOverride && record.source !== 'MANUAL' && record.source !== 'Manual') {
          console.log(`[Database] Skipping update/merge for employee ${record.employeeName} on ${record.date} because a manual override is active.`);
          return existing;
        }

        if (record.status === 'leave') {
          // Full-day leave overrides existing check-in/work record
          const existingMsgs = existing.messageText ? existing.messageText.split('|').map(m => m.trim()).filter(Boolean) : [];
          const incomingMsgs = record.messageText ? record.messageText.split('|').map(m => m.trim()).filter(Boolean) : [];
          const combinedMsgs = [...new Set([...existingMsgs, ...incomingMsgs])];
          
          record.messageText = combinedMsgs.join(' | ');
          record.checkIn = null;
          record.checkOut = null;
          record.punches = [];
          record.status = 'leave';
          record.duration = 0;
          record.regularHours = 0;
          record.otHours = 0;
          record.extraHours = 0;
          record.isHalfDay = false;
          record.isFullDay = false;
          record.calculatedWage = 0;
          record.isLate = false;
          record.id = existing.id;
        } else if (existing.status === 'leave') {
          // Incoming check-in overrides existing leave record
          const existingMsgs = existing.messageText ? existing.messageText.split('|').map(m => m.trim()).filter(Boolean) : [];
          const incomingMsgs = record.messageText ? record.messageText.split('|').map(m => m.trim()).filter(Boolean) : [];
          const combinedMsgs = [...new Set([...existingMsgs, ...incomingMsgs])];
          
          record.messageText = combinedMsgs.join(' | ');
          record.id = existing.id;
          // Rest of saveAttendance will process incoming check-in
        } else {
          // Standard Multi-Shift Merging:
          // Build punches for both existing and incoming
          this.ensurePunches(existing);
          this.ensurePunches(record);

          // Filter out auto-checkouts
          const cleanExistingPunches = existing.punches.filter(p => !p.messageText || !p.messageText.includes('System Auto-Checkout'));
          const cleanIncomingPunches = record.punches.filter(p => !p.messageText || !p.messageText.includes('System Auto-Checkout'));

          // Combine and de-duplicate punches by time and type
          const combinedPunches = [...cleanExistingPunches, ...cleanIncomingPunches];
          const uniquePunches = [];
          const seen = new Set();
          combinedPunches.forEach(p => {
            const key = `${p.time}_${p.type}`;
            if (!seen.has(key)) {
              seen.add(key);
              uniquePunches.push(p);
            }
          });
          
          record.punches = uniquePunches.sort((a, b) => new Date(a.time) - new Date(b.time));

          // Set checkIn to the earliest punch
          // Set checkOut to the latest punch
          const ins = record.punches.filter(p => p.type === 'in');
          const outs = record.punches.filter(p => p.type === 'out');
          
          if (ins.length > 0) {
            record.checkIn = ins[0].time;
          }
          if (record.punches.length > 0) {
            const lastPunch = record.punches[record.punches.length - 1];
            if (lastPunch.type === 'in') {
              record.checkOut = null;
            } else {
              record.checkOut = lastPunch.time;
            }
          } else {
            record.checkOut = null;
          }

          // 3. Merge siteName
          const existingSites = existing.siteName ? existing.siteName.split('/').map(s => s.trim()).filter(s => s && s !== '—') : [];
          const incomingSites = record.siteName ? record.siteName.split('/').map(s => s.trim()).filter(s => s && s !== '—') : [];
          const combinedSites = [...new Set([...existingSites, ...incomingSites])];
          record.siteName = combinedSites.join(' / ') || '—';

          // 4. Merge messageText
          const existingMsgs = existing.messageText ? existing.messageText.split('|').map(m => m.trim()).filter(Boolean) : [];
          const incomingMsgs = record.messageText ? record.messageText.split('|').map(m => m.trim()).filter(Boolean) : [];
          const combinedMsgs = [...new Set([...existingMsgs, ...incomingMsgs])];
          record.messageText = combinedMsgs.join(' | ');

          // 5. Merge travelHours
          record.travelHours = (Number(existing.travelHours) || 0.0) + (Number(record.travelHours) || 0.0);

          // 6. Merge hospital cases
          if (existing.isHospitalCase || record.isHospitalCase) {
            record.isHospitalCase = true;
            record.hospitalHours = (Number(existing.hospitalHours) || 0.0) + (Number(record.hospitalHours) || 0.0);
          }

          // Use the existing ID so we overwrite/update the existing entry in db
          record.id = existing.id;
        }
      }
    }
    record.regularHours = Number(record.regularHours) || 0.0;
    record.otHours = Number(record.otHours) || 0.0;
    record.extraHours = Number(record.extraHours) || 0.0;
    record.isHalfDay = record.isHalfDay === true || record.isHalfDay === 'true';
    record.isFullDay = record.isFullDay === true || record.isFullDay === 'true';
    record.calculatedWage = Number(record.calculatedWage) || 0.0;
    record.travelHours = Number(record.travelHours) || 0.0;
    
    // Set scannedCheckIn automatically to true if there is any punch from CCTV or Selfie
    if (record.punches && record.punches.length > 0) {
      const hasPhysicalScan = record.punches.some(p => p.source === 'CCTV' || p.source === 'Selfie');
      if (hasPhysicalScan) {
        record.scannedCheckIn = true;
      }
    }

    // Unless it's a manual override or leave, ensure checkIn/checkOut are correctly computed from punches
    if (!record.isManualOverride && record.status !== 'leave' && record.punches && record.punches.length > 0) {
      // Ensure the first punch of the day is always an 'in' punch
      if (record.punches[0].type === 'out') {
        record.punches[0].type = 'in';
      }
      
      const ins = record.punches.filter(p => p.type === 'in');
      if (ins.length > 0) {
        record.checkIn = ins[0].time;
      }
      
      const lastPunch = record.punches[record.punches.length - 1];
      if (lastPunch.type === 'in') {
        record.checkOut = null;
      } else {
        record.checkOut = lastPunch.time;
      }
    }

    // Strict Late Check-in Check against registry shift start time
    if (record.checkIn && employee.shiftStart && employee.shiftStart.includes(':')) {
      try {
        const checkInDate = new Date(record.checkIn);
        const checkInH = checkInDate.getHours();
        const checkInM = checkInDate.getMinutes();
        const [startH, startM] = employee.shiftStart.split(':').map(Number);
                const checkInMinutes = checkInH * 60 + checkInM;
        const shiftStartMinutes = startH * 60 + startM;
        
        if (checkInMinutes > shiftStartMinutes) { // sharp time (no grace period)
          record.isLate = true;
        } else {
          record.isLate = false;
          if (record.status === 'late' || record.status === 'Late Check-in') {
            record.status = ''; // Force fallback to default active/completed status
          }
        }
      } catch (err) {
        console.warn(`[saveAttendance] Failed to evaluate check-in time comparison:`, err.message);
      }
    }

    if (record.status === 'Early Check-out') {
      record.isEarlyCheckout = true;
    }

    // Calculate hospital exemption status
    const monthStr = record.date.substring(0, 7);
    if (record.isHospitalCase) {
      const usage = this.getHospitalUsageForMonth(record.employeeId, monthStr, record.date, db);
      const claimedHours = Number(record.hospitalHours || 0);
      if (usage.days < 2 && (usage.hours + claimedHours) <= 2) {
        record.isHospitalExempt = true;
      } else {
        record.isHospitalExempt = false;
      }
    } else {
      record.isHospitalExempt = false;
    }

    // Check if check-out time is supplied and check-in exists. If so, calculate math if not explicitly overridden by manual edit
    // Safeguard: If manual override is enabled but all override values are zero, we fall back to auto-calculation to avoid accidental zeroing.
    const isManualOverrideActuallyZero = record.isManualOverride && 
      Number(record.regularHours) === 0 && 
      Number(record.otHours) === 0 && 
      Number(record.extraHours) === 0 && 
      Number(record.calculatedWage) === 0;

    if (record.checkIn && record.checkOut && (!record.isManualOverride || isManualOverrideActuallyZero)) {
      if (isManualOverrideActuallyZero) {
        record.isManualOverride = false;
      }
      const shiftMath = this.calculateShift(employee, record.checkIn, record.checkOut, record);
      record.duration = shiftMath.durationMinutes;
      record.regularHours = shiftMath.regularHours;
      record.otHours = shiftMath.otHours;
      record.extraHours = shiftMath.extraHours;
      record.isHalfDay = shiftMath.isHalfDay;
      record.isFullDay = shiftMath.isFullDay;
      record.calculatedWage = shiftMath.calculatedWage;
      
      // Detect early check-out
      let isEarlyOut = false;
      if (employee.shiftEnd && employee.shiftEnd.includes(':')) {
        try {
          const checkOutDate = new Date(record.checkOut);
          const coHour = checkOutDate.getHours();
          const coMinute = checkOutDate.getMinutes();
          const checkOutMinutes = coHour * 60 + coMinute;

          const [shEndHour, shEndMin] = employee.shiftEnd.split(':').map(Number);
          const shiftEndMinutes = shEndHour * 60 + shEndMin;
          if (checkOutMinutes < shiftEndMinutes - 5) {
            isEarlyOut = true;
          }
        } catch (e) {
          console.error("Failed to calculate early checkout:", e);
        }
      }
      record.isEarlyCheckout = isEarlyOut;

      if (record.isHalfDay) {
        record.status = "half-day leave";
      } else if (record.isEarlyCheckout) {
        record.status = "Early Check-out";
      } else if (record.status === 'Late Check-in' || record.status === 'late' || record.isLate) {
        record.isLate = true;
        if (record.scannedCheckIn || record.checkOut) {
          record.status = "Late Check-in";
        } else {
          record.status = "late";
        }
      } else {
        record.status = "completed";
      }
    } else if (record.checkIn && !record.checkOut) {
      // Active check-in
      record.duration = 0;
      record.regularHours = 0.0;
      record.otHours = 0.0;
      record.extraHours = 0.0;
      record.isHalfDay = false;
      record.isFullDay = false;
      record.calculatedWage = 0.0;
      if (record.status === 'out-for-lunch') {
        // Preserve lunch break state without closing the shift
      } else if (record.status === 'Late Check-in' || record.status === 'late' || record.isLate) {
        record.isLate = true;
        if (record.scannedCheckIn) {
          record.status = "Late Check-in";
        } else {
          record.status = "late";
        }
      } else {
        record.status = "checked-in";
      }
    }

    // Insert or update
    const index = db.attendance.findIndex(a => a.id === record.id || (a.employeeId === record.employeeId && a.date === record.date));
    if (index >= 0) {
      if (db.attendance[index].isManualOverride && !record.isManualOverride && record.source !== 'MANUAL' && record.source !== 'Manual') {
        console.log(`[Database] Skipping update for employee ${record.employeeName} on ${record.date} because a manual override is active.`);
        return db.attendance[index];
      }
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
        id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
        timestamp: messageTimestamp || new Date().toISOString(),
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
        id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
        timestamp: messageTimestamp || new Date().toISOString(),
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
      ? getLocalDateString(messageTimestamp)
      : getLocalDateString();
    
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

    // Robust Out-of-Order and Split-Message Merging logic
    const isStandardPunch = parsedData.extractedAction === 'in' || parsedData.extractedAction === 'out' || parsedData.extractedAction === 'completed';
    if (existingLogIndex >= 0 && isStandardPunch) {
      const existing = db.attendance[existingLogIndex];
      const incomingTimeStr = parsedData.checkInTime || parsedData.checkOutTime || getFallbackTimestamp();
      
      if (existing && existing.checkIn) {
        const existingCheckInTime = new Date(existing.checkIn).getTime();
        const incomingTime = new Date(incomingTimeStr).getTime();
        
        if (!existing.checkOut) {
          // Case 1: Existing check-in exists, check-out is null
          if (incomingTime - existingCheckInTime >= 3 * 60 * 60 * 1000) {
            // New time is >= 3 hours after existing check-in -> treat as check-out
            console.log(`[Database] Employee ${employee.name} already checked in at ${existing.checkIn}. Converting subsequent message to check-out.`);
            parsedData.extractedAction = 'out';
            parsedData.checkOutTime = incomingTimeStr;
            parsedData.checkInTime = null;
          } else if (existingCheckInTime - incomingTime >= 3 * 60 * 60 * 1000) {
            // New time is >= 3 hours BEFORE existing check-in -> treat new time as check-in, existing as check-out
            console.log(`[Database] Employee ${employee.name} has check-in at ${existing.checkIn}. Incoming time ${incomingTimeStr} is earlier. Shifting check-in to check-out.`);
            parsedData.extractedAction = 'out';
            parsedData.checkOutTime = existing.checkIn;
            parsedData.checkInTime = incomingTimeStr;
            existing.checkIn = incomingTimeStr;
          }
        } else {
          // Case 2: Existing check-in and check-out are both set
          const existingCheckOutTime = new Date(existing.checkOut).getTime();
          if (incomingTime < existingCheckInTime) {
            // New time is earlier than check-in -> update check-in
            console.log(`[Database] Employee ${employee.name} already has full shift. Incoming time ${incomingTimeStr} is earlier than check-in. Updating check-in.`);
            existing.checkIn = incomingTimeStr;
            parsedData.extractedAction = 'out';
            parsedData.checkOutTime = existing.checkOut;
            parsedData.checkInTime = incomingTimeStr;
          } else if (incomingTime > existingCheckOutTime) {
            // New time is later than check-out -> update check-out
            console.log(`[Database] Employee ${employee.name} already has full shift. Incoming time ${incomingTimeStr} is later than check-out. Updating check-out.`);
            existing.checkOut = incomingTimeStr;
            parsedData.extractedAction = 'out';
            parsedData.checkOutTime = incomingTimeStr;
            parsedData.checkInTime = existing.checkIn;
          }
        }
      }
    }

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
        travelHours: parsedData.travelHours || 0.0,
        punches: []
      };
      if (record.checkIn) {
        record.punches.push({
          time: record.checkIn,
          type: 'in',
          siteName: site.name,
          messageText: rawText,
          source: parsedData.source || 'WhatsApp'
        });
      }
      if (record.checkOut) {
        record.punches.push({
          time: record.checkOut,
          type: 'out',
          siteName: site.name,
          messageText: rawText,
          source: parsedData.source || 'WhatsApp'
        });
      }
      return this.saveAttendance(record);
    } else if (parsedData.extractedAction === 'half-day-leave') {
      const targetDate = parsedData.leaveDate || targetDateStr;
      let halfDayHours = this.getSettings().standardHalfDayHours || 4.0;
      let checkInISO = null;
      let checkOutISO = null;

      if (employee.shiftStart && employee.shiftEnd) {
        try {
          const [startH, startM] = employee.shiftStart.split(':').map(Number);
          const [endH, endM] = employee.shiftEnd.split(':').map(Number);
          let shiftMinutes = (endH * 60 + endM) - (startH * 60 + startM);
          if (shiftMinutes < 0) shiftMinutes += 24 * 60;
          const shiftHours = shiftMinutes / 60;
          const fullDayHours = shiftHours >= 9.0 ? shiftHours - 1.0 : shiftHours;
          halfDayHours = fullDayHours / 2.0;

          // Compute check-in/out based on which half of the day
          const period = parsedData.halfDayPeriod || 'second'; // default: afternoon leave
          const makeISO = (datePart, h, m) => {
            const d = new Date(`${datePart}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
            return d.toISOString();
          };

          if (period === 'first') {
            // Morning leave: worked 0 hours in morning, present in afternoon
            // Check-in = after lunch (14:00), Check-out = shiftEnd
            checkInISO = makeISO(targetDate, 14, 0);
            checkOutISO = makeISO(targetDate, endH, endM);
          } else {
            // Afternoon/evening leave: present in morning, leaves at noon
            // Check-in = shiftStart, Check-out = noon (13:00)
            checkInISO = makeISO(targetDate, startH, startM);
            checkOutISO = makeISO(targetDate, 13, 0);
          }

          // Recalculate half-day hours from the resolved check-in/out window
          const actualMinutes = (new Date(checkOutISO) - new Date(checkInISO)) / 60000;
          if (actualMinutes > 0) halfDayHours = actualMinutes / 60;

        } catch (err) {
          console.warn(`[half-day-leave] Failed to parse custom shift times for ${employee.name}:`, err.message);
        }
      }

      const halfWage = Number(((employee.dailyRate || 0) * 0.5).toFixed(2));
      const record = {
        employeeId: employee.id,
        employeeName: employee.name,
        siteName: site.name || "—",
        date: targetDate,
        checkIn: checkInISO,
        checkOut: checkOutISO,
        duration: Math.round(halfDayHours * 60),
        regularHours: Number(halfDayHours.toFixed(2)),
        otHours: 0.0,
        extraHours: 0.0,
        isHalfDay: true,
        isFullDay: false,
        calculatedWage: halfWage,
        messageText: rawText,
        status: "half-day leave",
        travelHours: 0.0
      };
      if (existingLogIndex >= 0) {
        record.id = db.attendance[existingLogIndex].id;
      }
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
    } else if (parsedData.extractedAction === 'out-for-lunch') {
      if (existingLogIndex >= 0) {
        const existing = db.attendance[existingLogIndex];
        if (existing.messageText) {
          const parts = existing.messageText.split(' | ').map(p => p.trim());
          if (!parts.includes(rawText.trim())) {
            existing.messageText = [...parts, rawText.trim()].join(' | ');
          }
        } else {
          existing.messageText = rawText;
        }
        existing.status = 'out-for-lunch';
        if (parsedData.breakStart) existing.breakStart = parsedData.breakStart;
        if (parsedData.breakEnd) existing.breakEnd = parsedData.breakEnd;
        return this.saveAttendance(existing);
      }
      return this.savePendingMessage({
        id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
        timestamp: messageTimestamp || new Date().toISOString(),
        sender: parsedData.rawSender || "Unknown",
        messageText: rawText,
        reason: "Out for lunch message without an active check-in",
        extractedName: employee.name,
        extractedSite: site.name,
        extractedAction: "out-for-lunch",
        extractedTime: parsedData.extractedTime,
        extractedDate: targetDateStr
      });
    } else if (parsedData.extractedAction === 'late') {
      if (existingLogIndex >= 0) {
        const existing = db.attendance[existingLogIndex];
        existing.isLate = true;
        if (parsedData.hospitalHours) {
          existing.isHospitalCase = true;
          existing.hospitalHours = parsedData.hospitalHours;
        }
        if (existing.messageText) {
          const parts = existing.messageText.split(' | ').map(p => p.trim());
          if (!parts.includes(rawText.trim())) {
            existing.messageText = [...parts, rawText.trim()].join(' | ');
          }
        } else {
          existing.messageText = rawText;
        }
        return this.saveAttendance(existing);
      }
      
      const record = {
        employeeId: employee.id,
        employeeName: employee.name,
        siteName: site.name,
        date: targetDateStr,
        checkIn: null,
        checkOut: null,
        messageText: rawText,
        status: "late",
        isLate: true,
        isHospitalCase: !!parsedData.isHospitalCase,
        hospitalHours: parsedData.hospitalHours || 0.0,
        scannedCheckIn: false,
        travelHours: parsedData.travelHours || 0.0,
        punches: []
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
        status: parsedData.isLate ? "late" : "checked-in",
        isLate: !!parsedData.isLate,
        isHospitalCase: !!parsedData.isHospitalCase,
        hospitalHours: parsedData.hospitalHours || 0.0,
        scannedCheckIn: false,
        travelHours: parsedData.travelHours || 0.0
      };
      record.punches = [
        {
          time: record.checkIn,
          type: 'in',
          siteName: site.name,
          messageText: rawText,
          source: parsedData.source || 'WhatsApp'
        }
      ];
      return this.saveAttendance(record);
    } else if (parsedData.extractedAction === 'out') {
      const timestamp = parsedData.checkOutTime || getFallbackTimestamp();
      if (existingLogIndex >= 0) {
        const existing = db.attendance[existingLogIndex];
        // Apply check-out
        existing.checkOut = timestamp;
        if (!existing.punches) existing.punches = [];
        const punchExists = existing.punches.some(p => p.time === timestamp && p.type === 'out');
        if (!punchExists) {
          existing.punches.push({
            time: timestamp,
            type: 'out',
            siteName: site.name,
            messageText: rawText,
            source: parsedData.source || 'WhatsApp'
          });
        }
        
        let isNewMessageText = true;
        if (existing.messageText) {
          const parts = existing.messageText.split(' | ').map(p => p.trim());
          if (parts.includes(rawText.trim())) {
            isNewMessageText = false;
          } else {
            existing.messageText = [...parts, rawText.trim()].join(' | ');
          }
        } else {
          existing.messageText = rawText;
        }

        if (isNewMessageText) {
          if (parsedData.travelHours) {
            existing.travelHours = (existing.travelHours || 0.0) + parsedData.travelHours;
          }
          if (parsedData.isHospitalCase) {
            existing.isHospitalCase = true;
            existing.hospitalHours = (existing.hospitalHours || 0.0) + parsedData.hospitalHours;
          }
        }
        return this.saveAttendance(existing);
      } else {
        // Checked out without checking in! Mark as flagged/pending review
        return this.savePendingMessage({
          id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
          timestamp: messageTimestamp || new Date().toISOString(),
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
      // Auto-attendance for supervisor/sender
      const senderPhone = parsedData.items.find(i => i.rawSender)?.rawSender;
      if (senderPhone) {
        const db = this.read();
        const cleanSender = senderPhone.replace(/\D/g, '');
        const supervisor = db.employees.find(e => e.phone && e.phone.replace(/\D/g, '') === cleanSender && e.status === 'active');
        if (supervisor) {
          // Check if supervisor is already in the parsed list with a valid shift (e.g. checkIn and checkOut both set)
          const supervisorItems = parsedData.items.filter(item => item.matchedEmployeeId === supervisor.id);
          const hasFullShift = supervisorItems.some(i => i.checkInTime && i.checkOutTime);
          
          if (!hasFullShift) {
            // Find target date (from items or message timestamp)
            const targetDateStr = parsedData.items.find(i => i.checkInTime)?.checkInTime?.split('T')[0] || getLocalDateString(messageTimestamp || Date.now());
            
            // Gather all check-in/out times from OTHER workers' parsed items for this date
            const otherItems = parsedData.items.filter(item => item.matchedEmployeeId !== supervisor.id);
            
            const validCheckIns = otherItems
              .filter(i => i.checkInTime && i.checkInTime.startsWith(targetDateStr))
              .map(i => new Date(i.checkInTime).getTime());
            
            const validCheckOuts = otherItems
              .filter(i => i.checkOutTime && i.checkOutTime.startsWith(targetDateStr))
              .map(i => new Date(i.checkOutTime).getTime());
              
            if (validCheckIns.length > 0) {
              const minCheckIn = new Date(Math.min(...validCheckIns)).toISOString();
              const maxCheckOut = validCheckOuts.length > 0 ? new Date(Math.max(...validCheckOuts)).toISOString() : null;
              
              // Gather combined site names from other items
              const siteNames = otherItems
                .filter(i => i.extractedSite && i.extractedSite !== '—')
                .map(i => i.extractedSite);
              const combinedSiteName = [...new Set(siteNames)].join(' / ') || '—';
              
              console.log(`[Database] Auto-marking supervisor ${supervisor.name} attendance: check-in=${minCheckIn}, check-out=${maxCheckOut}, site=${combinedSiteName}`);
              
              const supervisorParsedItem = {
                isSuccess: true,
                reason: "",
                matchedEmployeeId: supervisor.id,
                matchedSiteId: null,
                extractedName: supervisor.name,
                extractedSite: combinedSiteName,
                extractedAction: maxCheckOut ? 'completed' : 'in',
                checkInTime: minCheckIn,
                checkOutTime: maxCheckOut,
                confidence: 1.0,
                rawSender: senderPhone,
                originalLineText: `[Auto-Generated Supervisor Shift: ${combinedSiteName}]`
              };
              
              try {
                const logged = this.recordSingleFromWhatsApp(supervisorParsedItem, rawText, messageTimestamp);
                if (logged) logs.push(logged);
              } catch (e) {
                console.error("Failed to log supervisor auto-attendance:", e);
              }
            }
          }
        }
      }
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
    const todayStr = getLocalDateString();
    
    // Find all attendance records from previous days that are checked-in but not checked-out
    const pendingLogs = db.attendance.filter(log => log.date < todayStr && log.checkIn && !log.checkOut);
    
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
    if (this.skipExcelSync) {
      this.pendingExcelSync = true;
      return;
    }
    
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
        uniqueDates.push(getLocalDateString());
      }

      const excelRows = [];

      uniqueDates.forEach(dateStr => {
        // Fetch completed dynamic attendance sheet for that date (includes Absent/Excused)
        const dailySheet = this.getAttendanceForDate(dateStr, db);
        
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
            "Detailed Punches Log": row.punches && row.punches.length > 0
              ? row.punches.map(p => {
                  let timeStr = "—";
                  try {
                    timeStr = new Date(p.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                  } catch(e) {}
                  return `${p.type.toUpperCase()}: ${timeStr} (${p.siteName})`;
                }).join(' | ')
              : "—",
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

      // Compile and append Welders Weekly Report sheet
      try {
        const weeklyRows = this.compileWeldersWeeklyReport(db);
        if (weeklyRows && weeklyRows.length > 0) {
          const wsWeekly = XLSX.utils.json_to_sheet(weeklyRows);
          
          // Auto-fit column widths for a professional finish!
          const colsWeekly = Object.keys(weeklyRows[0]);
          wsWeekly['!cols'] = colsWeekly.map(col => {
            const maxCharLen = Math.max(
              col.length,
              ...weeklyRows.map(row => String(row[col] || '').length)
            );
            return { wch: Math.max(12, maxCharLen + 2) };
          });
          
          XLSX.utils.book_append_sheet(wb, wsWeekly, "Welders Weekly Report");
        }
      } catch (errWeekly) {
        console.error("[Excel Sync] Failed to compile Welders Weekly sheet:", errWeekly);
      }
      
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
      
      // Count present days from logs (include late check-in days)
      const empLogs = attendanceLogs.filter(log => log.employeeId === emp.id);
      const presentCount = empLogs.filter(log => log.status === 'completed' || log.status === 'checked-in' || (log.status === 'late' && log.checkIn) || log.status === 'Late Check-in' || log.status === 'Early Check-out').length;
      
      // Calculate hospital case exemptions and standard late counts chronologically
      const sortedEmpLogs = [...empLogs].sort((a, b) => a.date.localeCompare(b.date));
      let hospitalDaysCount = 0;
      let hospitalHoursCount = 0;
      let standardLateCount = 0;

      sortedEmpLogs.forEach(log => {
        if (log.isHospitalCase) {
          const claimedHours = Number(log.hospitalHours || 0);
          if (hospitalDaysCount < 2 && (hospitalHoursCount + claimedHours) <= 2) {
            hospitalDaysCount += 1;
            hospitalHoursCount += claimedHours;
            log.isHospitalExempt = true;
          } else {
            log.isHospitalExempt = false;
          }
        } else {
          log.isHospitalExempt = false;
        }

        if ((log.status === 'late' || log.status === 'Late Check-in' || log.isLate) && !log.isHospitalExempt) {
          standardLateCount += 1;
        }
      });

      const lateLopDays = Math.max(0, standardLateCount - 2) * 0.5;

      // Default std working days (30 for office staff, 26 for all others)
      const stdWorkingDays = adj.stdWorkingDays !== undefined ? Number(adj.stdWorkingDays) : defaultStdDays;
      
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
        const defaultLopDays = Math.max(0, stdWorkingDays - presentCount);
        lopDays = adj.lopDays !== undefined ? Number(adj.lopDays) : (defaultLopDays + lateLopDays);
        if (emp.fixedSalary === true || emp.fixedSalary === 'true' || emp.salaryLocked === true) {
          lopDays = adj.lopDays !== undefined ? Number(adj.lopDays) : 0;
        }
        workingDays = Number((stdWorkingDays - lopDays).toFixed(2));
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
        lopDays = adj.lopDays !== undefined ? Number(adj.lopDays) : (absentCount + lateLopDays);
        if (emp.fixedSalary === true || emp.fixedSalary === 'true' || emp.salaryLocked === true) {
          lopDays = adj.lopDays !== undefined ? Number(adj.lopDays) : 0;
        }
        lopAmount = Number((lopDays * dailyRate * lopDeductionRate).toFixed(2));
        workingDays = Number((stdWorkingDays - lopDays).toFixed(2));
        amount = Number((actualSalary * (workingDays / stdWorkingDays)).toFixed(2));
      }
      
      let F = 8.0;
      if (emp.shiftStart && emp.shiftEnd) {
        try {
          const [startH, startM] = emp.shiftStart.split(':').map(Number);
          const [endH, endM] = emp.shiftEnd.split(':').map(Number);
          let shiftMinutes = (endH * 60 + endM) - (startH * 60 + startM);
          if (shiftMinutes < 0) shiftMinutes += 24 * 60;
          const shiftHours = shiftMinutes / 60;
          F = shiftHours >= 9.0 ? shiftHours - 1.0 : shiftHours;
        } catch (err) {
          console.warn(`Failed to parse shift times for ${emp.name} in database payroll calculation:`, err.message);
        }
      }
      const hourlyRate = Number(emp.hourlyRate) || Number((dailyRate / F).toFixed(2)) || 0.0;
      
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
        ? Number((otHours * hourlyRate).toFixed(2))
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
        dailyRate,
        lateDays: standardLateCount,
        lateLopDays: lateLopDays
      };
    });
  }

  // --- Welders Weekly Reports and Payroll Calculations ---
  getWeldersWeeklyReportData(fridayDateStr, db = null) {
    if (!db) db = this.read();
    
    const fridayDate = new Date(fridayDateStr);
    const dayNames = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const datesOfWeek = [];
    for (let i = -6; i <= 0; i++) {
      const d = new Date(fridayDate.getTime());
      d.setUTCDate(d.getUTCDate() + i);
      datesOfWeek.push(d.toISOString().split('T')[0]);
    }
    
    const welders = (db.employees || []).filter(e => e && e.modeOfWork && e.modeOfWork.toLowerCase().includes('welder'));
    const attendanceLogs = db.attendance || [];
    
    return welders.map(welder => {
      const dailyDetails = [];
      let totalHours = 0;
      let totalPresentDays = 0;
      let weeklyRegularWage = 0;
      let weeklyOtPay = 0;
      let weeklyTravelPay = 0;
      let totalOtHours = 0;
      let totalTravelHours = 0;
      
      datesOfWeek.forEach((dateStr, index) => {
        const dayName = dayNames[index];
        const log = attendanceLogs.find(a => a.employeeId === welder.id && a.date === dateStr);
        
        let status = "ABSENT";
        let hours = 0;
        let wage = 0;
        let otHours = 0;
        let travelHours = 0;
        let checkIn = "—";
        let checkOut = "—";
        
        if (log) {
          status = log.status.toUpperCase();
          const isPresent = log.status === 'completed' || log.status === 'checked-in' || (log.status === 'late' && log.checkIn) || log.status === 'Late Check-in' || log.status === 'Early Check-out' || log.status === 'half-day leave';
          
          if (isPresent) {
            totalPresentDays += 1;
            hours = log.status === 'absent' || log.status === 'leave' ? 0.0 : Number((log.duration / 60).toFixed(2));
            totalHours += hours;
            
            const isFriday = (index === 6);
            // Overtime excluded on Friday
            const actualOtHours = isFriday ? 0.0 : (Number(log.otHours) || 0.0);
            otHours = actualOtHours;
            
            const dailyRate = Number(welder.dailyRate) || 0.0;
            const hourlyRate = Number(welder.hourlyRate) || 0.0;
            
            let F = 8.0;
            let h = 4.0;
            if (welder.shiftStart && welder.shiftEnd) {
              try {
                const [startH, startM] = welder.shiftStart.split(':').map(Number);
                const [endH, endM] = welder.shiftEnd.split(':').map(Number);
                let shiftMinutes = (endH * 60 + endM) - (startH * 60 + startM);
                if (shiftMinutes < 0) shiftMinutes += 24 * 60;
                const shiftHours = shiftMinutes / 60;
                F = shiftHours >= 9.0 ? shiftHours - 1.0 : shiftHours;
                h = F / 2.0;
              } catch(e) {}
            }
            
            let dailyWage = 0.0;
            const forceHalfDay = log.status === 'half-day leave';
            
            if (log.isManualOverride) {
              const manualWage = Number(log.calculatedWage) || 0.0;
              if (isFriday) {
                const manualOt = Number(log.otHours) || 0.0;
                const otPayout = Number((manualOt * hourlyRate).toFixed(2));
                dailyWage = Math.max(0, Number((manualWage - otPayout).toFixed(2)));
              } else {
                dailyWage = manualWage;
                const dailyOtHours = Number(log.otHours) || 0.0;
                weeklyOtPay += Number((dailyOtHours * hourlyRate).toFixed(2));
              }
            } else {
              if (hours >= F && !forceHalfDay) {
                dailyWage = dailyRate;
                if (!isFriday) {
                  const dayOtPay = Number((otHours * hourlyRate).toFixed(2));
                  weeklyOtPay += dayOtPay;
                  dailyWage += dayOtPay;
                }
              } else if (hours >= h || forceHalfDay) {
                const extraH = Math.max(0.0, Number((hours - h).toFixed(2)));
                dailyWage = Number(((dailyRate * 0.5) + (extraH * hourlyRate)).toFixed(2));
              } else {
                dailyWage = Number((hours * hourlyRate).toFixed(2));
              }
            }
            
            wage = dailyWage;
            travelHours = Number(log.travelHours) || 0.0;
            weeklyTravelPay += Number((travelHours * hourlyRate).toFixed(2));
            totalOtHours += otHours;
            totalTravelHours += travelHours;
            
            checkIn = log.checkIn ? new Date(log.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : "—";
            checkOut = log.checkOut ? new Date(log.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : (log.status === 'checked-in' ? "Checked-In" : "—");
          }
        }
        
        dailyDetails.push({
          date: dateStr,
          dayName,
          status,
          hours,
          otHours,
          wage,
          travelHours,
          checkIn,
          checkOut
        });
      });
      
      const totalWage = dailyDetails.reduce((sum, d) => sum + d.wage, 0);
      const totalWeeklyEarnings = Number((totalWage + weeklyTravelPay).toFixed(2));
      
      return {
        welderId: welder.userId,
        welderName: welder.name,
        dailyRate: welder.dailyRate,
        dailyDetails,
        totalHours: Number(totalHours.toFixed(2)),
        totalPresentDays,
        weeklyRegularWage: Number((totalWage - weeklyOtPay).toFixed(2)),
        weeklyOtPay: Number(weeklyOtPay.toFixed(2)),
        weeklyTravelPay: Number(weeklyTravelPay.toFixed(2)),
        totalWeeklyEarnings,
        modeOfWork: welder.modeOfWork || "—",
        company: welder.paymentMode || "—",
        totalOtHours: Number(totalOtHours.toFixed(2)),
        totalTravelHours: Number(totalTravelHours.toFixed(2))
      };
    });
  }

  compileWeldersWeeklyReport(db) {
    const uniqueDates = Array.from(new Set(db.attendance.map(a => a.date)));
    const fridays = uniqueDates.filter(d => {
      try {
        return new Date(d).getDay() === 5;
      } catch (e) {
        return false;
      }
    }).sort((a, b) => a.localeCompare(b));
    
    const rows = [];
    fridays.forEach(fridayStr => {
      const data = this.getWeldersWeeklyReportData(fridayStr, db);
      data.forEach(w => {
        const sat = w.dailyDetails[0];
        const sun = w.dailyDetails[1];
        const mon = w.dailyDetails[2];
        const tue = w.dailyDetails[3];
        const wed = w.dailyDetails[4];
        const thu = w.dailyDetails[5];
        const fri = w.dailyDetails[6];
        
        rows.push({
          "Week Ending (Friday)": fridayStr,
          "Welder ID": w.welderId,
          "Welder Name": w.welderName,
          "Daily Rate (₹)": w.dailyRate,
          "Sat Hours": sat.hours || 0,
          "Sun Hours": sun.hours || 0,
          "Mon Hours": mon.hours || 0,
          "Tue Hours": tue.hours || 0,
          "Wed Hours": wed.hours || 0,
          "Thu Hours": thu.hours || 0,
          "Fri Hours": fri.hours || 0,
          "Total Weekly Hours": w.totalHours,
          "Total Present Days": w.totalPresentDays,
          "Weekly Regular Wage (₹)": w.weeklyRegularWage,
          "Weekly Overtime Pay (₹)": w.weeklyOtPay,
          "Weekly Travel Pay (₹)": w.weeklyTravelPay,
          "Total Weekly Earnings (₹)": w.totalWeeklyEarnings
        });
      });
    });
    
    return rows;
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
      selfie.id = selfie.id || `selfie_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
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
