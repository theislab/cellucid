/**
 * Where the page runs, as Google's and Microsoft's rules see it: its origin,
 * whether it is a Cellucid on this computer, and whether it is embedded in a
 * page of another site.
 *
 * An embedded page of another site gets storage of its own (the browser's
 * storage partitioning), and a `BroadcastChannel` is storage: a sign-in
 * window, which is a page in its own right, cannot post to it.
 *
 * @module data/sources/auth/page-context
 */

/** The page's origin (`https://www.cellucid.com`), or '' when it has none. */
export function pageOrigin(win) {
  return win.location?.origin ?? '';
}

/** A Cellucid served on this computer by name: `http://127.0.0.1` or `http://localhost`, any port. */
export function isLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * The origin of the page this one is embedded in: null for a page in its own
 * tab, '' when the browser does not say. A notebook shows its viewer one
 * level down, so the parent the browser names is the top page.
 */
export function embeddingOrigin(win) {
  if (win.self === win.top) return null;
  try {
    return win.top.location.origin;
  } catch {
    // Another origin: its address is not readable, only named below.
  }
  const ancestors = win.location?.ancestorOrigins;
  if (ancestors !== undefined && ancestors !== null && ancestors.length > 0) {
    return String(ancestors[ancestors.length - 1]);
  }
  try {
    return new URL(win.document.referrer).origin;
  } catch {
    return '';
  }
}

/** A host whose site is the host itself: an IP address or a name without a dot (`localhost`). */
function isLiteralHost(hostname) {
  return hostname.startsWith('[') || !hostname.includes('.') || /^[\d.]+$/.test(hostname);
}

/**
 * Whether the page is embedded in a page of another site: true, false, or
 * null when that cannot be told here. Two different domain names may share a
 * site (`a.example.org`, `b.example.org`); telling that needs the public
 * suffix list, so that case is null.
 */
export function embeddedInOtherSite(win) {
  const top = embeddingOrigin(win);
  if (top === null) return false;
  let self;
  let other;
  try {
    self = new URL(pageOrigin(win));
    other = new URL(top);
  } catch {
    return null;
  }
  if (self.protocol !== other.protocol) return true;
  if (self.hostname === other.hostname) return false;
  if (isLiteralHost(self.hostname) || isLiteralHost(other.hostname)) return true;
  return null;
}
