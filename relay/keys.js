/**
 * The relay's keys and its signed values.
 *
 * One secret (`RELAY_SIGNING_KEY`) gives a separate HMAC-SHA-256 key per use
 * (HMAC of the secret over a label), so a value signed for one use is never
 * accepted for another:
 *
 * - `pairing`: the pairing id of a tab secret, HMAC(key, tab secret). The
 *   relay keeps no tab secret and no list of pairings; a tab that proves its
 *   secret finds its pairing again, and nobody else can.
 * - `client`: a client registered by Dynamic Client Registration is its own
 *   client id, signed (`cd1.`); nothing is stored per client.
 * - `access`, `refresh`: tokens (`at1.`, `rt1.`), each carrying who it was
 *   issued to and until when. An access token is checked by its signature
 *   alone; a refresh token also by its connection's rotation count, kept by
 *   the pairing (`pairing.js`), so a used one never works twice.
 *
 * A signed value is `<prefix>.<base64url JSON>.<base64url HMAC>`; the HMAC
 * covers the prefix and the payload.
 */

import { base64UrlOf, bytesOfBase64Url, encoder, hexOf, textOf } from './encoding.js';

const PURPOSES = Object.freeze(['pairing', 'client', 'access', 'refresh']);
let cached = null;

async function derive(master, purpose) {
  const raw = await crypto.subtle.sign('HMAC', master, encoder.encode(`cellucid-relay/1/${purpose}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * The per-use keys of `secret` (computed once per secret).
 * @param {string} secret
 * @returns {Promise<Record<'pairing'|'client'|'access'|'refresh', CryptoKey>>}
 */
export function relayKeys(secret) {
  if (cached?.secret !== secret) {
    const keys = (async () => {
      const master = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const derived = await Promise.all(PURPOSES.map(purpose => derive(master, purpose)));
      return Object.freeze(Object.fromEntries(PURPOSES.map((purpose, index) => [purpose, derived[index]])));
    })();
    cached = { secret, keys };
  }
  return cached.keys;
}

/**
 * Sign `payload` as a `<prefix>.` value.
 * @param {CryptoKey} key
 * @param {string} prefix
 * @param {object} payload
 */
export async function seal(key, prefix, payload) {
  const body = `${prefix}.${base64UrlOf(encoder.encode(JSON.stringify(payload)))}`;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `${body}.${base64UrlOf(mac)}`;
}

/**
 * The payload of a `<prefix>.` value signed with `key`, or null when it is
 * not one (another prefix, a changed byte, another key).
 * @param {CryptoKey} key
 * @param {string} prefix
 * @param {unknown} value
 */
export async function unseal(key, prefix, value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const mac = bytesOfBase64Url(parts[2]);
  const payloadBytes = bytesOfBase64Url(parts[1]);
  if (mac === null || payloadBytes === null) return null;
  const valid = await crypto.subtle.verify('HMAC', key, mac, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;
  const text = textOf(payloadBytes);
  if (text === null) return null;
  try {
    const payload = JSON.parse(text);
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The pairing id of a tab secret: 64 hex digits.
 * @param {Record<string, CryptoKey>} keys
 * @param {string} tabSecret
 */
export async function pairingIdOf(keys, tabSecret) {
  return hexOf(new Uint8Array(await crypto.subtle.sign('HMAC', keys.pairing, encoder.encode(tabSecret))));
}
