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
  formEndpoint: "",

  // Cloudflare Turnstile site key. Blank hides the anti-spam widget.
  turnstileSiteKey: "",

  // Shown in the footer and on the legal pages.
  company: {
    name: "Open Source AI Ltd",
    number: "",
    registeredOffice: "",
    icoReference: ""
  }
};
