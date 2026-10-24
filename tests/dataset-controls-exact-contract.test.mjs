import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createLatestDatasetReloadCoordinator
} from '../assets/js/app/dataset-reload-outcome.js';

const moduleUrl = new URL(
  '../assets/js/app/ui/modules/dataset-controls.js',
  import.meta.url
);
const moduleSource = fs.readFileSync(moduleUrl, 'utf8');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.textContent = '';
    this.title = '';
    this.value = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener, options = {}) {
    this.listeners.set(type, listener);
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', () => {
        if (this.listeners.get(type) === listener) {
          this.listeners.delete(type);
        }
      }, { once: true });
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
}

function descendantOptions(element) {
  const options = [];
  for (const child of element.children) {
    if (child.tagName === 'OPTION') {
      options.push(child);
    } else {
      options.push(...descendantOptions(child));
    }
  }
  return options;
}

class FakeSelect extends FakeElement {
  constructor(ownerDocument) {
    super('select', ownerDocument);
    this._value = '';
    this.focusCalls = 0;
  }

  get options() {
    return descendantOptions(this);
  }

  get selectedOptions() {
    return this.options.filter(option => option.selected);
  }

  get value() {
    return this._value;
  }

  set value(nextValue) {
    const exactValue = String(nextValue);
    const match = this.options.find(option => option.value === exactValue);
    for (const option of this.options) {
      option.selected = option === match;
    }
    this._value = match === undefined ? '' : exactValue;
  }

  appendChild(child) {
    const result = super.appendChild(child);
    this.synchronizeSelection();
    return result;
  }

  replaceChildren(...children) {
    super.replaceChildren(...children);
    this.synchronizeSelection();
  }

  synchronizeSelection() {
    const options = this.options;
    const explicit = options.find(option => option.selected);
    const selected = explicit ?? options[0];
    for (const option of options) option.selected = option === selected;
    this._value = selected === undefined ? '' : selected.value;
  }

