/**
 * Exports and methods that nothing calls are deleted, not kept "just in case".
 */
import assert from 'node:assert/strict';
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
