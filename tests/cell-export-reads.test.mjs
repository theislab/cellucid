/**
 * Cell exports read many scattered rows at the link's floor, holding a part
 * at a time, priced before they start, and failing in words.
 *
 * - `AnnDataReader.readMatrixRows`: one read of every cell, its parts handed
 *   out in the cells' order, the next part read before one is handed out;
 *   the same rows as `getMatrixRows` (which gathers its parts).
 * - `pipelined`: a read that arrived frees its request's worth at once, so
 *   a slow read at the head never holds the link below its concurrency.
 * - `AnnDataReader.readObsNames({cells})`: listed cells' names, in their
 *   order, from their own chunks.
 * - `AnnDataReader.matrixRowsCost`: the export's price from the layout, the
 *   bytes a read of those rows fetches.
 * - The page's range cache keeps and looks up ranges in logarithmic time.
 * - `failureText`: never an empty failure (that no notification shows an
 *   error's words alone is `failure-wording-contract.test.mjs`).
 */
import { blocksRun } from './helpers/block-counts.mjs';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { annData, array, countingStore, dataFrame, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { pipelined } from '../assets/js/data/anndata/matrix-access.js';
import { createByteRangeCache } from '../assets/js/data/byte-range-cache.js';
import { failureText } from '../assets/js/utils/errors.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { ReadActivity } from '../assets/js/formats/io/activity.js';
import { toWire, fromWire } from '../assets/js/utils/error-wire.js';

import { until } from './helpers/until.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A CSR matrix of `nObs` cells, `perRow` entries each, in chunks of `chunk` entries. */
function csrTree({ nObs = 400, nVars = 50, perRow = 5, chunk = 64, compressed = false } = {}) {
  const indptr = new Int32Array(nObs + 1);
  const indices = new Int32Array(nObs * perRow);
  const data = new Float32Array(nObs * perRow);
  for (let cell = 0; cell < nObs; cell++) {
    indptr[cell + 1] = (cell + 1) * perRow;
    for (let k = 0; k < perRow; k++) {
      indices[cell * perRow + k] = (cell * 7 + k * 3) % nVars;
      data[cell * perRow + k] = cell + k / 10;
    }
    // Ascending within the row, as a CSR matrix keeps them.
    const row = indices.subarray(cell * perRow, (cell + 1) * perRow);
    row.sort();
  }
  return annData({
    obs: dataFrame({ _index: strings(Array.from({ length: nObs }, (_, i) => `cell-${i}`), { chunks: [32] }), n: array(Float32Array.from({ length: nObs }, (_, i) => i), { chunks: [32] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `g${g}`)) }),
    obsm: mapping({}),
    X: sparse({ data, indices, indptr, shape: [nObs, nVars], chunks: chunk, compressed }),
  });
}

async function open(tree, { onChunk = null, cellSubset = undefined, decodedChunkBytes = 0 } = {}) {
  const { store, fetched, reads } = countingStore(tree, { onChunk });
  const root = await openZarr(store, { decodedChunkCacheBytes: decodedChunkBytes });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes, ...(cellSubset === undefined ? {} : { cellSubset }) });
  return { reader, fetched, reads };
}

test('readMatrixRows hands every cell\'s row out part by part, in the cells\' order, the next part asked for before one is handed out', async () => {
  const log = [];
  const { reader } = await open(csrTree(), { onChunk: key => { if (key.startsWith('X/data/')) log.push(['chunk', key]); } });
  // Scattered cells, not ascending: an export's original order.
  const cells = Array.from({ length: 120 }, (_, i) => (i * 37) % 400);
  const parts = [];
  const read = await reader.readMatrixRows('X', cells, {
    partEntries: 100,
    onPart: part => {
      log.push(['part', part.first]);
      parts.push(part);
    },
  });
  assert.equal(read.cells, cells.length);
  assert.ok(parts.length >= 5, 'several parts of about 100 entries');
  let next = 0;
  for (const part of parts) {
    assert.equal(part.first, next, 'parts in the cells\' order');
    assert.equal(part.pointers.length, part.count + 1);
    next += part.count;
  }
  assert.equal(next, cells.length);
  // The second part's chunks were asked for before the first part was handed out.
  const firstHanded = log.findIndex(([kind]) => kind === 'part');
  const asked = new Set(log.slice(0, firstHanded).filter(([kind]) => kind === 'chunk').map(([, key]) => key));
  const second = parts[1];
  const secondChunks = new Set();
  for (let i = 0; i < second.count; i++) secondChunks.add(`X/data/${Math.floor((cells[second.first + i] * 5) / 64)}`);
  assert.ok([...secondChunks].some(key => asked.has(key)), 'the next part is read while one is handed out');
  // The same rows as every cell read alone.
  const rows = await reader.getMatrixRows('X', cells);
  for (const part of parts) {
    for (let i = 0; i < part.count; i++) {
      const want = rows[part.first + i];
      assert.deepEqual(Array.from(part.genes.subarray(part.pointers[i], part.pointers[i + 1])), Array.from(want.genes));
      assert.deepEqual(Array.from(part.values.subarray(part.pointers[i], part.pointers[i + 1])), Array.from(want.values));
      const cell = cells[part.first + i];
      assert.equal(want.values[0], cell, `cell ${cell}'s own row`);
      for (let k = 1; k < want.genes.length; k++) assert.ok(want.genes[k] > want.genes[k - 1], 'genes ascending');
    }
  }
});

