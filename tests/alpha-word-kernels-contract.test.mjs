import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alphaEncodingWords,
  encodeAlphaSpan,
  firstNonBinaryByte,
  requirePointTransparency,
} from '../assets/js/rendering/alpha-visibility.js';

/**
 * The per-cell 0/1 byte kernels read four cells to a word. These tests hold
 * them to the byte-by-byte definition at every alignment, length and position
 * of a bad byte, so the word form can never answer differently.
 */

function byteFirstNonBinary(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 1) return i;
  return -1;
}

function byteEncode(alphas, target, reference, from, to) {
  let moved = 0;
  for (let i = from; i < to; i++) {
    if (alphas[i] > 1) return -(i + 1);
    const encoded = -alphas[i] & 255;
    moved |= encoded ^ reference[i];
    target[i] = encoded;
  }
  return moved !== 0 ? 1 : 0;
}

function pattern(length, seed) {
  const bytes = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes[i] = (x >>> 16) & 1;
  }
  return bytes;
}

test('firstNonBinaryByte equals the byte definition at every offset, length and bad position', () => {
  const backing = new Uint8Array(64 + 8);
  for (let offset = 0; offset < 4; offset++) {
    for (let length = 0; length <= 40; length++) {
      const view = backing.subarray(offset, offset + length);
      view.set(pattern(length, length * 7 + offset));
      assert.equal(firstNonBinaryByte(view), -1, `clean ${offset}/${length}`);
      for (let bad = 0; bad < length; bad++) {
        for (const value of [2, 3, 128, 255]) {
          const kept = view[bad];
          view[bad] = value;
          if (bad + 3 < length) view[bad + 3] = 7;
          assert.equal(firstNonBinaryByte(view), byteFirstNonBinary(view), `${offset}/${length}/${bad}/${value}`);
          assert.equal(firstNonBinaryByte(view), bad);
          view[bad] = kept;
          if (bad + 3 < length) view.set(pattern(length, length * 7 + offset));
        }
      }
    }
  }
});

test('requirePointTransparency names the first value above one', () => {
  const values = Uint8Array.from([1, 0, 1, 1, 0, 1, 4, 1, 9]);
  assert.throws(() => requirePointTransparency(values, values.length, 'T'), /T entry 6 must be exactly 0 or 1\./);
  values[6] = 1;
  values[8] = 1;
  assert.equal(requirePointTransparency(values, values.length, 'T'), values);
});

test('encodeAlphaSpan writes, compares and rejects exactly as byte by byte, with and without words', () => {
  for (const length of [0, 1, 3, 4, 5, 8, 13, 64, 67]) {
    const alphas = pattern(length, length + 1);
    for (const changeAt of [-1, 0, Math.floor(length / 2), length - 1]) {
      const reference = new Uint8Array(length + 4);
      for (let i = 0; i < length; i++) reference[i] = -alphas[i] & 255;
      if (changeAt >= 0 && changeAt < length) reference[changeAt] ^= 255;
      for (const [from, to] of [[0, length], [0, length & ~3], [length & ~3, length], [4, Math.max(4, length)]]) {
        if (from > to || to > length) continue;
        const expected = new Uint8Array(length + 4).fill(77);
        const actual = new Uint8Array(length + 4).fill(77);
        const want = byteEncode(alphas, expected, reference, from, to);
        const words = alphaEncodingWords(alphas, actual, reference);
        assert.ok(words !== null);
        assert.equal(encodeAlphaSpan(alphas, actual, reference, words, from, to), want, `${length}/${changeAt}/${from}-${to}`);
        assert.deepEqual(actual, expected);
        const bytewise = new Uint8Array(length + 4).fill(77);
        assert.equal(encodeAlphaSpan(alphas, bytewise, reference, null, from, to), want);
        assert.deepEqual(bytewise, expected);
      }
    }
    for (let bad = 0; bad < length; bad++) {
      const broken = alphas.slice();
      broken[bad] = 2;
      const target = new Uint8Array(length);
      const reference = new Uint8Array(length);
      const words = alphaEncodingWords(broken, target, reference);
      assert.equal(encodeAlphaSpan(broken, target, reference, words, 0, length), -(bad + 1));
      assert.equal(encodeAlphaSpan(broken, new Uint8Array(length), reference, null, 0, length), -(bad + 1));
    }
  }
});

test('one array may be both the target and the reference', () => {
  const alphas = pattern(37, 5);
  const same = new Uint8Array(40);
  for (let i = 0; i < 37; i++) same[i] = -alphas[i] & 255;
  assert.equal(encodeAlphaSpan(alphas, same, same, alphaEncodingWords(alphas, same, same), 0, 37), 0);
  same[20] ^= 255;
  assert.equal(encodeAlphaSpan(alphas, same, same, alphaEncodingWords(alphas, same, same), 0, 37), 1);
  assert.equal(same[20], -alphas[20] & 255);
});

test('word views are refused for an array that does not start on a word boundary', () => {
  const backing = new Uint8Array(16);
  assert.equal(alphaEncodingWords(backing.subarray(1, 9), new Uint8Array(8), new Uint8Array(8)), null);
  assert.equal(alphaEncodingWords(new Uint8Array(8), backing.subarray(2, 10), new Uint8Array(8)), null);
  assert.ok(alphaEncodingWords(new Uint8Array(8), new Uint8Array(8), backing.subarray(4, 12)) !== null);
});
