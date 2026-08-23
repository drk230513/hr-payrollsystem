/* ============================================================================
   UK PAYROLL ENGINE — sector neutral
   ----------------------------------------------------------------------------
   Works for private companies, public bodies and charities. Nothing here
   assumes a particular employer type; everything that differs between them
   is configuration.

   Uses the HMRC "exact percentage method", permitted for computerised payroll.

   RATES ARE DEFAULTS AND ARE EDITABLE. Verify against HMRC before live use.
   ========================================================================== */

const p2       = n => Math.round((n + Number.EPSILON) * 100) / 100;
const floor2   = n => Math.floor((n + 1e-9) * 100) / 100;
const floorGBP = n => Math.floor(n + 1e-9);
const clamp    = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/* ---------- pay frequency ------------------------------------------------- */
const PAY_FREQUENCIES = {
  weekly:      { label: "Weekly",       periods: 52 },
  fortnightly: { label: "Fortnightly",  periods: 26 },
  fourWeekly:  { label: "Four-weekly",  periods: 13 },
  monthly:     { label: "Monthly",      periods: 12 },
  quarterly:   { label: "Quarterly",    periods: 4  }
};

/* ---------- pension earnings bases ---------------------------------------
   The single biggest difference between a public-sector scheme and a private
   auto-enrolment scheme. Same percentage, very different money.
     qualifying  - band between lower and upper limits (AE minimum, NEST etc)
     pensionable - only elements marked pensionable (LGPS, TPS, many DB schemes)
     total       - every penny of gross (some generous DC schemes)
     basic       - basic salary only, ignoring overtime and allowances
------------------------------------------------------------------------- */
const PENSION_BASES = {
  qualifying:  "Qualifying earnings (band)",
  pensionable: "Pensionable pay",
  total:       "Total gross pay",
  basic:       "Basic pay only"
};

const PENSION_METHODS = {
  netPay:         "Net pay arrangement",
  salarySac:      "Salary sacrifice",
  reliefAtSource: "Relief at source"
};

const DEFAULT_CONFIG = {
  taxYear: "2026/27",
  payFrequency: "monthly",
  region: "restOfUK",              // restOfUK | scotland

  // Free pay comes from each employee's TAX CODE, not a global setting.
  bands: [
    { name: "Basic rate",      limit: 37700,    rate: 0.20 },
    { name: "Higher rate",     limit: 125140,   rate: 0.40 },
    { name: "Additional rate", limit: Infinity, rate: 0.45 }
  ],
  scottishBands: [
    { name: "Starter rate",      limit: 2827,     rate: 0.19 },
    { name: "Basic rate",        limit: 14921,    rate: 0.20 },
    { name: "Intermediate rate", limit: 31092,    rate: 0.21 },
    { name: "Higher rate",       limit: 62430,    rate: 0.42 },
    { name: "Advanced rate",     limit: 125140,   rate: 0.45 },
    { name: "Top rate",          limit: Infinity, rate: 0.48 }
  ],

  ni: {
    lel: 6500, pt: 12570, st: 5000, uel: 50270, ust: 50270, aust: 50270,
    employeeMain: 0.08, employeeUpper: 0.02, employeeReduced: 0.0185,
    employerRate: 0.15
  },

  studentLoans: {
    plan1: { threshold: 26065, rate: 0.09 },
    plan2: { threshold: 28470, rate: 0.09 },
    plan4: { threshold: 32745, rate: 0.09 },
    plan5: { threshold: 25000, rate: 0.09 },
    pgl:   { threshold: 21000, rate: 0.06 }
  },

  autoEnrolment: {
    triggerAnnual: 10000,
    qualifyingLower: 6240,
    qualifyingUpper: 50270
  },

  statutory: {
    sspWeekly: 118.75,
    sspWaitingDays: 3,
    sspMaxWeeks: 28,
    smpHigherPct: 0.90,
    smpStandardWeekly: 187.18,
    smpHigherWeeks: 6,
    smpStandardWeeks: 33
  },

  employerReliefs: {
    employmentAllowance: 10500,       // most public bodies are NOT eligible
    apprenticeshipLevyThreshold: 3000000,
    apprenticeshipLevyRate: 0.005,
    smallEmployerNICThreshold: 45000, // for statutory payment recovery
    statutoryRecoveryStandard: 0.92,
    statutoryRecoverySmall: 1.03
  }
};

