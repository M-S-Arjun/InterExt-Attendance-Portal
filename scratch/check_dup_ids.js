const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const ids = {};
  db.employees.forEach(emp => {
    if (ids[emp.id]) {
      console.log("DUPLICATE ID FOUND:", emp.id, "Names:", ids[emp.id].name, "and", emp.name);
    } else {
      ids[emp.id] = emp;
    }
  });
  console.log("Finished ID check.");
} else {
  console.log("data.json not found");
}
