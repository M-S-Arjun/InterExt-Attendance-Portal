const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const linesApp = appJs.split('\n');
console.log("--- public/app.js modal click matches ---");
linesApp.forEach((line, i) => {
  if (line.includes('modal') && (line.includes('click') || line.includes('target') || line.includes('addEventListener'))) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
