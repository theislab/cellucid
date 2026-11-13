/**
 * The action layer and the history on fake domains: dispatch, ordering,
 * coalescing, rollback, confirmation, undo/redo, branches, jumps, deleting a
 * step with dependants, observed changes, save and load
 * (`assets/js/app/actions/`, `assets/js/app/history/`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction, catalogDocument, toolNameOf } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher, ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { schemaProblem, withDefaults, exampleOf, assertActionSchema } from '../assets/js/app/actions/schema.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { hashValue, createValuePool } from '../assets/js/app/history/value-pool.js';
import { pathTo } from '../assets/js/app/history/tree.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { stateFingerprint } from '../assets/js/app/state/domains/fingerprint.js';

/** A page with three domains: labels (a map), a color, a camera number; plus the rest as constants. */
function fakePage() {
  const state = { labels: { a: 'A', b: 'B' }, color: 'red', camera: 0, settings: { size: 1 } };
  const domains = createDomainRegistry();
  const restores = [];
  for (const id of ['field-overlays', 'colors', 'camera', 'settings']) {
    const key = { 'field-overlays': 'labels', colors: 'color', camera: 'camera', settings: 'settings' }[id];
    domains.provide(id, {
      capture: () => structuredClone(state[key]),
      restore: value => { restores.push(id); state[key] = structuredClone(value); },
      describe: (a, b) => [`${JSON.stringify(a)} → ${JSON.stringify(b)}`],
    });
  }
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  return { state, domains, restores };
}

const definitions = [
  defineAction({
    type: 'category.rename', title: 'Rename a category', summary: 'Give a category a new label.', group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } },
    },
    touches: ['field-overlays'], reads: [], effect: 'state',
    describe: p => `Renamed ${p.from} to ${p.to}`, code: p => `rename_category(${JSON.stringify(p.from)}, ${JSON.stringify(p.to)})`,
  }),
  defineAction({
    type: 'color.set', title: 'Set the color', summary: 'Color everything one color.', group: 'Colors',
    params: {
      type: 'object', additionalProperties: false, required: ['color'],
      properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] }, slow: { type: 'boolean', default: false } },
    },
    touches: ['colors'], reads: [], effect: 'view', coalesce: () => 'one',
    describe: p => `Colored ${p.color}`, code: p => `set_color(${JSON.stringify(p.color)})`,
  }),
  defineAction({
    type: 'camera.set', title: 'Move the camera', summary: 'Place the camera.', group: 'Camera',
    params: { type: 'object', additionalProperties: false, required: ['at'], properties: { at: { type: 'number' } } },
    touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'camera',
    describe: p => `Camera at ${p.at}`, code: p => `camera(${p.at})`,
  }),
  defineAction({
    type: 'file.write', title: 'Write a file', summary: 'Write a copy.', group: 'Files',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['settings'], reads: [], effect: 'state', confirm: 'writes-file',
    describe: () => 'Wrote a file', code: () => 'write()',
  }),
  defineAction({
    type: 'labels.read', title: 'Read labels', summary: 'List the labels.', group: 'Fields',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [], effect: 'read', describe: () => 'Read labels', code: () => 'labels()',
  }),
  defineAction({
    type: 'broken.half', title: 'Fail halfway', summary: 'Changes something, then fails.', group: 'Test',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['colors'], reads: [], effect: 'view', describe: () => 'Failed', code: () => 'fail()',
  }),
];

function setup({ withHistoryActions = false } = {}) {
  const pendingTaskEnds = [];
  const page = fakePage();
  const catalog = createActionCatalog(withHistoryActions ? [...definitions, ...historyActions] : definitions);
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.provide('category.rename', ({ from, to }) => {
    if (!(from in invertLabels(page.state.labels))) throw new ActionRefused(`There is no category "${from}"`);
    const key = invertLabels(page.state.labels)[from];
    page.state.labels = { ...page.state.labels, [key]: to };
    return { renamed: 1 };
  });
  dispatcher.provide('color.set', async ({ color, slow }) => {
    if (slow) await new Promise(resolve => setTimeout(resolve, 20));
    page.state.color = color;
  });
  dispatcher.provide('camera.set', ({ at }) => { page.state.camera = at; });
  dispatcher.provide('file.write', () => { page.state.settings = { ...page.state.settings, wrote: true }; });
  dispatcher.provide('labels.read', () => ({ labels: page.state.labels }));
  dispatcher.provide('broken.half', () => { page.state.color = 'purple'; throw new Error('boom'); });
  let n = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: (() => { let t = 0; return () => ++t; })(),
    nextTask: fn => { pendingTaskEnds.push(fn); },
  });
  /** The page's task ends (the events of one gesture are in one task; the next gesture's in the next). */
  const endTask = () => { for (const fn of pendingTaskEnds.splice(0)) fn(); };
  return { page, catalog, dispatcher, history, endTask };
}

function invertLabels(labels) {
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [v, k]));
}