/* ============================================================================
   TAX CODES
   ========================================================================== */
function parseTaxCode(raw){
  const code = String(raw || "").toUpperCase().replace(/\s+/g,"");
  const out = { raw: code, cumulative: true, kind: "suffix", allowance: 0, fixedRate: null, valid: true, scottish: false, welsh: false };

  const nonCum = /(W1|M1|X)$/.test(code);
  let core = code.replace(/(W1|M1|X)$/,"");
  out.cumulative = !nonCum;

  if(core.startsWith("S")){ out.scottish = true; core = core.slice(1); }
  else if(core.startsWith("C")){ out.welsh = true; core = core.slice(1); }

  if(core === "NT"){ out.kind = "NT"; out.fixedRate = 0; return out; }
  if(core === "BR"){ out.kind = "BR"; out.fixedRate = 0.20; return out; }
  if(core === "D0"){ out.kind = "D0"; out.fixedRate = 0.40; return out; }
  if(core === "D1"){ out.kind = "D1"; out.fixedRate = 0.45; return out; }
  if(core === "D2"){ out.kind = "D2"; out.fixedRate = 0.48; return out; }

  const k = core.match(/^K(\d+)$/);
  if(k){ out.kind = "K"; out.allowance = -((parseInt(k[1],10) * 10) + 9); return out; }

  const s = core.match(/^(\d+)([LMNTY])$/);
  if(s){ out.allowance = (parseInt(s[1],10) * 10) + 9; return out; }

  out.valid = false;
  return out;
}

/* ============================================================================
   PAYE
   ========================================================================== */
function calcPAYE({ taxCode, taxablePayToDate, taxPaidToDate = 0, period, grossThisPeriod, config = DEFAULT_CONFIG }){
  const tc = parseTaxCode(taxCode);
  const n = periodsPerYear(config);
  const prop = tc.cumulative ? (period / n) : (1 / n);
  const bands = (tc.scottish || config.region === "scotland") ? config.scottishBands : config.bands;

  const payToDate = taxablePayToDate;
  const alreadyPaid = tc.cumulative ? taxPaidToDate : 0;

  if(tc.kind === "NT") return { tax: 0, taxDueToDate: 0, breakdown: [], code: tc, refund: false, regulatoryLimitApplied: false };

  let taxDueToDate = 0, breakdown = [];

  if(tc.fixedRate !== null){
    taxDueToDate = floor2(payToDate * tc.fixedRate);
    breakdown = [{ name: tc.kind + " — all pay", amount: p2(payToDate), rate: tc.fixedRate, tax: taxDueToDate }];
  } else {
    const freePay = floor2(tc.allowance * prop);
    let taxable = Math.max(payToDate - freePay, 0);
    let remaining = taxable, lower = 0, total = 0;
    for(const band of bands){
      const cap = band.limit === Infinity ? Infinity : floor2(band.limit * prop);
      const inBand = Math.min(remaining, cap - lower);
      if(inBand > 0){
        total += inBand * band.rate;
        breakdown.push({ name: band.name, amount: p2(inBand), rate: band.rate, tax: floor2(inBand * band.rate) });
        remaining -= inBand;
      }
      lower = cap;
      if(remaining <= 0) break;
    }
    taxDueToDate = floor2(total);
  }

  let tax = p2(taxDueToDate - alreadyPaid);
  const limit = floor2(grossThisPeriod * 0.5);
  let limited = false;
  if(tax > limit){ tax = limit; limited = true; }

  return { tax, taxDueToDate, breakdown, code: tc, refund: tax < 0, regulatoryLimitApplied: limited };
}

