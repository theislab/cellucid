/**
 * A session names cells by original position (`session/session-cell-order.js`):
 * per-cell chunks — highlight memberships, user-defined codes and values — and
 * the cell-order digest hold the same bytes whatever order the app opened the
 * cells in (a priority-ordered file opened whole, a subsample opened in its
 * priority order), so Python and R apply them to an object in its original
 * order, and a session survives the file being laid out again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as highlightsCells from '../assets/js/app/session/contributors/highlights-cells.js';
import * as userDefinedCodes from '../assets/js/app/session/contributors/user-defined-codes.js';
import * as userDefinedValues from '../assets/js/app/session/contributors/user-defined-values.js';
import { digestCellOrder } from '../assets/js/app/session/session-context.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { priorityOrder, rankOf } from '../assets/js/data/subsample.js';

const N = 600;
const categories = ['A', 'B', 'C'];
// The truth, by original position.
const codes = Uint8Array.from({ length: N }, (_, p) => (p < 100 ? 0 : p < 450 ? 1 : 2));
const regions = Uint8Array.from({ length: N }, (_, p) => (p * 7919) % 3);
const scores = Float32Array.from({ length: N }, (_, p) => Math.sin(p) * 10);
const lasso = Array.from({ length: N }, (_, p) => p).filter(p => p % 5 === 2);
const categoryA = Array.from({ length: 100 }, (_, p) => p);

/** The app's state over the open cells `open` (original positions, in open order). */
function stateOver(open, identity) {
  const at = new Map(Array.from(open, (p, i) => [p, i]));
  const openCells = cells => Uint32Array.from(cells.filter(p => at.has(p)).map(p => at.get(p))).sort();
  const pick = (values, Type) => Type.from(open, p => values[p]);
  const groups = [
    { id: 'highlight_1', type: 'lasso', label: 'Lasso', cells: openCells(lasso) },
    { id: 'highlight_2', type: 'category', label: 'ctype: A', cells: openCells(categoryA), fieldKey: 'ctype', fieldIndex: 0, fieldSource: 'obs', categoryIndex: 0, categoryName: 'A' },
  ].map(g => ({ ...g, enabled: true, cellCount: g.cells.length, cellIndices: g.cells }));
  const userCodes = { _userDefinedId: 'user_cat_1', kind: 'category', key: 'regions', codes: pick(regions, Uint8Array) };
  const userValues = { _userDefinedId: 'user_cont_1', kind: 'continuous', key: 'score', values: pick(scores, Float32Array), _sourceField: null };
  return {
    pointCount: open.length,
    cellIdentity: identity,
    obsData: { fields: [{ key: 'ctype', kind: 'category', categories, codes: pick(codes, Uint8Array) }] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    viewContexts: new Map(),
    getHighlightPages: () => [{ id: 'page_1', name: 'Page 1', color: '#2563eb', highlightedGroups: groups }],
    getUserDefinedFieldsRegistry: () => ({ getAllFields: () => [userCodes, userValues], getField: id => [userCodes, userValues].find(f => f._userDefinedId === id) }),
  };
}

function payloads(state) {
  const ctx = { state };
  const out = {};
  for (const chunk of highlightsCells.capture(ctx)) out[chunk.id] = Array.from(chunk.payload);
  for (const chunk of userDefinedCodes.capture(ctx)) out[chunk.id] = Array.from(chunk.payload);
  for (const chunk of userDefinedValues.capture(ctx)) out[chunk.id] = Array.from(chunk.payload);
  return out;
}

test('every cell open in priority order saves the bytes of the cells in original order', () => {
  const asGiven = Uint32Array.from({ length: N }, (_, p) => p);
  const priority = Uint32Array.from(asGiven).sort((a, b) => rankOf(0, a) - rankOf(0, b));
  const reference = payloads(stateOver(asGiven, createCellIdentity({ nObs: N })));
  const opened = payloads(stateOver(priority, createCellIdentity({ nObs: N, openOrder: priority })));
  assert.deepEqual(Object.keys(reference).sort(), [
    'highlights/cells/highlight_1', 'highlights/cells/highlight_2', 'user-defined/codes/user_cat_1', 'user-defined/values/user_cont_1',
  ]);
  assert.deepEqual(opened, reference);
});

test('a subsample opened in its priority order saves the bytes of its kept cells ascending', () => {
  const spec = { method: 'uniform', nObs: N, k: 150, seed: 7 };
  const ranked = Uint32Array.from({ length: N }, (_, p) => p).sort((a, b) => rankOf(7, a) - rankOf(7, b));
  const kept = Uint32Array.from(ranked.subarray(0, 150)).sort();
  const reference = payloads(stateOver(kept, createCellIdentity({ nObs: N, kept })));
  const order = priorityOrder(spec, kept);
  assert.notDeepEqual(Array.from(order), Array.from(kept));
  const opened = payloads(stateOver(order, createCellIdentity({ nObs: N, kept, openOrder: order })));
  assert.deepEqual(opened, reference);
});

test('the cell-order digest names the cells by original position, whatever order they are held in', () => {
  const positions = Float32Array.from({ length: N * 2 }, (_, i) => Math.cos(i) * 3);
  const reference = digestCellOrder(positions, 2);
  const priority = Uint32Array.from({ length: N }, (_, p) => p).sort((a, b) => rankOf(0, a) - rankOf(0, b));
  const held = new Float32Array(N * 2);
  priority.forEach((p, row) => { held[row * 2] = positions[p * 2]; held[row * 2 + 1] = positions[p * 2 + 1]; });
  const rowOf = new Uint32Array(N);
  priority.forEach((p, row) => { rowOf[p] = row; });
  assert.notEqual(digestCellOrder(held, 2), reference);
  assert.equal(digestCellOrder(held, 2, rowOf), reference);
});

test('restoring maps a session\'s cells back to the open order exactly', async () => {
  const { sessionCellOrder, mapCells, mapValues } = await import('../assets/js/app/session/session-cell-order.js');
  const spec = { method: 'uniform', nObs: N, k: 200, seed: 3 };
  const ranked = Uint32Array.from({ length: N }, (_, p) => p).sort((a, b) => rankOf(3, a) - rankOf(3, b));
  const kept = Uint32Array.from(ranked.subarray(0, 200)).sort();
  const identity = createCellIdentity({ nObs: N, kept, openOrder: priorityOrder(spec, kept) });
  const { toSession, toOpen } = sessionCellOrder(identity);
  const values = Float32Array.from({ length: 200 }, (_, i) => i * 1.5);
  assert.deepEqual(mapValues(mapValues(values, toSession), toOpen), values);
  const cells = Uint32Array.of(0, 7, 31, 199);
  assert.deepEqual(mapCells(mapCells(cells, toSession), toOpen), cells);
  // Session cell s is kept[s]: open cell i's session position is where its original position sits in kept.
  for (let i = 0; i < 200; i++) assert.equal(kept[toSession[i]], identity.openOrder[i]);
  assert.equal(sessionCellOrder(createCellIdentity({ nObs: N })), null);
});
