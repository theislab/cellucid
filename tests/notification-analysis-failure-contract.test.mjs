import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  NotificationCenter,
  NotificationType,
} from '../assets/js/app/notification-center.js';
import {
  formatBytes,
  formatCompactNumber,
  formatDuration,
} from '../assets/js/app/notification-center/formatters.js';
import {
  AnalysisHistoryTracker,
} from '../assets/js/app/analysis/core/analysis-history.js';
import {
  createPlotContainer,
} from '../assets/js/app/analysis/shared/result-renderer.js';
import {
  FigureContainer,
} from '../assets/js/app/analysis/ui/shared/figure-container.js';
import {
  PlotRegistry,
} from '../assets/js/app/analysis/shared/plot-registry-utils.js';

function currentConfig() {
  return {
    analysisType: 'differential-expression',
    pageIds: ['treated', 'control'],
    variable: 'condition',
    plotType: 'volcanoplot',
    options: {},
  };
}

function createCancelButton() {
  const attributes = new Map();
  return {
    attributes,
    disabled: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.id = '';
    this._textContent = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  set textContent(value) {
    this._textContent = value;
    if (value === '') this.children = [];
  }

  get textContent() {
    return this._textContent;
  }
}

async function withDocument(documentValue, operation) {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const originalDocument = globalThis.document;
  globalThis.document = documentValue;
  try {
    return await operation();
  } finally {
    if (hadDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  }
}

function withSessionStorage(storage, operation) {
  const hadStorage = Object.hasOwn(globalThis, 'sessionStorage');
  const originalStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = storage;
  try {
    return operation();
  } finally {
    if (hadStorage) globalThis.sessionStorage = originalStorage;
    else delete globalThis.sessionStorage;
  }
}

test('notification cancellation publishes rejection and restores the control', async () => {
  const center = new NotificationCenter();
  const observed = [];
  center.error = (message, options) => {
    observed.push({ message, options });
  };
  const button = createCancelButton();
  const failure = new Error('synthetic cancellation failure');

  const outcome = await center._runCancelHandler(button, async () => {
    throw failure;
  });

  assert.equal(outcome, false);
  assert.equal(button.disabled, false);
  assert.equal(button.attributes.has('aria-disabled'), false);
  assert.deepEqual(observed, [{
    message: 'Cancel failed: synthetic cancellation failure',
    options: {
      category: 'default',
      title: 'Cancellation Error',
    },
  }]);
});

test('notification cancellation disables repeated activation after success', async () => {
  const center = new NotificationCenter();
  const button = createCancelButton();
  let calls = 0;

  const outcome = await center._runCancelHandler(button, () => {
    calls += 1;
  });

  assert.equal(outcome, true);
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.attributes.get('aria-disabled'), 'true');
});

test('notification and formatter inputs reject coercion and missing trackers', () => {
  const center = new NotificationCenter();

  assert.throws(
    () => center._updateNotification('missing', { message: 'update' }),
    /does not exist/i,
  );
  assert.throws(
    () => center._createNotificationElement('id', {
      type: NotificationType.INFO,
      category: 'unregistered-category',
      message: 'invalid',
    }),
    /unknown notification category/i,
  );
  assert.throws(() => formatBytes('1024'), /bytes must be/i);
  assert.throws(() => formatDuration(Number.NaN), /duration must be/i);
  assert.throws(() => formatCompactNumber('1000'), /number must be finite/i);
  assert.throws(
    () => center.updateDownload('missing', 0),
    /tracker.*does not exist/i,
  );
  assert.throws(
    () => center.error('exact message', null),
    /options must be a plain object/i,
  );
});

test('download zero-byte totals remain exact and tracker adoption is transactional', () => {
  const center = new NotificationCenter();
  const shown = [];
  center.show = options => {
    shown.push(options);
    return options.id;
  };

  const id = center.startDownload('Empty dataset', 0);
  assert.equal(center.downloadTrackers.has(id), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, NotificationType.PROGRESS);
  assert.equal(shown[0].progress, 100);

  const failedCenter = new NotificationCenter();
  failedCenter.show = () => {
    throw new Error('DOM publication rejected');
  };
  assert.throws(
    () => failedCenter.startDownload('Rejected dataset', 1),
    /DOM publication rejected/,
  );
  assert.equal(failedCenter.downloadTrackers.size, 0);
});

test('stale auto-dismiss timers cannot dismiss a newer id generation', async () => {
  const center = new NotificationCenter();
  const older = {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.INFO },
  };
  const newer = {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.INFO },
  };
  center.notifications.set('shared-id', older);
  center._scheduleDismiss('shared-id', older, 1);
  center.notifications.set('shared-id', newer);

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(center.notifications.get('shared-id'), newer);
});

test('analysis history accepts only the current config record', () => {
  const tracker = new AnalysisHistoryTracker();
  const id = tracker.record({
    datasetId: 'synthetic-dataset',
    config: currentConfig(),
    resultSummary: { cellCount: 8 },
    durationMs: 12.5,
  });

  assert.match(id, /^ah_/);
  assert.equal(tracker.getHistory()[0].config.analysisType, 'differential-expression');

  assert.throws(
    () => tracker.record({
      datasetId: 'synthetic-dataset',
      config: {
        type: 'differential-expression',
        pageIds: [],
        variableKey: 'condition',
        plotType: 'volcanoplot',
        options: {},
      },
    }),
    /config must contain exactly/i,
  );
});

