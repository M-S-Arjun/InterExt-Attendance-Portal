const parser = require('../parser');

// Reference date is June 10, 2026 (Wednesday)
// Yesterday: June 9, 2026 (Tuesday)
// Tomorrow: June 11, 2026 (Thursday)
const mockTimestamp = "2026-06-10T12:00:00.000Z"; 

const testCases = [
  {
    name: "1. Text shows present yesterday for specific time period",
    text: "Yesterday Time 9 Am to 8.30",
    phone: "919562012229" // Pratheesh K S
  },
  {
    name: "2. Single employee leave for today and yesterday",
    text: "i am leave for today and yesterday",
    phone: "919562012229" // Pratheesh K S
  },
  {
    name: "3. Malayalam relative leave",
    text: "innale innu leave",
    phone: "917510893422" // M S Arjun
  },
  {
    name: "4. Supervisor list with shared 'yesterday' header",
    text: "Yesterday\nSite: Interext Office\nSunil C M 9 to 6\nStephin Pious 9 to 6",
    phone: "917510893422"
  },
  {
    name: "5. Supervisor list with individual relative dates",
    text: "Site: Interext Office\nSunil C M 9 to 6 yesterday\nStephin Pious 9 to 6 today",
    phone: "917510893422"
  },
  {
    name: "6. Malayalam tomorrow leave",
    text: "nale leave aanu",
    phone: "919562012229"
  }
];

console.log("==========================================");
console.log("=== RUNNING SEMANTIC PARSER TEST CASES ===");
console.log(`Reference Date (Today): 2026-06-10`);
console.log("==========================================\n");

testCases.forEach((tc, index) => {
  console.log(`------------------------------------------`);
  console.log(`TEST CASE ${index + 1}: ${tc.name}`);
  console.log(`Input Message:\n"""\n${tc.text}\n"""`);
  console.log(`Sender Phone: ${tc.phone}`);
  
  try {
    const result = parser.parse(tc.text, tc.phone, mockTimestamp);
    console.log(`Parsed Output:`);
    if (result.isList) {
      console.log(`- Type: List (Multi-record, ${result.items.length} items)`);
      result.items.forEach((item, itemIdx) => {
        console.log(`  [Record ${itemIdx + 1}]`);
        console.log(`    Date: ${item.checkInTime ? item.checkInTime.split('T')[0] : (item.leaveDate || "unknown")}`);
        console.log(`    Employee ID: ${item.matchedEmployeeId}`);
        console.log(`    Action: ${item.extractedAction}`);
        console.log(`    Check-in: ${item.checkInTime}`);
        console.log(`    Check-out: ${item.checkOutTime}`);
        console.log(`    Leave Date: ${item.leaveDate}`);
      });
    } else {
      console.log(`- Type: Single`);
      console.log(`    Date: ${result.checkInTime ? result.checkInTime.split('T')[0] : (result.leaveDate || "unknown")}`);
      console.log(`    Employee ID: ${result.matchedEmployeeId}`);
      console.log(`    Action: ${result.extractedAction}`);
      console.log(`    Check-in: ${result.checkInTime}`);
      console.log(`    Check-out: ${result.checkOutTime}`);
      console.log(`    Leave Date: ${result.leaveDate}`);
    }
  } catch (err) {
    console.error("Test execution failed:", err);
  }
  console.log(`------------------------------------------\n`);
});