test('readMatrixRows of a subsample\'s cells reads their rows\' pointers once and each chunk they lie in once', async () => {
  const tree = csrTree({ nObs: 600, chunk: 50 });
  // Decoded chunks kept as the reader keeps them (`decodedBlocks`): a chunk
  // two parts share is decoded once.
  const { reader, fetched } = await open(tree, { cellSubset: { mode: 'subsample', fraction: 0.5, method: 'uniform', seed: 3 }, decodedChunkBytes: 1 << 20 });
  const before = fetched.length;
  const cells = Array.from({ length: Math.floor(reader.nObs / 3) }, (_, i) => i * 3);
  let handed = 0;
  await reader.readMatrixRows('X', cells, { partEntries: 60, onPart: part => { handed += part.count; } });
  assert.equal(handed, cells.length);
  const read = fetched.slice(before);
  for (const array of ['X/indptr', 'X/indices', 'X/data']) {
    const keys = read.filter(key => key.startsWith(`${array}/`));
    assert.equal(new Set(keys).size, keys.length, `${array}: each chunk read once`);
  }
});

test('pipelined frees an arrived read\'s request worth at once: a slow head never holds the reads behind it back', async () => {
  // Ten reads of one entry each, priced at a request of 4 entries, with 10
  // in flight: two at a time while every read waits; read 0 is slow.
  const reads = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 1 }));
  const releases = new Map();
  const asked = [];
  const handled = [];
  const done = pipelined(reads, 10, read => {
    asked.push(read.start);
    return new Promise(resolve => releases.set(read.start, resolve));
  }, read => handled.push(read.start), 4);
  assert.deepEqual(asked, [0, 1]);
  // Read 1 arrives while read 0 is slow: read 1 now holds its entry only,
  // so more reads go out at once, though none is handed out before read 0.
  releases.get(1)('one');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(asked.length > 2, `more reads asked while the head waits (${asked})`);
  assert.deepEqual(handled, []);
  for (let i = 0; i < 10 && handled.length < 10; i++) {
    for (const [start, resolve] of releases) resolve(start);
    await new Promise(resolve => setImmediate(resolve));
  }
  await done;
  assert.deepEqual(handled, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'handed out in order');
});

test('readObsNames of listed cells names them in their order from their own chunks only', async () => {
  const { reader, fetched } = await open(csrTree({ nObs: 400 }));
  const before = fetched.length;
  const cells = [399, 5, 6, 200, 7];
  assert.deepEqual(await reader.readObsNames({ cells }), cells.map(i => `cell-${i}`));
  const chunks = fetched.slice(before).filter(key => key.startsWith('obs/_index/'));
  // Rows 5-7 in chunk 0, 200 in chunk 6, 399 in chunk 12: never the other ten.
  assert.deepEqual([...new Set(chunks)].sort(), ['obs/_index/0', 'obs/_index/12', 'obs/_index/6']);
  // Listed cells and a range of rows are two readings, never one.
  await assert.rejects(reader.readObsNames({ cells, rows: [0, 10] }), TypeError);
});

