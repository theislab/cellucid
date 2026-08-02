/**
 * What the window `error` listener in `state-serializer/ui-controls.js` is for,
 * and how narrow it is (CEL-0239).
 *
 * `EventTarget.dispatchEvent()` does not propagate an exception thrown by a
 * listener to its caller: the DOM reports the exception to the global error
 * handler and finishes the dispatch, and `dispatchEvent` returns normally. A
 * restored control therefore looks restored even when the owner that acts on it
 * failed — and most owners publish to the viewer or the DataState without
 * touching the element, so the post-write readback in
 * `restoreValidatedControl()` cannot see it either. The capture-phase listener
 * exists to turn that swallowed exception back into a restore failure.
 *
 * Its lifetime is exactly one synchronous `dispatchEvent` call, which is the
 * only narrowing available and the only one that matters: nothing else can be
 * running while it is installed, so every error it can observe is one this
 * dispatch raised. These tests pin both halves — the failure is attributed, and
 * the listener is gone the moment the dispatch returns, so an exception
 * reported afterwards is never charged to a control.
 *
 * `tests/browser/renderer-smoke.spec.mjs` already proves the first half against
 * a real DOM: a real `input` listener that throws comes back out of
 * `restoreUIControls()` as the same Error, with the element's value published
 * and no page error escaping. What had no coverage anywhere was the lifetime —
 * and in node the branch was not reached at all, because the fake controls in
 * `session-ui-controls-exact-contract.test.mjs` carry no `ownerDocument` and so
 * take the no-window path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiControlSerializer } from
  '../assets/js/app/state-serializer/ui-controls.js';

/**
 * A window that reports exceptions the way a browser reports them: an
 * `ErrorEvent` dispatched synchronously at the point of the throw.
 */
function createWindowStub() {
  const listeners = new Set();
  const reportedEvents = [];
  return {
    reportedEvents,
    listenerCount: () => listeners.size,
    addEventListener(type, listener, capture) {
      assert.equal(type, 'error');
      assert.equal(capture, true);
      listeners.add(listener);
    },
    removeEventListener(type, listener, capture) {
      assert.equal(type, 'error');
      assert.equal(capture, true);
      listeners.delete(listener);
    },
    Event: class StubEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = init.bubbles === true;
      }
    },
    reportException(error) {
      const event = {
        cancelable: true,
        defaultPrevented: false,
        error,
        message: error.message,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      reportedEvents.push(event);
      for (const listener of [...listeners]) listener(event);
      return event;
    },
  };
}

class FakeControl {
  constructor({ id, type, checked, ownerWindow, onDispatch }) {
    this.id = id;
    this.tagName = 'INPUT';
    this.type = type;
    this.checked = checked;
    this.value = '';
    this.onDispatch = onDispatch;
    this.ownerDocument = { defaultView: ownerWindow };
    this.ownerWindow = ownerWindow;
  }

  closest() {
    return null;
  }

  // The listener runs, throws, and the exception is reported rather than
  // propagated — exactly what the DOM specifies for `dispatchEvent`.
  dispatchEvent(event) {
    try {
      this.onDispatch?.(event);
    } catch (error) {
      this.ownerWindow.reportException(error);
    }
    return true;
  }
}

function installDocument(controls) {
  const previousDocument = globalThis.document;
  const byId = new Map(controls.map(control => [control.id, control]));
  globalThis.document = {
    getElementById(id) {
      return id === 'floating-panels-root' ? null : byId.get(id) ?? null;
    },
  };
  return {
    sidebar: {
      querySelectorAll(selector) {
        return selector === 'input[id]' ? controls : [];
      },
    },
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

test('a swallowed control-listener exception becomes a restore failure', () => {
  const ownerWindow = createWindowStub();
  const failure = new Error('the renderer refused the restored value');
  const control = new FakeControl({
    id: 'toggle-centroid-labels',
    type: 'checkbox',
    checked: false,
    ownerWindow,
    onDispatch() {
      throw failure;
    },
  });
  const fixture = installDocument([control]);

  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        'toggle-centroid-labels': { type: 'checkbox', checked: true },
      }),
      error => error === failure,
      'the exception the owner threw must reach the restore, not the console',
    );
    assert.equal(
      control.checked,
      true,
      'the element itself accepted the value, so nothing but this guard could '
        + 'have noticed that its owner failed',
    );
    assert.equal(
      ownerWindow.reportedEvents.at(-1).defaultPrevented,
      true,
      'the restore reports the failure, so the browser must not also log it',
    );
  } finally {
    fixture.restore();
  }
});

test('the dispatch guard lives exactly as long as one dispatch', () => {
  const ownerWindow = createWindowStub();
  const observedListenerCounts = [];
  const control = new FakeControl({
    id: 'toggle-centroid-labels',
    type: 'checkbox',
    checked: false,
    ownerWindow,
    onDispatch() {
      observedListenerCounts.push(ownerWindow.listenerCount());
    },
  });
  const fixture = installDocument([control]);

  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.equal(ownerWindow.listenerCount(), 0);
    serializer.restoreUIControls({
      'toggle-centroid-labels': { type: 'checkbox', checked: true },
    });
    assert.deepEqual(
      observedListenerCounts,
      [1],
      'the guard must be installed for the dispatch it is guarding',
    );
    assert.equal(
      ownerWindow.listenerCount(),
      0,
      'and removed the moment that dispatch returns',
    );

    // An unrelated animation frame, timer, or resource error can only ever land
    // outside that window. It must not be charged to any control.
    assert.doesNotThrow(() => ownerWindow.reportException(
      new RangeError('Active view "snap_1" is not in the viewer inventory.'),
    ));
    assert.equal(
      ownerWindow.reportedEvents.at(-1).defaultPrevented,
      false,
      'an error reported outside a dispatch is not the restore\'s to swallow',
    );
  } finally {
    fixture.restore();
  }
});

test('a dispatch that throws outright is still the failure that is reported', () => {
  const ownerWindow = createWindowStub();
  const failure = new Error('dispatch itself failed');
  const control = new FakeControl({
    id: 'toggle-centroid-labels',
    type: 'checkbox',
    checked: false,
    ownerWindow,
  });
  control.dispatchEvent = () => {
    throw failure;
  };
  const fixture = installDocument([control]);

  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        'toggle-centroid-labels': { type: 'checkbox', checked: true },
      }),
      error => error === failure,
    );
    assert.equal(
      ownerWindow.listenerCount(),
      0,
      'a throwing dispatch must still remove the guard',
    );
  } finally {
    fixture.restore();
  }
});
