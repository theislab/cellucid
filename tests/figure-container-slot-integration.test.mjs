import assert from 'node:assert/strict';
import test from 'node:test';

import { PlotRegistry } from '../assets/js/app/analysis/shared/plot-registry-utils.js';
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

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeStyle {
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

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  _set() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  _write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...names) {
    const values = this._set();
    for (const name of names) values.add(name);
    this._write(values);
  }

  remove(...names) {
    const values = this._set();
    for (const name of names) values.delete(name);
    this._write(values);
  }

  contains(name) {
    return this._set().has(name);
  }

  toggle(name, force) {
    const values = this._set();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name);
    else values.delete(name);
    this._write(values);
    return enabled;
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
    this.title = '';
    this.textContent = '';
    this.offsetHeight = 480;
    this.offsetWidth = 640;
    this._innerHTML = '';
    this._rect = { width: 640, height: 480 };
  }

  get childElementCount() {
    return this.children.length;
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

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('Fake child was not found');
    this.children.splice(index, 1);
    child.parentNode = null;
    child._setConnected(false);
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some(child => child.contains(candidate));
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

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      right: this._rect.width,
      bottom: this._rect.height,
      width: this._rect.width,
      height: this._rect.height,
    };
  }

  focus() {}
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(selector)) {
    return element.tagName.toLowerCase() === selector.toLowerCase();
  }
  return false;
}

