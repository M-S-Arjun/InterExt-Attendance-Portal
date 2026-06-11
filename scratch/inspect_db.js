const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  console.log("Database employees details:");
  db.employees.forEach(emp => {
    console.log(`${emp.userId} | ${emp.name} | ${emp.shiftStart} - ${emp.shiftEnd} | Daily: ${emp.dailyRate} | Monthly: ${emp.monthlyWage} | Mode: ${emp.modeOfWork}`);
  });
} else {
  console.log("data.json not found");
}
