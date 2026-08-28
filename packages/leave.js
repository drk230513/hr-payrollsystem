/* ============================================================================
   LEAVE SCHEMES
   ----------------------------------------------------------------------------
   Named, assignable schemes rather than one entitlement per person. A large
   employer typically runs dozens: annual leave for each contract type, TOIL,
   volunteering days, study leave, jury service, unpaid leave, long service
   awards, and a handful of local arrangements nobody quite remembers agreeing.

   Everything is held in HOURS. Days are a display convenience. A person on
   43.75 hours over five days and one on 35 hours over five days both take "a
   day", and it costs them different amounts — holding days and converting at
   the end is how part-time staff end up short-changed.

   Four rules that are easy to get wrong:

   1. THE STATUTORY MINIMUM IS 5.6 WEEKS, CAPPED AT 28 DAYS. Not 28 days for
      everyone. Someone working three days a week is entitled to 16.8 days,
      and the 28-day cap never comes into play for them.

   2. IRREGULAR HOURS AND PART-YEAR WORKERS ACCRUE 12.07% of hours worked,
      following Harpur Trust v Brazel and the 2024 reforms. Giving them a
      fixed annual figure is the error that case was about.

   3. CARRY-OVER EXPIRES. Days brought forward that are not used by the
      expiry date are lost, and they are consumed BEFORE the current year's
      entitlement — otherwise the employee loses days they need not have.

   4. A SCHEME BELOW THE STATUTORY MINIMUM IS UNLAWFUL for annual leave.
      Flagged rather than silently accepted.
   ========================================================================== */

const p2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const DAY = 86400000;
const d = s => (s instanceof Date ? s : new Date(String(s) + "T00:00:00Z"));
const iso = x => d(x).toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(d(s).getTime() + n * DAY));
const daysBetween = (a, b) => Math.round((d(b) - d(a)) / DAY);

const STATUTORY_WEEKS = 5.6;
const STATUTORY_DAY_CAP = 28;
const IRREGULAR_ACCRUAL_RATE = 0.1207;   // 12.07%

/* ---------- defining a scheme ------------------------------------------- */
function makeLeaveScheme({
  id, name, kind = "annual",
  entitlementWeeks = null,        // preferred: weeks, converted per person
  entitlementDays = null,         // or a flat number of days
  accrual = "upfront",            // upfront | monthly | irregularHours
  bankHolidaysIncluded = true,    // are bank holidays part of the entitlement
  bankHolidayDays = 8,
  paid = true,
  countsTowardStatutory = true,   // does it satisfy the 5.6 week minimum
  carryOverMaxDays = 0,
  carryOverExpiresAfterMonths = 3,
  serviceIncrements = [],         // [{ afterMonths, extraDays }]
  proRataForPartYear = true,
  requiresApproval = true,
  minimumNoticeDays = 0,
  maxConsecutiveDays = null,
  allowNegativeBalance = false
}){
  return {
    id, name, kind,
    entitlementWeeks, entitlementDays, accrual,
    bankHolidaysIncluded, bankHolidayDays,
    paid, countsTowardStatutory,
    carryOverMaxDays, carryOverExpiresAfterMonths,
    serviceIncrements: [...serviceIncrements].sort((a,b) => a.afterMonths - b.afterMonths),
    proRataForPartYear, requiresApproval,
    minimumNoticeDays, maxConsecutiveDays, allowNegativeBalance
  };
}

/* Examples only. Every employer writes its own, and a group commonly has one
   per contract type plus a long tail of local arrangements. */
