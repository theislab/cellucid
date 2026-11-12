/**
 * @fileoverview The tab secret: what pairs this browser with the Cellucid
 * relay, so Claude and ChatGPT reach the person's open tab without an
 * account.
 *
 * 32 random bytes (base64url), made the first time the person connects an
 * agent and kept in this browser's localStorage, so every Cellucid tab of
 * this browser profile shares one pairing and it survives a reload. The relay
 * derives the pairing from it with its own key and keeps nothing that could
 * reveal it. **Forget** (`forgetTabSecret`) deletes it: every agent
 * connection made through it stops working, and the next connection makes a
 * new one. Nothing else in the app reads or writes this key.
 *
 * @module app/agent/bridge/tab-secret
 */

import { TAB_SECRET_BYTES, TAB_SECRET_PATTERN } from './relay-protocol.js';
import { webStorage } from '../../../utils/web-storage.js';
import { base64UrlOfBytes } from '../../../utils/byte-text.js';

export const TAB_SECRET_STORAGE_KEY = 'cellucid:agent-relay:tab-secret';

/** This browser keeps no data for the site, so a pairing cannot be kept. */
export class TabSecretError extends Error {
  constructor(cause) {
    super(
      'This browser keeps no data for Cellucid (private browsing, or site data blocked), '
      + 'so it cannot stay connected to Claude or ChatGPT. Allow site data for Cellucid and try again.',
      { cause },
    );
    this.name = 'TabSecretError';
  }
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  const kept = webStorage('localStorage');
  if (kept === null) throw new TabSecretError(new Error('This browser keeps no localStorage for this site.'));
  return kept;
}


/**
 * The tab secret this browser keeps, or null when it keeps none (never
 * paired, or forgotten). A stored value that is not a secret (edited by hand)
 * counts as none.
 *
 * @param {{storage?: Storage}} [options]
 * @returns {string|null}
 */
export function readTabSecret({ storage } = {}) {
  let value;
  try {
    value = storageOf(storage).getItem(TAB_SECRET_STORAGE_KEY);
  } catch (cause) {
    throw new TabSecretError(cause);
  }
  return typeof value === 'string' && TAB_SECRET_PATTERN.test(value) ? value : null;
}

/**
 * The tab secret, made and kept now when there is none.
 *
 * @param {{storage?: Storage, random?: (bytes: Uint8Array) => Uint8Array}} [options]
 * @returns {string}
 */
export function ensureTabSecret({ storage, random = bytes => crypto.getRandomValues(bytes) } = {}) {
  const existing = readTabSecret({ storage });
  if (existing !== null) return existing;
  const secret = base64UrlOfBytes(random(new Uint8Array(TAB_SECRET_BYTES)));
  try {
    storageOf(storage).setItem(TAB_SECRET_STORAGE_KEY, secret);
  } catch (cause) {
    throw new TabSecretError(cause);
  }
  return secret;
}

/**
 * Forget the pairing in this browser. Call it after the relay was told to
 * forget (`relay-client.js` `forget()`), so connections made through it are
 * revoked there too; without the relay, they stop working anyway once no tab
 * can prove the secret.
 *
 * @param {{storage?: Storage}} [options]
 */
export function forgetTabSecret({ storage } = {}) {
  try {
    storageOf(storage).removeItem(TAB_SECRET_STORAGE_KEY);
  } catch (cause) {
    throw new TabSecretError(cause);
  }
}
