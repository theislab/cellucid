import assert from 'node:assert/strict';
import test from 'node:test';

import { PlotRegistry } from '../assets/js/app/analysis/shared/plot-registry-utils.js';
import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { FigureContainer } from '../assets/js/app/analysis/ui/shared/figure-container.js';
import {
  restorePlotlyNotifications,
  setPlotlyHintsEnabled,
} from '../assets/js/app/analysis/plots/plotly-hints.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  _values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  _write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...names) {
    const values = this._values();
    for (const name of names) values.add(name);
    this._write(values);
  }

  remove(...names) {
    const values = this._values();
    for (const name of names) values.delete(name);
    this._write(values);
  }

  contains(name) {
    return this._values().has(name);
  }
}

class FakeStyle {
  constructor() {
    this.cssText = '';
  }

  setProperty(name, value) {
    this[name] = String(value);
  }

  getPropertyValue(name) {
    return this[name] ?? '';
  }

  removeProperty(name) {
    delete this[name];
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.isConnected = false;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = new FakeStyle();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = '';
    this.textContent = '';
    this.title = '';
    this._innerHTML = '';
    this._plotListeners = new Map();
    this.offsetHeight = 100;
    this.offsetWidth = 200;
  }

  set innerHTML(value) {
    for (const child of this.children) {
      child.parentNode = null;
      child._setConnected(false);
    }
    this.children = [];
    this._innerHTML = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  _setConnected(value) {
    this.isConnected = value;
    for (const child of this.children) child._setConnected(value);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this._innerHTML = '';
    this.children.push(child);
    child.parentNode = this;
    child._setConnected(this.isConnected);
    return child;
  }

  append(child) {
    return this.appendChild(child);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('FakeElement child was not found');
    this.children.splice(index, 1);
    child.parentNode = null;
    child._setConnected(false);
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener),
    );
  }

  on(type, listener) {
    this._plotListeners.set(type, listener);
  }

  removeListener(type, listener) {
    if (this._plotListeners.get(type) === listener) {
      this._plotListeners.delete(type);
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = element => {
      if (matchesSelector(element, selector)) matches.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      right: 640,
      bottom: 480,
      width: 640,
      height: 480,
    };
  }

  focus() {}
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

async function withFakeDOM(run) {
  const originals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  const purgeCounts = new Map();
  const downloadCalls = [];
  const documentListeners = new Map();
  const document = {
    body: null,
    head: null,
    documentElement: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    createDocumentFragment() {
      return new FakeElement('fragment', document);
    },
    getElementById(id) {
      for (const root of [document.head, document.body]) {
        if (root.id === id) return root;
        const found = root.querySelector(`#${id}`);
        if (found) return found;
      }
      return null;
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      documentListeners.set(
        type,
        listeners.filter(candidate => candidate !== listener),
      );
    },
  };
  document.head = new FakeElement('head', document);
  document.body = new FakeElement('body', document);
  document.documentElement = new FakeElement('html', document);
  document.head._setConnected(true);
  document.body._setConnected(true);
  document.documentElement._setConnected(true);

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}
    disconnect() {}
  }

  const Plotly = {
    purge(container) {
      purgeCounts.set(container, (purgeCounts.get(container) ?? 0) + 1);
    },
    async downloadImage(container, options) {
      downloadCalls.push({ container, options });
    },
  };

  globalThis.document = document;
  globalThis.getComputedStyle = () => {
    const tokens = new Map([
      ['--font-sans', 'Inter, system-ui, sans-serif'],
      ['--text-sm', '11px'],
      ['--text-md', '12px'],
      ['--color-surface-elevated', '#ffffff'],
      ['--color-text-primary', '#111827'],
      ['--color-text-secondary', '#374151'],
      ['--color-text-tertiary', '#6b7280'],
      ['--color-accent', '#1ed8ff'],
      ['--color-danger', '#dc2626'],
      ['--color-success', '#16a34a'],
      ['--color-info', '#3b82f6'],
      ['--color-warning', '#eab308'],
      ['--color-border-light', '#e5e7eb'],
      ['--color-surface-tertiary', '#f3f4f6'],
      ['--color-surface-inverse', '#111827'],
      ['--color-text-inverse', '#ffffff'],
    ]);
    return {
      getPropertyValue(name) {
        return tokens.get(name) ?? '';
      },
    };
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.requestAnimationFrame = callback => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = {
    Plotly,
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    return await run({
      document,
      downloadCalls,
      Plotly,
      purgeCounts,
    });
  } finally {
    restorePlotlyNotifications();
    setPlotlyHintsEnabled(true);
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

async function withPlotDefinition(plotDef, run) {
  const originalGet = PlotRegistry.get;
  const originalMergeOptions = PlotRegistry.mergeOptions;
  PlotRegistry.get = () => plotDef;
  PlotRegistry.mergeOptions = (_plotType, options = {}) => structuredClone(options);
  try {
    return await run();
  } finally {
    PlotRegistry.get = originalGet;
    PlotRegistry.mergeOptions = originalMergeOptions;
  }
}

function attachRoot(document, className = '') {
  const root = document.createElement('div');
  root.className = className;
  document.body.appendChild(root);
  return root;
}

function analysisResult(owner) {
  return {
    owner,
    plotType: '__transaction-probe__',
    data: { owner },
    options: { owner },
    title: owner,
  };
}

for (const previewCase of [
  {
    label: 'Correlation',
    create() {
      const ui = new CorrelationAnalysisUI({
        comparisonModule: {},
        dataLayer: {},
        multiVariableAnalysis: {},
      });
      ui._plotContainerIdBase = 'correlation-transaction-preview';
      return ui;
    },
  },
  {
    label: 'Gene Signature',
    create() {
      return new GeneSignatureUI({
        comparisonModule: {},
        dataLayer: {},
        multiVariableAnalysis: {},
        instanceId: 'signature-transaction',
      });
    },
  },
]) {
  test(`${previewCase.label} keeps the committed preview until the newest candidate commits`, { concurrency: false }, async () => {
    await withFakeDOM(async ({ document }) => {
      const newerGate = deferred();
      const newerStarted = deferred();
      const candidates = new Map();
      const plotDef = {
        async render(data, _options, candidate) {
          candidate.dataset.owner = data.owner;
          candidates.set(data.owner, candidate);
          if (data.owner === 'newer') {
            newerStarted.resolve();
            await newerGate.promise;
          }
          return candidate;
        },
      };

      await withPlotDefinition(plotDef, async () => {
        const ui = previewCase.create();
        ui._resultContainer = attachRoot(document, 'analysis-result');
        ui._container = ui._resultContainer;

        const committedRequest = ui._startAnalysisRequest();
        await ui._showResult(analysisResult('committed'), committedRequest);
        ui._finishAnalysisRequest(committedRequest);
        const committed = candidates.get('committed');

        const newerRequest = ui._startAnalysisRequest();
        const newerRender = ui._showResult(
          analysisResult('newer'),
          newerRequest,
        );
        await newerStarted.promise;
        const committedStayedVisible = (
          committed.isConnected &&
          ui._resultContainer.querySelector('.analysis-preview-plot') === committed
        );

        const newestRequest = ui._startAnalysisRequest();
        const newestRender = ui._showResult(
          analysisResult('newest'),
          newestRequest,
        );
        newerGate.resolve();
        await Promise.all([newerRender, newestRender]);
        ui._finishAnalysisRequest(newestRequest);

        assert.equal(
          committedStayedVisible,
          true,
          'a pending renderer must not clear the last committed preview',
        );
        assert.equal(
          ui._resultContainer.querySelector('.analysis-preview-plot'),
          candidates.get('newest'),
          'a stale completion must not replace the newest committed candidate',
        );
        await ui.destroy();
      });
    });
  });
}

test('DE form invalidation does not purge or detach its running preview candidate', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const renderGate = deferred();
    const renderStarted = deferred();
    let candidate = null;
    const plotDef = {
      async render(_data, _options, plotCandidate) {
        candidate = plotCandidate;
        renderStarted.resolve();
        await renderGate.promise;
      },
    };

    await withPlotDefinition(plotDef, async () => {
      const ui = new DEAnalysisUI({
        comparisonModule: {},
        dataLayer: {},
        multiVariableAnalysis: {},
      });
      ui._resultContainer = attachRoot(document, 'analysis-result');
      ui._container = ui._resultContainer;
      const requestId = ui._startAnalysisRequest();
      const rendering = ui._showResult(analysisResult('running'), requestId);
      await renderStarted.promise;

      ui._handleFormInputIntent();
      const remainedConnected = candidate.isConnected;
      const purgeCountDuringRender = purgeCounts.get(candidate) ?? 0;

      renderGate.resolve();
      await rendering;

      assert.equal(remainedConnected, true);
      assert.equal(
        purgeCountDuringRender,
        0,
        'invalidation may mark a renderer stale but cannot purge it mid-call',
      );
      assert.equal(
        purgeCounts.get(candidate),
        1,
        'the stale candidate must be retired exactly once after settlement',
      );
      await ui.destroy();
    });
  });
});

