import assert from 'node:assert/strict';
import test from 'node:test';

import { ComparisonModule } from '../assets/js/app/analysis/comparison-module.js';
import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { AnalysisUIManager } from '../assets/js/app/analysis/ui/analysis-ui-manager.js';
import { AnalysisWindowManager } from '../assets/js/app/analysis/ui/analysis-window-manager.js';
import { PlotRenderSlot } from '../assets/js/app/analysis/shared/plot-render-slot.js';
import { getMemoryMonitor } from '../assets/js/app/analysis/shared/memory-monitor.js';
import { createDataState } from '../assets/js/app/state/index.js';
import { EventEmitter } from '../assets/js/app/utils/event-emitter.js';
import {
  setDockableAccordions,
} from '../assets/js/app/dockable-accordions-registry.js';
import {
  restore as restoreAnalysisWindows,
} from '../assets/js/app/session/contributors/analysis-windows.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function isThenable(value) {
  return value !== null && typeof value?.then === 'function';
}

function createManagedContainer() {
  return {
    parentNode: {},
    removed: false,
    remove() {
      this.removed = true;
      this.parentNode = null;
    },
  };
}

function createBareUIManager({ destroy }) {
  const manager = Object.create(AnalysisUIManager.prototype);
  const container = createManagedContainer();
  const entry = {
    config: { id: 'owned' },
    container,
    initialized: true,
    ui: { destroy },
  };
  manager._uis = new Map([['owned', entry]]);
  manager._registry = new Map([['owned', entry.config]]);
  manager._activeMode = 'owned';
  manager._currentPages = ['page-a'];
  return { container, entry, manager };
}

test(
  'AnalysisUIManager unregister keeps its container alive until async UI destruction settles',
  async () => {
    const destruction = deferred();
    const { container, manager } = createBareUIManager({
      destroy: () => destruction.promise,
    });

    const result = manager.unregister('owned');
    const removedBeforeDestructionSettled = container.removed;

    destruction.resolve();
    await Promise.resolve(result);

    assert.equal(
      isThenable(result),
      true,
      'unregister must expose the owned teardown task to its caller',
    );
    assert.equal(
      removedBeforeDestructionSettled,
      false,
      'the UI may still be retiring a connected Plotly candidate',
    );
    assert.equal(container.removed, true);
  },
);

for (const lifecycle of ['destroy', 'reset']) {
  test(
    `AnalysisUIManager ${lifecycle} awaits async child destruction before retiring manager state`,
    async () => {
      const destruction = deferred();
      const { container, entry, manager } = createBareUIManager({
        destroy: () => destruction.promise,
      });

      const result = manager[lifecycle]();
      const stateRetiredBeforeDestructionSettled = lifecycle === 'destroy'
        ? container.removed
        : entry.ui === null;

      destruction.resolve();
      await Promise.resolve(result);

      assert.equal(
        isThenable(result),
        true,
        `${lifecycle} must expose the complete child teardown task`,
      );
      assert.equal(
        stateRetiredBeforeDestructionSettled,
        false,
        'manager state must remain owned while child cleanup is pending',
      );
      if (lifecycle === 'destroy') {
        assert.equal(container.removed, true);
      } else {
        assert.equal(entry.ui, null);
      }
    },
  );
}

test(
  'AnalysisUIManager propagates an exact async child teardown failure',
  async () => {
    const exactFailure = new Error('exact asynchronous UI teardown failure');
    const rejectedDestruction = Promise.reject(exactFailure);
    rejectedDestruction.catch(() => {});
    const { manager } = createBareUIManager({
      destroy: () => rejectedDestruction,
    });

    const result = manager.unregister('owned');

    assert.equal(isThenable(result), true);
    await assert.rejects(result, error => error === exactFailure);
  },
);

test(
  'AnalysisUIManager reset is referentially idempotent in flight and reusable after settlement',
  async () => {
    const firstDestruction = deferred();
    let destroyCalls = 0;
    const { entry, manager } = createBareUIManager({
      destroy() {
        destroyCalls += 1;
        return firstDestruction.promise;
      },
    });

    const first = manager.reset();
    const repeated = manager.reset();
    assert.equal(repeated, first);
    assert.equal(destroyCalls, 0, 'owned operations begin after publication');

    await Promise.resolve();
    assert.equal(destroyCalls, 1);
    firstDestruction.resolve();
    await first;

    entry.ui = {
      destroy() {
        destroyCalls += 1;
      },
    };
    entry.initialized = true;
    const reused = manager.reset();
    assert.notEqual(reused, first);
    await reused;
    assert.equal(destroyCalls, 2);
  },
);

test(
  'AnalysisUIManager destroy publishes one terminal referentially idempotent task',
  async () => {
    const destruction = deferred();
    let destroyCalls = 0;
    const { manager } = createBareUIManager({
      destroy() {
        destroyCalls += 1;
        return destruction.promise;
      },
    });

    const first = manager.destroy();
    const repeated = manager.destroy();
    assert.equal(repeated, first);

    destruction.resolve();
    await first;
    assert.equal(destroyCalls, 1);
    assert.equal(manager.destroy(), first);
  },
);

function installDockableRegistry(events = []) {
  setDockableAccordions({
    floatingRoot: {
      appendChild() {},
    },
    register() {},
    float() {},
    unregister(details) {
      events.push(`unregister:${details.id}`);
    },
  });
}

