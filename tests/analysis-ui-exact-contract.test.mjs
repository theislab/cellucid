import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AnalysisUIManager } from '../assets/js/app/analysis/ui/analysis-ui-manager.js';
import { AnalysisWindowManager } from '../assets/js/app/analysis/ui/analysis-window-manager.js';
import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';
import { PlotRegistry } from '../assets/js/app/analysis/shared/plot-registry-utils.js';
import {
  PAGE_MODE,
  PageSelectorComponent,
} from '../assets/js/app/analysis/ui/shared/page-selector.js';
import {
  setDockableAccordions,
} from '../assets/js/app/dockable-accordions-registry.js';
import scatterPlotDefinition from '../assets/js/app/analysis/plots/types/scatterplot.js';
import volcanoPlotDefinition from '../assets/js/app/analysis/plots/types/volcanoplot.js';
import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { createRequestIdTracker } from '../assets/js/app/analysis/shared/cancellable-operation.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import {
  capture as captureAnalysisWindows,
  restore as restoreAnalysisWindows,
} from '../assets/js/app/session/contributors/analysis-windows.js';
import { SessionSerializer } from '../assets/js/app/session/session-serializer.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { ComparisonModule } from '../assets/js/app/analysis/comparison-module.js';
import { createPageComparisonSelector } from '../assets/js/app/analysis/ui/components/selectors.js';
import {
  deResultsToCSV,
  toCSV,
} from '../assets/js/app/analysis/shared/analysis-utils.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function instrumentRejectionObservers(task) {
  let count = 0;
  const originalThen = task.then.bind(task);
  const originalCatch = task.catch.bind(task);
  task.then = (onFulfilled, onRejected) => {
    if (typeof onRejected === 'function') count++;
    return originalThen(onFulfilled, onRejected);
  };
  task.catch = onRejected => {
    if (typeof onRejected === 'function') count++;
    return originalCatch(onRejected);
  };
  return () => count;
}

function baseSettingsHarness() {
  const ui = Object.create(BaseAnalysisUI.prototype);
  ui.dataLayer = {
    getPages() {
      return [{ id: 'page-a', name: 'Page A' }];
    },
    getCellCountForPageId() {
      return 1;
    },
  };
  ui._pageSelector = null;
  ui._selectedPages = ['page-a'];
  ui._currentConfig = {
    dataSource: {
      type: 'continuous_obs',
      variable: 'score',
    },
    pages: ['page-a'],
    plotType: 'boxplot',
    plotOptions: {},
  };
  ui._renderControls = () => {};
  ui._scheduleUpdate = () => {};
  return ui;
}

test('BaseAnalysisUI settings are exact, cloneable, and internally consistent', () => {
  const ui = baseSettingsHarness();
  ui._currentConfig.plotOptions.formatter = () => 'not cloneable';

  assert.throws(
    () => ui.exportSettings(),
    /could not be cloned|clone/i,
    'uncloneable settings must not be serialized through a lossy alternate format',
  );

  delete ui._currentConfig.plotOptions.formatter;
  const originalPages = [...ui._selectedPages];
  const originalConfig = structuredClone(ui._currentConfig);

  assert.throws(
    () => ui.importSettings({
      selectedPages: ['page-a'],
      config: {
        ...structuredClone(ui._currentConfig),
        pages: ['page-b'],
      },
    }),
    /selectedPages.*config\.pages|config\.pages.*selectedPages/i,
  );
  assert.deepEqual(ui._selectedPages, originalPages);
  assert.deepEqual(ui._currentConfig, originalConfig);

  assert.throws(
    () => ui.importSettings(null),
    /settings must be an object/i,
  );
});

test('FormBasedAnalysisUI imports one complete exact settings schema', () => {
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui.onPageSelectionChange = () => {
    throw new Error('invalid settings must be rejected before mutation');
  };
  ui._applyNamedFormControls = () => {
    throw new Error('invalid settings must be rejected before mutation');
  };

  assert.throws(
    () => ui.importSettings(null),
    /form-based analysis settings must be an object/i,
  );
  assert.throws(
    () => ui.importSettings({
      selectedPages: ['page-a'],
      formControls: {},
      legacyMode: true,
    }),
    /exactly.*formControls.*selectedPages/i,
  );
  assert.throws(
    () => ui.importSettings({
      selectedPages: ['page-a'],
    }),
    /exactly.*formControls.*selectedPages/i,
  );
  assert.throws(
    () => ui.importSettings({
      selectedPages: ['page-a'],
      formControls: {
        method: {
          type: 'checkbox',
          value: 'true',
        },
      },
    }),
    /checkbox.*boolean/i,
  );
});

test('PageSelectorComponent imports one exact current state schema', () => {
  const selector = Object.create(PageSelectorComponent.prototype);
  selector.supportsDynamicMode = true;
  selector._isDynamicMode = true;
  selector._selectedPages = new Set();
  selector.customColors = new Map();
  selector._basePages = [];
  selector.container = null;
  selector.dataLayer = {
    getPages() {
      return [
        { id: 'page-a', name: 'Page A' },
        { id: 'page-b', name: 'Page B' },
      ];
    },
    getCellIndicesForPage() {
      return new Uint32Array([0]);
    },
  };

  assert.throws(
    () => selector.importState({
      mode: 'automatic',
      selectedPages: ['page-a'],
      customColors: [],
    }),
    /mode.*dynamic.*manual/i,
  );

  assert.throws(
    () => selector.importState({
      mode: PAGE_MODE.MANUAL,
      selectedPages: ['missing-page'],
      customColors: [],
    }),
    /page.*missing-page.*not found/i,
  );

  assert.throws(
    () => selector.importState({
      mode: PAGE_MODE.MANUAL,
      selectedPages: ['page-a'],
      customColors: [
        ['page-a', '#112233'],
        ['page-a', '#445566'],
      ],
    }),
    /page-a.*more than one custom color/i,
  );
});

