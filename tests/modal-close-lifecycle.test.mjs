import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeModal,
  createAnalysisModal,
  openModal,
} from '../assets/js/app/analysis/ui/components/modal.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function settleMicrotasks(turns = 8) {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function withControlledTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 1;

  globalThis.setTimeout = (callback, _delay, ...args) => {
    const timerId = nextTimerId++;
    timers.set(timerId, () => callback(...args));
    return timerId;
  };
  globalThis.clearTimeout = timerId => {
    timers.delete(timerId);
  };

  const runAllTimers = () => {
    for (let pass = 0; timers.size > 0; pass++) {
      if (pass >= 100) {
        throw new Error('Controlled modal timers did not quiesce');
      }
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, callback] of pending) callback();
    }
  };

  try {
    return await run({
      pendingTimerCount: () => timers.size,
      runAllTimers,
    });
  } finally {
    runAllTimers();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

class FakeStyle {
  constructor() {
    this.priorities = new Map();
  }

  propertyKey(name) {
    return String(name).replace(
      /-([a-z])/g,
      (_match, letter) => letter.toUpperCase()
    );
  }

  getPropertyPriority(name) {
    return this.priorities.get(String(name)) ?? '';
  }

  getPropertyValue(name) {
    return this[this.propertyKey(name)] ?? '';
  }

  removeProperty(name) {
    const property = String(name);
    const key = this.propertyKey(property);
    const previous = this[key] ?? '';
    delete this[key];
    this.priorities.delete(property);
    return previous;
  }

  setProperty(name, value, priority = '') {
    const property = String(name);
    this[this.propertyKey(property)] = String(value);
    this.priorities.set(property, String(priority));
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  _values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  _write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...names) {
    const values = this._values();
    for (const name of names) values.add(name);
    this._write(values);
  }

  remove(...names) {
    const values = this._values();
    for (const name of names) values.delete(name);
    this._write(values);
  }

  contains(name) {
    return this._values().has(name);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.isConnected = false;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.tabIndex = 0;
    this.listeners = new Map();
    this.offsetHeight = 480;
    this.offsetWidth = 640;
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.capturedPointers = new Set();
    this.releasedPointers = [];
  }

  get childElementCount() {
    return this.children.length;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    child._setConnected(this.isConnected);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('Fake child was not found');
    this.children.splice(index, 1);
    child.parentNode = null;
    child._setConnected(false);
    return child;
  }

  _setConnected(value) {
    this.isConnected = value;
    for (const child of this.children) child._setConnected(value);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener),
    );
  }

  dispatchEvent(event) {
    const exactEvent = {
      ...event,
      currentTarget: this,
      target: event.target ?? this,
    };
    for (const listener of this.listeners.get(exactEvent.type) ?? []) {
      listener(exactEvent);
    }
    return true;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const matchesSelector = element => {
      for (const rawPart of String(selector).split(',')) {
        const part = rawPart.trim();
        if (part.startsWith('.')) {
          const classes = part.slice(1).split('.');
          if (classes.every(name => element.classList.contains(name))) {
            return true;
          }
        } else if (part === 'button' && element.tagName === 'BUTTON') {
          return true;
        } else if (part === '[href]' && element.getAttribute('href') !== null) {
          return true;
        } else if (part === 'input' && element.tagName === 'INPUT') {
          return true;
        } else if (part === 'select' && element.tagName === 'SELECT') {
          return true;
        } else if (part === 'textarea' && element.tagName === 'TEXTAREA') {
          return true;
        } else if (
          part.startsWith('[tabindex]') &&
          element.getAttribute('tabindex') !== null &&
          element.getAttribute('tabindex') !== '-1'
        ) {
          return true;
        } else if (
          part === '[role="dialog"]' &&
          element.getAttribute('role') === 'dialog'
        ) {
          return true;
        }
      }
      return false;
    };
    const visit = element => {
      if (matchesSelector(element)) matches.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (
        selector.startsWith('.') &&
        current.classList.contains(selector.slice(1))
      ) {
        return current;
      }
      if (
        selector === '[role="dialog"]' &&
        current.getAttribute('role') === 'dialog'
      ) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return {
      bottom: 480,
      height: 480,
      left: 0,
      right: 640,
      top: 0,
      width: 640,
    };
  }

  getClientRects() {
    return this.isConnected ? [this.getBoundingClientRect()] : [];
  }

  contains(candidate) {
    let current = candidate;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  setPointerCapture(pointerId) {
    this.capturedPointers.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.capturedPointers.delete(pointerId);
    this.releasedPointers.push(pointerId);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

async function withFakeDOM(run) {
  const originalGlobals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    activeElement: null,
    body: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      documentListeners.set(
        type,
        listeners.filter(candidate => candidate !== listener),
      );
    },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) ?? []) {
        listener(event);
      }
    },
    querySelectorAll(selector) {
      const matches = [];
      if (
        selector.startsWith('.') &&
        selector.slice(1).split('.').every(
          name => document.body.classList.contains(name)
        )
      ) {
        matches.push(document.body);
      }
      matches.push(...document.body.querySelectorAll(selector));
      return matches;
    },
  };
  document.body = new FakeElement('body', document);
  document.body._setConnected(true);
  document.activeElement = document.body;

  class FakeResizeObserver {
    observe() {}
    disconnect() {}
  }

  const window = {
    Plotly: {
      purge() {},
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      windowListeners.set(
        type,
        listeners.filter(candidate => candidate !== listener),
      );
    },
  };

  globalThis.document = document;
  globalThis.HTMLElement = FakeElement;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = window;

  try {
    return await run({ document });
  } finally {
    for (const [name, value] of Object.entries(originalGlobals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

function createBareModal({
  beforeClose = null,
  onClose = null,
  parentNode = null,
} = {}) {
  return {
    _beforeClose: beforeClose,
    _cleanupDone: false,
    _cleanupFns: [],
    _closePromise: null,
    _onClose: onClose,
    classList: {
      remove() {},
    },
    parentNode,
  };
}

test('reentrant beforeClose executes once and observes the one stable close promise', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const gate = deferred();
    let beforeCloseCalls = 0;
    let reentrantClose = null;
    const modal = createBareModal();
    modal._beforeClose = () => {
      beforeCloseCalls++;
      if (beforeCloseCalls === 1) {
        reentrantClose = closeModal(modal);
      }
      return gate.promise;
    };

    const outerClose = closeModal(modal);
    await waitFor(() => beforeCloseCalls > 0, 'reentrant beforeClose');
    const exactCallCount = beforeCloseCalls;
    const stablePromise = reentrantClose === outerClose;

    gate.resolve();
    await waitFor(() => modal._cleanupDone, 'reentrant modal cleanup');
    runAllTimers();
    await Promise.all([...new Set([outerClose, reentrantClose])]);

    assert.equal(exactCallCount, 1);
    assert.equal(stablePromise, true);
    assert.equal(closeModal(modal), outerClose);
  });
});

