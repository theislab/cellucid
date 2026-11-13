/**
 * The expanded overlay must show the analysis the sidebar shows.
 *
 * With the Gene Signature overlay open, changing the gene list re-runs the
 * analysis and moves the sidebar preview to the new result, and the overlay
 * follows it, its title naming the new gene set: two surfaces never show two
 * different scientific results.
 *
 * Every form-based mode publishes its result through one owner, which
 * refreshes the open overlay; were each mode to assign `_lastResult` inline,
 * the overlay would stay bound to the result current when it opened and there
 * would be nowhere for a refresh to live. Detailed analysis refreshes its open
 * modal itself (`detailed-analysis-ui.js` `_updateModal`).
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  FormBasedAnalysisUI,
} from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { closeModal } from '../assets/js/app/analysis/ui/components/modal.js';
import { PlotRegistry } from '../assets/js/app/analysis/shared/plot-registry-utils.js';
import { settleMicrotasks, waitFor, withControlledTimers, withFakeDOM } from './helpers/fake-analysis-modal-dom.mjs';

const ANALYSIS_TYPES_DIR = new URL(
  '../assets/js/app/analysis/ui/analysis-types/',
  import.meta.url,
);

/** A FormBasedAnalysisUI with only the state `_publishAnalysisResult` reads. */
function publisher() {
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui._isDestroyed = false;
  ui._modal = null;
  ui._lastResult = null;
  ui._currentPageData = null;
  ui._requestedPlotOptions = null;
  ui._activeAnalysisRequestId = null;
  ui.renders = [];
  ui._renderExpandedViewContent = async (modal, result) => {
    ui.renders.push({ modal, result });
    return true;
  };
  return ui;
}

const RESULT_A = Object.freeze({
  data: [{ pageId: 'page-1', values: [1, 2] }],
  options: { showBox: true },
  plotType: 'violinplot',
  title: 'Gene Signature Score',
  subtitle: '3 genes: A, B, C',
});
const RESULT_B = Object.freeze({
  data: [{ pageId: 'page-1', values: [7, 8] }],
  options: { showBox: true },
  plotType: 'violinplot',
  title: 'Gene Signature Score',
  subtitle: '4 genes: D, E, F, G',
});

test('publishing a new result re-draws an overlay that is already open', async () => {
  const ui = publisher();
  const modal = { id: 'overlay' };

  await ui._publishAnalysisResult(RESULT_A);
  ui._modal = modal;
  await ui._publishAnalysisResult(RESULT_A);
  assert.deepEqual(
    ui.renders.map(entry => entry.result),
    [RESULT_A],
    'only the publication made while the overlay was open may draw it',
  );

  await ui._publishAnalysisResult(RESULT_B);

  assert.equal(ui._lastResult, RESULT_B);
  assert.equal(ui._currentPageData, RESULT_B.data);
  assert.deepEqual(ui._requestedPlotOptions, RESULT_B.options);
  assert.deepEqual(
    ui.renders.map(entry => entry.result),
    [RESULT_A, RESULT_B],
    'the open overlay must be re-drawn from the newly published result',
  );
  assert.equal(ui.renders.at(-1).modal, modal);
});

test('the overlay is re-drawn only for the request that still owns the UI', async () => {
  const ui = publisher();
  ui._modal = { id: 'overlay' };
  ui._activeAnalysisRequestId = 7;

  await ui._publishAnalysisResult(RESULT_B, 3);

  assert.equal(
    ui._lastResult,
    RESULT_B,
    'a superseded request still publishes nothing but its own state',
  );
  assert.deepEqual(
    ui.renders,
    [],
    'a superseded request must not draw over the overlay',
  );
});

