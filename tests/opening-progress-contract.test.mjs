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
