const fs = require('fs');
const db = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const statuses = new Set(db.attendance.map(a => a.status));
console.log("Unique attendance statuses:", Array.from(statuses));
