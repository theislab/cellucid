/**
 * @fileoverview Whether an address is this machine: the one test for it, in
 * its two senses.
 *
 * - **A loopback host a browser trusts** (`isSecureContextLoopbackHost`):
 *   `localhost` and its subdomains (RFC 6761), 127.0.0.0/8, `::1` -- the
 *   hosts the W3C Secure Contexts specification calls potentially
 *   trustworthy over plain HTTP (§3.1), so a page there is a secure context
 *   and an `http:` request there is not mixed content. The rule for where a
 *   secret may go over plain HTTP: a Worker's or the relay's
 *   `ALLOWED_ORIGINS` (`utils/origin-allowlist.js`, the relay's copy in
 *   `relay/http.js`), a local relay's origin (`agent/bridge/relay-client.js`).
 * - **This machine** (`isLoopbackHostname`): those, or `0.0.0.0` (a server
 *   bound to every interface, opened by that address, answers from here).
 *   Bytes from it never cross a network: `cellucid serve`, Python's and R's
 *   served stores, a web server run here, a tunnel to one. `0.0.0.0` is not
 *   a trusted origin: browsers do not make it a secure context, and Chromium
 *   refuses requests to it from other sites (the "0.0.0.0 day" fix), so it
 *   is never where a secret may go over plain HTTP.
 *
 * Both read a host as `URL.hostname` gives it (lower case, `[::1]`
 * bracketed) or bare, in any case: `LOCALHOST` is `localhost`, `::1` is
 * `[::1]`. A name that only starts or ends like one (`localhost.example`,
 * `127.0.0.1.example`, `xlocalhost`) is neither.
 *
 * @module utils/loopback
 */

/** A host as the tests below read it: lower case, without IPv6 brackets. */
function bareHost(hostname) {
  return String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Whether `hostname` is a loopback host a browser trusts over plain HTTP
 * (module overview): `localhost`, `*.localhost`, 127.0.0.0/8, `::1`.
 *
 * @param {string} hostname - As `URL.hostname` gives it (`[::1]` bracketed) or bare
 * @returns {boolean}
 */
export function isSecureContextLoopbackHost(hostname) {
  const host = bareHost(hostname);
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '::1';
}

/**
 * Whether `hostname` is this machine (module overview): a trusted loopback
 * host, or `0.0.0.0`.
 *
 * @param {string} hostname - As `URL.hostname` gives it (`[::1]` bracketed) or bare
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  return isSecureContextLoopbackHost(hostname) || bareHost(hostname) === '0.0.0.0';
}

/**
 * Whether `href` (a URL or an origin) is an http(s) address on this machine.
 *
 * @param {string} href
 * @returns {boolean}
 */
export function isLoopbackUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname);
}
