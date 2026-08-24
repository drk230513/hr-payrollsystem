/* ============================================================================
   HMRC REAL TIME INFORMATION — FPS AND EPS
   ----------------------------------------------------------------------------
   Built directly from the 2026-27 RIM schemas:
     FullPaymentSubmission-2027-v1-0.xsd
     EmployerPaymentSummary-2027-v1-0.xsd
     envelope-v2-0-HMRC.xsd

   Three things the schema insists on that are easy to get wrong, and each of
   which produces an outright rejection rather than a helpful message:

     1. ELEMENT ORDER IS FIXED. The schema is sequence-based. Correct data in
        the wrong order is invalid, so the builders below emit in schema order
        and nothing sorts them afterwards.

     2. THE TAX CODE IS NOT THE STRING WE HOLD. "S1257L W1" is three separate
        things: the code 1257L, a TaxRegime attribute of "S", and a
        BasisNonCumulative attribute of "yes". Sending "S1257LW1" as the code
        fails the pattern.

     3. THE PAYE REFERENCE IS TWO FIELDS. "120/AB12345" splits into OfficeNo
        (exactly three digits) and PayeRef (up to ten characters). Sending the
        whole string as either is invalid.

   Nothing here contacts HMRC. It produces the XML; submission is separate and
   needs credentials that only arrive with recognition.
   ========================================================================== */

const crypto = require("crypto");

const FPS_NS = "http://www.govtalk.gov.uk/taxation/PAYE/RTI/FullPaymentSubmission/26-27/1";
const EPS_NS = "http://www.govtalk.gov.uk/taxation/PAYE/RTI/EmployerPaymentSummary/26-27/1";
const ENVELOPE_NS = "http://www.govtalk.gov.uk/CM/envelope";

/* ---------- value formatting -------------------------------------------
   The monetary pattern is -?(([1-9][0-9]*)|0)\.[0-9]{2} — exactly two decimal
   places, and no leading zeros on the whole part. "0100.5" and "100.500" are
   both invalid; so is "100".
------------------------------------------------------------------------ */
function money(n){
  const v = Number(n || 0);
  if(!isFinite(v)) throw new Error("not a number: " + n);
  // toFixed alone is not enough: 100.005 is held as 100.00499... so it rounds
  // DOWN, which is not what HMRC expects and not what the calculation engine
  // does. The epsilon matches p2() in the engine, so a figure formatted here
  // always agrees with the figure that was calculated.
  const rounded = Math.round((Math.abs(v) + Number.EPSILON) * 100) / 100;
  const s = (v < 0 ? -rounded : rounded).toFixed(2);
  return s === "-0.00" ? "0.00" : s;
}

/* Four fields are reported in whole pounds, not pence — the schema pattern is
   .*\.00 and anything else is rejected outright:

     StudentLoansTD, PostgradLoansTD, PostgradLoanRecovered   student loans are
        deducted in whole pounds in the first place, so this agrees with the
        calculation rather than rounding it
     AtLELYTD   earnings at the Lower Earnings Limit, used for contributory
        benefit purposes

   Rounded DOWN, matching how the deductions themselves are computed. */
function wholePounds(n){
  const v = Math.floor(Number(n || 0) + 1e-9);
  return v.toFixed(2);
}

function date(d){
  if(!d) throw new Error("a date is required");
  const s = d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("date must be YYYY-MM-DD, got " + s);
  return s;
}

function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

/* ---------- the pieces that need decomposing ---------------------------- */

/* "120/AB12345" is two schema fields, not one. */
function splitPayeReference(ref){
  const m = String(ref || "").trim().match(/^(\d{3})\/([A-Za-z0-9]{1,10})$/);
  if(!m) throw new Error('PAYE reference must look like 120/AB12345, got "' + ref + '"');
  return { officeNo: m[1], payeRef: m[2].toUpperCase() };
}

/* "S1257L W1" is a code, a regime and a basis. */
function decomposeTaxCode(raw){
  let s = String(raw || "").toUpperCase().replace(/\s+/g, "");
  let regime = null, nonCumulative = false;

  if(s.startsWith("S")){ regime = "S"; s = s.slice(1); }
  else if(s.startsWith("C")){ regime = "C"; s = s.slice(1); }

  if(/(W1M1|W1|M1|X)$/.test(s)){
    nonCumulative = true;
    s = s.replace(/(W1M1|W1|M1|X)$/, "");
  }

  // The schema's own pattern. Anything outside it is rejected by HMRC, so it
  // is rejected here where the message can be useful.
  if(!/^(([1-9][0-9]{0,5}[LMNPTY])|(BR)|(0T)|(NT)|(D[0-8])|(K[1-9][0-9]{0,5}))$/.test(s)){
    throw new Error('tax code "' + raw + '" is not valid for RTI (resolved to "' + s + '")');
  }
  return { code: s, regime, nonCumulative };
}

