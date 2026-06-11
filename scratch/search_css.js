const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const lines = css.split('\n');
lines.forEach((line, i) => {
  if (line.includes('thead') || line.includes('sticky') || line.includes('data-table') || line.includes('.modal-body')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
