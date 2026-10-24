/**
 * Long AnnData reads are shown in one place: `showReadProgress` turns the
 * read activity the reader worker reports into progress notifications. A
 * gene index is one of those reads (kind `index`); nothing else shows it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { showReadProgress } from '../assets/js/app/read-progress-notifications.js';

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
    updateProgress(id, percent, { message }) {
      calls.push(['update', id, message, percent]);
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

test('a gene index is shown with its progress, from its first long report to its end', () => {
  const log = fakeLog();
  const notifications = fakeNotifications();
  const stop = showReadProgress({ log, notifications });
  const index = { ...base, id: 7, kind: 'index', label: 'Sparse X index, indexed by gene' };
  log.record({ ...index, status: 'running', elapsedMs: 100, progress: { done: 1, total: 10 } });
  assert.deepEqual(notifications.calls, [], 'a read shorter than a moment is not shown');
  log.record({ ...index, status: 'running', elapsedMs: 900, progress: { done: 5, total: 10 } });
  log.record({ ...index, status: 'running', elapsedMs: 1400, progress: { done: 8, total: 10 } });
  log.record({ ...index, status: 'done', elapsedMs: 2000, bytesFetched: 4096, progress: { done: 10, total: 10 } });
  assert.deepEqual(notifications.calls.map(call => call.slice(0, 2)), [
    ['progress', 'n1'],
    ['update', 'n1'],
    ['complete', 'n1'],
  ]);
  assert.equal(notifications.calls[0][3], 50);
  assert.equal(notifications.calls[1][3], 80);
  assert.match(notifications.calls[0][2], /^Reading Sparse X index, indexed by gene: 50%/);
  assert.match(notifications.calls[2][2], /4\.0 KB read/);
  stop();
  log.record({ ...index, id: 8, status: 'running', elapsedMs: 5000 });
  assert.equal(notifications.calls.length, 3, 'nothing is shown once stopped');
});

test('a cancelled read is dismissed, a failed one says why, opening is never shown here', () => {
  const log = fakeLog();
  const notifications = fakeNotifications();
  showReadProgress({ log, notifications });
  const genes = { ...base, kind: 'genes', label: '12 genes of X' };
  log.record({ ...genes, id: 1, status: 'running', elapsedMs: 800 });
  log.record({ ...genes, id: 1, status: 'cancelled', elapsedMs: 900 });
  log.record({ ...genes, id: 2, status: 'running', elapsedMs: 800 });
  log.record({ ...genes, id: 2, status: 'failed', elapsedMs: 900, detail: 'HTTP 503' });
  log.record({ ...base, id: 3, kind: 'open', label: 'the structure of x.h5ad', status: 'running', elapsedMs: 5000 });
  assert.deepEqual(notifications.calls.map(call => call[0]), ['progress', 'dismiss', 'progress', 'fail']);
  assert.match(notifications.calls[3][2], /12 genes of X could not be read: HTTP 503/);
});

test('the reader worker posts no progress event of its own: activity is the one channel', () => {
  for (const file of ['anndata-reader-worker.js', 'anndata-reader-client.js', 'anndata-file-source.js', 'anndata/reader.js']) {
    const source = readFileSync(new URL(`../assets/js/data/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /event: 'progress'|onProgress|by gene \(once/, file);
  }
});
