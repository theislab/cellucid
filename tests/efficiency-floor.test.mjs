/**
 * The efficiency floor, held: every element the viewer reads, at every
 * share, fetches no stored chunk outside its floor and no chunk twice.
 *
 * The floor of a read is the set of stored chunks that hold any element it
 * needs, computed here from the store's own layout (the tree's chunk shapes
 * and, for a sparse matrix, its row pointers) independently of the reader.
 * The store is an in-memory Zarr store (`helpers/anndata-store.mjs`) whose
 * every chunk is its own key, so what the reader fetched is known chunk by
 * chunk and the ratio of fetched bytes to the floor's is exact: it must be
 * 1.00 (every chunk of the floor fetched once, none beside it). The same
 * floor over real files, real links and the HDF5 reader is measured by
 * `scripts/efficiency-floor.mjs`.
 *
 * Elements: obs (categorical codes, continuous, boolean, strings), obsm
 * embeddings in 2 and 3 dimensions (switching back to one read before is
 * the page's: `base-anndata-adapter.js` keeps it), a velocity
 * field, a neighbor graph's induced subgraph, X as CSR (a gene builds the
 * kept rows' gene index: their entries, nothing else), CSC (a gene's
 * entries) and dense (the gene's column chunks of kept rows), a layer,
 * raw.X, the stored outlier quantiles, and a priority-ordered file's
 * gene-major X read as the kept prefix of each gene. Shares: every cell,
 * 10% blocks, 1% uniform. The same store as Zarr v3 with every array
 * sharded (four chunks a shard along the cells): its inner chunks are held
 * to the same floor, and each shard index is read once. A later visit of a
 * remote file whose parts this browser kept (`formats/io/kept-parts.js`):
 * its floor is nothing for what an earlier visit read, and a gene not read
 * before fetches no more than its own floor. A Zarr folder on a web host
 * fetches no object twice in a tab: a field read again, and a larger share
 * opened in a new reader of the same store version (the page's range cache,
 * `storeObjects`; a read split by held pieces is priced by the link, in
 * `formats-io-contract`).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// The plans asserted here weigh this machine's speed: held at rest (`helpers/machine-at-rest.mjs`).
import './helpers/machine-at-rest.mjs';

import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { blocksPriorityOrder, priorityOrder } from '../assets/js/data/subsample.js';
import { SLAB_BYTES, readFloat32 } from '../assets/js/data/anndata/values.js';
import { gatheredArray, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';
import { numericDtype } from '../assets/js/formats/store.js';
import {
  annData, array, categorical, countingShardedStore, countingStore, dataFrame, dense, group, mapping, sparse, strings, zarrEntries,
} from './helpers/anndata-store.mjs';
import { until } from './helpers/until.mjs';

const N = 6000;
const G = 40;
const LATENT = 30;
const CELL_CHUNK = 250;
const ENTRY_CHUNK = 512;

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

/** A cells x genes matrix with about four genes per cell: CSR (by cell) and CSC (by gene). */
function matrix(seed, rowsOrder = null) {
  const next = random(seed);
  const rows = [];
  for (let cell = 0; cell < N; cell++) {
    const genes = new Set();
    while (genes.size < 4) genes.add(Math.floor(next() * G));
    rows.push([...genes].sort((a, b) => a - b).map(gene => [gene, 1 + Math.floor(next() * 9)]));
  }
  const ordered = rowsOrder === null ? rows : Array.from(rowsOrder, position => rows[position]);
  const csr = { indptr: [0], indices: [], data: [] };
  ordered.forEach(row => {
    for (const [gene, value] of row) { csr.indices.push(gene); csr.data.push(value); }
    csr.indptr.push(csr.indices.length);
  });
  const byGene = Array.from({ length: G }, () => []);
  ordered.forEach((row, r) => { for (const [gene, value] of row) byGene[gene].push([r, value]); });
  const csc = { indptr: [0], indices: [], data: [] };
  for (const entries of byGene) {
    for (const [r, value] of entries) { csc.indices.push(r); csc.data.push(value); }
    csc.indptr.push(csc.indices.length);
  }
  return { csr, csc };
}

/** A symmetric neighbor graph of the stored rows (no self-loops): about six neighbors a cell. */
function graphOf(seed) {
  const next = random(seed);
  const rows = Array.from({ length: N }, () => new Map());
  for (let r = 0; r < N; r++) {
    for (let k = 0; k < 3; k++) {
      const c = Math.floor(next() * N);
      if (c === r) continue;
      const weight = Math.fround(0.5 + ((Math.min(r, c) * 31 + Math.max(r, c)) % 97) / 200);
      rows[r].set(c, weight);
      rows[c].set(r, weight);
    }
  }
  const parts = { indptr: [0], indices: [], data: [] };
  for (const row of rows) {
    for (const c of [...row.keys()].sort((x, y) => x - y)) { parts.indices.push(c); parts.data.push(row.get(c)); }
    parts.indptr.push(parts.indices.length);
  }
  return parts;
}

function sparseNode(format, parts, shape = [N, G], chunks = ENTRY_CHUNK) {
  return sparse({
    format,
    data: Float32Array.from(parts.data),
    indices: Int32Array.from(parts.indices),
    indptr: Int32Array.from(parts.indptr),
    shape,
    chunks,
  });
}

/**
 * One store of every element; `X` in `layout`; a priority-ordered file when
 * `priority`. `entryChunk`: X's entries a chunk (a served store's: 2^14).
 */
function storeTree(layout, { priority = false, entryChunk = ENTRY_CHUNK } = {}) {
  const next = random(11);
  const order = priority ? priorityOrder({ method: 'uniform', nObs: N, k: N, seed: 0 }, Uint32Array.from({ length: N }, (_, i) => i)) : null;
  const row = position => (order === null ? position : order[position]);
  const cellChunks = { chunks: [CELL_CHUNK] };
  const codes = Int8Array.from({ length: N }, (_, r) => row(r) % 7);
  const umap = Float32Array.from({ length: N * 2 }, () => next());
  const { csr, csc } = matrix(5, order);
  const X = layout === 'csr' ? sparseNode('csr', csr, [N, G], entryChunk)
    : layout === 'csc' ? sparseNode('csc', csc, [N, G], entryChunk)
      : dense(Float32Array.from({ length: N * G }, (_, i) => (i % 5 === 0 ? i % 13 : 0)), [N, G], { chunks: [CELL_CHUNK, 8] });
  const graph = graphOf(9);
  const obsColumns = {
    cluster: categorical(codes, Array.from({ length: 7 }, (_, c) => `c${c}`)),
    score: array(Float32Array.from({ length: N }, () => next()), cellChunks),
    flag: array(Uint8Array.from({ length: N }, (_, r) => row(r) % 3 === 0 ? 1 : 0), { dtype: '|b1', ...cellChunks }),
    note: strings(Array.from({ length: N }, (_, r) => `note-${row(r)}`), cellChunks),
  };
  obsColumns.cluster.children.codes.chunks = [CELL_CHUNK];
  if (priority) obsColumns.cellucid_original_position = array(Uint32Array.from(order), { dtype: '<u4', ...cellChunks });
  const uns = { outlier: array(Float32Array.from({ length: N }, () => next()), cellChunks) };
  const children = {
    obs: dataFrame({ _index: strings(Array.from({ length: N }, (_, r) => `cell-${row(r)}`), cellChunks), ...obsColumns }),
    var: dataFrame({ _index: strings(Array.from({ length: G }, (_, g) => `g${g}`)) }),
    obsm: mapping({
      X_umap: dense(umap, [N, 2], { chunks: [CELL_CHUNK, 2] }),
      X_3d: dense(Float32Array.from({ length: N * 3 }, () => next()), [N, 3], { chunks: [CELL_CHUNK, 3] }),
      velocity_umap: dense(Float32Array.from({ length: N * 2 }, () => next() - 0.5), [N, 2], { chunks: [CELL_CHUNK, 2] }),
      // A latent space of thirty columns in one chunk of whole rows, as a
      // served store answers it: its values' bytes, read in part.
      X_pca: dense(Float32Array.from({ length: N * LATENT }, () => next()), [N, LATENT], { chunks: [N, LATENT] }),
    }),
    obsp: mapping({ connectivities: sparseNode('csr', graph, [N, N]) }),
    layers: mapping({ counts: sparseNode('csr', csr) }),
    raw: mapping({ X: sparseNode('csr', csr), var: dataFrame({ _index: strings(Array.from({ length: G }, (_, g) => `g${g}`)) }) }),
    X,
    uns: mapping({
      cellucid: mapping({
        schema: scalar(1),
        outlierQuantiles: mapping({
          latentKey: textScalar('X_umap'),
          minPoints: scalar(10),
          fields: mapping({ cluster: uns.outlier }),
        }),
        ...(priority ? { priority: mapping({ seed: scalar(0), specVersion: scalar(1), nObs: scalar(N), levels: array(BigInt64Array.from(levelsOf(N), BigInt), { dtype: '<i8' }) }) } : {}),
      }),
    }),
  };
  if (priority) {
    const levels = levelsOf(N);
    const counts = new Uint32Array(G * levels.length);
    for (let g = 0; g < G; g++) {
      for (let j = 0; j < levels.length; j++) {
        let count = 0;
        for (let e = csc.indptr[g]; e < csc.indptr[g + 1]; e++) if (csc.indices[e] < levels[j]) count++;
        counts[g * levels.length + j] = count;
      }
    }
    children.varm = mapping({ cellucid_prefix_counts: dense(counts, [G, levels.length], { dtype: '<u4', chunks: [G, 1] }) });
  }
  return { tree: annData(children), csr, csc, graph, order };
}

