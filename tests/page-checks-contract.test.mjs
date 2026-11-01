/**
 * One integrity mechanism for every copy of a file's bytes kept in this
 * browser (`formats/io/page-checks.js`): a converted store's files and a
 * file downloaded whole are checked page by page, a kept gene index gene by
 * gene, all with the same streaming CRC-32. The consumers' own tests check
 * each copy end to end (`transcode-cache-contract`, `kept-column-index-contract`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECK_PAGE_BYTES, KeptCopyDamage, PageChecksums, PieceChecksums, checkedRead, checksumBytes, checksumOf,
  checksumsFit, checksumsFromBytes, matchesChecksum, pageChecksumsOf,
} from '../assets/js/formats/io/page-checks.js';
import { crc32 } from '../assets/js/formats/zip/crc32.js';

const bytesOf = length => Uint8Array.from({ length }, (_, i) => (i * 131 + (i >>> 8)) & 0xff);

/** The bytes as pieces of the given sizes (how a stream hands them over). */
function* piecesOf(bytes, sizes) {
  let at = 0;
  for (let i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length];
    yield bytes.subarray(at, at + size);
    at += size;
  }
}

test('page checksums are the same however the bytes arrive, one a page, the last for the bytes it holds', () => {
  for (const length of [0, 1, CHECK_PAGE_BYTES - 1, CHECK_PAGE_BYTES, CHECK_PAGE_BYTES + 1, 5 * CHECK_PAGE_BYTES + 77]) {
    const bytes = bytesOf(length);
    const expected = Uint32Array.from({ length: Math.ceil(length / CHECK_PAGE_BYTES) },
      (_, page) => crc32(bytes.subarray(page * CHECK_PAGE_BYTES, (page + 1) * CHECK_PAGE_BYTES)));
    assert.deepEqual(pageChecksumsOf(bytes), expected, `${length} bytes whole`);
    for (const sizes of [[1], [7, 4093], [CHECK_PAGE_BYTES], [3 * CHECK_PAGE_BYTES + 5]]) {
      const sums = new PageChecksums();
      for (const piece of piecesOf(bytes, sizes)) sums.add(piece);
      assert.deepEqual(sums.finish(), expected, `${length} bytes in pieces of ${sizes}`);
    }
    assert.ok(checksumsFit(expected, length));
    assert.deepEqual(checksumsFromBytes(checksumBytes(expected)), expected, 'stored and read back');
  }
  assert.equal(checksumsFromBytes(new Uint8Array(5)), null, 'not a table');
});

test('piece checksums follow given ends: a gene with no bytes has the empty checksum, and more bytes than pieces is refused', () => {
  const ends = [3, 3, 10, 10, 25];
  const bytes = bytesOf(25);
  const sums = new PieceChecksums(i => ends[i], ends.length);
  for (const piece of piecesOf(bytes, [4, 1, 9])) sums.add(piece);
  const starts = [0, ...ends];
  assert.deepEqual(sums.finish(), Uint32Array.from(ends, (end, i) => crc32(bytes.subarray(starts[i], end))));
  const over = new PieceChecksums(i => ends[i], ends.length);
  assert.throws(() => over.add(bytesOf(26)), /more bytes were written than their pieces hold/i);
  assert.equal(checksumOf(bytes), crc32(bytes));
  assert.equal(checksumOf(bytes.subarray(10), checksumOf(bytes.subarray(0, 10))), crc32(bytes), 'continued');
  assert.ok(matchesChecksum(bytes, crc32(bytes)));
});

test('a checked read reads the whole pages it touches, returns exactly what was asked, and fails damaged pages as damage', async () => {
  const bytes = bytesOf(4 * CHECK_PAGE_BYTES + 999);
  const sums = pageChecksumsOf(bytes);
  const asked = [];
  const stored = bytes.slice();
  const read = async (offset, length) => {
    asked.push([offset, length]);
    return stored.slice(offset, offset + length);
  };
  const damages = [];
  const checked = checkedRead(read, { size: bytes.length, sums, label: 'The copy of a.h5ad', onDamage: error => damages.push(error) });
  for (const [offset, length] of [[0, 1], [CHECK_PAGE_BYTES - 1, 2], [10, 3 * CHECK_PAGE_BYTES], [bytes.length - 5, 5], [0, bytes.length]]) {
    asked.length = 0;
    assert.deepEqual(await checked(offset, length), bytes.subarray(offset, offset + length));
    const [[start, span]] = asked;
    assert.equal(start % CHECK_PAGE_BYTES, 0, 'from a page start');
    assert.ok(start + span === bytes.length || (start + span) % CHECK_PAGE_BYTES === 0, 'to a page end');
    assert.ok(span - length < 2 * CHECK_PAGE_BYTES, 'at most a page more on each side');
  }
  assert.deepEqual(await checked(7, 0), new Uint8Array(0));
  stored[2 * CHECK_PAGE_BYTES + 17] ^= 1;
  assert.deepEqual(await checked(0, 100), bytes.subarray(0, 100), 'other pages still read');
  await assert.rejects(checked(2 * CHECK_PAGE_BYTES, 1), error => error instanceof KeptCopyDamage && error.page === 2
    && /^The copy of a\.h5ad kept in this browser is damaged/.test(error.message));
  assert.equal(damages.length, 1, 'told once per failed read');
  assert.throws(() => checkedRead(read, { size: bytes.length + CHECK_PAGE_BYTES, sums, label: 'x' }), /do not cover/);
});

test('a checked read of a copy that came back short is damage, even when it ends on a page boundary', async () => {
  const bytes = bytesOf(4 * CHECK_PAGE_BYTES + 999);
  const sums = pageChecksumsOf(bytes);
  for (const kept of [2 * CHECK_PAGE_BYTES, 3 * CHECK_PAGE_BYTES + 10]) {
    // The copy now holds only its first `kept` bytes: a read returns what is left.
    const read = async (offset, length) => bytes.slice(offset, Math.min(kept, offset + length));
    const damages = [];
    const checked = checkedRead(read, { size: bytes.length, sums, label: 'The copy of a.h5ad', onDamage: error => damages.push(error) });
    assert.deepEqual(await checked(0, 100), bytes.subarray(0, 100), 'pages still held read');
    await assert.rejects(checked(CHECK_PAGE_BYTES, 3 * CHECK_PAGE_BYTES), error => error instanceof KeptCopyDamage
      && error.page === Math.floor(kept / CHECK_PAGE_BYTES), `cut at ${kept}`);
    await assert.rejects(checked(0, bytes.length), KeptCopyDamage);
    assert.equal(damages.length, 2);
  }
});
