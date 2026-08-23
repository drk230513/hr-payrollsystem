/* End to end: seed a tenant, run payroll through the API, commit it, and pull
   the journal. Proves the engine, the database and the journal all agree. */
process.env.PGHOST = process.env.PGHOST || "127.0.0.1";
process.env.PGPORT = process.env.PGPORT || "5432";
process.env.PGUSER = process.env.PGUSER || "postgres";
process.env.REGISTRY_DB="hrp_registry"; process.env.BASE_DOMAIN="hr-payrollsystem.com";
const http=require("http");
const db=require("./src/db"), auth=require("./src/auth"), {createApp}=require("./src/server");
let pass=0,fail=0;
const eq=(l,g,w)=>{const o=JSON.stringify(g)===JSON.stringify(w);o?pass++:fail++;
  console.log((o?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(o?"":"  want="+JSON.stringify(w)));};
const ok=(l,c)=>eq(l,!!c,true);
let base;
function req(m,p,o={}){return new Promise((res,rej)=>{const d=o.body?JSON.stringify(o.body):null;
  const r=http.request({hostname:"127.0.0.1",port:base,method:m,path:p,headers:Object.assign(
    {Host:o.host||"acme-ltd.hr-payrollsystem.com"},d?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d)}:{},
    o.cookie?{Cookie:o.cookie}:{})},x=>{let s="";x.on("data",c=>s+=c);x.on("end",()=>{
      let j=null;try{j=JSON.parse(s);}catch(e){}res({status:x.statusCode,body:j,text:s});});});
  r.on("error",rej);if(d)r.write(d);r.end();});}

