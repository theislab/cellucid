/**
 * @fileoverview Browser capabilities the community annotation UI depends on.
 *
 * External navigation and clipboard access are refused rather than degraded:
 * a non-HTTPS or non-canonical URL is not opened, and a missing clipboard API
 * throws instead of silently doing nothing. `describeGitHubAuthReachabilityError`
 * turns the failure a user can act on (a Worker origin allowlist that does not
 * include this site) into an instruction rather than raw fetch text.
 *
 * @module ui/modules/community-annotation/browser-integration
 */

export function openExternal(url) {
  if (
    typeof url !== 'string' ||
    !url ||
    /^\s|\s$/.test(url)
  ) {
    return false;
  }
  if (typeof URL.canParse !== 'function') {
    throw new TypeError('External navigation requires URL.canParse()');
  }
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.toString() !== url) return false;
  if (typeof window.open !== 'function') {
    throw new TypeError('External navigation requires window.open()');
  }
  // `window.open` with the `noopener` feature returns null whether or not a
  // window opened (HTML: "the window open steps", noopener), so it cannot
  // tell a blocked popup from an opened one. Open a blank window instead: null
  // means the browser refused it; otherwise cut its opener (what `noopener`
  // gives) before it navigates to the external page, so that page can never
  // reach this one.
  const opened = window.open('about:blank', '_blank');
  if (opened === null || opened === undefined) return false;
  opened.opener = null;
  opened.location.replace(parsed.toString());
  return true;
}

export async function copyTextToClipboard(text) {
  if (
    typeof text !== 'string' ||
    !text ||
    /^\s|\s$/.test(text)
  ) {
    return false;
  }
  const value = text;
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  throw new TypeError('Community annotation copying requires navigator.clipboard.writeText()');
}

/**
 * What to tell the person when GitHub sign-in or repository discovery could
 * not reach the Worker. A Worker never reached (no answer this page may
 * read, and none before: `worker-request.js` `answeredBefore`) is most often
 * one whose `ALLOWED_ORIGINS` does not list this site; anything else keeps
 * its own sentence.
 */
export function describeGitHubAuthReachabilityError(err) {
  const msg = String(err?.message || '').trim();
  if (err?.code !== 'GITHUB_WORKER_UNREACHABLE' || err.answeredBefore === true) {
    return msg || 'Request failed';
  }
  const origin = String(window.location.origin || '').trim();
  return `Couldn’t reach the GitHub sign-in server from ${origin || 'this site'}. If you recently changed domains, update your Cloudflare Worker allowlist (ALLOWED_ORIGINS) to include ${origin || 'this origin'}, then reload.`;
}
