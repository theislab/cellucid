/**
 * Defects of the history core, reproduced on fake domains
 * (`assets/js/app/history/history.js`, `tree.js`). Each test states what a
 * person expects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { redoTarget } from '../assets/js/app/history/tree.js';

function fakePage() {
  const state = { labels: { a: 'A' }, color: 'red', camera: 0 };
  const domains = createDomainRegistry();
  for (const [id, key] of [['field-overlays', 'labels'], ['colors', 'color'], ['camera', 'camera']]) {
    domains.provide(id, {
      capture: () => structuredClone(state[key]),
      restore: value => { state[key] = structuredClone(value); },
      describe: () => ['changed'],
    });
  }
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  return { state, domains };
}

const definitions = [
  defineAction({
    type: 'label.set', title: 'Set a label', summary: 'Set the label.', group: 'Fields',
    params: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'string', minLength: 1 } } },
    touches: ['field-overlays'], reads: [], effect: 'state', describe: p => `Label ${p.to}`, code: p => `label(${JSON.stringify(p.to)})`,
  }),
  defineAction({
    type: 'color.set', title: 'Set the color', summary: 'Color.', group: 'Colors',
    params: { type: 'object', additionalProperties: false, required: ['color'], properties: { color: { type: 'string', minLength: 1 } } },
    touches: ['colors'], reads: [], effect: 'view', describe: p => `Colored ${p.color}`, code: p => `color(${JSON.stringify(p.color)})`,
  }),
  defineAction({
    type: 'camera.set', title: 'Move the camera', summary: 'Place the camera.', group: 'Camera',
    params: { type: 'object', additionalProperties: false, required: ['at'], properties: { at: { type: 'number' } } },
    touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'camera', describe: p => `Camera at ${p.at}`, code: p => `camera(${p.at})`,
  }),
];

async function setup() {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(definitions) });
  dispatcher.provide('label.set', ({ to }) => { page.state.labels = { a: to }; });
  dispatcher.provide('color.set', ({ color }) => { page.state.color = color; });
  dispatcher.provide('camera.set', ({ at }) => { page.state.camera = at; });
  let n = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: (() => { let t = 0; return () => ++t; })(),
  });
  await history.startTracker();
  const act = async (type, params) => (await dispatcher.dispatch(type, params)).step.id;
  return { page, dispatcher, history, act };
}

test('deleting an earlier step keeps the branch redo follows', async () => {
  const { history, act } = await setup();
  const x = await act('label.set', { to: 'x' });
  const s1 = await act('color.set', { color: 'c1' });
  const s2 = await act('color.set', { color: 'c2' });
  const s3 = await act('color.set', { color: 'c3' });
  // A second branch from s2, two steps long.
  await history.jump(s2);
  await act('camera.set', { at: 5 });
  await act('label.set', { to: 'y' });
  // Back on Main: shown at s1, with s2 and s3 to redo.
  await history.jump(s3);
  await history.undo();
  await history.undo();
  const tree = history.active;
  assert.equal(tree.headId, s1);
  assert.equal(tree.branches.get(tree.activeBranch).tip, s3, 'Main is the branch shown');
  assert.equal(redoTarget(tree), s2);
  // Deleting the first step, which both branches come after, does not switch branches.
  await history.deleteStep(x);
  assert.equal(tree.headId, s1);
  assert.equal(tree.branches.get(tree.activeBranch).tip, s3, 'still on Main: redo goes on to s2 then s3');
  await history.redo();
  await history.redo();
  assert.equal(tree.headId, s3);
});

test('a camera move after jumping to an old branch tip is a new step; the tip keeps the state it recorded', async () => {
  const { page, history, act } = await setup();
  const tipB = await act('camera.set', { at: 1 });
  await history.undo();
  await act('color.set', { color: 'blue' });
  // Later, the person looks at the old branch again and nudges the camera.
  await history.jump(tipB);
  await act('camera.set', { at: 2 });
  assert.notEqual(history.active.headId, tipB, 'a new step, not the old tip rewritten');
  await history.jump(tipB);
  assert.equal(page.state.camera, 1, 'the old tip still shows the camera it recorded');
});

test('Ctrl+Z while a person\'s change waits for the work it set off undoes that change, not the step before it', async () => {
  const { page, dispatcher, history, act } = await setup();
  const before = await act('color.set', { color: 'blue' });
  // A person's change (an analysis option, a camera gesture still settling): made now, recorded once its work settles.
  let settle;
  const work = new Promise(resolve => { settle = resolve; });
  page.state.labels = { a: 'chosen' };
  const recorded = dispatcher.recordObserved('label.set', { to: 'chosen' }, {}, null, { after: work });
  // The person presses undo at once.
  const undone = history.undo();
  settle();
  await Promise.all([recorded, undone]);
  await history.idle();
  const tree = history.active;
  const tips = [...tree.steps.values()].filter(step => step.children.length === 0);
  assert.equal(tips.length, 1, 'no branch was made');
  assert.equal(tree.headId, before, 'the head is the step before the undone change');
  assert.equal(page.state.color, 'blue', 'the step before it is not undone');
  assert.deepEqual(page.state.labels, { a: 'A' }, 'the change is undone');
});
