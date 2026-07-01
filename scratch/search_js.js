const fs = require('fs');
const dbJs = fs.readFileSync('database.js', 'utf8');
const lines = dbJs.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('saveUnknownDetection') || line.includes('UnknownDetection') || line.includes('unknownDetections')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
