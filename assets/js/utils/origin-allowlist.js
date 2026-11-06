/**
 * An exact origin allowlist (a Worker's `ALLOWED_ORIGINS` secret), and the
 * loopback hosts on which plain HTTP is accepted.
 *
 * The community-annotation Worker (`app/community-annotations/_worker-code.js`)
 * imports this module. The agent relay (`relay/http.js`) keeps its own copy,
 * which `tests/community-annotation-worker-duplication-contract.test.mjs`
 * holds to the same answers on the same inputs.
 *
 * @module utils/origin-allowlist
 */

/**
 * Whether a URL hostname (as `new URL(...).hostname` gives it) names this
 * computer: `localhost` and its subdomains, `127.0.0.0/8`, `[::1]`. A URL's
 * IPv4 host is always written as four decimal octets, so the pattern names
 * every loopback IPv4 address.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Parse a comma-separated list of exact origins: each entry is exactly a
 * URL's origin (no path, query, fragment, credentials, trailing slash or
 * surrounding space), over HTTPS, or over plain HTTP on a loopback host
 * (so a token is never sent to a remote plaintext origin). No entry may be
 * empty, `*`, or repeated.
 *
 * @param {unknown} raw
 * @param {(message: string) => Error} fail - builds the error thrown for a bad list
 * @returns {Set<string>}
 */
export function parseOriginAllowlist(raw, fail) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw fail('ALLOWED_ORIGINS must be a comma-separated list of exact origins');
  }
  const allowed = new Set();
  for (const entry of raw.split(',')) {
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw fail(`ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    }
    const exact = url.origin === entry && !url.username && !url.password;
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
    if (!exact || !secure) {
      throw fail(
        'ALLOWED_ORIGINS entries must be exact HTTPS origins or loopback ' +
          `HTTP development origins: ${entry}`
      );
    }
    if (allowed.has(entry)) {
      throw fail(`ALLOWED_ORIGINS repeats ${entry}`);
    }
    allowed.add(entry);
  }
  return allowed;
}
