/**
 * Outlier quantiles under a subsample (decision F-K7):
 * - stored quantiles (`prepare(latent_key=...)`) describe the whole dataset:
 *   a subsample reads the file's, gathered for its open cells, under every
 *   method, never recomputed and never refused as "not fitting" (they rank
 *   each category over its cells in the file, which the open cells do not
 *   count);
 * - the stored check still refuses quantiles a subsample's open cells show
 *   cannot be the field's (a category scored for some open cells only, a
 *   value no rank of one category size gives, sizes the file cannot hold);
 * - computed quantiles use the open cells only: the bytes of the rule on the
 *   open cells' latent rows and codes, and tagged as an estimate
 *   (`outlierQuantilesEstimate` = `{open, of}`); every cell open, no tag;
 * - the outlier filter says so: "Estimated from the open k cells." once they
 *   are got, the same in the plan's detail before, nothing for stored ones;
 *   a subsample's open counts do not make a field with stored quantiles
 *   "too small".
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { setNextCellSubsetRequest } from '../assets/js/data/cell-subset-policy.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { mappingLatentOutlierPath } from '../assets/js/data/data-mapping-candidates.js';
import { computeLatentOutlierQuantiles, storedQuantilesDefect } from '../assets/js/data/latent-outliers.js';
import { outlierQuantilesEstimate } from '../assets/js/data/outlier-quantile-source.js';
import { categoricalStorageForDtype } from '../assets/js/data/categorical-storage-contract.js';
import { getReadActivityLog } from '../assets/js/data/read-activity-log.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';
import { describeOutlierStatus } from '../assets/js/app/ui/modules/outlier-filter-control.js';

const FIXTURES = new URL('./browser/fixtures/', import.meta.url);
const MIN_POINTS = 10;

function silence(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => `${name}-id`;
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
    console.warn = warn;
  });
  return warnings;
}

async function open(t, name, request) {
  const warnings = silence(t);
  const bytes = await readFile(new URL(name, FIXTURES));
  if (request !== null) setNextCellSubsetRequest(request);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(new File([bytes], name));
  const adapter = source.getAdapter();
  const obsm = adapter.getMappingCandidates().obsm.map(item => item.key);
  const fields = new Map(adapter.getObsFields().fields.filter(field => field.kind === 'category').map(field => [field.key, field.fieldIndex]));
  const route = (latent, field) => mappingLatentOutlierPath(obsm.indexOf(latent), fields.get(field));
  return { adapter, warnings, route };
}

async function codesOf(adapter, key) {
  const data = await adapter.getObsFieldData(key);
  const { TypedArrayClass } = categoricalStorageForDtype(data.dtype, key);
  return { codes: new TypedArrayClass(data.data), nCategories: data.categories.length };
}

const sameBits = (a, b, label) => assert.deepEqual(
  Buffer.from(a.buffer, a.byteOffset, a.byteLength),
  Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  label,
);

const REQUESTS = [
  { mode: 'subsample', method: 'uniform', k: 300, seed: 1 },
  { mode: 'subsample', method: 'uniform', k: 37, seed: 99 },
  { mode: 'subsample', method: 'blocks', k: 250, seed: 4, blockSize: 32 },
  { mode: 'subsample', method: 'stratified', k: 120, seed: 7, field: 'cell_type', allocation: 'balanced' },
  { mode: 'subsample', method: 'stratified', k: 200, seed: 2, field: 'batch', allocation: 'proportional' },
  { mode: 'subsample', method: 'spatial', k: 90, seed: 5, gridSize: 6 },
  { mode: 'subsample', method: 'uniform', k: 2, seed: 3 },
];

for (const name of ['outliers-stored.h5ad', 'outliers-stored.zarr.zip']) {
  test(`${name}: a subsample's stored quantiles are the file's, gathered, under every method`, async t => {
    const whole = await open(t, name, null);
    const fieldsStored = ['cell_type', 'batch', 'doublet'];
    const full = {};
    for (const field of fieldsStored) full[field] = await whole.adapter.getLatentOutlierQuantiles(whole.route('X_scVI', field));
    for (const field of fieldsStored) assert.equal(outlierQuantilesEstimate(full[field]), null, `${field}: every cell open, no estimate`);
    for (const request of REQUESTS) {
      const label = `${name} ${request.method} k=${request.k}`;
      const subset = await open(t, name, request);
      const order = subset.adapter._loader.cellSubset.openOrder;
      assert.equal(order.length, request.k, label);
      getReadActivityLog().clear();
      for (const field of fieldsStored) {
        const plan = await subset.adapter.describeLatentOutlierQuantiles(subset.route('X_scVI', field));
        assert.equal(plan.source, 'stored', `${label} ${field}: plan`);
        const got = await subset.adapter.getLatentOutlierQuantiles(subset.route('X_scVI', field));
        sameBits(got, Float32Array.from(order, p => full[field][p]), `${label} ${field}: the file's quantiles of the open cells`);
        assert.equal(outlierQuantilesEstimate(got), null, `${label} ${field}: whole-dataset quantiles are no estimate`);
      }
      assert.ok(getReadActivityLog().entries().filter(a => a.kind === 'outliers').every(a => a.label.startsWith('stored outlier quantiles')),
        `${label}: the latent space is not read`);
      assert.deepEqual(subset.warnings.filter(line => /do not fit/.test(line)), [], `${label}: nothing refused`);
    }
  });
}

test('computed quantiles of a subsample are the rule on its open cells, and say they are an estimate', async t => {
  const whole = await open(t, 'outliers-stored.h5ad', null);
  const width = whole.adapter.getMappingCandidates().obsm.find(item => item.key === 'X_pca').shape[1];
  const fullLatent = await whole.adapter._loader.readObsmColumns('X_pca', Array.from({ length: width }, (_, c) => c));
  for (const request of REQUESTS) {
    const label = `${request.method} k=${request.k}`;
    const subset = await open(t, 'outliers-stored.h5ad', request);
    const order = subset.adapter._loader.cellSubset.openOrder;
    for (const field of ['cell_type', 'batch', 'rare']) {
      const got = await subset.adapter.getLatentOutlierQuantiles(subset.route('X_pca', field));
      const { codes, nCategories } = await codesOf(subset.adapter, field);
      const latent = new Float32Array(order.length * width);
      order.forEach((p, i) => latent.set(fullLatent.subarray(p * width, (p + 1) * width), i * width));
      const want = computeLatentOutlierQuantiles({ latent, width, codes, nCategories, minPoints: MIN_POINTS });
      sameBits(got, want, `${label} ${field}: the rule on the open cells`);
      assert.deepEqual(outlierQuantilesEstimate(got), { open: request.k, of: 600 }, `${label} ${field}: an estimate`);
    }
  }
});

test('the stored check on a subsample accepts the gathered quantiles and refuses what the open cells show is not the field', () => {
  const random = createMulberry32(0x0f7);
  let refusedCases = 0;
  for (let c = 0; c < 60; c++) {
    const n = 20 + Math.floor(random() * 400);
    const nCategories = 1 + Math.floor(random() * 5);
    const width = 1 + Math.floor(random() * 4);
    const minPoints = 1 + Math.floor(random() * 12);
    const codes = Int32Array.from({ length: n }, () => (random() < 0.05 ? -1 : Math.floor(random() * random() * nCategories)));
    // Coarse values: many ties, as integer embeddings have.
    const latent = Float32Array.from({ length: n * width }, () => Math.round(random() * 6) / 2);
    const quantiles = computeLatentOutlierQuantiles({ latent, width, codes, nCategories, minPoints });
    assert.equal(storedQuantilesDefect(quantiles, codes, nCategories, minPoints), null, `case ${c}: whole`);
    for (let s = 0; s < 6; s++) {
      const k = 1 + Math.floor(random() * (n - 1));
      const kept = Array.from({ length: n }, (_, p) => p).sort(() => random() - 0.5).slice(0, k);
      const openCodes = Int32Array.from(kept, p => codes[p]);
      const openQuantiles = Float32Array.from(kept, p => quantiles[p]);
      assert.equal(storedQuantilesDefect(openQuantiles, openCodes, nCategories, minPoints, { nOriginal: n }), null,
        `case ${c}/${s}: the file's quantiles of ${k} open cells of ${n}`);
      // A scored open cell moved to a category scored otherwise, or given
      // another category's share: refused.
      const scored = [...openQuantiles.keys()].filter(i => !Number.isNaN(openQuantiles[i]) && openCodes[i] >= 0);
      const unscoredCodes = new Set([...openQuantiles.keys()].filter(i => Number.isNaN(openQuantiles[i]) && openCodes[i] >= 0).map(i => openCodes[i]));
      if (scored.length > 0 && unscoredCodes.size > 0) {
        const moved = Int32Array.from(openCodes);
        moved[scored[0]] = [...unscoredCodes][0];
        assert.notEqual(storedQuantilesDefect(openQuantiles, moved, nCategories, minPoints, { nOriginal: n }), null, `case ${c}/${s}: moved`);
        refusedCases++;
      }
      if (scored.length > 0) {
        const off = Float32Array.from(openQuantiles);
        // 1 / (n + 1) is no rank share of any category size the file holds.
        off[scored[0]] = Math.fround(1 / (n + 1));
        const forged = storedQuantilesDefect(off, openCodes, nCategories, minPoints, { nOriginal: n });
        if (forged === null) {
          // Accepted only if one size fits every open cell of the category.
          const code = openCodes[scored[0]];
          const same = scored.filter(i => openCodes[i] === code);
          assert.equal(same.length, 1, `case ${c}/${s}: a share of no size accepted`);
        }
      }
    }
  }
  assert.ok(refusedCases > 20);
  // Every open cell of one category NaN but one: refused.
  assert.match(storedQuantilesDefect(Float32Array.of(0.5, NaN), Int32Array.of(0, 0), 1, 1, { nOriginal: 10 }), /some of its cells only/);
  // Two open cells both ranked first of an 8-cell category (no other size
  // fits the file): refused. Tied at rank 2 of 8, they are not.
  assert.match(storedQuantilesDefect(Float32Array.of(0.125, 0.125), Int32Array.of(0, 0), 1, 1, { nOriginal: 8 }), /no share/);
  assert.equal(storedQuantilesDefect(Float32Array.of(0.25, 0.25), Int32Array.of(0, 0), 1, 1, { nOriginal: 8 }), null);
  // Categories that need more cells than the file has: refused.
  assert.match(storedQuantilesDefect(Float32Array.of(0.2, 0.2), Int32Array.of(0, 1), 2, 1, { nOriginal: 6 }), /more than the file/);
  assert.throws(() => storedQuantilesDefect(Float32Array.of(0.5), Int32Array.of(0), 1, 1, { nOriginal: 0 }), RangeError);
});

/** A DataState with one categorical field over `open` of `of` cells and an outlier route. */
function subsampleState({ open, of, stored, codes }) {
  const state = new DataState(null, null);
  state.viewer = new Proxy({ getViewLayout: () => ({ mode: 'grid' }) }, {
    get(target, property) { return Object.hasOwn(target, property) ? target[property] : () => {}; },
  });
  state.pointCount = open;
  state.dimensionManager = createInMemoryDimensionManager({ positions: new Float32Array(open * 2), dimension: 2 });
  state.activeDimensionLevel = 2;
  state.colorsArray = new Uint8Array(open * 4);
  state.categoryTransparency = new Uint8Array(open).fill(1);
  state.cellVisibilityMask = new Uint8Array(open).fill(1);
  state.cellIdentity = createCellIdentity({ nObs: of, kept: Uint32Array.from({ length: open }, (_, i) => i * 2) });
  state.dataMapping = { latent: 'X_scVI' };
  state._mappingCandidates = { kind: 'anndata', obsm: [{ key: 'X_scVI', usable: true, storage: 'dense', shape: [open, 10] }] };
  const descriptor = Object.freeze({
    key: 'leiden', kind: 'category', fieldIndex: 0, categories: ['a', 'b'], codesDtype: 'uint8', codesMissingValue: 255, palette: null,
    outlierQuantilesPath: 'outliers/0/0',
  });
  state._obsFieldDescriptors = Object.freeze([descriptor]);
  state.obsData = { fields: [{ ...descriptor, codes, centroidsByLayout: new Map(), loaded: true }] };
  state._fieldDataCache.set('leiden', { codes });
  state.fieldLoader = {
    outlierMinPoints: 4,
    storedOutlierLatentKey: stored ? 'X_scVI' : null,
    describeOutlierQuantiles: async () => (stored
      ? { source: 'stored', latentKey: 'X_scVI', bytes: 400 }
      : { source: 'read', latentKey: 'X_scVI', storedBytes: 4096, valueBytes: 9000, kept: true, storedLatentKey: null }),
  };
  state._resetViewContexts();
  state.setActiveField(0);
  return state;
}