test('matrixRowsCost prices an export\'s rows before reading them: the bytes the read then fetches', async () => {
  // Compressed chunks, read whole, as an .h5ad's gzip chunks are.
  const tree = csrTree({ nObs: 800, perRow: 8, chunk: 64, compressed: true });
  const cells = Array.from({ length: 40 }, (_, i) => i * 19);
  const priced = await open(tree);
  const cost = await priced.reader.matrixRowsCost('X', cells);
  const { reader, reads } = await open(tree);
  const before = reads.length;
  await reader.readMatrixRows('X', cells, { onPart: () => {} });
  const fetchedBytes = reads.slice(before).filter(read => /^X\/(indptr|indices|data)\//.test(read.key)).reduce((sum, read) => sum + read.end - read.start, 0);
  assert.equal(cost.cells, cells.length);
  assert.equal(cost.keptBytes, 0);
  assert.ok(cost.requests > 0);
  // Uniform rows: the layout's model is the read, chunk for chunk.
  assert.ok(Math.abs(cost.bytes - fetchedBytes) <= fetchedBytes * 0.05, `priced ${cost.bytes} B, read ${fetchedBytes} B`);
  assert.equal(cost.ms, null, 'no time without a measured link');
});

test('the page\'s range cache keeps and looks up ranges exactly, in logarithmic time', async () => {
  const cache = createByteRangeCache({ budgetBytes: 1 << 30 });
  // A naive model: the bytes held at each offset.
  const held = new Map();
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 2000; i++) {
    const start = Math.floor(random() * 5000);
    const length = 1 + Math.floor(random() * 60);
    const bytes = Uint8Array.from({ length }, (_, k) => (start + k) & 0xff);
    cache.keep('f', start, bytes);
    for (let k = 0; k < length; k++) held.set(start + k, (start + k) & 0xff);
  }
  for (let i = 0; i < 300; i++) {
    const offset = Math.floor(random() * 5000);
    const length = 1 + Math.floor(random() * 100);
    for (const piece of cache.lookup('f', offset, length)) {
      assert.ok(piece.start >= offset && piece.start + piece.bytes.length <= offset + length);
      piece.bytes.forEach((value, k) => assert.equal(value, held.get(piece.start + k)));
    }
  }
  // Tens of thousands of scattered chunks, as an export reads them: blocks run
  // (`helpers/block-counts.mjs`), not milliseconds. Ten times the chunks runs
  // about ten times the blocks; a scan of the ranges per lookup, a hundred.
  const chunks = async count => {
    const big = createByteRangeCache({ budgetBytes: 1 << 30 });
    const blocks = await blocksRun('/byte-range-cache.js', () => {
      for (let i = 0; i < count; i++) big.keep('g', i * 3000, new Uint8Array(1000));
      for (let i = 0; i < count; i++) big.lookup('g', i * 3000 + 10, 20);
    });
    assert.equal(big.stats().ranges, count);
    return blocks;
  };
  const few = await chunks(4000);
  const many = await chunks(40000);
  assert.ok(many / few < 20, `ten times the chunks ran ${(many / few).toFixed(1)} times the blocks (${few}, then ${many})`);
});

test('a failure is never shown without words: its class and cause when its message is empty, across a thread too', () => {
  assert.equal(failureText(new Error('')), 'Error (no message given)');
  assert.equal(failureText(new Error('', { cause: new TypeError('the part did not fit') })), 'Error (no message given): the part did not fit');
  assert.equal(failureText(new Error('Read failed', { cause: new Error('host 503') })), 'Read failed: host 503');
  assert.equal(failureText(new Error('Read failed: host 503', { cause: new Error('host 503') })), 'Read failed: host 503');
  const crossed = fromWire(toWire(new Error('', { cause: new RangeError('Array buffer allocation failed') })));
  assert.equal(failureText(crossed), 'Error (no message given): Array buffer allocation failed');
  assert.equal(failureText(null), 'Error (no message given)');
});

