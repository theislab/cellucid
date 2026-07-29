import assert from 'node:assert/strict';
import test from 'node:test';

import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function correlationForm(owner) {
  return {
    owner,
    variableX: { type: 'continuous_obs', key: `x-${owner}` },
    variableY: { type: 'continuous_obs', key: `y-${owner}` },
  };
}

function createAutoAnalysisHarness(UIClass, formValues) {
  const ui = new UIClass({
    comparisonModule: {},
    dataLayer: {},
    multiVariableAnalysis: {},
  });
  const pendingByOwner = new Map();
  const renders = [];
  const errors = [];
  const forms = [...formValues];

  ui._canRunAnalysis = () => true;
  ui._getFormValues = () => forms.shift();
  ui._runAnalysisImpl = ({ owner }) => {
    const pending = deferred();
    pendingByOwner.set(owner, pending);
    return pending.promise;
  };
  ui._showResult = async result => {
    renders.push(result.owner);
  };
  ui._showError = message => {
    errors.push(message);
  };

  return { errors, pendingByOwner, renders, ui };
}

class ManualFormHarness extends FormBasedAnalysisUI {
  static getRequirements() {
    return { minPages: 0 };
  }

  _getTitle() {
    return 'Manual';
  }

  _getDescription() {
    return 'Manual request harness';
  }

  _renderFormControls() {}

  _getFormValues() {
    return {};
  }

  async _showResult() {}
}

for (const analysisCase of [
  {
    label: 'Correlation',
    UIClass: CorrelationAnalysisUI,
    forms: [correlationForm('older'), correlationForm('newer')],
  },
  {
    label: 'Gene Signature',
    UIClass: GeneSignatureUI,
    forms: [{ owner: 'older' }, { owner: 'newer' }],
  },
]) {
  test(`${analysisCase.label} publishes only the newest out-of-order completion`, async () => {
    const {
      pendingByOwner,
      renders,
      ui,
    } = createAutoAnalysisHarness(analysisCase.UIClass, analysisCase.forms);

    const olderRun = ui._runAnalysisIfValid();
    const newerRun = ui._runAnalysisIfValid();

    try {
      pendingByOwner.get('older').resolve({
        owner: 'older',
        data: { owner: 'older' },
      });
      await olderRun;

      assert.deepEqual(
        renders,
        [],
        'an older completion must not render while a newer request is pending',
      );
      assert.equal(
        ui.isLoading(),
        true,
        'an older finally block must not clear the newer loading generation',
      );

      pendingByOwner.get('newer').resolve({
        owner: 'newer',
        data: { owner: 'newer' },
      });
      await newerRun;

      assert.deepEqual(renders, ['newer']);
      assert.equal(ui.getLastResult().owner, 'newer');
      assert.equal(ui._currentPageData.owner, 'newer');
      assert.equal(ui.isLoading(), false);
    } finally {
      pendingByOwner.get('older')?.resolve({
        owner: 'older',
        data: { owner: 'older' },
      });
      pendingByOwner.get('newer')?.resolve({
        owner: 'newer',
        data: { owner: 'newer' },
      });
      await Promise.allSettled([olderRun, newerRun]);
    }
  });

  test(`${analysisCase.label} suppresses stale failure publication`, async () => {
    const {
      errors,
      pendingByOwner,
      renders,
      ui,
    } = createAutoAnalysisHarness(analysisCase.UIClass, analysisCase.forms);

    const olderRun = ui._runAnalysisIfValid();
    const newerRun = ui._runAnalysisIfValid();

    try {
      pendingByOwner.get('older').reject(new Error('older failure'));
      await olderRun;

      assert.deepEqual(errors, []);
      assert.deepEqual(renders, []);
      assert.equal(
        ui.isLoading(),
        true,
        'a stale failure must not end the newer loading generation',
      );

      pendingByOwner.get('newer').resolve({
        owner: 'newer',
        data: { owner: 'newer' },
      });
      await newerRun;

      assert.deepEqual(errors, []);
      assert.deepEqual(renders, ['newer']);
      assert.equal(ui.getLastResult().owner, 'newer');
      assert.equal(ui.isLoading(), false);
    } finally {
      pendingByOwner.get('older')?.resolve({
        owner: 'older',
        data: { owner: 'older' },
      });
      pendingByOwner.get('newer')?.resolve({
        owner: 'newer',
        data: { owner: 'newer' },
      });
      await Promise.allSettled([olderRun, newerRun]);
    }
  });

  test(`${analysisCase.label} does not adopt result data before its render commits`, async () => {
    const renderStarted = deferred();
    const renderSettlement = deferred();
    const {
      pendingByOwner,
      ui,
    } = createAutoAnalysisHarness(analysisCase.UIClass, [
      analysisCase.forms[0],
    ]);
    ui._showResult = async () => {
      renderStarted.resolve();
      await renderSettlement.promise;
    };

    const run = ui._runAnalysisIfValid();
    pendingByOwner.get('older').resolve({
      owner: 'older',
      data: { owner: 'older' },
    });
    await renderStarted.promise;

    ui._invalidateAnalysisRequest();
    renderSettlement.resolve();
    await run;

    assert.equal(
      ui.getLastResult(),
      null,
      'an invalidated render candidate must not become the exported result',
    );
    assert.equal(
      ui._currentPageData,
      null,
      'an invalidated render candidate must not become exported page data',
    );
    assert.equal(ui.isLoading(), false);
  });
}

