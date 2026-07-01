const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data.json');

try {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const today = '2026-06-30';
  
  const entries = db.attendance.filter(att => att.date === today && (att.employeeName.includes('Manu') || att.employeeName.includes('Anish')));
  console.log(JSON.stringify(entries, null, 2));
} catch (err) {
  console.error(err);
}
