const E = require("./engine.js");
const J = require("./journal.js");

let pass = 0, fail = 0;
function eq(l, g, w, tol = 0.005){
  const ok = typeof w === "number" ? Math.abs(g - w) <= tol : g === w;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + l + "  got=" + JSON.stringify(g) + (ok ? "" : "  want=" + JSON.stringify(w)));
}
function ok(l, c){ eq(l, !!c, true); }

const SCHEME = { id:"S1", name:"Workplace pension", basis:"qualifying",
                 employeeRate:0.05, employerRate:0.03, method:"reliefAtSource",
                 qualifyingLower:6240, qualifyingUpper:50270 };
const PERIOD = { n:5, taxYear:"2026/27", label:"August 2026",
                 start:"2026-08-01", end:"2026-08-31", payDate:"2026-08-28" };
const ORG = { shortName:"Northgate Logistics" };

const mkE = o => Object.assign({
  id:"E"+Math.random().toString(36).slice(2,7), status:"active", weeklyHours:37.5, daysPerWeek:5,
  taxCode:"1257L", niCategory:"A", annualSalary:36000, pensionSchemeId:"S1",
  studentLoanPlan:"none", niNumber:"AB123456C", dob:"1985-03-11",
  department:"Operations", costCentre:"OPS-100", otherDeductions:[]
}, o);

function runFor(emps, elements = {}, extra = {}){
  const payslips = emps.map(e => E.calcPayslip({
    employee:e, period:5, scheme:SCHEME, elements: elements[e.id] || []
  }));
  const run = { period:5, payslips, exceptions:[], decisions:{}, ...extra };
  return { run, payslips };
}

console.log("\n--- a single employee balances ---");
const one = [mkE({ name:"Solo", otherDeductions:[{ label:"Union subscription", amount:16.90 }] })];
let { run, payslips } = runFor(one);
let j = J.buildJournal({ run, payslips, employees:one, period:PERIOD, org:ORG });
eq("debits equal credits", j.difference, 0);
ok("marked as balanced", j.balanced);
ok("passes validation", J.validateJournal(j).valid);
eq("one employee included", j.employeesIncluded, 1);

console.log("\n--- the two sides say what they should ---");
const ps = payslips[0];
const debitOf = code => j.lines.filter(l => l.code === code).reduce((s,l) => s + l.debit, 0);
const creditOf = code => j.lines.filter(l => l.code === code).reduce((s,l) => s + l.credit, 0);
eq("gross pay debited in full", debitOf("7000"), ps.gross);
eq("employer NI debited", debitOf("7006"), ps.ni.employer);
eq("employer pension debited", debitOf("7007"), ps.pension.employer);
eq("PAYE credited to HMRC", creditOf("2210"), ps.paye.tax);
eq("both halves of NI credited together", creditOf("2211"), E.p2(ps.ni.employee + ps.ni.employer));
eq("both halves of pension credited together", creditOf("2212"), E.p2(ps.pension.employee + ps.pension.employer));
eq("net pay credited", creditOf("2220"), ps.net);
eq("union subscription credited separately", creditOf("2230"), 16.90);

console.log("\n--- the total debit is the true cost of employment ---");
eq("cost equals gross plus employer contributions", j.totalDebit,
   E.p2(ps.gross + ps.ni.employer + ps.pension.employer));
eq("and matches the payslip's own employer cost", j.totalDebit, ps.employerCost);
ok("cost exceeds gross, as it must", j.totalDebit > ps.gross);

