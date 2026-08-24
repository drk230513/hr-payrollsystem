/* ============================================================================
   SITE CONFIGURATION
   ----------------------------------------------------------------------------
   Your own values. Everything here is public — it is served to the browser —
   so nothing secret belongs in this file.

   THE RELEASE NEVER OVERWRITES THIS. Earlier versions had these values edited
   directly into index.html, which meant every upgrade silently reverted them
   and the enquiry form stopped working until someone noticed.
   ========================================================================== */
window.SITE_CONFIG = {

  // Formspree, or your own handler. Blank disables the form with a clear message.
  formEndpoint: "https://formspree.io/f/xljrvkrr",

  // Cloudflare Turnstile site key. Blank hides the anti-spam widget.
  turnstileSiteKey: "0x4AAAAAAEZePrYdfdYvc8aU",

  // Shown in the footer and on the legal pages.
  company: {
    name: "Open Source AI Ltd",
    number: "16933778",
    registeredOffice: "United Kingdom",
    icoReference: "ICO:00013386321"
  }
};
