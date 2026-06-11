const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  
  // Find Sunil Rana in employees
  const sunil = db.employees.find(e => e.name === 'Sunil Rana' && e.userId === 'IN071');
  if (sunil) {
    sunil.id = 'emp_IN072';
    sunil.userId = 'IN072';
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    console.log("Sunil Rana's ID and userId updated successfully.");
  } else {
    console.log("Sunil Rana with userId IN071 not found.");
  }
} else {
  console.log("data.json not found");
}
