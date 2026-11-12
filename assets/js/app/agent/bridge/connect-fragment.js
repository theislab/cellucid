/**
 * Take a relay approval link's connect code out of the page address before
 * anything else runs.
 *
 * The Cellucid relay's approval page (shown when Claude or ChatGPT asks to
 * connect) links here with `#cellucid_connect=<code>`. The module that
 * claims the code (`app/agent/bridge/connect-code.js`, read by the relay
 * client) runs only once the module graph has loaded; this classic script in
 * the head moves the code into the page's memory
 * (`window.cellucidConnectFragment`, read once) and replaces the address
 * without that one segment, so a reload, a bookmark or a shared link never
 * carries it. Every other part of the fragment stays where it is.
 *
 * A page inside another site's frame takes the code out but keeps none: a
 * site that frames Cellucid could otherwise lay its own page over the
 * approval dialog and have the person click Allow unseen (clickjacking;
 * GitHub Pages cannot send `frame-ancestors`).
 *
 * It runs before `auth-fragment-init.js`, which takes a GitHub sign-in's
 * whole fragment. The key is `CONNECT_FRAGMENT_KEY` of
 * `app/agent/bridge/relay-protocol.js` (a classic script cannot import it; a
 * contract test keeps the two equal).
 */
(() => {
  const hash = window.location.hash;
  if (!/^#(?:.*&)?cellucid_connect=/.test(hash)) return;
  const segments = hash.slice(1).split('&');
  const kept = [];
  let code = null;
  for (const segment of segments) {
    if (segment.startsWith('cellucid_connect=')) {
      if (code === null) {
        try {
          code = decodeURIComponent(segment.slice('cellucid_connect='.length));
        } catch {
          code = '';
        }
      }
    } else if (segment !== '') {
      kept.push(segment);
    }
  }
  Object.defineProperty(window, 'cellucidConnectFragment', {
    configurable: true,
    enumerable: false,
    value: window.top === window ? code : null,
    writable: false,
  });
  const rest = kept.length > 0 ? `#${kept.join('&')}` : '';
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest}`);
})();
