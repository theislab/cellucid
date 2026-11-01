// A tab the browser ended while it opened a dataset (app/page-memory.js): a
// phone ends a tab that holds more memory than the phone lets it, with no
// refused allocation the page could hear first, and a browser that reports no
// device memory (Safari) is taken to be an 8 GiB device. The opening under way
// is marked in the tab's session storage; a reload or a navigation (pagehide)
// clears the mark, an ended tab does not, and the next load halves the memory
// allowance and says why.

import assert from 'node:assert/strict';
import test from 'node:test';

import { OPENING_MARK, initPageMemory } from '../assets/js/app/page-memory.js';
import { memoryAllowanceBytes, recordAllocationSuccess, resetMemoryModel, workingSetBytes } from '../assets/js/data/memory-budget.js';

function storage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    has: key => map.has(key),
  };
}

function fakeOpening() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(state) {
      for (const listener of listeners) listener(state === null ? null : { state });
    },
  };
}

function page(sessionStorage) {
  const windowOwner = new EventTarget();
  windowOwner.sessionStorage = sessionStorage;
  const shown = [];
  const notifications = { show: options => shown.push(options), hasNotification: () => false };
  return { windowOwner, notifications, shown, documentOwner: new EventTarget() };
}

test('an opening under way is marked, and the mark goes when it ends or the page is left', t => {
  resetMemoryModel();
  t.after(resetMemoryModel);
  const session = storage();
  const opening = fakeOpening();
  const { windowOwner, notifications, documentOwner } = page(session);
  const stop = initPageMemory({ notifications, documentOwner, windowOwner, opening });
  opening.emit('running');
  assert.equal(session.has(OPENING_MARK), true);
  opening.emit('done');
  assert.equal(session.has(OPENING_MARK), false);
  opening.emit('running');
  windowOwner.dispatchEvent(new Event('pagehide'));
  assert.equal(session.has(OPENING_MARK), false, 'a reload or a navigation is not an ended tab');
  stop();
});

test('a tab that ended while opening halves the allowance on its next load, and says why', t => {
  resetMemoryModel();
  t.after(resetMemoryModel);
  const before = memoryAllowanceBytes();
  const session = storage({ [OPENING_MARK]: '1' });
  const { windowOwner, notifications, shown, documentOwner } = page(session);
  const stop = initPageMemory({ notifications, documentOwner, windowOwner, opening: fakeOpening() });
  assert.equal(memoryAllowanceBytes(), Math.floor(before / 2));
  assert.equal(session.has(OPENING_MARK), false, 'said once');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, 'warning');
  assert.match(shown[0].message, /stopped while it was opening a dataset.*half as many cells/);
  stop();

  // It comes back as a refused allocation's would: an allocation granted
  // while the app holds the lowered allowance.
  assert.equal(workingSetBytes(), 0);
  recordAllocationSuccess(memoryAllowanceBytes() + 1);
  assert.equal(memoryAllowanceBytes(), before);
});

test('a browser that keeps nothing for the tab learns nothing and fails nothing', t => {
  resetMemoryModel();
  t.after(resetMemoryModel);
  const refusing = {
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() { throw new DOMException('denied', 'SecurityError'); },
  };
  const opening = fakeOpening();
  const { windowOwner, notifications, shown, documentOwner } = page(refusing);
  const stop = initPageMemory({ notifications, documentOwner, windowOwner, opening });
  opening.emit('running');
  assert.equal(shown.length, 0);
  stop();
});