test('schemas: a closed subset, checked when an action is defined', () => {
  assert.throws(() => assertActionSchema({ type: 'object', properties: {} }), /additionalProperties: false/);
  assert.throws(() => assertActionSchema({ type: 'string', format: 'email' }), /unsupported keyword "format"/);
  assert.throws(() => assertActionSchema({ type: 'array' }), /arrays must declare items/);
  assert.throws(() => assertActionSchema({ type: 'integer', default: 'x' }), /default does not match/);
  const schema = definitions[0].params;
  assert.equal(schemaProblem(schema, { from: 'A', to: 'B' }), null);
  assert.match(schemaProblem(schema, { from: 'A', too: 'B' }), /has no parameter "too" \(known: from, to\)/);
  assert.match(schemaProblem(schema, { from: 'A' }), /params\.to is required/);
  assert.match(schemaProblem(definitions[1].params, { color: 'pink' }), /must be one of "red", "green", "blue"/);
  assert.deepEqual(withDefaults(definitions[1].params, { color: 'red' }), { color: 'red', slow: false });
  assert.deepEqual(exampleOf(schema), { from: 'x', to: 'x' });
  const cells = { type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true, minItems: 1 };
  assert.equal(schemaProblem(cells, new Uint32Array([1, 2])), null);
  assert.match(schemaProblem(cells, new Uint32Array(0)), /at least 1 cell/);
  assert.match(schemaProblem(cells, [1, -1]), /\[1\] must be at least 0/);
});

test('definitions: dotted names, known domains, reads touch nothing', () => {
  const base = { title: 't', summary: 's', group: 'g', params: { type: 'object', additionalProperties: false, properties: {} }, describe: () => '', code: () => '' };
  assert.throws(() => defineAction({ ...base, type: 'Bad', touches: ['colors'], reads: [], effect: 'view' }), /dotted lowercase/);
  assert.throws(() => defineAction({ ...base, type: 'a.b', touches: ['nope'], reads: [], effect: 'view' }), /unknown domain "nope"/);
  assert.throws(() => defineAction({ ...base, type: 'a.b', touches: ['colors'], reads: [], effect: 'read' }), /a read or a history move touches no domain/);
  assert.throws(() => defineAction({ ...base, type: 'a.b', reads: [], effect: 'view' }), /every other action touches one/);
  // A move of the history shows another step and records none: it touches no domain.
  assert.throws(() => defineAction({ ...base, type: 'a.b', touches: ['colors'], reads: [], effect: 'history' }), /a read or a history move touches no domain/);
  assert.equal(defineAction({ ...base, type: 'a.b', reads: [], effect: 'history' }).touches.length, 0);
  assert.throws(() => defineAction({ ...base, type: 'a.b', reads: [], effect: 'undo' }), /effect must be one of state, view, layout, read, control, history, dataset, outside/);
  assert.throws(() => defineAction({ ...base, type: 'a.b', touches: ['colors'], reads: [], effect: 'view', extra: 1 }), /unknown field "extra"/);
  assert.throws(() => createActionCatalog([definitions[0], definitions[0]]), /defined twice/);
  assert.equal(toolNameOf('filter.category-visibility'), 'filter_category_visibility');
  const doc = catalogDocument(createActionCatalog(definitions));
  assert.deepEqual(doc.actions.map(a => a.type), [...definitions.map(d => d.type)].sort());
  assert.equal(JSON.stringify(doc), JSON.stringify(catalogDocument(createActionCatalog([...definitions].reverse()))));
});

test('value hashes: by content, typed arrays by bytes, NaN, ±Infinity and -0 by a typed form, non-plain objects refused', async () => {
  assert.equal(await hashValue({ a: 1, b: [2, 3] }), await hashValue({ b: [2, 3], a: 1 }));
  assert.notEqual(await hashValue({ a: 1 }), await hashValue({ a: 2 }));
  assert.equal(await hashValue({ c: new Uint32Array([1, 2]) }), await hashValue({ c: new Uint32Array([1, 2]) }));
  assert.notEqual(await hashValue({ c: new Uint32Array([1, 2]) }), await hashValue({ c: new Int32Array([1, 2]) }));
  await assert.rejects(hashValue({ m: new Map() }), /holds a Map object at value\.m/);
  // A number JSON cannot hold has a typed form of its own, never the text it prints as.
  for (const [special, text] of [[Number.NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity']]) {
    assert.notEqual(await hashValue({ v: special }), await hashValue({ v: text }), `${text} is not the text "${text}"`);
    assert.equal(await hashValue({ v: special }), await hashValue({ v: special }));
  }
  assert.notEqual(await hashValue({ v: -0 }), await hashValue({ v: 0 }), '-0 is not 0');
  assert.notEqual(await hashValue({ v: -0 }), await hashValue({ v: '-0' }));
  assert.notEqual(await hashValue(Number.NaN), await hashValue(Infinity));
  // The typed forms are those of the stored skeleton, so an object may not pose as one.
  await assert.rejects(hashValue({ v: { $number: 'NaN' } }), /reserved key "\$array", "\$number" or "\$part" at value\.v/);
  await assert.rejects(hashValue({ $array: 'Uint8Array:1:00' }), /reserved key/);
  const pool = createValuePool();
  const h = await pool.put({ x: new Uint8Array(10) });
  assert.equal(await pool.put({ x: new Uint8Array(10) }), h);
  assert.equal(pool.size, 1);
  assert.equal(pool.byteLength(), 10);
});

test('dispatch records one step per change, with origin; undo and redo restore exactly', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  const { step } = await dispatcher.dispatch('category.rename', { from: 'A', to: 'T cells' });
  assert.equal(step.label, 'Renamed A to T cells');
  assert.equal(step.by.origin, 'user');
  assert.deepEqual(step.touches, ['field-overlays']);
  await dispatcher.dispatch('color.set', { color: 'blue' }, { origin: 'agent', agent: 'Claude', turn: 'turn1' });
  assert.equal(history.active.steps.size, 3);
  assert.equal(history.active.steps.get(history.active.headId).by.agent, 'Claude');

  assert.equal(await history.undo(), true);
  assert.deepEqual(page.state, { labels: { a: 'T cells', b: 'B' }, color: 'red', camera: 0, settings: { size: 1 } });
  assert.equal(await history.undo(), true);
  assert.deepEqual(page.state.labels, { a: 'A', b: 'B' });
  assert.equal(await history.undo(), false);
  assert.equal(await history.redo(), true);
  assert.equal(await history.redo(), true);
  assert.deepEqual(page.state, { labels: { a: 'T cells', b: 'B' }, color: 'blue', camera: 0, settings: { size: 1 } });
  assert.equal(await history.redo(), false);
});

test('a no-op is no step; a read is no step and returns its result', async () => {
  const { dispatcher, history } = setup();
  await history.startTracker();
  const { step, unrecorded } = await dispatcher.dispatch('color.set', { color: 'red' });
  assert.deepEqual([step, unrecorded], [null, 'unchanged'], 'a no-op says why it made no step');
  const read = await dispatcher.dispatch('labels.read', {});
  assert.deepEqual(read, { outcome: { labels: { a: 'A', b: 'B' } }, step: null, unrecorded: null });
  assert.equal(history.active.steps.size, 1);
});

test('consecutive coalescing steps merge into one; another action in between ends the merge', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  for (const at of [1, 2, 3]) await dispatcher.dispatch('camera.set', { at });
  assert.equal(history.active.steps.size, 2);
  await dispatcher.dispatch('color.set', { color: 'green' });
  await dispatcher.dispatch('camera.set', { at: 9 });
  assert.equal(history.active.steps.size, 4);
  await history.undo();
  assert.equal(page.state.camera, 3);
  await history.undo();
  await history.undo();
  assert.equal(page.state.camera, 0);
});

