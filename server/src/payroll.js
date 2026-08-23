/* ============================================================================
   PAYROLL SERVICE
   ----------------------------------------------------------------------------
   Where the calculation engine meets the database. Reads effective-dated
   records for a period, calculates, detects exceptions, and — on commit —
   writes immutable payslips and produces the accounting journal.

   Every read resolves records AS AT the period, not as they are today. Asking
   "what was this person's salary in August" three years later must give the
   August answer, which is why remuneration, tax codes and NI categories are
   all queried through their effective date ranges.
   ========================================================================== */

const ENGINE  = require("../../engine.js");
const JOURNAL = require("../../journal.js");
const db = require("./db");

/* ---------- read the workforce as it stood during the period ------------- */
async function employeesForPeriod(pool, period){
  const { rows } = await pool.query(`
    SELECT e.id, e.payroll_number, e.first_name, e.last_name, e.date_of_birth,
           e.ni_number, e.status, e.is_director,
           em.id AS employment_id, em.job_title, em.started_on, em.ended_on,
           coalesce(d.cost_centre, d.code) AS cost_centre, d.name AS department,
           r.annual_salary, r.weekly_hours, r.days_per_week,
           tc.code AS tax_code, tc.basis AS tax_basis,
           ni.category AS ni_category,
           sm.scheme_id
      FROM payroll.employees e
      JOIN payroll.employments em ON em.employee_id = e.id
       AND daterange(em.started_on, em.ended_on, '[)') && daterange($1::date, $2::date, '[]')
      LEFT JOIN payroll.departments d ON d.id = em.department_id
      LEFT JOIN payroll.remuneration r ON r.employment_id = em.id
       AND daterange(r.effective_from, r.effective_to, '[)') @> $2::date
      LEFT JOIN payroll.tax_codes tc ON tc.employee_id = e.id
       AND daterange(tc.effective_from, tc.effective_to, '[)') @> $2::date
      LEFT JOIN payroll.ni_categories ni ON ni.employee_id = e.id
       AND daterange(ni.effective_from, ni.effective_to, '[)') @> $2::date
      LEFT JOIN payroll.scheme_memberships sm ON sm.employee_id = e.id
       AND sm.opt_out_on IS NULL
       AND daterange(sm.joined_on, sm.left_on, '[)') @> $2::date
     WHERE e.status <> 'suspended'
     ORDER BY e.last_name, e.first_name`,
    [period.starts_on, period.ends_on]);

  return rows.map(r => ({
    id: r.id,
    payrollNumber: r.payroll_number,
    name: r.first_name + " " + r.last_name,
    dob: r.date_of_birth ? isoDate(r.date_of_birth) : null,
    niNumber: r.ni_number,
    status: r.status,
    director: r.is_director,
    jobTitle: r.job_title,
    department: r.department,
    costCentre: r.cost_centre,
    leavingDate: r.ended_on ? isoDate(r.ended_on) : null,
    annualSalary: Number(r.annual_salary || 0),
    weeklyHours: Number(r.weekly_hours || 37.5),
    daysPerWeek: Number(r.days_per_week || 5),
    taxCode: r.tax_code || "",
    niCategory: r.ni_category || "A",
    pensionSchemeId: r.scheme_id || "",
    otherDeductions: []
  }));
}

const isoDate = d => (d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10));

async function schemesFor(pool){
  const { rows } = await pool.query(
    `SELECT id, name, provider, basis, method,
            employee_rate, employer_rate, qualifying_lower, qualifying_upper, is_default
       FROM payroll.pension_schemes`);
  return rows.map(r => ({
    id: r.id, name: r.name, provider: r.provider,
    basis: r.basis === "net_pay" ? "pensionable" : r.basis,
    method: { net_pay:"netPay", salary_sacrifice:"salarySac", relief_at_source:"reliefAtSource" }[r.method] || r.method,
    employeeRate: Number(r.employee_rate), employerRate: Number(r.employer_rate),
    qualifyingLower: r.qualifying_lower ? Number(r.qualifying_lower) : undefined,
    qualifyingUpper: r.qualifying_upper ? Number(r.qualifying_upper) : undefined,
    isDefault: r.is_default
  }));
}

async function periodByNumber(pool, taxYear, sequence){
  const { rows } = await pool.query(
    `SELECT p.*, s.frequency, s.periods_per_year
       FROM payroll.pay_periods p
       JOIN payroll.pay_schedules s ON s.id = p.schedule_id
      WHERE p.tax_year = $1 AND p.sequence = $2
      LIMIT 1`, [taxYear, sequence]);
  return rows[0] || null;
}

/* Year-to-date comes from committed runs only. A draft run must never feed the
   next period's cumulative figures, or reopening it silently corrupts the rest
   of the tax year. */
