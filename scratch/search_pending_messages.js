const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = code.split('\n');
lines.forEach((line, i) => {
  if (line.includes('pending_messages') || line.includes('pendingMessages') || line.includes('exceptions') || line.includes('exception')) {
    if (line.includes('render') || line.includes('innerHTML') || line.includes('forEach') || line.includes('list') || line.includes('sort') || line.includes('map')) {
      console.log(`${i + 1}: ${line.trim()}`);
    }
  }
});
