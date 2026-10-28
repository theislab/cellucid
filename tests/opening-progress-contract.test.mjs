/**
 * The opening progress (`data/opening-progress.js`): one opening on screen
 * per dataset being opened, whichever layers report into it, from its first
 * moment to its outcome, with Cancel stopping every layer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OpeningProgress,
  describeOpeningRead,
  getOpeningProgress,
  openingCancelledError,
  stoppableOpening,
} from '../assets/js/data/opening-progress.js';
import { TransferLog } from '../assets/js/data/transfer-log.js';

/** A read activity log that reports what the test records. */
function fakeLog() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(activity) {
      for (const listener of listeners) listener(activity);
    },
  };
}

function harness() {
  const log = fakeLog();
  const transfers = new TransferLog({ console: null });
  const progress = new OpeningProgress({ log, transfers });
  const seen = [];
  progress.subscribe(snapshot => seen.push(snapshot));
  return { log, transfers, progress, seen };
}

test('layers join one opening, named by the outermost, which ends once', () => {
  const { progress, seen } = harness();
  const startup = progress.begin({ title: 'geo:GSE1/a.h5ad', step: 'Starting Cellucid' });
  assert.equal(seen.at(-1).state, 'running', 'shown from its first moment');
  const link = progress.begin({ title: 'GSE1 / a.h5ad', step: 'Finding the file' });
  const loader = progress.begin({ title: 'a.h5ad' });
  assert.equal(link.joined, true);
  assert.equal(new Set(seen.map(snapshot => snapshot.id)).size, 1);
  assert.equal(seen.at(-1).title, 'geo:GSE1/a.h5ad');
  assert.equal(seen.at(-1).step, 'Finding the file');
  loader.end();
  link.end();
  assert.equal(seen.at(-1).state, 'running', 'the outermost layer is still under way');
  startup.end();
  assert.equal(seen.at(-1).state, 'done');
  assert.equal(seen.filter(snapshot => snapshot.state !== 'running').length, 1);
  assert.equal(progress.active, false);
});

test('Cancel stops every layer at once and ends the opening as cancelled', () => {
  const { progress, seen } = harness();
  const stopped = [];
  const outer = progress.begin({ title: 'x', onCancel: () => stopped.push('outer') });
  const inner = progress.begin({ title: 'x.h5ad', onCancel: () => stopped.push('inner') });
  assert.equal(progress.cancel(), true);
  assert.deepEqual(stopped.sort(), ['inner', 'outer']);
  assert.equal(seen.at(-1).state, 'cancelled');
  assert.equal(seen.at(-1).message, 'Opening x was cancelled.');
  // The layers then unwind with their abort errors: nothing changes.
  inner.fail(openingCancelledError('x'));
  outer.fail(openingCancelledError('x'));
  assert.equal(seen.at(-1).state, 'cancelled');
  assert.equal(progress.cancel(), false, 'nothing is under way any more');
});

test('a failure is said by the outermost layer; a superseded layer leaves the opening to the newer one', () => {
  const failing = harness();
  const ui = failing.progress.begin({ title: 'zenodo:1' });
  const activation = failing.progress.begin({ title: 'record 1' });
  activation.fail(new Error('Cellucid found nothing to plot.'));
  assert.equal(failing.seen.at(-1).state, 'running', 'an inner failure reaches the layer around it');
  ui.fail('The linked data could not be opened: Cellucid found nothing to plot.');
  assert.equal(failing.seen.at(-1).state, 'failed');
  assert.equal(failing.seen.at(-1).error, 'The linked data could not be opened: Cellucid found nothing to plot.');

  // A layer whose failure is said where it happened only lets go.
  const explained = harness();
  const controls = explained.progress.begin({ title: 'suo' });
  const loader = explained.progress.begin({ title: 'suo.zarr' });
  loader.fail(new Error('a chunk is damaged'));
  controls.dismiss();
  assert.equal(explained.seen.at(-1).state, 'dismissed');

  const superseded = harness();
  const older = superseded.progress.begin({ title: 'older.zarr' });
  const newer = superseded.progress.begin({ title: 'newer.zarr' });
  newer.end();
  const stale = new Error('superseded');
  stale.name = 'AbortError';
  older.fail(stale);
  assert.equal(superseded.seen.at(-1).state, 'done');
});

