/* ============================================================================
   AUTOMATION POLICY ENGINE
   ----------------------------------------------------------------------------
   Automates the PATH, never the DECISION. Some things are permanently
   un-automatable no matter what mode the organisation selects:
     - committing a run (BACS is effectively irrevocable)
     - releasing a payment to someone flagged as a leaver
     - anything that reduces an individual's pay without notice
     - duplicate bank accounts and negative net pay
   Those carry never:true and cannot be raised above "propose" from the UI.
   ========================================================================== */

var TIERS = {
  off:     { label: "Off",              rank: 0, note: "Not evaluated" },
  propose: { label: "Propose",          rank: 1, note: "Prepares the change, a person clicks to accept" },
  notify:  { label: "Apply and notify", rank: 2, note: "Applies it, records it, reversible from the log" },
  apply:   { label: "Apply",            rank: 3, note: "Applies it silently, still recorded in the log" }
};

var MODES = {
  manual:    { label: "Manual",    note: "Nothing happens without a person doing it. Every check is a human check." },
  assisted:  { label: "Assisted",  note: "The system prepares every fix but waits for a click. Nothing changes on its own." },
  automated: { label: "Automated", note: "Routine corrections apply themselves and are logged. Judgement calls still stop." },
  cover:     { label: "Cover",     note: "For when the payroll lead is away. Routine work handles itself, every remaining decision comes with plain-English guidance, and anything above the delegation limit needs a second name." }
};

var AUTOMATION_RULES = [
  { id:"ni-age", name:"National Insurance category by age", group:"Statutory",
    what:"Moves category M to A at 21, H to A at 25, and to C at State Pension age.",
    why:"Age thresholds are arithmetic, not judgement. Leaving M on a 22-year-old under-pays employer NI every period until someone notices.",
    autoTier:"apply", never:false },

  { id:"auto-enrolment", name:"Auto-enrolment assessment", group:"Pensions",
    what:"Enrols an eligible jobholder into the default scheme when earnings pass the trigger and no opt-out is held.",
    why:"The Pensions Regulator expects assessment every pay period. Doing it by hand is where employers fall behind.",
    autoTier:"notify", never:false },

  { id:"recurring-elements", name:"Recurring pay elements", group:"Payroll",
    what:"Carries forward pay elements marked as recurring from the last committed run.",
    why:"Re-keying the same allowance every period is pure waste and a common source of omission.",
    autoTier:"apply", never:false },

  { id:"bank-format", name:"Bank detail validation", group:"Payments",
    what:"Checks sort code and account number structure before a payment file is produced.",
    why:"Catching a malformed account before BACS is far cheaper than a failed payment and a chased correction.",
    autoTier:"notify", never:false },

  { id:"carryover-expiry", name:"Carry-over expiry warning", group:"Leave",
    what:"Notifies employees whose carried-over leave is close to expiring.",
    why:"Carried leave cannot be paid in lieu. Silence means the employee simply loses it.",
    autoTier:"notify", never:false },

  { id:"clear-informational", name:"Clear informational exceptions", group:"Payroll",
    what:"Auto-releases low-severity exceptions that carry no financial impact, with the rule recorded as the decider.",
    why:"A missing NI number should not block a payroll run. It should be chased, not gate the money.",
    autoTier:"notify", never:false },

  { id:"tax-code", name:"Apply HMRC tax code notices", group:"Statutory",
    what:"Applies P6 and P9 coding notices received from HMRC.",
    why:"HMRC notices are authoritative and involve no judgement. Keying them by hand wastes time and introduces error.",
    autoTier:"propose", never:true,
    blocked:"Requires the HMRC Data Provisioning Service, which needs RTI recognition first. Until then this can only propose from what is already on file." },

  { id:"leaver-final-pay", name:"Leaver final pay", group:"Payroll",
    what:"Prepares the final payslip: holds the record, calculates payment in lieu of untaken leave, and readies the P45.",
    why:"Highest error rate in payroll, and an overpayment to someone who has left is the hardest of all to recover.",
    autoTier:"propose", never:true,
    blocked:"A person confirms every leaver. This is where the costliest payroll errors happen." },

  { id:"commit-run", name:"Commit the payroll run", group:"Payments",
    what:"Releases the run for payment.",
    why:"BACS is effectively irrevocable. Recovering an overpayment from a low-paid worker is a union and reputational problem before it is a finance one.",
    autoTier:"off", never:true,
    blocked:"Permanently manual. A named person takes responsibility before money moves." }
];

