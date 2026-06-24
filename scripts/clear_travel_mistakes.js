const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const database = require('../database');

const dbPath = path.join(__dirname, '../data.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

console.log(`Starting database travel hours cleanup...`);
let updateCount = 0;

db.attendance.forEach(log => {
  const parts = (log.messageText || '').split(' | ').map(p => p.trim()).filter(Boolean);
  let maxTravelHours = 0;

  for (const part of parts) {
    if (part.includes('[System Auto-Checkout') || part.includes('Punching Machine') || part.includes('CCTV Face recognized') || part.includes('Biometric')) {
      continue;
    }
    try {
      const parsed = parser.parse(part, "", new Date(log.date + 'T12:00:00Z').toISOString());
      let partTravel = 0;
      if (parsed.isList) {
        const item = parsed.items.find(it => it.matchedEmployeeId === log.employeeId);
        partTravel = item ? (item.travelHours || 0) : 0;
      } else {
        if (parsed.matchedEmployeeId === log.employeeId) {
          partTravel = parsed.travelHours || 0;
        }
      }
      if (partTravel > maxTravelHours) {
        maxTravelHours = partTravel;
      }
    } catch (e) {
      // ignore
    }
  }

  // Ensure travelHours is updated to corrected value
  const oldVal = log.travelHours || 0;
  if (oldVal !== maxTravelHours) {
    console.log(`Correcting ${log.date} | ${log.employeeName}: ${oldVal} hrs -> ${maxTravelHours} hrs (Msg: "${log.messageText}")`);
    log.travelHours = maxTravelHours;
    updateCount++;
  }
});

if (updateCount > 0) {
  // Write the corrected database back to disk
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  console.log(`Successfully updated ${updateCount} records in data.json.`);

  // Recompile the Excel spreadsheet to reflect corrected travel hours
  console.log(`Recompiling Excel spreadsheet...`);
  database.syncToExcel();
  console.log(`Database and spreadsheet successfully updated.`);
} else {
  console.log(`No records needed updates.`);
}
