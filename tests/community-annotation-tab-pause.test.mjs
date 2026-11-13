// Two tabs on the same dataset and repository: the second tab pauses annotation instead
// of failing the dataset controls, and Use here takes the scope over; the
// first tab then hears it lost the scope (and pauses in turn).
import test from 'node:test';
import assert from 'node:assert/strict';

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