test('PageSelectorComponent disables zero-cell pages and defaults to a non-empty derived page', async () => {
  await withFakeDOM(() => {
    const container = new FakeElement('div');
    const selector = new PageSelectorComponent({
      dataLayer: {
        getPages() {
          return [{ id: 'page_1', name: 'Page 1' }];
        },
        getPageColor() {
          return '#336699';
        },
      },
      container,
      includeDerivedPages: true,
      getCellCountForPageId(pageId) {
        return pageId === 'page_1' ? 0 : 561_947;
      },
    });

    assert.deepEqual(
      selector.getSelectedPages(),
      ['restof__page_1'],
      'fresh analysis must select the non-empty Rest page when every base page is empty',
    );

    const tabs = [];
    const visit = element => {
      if (element.dataset?.pageId) tabs.push(element);
      for (const child of element.children) visit(child);
    };
    visit(container);
    const emptyTab = tabs.find(tab => tab.dataset.pageId === 'page_1');
    const restTab = tabs.find(tab => tab.dataset.pageId === 'restof__page_1');
    assert.ok(emptyTab.className.includes('disabled'));
    assert.equal(emptyTab.attributes.get('aria-disabled'), 'true');
    assert.equal(emptyTab.className.includes('selected'), false);
    assert.ok(restTab.className.includes('selected'));

    assert.throws(
      () => selector.setSelectedPages(['page_1']),
      /page_1.*zero cells.*cannot be selected/i,
    );
  });
});

test('ComparisonModule never publishes a zero-cell page as selected', () => {
  let publishedPages = null;
  const comparison = Object.create(ComparisonModule.prototype);
  comparison.dataLayer = {
    getPages() {
      return [{ id: 'page_1', name: 'Page 1' }];
    },
    getCellCountForPageId() {
      return 0;
    },
  };
  comparison._lastKnownPageIds = ['page_1'];
  comparison._lastKnownSelectablePageIds = [];
  comparison.currentConfig = { pages: ['page_1'] };
  comparison._uiManager = {
    getCurrentPages() {
      return ['page_1'];
    },
    onPageSelectionChange(pageIds) {
      publishedPages = [...pageIds];
    },
  };
  comparison._analysisWindowManager = {
    onPagesChanged() {},
  };

  comparison.onPagesChanged();

  assert.deepEqual(comparison.currentConfig.pages, []);
  assert.deepEqual(publishedPages, []);
});

test('AnalysisUIManager rejects an explicit zero-cell page selection', () => {
  const manager = new AnalysisUIManager({
    containerMap: {},
    comparisonModule: { multiVariableAnalysis: {} },
    dataLayer: {
      getPages() {
        return [{ id: 'page_1', name: 'Page 1' }];
      },
      getCellCountForPageId() {
        return 0;
      },
    },
  });

  assert.throws(
    () => manager.setCurrentPages(['page_1']),
    /page_1.*zero cells.*cannot be selected/i,
  );
  assert.deepEqual(manager.getCurrentPages(), []);
});

test('DE page comparison never constructs a pair from a zero-cell page', async () => {
  await withFakeDOM(() => {
    const changes = [];
    const selector = createPageComparisonSelector({
      pages: [{ id: 'page_1', name: 'Page 1' }],
      selectedIds: [],
      includeDerivedPages: true,
      getCellCountForPageId(pageId) {
        return pageId === 'page_1' ? 0 : 561_947;
      },
      onChange(pageIds) {
        changes.push([...pageIds]);
      },
    });

    assert.deepEqual(
      selector._getSelection(),
      [],
      'DE requires two non-empty groups and must not pair Page 1 (0) with Rest',
    );
    assert.deepEqual(changes, []);

    assert.throws(
      () => createPageComparisonSelector({
        pages: [{ id: 'page_1', name: 'Page 1' }],
        selectedIds: ['page_1', 'restof__page_1'],
        includeDerivedPages: true,
        getCellCountForPageId(pageId) {
          return pageId === 'page_1' ? 0 : 561_947;
        },
        onChange() {},
      }),
      /page_1.*zero cells.*cannot be selected/i,
    );
  });
});

test('AnalysisUIManager accepts only factories that return a fully initialized UI', () => {
  const container = {
    classList: { add() {} },
    remove() {},
  };
  let initCalls = 0;
  const manager = new AnalysisUIManager({
    containerMap: { exact: container },
    dataLayer: {},
    comparisonModule: { multiVariableAnalysis: {} },
  });
  manager.register({
    id: 'exact',
    name: 'Exact',
    factory() {
      return {
        _container: null,
        init(receivedContainer) {
          initCalls += 1;
          this._container = receivedContainer;
        },
      };
    },
  });
  manager.initContainers();

  assert.throws(
    () => manager.getUI('exact'),
    /factory.*fully initialized|fully initialized.*factory/i,
  );
  assert.equal(initCalls, 0, 'the manager must not probe or repair factory initialization');
});

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  remove(...values) {
    for (const value of values) this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value) {
    this.values.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? '';
  }

  removeProperty(name) {
    this.values.delete(name);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.open = false;
    this.removed = false;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError(`Event listener for "${type}" must be a function`);
    }
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    const event = {
      preventDefault() {},
      stopPropagation() {},
      target: this,
      currentTarget: this,
    };
    for (const listener of this.listeners.get('click') ?? []) {
      listener.call(this, event);
    }
  }

  querySelector() {
    return null;
  }

  getBoundingClientRect() {
    return {
      left: 40,
      top: 50,
      right: 360,
      bottom: 290,
      width: 320,
      height: 240,
    };
  }

  remove() {
    this.removed = true;
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
  }
}

