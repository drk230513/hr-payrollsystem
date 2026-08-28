/* ============================================================================
   OCCUPATIONAL ABSENCE
   ----------------------------------------------------------------------------
   Company sick pay and enhanced family leave, on top of the statutory minimum.

   The shape of a typical scheme:

       under 1 year      4 weeks full pay,  4 weeks half pay
       1 to 2 years      8 weeks full,      8 weeks half
       2 to 5 years     13 weeks full,     13 weeks half
       5 years plus     26 weeks full,     26 weeks half

   Four things make this harder than it looks, and each is a place where
   systems get it wrong:

   1. ENTITLEMENT IS CONSUMED, NOT RESET. It is measured over a rolling window
      — usually the twelve months preceding the first day of the current
      absence. Someone off for six weeks in March has less available in
      October. Calculating from the start of the leave year instead is a
      common and expensive error.

   2. SERVICE IS MEASURED AT THE START OF THE ABSENCE, not today. Someone who
      passes five years' service mid-absence does not move up a band partway
      through.

   3. OCCUPATIONAL PAY IS INCLUSIVE OF STATUTORY, NOT ON TOP. Full pay means
      normal pay, of which SSP forms part. Paying both is an overpayment, and
      it is the single most common occupational sick pay mistake.

   4. THE WINDOW IS IN DAYS, THE ENTITLEMENT IN WEEKS, AND THE PAY IN HOURS.
      Part-time and irregular-hours staff need the conversion done properly
      rather than assuming a five-day week.
   ========================================================================== */

var p2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
var DAY = 86400000;

var d = s => (s instanceof Date ? s : new Date(String(s) + "T00:00:00Z"));
var iso = x => d(x).toISOString().slice(0, 10);
var addDays = (s, n) => iso(new Date(d(s).getTime() + n * DAY));
var daysBetween = (a, b) => Math.round((d(b) - d(a)) / DAY);

/* ---------- scheme definition ------------------------------------------
   Bands are ordered by service. A scheme with no bands is unpaid, which is
   legitimate — some absence types are recorded but not paid.
------------------------------------------------------------------------ */
function makeScheme({ id, name, kind = "sickness", bands = [],
                      windowMonths = 12, windowType = "rolling",
                      offsetStatutory = true, waitingDays = 0,
                      requiresCertificate = null, includesStatutory = true }){
  return {
    id, name, kind,
    bands: [...bands].sort((a, b) => a.fromMonths - b.fromMonths),
    windowMonths, windowType,
    // Whether statutory pay counts towards the occupational figure rather
    // than being paid in addition. Almost always true.
    offsetStatutory, includesStatutory,
    waitingDays,
    requiresCertificate
  };
}

/* A few realistic starting points. Every organisation writes its own, so
   these are examples rather than defaults to rely on. */
var EXAMPLE_SCHEMES = [
  makeScheme({
    id: "OSP-STD", name: "Occupational sick pay — standard", kind: "sickness",
    bands: [
      { fromMonths: 0,  fullWeeks: 4,  halfWeeks: 4,  label: "under 1 year" },
      { fromMonths: 12, fullWeeks: 8,  halfWeeks: 8,  label: "1 to 2 years" },
      { fromMonths: 24, fullWeeks: 13, halfWeeks: 13, label: "2 to 5 years" },
      { fromMonths: 60, fullWeeks: 26, halfWeeks: 26, label: "5 years or more" }
    ]
  }),
  makeScheme({
    id: "OMP-ENH", name: "Enhanced maternity pay", kind: "maternity",
    bands: [
      { fromMonths: 0,  fullWeeks: 0,  halfWeeks: 0,  label: "under 1 year — statutory only" },
      { fromMonths: 12, fullWeeks: 8,  halfWeeks: 18, label: "1 year or more" }
    ],
    windowMonths: 0, windowType: "perOccurrence"
  }),
  makeScheme({
    id: "OPP-ENH", name: "Enhanced paternity pay", kind: "paternity",
    bands: [{ fromMonths: 0, fullWeeks: 2, halfWeeks: 0, label: "all employees" }],
    windowMonths: 0, windowType: "perOccurrence"
  })
];

