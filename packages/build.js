const fs = require("fs");
const engine = fs.readFileSync("engine.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
const autom  = fs.readFileSync("automation.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
const jrnl   = fs.readFileSync("journal.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
const app    = fs.readFileSync("app.js","utf8");
const css    = fs.readFileSync("app.css","utf8");

const engineExports = `
var ENGINE = { DEFAULT_CONFIG, PAY_FREQUENCIES, PENSION_BASES, PENSION_METHODS,
  parseTaxCode, calcPAYE, calcNI, calcStudentLoan, calcPension, pensionableEarnings,
  calcSSP, calcSMP, calcPayslip, applyEmployerReliefs, detectExceptions,
  workingDaysBetween, leaveHours, leaveBalance, statutoryMinimumDays,
  BANK_HOLIDAYS, ageAt, p2, periodsPerYear };
`;

const html = `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HR &amp; Payroll</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600;700&display=swap" rel="stylesheet">
<style id="appstyle">
${css}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-in">
    <div class="brand">HR &amp; Payroll</div>
    <div class="tabs">
      <button class="tab on" data-view="dashboard">Overview</button>
      <button class="tab" data-view="employees">People</button>
      <button class="tab" data-view="payroll">Payroll</button>
      <button class="tab" data-view="leave">Leave</button>
      <button class="tab" data-view="payslips">Payslips</button>
      <button class="tab" data-view="pensions">Pensions</button>
      <button class="tab" data-view="automation">Automation</button>
      <button class="tab" data-view="journal">Journal</button>
      <button class="tab" data-view="integrations">Integrations</button>
      <button class="tab" data-view="settings">Settings</button>
    </div>
  </div>
</div>

<div class="wrap"><div id="app"></div></div>

<footer class="sitefoot">
  <div class="sitefoot-in">
    <span class="sf-brand">Powered by <b>Open Source AI Ltd</b></span>
    <span class="sf-note">Demonstration build \u00b7 verify all statutory rates against HMRC before live use</span>
  </div>
</footer>

<div class="scrim" id="scrim">
  <div class="modal">
    <div class="modal-bar">
      <span class="eyebrow" id="modalLabel"></span>
      <div class="modal-acts" id="modalActions"></div>
    </div>
    <div id="modalBody"></div>
  </div>
</div>

<script>
${engine}
${engineExports}
${autom}
${jrnl}
${app}
</script>
</body>
</html>
`;

fs.writeFileSync("hr-payroll-system.html", html);
console.log("built:", (html.length/1024).toFixed(1) + " KB");
