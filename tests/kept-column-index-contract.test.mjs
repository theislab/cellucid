/**
 * Gene indexes kept in this browser across visits
 * (`assets/js/data/anndata/kept-column-index.js`): the column index of a
 * cell-major matrix, built over the open cells, kept in the origin-private
 * file system (`transcode/space.js`) under the file's identity, the matrix
 * and the order the cells are opened in.
 *
 * - A later opening of the same cells of a file whose identity names its
 *   content reads no byte of the matrix but genes (a store with values
 *   reads nothing; a structure over a slow link only the gene's values).
 *   One whose identity says only when it was written (a local file, a
 *   Last-Modified date, a host's ETag) reads the run's fingerprint first:
 *   a seeded row in each doubling band of its rows.
 * - A rewrite under the same identity (a gene order reversed, the row
 *   pointers unchanged) is found by the fingerprint; the run is removed and
 *   the values are the new file's.
 * - Nested reuse across k: a larger subsample of the same method and seed
 *   indexes only its new cells; a smaller one reads its rows from the kept
 *   runs it shares.
 * - Identity: another version of the file, another seed, never reuse a run;
 *   a file known by its size alone is kept for its tab only.
 * - Integrity: every gene's stored piece carries a CRC-32, checked as it is
 *   read; a damaged run (bytes, row pointers, checksums) is removed, the
 *   index built again and kept again, and the values are exact.
 * - Holds: every run an opening takes is let go when its reader closes (a
 *   dense segment read by strips too); the writer hands its hold to the
 *   page with no moment between.
 * - Room: kept runs make room only from other kept runs (never a converted
 *   store), try again after a QuotaExceededError, and live work removes
 *   runs before converted stores.
 * - The revision of what a kept index holds is raised whenever the code
 *   that decides its bytes changes (comments aside).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { annData, countingStore, dataFrame, dense, mapping, sparse, strings } from './helpers/anndata-store.mjs';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';
import { codeDigest, codeOf, sourceClosure } from './helpers/code-digest.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import {
  KEPT_INDEX_REVISION,
  TRANSCODED_DIRECTORY,
  cacheKey,
  clearKeptStores,
  holdTranscodedStore,
  identityDigest,
  keptStoresUsage,
  namesContent,
  onKeptStoresChange,
  openTranscodeSpace,
  sweepAbandonedTranscodes,
} from '../assets/js/data/anndata/transcode/space.js';
import { fingerprintRows } from '../assets/js/data/anndata/kept-column-index.js';
import { diskFreeBytes } from '../assets/js/data/column-store-placement.js';
import { describeCleared, describeKeptStores, initKeptStoresLine } from '../assets/js/app/ui/modules/kept-stores-line.js';

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

function wideTree(layout, seed = 1, { mutate = null } = {}) {
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
    X = sparse({ format: 'csr', ...arrays, shape: [N_OBS, N_VARS], compressed: true });
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

/** A link slower than a disk: the index is the structure, values read per gene. */
const SLOW_LINK = Object.freeze({ readsAhead: false, mergeGapBytes: 0, snapshot: () => ({ measured: false }), watchProtocol() {} });

/** A file whose identity names its content (a provider's checksum): what is kept of it is used without reading it. */
const FILE = Object.freeze({ kind: 'remote', key: 'host:wide', version: `md5:${'0'.repeat(32)}:1` });
/** A local file: its name, size and modification time say when it was written, not what it holds. */
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