async function withFakeDOM(run) {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const body = new FakeElement('body');
  globalThis.HTMLElement = FakeElement;
  globalThis.window = {
    innerWidth: 1440,
    innerHeight: 900,
  };
  globalThis.getComputedStyle = element => ({
    getPropertyValue(name) {
      return element.style.getPropertyValue(name);
    },
  });
  globalThis.document = {
    body,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    getElementById() {
      return null;
    },
  };

  try {
    return await run({ body });
  } finally {
    setDockableAccordions(null);
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test('Form plot-option events observe and drain work while direct callers retain the exact render task', { concurrency: false }, async () => {
  await withFakeDOM(async () => {
    const directRender = deferred();
    const eventRender = deferred();
    const rejectionObserverCount = instrumentRejectionObservers(
      eventRender.promise,
    );
    const ui = new FormBasedAnalysisUI({
      comparisonModule: {},
      dataLayer: {},
    });
    ui._lastResult = {
      data: {},
      options: { enabled: false },
      plotType: 'probe',
    };
    let rerenderCalls = 0;
    ui._rerenderAfterOptionChange = () => {
      rerenderCalls++;
      return rerenderCalls === 1
        ? directRender.promise
        : eventRender.promise;
    };

    const directTask = ui._handlePlotOptionChange('enabled', false);
    assert.equal(
      directTask,
      directRender.promise,
      'the callable owner must preserve its exact render task',
    );
    directRender.resolve();
    await directTask;

    const plotDefinition = {
      defaultOptions: { enabled: false },
      optionSchema: {
        enabled: {
          label: 'Enabled',
          type: 'checkbox',
        },
      },
    };
    const originalGet = PlotRegistry.get;
    const originalGetVisibleOptions = PlotRegistry.getVisibleOptions;
    PlotRegistry.get = () => plotDefinition;
    PlotRegistry.getVisibleOptions = () => plotDefinition.optionSchema;
    try {
      const optionsContainer = new FakeElement('div');
      ui._renderModalOptions(optionsContainer);
      const checkbox = optionsContainer.children[0]?.children[0] ?? null;
      assert.equal(
        checkbox?.tagName,
        'INPUT',
        'the real options renderer must wire its checkbox',
      );
      checkbox.checked = true;
      for (const listener of checkbox.listeners.get('change') ?? []) {
        listener.call(checkbox, { target: checkbox });
      }
      await Promise.resolve();

      const observedBeforeDestroy = rejectionObserverCount() > 0;
      let destroySettled = false;
      const destroying = ui.destroy();
      void destroying.then(
        () => {
          destroySettled = true;
        },
        () => {
          destroySettled = true;
        },
      );
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      const settledBeforeEventRender = destroySettled;

      eventRender.resolve();
      await destroying;

      assert.deepEqual({
        observedBeforeDestroy,
        rerenderCalls,
        settledBeforeEventRender,
      }, {
        observedBeforeDestroy: true,
        rerenderCalls: 2,
        settledBeforeEventRender: false,
      });
    } finally {
      PlotRegistry.get = originalGet;
      PlotRegistry.getVisibleOptions = originalGetVisibleOptions;
    }
  });
});

test('Form preview expand events observe failures and destruction drains the active modal-open task', { concurrency: false }, async () => {
  await withFakeDOM(async () => {
    const openTask = deferred();
    const rejectionObserverCount = instrumentRejectionObservers(
      openTask.promise,
    );
    const ui = new FormBasedAnalysisUI({
      comparisonModule: {},
      dataLayer: {},
    });
    ui._resultContainer = new FakeElement('div');
    ui._createOwnedPlotSlot = () => ({
      destroy() {
        return Promise.resolve();
      },
    });
    let openCalls = 0;
    ui._openExpandedView = () => {
      openCalls++;
      return openTask.promise;
    };

    await ui._ensurePreviewPlotSlot({
      clickable: true,
      containerId: 'event-owner-preview',
    });
    const preview = ui._resultContainer.children[0];
    preview.click();
    await Promise.resolve();

    const observedBeforeDestroy = rejectionObserverCount() > 0;
    let destroySettled = false;
    const destroying = ui.destroy();
    void destroying.then(
      () => {
        destroySettled = true;
      },
      () => {
        destroySettled = true;
      },
    );
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    const settledBeforeOpenTask = destroySettled;

    openTask.resolve();
    await destroying;

    assert.deepEqual({
      observedBeforeDestroy,
      openCalls,
      settledBeforeOpenTask,
    }, {
      observedBeforeDestroy: true,
      openCalls: 1,
      settledBeforeOpenTask: false,
    });
  });
});

function createWindowManagerHarness() {
  const pages = [{ id: 'page-a', name: 'Page A' }];
  const comparisonModule = {
    dataLayer: {
      getPages() {
        return pages;
      },
      getCellCountForPageId() {
        return 1;
      },
    },
    multiVariableAnalysis: {},
  };
  const settings = {
    selectedPages: ['page-a'],
    config: {
      dataSource: {
        type: 'continuous_obs',
        variable: 'score',
      },
      pages: ['page-a'],
      plotType: 'boxplot',
      plotOptions: {},
    },
  };
  const originUi = {
    exportSettings() {
      return structuredClone(settings);
    },
  };
  const uiManager = {
    getUI(modeId) {
      assert.equal(modeId, 'exact');
      return originUi;
    },
    getTypeInfo(modeId) {
      assert.equal(modeId, 'exact');
      return {
        id: 'exact',
        name: 'Exact',
        tooltip: 'Exact analysis',
        factoryOptions: {},
        factory(options) {
          return {
            _container: options.container,
            importedSettings: null,
            importSettings(receivedSettings) {
              this.importedSettings = receivedSettings;
            },
            exportSettings() {
              return structuredClone(this.importedSettings);
            },
            getSelectedPages() {
              return [...this.importedSettings.selectedPages];
            },
            onPageSelectionChange() {},
            onHighlightChanged() {},
            destroy() {},
          };
        },
      };
    },
  };
  const sidebar = new FakeElement('aside');
  return {
    manager: new AnalysisWindowManager({
      comparisonModule,
      uiManager,
      sidebar,
    }),
    settings,
  };
}

test('AnalysisWindowManager requires the exact settings export API', async () => {
  await withFakeDOM(() => {
    const { manager } = createWindowManagerHarness();
    const details = new FakeElement('details');
    manager._windows.set('window-a', {
      id: 'window-a',
      modeId: 'exact',
      details,
      ui: {
        getSelectedPages() {
          return ['page-a'];
        },
        getConfig() {
          return {};
        },
      },
      headerTitle: 'Exact',
      headerDesc: '',
      floatConstraints: {
        minWidth: 180,
        maxWidth: 600,
        minHeight: 0,
        maxHeight: 800,
      },
    });

    assert.throws(
      () => manager.exportSessionWindows(),
      /exportSettings/i,
    );
  });
});

test('AnalysisWindowManager propagates dockable registration failure and rolls back', async () => {
  await withFakeDOM(() => {
    const injected = new Error('injected dockable registration failure');
    const floatingRoot = new FakeElement('div');
    let floatCalls = 0;
    setDockableAccordions({
      floatingRoot,
      register() {
        throw injected;
      },
      float() {
        floatCalls += 1;
      },
      unregister() {},
    });
    const { manager } = createWindowManagerHarness();

    assert.throws(
      () => manager.copyFromEmbedded('exact'),
      error => error === injected,
    );
    assert.equal(floatCalls, 0);
    assert.equal(manager.getWindowCount(), 0);
    assert.equal(floatingRoot.children.length, 0);
  });
});

test('AnalysisWindowManager removes zero-cell selections before highlight propagation', () => {
  let publishedPages = null;
  let highlightCalls = 0;
  const manager = Object.create(AnalysisWindowManager.prototype);
  manager._comparisonModule = {
    dataLayer: {
      getPages() {
        return [{ id: 'page_1', name: 'Page 1' }];
      },
      getCellCountForPageId() {
        return 0;
      },
    },
  };
  manager._windows = new Map([
    ['analysis-window-1', {
      id: 'analysis-window-1',
      ui: {
        getSelectedPages() {
          return ['page_1'];
        },
        onPageSelectionChange(pageIds) {
          publishedPages = [...pageIds];
        },
        onHighlightChanged() {
          highlightCalls += 1;
        },
      },
    }],
  ]);

  manager.onHighlightChanged();

  assert.deepEqual(publishedPages, []);
  assert.equal(highlightCalls, 1);
});

test('analysis-window session capture requires the exact manager API', () => {
  assert.throws(
    () => captureAnalysisWindows({}),
    /analysisWindowManager.*exportSessionWindows/i,
  );
  assert.throws(
    () => captureAnalysisWindows({
      analysisWindowManager: {
        exportSessionWindows() {
          return {};
        },
      },
    }),
    /exportSessionWindows.*array/i,
  );
});

test('analysis-window session restore is terminal on invalid boundaries and manager failures', async () => {
  await assert.rejects(
    restoreAnalysisWindows({}, {}, { windows: [] }),
    /analysisWindowManager.*closeAll.*createFromSessionDescriptor/i,
  );
  const exactManager = {
    closeAll() {},
    createFromSessionDescriptor() {},
  };
  await assert.rejects(
    restoreAnalysisWindows(
      { analysisWindowManager: exactManager },
      {},
      {},
    ),
    /payload.*exactly.*windows/i,
  );

  const closeError = new Error('close failed');
  let restoreCalls = 0;
  await assert.rejects(
    restoreAnalysisWindows(
      {
        analysisWindowManager: {
          closeAll() {
            throw closeError;
          },
          createFromSessionDescriptor() {
            restoreCalls += 1;
          },
        },
      },
      {},
      { windows: [{}] },
    ),
    error => error === closeError,
  );
  assert.equal(restoreCalls, 0);

  const restoreError = new Error('restore failed');
  restoreCalls = 0;
  await assert.rejects(
    restoreAnalysisWindows(
      {
        analysisWindowManager: {
          closeAll() {},
          createFromSessionDescriptor() {
            restoreCalls += 1;
            throw restoreError;
          },
        },
      },
      {},
      { windows: [{ modeId: 'first' }, { modeId: 'second' }] },
    ),
    error => error === restoreError,
  );
  assert.equal(restoreCalls, 1, 'restore must stop at the first failed descriptor');
});

function createSessionSerializer(contributors) {
  return new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors,
  });
}

