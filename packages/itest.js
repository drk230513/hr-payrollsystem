const { JSDOM } = require("jsdom");
const fs = require("fs");

let pass = 0, fail = 0;
function eq(label, got, want){
  const ok = typeof want === "number" ? Math.abs(got-want) < 0.011 : got === want;
  ok ? pass++ : fail++;
  console.log((ok?"  ok   ":"  FAIL ") + label + "  got=" + JSON.stringify(got) + (ok?"":"  want="+JSON.stringify(want)));
}
function ok(label, cond){ eq(label, !!cond, true); }

var captured = {};
let captureInstalled = false;
function installDownloadCapture(w){
  if(captureInstalled) return;
  captureInstalled = true;
  w.URL.createObjectURL = () => "blob:x";
  w.URL.revokeObjectURL = () => {};
  const origBlob = w.Blob;
  w.Blob = function(parts, opts){ captured.text = parts.join(""); captured.type = opts?.type; return new origBlob(parts, opts); };
  w.HTMLAnchorElement.prototype.click = function(){};
}

/* The built demo sits at the project root, one level above this file. Resolve
   it relative to the script rather than the working directory, so the suite
   runs the same whether invoked from the root or from packages/. */
const path = require("path");
/* The shipped demo comes first. A build output at the project root is where
   development happens; in a release the only copy is the one actually served,
   and two copies is how one of them goes stale unnoticed. */
const BUILT = [
  path.join(__dirname, "..", "site", "demo", "index.html"),
  path.join(__dirname, "..", "hr-payroll-system.html"),
  path.join(__dirname, "hr-payroll-system.html")
].find(p => fs.existsSync(p));

if(!BUILT){
  console.error("\n  The built demo was not found. Run:  node packages/build.js\n");
  process.exit(1);
}
const html = fs.readFileSync(BUILT, "utf8");
const errors = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "https://example.org/",
  virtualConsole: new (require("jsdom").VirtualConsole)().on("jsdomError", e => { if(!/Not implemented/.test(e.message)) errors.push(e.message); })
});
const w = dom.window, d = w.document;

console.log("\n--- boot ---");
eq("no script errors on load", errors.length, 0);
if(errors.length) errors.forEach(e => console.log("     " + e));
ok("app container rendered", d.getElementById("app").innerHTML.length > 500);
ok("dashboard shows headcount", d.getElementById("app").textContent.includes("On payroll"));
eq("employees seeded", w.S.employees.length, 9);
ok("pension schemes seeded", w.S.schemes.length >= 2);
ok("organisation profile present", !!w.S.employer.sector);
ok("localStorage persisted state", !!w.localStorage.getItem("hrp:state"));

console.log("\n--- navigation ---");
const tabs = [...d.querySelectorAll(".tab")];
eq("all views have tabs", tabs.length, 11);

// Marker-based, not length-based. `el.innerHTML = view()` leaves the PREVIOUS
// view in place when view() throws, so a length check passes on a broken screen.
const MARKERS = {
  dashboard:"Next steps", employees:"All employees", payroll:"Pay period",
  leave:"Request time off", payslips:"Pay documents", pensions:"Contribution comparison",
  automation:"How much runs itself", integrations:"Real Time Information", settings:"Organisation",
  absence:"Occupational pay",
  // Present whether or not a run has been committed, so it tests rendering
  // rather than the presence of data.
  journal:"Accounting entries"
};
for(const t of tabs){
  t.dispatchEvent(new w.Event("click", { bubbles:true }));
  const html2 = d.getElementById("app").innerHTML;
  ok("view '" + t.dataset.view + "' renders its own content", html2.includes(MARKERS[t.dataset.view]));
  ok("view '" + t.dataset.view + "' did not fall into recovery", !html2.includes("could not be drawn"));
}

console.log("\n--- payroll run: calculate ---");
d.querySelector('[data-view="payroll"]').dispatchEvent(new w.Event("click",{bubbles:true}));
let btn = d.getElementById("calcBtn");
ok("calculate button present", !!btn);
btn.dispatchEvent(new w.Event("click",{bubbles:true}));

const run = w.S.runs.find(r => r.period === w.S.currentPeriod);
ok("run created", !!run);
eq("payslip for every active employee", run.payslips.length, w.S.employees.filter(e=>e.status==="active").length);
ok("exceptions detected", run.exceptions.length > 0);
console.log("     exceptions raised: " + run.exceptions.map(x=>x.ref+" "+x.severity).join(", "));

console.log("\n--- every payslip balances ---");
let balanced = true, negatives = 0;
run.payslips.forEach(ps => {
  const calc = Math.round((ps.gross - ps.totalDeductions)*100)/100;
  if(Math.abs(calc - ps.net) > 0.005) balanced = false;
  if(ps.net < 0) negatives++;
});
ok("gross - deductions = net for all", balanced);
eq("no negative net pay", negatives, 0);

console.log("\n--- known exception types fire on seed data ---");
const titles = run.exceptions.map(x => x.title.toLowerCase());
ok("leaver detected (Emma Whitfield)", titles.some(t => t.includes("leaver")));
ok("duplicate bank accounts detected", titles.some(t => t.includes("bank account")));
ok("NI cat C under pension age detected", titles.some(t => t.includes("state pension age")));
ok("missing NI number detected", titles.some(t => t.includes("national insurance number")));
ok("non-cumulative code detected", titles.some(t => t.includes("emergency")));
ok("auto-enrolment gap detected", titles.some(t => t.includes("jobholder")));

console.log("\n--- gate blocks commit until every exception is decided ---");
let commitBtn = d.getElementById("commitBtn");
ok("commit button disabled while open", commitBtn.disabled);

