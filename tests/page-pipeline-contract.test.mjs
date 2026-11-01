/**
 * The page's own work between the reader's answer and the pixels, held to
 * the bytes it must produce and to what it costs at 10M cells.
 *
 * - The continuous colour kernels (`state/managers/continuous-colors.js`)
 *   are the per-cell rule, byte for byte, on columns made of what fields
 *   are made of at scale: runs of one value (a gene's zeros), a gene
 *   sample's unread NaN tail, the neutral floor, -0, infinities (scanned,
 *   with their cells named).
 * - A gene reaches the page with its sparse form (`data/column-forms.js`):
 *   the reader worker makes it where the column is made, the page notes it
 *   beside the column, and colours and statistics are read from it (a word
 *   fill and its entries, not two passes over every cell: ~50 ms of the
 *   main thread at 10M). A gene shown while its index is built crosses as
 *   that form alone, not as a whole column a partial answer.
 * - An inactive gene keeps its form alone (its entries, not four bytes a
 *   cell), and is made again from it, without a read, when shown.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COLORMAP_TABLE_BUCKETS, CONTINUOUS_COLORMAPS } from '../assets/js/data/palettes.js';
import { NEUTRAL_GRAY_UINT8 } from '../assets/js/app/state/core/constants.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE } from '../assets/js/rendering/alpha-visibility.js';
import { scanContinuousColumn, writeContinuousColors } from '../assets/js/app/state/managers/continuous-colors.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { columnFormOf, filledForm, noteColumnForm, resizedForm, sparseFormOf } from '../assets/js/data/column-forms.js';
import { resizedCellArray } from '../assets/js/app/state/managers/open-cells.js';
import { annData, dataFrame, dense, mapping, sparse, strings, zarrEntries } from './helpers/anndata-store.mjs';

/**
 * The per-cell rule: grey beneath for NaN, a non-positive value on a log
 * scale, or a value at or below the floor; the bottom layer (not read) for
 * the cells from `readRows` on.
 */
function referenceColors(values, domain, colormap, readRows = values.length) {
  const colors = new Uint8Array(values.length * 4);
  const useLog = domain.scale === 'log';
  const logMin = useLog ? Math.log10(domain.min) : 0;
  const denom = useLog ? Math.log10(domain.max) - logMin : domain.max - domain.min;
  const floor = domain.neutralAtOrBelow ?? Number.NaN;
  const sample = [0, 0, 0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (i >= readRows) {
      colors.set([NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, UNREAD_ALPHA_BYTE], i * 4);
      continue;
    }
    if (Number.isNaN(v) || (useLog && v <= 0) || v <= floor) {
      colors.set([NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, BENEATH_ALPHA_BYTE], i * 4);
      continue;
    }
    const t = denom === 0 ? 0.5 : useLog ? (Math.log10(v) - logMin) / denom : (v - domain.min) / denom;
    colormap.sampleInto(t, sample);
    colors.set([...sample.map(channel => Math.round(channel * 255)), 255], i * 4);
  }
  return colors;
}

/** The range and non-finite tally by their definitions, one value at a time. */
function referenceScan(values) {
  const out = { tally: { nan: 0, positiveInfinity: 0, negativeInfinity: 0, examples: [], total: values.length }, min: Infinity, max: -Infinity, minPositive: Infinity, maxPositive: -Infinity };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) { out.tally.nan++; continue; }
    if (v === Infinity || v === -Infinity) {
      if (v > 0) out.tally.positiveInfinity++; else out.tally.negativeInfinity++;
      if (out.tally.examples.length < 5) out.tally.examples.push(i);
      continue;
    }
    if (v < out.min) out.min = v;
    if (v > out.max) out.max = v;
    if (v > 0) { out.minPositive = Math.min(out.minPositive, v); out.maxPositive = Math.max(out.maxPositive, v); }
  }
  return out;
}

/** A column as fields at scale are: runs of zeros, of one value, of NaN, and a NaN tail. */
function runsColumn(Values, n, seed, { negative = false, infinities = false } = {}) {
  const random = createMulberry32(seed);
  const values = new Values(n);
  let i = 0;
  while (i < n) {
    const run = 1 + Math.floor(random() * 40);
    const pick = random();
    const value = pick < 0.45 ? 0
      : pick < 0.5 ? -0
        : pick < 0.6 ? Number.NaN
          : pick < 0.62 && infinities ? (random() < 0.5 ? Infinity : -Infinity)
            : Math.fround((negative ? random() * 20 - 5 : random() * 15) * (random() < 0.5 ? 1 : 1 / 3));
    values.fill(value, i, Math.min(n, i + run));
    i += run;
  }
  // A gene sample's unread cells.
  values.fill(Number.NaN, Math.floor(n * 0.8));
  return values;
}