/* ============================================================================
   NATIONAL INSURANCE
   Directors are calculated on an ANNUAL cumulative basis, which is a genuine
   legal difference rather than a rounding preference.
   ========================================================================== */
function calcNI({ niablePay, category = "A", config = DEFAULT_CONFIG, director = false, niableToDate = 0, niEmployeePaidToDate = 0, niEmployerPaidToDate = 0 }){
  const n = periodsPerYear(config);
  const c = config.ni;
  const cat = String(category || "A").toUpperCase();

  const scale = director ? 1 : (1 / n);
  const LEL = floor2(c.lel * scale), PT = floor2(c.pt * scale), ST = floor2(c.st * scale);
  const UEL = floor2(c.uel * scale), UST = floor2(c.ust * scale), AUST = floor2(c.aust * scale);

  const pay = director ? p2(niableToDate + niablePay) : niablePay;

  const ptToUel = clamp(pay - PT, 0, UEL - PT);
  const aboveUel = Math.max(pay - UEL, 0);

  let employee = 0, employer = 0;
  if(cat === "X" || cat === "C") employee = 0;
  else if(cat === "B")           employee = ptToUel * c.employeeReduced + aboveUel * c.employeeUpper;
  else                           employee = ptToUel * c.employeeMain + aboveUel * c.employeeUpper;

  if(cat === "X")                       employer = 0;
  else if(cat === "M" || cat === "I")   employer = Math.max(pay - UST, 0) * c.employerRate;
  else if(cat === "H")                  employer = Math.max(pay - AUST, 0) * c.employerRate;
  else                                  employer = Math.max(pay - ST, 0) * c.employerRate;

  if(director){
    employee = p2(employee) - niEmployeePaidToDate;
    employer = p2(employer) - niEmployerPaidToDate;
  }

  return {
    employee: p2(employee), employer: p2(employer), category: cat, director,
    earningsAtLEL:    p2(clamp(niablePay, 0, floor2(c.lel / n))),
    earningsLELtoPT:  p2(clamp(niablePay - floor2(c.lel / n), 0, floor2(c.pt / n) - floor2(c.lel / n))),
    earningsPTtoUEL:  p2(clamp(niablePay - floor2(c.pt / n), 0, floor2(c.uel / n) - floor2(c.pt / n))),
    earningsAboveUEL: p2(Math.max(niablePay - floor2(c.uel / n), 0))
  };
}

/* ============================================================================
   STUDENT LOANS
   ========================================================================== */
function calcStudentLoan({ gross, plan, postgrad = false, config = DEFAULT_CONFIG }){
  const n = periodsPerYear(config);
  let main = 0, pgl = 0;
  if(plan && plan !== "none" && config.studentLoans[plan]){
    const p = config.studentLoans[plan];
    main = floorGBP(Math.max(gross - floor2(p.threshold / n), 0) * p.rate);
  }
  if(postgrad){
    const p = config.studentLoans.pgl;
    pgl = floorGBP(Math.max(gross - floor2(p.threshold / n), 0) * p.rate);
  }
  return { main, pgl, total: main + pgl };
}

/* ============================================================================
   PENSION — scheme driven
   ========================================================================== */
function pensionableEarnings({ gross, pensionablePortion, basicPortion, scheme, config = DEFAULT_CONFIG }){
  const n = periodsPerYear(config);
  switch(scheme.basis){
    case "qualifying": {
      const lo = floor2((scheme.qualifyingLower ?? config.autoEnrolment.qualifyingLower) / n);
      const hi = floor2((scheme.qualifyingUpper ?? config.autoEnrolment.qualifyingUpper) / n);
      return p2(clamp(gross - lo, 0, hi - lo));
    }
    case "pensionable": return p2(pensionablePortion);
    case "basic":       return p2(basicPortion);
    default:            return p2(gross);
  }
}

