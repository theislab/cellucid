/**
 * A key that comes from data stays the data's own key through the walkers
 * that rebuild results and saved state: a category, field or group may be
 * named `__proto__`, and `out[key] = value` with that key changes `out`'s
 * prototype instead, so the entry would vanish from what an agent was sent,
 * from a saved session and from a figure's legend (and an object value would
 * become inherited state of the record). The walkers write with `setOwnDataProperty` (`utils/exact-record.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { withoutSingleCellStatistics } from '../assets/js/app/agent/bridge/data-guard.js';
import { analysisWithoutResults } from '../assets/js/app/session/share-scope.js';

const hostile = () => JSON.parse('{"groups": {"__proto__": {"count": 3, "min": 1, "max": 9}, "B": {"count": 2, "min": 0, "max": 4}}}');

test('the summaries-only guard keeps a group named __proto__ as a group, its single-cell statistics left out', () => {
  const { json, leftOut } = withoutSingleCellStatistics('field.summary', hostile());
  assert.deepEqual(Object.keys(json.groups), ['__proto__', 'B']);
  assert.equal(Object.getPrototypeOf(json.groups), Object.prototype);
  assert.deepEqual(json.groups.__proto__, { count: 3, min: null, max: null });
  assert.equal(JSON.stringify(json), '{"groups":{"__proto__":{"count":3,"min":null,"max":null},"B":{"count":2,"min":null,"max":null}}}');
  assert.deepEqual([...leftOut].sort(), ['max', 'min']);
});

test('a saved analysis keeps a key named __proto__ as its own', () => {
  const saved = analysisWithoutResults(hostile());
  assert.equal(Object.getPrototypeOf(saved.groups), Object.prototype);
  assert.equal(JSON.stringify(saved), JSON.stringify(hostile()));
});