/* "2026/27" is written 26-27 in RTI. */
function relatedTaxYear(taxYear){
  const m = String(taxYear || "").match(/^(\d{4})[\/-](\d{2})$/);
  if(!m) throw new Error('tax year must look like 2026/27, got "' + taxYear + '"');
  return m[1].slice(2) + "-" + m[2];
}

/* Hours are reported as a band, not a number. A common mistake is sending
   the actual hours worked. */
const HOURS_BANDS = [
  { band: "A", upTo: 15.99,  label: "up to 15.99 hours" },
  { band: "B", upTo: 29.99,  label: "16 to 29.99 hours" },
  { band: "C", upTo: Infinity, label: "30 hours or more" }
];
function hoursBand(weeklyHours, { irregular = false, notKnown = false } = {}){
  if(notKnown) return "E";        // not regularly employed
  if(irregular) return "D";       // other
  const h = Number(weeklyHours || 0);
  return HOURS_BANDS.find(b => h <= b.upTo).band;
}

/* Plan 5 has no code in the 2026-27 schema's enumeration, which is worth
   knowing before a customer with Plan 5 borrowers is onboarded. */
const STUDENT_LOAN_PLANS = { plan1: "01", plan2: "02", plan4: "04" };
function studentLoanPlanCode(plan){
  const c = STUDENT_LOAN_PLANS[plan];
  if(!c) throw new Error("student loan plan " + plan + " has no RTI plan type code");
  return c;
}

const PAY_FREQUENCIES = {
  weekly: "W1", fortnightly: "W2", fourWeekly: "W4",
  monthly: "M1", quarterly: "M3", biannually: "M6",
  annually: "MA", oneOff: "IO", irregular: "IR"
};
function payFrequency(f){
  const v = PAY_FREQUENCIES[f];
  if(!v) throw new Error("unsupported pay frequency for RTI: " + f);
  return v;
}

/* ---------- small XML writer -------------------------------------------
   Deliberately not a generic serialiser. Order matters, so the builders
   below write elements in sequence and this only handles indentation and
   escaping.
------------------------------------------------------------------------ */
function el(name, value, attrs, indent){
  const pad = " ".repeat(indent);
  const a = attrs ? Object.entries(attrs).filter(([,v]) => v != null && v !== false)
    .map(([k,v]) => ' ' + k + '="' + esc(v) + '"').join("") : "";
  if(value == null || value === "") return pad + "<" + name + a + "/>";
  return pad + "<" + name + a + ">" + esc(value) + "</" + name + ">";
}
function open(name, indent, attrs){
  const a = attrs ? Object.entries(attrs).filter(([,v]) => v != null)
    .map(([k,v]) => ' ' + k + '="' + esc(v) + '"').join("") : "";
  return " ".repeat(indent) + "<" + name + a + ">";
}
function close(name, indent){ return " ".repeat(indent) + "</" + name + ">"; }
const push = (out, line) => { if(line != null) out.push(line); };

/* ============================================================================
   FULL PAYMENT SUBMISSION
   ========================================================================== */