async function withFakeDOM(run) {
  const originalGlobals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  const documentListeners = new Map();
  const observers = [];
  const frames = new Map();
  const purgeCounts = new Map();
  const downloadCalls = [];
  const resizeCalls = [];
  let nextFrameId = 1;

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
      this.disconnected = false;
      this.targets = [];
      observers.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }

    disconnect() {
      this.disconnected = true;
    }

    trigger() {
      if (!this.disconnected) this.callback([]);
    }
  }

  const Plotly = {
    Plots: {
      async resize(candidate) {
        resizeCalls.push(candidate);
      },
    },
    async downloadImage(candidate, options) {
      downloadCalls.push({ candidate, options });
    },
    purge(candidate) {
      purgeCounts.set(candidate, (purgeCounts.get(candidate) ?? 0) + 1);
    },
  };
  const window = {
    Plotly,
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.document = document;
  globalThis.HTMLElement = FakeElement;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    frames.delete(id);
  };
  globalThis.window = window;
  setPlotlyHintsEnabled(false);

  const flushFrames = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  };

  try {
    return await run({
      document,
      downloadCalls,
      flushFrames,
      frames,
      observers,
      Plotly,
      purgeCounts,
      resizeCalls,
    });
  } finally {
    restorePlotlyNotifications();
    setPlotlyHintsEnabled(true);
    for (const [name, value] of Object.entries(originalGlobals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

async function withPlotDefinition(plotDefinition, run) {
  const originalGet = PlotRegistry.get;
  const originalMergeOptions = PlotRegistry.mergeOptions;
  PlotRegistry.get = () => plotDefinition;
  PlotRegistry.mergeOptions = (_plotType, options = {}) =>
    structuredClone(options);
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

function makePageData(owner) {
  return [{
    owner,
    pageId: 'page-A',
    pageName: 'Page A',
    values: Float32Array.of(1, 2),
    cellIndices: Uint32Array.of(0, 1),
    variableInfo: {
      name: 'score',
      kind: 'continuous',
    },
  }];
}

function createFigure(document, options = {}) {
  const figure = new FigureContainer({
    container: attachRoot(document, 'figure-host'),
    expandable: false,
    showOptions: false,
    showStats: false,
    ...options,
  });
  figure._notifications = {
    error() {},
    success() {},
  };
  return figure;
}

function attachOwnedModal(figure, document) {
  const modal = document.createElement('div');
  modal.className = 'analysis-modal open';
  modal._cleanupDone = false;
  modal._cleanupFns = [];
  modal._closePromise = null;
  modal._openPositionTimeout = null;
  modal._escapeHandler = null;
  modal._plotContainer = document.createElement('div');
  modal._title = document.createElement('div');
  modal._optionsContent = document.createElement('div');
  modal._statsContent = document.createElement('div');
  modal._annotationsContent = document.createElement('div');
  modal.appendChild(modal._plotContainer);
  document.body.appendChild(modal);

  figure._modal = modal;
  figure._modalSlot = figure._createPlotSlot(
    modal._plotContainer,
    'analysis-modal-plot-candidate',
  );
  modal._figurePlotSlot = figure._modalSlot;
  modal._figureResizeOwner = figure._installResponsiveResize(
    figure._modalSlot,
    modal._plotContainer,
    () => figure._modal === modal ? figure._modalPlotDiv : null,
  );
  modal._beforeClose = () => figure._teardownModalOwnership(modal);
  modal._onClose = () => figure._finalizeModalOwnership(modal);
  modal._onCloseError = null;

  // These tests isolate render ownership; metadata renderers have independent
  // coverage and do not own Plotly children.
  figure._publishModalMetadata = () => true;
  return modal;
}

test('Figure option events observe their task immediately and destruction drains that exact work', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const optionTask = deferred();
    const rejectionObserverCount = instrumentRejectionObservers(
      optionTask.promise,
    );
    const plotDefinition = {
      defaultOptions: { enabled: false },
      optionSchema: {
        enabled: {
          label: 'Enabled',
          type: 'checkbox',
        },
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const originalGetVisibleOptions = PlotRegistry.getVisibleOptions;
      PlotRegistry.getVisibleOptions = () => plotDefinition.optionSchema;
      try {
        const figure = createFigure(document, {
          showOptions: true,
        });
        let optionCalls = 0;
        figure._applyPlotOptionChange = () => {
          optionCalls++;
          return optionTask.promise;
        };
        figure._currentPlotType = 'probe';
        figure._requestedOptions = { enabled: false };
        const optionsContainer = document.createElement('div');
        figure._modal = { _optionsContent: optionsContainer };
        figure._renderModalOptions();
        figure._modal = null;

        const checkbox = optionsContainer.querySelector(
          '.analysis-option-checkbox',
        );
        assert.ok(checkbox, 'the real options renderer must wire a checkbox');
        checkbox.checked = true;
        for (const listener of checkbox.listeners.get('change') ?? []) {
          listener.call(checkbox, { target: checkbox });
        }
        await Promise.resolve();

        const observedBeforeDestroy = rejectionObserverCount() > 0;
        figure._destroyResizeOwner = () => Promise.resolve();
        figure._previewSlot = {
          destroy() {
            return Promise.resolve();
          },
        };
        let destroySettled = false;
        const destroying = figure.destroy();
        void destroying.then(
          () => {
            destroySettled = true;
          },
          () => {
            destroySettled = true;
          },
        );
        for (let turn = 0; turn < 12; turn++) await Promise.resolve();
        const settledBeforeOptionTask = destroySettled;

        optionTask.resolve();
        await destroying;

        assert.deepEqual({
          observedBeforeDestroy,
          optionCalls,
          settledBeforeOptionTask,
        }, {
          observedBeforeDestroy: true,
          optionCalls: 1,
          settledBeforeOptionTask: false,
        });
      } finally {
        PlotRegistry.getVisibleOptions = originalGetVisibleOptions;
      }
    });
  });
});

test('Figure expand events observe failures and destruction drains the active open task', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const openTask = deferred();
    const rejectionObserverCount = instrumentRejectionObservers(
      openTask.promise,
    );
    const figure = createFigure(document, {
      expandable: true,
    });
    let openCalls = 0;
    figure._openModal = () => {
      openCalls++;
      return openTask.promise;
    };
    figure._renderActions();

    const expandButton = figure._actionsContainer.querySelector(
      '.analysis-expand-btn',
    );
    assert.ok(expandButton, 'the real actions renderer must wire expand');
    for (const listener of expandButton.listeners.get('click') ?? []) {
      listener.call(expandButton, { target: expandButton });
    }
    await Promise.resolve();

    const observedBeforeDestroy = rejectionObserverCount() > 0;
    figure._destroyResizeOwner = () => Promise.resolve();
    figure._previewSlot = {
      destroy() {
        return Promise.resolve();
      },
    };
    let destroySettled = false;
    const destroying = figure.destroy();
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

test('Figure preview retains its commit and publishes state only after the newest child commits', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const secondGate = deferred();
    const secondStarted = deferred();
    const newestGate = deferred();
    const newestStarted = deferred();
    const candidates = new Map();
    const plotDefinition = {
      async render(pageData, _options, candidate) {
        const owner = pageData[0].owner;
        candidate.dataset.owner = owner;
        candidates.set(owner, candidate);
        if (owner === 'second') {
          secondStarted.resolve();
          await secondGate.promise;
        }
        if (owner === 'newest') {
          newestStarted.resolve();
          await newestGate.promise;
        }
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('committed'), {
        revision: 'committed',
      });
      const committed = candidates.get('committed');

      const second = figure.renderPlot(
        'probe',
        makePageData('second'),
        { revision: 'second' },
      );
      await secondStarted.promise;
      const newest = figure.renderPlot(
        'probe',
        makePageData('newest'),
        { revision: 'newest' },
      );

      assert.equal(figure.getPlotElement(), committed);
      assert.equal(figure.getPageData()[0].owner, 'committed');
      assert.equal(figure.getOptions().revision, 'committed');
      assert.equal(committed.isConnected, true);

      secondGate.resolve();
      await newestStarted.promise;
      assert.equal(figure.getPlotElement(), committed);
      assert.equal(figure.getPageData()[0].owner, 'committed');
      assert.equal(purgeCounts.get(committed) ?? 0, 0);

      newestGate.resolve();
      assert.deepEqual(await Promise.all([second, newest]), [false, true]);
      assert.equal(figure.getPlotElement(), candidates.get('newest'));
      assert.equal(figure.getPageData()[0].owner, 'newest');
      assert.equal(figure.getOptions().revision, 'newest');
      assert.equal(committed.isConnected, false);
      assert.equal(purgeCounts.get(committed), 1);
      await figure.destroy();
    });
  });
});

