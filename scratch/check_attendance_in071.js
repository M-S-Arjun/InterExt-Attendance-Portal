const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const logs = db.attendance.filter(a => a.employeeId === 'emp_IN071' || a.employeeId === 'IN071' || a.employeeName.includes('Rana'));
  console.log(`Found ${logs.length} attendance records:`);
  logs.forEach(l => {
    console.log(`${l.date} | ID: ${l.employeeId} | Name: ${l.employeeName} | status: ${l.status}`);
  });
} else {
  console.log("data.json not found");
}
