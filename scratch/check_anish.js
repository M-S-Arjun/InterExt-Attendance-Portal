const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data.json');

try {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const emp = db.employees.find(e => e.name.includes('Anish Viswanathan'));
  console.log(JSON.stringify(emp, null, 2));
} catch (err) {
  console.error(err);
}
