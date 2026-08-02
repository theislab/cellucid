import assert from 'node:assert/strict';
import test from 'node:test';

import {
  viewerNeedsUiRetirement,
} from '../assets/js/app/ui/core/viewer-lifecycle.js';

test('UI retires viewer-side ownership while the viewer is live', () => {
  assert.equal(viewerNeedsUiRetirement({}), true);
  assert.equal(viewerNeedsUiRetirement({
    isContextLost: () => false,
    isDisposed: () => false,
  }), true);
});

test('UI skips viewer mutations after terminal viewer disposal', () => {
  let contextLossRead = false;
  assert.equal(viewerNeedsUiRetirement({
    isContextLost() {
      contextLossRead = true;
      return false;
    },
    isDisposed: () => true,
  }), false);
  assert.equal(contextLossRead, false);
});

test('UI skips viewer mutations after physical WebGL context loss', () => {
  assert.equal(viewerNeedsUiRetirement({
    isContextLost: () => true,
    isDisposed: () => false,
  }), false);
});
