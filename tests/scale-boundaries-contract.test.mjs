/**
 * Size boundaries no small dataset reaches, reproduced cheaply with
 * synthetic typed arrays: past 2^24 cells (a JavaScript Map or Set refuses
 * more entries), orders of millions of cells in linear time (no comparator
 * call per comparison, no object per cell), and exports that read and build
 * an obs-column CSV a batch at a time (no array of every cell's name, no
 * single long task).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { orderByKey } from '../assets/js/utils/radix-order.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { fieldCsv, highlightsCsv, inOriginalOrder } from '../assets/js/app/exports/cell-exports.js';
import { DerivedResultsRegistry } from '../assets/js/app/registries/derived-results.js';
import { BOOLEAN_FLAG_MISSING, decodeAnnDataBooleanFlags } from '../assets/js/data/anndata-value-kinds.js';
import { codeBooleanColumn, codeDiscoveredColumn } from '../assets/js/data/discovered-categories.js';
import { rowChunks } from '../assets/js/data/anndata/subsample-plan.js';
import { keptChunkShare } from '../assets/js/data/anndata/views/cell-subset.js';

/** More cells than a Map or Set holds. */
const PAST_SET_LIMIT = 2 ** 24 + 3;

/** A permutation of [0, n): i -> i * 7919 mod n (7919 is prime and does not divide n). */
function priorityOrder(n) {
  assert.notEqual(n % 7919, 0);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = (i * 7919) % n;
  return order;
}

test('orderByKey is the stable ascending order of 32-bit keys', () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (const [n, spread] of [[0, 1], [1, 1], [2, 1], [1000, 50], [1000, 2 ** 32], [70000, 65536], [5000, 2 ** 20]]) {
    const keys = new Uint32Array(n);
    for (let i = 0; i < n; i++) keys[i] = spread === 2 ** 32 ? random() : random() % spread;
    const order = orderByKey(keys);
    const expected = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
    assert.deepEqual([...order], expected, `${n} keys below ${spread}`);
  }
  assert.throws(() => orderByKey([3, 1]), /Uint32Array/);
});

test('an export orders more cells than a Map holds by original position, in linear time', () => {
  const n = PAST_SET_LIMIT;
  const identity = createCellIdentity({ nObs: n, openOrder: priorityOrder(n) });
  // Every other open cell, ascending by open position.
  const cells = new Uint32Array(Math.ceil(n / 2));
  for (let i = 0; i < cells.length; i++) cells[i] = 2 * i;
  const ordered = inOriginalOrder({ cellIdentity: identity }, cells);
  assert.equal(ordered.length, cells.length);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(identity.originalAt(ordered[i - 1]) < identity.originalAt(ordered[i]), `row ${i} out of original order`);
  }
  let parity = 0;
  for (let i = 0; i < ordered.length; i++) parity |= ordered[i] & 1;
  assert.equal(parity, 0, 'only the cells asked for');
  // Every open cell: the identity's own ascending order.
  const every = inOriginalOrder({ cellIdentity: identity });
  assert.equal(every.length, n);
  for (let i = 0; i < 1000; i++) assert.equal(identity.originalAt(every[i]), i);
});

test('values named by original position order more cells than a Map holds', () => {
  const n = PAST_SET_LIMIT;
  const identity = createCellIdentity({ nObs: n, openOrder: priorityOrder(n) });
  const positions = new Uint32Array(n);
  for (let i = 0; i < n; i++) positions[i] = n - 1 - i;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = positions[i] % 1000;
  const { cells, values: ordered } = identity.originalValues(positions, values);
  assert.equal(cells.length, n);
  for (let k = 0; k < n; k++) assert.equal(cells[k], k);
  // The value of original cell k is its open position's.
  for (const k of [0, 1, 7919, n - 1]) {
    const open = (() => { for (let p = 0; p < n; p++) if (identity.originalAt(p) === k) return p; return -1; })();
    assert.equal(ordered[k], open % 1000);
  }
});

test('a score moves with its cells to new positions, past a Map\'s size, without a pair per cell', () => {
  const n = PAST_SET_LIMIT;
  const registry = new DerivedResultsRegistry();
  const cells = new Uint32Array(n);
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) { cells[i] = i; values[i] = i % 4096; }
  registry.replaceOwned('signature', { scores: [{ key: 'score', cells, values }] });
  const positionOf = priorityOrder(n);
  registry.moveCells(positionOf);
  const [moved] = registry.getScores();
  assert.equal(moved.cells.length, n);
  for (let k = 1; k < n; k++) assert.ok(moved.cells[k - 1] < moved.cells[k]);
  // Cell c went to positionOf[c] with its value.
  for (const c of [0, 1, 2, 4097, n - 1]) {
    const at = moved.cells.indexOf(positionOf[c]);
    assert.equal(moved.values[at], c % 4096);
  }
});