function calcPension({ gross, pensionablePortion, basicPortion, scheme, config = DEFAULT_CONFIG }){
  if(!scheme || (!scheme.employeeRate && !scheme.employerRate)){
    return { employee: 0, employer: 0, earnings: 0, method: "none", schemeName: "None",
             reducesTaxable: false, reducesNIable: false, basis: null };
  }
  const earnings = pensionableEarnings({ gross, pensionablePortion, basicPortion, scheme, config });
  return {
    employee: p2(earnings * (scheme.employeeRate || 0)),
    employer: p2(earnings * (scheme.employerRate || 0)),
    earnings, method: scheme.method, basis: scheme.basis, schemeName: scheme.name,
    reducesTaxable: scheme.method === "netPay" || scheme.method === "salarySac",
    reducesNIable:  scheme.method === "salarySac"
  };
}

/* ============================================================================
   STATUTORY PAYMENTS  (helpers that generate pay elements)
   ========================================================================== */
function calcSSP({ sickDays, qualifyingDaysPerWeek = 5, waitingDaysAlreadyServed = 0, config = DEFAULT_CONFIG }){
  const s = config.statutory;
  const waiting = Math.max(0, Math.min(s.sspWaitingDays - waitingDaysAlreadyServed, sickDays));
  const payable = Math.max(0, sickDays - waiting);
  const daily = s.sspWeekly / qualifyingDaysPerWeek;
  return { waitingDays: waiting, payableDays: payable, dailyRate: p2(daily), amount: p2(payable * daily) };
}

function calcSMP({ weekNumber, averageWeeklyEarnings, config = DEFAULT_CONFIG }){
  const s = config.statutory;
  if(weekNumber < 1 || weekNumber > s.smpHigherWeeks + s.smpStandardWeeks) return { weekly: 0, stage: "outside" };
  if(weekNumber <= s.smpHigherWeeks){
    return { weekly: p2(averageWeeklyEarnings * s.smpHigherPct), stage: "higher" };
  }
  return { weekly: p2(Math.min(averageWeeklyEarnings * s.smpHigherPct, s.smpStandardWeekly)), stage: "standard" };
}

/* ============================================================================
   FULL PAYSLIP
   ========================================================================== */
function periodsPerYear(config){
  return (PAY_FREQUENCIES[config.payFrequency] || PAY_FREQUENCIES.monthly).periods;
}

