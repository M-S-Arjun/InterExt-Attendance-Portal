const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const lines = html.split('\n');
lines.forEach((line, i) => {
  if (line.includes('tab-') || line.includes('nav-') || line.includes('showTab') || line.includes('switchTab')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
