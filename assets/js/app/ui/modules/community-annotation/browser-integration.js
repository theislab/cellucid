/**
 * @fileoverview Browser capabilities the community annotation UI depends on.
 *
 * External navigation and clipboard access are refused rather than degraded:
 * a non-HTTPS or non-canonical URL is not opened, and a missing clipboard API
 * throws instead of silently doing nothing. `describeGitHubAuthReachabilityError`
 * turns the two failure shapes a user can actually act on — an over-large GitHub
 * account and a Worker origin allowlist that does not include this site — into
 * instructions rather than raw fetch text.
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
  return window.open(parsed.toString(), '_blank', 'noopener,noreferrer') !== null;
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

export function describeGitHubAuthReachabilityError(err) {
  const msg = String(err?.message || '').trim();
  if (msg === 'GitHub installations total_count exceeds 10000') {
    return (
      'GitHub returned more than 10,000 installations, which Cellucid ' +
      'will not truncate. Reduce the Cellucid GitHub App installations ' +
      'available to this GitHub account, then click Reload.'
    );
  }
  if (msg === 'GitHub repositories total_count exceeds 10000') {
    return (
      'GitHub returned more than 10,000 repositories for one Cellucid ' +
      'GitHub App installation, which Cellucid will not truncate. In ' +
      'GitHub App settings, select fewer repositories for that ' +
      'installation, then click Reload.'
    );
  }
  if (msg === 'GitHub repository discovery exceeds 10000 repositories') {
    return (
      'Cellucid found more than 10,000 repositories across your GitHub ' +
      'App installations, which it will not truncate. In GitHub App ' +
      'settings, select fewer repositories, then click Reload.'
    );
  }
  const origin = String(window.location.origin || '').trim();
  const looksLikeCors =
    err instanceof TypeError ||
    /failed to fetch|load failed/i.test(msg);
  if (!looksLikeCors) return msg || 'Request failed';
  return `Couldn’t reach the GitHub sign-in server from ${origin || 'this site'}. If you recently changed domains, update your Cloudflare Worker allowlist (ALLOWED_ORIGINS) to include ${origin || 'this origin'}, then reload.`;
}
