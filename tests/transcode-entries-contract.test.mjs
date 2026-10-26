/**
 * Sparse entries in any order into one compressed matrix
 * (`assets/js/data/anndata/transcode/entries.js`), in memory and on the
 * origin-private file system (`helpers/opfs-on-disk.mjs`):
 *
 * - entries that arrive by cell are the `csr_matrix` as they are, and by
 *   feature the `csc_matrix`, with nothing read back;
 * - entries in any other order come out sorted by cell, then by feature,
 *   whatever the bucket size (one cell larger than a bucket included), with
 *   the same values;
 * - what the sort wrote along the way is given back: only the matrix's own
 *   payloads are left in the space;
 * - an entry outside the matrix, and a count that is not the declared one,
 *   fail.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EntryCollector } from '../assets/js/data/anndata/transcode/entries.js';
import { TRANSCODED_DIRECTORY, openTranscodeSpace } from '../assets/js/data/anndata/transcode/space.js';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';

/** A deterministic random generator (mulberry32). */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distinct entries of an nCells × nFeatures matrix, one cell much fuller than the rest. */
function entriesOf(nCells, nFeatures, seed) {
  const next = random(seed);
  const entries = [];
  for (let cell = 0; cell < nCells; cell++) {
    const full = cell === 3;
    for (let feature = 0; feature < nFeatures; feature++) {
      if (full || next() < 0.3) entries.push({ cell, feature, value: Math.fround(1 + next() * 100) });
    }
  }
  return entries;
}