/* ============================================================================
   COVER MODE
   ----------------------------------------------------------------------------
   The payroll lead is off. Someone competent but less experienced has to get
   the run out. This is not "the system does it alone" — it is a first officer
   arrangement: the aircraft flies itself more of the time, every remaining
   decision is explained rather than merely flagged, and there is a hard limit
   on what one person can sign off without a second name.

   The limits mirror controls an auditor already expects: delegated authority,
   dual authorisation above a threshold, and a handover record.
   ========================================================================== */
var DEFAULT_COVER = {
  active: false,
  leadName: "",              // who is away
  deputyName: "",            // who is covering
  releaseLimit: 1000,        // £ a deputy may release alone
  requireSecondApproval: true,
  escalateHighSeverity: true,
  returnsOn: null
};

/* Plain-English guidance per rule, written for someone who does not run
   payroll every month. Deliberately says what the risk is, not just what the
   rule found. */
var COVER_GUIDANCE = {
  "leaver-final-pay":
    "Someone has left but is still being paid. If you release this, the money goes and getting it back means asking them to return it. Hold it unless you know for certain they are still employed.",
  "bank-format":
    "These bank details will be rejected by the bank. The payment will fail and the employee will not be paid on time. Fix the details or hold that one record.",
  "ni-age":
    "A birthday changed which National Insurance category applies. This is arithmetic, not judgement — accepting it is safe.",
  "auto-enrolment":
    "Their earnings mean they must be offered a pension. Accepting enrols them, which is what the law requires. If they have opted out, the opt-out form needs recording first.",
  "recurring-elements":
    "The same allowances as last month, carried forward. Check the amounts look like last month's payslip and accept.",
  "carryover-expiry":
    "Nothing to fix in this run. It is a warning to the employee that leave will be lost.",
  "clear-informational":
    "Paperwork rather than money. Safe to clear now and chase afterwards.",
  "tax-code":
    "No valid tax code held, so the emergency code applies. The employee may be over-taxed for a month and HMRC will correct it later. Accepting is the normal course."
};

function coverAssessment(action, exceptionAmount, cover){
  const amount = Number(exceptionAmount || 0);
  const rule = AUTOMATION_RULES.find(r => r.id === action.ruleId) || {};
  const overLimit = amount > (cover.releaseLimit || 0);
  const highSeverity = action.blocking === true;

  let authority = "deputy";
  let reason = "Within the delegated limit.";

  if(highSeverity && cover.escalateHighSeverity){
    authority = "lead";
    reason = "High-risk item. Held for " + (cover.leadName || "the payroll lead") + " to decide on their return.";
  } else if(overLimit && cover.requireSecondApproval){
    authority = "second";
    reason = "£" + amount.toFixed(2) + " is above the £" + Number(cover.releaseLimit).toFixed(2)
           + " delegated limit, so it needs a second named approver.";
  }

  return {
    authority, reason,
    guidance: COVER_GUIDANCE[action.ruleId] || "Check the evidence and decide. If you are unsure, hold it — a held record can be paid later, a wrong payment cannot be unpaid.",
    amount
  };
}

/* A run cannot be committed under cover authority while anything is escalated. */
function coverReadiness({ exceptions, decisions, actions, cover }){
  const open = (exceptions || []).filter(x => !decisions?.[x.ref]);
  const escalated = (actions || [])
    .map(a => ({ a, c: coverAssessment(a, a.amount || 0, cover) }))
    .filter(x => x.c.authority !== "deputy");

  return {
    open: open.length,
    escalated: escalated.length,
    needsSecondApproval: escalated.filter(x => x.c.authority === "second").length,
    heldForLead: escalated.filter(x => x.c.authority === "lead").length,
    canCommit: open.length === 0 && escalated.filter(x => x.c.authority === "lead").length === 0
  };
}

function defaultPolicy(mode){
  const p = {};
  AUTOMATION_RULES.forEach(r => {
    if(mode === "manual")        p[r.id] = "off";
    else if(mode === "assisted") p[r.id] = r.id === "commit-run" ? "off" : "propose";
    else if(mode === "cover")    p[r.id] = r.never ? (r.id === "commit-run" ? "off" : "propose") : r.autoTier;
    else                          p[r.id] = r.never ? (r.id === "commit-run" ? "off" : "propose") : r.autoTier;
  });
  return p;
}

function tierFor(policy, ruleId){
  const rule = AUTOMATION_RULES.find(r => r.id === ruleId);
  let t = policy?.[ruleId] || "off";
  if(rule?.never && TIERS[t].rank > TIERS.propose.rank) t = "propose";
  if(rule?.id === "commit-run") t = "off";
  return t;
}