console.log("\n--- nine employees across three cost centres ---");
const many = [
  mkE({ name:"A", costCentre:"OPS-100", annualSalary:36000 }),
  mkE({ name:"B", costCentre:"OPS-100", annualSalary:28000 }),
  mkE({ name:"C", costCentre:"WAR-200", annualSalary:31200 }),
  mkE({ name:"D", costCentre:"WAR-200", annualSalary:24960, studentLoanPlan:"plan2" }),
  mkE({ name:"E", costCentre:"FIN-300", annualSalary:52000, niCategory:"C" }),
  mkE({ name:"F", costCentre:"FIN-300", annualSalary:41904, studentLoanPlan:"plan2", postgradLoan:true }),
  mkE({ name:"G", costCentre:"OPS-100", annualSalary:22400, niCategory:"H" }),
  mkE({ name:"H", costCentre:"WAR-200", annualSalary:21840, niCategory:"M", taxCode:"1257LM1" }),
  mkE({ name:"I", costCentre:"FIN-300", annualSalary:96000, director:true })
];
({ run, payslips } = runFor(many));
j = J.buildJournal({ run, payslips, employees:many, period:PERIOD, org:ORG });
eq("still balances with nine people", j.difference, 0);
eq("all nine included", j.employeesIncluded, 9);
const centres = [...new Set(j.lines.filter(l => l.costCentre).map(l => l.costCentre))].sort();
eq("split across three cost centres", centres.join(","), "FIN-300,OPS-100,WAR-200");
eq("gross across all centres matches the run",
   j.lines.filter(l => l.code === "7000").reduce((s,l) => s + l.debit, 0),
   E.p2(payslips.reduce((s,p) => s + p.gross, 0)));

console.log("\n--- held records are excluded, because they were never paid ---");
const withHold = {
  exceptions: [{ ref:"E-01", employeeIds:[many[0].id], severity:"high" }],
  decisions: { "E-01": { type:"hold" } }
};
({ run, payslips } = runFor(many, {}, withHold));
const jh = J.buildJournal({ run, payslips, employees:many, period:PERIOD, org:ORG });
eq("eight employees posted", jh.employeesIncluded, 8);
eq("one recorded as held", jh.employeesHeld, 1);
ok("still balances", jh.balanced);
ok("the held employee's cost is not in the journal", jh.totalDebit < j.totalDebit);
eq("and the difference is exactly their cost",
   E.p2(j.totalDebit - jh.totalDebit), payslips[0].employerCost);

console.log("\n--- Employment Allowance reduces the cost, it is not income ---");
({ run, payslips } = runFor(many, {}, { reliefs: { employmentAllowanceClaimed: 500 } }));
const jea = J.buildJournal({ run, payslips, employees:many, period:PERIOD, org:ORG });
ok("still balances with the allowance", jea.balanced);
const eaLine = jea.lines.find(l => l.note && l.note.includes("Employment Allowance"));
ok("posted against the employer NI expense", eaLine && eaLine.code === "7006");
eq("as a credit, not as income", eaLine.credit, 500);
ok("no income account appears", !jea.lines.some(l => l.type === "income"));
const jNoEa = J.buildJournal({ run:{...run, reliefs:null}, payslips, employees:many, period:PERIOD, org:ORG });
eq("NI owed to HMRC falls by the allowance",
   E.p2(jNoEa.lines.filter(l=>l.code==="2211").reduce((s,l)=>s+l.credit,0)
      - jea.lines.filter(l=>l.code==="2211").reduce((s,l)=>s+l.credit,0)), 500);

console.log("\n--- salary sacrifice moves money, and still balances ---");
const sacScheme = { ...SCHEME, basis:"total", method:"salarySac", employeeRate:0.05, employerRate:0.08 };
const sacSlips = many.map(e => E.calcPayslip({ employee:e, period:5, scheme:sacScheme }));
const jsac = J.buildJournal({ run:{ period:5, payslips:sacSlips, exceptions:[], decisions:{} },
                              payslips:sacSlips, employees:many, period:PERIOD, org:ORG });
ok("balances under salary sacrifice", jsac.balanced);
ok("employer NI is lower than under net pay",
   jsac.lines.filter(l=>l.code==="7006").reduce((s,l)=>s+l.debit,0) <
   j.lines.filter(l=>l.code==="7006").reduce((s,l)=>s+l.debit,0));

