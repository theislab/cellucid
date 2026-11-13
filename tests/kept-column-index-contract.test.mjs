/**
 * Gene indexes kept in this browser across visits
 * (`assets/js/data/anndata/kept-column-index.js`): the column index of a
 * cell-major matrix, built over the open cells, kept in the origin-private
 * file system (`transcode/space.js`) under the file's identity, the matrix
 * and the order the cells are opened in.
 *
 * - A later opening of the same cells of the same version of a file (a
 *   content name, or a size with a modification time: one rule) reads no
 *   byte of the matrix but genes (a store with values reads nothing, nor
 *   does a run over a slow link whose values the first gene bought, kept
 *   with them; a structure kept without values reads only the gene's).
 * - Opening another version of the file removes the runs of the old one
 *   (`forgetOtherVersions`), and its values are the new file's.
 * - Nested reuse across k: a larger subsample of the same method and seed
 *   indexes only its new cells; a smaller one reads its rows from the kept
 *   runs it shares.
 * - Identity: another version of the file, another seed, never reuse a run;
 *   a file known by its size alone is kept for its opening only (the tab
 *   the reader worker names for it).
 * - Integrity: every gene's stored piece carries a CRC-32, checked as it is
 *   read; a damaged run (bytes, row pointers, checksums) is removed, the
 *   index built again and kept again, and the values are exact.
 * - Holds: every run an opening takes is let go when its reader closes (a
 *   dense segment read by strips too); the writer hands its hold to the
 *   page with no moment between.
 * - Room: kept runs make room only from other kept runs (never a converted
 *   store), try again after a QuotaExceededError, and live work removes
 *   runs before converted stores.
 * - Code: a run is stamped with the code fingerprint of gene indexes; one
 *   stamped by other code is removed, never read, and the index is built
 *   and kept again (which code that is:
 *   `tests/kept-code-fingerprints-contract.test.mjs`).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// The plans asserted here weigh this machine's speed: held at rest (`helpers/machine-at-rest.mjs`).
import './helpers/machine-at-rest.mjs';

import { annData, countingStore, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import {
  TRANSCODED_DIRECTORY,
  holdTranscodedStore,
  listKeptStores,
  forgetOtherVersions,
  onKeptStoresChange,
  openTranscodeSpace,
  removeKeptStores,
  sweepAbandonedTranscodes,
} from '../assets/js/data/anndata/transcode/space.js';
import { KEPT_CODE_FINGERPRINTS } from '../assets/js/data/anndata/transcode/kept-code-fingerprints.js';
import { cacheKey, identityDigest } from '../assets/js/data/anndata/transcode/kept-format.js';
import { persistsAcrossVisits, writeVersion } from '../assets/js/data/sources/identity.js';
import { diskFreeBytes } from '../assets/js/data/column-store-placement.js';
import { initKeptStoresLine, summarizeKeptStores } from '../assets/js/app/ui/modules/kept-stores-line.js';
import { formatBytes } from '../assets/js/utils/format-units.js';
import { until } from './helpers/until.mjs';

const N_OBS = 2400;
const N_VARS = 300;

/** Genes renumbered `g -> N_VARS - 1 - g` in every row: each row keeps its entry count (and the row pointers stay). */
function reverseGenes(arrays) {
  for (let cell = 0; cell < N_OBS; cell++) {
    const pairs = [];
    for (let i = arrays.indptr[cell]; i < arrays.indptr[cell + 1]; i++) pairs.push([N_VARS - 1 - arrays.indices[i], arrays.data[i]]);
    pairs.sort((a, b) => a[0] - b[0]);
    pairs.forEach(([gene, value], j) => {
      arrays.indices[arrays.indptr[cell] + j] = gene;
      arrays.data[arrays.indptr[cell] + j] = value;
    });
  }
}

function wideTree(layout, seed = 1, { mutate = null, compressed = true } = {}) {
  const random = createMulberry32(seed);
  const values = new Float32Array(N_OBS * N_VARS);
  for (let i = 0; i < values.length; i++) values[i] = random() < 0.3 ? Math.fround(1 + random() * 9) : 0;
  let X;
  if (layout === 'dense') {
    X = dense(values, [N_OBS, N_VARS], { chunks: [64, N_VARS], compressed: true });
  } else {
    const data = [];
    const indices = [];
    const indptr = [0];
    for (let cell = 0; cell < N_OBS; cell++) {
      for (let gene = 0; gene < N_VARS; gene++) {
        if (values[cell * N_VARS + gene] !== 0) {
          indices.push(gene);
          data.push(values[cell * N_VARS + gene]);
        }
      }
      indptr.push(data.length);
    }
    const arrays = { data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr) };
    if (mutate !== null) {
      mutate(arrays);
      values.fill(0);
      for (let cell = 0; cell < N_OBS; cell++) {
        for (let i = arrays.indptr[cell]; i < arrays.indptr[cell + 1]; i++) values[cell * N_VARS + arrays.indices[i]] = arrays.data[i];
      }
    }
    X = sparse({ format: 'csr', ...arrays, shape: [N_OBS, N_VARS], compressed });
    X.children.data.chunks = [4096];
    X.children.indices.chunks = [4096];
    X.children.indptr.chunks = [512];
  }
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: N_OBS }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(Array.from({ length: N_VARS }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(new Float32Array(N_OBS * 2), [N_OBS, 2]) }),
    X,
  });
  return { tree, values };
}