/* ---------- service ------------------------------------------------------ */
function serviceMonthsAt(startedOn, atDate){
  if(!startedOn) return 0;
  const s = d(startedOn), a = d(atDate);
  if(a < s) return 0;
  let months = (a.getUTCFullYear() - s.getUTCFullYear()) * 12
             + (a.getUTCMonth() - s.getUTCMonth());
  if(a.getUTCDate() < s.getUTCDate()) months--;
  return Math.max(0, months);
}

/* Service is fixed at the first day of the absence. Someone crossing a
   service threshold mid-absence stays in the band they started in. */
function bandFor(scheme, startedOn, absenceStart){
  const months = serviceMonthsAt(startedOn, absenceStart);
  let chosen = null;
  for(const b of scheme.bands){
    if(months >= b.fromMonths) chosen = b;
  }
  return chosen ? { ...chosen, serviceMonths: months }
                : { fullWeeks: 0, halfWeeks: 0, label: "no entitlement", serviceMonths: months };
}

/* ---------- the rolling window ------------------------------------------
   Everything already taken inside the window counts against entitlement.
   Only the portion of a prior absence that FALLS INSIDE the window counts —
   an absence straddling the boundary is apportioned, not counted whole.
------------------------------------------------------------------------ */
function windowFor(scheme, absenceStart){
  if(scheme.windowType === "perOccurrence" || !scheme.windowMonths){
    return null;                       // each occurrence stands alone
  }
  const start = d(absenceStart);
  const from = new Date(start);
  if(scheme.windowType === "rolling"){
    from.setUTCMonth(from.getUTCMonth() - scheme.windowMonths);
  } else {
    // fixed leave year: back to the most recent anniversary
    from.setUTCMonth(from.getUTCMonth() - scheme.windowMonths);
  }
  return { from: iso(from), to: iso(addDays(absenceStart, -1)) };
}

function consumedInWindow(history, window, schemeId){
  if(!window) return { fullDays: 0, halfDays: 0, occurrences: 0 };
  let fullDays = 0, halfDays = 0, occurrences = 0;

  for(const a of history || []){
    if(a.schemeId !== schemeId) continue;
    const overlapFrom = d(a.from) > d(window.from) ? a.from : window.from;
    const overlapTo   = d(a.to)   < d(window.to)   ? a.to   : window.to;
    if(d(overlapFrom) > d(overlapTo)) continue;

    // Apportion an absence that straddles the window boundary.
    const totalDays = daysBetween(a.from, a.to) + 1;
    const inWindow  = daysBetween(overlapFrom, overlapTo) + 1;
    const share = totalDays > 0 ? inWindow / totalDays : 0;

    fullDays += (a.fullPaidDays || 0) * share;
    halfDays += (a.halfPaidDays || 0) * share;
    occurrences++;
  }
  return { fullDays: p2(fullDays), halfDays: p2(halfDays), occurrences };
}

/* ---------- entitlement -------------------------------------------------- */
function entitlementFor({ employee, scheme, absenceStart, history }){
  const band = bandFor(scheme, employee.startedOn || employee.startDate, absenceStart);
  const perWeek = Number(employee.daysPerWeek || 5);

  const fullDaysEntitled = p2(band.fullWeeks * perWeek);
  const halfDaysEntitled = p2(band.halfWeeks * perWeek);

  const window = windowFor(scheme, absenceStart);
  const used = consumedInWindow(history, window, scheme.id);

  return {
    band, window,
    perWeek,
    fullDaysEntitled, halfDaysEntitled,
    fullDaysUsed: used.fullDays, halfDaysUsed: used.halfDays,
    fullDaysRemaining: p2(Math.max(0, fullDaysEntitled - used.fullDays)),
    halfDaysRemaining: p2(Math.max(0, halfDaysEntitled - used.halfDays)),
    priorOccurrences: used.occurrences,
    exhausted: (fullDaysEntitled - used.fullDays) <= 0 && (halfDaysEntitled - used.halfDays) <= 0
  };
}

