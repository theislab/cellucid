/** Google Analytics bootstrap for the declared production hosts. */
(() => {
  const MEASUREMENT_ID = 'G-K4774ZWGEQ';
  const PRODUCTION_HOSTS = new Set([
    'cellucid.com',
    'www.cellucid.com',
    'theislab.github.io',
  ]);
  const hostname = window.location.hostname;
  const enabled = PRODUCTION_HOSTS.has(hostname);
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

  window.dataLayer = [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID, {
    anonymize_ip: true,
    transport_type: 'beacon',
  });

  const script = document.createElement('script');
  script.async = true;
  script.src =
    `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
})();