/**
 * An adapter whose names are made per row and never handed out all at once:
 * asked by a range of rows, or by the cells listed (read in the stored order
 * by the reader).
 */
function namesAdapter(name) {
  return {
    largestRead: 0,
    reads: 0,
    async getObsNames({ rows = null, cells = null } = {}) {
      assert.ok(rows !== null || cells !== null, 'an export reads names in batches, never every name at once');
      this.reads++;
      if (cells !== null) {
        this.largestRead = Math.max(this.largestRead, cells.length);
        return Array.from(cells, cell => name(cell));
      }
      this.largestRead = Math.max(this.largestRead, rows[1] - rows[0]);
      return Array.from({ length: rows[1] - rows[0] }, (_, i) => name(rows[0] + i));
    },
  };
}

function exportState(identity, codes) {
  const highlighted = new Uint32Array([1, 5, identity.n - 1]);
  return {
    cellIdentity: identity,
    pointCount: identity.n,
    getHighlightPages: () => [{ id: 'p', name: 'page', highlightedGroups: [{ id: 'g', enabled: true, cellIndices: highlighted }] }],
    ensureFieldLoaded: async () => ({ key: 'kind', kind: 'category', codes, categories: ['a', 'b'] }),
  };
}

test('an obs-column CSV of every cell reads its names, builds and writes its rows a batch at a time, and says its size after the first', async () => {
  const n = 300_001;
  const codes = new Uint8Array(n);
  for (let i = 0; i < n; i++) codes[i] = i % 2;
  // A file in its own order: each batch reads its own rows.
  const own = namesAdapter(row => `c${row}`);
  const progress = [];
  const expected = [];
  const csv = await highlightsCsv({
    state: exportState(createCellIdentity({ nObs: n }), codes),
    adapter: own,
    pageId: 'p',
    onProgress: (done, _total, bytes) => {
      progress.push(done);
      expected.push(bytes);
    },
  });
  // Its size is said after its first batch, before the rest is written:
  // within a tenth of what is written (these names grow longer later).
  assert.ok(Math.abs(expected[0] - csv.blob.size) / csv.blob.size < 0.1, `said ${expected[0]}, wrote ${csv.blob.size}`);
  assert.equal(expected.at(-1), csv.blob.size, 'exact once every row is written');
  assert.equal(csv.blob.type, 'text/csv');
  const lines = (await csv.blob.text()).trimEnd().split('\n');
  assert.equal(lines.length, n + 2);
  assert.equal(lines[3], 'c1,true');
  assert.equal(lines[n + 1], `c${n - 1},true`);
  assert.ok(own.largestRead <= 65536, `a read of ${own.largestRead} rows`);
  assert.ok(progress.length >= 4 && progress.at(-1) === n);
  // A file in priority order, listed by original position.
  const identity = createCellIdentity({ nObs: n, openOrder: priorityOrder(n) });
  const ranked = namesAdapter(row => `c${identity.originalAt(row)}`);
  const field = await fieldCsv({ state: exportState(identity, codes), adapter: ranked, fieldIndex: 0 });
  const rows = (await field.blob.text()).trimEnd().split('\n');
  assert.equal(rows.length, n + 2);
  for (const k of [0, 1, 12345, n - 1]) assert.equal(rows[k + 2].split(',')[0], `c${k}`);
  // Each batch's cells lie throughout the file: read batch by batch, every
  // batch would read every name chunk again. The names are read once, as
  // the range of every open cell, in the stored order.
  assert.equal(ranked.reads, 1, `${ranked.reads} reads of the names`);
  assert.equal(ranked.largestRead, n);
});

test('an export stops at its signal between batches', async () => {
  const n = 600_000;
  const controller = new AbortController();
  const adapter = namesAdapter(row => `c${row}`);
  const pending = highlightsCsv({
    state: exportState(createCellIdentity({ nObs: n }), new Uint8Array(n)),
    adapter,
    pageId: 'p',
    signal: controller.signal,
    onProgress: () => controller.abort(new DOMException('stop', 'AbortError')),
  });
  await assert.rejects(pending, /stop/);
  // The batch written, and the two read ahead of it then the one asked as
  // it was taken: never the other six.
  assert.ok(adapter.reads <= 4, `${adapter.reads} batches read`);
});