  focus() {
    this.focusCalls++;
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

function makeIdentity(id, name, nCells = 0) {
  return {
    id,
    name,
    description: '',
    stats: {
      n_cells: nCells,
      n_genes: 0,
      n_obs_fields: 0,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: false,
      n_edges: null
    },
    embeddings: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: {
          label: 'X_umap',
          dimension: 2,
          path: 'obsm/0/0-1',
          source: { key: 'X_umap', columns: [0, 1] }
        }
      }
    },
    obs_fields: []
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleDatasetEvent() {
  await new Promise(resolve => setImmediate(resolve));
}

class FakeDatasetManager {
  constructor(catalog) {
    this.catalog = catalog;
    this.catalogCalls = [];
    this.activeDatasetId = null;
    this.activeSourceType = null;
    this.activeMetadata = null;
    this.datasetListeners = [];
    this.sourceListeners = [];
    this.switchError = null;
  }

  async getAllDatasets(options) {
    this.catalogCalls.push(options === undefined ? null : options);
    if (this.catalog instanceof Error) throw this.catalog;
    return this.catalog;
  }

  getCurrentDatasetId() {
    return this.activeDatasetId;
  }

  getCurrentMetadata() {
    return this.activeMetadata;
  }

  getCurrentSourceType() {
    return this.activeSourceType;
  }

  getSource(sourceType) {
    return {
      getType() {
        return sourceType;
      }
    };
  }

  onDatasetChange(listener) {
    this.datasetListeners.push(listener);
  }

  offDatasetChange(listener) {
    this.datasetListeners = this.datasetListeners.filter(
      candidate => candidate !== listener
    );
  }

  onSourcesChange(listener) {
    this.sourceListeners.push(listener);
  }

  registerSource() {}

  unregisterSource() {}

  async switchToDataset(sourceType, datasetId, options) {
    if (this.switchError !== null) throw this.switchError;
    assert.deepEqual(options, { loadMethod: 'dataset-dropdown' });
    const source = this.catalog.find(
      record => record.sourceType === sourceType
    );
    const metadata = source?.datasets.find(
      dataset => dataset.id === datasetId
    );
    if (metadata === undefined) {
      throw new Error(`Missing fake dataset ${sourceType}/${datasetId}.`);
    }
    const previousSourceType = this.activeSourceType;
    const previousDatasetId = this.activeDatasetId;
    this.activeSourceType = sourceType;
    this.activeDatasetId = datasetId;
    this.activeMetadata = metadata;
    const event = {
      baseUrl: `zarr://${sourceType}/${datasetId}/`,
      datasetId,
      loadMethod: options.loadMethod,
      metadata,
      previousDatasetId,
      previousSourceType,
      sourceType
    };
    for (const listener of this.datasetListeners) listener(event);
  }

  async clearActiveDataset(options) {
    assert.deepEqual(options, { loadMethod: 'dataset-dropdown' });
    const previousSourceType = this.activeSourceType;
    const previousDatasetId = this.activeDatasetId;
    this.activeSourceType = null;
    this.activeDatasetId = null;
    this.activeMetadata = null;
    if (previousDatasetId === null) return;
    const event = {
      baseUrl: null,
      datasetId: null,
      loadMethod: options.loadMethod,
      metadata: null,
      previousDatasetId,
      previousSourceType,
      sourceType: null
    };
    for (const listener of this.datasetListeners) listener(event);
  }
}

function installBrowserGlobals(fakeDocument) {
  const replacements = {
    document: globalThis.document,
    history: globalThis.history,
    window: globalThis.window
  };
  const historyCalls = [];
  globalThis.document = fakeDocument;
  globalThis.window = {
    addEventListener() {},
    location: {
      href: 'https://cellucid.example/viewer?dataset=old'
    },
    history: null
  };
  globalThis.history = {
    replaceState(...args) {
      historyCalls.push(args);
    }
  };
  globalThis.window.history = globalThis.history;
  return {
    historyCalls,
    restore() {
      for (const [key, value] of Object.entries(replacements)) {
        if (value === undefined) {
          delete globalThis[key];
        } else {
          globalThis[key] = value;
        }
      }
    }
  };
}

/**
 * The Dataset box as the controls drive it: what it shows (no dataset, a
 * dataset opening, or one dataset), never anything else.
 */
function createFakeDatasetCard() {
  return {
    cells: '',
    edges: null,
    name: 'No dataset open',
    refreshes: 0,
    sourceType: null,
    state: 'empty',
    show(metadata, sourceType) {
      this.state = 'ready';
      this.name = metadata.name;
      this.cells = String(metadata.stats.n_cells);
      this.sourceType = sourceType;
    },
    showLoading(label) {
      this.state = 'loading';
      this.name = label;
      this.cells = '';
      this.sourceType = null;
    },
    showNone() {
      this.state = 'empty';
      this.name = 'No dataset open';
      this.cells = '';
      this.sourceType = null;
    },
    refreshFacts() {
      this.refreshes++;
    },
    showLoadedConnectivityEdges(edges) {
      this.edges = edges;
    }
  };
}

function makeHarness(catalog) {
  const fakeDocument = new FakeDocument();
  const browser = installBrowserGlobals(fakeDocument);
  const select = new FakeSelect(fakeDocument);
  // The real markup wraps the selector in its own control block; the recovery
  // notice is mounted there, next to the selector it explains.
  const selectBlock = new FakeElement('div', fakeDocument);
  selectBlock.appendChild(select);
  const dom = { select };
  const card = createFakeDatasetCard();
  const manager = new FakeDatasetManager(catalog);
  const stateCalls = [];
  const state = {
    varData: {},
    clearActiveField: async () => stateCalls.push('clearActiveField'),
    clearAllHighlights: async () => stateCalls.push('clearAllHighlights'),
    clearSnapshotViews: async () => stateCalls.push('clearSnapshotViews'),
    initScene: async (...args) => stateCalls.push(['initScene', ...args]),
    setFieldLoader: async value => stateCalls.push(['setFieldLoader', value]),
    setVarFieldLoader: async value => stateCalls.push(['setVarFieldLoader', value])
  };
  const viewerCalls = [];
  const viewer = {
    clearSnapshotViews: async () => viewerCalls.push('clearSnapshotViews'),
    updateHighlight: async value => viewerCalls.push(['updateHighlight', value])
  };
  const callbackCalls = [];
  const statuses = [];
  const callbacks = {
    clearGeneSelection: () => callbackCalls.push('clearGeneSelection'),
    initGeneExpressionDropdown: () =>
      callbackCalls.push('initGeneExpressionDropdown'),
    refreshUIForActiveView: () =>
      callbackCalls.push('refreshUIForActiveView'),
    renderDeletedFieldsSection: () =>
      callbackCalls.push('renderDeletedFieldsSection'),
    renderFieldSelects: () => callbackCalls.push('renderFieldSelects'),
    renderRepresentationPicker: () =>
      callbackCalls.push('renderRepresentationPicker'),
    showSessionStatus: (message, isError, details) =>
      statuses.push(
        details === undefined ? { message, isError } : { message, isError, details }
      )
  };
  const reloads = [];
  const clearCalls = [];
  return {
    browser,
    datasetChanges: createLatestDatasetReloadCoordinator(() => ({
      baseUrl: null,
      datasetId: null,
      selectionIdentity: null,
      source: null
    })),
    callbackCalls,
    callbacks,
    card,
    dom,
    manager,
    reloads,
    reloadDataset: async selection => {
      reloads.push(selection);
      await manager.switchToDataset(
        selection.sourceType,
        selection.datasetId,
        { loadMethod: selection.loadMethod }
      );
      return true;
    },
    clearDataset: async () => {
      clearCalls.push('clear');
      await manager.clearActiveDataset({
        loadMethod: 'dataset-dropdown'
      });
      await state.setFieldLoader(null);
      await state.setVarFieldLoader(null);
      state.varData = null;
      await state.initScene(new Float32Array(), {
        fields: [],
        count: 0
      });
      await state.clearActiveField();
      await state.clearAllHighlights();
      await state.clearSnapshotViews();
      await viewer.clearSnapshotViews();
      await viewer.updateHighlight(new Uint8Array());
      return true;
    },
    clearCalls,
    select,
    selectBlock,
    catalogNotice: () => {
      const notices = selectBlock.children.filter(
        child => child !== select
      );
      assert.equal(
        notices.length,
        1,
        'the selector block must own exactly one catalog notice'
      );
      const [notice] = notices;
      const [messageEl, retryButton] = notice.children;
      return { notice, messageEl, retryButton };
    },
    state,
    stateCalls,
    statuses,
    viewer,
    viewerCalls
  };
}

function dispatchDatasetSelection(harness, value) {
  harness.select.value = value;
  const listener = harness.select.listeners.get('change');
  assert.equal(typeof listener, 'function');
  listener({ currentTarget: harness.select });
}

function captureDatasetUi(harness) {
  return {
    cells: harness.card.cells,
    disabled: harness.select.disabled,
    name: harness.card.name,
    sourceType: harness.card.sourceType,
    state: harness.card.state,
    statuses: harness.statuses.map(status => ({ ...status })),
    value: harness.select.value
  };
}

test('dataset teardown drains a rejected reload without publishing stale UI', async t => {
  const current = makeIdentity('current', 'Current', 12);
  const target = makeIdentity('target', 'Target', 24);
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [current, target],
      error: null
    }
  ]);
  t.after(harness.browser.restore);
  harness.manager.activeDatasetId = current.id;
  harness.manager.activeSourceType = 'local-demo';
  harness.manager.activeMetadata = current;