test('the colour kernels are the per-cell rule on runs, NaN tails, the floor and -0, at every scale and colormap', () => {
  for (const Values of [Float32Array, Float64Array]) {
    for (const [seed, negative] of [[1, false], [2, true]]) {
      const values = runsColumn(Values, 6000, seed, { negative });
      const scan = scanContinuousColumn(values);
      const domains = [
        { min: scan.min, max: scan.max, scale: 'linear' },
        { min: scan.min, max: scan.max, scale: 'linear', neutralAtOrBelow: 0 },
        { min: 2, max: 7, scale: 'linear', neutralAtOrBelow: 0 },
        { min: 4, max: 4, scale: 'linear' },
        { min: 0.25, max: 15, scale: 'log' },
      ];
      for (const colormap of CONTINUOUS_COLORMAPS) {
        for (const domain of domains) {
          const colors = new Uint8Array(values.length * 4);
          writeContinuousColors(colors, values, domain, colormap);
          assert.deepEqual(colors, referenceColors(values, domain, colormap), `${Values.name} seed ${seed} ${colormap.id} ${JSON.stringify(domain)}`);
        }
      }
    }
  }
});

test('the scan is the range and tally by definition, infinities named by their cells, runs and NaN tails included', () => {
  for (const Values of [Float32Array, Float64Array]) {
    for (const seed of [3, 4, 5]) {
      const values = runsColumn(Values, 20000, seed, { negative: seed === 4, infinities: true });
      const scan = scanContinuousColumn(values);
      const expected = referenceScan(values);
      assert.deepEqual({ ...scan, tally: { ...scan.tally } }, expected, `${Values.name} seed ${seed}`);
    }
  }
  // -0 then +0, +0 then -0: the first zero seen is the minimum's sign, as by definition.
  for (const values of [Float32Array.of(-0, 0, 2), Float32Array.of(0, -0, 2)]) {
    assert.ok(Object.is(scanContinuousColumn(values).min, referenceScan(values).min));
  }
});

test('the linear dense kernel samples the colormap only for the table\'s inexact buckets', () => {
  // Every value distinct (a continuous obs column): the colormap's sampler
  // runs for about 1 % of the cells, the table answers the rest.
  const colormap = CONTINUOUS_COLORMAPS[0];
  let sampled = 0;
  const counting = { ...colormap, sampleInto: (t, out) => { sampled++; return colormap.sampleInto(t, out); } };
  const n = 200000;
  const random = createMulberry32(9);
  const values = Float32Array.from({ length: n }, () => random() * 10);
  // The colormap's byte table is built once (its own samples), then counted.
  writeContinuousColors(new Uint8Array(4), values.subarray(0, 1), { min: 0, max: 10, scale: 'linear' }, counting);
  sampled = 0;
  writeContinuousColors(new Uint8Array(n * 4), values, { min: 0, max: 10, scale: 'linear' }, counting);
  assert.ok(sampled < n * 0.03, `the sampler ran ${sampled} times for ${n} cells (${COLORMAP_TABLE_BUCKETS} buckets)`);
  // A gene sample's NaN tail and a gene's zeros sample nothing at all.
  sampled = 0;
  const gene = new Float32Array(n);
  gene.fill(Number.NaN, n / 2);
  writeContinuousColors(new Uint8Array(n * 4), gene, { min: 0, max: 3, scale: 'linear', neutralAtOrBelow: 0 }, counting);
  assert.equal(sampled, 0);
});

/** The column a sparse form stands for. */
function denseOfForm({ length, indices, values, readRows }) {
  const out = new Float32Array(length);
  out.fill(Number.NaN, readRows);
  indices.forEach((cell, k) => { out[cell] = values[k]; });
  return out;
}

function sameBits(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  assert.deepEqual(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength), new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength), `${label}: bits`);
}

