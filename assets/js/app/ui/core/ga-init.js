/**
 * Google Analytics bootstrap for the declared production hosts.
 *
 * Analytics runs only on the app's own pages on a production host. A viewer
 * page (any address with the `viewer` parameter: a notebook widget frames
 * `?viewer=embedded`, a Python or R browser-tab viewer serves
 * `?viewer=true…`; `data/viewer-protocol.js` `VIEWER_PAGE_MODE_PARAMETER`)
 * never loads it, whatever host serves it, and neither does any other host.
 *
 * What the page lets Google collect is fixed here, before the tag loads, so
 * a change in the Google Analytics property cannot widen it:
 *
 * - consent defaults deny advertising storage, advertising use of user data
 *   and ad personalization (only `analytics_storage` is granted), and Google
 *   signals and ad-personalization signals are off;
 * - the page location and referrer are origin and path only, set for every
 *   hit: the query string names what the page opens (`dataset`, `remote`,
 *   `data`, `sampleCatalog`, a subsample) and can carry a private server
 *   address or a signed link, so it is never part of either.
 *
 * Every event is declared in `analytics/schema.js`.
 */
(() => {
  const MEASUREMENT_ID = 'G-K4774ZWGEQ';
  const PRODUCTION_HOSTS = new Set([
    'cellucid.com',
    'www.cellucid.com',
    'theislab.github.io',
  ]);
  const VIEWER_PAGE_PARAMETER = 'viewer';
  const viewerPage = new URLSearchParams(window.location.search).has(VIEWER_PAGE_PARAMETER);
  const enabled = PRODUCTION_HOSTS.has(window.location.hostname) && !viewerPage;
  Object.defineProperty(window, 'cellucidAnalyticsEnabled', {
    configurable: false,
    enumerable: false,
    value: enabled,
    writable: false,
  });
  if (!enabled) return;

  if (
    Object.hasOwn(window, 'dataLayer') ||
    Object.hasOwn(window, 'gtag')
  ) {
    throw new Error('Google Analytics was initialized more than once');
  }

  /** An address as origin and path, or '' for none or an unreadable one. */
  const withoutQuery = href => {
    try {
      const url = new URL(href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '';
    }
  };

  window.dataLayer = [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  });
  window.gtag('js', new Date());
  const page = {
    page_location: `${window.location.origin}${window.location.pathname}`,
    page_referrer: withoutQuery(document.referrer),
  };
  // Every hit, not only the first page view: an automatic page view after
  // the app rewrites its address carries the same two values.
  window.gtag('set', page);
  window.gtag('config', MEASUREMENT_ID, {
    ...page,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src =
    `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
})();
