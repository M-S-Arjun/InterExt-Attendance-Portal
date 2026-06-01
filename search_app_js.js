const fs = require('fs');
const appJs = fs.readFileSync('public/app.js', 'utf8');

console.log("=== SEARCHING SWITCHTAB IN APP.JS ===");
const lines = appJs.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('switchTab') || line.includes('active') && line.includes('tab-')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});

console.log("\n=== SEARCHING FOR TABS LIST IN APP.JS ===");
const tabMatches = appJs.match(/const\s+tabs\s*=\s*\[[^\]]+\]/i) || appJs.match(/switchTab\s*=\s*\(.*\)\s*=>/i) || [];
console.log("Matches:", tabMatches);