function createBareWindowManager({ destroy }) {
  const manager = Object.create(AnalysisWindowManager.prototype);
  const details = {
    id: 'details-a',
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  manager._windows = new Map([
    ['window-a', {
      id: 'window-a',
      details,
      ui: { destroy },
    }],
  ]);
  return { details, manager };
}

test(
  'AnalysisWindowManager closeWindow keeps the floating container alive until its UI is destroyed',
  async () => {
    const destruction = deferred();
    const registryEvents = [];
    installDockableRegistry(registryEvents);
    try {
      const { details, manager } = createBareWindowManager({
        destroy: () => destruction.promise,
      });

      const result = manager.closeWindow('window-a');
      const removedBeforeDestructionSettled = details.removed;

      destruction.resolve();
      await Promise.resolve(result);

      assert.equal(isThenable(result), true);
      assert.equal(removedBeforeDestructionSettled, false);
      assert.equal(details.removed, true);
      assert.deepEqual(registryEvents, ['unregister:details-a']);
    } finally {
      setDockableAccordions(null);
    }
  },
);

test(
  'AnalysisWindowManager coalesces repeated closeWindow calls onto one teardown owner',
  async () => {
    const destruction = deferred();
    let destroyCalls = 0;
    installDockableRegistry();
    try {
      const { manager } = createBareWindowManager({
        destroy() {
          destroyCalls += 1;
          return destruction.promise;
        },
      });

      const first = manager.closeWindow('window-a');
      const repeated = manager.closeWindow('window-a');

      destruction.resolve();
      await Promise.all([
        Promise.resolve(first),
        Promise.resolve(repeated),
      ]);

      assert.equal(isThenable(first), true);
      assert.equal(repeated, first);
      assert.equal(destroyCalls, 1);
    } finally {
      setDockableAccordions(null);
    }
  },
);

test(
  'AnalysisWindowManager retires a closing window from exports synchronously',
  async () => {
    const destruction = deferred();
    installDockableRegistry();
    try {
      const { details, manager } = createBareWindowManager({
        destroy: () => destruction.promise,
      });
      const entry = manager._windows.get('window-a');
      entry.modeId = 'owned';
      entry.headerTitle = 'Owned';
      entry.headerDesc = '';
      entry.details.getBoundingClientRect = () => ({
        height: 240,
        left: 20,
        top: 40,
        width: 320,
      });
      entry.ui.exportSettings = () => ({});

      const closeTask = manager.closeWindow('window-a');

      assert.equal(manager.getWindowCount(), 0);
      assert.deepEqual(manager.exportSessionWindows(), []);
      assert.equal(
        details.removed,
        false,
        'the DOM container remains owned until asynchronous UI teardown settles',
      );

      destruction.resolve();
      await closeTask;
    } finally {
      setDockableAccordions(null);
    }
  },
);

test(
  'AnalysisWindowManager closeAll observes every async close and preserves rejection identity',
  async () => {
    const manager = Object.create(AnalysisWindowManager.prototype);
    manager._windows = new Map([
      ['window-a', {}],
      ['window-b', {}],
    ]);
    const exactFailure = new Error('exact asynchronous window close failure');
    const rejectedClose = Promise.reject(exactFailure);
    rejectedClose.catch(() => {});
    const completed = [];
    manager.closeWindow = id => {
      completed.push(id);
      return id === 'window-a' ? rejectedClose : Promise.resolve();
    };

    const result = manager.closeAll();

    assert.equal(isThenable(result), true);
    await assert.rejects(
      result,
      error => (
        error === exactFailure ||
        (
          error instanceof AggregateError &&
          error.errors.includes(exactFailure)
        )
      ),
    );
    assert.deepEqual(completed, ['window-a', 'window-b']);
  },
);

test(
  'AnalysisWindowManager closeAll is a synchronous window-creation barrier',
  async () => {
    const closeRelease = deferred();
    const manager = Object.create(AnalysisWindowManager.prototype);
    manager._windows = new Map([['window-a', {}]]);
    manager._closeTasks = new Map();
    manager._activeCloseTasks = new Set();
    manager._closeAllPromise = null;
    manager.closeWindow = () => closeRelease.promise;

    const closeTask = manager.closeAll();

    assert.throws(
      () => manager._createWindow('owned', {}, {}),
      /Cannot create an analysis window while closeAll\(\) is in progress/,
    );

    closeRelease.resolve();
    await closeTask;
    assert.equal(manager._closeAllPromise, null);
  },
);

test(
  'DataLayer destroy publishes one stable task and drains memory cleanup ownership before clearing',
  async () => {
    const unregisterRelease = deferred();
    const events = [];
    const layer = Object.create(DataLayer.prototype);
    layer._destroyPromise = null;
    layer._destroyed = false;
    layer._datasetGeneration = 4;
    layer._cacheGeneration = 7;
    layer._fieldLoadLifecycle = new AbortController();
    layer._bulkGeneCacheGeneration = 9;
    layer._bulkGeneCacheReplacementOwner = {};
    layer._instanceId = 'data-layer-owned';
    layer._memoryMonitor = {
      unregisterCleanupHandler(instanceId) {
        assert.equal(instanceId, 'data-layer-owned');
        events.push('memory:unregister');
        return unregisterRelease.promise.then(() => {
          events.push('memory:drained');
        });
      },
    };
    layer._dataCache = new Map([['page', {}]]);
    layer._bulkGeneCache = new Map([['bulk', {}]]);
    layer._bulkGeneCacheAccessOrder = ['bulk'];
    layer._variableCache = new Map([['variable', {}]]);
    layer._pendingRequests = new Map([['request', {}]]);
    layer._prefetchQueue = [{}];
    layer._prefetchTimeout = null;
    layer._notifications = {};

    const first = layer.destroy();
    const repeated = layer.destroy();

    assert.equal(first, repeated);
    assert.equal(isThenable(first), true);
    assert.equal(layer._destroyed, true);
    assert.equal(layer._datasetGeneration, 5);
    assert.equal(layer._cacheGeneration, 8);
    assert.equal(layer._bulkGeneCacheGeneration, 10);
    assert.equal(layer._dataCache.size, 1);
    assert.equal(layer._memoryMonitor === null, false);

    await Promise.resolve();
    assert.deepEqual(events, ['memory:unregister']);
    assert.equal(
      layer._dataCache.size,
      1,
      'cache state remains owned while a running memory handler drains',
    );

    unregisterRelease.resolve();
    await first;

    assert.deepEqual(events, ['memory:unregister', 'memory:drained']);
    assert.equal(layer._dataCache.size, 0);
    assert.equal(layer._bulkGeneCache.size, 0);
    assert.equal(layer._pendingRequests.size, 0);
    assert.equal(layer._memoryMonitor, null);
    assert.equal(layer.destroy(), first);
  },
);

test(
  'DataLayer destroy synchronously closes prefetch admission while memory ownership drains',
  { concurrency: false },
  async () => {
    const unregisterRelease = deferred();
    const events = [];
    const timeoutToken = {};
    const restoreClearTimeout = replaceGlobal(
      'clearTimeout',
      receivedToken => {
        assert.equal(receivedToken, timeoutToken);
        events.push('prefetch:cancel');
      },
    );
    const layer = Object.create(DataLayer.prototype);
    layer._destroyPromise = null;
    layer._destroyed = false;
    layer._datasetGeneration = 0;
    layer._cacheGeneration = 0;
    layer._fieldLoadLifecycle = new AbortController();
    layer._bulkGeneCacheGeneration = 0;
    layer._bulkGeneCacheReplacementOwner = null;
    layer._instanceId = 'data-layer-prefetch-owner';
    layer._memoryMonitor = {
      unregisterCleanupHandler() {
        return unregisterRelease.promise;
      },
    };
    layer._options = { enablePrefetch: true };
    layer._dataCache = new Map();
    layer._bulkGeneCache = new Map();
    layer._bulkGeneCacheAccessOrder = [];
    layer._variableCache = new Map();
    layer._pendingRequests = new Map();
    layer._pageVersions = new Map();
    layer._prefetchQueue = [{ pageIds: ['page-a'] }];
    layer._prefetchTimeout = timeoutToken;
    layer._notifications = {};

    try {
      const destruction = layer.destroy();

      assert.deepEqual(events, ['prefetch:cancel']);
      assert.equal(layer._prefetchTimeout, null);
      assert.deepEqual(layer._prefetchQueue, []);
      assert.throws(
        () => layer.resetForDatasetReload(),
        /destroyed DataLayer/i,
      );

      layer.prefetch({ pageIds: ['page-b'] });
      await layer._processPrefetchQueue();
      assert.deepEqual(layer._prefetchQueue, []);
      assert.equal(layer._prefetchTimeout, null);

      unregisterRelease.resolve();
      await destruction;
    } finally {
      restoreClearTimeout();
    }
  },
);

test(
  'DataLayer analysis joins the shared field-load lease before a UI consumer aborts',
  async () => {
    const loaderRelease = deferred();
    let loaderCalls = 0;
    const state = createDataState({
      viewer: {},
      labelLayer: null,
    });
    state.pointCount = 2;
    const descriptor = Object.freeze({
      key: 'GENE_A',
      kind: 'continuous',
    });
    const field = {
      ...descriptor,
      loaded: false,
      _loadingPromise: null,
      _loadingSignal: null,
    };
    state.varData = { fields: [field] };
    state._varFieldDescriptors = Object.freeze([descriptor]);
    state.setVarFieldLoader(async (_ownedDescriptor, { signal }) => {
      loaderCalls++;
      assert.equal(signal instanceof AbortSignal, true);
      return loaderRelease.promise;
    });
    const layer = new DataLayer(state, {
      enableCache: false,
      enableDedup: false,
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: false,
    });
    const uiController = new AbortController();

    try {
      const uiTask = state.ensureVarFieldLoaded(0, {
        signal: uiController.signal,
        silent: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(loaderCalls, 1);

      const analysisTask = layer.ensureGeneExpressionLoaded(
        'GENE_A',
        { silent: true },
      );
      await Promise.resolve();
      uiController.abort(
        new DOMException('UI selection changed.', 'AbortError'),
      );
      loaderRelease.resolve({
        values: new Float32Array([1, 2]),
      });

      await assert.rejects(
        uiTask,
        error => error?.name === 'AbortError',
      );
      const analysis = await analysisTask;
      assert.equal(loaderCalls, 1);
      assert.deepEqual(Array.from(analysis.values), [1, 2]);
      assert.equal(field.loaded, true);
    } finally {
      loaderRelease.resolve({
        values: new Float32Array([1, 2]),
      });
      await layer.destroy();
    }
  },
);

test(
  'DataLayer destruction retires its last shared field-load lease immediately',
  async () => {
    const loaderRelease = deferred();
    let backendSignal = null;
    const state = createDataState({
      viewer: {},
      labelLayer: null,
    });
    state.pointCount = 2;
    const descriptor = Object.freeze({
      key: 'GENE_A',
      kind: 'continuous',
    });
    const field = {
      ...descriptor,
      loaded: false,
      _loadingPromise: null,
      _loadingSignal: null,
    };
    state.varData = { fields: [field] };
    state._varFieldDescriptors = Object.freeze([descriptor]);
    state.setVarFieldLoader(async (_ownedDescriptor, { signal }) => {
      backendSignal = signal;
      return loaderRelease.promise;
    });
    const layer = new DataLayer(state, {
      enableCache: false,
      enableDedup: false,
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: false,
    });
    let analysisTask = null;
    let destruction = null;

    try {
      analysisTask = layer.ensureGeneExpressionLoaded(
        'GENE_A',
        { silent: true },
      );
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(backendSignal instanceof AbortSignal, true);

      destruction = layer.destroy();
      assert.equal(
        backendSignal.aborted,
        true,
        'terminal DataLayer ownership must synchronously retire the backend lease',
      );
      await assert.rejects(
        analysisTask,
        error => error?.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED',
      );
      await destruction;
      assert.equal(field.loaded, false);
    } finally {
      loaderRelease.resolve({
        values: new Float32Array([1, 2]),
      });
      await Promise.allSettled([
        analysisTask,
        destruction ?? layer.destroy(),
      ].filter(Boolean));
    }
  },
);

test(
  'DataLayer loaded-field reads cannot resolve across terminal destruction',
  async () => {
    const field = {
      key: 'GENE_A',
      kind: 'continuous',
      loaded: true,
      values: new Float32Array([1, 2]),
    };
    const state = {
      pointCount: 2,
      varData: { fields: [field] },
    };
    const layer = new DataLayer(state, {
      enableCache: false,
      enableDedup: false,
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: false,
    });

    const read = layer.ensureGeneExpressionLoaded(
      'GENE_A',
      { silent: true },
    );
    const destruction = layer.destroy();

    await assert.rejects(
      read,
      error => error?.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED',
    );
    await destruction;
  },
);

test(
  'DataLayer loaded observation reads cannot resolve across dataset reset',
  async () => {
    const field = {
      codes: new Uint8Array([0, 0]),
      categories: ['A'],
      key: 'cell_type',
      kind: 'category',
      loaded: true,
    };
    const state = {
      obsData: { fields: [field] },
      pointCount: 2,
    };
    const layer = new DataLayer(state, {
      enableCache: false,
      enableDedup: false,
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: false,
    });

    try {
      const read = layer.ensureObsFieldLoaded(
        'cell_type',
        { silent: true },
      );
      layer.resetForDatasetReload();
      await assert.rejects(
        read,
        error => error?.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED',
      );
    } finally {
      await layer.destroy();
    }
  },
);

test(
  'DataLayer dataset reset retires its last shared field-load lease immediately',
  async () => {
    const loaderRelease = deferred();
    let backendSignal = null;
    const state = createDataState({
      viewer: {},
      labelLayer: null,
    });
    state.pointCount = 2;
    const descriptor = Object.freeze({
      key: 'GENE_A',
      kind: 'continuous',
    });
    const field = {
      ...descriptor,
      loaded: false,
      _loadingPromise: null,
      _loadingSignal: null,
    };
    state.varData = { fields: [field] };
    state._varFieldDescriptors = Object.freeze([descriptor]);
    state.setVarFieldLoader(async (_ownedDescriptor, { signal }) => {
      backendSignal = signal;
      return loaderRelease.promise;
    });
    const layer = new DataLayer(state, {
      enableCache: false,
      enableDedup: false,
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: false,
    });
    let analysisTask = null;

    try {
      analysisTask = layer.ensureGeneExpressionLoaded(
        'GENE_A',
        { silent: true },
      );
      await Promise.resolve();
      await Promise.resolve();
      layer.resetForDatasetReload();
      assert.equal(backendSignal.aborted, true);
      await assert.rejects(
        analysisTask,
        error => error?.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED',
      );
      assert.equal(field.loaded, false);
    } finally {
      loaderRelease.resolve({
        values: new Float32Array([1, 2]),
      });
      await Promise.allSettled([
        analysisTask,
        layer.destroy(),
      ].filter(Boolean));
    }
  },
);

class WindowTestElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.open = false;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    const event = {
      preventDefault() {},
      stopPropagation() {},
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, event);
    }
  }

  getBoundingClientRect() {
    return {
      height: 240,
      left: 20,
      right: 340,
      top: 40,
      width: 320,
    };
  }

  querySelector() {
    return null;
  }

  remove() {
    if (this.parentNode === null) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
}

function createWindowCreationHarness({ destroy }) {
  const floatingRoot = new WindowTestElement('div');
  const sidebar = new WindowTestElement('aside');
  const comparisonModule = {
    dataLayer: {
      getCellCountForPageId() {
        return 1;
      },
      getPages() {
        return [];
      },
    },
    multiVariableAnalysis: {},
  };
  const uiManager = {
    getTypeInfo(modeId) {
      assert.equal(modeId, 'owned');
      return {
        factory(options) {
          return {
            _container: options.container,
            destroy,
            exportSettings() {
              return {};
            },
            getSelectedPages() {
              return [];
            },
            importSettings() {},
            onHighlightChanged() {},
            onPageSelectionChange() {},
          };
        },
        factoryOptions: {},
        name: 'Owned',
      };
    },
  };
  const manager = new AnalysisWindowManager({
    comparisonModule,
    sidebar,
    uiManager,
  });
  return { floatingRoot, manager };
}

test(
  'analysis-window creation rollback awaits async UI destruction before detaching and preserves the primary failure',
  { concurrency: false },
  async () => {
    const destruction = deferred();
    const primaryFailure = new Error('exact dockable registration failure');
    const { floatingRoot, manager } = createWindowCreationHarness({
      destroy: () => destruction.promise,
    });
    const restoreWindow = replaceGlobal('window', {
      innerHeight: 900,
      innerWidth: 1440,
    });
    const restoreDocument = replaceGlobal('document', {
      createElement(tagName) {
        return new WindowTestElement(tagName);
      },
    });
    setDockableAccordions({
      floatingRoot,
      float() {},
      register() {
        throw primaryFailure;
      },
      unregister() {},
    });

    try {
      const result = manager._createWindow('owned', {}, {});
      assert.equal(isThenable(result), true);
      assert.equal(floatingRoot.children.length, 1);

      destruction.resolve();
      await assert.rejects(result, error => error === primaryFailure);
      assert.equal(floatingRoot.children.length, 0);
    } finally {
      setDockableAccordions(null);
      restoreDocument();
      restoreWindow();
    }
  },
);

test(
  'AnalysisWindowManager closeAll drains an in-flight failed-creation rollback',
  { concurrency: false },
  async () => {
    const destruction = deferred();
    const primaryFailure = new Error('exact creation barrier failure');
    const { floatingRoot, manager } = createWindowCreationHarness({
      destroy: () => destruction.promise,
    });
    const restoreWindow = replaceGlobal('window', {
      innerHeight: 900,
      innerWidth: 1440,
    });
    const restoreDocument = replaceGlobal('document', {
      createElement(tagName) {
        return new WindowTestElement(tagName);
      },
    });
    setDockableAccordions({
      floatingRoot,
      float() {},
      register() {
        throw primaryFailure;
      },
      unregister() {},
    });

    try {
      const creationTask = manager._createWindow('owned', {}, {});
      const closeTask = manager.closeAll();
      let closeSettled = false;
      void closeTask.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );

      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        closeSettled,
        false,
        'closeAll must retain the failed UI rollback before shared data can retire',
      );

      destruction.resolve();
      await assert.rejects(
        creationTask,
        error => error === primaryFailure,
      );
      await assert.rejects(
        closeTask,
        error => (
          error === primaryFailure ||
          (
            error instanceof AggregateError &&
            error.errors.includes(primaryFailure)
          )
        ),
      );
      assert.equal(floatingRoot.children.length, 0);
    } finally {
      setDockableAccordions(null);
      restoreDocument();
      restoreWindow();
    }
  },
);

