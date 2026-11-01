/**
 * Reading genes of a small share of a large cell-major (CSR) matrix holds
 * memory in proportion to the kept cells' entries and the bounded caches,
 * never to the file: its stored entries, its chunks, or its cells.
 *
 * The atlas here is virtual (2M cells, 400M stored entries, CELLxGENE HLCA's
 * chunking: `indices` int64 in chunks of 8,573, `data` float32 in chunks of
 * 17,145, `indptr` in chunks of 1,251, each chunk deflated): its chunks are
 * made as they are asked for, so the file is never held. A 3,400-cell
 * blocks subsample is opened over a link slower than a disk (values read per
 * gene) and two genes are read, as a person colours by a gene and then
 * another. While they are read, the process's JavaScript heap and
 * ArrayBuffer bytes are sampled: their peak growth must stay within the kept
 * entries' worth and the decoded-chunk budget, whatever the file's size.
 *
 * Regression: a segment of the subsample's matrix (`rowRangeMatrix`) is a
 * gather of the subsample's gathered `indices` and `data`; read through the
 * inner gather's estimated chunks (a few kept rows each), every slab became
 * tens of thousands of reads at once, which held about 1 KB each for every
 * stored chunk of the file (HLCA: gigabytes for 20 MB of entries). A gather
 * of a gather is now one gather of the stored array (`composedRuns`).
 *
 * The lookups a cell subset reads through hold its cells, not every row of
 * the file: an induced `obsp` graph's (`KeptPositions`) and a gene-major
 * matrix's cell subset (`keepSubsetEntries` over the subset's rows
 * ascending), each checked against a lookup of every row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { annData, array, dataFrame, group, strings, zarrEntries } from './helpers/anndata-store.mjs';
import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { KeptPositions, composedRuns, gatheredArray } from '../assets/js/data/anndata/views/cell-subset.js';
import { keepSubsetEntries } from '../assets/js/data/anndata/subset-entries.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { rowRangeMatrix } from '../assets/js/data/anndata/prefix-column-index.js';

const N_OBS = 2_000_000;
const PER_ROW = 200;
const N_VARS = 50_000;
const NNZ = N_OBS * PER_ROW;
const CHUNKS = { indptr: 1251, indices: 8573, data: 17145, names: 5000 };
const KEPT_CELLS = 3400;
const DECODED_CHUNK_BYTES = 8 * 1024 * 1024;

/** Gene of stored entry `e` (ascending within its row) and its value. */
const geneOf = e => {
  const row = Math.floor(e / PER_ROW);
  return ((e - row * PER_ROW) * 250 + (row % 250)) % N_VARS;
};
const valueOf = e => 1 + (Math.floor(e / PER_ROW) % 5);

/** One chunk of the virtual atlas's large arrays, deflated, or null for another key. */
function virtualChunk(key) {
  const match = /^(X\/(data|indices|indptr)|obs\/_index)\/(\d+)$/.exec(key);
  if (match === null) return null;
  const c = Number(match[3]);
  let raw;
  if (match[1] === 'obs/_index') {
    const encoder = new TextEncoder();
    const names = [];
    for (let i = c * CHUNKS.names; i < (c + 1) * CHUNKS.names; i++) names.push(encoder.encode(i < N_OBS ? `c${i}` : ''));
    raw = new Uint8Array(4 + names.reduce((sum, name) => sum + 4 + name.length, 0));
    const view = new DataView(raw.buffer);
    view.setUint32(0, names.length, true);
    let at = 4;
    for (const name of names) {
      view.setUint32(at, name.length, true);
      raw.set(name, at + 4);
      at += 4 + name.length;
    }
  } else if (match[2] === 'indptr') {
    const values = new BigInt64Array(CHUNKS.indptr);
    for (let i = 0; i < values.length; i++) values[i] = BigInt(Math.min(N_OBS, c * CHUNKS.indptr + i) * PER_ROW);
    raw = new Uint8Array(values.buffer);
  } else if (match[2] === 'indices') {
    const values = new BigInt64Array(CHUNKS.indices);
    for (let i = 0; i < values.length; i++) {
      const e = c * CHUNKS.indices + i;
      values[i] = e < NNZ ? BigInt(geneOf(e)) : 0n;
    }
    raw = new Uint8Array(values.buffer);
  } else {
    const values = new Float32Array(CHUNKS.data);
    for (let i = 0; i < values.length; i++) values[i] = valueOf(c * CHUNKS.data + i);
    raw = new Uint8Array(values.buffer);
  }
  return new Uint8Array(deflateSync(raw, { level: 1 }));
}

