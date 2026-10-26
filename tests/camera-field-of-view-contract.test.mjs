/**
 * The field of view applies to the presented area's shorter side, so a camera
 * frames the same data on a portrait screen as on a landscape one
 * (`rendering/viewer/field-of-view.js`; the browser half of this contract is
 * `tests/browser/camera-framing-aspect.spec.mjs`).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('the viewer takes its field of view from the presented area, nowhere else', async () => {
  const source = await readFile(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(source, /let fov = BASE_FIELD_OF_VIEW;/);
  assert.match(source, /fieldOfViewFor\(area\.cssWidth \/ area\.cssHeight\)/);
  assert.doesNotMatch(source, /45 \* Math\.PI/);
});
