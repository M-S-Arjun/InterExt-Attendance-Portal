const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const lines = css.split('\n');
lines.forEach((line, i) => {
  if (line.includes('table-responsive')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