test('Genes modal close waits for its running child candidate to settle', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const renderGate = deferred();
    const renderStarted = deferred();
    const plotDef = {
      async render(_data, _options, candidate) {
        renderStarted.resolve(candidate);
        await renderGate.promise;
      },
    };

    await withPlotDefinition(plotDef, async () => {
      const ui = new GenesPanelUI({
        comparisonModule: {},
        dataLayer: {},
        multiVariableAnalysis: {},
      });
      ui._setupHoverContext = () => {};
      ui._resultContainer = attachRoot(document, 'analysis-result');
      ui._container = ui._resultContainer;
      ui._lastResult = analysisResult('modal-running');

      const modal = document.createElement('div');
      modal._cleanupDone = false;
      modal._cleanupFns = [];
      modal._plotContainer = document.createElement('div');
      modal.appendChild(modal._plotContainer);
      document.body.appendChild(modal);
      ui._modal = modal;

      const rendering = ui._renderModalPlot(modal._plotContainer);
      const candidate = await renderStarted.promise;
      const closeTask = ui._discardFormResult();
      const closeIsAwaitable = typeof closeTask?.then === 'function';
      const cleanupStartedDuringRender = modal._cleanupDone;
      const parentPurgeDuringRender =
        purgeCounts.get(modal._plotContainer) ?? 0;

      renderGate.resolve();
      await rendering;
      await Promise.resolve(closeTask);

      assert.equal(closeIsAwaitable, true);
      assert.equal(
        cleanupStartedDuringRender,
        false,
        'modal teardown cannot begin while Plotly still owns its child',
      );
      assert.equal(parentPurgeDuringRender, 0);
      assert.equal(modal._cleanupDone, true);
      await ui.destroy();
    });
  });
});

