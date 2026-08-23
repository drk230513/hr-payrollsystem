# Launching hr-payrollsystem.com

Two launches, not one. Confusing them is the expensive mistake.

**Launch A — the site.** Marketing page, demo, enquiry form. Nothing legally
blocks this. You could be live this week.

**Launch B — live payroll for a paying customer.** Blocked by approvals that
take months and cannot be shortened by writing more code.

Launching A while B is in progress is the right commercial move regardless.
It builds a pipeline during the wait, and the status section on the homepage
turns the wait into a credibility signal rather than something to explain away.

---

## Launch A — before the site goes live

### Domain and hosting
- [ ] Register **hr-payrollsystem.com**, and defensively register `.co.uk` — UK
      buyers will type it. Point it at the same host.
- [ ] DNS: A record for the apex, CNAME for `www`.
- [ ] Enable registrar lock and two-factor on the registrar account. A payroll
      brand losing its domain is unrecoverable.
- [ ] Host in a **UK region**. The security page will claim UK data residency
      and the database schema enforces it.
- [ ] TLS via Let's Encrypt (`docker compose run --rm certbot`). Confirm
      auto-renewal actually runs before you raise the HSTS max-age.
- [ ] Set up email on the domain with SPF, DKIM and DMARC. Payroll enquiries
      landing in spam is a silent business killer.

### Legal pages — genuinely required, not optional
- [ ] **Privacy notice.** You are a data controller for enquiry data the moment
      the form goes live. UK GDPR Articles 13 and 14 set out what it must say.
- [ ] **Terms of service.**
- [ ] **Cookie banner** — only if you add analytics. If you use none, say so;
      it is a real differentiator and saves you the banner entirely.
- [ ] **Company details in the footer.** The Companies Act 2006 requires a
      limited company to show its registered name, number and registered office
      on its website. The footer has placeholders — fill them in.

### ICO registration
- [ ] Register with the **Information Commissioner's Office** and pay the data
      protection fee. This is a legal requirement for UK data controllers, the
      fee is modest, and the reference goes in your footer. Do this before the
      form collects a single enquiry.

### Before you point anyone at it
- [ ] Fill in `[COMPANY NUMBER]`, `[REGISTERED ADDRESS]`, `[ICO REFERENCE]`.
- [ ] Set `FORM_ENDPOINT` in `index.html`, or leave it blank and let the mailto
      fallback work — but test whichever you choose.
- [ ] Check the page on a real phone, not just a narrow browser window.

---

## Launch B — before real employee data exists

These run in parallel and all take time. Start them now.

### 1. HMRC recognition — the long pole
Software cannot submit RTI without it. HMRC tests your FPS and EPS output
against their scenario suite before issuing credentials.

- [ ] Apply for the HMRC software developer programme.
- [ ] Work through the test scenarios and pass validation.
- [ ] Obtain Government Gateway credentials and a Sender ID.

Budget several months. Everything else on this list is faster.

### 2. BACS Service User Number
- [ ] Apply through a sponsoring bank or an approved bureau.
- [ ] Obtain a Bacstel-IP certificate.

A bureau is usually faster than direct sponsorship for a new company, at the
cost of a per-file fee. For a first customer that trade is almost always worth it.

### 3. Insurance
- [ ] **Professional indemnity.** Non-negotiable. If a calculation error causes
      an underpayment to HMRC, the claim lands on you. Public sector tenders
      routinely require a specific minimum — check before bidding, not after.
- [ ] Cyber liability.
- [ ] Employers' liability if you have staff (legally required in the UK).

### 4. Security accreditation
- [ ] **Cyber Essentials** — effectively mandatory for public sector work and
      increasingly expected privately. Cheap and quick.
- [ ] **Cyber Essentials Plus** — audited. Councils often require it.
- [ ] ISO 27001 only when a customer demands it. Expensive, slow, and premature
      before you have revenue.

### 5. Data protection
- [ ] **Data Processing Agreement.** Once you hold a customer's employee data
      you are their processor, and UK GDPR Article 28 requires specific
      contract terms. Get this drafted by a solicitor — a template found online
      is a false economy here.
- [ ] **DPIA.** Large-scale processing of employee financial data warrants one.
      Councils will ask to see it.
- [ ] **Sub-processor list**, published and kept current.
- [ ] **Retention policy.** Payroll records must be kept six years; personal
      data beyond that should be purged. Nothing currently expires anything.

### 6. Engineering still outstanding
- [ ] Encrypt `ni_number` — currently plaintext, and it is personal data.
- [ ] Row-level security inside tenants, before employee self-service.
- [ ] **Weekly automated restore drill.** Restore a tenant into a scratch
      database and alert if it fails. An untested restore is not a backup.
- [ ] Off-site, separately-credentialed backup copies. Ransomware that reaches
      your host reaches backups stored on the same host.
- [ ] Uptime and error monitoring with alerts that reach a human.
- [ ] A staging environment. Never migrate production first.

---

## First customer

Pick one with **fewer than 100 employees, monthly pay, no unusual schemes**.
Not a council, not one with term-time staff or multiple assignments. You want
the interesting edge cases in your test suite, not in your first live run.

Parallel-run **three cycles minimum** against their existing system, comparing
every payslip to the penny. Two cycles is where projects fail: the second month
looks fine and the third surfaces the quarterly and annual events.

Charge for the parallel run. It is real work, and a customer who pays engages
properly with the comparison.

---

## What to say about status

The homepage states plainly that RTI submission is in recognition. Keep it.

Payroll buyers have been sold vapourware before and expect to be. Saying *"the
engine is complete and tested, we're in the HMRC recognition process, and here
is exactly what that means for your timeline"* converts better with this
audience than a confident claim they will check and find wanting.

Never claim a system is live before recognition. That is the kind of thing that
ends a supplier relationship rather than starting one.

---

## Files

```
site/
  index.html            the landing page
  deploy/
    docker-compose.yml  postgres, pgbouncer, nginx, certbot, backups
    nginx.conf          TLS, security headers, canonical host
    .env.example        copy to .env and fill in
  LAUNCH.md             this file
database/               the schema, tested against PostgreSQL 16
```

Serve the interactive product demo at `/demo` — the nginx config already routes
it. It is the strongest thing you have; put it one click from the hero.
