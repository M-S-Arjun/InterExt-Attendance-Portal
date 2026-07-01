const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data.json');

try {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const mismatches = [];

  if (db.attendance) {
    db.attendance.forEach(att => {
      // Find logs with 'late' status, that have a checkIn, but scannedCheckIn is not true
      // Or records that have isLate = true but checkIn is set without scannedCheckIn
      if (att.status === 'late' && att.checkIn && !att.scannedCheckIn) {
        mismatches.push(att);
      }
    });
  }

  console.log(`Found ${mismatches.length} mismatches where status is 'late', has checkIn, but scannedCheckIn is false/unset.`);
  
  if (mismatches.length > 0) {
    console.log('Sample mismatches (first 10):');
    mismatches.slice(0, 10).forEach(m => {
      console.log(`- Date: ${m.date} | Employee: ${m.employeeName} | checkIn: ${m.checkIn} | status: ${m.status} | msg: "${m.messageText}"`);
    });
  }
} catch (err) {
  console.error('Error:', err);
}