run.exceptions.forEach(x => {
  run.decisions[x.ref] = { type: x.severity === "high" ? "hold" : "release", time:"10:00", by:"Test Officer" };
});
w.save(); w.render();
commitBtn = d.getElementById("commitBtn");
ok("commit button enabled once all decided", !commitBtn.disabled);

console.log("\n--- commit and year-to-date chaining ---");
commitBtn.dispatchEvent(new w.Event("click",{bubbles:true}));
ok("run marked committed", w.S.runs.find(r=>r.period===w.S.currentPeriod).committed);

// run the NEXT period and check YTD carried forward
const p = w.S.currentPeriod;
w.S.currentPeriod = p + 1; w.save();
w.calculateRun(p + 1);
const run2 = w.S.runs.find(r => r.period === p + 1);
const e1 = w.S.employees[0];
const ps1 = run.payslips.find(x => x.employeeId === e1.id);
const ps2 = run2.payslips.find(x => x.employeeId === e1.id);
ok("next period picks up prior YTD", ps2.ytd.gross > ps1.ytd.gross);
eq("YTD gross accumulates correctly", ps2.ytd.gross, Math.round((ps1.ytd.gross + ps2.gross)*100)/100);
eq("YTD tax accumulates correctly", ps2.ytd.tax, Math.round((ps1.ytd.tax + ps2.paye.tax)*100)/100);

console.log("\n--- twelve committed periods reconcile ---");
w.S.runs = []; w.S.currentPeriod = 1; w.save();
let sumTax = 0, sumGross = 0, last = null;
for(let i = 1; i <= 12; i++){
  w.S.currentPeriod = i;
  const r = w.calculateRun(i);
  r.exceptions.forEach(x => r.decisions[x.ref] = { type:"release", time:"10:00", by:"Test" });
  r.committed = true; r.committedAt = new Date().toISOString();
  w.save();
  const slip = r.payslips.find(x => x.employeeId === e1.id);
  sumTax += slip.paye.tax; sumGross += slip.gross; last = slip;
}
eq("12 periods of gross equals YTD gross", Math.round(sumGross*100)/100, last.ytd.gross);
eq("12 periods of tax equals YTD tax", Math.round(sumTax*100)/100, last.ytd.tax);
console.log("     employee 1 annual: gross " + last.ytd.gross + " tax " + last.ytd.tax + " net " + last.ytd.net);