/** Gene `gene` removed from every row (each row keeps its other entries): a gene with no entry. */
function dropGene(gene) {
  return arrays => {
    const data = [];
    const indices = [];
    const indptr = [0];
    for (let cell = 0; cell < N_OBS; cell++) {
      for (let i = arrays.indptr[cell]; i < arrays.indptr[cell + 1]; i++) {
        if (arrays.indices[i] === gene) continue;
        indices.push(arrays.indices[i]);
        data.push(arrays.data[i]);
      }
      indptr.push(data.length);
    }
    arrays.data = Float32Array.from(data);
    arrays.indices = Int32Array.from(indices);
    arrays.indptr = Int32Array.from(indptr);
  };
}

/**
 * A link slower than a disk (not read ahead): the index is the structure,
 * values read per gene. Measured, and fast enough that every open cell's
 * first gene is read within the gene time (no gene sample): a link with no
 * price reads a first gene only for the cells kept here (`geneTimeFit`).
 */
const SLOW_LINK_SNAPSHOT = Object.freeze({ measured: true, latencyMs: 1, bytesPerMs: 1e5, concurrency: 6, shapingConcurrency: 6, mergeGapBytes: 0, readsAhead: false });
const SLOW_LINK = Object.freeze({ readsAhead: false, mergeGapBytes: 0, snapshot: () => SLOW_LINK_SNAPSHOT, watchProtocol() {} });

/** A file whose identity names its content (a provider's checksum). */
const FILE = Object.freeze({ kind: 'remote', key: 'host:wide', version: `md5:${'0'.repeat(32)}:1` });
/** A local file: its name, size and modification time are its version. */
const LOCAL = Object.freeze({ kind: 'file', name: 'wide.zarr', size: 1, lastModified: 5 });

/**
 * One opening, as a visit makes it: a fresh store (nothing cached between
 * visits), the same storage. Returns the reader, the matrix chunks it read,
 * and the kept directories it wrote and completed.
 */
async function visit(tree, environment, request, { identity = FILE, link = null, tab, decodedChunkBytes = 0, onComplete = null, onChunk = null } = {}) {
  const { store, fetched } = countingStore(tree, { onChunk });
  if (onChunk !== null) {
    // Parts of chunks too.
    const getRanges = store.getRanges;
    store.getRanges = async (key, ...rest) => {
      await onChunk(key);
      return getRanges(key, ...rest);
    };
  }
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const stores = [];
  const reader = new AnnDataReader();
  await reader.open(root, {
    format: ZARR_FORMAT,
    name: 'wide.zarr',
    decodedChunkBytes,
    link,
    cellSubset: request,
    keptIndexes: {
      identity,
      environment,
      tab,
      onStore: event => {
        stores.push(event);
        return event.state === 'complete' ? onComplete?.(event) : undefined;
      },
    },
  });
  const opened = fetched.length;
  return {
    reader,
    stores,
    // The matrix's chunks read after opening, but its kept rows' pointers:
    // a subsample reads those when X is first read, not at opening
    // (`views/cell-subset.js` `readRowPointers`), with or without a kept index.
    matrixReads: () => fetched.slice(opened).filter(key => key.startsWith('X/') && !key.startsWith('X/indptr/')),
    /** Every gene index built and every run kept. */
    async settled() {
      for (let wait = 0; (await reader.geneReadPlan('X')).built !== true; wait++) {
        assert.ok(wait < 2000, 'the index is built');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await reader.whenIndexesKept();
    },
  };
}

function assertGene(column, values, order, gene, label) {
  for (let i = 0; i < order.length; i++) assert.equal(column[i], values[order[i] * N_VARS + gene], `${label}: cell ${i}`);
}

function keptDirectories(disk) {
  const parent = path.join(disk.root, TRANSCODED_DIRECTORY);
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names.filter(name => statSync(path.join(parent, name)).isDirectory()).flatMap(name => {
    try {
      const manifest = JSON.parse(readFileSync(path.join(parent, name, 'manifest.json'), 'utf8'));
      return [{ name, folder: path.join(parent, name), manifest }];
    } catch {
      return [];
    }
  });
}

/** Bytes under a folder: what the browser counts as used. */
function usage(folder) {
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    total += entry.isDirectory() ? usage(target) : statSync(target).size;
  }
  return total;
}

const blocks = k => ({ mode: 'subsample', method: 'blocks', k, seed: 3, blockSize: 40 });

/**
 * Every kept directory held by nobody: what `removeKeptStores` says once
 * every reader closed. A closed reader lets its shared locks go as its
 * store closes, after its last reads of the disk: once no lock is held.
 */
async function assertNothingHeld(disk, label) {
  await until(() => disk.environment.navigator.locks.held.size === 0, `${label}: every closed reader's hold let go`);
  const cleared = await removeKeptStores(null, disk.environment);
  assert.equal(cleared.held, 0, `${label}: nothing is held once every reader closed`);
}