function sessionChunk(contributorId, id, priority = 'eager') {
  return {
    id,
    contributorId,
    priority,
    kind: 'json',
    codec: 'none',
    label: id,
    datasetDependent: false,
    payload: { id },
  };
}

async function withSessionNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const methodNames = [
    'completeDownload',
    'dismissDownload',
    'failDownload',
    'info',
    'startDownload',
    'updateDownload',
    'warning',
  ];
  const originals = new Map(
    methodNames.map(name => [name, notifications[name]]),
  );
  notifications.startDownload = () => 'session-test-download';
  notifications.updateDownload = () => {};
  notifications.completeDownload = () => {};
  notifications.dismissDownload = () => {};
  notifications.failDownload = () => {};
  notifications.info = () => {};
  notifications.warning = () => {};
  try {
    return await run();
  } finally {
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
}

test('SessionSerializer capture stops at and propagates the first contributor failure', async () => {
  const captureError = new Error('capture failed');
  let laterCaptureCalls = 0;
  const serializer = createSessionSerializer([
    {
      id: 'failing-capture',
      capture() {
        throw captureError;
      },
      restore() {},
    },
    {
      id: 'later-capture',
      capture() {
        laterCaptureCalls += 1;
        return [];
      },
      restore() {},
    },
  ]);

  await assert.rejects(
    serializer.createSessionBundle(),
    error => error === captureError,
  );
  assert.equal(laterCaptureCalls, 0);
});

