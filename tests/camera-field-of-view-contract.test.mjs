/**
 * The field of view applies to the presented area's shorter side, so a camera
 * frames the same data on a portrait screen as on a landscape one
 * (`rendering/viewer/field-of-view.js`; the browser half of this contract is
 * `tests/browser/camera-framing-aspect.spec.mjs`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_FIELD_OF_VIEW,
  fieldOfViewFor,
} from '../assets/js/rendering/viewer/field-of-view.js';

const horizontalOf = (vertical, aspect) => 2 * Math.atan(Math.tan(vertical / 2) * aspect);

test('a landscape or square area keeps the 45° vertical field of view exactly', () => {
  assert.equal(BASE_FIELD_OF_VIEW, 45 * Math.PI / 180);
  for (const aspect of [1, 1.44, 16 / 9, 3]) {
    assert.equal(fieldOfViewFor(aspect), BASE_FIELD_OF_VIEW);
  }
});

test('a portrait area sees 45° across, as a landscape one sees down', () => {
  for (const aspect of [390 / 844, 0.75, 0.999]) {
    const vertical = fieldOfViewFor(aspect);
    assert.ok(vertical > BASE_FIELD_OF_VIEW);
    assert.ok(Math.abs(horizontalOf(vertical, aspect) - BASE_FIELD_OF_VIEW) < 1e-12);
  }
});

test('an area with no shape is refused', () => {
  for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => fieldOfViewFor(aspect), /positive finite/);
  }
});

test('two views side by side make portrait panes that see 45° across: a kept view no longer crops a wide 2-D map', async () => {
  const { resolvePresentedLayout } = await import('../assets/js/rendering/viewer/presented-view-layout.js');
  // 1440 × 900 with the sidebar over 290 px: one landscape area, or two 575 × 900 portrait panes.
  const options = { canvasHeight: 1800, canvasWidth: 2880, cssHeight: 900, cssWidth: 1440, focusedViewId: 'live', leftOcclusionRatio: 290 / 1440 };
  const single = resolvePresentedLayout({ ...options, mode: 'single', viewIds: ['live'] });
  assert.equal(single.panes[0].fov, BASE_FIELD_OF_VIEW);
  const grid = resolvePresentedLayout({ ...options, mode: 'grid', viewIds: ['live', 'snap_1'] });
  for (const pane of grid.panes) {
    const aspect = pane.cssWidth / pane.cssHeight;
    assert.ok(aspect < 1, 'a portrait pane');
    assert.equal(pane.fov, fieldOfViewFor(aspect));
    // The camera that frames the data's height in the single view frames its width here:
    // 45° across, where the presented area's 45° down saw only 2·atan(tan 22.5° · aspect).
    assert.ok(Math.abs(horizontalOf(pane.fov, aspect) - BASE_FIELD_OF_VIEW) < 1e-12);
    assert.ok(horizontalOf(BASE_FIELD_OF_VIEW, aspect) < 0.7 * BASE_FIELD_OF_VIEW, 'what the shared field of view showed');
  }
  // Two panes stacked on a wide window stay landscape, at 45° down.
  const wide = resolvePresentedLayout({ ...options, cssWidth: 2880, canvasWidth: 5760, leftOcclusionRatio: 0, mode: 'grid', viewIds: ['live', 'snap_1'] });
  for (const pane of wide.panes) assert.equal(pane.fov, BASE_FIELD_OF_VIEW);
});
