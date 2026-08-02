/**
 * @fileoverview A UUID that does not require a secure context.
 *
 * `crypto.randomUUID()` is secure-context only. `crypto.getRandomValues()` is
 * not: it is available over plain HTTP as well. The Python package supports
 * binding to a non-loopback address deliberately, so the app is reachable at
 * `http://<lan-address>:<port>`, and there `randomUUID` is simply absent.
 * Calling it unguarded fails with "crypto.randomUUID is not a function" at the
 * moment the user acts.
 *
 * This mints the same v4 shape from `getRandomValues`, so identifiers written
 * into session bundles keep one format regardless of where the page was served
 * from, and existing bundles stay readable.
 *
 * This is for opaque *domain* identifiers - a keyframe, a saved query. DOM ids
 * come from `ui/components/dom-id.js`, which needs no randomness at all. The
 * cross-tab annotation lock and the GitHub mutation ownership token
 * deliberately keep requiring `randomUUID`, and say so where they demand it:
 * those identities are about ownership rather than uniqueness, and their
 * feature needs a secure context regardless.
 *
 * @module utils/opaque-id
 */

const HEX = [];
for (let value = 0; value < 256; value++) {
  HEX.push((value + 0x100).toString(16).slice(1));
}

/**
 * Mint a random v4 UUID, in or out of a secure context.
 *
 * @returns {string}
 */
export function createOpaqueId() {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new TypeError(
      'Opaque identifiers require crypto.getRandomValues(), which every '
      + 'supported browser exposes on both secure and non-secure origins'
    );
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  // Version 4, variant 1, exactly as randomUUID would set them.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return (
    HEX[bytes[0]] + HEX[bytes[1]] + HEX[bytes[2]] + HEX[bytes[3]] + '-'
    + HEX[bytes[4]] + HEX[bytes[5]] + '-'
    + HEX[bytes[6]] + HEX[bytes[7]] + '-'
    + HEX[bytes[8]] + HEX[bytes[9]] + '-'
    + HEX[bytes[10]] + HEX[bytes[11]] + HEX[bytes[12]]
    + HEX[bytes[13]] + HEX[bytes[14]] + HEX[bytes[15]]
  );
}