const EXAMPLE_SCHEMES = [
  makeLeaveScheme({
    id:"AL-STD", name:"Annual leave — standard", kind:"annual",
    entitlementWeeks: 5.6, bankHolidaysIncluded: true,
    carryOverMaxDays: 5, carryOverExpiresAfterMonths: 3,
    serviceIncrements: [{ afterMonths: 60, extraDays: 1 }, { afterMonths: 120, extraDays: 2 }]
  }),
  makeLeaveScheme({
    id:"AL-ENH", name:"Annual leave — enhanced", kind:"annual",
    entitlementDays: 30, bankHolidaysIncluded: false, bankHolidayDays: 8,
    carryOverMaxDays: 5
  }),
  makeLeaveScheme({
    id:"AL-CAS", name:"Annual leave — casual and irregular hours", kind:"annual",
    accrual: "irregularHours", bankHolidaysIncluded: true, carryOverMaxDays: 0
  }),
  makeLeaveScheme({
    id:"VOL", name:"Volunteering days", kind:"other",
    entitlementDays: 2, countsTowardStatutory: false, carryOverMaxDays: 0
  }),
  makeLeaveScheme({
    id:"TOIL", name:"Time off in lieu", kind:"toil",
    entitlementDays: 0, countsTowardStatutory: false,
    carryOverMaxDays: 0, allowNegativeBalance: false
  }),
  makeLeaveScheme({
    id:"UNP", name:"Unpaid leave", kind:"unpaid",
    entitlementDays: 0, paid: false, countsTowardStatutory: false
  }),
  makeLeaveScheme({
    id:"JURY", name:"Jury service", kind:"statutory_other",
    entitlementDays: 0, paid: true, countsTowardStatutory: false,
    requiresApproval: false
  })
];

/* ---------- the statutory floor ------------------------------------------
   5.6 weeks, capped at 28 days. The cap only bites at five days a week or
   more, which is why applying "28 days" to everyone is wrong.
------------------------------------------------------------------------ */
function statutoryMinimumDays(daysPerWeek){
  return Math.min(STATUTORY_DAY_CAP, p2(Number(daysPerWeek || 5) * STATUTORY_WEEKS));
}

function hoursPerDay(employee){
  const wh = Number(employee.weeklyHours || 37.5);
  const dpw = Number(employee.daysPerWeek || 5);
  return dpw > 0 ? wh / dpw : 0;
}

function serviceMonthsAt(startedOn, atDate){
  if(!startedOn) return 0;
  const s = d(startedOn), a = d(atDate);
  if(a < s) return 0;
  let m = (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth());
  if(a.getUTCDate() < s.getUTCDate()) m--;
  return Math.max(0, m);
}

/* ---------- entitlement --------------------------------------------------- */
function entitlementFor({ employee, scheme, leaveYear, hoursWorkedInYear = 0, asAt }){
  const hpd = hoursPerDay(employee);
  const dpw = Number(employee.daysPerWeek || 5);
  const at = asAt || leaveYear.ends;

  /* Irregular hours and part-year workers accrue as they work. This is the
     Harpur Trust position, and giving them a fixed annual figure instead is
     the specific error that case was about. */
  if(scheme.accrual === "irregularHours"){
    const accruedHours = p2(Number(hoursWorkedInYear) * IRREGULAR_ACCRUAL_RATE);
    return {
      method: "irregularHours",
      baseDays: null,
      hoursPerDay: hpd,
      entitlementHours: accruedHours,
      bankHolidayHours: 0,
      totalHours: accruedHours,
      statutoryMinimumDays: null,
      belowStatutory: false,
      serviceExtraDays: 0,
      proRataFraction: 1,
      note: "Accrued at 12.07% of hours worked"
    };
  }

  // Base entitlement, in days.
  let baseDays = scheme.entitlementDays != null
    ? Number(scheme.entitlementDays)
    : p2(Number(scheme.entitlementWeeks || 0) * dpw);

  // Long service increments, measured at the start of the leave year.
  const months = serviceMonthsAt(employee.startedOn || employee.startDate, leaveYear.starts);
  let extra = 0;
  for(const inc of scheme.serviceIncrements){
    if(months >= inc.afterMonths) extra = Number(inc.extraDays);
  }
  baseDays = p2(baseDays + extra);

  // Pro rata for anyone joining or leaving part-way through the year.
  let fraction = 1;
  if(scheme.proRataForPartYear){
    fraction = partYearFraction(employee, leaveYear);
    baseDays = p2(baseDays * fraction);
  }

  // Accrued monthly rather than available in full from day one. Common in a
  // first year of employment.
  if(scheme.accrual === "monthly"){
    const elapsed = Math.min(12, Math.max(0,
      (d(at).getUTCFullYear() - d(leaveYear.starts).getUTCFullYear()) * 12 +
      (d(at).getUTCMonth() - d(leaveYear.starts).getUTCMonth()) + 1));
    baseDays = p2(baseDays * (elapsed / 12));
  }

  const bankDays = scheme.bankHolidaysIncluded ? 0 : p2(scheme.bankHolidayDays * fraction);
  const entitlementHours = p2(baseDays * hpd);
  const bankHolidayHours = p2(bankDays * hpd);

  const statMin = statutoryMinimumDays(dpw);
  const totalForStatutory = baseDays + bankDays;

  return {
    method: scheme.accrual,
    baseDays, hoursPerDay: hpd,
    entitlementHours, bankHolidayHours,
    totalHours: p2(entitlementHours + bankHolidayHours),
    statutoryMinimumDays: statMin,
    // Only annual leave has to meet the floor. A volunteering day scheme
    // offering two days is not unlawful.
    belowStatutory: scheme.countsTowardStatutory && fraction === 1 && totalForStatutory < statMin,
    shortfallDays: scheme.countsTowardStatutory && fraction === 1
      ? p2(Math.max(0, statMin - totalForStatutory)) : 0,
    serviceExtraDays: extra,
    proRataFraction: p2(fraction)
  };
}

