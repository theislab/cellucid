/**
 * A stopped action ends as a cancellation wherever it is, whether or not its
 * implementation watches its signal: the dispatcher, not each
 * implementation, keeps the promise its Stop makes.
 *
 * - A change stopped (the person's Stop of an agent turn, the page closing)
 *   while its handler runs, by a handler that goes on to its end, is rolled
 *   back and makes no step. One replaced by a newer choice of its kind
 *   (`supersede`) that still ran to its end keeps its step: the newer runs
 *   right after it (putting back what it replaces at once is work for
 *   nothing).
 * - A read stopped ends at once (it changes nothing; nothing waits for it).
 * - A change that keeps what it did when stopped (`keepsWhenStopped`: a
 *   camera path stays where the film stopped) answers and keeps its
 *   step; its implementation hears the signal and ends where it is.
 *
 * No timers: each handler is held open by a promise the test releases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deferred, makePage, NUMBER } from './history-fake-page.mjs';
import { defineAction } from '../assets/js/app/actions/catalog.js';
import { cancelled, isCancellation } from '../assets/js/utils/abort.js';

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-1' });
const NONE = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });

const SLOW_SET = defineAction({
  type: 'slow.set', title: 'Slow set', summary: 'Sets a, then waits.', group: 'T', params: NUMBER,
  touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `slow(${p.v})`,
});
const SLOW_PICK = defineAction({
  type: 'slow.pick', title: 'Slow pick', summary: 'Sets a, then waits; a newer pick replaces it.', group: 'T', params: NUMBER,
  touches: ['filters'], reads: [], effect: 'state', supersede: true, describe: p => `a = ${p.v}`, code: p => `pick(${p.v})`,
});
const SLOW_FILM = defineAction({
  type: 'slow.film', title: 'Slow film', summary: 'Moves a on until it ends or is stopped, and stays where it stopped.', group: 'T', params: NONE,
  touches: ['filters'], reads: [], effect: 'state', keepsWhenStopped: true, describe: () => 'film', code: () => 'film()',
});
const SLOW_LOOP = defineAction({
  type: 'slow.loop', title: 'Slow loop', summary: 'Starts work that goes on after it answers.', group: 'T', params: NONE,
  touches: ['filters'], reads: [], effect: 'state', describe: () => 'loop', code: () => 'loop()',
});
const SLOW_READ = defineAction({
  type: 'slow.read', title: 'Slow read', summary: 'Reads a, slowly.', group: 'T', params: NONE,
  reads: [], effect: 'read', describe: () => 'a', code: () => 'read()',
});

/** A page whose slow actions change `a` at once and then wait on `hold` without looking at their signal. */
async function pageWithSlowActions() {
  const hold = deferred();
  const entered = [];
  const made = await makePage({
    extra: [SLOW_SET, SLOW_PICK, SLOW_FILM, SLOW_LOOP, SLOW_READ],
    provide: (dispatcher, page) => {
      const slowly = async v => {
        page.state.a = v;
        const reached = entered.shift();
        reached?.resolve();
        await hold.promise;
        return { a: v };
      };
      dispatcher.provide('slow.set', ({ v }) => slowly(v));
      dispatcher.provide('slow.pick', ({ v }) => slowly(v));
      // Frame 5 of a film, then it plays on until stopped and answers where it is.
      dispatcher.provide('slow.film', (_params, { signal }) => {
        page.state.a = 5;
        entered.shift()?.resolve();
        return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ended: 'stopped', a: page.state.a }), { once: true }));
      });
      dispatcher.provide('slow.read', async () => {
        entered.shift()?.resolve();
        await hold.promise;
        return { a: page.state.a };
      });
    },
  });
  /** Resolves once the next handler to start is inside, waiting. */
  const inside = () => {
    const reached = deferred();
    entered.push(reached);
    return reached.promise;
  };
  return { ...made, hold, inside };
}

test('a change stopped while a handler that ignores its signal runs is rolled back and makes no step', async () => {
  const { page, history, dispatcher, hold, inside } = await pageWithSlowActions();
  const steps = history.active.steps.size;
  const reached = inside();
  const running = dispatcher.dispatch('slow.set', { v: 9 }, AGENT);
  await reached;
  assert.equal(page.state.a, 9, 'the handler changed the state');
  const reason = cancelled('user', 'The person stopped Claude.');
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  hold.resolve();
  await assert.rejects(running, error => error === reason);
  assert.equal(page.state.a, 0, 'rolled back');
  assert.equal(history.active.steps.size, steps, 'no step');
  await dispatcher.idle();
});