test('manual form invalidation immediately releases its button and suppresses stale rejection', async () => {
  const implementation = deferred();
  const terminal = [];
  const button = { disabled: false, textContent: 'Run Analysis' };
  const ui = new ManualFormHarness({
    comparisonModule: {},
    dataLayer: {},
  });
  ui._formContainer = {
    querySelector() {
      return button;
    },
  };
  ui._validateForm = () => ({ valid: true });
  ui._runAnalysisImpl = () => implementation.promise;
  ui._notifications = {
    loading() {
      return 'manual-A';
    },
    complete(id) {
      terminal.push(['complete', id]);
    },
    fail(id) {
      terminal.push(['fail', id]);
    },
    dismiss(id) {
      terminal.push(['dismiss', id]);
    },
  };

  const run = ui._runAnalysis();
  assert.deepEqual(button, {
    disabled: true,
    textContent: 'Running...',
  });

  ui._invalidateAnalysisRequest();
  assert.deepEqual(
    button,
    { disabled: false, textContent: 'Run Analysis' },
    'input invalidation must make the same visible Run control usable immediately',
  );

  implementation.reject(new Error('stale implementation failure'));
  await run;
  assert.deepEqual(terminal, [['dismiss', 'manual-A']]);
  assert.equal(ui.getLastResult(), null);
  assert.equal(ui.isLoading(), false);
});

test('a newer manual form run never captures an older Running label', async () => {
  const older = deferred();
  const newer = deferred();
  const pending = [older, newer];
  const button = { disabled: false, textContent: 'Run Analysis' };
  const ui = new ManualFormHarness({
    comparisonModule: {},
    dataLayer: {},
  });
  ui._formContainer = {
    querySelector() {
      return button;
    },
  };
  ui._validateForm = () => ({ valid: true });
  ui._runAnalysisImpl = () => pending.shift().promise;
  ui._notifications = {
    loading() {
      return `manual-${pending.length}`;
    },
    complete() {},
    fail() {},
    dismiss() {},
  };

  const olderRun = ui._runAnalysis();
  const newerRun = ui._runAnalysis();
  newer.resolve({ data: { owner: 'newer' } });
  await newerRun;

  assert.deepEqual(button, {
    disabled: false,
    textContent: 'Run Analysis',
  });
  assert.equal(ui.getLastResult().data.owner, 'newer');

  older.resolve({ data: { owner: 'older' } });
  await olderRun;
  assert.equal(ui.getLastResult().data.owner, 'newer');
  assert.deepEqual(button, {
    disabled: false,
    textContent: 'Run Analysis',
  });
});

test('manual form highlight changes invalidate active scientific ownership', () => {
  const ui = new ManualFormHarness({
    comparisonModule: {},
    dataLayer: {},
  });
  ui._updatePageSelectorCounts = () => {};
  const requestId = ui._startAnalysisRequest();
  let cleanups = 0;
  ui._registerAnalysisInvalidationCleanup(requestId, () => {
    cleanups += 1;
  });

  ui.onHighlightChanged();

  assert.equal(ui._isCurrentAnalysisRequest(requestId), false);
  assert.equal(cleanups, 1);
});

test('DE comparison changes invalidate active scientific ownership immediately', () => {
  const ui = new DEAnalysisUI({
    comparisonModule: {},
    dataLayer: {
      getCellCountForPageId() {
        return 1;
      },
    },
  });
  const requestId = ui._startAnalysisRequest();
  let cleanups = 0;
  ui._registerAnalysisInvalidationCleanup(requestId, () => {
    cleanups += 1;
  });

  ui._handleComparisonChange(['page-A', 'page-B']);

  assert.equal(ui._isCurrentAnalysisRequest(requestId), false);
  assert.equal(cleanups, 1);
});

test('DE progress updates mutate only their request-local tracker', () => {
  const calls = [];
  const makeTracker = owner => ({
    setPhase(value) {
      calls.push([owner, 'phase', value]);
    },
    setTotalItems(value) {
      calls.push([owner, 'total', value]);
    },
    setCompletedItems(value) {
      calls.push([owner, 'completed', value]);
    },
    setMessage(value) {
      calls.push([owner, 'message', value]);
    },
  });
  const ui = Object.create(DEAnalysisUI.prototype);
  const olderTracker = makeTracker('older');
  ui._progressTracker = makeTracker('newer');

  ui._updateProgress({
    phase: 'Loading & Computing',
    progress: 50,
    loaded: 1,
    total: 2,
    message: 'One of two',
  }, olderTracker);

  assert.deepEqual(calls, [
    ['older', 'phase', 'Loading & Computing'],
    ['older', 'total', 2],
    ['older', 'completed', 1],
    ['older', 'message', 'One of two'],
  ]);
});

test('differential expression stops before data access when its owner is stale', async () => {
  const accessError = new Error('stale DE reached dataset access');
  const analysis = new MultiVariableAnalysis({
    state: { pointCount: 10 },
    getAvailableVariables() {
      throw accessError;
    },
  });

  const result = await analysis.differentialExpression({
    pageA: 'page-A',
    pageB: 'page-B',
    method: 'wilcox',
    isCurrent: () => false,
    registerInvalidationCleanup() {},
  });
  assert.equal(result, null);
});