test('SessionSerializer rejects invalid captured chunks instead of omitting them', async () => {
  const serializer = createSessionSerializer([{
    id: 'invalid-chunk-contributor',
    capture() {
      return [null];
    },
    restore() {},
  }]);

  await assert.rejects(
    serializer.createSessionBundle(),
    /session contributor.*chunk.*object/i,
  );
});

test('SessionSerializer restore stops at and propagates eager contributor failure', async () => {
  const contributorId = 'failing-eager-restore';
  const bundle = await createSessionSerializer([{
    id: contributorId,
    capture() {
      return [
        sessionChunk(contributorId, 'test/eager-first'),
        sessionChunk(contributorId, 'test/eager-second'),
      ];
    },
    restore() {},
  }]).createSessionBundle();

  const restoreError = new Error('eager restore failed');
  let restoreCalls = 0;
  const serializer = createSessionSerializer([{
    id: contributorId,
    capture() {
      return [];
    },
    restore() {
      restoreCalls += 1;
      throw restoreError;
    },
  }]);

  await withSessionNotificationHarness(async () => {
    await assert.rejects(
      serializer.restoreFromBlob(bundle),
      error => error === restoreError,
    );
  });
  assert.equal(restoreCalls, 1);
});

test('SessionSerializer public restore promise propagates lazy contributor failure', async () => {
  const contributorId = 'failing-lazy-restore';
  const bundle = await createSessionSerializer([{
    id: contributorId,
    capture() {
      return [sessionChunk(contributorId, 'test/lazy', 'lazy')];
    },
    restore() {},
  }]).createSessionBundle();

  const restoreError = new Error('lazy restore failed');
  const serializer = createSessionSerializer([{
    id: contributorId,
    capture() {
      return [];
    },
    restore() {
      throw restoreError;
    },
  }]);

  let outcome;
  await withSessionNotificationHarness(async () => {
    outcome = await serializer.restoreFromBlob(bundle).then(
      () => ({ status: 'resolved' }),
      error => ({ status: 'rejected', error }),
    );
    if (serializer._activeLazyTask) {
      await serializer._activeLazyTask.catch(() => {});
    }
  });
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error, restoreError);
});

test('SessionSerializer rejects a current bundle whose contributor is not registered', async () => {
  const contributorId = 'required-current-contributor';
  const bundle = await createSessionSerializer([{
    id: contributorId,
    capture() {
      return [sessionChunk(contributorId, 'test/required-contributor')];
    },
    restore() {},
  }]).createSessionBundle();
  const serializer = createSessionSerializer([]);

  await withSessionNotificationHarness(async () => {
    await assert.rejects(
      serializer.restoreFromBlob(bundle),
      /session contributor.*required-current-contributor.*not registered/i,
    );
  });
});

test('correlation UI awaits each selected variable readiness before one compute execution', async () => {
  const gates = new Map();
  const requestOrder = [];
  for (const key of ['age', 'n_genes']) {
    let resolve;
    const promise = new Promise(resolvePromise => {
      resolve = resolvePromise;
    });
    gates.set(key, { promise, resolve });
  }

  let computeCalls = 0;
  let computeRequestOrder = null;
  const ui = Object.create(CorrelationAnalysisUI.prototype);
  ui._selectedPages = ['page-a'];
  ui._pageSelector = {
    getCustomColors() {
      return new Map();
    },
  };
  ui.dataLayer = {
    async getDataForPages(request) {
      requestOrder.push(request.variableKey);
      await gates.get(request.variableKey).promise;
      return [{
        pageId: 'page-a',
        pageName: 'Page A',
        values: [1, 2, 3],
        cellIndices: [0, 1, 2],
      }];
    },
  };
  ui.multiVariableAnalysis = {
    async correlationAnalysis() {
      computeCalls += 1;
      computeRequestOrder = [...requestOrder];
      return [{
        pageId: 'page-a',
        pageName: 'Page A',
        xValues: [1, 2, 3],
        yValues: [2, 3, 4],
      }];
    },
  };

  const analysisPromise = ui._runAnalysisImpl({
    variableX: { type: 'continuous_obs', key: 'age' },
    variableY: { type: 'continuous_obs', key: 'n_genes' },
    method: 'pearson',
    colorBy: null,
  });
  try {
    await Promise.resolve();
    assert.deepEqual(requestOrder, ['age']);
    assert.equal(computeCalls, 0);

    gates.get('age').resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(requestOrder, ['age', 'n_genes']);
    assert.equal(computeCalls, 0);

    gates.get('n_genes').resolve();
    const result = await analysisPromise;
    assert.equal(computeCalls, 1);
    assert.deepEqual(computeRequestOrder, ['age', 'n_genes']);
    assert.equal(result.data.length, 1);
  } finally {
    gates.get('age').resolve();
    gates.get('n_genes').resolve();
    await analysisPromise.catch(() => {});
  }
});