test('the outlier filter says when its quantiles are estimated from the open cells', async () => {
  const codes = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
  const computed = subsampleState({ open: 8, of: 16, stored: false, codes });
  computed.getOutlierFilterStatus(0);
  await new Promise(resolve => setTimeout(resolve, 0));
  const available = computed.getOutlierFilterStatus(0);
  assert.equal(available.state, 'available');
  assert.deepEqual({ ...available.estimate }, { open: 8, of: 16 });
  assert.match(describeOutlierStatus(available).detail, /Computed on the 8 open cells of 16 cells, so they estimate the whole dataset’s/);

  // Got on the open cells: the line says it.
  const quantiles = Float32Array.from([0.25, 0.5, 0.75, 1, 0.25, 0.5, 0.75, 1]);
  computed.obsData.fields[0].outlierQuantiles = quantiles;
  const { OutlierQuantileSource } = await import('../assets/js/data/outlier-quantile-source.js');
  // Tag them as the source does for a computation on a subsample.
  const source = new OutlierQuantileSource({
    loader: { nObs: 8, cellSubset: { nObs: 16 }, latentOutlierQuantiles: async () => [quantiles] },
    stored: null,
    minPoints: 4,
  });
  const tagged = await source.quantiles({ latentKey: 'X_scVI', width: 10, fieldKey: 'leiden', codes, nCategories: 2 });
  computed.obsData.fields[0].outlierQuantiles = tagged;
  const ready = computed.getOutlierFilterStatus(0);
  assert.equal(ready.state, 'ready');
  assert.equal(describeOutlierStatus(ready).text, 'Estimated from the open 8 cells.');

  // Stored quantiles: whole-dataset, no line.
  const stored = subsampleState({ open: 8, of: 16, stored: true, codes });
  stored.obsData.fields[0].outlierQuantiles = Float32Array.from([0.125, 0.25, 0.375, 0.5, 0.125, 0.25, 0.375, 0.5]);
  const storedReady = stored.getOutlierFilterStatus(0);
  assert.equal(storedReady.state, 'ready');
  assert.equal(storedReady.estimate, null);
  assert.equal(describeOutlierStatus(storedReady), null);
});

test('a subsample whose open categories are small is not "too small" when the file stores quantiles', async () => {
  // Three open cells a category, under the four the rule needs.
  const codes = Uint8Array.from([0, 0, 0, 1, 1, 1]);
  const stored = subsampleState({ open: 6, of: 60, stored: true, codes });
  assert.equal(stored.getOutlierFilterStatus(0).state, 'available');
  const computed = subsampleState({ open: 6, of: 60, stored: false, codes });
  assert.equal(computed.getOutlierFilterStatus(0).state, 'too-small');
});
