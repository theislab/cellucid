/**
 * The reads a person waits for that nothing else shows are one notification:
 * `showReadProgress` turns the read activity the reader worker reports into
 * one progress notification in plain words, gone when the reads end.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { showReadProgress } from '../assets/js/app/read-progress-notifications.js';
import { getReadActivityLog } from '../assets/js/data/read-activity-log.js';

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

function fakeNotifications() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    progress(message, percent) {
      const id = `n${nextId++}`;
      calls.push(['progress', id, message, percent]);
      return id;
    },
    updateProgress(id, percent, { message } = {}) {
      if (message !== undefined) calls.push(['update', id, message, percent]);
    },
    complete(id, message) {
      calls.push(['complete', id, message]);
    },
    fail(id, message) {
      calls.push(['fail', id, message]);
    },
    dismiss(id) {
      calls.push(['dismiss', id]);
    },
    error(message) {
      calls.push(['error', message]);
    },
    hasNotification: () => true,
  };
}

const base = {
  bytesFetched: 0,
  bytesTotal: null,
  bytesPerSecond: null,
  remainingMs: null,
  progress: null,
  detail: null,
};

test('the reads nothing else shows are one notification, in plain words, gone when they end', () => {
  const log = fakeLog();
  const notifications = fakeNotifications();
  const stop = showReadProgress({ log, notifications });
  const field = { ...base, id: 7, kind: 'field', label: "obs['cell_type'] of x.h5ad", bytesTotal: 4000 };
  const graph = { ...base, id: 8, kind: 'graph', label: "obsp['connectivities']", bytesTotal: 6000 };
  log.record({ ...field, status: 'running', elapsedMs: 10, bytesFetched: 1000 });
  log.record({ ...graph, status: 'running', elapsedMs: 10, bytesFetched: 1000 });
  log.record({ ...field, status: 'running', elapsedMs: 900, bytesFetched: 3000, remainingMs: 2000 });
  log.record({ ...field, status: 'done', elapsedMs: 1200, bytesFetched: 4000 });
  log.record({ ...graph, status: 'done', elapsedMs: 1500, bytesFetched: 6000 });
  assert.deepEqual(notifications.calls.map(call => call.slice(0, 2)), [
    ['progress', 'n1'],
    ['update', 'n1'],
    ['update', 'n1'],
    ['update', 'n1'],
    ['dismiss', 'n1'],
  ]);
  assert.match(notifications.calls[0][2], /^Reading field cell_type · \S+ B of \S+ KB$/);
  assert.match(notifications.calls[1][2], /^Reading field cell_type and the neighbor graph · \S+ KB of \S+ KB$/);
  assert.match(notifications.calls[2][2], /^Reading field cell_type and the neighbor graph · \S+ KB of \S+ KB · .*2 s left$/);
  assert.match(notifications.calls[3][2], /^Reading the neighbor graph · /);
  assert.ok(notifications.calls.every(call => !/obs\[|obsp\[/.test(call[2] ?? '')), 'the reader\'s words stay in the console');
  stop();
  log.record({ ...field, id: 9, status: 'running', elapsedMs: 5000 });
  assert.equal(notifications.calls.length, 5, 'nothing is shown once stopped');
});

test('a failed read leaves the card to what asked for it; an opening, a growth step, a job and background work are never shown here', () => {
  const log = fakeLog();
  const notifications = fakeNotifications();
  showReadProgress({ log, notifications, opening: { shows: activity => activity.label === 'shown by the opening' } });
  const genes = { ...base, kind: 'genes', label: '12 genes of X' };
  log.record({ ...genes, id: 1, status: 'running', elapsedMs: 800 });
  log.record({ ...genes, id: 1, status: 'cancelled', elapsedMs: 900 });
  log.record({ ...genes, id: 2, status: 'running', elapsedMs: 800 });
  log.record({ ...genes, id: 2, status: 'failed', elapsedMs: 900, detail: 'HTTP 503' });
  for (const quiet of [
    { kind: 'open', label: 'the structure of x.h5ad' },
    { kind: 'embedding', label: 'shown by the opening' },
    { kind: 'embedding', label: "obsm['X_umap'] columns 0, 1, open cells 100–200 (embedding, cells added)" },
    { kind: 'analysis', label: 'genes for differential expression' },
    { kind: 'index', label: 'Sparse X index, indexed by gene', background: true },
  ]) {
    log.record({ ...base, id: 3, ...quiet, status: 'running', elapsedMs: 5000 });
  }
  // The failure is the caller's to say (an opening's, a field's, a job's):
  // here the card only goes, so it is never said twice.
  assert.deepEqual(notifications.calls.map(call => call[0]), ['progress', 'dismiss', 'progress', 'dismiss']);
});

test('a gene\'s reads its own loading notification shows (with its wait) are not shown again here', () => {
  // Offline while a gene is read, its notification says "Reading gene BARX2: This computer is
  // offline: …" with Cancel; a second one ("Reading genes · waiting: This computer is offline")
  // would repeat it.
  const log = getReadActivityLog();
  log.clear();
  const notifications = fakeNotifications();
  const stop = showReadProgress({ log, notifications, opening: { shows: () => false } });
  try {
    log.adopt('field-load-7', 'gene-notification-n3');
    const waiting = { text: 'This computer is offline: reading goes on as soon as it is back; what was read is kept.' };
    log.record({ ...base, requests: 3, chunks: 0, decodedBytes: 0, id: 41, kind: 'genes', label: 'gene BARX2 of X', keys: ['field-load-7'], status: 'running', elapsedMs: 5000, waiting });
    log.flush();
    assert.deepEqual(notifications.calls, [], 'said once, by the gene\'s notification');
    // A read of the same kind that no notification owns is still shown.
    log.record({ ...base, requests: 3, chunks: 0, decodedBytes: 0, id: 42, kind: 'genes', label: '12 genes of X', keys: ['field-load-8'], status: 'running', elapsedMs: 5000, waiting });
    log.flush();
    assert.equal(notifications.calls.filter(call => call[0] === 'progress').length, 1);
    assert.match(notifications.calls[0][2], /^Reading genes · waiting: This computer is offline/);
  } finally {
    stop();
    log.clear();
  }
  // Every gene load that shows a notification adopts its reads for it.
  const loading = readFileSync(new URL('../assets/js/app/state/managers/field/loading.js', import.meta.url), 'utf8');
  assert.match(loading, /if \(notifId !== null\) getReadActivityLog\(\)\.adopt\(sharedOwner\.readKey, `gene-notification-\$\{notifId\}`\);/);
});