function buildFPS({ employer, taxYear, period, payslips, employees, sender, finalSubmission }){
  const { officeNo, payeRef } = splitPayeReference(employer.payeReference);
  const out = [];
  const i = 4;

  push(out, open("IRenvelope", 0, { xmlns: FPS_NS }));
  push(out, buildIRheader({ periodEnd: period.payDate, sender, employer, taxYear, kind: "FPS" }, 2));
  push(out, open("FullPaymentSubmission", 2));

  push(out, open("EmpRefs", i));
  push(out, el("OfficeNo", officeNo, null, i+2));
  push(out, el("PayeRef", payeRef, null, i+2));
  push(out, el("AORef", employer.accountsOfficeReference, null, i+2));
  if(employer.corporationTaxRef) push(out, el("COTAXRef", employer.corporationTaxRef, null, i+2));
  push(out, close("EmpRefs", i));

  push(out, el("RelatedTaxYear", relatedTaxYear(taxYear), null, i));

  const byId = Object.fromEntries((employees || []).map(e => [e.id, e]));
  for(const ps of payslips){
    const e = byId[ps.employeeId];
    if(!e) throw new Error("no employee record for payslip " + ps.employeeId);
    push(out, buildEmployee({ employee: e, payslip: ps, period, taxYear }, i));
  }

  if(finalSubmission){
    push(out, open("FinalSubmission", i));
    if(finalSubmission.schemeCeased){
      push(out, el("BecauseSchemeCeased", "yes", null, i+2));
      push(out, el("DateSchemeCeased", date(finalSubmission.dateCeased), null, i+2));
    }
    if(finalSubmission.forYear) push(out, el("ForYear", "yes", null, i+2));
    push(out, close("FinalSubmission", i));
  }

  push(out, close("FullPaymentSubmission", 2));
  push(out, close("IRenvelope", 0));
  return out.join("\n");
}