test('a merge is shared by its author: a turn parts an agent\'s or a notebook\'s changes, never a person\'s', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  // A person's `turn` is not recorded (`byOfMeta`): their gestures on one view are one step.
  for (const at of [1, 2, 3]) await dispatcher.dispatch('camera.set', { at }, { turn: `cell-${at}` });
  assert.equal(history.active.steps.size, 2);
  // Each notebook cell is a turn of its own: one step each.
  for (const at of [4, 5]) await dispatcher.dispatch('camera.set', { at }, { origin: 'host', host: 'python', turn: `cell-${at}` });
  assert.equal(history.active.steps.size, 4);
  // A host naming a language the history cannot record is refused before its handler runs.
  await assert.rejects(dispatcher.dispatch('camera.set', { at: 6 }, { origin: 'host', host: 'julia', turn: 'cell-6' }),
    /^TypeError: A host action names its language: one of python, r$/);
  await assert.rejects(dispatcher.dispatch('camera.set', { at: 6 }, { origin: 'host', turn: 'cell-6' }),
    /^TypeError: A host action names its language: one of python, r$/);
  assert.equal(page.state.camera, 5);
  assert.equal(history.active.steps.size, 4);
});

test('a handler that fails after changing something leaves no half-state and no step', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  await assert.rejects(dispatcher.dispatch('broken.half', {}), /boom/);
  assert.equal(page.state.color, 'red');
  assert.equal(history.active.steps.size, 1);
});

test('a retired dispatcher ends the dispatch under way as a cancellation, records nothing, and refuses later ones', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  const steps = history.active.steps.size;
  const restores = page.restores.length;
  // Its handler is running when the application retires (the teardown withdraws the state's owners next).
  const running = dispatcher.dispatch('color.set', { color: 'blue', slow: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  dispatcher.retire();
  await assert.rejects(running, error => error.name === 'AbortError' && error.kind === 'closed');
  assert.equal(history.active.steps.size, steps, 'no step is recorded');
  assert.equal(page.restores.length, restores, 'nothing is put back into an owner');
  await assert.rejects(dispatcher.dispatch('camera.set', { at: 3 }), error => error.name === 'AbortError' && error.kind === 'closed');
  assert.equal(page.state.camera, 0, 'a later dispatch never runs');
  dispatcher.retire();
});

test('wrong parameters and unknown categories are refused with a sentence; nothing is recorded', async () => {
  const { dispatcher, history } = setup();
  await history.startTracker();
  await assert.rejects(dispatcher.dispatch('color.set', { colour: 'red' }), /has no parameter "colour"/);
  await assert.rejects(dispatcher.dispatch('category.rename', { from: 'Z', to: 'Y' }), /There is no category "Z"/);
  await assert.rejects(dispatcher.dispatch('nope.nope', {}), /There is no action "nope.nope"/);
  assert.equal(history.active.steps.size, 1);
});

test('an agent asks before a confirm action; a person does not', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  await assert.rejects(
    dispatcher.dispatch('file.write', {}, { origin: 'agent', agent: 'Claude' }),
    error => error.code === 'needs-confirmation',
  );
  const asked = [];
  dispatcher.setConfirmer(({ definition }) => { asked.push(definition.type); return asked.length > 1; });
  await assert.rejects(dispatcher.dispatch('file.write', {}, { origin: 'agent', agent: 'Claude' }), /declined/);
  assert.equal(page.state.settings.wrote, undefined);
  await dispatcher.dispatch('file.write', {}, { origin: 'agent', agent: 'Claude' });
  assert.equal(page.state.settings.wrote, true);
  await dispatcher.dispatch('file.write', {}, { origin: 'user' });
  assert.deepEqual(asked, ['file.write', 'file.write']);
});

