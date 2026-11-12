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

import { hexOfByteArray, randomBytes } from './byte-text.js';

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
  const bytes = randomBytes(16);
  // Version 4, variant 1, exactly as randomUUID would set them.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = hexOfByteArray(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
