import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { QuickInsights } from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';

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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createConnectedContainer(...ownedHosts) {
  let html = 'mounted';
  return {
    closest() {
      return null;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
      if (html === '') {
        for (const host of ownedHosts) host.isConnected = false;
      }
    },
    querySelector() {
      return null;
    },
  };
}

function installBaseState(owner, container = null) {
  let generation = 0;
  owner._isDestroyed = false;
  owner._analysisRequestTracker = {
    next() {
      generation += 1;
      return generation;
    },
    isCurrent(requestId) {
      return requestId === generation;
    },
  };
  owner._analysisInvalidationOwner = null;
  owner._activeAnalysisRequestId = null;
  owner._updateTimer = null;
  owner._modal = null;
  owner._container = container;
  owner._previewContainer = null;
  owner._actionsContainer = null;
  owner._currentPageData = {};
  owner._selectedPages = ['page-a'];
  owner._lastResult = {};
  owner._isLoading = false;
}

function installFormState(owner, container = null) {
  installBaseState(owner, container);
  owner._destroyPromise = null;
  owner._formContainer = {};
  owner._resultContainer = {
    classList: {
      add() {},
    },
    innerHTML: '',
    querySelector() {
      return null;
    },
  };
  owner._plotContainerId = null;
  owner._previewPlotHost = null;
  owner._previewPlotSlot = null;
  owner._modalPlotSlot = null;
  owner._pendingModalCloseTasks = new Set();
  owner._requestedPlotOptions = {};
  owner._optionRenderRevision = 0;
}

function observedRejection(error) {
  const promise = Promise.reject(error);
  void promise.catch(() => {});
  return promise;
}

function errorLeaves(error) {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(errorLeaves);
  }
  return [error];
}

test(
  'BaseAnalysisUI destruction is a stable task and keeps owned DOM connected until async cleanup settles',
  async () => {
    const cleanup = deferred();
    const host = { isConnected: true };
    const owner = Object.create(BaseAnalysisUI.prototype);
    installBaseState(owner, createConnectedContainer(host));
    let cleanupCalls = 0;
    owner._cleanupPreviousAnalysis = () => {
      cleanupCalls += 1;
      return cleanup.promise;
    };

    const first = owner.destroy();
    const repeated = owner.destroy();
    const connectedBeforeCleanupSettled = host.isConnected;

    cleanup.resolve();
    await Promise.all([
      Promise.resolve(first),
      Promise.resolve(repeated),
    ]);

    assert.equal(isThenable(first), true);
    assert.equal(repeated, first);
    assert.equal(cleanupCalls, 1);
    assert.equal(connectedBeforeCleanupSettled, true);
    assert.equal(host.isConnected, false);
  },
);

test(
  'BaseAnalysisUI destruction preserves a same-turn interactive rejection exactly',
  async () => {
    const sentinel = new Error('exact same-turn base interaction failure');
    const owner = Object.create(BaseAnalysisUI.prototype);
    installBaseState(owner);
    owner._notifications = { error() {} };

    owner._trackInteractiveTask(
      Promise.reject(sentinel),
      'same-turn base interaction',
    );
    const destroying = owner.destroy();

    assert.equal(owner.destroy(), destroying);
    await assert.rejects(destroying, error => error === sentinel);
  },
);

test(
  'BaseAnalysisUI installs its stable destruction task before synchronous invalidation cleanup',
  async () => {
    const sentinel = new Error('exact synchronous invalidation cleanup failure');
    const owner = Object.create(BaseAnalysisUI.prototype);
    installBaseState(owner);
    const requestId = owner._startAnalysisRequest();
    owner._registerAnalysisInvalidationCleanup(requestId, () => {
      throw sentinel;
    });

    let destroying;
    assert.doesNotThrow(() => {
      destroying = owner.destroy();
    });
    assert.equal(isThenable(destroying), true);
    assert.equal(owner.destroy(), destroying);
    await assert.rejects(destroying, error => error === sentinel);
  },
);

