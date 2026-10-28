import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { closeModal } from '../assets/js/app/analysis/ui/components/modal.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { createRequestIdTracker } from '../assets/js/app/jobs/cancellable-job.js';
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
  const shown = [];
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui._isDestroyed = false;
  ui._isLoading = false;
  ui._analysisRequestTracker = createRequestIdTracker();
  ui._activeAnalysisRequestId = null;
  ui._analysisInvalidationOwner = null;
  ui._getTitle = () => 'Manual';
  ui._options = {};
  ui._selectedPages = [];
  ui._runRow = null;
  ui._highlightRevision = 0;
  ui._notifications = {
    error(message) {
      shown.push(message);
    },
  };
  ui._runAnalysisImpl = async () => {
    throw primaryError;
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await ui._runAnalysis();
  } finally {
    console.error = originalError;
  }
  // The failure ends the run's job, which says why once (here, before its
  // progress notification showed, as an error notification).
  assert.equal(ui._shownJob.state, 'failed');
  assert.equal(ui._shownJob.message, primaryError.message);
  assert.deepEqual(shown, ['Manual failed: analysis implementation failed']);
  assert.equal(errors.length, 1, 'and is logged once');
  assert.equal(errors[0][1], primaryError);
});

test('form-based modal exports fail when no exact modal plot exists', async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class HTMLElement {};
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui._modal = null;
  ui._lastResult = null;
  ui._resultInputs = null;

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
