const fs = require('fs');
const db = JSON.parse(fs.readFileSync('data.json', 'utf8'));
console.log("Attendance record schema sample:");
if (db.attendance && db.attendance.length > 0) {
    // find one record with punches or checkIn
    const record = db.attendance.find(r => r.checkIn || r.punches);
    console.log(JSON.stringify(record || db.attendance[0], null, 2));
} else {
    console.log("No attendance records found.");
}
console.log("Employees schema sample:");
if (db.employees && db.employees.length > 0) {
    console.log(JSON.stringify(db.employees[0], null, 2));
} else {
    console.log("No employees found.");
}