test(
  'FormBasedAnalysisUI keeps preview and modal plot owners connected until both retirement tasks settle',
  async () => {
    const previewRetirement = deferred();
    const modalRenderRetirement = deferred();
    const previewHost = { isConnected: true };
    const modalHost = { isConnected: true };
    const owner = Object.create(FormBasedAnalysisUI.prototype);
    installFormState(owner, createConnectedContainer(previewHost));

    let previewDestroyCalls = 0;
    owner._previewPlotHost = previewHost;
    owner._previewPlotSlot = {
      destroy() {
        previewDestroyCalls += 1;
        return previewRetirement.promise;
      },
    };
    const modalCloseTask = modalRenderRetirement.promise.then(() => {
      modalHost.isConnected = false;
    });
    owner._pendingModalCloseTasks.add(modalCloseTask);

    const first = owner.destroy();
    const repeated = owner.destroy();
    const initiallyConnected = {
      modal: modalHost.isConnected,
      preview: previewHost.isConnected,
    };

    previewRetirement.resolve();
    await flushMicrotasks();
    const afterPreviewOnly = {
      modal: modalHost.isConnected,
      preview: previewHost.isConnected,
    };

    modalRenderRetirement.resolve();
    await Promise.resolve(first);

    assert.equal(isThenable(first), true);
    assert.equal(repeated, first);
    assert.equal(previewDestroyCalls, 1);
    assert.deepEqual(initiallyConnected, { modal: true, preview: true });
    assert.deepEqual(afterPreviewOnly, { modal: true, preview: true });
    assert.equal(modalHost.isConnected, false);
    assert.equal(previewHost.isConnected, false);
  },
);

test(
  'DetailedAnalysisUI destruction preserves one owner across preview and modal retirement',
  async () => {
    const previewRetirement = deferred();
    const modalRetirement = deferred();
    const host = { isConnected: true };
    const owner = Object.create(DetailedAnalysisUI.prototype);
    installBaseState(owner, createConnectedContainer(host));
    owner._destroyPromise = null;
    owner._modalRenderGeneration = 0;
    owner._variableSelector = null;
    owner._pageSelector = null;
    owner._pageSelectContainer = null;
    owner._savedPlotOptions = new Map();
    owner._previewPlotSlot = {
      destroy() {
        return previewRetirement.promise;
      },
    };
    owner._modalPlotSlot = null;
    owner._pendingModalCloseTasks = new Set([modalRetirement.promise]);
    owner._layoutEngine = {};

    const first = owner.destroy();
    const repeated = owner.destroy();
    const connectedInitially = host.isConnected;

    previewRetirement.resolve();
    await flushMicrotasks();
    const connectedWhileModalRetires = host.isConnected;
    modalRetirement.resolve();
    await first;

    assert.equal(isThenable(first), true);
    assert.equal(repeated, first);
    assert.equal(connectedInitially, true);
    assert.equal(connectedWhileModalRetires, true);
    assert.equal(host.isConnected, false);
  },
);

test(
  'DetailedAnalysisUI installs its stable destruction task before synchronous invalidation cleanup',
  async () => {
    const sentinel = new Error(
      'exact detailed synchronous invalidation cleanup failure',
    );
    const owner = Object.create(DetailedAnalysisUI.prototype);
    installBaseState(owner);
    owner._destroyPromise = null;
    owner._modalRenderGeneration = 0;
    owner._variableSelector = null;
    owner._pageSelector = null;
    owner._pageSelectContainer = null;
    owner._savedPlotOptions = new Map();
    owner._previewPlotSlot = null;
    owner._modalPlotSlot = null;
    owner._pendingModalCloseTasks = new Set();
    owner._layoutEngine = {};
    const requestId = owner._startAnalysisRequest();
    owner._registerAnalysisInvalidationCleanup(requestId, () => {
      throw sentinel;
    });

    let destroying;
    assert.doesNotThrow(() => {
      destroying = owner.destroy();
    });
    assert.equal(isThenable(destroying), true);
    assert.equal(owner.destroy(), destroying);
    await assert.rejects(destroying, error => error === sentinel);
  },
);

test(
  'Correlation, Signature, Genes, and Quick Insights preserve the exact superclass destruction task',
  async t => {
    const formTask = Promise.resolve();
    const baseTask = Promise.resolve();
    t.mock.method(FormBasedAnalysisUI.prototype, 'destroy', () => formTask);
    t.mock.method(BaseAnalysisUI.prototype, 'destroy', () => baseTask);

    const correlation = Object.create(CorrelationAnalysisUI.prototype);
    correlation._destroyPromise = null;
    correlation._xSelector = null;
    correlation._ySelector = null;
    correlation._pageSelector = null;
    correlation._colorByVariable = null;

    const signature = Object.create(GeneSignatureUI.prototype);
    signature._destroyPromise = null;
    signature._pageSelector = null;

    const genes = Object.create(GenesPanelUI.prototype);
    genes._destroyPromise = null;
    genes._progressTracker = null;
    genes._controller = null;
    genes._teardownHoverContext = () => {};

    const quick = Object.create(QuickInsights.prototype);
    quick._destroyPromise = null;
    quick._currentRequestId = 0;
    quick._abortController = null;
    quick._debounceTimer = null;
    quick._cache = new Map();
    quick._fieldPickers = { categorical: null, continuous: null };
    quick._pageSelector = null;
    quick._detailsToggleListener = null;
    quick._container = null;

    const first = {
      correlation: correlation.destroy(),
      genes: genes.destroy(),
      quick: quick.destroy(),
      signature: signature.destroy(),
    };
    const repeated = {
      correlation: correlation.destroy(),
      genes: genes.destroy(),
      quick: quick.destroy(),
      signature: signature.destroy(),
    };

    assert.deepEqual(
      {
        correlation: first.correlation === formTask,
        genes: first.genes === formTask,
        quick: first.quick === baseTask,
        signature: first.signature === formTask,
      },
      {
        correlation: true,
        genes: true,
        quick: true,
        signature: true,
      },
    );
    assert.equal(repeated.correlation, first.correlation);
    assert.equal(repeated.signature, first.signature);
    assert.equal(repeated.genes, first.genes);
    assert.equal(repeated.quick, first.quick);
  },
);