function scalar(value) {
  return array(BigInt64Array.from([BigInt(value)]), { dtype: '<i8', shape: [], chunks: [], attrs: { 'encoding-type': 'numeric-scalar', 'encoding-version': '0.2.0' } });
}

function textScalar(value) {
  return array([value], { dtype: '|O', shape: [], chunks: [], attrs: { 'encoding-type': 'string', 'encoding-version': '0.2.0' } });
}

/** The prefix sizes a priority file counts at (the specification's, `prefix_levels`). */
function levelsOf(n) {
  const levels = [];
  let level = n;
  for (;;) {
    level = Math.floor(level * 3 / 4);
    if (level < 1 || (levels.length > 0 && level === levels.at(-1))) break;
    levels.push(level);
  }
  return levels.reverse();
}

// ------------------------------------------------------------------- floor

/** Chunk keys of a row-chunked array (`chunkRows` rows each) holding any of `ranges`. */
function rowChunkKeys(path, ranges, chunkRows, suffix = '') {
  const keys = new Set();
  for (const [start, end] of ranges) {
    for (let c = Math.floor(start / chunkRows); c <= Math.floor((end - 1) / chunkRows); c++) keys.add(`${path}/${c}${suffix}`);
  }
  return keys;
}

function runsOf(rows) {
  const sorted = Array.from(rows).sort((a, b) => a - b);
  const runs = [];
  for (const r of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === r) last[1]++;
    else runs.push([r, r + 1]);
  }
  return runs;
}

/** The kept rows' entry ranges of a compressed matrix. */
function entryRanges(indptr, runs) {
  return runs.map(([r0, r1]) => [indptr[r0], indptr[r1]]).filter(([s, e]) => e > s);
}

/** The floor of one step: the chunk keys it must fetch (`floors`), by element. */
function floorsOf({ csr, csc, graph }, layout, keptRuns, keptRows, prefix) {
  const cells = keptRuns;
  const union = (...sets) => new Set(sets.flatMap(set => [...set]));
  const pointerRuns = cells.map(([r0, r1]) => [r0, r1 + 1]);
  const csrFloor = (path, parts) => union(
    rowChunkKeys(`${path}/indptr`, pointerRuns, CELL_CHUNK_OF_POINTERS),
    rowChunkKeys(`${path}/indices`, entryRanges(parts.indptr, cells), ENTRY_CHUNK),
    rowChunkKeys(`${path}/data`, entryRanges(parts.indptr, cells), ENTRY_CHUNK),
  );
  const kept = new Uint8Array(N);
  for (const r of keptRows) kept[r] = 1;
  const graphEntries = entryRanges(graph.indptr, cells);
  const graphData = [];
  for (const [s, e] of graphEntries) for (let p = s; p < e; p++) if (kept[graph.indices[p]] === 1) graphData.push(p);
  const gene = 3;
  let X;
  if (layout === 'csr') X = csrFloor('X', csr);
  else if (layout === 'csc') {
    const start = csc.indptr[gene];
    let end = csc.indptr[gene + 1];
    if (prefix !== null) {
      let p = start;
      while (p < end && csc.indices[p] < prefix) p++;
      end = p;
    }
    // A foreign gene-major gene of a subsample: its whole index, the values
    // of its kept entries only (read after the index; a local store's round
    // trip costs nothing).
    const keptEntries = [];
    for (let p = start; p < end; p++) if (prefix !== null || keptRows.length === N || kept[csc.indices[p]] === 1) keptEntries.push(p);
    X = union(rowChunkKeys('X/indptr', [[0, G + 1]], G + 1), end > start ? rowChunkKeys('X/indices', [[start, end]], ENTRY_CHUNK) : new Set(),
      keptEntries.length > 0 ? rowChunkKeys('X/data', runsOf(keptEntries), ENTRY_CHUNK) : new Set());
    if (prefix !== null) X = union(X, new Set(['varm/cellucid_prefix_counts/0.' + levelColumn(prefix)]));
  } else X = rowChunkKeys('X', cells, CELL_CHUNK, `.${Math.floor(gene / 8)}`);
  return {
    'obs categorical': union(rowChunkKeys('obs/cluster/codes', cells, CELL_CHUNK), new Set(['obs/cluster/categories/0'])),
    'obs continuous': rowChunkKeys('obs/score', cells, CELL_CHUNK),
    'obs boolean': rowChunkKeys('obs/flag', cells, CELL_CHUNK),
    'obs strings': rowChunkKeys('obs/note', cells, CELL_CHUNK),
    'obsm 2D': rowChunkKeys('obsm/X_umap', cells, CELL_CHUNK, '.0'),
    'obsm 3D': rowChunkKeys('obsm/X_3d', cells, CELL_CHUNK, '.0'),
    'vector field': rowChunkKeys('obsm/velocity_umap', cells, CELL_CHUNK, '.0'),
    'obsp graph': union(
      rowChunkKeys('obsp/connectivities/indptr', pointerRuns, CELL_CHUNK_OF_POINTERS),
      rowChunkKeys('obsp/connectivities/indices', graphEntries, ENTRY_CHUNK),
      rowChunkKeys('obsp/connectivities/data', runsOf(graphData), ENTRY_CHUNK),
    ),
    [`X ${layout} gene`]: X,
    'layer gene': csrFloor('layers/counts', csr),
    'raw.X gene': csrFloor('raw/X', csr),
    'stored outlier quantiles': rowChunkKeys('uns/cellucid/outlierQuantiles/fields/cluster', cells, CELL_CHUNK),
  };
}

/** A compressed matrix's `indptr` is chunked by the entry chunk (`sparse` gives its arrays one chunk length). */
const CELL_CHUNK_OF_POINTERS = ENTRY_CHUNK;

let levelColumnOf = null;
function levelColumn(prefix) {
  return levelColumnOf(prefix);
}

// --------------------------------------------------------------------- run