test('a sparse form gives back its column bit for bit, and is made only when smaller', () => {
  const column = new Float32Array(1000);
  column[3] = 2; column[10] = -0; column[11] = Number.NaN; column[500] = -1.5;
  column.fill(Number.NaN, 900);
  const form = sparseFormOf(column);
  assert.equal(form.readRows, 900, 'the NaN tail found from the end');
  assert.deepEqual(Array.from(form.indices), [3, 10, 11, 500], '-0 and a NaN inside the cells read are entries');
  sameBits(denseOfForm(form), column, 'round trip');
  // Told where the cells read end.
  assert.equal(sparseFormOf(column, 950).readRows, 950);
  // As many bytes as the column or more: no form.
  const dense = Float32Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 0 : i));
  assert.equal(sparseFormOf(dense), null);
  // Float64 columns too.
  const wide = Float64Array.from({ length: 100 }, (_, i) => (i === 7 ? 0.1 : 0));
  assert.deepEqual(Array.from(sparseFormOf(wide).values), [0.1]);
});

test('a column whose form was noted is coloured and scanned from the form', () => {
  const n = 5000;
  const truth = new Float32Array(n);
  for (let i = 0; i < n; i += 41) truth[i] = 1 + (i % 7);
  truth.fill(Number.NaN, 4000);
  const form = sparseFormOf(truth);
  // A column whose cells say otherwise: only the form can give the truth's
  // colours, so the kernels read it and no cell of the column.
  const column = new Float32Array(n).fill(9);
  noteColumnForm(column, form);
  assert.strictEqual(columnFormOf(column), form);
  const colormap = CONTINUOUS_COLORMAPS[0];
  const domain = { min: 0, max: 7, scale: 'linear', neutralAtOrBelow: 0 };
  const fromForm = new Uint8Array(n * 4);
  writeContinuousColors(fromForm, column, domain, colormap);
  // The form's NaN tail (from 4000) is its cells not read.
  assert.deepEqual(fromForm, referenceColors(truth, domain, colormap, 4000));
  assert.deepEqual(scanContinuousColumn(column), referenceScan(truth));
  // A form given as the column itself (a partial gene's) reads the same.
  const asColumn = new Uint8Array(n * 4);
  writeContinuousColors(asColumn, form, domain, colormap);
  assert.deepEqual(asColumn, fromForm);
  assert.deepEqual(scanContinuousColumn(form), referenceScan(truth));
  // A form must be of the column's length, its entries below readRows.
  assert.throws(() => noteColumnForm(new Float32Array(10), form), /sparse form/);
  assert.throws(() => noteColumnForm(new Float32Array(10), { length: 10, indices: Uint32Array.of(8), values: Float32Array.of(1), readRows: 5 }), /below 5/);
});

const N_OBS = 2400;
const N_VARS = 1100;
const SPARSE_GENES = 10;

/** A CSR X with about a thousand entries a cell (its gene index of a subsample spans segments); genes below SPARSE_GENES sparse. */
function segmentedTree() {
  const random = createMulberry32(3);
  const values = new Float32Array(N_OBS * N_VARS);
  for (let cell = 0; cell < N_OBS; cell++) {
    for (let gene = 0; gene < N_VARS; gene++) {
      const p = gene < SPARSE_GENES ? 0.03 : 0.92;
      if (random() < p) values[cell * N_VARS + gene] = Math.fround(1 + random() * 9);
    }
  }
  const data = [];
  const indices = [];
  const indptr = [0];
  for (let cell = 0; cell < N_OBS; cell++) {
    for (let gene = 0; gene < N_VARS; gene++) {
      const value = values[cell * N_VARS + gene];
      if (value !== 0) { indices.push(gene); data.push(value); }
    }
    indptr.push(data.length);
  }
  const X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [N_OBS, N_VARS] });
  X.children.data.chunks = [65536];
  X.children.indices.chunks = [65536];
  X.children.indptr.chunks = [512];
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: N_OBS }, (_, i) => `cell-${i}`), { chunks: [128] }) }),
    var: dataFrame({ _index: strings(Array.from({ length: N_VARS }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: N_OBS * 2 }, () => random() * 10), [N_OBS, 2], { chunks: [150, 2] }) }),
    X,
  });
  return { tree, values };
}