  const reload = createDeferred();
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: () => reload.promise,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  dispatchDatasetSelection(
    harness,
    'dataset:local-demo:target'
  );
  assert.equal(harness.card.state, 'loading');
  const terminalUi = captureDatasetUi(harness);
  const terminalCallbacks = [...harness.callbackCalls];

  const destroyPromise = controls.destroy();
  assert.equal(controls.destroy(), destroyPromise);
  assert.equal(harness.manager.datasetListeners.length, 0);
  assert.equal(harness.select.listeners.has('change'), false);

  let drained = false;
  void destroyPromise.then(() => {
    drained = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);

  reload.reject(new Error('reload rejected after UI disposal'));
  await assert.doesNotReject(destroyPromise);
  assert.equal(drained, true);
  assert.deepEqual(captureDatasetUi(harness), terminalUi);
  assert.deepEqual(harness.callbackCalls, terminalCallbacks);
  await assert.rejects(
    controls.selectDataset('target', 'local-demo'),
    /unavailable after destroy/
  );
});

test('dataset controls contain no dev global, reload, or guessed-source path', () => {
  assert.doesNotMatch(moduleSource, /__CELLUCID_DEV__/);
  assert.doesNotMatch(moduleSource, /runLocalUserInPlaceSwitchSelfTest/);
  assert.doesNotMatch(moduleSource, /location\.reload|setTimeout/);
  assert.doesNotMatch(moduleSource, /\|\|\s*['"]local-demo['"]/);
  assert.doesNotMatch(moduleSource, /catch\s*\([^)]*\)\s*\{\s*\}/s);
  assert.doesNotMatch(moduleSource, /catch\s*\{\s*\}/s);
});

test('dataset controls require their exact top-level contract', async () => {
  const { initDatasetControls } = await import(moduleUrl);
  assert.throws(
    () => initDatasetControls({}),
    /must contain exactly: callbacks, clearDataset, dataSourceManager, datasetCard, datasetChanges, dom, reloadDataset/
  );
});

test('catalog keeps None explicit and distinguishes equal ids across sources', async t => {
  // Two connected catalogs that each hold several datasets are both offered,
  // one group each; the samples step aside while a catalog is connected.
  const first = makeIdentity('shared', 'First', 0);
  const firstOther = makeIdentity('first-other', 'First other', 3);
  const second = makeIdentity('shared', 'Second', 12);
  const secondOther = makeIdentity('second-other', 'Second other', 4);
  const sample = makeIdentity('sample', 'Sample', 5);
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [sample], error: null },
    { sourceType: 'link', datasets: [first, firstOther], error: null },
    { sourceType: 'remote', datasets: [second, secondOther], error: null }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  const values = harness.select.options.map(option => option.value);
  assert.deepEqual(values, [
    NONE_DATASET_VALUE,
    'dataset:link:shared',
    'dataset:link:first-other',
    'dataset:remote:shared',
    'dataset:remote:second-other'
  ]);
  assert.equal(values.includes(''), false);
  assert.equal(harness.select.value, NONE_DATASET_VALUE);
  assert.equal(harness.select.disabled, false);
  assert.equal(harness.card.cells, '');
});

