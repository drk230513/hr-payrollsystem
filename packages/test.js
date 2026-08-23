const E = require("./engine.js");
const C = E.DEFAULT_CONFIG;

let pass = 0, fail = 0;
function ok(label, cond){ eq(label, !!cond, true); }
function ok_lt(label, a, b){ eq(label, a < b, true); }
function eq(label, got, want, tol = 0.01){
  const ok = typeof want === "number" ? Math.abs(got - want) <= tol : got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + "  got=" + JSON.stringify(got) + (ok ? "" : "  want=" + JSON.stringify(want)));
}

console.log("\n--- tax code parsing ---");
eq("1257L allowance", E.parseTaxCode("1257L").allowance, 12579);
eq("1257L cumulative", E.parseTaxCode("1257L").cumulative, true);
eq("1257L M1 non-cumulative", E.parseTaxCode("1257LM1").cumulative, false);
eq("BR fixed rate", E.parseTaxCode("BR").fixedRate, 0.20);
eq("D0 fixed rate", E.parseTaxCode("D0").fixedRate, 0.40);
eq("NT fixed rate", E.parseTaxCode("NT").fixedRate, 0);
eq("K475 negative allowance", E.parseTaxCode("K475").allowance, -4759);
eq("nonsense invalid", E.parseTaxCode("HELLO").valid, false);

console.log("\n--- PAYE: cumulative, month 1, £3,000 gross, 1257L ---");
// Free pay M1 = 12579/12 = 1048.25.  Taxable = 3000 - 1048.25 = 1951.75 @20% = 390.35
let r = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:3000, taxPaidToDate:0, period:1, grossThisPeriod:3000 });
eq("month 1 tax", r.tax, 390.35);

console.log("\n--- PAYE: cumulative month 2, steady pay (should equal month 1) ---");
r = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:6000, taxPaidToDate:390.35, period:2, grossThisPeriod:3000 });
eq("month 2 tax equals month 1", r.tax, 390.35);

console.log("\n--- PAYE: cumulative catch-up after a low month ---");
// M1 paid nothing (0 pay), M2 gets 6000. Cumulative should tax the same total.
let a = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:0, taxPaidToDate:0, period:1, grossThisPeriod:0 });
let b = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:6000, taxPaidToDate:a.tax, period:2, grossThisPeriod:6000 });
eq("two-month total matches steady total", E.p2(a.tax + b.tax), 780.70, 0.02);

console.log("\n--- PAYE: refund when pay falls (cumulative) ---");
// M1 huge, M2 nothing -> M2 should produce a refund
a = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:10000, taxPaidToDate:0, period:1, grossThisPeriod:10000 });
b = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:10000, taxPaidToDate:a.tax, period:2, grossThisPeriod:0 });
eq("month 2 is a refund", b.refund, true);

console.log("\n--- PAYE: higher rate crossover ---");
// Annual 60000 -> monthly 5000. M1: free 1048.25, taxable 3951.75.
// Basic band M1 = 37700/12 = 3141.66 @20% = 628.33; remainder 810.09 @40% = 324.03
r = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:5000, taxPaidToDate:0, period:1, grossThisPeriod:5000 });
eq("higher rate month 1", r.tax, 952.36, 0.05);
eq("two bands used", r.breakdown.length, 2);

console.log("\n--- PAYE: BR code taxes everything at 20% ---");
r = E.calcPAYE({ taxCode:"BR", taxablePayToDate:2000, taxPaidToDate:0, period:1, grossThisPeriod:2000 });
eq("BR tax", r.tax, 400);

console.log("\n--- PAYE: NT code deducts nothing ---");
r = E.calcPAYE({ taxCode:"NT", taxablePayToDate:5000, taxPaidToDate:0, period:1, grossThisPeriod:5000 });
eq("NT tax", r.tax, 0);

console.log("\n--- PAYE: 50% regulatory limit on a K code ---");
// K1000 on £1,000 gross computes to 366.81 - under the cap, so no limit needed
r = E.calcPAYE({ taxCode:"K1000", taxablePayToDate:1000, taxPaidToDate:0, period:1, grossThisPeriod:1000 });
eq("no cap when tax is under half of gross", r.regulatoryLimitApplied, false);
// K2000 on £500 gross computes to 433.48 - over the 250 cap, so it must be limited
r = E.calcPAYE({ taxCode:"K2000", taxablePayToDate:500, taxPaidToDate:0, period:1, grossThisPeriod:500 });
eq("tax capped at half of gross", r.tax, 250);
eq("limit flagged", r.regulatoryLimitApplied, true);