test(
  'analysis-window close-button events observe and report async close rejection',
  { concurrency: false },
  async () => {
    const exactFailure = new Error('exact close-button rejection');
    const rejectedClose = Promise.reject(exactFailure);
    rejectedClose.catch(() => {});
    const { floatingRoot, manager } = createWindowCreationHarness({
      destroy() {},
    });
    const restoreWindow = replaceGlobal('window', {
      innerHeight: 900,
      innerWidth: 1440,
    });
    const restoreDocument = replaceGlobal('document', {
      createElement(tagName) {
        return new WindowTestElement(tagName);
      },
    });
    setDockableAccordions({
      floatingRoot,
      float() {},
      register() {},
      unregister() {},
    });
    const reported = [];
    const originalConsoleError = console.error;
    console.error = (...args) => {
      reported.push(args);
    };

    try {
      const windowId = manager._createWindow('owned', {}, {});
      assert.equal(typeof windowId, 'string');
      const details = floatingRoot.children[0];
      const summary = details.children[0];
      const closeButton = summary.children[3];
      manager.closeWindow = receivedId => {
        assert.equal(receivedId, windowId);
        return rejectedClose;
      };

      closeButton.dispatch('click');
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(reported.length, 1);
      assert.equal(reported[0][1], exactFailure);
    } finally {
      console.error = originalConsoleError;
      setDockableAccordions(null);
      restoreDocument();
      restoreWindow();
    }
  },
);

