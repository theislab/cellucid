/**
 * L20-2 (live every-action sweep, History group): `history.replay` never
 * answered, the turn's Stop did not end it, and the undo after it waited
 * forever. A Stop must reach every wait of a replay: reading the saved state
 * (a read: it ends at once, the source cancelled), waiting for its turn
 * (it never runs), and between the steps it applies; and the history's
 * exclusive lock is free again however the replay ends (stopped, refused,
 * failed), so the next move runs.
 *
 * No timers decide an outcome: each wait is held open by a promise the test
 * releases; `within` only turns a hang into a failure instead of a stuck run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { readReplayPlan, replayPlanOf } from '../assets/js/app/history/replay.js';
import { cancelled, isCancellation } from '../assets/js/utils/abort.js';
import { deferred, definitions, fakePage, historyProblem, makePage, trackerId } from './history-fake-page.mjs';

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-replay' });

/** `promise`, or 'hung' after `ms` (a hang fails the test instead of stalling the run). */
function within(promise, ms = 2000) {
  let timer;
  return Promise.race([
    promise.then(value => ({ value }), error => ({ error })),
    new Promise(resolve => { timer = setTimeout(() => resolve('hung'), ms); }),
  ]).finally(() => clearTimeout(timer));
}

let made = 0;

/** A started history on the fake page whose saved states come from `openSaved`. */
async function pageWithSaved(openSaved) {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.state.a = v; });
  dispatcher.provide('b.inc', () => { page.state.b += 1; });
  let t = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => trackerId(9000 + ++made), now: () => ++t * 1000, openSaved,
  });
  await history.startTracker();
  return { page, dispatcher, history };
}

/** A saved-state source whose eager read waits on `hold` (an IndexedDB read that does not come back). */
function heldSource(snapshot, hold) {
  const source = {
    cancelledWith: null,
    readEager: async () => { await hold.promise; return { history: snapshot, values: new Map() }; },
    readRest: async () => ({ values: new Map(), chats: [], journals: [], params: [] }),
    cancel: async reason => { source.cancelledWith = reason; },
  };
  return source;
}

test('a replay stopped while it reads the saved state ends at once, cancels the read, and leaves the history free', async () => {
  const hold = deferred();
  let source = null;
  const { history, dispatcher } = await pageWithSaved(async () => source);
  await dispatcher.dispatch('a.set', { v: 1 });
  source = heldSource(history.snapshot(), hold);
  const replay = dispatcher.dispatch('history.replay', { saved: 'state-1' }, AGENT);
  await new Promise(resolve => setImmediate(resolve));
  const reason = cancelled('user', 'The person stopped Claude.');
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  const out = await within(replay);
  assert.notEqual(out, 'hung', 'the replay answered the Stop');
  assert.equal(out.error, reason);
  assert.equal(source.cancelledWith, reason, 'the saved state\'s read is cancelled');
  assert.notEqual(await within(history.idle()), 'hung', 'the history is free');
  // The next move runs.
  assert.notEqual(await within(history.undo()), 'hung');
  hold.resolve();
});

