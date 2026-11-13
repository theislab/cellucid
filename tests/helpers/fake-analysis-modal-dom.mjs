/**
 * What a Node test needs to open the analysis modal: a small DOM with `<dialog>`, a pointer-capturing
 * element and the viewport the modal reads (`withFakeDOM`), and timers it can run on demand
 * (`withControlledTimers`).
 */

export function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

export async function settleMicrotasks(turns = 8) {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

export async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function withControlledTimers(run) {
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
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.capturedPointers = new Set();
    this.releasedPointers = [];
  }

  // Every fake box is positioned, so its offset parent is its parent.
  get offsetParent() {
    return this.parentNode;
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

  // What focus asks of a target (`app-dialog.js` `canTakeFocus`).
  matches(selector) {
    return selector === ':disabled' ? this.disabled === true : false;
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

/**
 * A `<dialog>` as the analysis view uses it (`wireAppDialog`): opened
 * modally, closed with a `close` event, as the browser does (Escape is the
 * browser's `cancel`, then `close`).
 */
class FakeDialog extends FakeElement {
  constructor(ownerDocument) {
    super('dialog', ownerDocument);
    this.open = false;
    this.modal = false;
  }

  showModal() {
    this.open = true;
    this.modal = true;
    // Every engine focuses the dialog's first control before showModal()
    // returns, and a focus listener may close the dialog there.
    this.ownerDocument.onDialogFocusedWhileOpening?.(this);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.modal = false;
    this.dispatchEvent({ type: 'close' });
  }
}

export async function withFakeDOM(run) {
  const originalGlobals = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLDialogElement: globalThis.HTMLDialogElement,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    activeElement: null,
    body: null,
    /** What a focus listener does when showModal() focuses a dialog (it may close it). */
    onDialogFocusedWhileOpening: null,
    createElement(tagName) {
      return tagName === 'dialog' ? new FakeDialog(document) : new FakeElement(tagName, document);
    },
    // Nothing selected: the dialog leaves an empty selection as it is (`app-dialog.js`).
    getSelection() {
      return { rangeCount: 0, anchorNode: null };
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
    innerWidth: 1280,
    innerHeight: 800,
    // A desktop viewport: the expanded view is not full screen.
    matchMedia: () => ({ matches: false }),
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
  globalThis.HTMLDialogElement = FakeDialog;
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