test('an empty catalog publishes the exact ready outcome and leaves None usable', async t => {
  const harness = makeHarness([]);
  t.after(harness.browser.restore);
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  const catalogOutcome = await controls.catalogReady;
  assert.deepEqual(catalogOutcome, { status: 'ready' });
  assert.equal(Object.isFrozen(catalogOutcome), true);
  assert.equal(harness.select.disabled, false);
  assert.equal(harness.select.value, NONE_DATASET_VALUE);
  assert.deepEqual(
    harness.select.options.map(option => ({
      disabled: option.disabled,
      text: option.textContent,
      value: option.value
    })),
    [
      {
        disabled: false,
        text: 'None',
        value: NONE_DATASET_VALUE
      },
      {
        disabled: true,
        text: 'No datasets found',
        value: '__catalog_empty__'
      }
    ]
  );
});

test('an older catalog request publishes superseded without disturbing the newer catalog', async t => {
  const metadata = makeIdentity('current', 'Current dataset', 12);
  const catalog = [
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ];
  const harness = makeHarness(catalog);
  t.after(harness.browser.restore);
  const pendingCatalogs = [];
  harness.manager.getAllDatasets = () => new Promise(resolve => {
    pendingCatalogs.push(resolve);
  });
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  assert.equal(pendingCatalogs.length, 1);
  const newerCatalogTask = controls.populateDatasetDropdown();
  assert.equal(pendingCatalogs.length, 2);
  pendingCatalogs[1](catalog);
  const newerOutcome = await newerCatalogTask;
  assert.deepEqual(newerOutcome, { status: 'ready' });
  assert.equal(Object.isFrozen(newerOutcome), true);
  assert.equal(harness.select.disabled, false);
  assert.deepEqual(
    harness.select.options.map(option => option.value),
    ['__none__', 'dataset:local-demo:current']
  );

  pendingCatalogs[0](catalog);
  const olderOutcome = await controls.catalogReady;
  assert.deepEqual(olderOutcome, { status: 'superseded' });
  assert.equal(Object.isFrozen(olderOutcome), true);
  assert.equal(harness.select.disabled, false);
  assert.deepEqual(
    harness.select.options.map(option => option.value),
    ['__none__', 'dataset:local-demo:current']
  );
});

test('catalog failure remains visible and disables ambiguous selection', async t => {
  const harness = makeHarness(new Error('catalog offline'));
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  const catalogOutcome = await controls.catalogReady;
  assert.equal(catalogOutcome.status, 'failed');
  assert.match(catalogOutcome.error.message, /catalog offline/);
  assert.equal(harness.select.disabled, true);
  assert.equal(harness.select.options.length, 1);
  assert.equal(harness.select.value, '__catalog_error__');
  assert.equal(harness.select.options[0].textContent, 'Dataset list unavailable');
  assert.equal(harness.card.state === 'loading', false);
  // One sentence; the raw error is the notification's Details.
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'The dataset list could not be loaded.',
    isError: true,
    details: 'catalog offline'
  });
});

test('catalog publication replaces an in-flight exact dataset event atomically', async t => {
  const metadata = makeIdentity('in-flight', 'In flight');
  const catalog = [
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ];
  const harness = makeHarness(catalog);
  t.after(harness.browser.restore);
  let resolveCatalog;
  harness.manager.getAllDatasets = () => new Promise(resolve => {
    resolveCatalog = resolve;
  });
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  harness.manager.activeDatasetId = metadata.id;
  harness.manager.activeSourceType = 'local-demo';
  harness.manager.activeMetadata = metadata;
  harness.manager.datasetListeners[0]({
    baseUrl: 'zarr://local-demo/in-flight/',
    datasetId: metadata.id,
    loadMethod: 'dataset-dropdown',
    metadata,
    previousDatasetId: null,
    previousSourceType: null,
    sourceType: 'local-demo'
  });
  resolveCatalog(catalog);

  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.equal(harness.select.value, 'dataset:local-demo:in-flight');
  assert.equal(harness.select.options.length, 2);
  assert.equal(harness.card.state === 'loading', false);
});