test('a layer that leaves the outcome to the one that joins it lets that layer say a failure', () => {
  // The address bar asking an address whether it is a Cellucid server, then
  // opening it as linked data: the link's failure is the opening's, though
  // the asking layer is outermost and lets go afterwards with nothing to say.
  const { progress, seen } = harness();
  const asking = progress.begin({ title: 'https://example.org/atlas/', step: 'Checking for a Cellucid server', saysOutcome: false });
  const connection = progress.begin({ title: 'https://example.org/atlas/' });
  const link = progress.begin({ title: 'https://example.org/atlas/' });
  link.fail(new Error('https://example.org/atlas/ holds no datasets.json'));
  assert.equal(seen.at(-1).state, 'running', 'the inner failure reaches the connection');
  connection.fail('The linked data could not be opened: https://example.org/atlas/ holds no datasets.json');
  assert.equal(seen.at(-1).state, 'failed');
  assert.equal(seen.at(-1).error, 'The linked data could not be opened: https://example.org/atlas/ holds no datasets.json');
  asking.dismiss();
  assert.equal(seen.at(-1).state, 'failed', 'letting go afterwards changes nothing');
  assert.equal(seen.filter(snapshot => snapshot.state !== 'running').length, 1);

  // It still names the opening, and ends it when nothing joined.
  const alone = harness();
  const probe = alone.progress.begin({ title: 'lab-server/atlas/', saysOutcome: false });
  assert.equal(alone.seen.at(-1).title, 'lab-server/atlas/');
  probe.dismiss();
  assert.equal(alone.seen.at(-1).state, 'dismissed');
});

test('a failing layer may say what the failure means and offer the ways on', () => {
  const failing = harness();
  const startup = failing.progress.begin({ title: '10.6084/m9.figshare.1' });
  const link = failing.progress.begin({ title: 'figshare file' });
  link.fail(new Error('https://ndownloader.example/files/1: the host answered HTTP 202.'));
  let retried = 0;
  const outcome = {
    summary: 'Cellucid could not read the data this link points to. Try again, or open Cellucid without it.',
    actions: [{ label: 'Try again', run: () => { retried += 1; } }],
  };
  startup.fail(new Error('Failed to open 10.6084/m9.figshare.1: the host answered HTTP 202.'), outcome);
  const failed = failing.seen.at(-1);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.summary, outcome.summary);
  // The failure's own message stays the detail.
  assert.equal(failed.message, 'Failed to open 10.6084/m9.figshare.1: the host answered HTTP 202.');
  assert.deepEqual(failed.actions.map(action => action.label), ['Try again']);
  failed.actions[0].run();
  assert.equal(retried, 1);

  // Without an outcome a failure has no summary and no actions.
  const plain = harness();
  plain.progress.begin({ title: 'x' }).fail(new Error('no'));
  assert.equal(plain.seen.at(-1).summary, null);
  assert.deepEqual(plain.seen.at(-1).actions, []);

  const strict = harness();
  const layer = strict.progress.begin({ title: 'x' });
  assert.throws(() => layer.fail(new Error('no'), { summary: '', actions: [] }), TypeError);
  assert.throws(() => layer.fail(new Error('no'), { summary: 'S.', actions: [{ label: 'Go' }] }), TypeError);
});

test('the step and detail follow the reads of the opening', () => {
  const { log, progress, seen } = harness();
  const handle = progress.begin({ title: 'a.h5ad', step: 'Connecting to ftp.ncbi.nlm.nih.gov' });
  log.record({ id: 1, kind: 'open', label: 'the structure of a.h5ad', status: 'running', bytesFetched: 2_000_000, bytesTotal: 6_000_000, remainingMs: 3000 });
  assert.equal(seen.at(-1).step, "Reading the file's structure");
  assert.match(seen.at(-1).detail, /1\.9 MB of 5\.7 MB/);
  assert.match(seen.at(-1).detail, /~3 s left/);
  assert.equal(Math.round(seen.at(-1).percent), 33);
  // Background work (a gene index) is never part of an opening.
  log.record({ id: 2, kind: 'index', label: 'X, indexed by gene', status: 'running', bytesFetched: 1, background: true });
  assert.equal(seen.at(-1).step, "Reading the file's structure");
  log.record({ id: 1, kind: 'open', label: 'the structure of a.h5ad', status: 'done', bytesFetched: 6_000_000, bytesTotal: 6_000_000 });
  log.record({ id: 3, kind: 'embedding', label: "obsm['X_umap'] columns 0, 1", status: 'running', bytesFetched: 0, bytesTotal: 174_000 });
  assert.equal(seen.at(-1).step, 'Reading embedding X_umap');
  assert.equal(progress.shows({ kind: 'embedding' }), true, 'its reads are shown here, not as read notifications');
  handle.end();
  assert.equal(progress.shows({ kind: 'embedding' }), false);
});