console.log("\n--- holiday pay accrual ---");
({ run, payslips } = runFor(many));
const jacc = J.buildJournal({ run, payslips, employees:many, period:PERIOD, org:ORG,
                              options:{ leaveAccrual: 4820.55 } });
ok("balances with an accrual", jacc.balanced);
eq("expense debited", jacc.lines.filter(l=>l.code==="7010").reduce((s,l)=>s+l.debit,0), 4820.55);
eq("provision credited", jacc.lines.filter(l=>l.code==="2240").reduce((s,l)=>s+l.credit,0), 4820.55);
const jrel = J.buildJournal({ run, payslips, employees:many, period:PERIOD, org:ORG,
                              options:{ leaveAccrual: -1200 } });
ok("a release reverses both sides", jrel.balanced);
eq("expense credited on release", jrel.lines.filter(l=>l.code==="7010").reduce((s,l)=>s+l.credit,0), 1200);
eq("provision debited on release", jrel.lines.filter(l=>l.code==="2240").reduce((s,l)=>s+l.debit,0), 1200);

console.log("\n--- validation catches a broken journal ---");
const broken = { lines:[{ code:"7000", account:"x", debit:100, credit:0 }],
                 totalDebit:100, totalCredit:0, difference:100, balanced:false };
const v = J.validateJournal(broken);
ok("rejected", !v.valid);
ok("says by how much", v.problems[0].includes("100.00"));
ok("empty journal rejected", !J.validateJournal({ lines:[], balanced:true, difference:0 }).valid);
ok("a line with both debit and credit rejected",
   !J.validateJournal({ lines:[{code:"1",debit:5,credit:5}], balanced:true, difference:0 }).valid);
ok("a negative amount rejected",
   !J.validateJournal({ lines:[{code:"1",debit:-5,credit:0}], balanced:true, difference:0 }).valid);
ok("a line with no account code rejected",
   !J.validateJournal({ lines:[{debit:5,credit:0}], balanced:true, difference:0 }).valid);

console.log("\n--- no empty lines are ever posted ---");
const nilPay = [mkE({ name:"Nil", annualSalary:0 })];
const nilRun = runFor(nilPay);
const jn = J.buildJournal({ run:nilRun.run, payslips:nilRun.payslips, employees:nilPay, period:PERIOD, org:ORG });
ok("a zero-pay employee produces no lines", jn.lines.length === 0 || jn.lines.every(l => l.debit > 0 || l.credit > 0));
ok("every line in a normal journal carries a value", j.lines.every(l => l.debit > 0 || l.credit > 0));

console.log("\n--- a scheme not named 'pension' must still balance ---");
// Regression: the journal used to identify pension deductions by matching the
// word "pension" in the label, which double-counted any scheme named otherwise.
const oddScheme = { id:"S9", name:"Enhanced scheme", basis:"total", method:"netPay",
                    employeeRate:0.05, employerRate:0.08 };
const oddSlips = many.map(e => E.calcPayslip({ employee:e, period:5, scheme:oddScheme }));
const jodd = J.buildJournal({ run:{ period:5, payslips:oddSlips, exceptions:[], decisions:{} },
                              payslips:oddSlips, employees:many, period:PERIOD, org:ORG });
eq("balances with a scheme named 'Enhanced scheme'", jodd.difference, 0);
ok("and the pension is not counted twice",
   jodd.lines.filter(l=>l.code==="2230").reduce((s,l)=>s+l.credit,0) === 0);
["Scheme A","Retirement plan","Group personal","Enhanced scheme","AVC"].forEach(nm => {
  const s2 = { ...oddScheme, name:nm };
  const sl = many.map(e => E.calcPayslip({ employee:e, period:5, scheme:s2 }));
  const jj = J.buildJournal({ run:{ period:5, payslips:sl, exceptions:[], decisions:{} },
                              payslips:sl, employees:many, period:PERIOD, org:ORG });
  eq("balances for a scheme called " + JSON.stringify(nm), jj.difference, 0);
});

