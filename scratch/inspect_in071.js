const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const emps = db.employees.filter(e => e.userId === 'IN071');
  console.log("Employees with userId IN071:", JSON.stringify(emps, null, 2));
} else {
  console.log("data.json not found");
}