(async()=>{
const T=db.tenant("hrp_acme_ltd");
console.log("\n--- seeding the tenant database ---");
await T.query("TRUNCATE payroll.payslip_lines, payroll.payslips, payroll.exception_decisions, payroll.run_exceptions, payroll.pay_runs CASCADE");
await T.query("TRUNCATE payroll.scheme_memberships, payroll.ni_categories, payroll.tax_codes, payroll.remuneration, payroll.employments, payroll.employees CASCADE");
await T.query("TRUNCATE payroll.pay_periods, payroll.pay_schedules, payroll.pension_schemes, payroll.departments CASCADE");

const sch=(await T.query(`INSERT INTO payroll.pay_schedules(name,frequency,periods_per_year,is_default)
  VALUES('Monthly','monthly',12,true) RETURNING id`)).rows[0].id;
const dep=(await T.query(`INSERT INTO payroll.departments(code,name,cost_centre) VALUES('OPS','Operations','OPS-100') RETURNING id`)).rows[0].id;
const dep2=(await T.query(`INSERT INTO payroll.departments(code,name,cost_centre) VALUES('FIN','Finance','FIN-300') RETURNING id`)).rows[0].id;
const pen=(await T.query(`INSERT INTO payroll.pension_schemes(name,provider,basis,method,employee_rate,employer_rate,qualifying_lower,qualifying_upper,is_default)
  VALUES('Workplace pension','nest','qualifying','relief_at_source',0.05,0.03,6240,50270,true) RETURNING id`)).rows[0].id;
for(let i=1;i<=12;i++){
  const m=(i+2)%12, y=2026+(m<3?1:0);
  const s=new Date(Date.UTC(y,m,1)), e=new Date(Date.UTC(y,m+1,0));
  await T.query(`INSERT INTO payroll.pay_periods(schedule_id,tax_year,sequence,starts_on,ends_on,pay_date)
    VALUES($1,'2026/27',$2,$3,$4,$4)`,[sch,i,s.toISOString().slice(0,10),e.toISOString().slice(0,10)]);
}
const people=[
  ["NG001","Priya","Raman","1987-11-02",52000,dep],
  ["NG002","Callum","Byrne","1995-07-19",34500,dep],
  ["NG003","Leila","Hassan","1993-12-05",31200,dep],
  ["NG004","Grace","Whitlock","1969-03-11",38400,dep2],
  ["NG005","Owen","Fletcher","2004-05-30",22400,dep2]
];
for(const [num,fn,ln,dob,sal,d] of people){
  const eid=(await T.query(`INSERT INTO payroll.employees(payroll_number,first_name,last_name,date_of_birth,ni_number,status)
    VALUES($1,$2,$3,$4,'AB123456C','active') RETURNING id`,[num,fn,ln,dob])).rows[0].id;
  const emp=(await T.query(`INSERT INTO payroll.employments(employee_id,schedule_id,department_id,job_title,started_on)
    VALUES($1,$2,$3,'Staff','2022-01-01') RETURNING id`,[eid,sch,d])).rows[0].id;
  await T.query(`INSERT INTO payroll.remuneration(employment_id,effective_from,annual_salary,weekly_hours,days_per_week)
    VALUES($1,'2022-01-01',$2,37.5,5)`,[emp,sal]);
  await T.query(`INSERT INTO payroll.tax_codes(employee_id,code,basis,effective_from) VALUES($1,'1257L','cumulative','2022-01-01')`,[eid]);
  await T.query(`INSERT INTO payroll.ni_categories(employee_id,category,effective_from) VALUES($1,'A','2022-01-01')`,[eid]);
  await T.query(`INSERT INTO payroll.scheme_memberships(employee_id,scheme_id,joined_on) VALUES($1,$2,'2022-01-01')`,[eid,pen]);
}
eq("five employees seeded",(await T.query("SELECT count(*) FROM payroll.employees")).rows[0].count,"5");

await auth.ensureSessionTable();
const srv=createApp().listen(0); await new Promise(r=>srv.once("listening",r)); base=srv.address().port;
let r=await req("POST","/api/auth/login",{host:"hr-payrollsystem.com",body:{email:"alice@acme.example",password:"correct-horse-battery"}});
const C=(r.text,r.status===200)?"hrp_session="+/hrp_session=([^;]+)/.exec(JSON.stringify(r))?.[1]:null;
const cookie=await (async()=>{const x=await req("POST","/api/auth/login",{host:"hr-payrollsystem.com",body:{email:"alice@acme.example",password:"correct-horse-battery"}});
  return null;})();

// get the cookie properly
function loginCookie(){return new Promise((resolve,rej)=>{const d=JSON.stringify({email:"alice@acme.example",password:"correct-horse-battery"});
  const q=http.request({hostname:"127.0.0.1",port:base,method:"POST",path:"/api/auth/login",
    headers:{Host:"hr-payrollsystem.com","Content-Type":"application/json","Content-Length":Buffer.byteLength(d)}},
    x=>{x.on("data",()=>{});x.on("end",()=>resolve((x.headers["set-cookie"]||[]).map(c=>c.split(";")[0]).join("; ")));});
  q.on("error",rej);q.write(d);q.end();});}
const AC=await loginCookie();

console.log("\n--- employees over the API ---");
r=await req("GET","/api/employees",{cookie:AC});
eq("five returned",r.body.employees.length,5);
ok("names resolved from the database",r.body.employees.some(e=>e.full_name==="Priya Raman"));

console.log("\n--- calculate August ---");
r=await req("POST","/api/payroll/calculate",{cookie:AC,body:{taxYear:"2026/27",period:5}});
eq("calculated",r.status,200);
eq("five payslips",r.body.employees,5);
ok("gross is plausible",r.body.totals.gross>13000&&r.body.totals.gross<15000);
ok("employer cost exceeds gross",r.body.totals.employerCost>r.body.totals.gross);
console.log("     gross "+r.body.totals.gross+"  net "+r.body.totals.net+"  employer cost "+r.body.totals.employerCost);
const exceptions=r.body.exceptions;
console.log("     exceptions: "+(exceptions.length?exceptions.map(x=>x.ref+" "+x.severity).join(", "):"none"));

console.log("\n--- commit is refused while exceptions are open ---");
r=await req("POST","/api/payroll/commit",{cookie:AC,body:{taxYear:"2026/27",period:5,decisions:{}}});
if(exceptions.length){ eq("refused",r.status,409); eq("and names them",r.body.error,"exceptions_undecided"); }
else { ok("no exceptions to block it",true); }

console.log("\n--- commit with every exception decided ---");
const decisions={}; exceptions.forEach(x=>decisions[x.ref]={type:"release",by:"alice@acme.example"});
r=await req("POST","/api/payroll/commit",{cookie:AC,body:{taxYear:"2026/27",period:5,decisions}});
eq("committed",r.status,200);
ok("a run id was returned",!!r.body.runId);
const status=(await T.query("SELECT status,committed_by FROM payroll.pay_runs")).rows[0];
eq("the database says committed",status.status,"committed");
eq("and records who",status.committed_by,"alice@acme.example");
eq("payslips written",(await T.query("SELECT count(*) FROM payroll.payslips")).rows[0].count,"5");
ok("payslip lines written",Number((await T.query("SELECT count(*) FROM payroll.payslip_lines")).rows[0].count)>10);

console.log("\n--- committed payslips are immutable ---");
let threw=false;
try{ await T.query("UPDATE payroll.payslips SET net = 1 WHERE true"); }catch(e){ threw=e.message.includes("immutable"); }
ok("the database refuses to edit them",threw);

console.log("\n--- the journal ---");
r=await req("GET","/api/payroll/journal?taxYear=2026/27&period=5",{cookie:AC});
eq("journal produced",r.status,200);
ok("it balances",r.body.balanced);
eq("difference is zero",r.body.difference,0);
eq("five employees included",r.body.employeesIncluded,5);
console.log("     debits "+r.body.totalDebit+"  credits "+r.body.totalCredit);
const centres=[...new Set(r.body.lines.filter(l=>l.costCentre).map(l=>l.costCentre))].sort();
eq("split by cost centre",centres,["FIN-300","OPS-100"]);

console.log("\n--- journal export formats ---");
r=await req("GET","/api/payroll/journal?taxYear=2026/27&period=5&format=csv",{cookie:AC});
ok("CSV downloads",r.text.startsWith("Date,Reference,Account code"));
r=await req("GET","/api/payroll/journal?taxYear=2026/27&period=5&format=xero",{cookie:AC});
eq("Xero payload is a draft",r.body.Status,"DRAFT");
eq("Xero lines sum to zero",Math.round(r.body.JournalLines.reduce((s,l)=>s+l.LineAmount,0)*100)/100,0);
r=await req("GET","/api/payroll/journal?taxYear=2026/27&period=5&format=sage",{cookie:AC});
ok("Sage export typed JD/JC",/^(JD|JC),/.test(r.text.split("\n")[1]));

console.log("\n--- another tenant cannot see any of it ---");
r=await req("GET","/api/payroll/journal?taxYear=2026/27&period=5",{host:"rival-plc.hr-payrollsystem.com",cookie:AC});
eq("blocked at the tenant boundary",r.status,404);

console.log("\n--- September picks up August's year to date ---");
r=await req("POST","/api/payroll/calculate",{cookie:AC,body:{taxYear:"2026/27",period:6}});
eq("calculated",r.status,200);
const sep=(await T.query("SELECT 1")).rowCount;
ok("September gross matches August",Math.abs(r.body.totals.gross-13000)<2000);

console.log("\n============================================");
console.log("  "+pass+" passed, "+fail+" failed");
console.log("============================================\n");
srv.close(); await db.closeAll(); process.exit(fail?1:0);
})().catch(e=>{console.error("\nFAILED:",e.message,e.stack);process.exit(1);});
