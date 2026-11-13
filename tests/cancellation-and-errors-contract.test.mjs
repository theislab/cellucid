/**
 * Cancellation and honest failure, one invariant per section: a cancellation
 * is never a failure and keeps its kind everywhere (one identity, one wire
 * format); a worker that cannot answer is retired and one that can is not
 * failed for a stray error; slowness is never turned into failure by a clock;
 * an older browser is told so before startup; a long export can be stopped;
 * shared work names no waiter's reason; a failure is said once; a sign-in
 * nobody waits for goes; background discards are observed. The grep guard
 * over every module is `cancellation-guard-contract.test.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANCEL_KINDS,
  SharedWork,
  abortListenerCount,
  abortReason,
  awaitWithSignal,
  cancel,
  cancellationKind,
  cancelled,
  isCancellation,
  isTransientCancellation,
} from '../assets/js/utils/abort.js';
import { fromWire, toWire } from '../assets/js/utils/error-wire.js';
import { isReported, markReported, settleQuietly } from '../assets/js/utils/errors.js';
import { describeHostFault, explainedFailure, isExplainedFailure, DataSourceErrorCode } from '../assets/js/data/data-source.js';
import { isSettledDataSourceFailure } from '../assets/js/app/ui/modules/dataset-connections.js';
import {
  AnnDataReaderClient,
  prewarmAnnDataReaderWorker,
  retireAnnDataReaderWorkers,
  setAnnDataReaderWorkerFactory,
} from '../assets/js/data/anndata-reader-client.js';
import {
  BROWSER_TOO_OLD_CODE,
  describeStartupFailure,
  missingBrowserFeatures,
  requireBrowserFeatures,
} from '../assets/js/app/startup-failure.js';
import { SignInSteps } from '../assets/js/data/sources/auth/sign-in.js';
import { createFigureExportWorkerHandler } from '../assets/js/app/ui/modules/figure-export/utils/figure-export-worker.js';
import { probeRemoteServer } from '../assets/js/data/remote-source.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

// --- one identity for a cancellation ----------------------------------

test('a cancellation has a kind, is made once, and is told apart by name alone', () => {
  assert.deepEqual([...CANCEL_KINDS], ['user', 'superseded', 'closed', 'released', 'page-left']);
  const controller = new AbortController();
  assert.equal(cancel(controller, 'superseded', 'A newer choice replaced it.'), true);
  assert.equal(cancel(controller, 'user', 'Again.'), false, 'stopped once');
  const reason = controller.signal.reason;
  assert.equal(isCancellation(reason), true);
  assert.equal(cancellationKind(reason), 'superseded');
  assert.equal(reason.message, 'A newer choice replaced it.');
  // The platform's own abort is a cancellation too (kind user), never a failure.
  const platform = new AbortController();
  platform.abort();
  assert.equal(cancellationKind(abortReason(platform.signal)), 'user');
  // A deadline's TimeoutError is a failure: it is not relabeled.
  const timed = new AbortController();
  timed.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  assert.equal(abortReason(timed.signal).name, 'TimeoutError');
  assert.equal(isCancellation(abortReason(timed.signal)), false);
  assert.throws(() => cancelled('later', 'x'), RangeError);
  assert.equal(isTransientCancellation(cancelled('released', 'Memory went.')), true);
  assert.equal(isTransientCancellation(cancelled('superseded', 'Newer.')), false);
});

// --- shared work ------------------------------------------------------

test('shared work stops only when every waiter left, and its own abort names no waiter\'s reason', async () => {
  let workSignal = null;
  const work = new SharedWork(signal => {
    workSignal = signal;
    return new Promise(() => {});
  });
  const a = new AbortController();
  const b = new AbortController();
  const ofA = work.join(a.signal);
  const ofB = work.join(b.signal);
  cancel(a, 'user', 'A left.');
  await assert.rejects(ofA, error => error === a.signal.reason);
  assert.equal(workSignal.aborted, false, 'one waiter left: the work goes on for the other');
  b.abort(new Error('a failure of B\'s own'));
  await assert.rejects(ofB, /a failure of B/);
  assert.equal(workSignal.aborted, true);
  assert.equal(cancellationKind(workSignal.reason), 'superseded', 'the work is no longer wanted, never failed');
});

test('waiting on one signal from many places keeps one listener on it', async () => {
  const controller = new AbortController();
  const tasks = Array.from({ length: 1000 }, () => new Promise(() => {}));
  const waits = tasks.map(task => awaitWithSignal(task, controller.signal));
  assert.equal(abortListenerCount(controller.signal), 1);
  cancel(controller, 'user', 'Stopped.');
  const outcomes = await Promise.allSettled(waits);
  assert.ok(outcomes.every(outcome => cancellationKind(outcome.reason) === 'user'));
});

// --- one wire format --------------------------------------------------

test('an error crosses a thread with its class, kind, code, details, mark and cause', () => {
  const cancellation = fromWire(structuredClone(toWire(cancelled('released', 'Memory was given back.'))));
  assert.equal(cancellationKind(cancellation), 'released');
  const refused = fromWire(structuredClone(toWire(new RangeError('Array buffer allocation failed'))));
  assert.ok(refused instanceof RangeError, 'a refused allocation stays a RangeError');
  const explained = markReported(explainedFailure('The file names two datasets.', DataSourceErrorCode.INVALID_FORMAT, 'link'));
  const outer = new Error('Opening failed', { cause: explained });
  const back = fromWire(structuredClone(toWire(outer)));
  assert.equal(back.message, 'Opening failed');
  assert.equal(isExplainedFailure(back.cause), true);
  assert.equal(back.cause.code, DataSourceErrorCode.INVALID_FORMAT);
  assert.equal(isReported(back.cause), true);
  // A DOMException's numeric code (the platform's, by name) is not a code of ours.
  assert.equal(Object.hasOwn(toWire(cancelled('user', 'x')), 'code'), false);
});

// --- the reader worker's lifecycle ------------------------------

/** A worker double: records what it is sent; the test answers for it. */
class FakeWorker extends EventTarget {
  constructor() {
    super();
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.posted = [];
    this.terminated = false;
  }