async function ytdFor(pool, employeeId, taxYear, beforeSequence){
  const { rows } = await pool.query(
    `SELECT ps.ytd_gross, ps.ytd_taxable, ps.ytd_tax, ps.ytd_employee_ni, ps.ytd_pension,
            ps.niable_pay, ps.employer_ni
       FROM payroll.payslips ps
       JOIN payroll.pay_runs pr ON pr.id = ps.pay_run_id
       JOIN payroll.pay_periods pp ON pp.id = pr.pay_period_id
      WHERE ps.employee_id = $1 AND pp.tax_year = $2 AND pp.sequence < $3
        AND pr.status = 'committed'
      ORDER BY pp.sequence DESC LIMIT 1`,
    [employeeId, taxYear, beforeSequence]);
  const r = rows[0];
  if(!r) return null;
  return {
    gross: Number(r.ytd_gross), taxable: Number(r.ytd_taxable),
    niable: Number(r.ytd_taxable), tax: Number(r.ytd_tax),
    niEmployee: Number(r.ytd_employee_ni), niEmployer: 0,
    pension: Number(r.ytd_pension), pensionEr: 0, studentLoan: 0, net: 0
  };
}

/* ---------- calculate ---------------------------------------------------- */
async function calculate(pool, { taxYear, sequence, config, org }){
  const period = await periodByNumber(pool, taxYear, sequence);
  if(!period) throw Object.assign(new Error("pay period not found"), { status: 404 });

  const employees = await employeesForPeriod(pool, period);
  const schemes = await schemesFor(pool);
  const schemeFor = e => schemes.find(s => s.id === e.pensionSchemeId) || null;

  const payslips = [];
  for(const e of employees){
    const ytd = await ytdFor(pool, e.id, taxYear, sequence);
    payslips.push(ENGINE.calcPayslip({ employee: e, period: sequence, scheme: schemeFor(e), ytd, config }));
  }

  const priors = {};
  for(const e of employees){
    const p = await ytdFor(pool, e.id, taxYear, sequence);
    if(p) priors[e.id] = { net: 0 };
  }

  const exceptions = ENGINE.detectExceptions({
    payslips, employees, priorPayslips: priors, schemes, config,
    period: { start: isoDate(period.starts_on), end: isoDate(period.ends_on) }
  });

  const totals = payslips.reduce((t, ps) => ({
    gross: t.gross + ps.gross, net: t.net + ps.net, tax: t.tax + ps.paye.tax,
    niEmployee: t.niEmployee + ps.ni.employee, niEmployer: t.niEmployer + ps.ni.employer,
    pension: t.pension + ps.pension.employee, pensionEr: t.pensionEr + ps.pension.employer,
    employerCost: t.employerCost + ps.employerCost
  }), { gross:0, net:0, tax:0, niEmployee:0, niEmployer:0, pension:0, pensionEr:0, employerCost:0 });
  Object.keys(totals).forEach(k => totals[k] = ENGINE.p2(totals[k]));

  const reliefs = ENGINE.applyEmployerReliefs({
    totalEmployerNI: totals.niEmployer, allowanceUsedToDate: 0,
    org: org || {}, config
  });

  return { period, employees, schemes, payslips, exceptions, totals, reliefs };
}