test('a boolean column is one byte a cell and codes as its values would, past a Map\'s size', () => {
  const n = PAST_SET_LIMIT;
  const raw = new Uint8Array(n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) { raw[i] = (i % 3) === 0 ? 1 : 0; mask[i] = (i % 7) === 0 ? 1 : 0; }
  const flags = decodeAnnDataBooleanFlags(raw, mask, 'not a boolean');
  assert.equal(flags.length, n);
  assert.equal(flags[0], BOOLEAN_FLAG_MISSING);
  assert.equal(flags[3], 1);
  assert.equal(flags[1], 0);
  const coded = codeBooleanColumn(flags, null, 'flag');
  assert.deepEqual(coded.categories, [false, true]);
  assert.equal(coded.codes.length, n);
  // As the values themselves code, on a sample small enough for an array of them.
  const sample = Array.from(flags.subarray(0, 1000), f => (f === BOOLEAN_FLAG_MISSING ? null : f === 1));
  for (const known of [null, [true], [false, true], ['x', true]]) {
    const typed = codeBooleanColumn(flags.subarray(0, 1000), known, 'flag');
    const plain = codeDiscoveredColumn(sample, known, 'flag');
    assert.deepEqual(typed.categories, plain.categories, `known ${JSON.stringify(known)}`);
    assert.deepEqual([...typed.codes], [...plain.codes], `known ${JSON.stringify(known)}`);
    assert.equal(typed.added, plain.added);
  }
  // Only false and true (or 0 and 1) are booleans.
  assert.throws(() => decodeAnnDataBooleanFlags(Uint8Array.of(0, 2), null, 'not a boolean'), /not a boolean/);
  assert.throws(() => decodeAnnDataBooleanFlags([true, 'yes'], null, 'not a boolean'), /not a boolean/);
  assert.deepEqual([...decodeAnnDataBooleanFlags([true, false, 1n, 0], null, 'x')], [1, 0, 1, 0]);
});

/** The chunks rows lie in, row by row: the definition `rowChunks` prices by runs. */
function rowChunksRowByRow(rows, elementOf, chunkElements, extra = 0, held = null) {
  let chunks = 0;
  let runs = 0;
  let kept = 0;
  let last = -2;
  let lastFetched = -2;
  for (let i = 0; i < rows.length; i++) {
    const start = elementOf(rows[i]);
    const end = elementOf(rows[i] + 1) + extra;
    if (end <= start) continue;
    let first = Math.floor(start / chunkElements);
    const stop = Math.floor((end - 1) / chunkElements);
    if (first <= last) first = last + 1;
    if (stop < first) continue;
    for (let chunk = first; chunk <= stop; chunk++) {
      if (held !== null && held(chunk)) { kept++; continue; }
      if (chunk !== lastFetched + 1) runs++;
      chunks++;
      lastFetched = chunk;
    }
    last = stop;
  }
  return { chunks, runs, kept, gaps: 0 };
}

/** The share of index chunks the rows touch, row by row: the definition of `keptChunkShare`. */
function keptChunkShareRowByRow(pointers, rows, chunkElements) {
  const nnz = pointers[pointers.length - 1];
  const kept = [...rows].sort((a, b) => a - b);
  let touched = 0;
  let last = -1;
  for (const row of kept) {
    const start = pointers[row];
    const end = pointers[row + 1];
    if (end <= start) continue;
    let first = Math.floor(start / chunkElements);
    const stop = Math.floor((end - 1) / chunkElements);
    if (first <= last) first = last + 1;
    if (stop >= first) touched += stop - first + 1;
    if (stop > last) last = stop;
  }
  return touched / Math.ceil(nnz / chunkElements);
}