async function measure(layout, request, { priority = false, sharded = false } = {}) {
  const built = storeTree(layout, { priority });
  const levels = levelsOf(N);
  // The column a prefix of k rows is read from: the first level at or above k.
  levelColumnOf = k => levels.findIndex(level => level >= k);
  // Sharded: the same chunks as inner chunks of Zarr v3 shards of four,
  // counted chunk by chunk under the same names, and every shard index read.
  const counted = sharded ? countingShardedStore(built.tree) : countingStore(built.tree);
  const { store, fetched, reads = null } = counted;
  const root = await openZarr(store, { decodedChunkCacheBytes: 64 * 1024 * 1024 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'floor.zarr', decodedChunkBytes: 64 * 1024 * 1024, cellSubset: request });
  const subset = reader.cellSubset;
  // The kept file rows: original positions, through the file's order.
  let keptRows;
  if (subset?.kept == null) keptRows = Uint32Array.from({ length: N }, (_, i) => i);
  else if (built.order === null) keptRows = Uint32Array.from(subset.kept);
  else {
    const rowOf = new Uint32Array(N);
    built.order.forEach((position, r) => { rowOf[position] = r; });
    keptRows = Uint32Array.from(subset.kept, position => rowOf[position]).sort();
  }
  const keptRuns = runsOf(keptRows);
  const prefix = priority && keptRuns.length === 1 && keptRuns[0][0] === 0 && subset?.kept != null ? keptRuns[0][1] : null;
  const floors = floorsOf(built, layout, keptRuns, keptRows, prefix);
  const steps = {
    'obs categorical': () => reader.getObsField('cluster'),
    'obs continuous': () => reader.getObsField('score'),
    'obs boolean': () => reader.getObsField('flag'),
    'obs strings': () => reader.getObsField('note'),
    'obsm 2D': () => reader.readEmbedding('X_umap', [0, 1], false),
    'obsm 3D': () => reader.readEmbedding('X_3d', [0, 1, 2], false),
    'vector field': () => reader.readVectorField('velocity_umap', [0, 1], { key: 'X_umap', columns: [0, 1] }, false),
    'obsp graph': () => reader.getConnectivityEdges('connectivities'),
    [`X ${layout} gene`]: () => reader.getMatrixColumn('X', 3),
    'layer gene': () => reader.getMatrixColumn('layers/counts', 3),
    'raw.X gene': () => reader.getMatrixColumn('raw/X', 3),
    'stored outlier quantiles': () => reader.readStoredOutlierQuantiles('cluster'),
  };
  const out = {};
  const bytes = {};
  const opened = fetched.length;
  // What opening fetched: nothing of these elements but a priority file's
  // first position chunk and the prefix counts column read at open.
  out.open = fetched.slice(0, opened);
  for (const [element, read] of Object.entries(steps)) {
    const mark = fetched.length;
    const readMark = reads?.length ?? 0;
    await read();
    // An element may be read again by a later step (the 2D embedding by the
    // velocity field): what each step fetched is its own.
    out[element] = fetched.slice(mark);
    bytes[element] = reads?.slice(readMark) ?? null;
  }
  reader.close();
  return { fetched: out, bytes, floors, entries: zarrEntries(built.tree), cells: keptRows.length, indexes: counted.indexes ?? null };
}

const SHARES = [
  ['every cell', { mode: 'all' }],
  ['10% blocks', { mode: 'subsample', method: 'blocks', fraction: 0.1, seed: 2 }],
  ['1% uniform', { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 2 }],
];

const bytesOf = (keys, entries) => keys.reduce((sum, key) => sum + entries.get(key).length, 0);

for (const layout of ['csr', 'csc', 'dense']) {
  for (const [label, request] of SHARES) {
    test(`${layout} X, ${label}: every element fetches its floor, once, and nothing beside it`, async () => {
      const { fetched, bytes, floors, entries } = await measure(layout, request);
      for (const [element, floor] of Object.entries(floors)) {
        const got = fetched[element];
        const outside = got.filter(key => !floor.has(key));
        // The 2D embedding a velocity field is scaled by is the page's: read once, by its own step.
        assert.deepEqual(outside, [], `${element}: chunks outside the floor`);
        // The store's chunks are their values' bytes (uncompressed), read
        // whole or in part: no byte of one is fetched twice.
        assert.deepEqual(readTwice(bytes[element]), [], `${element}: chunk bytes fetched twice`);
        const floorBytes = bytesOf([...floor].filter(key => got.includes(key) || !fetchedEarlier(fetched, element, key)), entries);
        const ratio = floorBytes === 0 ? 1 : fetchedBytes(bytes[element]) / floorBytes;
        assert.ok(ratio <= 1, `${element}: ${ratio.toFixed(2)} x the floor`);
      }
    });
  }
}

for (const layout of ['csr', 'csc', 'dense']) {
  for (const [label, request] of SHARES) {
    test(`Zarr v3 sharded, ${layout} X, ${label}: every element fetches its floor's inner chunks, once, and each shard index once`, async () => {
      const { fetched, floors, entries, indexes } = await measure(layout, request, { sharded: true });
      for (const [element, floor] of Object.entries(floors)) {
        const got = fetched[element];
        assert.deepEqual(got.filter(key => !floor.has(key)), [], `${element}: inner chunks outside the floor`);
        assert.deepEqual(got.filter((key, i) => got.indexOf(key) !== i), [], `${element}: inner chunks fetched twice`);
        const floorBytes = bytesOf([...floor].filter(key => got.includes(key) || !fetchedEarlier(fetched, element, key)), entries);
        const ratio = floorBytes === 0 ? 1 : bytesOf(got, entries) / floorBytes;
        assert.ok(ratio <= 1, `${element}: ${ratio.toFixed(2)} x the floor`);
      }
      assert.ok(indexes.length > 0, 'read through shard indexes');
      assert.deepEqual(indexes.filter((key, i) => indexes.indexOf(key) !== i), [], 'a shard index read twice');
    });
  }
}

/** The bytes of `reads` (`countingStore`'s `{key, start, end}`). */
function fetchedBytes(reads) {
  return reads.reduce((sum, read) => sum + read.end - read.start, 0);
}

/** The chunk keys of `reads` some byte of which was read more than once. */
function readTwice(reads) {
  const byKey = new Map();
  for (const read of reads) {
    if (!byKey.has(read.key)) byKey.set(read.key, []);
    byKey.get(read.key).push([read.start, read.end]);
  }
  const twice = [];
  for (const [key, ranges] of byKey) {
    ranges.sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const [start, stop] of ranges) {
      if (start < end) {
        twice.push(key);
        break;
      }
      end = Math.max(end, stop);
    }
  }
  return twice;
}

/** Whether a floor chunk was fetched by an earlier step (an ideal reader keeps it). */
function fetchedEarlier(fetched, element, key) {
  for (const [name, keys] of Object.entries(fetched)) {
    if (name === element) return false;
    if (keys.includes(key)) return true;
  }
  return false;
}

test('a priority-ordered file: a uniform subsample under its seed reads only the prefix of every array and of each gene', async () => {
  for (const fraction of [0.1, 0.01]) {
    const { fetched, floors } = await measure('csc', { mode: 'subsample', method: 'uniform', fraction, seed: 0 }, { priority: true });
    for (const [element, floor] of Object.entries(floors)) {
      const outside = fetched[element].filter(key => !floor.has(key) && !key.startsWith('varm/cellucid_prefix_counts/'));
      assert.deepEqual(outside, [], `${fraction}: ${element}: chunks outside the prefix floor`);
    }
    // Opening reads the record, the first position chunk, the prefix counts'
    // column and X's gene pointers (one per gene, whatever the cells: the
    // first gene is then one round trip), no stored value.
    assert.deepEqual(fetched.open.filter(key => key.startsWith('X/') && !key.startsWith('X/indptr/')), [], `${fraction}: opening reads no matrix value`);
  }
});