function buildEmployee({ employee: e, payslip: ps, period, taxYear }, i){
  const out = [];
  push(out, open("Employee", i));

  /* --- who they are --- */
  push(out, open("EmployeeDetails", i+2));
  if(e.niNumber) push(out, el("NINO", normaliseNino(e.niNumber), null, i+4));
  push(out, open("Name", i+4));
  const { forenames, surname } = splitName(e.name, e);
  forenames.slice(0,2).forEach(f => push(out, el("Fore", f, null, i+6)));
  push(out, el("Sur", surname, null, i+6));
  push(out, close("Name", i+4));
  if(e.address && e.address.lines && e.address.lines.length){
    push(out, open("Address", i+4));
    e.address.lines.slice(0,4).forEach(l => push(out, el("Line", l, null, i+6)));
    if(e.address.postcode) push(out, el("UKPostcode", e.address.postcode, null, i+6));
    else if(e.address.country) push(out, el("ForeignCountry", e.address.country, null, i+6));
    push(out, close("Address", i+4));
  }
  if(e.dob) push(out, el("BirthDate", date(e.dob), null, i+4));
  push(out, el("Gender", genderFor(e), null, i+4));
  push(out, close("EmployeeDetails", i+2));

  /* --- the employment --- */
  push(out, open("Employment", i+2));
  if(e.offPayrollWorker) push(out, el("OffPayrollWorker", "yes", null, i+4));
  if(e.occupationalPension) push(out, el("OccPenInd", "yes", null, i+4));
  if(e.director){
    // Directors are reported on the annual basis, which HMRC needs to know
    // because their NI is calculated differently.
    push(out, el("DirectorsNIC", e.directorsNicMethod === "alternative" ? "AL" : "AN", null, i+4));
    if(e.directorAppointedWeek) push(out, el("TaxWkOfApptOfDirector", e.directorAppointedWeek, null, i+4));
  }
  if(e.starter){
    push(out, open("Starter", i+4));
    push(out, el("StartDate", date(e.starter.startDate), null, i+6));
    if(e.starter.declaration) push(out, el("StartDec", e.starter.declaration, null, i+6));
    if(e.starter.studentLoan) push(out, el("StudentLoan", "yes", null, i+6));
    if(e.starter.postgradLoan) push(out, el("PostgradLoan", "yes", null, i+6));
    push(out, close("Starter", i+4));
  }
  if(e.payrollNumber) push(out, el("PayId", e.payrollNumber, null, i+4));
  if(e.irregularPayment) push(out, el("IrrEmp", "yes", null, i+4));
  if(e.leavingDate) push(out, el("LeavingDate", date(e.leavingDate), null, i+4));

  /* --- year to date --- */
  push(out, open("FiguresToDate", i+4));
  push(out, el("TaxablePay", money(ps.ytd.taxable), null, i+6));
  push(out, el("TotalTax", money(ps.ytd.tax), null, i+6));
  if(ps.ytd.studentLoan > 0) push(out, el("StudentLoansTD", wholePounds(ps.ytd.studentLoan), null, i+6));
  if(ps.ytd.postgradLoan > 0) push(out, el("PostgradLoansTD", wholePounds(ps.ytd.postgradLoan), null, i+6));
  if(ps.ytd.pension > 0) push(out, el("EmpeePenContribnsPaidYTD", money(ps.ytd.pension), null, i+6));
  push(out, close("FiguresToDate", i+4));

  /* --- this payment --- */
  push(out, open("Payment", i+4));
  push(out, el("PayFreq", payFrequency(period.frequency), null, i+6));
  push(out, el("PmtDate", date(period.payDate), null, i+6));
  if(period.frequency === "monthly" || period.frequency === "quarterly" ||
     period.frequency === "biannually" || period.frequency === "annually"){
    push(out, el("MonthNo", period.taxMonth || period.sequence, null, i+6));
  } else {
    push(out, el("WeekNo", period.taxWeek || period.sequence, null, i+6));
  }
  push(out, el("PeriodsCovered", period.periodsCovered || 1, null, i+6));
  if(e.aggregatedEarnings) push(out, el("AggregatedEarnings", "yes", null, i+6));
  if(e.paymentAfterLeaving) push(out, el("PmtAfterLeaving", "yes", null, i+6));
  push(out, el("HoursWorked", hoursBand(e.weeklyHours, {
    irregular: e.irregularHours, notKnown: e.hoursNotKnown }), null, i+6));

  const tc = decomposeTaxCode(e.taxCode);
  push(out, el("TaxCode", tc.code, {
    BasisNonCumulative: tc.nonCumulative ? "yes" : null,
    TaxRegime: tc.regime
  }, i+6));

  push(out, el("TaxablePay", money(ps.taxableThis), null, i+6));
  if(ps.nonTaxablePay > 0) push(out, el("NonTaxOrNICPmt", money(ps.nonTaxablePay), null, i+6));
  if(ps.deductionsFromNetPay > 0) push(out, el("DednsFromNetPay", money(ps.deductionsFromNetPay), null, i+6));
  if(ps.pension && ps.pension.employee > 0)
    push(out, el("EmpeePenContribnsPaid", money(ps.pension.employee), null, i+6));
  if(ps.studentLoan && ps.studentLoan.main > 0){
    // PlanType is a required attribute, not optional. HMRC needs to know which
    // plan the deduction came from because the thresholds differ.
    push(out, el("StudentLoanRecovered", wholePounds(ps.studentLoan.main),
      { PlanType: studentLoanPlanCode(e.studentLoanPlan) }, i+6));
  }
  if(ps.studentLoan && ps.studentLoan.pgl > 0)
    push(out, el("PostgradLoanRecovered", wholePounds(ps.studentLoan.pgl), null, i+6));
  push(out, el("TaxDeductedOrRefunded", money(ps.paye.tax), null, i+6));
  if(e.onStrike) push(out, el("OnStrike", "yes", null, i+6));
  if(e.unpaidAbsence) push(out, el("UnpaidAbsence", "yes", null, i+6));
  push(out, close("Payment", i+4));

  /* --- National Insurance, one block per letter used this year --- */
  for(const ni of niBlocksFor(ps)){
    push(out, open("NIlettersAndValues", i+4));
    push(out, el("NIletter", ni.letter, null, i+6));
    push(out, el("GrossEarningsForNICsInPd", money(ni.grossInPeriod), null, i+6));
    push(out, el("GrossEarningsForNICsYTD", money(ni.grossYTD), null, i+6));
    push(out, el("AtLELYTD", wholePounds(ni.atLelYTD), null, i+6));
    push(out, el("LELtoPTYTD", money(ni.lelToPtYTD), null, i+6));
    push(out, el("PTtoUELYTD", money(ni.ptToUelYTD), null, i+6));
    push(out, el("TotalEmpNICInPd", money(ni.totalNicInPeriod), null, i+6));
    push(out, el("TotalEmpNICYTD", money(ni.totalNicYTD), null, i+6));
    push(out, el("EmpeeContribnsInPd", money(ni.employeeInPeriod), null, i+6));
    push(out, el("EmpeeContribnsYTD", money(ni.employeeYTD), null, i+6));
    push(out, close("NIlettersAndValues", i+4));
  }

  push(out, close("Employment", i+2));
  push(out, close("Employee", i));
  return out.join("\n");
}

/* TotalEmpNIC is employer AND employee combined, which is a common error —
   sending only the employer's share makes the figures irreconcilable. */