test('an .h5ad export says what it will read before it reads it, and its Cancel stops it with nothing saved', async () => {
  const { initCellExportsUi } = await import('../assets/js/app/ui/modules/cell-exports-ui.js');
  const { createCellIdentity } = await import('../assets/js/data/cell-identity.js');
  const element = () => Object.assign(new EventTarget(), { hidden: false, disabled: false, value: '0' });
  const dom = {
    highlightsCsvButton: element(), highlightsH5adButton: element(), categoricalExportButton: element(),
    continuousExportButton: element(), categoricalSelect: element(), continuousSelect: element(),
  };
  const said = [];
  let onCancel = null;
  const outcomes = [];
  const notifications = {
    progress: (text, _percent, options) => { said.push({ message: text }); onCancel = options.onCancel; return 'card'; },
    updateProgress: (_id, _percent, options) => { if (options.message !== undefined) said.push(options); },
    complete: (_id, message) => outcomes.push(['complete', message]),
    fail: (_id, message) => outcomes.push(['fail', message]),
    dismiss: () => outcomes.push(['dismiss']),
    info: message => outcomes.push(['info', message]),
    hasNotification: () => true,
  };
  const cells = Uint32Array.of(1, 4, 7);
  let reading = null;
  const adapter = {
    async getMatrixRowsCostOf(path, asked) {
      assert.equal(path, 'var/0');
      assert.deepEqual(Array.from(asked), [1, 4, 7]);
      return { cells: 3, bytes: 808 * 2 ** 20, keptBytes: 2 * 2 ** 20, requests: 24462, ms: 480_000 };
    },
    getObsNames: () => new Promise((_, reject) => { reading = reject; }),
  };
  const state = {
    pointCount: 10,
    cellIdentity: createCellIdentity({ nObs: 10 }),
    getActivePageId: () => 'p',
    getHighlightPages: () => [{ id: 'p', name: 'page', highlightedGroups: [{ id: 'g', enabled: true, cellIndices: cells }] }],
    getHighlightedCellCountForPage: () => 3,
    whenGenesListed: async () => {},
    varData: { fields: [{ key: 'G0', path: 'var/0' }] },
    on: () => () => {},
  };
  initCellExportsUi({ state, dom, getAnnDataSource: () => ({ getAdapter: () => adapter }), notifications });
  dom.highlightsH5adButton.dispatchEvent(new Event('click'));
  // The export starts on a later task (it waits for the open cells): until it reads.
  await until(() => reading !== null, 'the export reading');
  const line = said.find(entry => /reads/.test(entry.message ?? ''));
  assert.ok(line, `the card says what it reads: ${JSON.stringify(said)}`);
  assert.match(line.message, /Export the highlighted cells \(\.h5ad\) · reads 808 MB, ~8 min…/);
  assert.match(line.details, /3 cells: 808 MB to read in about 24,462 requests; ~8 min 0 s over this connection as measured; 2.0 MB more is read from this browser's copy/);
  // Cancel: stopped, never failed, nothing saved.
  onCancel();
  reading(new Error('should not be shown'));
  await until(() => outcomes.length > 0, 'the export ended');
  assert.deepEqual(outcomes, [['dismiss']]);
});

test('bytes a cell export alone reads are not kept in the page\'s memory; bytes any other read shares are', async () => {
  const bytes = new Uint8Array(100_000);
  const base = bytesByteSource(bytes, { name: 'f', policy: { blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 1 << 20, concurrency: 4, cacheBytes: 4096 } });
  const asked = [];
  const source = { ...base, read: (offset, length, options = {}) => { asked.push([offset, options.keepInMemory]); return base.read(offset, length, options); } };
  const reader = createByteReader(source);
  const exportRead = new ReadActivity({ kind: 'cells', label: 'cells' });
  const geneRead = new ReadActivity({ kind: 'genes', label: 'gene' });
  assert.equal(exportRead.readOnce, true);
  assert.equal(geneRead.readOnce, false);
  await reader.read(0, 100, { activity: exportRead });
  await reader.read(50_000, 100, { activity: geneRead });
  // One range asked by both in one plan: kept, another read needs it.
  await Promise.all([reader.read(80_000, 100, { activity: exportRead }), reader.read(80_000, 100, { activity: geneRead })]);
  assert.deepEqual(asked, [[0, false], [50_000, true], [80_000, true]]);
});

test('an export spool never fails on a full storage: this page\'s earlier exports\' files go first, then memory, and every byte is kept in order', async () => {
  const { createSpool } = await import('../assets/js/app/exports/cell-exports.js');
  // A private storage of 100 bytes, as a full one answers (`QuotaExceededError`).
  const files = new Map();
  const used = () => [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  const directory = {
    async getFileHandle(name) {
      return {
        async createWritable() {
          const parts = [];
          return {
            async write(data) {
              // A Blob or bytes, as a file stream takes either.
              const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
              if (used() + parts.reduce((sum, part) => sum + part.length, 0) + bytes.length > 100) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
              parts.push(bytes);
            },
            async close() { files.set(name, new Uint8Array(await new Blob(parts).arrayBuffer())); },
            async abort() {},
          };
        },
        async getFile() { return new File([files.get(name) ?? new Uint8Array(0)], name); },
      };
    },
    async removeEntry(name) { files.delete(name); },
    async *entries() { for (const name of [...files.keys()]) yield [name, null]; },
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => directory } }, configurable: true });
  try {
    const fill = (n, value) => new Uint8Array(n).fill(value);
    // An earlier export, finished (its download read it).
    const earlier = await createSpool('csv', { segmentBytes: 1 });
    await earlier.write(fill(60, 1));
    assert.equal((await earlier.finish()).size, 60);
    // An export of two spools at once: neither removes the other's files.
    const data = await createSpool('data', { segmentBytes: 1 });
    const indices = await createSpool('indices', { segmentBytes: 1 });
    await indices.write(fill(10, 9));
    await data.write(fill(20, 2));
    // Full: the earlier export's files are removed, the write tried again.
    await data.write(fill(30, 3));
    assert.ok(![...files.keys()].some(name => name.includes('-csv-')), 'the earlier export\'s files are removed');
    assert.ok([...files.keys()].some(name => name.includes('-indices-')), 'the export\'s other spool keeps its files');
    // Still full: memory, from here on.
    await data.write(fill(80, 4));
    await data.write(fill(5, 5));
    const blob = await data.finish();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(Array.from(bytes), [...fill(20, 2), ...fill(30, 3), ...fill(80, 4), ...fill(5, 5)]);
    assert.deepEqual(Array.from(new Uint8Array(await (await indices.finish()).arrayBuffer())), Array.from(fill(10, 9)));
    // Writes are gathered into segments: one file for many small writes.
    const gathered = await createSpool('csv');
    for (let i = 0; i < 50; i++) await gathered.write(fill(1, i));
    const before = files.size;
    const whole = await gathered.finish();
    assert.equal(whole.size, 50);
    assert.ok(files.size - before <= 1, 'fifty writes, at most one file');
  } finally {
    if (before === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', before);
  }
});

