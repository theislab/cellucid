/**
 * Local/dev host detection.
 *
 * Used to gate dev-only console toggles so they cannot be enabled on production
 * by simply setting `window.*` flags.
 */

export function isLocalDevHost() {
  try {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
    const host = String(window.location.hostname || '').toLowerCase();
    const proto = String(window.location.protocol || '').toLowerCase();
    if (proto === 'file:') return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    if (host.endsWith('.local')) return true;
    if (/^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return true;
    if (/^192\.168\.(\d{1,3})\.(\d{1,3})$/.test(host)) return true;
    const m = host.match(/^172\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const second = Number(m[1]);
      if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

