/* ============================================================================
   CONNECTOR REGISTRY
   ----------------------------------------------------------------------------
   Every accounting system a customer might use, declared in one place.

   A connector declares what it IS before it declares what it DOES. That is
   deliberate: it lets the product show a customer "Xero — not yet available,
   pending app review" honestly, rather than either hiding it or pretending it
   works. A provider with `available: false` cannot be connected, and the
   reason is shown rather than buried.

   Adding a real integration means filling in the methods, not restructuring
   anything around it.
   ========================================================================== */

const JOURNAL = require("../../../packages/journal.js");
const crypto = require("crypto");

/* Shape every connector implements. Anything not implemented throws rather
   than silently doing nothing, because a connector that appears to post and
   does not is worse than one that plainly refuses. */
const notImplemented = name => () => {
  throw Object.assign(new Error(name + " is not implemented yet"), { status: 501 });
};

/* -------------------------------------------------------------- manual ---
   Works today, and for a lot of small customers it is all they need: produce
   the file, hand it to the bookkeeper. No credentials, no approval process,
   no dependency on anyone else's API staying up.
------------------------------------------------------------------------- */
const manual = {
  id: "manual",
  name: "Download a file",
  vendor: null,
  available: true,
  requiresOAuth: false,
  formats: ["csv", "sage", "xero"],
  description: "Export the journal and import it into any finance system by hand.",
  capabilities: { export: true, post: false, fetchAccounts: false },

  async connect(){ return { status: "connected", externalOrgName: "Manual export" }; },
  async disconnect(){ return { status: "not_connected" }; },
  async test(){ return { ok: true, detail: "Nothing to test — files are produced locally." }; },
  render(journal, format){
    if(format === "sage") return { body: JOURNAL.journalToSage(journal), type: "text/csv" };
    if(format === "xero") return { body: JSON.stringify(JOURNAL.journalToXero(journal), null, 2), type: "application/json" };
    return { body: JOURNAL.journalToCSV(journal), type: "text/csv" };
  },
  post: notImplemented("Direct posting for manual export")
};

/* --------------------------------------------------------------- xero ----
   The payload is already correct — journalToXero produces exactly what their
   manual journals endpoint expects. What is missing is the OAuth round trip
   and Xero's app review, neither of which is a coding problem.
------------------------------------------------------------------------- */
const xero = {
  id: "xero",
  name: "Xero",
  vendor: "Xero Limited",
  available: false,
  unavailableReason: "Awaiting Xero app review. The journal payload is complete and can be exported and imported by hand in the meantime.",
  requiresOAuth: true,
  oauth: {
    authoriseUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    scopes: ["offline_access", "accounting.transactions", "accounting.settings.read"],
    usesPKCE: true
  },
  formats: ["xero"],
  description: "Post the payroll journal directly to Xero as a draft manual journal.",
  capabilities: { export: true, post: true, fetchAccounts: true },

  render(journal){ return { body: JSON.stringify(JOURNAL.journalToXero(journal), null, 2), type: "application/json" }; },
  buildPayload(journal){ return JOURNAL.journalToXero(journal); },
  connect: notImplemented("Xero authorisation"),
  disconnect: notImplemented("Xero disconnection"),
  test: notImplemented("Xero connection test"),
  post: notImplemented("Posting to Xero")
};

/* --------------------------------------------------------------- sage ----
   "Sage" is not one product. Sage 50, Sage 200, Sage Intacct and Sage
   Business Cloud have different APIs and different onboarding. Listing them
   separately is more honest than a single entry a customer will misread.
------------------------------------------------------------------------- */
const sage50 = {
  id: "sage50",
  name: "Sage 50",
  vendor: "The Sage Group plc",
  available: false,
  unavailableReason: "Sage 50 imports a nominal ledger file rather than exposing a hosted API. File export is available now; automatic import is not.",
  requiresOAuth: false,
  formats: ["sage"],
  description: "Nominal ledger import file for Sage 50 Accounts.",
  capabilities: { export: true, post: false, fetchAccounts: false },
  render(journal){ return { body: JOURNAL.journalToSage(journal), type: "text/csv" }; },
  connect: notImplemented("Sage 50 connection"),
  disconnect: notImplemented("Sage 50 disconnection"),
  test: notImplemented("Sage 50 connection test"),
  post: notImplemented("Posting to Sage 50")
};

const sageBusinessCloud = {
  id: "sage_business_cloud",
  name: "Sage Business Cloud Accounting",
  vendor: "The Sage Group plc",
  available: false,
  unavailableReason: "Requires registration on the Sage developer programme. Not started.",
  requiresOAuth: true,
  oauth: {
    authoriseUrl: "https://www.sageone.com/oauth2/auth/central",
    tokenUrl: "https://oauth.accounting.sage.com/token",
    scopes: ["full_access"],
    usesPKCE: false
  },
  formats: ["csv"],
  description: "Post journals directly to Sage Business Cloud Accounting.",
  capabilities: { export: true, post: true, fetchAccounts: true },
  render(journal){ return { body: JOURNAL.journalToCSV(journal), type: "text/csv" }; },
  connect: notImplemented("Sage Business Cloud authorisation"),
  disconnect: notImplemented("Sage Business Cloud disconnection"),
  test: notImplemented("Sage Business Cloud connection test"),
  post: notImplemented("Posting to Sage Business Cloud")
};

const quickbooks = {
  id: "quickbooks",
  name: "QuickBooks Online",
  vendor: "Intuit Inc.",
  available: false,
  unavailableReason: "Requires an Intuit developer account and app review. Not started.",
  requiresOAuth: true,
  oauth: {
    authoriseUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scopes: ["com.intuit.quickbooks.accounting"],
    usesPKCE: false
  },
  formats: ["csv"],
  description: "Post journal entries directly to QuickBooks Online.",
  capabilities: { export: true, post: true, fetchAccounts: true },
  render(journal){ return { body: JOURNAL.journalToCSV(journal), type: "text/csv" }; },
  connect: notImplemented("QuickBooks authorisation"),
  disconnect: notImplemented("QuickBooks disconnection"),
  test: notImplemented("QuickBooks connection test"),
  post: notImplemented("Posting to QuickBooks")
};

const REGISTRY = [manual, xero, sage50, sageBusinessCloud, quickbooks];
const byId = Object.fromEntries(REGISTRY.map(c => [c.id, c]));

function list(){
  return REGISTRY.map(c => ({
    id: c.id, name: c.name, vendor: c.vendor,
    available: c.available,
    unavailableReason: c.unavailableReason || null,
    requiresOAuth: c.requiresOAuth,
    formats: c.formats,
    description: c.description,
    capabilities: c.capabilities
  }));
}

function get(id){
  const c = byId[id];
  if(!c) throw Object.assign(new Error("unknown connector: " + id), { status: 404 });
  return c;
}

/* A connector that is not available cannot be reached by any route. Checked
   here rather than in each route, so a new route cannot forget. */
function requireAvailable(id){
  const c = get(id);
  if(!c.available){
    throw Object.assign(
      new Error(c.unavailableReason || (c.name + " is not available yet")),
      { status: 409, connector: c.id });
  }
  return c;
}

/* Identifies a journal by its content. If a run is reopened and recalculated,
   the hash changes and the difference is visible rather than silent. */
function journalHash(journal){
  const canonical = JSON.stringify({
    reference: journal.reference,
    date: journal.date,
    lines: journal.lines.map(l => [l.code, l.costCentre || "", l.debit, l.credit])
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

module.exports = { list, get, requireAvailable, journalHash, REGISTRY };
