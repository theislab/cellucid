/**
 * @fileoverview SHA-256 that does not require a secure context.
 *
 * `crypto.subtle` is secure-context only, and unlike `crypto.getRandomValues`
 * it has no non-secure counterpart: on a plain-HTTP origin `globalThis.crypto`
 * exists but `globalThis.crypto.subtle` is `undefined`. The Python package
 * supports binding to a non-loopback address deliberately, so the app is
 * reachable at `http://<lan-address>:<port>`, and there every `subtle.digest`
 * call fails with "undefined is not an object" at the moment the user acts —
 * which is what turned "apply this sample's published view" into an error
 * banner and left the dataset uncoloured.
 *
 * A published state's SHA-256 is an integrity check on a public artifact, not
 * a secret-dependent operation, so computing it in JavaScript is exactly as
 * correct as computing it in WebCrypto — the digest of a byte string is one
 * value. WebCrypto is still preferred where it exists, because it is native
 * code and this runs on the dataset-open path. Where it does not exist, the
 * answer is the same one computed here, rather than no answer at all.
 *
 * Sibling of `utils/opaque-id.js`, which does the same for `randomUUID`.
 *
 * @module utils/sha256
 */

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const HEX = [];
for (let value = 0; value < 256; value++) {
  HEX.push((value + 0x100).toString(16).slice(1));
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

/**
 * FIPS 180-4 SHA-256, computed in place over one padded message.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32 digest bytes.
 */
function digestBytes(bytes) {
  // One 0x80 byte, then zeros, then a 64-bit big-endian bit count, padded to a
  // whole number of 64-byte blocks. The two branches below are the same rule:
  // the tail needs 9 bytes of its own, so it takes one extra block when fewer
  // than 9 remain in the last partial one.
  const blockCount = Math.floor(bytes.length / 64) + (bytes.length % 64 < 56 ? 1 : 2);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  // Split rather than BigInt: the high word is only nonzero past 512 MB, and
  // every input here is bounded far below that, but a length field that is
  // wrong above some size is a hash that is wrong above some size.
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const state = INITIAL_STATE.slice();
  const schedule = new Uint32Array(64);
  for (let block = 0; block < blockCount; block++) {
    const base = block * 64;
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(base + index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const previous = schedule[index - 15];
      const recent = schedule[index - 2];
      const s0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const s1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 8; index++) {
    digestView.setUint32(index * 4, state[index], false);
  }
  return digest;
}

function toHex(digest) {
  let hex = '';
  for (let index = 0; index < digest.length; index++) hex += HEX[digest[index]];
  return hex;
}

/**
 * The lowercase hex SHA-256 of some bytes, in or out of a secure context.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} 64 lowercase hex characters.
 */
export async function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('SHA-256 input must be a Uint8Array.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  }
  return toHex(digestBytes(bytes));
}

/**
 * The same digest without WebCrypto, for the contract test that has to compare
 * the two implementations against each other on the same inputs.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256HexWithoutWebCrypto(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('SHA-256 input must be a Uint8Array.');
  }
  return toHex(digestBytes(bytes));
}
