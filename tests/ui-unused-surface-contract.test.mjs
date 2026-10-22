/**
 * Exports and methods that nothing calls are deleted, not kept "just in case".
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as pointSize from '../assets/js/app/ui/modules/figure-export/utils/point-size.js';
import * as highlightContract from '../assets/js/app/ui/modules/highlight/exact-contract.js';
import * as hoverContext from '../assets/js/app/analysis/ui/components/hover-context.js';
import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';

test('unused helper exports are absent', () => {
  assert.equal(Object.hasOwn(pointSize, 'getEffectivePointRadiusPx'), false);
  assert.equal(Object.hasOwn(highlightContract, 'CURRENT_SELECTION_MODES'), false);
  assert.equal(Object.hasOwn(hoverContext, 'createHoverContext'), false);
  assert.equal(Object.hasOwn(BaseAnalysisUI.prototype, '_showLoading'), false);
});

test('the comparison module carries no uncalled analysis or hook surface', async () => {
  const source = await readFile(
    new URL('../assets/js/app/analysis/comparison-module.js', import.meta.url),
    'utf8'
  );
  for (const pattern of [
    /\basync runAnalysis\(/,
    /\brunStatisticalTests\(/,
    /\bgetLastStatResults\(/,
    /\b_lastStatResults\b/,
    /\b_hooks\b/,
    /^\s+on\(event, callback\)/m,
    /^\s+off\(event, callback\)/m,
    /advanced-analysis-ui\.js/,
    /role="tablist"/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});
