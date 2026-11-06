/**
 * The state domains name cells by original position
 * (`app/state/domains/cell-positions.js`): the per-cell parts of a value —
 * highlight memberships (`highlights`), user-defined codes and values
 * (`field-overlays`) — and the cell-order digest are the same whatever order
 * the app opened the cells in (a priority-ordered file opened whole, a
 * subsample opened in its priority order), so the history and a session file
 * hold the same state, Python and R apply it to an object in its original
 * order, and it survives the file being laid out again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHighlightsDomain } from '../assets/js/app/state/domains/highlights.js';
import { captureFieldOverlays } from '../assets/js/app/state/domains/field-overlays.js';
import { openCellList, openColumn, originalCellList, originalColumn } from '../assets/js/app/state/domains/cell-positions.js';
import { RenameRegistry } from '../assets/js/app/registries/rename-registry.js';
import { DeleteRegistry } from '../assets/js/app/registries/delete-registry.js';
import { cellOrderDigest } from '../assets/js/data/cell-order-digest.js';
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
  const common = { _isUserDefined: true, _fieldSource: 'obs', _isDeleted: false, _isPurged: false, _createdAt: 1, _operation: null };
  const userCodes = {
    ...common, _userDefinedId: 'user_cat_1', kind: 'category', key: 'regions', categories: ['r0', 'r1', 'r2'],
    codes: pick(regions, Uint8Array), _sourceField: null, _sourcePages: [], _overlapStrategy: 'first',
  };
  const userValues = { ...common, _userDefinedId: 'user_cont_1', kind: 'continuous', key: 'score', values: pick(scores, Float32Array), _sourceField: null };
  return {
    pointCount: open.length,
    cellIdentity: identity,
    obsData: { fields: [{ key: 'ctype', kind: 'category', categories, codes: pick(codes, Uint8Array) }] },
    varData: { fields: [] },
    getActivePageId: () => 'page_1',
    getHighlightPages: () => [{ id: 'page_1', name: 'Page 1', color: '#2563eb', highlightedGroups: groups }],
    getRenameRegistry: () => new RenameRegistry(),
    getDeleteRegistry: () => new DeleteRegistry(),
    getUserDefinedFieldsRegistry: () => ({ getAllFields: () => [userCodes, userValues], getField: id => [userCodes, userValues].find(f => f._userDefinedId === id) }),
  };
}

/** The per-cell parts of the state, as the highlights and field-overlays domains hold them. */
function perCellState(state) {
  const highlights = createHighlightsDomain({ state, refreshUi: () => {} }).capture();
  const overlays = captureFieldOverlays(state);
  return {
    groups: Object.fromEntries(highlights.pages[0].groups.map(group => [group.id, group.cells])),
    codes: Object.fromEntries(overlays.userFields.filter(item => item.codes !== undefined).map(item => [item.id, item.codes])),
    values: Object.fromEntries(overlays.userFields.filter(item => item.values !== undefined).map(item => [item.id, item.values])),
  };
}

test('every cell open in priority order holds the cells in original order', () => {
  const asGiven = Uint32Array.from({ length: N }, (_, p) => p);
  const priority = Uint32Array.from(asGiven).sort((a, b) => rankOf(0, a) - rankOf(0, b));
  const reference = perCellState(stateOver(asGiven, createCellIdentity({ nObs: N })));
  assert.deepEqual(Object.keys(reference.groups), ['highlight_1', 'highlight_2']);
  assert.deepEqual(Object.keys(reference.codes), ['user_cat_1']);
  assert.deepEqual(Object.keys(reference.values), ['user_cont_1']);
  // Every cell open: lists and columns by original position, the truth itself.
  assert.deepEqual(Array.from(reference.groups.highlight_1), lasso);
  assert.deepEqual(Array.from(reference.groups.highlight_2), categoryA);
  assert.deepEqual(reference.codes.user_cat_1, { cells: null, values: regions });
  assert.deepEqual(reference.values.user_cont_1, { cells: null, values: scores });
  const opened = perCellState(stateOver(priority, createCellIdentity({ nObs: N, openOrder: priority })));
  assert.deepEqual(opened, reference);
});

