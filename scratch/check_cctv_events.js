const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data.json');

try {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const today = '2026-06-30';
  
  if (db.cameraEvents) {
    const events = db.cameraEvents.filter(e => e.date === today && e.employeeName.includes('Manu'));
    console.log(JSON.stringify(events, null, 2));
  } else {
    console.log('No cameraEvents field in DB');
  }
} catch (err) {
  console.error(err);
}