test(
  'ComparisonModule destroy synchronously detaches its shared state subscriptions',
  async () => {
    const state = new EventEmitter();
    const comparison = Object.create(ComparisonModule.prototype);
    let highlightChanges = 0;
    let pageChanges = 0;
    comparison.state = state;
    comparison._stateUnsubscribers = [];
    comparison.onPagesChanged = () => {
      pageChanges++;
    };
    comparison.onHighlightChanged = () => {
      highlightChanges++;
    };
    comparison._subscribeToStateChanges();
    assert.equal(state.listenerCount('page:changed'), 1);
    assert.equal(state.listenerCount('highlight:changed'), 1);

    state.emit('page:changed');
    state.emit('highlight:changed');
    assert.deepEqual({ highlightChanges, pageChanges }, {
      highlightChanges: 1,
      pageChanges: 1
    });

    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._memoryMonitor = null;
    comparison._analysisWindowManager = null;
    comparison._uiManager = null;
    comparison.dataLayer = null;
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};

    const destruction = comparison.destroy();
    assert.equal(state.listenerCount('page:changed'), 0);
    assert.equal(state.listenerCount('highlight:changed'), 0);
    assert.doesNotThrow(() => {
      state.emit('page:changed');
      state.emit('highlight:changed');
    });
    assert.deepEqual({ highlightChanges, pageChanges }, {
      highlightChanges: 1,
      pageChanges: 1
    });
    assert.equal(comparison.destroy(), destruction);
    await destruction;
  }
);