test('readReplayPlan stopped between its reads, or during one, ends with the Stop and cancels its source', async () => {
  for (const at of ['eager', 'rest']) {
    const { history, dispatcher } = await pageWithSaved(null);
    await dispatcher.dispatch('a.set', { v: 2 });
    const hold = deferred();
    const snapshot = history.snapshot();
    const source = {
      cancelledWith: null,
      readEager: async () => { if (at === 'eager') await hold.promise; return { history: snapshot, values: new Map() }; },
      readRest: async () => { if (at === 'rest') await hold.promise; return { values: new Map(), chats: [], journals: [], params: [] }; },
      cancel: async reason => { source.cancelledWith = reason; },
    };
    const controller = new AbortController();
    const reading = readReplayPlan(source, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    const reason = cancelled('user', 'Stopped.');
    controller.abort(reason);
    const out = await within(reading);
    assert.notEqual(out, 'hung', `stopped during the ${at} read`);
    assert.equal(out.error, reason);
    assert.equal(source.cancelledWith, reason);
    hold.resolve();
  }
});

test('the history.replay action reads the saved state as Replay… does: whole, with the parameters only its rest holds', async () => {
  const { history, dispatcher, page } = await pageWithSaved(null);
  await dispatcher.dispatch('a.set', { v: 3 });
  const snapshot = history.snapshot();
  const tracker = snapshot.trackers[0];
  const step = tracker.steps.find(each => each.type === 'a.set');
  // The eager part names the step; its parameters come with the rest (`history-file.js` `assembleHistory`).
  const eagerHistory = { ...snapshot, trackers: [{ ...tracker, steps: tracker.steps.map(each => (each.id === step.id ? { ...each, params: { v: 0 } } : each)) }] };
  const source = {
    readEager: async () => ({ history: eagerHistory, values: new Map() }),
    readRest: async () => ({ values: new Map(), chats: [], journals: [], params: [{ tracker: tracker.id, step: step.id, params: { v: 7 }, outcome: null }] }),
    cancel: async () => {},
  };
  const { history: replayed, dispatcher: other, page: target } = await pageWithSaved(async () => source);
  const { outcome } = await other.dispatch('history.replay', { saved: 'state-1' });
  assert.deepEqual(outcome.report.map(entry => entry.outcome), ['applied']);
  assert.equal(target.state.a, 7, 'the parameters the rest holds were replayed');
  assert.equal(historyProblem(replayed), null);
  assert.equal(page.state.a, 3);
});

const Z_SET = defineAction({
  type: 'z.set', title: 'Set the theme', summary: 'Theme.', group: 'T',
  params: { type: 'object', additionalProperties: false, required: ['theme'], properties: { theme: { type: 'string' } } },
  touches: ['layout'], reads: [], effect: 'view', describe: p => `theme ${p.theme}`, code: p => `theme(${p.theme})`,
});

test('a replay whose step is refused, fails or is stopped between steps ends, and releases the exclusive lock', async () => {
  for (const ending of ['refused', 'failed', 'stopped']) {
    let mode = 'ok';
    const { history, dispatcher, step } = await makePage({
      extra: [Z_SET],
      provide: (d, page) => d.provide('z.set', ({ theme }) => {
        if (mode === 'refused') throw new ActionRefused('Not this theme here.');
        if (mode === 'failed') throw new Error('The theme could not be read.');
        page.state.theme = theme;
      }),
    });
    await step('z.set', { theme: 'dark' });
    await step('b.inc');
    const plan = replayPlanOf(history.snapshot(), { branch: history.active.activeBranch });
    await history.jump(history.active.rootId);
    mode = ending === 'stopped' ? 'ok' : ending;
    const controller = new AbortController();
    const unsubscribe = dispatcher.subscribe(event => {
      if (ending === 'stopped' && event.kind === 'done' && event.meta.origin === 'replay') controller.abort(cancelled('user', 'Stopped.'));
    });
    const out = await within(history.replay({ ...plan, name: `Again ${ending}` }, { signal: controller.signal }));
    unsubscribe();
    assert.notEqual(out, 'hung', `the replay ${ending} ends`);
    const outcomes = out.value?.report.map(entry => entry.outcome) ?? null;
    if (ending === 'stopped') assert.ok(out.error ? isCancellation(out.error) : outcomes.at(-1) === 'stopped', JSON.stringify(out));
    else assert.deepEqual(outcomes, ['unmatched', 'applied']);
    assert.notEqual(await within(history.idle()), 'hung', `the lock is free after a replay ${ending}`);
    assert.notEqual(await within(history.undo()), 'hung');
    assert.equal(historyProblem(history), null);
  }
});

test('a history.share stopped while it waits (for an action still running, or for the session operation before it) ends at once and frees the session', async () => {
  const { SessionSerializer } = await import('../assets/js/app/session/session-serializer.js');
  const stuck = deferred();
  const dispatcher = { idle: () => stuck.promise };
  const serializer = new SessionSerializer({ state: {}, dataSourceManager: null, getHistory: () => null, dispatcher, onLoaded: () => {} });
  // Waiting for the actions still running.
  const first = new AbortController();
  const sharing = serializer.writeShare({ signal: first.signal });
  await new Promise(resolve => setImmediate(resolve));
  const reason = cancelled('user', 'The person stopped Claude.');
  first.abort(reason);
  const out = await within(sharing);
  assert.notEqual(out, 'hung', 'the share answered the Stop');
  assert.equal(out.error, reason);
  // Waiting for its turn behind an operation that does not end: it never runs.
  const held = deferred();
  const before = serializer._exclusive(() => held.promise);
  const second = new AbortController();
  const queued = serializer.writeShare({ signal: second.signal });
  second.abort(reason);
  const queuedOut = await within(queued);
  assert.notEqual(queuedOut, 'hung');
  assert.equal(queuedOut.error, reason);
  held.resolve();
  await before;
  // The session is free: the next operation runs.
  assert.deepEqual(await within(serializer._exclusive(async () => 'ran')), { value: 'ran' });
  stuck.resolve();
});
