/* ============================================================================
   APPLICATION LAYER — storage, state, views
   ========================================================================== */

/* ---------- storage: localStorage with a graceful in-memory fallback ------ */
const DB = (() => {
  let mem = {}, live = true;
  try { localStorage.setItem("__t","1"); localStorage.removeItem("__t"); }
  catch(e){ live = false; }
  return {
    live,
    get(k, d){ try { const v = live ? localStorage.getItem(k) : mem[k]; return v ? JSON.parse(v) : d; } catch(e){ return d; } },
    set(k, v){ const s = JSON.stringify(v); if(live) localStorage.setItem(k, s); else mem[k] = s; },
    clear(){ if(live){ Object.keys(localStorage).filter(k => k.startsWith("hrp:")).forEach(k => localStorage.removeItem(k)); } else mem = {}; }
  };
})();

const KEY = "hrp:state";
const uid = () => "E" + Math.random().toString(36).slice(2,8).toUpperCase();
const money = (n, dp=2) => (n < 0 ? "−" : "") + "£" + Math.abs(n).toLocaleString("en-GB",{minimumFractionDigits:dp, maximumFractionDigits:dp});
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtD = d => d ? new Date(d+"T00:00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}) : "—";

/* ---------- pay periods: UK tax year runs 6 April to 5 April -------------- */
function buildPeriods(freq){
  const n = (ENGINE.PAY_FREQUENCIES[freq] || ENGINE.PAY_FREQUENCIES.monthly).periods;
  if(freq === "monthly"){
    return Array.from({length:12}, (_,i) => {
      const m = (i + 3) % 12, y = 2026 + (m < 3 ? 1 : 0);
      const start = new Date(Date.UTC(y, m, 1)), end = new Date(Date.UTC(y, m + 1, 0));
      return { n:i+1, label:start.toLocaleDateString("en-GB",{month:"long",year:"numeric"}),
               short:start.toLocaleDateString("en-GB",{month:"short",year:"2-digit"}),
               start:start.toISOString().slice(0,10), end:end.toISOString().slice(0,10),
               payDate:end.toISOString().slice(0,10) };
    });
  }
  const daysPer = freq === "weekly" ? 7 : freq === "fortnightly" ? 14 : freq === "fourWeekly" ? 28 : 91;
  const origin = Date.UTC(2026, 3, 6);   // 6 April 2026
  return Array.from({length:n}, (_,i) => {
    const start = new Date(origin + i * daysPer * 86400000);
    const end   = new Date(origin + ((i+1) * daysPer - 1) * 86400000);
    const unit  = freq === "weekly" ? "Week" : freq === "fortnightly" ? "Fortnight" : freq === "fourWeekly" ? "Period" : "Quarter";
    return { n:i+1, label:unit + " " + (i+1) + " — " + start.toLocaleDateString("en-GB",{day:"numeric",month:"short"}),
             short:unit.slice(0,2) + (i+1),
             start:start.toISOString().slice(0,10), end:end.toISOString().slice(0,10),
             payDate:end.toISOString().slice(0,10) };
  });
}
var PERIODS = buildPeriods("monthly");
function refreshPeriods(){ PERIODS = buildPeriods(S.config.payFrequency); }

/* ---------- organisation presets ----------------------------------------- */
const PRESETS = {
  private: {
    org: { name:"Northgate Logistics Ltd", shortName:"Northgate Logistics",
      address:"Unit 12, Brookfield Park, Leeds LS11 5QT", sector:"private",
      payeRef:"120/NG88214", accountsOfficeRef:"120PA00456789", companyNumber:"09884120",
      claimsEmploymentAllowance:true, smallEmployer:true, apprenticeshipLevy:false },
    payFrequency: "monthly",
    schemes: [
      { id:"SCH1", name:"Workplace pension (NEST)", provider:"nest", basis:"qualifying",
        employeeRate:0.05, employerRate:0.03, method:"reliefAtSource",
        employerRef:"", groupRef:"", isDefault:true },
      { id:"SCH2", name:"Enhanced scheme", provider:"aviva", basis:"total",
        employeeRate:0.05, employerRate:0.08, method:"salarySac",
        employerRef:"", groupRef:"", isDefault:false }
    ]
  },
  public: {
    org: { name:"Thornbury Metropolitan Borough Council", shortName:"Thornbury MBC",
      address:"Civic Centre, Thornbury TS15 9AA", sector:"public",
      payeRef:"083/TB4471", accountsOfficeRef:"083PA00123456", companyNumber:"",
      claimsEmploymentAllowance:false, smallEmployer:false, apprenticeshipLevy:true },
    payFrequency: "monthly",
    schemes: [
      { id:"SCH1", name:"Local Government Pension Scheme", provider:"iconnect", basis:"pensionable",
        employeeRate:0.065, employerRate:0.204, method:"netPay",
        employerRef:"", groupRef:"", isDefault:true },
      { id:"SCH2", name:"Teachers' Pension Scheme", provider:"mdc", basis:"pensionable",
        employeeRate:0.093, employerRate:0.288, method:"netPay",
        employerRef:"", groupRef:"", isDefault:false }
    ]
  }
};

const PROVIDERS = {
  nest:      { name:"NEST",                 format:"CSV upload",  note:"Contribution schedule per pay period" },
  peoples:   { name:"The People's Pension", format:"CSV upload",  note:"Standard contribution file" },
  smart:     { name:"Smart Pension",        format:"API or CSV",  note:"Payroll integration available" },
  aviva:     { name:"Aviva",                format:"CSV upload",  note:"Scheme-specific template" },
  legal:     { name:"Legal & General",      format:"CSV upload",  note:"Standard contribution file" },
  iconnect:  { name:"i-Connect (LGPS)",     format:"Monthly file",note:"Per administering authority onboarding" },
  mdc:       { name:"MDC (Teachers')",      format:"Monthly file",note:"Monthly Data Collection submission" },
  other:     { name:"Other / manual",       format:"CSV export",  note:"Generic contribution export" }
};

/* ---------- default state ------------------------------------------------- */
/* Runs a block and swallows a failure rather than taking the whole screen
   down with it. One broken section should not blank the page — the recovery
   panel exists for corrupt state, not for a single calculation throwing. */
function safely(label, fn){
  try { return fn(); }
  catch(err){
    console.error("[" + label + "]", err && err.message);
    return null;
  }
}

function seedState(preset = "private"){
  const P = PRESETS[preset];
  const mk = o => Object.assign({
    id: uid(), status:"active", weeklyHours:37.5, daysPerWeek:5,
    taxCode:"1257L", niCategory:"A", pensionSchemeId:"SCH1", pensionOptOut:false,
    studentLoanPlan:"none", postgradLoan:false, director:false,
    leaveDays:28, bankHolidaysInEntitlement:true, bankHolidayDays:8, carriedDays:0,
    otherDeductions:[]
  }, o);

  const people = preset === "public" ? [
    mk({ name:"Ryan Considine", payrollNumber:"00287165", niNumber:"NM418820C", dob:"1985-03-11",
         startDate:"2018-06-04", jobTitle:"Loader / Driver", department:"Waste Services",
         annualSalary:27269, weeklyHours:37, bankSort:"20-41-12", bankAccount:"88104471",
         carriedDays:5, leaveDays:26, bankHolidaysInEntitlement:false,
         otherDeductions:[{label:"Union subscription", amount:16.90}] }),
    mk({ name:"Emma Whitfield", payrollNumber:"00291447", niNumber:"PA662310B", dob:"1979-11-02",
         startDate:"2011-01-10", jobTitle:"Senior Care Coordinator", department:"Adult Social Care",
         annualSalary:38442, weeklyHours:37, leavingDate:"2026-07-31", bankSort:"30-88-04", bankAccount:"41220987" }),
    mk({ name:"Sasha Ratcliffe", payrollNumber:"00418823", niNumber:"JT551208A", dob:"1992-07-19",
         startDate:"2021-09-01", jobTitle:"Neighbourhood Officer", department:"Neighbourhood Services",
         annualSalary:34314, weeklyHours:37, studentLoanPlan:"plan2", bankSort:"40-11-60", bankAccount:"70055412" }),
    mk({ name:"Helen Pryce", payrollNumber:"00390221", niNumber:"RG774418A", dob:"1983-12-05",
         startDate:"2013-09-02", jobTitle:"Teacher", department:"Education",
         annualSalary:42618, weeklyHours:37, pensionSchemeId:"SCH2", bankSort:"11-40-22", bankAccount:"29103844" }),
    mk({ name:"Amrit Kaur", payrollNumber:"00429730", niNumber:"YB901122C", dob:"1996-05-30",
         startDate:"2024-02-05", jobTitle:"Planning Technician", department:"Planning",
         annualSalary:31586, weeklyHours:37, pensionSchemeId:"", bankSort:"09-01-27", bankAccount:"66120388" }),
    mk({ name:"Tom Kaur", payrollNumber:"00429731", niNumber:"YB901188A", dob:"1994-01-12",
         startDate:"2023-06-19", jobTitle:"Grounds Operative", department:"Parks",
         annualSalary:25584, weeklyHours:37, bankSort:"09-01-27", bankAccount:"66120388" }),
    mk({ name:"Priya Hallworth", payrollNumber:"00304118", niNumber:"", dob:"1985-03-11",
         startDate:"2015-08-03", jobTitle:"Highways Inspector", department:"Highways",
         annualSalary:33024, weeklyHours:37, niCategory:"C", bankSort:"20-41-12", bankAccount:"55011923" }),
    mk({ name:"Jo Ferreira", payrollNumber:"00434881", niNumber:"HC774102A", dob:"2003-04-22",
         startDate:"2026-08-04", jobTitle:"Library Assistant", department:"Libraries",
         annualSalary:24960, weeklyHours:37, taxCode:"1257LM1", niCategory:"M",
         bankSort:"77-20-11", bankAccount:"90223417" })
  ] : [
    mk({ name:"Daniel Marsh", payrollNumber:"NG0012", niNumber:"NM418820C", dob:"1981-03-11",
         startDate:"2016-02-01", jobTitle:"Managing Director", department:"Board",
         annualSalary:96000, director:true, pensionSchemeId:"SCH2",
         bankSort:"20-41-12", bankAccount:"88104471" }),
    mk({ name:"Priya Raman", payrollNumber:"NG0034", niNumber:"PA662310B", dob:"1987-11-02",
         startDate:"2019-05-13", jobTitle:"Operations Manager", department:"Operations",
         annualSalary:52000, pensionSchemeId:"SCH2", bankSort:"30-88-04", bankAccount:"41220987" }),
    mk({ name:"Callum Byrne", payrollNumber:"NG0051", niNumber:"JT551208A", dob:"1995-07-19",
         startDate:"2022-09-01", jobTitle:"HGV Driver", department:"Transport",
         annualSalary:34500, studentLoanPlan:"plan2", carriedDays:3,
         bankSort:"40-11-60", bankAccount:"70055412" }),
    mk({ name:"Leila Hassan", payrollNumber:"NG0067", niNumber:"RG774418A", dob:"1993-12-05",
         startDate:"2021-03-15", jobTitle:"Warehouse Supervisor", department:"Warehouse",
         annualSalary:31200, bankSort:"11-40-22", bankAccount:"29103844" }),
    mk({ name:"Owen Fletcher", payrollNumber:"NG0072", niNumber:"YB901122C", dob:"2004-05-30",
         startDate:"2025-09-08", jobTitle:"Apprentice Technician", department:"Maintenance",
         annualSalary:22400, niCategory:"H", bankSort:"09-01-27", bankAccount:"66120388" }),
    mk({ name:"Sophie Fletcher", payrollNumber:"NG0073", niNumber:"YB901188A", dob:"2001-01-12",
         startDate:"2024-06-19", jobTitle:"Customer Coordinator", department:"Sales",
         annualSalary:26800, bankSort:"09-01-27", bankAccount:"66120388" }),
    mk({ name:"Grace Whitlock", payrollNumber:"NG0080", niNumber:"", dob:"1969-03-11",
         startDate:"2012-08-03", jobTitle:"Finance Officer", department:"Finance",
         annualSalary:38400, niCategory:"C", bankSort:"20-41-12", bankAccount:"55011923" }),
    mk({ name:"Jo Ferreira", payrollNumber:"NG0091", niNumber:"HC774102A", dob:"2007-04-22",
         startDate:"2026-08-04", jobTitle:"Warehouse Operative", department:"Warehouse",
         annualSalary:21840, taxCode:"1257LM1", niCategory:"M", pensionSchemeId:"",
         bankSort:"77-20-11", bankAccount:"90223417" }),
    mk({ name:"Ellis Warrington", payrollNumber:"NG0094", niNumber:"KP220417B", dob:"1990-02-28",
         startDate:"2020-11-02", jobTitle:"Fleet Controller", department:"Transport",
         annualSalary:29900, leavingDate:"2026-07-31", bankSort:"23-05-80", bankAccount:"14778290" })
  ];

  // Spread people across the group so the screens show something real.
  people.forEach((e, i) => {
    e.employerId = i === 0 || i === 8 ? "EMP-HOLD" : i === 6 ? "EMP-FM" : "EMP-LOG";
    e.scheduleId = i === 0 ? "SCH-Q-DIR" : i === 6 ? "SCH-W-CAS"
                 : i === 8 ? "SCH-M-HEAD" : i % 4 === 1 ? "SCH-W-DRV" : "SCH-M-OPS";
  });

  const cfg = JSON.parse(JSON.stringify(ENGINE.DEFAULT_CONFIG));
  cfg.payFrequency = P.payFrequency;

  return {
    preset,
    employer: { ...P.org },
    schemes: JSON.parse(JSON.stringify(P.schemes)),
    automation: { mode:"manual", policy: defaultPolicy("manual"), log: [], notifications: [],
                  cover: { ...DEFAULT_COVER, leadName:"A. Okafor", deputyName:"J. Small" } },
    integrations: {
      rti:  { enabled:false, gatewayId:"", senderId:"", credentialsSet:false, lastSubmission:null },
      bacs: { enabled:false, sun:"", bureau:"", originSort:"", originAccount:"", leadDays:3, lastFile:null },
      pension: { enabled:false, note:"" }
    },
    config: cfg,
    currentPeriod: 5,
    employees: people,
    leave: [],

    /* Several named leave schemes rather than one entitlement per person,
       because a real employer runs dozens. */
    leaveSchemes: [
      LEAVE.makeLeaveScheme({ id:"AL-STD", name:"Annual leave — standard",
        entitlementWeeks:5.6, carryOverMaxDays:5, carryOverExpiresAfterMonths:3,
        serviceIncrements:[{ afterMonths:60, extraDays:1 }, { afterMonths:120, extraDays:2 }] }),
      LEAVE.makeLeaveScheme({ id:"AL-ENH", name:"Annual leave — enhanced",
        entitlementDays:25, bankHolidaysIncluded:false, bankHolidayDays:8, carryOverMaxDays:5 }),
      LEAVE.makeLeaveScheme({ id:"AL-CAS", name:"Annual leave — irregular hours",
        accrual:"irregularHours", carryOverMaxDays:0 }),
      LEAVE.makeLeaveScheme({ id:"VOL", name:"Volunteering days",
        entitlementDays:2, countsTowardStatutory:false, carryOverMaxDays:0 }),
      LEAVE.makeLeaveScheme({ id:"UNP", name:"Unpaid leave",
        entitlementDays:0, paid:false, countsTowardStatutory:false }),
      // Deliberately unlawful, so the assurance check has something to find.
      LEAVE.makeLeaveScheme({ id:"AL-OLD", name:"Annual leave — legacy contract",
        entitlementDays:20, carryOverMaxDays:0 })
    ],
    leaveMemberships: people.map((e, i) => ({
      employeeId: e.id,
      schemeId: i === 3 ? "AL-OLD" : i === 6 ? "AL-CAS" : i % 3 === 0 ? "AL-ENH" : "AL-STD"
    })).concat(people.slice(0, 4).map(e => ({ employeeId: e.id, schemeId: "VOL" }))),
    leaveYear: { starts:"2026-04-01", ends:"2027-03-31", label:"2026/27" },
    leaveCarriedIn: { [people[1].id]: { "AL-STD": { hours: 22.5, expiresOn: "2026-09-15" } } },
    hoursWorkedInYear: { [people[6].id]: 512 },

    /* A group: several legal entities, each with its own PAYE reference and
       its own RTI, sharing one HR function. */
    employers: [
      { id:"EMP-HOLD", code:"NG-HOLD", name:"Northgate Group Ltd",
        payeOfficeNo:"120", payeRef:"NG88214", aoRef:"120PA00456789",
        claimsEmploymentAllowance:true },
      { id:"EMP-LOG",  code:"NG-LOG",  name:"Northgate Logistics Ltd",
        payeOfficeNo:"120", payeRef:"NG88215", aoRef:"120PA00456790",
        claimsEmploymentAllowance:false },
      { id:"EMP-FM",   code:"NG-FM",   name:"Northgate Facilities Ltd",
        payeOfficeNo:"120", payeRef:"NG88216", aoRef:"120PA00456791",
        claimsEmploymentAllowance:false }
    ],

    /* Several payrolls running alongside each other, each with its own
       frequency and its own periods. */
    schedules: [
      { id:"SCH-M-HEAD", code:"M-HEAD", name:"Monthly — head office",
        employerId:"EMP-HOLD", frequency:"monthly", weekStartsOn:1, payDay:28 },
      { id:"SCH-M-OPS",  code:"M-OPS",  name:"Monthly — operations",
        employerId:"EMP-LOG",  frequency:"monthly", weekStartsOn:1, payDay:28 },
      { id:"SCH-W-DRV",  code:"W-DRV",  name:"Weekly — drivers",
        employerId:"EMP-LOG",  frequency:"weekly", weekStartsOn:1, payDay:5 },
      { id:"SCH-W-CAS",  code:"W-CAS",  name:"Weekly — casual",
        employerId:"EMP-FM",   frequency:"weekly", weekStartsOn:1, payDay:5 },
      { id:"SCH-Q-DIR",  code:"Q-DIR",  name:"Quarterly — directors",
        employerId:"EMP-HOLD", frequency:"quarterly", weekStartsOn:1, payDay:28 }
    ],

    /* Casual staff submit hours; somebody else approves them. */
    timesheets: [
      { id:"TS-1", employeeId: people[6].id, weekStarting:"2026-08-17",
        status:"approved", submittedBy:"o.fletcher@northgate.example",
        approvedBy:"a.okafor@northgate.example",
        lines:[
          { workedOn:"2026-08-17", hours:7.5, rate:14.40 },
          { workedOn:"2026-08-19", hours:6.0, rate:14.40 },
          { workedOn:"2026-08-21", hours:8.0, rate:14.40 }
        ] },
      { id:"TS-2", employeeId: people[6].id, weekStarting:"2026-08-24",
        status:"submitted", submittedBy:"o.fletcher@northgate.example",
        approvedBy:null,
        lines:[
          { workedOn:"2026-08-24", hours:7.5, rate:14.40 },
          { workedOn:"2026-08-26", hours:7.5, rate:14.40 }
        ] }
    ],

    /* Occupational sick pay on top of SSP, with service bands. */
    absenceSchemes: [
      ABSENCE.makeScheme({ id:"OSP", name:"Occupational sick pay", kind:"sickness",
        bands:[
          { fromMonths:0,  fullWeeks:4,  halfWeeks:4,  label:"under 1 year" },
          { fromMonths:12, fullWeeks:8,  halfWeeks:8,  label:"1 to 2 years" },
          { fromMonths:24, fullWeeks:13, halfWeeks:13, label:"2 to 5 years" },
          { fromMonths:60, fullWeeks:26, halfWeeks:26, label:"5 years or more" }
        ] }),
      ABSENCE.makeScheme({ id:"OMP", name:"Enhanced maternity pay", kind:"maternity",
        windowType:"perOccurrence", windowMonths:0,
        bands:[
          { fromMonths:0,  fullWeeks:0, halfWeeks:0,  label:"under 1 year — statutory only" },
          { fromMonths:12, fullWeeks:8, halfWeeks:18, label:"1 year or more" }
        ] })
    ],
    absences: [
      // Long spell earlier in the year, so entitlement is partly consumed.
      /* Enough consumed earlier in the year that the current absence crosses
         from full pay into half — the case worth seeing, because it is the one
         an employee needs telling about before the payslip arrives. */
      { id:"ABS-1", employeeId: people[2].id, schemeId:"OSP", kind:"sickness",
        from:"2026-04-13", to:"2026-06-26", workingDays:55, fullPaidDays:55, halfPaidDays:0,
        reason:"Surgery and recovery", statutoryPaid:0 },
      // Current absence, which will cross from full pay into half.
      { id:"ABS-2", employeeId: people[2].id, schemeId:"OSP", kind:"sickness",
        from:"2026-08-10", to:"2026-08-28", workingDays:15, reason:"Ongoing", statutoryPaid:0 },
      { id:"ABS-3", employeeId: people[5].id, schemeId:"OSP", kind:"sickness",
        from:"2026-08-17", to:"2026-08-21", workingDays:5, reason:"Influenza", statutoryPaid:0 }
    ],
    runs: []
  };
}

/* ---------- schema migration ---------------------------------------------
   Saved data from an earlier version is missing fields the current code
   expects. Upgrade it in place rather than crashing or silently wiping it.
------------------------------------------------------------------------- */
const SCHEMA_VERSION = 5;

function migrate(old){
  if(!old || typeof old !== "object" || !Array.isArray(old.employees)) return null;
  const fresh = seedState("public");          // earlier versions were council-shaped
  const s = { ...old };
  s.schemaVersion = SCHEMA_VERSION;

  // --- organisation ---
  s.employer = { ...fresh.employer, ...(old.employer || {}) };
  if(!s.employer.shortName) s.employer.shortName = old.employer?.logoText || s.employer.name;
  delete s.employer.logoText;
  if(!s.employer.sector) s.employer.sector = "public";
  ["claimsEmploymentAllowance","smallEmployer","apprenticeshipLevy"].forEach(k => {
    if(typeof s.employer[k] !== "boolean") s.employer[k] = fresh.employer[k];
  });

  // --- config: fill any block added since ---
  s.config = { ...ENGINE.DEFAULT_CONFIG, ...(old.config || {}) };
  ["ni","studentLoans","autoEnrolment","statutory","employerReliefs"].forEach(k => {
    s.config[k] = { ...ENGINE.DEFAULT_CONFIG[k], ...(old.config?.[k] || {}) };
  });
  if(!s.config.payFrequency) s.config.payFrequency = "monthly";
  if(!s.config.region) s.config.region = "restOfUK";
  if(!Array.isArray(s.config.bands) || !s.config.bands.length) s.config.bands = ENGINE.DEFAULT_CONFIG.bands;
  if(!Array.isArray(s.config.scottishBands)) s.config.scottishBands = ENGINE.DEFAULT_CONFIG.scottishBands;
  delete s.config.personalAllowance;
  delete s.config.paTaperStart;

  // --- pension schemes: derive from the old per-employee rates ---
  if(!Array.isArray(s.schemes) || !s.schemes.length){
    const combos = new Map();
    (old.employees || []).forEach(e => {
      if(!e.pensionRate) return;
      const key = [e.pensionRate, e.pensionEmployerRate || 0, e.pensionMethod || "netPay"].join("|");
      if(!combos.has(key)) combos.set(key, { rate:e.pensionRate, er:e.pensionEmployerRate || 0, method:e.pensionMethod || "netPay", ids:[] });
      combos.get(key).ids.push(e.id);
    });
    s.schemes = [];
    let i = 0;
    for(const c of combos.values()){
      i++;
      s.schemes.push({
        id: "SCH" + i,
        name: i === 1 ? "Main pension scheme" : "Pension scheme " + i,
        provider: "other", basis: "pensionable", method: c.method,
        employeeRate: c.rate, employerRate: c.er,
        employerRef: "", groupRef: "", isDefault: i === 1
      });
      c.schemeId = "SCH" + i;
    }
    if(!s.schemes.length) s.schemes = fresh.schemes;
    // map employees onto the schemes just created
    const lookup = {};
    for(const c of combos.values()) c.ids.forEach(id => lookup[id] = c.schemeId);
    s.employees = (old.employees || []).map(e => ({ ...e, pensionSchemeId: lookup[e.id] || "" }));
  }

  // --- integrations ---
  s.integrations = { ...fresh.integrations, ...(old.integrations || {}) };

  // --- employees: renamed and added fields ---
  s.employees = (s.employees || []).map(e => {
    const n = { ...e };
    if(n.post && !n.jobTitle){ n.jobTitle = n.post; }
    delete n.post;
    if(typeof n.director !== "boolean") n.director = false;
    if(typeof n.bankHolidaysInEntitlement !== "boolean") n.bankHolidaysInEntitlement = false;
    if(n.leaveDays == null) n.leaveDays = 26;
    if(n.weeklyHours == null) n.weeklyHours = 37;
    if(n.daysPerWeek == null) n.daysPerWeek = 5;
    delete n.pensionRate; delete n.pensionEmployerRate; delete n.pensionMethod;
    return n;
  });

  // --- runs: payslip YTD gained a niable figure used by director NI ---
  s.runs = (s.runs || []).map(r => ({
    ...r,
    payslips: (r.payslips || []).map(ps => ({
      ...ps,
      ytd: { niable: ps.ytd?.taxable ?? 0, ...(ps.ytd || {}) }
    }))
  }));

  s.leave = Array.isArray(s.leave) ? s.leave : [];
  return s;
}

/* Structural guarantee. Runs on EVERY load regardless of schemaVersion, because
   a version stamp only tells you what wrote the data, not that it is complete.
   Trusting the stamp was a real bug: partial state skipped migration, crashed at
   boot, and because the bad state was saved a refresh never recovered. */
function normalise(s){
  if(!s || typeof s !== "object") s = {};
  const fresh = seedState("private");

  s.employer = { ...fresh.employer, ...(s.employer || {}) };
  if(!s.employer.shortName) s.employer.shortName = s.employer.name || "Employer";

  s.config = { ...ENGINE.DEFAULT_CONFIG, ...(s.config || {}) };
  ["ni","studentLoans","autoEnrolment","statutory","employerReliefs"].forEach(k => {
    s.config[k] = { ...ENGINE.DEFAULT_CONFIG[k], ...(s.config[k] || {}) };
  });
  if(!ENGINE.PAY_FREQUENCIES[s.config.payFrequency]) s.config.payFrequency = "monthly";
  if(!s.config.region) s.config.region = "restOfUK";
  if(!Array.isArray(s.config.bands) || !s.config.bands.length) s.config.bands = ENGINE.DEFAULT_CONFIG.bands;
  if(!Array.isArray(s.config.scottishBands) || !s.config.scottishBands.length) s.config.scottishBands = ENGINE.DEFAULT_CONFIG.scottishBands;
  s.config.bands.forEach(b => { if(b.limit == null) b.limit = Infinity; });
  s.config.scottishBands.forEach(b => { if(b.limit == null) b.limit = Infinity; });

  s.automation = { mode:"manual", policy:{}, log:[], notifications:[], ...(s.automation || {}) };
  s.automation.cover = { ...DEFAULT_COVER, ...(s.automation.cover || {}) };
  if(!(Number(s.automation.cover.releaseLimit) > 0)) s.automation.cover.releaseLimit = DEFAULT_COVER.releaseLimit;
  if(!MODES[s.automation.mode]) s.automation.mode = "manual";
  const basePolicy = defaultPolicy(s.automation.mode);
  s.automation.policy = { ...basePolicy, ...(s.automation.policy || {}) };
  AUTOMATION_RULES.forEach(r => { if(!TIERS[s.automation.policy[r.id]]) s.automation.policy[r.id] = basePolicy[r.id]; });
  if(!Array.isArray(s.automation.log)) s.automation.log = [];
  if(!Array.isArray(s.automation.notifications)) s.automation.notifications = [];

  s.integrations = { ...fresh.integrations, ...(s.integrations || {}) };
  ["rti","bacs","pension"].forEach(k => { s.integrations[k] = { ...fresh.integrations[k], ...(s.integrations[k] || {}) }; });

  if(!Array.isArray(s.schemes)) s.schemes = [];
  s.schemes = s.schemes.filter(x => x && x.id).map(x => ({
    id: x.id, name: x.name || "Pension scheme", provider: x.provider || "other",
    basis: ENGINE.PENSION_BASES[x.basis] ? x.basis : "qualifying",
    method: ENGINE.PENSION_METHODS[x.method] ? x.method : "reliefAtSource",
    employeeRate: Number(x.employeeRate) || 0, employerRate: Number(x.employerRate) || 0,
    qualifyingLower: x.qualifyingLower, qualifyingUpper: x.qualifyingUpper,
    employerRef: x.employerRef || "", groupRef: x.groupRef || "", isDefault: !!x.isDefault
  }));
  if(!s.schemes.length) s.schemes = fresh.schemes;
  if(!s.schemes.some(x => x.isDefault)) s.schemes[0].isDefault = true;

  if(!Array.isArray(s.employees)) s.employees = [];
  s.employees = s.employees.filter(e => e && e.id).map(e => ({
    ...e,
    name: e.name || "Unnamed",
    status: e.status || "active",
    weeklyHours: Number(e.weeklyHours) > 0 ? Number(e.weeklyHours) : 37.5,
    daysPerWeek: Number(e.daysPerWeek) > 0 ? Number(e.daysPerWeek) : 5,
    annualSalary: Number(e.annualSalary) || 0,
    taxCode: e.taxCode || "1257L",
    niCategory: e.niCategory || "A",
    studentLoanPlan: e.studentLoanPlan || "none",
    pensionSchemeId: s.schemes.some(x => x.id === e.pensionSchemeId) ? e.pensionSchemeId : "",
    director: !!e.director,
    postgradLoan: !!e.postgradLoan,
    pensionOptOut: !!e.pensionOptOut,
    bankHolidaysInEntitlement: e.bankHolidaysInEntitlement !== false,
    leaveDays: e.leaveDays == null ? 28 : Number(e.leaveDays),
    bankHolidayDays: e.bankHolidayDays == null ? 8 : Number(e.bankHolidayDays),
    carriedDays: Number(e.carriedDays) || 0,
    otherDeductions: Array.isArray(e.otherDeductions) ? e.otherDeductions : []
  }));

  const ids = new Set(s.employees.map(e => e.id));
  s.leave = (Array.isArray(s.leave) ? s.leave : []).filter(l => l && ids.has(l.employeeId));
  s.runs  = (Array.isArray(s.runs) ? s.runs : []).filter(r => r && typeof r.period === "number").map(r => ({
    ...r,
    decisions: r.decisions || {}, elements: r.elements || {},
    exceptions: Array.isArray(r.exceptions) ? r.exceptions : [],
    payslips: (Array.isArray(r.payslips) ? r.payslips : []).map(ps => ({
      ...ps, ytd: { niable: ps.ytd?.taxable ?? 0, ...(ps.ytd || {}) }
    })),
    totals: r.totals || { gross:0, net:0, tax:0, niEmployee:0, niEmployer:0, pension:0, pensionEr:0, employerCost:0 }
  }));

  const n = ENGINE.periodsPerYear(s.config);
  s.currentPeriod = Math.min(Math.max(1, Number(s.currentPeriod) || 1), n);
  s.preset = s.preset || "private";
  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

var S = (() => {
  const stored = DB.get(KEY, null);
  if(!stored) return seedState("private");
  try {
    const upgraded = stored.schemaVersion === SCHEMA_VERSION ? stored : (migrate(stored) || stored);
    return normalise(upgraded);
  } catch(err){
    console.warn("Saved data could not be read; starting fresh.", err);
    return seedState("private");
  }
})();
save();
refreshPeriods();

function save(){ DB.set(KEY, S); }
function emp(id){ return S.employees.find(e => e.id === id); }
function schemeFor(e){ return S.schemes.find(s => s.id === e.pensionSchemeId) || null; }
function defaultScheme(){ return S.schemes.find(s => s.isDefault) || S.schemes[0] || null; }
function activeEmployees(){ return S.employees.filter(e => e.status === "active"); }

/* ---------- seed leave records once employees exist ----------------------- */
function seedLeave(){
  if(S.leave.length || !S.employees.length || S.employees.length < 6) return;
  const h = e => (e.weeklyHours||37.5)/(e.daysPerWeek||5);
  const at = i => S.employees[Math.min(i, S.employees.length - 1)];
  const a0 = at(0), a2 = at(2), a5 = at(5);
  S.leave = [
    { id:uid(), employeeId:a0.id, from:"2026-04-20", to:"2026-04-21", hours:p2r(2*h(a0)), type:"annual", status:"approved" },
    { id:uid(), employeeId:a0.id, from:"2026-10-19", to:"2026-10-23", hours:p2r(5*h(a0)), type:"annual", status:"approved" },
    { id:uid(), employeeId:a2.id, from:"2026-08-10", to:"2026-08-14", hours:p2r(5*h(a2)), type:"annual", status:"approved" },
    { id:uid(), employeeId:a5.id, from:"2026-09-07", to:"2026-09-11", hours:p2r(5*h(a5)), type:"annual", status:"pending" }
  ];
  save();
}
function p2r(n){ return Math.round(n*100)/100; }
seedLeave();

/* ---------- YTD from committed runs --------------------------------------- */
function ytdFor(employeeId, uptoPeriod){
  const blank = { gross:0, taxable:0, niable:0, tax:0, niEmployee:0, niEmployer:0, pension:0, pensionEr:0, studentLoan:0, net:0 };
  const runs = S.runs.filter(r => r.period < uptoPeriod && r.committed).sort((a,b) => a.period - b.period);
  let y = blank;
  for(const run of runs){
    const ps = run.payslips.find(p => p.employeeId === employeeId);
    if(ps) y = ps.ytd;
  }
  return y;
}
function priorPayslip(employeeId, period){
  const runs = S.runs.filter(r => r.period < period && r.committed).sort((a,b) => b.period - a.period);
  for(const run of runs){
    const ps = run.payslips.find(p => p.employeeId === employeeId);
    if(ps) return ps;
  }
  return null;
}
function runFor(period){ return S.runs.find(r => r.period === period); }

/* ============================================================================
   NAVIGATION
   ========================================================================== */
let VIEW = "dashboard";
function go(v){
  VIEW = v;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.view === v));
  render();
  if(window.scrollTo) try{ window.scrollTo(0,0); }catch(e){}
}
function render(){
  const el = document.getElementById("app");
  const views = {
    dashboard: viewDashboard, employees: viewEmployees, payroll: viewPayroll,
    leave: viewLeave, payslips: viewPayslips, pensions: viewPensions,
    group: viewGroup, absence: viewAbsence, automation: viewAutomation, journal: viewJournal,
    integrations: viewIntegrations, settings: viewSettings
  };
  try {
    el.innerHTML = (views[VIEW] || views.dashboard)();
    bind();
  } catch(err){
    console.error("Render failed on view '" + VIEW + "':", err);
    el.innerHTML = `
      <div class="masthead" style="border-top-color:var(--high)">
        <div class="mast-top"><span class="eyebrow">Something went wrong</span></div>
        <div class="mast-body"><div><h1>This screen could not load</h1></div></div>
      </div>
      <div class="panelbox">
        <p style="margin:0 0 8px">The saved data in this browser does not match what this screen expects.
        That usually means it was created by an earlier version.</p>
        <div class="evidence" style="margin:14px 0">${esc(String(err && err.message || err))}</div>
        <p style="margin:0 0 16px;color:var(--ink2);font-size:14px">
          Export a backup first if the data matters — then reload with a clean set.</p>
        <div class="actions">
          <button class="btn" id="errExport">Export backup (JSON)</button>
          <button class="btn primary" id="errReset">Reset and reload</button>
        </div>
      </div>`;
    const ex = document.getElementById("errExport");
    if(ex) ex.addEventListener("click", () => download("hr-payroll-backup.json", JSON.stringify(S, null, 2), "application/json"));
    const rs = document.getElementById("errReset");
    if(rs) rs.addEventListener("click", () => { DB.clear(); location.reload(); });
  }
}

