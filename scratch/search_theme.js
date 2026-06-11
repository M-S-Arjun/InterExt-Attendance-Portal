const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const linesApp = appJs.split('\n');
console.log("--- public/app.js theme matches ---");
linesApp.forEach((line, i) => {
  if (line.includes('theme') || line.includes('Theme') || line.includes('dark') || line.includes('light')) {
    if (line.includes('toggle') || line.includes('class') || line.includes('set') || line.includes('localStorage') || line.includes('click')) {
      console.log(`${i + 1}: ${line.trim()}`);
    }
  }
});

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const linesHtml = indexHtml.split('\n');
console.log("--- public/index.html theme matches ---");
linesHtml.forEach((line, i) => {
  if (line.includes('theme') || line.includes('Theme') || line.includes('dark') || line.includes('light')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
