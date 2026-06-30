const fs = require('fs');
const db = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const travelLogs = db.attendance.filter(a => a.travelHours > 0);
const months = [...new Set(travelLogs.map(a => a.date.substring(0,7)))].sort();
console.log('Months with travel data:', JSON.stringify(months));
console.log('Total travel logs:', travelLogs.length);
console.log('Sample:', JSON.stringify(travelLogs.slice(0,5).map(a => ({date:a.date,emp:a.employeeName,hrs:a.travelHours}))));