console.log("\n--- payslips are reachable before commit ---");
const savedRuns = w.S.runs, savedPeriod = w.S.currentPeriod;
w.S.currentPeriod = 5; w.S.runs = []; w.save();
d.querySelector('[data-view="payslips"]').dispatchEvent(new w.Event("click",{bubbles:true}));
ok("empty state points at payroll", !!d.querySelector('[data-go="payroll"]'));
w.calculateRun(5);
d.querySelector('[data-view="payslips"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const nSlips = d.querySelectorAll("[data-slip]").length;
ok("draft payslips listed without committing", nSlips > 0);
eq("every row has a download button", d.querySelectorAll("[data-slipdl]").length, nSlips);
eq("every row has a print button", d.querySelectorAll("[data-slippr]").length, nSlips);
ok("draft status made clear", d.getElementById("app").textContent.includes("has not been committed"));

console.log("\n--- payslip download and bulk export ---");
installDownloadCapture(w);
d.querySelector("[data-slipdl]").dispatchEvent(new w.Event("click",{bubbles:true}));
ok("download produces an HTML document", (captured.type||"").startsWith("text/html"));
ok("document contains the payslip", captured.text.includes("Net pay"));
ok("document is self-contained (styles inlined)", captured.text.includes("<style>"));
ok("document carries the footer", captured.text.includes("Open Source AI Ltd"));
d.querySelector("[data-slipall]").dispatchEvent(new w.Event("click",{bubbles:true}));
eq("bulk file holds every payslip", (captured.text.match(/Net pay/g)||[]).length, nSlips);
d.querySelector("[data-slipcsv]").dispatchEvent(new w.Event("click",{bubbles:true}));
ok("summary CSV has the expected header", captured.text.startsWith("Payroll no,Name,Department"));
eq("summary CSV has a row per payslip", captured.text.trim().split("\n").length - 1, nSlips);

console.log("\n--- employee filter actually filters ---");
const selEmp = d.getElementById("slipEmp");
ok("filter control present", !!selEmp);
const pick = w.S.employees[2];
selEmp.value = pick.id; selEmp.dispatchEvent(new w.Event("change",{bubbles:true}));
eq("filtered to one payslip", d.querySelectorAll("[data-slip]").length, 1);
ok("and it is the chosen employee", d.getElementById("app").textContent.includes(pick.name));
selEmp.value = ""; selEmp.dispatchEvent(new w.Event("change",{bubbles:true}));
eq("clearing the filter restores all", d.querySelectorAll("[data-slip]").length, nSlips);

console.log("\n--- footer ---");
ok("site footer present", !!d.querySelector(".sitefoot"));
ok("footer credits Open Source AI Ltd", d.querySelector(".sitefoot").textContent.includes("Open Source AI Ltd"));
w.S.runs = savedRuns; w.S.currentPeriod = savedPeriod; w.save();   // restore for later tests

console.log("\n--- payslip document renders ---");
const slipHtml = w.payslipHTML(e1.id, 12);
ok("payslip contains employee name", slipHtml.includes(e1.name));
ok("payslip shows net pay", slipHtml.includes("Net pay"));
ok("payslip shows YTD block", slipHtml.includes("Gross to date"));
ok("payslip shows employer costs", slipHtml.includes("Paid by the employer"));
ok("payslip shows leave balance", slipHtml.includes("Leave balance"));

console.log("\n--- leave workflow ---");
d.querySelector('[data-view="leave"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const before = w.S.leave.length;
d.getElementById("lvFrom").value = "2026-11-02";
d.getElementById("lvTo").value = "2026-11-06";
d.getElementById("lvSubmit").dispatchEvent(new w.Event("click",{bubbles:true}));
eq("leave request added", w.S.leave.length, before + 1);
const newest = w.S.leave[w.S.leave.length-1];
const bookedEmp = w.emp(newest.employeeId);
eq("five working days booked at their hours", newest.hours,
   Math.round(5 * (bookedEmp.weeklyHours/bookedEmp.daysPerWeek) * 100)/100);
eq("starts as pending", newest.status, "pending");

const bal = w.ENGINE.leaveBalance(w.S.employees[0], w.S.leave, "2026-08-21");
ok("balance held in hours", bal.total > 200);
const carrier = w.S.employees.find(e => e.carriedDays > 0);
ok("someone has carried-over leave", !!carrier);
ok("carried-over tracked", w.ENGINE.leaveBalance(carrier, w.S.leave, "2026-08-21").carriedRemaining > 0);
ok("statutory minimum computed", bal.statutoryMinimumDays === 28);

console.log("\n--- CSV exports produce data ---");
installDownloadCapture(w);
w.exportCSV("fps");
ok("FPS export has header row", captured.text.startsWith("Payroll ID,Surname"));
ok("FPS export has NI band columns", captured.text.includes("Earnings LEL to PT"));
w.exportCSV("bacs");
ok("BACS export has payment columns", captured.text.startsWith("Sort code,Account number"));
w.exportCSV("employees");
ok("employee export works", captured.text.includes("Payroll no"));

console.log("\n--- settings persist ---");
d.querySelector('[data-view="settings"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const brl = d.querySelector('[data-cfg="config.bands.0.limit"]');
ok("basic rate limit field present", !!brl);
brl.value = "38000";
brl.dispatchEvent(new w.Event("change",{bubbles:true}));
eq("config updated in state", w.S.config.bands[0].limit, 38000);
ok("config written to storage", JSON.parse(w.localStorage.getItem("hrp:state")).config.bands[0].limit === 38000);
ok("no personal allowance field (allowance comes from the tax code)", !d.querySelector('[data-cfg="config.personalAllowance"]'));
w.S.config.bands[0].limit = 37700; w.save();

console.log("\n--- editing a rate actually changes the calculation ---");
w.S.runs = []; w.S.currentPeriod = 1; w.save();
const baseTax = w.calculateRun(1).payslips.find(x => x.employeeId === e1.id).paye.tax;
w.S.config.bands[0].rate = 0.25; w.S.runs = []; w.save();
const higherRateTax = w.calculateRun(1).payslips.find(x => x.employeeId === e1.id).paye.tax;
ok("raising the basic rate raises the tax", higherRateTax > baseTax);
w.S.config.bands[0].rate = 0.20; w.S.runs = []; w.save();

console.log("\n--- tax code drives the allowance, not a global setting ---");
const e2 = w.S.employees[2];
w.S.runs = []; const rr = w.calculateRun(1);
const normal = rr.payslips.find(x => x.employeeId === e2.id).paye.tax;
e2.taxCode = "BR"; w.S.runs = []; w.save();
const brTax = w.calculateRun(1).payslips.find(x => x.employeeId === e2.id).paye.tax;
ok("BR code taxes more than 1257L (no free pay)", brTax > normal);
e2.taxCode = "1257L"; w.S.runs = []; w.save();

console.log("\n--- sector switching ---");
w.S = w.seedState("public"); w.save(); w.refreshPeriods(); w.render();
eq("public preset loads", w.S.employer.sector, "public");
ok("LGPS scheme present", w.S.schemes.some(s => s.name.includes("Local Government")));
ok("public body does not claim Employment Allowance", !w.S.employer.claimsEmploymentAllowance);
w.S.currentPeriod = 1; w.S.runs = [];
let pubRun = w.calculateRun(1);
eq("public body pays full employer NI", pubRun.reliefs.employerNIPayable, pubRun.totals.niEmployer);

w.S = w.seedState("private"); w.save(); w.refreshPeriods(); w.render();
eq("private preset loads", w.S.employer.sector, "private");
ok("private body claims Employment Allowance", w.S.employer.claimsEmploymentAllowance);
w.S.currentPeriod = 1; w.S.runs = [];
let privRun = w.calculateRun(1);
ok("Employment Allowance reduces employer NI", privRun.reliefs.employerNIPayable < privRun.totals.niEmployer);
ok("allowance tracked as claimed", privRun.reliefs.employmentAllowanceClaimed > 0);

console.log("\n--- pension scheme drives the contribution ---");
const dm = w.S.employees.find(e => e.director);
ok("a director exists in the private seed", !!dm);
const dslip = privRun.payslips.find(x => x.employeeId === dm.id);
ok("director NI flagged on the payslip", dslip.ni.director);
const qualEmp = w.S.employees.find(e => e.pensionSchemeId === "SCH1");
const qslip = privRun.payslips.find(x => x.employeeId === qualEmp.id);
ok("qualifying basis uses less than gross", qslip.pension.earnings < qslip.gross);
eq("scheme basis recorded", qslip.pension.basis, "qualifying");

console.log("\n--- changing a scheme changes everyone in it ---");
const sch = w.S.schemes.find(s => s.id === "SCH1");
const beforeContrib = qslip.pension.employee;
sch.employeeRate = 0.10; w.S.runs = []; w.save();
const afterContrib = w.calculateRun(1).payslips.find(x => x.employeeId === qualEmp.id).pension.employee;
ok("doubling the scheme rate doubles the contribution", Math.abs(afterContrib - beforeContrib*2) < 0.05);
sch.employeeRate = 0.05; w.S.runs = []; w.save();

console.log("\n--- pay frequency rebuilds the period calendar ---");
w.S.config.payFrequency = "weekly"; w.refreshPeriods();
eq("52 weekly periods", w.PERIODS.length, 52);
w.S.runs = []; w.S.currentPeriod = 1; w.save();
const wkRun = w.calculateRun(1);
ok("weekly gross is roughly a twelfth of monthly", wkRun.totals.gross < privRun.totals.gross / 3);
w.S.config.payFrequency = "monthly"; w.refreshPeriods(); w.S.runs = []; w.save();

console.log("\n--- integrations screen ---");
d.querySelector('[data-view="integrations"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const itxt = d.getElementById("app").textContent;
ok("RTI card present", itxt.includes("Real Time Information"));
ok("BACS card present", itxt.includes("Service User Number"));
ok("pension providers card present", itxt.includes("i-Connect"));
ok("all three show as not connected", (d.getElementById("app").innerHTML.match(/not connected/g)||[]).length >= 3);

console.log("\n--- integration exports ---");
w.S.currentPeriod = 1; w.S.runs = [];
const r0 = w.calculateRun(1);
r0.exceptions.forEach(x => r0.decisions[x.ref] = { type:"release", time:"10:00", by:"Test" });
r0.committed = true; w.save();
w.exportCSV("eps");
ok("EPS export includes Employment Allowance", captured.text.includes("Employment Allowance claimed"));
w.exportCSV("pension");
ok("pension file has scheme and basis columns", captured.text.startsWith("Scheme,Provider"));
ok("pension file names the provider", captured.text.includes("NEST"));

console.log("\n--- pensions screen ---");
d.querySelector('[data-view="pensions"]').dispatchEvent(new w.Event("click",{bubbles:true}));
ok("comparison table rendered", d.getElementById("app").textContent.includes("Contribution comparison"));

console.log("\n--- manual vs automated toggle ---");
w.S = w.seedState("private"); w.save(); w.refreshPeriods();
w.S.currentPeriod = 1; w.S.runs = [];
eq("starts in manual", w.S.automation.mode, "manual");
const manRun = w.calculateRun(1);
eq("manual mode produces no actions", (manRun.actions||[]).length, 0);
eq("manual mode logs nothing", w.S.automation.log.length, 0);
const manOpen = manRun.exceptions.filter(x => !manRun.decisions[x.ref]).length;
ok("manual leaves every exception for a human", manOpen === manRun.exceptions.length);

d.querySelector('[data-view="automation"]').dispatchEvent(new w.Event("click",{bubbles:true}));
d.querySelector('[data-mode="automated"]').dispatchEvent(new w.Event("click",{bubbles:true}));
eq("switched to automated", w.S.automation.mode, "automated");
const autoRun = w.runFor(1);
ok("automated mode produces actions", (autoRun.actions||[]).length > 0);
ok("automated mode wrote to the log", w.S.automation.log.length > 0);
const autoOpen = autoRun.exceptions.filter(x => !autoRun.decisions[x.ref]).length;
ok("automated mode clears some exceptions", autoOpen < manOpen);
ok("cleared ones are attributed to a rule",
   Object.values(autoRun.decisions).filter(Boolean).every(v => v.byRule || v.by !== "Automation rule"));

console.log("\n--- automation actually corrects the data ---");
// Construct the condition rather than hoping the seed contains it: the seeded
// category-M employee is 19, so the rule correctly leaves them alone.
w.S = w.seedState("private");
w.S.automation.mode = "automated"; w.S.automation.policy = w.defaultPolicy("automated");
const target = w.S.employees[3];
target.niCategory = "M"; target.dob = "2004-02-01";      // 22 by August 2026
const stillYoung = w.S.employees.find(e => e.niCategory === "M" && e.id !== target.id);
w.S.currentPeriod = 5; w.S.runs = []; w.save();
w.calculateRun(5);
eq("the 22-year-old on category M was corrected", w.emp(target.id).niCategory, "A");
if(stillYoung) eq("the 19-year-old was left on M", w.emp(stillYoung.id).niCategory, "M");
ok("the correction was logged", w.S.automation.log.some(l => l.ruleId === "ni-age"));
const enrolled = w.S.employees.filter(e => e.pensionSchemeId).length;
ok("eligible jobholders were enrolled", enrolled >= 8);

console.log("\n--- guardrails hold in automated mode ---");
// The seeded leaver left on 31 July, so the rule only fires from period 5 (August)
w.S.currentPeriod = 5; w.S.runs = []; w.save();
const augRun = w.calculateRun(5);
const leaverAct = (augRun.actions||[]).find(x => x.ruleId === "leaver-final-pay");
ok("leaver action raised in the period after leaving", !!leaverAct);
eq("leaver stays a proposal even in automated mode", leaverAct.tier, "propose");
ok("leaver proposal marked as blocking", leaverAct.blocking);
ok("payment in lieu calculated for the leaver", leaverAct.change.pilonAmount > 0);
ok("leaver was not auto-applied", !w.S.automation.log.some(l => l.ruleId === "leaver-final-pay" && l.automatic));
const dupEx = augRun.exceptions.find(x => x.title.includes("bank account"));
ok("a duplicate bank account exists in the seed", !!dupEx);
if(dupEx) ok("duplicate bank account never auto-decided", !augRun.decisions[dupEx.ref]);
const leaverEx = augRun.exceptions.find(x => x.title.includes("Leaver"));
if(leaverEx) ok("leaver exception never auto-decided", !augRun.decisions[leaverEx.ref]);
w.S.currentPeriod = 1;
const commitBtn2 = (() => { d.querySelector('[data-view="payroll"]').dispatchEvent(new w.Event("click",{bubbles:true}));
  return d.getElementById("commitBtn"); })();
ok("commit still blocked while exceptions remain", !commitBtn2 || commitBtn2.disabled);

console.log("\n--- a rule can be overridden individually ---");
d.querySelector('[data-view="automation"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const sel = d.querySelector('[data-rule="ni-age"]');
ok("rule selector present", !!sel);
sel.value = "off"; sel.dispatchEvent(new w.Event("change",{bubbles:true}));
eq("override saved", w.S.automation.policy["ni-age"], "off");
const lockedSel = d.querySelector('[data-rule="leaver-final-pay"]');
ok("locked rule offers no apply option", ![...lockedSel.options].some(o => o.value === "apply"));
ok("commit rule selector disabled", d.querySelector('[data-rule="commit-run"]').disabled);

console.log("\n--- automated changes are reversible ---");
// fresh seed: earlier steps already corrected these records
w.S = w.seedState("private");
w.S.automation.mode = "automated";
w.S.automation.policy = w.defaultPolicy("automated");
w.S.currentPeriod = 5; w.S.runs = []; w.save();
w.calculateRun(5);
const entry = w.S.automation.log.find(l => l.undo && !l.reversed && l.undo.type === "setField");
if(entry) console.log("     reversing: " + entry.ruleId + " — " + entry.label.slice(0,50));
if(entry){
  const e2 = w.emp(entry.undo.employeeId);
  const nowVal = e2[entry.undo.field], wasVal = entry.undo.to;
  w.reverseLogEntry(entry.id);
  eq("field restored to its previous value", w.emp(entry.undo.employeeId)[entry.undo.field], wasVal);
  ok("value genuinely changed back", nowVal !== wasVal);
  ok("log entry marked reversed", w.S.automation.log.find(l => l.id === entry.id).reversed);
} else { ok("a reversible field change exists in the log", false); }

console.log("\n--- touchless rate rises with automation ---");
w.S.automation.mode = "manual"; w.S.automation.policy = w.defaultPolicy("manual");
w.S = w.seedState("private"); w.S.currentPeriod = 1; w.S.runs = []; w.save();
const rMan = w.calculateRun(1);
const tMan = w.touchlessRate({payslips:rMan.payslips,exceptions:rMan.exceptions,decisions:rMan.decisions,actions:rMan.actions||[]});
w.S.automation.mode = "automated"; w.S.automation.policy = w.defaultPolicy("automated");
w.S.runs = []; w.save();
const rAuto = w.calculateRun(1);
const tAuto = w.touchlessRate({payslips:rAuto.payslips,exceptions:rAuto.exceptions,decisions:rAuto.decisions,actions:rAuto.actions||[]});
const openMan  = rMan.exceptions.filter(x => !rMan.decisions[x.ref]).length;
const openAuto = rAuto.exceptions.filter(x => !rAuto.decisions[x.ref]).length;
console.log("     manual: " + openMan + " decisions, " + tMan.rate + "% touchless");
console.log("     auto:   " + openAuto + " decisions, " + tAuto.rate + "% touchless");
ok("automation reduces the decisions a human must make", openAuto < openMan);
ok("automation never lowers the touchless rate", tAuto.rate >= tMan.rate);
ok("avoided decisions are attributed to a rule",
   Object.values(rAuto.decisions).filter(Boolean).every(v => v.byRule));
// One person can carry several exceptions, so the per-record rate understates
// the saving. Both numbers are shown in the UI for that reason.
ok("financial exceptions still require a human", rAuto.exceptions
   .filter(x => x.amount > 0).every(x => !rAuto.decisions[x.ref]));

console.log("\n--- cover mode: the payroll lead is away ---");
w.S = w.seedState("private");
w.S.automation.mode = "cover";
w.S.automation.policy = w.defaultPolicy("cover");
w.S.currentPeriod = 5; w.S.runs = []; w.save();
w.calculateRun(5);
d.querySelector('[data-view="automation"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const capp = d.getElementById("app");
eq("four modes offered", d.querySelectorAll("[data-mode]").length, 4);
ok("cover panel appears", capp.textContent.includes("Who is covering"));
eq("lead, deputy and limit are configurable", d.querySelectorAll("[data-cover]").length, 5);

const boxes = [...d.querySelectorAll(".coverbox")];
ok("proposals carry plain-English guidance", boxes.length > 0);
ok("the leaver is held for the lead", boxes.some(b => b.className.includes("auth-lead")));
ok("and names who it waits for", capp.textContent.includes("A. Okafor"));
eq("Accept is disabled when it is not the deputy's call",
   [...d.querySelectorAll("[data-doact]")].filter(b => b.disabled).length,
   boxes.filter(b => !b.className.includes("auth-deputy")).length);
ok("the run is not ready while something is held for the lead", capp.textContent.includes("Not ready"));

console.log("\n--- delegation limits are adjustable in the UI ---");
const limEl = d.querySelector('[data-cover="releaseLimit"]');
limEl.value = "50"; limEl.dispatchEvent(new w.Event("change",{bubbles:true}));
eq("limit saved to state", w.S.automation.cover.releaseLimit, 50);
const escEl = d.querySelector('[data-cover="escalateHighSeverity"]');
escEl.value = "false"; escEl.dispatchEvent(new w.Event("change",{bubbles:true}));
eq("high-risk escalation can be turned off", w.S.automation.cover.escalateHighSeverity, false);
ok("nothing held for the lead once escalation is off",
   ![...d.querySelectorAll(".coverbox")].some(b => b.className.includes("auth-lead")));

console.log("\n--- but the hard limits still hold under cover ---");
eq("commit rule stays off in cover mode", w.tierFor(w.S.automation.policy, "commit-run"), "off");
eq("leaver still only proposed", w.tierFor(w.S.automation.policy, "leaver-final-pay"), "propose");
w.S.automation.cover.escalateHighSeverity = true; w.save();

console.log("\n--- the edit dialog actually works ---");
/* Regression: modal buttons were bound with the same per-element helper used
   for the rest of the page, which attaches listeners only to elements present
   at that moment. Modal buttons are written in afterwards, so Save, Delete and
   Close silently did nothing and the only escape was reloading the page. */
w.S = w.seedState("private"); w.save();
w.confirm = () => true;
const isOpen = () => d.getElementById("scrim").classList.contains("show");

d.querySelector('[data-view="employees"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const eid = d.querySelector("[data-edit]").dataset.edit;
const origName = w.emp(eid).name;

d.querySelector("[data-edit]").dispatchEvent(new w.Event("click",{bubbles:true}));
ok("the dialog opens", isOpen());
const nameInput = d.querySelector("#modalBody input");
nameInput.value = "Renamed Person";
[...d.querySelectorAll("[data-ma]")].find(b => b.dataset.ma === "saveEmp")
  .dispatchEvent(new w.Event("click",{bubbles:true}));
eq("Save writes the change", w.emp(eid).name, "Renamed Person");
ok("and closes the dialog", !isOpen());

d.querySelector("[data-edit]").dispatchEvent(new w.Event("click",{bubbles:true}));
[...d.querySelectorAll("[data-ma]")].find(b => b.dataset.ma === "close")
  .dispatchEvent(new w.Event("click",{bubbles:true}));
ok("Close closes it", !isOpen());

d.querySelector("[data-edit]").dispatchEvent(new w.Event("click",{bubbles:true}));
d.dispatchEvent(new w.KeyboardEvent("keydown",{ key:"Escape", bubbles:true }));
ok("Escape closes it", !isOpen());

d.querySelector("[data-edit]").dispatchEvent(new w.Event("click",{bubbles:true}));
d.getElementById("scrim").dispatchEvent(new w.Event("click",{bubbles:true}));
ok("clicking the backdrop closes it", !isOpen());

const countBefore = w.S.employees.length;
d.querySelector("[data-edit]").dispatchEvent(new w.Event("click",{bubbles:true}));
[...d.querySelectorAll("[data-ma]")].find(b => b.dataset.ma === "delEmp")
  .dispatchEvent(new w.Event("click",{bubbles:true}));
eq("Delete removes the employee", w.S.employees.length, countBefore - 1);
ok("and closes the dialog", !isOpen());

console.log("\n--- modal actions survive a re-render ---");
w.S = w.seedState("private"); w.save();
d.querySelector('[data-view="payroll"]').dispatchEvent(new w.Event("click",{bubbles:true}));
d.querySelector('[data-view="employees"]').dispatchEvent(new w.Event("click",{bubbles:true}));
d.querySelector("[data-edit]").dispatchEvent(new w.Event("click",{bubbles:true}));
[...d.querySelectorAll("[data-ma]")].find(b => b.dataset.ma === "close")
  .dispatchEvent(new w.Event("click",{bubbles:true}));
ok("still closes after navigating between views", !isOpen());

console.log("\n--- P45 for a leaver ---");
w.S = w.seedState("private");
w.S.currentPeriod = 5; w.S.runs = []; w.save();
const leaver = w.S.employees.find(e => e.leavingDate);
ok("the seed includes a leaver", !!leaver);

d.querySelector('[data-view="payslips"]').dispatchEvent(new w.Event("click",{bubbles:true}));
ok("a leaver certificates section exists", d.getElementById("app").textContent.includes("Leaver certificates"));
eq("but no P45 before the final pay is committed", d.querySelectorAll("[data-p45]").length, 0);
ok("and it says why", d.getElementById("app").textContent.includes("not yet committed") ||
   d.getElementById("app").textContent.includes("Not due"));

const prun = w.calculateRun(5);
prun.exceptions.forEach(x => prun.decisions[x.ref] = { type:"release", time:"10:00", by:"A. Okafor" });
prun.committed = true; w.save();
d.querySelector('[data-view="payslips"]').dispatchEvent(new w.Event("click",{bubbles:true}));
eq("once committed, a P45 is available", d.querySelectorAll("[data-p45]").length, 1);

/* Click the button rather than calling the function. The View button called
   openDoc(), which never existed — the document rendered fine when called
   directly, so a test that did that passed while the button threw. */
d.querySelector("[data-p45]").dispatchEvent(new w.Event("click",{bubbles:true}));
ok("View opens the dialog", d.getElementById("scrim").classList.contains("show"));
ok("titled with the employee", d.getElementById("modalLabel").textContent.includes(leaver.name));
ok("showing Part 1A", d.getElementById("modalBody").textContent.includes("Part 1A"));
eq("with Download, Print and Close",
   [...d.querySelectorAll("#modalActions [data-ma]")].map(b => b.textContent).join("/"),
   "Download/Print/Close");
[...d.querySelectorAll("#modalActions [data-ma]")].find(b => b.dataset.ma === "close")
  .dispatchEvent(new w.Event("click",{bubbles:true}));
ok("and closes again", !d.getElementById("scrim").classList.contains("show"));

const p45 = w.p45HTML(leaver.id);
const p45text = p45.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
ok("it is Part 1A, the employee's copy", p45text.includes("Part 1A"));
ok("carries the employer PAYE reference", p45text.includes(w.S.employer.payeRef));
ok("carries the leaving date", p45text.includes("Leaving date"));
ok("carries the tax code at leaving", p45text.includes("Tax code at leaving"));
ok("states the week 1 / month 1 basis", p45text.includes("Week 1 / Month 1"));
ok("flags student loan deductions", p45text.includes("Student loan deductions"));
ok("shows pay in this employment", p45text.includes("Pay in this employment"));
ok("explains Part 1 goes via the FPS", p45text.includes("Full Payment Submission"));
ok("tells the employee copies cannot be issued", p45text.includes("cannot be issued"));

const pslip = prun.payslips.find(p => p.employeeId === leaver.id);
const asMoney = n => "\u00a3" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
ok("the figures come from the committed payslip",
   p45.includes(asMoney(pslip.ytd.taxable)) && p45.includes(asMoney(pslip.ytd.tax)));

console.log("\n--- a week 1 / month 1 leaver reports no cumulative total ---");
const w1 = w.S.employees[1];
w1.leavingDate = "2026-08-20"; w1.taxCode = "1257LM1"; w.save();
w.S.runs = []; w.save();
const r2 = w.calculateRun(5);
r2.exceptions.forEach(x => r2.decisions[x.ref] = { type:"release", time:"10:00", by:"A" });
r2.committed = true; w.save();
const p45b = w.p45HTML(w1.id).replace(/<[^>]+>/g," ");
ok("total pay to date is not applicable on week 1/month 1", p45b.includes("Not applicable"));
ok("and the basis is recorded as yes", /Week 1 \/ Month 1 basis\s*Yes/.test(p45b.replace(/\s+/g," ")));

console.log("\n--- hourly paid work ---");
d.querySelector('[data-view="payroll"]').dispatchEvent(new w.Event("click",{bubbles:true}));
w.payElementModal();
ok("the pay element dialog opens", !!d.getElementById("elAmount"));
const hrs = d.getElementById("elHours"), rate = d.getElementById("elRate"), amt = d.getElementById("elAmount");
ok("hours and rate are both offered", !!hrs && !!rate);
hrs.value = "12.5"; rate.value = "14.40";
hrs.dispatchEvent(new w.Event("input",{bubbles:true}));
eq("the amount is calculated from hours and rate", amt.value, "180.00");
rate.value = "15.00"; rate.dispatchEvent(new w.Event("input",{bubbles:true}));
eq("and recalculates when the rate changes", amt.value, "187.50");

console.log("\n--- occupational absence in the demo ---");
w.S = w.seedState("private"); w.save();
d.querySelector('[data-view="absence"]').dispatchEvent(new w.Event("click",{bubbles:true}));
let atext = d.getElementById("app").textContent.replace(/\s+/g," ");
ok("the absence view renders", !atext.includes("Something went wrong"));
ok("schemes are listed", atext.includes("Occupational sick pay"));
ok("service bands shown", atext.includes("5 years or more"));
ok("explains entitlement is consumed, not reset", atext.includes("consumed, not reset"));
ok("explains occupational pay is inclusive of statutory", atext.includes("inclusive of statutory"));

const consumed = w.ABSENCE.entitlementFor({
  employee: { ...w.S.employees[2], startedOn: w.S.employees[2].startDate },
  scheme: w.S.absenceSchemes[0], absenceStart:"2026-08-10",
  history: w.S.absences.filter(x => x.employeeId === w.S.employees[2].id && x.id === "ABS-1") });
eq("55 days already used", consumed.fullDaysUsed, 55);
eq("so 10 remain at full pay", consumed.fullDaysRemaining, 10);

console.log("\n--- absence and leave reach the commit gate ---");
w.S.currentPeriod = 5; w.S.runs = []; w.save();
const gateRun = w.calculateRun(5);
ok("absence raises an exception", gateRun.exceptions.some(x => x.kind === "absence"));
ok("leave raises exceptions", gateRun.exceptions.some(x => x.kind === "leave"));
ok("the half-pay drop is flagged",
   gateRun.exceptions.some(x => x.title.includes("half rate")));
ok("an unlawful entitlement is flagged as high severity",
   gateRun.exceptions.some(x => x.title.includes("below the statutory") && x.severity === "high"));
ok("expiring carry-over is flagged",
   gateRun.exceptions.some(x => x.title.includes("about to expire")));

console.log("\n--- leave schemes in the demo ---");
d.querySelector('[data-view="leave"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const ltext = d.getElementById("app").textContent.replace(/\s+/g," ");
ok("the leave view renders", !ltext.includes("Something went wrong"));
ok("several schemes listed", ltext.includes("Leave schemes"));
ok("irregular hours accrual explained", ltext.includes("12.07%"));
ok("Harpur Trust cited", ltext.includes("Harpur Trust"));
ok("a below-statutory scheme is marked", ltext.includes("below statutory"));
ok("carried-over days are shown", ltext.includes("carried"));
eq("statutory minimum for three days a week", w.LEAVE.statutoryMinimumDays(3), 16.8);

console.log("\n--- the two engines do not overwrite each other ---");
/* Both libraries define serviceMonthsAt and entitlementFor. Bundled into one
   scope the second would silently replace the first, and the symptom would be
   leave entitlement calculated by absence rules. */
ok("ABSENCE and LEAVE are separate namespaces",
   w.ABSENCE.entitlementFor !== w.LEAVE.entitlementFor);
ok("and both still work",
   typeof w.ABSENCE.assessAbsence === "function" && typeof w.LEAVE.balanceFor === "function");

console.log("\n--- every button on every view, clicked ---");
/* The bug this exists to catch: the P45 View button called openDoc(), which
   was never defined. Tests that called p45HTML() directly passed, because the
   document rendered fine — it was the handler that threw. Rendering a view is
   not the same as its controls working, so this clicks all of them. */
w.S = w.seedState("private");
w.S.currentPeriod = 5; w.S.runs = []; w.save();
const auditRun = w.calculateRun(5);
auditRun.exceptions.forEach(x => auditRun.decisions[x.ref] = { type:"release", time:"10:00", by:"A" });
auditRun.committed = true; w.save();

w.confirm = () => true;
w.print = () => {};
w.URL.createObjectURL = () => "blob:x";
w.URL.revokeObjectURL = () => {};
w.HTMLAnchorElement.prototype.click = function(){};
w.open = () => ({ document:{ write(){}, close(){} }, focus(){}, print(){}, close(){} });

const auditViews = ["dashboard","employees","payroll","leave","absence","payslips",
                    "pensions","automation","journal","integrations","settings"];
let clicked = 0;
const brokenButtons = [];
for(const v of auditViews){
  d.querySelector('[data-view="' + v + '"]').dispatchEvent(new w.Event("click",{bubbles:true}));
  const buttons = [...d.querySelectorAll("#app button:not([disabled])")];
  for(const b of buttons){
    const label = (b.textContent || "").trim().slice(0, 30);
    const before = errors.length;
    try { b.dispatchEvent(new w.Event("click",{bubbles:true})); clicked++; }
    catch(err){ brokenButtons.push(v + " / " + label + ": " + err.message.split("\n")[0]); continue; }
    if(errors.length > before) brokenButtons.push(v + " / " + label + ": " + errors[errors.length-1]);
    const scrim = d.getElementById("scrim");
    if(scrim && scrim.classList.contains("show")) w.closeModal();
    d.querySelector('[data-view="' + v + '"]').dispatchEvent(new w.Event("click",{bubbles:true}));
  }
}
ok(clicked + " buttons clicked across " + auditViews.length + " views", clicked > 40);
ok("none of them threw" + (brokenButtons.length ? ": " + brokenButtons.join(" | ") : ""),
   brokenButtons.length === 0);

console.log("\n--- resilience against damaged saved data ---");
const BAD = {
  "version stamp but nothing else": { schemaVersion:3 },
  "null config and schemes": { schemaVersion:3, config:null, schemes:null, employees:null, employer:null },
  "employee pointing at a deleted scheme": { schemaVersion:3, employees:[{id:"X",name:"A",pensionSchemeId:"GONE",annualSalary:30000,status:"active"}], schemes:[], leave:[], runs:[] },
  "invalid pay frequency": { schemaVersion:3, config:{payFrequency:"hourly"}, currentPeriod:999, employees:[], leave:[], runs:[] },
  "malformed runs": { schemaVersion:3, employees:[], leave:[], runs:[{period:1, payslips:null, exceptions:null}] },
  "unknown automation mode": { schemaVersion:3, automation:{mode:"turbo",policy:{"ni-age":"nonsense"},log:null}, employees:[], leave:[], runs:[] },
  "previous build shape": { employer:{name:"X",logoText:"X"}, config:{periodsPerYear:12, personalAllowance:12570},
    employees:[{id:"E1",name:"Old",post:"Loader",annualSalary:27269,pensionRate:0.065,pensionEmployerRate:0.204,pensionMethod:"netPay",status:"active"}],
    leave:[], runs:[] }
};
for(const [label, bad] of Object.entries(BAD)){
  const fixed = w.normalise(JSON.parse(JSON.stringify(bad)));
  ok(label + " -> valid config", !!ENGINE_FREQ(fixed.config.payFrequency));
  ok(label + " -> at least one scheme", fixed.schemes.length > 0);
  ok(label + " -> a default scheme exists", fixed.schemes.some(s => s.isDefault));
  ok(label + " -> period in range", fixed.currentPeriod >= 1 && fixed.currentPeriod <= 52);
  ok(label + " -> automation mode valid", !!w.MODES[fixed.automation.mode]);
  ok(label + " -> every rule has a valid tier", w.AUTOMATION_RULES.every(r => !!w.TIERS[fixed.automation.policy[r.id]]));
  ok(label + " -> no dangling scheme references",
     fixed.employees.every(e => !e.pensionSchemeId || fixed.schemes.some(s => s.id === e.pensionSchemeId)));
}
function ENGINE_FREQ(f){ return w.ENGINE.PAY_FREQUENCIES[f]; }

console.log("\n--- a broken view degrades to recovery, not a dead page ---");
const goodSchemes = w.S.schemes;
w.S.schemes = null;                        // corrupt live state the way a bad write would
d.querySelector('[data-view="pensions"]').dispatchEvent(new w.Event("click",{bubbles:true}));
const rec = d.getElementById("app").innerHTML;
ok("recovery panel shown instead of a blank screen", rec.includes("could not load"));
ok("recovery offers an export of what is there", !!d.getElementById("errExport"));
ok("recovery offers a reset", !!d.getElementById("errReset"));
w.S.schemes = goodSchemes;
d.querySelector('[data-view="employees"]').dispatchEvent(new w.Event("click",{bubbles:true}));
ok("other views still work after a failure", d.getElementById("app").innerHTML.includes("All employees"));
d.querySelector('[data-view="pensions"]').dispatchEvent(new w.Event("click",{bubbles:true}));
ok("the failed view recovers once state is valid again", d.getElementById("app").innerHTML.includes("Contribution comparison"));

console.log("\n--- no errors accumulated during the whole run ---");
eq("still zero script errors", errors.length, 0);
if(errors.length) errors.forEach(e => console.log("     " + e));

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
process.exit(fail ? 1 : 0);