for (const [layout, link] of [['csr', null], ['csr', SLOW_LINK], ['dense', null]]) {
  const kind = `${layout}${link === null ? '' : ' over a slow link'}`;

  test(`${kind}: a later opening of the same cells reads its genes at once, from the kept index`, async t => {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const { tree, values } = wideTree(layout);
    const first = await visit(tree, disk.environment, blocks(900), { link });
    assert.equal((await first.reader.geneReadPlan('X')).built, false);
    await first.reader.getMatrixColumn('X', 7);
    await first.settled();
    assert.ok(first.stores.some(s => s.state === 'complete'), 'a run is kept');
    first.reader.close();

    const again = await visit(tree, disk.environment, blocks(900), { link });
    // Said before the first gene: the index is built.
    assert.equal((await again.reader.geneReadPlan('X')).built, true);
    const order = again.reader.cellSubset.openOrder;
    for (const gene of [7, 0, N_VARS - 1]) assertGene(await again.reader.getMatrixColumn('X', gene), values, order, gene, `${kind} gene ${gene}`);
    const reads = again.matrixReads();
    if (link === null) assert.deepEqual(reads, [], 'no byte of the matrix is read');
    else assert.deepEqual(reads.filter(key => !key.startsWith('X/data/')), [], 'only the genes\' values are read');
    assert.equal(again.stores.length, 0, 'nothing is kept again');
    again.reader.close();
    await assertNothingHeld(disk, kind);
  });

  test(`${kind}: a larger subsample of the same seed indexes only its new cells; a smaller one reads none`, async t => {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const { tree, values } = wideTree(layout, 2);
    const small = await visit(tree, disk.environment, blocks(600), { link });
    await small.reader.getMatrixColumn('X', 3);
    await small.settled();
    small.reader.close();

    const fresh = await visit(tree, opfsOnDisk().environment, blocks(1800), { link });
    await fresh.reader.getMatrixColumn('X', 3);
    const freshIndexReads = fresh.matrixReads().filter(key => !key.startsWith('X/data/') || link === null).length;
    fresh.reader.close();

    const large = await visit(tree, disk.environment, blocks(1800), { link });
    const order = large.reader.cellSubset.openOrder;
    if (link === null) {
      const plan = await large.reader.geneReadPlan('X');
      assert.equal(plan.progressive?.done, 600, 'the kept cells are indexed already');
    } else {
      // Over a link, a later visit's first gene answers from the kept cells
      // (`geneTimeFit`), and the page's top-up reads the rest after it.
      assert.equal(large.reader.geneSample?.cells, 600, 'the first gene answers from the kept cells');
      assert.equal(large.reader.geneSample.fit.growTo, 1800, 'every cell priced within the target, read next');
      const first = await large.reader.getMatrixColumn('X', 3);
      assert.deepEqual(large.matrixReads().filter(key => !key.startsWith('X/data/')), [], 'the first gene reads no index');
      for (let i = 0; i < 600; i++) assert.equal(first[i], values[order[i] * N_VARS + 3], `${kind} kept cell ${i}`);
      await large.reader.growGeneSample('X', 1800, { gene: 3, topUp: true });
    }
    assertGene(await large.reader.getMatrixColumn('X', 3), values, order, 3, `${kind} raised`);
    const largeIndexReads = large.matrixReads().filter(key => !key.startsWith('X/data/') || link === null).length;
    assert.ok(largeIndexReads < freshIndexReads, `raised: ${largeIndexReads} index chunks, fresh ${freshIndexReads}`);
    await large.settled();
    large.reader.close();

    const lower = await visit(tree, disk.environment, blocks(1000), { link });
    assert.equal((await lower.reader.geneReadPlan('X')).built, true, 'a smaller subsample is covered by the runs kept');
    const lowerOrder = lower.reader.cellSubset.openOrder;
    for (const gene of [3, 150]) assertGene(await lower.reader.getMatrixColumn('X', gene), values, lowerOrder, gene, `${kind} lowered`);
    if (link === null) assert.deepEqual(lower.matrixReads(), []);
    lower.reader.close();
    await assertNothingHeld(disk, `${kind} lowered`);
  });
}

for (const [layout, link] of [['csr', null], ['csr', SLOW_LINK], ['dense', null]]) {
  const kind = `${layout}${link === null ? '' : ' over a slow link'}`;

  test(`${kind}: a later opening reads every gene from the kept index in a few reads of it, never a read per gene; exact`, async t => {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const { tree, values } = wideTree(layout, 6);
    const first = await visit(tree, disk.environment, blocks(900), { link });
    await first.reader.getMatrixColumn('X', 7);
    await first.settled();
    first.reader.close();
    const runs = keptDirectories(disk).filter(item => item.manifest.kind === 'column-index');
    assert.ok(runs.length > 0, 'runs are kept');

    const again = await visit(tree, disk.environment, blocks(900), { link });
    const order = again.reader.cellSubset.openOrder;
    // The kept runs are found and checked with the first gene.
    assertGene(await again.reader.getMatrixColumn('X', 7), values, order, 7, `${kind} first gene`);
    // Reads of the kept copies from here on: every read of a kept file is a slice of it.
    let reads = 0;
    const slice = Blob.prototype.slice;
    Blob.prototype.slice = function counted(...args) {
      reads++;
      return slice.apply(this, args);
    };
    // Every gene, 64 at a time, as an analysis asks for them.
    const everyGene = async () => {
      for (let gene = 0; gene < N_VARS; gene += 64) {
        const genes = Array.from({ length: Math.min(64, N_VARS - gene) }, (_, i) => gene + i);
        const columns = await again.reader.getMatrixColumnsSparse('X', genes);
        columns.forEach((column, i) => {
          const dense = new Float32Array(order.length);
          column.indices.forEach((cell, j) => { dense[cell] = column.values[j]; });
          assertGene(dense, values, order, genes[i], `${kind} gene ${genes[i]}`);
        });
      }
    };
    const arrays = runs.reduce((sum, run) => sum + ({ structure: 1, sparse: 2, dense: 1 })[run.manifest.layout], 0);
    const batches = Math.ceil(N_VARS / 64);
    try {
      // While the kept copy is read whole (from the first gene on): at most
      // one read of each kept array per batch of genes, never one per gene.
      await everyGene();
      assert.ok(reads <= arrays * batches, `${reads} reads of ${runs.length} kept runs (${arrays} arrays) for ${N_VARS} genes`);
      // Held whole once read: every gene again reads nothing of it. The
      // whole copy is read in the background from the first gene on, from
      // the disk: held once a gene reads nothing.
      await again.reader.whenIndexesKept();
      await until(async () => (await again.reader.geneReadPlan('X')).built === true, 'the index is built');
      await until(async () => {
        reads = 0;
        await again.reader.getMatrixColumnsSparse('X', [0]);
        return reads === 0;
      }, 'the kept copy held whole');
      reads = 0;
      await everyGene();
      assert.equal(reads, 0, 'every gene from memory');
    } finally {
      Blob.prototype.slice = slice;
    }
    assert.equal(again.stores.length, 0, 'nothing is kept again');
    again.reader.close();
    await assertNothingHeld(disk, `${kind} every gene`);
  });
}