test('a priority-ordered file\'s rows at a share under its seed (a cell export) read each gene\'s prefix alone, never every chunk of X', async () => {
  const built = storeTree('csc', { priority: true });
  const levels = levelsOf(N);
  for (const request of [{ mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 0 }, { mode: 'subsample', method: 'uniform', fraction: 0.1, seed: 0 }, { mode: 'all' }]) {
    const { store, fetched } = countingStore(built.tree);
    const root = await openZarr(store, { decodedChunkCacheBytes: 64 * 1024 * 1024 });
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'floor.zarr', decodedChunkBytes: 64 * 1024 * 1024, cellSubset: request });
    const k = reader.nObs;
    // An export's cells: every third open cell, listed descending (not the stored order).
    const cells = Array.from({ length: Math.ceil(k / 3) }, (_, i) => k - 1 - i * 3);
    const mark = fetched.length;
    const parts = [];
    const read = await reader.readMatrixRows('X', cells, { partEntries: 50, onPart: part => parts.push(part) });
    const keys = fetched.slice(mark);
    // Open cell i is file row i (the prefix): its row as stored.
    let next = 0;
    for (const part of parts) {
      assert.equal(part.first, next, 'parts in the cells\' order');
      for (let i = 0; i < part.count; i++) {
        const row = cells[part.first + i];
        const from = built.csr.indptr[row];
        const to = built.csr.indptr[row + 1];
        assert.deepEqual(Array.from(part.genes.subarray(part.pointers[i], part.pointers[i + 1])), built.csr.indices.slice(from, to), `row ${row}'s genes`);
        assert.deepEqual(Array.from(part.values.subarray(part.pointers[i], part.pointers[i + 1])), built.csr.data.slice(from, to), `row ${row}'s values`);
      }
      next += part.count;
    }
    assert.equal(next, cells.length);
    assert.equal(read.cells, cells.length);
    if (request.mode === 'all') continue;
    // The floor: each gene's entries below the level read (the smallest at
    // or above the prefix) and the next one, in the chunks they lie in.
    const level = levels.find(size => size >= k);
    const floor = new Set();
    for (let g = 0; g < G; g++) {
      let end = built.csc.indptr[g];
      while (end < built.csc.indptr[g + 1] && built.csc.indices[end] < level) end++;
      end = Math.min(built.csc.indptr[g + 1], end + 1);
      if (end > built.csc.indptr[g]) for (const array of ['indices', 'data']) for (const key of rowChunkKeys(`X/${array}`, [[built.csc.indptr[g], end]], ENTRY_CHUNK)) floor.add(key);
    }
    const values = keys.filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/'));
    assert.deepEqual(values.filter(key => !floor.has(key)), [], `${request.fraction}: X chunks outside the genes' prefixes`);
    assert.deepEqual(values.filter((key, i) => values.indexOf(key) !== i), [], `${request.fraction}: an X chunk read twice`);
    const every = zarrEntries(built.tree);
    const all = [...every.keys()].filter(key => key.startsWith('X/indices/') || key.startsWith('X/data/')).length;
    assert.ok(values.length < all, `${request.fraction}: ${values.length} of ${all} X chunks`);
    reader.close();
  }
});

test('opening a subsample of a cell-major matrix reads no row pointer; a gene reads only the kept rows\'', async () => {
  const built = storeTree('csr');
  const { store, fetched } = countingStore(built.tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'floor.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 4 } });
  const pointerChunks = () => fetched.filter(key => /\/indptr\//.test(key));
  assert.deepEqual(pointerChunks(), [], 'opening reads no indptr of X, a layer, raw.X or a graph');
  await reader.getMatrixColumn('X', 3);
  const kept = runsOf(Uint32Array.from(reader.cellSubset.kept));
  const floor = rowChunkKeys('X/indptr', kept.map(([r0, r1]) => [r0, r1 + 1]), ENTRY_CHUNK);
  assert.ok(pointerChunks().length > 0 && pointerChunks().every(key => floor.has(key)), 'a gene reads the kept rows\' pointers only');
  assert.ok(pointerChunks().every(key => key.startsWith('X/')), 'and only X\'s: a layer\'s are read when the layer is');
  reader.close();
});

test('a gene sample of a CSR atlas opened whole reads its own rows\' pointers, indices and values once, nothing for later genes, and cells past it their own rows\'', async () => {
  // Every cell open in the default blocks subsample's order, genes read for
  // the first open cells (the gene sample, `geneSampleOf`): its first gene
  // fetches the pointer chunks of the sample's rows (never every open row's:
  // a CELLxGENE atlas's 11.4M-cell sample of 2,011 read its whole `indptr`,
  // 4,379 requests), the index chunks of their entries, and their value
  // chunks with them (stored compressed: bought, `buysValues`); each chunk
  // once, one request a chunk here, and a later gene reads nothing -- even
  // when the first gene has no entry among the sample's cells (gene 3 here:
  // a rare gene read first made each later gene read its own chunks).
  const nObs = 40_000;
  const nVars = 50;
  const next = random(17);
  const data = [];
  const indices = [];
  const indptr = [0];
  for (let cell = 0; cell < nObs; cell++) {
    for (let gene = 0; gene < nVars; gene++) {
      if (next() < (gene === 3 ? 0 : 0.12)) {
        indices.push(gene);
        data.push(1 + Math.floor(next() * 5));
      }
    }
    indptr.push(data.length);
  }
  const X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [nObs, nVars], compressed: true });
  X.children.data.chunks = [1024];
  X.children.indices.chunks = [1024];
  X.children.indptr.chunks = [256];
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: nObs }, (_, i) => `c${i}`), { chunks: [5000] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: nVars }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: nObs * 2 }, (_, i) => i), [nObs, 2], { chunks: [5000, 2], compressed: true }) }),
    X,
  });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const snapshot = { measured: true, latencyMs: 50, bytesPerMs: 2, concurrency: 6, shapingConcurrency: 6, mergeGapBytes: 0, roundTripBytes: 100, readsAhead: false };
  const link = { readsAhead: false, mergeGapBytes: 0, roundTripBytes: 100, snapshot: () => snapshot, watchProtocol() {} };
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'atlas.zarr', link, cellSubset: { mode: 'auto' } });
  const sample = reader.geneSample;
  assert.ok(sample !== null && sample.cells > 0 && sample.cells * 10 < nObs, `a gene sample of a tenth of the cells at most (${sample?.cells})`);
  // The sample's file rows: the first open cells' (their names are their rows).
  const names = await reader.readObsNames();
  const sampleRows = Array.from(names.slice(0, sample.cells), name => Number(String(name).slice(1)));
  const rowRuns = runsOf(sampleRows);
  const floor = {
    indptr: rowChunkKeys('X/indptr', rowRuns.map(([r0, r1]) => [r0, r1 + 1]), 256),
    indices: rowChunkKeys('X/indices', entryRanges(indptr, rowRuns), 1024),
    data: rowChunkKeys('X/data', entryRanges(indptr, rowRuns), 1024),
  };
  const ofArray = (keys, name) => new Set(keys.filter(key => key.startsWith(`X/${name}/`)));
  const mark = fetched.length;
  await reader.getMatrixColumn('X', 3);
  const gene1 = fetched.slice(mark);
  assert.equal(new Set(gene1).size, gene1.length, 'no chunk fetched twice');
  for (const name of ['indptr', 'indices', 'data']) assert.deepEqual(ofArray(gene1, name), floor[name], `X/${name}: the sample's chunks, no other`);
  const allPointerChunks = Math.ceil((nObs + 1) / 256);
  assert.ok(floor.indptr.size * 4 < allPointerChunks, `the sample's pointer chunks (${floor.indptr.size}) are a few of the ${allPointerChunks}`);
  // The request count, pinned: one a chunk of the floor.
  assert.equal(gene1.length, floor.indptr.size + floor.indices.size + floor.data.size);
  const later = fetched.length;
  await reader.getMatrixColumn('X', 11);
  await reader.getMatrixColumns('X', [17, 29]);
  assert.deepEqual(fetched.slice(later), [], 'later genes read nothing: the values came with the first');
  // Cells past the sample, read by their own rows (a cell export, an
  // analysis naming them): their rows' pointer chunks only, never every
  // open row's.
  const past = [sample.cells + 5, nObs - 3];
  const pastFloor = rowChunkKeys('X/indptr', past.map(i => Number(String(names[i]).slice(1))).map(r => [r, r + 2]), 256);
  for (const read of [() => reader.getMatrixRows('X', past), () => reader.getMatrixCellSubset('X', past, [7, 11])]) {
    const before = fetched.length;
    await read();
    const pointerChunks = ofArray(fetched.slice(before), 'indptr');
    assert.ok([...pointerChunks].every(key => pastFloor.has(key)), `the named cells' pointer chunks only (${[...pointerChunks]})`);
  }
  reader.close();
});

