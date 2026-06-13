const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = code.split('\n');
lines.forEach((line, i) => {
  if (line.includes('app.get') || line.includes('app.post') || line.includes('/api/')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