test('a gene reaches the page with its form noted, and while its index builds its partial answers are forms', async t => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient } = await import('../assets/js/data/anndata-reader-client.js');
  const { setNextCellSubsetRequest } = await import('../assets/js/data/cell-subset-policy.js');
  const { tree, values } = segmentedTree();
  const files = new Map([...zarrEntries(tree)].map(([key, bytes]) => [`seg.zarr/${key}`, new File([bytes], key.split('/').at(-1))]));
  const client = new AnnDataReaderClient();
  t.after(() => client.close());
  // Genes read for every open cell (`genes: 'all'`), so a gene spans
  // several index segments whatever the link measures (a sample fitted to
  // the first gene's time rests on this in-process reader's link, whose
  // reads share the test's one thread with the whole opening).
  setNextCellSubsetRequest({ mode: 'subsample', method: 'blocks', k: 2000, seed: 1, blockSize: 50, genes: 'all' });
  await client.open({ files, rootName: 'seg.zarr' });
  assert.equal(client.geneSample, null, 'genes are read for every open cell');
  const order = client.cellSubset.openOrder;
  const gene = 4;
  const heard = [];
  const column = await client.getMatrixColumn('X', gene, { onPartial: (part, cells) => heard.push({ part, cells }) });
  assert.ok(heard.length >= 1, 'answered segment by segment');
  for (const { part, cells } of heard) {
    // A sparse gene's partial answer is its form: a few entries, not 2,000 values.
    assert.ok(!ArrayBuffer.isView(part), 'a form, not a whole column');
    assert.equal(part.length, 2000);
    assert.equal(part.readRows, cells);
    assert.ok(part.indices.length < cells / 4);
    const dense = denseOfForm(part);
    for (let i = 0; i < 2000; i++) {
      if (i < cells) assert.equal(dense[i], values[order[i] * N_VARS + gene], `cell ${i}`);
      else assert.ok(Number.isNaN(dense[i]));
    }
  }
  for (let i = 0; i < 2000; i++) assert.equal(column[i], values[order[i] * N_VARS + gene]);
  const form = columnFormOf(column);
  assert.ok(form !== null, 'the column comes with its form');
  sameBits(denseOfForm(form), column, 'the form is the column');
  // A dense gene: partial answers stay columns, and no form is noted.
  const denseGene = await client.getMatrixColumn('X', 600, { onPartial: () => {} });
  assert.equal(columnFormOf(denseGene), null);
  // Another caller of the same gene gets its own copy, with the same form noted.
  const [first, second] = await Promise.all([client.getMatrixColumn('X', 7), client.getMatrixColumn('X', 7)]);
  assert.notStrictEqual(first, second);
  sameBits(denseOfForm(columnFormOf(second)), first, 'the copy\'s form');
});

/** A DataState of `n` cells with one gene field, its viewer recording the colours it is handed. */
async function geneScene(n) {
  const { createDataState } = await import('../assets/js/app/state/core/data-state.js');
  const { createDimensionManager } = await import('../assets/js/data/dimension-manager.js');
  const { createCellIdentity } = await import('../assets/js/data/cell-identity.js');
  const { OPEN_ORDER_PRIORITY } = await import('../assets/js/data/cell-priority.js');
  const random = createMulberry32(11);
  const positions = Float32Array.from({ length: n * 2 }, () => random() * 2 - 1);
  const manager = createDimensionManager({ embeddingsMetadata: { default_dimension: 2, defaults: { '2d': 'X_umap' },
    items: { X_umap: { label: 'X_umap', dimension: 2, path: 'obsm/0/0-1', source: { key: 'X_umap', columns: [0, 1] } } } } });
  manager.loadLayout = async () => { manager.loadedTransformCache.set('X_umap', { center: [0, 0, 0], scale: 1 }); return positions.slice(); };
  manager.publishCellCount(n);
  await manager.getPositions('X_umap');
  const pushed = [];
  const answers = { isDisposed: () => false, hasVectorFieldForLayout: () => false, hasSnapshots: () => false,
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }), updateColors: colors => pushed.push(colors.slice()) };
  const viewer = new Proxy(answers, { get: (target, p) => (Object.hasOwn(target, p) ? target[p] : () => {}) });
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [{ key: 'G', kind: 'continuous', path: 'var/0' }] });
  manager.setViewLayout('live', 'X_umap');
  state.initScene(manager.getResidentPositions('X_umap'), { fields: [] });
  state.setCellIdentity(createCellIdentity({ nObs: n, kept: null }));
  state.setCellPriority(OPEN_ORDER_PRIORITY);
  return { state, pushed };
}

