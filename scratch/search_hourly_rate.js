const fs = require('fs');
const path = require('path');

const codeDB = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const linesDB = codeDB.split('\n');
console.log("--- database.js matches ---");
linesDB.forEach((line, i) => {
  if (line.includes('hourlyRate') || line.includes('hourly') || line.includes('Rate')) {
    if (line.includes('=') || line.includes('/') || line.includes('function') || line.includes('Math.round') || line.includes('toFixed')) {
      console.log(`${i + 1}: ${line.trim()}`);
    }
  }
});

const codeApp = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const linesApp = codeApp.split('\n');
console.log("--- public/app.js matches ---");
linesApp.forEach((line, i) => {
  if (line.includes('hourlyRate') || line.includes('hourly') || line.includes('Rate')) {
    if (line.includes('=') || line.includes('/') || line.includes('function') || line.includes('Math.round') || line.includes('toFixed')) {
      console.log(`${i + 1}: ${line.trim()}`);
    }
  }
});