/* ---------- bank detail validation ---------------------------------------
   Structural validation only. Full VocaLink modulus checking needs their
   published weights table (EISCD), which is licensed and not embedded here.
   Structure alone still removes most keying errors.
------------------------------------------------------------------------- */
function validateBankDetails(sort, account){
  const s = String(sort || "").replace(/\D/g,"");
  const a = String(account || "").replace(/\D/g,"");
  const problems = [];
  if(!s) problems.push("no sort code");
  else if(s.length !== 6) problems.push("sort code is " + s.length + " digits, expected 6");
  else if(/^0{6}$/.test(s)) problems.push("sort code is all zeros");
  if(!a) problems.push("no account number");
  else if(a.length < 6 || a.length > 10) problems.push("account number is " + a.length + " digits, expected 6 to 10");
  else if(/^0+$/.test(a)) problems.push("account number is all zeros");
  return { valid: problems.length === 0, problems, sort: s, account: a,
           modulusChecked: false };
}

/* ============================================================================
   EVALUATION — returns proposed actions, applies nothing itself
   ========================================================================== */
function evaluateAutomations({ employees, payslips, exceptions, schemes, leave, period, policy, config, lastRun }){
  const actions = [];
  const byId = Object.fromEntries(employees.map(e => [e.id, e]));
  let seq = 0;
  const mk = (ruleId, o) => {
    const tier = tierFor(policy, ruleId);
    if(tier === "off") return;
    actions.push({ id: "A" + (++seq), ruleId, tier, ...o });
  };

  /* --- NI category by age --- */
  employees.filter(e => e.status === "active" && e.dob).forEach(e => {
    const age = ageAt(e.dob, period.end);
    let to = null;
    if(e.niCategory === "M" && age >= 21) to = "A";
    else if(e.niCategory === "H" && age >= 25) to = "A";
    else if(["A","B","H","M"].includes(e.niCategory) && age >= 66) to = "C";
    if(to) mk("ni-age", {
      scope:"employee", targetId:e.id,
      label:`${e.name}: NI category ${e.niCategory} to ${to}`,
      detail:`Aged ${age} at the end of this period.`,
      evidence:[["Current category", e.niCategory],["Age at period end", String(age)],["Correct category", to]],
      change:{ type:"setField", employeeId:e.id, field:"niCategory", from:e.niCategory, to }
    });
  });

  /* --- auto-enrolment --- */
  const dflt = schemes.find(s => s.isDefault) || schemes[0];
  if(dflt) payslips.forEach(ps => {
    const e = byId[ps.employeeId];
    if(!e || e.pensionOptOut) return;
    const inScheme = schemes.some(s => s.id === e.pensionSchemeId);
    const annualised = ps.gross * periodsPerYear(config);
    if(!inScheme && annualised >= config.autoEnrolment.triggerAnnual) mk("auto-enrolment", {
      scope:"employee", targetId:e.id,
      label:`${e.name}: enrol into ${dflt.name}`,
      detail:`Annualised earnings of £${annualised.toFixed(0)} exceed the £${config.autoEnrolment.triggerAnnual} trigger.`,
      evidence:[["Annualised earnings","£"+annualised.toFixed(0)],["Trigger","£"+config.autoEnrolment.triggerAnnual],["Scheme",dflt.name],["Opt-out","none held"]],
      change:{ type:"setField", employeeId:e.id, field:"pensionSchemeId", from:e.pensionSchemeId||"", to:dflt.id }
    });
  });

  /* --- recurring pay elements --- */
  if(lastRun) Object.entries(lastRun.elements || {}).forEach(([empId, els]) => {
    const recurring = els.filter(x => x.recurring);
    if(!recurring.length || !byId[empId] || byId[empId].status !== "active") return;
    mk("recurring-elements", {
      scope:"element", targetId:empId,
      label:`${byId[empId].name}: carry forward ${recurring.length} recurring element${recurring.length>1?"s":""}`,
      detail:recurring.map(x => x.label + " £" + x.amount.toFixed(2)).join(", "),
      evidence:recurring.map(x => [x.label, "£" + x.amount.toFixed(2)]),
      change:{ type:"addElements", employeeId:empId, elements:recurring }
    });
  });

  /* --- bank detail validation --- */
  employees.filter(e => e.status === "active").forEach(e => {
    const v = validateBankDetails(e.bankSort, e.bankAccount);
    if(!v.valid) mk("bank-format", {
      scope:"employee", targetId:e.id, blocking:true,
      label:`${e.name}: bank details will fail`,
      detail:v.problems.join("; ") + ".",
      evidence:[["Sort code", e.bankSort || "(none)"],["Account", e.bankAccount || "(none)"],["Problems", v.problems.join("; ")]],
      change:{ type:"flagOnly", employeeId:e.id }
    });
  });

  /* --- carry-over expiry --- */
  employees.filter(e => e.status === "active" && e.carriedDays > 0).forEach(e => {
    const bal = leaveBalance(e, leave, period.end);
    if(bal.carriedRemaining > 0) mk("carryover-expiry", {
      scope:"employee", targetId:e.id,
      label:`${e.name}: ${bal.days(bal.carriedRemaining).toFixed(1)} days of carried leave will expire`,
      detail:"Carried leave cannot be paid in lieu. Unused, it is simply lost.",
      evidence:[["Carried remaining", bal.carriedRemaining.toFixed(1) + " hrs"],["In days", bal.days(bal.carriedRemaining).toFixed(1)]],
      change:{ type:"notifyOnly", employeeId:e.id, message:"You have carried-over leave close to expiry." }
    });
  });

  /* --- clear informational exceptions --- */
  const INFORMATIONAL = ["No National Insurance number held","Employee is on a non-cumulative (emergency) tax code"];
  (exceptions || []).filter(x => x.severity === "low" && x.amount === 0 && INFORMATIONAL.some(t => x.title.startsWith(t)))
    .forEach(x => mk("clear-informational", {
      scope:"exception", targetId:x.ref,
      label:`${x.ref} cleared: ${x.title.toLowerCase()}`,
      detail:"No financial impact. Released so it does not gate the run, and raised as a task instead.",
      evidence:x.evidence,
      change:{ type:"decideException", ref:x.ref, decision:"release" }
    }));

  /* --- leaver final pay (propose only, always) --- */
  employees.filter(e => e.leavingDate).forEach(e => {
    const ps = payslips.find(p => p.employeeId === e.id);
    if(!ps || new Date(e.leavingDate) >= new Date(period.start)) return;
    const bal = leaveBalance(e, leave, period.end);
    const hourly = (e.annualSalary || 0) / 52.143 / (e.weeklyHours || 37.5);
    mk("leaver-final-pay", {
      scope:"employee", targetId:e.id, blocking:true,
      label:`${e.name}: prepare final pay`,
      detail:`Left ${e.leavingDate}. ${bal.available.toFixed(1)} hours untaken, worth £${(bal.available*hourly).toFixed(2)} in lieu.`,
      evidence:[["Leaving date", e.leavingDate],["Untaken leave", bal.available.toFixed(1) + " hrs"],
                ["Payment in lieu", "£" + (bal.available*hourly).toFixed(2)],["Scheduled net", "£" + ps.net.toFixed(2)]],
      change:{ type:"markLeaver", employeeId:e.id, pilonHours:bal.available, pilonAmount:p2(bal.available*hourly) }
    });
  });

  /* --- tax codes (propose only until DPS is connected) --- */
  employees.filter(e => e.status === "active" && !parseTaxCode(e.taxCode).valid).forEach(e => {
    mk("tax-code", {
      scope:"employee", targetId:e.id,
      label:`${e.name}: apply emergency tax code`,
      detail:"No valid code held. The statutory emergency code applies until HMRC issues one.",
      evidence:[["Code held", e.taxCode || "(none)"],["Proposed", "1257L W1/M1"]],
      change:{ type:"setField", employeeId:e.id, field:"taxCode", from:e.taxCode||"", to:"1257LM1" }
    });
  });

  return actions;
}

/* ---------- touchless rate ------------------------------------------------ */
function touchlessRate({ payslips, exceptions, decisions, actions }){
  if(!payslips.length) return { rate: 0, touched: 0, total: 0 };
  const touched = new Set();
  (exceptions || []).forEach(x => {
    const d = decisions?.[x.ref];
    const auto = d && d.byRule;
    if(!auto) (x.employeeIds || []).forEach(id => touched.add(id));
  });
  (actions || []).filter(a => a.tier === "propose").forEach(a => { if(a.targetId) touched.add(a.targetId); });
  const total = payslips.length;
  return { rate: Math.round(((total - touched.size) / total) * 1000) / 10, touched: touched.size, total };
}

if(typeof module !== "undefined") module.exports = {
  TIERS, MODES, AUTOMATION_RULES, DEFAULT_COVER, COVER_GUIDANCE,
  defaultPolicy, tierFor, coverAssessment, coverReadiness,
  validateBankDetails, evaluateAutomations, touchlessRate
};
