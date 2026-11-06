/**
 * Redirect URIs: which a client may register, and when a requested one is
 * the registered one.
 *
 * - A redirect URI is https, or http on this computer's loopback
 *   (`localhost`, `127.0.0.1`, `[::1]`): the MCP authorization rules allow
 *   nothing else. No fragment, no user name or password.
 * - A requested URI matches a registered one exactly, character for
 *   character, except that a loopback URI matches on any port: a native app
 *   (Claude Code) listens on a port it picks per sign-in (RFC 8252 §7.3; the
 *   same for `localhost`, which Claude Code declares).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(value) {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Why `value` cannot be a redirect URI, or null when it can. */
export function redirectUriProblem(value) {
  const url = parse(value);
  if (url === null) return 'is not an absolute URL';
  if (value.includes('#')) return 'has a fragment';
  if (url.username !== '' || url.password !== '') return 'carries a user name or password';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return 'must be https, or http on localhost, 127.0.0.1 or [::1]';
}

/** Whether `value` is a loopback redirect URI (the app asking runs on the person's computer). */
export function isLoopbackRedirect(value) {
  const url = parse(value);
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether `requested` is `registered`.
 * @param {string} registered
 * @param {string} requested
 */
export function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  if (!isLoopbackRedirect(registered) || !isLoopbackRedirect(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** The host the answer of an authorization goes to (for the person to see). */
export function redirectHostOf(value) {
  return parse(value)?.hostname ?? '';
}
