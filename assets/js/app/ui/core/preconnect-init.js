/**
 * Preconnect to the sample-catalog origin, and only to it.
 *
 * The catalog named by the `cellucid-sample-catalog` meta element is the
 * first cross-origin fetch of a start-up, so its TLS handshake is worth
 * starting while the modules load. A page that was told another catalog
 * (`?sampleCatalog=`, which `data/data-source.js` honors over the meta
 * element) never contacts the default one and must not open a connection to
 * it: a test, a notebook or an offline lab server would reach out to the
 * Internet for nothing, and WebKit reports the failed handshake as a console
 * error. Nor does a viewer page (`?viewer=…`: a notebook widget, a Python or
 * R browser-tab viewer), which never reads the sample catalog. A classic
 * script in the head, where the static link was, so the connection starts
 * before the stylesheet and the modules are requested.
 */
(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.has('sampleCatalog') || params.has('viewer')) return;
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