test('csr over a slow link: the values bought with the first gene are kept with the index; a later opening reads no byte of the matrix', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree, values } = wideTree('csr', 4);
  const first = await visit(tree, disk.environment, blocks(900), { link: SLOW_LINK });
  await first.reader.getMatrixColumn('X', 7);
  await first.settled();
  const runs = keptDirectories(disk).filter(item => item.manifest.kind === 'column-index');
  assert.deepEqual(runs.map(run => run.manifest.layout), ['sparse'], 'kept with the values the first gene bought');
  first.reader.close();

  const again = await visit(tree, disk.environment, blocks(900), { link: SLOW_LINK });
  const order = again.reader.cellSubset.openOrder;
  for (const gene of [7, 0, 150, N_VARS - 1]) assertGene(await again.reader.getMatrixColumn('X', gene), values, order, gene, `gene ${gene}`);
  assert.deepEqual(again.matrixReads(), [], 'no byte of the matrix is read again, not even a value');
  again.reader.close();
  await assertNothingHeld(disk, 'bought values');
});

test('every cell of a foreign file is indexed whole and kept whole', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree, values } = wideTree('csr', 4);
  const first = await visit(tree, disk.environment, { mode: 'all' });
  await first.reader.getMatrixColumn('X', 1);
  await first.settled();
  first.reader.close();
  const again = await visit(tree, disk.environment, { mode: 'all' });
  assert.equal((await again.reader.geneReadPlan('X')).built, true);
  const order = Uint32Array.from({ length: N_OBS }, (_, i) => i);
  assertGene(await again.reader.getMatrixColumn('X', 9), values, order, 9, 'whole');
  // The row pointers alone, which the kept index is checked against.
  assert.deepEqual(again.matrixReads().filter(key => !key.startsWith('X/indptr/')), []);
  again.reader.close();
});

test('another version of the file, or another seed, never takes a kept run; a size-only file is its tab\'s', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 5);
  const first = await visit(tree, disk.environment, blocks(900));
  await first.reader.getMatrixColumn('X', 2);
  await first.settled();
  first.reader.close();
  for (const [label, options, request] of [
    ['a newer version', { identity: { ...FILE, version: `md5:${'1'.repeat(32)}:1` } }, blocks(900)],
    ['another seed', {}, { ...blocks(900), seed: 4 }],
    ['another block size', {}, { ...blocks(900), blockSize: 41 }],
  ]) {
    const other = await visit(tree, disk.environment, request, options);
    assert.equal((await other.reader.geneReadPlan('X')).built, false, label);
    other.reader.close();
  }
  // Known by its size alone (a host that reports no version): kept for this tab, and only this tab finds it.
  const sized = { kind: 'remote', key: 'host:wide', version: 'size:1' };
  const mine = await visit(tree, disk.environment, blocks(900), { identity: sized, tab: 'tab-a', onComplete: event => holdTranscodedStore(event.directory, disk.environment) });
  await mine.reader.getMatrixColumn('X', 2);
  await mine.settled();
  mine.reader.close();
  const kept = keptDirectories(disk).filter(({ manifest }) => manifest.persist === false);
  assert.ok(kept.length > 0 && kept.every(({ manifest }) => manifest.tab === 'tab-a'));
  const sameTab = await visit(tree, disk.environment, blocks(900), { identity: sized, tab: 'tab-a' });
  assert.equal((await sameTab.reader.geneReadPlan('X')).built, true, 'its tab finds it');
  sameTab.reader.close();
  const otherTab = await visit(tree, disk.environment, blocks(900), { identity: sized, tab: 'tab-b' });
  assert.equal((await otherTab.reader.geneReadPlan('X')).built, false, 'another tab does not');
  otherTab.reader.close();
});