test('a failed overlay refresh closes the overlay rather than leaving it stale', async () => {
  const ui = publisher();
  const errors = [];
  // `closeModal` short-circuits on an already-torn-down modal, which is the
  // exact state this test needs: the assertion is about ownership release and
  // reporting, not about modal teardown, which has its own coverage.
  const modal = { id: 'overlay', _cleanupDone: true };
  ui._modal = modal;
  ui._notifications = {
    error(message) {
      errors.push(message);
    },
  };
  ui._renderExpandedViewContent = async () => {
    throw new Error('injected overlay render failure');
  };

  await ui._publishAnalysisResult(RESULT_B);

  assert.equal(ui._lastResult, RESULT_B, 'the result is still published');
  assert.equal(ui._modal, null, 'the stale overlay must be released');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Expanded view could not follow the new result/);
  assert.match(errors[0], /injected overlay render failure/);
});

test('a newer result published during the first draw owns the overlay; the superseded draw does not close it', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async () => {
      const ui = publisher();
      ui._lastResult = RESULT_A;
      ui._notifications = { error() {}, success() {} };
      const drawn = [];
      const busyDuringDraw = [];
      ui._renderExpandedViewContent = FormBasedAnalysisUI.prototype._renderExpandedViewContent;
      ui._drawExpandedViewContent = async (modal, result) => {
        busyDuringDraw.push(modal._body.getAttribute('aria-busy'));
        if (result === RESULT_A) {
          await ui._publishAnalysisResult(RESULT_B);
          return false;
        }
        modal._title.textContent = result.subtitle;
        drawn.push(result.subtitle);
        return true;
      };

      // Timers run on demand, so a close the open itself waits for cannot stall it.
      const opening = ui._openExpandedView();
      await settleMicrotasks();
      runAllTimers();
      await opening;
      const modal = ui._modal;

      assert.equal(modal === null, false, 'the overlay stays open');
      assert.equal(modal.isConnected, true);
      assert.deepEqual(busyDuringDraw, ['true', 'true'], 'each draw runs while the overlay is busy');
      assert.deepEqual(drawn, [RESULT_B.subtitle], 'only the newer result is drawn');
      assert.equal(modal._title.textContent, RESULT_B.subtitle);
      assert.equal(modal._body.getAttribute('aria-busy'), null, 'the overlay is not left busy');

      const closing = closeModal(modal);
      await settleMicrotasks();
      runAllTimers();
      await closing;
    });
  });
});

test('a result discarded during the draw closes the overlay it was drawing', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async () => {
      const ui = publisher();
      ui._lastResult = RESULT_A;
      ui._renderExpandedViewContent = async () => {
        ui._lastResult = null;
        return false;
      };

      const opening = ui._openExpandedView();
      await settleMicrotasks();
      runAllTimers();
      await opening;
      await settleMicrotasks();
      runAllTimers();

      const left = ui._modal;
      if (left !== null) {
        // Closed here so a failure does not leave the dialog's timers running.
        const closing = closeModal(left);
        await waitFor(() => left._cleanupDone, 'the overlay cleanup');
        runAllTimers();
        await closing;
      }
      assert.equal(left === null, true, 'the overlay of a discarded result is closed');
    });
  });
});