test('analysis previews invoke their required full-view modal owner', async () => {
  await withFakeDOM(async () => {
    const originalGet = PlotRegistry.get;
    const originalMergeOptions = PlotRegistry.mergeOptions;
    PlotRegistry.get = () => ({
      async render() {},
    });
    PlotRegistry.mergeOptions = (_plotType, options = {}) => (
      structuredClone(options)
    );
    const cases = [
      {
        label: 'Correlation',
        prototype: CorrelationAnalysisUI.prototype,
        result: { plotType: '__missing-correlation-preview-plot__' },
        clickClass: 'analysis-preview-container',
        configure(ui) {
          ui._plotContainerIdBase = 'correlation-preview';
        },
      },
      {
        label: 'Gene Signature',
        prototype: GeneSignatureUI.prototype,
        result: { plotType: '__missing-signature-preview-plot__' },
        clickClass: 'analysis-preview-container',
        configure(ui) {
          ui._instanceId = 'signature-preview';
        },
      },
      {
        label: 'Differential Expression',
        prototype: DEAnalysisUI.prototype,
        result: { plotType: '__missing-de-preview-plot__' },
        clickClass: 'analysis-expand-btn',
        configure(ui) {
          ui._plotContainerIdBase = 'de-preview';
        },
      },
    ];

    try {
      for (const modalCase of cases) {
        let modalOpenCalls = 0;
        const ui = Object.create(modalCase.prototype);
        ui._resultContainer = new FakeElement('div');
        ui._analysisRequestTracker = createRequestIdTracker();
        ui._activeAnalysisRequestId = null;
        ui._analysisInvalidationOwner = null;
        ui._isDestroyed = false;
        ui._isLoading = false;
        ui._createOwnedPlotSlot = (host, candidateClassName) => ({
          async render() {
            const candidate = new FakeElement('div');
            candidate.className = candidateClassName;
            host.appendChild(candidate);
            return candidate;
          },
        });
        ui._openExpandedView = async () => {
          modalOpenCalls += 1;
        };
        modalCase.configure(ui);

        const requestId = ui._startAnalysisRequest();
        await ui._showResult(modalCase.result, requestId);
        ui._finishAnalysisRequest(requestId);

        let clickTarget = null;
        const visit = element => {
          if (
            element.className
              .split(/\s+/)
              .includes(modalCase.clickClass)
          ) {
            clickTarget = element;
          }
          for (const child of element.children) visit(child);
        };
        visit(ui._resultContainer);
        assert.ok(
          clickTarget,
          `${modalCase.label} must render its full-view control`,
        );
        clickTarget.click();
        assert.equal(
          modalOpenCalls,
          1,
          `${modalCase.label} full-view control must invoke the modal owner exactly once`,
        );
      }
    } finally {
      PlotRegistry.get = originalGet;
      PlotRegistry.mergeOptions = originalMergeOptions;
    }
  });
});

test('correlation computation rejects insufficient ready data instead of completing with an error sentinel', async () => {
  let completeCalls = 0;
  let failCalls = 0;
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    async getDataForPages({ variableKey }) {
      return [{
        pageId: 'page-a',
        pageName: 'Page A',
        values: variableKey === 'age' ? [1, 2] : [3, 4],
        cellIndices: [0, 1],
      }];
    },
  };
  analysis._notifications = {
    loading() {
      return 'correlation-notification';
    },
    complete() {
      completeCalls += 1;
    },
    fail() {
      failCalls += 1;
    },
  };
  analysis._getComputeManager = async () => ({
    execute() {
      throw new Error('compute must not run for insufficient data');
    },
  });

  await assert.rejects(
    analysis.correlationAnalysis({
      varX: { type: 'continuous_obs', key: 'age' },
      varY: { type: 'continuous_obs', key: 'n_genes' },
      pageIds: ['page-a'],
      method: 'pearson',
      colorBy: null,
    }),
    /page-a.*at least 3 paired values/i,
  );
  assert.equal(completeCalls, 0);
  assert.equal(failCalls, 1);
});