/* ============================================================================
   DASHBOARD
   ========================================================================== */
function viewDashboard(){
  const active = activeEmployees();
  const period = PERIODS[S.currentPeriod - 1];
  const run = runFor(S.currentPeriod);
  const pending = S.leave.filter(l => l.status === "pending").length;
  const paybill = active.reduce((s,e) => s + (e.annualSalary||0), 0);

  const lastCommitted = S.runs.filter(r => r.committed).sort((a,b) => b.period - a.period)[0];

  return `
  ${mast("Overview", S.employer.name, [
    ["Active employees", String(active.length)],
    ["Annual pay bill", money(paybill,0)],
    ["Mode", MODES[S.automation.mode].label]
  ])}
  <div class="counters">
    ${counter(String(active.length), "On payroll")}
    ${counter(period.label, "Period " + S.currentPeriod, true)}
    ${counter(run ? (run.committed ? "Committed" : "In progress") : "Not started", "Run status", true)}
    ${counter(String(pending), "Leave awaiting approval")}
  </div>
  ${run ? `<div class="counters" style="border-top:1px solid var(--rule)">
    ${counter(touchlessRate({payslips:run.payslips,exceptions:run.exceptions,decisions:run.decisions,actions:run.actions||[]}).rate.toFixed(1) + "%", "Touchless this period")}
    ${counter(String((run.actions||[]).filter(x=>x.tier!=="propose").length), "Handled automatically")}
    ${counter(String((run.actions||[]).filter(x=>x.tier==="propose").length), "Proposed for review")}
    ${counter(String(S.automation.log.filter(l=>!l.reversed).length), "Total automated actions")}
  </div>` : ""}

  <div class="sec-head"><h2>Next steps</h2></div>
  <div class="ledger">
    ${!run ? actionRow("Run " + period.label + " payroll", "Calculate gross to net for " + active.length + " employees, review exceptions, then commit.", "payroll", "Open payroll") : ""}
    ${run && !run.committed ? actionRow("Review " + period.label, run.exceptions.filter(x => !run.decisions[x.ref]).length + " exceptions still need a decision before the run can be committed.", "payroll", "Continue review") : ""}
    ${run && run.committed ? actionRow("Post " + period.label + " to your accounts", "The accounting journal is ready — " + money(run.totals.employerCost,0) + " of employment cost, balanced and exportable to Sage, Xero or CSV.", "journal", "View journal") : ""}
    ${run && run.committed ? actionRow(period.label + " is committed", "Payslips are available to employees. " + money(run.totals.net) + " net across " + run.payslips.length + " records.", "payslips", "View payslips") : ""}
    ${pending ? actionRow(pending + " leave request" + (pending>1?"s":"") + " awaiting approval", "Requests are not deducted from balances until approved.", "leave", "Review leave") : ""}
    ${!S.integrations.rti.credentialsSet ? actionRow("Connect HMRC, BACS and pensions", "Three external approvals stand between this system and paying people. The data for each is already produced.", "integrations", "Open integrations") : ""}
    ${actionRow("Check tax year settings", "Rates default to " + S.config.taxYear + ". Verify against HMRC before any live use.", "settings", "Open settings")}
  </div>

  ${lastCommitted ? `
  <div class="sec-head"><h2>Last committed run</h2><span class="eyebrow">${esc(PERIODS[lastCommitted.period-1].label)}</span></div>
  <div class="counters">
    ${counter(money(lastCommitted.totals.gross,0), "Gross")}
    ${counter(money(lastCommitted.totals.net,0), "Net paid")}
    ${counter(money(lastCommitted.totals.tax + lastCommitted.totals.niEmployee + (lastCommitted.reliefs?.employerNIPayable ?? lastCommitted.totals.niEmployer), 0), "Due to HMRC")}
    ${counter(money(lastCommitted.totals.employerCost,0), "Total cost")}
  </div>` : ""}

  ${banner()}
  `;
}
function actionRow(title, sub, view, cta){
  return `<div class="prow"><span><b>${esc(title)}</b><span class="r-sub">${esc(sub)}</span></span>
    <span></span><span></span><button class="btn sm" data-go="${view}">${esc(cta)}</button></div>`;
}

/* ============================================================================
   EMPLOYEES
   ========================================================================== */
function viewEmployees(){
  const rows = S.employees.map(e => {
    const bal = ENGINE.leaveBalance(e, S.leave, todayISO());
    return `<div class="prow" data-emp="${e.id}">
      <span><b>${esc(e.name)}</b><span class="r-sub">${esc(e.payrollNumber)} · ${esc(e.jobTitle||"—")} · ${esc(e.department||"—")}${e.director ? " · director" : ""}</span></span>
      <span class="m">${money(e.annualSalary||0,0)}</span>
      <span class="m">${bal.days(bal.available).toFixed(1)} d</span>
      <span>${e.status === "active"
        ? (e.leavingDate ? `<span class="status st-pending">leaving</span>` : `<span class="status st-approved">active</span>`)
        : `<span class="status st-taken">${esc(e.status)}</span>`}</span>
      <button class="btn sm" data-edit="${e.id}">Edit</button>
    </div>`;
  }).join("");

  return `
  ${mast("People", "Employee records", [
    ["Total", String(S.employees.length)],
    ["Active", String(activeEmployees().length)],
    ["Leavers pending", String(S.employees.filter(e => e.leavingDate).length)]
  ])}
  <div class="sec-head"><h2>All employees</h2><button class="btn" data-add="1">Add employee</button></div>
  <div class="ledger">
    <div class="prow head"><span>Name</span><span>Salary</span><span>Leave left</span><span>Status</span><span></span></div>
    ${rows || `<div class="prow"><span class="r-sub">No employees yet.</span></div>`}
  </div>
  ${banner()}`;
}

