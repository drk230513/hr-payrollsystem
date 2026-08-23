const E = require("./engine.js");
// automation.js expects engine helpers in scope; emulate the browser bundle
const fs = require("fs");
const src = fs.readFileSync("automation.js","utf8").replace(/if\(typeof module[\s\S]*$/,"");
// Export list derived from the source, not hardcoded — a hardcoded list goes
// stale silently the moment a function is added to the engine.
const EXPORTS = ["TIERS","MODES","AUTOMATION_RULES","DEFAULT_COVER","COVER_GUIDANCE",
  "defaultPolicy","tierFor","coverAssessment","coverReadiness",
  "validateBankDetails","evaluateAutomations","touchlessRate"];
const A = new Function("ageAt","leaveBalance","parseTaxCode","periodsPerYear","p2",
  src + "; return { " + EXPORTS.join(", ") + " };"
)(E.ageAt, E.leaveBalance, E.parseTaxCode, E.periodsPerYear, E.p2);
EXPORTS.forEach(n => { if(A[n] === undefined) throw new Error("engine is missing export: " + n); });

let pass=0, fail=0;
function eq(l,g,w,t=0.01){const ok=typeof w==="number"?Math.abs(g-w)<=t:g===w;ok?pass++:fail++;
  console.log((ok?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(ok?"":"  want="+JSON.stringify(w)));}
function ok(l,c){eq(l,!!c,true);}

const SCHEMES=[{id:"S1",name:"Workplace pension",basis:"qualifying",employeeRate:0.05,employerRate:0.03,method:"reliefAtSource",isDefault:true}];
const PERIOD={start:"2026-08-01",end:"2026-08-31"};
const mkE=o=>Object.assign({id:"E"+Math.random().toString(36).slice(2,6),status:"active",weeklyHours:37.5,daysPerWeek:5,
  taxCode:"1257L",niCategory:"A",annualSalary:30000,pensionSchemeId:"S1",leaveDays:28,carriedDays:0,
  bankSort:"20-41-12",bankAccount:"88104471",dob:"1990-01-01",niNumber:"AB123456C",otherDeductions:[]},o);

console.log("\n--- modes set sensible defaults ---");
const man=A.defaultPolicy("manual"), asst=A.defaultPolicy("assisted"), auto=A.defaultPolicy("automated");
ok("manual turns everything off", Object.values(man).every(v=>v==="off"));
ok("assisted proposes but never applies", Object.entries(asst).every(([k,v])=>v==="propose"||k==="commit-run"));
ok("automated applies routine rules", auto["ni-age"]==="apply");
eq("commit is off in every mode", [man,asst,auto].map(p=>p["commit-run"]).join(","), "off,off,off");

console.log("\n--- guardrails cannot be overridden ---");
eq("leaver final pay capped at propose", A.tierFor({"leaver-final-pay":"apply"},"leaver-final-pay"), "propose");
eq("tax code capped at propose", A.tierFor({"tax-code":"apply"},"tax-code"), "propose");
eq("commit can never be raised", A.tierFor({"commit-run":"apply"},"commit-run"), "off");
eq("ordinary rules can be raised", A.tierFor({"ni-age":"apply"},"ni-age"), "apply");

console.log("\n--- bank validation ---");
ok("good details pass", A.validateBankDetails("20-41-12","88104471").valid);
ok("short sort code fails", !A.validateBankDetails("2041","88104471").valid);
ok("all zeros fails", !A.validateBankDetails("000000","88104471").valid);
ok("missing account fails", !A.validateBankDetails("204112","").valid);
ok("honest that modulus is not checked", A.validateBankDetails("204112","88104471").modulusChecked === false);

console.log("\n--- manual mode produces nothing at all ---");
const emps=[mkE({name:"Under 21",niCategory:"M",dob:"2003-01-01"}), mkE({name:"Bad bank",bankSort:"12",bankAccount:"1"})];
const slips=emps.map(e=>E.calcPayslip({employee:e,period:5,scheme:SCHEMES[0]}));
const none=A.evaluateAutomations({employees:emps,payslips:slips,exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:man,config:E.DEFAULT_CONFIG});
eq("no actions in manual mode", none.length, 0);

console.log("\n--- automated mode detects the routine work ---");
const acts=A.evaluateAutomations({employees:emps,payslips:slips,exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG});
const has=id=>acts.some(a=>a.ruleId===id);
ok("NI age correction raised", has("ni-age"));
ok("bank problem raised", has("bank-format"));
const niAct=acts.find(a=>a.ruleId==="ni-age");
eq("NI change targets the right field", niAct.change.field, "niCategory");
eq("NI change is M to A", niAct.change.from+"->"+niAct.change.to, "M->A");
eq("NI rule applies automatically", niAct.tier, "apply");

console.log("\n--- age boundaries ---");
const boundary=(cat,dob)=>{const e=mkE({name:"x",niCategory:cat,dob});
  return A.evaluateAutomations({employees:[e],payslips:[E.calcPayslip({employee:e,period:5,scheme:SCHEMES[0]})],
    exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG}).find(a=>a.ruleId==="ni-age");};
ok("M at 20 is left alone", !boundary("M","2006-01-01"));
ok("M at 21 is corrected", !!boundary("M","2005-01-01"));
ok("H at 24 is left alone", !boundary("H","2002-01-01"));
ok("H at 25 is corrected", !!boundary("H","2001-01-01"));
eq("A at 66 moves to C", boundary("A","1960-01-01").change.to, "C");
ok("A at 65 is left alone", !boundary("A","1961-06-01"));

console.log("\n--- auto-enrolment ---");
const unenrolled=mkE({name:"Not enrolled",pensionSchemeId:"",annualSalary:30000});
const aeActs=A.evaluateAutomations({employees:[unenrolled],payslips:[E.calcPayslip({employee:unenrolled,period:5,scheme:null})],
  exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG});
const ae=aeActs.find(a=>a.ruleId==="auto-enrolment");
ok("eligible jobholder enrolled", !!ae);
eq("assigned to the default scheme", ae.change.to, "S1");
eq("enrolment notifies rather than applies silently", ae.tier, "notify");
const optedOut=mkE({name:"Opted out",pensionSchemeId:"",pensionOptOut:true});
const ooActs=A.evaluateAutomations({employees:[optedOut],payslips:[E.calcPayslip({employee:optedOut,period:5,scheme:null})],
  exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG});
ok("opt-out is respected", !ooActs.some(a=>a.ruleId==="auto-enrolment"));
const lowPaid=mkE({name:"Low paid",pensionSchemeId:"",annualSalary:8000});
const lpActs=A.evaluateAutomations({employees:[lowPaid],payslips:[E.calcPayslip({employee:lowPaid,period:5,scheme:null})],
  exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG});
ok("below the trigger is not enrolled", !lpActs.some(a=>a.ruleId==="auto-enrolment"));

console.log("\n--- leavers are proposed, never applied ---");
const leaver=mkE({name:"Gone",leavingDate:"2026-07-31"});
const lvActs=A.evaluateAutomations({employees:[leaver],payslips:[E.calcPayslip({employee:leaver,period:5,scheme:SCHEMES[0]})],
  exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG});
const lv=lvActs.find(a=>a.ruleId==="leaver-final-pay");
ok("leaver detected", !!lv);
eq("leaver stays at propose even in automated mode", lv.tier, "propose");
ok("payment in lieu calculated", lv.change.pilonAmount > 0);
ok("marked as blocking", lv.blocking);

console.log("\n--- informational exceptions cleared, financial ones never ---");
const exs=[
  {ref:"E-01",severity:"low",amount:0,title:"No National Insurance number held",employeeIds:[emps[0].id],evidence:[]},
  {ref:"E-02",severity:"high",amount:4120,title:"Leaver is still active in the run",employeeIds:[emps[0].id],evidence:[]},
  {ref:"E-03",severity:"high",amount:2890,title:"Two or more employees share the same bank account",employeeIds:[emps[0].id],evidence:[]}
];
const clr=A.evaluateAutomations({employees:emps,payslips:slips,exceptions:exs,schemes:SCHEMES,leave:[],period:PERIOD,policy:auto,config:E.DEFAULT_CONFIG})
  .filter(a=>a.ruleId==="clear-informational");
eq("only the informational one is cleared", clr.length, 1);
eq("and it is the NI number one", clr[0].change.ref, "E-01");
ok("duplicate bank account never auto-cleared", !clr.some(a=>a.change.ref==="E-03"));
ok("leaver exception never auto-cleared", !clr.some(a=>a.change.ref==="E-02"));

console.log("\n--- recurring elements carry forward ---");
const last={elements:{[emps[0].id]:[{label:"Car allowance",amount:250,recurring:true},{label:"One-off bonus",amount:500,recurring:false}]}};
const rec=A.evaluateAutomations({employees:emps,payslips:slips,exceptions:[],schemes:SCHEMES,leave:[],period:PERIOD,
  policy:auto,config:E.DEFAULT_CONFIG,lastRun:last}).find(a=>a.ruleId==="recurring-elements");
ok("recurring element carried", !!rec);
eq("only the recurring one", rec.change.elements.length, 1);
eq("the right one", rec.change.elements[0].label, "Car allowance");

console.log("\n--- touchless rate ---");
const t1=A.touchlessRate({payslips:slips,exceptions:[],decisions:{},actions:[]});
eq("no exceptions means fully touchless", t1.rate, 100);
const t2=A.touchlessRate({payslips:slips,exceptions:[{ref:"E-01",employeeIds:[emps[0].id]}],decisions:{},actions:[]});
eq("one untouched exception lowers the rate", t2.rate, 50);
const t3=A.touchlessRate({payslips:slips,exceptions:[{ref:"E-01",employeeIds:[emps[0].id]}],
  decisions:{"E-01":{type:"release",byRule:"clear-informational"}},actions:[]});
eq("rule-decided exceptions count as touchless", t3.rate, 100);
const t4=A.touchlessRate({payslips:slips,exceptions:[],decisions:{},actions:[{tier:"propose",targetId:emps[1].id}]});
eq("a pending proposal counts as touched", t4.rate, 50);

/* ============================ COVER MODE ============================ */
console.log("\n--- cover mode: the payroll lead is away ---");
const COVER = { ...A.DEFAULT_COVER, active:true, leadName:"A. Okafor", deputyName:"J. Small",
                releaseLimit:1000, requireSecondApproval:true, escalateHighSeverity:true };

const cp = A.defaultPolicy("cover");
ok("cover automates the routine rules", cp["ni-age"]==="apply" && cp["auto-enrolment"]==="notify");
eq("cover still cannot commit", cp["commit-run"], "off");
eq("leaver still only proposed under cover", A.tierFor(cp,"leaver-final-pay"), "propose");
ok("cover mode exists in the mode list", !!A.MODES.cover);

console.log("\n--- delegation limits decide who may sign ---");
const small = A.coverAssessment({ruleId:"clear-informational"}, 0, COVER);
eq("a no-value item is the deputy's to clear", small.authority, "deputy");

const medium = A.coverAssessment({ruleId:"net-variance"}, 850, COVER);
eq("under the limit stays with the deputy", medium.authority, "deputy");

const large = A.coverAssessment({ruleId:"net-variance"}, 2400, COVER);
eq("over the limit needs a second name", large.authority, "second");
ok("and says why in pounds", large.reason.includes("2400.00") && large.reason.includes("1000.00"));

const risky = A.coverAssessment({ruleId:"leaver-final-pay", blocking:true}, 4120, COVER);
eq("a leaver is held for the lead", risky.authority, "lead");
ok("names who it is waiting for", risky.reason.includes("A. Okafor"));

console.log("\n--- every decision comes with plain-English guidance ---");
["leaver-final-pay","bank-format","ni-age","auto-enrolment","recurring-elements"].forEach(r => {
  const g = A.coverAssessment({ruleId:r}, 0, COVER).guidance;
  ok(r + " has guidance", g.length > 40);
});
ok("unknown rules still get safe guidance",
   A.coverAssessment({ruleId:"something-new"}, 0, COVER).guidance.includes("hold it"));
ok("the leaver guidance explains the actual risk",
   A.COVER_GUIDANCE["leaver-final-pay"].includes("getting it back"));

console.log("\n--- limits can be tightened or loosened ---");
const tight = { ...COVER, releaseLimit:100 };
eq("a lower limit escalates more", A.coverAssessment({ruleId:"x"}, 500, tight).authority, "second");
const loose = { ...COVER, releaseLimit:10000 };
eq("a higher limit escalates less", A.coverAssessment({ruleId:"x"}, 500, loose).authority, "deputy");
const noSecond = { ...COVER, requireSecondApproval:false };
eq("second approval can be switched off", A.coverAssessment({ruleId:"x"}, 5000, noSecond).authority, "deputy");
const noEscalate = { ...COVER, escalateHighSeverity:false };
eq("but high-risk escalation is a separate switch",
   A.coverAssessment({ruleId:"leaver-final-pay", blocking:true}, 50, noEscalate).authority, "deputy");

console.log("\n--- the run cannot go out with something held for the lead ---");
const exs2 = [{ref:"E-01"},{ref:"E-02"}];
const acts2 = [
  {ruleId:"clear-informational", amount:0},
  {ruleId:"leaver-final-pay", blocking:true, amount:4120}
];
const r1 = A.coverReadiness({ exceptions:exs2, decisions:{}, actions:acts2, cover:COVER });
eq("two exceptions still open", r1.open, 2);
eq("one is held for the lead", r1.heldForLead, 1);
ok("so the run is blocked", !r1.canCommit);

const r2 = A.coverReadiness({ exceptions:exs2, decisions:{"E-01":{},"E-02":{}},
                              actions:[{ruleId:"clear-informational", amount:0}], cover:COVER });
ok("with everything decided and nothing escalated, the deputy can commit", r2.canCommit);

const r3 = A.coverReadiness({ exceptions:exs2, decisions:{"E-01":{},"E-02":{}},
                              actions:[{ruleId:"x", amount:9000}], cover:COVER });
eq("an over-limit item needs a second approver", r3.needsSecondApproval, 1);
ok("but does not block the run outright", r3.canCommit);

console.log("\n============================================");
console.log("  "+pass+" passed, "+fail+" failed");
console.log("============================================\n");
process.exit(fail?1:0);