test(
  'ComparisonModule destroy drains owned managers before releasing shared data',
  async () => {
    const windowsDestruction = deferred();
    const embeddedDestruction = deferred();
    let dataLayerDestroyed = false;
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._memoryMonitor = {
      unregisterCleanupHandler() {},
    };
    comparison._analysisWindowManager = {
      closeAll() {
        return windowsDestruction.promise;
      },
    };
    comparison._uiManager = {
      destroy() {
        return embeddedDestruction.promise;
      },
    };
    comparison.dataLayer = {
      destroy() {
        dataLayerDestroyed = true;
      },
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};

    const result = comparison.destroy();
    const dataDestroyedBeforeChildrenSettled = dataLayerDestroyed;

    windowsDestruction.resolve();
    embeddedDestruction.resolve();
    await Promise.resolve(result);

    assert.equal(isThenable(result), true);
    assert.equal(dataDestroyedBeforeChildrenSettled, false);
    assert.equal(dataLayerDestroyed, true);
    assert.equal(comparison.dataLayer, null);
  },
);

test(
  'ComparisonModule destroy drains its running memory handler before retiring managers or shared data',
  async () => {
    const memoryDrain = deferred();
    const events = [];
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._memoryMonitor = {
      unregisterCleanupHandler(componentId) {
        assert.equal(componentId, 'comparison-module');
        events.push('memory:unregister');
        return memoryDrain.promise.then(() => {
          events.push('memory:drained');
        });
      },
    };
    comparison._analysisWindowManager = {
      closeAll() {
        events.push('windows:destroy');
      },
    };
    comparison._uiManager = {
      destroy() {
        events.push('embedded:destroy');
      },
    };
    comparison.dataLayer = {
      destroy() {
        events.push('data:destroy');
      },
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};

    const destroyTask = comparison.destroy();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(events, ['memory:unregister']);

    memoryDrain.resolve();
    await destroyTask;

    assert.deepEqual(events, [
      'memory:unregister',
      'memory:drained',
      'windows:destroy',
      'embedded:destroy',
      'data:destroy',
    ]);
  },
);