function employeeForm(e){
  const f = (label, key, type="text", extra="") =>
    `<div class="field"><label>${label}</label><input type="${type}" data-f="${key}" value="${esc(e[key] ?? "")}" ${extra}></div>`;
  const sel = (label, key, opts) =>
    `<div class="field"><label>${label}</label><select data-f="${key}">${opts.map(([v,t]) =>
      `<option value="${v}" ${String(e[key]) === String(v) ? "selected" : ""}>${t}</option>`).join("")}</select></div>`;

  return `
  <div class="formgrid">
    <div class="fs"><h4>Identity</h4>
      ${f("Full name","name")} ${f("Payroll number","payrollNumber")}
      ${f("NI number","niNumber")} ${f("Date of birth","dob","date")}
    </div>
    <div class="fs"><h4>Employment</h4>
      ${f("Job title","jobTitle")} ${f("Department","department")}
      ${f("Start date","startDate","date")} ${f("Leaving date","leavingDate","date")}
      ${sel("Status","status",[["active","Active"],["leaver","Leaver"],["suspended","Suspended"]])}
      ${sel("Company director","director",[[false,"No"],[true,"Yes — annual NI basis"]])}
    </div>
    <div class="fs"><h4>Pay</h4>
      ${f("Annual salary (£)","annualSalary","number",'step="1"')}
      ${f("Weekly hours","weeklyHours","number",'step="0.5"')}
      ${f("Days per week","daysPerWeek","number",'step="0.5"')}
    </div>
    <div class="fs"><h4>Tax and NI</h4>
      ${f("Tax code","taxCode")}
      ${sel("NI category","niCategory",[["A","A — standard"],["B","B — reduced rate"],["C","C — over pension age"],["H","H — apprentice under 25"],["M","M — under 21"],["X","X — no NI"]])}
      ${sel("Student loan","studentLoanPlan",[["none","None"],["plan1","Plan 1"],["plan2","Plan 2"],["plan4","Plan 4 (Scotland)"],["plan5","Plan 5"]])}
      ${sel("Postgraduate loan","postgradLoan",[[false,"No"],[true,"Yes"]])}
    </div>
    <div class="fs"><h4>Pension</h4>
      ${sel("Scheme","pensionSchemeId",[["","Not enrolled"]].concat(S.schemes.map(s => [s.id, s.name])))}
      ${sel("Opted out of auto-enrolment","pensionOptOut",[[false,"No"],[true,"Yes"]])}
      <div class="hint">Rates and earnings basis come from the scheme, not the employee. Change them under Pensions.</div>
    </div>
    <div class="fs"><h4>Payment</h4>
      ${f("Sort code","bankSort")} ${f("Account number","bankAccount")}
    </div>
    <div class="fs"><h4>Leave</h4>
      ${f("Annual entitlement (days)","leaveDays","number",'step="0.5"')}
      ${sel("Bank holidays","bankHolidaysInEntitlement",[[true,"Included in the figure above"],[false,"On top of the figure above"]])}
      ${f("Bank holidays (days)","bankHolidayDays","number",'step="0.5"')}
      ${f("Carried over (days)","carriedDays","number",'step="0.5"')}
      <div class="hint">Statutory minimum is 5.6 weeks including bank holidays — 28 days for a 5-day week.</div>
    </div>
  </div>`;
}

/* ============================================================================
   PAYROLL
   ========================================================================== */
function calculateRun(period){
  const p = PERIODS[period - 1];
  const existing = runFor(period);
  const elements = existing ? existing.elements : {};
  const employees = S.employees.filter(e =>
    e.status === "active" &&
    (!e.startDate || e.startDate <= p.end)
  );

  const payslips = employees.map(e => ENGINE.calcPayslip({
    employee: e, period,
    elements: elements[e.id] || [],
    ytd: ytdFor(e.id, period),
    scheme: schemeFor(e),
    config: S.config
  }));

  const priors = {};
  employees.forEach(e => { const pp = priorPayslip(e.id, period); if(pp) priors[e.id] = pp; });

  const exceptions = ENGINE.detectExceptions({
    payslips, employees, priorPayslips: priors, period: p, schemes: S.schemes, config: S.config
  });

  /* Absence and leave raise their own exceptions into the same gate. A payroll
     run is not clear because the arithmetic worked — it is clear when nobody
     is being paid something they should not be. */
  safely("absence exceptions", function(){
    exceptions.push(...ABSENCE.absenceExceptions({
      employees, schemes: S.absenceSchemes || [], absences: S.absences || [],
      period: { start: p.start, end: p.end }, config: S.config }));
  });
  safely("leave exceptions", function(){
    exceptions.push(...LEAVE.leaveExceptions({
      employees, schemes: S.leaveSchemes || [], memberships: S.leaveMemberships || [],
      requests: (S.leave || []).map(r => ({ ...r, schemeId: r.schemeId ||
        (S.leaveMemberships || []).find(m => m.employeeId === r.employeeId)?.schemeId })),
      leaveYear: S.leaveYear || { starts:"2026-04-01", ends:"2027-03-31" },
      carriedIn: S.leaveCarriedIn || {}, asAt: p.end }));
  });

  const totals = payslips.reduce((t, ps) => ({
    gross: t.gross + ps.gross, net: t.net + ps.net,
    tax: t.tax + ps.paye.tax, niEmployee: t.niEmployee + ps.ni.employee,
    niEmployer: t.niEmployer + ps.ni.employer, pension: t.pension + ps.pension.employee,
    pensionEr: t.pensionEr + ps.pension.employer, employerCost: t.employerCost + ps.employerCost
  }), { gross:0, net:0, tax:0, niEmployee:0, niEmployer:0, pension:0, pensionEr:0, employerCost:0 });
  Object.keys(totals).forEach(k => totals[k] = ENGINE.p2(totals[k]));

  // Employment Allowance is an employer-level relief, applied across the run
  const usedToDate = S.runs.filter(r => r.period < period && r.committed)
                           .reduce((s,r) => s + (r.reliefs?.employmentAllowanceClaimed || 0), 0);
  const reliefs = ENGINE.applyEmployerReliefs({
    totalEmployerNI: totals.niEmployer, allowanceUsedToDate: usedToDate,
    org: S.employer, config: S.config
  });

  const actions = evaluateAutomations({
    employees, payslips, exceptions, schemes: S.schemes, leave: S.leave,
    period: p, policy: S.automation.policy, config: S.config,
    lastRun: S.runs.filter(r => r.period < period && r.committed).sort((a,b) => b.period - a.period)[0]
  });

  const run = {
    period, payslips, exceptions, totals, elements, reliefs, actions,
    decisions: existing ? existing.decisions : {},
    committed: existing ? existing.committed : false,
    committedAt: existing ? existing.committedAt : null,
    held: existing ? existing.held : []
  };
  const i = S.runs.findIndex(r => r.period === period);
  if(i >= 0) S.runs[i] = run; else S.runs.push(run);
  save();

  // Apply anything at notify or apply tier, once, then recalculate if state changed
  if(!run.committed){
    const auto = actions.filter(x => x.tier === "notify" || x.tier === "apply");
    let changed = false;
    auto.forEach(x => { if(applyAction(x, run, true)) changed = true; });
    if(changed){ save(); return calculateRun(period); }
  }
  save();
  return run;
}

function viewPayroll(){
  const period = S.currentPeriod;
  const p = PERIODS[period - 1];
  const run = runFor(period);

  const periodPicker = `<select id="periodPick">${PERIODS.map(x => {
    const r = runFor(x.n);
    const tag = r ? (r.committed ? " ✓" : " …") : "";
    return `<option value="${x.n}" ${x.n === period ? "selected" : ""}>${x.label}${tag}</option>`;
  }).join("")}</select>`;

  if(!run){
    return `
    ${mast("Payroll", p.label, [["Period", String(period)],["Pay date", fmtD(p.payDate)],["Employees", String(activeEmployees().length)]])}
    <div class="sec-head"><h2>Pay period</h2><div class="field inline">${periodPicker}</div></div>
    <div class="panelbox">
      <p style="margin:0 0 16px;max-width:70ch;color:var(--ink2)">Nothing calculated for this period yet. Calculating produces a payslip for every active employee, then checks the whole run for exceptions before anything can be committed.</p>
      <button class="btn primary" id="calcBtn">Calculate ${esc(p.label)}</button>
    </div>
    ${banner()}`;
  }

  const open = run.exceptions.filter(x => !run.decisions[x.ref]).length;
  const held = run.exceptions.filter(x => run.decisions[x.ref]?.type === "hold").flatMap(x => x.employeeIds);
  const heldSet = new Set(held);

  return `
  ${mast("Payroll", p.label, [
    ["Gross", money(run.totals.gross,0)],
    ["Net", money(run.totals.net,0)],
    ["Employer cost", money(run.totals.employerCost,0)]
  ], gate(run, open, heldSet.size))}

  <div class="counters">
    ${counter(String(run.payslips.length), "Payslips calculated")}
    ${counter(String(open), "Awaiting decision")}
    ${counter(String(heldSet.size), "Held from run")}
    ${counter(money(run.totals.tax + run.totals.niEmployee + (run.reliefs?.employerNIPayable ?? run.totals.niEmployer), 0), "Due to HMRC")}
  </div>

  <div class="sec-head"><h2>Pay period</h2>
    <div class="row-tools">
      <div class="field inline">${periodPicker}</div>
      ${!run.committed ? `<button class="btn" id="calcBtn">Recalculate</button>
      <button class="btn" id="addElBtn">Add pay element</button>` : ""}
    </div>
  </div>

  <div class="sec-head"><h2>Exceptions</h2><span class="eyebrow">${run.exceptions.length} raised</span></div>
  <div class="ledger" id="exList">
    ${run.exceptions.length ? run.exceptions.map(x => exceptionRow(x, run)).join("")
      : `<div class="prow"><span class="r-sub">No exceptions raised. Every record passed the rule checks and variance comparison.</span></div>`}
  </div>

  <div class="sec-head"><h2>Payslips in this run</h2><span class="eyebrow">Click to view</span></div>
  <div class="ledger">
    <div class="prow head"><span>Employee</span><span>Gross</span><span>Net</span><span></span></div>
    ${run.payslips.map(ps => {
      const e = emp(ps.employeeId);
      const isHeld = heldSet.has(ps.employeeId);
      return `<div class="prow ${isHeld ? "muted" : ""}">
        <span><b>${esc(e?.name || "?")}</b><span class="r-sub">${esc(e?.payrollNumber||"")} · ${esc(e?.department||"")}${isHeld ? " · HELD" : ""}</span></span>
        <span class="m">${money(ps.gross)}</span>
        <span class="m">${money(ps.net)}</span>
        <button class="btn sm" data-slip="${ps.employeeId}|${period}">View</button>
      </div>`;
    }).join("")}
  </div>

  ${!run.committed ? `
  <div class="panelbox" style="margin-top:22px">
    <h3 style="margin:0 0 8px;font-family:var(--cond);font-size:15px;letter-spacing:.05em;text-transform:uppercase">Commit the run</h3>
    <p style="margin:0 0 16px;max-width:70ch;color:var(--ink2);font-size:14px">
      Committing locks the payslips, writes year-to-date figures, and makes payslips visible to employees.
      ${open ? `<b style="color:var(--high)">${open} exception${open>1?"s":""} still need a decision.</b>` : `All exceptions decided.`}
      In a live system this is also the point at which the FPS would be submitted to HMRC and the BACS file generated.
    </p>
    <button class="btn primary" id="commitBtn" ${open ? "disabled" : ""}>Commit ${esc(p.label)}</button>
  </div>` : `
  <div class="panelbox" style="margin-top:22px">
    <div class="flag ok"><b>Committed ${esc(new Date(run.committedAt).toLocaleString("en-GB"))}.</b>
    Year-to-date figures are written and payslips are available. ${heldSet.size ? heldSet.size + " record(s) were held and excluded." : ""}</div>
    <div class="actions"><button class="btn" id="uncommitBtn">Reopen run</button>
    <button class="btn" data-export="fps">Export FPS data (CSV)</button>
    <button class="btn" data-export="bacs">Export BACS data (CSV)</button></div>
  </div>`}
  ${banner()}`;
}

function gate(run, open, held){
  const cls = open === 0 ? "is-open" : "";
  const txt = run.committed ? "Committed" : (open === 0 ? "Gate open" : "Gate held");
  const note = run.committed
    ? "This run is locked. Reopen it to make changes."
    : open === 0
      ? `All exceptions decided. ${run.payslips.length - held} record${run.payslips.length-held===1?"":"s"} authorised.`
      : `${open} exception${open>1?"s":""} awaiting a decision. The run cannot be committed until each is resolved by a named officer.`;
  const segs = run.exceptions.map(x => {
    const d = run.decisions[x.ref];
    return `<div class="seg ${d ? "d-"+d.type : ""}" title="${esc(x.ref)}"></div>`;
  }).join("") || `<div class="seg d-release"></div>`;
  return `<div class="meter-wrap">
    <div class="meter-head">
      <span class="meter-status ${cls}"><span class="dot"></span>${txt}</span>
      <span class="meter-note">${esc(note)}</span>
    </div>
    <div class="segbar">${segs}</div>
  </div>`;
}

function exceptionRow(x, run){
  const d = run.decisions[x.ref];
  return `<div class="row ${d ? "settled" : ""}" data-ex="${x.ref}">
    <button class="row-btn">
      <span class="r-ref">${x.ref}</span>
      <span class="chip ${x.severity}">${x.severity}</span>
      <span><span class="r-title">${esc(x.title)}</span><span class="r-sub">${esc(x.subject)} · ${x.kind === "rule" ? "rule check" : "pattern comparison"}</span></span>
      <span class="r-amt ${x.amount ? "" : "nil"}">${x.amount ? money(x.amount,0) : "—"}</span>
      <span class="chev">›</span>
    </button>
    <div class="detail">
      <div class="p-block"><div class="p-l">Why this was flagged</div><div class="p-t">${esc(x.why)}</div></div>
      <div class="p-block"><div class="p-l">Evidence</div><div class="evidence">
        ${x.evidence.map(r => `<div><span>${esc(r[0])}</span> · ${esc(r[1])}</div>`).join("")}
      </div></div>
      <div class="p-block"><div class="p-l">Recommended handling</div><div class="p-t">${esc(x.action)}</div></div>
      ${d ? `<div class="decided"><span><b>${d.type === "hold" ? "Held from run" : d.type === "release" ? "Released" : "Dismissed"}</b> at ${esc(d.time)} by ${esc(d.by)}</span>
             ${run.committed ? "" : `<button class="undo" data-undo="${x.ref}">Reopen</button>`}</div>`
        : `<div class="actions">
            <button class="btn primary" data-dec="${x.ref}|hold">Hold from run</button>
            <button class="btn" data-dec="${x.ref}|release">Release with note</button>
            <button class="btn" data-dec="${x.ref}|dismiss">Dismiss — not an error</button>
          </div>`}
    </div>
  </div>`;
}

/* ============================================================================
   LEAVE
   ========================================================================== */
function viewLeave(){
  const pending = S.leave.filter(l => l.status === "pending");
  const balances = activeEmployees().map(e => {
    const b = ENGINE.leaveBalance(e, S.leave, todayISO());
    return { e, b };
  });
  const atRisk = balances.filter(x => x.b.carriedRemaining > 0);

  return `
  ${mast("Leave", "Absence and entitlement", [
    ["Awaiting approval", String(pending.length)],
    ["Carry-over at risk", String(atRisk.length)],
    ["Leave year", "1 Apr 2026 – 31 Mar 2027"]
  ])}

  <div class="sec-head"><h2>Leave schemes</h2>
    <span class="eyebrow">${(S.leaveSchemes || []).length} schemes in use</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Scheme</span><span>Entitlement</span><span>Carry-over</span><span>On it</span><span></span></div>
    ${(S.leaveSchemes || []).map(s => {
      const on = (S.leaveMemberships || []).filter(m => m.schemeId === s.id).length;
      const ent = s.accrual === "irregularHours"
        ? "12.07% of hours worked"
        : (s.entitlementWeeks != null
            ? s.entitlementWeeks + " weeks"
            : s.entitlementDays + " days") +
          (s.bankHolidaysIncluded ? " incl. bank holidays" : " plus " + s.bankHolidayDays + " bank holidays");
      // Judged against 5.6 weeks only where the scheme counts toward it.
      let unlawful = false;
      safely("stat", () => {
        if(s.countsTowardStatutory && s.accrual !== "irregularHours"){
          const days = s.entitlementDays != null ? s.entitlementDays : s.entitlementWeeks * 5;
          const bh = s.bankHolidaysIncluded ? 0 : s.bankHolidayDays;
          unlawful = (days + bh) < LEAVE.statutoryMinimumDays(5);
        }
      });
      return `<div class="lrow">
        <div><b>${esc(s.name)}</b><span class="note">${esc(s.kind)}${s.paid ? "" : " · unpaid"}${
          s.countsTowardStatutory ? "" : " · does not count toward the statutory minimum"}</span></div>
        <span class="m">${esc(ent)}</span>
        <span class="m">${s.carryOverMaxDays ? s.carryOverMaxDays + " days, " + s.carryOverExpiresAfterMonths + " months" : "none"}</span>
        <span class="m">${on}</span>
        <span>${unlawful ? '<span class="status st-pending">below statutory</span>' : ""}</span>
      </div>`;
    }).join("")}
  </div>

  <div class="sec-head" style="margin-top:34px"><h2>Entitlement by person</h2>
    <span class="eyebrow">Held in hours, because a day is not a day</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Employee</span><span>Scheme</span><span>Hours a day</span><span>Entitlement</span><span>Available</span></div>
    ${activeEmployees().map(e => {
      const m = (S.leaveMemberships || []).find(x => x.employeeId === e.id);
      const scheme = (S.leaveSchemes || []).find(s => s.id === (m && m.schemeId));
      if(!scheme) return "";
      let b = null;
      safely("balance", () => {
        b = LEAVE.balanceFor({
          employee: { ...e, startedOn: e.startDate }, scheme,
          leaveYear: S.leaveYear || { starts:"2026-04-01", ends:"2027-03-31" },
          requests: (S.leave || []).map(r => ({ ...r, schemeId: r.schemeId || scheme.id })),
          carriedIn: (S.leaveCarriedIn || {})[e.id] ? (S.leaveCarriedIn[e.id][scheme.id]) : null,
          hoursWorkedInYear: (S.hoursWorkedInYear || {})[e.id] || 0,
          asAt: todayISO() });
      });
      if(!b) return "";
      return `<div class="lrow">
        <div><b>${esc(e.name)}</b><span class="note">${e.weeklyHours} hours over ${e.daysPerWeek} days</span></div>
        <span class="m">${esc(scheme.name)}</span>
        <span class="m">${b.hoursPerDay.toFixed(2)}</span>
        <span class="m">${b.entitlement.entitlementHours.toFixed(1)} hrs</span>
        <span class="m">${b.availableDays.toFixed(1)} days${
          b.carriedRemainingHours > 0 ? " <span class='note'>+" +
          (b.carriedRemainingHours / b.hoursPerDay).toFixed(1) + " carried</span>" : ""}</span>
      </div>`;
    }).join("")}
  </div>

  <div class="gov" style="margin-bottom:34px">
    <span class="eyebrow">Why hours and not days</span>
    <p>Two people on a five-day week, one contracted for 43.75 hours and one for 35, both take
    "a day" and it costs them different amounts. Holding entitlement in days and converting at
    the end is how part-time and compressed-hours staff end up short-changed.</p>
    <p><strong>The statutory minimum is 5.6 weeks capped at 28 days</strong>, not 28 days for
    everyone. Somebody working three days a week is entitled to 16.8 days, and the cap never
    applies to them. Irregular-hours staff accrue <strong>12.07% of hours worked</strong>,
    following <i>Harpur Trust v Brazel</i>.</p>
  </div>

  <div class="sec-head"><h2>Request time off</h2></div>
  <div class="panelbox">
    <div class="frow">
      <div class="field"><label>Employee</label><select id="lvEmp">
        ${activeEmployees().map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}
      </select></div>
      <div class="field"><label>First day</label><input type="date" id="lvFrom" value="2026-09-21"></div>
      <div class="field"><label>Last day</label><input type="date" id="lvTo" value="2026-09-25"></div>
      <div class="field"><label>Part days</label><select id="lvHalf">
        <option value="none">Full days</option><option value="start">Half at start</option>
        <option value="end">Half at end</option><option value="both">Half both ends</option>
      </select></div>
      <div class="field"><label>Type</label><select id="lvType">
        <option value="annual">Annual leave</option><option value="carried">Carried-over</option>
        <option value="unpaid">Unpaid leave</option><option value="sick">Sickness</option>
      </select></div>
      <button class="btn primary" id="lvSubmit">Submit request</button>
    </div>
    <div class="calcbox" id="lvCalc"></div>
  </div>

  ${pending.length ? `
  <div class="sec-head"><h2>Awaiting approval</h2><span class="eyebrow">${pending.length} open</span></div>
  <div class="ledger">
    ${pending.map(l => {
      const e = emp(l.employeeId); if(!e) return "";
      const b = ENGINE.leaveBalance(e, S.leave, todayISO());
      const after = ENGINE.p2(b.available);
      return `<div class="prow">
        <span><b>${esc(e.name)}</b><span class="r-sub">${fmtD(l.from)} – ${fmtD(l.to)} · ${l.hours.toFixed(1)} hrs · ${esc(l.type)}</span></span>
        <span class="m">${b.days(after).toFixed(1)} d left</span>
        <span><button class="btn sm" data-lv="${l.id}|approve">Approve</button></span>
        <button class="btn sm" data-lv="${l.id}|reject">Reject</button>
      </div>`;
    }).join("")}
  </div>` : ""}

  <div class="sec-head"><h2>Balances</h2><span class="eyebrow">Held in hours</span></div>
  <div class="ledger">
    <div class="prow head"><span>Employee</span><span>Entitlement</span><span>Taken</span><span>Available</span></div>
    ${balances.map(({e,b}) => `<div class="prow">
      <span><b>${esc(e.name)}</b><span class="r-sub">${b.hoursPerDay.toFixed(1)} hrs/day${b.carriedRemaining > 0 ? ` · ${b.days(b.carriedRemaining).toFixed(1)} d carried expires 30 Sep` : ""}</span></span>
      <span class="m">${b.total.toFixed(1)} h</span>
      <span class="m">${b.taken.toFixed(1)} h</span>
      <span class="m"><b>${b.days(b.available).toFixed(1)} d</b> · ${b.available.toFixed(1)} h</span>
    </div>`).join("")}
  </div>

  <div class="sec-head"><h2>All records</h2></div>
  <div class="ledger">
    ${S.leave.length ? S.leave.slice().sort((a,b) => b.from.localeCompare(a.from)).map(l => {
      const e = emp(l.employeeId);
      return `<div class="prow">
        <span><b>${esc(e?.name||"?")}</b><span class="r-sub">${fmtD(l.from)} – ${fmtD(l.to)} · ${esc(l.type)}</span></span>
        <span class="m">${l.hours.toFixed(1)} h</span>
        <span><span class="status st-${l.status === "approved" ? "approved" : l.status === "pending" ? "pending" : "taken"}">${l.status}</span></span>
        <button class="btn sm" data-lvdel="${l.id}">Delete</button>
      </div>`;
    }).join("") : `<div class="prow"><span class="r-sub">No leave recorded.</span></div>`}
  </div>
  ${banner()}`;
}

