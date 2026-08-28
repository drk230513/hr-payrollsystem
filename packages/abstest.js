const A = require("./absence.js");

let pass = 0, fail = 0;
function eq(l,g,w,tol=0.005){
  const ok = typeof w === "number" ? Math.abs(g-w) <= tol : JSON.stringify(g)===JSON.stringify(w);
  ok?pass++:fail++;
  console.log((ok?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(ok?"":"  want="+JSON.stringify(w)));
}
const ok = (l,c) => eq(l, !!c, true);

const OSP = A.makeScheme({
  id:"OSP", name:"Occupational sick pay", kind:"sickness",
  bands:[
    { fromMonths:0,  fullWeeks:4,  halfWeeks:4,  label:"under 1 year" },
    { fromMonths:12, fullWeeks:8,  halfWeeks:8,  label:"1 to 2 years" },
    { fromMonths:24, fullWeeks:13, halfWeeks:13, label:"2 to 5 years" },
    { fromMonths:60, fullWeeks:26, halfWeeks:26, label:"5 years or more" }
  ]
});

const emp = o => Object.assign({
  id:"E1", name:"Test Person", startedOn:"2019-01-07",
  annualSalary:32500, daysPerWeek:5, weeklyHours:37.5
}, o);

console.log("\n--- service is measured in whole months ---");
eq("just under a year", A.serviceMonthsAt("2025-09-01","2026-08-31"), 11);
eq("exactly a year", A.serviceMonthsAt("2025-09-01","2026-09-01"), 12);
eq("five years", A.serviceMonthsAt("2021-08-15","2026-08-15"), 60);
eq("a day short of five years", A.serviceMonthsAt("2021-08-15","2026-08-14"), 59);
eq("not yet started", A.serviceMonthsAt("2027-01-01","2026-08-01"), 0);

console.log("\n--- the band follows service ---");
eq("new starter", A.bandFor(OSP, "2026-06-01", "2026-08-01").label, "under 1 year");
eq("eighteen months", A.bandFor(OSP, "2025-02-01", "2026-08-01").label, "1 to 2 years");
eq("three years", A.bandFor(OSP, "2023-02-01", "2026-08-01").label, "2 to 5 years");
eq("seven years", A.bandFor(OSP, "2019-02-01", "2026-08-01").label, "5 years or more");

console.log("\n--- service is fixed at the START of the absence ---");
// Crosses five years on 15 August, mid-absence.
const crossing = A.bandFor(OSP, "2021-08-15", "2026-08-01");
eq("still in the lower band", crossing.label, "2 to 5 years");
eq("and does not move up mid-absence",
   A.bandFor(OSP, "2021-08-15", "2026-08-01").fullWeeks, 13);

console.log("\n--- entitlement in days, from weeks and the working pattern ---");
let e = A.entitlementFor({ employee: emp(), scheme: OSP, absenceStart:"2026-08-03", history: [] });
eq("seven years of service", e.band.label, "5 years or more");
eq("26 weeks at full pay is 130 days", e.fullDaysEntitled, 130);
eq("and 130 at half", e.halfDaysEntitled, 130);
eq("none used", e.fullDaysUsed, 0);

console.log("\n--- a part-timer gets the same WEEKS, fewer days ---");
e = A.entitlementFor({ employee: emp({ daysPerWeek:3 }), scheme: OSP,
  absenceStart:"2026-08-03", history: [] });
eq("26 weeks on three days a week is 78 days", e.fullDaysEntitled, 78);
ok("which is fewer than a full-timer's", e.fullDaysEntitled < 130);

console.log("\n--- entitlement is CONSUMED, not reset each year ---");
const history = [
  { id:"A1", employeeId:"E1", schemeId:"OSP", kind:"sickness",
    from:"2026-03-02", to:"2026-04-10", workingDays:30, fullPaidDays:30, halfPaidDays:0 }
];
e = A.entitlementFor({ employee: emp(), scheme: OSP, absenceStart:"2026-08-03", history });
eq("thirty days already used", e.fullDaysUsed, 30);
eq("so a hundred remain at full pay", e.fullDaysRemaining, 100);
eq("half pay is untouched", e.halfDaysRemaining, 130);
eq("one prior spell", e.priorOccurrences, 1);

console.log("\n--- the window is rolling, so old absence falls out ---");
const old = [
  { id:"A0", employeeId:"E1", schemeId:"OSP", kind:"sickness",
    from:"2025-01-06", to:"2025-02-14", workingDays:30, fullPaidDays:30, halfPaidDays:0 }
];
e = A.entitlementFor({ employee: emp(), scheme: OSP, absenceStart:"2026-08-03", history: old });
eq("an absence 18 months ago does not count", e.fullDaysUsed, 0);
eq("so the full entitlement is available", e.fullDaysRemaining, 130);

console.log("\n--- an absence straddling the window edge is apportioned ---");
// Window opens 2025-08-03. This absence runs 2025-07-21 to 2025-08-15.
const straddle = [
  { id:"A2", employeeId:"E1", schemeId:"OSP", kind:"sickness",
    from:"2025-07-21", to:"2025-08-15", workingDays:20, fullPaidDays:20, halfPaidDays:0 }
];
e = A.entitlementFor({ employee: emp(), scheme: OSP, absenceStart:"2026-08-03", history: straddle });
ok("only part of it counts", e.fullDaysUsed > 0 && e.fullDaysUsed < 20);
ok("roughly the days inside the window", Math.abs(e.fullDaysUsed - 10) < 4);

console.log("\n--- working out an absence ---");
let r = A.assessAbsence({
  employee: emp(), scheme: OSP,
  absence: { id:"N1", from:"2026-08-03", to:"2026-08-14", workingDays:10 },
  history: [], statutoryPaid: 0
});
eq("ten working days", r.workingDays, 10);
eq("all at full pay", r.daysAtFullPay, 10);
eq("none at half", r.daysAtHalfPay, 0);
eq("none unpaid", r.daysUnpaid, 0);
eq("daily rate from salary", r.dailyRate, 32500/52/5);
eq("gross occupational pay", r.grossOccupational, 10 * (32500/52/5));

console.log("\n--- OCCUPATIONAL PAY IS INCLUSIVE OF STATUTORY ---");
/* The most common and most expensive occupational sick pay error is paying
   full pay AND SSP. The employee receives the higher, never the sum. */
r = A.assessAbsence({
  employee: emp(), scheme: OSP,
  absence: { from:"2026-08-03", to:"2026-08-14", workingDays:10 },
  history: [], statutoryPaid: 118.75
});
eq("statutory is offset, not added", r.statutoryOffset, 118.75);
eq("the top-up is the difference", r.occupationalTopUp, p2(r.grossOccupational - 118.75));
eq("total pay equals the occupational figure", r.totalPayable, r.grossOccupational);
ok("which is NOT occupational plus statutory",
   r.totalPayable < r.grossOccupational + 118.75);

console.log("\n--- unless the scheme genuinely pays both ---");
const ADDITIVE = A.makeScheme({ id:"ADD", name:"On top", bands: OSP.bands, offsetStatutory:false });
r = A.assessAbsence({
  employee: emp(), scheme: ADDITIVE,
  absence: { from:"2026-08-03", to:"2026-08-14", workingDays:10 },
  history: [], statutoryPaid: 118.75
});
eq("nothing is offset", r.statutoryOffset, 0);
eq("and both are paid", r.totalPayable, p2(r.grossOccupational + 118.75));

console.log("\n--- dropping from full to half pay part-way through ---");
const nearlyOut = [
  { id:"B1", employeeId:"E1", schemeId:"OSP", from:"2026-05-05", to:"2026-06-26",
    workingDays:40, fullPaidDays:126, halfPaidDays:0 }
];
r = A.assessAbsence({
  employee: emp(), scheme: OSP,
  absence: { from:"2026-08-03", to:"2026-08-14", workingDays:10 },
  history: nearlyOut, statutoryPaid: 0
});
eq("four days remain at full pay", r.daysAtFullPay, 4);
eq("the rest at half", r.daysAtHalfPay, 6);
eq("none unpaid yet", r.daysUnpaid, 0);
const expected = 4 * (32500/52/5) + 6 * (32500/52/5) * 0.5;
eq("paid at the two rates", r.grossOccupational, p2(expected));

console.log("\n--- running out entirely ---");
const exhausted = [
  { id:"C1", employeeId:"E1", schemeId:"OSP", from:"2025-10-01", to:"2026-06-30",
    workingDays:190, fullPaidDays:130, halfPaidDays:130 }
];
r = A.assessAbsence({
  employee: emp(), scheme: OSP,
  absence: { from:"2026-08-03", to:"2026-08-14", workingDays:10 },
  history: exhausted, statutoryPaid: 0
});
eq("nothing at full pay", r.daysAtFullPay, 0);
eq("nothing at half", r.daysAtHalfPay, 0);
eq("all ten days unpaid", r.daysUnpaid, 10);
eq("no occupational pay due", r.grossOccupational, 0);
ok("flagged as exhausted during the absence", r.exhaustedDuring);

console.log("\n--- a new starter with a short band ---");
r = A.assessAbsence({
  employee: emp({ startedOn:"2026-06-01" }), scheme: OSP,
  absence: { from:"2026-08-03", to:"2026-09-11", workingDays:30 },
  history: [], statutoryPaid: 0
});
eq("under a year gets four weeks full", r.daysAtFullPay, 20);
eq("then four weeks half", r.daysAtHalfPay, 10);
eq("band recorded", r.band, "under 1 year");

console.log("\n--- waiting days ---");
const WAIT = A.makeScheme({ id:"W", name:"With waiting days", bands: OSP.bands, waitingDays: 3 });
r = A.assessAbsence({
  employee: emp(), scheme: WAIT,
  absence: { from:"2026-08-03", to:"2026-08-14", workingDays:10 },
  history: [], statutoryPaid: 0
});
eq("three days waiting", r.waitingDays, 3);
eq("seven paid at full", r.daysAtFullPay, 7);

console.log("\n--- non-working days do not consume entitlement ---");
eq("Mon to Fri is five working days",
   A.countWorkingDays("2026-08-03","2026-08-07", emp()), 5);
eq("a full week including the weekend is still five",
   A.countWorkingDays("2026-08-03","2026-08-09", emp()), 5);
eq("two weeks is ten",
   A.countWorkingDays("2026-08-03","2026-08-14", emp()), 10);
eq("a three-day-a-week pattern counts three",
   A.countWorkingDays("2026-08-03","2026-08-09", emp({ daysPerWeek:3 })), 3);
const patterned = emp({ workingPattern: { days:[0, 7.5, 7.5, 0, 7.5, 0, 0] } });
eq("an explicit pattern is honoured",
   A.countWorkingDays("2026-08-03","2026-08-09", patterned), 3);

console.log("\n--- looking ahead to when pay drops ---");
const proj = A.projectExhaustion({
  employee: emp(), scheme: OSP,
  absence: { from:"2026-08-03", to:"2026-08-14" },
  history: nearlyOut, asAt: "2026-08-07"
});
ok("says how long full pay lasts", proj.daysAtFullPayRemaining >= 0);
ok("and gives a date", !!proj.fullPayEndsOn || proj.daysAtFullPayRemaining === 0);
ok("half pay ends later than full",
   !proj.halfPayEndsOn || !proj.fullPayEndsOn || proj.halfPayEndsOn >= proj.fullPayEndsOn);

console.log("\n--- Bradford Factor ---");
const spells = [
  { kind:"sickness", from:"2026-01-05", to:"2026-01-06", workingDays:2 },
  { kind:"sickness", from:"2026-03-02", to:"2026-03-02", workingDays:1 },
  { kind:"sickness", from:"2026-05-11", to:"2026-05-13", workingDays:3 },
  { kind:"sickness", from:"2026-07-06", to:"2026-07-07", workingDays:2 }
];
const bf = A.bradfordFactor(spells);
eq("four spells", bf.spells, 4);
eq("eight days", bf.days, 8);
eq("score is S squared times D", bf.score, 4*4*8);
const oneLong = [{ kind:"sickness", from:"2026-01-05", to:"2026-01-30", workingDays:20 }];
ok("one long absence scores lower than four short ones",
   A.bradfordFactor(oneLong).score < bf.score);

console.log("\n--- exceptions raised into the payroll run ---");
const employees = [emp({ id:"E1", name:"Marcus Bexley" })];
const absences = [
  { id:"X1", employeeId:"E1", schemeId:"OSP", kind:"sickness",
    from:"2026-08-03", to:"2026-08-14", workingDays:10, statutoryPaid:0 },
  { id:"X0", employeeId:"E1", schemeId:"OSP", kind:"sickness",
    from:"2025-10-01", to:"2026-06-30", workingDays:190, fullPaidDays:130, halfPaidDays:130 }
];
const exs = A.absenceExceptions({ employees, schemes:[OSP], absences,
  period:{ start:"2026-08-01", end:"2026-08-31" } });
ok("an exception is raised", exs.length > 0);
const ran = exs.find(x => x.title.includes("run out"));
ok("it says entitlement has run out", !!ran);
eq("and is high severity", ran.severity, "high");
ok("naming the person", ran.subject === "Marcus Bexley");
ok("with evidence attached", ran.evidence.length >= 2);
ok("and an action for a human", ran.action.length > 10);

console.log("\n--- paying statutory on top is flagged ---");
const additive = [{ id:"Y1", employeeId:"E1", schemeId:"ADD", kind:"sickness",
  from:"2026-08-03", to:"2026-08-14", workingDays:10, statutoryPaid:118.75 }];
const exs2 = A.absenceExceptions({ employees, schemes:[ADDITIVE], absences: additive,
  period:{ start:"2026-08-01", end:"2026-08-31" } });
ok("the overpayment risk is raised",
   exs2.some(x => x.title.includes("on top of occupational")));

console.log("\n--- enhanced maternity is per occurrence, not rolling ---");
const OMP = A.EXAMPLE_SCHEMES.find(s => s.id === "OMP-ENH");
eq("no rolling window", A.windowFor(OMP, "2026-08-03"), null);
const prior = [{ id:"M0", employeeId:"E1", schemeId:"OMP-ENH",
  from:"2024-01-08", to:"2024-10-04", workingDays:190, fullPaidDays:40, halfPaidDays:90 }];
const me = A.entitlementFor({ employee: emp(), scheme: OMP, absenceStart:"2026-08-03", history: prior });
eq("a previous maternity leave does not reduce this one", me.fullDaysUsed, 0);
eq("full entitlement available", me.fullDaysEntitled, 40);

console.log("\n--- a scheme with no bands pays nothing, which is valid ---");
const UNPAID = A.makeScheme({ id:"UNP", name:"Unpaid leave", bands: [] });
r = A.assessAbsence({ employee: emp(), scheme: UNPAID,
  absence:{ from:"2026-08-03", to:"2026-08-07", workingDays:5 }, history: [] });
eq("all unpaid", r.daysUnpaid, 5);
eq("nothing payable", r.grossOccupational, 0);

function p2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
process.exit(fail ? 1 : 0);