test('pricing the chunks of a gene read walks runs of rows, with the row-by-row result exactly', () => {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (let trial = 0; trial < 1500; trial++) {
    const n = 1 + Math.floor(random() * 2000);
    const mean = random() * 5;
    const pointers = new Float64Array(n + 1);
    for (let row = 1; row <= n; row++) pointers[row] = pointers[row - 1] + (random() < 0.3 ? 0 : Math.floor(random() * 2 * mean + 1));
    const nnz = Math.round(n * mean);
    const rows = Uint32Array.from({ length: n }, (_, i) => i).filter(() => random() < 0.6);
    const chunk = 1 + Math.floor(random() * 64);
    const extra = random() < 0.5 ? 1 : 0;
    const heldChunks = new Set(Array.from({ length: 20 }, () => Math.floor(random() * 200)));
    const held = random() < 0.5 ? null : c => heldChunks.has(c);
    for (const elementOf of [row => pointers[row], row => Math.min(nnz, Math.round(row * mean)), row => row * 3]) {
      assert.deepEqual(rowChunks(rows, elementOf, chunk, extra, held), rowChunksRowByRow(rows, elementOf, chunk, extra, held));
    }
    if (pointers[n] > 0) {
      const shuffled = Uint32Array.from(rows).reverse();
      assert.equal(keptChunkShare(pointers, shuffled, chunk), keptChunkShareRowByRow(pointers, rows, chunk));
    }
  }
  // Every row of a file past 2^24 rows: a handful of runs, priced at once.
  const every = new Uint32Array(PAST_SET_LIMIT);
  for (let i = 0; i < every.length; i++) every[i] = i;
  assert.deepEqual(rowChunks(every, row => row * 4, 65536), { chunks: Math.ceil(PAST_SET_LIMIT * 4 / 65536), runs: 1, kept: 0, gaps: 0 });
});

test('a string index answers as a Map of the names would, without a Map', async () => {
  const { StringIndex } = await import('../assets/js/utils/string-index.js');
  let seed = 11;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const names = Array.from({ length: 200_000 }, () => `cell-${random() % 150_000}`);
  const index = StringIndex.of(names);
  const map = new Map(names.map((name, i) => [name, i]));
  assert.equal(index.size, map.size);
  for (const [name, at] of map) assert.equal(index.get(name), at, name);
  assert.equal(index.get('absent'), undefined);
  // Interning numbers each distinct string once, in first-seen order.
  const labels = new StringIndex();
  const codes = ['b', 'a', 'b', '', 'é', 'a'].map(label => labels.intern(label));
  assert.deepEqual(codes, [0, 1, 0, 2, 3, 1]);
  assert.deepEqual(labels.keys, ['b', 'a', '', 'é']);
  assert.equal(labels.find('é'), 3);
  assert.equal(labels.find('c'), -1);
});

test('a cell table is read typed in one pass and matched to its cells by name', async () => {
  const { joinTable, readTable } = await import('../assets/js/data/anndata/transcode/tables.js');
  const reader = text => {
    const bytes = new TextEncoder().encode(text);
    return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
  };
  // Rows out of order, a cell named twice (the later row wins), one unknown,
  // a quoted text field, missing values, a byte-order mark, CRLF lines.
  const csv = '﻿cell,UMAP_1,UMAP_2,leiden,score,donor\r\n' +
    'c2,0.5,1,3,NA,"d,1"\r\nc0,1.5,2,10,0.25,d2\r\nzz,9,9,1,1,d3\r\nc2,2.5,3,3,1e2,d2\r\n\r\nc1,,4,,7,\r\n';
  const table = await readTable(reader(csv), { cells: ['c0', 'c1', 'c2'] });
  assert.deepEqual(table.names, ['cell', 'UMAP_1', 'UMAP_2', 'leiden', 'score', 'donor']);
  assert.equal(table.rows, 5);
  assert.deepEqual([...table.rowOf], [2, 0, -1, 2, 1]);
  assert.equal(table.ragged, null);
  const joined = joinTable(table, 3);
  assert.equal(joined.matched, 4);
  assert.deepEqual(joined.obsm.map(entry => entry.name), ['X_umap']);
  assert.deepEqual([...joined.obsm[0].values], [1.5, NaN, 2.5, 2, 4, 3]);
  const byName = Object.fromEntries(joined.columns.map(entry => [entry.name, entry.column]));
  assert.deepEqual(byName.leiden.categories, ['3', '10'], 'a clustering of numbers in numeric order');
  assert.deepEqual([...byName.leiden.codes], [1, -1, 0]);
  assert.deepEqual([...byName.score.values], [0.25, 7, 100]);
  assert.deepEqual(byName.donor.categories, ['d2'], 'only labels the cells keep (row 1 was replaced; zz is no cell)');
  assert.deepEqual([...byName.donor.codes], [0, -1, 0]);
  // A header-less table names its columns; a ragged one says where.
  const plain = await readTable(reader('c0\t1\t2\nc1\t3\t4\n'), { cells: ['c0', 'c1'] });
  assert.deepEqual(plain.names, ['column_1', 'column_2', 'column_3']);
  assert.deepEqual([...plain.numbers[1]], [1, 3]);
  const ragged = await readTable(reader('Barcode,UMAP-1,UMAP-2\nA,1,2\nB,3\n'), { cells: ['A', 'B'], header: true });
  assert.deepEqual(ragged.ragged, { line: 3, fields: 2 });
});

