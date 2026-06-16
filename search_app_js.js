const fs = require('fs');
const appJs = fs.readFileSync('public/app.js', 'utf8');

const jsLines = appJs.split('\n');
jsLines.forEach((line, idx) => {
  if (line.includes('checkIn') || line.includes('checkOut') || line.includes('renderLogs') || line.includes('renderAttendance')) {
    if (line.includes('innerHTML') || line.includes('tr') || line.includes('td')) {
      console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
  }
});

