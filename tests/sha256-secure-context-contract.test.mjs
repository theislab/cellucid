/**
 * @fileoverview Applying an official sample's published view must work on the
 * origins the project supports serving from.
 *
 * `crypto.subtle` exists only in a secure context, and unlike
 * `crypto.getRandomValues` it has no non-secure counterpart: on a plain-HTTP
 * origin `globalThis.crypto` is present and `globalThis.crypto.subtle` is
 * `undefined`. The Python package supports binding to a non-loopback address on
 * purpose, so the app is reachable at `http://<lan-address>:<port>` — and there
 * the integrity check on a published default state threw "undefined is not an
 * object (evaluating 'globalThis.crypto.subtle.digest')" and the dataset opened
 * with none of its published colouring applied.
 *
 * Sibling of `opaque-id-secure-context-contract.test.mjs`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  sha256Hex,
  sha256HexWithoutWebCrypto,
} from '../assets/js/app/utils/sha256.js';

function withCrypto(replacement, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: replacement
  });
  try {
    return run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

/** Exactly what a browser presents over plain HTTP: crypto without subtle. */
const nonSecureCrypto = {
  getRandomValues: array => array
};

const encoder = new TextEncoder();

// The three published FIPS 180-4 vectors, so this test fails if the
// implementation is wrong rather than only if it is inconsistent.
const FIPS_VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  ],
];

test('the published digests are produced without a secure context', async () => {
  await withCrypto(nonSecureCrypto, async () => {
    assert.equal(
      globalThis.crypto.subtle,
      undefined,
      'the fixture must be the shape a plain-HTTP origin actually presents'
    );
    for (const [message, expected] of FIPS_VECTORS) {
      assert.equal(
        await sha256Hex(encoder.encode(message)),
        expected,
        `SHA-256 of ${JSON.stringify(message)} on a non-secure origin`
      );
    }
  });
});

test('crypto is allowed to be absent entirely', async () => {
  await withCrypto(undefined, async () => {
    assert.equal(
      await sha256Hex(encoder.encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

test('WebCrypto is still preferred when it exists', async () => {
  let reached = 0;
  await withCrypto(
    {
      subtle: {
        digest: async (algorithm, bytes) => {
          assert.equal(algorithm, 'SHA-256');
          reached += 1;
          return createHash('sha256').update(bytes).digest().buffer;
        }
      }
    },
    async () => {
      assert.equal(
        await sha256Hex(encoder.encode('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    }
  );
  assert.equal(reached, 1, 'a secure context must not fall back');
});

test('both implementations agree across every padding regime', () => {
  // A block is 64 bytes and the length field needs the last 8, so lengths 55,
  // 56 and 63 are where a padding mistake shows up and nowhere else. Sweeping
  // 0..200 covers all three boundaries in all three block counts.
  for (let length = 0; length <= 200; length++) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      bytes[index] = (index * 37 + 11) & 0xff;
    }
    assert.equal(
      sha256HexWithoutWebCrypto(bytes),
      createHash('sha256').update(bytes).digest('hex'),
      `SHA-256 of ${length} bytes`
    );
  }
});

test('a state at the published size bound hashes correctly', () => {
  // MAX_STATE_BYTES in session/dataset-state-manifest.js. The digest this
  // module exists to compute is taken over a payload of exactly this size at
  // most, so the largest one it will ever see is checked here.
  const bytes = new Uint8Array(32768);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (index * 251 + 7) & 0xff;
  }
  assert.equal(
    sha256HexWithoutWebCrypto(bytes),
    createHash('sha256').update(bytes).digest('hex')
  );
});

test('a view into a larger buffer hashes its own bytes only', () => {
  const backing = new Uint8Array(64).fill(0xff);
  backing.set(encoder.encode('abc'), 16);
  const view = backing.subarray(16, 19);
  assert.equal(
    sha256HexWithoutWebCrypto(view),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'a Uint8Array is its own length, not its buffer'
  );
});

test('a non-Uint8Array input is refused rather than hashed', async () => {
  await assert.rejects(
    () => sha256Hex('abc'),
    /SHA-256 input must be a Uint8Array/
  );
  assert.throws(
    () => sha256HexWithoutWebCrypto([1, 2, 3]),
    /SHA-256 input must be a Uint8Array/
  );
});