test('a subsample opened in its priority order holds its kept cells ascending', () => {
  const spec = { method: 'uniform', nObs: N, k: 150, seed: 7 };
  const ranked = Uint32Array.from({ length: N }, (_, p) => p).sort((a, b) => rankOf(7, a) - rankOf(7, b));
  const kept = Uint32Array.from(ranked.subarray(0, 150)).sort();
  const reference = perCellState(stateOver(kept, createCellIdentity({ nObs: N, kept })));
  const isKept = new Set(kept);
  assert.deepEqual(Array.from(reference.groups.highlight_1), lasso.filter(p => isKept.has(p)));
  assert.deepEqual(reference.codes.user_cat_1, { cells: kept, values: Uint8Array.from(kept, p => regions[p]) });
  assert.deepEqual(reference.values.user_cont_1, { cells: kept, values: Float32Array.from(kept, p => scores[p]) });
  const order = priorityOrder(spec, kept);
  assert.notDeepEqual(Array.from(order), Array.from(kept));
  const opened = perCellState(stateOver(order, createCellIdentity({ nObs: N, kept, openOrder: order })));
  assert.deepEqual(opened, reference);
});

test('the cell-order digest names the cells by original position, whatever order they are held in', () => {
  const positions = Float32Array.from({ length: N * 2 }, (_, i) => Math.cos(i) * 3);
  const reference = cellOrderDigest(positions, 2);
  const priority = Uint32Array.from({ length: N }, (_, p) => p).sort((a, b) => rankOf(0, a) - rankOf(0, b));
  const held = new Float32Array(N * 2);
  priority.forEach((p, row) => { held[row * 2] = positions[p * 2]; held[row * 2 + 1] = positions[p * 2 + 1]; });
  // Held in priority order, each row named by its cell: the same digest;
  // the rows taken for the cells at their positions: another.
  assert.equal(cellOrderDigest(held, 2, priority), reference);
  assert.notEqual(cellOrderDigest(held, 2), reference);
});

test('restoring maps a value\'s cells back to the open order exactly', () => {
  const spec = { method: 'uniform', nObs: N, k: 200, seed: 3 };
  const ranked = Uint32Array.from({ length: N }, (_, p) => p).sort((a, b) => rankOf(3, a) - rankOf(3, b));
  const kept = Uint32Array.from(ranked.subarray(0, 200)).sort();
  const identity = createCellIdentity({ nObs: N, kept, openOrder: priorityOrder(spec, kept) });
  // A column out and back, through another array of the same values (a value
  // read from a file), lands on the same open cells.
  const values = Float32Array.from({ length: 200 }, (_, i) => i * 1.5);
  const column = originalColumn(identity, values);
  assert.deepEqual(column.cells, kept);
  // Original position kept[s] holds the value of the open cell that is it.
  for (let i = 0; i < 200; i++) assert.equal(column.values[kept.indexOf(identity.openOrder[i])], values[i]);
  const read = { cells: Uint32Array.from(column.cells), values: Float32Array.from(column.values) };
  assert.deepEqual(openColumn(identity, read, Float32Array, Number.NaN), values);
  const cells = Uint32Array.of(0, 7, 31, 199);
  const named = originalCellList(identity, cells);
  assert.deepEqual(Array.from(named), Array.from(cells, i => identity.openOrder[i]).sort((a, b) => a - b));
  assert.deepEqual(openCellList(identity, Uint32Array.from(named)), cells);
  // Every cell open in its own order: original positions are open positions.
  const whole = createCellIdentity({ nObs: N });
  assert.equal(originalCellList(whole, cells), cells);
});
