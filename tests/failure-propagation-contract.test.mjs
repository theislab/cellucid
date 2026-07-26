import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { closeModal } from '../assets/js/app/analysis/ui/components/modal.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { enableDebug } from '../assets/js/app/analysis/shared/debug-utils.js';
import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';

const exactFailureSurfaces = [
  '../assets/js/app/community-annotations/file-cache.js',
  '../assets/js/app/ui/modules/community-annotation-controls.js',
  '../assets/js/app/ui/modules/community-annotation-voting-modal.js',
  '../assets/js/app/analysis/plots/types/pieplot.js',
  '../assets/js/app/analysis/shared/debug-utils.js',
  '../assets/js/app/analysis/ui/components/modal.js',
  '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js',
];

test('assigned UI failure surfaces contain no empty catches or optional cleanup calls', async () => {
  for (const relativePath of exactFailureSurfaces) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*)?\}/,
      `${relativePath} must not swallow a caught failure`,
    );
    assert.doesNotMatch(
      source,
      /\?\.\s*(?:abort|close|disconnect|focus|preventDefault|remove|stopPropagation)\s*(?:\?\.)?\s*\(/,
      `${relativePath} must not make required cleanup or event operations optional`,
    );
  }
});

test('IndexedDB upgrade reports both the schema failure and abort failure', async () => {
  const previousIndexedDB = globalThis.indexedDB;
  const primaryError = new Error('schema creation failed');
  const cleanupError = new Error('transaction abort failed');
  const request = {
    result: {
      objectStoreNames: {
        contains() {
          return false;
        },
      },
      createObjectStore() {
        throw primaryError;
      },
    },
    transaction: {
      abort() {
        throw cleanupError;
      },
    },
  };
  globalThis.indexedDB = {
    open() {
      queueMicrotask(() => request.onupgradeneeded());
      return request;
    },
  };

  try {
    const cache = new CommunityAnnotationFileCache();
    await assert.rejects(
      () => cache._openDatabase(),
      error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primaryError, cleanupError]);
        return true;
      },
    );
  } finally {
    if (previousIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIndexedDB;
  }
});

test('debug enablement propagates storage failure before mutating debug state', () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const storageError = new Error('debug storage write failed');
  globalThis.window = {
    __CELLUCID_DEBUG__: false,
    location: { href: 'https://cellucid.example/' },
  };
  globalThis.localStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw storageError;
    },
    removeItem() {},
  };

  try {
    assert.throws(() => enableDebug(), error => error === storageError);
    assert.equal(globalThis.window.__CELLUCID_DEBUG__, false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('analysis modal teardown aggregates independent cleanup failures', () => {
  const firstError = new Error('first modal cleanup failed');
  const secondError = new Error('second modal cleanup failed');
  const modal = {
    _cleanupDone: false,
    _cleanupFns: [
      () => {
        throw firstError;
      },
      () => {
        throw secondError;
      },
    ],
    classList: {
      remove() {},
    },
    parentNode: null,
  };

  assert.throws(
    () => closeModal(modal),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [firstError, secondError]);
      return true;
    },
  );
});

test('form-based analysis requires concrete result rendering and propagates execution failure', async () => {
  const abstractUi = Object.create(FormBasedAnalysisUI.prototype);
  await assert.rejects(
    () => abstractUi._showResult({}),
    /_showResult\(\) must be implemented by subclass/,
  );

  const primaryError = new Error('analysis implementation failed');
  let failedNotification = null;
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui._isDestroyed = false;
  ui._isLoading = false;
  ui._getFormValues = () => ({});
  ui._validateForm = () => ({ valid: true });
  ui._formContainer = {
    querySelector() {
      return { disabled: false, textContent: 'Run Analysis' };
    },
  };
  ui._notifications = {
    loading() {
      return 'analysis-notification';
    },
    complete() {
      throw new Error('failed analysis must not complete its notification');
    },
    fail(id, message) {
      failedNotification = { id, message };
    },
  };
  ui._runAnalysisImpl = async () => {
    throw primaryError;
  };

  await assert.rejects(() => ui._runAnalysis(), error => error === primaryError);
  assert.deepEqual(failedNotification, {
    id: 'analysis-notification',
    message: 'Analysis failed: analysis implementation failed',
  });
});

test('form-based modal exports fail when no exact modal plot exists', async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class HTMLElement {};
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui._modal = null;

  try {
    await assert.rejects(
      () => ui._exportModalPNG(),
      /PNG export requires an open analysis modal plot/,
    );
    await assert.rejects(
      () => ui._exportModalSVG(),
      /SVG export requires an open analysis modal plot/,
    );
    assert.throws(
      () => ui._exportModalCSV(),
      /_exportModalCSV\(\) must be implemented by subclass/,
    );
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});
