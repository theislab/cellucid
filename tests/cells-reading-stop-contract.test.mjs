/**
 * Reading the open dataset again with other cells (`cells.open`, a history
 * move that puts other cells back) stopped while the cells are read ends
 * promptly as a cancellation, and the reading is cancelled with it.
 *
 * The dispatcher waits for a stopped action to end before it puts back what
 * it changed, so an action that waits on a reading not tied to its signal
 * holds every later history move for as long as the dataset is read (on an
 * atlas, a minute). The reading has a Cancel of its own (the Dataset box);
 * the action and the `cells` domain's restore reach it through the signal
 * that `reopenOpenDataset`, `reopenKeeping` and the domain's
 * `reopen`/`readGenes` pass down. The reading is cancelled as Cancel cancels
 * it: the cells open before stay open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeHarness, makeIdentity } from './helpers/dataset-controls-harness.mjs';
import { createCellsDomain } from '../assets/js/app/state/domains/cells.js';
import { abortReason, cancelled, onAbort } from '../assets/js/utils/abort.js';
import { settlesSoon } from './helpers/settles.mjs';

const STOP = () => cancelled('user', 'The person stopped Claude.');

/** A reading that ends only when its own signal (the dataset change's) aborts. */
function readingUntilCancelled(log) {
  return ({ signal }) => new Promise((_resolve, reject) => {
    log.push('reading');
    onAbort(signal, () => { log.push('cancelled'); reject(abortReason(signal)); });
  });
}

test('the open dataset read again with a caller\'s signal: stopped, the reading is cancelled and the cells stay', async t => {
  const log = [];
  const identity = makeIdentity('cells', 'Lung atlas', 300);
  const harness = makeHarness([{ sourceType: 'remote', datasets: [identity], error: null }]);
  t.after(harness.browser.restore);
  harness.manager.getSource = type => ({ getType: () => type, getAnnDataSource: () => ({ reopenCells: async () => ({}) }) });
  const { initDatasetControls } = await import('../assets/js/app/ui/modules/dataset-controls.js');
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    resizeOpenCells: readingUntilCancelled(log),
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks,
  });
  t.after(() => controls.destroy());
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.equal(await controls.loadStartupDataset({ datasetId: 'cells', loadMethod: 'dataset-dropdown', sourceType: 'remote' }), 'ready');
  const before = harness.statuses.length;
  const stop = new AbortController();
  const reading = controls.reopenOpenDataset({ mode: 'all' }, { signal: stop.signal });
  while (!log.includes('reading')) await new Promise(resolve => setImmediate(resolve));
  stop.abort(STOP());
  const outcome = await settlesSoon(reading);
  assert.ok(outcome !== null, 'the reading ended with its caller');
  assert.deepEqual(outcome.value, { shown: false, inPlace: false }, 'the cells open before are still open');
  assert.deepEqual(log, ['reading', 'cancelled']);
  assert.deepEqual(harness.statuses.slice(before), [], 'a cancellation is said by nobody');
  // A caller already stopped never reads.
  const stopped = new AbortController();
  stopped.abort(STOP());
  assert.deepEqual(await controls.reopenOpenDataset({ mode: 'all' }, { signal: stopped.signal }), { shown: false, inPlace: false });
  assert.deepEqual(log, ['reading', 'cancelled', 'reading', 'cancelled']);
});

/** The `cells` domain over open cells whose reading again ends only when the signal it is given aborts. */
function cellsDomain() {
  const calls = [];
  let open = null;
  const openCells = {
    subset: () => (open === null ? null : { kept: new Uint32Array(open), nObs: 100, spec: { method: 'uniform', nObs: 100, k: open, seed: 0, specVersion: 1 } }),
    geneSample: () => ({ cells: 10, of: 100 }),
    genesAsked: () => null,
    setGenesAsked: cells => calls.push(['genes asked', cells]),
    reopen: (request, { signal = null } = {}) => new Promise(resolve => {
      calls.push(['reopen', request.mode]);
      // As `reopenKeeping` answers a cancelled reading: nothing shown, nothing to restore.
      onAbort(signal, () => resolve({ restoring: Promise.resolve() }));
    }),
    readGenes: (cells, { signal = null } = {}) => new Promise(resolve => {
      calls.push(['read genes', cells]);
      onAbort(signal, () => resolve({ ended: 'stopped' }));
    }),
  };
  return { domain: createCellsDomain({ openCells }), calls, setOpen: k => { open = k; } };
}