test('form plot-option bursts keep one modal render running and coalesce the pending payload to newest', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const renderGate = deferred();
    const started = [];
    const plotDef = {
      async render(_data, options, candidate) {
        started.push(`${candidate.parentNode.id}:${options.mode}`);
        await renderGate.promise;
        candidate.dataset.owner = options.mode;
      },
      async update() {
        throw new Error(
          'isolated option candidates must receive a complete render'
        );
      },
    };

    await withPlotDefinition(plotDef, async () => {
      const ui = new DEAnalysisUI({
        comparisonModule: {},
        dataLayer: {},
        multiVariableAnalysis: {},
      });
      ui._isDestroyed = false;
      ui._lastResult = {
        plotType: '__transaction-probe__',
        data: { exact: true },
        options: {},
      };
      const preview = attachRoot(document, 'analysis-preview-plot-host');
      preview.id = 'option-preview';
      ui._plotContainerId = preview.id;
      const modalPlot = attachRoot(document, 'analysis-modal-plot');
      modalPlot.id = 'option-modal';
      const modal = {
        _plotContainer: modalPlot,
        _optionsContent: document.createElement('div'),
        _statsContent: document.createElement('div'),
        _annotationsContent: document.createElement('div'),
      };
      ui._modal = modal;
      ui._renderModalStats = () => {};
      ui._renderModalAnnotations = () => {};

      const first = ui._handlePlotOptionChange('mode', 'first');
      await waitFor(
        () => started.includes('option-modal:first'),
        'first modal option render',
      );
      const second = ui._handlePlotOptionChange('mode', 'second');
      const third = ui._handlePlotOptionChange('mode', 'third');
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      const startedWhileFirstWasRunning = [...started];

      renderGate.resolve();
      await Promise.allSettled([first, second, third]);

      assert.deepEqual(
        startedWhileFirstWasRunning,
        ['option-modal:first'],
        'second and third option payloads must not overlap the running renderer',
      );
      assert.deepEqual(started, [
        'option-modal:first',
        'option-modal:third',
        'option-preview:third',
      ]);
      assert.equal(
        modalPlot.querySelector('.analysis-modal-plot-candidate')?.dataset.owner,
        'third',
      );
      assert.equal(
        preview.querySelector('.analysis-preview-plot')?.dataset.owner,
        'third',
      );
      await ui._previewPlotSlot.destroy();
      await ui._destroyModalPlotOwner(modal);
      modalPlot.remove();
    });
  });
});

