const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const lines = html.split('\n');
lines.forEach((line, i) => {
  if (line.includes('class="modal-body"') || line.includes('modal-body')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
