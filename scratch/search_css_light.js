const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const lines = css.split('\n');
console.log("--- public/style.css .light-theme matches ---");
lines.forEach((line, i) => {
  if (line.includes('light-theme') || line.includes('light')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