test('Detailed exports lease the exact committed modal child across replacement', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, Plotly }) => {
    const replacementGate = deferred();
    const replacementStarted = deferred();
    const exportGate = deferred();
    const exportStarted = deferred();
    let renderCount = 0;
    let exportTarget = null;
    const plotDef = {
      async render(_data, _options, candidate) {
        renderCount += 1;
        candidate.dataset.owner = `render-${renderCount}`;
        if (renderCount === 2) {
          replacementStarted.resolve();
          await replacementGate.promise;
        }
      },
    };
    Plotly.downloadImage = async target => {
      exportTarget = target;
      exportStarted.resolve();
      await exportGate.promise;
    };

    await withPlotDefinition(plotDef, async () => {
      const ui = new DetailedAnalysisUI({
        comparisonModule: {},
        dataLayer: {},
      });
      ui._notifications = {
        error() {},
        success() {},
      };
      const modalPlot = attachRoot(document, 'analysis-modal-plot');
      ui._modal = {
        _plotContainer: modalPlot,
        _statsContent: null,
        _annotationsContent: null,
      };
      ui._currentPageData = [{ pageId: 'page-A' }];
      ui._layoutEngine = {};
      ui._currentConfig = {
        dataSource: {
          type: 'continuous_obs',
          variable: 'score',
        },
        pages: ['page-A'],
        plotType: '__transaction-probe__',
        plotOptions: {},
      };
      const requestId = ui._startAnalysisRequest();
      await ui._updateModal(
        plotDef,
        {},
        ui._currentPageData,
        ui._layoutEngine,
        ui._currentConfig,
        requestId,
      );
      const committedChild = modalPlot.children[0];

      const exporting = ui._exportPNG();
      await exportStarted.promise;
      const replacement = ui._updateModal(
        plotDef,
        { revision: 2 },
        ui._currentPageData,
        ui._layoutEngine,
        ui._currentConfig,
        requestId,
      );
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      const replacementStartedBeforeExportSettled =
        renderCount > 1;
      const committedStayedConnectedDuringExport =
        committedChild.isConnected;

      exportGate.resolve();
      await exporting;
      await replacementStarted.promise;
      replacementGate.resolve();
      await replacement;

      assert.equal(
        exportTarget,
        committedChild,
        'Plotly export must receive the committed child, not its mutable host',
      );
      assert.equal(replacementStartedBeforeExportSettled, false);
      assert.equal(committedStayedConnectedDuringExport, true);
      ui._finishAnalysisRequest(requestId);
    });
  });
});

test('Detailed invalid and failed reruns retire preview and modal scientific state together', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const createOwner = () => {
      const ui = new DetailedAnalysisUI({
        comparisonModule: {},
        dataLayer: {},
      });
      ui._previewContainer = attachRoot(
        document,
        'analysis-preview-container',
      );
      ui._actionsContainer = attachRoot(document, 'analysis-actions');
      ui._actionsContainer.style.display = 'flex';
      ui._currentPageData = [{ pageId: 'stale-page' }];
      ui._layoutEngine = { owner: 'stale-layout' };
      const stats = document.createElement('div');
      stats.innerHTML = 'stale stats';
      const annotations = document.createElement('div');
      annotations.innerHTML = 'stale annotations';
      const invalidations = { modal: 0, preview: 0 };
      ui._previewPlotSlot = {
        invalidate() {
          invalidations.preview += 1;
          return Promise.resolve();
        },
      };
      ui._modal = {
        _analysisPlotSlot: {
          invalidate() {
            invalidations.modal += 1;
            return Promise.resolve();
          },
        },
        _annotationsContent: annotations,
        _statsContent: stats,
      };
      ui._notifications = { error() {} };
      return { annotations, invalidations, stats, ui };
    };

    const invalid = createOwner();
    invalid.ui._currentConfig = {
      dataSource: { type: '', variable: '' },
      pages: [],
      plotOptions: {},
      plotType: '',
    };
    invalid.ui._selectedPages = [];
    await invalid.ui._runAnalysisIfValid();

    assert.deepEqual(invalid.invalidations, { modal: 1, preview: 1 });
    assert.equal(invalid.ui._currentPageData, null);
    assert.equal(invalid.ui._layoutEngine, null);
    assert.equal(invalid.stats.innerHTML, '');
    assert.equal(invalid.annotations.innerHTML, '');

    const failed = createOwner();
    const requestId = failed.ui._startAnalysisRequest();
    await failed.ui._showError('replacement failed', requestId);

    assert.deepEqual(failed.invalidations, { modal: 1, preview: 1 });
    assert.equal(failed.ui._currentPageData, null);
    assert.equal(failed.ui._layoutEngine, null);
    assert.equal(failed.stats.innerHTML, '');
    assert.equal(failed.annotations.innerHTML, '');
    assert.ok(
      failed.ui._previewContainer.querySelector('.analysis-error'),
    );
    failed.ui._finishAnalysisRequest(requestId);
  });
});