test('Figure preview render bursts keep one running and coalesce pending work to newest', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const runningGate = deferred();
    const runningStarted = deferred();
    const newestStarted = deferred();
    const started = [];
    const plotDefinition = {
      async render(pageData, _options, candidate) {
        const owner = pageData[0].owner;
        started.push(owner);
        candidate.dataset.owner = owner;
        if (owner === 'running') {
          runningStarted.resolve();
          await runningGate.promise;
        }
        if (owner === 'newest') newestStarted.resolve();
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('committed'));
      const running = figure.renderPlot('probe', makePageData('running'));
      await runningStarted.promise;
      const middle = figure.renderPlot('probe', makePageData('middle'));
      const newest = figure.renderPlot('probe', makePageData('newest'));

      assert.deepEqual(started, ['committed', 'running']);
      runningGate.resolve();
      await newestStarted.promise;
      assert.deepEqual(
        await Promise.all([running, middle, newest]),
        [false, false, true],
      );
      assert.deepEqual(started, ['committed', 'running', 'newest']);
      assert.equal(figure.getPlotElement().dataset.owner, 'newest');
      await figure.destroy();
    });
  });
});

test('Figure modal option bursts coalesce to the newest option payload', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const firstGate = deferred();
    const firstStarted = deferred();
    const thirdStarted = deferred();
    const modalStarts = [];
    const plotDefinition = {
      async render(_pageData, options, candidate) {
        if (!candidate.classList.contains('analysis-modal-plot-candidate')) {
          return;
        }
        const mode = options.mode ?? 'initial';
        modalStarts.push(mode);
        candidate.dataset.owner = mode;
        if (mode === 'first') {
          firstStarted.resolve();
          await firstGate.promise;
        }
        if (mode === 'third') thirdStarted.resolve();
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('preview'));
      attachOwnedModal(figure, document);
      await figure._renderModalPlot();

      const first = figure._applyPlotOptionChange('mode', 'first');
      await firstStarted.promise;
      const second = figure._applyPlotOptionChange('mode', 'second');
      const third = figure._applyPlotOptionChange('mode', 'third');
      assert.deepEqual(modalStarts, ['initial', 'first']);
      assert.deepEqual(figure.getOptions(), {});

      firstGate.resolve();
      await thirdStarted.promise;
      assert.deepEqual(
        await Promise.all([first, second, third]),
        [false, false, true],
      );
      assert.deepEqual(modalStarts, ['initial', 'first', 'third']);
      assert.equal(figure.getModalPlotElement().dataset.owner, 'third');
      assert.equal(figure.getOptions().mode, 'third');
      await figure.destroy();
    });
  });
});

