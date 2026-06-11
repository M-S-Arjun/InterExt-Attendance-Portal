const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const lines = html.split('\n');
lines.forEach((line, i) => {
  if (line.includes('class="modal"') || (line.includes('class=') && line.includes('modal') && line.includes('id='))) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
