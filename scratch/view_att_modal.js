const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const lines = html.split('\n');
let modalStart = -1;
let modalEnd = -1;
lines.forEach((line, i) => {
  if (line.includes('id="attendance-modal"')) {
    modalStart = i;
  }
  if (modalStart !== -1 && modalEnd === -1 && line.includes('</form>')) {
    modalEnd = i;
  }
});
if (modalStart !== -1 && modalEnd !== -1) {
  console.log(`Attendance Modal block (lines ${modalStart+1} to ${modalEnd+1}):`);
  for (let i = modalStart - 2; i <= modalEnd + 5; i++) {
    console.log(`${i+1}: ${lines[i]}`);
  }
} else {
  console.log("Could not find attendance modal block");
}
