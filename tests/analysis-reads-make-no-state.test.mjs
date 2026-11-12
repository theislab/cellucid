/**
 * A read of the analyses makes no state. The panel makes a mode's analysis
 * on first use, and every mode it made is part of the `analysis` state
 * domain (`ComparisonModule.exportSessionState`), so a read that made one
 * changed the state with no step, which undo could not take back (found by
 * F1's live sweep: undo of a turn left `analysis` changed after
 * `analysis.<mode>.get`). This guard holds the class shut in the sources:
 *
 * - no provider of a read (effect `read`) or of a stop (effect `control`,
 *   `analysis.cancel`: no step either) in `app/analysis/actions.js`, and
 *   no estimate, reaches `analysisAt` (which makes a mode for a change) or
 *   makes a mode itself; they read through `readAnalysisAt`
 *   (`ComparisonModule.readPanelUI`, which unmakes what it made, in the same
 *   task);
 * - the comparison module's public `getUI` peeks (`peekUI`) and never makes,
 *   and one analysis reads another's results by peeking.
 *
 * The Chromium spec (`actions-settings-layout-analysis.spec.mjs`, "reading
 * an analysis makes no state") proves the same on the page, fingerprint by
 * fingerprint.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { ANALYSIS_MODES } from '../assets/js/app/analysis/options/analysis-modes.js';
import { AnalysisUIManager } from '../assets/js/app/analysis/ui/analysis-ui-manager.js';

const source = path => readFileSync(new URL(`../assets/js/app/analysis/${path}`, import.meta.url), 'utf8');

/** What makes a mode: `analysisAt`, the panel's maker, the UI manager's maker. */
const MAKERS = [/\banalysisAt\(/, /\bgetPanelUI\(/, /\buiManager\.getUI\(/, /\b_uiManager\.getUI\(/, /getUIManager\(\)\??\.getUI\(/];

/** Each provider in `actions.js`: its kind (`provide`, `provideEstimate`), its type pattern and its body. */
function providers(text) {
  const out = [];
  const pattern = /actions\.(provide|provideEstimate)\((`[^`]+`|'[^']+')/g;
  const starts = [...text.matchAll(pattern)];
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : text.indexOf('function record(', match.index);
    out.push({ kind: match[1], type: match[2].slice(1, -1), body: text.slice(match.index, end) });
  });
  return out;
}

/** The catalog types a provider's type (a template over the modes) stands for. */
function typesOf(type) {
  if (!type.includes('${mode.name}')) return [type];
  return ANALYSIS_MODES.filter(mode => mode.options !== null).map(mode => type.replace('${mode.name}', mode.name));
}

test('no read of the analyses, and no estimate, reaches what makes a mode', () => {
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const found = providers(source('actions.js'));
  assert.ok(found.length > 10, 'the providers are found');
  const reads = found.filter(({ kind, type }) => kind === 'provideEstimate' || typesOf(type).every(t => ['read', 'control'].includes(catalog.get(t).effect)));
  assert.deepEqual(
    [...new Set(reads.map(({ kind, type }) => `${kind}:${type}`))].sort(),
    ['provide:analysis.${mode.name}.get', 'provide:analysis.cancel', 'provide:analysis.list', 'provide:analysis.result', 'provideEstimate:analysis.run'].sort(),
    'every read of the analyses (and the run\'s estimate) is held here',
  );
  for (const { kind, type, body } of reads) {
    for (const maker of MAKERS) assert.doesNotMatch(body, maker, `${kind} ${type} must read through readAnalysisAt, never ${maker}`);
  }
  // Changes may make a mode (inside their step); a read never.
  const readAt = source('actions.js').match(/function readAnalysisAt[\s\S]*?\n {2}}\n/)[0];
  assert.match(readAt, /comparisonModule\.readPanelUI\(/);
});

test('the public getUI peeks; one analysis reads another\'s results by peeking', () => {
  const module = source('comparison-module.js');
  const getUI = module.match(/\n {2}getUI\(modeId\) \{[\s\S]*?\n {2}}\n/)[0];
  assert.match(getUI, /peekUI\(modeId\)/);
  assert.doesNotMatch(module, /getAnalysisUIs/, 'the unused maker of every mode is gone');
  for (const file of ['ui/analysis-types/dotplot-ui.js', 'ui/analysis-types/gene-signature-ui.js']) {
    assert.doesNotMatch(source(file), /getUI\('genesPanel'\)|getUI\?\.\('genesPanel'\)/, `${file} reads the marker genes by peeking`);
    assert.match(source(file), /peekUI\??\.?\('genesPanel'\)/, file);
  }
});

test('peekUI never makes a mode; getUI makes it', () => {
  const made = [];
  const manager = Object.create(AnalysisUIManager.prototype);
  manager._uis = new Map([['markers', { ui: null, initialized: false }]]);
  manager._initializeUI = (modeId, entry) => {
    made.push(modeId);
    entry.ui = { modeId };
    entry.initialized = true;
  };
  assert.equal(manager.peekUI('markers'), null);
  assert.equal(manager.peekUI('nowhere'), null);
  assert.deepEqual(made, []);
  assert.deepEqual(manager.getUI('markers'), { modeId: 'markers' });
  assert.deepEqual(made, ['markers']);
  assert.deepEqual(manager.peekUI('markers'), { modeId: 'markers' });
});