test('every cell opened in a cell order reads a field over many slabs in the stored order: each chunk once, ascending', async () => {
  // Every cell of a file in its own order opens in the default blocks
  // subsample's order (`cellOrder`): the open cells are the file's blocks
  // shuffled. Read a slab of open cells at a time, each slab's chunks lie
  // all over the file, apart, and the byte reader joins none of them
  // (measured: 23_decisions_partial_reading.md). A read of many open cells
  // (`readRowsInStoreOrder`) asks the stored chunks in ascending order, wave
  // after wave, each wave's together.
  const nObs = 5_000_000;
  const chunkRows = 65_536;
  assert.ok(nObs * 8 > SLAB_BYTES, 'more than a slab of float64');
  const reads = [];
  const real = Object.freeze({
    kind: 'array',
    path: '/obs/score',
    name: 'score',
    attrs: {},
    attributeType: () => null,
    shape: [nObs],
    dtype: numericDtype('float', 8),
    chunks: [chunkRows],
    partialChunks: false,
    fillValue: 0,
    async read([[start, end]]) {
      reads.push([start, end]);
      const values = new Float64Array(end - start);
      for (let i = 0; i < values.length; i++) values[i] = start + i;
      return values;
    },
    async storedBytes() {
      return null;
    },
  });
  const order = blocksPriorityOrder(nObs, 0, chunkRows);
  const view = gatheredArray(real, runsOfPositions(order), { mergeGapBytes: () => 0 });
  const values = await readFloat32(view, 0, nObs, 'score');
  assert.equal(values.length, nObs);
  for (let i = 0; i < nObs; i += 9973) assert.equal(values[i], order[i], `open cell ${i} holds its file row's value`);
  // One read a stored chunk, each once, in ascending order across the slabs.
  assert.equal(reads.length, Math.ceil(nObs / chunkRows));
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i][0] >= reads[i - 1][1], `chunk at row ${reads[i][0]} asked after the one at ${reads[i - 1][0]}`);
});

test('a sharded Zarr array prices the shard indexes a read would read first: each shard once, one round trip, none once read', async () => {
  // The gene sample's price counts the index reads that find a read's
  // chunks (`chunkIndexReads`, `subsample-plan.js` `firstGeneReadCost`):
  // for a sharded Zarr v3 array, the index of each shard holding them (four
  // inner chunks a shard here) not read yet.
  const n = 4000;
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: n }, (_, i) => `c${i}`), { chunks: [250] }) }),
    var: dataFrame({ _index: strings(['g']) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: n * 2 }, (_, i) => i), [n, 2], { chunks: [250, 2] }) }),
  });
  const { store } = countingShardedStore(tree);
  const root = await openZarr(store, {});
  const embedding = root.get('obsm/X_umap');
  const price = await embedding.chunkIndexReads();
  // Inner chunks 0-3 and 8-9: shards 0 and 2, their indexes in one round trip.
  assert.deepEqual(price([[0, 3], [8, 9]]), { nodes: 2, levels: 1, steps: [2] });
  await embedding.read([[0, 1000], [0, 2]]);
  assert.deepEqual(price([[0, 3], [8, 9]]), { nodes: 1, levels: 1, steps: [1] }, 'the index read is not priced again');
  // An array not sharded finds its chunks by name: nothing to price.
  const { store: plain } = countingStore(tree);
  assert.equal(await (await openZarr(plain, {})).get('obsm/X_umap').chunkIndexReads(), null);
});

test('opening says what reading genes fetches without reading a pointer: the estimate meets the exact share for even rows', async () => {
  const { estimatedChunkShare, keptChunkShare } = await import('../assets/js/data/anndata/views/cell-subset.js');
  const nRows = 10_000;
  const perRow = 7;
  const pointers = Float64Array.from({ length: nRows + 1 }, (_, r) => r * perRow);
  for (const rows of [
    Uint32Array.from({ length: 100 }, (_, i) => i * 97),
    Uint32Array.from({ length: 1000 }, (_, i) => 5000 + i),
    Uint32Array.from({ length: nRows }, (_, i) => i),
  ]) {
    const exact = keptChunkShare(pointers, rows, 512);
    assert.equal(estimatedChunkShare(rows, nRows, nRows * perRow, 512), exact);
  }
  // A matrix of uneven rows: the estimate is the mean row's, the exact share replaces it once X is read.
  const uneven = Float64Array.from({ length: nRows + 1 }, (_, r) => r * perRow + (r % 2 === 0 ? 0 : 3));
  const rows = Uint32Array.from({ length: 300 }, (_, i) => i * 33);
  assert.ok(Math.abs(estimatedChunkShare(rows, nRows, uneven[nRows], 512) - keptChunkShare(uneven, rows, 512)) < 0.05);
});