test('a gene shown on the cells read so far is coloured from its form exactly as from its column', async () => {
  const n = 3000;
  const truth = new Float32Array(n);
  for (let i = 0; i < n; i += 13) truth[i] = 0.5 + (i % 11);
  truth.fill(Number.NaN, 1200);
  const { state, pushed } = await geneScene(n);
  assert.equal(state.showPartialVarField(0, truth), true);
  const fromColumn = pushed.at(-1);
  assert.equal(state.showPartialVarField(0, sparseFormOf(truth, 1200)), true);
  assert.deepEqual(pushed.at(-1), fromColumn, 'the same bytes from the form');
  // The cells not read are the bottom layer (not read), not the no-value
  // grey; a form of another length is refused.
  assert.deepEqual(Array.from(fromColumn.subarray(2000 * 4, 2000 * 4 + 4)), [NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, UNREAD_ALPHA_BYTE]);
  assert.throws(() => state.showPartialVarField(0, sparseFormOf(truth.subarray(0, 2000), 1000)), /sparse form/);
});

test('a gene grown or cut in place keeps its form, exactly the resized column\'s', () => {
  const random = createMulberry32(17);
  const column = n => Float32Array.from({ length: n }, () => (random() < 0.05 ? Math.fround(1 + random() * 4) : 0));
  const before = column(1000);
  const added = column(600);
  // Grown: every cell of both read.
  const grown = resizedCellArray(before, 1000, 1600, { added });
  sameBits(denseOfForm(resizedForm(sparseFormOf(before), 1000, 1600, sparseFormOf(added))), grown, 'grown');
  // Grown, the added cells read only in part (a gene sample's tail).
  const addedSample = added.slice();
  addedSample.fill(Number.NaN, 250);
  const grownSample = resizedCellArray(before, 1000, 1600, { added: addedSample });
  const form = resizedForm(sparseFormOf(before), 1000, 1600, sparseFormOf(addedSample));
  assert.equal(form.readRows, 1250);
  sameBits(denseOfForm(form), grownSample, 'grown into a sample');
  // An earlier sample grown past with nothing read: its tail runs on.
  const sample = before.slice();
  sample.fill(Number.NaN, 700);
  const unread = new Float32Array(600).fill(Number.NaN);
  sameBits(denseOfForm(resizedForm(sparseFormOf(sample), 1000, 1600, sparseFormOf(unread))), resizedCellArray(sample, 1000, 1600, { added: unread }), 'tail runs on');
  // Cells read after cells not read cannot be a form; a part with no form gives none.
  assert.equal(resizedForm(sparseFormOf(sample), 1000, 1600, sparseFormOf(added)), null);
  assert.equal(resizedForm(sparseFormOf(before), 1000, 1600, null), null);
  // Cut.
  sameBits(denseOfForm(resizedForm(sparseFormOf(sample), 1000, 400)), resizedCellArray(sample, 1000, 400), 'cut');
  sameBits(denseOfForm(resizedForm(sparseFormOf(sample), 1000, 900)), resizedCellArray(sample, 1000, 900), 'cut inside the tail');
});

test('a gene sample grown in place keeps its form', () => {
  const random = createMulberry32(23);
  const values = Float32Array.from({ length: 2000 }, () => (random() < 0.04 ? Math.fround(random() * 3 + 1) : 0));
  values.fill(Number.NaN, 500);
  const rows = Float32Array.from({ length: 700 }, () => (random() < 0.04 ? Math.fround(random() * 3 + 1) : 0));
  const grown = values.slice();
  grown.set(rows, 500);
  const form = filledForm(sparseFormOf(values), 500, sparseFormOf(rows));
  assert.equal(form.readRows, 1200);
  sameBits(denseOfForm(form), grown, 'filled');
  assert.equal(filledForm(sparseFormOf(values), 400, sparseFormOf(rows)), null, 'rows not where the cells read end');
});

