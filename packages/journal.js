/* ============================================================================
   PAYROLL JOURNAL ENGINE
   ----------------------------------------------------------------------------
   Turns a committed payroll run into double-entry accounting lines.

   The shape of it, in plain terms:

     DEBIT  what employing people COST the organisation this period
              gross pay, employer NI, employer pension, and any accrual
     CREDIT what the organisation now OWES as a result
              PAYE and NI to HMRC, contributions to the pension provider,
              net pay to the employees, deductions to third parties

   Debits must equal credits exactly. A journal that does not balance is not a
   rounding nuisance — every accounting system will reject it outright, so the
   balance check here is a hard error rather than a warning.

   Deliberately format-neutral. The same journal posts to Xero, to Sage, or to
   a CSV a bookkeeper types in by hand. Only the delivery differs.
   ========================================================================== */

const jp2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

/* ---------- chart of accounts -------------------------------------------
   Codes are defaults. Every organisation has its own chart, so these are
   overridable per tenant — a council's ledger looks nothing like a small
   company's, and posting to the wrong code is worse than not posting at all.
------------------------------------------------------------------------ */
const DEFAULT_ACCOUNTS = {
  grossPay:          { code: "7000", name: "Gross wages and salaries",     type: "expense"  },
  employerNI:        { code: "7006", name: "Employer National Insurance",  type: "expense"  },
  employerPension:   { code: "7007", name: "Employer pension contributions", type: "expense" },
  employmentAllowance:{ code:"7008", name: "Employment Allowance relief",  type: "expense"  },
  leaveAccrual:      { code: "7010", name: "Holiday pay accrual",          type: "expense"  },

  payeControl:       { code: "2210", name: "PAYE payable to HMRC",         type: "liability" },
  niControl:         { code: "2211", name: "National Insurance payable to HMRC", type: "liability" },
  pensionControl:    { code: "2212", name: "Pension contributions payable", type: "liability" },
  studentLoanControl:{ code: "2213", name: "Student loan deductions payable", type: "liability" },
  netPayControl:     { code: "2220", name: "Net wages payable",            type: "liability" },
  otherDeductions:   { code: "2230", name: "Other deductions payable",     type: "liability" },
  leaveProvision:    { code: "2240", name: "Holiday pay provision",        type: "liability" }
};

/* ============================================================================
   BUILD
   ========================================================================== */
