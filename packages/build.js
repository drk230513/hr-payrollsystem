const fs = require("fs");
const path = require("path");
// Read inputs beside this file and write the bundle to the project root, so the
// build works the same from the development tree and from a release archive.
process.chdir(__dirname);
const OUT = path.join(__dirname, "..", "hr-payroll-system.html");
const engine = fs.readFileSync("engine.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
const autom  = fs.readFileSync("automation.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
const jrnl   = fs.readFileSync("journal.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
/* Some libraries guard their export with `if(typeof module`, others assign
   `module.exports` directly. Strip either form, and fail loudly if neither
   matched — a silent miss leaves `module is not defined` at page load. */
function stripExports(file){
  const src = fs.readFileSync(file, "utf8");
  const out = src.replace(/if\(typeof module[\s\S]*$/, "")
                 .replace(/module\.exports\s*=\s*\{[\s\S]*$/, "");
  if(out.length === src.length){
    throw new Error("no export block found in " + file + " — the bundle would not run");
  }
  return out;
}
const absn   = stripExports("absence.js");
const lve    = stripExports("leave.js");
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
      <button class="tab" data-view="group">Group</button>
      <button class="tab" data-view="payroll">Payroll</button>
      <button class="tab" data-view="leave">Leave</button>
      <button class="tab" data-view="absence">Absence</button>
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

/* absence.js and leave.js both define serviceMonthsAt and entitlementFor.
   In one shared scope the second would silently overwrite the first, and the
   bug would surface as leave entitlement being calculated by the absence
   rules. Each gets its own namespace instead. */
var ABSENCE = (function(){
${absn}
  return { makeScheme, EXAMPLE_SCHEMES, serviceMonthsAt, bandFor, windowFor,
    consumedInWindow, entitlementFor, assessAbsence, projectExhaustion,
    countWorkingDays, dailyRateFor, bradfordFactor, absenceExceptions };
})();

var LEAVE = (function(){
${lve}
  return { makeLeaveScheme, EXAMPLE_SCHEMES, statutoryMinimumDays, hoursPerDay,
    serviceMonthsAt, partYearFraction, entitlementFor, carryOverFor, balanceFor,
    allBalancesFor, validateRequest, leaveExceptions, teamClashes,
    STATUTORY_WEEKS, STATUTORY_DAY_CAP, IRREGULAR_ACCRUAL_RATE };
})();
${app}
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log("built:", (html.length/1024).toFixed(1) + " KB");