async function partOf(space, part, Type) {
  if (part.values) return part.values;
  const bytes = await space.read(part.region);
  return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

/** Every entry of a compressed matrix as `{cell, feature, value}`, in stored order. */
async function storedEntries(space, matrix) {
  const indptr = await partOf(space, matrix.indptr, matrix.indptr.values?.constructor ?? Int32Array);
  const indices = await partOf(space, matrix.indices, Int32Array);
  const data = await partOf(space, matrix.data, matrix.data.dtype === '<f8' ? Float64Array : Float32Array);
  const out = [];
  for (let major = 0; major + 1 < indptr.length; major++) {
    for (let k = indptr[major]; k < indptr[major + 1]; k++) {
      out.push(matrix.format === 'csr'
        ? { cell: major, feature: indices[k], value: data[k] }
        : { cell: indices[k], feature: major, value: data[k] });
    }
  }
  return out;
}

const byCell = (a, b) => a.cell - b.cell || a.feature - b.feature;
const byFeature = (a, b) => a.feature - b.feature || a.cell - b.cell;

for (const where of ['memory', 'opfs']) {
  test(`entries in any order become one matrix sorted by cell (${where})`, async t => {
    const disk = opfsOnDisk();
    t.after(disk.cleanup);
    const nCells = 40;
    const nFeatures = 25;
    const entries = entriesOf(nCells, nFeatures, 7);
    const next = random(11);
    const shuffled = entries.map(entry => ({ entry, key: next() })).sort((a, b) => a.key - b.key).map(item => item.entry);
    for (const blockEntries of [7, 64, 1 << 22]) {
      const space = await openTranscodeSpace({ kind: 'file', name: `entries-${blockEntries}` }, { environment: disk.environment, memory: where === 'memory' });
      const collector = await EntryCollector.open(space, { nCells, nFeatures, entries: shuffled.length, blockEntries });
      for (const { cell, feature, value } of shuffled) collector.add(cell, feature, value);
      const matrix = await collector.finish();
      assert.equal(matrix.format, 'csr');
      assert.deepEqual(matrix.shape, [nCells, nFeatures]);
      assert.deepEqual(await storedEntries(space, matrix), [...entries].sort(byCell), `bucket of ${blockEntries}`);
      if (where === 'opfs') {
        const used = new Set([matrix.indices.region.store, matrix.data.region.store]);
        const left = readdirSync(path.join(disk.root, TRANSCODED_DIRECTORY, space.directory)).filter(name => name.startsWith('p'));
        assert.deepEqual(left.sort(), [...used].sort(), 'what the sort wrote along the way is given back');
      }
      await space.discard();
    }
  });
}

test('entries that arrive by cell or by feature are kept as they arrived, with nothing read back', async () => {
  const nCells = 30;
  const nFeatures = 12;
  const entries = entriesOf(nCells, nFeatures, 3);
  for (const [order, format] of [[byCell, 'csr'], [byFeature, 'csc']]) {
    const space = await openTranscodeSpace(null, { memory: true });
    let reads = 0;
    const read = space.read.bind(space);
    const collector = await EntryCollector.open(space, { nCells, nFeatures, entries: entries.length, Values: Float64Array });
    for (const { cell, feature, value } of [...entries].sort(order)) collector.add(cell, feature, value);
    space.read = region => {
      reads++;
      return read(region);
    };
    const matrix = await collector.finish();
    assert.equal(reads, 0, `${format}: nothing read back`);
    assert.equal(matrix.format, format);
    assert.equal(matrix.data.dtype, '<f8');
    space.read = read;
    assert.deepEqual((await storedEntries(space, matrix)).sort(byCell), [...entries].sort(byCell));
  }
});

test('entries handed over in blocks make the same matrix, byte for byte, as entries one by one', async () => {
  const nCells = 40;
  const nFeatures = 25;
  const entries = entriesOf(nCells, nFeatures, 5);
  const next = random(13);
  const shuffled = entries.map(entry => ({ entry, key: next() })).sort((a, b) => a.key - b.key).map(item => item.entry);
  const bytesOf = async (space, matrix) => Promise.all([matrix.indices, matrix.data].map(part => space.read(part.region)));
  const sorted = [...entries].sort(byCell);
  const lateBreak = [...sorted.slice(0, 200), ...shuffled.filter(entry => !sorted.slice(0, 200).includes(entry))];
  const diagonal = Array.from({ length: 20 }, (_, k) => ({ cell: k, feature: k, value: k + 0.5 }));
  for (const [label, arrival] of [['by cell', sorted], ['by feature', [...entries].sort(byFeature)], ['shuffled', shuffled],
    ['by cell, then in any order', lateBreak], ['by cell and by feature at once', diagonal]]) {
    const oneSpace = await openTranscodeSpace(null, { memory: true });
    const one = await EntryCollector.open(oneSpace, { nCells, nFeatures, entries: arrival.length, blockEntries: 64 });
    for (const { cell, feature, value } of arrival) one.add(cell, feature, value);
    const expected = await one.finish();
    // Blocks of every size from one entry to more than the stage holds.
    for (const size of [1, 3, 50, arrival.length, 1 << 15]) {
      const space = await openTranscodeSpace(null, { memory: true });
      const collector = await EntryCollector.open(space, { nCells, nFeatures, entries: arrival.length, blockEntries: 64 });
      for (let from = 0; from < arrival.length; from += size) {
        const part = arrival.slice(from, from + size);
        // Arrays longer than their count: only the count is taken.
        const cells = new Int32Array(part.length + 2);
        const features = new Int32Array(part.length + 2);
        const values = new Float32Array(part.length + 2);
        part.forEach((entry, k) => {
          cells[k] = entry.cell;
          features[k] = entry.feature;
          values[k] = entry.value;
        });
        collector.addBatch(cells, features, values, part.length);
      }
      const matrix = await collector.finish();
      assert.equal(matrix.format, expected.format, `${label}, blocks of ${size}`);
      assert.deepEqual(matrix.indptr.values, expected.indptr.values, `${label}, blocks of ${size}`);
      assert.deepEqual(await bytesOf(space, matrix), await bytesOf(oneSpace, expected), `${label}, blocks of ${size}`);
      assert.deepEqual((await storedEntries(space, matrix)).sort(byCell), [...arrival].sort(byCell), `${label}, blocks of ${size}`);
    }
    assert.deepEqual((await storedEntries(oneSpace, expected)).sort(byCell), [...arrival].sort(byCell), `${label}, one by one`);
  }
  const space = await openTranscodeSpace(null, { memory: true });
  const collector = await EntryCollector.open(space, { nCells: 2, nFeatures: 2, entries: 2 });
  assert.throws(() => collector.addBatch(Int32Array.of(0, 2), Int32Array.of(0, 0), Float32Array.of(1, 1), 2), RangeError);
  assert.throws(() => collector.addBatch(Int32Array.of(0), Int32Array.of(0), Float64Array.of(1), 1), TypeError);
  assert.throws(() => collector.addBatch(Int32Array.of(0), Int32Array.of(0), Float32Array.of(1), 2), TypeError);
});

test('an entry outside the matrix, and a count other than the declared one, fail', async () => {
  const space = await openTranscodeSpace(null, { memory: true });
  const collector = await EntryCollector.open(space, { nCells: 2, nFeatures: 2, entries: 2 });
  assert.throws(() => collector.add(2, 0, 1), RangeError);
  assert.throws(() => collector.add(0, -1, 1), RangeError);
  collector.add(0, 0, 1);
  await assert.rejects(collector.finish(), /declared 2 entries and 1 arrived/);
});

test('pieces of a split R matrix assemble into one matrix by cell, block by block', async () => {
  const { assembleColumns } = await import('../assets/js/data/anndata/transcode/r-matrices.js');
  // A dgCMatrix piece (features × its cells) as parsed nodes held in memory.
  const piece = (columns, cells, features = null) => {
    const p = [0];
    const i = [];
    const x = [];
    for (const column of columns) {
      for (const [row, value] of column) {
        i.push(row);
        x.push(value);
      }
      p.push(i.length);
    }
    const node = (kind, values) => ({ kind, length: values.length, values: kind === 'integer' ? Int32Array.from(values) : Float64Array.from(values), region: null, sequence: null });
    return { matrix: { p: node('integer', p), i: node('integer', i), x: node('double', x) }, cells: Int32Array.from(cells), features: features === null ? null : Int32Array.from(features) };
  };
  const nCells = 6;
  const nFeatures = 4;
  // Split by group: cells 0, 2, 4 in one piece, 1, 3, 5 in the other; the
  // second covers features 3 and 1 only (remapped), and cell 5 is also in a
  // third piece over feature 0.
  const pieces = [
    piece([[[0, 1], [2, 2]], [[1, 3]], [[3, 4]]], [0, 2, 4]),
    piece([[[0, 5]], [[1, 6], [0, 7]], [[0, 8]]], [1, 3, 5], [3, 1]),
    piece([[[0, 9]]], [5], [0]),
  ];
  const expected = [
    [0, 0, 1], [0, 2, 2], [1, 3, 5], [2, 1, 3], [3, 1, 6], [3, 3, 7], [4, 3, 4], [5, 0, 9], [5, 3, 8],
  ].map(([cell, feature, value]) => ({ cell, feature, value }));
  for (const blockEntries of [1, 2, 3, 1 << 22]) {
    const space = await openTranscodeSpace(null, { memory: true });
    const matrix = await assembleColumns(pieces, nCells, nFeatures, { space, readRegion: region => space.read(region) }, { blockEntries });
    assert.equal(matrix.format, 'csr');
    assert.deepEqual(await storedEntries(space, matrix), expected, `blocks of ${blockEntries}`);
  }
  // Pieces whose cells do not rise are collected by cell.
  const space = await openTranscodeSpace(null, { memory: true });
  const falling = [piece([[[0, 1]], [[1, 2]]], [3, 0]), piece([[[2, 3]]], [1])];
  const matrix = await assembleColumns(falling, 4, 3, { space, readRegion: region => space.read(region) });
  assert.deepEqual((await storedEntries(space, matrix)).sort(byCell), [
    { cell: 0, feature: 1, value: 2 }, { cell: 1, feature: 2, value: 3 }, { cell: 3, feature: 0, value: 1 },
  ]);
});