test('a file by its size and modification time reads no chunk of the index again; another version of it removes the old runs', async t => {
  for (const [layout, link] of [['csr', null], ['csr', SLOW_LINK], ['dense', null]]) {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const kind = `${layout}${link === null ? '' : ' over a slow link'}`;
    const { tree } = wideTree(layout, 9);
    const first = await visit(tree, disk.environment, blocks(900), { identity: LOCAL, link });
    await first.reader.getMatrixColumn('X', 5);
    await first.settled();
    const builtReads = first.matrixReads();
    if (link === null) assert.equal(new Set(builtReads).size, builtReads.length, `${kind}: no chunk read twice to keep the run`);
    first.reader.close();

    // The same version again: nothing of the matrix is read to use the run.
    const same = await visit(tree, disk.environment, blocks(900), { identity: LOCAL, link });
    assert.equal((await same.reader.geneReadPlan('X')).built, true, `${kind}: the unchanged file's run is used`);
    assert.deepEqual(same.matrixReads(), [], `${kind}: no chunk read to use the run`);
    same.reader.close();

    if (layout === 'dense') continue;
    // Rewritten by its source (its version moves): opening the new version
    // removes what is kept of the old one, every kind, and reads the new values.
    const old = { kind: 'remote', key: 'host:wide', version: writeVersion({ size: 1, lastModified: 'Tue, 27 Oct 2026 10:00:00 GMT' }) };
    const renewed = { ...old, version: writeVersion({ size: 1, lastModified: 'Wed, 28 Oct 2026 10:00:00 GMT' }) };
    const before = await visit(tree, disk.environment, blocks(900), { identity: old, link });
    await before.reader.getMatrixColumn('X', 5);
    await before.settled();
    before.reader.close();
    const oldRuns = keptDirectories(disk).map(({ name }) => name);
    assert.ok(await forgetOtherVersions(renewed, disk.environment) > 0, `${kind}: the old version's runs are forgotten`);
    const { tree: rewritten, values } = wideTree(layout, 9, { mutate: reverseGenes });
    const after = await visit(rewritten, disk.environment, blocks(900), { identity: renewed, link });
    assert.equal((await after.reader.geneReadPlan('X')).built, false, `${kind}: the old version's run is not used`);
    const order = after.reader.cellSubset.openOrder;
    assertGene(await after.reader.getMatrixColumn('X', 5), values, order, 5, `${kind} rewritten`);
    await after.settled();
    after.reader.close();
    const left = new Set(keptDirectories(disk).map(({ name }) => name));
    const oldOnly = oldRuns.filter(name => !left.has(name));
    assert.ok(oldOnly.length > 0, `${kind}: the old version's runs are removed`);
    assert.ok(keptDirectories(disk).every(({ manifest }) => manifest.address !== undefined), `${kind}: every run names its file's address`);
  }
});

test('a damaged kept run is found out, removed, built again and kept again; values exact', async t => {
  const cases = [
    ['truncate', 'csr', SLOW_LINK],
    ['positions', 'csr', SLOW_LINK],
    ['pointers', 'csr', SLOW_LINK],
    ['checks', 'csr', SLOW_LINK],
    ['columnStart', 'csr', null],
    ['values', 'csr', null],
    ['rows', 'csr', null],
    ['values', 'dense', null],
  ];
  for (const [damage, layout, link] of cases) {
    const label = `${damage} (${layout}${link === null ? '' : ', slow link'})`;
    // Over a slow link, a run keeps the values the first gene bought with it
    // (rows and values); one whose first gene held none (values stored
    // uncompressed, a gene with no entry) keeps entry positions alone.
    const structure = link !== null && (damage === 'positions' || damage === 'checks');
    const { tree, values } = wideTree(layout, 6, structure ? { compressed: false, mutate: dropGene(5) } : {});
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const first = await visit(tree, disk.environment, blocks(900), { link });
    await first.reader.getMatrixColumn('X', 5);
    await first.settled();
    first.reader.close();
    const [{ name, folder, manifest }] = keptDirectories(disk);
    if (structure) assert.equal(manifest.layout, 'structure', `${label}: kept as entry positions`);
    const blob = path.join(folder, 'd.bin');
    const bytes = readFileSync(blob);
    const regionOf = array => manifest.arrays[array].region;
    if (damage === 'truncate') {
      writeFileSync(blob, bytes.subarray(0, bytes.length - 8));
    } else if (damage === 'positions') {
      // Positions out of order (every position of the first genes the same).
      bytes.fill(0, regionOf('positions').offset, regionOf('positions').offset + 4096);
    } else if (damage === 'pointers') {
      // Row pointers another file's.
      bytes.fill(0x41, regionOf('rowPointers').offset + 8, regionOf('rowPointers').offset + 4096);
    } else if (damage === 'checks') {
      bytes.fill(0x13, regionOf('positionsChecks').offset, regionOf('positionsChecks').offset + 64);
    } else if (damage === 'columnStart') {
      // Still rising, to the same count: only its checksum finds it.
      const at = regionOf('columnStart').offset + 8 * 10;
      bytes.writeDoubleLE(bytes.readDoubleLE(at) + 1, at);
    } else {
      // Plausible values (or rows) in place of the kept ones: only the checksums find them.
      const region = regionOf(damage);
      const view = damage === 'rows'
        ? new Uint32Array(bytes.buffer, bytes.byteOffset + region.offset, region.byteLength / 4)
        : new Float32Array(bytes.buffer, bytes.byteOffset + region.offset, region.byteLength / 4);
      for (let i = 0; i < view.length; i++) view[i] = damage === 'rows' ? Math.min(view[i], 1) : 12345;
    }
    if (damage !== 'truncate') writeFileSync(blob, bytes);
    const again = await visit(tree, disk.environment, blocks(900), { link });
    const order = again.reader.cellSubset.openOrder;
    for (const gene of [0, 5, 77, N_VARS - 1]) assertGene(await again.reader.getMatrixColumn('X', gene), values, order, gene, `${label}: gene ${gene}`);
    await again.settled();
    again.reader.close();
    const left = keptDirectories(disk);
    assert.ok(left.every(({ name: other }) => other !== name), `${label}: the damaged run is removed`);
    assert.ok(left.length > 0, `${label}: the index built again is kept again`);
    // The run kept again serves the next opening.
    const next = await visit(tree, disk.environment, blocks(900), { link });
    assert.equal((await next.reader.geneReadPlan('X')).built, true, `${label}: kept again`);
    assertGene(await next.reader.getMatrixColumn('X', 77), values, next.reader.cellSubset.openOrder, 77, `${label}: next opening`);
    next.reader.close();
    await assertNothingHeld(disk, label);
  }
});

