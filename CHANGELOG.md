# Changelog

## 0.2.0

Added the backend.

- Multi-tenant payroll API: subdomain resolution, session authentication,
  per-tenant connection pooling, and a membership check re-run on every request
- Accounting journal engine with CSV, Xero and Sage exports
- Cover mode: delegation limits and plain-English guidance for a stand-in
- Reserved subdomains, so a customer cannot register `www` or `api`
- One installer for the whole release

Fixed:

- Journals were posting department codes instead of cost centres, which a
  finance system would not recognise
- Tenant schema is applied once and changes go through migrations; re-running
  it over a live database threw dozens of errors

## 0.1.0

- UK calculation engine: cumulative and non-cumulative PAYE including Scottish
  bands, NI across all categories plus the directors' annual basis, student and
  postgraduate loans, four pension earnings bases, statutory payments, leave
  held in hours
- Pre-commit assurance with exception detection and a commit gate
- Automation policy engine with manual, assisted and automated modes
- PostgreSQL schema: control plane plus one database per customer
- Public website, interactive demo, legal pages
