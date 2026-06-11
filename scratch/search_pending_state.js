const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = code.split('\n');
lines.forEach((line, i) => {
  if (line.includes('state.pendingMessages') || line.includes('pendingMessages')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
