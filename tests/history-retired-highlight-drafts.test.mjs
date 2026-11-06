/**
 * The IndexedDB database Cellucid 0.9.6 kept unsaved highlights in
 * (`cellucid-highlight-drafts`) is read by nothing since saved states replaced
 * it, and is deleted once when the highlight controls start: that one database
 * by its exact name, nothing else.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HISTORY_DATABASE,
  RETIRED_HIGHLIGHT_DRAFTS_DATABASE,
  deleteRetiredHighlightDrafts,
} from '../assets/js/app/history/autosave-store.js';

/** An IDBFactory that records what it was asked to delete. */
function recordingFactory() {
  const deleted = [];
  const requests = [];
  return {
    deleted,
    requests,
    deleteDatabase(name) {
      deleted.push(name);
      const request = { onerror: null, onsuccess: null, onblocked: null };
      requests.push(request);
      return request;
    },
    open() { throw new Error('the cleanup opens nothing'); },
    databases() { throw new Error('the cleanup lists nothing'); },
  };
}

test('the retired highlight-drafts database is deleted by its exact name, and nothing else', () => {
  assert.equal(RETIRED_HIGHLIGHT_DRAFTS_DATABASE, 'cellucid-highlight-drafts');
  assert.notEqual(RETIRED_HIGHLIGHT_DRAFTS_DATABASE, HISTORY_DATABASE);
  const factory = recordingFactory();
  assert.equal(deleteRetiredHighlightDrafts(factory), true);
  assert.deepEqual(factory.deleted, ['cellucid-highlight-drafts']);
  // A failed deletion is handled where it happens, never reported as the page's error.
  let prevented = false;
  factory.requests[0].onerror({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  // Every start asks again; deleting a database that is gone is a no-op for the browser.
  assert.equal(deleteRetiredHighlightDrafts(factory), true);
  assert.deepEqual(factory.deleted, ['cellucid-highlight-drafts', 'cellucid-highlight-drafts']);
});

test('a browser without IndexedDB, or refusing it, starts all the same', () => {
  assert.equal(deleteRetiredHighlightDrafts(null), false);
  assert.equal(deleteRetiredHighlightDrafts({}), false);
  assert.equal(deleteRetiredHighlightDrafts({ deleteDatabase() { throw new Error('SecurityError'); } }), false);
});

test('the highlight controls delete it once, as they start', () => {
  const source = readFileSync(new URL('../assets/js/app/ui/modules/highlight-controls.js', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('export function initHighlightControls('));
  assert.match(start.slice(0, 600), /deleteRetiredHighlightDrafts\(\);/);
  assert.equal(source.match(/deleteRetiredHighlightDrafts\(/g).length, 1);
  // Nothing else in the app names the retired database.
  assert.equal(
    readFileSync(new URL('../assets/js/app/history/autosave-store.js', import.meta.url), 'utf8')
      .match(/cellucid-highlight-drafts/g).length,
    1,
  );
});
