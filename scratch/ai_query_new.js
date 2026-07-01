// AI Query Endpoint
// Levenshtein distance helper for spelling tolerance
function levenshteinDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[len1][len2];
}

// Typo-tolerant keyword matching function
function hasFuzzyKeyword(query, keywords) {
  const cleanQuery = query.toLowerCase().trim();
  for (const keyword of keywords) {
    if (cleanQuery.includes(keyword)) return true;
  }
  const words = cleanQuery.split(/\s+/).map(w => w.replace(/[^\w]/g, ''));
  for (const word of words) {
    if (word.length < 3) continue;
    for (const keyword of keywords) {
      const minLen = Math.min(word.length, keyword.length);
      let allowedDistance = 2;
      if (minLen <= 3) allowedDistance = 0;
      else if (minLen === 4) allowedDistance = 1;
      if (levenshteinDistance(word, keyword) <= allowedDistance) return true;
    }
  }
  return false;
}

// AI Query Endpoint — Comprehensive 30+ intent engine
app.post('/api/ai/query', (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const cleanQuery = query.toLowerCase().trim();
    const todayStr = getLocalDateString();
    const db = database.read();
    const employees = db.employees || [];
    const activeEmployees = employees.filter(e => e && e.status === 'active');
    const allAttendance = db.attendance || [];
    const dailyLogs = database.getAttendanceForDate(todayStr) || [];
    const holidays = db.holidays || [];
    const sites = db.sites || [];
    const cameras = db.cctvCameras || [];

    let steps = [];
    let responseText = "";

    // Status helpers
    const isPresent  = s => ['checked-in','completed','late','Late Check-in','Early Check-out','half-day leave'].includes(s);
    const isLeave    = s => s === 'leave';
    const isAbsent   = s => s === 'absent';
    const isLate     = s => ['late','Late Check-in'].includes(s);
    const isEarlyOut = s => s === 'Early Check-out';

    // Fuzzy employee name finder
    function findEmployeeByName(q) {
      const lq = q.toLowerCase().replace(/[^\w\s]/g, '').trim();
      let match = activeEmployees.find(e => lq.includes(e.name.toLowerCase()));
      if (match) return match;
      const words = lq.split(/\s+/);
      let best = null, bestScore = Infinity;
      for (const emp of activeEmployees) {
        for (const nPart of emp.name.toLowerCase().split(/\s+/)) {
          if (nPart.length < 3) continue;
          for (const word of words) {
            if (word.length < 3) continue;
            const dist = levenshteinDistance(word, nPart);
            if (dist < bestScore && dist <= 2) { bestScore = dist; best = emp; }
          }
        }
      }
      return best;
    }

    // Date parser
    function parseDateFromQuery(q) {
      const isoMatch = q.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return isoMatch[1];
      if (q.includes('today')) return todayStr;
      if (q.includes('yesterday')) {
        const y = new Date(); y.setDate(y.getDate() - 1);
        return y.toISOString().split('T')[0];
      }
      const monthNums = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
        january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
      for (const [mName, mNum] of Object.entries(monthNums)) {
        if (q.includes(mName)) {
          const dayMatch = q.match(/(\d{1,2})/);
          if (dayMatch) {
            const yr = new Date().getFullYear();
            return `${yr}-${String(mNum).padStart(2,'0')}-${String(dayMatch[1]).padStart(2,'0')}`;
          }
        }
      }
      return null;
    }

    // Month parser
    function parseMonthFromQuery(q) {
      const monthMap = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
        january:'01',february:'02',march:'03',april:'04',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };
      const now = new Date();
      if (q.includes('this month') || q.includes('current month')) return now.toISOString().substring(0,7);
      if (q.includes('last month') || q.includes('previous month')) {
        const d = new Date(now.getFullYear(), now.getMonth()-1, 1);
        return d.toISOString().substring(0,7);
      }
      for (const [mName, mNum] of Object.entries(monthMap)) {
        if (q.includes(mName)) {
          const yearMatch = q.match(/20\d{2}/);
          const yr = yearMatch ? yearMatch[0] : now.getFullYear();
          return `${yr}-${mNum}`;
        }
      }
      return now.toISOString().substring(0,7);
    }

    function fmtTime(t) {
      if (!t) return '—';
      try { return new Date(t).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}); } catch { return t; }
    }
    function fmtRupee(n) { return '₹' + Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:0}); }
    function monthLabel(ms) {
      const [y,m] = ms.split('-');
      return ['','January','February','March','April','May','June','July','August','September','October','November','December'][parseInt(m)] + ' ' + y;
    }

    // Excel export links
    const today = new Date();
    const yr = today.getFullYear(), mo = String(today.getMonth()+1).padStart(2,'0');
    const startOfMonthStr = `${yr}-${mo}-01`;
    const lastFriday = new Date(today);
    const dow = today.getDay();
    lastFriday.setDate(today.getDate() - ((dow >= 5) ? (dow-5) : (dow+2)));
    const lastFridayStr = getLocalDateString(lastFriday);
    const excelKeywords = ['excel','excl','export','sheet','download','xlsx','report','file','spreadsheet'];
    const isExcelRequested = hasFuzzyKeyword(cleanQuery, excelKeywords);
    const excelSuffix = isExcelRequested
      ? `\n\n📊 **Excel Export:**\n• [Attendance (Excel)](/api/export/excel?startDate=${startOfMonthStr}&endDate=${todayStr})\n• [Payroll (Excel)](/api/export/payroll/excel?startDate=${startOfMonthStr}&endDate=${todayStr})\n• [Welders Report (Excel)](/api/export/welders-weekly/excel?friday=${lastFridayStr})`
      : '';

    // Keyword groups
    const KW = {
      present:  ['present','presnt','attendance','here','marked','presents','attended'],
      absent:   ['absent','absnt','missing','absentees','away','absents','didnt','didn'],
      leave:    ['leave','leve','leaves','vacation','off','sick'],
      payroll:  ['payable','payroll','salary','salry','wage','wages','earnings','payout','pay','net','gross','monthly salary'],
      cctv:     ['cctv','camera','cam','stream','video','feed','cameras'],
      help:     ['help','guide','features','portal','how to use'],
      punch:    ['punch','punches','checkin','check-in','checkout','check-out','entry','exit','time','clock'],
      late:     ['late','latecomers','lateness','delay','delayed'],
      overtime: ['overtime','over-time','ot','extra hours','overwork'],
      top:      ['top','most','highest','maximum','max','best','rank'],
      bottom:   ['least','lowest','minimum','fewest','bottom','worst'],
      site:     ['site','location','jobsite','workplace','project'],
      holiday:  ['holiday','holidays','off day','public holiday'],
      employee: ['employee','staff','worker','workers','employees','headcount','how many staff','total staff'],
      hours:    ['hours','hrs','hours worked','worked','duration','total hours'],
      days:     ['days','day count','working days','days worked','attendance days'],
      checkin:  ['check in','check-in','checkin','clock in','arrival','in time','entry time'],
      checkout: ['check out','check-out','checkout','clock out','exit time','out time','left','departure'],
      advance:  ['advance','loan','borrowing','deduction'],
      summary:  ['summary','overview','stats','statistics','snapshot','digest'],
      salary:   ['salary','sal','earnings','income'],
    };

    const E  = findEmployeeByName(cleanQuery);
    const D  = parseDateFromQuery(cleanQuery);
    const M  = parseMonthFromQuery(cleanQuery);

    // ─── ROUTING ────────────────────────────────────────────────────────────

    // A1: [Name] check-in time
    if (E && hasFuzzyKeyword(cleanQuery, KW.checkin) && !hasFuzzyKeyword(cleanQuery, KW.checkout)) {
      const ds = D || todayStr;
      steps = [`Looking up ${E.name}'s attendance for ${ds}...`, 'Fetching check-in record...', 'Done!'];
      const rec = (database.getAttendanceForDate(ds)||[]).find(l => l.employeeId === E.id);
      if (!rec || !rec.checkIn) {
        responseText = `**${E.name}** has no check-in recorded for **${ds}**.`;
      } else {
        responseText = `**${E.name}** checked in at **${fmtTime(rec.checkIn)}** on **${ds}**.\nStatus: ${rec.status||'—'}`;
        if (rec.punches && rec.punches.length) {
          responseText += `\n\n📋 **All punches:** ${rec.punches.map(p=>`${p.type==='in'?'▶ IN':'◀ OUT'} ${fmtTime(p.time)}`).join(' | ')}`;
        }
      }
    }

    // A2: [Name] check-out time
    else if (E && hasFuzzyKeyword(cleanQuery, KW.checkout) && !hasFuzzyKeyword(cleanQuery, KW.checkin)) {
      const ds = D || todayStr;
      steps = [`Looking up ${E.name}'s check-out for ${ds}...`, 'Done!'];
      const rec = (database.getAttendanceForDate(ds)||[]).find(l => l.employeeId === E.id);
      if (!rec || !rec.checkOut) {
        responseText = `**${E.name}** has no check-out recorded for **${ds}**.`;
      } else {
        responseText = `**${E.name}** checked out at **${fmtTime(rec.checkOut)}** on **${ds}**.\nStatus: ${rec.status||'—'} | Hours: **${Number(rec.duration||0).toFixed(2)} hrs**`;
        if (rec.punches && rec.punches.length) {
          responseText += `\n\n📋 **All punches:** ${rec.punches.map(p=>`${p.type==='in'?'▶ IN':'◀ OUT'} ${fmtTime(p.time)}`).join(' | ')}`;
        }
      }
    }

    // A3: [Name] punches
    else if (E && hasFuzzyKeyword(cleanQuery, KW.punch)) {
      const ds = D || todayStr;
      steps = [`Fetching punch log for ${E.name} on ${ds}...`, 'Compiling timeline...', 'Done!'];
      const rec = (database.getAttendanceForDate(ds)||[]).find(l => l.employeeId === E.id);
      if (!rec) {
        responseText = `No attendance record for **${E.name}** on **${ds}**.`;
      } else if (!rec.punches || !rec.punches.length) {
        responseText = `**${E.name}** has no punches on **${ds}**.`;
      } else {
        const list = rec.punches.map((p,i)=>`${i+1}. ${p.type==='in'?'▶ **IN**':'◀ **OUT**'} at **${fmtTime(p.time)}**${p.source?' *('+p.source+')*':''}`).join('\n');
        responseText = `📋 **Punch log — ${E.name} on ${ds}:**\n\n${list}\n\nIn: **${fmtTime(rec.checkIn)}** | Out: **${fmtTime(rec.checkOut)}** | Status: **${rec.status||'—'}** | Hours: **${Number(rec.duration||0).toFixed(2)} hrs**`;
      }
    }

    // A4: [Name] hours worked
    else if (E && hasFuzzyKeyword(cleanQuery, KW.hours)) {
      if (D) {
        steps = [`Calculating hours for ${E.name} on ${D}...`, 'Done!'];
        const rec = (database.getAttendanceForDate(D)||[]).find(l=>l.employeeId===E.id);
        responseText = rec
          ? `**${E.name}** worked **${Number(rec.duration||0).toFixed(2)} hrs** on **${D}**.\nStatus: ${rec.status||'—'} | Wage: ${fmtRupee(rec.calculatedWage)}`
          : `No record for **${E.name}** on **${D}**.`;
      } else {
        steps = [`Fetching monthly hours for ${E.name} in ${M}...`, 'Aggregating...', 'Done!'];
        const logs = allAttendance.filter(l=>l.employeeId===E.id && l.date && l.date.startsWith(M));
        const hrs = logs.reduce((s,l)=>s+Number(l.duration||0),0);
        const days = logs.filter(l=>isPresent(l.status)).length;
        responseText = `**${E.name}** worked **${hrs.toFixed(2)} hours** over **${days} days** in **${monthLabel(M)}**.`;
      }
    }

    // A5: [Name] days attended
    else if (E && hasFuzzyKeyword(cleanQuery, KW.days)) {
      steps = [`Counting attendance days for ${E.name} in ${M}...`, 'Done!'];
      const logs = allAttendance.filter(l=>l.employeeId===E.id && l.date && l.date.startsWith(M));
      const p = logs.filter(l=>isPresent(l.status)).length;
      const lv = logs.filter(l=>isLeave(l.status)).length;
      const ab = logs.filter(l=>isAbsent(l.status)).length;
      responseText = `**${E.name}** in **${monthLabel(M)}**:\n\n• ✅ Present: **${p} days**\n• 🏖 Leave: **${lv} days**\n• ❌ Absent: **${ab} days**`;
    }

    // A6: [Name] salary/payroll
    else if (E && hasFuzzyKeyword(cleanQuery, [...KW.payroll,...KW.salary])) {
      steps = [`Fetching payroll for ${E.name} in ${M}...`, 'Calculating net pay...', 'Done!'];
      const sheet = database.getMonthlySalarySheet(M);
      const row = sheet && sheet.find(r=>r.employeeId===E.id);
      if (!row) {
        responseText = `No payroll record for **${E.name}** in **${monthLabel(M)}**.`;
      } else {
        responseText = `💰 **Payroll — ${E.name} (${monthLabel(M)}):**\n\n• Days Worked: **${row.daysWorked||0}**\n• Gross Wages: **${fmtRupee(row.earnedSalary)}**\n• Salary Advance: **${fmtRupee(row.salaryAdvance)}**\n• **Net Payable: ${fmtRupee(row.netSalary)}**\n• OT Hours: **${Number(row.otHours||0).toFixed(2)} hrs**\n• Daily Rate: **${fmtRupee(E.dailyRate)}**`;
      }
    }

    // A7: [Name] status today/on date
    else if (E && hasFuzzyKeyword(cleanQuery, [...KW.present,'status','today','attendance'])) {
      const ds = D || todayStr;
      steps = [`Checking status for ${E.name} on ${ds}...`, 'Done!'];
      const rec = (database.getAttendanceForDate(ds)||[]).find(l=>l.employeeId===E.id);
      if (!rec) {
        responseText = `No record for **${E.name}** on **${ds}**.`;
      } else {
        const emoji = isPresent(rec.status)?'✅':isLeave(rec.status)?'🏖':'❌';
        responseText = `${emoji} **${E.name}** on **${ds}**: **${rec.status||'Unknown'}**\n\nCheck-in: **${fmtTime(rec.checkIn)}** | Check-out: **${fmtTime(rec.checkOut)}** | Hours: **${Number(rec.duration||0).toFixed(2)} hrs**`;
      }
    }

    // A8: [Name] advance/loan
    else if (E && hasFuzzyKeyword(cleanQuery, KW.advance)) {
      steps = [`Looking up advance for ${E.name} in ${M}...`, 'Done!'];
      const adjs = database.getPayrollAdjustments(M);
      const adj = adjs && adjs.find(a=>a.employeeId===E.id);
      if (!adj || !adj.salaryAdvance) {
        responseText = `**${E.name}** has no salary advance for **${monthLabel(M)}**.`;
      } else {
        responseText = `**${E.name}** — Advance for **${monthLabel(M)}**: **${fmtRupee(adj.salaryAdvance)}**\nNotes: ${adj.notes||'—'}`;
      }
    }

    // B1: Who present on [date]?
    else if (D && hasFuzzyKeyword(cleanQuery, KW.present) && !hasFuzzyKeyword(cleanQuery, KW.absent)) {
      steps = [`Fetching attendance for ${D}...`, 'Filtering present staff...', 'Done!'];
      const logs = (database.getAttendanceForDate(D)||[]).filter(l=>isPresent(l.status));
      responseText = logs.length
        ? `**${logs.length} present on ${D}:**\n\n` + logs.map((l,i)=>`${i+1}. **${l.employeeName}** — ${l.status} (In: ${fmtTime(l.checkIn)} | Out: ${fmtTime(l.checkOut)} | ${Number(l.duration||0).toFixed(1)} hrs)`).join('\n')
        : `No staff marked present on **${D}**.`;
    }

    // B2: Who absent on [date]?
    else if (D && hasFuzzyKeyword(cleanQuery, KW.absent)) {
      steps = [`Fetching attendance for ${D}...`, 'Finding absent employees...', 'Done!'];
      const logs = (database.getAttendanceForDate(D)||[]).filter(l=>isAbsent(l.status));
      responseText = logs.length
        ? `**${logs.length} absent on ${D}:**\n\n` + logs.map((l,i)=>`${i+1}. **${l.employeeName}**`).join('\n')
        : `No staff absent on **${D}**.`;
    }

    // B3: Who late on [date]?
    else if (D && hasFuzzyKeyword(cleanQuery, KW.late)) {
      steps = [`Fetching late arrivals for ${D}...`, 'Done!'];
      const logs = (database.getAttendanceForDate(D)||[]).filter(l=>isLate(l.status)||isEarlyOut(l.status));
      responseText = logs.length
        ? `⏰ **${logs.length} late on ${D}:**\n\n` + logs.map((l,i)=>`${i+1}. **${l.employeeName}** — ${l.status} (In: ${fmtTime(l.checkIn)})`).join('\n')
        : `No late arrivals on **${D}**.`;
    }

    // C1: Late arrivals this month (no specific person)
    else if (hasFuzzyKeyword(cleanQuery, KW.late) && !E) {
      steps = [`Scanning ${monthLabel(M)} for late arrivals...`, 'Compiling list...', 'Done!'];
      const lateCount = {};
      allAttendance.filter(l=>l.date&&l.date.startsWith(M)&&isLate(l.status)).forEach(l=>{
        lateCount[l.employeeName] = (lateCount[l.employeeName]||0)+1;
      });
      const sorted = Object.entries(lateCount).sort((a,b)=>b[1]-a[1]);
      responseText = sorted.length
        ? `⏰ **Late arrivals in ${monthLabel(M)}:**\n\n` + sorted.map(([n,c],i)=>`${i+1}. **${n}** — ${c} time(s)`).join('\n')
        : `No late arrivals in **${monthLabel(M)}**. 🎉`;
    }

    // C2: Overtime rankings
    else if (hasFuzzyKeyword(cleanQuery, KW.overtime)) {
      steps = [`Analyzing OT for ${monthLabel(M)}...`, 'Ranking employees...', 'Done!'];
      const otMap = {};
      allAttendance.filter(l=>l.date&&l.date.startsWith(M)).forEach(l=>{
        otMap[l.employeeName] = (otMap[l.employeeName]||0) + Number(l.otHours||0);
      });
      const sorted = Object.entries(otMap).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
      responseText = sorted.length
        ? `🏆 **OT Rankings — ${monthLabel(M)}:**\n\n` + sorted.slice(0,10).map(([n,h],i)=>`${i+1}. **${n}** — ${h.toFixed(2)} OT hrs`).join('\n')
        : `No overtime records in **${monthLabel(M)}**.`;
    }

    // C3: Top workers / most hours
    else if (hasFuzzyKeyword(cleanQuery, [...KW.top,...KW.hours]) && !E) {
      steps = [`Analyzing hours in ${monthLabel(M)}...`, 'Ranking employees...', 'Done!'];
      const hMap = {};
      allAttendance.filter(l=>l.date&&l.date.startsWith(M)).forEach(l=>{
        hMap[l.employeeName] = (hMap[l.employeeName]||0) + Number(l.duration||0);
      });
      const sorted = Object.entries(hMap).sort((a,b)=>b[1]-a[1]);
      responseText = sorted.length
        ? `🏆 **Top by hours worked — ${monthLabel(M)}:**\n\n` + sorted.slice(0,10).map(([n,h],i)=>`${i+1}. **${n}** — ${h.toFixed(2)} hrs`).join('\n')
        : `No attendance data for **${monthLabel(M)}**.`;
    }

    // C4: Most absent employees
    else if (hasFuzzyKeyword(cleanQuery, KW.bottom) || (hasFuzzyKeyword(cleanQuery, KW.absent) && hasFuzzyKeyword(cleanQuery, [...KW.days,'most','rank']))) {
      steps = [`Counting absences in ${monthLabel(M)}...`, 'Done!'];
      const absMap = {};
      activeEmployees.forEach(e=>absMap[e.name]=0);
      allAttendance.filter(l=>l.date&&l.date.startsWith(M)&&isAbsent(l.status)).forEach(l=>{
        if (l.employeeName) absMap[l.employeeName]=(absMap[l.employeeName]||0)+1;
      });
      const sorted = Object.entries(absMap).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
      responseText = sorted.length
        ? `📋 **Most absent — ${monthLabel(M)}:**\n\n` + sorted.slice(0,10).map(([n,d],i)=>`${i+1}. **${n}** — ${d} day(s)`).join('\n')
        : `No absences in **${monthLabel(M)}**! 🎉`;
    }

    // C5: Monthly payroll summary
    else if (hasFuzzyKeyword(cleanQuery, KW.payroll) && !E) {
      steps = [`Fetching payroll for ${monthLabel(M)}...`, 'Calculating totals...', 'Done!'];
      const sheet = database.getMonthlySalarySheet(M);
      let tGross=0, tAdv=0, tNet=0, tDays=0;
      if (Array.isArray(sheet)) sheet.forEach(r=>{
        tGross+=Number(r.earnedSalary)||0; tAdv+=Number(r.salaryAdvance)||0;
        tNet+=Number(r.netSalary)||0; tDays+=Number(r.daysWorked)||0;
      });
      responseText = `💰 **Payroll Summary — ${monthLabel(M)}:**\n\n• Employees: **${Array.isArray(sheet)?sheet.length:0}**\n• Total Days: **${tDays}**\n• Gross Wages: **${fmtRupee(tGross)}**\n• Advances: **${fmtRupee(tAdv)}**\n• **Net Payable: ${fmtRupee(tNet)}**` + excelSuffix;
    }

    // D1: Present today
    else if (hasFuzzyKeyword(cleanQuery, KW.present) && !hasFuzzyKeyword(cleanQuery, KW.absent) && !D) {
      steps = ["Checking today's attendance...", "Listing present staff...", "Done!"];
      const present = dailyLogs.filter(l=>isPresent(l.status));
      responseText = present.length
        ? `**${present.length} present today (${todayStr}):**\n\n` + present.map((l,i)=>`${i+1}. **${l.employeeName}** — ${l.status} (In: ${fmtTime(l.checkIn)} | ${Number(l.duration||0).toFixed(1)} hrs)`).join('\n') + excelSuffix
        : `No staff marked present today yet.` + excelSuffix;
    }

    // D2: Absent today
    else if (hasFuzzyKeyword(cleanQuery, KW.absent) && !D) {
      steps = ["Checking today's attendance...", "Finding absentees...", "Done!"];
      const absent = dailyLogs.filter(l=>isAbsent(l.status));
      responseText = absent.length
        ? `**${absent.length} absent today (${todayStr}):**\n\n` + absent.map((l,i)=>`${i+1}. **${l.employeeName}**`).join('\n') + excelSuffix
        : `Everyone showed up today! 🎉` + excelSuffix;
    }

    // D3: On leave today
    else if (hasFuzzyKeyword(cleanQuery, KW.leave) && !D && !hasFuzzyKeyword(cleanQuery, KW.holiday)) {
      steps = ["Checking today's leave records...", "Done!"];
      const onLeave = dailyLogs.filter(l=>isLeave(l.status));
      responseText = onLeave.length
        ? `**${onLeave.length} on leave today:**\n\n` + onLeave.map((l,i)=>`${i+1}. **${l.employeeName}**`).join('\n')
        : `No staff on leave today.`;
    }

    // D4: Late today (no date specified)
    else if (hasFuzzyKeyword(cleanQuery, KW.late) && !D) {
      steps = ["Checking late arrivals today...", "Done!"];
      const late = dailyLogs.filter(l=>isLate(l.status)||isEarlyOut(l.status));
      responseText = late.length
        ? `⏰ **${late.length} late today:**\n\n` + late.map((l,i)=>`${i+1}. **${l.employeeName}** — ${l.status} (In: ${fmtTime(l.checkIn)})`).join('\n')
        : `No late arrivals today. 👍`;
    }

    // D5: Check-in/out times today all
    else if (hasFuzzyKeyword(cleanQuery, [...KW.checkin,...KW.checkout,...KW.punch]) && !E) {
      steps = ["Fetching today's punch records...", "Compiling times...", "Done!"];
      const checked = dailyLogs.filter(l=>isPresent(l.status)&&l.checkIn);
      responseText = checked.length
        ? `📋 **Check-in/out times today (${todayStr}):**\n\n` + checked.map((l,i)=>`${i+1}. **${l.employeeName}** — In: **${fmtTime(l.checkIn)}** | Out: **${fmtTime(l.checkOut)}** | ${Number(l.duration||0).toFixed(1)} hrs`).join('\n')
        : `No check-in records found today yet.`;
    }

    // E1: Employee count
    else if (hasFuzzyKeyword(cleanQuery, KW.employee)) {
      steps = ["Fetching employee directory...", "Done!"];
      const office = activeEmployees.filter(e=>e.modeOfWork&&e.modeOfWork.toLowerCase().includes('office'));
      const daily  = activeEmployees.filter(e=>!e.modeOfWork||!e.modeOfWork.toLowerCase().includes('office'));
      const bySite = {};
      activeEmployees.forEach(e=>{ const s=e.site||e.siteName||'Unassigned'; bySite[s]=(bySite[s]||0)+1; });
      responseText = `👥 **Employee Summary:**\n\n• **Total Active: ${activeEmployees.length}**\n• Office Staff: ${office.length}\n• Daily Wage Workers: ${daily.length}\n\n**By Site:**\n` +
        Object.entries(bySite).map(([s,c])=>`• ${s}: ${c}`).join('\n');
    }

    // E2: List all employees
    else if ((cleanQuery.includes('list')||cleanQuery.includes('all')) && hasFuzzyKeyword(cleanQuery, ['employee','staff','worker','workers'])) {
      steps = ["Fetching employee list...", "Done!"];
      responseText = `📋 **All Active Employees (${activeEmployees.length}):**\n\n` +
        activeEmployees.map((e,i)=>`${i+1}. **${e.name}** — ${e.modeOfWork||'Daily Wage'} | Rate: ${fmtRupee(e.dailyRate)}/day`).join('\n');
    }

    // F: Site queries
    else if (hasFuzzyKeyword(cleanQuery, KW.site)) {
      steps = ["Fetching site information...", "Done!"];
      if (!sites.length) {
        responseText = `No sites configured yet.`;
      } else {
        responseText = `🏗 **Sites (${sites.length} total):**\n\n` +
          sites.map((s,i)=>{
            const cnt = activeEmployees.filter(e=>(e.site||e.siteName||'').toLowerCase()===s.name.toLowerCase()).length;
            return `${i+1}. **${s.name}** — ${cnt} employee(s)`;
          }).join('\n');
      }
    }

    // G: Holiday queries
    else if (hasFuzzyKeyword(cleanQuery, KW.holiday)) {
      steps = ["Fetching holiday calendar...", "Done!"];
      const upcoming = holidays.filter(h=>h.date>=todayStr).slice(0,10);
      const thisMonth = holidays.filter(h=>h.date&&h.date.startsWith(M));
      responseText = holidays.length
        ? `🗓 **Holiday Calendar:**\n\n**Upcoming:**\n` +
          (upcoming.length ? upcoming.map((h,i)=>`${i+1}. **${h.date}** — ${h.name||'Holiday'}`).join('\n') : 'None upcoming.') +
          `\n\n**${monthLabel(M)}: ${thisMonth.length} holiday(s)**`
        : `No holidays configured.`;
    }

    // H: CCTV queries
    else if (hasFuzzyKeyword(cleanQuery, KW.cctv)) {
      steps = ["Querying CCTV streams...", "Checking camera status...", "Done!"];
      if (!cameras.length) {
        responseText = `No CCTV cameras configured.`;
      } else {
        const active = cameras.filter(c=>c.status!=='inactive').length;
        responseText = `📹 **CCTV Status:**\n\n**${active} active camera(s)** out of ${cameras.length}:\n\n` +
          cameras.map((c,i)=>`${i+1}. **${c.name}** — ${c.eventType?c.eventType.toUpperCase():'?'} | ${c.status||'Active'} | ${c.source||'—'}`).join('\n');
      }
    }

    // I: Daily/Monthly summary
    else if (hasFuzzyKeyword(cleanQuery, KW.summary)||cleanQuery==='summary'||cleanQuery==='report'||cleanQuery==='stats') {
      const ds = D || todayStr;
      steps = [`Generating summary for ${ds}...`, "Computing all stats...", "Done!"];
      const logs = database.getAttendanceForDate(ds)||[];
      const pres = logs.filter(l=>isPresent(l.status)).length;
      const abs  = logs.filter(l=>isAbsent(l.status)).length;
      const lv   = logs.filter(l=>isLeave(l.status)).length;
      const late = logs.filter(l=>isLate(l.status)).length;
      const ear  = logs.filter(l=>isEarlyOut(l.status)).length;
      const wage = logs.filter(l=>isPresent(l.status)).reduce((s,l)=>s+Number(l.calculatedWage||0),0);
      responseText = `📊 **Attendance Summary — ${ds}:**\n\n• ✅ Present: **${pres}**\n• ❌ Absent: **${abs}**\n• 🏖 On Leave: **${lv}**\n• ⏰ Late: **${late}**\n• 🚪 Early Checkout: **${ear}**\n• 💰 Total Wages: **${fmtRupee(wage)}**` + excelSuffix;
    }

    // J: Excel export
    else if (isExcelRequested) {
      steps = ["Generating download links...", "Done!"];
      responseText = `📊 **Download Reports:**\n\n• [Attendance (Excel)](/api/export/excel?startDate=${startOfMonthStr}&endDate=${todayStr})\n• [Payroll (Excel)](/api/export/payroll/excel?startDate=${startOfMonthStr}&endDate=${todayStr})\n• [Welders Report (Excel)](/api/export/welders-weekly/excel?friday=${lastFridayStr})\n\n*(Range: ${startOfMonthStr} to ${todayStr})*`;
    }

    // K: Help
    else if (hasFuzzyKeyword(cleanQuery, KW.help)||cleanQuery.includes('how to')||cleanQuery.includes('features')) {
      steps = ["Loading help guide...", "Done!"];
      responseText = `🤖 **InterExt AI — What I can answer:**\n\n**Today's Status:**\n• Who is present/absent/on leave/late today?\n• Check-in/out times today | Attendance summary\n\n**Specific Employee:**\n• "[Name]'s check-in time" / "[Name]'s punches today"\n• "[Name]'s salary this month" / "[Name]'s hours in June"\n• "How many days did [name] attend?" / "[Name]'s advance"\n\n**Specific Date:**\n• "Who was present on 25th June?"\n• "Absent on 2026-06-10?" / "Late on 15 July?"\n\n**Monthly Analytics:**\n• "Who worked the most hours this month?"\n• "Late arrivals in June" / "Most absent this month"\n• "Overtime rankings" | "Payroll summary for May"\n\n**Other:**\n• "How many employees?" / "List all employees"\n• "Upcoming holidays" / "Site list" / "CCTV status"\n• "Download Excel report"`;
    }

    // Fallback
    else {
      steps = ["Analyzing query...", "Searching all data sources...", "Done!"];
      responseText = `Hello! I'm **InterExt AI** 🤖. I didn't understand that query.\n\nTry asking:\n• 🧑 "Who is present today?" / "Who was absent on 25th June?"\n• ⏰ "Who came late today?" / "Late arrivals in June"\n• 💼 "[Name]'s salary this month" / "Payroll summary"\n• 📋 "Show [name]'s punches today" / "Check-in times"\n• 📊 "Attendance summary" / "Who worked the most hours?"\n• 🗓 "Upcoming holidays?" / "How many employees?"\n• 📥 "Download Excel report"\n\nType **'help'** to see all commands!`;
    }

    res.json({ success: true, steps, response: responseText });
  } catch (err) {
    console.error("[AI Chatbot] Error resolving query:", err);
    res.status(500).json({ error: "Internal server error: " + err.message });
  }
});
