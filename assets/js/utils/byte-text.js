/**
 * @fileoverview Bytes written as text, and read back: lowercase hex (digests,
 * sign-in states, opaque ids), base64 (pictures, kept stores, cell records,
 * GitHub contents, Zarr fill values) and base64url (PKCE, share ids, tab
 * secrets). The one place bytes become text in either alphabet; a color as
 * `#rrggbb` is `hex-color.js`'s.
 *
 * @module utils/byte-text
 */

/** Each byte's two lowercase hex digits. */
const HEX = Array.from({ length: 256 }, (_unused, byte) => byte.toString(16).padStart(2, '0'));

/**
 * Bytes at a time handed to `String.fromCharCode`: a longer argument list
 * overflows the call stack on some engines.
 */
const CHAR_CODE_PIECE = 0x8000;

/**
 * Bytes as lowercase hex, two digits each.
 * @param {ArrayLike<number>} bytes - Bytes (a `Uint8Array`, or integers 0–255).
 * @returns {string}
 */
export function hexOfByteArray(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index++) {
    const digits = HEX[bytes[index]];
    if (digits === undefined) {
      throw new TypeError(`A byte must be an integer from 0 through 255, not ${bytes[index]}.`);
    }
    text += digits;
  }
  return text;
}

/**
 * `byteCount` random bytes (`crypto.getRandomValues`, in or out of a secure
 * context) as lowercase hex: `2 × byteCount` digits.
 * @param {number} byteCount
 * @returns {string}
 */
export function randomHex(byteCount) {
  return hexOfByteArray(randomBytes(byteCount));
}

/**
 * `byteCount` random bytes from `crypto.getRandomValues`, which every
 * supported browser and worker runtime has on secure and plain-HTTP origins.
 * @param {number} byteCount
 * @returns {Uint8Array}
 */
export function randomBytes(byteCount) {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new TypeError('Random bytes need crypto.getRandomValues(), which this browser does not have.');
  }
  return source.getRandomValues(new Uint8Array(byteCount));
}

/** Bytes as a binary string (one character per byte), in pieces. */
function binaryOf(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHAR_CODE_PIECE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + CHAR_CODE_PIECE));
  }
  return binary;
}

/**
 * Bytes as base64 (RFC 4648 §4, padded).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64OfBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Base64 input must be a Uint8Array.');
  return btoa(binaryOf(bytes));
}

/**
 * Base64 text as bytes. Padding may be left out (base64's forgiving decode,
 * as `atob` reads it); anything else that is not base64 throws `atob`'s
 * `InvalidCharacterError`.
 * @param {string} text
 * @param {(length: number) => Uint8Array} [allocate] - Where the bytes go:
 *   a caller that accounts large allocations passes its own.
 * @returns {Uint8Array}
 */
export function bytesOfBase64(text, allocate = length => new Uint8Array(length)) {
  const binary = atob(text);
  const bytes = allocate(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Bytes as base64url (RFC 4648 §5, no padding).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64UrlOfBytes(bytes) {
  return base64OfBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url text (padded or not) as bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function bytesOfBase64Url(text) {
  return bytesOfBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
}