test('an inactive gene keeps its form alone and is made again from it without a read', async () => {
  const n = 4000;
  const { state } = await geneScene(n);
  const genes = [0, 1].map(seed => {
    const random = createMulberry32(31 + seed);
    return Float32Array.from({ length: n }, () => (random() < 0.03 ? Math.fround(random() * 5 + 0.5) : 0));
  });
  state.initVarData({ fields: [{ key: 'A', kind: 'continuous', path: 'var/0' }, { key: 'B', kind: 'continuous', path: 'var/1' }] });
  let reads = 0;
  const loader = async descriptor => {
    reads++;
    const values = genes[Number(descriptor.path.split('/')[1])].slice();
    return { values: noteColumnForm(values, sparseFormOf(values)) };
  };
  state.setVarFieldLoader(loader);
  await state.ensureVarFieldLoaded(0, { silent: true });
  state.setActiveVarField(0);
  await state.ensureVarFieldLoaded(1, { silent: true });
  state.setActiveVarField(1);
  // Gene A is inactive: its column's bytes are gone, its form kept.
  const a = state.varData.fields[0];
  assert.equal(a.loaded, false);
  assert.equal(a.values, undefined);
  const entry = state._varFieldDataCache.get('A');
  assert.ok(entry.form && entry.values === undefined, 'the form alone');
  // Shown again: made from the form, bit for bit, no read.
  await state.ensureVarFieldLoaded(0, { silent: true });
  assert.equal(reads, 2, 'no third read');
  sameBits(state.varData.fields[0].values, genes[0], 'gene A made again');
  assert.ok(columnFormOf(state.varData.fields[0].values) !== null, 'with its form noted');
  state.setActiveVarField(0);
  // Gene B, inactive now, is kept as its form in turn.
  assert.ok(state._varFieldDataCache.get('B').form !== undefined && state.varData.fields[1].loaded === false);
});

test('a categorical grown in place proves only the codes of the cells added', async () => {
  const { carryCategoryCodesProof, requireCategoryCodesInInventory } = await import('../assets/js/app/state/managers/category-codes.js');
  const describe = index => `bad code at ${index}`;
  const before = Uint8Array.from({ length: 1000 }, (_, i) => i % 5);
  requireCategoryCodesInInventory(before, 5, describe);
  const grownCodes = resizedCellArray(before, 1000, 1600, { added: Uint8Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 255 : i % 5)) });
  carryCategoryCodesProof(before, grownCodes, 1000, 5);
  // Proven without a scan of the first cells: a code there no longer looked at.
  grownCodes[3] = 9;
  assert.doesNotThrow(() => requireCategoryCodesInInventory(grownCodes, 5, describe));
  // A code added outside the inventory is not carried; the full check finds it.
  const bad = resizedCellArray(before, 1000, 1100, { added: new Uint8Array(100).fill(7) });
  carryCategoryCodesProof(before, bad, 1000, 5);
  assert.throws(() => requireCategoryCodesInInventory(bad, 5, describe), /bad code at 1000/);
  // Another dtype, or a proof for more categories than now: nothing carried.
  const wide = Uint16Array.from(grownCodes);
  carryCategoryCodesProof(before, wide, 1000, 5);
  assert.throws(() => requireCategoryCodesInInventory(wide, 5, describe), /bad code at 3/);
});

test('unsigned 32-bit values sort in linear time to exactly what the comparison sort gives', async () => {
  const { sortUint32 } = await import('../assets/js/utils/radix-order.js');
  const random = createMulberry32(41);
  for (const n of [0, 1, 2, 1000, 70000]) {
    const values = Uint32Array.from({ length: n }, () => Math.floor(random() * 2 ** 32));
    assert.deepEqual(sortUint32(values.slice()), values.slice().sort());
  }
  // Keys sharing a digit (one pass), and every value equal.
  const low = Uint32Array.from({ length: 5000 }, () => Math.floor(random() * 65536));
  assert.deepEqual(sortUint32(low.slice()), low.slice().sort());
  assert.deepEqual(sortUint32(new Uint32Array(9).fill(7)), new Uint32Array(9).fill(7));
  // The priority layout's positions, from it, are a priority-ordered file's rows.
  const { priorityPositions } = await import('../assets/js/data/anndata/priority-layout.js');
  const { priorityOrder } = await import('../assets/js/data/subsample.js');
  const all = Uint32Array.from({ length: 30000 }, (_, i) => i);
  assert.deepEqual(priorityPositions(3, 30000), priorityOrder({ method: 'uniform', seed: 3 }, all));
});
