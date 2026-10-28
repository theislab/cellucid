/**
 * Progressive subsampled reading: a subsample's cells open in priority order
 * (`priorityOrder`), so a smaller subsample of the same method and seed is
 * the prefix of a larger one, and the gene index of a cell-major matrix is
 * built in segments of that order (`prefix-column-index.js`).
 *
 * - Growing (a larger subsample opened after a smaller one, the earlier
 *   reader `carry`ing what it built) and shrinking give, bit for bit, what
 *   opening at the final size directly gives.
 * - Raising the subsample reads only the new cells' bytes of the index;
 *   lowering it reads none.
 * - A gene asked for while the index builds is answered segment by segment:
 *   each partial answer holds the gene on a prefix of the open cells and NaN
 *   on the rest, and the last is the whole column.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, categorical, countingStore, dataFrame, dense, mapping, sparse, strings, array } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { priorityOrder, subsampleBlocks, subsampleUniform } from '../assets/js/data/subsample.js';
import { firstSegmentRows, segmentBounds } from '../assets/js/data/anndata/prefix-column-index.js';

const N_OBS = 2400;
const N_VARS = 1100;

/** A store whose X has about a thousand entries a cell: the gene index of a subsample spans several segments. */
function wideTree(layout, seed = 1) {
  const random = createMulberry32(seed);
  const values = new Float32Array(N_OBS * N_VARS);
  for (let i = 0; i < values.length; i++) values[i] = random() < 0.92 ? Math.fround(1 + random() * 9) : 0;
  let X;
  if (layout === 'dense') {
    X = dense(values, [N_OBS, N_VARS], { chunks: [64, N_VARS] });
  } else {
    const data = [];
    const indices = [];
    const indptr = [0];
    for (let cell = 0; cell < N_OBS; cell++) {
      for (let gene = 0; gene < N_VARS; gene++) {
        const value = values[cell * N_VARS + gene];
        if (value !== 0) {
          indices.push(gene);
          data.push(value);
        }
      }
      indptr.push(data.length);
    }
    X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [N_OBS, N_VARS] });
    X.children.data.chunks = [65536];
    X.children.indices.chunks = [65536];
    X.children.indptr.chunks = [512];
  }
  const tree = annData({
    obs: dataFrame({
      _index: strings(Array.from({ length: N_OBS }, (_, i) => `cell-${i}`), { chunks: [128] }),
      cluster: categorical(Int8Array.from({ length: N_OBS }, () => Math.floor(random() * 5)), ['a', 'b', 'c', 'd', 'e']),
      score: array(Float32Array.from({ length: N_OBS }, () => random()), { chunks: [100] }),
    }),
    var: dataFrame({ _index: strings(Array.from({ length: N_VARS }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: N_OBS * 2 }, () => random() * 10), [N_OBS, 2], { chunks: [150, 2] }) }),
    X,
  });
  return { tree, values };
}

/** One store, opened by readers one after another as the reader worker does: each later one carrying the one before. */
async function sharedStore(tree, { decodedChunkBytes = 0 } = {}) {
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  let previous = null;
  return {
    fetched,
    async open(cellSubset, { carry = true } = {}) {
      const reader = new AnnDataReader();
      await reader.open(root, { format: ZARR_FORMAT, name: 'wide.zarr', decodedChunkBytes, cellSubset, carry: carry ? previous : null });
      if (previous !== null) {
        previous.releaseStore();
        previous.close();
      }
      previous = reader;
      return reader;
    },
  };
}

function sameBits(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  assert.deepEqual(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength), new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength), `${label}: bits`);
}

const GENES = [0, 1, 517, N_VARS - 1];

/** Everything a view reads of an opening, keyed for comparison. */
async function readAll(reader) {
  return {
    order: reader.cellSubset.openOrder,
    score: (await reader.getObsField('score')).values,
    cluster: (await reader.getObsField('cluster')).codes,
    umap: await reader.readObsmColumns('X_umap', [0, 1]),
    genes: await reader.getMatrixColumns('X', GENES),
  };
}

