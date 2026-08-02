/**
 * The expanded overlay must show the analysis the sidebar shows.
 *
 * Reproduced in Chromium before the fix: with the Gene Signature overlay open,
 * changing the gene list re-ran the analysis and moved the sidebar preview to
 * mean 1.448292, while the overlay went on showing mean 3.966388 under a title
 * still naming the previous gene set. Two surfaces, two different scientific
 * results, no indication which was current.
 *
 * The cause was that the overlay was bound to whichever result was current when
 * it opened and nothing re-drew it afterwards, while each form-based mode
 * published its result by assigning `_lastResult` inline — five separate
 * assignments, so there was nowhere for a refresh to live. Detailed analysis
 * already refreshed its open modal (`detailed-analysis-ui.js` `_updateModal`),
 * which is why only the form-based family was affected.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  FormBasedAnalysisUI,
} from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';

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

test('every form-based mode publishes through the one result owner', async () => {
  // The defect existed because the publication step was copied into each mode.
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