function calcPayslip({ employee, period, elements = [], ytd = null, scheme = null, config = DEFAULT_CONFIG }){
  const e = employee;
  const n = periodsPerYear(config);
  const y = ytd || { gross:0, taxable:0, niable:0, tax:0, niEmployee:0, niEmployer:0, pension:0, pensionEr:0, studentLoan:0, net:0 };

  const basic = p2((e.annualSalary || 0) / n);
  const payments = [];
  if(basic > 0) payments.push({ label: "Basic pay", amount: basic, pensionable: true, niable: true, taxable: true, basic: true });

  for(const el of elements){
    payments.push({
      label: el.label, amount: p2(el.amount), hours: el.hours || null, rate: el.rate || null,
      pensionable: el.pensionable !== false, niable: el.niable !== false, taxable: el.taxable !== false, basic: false
    });
  }

  const gross       = p2(payments.reduce((s,x) => s + x.amount, 0));
  const pensionable = p2(payments.filter(x => x.pensionable).reduce((s,x) => s + x.amount, 0));
  const basicOnly   = p2(payments.filter(x => x.basic).reduce((s,x) => s + x.amount, 0));

  const pen = calcPension({ gross, pensionablePortion: pensionable, basicPortion: basicOnly, scheme, config });

  const taxableThis = p2(gross - (pen.reducesTaxable ? pen.employee : 0));
  const niableThis  = p2(gross - (pen.reducesNIable  ? pen.employee : 0));

  const paye = calcPAYE({
    taxCode: e.taxCode, taxablePayToDate: p2(y.taxable + taxableThis),
    taxPaidToDate: y.tax, period, grossThisPeriod: gross, config
  });

  const ni = calcNI({
    niablePay: niableThis, category: e.niCategory, config,
    director: !!e.director, niableToDate: y.niable,
    niEmployeePaidToDate: y.niEmployee, niEmployerPaidToDate: y.niEmployer
  });

  const sl = calcStudentLoan({ gross: niableThis, plan: e.studentLoanPlan, postgrad: !!e.postgradLoan, config });

  const deductions = [];
  if(paye.tax !== 0)   deductions.push({ label: paye.tax < 0 ? "PAYE income tax (refund)" : "PAYE income tax", amount: paye.tax, statutory: true });
  if(ni.employee > 0)  deductions.push({ label: `National Insurance — cat ${ni.category}${ni.director ? " (director)" : ""}`, amount: ni.employee, statutory: true });
  if(pen.employee > 0) deductions.push({ label: `${pen.schemeName} — ${((scheme?.employeeRate||0)*100).toFixed(1)}%`, amount: pen.employee, statutory: false });
  if(sl.main > 0)      deductions.push({ label: `Student loan — ${String(e.studentLoanPlan||"").replace("plan","Plan ")}`, amount: sl.main, statutory: true });
  if(sl.pgl > 0)       deductions.push({ label: "Postgraduate loan", amount: sl.pgl, statutory: true });
  for(const o of (e.otherDeductions || [])) if(o.amount > 0) deductions.push({ label: o.label, amount: p2(o.amount), statutory: false });

  const totalDeductions = p2(deductions.reduce((s,d) => s + d.amount, 0));
  const net = p2(gross - totalDeductions);

  return {
    period, employeeId: e.id, payments, deductions,
    gross, pensionable, taxableThis, niableThis,
    pension: pen, ni, paye, studentLoan: sl,
    totalDeductions, net,
    employerCost: p2(gross + ni.employer + pen.employer),
    ytd: {
      gross: p2(y.gross + gross), taxable: p2(y.taxable + taxableThis), niable: p2(y.niable + niableThis),
      tax: p2(y.tax + paye.tax), niEmployee: p2(y.niEmployee + ni.employee), niEmployer: p2(y.niEmployer + ni.employer),
      pension: p2(y.pension + pen.employee), pensionEr: p2(y.pensionEr + pen.employer),
      studentLoan: p2(y.studentLoan + sl.total), net: p2(y.net + net)
    }
  };
}

/* ============================================================================
   EMPLOYER RELIEFS — applied at run level, not per employee
   ========================================================================== */
function applyEmployerReliefs({ totalEmployerNI, allowanceUsedToDate = 0, org, config = DEFAULT_CONFIG }){
  const r = config.employerReliefs;
  let allowanceClaimed = 0;
  if(org.claimsEmploymentAllowance){
    const remaining = Math.max(0, r.employmentAllowance - allowanceUsedToDate);
    allowanceClaimed = p2(Math.min(remaining, totalEmployerNI));
  }
  return {
    employerNIGross: p2(totalEmployerNI),
    employmentAllowanceClaimed: allowanceClaimed,
    employerNIPayable: p2(totalEmployerNI - allowanceClaimed),
    allowanceRemaining: p2(Math.max(0, r.employmentAllowance - allowanceUsedToDate - allowanceClaimed))
  };
}

/* ============================================================================
   EXCEPTIONS
   ========================================================================== */
