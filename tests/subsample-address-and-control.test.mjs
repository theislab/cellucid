/**
 * The subsample's address and the Cells-to-open control:
 *
 * - the address names a subsample only when its specification reproduces it
 *   exactly: never cells fitted to this device (`autoFit`), nor a restored
 *   set its specification no longer gives (`reproduced: false`); the paths
 *   that open the same cells again (a page restored from the back/forward
 *   cache, a cancelled reading undone) carry both, so the address stays
 *   right after them (`url-state.js`, `subsample-plan.js` `kept` mode);
 * - the control keeps the open subsample's exact count until the share is
 *   edited: the percentage it shows is rounded for display
 *   (`subsample-control.js`);
 * - auto-fit counts every modality's expression index by the share of the
 *   cells it measures, a matrix presented twice once (`autoFitCount`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareUrlForDatasetSelection } from '../assets/js/app/url-state.js';
import { resolveCellSubset, autoFitCount } from '../assets/js/data/anndata/subsample-plan.js';
import { columnIndexResidentBytes } from '../assets/js/data/anndata/matrix-access.js';
import { annData, dataFrame, dense, mapping, strings, openStore } from './helpers/anndata-store.mjs';

function installBrowser(href) {
  const previous = globalThis.window;
  const state = { href };
  globalThis.window = {
    location: { get href() { return state.href; }, get search() { return new URL(state.href).search; } },
    history: { replaceState(_s, _t, next) { state.href = next; } },
  };
  return { state, restore() { globalThis.window = previous; } };
}

function linkSource(subset) {
  return {
    getType: () => 'link',
    getConnectionInfo: () => ({ datasetsCount: 1, locator: 'https://data.example.test/atlas.h5ad' }),
    getAnnDataSource: () => ({ getCellSubset: () => subset }),
  };
}

const SPEC = Object.freeze({ method: 'uniform', nObs: 1000, k: 100, seed: 7, specVersion: 1 });

test('the address names a subsample only when its specification reproduces it', () => {
  const browser = installBrowser('https://www.cellucid.com/?data=old');
  try {
    const addressOf = subset => {
      prepareUrlForDatasetSelection({ datasetId: 'atlas', source: linkSource(subset), sourceType: 'link' }).commit();
      const params = new URL(browser.state.href).searchParams;
      return { data: params.get('data'), cells: params.get('cells'), sample: params.get('sample'), seed: params.get('seed') };
    };
    const kept = Uint32Array.from({ length: 100 }, (_, i) => i * 10);
    // Chosen in the Session panel or by a link: its specification.
    assert.deepEqual(addressOf({ kept, spec: SPEC, autoFit: null, reproduced: null }),
      { data: 'https://data.example.test/atlas.h5ad', cells: '100', sample: 'uniform', seed: '7' });
    // Every cell, fitted to this device, or a set its specification no longer gives: none.
    for (const subset of [
      null,
      { kept: null, spec: null, autoFit: null, reproduced: null },
      { kept, spec: SPEC, autoFit: { k: 100, limit: 'cells' }, reproduced: null },
      { kept, spec: SPEC, autoFit: null, reproduced: false },
    ]) {
      assert.deepEqual(addressOf(subset), { data: 'https://data.example.test/atlas.h5ad', cells: null, sample: null, seed: null });
    }
  } finally {
    browser.restore();
  }
});

async function plainStore(nObs) {
  const tree = annData({
    obs: dataFrame({ _index: strings(Array.from({ length: nObs }, (_, i) => `c${i}`)) }),
    var: dataFrame({ _index: strings(['g0']) }),
    obsm: mapping({ X_umap: dense(new Float32Array(nObs * 2), [nObs, 2], { chunks: [16, 2] }) }),
  });
  return (await openStore(tree)).root;
}

test('opening the same cells again keeps whether they were fitted and whether their specification gives them', async () => {
  const root = await plainStore(1000);
  const first = await resolveCellSubset(root, { mode: 'subsample', method: 'uniform', k: 100, seed: 7 }, {});
  assert.equal(first.autoFit ?? null, null);
  // What the back/forward cache and an undone cancel pass back (`anndata-reader-client.js`
  // `_adoptSnapshot`, `anndata-file-source.js`): the cells, with how they came to be open.
  const fitted = { k: 100, limit: 'cells', budgetBytes: 1, neededBytes: 2 };
  const again = await resolveCellSubset(root, { mode: 'kept', spec: first.spec, kept: first.kept, autoFit: fitted, reproduced: null }, {});
  assert.deepEqual(again.autoFit, fitted);
  assert.equal(again.reproduced, true);
  const lost = await resolveCellSubset(root, { mode: 'kept', spec: first.spec, kept: first.kept, autoFit: null, reproduced: false }, {});
  assert.equal(lost.reproduced, false, 'a set once found not reproducible stays so');
  assert.equal(lost.autoFit, null);
});

/** A group node of the store contract (`formats/store.js`). */
function group(path, attrs, children) {
  return { kind: 'group', path, attrs, keys: () => Object.keys(children), has: key => key in children, get: key => children[key] };
}
function arrayNode(path, shape) {
  return { kind: 'array', path, shape, attrs: {}, chunks: shape, read: async () => { throw new Error('not read'); } };
}
function csr(path, nCells, nVars, nnz) {
  return group(path, { 'encoding-type': 'csr_matrix', 'encoding-version': '0.1.0', shape: [nCells, nVars] }, {
    data: arrayNode(`${path}/data`, [nnz]),
    indices: arrayNode(`${path}/indices`, [nnz]),
    indptr: arrayNode(`${path}/indptr`, [nCells + 1]),
  });
}