test('a change replaced by a newer one of its kind that still ran to its end keeps its step; the newer runs after it', async () => {
  const { page, history, dispatcher, hold, inside } = await pageWithSlowActions();
  const steps = history.active.steps.size;
  const reached = inside();
  const older = dispatcher.dispatch('slow.pick', { v: 1 });
  await reached;
  const replacing = deferred();
  const unsubscribe = dispatcher.subscribe(event => {
    if (event.kind === 'start' && event.params.v === 2) replacing.resolve();
  });
  const newer = dispatcher.dispatch('slow.pick', { v: 2 });
  // The newer one has replaced the older (it waits for it to end) before the older's handler ends.
  await replacing.promise;
  unsubscribe();
  hold.resolve();
  // Not put back only to be replaced at once (a heavy domain would be read again for nothing).
  const first = await older;
  const second = await newer;
  assert.equal(page.state.a, 2);
  assert.equal(history.active.steps.size, steps + 2);
  assert.equal(second.step.parent, first.step.id, 'the newer step follows the older');
  assert.equal(history.active.headId, second.step.id);
  await dispatcher.idle();
});

test('a read stopped ends at once, whatever its implementation waits for', async () => {
  const { dispatcher, hold, inside } = await pageWithSlowActions();
  const reached = inside();
  const reading = dispatcher.dispatch('slow.read', {}, AGENT);
  await reached;
  const reason = cancelled('user', 'The person stopped Claude.');
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  // Not released: the read ends without its handler.
  await assert.rejects(reading, error => error === reason && isCancellation(error));
  hold.resolve();
});

test('an action not stopped is untouched: its change and its step stay', async () => {
  const { page, history, dispatcher, hold } = await pageWithSlowActions();
  const steps = history.active.steps.size;
  hold.resolve();
  const { outcome, step } = await dispatcher.dispatch('slow.set', { v: 4 }, AGENT);
  assert.deepEqual(outcome, { a: 4 });
  assert.equal(page.state.a, 4);
  assert.equal(history.active.steps.size, steps + 1);
  assert.equal(history.active.headId, step.id);
});

test('a change that keeps what it did when stopped (keepsWhenStopped) answers, keeps its change and records its step', async () => {
  const { page, history, dispatcher, inside } = await pageWithSlowActions();
  const steps = history.active.steps.size;
  const reached = inside();
  const playing = dispatcher.dispatch('slow.film', {}, AGENT);
  await reached;
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, cancelled('user', 'The person stopped Claude.')), 1);
  const { outcome, step } = await playing;
  assert.deepEqual(outcome, { ended: 'stopped', a: 5 });
  assert.equal(page.state.a, 5, 'not put back');
  assert.equal(history.active.steps.size, steps + 1, 'its step is recorded');
  assert.equal(history.active.headId, step.id);
  await dispatcher.idle();
});

test('keepsWhenStopped is a boolean of an action that records a step', () => {
  const base = { type: 'x.film', title: 'Film', summary: 'A film.', group: 'T', params: NONE, describe: () => 'x', code: () => 'x()' };
  assert.throws(() => defineAction({ ...base, reads: [], effect: 'read', keepsWhenStopped: true }), /records no step, so there is nothing a Stop could keep/);
  assert.throws(() => defineAction({ ...base, touches: ['filters'], reads: [], effect: 'state', keepsWhenStopped: 'yes' }), /keepsWhenStopped must be a boolean/);
  assert.equal(defineAction({ ...base, touches: ['filters'], reads: [], effect: 'state' }).keepsWhenStopped, false);
});

test('work an action leaves going (ctx.ongoing) is its turn\'s: that turn\'s Stop ends it, another\'s does not, and released it is no one\'s', async () => {
  const { dispatcher } = await pageWithSlowActions();
  const stopped = [];
  let release = null;
  dispatcher.provide('slow.loop', (_params, { ongoing }) => {
    release = ongoing(reason => stopped.push(reason.message));
    return { looping: true };
  });
  const { outcome } = await dispatcher.dispatch('slow.loop', {}, AGENT);
  assert.deepEqual(outcome, { looping: true });
  assert.equal(dispatcher.stop({ turn: 'other' }, cancelled('user', 'The person stopped ChatGPT.')), 0);
  assert.deepEqual(stopped, []);
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, cancelled('user', 'The person stopped Claude.')), 1);
  assert.deepEqual(stopped, ['The person stopped Claude.']);
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, cancelled('user', 'The person stopped Claude.')), 0, 'stopped once');
  await dispatcher.dispatch('slow.loop', {}, AGENT);
  release();
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, cancelled('user', 'The person stopped Claude.')), 0, 'released, it is no one\'s');
  assert.deepEqual(stopped, ['The person stopped Claude.']);
});
