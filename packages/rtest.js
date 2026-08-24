/* RTI tests. Every generated document is validated against HMRC's own
   2026-27 schema using xmlschema, so "passes" means the schema says so. */

const RTI = require("./rti.js");
const E = require("./engine.js");
const fs = require("fs");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function eq(l,g,w){ const o = JSON.stringify(g)===JSON.stringify(w); o?pass++:fail++;
  console.log((o?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(o?"":"  want="+JSON.stringify(w))); }
const ok = (l,c) => eq(l, !!c, true);
function refuses(label, fn, expect){
  let err = null;
  try { fn(); } catch(e){ err = e; }
  ok(label, err && (!expect || err.message.toLowerCase().includes(expect.toLowerCase())));
  return err;
}

const SCHEMA_DIR = __dirname + "/../specs";
const HAVE_SCHEMA = fs.existsSync(SCHEMA_DIR + "/FullPaymentSubmission-2027-v1-0.xsd");

/* Validates against HMRC's schema. Skipped with a clear note if the schemas
   are not present, because they are HMRC's and not redistributed. */
let skippedValidations = 0;

/* Asserts a document is valid, or records a skip when HMRC's schemas are not
   present. Returning a falsy result on skip would fail the test and suggest
   the generator is broken when it is only unvalidated. */
function schemaOk(label, xml, which){
  const v = validateAgainstSchema(xml, which);
  if(v.skipped){ skippedValidations++; return; }
  ok(label, v.valid);
  if(!v.valid) console.log("       " + v.detail);
}

function validateAgainstSchema(xml, which = "FullPaymentSubmission-2027-v1-0.xsd"){
  if(!HAVE_SCHEMA) return { skipped: true };
  fs.writeFileSync("/tmp/rti-check.xml", xml);
  const script = `
import sys, xmlschema
s = xmlschema.XMLSchema("${SCHEMA_DIR}/${which}")
try:
    s.validate("/tmp/rti-check.xml"); print("VALID")
except Exception as e:
    print("INVALID: " + str(e)[:400].replace("\\n"," "))
`;
  fs.writeFileSync("/tmp/rti-check.py", script);
  const out = execFileSync("python3", ["/tmp/rti-check.py"], { encoding: "utf8" }).trim();
  return { valid: out.startsWith("VALID"), detail: out };
}

const SCHEME = { id:"S1", name:"Workplace pension", basis:"qualifying",
  employeeRate:0.05, employerRate:0.03, method:"reliefAtSource",
  qualifyingLower:6240, qualifyingUpper:50270 };

const EMPLOYER = {
  payeReference: "120/NG88214",
  accountsOfficeReference: "120PA00456789",
  name: "Northgate Logistics Ltd"
};
const PERIOD = { frequency:"monthly", sequence:5, taxMonth:5,
                 payDate:"2026-08-28", periodsCovered:1 };

const mk = o => Object.assign({
  gender:"M", taxCode:"1257L", niCategory:"A", weeklyHours:37.5, daysPerWeek:5,
  pensionSchemeId:"S1", studentLoanPlan:"none", otherDeductions:[], annualSalary:36000
}, o);

function fpsFor(emps, extra = {}){
  const payslips = emps.map(e => E.calcPayslip({ employee:e, period:5, scheme:SCHEME }));
  let xml = RTI.buildFPS({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
    payslips, employees: emps, sender:"Company", ...extra });
  return RTI.applyIRmark(xml);
}

console.log("\n--- the PAYE reference is two fields, not one ---");
eq("split into office and reference", RTI.splitPayeReference("120/NG88214"),
   { officeNo:"120", payeRef:"NG88214" });
eq("lower case is normalised", RTI.splitPayeReference("083/tb4471").payeRef, "TB4471");
refuses("a missing slash is refused", () => RTI.splitPayeReference("120NG88214"), "120/AB12345");
refuses("two digits is refused", () => RTI.splitPayeReference("12/AB1234"), "120/AB12345");
refuses("an empty reference is refused", () => RTI.splitPayeReference(""), "120/AB12345");

console.log("\n--- the tax code is a code, a regime and a basis ---");
eq("a plain code", RTI.decomposeTaxCode("1257L"), { code:"1257L", regime:null, nonCumulative:false });
eq("Scottish becomes an attribute", RTI.decomposeTaxCode("S1257L"),
   { code:"1257L", regime:"S", nonCumulative:false });
eq("Welsh becomes an attribute", RTI.decomposeTaxCode("C1257L"),
   { code:"1257L", regime:"C", nonCumulative:false });
eq("Month 1 becomes an attribute", RTI.decomposeTaxCode("1257L M1"),
   { code:"1257L", regime:null, nonCumulative:true });
eq("Week 1 too", RTI.decomposeTaxCode("1257LW1"),
   { code:"1257L", regime:null, nonCumulative:true });
eq("X means the same", RTI.decomposeTaxCode("1257LX"),
   { code:"1257L", regime:null, nonCumulative:true });
eq("Scottish AND non-cumulative", RTI.decomposeTaxCode("S1257L W1"),
   { code:"1257L", regime:"S", nonCumulative:true });
eq("BR survives", RTI.decomposeTaxCode("BR").code, "BR");
eq("0T survives", RTI.decomposeTaxCode("0T").code, "0T");
eq("NT survives", RTI.decomposeTaxCode("NT").code, "NT");
eq("D0 survives", RTI.decomposeTaxCode("D0").code, "D0");
eq("a K code survives", RTI.decomposeTaxCode("K475").code, "K475");
refuses("nonsense is refused", () => RTI.decomposeTaxCode("HELLO"), "not valid");
refuses("D9 is refused — the schema allows D0 to D8", () => RTI.decomposeTaxCode("D9"), "not valid");
refuses("an empty code is refused", () => RTI.decomposeTaxCode(""), "not valid");

console.log("\n--- the tax year is written 26-27, not 2026/27 ---");
eq("converted", RTI.relatedTaxYear("2026/27"), "26-27");
eq("a hyphen works too", RTI.relatedTaxYear("2026-27"), "26-27");
refuses("a single year is refused", () => RTI.relatedTaxYear("2026"), "2026/27");

console.log("\n--- hours are a band, not a number ---");
eq("under 16 hours is band A", RTI.hoursBand(12), "A");
eq("exactly 16 is band B", RTI.hoursBand(16), "B");
eq("29.99 is still band B", RTI.hoursBand(29.99), "B");
eq("30 or more is band C", RTI.hoursBand(37.5), "C");
eq("irregular is band D", RTI.hoursBand(37.5, { irregular:true }), "D");
eq("unknown is band E", RTI.hoursBand(0, { notKnown:true }), "E");

console.log("\n--- pay frequency codes ---");
eq("monthly", RTI.payFrequency("monthly"), "M1");
eq("weekly", RTI.payFrequency("weekly"), "W1");
eq("fortnightly", RTI.payFrequency("fortnightly"), "W2");
eq("four-weekly", RTI.payFrequency("fourWeekly"), "W4");
refuses("an unknown frequency is refused", () => RTI.payFrequency("daily"), "unsupported");

console.log("\n--- money formatting matches the schema pattern ---");
eq("two decimal places always", RTI.money(100), "100.00");
eq("rounded to the penny", RTI.money(100.005), "100.01");
eq("zero", RTI.money(0), "0.00");
eq("negative refunds are allowed", RTI.money(-45.5), "-45.50");
eq("negative zero is not emitted", RTI.money(-0.001), "0.00");
const pat = /^-?(([1-9][0-9]*)|0)\.[0-9]{2}$/;
[0, 1, 100, 1234.5, -99.99, 0.01].forEach(v =>
  ok("matches the schema pattern: " + RTI.money(v), pat.test(RTI.money(v))));

console.log("\n--- four fields are whole pounds, and rounded down ---");
eq("45.99 becomes 45.00", RTI.wholePounds(45.99), "45.00");
eq("45.00 stays", RTI.wholePounds(45), "45.00");
eq("zero", RTI.wholePounds(0), "0.00");
ok("always matches the .00 pattern", /\.00$/.test(RTI.wholePounds(123.45)));

console.log("\n--- student loan plan codes ---");
eq("plan 1", RTI.studentLoanPlanCode("plan1"), "01");
eq("plan 2", RTI.studentLoanPlanCode("plan2"), "02");
eq("plan 4", RTI.studentLoanPlanCode("plan4"), "04");
refuses("plan 5 has no code in the 2026-27 schema",
  () => RTI.studentLoanPlanCode("plan5"), "no RTI plan type");

/* ================= against HMRC's schema ================= */
if(!HAVE_SCHEMA){
  console.log("\n  NOTE: HMRC schemas not present in specs/, schema validation skipped");
} else {
  console.log("\n--- a straightforward employee ---");
  let xml = fpsFor([mk({ id:"E1", name:"Priya Raman", payrollNumber:"NG0034",
    niNumber:"PA662310B", dob:"1987-11-02", gender:"F", annualSalary:52000 })]);
  let v = validateAgainstSchema(xml);
  ok("valid against HMRC's schema", v.valid);
  if(!v.valid) console.log("       " + v.detail);

  console.log("\n--- a Scottish taxpayer ---");
  xml = fpsFor([mk({ id:"E2", name:"Callum Byrne", payrollNumber:"NG0051",
    niNumber:"JT551208A", dob:"1995-07-19", taxCode:"S1257L" })]);
  schemaOk("valid", xml);
  ok("the regime is an attribute, not part of the code",
     xml.includes('<TaxCode TaxRegime="S">1257L</TaxCode>'));
  ok("and the code itself carries no S", !xml.includes(">S1257L<"));

  console.log("\n--- an emergency code ---");
  xml = fpsFor([mk({ id:"E3", name:"Jo Ferreira", payrollNumber:"NG0091",
    niNumber:"HC774102A", dob:"2003-04-22", taxCode:"1257LM1", niCategory:"M" })]);
  schemaOk("valid", xml);
  ok("the basis is an attribute", xml.includes('BasisNonCumulative="yes"'));

  console.log("\n--- a director ---");
  xml = fpsFor([mk({ id:"E4", name:"Daniel Marsh", payrollNumber:"NG0012",
    niNumber:"NM418820C", dob:"1981-03-11", annualSalary:96000, director:true })]);
  schemaOk("valid", xml);
  ok("reported on the annual NI basis", xml.includes("<DirectorsNIC>AN</DirectorsNIC>"));

  console.log("\n--- a new starter with a student loan ---");
  xml = fpsFor([mk({ id:"E5", name:"Amrit Kaur", payrollNumber:"NG0067",
    niNumber:"YB901122C", dob:"1996-05-30", gender:"F", studentLoanPlan:"plan2",
    annualSalary:41904, starter:{ startDate:"2026-08-04", declaration:"A", studentLoan:true } })]);
  schemaOk("valid", xml);
  ok("the starter declaration is present", xml.includes("<StartDec>A</StartDec>"));
  ok("the plan type is on the deduction", xml.includes('PlanType="02"'));

  console.log("\n--- a leaver ---");
  xml = fpsFor([mk({ id:"E6", name:"Ellis Warrington", payrollNumber:"NG0094",
    niNumber:"KP220417B", dob:"1990-02-28", leavingDate:"2026-08-15" })]);
  schemaOk("valid", xml);
  ok("the leaving date is reported", xml.includes("<LeavingDate>2026-08-15</LeavingDate>"));

  console.log("\n--- a part-timer falls in a different hours band ---");
  xml = fpsFor([mk({ id:"E7", name:"Dele Ogundele", payrollNumber:"NG0100",
    niNumber:"SK223401A", dob:"1988-02-28", weeklyHours:20, annualSalary:14820 })]);
  schemaOk("valid", xml);
  ok("band B for 20 hours", xml.includes("<HoursWorked>B</HoursWorked>"));

  console.log("\n--- a whole payroll of nine, mixed cases ---");
  const many = [
    mk({ id:"A", name:"Priya Raman",     payrollNumber:"P1", niNumber:"PA662310B", dob:"1987-11-02", gender:"F", annualSalary:52000 }),
    mk({ id:"B", name:"Callum Byrne",    payrollNumber:"P2", niNumber:"JT551208A", dob:"1995-07-19", taxCode:"S1257L", studentLoanPlan:"plan2", annualSalary:34500 }),
    mk({ id:"C", name:"Leila Hassan",    payrollNumber:"P3", niNumber:"RG774418A", dob:"1993-12-05", gender:"F", annualSalary:31200 }),
    mk({ id:"D", name:"Owen Fletcher",   payrollNumber:"P4", niNumber:"YB901122C", dob:"2004-05-30", niCategory:"H", annualSalary:22400 }),
    mk({ id:"F", name:"Grace Whitlock",  payrollNumber:"P5", niNumber:"WL338207B", dob:"1959-03-11", gender:"F", niCategory:"C", annualSalary:38400 }),
    mk({ id:"G", name:"Daniel Marsh",    payrollNumber:"P6", niNumber:"NM418820C", dob:"1981-03-11", director:true, annualSalary:96000 }),
    mk({ id:"H", name:"Jo Ferreira",     payrollNumber:"P7", niNumber:"HC774102A", dob:"2003-04-22", taxCode:"1257LM1", niCategory:"M", annualSalary:21840 }),
    mk({ id:"I", name:"Marcus Bexley",   payrollNumber:"P8", niNumber:"KP220417B", dob:"1990-09-14", taxCode:"BR", studentLoanPlan:"plan1", annualSalary:41904 }),
    mk({ id:"J", name:"Helen Pryce",     payrollNumber:"P9", niNumber:"YB901188A", dob:"1983-12-05", gender:"F", taxCode:"K475", annualSalary:42618 })
  ];
  xml = fpsFor(many);
  schemaOk("the whole submission is valid", xml);
  eq("nine employees reported", (xml.match(/<Employee>/g) || []).length, 9);

  console.log("\n--- a final submission for the year ---");
  xml = fpsFor([mk({ id:"E1", name:"Priya Raman", payrollNumber:"NG0034",
    niNumber:"PA662310B", dob:"1987-11-02", gender:"F" })],
    { finalSubmission: { forYear: true } });
  schemaOk("valid", xml);
  ok("marked as the final submission", xml.includes("<ForYear>yes</ForYear>"));

  console.log("\n--- an Employer Payment Summary ---");
  let eps = RTI.buildEPS({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
    employmentAllowance: true, sender:"Company" });
  eps = RTI.applyIRmark(eps);
  schemaOk("valid against the EPS schema", eps, "EmployerPaymentSummary-2027-v1-0.xsd");
  ok("the Employment Allowance claim is present", eps.includes("<EmpAllceInd>yes</EmpAllceInd>"));

  console.log("\n--- an EPS reporting no payments made ---");
  eps = RTI.applyIRmark(RTI.buildEPS({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
    noPaymentForPeriod: { from:"2026-08-06", to:"2026-09-05" }, sender:"Company" }));
  schemaOk("valid", eps, "EmployerPaymentSummary-2027-v1-0.xsd");
  ok("the period is reported", eps.includes("<From>2026-08-06</From>"));
}

  console.log("\n--- an EPS reclaiming statutory payments ---");
  eps = RTI.applyIRmark(RTI.buildEPS({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
    reclaims: { taxMonth: 5, smp: 1842.60, nicOnSMP: 55.28, spp: 374.16 },
    employmentAllowance: true, sender:"Company" }));
  schemaOk("valid", eps, "EmployerPaymentSummary-2027-v1-0.xsd");
  ok("SMP recovery reported", eps.includes("<SMPRecovered>1842.60</SMPRecovered>"));
  ok("NIC compensation reported", eps.includes("<NICCompensationOnSMP>55.28</NICCompensationOnSMP>"));
  ok("RelatedTaxYear comes near the end, after the reclaims",
     eps.indexOf("RelatedTaxYear") > eps.indexOf("RecoverableAmountsYTD"));

  console.log("\n--- an EPS with the Apprenticeship Levy ---");
  eps = RTI.applyIRmark(RTI.buildEPS({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
    apprenticeshipLevy: { dueYTD: 1250, taxMonth: 5, annualAllowance: 15000 },
    sender:"Company" }));
  schemaOk("valid", eps, "EmployerPaymentSummary-2027-v1-0.xsd");
  ok("the levy is reported in whole pounds", eps.includes("<LevyDueYTD>1250.00</LevyDueYTD>"));

  console.log("\n--- an EPS declining the Employment Allowance ---");
  eps = RTI.applyIRmark(RTI.buildEPS({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
    employmentAllowance: false, sender:"Company" }));
  schemaOk("valid", eps, "EmployerPaymentSummary-2027-v1-0.xsd");
  ok("recorded as no, not omitted", eps.includes("<EmpAllceInd>no</EmpAllceInd>"));

console.log("\n--- the IRmark ---");
const sample = fpsFor([mk({ id:"E1", name:"Priya Raman", payrollNumber:"NG0034",
  niNumber:"PA662310B", dob:"1987-11-02", gender:"F" })]);
const markMatch = sample.match(/<IRmark[^>]*>([^<]+)<\/IRmark>/);
ok("an IRmark is present", !!markMatch);
ok("it is base64 of a SHA-1, so 28 characters", markMatch[1].length === 28);
ok("and ends with the base64 padding of a 20-byte digest", markMatch[1].endsWith("="));

const again = fpsFor([mk({ id:"E1", name:"Priya Raman", payrollNumber:"NG0034",
  niNumber:"PA662310B", dob:"1987-11-02", gender:"F" })]);
eq("the same content gives the same mark",
   again.match(/<IRmark[^>]*>([^<]+)<\/IRmark>/)[1], markMatch[1]);

const different = fpsFor([mk({ id:"E1", name:"Priya Raman", payrollNumber:"NG0034",
  niNumber:"PA662310B", dob:"1987-11-02", gender:"F", annualSalary:99999 })]);
ok("different content gives a different mark",
   different.match(/<IRmark[^>]*>([^<]+)<\/IRmark>/)[1] !== markMatch[1]);
ok("the mark is computed with the IRmark element removed",
   RTI.computeIRmark(sample) === markMatch[1]);

console.log("\n--- the GovTalk envelope ---");
const wrapped = RTI.wrapInGovTalk({ body: sample, messageClass: RTI.MESSAGE_CLASS.FPS,
  senderId: "TESTSENDER", password: "testpass", transactionId: "TX123" });
ok("declares itself XML", wrapped.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
ok("carries the FPS message class", wrapped.includes("<Class>HMRC-PAYE-RTI-FPS</Class>"));
ok("is a submit request", wrapped.includes("<Function>submit</Function>") &&
   wrapped.includes("<Qualifier>request</Qualifier>"));
ok("carries the sender id", wrapped.includes("<SenderID>TESTSENDER</SenderID>"));
ok("wraps the submission in a Body", wrapped.includes("<Body>") && wrapped.includes("IRenvelope"));
eq("the EPS class differs", RTI.MESSAGE_CLASS.EPS, "HMRC-PAYE-RTI-EPS");

console.log("\n--- input validation catches problems before HMRC does ---");
const bad = RTI.validateFPSInputs({
  employer: { payeReference: "nonsense", accountsOfficeReference: "wrong" },
  taxYear: "2026/27", period: PERIOD,
  payslips: [{ employeeId: "X", ytd: {} }],
  employees: [{ id: "X", name: "No Code", taxCode: "RUBBISH" }]
});
ok("problems are reported", !bad.valid);
ok("the PAYE reference is flagged", bad.problems.some(p => p.includes("120/AB12345")));
ok("the Accounts Office reference is flagged", bad.problems.some(p => p.includes("083PA")));
ok("the tax code is flagged, naming the person",
   bad.problems.some(p => p.startsWith("No Code") && p.includes("tax code")));
ok("the missing payroll id is flagged", bad.problems.some(p => p.includes("payroll id")));

const good = RTI.validateFPSInputs({ employer: EMPLOYER, taxYear:"2026/27", period: PERIOD,
  payslips: [{ employeeId:"E1", ytd:{ taxable:0, tax:0 } }],
  employees: [mk({ id:"E1", name:"Priya Raman", payrollNumber:"NG0034", niNumber:"PA662310B" })] });
ok("a sound submission passes", good.valid);

console.log("\n--- gender is required, and guessing would be worse ---");
refuses("a missing gender is refused rather than assumed",
  () => fpsFor([mk({ id:"E1", name:"Someone", payrollNumber:"P1", gender:null })]),
  "gender");

if(skippedValidations){
  console.log("\n  NOTE: " + skippedValidations + " schema validations skipped — HMRC schemas are not");
  console.log("        redistributed. Download them from GOV.UK into specs/ to enable them.");
}

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
process.exit(fail ? 1 : 0);
