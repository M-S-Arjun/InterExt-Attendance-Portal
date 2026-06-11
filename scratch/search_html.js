const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const lines = html.split('\n');
lines.forEach((line, i) => {
  if (line.includes('<table') || line.includes('</table>') || line.includes('id="employee') || line.includes('id="workers')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
