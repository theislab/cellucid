import assert from 'node:assert/strict';
import test from 'node:test';

import {
  firstNonBinaryByte,
  requirePointTransparency,
} from '../assets/js/rendering/alpha-visibility.js';

/**
 * The per-cell 0/1 byte check reads four cells to a word. These tests hold
 * it to the byte-by-byte definition at every alignment, length and position
 * of a bad byte, so the word form can never answer differently.
 */

function byteFirstNonBinary(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 1) return i;
  return -1;
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
