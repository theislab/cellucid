/**
 * Google Analytics bootstrap (gtag).
 *
 * This file is intentionally tiny and loaded from `index.html` after the
 * async `gtag.js` script tag, so it must:
 * - define `window.dataLayer` and `window.gtag` if missing
 * - queue initial `gtag()` calls even if `gtag.js` hasn't finished loading
 * - never throw (analytics must not break the app)
 */
(() => {
  try {
    const MEASUREMENT_ID = 'G-K4774ZWGEQ';

    const hostname = window.location?.hostname || '';
    const isLocal =
      hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1';

    const params = new URLSearchParams(window.location?.search || '');
    const debugMode = isLocal || params.get('ga_debug') === '1' || params.get('ga_debug') === 'true';

    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function gtag() {
        window.dataLayer.push(arguments);
      };

    window.gtag('js', new Date());
    window.gtag('config', MEASUREMENT_ID, {
      anonymize_ip: true,
      transport_type: 'beacon',
      debug_mode: debugMode
    });
  } catch (err) {
    console.warn('[GA] Failed to initialize Google Analytics:', err);
  }
})();