test('Figure PNG and SVG exports lease the exact committed child and block replacement commit', { concurrency: false }, async () => {
  await withFakeDOM(async ({
    document,
    downloadCalls,
    Plotly,
  }) => {
    const candidates = new Map();
    const renderStarts = [];
    const plotDefinition = {
      async render(pageData, _options, candidate) {
        const owner = pageData[0].owner;
        renderStarts.push(owner);
        candidate.dataset.owner = owner;
        candidates.set(owner, candidate);
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('initial'));

      for (const {
        exportMethod,
        format,
        replacementOwner,
      } of [
        {
          exportMethod: '_handleExportPNG',
          format: 'png',
          replacementOwner: 'after-png',
        },
        {
          exportMethod: '_handleExportSVG',
          format: 'svg',
          replacementOwner: 'after-svg',
        },
      ]) {
        const exportGate = deferred();
        const exportStarted = deferred();
        Plotly.downloadImage = async (candidate, options) => {
          downloadCalls.push({ candidate, options });
          exportStarted.resolve();
          await exportGate.promise;
        };
        const committed = figure.getPlotElement();
        const exporting = figure[exportMethod]();
        await exportStarted.promise;
        const replacement = figure.renderPlot(
          'probe',
          makePageData(replacementOwner),
        );
        await waitFor(
          () => renderStarts.includes(replacementOwner),
          `${replacementOwner} candidate render`,
        );
        let replacementSettled = false;
        void replacement.then(() => {
          replacementSettled = true;
        });
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();

        assert.equal(downloadCalls.at(-1).candidate, committed);
        assert.equal(downloadCalls.at(-1).options.format, format);
        assert.equal(replacementSettled, false);
        assert.equal(committed.isConnected, true);
        assert.equal(figure.getPlotElement(), committed);

        exportGate.resolve();
        assert.equal(await exporting, true);
        assert.equal(await replacement, true);
        assert.equal(
          figure.getPlotElement(),
          candidates.get(replacementOwner),
        );
        assert.equal(committed.isConnected, false);
      }
      await figure.destroy();
    });
  });
});

test('Figure generic beforeClose waits for a running modal candidate before purge or detach', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const runningGate = deferred();
    const runningStarted = deferred();
    let runningCandidate = null;
    const plotDefinition = {
      async render(_pageData, options, candidate) {
        candidate.dataset.owner = options.mode ?? 'initial';
        if (
          candidate.classList.contains('analysis-modal-plot-candidate') &&
          options.mode === 'running'
        ) {
          runningCandidate = candidate;
          runningStarted.resolve();
          await runningGate.promise;
        }
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('preview'));
      const modal = attachOwnedModal(figure, document);
      await figure._renderModalPlot();

      const rendering = figure._applyPlotOptionChange('mode', 'running');
      await runningStarted.promise;
      const closing = figure.closeModal();
      const closingAgain = figure.closeModal();

      assert.equal(closingAgain, closing);
      assert.equal(modal._cleanupDone, false);
      assert.equal(modal.isConnected, true);
      assert.equal(runningCandidate.isConnected, true);
      assert.equal(purgeCounts.get(runningCandidate) ?? 0, 0);
      assert.equal(purgeCounts.get(modal._plotContainer) ?? 0, 0);

      runningGate.resolve();
      assert.equal(await rendering, false);
      await Promise.all([closing, closingAgain]);
      assert.equal(modal._cleanupDone, true);
      assert.equal(purgeCounts.get(runningCandidate), 1);
      assert.equal(purgeCounts.get(modal._plotContainer), 1);

      await figure.closeModal();
      assert.equal(purgeCounts.get(runningCandidate), 1);
      assert.equal(purgeCounts.get(modal._plotContainer), 1);
      await figure.destroy();
    });
  });
});

