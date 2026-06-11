const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const linesApp = appJs.split('\n');
console.log("--- public/app.js matches ---");
linesApp.forEach((line, i) => {
  if (line.includes('Active Registry') || line.includes('Absent Today') || line.includes('metric-modal') || line.includes('metric-employees')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const linesHtml = indexHtml.split('\n');
console.log("--- public/index.html matches ---");
linesHtml.forEach((line, i) => {
  if (line.includes('metric-employees') || line.includes('Active Registry') || line.includes('Absent Today')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