console.log("\n--- National Insurance, category A ---");
// PT monthly = 12570/12 = 1047.50 ; UEL monthly = 50270/12 = 4189.16
// gross 3000 -> (3000-1047.50)=1952.50 @8% = 156.20
let ni = E.calcNI({ niablePay:3000, category:"A" });
eq("employee NI cat A", ni.employee, 156.20);
// employer: ST monthly = 5000/12 = 416.66 ; (3000-416.66) @15% = 387.50
eq("employer NI cat A", ni.employer, 387.50, 0.02);

console.log("\n--- NI above the Upper Earnings Limit ---");
ni = E.calcNI({ niablePay:6000, category:"A" });
// (4189.16-1047.50)=3141.66 @8% = 251.33 ; (6000-4189.16)=1810.84 @2% = 36.22 -> 287.55
eq("employee NI crosses UEL", ni.employee, 287.55, 0.05);

console.log("\n--- NI category C: employee pays nothing, employer still pays ---");
ni = E.calcNI({ niablePay:3000, category:"C" });
eq("cat C employee", ni.employee, 0);
eq("cat C employer still charged", ni.employer > 0, true);

console.log("\n--- NI category M (under 21): employer relieved to UST ---");
ni = E.calcNI({ niablePay:3000, category:"M" });
eq("cat M employee same as A", ni.employee, 156.20);
eq("cat M employer nil below UST", ni.employer, 0);

console.log("\n--- Student loan, Plan 2, rounded down to whole pounds ---");
// threshold 28470/12 = 2372.50 ; (3000-2372.50)=627.50 @9% = 56.475 -> 56
let sl = E.calcStudentLoan({ gross:3000, plan:"plan2" });
eq("plan 2 deduction", sl.main, 56);
eq("below threshold deducts nothing", E.calcStudentLoan({ gross:2000, plan:"plan2" }).main, 0);
eq("postgrad adds separately (6% over £1,750/mo)", E.calcStudentLoan({ gross:3000, plan:"plan2", postgrad:true }).pgl, 75);

console.log("\n--- Pension arrangements behave differently ---");
const mkScheme = m => ({ name:"S", basis:"total", employeeRate:0.065, employerRate:0.03, method:m });
const args = { gross:3000, pensionablePortion:3000, basicPortion:3000 };
let np = E.calcPension({ ...args, scheme:mkScheme("netPay") });
eq("net pay reduces taxable", np.reducesTaxable, true);
eq("net pay does NOT reduce NIable", np.reducesNIable, false);
let ss = E.calcPension({ ...args, scheme:mkScheme("salarySac") });
eq("salary sacrifice reduces NIable", ss.reducesNIable, true);
eq("salary sacrifice also reduces taxable", ss.reducesTaxable, true);
let ras = E.calcPension({ ...args, scheme:mkScheme("reliefAtSource") });
eq("relief at source reduces neither", ras.reducesTaxable || ras.reducesNIable, false);
eq("no scheme means no contribution", E.calcPension({ ...args, scheme:null }).employee, 0);

console.log("\n--- Full payslip balances to the penny ---");
const SCHEME = { id:"S1", name:"Company scheme", basis:"total", employeeRate:0.065, employerRate:0.204, method:"netPay" };
const emp = {
  id:"E1", name:"Test Person", payrollNumber:"001", taxCode:"1257L", niCategory:"A",
  annualSalary:36000, pensionSchemeId:"S1",
  studentLoanPlan:"none", niNumber:"AB123456C", dob:"1985-03-11", status:"active",
  otherDeductions:[{label:"Union subscription", amount:16.90}]
};
const ps = E.calcPayslip({ employee:emp, period:1, scheme:SCHEME, elements:[{label:"Overtime", amount:500, hours:20, rate:25}] });
eq("gross", ps.gross, 3500);
eq("gross minus deductions equals net", E.p2(ps.gross - ps.totalDeductions), ps.net);
eq("pension at 6.5% of gross", ps.pension.employee, 227.50);
eq("scheme name on the deduction", ps.pension.schemeName, "Company scheme");
eq("taxable excludes pension", ps.taxableThis, 3272.50);
eq("NIable includes pension (net pay arrangement)", ps.niableThis, 3500);
eq("employer cost above gross", ps.employerCost > ps.gross, true);