for (const stateCase of [
  {
    label: 'empty',
    invoke(figure) {
      return figure.showEmpty('Nothing selected');
    },
    messageClass: 'analysis-empty-message',
  },
  {
    label: 'error',
    invoke(figure) {
      return figure.showError('Render unavailable');
    },
    messageClass: 'analysis-error',
  },
]) {
  test(`Figure ${stateCase.label} invalidation drains without detaching its running candidate`, { concurrency: false }, async () => {
    await withFakeDOM(async ({ document, purgeCounts }) => {
      const runningGate = deferred();
      const runningStarted = deferred();
      let runningCandidate = null;
      const plotDefinition = {
        async render(pageData, _options, candidate) {
          if (pageData[0].owner === 'running') {
            runningCandidate = candidate;
            runningStarted.resolve();
            await runningGate.promise;
          }
        },
      };

      await withPlotDefinition(plotDefinition, async () => {
        const figure = createFigure(document);
        await figure.renderPlot('probe', makePageData('committed'));
        const rendering = figure.renderPlot(
          'probe',
          makePageData('running'),
        );
        await runningStarted.promise;
        let stateSettled = false;
        const stateChange = stateCase.invoke(figure);
        void stateChange.then(() => {
          stateSettled = true;
        });
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();

        assert.equal(stateSettled, false);
        assert.equal(runningCandidate.isConnected, true);
        assert.equal(purgeCounts.get(runningCandidate) ?? 0, 0);

        runningGate.resolve();
        assert.equal(await rendering, false);
        assert.equal(await stateChange, true);
        assert.equal(runningCandidate.isConnected, false);
        assert.equal(purgeCounts.get(runningCandidate), 1);
        assert.ok(
          figure._previewContainer.querySelector(
            `.${stateCase.messageClass}`,
          ),
        );
        await figure.destroy();
      });
    });
  });
}

test('Figure ResizeObserver bursts coalesce Plotly resize leases on the exact committed child', { concurrency: false }, async () => {
  await withFakeDOM(async ({
    document,
    flushFrames,
    frames,
    observers,
    Plotly,
    resizeCalls,
  }) => {
    const firstResizeGate = deferred();
    const firstResizeStarted = deferred();
    Plotly.Plots.resize = async candidate => {
      resizeCalls.push(candidate);
      if (resizeCalls.length === 1) {
        firstResizeStarted.resolve();
        await firstResizeGate.promise;
      }
    };
    const plotDefinition = {
      async render(_pageData, _options, candidate) {
        candidate.dataset.owner = 'committed';
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('committed'));
      const committed = figure.getPlotElement();
      const previewObserver = observers[0];

      // The transactional slot already sized this exact child to the initial
      // host measurement. Exercise a real post-commit size change rather than
      // requiring a redundant Plotly resize at the unchanged dimensions.
      figure._previewContainer._rect.width = 680;
      previewObserver.trigger();
      previewObserver.trigger();
      previewObserver.trigger();
      assert.equal(frames.size, 1);
      flushFrames();
      await firstResizeStarted.promise;
      assert.deepEqual(resizeCalls, [committed]);

      previewObserver.trigger();
      previewObserver.trigger();
      previewObserver.trigger();
      assert.equal(frames.size, 0);
      firstResizeGate.resolve();
      await waitFor(() => frames.size === 1, 'coalesced resize frame');
      flushFrames();
      const resizeOwner = figure._resizeOwners.get(figure._previewSlot);
      await waitFor(
        () => resizeOwner.activeLease !== null,
        'second resize lease',
      );
      const secondResizeResult = await resizeOwner.activeLease;
      assert.deepEqual({
        callCount: resizeCalls.length,
        exactTargets: resizeCalls.every(candidate => candidate === committed),
        secondResizeResult,
      }, {
        callCount: 1,
        exactTargets: true,
        secondResizeResult: false,
      });

      await waitFor(
        () => resizeOwner.activeLease === null,
        'same-size resize lease settlement',
      );
      figure._previewContainer._rect.width = 800;
      previewObserver.trigger();
      previewObserver.trigger();
      previewObserver.trigger();
      assert.equal(frames.size, 1);
      flushFrames();
      await waitFor(
        () => resizeOwner.activeLease !== null,
        'changed-size resize lease',
      );
      assert.equal(await resizeOwner.activeLease, true);
      assert.deepEqual(resizeCalls, [committed, committed]);
      assert.equal(committed.isConnected, true);
      await figure.destroy();
    });
  });
});