test(
  'dataset reload waits for window and embedded UI teardown before resetting shared data',
  async () => {
    const windowsDestruction = deferred();
    const embeddedDestruction = deferred();
    const events = [];
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._analysisWindowManager = {
      closeAll() {
        events.push('windows:start');
        return windowsDestruction.promise.then(() => {
          events.push('windows:done');
        });
      },
    };
    comparison._modeToggleContainer = null;
    comparison._analysisMode = 'detailed';
    comparison._uiManager = {
      clearActiveMode() {
        events.push('active:clear');
      },
      reset() {
        events.push('embedded:start');
        return embeddedDestruction.promise.then(() => {
          events.push('embedded:done');
        });
      },
    };
    comparison.dataLayer = {
      resetForDatasetReload() {
        events.push('data:reset');
      },
    };
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};
    comparison._datasetReloadResetCount = 0;
    comparison.onPagesChanged = () => {
      events.push('pages:publish');
    };

    const result = comparison.resetForDatasetReload({
      reason: 'teardown-ownership-test',
    });
    const dataResetBeforeChildrenSettled = events.includes('data:reset');

    windowsDestruction.resolve();
    embeddedDestruction.resolve();
    await Promise.resolve(result);

    assert.equal(isThenable(result), true);
    assert.equal(dataResetBeforeChildrenSettled, false);
    assert.ok(events.indexOf('windows:done') < events.indexOf('data:reset'));
    assert.ok(events.indexOf('embedded:done') < events.indexOf('data:reset'));
    assert.ok(events.indexOf('data:reset') < events.indexOf('pages:publish'));
  },
);

test(
  'ComparisonModule destroy drains an in-flight dataset reset before destroying shared data',
  async () => {
    const resetRelease = deferred();
    const events = [];
    let resetInFlight = false;
    let destroyedDuringReset = false;
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._memoryMonitor = {
      unregisterCleanupHandler() {},
    };
    comparison._analysisWindowManager = {
      closeAll() {},
    };
    comparison._modeToggleContainer = null;
    comparison._analysisMode = 'detailed';
    comparison._uiManager = {
      clearActiveMode() {},
      reset() {},
      destroy() {},
    };
    comparison.dataLayer = {
      async resetForDatasetReload() {
        resetInFlight = true;
        events.push('data:reset:start');
        await resetRelease.promise;
        events.push('data:reset:done');
        resetInFlight = false;
      },
      destroy() {
        destroyedDuringReset = resetInFlight;
        events.push('data:destroy');
      },
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};
    comparison._datasetReloadResetCount = 0;
    comparison.onPagesChanged = () => {
      events.push('pages:publish');
    };

    const resetTask = comparison.resetForDatasetReload({
      reason: 'destroy-race-test',
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resetInFlight, true);

    const destroyTask = comparison.destroy();
    assert.equal(
      comparison.destroy(),
      destroyTask,
      'terminal destruction must retain one stable owned task',
    );
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      events.includes('data:destroy'),
      false,
      'shared data must remain alive while its reset is in flight',
    );

    resetRelease.resolve();
    await resetTask;
    await destroyTask;

    assert.equal(destroyedDuringReset, false);
    assert.ok(
      events.indexOf('data:reset:done') < events.indexOf('data:destroy'),
    );
    assert.ok(events.indexOf('pages:publish') < events.indexOf('data:destroy'));
    assert.equal(comparison.dataLayer, null);
  },
);

