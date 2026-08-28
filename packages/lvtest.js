const L = require("./leave.js");

let pass = 0, fail = 0;
function eq(l,g,w,tol=0.005){
  const ok = typeof w === "number" ? Math.abs(g-w) <= tol : JSON.stringify(g)===JSON.stringify(w);
  ok?pass++:fail++;
  console.log((ok?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(ok?"":"  want="+JSON.stringify(w)));
}
const ok = (l,c) => eq(l, !!c, true);

const YEAR = { starts:"2026-04-01", ends:"2027-03-31" };
const emp = o => Object.assign({
  id:"E1", name:"Test Person", startedOn:"2019-01-07",
  weeklyHours:37.5, daysPerWeek:5, department:"Operations"
}, o);

console.log("\n--- the statutory minimum is 5.6 weeks, capped at 28 days ---");
eq("five days a week hits the cap", L.statutoryMinimumDays(5), 28);
eq("six days a week is still capped at 28", L.statutoryMinimumDays(6), 28);
eq("four days a week is 22.4", L.statutoryMinimumDays(4), 22.4);
eq("three days a week is 16.8", L.statutoryMinimumDays(3), 16.8);
eq("two days a week is 11.2", L.statutoryMinimumDays(2), 11.2);
ok("so 28 days is NOT the answer for everyone", L.statutoryMinimumDays(3) !== 28);

console.log("\n--- entitlement in hours, because a day is not a day ---");
const STD = L.makeLeaveScheme({ id:"AL", name:"Annual leave", entitlementWeeks: 5.6 });
let e = L.entitlementFor({ employee: emp(), scheme: STD, leaveYear: YEAR });
eq("28 days for a five-day week", e.baseDays, 28);
eq("7.5 hours per day", e.hoursPerDay, 7.5);
eq("210 hours", e.entitlementHours, 210);
ok("not below the statutory minimum", !e.belowStatutory);

console.log("\n--- 43.75 hours and 35 hours differ, as Sovini's patterns do ---");
const long = L.entitlementFor({ employee: emp({ weeklyHours:43.75 }), scheme: STD, leaveYear: YEAR });
const short = L.entitlementFor({ employee: emp({ weeklyHours:35 }), scheme: STD, leaveYear: YEAR });
eq("both get 28 days", long.baseDays, short.baseDays);
eq("43.75 hours gives 8.75 per day", long.hoursPerDay, 8.75);
eq("35 hours gives 7 per day", short.hoursPerDay, 7);
eq("so 245 hours", long.entitlementHours, 245);
eq("against 196", short.entitlementHours, 196);
ok("holding days alone would have hidden that", long.entitlementHours > short.entitlementHours);

console.log("\n--- a part-timer gets the same weeks, fewer days ---");
e = L.entitlementFor({ employee: emp({ daysPerWeek:3, weeklyHours:22.5 }), scheme: STD, leaveYear: YEAR });
eq("16.8 days for three days a week", e.baseDays, 16.8);
eq("statutory minimum matches", e.statutoryMinimumDays, 16.8);
ok("and it is not below it", !e.belowStatutory);

console.log("\n--- a scheme below the statutory minimum is flagged ---");
const MEAN = L.makeLeaveScheme({ id:"BAD", name:"Twenty days", entitlementDays: 20 });
e = L.entitlementFor({ employee: emp(), scheme: MEAN, leaveYear: YEAR });
ok("flagged", e.belowStatutory);
eq("by eight days", e.shortfallDays, 8);

console.log("\n--- unless bank holidays make it up ---");
const PLUS = L.makeLeaveScheme({ id:"OK", name:"Twenty plus bank holidays",
  entitlementDays: 20, bankHolidaysIncluded: false, bankHolidayDays: 8 });
e = L.entitlementFor({ employee: emp(), scheme: PLUS, leaveYear: YEAR });
ok("not flagged, because 20 + 8 meets the minimum", !e.belowStatutory);
eq("bank holiday hours are separate", e.bankHolidayHours, 60);
eq("total is 28 days of hours", e.totalHours, 210);

console.log("\n--- a scheme that is not annual leave is not held to the minimum ---");
const VOL = L.makeLeaveScheme({ id:"VOL", name:"Volunteering", entitlementDays: 2,
  countsTowardStatutory: false });
e = L.entitlementFor({ employee: emp(), scheme: VOL, leaveYear: YEAR });
ok("two days is fine for a volunteering scheme", !e.belowStatutory);

console.log("\n--- long service increments ---");
const SVC = L.makeLeaveScheme({ id:"SVC", name:"With increments", entitlementWeeks: 5.6,
  serviceIncrements: [{ afterMonths: 60, extraDays: 1 }, { afterMonths: 120, extraDays: 2 }] });
eq("under five years gets the base",
   L.entitlementFor({ employee: emp({ startedOn:"2023-01-07" }), scheme: SVC, leaveYear: YEAR }).baseDays, 28);
eq("over five years gets one more",
   L.entitlementFor({ employee: emp({ startedOn:"2019-01-07" }), scheme: SVC, leaveYear: YEAR }).baseDays, 29);
eq("over ten years gets two more",
   L.entitlementFor({ employee: emp({ startedOn:"2012-01-07" }), scheme: SVC, leaveYear: YEAR }).baseDays, 30);
eq("increments are measured at the START of the leave year",
   L.entitlementFor({ employee: emp({ startedOn:"2021-06-01" }), scheme: SVC, leaveYear: YEAR }).serviceExtraDays, 0);

console.log("\n--- pro rata for a mid-year starter ---");
e = L.entitlementFor({ employee: emp({ startedOn:"2026-10-01" }), scheme: STD, leaveYear: YEAR });
ok("about half a year", Math.abs(e.proRataFraction - 0.5) < 0.05);
ok("so about half the days", Math.abs(e.baseDays - 14) < 1.5);
ok("a part-year entitlement is not judged against the full minimum", !e.belowStatutory);

console.log("\n--- and for a leaver ---");
e = L.entitlementFor({ employee: emp({ leavingDate:"2026-09-30" }), scheme: STD, leaveYear: YEAR });
ok("about half a year", Math.abs(e.proRataFraction - 0.5) < 0.05);
ok("so about half the days", Math.abs(e.baseDays - 14) < 1.5);

console.log("\n--- IRREGULAR HOURS ACCRUE AT 12.07% ---");
/* Harpur Trust v Brazel, and the 2024 reforms. Giving a casual worker a fixed
   annual figure is the error that case was about. */
const CAS = L.makeLeaveScheme({ id:"CAS", name:"Casual", accrual:"irregularHours" });
e = L.entitlementFor({ employee: emp({ weeklyHours:0, daysPerWeek:5 }), scheme: CAS,
  leaveYear: YEAR, hoursWorkedInYear: 500 });
eq("500 hours worked accrues 60.35 hours", e.entitlementHours, 60.35);
eq("the method is recorded", e.method, "irregularHours");
ok("and explained", e.note.includes("12.07"));
eq("no hours worked, no accrual",
   L.entitlementFor({ employee: emp(), scheme: CAS, leaveYear: YEAR, hoursWorkedInYear: 0 }).entitlementHours, 0);
ok("never flagged below statutory, since it accrues",
   !L.entitlementFor({ employee: emp(), scheme: CAS, leaveYear: YEAR, hoursWorkedInYear: 100 }).belowStatutory);

console.log("\n--- monthly accrual builds through the year ---");
const MON = L.makeLeaveScheme({ id:"MON", name:"Accrued monthly",
  entitlementWeeks: 5.6, accrual:"monthly" });
const m1 = L.entitlementFor({ employee: emp(), scheme: MON, leaveYear: YEAR, asAt:"2026-04-15" });
const m6 = L.entitlementFor({ employee: emp(), scheme: MON, leaveYear: YEAR, asAt:"2026-09-15" });
const m12 = L.entitlementFor({ employee: emp(), scheme: MON, leaveYear: YEAR, asAt:"2027-03-15" });
ok("one month gives roughly a twelfth", Math.abs(m1.baseDays - 28/12) < 0.5);
ok("six months gives roughly half", Math.abs(m6.baseDays - 14) < 0.5);
eq("twelve months gives the lot", m12.baseDays, 28);
ok("and it increases through the year", m1.baseDays < m6.baseDays && m6.baseDays < m12.baseDays);

console.log("\n--- carry-over is capped ---");
const CARRY = L.makeLeaveScheme({ id:"C", name:"With carry-over",
  entitlementWeeks: 5.6, carryOverMaxDays: 5, carryOverExpiresAfterMonths: 3 });
let co = L.carryOverFor({ scheme: CARRY, employee: emp(),
  previousBalance: { availableHours: 22.5 }, leaveYear: YEAR });
eq("three days carried in full", co.hours, 22.5);
ok("not capped", !co.capped);
co = L.carryOverFor({ scheme: CARRY, employee: emp(),
  previousBalance: { availableHours: 75 }, leaveYear: YEAR });
eq("ten days is capped at five", co.hours, 37.5);
ok("flagged as capped", co.capped);
eq("and the rest is forfeited", co.forfeited, 37.5);
eq("expiring three months into the year", co.expiresOn, "2026-07-01");

console.log("\n--- a scheme with no carry-over carries nothing ---");
eq("nothing carried", L.carryOverFor({ scheme: STD, employee: emp(),
  previousBalance: { availableHours: 40 }, leaveYear: YEAR }).hours, 0);

console.log("\n--- balances ---");
const requests = [
  { id:"R1", employeeId:"E1", schemeId:"AL", from:"2026-05-04", to:"2026-05-08", hours:37.5, status:"approved" },
  { id:"R2", employeeId:"E1", schemeId:"AL", from:"2026-12-21", to:"2026-12-24", hours:30,   status:"approved" },
  { id:"R3", employeeId:"E1", schemeId:"AL", from:"2027-02-01", to:"2027-02-02", hours:15,   status:"pending" }
];
let b = L.balanceFor({ employee: emp(), scheme: STD, leaveYear: YEAR, requests, asAt:"2026-08-28" });
eq("a week taken", b.takenHours, 37.5);
eq("four days booked ahead", b.bookedHours, 30);
eq("two days awaiting approval", b.pendingHours, 15);
eq("leaving 127.5 hours", b.availableHours, 127.5);
eq("which is 17 days", b.availableDays, 17);

console.log("\n--- carried hours are used FIRST, so they are not lost ---");
b = L.balanceFor({ employee: emp(), scheme: CARRY, leaveYear: YEAR,
  requests: requests.map(r => ({ ...r, schemeId:"C" })),
  carriedIn: { hours: 22.5, expiresOn:"2026-07-01" }, asAt:"2026-08-28" });
eq("all the carried hours were consumed", b.carriedRemainingHours, 0);
eq("nothing expired unused", b.carriedExpiredHours, 0);
ok("and the total included them", b.totalHours === 232.5);

console.log("\n--- but unused carry-over does expire ---");
b = L.balanceFor({ employee: emp(), scheme: CARRY, leaveYear: YEAR,
  requests: [], carriedIn: { hours: 22.5, expiresOn:"2026-07-01" }, asAt:"2026-08-28" });
eq("nothing was taken", b.takenHours, 0);
eq("so all of it expired", b.carriedExpiredHours, 22.5);
eq("and it is no longer available", b.availableHours, 210);

console.log("\n--- several schemes at once, which is the point ---");
const SCHEMES = [STD, VOL, L.makeLeaveScheme({ id:"UNP", name:"Unpaid", entitlementDays:0, paid:false })];
const memberships = [
  { employeeId:"E1", schemeId:"AL" },
  { employeeId:"E1", schemeId:"VOL" },
  { employeeId:"E1", schemeId:"UNP" }
];
const all = L.allBalancesFor({ employee: emp(), schemes: SCHEMES, memberships,
  leaveYear: YEAR, requests, asAt:"2026-08-28" });
eq("three balances", all.length, 3);
eq("annual leave", all[0].scheme.name, "Annual leave");
eq("volunteering has two days", all[1].entitlement.baseDays, 2);
ok("unpaid leave is marked unpaid", all[2].scheme.paid === false);
ok("volunteering is untouched by annual leave requests", all[1].takenHours === 0);

console.log("\n--- validating a request ---");
let v = L.validateRequest({ employee: emp(), scheme: STD,
  request: { from:"2026-09-01", to:"2026-09-04", hours:30 },
  balance: { availableHours: 127.5 }, existingRequests: requests, asAt:"2026-08-01" });
ok("a reasonable request is fine", v.valid);

v = L.validateRequest({ employee: emp(), scheme: STD,
  request: { from:"2026-09-01", to:"2026-09-04", hours:200 },
  balance: { availableHours: 127.5 }, existingRequests: [], asAt:"2026-08-01" });
ok("more than the balance is refused", !v.valid);
ok("saying how much remains", v.problems[0].includes("127.50"));

v = L.validateRequest({ employee: emp(), scheme: STD,
  request: { from:"2026-05-06", to:"2026-05-07", hours:15 },
  balance: { availableHours: 127.5 }, existingRequests: requests, asAt:"2026-04-01" });
ok("overlapping existing leave is refused", !v.valid);
ok("naming the clash", v.problems.some(p => p.includes("overlaps")));

const NOTICE = L.makeLeaveScheme({ id:"N", name:"Needs notice",
  entitlementWeeks:5.6, minimumNoticeDays: 14 });
v = L.validateRequest({ employee: emp(), scheme: NOTICE,
  request: { from:"2026-08-05", to:"2026-08-06", hours:15 },
  balance: { availableHours: 200 }, existingRequests: [], asAt:"2026-08-01" });
ok("too little notice is refused", !v.valid);
ok("saying how much was needed", v.problems[0].includes("14"));

const MAXC = L.makeLeaveScheme({ id:"M", name:"Capped run",
  entitlementWeeks:5.6, maxConsecutiveDays: 10 });
v = L.validateRequest({ employee: emp(), scheme: MAXC,
  request: { from:"2026-09-01", to:"2026-09-30", hours:150 },
  balance: { availableHours: 200 }, existingRequests: [], asAt:"2026-08-01" });
ok("too long a run is refused", !v.valid);

v = L.validateRequest({ employee: emp(), scheme: STD,
  request: { from:"2026-09-10", to:"2026-09-01", hours:15 },
  balance: { availableHours: 200 }, existingRequests: [], asAt:"2026-08-01" });
ok("dates the wrong way round are refused", !v.valid);

console.log("\n--- exceptions ---");
const employees = [emp({ id:"E1", name:"Marcus Bexley" })];
let exs = L.leaveExceptions({ employees, schemes:[MEAN],
  memberships:[{ employeeId:"E1", schemeId:"BAD" }],
  requests: [], leaveYear: YEAR, asAt:"2026-08-28" });
const below = exs.find(x => x.title.includes("below the statutory"));
ok("an unlawful entitlement is raised", !!below);
eq("as high severity", below.severity, "high");
ok("naming the person", below.subject === "Marcus Bexley");
ok("and saying it is unlawful", below.action.includes("unlawful"));

exs = L.leaveExceptions({ employees, schemes:[CARRY],
  memberships:[{ employeeId:"E1", schemeId:"C" }], requests: [], leaveYear: YEAR,
  carriedIn:{ E1: { C: { hours: 22.5, expiresOn:"2026-09-15" } } }, asAt:"2026-08-28" });
const expiring = exs.find(x => x.title.includes("about to expire"));
ok("expiring carry-over is raised", !!expiring);
ok("with the date", expiring.detail.includes("2026-09-15"));
ok("and an action", expiring.action.includes("before it is lost"));

exs = L.leaveExceptions({ employees, schemes:[STD],
  memberships:[{ employeeId:"E1", schemeId:"AL" }],
  requests: [{ id:"X", employeeId:"E1", schemeId:"AL",
               from:"2026-06-01", to:"2026-12-01", hours:300, status:"approved" }],
  leaveYear: YEAR, asAt:"2026-08-28" });
ok("over-booking is raised", exs.some(x => x.title.includes("More leave booked")));

console.log("\n--- team clashes ---");
const team = [emp({ id:"A", name:"Ann",  department:"Operations" }),
              emp({ id:"B", name:"Ben",  department:"Operations" }),
              emp({ id:"C", name:"Cara", department:"Finance" })];
const clashes = L.teamClashes({
  employees: team, from:"2026-08-03", to:"2026-08-07",
  requests: [
    { employeeId:"A", from:"2026-08-03", to:"2026-08-07", hours:37.5, status:"approved" },
    { employeeId:"B", from:"2026-08-04", to:"2026-08-06", hours:22.5, status:"approved" },
    { employeeId:"C", from:"2026-08-05", to:"2026-08-05", hours:7.5,  status:"approved" }
  ]});
eq("one team has a clash", clashes.length, 1);
eq("Operations", clashes[0].team, "Operations");
eq("two people", clashes[0].count, 2);
ok("named", clashes[0].people.includes("Ann") && clashes[0].people.includes("Ben"));
ok("a single person in Finance is not a clash", !clashes.some(c => c.team === "Finance"));

console.log("\n--- 46 schemes is not a problem ---");
const many = [];
for(let i = 1; i <= 46; i++){
  many.push(L.makeLeaveScheme({
    id:"S" + i, name:"Scheme " + i,
    entitlementDays: 20 + (i % 12),
    countsTowardStatutory: i % 4 === 0,
    carryOverMaxDays: i % 3,
    paid: i % 7 !== 0
  }));
}
const memberAll = many.map(s => ({ employeeId:"E1", schemeId: s.id }));
const balances = L.allBalancesFor({ employee: emp(), schemes: many, memberships: memberAll,
  leaveYear: YEAR, requests: [], asAt:"2026-08-28" });
eq("all 46 produce a balance", balances.length, 46);
ok("each with its own entitlement",
   new Set(balances.map(b => b.entitlement.baseDays)).size > 1);
ok("some paid, some not", balances.some(b => b.scheme.paid) && balances.some(b => !b.scheme.paid));
const exs46 = L.leaveExceptions({ employees, schemes: many, memberships: memberAll,
  requests: [], leaveYear: YEAR, asAt:"2026-08-28" });
ok("only the ones that count toward statutory are checked against it",
   exs46.filter(x => x.title.includes("below the statutory")).length <
   many.filter(s => s.countsTowardStatutory).length + 1);

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
process.exit(fail ? 1 : 0);