  postMessage(message) {
    this.posted.push(message);
    if (message?.leave === true) {
      queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { data: { event: 'left' } })));
    }
  }

  terminate() {
    this.terminated = true;
  }

  /** The id of the latest request of `method`. */
  requestOf(method) {
    return this.posted.filter(message => message?.method === method).at(-1)?.id;
  }

  answer(id, result) {
    this.onmessage({ data: { id, result } });
  }
}

function workers(t) {
  const made = [];
  setAnnDataReaderWorkerFactory(() => {
    const worker = new FakeWorker();
    made.push(worker);
    return worker;
  });
  t.after(() => {
    retireAnnDataReaderWorkers();
    setAnnDataReaderWorkerFactory(null);
  });
  return made;
}

test('a reader worker whose script never loaded is retired: its calls fail saying so, and the next call starts another', async t => {
  const made = workers(t);
  const client = new AnnDataReaderClient();
  const first = client._call('getDatasetMetadata');
  made[0].onerror({ message: 'Failed to load module script', preventDefault() {} });
  await assert.rejects(first, /could not start .*Reload the page/s);
  assert.equal(made[0].terminated, true);
  assert.equal(client._worker, null);
  const second = client._call('getDatasetMetadata');
  assert.equal(made.length, 2, 'a new worker for the next call');
  made[1].answer(made[1].requestOf('getDatasetMetadata'), { ok: true });
  assert.deepEqual(await second, { ok: true });
});

test('offline, a reader worker whose script never loaded fails its calls as this computer offline, which may pass', async t => {
  const made = workers(t);
  const navigatorOwn = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigatorOwn));
  const client = new AnnDataReaderClient();
  const first = client._call('getDatasetMetadata');
  made[0].onerror(new Event('error'));
  const error = await first.then(() => assert.fail('the call is answered'), failure => failure);
  assert.equal(describeHostFault(error)?.kind, 'offline');
  assert.equal(isSettledDataSourceFailure(error), false, 'Try again, once connected, may cure it');
  assert.equal(made[0].terminated, true);
});