function partYearFraction(employee, leaveYear){
  const start = d(leaveYear.starts), end = d(leaveYear.ends);
  const joined = employee.startedOn ? d(employee.startedOn) : start;
  const left = employee.leavingDate ? d(employee.leavingDate) : end;
  const from = joined > start ? joined : start;
  const to = left < end ? left : end;
  if(to < from) return 0;
  const whole = daysBetween(leaveYear.starts, leaveYear.ends) + 1;
  const part = daysBetween(iso(from), iso(to)) + 1;
  return whole > 0 ? Math.min(1, part / whole) : 1;
}

/* ---------- carry-over ----------------------------------------------------
   Capped, and it expires. Carried hours are consumed BEFORE the current
   year's entitlement, or an employee loses days they need not have lost.
------------------------------------------------------------------------ */
function carryOverFor({ scheme, previousBalance, leaveYear, employee }){
  if(!scheme.carryOverMaxDays || !previousBalance) {
    return { hours: 0, expiresOn: null, capped: false };
  }
  const hpd = hoursPerDay(employee);
  const maxHours = p2(scheme.carryOverMaxDays * hpd);
  const unused = Math.max(0, Number(previousBalance.availableHours || 0));
  const hours = p2(Math.min(unused, maxHours));

  const expires = scheme.carryOverExpiresAfterMonths
    ? iso(new Date(d(leaveYear.starts).setUTCMonth(
        d(leaveYear.starts).getUTCMonth() + scheme.carryOverExpiresAfterMonths)))
    : null;

  return { hours, expiresOn: expires, capped: unused > maxHours, forfeited: p2(unused - hours) };
}

