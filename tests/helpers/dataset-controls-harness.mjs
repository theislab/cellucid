/**
 * A fake document, dataset manager and Dataset box for the dataset controls
 * (`app/ui/modules/dataset-controls.js`) in Node: `makeHarness(catalog)`
 * gives the controls everything `initDatasetControls` takes, and records
 * what they said (`statuses`) and did.
 *
 * Copied from `tests/dataset-controls-exact-contract.test.mjs` (2026-11-01),
 * which keeps its own copy until it imports this one.
 */
import assert from 'node:assert/strict';

import {
  createLatestDatasetReloadCoordinator
} from '../../assets/js/app/dataset-reload-outcome.js';

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

export class FakeElement {
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

  remove() {
    if (this.parentNode === null) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
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

export class FakeSelect extends FakeElement {
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

export class FakeDocument {
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

export function makeIdentity(id, name, nCells = 0) {
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

export function createDeferred() {
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

export class FakeDatasetManager {
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
      baseUrl: `anndata://${sourceType}/${datasetId}/`,
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

export function installBrowserGlobals(fakeDocument) {
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
export function createFakeDatasetCard() {
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

export function makeHarness(catalog) {
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
    clearActivePageHighlights: async () => stateCalls.push('clearActivePageHighlights'),
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
    resizeOpenCells: async () => ({ inPlace: false }),
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
      await state.clearActivePageHighlights();
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