test('selection reloads in place and None clears every exact runtime owner', async t => {
  const metadata = makeIdentity('local', 'Local data', 0);
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  assert.equal(await controls.selectDataset('local', 'local-demo'), true);
  assert.equal(harness.reloads.length, 1);
  assert.deepEqual(
    {
      datasetId: harness.reloads[0].datasetId,
      loadMethod: harness.reloads[0].loadMethod,
      sourceType: harness.reloads[0].sourceType
    },
    {
      datasetId: 'local',
      loadMethod: 'dataset-dropdown',
      sourceType: 'local-demo'
    }
  );
  assert.equal(harness.select.value, 'dataset:local-demo:local');
  assert.equal(harness.card.cells, '0');
  // The opening progress announces how the change went; the controls add
  // no toast of their own.
  assert.equal(
    harness.statuses.some(status => status.message === 'Dataset loaded'),
    false
  );
  assert.equal(harness.browser.historyCalls.length, 0);

  assert.equal(await controls.clearDataset(), true);
  assert.equal(harness.manager.getCurrentDatasetId(), null);
  assert.equal(harness.manager.getCurrentSourceType(), null);
  assert.equal(harness.manager.getCurrentMetadata(), null);
  assert.equal(harness.select.value, NONE_DATASET_VALUE);
  assert.equal(harness.state.varData, null);
  assert.deepEqual(
    harness.stateCalls.map(call => Array.isArray(call) ? call[0] : call),
    [
      'setFieldLoader',
      'setVarFieldLoader',
      'initScene',
      'clearActiveField',
      'clearAllHighlights',
      'clearSnapshotViews'
    ]
  );
  assert.deepEqual(
    harness.viewerCalls.map(call => Array.isArray(call) ? call[0] : call),
    ['clearSnapshotViews', 'updateHighlight']
  );
  assert.equal(harness.browser.historyCalls.length, 0);
  assert.deepEqual(harness.clearCalls, ['clear']);
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'No dataset selected',
    isError: false
  });
});

test('a superseded None selection remains owned by the newer dataset intent', async t => {
  const metadata = makeIdentity('current', 'Current');
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ]);
  t.after(harness.browser.restore);
  const {
    createDatasetReloadSupersededError,
    isDatasetReloadSupersededError
  } = await import('../assets/js/app/dataset-reload-outcome.js');
  const superseded = createDatasetReloadSupersededError(
    'A newer selection owns dataset publication.'
  );
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: async () => {
      throw superseded;
    },
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  await assert.rejects(
    controls.clearDataset(),
    error => error === superseded && isDatasetReloadSupersededError(error)
  );
  assert.equal(
    harness.statuses.some(({ message, isError }) =>
      isError === true && message === 'The dataset could not be closed.'
    ),
    false
  );
});

test('an older DOM selection settlement cannot mutate a newer pending selection', async t => {
  const current = makeIdentity('current', 'Current');
  const first = makeIdentity('first', 'First');
  const second = makeIdentity('second', 'Second');
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [current, first, second],
      error: null
    }
  ]);
  t.after(harness.browser.restore);
  harness.manager.activeDatasetId = current.id;
  harness.manager.activeSourceType = 'local-demo';
  harness.manager.activeMetadata = current;
  const pending = new Map();
  const reloadDataset = selection => {
    const request = createDeferred();
    pending.set(selection.datasetId, { request, selection });
    return request.promise;
  };
  const { createDatasetReloadSupersededError } = await import(
    '../assets/js/app/dataset-reload-outcome.js'
  );
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  dispatchDatasetSelection(
    harness,
    'dataset:local-demo:first'
  );
  assert.equal(pending.has('first'), true);
  dispatchDatasetSelection(
    harness,
    'dataset:local-demo:second'
  );
  assert.equal(pending.has('second'), true);
  const newerPendingUi = captureDatasetUi(harness);
  assert.equal(newerPendingUi.value, 'dataset:local-demo:second');
  assert.equal(newerPendingUi.state, 'loading');

  pending.get('first').request.reject(
    createDatasetReloadSupersededError(
      'The second DOM selection owns publication.'
    )
  );
  await settleDatasetEvent();
  assert.deepEqual(captureDatasetUi(harness), newerPendingUi);

  const secondSelection = pending.get('second').selection;
  await harness.manager.switchToDataset(
    secondSelection.sourceType,
    secondSelection.datasetId,
    { loadMethod: secondSelection.loadMethod }
  );
  pending.get('second').request.resolve(true);
  await settleDatasetEvent();
  assert.equal(
    harness.select.value,
    'dataset:local-demo:second'
  );
  assert.equal(harness.card.state === 'loading', false);
  // The opening progress announces how the change went; the controls add
  // no toast of their own.
  assert.equal(
    harness.statuses.some(status => status.message === 'Dataset loaded'),
    false
  );
});

test('selecting the committed dataset retires an older pending DOM intent', async t => {
  const current = makeIdentity('current', 'Current', 12);
  const pendingMetadata = makeIdentity('pending', 'Pending', 24);
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [current, pendingMetadata],
      error: null
    }
  ]);
  t.after(harness.browser.restore);
  harness.manager.activeDatasetId = current.id;
  harness.manager.activeSourceType = 'local-demo';
  harness.manager.activeMetadata = current;
  const pending = createDeferred();
  const { createDatasetReloadSupersededError } = await import(
    '../assets/js/app/dataset-reload-outcome.js'
  );
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: () => pending.promise,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  dispatchDatasetSelection(
    harness,
    'dataset:local-demo:pending'
  );
  assert.equal(harness.card.state, 'loading');
  assert.equal(harness.card.cells, '');

  dispatchDatasetSelection(
    harness,
    'dataset:local-demo:current'
  );
  await settleDatasetEvent();
  const currentUi = captureDatasetUi(harness);
  assert.equal(currentUi.value, 'dataset:local-demo:current');
  assert.equal(currentUi.state, 'ready');
  assert.equal(currentUi.cells, '12');
  assert.equal(
    currentUi.statuses.some(status => status.message === 'Dataset loaded'),
    false
  );

  pending.reject(
    createDatasetReloadSupersededError(
      'The committed dataset selection retired pending work.'
    )
  );
  await settleDatasetEvent();
  assert.deepEqual(captureDatasetUi(harness), currentUi);
});