/** The virtual atlas as a Zarr store: its metadata written, its large arrays' chunks made when read. */
function virtualAtlas() {
  const metadataOnly = (dtype, length, chunk) => array([], { dtype, shape: [length], chunks: [chunk], attrs: null, writeChunks: false, compressed: true });
  const tree = annData({
    obs: dataFrame({ _index: array([], { dtype: '|O', shape: [N_OBS], chunks: [CHUNKS.names], writeChunks: false, compressed: true }) }),
    var: dataFrame({ _index: strings(Array.from({ length: N_VARS }, (_, g) => `g${g}`), { chunks: [N_VARS] }) }),
    X: group({
      data: metadataOnly('<f4', NNZ, CHUNKS.data),
      indices: metadataOnly('<i8', NNZ, CHUNKS.indices),
      indptr: metadataOnly('<i8', N_OBS + 1, CHUNKS.indptr),
    }, { 'encoding-type': 'csr_matrix', 'encoding-version': '0.1.0', shape: [N_OBS, N_VARS] }),
  });
  const inner = memoryStore(zarrEntries(tree), { name: 'atlas.zarr' });
  const store = {
    name: 'atlas.zarr',
    async get(key, options) {
      return virtualChunk(key) ?? inner.get(key, options);
    },
    getMany(keys, options) {
      return Promise.all(keys.map(key => store.get(key, options)));
    },
    async getRanges(key, ranges, options) {
      const bytes = virtualChunk(key);
      if (bytes === null) return inner.getRanges(key, ranges, options);
      return ranges.map(range => (range.suffix !== undefined ? bytes.subarray(bytes.length - range.suffix) : bytes.subarray(range.offset, range.offset + range.length)));
    },
    storedSize: inner.storedSize,
    list: inner.list,
  };
  return store;
}

/** A link slower than a disk, measured (values are read per gene). */
function slowLink() {
  const snapshot = {
    measured: true, latencyMs: 250, bytesPerMs: 2500, concurrency: 100, shapingConcurrency: 24, backgroundConcurrency: 23,
    mergeGapBytes: 25_000, roundTripBytes: 620_000, maxRequestBytes: 8 * 1024 * 1024, readsAhead: false,
  };
  return { readsAhead: false, mergeGapBytes: snapshot.mergeGapBytes, roundTripBytes: snapshot.roundTripBytes, snapshot: () => snapshot, watchProtocol() {} };
}

/** The process's JavaScript heap and ArrayBuffer bytes now. */
function heldBytes() {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** `work()`'s result and the peak growth of `heldBytes` while it ran (sampled every few milliseconds). */
async function peakGrowth(work) {
  const baseline = heldBytes();
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, heldBytes()); }, 2);
  try {
    const result = await work();
    peak = Math.max(peak, heldBytes());
    return { result, growth: peak - baseline };
  } finally {
    clearInterval(sampler);
  }
}

test('genes of 3,400 cells of a 2M-cell CSR atlas hold memory of their kept entries, not of the file', async () => {
  const root = await openZarr(virtualAtlas(), { decodedChunkCacheBytes: DECODED_CHUNK_BYTES });
  const reader = new AnnDataReader();
  await reader.open(root, {
    format: ZARR_FORMAT,
    name: 'atlas.zarr',
    link: slowLink(),
    decodedChunkBytes: DECODED_CHUNK_BYTES,
    // Genes for every kept cell (no gene sample): what reading all their entries holds.
    cellSubset: { mode: 'subsample', method: 'blocks', k: KEPT_CELLS, seed: 0, blockSize: 19, strict: true, genes: 'all' },
  });
  const names = await reader.readObsNames();
  const cells = Array.from(names, name => Number(String(name).slice(1)));
  assert.equal(cells.length, KEPT_CELLS);
  const keptEntries = KEPT_CELLS * PER_ROW;
  for (const gene of [7, 123]) {
    const { result: column, growth } = await peakGrowth(() => reader.getMatrixColumn('X', gene));
    for (let i = 0; i < cells.length; i++) {
      const row = cells[i];
      const slot = ((gene - (row % 250)) % N_VARS + N_VARS) % N_VARS;
      const expected = slot % 250 === 0 && slot / 250 < PER_ROW ? valueOf(row * PER_ROW) : 0;
      assert.equal(column[i], expected, `gene ${gene}, cell ${row}`);
    }
    // What reading the kept entries can hold: each entry stored and decoded
    // (8-byte index, 4-byte value), its kept index and position, its value
    // read whole, the index's working copies; the decoded chunks kept
    // within their budget (a chunk of each array decoded whole past each
    // end of a kept block); and the reader's own bookkeeping.
    const allowed = keptEntries * 64 + 2 * DECODED_CHUNK_BYTES + 64 * 1024 * 1024;
    assert.ok(growth <= allowed, `gene ${gene}: held ${(growth / 1e6).toFixed(0)} MB more while read, at most ${(allowed / 1e6).toFixed(0)} MB for ${keptEntries} kept entries`);
  }
  reader.close();
});

