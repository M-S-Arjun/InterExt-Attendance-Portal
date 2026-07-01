const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data.json');

try {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const todayStr = '2026-06-22';
  
  console.log('--- ALL PUNCHES TODAY ---');
  let todayPunches = [];
  if (db.attendance) {
    db.attendance.forEach(att => {
      if (att.date === todayStr && att.punches) {
        att.punches.forEach(p => {
          todayPunches.push({
            employeeName: att.employeeName,
            time: p.time,
            localTime: new Date(p.time).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
            type: p.type,
            source: p.source,
            siteName: p.siteName
          });
        });
      }
    });
  }
  
  todayPunches.sort((a, b) => new Date(a.time) - new Date(b.time));
  console.log(`Total punches today: ${todayPunches.length}`);
  console.log('Last 10 punches:');
  todayPunches.slice(-10).forEach(p => {
    console.log(`- ${p.localTime} | ${p.employeeName} | ${p.type.toUpperCase()} | ${p.source} | ${p.siteName}`);
  });

  console.log('\n--- ALL UNKNOWN DETECTIONS TODAY ---');
  let todayUnknowns = [];
  if (db.unknownDetections) {
    db.unknownDetections.forEach(det => {
      const timestamp = det.timestamp || det.createdAt;
      if (timestamp && timestamp.startsWith(todayStr)) {
        todayUnknowns.push({
          id: det.id,
          cameraName: det.cameraName,
          time: timestamp,
          localTime: new Date(timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
          confidence: det.confidence
        });
      }
    });
  }
  
  todayUnknowns.sort((a, b) => new Date(a.time) - new Date(b.time));
  console.log(`Total unknown detections today: ${todayUnknowns.length}`);
  console.log('Last 10 unknown detections:');
  todayUnknowns.slice(-10).forEach(det => {
    console.log(`- ${det.localTime} | ${det.cameraName} | Conf: ${det.confidence} | ID: ${det.id}`);
  });

} catch (err) {
  console.error('Error reading db:', err);
}