test('2D correlation and volcano plots preselect the cross-browser SVG scatter renderer', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
  };
  const captured = [];
  globalThis.document = {
    body: {},
    head: {
      appendChild() {},
    },
    getElementById() {
      return null;
    },
    createElement(tagName) {
      if (tagName === 'canvas') {
        return {
          getContext(contextName) {
            assert.equal(contextName, 'webgl2');
            return {
              getExtension() {
                return null;
              },
            };
          },
        };
      }
      return {};
    },
  };
  globalThis.MutationObserver = class {
    observe() {}
  };
  globalThis.window = {
    Plotly: {
      async newPlot(_container, traces) {
        captured.push(...traces);
        return { data: traces };
      },
    },
  };

  try {
    const pointCount = 1_001;
    const xValues = Float32Array.from(
      { length: pointCount },
      (_, index) => index,
    );
    const yValues = Float32Array.from(
      { length: pointCount },
      (_, index) => index * 2,
    );
    await scatterPlotDefinition.render(
      [{
        pageId: 'page-a',
        pageName: 'Page A',
        xVariable: 'age',
        yVariable: 'n_genes',
        xValues,
        yValues,
        r: 1,
        rSquared: 1,
        pValue: 0,
        slope: 2,
        intercept: 0,
      }],
      {
        showTrendline: true,
        showR2: true,
        showConfidenceInterval: true,
        pointSize: 5,
        pointOpacity: 0.6,
        showDensity: false,
        densityThreshold: 1_000,
        logScaleX: false,
        logScaleY: false,
        showGrid: true,
        legendPosition: 'right',
      },
      {},
      null,
    );

    assert.ok(
      captured.some(trace => trace.type === 'histogram2dcontour'),
      'the explicit large-correlation density layer must remain present',
    );
    const cartesianTraces = captured.filter(trace =>
      trace.mode === 'markers' || trace.mode === 'lines'
    );
    assert.ok(cartesianTraces.length > 0);
    assert.ok(
      cartesianTraces.every(trace => trace.type === 'scatter'),
      'markers, trend lines, and confidence bands must use one SVG trace type',
    );
    assert.equal(
      captured.some(trace => trace.type === 'scattergl'),
      false,
      'correlation rendering must not allocate a second browser WebGL context',
    );

    captured.length = 0;
    await volcanoPlotDefinition.render(
      {
        results: [
          {
            gene: 'GeneA',
            log2FoldChange: 2,
            pValue: 0.001,
            adjustedPValue: 0.003,
          },
          {
            gene: 'GeneB',
            log2FoldChange: -2,
            pValue: 0.002,
            adjustedPValue: 0.004,
          },
          {
            gene: 'GeneC',
            log2FoldChange: 0.1,
            pValue: 0.5,
            adjustedPValue: 0.7,
          },
        ],
      },
      {
        pValueThreshold: 0.05,
        foldChangeThreshold: 1,
        useAdjustedPValue: true,
        labelTopN: 0,
        pointSize: 6,
        showThresholdLines: true,
        colorScheme: 'default',
        highlightGenes: [],
        legendPosition: 'right',
      },
      { clientWidth: 720, clientHeight: 520 },
    );
    assert.equal(captured.length, 5);
    assert.ok(
      captured.every(trace => trace.type === 'scatter'),
      'volcano genes and legend traces must use one SVG trace type',
    );
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

test('volcano plots and exports preserve p=0 as exact +infinity significance', async () => {
  const originalWindow = globalThis.window;
  /** @type {Array<{traces: Object[], layout: Object}>} */
  const figures = [];
  globalThis.window = {
    Plotly: {
      async newPlot(container, traces, layout) {
        figures.push({ traces, layout });
        container.data = traces;
        container.layout = layout;
        return container;
      },
    },
  };

  const results = [
    {
      gene: 'RAW_ZERO',
      log2FoldChange: 2,
      pValue: 0,
      adjustedPValue: 0.5,
      meanA: 3,
      meanB: 1,
    },
    {
      gene: 'ADJUSTED_ZERO',
      log2FoldChange: -2,
      pValue: 0.25,
      adjustedPValue: 0,
      meanA: 1,
      meanB: 3,
    },
    {
      gene: 'ADJUSTED_MISSING',
      log2FoldChange: 3,
      pValue: 0.001,
      meanA: 4,
      meanB: 1,
    },
    {
      gene: 'FINITE',
      log2FoldChange: 1.5,
      pValue: 1e-12,
      adjustedPValue: 1e-10,
      meanA: 2.5,
      meanB: 1,
    },
  ];
  const container = { clientWidth: 720, clientHeight: 520 };
  const options = {
    pValueThreshold: 0.05,
    foldChangeThreshold: 1,
    useAdjustedPValue: false,
    labelTopN: 2,
    pointSize: 6,
    showThresholdLines: true,
    colorScheme: 'default',
    highlightGenes: [],
    legendPosition: 'auto',
  };

  try {
    await volcanoPlotDefinition.render({ results }, options, container);
    const rawFigure = figures.at(-1);
    assert.equal(rawFigure.traces.length, 5);

    const rawGenes = rawFigure.traces[0];
    const rawInfinityBoundary = rawFigure.traces[4];
    assert.deepEqual(Array.from(rawGenes.customdata), [0, 0.25, 0.001, 1e-12]);
    assert.equal(Number.isNaN(rawGenes.y[0]), true);
    assert.equal(Array.from(rawGenes.y).includes(300), false);
    assert.deepEqual(rawInfinityBoundary.text, ['RAW_ZERO']);
    assert.deepEqual(rawInfinityBoundary.customdata, [0]);
    assert.match(rawInfinityBoundary.name, /p\s*=\s*0.*\+∞/u);
    assert.match(rawInfinityBoundary.hovertemplate, /p:\s*0.*\+∞/u);
    assert.ok(
      rawFigure.layout.yaxis.ticktext.includes('+∞'),
      'the finite display boundary must be labeled as mathematical +infinity',
    );

    await volcanoPlotDefinition.render(
      { results },
      { ...options, useAdjustedPValue: true },
      container,
    );
    const adjustedFigure = figures.at(-1);
    const adjustedGenes = adjustedFigure.traces[0];
    const adjustedInfinityBoundary = adjustedFigure.traces[4];
    assert.equal(adjustedGenes.customdata[0], 0.5);
    assert.equal(adjustedGenes.customdata[1], 0);
    assert.equal(Number.isNaN(adjustedGenes.customdata[2]), true);
    assert.equal(
      Number.isNaN(adjustedGenes.y[2]),
      true,
      'missing adjusted p-values must not be replaced with raw p-values',
    );
    assert.deepEqual(adjustedInfinityBoundary.text, ['ADJUSTED_ZERO']);

    const rawExport = volcanoPlotDefinition.exportCSV(
      { results },
      { ...options, useAdjustedPValue: false },
    );
    const rawZeroRow = rawExport.rows.find(row => row.gene === 'RAW_ZERO');
    assert.equal(rawZeroRow.pValue, 0);
    assert.equal(rawZeroRow.adjustedPValue, 0.5);
    assert.equal(rawZeroRow.negLog10P, '+Infinity');
    assert.match(toCSV(rawExport.rows, { columns: rawExport.columns }), /RAW_ZERO,2,0,0\.5,\+Infinity/);

    const adjustedExport = volcanoPlotDefinition.exportCSV(
      { results },
      { ...options, useAdjustedPValue: true },
    );
    const adjustedZeroRow = adjustedExport.rows.find(row => row.gene === 'ADJUSTED_ZERO');
    const adjustedMissingRow = adjustedExport.rows.find(row => row.gene === 'ADJUSTED_MISSING');
    assert.equal(adjustedZeroRow.pValue, 0.25);
    assert.equal(adjustedZeroRow.adjustedPValue, 0);
    assert.equal(adjustedZeroRow.negLog10P, '+Infinity');
    assert.equal(adjustedMissingRow.negLog10P, '');
    assert.equal(adjustedMissingRow.significant, 'no');
    assert.deepEqual(
      volcanoPlotDefinition.getSummary(
        { results },
        { ...options, useAdjustedPValue: true },
      ),
      {
        total: 4,
        upregulated: 1,
        downregulated: 1,
        notSignificant: 2,
        significantTotal: 2,
      },
    );

    const scientificCSV = deResultsToCSV(results);
    assert.match(scientificCSV, /RAW_ZERO,3,1,2,0,0\.5/);
    assert.match(scientificCSV, /ADJUSTED_ZERO,1,3,-2,0\.25,0/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('volcano gene-label layout is deterministic, collision-free, and count-exact', async () => {
  const originalWindow = globalThis.window;
  let captured = null;
  globalThis.window = {
    Plotly: {
      async newPlot(container, traces, layout) {
        captured = { traces, layout };
        return container;
      },
    },
  };

  const width = 760;
  const height = 560;
  const results = Array.from({ length: 15 }, (_, index) => ({
    gene: `ENSG00000_LABEL_${String(index + 1).padStart(2, '0')}`,
    log2FoldChange: (index % 2 === 0 ? -1 : 1) * (1.2 + (index * 0.18)),
    pValue: index < 4 ? 0 : 10 ** (-(20 - index)),
    adjustedPValue: index < 4 ? 0 : 10 ** (-(18 - index)),
  }));
  const options = {
    pValueThreshold: 0.05,
    foldChangeThreshold: 1,
    useAdjustedPValue: true,
    labelTopN: 15,
    pointSize: 6,
    showThresholdLines: true,
    colorScheme: 'default',
    highlightGenes: [],
    legendPosition: 'auto',
  };

  try {
    await volcanoPlotDefinition.render(
      { results },
      options,
      { clientWidth: width, clientHeight: height },
    );

    const labels = captured.layout.annotations.filter(annotation => annotation.showarrow);
    assert.equal(labels.length, 15);
    assert.deepEqual(captured.layout.meta.cellucidVolcanoLabels, {
      requested: 15,
      displayed: 15,
    });
    assert.match(
      captured.layout.annotations.find(annotation => !annotation.showarrow).text,
      /15 of 15 gene labels shown/i,
    );

    const xRange = captured.layout.xaxis.range;
    const yRange = captured.layout.yaxis.range;
    const margin = captured.layout.margin;
    const plotWidth = width - margin.l - margin.r;
    const plotHeight = height - margin.t - margin.b;
    const boxes = labels.map((annotation) => {
      const xAtPoint = margin.l +
        ((annotation.x - xRange[0]) / (xRange[1] - xRange[0])) * plotWidth;
      const yAtPoint = margin.t +
        (1 - ((annotation.y - yRange[0]) / (yRange[1] - yRange[0]))) * plotHeight;
      const centerX = xAtPoint + annotation.ax;
      const centerY = yAtPoint + annotation.ay;
      const boxWidth = annotation.text.length * 6 + 10;
      return {
        left: centerX - (boxWidth / 2),
        right: centerX + (boxWidth / 2),
        top: centerY - 9,
        bottom: centerY + 9,
      };
    });

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlaps = (
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top
        );
        assert.equal(
          overlaps,
          false,
          `gene-label boxes ${i} and ${j} must not overlap`,
        );
      }
    }
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('volcano scientific paths contain no p-value flooring or adjusted-to-raw substitution', async () => {
  const [plotSource, deUiSource] = await Promise.all([
    readFile(
      new URL('../assets/js/app/analysis/plots/types/volcanoplot.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js', import.meta.url),
      'utf8',
    ),
  ]);

  assert.doesNotMatch(plotSource, /1e-300|Math\.max\(\s*p|AdjustedOrRaw|adjustedPValue\s*\?\?/);
  assert.doesNotMatch(deUiSource, /adjustedPValue\s*\?\?\s*row\.pValue/);
});

test('scatter plot update propagates purge failure without attempting another render', async () => {
  const originalWindow = globalThis.window;
  const purgeError = new Error('purge failed');
  let renderCalls = 0;
  globalThis.window = {
    Plotly: {
      purge() {
        throw purgeError;
      },
      async newPlot() {
        renderCalls += 1;
        return {};
      },
    },
  };

  try {
    await assert.rejects(
      scatterPlotDefinition.update({}, [], {}, null),
      error => error === purgeError,
    );
    assert.equal(renderCalls, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('the complete 2D analysis plot surface contains no scattergl selector', async () => {
  const paths = [
    '../assets/js/app/analysis/plots/plot-factory.js',
    '../assets/js/app/analysis/plots/plotly-loader.js',
    '../assets/js/app/analysis/plots/types/densityplot.js',
    '../assets/js/app/analysis/plots/types/scatterplot.js',
    '../assets/js/app/analysis/plots/types/volcanoplot.js',
  ];

  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /scattergl|getScatterTraceType/,
      `${path} must preselect the current SVG scatter contract`,
    );
  }
});