function detectExceptions({ payslips, employees, priorPayslips = {}, period, schemes = [], config = DEFAULT_CONFIG }){
  const out = [];
  const byId = Object.fromEntries(employees.map(e => [e.id, e]));
  let n = 0;
  const ref = () => "E-" + String(++n).padStart(2,"0");

  const banks = {};
  employees.filter(e => e.status === "active" && e.bankAccount).forEach(e => {
    const k = (e.bankSort||"") + "|" + e.bankAccount;
    (banks[k] = banks[k] || []).push(e);
  });
  Object.values(banks).filter(g => g.length > 1).forEach(g => out.push({
    ref: ref(), severity: "high", kind: "model",
    title: "Two or more employees share the same bank account",
    subject: g.map(e => e.name).join(" / "), employeeIds: g.map(e => e.id),
    amount: p2(g.reduce((s,e) => s + (payslips.find(p => p.employeeId === e.id)?.net || 0), 0)),
    why: "These records pay to an identical sort code and account number. Often legitimate — a joint account held by two employed family members — but it is also the clearest signature of a duplicate record or a diverted payment.",
    evidence: g.map(e => [e.name, (e.bankSort||"??-??-??") + " / ····" + String(e.bankAccount).slice(-4)]),
    action: "Confirm the individuals are distinct before release. Differing NI numbers support that they are."
  }));

  employees.forEach(e => {
    if(!e.leavingDate) return;
    const ps = payslips.find(p => p.employeeId === e.id);
    if(ps && new Date(e.leavingDate) < new Date(period.start)) out.push({
      ref: ref(), severity: "high", kind: "rule",
      title: "Leaver is still active in the run",
      subject: e.name + " · " + e.payrollNumber, employeeIds: [e.id], amount: ps.net,
      why: `A leaving date of ${e.leavingDate} precedes the start of this pay period, but a full payment is scheduled.`,
      evidence: [["Leaving date", e.leavingDate],["Period start", period.start],["Scheduled net", "£" + ps.net.toFixed(2)]],
      action: "Hold from the run and process as a leaver with a P45. Releasing creates an overpayment recoverable only by agreement."
    });
  });

  payslips.forEach(ps => {
    const prior = priorPayslips[ps.employeeId];
    if(!prior || prior.net <= 0) return;
    const delta = (ps.net - prior.net) / prior.net;
    if(Math.abs(delta) >= 0.30) out.push({
      ref: ref(), severity: Math.abs(delta) >= 0.60 ? "high" : "med", kind: "model",
      title: `Net pay ${delta > 0 ? "up" : "down"} ${Math.abs(delta*100).toFixed(0)}% against last period`,
      subject: byId[ps.employeeId]?.name || ps.employeeId, employeeIds: [ps.employeeId],
      amount: p2(Math.abs(ps.net - prior.net)),
      why: "A change of this size is usually a known event — overtime, changed hours, a backdated award. It is also how double payments and keying errors present.",
      evidence: [["Last period","£"+prior.net.toFixed(2)],["This period","£"+ps.net.toFixed(2)],["Change","£"+(ps.net-prior.net).toFixed(2)]],
      action: "Confirm the cause before release."
    });
  });

  payslips.forEach(ps => {
    const e = byId[ps.employeeId];
    if(!e || !e.dob) return;
    const age = ageAt(e.dob, period.end);
    if(e.niCategory === "C" && age < 66) out.push({
      ref: ref(), severity: "med", kind: "rule",
      title: "NI category C applied below State Pension age",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "Category C applies only above State Pension age. Either the category or the date of birth is wrong.",
      evidence: [["NI category","C"],["Date of birth",e.dob],["Age at period end",String(age)]],
      action: "Verify the date of birth first — correcting the category against a wrong DOB compounds the error."
    });
    if(e.niCategory === "M" && age >= 21) out.push({
      ref: ref(), severity: "med", kind: "rule",
      title: "NI category M applied to an employee aged 21 or over",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "Category M is for employees under 21. Secondary NI is being under-paid.",
      evidence: [["NI category","M"],["Age at period end",String(age)]],
      action: "Move to category A from the period following the 21st birthday."
    });
    if(e.niCategory === "H" && age >= 25) out.push({
      ref: ref(), severity: "med", kind: "rule",
      title: "Apprentice NI category H applied to an employee aged 25 or over",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "Category H applies to apprentices under 25 on an approved scheme.",
      evidence: [["NI category","H"],["Age at period end",String(age)]],
      action: "Move to the appropriate standard category."
    });
  });

  payslips.forEach(ps => {
    const e = byId[ps.employeeId];
    if(!e) return;
    const annualised = ps.gross * periodsPerYear(config);
    const scheme = schemes.find(s => s.id === e.pensionSchemeId);
    const contributing = scheme && (scheme.employeeRate > 0 || scheme.employerRate > 0);
    if(annualised >= config.autoEnrolment.triggerAnnual && !contributing && !e.pensionOptOut) out.push({
      ref: ref(), severity: "med", kind: "rule",
      title: "Eligible jobholder with no pension scheme and no opt-out",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "Earnings exceed the auto-enrolment trigger but no contributing scheme is assigned and no opt-out is recorded.",
      evidence: [["Annualised earnings","£"+annualised.toFixed(0)],["Trigger","£"+config.autoEnrolment.triggerAnnual],["Scheme",scheme ? scheme.name : "none"],["Opt-out","none"]],
      action: "Enrol and backdate, or record a valid opt-out. This is a Pensions Regulator matter, not a payroll error."
    });
  });

  payslips.filter(ps => ps.net < 0).forEach(ps => out.push({
    ref: ref(), severity: "high", kind: "rule",
    title: "Negative net pay",
    subject: byId[ps.employeeId]?.name || ps.employeeId, employeeIds: [ps.employeeId], amount: p2(Math.abs(ps.net)),
    why: "Deductions exceed gross pay. This cannot be paid and will fail at BACS.",
    evidence: [["Gross","£"+ps.gross.toFixed(2)],["Deductions","£"+ps.totalDeductions.toFixed(2)],["Net","£"+ps.net.toFixed(2)]],
    action: "Reduce or defer a voluntary deduction. Statutory deductions cannot take pay below zero."
  }));

  payslips.forEach(ps => {
    const e = byId[ps.employeeId];
    if(!e) return;
    const tc = parseTaxCode(e.taxCode);
    if(!tc.valid) out.push({
      ref: ref(), severity: "med", kind: "rule",
      title: "Tax code is missing or not recognised",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "Without a valid code the record defaults to an emergency basis and the employee is over-taxed.",
      evidence: [["Code held", e.taxCode || "(none)"]],
      action: "Capture a starter declaration, or apply the code from the P45 or HMRC notice."
    });
    else if(!tc.cumulative) out.push({
      ref: ref(), severity: "low", kind: "rule",
      title: "Employee is on a non-cumulative (emergency) tax code",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "Tax is calculated on this period alone, ignoring earlier pay. This usually over-deducts until HMRC issues a cumulative code.",
      evidence: [["Code held", e.taxCode],["Basis","Week 1 / Month 1"]],
      action: "Monitor for a P6 from HMRC. No action needed if the starter declaration was recent."
    });
    if(!e.niNumber) out.push({
      ref: ref(), severity: "low", kind: "rule",
      title: "No National Insurance number held",
      subject: e.name, employeeIds: [e.id], amount: 0,
      why: "The FPS will be accepted but HMRC may be unable to match the record, which can misallocate contributions.",
      evidence: [["NI number","(none)"]],
      action: "Obtain the number, or record that the employee has applied for one."
    });
  });

  const order = { high: 0, med: 1, low: 2 };
  return out.sort((a,b) => order[a.severity] - order[b.severity] || b.amount - a.amount);
}

