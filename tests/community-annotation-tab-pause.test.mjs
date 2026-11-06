// Two tabs on the same dataset and repository (B4 of the community
// annotation UI audit, 2026-11-05): the second tab pauses annotation instead
// of failing the dataset controls, and Use here takes the scope over; the
// first tab then hears it lost the scope (and pauses in turn).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CommunityAnnotationScopeLock } from '../assets/js/app/community-annotations/scope-lock.js';
import { isHeldElsewhere } from '../assets/js/app/community-annotations/runtime-context.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function tab(id) {
  const lock = new CommunityAnnotationScopeLock();
  lock._tabId = id;
  return lock;
}

const SCOPE = 'pancreas|team%2Flabels|main|42';

test('a second tab is refused the scope, takes it over with Use here, and the first tab loses it', () => {
  const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const first = tab('11111111-1111-4111-8111-111111111111');
  const second = tab('22222222-2222-4222-8222-222222222222');
  try {
    assert.equal(first.setScopeKey(SCOPE).ok, true);
    const refused = second.setScopeKey(SCOPE);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'LOCK_HELD');
    assert.equal(isHeldElsewhere(refused), true, 'held by another tab: paused here, not an error');

    const lost = [];
    first.on('lost', event => lost.push(event));
    const taken = second.takeOver(SCOPE);
    assert.deepEqual(taken, { ok: true, scopeKey: SCOPE });
    assert.equal(second.isHolding(SCOPE), true);
    assert.equal(first.isHolding(SCOPE), false);
    // The first tab's next renewal (or its storage event) finds the record replaced.
    first._renewTick();
    assert.equal(lost.length, 1);
    assert.equal(lost[0].scopeKey, SCOPE);
    assert.equal(isHeldElsewhere(lost[0]), true, 'lost to another tab: paused there too');

    assert.equal(isHeldElsewhere({ code: 'LOCK_STORAGE_FAILED' }), false, 'a broken storage is no other tab');
  } finally {
    first.release();
    second.release();
    globalThis.localStorage = previous.localStorage;
    globalThis.sessionStorage = previous.sessionStorage;
  }
});

test('annotation never fails the shared dataset-change listener', () => {
  const controls = readFileSync(new URL('../assets/js/app/ui/modules/community-annotation-controls.js', import.meta.url), 'utf8');
  const handler = controls.slice(controls.indexOf('const handleDatasetChange = () => {'), controls.indexOf('let datasetChangeSubscribed'));
  assert.match(handler, /try \{\s*setDatasetContextFromManager\(\);\s*\} catch \(error\) \{/);
  // A lock another tab holds pauses here; it never disconnects the repository both tabs share.
  assert.match(controls, /session\.on\('lock:error', \(evt\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(isHeldElsewhere\(evt\)\) return;/);
  const runtime = readFileSync(new URL('../assets/js/app/community-annotations/runtime-context.js', import.meta.url), 'utf8');
  assert.match(runtime, /if \(!isHeldElsewhere\(error\) \|\| scopeKey === null\) throw error;\s*pauseAnnotationScopeHere\(scopeKey\);/);
});
