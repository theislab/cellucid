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
 * `scripts/efficiency-floor.mjs` (`cellucid-private/plans/efficiency-floor-*.md`).
 *
 * Elements: obs (categorical codes, continuous, boolean, strings), obsm
 * embeddings in 2 and 3 dimensions (switching back to one read before is
 * the page's: `base-anndata-adapter.js` keeps it), a velocity
 * field, a neighbour graph's induced subgraph, X as CSR (a gene builds the
 * kept rows' gene index: their entries, nothing else), CSC (a gene's
 * entries) and dense (the gene's column chunks of kept rows), a layer,
 * raw.X, the stored outlier quantiles, and a priority-ordered file's
 * gene-major X read as the kept prefix of each gene. Shares: every cell,
 * 10 % blocks, 1 % uniform. The same store as Zarr v3 with every array
 * sharded (four chunks a shard along the cells): its inner chunks are held
 * to the same floor, and each shard index is read once.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { priorityOrder } from '../assets/js/data/subsample.js';
import {
  annData, array, categorical, countingShardedStore, countingStore, dataFrame, dense, group, mapping, sparse, strings, zarrEntries,
} from './helpers/anndata-store.mjs';

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

/** A symmetric neighbour graph of the stored rows (no self-loops): about six neighbours a cell. */
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
  ['10 % blocks', { mode: 'subsample', method: 'blocks', fraction: 0.1, seed: 2 }],
  ['1 % uniform', { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 2 }],
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
  const root = muDataView(await openZarr(store, { decodedChunkCacheBytes: 0 }), { name: 'mu.zarr' });
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
  for (const [label, request] of [...SHARES, ['1 % blocks', { mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 3 }]]) {
    const { store, fetched } = countingStore(tree, { name: 'floor.loom' });
    const root = LOOM_VIEW.view(await openZarr(store, { decodedChunkCacheBytes: 64 * 1024 * 1024 }), { name: 'floor.loom' });
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

test('a served store at 1 %: an analysis over every gene and many genes read each gene\'s counted entries and the next, no other byte of X', async () => {
  // As `cellucid serve` / `cellucid_serve` answer a dataset: priority order,
  // a gene-major X whose chunks (2^14 entries) are their values' bytes, the
  // prefix counts beside it. A 1 % uniform subsample under the file's seed
  // is its first k rows, and a gene's open values its first entries.
  const built = storeTree('csc', { priority: true, entryChunk: 16384 });
  const { store, reads } = countingStore(built.tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'served.zarr', decodedChunkBytes: 0, cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 0 } });
  const k = reader.nObs;
  assert.equal(reader.cellSubset.prefix, k);
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
      const chunk = Number(key.slice(key.lastIndexOf('/') + 1)) * 16384 * 4;
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
    ['1 % uniform', { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 2 }, false],
    ['1 % blocks', { mode: 'subsample', method: 'blocks', fraction: 0.01, seed: 2, blockSize: 20 }, false],
    ['a served store\'s 1 % (its prefix)', { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 0 }, true],
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