function buildJournal({ run, payslips, employees, schemes = [], period, org = {},
                        accounts = DEFAULT_ACCOUNTS, options = {} }){
  const byId = Object.fromEntries((employees || []).map(e => [e.id, e]));
  const splitByCostCentre = options.splitByCostCentre !== false;

  // Held records were never paid, so they must not appear in the journal.
  const heldIds = new Set(
    (run?.exceptions || [])
      .filter(x => run.decisions?.[x.ref]?.type === "hold")
      .flatMap(x => x.employeeIds || [])
  );
  const paid = (payslips || []).filter(ps => !heldIds.has(ps.employeeId));

  const lines = [];
  const add = (acct, side, amount, costCentre, note) => {
    const v = jp2(amount);
    if(v === 0) return;                       // never post a zero line
    lines.push({
      code: acct.code, account: acct.name, type: acct.type,
      debit:  side === "debit"  ? v : 0,
      credit: side === "credit" ? v : 0,
      costCentre: costCentre || null,
      note: note || null
    });
  };

  /* ---- costs, split by cost centre so a budget holder can see their own --- */
  const buckets = {};
  paid.forEach(ps => {
    const e = byId[ps.employeeId] || {};
    const cc = splitByCostCentre ? (e.costCentre || e.department || "Unallocated") : "All";
    const b = buckets[cc] = buckets[cc] || { gross:0, erNI:0, erPension:0 };
    b.gross      += ps.gross;
    b.erNI       += ps.ni.employer;
    b.erPension  += ps.pension.employer;
  });

  Object.entries(buckets).sort((a,b) => a[0].localeCompare(b[0])).forEach(([cc,b]) => {
    add(accounts.grossPay,        "debit", b.gross,     cc);
    add(accounts.employerNI,      "debit", b.erNI,      cc);
    add(accounts.employerPension, "debit", b.erPension, cc);
  });

  /* ---- Employment Allowance reduces the employer NI cost -----------------
     Posted as a credit against the expense, not as income. It is a relief on
     a cost the organisation would otherwise bear, and treating it as income
     overstates both sides of the profit and loss.
  ------------------------------------------------------------------------- */
  const ea = jp2(run?.reliefs?.employmentAllowanceClaimed || 0);
  if(ea > 0) add(accounts.employerNI, "credit", ea, null, "Employment Allowance claimed");

  /* ---- what is now owed -------------------------------------------------- */
  const owed = paid.reduce((t, ps) => ({
    paye:        t.paye        + ps.paye.tax,
    niEmployee:  t.niEmployee  + ps.ni.employee,
    niEmployer:  t.niEmployer  + ps.ni.employer,
    pensionEe:   t.pensionEe   + ps.pension.employee,
    pensionEr:   t.pensionEr   + ps.pension.employer,
    studentLoan: t.studentLoan + ps.studentLoan.total,
    net:         t.net         + ps.net,
    other:       t.other       + otherDeductionsOn(ps)
  }), { paye:0, niEmployee:0, niEmployer:0, pensionEe:0, pensionEr:0, studentLoan:0, net:0, other:0 });

  Object.keys(owed).forEach(k => owed[k] = jp2(owed[k]));

  add(accounts.payeControl,        "credit", owed.paye,        null, "Income tax deducted");
  // Employee and employer NI go to the same HMRC control account, less the
  // allowance, because that is what actually gets paid over.
  add(accounts.niControl,          "credit", jp2(owed.niEmployee + owed.niEmployer - ea), null,
      ea > 0 ? "Employee and employer NI, net of Employment Allowance" : "Employee and employer NI");
  add(accounts.pensionControl,     "credit", jp2(owed.pensionEe + owed.pensionEr), null,
      "Employee and employer contributions");
  add(accounts.studentLoanControl, "credit", owed.studentLoan,  null, "Student and postgraduate loans");
  add(accounts.otherDeductions,    "credit", owed.other,        null, "Union subscriptions and similar");
  add(accounts.netPayControl,      "credit", owed.net,          null, "Payable by BACS");

  /* ---- optional: holiday pay accrual -------------------------------------
     Untaken leave is a cost already incurred and not yet paid. Public bodies
     must carry it under the CIPFA Code; companies under FRS 102 section 28.
     Off by default because it needs a leave balance to be meaningful.
  ------------------------------------------------------------------------- */
  if(options.leaveAccrual && options.leaveAccrual !== 0){
    const acc = jp2(options.leaveAccrual);
    add(accounts.leaveAccrual,  acc > 0 ? "debit"  : "credit", Math.abs(acc), null,
        acc > 0 ? "Increase in untaken leave" : "Decrease in untaken leave");
    add(accounts.leaveProvision, acc > 0 ? "credit" : "debit",  Math.abs(acc), null,
        "Holiday pay provision movement");
  }

  /* ---- balance ----------------------------------------------------------- */
  const totalDebit  = jp2(lines.reduce((s,l) => s + l.debit,  0));
  const totalCredit = jp2(lines.reduce((s,l) => s + l.credit, 0));
  const difference  = jp2(totalDebit - totalCredit);

  return {
    reference: journalReference(period, org),
    date: period?.payDate || period?.end || null,
    narrative: journalNarrative(period, paid.length, org),
    lines,
    totalDebit, totalCredit, difference,
    balanced: difference === 0,
    employeesIncluded: paid.length,
    employeesHeld: heldIds.size,
    employerCost: jp2(totalDebit)
  };
}

