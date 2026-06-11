const fs = require('fs');
const path = require('path');

const userList = [
  { mode: "Daily Wages Staff", userId: "2014", name: "NIJI MANOJ", monthly: 15000, daily: 576.92, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "17:00" },
  { mode: "Daily Wages Staff", userId: "2015", name: "REKHA MADHU", monthly: 15000, daily: 576.92, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "17:00" },
  { mode: "Daily Wages Staff", userId: "2028", name: "RAJI KANNAN", monthly: 15000, daily: 576.92, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "17:00" },
  { mode: "Daily Wages Staff", userId: "2038", name: "James TM", monthly: 25000, daily: 961.54, designation: "Sales Executive", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Daily Wages Staff", userId: "2046", name: "Sunil. C. M", monthly: 26000, daily: 1000, designation: "Office Attandent", payment: "Interext", start: "7:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2048", name: "Ratheesh K S", monthly: 38000, daily: 1461.54, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2090", name: "Binu Ajith", monthly: 16000, daily: 615.38, designation: "Office Attandent", payment: "City Advertisers", start: "7:00", end: "16:00" },
  { mode: "Daily Wages Staff", userId: "2052", name: "Raju Rana", monthly: 23500, daily: 903.85, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2053", name: "Devadas E K", monthly: 33000, daily: 1269.23, designation: "Workshop Assistant", payment: "City Advertisers", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2056", name: "Raj Kumar Rana", monthly: 22100, daily: 850, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2058", name: "Akash", monthly: 30000, daily: 1153.85, designation: "Workshop Assistant", payment: "City Advertisers", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2067", name: "Pappu Kumar Rana", monthly: 27000, daily: 1038.46, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2081", name: "Bimal Rana", monthly: 15000, daily: 576.92, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2083", name: "Ajmal K H", monthly: 26000, daily: 1000, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff - Welder", userId: "2060", name: "Ratheesh P R", monthly: null, daily: 1300, designation: "welder signage", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff - Welder", userId: "2061", name: "Joshy", monthly: null, daily: 1350, designation: "welder signage", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff - Welder", userId: "2066", name: "Arun P madhu", monthly: null, daily: 1300, designation: "welder signage", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Daily Wages Staff", userId: "2049", name: "Rahul R Nair", monthly: 26000, daily: 1000, designation: "Workshop Assistant", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Office Staff", userId: "1002", name: "PRATHEESH K S", monthly: 57000, daily: 1900, designation: "Project Manager", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "1003", name: "AJEESH VIJAYAN", monthly: 32000, daily: 1066.67, designation: "Material Sourcing Manager", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "1004", name: "REBEESH K S", monthly: 38000, daily: 1266.67, designation: "Finance & Accounts Head", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "1009", name: "SHYAM MURALI", monthly: 41000, daily: 1366.67, designation: "Material & Cost Manager", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2001", name: "SHINODH N T", monthly: 50000, daily: 1666.67, designation: "Poject Manager", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2006", name: "AKHIL P KUMAR", monthly: 36000, daily: 1200, designation: "Senior Graphic Designer", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2008", name: "SHAHANA JABBAR", monthly: 30000, daily: 1000, designation: "Senior Graphic Designer", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2010", name: "BINDHU JOSE", monthly: 21000, daily: 700, designation: "Accountant", payment: "City Advertisers", start: "9:00", end: "17:00" },
  { mode: "Office Staff", userId: "2025", name: "PRASANTH E.M", monthly: 31000, daily: 1033.33, designation: "Site Supervisor", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2027", name: "GEORGE THOMAS", monthly: 39000, daily: 1300, designation: "Senior Interior & Exterior Designer", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2029", name: "ANADHU SUNIL", monthly: 25000, daily: 833.33, designation: "Junior Machine Operator", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Office Staff", userId: "2032", name: "GOKUL K", monthly: 27000, daily: 900, designation: "Interior& Exterior Designer", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2033", name: "NOURIN SHAJI", monthly: 20000, daily: 666.67, designation: "Interior& Exterior Designer", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2036", name: "Sineesh Sasi", monthly: 29000, daily: 966.67, designation: "Interior& Exterior Designer", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2037", name: "Manu Mahesh", monthly: 40000, daily: 1333.33, designation: "Sales Lead", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2039", name: "Ajith Reghunath", monthly: 18000, daily: 600, designation: "Graphic Designer", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2041", name: "Niranjan Bose", monthly: 26000, daily: 866.67, designation: "Graphic Designer", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2042", name: "Sukanto Mishal", monthly: 40000, daily: 1333.33, designation: "CNC Machine Operator", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Office Staff", userId: "2044", name: "RAHUL SUNDARAN", monthly: 35000, daily: 1166.67, designation: "Lead Data Coordinator", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2045", name: "Stephin Pious", monthly: 25000, daily: 833.33, designation: "Driver", payment: "Interext", start: "8:30", end: "19:00" },
  { mode: "Office Staff", userId: "2051", name: "Siju Thomas", monthly: 26000, daily: 866.67, designation: "Site Supervisor", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2054", name: "Mahin KJ", monthly: 27000, daily: 900, designation: "Driver", payment: "Interext", start: "8:30", end: "19:00" },
  { mode: "Office Staff", userId: "2064", name: "Sreelakshmi R", monthly: 16000, daily: 533.33, designation: "Admin & Project Coordinator", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2069", name: "Abhishek Shaji", monthly: 14000, daily: 466.67, designation: "Graphic Designer", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2071", name: "Remanan N N", monthly: 60000, daily: 2000, designation: "Supervisor Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2072", name: "Vijesh A V", monthly: 30000, daily: 1000, designation: "Senior Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2075", name: "Rakesh Sadhukha", monthly: 40000, daily: 1333.33, designation: "Senior Machine Operator", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Office Staff", userId: "2076", name: "Sona Francis", monthly: 18000, daily: 600, designation: "Graphic Designer", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2078", name: "Anusree Subramanian", monthly: 15000, daily: 500, designation: "Admin & Project Coordinator", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2080", name: "Alex Rajan", monthly: 20000, daily: 666.67, designation: "Project Manager", payment: "Interext", start: "9:00", end: "19:00" },
  { mode: "Office Staff", userId: "2084", name: "Rahul Das", monthly: 22000, daily: 733.33, designation: "Driver", payment: "Interext", start: "8:30", end: "19:00" },
  { mode: "Office Staff", userId: "2085", name: "Anish Viswanathan", monthly: 22000, daily: 733.33, designation: "Driver", payment: "Interext", start: "8:30", end: "19:00" },
  { mode: "Office Staff", userId: "2086", name: "Gokul Krishnan  E V", monthly: 15000, daily: 500, designation: "Site Supervisor", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2087", name: "MS Arjun", monthly: 25000, daily: 833.33, designation: "Software Developer", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2088", name: "Ramsy Rasheed", monthly: 25000, daily: 833.33, designation: "Accountant", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Office Staff", userId: "2089", name: "Abin Mathew", monthly: 22000, daily: 733.33, designation: "Driver", payment: "Interext", start: "8:30", end: "19:00" },
  { mode: "Office Staff", userId: "2092", name: "Neethu Vijayan", monthly: null, daily: 0, designation: "Admin & Project Coordinator", payment: "City Advertisers", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN048", name: "Aneesh Ahammed", monthly: null, daily: 1100, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN049", name: "Faiyaj Ansari", monthly: null, daily: 900, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN053", name: "Sunil Aliyar", monthly: null, daily: 1350, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN054", name: "Sreeraj V S", monthly: null, daily: 1050, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN055", name: "Mohammed Gulfam", monthly: null, daily: 1200, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN056", name: "Sumesh B", monthly: null, daily: 1300, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN058", name: "Tufail Alam Danish", monthly: null, daily: 900, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN060", name: "Sandeep C", monthly: null, daily: 1200, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN061", name: "Arun George", monthly: null, daily: 1200, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN063", name: "Akhil AK", monthly: null, daily: 1300, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN064", name: "Anandhu Raj", monthly: null, daily: 1050, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN065", name: "Anoop (Ancil K Grace)", monthly: null, daily: 1350, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN066", name: "Gopal (soma)", monthly: null, daily: 1050, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN067", name: "Sabu (Joseph Antony)", monthly: null, daily: 1300, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN069", name: "Subodh Sha", monthly: null, daily: 1000, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN071", name: "Anil Rana", monthly: null, daily: 1050, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  // Note: we can treat Sunil Rana as IN072 in the lookup to see if he's matched correctly!
  { mode: "Welders", userId: "IN072", name: "Sunil Rana", monthly: null, daily: 1200, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN073", name: "Samshad Aalam", monthly: null, daily: 900, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN074", name: "Aamil", monthly: null, daily: 1200, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" },
  { mode: "Welders", userId: "IN075", name: "Sanjaya behara", monthly: null, daily: 1200, designation: "Welder", payment: "Interext", start: "9:00", end: "18:00" }
];

function cleanName(n) {
  return n.toLowerCase().replace(/[^a-z]/g, '');
}

const DB_PATH = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(DB_PATH)) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  
  userList.forEach(user => {
    // Try to find employee in DB by userId or matching name
    let emp = db.employees.find(e => e.userId === user.userId);
    if (!emp) {
      // Try by cleaned name
      emp = db.employees.find(e => cleanName(e.name) === cleanName(user.name));
    }
    
    if (!emp) {
      console.log(`MISSING EMPLOYEE in DB: ID ${user.userId} | ${user.name}`);
    } else {
      // Check details
      const formatTime = (t) => {
        if (!t) return "";
        const parts = t.split(':');
        return parts.map(p => p.padStart(2, '0')).join(':');
      };
      
      const uStart = formatTime(user.start);
      const uEnd = formatTime(user.end);
      const dbStart = formatTime(emp.shiftStart);
      const dbEnd = formatTime(emp.shiftEnd);
      
      const shiftDiff = uStart !== dbStart || uEnd !== dbEnd;
      const rateDiff = Math.abs(emp.dailyRate - user.daily) > 0.05 || (user.monthly && Math.abs(emp.monthlyWage - user.monthly) > 0.05);
      
      if (shiftDiff || rateDiff) {
        console.log(`DIFF found for ID ${user.userId} (${user.name}):`);
        if (shiftDiff) {
          console.log(`  Shift: Expected ${uStart}-${uEnd}, Got ${dbStart}-${dbEnd}`);
        }
        if (rateDiff) {
          console.log(`  Rate: Expected Daily ${user.daily} Monthly ${user.monthly}, Got Daily ${emp.dailyRate} Monthly ${emp.monthlyWage}`);
        }
      }
    }
  });
  console.log("Check complete.");
} else {
  console.log("data.json not found");
}