test('acting after an undo starts a branch; both branches stay and can be shown', async () => {
  const { page, dispatcher, history } = setup({ withHistoryActions: true });
  await history.startTracker();
  await dispatcher.dispatch('color.set', { color: 'green' });
  const greenTip = history.active.headId;
  await history.undo();
  await dispatcher.dispatch('color.set', { color: 'blue' });
  const blueTip = history.active.headId;
  const tree = history.active;
  assert.equal(tree.branches.size, 2);
  assert.equal(history.branchOf(greenTip).name, 'Main');
  assert.equal(history.branchOf(blueTip).name, 'Branch 1');
  assert.equal(history.branchOf(blueTip).base, tree.rootId, 'the branch forks at the step it was made after');
  await dispatcher.dispatch('history.branch.rename', { branch: history.branchOf(blueTip).id, name: 'Blue idea' });
  assert.equal(history.branchOf(blueTip).name, 'Blue idea');
  await history.jump(greenTip);
  assert.equal(page.state.color, 'green');
  await history.undo();
  assert.equal(await history.redo(), true);
  assert.equal(page.state.color, 'green', 'redo follows the branch shown last');
  const diff = await history.diff(greenTip, blueTip);
  assert.deepEqual(diff.domains, [{ domain: 'colors', lines: ['"green" → "blue"'] }]);
  // A branch is found by its name or id, in any case (what `view.keep` compares branches by).
  assert.equal(history.tipNamed('Blue idea'), blueTip);
  assert.equal(history.tipNamed('blue IDEA'), blueTip);
  assert.equal(history.tipNamed('Main'), greenTip);
  assert.throws(() => history.tipNamed('Red'), error => error instanceof ActionRefused
    && error.message === 'There is no branch "Red"; the branches are "Main" and "Blue idea".');
  // Names are unique: a clash is refused, naming the other.
  await assert.rejects(
    dispatcher.dispatch('history.branch.rename', { branch: 'Main', name: 'blue idea' }),
    error => error.code === 'name-taken' && /A branch is already called "Blue idea" \(from step 0\)/.test(error.message),
  );
});

test('jumps restore only the domains that differ', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  await dispatcher.dispatch('category.rename', { from: 'A', to: 'Q' });
  const first = history.active.headId;
  await dispatcher.dispatch('color.set', { color: 'green' });
  page.restores.length = 0;
  await history.jump(first);
  assert.deepEqual(page.restores, ['colors']);
});

test('deleting a step re-applies what came after; a step that depended on it is flagged, not dropped', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  await dispatcher.dispatch('category.rename', { from: 'A', to: 'T' });
  const renameA = history.active.headId;
  await dispatcher.dispatch('category.rename', { from: 'T', to: 'T cells' });
  await dispatcher.dispatch('color.set', { color: 'blue' });
  const { flagged: report } = await history.deleteStep(renameA);
  assert.equal(report.length, 1);
  assert.match(report[0].reason, /no category "T"/);
  const steps = pathTo(history.active, history.active.headId);
  assert.deepEqual(steps.map(s => s.status), ['applied', 'unapplicable', 'applied']);
  assert.deepEqual(page.state.labels, { a: 'A', b: 'B' });
  assert.equal(page.state.color, 'blue');
});

test('deleting the last step of the branch shown (the head, the tip) shows the step before it; the branch ends there', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  const colorBefore = page.state.color;
  await dispatcher.dispatch('category.rename', { from: 'A', to: 'T' });
  const renamed = history.active.headId;
  await dispatcher.dispatch('color.set', { color: 'blue' });
  const blue = history.active.headId;
  assert.deepEqual((await history.deleteStep(blue)).flagged, []);
  assert.equal(history.active.headId, renamed);
  assert.equal(history.active.branches.get(history.active.activeBranch).tip, renamed);
  assert.equal(page.state.color, colorBefore);
  // Another branch below the step shown: the branch shown keeps being shown, ending at its parent.
  await history.undo();
  await dispatcher.dispatch('color.set', { color: 'red' });
  const red = history.active.headId;
  await history.jump(renamed);
  assert.deepEqual((await history.deleteStep(renamed)).flagged, []);
  assert.equal(history.active.activeBranch, 'b0');
  assert.equal(history.active.branches.get('b0').tip, history.active.rootId);
  assert.ok(history.active.steps.has(red), 'the other branch keeps its step');
});

test('changes made outside an action are kept as their own step, so undo still lands where it was', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  page.state.color = 'green';
  await dispatcher.dispatch('color.set', { color: 'blue' });
  const labels = pathTo(history.active, history.active.headId).map(s => s.label);
  assert.deepEqual(labels, ['Opened', 'Changed outside the history', 'Colored blue']);
  await history.undo();
  assert.equal(page.state.color, 'green');
});