console.log("\n--- Salary sacrifice genuinely reduces NI ---");
const SCHEME_SS = { ...SCHEME, method:"salarySac" };
const psSS = E.calcPayslip({ employee:emp, period:1, scheme:SCHEME_SS, elements:[{label:"Overtime", amount:500}] });
eq("sacrifice lowers employee NI", psSS.ni.employee < ps.ni.employee, true);
eq("sacrifice lowers employer NI", psSS.ni.employer < ps.ni.employer, true);

console.log("\n--- Twelve periods reconcile against the annual position ---");
let ytd = null, totalTax = 0;
for(let p = 1; p <= 12; p++){
  const slip = E.calcPayslip({ employee:emp, period:p, ytd, scheme:SCHEME });
  ytd = slip.ytd; totalTax += slip.paye.tax;
}
eq("YTD gross = 12 x monthly", ytd.gross, 36000);
// taxable = 36000 - 6.5% = 33660 ; less PA 12579 = 21081 @20% = 4216.20
eq("YTD tax matches annual calculation", ytd.tax, 4216.20, 0.30);
eq("running total equals YTD", E.p2(totalTax), ytd.tax, 0.02);

console.log("\n--- Leave calculations ---");
let lv = E.leaveHours("2026-09-14","2026-09-18","none",7.4);
eq("full working week", lv.days, 5);
eq("hours for a week", lv.hours, 37);
lv = E.leaveHours("2026-08-31","2026-09-04","none",7.4);
eq("bank holiday excluded", lv.days, 4);
eq("bank holiday counted", lv.bank, 1);
lv = E.leaveHours("2026-09-14","2026-09-18","start",7.4);
eq("half day at start", lv.days, 4.5);
lv = E.leaveHours("2026-09-12","2026-09-13","none",7.4);
eq("weekend only deducts nothing", lv.days, 0);

console.log("\n--- Exception detection fires on real data ---");
const emps = [
  { ...emp, id:"A", name:"Alice", bankSort:"20-00-00", bankAccount:"11114471", status:"active" },
  { ...emp, id:"B", name:"Bob",   bankSort:"20-00-00", bankAccount:"11114471", status:"active" },
  { ...emp, id:"C", name:"Cara",  status:"active", leavingDate:"2026-07-31", bankAccount:"22225555" },
  { ...emp, id:"D", name:"Dan",   status:"active", niCategory:"C", dob:"1990-01-01", bankAccount:"33336666" },
  { ...emp, id:"F", name:"Fay",   status:"active", taxCode:"", bankAccount:"44447777" }
];
const slips = emps.map(e => E.calcPayslip({ employee:e, period:5, scheme:SCHEME }));
const ex = E.detectExceptions({
  payslips: slips, employees: emps,
  priorPayslips: { A: { net: 1000 } },
  period: { start:"2026-08-01", end:"2026-08-31" }
});
const has = t => ex.some(x => x.title.toLowerCase().includes(t));
eq("duplicate bank account found", has("same bank account"), true);
eq("leaver found", has("leaver"), true);
eq("NI category mismatch found", has("state pension age"), true);
eq("bad tax code found", has("not recognised"), true);
eq("net pay variance found", has("net pay"), true);
eq("high severity sorted first", ex[0].severity, "high");

console.log("\n--- pension bases produce different money from the same pay ---");
const g = 3000;
const qual = E.calcPension({ gross:g, pensionablePortion:g, basicPortion:2500,
  scheme:{ name:"AE minimum", basis:"qualifying", employeeRate:0.05, employerRate:0.03, method:"reliefAtSource" } });
const totalB = E.calcPension({ gross:g, pensionablePortion:g, basicPortion:2500,
  scheme:{ name:"Full pay", basis:"total", employeeRate:0.05, employerRate:0.03, method:"netPay" } });
const basicB = E.calcPension({ gross:g, pensionablePortion:g, basicPortion:2500,
  scheme:{ name:"Basic only", basis:"basic", employeeRate:0.05, employerRate:0.03, method:"netPay" } });
// qualifying band monthly: 6240/12=520 to 50270/12=4189.16 -> (3000-520)=2480
eq("qualifying earnings band applied", qual.earnings, 2480);
eq("total basis uses all gross", totalB.earnings, 3000);
eq("basic basis uses basic only", basicB.earnings, 2500);
ok_lt("qualifying gives a smaller contribution than total", qual.employee, totalB.employee);