test('the cells domain\'s restore stopped while the cells are read again ends at once with why', async () => {
  const { domain, calls, setOpen } = cellsDomain();
  setOpen(10);
  const stop = new AbortController();
  const restoring = domain.restore({ open: null, genes: null }, { signal: stop.signal });
  while (calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(restoring);
  assert.ok(outcome !== null, 'the restore ended with its move');
  assert.equal(outcome.error, reason, 'said as the move\'s Stop, never as cells that could not be read');
  assert.deepEqual(calls, [['reopen', 'all']]);
});

test('the cells domain\'s restore stopped while genes are read for more cells ends at once with why', async () => {
  const { domain, calls } = cellsDomain();
  const stop = new AbortController();
  const restoring = domain.restore({ open: null, genes: 50 }, { signal: stop.signal });
  while (calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  const reason = STOP();
  stop.abort(reason);
  const outcome = await settlesSoon(restoring);
  assert.ok(outcome !== null);
  assert.equal(outcome.error, reason);
  assert.deepEqual(calls, [['genes asked', 50], ['read genes', 50]]);
});

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

test('cells.open stopped while the cells are read ends at once, the reading cancelled; the history is free again', async () => {
  const previous = { window: globalThis.window, Option: globalThis.Option };
  globalThis.window = { location: { href: 'https://www.cellucid.com/', search: '' }, history: { replaceState() {} } };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  try {
    const { getActions, getStateDomains } = await import('../assets/js/app/actions/index.js');
    const { initSubsampleControl } = await import('../assets/js/app/ui/modules/subsample-control.js');
    const { createHistory } = await import('../assets/js/app/history/history.js');
    const k = 40;
    const subset = { nObs: 100, kept: Uint32Array.from({ length: k }, (_, i) => i * 2), spec: { method: 'uniform', nObs: 100, k, seed: 0, specVersion: 1 }, prioritySeed: 0, autoFit: null, reproduced: null };
    const dom = Object.fromEntries(['root', 'slider', 'percent', 'count', 'settings', 'method', 'seed', 'fieldRow',
      'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList', 'openAll', 'copyLink', 'useBlocks'].map(key => [key, element()]));
    const state = { pointCount: k, obsData: { fields: [] }, cellIdentity: { digest: '0123456789abcdef', n: k, kept: subset.kept, toOriginal: positions => positions }, getMappingCandidates: () => null };
    const log = [];
    // The dataset controls' reading again: cancelled when its caller stops (`reopenOpenDataset`).
    const reopen = (_cellSubset, { signal = null } = {}) => new Promise(resolve => {
      log.push('reading');
      onAbort(signal, () => { log.push('cancelled'); resolve({ shown: false, inPlace: false }); });
    });
    const control = initSubsampleControl({ dom, state, getCellSubset: () => subset, reopen });
    // A page of fake domains, the cells domain over this control, and its history.
    const page = { theme: 'light' };
    const domains = getStateDomains();
    // Withdrawn at the end: the page's registries are this file's (each test makes its own page on them).
    const withdraw = [];
    withdraw.push(domains.provide('cells', createCellsDomain({
      openCells: {
        subset: () => subset,
        geneSample: () => null,
        genesAsked: () => null,
        setGenesAsked() {},
        reopen: (request, how) => control.reopenKeeping(request, how),
        readGenes: async () => null,
      },
    })));
    withdraw.push(domains.provide('layout', { capture: () => page.theme, restore: value => { page.theme = value; } }));
    for (const id of domains.missing()) withdraw.push(domains.provide(id, { capture: () => null, restore: () => {} }));
    const actions = getActions();
    withdraw.push(actions.provide('layout.theme.set', ({ theme }) => { page.theme = theme; return { theme }; }));
    let t = 0;
    const history = createHistory({
      dispatcher: actions, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
      newTrackerId: () => 't-00000000-0000-4000-8000-000000000001', now: () => ++t * 1000,
    });
    await history.startTracker();
    await actions.dispatch('layout.theme.set', { theme: 'dark' });
    const steps = history.active.steps.size;
    const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-cells' };
    const opening = actions.dispatch('cells.open', { mode: 'all' }, agent);
    while (!log.includes('reading')) await new Promise(resolve => setImmediate(resolve));
    const reason = STOP();
    assert.equal(actions.stop({ turn: agent.turn }, reason), 1);
    const outcome = await settlesSoon(opening);
    assert.ok(outcome !== null, 'the stopped action ended without the reading\'s end');
    assert.equal(outcome.error, reason);
    assert.deepEqual(log, ['reading', 'cancelled'], 'the reading was cancelled with the action');
    assert.equal(history.active.steps.size, steps, 'no step');
    // The history is free: a move runs.
    await actions.dispatch('history.undo', {});
    assert.equal(page.theme, 'light');
    history.destroy();
    control.destroy();
    for (const remove of withdraw) remove();
  } finally {
    globalThis.window = previous.window;
    globalThis.Option = previous.Option;
  }
});