test('DOM switch failure rolls back selection and preserves terminal error styling', async t => {
  const metadata = makeIdentity('broken', 'Broken');
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  harness.manager.switchError = new Error('switch rejected');
  dispatchDatasetSelection(
    harness,
    'dataset:local-demo:broken'
  );
  await settleDatasetEvent();

  assert.equal(harness.select.value, NONE_DATASET_VALUE);
  assert.equal(harness.card.state === 'loading', false);
  // One notification, one sentence; the raw text is its Details. What to do
  // stays next to the selector, with the retry.
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'Could not open "Broken".',
    isError: true,
    details: 'switch rejected'
  });
});

test('DOM None and malformed failures preserve rollback error styling', async t => {
  const metadata = makeIdentity('current', 'Current');
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ]);
  t.after(harness.browser.restore);
  harness.manager.activeDatasetId = metadata.id;
  harness.manager.activeSourceType = 'local-demo';
  harness.manager.activeMetadata = metadata;
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: async () => {
      throw new Error('clear rejected');
    },
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  dispatchDatasetSelection(harness, NONE_DATASET_VALUE);
  await settleDatasetEvent();
  assert.equal(
    harness.select.value,
    'dataset:local-demo:current'
  );
  assert.equal(harness.card.state === 'loading', false);
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'The dataset could not be closed.',
    isError: true,
    details: 'clear rejected'
  });

  const listener = harness.select.listeners.get('change');
  assert.equal(typeof listener, 'function');
  listener({ currentTarget: null });
  await settleDatasetEvent();
  assert.equal(
    harness.select.value,
    'dataset:local-demo:current'
  );
  assert.equal(harness.card.state === 'loading', false);
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'That dataset choice could not be applied.',
    isError: true,
    details: 'Dataset change DOM event must be owned by the dataset select.'
  });
});

test('terminal switch and malformed event failures are not guessed or hidden', async t => {
  const metadata = makeIdentity('broken', 'Broken');
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  harness.manager.switchError = new Error('switch rejected');
  assert.equal(
    await controls.selectDataset('broken', 'local-demo'),
    false
  );
  assert.equal(harness.reloads.length, 1);
  assert.equal(harness.card.state === 'loading', false);
  // One notification, one sentence; the raw text is its Details. What to do
  // stays next to the selector, with the retry.
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'Could not open "Broken".',
    isError: true,
    details: 'switch rejected'
  });

  assert.throws(
    () => harness.manager.datasetListeners[0]({
      baseUrl: null,
      datasetId: null,
      loadMethod: null,
      metadata: null,
      previousDatasetId: null,
      previousSourceType: null,
      sourceType: null,
      legacyDataset: null
    }),
    /must contain exactly/
  );
});

// ---------------------------------------------------------------------------
// Per-source catalog failure and recovery
// ---------------------------------------------------------------------------
// getAllDatasets() reports one record per probed source. A source that failed
// carries an Error and no datasets; a source that is merely unavailable is not
// reported at all. The selector must keep listing the sources that answered,
// say plainly which one did not, and offer the retry that clears the cached
// failure -- without that retry the only recovery is a page reload.

test('a failed source is named next to the selector while healthy sources still list', async t => {
  const metadata = makeIdentity('local', 'Local dataset', 20);
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [],
      error: new Error(
        'Sample catalog https://catalog.cellucid.test/datasets.json: ' +
        'CORS owner rejected the request'
      )
    },
    {
      sourceType: 'link',
      datasets: [metadata, makeIdentity('linked', 'Linked dataset', 4)],
      error: null
    }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.equal(harness.select.disabled, false);
  assert.deepEqual(
    harness.select.options.map(option => option.value),
    ['__none__', 'dataset:link:local', 'dataset:link:linked'],
    'one unreachable catalog must not remove the sources that answered'
  );

  const { notice, messageEl, retryButton } = harness.catalogNotice();
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.classList.contains('dataset-notice'), true);
  assert.match(messageEl.textContent, /Sample datasets could not be loaded/);
  assert.doesNotMatch(
    messageEl.textContent,
    /CORS|https:|Error/,
    'the notice must not quote the transport diagnostic at a biologist'
  );
  assert.match(messageEl.textContent, /try again/i);
  assert.equal(retryButton.tagName, 'BUTTON');
  assert.equal(retryButton.textContent, 'Try again');
  assert.equal(retryButton.disabled, false);
  assert.equal(harness.card.state === 'loading', false);
  assert.deepEqual(harness.manager.catalogCalls, [{ refresh: false }]);
});