/* ---------- balance ------------------------------------------------------- */
function balanceFor({ employee, scheme, leaveYear, requests, carriedIn,
                      hoursWorkedInYear = 0, asAt }){
  const at = asAt || iso(new Date());
  const ent = entitlementFor({ employee, scheme, leaveYear, hoursWorkedInYear, asAt: at });
  const carried = carriedIn || { hours: 0, expiresOn: null };

  const mine = (requests || []).filter(r =>
    r.employeeId === employee.id &&
    r.schemeId === scheme.id &&
    r.status !== "rejected" && r.status !== "cancelled");

  let taken = 0, booked = 0, pending = 0;
  for(const r of mine){
    const hrs = Number(r.hours || 0);
    if(r.status === "pending"){ pending += hrs; continue; }
    if(d(r.to) < d(at)) taken += hrs; else booked += hrs;
  }

  const totalAvailable = p2(ent.totalHours + carried.hours);
  const used = p2(taken + booked + pending);

  // Carried hours are used first, so they are not lost unnecessarily.
  const carriedUsed = p2(Math.min(used, carried.hours));
  const carriedLeft = p2(Math.max(0, carried.hours - carriedUsed));
  const carriedExpired = carried.expiresOn && d(at) > d(carried.expiresOn) ? carriedLeft : 0;

  return {
    scheme: { id: scheme.id, name: scheme.name, paid: scheme.paid, kind: scheme.kind },
    entitlement: ent,
    carriedInHours: carried.hours,
    carriedRemainingHours: carriedLeft,
    carriedExpiresOn: carried.expiresOn,
    carriedExpiredHours: p2(carriedExpired),
    takenHours: p2(taken), bookedHours: p2(booked), pendingHours: p2(pending),
    totalHours: totalAvailable,
    availableHours: p2(totalAvailable - used - carriedExpired),
    hoursPerDay: ent.hoursPerDay,
    availableDays: ent.hoursPerDay > 0
      ? p2((totalAvailable - used - carriedExpired) / ent.hoursPerDay) : 0,
    overdrawn: (totalAvailable - used) < 0
  };
}

/* Everything an employee holds, across every scheme they belong to. */
function allBalancesFor({ employee, schemes, memberships, leaveYear, requests,
                          carriedIn = {}, hoursWorkedInYear = 0, asAt }){
  const mine = (memberships || [])
    .filter(m => m.employeeId === employee.id)
    .map(m => (schemes || []).find(s => s.id === m.schemeId))
    .filter(Boolean);

  return mine.map(scheme => balanceFor({
    employee, scheme, leaveYear, requests,
    carriedIn: carriedIn[scheme.id], hoursWorkedInYear, asAt
  }));
}

/* ---------- validating a request ------------------------------------------ */
function validateRequest({ employee, scheme, request, balance, existingRequests, asAt }){
  const problems = [];
  const at = asAt || iso(new Date());
  const hrs = Number(request.hours || 0);

  if(hrs <= 0) problems.push("no hours were requested");
  if(d(request.to) < d(request.from)) problems.push("the end date is before the start date");

  if(scheme.minimumNoticeDays){
    const notice = daysBetween(at, request.from);
    if(notice < scheme.minimumNoticeDays){
      problems.push(scheme.name + " needs " + scheme.minimumNoticeDays +
        " days' notice; this gives " + Math.max(0, notice));
    }
  }

  if(scheme.maxConsecutiveDays){
    const span = daysBetween(request.from, request.to) + 1;
    if(span > scheme.maxConsecutiveDays){
      problems.push("longer than the " + scheme.maxConsecutiveDays +
        " consecutive days this scheme allows");
    }
  }

  if(balance && !scheme.allowNegativeBalance && hrs > balance.availableHours){
    problems.push("only " + balance.availableHours.toFixed(2) +
      " hours remain, and this asks for " + hrs.toFixed(2));
  }

  // Somebody cannot be on two kinds of leave at once.
  for(const r of existingRequests || []){
    if(r.employeeId !== employee.id) continue;
    if(r.id === request.id) continue;
    if(r.status === "rejected" || r.status === "cancelled") continue;
    if(d(r.from) <= d(request.to) && d(r.to) >= d(request.from)){
      problems.push("overlaps existing leave from " + r.from + " to " + r.to);
    }
  }

  return { valid: problems.length === 0, problems };
}