test('button, backdrop, Escape, and direct close share one awaited hook', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      const gate = deferred();
      let beforeCloseCalls = 0;
      let onCloseCalls = 0;
      const modal = createAnalysisModal({
        beforeClose() {
          beforeCloseCalls++;
          return gate.promise;
        },
        onClose() {
          onCloseCalls++;
        },
      });
      openModal(modal);

      const directClose = closeModal(modal);
      modal.querySelector('.analysis-modal-close').dispatchEvent({
        type: 'click',
      });
      modal.querySelector('.analysis-modal-backdrop').dispatchEvent({
        type: 'click',
      });
      document.dispatchEvent({ key: 'Escape', type: 'keydown' });
      const repeatedDirectClose = closeModal(modal);

      await waitFor(() => beforeCloseCalls > 0, 'shared beforeClose');
      assert.equal(beforeCloseCalls, 1);
      assert.equal(repeatedDirectClose, directClose);
      assert.equal(modal._cleanupDone, false);
      assert.equal(onCloseCalls, 0);
      assert.equal(modal.isConnected, true);

      gate.resolve();
      await waitFor(() => modal._cleanupDone, 'modal cleanup');
      runAllTimers();
      await directClose;

      assert.equal(beforeCloseCalls, 1);
      assert.equal(onCloseCalls, 1);
      assert.equal(modal.isConnected, false);
      assert.equal(closeModal(modal), directClose);
    });
  });
});

test('analysis modal publishes dialog semantics, traps Tab, and restores trigger focus', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const modal = createAnalysisModal();
      const title = modal.querySelector('.analysis-modal-title');
      const closeButton = modal.querySelector('.analysis-modal-close');
      assert.equal(modal.getAttribute('role'), 'dialog');
      assert.equal(modal.getAttribute('aria-modal'), 'true');
      assert.equal(modal.getAttribute('aria-labelledby'), title.id);
      assert.equal(closeButton.getAttribute('aria-label'), 'Close analysis');

      openModal(modal);
      assert.equal(document.activeElement, closeButton);

      let preventedTabs = 0;
      document.dispatchEvent({
        key: 'Tab',
        preventDefault() {
          preventedTabs++;
        },
        shiftKey: false,
        type: 'keydown'
      });
      document.dispatchEvent({
        key: 'Tab',
        preventDefault() {
          preventedTabs++;
        },
        shiftKey: true,
        type: 'keydown'
      });
      assert.equal(preventedTabs, 2);
      assert.equal(document.activeElement, closeButton);

      const closing = closeModal(modal);
      runAllTimers();
      await closing;
      assert.equal(document.activeElement, trigger);
      assert.equal(modal.isConnected, false);
    });
  });
});

