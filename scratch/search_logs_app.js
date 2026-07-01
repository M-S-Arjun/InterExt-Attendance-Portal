const fs = require('fs');
const content = fs.readFileSync('public/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('/api/attendance') || line.includes('loadLogs') || line.includes('renderLogs')) {
        if (line.length < 150) {
            console.log(`${idx+1}: ${line.trim()}`);
        }
    }
});