test('a MuData subsample reads its modality columns and cell maps at the kept cells only', async () => {
  const { muDataView, MUDATA_ZARR_FORMAT } = await import('../assets/js/data/anndata/views/mudata.js');
  const n = 4000;
  const chunk = 200;
  const names = Array.from({ length: n }, (_, i) => `cell-${i}`);
  const modality = annData({
    obs: dataFrame({
      _index: strings(names, { chunks: [chunk] }),
      score: array(Float32Array.from({ length: n }, (_, i) => i / n), { chunks: [chunk] }),
    }),
    var: dataFrame({ _index: strings(['g0', 'g1']) }),
    X: dense(new Float32Array(n * 2), [n, 2], { chunks: [chunk, 2] }),
  });
  const tree = {
    kind: 'group',
    attrs: { 'encoding-type': 'MuData', 'encoding-version': '0.1.0', axis: 0 },
    children: {
      obs: dataFrame({ _index: strings(names, { chunks: [chunk] }) }),
      obsm: mapping({ X_umap: dense(new Float32Array(n * 2), [n, 2], { chunks: [chunk, 2] }) }),
      mod: { kind: 'group', attrs: { 'mod-order': ['rna'] }, children: { rna: modality } },
      obsmap: { kind: 'group', attrs: {}, children: { rna: array(Uint32Array.from(names, (_, i) => i + 1), { dtype: '<u4', chunks: [chunk] }) } },
    },
  };
  const { store, fetched } = countingStore(tree);
  const root = await muDataView(await openZarr(store, { decodedChunkCacheBytes: 0 }), { name: 'mu.zarr' });
  const reader = new AnnDataReader();
  await reader.open(root, { format: MUDATA_ZARR_FORMAT, name: 'mu.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'blocks', fraction: 0.02, seed: 1, blockSize: 40 } });
  const keptChunks = new Set(Array.from(reader.cellSubset.kept, position => Math.floor(position / chunk)));
  const mark = fetched.length;
  const field = await reader.getObsField('rna:score');
  assert.equal(field.values.length, reader.nObs);
  const read = fetched.slice(mark).filter(key => key.startsWith('mod/rna/obs/score/'));
  assert.ok(read.length > 0 && read.every(key => keptChunks.has(Number(key.slice(key.lastIndexOf('/') + 1)))),
    `the modality column reads the chunks of the kept cells' rows only: ${read.join(', ')}`);
  const maps = fetched.filter(key => key.startsWith('obsmap/rna/'));
  assert.ok(maps.every(key => keptChunks.has(Number(key.slice(key.lastIndexOf('/') + 1)))), `the cell map is read at the kept cells only: ${maps.join(', ')}`);
  reader.close();
});

test('a Loom matrix (genes x cells, read transposed): a gene reads only its strip\'s chunks that hold an open cell, once', async () => {
  const { LOOM_VIEW } = await import('../assets/js/data/anndata/views/loom.js');
  // Loom's own orientation and a loompy-like square chunk: a gene is a row
  // of `/matrix`, the cells its columns, so the kept cells select chunk
  // columns of the gene's strip of rows.
  const genes = 96;
  const geneChunk = 16;
  const cellChunk = 100;
  const values = Float32Array.from({ length: genes * N }, (_, i) => (i % 7 === 0 ? i % 11 : 0));
  const tree = group({
    matrix: dense(values, [genes, N], { chunks: [geneChunk, cellChunk], attrs: null }),
    col_attrs: group({
      CellID: strings(Array.from({ length: N }, (_, c) => `cell-${c}`), { chunks: [cellChunk], attrs: null }),
      X_umap: dense(Float32Array.from({ length: N * 2 }, (_, i) => i / N), [N, 2], { chunks: [cellChunk, 2], attrs: null }),
    }),
    row_attrs: group({ Gene: strings(Array.from({ length: genes }, (_, g) => `g${g}`), { attrs: null }) }),
  });
  // One gene in each of four strips: an uncompressed chunk's gene is one run
  // of its bytes, read alone (`formats/zarr/array.js`), so two genes of one
  // strip read two ranges of one chunk key.
  const asked = [3, 20, 40, 90];
  for (const [label, request] of [...SHARES, ['1% blocks', { mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 3 }]]) {
    const { store, fetched } = countingStore(tree, { name: 'floor.loom' });
    const root = await LOOM_VIEW.view(await openZarr(store, { decodedChunkCacheBytes: 64 * 1024 * 1024 }), { name: 'floor.loom' });
    const reader = new AnnDataReader();
    await reader.open(root, { format: LOOM_VIEW.readerFormat, name: 'floor.loom', decodedChunkBytes: 64 * 1024 * 1024, cellSubset: request });
    // The open cells in their open order (a uniform subsample's is its priority order).
    const kept = Uint32Array.from(await reader.readObsNames(), name => Number(name.slice('cell-'.length)));
    const keptColumns = new Set(Array.from(kept, cell => Math.floor(cell / cellChunk)));
    const floorOf = geneList => new Set(geneList.flatMap(gene => [...keptColumns].map(column => `matrix/${Math.floor(gene / geneChunk)}.${column}`)));
    const mark = fetched.length;
    const one = await reader.getMatrixColumn('X', asked[0]);
    assert.equal(one.length, reader.nObs);
    for (let i = 0; i < kept.length; i++) assert.equal(one[i], values[asked[0] * N + kept[i]], `${label}: cell ${kept[i]}`);
    const many = await reader.getMatrixColumns('X', asked.slice(1));
    many.forEach((column, k) => {
      for (let i = 0; i < kept.length; i++) assert.equal(column[i], values[asked[k + 1] * N + kept[i]], `${label}: gene ${asked[k + 1]}, cell ${kept[i]}`);
    });
    const got = fetched.slice(mark).filter(key => key.startsWith('matrix/'));
    const floor = floorOf(asked);
    assert.deepEqual(got.filter(key => !floor.has(key)), [], `${label}: /matrix chunks holding no open cell, or outside the genes' strips`);
    assert.deepEqual(got.filter((key, i) => got.indexOf(key) !== i), [], `${label}: /matrix chunks fetched twice`);
    assert.equal(new Set(got).size, floor.size, `${label}: every chunk of the floor fetched`);
    reader.close();
  }
});

for (const entryChunk of [16384, 2 ** 18]) test(`a served store at 1% (X in chunks of ${entryChunk} entries): an analysis over every gene and many genes read each gene's counted entries and the next, no other byte of X`, async () => {
  // As `cellucid serve` / `cellucid_serve` answer a dataset: priority order,
  // a gene-major X whose chunks are their values' bytes (2^18 entries a
  // chunk, `SERVED_ENTRY_CHUNK_ELEMENTS` / `.chunk_elements_served`: a request
  // over loopback costs more than a smaller chunk moves; 2^14 as a prepared
  // file's), the prefix counts beside it. A 1% uniform subsample under the
  // file's seed is its first k rows, and a gene's open values its first
  // entries: read in part, however large the chunk.
  const built = storeTree('csc', { priority: true, entryChunk });
  const { store, reads } = countingStore(built.tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'served.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 0 } });
  const k = reader.nObs;
  assert.equal(reader.cellSubset.prefix, k);
  // The counts probe samples a chunk read in part (raw, as served) as a
  // matrix stored in one piece: one row's worth of values, never the chunk.
  const probeMark = reads.length;
  await reader.probeMapping();
  const probed = reads.slice(probeMark).filter(read => /^X\/data\//.test(read.key));
  assert.ok(probed.length > 0 && probed.every(read => read.end - read.start <= G * 4), `the counts probe read ${JSON.stringify(probed)}`);
  const levels = levelsOf(N);
  const level = levels.find(size => size >= k);
  // The floor: each gene's entries below the level and the one after them.
  const floor = [];
  for (let g = 0; g < G; g++) {
    const start = built.csc.indptr[g];
    const end = built.csc.indptr[g + 1];
    let counted = start;
    while (counted < end && built.csc.indices[counted] < level) counted++;
    floor.push([start * 4, Math.min(end, counted + 1) * 4]);
  }
  const genes = Array.from({ length: G }, (_, g) => g);
  const every = Array.from({ length: k }, (_, cell) => cell);
  const twoGroups = every.filter(cell => cell % 3 !== 0 && cell !== k - 1);
  for (const [label, read] of [
    ['every gene', () => reader.getMatrixColumns('X', genes)],
    ['an analysis of every open cell (a group against the rest)', () => reader.getMatrixCellSubset('X', every, genes)],
    ['an analysis of two groups', () => reader.getMatrixCellSubset('X', twoGroups, genes)],
  ]) {
    const mark = reads.length;
    const result = await read();
    if (!Array.isArray(result)) {
      // Every open cell's value, as the stored matrix holds it.
      for (let g = 0; g < G; g++) {
        for (let e = result.pointers[g]; e < result.pointers[g + 1]; e++) assert.ok(result.cellIndex[e] >= 0);
      }
    }
    const matrix = reads.slice(mark).filter(read => /^X\/(indices|data)\//.test(read.key));
    assert.ok(matrix.length > 0, `${label}: X is read`);
    const outside = matrix.filter(({ key, start, end }) => {
      const chunk = Number(key.slice(key.lastIndexOf('/') + 1)) * entryChunk * 4;
      return !floor.some(([from, to]) => chunk + start >= from && chunk + end <= to);
    });
    assert.deepEqual(outside, [], `${label}: bytes of X outside each gene's counted entries`);
    assert.deepEqual(readTwice(matrix.map(read => ({ ...read, key: read.key }))), [], `${label}: X bytes read twice`);
  }
  reader.close();
});

test('a latent space\'s columns of a subsample read the kept rows\' bytes, never the gaps between them', async () => {
  // In a chunk stored as its values' bytes (a served store's): each kept
  // run of rows is its own range of the chunk, two columns of thirty the
  // rows' bytes from the first column to the second.
  for (const [label, request, priority] of [
    ['1% uniform', { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 2 }, false],
    ['1% blocks', { mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 2, blockSize: 20 }, false],
    ['a served store\'s 1% (its prefix)', { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 0 }, true],
  ]) {
    const built = storeTree('csr', { priority });
    const { store, reads } = countingStore(built.tree);
    const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'latent.zarr', decodedChunkBytes: 0, cellSubset: request });
    const mark = reads.length;
    const columns = await reader.readObsmColumns('X_pca', [0, 1]);
    assert.equal(columns.length, reader.nObs * 2);
    const latent = reads.slice(mark).filter(read => read.key.startsWith('obsm/X_pca/'));
    const keptRows = reader.nObs;
    // The kept rows' bytes from their first column to their second: at most a whole row each.
    assert.ok(fetchedBytes(latent) <= keptRows * LATENT * 4, `${label}: ${fetchedBytes(latent)} bytes for ${keptRows} rows of ${LATENT * 4}`);
    assert.deepEqual(readTwice(latent), [], `${label}: latent bytes read twice`);
    reader.close();
  }
});

test('a latent space\'s columns of a subsample stored in one piece: two kept runs are joined only when the stored rows between them cost less than a request', async () => {
  const { gatheredArray, runsOfPositions } = await import('../assets/js/data/anndata/views/cell-subset.js');
  const width = 30;
  const values = Float32Array.from({ length: N * width }, (_, i) => i);
  const boxes = [];
  const real = {
    kind: 'array', path: '/obsm/X_pca', name: 'X_pca', attrs: {}, attributeType: () => null,
    shape: [N, width], dtype: '<f4', chunks: null, fillValue: 0,
    async read(selection) {
      const [[r0, r1], [c0, c1]] = selection;
      boxes.push([r0, r1]);
      const out = new Float32Array((r1 - r0) * (c1 - c0));
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) out[(r - r0) * (c1 - c0) + c - c0] = values[r * width + c];
      return out;
    },
    async storedBytes() { return 0; },
  };
  // Two blocks of 20 rows, 1,000 rows apart: 120 KB of stored rows between
  // them (8 KB of the two columns asked for), against a 64 KB merge gap.
  const kept = Uint32Array.from([...Array.from({ length: 20 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 1120 + i)]);
  const view = gatheredArray(real, runsOfPositions(kept), { mergeGapBytes: () => 64 * 1024 });
  const read = await view.read([[0, kept.length], [0, 2]]);
  assert.deepEqual(boxes, [[100, 120], [1120, 1140]], 'each block its own read');
  for (let i = 0; i < kept.length; i++) assert.equal(read[i * 2], values[kept[i] * width]);
  // Rows close enough that the stored bytes between them are cheaper than a request are one read.
  boxes.length = 0;
  const near = Uint32Array.from([...Array.from({ length: 20 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 200 + i)]);
  await gatheredArray(real, runsOfPositions(near), { mergeGapBytes: () => 64 * 1024 }).read([[0, near.length], [0, 2]]);
  assert.deepEqual(boxes, [[100, 220]]);
});

test('a later visit of a remote file kept in this browser: nothing it read before is fetched; a new gene fetches only its floor', async t => {
  const { anndataZarrZip } = await import('./browser/helpers/anndata-zarr-zip.mjs');
  const { opfsOnDisk, createLocks } = await import('./helpers/opfs-on-disk.mjs');
  const { openDatasetStore } = await import('../assets/js/data/anndata/open.js');
  const cells = 3000;
  const genes = 50;
  const csr = matrix(11).csr;
  const indptr = Int32Array.from(csr.indptr.slice(0, cells + 1));
  const used = indptr[cells];
  const bytes = anndataZarrZip({
    cells,
    genes: Array.from({ length: genes }, (_, g) => `g${g}`),
    X: { data: Float32Array.from(csr.data.slice(0, used)), indices: Int32Array.from(csr.indices.slice(0, used), gene => gene % genes), indptr },
    obsm: { X_umap: { data: Float32Array.from({ length: cells * 2 }, (_, i) => Math.cos(i)), columns: 2 } },
  });
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const original = globalThis.fetch;
  const fetched = { bytes: 0, requests: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
    fetched.requests++;
    fetched.bytes += end - start + 1;
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ETag: '"floor-v1"', 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const file = { url: 'https://floor.test/a.zarr.zip', size: bytes.length, name: 'a.zarr.zip', identity: { kind: 'remote', key: 'floor:a', version: 'census:floor' } };
  const visit = async geneList => {
    disk.environment.navigator.locks = createLocks();
    const opened = await openDatasetStore({ source: { file }, fromLink: true }, { decodedChunkCacheBytes: 0, transcoding: { environment: disk.environment, tab: 'tab' } });
    const reader = new AnnDataReader();
    await reader.open(opened.root, { format: opened.readerFormat, name: opened.name, link: opened.link, decodedBudget: opened.decodedBudget });
    const values = [Array.from(await reader.readObsmColumns('X_umap', [0, 1]).then(columns => columns.flatMap?.(column => Array.from(column)) ?? []))];
    for (const gene of geneList) values.push(Array.from(await reader.getMatrixColumn('X', gene)));
    samples.push(reader.geneSample);
    reader.close();
    // The batch kept is complete once its journal is closed (as its reader
    // closes, or its reads go quiet): its writing lock let go (`space.js`
    // `openKeptJournal`). Its directory is made only once that lock is
    // held, so a complete directory and no lock is a closed journal, never
    // one not yet begun.
    await until(() => {
      const parent = path.join(disk.root, 'cellucid-transcoded');
      const complete = existsSync(parent) && readdirSync(parent).some(name => existsSync(path.join(parent, name, 'manifest.json')));
      return complete && ![...disk.environment.navigator.locks.held.keys()].some(name => name.endsWith('#writing'));
    }, 'the kept batch completed');
    return values;
  };
  const samples = [];
  const first = await visit([3, 7]);
  assert.ok(fetched.bytes > 0);
  const before = { ...fetched };
  assert.deepEqual(await visit([3, 7]), first);
  // The later visit fetches nothing over the link: what it keeps -- the raw
  // values read by range too -- costs nothing, so its genes are read for
  // every cell, as on the first visit; a cell whose values were priced as
  // fetched would have no price at all.
  assert.deepEqual(samples, [null, null], 'genes read for every cell on both visits');
  assert.deepEqual({ bytes: fetched.bytes - before.bytes, requests: fetched.requests - before.requests }, { bytes: 0, requests: 0 }, 'the floor of what was read before is nothing');
});

test('a Zarr folder on a web host: a raised share in a new reader, and a field read again, fetch no chunk the tab fetched before', async t => {
  const { httpStore } = await import('../assets/js/formats/zarr/index.js');
  const { createByteRangeCache } = await import('../assets/js/data/byte-range-cache.js');
  const { adoptRangeCachePort } = await import('../assets/js/formats/io/range-cache.js');
  const cache = createByteRangeCache({ budgetBytes: 256 << 20 });
  const { port1, port2 } = new MessageChannel();
  cache.connect(port1);
  adoptRangeCachePort(port2);
  t.after(() => {
    adoptRangeCachePort(null);
    port1.close();
  });
  const entries = zarrEntries(storeTree('csr').tree);
  // A web host reads a folder from its consolidated metadata.
  const metadata = {};
  for (const [key, bytes] of entries) {
    if (/(^|\/)\.(zgroup|zattrs|zarray)$/.test(key)) metadata[key] = JSON.parse(new TextDecoder().decode(bytes));
  }
  entries.set('.zmetadata', new TextEncoder().encode(JSON.stringify({ zarr_consolidated_format: 1, metadata })));
  const fetched = [];
  const fetch = async url => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/floor\.zarr\//, ''));
    const bytes = entries.get(key);
    if (bytes === undefined) return new Response(null, { status: 404 });
    if (!/(^|\/)\.z(group|attrs|array|metadata)$/.test(key)) fetched.push(key);
    return new Response(bytes, { status: 200, headers: { ETag: '"floor-v1"' } });
  };
  const open = async cellSubset => {
    const root = await openZarr(httpStore('https://floor.test/floor.zarr/', { fetch }), { decodedChunkCacheBytes: 0 });
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'floor.zarr', decodedChunkBytes: 0, cellSubset });
    return reader;
  };
  // A first share, then the same field again (a page that let it go). What
  // a reader hands the page crosses to it before its next question on the
  // same port: nothing is waited for between them.
  const first = await open({ mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 4 });
  await first.getObsField('cluster');
  await first.readEmbedding('X_umap', [0, 1], false);
  await first.getMatrixColumn('X', 3);
  const before = fetched.length;
  await first.readEmbedding('X_umap', [0, 1], false);
  assert.equal(fetched.length, before, 'an embedding read again fetches nothing');
  // Every cell (Apply of a larger share): a new reader of the same store version.
  const every = await open({ mode: 'all' });
  await every.getObsField('cluster');
  await every.readEmbedding('X_umap', [0, 1], false);
  await every.getMatrixColumn('X', 3);
  first.close();
  every.close();
  const twice = fetched.filter((key, i) => fetched.indexOf(key) !== i);
  assert.deepEqual(twice, [], 'no chunk fetched twice in the tab');
  assert.ok(fetched.length > before, 'the larger share fetched what the first did not hold');
});

test('a Zarr folder named by its content on a host that shows no validator (GitHub\'s raw host): a new reader in the tab fetches no chunk fetched before', async t => {
  const { httpStore } = await import('../assets/js/formats/zarr/index.js');
  const { createByteRangeCache } = await import('../assets/js/data/byte-range-cache.js');
  const { adoptRangeCachePort } = await import('../assets/js/formats/io/range-cache.js');
  const cache = createByteRangeCache({ budgetBytes: 256 << 20 });
  const { port1, port2 } = new MessageChannel();
  cache.connect(port1);
  adoptRangeCachePort(port2);
  t.after(() => {
    adoptRangeCachePort(null);
    port1.close();
  });
  const entries = zarrEntries(storeTree('csr').tree);
  const metadata = {};
  for (const [key, bytes] of entries) {
    if (/(^|\/)\.(zgroup|zattrs|zarray)$/.test(key)) metadata[key] = JSON.parse(new TextDecoder().decode(bytes));
  }
  entries.set('.zmetadata', new TextEncoder().encode(JSON.stringify({ zarr_consolidated_format: 1, metadata })));
  const fetched = [];
  // No ETag, no Last-Modified: the metadata names no version.
  const fetch = async url => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/floor\.zarr\//, ''));
    const bytes = entries.get(key);
    if (bytes === undefined) return new Response(null, { status: 404 });
    if (!/(^|\/)\.z(group|attrs|array|metadata)$/.test(key)) fetched.push(key);
    return new Response(bytes, { status: 200 });
  };
  // Its provider names its content (the commit it is read at); nothing is kept in this browser here.
  const keeping = { version: `commit:${'9'.repeat(40)}`, open: async () => null };
  const open = async cellSubset => {
    const root = await openZarr(httpStore('https://floor.test/floor.zarr/', { fetch, keeping }), { decodedChunkCacheBytes: 0 });
    const reader = new AnnDataReader();
    await reader.open(root, { format: ZARR_FORMAT, name: 'floor.zarr', decodedChunkBytes: 0, cellSubset });
    return reader;
  };
  const first = await open({ mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 4 });
  await first.getObsField('cluster');
  await first.readEmbedding('X_umap', [0, 1], false);
  // Handed to the page before the next reader's questions, on the same port.
  const every = await open({ mode: 'all' });
  await every.getObsField('cluster');
  await every.readEmbedding('X_umap', [0, 1], false);
  first.close();
  every.close();
  const twice = fetched.filter((key, i) => fetched.indexOf(key) !== i);
  assert.deepEqual(twice, [], 'no chunk fetched twice in the tab');
});

test('the share grid judges each downstream against every cell of the same store: above 1.0 a break, far above s/n flagged, noise not', async () => {
  const { parseShare, ratioTable } = await import('../scripts/efficiency-floor/share-grid.mjs');
  assert.deepEqual(parseShare('10%u'), { text: '10%u', cells: '10%', sample: 'uniform', fraction: 0.1 });
  assert.deepEqual(parseShare('100%'), { text: '100%', cells: '100%', sample: null, fraction: 1 });
  assert.throws(() => parseShare('10'), /a share is a percentage/);
  const row = (share, step, ms, servedMB, servedRequests, detail = {}) => ({ store: 's', step, share, failure: null, ms, servedMB, servedRequests, rendererMB: 500, gpuProcessMB: 100, jsMB: 0, detail });
  const rows = [
    row('100%', 'gene', 1000, 10, 100, { loadMs: 900 }),
    row('1% uniform', 'gene', 1300, 3, 2, { loadMs: 1200 }),
    row('100%', 'open', 5000, 50, 40, { firstFrameMs: 800, settledMs: 5000 }),
    row('1% uniform', 'open', 700, 2, 30, { firstFrameMs: 760, settledMs: 900 }),
    { ...row('1% uniform', 'de', 1, 0, 0), failure: 'timeout' },
  ];
  const table = ratioTable(rows);
  const cell = (step, metric) => table.find(r => r.step === step && r.metric === metric);
  // A gene that takes longer at 1% than with every cell open breaks the rule (beyond the noise floor).
  assert.equal(cell('gene', 'loadMs').break, true);
  assert.equal(cell('gene', 'loadMs').ratio, 1.33);
  // Fewer bytes than every cell, but far from the share's fraction: flagged, not a break.
  assert.equal(cell('gene', 'MB').break, false);
  assert.equal(cell('gene', 'MB').far, true);
  // 760 vs 800 ms is no break; 30 requests vs 40 is far from s/n.
  assert.equal(cell('open', 'pictureMs').break, false);
  assert.equal(cell('open', 'requests').far, true);
  // Memory a few MB above is noise; a failed step is listed as such.
  assert.equal(cell('gene', 'rendererMB').break, false);
  assert.equal(table.find(r => r.step === 'de').failure, 'timeout');
  // Every cell ran out of its time: a share is judged against that bound, never a break.
  const bound = ratioTable([{ ...row('100%', 'export-h5ad', 900_000, 0, 0), failure: 'timeout 900000 ms' }, row('1% uniform', 'export-h5ad', 4_000, 2, 30, { ms: 3_900 })]);
  const step = bound.find(r => r.metric === 'stepMs');
  assert.equal(step.reference, 900_000);
  assert.equal(step.atLeast, true);
  assert.equal(step.break, false);
  // A smaller share above a larger one of the same kind breaks the rule too; a failure where the larger finished as well.
  const { monotonicBreaks } = await import('../scripts/efficiency-floor/share-grid.mjs');
  const above = monotonicBreaks([
    row('1% uniform', 'gene', 900, 2, 10, { loadMs: 800 }), row('10% uniform', 'gene', 600, 3, 12, { loadMs: 500 }),
    { ...row('10% uniform', 'filter', 1, 0, 0), failure: 'timeout 600000 ms' }, row('50% uniform', 'filter', 3700, 0, 0),
    row('1% blocks', 'gene', 300, 1, 5, { loadMs: 250 }),
  ]);
  assert.ok(above.some(r => r.metric === 'loadMs' && r.small === 800 && r.large === 500));
  assert.ok(above.some(r => r.metric === 'failure' && /filter/.test(r.label)));
  assert.ok(!above.some(r => /blocks/.test(r.label)), 'blocks are compared with blocks only');
});