test('observed changes record a step; the change events a restore causes do not', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  page.state.camera = 5;
  await dispatcher.recordObserved('camera.set', { at: 5 });
  assert.equal(history.active.steps.size, 2);
  await history.undo();
  // A camera-settled event arriving after the restore observes what is shown: no step.
  assert.equal(await dispatcher.recordObserved('camera.set', { at: 0 }), null);
  assert.equal(history.active.steps.size, 2);
});

test('changes observed in quick succession that merge into one step leave it naming the last value', async () => {
  // A slider moved by four key presses fires four events, each before the
  // record of the one before it has run. Each change is read as soon as its
  // effects settle, and its record's turn uses that reading once a later
  // change of the same domain came: the merged step shows and names the last.
  const { page, dispatcher, history, endTask } = setup();
  await history.startTracker();
  const records = [];
  for (const at of [1, 2, 3, 4]) {
    page.state.camera = at;
    records.push(dispatcher.recordObserved('camera.set', { at }));
    endTask();
  }
  await Promise.all(records);
  await history.idle();
  assert.equal(history.active.steps.size, 2, 'one merged step');
  const head = history.active.steps.get(history.active.headId);
  assert.deepEqual(head.params, { at: 4 });
  assert.equal(head.label, 'Camera at 4');
  assert.equal(history.pool.get(head.after.camera), 4);
  assert.equal(head.merged, 4);

  // A change that finds nothing changed and merges into nothing is still no step.
  await history.undo();
  assert.equal(await dispatcher.recordObserved('camera.set', { at: 0 }), null);
  assert.equal(history.active.steps.size, 2);
});

test('two quick changes of one domain that do not merge are two steps, each holding its own value', async () => {
  // The second change happens before the first one's record runs; the first is read as its effects
  // settled, so it never takes in the second, and the second is not dropped as "nothing changed".
  const { page, dispatcher, history, endTask } = setup();
  await history.startTracker();
  page.state.labels = { a: 'X', b: 'B' };
  const first = dispatcher.recordObserved('category.rename', { from: 'A', to: 'X' });
  endTask();
  page.state.labels = { a: 'X', b: 'Y' };
  const second = dispatcher.recordObserved('category.rename', { from: 'B', to: 'Y' });
  const [one, two] = await Promise.all([first, second]);
  assert.ok(one !== null && two !== null);
  assert.notEqual(one.id, two.id);
  assert.deepEqual(history.pool.get(history.active.steps.get(one.id).after['field-overlays']), { a: 'X', b: 'B' });
  assert.deepEqual(history.pool.get(history.active.steps.get(two.id).after['field-overlays']), { a: 'X', b: 'Y' });
  assert.equal(history.active.steps.get(one.id).label, 'Renamed A to X');
});

test('changes observed in one task are one gesture: the step holds all of it, the later records find nothing new', async () => {
  // A select fires `input`, then `change`, whose own listener sets what the choice names (a size
  // preset sets the sizes): both events are observed in one task, one gesture, one step.
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  page.state.labels = { a: 'X', b: 'B' };
  const first = dispatcher.recordObserved('category.rename', { from: 'A', to: 'X' });
  page.state.labels = { a: 'X', b: 'Y' };
  const second = dispatcher.recordObserved('category.rename', { from: 'B', to: 'Y' });
  const [one, two] = await Promise.all([first, second]);
  assert.ok(one !== null);
  assert.equal(two, null);
  assert.deepEqual(history.pool.get(history.active.steps.get(one.id).after['field-overlays']), { a: 'X', b: 'Y' });
  assert.equal(history.active.steps.size, 2);
});

test('an observed change alone is read when its turn comes, holding effects that settle after its event', async () => {
  // A change whose effects finish after the event (a camera settling on a pane, a size preset laying
  // out): with no later change of its domains, the record reads the state when its turn comes.
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  page.state.camera = 1;
  const recorded = dispatcher.recordObserved('camera.set', { at: 2 });
  page.state.camera = 2; // the effect lands after the event, before the record's turn
  const step = await recorded;
  assert.equal(history.pool.get(step.after.camera), 2);
});

test('a change observed while an action on the same domain applies is part of that action\'s step', async () => {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(definitions) });
  let release;
  let started;
  const applying = new Promise(resolve => { started = resolve; });
  dispatcher.provide('broken.half', () => {
    started();
    return new Promise(resolve => { release = resolve; }).then(() => { page.state.color = 'green'; });
  });
  dispatcher.provide('camera.set', ({ at }) => { page.state.camera = at; });
  const history = createHistory({ dispatcher, domains: page.domains, dataset: { id: 'd', name: 'D', cellOrder: null }, newTrackerId: () => 't-00000000-0000-4000-8000-000000000001' });
  await history.startTracker();
  const running = dispatcher.dispatch('broken.half', {});
  await applying;
  // A camera-settled the action itself caused (not a color action: another domain) is still its own step.
  page.state.camera = 2;
  assert.notEqual(await dispatcher.recordObserved('camera.set', { at: 2 }), null);
  // A color change seen while the color action applies is the action's.
  page.state.color = 'blue';
  assert.equal(await dispatcher.recordObserved('color.set', { color: 'blue' }), null);
  release();
  await running;
  assert.deepEqual(pathTo(history.active, history.active.headId).map(step => step.label), ['Opened', 'Camera at 2', 'Failed']);
  await history.undo();
  assert.equal(page.state.color, 'red');
});