function ageAt(dob, on){
  const d = new Date(dob), o = new Date(on);
  let a = o.getFullYear() - d.getFullYear();
  const m = o.getMonth() - d.getMonth();
  if(m < 0 || (m === 0 && o.getDate() < d.getDate())) a--;
  return a;
}

/* ============================================================================
   LEAVE
   ========================================================================== */
const BANK_HOLIDAYS = {
  "2026-04-03":"Good Friday","2026-04-06":"Easter Monday","2026-05-04":"Early May",
  "2026-05-25":"Spring","2026-08-31":"Summer","2026-12-25":"Christmas Day",
  "2026-12-28":"Boxing Day (substitute)","2027-01-01":"New Year's Day"
};

function workingDaysBetween(from, to, opts = {}){
  const skipBH = opts.skipBankHolidays !== false;
  const a = new Date(from + "T00:00:00"), b = new Date(to + "T00:00:00");
  if(isNaN(a) || isNaN(b) || b < a) return null;
  let working = 0, weekend = 0, bank = 0;
  for(let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)){
    const iso = d.toISOString().slice(0,10), dow = d.getDay();
    if(dow === 0 || dow === 6){ weekend++; continue; }
    if(skipBH && BANK_HOLIDAYS[iso]){ bank++; continue; }
    working++;
  }
  return { working, weekend, bank };
}