test('Detailed analysis draws its expanded view from the committed snapshot, not the config being edited', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async () => {
      const ui = new DetailedAnalysisUI({ comparisonModule: {}, dataLayer: {} });
      const committedConfig = {
        dataSource: { type: 'categorical_obs', variable: 'cell_type' },
        pages: ['page-a'],
        plotType: 'barplot',
        plotOptions: {},
      };
      const committedData = [{ pageId: 'page-a', variableInfo: { name: 'cell_type' } }];
      ui._committedView = Object.freeze({ config: committedConfig, pageData: committedData, layoutEngine: {} });
      // A control change moves `_currentConfig` before its debounced fetch commits matching data.
      ui._currentConfig = {
        dataSource: { type: 'continuous_obs', variable: 'score' },
        pages: ['page-1'],
        plotType: 'histogram',
        plotOptions: {},
      };
      // The plot options panel is not what is checked: the heading is drawn without it.
      const renderHeading = ui._renderModalHeading.bind(ui);
      ui._renderModalHeading = (modal, config, pageData) => renderHeading({ _title: modal._title }, config, pageData);
      let drawnWith = null;
      ui._drawExpandedView = async (modal, committed) => {
        drawnWith = {
          busy: modal._body.getAttribute('aria-busy'),
          sameConfig: committed.config === committedConfig,
          sameData: committed.pageData === committedData,
        };
      };

      await ui._openExpandedView();
      const modal = ui._modal;

      assert.deepEqual(drawnWith, { busy: 'true', sameConfig: true, sameData: true });
      assert.equal(modal._title.textContent, 'Comparing: cell_type');
      assert.equal(modal._body.getAttribute('aria-busy'), null);

      const closing = closeModal(modal);
      await settleMicrotasks();
      runAllTimers();
      await closing;
    });
  });
});

test('an overlay closed while it opens draws nothing into the dialog its close took the plot owner of', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      // A focus listener closes the dialog as showModal() focuses it.
      const closedWhileOpening = [];
      document.onDialogFocusedWhileOpening = dialog => {
        closedWhileOpening.push(dialog);
        dialog.close();
      };
      const settleClose = async () => {
        await settleMicrotasks();
        runAllTimers();
        await settleMicrotasks();
      };

      const form = publisher();
      form._lastResult = RESULT_A;
      form._notifications = { error() {}, success() {} };
      const opening = form._openExpandedView();
      await settleClose();
      await opening;
      await settleClose();
      assert.deepEqual(form.renders, [], 'a form-based mode draws nothing into it');
      assert.equal(form._modal, null);

      const detailed = new DetailedAnalysisUI({ comparisonModule: {}, dataLayer: {} });
      detailed._committedView = Object.freeze({
        config: { dataSource: { type: 'categorical_obs', variable: 'cell_type' }, pages: ['page-a'], plotType: 'barplot', plotOptions: {} },
        pageData: [{ pageId: 'page-a', variableInfo: { name: 'cell_type' } }],
        layoutEngine: {},
      });
      detailed._renderModalHeading = () => {};
      const draws = [];
      detailed._drawExpandedView = async modal => { draws.push(modal); };
      const detailedOpening = detailed._openExpandedView();
      await settleClose();
      await detailedOpening;
      await settleClose();
      assert.deepEqual(draws, [], 'Detailed analysis draws nothing into it');
      assert.equal(detailed._modal, null);

      assert.equal(closedWhileOpening.length, 2);
      for (const dialog of closedWhileOpening) assert.equal(dialog.isConnected, false, 'each closed dialog is removed');
    });
  });
});

test('Detailed analysis makes no plot in an overlay closed while Plotly loaded', { concurrency: false }, async t => {
  const plotType = 'closed-while-loading';
  assert.equal(PlotRegistry.register({ id: plotType, name: 'A plot', supportedTypes: ['categorical_obs'], render: () => {} }), true);
  t.after(() => PlotRegistry.unregister(plotType));
  // What loading Plotly asks of the page (`plotly-hints.js`): Plotly itself is the fake DOM's.
  const hadMutationObserver = 'MutationObserver' in globalThis;
  const mutationObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => {
    if (hadMutationObserver) globalThis.MutationObserver = mutationObserver;
    else delete globalThis.MutationObserver;
  });
  await withControlledTimers(async () => {
    await withFakeDOM(async ({ document }) => {
      document.head = document.createElement('head');
      document.getElementById = () => null;
      const ui = new DetailedAnalysisUI({ comparisonModule: {}, dataLayer: {} });
      const modal = { _plotContainer: document.createElement('div'), _analysisPlotSlot: null };
      const committed = Object.freeze({
        config: { dataSource: { type: 'categorical_obs', variable: 'cell_type' }, pages: ['page-a'], plotType, plotOptions: {} },
        pageData: [{ pageId: 'page-a', variableInfo: { name: 'cell_type' } }],
        layoutEngine: {},
      });
      const slotsMade = [];
      ui._ensureModalPlotSlot = target => {
        slotsMade.push(target);
        throw new Error('a plot slot was made');
      };
      // The overlay's close ran its `beforeClose` while Plotly loaded: it no longer owns the UI.
      ui._modal = null;
      await ui._drawExpandedView(modal, committed, ui._modalRenderGeneration);
      assert.deepEqual(slotsMade, [], 'no plot slot is made in it');
    });
  });
});

