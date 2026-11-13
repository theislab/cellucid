/**
 * A restore visits views one by one (`state/domains/view-list.js`
 * `inEachView`): each view is focused while its value is applied, and an
 * apply awaits field reads, so a frame can come in between. While a visit is
 * under way the focused view is its cursor — possibly a live view the person
 * removed — and what draws the view list and the sidebar from the focused
 * view waits for its end (`visitingViews`; `ui-coordinator.js`,
 * `view-controls.js`). Reopening a saved analysis whose live view was removed
 * must not throw "A hidden live view cannot be the active view" from a frame
 * drawn mid-visit.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { inEachView, visitingViews } from '../assets/js/app/state/domains/view-list.js';

function focusState(start) {
  let active = start;
  const focused = [];
  return {
    focused,
    getActiveViewId: () => active,
    setActiveView: id => { active = id; focused.push(id); return id; },
  };
}

test('a visit is under way from its first focus to the focus put back, across its awaits', async () => {
  const state = focusState('snap_2');
  const seen = [];
  assert.equal(visitingViews(), false);
  await inEachView(state, ['live', 'snap_1', 'snap_2'], [0, 1, 2], async viewId => {
    seen.push([viewId, visitingViews()]);
    await new Promise(resolve => setTimeout(resolve, 1));
    seen.push([viewId, visitingViews()]);
  });
  assert.deepEqual(seen, [['live', true], ['live', true], ['snap_1', true], ['snap_1', true], ['snap_2', true], ['snap_2', true]]);
  assert.equal(visitingViews(), false, 'over once the focus is back');
  assert.equal(state.getActiveViewId(), 'snap_2');
});

test('a visit that fails ends too, with the focus put back; nested visits end with the outer one', async () => {
  const state = focusState('snap_1');
  await assert.rejects(inEachView(state, ['live', 'snap_1'], [0], async () => {
    await inEachView(state, ['live', 'snap_1'], [1], () => assert.equal(visitingViews(), true));
    assert.equal(visitingViews(), true, 'the outer visit is still under way');
    throw new Error('a field could not be read');
  }), /could not be read/);
  assert.equal(visitingViews(), false);
  assert.equal(state.getActiveViewId(), 'snap_1');
  // Nothing to visit: no visit.
  await inEachView(state, ['live'], [], () => assert.fail('nothing to apply'));
  assert.equal(visitingViews(), false);
});

test('the view list and the frame-drawn sidebar wait for a visit to end', () => {
  const coordinator = readFileSync(new URL('../assets/js/app/ui/core/ui-coordinator.js', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('../assets/js/app/ui/modules/view-controls.js', import.meta.url), 'utf8');
  assert.match(coordinator, /scheduleFrame\(function update\(\) \{[\s\S]{0,400}if \(visitingViews\(\)\) \{\s*visibilityUiFrame = scheduleFrame\(update\);\s*return;/);
  assert.match(controls, /function renderSplitViewBadges\(\) \{\s*if \(destroyed\) return false;\s*if \(visitingViews\(\)\) \{\s*renderSplitViewBadgesAfterVisit\(\);\s*return false;/);
});
