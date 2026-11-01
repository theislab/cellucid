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
    getAddressLocator: () => 'https://data.example.test/atlas.h5ad',
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
  // Values stored in chunks read whole are bought with the first gene and held beside the positions (`buysValues`).
  const cost = (nnz, nCells, nVars) => columnIndexResidentBytes({ layout: 'sparse', nnz, nObs: nCells, nVars, valuesOnDemand: true, valuesBought: true });
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
    dataset: {},
    children: [],
    ownerDocument: { createElement: tag => element({ tag }) },
    replaceChildren(...nodes) { this.children = nodes; },
    appendChild(node) { this.children.push(node); },
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
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
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

test('the control is the person\'s again once the new cells are open, while what was shown comes back on them', async () => {
  // A view coloured by a gene reads that gene again for the new cells (on a
  // 2.3M-cell atlas, tens of seconds: the Apply button stayed disabled with
  // "All 2,282,447 cells" chosen until it was in). The cells being open,
  // another share can be applied at once; the earlier restoring then says
  // nothing.
  const browser = installBrowser('https://www.cellucid.com/');
  const previousOption = globalThis.Option;
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { initSubsampleControl } = await import('../assets/js/app/ui/modules/subsample-control.js');
    const policy = await import('../assets/js/data/cell-subset-policy.js');
    policy.resetCellSubsetRequests?.();
    const n = 1_000_000;
    let subset = { nObs: n, kept: null, spec: null, prioritySeed: 0, autoFit: null, reproduced: null };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
    const identity = { digest: '0123456789abcdef', n, kept: null, toOriginal: positions => positions, fromOriginal: positions => ({ positions }) };
    const state = {
      pointCount: n, obsData: { fields: [] }, varData: { fields: [] }, cellIdentity: identity, getMappingCandidates: () => null,
      getHighlightPages: () => [], getActivePageId: () => null, ensureHighlightPage: () => {}, cellVisibilityMask: null,
    };
    const restores = [];
    const viewCarry = {
      capture: () => ({}),
      restore: () => new Promise(resolve => restores.push(resolve)),
    };
    const notes = [];
    const asked = [];
    const control = initSubsampleControl({
      dom, state, notify: text => notes.push(text), viewCarry, getCellSubset: () => subset,
      reopen: async cellSubset => {
        asked.push(cellSubset);
        const k = cellSubset.k ?? n;
        subset = cellSubset.mode === 'all' ? { ...subset, kept: null, spec: null }
          : { ...subset, kept: Uint32Array.from({ length: k }, (_, i) => i), spec: { method: 'uniform', nObs: n, k, seed: 0, specVersion: 1 } };
        state.pointCount = k;
        return { shown: true, inPlace: false };
      },
    });
    dom.percent.value = '10';
    dom.percent.fire('input');
    dom.method.value = 'uniform';
    dom.method.fire('change');
    assert.equal(dom.apply.disabled, false);
    dom.apply.fire('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(asked.length, 1);
    assert.equal(restores.length, 1, 'the view is being restored on the new cells');
    // Back to every cell while the view's gene is still being read again.
    control.showOpenCells();
    dom.percent.value = '100';
    dom.percent.fire('input');
    assert.equal(dom.apply.disabled, false, 'Apply is free once the cells are open');
    dom.apply.fire('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(asked[1], { mode: 'all' });
    // The first restoring ends after the second reading: it says nothing.
    restores[0]([]);
    restores[1](['a reason']);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(notes, ['Not kept after reading the cells again — a reason']);
    control.destroy();
  } finally {
    globalThis.Option = previousOption;
    browser.restore();
  }
});

test('auto-fit never fits a dataset to fewer than two cells, and the plan refuses, never raises, a size under it', async () => {
  const { FEWEST_OPEN_CELLS, FEWEST_OPEN_CELLS_REASON } = await import('../assets/js/data/subsample.js');
  // Derived from the viewer's rule (`embedding-payload.js`), not chosen.
  assert.equal(FEWEST_OPEN_CELLS, 2);
  assert.equal(FEWEST_OPEN_CELLS_REASON, 'one cell has no coordinate variation to draw');
  const root = await plainStore(1000);
  // The plan never turns a requested size into another: a count, or a
  // share whose exact count rounds, under two cells is refused with the
  // control's reason; two cells open.
  for (const [request, asked] of [
    [{ mode: 'subsample', method: 'uniform', k: 1, seed: 0, strict: true }, '1 cell'],
    [{ mode: 'subsample', method: 'uniform', percent: '0.1', seed: 0 }, '0.1% of 1,000 cells (1 cell)'],
    [{ mode: 'subsample', method: 'uniform', percent: '0.01', seed: 0 }, '0.01% of 1,000 cells (1 cell)'],
  ]) {
    await assert.rejects(resolveCellSubset(root, request, {}),
      new RegExp(`^RangeError: A subsample of ${asked.replace(/[.()]/g, '\\$&')} cannot open: one cell has no coordinate variation to draw, so at least 2 cells open\\.$`));
  }
  assert.equal((await resolveCellSubset(root, { mode: 'subsample', method: 'uniform', percent: '0.2', seed: 0 }, {})).kept.length, 2);
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
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
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

test('the control says one short line, and every fact behind it is a row of its Details table', async () => {
  const browser = installBrowser('https://www.cellucid.com/');
  const previousOption = globalThis.Option;
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { initSubsampleControl, openCellsStatus, openCellsFacts, representationFact, geneCostFacts } = await import('../assets/js/app/ui/modules/subsample-control.js');
    const nObs = 2_282_447;
    const k = 227_535;
    const fitted = {
      nObs,
      kept: new Uint32Array(k),
      spec: { method: 'blocks', nObs, k, seed: 0, blockSize: 19, specVersion: 1 },
      prioritySeed: null,
      prefix: null,
      autoFit: { k, limit: 'columnIndex', budgetBytes: 1.5 * 2 ** 30, neededBytes: 15 * 2 ** 30 },
      reproduced: null,
      note: null,
      matrixChunkShare: null,
    };
    // One line: how the cells were chosen; never the reasons.
    assert.deepEqual(openCellsStatus(fitted), { text: 'Fitted to this device: blocks of 19, seed 0.', tone: 'muted', growing: false });
    assert.deepEqual(openCellsStatus({ ...fitted, autoFit: null, spec: { ...fitted.spec, method: 'uniform', seed: 7 } }), { text: 'Uniform, seed 7.', tone: 'muted', growing: false });
    assert.deepEqual(openCellsStatus(fitted, { cells: 9291, target: 22_824 }), { text: 'Reading 9,291 of 22,824 cells…', tone: 'muted', growing: true });
    assert.equal(openCellsStatus({ ...fitted, reproduced: false }).tone, 'warning', 'what needs attention is said instead');
    assert.deepEqual(openCellsStatus({ nObs, kept: null, spec: null, autoFit: null, note: null }), { text: '', tone: 'muted', growing: false });

    // Every sentence the notice said survives as a row (its value, or its title).
    const represented = representationFact({ field: 'suspension_type', largestDeviation: 0.0005, category: 'cell' });
    const rows = openCellsFacts(fitted, { digest: '7afd1496cb085c35', representation: represented });
    const byLabel = Object.fromEntries(rows.map(row => [row.label, row]));
    assert.equal(byLabel.Open.value, '227,535 of 2,282,447 cells');
    assert.equal(byLabel['Chosen by'].value, 'blocks of 19');
    assert.equal(byLabel['Chosen by'].title, 'Cells next to each other in the file are kept together.');
    assert.equal(byLabel.Seed.value, '0');
    assert.equal(byLabel['Fitted to'].value, 'this device: needs 15 GB, has 1.5 GB');
    assert.equal(byLabel['Fitted to'].title, 'Reading its genes would hold 15 GB in memory, and this device has 1.5 GB for it.');
    assert.equal(byLabel['Cell set'].value, '7afd1496cb085c35');
    assert.equal(byLabel.Categories.value, 'suspension_type: within 0.05 percentage points (cell)');
    assert.equal(byLabel.Categories.title, 'Largest difference from every cell in suspension_type: 0.05 percentage points (cell).');
    assert.equal(representationFact({ field: 'cell_type', largestDeviation: 0, category: 'B' }).value, 'cell_type: every category keeps its share');
    const priority = openCellsFacts({ ...fitted, autoFit: null, prioritySeed: 4, matrixChunkShare: 0.62 }, {});
    assert.match(priority.find(row => row.label === 'Stored order').title, /^This file is stored in priority order: uniform with its seed \(4\) reads only the share/);
    assert.equal(priority.find(row => row.label === 'Matrix read').value, '62 % for 10 % of the cells');
    assert.equal(openCellsFacts({ ...fitted, reproduced: false }, {}).find(row => row.label === 'Cells').title, "These are the session's own cells; its settings no longer give exactly these.");
    assert.equal(openCellsFacts({ ...fitted, kept: null, note: 'This dataset has no field x, so its subsample is its default method instead of stratified' }, {})[0].label, 'Note');
    // Genes read for a sample of the open cells, sized by a gene's read
    // time: the cells, why, and the layout's rows, one source for that wording.
    const genes = { cells: 40_000, of: k, fit: { cells: 40_000, limit: 'geneTime', budgetMs: 20_000, neededMs: 49_000, neededCells: k, layout: 'csr', matrix: 'raw.X', kept: null } };
    const timed = openCellsFacts({ ...fitted, genes }, {
      geneCost: [{ label: 'A gene reads', value: 'only its own values', title: null }],
    });
    assert.equal(timed.find(row => row.label === 'Genes read').value, '40,000 of 227,535 open cells');
    assert.equal(timed.find(row => row.label === 'Sized to').value, 'a gene in about 20 s here');
    assert.match(timed.find(row => row.label === 'Sized to').title, /for the first gene of raw\.X, the matrix genes are read from/, 'names the matrix it priced');
    assert.ok(timed.some(row => row.label === 'Stored'), 'the layout rows follow');
    assert.ok(!timed.some(row => row.label === 'A gene reads'), 'said once');
    // Every cell open: no line (Genes read for, below, says the gene sample), and Details its facts.
    const whole = { nObs, kept: null, spec: null, autoFit: null, note: null, genes: { cells: 40_000, of: nObs, fit: { ...genes.fit, neededCells: nObs } } };
    assert.deepEqual(openCellsStatus(whole), { text: '', tone: 'muted', growing: false });
    assert.deepEqual(openCellsFacts(whole, {}).map(row => row.label).slice(0, 2), ['Genes read', 'Sized to']);
    // Sized by the gene index's memory.
    const memory = openCellsFacts({ ...whole, genes: { cells: 9000, of: nObs, fit: { cells: 9000, limit: 'columnIndex', budgetBytes: 2 ** 30, neededBytes: 9 * 2 ** 30, neededCells: nObs, layout: 'csr', matrix: 'X' } } }, {});
    assert.equal(memory.find(row => row.label === 'Sized to').value, 'memory: needs 9.0 GB, has 1.0 GB');
    assert.deepEqual(geneCostFacts({ cellMajor: false, built: true }), [{ label: 'A gene reads', value: 'only its own values', title: null }]);
    assert.equal(geneCostFacts(null), null);
    assert.deepEqual(openCellsFacts({ nObs, kept: null, spec: null, autoFit: null, note: null }, {}), [], 'every cell open: no Details');

    // The control: the line, the table, and what a gene costs asked once Details opens.
    const header = element({ attributes: { 'aria-expanded': 'false' } });
    header.getAttribute = name => header.attributes[name];
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
    dom.details.querySelector = () => header;
    const state = { pointCount: k, obsData: { fields: [] }, cellIdentity: { digest: '7afd1496cb085c35', n: k, kept: fitted.kept }, getMappingCandidates: () => null };
    let asked = 0;
    const control = initSubsampleControl({
      dom, state, getCellSubset: () => fitted, reopen: async () => ({ shown: false, inPlace: false }),
      geneCost: async () => { asked++; return [{ label: 'A gene reads', value: 'only its own values', title: null }]; },
    });
    assert.equal(dom.notice.textContent, 'Fitted to this device: blocks of 19, seed 0.');
    assert.equal(dom.method.options[0].textContent, 'File default (blocks)');
    assert.equal(dom.details.hidden, false);
    const terms = () => dom.detailsList.children.filter(node => node.tag === 'dt').map(node => node.textContent);
    assert.deepEqual(terms(), ['Open', 'Chosen by', 'Seed', 'Fitted to', 'Cell set']);
    assert.equal(asked, 0, 'nothing is worked out while Details is closed');
    header.attributes['aria-expanded'] = 'true';
    header.fire('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(asked, 1);
    assert.ok(terms().includes('A gene reads'));
    header.fire('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(asked, 1, 'asked once per opening');
    control.destroy();
  } finally {
    globalThis.Option = previousOption;
    browser.restore();
  }
});

test('a share is read as typed in any locale: a decimal point or comma, never a thousands separator', async () => {
  const { parseDecimalText } = await import('../assets/js/utils/format-units.js');
  assert.equal(parseDecimalText('12.5'), 12.5);
  assert.equal(parseDecimalText('12,5'), 12.5, 'a German or Turkish decimal comma');
  assert.equal(parseDecimalText('9,969'), 9.969, 'never nine thousand');
  assert.equal(parseDecimalText(' 40 % '), 40);
  assert.equal(parseDecimalText('12,'), 12, 'half typed');
  assert.equal(parseDecimalText(',5'), 0.5);
  assert.equal(parseDecimalText('2e-7'), 2e-7, 'as the box writes a tiny share');
  for (const text of ['', ' ', '1,000.5', '1.000,5', '1.2.3', '12,5,1', 'ten', '%', '.']) {
    assert.ok(Number.isNaN(parseDecimalText(text)), text);
  }
});

test('a subsample a few cells short of every cell is never "All", and Apply opens exactly it (NS-6)', async () => {
  const browser = installBrowser('https://www.cellucid.com/');
  const previousOption = globalThis.Option;
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { initSubsampleControl, describeShare, shareShown } = await import('../assets/js/app/ui/modules/subsample-control.js');
    assert.equal(shareShown(99_996, 100_000), 99.996);
    assert.equal(shareShown(999_999, 1_000_000), 99.9999);
    assert.equal(shareShown(4_294_967_294, 4_294_967_295) < 100, true);
    assert.equal(shareShown(100_000, 100_000), 100);
    assert.equal(shareShown(12_345, 100_000), 12.35);
    assert.equal(describeShare(100, 1000, 999), '999 of 1,000 cells');
    assert.equal(describeShare(100, 1000), 'All 1,000 cells');
    // A typed share whose count rounds to every cell is every cell.
    assert.equal(describeShare(99.99, 1000), 'All 1,000 cells');

    const nObs = 100_000;
    const k = nObs - 1;
    const subset = {
      nObs,
      kept: Uint32Array.from({ length: k }, (_, i) => i + 1),
      spec: { method: 'uniform', nObs, k, seed: 0, specVersion: 1 },
      prioritySeed: 0,
      autoFit: { k, limit: 'memory', budgetBytes: 1, neededBytes: 2 },
      reproduced: null,
    };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
    const state = { pointCount: k, obsData: { fields: [] }, cellIdentity: { digest: '0123456789abcdef', n: k, kept: subset.kept, toOriginal: positions => positions }, getMappingCandidates: () => null };
    let asked = null;
    const control = initSubsampleControl({ dom, state, getCellSubset: () => subset, reopen: async cellSubset => { asked = cellSubset; return { shown: false, inPlace: false }; } });
    assert.equal(dom.percent.value, '99.999');
    assert.equal(dom.count.textContent, '99,999 of 100,000 cells');
    assert.equal(dom.settings.hidden, false, 'a subsample keeps its settings');
    assert.equal(dom.apply.disabled, true, 'the open subsample: nothing to apply');
    // A seed change applies to exactly the 99,999 cells, never every cell.
    dom.seed.value = '3';
    dom.seed.fire('change');
    assert.equal(dom.apply.disabled, false);
    dom.apply.fire('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(asked.mode, 'subsample');
    assert.equal(asked.k, k);
    control.destroy();
  } finally {
    globalThis.Option = previousOption;
    browser.restore();
  }
});
