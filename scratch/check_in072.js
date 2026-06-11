const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const emp = db.employees.find(e => e.userId === 'IN072' || e.id === 'emp_IN072');
  console.log("Employee with userId/id IN072/emp_IN072:", JSON.stringify(emp, null, 2));
} else {
  console.log("data.json not found");
}