test('auto-fit counts each modality by the share of the cells it measures, and a matrix shown twice once', () => {
  const nObs = 1000;
  // RNA measures every cell (its X is also the root's: the default
  // modality); ADT 400 of them, overlapping partly with nothing else.
  const rnaX = csr('/mod/rna/X', 1000, 50, 20000);
  const adtX = csr('/mod/adt/X', 400, 10, 4000);
  const root = group('/', { 'encoding-type': 'MuData' }, {
    X: rnaX,
    mod: group('/mod', {}, {
      rna: group('/mod/rna', {}, { X: rnaX }),
      adt: group('/mod/adt', {}, { X: adtX }),
    }),
  });
  root.modalities = [{ name: 'rna', nCells: 1000 }, { name: 'adt', nCells: 400 }];
  const cost = (nnz, nCells, nVars) => columnIndexResidentBytes({ layout: 'sparse', nnz, nObs: nCells, nVars, valuesOnDemand: true });
  const rna = cost(20000, 1000, 50);
  const adt = cost(4000, 400, 10);
  const fixed = cost(0, 0, 50) + cost(0, 0, 10);
  const perCell = ((rna - cost(0, 0, 50)) + (adt - cost(0, 0, 10))) / nObs;
  const budget = Math.floor((rna + adt) / 4);
  const fit = autoFitCount(root, nObs, { valuesOnDemand: true, decodedChunkBytes: 1e9, allowanceBytes: 1e12, columnIndexBytes: budget });
  assert.equal(fit.limit, 'columnIndex');
  assert.equal(fit.neededBytes, rna + adt, 'the root X is the RNA modality\'s: counted once');
  assert.equal(fit.k, Math.floor((budget - fixed) / perCell));
  // At k kept cells (ADT holding its 40 % share of them) the indexes fit; one more would not.
  assert.ok(fixed + perCell * fit.k <= budget);
  assert.ok(fixed + perCell * (fit.k + 1) > budget);
  // Without the modality's share (every ADT entry per kept cell), k would be smaller.
  const unscaled = Math.floor((budget - fixed) / ((rna - cost(0, 0, 50)) / nObs + (adt - cost(0, 0, 10)) / 400));
  assert.ok(unscaled < fit.k);
});

/** Elements of the control: what `initSubsampleControl` reads and writes. */
function element(extra = {}) {
  const listeners = new Map();
  return {
    value: '', hidden: false, disabled: false, checked: false, textContent: '', placeholder: '',
    options: [{ textContent: '' }],
    replaceChildren() {},
    addEventListener(type, handler) { listeners.set(type, handler); },
    fire(type) { listeners.get(type)?.(); },
    ...extra,
  };
}