function leaveHours(from, to, halfMode, hoursPerDay){
  const w = workingDaysBetween(from, to);
  if(!w) return null;
  let d = w.working;
  if(d > 0){
    if(halfMode === "start" || halfMode === "end") d -= 0.5;
    if(halfMode === "both") d -= (d > 1 ? 1 : 0.5);
  }
  return { ...w, days: d, hours: p2(d * hoursPerDay) };
}

/* Statutory minimum is 5.6 weeks, capped at 28 days for a 5-day week.
   Anything above that is contractual. */
function statutoryMinimumDays(daysPerWeek){
  return Math.min(p2((daysPerWeek || 5) * 5.6), 28);
}

function leaveBalance(employee, records, asAt){
  const hpd = (employee.weeklyHours || 37.5) / (employee.daysPerWeek || 5);
  const statMin = statutoryMinimumDays(employee.daysPerWeek);
  const entDays = employee.leaveDays ?? statMin;
  const inclusive = employee.bankHolidaysInEntitlement !== false;

  const entitlementHours = p2(entDays * hpd);
  const bankHours = inclusive ? 0 : p2((employee.bankHolidayDays ?? 8) * hpd);
  const carriedHours = p2((employee.carriedDays || 0) * hpd);
  const total = p2(entitlementHours + bankHours + carriedHours);

  const mine = records.filter(r => r.employeeId === employee.id && r.status !== "rejected" && r.status !== "cancelled");
  const now = new Date(asAt + "T00:00:00");
  let taken = 0, booked = 0, pending = 0, carriedUsed = 0;
  mine.forEach(r => {
    if(r.type === "unpaid" || r.type === "sick") return;
    if(r.type === "carried") carriedUsed += r.hours;
    if(r.status === "pending"){ pending += r.hours; return; }
    (new Date(r.to + "T00:00:00") < now ? (taken += r.hours) : (booked += r.hours));
  });

  return {
    hoursPerDay: hpd, total, entitlementHours, bankHours, carriedHours,
    statutoryMinimumDays: statMin,
    belowStatutory: entDays + (inclusive ? 0 : (employee.bankHolidayDays ?? 8)) < statMin,
    taken: p2(taken), booked: p2(booked), pending: p2(pending),
    available: p2(total - taken - booked - pending),
    carriedRemaining: p2(Math.max(0, carriedHours - carriedUsed)),
    days: h => p2(h / hpd)
  };
}

/* ========================================================================== */
if(typeof module !== "undefined") module.exports = {
  DEFAULT_CONFIG, PAY_FREQUENCIES, PENSION_BASES, PENSION_METHODS,
  parseTaxCode, calcPAYE, calcNI, calcStudentLoan, calcPension, pensionableEarnings,
  calcSSP, calcSMP, calcPayslip, applyEmployerReliefs, detectExceptions,
  workingDaysBetween, leaveHours, leaveBalance, statutoryMinimumDays,
  BANK_HOLIDAYS, ageAt, p2, periodsPerYear
};