/** Every kept directory held by nobody: what `clearKeptStores` says once every reader closed. */
async function assertNothingHeld(disk, label) {
  await new Promise(resolve => setTimeout(resolve, 20));
  const cleared = await clearKeptStores(disk.environment);
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
    const plan = await large.reader.geneReadPlan('X');
    assert.equal(plan.progressive?.done, 600, 'the kept cells are indexed already');
    const order = large.reader.cellSubset.openOrder;
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

test('a file whose identity does not name its content is checked against the run\'s fingerprint; a rewrite under it is found', async t => {
  for (const [layout, link] of [['csr', null], ['csr', SLOW_LINK], ['dense', null]]) {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const kind = `${layout}${link === null ? '' : ' over a slow link'}`;
    const { tree } = wideTree(layout, 9);
    const first = await visit(tree, disk.environment, blocks(900), { identity: LOCAL, link });
    await first.reader.getMatrixColumn('X', 5);
    await first.settled();
    // The fingerprint is the pass's: keeping the run reads no chunk again
    // (values read on demand: only the fingerprint rows' values, once).
    const builtReads = first.matrixReads();
    if (link === null) assert.equal(new Set(builtReads).size, builtReads.length, `${kind}: no chunk read twice to keep the run`);
    first.reader.close();
    const [{ name: kept, manifest }] = keptDirectories(disk);
    manifest.fingerprint.forEach(({ row }, band) => {
      assert.ok(row >= 2 ** band - 1 && row < Math.min(manifest.nRows, 2 ** (band + 1) - 1), `one row in each doubling band (${band}: ${row})`);
    });
    assert.equal(manifest.fingerprint.length, fingerprintRows(manifest.nRows).length);

    // The same file again: the fingerprint's rows are read, nothing else of the index.
    const same = await visit(tree, disk.environment, blocks(900), { identity: LOCAL, link });
    assert.equal((await same.reader.geneReadPlan('X')).built, true, `${kind}: the unchanged file's run is used`);
    const fingerprintReads = same.matrixReads().length;
    // Each row's entries are in at most two chunks of each array.
    assert.ok(fingerprintReads > 0 && fingerprintReads <= (layout === 'dense' ? 2 : 4) * manifest.fingerprint.length, `${kind}: ${fingerprintReads} chunks read for the fingerprint`);
    same.reader.close();

    if (layout === 'dense') continue;
    // Rewritten under the same identity, its row pointers as they were: another gene's values would be served.
    const { tree: rewritten, values } = wideTree(layout, 9, { mutate: reverseGenes });
    const after = await visit(rewritten, disk.environment, blocks(900), { identity: LOCAL, link });
    assert.equal((await after.reader.geneReadPlan('X')).built, false, `${kind}: the rewritten file's run is not used`);
    const order = after.reader.cellSubset.openOrder;
    assertGene(await after.reader.getMatrixColumn('X', 5), values, order, 5, `${kind} rewritten`);
    await after.settled();
    after.reader.close();
    assert.ok(keptDirectories(disk).every(({ name }) => name !== kept), `${kind}: the run of the old file is removed`);
  }
});

test('a fingerprint the file cannot be read for now leaves the run kept for the next opening', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const { tree } = wideTree('csr', 13);
  const first = await visit(tree, disk.environment, blocks(900), { identity: LOCAL });
  await first.reader.getMatrixColumn('X', 5);
  await first.settled();
  first.reader.close();
  const kept = keptDirectories(disk).map(({ name }) => name);
  // The matrix's chunks fail (a dropped connection) while the runs are checked.
  const failing = await visit(tree, disk.environment, blocks(900), {
    identity: LOCAL,
    onChunk: key => { if (/^X\/(data|indices)\//.test(key)) throw new TypeError('Failed to fetch'); },
  });
  assert.equal((await failing.reader.geneReadPlan('X')).built, false, 'not used unchecked');
  failing.reader.close();
  assert.deepEqual(keptDirectories(disk).map(({ name }) => name), kept, 'not removed');
  const later = await visit(tree, disk.environment, blocks(900), { identity: LOCAL });
  assert.equal((await later.reader.geneReadPlan('X')).built, true, 'used once the file reads again');
  later.reader.close();
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
    const { tree, values } = wideTree(layout, 6);
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const first = await visit(tree, disk.environment, blocks(900), { link });
    await first.reader.getMatrixColumn('X', 5);
    await first.settled();
    first.reader.close();
    const [{ name, folder, manifest }] = keptDirectories(disk);
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
  await new Promise(resolve => setTimeout(resolve, 5));
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

test('which identities name their file\'s content (no fingerprint), and which only when it was written', () => {
  const remote = version => ({ kind: 'remote', key: 'k', version });
  for (const version of [
    `md5:${'a'.repeat(32)}:10`, 'revision:0B1x:10', `figshare:123v2:${'b'.repeat(32)}`, 'zenodo:7:md5:abc', `hf:${'c'.repeat(40)}:${'d'.repeat(64)}`,
    'census:2025-11-10', 'ctag:aYzpBQ:10', 'e'.repeat(64),
  ]) assert.equal(namesContent(remote(version)), true, version);
  for (const version of ['"5f2b-1a"', 'W/"5f2b"', 'modified:Tue, 21 Oct 2026 07:28:00 GMT', 'size:10', 'figshare:123v2:', 'zenodo:7:', '"18a2c-6420f1b2c-1"']) {
    assert.equal(namesContent(remote(version)), false, version);
  }
  assert.equal(namesContent({ kind: 'file', name: 'a.h5ad', size: 1, lastModified: 1 }), false, 'a local file');
  assert.equal(namesContent({ kind: 'url', url: 'https://x/a.zarr', version: '"e"' }), false, 'a served folder');
  assert.equal(namesContent({ files: [remote('census:1'), remote('"e"')] }), false);
  assert.equal(namesContent({ files: [remote('census:1'), remote(`md5:${'a'.repeat(32)}:1`)] }), true);
  // Each band of rows holds one, and any first n rows floor(log2(n + 1)) of them.
  const rows = fingerprintRows(1000);
  assert.equal(rows.length, 10);
  for (let n = 1; n <= 1000; n++) assert.ok(rows.filter(row => row < n).length >= Math.floor(Math.log2(n + 1)));
});

test('the Session panel line says which files\' gene indexes are kept, refreshes on keep, and clears what no tab uses', async t => {
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
  assert.equal(changes.length, runs, 'the line hears every run kept');
  const usageNow = await keptStoresUsage(disk.environment);
  assert.equal(usageNow.stores, 0);
  assert.equal(usageNow.indexes, 1, 'one file, however many runs');
  assert.equal(usageNow.indexesHeld, 1, 'held by this page');
  assert.equal(usageNow.clearable, 0);
  assert.ok(usageNow.indexBytes > 0);
  assert.deepEqual(await clearKeptStores(disk.environment), { removed: 0, held: 1 }, 'one file stays, however many runs');
  assert.equal(
    describeKeptStores({ stores: 0, bytes: 0, held: 0, indexes: 1, indexBytes: 3_145_728, indexesHeld: 0 }),
    'The gene index of 1 file stored cell by cell kept in this browser (3.0 MB): opened again with the same cells, its genes are read at once'
  );
  assert.equal(
    describeKeptStores({ stores: 2, bytes: 1024, held: 1, indexes: 3, indexBytes: 2048, indexesHeld: 3 }),
    '2 files kept in this browser (1.0 KB): opened again, they are not read again (1 of them in use by open tabs); ' +
    'the gene index of 3 files stored cell by cell kept in this browser (2.0 KB): opened again with the same cells, their genes are read at once (all in use by open tabs)'
  );
  assert.equal(describeCleared({ removed: 3, held: 0 }), '');
  assert.equal(describeCleared({ removed: 3, held: 1 }), 'The file in use by an open tab stays until that tab closes.');
  assert.equal(describeCleared({ removed: 0, held: 2 }), '2 files in use by open tabs stay until those tabs close.');

  // The line: Clear is offered while anything is used by no open tab, even when other runs of the same file are held.
  const element = () => {
    const listeners = new Map();
    return { textContent: '', hidden: true, disabled: false, addEventListener: (type, f) => listeners.set(type, f), removeEventListener: type => listeners.delete(type), click: () => listeners.get('click')?.() };
  };
  const dom = { root: element(), text: element(), clear: element() };
  let now = { stores: 0, bytes: 0, held: 0, indexes: 1, indexBytes: 10, indexesHeld: 1, clearable: 1 };
  let hear = null;
  let cleared = 0;
  const line = initKeptStoresLine(dom, {
    opening: { subscribe: () => () => {} },
    usage: async () => now,
    clear: async () => {
      cleared++;
      now = { ...now, clearable: 0 };
      return { removed: 1, held: 1 };
    },
    changes: listener => {
      hear = listener;
      return () => { hear = null; };
    },
  });
  await line.refresh();
  assert.equal(dom.clear.disabled, false, 'a run of a held file that nobody holds can be cleared');
  assert.equal(dom.root.hidden, false);
  await dom.clear.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cleared, 1);
  assert.equal(dom.clear.disabled, true);
  assert.match(dom.text.textContent, /\. The file in use by an open tab stays until that tab closes\.$/);
  now = { ...now, indexes: 2, indexBytes: 20, clearable: 2 };
  hear();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(dom.text.textContent, /gene index of 2 files/, 'refreshed when a run is kept');
  line.destroy();
  assert.equal(hear, null);
});

/**
 * The code that decides the bytes a kept index holds, and so what a kept
 * run means: followed from these modules through every relative import.
 *
 * - The index and its kept form: the column stores and their kept form,
 *   the index's build (`sparse-column-index.js`), the runs of rows
 *   (`prefix-column-index.js`), the kept format (`kept-column-index.js`).
 * - The values and entries it is built from: the matrix's reads
 *   (`matrix-access.js`: `readValues`, `readRows`, `writeFloat32`), their
 *   conversion (`values.js`: `readNumbers`, `readIntegers`), the subsample's
 *   view of the file's rows (`views/cell-subset.js`), the layouts a file is
 *   presented through (`views/index.js`, `older-layouts.js`), and the
 *   readers that decode the file's chunks (`formats/zarr`, `formats/hdf5`,
 *   `formats/zip`, and the decode worker that runs their codecs).
 *
 * The comments of these files do not count (`helpers/code-digest.mjs`
 * `codeOf`: each file printed by esbuild with comments and whitespace
 * removed, a semantics-preserving print), so a comment changes nothing;
 * any change to code does.
 */
const ENTRIES = [
  'assets/js/data/anndata/kept-column-index.js',
  'assets/js/data/sparse-column-index.js',
  'assets/js/data/anndata/prefix-column-index.js',
  'assets/js/data/anndata/matrix-access.js',
  'assets/js/data/anndata/values.js',
  'assets/js/data/anndata/views/cell-subset.js',
  'assets/js/data/anndata/views/index.js',
  'assets/js/data/anndata/older-layouts.js',
  'assets/js/formats/zarr/index.js',
  'assets/js/formats/hdf5/index.js',
  'assets/js/formats/zip/index.js',
  'assets/js/formats/io/decode-worker.js',
];

/**
 * Modules reached from those that do not decide what a run holds, each
 * with why (and, followed no further, what only they import). A module
 * newly imported by a guarded one is guarded until it is listed here.
 */
const LEFT_OUT = new Map([
  // Holds the revision (guarding it would change the digest with every raise); writes no index content.
  ['assets/js/data/anndata/transcode/space.js', 'keeps the runs; holds the revision'],
  // Move bytes, schedule work or measure the link: what arrives is the same bytes.
  ['assets/js/formats/io/byte-source.js', 'transport'],
  ['assets/js/formats/io/byte-reader.js', 'transport'],
  ['assets/js/formats/io/host-fetch.js', 'transport'],
  ['assets/js/formats/io/link.js', 'link measurement'],
  ['assets/js/formats/io/mirrors.js', 'transport'],
  ['assets/js/formats/io/abort.js', 'cancellation'],
  ['assets/js/formats/io/activity.js', 'progress reporting'],
  ['assets/js/formats/io/decode-pool.js', 'runs the codecs (guarded through the decode worker) on worker threads'],
  ['assets/js/data/memory-budget.js', 'residency policy'],
  ['assets/js/utils/format-units.js', 'messages'],
  ['assets/workers/scripts.js', 'generated names of the worker bundles'],
  // Say what a file is or which modality is shown first; the matrix a run indexes is named in its group.
  ['assets/js/data/input-formats.js', 'recognises formats'],
  ['assets/js/data/data-mapping.js', 'names the default modality'],
]);

/** Every revision's digest of that code, oldest first: a row is added for every change, never edited. */
const INDEX_REVISIONS = [
  { revision: 1, digest: 'dda0ce2eaf4a5e4946fc24756d7f0e2ff1048fa879588997a68c1fbcf5704b41' },
];

test('the kept-index revision is raised whenever the code that decides what an index holds changes', () => {
  const root = new URL('..', import.meta.url).pathname;
  const { guarded, reached } = sourceClosure(root, ENTRIES, LEFT_OUT);
  // Every left-out module is one the guarded code reaches (a stale entry is removed).
  for (const file of LEFT_OUT.keys()) assert.ok(reached.has(file), `${file} is left out but no longer reached`);
  // Every container reader the reader opens a file with is followed.
  const opens = readFileSync(path.join(root, 'assets/js/data/anndata/open.js'), 'utf8');
  for (const [, target] of opens.matchAll(/from '(\.\.\/\.\.\/formats\/[^/']+\/index\.js)'/g)) {
    const file = path.posix.normalize(path.posix.join('assets/js/data/anndata', target));
    assert.ok(reached.has(file), `${file}, which opens files, is followed`);
  }
  assert.ok(guarded.includes('assets/js/formats/zarr/codecs/blosc.js') && guarded.includes('assets/js/formats/hdf5/filters.js') && guarded.includes('assets/js/data/anndata/values.js'), 'the decoders and the conversion are guarded');
  // A comment changes nothing; code does.
  assert.equal(codeOf('const a = 1; // one\n/** two */\nexport { a };', 'x.js'), codeOf('const a = 1;\nexport { a };', 'x.js'));
  assert.notEqual(codeOf('const a = 1;\nexport { a };', 'x.js'), codeOf('const a = 2;\nexport { a };', 'x.js'));
  assert.notEqual(codeOf('const a = "x  y";', 'x.js'), codeOf('const a = "x y";', 'x.js'), 'the text of a string is code');
  const digest = codeDigest(root, guarded);
  INDEX_REVISIONS.forEach((row, index) => {
    if (index > 0) assert.equal(row.revision, INDEX_REVISIONS[index - 1].revision + 1, 'one row per revision, in order');
  });
  assert.equal(new Set(INDEX_REVISIONS.map(row => row.digest)).size, INDEX_REVISIONS.length, 'every revision has its own code');
  assert.deepEqual({ revision: KEPT_INDEX_REVISION, digest }, INDEX_REVISIONS.at(-1),
    'The code that decides what a kept gene index holds changed: raise KEPT_INDEX_REVISION in assets/js/data/anndata/transcode/space.js ' +
    '(indexes kept by the earlier revision are then removed, not read), and add a row with the new revision and digest here.');
  // A row is never edited: against the committed test, a new digest comes with a new revision.
  let committed = null;
  try {
    committed = execFileSync('git', ['show', 'HEAD:tests/kept-column-index-contract.test.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    committed = null;
  }
  for (const [, revision, recorded] of committed?.matchAll(/\{ revision: (\d+), digest: '([0-9a-f]{64})' \}/g) ?? []) {
    const row = INDEX_REVISIONS.find(item => item.revision === Number(revision));
    assert.equal(row?.digest, recorded, `revision ${revision}'s committed digest is kept as it was: a change takes the next revision`);
  }
});