test('showing a step that reads other cells captures every domain again before the next is compared', async () => {
  const state = { cells: 100, camera: 3 };
  const domains = createDomainRegistry();
  // Reading the cells again puts the camera back to its start (a dataset re-read frames it).
  domains.provide('cells', { capture: () => state.cells, restore: value => { state.cells = value; state.camera = 0; } });
  domains.provide('camera', { capture: () => state.camera, restore: value => { state.camera = value; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const catalog = createActionCatalog([
    defineAction({
      type: 'cells.open', title: 'Open cells', summary: 'Read the dataset again on a share of its cells.', group: 'Data',
      params: { type: 'object', additionalProperties: false, required: ['share'], properties: { share: { type: 'integer', minimum: 1 } } },
      touches: ['cells', 'camera'], reads: [], effect: 'state', describe: p => `Opened ${p.share}`, code: p => `open(${p.share})`,
    }),
    definitions[2],
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.provide('cells.open', ({ share }) => { state.cells = share; state.camera = 0; });
  dispatcher.provide('camera.set', ({ at }) => { state.camera = at; });
  const history = createHistory({ dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null }, newTrackerId: () => 't-00000000-0000-4000-8000-000000000001' });
  await history.startTracker();
  await dispatcher.dispatch('cells.open', { share: 50 });
  await dispatcher.dispatch('camera.set', { at: 3 });
  assert.deepEqual(state, { cells: 50, camera: 3 });
  // Only the cells differ from the opening; reading them again moves the camera, which is then put back too.
  await history.jump(history.active.rootId);
  assert.deepEqual(state, { cells: 100, camera: 3 });
  await history.redo();
  assert.deepEqual(state, { cells: 50, camera: 0 });
});

test('undo, redo and jumps are actions: no step, the head moves and the state follows', async () => {
  const { page, dispatcher, history } = setup({ withHistoryActions: true });
  const host = { origin: 'host', host: 'python' };
  // Before the dataset's first tracker there is nothing to move.
  await assert.rejects(dispatcher.dispatch('history.undo', {}, host), /^ActionRefused: The history starts once a dataset is open\.$/);
  await history.startTracker();
  await dispatcher.dispatch('category.rename', { from: 'A', to: 'T cells' });
  await dispatcher.dispatch('camera.set', { at: 2 });
  const tree = history.active;
  assert.equal(tree.headId, 's2');

  assert.deepEqual(await dispatcher.dispatch('history.undo', {}, host), { outcome: { moved: true, head: 's1' }, step: null, unrecorded: null });
  assert.deepEqual(page.state, { labels: { a: 'T cells', b: 'B' }, color: 'red', camera: 0, settings: { size: 1 } });
  assert.equal(tree.steps.size, 3, 'a move of the history records no step');
  assert.deepEqual(await dispatcher.dispatch('history.redo', {}, host), { outcome: { moved: true, head: 's2' }, step: null, unrecorded: null });
  assert.equal(page.state.camera, 2);
  assert.deepEqual(await dispatcher.dispatch('history.redo', {}), { outcome: { moved: false, head: 's2' }, step: null, unrecorded: null });

  assert.deepEqual(await dispatcher.dispatch('history.jump', { step: 's0' }, host), { outcome: { head: 's0' }, step: null, unrecorded: null });
  assert.deepEqual(page.state.labels, { a: 'A', b: 'B' });
  assert.equal(page.state.camera, 0);
  assert.deepEqual(await dispatcher.dispatch('history.undo', {}), { outcome: { moved: false, head: 's0' }, step: null, unrecorded: null });
  // A jump keeps the branch: redo walks it again.
  assert.deepEqual((await dispatcher.dispatch('history.redo', {})).outcome, { moved: true, head: 's1' });
  assert.equal(tree.steps.size, 3);

  await assert.rejects(
    dispatcher.dispatch('history.jump', { step: 's9' }, host),
    /^ActionRefused: There is no step "s9" in the tracker "Tracker 1"; history_get lists its steps\.$/,
  );
  await assert.rejects(dispatcher.dispatch('history.jump', { step: 'step 1' }, host), TypeError);
  assert.equal(tree.headId, 's1');

  // A move waits for the action running, then undoes it.
  const slow = dispatcher.dispatch('color.set', { color: 'green', slow: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  const back = await dispatcher.dispatch('history.undo', {}, host);
  await slow;
  assert.deepEqual(back.outcome, { moved: true, head: 's1' });
  assert.equal(page.state.color, 'red');
  assert.equal(tree.steps.size, 4, 'the color step stays, to redo');

  history.destroy();
  for (const type of ['history.get', 'history.undo', 'history.redo', 'history.jump']) {
    assert.equal(dispatcher.provided(type), false, `${type} goes with its history`);
  }
});

test('one agent turn undoes in one click', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  await dispatcher.dispatch('camera.set', { at: 1 });
  const meta = { origin: 'agent', agent: 'ChatGPT', turn: 'turn-7' };
  await dispatcher.dispatch('category.rename', { from: 'A', to: 'X' }, meta);
  await dispatcher.dispatch('color.set', { color: 'blue' }, meta);
  const result = await history.undoTurn('turn-7');
  assert.equal(result.removed, 0, 'its steps alone at the end: back to before it, kept for redo');
  const turn = history.active.turns.get('turn-7');
  assert.equal(turn.by.agent, 'ChatGPT');
  assert.equal(turn.label, 'Renamed A to X', 'a turn with no label of its own takes its first step\'s');
  assert.deepEqual(page.state, { labels: { a: 'A', b: 'B' }, color: 'red', camera: 1, settings: { size: 1 } });
});

test('actions on overlapping domains run in order; a jump waits for running actions and holds new ones', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  const slow = dispatcher.dispatch('color.set', { color: 'green', slow: true });
  const fast = dispatcher.dispatch('color.set', { color: 'blue' });
  await Promise.all([slow, fast]);
  assert.equal(page.state.color, 'blue');
  const undo = history.undo();
  const during = dispatcher.dispatch('camera.set', { at: 4 });
  await Promise.all([undo, during]);
  // The two color steps coalesced into one, so undo returns to the color before both.
  assert.equal(page.state.color, 'red');
  assert.equal(history.active.steps.size, 3);
  assert.equal(page.state.camera, 4);
});

test('trackers: independent trees on one dataset; save and load restore every tracker at its head', async () => {
  const { page, dispatcher, history } = setup();
  const first = await history.startTracker({ name: 'Annotation' });
  await dispatcher.dispatch('category.rename', { from: 'A', to: 'T cells' });
  const second = await history.startTracker({ name: 'Exploration', start: 'shown' });
  await dispatcher.dispatch('color.set', { color: 'green' });
  assert.equal(first.steps.size, 2);
  assert.equal(second.steps.size, 2);
  assert.equal(second.steps.get(second.rootId).after['field-overlays'], first.steps.get(first.headId).after['field-overlays'],
    'a tracker starts from what was shown');
  await history.useTracker(first.id);
  assert.equal(page.state.color, 'red', 'each tracker shows its own state');
  assert.deepEqual(page.state.labels, { a: 'T cells', b: 'B' });
  const saved = structuredClone(history.snapshot());
  const values = Object.fromEntries(history.pool.hashes().map(h => [h, history.pool.get(h)]));

  const fresh = setup();
  for (const [hash, value] of Object.entries(values)) fresh.history.pool.adopt(hash, value);
  await fresh.history.load(saved);
  assert.deepEqual(fresh.history.trackers().map(t => t.name), ['Annotation', 'Exploration']);
  assert.deepEqual(fresh.page.state, page.state);
  await fresh.history.undo();
  assert.deepEqual(fresh.page.state.labels, { a: 'A', b: 'B' });
});

test('deleting the step shown at the end of its branch shows its parent and ends the branch there', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  const { step: first } = await dispatcher.dispatch('color.set', { color: 'blue' });
  const { step: second } = await dispatcher.dispatch('camera.set', { at: 4 });
  assert.equal(history.active.headId, second.id);
  assert.equal(history.active.branches.get(history.active.activeBranch).tip, second.id);
  assert.deepEqual((await history.deleteStep(second.id)).flagged, []);
  assert.equal(history.active.headId, first.id);
  assert.equal(history.active.branches.get(history.active.activeBranch).tip, first.id);
  assert.equal(history.active.steps.has(second.id), false);
  assert.equal(page.state.camera, 0);
  assert.equal(page.state.color, 'blue');

  // On a branch: the active branch ends in the newest tip left below the parent.
  const { step: kept } = await dispatcher.dispatch('camera.set', { at: 7 });
  await history.undo();
  const { step: branch } = await dispatcher.dispatch('color.set', { color: 'green' });
  assert.equal(history.active.branches.get(history.active.activeBranch).tip, branch.id);
  await history.deleteStep(branch.id);
  assert.equal(history.active.headId, first.id);
  assert.equal(history.active.branches.get(history.active.activeBranch).tip, kept.id);
  assert.equal(page.state.color, 'blue');
  assert.equal(page.state.camera, 0);
  await history.redo();
  assert.equal(page.state.camera, 7);
});

test('idle resolves once no action, history operation or observed change is under way, those started meanwhile included', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  const order = [];
  // A slow action, an observed change recorded behind it and an undo queued after both.
  const slow = dispatcher.dispatch('color.set', { color: 'blue', slow: true }).then(() => order.push('action'));
  page.state.camera = 3;
  const observed = dispatcher.recordObserved('camera.set', { at: 3 }).then(() => order.push('observed'));
  const idle = history.idle().then(() => order.push('idle'));
  const undo = history.undo().then(() => order.push('undo'));
  await Promise.all([slow, observed, idle, undo]);
  assert.equal(order.at(-1), 'idle', `idle waits for everything under way when it was asked: ${order.join(', ')}`);
  assert.deepEqual(order.slice(0, -1).sort(), ['action', 'observed', 'undo']);
  // Nothing under way: it resolves at once.
  await history.idle();

  // A control's change asked while a history operation runs waits at the
  // gate, and is under way from the moment it is asked: the dispatcher's own
  // idle waits for it.
  const gatedOrder = [];
  const before = dispatcher.dispatch('color.set', { color: 'green', slow: true });
  const move = history.undo();
  const gated = dispatcher.dispatch('camera.set', { at: 5 }).then(() => gatedOrder.push('gated'));
  await dispatcher.idle().then(() => gatedOrder.push('idle'));
  assert.deepEqual(gatedOrder, ['gated', 'idle'], 'idle waits for a change held at the gate');
  assert.equal(page.state.camera, 5);
  await Promise.all([before, move, gated]);

  // One waiting for the person's go-ahead waits for a person, not for work:
  // idle, asked before the question is (while the start is judged), resolves
  // once the person is asked, before they answer (in a later turn of the
  // page), and waits for the change once given.
  dispatcher.setConfirmer(({ asking }) => new Promise(resolve => { asking(); setImmediate(() => resolve(true)); }));
  const asked = dispatcher.dispatch('file.write', {}, { origin: 'agent', agent: 'Claude' });
  await dispatcher.idle();
  assert.equal(page.state.settings.wrote, undefined, 'idle resolved while the person was asked');
  await new Promise(resolve => setImmediate(resolve));
  await dispatcher.idle();
  assert.equal(page.state.settings.wrote, true);
  await asked;
});

test('idle does not wait for a question an implementation asks, nor one a dispatch it runs asks through it', async () => {
  const definition = (type, extra = {}) => defineAction({
    type, title: type, summary: 'A change.', group: 'Test',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['settings'], reads: [], effect: 'state', describe: () => type, code: () => `${type}()`, ...extra,
  });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([
    definition('download.large', { confirm: 'large-download', confirmAt: 'handler' }),
    // A move of the history, which replays steps as internal dispatches.
    definition('outer.replay', { effect: 'history', touches: [] }),
    definition('inner.step'),
  ]) });
  const done = [];
  dispatcher.provide('download.large', async (params, { confirm }) => { await confirm('It downloads 2 GB.'); done.push('download'); });
  dispatcher.provide('inner.step', async (params, { heavy }) => {
    await heavy({ ms: 60_000, bytes: null, what: 'It reads every gene.' });
    done.push('inner');
  });
  dispatcher.provide('outer.replay', (params, { heavy, signal }) =>
    dispatcher.dispatch('inner.step', {}, { origin: 'replay', internal: true, heavy, signal }));
  const questions = [];
  // Every change of an agent's passes the confirmer at its start: allowed
  // there, asked only from the implementation, and answered in a later turn
  // of the page.
  dispatcher.setConfirmer(({ stage, detail, asking }) => stage === 'start' || new Promise(resolve => {
    questions.push(detail);
    asking();
    setImmediate(() => resolve(true));
  }));
  const agent = { origin: 'agent', agent: 'Claude' };

  for (const type of ['download.large', 'outer.replay']) {
    const dispatched = dispatcher.dispatch(type, {}, agent);
    // Asked at once, while the start is judged: the question comes later, from the implementation.
    await dispatcher.idle();
    assert.equal(questions.length, 1, `${type}: idle resolved once its implementation asked the person`);
    assert.deepEqual(done, [], `${type}: idle resolved before the person answered`);
    await new Promise(resolve => setImmediate(resolve));
    await dispatcher.idle();
    assert.equal(done.length, 1, `${type}: idle waits for the work the answer let go on`);
    await dispatched;
    done.length = 0;
    questions.length = 0;
  }
});