/* ---------- commit ------------------------------------------------------
   One transaction. Either the whole run lands or none of it does — a run that
   half-commits leaves year-to-date figures wrong for the rest of the year.
------------------------------------------------------------------------- */
async function commit(pool, { taxYear, sequence, config, org, actor, decisions }){
  const calc = await calculate(pool, { taxYear, sequence, config, org });

  const undecided = calc.exceptions.filter(x => !decisions || !decisions[x.reference || x.ref]);
  if(undecided.length){
    throw Object.assign(
      new Error(undecided.length + " exception(s) still undecided"),
      { status: 409, undecided: undecided.map(x => x.ref) });
  }

  return db.withTransaction(pool, async client => {
    const { rows: runRows } = await client.query(
      `INSERT INTO payroll.pay_runs(pay_period_id, status, calculated_at, engine_version, rates_snapshot)
       VALUES ($1,'draft',now(),$2,$3)
       ON CONFLICT (pay_period_id) DO UPDATE SET calculated_at = now()
       RETURNING id`,
      [calc.period.id, process.env.ENGINE_VERSION || "1.0.0", JSON.stringify(config)]);
    const runId = runRows[0].id;

    for(const ps of calc.payslips){
      const e = calc.employees.find(x => x.id === ps.employeeId);
      const { rows: slipRows } = await client.query(
        `INSERT INTO payroll.payslips(
           pay_run_id, employee_id, gross, taxable_pay, niable_pay, tax,
           employee_ni, employer_ni, pension_employee, pension_employer,
           student_loan, other_deductions, total_deductions, net,
           ytd_gross, ytd_taxable, ytd_tax, ytd_employee_ni, ytd_pension,
           tax_code_used, tax_basis_used, ni_category_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (pay_run_id, employee_id) DO NOTHING
         RETURNING id`,
        [runId, ps.employeeId, ps.gross, ps.taxableThis, ps.niableThis, ps.paye.tax,
         ps.ni.employee, ps.ni.employer, ps.pension.employee, ps.pension.employer,
         ps.studentLoan.total, 0, ps.totalDeductions, ps.net,
         ps.ytd.gross, ps.ytd.taxable, ps.ytd.tax, ps.ytd.niEmployee, ps.ytd.pension,
         e.taxCode, ps.paye.code.cumulative ? "cumulative" : "week1_month1", ps.ni.category]);

      const slipId = slipRows[0] && slipRows[0].id;
      if(slipId){
        let seq = 0;
        for(const p of ps.payments){
          await client.query(
            `INSERT INTO payroll.payslip_lines(payslip_id, kind, sequence, label, amount, hours, rate)
             VALUES ($1,'payment',$2,$3,$4,$5,$6)`,
            [slipId, ++seq, p.label, p.amount, p.hours, p.rate]);
        }
        seq = 0;
        for(const dd of ps.deductions){
          await client.query(
            `INSERT INTO payroll.payslip_lines(payslip_id, kind, sequence, label, amount)
             VALUES ($1,'deduction',$2,$3,$4)`,
            [slipId, ++seq, dd.label, dd.amount]);
        }
      }
    }

    for(const x of calc.exceptions){
      const { rows: exRows } = await client.query(
        `INSERT INTO payroll.run_exceptions(pay_run_id, reference, rule_id, severity, title, amount, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (pay_run_id, reference) DO UPDATE SET title = EXCLUDED.title
         RETURNING id`,
        [runId, x.ref, x.kind === "rule" ? x.ref : (x.ruleId || "model"),
         x.severity, x.title, x.amount, JSON.stringify(x.evidence || [])]);
      const exId = exRows[0].id;
      const d = decisions[x.ref];
      await client.query(
        `INSERT INTO payroll.exception_decisions(exception_id, decision, decided_by, by_rule, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (exception_id) DO NOTHING`,
        [exId, d.type, d.by || actor, d.byRule || null, d.note || null]);
    }

    // The database refuses this while any exception is undecided.
    await client.query(
      `UPDATE payroll.pay_runs SET status='committed', committed_at=now(), committed_by=$2 WHERE id=$1`,
      [runId, actor]);

    await client.query(
      `INSERT INTO payroll.audit_log(actor, action, entity, entity_id, after)
       VALUES ($1,'payroll.committed','pay_run',$2,$3)`,
      [actor, runId, JSON.stringify({ taxYear, sequence, totals: calc.totals })]);

    return { runId, ...calc };
  });
}

/* ---------- journal ------------------------------------------------------ */
async function journalFor(pool, { taxYear, sequence, org, accounts, options }){
  const period = await periodByNumber(pool, taxYear, sequence);
  if(!period) throw Object.assign(new Error("pay period not found"), { status: 404 });

  const { rows } = await pool.query(
    `SELECT ps.*, e.id AS emp_id, coalesce(d.cost_centre, d.code) AS cost_centre, d.name AS department
       FROM payroll.payslips ps
       JOIN payroll.pay_runs pr ON pr.id = ps.pay_run_id
       JOIN payroll.employees e ON e.id = ps.employee_id
       LEFT JOIN payroll.employments em ON em.employee_id = e.id AND em.ended_on IS NULL
       LEFT JOIN payroll.departments d ON d.id = em.department_id
      WHERE pr.pay_period_id = $1 AND pr.status = 'committed'`,
    [period.id]);

  if(!rows.length) throw Object.assign(new Error("no committed run for this period"), { status: 404 });

  const payslips = rows.map(r => ({
    employeeId: r.emp_id,
    gross: Number(r.gross),
    net: Number(r.net),
    paye: { tax: Number(r.tax) },
    ni: { employee: Number(r.employee_ni), employer: Number(r.employer_ni) },
    pension: { employee: Number(r.pension_employee), employer: Number(r.pension_employer) },
    studentLoan: { total: Number(r.student_loan) },
    deductions: [],
    employerCost: Number(r.gross) + Number(r.employer_ni) + Number(r.pension_employer),
    totalDeductions: Number(r.total_deductions)
  }));

  const employees = rows.map(r => ({
    id: r.emp_id, costCentre: r.cost_centre, department: r.department
  }));

  return JOURNAL.buildJournal({
    run: { exceptions: [], decisions: {} },
    payslips, employees,
    period: {
      n: period.sequence, taxYear: period.tax_year,
      label: new Date(period.starts_on).toLocaleDateString("en-GB", { month:"long", year:"numeric" }),
      start: isoDate(period.starts_on), end: isoDate(period.ends_on), payDate: isoDate(period.pay_date)
    },
    org: org || {}, accounts, options
  });
}

module.exports = {
  employeesForPeriod, schemesFor, periodByNumber, ytdFor,
  calculate, commit, journalFor
};
