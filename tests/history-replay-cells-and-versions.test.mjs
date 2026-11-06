/**
 * Two replay rules of the history (`assets/js/app/history/history.js`
 * `replaySteps`):
 *
 * - A step whose parameters name cells by their original positions (an
 *   `x-cells` or `x-values` parameter: a pushed column, a selection) is
 *   applied again only on the dataset it was recorded on. Another dataset
 *   lists its cells in its own order, so a position there is another cell,
 *   even when both have as many cells.
 * - A step recorded with an earlier version of an action whose parameters
 *   hold nothing the version now can be made from (`valuesOnlyUpgrade`,
 *   `field.consensus` version 1) is put back by its values on the dataset it
 *   was recorded on, and flagged with the action's reason on another.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog, defineAction, ParamsNotUpgradable, upgradeParams, valuesOnlyUpgrade } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { namesCells, replayPlanOf } from '../assets/js/app/history/replay.js';

const VALUES_ONLY = 'It was built as one value per cell, so it is not applied again by name.';

const DEFINITIONS = [
  defineAction({
    type: 'cells.mark', title: 'Mark cells', summary: 'Mark cells by original position.', group: 'Cells',
    params: {
      type: 'object', additionalProperties: false, required: ['n_obs', 'cells'],
      properties: { n_obs: { type: 'integer', minimum: 0 }, cells: { type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true } },
    },
    touches: ['highlights'], reads: [], effect: 'state', describe: p => `Marked ${p.cells.length} cells`, code: () => 'mark()',
  }),
  defineAction({
    type: 'color.by', title: 'Colour by', summary: 'Colour by a field.', group: 'Colours',
    params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } },
    touches: ['colors'], reads: [], effect: 'view', describe: p => `Coloured by ${p.field}`, code: () => 'color_by()',
  }),
  defineAction({
    type: 'column.build', title: 'Build a column', summary: 'A column from the outcome of each category.', group: 'Fields',
    version: 2,
    upgrade: { 1: valuesOnlyUpgrade(VALUES_ONLY) },
    params: { type: 'object', additionalProperties: false, required: ['mapping'], properties: { mapping: { type: 'array', items: { type: 'string' } } } },
    touches: ['field-overlays'], reads: [], effect: 'state', describe: () => 'Built a column', code: () => 'build()',
  }),
];

let trackers = 0;

/** A dataset's page: three domains, the three actions. */
function page({ id, name = id }, { withHistoryActions = false } = {}) {
  const state = { highlights: { cells: [] }, colors: { by: null }, overlays: { column: null } };
  const domains = createDomainRegistry();
  domains.provide('highlights', { capture: () => ({ cells: [...state.highlights.cells] }), restore: value => { state.highlights = { cells: [...value.cells] }; } });
  domains.provide('colors', { capture: () => ({ ...state.colors }), restore: value => { state.colors = { ...value }; } });
  domains.provide('field-overlays', { capture: () => ({ ...state.overlays }), restore: value => { state.overlays = { ...value }; } });
  for (const missing of domains.missing()) domains.provide(missing, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(withHistoryActions ? [...DEFINITIONS, ...historyActions] : DEFINITIONS) });
  const calls = [];
  dispatcher.provide('cells.mark', ({ cells }) => { calls.push('cells.mark'); state.highlights = { cells: [...cells] }; return null; });
  dispatcher.provide('color.by', ({ field }) => { calls.push('color.by'); state.colors = { by: field }; return null; });
  dispatcher.provide('column.build', ({ mapping }) => { calls.push('column.build'); state.overlays = { column: mapping.join(',') }; return null; });
  let t = 1000;
  const history = createHistory({
    dispatcher, domains, dataset: { id, name, cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++trackers).padStart(12, '0')}`, now: () => ++t,
  });
  return { state, dispatcher, history, calls };
}

test('which actions name cells: every one with an x-cells or x-values parameter, at any depth', () => {
  const catalog = createActionCatalog(DEFINITIONS);
  assert.equal(namesCells(catalog.get('cells.mark')), true);
  assert.equal(namesCells(catalog.get('color.by')), false);
  const app = getActionCatalog();
  assert.equal(namesCells(app.get('field.push')), true, 'a pushed column names its cells');
  assert.equal(namesCells(app.get('field.consensus')), false, 'a consensus column names its categories, not its cells');
});

test('a step naming cells applies only on the dataset it was recorded on, whatever the cell counts', async () => {
  const a = page({ id: 'dataset-a', name: 'Dataset A' });
  await a.history.startTracker({ name: 'Cells' });
  await a.dispatcher.dispatch('color.by', { field: 'leiden' });
  await a.dispatcher.dispatch('cells.mark', { n_obs: 4, cells: [0, 2] });
  const plan = replayPlanOf(a.history.snapshot());

  // Another dataset of as many cells: the colour applies, the cells do not.
  const b = page({ id: 'dataset-b', name: 'Dataset B' });
  await b.history.startTracker({ name: 'Mine' });
  const other = await b.history.replay(plan);
  assert.deepEqual(other.report.map(entry => [entry.label, entry.outcome]), [['Coloured by leiden', 'applied'], ['Marked 2 cells', 'unmatched']]);
  assert.equal(other.report[1].reason, 'It names cells of "Dataset A" by their positions, which are not this dataset\'s cells, so it is not applied here.');
  assert.deepEqual(b.calls, ['color.by'], 'the step naming cells is never dispatched');
  assert.deepEqual(b.state.highlights, { cells: [] });

  // The same dataset (the same file, by its identity) in another page: both apply.
  const a2 = page({ id: 'dataset-a', name: 'Dataset A' });
  await a2.history.startTracker({ name: 'Again' });
  const same = await a2.history.replay(plan);
  assert.deepEqual(same.report.map(entry => entry.outcome), ['applied', 'applied']);
  assert.deepEqual(a2.state.highlights, { cells: [0, 2] });
});

test('a branch applied again on its own history names its own cells, even for a dataset with no identity', async () => {
  const a = page({ id: null, name: 'Local file' }, { withHistoryActions: true });
  await a.history.startTracker({ name: 'Cells' });
  const colour = (await a.dispatcher.dispatch('color.by', { field: 'leiden' })).step;
  await a.dispatcher.dispatch('cells.mark', { n_obs: 4, cells: [1] });
  // Without the colour: the later step, naming cells, is applied again on its own dataset.
  const { outcome } = await a.dispatcher.dispatch('history.branch.without', { step: colour.id });
  assert.deepEqual(outcome.report.map(entry => entry.outcome), ['applied']);
  assert.deepEqual(a.state.highlights, { cells: [1] });
  const { outcome: verified } = await a.dispatcher.dispatch('history.verify', { branch: 'Main' });
  assert.equal(verified.reproduced, true);
});

test('parameters of a values-only earlier version: put back by their values where they were recorded, flagged elsewhere', async () => {
  const definition = createActionCatalog(DEFINITIONS).get('column.build');
  assert.throws(() => upgradeParams(definition, 1, { values: [0, 1] }), error => error instanceof ParamsNotUpgradable && error.reason === VALUES_ONLY);
  assert.deepEqual(upgradeParams(definition, 2, { mapping: ['x'] }), { mapping: ['x'] });
  assert.throws(() => valuesOnlyUpgrade(''), /says why/);

  const a = page({ id: 'dataset-a', name: 'Dataset A' });
  await a.history.startTracker({ name: 'Built' });
  await a.dispatcher.dispatch('column.build', { mapping: ['T', 'B'] });
  await a.dispatcher.dispatch('color.by', { field: 'community' });
  // As an earlier Cellucid recorded it: version 1, one value per cell.
  const snapshot = a.history.snapshot();
  const built = snapshot.trackers[0].steps.find(step => step.type === 'column.build');
  built.v = 1;
  built.params = { values: [0, 1, 1] };
  const plan = replayPlanOf(snapshot);

  // Where it was recorded (its values held here): put back, a step of the same action as recorded.
  await a.dispatcher.dispatch('color.by', { field: 'other' });
  await a.history.startTracker({ name: 'Fresh' });
  a.state.overlays = { column: null };
  await a.history.reconcile();
  const here = await a.history.replay(plan);
  assert.deepEqual(here.report.map(entry => [entry.label, entry.outcome]), [['Built a column', 'applied'], ['Coloured by community', 'applied']]);
  assert.equal(a.state.overlays.column, 'T,B', 'its values, as recorded');
  assert.equal(a.calls.filter(type => type === 'column.build').length, 1, 'never dispatched again');
  const putBack = a.history.active.steps.get(here.report[0].step);
  assert.deepEqual([putBack.kind, putBack.type, putBack.v, putBack.params], ['action', 'column.build', 1, { values: [0, 1, 1] }]);

  // On another dataset: flagged with the action's reason, nothing changed.
  const b = page({ id: 'dataset-b', name: 'Dataset B' });
  await b.history.startTracker({ name: 'Mine' });
  const other = await b.history.replay(plan);
  assert.deepEqual(other.report.map(entry => [entry.outcome, entry.reason]), [['unmatched', VALUES_ONLY], ['applied', null]]);
  assert.deepEqual(b.state.overlays, { column: null });
  assert.deepEqual(b.calls, ['color.by']);
});