test('a stray error of a live reader worker fails none of the reads waiting on it', async t => {
  const made = workers(t);
  const client = new AnnDataReaderClient();
  const first = client._call('getDatasetMetadata');
  made[0].answer(made[0].requestOf('getDatasetMetadata'), 1);
  assert.equal(await first, 1);
  const waiting = client._call('getObsKeys');
  const logged = t.mock.method(console, 'error', () => {});
  made[0].onerror({ message: 'Uncaught TypeError in a port handler', preventDefault() {} });
  await turn();
  assert.equal(logged.mock.callCount(), 1, 'reported');
  assert.equal(made[0].terminated, false);
  made[0].answer(made[0].requestOf('getObsKeys'), 2);
  assert.equal(await waiting, 2, 'the read goes on');
});

test('a spare reader worker that failed to load is not adopted', async t => {
  const made = workers(t);
  prewarmAnnDataReaderWorker();
  made[0].dispatchEvent(Object.assign(new Event('error'), { message: 'Failed to load module script' }));
  const client = new AnnDataReaderClient();
  const call = client._call('getDatasetMetadata');
  assert.equal(made[0].terminated, true);
  assert.equal(made.length, 2, 'a worker of its own');
  made[1].answer(made[1].requestOf('getDatasetMetadata'), 3);
  assert.equal(await call, 3);
});

test('a reopen that failed is not kept: the next call reopens again', async t => {
  const made = workers(t);
  const client = new AnnDataReaderClient();
  client._source = { file: 'kept' };
  const first = client._call('getObsKeys');
  made[0].onmessage({ data: { id: made[0].requestOf('open'), error: toWire(new Error('the host refused')) } });
  await assert.rejects(first, /the host refused/);
  assert.equal(client._reopening, null);
  // Let go (asked to leave, or ended at once once readers are retired).
  assert.ok(made[0].terminated || made[0].posted.some(message => message?.leave === true), 'the worker with nothing open was let go');
  assert.equal(client._worker, null);
  const second = client._call('getObsKeys');
  assert.equal(made.length, 2);
  const open = made[1].requestOf('open');
  assert.notEqual(open, undefined, 'opened again');
  made[1].answer(open, {});
  await turn();
  made[1].answer(made[1].requestOf('getObsKeys'), ['a']);
  assert.deepEqual(await second, ['a']);
});

// --- no clock turns slowness into failure -------------------------------

test('a server probe has no deadline: a busy server that answers late is a server', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let answer = null;
  globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
  const opening = new AbortController();
  const probing = probeRemoteServer('http://127.0.0.1:8765', { signal: opening.signal });
  await turn();
  t.mock.timers.tick(10 * 60_000);
  answer(new Response(JSON.stringify({ status: 'ok' }), { headers: { 'content-type': 'application/json' } }));
  // The health document is checked as before; what matters is that it was waited for.
  const outcome = await probing.then(value => value, error => error);
  assert.ok(typeof outcome === 'boolean', `answered, not timed out: ${outcome}`);
  await assert.rejects(probeRemoteServer('http://127.0.0.1:8765', {}), TypeError, 'a probe runs under its opening');
});

// --- the browser floor, checked before startup ---------------------------

test('a browser without AbortSignal.any is told it is too old before anything starts', () => {
  assert.deepEqual(missingBrowserFeatures(globalThis), []);
  const old = { AbortSignal: { timeout() {} } };
  assert.deepEqual(missingBrowserFeatures(old), ['AbortSignal.any']);
  let refusal = null;
  try {
    requireBrowserFeatures(old);
  } catch (error) {
    refusal = error;
  }
  assert.equal(refusal?.code, BROWSER_TOO_OLD_CODE);
  const screen = describeStartupFailure(refusal, { webgl2Available: true, hasLaunchSettings: false });
  assert.equal(screen.kind, 'browser');
  assert.match(screen.sentence, /Safari 17\.4/);
});

// --- a figure export can be stopped ---------------------------------------