function assertSameReading(actual, expected, label) {
  assert.deepEqual(actual.order, expected.order, `${label}: open order`);
  sameBits(actual.score, expected.score, `${label}: score`);
  sameBits(actual.cluster, expected.cluster, `${label}: cluster`);
  sameBits(actual.umap, expected.umap, `${label}: umap`);
  actual.genes.forEach((column, g) => sameBits(column, expected.genes[g], `${label}: gene ${GENES[g]}`));
}

for (const layout of ['csr', 'dense']) {
  test(`${layout}: a subsample grown and shrunk in place is, bit for bit, the subsample opened at its size`, async () => {
    const { tree, values } = wideTree(layout);
    for (const [method, extra] of [['uniform', {}], ['blocks', { blockSize: 40 }]]) {
      const request = k => ({ mode: 'subsample', method, k, seed: 9, ...extra });
      const store = await sharedStore(tree);
      const small = await store.open(request(240));
      // The index of the small subsample is built (a gene read), then carried.
      const smallReading = await readAll(small);
      const grown = await store.open(request(1200));
      const grownReading = await readAll(grown);
      const shrunk = await store.open(request(600));
      const shrunkReading = await readAll(shrunk);
      for (const [k, reading] of [[240, smallReading], [1200, grownReading], [600, shrunkReading]]) {
        const fresh = await (await sharedStore(tree)).open(request(k));
        assertSameReading(reading, await readAll(fresh), `${layout} ${method} k=${k}`);
        // Open cell i is original position order[i]; its gene values are the stored ones.
        const order = reading.order;
        const kept = method === 'uniform' ? subsampleUniform(N_OBS, k, 9) : subsampleBlocks(N_OBS, k, 9, 40);
        assert.deepEqual(order, priorityOrder({ method, seed: 9, ...extra }, kept));
        reading.genes.forEach((column, g) => {
          for (let i = 0; i < k; i++) assert.equal(column[i], values[order[i] * N_VARS + GENES[g]]);
        });
        fresh.close();
      }
      // Nested: a smaller subsample is the prefix of a larger one.
      assert.deepEqual(grownReading.order.subarray(0, 240), smallReading.order);
      assert.deepEqual(grownReading.order.subarray(0, 600), shrunkReading.order);
      shrunk.close();
    }
  });

  test(`${layout}: raising a subsample indexes only the new cells, lowering it reads nothing`, async () => {
    const { tree } = wideTree(layout, 3);
    const store = await sharedStore(tree);
    const request = k => ({ mode: 'subsample', method: 'blocks', k, seed: 4, blockSize: 64 });
    const matrixChunks = () => store.fetched.filter(key => key.startsWith('X/'));
    const first = await store.open(request(300));
    await first.getMatrixColumn('X', 5);
    const before = matrixChunks().length;
    assert.ok(before > 0);
    // Raised: the index reads the chunks of the new cells' rows only.
    const raised = await store.open(request(900));
    await raised.getMatrixColumn('X', 5);
    const raisedReads = matrixChunks().slice(before);
    const order = raised.cellSubset.openOrder;
    const rowChunk = layout === 'dense' ? row => `X/${Math.floor(row / 64)}.0` : null;
    if (rowChunk !== null) {
      const newChunks = new Set(Array.from(order.subarray(300), rowChunk));
      for (const key of raisedReads) assert.ok(newChunks.has(key), `${key} holds no new cell`);
    }
    // Opening the same cells afresh reads more than the raise did.
    const fresh = await sharedStore(tree);
    const again = await fresh.open(request(900));
    await again.getMatrixColumn('X', 5);
    const freshReads = fresh.fetched.filter(key => key.startsWith('X/')).length;
    assert.ok(raisedReads.length < freshReads, `raised read ${raisedReads.length} matrix chunks, a fresh opening ${freshReads}`);
    again.close();
    // Lowered: every row is indexed already.
    const atRaise = matrixChunks().length;
    const lowered = await store.open(request(450));
    await lowered.getMatrixColumns('X', [5, 6, 700]);
    assert.equal(matrixChunks().length, atRaise, 'lowering reads no matrix chunk');
    lowered.close();
  });

  test(`${layout}: a gene asked for while its index builds is answered segment by segment, each answer a prefix sample`, async () => {
    const { tree, values } = wideTree(layout, 5);
    const store = await sharedStore(tree);
    const k = 2000;
    const reader = await store.open({ mode: 'subsample', method: 'uniform', k, seed: 2 });
    const order = reader.cellSubset.openOrder;
    const perCell = layout === 'dense' ? N_VARS : tree.children.X.children.indices.shape[0] / N_OBS;
    const ends = segmentBounds(0, k, firstSegmentRows(k, perCell));
    assert.ok(ends.length >= 2, `a ${k}-cell subsample spans ${ends.length} segments`);
    const partials = [];
    const gene = 33;
    const column = await reader.getMatrixColumn('X', gene, { onPartial: (part, cells) => partials.push({ part, cells }) });
    assert.deepEqual(partials.map(p => p.cells), ends.slice(0, -1), 'one answer after each segment but the last');
    for (const { part, cells } of partials) {
      assert.equal(part.length, k);
      for (let i = 0; i < k; i++) {
        if (i < cells) assert.equal(part[i], values[order[i] * N_VARS + gene]);
        else assert.ok(Number.isNaN(part[i]), `cell ${i} not read yet is NaN`);
      }
    }
    for (let i = 0; i < k; i++) assert.equal(column[i], values[order[i] * N_VARS + gene]);
    // Once every segment is built, a gene is answered at once, whole.
    for (let wait = 0; (await reader.geneReadPlan('X')).built !== true; wait++) {
      assert.ok(wait < 500, 'the index is built');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const again = [];
    sameBits(await reader.getMatrixColumn('X', gene, { onPartial: part => again.push(part) }), column, 'built');
    assert.equal(again.length, 0);
    reader.close();
  });
}

test('every cell of a foreign file opens in file order and is indexed whole', async () => {
  const { tree } = wideTree('csr', 7);
  const store = await sharedStore(tree);
  const reader = await store.open({ mode: 'all' });
  assert.equal(reader.cellSubset.openOrder, null);
  assert.equal(reader.cellSubset.ordered, false);
  const partials = [];
  await reader.getMatrixColumn('X', 3, { onPartial: part => partials.push(part) });
  assert.equal(partials.length, 0, 'file order is no sample: no partial answers');
  reader.close();
});

test('the page hears a gene on more cells through the reader client, before its reply', async t => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient } = await import('../assets/js/data/anndata-reader-client.js');
  const { setNextCellSubsetRequest } = await import('../assets/js/data/cell-subset-policy.js');
  const { zarrEntries } = await import('./helpers/anndata-store.mjs');
  const { tree, values } = wideTree('csr', 11);
  // The store as a picked folder: one File a key.
  const files = new Map([...zarrEntries(tree)].map(([key, bytes]) => [`wide.zarr/${key}`, new File([bytes], key.split('/').at(-1))]));
  const client = new AnnDataReaderClient();
  t.after(() => client.close());
  setNextCellSubsetRequest({ mode: 'subsample', method: 'blocks', k: 2000, seed: 1, blockSize: 50 });
  await client.open({ files, rootName: 'wide.zarr' });
  const order = client.cellSubset.openOrder;
  const heard = [];
  const gene = 12;
  const [column, again] = await Promise.all([
    client.getMatrixColumn('X', gene, { onPartial: (part, cells) => heard.push({ part, cells }) }),
    // A second caller of the same gene, asking for nothing partial.
    client.getMatrixColumn('X', gene),
  ]);
  assert.ok(heard.length >= 1, 'at least one partial answer');
  for (const { part, cells } of heard) {
    for (let i = 0; i < 2000; i++) {
      if (i < cells) assert.equal(part[i], values[order[i] * N_VARS + gene]);
      else assert.ok(Number.isNaN(part[i]));
    }
  }
  for (let i = 0; i < 2000; i++) assert.equal(column[i], values[order[i] * N_VARS + gene]);
  sameBits(again, column, 'the other caller');
});