/* ---------- working out one absence -------------------------------------
   Days are allocated full pay first, then half pay, then nil. Waiting days
   come off the front and are unpaid occupationally, though SSP may still
   apply once its own waiting days are served.
------------------------------------------------------------------------ */
function assessAbsence({ employee, scheme, absence, history, statutoryPaid = 0, dailyRate }){
  const ent = entitlementFor({ employee, scheme, absenceStart: absence.from, history });

  const workingDays = absence.workingDays != null
    ? Number(absence.workingDays)
    : countWorkingDays(absence.from, absence.to, employee);

  let remaining = workingDays;
  const waiting = Math.min(scheme.waitingDays || 0, remaining);
  remaining -= waiting;

  const atFull = Math.min(remaining, ent.fullDaysRemaining);
  remaining -= atFull;
  const atHalf = Math.min(remaining, ent.halfDaysRemaining);
  remaining -= atHalf;
  const unpaid = remaining;

  const rate = dailyRate != null ? Number(dailyRate) : dailyRateFor(employee);
  const grossOccupational = p2(atFull * rate + atHalf * rate * 0.5);

  /* Occupational pay is inclusive of statutory. Paying full pay AND SSP on
     top is an overpayment, and it is the mistake this offset exists to
     prevent. The employee receives the higher of the two, never the sum. */
  const offset = scheme.offsetStatutory ? Math.min(statutoryPaid, grossOccupational) : 0;
  const occupationalTopUp = p2(grossOccupational - offset);

  return {
    workingDays, waitingDays: waiting,
    daysAtFullPay: p2(atFull), daysAtHalfPay: p2(atHalf), daysUnpaid: p2(unpaid),
    dailyRate: p2(rate),
    grossOccupational,
    statutoryPaid: p2(statutoryPaid),
    statutoryOffset: p2(offset),
    occupationalTopUp,
    totalPayable: p2(occupationalTopUp + statutoryPaid),
    entitlement: ent,
    exhaustedDuring: unpaid > 0,
    band: ent.band.label
  };
}

/* A working day is one the employee would have worked. Absence on a
   non-working day costs nothing and must not consume entitlement. */
function countWorkingDays(from, to, employee){
  const pattern = employee.workingPattern;
  let count = 0;
  for(let i = 0; i <= daysBetween(from, to); i++){
    const day = d(addDays(from, i));
    const dow = day.getUTCDay();                       // 0 Sunday
    if(pattern && Array.isArray(pattern.days)){
      if(pattern.days[dow] > 0) count++;
    } else {
      const perWeek = Number(employee.daysPerWeek || 5);
      if(perWeek >= 5 ? (dow >= 1 && dow <= 5) : (dow >= 1 && dow <= perWeek)) count++;
    }
  }
  return count;
}

function dailyRateFor(employee){
  const annual = Number(employee.annualSalary || 0);
  const perWeek = Number(employee.daysPerWeek || 5);
  if(annual > 0) return annual / 52 / perWeek;
  const hourly = Number(employee.hourlyRate || 0);
  const weeklyHours = Number(employee.weeklyHours || 0);
  if(hourly > 0 && weeklyHours > 0) return hourly * (weeklyHours / perWeek);
  return 0;
}

/* ---------- looking ahead -----------------------------------------------
   When entitlement will run out. A manager finding out on the day is a
   surprise; four weeks' notice is a conversation.
------------------------------------------------------------------------ */
function projectExhaustion({ employee, scheme, absence, history, asAt }){
  const ent = entitlementFor({ employee, scheme, absenceStart: absence.from, history });
  const elapsed = countWorkingDays(absence.from, asAt || absence.to, employee);

  const fullLeft = Math.max(0, ent.fullDaysRemaining - elapsed);
  const halfLeft = fullLeft > 0
    ? ent.halfDaysRemaining
    : Math.max(0, ent.halfDaysRemaining - (elapsed - ent.fullDaysRemaining));

  const perWeek = Number(employee.daysPerWeek || 5);
  const dayToDate = n => addDays(asAt || absence.to, Math.ceil(n / perWeek * 7));

  return {
    daysAtFullPayRemaining: p2(fullLeft),
    daysAtHalfPayRemaining: p2(halfLeft),
    fullPayEndsOn: fullLeft > 0 ? dayToDate(fullLeft) : null,
    halfPayEndsOn: (fullLeft + halfLeft) > 0 ? dayToDate(fullLeft + halfLeft) : null,
    alreadyUnpaid: fullLeft <= 0 && halfLeft <= 0
  };
}