test('every form-based mode publishes through the one result owner', async () => {
  // The publication step is not copied into each mode.
  // Nothing outside the owner may assign `_lastResult`, or the overlay refresh
  // silently stops happening for that mode.
  const owner = 'base/form-based-analysis.js';
  const offenders = [];

  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, directory), `${relative}/`);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = await readFile(new URL(entry.name, directory), 'utf8');
      const assignments = source.match(/this\._lastResult\s*=(?!=)\s*(?!null)/g) ?? [];
      if (assignments.length > 0 && relative !== owner) {
        offenders.push(`${relative} (${assignments.length})`);
      }
    }
  };
  await walk(ANALYSIS_TYPES_DIR, '');

  assert.deepEqual(
    offenders,
    [],
    'analysis modes must call _publishAnalysisResult() instead of assigning ' +
    '_lastResult, so the open overlay is refreshed with every new result',
  );
  assert.ok(path.basename(owner).length > 0);
});

test('a preview\'s Expand opens only its published result: disabled while the result is drawn, enabled once published', async t => {
  // The preview and its Expand are drawn before the result is published (DE of a large dataset),
  // and an Expand clicked in between would say "Expanded analysis view requires a completed
  // analysis result".
  // The few DOM calls `_renderPreviewExpandAction` makes, on plain objects (this suite runs without a DOM).
  const element = tag => {
    const el = { tagName: tag, children: [], disabled: false, title: '', className: '', parentElement: null,
      appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
      querySelector() { return null; } };
    return el;
  };
  globalThis.document = { createElement: element };
  globalThis.HTMLElement = Object;
  t.after(() => {
    delete globalThis.document;
    delete globalThis.HTMLElement;
  });
  const ui = publisher();
  ui._showCellChoice = () => {};
  ui._openCells = () => null;
  ui._resultGeneSample = () => null;
  ui._publishDerivedResultsSafely = () => {};
  ui._createExpandButton = () => document.createElement('button');
  ui._resultContainer = document.createElement('div');
  const button = ui._renderPreviewExpandAction(RESULT_A);
  assert.equal(button.disabled, true, 'drawn before its result is published: not yet');
  await ui._publishAnalysisResult(RESULT_A);
  assert.equal(button.disabled, false, 'published: it opens');
  // A preview drawn again for the published result (new plot options) is live at once.
  assert.equal(ui._renderPreviewExpandAction(RESULT_A).disabled, false);
});

test('every mode draws its preview from the result itself, so its Expand opens once that result is published', async () => {
  // A preview drawn from a copy of the result (`{...result, options}`, to leave the legend out)
  // would never match the published result, and its Expand would stay disabled ("Opens once the
  // result is drawn"). Other plot options go in `plotOptions`.
  const offenders = [];
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, directory), `${relative}/`);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = await readFile(new URL(entry.name, directory), 'utf8');
      const copies = source.match(/_render(?:PreviewPlot\(\{\s*result:\s*\{|PreviewExpandAction\(\s*\{)/g) ?? [];
      if (copies.length > 0) offenders.push(`${relative} (${copies.length})`);
    }
  };
  await walk(ANALYSIS_TYPES_DIR, '');
  assert.deepEqual(offenders, [], 'pass the result itself, and other plot options as `plotOptions`');
});