function niBlocksFor(ps){
  const ni = ps.ni || {};
  return [{
    letter: ni.category || "A",
    grossInPeriod: ps.niableThis,
    grossYTD: (ps.ytd && ps.ytd.niable) || ps.niableThis,
    atLelYTD: ni.earningsAtLEL || 0,
    lelToPtYTD: ni.earningsLELtoPT || 0,
    ptToUelYTD: ni.earningsPTtoUEL || 0,
    totalNicInPeriod: (ni.employee || 0) + (ni.employer || 0),
    totalNicYTD: ((ps.ytd && ps.ytd.niEmployee) || 0) + ((ps.ytd && ps.ytd.niEmployer) || 0),
    employeeInPeriod: ni.employee || 0,
    employeeYTD: (ps.ytd && ps.ytd.niEmployee) || 0
  }];
}

function splitName(full, e){
  if(e && e.surname) return { forenames: e.forenames || [e.firstName].filter(Boolean), surname: e.surname };
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if(!parts.length) throw new Error("an employee name is required");
  if(parts.length === 1) return { forenames: [], surname: parts[0] };
  return { forenames: parts.slice(0, -1), surname: parts[parts.length - 1] };
}

function normaliseNino(n){
  const s = String(n || "").toUpperCase().replace(/\s+/g, "");
  if(!s) return null;
  // The schema fixes the length at 9, padding a missing suffix with a space.
  return s.length === 8 ? s + " " : s;
}

function genderFor(e){
  const g = String(e.gender || "").toUpperCase()[0];
  if(g === "M" || g === "F") return g;
  // The schema requires it. Guessing is worse than refusing.
  throw new Error("RTI requires a gender of M or F for " + (e.name || e.id));
}

/* ============================================================================
   EMPLOYER PAYMENT SUMMARY
   ========================================================================== */
/* Element order here is taken from the schema, not from what reads naturally.
   RelatedTaxYear sits near the END, after Account — putting it after EmpRefs
   as the FPS does is invalid. The no-payment flag and its dates are an
   optional PAIR: reporting one without the other fails. */
function buildEPS({ employer, taxYear, period, reclaims, noPaymentForPeriod, periodOfInactivity,
                    employmentAllowance, apprenticeshipLevy, account, sender, finalSubmission }){
  const { officeNo, payeRef } = splitPayeReference(employer.payeReference);
  const out = [];
  const i = 4;

  push(out, open("IRenvelope", 0, { xmlns: EPS_NS }));
  push(out, buildIRheader({ periodEnd: period.payDate, sender, employer, taxYear, kind: "EPS" }, 2));
  push(out, open("EmployerPaymentSummary", 2));

  push(out, open("EmpRefs", i));
  push(out, el("OfficeNo", officeNo, null, i+2));
  push(out, el("PayeRef", payeRef, null, i+2));
  push(out, el("AORef", employer.accountsOfficeReference, null, i+2));
  if(employer.corporationTaxRef) push(out, el("COTAXRef", employer.corporationTaxRef, null, i+2));
  push(out, close("EmpRefs", i));

  /* Telling HMRC nobody was paid. Without this they assume a missed
     submission and issue an automatic penalty. */
  if(noPaymentForPeriod){
    push(out, el("NoPaymentForPeriod", "yes", null, i));
    push(out, open("NoPaymentDates", i));
    push(out, el("From", date(noPaymentForPeriod.from), null, i+2));
    push(out, el("To", date(noPaymentForPeriod.to), null, i+2));
    push(out, close("NoPaymentDates", i));
  }

  if(periodOfInactivity){
    push(out, open("PeriodOfInactivity", i));
    push(out, el("From", date(periodOfInactivity.from), null, i+2));
    push(out, el("To", date(periodOfInactivity.to), null, i+2));
    push(out, close("PeriodOfInactivity", i));
  }

  if(employmentAllowance != null){
    push(out, el("EmpAllceInd", employmentAllowance ? "yes" : "no", null, i));
  }

  if(reclaims && Object.values(reclaims).some(v => Number(v) > 0)){
    push(out, open("RecoverableAmountsYTD", i));
    if(reclaims.taxMonth) push(out, el("TaxMonth", reclaims.taxMonth, null, i+2));
    const fields = [
      ["SMPRecovered", reclaims.smp], ["SPPRecovered", reclaims.spp],
      ["SAPRecovered", reclaims.sap], ["ShPPRecovered", reclaims.shpp],
      ["SPBPRecovered", reclaims.spbp], ["SNCPRecovered", reclaims.sncp],
      ["NICCompensationOnSMP", reclaims.nicOnSMP],
      ["NICCompensationOnSPP", reclaims.nicOnSPP],
      ["NICCompensationOnSAP", reclaims.nicOnSAP],
      ["NICCompensationOnShPP", reclaims.nicOnShPP],
      ["CISDeductionsSuffered", reclaims.cisSuffered]
    ];
    for(const [name, value] of fields){
      if(Number(value) > 0) push(out, el(name, money(value), null, i+2));
    }
    push(out, close("RecoverableAmountsYTD", i));
  }

  if(apprenticeshipLevy){
    push(out, open("ApprenticeshipLevy", i));
    push(out, el("LevyDueYTD", wholePounds(apprenticeshipLevy.dueYTD), null, i+2));
    push(out, el("TaxMonth", apprenticeshipLevy.taxMonth, null, i+2));
    push(out, el("AnnualAllce", money(apprenticeshipLevy.annualAllowance), null, i+2));
    push(out, close("ApprenticeshipLevy", i));
  }

  if(account){
    push(out, open("Account", i));
    push(out, el("AccountHoldersName", account.holder, null, i+2));
    push(out, el("AccountNo", account.number, null, i+2));
    push(out, el("SortCode", String(account.sortCode).replace(/\D/g, ""), null, i+2));
    if(account.buildingSocietyRef) push(out, el("BuildingSocRef", account.buildingSocietyRef, null, i+2));
    push(out, close("Account", i));
  }

  push(out, el("RelatedTaxYear", relatedTaxYear(taxYear), null, i));

  if(finalSubmission){
    push(out, open("FinalSubmission", i));
    if(finalSubmission.schemeCeased){
      push(out, el("BecauseSchemeCeased", "yes", null, i+2));
      push(out, el("DateSchemeCeased", date(finalSubmission.dateCeased), null, i+2));
    }
    if(finalSubmission.forYear) push(out, el("ForYear", "yes", null, i+2));
    push(out, close("FinalSubmission", i));
  }

  push(out, close("EmployerPaymentSummary", 2));
  push(out, close("IRenvelope", 0));
  return out.join("\n");
}

