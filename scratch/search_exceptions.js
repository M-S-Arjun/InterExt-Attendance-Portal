const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = code.split('\n');
lines.forEach((line, i) => {
  if (line.includes('Exception') || line.includes('pending') || line.includes('dispute') || line.includes('pending-messages') || line.includes('renderPending')) {
    if (line.includes('function') || line.includes('render') || line.includes('sort') || line.includes('find') || line.includes('load')) {
      console.log(`${i + 1}: ${line.trim()}`);
    }
  }
});
