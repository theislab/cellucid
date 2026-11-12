/**
 * The range filter's slider and number boxes (`ui/modules/legend/range-bounds.js`,
 * audit NS-10): a slider moves in thousandths of its track and sets the
 * shortest decimal that tells its step apart; a log color scale spaces the
 * track in log units (the zeros at its first step); a typed bound is exact.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SLIDER_STEPS, boundText, createRangeScale, parseBound } from '../assets/js/app/ui/modules/legend/range-bounds.js';

test('a linear track: thousandths of the range, short bounds, exact ends', () => {
  const scale = createRangeScale({ min: 500, max: 100000 });
  assert.equal(SLIDER_STEPS, 1000);
  assert.equal(scale.valueAt(0), 500);
  assert.equal(scale.valueAt(1000), 100000);
  assert.equal(scale.valueAt(10), 1500);
  assert.equal(scale.valueAt(1), 600);
  assert.equal(scale.positionOf(1500), 10);
  for (let position = 0; position <= 1000; position++) {
    const value = scale.valueAt(position);
    assert.ok(value >= 500 && value <= 100000);
    assert.ok(boundText(value).replace(/^0\.0*|\./g, '').length <= 6, `${position}: ${value} is short`);
    assert.equal(scale.positionOf(value), position, `${position} round-trips`);
  }
  // A small range with an offset keeps its digits.
  const small = createRangeScale({ min: 0.012, max: 0.085 });
  assert.equal(small.valueAt(500), 0.0485);
});

test('a log track: zeros at the first step, decades spread over the rest', () => {
  const scale = createRangeScale({ min: 0, max: 100000, positiveMin: 1, log: true });
  assert.equal(scale.log, true);
  assert.equal(scale.valueAt(0), 0);
  assert.equal(scale.valueAt(1), 1);
  assert.equal(scale.valueAt(1000), 100000);
  // The middle of the track is the middle decade, not 50,000.
  const middle = scale.valueAt(500);
  assert.ok(middle > 250 && middle < 400, `${middle}`);
  assert.equal(scale.positionOf(0), 0);
  assert.equal(scale.positionOf(1), 1);
  assert.equal(scale.positionOf(100000), 1000);
  // Without a positive value below the maximum the track stays linear.
  assert.equal(createRangeScale({ min: -1, max: 0, positiveMin: null, log: true }).log, false);
});

test('a typed bound is exact, in the data range, or not read', () => {
  assert.equal(parseBound('1500', { min: 500, max: 1e5 }), 1500);
  assert.equal(parseBound('0,012', { min: 0, max: 1 }), 0.012);
  assert.equal(parseBound('1e-3', { min: 0, max: 1 }), 0.001);
  assert.equal(parseBound('-5', { min: 0, max: 1 }), 0);
  assert.equal(parseBound('2e9', { min: 0, max: 1 }), 1);
  assert.equal(parseBound('', { min: 0, max: 1 }), null);
  assert.equal(parseBound('1,234.5', { min: 0, max: 1e5 }), null);
  assert.equal(boundText(1234.5), '1234.5');
});