/* ============================================================================
   IRHEADER
   The IRmark is left empty here and filled in afterwards, because it is a
   hash of the document that contains it.
   ========================================================================== */
function buildIRheader({ periodEnd, sender, employer, taxYear, kind }, indent){
  const out = [];
  const i = indent;
  push(out, open("IRheader", i));
  push(out, open("Keys", i+2));
  push(out, el("Key", splitPayeReference(employer.payeReference).officeNo + "/" +
                      splitPayeReference(employer.payeReference).payeRef,
               { Type: "TaxOfficeNumber" }, i+4));
  push(out, close("Keys", i+2));
  push(out, el("PeriodEnd", date(periodEnd), null, i+2));
  push(out, el("DefaultCurrency", "GBP", null, i+2));
  push(out, el("IRmark", "", { Type: "generic" }, i+2));
  push(out, el("Sender", sender || "Company", null, i+2));
  push(out, close("IRheader", i));
  return out.join("\n");
}

/* ============================================================================
   IRMARK
   ----------------------------------------------------------------------------
   A SHA-1 digest of the message body with the IRmark element itself removed,
   canonicalised, base64 encoded. HMRC rejects a submission whose IRmark does
   not match, so this is not optional.

   The canonicalisation here is a simplified exclusive C14N sufficient for
   documents this generator produces — it emits no comments, no processing
   instructions and no namespace prefixes beyond the default. A document from
   another source would need a full C14N implementation.
   ========================================================================== */
function computeIRmark(xml){
  // Remove the IRmark element entirely, including any whitespace-only line.
  const withoutMark = xml.replace(/^[ \t]*<IRmark[^>]*\/>\s*\n?/m, "")
                         .replace(/^[ \t]*<IRmark[^>]*>[\s\S]*?<\/IRmark>\s*\n?/m, "");
  const canonical = canonicalise(withoutMark);
  return crypto.createHash("sha1").update(canonical, "utf8").digest("base64");
}

function canonicalise(xml){
  return xml
    .replace(/<\?xml[^>]*\?>\s*/g, "")   // no declaration
    .replace(/<!--[\s\S]*?-->/g, "")     // no comments
    .replace(/>\s+</g, "><")             // no inter-element whitespace
    .trim();
}

function applyIRmark(xml){
  const mark = computeIRmark(xml);
  return xml.replace(/<IRmark([^>]*)\/>/, '<IRmark$1>' + mark + '</IRmark>')
            .replace(/<IRmark([^>]*)>\s*<\/IRmark>/, '<IRmark$1>' + mark + '</IRmark>');
}