function lvCalc(){
  const box = document.getElementById("lvCalc");
  if(!box) return;
  const e = emp(document.getElementById("lvEmp").value);
  const from = document.getElementById("lvFrom").value;
  const to = document.getElementById("lvTo").value;
  const half = document.getElementById("lvHalf").value;
  const type = document.getElementById("lvType").value;
  if(!e || !from || !to){ box.classList.remove("show"); return; }

  const b = ENGINE.leaveBalance(e, S.leave, todayISO());
  const lv = ENGINE.leaveHours(from, to, half, b.hoursPerDay);
  if(!lv || lv.days <= 0){
    box.classList.add("show");
    box.innerHTML = `<div class="flag bad">That range contains no working days.</div>`;
    return;
  }
  const after = ENGINE.p2(b.available - (type === "unpaid" || type === "sick" ? 0 : lv.hours));
  const hourly = (e.annualSalary || 0) / 52.143 / (e.weeklyHours || 37);

  let flags = "";
  if(type === "carried"){
    flags += b.carriedRemaining >= lv.hours
      ? `<div class="flag ok"><b>Drawn from carried-over leave.</b> Uses ${lv.days.toFixed(1)} of the ${b.days(b.carriedRemaining).toFixed(1)} days that expire on 30 September.</div>`
      : `<div class="flag bad"><b>Only ${b.days(b.carriedRemaining).toFixed(1)} days of carried leave remain.</b> The excess would come from this year's entitlement.</div>`;
  }
  if(type === "unpaid"){
    flags += `<div class="flag"><b>This creates a payroll instruction.</b> ${lv.hours.toFixed(1)} unpaid hours at ${money(hourly)} reduces gross pay by ${money(lv.hours * hourly)} in the next uncommitted run, and reduces pensionable pay with it.</div>`;
  }
  if(lv.bank > 0){
    flags += `<div class="flag ok"><b>${lv.bank} bank holiday${lv.bank>1?"s":""} excluded.</b> These are applied automatically and are not charged twice.</div>`;
  }
  if(after < 0 && type !== "unpaid" && type !== "sick"){
    flags += `<div class="flag bad"><b>This exceeds the available balance by ${Math.abs(after).toFixed(1)} hours.</b> It can still be submitted, but needs authorisation above the balance.</div>`;
  }

  box.classList.add("show");
  box.innerHTML = `
    <div class="calcline"><span>Working days</span><span>${lv.working}</span></div>
    <div class="calcline"><span>Weekend days excluded</span><span>${lv.weekend}</span></div>
    <div class="calcline"><span>Bank holidays excluded</span><span>${lv.bank}</span></div>
    <div class="calcline total"><span>Deducted</span><span>${lv.days.toFixed(1)} d · ${lv.hours.toFixed(1)} hrs</span></div>
    <div class="calcline"><span>Balance after</span><span>${type === "unpaid" || type === "sick" ? "unchanged" : `${b.days(after).toFixed(1)} d · ${after.toFixed(1)} hrs`}</span></div>
    ${flags}`;
}

/* ============================================================================
   PAYSLIPS
   ========================================================================== */
var slipFilter = "";

function viewPayslips(){
  const committed = S.runs.filter(r => r.committed).sort((a,b) => b.period - a.period);
  const draft = S.runs.filter(r => !r.committed && r.payslips?.length).sort((a,b) => b.period - a.period);
  const all = [...draft, ...committed];
  const match = ps => !slipFilter || ps.employeeId === slipFilter;
  const totalShown = all.reduce((n,r) => n + r.payslips.filter(match).length, 0);

  const block = (run, isDraft) => {
    const rows = run.payslips.filter(match);
    if(!rows.length) return "";
    const p = PERIODS[run.period - 1];
    return `
    <div class="sec-head">
      <h2>${esc(p.label)}${isDraft ? " — draft" : ""}</h2>
      <span class="eyebrow">${isDraft ? "not committed yet" : "paid " + fmtD(p.payDate)} · ${rows.length} payslip${rows.length===1?"":"s"}</span>
    </div>
    ${isDraft ? `<div class="flag" style="margin-bottom:10px"><b>This run has not been committed.</b>
      You can open, print and download these payslips now, but the figures can still change until the run is committed.</div>` : ""}
    <div class="ledger">
      <div class="prow head"><span>Employee</span><span>Gross</span><span>Net</span><span>Actions</span></div>
      ${rows.map(ps => {
        const e = emp(ps.employeeId);
        return `<div class="prow">
          <span><b>${esc(e?.name||"?")}</b><span class="r-sub">${esc(e?.payrollNumber||"")} · ${esc(e?.department||"")}</span></span>
          <span class="m">${money(ps.gross)}</span>
          <span class="m">${money(ps.net)}</span>
          <span class="rowacts">
            <button class="btn sm primary" data-slip="${ps.employeeId}|${run.period}">View</button>
            <button class="btn sm" data-slipdl="${ps.employeeId}|${run.period}">Download</button>
            <button class="btn sm" data-slippr="${ps.employeeId}|${run.period}">Print</button>
          </span>
        </div>`;
      }).join("")}
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-slipall="${run.period}">Download all ${rows.length} as one file</button>
      <button class="btn" data-slipcsv="${run.period}">Export summary (CSV)</button>
    </div>`;
  };

  return `
  ${mast("Payslips", "Pay documents", [
    ["Committed runs", String(committed.length)],
    ["Draft runs", String(draft.length)],
    ["Payslips shown", String(totalShown)]
  ])}

  ${all.length ? `
  <div class="sec-head"><h2>Filter</h2>
    <div class="field inline"><select id="slipEmp">
      <option value="">All employees</option>
      ${S.employees.map(e => `<option value="${e.id}" ${slipFilter===e.id?"selected":""}>${esc(e.name)}</option>`).join("")}
    </select></div>
  </div>
  ${all.map(r => block(r, !r.committed)).join("") || `
    <div class="panelbox"><p style="margin:0;color:var(--ink2)">No payslips for that employee in any run.</p></div>`}
  ` : `
  <div class="panelbox">
    <h3 style="margin:0 0 10px;font-family:var(--cond);font-size:16px;letter-spacing:.05em;text-transform:uppercase">No payslips yet</h3>
    <p style="margin:0 0 16px;max-width:70ch;color:var(--ink2)">
      Payslips appear here once a payroll run has been calculated. Calculate a period and they show as drafts
      straight away — you can view, print and download them before committing.</p>
    <button class="btn primary" data-go="payroll">Go to payroll</button>
  </div>`}

  <div class="sec-head"><h2>Year-end documents</h2><span class="eyebrow">Available after the final period</span></div>
  <div class="ledger">
    <div class="prow"><span><b>P60 — End of year certificate</b>
      <span class="r-sub">Issued after period ${ENGINE.periodsPerYear(S.config)} is committed</span></span>
      <span class="m">—</span><span class="m">—</span>
      <button class="btn sm" ${committed.length >= ENGINE.periodsPerYear(S.config) ? 'data-p60="1"' : "disabled"}>Download</button></div>
  </div>

  <div class="sec-head"><h2>Leaver certificates</h2><span class="eyebrow">P45</span></div>
  ${(() => {
    const ready = S.employees.filter(e => e.leavingDate &&
      S.runs.some(r => r.committed && r.payslips.some(p => p.employeeId === e.id)));
    const pending = S.employees.filter(e => e.leavingDate && !ready.includes(e));
    if(!ready.length && !pending.length){
      return `<div class="panelbox"><p style="margin:0;color:var(--ink2)">
        Nobody has left. A P45 appears here once a leaver's final pay is committed \u2014 the
        year-to-date figures it carries are not final until then.</p></div>`;
    }
    return `<div class="ledger">
      ${ready.map(e => `<div class="prow">
        <span><b>${esc(e.name)}</b><span class="r-sub">${esc(e.payrollNumber)} · left ${fmtD(e.leavingDate)}</span></span>
        <span class="m">—</span><span class="m">—</span>
        <span class="rowacts">
          <button class="btn sm primary" data-p45="${e.id}">View</button>
          <button class="btn sm" data-p45dl="${e.id}">Download</button>
          <button class="btn sm" data-p45pr="${e.id}">Print</button>
        </span></div>`).join("")}
      ${pending.map(e => `<div class="prow muted">
        <span><b>${esc(e.name)}</b><span class="r-sub">${esc(e.payrollNumber)} · leaves ${fmtD(e.leavingDate)} · final pay not yet committed</span></span>
        <span class="m">—</span><span class="m">—</span>
        <button class="btn sm" disabled>Not due</button></div>`).join("")}
    </div>`;
  })()}

  <div class="gov">
    <span class="eyebrow">What your payslip must show</span>
    <p>Under section 8 of the Employment Rights Act 1996 a payslip itemises <strong>gross pay, every deduction with its purpose, and net pay</strong>. Where pay varies with hours worked, the <strong>number of hours is shown alongside the rate</strong>, as required since April 2019.</p>
    <p>Employer pension and National Insurance are shown for transparency. They are paid by the employer on top of gross pay and are not deducted from it.</p>
  </div>
  ${banner()}`;
}

/* ============================================================================
   P45
   ----------------------------------------------------------------------------
   Legally required when someone leaves. Parts 1A, 2 and 3 go to the employee;
   the leaving details on Part 1 reach HMRC through the FPS rather than being
   sent separately.

   Every figure comes from the committed payslip, which is why it can only be
   produced after the final pay run is committed — the year-to-date totals are
   not final until then.
   ========================================================================== */
function p45HTML(employeeId){
  const e = emp(employeeId);
  if(!e) return "<div class='slip'>Not found.</div>";

  const runs = S.runs.filter(r => r.committed && r.payslips.some(p => p.employeeId === employeeId))
                     .sort((a,b) => b.period - a.period);
  if(!runs.length) return "<div class='slip'>No committed pay run for this employee.</div>";
  const run = runs[0];
  const ps = run.payslips.find(p => p.employeeId === employeeId);
  const p = PERIODS[run.period - 1];
  const tc = ENGINE.parseTaxCode(e.taxCode);
  const parts = String(e.name || "").trim().split(/\s+/);
  const surname = parts.pop() || "";
  const forenames = parts.join(" ");

  return `<div class="slip">
    <div class="slip-head">
      <div>
        <div class="slip-org">P45 — Part 1A</div>
        <div class="slip-sub">Details of employee leaving work<br>Copy for the employee</div>
      </div>
      <div class="slip-meta">
        ${esc(S.employer.shortName)}<br>
        PAYE ref <b>${esc(S.employer.payeRef)}</b><br>
        Issued ${fmtD(todayISO())}
      </div>
    </div>

    <div class="slip-id">
      <div><span>1 Employer PAYE reference</span><b>${esc(S.employer.payeRef)}</b></div>
      <div><span>2 National Insurance number</span><b>${esc(e.niNumber || "not held")}</b></div>
      <div><span>3 Surname</span><b>${esc(surname.toUpperCase())}</b></div>
      <div><span>&nbsp;&nbsp; Forenames</span><b>${esc(forenames)}</b></div>
      <div><span>4 Leaving date</span><b>${fmtD(e.leavingDate)}</b></div>
      <div><span>5 Student loan deductions</span><b>${(ps.ytd.studentLoan > 0) ? "Y" : "N"}</b></div>
      <div><span>6 Tax code at leaving date</span><b>${esc(tc.raw)}</b></div>
      <div><span>&nbsp;&nbsp; Week 1 / Month 1 basis</span><b>${tc.cumulative ? "No" : "Yes"}</b></div>
    </div>

    <div class="slip-cols">
      <div class="slip-col">
        <h4>7 Total pay and tax</h4>
        ${tc.cumulative
          ? `<div class="sl"><span>Total pay to date</span><span>${money(ps.ytd.gross)}</span></div>
             <div class="sl"><span>Total tax to date</span><span>${money(ps.ytd.tax)}</span></div>`
          : `<div class="sl"><span>Total pay to date</span><span>Not applicable</span></div>
             <div class="sl"><span>&nbsp;</span><span>week 1 / month 1 basis</span></div>`}
        <div class="sl tot"><span>Pay in this employment</span><span>${money(ps.ytd.taxable)}</span></div>
        <div class="sl tot"><span>Tax in this employment</span><span>${money(ps.ytd.tax)}</span></div>
      </div>
      <div class="slip-col">
        <h4>8 Employee details</h4>
        <div class="sl"><span>Payroll number</span><span>${esc(e.payrollNumber)}</span></div>
        <div class="sl"><span>Date of birth</span><span>${fmtD(e.dob)}</span></div>
        <div class="sl"><span>Final pay period</span><span>${esc(p.label)}</span></div>
        <div class="sl"><span>Final pay date</span><span>${fmtD(p.payDate)}</span></div>
      </div>
    </div>

    <div class="slip-net">
      <span class="l">Pay in this employment</span>
      <span class="v">${money(ps.ytd.taxable)}</span>
    </div>

    <div class="slip-foot">
      <b>To the employee.</b> Keep Parts 1A, 2 and 3 safe. You will need them to claim a tax
      refund or benefits, and Parts 2 and 3 go to your next employer. Copies cannot be issued.<br><br>
      <b>To HMRC.</b> The leaving details on Part 1 are reported through the Full Payment Submission
      for the period shown, rather than sent separately.<br>
      <span style="letter-spacing:.08em;text-transform:uppercase;font-family:var(--mono);font-size:9.5px">Powered by Open Source AI Ltd</span>
    </div>
  </div>`;
}

