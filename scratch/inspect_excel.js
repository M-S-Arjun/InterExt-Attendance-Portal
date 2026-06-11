const XLSX = require('xlsx');
const path = require('path');

const EXCEL_PATH = path.join(__dirname, '..', 'Attendance_Payroll.xlsx');
try {
  const workbook = XLSX.readFile(EXCEL_PATH);
  console.log("Sheet Names:", workbook.SheetNames);
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref'] || "A1:A1");
    console.log(`Sheet: ${sheetName}, Range: ${sheet['!ref']}`);
    // Print first 2 rows of the sheet
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    console.log("Rows count:", rows.length);
    console.log("Row 1:", rows[0]);
    console.log("Row 2:", rows[1]);
    console.log("Row 3:", rows[2]);
  });
} catch (err) {
  console.error("Error reading Excel:", err);
}