test('a stopped figure export skips every request of its session still queued', async () => {
  const handle = createFigureExportWorkerHandler();
  assert.equal(await handle({ op: 'cancel', session: 7 }), null);
  const answer = await handle({ id: 1, op: 'encodePng', session: 7, uploads: [], args: {} });
  assert.equal(cancellationKind(fromWire(answer.reply.error)), 'user');
  // Another session is untouched; a closed one is forgotten.
  const other = await handle({ id: 2, op: 'nonexistent', session: 8, uploads: [], args: {} });
  assert.equal(isCancellation(fromWire(other.reply.error)), false);
  await handle({ op: 'close', session: 7 });
  const reopened = await handle({ id: 3, op: 'nonexistent', session: 7, uploads: [], args: {} });
  assert.equal(isCancellation(fromWire(reopened.reply.error)), false);
});

// --- a failure is said once -------------------------------------------------

test('a failure one surface showed is marked, and only what is marked', () => {
  assert.equal(isReported(new Error('unshown')), false);
  assert.equal(isReported(null), false);
  const shown = markReported(new Error('shown'));
  assert.equal(isReported(shown), true);
});

// --- a sign-in step nobody waits for goes -----------------------------------

test('a sign-in step whose every waiter left during an attempt goes when the attempt fails', async () => {
  const steps = new SignInSteps();
  let attemptSignal = null;
  let failAttempt = null;
  const waiter = new AbortController();
  const waiting = steps.request({
    account: 'a',
    kind: 'sign-in',
    text: 'Sign in',
    action: 'Sign in',
    signal: waiter.signal,
    act: ({ signal }) => {
      attemptSignal = signal;
      return new Promise((_resolve, reject) => { failAttempt = reject; });
    },
  });
  waiting.catch(() => {});
  const [step] = steps.list();
  steps.run(step.id);
  cancel(waiter, 'user', 'The opening was cancelled.');
  await assert.rejects(waiting, error => cancellationKind(error) === 'user');
  assert.equal(steps.list().length, 1, 'kept while its attempt runs');
  failAttempt(new Error('The window was closed before signing in.'));
  await turn();
  assert.equal(steps.list().length, 0, 'nobody waits: the step goes');
  assert.equal(attemptSignal.aborted, true, 'and what its attempt listens on ends');
});

// --- background work is observed ---------------------------------------------

test('a background discard that fails is logged with what was being done and stops nothing after it', async t => {
  const warned = t.mock.method(console, 'warn', () => {});
  await settleQuietly(Promise.reject(new Error('the folder is locked')), 'discarding a journal');
  assert.equal(warned.mock.callCount(), 1);
  assert.match(String(warned.mock.calls[0].arguments[0]), /discarding a journal/);
  await settleQuietly(Promise.reject(cancelled('closed', 'Closed.')), 'discarding a journal');
  assert.equal(warned.mock.callCount(), 1, 'a cancellation is no failure');
  await settleQuietly(undefined, 'nothing');
});

test('work nobody waits for ends quietly when cancelled and reports a failure; a cancellation nobody handles is no page error', async () => {
  const { cancelled: cancelledError, settleInBackground, quietUnhandledCancellations } = await import('../assets/js/utils/abort.js');
  const reported = [];
  settleInBackground(Promise.reject(cancelledError('superseded', 'A newer choice took its place.')), error => reported.push(error));
  const failure = new Error('could not read');
  settleInBackground(Promise.reject(failure), error => reported.push(error));
  settleInBackground(Promise.resolve(1), error => reported.push(error));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(reported, [failure]);
  assert.throws(() => settleInBackground(null, () => {}), /a promise/);
  assert.throws(() => settleInBackground(Promise.resolve(), null), /failures go/);

  // The page's net: an unhandled cancellation is prevented (quiet), anything else left as it is.
  const target = new EventTarget();
  const remove = quietUnhandledCancellations(target);
  const event = reason => {
    const e = new Event('unhandledrejection', { cancelable: true });
    e.reason = reason;
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(event(cancelledError('superseded', 'Field interaction was superseded by a newer intent.')), true);
  assert.equal(event(new DOMException('stopped', 'AbortError')), true);
  assert.equal(event(new Error('a real failure')), false);
  remove();
  assert.equal(event(cancelledError('superseded', 'after removal')), false);
});