test('an unavailable source is never announced as a failure', async t => {
  const metadata = makeIdentity('local', 'Local dataset', 20);
  // An unavailable source produces no record at all, so the only entry here is
  // the healthy one and nothing must be said about anything else.
  const harness = makeHarness([
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  const { notice, messageEl } = harness.catalogNotice();
  assert.equal(notice.hidden, true);
  assert.equal(messageEl.textContent, '');
});

test('the notice retry clears the cached failure and reports its outcome', async t => {
  const metadata = makeIdentity('sample', 'Sample dataset', 44);
  const failedCatalog = [
    {
      sourceType: 'local-demo',
      datasets: [],
      error: new Error('catalog host unreachable')
    }
  ];
  const healedCatalog = [
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ];
  const harness = makeHarness(failedCatalog);
  t.after(harness.browser.restore);
  const catalogRequests = [];
  let pendingCatalog = null;
  harness.manager.getAllDatasets = options => {
    catalogRequests.push(options === undefined ? null : options);
    return new Promise(resolve => {
      pendingCatalog = resolve;
    });
  };

  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  pendingCatalog(failedCatalog);
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.deepEqual(catalogRequests, [{ refresh: false }]);

  const { notice, messageEl, retryButton } = harness.catalogNotice();
  assert.equal(notice.hidden, false);
  assert.match(messageEl.textContent, /Sample datasets could not be loaded/);

  retryButton.listeners.get('click')();
  assert.deepEqual(
    catalogRequests,
    [{ refresh: false }, { refresh: true }],
    'the retry must be the refreshing pass that clears the cached failure'
  );
  assert.equal(
    notice.hidden,
    false,
    'the affordance must stay put while its own retry is in flight'
  );
  assert.equal(retryButton.disabled, true);
  assert.equal(retryButton.textContent, 'Retrying…');
  assert.equal(harness.select.disabled, true);

  pendingCatalog(healedCatalog);
  await settleDatasetEvent();

  assert.equal(notice.hidden, true);
  assert.equal(retryButton.disabled, false);
  assert.equal(retryButton.textContent, 'Try again');
  assert.equal(harness.select.disabled, false);
  assert.deepEqual(
    harness.select.options.map(option => option.value),
    ['__none__', 'dataset:local-demo:sample']
  );
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'Dataset list reloaded',
    isError: false
  });
});

test('a retry that fails again says so instead of settling silently', async t => {
  const failedCatalog = [
    {
      sourceType: 'local-demo',
      datasets: [],
      error: new Error('catalog host unreachable')
    },
    {
      sourceType: 'link',
      datasets: [],
      error: new Error('rate limited')
    }
  ];
  const harness = makeHarness(failedCatalog);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  const { messageEl, retryButton } = harness.catalogNotice();
  assert.match(
    messageEl.textContent,
    /Sample datasets and Linked data could not be loaded/,
    'every failed source must be named, in the words the dropdown uses'
  );
  assert.equal(harness.select.value, '__none__');
  assert.deepEqual(
    harness.select.options.map(option => option.value),
    ['__none__', '__catalog_empty__']
  );

  retryButton.listeners.get('click')();
  await settleDatasetEvent();
  assert.deepEqual(
    harness.manager.catalogCalls,
    [{ refresh: false }, { refresh: true }]
  );
  assert.equal(retryButton.disabled, false);
  assert.equal(retryButton.textContent, 'Try again');
  assert.deepEqual(harness.statuses.at(-1), {
    message: messageEl.textContent,
    isError: true
  });
});

test('a total catalog failure offers the retry instead of a page reload', async t => {
  const harness = makeHarness(new Error('catalog offline'));
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  const catalogOutcome = await controls.catalogReady;
  assert.equal(catalogOutcome.status, 'failed');
  const { notice, messageEl, retryButton } = harness.catalogNotice();
  assert.equal(notice.hidden, false);
  assert.match(messageEl.textContent, /dataset list could not be loaded/i);
  assert.doesNotMatch(messageEl.textContent, /catalog offline/);
  assert.equal(retryButton.disabled, false);

  const metadata = makeIdentity('sample', 'Sample dataset', 9);
  harness.manager.catalog = [
    { sourceType: 'local-demo', datasets: [metadata], error: null }
  ];
  retryButton.listeners.get('click')();
  await settleDatasetEvent();

  assert.deepEqual(
    harness.manager.catalogCalls,
    [{ refresh: false }, { refresh: true }]
  );
  assert.equal(notice.hidden, true);
  assert.equal(harness.select.disabled, false);
  assert.deepEqual(
    harness.select.options.map(option => option.value),
    ['__none__', 'dataset:local-demo:sample']
  );
});

test('destroy retires the notice so no dead retry stays on screen', async t => {
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [],
      error: new Error('catalog host unreachable')
    }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  await controls.catalogReady;
  const { notice, retryButton } = harness.catalogNotice();
  assert.equal(notice.hidden, false);

  await controls.destroy();
  assert.equal(notice.hidden, true);
  assert.equal(retryButton.listeners.has('click'), false);
  retryButton.listeners.set('click', () => {});
  assert.deepEqual(harness.manager.catalogCalls, [{ refresh: false }]);
});