test('a dense run cut into a segment read by strips is let go: nothing is held once every reader closed', async t => {
  const { tree, values } = wideTree('dense', 4);
  // The whole matrix (2.9 MB) is over the budget (a row index); 200 rows x 300 genes (240 KB) within it (strips).
  const decodedChunkBytes = 400 * 1024;
  for (const ks of [[1800, 200], [600, 1800, 700]]) {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    for (const k of ks.slice(0, -1)) {
      const kept = await visit(tree, disk.environment, blocks(k), { decodedChunkBytes });
      await kept.reader.getMatrixColumn('X', 5);
      await kept.settled();
      kept.reader.close();
    }
    const last = await visit(tree, disk.environment, blocks(ks.at(-1)), { decodedChunkBytes });
    assertGene(await last.reader.getMatrixColumn('X', 5), values, last.reader.cellSubset.openOrder, 5, `k ${ks.join(' then ')}`);
    await last.settled();
    last.reader.close();
    await assertNothingHeld(disk, `k ${ks.join(' then ')}`);
  }
});

test('the writer hands its hold on a kept run to the page with no moment between', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 10);
  // Kept for one tab only: the sweep removes such a run the moment nobody holds it.
  const sized = { kind: 'remote', key: 'host:wide', version: 'size:1' };
  let handOver = null;
  const reader = await visit(tree, disk.environment, blocks(900), {
    identity: sized,
    tab: 'tab-a',
    onComplete: event => new Promise(resolve => { handOver = { event, resolve }; }),
  });
  await reader.reader.getMatrixColumn('X', 1);
  for (let wait = 0; handOver === null; wait++) {
    assert.ok(wait < 2000, 'the run is complete');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const { directory } = handOver.event;
  await sweepAbandonedTranscodes(disk.environment);
  assert.ok(keptDirectories(disk).some(({ name }) => name === directory), 'held by its writer until the page holds it');
  await holdTranscodedStore(directory, disk.environment);
  handOver.resolve();
  await reader.reader.whenIndexesKept();
  await sweepAbandonedTranscodes(disk.environment);
  assert.ok(keptDirectories(disk).some(({ name }) => name === directory), 'held by the page from then on');
  reader.reader.close();
});

test('a run whose rows are the opening\'s but whose row pointers are not the file\'s is removed', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 11);
  const first = await visit(tree, disk.environment, { mode: 'all' });
  await first.reader.getMatrixColumn('X', 1);
  await first.settled();
  first.reader.close();
  const [{ name }] = keptDirectories(disk);
  // The same identity, another file: one entry moved from the first row to the second.
  const { tree: other, values } = wideTree('csr', 11, { mutate: arrays => { arrays.indptr[1]--; } });
  const again = await visit(other, disk.environment, { mode: 'all' });
  assert.equal((await again.reader.geneReadPlan('X')).built, false);
  assertGene(await again.reader.getMatrixColumn('X', 1), values, Uint32Array.from({ length: N_OBS }, (_, i) => i), 1, 'the other file');
  await again.settled();
  again.reader.close();
  assert.ok(keptDirectories(disk).every(({ name: left }) => left !== name), 'the stale run is removed, not only let go');
});

/**
 * A browser whose storage refuses writes past `limit` bytes with a
 * QuotaExceededError while its estimate reports plenty (a private window).
 */
function withRealQuota(disk, limit) {
  const quota = { limit };
  const wrapFile = handle => ({
    ...handle,
    async createSyncAccessHandle() {
      const access = await handle.createSyncAccessHandle();
      return {
        ...access,
        write(view, options) {
          if (usage(disk.root) + view.length > quota.limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return access.write(view, options);
        },
      };
    },
  });
  const wrapDirectory = handle => ({
    ...handle,
    entries: handle.entries,
    getDirectoryHandle: async (...args) => wrapDirectory(await handle.getDirectoryHandle(...args)),
    getFileHandle: async (...args) => wrapFile(await handle.getFileHandle(...args)),
  });
  const getDirectory = disk.environment.navigator.storage.getDirectory;
  disk.environment.navigator.storage.getDirectory = async () => wrapDirectory(await getDirectory());
  return quota;
}

/** A converted store (an R object read whole) of `bytes` bytes, kept for later visits. */
async function convertedStore(disk, name, bytes) {
  const space = await openTranscodeSpace({ kind: 'file', name, size: 1, lastModified: 1 }, { environment: disk.environment });
  await space.put(new Uint8Array(bytes).fill(7));
  await space.finish({ whole: true, objects: [] }, new Set(['d.bin']));
  space.release();
  return space.directory;
}

const sizeOf = ({ manifest }) => Object.values(manifest.blobs).reduce((a, b) => a + b, 0);

test('a kept run makes room only from other kept runs, and tries again after the browser refuses a write for its quota', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 7);
  const converted = await convertedStore(disk, 'old.rds', 4096);
  const first = await visit(tree, disk.environment, blocks(900));
  await first.reader.getMatrixColumn('X', 1);
  await first.settled();
  first.reader.close();
  const before = keptDirectories(disk).filter(({ manifest }) => manifest.kind === 'column-index');
  const runBytes = before.reduce((sum, item) => sum + sizeOf(item), 0);
  // Room for one such index only once the first goes: the write is refused, the old runs make room, and it is kept.
  withRealQuota(disk, usage(disk.root) + runBytes * 0.6);
  const other = await visit(tree, disk.environment, { ...blocks(900), seed: 8 });
  await other.reader.getMatrixColumn('X', 1);
  await other.settled();
  other.reader.close();
  const after = keptDirectories(disk);
  assert.ok(before.every(({ name }) => !after.some(item => item.name === name)), 'the other runs made room');
  assert.ok(after.some(({ manifest }) => manifest.kind === 'column-index'), 'the new runs are kept');
  assert.ok(after.some(({ name }) => name === converted), 'a converted store is never removed for an optional copy');

  // Nothing but the converted store could make room: the run is not kept, the store stays.
  const tight = opfsOnDisk();
  t.after(() => tight.cleanup());
  const store = await convertedStore(tight, 'big.rds', 1 << 20);
  tight.environment.navigator.storage.estimate = async () => ({ quota: usage(tight.root) + 1024, usage: usage(tight.root) });
  const refused = await visit(tree, tight.environment, blocks(900));
  await refused.reader.getMatrixColumn('X', 1);
  await refused.settled();
  refused.reader.close();
  assert.deepEqual(keptDirectories(tight).map(({ name }) => name), [store]);
});