test('the control keeps the open subsample\'s exact count until the share is edited', async () => {
  const browser = installBrowser('https://www.cellucid.com/');
  const previousOption = globalThis.Option;
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { initSubsampleControl } = await import('../assets/js/app/ui/modules/subsample-control.js');
    const policy = await import('../assets/js/data/cell-subset-policy.js');
    policy.resetCellSubsetRequests?.();
    const k = 123_457;
    const subset = {
      nObs: 1_000_000,
      kept: Uint32Array.from({ length: k }, (_, i) => i * 8),
      spec: { method: 'uniform', nObs: 1_000_000, k, seed: 0, specVersion: 1 },
      prioritySeed: 0,
      autoFit: null,
      reproduced: null,
    };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'openAll', 'copyLink'].map(key => [key, element()]));
    const state = { pointCount: k, obsData: { fields: [] }, cellIdentity: { digest: '0123456789abcdef', n: k, kept: subset.kept, toOriginal: positions => positions }, getMappingCandidates: () => null };
    let reopened = 0;
    let asked = null;
    const control = initSubsampleControl({ dom, state, getCellSubset: () => subset, reopen: async cellSubset => { reopened++; asked = cellSubset; return { shown: false, inPlace: false }; } });
    // 12.35 % is shown (12.3457 rounded), which alone would be 123,500 cells.
    assert.equal(dom.percent.value, '12.35');
    assert.equal(dom.apply.disabled, true, 'nothing changed: nothing to apply');
    // A seed-only change: Apply opens the same count with the new seed.
    dom.seed.value = '5';
    dom.seed.fire('change');
    assert.equal(dom.apply.disabled, false);
    dom.apply.fire('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reopened, 1);
    // The reading is given its own request; the next opening's is untouched.
    assert.equal(asked.k, k, 'the exact count, not the rounded share');
    assert.equal(asked.seed, 5);
    assert.equal(policy.takeCellSubsetRequest(), policy.getTabCellSubsetRequest());
    // Editing the share drops the exact count: the share shown is what opens.
    dom.seed.value = '';
    dom.percent.value = '12.35';
    dom.percent.fire('input');
    assert.equal(dom.apply.disabled, false, '123,500 cells is another subsample');
    // The open cells changing in place meanwhile (a progressive opening's
    // step) leave what the person is setting as it is.
    control.showGrowth({ cells: 50_000, target: k });
    control.showOpenCells();
    assert.equal(dom.percent.value, '12.35');
    assert.equal(dom.apply.disabled, false);
    control.destroy();
  } finally {
    globalThis.Option = previousOption;
    browser.restore();
  }
});

test('auto-fit never fits a dataset to fewer than two cells, and the plan keeps any size it is asked for', async () => {
  const { FEWEST_OPEN_CELLS, FEWEST_OPEN_CELLS_REASON } = await import('../assets/js/data/subsample.js');
  // Derived from the viewer's rule (`embedding-payload.js`), not chosen.
  assert.equal(FEWEST_OPEN_CELLS, 2);
  assert.equal(FEWEST_OPEN_CELLS_REASON, 'one cell has no coordinate variation to draw');
  const root = await plainStore(1000);
  // The plan never turns a requested size into another: one cell asked
  // for is one cell (the control and the link do not ask for it).
  for (const request of [
    { mode: 'subsample', method: 'uniform', k: 1, seed: 0, strict: true },
    { mode: 'subsample', method: 'uniform', percent: '0.1', seed: 0 },
  ]) {
    assert.equal((await resolveCellSubset(root, request, {})).kept.length, 1);
  }
  const fit = autoFitCount(root, 1000, { valuesOnDemand: true, decodedChunkBytes: 1e9, allowanceBytes: 1, columnIndexBytes: 1e12 });
  assert.equal(fit.k, 2);
  assert.equal(autoFitCount(root, 2, { valuesOnDemand: true, decodedChunkBytes: 1e9, allowanceBytes: 1, columnIndexBytes: 1e12 }), null);
});

test('the control does not offer a share of fewer than two cells, and says why', async () => {
  const browser = installBrowser('https://www.cellucid.com/');
  const previousOption = globalThis.Option;
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { initSubsampleControl, describeShare } = await import('../assets/js/app/ui/modules/subsample-control.js');
    assert.equal(describeShare(0.1, 1000), '1 of 1,000 cells: one cell has no coordinate variation to draw, so at least 2 cells open.');
    assert.equal(describeShare(0, 1000), '0 of 1,000 cells: one cell has no coordinate variation to draw, so at least 2 cells open.');
    assert.equal(describeShare(0.2, 1000), '2 of 1,000 cells');
    const subset = { nObs: 1000, kept: null, spec: null, prioritySeed: 0, autoFit: null, reproduced: null };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'openAll', 'copyLink'].map(key => [key, element()]));
    const state = { pointCount: 1000, obsData: { fields: [] }, cellIdentity: { digest: '0123456789abcdef', n: 1000, kept: null }, getMappingCandidates: () => null };
    let reopened = 0;
    const control = initSubsampleControl({ dom, state, getCellSubset: () => subset, reopen: async () => { reopened++; return { shown: false, inPlace: false }; } });
    for (const [percent, disabled] of [['0.1', true], ['0.04', true], ['0', true], ['0.2', false]]) {
      dom.percent.value = percent;
      dom.percent.fire('input');
      assert.equal(dom.apply.disabled, disabled, `${percent} %`);
      assert.equal(dom.count.textContent, describeShare(Number(percent), 1000));
    }
    assert.equal(reopened, 0);
    control.destroy();
  } finally {
    globalThis.Option = previousOption;
    browser.restore();
  }
});