/* ---------- Bradford Factor ---------------------------------------------
   S² x D, where S is the number of separate spells and D the total days.
   Weights frequent short absences over one long one. Widely used as a
   trigger for a conversation, and widely misused as a disciplinary
   threshold — it is reported here, not acted upon.
------------------------------------------------------------------------ */
function bradfordFactor(history, { from, to, kind = "sickness" } = {}){
  const spells = (history || []).filter(a =>
    (!kind || a.kind === kind) &&
    (!from || d(a.to) >= d(from)) &&
    (!to || d(a.from) <= d(to)));
  const S = spells.length;
  const D = spells.reduce((sum, a) => sum + (a.workingDays || 0), 0);
  return { spells: S, days: D, score: S * S * D };
}

/* ---------- exceptions ---------------------------------------------------
   Surfaced in the payroll run alongside every other check.
------------------------------------------------------------------------ */
function absenceExceptions({ employees, schemes, absences, period, config }){
  const out = [];
  const schemeBy = Object.fromEntries((schemes || []).map(s => [s.id, s]));
  let n = 0;
  const ref = () => "ABS-" + String(++n).padStart(2, "0");

  for(const a of absences || []){
    const e = (employees || []).find(x => x.id === a.employeeId);
    if(!e) continue;
    const scheme = schemeBy[a.schemeId];
    if(!scheme) continue;
    if(period && d(a.from) > d(period.end)) continue;

    const assessed = assessAbsence({
      employee: e, scheme, absence: a,
      history: (absences || []).filter(x => x.employeeId === a.employeeId && x.id !== a.id),
      statutoryPaid: a.statutoryPaid || 0
    });

    if(assessed.daysUnpaid > 0){
      out.push({
        ref: ref(), severity: "high", kind: "absence",
        title: "Occupational sick pay has run out",
        subject: e.name,
        detail: e.name + " has used all " + assessed.entitlement.fullDaysEntitled +
                " days at full pay and " + assessed.entitlement.halfDaysEntitled +
                " at half pay in the rolling window. " + assessed.daysUnpaid +
                " day(s) in this absence are unpaid.",
        amount: 0,
        evidence: [
          "Band: " + assessed.band,
          "Used: " + assessed.entitlement.fullDaysUsed + " full, " +
                     assessed.entitlement.halfDaysUsed + " half",
          "This absence: " + assessed.workingDays + " working days"
        ],
        action: "Confirm the employee has been told before the payslip reaches them."
      });
    }

    if(assessed.daysAtHalfPay > 0 && assessed.daysAtFullPay > 0){
      out.push({
        ref: ref(), severity: "medium", kind: "absence",
        title: "Pay drops to half rate during this absence",
        subject: e.name,
        detail: e.name + " moves from full to half pay part-way through this absence: " +
                assessed.daysAtFullPay + " day(s) at full, " + assessed.daysAtHalfPay + " at half.",
        amount: assessed.grossOccupational,
        evidence: ["Band: " + assessed.band, "Daily rate: " + assessed.dailyRate.toFixed(2)],
        action: "Check the employee has been notified of the change."
      });
    }

    /* Fires when the scheme does NOT offset, because that is the case where
       the employee receives occupational pay AND statutory pay. Almost every
       real scheme is inclusive, so a non-offsetting one is usually a
       misconfiguration rather than a deliberate choice. */
    if(!scheme.offsetStatutory && assessed.statutoryPaid > 0
       && assessed.grossOccupational > 0){
      out.push({
        ref: ref(), severity: "high", kind: "absence",
        title: "Statutory pay may be paid on top of occupational pay",
        subject: e.name,
        detail: "Occupational pay is normally inclusive of statutory pay. Paying both produces " +
                "an overpayment that has to be recovered from the employee.",
        amount: assessed.statutoryPaid,
        evidence: ["Occupational: " + assessed.grossOccupational.toFixed(2),
                   "Statutory: " + assessed.statutoryPaid.toFixed(2)],
        action: "Confirm the scheme genuinely pays statutory in addition."
      });
    }
  }
  return out;
}

module.exports = {
  makeScheme, EXAMPLE_SCHEMES,
  serviceMonthsAt, bandFor, windowFor, consumedInWindow,
  entitlementFor, assessAbsence, projectExhaustion,
  countWorkingDays, dailyRateFor, bradfordFactor, absenceExceptions,
  p2, iso, addDays, daysBetween
};