test('live work makes room from the copies cheapest to make again first: index runs before converted stores', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 12);
  // The converted store is the least recently used, but costlier to make again.
  const converted = await convertedStore(disk, 'old.rds', 64 * 1024);
  // The runs are kept later by the clock that stamps their use.
  const convertedAt = Date.now();
  await until(() => Date.now() > convertedAt, 'a later millisecond');
  const first = await visit(tree, disk.environment, blocks(900));
  await first.reader.getMatrixColumn('X', 1);
  await first.settled();
  first.reader.close();
  const runs = keptDirectories(disk).filter(({ manifest }) => manifest.kind === 'column-index');
  const runBytes = runs.reduce((sum, item) => sum + sizeOf(item), 0);
  disk.environment.navigator.storage.estimate = async () => ({ quota: 1000, usage: 1000 });
  // Asked ahead (a plan): counted, nothing removed.
  assert.ok(await diskFreeBytes(disk.environment, runBytes) >= runBytes);
  assert.equal(keptDirectories(disk).length, runs.length + 1);
  // Placing the index: the runs go, the converted store stays.
  assert.ok(await diskFreeBytes(disk.environment, runBytes, { makeRoom: true }) >= runBytes);
  assert.deepEqual(keptDirectories(disk).map(({ name }) => name), [converted]);
});

test('a link signed again is the same file in every identity form; no credential is filed', async () => {
  const signed = 'https://bucket.s3.amazonaws.com/x.h5ad?v=2&X-Amz-Signature=abc&X-Amz-Expires=60&token=t';
  const plain = 'https://bucket.s3.amazonaws.com/x.h5ad?v=2';
  for (const [form, of] of [
    ['a remote file\'s url', url => ({ kind: 'url', url, size: 4 })],
    ['a Zarr folder\'s url and version', url => ({ kind: 'url', url, version: '"e1"' })],
    ['a provider key that is a link', url => ({ kind: 'remote', key: `url:${encodeURIComponent(url)}`, version: '"e1"' })],
    ['a file of a set', url => ({ files: [{ kind: 'url', url, size: 4, name: 'a' }] })],
    ['a gene index group', url => ({ columnIndex: { file: { kind: 'url', url, size: 4 }, element: 'X' } })],
  ]) {
    assert.equal(await identityDigest(of(signed)), await identityDigest(of(plain)), form);
    assert.ok(!JSON.stringify(cacheKey(of(signed))).includes('abc'), `${form}: no signature is filed`);
  }
  assert.notEqual(await identityDigest({ kind: 'url', url: plain, size: 4 }), await identityDigest({ kind: 'url', url: 'https://bucket.s3.amazonaws.com/x.h5ad?v=3', size: 4 }), 'other parameters name another file');
});

test('one version rule: a content name, or a size with Last-Modified and a strong ETag; nothing else is kept across visits', () => {
  const remote = version => ({ kind: 'remote', key: 'k', version });
  for (const version of [
    `md5:${'a'.repeat(32)}:10`, 'revision:0B1x:10', 'census:2025-11-10', 'ctag:aYzpBQ:10',
    writeVersion({ size: 10, lastModified: 'Tue, 21 Oct 2026 07:28:00 GMT' }),
    writeVersion({ size: 10, etag: '"5f2b-1a"' }),
  ]) assert.equal(persistsAcrossVisits(remote(version)), true, version);
  assert.equal(writeVersion({ size: 10, etag: 'W/"5f2b"' }), null, 'a weak ETag alone names no version');
  assert.equal(writeVersion({ size: 10 }), null, 'no validator names no version');
  assert.equal(writeVersion({ size: 10, lastModified: 'Tue, 21 Oct 2026 07:28:00 GMT', etag: 'W/"5f2b"' }), 'written:10 modified:Tue, 21 Oct 2026 07:28:00 GMT', 'a weak ETag adds nothing');
  assert.equal(persistsAcrossVisits(remote('size:10')), false);
  assert.equal(persistsAcrossVisits({ kind: 'file', name: 'a.h5ad', size: 1, lastModified: 1 }), true, 'a local file: size and modification time');
  assert.equal(persistsAcrossVisits({ kind: 'file', name: 'a.h5ad', size: 1, lastModified: null }), false);
  assert.equal(persistsAcrossVisits({ files: [remote('census:1'), remote('size:3')] }), false, 'a set with a file of no version');
  assert.equal(persistsAcrossVisits({ columnIndex: { file: remote('census:1') } }), true);
  assert.equal(persistsAcrossVisits({ parts: remote('census:1'), size: 3 }), true);
});