test('the catalog contract rejects a source record that reports both datasets and a failure', async t => {
  const metadata = makeIdentity('sample', 'Sample dataset', 3);
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [metadata],
      error: new Error('half-failed')
    }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  const outcome = await controls.catalogReady;
  assert.equal(outcome.status, 'failed');
  assert.match(
    outcome.error.message,
    /cannot report both datasets and a failure/
  );
});

test('a choice overtaken by a change made outside the controls puts the select back', async t => {
  const current = makeIdentity('current', 'Current', 12);
  const target = makeIdentity('target', 'Target', 24);
  const harness = makeHarness([
    {
      sourceType: 'local-demo',
      datasets: [current, target],
      error: null
    }
  ]);
  t.after(harness.browser.restore);
  harness.manager.activeDatasetId = current.id;
  harness.manager.activeSourceType = 'local-demo';
  harness.manager.activeMetadata = current;
  const {
    createDatasetReloadSupersededError,
    isDatasetReloadSupersededError
  } = await import('../assets/js/app/dataset-reload-outcome.js');

  const reload = createDeferred();
  const reloadTransactions = [];
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: selection => {
      reloadTransactions.push(selection.transaction);
      return reload.promise;
    },
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  const selecting = controls.selectDataset('target', 'local-demo');
  // The choice is presented while it loads, under its own transaction.
  assert.equal(harness.select.value, 'dataset:local-demo:target');
  assert.equal(harness.card.state, 'loading');
  assert.equal(reloadTransactions.length, 1);
  assert.equal(reloadTransactions[0].isLatest(), true);
  assert.equal(harness.datasetChanges.settled, false);

  // The benchmark begins its own change in the bootstrap.
  const benchmark = harness.datasetChanges.begin();
  assert.equal(reloadTransactions[0].signal.aborted, true);
  reload.reject(
    createDatasetReloadSupersededError('A newer dataset change began.')
  );
  await assert.rejects(selecting, isDatasetReloadSupersededError);

  assert.equal(harness.select.value, 'dataset:local-demo:current');
  assert.equal(harness.card.state === 'loading', false);
  assert.equal(harness.card.name, 'Current');
  assert.equal(
    harness.statuses.some(({ isError }) => isError === true),
    false,
    'an overtaken choice announces nothing'
  );
  benchmark.finish();
  assert.equal(harness.datasetChanges.settled, true);
});

test('the sample catalog lists its entries while the startup dataset opens and marks it opening', async t => {
  const suo = makeIdentity('suo', 'Suo atlas', 1200);
  const garcia = makeIdentity('garcia', 'Garcia', 3400);
  const catalog = [
    { sourceType: 'local-demo', datasets: [suo, garcia], error: null }
  ];
  const harness = makeHarness(catalog);
  t.after(harness.browser.restore);
  // The full listing reads every file, after the dataset being opened.
  const listing = createDeferred();
  harness.manager.getAllDatasets = () => listing.promise;
  harness.manager.getSource = sourceType => ({
    getType: () => sourceType,
    isAvailable: async () => sourceType === 'local-demo',
    ...(sourceType === 'local-demo'
      ? {
          listCatalogEntries: async () => [
            { id: 'suo', name: 'suo' },
            { id: 'garcia', name: 'garcia' }
          ]
        }
      : {})
  });
  const opening = createDeferred();
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    datasetCard: harness.card,
    dataSourceManager: harness.manager,
    datasetChanges: harness.datasetChanges,
    clearDataset: harness.clearDataset,
    reloadDataset: () => opening.promise,
    callbacks: harness.callbacks
  });
  const startup = controls.loadStartupDataset({
    datasetId: 'suo',
    loadMethod: 'dataset-dropdown',
    sourceType: 'local-demo'
  });
  await settleDatasetEvent();
  const texts = () => harness.select.options.map(option => option.textContent);
  assert.deepEqual(texts(), ['None', 'suo · opening…', 'garcia']);
  assert.equal(harness.select.value, 'dataset:local-demo:suo');
  assert.equal(harness.select.disabled, false);

  listing.resolve(catalog);
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.deepEqual(
    texts(),
    ['None', 'Suo atlas (1.2K cells) · opening…', 'Garcia (3.4K cells)']
  );
  assert.equal(harness.select.value, 'dataset:local-demo:suo');

  await harness.manager.switchToDataset('local-demo', 'suo', {
    loadMethod: 'dataset-dropdown'
  });
  opening.resolve(true);
  assert.equal(await startup, 'ready');
  assert.deepEqual(
    texts(),
    ['None', 'Suo atlas (1.2K cells)', 'Garcia (3.4K cells)']
  );
  assert.equal(harness.select.value, 'dataset:local-demo:suo');
});