test('Figure commit resizes the exact replacement child when its host changed during render', { concurrency: false }, async () => {
  await withFakeDOM(async ({
    document,
    flushFrames,
    frames,
    observers,
    Plotly,
    resizeCalls,
  }) => {
    const replacementGate = deferred();
    const replacementStarted = deferred();
    const candidates = new Map();
    Plotly.Plots.resize = async candidate => {
      resizeCalls.push(candidate);
    };
    const plotDefinition = {
      async render(pageData, _options, candidate) {
        const owner = pageData[0].owner;
        candidate.dataset.owner = owner;
        candidates.set(owner, candidate);
        if (owner === 'replacement') {
          replacementStarted.resolve();
          await replacementGate.promise;
        }
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('initial'));
      const initial = candidates.get('initial');
      const previewObserver = observers[0];
      const resizeOwner = figure._resizeOwners.get(figure._previewSlot);

      // A commit-aware implementation may schedule an initial exact-child
      // resize. Drain it so this test isolates the replacement transaction.
      if (frames.size > 0) flushFrames();
      if (resizeOwner.activeLease !== null) {
        await resizeOwner.activeLease;
      }
      await waitFor(
        () => resizeOwner.activeLease === null,
        'initial commit resize settlement',
      );
      resizeCalls.length = 0;

      const replacement = figure.renderPlot(
        'probe',
        makePageData('replacement'),
      );
      await replacementStarted.promise;

      // The replacement measured the old 640px box. While it is rendering,
      // ResizeObserver updates the still-committed old child and caches 720px.
      // That cache must not suppress resizing the different child at commit.
      figure._previewContainer._rect.width = 720;
      previewObserver.trigger();
      assert.equal(frames.size, 1);
      flushFrames();
      await waitFor(
        () => resizeOwner.activeLease !== null,
        'old child resize lease',
      );
      await resizeOwner.activeLease;
      await waitFor(
        () => resizeOwner.activeLease === null,
        'old child resize settlement',
      );
      assert.deepEqual(resizeCalls, [initial]);
      resizeCalls.length = 0;

      replacementGate.resolve();
      assert.equal(await replacement, true);
      const committedReplacement = candidates.get('replacement');
      assert.equal(figure.getPlotElement(), committedReplacement);

      await waitFor(
        () => frames.size === 1,
        'replacement commit resize frame',
      );
      flushFrames();
      await waitFor(
        () => resizeOwner.activeLease !== null,
        'replacement exact-child resize lease',
      );
      await resizeOwner.activeLease;
      assert.deepEqual(
        resizeCalls,
        [committedReplacement],
        'a previous child size cache cannot suppress the new child resize',
      );
      await figure.destroy();
    });
  });
});