test(
  'GenesPanelUI keeps plot hosts connected until preview, modal, and controller retirement all settle',
  async () => {
    const previewRetirement = deferred();
    const modalRetirement = deferred();
    const controllerRetirement = deferred();
    const host = { isConnected: true };
    const owner = Object.create(GenesPanelUI.prototype);
    installFormState(owner, createConnectedContainer(host));
    owner._progressTracker = null;
    owner._teardownHoverContext = () => {};
    owner._notifications = { error() {} };
    owner._controller = {
      close() {
        return controllerRetirement.promise;
      },
    };
    owner._previewPlotHost = host;
    owner._previewPlotSlot = {
      destroy() {
        return previewRetirement.promise;
      },
    };
    owner._pendingModalCloseTasks.add(modalRetirement.promise);

    const first = owner.destroy();
    const repeated = owner.destroy();
    const connectedInitially = host.isConnected;

    previewRetirement.resolve();
    modalRetirement.resolve();
    await flushMicrotasks();
    const connectedWhileControllerRetires = host.isConnected;

    controllerRetirement.resolve();
    await Promise.resolve(first);

    assert.equal(isThenable(first), true);
    assert.equal(repeated, first);
    assert.equal(connectedInitially, true);
    assert.equal(connectedWhileControllerRetires, true);
    assert.equal(host.isConnected, false);
  },
);

test(
  'GenesPanelUI aggregates exact controller, plot-slot, and base-cleanup failures into its returned destruction task',
  async () => {
    const controllerFailure = new Error('exact marker controller close failure');
    const slotFailure = new Error('exact preview plot slot failure');
    const baseFailure = new Error('exact base cleanup failure');
    const controllerTask = observedRejection(controllerFailure);
    const slotTask = observedRejection(slotFailure);
    const baseTask = observedRejection(baseFailure);
    const owner = Object.create(GenesPanelUI.prototype);
    installFormState(owner);
    owner._progressTracker = null;
    owner._teardownHoverContext = () => {};
    owner._notifications = { error() {} };
    owner._controller = {
      close() {
        return controllerTask;
      },
    };
    owner._previewPlotSlot = {
      destroy() {
        return slotTask;
      },
    };
    owner._cleanupPreviousAnalysis = () => baseTask;

    const destruction = owner.destroy();
    const repeated = owner.destroy();

    assert.equal(isThenable(destruction), true);
    assert.equal(repeated, destruction);
    await assert.rejects(
      destruction,
      error => {
        const leaves = errorLeaves(error);
        assert.equal(leaves.includes(controllerFailure), true);
        assert.equal(leaves.includes(slotFailure), true);
        assert.equal(leaves.includes(baseFailure), true);
        return true;
      },
    );
  },
);

for (const [label, UIClass] of [
  ['CorrelationAnalysisUI', CorrelationAnalysisUI],
  ['GeneSignatureUI', GeneSignatureUI],
]) {
  test(
    `${label} hide-result waits for its current plot owner before clearing the result DOM`,
    async () => {
      const retirement = deferred();
      const candidate = { isConnected: true };
      const resultContainer = createConnectedContainer(candidate);
      resultContainer.classList = { add() {} };
      resultContainer.querySelector = selector => (
        selector === '.analysis-preview-plot' ? candidate : null
      );
      const owner = Object.create(UIClass.prototype);
      owner._previewPlotSlot = {
        invalidate() {
          return retirement.promise.then(() => {
            candidate.isConnected = false;
          });
        },
      };
      owner._resultContainer = resultContainer;
      owner._lastResult = {};
      owner._currentPageData = {};

      const hiding = owner._hideResult();
      const connectedBeforeRetirement = candidate.isConnected;
      retirement.resolve();
      await Promise.resolve(hiding);

      assert.equal(isThenable(hiding), true);
      assert.equal(connectedBeforeRetirement, true);
      assert.equal(candidate.isConnected, false);
      assert.equal(owner._lastResult, null);
      assert.equal(owner._currentPageData, null);
    },
  );
}