/* ---------- exceptions ---------------------------------------------------- */
function leaveExceptions({ employees, schemes, memberships, requests, leaveYear,
                           carriedIn = {}, asAt }){
  const out = [];
  const at = asAt || iso(new Date());
  let n = 0;
  const ref = () => "LV-" + String(++n).padStart(2, "0");
  const schemeBy = Object.fromEntries((schemes || []).map(s => [s.id, s]));

  for(const e of employees || []){
    const balances = allBalancesFor({
      employee: e, schemes, memberships, leaveYear, requests,
      carriedIn: carriedIn[e.id] || {}, asAt: at
    });

    for(const b of balances){
      const scheme = schemeBy[b.scheme.id];

      if(b.entitlement.belowStatutory){
        out.push({
          ref: ref(), severity: "high", kind: "leave",
          title: "Leave entitlement is below the statutory minimum",
          subject: e.name,
          detail: e.name + " is on " + b.scheme.name + " with " +
                  b.entitlement.baseDays + " days. The statutory minimum for " +
                  (e.daysPerWeek || 5) + " days a week is " +
                  b.entitlement.statutoryMinimumDays + " days.",
          amount: 0,
          evidence: ["Shortfall: " + b.entitlement.shortfallDays + " days",
                     "5.6 weeks, capped at 28 days"],
          action: "Correct the entitlement. Below the statutory minimum is unlawful."
        });
      }

      if(b.carriedRemainingHours > 0 && b.carriedExpiresOn){
        const daysLeft = daysBetween(at, b.carriedExpiresOn);
        if(daysLeft >= 0 && daysLeft <= 60){
          out.push({
            ref: ref(), severity: daysLeft <= 21 ? "medium" : "low", kind: "leave",
            title: "Carried-over leave is about to expire",
            subject: e.name,
            detail: e.name + " has " + p2(b.carriedRemainingHours / b.hoursPerDay) +
                    " day(s) carried over from last year, expiring on " +
                    b.carriedExpiresOn + " — " + daysLeft + " days away.",
            amount: 0,
            evidence: [b.carriedRemainingHours.toFixed(2) + " hours remaining"],
            action: "Tell the employee before it is lost."
          });
        }
      }

      if(b.carriedExpiredHours > 0){
        out.push({
          ref: ref(), severity: "medium", kind: "leave",
          title: "Carried-over leave has expired unused",
          subject: e.name,
          detail: p2(b.carriedExpiredHours / b.hoursPerDay) + " day(s) expired on " +
                  b.carriedExpiresOn + " without being taken.",
          amount: 0,
          evidence: ["Scheme: " + b.scheme.name],
          action: "Confirm the employee was told in time."
        });
      }

      if(b.overdrawn){
        out.push({
          ref: ref(), severity: "high", kind: "leave",
          title: "More leave booked than the employee has",
          subject: e.name,
          detail: e.name + " has booked " + Math.abs(b.availableHours).toFixed(2) +
                  " hours more " + b.scheme.name + " than they are entitled to.",
          amount: 0,
          evidence: ["Available: " + b.availableHours.toFixed(2) + " hours"],
          action: "Either cancel a booking or agree the excess as unpaid."
        });
      }
    }
  }
  return out;
}

/* ---------- clash checking ------------------------------------------------
   Two people from the same team off at once is a staffing problem, not a
   payroll one, but it is cheaper to see it when the leave is requested.
------------------------------------------------------------------------ */
function teamClashes({ employees, requests, from, to, threshold = 2 }){
  const byTeam = {};
  for(const r of requests || []){
    if(r.status === "rejected" || r.status === "cancelled") continue;
    if(d(r.to) < d(from) || d(r.from) > d(to)) continue;
    const e = (employees || []).find(x => x.id === r.employeeId);
    if(!e) continue;
    const team = e.department || e.costCentre || "Unallocated";
    (byTeam[team] = byTeam[team] || []).push({ employee: e, request: r });
  }
  return Object.entries(byTeam)
    .filter(([, list]) => list.length >= threshold)
    .map(([team, list]) => ({
      team, count: list.length,
      people: list.map(x => x.employee.name),
      dates: list.map(x => x.request.from + " to " + x.request.to)
    }));
}

module.exports = {
  makeLeaveScheme, EXAMPLE_SCHEMES,
  statutoryMinimumDays, hoursPerDay, serviceMonthsAt, partYearFraction,
  entitlementFor, carryOverFor, balanceFor, allBalancesFor,
  validateRequest, leaveExceptions, teamClashes,
  STATUTORY_WEEKS, STATUTORY_DAY_CAP, IRREGULAR_ACCRUAL_RATE,
  p2, iso, addDays, daysBetween
};
