const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'public', 'app.js'),
  path.join(__dirname, '..', 'database.js'),
  path.join(__dirname, '..', 'whatsapp.js'),
  path.join(__dirname, '..', 'parser.js'),
  path.join(__dirname, '..', 'server.js')
];

files.forEach(file => {
  if (fs.existsSync(file)) {
    const code = fs.readFileSync(file, 'utf8');
    const lines = code.split('\n');
    const filename = path.basename(file);
    lines.forEach((line, i) => {
      if (line.includes('TODO') || line.includes('FIXME') || line.includes('BUG') || line.includes('workHours')) {
        console.log(`${filename}:${i + 1}: ${line.trim()}`);
      }
    });
  }
});
