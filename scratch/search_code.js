const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const lines = code.split('\n');
lines.forEach((line, i) => {
  if (line.includes('syncToExcel') || line.includes('sync') || line.includes('excel')) {
    console.log(`${i + 1}: ${line}`);
  }
});
