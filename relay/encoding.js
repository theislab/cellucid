/**
 * Bytes and text for the relay: base64url, hex, random values, SHA-256 and
 * a comparison whose time does not depend on where two secrets differ.
 */

export const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const CHUNK = 0x8000;

/** @param {Uint8Array} bytes */
export function base64UrlOf(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The bytes of unpadded base64url `text`, or null when it is not that. */
export function bytesOfBase64Url(text) {
  if (typeof text !== 'string' || !BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  // Only the canonical spelling of these bytes is accepted (no stray low bits).
  return base64UrlOf(bytes) === text ? bytes : null;
}

/** UTF-8 text of `bytes`, or null when they are not UTF-8. */
export function textOf(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** @param {Uint8Array} bytes */
export function hexOf(bytes) {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** `count` random bytes as base64url. */
export function randomBase64Url(count = 32) {
  return base64UrlOf(crypto.getRandomValues(new Uint8Array(count)));
}

/** SHA-256 of UTF-8 `text`, as base64url. */
export async function sha256Base64Url(text) {
  return base64UrlOf(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

/** Whether two strings are equal, in a time that depends only on their lengths. */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index % (a.length || 1)) || 0) ^ (b.charCodeAt(index % (b.length || 1)) || 0);
  }
  return difference === 0;
}