test('a CSV of every cell of a file in priority order reads the names once, as one range, never every name chunk a batch', async () => {
  const { fieldCsv } = await import('../assets/js/app/exports/cell-exports.js');
  const { createCellIdentity } = await import('../assets/js/data/cell-identity.js');
  // 70,000 open cells (more than a CSV batch), stored in a priority order:
  // open cell i is original position order[i].
  const n = 70_000;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = (i * 7919) % n;
  const names = Array.from({ length: n }, (_, i) => `cell-${order[i]}`);
  const reads = [];
  const adapter = {
    async getObsNames({ rows = null, cells = null } = {}) {
      reads.push(cells === null ? { rows } : { cells: cells.length });
      return cells === null ? names.slice(rows[0], rows[1]) : Array.from(cells, cell => names[cell]);
    },
  };
  const field = { key: 'score', kind: 'continuous', values: Float32Array.from({ length: n }, (_, i) => order[i] % 5) };
  const loads = [];
  const state = { cellIdentity: createCellIdentity({ nObs: n, openOrder: order }), ensureFieldLoaded: async (index, options) => { loads.push([index, options]); return field; } };
  const signal = new AbortController().signal;
  const { blob } = await fieldCsv({ state, adapter, fieldIndex: 0, signal });
  // The field is read under the export: its Cancel stops it, and no card of
  // the field's own (whose Cancel failed the export) appears beside its card.
  assert.deepEqual(loads, [[0, { signal, silent: true }]]);
  assert.deepEqual(reads, [{ rows: [0, n] }], 'one range read of every open cell\'s names');
  const lines = (await blob.text()).trimEnd().split('\n');
  assert.equal(lines.length, n + 3);
  // Rows by original position, each named and valued as its cell.
  for (const row of [0, 1, 65_535, 65_536, n - 1]) assert.equal(lines[row + 3], `cell-${row},${row % 5}`);
});

test('an export reads the embedding rows of its listed cells alone, in their order, never every open row between them', async () => {
  const nObs = 400;
  const umap = Float32Array.from({ length: nObs * 2 }, (_, i) => Math.floor(i / 2) + (i % 2) / 10);
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: nObs }, (_, i) => `cell-${i}`), { chunks: [32] }) }),
    var: dataFrame({ _index: strings(['g0']) }),
    obsm: mapping({ X_umap: array(umap, { shape: [nObs, 2], chunks: [32, 2] }) }),
  });
  const { reader, fetched } = await open(tree, { cellSubset: { mode: 'subsample', fraction: 0.5, method: 'uniform', seed: 3 } });
  const fileRow = open => (reader.cellSubset.openOrder === null ? reader.cellSubset.kept[open] : reader.cellSubset.openOrder[open]);
  // A few open cells, listed in no particular order: rows of three file chunks.
  const listed = [];
  for (let open = 0; open < reader.nObs && listed.length < 6; open++) if (Math.floor(fileRow(open) / 32) % 4 === 1) listed.push(open);
  listed.reverse();
  const before = fetched.length;
  const values = await reader.readObsmColumns('X_umap', [0, 1], { cells: listed, reason: 'export' });
  assert.deepEqual(Array.from(values), listed.flatMap(open => [fileRow(open), Math.fround(fileRow(open) + 0.1)]));
  const chunks = new Set(fetched.slice(before).filter(key => key.startsWith('obsm/X_umap/')));
  const floor = new Set(listed.map(open => `obsm/X_umap/${Math.floor(fileRow(open) / 32)}.0`));
  assert.deepEqual([...chunks].sort(), [...floor].sort(), 'the listed cells\' chunks alone');
});
