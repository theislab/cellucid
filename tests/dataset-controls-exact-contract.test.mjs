import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.disabled = false;
    this.selected = false;
    this.textContent = '';
    this.title = '';
    this.value = '';
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
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
    version: 2,
    id,
    name,
    description: '',
    cellucid_data_version: '1.0.0',
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
      available_dimensions: [2],
      default_dimension: 2,
      files: {
        '2d': 'points_2d.bin'
      }
    },
    obs_fields: []
  };
}

class FakeDatasetManager {
  constructor(catalog) {
    this.catalog = catalog;
    this.activeDatasetId = null;
    this.activeSourceType = null;
    this.activeMetadata = null;
    this.datasetListeners = [];
    this.sourceListeners = [];
    this.switchError = null;
  }

  async getAllDatasets() {
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

function makeHarness(catalog) {
  const fakeDocument = new FakeDocument();
  const browser = installBrowserGlobals(fakeDocument);
  const select = new FakeSelect(fakeDocument);
  const info = new FakeElement('section', fakeDocument);
  const dom = {
    select,
    info,
    nameEl: new FakeElement('span', fakeDocument),
    sourceEl: new FakeElement('span', fakeDocument),
    descriptionEl: new FakeElement('span', fakeDocument),
    urlEl: new FakeElement('span', fakeDocument),
    cellsEl: new FakeElement('span', fakeDocument),
    genesEl: new FakeElement('span', fakeDocument),
    obsEl: new FakeElement('span', fakeDocument),
    connectivityEl: new FakeElement('span', fakeDocument)
  };
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
    showSessionStatus: (message, isError) =>
      statuses.push({ message, isError }),
    updateDimensionSelectUI: () =>
      callbackCalls.push('updateDimensionSelectUI')
  };
  const reloads = [];
  const clearCalls = [];
  return {
    browser,
    callbackCalls,
    callbacks,
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
    state,
    stateCalls,
    statuses,
    viewer,
    viewerCalls
  };
}

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
    /must contain exactly: callbacks, clearDataset, dataSourceManager, dom, reloadDataset/
  );
});

test('catalog keeps None explicit and distinguishes equal ids across sources', async t => {
  const first = makeIdentity('shared', 'First', 0);
  const second = makeIdentity('shared', 'Second', 12);
  const harness = makeHarness([
    { sourceType: 'local-user', datasets: [first] },
    { sourceType: 'jupyter', datasets: [second] }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    dataSourceManager: harness.manager,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  const values = harness.select.options.map(option => option.value);
  assert.deepEqual(values, [
    NONE_DATASET_VALUE,
    'dataset:local-user:shared',
    'dataset:jupyter:shared'
  ]);
  assert.equal(values.includes(''), false);
  assert.equal(harness.select.value, NONE_DATASET_VALUE);
  assert.equal(harness.select.disabled, false);
  assert.equal(harness.dom.cellsEl.textContent, '–');
});

test('catalog failure remains visible and disables ambiguous selection', async t => {
  const harness = makeHarness(new Error('catalog offline'));
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    dataSourceManager: harness.manager,
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
  assert.match(harness.select.options[0].textContent, /catalog offline/);
  assert.equal(harness.dom.info.classList.contains('error'), true);
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'Failed to load dataset catalog: catalog offline',
    isError: true
  });
});

test('catalog publication replaces an in-flight exact dataset event atomically', async t => {
  const metadata = makeIdentity('in-flight', 'In flight');
  const catalog = [
    { sourceType: 'local-user', datasets: [metadata] }
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
    dataSourceManager: harness.manager,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });

  harness.manager.activeDatasetId = metadata.id;
  harness.manager.activeSourceType = 'local-user';
  harness.manager.activeMetadata = metadata;
  harness.manager.datasetListeners[0]({
    baseUrl: 'zarr://local-user/in-flight/',
    datasetId: metadata.id,
    loadMethod: 'dataset-dropdown',
    metadata,
    previousDatasetId: null,
    previousSourceType: null,
    sourceType: 'local-user'
  });
  resolveCatalog(catalog);

  assert.deepEqual(await controls.catalogReady, { status: 'ready' });
  assert.equal(harness.select.value, 'dataset:local-user:in-flight');
  assert.equal(harness.select.options.length, 2);
  assert.equal(harness.dom.info.classList.contains('error'), false);
});

test('selection reloads in place and None clears every exact runtime owner', async t => {
  const metadata = makeIdentity('local', 'Local data', 0);
  const harness = makeHarness([
    { sourceType: 'local-user', datasets: [metadata] }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls, NONE_DATASET_VALUE } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    dataSourceManager: harness.manager,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  assert.equal(await controls.selectDataset('local', 'local-user'), true);
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
      sourceType: 'local-user'
    }
  );
  assert.equal(harness.select.value, 'dataset:local-user:local');
  assert.equal(harness.dom.cellsEl.textContent, '0');
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'Dataset loaded',
    isError: false
  });
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
    { sourceType: 'local-user', datasets: [metadata] }
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
    dataSourceManager: harness.manager,
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
      isError === true && message.startsWith('Failed to clear dataset:')
    ),
    false
  );
});

test('terminal switch and malformed event failures are not guessed or hidden', async t => {
  const metadata = makeIdentity('broken', 'Broken');
  const harness = makeHarness([
    { sourceType: 'local-user', datasets: [metadata] }
  ]);
  t.after(harness.browser.restore);
  const { initDatasetControls } = await import(moduleUrl);
  const controls = initDatasetControls({
    dom: harness.dom,
    dataSourceManager: harness.manager,
    clearDataset: harness.clearDataset,
    reloadDataset: harness.reloadDataset,
    callbacks: harness.callbacks
  });
  assert.deepEqual(await controls.catalogReady, { status: 'ready' });

  harness.manager.switchError = new Error('switch rejected');
  assert.equal(
    await controls.selectDataset('broken', 'local-user'),
    false
  );
  assert.equal(harness.reloads.length, 1);
  assert.equal(harness.dom.info.classList.contains('error'), true);
  assert.deepEqual(harness.statuses.at(-1), {
    message: 'Failed to switch dataset: switch rejected',
    isError: true
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