test('closing during edge resize, panel resize, or header drag restores exact interaction ownership', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    await withFakeDOM(async ({ document }) => {
      const scenarios = [
        {
          name: 'edge resize',
          selector: '.analysis-modal-edge-resize-right',
          start(element) {
            element.dispatchEvent({
              clientX: 640,
              clientY: 240,
              preventDefault() {},
              stopPropagation() {},
              type: 'mousedown'
            });
            return null;
          },
          expectedCursor: 'ew-resize'
        },
        {
          name: 'panel resize',
          selector: '.analysis-modal-resizer-vertical',
          start(element) {
            element.dispatchEvent({
              clientX: 400,
              clientY: 240,
              pointerId: 17,
              preventDefault() {},
              stopPropagation() {},
              type: 'pointerdown'
            });
            return element;
          },
          expectedCursor: 'col-resize'
        },
        {
          name: 'header drag',
          selector: '.analysis-modal-header',
          start(element) {
            element.dispatchEvent({
              clientX: 320,
              clientY: 40,
              preventDefault() {},
              type: 'mousedown'
            });
            return null;
          },
          expectedCursor: 'move'
        }
      ];

      for (const scenario of scenarios) {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        document.body.style.setProperty('cursor', 'help', 'important');
        document.body.style.setProperty(
          'user-select',
          'text',
          'important'
        );
        document.body.style.setProperty(
          '-webkit-user-select',
          'contain',
          'important'
        );
        const modal = createAnalysisModal();
        openModal(modal);
        const interactionTarget = modal.querySelector(scenario.selector);
        const pointerTarget = scenario.start(interactionTarget);

        assert.equal(
          document.body.style.cursor,
          scenario.expectedCursor,
          `${scenario.name} did not acquire the cursor`
        );
        assert.equal(document.body.style.userSelect, 'none');
        assert.equal(document.body.style.WebkitUserSelect, 'none');

        const closing = closeModal(modal);
        assert.equal(document.body.style.cursor, 'help');
        assert.equal(document.body.style.userSelect, 'text');
        assert.equal(document.body.style.WebkitUserSelect, 'contain');
        assert.equal(
          document.body.style.getPropertyPriority('cursor'),
          'important'
        );
        assert.equal(
          document.body.style.getPropertyPriority('user-select'),
          'important'
        );
        assert.equal(
          document.body.style.getPropertyPriority('-webkit-user-select'),
          'important'
        );
        assert.equal(
          interactionTarget.classList.contains('resizing'),
          false
        );
        if (pointerTarget !== null) {
          assert.equal(pointerTarget.hasPointerCapture(17), false);
          assert.deepEqual(pointerTarget.releasedPointers, [17]);
        }

        runAllTimers();
        await closing;
        assert.equal(document.activeElement, trigger);
      }
    });
  });
});

test('async onClose and animated physical detach both delay close settlement', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const onCloseGate = deferred();
    let onCloseCalls = 0;
    let detached = false;
    const parent = {
      removeChild(child) {
        assert.equal(child, modal);
        detached = true;
        modal.parentNode = null;
      },
    };
    const modal = createBareModal({
      beforeClose: async () => {},
      onClose() {
        onCloseCalls++;
        return onCloseGate.promise;
      },
      parentNode: parent,
    });
    let closeSettled = false;
    const closing = closeModal(modal);
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );

    await waitFor(() => onCloseCalls === 1, 'async onClose invocation');
    await settleMicrotasks();
    const settledBeforeOnClose = closeSettled;
    const detachedBeforeTimer = detached;

    onCloseGate.resolve();
    await settleMicrotasks();
    const settledBeforeDetach = closeSettled;

    runAllTimers();
    await closing;

    assert.equal(settledBeforeOnClose, false);
    assert.equal(detachedBeforeTimer, false);
    assert.equal(settledBeforeDetach, false);
    assert.equal(detached, true);
    assert.equal(closeSettled, true);
  });
});

test('a failed close is returned as the same rejected promise forever', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const exactFailure = new Error('modal owner teardown failed');
    let beforeCloseCalls = 0;
    const modal = createBareModal({
      beforeClose() {
        beforeCloseCalls++;
        throw exactFailure;
      },
    });

    const firstClose = closeModal(modal);
    await waitFor(() => modal._cleanupDone, 'failed modal cleanup');
    runAllTimers();
    const firstFailure = await firstClose.then(
      () => null,
      error => error,
    );
    const repeatedClose = closeModal(modal);
    const repeatedFailure =
      repeatedClose && typeof repeatedClose.then === 'function'
        ? await repeatedClose.then(
          () => null,
          error => error,
        )
        : null;

    assert.equal(firstFailure, exactFailure);
    assert.equal(repeatedClose, firstClose);
    assert.equal(repeatedFailure, exactFailure);
    assert.equal(beforeCloseCalls, 1);
  });
});

test('a no-hook modal still reports cleanup failure synchronously', { concurrency: false }, async () => {
  await withControlledTimers(async ({ runAllTimers }) => {
    const exactFailure = new Error('synchronous cleanup failed');
    const modal = createBareModal();
    modal._cleanupFns.push(() => {
      throw exactFailure;
    });

    assert.throws(() => closeModal(modal), error => error === exactFailure);
    assert.equal(modal._cleanupDone, true);
    runAllTimers();
  });
});