test('a request made again shows as Retrying with why; a whole-file read shows its share', () => {
  const { transfers, progress, seen } = harness();
  progress.begin({ title: 'a.h5ad' });
  const entry = transfers.begin({ key: 'https://example.org/a.h5ad', label: 'a', why: 'test', mode: 'download', total: 1000 });
  transfers.retrying(entry.key, 'https://example.org/a.h5ad: the host could not answer (HTTP 503).');
  assert.equal(seen.at(-1).step, 'Retrying');
  assert.equal(seen.at(-1).retrying, true);
  assert.match(seen.at(-1).detail, /HTTP 503/);
  transfers.record(entry.key, { bytes: 250 });
  assert.equal(seen.at(-1).retrying, false, 'bytes arriving again end the retry');
  assert.equal(seen.at(-1).percent, 25);
  assert.match(seen.at(-1).detail, /250 B of 1000 B/);
});

test('reads are named as people say them', () => {
  assert.equal(describeOpeningRead({ kind: 'field', label: "categories of obs['cell_type']" }), 'Reading field cell_type');
  assert.equal(describeOpeningRead({ kind: 'names', label: 'gene names of var' }), 'Reading gene names');
  assert.equal(describeOpeningRead({ kind: 'graph', label: "obsp['connectivities']" }), 'Reading the neighbour graph');
});

test('a file read whole is said up front, by a layer or by the reader, and the note lasts while the opening runs', () => {
  const { progress, seen } = harness();
  assert.equal(describeOpeningRead({ kind: 'transcode', label: 'seu.rds' }), 'Reading seu.rds whole, once');
  progress.notice('ignored: nothing is opening');
  const link = progress.begin({ title: 'geo:GSE1/seu.rds', step: 'Finding the file' });
  assert.equal(seen.at(-1).note, null);
  link.notice('ftp.ncbi.nlm.nih.gov serves this file only whole.');
  assert.equal(seen.at(-1).note, 'ftp.ncbi.nlm.nih.gov serves this file only whole.');
  // The reader, which holds no handle, replaces it once the file is read whole.
  progress.notice('An R object (.rds) cannot be read in parts.');
  link.step('Reading the file');
  assert.equal(seen.at(-1).note, 'An R object (.rds) cannot be read in parts.');
  const before = seen.length;
  progress.notice('An R object (.rds) cannot be read in parts.');
  assert.equal(seen.length, before, 'the same note again changes nothing');
  link.end();
  assert.equal(seen.at(-1).state, 'done');
  progress.notice('too late');
  assert.equal(seen.at(-1).note, 'An R object (.rds) cannot be read in parts.');
  assert.equal(progress.begin({ title: 'next.h5ad' }) && seen.at(-1).note, null, 'a new opening starts with none');
});

test('a stoppable layer stops on Cancel or on its signal, and rejects with why', () => {
  let stops = 0;
  const cancelled = stoppableOpening({ title: 'a.h5ad', stop: () => { stops += 1; } });
  getOpeningProgress().cancel();
  assert.equal(stops, 1);
  assert.equal(cancelled.stopped, true);
  assert.equal(cancelled.outcome(new Error('The AnnData file was closed')).name, 'AbortError');
  assert.throws(() => cancelled.throwIfStopped(), /Opening a\.h5ad was cancelled/);
  cancelled.release();

  const controller = new AbortController();
  const superseded = stoppableOpening({ title: 'b.h5ad', signal: controller.signal, stop: () => { stops += 1; } });
  controller.abort(new DOMException('A newer choice.', 'AbortError'));
  assert.equal(stops, 2);
  assert.match(superseded.outcome(new Error('closed')).message, /newer choice/);
  superseded.release();
  superseded.handle.fail(superseded.outcome(new Error('closed')));
  assert.equal(getOpeningProgress().active, false);
});