function payslipDocument(title, bodyHTML){
  const css = document.getElementById("appstyle").textContent;
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600;700&display=swap" rel="stylesheet">
<style>${css}
body{background:#fff;padding:20px}
.modal{max-width:760px;margin:0 auto 40px;border-top:3px solid #14181F}
.pagebreak{page-break-after:always}
.docfoot{max-width:760px;margin:0 auto;text-align:center;font-family:var(--mono);font-size:10.5px;
  letter-spacing:.11em;text-transform:uppercase;color:#828A97;padding:18px 0}
</style></head><body>${bodyHTML}
<div class="docfoot">Powered by Open Source AI Ltd</div></body></html>`;
}

function printHTML(title, bodyHTML){
  const win = window.open("", "_blank");
  if(!win){ alert("Your browser blocked the print window. Allow pop-ups for this page, or use Download instead."); return; }
  win.document.write(payslipDocument(title, bodyHTML));
  win.document.close();
  win.focus();
  setTimeout(() => { try { win.print(); } catch(e){} }, 400);
}

/* ---------- payslip document --------------------------------------------- */
function payslipHTML(employeeId, period){
  const run = runFor(period);
  const ps = run?.payslips.find(p => p.employeeId === employeeId);
  const e = emp(employeeId);
  if(!ps || !e) return "<div class='slip'>Not found.</div>";
  const p = PERIODS[period - 1];
  const bal = ENGINE.leaveBalance(e, S.leave, p.end);

  return `<div class="slip">
    <div class="slip-head">
      <div>
        <div class="slip-org">${esc(S.employer.shortName)}</div>
        <div class="slip-sub">${esc(S.employer.address)}<br>PAYE ref ${esc(S.employer.payeRef)}</div>
      </div>
      <div class="slip-meta">
        PAYSLIP · PERIOD ${String(period).padStart(2,"0")} · ${esc(S.config.taxYear)}<br>
        Pay date <b>${fmtD(p.payDate)}</b><br>
        Method BACS ····${esc(String(e.bankAccount||"").slice(-4))}
      </div>
    </div>
    <div class="slip-id">
      <div><span>Employee</span><b>${esc(e.name)}</b></div>
      <div><span>Payroll no.</span><b>${esc(e.payrollNumber)}</b></div>
      <div><span>NI number</span><b>${esc(e.niNumber || "—")}</b></div>
      <div><span>Tax code</span><b>${esc(e.taxCode)}${ps.paye.code.cumulative ? "" : " M1"}</b></div>
      <div><span>Job title</span><b>${esc(e.jobTitle||"—")}</b></div>
      <div><span>Department</span><b>${esc(e.department||"—")}</b></div>
      <div><span>NI category</span><b>${esc(ps.ni.category)}</b></div>
      <div><span>Basis</span><b>${ps.paye.code.cumulative ? "Cumulative" : "Wk1/Mth1"}</b></div>
    </div>
    <div class="slip-cols">
      <div class="slip-col"><h4>Payments</h4>
        ${ps.payments.map(x => `<div class="sl"><span>${esc(x.label)}${x.hours ? ` — ${x.hours} hrs${x.rate ? ` @ ${money(x.rate)}` : ""}` : ""}</span><span>${money(x.amount)}</span></div>`).join("")}
        <div class="sl tot"><span>Gross pay</span><span>${money(ps.gross)}</span></div>
      </div>
      <div class="slip-col"><h4>Deductions</h4>
        ${ps.deductions.length ? ps.deductions.map(d => `<div class="sl"><span>${esc(d.label)}</span><span>${money(d.amount)}</span></div>`).join("") : `<div class="sl"><span>None</span><span>—</span></div>`}
        <div class="sl tot"><span>Total deductions</span><span>${money(ps.totalDeductions)}</span></div>
      </div>
    </div>
    <div class="slip-net"><span class="l">Net pay</span><span class="v">${money(ps.net)}</span></div>
    <div class="slip-ytd">
      <div class="yr h"><div>Gross to date</div><div>Taxable to date</div><div>Tax to date</div><div>NI to date</div><div>Pension to date</div></div>
      <div class="yr"><div>${money(ps.ytd.gross)}</div><div>${money(ps.ytd.taxable)}</div><div>${money(ps.ytd.tax)}</div><div>${money(ps.ytd.niEmployee)}</div><div>${money(ps.ytd.pension)}</div></div>
    </div>
    <div class="slip-cols" style="padding-bottom:0">
      <div class="slip-col"><h4>Paid by the employer</h4>
        <div class="sl"><span>Employer National Insurance</span><span>${money(ps.ni.employer)}</span></div>
        <div class="sl"><span>Employer pension${ps.pension.basis ? " — " + esc(ENGINE.PENSION_BASES[ps.pension.basis].toLowerCase()) : ""}</span><span>${money(ps.pension.employer)}</span></div>
        <div class="sl tot"><span>Total employment cost</span><span>${money(ps.employerCost)}</span></div>
      </div>
      <div class="slip-col"><h4>Leave balance</h4>
        <div class="sl"><span>Entitlement</span><span>${bal.total.toFixed(1)} hrs</span></div>
        <div class="sl"><span>Taken</span><span>${bal.taken.toFixed(1)} hrs</span></div>
        <div class="sl"><span>Booked ahead</span><span>${bal.booked.toFixed(1)} hrs</span></div>
        <div class="sl tot"><span>Available</span><span>${bal.available.toFixed(1)} hrs</span></div>
      </div>
    </div>
    <div class="slip-foot">
      Hours paid are shown against each variable payment as required by section 8 of the Employment Rights Act 1996.
      Employer contributions are paid in addition to gross pay and are not deducted from it.<br>
      Queries: your payroll contact — quote your payroll number and the period shown above.<br>
      <span style="letter-spacing:.08em;text-transform:uppercase;font-family:var(--mono);font-size:9.5px">Powered by Open Source AI Ltd</span>
      <div class="slip-producer">Payroll produced by <b>Open Source AI Ltd</b></div>
    </div>
  </div>`;
}



/* ============================================================================
   APPLYING AN AUTOMATION ACTION
   Every application is logged with enough detail to reverse it.
   ========================================================================== */
function applyAction(action, run, automatic){
  const already = S.automation.log.some(l => l.runPeriod === run.period && l.actionKey === actionKey(action));
  if(already) return false;
  const c = action.change;
  let applied = true, undo = null;

  switch(c.type){
    case "setField": {
      const e = emp(c.employeeId);
      if(!e || e[c.field] === c.to){ applied = false; break; }
      undo = { type:"setField", employeeId:c.employeeId, field:c.field, to:e[c.field] };
      e[c.field] = c.to;
      break;
    }
    case "addElements": {
      run.elements = run.elements || {};
      const existing = run.elements[c.employeeId] || [];
      const toAdd = c.elements.filter(x => !existing.some(y => y.label === x.label && y.amount === x.amount));
      if(!toAdd.length){ applied = false; break; }
      run.elements[c.employeeId] = existing.concat(toAdd.map(x => ({ ...x })));
      undo = { type:"removeElements", employeeId:c.employeeId, labels: toAdd.map(x => x.label) };
      break;
    }
    case "decideException": {
      if(run.decisions[c.ref]){ applied = false; break; }
      run.decisions[c.ref] = { type:c.decision, time:new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}),
                               by:"Automation rule", byRule:action.ruleId };
      undo = { type:"undecideException", ref:c.ref };
      break;
    }
    case "notifyOnly": {
      const key = action.ruleId + "|" + c.employeeId;
      if(S.automation.notifications.some(n => n.key === key)){ applied = false; break; }
      S.automation.notifications.push({ key, employeeId:c.employeeId, message:c.message, at:new Date().toISOString() });
      undo = { type:"removeNotification", key };
      break;
    }
    case "markLeaver": {
      const e = emp(c.employeeId);
      if(!e){ applied = false; break; }
      undo = { type:"setField", employeeId:c.employeeId, field:"status", to:e.status };
      e.status = "leaver";
      run.decisions[(run.exceptions.find(x => (x.employeeIds||[]).includes(c.employeeId) && x.severity === "high") || {}).ref
        || "__none"] = undefined;
      break;
    }
    case "flagOnly": applied = false; break;   // advisory only, nothing to change
    default: applied = false;
  }

  if(!applied) return false;
  S.automation.log.unshift({
    id: uid(), at: new Date().toISOString(), runPeriod: run.period,
    ruleId: action.ruleId, actionKey: actionKey(action), tier: action.tier,
    label: action.label, detail: action.detail, automatic: !!automatic,
    by: automatic ? "Automation" : "A. Okafor, Payroll Manager",
    undo, reversed: false
  });
  if(S.automation.log.length > 400) S.automation.log.length = 400;
  return true;
}

function actionKey(a){ return a.ruleId + "|" + (a.targetId || "") + "|" + (a.change?.field || a.change?.type || ""); }

function reverseLogEntry(id){
  const entry = S.automation.log.find(l => l.id === id);
  if(!entry || entry.reversed || !entry.undo) return;
  const u = entry.undo;
  const run = runFor(entry.runPeriod);
  if(u.type === "setField"){ const e = emp(u.employeeId); if(e) e[u.field] = u.to; }
  if(u.type === "removeElements" && run){
    run.elements[u.employeeId] = (run.elements[u.employeeId] || []).filter(x => !u.labels.includes(x.label));
    if(!run.elements[u.employeeId].length) delete run.elements[u.employeeId];
  }
  if(u.type === "undecideException" && run) delete run.decisions[u.ref];
  if(u.type === "removeNotification") S.automation.notifications = S.automation.notifications.filter(n => n.key !== u.key);
  entry.reversed = true;
  entry.reversedAt = new Date().toISOString();
  save();
  if(run && !run.committed) calculateRun(entry.runPeriod);
  render();
}





/* ============================================================================
   GROUP — employers, payrolls and timesheets
   ----------------------------------------------------------------------------
   A group files RTI per employer but runs one HR function. The rules enforced
   here are the same ones the database enforces: two employers cannot share a
   PAYE reference, only one may claim the Employment Allowance, and nobody may
   approve their own hours.
   ========================================================================== */
function employerOf(e){ return (S.employers || []).find(x => x.id === e.employerId) || null; }
function scheduleOf(e){ return (S.schedules || []).find(x => x.id === e.scheduleId) || null; }

const FREQ_LABEL = { weekly:"Weekly", fortnightly:"Fortnightly", fourWeekly:"Four-weekly",
                     monthly:"Monthly", quarterly:"Quarterly" };

function timesheetHours(ts){
  return (ts.lines || []).reduce((s,l) => s + Number(l.hours || 0), 0);
}
function timesheetValue(ts){
  return (ts.lines || []).reduce((s,l) => s + Number(l.hours || 0) * Number(l.rate || 0), 0);
}

function viewGroup(){
  const employers = S.employers || [];
  const schedules = S.schedules || [];
  const timesheets = S.timesheets || [];
  const people = activeEmployees();

  const eaClaims = employers.filter(x => x.claimsEmploymentAllowance).length;
  const pending = timesheets.filter(t => t.status === "submitted");

  return `
  ${mast("Group", "Employers, payrolls and timesheets", [
    ["Employers", String(employers.length)],
    ["Payrolls", String(schedules.length)],
    ["Timesheets to approve", String(pending.length)]
  ])}

  <div class="sec-head"><h2>Employers</h2>
    <span class="eyebrow">Each files its own RTI</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Employer</span><span>PAYE reference</span><span>Accounts Office</span><span>On payroll</span><span></span></div>
    ${employers.map(x => {
      const n = people.filter(e => e.employerId === x.id).length;
      return `<div class="lrow">
        <div><b>${esc(x.name)}</b><span class="note">${esc(x.code)}</span></div>
        <span class="m">${esc(x.payeOfficeNo)}/${esc(x.payeRef)}</span>
        <span class="m">${esc(x.aoRef)}</span>
        <span class="m">${n}</span>
        <span>${x.claimsEmploymentAllowance
          ? '<span class="status st-approved">claims allowance</span>' : ""}</span>
      </div>`;
    }).join("")}
  </div>

  <div class="flag ${eaClaims === 1 ? "ok" : "bad"}" style="margin-top:14px">
    ${eaClaims === 1
      ? "<b>One Employment Allowance claim across the group.</b> Connected companies may only claim it once, and a second claim is refused rather than quietly accepted."
      : "<b>" + eaClaims + " employers are claiming the Employment Allowance.</b> Connected companies may only claim it once."}
  </div>

  <div class="sec-head" style="margin-top:34px"><h2>Payrolls running in parallel</h2>
    <span class="eyebrow">${schedules.length} schedules, ${new Set(schedules.map(s=>s.frequency)).size} frequencies</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Payroll</span><span>Employer</span><span>Frequency</span><span>Periods a year</span><span>On it</span></div>
    ${schedules.map(s => {
      const employer = employers.find(x => x.id === s.employerId);
      const n = people.filter(e => e.scheduleId === s.id).length;
      let per = 12;
      safely("periods", () => { per = ENGINE.periodsPerYear({ ...S.config, payFrequency: s.frequency }); });
      return `<div class="lrow">
        <div><b>${esc(s.name)}</b><span class="note">${esc(s.code)} · week starts ${
          ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][s.weekStartsOn]}</span></div>
        <span class="m">${esc(employer ? employer.name : "—")}</span>
        <span class="m">${esc(FREQ_LABEL[s.frequency] || s.frequency)}</span>
        <span class="m">${per}</span>
        <span class="m">${n}</span>
      </div>`;
    }).join("")}
  </div>

  <div class="sec-head" style="margin-top:34px"><h2>Who is on which payroll</h2></div>
  <div class="ledger">
    <div class="lrow head"><span>Employee</span><span>Employer</span><span>Payroll</span><span></span><span></span></div>
    ${people.map(e => {
      const x = employerOf(e), s = scheduleOf(e);
      return `<div class="lrow">
        <div><b>${esc(e.name)}</b><span class="note">${esc(e.jobTitle || "")}</span></div>
        <span class="m">${esc(x ? x.name : "unassigned")}</span>
        <span class="m">${esc(s ? s.name : "unassigned")}</span>
        <span></span>
        <span>${!x || !s ? '<span class="status st-pending">needs assigning</span>' : ""}</span>
      </div>`;
    }).join("")}
  </div>

  <div class="sec-head" style="margin-top:34px"><h2>Timesheets</h2>
    <span class="eyebrow">Casual and as-and-when staff</span></div>
  ${!timesheets.length ? `<div class="panelbox"><p style="margin:0;color:var(--ink2)">No timesheets submitted.</p></div>` : `
  <div class="ledger">
    <div class="lrow head"><span>Employee</span><span>Week starting</span><span>Hours</span><span>Value</span><span></span></div>
    ${timesheets.map(ts => {
      const e = emp(ts.employeeId);
      return `<div class="prow">
        <span><b>${esc(e ? e.name : "unknown")}</b><span class="r-sub">${
          (ts.lines||[]).length} day${(ts.lines||[]).length===1?"":"s"}${
          ts.submittedBy ? " · submitted by " + esc(ts.submittedBy) : ""}${
          ts.approvedBy ? " · approved by " + esc(ts.approvedBy) : ""}</span></span>
        <span class="m">${fmtD(ts.weekStarting)}</span>
        <span class="m">${timesheetHours(ts).toFixed(2)}</span>
        <span class="m">${money(timesheetValue(ts))}</span>
        <span class="rowacts">${
          ts.status === "submitted"
            ? `<button class="btn sm primary" data-tsapprove="${ts.id}">Approve</button>
               <button class="btn sm" data-tsreject="${ts.id}">Reject</button>`
            : ts.status === "approved"
              ? '<span class="status st-approved">approved · locked</span>'
              : ts.status === "rejected"
                ? '<span class="status st-pending">rejected</span>'
                : '<span class="status st-pending">draft</span>'}</span>
      </div>`;
    }).join("")}
  </div>`}

  <div class="panelbox" style="margin-top:18px">
    <h3 style="margin:0 0 10px;font-family:var(--cond);font-size:15px;letter-spacing:.05em;text-transform:uppercase">Approving as</h3>
    <div class="frow">
      <div class="field"><label>Your email</label>
        <input id="tsApprover" value="${esc(S.approverEmail || "a.okafor@northgate.example")}"></div>
    </div>
    <p style="margin:12px 0 0;font-size:13px;color:var(--ink2)">
      Change this to the submitter's address and try approving their sheet. It will refuse —
      nobody may approve their own hours.</p>
  </div>

  <div class="gov">
    <span class="eyebrow">Why these rules are in the database, not the screen</span>
    <p><strong>Two employers cannot share a PAYE reference.</strong> RTI would be filed against
    the wrong scheme and the figures would never reconcile.</p>
    <p><strong>Only one employer in a group may claim the Employment Allowance.</strong> A second
    claim is refused outright rather than corrected later by HMRC.</p>
    <p><strong>An approved timesheet cannot be edited.</strong> It is evidence of hours worked.
    A correction goes on a new sheet, in the same way a committed payslip is superseded rather
    than altered.</p>
  </div>
  ${banner()}`;
}

/* ============================================================================
   ABSENCE
   ========================================================================== */
function viewAbsence(){
  const schemes = S.absenceSchemes || [];
  const absences = S.absences || [];
  const p = PERIODS[S.currentPeriod - 1];
  const schemeBy = Object.fromEntries(schemes.map(s => [s.id, s]));

  const assessed = absences.map(ab => {
    const e = emp(ab.employeeId);
    const scheme = schemeBy[ab.schemeId];
    if(!e || !scheme) return null;
    let r = null;
    safely("assess", () => {
      r = ABSENCE.assessAbsence({
        employee: { ...e, startedOn: e.startDate },
        scheme, absence: ab,
        history: absences.filter(x => x.employeeId === ab.employeeId && x.id !== ab.id),
        statutoryPaid: ab.statutoryPaid || 0 });
    });
    return r ? { ab, e, scheme, r } : null;
  }).filter(Boolean);

  const open = assessed.filter(x => !x.ab.to || x.ab.to >= p.start);
  const cost = assessed.reduce((s,x) => s + x.r.grossOccupational, 0);

  return `
  ${mast("Absence", "Occupational pay", [
    ["Open absences", String(open.length)],
    ["Occupational cost", money(cost, 0)],
    ["Schemes", String(schemes.length)]
  ])}

  <div class="sec-head"><h2>Schemes</h2><span class="eyebrow">Company pay above the statutory minimum</span></div>
  <div class="ledger">
    ${schemes.map(s => `<div class="lrow">
      <div><b>${esc(s.name)}</b><span class="note">${esc(s.kind)} ·
        ${s.windowType === "perOccurrence"
          ? "each occurrence assessed on its own"
          : "rolling " + s.windowMonths + " month window"} ·
        ${s.offsetStatutory ? "inclusive of statutory pay" : "paid on top of statutory"}</span></div>
      <span class="m">${s.bands.length} band${s.bands.length===1?"":"s"}</span>
    </div>`).join("")}
  </div>

  <div class="sec-head" style="margin-top:34px"><h2>Service bands</h2></div>
  ${schemes.map(s => `
    <div class="panelbox" style="margin-bottom:16px">
      <h3 style="margin:0 0 12px;font-family:var(--cond);font-size:15px;letter-spacing:.05em;text-transform:uppercase">${esc(s.name)}</h3>
      <div class="ledger">
        <div class="lrow head"><span>Service</span><span>Full pay</span><span></span><span></span><span>Half pay</span></div>
        ${s.bands.map(b => `<div class="lrow">
          <span>${esc(b.label)}</span>
          <span class="m">${b.fullWeeks} week${b.fullWeeks===1?"":"s"}</span>
          <span></span><span></span>
          <span class="m">${b.halfWeeks} week${b.halfWeeks===1?"":"s"}</span>
        </div>`).join("")}
      </div>
    </div>`).join("")}

  <div class="sec-head"><h2>Current and recent absence</h2></div>
  ${!assessed.length ? `<div class="panelbox"><p style="margin:0;color:var(--ink2)">Nobody is absent.</p></div>` : `
  <div class="ledger">
    <div class="lrow head"><span>Employee</span><span>Band</span><span>Full / half / unpaid</span><span>Occupational</span><span></span></div>
    ${assessed.map(({ab,e,scheme,r}) => `<div class="lrow">
      <div><b>${esc(e.name)}</b><span class="note">${esc(scheme.name)} ·
        ${fmtD(ab.from)} to ${ab.to ? fmtD(ab.to) : "ongoing"} ·
        ${r.workingDays} working day${r.workingDays===1?"":"s"}${ab.reason ? " · " + esc(ab.reason) : ""}</span></div>
      <span class="m">${esc(r.band)}</span>
      <span class="m">${r.daysAtFullPay} / ${r.daysAtHalfPay} / ${r.daysUnpaid}</span>
      <span class="m">${money(r.grossOccupational)}</span>
      <span>${r.daysUnpaid > 0
        ? '<span class="status st-pending">entitlement used up</span>'
        : r.daysAtHalfPay > 0
          ? '<span class="status st-pending">dropped to half pay</span>'
          : '<span class="status st-approved">full pay</span>'}</span>
    </div>`).join("")}
  </div>`}

  <div class="sec-head" style="margin-top:34px"><h2>Entitlement remaining</h2>
    <span class="eyebrow">Rolling twelve months</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Employee</span><span>Band</span><span>Full pay left</span><span>Half pay left</span><span></span></div>
    ${activeEmployees().map(e => {
      const scheme = schemes[0];
      if(!scheme) return "";
      let ent = null;
      safely("ent", () => {
        ent = ABSENCE.entitlementFor({
          employee: { ...e, startedOn: e.startDate }, scheme,
          absenceStart: p.end,
          history: absences.filter(x => x.employeeId === e.id) });
      });
      if(!ent) return "";
      return `<div class="lrow">
        <div><b>${esc(e.name)}</b><span class="note">${esc(e.jobTitle || "")}</span></div>
        <span class="m">${esc(ent.band.label)}</span>
        <span class="m">${ent.fullDaysRemaining} of ${ent.fullDaysEntitled} days</span>
        <span class="m">${ent.halfDaysRemaining} of ${ent.halfDaysEntitled} days</span>
        <span>${ent.exhausted ? '<span class="status st-pending">exhausted</span>' : ""}</span>
      </div>`;
    }).join("")}
  </div>

  <div class="gov">
    <span class="eyebrow">How occupational sick pay works</span>
    <p><strong>Entitlement is consumed, not reset.</strong> It is measured over the twelve months
    before the first day of the absence, so time off in March reduces what is available in
    October. Calculating from the start of the leave year instead is a common and expensive error.</p>
    <p><strong>Occupational pay is inclusive of statutory pay, not on top of it.</strong> Full pay
    means normal pay, of which SSP forms part. Paying both is an overpayment that has to be
    recovered from the employee.</p>
    <p><strong>Service is fixed at the start of the absence.</strong> Someone who passes five
    years' service part-way through does not move up a band mid-absence.</p>
  </div>
  ${banner()}`;
}

/* ============================================================================
   ACCOUNTING JOURNAL
   ========================================================================== */
function viewJournal(){
  const committed = S.runs.filter(r => r.committed).sort((a,b) => b.period - a.period);
  if(!committed.length){
    return `
    ${mast("Journal", "Accounting entries", [["Committed runs","0"],["Status","—"],["Tax year", S.config.taxYear]])}
    <div class="panelbox">
      <h3 style="margin:0 0 10px;font-family:var(--cond);font-size:16px;letter-spacing:.05em;text-transform:uppercase">Nothing to post yet</h3>
      <p style="margin:0 0 16px;max-width:70ch;color:var(--ink2)">
        The journal is produced from a committed payroll run. Commit a period and the accounting
        entries appear here, ready to post to your finance system.</p>
      <button class="btn primary" data-go="payroll">Go to payroll</button>
    </div>
    ${banner()}`;
  }

  const run = committed.find(r => r.period === journalPeriod) || committed[0];
  journalPeriod = run.period;
  const p = PERIODS[run.period - 1];

  const j = buildJournalForRun(run, p);
  const check = validateJournal(j);

  return `
  ${mast("Journal", "Accounting entries", [
    ["Reference", j.reference],
    ["Employer cost", money(j.totalDebit,0)],
    ["Balanced", j.balanced ? "Yes" : "NO"]
  ])}

  <div class="sec-head"><h2>Period</h2>
    <div class="row-tools">
      <div class="field inline"><select id="jPeriod">
        ${committed.map(r => `<option value="${r.period}" ${r.period===run.period?"selected":""}>${esc(PERIODS[r.period-1].label)}</option>`).join("")}
      </select></div>
      <button class="btn" data-jexp="csv">Download CSV</button>
      <button class="btn" data-jexp="sage">Sage 50</button>
      <button class="btn" data-jexp="xero">Xero</button>
    </div>
  </div>

  <div class="flag ${j.balanced ? "ok" : "bad"}">
    ${j.balanced
      ? `<b>Balanced.</b> ${money(j.totalDebit)} of cost against ${money(j.totalCredit)} of liability, across ${j.employeesIncluded} employee${j.employeesIncluded===1?"":"s"}.${j.employeesHeld ? " " + j.employeesHeld + " held record(s) excluded — they were not paid." : ""}`
      : `<b>Does not balance.</b> ${esc(check.problems.join("; "))}. This would be rejected by any accounting system.`}
  </div>

  <div class="sec-head" style="margin-top:26px"><h2>What employing people cost</h2><span class="eyebrow">Debits</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Account</span><span>Cost centre</span><span></span><span></span><span>Amount</span></div>
    ${j.lines.filter(l => l.debit > 0).map(l => `<div class="lrow">
      <span><b>${esc(l.account)}</b><span class="r-sub">${esc(l.code)}</span></span>
      <span class="m">${esc(l.costCentre || "—")}</span><span></span><span></span>
      <span class="m">${money(l.debit)}</span></div>`).join("")}
  </div>

  <div class="sec-head"><h2>What is now owed</h2><span class="eyebrow">Credits</span></div>
  <div class="ledger">
    <div class="lrow head"><span>Account</span><span>To whom</span><span></span><span></span><span>Amount</span></div>
    ${j.lines.filter(l => l.credit > 0).map(l => `<div class="lrow">
      <span><b>${esc(l.account)}</b><span class="r-sub">${esc(l.code)}${l.note ? " · " + esc(l.note) : ""}</span></span>
      <span class="m">${esc(l.costCentre || "—")}</span><span></span><span></span>
      <span class="m">${money(l.credit)}</span></div>`).join("")}
  </div>

  <div class="counters" style="border-top:none;margin-top:18px">
    ${counter(money(j.totalDebit), "Total debits")}
    ${counter(money(j.totalCredit), "Total credits")}
    ${counter(money(j.difference), "Difference")}
    ${counter(String(j.employeesIncluded), "Employees posted")}
  </div>

  <div class="gov">
    <span class="eyebrow">How to read this</span>
    <p><strong>The two sides must be identical.</strong> The left is what employing people cost the
    organisation this period — gross pay plus employer National Insurance plus employer pension.
    The right is what the organisation now owes: to HMRC, to the pension provider, and to the
    employees themselves. A journal that does not balance is rejected outright by every accounting system.</p>
    <p>Employer National Insurance and employer pension appear as costs but are <strong>not</strong> owed to
    the employee. They sit on top of gross pay, which is why the total cost exceeds the total gross.</p>
  </div>
  ${banner()}`;
}

var journalPeriod = null;

function buildJournalForRun(run, p){
  return buildJournal({
    run,
    payslips: run.payslips,
    employees: S.employees,
    period: { n: run.period, taxYear: S.config.taxYear, label: p.label,
              start: p.start, end: p.end, payDate: p.payDate },
    org: { shortName: S.employer.shortName },
    options: {}
  });
}

/* ============================================================================
   AUTOMATION
   ========================================================================== */
function viewAutomation(){
  const A = S.automation;
  const run = runFor(S.currentPeriod);
  const tl = run ? touchlessRate({ payslips:run.payslips, exceptions:run.exceptions,
                                   decisions:run.decisions, actions:run.actions || [] })
                 : { rate:0, touched:0, total:0 };
  const pending = (run?.actions || []).filter(x => x.tier === "propose");
  const groups = [...new Set(AUTOMATION_RULES.map(r => r.group))];

  return `
  ${mast("Automation", "How much runs itself", [
    ["Mode", MODES[A.mode].label],
    ["Touchless", run ? tl.rate.toFixed(1) + "%" : "—"],
    ["Actions logged", String(A.log.filter(l => !l.reversed).length)]
  ])}

  <div class="sec-head"><h2>Mode</h2><span class="eyebrow">Sets every rule below at once</span></div>
  <div class="modeswitch">
    ${Object.entries(MODES).map(([k,v]) => `
      <button class="modebtn ${A.mode===k?"on":""}" data-mode="${k}">
        <span class="mb-l">${esc(v.label)}</span>
        <span class="mb-n">${esc(v.note)}</span>
      </button>`).join("")}
  </div>

  ${A.mode === "cover" ? coverPanel(run) : ""}

  ${run ? `
  <div class="counters" style="border-top:1px solid var(--rule);margin-top:18px">
    ${counter(tl.rate.toFixed(1) + "%", "Records needing no attention")}
    ${counter(String(Object.values(run.decisions||{}).filter(v => v && v.byRule).length), "Decisions avoided")}
    ${counter(String(pending.length), "Waiting for a decision")}
    ${counter(String((run.actions||[]).filter(x => x.tier!=="propose").length), "Handled automatically")}
  </div>` : `<div class="panelbox" style="border-top:none">
    <p style="margin:0;color:var(--ink2)">Calculate a payroll run to see the touchless rate for this period.</p></div>`}

  ${pending.length ? `
  <div class="sec-head"><h2>Waiting for you</h2><span class="eyebrow">${pending.length} proposed</span></div>
  <div class="ledger">
    ${pending.map(x => {
      const c = A.mode === "cover" ? coverAssessment(x, x.amount || 0, A.cover) : null;
      const canAct = !c || c.authority === "deputy";
      return `<div class="prow">
      <span><b>${esc(x.label)}</b><span class="r-sub">${esc(ruleName(x.ruleId))}${x.blocking ? " · blocks the run" : ""}</span>
        <div class="a-d" style="margin-top:5px">${esc(x.detail)}</div>
        ${c ? `<div class="coverbox auth-${c.authority}">
                 <div class="p-l">What this means</div>
                 <div>${esc(c.guidance)}</div>
                 <div class="coverwho">${esc(c.reason)}</div>
               </div>` : ""}</span>
      <span></span>
      <span>${c ? `<span class="status ${c.authority === "deputy" ? "st-approved" : "st-pending"}">${
          c.authority === "deputy" ? "yours to decide" : c.authority === "second" ? "second approver" : "held for lead"}</span>` : ""}</span>
      <span class="actions" style="margin:0">
        <button class="btn sm primary" data-doact="${x.id}" ${canAct ? "" : "disabled"}>Accept</button>
        <button class="btn sm" data-skipact="${x.id}">Skip</button>
      </span>
    </div>`;}).join("")}
  </div>` : ""}

  <div class="sec-head"><h2>Rules</h2><span class="eyebrow">Override individually</span></div>
  ${groups.map(g => `
    <div class="rulegroup"><div class="p-l" style="margin:18px 0 8px">${esc(g)}</div>
    <div class="ledger">
      ${AUTOMATION_RULES.filter(r => r.group === g).map(r => {
        const t = tierFor(A.policy, r.id);
        return `<div class="prow rulerow">
          <span><b>${esc(r.name)}</b>${r.never ? ' <span class="status st-pending">always manual</span>' : ""}
            <span class="r-sub">${esc(r.what)}</span>
            <div class="a-d" style="margin-top:6px">${esc(r.why)}</div>
            ${r.blocked ? `<div class="lockednote">${esc(r.blocked)}</div>` : ""}</span>
          <span></span><span></span>
          <span><select data-rule="${r.id}" ${r.id==="commit-run"?"disabled":""}>
            ${Object.entries(TIERS).filter(([k]) => !(r.never && (k==="notify"||k==="apply")))
              .map(([k,v]) => `<option value="${k}" ${t===k?"selected":""}>${v.label}</option>`).join("")}
          </select></span>
        </div>`;
      }).join("")}
    </div></div>`).join("")}

  <div class="sec-head"><h2>Activity log</h2><span class="eyebrow">Every automatic change, reversible</span></div>
  <div class="ledger">
    ${A.log.length ? A.log.slice(0,40).map(l => `<div class="prow ${l.reversed?"muted":""}">
      <span><b>${esc(l.label)}</b><span class="r-sub">${esc(ruleName(l.ruleId))} · period ${l.runPeriod} · ${esc(l.by)}</span></span>
      <span class="m">${new Date(l.at).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
      <span><span class="status ${l.reversed?"st-taken":"st-approved"}">${l.reversed?"reversed":TIERS[l.tier].label.toLowerCase()}</span></span>
      ${l.reversed || !l.undo ? "<span></span>" : `<button class="btn sm" data-undoact="${l.id}">Reverse</button>`}
    </div>`).join("") : `<div class="prow"><span class="r-sub">Nothing yet. In Manual mode the log stays empty by design.</span></div>`}
  </div>

  <div class="gov">
    <span class="eyebrow">What is deliberately never automated</span>
    <p><strong>Committing a run.</strong> BACS is effectively irrevocable, and recovering an overpayment from a low-paid worker is a union and reputational problem before it is a finance one. A named person takes responsibility before money moves.</p>
    <p><strong>Leavers, duplicate bank accounts and negative net pay.</strong> These carry the highest error cost in payroll and the least tolerance for a wrong guess. The system prepares the answer and stops.</p>
    <p><strong>Anything that reduces someone's pay without notice.</strong> Under UK GDPR Article 22, automated decisions with a significant effect on an individual need human involvement. Pay qualifies.</p>
  </div>`;
}

function coverPanel(run){
  const c = S.automation.cover;
  const rd = run ? coverReadiness({ exceptions:run.exceptions, decisions:run.decisions,
                                    actions:run.actions || [], cover:c }) : null;
  return `
  <div class="panelbox" style="border-top:none;border-left:3px solid var(--navy)">
    <h3 style="margin:0 0 6px;font-family:var(--cond);font-size:16px;letter-spacing:.05em;text-transform:uppercase">Who is covering</h3>
    <p style="margin:0 0 18px;max-width:72ch;color:var(--ink2);font-size:14px">
      Cover mode does not remove the pilot, it adds a first officer. Routine work handles itself,
      every remaining decision is explained in plain terms, and there is a hard limit on what one
      person can release alone.</p>
    <div class="frow">
      <div class="field"><label>Payroll lead (away)</label><input data-cover="leadName" value="${esc(c.leadName||"")}"></div>
      <div class="field"><label>Covering</label><input data-cover="deputyName" value="${esc(c.deputyName||"")}"></div>
      <div class="field"><label>Release limit (£)</label><input type="number" step="50" data-cover="releaseLimit" value="${c.releaseLimit}"></div>
      <div class="field"><label>Above the limit</label><select data-cover="requireSecondApproval">
        <option value="true" ${c.requireSecondApproval?"selected":""}>Needs a second approver</option>
        <option value="false" ${!c.requireSecondApproval?"selected":""}>Deputy may release</option></select></div>
      <div class="field"><label>High-risk items</label><select data-cover="escalateHighSeverity">
        <option value="true" ${c.escalateHighSeverity?"selected":""}>Hold for the lead</option>
        <option value="false" ${!c.escalateHighSeverity?"selected":""}>Deputy may decide</option></select></div>
    </div>
    ${rd ? `<div class="flag ${rd.canCommit ? "ok" : "bad"}" style="margin-top:18px">
      ${rd.canCommit
        ? `<b>Ready to commit under cover authority.</b> ${rd.needsSecondApproval
            ? rd.needsSecondApproval + " item(s) needed a second approver." : "Nothing required escalation."}`
        : `<b>Not ready.</b> ${rd.heldForLead
            ? rd.heldForLead + " item(s) held for " + esc(c.leadName || "the payroll lead") + " — cover cannot release these. "
            : ""}${rd.open ? rd.open + " exception(s) still undecided." : ""}`}
    </div>` : ""}
    <p style="margin:16px 0 0;font-size:13px;color:var(--ink3)">
      Every decision is recorded as made under cover authority, naming both people. ${esc(c.leadName||"The lead")}
      receives a handover summary of everything decided while away.</p>
  </div>`;
}

function ruleName(id){ return (AUTOMATION_RULES.find(r => r.id === id) || {}).name || id; }

/* ============================================================================
   PENSION SCHEMES
   ========================================================================== */
function viewPensions(){
  return `
  ${mast("Pensions", "Pension schemes", [
    ["Schemes", String(S.schemes.length)],
    ["Enrolled", String(S.employees.filter(e => e.status==="active" && schemeFor(e)).length)],
    ["Not enrolled", String(S.employees.filter(e => e.status==="active" && !schemeFor(e)).length)]
  ])}

  <div class="flag ok" style="margin:22px 0">
    <b>The earnings basis matters more than the percentage.</b> A 5% contribution on qualifying earnings
    and 5% on total pay produce different money from the same salary. Auto-enrolment minimums are defined
    on the qualifying earnings band; most occupational schemes use pensionable or total pay.
  </div>

  <div class="sec-head"><h2>Schemes</h2><button class="btn" data-addscheme="1">Add scheme</button></div>
  <div class="ledger">
    ${S.schemes.map(s => {
      const members = S.employees.filter(e => e.pensionSchemeId === s.id && e.status === "active").length;
      const prov = PROVIDERS[s.provider] || PROVIDERS.other;
      return `<div class="prow">
        <span><b>${esc(s.name)}</b>${s.isDefault ? ' <span class="status st-approved">default</span>' : ""}
          <span class="r-sub">${esc(prov.name)} · ${esc(ENGINE.PENSION_BASES[s.basis])} · ${esc(ENGINE.PENSION_METHODS[s.method])}</span></span>
        <span class="m">${(s.employeeRate*100).toFixed(1)}% / ${(s.employerRate*100).toFixed(1)}%</span>
        <span class="m">${members} member${members===1?"":"s"}</span>
        <button class="btn sm" data-editscheme="${s.id}">Edit</button>
      </div>`;
    }).join("") || `<div class="prow"><span class="r-sub">No schemes defined.</span></div>`}
  </div>

  <div class="sec-head"><h2>Contribution comparison</h2><span class="eyebrow">On £3,000 gross per period</span></div>
  <div class="ledger">
    <div class="prow head"><span>Scheme</span><span>Earnings used</span><span>Employee</span><span>Employer</span></div>
    ${S.schemes.map(s => {
      const c = ENGINE.calcPension({ gross:3000, pensionablePortion:3000, basicPortion:2500, scheme:s, config:S.config });
      return `<div class="prow"><span>${esc(s.name)}<span class="r-sub">${esc(ENGINE.PENSION_BASES[s.basis])}</span></span>
        <span class="m">${money(c.earnings)}</span><span class="m">${money(c.employee)}</span><span class="m">${money(c.employer)}</span></div>`;
    }).join("")}
  </div>
  ${banner()}`;
}

function schemeForm(s){
  const f = (label,key,type="text",extra="") => `<div class="field"><label>${label}</label><input type="${type}" data-s="${key}" value="${esc(s[key] ?? "")}" ${extra}></div>`;
  const sel = (label,key,opts) => `<div class="field"><label>${label}</label><select data-s="${key}">${opts.map(([v,t]) =>
    `<option value="${v}" ${String(s[key])===String(v)?"selected":""}>${t}</option>`).join("")}</select></div>`;
  return `<div class="formgrid">
    <div class="fs"><h4>Scheme</h4>
      ${f("Name","name")}
      ${sel("Provider","provider",Object.entries(PROVIDERS).map(([k,v]) => [k,v.name]))}
      ${sel("Default for new starters","isDefault",[[false,"No"],[true,"Yes"]])}
    </div>
    <div class="fs"><h4>Calculation</h4>
      ${sel("Earnings basis","basis",Object.entries(ENGINE.PENSION_BASES))}
      ${sel("Tax arrangement","method",Object.entries(ENGINE.PENSION_METHODS))}
      ${f("Employee rate (0.05 = 5%)","employeeRate","number",'step="0.001"')}
      ${f("Employer rate","employerRate","number",'step="0.001"')}
    </div>
    <div class="fs"><h4>Qualifying band</h4>
      ${f("Lower limit (£/yr)","qualifyingLower","number",'step="1" placeholder="6240"')}
      ${f("Upper limit (£/yr)","qualifyingUpper","number",'step="1" placeholder="50270"')}
      <div class="hint">Only used when the earnings basis is qualifying earnings. Leave blank to use the statutory band.</div>
    </div>
    <div class="fs"><h4>Provider reference</h4>
      ${f("Employer reference","employerRef")}
      ${f("Group or payment source","groupRef")}
      <div class="hint">Needed on the contribution file. Blank until the provider issues it.</div>
    </div>
  </div>`;
}

/* ============================================================================
   INTEGRATIONS — the three external gates
   ========================================================================== */
function viewIntegrations(){
  const I = S.integrations;
  const run = S.runs.filter(r => r.committed).sort((a,b) => b.period - a.period)[0];
  const ready = run ? `${run.payslips.length} records from ${PERIODS[run.period-1].label}` : "no committed run yet";

  const card = (o) => `
  <div class="intcard">
    <div class="int-head">
      <div>
        <div class="int-name">${esc(o.title)}</div>
        <div class="int-sub">${esc(o.sub)}</div>
      </div>
      <span class="status ${o.connected ? "st-approved" : "st-pending"}">${o.connected ? "configured" : "not connected"}</span>
    </div>
    <p class="int-body">${o.body}</p>
    <div class="int-split">
      <div>
        <div class="p-l">What this system already produces</div>
        <ul class="ticks">${o.produces.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>
      <div>
        <div class="p-l">What must be obtained externally</div>
        <ul class="crosses">${o.blocked.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>
    </div>
    ${o.fields ? `<div class="formgrid" style="margin-top:20px">${o.fields}</div>` : ""}
    <div class="actions">${o.actions}</div>
  </div>`;

  const f = (label, path, extra="") => {
    const parts = path.split("."); let v = S; parts.forEach(p => v = v?.[p]);
    return `<div class="field"><label>${label}</label><input data-cfg="${path}" value="${esc(v ?? "")}" ${extra}></div>`;
  };

  return `
  ${mast("Integrations", "External connections", [
    ["HMRC RTI", I.rti.credentialsSet ? "Configured" : "Not connected"],
    ["BACS", I.bacs.sun ? "Configured" : "Not connected"],
    ["Pension providers", S.schemes.filter(s => s.employerRef).length + " of " + S.schemes.length]
  ])}

  <div class="flag" style="margin:22px 0">
    <b>These three are the only things standing between this system and paying people.</b>
    Each is an approval process rather than a development task. The data each one consumes is already
    calculated and exportable below — ${esc(ready)}.
  </div>

  ${card({
    title: "HMRC — Real Time Information",
    sub: "Full Payment Submission and Employer Payment Summary",
    connected: I.rti.credentialsSet,
    body: `Every payroll run must be reported to HMRC on or before the pay date. The FPS carries each employee's pay, tax, NI bands and year-to-date figures; the EPS reports reclaims and periods of no payment. <b>Software cannot submit without HMRC recognition</b> — an accreditation where HMRC tests your output against their scenario suite before issuing credentials.`,
    produces: [
      "FPS payload per employee with all required fields",
      "NI earnings split at LEL, LEL–PT, PT–UEL and above UEL",
      "Year-to-date taxable pay, tax, NI and pension figures",
      "Starter declarations, leaver dates and tax code basis",
      "EPS totals including any Employment Allowance claim"
    ],
    blocked: [
      "HMRC software recognition (test suite must pass)",
      "Government Gateway credentials and Sender ID",
      "A live PAYE scheme reference for the employer"
    ],
    fields: `<div class="fs">
        ${f("PAYE reference","employer.payeRef")}
        ${f("Accounts Office reference","employer.accountsOfficeRef")}
      </div><div class="fs">
        ${f("Government Gateway ID","integrations.rti.gatewayId")}
        ${f("Sender ID","integrations.rti.senderId")}
      </div>`,
    actions: `<button class="btn" data-export="fps">Export FPS data (CSV)</button>
              <button class="btn" data-export="eps">Export EPS summary (CSV)</button>
              <button class="btn" disabled title="Requires HMRC recognition">Submit to HMRC</button>`
  })}

  ${card({
    title: "BACS — payment submission",
    sub: "Bacstel-IP via a sponsoring bank or approved bureau",
    connected: !!I.bacs.sun,
    body: `Net pay reaches employees through a BACS file submitted three working days before the pay date. <b>This requires a Service User Number</b>, issued by a sponsoring bank or an approved bureau, along with a signing certificate. Without a SUN there is no way to move money, regardless of how correct the payroll is.`,
    produces: [
      "Payment instruction per employee with sort code and account",
      "Held records excluded automatically from the payment file",
      "Payment references in a consistent, reconcilable format",
      "Run totals for the contra debit",
      "Standard 18 layout fields, ready to format"
    ],
    blocked: [
      "A BACS Service User Number from a sponsoring bank",
      "Bacstel-IP smart card or software certificate",
      "Bureau agreement if submitting indirectly"
    ],
    fields: `<div class="fs">
        ${f("Service User Number","integrations.bacs.sun",'placeholder="6 digits"')}
        ${f("Bureau or sponsoring bank","integrations.bacs.bureau")}
      </div><div class="fs">
        ${f("Originating sort code","integrations.bacs.originSort")}
        ${f("Originating account","integrations.bacs.originAccount")}
      </div>`,
    actions: `<button class="btn" data-export="bacs">Export payment file (CSV)</button>
              <button class="btn" disabled title="Requires a Service User Number">Submit to BACS</button>`
  })}

  ${card({
    title: "Pension providers",
    sub: "Contribution files per scheme",
    connected: S.schemes.some(s => s.employerRef),
    body: `Each scheme has its own submission route and onboarding. Private providers such as NEST and The People's Pension take a contribution schedule per pay period. Public schemes use <b>i-Connect for LGPS</b> and <b>MDC for Teachers'</b>, each with its own administering body. The file format differs per provider; the underlying data does not.`,
    produces: [
      "Contribution amounts per member per period",
      "Pensionable earnings on the scheme's own basis",
      "Employer and employee split with the tax method",
      "Joiners, opt-outs and cessations",
      "Assessment against the auto-enrolment trigger"
    ],
    blocked: [
      "Employer reference from each provider",
      "i-Connect onboarding with the administering authority (LGPS)",
      "MDC registration with Teachers' Pensions",
      "File format confirmation per scheme"
    ],
    fields: null,
    actions: `<button class="btn" data-export="pension">Export contribution file (CSV)</button>
              <button class="btn" data-go="pensions">Manage schemes</button>`
  })}

  <div class="gov">
    <span class="eyebrow">How to describe this honestly</span>
    <p>The calculation, exception detection, payslip production and data preparation are complete and tested.
    What remains is <strong>accreditation and credentials, not engineering</strong>. HMRC recognition typically takes
    months and requires passing their test suite; a BACS SUN depends on a sponsoring bank's own due diligence;
    pension onboarding varies by provider.</p>
    <p>Saying "the engine is complete and we are in the HMRC recognition process" is accurate and defensible.
    <strong>Claiming a system is live before recognition is the kind of thing that ends a supplier relationship.</strong></p>
  </div>`;
}

/* ============================================================================
   SETTINGS
   ========================================================================== */
function viewSettings(){
  const c = S.config;
  return `
  ${mast("Settings", "Configuration", [["Tax year", c.taxYear],["Periods", String(c.periodsPerYear)],["Storage", DB.live ? "Persistent" : "Session only"]])}

  <div class="flag" style="margin:22px 0">
    <b>Rates must be verified against HMRC before any live use.</b> They change every tax year and mid-year in some Budgets.
    The figures below are defaults, not authoritative. This is why they are editable rather than compiled in.
  </div>

  <div class="sec-head"><h2>Organisation</h2></div>
  <div class="panelbox"><div class="formgrid">
    <div class="fs"><h4>Identity</h4>
      <div class="field"><label>Legal name</label><input data-cfg="employer.name" value="${esc(S.employer.name)}"></div>
      <div class="field"><label>Short name (on payslips)</label><input data-cfg="employer.shortName" value="${esc(S.employer.shortName)}"></div>
      <div class="field"><label>Address</label><input data-cfg="employer.address" value="${esc(S.employer.address)}"></div>
      <div class="field"><label>Company number</label><input data-cfg="employer.companyNumber" value="${esc(S.employer.companyNumber||"")}"></div>
    </div>
    <div class="fs"><h4>Type and payroll</h4>
      <div class="field"><label>Sector</label><select data-cfg="employer.sector">
        ${[["private","Private company"],["public","Public body"],["charity","Charity / not for profit"]].map(([v,t]) =>
          `<option value="${v}" ${S.employer.sector===v?"selected":""}>${t}</option>`).join("")}
      </select></div>
      <div class="field"><label>Pay frequency</label><select data-cfg="config.payFrequency" data-reload="1">
        ${Object.entries(ENGINE.PAY_FREQUENCIES).map(([k,v]) =>
          `<option value="${k}" ${S.config.payFrequency===k?"selected":""}>${v.label} — ${v.periods} periods</option>`).join("")}
      </select></div>
      <div class="field"><label>Tax region</label><select data-cfg="config.region">
        <option value="restOfUK" ${S.config.region==="restOfUK"?"selected":""}>England, Wales and NI</option>
        <option value="scotland" ${S.config.region==="scotland"?"selected":""}>Scotland</option>
      </select>
      <div class="hint">An S-prefixed tax code always uses Scottish bands regardless of this setting.</div></div>
    </div>
    <div class="fs"><h4>Employer reliefs</h4>
      <div class="field"><label>Claims Employment Allowance</label><select data-cfg="employer.claimsEmploymentAllowance">
        <option value="true" ${S.employer.claimsEmploymentAllowance?"selected":""}>Yes</option>
        <option value="false" ${!S.employer.claimsEmploymentAllowance?"selected":""}>No</option>
      </select>
      <div class="hint">Most public bodies are not eligible. Worth up to ${money(S.config.employerReliefs.employmentAllowance,0)} off employer NI.</div></div>
      <div class="field"><label>Small employer (statutory recovery)</label><select data-cfg="employer.smallEmployer">
        <option value="true" ${S.employer.smallEmployer?"selected":""}>Yes — recover 103%</option>
        <option value="false" ${!S.employer.smallEmployer?"selected":""}>No — recover 92%</option>
      </select></div>
      <div class="field"><label>Pays Apprenticeship Levy</label><select data-cfg="employer.apprenticeshipLevy">
        <option value="true" ${S.employer.apprenticeshipLevy?"selected":""}>Yes</option>
        <option value="false" ${!S.employer.apprenticeshipLevy?"selected":""}>No</option>
      </select>
      <div class="hint">Applies where the annual pay bill exceeds ${money(S.config.employerReliefs.apprenticeshipLevyThreshold,0)}.</div></div>
    </div>
    <div class="fs"><h4>HMRC references</h4>
      <div class="field"><label>PAYE reference</label><input data-cfg="employer.payeRef" value="${esc(S.employer.payeRef)}"></div>
      <div class="field"><label>Accounts Office reference</label><input data-cfg="employer.accountsOfficeRef" value="${esc(S.employer.accountsOfficeRef)}"></div>
    </div>
  </div></div>

  <div class="sec-head"><h2>Statutory payments</h2></div>
  <div class="panelbox"><div class="formgrid">
    <div class="fs">
      <div class="field"><label>SSP weekly rate (£)</label><input type="number" step="0.01" data-cfg="config.statutory.sspWeekly" value="${S.config.statutory.sspWeekly}"></div>
      <div class="field"><label>SSP waiting days</label><input type="number" data-cfg="config.statutory.sspWaitingDays" value="${S.config.statutory.sspWaitingDays}"></div>
    </div>
    <div class="fs">
      <div class="field"><label>SMP standard weekly rate (£)</label><input type="number" step="0.01" data-cfg="config.statutory.smpStandardWeekly" value="${S.config.statutory.smpStandardWeekly}"></div>
      <div class="field"><label>SMP higher rate weeks</label><input type="number" data-cfg="config.statutory.smpHigherWeeks" value="${S.config.statutory.smpHigherWeeks}"></div>
    </div>
    <div class="fs">
      <div class="field"><label>Auto-enrolment trigger (£/yr)</label><input type="number" data-cfg="config.autoEnrolment.triggerAnnual" value="${S.config.autoEnrolment.triggerAnnual}"></div>
      <div class="field"><label>Qualifying lower (£/yr)</label><input type="number" data-cfg="config.autoEnrolment.qualifyingLower" value="${S.config.autoEnrolment.qualifyingLower}"></div>
      <div class="field"><label>Qualifying upper (£/yr)</label><input type="number" data-cfg="config.autoEnrolment.qualifyingUpper" value="${S.config.autoEnrolment.qualifyingUpper}"></div>
    </div>
    <div class="fs">
      <div class="field"><label>Employment Allowance (£/yr)</label><input type="number" data-cfg="config.employerReliefs.employmentAllowance" value="${S.config.employerReliefs.employmentAllowance}"></div>
    </div>
  </div></div>

  <div class="sec-head"><h2>Income tax</h2></div>
  <div class="panelbox">
  <div class="flag ok" style="margin:0 0 20px"><b>There is no personal allowance setting, deliberately.</b>
  Each employee's tax-free allowance comes from their tax code, which HMRC issues per person — 1257L means £12,579 of free pay.
  A global allowance setting would be ignored by the calculation and is worse than no setting at all.</div>
  <div class="formgrid">
    <div class="fs">
      <div class="field"><label>Tax year label</label><input data-cfg="config.taxYear" value="${esc(c.taxYear)}"></div>
      <div class="field"><label>Basic rate limit (£)</label><input type="number" data-cfg="config.bands.0.limit" value="${c.bands[0].limit}"></div>
      <div class="field"><label>Higher rate limit (£)</label><input type="number" data-cfg="config.bands.1.limit" value="${c.bands[1].limit}"></div>
    </div>
    <div class="fs">
      <div class="field"><label>Basic rate</label><input type="number" step="0.01" data-cfg="config.bands.0.rate" value="${c.bands[0].rate}"></div>
      <div class="field"><label>Higher rate</label><input type="number" step="0.01" data-cfg="config.bands.1.rate" value="${c.bands[1].rate}"></div>
      <div class="field"><label>Additional rate</label><input type="number" step="0.01" data-cfg="config.bands.2.rate" value="${c.bands[2].rate}"></div>
    </div>
  </div></div>

  <div class="sec-head"><h2>National Insurance</h2></div>
  <div class="panelbox"><div class="formgrid">
    <div class="fs">
      <div class="field"><label>Lower Earnings Limit (£/yr)</label><input type="number" data-cfg="config.ni.lel" value="${c.ni.lel}"></div>
      <div class="field"><label>Primary Threshold (£/yr)</label><input type="number" data-cfg="config.ni.pt" value="${c.ni.pt}"></div>
      <div class="field"><label>Secondary Threshold (£/yr)</label><input type="number" data-cfg="config.ni.st" value="${c.ni.st}"></div>
      <div class="field"><label>Upper Earnings Limit (£/yr)</label><input type="number" data-cfg="config.ni.uel" value="${c.ni.uel}"></div>
    </div>
    <div class="fs">
      <div class="field"><label>Employee main rate</label><input type="number" step="0.001" data-cfg="config.ni.employeeMain" value="${c.ni.employeeMain}"></div>
      <div class="field"><label>Employee upper rate</label><input type="number" step="0.001" data-cfg="config.ni.employeeUpper" value="${c.ni.employeeUpper}"></div>
      <div class="field"><label>Employer rate</label><input type="number" step="0.001" data-cfg="config.ni.employerRate" value="${c.ni.employerRate}"></div>
    </div>
  </div></div>

  <div class="sec-head"><h2>Student loans</h2></div>
  <div class="panelbox"><div class="formgrid">
    ${["plan1","plan2","plan4","plan5","pgl"].map(k => `<div class="fs">
      <div class="field"><label>${k === "pgl" ? "Postgraduate" : k.replace("plan","Plan ")} threshold (£/yr)</label>
        <input type="number" data-cfg="config.studentLoans.${k}.threshold" value="${c.studentLoans[k].threshold}"></div>
      <div class="field"><label>Rate</label>
        <input type="number" step="0.01" data-cfg="config.studentLoans.${k}.rate" value="${c.studentLoans[k].rate}"></div>
    </div>`).join("")}
  </div></div>

  <div class="sec-head"><h2>Data</h2></div>
  <div class="panelbox">
    <p style="margin:0 0 16px;max-width:70ch;color:var(--ink2);font-size:14px">
      ${DB.live
        ? "Data is stored in this browser only. Nothing is transmitted anywhere. Clearing browser data will delete it — export a backup first."
        : "<b>Browser storage is unavailable here, so data will not survive a refresh.</b> Download the file and open it directly from your machine for persistence."}
    </p>
    <div class="actions">
      <button class="btn" id="exportBtn">Export all data (JSON)</button>
      <button class="btn" id="importBtn">Import data</button>
      <button class="btn" data-export="employees">Export employees (CSV)</button>
      <button class="btn" id="resetPrivate">Load private company example</button>
      <button class="btn" id="resetPublic">Load public sector example</button>
    </div>
    <input type="file" id="importFile" accept="application/json" style="display:none">
  </div>
  ${banner()}`;
}

/* ============================================================================
   SHARED CHROME
   ========================================================================== */
function mast(eyebrow, title, figs, extra=""){
  return `<div class="masthead">
    <div class="mast-top"><span class="eyebrow">${esc(eyebrow)}</span>
      <span class="mast-ref">${esc(S.employer.name.toUpperCase())} · PAYE <b>${esc(S.employer.payeRef)}</b></span></div>
    <div class="mast-body">
      <div><span class="eyebrow">${esc(S.config.taxYear)}</span><h1>${esc(title)}</h1></div>
      <div class="mast-figs">${figs.map(([l,v]) => `<div><span class="fig-l">${esc(l)}</span><span class="fig-v">${esc(v)}</span></div>`).join("")}</div>
    </div>
    ${extra}
  </div>`;
}
function counter(v, l, small=false){
  return `<div class="counter"><div class="c-v" ${small ? 'style="font-size:15px;font-family:var(--sans);font-weight:500"' : ""}>${esc(v)}</div><div class="c-l">${esc(l)}</div></div>`;
}
function banner(){
  return `<div class="gov">
    <span class="eyebrow">What this build does and does not do</span>
    <p><strong>Calculates:</strong> cumulative and non-cumulative PAYE including Scottish bands, National Insurance across all categories plus the annual director basis, student and postgraduate loans, pension schemes on four earnings bases, Employment Allowance, statutory payments, leave entitlement in hours, and cross-run exception detection. Any pay frequency from weekly to quarterly.</p>
    <p><strong>Does not:</strong> submit RTI to HMRC, generate live BACS payments, or file to pension providers. All three need external accreditation and credentials rather than code — see Integrations, where the data each one consumes is exportable today.</p>
  </div>`;
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function freqLabel(){ return (ENGINE.PAY_FREQUENCIES[S.config.payFrequency]||{}).label || "Monthly"; }

/* ============================================================================
   MODAL
   ========================================================================== */
let modalCtx = null;
/* ============================================================================
   MODAL ACTIONS
   ----------------------------------------------------------------------------
   Bound once to document, not per render.

   The previous version used the same per-element binding as everything else,
   which attaches listeners only to elements that exist at that moment. Modal
   buttons are written into the DOM afterwards, so they never received one —
   Save, Delete and Close all did nothing, and the dialog could only be escaped
   by reloading the page.

   Delegation survives any DOM replacement, which is what a dialog needs.
   ========================================================================== */
function bindModalActions(){
  if(window.__modalActionsBound) return;
  window.__modalActionsBound = true;

  document.addEventListener("click", ev => {
    const btn = ev.target.closest && ev.target.closest("[data-ma]");
    if(!btn) return;
    const e = { currentTarget: btn };
    const id = e.currentTarget.dataset.ma;
    if(id === "close") return closeModal();
    if(id === "print" && modalCtx?.kind === "slip"){
      const e3 = emp(modalCtx.id);
      return printHTML("Payslip " + e3.name, `<div class="modal">${payslipHTML(modalCtx.id, modalCtx.period)}</div>`);
    }
    if(id === "print") return window.print();
    if(id === "dl" && modalCtx?.kind === "slip"){
      const e2 = emp(modalCtx.id);
      return download("payslip-" + (e2.payrollNumber || modalCtx.id) + "-p" + modalCtx.period + ".html",
        payslipDocument("Payslip " + e2.name, `<div class="modal">${payslipHTML(modalCtx.id, modalCtx.period)}</div>`),
        "text/html");
    }
    if(id === "saveScheme") return saveScheme();
    if(id === "delScheme") return deleteScheme();
    if(id === "saveEmp") return saveEmployee();
    if(id === "delEmp") return deleteEmployee();
    if(id === "p45dl" && modalCtx?.kind === "p45"){
      const x = emp(modalCtx.id);
      return download("p45-" + (x.payrollNumber || modalCtx.id) + ".html",
        payslipDocument("P45 " + x.name, `<div class="modal">${p45HTML(modalCtx.id)}</div>`), "text/html");
    }
    if(id === "p45print" && modalCtx?.kind === "p45"){
      const x = emp(modalCtx.id);
      return printHTML("P45 " + x.name, `<div class="modal">${p45HTML(modalCtx.id)}</div>`);
    }
    if(id === "saveEl") return savePayElement();

  });

  // Clicking the backdrop, or pressing Escape, closes the dialog. Without
  // these the only way out of a stuck modal is a page reload.
  document.addEventListener("click", ev => {
    if(ev.target && ev.target.id === "scrim") closeModal();
  });
  document.addEventListener("keydown", ev => {
    if(ev.key === "Escape" && document.getElementById("scrim")
       && document.getElementById("scrim").classList.contains("show")) closeModal();
  });
}

function openModal(label, html, opts = {}){
  document.getElementById("modalLabel").textContent = label;
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modalActions").innerHTML = (opts.actions || []).map(a =>
    `<button class="btn sm ${a.primary ? "primary" : ""}" data-ma="${a.id}">${esc(a.label)}</button>`).join("") +
    `<button class="btn sm" data-ma="close">Close</button>`;
  modalCtx = opts.ctx || null;
  bindModalActions();
  document.getElementById("scrim").classList.add("show");
  document.body.style.overflow = "hidden";
}
function closeModal(){
  document.getElementById("scrim").classList.remove("show");
  document.body.style.overflow = "";
  modalCtx = null;
}

/* ============================================================================
   EXPORTS
   ========================================================================== */
function download(name, content, type = "text/plain"){
  const blob = new Blob([content], { type: type + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
function csv(rows){
  return rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }).join(",")).join("\n");
}
function exportCSV(kind){
  if(kind === "employees"){
    const rows = [["Name","Payroll no","NI number","DOB","Start","Leaving","Job title","Department","Annual salary","Weekly hours","Tax code","NI cat","Pension scheme","Student loan","Status"]];
    S.employees.forEach(e => rows.push([e.name,e.payrollNumber,e.niNumber,e.dob,e.startDate,e.leavingDate,e.jobTitle,e.department,e.annualSalary,e.weeklyHours,e.taxCode,e.niCategory,(schemeFor(e)||{}).name||"",e.studentLoanPlan,e.status]));
    return download("employees.csv", csv(rows), "text/csv");
  }
  const run = runFor(S.currentPeriod);
  if(!run) return;
  const held = new Set(run.exceptions.filter(x => run.decisions[x.ref]?.type === "hold").flatMap(x => x.employeeIds));

  if(kind === "fps"){
    const rows = [["Payroll ID","Surname","Forename","NI number","DOB","Tax code","Basis","NI category","Taxable pay this period","Tax this period","Taxable pay to date","Tax to date","Employee NIC","Employer NIC","Earnings at LEL","Earnings LEL to PT","Earnings PT to UEL","Pension contributions","Student loan","Net pay","Payment date"]];
    run.payslips.filter(ps => !held.has(ps.employeeId)).forEach(ps => {
      const e = emp(ps.employeeId); if(!e) return;
      const parts = e.name.trim().split(" ");
      rows.push([e.payrollNumber, parts.slice(-1)[0], parts.slice(0,-1).join(" "), e.niNumber, e.dob,
        e.taxCode, ps.paye.code.cumulative ? "Cumulative" : "Wk1/Mth1", ps.ni.category,
        ps.taxableThis.toFixed(2), ps.paye.tax.toFixed(2), ps.ytd.taxable.toFixed(2), ps.ytd.tax.toFixed(2),
        ps.ni.employee.toFixed(2), ps.ni.employer.toFixed(2), ps.ni.earningsAtLEL.toFixed(2),
        ps.ni.earningsLELtoPT.toFixed(2), ps.ni.earningsPTtoUEL.toFixed(2),
        ps.pension.employee.toFixed(2), ps.studentLoan.total.toFixed(2), ps.net.toFixed(2),
        PERIODS[run.period-1].payDate]);
    });
    return download("fps-period-" + run.period + ".csv", csv(rows), "text/csv");
  }
  if(kind === "eps"){
    const r2 = ENGINE.applyEmployerReliefs({ totalEmployerNI: run.totals.niEmployer,
      allowanceUsedToDate: 0, org: S.employer, config: S.config });
    const rows = [["Field","Value"],
      ["PAYE reference", S.employer.payeRef],
      ["Accounts Office reference", S.employer.accountsOfficeRef],
      ["Tax year", S.config.taxYear],
      ["Period", String(run.period)],
      ["Employment Allowance claimed", S.employer.claimsEmploymentAllowance ? "Yes" : "No"],
      ["Employment Allowance this period", r2.employmentAllowanceClaimed.toFixed(2)],
      ["Employer NI gross", run.totals.niEmployer.toFixed(2)],
      ["Employer NI payable", r2.employerNIPayable.toFixed(2)],
      ["Total tax due", run.totals.tax.toFixed(2)],
      ["Total employee NI", run.totals.niEmployee.toFixed(2)],
      ["Small employer relief", S.employer.smallEmployer ? "Yes" : "No"],
      ["Apprenticeship Levy", S.employer.apprenticeshipLevy ? "Yes" : "No"]];
    return download("eps-period-" + run.period + ".csv", csv(rows), "text/csv");
  }
  if(kind === "pension"){
    const rows = [["Scheme","Provider","Employer ref","Group","Payroll ID","Name","NI number","Pensionable earnings","Basis","Employee contribution","Employer contribution","Tax method","Period","Pay date"]];
    run.payslips.filter(ps => !held.has(ps.employeeId) && ps.pension.employee + ps.pension.employer > 0).forEach(ps => {
      const e = emp(ps.employeeId); if(!e) return;
      const s = schemeFor(e); if(!s) return;
      rows.push([s.name, (PROVIDERS[s.provider]||PROVIDERS.other).name, s.employerRef||"", s.groupRef||"",
        e.payrollNumber, e.name, e.niNumber, ps.pension.earnings.toFixed(2),
        ENGINE.PENSION_BASES[ps.pension.basis]||"", ps.pension.employee.toFixed(2), ps.pension.employer.toFixed(2),
        ENGINE.PENSION_METHODS[ps.pension.method]||"", String(run.period), PERIODS[run.period-1].payDate]);
    });
    return download("pension-contributions-p" + run.period + ".csv", csv(rows), "text/csv");
  }
  if(kind === "bacs"){
    const rows = [["Sort code","Account number","Account name","Amount","Reference"]];
    run.payslips.filter(ps => !held.has(ps.employeeId) && ps.net > 0).forEach(ps => {
      const e = emp(ps.employeeId); if(!e) return;
      rows.push([e.bankSort||"", e.bankAccount||"", e.name, ps.net.toFixed(2), "SAL" + e.payrollNumber + "P" + String(run.period).padStart(2,"0")]);
    });
    return download("bacs-period-" + run.period + ".csv", csv(rows), "text/csv");
  }
}

/* ============================================================================
   EVENT BINDING
   ========================================================================== */
function bind(){
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));

  on("[data-go]", "click", e => go(e.currentTarget.dataset.go));

  // --- employees ---
  on("[data-edit]", "click", e => editEmployee(e.currentTarget.dataset.edit));
  on("[data-add]", "click", () => editEmployee(null));
  on("[data-editscheme]", "click", e => editScheme(e.currentTarget.dataset.editscheme));
  on("[data-addscheme]", "click", () => editScheme(null));

  // --- payroll ---
  const pp = document.getElementById("periodPick");
  if(pp) pp.addEventListener("change", () => { S.currentPeriod = +pp.value; save(); render(); });
  const cb = document.getElementById("calcBtn");
  if(cb) cb.addEventListener("click", () => { calculateRun(S.currentPeriod); render(); });

  on(".row-btn", "click", e => {
    const row = e.currentTarget.closest(".row");
    row.classList.toggle("open");
  });
  on("[data-dec]", "click", e => {
    e.stopPropagation();
    const [ref, type] = e.currentTarget.dataset.dec.split("|");
    const run = runFor(S.currentPeriod);
    run.decisions[ref] = { type, time: new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}), by: "A. Okafor, Payroll Manager" };
    save(); render();
    const r = document.querySelector(`[data-ex="${ref}"]`); if(r) r.classList.add("open");
  });
  on("[data-undo]", "click", e => {
    e.stopPropagation();
    const run = runFor(S.currentPeriod);
    delete run.decisions[e.currentTarget.dataset.undo];
    save(); render();
  });
  const commit = document.getElementById("commitBtn");
  if(commit) commit.addEventListener("click", () => {
    const run = runFor(S.currentPeriod);
    run.committed = true; run.committedAt = new Date().toISOString();
    save(); render();
  });
  const uncommit = document.getElementById("uncommitBtn");
  if(uncommit) uncommit.addEventListener("click", () => {
    const run = runFor(S.currentPeriod);
    if(S.runs.some(r => r.period > run.period && r.committed)){
      alert("Later periods are already committed. Reopen those first — year-to-date figures depend on them.");
      return;
    }
    run.committed = false; save(); render();
  });
  const addEl = document.getElementById("addElBtn");
  if(addEl) addEl.addEventListener("click", payElementModal);

  on("[data-export]", "click", e => exportCSV(e.currentTarget.dataset.export));

  const jp = document.getElementById("jPeriod");
  if(jp) jp.addEventListener("change", () => { journalPeriod = +jp.value; render(); });

  on("[data-jexp]", "click", e => {
    const run = S.runs.find(r => r.committed && r.period === journalPeriod);
    if(!run) return;
    const p = PERIODS[run.period - 1];
    const j = buildJournalForRun(run, p);
    const fmt = e.currentTarget.dataset.jexp;
    if(fmt === "csv")  return download(j.reference + ".csv", journalToCSV(j), "text/csv");
    if(fmt === "sage") return download(j.reference + "-sage.csv", journalToSage(j), "text/csv");
    if(fmt === "xero") return download(j.reference + "-xero.json",
      JSON.stringify(journalToXero(j), null, 2), "application/json");
  });

  on("[data-mode]", "click", e => {
    const m = e.currentTarget.dataset.mode;
    S.automation.mode = m;
    S.automation.policy = defaultPolicy(m);
    S.runs.filter(r => !r.committed).forEach(r => calculateRun(r.period));
    save(); render();
  });
  on("[data-cover]", "change", e => {
    const k = e.currentTarget.dataset.cover;
    let v = e.currentTarget.value;
    if(e.currentTarget.type === "number") v = parseFloat(v) || 0;
    if(v === "true") v = true; if(v === "false") v = false;
    S.automation.cover[k] = v;
    save(); render();
  });
  on("[data-rule]", "change", e => {
    S.automation.policy[e.currentTarget.dataset.rule] = e.currentTarget.value;
    S.runs.filter(r => !r.committed).forEach(r => calculateRun(r.period));
    save(); render();
  });
  on("[data-doact]", "click", e => {
    const run = runFor(S.currentPeriod);
    const act = (run?.actions || []).find(x => x.id === e.currentTarget.dataset.doact);
    if(act){ applyAction(act, run, false); save(); calculateRun(S.currentPeriod); render(); }
  });
  on("[data-skipact]", "click", e => {
    const run = runFor(S.currentPeriod);
    const act = (run?.actions || []).find(x => x.id === e.currentTarget.dataset.skipact);
    if(act){
      run.skipped = run.skipped || [];
      run.skipped.push(actionKey(act));
      run.actions = run.actions.filter(x => x.id !== act.id);
      save(); render();
    }
  });
  on("[data-undoact]", "click", e => reverseLogEntry(e.currentTarget.dataset.undoact));
  const sf = document.getElementById("slipEmp");
  if(sf) sf.addEventListener("change", () => { slipFilter = sf.value; render(); });

  const tsIn = document.getElementById("tsApprover");
  if(tsIn) tsIn.addEventListener("change", () => { S.approverEmail = tsIn.value.trim(); save(); });

  on("[data-tsapprove]", "click", e => {
    const ts = (S.timesheets || []).find(t => t.id === e.currentTarget.dataset.tsapprove);
    if(!ts) return;
    const approver = (document.getElementById("tsApprover")?.value || "").trim();
    if(!approver) return alert("Enter the approver's email first.");
    // The same rule the database enforces: nobody may approve their own hours.
    if(approver.toLowerCase() === String(ts.submittedBy || "").toLowerCase()){
      return alert("You cannot approve your own timesheet. Somebody else has to.");
    }
    ts.status = "approved"; ts.approvedBy = approver; ts.approvedAt = new Date().toISOString();
    save(); render();
  });

  on("[data-tsreject]", "click", e => {
    const ts = (S.timesheets || []).find(t => t.id === e.currentTarget.dataset.tsreject);
    if(!ts) return;
    ts.status = "rejected"; save(); render();
  });

  on("[data-p45]", "click", e => {
    const id = e.currentTarget.dataset.p45;
    openModal("P45 · " + emp(id).name, p45HTML(id),
      { actions: [{ id:"p45dl", label:"Download" }, { id:"p45print", label:"Print" }],
        ctx: { kind:"p45", id } });
  });
  on("[data-p45dl]", "click", e => {
    const id = e.currentTarget.dataset.p45dl, x = emp(id);
    download("p45-" + (x.payrollNumber || id) + ".html",
      payslipDocument("P45 " + x.name, `<div class="modal">${p45HTML(id)}</div>`), "text/html");
  });
  on("[data-p45pr]", "click", e => {
    const id = e.currentTarget.dataset.p45pr, x = emp(id);
    printHTML("P45 " + x.name, `<div class="modal">${p45HTML(id)}</div>`);
  });

  on("[data-slipdl]", "click", e => {
    const [id, period] = e.currentTarget.dataset.slipdl.split("|");
    const e2 = emp(id);
    download("payslip-" + (e2.payrollNumber||id) + "-p" + period + ".html",
      payslipDocument("Payslip " + e2.name, `<div class="modal">${payslipHTML(id, +period)}</div>`), "text/html");
  });
  on("[data-slippr]", "click", e => {
    const [id, period] = e.currentTarget.dataset.slippr.split("|");
    const e2 = emp(id);
    printHTML("Payslip " + e2.name, `<div class="modal">${payslipHTML(id, +period)}</div>`);
  });
  on("[data-slipall]", "click", e => {
    const period = +e.currentTarget.dataset.slipall;
    const run = runFor(period);
    const rows = run.payslips.filter(ps => !slipFilter || ps.employeeId === slipFilter);
    const body = rows.map((ps,i) =>
      `<div class="modal ${i < rows.length-1 ? "pagebreak" : ""}">${payslipHTML(ps.employeeId, period)}</div>`).join("");
    download("payslips-period-" + period + ".html",
      payslipDocument(PERIODS[period-1].label + " payslips", body), "text/html");
  });
  on("[data-slipcsv]", "click", e => {
    const period = +e.currentTarget.dataset.slipcsv;
    const run = runFor(period);
    const rows = [["Payroll no","Name","Department","Gross","Taxable","PAYE","Employee NI","Pension","Student loan","Total deductions","Net","Employer NI","Employer pension","Employment cost"]];
    run.payslips.filter(ps => !slipFilter || ps.employeeId === slipFilter).forEach(ps => {
      const x = emp(ps.employeeId); if(!x) return;
      rows.push([x.payrollNumber, x.name, x.department, ps.gross.toFixed(2), ps.taxableThis.toFixed(2),
        ps.paye.tax.toFixed(2), ps.ni.employee.toFixed(2), ps.pension.employee.toFixed(2),
        ps.studentLoan.total.toFixed(2), ps.totalDeductions.toFixed(2), ps.net.toFixed(2),
        ps.ni.employer.toFixed(2), ps.pension.employer.toFixed(2), ps.employerCost.toFixed(2)]);
    });
    download("payslip-summary-p" + period + ".csv", csv(rows), "text/csv");
  });

  on("[data-slip]", "click", e => {
    const [id, period] = e.currentTarget.dataset.slip.split("|");
    const emply = emp(id);
    openModal("Payslip · " + emply.name + " · " + PERIODS[period-1].label,
      payslipHTML(id, +period),
      { actions:[{id:"dl",label:"Download",primary:false},{id:"print",label:"Print"}],
        ctx:{ kind:"slip", id, period:+period } });
  });

  // --- leave ---
  ["lvEmp","lvFrom","lvTo","lvHalf","lvType"].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener("change", lvCalc);
  });
  if(document.getElementById("lvCalc")) lvCalc();
  const lvs = document.getElementById("lvSubmit");
  if(lvs) lvs.addEventListener("click", () => {
    const e = emp(document.getElementById("lvEmp").value);
    const from = document.getElementById("lvFrom").value, to = document.getElementById("lvTo").value;
    const b = ENGINE.leaveBalance(e, S.leave, todayISO());
    const lv = ENGINE.leaveHours(from, to, document.getElementById("lvHalf").value, b.hoursPerDay);
    if(!lv || lv.days <= 0) return;
    S.leave.push({ id:uid(), employeeId:e.id, from, to, hours:lv.hours, type:document.getElementById("lvType").value, status:"pending" });
    save(); render();
  });
  on("[data-lv]", "click", e => {
    const [id, action] = e.currentTarget.dataset.lv.split("|");
    const l = S.leave.find(x => x.id === id);
    l.status = action === "approve" ? "approved" : "rejected";
    save(); render();
  });
  on("[data-lvdel]", "click", e => {
    S.leave = S.leave.filter(x => x.id !== e.currentTarget.dataset.lvdel);
    save(); render();
  });

  // --- settings ---
  on("[data-cfg]", "change", e => {
    const path = e.currentTarget.dataset.cfg.split(".");
    let o = S, k;
    for(let i = 0; i < path.length - 1; i++) o = o[path[i]];
    k = path[path.length - 1];
    const v = e.currentTarget.value;
    o[k] = e.currentTarget.type === "number" ? parseFloat(v) : (v === "true" ? true : v === "false" ? false : v);
    if(e.currentTarget.dataset.reload || path.includes("payFrequency")){
      refreshPeriods();
      S.runs = []; S.currentPeriod = 1;
      alert("Pay frequency changed. Existing runs have been cleared because period boundaries and thresholds differ.");
    }
    save(); render();
  });
  const exp = document.getElementById("exportBtn");
  if(exp) exp.addEventListener("click", () => download("hr-payroll-backup.json", JSON.stringify(S, null, 2), "application/json"));
  const imp = document.getElementById("importBtn");
  if(imp) imp.addEventListener("click", () => document.getElementById("importFile").click());
  const impf = document.getElementById("importFile");
  if(impf) impf.addEventListener("change", ev => {
    const file = ev.target.files[0]; if(!file) return;
    const r = new FileReader();
    r.onload = () => { try { S = JSON.parse(r.result); save(); render(); } catch(err){ alert("That file could not be read."); } };
    r.readAsText(file);
  });
  [["resetPrivate","private"],["resetPublic","public"]].forEach(([id,preset]) => {
    const b = document.getElementById(id);
    if(b) b.addEventListener("click", () => {
      if(confirm("Replace all data with the " + preset + " sector example? This cannot be undone.")){
        S = seedState(preset); save(); location.reload();
      }
    });
  });

  // Modal actions are delegated from document — see bindModalActions().

}

/* ---------- employee editing ---------------------------------------------- */
let editingId = null;
function editEmployee(id){
  editingId = id;
  const e = id ? emp(id) : {
    id: uid(), status:"active", weeklyHours:37, daysPerWeek:5, taxCode:"1257L", niCategory:"A",
    pensionRate:0.065, pensionMethod:"netPay", pensionEmployerRate:0.204, studentLoanPlan:"none",
    postgradLoan:false, leaveDays:26, bankHolidayDays:8, carriedDays:0, otherDeductions:[], annualSalary:0
  };
  if(!id) window.__newEmp = e;
  openModal(id ? "Edit — " + e.name : "Add employee", employeeForm(e), {
    actions: id
      ? [{id:"saveEmp",label:"Save",primary:true},{id:"delEmp",label:"Delete"}]
      : [{id:"saveEmp",label:"Add employee",primary:true}]
  });
}
function saveEmployee(){
  const e = editingId ? emp(editingId) : window.__newEmp;
  document.querySelectorAll("[data-f]").forEach(el => {
    const k = el.dataset.f;
    let v = el.value;
    if(el.type === "number") v = v === "" ? 0 : parseFloat(v);
    if(v === "true") v = true; if(v === "false") v = false;
    e[k] = v;
  });
  if(!e.name){ alert("A name is required."); return; }
  if(!editingId) S.employees.push(e);
  save(); closeModal(); render();
}
function deleteEmployee(){
  if(!confirm("Delete this employee? Committed payslips will keep their record.")) return;
  S.employees = S.employees.filter(x => x.id !== editingId);
  save(); closeModal(); render();
}

/* ---------- pension scheme editing ---------------------------------------- */
let editingScheme = null;
function editScheme(id){
  editingScheme = id;
  const s = id ? S.schemes.find(x => x.id === id) : {
    id: "SCH" + (S.schemes.length + 1), name: "New scheme", provider: "other",
    basis: "qualifying", method: "reliefAtSource", employeeRate: 0.05, employerRate: 0.03,
    employerRef: "", groupRef: "", isDefault: false
  };
  if(!id) window.__newScheme = s;
  openModal(id ? "Edit scheme — " + s.name : "Add pension scheme", schemeForm(s), {
    actions: id ? [{id:"saveScheme",label:"Save",primary:true},{id:"delScheme",label:"Delete"}]
                : [{id:"saveScheme",label:"Add scheme",primary:true}]
  });
}
function saveScheme(){
  const s = editingScheme ? S.schemes.find(x => x.id === editingScheme) : window.__newScheme;
  document.querySelectorAll("[data-s]").forEach(el => {
    const k = el.dataset.s;
    let v = el.value;
    if(el.type === "number") v = v === "" ? undefined : parseFloat(v);
    if(v === "true") v = true; if(v === "false") v = false;
    s[k] = v;
  });
  if(s.isDefault) S.schemes.forEach(x => { if(x !== s) x.isDefault = false; });
  if(!editingScheme) S.schemes.push(s);
  S.runs.filter(r => !r.committed).forEach(r => calculateRun(r.period));
  save(); closeModal(); render();
}
function deleteScheme(){
  const members = S.employees.filter(e => e.pensionSchemeId === editingScheme).length;
  if(members && !confirm(members + " employee(s) are in this scheme and will be left unenrolled. Continue?")) return;
  S.employees.forEach(e => { if(e.pensionSchemeId === editingScheme) e.pensionSchemeId = ""; });
  S.schemes = S.schemes.filter(x => x.id !== editingScheme);
  save(); closeModal(); render();
}

/* ---------- pay elements --------------------------------------------------- */
function payElementModal(){
  const run = runFor(S.currentPeriod);
  const rows = Object.entries(run.elements || {}).flatMap(([id, els]) =>
    els.map((el,i) => `<div class="prow"><span><b>${esc(emp(id)?.name||"?")}</b><span class="r-sub">${esc(el.label)}${el.hours ? ` · ${el.hours} hrs @ ${money(el.rate||0)}` : ""}</span></span>
      <span class="m">${money(el.amount)}</span><span></span>
      <button class="btn sm" data-delel="${id}|${i}">Remove</button></div>`));

  openModal("Pay elements — " + PERIODS[S.currentPeriod-1].label, `
    <div style="padding:22px">
      <p style="margin:0 0 18px;color:var(--ink2);font-size:14px;max-width:66ch">
        Elements are added on top of basic salary. Enter either an amount, or hours and a rate and the amount is worked out for you.</p>
      <div class="formgrid"><div class="fs">
        <div class="field"><label>Employee</label><select id="elEmp">
          ${activeEmployees().map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Description</label><input id="elLabel" value="Overtime" placeholder="e.g. Overtime"></div>
        <div class="field"><label>Hours (optional)</label><input type="number" step="0.25" id="elHours" placeholder=""></div>
        <div class="field"><label>Rate per hour (optional)</label><input type="number" step="0.01" id="elRate" placeholder=""></div>
        <div class="field"><label>Amount (£)</label><input type="number" step="0.01" id="elAmount" value="0"></div>
        <div class="field"><label>Pensionable</label><select id="elPen"><option value="true">Yes</option><option value="false">No</option></select></div>
      </div></div>
      ${rows.length ? `<div class="sec-head" style="margin-top:26px"><h2>Already added</h2></div><div class="ledger">${rows.join("")}</div>` : ""}
    </div>`, { actions:[{id:"saveEl",label:"Add element",primary:true}] });

  const sync = () => {
    const h = parseFloat(document.getElementById("elHours").value);
    const r = parseFloat(document.getElementById("elRate").value);
    if(!isNaN(h) && !isNaN(r)) document.getElementById("elAmount").value = (h*r).toFixed(2);
  };
  ["elHours","elRate"].forEach(id => document.getElementById(id).addEventListener("input", sync));
  document.querySelectorAll("[data-delel]").forEach(b => b.addEventListener("click", ev => {
    const [id, i] = ev.currentTarget.dataset.delel.split("|");
    run.elements[id].splice(+i,1);
    if(!run.elements[id].length) delete run.elements[id];
    save(); calculateRun(S.currentPeriod); closeModal(); render();
  }));
}
function savePayElement(){
  const run = runFor(S.currentPeriod);
  const id = document.getElementById("elEmp").value;
  const amount = parseFloat(document.getElementById("elAmount").value);
  if(!amount || isNaN(amount)){ alert("Enter an amount, or hours and a rate."); return; }
  const h = parseFloat(document.getElementById("elHours").value);
  const r = parseFloat(document.getElementById("elRate").value);
  run.elements = run.elements || {};
  (run.elements[id] = run.elements[id] || []).push({
    label: document.getElementById("elLabel").value || "Additional payment",
    amount, hours: isNaN(h) ? null : h, rate: isNaN(r) ? null : r,
    pensionable: document.getElementById("elPen").value === "true"
  });
  save(); calculateRun(S.currentPeriod); closeModal(); render();
}

/* ============================================================================
   BOOT
   ========================================================================== */
try {
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => go(t.dataset.view)));
  document.getElementById("scrim").addEventListener("click", e => { if(e.target.id === "scrim") closeModal(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape") closeModal(); });
  go("dashboard");
} catch(err){
  console.error("Boot failed:", err);
  document.getElementById("app").innerHTML = recoveryPanel("startup", err);
  bindRecovery();
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => go(t.dataset.view)));
}
