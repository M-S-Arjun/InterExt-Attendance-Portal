const fs = require('fs');
const content = fs.readFileSync('public/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('switchTab')) {
        console.log(`${idx+1}: ${line.trim()}`);
    }
});
