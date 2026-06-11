const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const linesApp = appJs.split('\n');
console.log("--- public/app.js site matches ---");
linesApp.forEach((line, i) => {
  if (line.includes('editSite') || line.includes('openSite') || line.includes('saveSite') || line.includes('SiteModal') || line.includes('site-modal')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const linesHtml = html.split('\n');
console.log("--- public/index.html site matches ---");
linesHtml.forEach((line, i) => {
  if (line.includes('site-modal') || line.includes('Site Modal') || line.includes('SiteModal')) {
    console.log(`${i + 1}: ${line.trim()}`);
  }
});
