/**
 * `cells.open` whose reading fails (R9M-9): the dataset controls say the
 * failure where it happened ("could not be read again with these cells …
 * The cells open before are still open.") and answer `shown: false`; the
 * action resolved as if the cells were open, so the history recorded "Opened
 * 50% of the cells" and an agent or a notebook was told it was done. It now
 * fails with an error already said (no second notice), and no step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { representationName } from '../assets/js/data/representation-names.js';

/** Elements of the Cells-to-open control (`initSubsampleControl`). */
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

test('cells.open whose reading fails ends as a failure already said, with no step (R9M-9)', async () => {
  const previous = { window: globalThis.window, Option: globalThis.Option };
  globalThis.window = { location: { href: 'https://www.cellucid.com/', search: '' }, history: { replaceState() {} } };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { getActions, getStateDomains } = await import('../assets/js/app/actions/index.js');
    const { initSubsampleControl } = await import('../assets/js/app/ui/modules/subsample-control.js');
    const { createHistory } = await import('../assets/js/app/history/history.js');
    const { isReported } = await import('../assets/js/utils/errors.js');
    const subset = { nObs: 100, kept: null, spec: null, prioritySeed: 0, autoFit: null, reproduced: null };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
    const state = { pointCount: 100, obsData: { fields: [] }, cellIdentity: { digest: '0123456789abcdef', n: 100, kept: null, toOriginal: positions => positions }, getMappingCandidates: () => null };
    // The dataset controls' reading again failed: said there ("could not be
    // read again with these cells"), the cells open before still open.
    const failure = '"Demo" could not be read again with these cells: A spatial subsample needs the embedding obsm[\'X_sparse\'], which this dataset does not have as a dense array. The cells open before are still open.';
    const reopen = async () => ({ shown: false, inPlace: false, failure });
    const control = initSubsampleControl({ dom, state, getCellSubset: () => subset, reopen });
    const domains = getStateDomains();
    for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
    const actions = getActions();
    let t = 0;
    const history = createHistory({
      dispatcher: actions, domains, dataset: { id: 'd2', name: 'Demo', cellOrder: null },
      newTrackerId: () => 't-00000000-0000-4000-8000-000000000002', now: () => ++t * 1000,
    });
    await history.startTracker();
    const steps = history.active.steps.size;
    await assert.rejects(
      actions.dispatch('cells.open', { mode: 'subsample', fraction: 0.5, method: 'uniform', seed: null }, { origin: 'agent', agent: 'Claude', turn: 'turn-fail' }),
      error => {
        // The agent gets the reason the person read, not a generic sentence.
        assert.equal(error.message, failure);
        assert.equal(isReported(error), true, 'said once, where the reading failed');
        return true;
      }
    );
    assert.equal(history.active.steps.size, steps, 'no step says the cells were opened');
    control.destroy();
  } finally {
    globalThis.window = previous.window;
    globalThis.Option = previous.Option;
  }
});

test('the spatial Embedding menu and cells.open offer only what the data mapping shows in 2D or 3D, its 2D default first (R9M-13)', async () => {
  const previous = { window: globalThis.window, Option: globalThis.Option };
  globalThis.window = { location: { href: 'https://www.cellucid.com/', search: '' }, history: { replaceState() {} } };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { getActions } = await import('../assets/js/app/actions/index.js');
    const { initSubsampleControl } = await import('../assets/js/app/ui/modules/subsample-control.js');
    const subset = { nObs: 100, kept: null, spec: null, prioritySeed: 0, autoFit: null, reproduced: null };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
    // The mapping shows a 3D PHATE, the 2D UMAP (default), t-SNE and a 1D pseudotime;
    // obsm also holds velocity_umap (a vector field), X_pca and a sparse array, which it does not show.
    const representations = [
      { dimension: 3, ref: { key: 'X_phate', columns: [0, 1, 2] }, isDefault: true },
      { dimension: 2, ref: { key: 'X_umap', columns: [0, 1] }, isDefault: true },
      { dimension: 2, ref: { key: 'X_tsne', columns: [0, 1] }, isDefault: false },
      { dimension: 1, ref: { key: 'pseudotime', columns: [0] }, isDefault: true },
    ];
    const state = {
      pointCount: 100, obsData: { fields: [] },
      cellIdentity: { digest: '0123456789abcdef', n: 100, kept: null, toOriginal: positions => positions },
      getMappingCandidates: () => ({ obsm: ['X_phate', 'X_umap', 'X_tsne', 'pseudotime', 'velocity_umap', 'X_pca', 'X_sparse'].map(key => ({ key, usable: key !== 'X_sparse' })) }),
      getEnabledRepresentations: () => representations,
      representationNameOf: layout => representationName(layout, { arrays: [['X_phate', 3], ['X_umap', 2], ['X_tsne', 2], ['pseudotime', 1], ['velocity_umap', 2], ['X_pca', 50], ['X_sparse', null]].map(([key, width]) => ({ key, width })) }),
      on() {}, off() {},
    };
    const asked = [];
    const reopen = async request => { asked.push(request); return { shown: false, inPlace: false, failure: 'stopped here' }; };
    const control = initSubsampleControl({ dom, state, getCellSubset: () => subset, reopen });
    assert.deepEqual(dom.embedding.children.map(option => [option.value, option.text]), [['X_umap', 'UMAP'], ['X_tsne', 't-SNE'], ['X_phate', 'PHATE']]);
    const actions = getActions();
    for (const embedding of ['velocity_umap', 'X_pca', 'X_sparse', 'pseudotime']) {
      await assert.rejects(
        actions.dispatch('cells.open', { mode: 'subsample', fraction: 0.5, method: 'spatial', seed: null, embedding }),
        error => error.code === 'refused' && /shows in 2D or 3D \('X_umap', 'X_tsne', 'X_phate'\)/.test(error.message),
      );
    }
    assert.deepEqual(asked, [], 'nothing is read for a refused embedding');
    // None named: the mapping's 2D default.
    await assert.rejects(actions.dispatch('cells.open', { mode: 'subsample', fraction: 0.5, method: 'spatial', seed: null }), /stopped here/);
    assert.equal(asked.at(-1).embedding, 'X_umap');
    control.destroy();
  } finally {
    globalThis.window = previous.window;
    globalThis.Option = previous.Option;
  }
});