function otherDeductionsOn(ps){
  return (ps.deductions || [])
    .filter(d => !d.statutory && !/pension/i.test(d.label))
    .reduce((s,d) => s + d.amount, 0);
}

function journalReference(period, org){
  const p = String(period?.n ?? period?.sequence ?? "").padStart(2,"0");
  const y = (period?.taxYear || "").replace("/","-");
  return "PAY-" + (y || "JRNL") + "-P" + p;
}

function journalNarrative(period, count, org){
  return "Payroll for " + (period?.label || "the period") +
         " — " + count + " employee" + (count === 1 ? "" : "s") +
         (org.shortName ? " (" + org.shortName + ")" : "");
}

/* ============================================================================
   VALIDATION
   A journal that does not balance must never reach an accounting system.
   ========================================================================== */
function validateJournal(journal){
  const problems = [];
  if(!journal.lines.length) problems.push("journal has no lines");
  if(!journal.balanced)
    problems.push("does not balance: debits " + journal.totalDebit.toFixed(2) +
                  " against credits " + journal.totalCredit.toFixed(2) +
                  ", difference " + journal.difference.toFixed(2));
  journal.lines.forEach((l,i) => {
    if(l.debit < 0 || l.credit < 0) problems.push("line " + (i+1) + " has a negative amount");
    if(l.debit > 0 && l.credit > 0) problems.push("line " + (i+1) + " has both a debit and a credit");
    if(l.debit === 0 && l.credit === 0) problems.push("line " + (i+1) + " is empty");
    if(!l.code) problems.push("line " + (i+1) + " has no account code");
  });
  return { valid: problems.length === 0, problems };
}

/* ============================================================================
   OUTPUT FORMATS
   The journal is the same in every case; only the shape of the file changes.
   ========================================================================== */
function journalToCSV(journal){
  const rows = [["Date","Reference","Account code","Account","Cost centre","Description","Debit","Credit"]];
  journal.lines.forEach(l => rows.push([
    journal.date || "", journal.reference, l.code, l.account,
    l.costCentre || "", l.note || journal.narrative,
    l.debit ? l.debit.toFixed(2) : "", l.credit ? l.credit.toFixed(2) : ""
  ]));
  rows.push(["","","","","","TOTAL", journal.totalDebit.toFixed(2), journal.totalCredit.toFixed(2)]);
  return rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }).join(",")).join("\n");
}

/* Xero's manual journal payload. Xero wants a single signed amount per line:
   positive for a debit, negative for a credit. */
function journalToXero(journal){
  return {
    Narration: journal.narrative,
    Date: journal.date,
    Status: "DRAFT",                 // never post live without a human looking
    LineAmountTypes: "NoTax",
    JournalLines: journal.lines.map(l => ({
      AccountCode: l.code,
      Description: l.note || l.account,
      LineAmount: l.debit > 0 ? l.debit : -l.credit,
      TrackingCategories: l.costCentre
        ? [{ Name: "Cost centre", Option: l.costCentre }] : []
    }))
  };
}

/* Sage 50 nominal ledger import layout. */
function journalToSage(journal){
  const rows = [["Type","Account Reference","Nominal A/C Ref","Date","Reference","Details","Net Amount","Tax Code"]];
  journal.lines.forEach(l => rows.push([
    l.debit > 0 ? "JD" : "JC", "", l.code, formatSageDate(journal.date),
    journal.reference, (l.note || l.account).slice(0,60),
    (l.debit > 0 ? l.debit : l.credit).toFixed(2), "T9"
  ]));
  return rows.map(r => r.join(",")).join("\n");
}

function formatSageDate(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  return d + "/" + m + "/" + y;
}

/* ========================================================================== */
if(typeof module !== "undefined") module.exports = {
  DEFAULT_ACCOUNTS, buildJournal, validateJournal,
  journalToCSV, journalToXero, journalToSage, jp2
};
