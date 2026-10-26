/**
 * Preconnect to the sample-catalog origin, and only to it.
 *
 * The catalog named by the `cellucid-sample-catalog` meta element is the
 * first cross-origin fetch of a start-up, so its TLS handshake is worth
 * starting while the modules load. A page that was told another catalog
 * (`?sampleCatalog=`, which `data/data-source.js` honours over the meta
 * element) never contacts the default one and must not open a connection to
 * it: a test, a notebook or an offline lab server would reach out to the
 * Internet for nothing, and WebKit reports the failed handshake as a console
 * error. A classic script in the head, where the static link was, so the
 * connection starts before the stylesheet and the modules are requested.
 */
(() => {
  if (new URLSearchParams(window.location.search).has('sampleCatalog')) return;
  const meta = document.querySelector('meta[name="cellucid-sample-catalog"]');
  if (meta === null) return;
  let origin;
  try {
    origin = new URL(meta.getAttribute('content') ?? '', window.location.href).origin;
  } catch {
    return;
  }
  if (origin === 'null' || origin === window.location.origin) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
})();