test('analysis timing is an exact one-shot JSON record owner', () => {
  const tracker = new AnalysisHistoryTracker();
  const finish = tracker.startTiming({
    datasetId: 'synthetic-dataset',
    config: currentConfig(),
  });
  const id = finish({ cellCount: 0 });
  assert.match(id, /^ah_\d+_\d+$/);
  assert.throws(
    () => finish({ cellCount: 0 }),
    /exactly once/,
  );
  assert.throws(
    () => tracker.record({
      datasetId: 'synthetic-dataset',
      config: {
        ...currentConfig(),
        options: { unsupported: 1n },
      },
    }),
    /only JSON values/,
  );
});

test('analysis history rejects corrupt storage instead of opening empty', () => {
  withSessionStorage({
    getItem() {
      return '{not-json';
    },
    setItem() {},
  }, () => {
    assert.throws(
      () => new AnalysisHistoryTracker({ persistToStorage: true }),
      SyntaxError,
    );
  });
});

test('analysis history persistence failure leaves memory unchanged', () => {
  withSessionStorage({
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('synthetic storage failure');
    },
  }, () => {
    const tracker = new AnalysisHistoryTracker({ persistToStorage: true });
    assert.throws(
      () => tracker.record({
        datasetId: 'synthetic-dataset',
        config: currentConfig(),
      }),
      /synthetic storage failure/i,
    );
    assert.deepEqual(tracker.getHistory(), []);
  });
});

test('analysis history listener failures are aggregated after every listener runs', () => {
  const tracker = new AnalysisHistoryTracker();
  const calls = [];
  tracker.on('record', () => {
    calls.push('first');
    throw new Error('first observer failed');
  });
  tracker.on('record', () => {
    calls.push('second');
    throw new Error('second observer failed');
  });

  assert.throws(
    () => tracker.record({
      datasetId: 'synthetic-dataset',
      config: currentConfig(),
    }),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 2
    ),
  );
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(tracker.getHistory().length, 1);
});

test('plot container shows and propagates the exact renderer failure', async () => {
  await withDocument({
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  }, async () => {
    const parent = new FakeElement('div');
    const container = createPlotContainer(parent, { id: 'exact-plot' });
    const failure = new Error('synthetic plot failure');
    const originalGet = PlotRegistry.get;
    PlotRegistry.get = () => ({
      async render() {
        throw failure;
      },
    });
    try {
      await assert.rejects(
        container.render('synthetic-plot', [], {}),
        error => error === failure,
      );
    } finally {
      PlotRegistry.get = originalGet;
    }

    assert.equal(container.element.children.length, 1);
    assert.equal(
      container.element.children[0].textContent,
      'Failed to render plot: synthetic plot failure',
    );
  });
});

test('FigureContainer public render rejects after publishing its visible error', async () => {
  const figure = Object.create(FigureContainer.prototype);
  const observed = [];
  figure._destroyed = false;
  figure._renderGeneration = 0;
  figure._cleanup = () => {};
  figure.showLoading = () => {};
  figure.showError = message => {
    observed.push(message);
  };
  const originalGet = PlotRegistry.get;
  PlotRegistry.get = () => null;
  try {
    await assert.rejects(
      figure.renderPlot('missing-plot', [{ pageId: 'page-a', pageName: 'A' }]),
      /unknown plot type.*missing-plot/i,
    );
  } finally {
    PlotRegistry.get = originalGet;
  }
  assert.deepEqual(observed, ['Failed to render plot: Unknown plot type: missing-plot']);
});

test('FigureContainer uses canonical category kind and owned layout color map', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/analysis/ui/shared/figure-container.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    source,
    /_currentVariableKind === 'category'\s*\?\s*'categorical_obs'/,
  );
  assert.doesNotMatch(source, /\.setCustomColors\(/);

  const figure = Object.create(FigureContainer.prototype);
  figure._destroyed = false;
  figure.customColors = new Map();
  figure._layoutEngine = {
    pageIds: ['page-a'],
    customColors: new Map(),
  };
  figure.setCustomColors(new Map([['page-a', '#123456']]));
  assert.deepEqual(
    [...figure._layoutEngine.customColors],
    [['page-a', '#123456']],
  );
});

test('owned notification and analysis files contain no swallowed console failure path', async () => {
  const urls = [
    '../assets/js/app/notification-center.js',
    '../assets/js/app/notification-center/download-tracking.js',
    '../assets/js/app/notification-center/benchmark-notifications.js',
    '../assets/js/app/analysis/core/analysis-history.js',
    '../assets/js/app/analysis/shared/result-renderer.js',
    '../assets/js/app/analysis/ui/shared/figure-container.js',
  ].map(path => new URL(path, import.meta.url));
  const source = (await Promise.all(urls.map(url => readFile(url, 'utf8')))).join('\n');

  assert.doesNotMatch(source, /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/[/*][^\n]*\s*)?\}/);
  assert.doesNotMatch(source, /console\.(?:warn|error)\s*\(/);
});
