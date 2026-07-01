const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'data.json');
if (!fs.existsSync(dataPath)) {
  console.log("No data.json file found at", dataPath);
  process.exit(1);
}

try {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const targetDate = "2026-06-23";
  console.log("Checking punches for date:", targetDate);
  
  const targetAttendance = (data.attendance || []).filter(a => a.date === targetDate);
  
  if (targetAttendance.length === 0) {
    console.log(`No attendance records found for ${targetDate}.`);
  } else {
    for (const record of targetAttendance) {
      const emp = (data.employees || []).find(e => e.id === record.employeeId);
      console.log(`\nEmployee: ${emp ? emp.name : 'Unknown'} (ID: ${record.employeeId})`);
      console.log(`Date: ${record.date}`);
      console.log(`Check-In: ${record.checkIn}`);
      console.log(`Check-Out: ${record.checkOut}`);
      console.log(`Status: ${record.status}`);
      console.log(`Punches:`);
      if (record.punches) {
        record.punches.forEach((p, idx) => {
          console.log(`  ${idx+1}. Time: ${p.time}, Type: ${p.type}, Site: ${p.siteName}, Source: ${p.source}, Msg: ${p.messageText}`);
        });
      } else {
        console.log("  No detailed punches array on this record.");
      }
    }
  }
} catch (err) {
  console.error("Error reading data.json:", err);
}