console.log("\n--- pay frequency changes the thresholds ---");
const wk = { ...C, payFrequency:"weekly" };
eq("weekly periods", E.periodsPerYear(wk), 52);
const niWk = E.calcNI({ niablePay:600, category:"A", config:wk });
// weekly PT = 12570/52 = 241.73 ; (600-241.73)=358.27 @8% = 28.66
eq("weekly NI uses weekly thresholds", niWk.employee, 28.66, 0.05);
const payeWk = E.calcPAYE({ taxCode:"1257L", taxablePayToDate:600, taxPaidToDate:0, period:1, grossThisPeriod:600, config:wk });
ok("weekly PAYE deducts something", payeWk.tax > 0);

console.log("\n--- directors NI is annual and cumulative ---");
const dirEmp = { ...emp, director:true };
let dytd = null, dirTotal = 0;
for(let p2i = 1; p2i <= 12; p2i++){
  const s = E.calcPayslip({ employee:dirEmp, period:p2i, ytd:dytd, scheme:SCHEME });
  dytd = s.ytd; dirTotal += s.ni.employee;
}
let sytd = null, stdTotal = 0;
for(let p3 = 1; p3 <= 12; p3++){
  const s = E.calcPayslip({ employee:emp, period:p3, ytd:sytd, scheme:SCHEME });
  sytd = s.ytd; stdTotal += s.ni.employee;
}
eq("director and standard NI converge over a full year", E.p2(dirTotal), E.p2(stdTotal), 0.60);
ok("director flagged on the calculation", E.calcNI({ niablePay:3000, director:true }).director);

console.log("\n--- Scottish bands ---");
const scot = E.calcPAYE({ taxCode:"S1257L", taxablePayToDate:3000, taxPaidToDate:0, period:1, grossThisPeriod:3000 });
const ruk  = E.calcPAYE({ taxCode:"1257L",  taxablePayToDate:3000, taxPaidToDate:0, period:1, grossThisPeriod:3000 });
ok("S prefix recognised", E.parseTaxCode("S1257L").scottish);
ok("Scottish tax differs from rest of UK", Math.abs(scot.tax - ruk.tax) > 0.5);

console.log("\n--- Employment Allowance ---");
const withEA = E.applyEmployerReliefs({ totalEmployerNI:4000, allowanceUsedToDate:0, org:{ claimsEmploymentAllowance:true } });
eq("allowance offsets employer NI", withEA.employerNIPayable, 0);
eq("allowance partly consumed", withEA.employmentAllowanceClaimed, 4000);
eq("remaining allowance tracked", withEA.allowanceRemaining, 6500);
const noEA = E.applyEmployerReliefs({ totalEmployerNI:4000, allowanceUsedToDate:0, org:{ claimsEmploymentAllowance:false } });
eq("public body pays full employer NI", noEA.employerNIPayable, 4000);
const spent = E.applyEmployerReliefs({ totalEmployerNI:4000, allowanceUsedToDate:10500, org:{ claimsEmploymentAllowance:true } });
eq("exhausted allowance claims nothing", spent.employmentAllowanceClaimed, 0);

console.log("\n--- statutory payments ---");
const ssp = E.calcSSP({ sickDays:10, qualifyingDaysPerWeek:5 });
eq("three waiting days unpaid", ssp.waitingDays, 3);
eq("seven days payable", ssp.payableDays, 7);
ok("SSP amount computed", ssp.amount > 0);
eq("first six weeks of SMP at 90%", E.calcSMP({ weekNumber:1, averageWeeklyEarnings:500 }).weekly, 450);
eq("later weeks capped at the standard rate", E.calcSMP({ weekNumber:10, averageWeeklyEarnings:500 }).weekly, 187.18);
eq("low earners keep 90% throughout", E.calcSMP({ weekNumber:10, averageWeeklyEarnings:150 }).weekly, 135);

console.log("\n--- statutory leave minimum ---");
eq("5-day week gets 28 days", E.statutoryMinimumDays(5), 28);
eq("3-day week gets 16.8 days", E.statutoryMinimumDays(3), 16.8);
eq("6-day week capped at 28", E.statutoryMinimumDays(6), 28);
const lowLeave = E.leaveBalance({ id:"x", weeklyHours:37.5, daysPerWeek:5, leaveDays:20, bankHolidaysInEntitlement:true }, [], "2026-08-21");
ok("below-statutory entitlement flagged", lowLeave.belowStatutory);
const okLeave = E.leaveBalance({ id:"y", weeklyHours:37.5, daysPerWeek:5, leaveDays:28, bankHolidaysInEntitlement:true }, [], "2026-08-21");
ok("compliant entitlement not flagged", !okLeave.belowStatutory);

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
process.exit(fail ? 1 : 0);