test('a change observed with the work it set off is recorded once that work settles, as one step holding both; idle waits for it', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  let finishWork;
  const work = new Promise(resolve => { finishWork = resolve; });
  // A person's choice changes the labels now; the work it set off (a run after a delay) changes them again later.
  page.state.labels = { ...page.state.labels, a: 'chosen' };
  const recorded = dispatcher.recordObserved('category.rename', { from: 'A', to: 'chosen' }, {}, null, { after: work });
  let idle = false;
  const idleDone = history.idle().then(() => { idle = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(idle, false, 'the change is under way until its work settles');
  assert.equal(history.active.steps.size, 1, 'no step before the work settles');
  page.state.labels = { ...page.state.labels, b: 'ran' };
  finishWork();
  const step = await recorded;
  await idleDone;
  assert.equal(history.active.steps.size, 2, 'one step');
  assert.deepEqual(history.valueAt(step.id, 'field-overlays'), { a: 'chosen', b: 'ran' }, 'the step holds the choice and what its work changed');
  assert.deepEqual(history.shownHashes(), (await stateFingerprint(page.domains)).domains, 'nothing differs from what the history shows');
});

test('work still under way holds back only its own record; a move waits for it, so it never moves away from an unrecorded change', async () => {
  const { page, dispatcher, history } = setup();
  await history.startTracker();
  let settle;
  const work = new Promise(resolve => { settle = resolve; });
  page.state.labels = { ...page.state.labels, a: 'slow' };
  const slow = dispatcher.recordObserved('category.rename', { from: 'A', to: 'slow' }, {}, null, { after: work });
  page.state.camera = 4;
  const camera = await dispatcher.recordObserved('camera.set', { at: 4 });
  assert.ok(camera !== null, 'the camera change is recorded meanwhile');
  await dispatcher.dispatch('color.set', { color: 'green' });
  assert.equal(page.state.color, 'green', 'actions are not held back');
  let undone = false;
  const undo = history.undo().then(() => { undone = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(undone, false, 'undo waits for the change still under way');
  settle();
  await Promise.all([slow, undo]);
  // The slow change was recorded last, so undo takes it back and nothing else.
  assert.deepEqual(page.state.labels, { a: 'A', b: 'B' });
  assert.equal(page.state.color, 'green');
  assert.equal(history.active.branches.size, 1, 'no branch was made');
});
