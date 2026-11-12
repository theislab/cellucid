/**
 * @fileoverview This page's Web Storage (`localStorage`, `sessionStorage`):
 * the one way any module reaches it.
 *
 * A browser that keeps nothing for this site (site data or cookies blocked,
 * a sandboxed frame, some private windows) throws a `SecurityError` on the
 * very read of `window.localStorage`, and a `typeof localStorage` test
 * throws too. Every preference, memory and cache kept there is a convenience:
 * without it Cellucid works for this visit and keeps nothing, so a module
 * asks here and reads `null` as "nothing is kept" instead of failing.
 *
 * Contract: `tests/web-storage-contract.test.mjs` (no module but this one
 * names the two stores as values).
 *
 * @module utils/web-storage
 */

const NAMES = new Set(['localStorage', 'sessionStorage']);

/** What a page whose browser keeps nothing for the site is told, once. */
export const STORAGE_NOT_KEPT =
  'This browser keeps no site data for Cellucid (blocked, or a private window): '
  + 'settings, histories and stored datasets last until this page closes.';

/**
 * This page's `name` store, or null where the browser does not give one.
 *
 * @param {'localStorage'|'sessionStorage'} name
 * @param {object} [scope] - The window to ask (a test's stand-in)
 * @returns {Storage|null}
 */
export function webStorage(name, scope = globalThis) {
  if (!NAMES.has(name)) {
    throw new TypeError('Web storage is "localStorage" or "sessionStorage".');
  }
  try {
    const storage = scope?.[name] ?? null;
    return storage !== null && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

/**
 * Whether this browser keeps what Cellucid stores for this site: a store is
 * there and takes a write (a full or refusing one does not).
 *
 * @param {object} [scope]
 * @returns {boolean}
 */
export function webStorageKeeps(scope = globalThis) {
  const storage = webStorage('localStorage', scope);
  if (storage === null) return false;
  const probe = 'cellucid:storage-probe';
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}