test('the Dataset box says how much of its neighbour graph a subsample keeps', async () => {
  const { describeDetails, describeGraphShare } = await import('../assets/js/app/ui/modules/dataset-card.js');
  assert.equal(describeGraphShare({ kept: 120, of: 1200 }), "10 % of the open cells' edges; the others lead to cells not open");
  assert.equal(describeGraphShare({ kept: 3, of: 1200 }), "0.25 % of the open cells' edges; the others lead to cells not open");
  assert.equal(describeGraphShare({ kept: 0, of: 0 }), 'no edge of the open cells');
  const metadata = { id: 'd', name: 'D', stats: { n_cells: 1000, n_genes: 3, n_obs_fields: 0, n_categorical_fields: 0, n_continuous_fields: 0, has_connectivity: true, n_edges: 5000 }, source: null };
  const cells = { nObs: 1000, kept: new Uint32Array(100), spec: { method: 'uniform', nObs: 1000, k: 100, seed: 0 }, autoFit: null };
  const graphRow = rows => rows.find(row => row.label === 'Neighbour graph').value;
  assert.match(graphRow(describeDetails(metadata, null, null, null, cells, { kept: 120, of: 1200 })), /\(10 % of the open cells' edges; the others lead to cells not open\)$/);
  assert.doesNotMatch(graphRow(describeDetails(metadata, null, null, null, cells, null)), /open cells/);
  assert.doesNotMatch(graphRow(describeDetails(metadata, null, null, null, { ...cells, kept: null }, { kept: 1, of: 2 })), /open cells/);
});

test('a gene\'s notice says when its first colours come', async () => {
  const { describeGeneReadPlan } = await import('../assets/js/data/gene-read-plan.js');
  const plan = {
    label: 'X', cellMajor: true, built: false, bytesPerSecond: null,
    scan: { storedBytes: 64e6, valueBytes: 80e6 }, index: null,
  };
  const fresh = describeGeneReadPlan({ ...plan, progressive: { cells: 228_000, done: 0, next: 7_125, nextStoredBytes: 2e6 } });
  assert.match(fresh, /first gene reads every cell's entries: 61 MB\./);
  assert.match(fresh, /Its colours fill in as cells are read: the first 7,125 of 228,000 cells \(1\.9 MB\), a sample of them/);
  const raised = describeGeneReadPlan({ ...plan, progressive: { cells: 228_000, done: 22_800, next: 45_600, nextStoredBytes: 5e6 } });
  assert.match(raised, /22,800 cells of it are indexed already, so the first gene reads the entries of the other 205,200/);
  assert.match(raised, /Its colours show at once on the 22,800 cells indexed, a sample of the 228,000 open cells/);
  assert.doesNotMatch(describeGeneReadPlan({ ...plan, progressive: null }), /colours/);
});

test('reading the open file again with other cells keeps its reader; a failed reading leaves the cells open before', async t => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { readFileSync } = await import('node:fs');
  const { AnnDataFileSource } = await import('../assets/js/data/anndata-file-source.js');
  const { setNextCellSubsetRequest, takeCellSubsetRequest, getTabCellSubsetRequest } = await import('../assets/js/data/cell-subset-policy.js');
  const name = 'data-mapping-full.h5ad';
  const file = new File([readFileSync(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
  const source = new AnnDataFileSource();
  t.after(() => source._loader?.close());
  await source.loadFile(file);
  const reader = source._loader;
  const adapter = source._adapter;
  assert.equal(source.getCellSubset().kept, null);

  // A reading names its own cells: the next opening's request (a link's)
  // is neither taken nor overwritten by it.
  const linked = { mode: 'subsample', method: 'uniform', k: 5, seed: 99 };
  setNextCellSubsetRequest(linked);
  await source.reopenCells({ cellSubset: { mode: 'subsample', method: 'uniform', k: 120, seed: 7 } });
  assert.equal(source._loader, reader, 'the same reader (and worker)');
  assert.notEqual(source._adapter, adapter, 'a new adapter for the new cells');
  assert.equal(adapter._closed, true, 'the earlier adapter let go');
  assert.equal(source.getCellSubset().kept.length, 120);
  const identity = source.getCellIdentity();
  assert.deepEqual(identity.openOrder, priorityOrder(source.getCellSubset().spec, identity.kept));
  assert.equal((await source._adapter.getGeneValues('var/0')).length, 120);

  // A reading that fails (a field the file does not have, asked for strictly).
  await assert.rejects(
    source.reopenCells({ cellSubset: { mode: 'subsample', method: 'stratified', field: 'no_such_field', k: 60, seed: 1, strict: true } }),
    /no_such_field/
  );
  assert.equal(source._loader, reader);
  assert.equal(source.getCellSubset().kept.length, 120, 'the cells open before');
  assert.equal(source.getCellIdentity().digest, identity.digest);
  assert.equal((await source._adapter.getGeneValues('var/0')).length, 120);
  // The link's request is still the next opening's, untouched.
  assert.deepEqual({ ...takeCellSubsetRequest() }, linked);
  assert.equal(takeCellSubsetRequest(), getTabCellSubsetRequest());
  await assert.rejects(source.reopenCells({}), /cell subset request/);
});

/**
 * A blocks share of a file whose per-cell arrays are chunked coarsely: the
 * share's cells lie in every chunk, so every growth step's added cells lie in
 * chunks earlier steps decoded. Grown through the reader as the page grows
 * it (each step a reopening carrying the one before, reading only its added
 * rows), each chunk is decoded once over the whole growth: the store's
 * decoded chunks (`decoded-chunks.js`) go from each opening to the next.
 */
test('a progressive opening decodes each chunk once over its growth: later steps read their added rows from the chunks kept', async t => {
  const random = createMulberry32(5);
  const tree = annData({
    obs: dataFrame({
      _index: strings(Array.from({ length: N_OBS }, (_, i) => `cell-${i}`), { chunks: [600] }),
      // Stored as a written file's (decoded whole): a chunk read in part
      // (a served store's) reads each step's rows alone, with nothing to keep.
      score: array(Float32Array.from({ length: N_OBS }, () => random()), { chunks: [600], compressed: true }),
    }),
    var: dataFrame({ _index: strings(['g0']) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: N_OBS * 2 }, () => random() * 10), [N_OBS, 2], { chunks: [600, 2], compressed: true }) }),
    X: dense(new Float32Array(N_OBS), [N_OBS, 1], { chunks: [N_OBS, 1] }),
  });
  const request = k => ({ mode: 'subsample', method: 'blocks', blockSize: 20, k, seed: 4 });
  // The direct opening of the whole share: what the growth must end as.
  const direct = await sharedStore(tree);
  const whole = await direct.open(request(1200));
  const expected = {
    umap: await whole.readObsmColumns('X_umap', [0, 1]),
    score: (await whole.getObsField('score')).values,
  };

  for (const kept of [true, false]) {
    // The store's own decoded-chunk cache is off: what is kept is the
    // reader's chunks, carried from step to step (`kept`), or each step's own.
    const store = await sharedStore(tree, { decodedChunkBytes: 1 << 20 });
    // Showing a cell costs 1 ms: a first view of the cells shown within a
    // millisecond (`progressivePlan`), then steps that double them.
    let reader = await store.open({ ...request(1200), progressive: { targetMs: 1, msPerCell: 1 } });
    const growth = reader.cellSubset.growth;
    assert.ok(growth !== null && growth.steps.length >= 3, 'a growth of several steps');
    const umap = new Float32Array(1200 * 2);
    const score = new Float32Array(1200);
    const take = async (from, to) => {
      const rows = from === 0 ? null : [from, to];
      umap.set(await reader.readObsmColumns('X_umap', [0, 1], rows === null ? {} : { rows }), from * 2);
      score.set((await reader.getObsField('score', rows === null ? {} : { rows })).values, from);
    };
    await take(0, reader.nObs);
    const decodes = [store.fetched.length];
    for (const k of growth.steps) {
      const from = reader.nObs;
      reader = await store.open(k === growth.target ? growth.final : { ...growth.step, k }, { carry: kept });
      await take(from, k);
      decodes.push(store.fetched.length);
    }
    sameBits(umap, expected.umap, `kept ${kept}: umap grown`);
    sameBits(score, expected.score, `kept ${kept}: score grown`);
    const chunkKeys = store.fetched.filter(key => /X_umap\/|score\//.test(key));
    const distinct = new Set(chunkKeys);
    t.diagnostic(`${kept ? 'kept' : 'not kept'}: chunks decoded after each step ${decodes.join(', ')}; ${chunkKeys.length} decodes of ${distinct.size} chunks`);
    if (kept) {
      assert.equal(chunkKeys.length, distinct.size, `each chunk decoded once (decodes per step: ${decodes.join(', ')})`);
    } else {
      assert.ok(chunkKeys.length > distinct.size, 'without the chunks carried the steps decode the same chunks again (the case this guards)');
    }
  }
});