test('a cell table is read once from its start; a column of numbers that becomes labels keeps their text, read again only up to that row', async () => {
  const { joinTable, readTable } = await import('../assets/js/data/anndata/transcode/tables.js');
  const { ownText } = await import('../assets/js/formats/text/lines.js');
  let passes = 0;
  const reader = text => {
    const bytes = new TextEncoder().encode(text);
    return {
      size: bytes.length,
      read: async (offset, length) => {
        if (offset === 0) passes++;
        return bytes.subarray(offset, offset + length);
      },
    };
  };
  // `plate` is numbers for 3 rows ("01", "1.50" not as a number would print)
  // and labels from the fourth; `n` stays numbers; `late` gains a column a
  // row after the header's width (ragged), its earlier rows missing.
  const csv = 'cell,plate,n\nc0,01,1\nc1,1.50,2\nc2,NA,3\nc3,A1,4\nc4,01,5,x\n';
  const table = await readTable(reader(csv), { cells: null, rowsHint: 5 });
  assert.equal(passes, 2, 'read again from its start only for the labels before row 3');
  assert.deepEqual(table.cellNames, ['c0', 'c1', 'c2', 'c3', 'c4']);
  assert.equal(table.numbers[1], null);
  assert.deepEqual([...table.numbers[2]], [1, 2, 3, 4, 5]);
  const plate = table.text[1];
  assert.deepEqual([...table.text[1].codes].map(code => (code < 0 ? null : plate.labels[code])), ['01', '1.50', null, 'A1', '01']);
  assert.deepEqual(table.names, ['cell', 'plate', 'n', 'column_4']);
  assert.deepEqual([...table.text[3].codes].map(code => (code < 0 ? null : table.text[3].labels[code])), [null, null, null, null, 'x']);
  assert.deepEqual(table.ragged, { line: 6, fields: 4 });
  // Its rows are the cells in order: the join gives its own columns, no copy.
  const joined = joinTable(table, 5);
  assert.equal(joined.columns.find(entry => entry.name === 'n').column.values, table.numbers[2]);
  // Without such a column, one pass.
  passes = 0;
  await readTable(reader('cell,a,b\nc0,1,x\nc1,2,y\n'), { cells: null });
  assert.equal(passes, 1);
  // R's write.csv: a header one shorter than the rows names all but the row names, which are the cells.
  const written = await readTable(reader('"UMAP_1","UMAP_2"\n"c0",1,2\n"c1",3,4\n'), { cells: ['c0', 'c1'] });
  assert.deepEqual(written.names, ['', 'UMAP_1', 'UMAP_2']);
  assert.deepEqual([...written.rowOf], [0, 1]);
  assert.deepEqual(joinTable(written, 2).obsm.map(entry => [...entry.values]), [[1, 3, 2, 4]]);
  // A kept field is a string of its own, with the same text.
  assert.equal(ownText('é,ü x'.split(',')[1]), 'ü x');
});

test('the edges of a k-nearest-neighbour graph cost what their arrays say, and past the device are refused before any is made', async () => {
  const { connectivityEdgeBytes } = await import('../assets/js/data/connectivity-edges.js');
  // 50M cells, 14 stored neighbours each (k = 15): 350M edges.
  const plan = connectivityEdgeBytes({ nCells: 50_000_000, nnz: 700_000_000, float32: true });
  assert.equal(plan.edges, 350_000_000);
  // Held: the forward adjacency, a partner and a strength an edge (8 B) and
  // one offset a cell; the build adds the next due edge of each cell.
  assert.equal(plan.held, 8 * 350_000_000 + 4 * 50_000_001);
  assert.equal(plan.build, plan.held + 4 * 50_000_000);
  assert.ok(plan.held < 3.1e9 && plan.build < 3.3e9, 'within a 16 GB device: scale-50m-100m.md L-12');
  // float64 weights are held whole beside the strengths they become.
  assert.equal(connectivityEdgeBytes({ nCells: 50_000_000, nnz: 700_000_000, float32: false }).build, plan.build + 8 * 350_000_000);
  // 10M cells: 70M edges, 0.6 GB to hold.
  assert.ok(connectivityEdgeBytes({ nCells: 10_000_000, nnz: 140_000_000, float32: true }).held < 0.61e9);
});