test(
  'ComparisonModule publishes reset ownership before a child callback can reenter destroy',
  async () => {
    const resetRelease = deferred();
    const events = [];
    let destroyTask = null;
    let closeCalls = 0;
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._memoryMonitor = null;
    comparison._modeToggleContainer = null;
    comparison._analysisMode = 'detailed';
    comparison._analysisWindowManager = {
      closeAll() {
        closeCalls++;
        events.push(`windows:close:${closeCalls}`);
        if (destroyTask === null) {
          destroyTask = comparison.destroy();
        }
      },
    };
    comparison._uiManager = {
      clearActiveMode() {
        events.push('ui:clear');
      },
      async reset() {
        events.push('ui:reset:start');
        await resetRelease.promise;
        events.push('ui:reset:done');
      },
      destroy() {
        events.push('ui:destroy');
      },
    };
    comparison.dataLayer = {
      resetForDatasetReload() {
        events.push('data:reset');
      },
      destroy() {
        events.push('data:destroy');
      },
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};
    comparison._datasetReloadResetCount = 0;
    comparison.onPagesChanged = () => {
      events.push('pages:publish');
    };

    const resetTask = comparison.resetForDatasetReload({
      reason: 'reentrant-destroy-ownership-test',
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(destroyTask);
    assert.equal(events.includes('ui:destroy'), false);
    assert.equal(events.includes('data:destroy'), false);

    resetRelease.resolve();
    await resetTask;
    await destroyTask;

    const resetDone = events.indexOf('ui:reset:done');
    const dataReset = events.indexOf('data:reset');
    const pagesPublish = events.indexOf('pages:publish');
    assert.ok(resetDone >= 0);
    assert.ok(dataReset > resetDone);
    assert.ok(pagesPublish > dataReset);
    assert.ok(events.indexOf('ui:destroy') > pagesPublish);
    assert.ok(events.indexOf('data:destroy') > pagesPublish);
  },
);

test(
  'AnalysisWindowManager blocks creation for the full Comparison reset lifetime',
  () => {
    const resetOwner = deferred();
    const manager = Object.create(AnalysisWindowManager.prototype);
    manager._comparisonModule = {
      _datasetResetPromise: resetOwner.promise,
      _destroyPromise: null,
    };
    manager._closeAllPromise = null;
    manager._windows = new Map();
    manager._activeCreationTasks = new Set();
    manager._closeTasks = new Map();
    manager._activeCloseTasks = new Set();

    assert.throws(
      () => manager._createWindow('simple', {}),
      /dataset reset is in progress/i,
    );
  },
);

test(
  'ComparisonModule completes an in-flight dataset reset before destroying its managers',
  async () => {
    const resetRelease = deferred();
    const events = [];
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = resetRelease.promise.then(() => {
      events.push('reset:done');
    });
    comparison._memoryMonitor = {
      unregisterCleanupHandler() {},
    };
    comparison._analysisWindowManager = {
      closeAll() {
        events.push('windows:destroy');
      },
    };
    comparison._uiManager = {
      destroy() {
        events.push('embedded:destroy');
      },
    };
    comparison.dataLayer = {
      destroy() {
        events.push('data:destroy');
      },
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [];
    comparison._lastStatResultsTimestamp = null;
    comparison._currentPageData = null;

    const destroyTask = comparison.destroy();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      events,
      [],
      'reset-owned managers must remain alive until reset completion',
    );

    resetRelease.resolve();
    await destroyTask;

    assert.deepEqual(events, [
      'reset:done',
      'windows:destroy',
      'embedded:destroy',
      'data:destroy',
    ]);
  },
);

test(
  'ComparisonModule destroy preserves an in-flight dataset reset failure while still releasing shared data',
  async () => {
    const resetRelease = deferred();
    const resetFailure = new Error('exact in-flight dataset reset failure');
    let dataLayerDestroyed = false;
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._memoryMonitor = {
      unregisterCleanupHandler() {},
    };
    comparison._analysisWindowManager = null;
    comparison._modeToggleContainer = null;
    comparison._analysisMode = 'detailed';
    comparison._uiManager = null;
    comparison.dataLayer = {
      async resetForDatasetReload() {
        await resetRelease.promise;
        throw resetFailure;
      },
      destroy() {
        dataLayerDestroyed = true;
      },
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};
    comparison._datasetReloadResetCount = 0;
    comparison.onPagesChanged = () => {};

    const resetTask = comparison.resetForDatasetReload({
      reason: 'destroy-race-failure-test',
    });
    await Promise.resolve();
    await Promise.resolve();
    const destroyTask = comparison.destroy();

    resetRelease.resolve();
    await assert.rejects(resetTask, error => error === resetFailure);
    await assert.rejects(destroyTask, error => error === resetFailure);

    assert.equal(dataLayerDestroyed, true);
    assert.equal(comparison.dataLayer, null);
  },
);

test(
  'failed dataset reset does not publish a successful reset diagnostic',
  async () => {
    const resetFailure = new Error('exact dataset reset failure');
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._analysisWindowManager = null;
    comparison._modeToggleContainer = null;
    comparison._analysisMode = 'detailed';
    comparison._uiManager = null;
    comparison.dataLayer = {
      resetForDatasetReload() {
        throw resetFailure;
      },
    };
    comparison._multiVariableAnalysis = {};
    comparison._lastStatResults = [{}];
    comparison._lastStatResultsTimestamp = 1;
    comparison._currentPageData = {};
    comparison._datasetReloadResetCount = 4;
    comparison._lastDatasetReloadReset = {
      at: 123,
      reason: 'previous-success',
    };
    let pagePublications = 0;
    comparison.onPagesChanged = () => {
      pagePublications++;
    };

    await assert.rejects(
      comparison.resetForDatasetReload({
        reason: 'failing-reset',
      }),
      error => error === resetFailure,
    );

    assert.equal(pagePublications, 1);
    assert.equal(comparison._datasetReloadResetCount, 4);
    assert.deepEqual(comparison._lastDatasetReloadReset, {
      at: 123,
      reason: 'previous-success',
    });
  },
);

test(
  'ComparisonModule rejects dataset reset synchronously once destruction is owned',
  async () => {
    const managerDestruction = deferred();
    let dataLayerReset = false;
    const comparison = Object.create(ComparisonModule.prototype);
    comparison._destroyPromise = null;
    comparison._datasetResetPromise = null;
    comparison._memoryMonitor = null;
    comparison._analysisWindowManager = {
      closeAll() {
        return managerDestruction.promise;
      },
    };
    comparison._modeToggleContainer = null;
    comparison._uiManager = null;
    comparison.dataLayer = {
      resetForDatasetReload() {
        dataLayerReset = true;
      },
      destroy() {},
    };
    comparison._hooks = { beforeRender: [], afterRender: [] };
    comparison.layoutEngine = {};
    comparison.transformPipeline = {};
    comparison._multiVariableAnalysis = null;
    comparison._lastStatResults = [];
    comparison._lastStatResultsTimestamp = null;
    comparison._currentPageData = null;
    comparison._datasetReloadResetCount = 0;
    comparison.onPagesChanged = () => {};

    const destroyTask = comparison.destroy();
    assert.throws(
      () => comparison.resetForDatasetReload({
        reason: 'post-destroy-reset-test',
      }),
      /Cannot reset a destroyed ComparisonModule/,
    );
    assert.equal(dataLayerReset, false);

    managerDestruction.resolve();
    await destroyTask;
  },
);

test(
  'analysis-window session restore awaits prior window teardown before creating replacements',
  async () => {
    const destruction = deferred();
    const events = [];
    const manager = {
      closeAll() {
        events.push('close:start');
        return destruction.promise.then(() => {
          events.push('close:done');
        });
      },
      createFromSessionDescriptor(descriptor) {
        events.push(`create:${descriptor.modeId}`);
      },
    };

    const result = restoreAnalysisWindows(
      { analysisWindowManager: manager },
      {},
      { windows: [{ modeId: 'replacement' }] },
    );
    const createdBeforeCloseSettled = events.includes('create:replacement');

    destruction.resolve();
    await Promise.resolve(result);

    assert.equal(isThenable(result), true);
    assert.equal(createdBeforeCloseSettled, false);
    assert.deepEqual(events, [
      'close:start',
      'close:done',
      'create:replacement',
    ]);
  },
);

function createPlotHost() {
  let serial = 0;
  return {
    bounds: { width: 640, height: 480 },
    children: [],
    isConnected: true,
    ownerDocument: {
      createElement(tagName) {
        return {
          tagName: tagName.toUpperCase(),
          serial: ++serial,
          className: 'analysis-preview-plot',
          style: {},
          attributes: new Map(),
          isConnected: false,
          parentNode: null,
          setAttribute(name, value) {
            this.attributes.set(name, value);
          },
          removeAttribute(name) {
            this.attributes.delete(name);
          },
          remove() {
            if (this.parentNode) {
              const index = this.parentNode.children.indexOf(this);
              if (index >= 0) this.parentNode.children.splice(index, 1);
            }
            this.parentNode = null;
            this.isConnected = false;
          },
        };
      },
    },
    append(candidate) {
      this.children.push(candidate);
      candidate.parentNode = this;
      candidate.isConnected = this.isConnected;
    },
    getBoundingClientRect() {
      return { ...this.bounds };
    },
  };
}

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
  return () => {
    if (descriptor === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

test(
  'memory-pressure cleanup never purges a DOM-discovered candidate while its slot render is running',
  { concurrency: false },
  async () => {
    const renderGate = deferred();
    const host = createPlotHost();
    const slot = new PlotRenderSlot({
      host,
      render: async () => {
        await renderGate.promise;
        return { rendered: true };
      },
      purge: () => {},
    });
    const renderTask = slot.render({ name: 'running-preview' });
    await Promise.resolve();
    assert.equal(host.children.length, 1);

    const directPurges = [];
    const restoreStorage = replaceGlobal('localStorage', {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    });
    const restoreWindow = replaceGlobal('window', {
      location: { href: 'https://cellucid.test/' },
      Plotly: {
        purge(candidate) {
          directPurges.push(candidate);
        },
      },
    });
    const restoreDocument = replaceGlobal('document', {
      querySelectorAll(selector) {
        if (selector === '.analysis-modal') return [];
        if (selector === '.analysis-preview-plot') return [...host.children];
        return [];
      },
    });

    const state = {
      getHighlightPages() {
        return [];
      },
      obsData: { fields: [] },
      pointCount: 0,
      varData: { fields: [] },
    };
    let comparison = null;
    let dataLayer = null;
    const memoryMonitor = getMemoryMonitor();
    memoryMonitor.setShowNotifications(false);
    try {
      comparison = new ComparisonModule({ state, container: {} });
      dataLayer = comparison.dataLayer;

      await memoryMonitor.performCleanup('critical');

      assert.deepEqual(
        directPurges,
        [],
        'a DOM sweep bypasses the slot generation and purge owner',
      );
    } finally {
      renderGate.resolve();
      await renderTask;
      await slot.destroy();
      if (comparison !== null) {
        await Promise.resolve(comparison.destroy());
      }
      if (dataLayer !== null && dataLayer._destroyed !== true) {
        dataLayer.destroy();
      }
      memoryMonitor.setShowNotifications(true);
      restoreDocument();
      restoreWindow();
      restoreStorage();
    }
  },
);
