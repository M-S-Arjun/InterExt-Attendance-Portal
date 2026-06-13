const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const targetFriday = '2026-06-12';
  
  const fridayDate = new Date(targetFriday);
  const dayNames = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const datesOfWeek = [];
  for (let i = -6; i <= 0; i++) {
    const d = new Date(fridayDate);
    d.setDate(fridayDate.getDate() + i);
    datesOfWeek.push(d.toISOString().split('T')[0]);
  }
  
  const welders = db.employees.filter(e => e.modeOfWork && e.modeOfWork.toLowerCase().includes('welder'));
  const attendanceLogs = db.attendance || [];
  
  const report = welders.map(welder => {
    const dailyDetails = [];
    let totalHours = 0;
    let totalPresentDays = 0;
    let weeklyRegularWage = 0;
    let weeklyOtPay = 0;
    let weeklyTravelPay = 0;
    
    datesOfWeek.forEach((dateStr, index) => {
      const dayName = dayNames[index];
      const log = attendanceLogs.find(a => a.employeeId === welder.id && a.date === dateStr);
      
      let status = "ABSENT";
      let hours = 0;
      let wage = 0;
      let otHours = 0;
      let travelHours = 0;
      let checkIn = "—";
      let checkOut = "—";
      
      if (log) {
        status = log.status.toUpperCase();
        const isPresent = log.status === 'completed' || log.status === 'checked-in' || log.status === 'late' || log.status === 'Late Check-in' || log.status === 'Early Check-out' || log.status === 'half-day leave';
        
        if (isPresent) {
          totalPresentDays += 1;
          hours = log.status === 'absent' || log.status === 'leave' ? 0.0 : Number((log.duration / 60).toFixed(2));
          totalHours += hours;
          
          const isFriday = (index === 6);
          const actualOtHours = isFriday ? 0.0 : (Number(log.otHours) || 0.0);
          otHours = actualOtHours;
          
          const dailyRate = Number(welder.dailyRate) || 0.0;
          const hourlyRate = Number(welder.hourlyRate) || 0.0;
          
          let F = 8.0;
          let h = 4.0;
          if (welder.shiftStart && welder.shiftEnd) {
            try {
              const [startH, startM] = welder.shiftStart.split(':').map(Number);
              const [endH, endM] = welder.shiftEnd.split(':').map(Number);
              let shiftMinutes = (endH * 60 + endM) - (startH * 60 + startM);
              if (shiftMinutes < 0) shiftMinutes += 24 * 60;
              const shiftHours = shiftMinutes / 60;
              F = shiftHours >= 9.0 ? shiftHours - 1.0 : shiftHours;
              h = F / 2.0;
            } catch(e) {}
          }
          
          let dailyWage = 0.0;
          const forceHalfDay = log.status === 'half-day leave';
          
          if (log.isManualOverride) {
            const manualWage = Number(log.calculatedWage) || 0.0;
            if (isFriday) {
              const manualOt = Number(log.otHours) || 0.0;
              const otPayout = Number((manualOt * (dailyRate / 10.0)).toFixed(2));
              dailyWage = Math.max(0, Number((manualWage - otPayout).toFixed(2)));
            } else {
              dailyWage = manualWage;
              const dailyOtHours = Number(log.otHours) || 0.0;
              weeklyOtPay += Number((dailyOtHours * (dailyRate / 10.0)).toFixed(2));
            }
          } else {
            if (hours >= F && !forceHalfDay) {
              dailyWage = dailyRate;
              if (!isFriday) {
                const dayOtPay = Number((otHours * (dailyRate / 10.0)).toFixed(2));
                weeklyOtPay += dayOtPay;
                dailyWage += dayOtPay;
              }
            } else if (hours >= h || forceHalfDay) {
              const extraH = Math.max(0.0, Number((hours - h).toFixed(2)));
              dailyWage = Number(((dailyRate * 0.5) + (extraH * hourlyRate)).toFixed(2));
            } else {
              dailyWage = Number((hours * hourlyRate).toFixed(2));
            }
          }
          
          wage = dailyWage;
          travelHours = Number(log.travelHours) || 0.0;
          weeklyTravelPay += Number((travelHours * hourlyRate).toFixed(2));
          
          checkIn = log.checkIn ? new Date(log.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : "—";
          checkOut = log.checkOut ? new Date(log.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : (log.status === 'checked-in' ? "Checked-In" : "—");
        }
      }
      
      dailyDetails.push({
        date: dateStr,
        dayName,
        status,
        hours,
        otHours,
        wage,
        travelHours,
        checkIn,
        checkOut
      });
    });
    
    const totalWage = dailyDetails.reduce((sum, d) => sum + d.wage, 0);
    const totalWeeklyEarnings = Number((totalWage + weeklyTravelPay).toFixed(2));
    
    return {
      welderId: welder.userId,
      welderName: welder.name,
      dailyRate: welder.dailyRate,
      totalHours: Number(totalHours.toFixed(2)),
      totalPresentDays,
      weeklyRegularWage: Number((totalWage - weeklyOtPay).toFixed(2)),
      weeklyOtPay: Number(weeklyOtPay.toFixed(2)),
      weeklyTravelPay: Number(weeklyTravelPay.toFixed(2)),
      totalWeeklyEarnings
    };
  });
  
  console.log("Calculated weekly report:");
  report.forEach(w => {
    if (w.totalPresentDays > 0) {
      console.log(`${w.welderId} | ${w.welderName} | Rate: ${w.dailyRate} | Pres: ${w.totalPresentDays} | RegWage: ${w.weeklyRegularWage} | OT: ${w.weeklyOtPay} | Travel: ${w.weeklyTravelPay} | Earnings: ${w.totalWeeklyEarnings}`);
    }
  });
} else {
  console.log("data.json not found");
}