test('Figure destroy strongly drains every simultaneously closing modal and preserves each close Promise', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const firstGate = deferred();
    const firstStarted = deferred();
    const secondGate = deferred();
    const secondStarted = deferred();
    const candidates = new Map();
    const plotDefinition = {
      async render(_pageData, options, candidate) {
        if (!candidate.classList.contains('analysis-modal-plot-candidate')) {
          return;
        }
        const owner = options.owner;
        candidate.dataset.owner = owner;
        candidates.set(owner, candidate);
        if (owner === 'first-closing') {
          firstStarted.resolve();
          await firstGate.promise;
        }
        if (owner === 'second-closing') {
          secondStarted.resolve();
          await secondGate.promise;
        }
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('preview'));

      const startModalRender = (modal, owner) => {
        const payload = figure._currentModalPayload({
          mergedOptions: { owner },
          options: { owner },
          plotType: plotDefinition,
        });
        return figure._renderModalPayload(payload, {
          figureGeneration: figure._renderGeneration,
          modal,
          optionGeneration: figure._optionGeneration,
        });
      };

      const firstModal = attachOwnedModal(figure, document);
      const firstRendering = startModalRender(
        firstModal,
        'first-closing',
      );
      await firstStarted.promise;
      const firstClosing = figure.closeModal();
      await waitFor(
        () => figure._modal === null,
        'first modal beforeClose ownership transfer',
      );
      const firstClosingAgain = figure.closeModal();

      const secondModal = attachOwnedModal(figure, document);
      const secondRendering = startModalRender(
        secondModal,
        'second-closing',
      );
      await secondStarted.promise;
      const secondClosing = figure.closeModal();
      await waitFor(
        () => figure._modal === null,
        'second modal beforeClose ownership transfer',
      );
      const secondClosingAgain = figure.closeModal();

      let destroySettled = false;
      const destroying = figure.destroy();
      void destroying.then(
        () => {
          destroySettled = true;
        },
        () => {
          destroySettled = true;
        },
      );
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      const destroySettledBeforeEitherRenderer = destroySettled;

      secondGate.resolve();
      assert.equal(await secondRendering, false);
      await secondClosing;
      const destroySettledAfterOnlySecondClosed = destroySettled;

      firstGate.resolve();
      assert.equal(await firstRendering, false);
      await Promise.all([
        firstClosing,
        firstClosingAgain,
        secondClosingAgain,
        destroying,
      ]);

      assert.deepEqual({
        destroySettledAfterOnlySecondClosed,
        destroySettledBeforeEitherRenderer,
        firstClosePromiseStable: firstClosingAgain === firstClosing,
        secondClosePromiseStable: secondClosingAgain === secondClosing,
      }, {
        destroySettledAfterOnlySecondClosed: false,
        destroySettledBeforeEitherRenderer: false,
        firstClosePromiseStable: true,
        secondClosePromiseStable: true,
      });
      assert.equal(purgeCounts.get(candidates.get('first-closing')), 1);
      assert.equal(purgeCounts.get(candidates.get('second-closing')), 1);
    });
  });
});

test('Figure destroy is referentially idempotent and drains each owned child exactly once', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document, purgeCounts }) => {
    const runningGate = deferred();
    const runningStarted = deferred();
    const candidates = new Map();
    const plotDefinition = {
      async render(pageData, _options, candidate) {
        const owner = pageData[0].owner;
        candidates.set(owner, candidate);
        if (owner === 'running') {
          runningStarted.resolve();
          await runningGate.promise;
        }
      },
    };

    await withPlotDefinition(plotDefinition, async () => {
      const figure = createFigure(document);
      await figure.renderPlot('probe', makePageData('committed'));
      const rendering = figure.renderPlot(
        'probe',
        makePageData('running'),
      );
      await runningStarted.promise;
      const runningCandidate = candidates.get('running');

      const destroying = figure.destroy();
      const destroyingAgain = figure.destroy();
      assert.equal(destroyingAgain, destroying);
      assert.equal(runningCandidate.isConnected, true);
      assert.equal(purgeCounts.get(runningCandidate) ?? 0, 0);

      runningGate.resolve();
      assert.equal(await rendering, false);
      await Promise.all([destroying, destroyingAgain]);
      assert.equal(purgeCounts.get(candidates.get('committed')), 1);
      assert.equal(purgeCounts.get(runningCandidate), 1);
      assert.equal(figure.container.children.length, 0);
      assert.equal(figure.destroy(), destroying);
    });
  });
});

test('Figure destroy preserves a same-turn interactive rejection exactly', { concurrency: false }, async () => {
  await withFakeDOM(async ({ document }) => {
    const sentinel = new Error('exact same-turn figure interaction failure');
    const figure = createFigure(document);

    figure._trackInteractiveTask(
      Promise.reject(sentinel),
      'same-turn figure interaction',
    );
    const destroying = figure.destroy();

    assert.equal(figure.destroy(), destroying);
    await assert.rejects(destroying, error => error === sentinel);
  });
});
