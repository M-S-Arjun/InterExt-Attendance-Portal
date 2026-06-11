const fs = require('fs');
const path = require('path');

const codeApp = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const linesApp = codeApp.split('\n');
console.log("--- public/app.js division by 8 ---");
linesApp.forEach((line, i) => {
  if (line.match(/\/ *8(\.0+)?\b/)) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});

const codeDB = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const linesDB = codeDB.split('\n');
console.log("--- database.js division by 8 ---");
linesDB.forEach((line, i) => {
  if (line.match(/\/ *8(\.0+)?\b/)) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
