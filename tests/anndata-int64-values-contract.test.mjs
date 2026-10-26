/**
 * 64-bit integer arrays (a 10x `.h5`'s int64 indices, anndata's int64
 * index pointers) are converted through their 32-bit words, not a BigInt
 * per element (`data/anndata/values.js`). The numbers must be the ones
 * `Number()` of each BigInt gives, and the refusals the same: an index
 * outside int32, a pointer outside the safe integer range.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readIntegers, writeFloat32, writeInt32 } from '../assets/js/data/anndata/values.js';

const SIGNED = [0n, 1n, -1n, 2147483647n, -2147483648n, 4294967295n, 4294967296n, -4294967297n,
  123456789012345n, 9007199254740991n, -9007199254740991n, 9007199254740993n,
  -9223372036854775808n, 9223372036854775807n];
const UNSIGNED = [0n, 1n, 4294967295n, 4294967296n, 9007199254740991n, 18446744073709551615n];

test('64-bit integers become the float32 Number() rounds them to', () => {
  const signed = new Float32Array(SIGNED.length);
  writeFloat32(BigInt64Array.from(SIGNED), signed, 0);
  assert.deepEqual([...signed], SIGNED.map(value => Math.fround(Number(value))));
  const unsigned = new Float32Array(UNSIGNED.length + 2);
  writeFloat32(BigUint64Array.from(UNSIGNED), unsigned, 2);
  assert.deepEqual([...unsigned.subarray(2)], UNSIGNED.map(value => Math.fround(Number(value))));
});

test('64-bit indices within int32 are kept exactly, and one outside is refused by its value', () => {
  const output = new Int32Array(4);
  writeInt32(BigInt64Array.from([5n, -2147483648n, 2147483647n, 0n]), output, 0, 'X/indices');
  assert.deepEqual([...output], [5, -2147483648, 2147483647, 0]);
  assert.throws(() => writeInt32(BigInt64Array.from([1n, 2147483648n]), new Int32Array(2), 0, 'X/indices'),
    /X\/indices 2147483648 is outside the Int32 range/);
  assert.throws(() => writeInt32(BigUint64Array.from([18446744073709551615n]), new Int32Array(1), 0, 'X/indices'),
    /X\/indices 18446744073709551615 is outside the Int32 range/);
});

test('64-bit pointers are exact numbers, and one past the safe range is refused by its value', async () => {
  const array = (values) => ({
    shape: [values.length],
    dtype: { kind: 'int', bytes: 8 },
    chunks: [values.length],
    read: async ([[start, end]]) => values.subarray(start, end),
  });
  const safe = BigInt64Array.from([0n, 4294967296n, 9007199254740991n, -9007199254740991n]);
  assert.deepEqual([...await readIntegers(array(safe), 0, 4, 'X/indptr')], [0, 4294967296, 9007199254740991, -9007199254740991]);
  await assert.rejects(readIntegers(array(BigInt64Array.from([0n, 9007199254740992n])), 0, 2, 'X/indptr'),
    /X\/indptr 9007199254740992 is outside the safe integer range/);
});