test('a gather of a gathered array is one gather of the stored array', async () => {
  const stored = array(Float32Array.from({ length: 1000 }, (_, i) => i), { chunks: [64], compressed: true });
  const root = await openZarr(memoryStore(zarrEntries(group({ values: stored })), { name: 'g.zarr' }));
  const real = root.get('values');
  const reads = [];
  const recording = Object.freeze({ ...real, read: (selection, options) => { reads.push(selection); return real.read(selection, options); } });
  // Rows 10–19, 500–699 and 900–909 of the stored array, in that order.
  const inner = { count: 3, starts: Float64Array.of(10, 500, 900), ends: Float64Array.of(20, 700, 910), offsets: Float64Array.of(0, 10, 210, 220) };
  // Rows 5–214 of those: the end of the first run, the second, the start of the third.
  const outer = { count: 1, starts: Float64Array.of(5), ends: Float64Array.of(215), offsets: Float64Array.of(0, 210) };
  const runs = composedRuns(inner, outer);
  assert.deepEqual([...runs.starts], [15, 500, 900]);
  assert.deepEqual([...runs.ends], [20, 700, 905]);
  assert.deepEqual([...runs.offsets], [0, 5, 205, 210]);
  const twice = gatheredArray(gatheredArray(recording, inner, { mergeGapBytes: () => 0 }), outer, { mergeGapBytes: () => 0 });
  assert.equal(twice.gather.source, recording, 'the gather of a gather reads the stored array');
  const values = await twice.read(undefined);
  assert.deepEqual([...values], [...[15, 16, 17, 18, 19], ...Array.from({ length: 200 }, (_, i) => 500 + i), ...[900, 901, 902, 903, 904]]);
  // One read per stored chunk the rows lie in, never one per estimated chunk of the inner gather.
  const touched = new Set([0, ...Array.from({ length: 200 }, (_, i) => Math.floor((500 + i) / 64)), 14]);
  assert.equal(reads.length, touched.size);
  // A segment of a subsample's matrix (rows of a CSR group whose entries are gathered) composes the same way.
  const csr = group({
    data: array(Float32Array.from({ length: 1000 }, (_, i) => i), { chunks: [64], attrs: null, compressed: true }),
    indices: array(Int32Array.from({ length: 1000 }, (_, i) => i % 10), { dtype: '<i4', chunks: [64], attrs: null, compressed: true }),
    indptr: array(Int32Array.from({ length: 101 }, (_, i) => i * 10), { dtype: '<i4', chunks: [101], attrs: null }),
  }, { 'encoding-type': 'csr_matrix', 'encoding-version': '0.1.0', shape: [100, 10] });
  const matrix = (await openZarr(memoryStore(zarrEntries(group({ X: csr })), { name: 'm.zarr' }))).get('X');
  const segment = rowRangeMatrix(Object.freeze({
    ...matrix,
    get: key => (key === 'data' ? gatheredArray(matrix.get('data'), inner, { mergeGapBytes: () => 0 }) : matrix.get(key)),
    keys: () => matrix.keys(),
  }), 0, 21, Float64Array.from({ length: 23 }, (_, i) => i * 10));
  assert.equal(segment.get('data').gather.source.path, matrix.get('data').path);
  assert.deepEqual([...(await segment.get('data').read(undefined))].slice(0, 12), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 500, 501]);
});

test('a cell subset\'s lookups hold its cells, never a slot for every row of the file', () => {
  const random = createMulberry32(5);
  const nObs = 1_000_000;
  const kept = new Set();
  while (kept.size < 5000) kept.add(Math.floor(random() * nObs));
  const rows = Uint32Array.from(kept);
  const reference = new Map(Array.from(rows, (row, i) => [row, i]));
  const positions = new KeptPositions(rows);
  for (const row of rows) assert.equal(positions.get(row), reference.get(row));
  for (let i = 0; i < 20_000; i++) {
    const row = Math.floor(random() * nObs);
    assert.equal(positions.get(row), reference.get(row) ?? -1);
  }
  assert.equal(positions.get(nObs + 5), -1);
  // A gene's entries kept in the subset: rows ascending, the subset given in any order.
  const sorted = Uint32Array.from(rows).sort();
  const subset = { rows: sorted, positions: Int32Array.from(sorted, row => reference.get(row)) };
  for (const share of [0.001, 0.01, 0.5]) {
    const geneRows = [];
    for (let row = 0; row < nObs; row++) if (random() < share || (kept.has(row) && random() < 0.5)) geneRows.push(row);
    const values = Float32Array.from(geneRows, (_, i) => i % 4);
    const outPositions = new Int32Array(geneRows.length);
    const outValues = new Float32Array(geneRows.length);
    const end = keepSubsetEntries(Uint32Array.from(geneRows), values, 0, geneRows.length, subset, nObs, outPositions, outValues, 0);
    const expected = [];
    geneRows.forEach((row, i) => { if (reference.has(row) && values[i] !== 0) expected.push([reference.get(row), values[i]]); });
    assert.deepEqual(Array.from({ length: end }, (_, i) => [outPositions[i], outValues[i]]), expected, `a gene in ${share} of the cells`);
  }
  // Rows that do not ascend are refused (the gene is read through its checks instead).
  assert.equal(keepSubsetEntries(Uint32Array.of(5, 3), Float32Array.of(1, 1), 0, 2, subset, nObs, new Int32Array(2), new Float32Array(2), 0), -1);
});