test('the Stored row lists one gene index per file and cell order, refreshes on keep, and removal keeps what a tab holds', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 8);
  const changes = [];
  const stop = onKeptStoresChange(() => changes.push(1));
  t.after(stop);
  // A smaller subsample, then a larger one of the same seed: its new cells are other runs of the same file.
  let runs = 0;
  for (const k of [600, 1800]) {
    const opened = await visit(tree, disk.environment, blocks(k), { onComplete: event => holdTranscodedStore(event.directory, disk.environment) });
    await opened.reader.getMatrixColumn('X', 1);
    await opened.settled();
    runs += opened.stores.filter(s => s.state === 'complete').length;
    opened.reader.close();
  }
  assert.ok(runs > 1, 'several runs');
  assert.equal(changes.length, runs, 'the row hears every run kept');
  const items = await listKeptStores(disk.environment);
  assert.equal(items.length, 1, 'one item, however many runs');
  const [index] = items;
  assert.equal(index.kind, 'gene-index');
  assert.equal(index.held, 'this-tab', 'held by this page');
  assert.equal(index.matrix, 'X');
  assert.equal(index.order.method, 'blocks');
  assert.equal(index.order.seed, 3);
  assert.ok(index.bytes > 0 && index.used > 0);
  assert.equal(summarizeKeptStores(items).text, `1 dataset · ${formatBytes(index.bytes)} kept`);
  assert.deepEqual(await removeKeptStores([index.id], disk.environment), { removed: 0, held: 1 }, 'one item stays, however many runs');
  assert.equal(changes.length, runs + 1, 'a removal is heard');

  // The row: the summary, hidden while nothing is kept, refreshed when something is kept, and Manage… opens the dialog.
  const element = () => {
    const listeners = new Map();
    return { textContent: '', hidden: true, addEventListener: (type, f) => listeners.set(type, f), removeEventListener: type => listeners.delete(type), click: () => listeners.get('click')?.() };
  };
  const dom = { root: element(), text: element(), manage: element() };
  let now = [];
  let hear = null;
  let managed = null;
  const line = initKeptStoresLine(dom, {
    opening: { subscribe: () => () => {} },
    list: async () => now,
    place: async () => ({ available: true }),
    hosts: () => [],
    changes: listener => {
      hear = listener;
      return () => { hear = null; };
    },
    onManage: opener => { managed = opener; },
  });
  await line.refresh();
  assert.equal(dom.root.hidden, true, 'hidden while nothing is kept');
  now = [{ ...index, bytes: 3_145_728 }, { id: 'converted:a', kind: 'converted', file: 'f', bytes: 1024 }, { id: 'download:a', kind: 'download', file: 'f', bytes: 1024 }];
  hear();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dom.root.hidden, false);
  assert.equal(dom.text.textContent, '2 datasets · 3.0 MB kept', 'a converted store and its download are one dataset; one line beside Manage…');
  dom.manage.click();
  assert.equal(managed, dom.manage, 'focus returns to Manage…');
  line.destroy();
  assert.equal(hear, null);

  // A window that gives the site no storage that lasts says so, with nothing kept.
  const bare = { root: element(), text: element(), manage: element() };
  const privateLine = initKeptStoresLine(bare, { opening: { subscribe: () => () => {} }, list: async () => [], place: async () => ({ available: false }), changes: () => () => {} });
  await privateLine.refresh();
  assert.equal(bare.root.hidden, false);
  assert.equal(bare.text.textContent, 'Kept for this tab only');
  privateLine.destroy();
});

test('a kept run stamped by other code is removed, never read: the index is built again, kept again, and exact', async t => {
  for (const [layout, link] of [['csr', null], ['csr', SLOW_LINK], ['dense', null]]) {
    const kind = `${layout}${link === null ? '' : ' over a slow link'}`;
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const { tree, values } = wideTree(layout, 13);
    const first = await visit(tree, disk.environment, blocks(900), { link });
    await first.reader.getMatrixColumn('X', 7);
    await first.settled();
    first.reader.close();
    const runs = keptDirectories(disk);
    assert.ok(runs.length > 0 && runs.every(({ manifest }) => manifest.kind === 'column-index' && manifest.codeFingerprint === KEPT_CODE_FINGERPRINTS.index),
      `${kind}: each run is stamped with the code fingerprint of gene indexes`);
    // The same runs, as other code would have left them.
    for (const { folder, manifest } of runs) writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ ...manifest, codeFingerprint: 'other code' }));

    const again = await visit(tree, disk.environment, blocks(900), { link });
    assert.equal((await again.reader.geneReadPlan('X')).built, false, `${kind}: no run of other code is used`);
    const order = again.reader.cellSubset.openOrder;
    for (const gene of [7, 0, N_VARS - 1]) assertGene(await again.reader.getMatrixColumn('X', gene), values, order, gene, `${kind} gene ${gene}`);
    assert.ok(again.matrixReads().length > 0, `${kind}: the index is built from the file again`);
    await again.settled();
    again.reader.close();
    const left = keptDirectories(disk);
    assert.ok(runs.every(({ name }) => !left.some(item => item.name === name)), `${kind}: the runs of other code are removed`);
    assert.ok(left.length > 0 && left.every(({ manifest }) => manifest.codeFingerprint === KEPT_CODE_FINGERPRINTS.index), `${kind}: this code's runs are kept`);
    const next = await visit(tree, disk.environment, blocks(900), { link });
    assert.equal((await next.reader.geneReadPlan('X')).built, true, `${kind}: kept again`);
    next.reader.close();
    await assertNothingHeld(disk, `${kind} other code`);
  }
});