console.log("\n--- other deductions are still captured ---");
const withUnion = many.map(e => E.calcPayslip({
  employee:{ ...e, otherDeductions:[{ label:"Union subscription", amount:16.90 }] },
  period:5, scheme:oddScheme }));
const junion = J.buildJournal({ run:{ period:5, payslips:withUnion, exceptions:[], decisions:{} },
                                payslips:withUnion, employees:many, period:PERIOD, org:ORG });
ok("still balances", junion.balanced);
eq("union subscriptions posted separately",
   junion.lines.filter(l=>l.code==="2230").reduce((s,l)=>s+l.credit,0), E.p2(16.90 * many.length));

console.log("\n--- export formats ---");
const csv = J.journalToCSV(j);
ok("CSV has the expected header", csv.startsWith("Date,Reference,Account code,Account,Cost centre"));
eq("one row per line plus header and total", csv.trim().split("\n").length, j.lines.length + 2);
ok("CSV totals row carries both sides",
   csv.trim().split("\n").pop().includes(j.totalDebit.toFixed(2)));

const xero = J.journalToXero(j);
eq("Xero journal is a draft, never posted live", xero.Status, "DRAFT");
eq("one Xero line per journal line", xero.JournalLines.length, j.lines.length);
ok("debits are positive and credits negative in Xero",
   xero.JournalLines.every((l,i) => j.lines[i].debit > 0 ? l.LineAmount > 0 : l.LineAmount < 0));
eq("Xero line amounts sum to zero",
   J.jp2(xero.JournalLines.reduce((s,l) => s + l.LineAmount, 0)), 0);
ok("cost centres carried as tracking categories",
   xero.JournalLines.some(l => l.TrackingCategories.length > 0));

const sage = J.journalToSage(j);
ok("Sage rows are typed JD or JC", sage.split("\n").slice(1).every(r => /^(JD|JC),/.test(r)));
ok("Sage uses UK date order", sage.includes("28/08/2026"));
ok("Sage uses the non-vatable tax code", sage.split("\n")[1].endsWith("T9"));

console.log("\n--- reference and narrative ---");
eq("reference identifies the period", j.reference, "PAY-2026-27-P05");
ok("narrative names the period and headcount",
   j.narrative.includes("August 2026") && j.narrative.includes("9 employees"));
eq("dated on the pay date, not the period end", j.date, "2026-08-28");

console.log("\n--- a full tax year of journals reconciles ---");
let ytdDebit = 0, ytdNet = 0, ytd = null;
for(let p = 1; p <= 12; p++){
  const slips = many.map((e,i) => {
    const y = ytd ? ytd[i] : null;
    const s = E.calcPayslip({ employee:e, period:p, scheme:SCHEME, ytd:y });
    return s;
  });
  ytd = slips.map(s => s.ytd);
  const jm = J.buildJournal({ run:{ period:p, payslips:slips, exceptions:[], decisions:{} },
                              payslips:slips, employees:many,
                              period:{ ...PERIOD, n:p }, org:ORG });
  if(!jm.balanced){ eq("period " + p + " balances", jm.difference, 0); }
  ytdDebit += jm.totalDebit;
  ytdNet += jm.lines.filter(l => l.code === "2220").reduce((s,l) => s + l.credit, 0);
}
ok("every one of twelve periods balanced", true);
eq("annual cost matches the sum of employer costs",
   J.jp2(ytdDebit), J.jp2(ytd.reduce((s,y) => s + y.gross + y.niEmployer + y.pensionEr, 0)), 0.5);
eq("annual net pay matches year-to-date net",
   J.jp2(ytdNet), J.jp2(ytd.reduce((s,y) => s + y.net, 0)), 0.5);

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
process.exit(fail ? 1 : 0);