/* ============================================================================
   GOVTALK ENVELOPE
   ========================================================================== */
function wrapInGovTalk({ body, messageClass, senderId, password, transactionId,
                         correlationId, qualifier = "request", function_ = "submit" }){
  const out = [];
  push(out, '<?xml version="1.0" encoding="UTF-8"?>');
  push(out, '<GovTalkMessage xmlns="' + ENVELOPE_NS + '">');
  push(out, el("EnvelopeVersion", "2.0", null, 2));
  push(out, open("Header", 2));
  push(out, open("MessageDetails", 4));
  push(out, el("Class", messageClass, null, 6));
  push(out, el("Qualifier", qualifier, null, 6));
  push(out, el("Function", function_, null, 6));
  if(transactionId) push(out, el("TransactionID", transactionId, null, 6));
  if(correlationId) push(out, el("CorrelationID", correlationId, null, 6));
  push(out, el("Transformation", "XML", null, 6));
  push(out, close("MessageDetails", 4));
  push(out, open("SenderDetails", 4));
  push(out, open("IDAuthentication", 6));
  push(out, el("SenderID", senderId, null, 8));
  push(out, open("Authentication", 8));
  push(out, el("Method", "clear", null, 10));
  push(out, el("Role", "principal", null, 10));
  push(out, el("Value", password, null, 10));
  push(out, close("Authentication", 8));
  push(out, close("IDAuthentication", 6));
  push(out, close("SenderDetails", 4));
  push(out, close("Header", 2));
  push(out, open("GovTalkDetails", 2));
  push(out, open("Keys", 4));
  push(out, close("Keys", 4));
  push(out, close("GovTalkDetails", 2));
  push(out, open("Body", 2));
  push(out, body.split("\n").map(l => "    " + l).join("\n"));
  push(out, close("Body", 2));
  push(out, "</GovTalkMessage>");
  return out.join("\n");
}

const MESSAGE_CLASS = {
  FPS: "HMRC-PAYE-RTI-FPS",
  EPS: "HMRC-PAYE-RTI-EPS",
  NVR: "HMRC-PAYE-RTI-NVR"
};

/* ============================================================================
   VALIDATION
   Catches the errors that produce an unhelpful rejection from HMRC, and says
   which employee caused them.
   ========================================================================== */
function validateFPSInputs({ employer, taxYear, period, payslips, employees }){
  const problems = [];
  const at = (who, msg) => problems.push(who + ": " + msg);

  try { splitPayeReference(employer.payeReference); }
  catch(e){ at("employer", e.message); }

  if(!/^[0-9]{3}P[A-Z][0-9]{7}[0-9X]$/.test(String(employer.accountsOfficeReference || ""))){
    at("employer", "Accounts Office reference must look like 083PA00123456");
  }
  try { relatedTaxYear(taxYear); } catch(e){ at("period", e.message); }
  try { date(period.payDate); } catch(e){ at("period", e.message); }
  try { payFrequency(period.frequency); } catch(e){ at("period", e.message); }

  const byId = Object.fromEntries((employees || []).map(e => [e.id, e]));
  for(const ps of payslips){
    const e = byId[ps.employeeId];
    const who = e ? (e.name || e.payrollNumber || e.id) : ps.employeeId;
    if(!e){ at(who, "no employee record"); continue; }
    try { decomposeTaxCode(e.taxCode); } catch(err){ at(who, err.message); }
    try { genderFor(e); } catch(err){ at(who, err.message); }
    if(e.niNumber && !/^[A-Z]{2}[0-9]{6}[A-D ]$/.test(normaliseNino(e.niNumber) || "")){
      at(who, "National Insurance number is not a valid format");
    }
    if(!e.payrollNumber) at(who, "a payroll id is required");
    if(ps.ytd == null) at(who, "year-to-date figures are missing");
  }
  return { valid: problems.length === 0, problems };
}

module.exports = {
  buildFPS, buildEPS, buildIRheader, wrapInGovTalk,
  computeIRmark, applyIRmark, canonicalise,
  splitPayeReference, decomposeTaxCode, relatedTaxYear,
  hoursBand, payFrequency, studentLoanPlanCode, money, wholePounds, date, niBlocksFor, splitName, normaliseNino,
  validateFPSInputs, MESSAGE_CLASS, FPS_NS, EPS_NS, ENVELOPE_NS
};