test('an outer layer that finishes after an inner one says the outcome', () => {
  const { progress, seen } = harness();
  const startup = progress.begin({ title: 'Starting' });
  const file = progress.begin({ title: 'a.h5ad' });
  const loader = progress.begin({ title: 'a.h5ad' });
  const change = progress.begin({ title: 'a' });
  // The loader and the dataset change finish first, saying nothing.
  loader.end();
  change.end();
  // The file's own layer says what was opened.
  file.end('User data ready: 120 cells');
  assert.equal(seen.at(-1).state, 'running');
  startup.dismiss();
  assert.equal(seen.at(-1).state, 'done');
  assert.equal(seen.at(-1).message, 'User data ready: 120 cells');
});

/** Timers on a clock the test moves (`OpeningProgress`'s `after`). */
function virtualClock() {
  let now = 0;
  const timers = new Set();
  return {
    after(ms, callback) {
      const timer = { due: now + ms, callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((left, right) => left.due - right.due)) {
        if (timer.due > now || !timers.has(timer)) continue;
        timers.delete(timer);
        timer.callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

/** An opening progress whose stall interval runs on a virtual clock. */
function stallHarness() {
  const log = fakeLog();
  const transfers = new TransferLog({ console: null });
  const clock = virtualClock();
  const said = [];
  const output = {
    warn: message => said.push(['warn', message]),
    info: message => said.push(['info', message]),
  };
  const personListeners = new Set();
  let waiting = false;
  const personWaits = listener => {
    personListeners.add(listener);
    listener(waiting);
    return () => personListeners.delete(listener);
  };
  const setWaiting = value => {
    waiting = value;
    for (const listener of personListeners) listener(value);
  };
  const stepListeners = new Set();
  let measuring = false;
  const stepDeadlines = listener => {
    stepListeners.add(listener);
    listener(measuring);
    return () => stepListeners.delete(listener);
  };
  const setStepMeasuring = value => {
    measuring = value;
    for (const listener of stepListeners) listener(value);
  };
  const progress = new OpeningProgress({
    log, transfers, stallMs: 60_000, after: clock.after, personWaits, stepDeadlines, console: output,
  });
  const seen = [];
  progress.subscribe(snapshot => seen.push(snapshot));
  return { log, progress, seen, clock, said, setWaiting, setStepMeasuring, personListeners, stepListeners };
}

const STRUCTURE = Object.freeze({
  id: 1, kind: 'open', label: 'the structure of a.h5ad', status: 'running',
  requests: 0, bytesFetched: 0, bytesPlanned: 524_288, bytesTotal: 524_288,
  cacheHits: 0, chunks: 0, decodedBytes: 0,
});

test('an opening silent for the stall interval says which step and reads it waits on', () => {
  const { log, progress, seen, clock, said } = stallHarness();
  const file = progress.begin({ title: 'a.h5ad', step: 'Reading the file' });
  log.record(STRUCTURE);
  clock.advance(59_999);
  assert.equal(seen.at(-1).stalled, null, 'not before the interval');
  assert.deepEqual(said, []);

  clock.advance(1);
  const stalled = seen.at(-1);
  assert.equal(stalled.state, 'running', 'nothing is stopped: the person decides');
  assert.equal(
    stalled.stalled,
    'Nothing has changed for 1 min 0 s; waiting for the structure of a.h5ad (0 B of 512 KB arrived).'
  );
  assert.equal(stalled.detail, stalled.stalled, 'the notification and the overlay say it');
  assert.equal(stalled.step, "Reading the file's structure");
  assert.deepEqual(said, [[
    'warn',
    "[cellucid:opening] Opening a.h5ad stalled while reading the file's structure: " +
      'nothing has changed for 1 min 0 s, while reading the structure of a.h5ad (0 B of 512 KB arrived).',
  ]]);

  // Bytes arriving are progress: the report ends and the interval starts over.
  log.record({ ...STRUCTURE, requests: 1, bytesFetched: 524_288 });
  assert.equal(seen.at(-1).stalled, null);
  assert.equal(said.at(-1)[0], 'info');
  assert.match(said.at(-1)[1], /^\[cellucid:opening\] Opening a\.h5ad moved on after 1 min 0 s without progress\.$/);

  // A wait that is no read is named by the step its layer gave.
  log.record({ ...STRUCTURE, status: 'done', requests: 1, bytesFetched: 524_288 });
  const change = progress.begin({ title: 'a', step: 'Opening the dataset' });
  change.step('Waiting for the GPU to finish the frames already queued');
  clock.advance(60_000);
  assert.equal(
    seen.at(-1).stalled,
    'Nothing has changed for 1 min 0 s while waiting for the GPU to finish the frames already queued.'
  );
  assert.equal(
    said.at(-1)[1],
    '[cellucid:opening] Opening a.h5ad stalled while waiting for the GPU to finish the frames already queued: ' +
      'nothing has changed for 1 min 0 s.'
  );

  // A layer letting go is not progress; the opening's end stops the measure.
  const before = said.length;
  change.dismiss();
  assert.equal(said.length, before);
  file.end();
  assert.equal(seen.at(-1).state, 'done');
  assert.equal(seen.at(-1).stalled, null);
  assert.equal(clock.pending, 0, 'no timer outlives the opening');
});

test('progress keeps an opening from stalling however long it takes', () => {
  const { log, progress, seen, clock, said } = stallHarness();
  const file = progress.begin({ title: 'big.h5ad' });
  for (let bytes = 1; bytes <= 10; bytes += 1) {
    log.record({ ...STRUCTURE, bytesFetched: bytes * 1000 });
    clock.advance(59_000);
  }
  assert.equal(seen.at(-1).stalled, null);
  assert.deepEqual(said, []);
  file.end();
});

test('a wait on the person is not silence', () => {
  const { log, progress, seen, clock, said, setWaiting, personListeners } = stallHarness();
  const file = progress.begin({ title: 'a.rda' });
  log.record(STRUCTURE);
  // Which object of the file to open, or a sign-in window: the measure stands still.
  setWaiting(true);
  clock.advance(10 * 60_000);
  assert.equal(seen.at(-1).stalled, null);
  assert.deepEqual(said, []);
  // Once answered, the whole interval starts over.
  setWaiting(false);
  clock.advance(59_000);
  assert.equal(seen.at(-1).stalled, null);
  clock.advance(1000);
  assert.equal(
    seen.at(-1).stalled,
    'Nothing has changed for 1 min 0 s; waiting for the structure of a.h5ad (0 B of 512 KB arrived).'
  );
  file.fail(new Error('no'));
  assert.equal(personListeners.size, 0, 'an ended opening stops hearing of the person');
});

test('an opening stall interval is a positive duration', () => {
  assert.throws(() => new OpeningProgress({ stallMs: 0 }), RangeError);
  assert.throws(() => new OpeningProgress({ stallMs: Number.NaN }), RangeError);
});

test('while a startup step deadline measures the wait, the opening does not measure it again', () => {
  const { log, progress, seen, clock, said, setWaiting, setStepMeasuring, stepListeners } = stallHarness();
  const startup = progress.begin({ title: 'suo', step: 'Starting Cellucid' });
  log.record(STRUCTURE);
  // The health check runs under its own deadline, which ends startup and
  // names the step when it elapses: the opening holds no timer meanwhile.
  setStepMeasuring(true);
  assert.equal(clock.pending, 0, 'no second deadline beside the step');
  clock.advance(10 * 60_000);
  assert.equal(seen.at(-1).stalled, null);
  assert.deepEqual(said, []);

  // The step ends: the whole interval starts over.
  setStepMeasuring(false);
  assert.equal(clock.pending, 1);
  clock.advance(59_999);
  assert.equal(seen.at(-1).stalled, null);

  // Two reasons to stand still: the measure resumes only when both are over.
  setStepMeasuring(true);
  setWaiting(true);
  setStepMeasuring(false);
  clock.advance(10 * 60_000);
  assert.equal(seen.at(-1).stalled, null, 'still waiting on the person');
  setWaiting(false);
  clock.advance(60_000);
  assert.match(seen.at(-1).stalled, /^Nothing has changed for 1 min 0 s; waiting for the structure of a\.h5ad/);

  startup.end();
  assert.equal(stepListeners.size, 0, 'an ended opening stops hearing of step deadlines');
  assert.equal(clock.pending, 0);
});