test('Detailed stale error publication cannot append after a newer request starts', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const retirement = deferred();
    const retirementStarted = deferred();
    const ui = new DetailedAnalysisUI({
      comparisonModule: {},
      dataLayer: {},
    });
    ui._previewContainer = attachRoot(
      document,
      'analysis-preview-container',
    );
    ui._actionsContainer = attachRoot(document, 'analysis-actions');
    ui._previewPlotSlot = {
      invalidate() {
        retirementStarted.resolve();
        return retirement.promise;
      },
    };
    ui._modal = null;
    let notifications = 0;
    ui._notifications = {
      error() {
        notifications += 1;
      },
    };

    const staleRequest = ui._startAnalysisRequest();
    const publishingError = ui._showError(
      'stale request failed',
      staleRequest,
    );
    await retirementStarted.promise;

    const currentRequest = ui._startAnalysisRequest();
    const currentData = [{ pageId: 'current-page' }];
    ui._currentPageData = currentData;
    retirement.resolve();
    await publishingError;

    assert.equal(
      ui._previewContainer.querySelector('.analysis-error'),
      null,
    );
    assert.equal(ui._currentPageData, currentData);
    assert.equal(notifications, 0);
    ui._finishAnalysisRequest(currentRequest);
  });
});

for (const [label, UIClass] of [
  ['Correlation', CorrelationAnalysisUI],
  ['Gene Signature', GeneSignatureUI],
]) {
  test(`${label} stale error publication cannot append after a newer request starts`, { concurrency: false }, async () => {
    await withFakeDOM(async ({ document }) => {
      const cleanup = deferred();
      const cleanupStarted = deferred();
      const ui = new UIClass({
        comparisonModule: {},
        dataLayer: {},
        multiVariableAnalysis: {},
      });
      ui._resultContainer = attachRoot(document, 'analysis-result');
      ui._discardFormResult = () => {
        cleanupStarted.resolve();
        return cleanup.promise;
      };
      let notifications = 0;
      ui._notifications = {
        error() {
          notifications += 1;
        },
      };

      const staleRequest = ui._startAnalysisRequest();
      const publishingError = ui._showError(
        'stale request failed',
        staleRequest,
      );
      await cleanupStarted.promise;
      const currentRequest = ui._startAnalysisRequest();
      cleanup.resolve();
      await publishingError;

      assert.equal(
        ui._resultContainer.querySelector('.analysis-error'),
        null,
      );
      assert.equal(notifications, 0);
      ui._finishAnalysisRequest(currentRequest);
    });
  });
}

test('FigureContainer destroy drains a running preview and purges every candidate once', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const runningGate = deferred();
    const runningStarted = deferred();
    const candidates = new Map();
    const plotDef = {
      async render(pageData, _options, candidate) {
        const owner = pageData[0].owner;
        candidate.dataset.owner = owner;
        candidates.set(owner, candidate);
        if (owner === 'running') {
          runningStarted.resolve();
          await runningGate.promise;
        }
      },
    };

    await withPlotDefinition(plotDef, async () => {
      const container = attachRoot(document, 'figure-owner');
      const figure = new FigureContainer({ container });
      const makePageData = owner => [{
        owner,
        pageId: 'page-A',
        pageName: 'Page A',
        values: Float32Array.of(1),
        cellIndices: Uint32Array.of(0),
        variableInfo: {
          name: 'score',
          kind: 'continuous',
        },
      }];

      await figure.renderPlot(
        '__transaction-probe__',
        makePageData('committed'),
      );
      const committed = candidates.get('committed');
      const runningRender = figure.renderPlot(
        '__transaction-probe__',
        makePageData('running'),
      );
      await runningStarted.promise;
      const running = candidates.get('running');

      const destroyTask = figure.destroy();
      const destroyIsAwaitable = typeof destroyTask?.then === 'function';
      const runningStayedConnected = running.isConnected;
      const runningPurgeBeforeSettlement = purgeCounts.get(running) ?? 0;

      runningGate.resolve();
      await runningRender;
      await Promise.resolve(destroyTask);

      assert.equal(destroyIsAwaitable, true);
      assert.equal(runningStayedConnected, true);
      assert.equal(runningPurgeBeforeSettlement, 0);
      assert.equal(purgeCounts.get(committed), 1);
      assert.equal(purgeCounts.get(running), 1);
    });
  });
});
