/**
 * @fileoverview Connect codes: the short one-time code a relay's approval
 * page shows ("ABCD-EFGH") and the Cellucid tab claims, either from the
 * page's "Open Cellucid to approve" link (`#cellucid_connect=<code>`, taken
 * out of the address by `connect-fragment.js` before any module runs) or
 * typed by the person in a tab of the browser that shows the page (the relay
 * lets only that browser claim it).
 *
 * Typed codes are forgiving the way Crockford's base32 is: case, spaces and
 * dashes do not matter, and I/L read as 1, O as 0.
 *
 * @module app/agent/bridge/connect-code
 */

import { CONNECT_CODE_ALPHABET, CONNECT_CODE_LENGTH } from './relay-protocol.js';

const SYMBOL = new Set(CONNECT_CODE_ALPHABET);

/**
 * The code in its exact form (`ABCDEFGH`), or null when `text` is not one.
 * @param {unknown} text
 * @returns {string|null}
 */
export function normalizeConnectCode(text) {
  if (typeof text !== 'string') return null;
  const compact = text.toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (compact.length !== CONNECT_CODE_LENGTH) return null;
  for (const symbol of compact) if (!SYMBOL.has(symbol)) return null;
  return compact;
}

/**
 * The code as a person reads it: two groups of four (`ABCD-EFGH`).
 * @param {string} code an exact code
 */
export function formatConnectCode(code) {
  const exact = normalizeConnectCode(code);
  if (exact === null) throw new TypeError('A connect code is eight letters and digits');
  return `${exact.slice(0, 4)}-${exact.slice(4)}`;
}

/**
 * Whether the page was opened with a connect code still to be claimed (the
 * relay approval page's link): the person came to approve a connection, so
 * the welcome is not shown over it. Reads without taking it.
 *
 * @param {object} [win] the page's window
 */
export function hasPendingConnectCode(win = globalThis.window) {
  return win !== undefined && win !== null && normalizeConnectCode(win.cellucidConnectFragment) !== null;
}

/**
 * The connect code the page was opened with, once: the head script
 * (`connect-fragment.js`) kept it in `window.cellucidConnectFragment` and
 * took it out of the address. Returns null when there is none or it is not a
 * code (a hand-edited link), and forgets it either way.
 *
 * @param {object} [win] the page's window
 * @returns {{code: string, via: 'link'}|null}
 */
export function takeConnectCode(win = globalThis.window) {
  if (win === undefined || win === null) return null;
  const raw = win.cellucidConnectFragment;
  if (raw === undefined) return null;
  delete win.cellucidConnectFragment;
  const code = normalizeConnectCode(raw);
  return code === null ? null : { code, via: 'link' };
}
