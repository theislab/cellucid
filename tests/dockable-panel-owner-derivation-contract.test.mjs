/**
 * The dockable panel system must read its owners, never keep copies of them.
 *
 * Four things about a floating panel are owned somewhere else, and
 * `dockable-accordions.js` used to keep a private copy of each:
 *
 * - **Which panel is on top.** A `zIndexCounter` counted this module's own
 *   calls, but `--z-layer` on the panels is what the browser stacks by, and a
 *   session restore writes it directly
 *   (`session/contributors/dockable-layout.js`). After a restore the counter
 *   was back at its base while the restored panels sat far above it, so every
 *   panel torn off afterwards opened *behind* them and clicking it raised it by
 *   one from the same stale base — it could never be brought to the front.
 * - **Where a panel belongs when docked.** The placeholder holds the slot, and
 *   whether to leave one was passed in by the caller rather than read off the
 *   panel. The restore path floats a panel that is standing in the sidebar but
 *   shares an entry point with analysis windows, which have no slot, so a
 *   restored panel docked to the end of the sidebar instead of to its place.
 * - **How big a panel is.** `--pos-width/height` is the panel's box;
 *   `getBoundingClientRect()` is what the stylesheet drew, and the stylesheet
 *   forces `height: auto` on a collapsed panel. Capturing the measurement threw
 *   away the size a collapsed panel would reopen at.
 * - **Whether a gesture was a drag.** `suppressNextClick` was armed on
 *   pointerup and disarmed only by the click that followed. A cancelled pointer
 *   produces no click, so the flag survived to eat the user's next real one.
 *
 * The DOM here is a fake, but the two rules it models are copied from
 * `assets/css/components/_accordion.css`: a floating panel's box is
 * `--pos-x/y/width/height`, and `:not([open])` overrides the height to `auto`.
 * Everything else is the real module under test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { initDockableAccordions } from '../assets/js/app/dockable-accordions.js';
import {
  capture as captureDockableLayout,
  restore as restoreDockableLayout,
} from '../assets/js/app/session/contributors/dockable-layout.js';

/* ------------------------------------------------------------------ *
 * A DOM small enough to read and complete enough to drive the module. *
 * ------------------------------------------------------------------ */

class FakeCssStyleDeclaration {
  constructor() {
    Object.defineProperty(this, 'properties', {
      value: new Map(),
      enumerable: false,
    });
    Object.defineProperty(this, 'writes', { value: [], enumerable: false });
  }

  setProperty(name, value) {
    this.writes.push(name);
    this.properties.set(name, String(value));
  }

  removeProperty(name) {
    this.properties.delete(name);
  }

  getPropertyValue(name) {
    return this.properties.get(name) ?? '';
  }
}

function parseCompound(text) {
  const spec = { tag: null, id: null, classes: [], attributes: [] };
  const withoutAttributes = text.trim().replace(
    /\[([-\w]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g,
    (_match, name, doubleQuoted, singleQuoted, bare) => {
      spec.attributes.push({
        name,
        value: doubleQuoted ?? singleQuoted ?? bare ?? null,
      });
      return '';
    },
  );
  const partPattern = /([.#])?([-\w]+)/g;
  let part = partPattern.exec(withoutAttributes);
  while (part !== null) {
    if (part[1] === '.') spec.classes.push(part[2]);
    else if (part[1] === '#') spec.id = part[2];
    else spec.tag = part[2].toLowerCase();
    part = partPattern.exec(withoutAttributes);
  }
  return spec;
}

function parseSelector(selector) {
  return selector.split(',').map((term) => {
    const trimmed = term.trim();
    const scoped = trimmed.startsWith(':scope >');
    return {
      scoped,
      spec: parseCompound(scoped ? trimmed.slice(':scope >'.length) : trimmed),
    };
  });
}

function matchesSpec(element, spec) {
  if (spec.tag !== null && element.tagName.toLowerCase() !== spec.tag) return false;
  if (spec.id !== null && element.id !== spec.id) return false;
  for (const className of spec.classes) {
    if (!element.classList.contains(className)) return false;
  }
  for (const attribute of spec.attributes) {
    const actual = element.getAttribute(attribute.name);
    if (actual === null) return false;
    if (attribute.value !== null && actual !== attribute.value) return false;
  }
  return true;
}

class FakeHTMLElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.hidden = false;
    this.tabIndex = -1;
    this.dataset = {};
    this.style = new FakeCssStyleDeclaration();
    this.children = [];
    this.parentElement = null;
    this.attributeMap = new Map();
    this.listeners = [];
    this.offsetHeight = 0;
    this.scrollHeight = 0;
    /** Docked geometry, scripted by the test. */
    this.layoutRect = { left: 0, top: 0, width: 0, height: 0 };
    /** Height a collapsed floating panel renders at (its header). */
    this.headerHeight = 0;
    this.focusCount = 0;
  }

  get classList() {
    const owner = this;
    const names = () => owner.className.split(/\s+/).filter(Boolean);
    return {
      contains: name => names().includes(name),
      add(...added) {
        owner.className = [...new Set([...names(), ...added])].join(' ');
      },
      remove(...removed) {
        owner.className = names()
          .filter(name => !removed.includes(name))
          .join(' ');
      },
      toggle(name, force) {
        const shouldHave = force === undefined ? !names().includes(name) : force;
        if (shouldHave) this.add(name);
        else this.remove(name);
      },
    };
  }

  setAttribute(name, value) {
    this.attributeMap.set(name, String(value));
    if (name.startsWith('data-')) {
      const key = name
        .slice('data-'.length)
        .replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    if (this.attributeMap.has(name)) return this.attributeMap.get(name);
    if (name === 'id') return this.id === '' ? null : this.id;
    if (name === 'class') return this.className === '' ? null : this.className;
    return null;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = reference === null ? -1 : this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) return child;
    this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  contains(node) {
    for (let cursor = node; cursor !== null; cursor = cursor.parentElement) {
      if (cursor === this) return true;
    }
    return false;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  matches(selector) {
    return parseSelector(selector).some(term => matchesSpec(this, term.spec));
  }

  querySelectorAll(selector) {
    const terms = parseSelector(selector);
    const scopedTerms = terms.filter(term => term.scoped);
    const freeTerms = terms.filter(term => !term.scoped);
    const out = [];
    for (const child of this.children) {
      if (scopedTerms.some(term => matchesSpec(child, term.spec))) out.push(child);
    }
    for (const candidate of this.descendants()) {
      if (freeTerms.some(term => matchesSpec(candidate, term.spec))) {
        if (!out.includes(candidate)) out.push(candidate);
      }
    }
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    const terms = parseSelector(selector);
    for (let cursor = this; cursor !== null; cursor = cursor.parentElement) {
      if (terms.some(term => matchesSpec(cursor, term.spec))) return cursor;
    }
    return null;
  }

  addEventListener(type, listener, options) {
    const capture = options === true || options?.capture === true;
    const signal = options?.signal ?? null;
    if (signal?.aborted === true) return;
    const record = { type, listener, capture, once: options?.once === true };
    this.listeners.push(record);
    signal?.addEventListener('abort', () => {
      const index = this.listeners.indexOf(record);
      if (index >= 0) this.listeners.splice(index, 1);
    });
  }

  removeEventListener(type, listener, options) {
    const capture = options === true || options?.capture === true;
    const index = this.listeners.findIndex(
      record => record.type === type
        && record.listener === listener
        && record.capture === capture,
    );
    if (index >= 0) this.listeners.splice(index, 1);
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect() {
    this.ownerDocument.measurements.push(this);
    if (this.classList.contains('accordion-floating')) {
      const length = (name) => {
        const raw = this.style.getPropertyValue(name);
        return raw.endsWith('px') ? Number.parseFloat(raw) : 0;
      };
      const left = length('--pos-x');
      const top = length('--pos-y');
      const width = length('--pos-width');
      // `_accordion.css`:
      //   `.accordion-section.accordion-floating:not([open]) { height: auto }`
      const height = this.open === false ? this.headerHeight : length('--pos-height');
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    const rect = this.layoutRect;
    return {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    };
  }
}

class FakeHTMLDetailsElement extends FakeHTMLElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'details');
    this.open = false;
  }
}

/** Capture down the ancestor chain, then the target, then bubble back up. */
function dispatch(target, type, init = {}) {
  let propagationStopped = false;
  let immediateStopped = false;
  const event = {
    type,
    target,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; },
    stopImmediatePropagation() {
      propagationStopped = true;
      immediateStopped = true;
    },
    ...init,
  };
  const path = [];
  for (let cursor = target; cursor !== null; cursor = cursor.parentElement) {
    path.push(cursor);
  }
  const run = (node, capture) => {
    for (const record of [...node.listeners]) {
      if (immediateStopped) return;
      if (record.type !== type) continue;
      if (record.capture !== capture) continue;
      if (record.once) node.removeEventListener(type, record.listener, record.capture);
      record.listener.call(node, event);
    }
  };
  for (let index = path.length - 1; index >= 1 && !propagationStopped; index--) {
    run(path[index], true);
  }
  if (!propagationStopped) {
    run(target, true);
    if (!immediateStopped) run(target, false);
  }
  for (let index = 1; index < path.length && !propagationStopped; index++) {
    run(path[index], false);
  }
  return event;
}

function installDom(t, { viewportWidth = 1600, viewportHeight = 900 } = {}) {
  const previous = {};
  for (const name of [
    'Element',
    'HTMLElement',
    'HTMLDetailsElement',
    'document',
    'window',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    previous[name] = Object.hasOwn(globalThis, name)
      ? globalThis[name]
      : Symbol.for('absent');
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === Symbol.for('absent')) delete globalThis[name];
      else globalThis[name] = value;
    }
  });

  const doc = {
    measurements: [],
    activeElement: null,
    frames: [],
    createElement(tagName) {
      return tagName === 'details'
        ? new FakeHTMLDetailsElement(this)
        : new FakeHTMLElement(this, tagName);
    },
    getElementById(id) {
      if (this.root.id === id) return this.root;
      return this.root.descendants().find(node => node.id === id) ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
    getSelection() {
      return { removeAllRanges() {} };
    },
  };
  doc.root = new FakeHTMLElement(doc, 'html');
  doc.body = new FakeHTMLElement(doc, 'body');
  doc.root.appendChild(doc.body);
  doc.body.classList.add('body');
  // A real window carries listeners, and the dockable owner registers one for
  // `resize` so a shrinking viewport cannot strand a panel out of reach. A fake
  // without them would make that code unreachable here rather than tested.
  const windowListeners = new Map();
  doc.defaultView = {
    innerWidth: viewportWidth,
    innerHeight: viewportHeight,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = windowListeners.get(type) ?? [];
      const at = handlers.indexOf(handler);
      if (at !== -1) handlers.splice(at, 1);
    },
    resizeTo(width, height) {
      this.innerWidth = width;
      this.innerHeight = height;
      for (const handler of [...(windowListeners.get('resize') ?? [])]) handler();
    }
  };

  globalThis.Element = FakeHTMLElement;
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLDetailsElement = FakeHTMLDetailsElement;
  globalThis.document = doc;
  globalThis.window = doc.defaultView;
  globalThis.getComputedStyle = element => ({
    getPropertyValue: name => element.style.getPropertyValue(name),
  });
  globalThis.requestAnimationFrame = (callback) => {
    doc.frames.push(callback);
    return doc.frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};

  return doc;
}

/**
 * A sidebar of `panelIds` docked accordion sections, stacked down the left.
 */
function buildSidebar(doc, panelIds) {
  const sidebar = new FakeHTMLElement(doc, 'div');
  sidebar.id = 'sidebar';
  sidebar.layoutRect = { left: 0, top: 0, width: 320, height: 900 };
  const accordion = new FakeHTMLElement(doc, 'div');
  accordion.className = 'accordion';
  sidebar.appendChild(accordion);
  doc.body.appendChild(sidebar);

  const panels = new Map();
  panelIds.forEach((panelId, index) => {
    const details = new FakeHTMLDetailsElement(doc);
    details.id = panelId;
    details.className = 'accordion-section';
    details.open = true;
    details.headerHeight = 34;
    details.layoutRect = { left: 8, top: 8 + index * 200, width: 300, height: 180 };
    const summary = new FakeHTMLElement(doc, 'summary');
    summary.textContent = panelId;
    summary.offsetHeight = 34;
    const content = new FakeHTMLElement(doc, 'div');
    content.className = 'accordion-content';
    content.scrollHeight = 260;
    details.appendChild(summary);
    details.appendChild(content);
    accordion.appendChild(details);
    panels.set(panelId, { details, summary, content });
  });

  return { sidebar, accordion, panels };
}

function layerOf(details) {
  const raw = details.style.getPropertyValue('--z-layer');
  return raw === '' ? null : Number(raw);
}

function pixels(details, property) {
  const raw = details.style.getPropertyValue(property);
  return raw === '' ? null : Number.parseFloat(raw);
}

function panelPayload(id, { left, top, width, height, z, open = true }) {
  return { id, open, rect: { left, top, width, height }, z };
}

/* ------------------------------------------------------------------ *
 * Which panel is on top is the DOM's answer, not a private counter.   *
 * ------------------------------------------------------------------ */

test(
  'a panel torn off after a session restore opens above the restored panels',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha', 'beta', 'gamma']);
    const dockable = initDockableAccordions({ sidebar });

    // A saved session carries whatever layers the panels reached while the
    // user worked; every click on a floating panel raised one.
    restoreDockableLayout({ dockableAccordions: dockable }, null, {
      panels: [
        panelPayload('alpha', {
          left: 500, top: 40, width: 320, height: 300, z: 141,
        }),
        panelPayload('beta', {
          left: 900, top: 60, width: 320, height: 300, z: 142,
        }),
      ],
    });

    assert.equal(layerOf(panels.get('alpha').details), 141);
    assert.equal(layerOf(panels.get('beta').details), 142);

    // The user now tears off a third panel. It must land on top.
    const gamma = panels.get('gamma').details;
    dockable.undock(gamma);

    assert.equal(gamma.classList.contains('accordion-floating'), true);
    assert.ok(
      layerOf(gamma) > 142,
      `a newly torn-off panel opened at layer ${layerOf(gamma)}, `
      + 'below the restored panels at 141 and 142',
    );
  },
);

test(
  'clicking a panel brings it to the front of a restored stack',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha', 'beta', 'gamma']);
    const dockable = initDockableAccordions({ sidebar });

    restoreDockableLayout({ dockableAccordions: dockable }, null, {
      panels: [
        panelPayload('alpha', {
          left: 500, top: 40, width: 320, height: 300, z: 141,
        }),
        panelPayload('beta', {
          left: 900, top: 60, width: 320, height: 300, z: 142,
        }),
      ],
    });

    const alpha = panels.get('alpha').details;
    dispatch(panels.get('alpha').summary, 'pointerdown', {
      clientX: 520,
      clientY: 50,
    });

    assert.ok(
      layerOf(alpha) > layerOf(panels.get('beta').details),
      `pressing a restored panel left it at layer ${layerOf(alpha)}, `
      + `below layer ${layerOf(panels.get('beta').details)}`,
    );
  },
);

test(
  'pressing the front panel again writes no new layer',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha', 'beta']);
    const dockable = initDockableAccordions({ sidebar });

    dockable.undock(panels.get('alpha').details);
    dockable.undock(panels.get('beta').details);

    const beta = panels.get('beta').details;
    const before = beta.style.writes.filter(name => name === '--z-layer').length;
    for (let press = 0; press < 20; press++) {
      dispatch(panels.get('beta').summary, 'pointerdown', {
        clientX: 700,
        clientY: 300,
      });
    }
    const after = beta.style.writes.filter(name => name === '--z-layer').length;

    assert.equal(
      after - before,
      0,
      'a panel already above every other panel must not be restacked on '
      + 'every pointer press',
    );
    assert.ok(
      layerOf(beta) > layerOf(panels.get('alpha').details),
      'the front panel must still be in front',
    );
  },
);

/* ------------------------------------------------------------------ *
 * A restored panel docks back into its slot, not onto the end.        *
 * ------------------------------------------------------------------ */

test(
  'a session-restored panel docks back into the slot it came from',
  (t) => {
    const doc = installDom(t);
    const { sidebar, accordion, panels } = buildSidebar(
      doc,
      ['alpha', 'beta', 'gamma'],
    );
    const dockable = initDockableAccordions({ sidebar });

    restoreDockableLayout({ dockableAccordions: dockable }, null, {
      panels: [
        panelPayload('beta', {
          left: 600, top: 80, width: 320, height: 300, z: 91,
        }),
      ],
    });

    const beta = panels.get('beta').details;
    assert.equal(beta.parentElement, dockable.floatingRoot);

    dockable.dock(beta);

    assert.deepEqual(
      accordion.children
        .filter(child => child.classList.contains('accordion-section'))
        .map(child => child.id),
      ['alpha', 'beta', 'gamma'],
      'docking a restored panel must return it to its own place in the sidebar',
    );
  },
);

test(
  'an analysis window, which has no slot, still docks nowhere',
  (t) => {
    const doc = installDom(t);
    const { sidebar, accordion } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    // Analysis windows are built straight into the floating root and are
    // registered as not dockable (`analysis/ui/analysis-window-manager.js`).
    const window_ = new FakeHTMLDetailsElement(doc);
    window_.id = 'analysis-window-1';
    window_.className = 'accordion-section analysis-window-panel';
    window_.open = true;
    window_.headerHeight = 34;
    const summary = new FakeHTMLElement(doc, 'summary');
    summary.offsetHeight = 34;
    summary.textContent = 'Comparison';
    const content = new FakeHTMLElement(doc, 'div');
    content.className = 'accordion-content';
    window_.appendChild(summary);
    window_.appendChild(content);
    dockable.floatingRoot.appendChild(window_);

    dockable.register(window_, { dockable: false });
    doc.measurements.length = 0;
    dockable.float(window_, {
      left: 700,
      top: 120,
      preferredSize: { width: 420, height: 320 },
    });

    assert.equal(window_.parentElement, dockable.floatingRoot);
    assert.equal(
      accordion.querySelector('.accordion-dock-placeholder'),
      null,
      'a window with no docked slot must not reserve one in the sidebar',
    );
    assert.equal(
      doc.measurements.filter(element => element === window_).length,
      0,
      'a window told its position and its size, and with no slot to hold '
      + 'open, has nothing left to measure',
    );
  },
);

/* ------------------------------------------------------------------ *
 * The captured size is the panel's, not the stylesheet's rendering.   *
 * ------------------------------------------------------------------ */

test(
  'a collapsed floating panel reopens at the size it was saved with',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });
    const ctx = { dockableAccordions: dockable };

    const alpha = panels.get('alpha').details;
    dockable.float(alpha, {
      left: 620,
      top: 90,
      preferredSize: { width: 360, height: 420 },
    });
    assert.equal(pixels(alpha, '--pos-height'), 420);

    // The user collapses the panel and saves.
    alpha.open = false;
    const captured = captureDockableLayout(ctx)[0].payload;
    assert.deepEqual(
      captured.panels.map(panel => ({ id: panel.id, open: panel.open })),
      [{ id: 'alpha', open: false }],
    );

    // Reopening it in a fresh page must give back the same panel.
    dockable.dock(alpha);
    restoreDockableLayout(ctx, null, captured);
    alpha.open = true;

    assert.equal(
      pixels(alpha, '--pos-height'),
      420,
      'a panel saved while collapsed must reopen at its own height, not at '
      + 'the floor a header-sized measurement collapses to',
    );
    assert.equal(pixels(alpha, '--pos-width'), 360);
  },
);

test(
  'floating geometry survives a save and restore unchanged',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha', 'beta']);
    const dockable = initDockableAccordions({ sidebar });
    const ctx = { dockableAccordions: dockable };

    dockable.float(panels.get('alpha').details, {
      left: 480,
      top: 64,
      preferredSize: { width: 300, height: 260 },
    });
    dockable.float(panels.get('beta').details, {
      left: 900,
      top: 128,
      preferredSize: { width: 340, height: 300 },
    });

    const first = captureDockableLayout(ctx)[0].payload;
    restoreDockableLayout(ctx, null, first);
    const second = captureDockableLayout(ctx)[0].payload;

    assert.deepEqual(second, first);
  },
);

/* ------------------------------------------------------------------ *
 * A gesture that produced no click must not consume the next one.     *
 * ------------------------------------------------------------------ */

test(
  'a cancelled drag does not swallow the next click on the header',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    const { details, summary } = panels.get('alpha');
    dockable.float(details, {
      left: 700,
      top: 200,
      preferredSize: { width: 320, height: 280 },
    });

    // Drag the floating panel, then let the browser take the pointer away.
    // A cancelled pointer never produces a click.
    dispatch(summary, 'pointerdown', { clientX: 720, clientY: 210 });
    dispatch(summary, 'pointermove', { clientX: 800, clientY: 260 });
    dispatch(summary, 'pointercancel', { clientX: 800, clientY: 260 });

    // The user now clicks the header to collapse the panel.
    const press = dispatch(summary, 'pointerdown', { clientX: 720, clientY: 210 });
    assert.equal(press.defaultPrevented, true);
    const click = dispatch(summary, 'click', { clientX: 720, clientY: 210 });

    assert.equal(
      click.defaultPrevented,
      false,
      'the click that follows a fresh press must reach the panel, however the '
      + 'previous gesture ended',
    );
  },
);

test(
  'a real drag still swallows exactly the click it produced',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    const { details, summary } = panels.get('alpha');
    dockable.float(details, {
      left: 700,
      top: 200,
      preferredSize: { width: 320, height: 280 },
    });

    dispatch(summary, 'pointerdown', { clientX: 720, clientY: 210 });
    dispatch(summary, 'pointermove', { clientX: 900, clientY: 300 });
    dispatch(summary, 'pointerup', { clientX: 900, clientY: 300 });

    const suppressed = dispatch(summary, 'click', { clientX: 900, clientY: 300 });
    assert.equal(suppressed.defaultPrevented, true);

    dispatch(summary, 'pointerdown', { clientX: 900, clientY: 300 });
    const next = dispatch(summary, 'click', { clientX: 900, clientY: 300 });
    assert.equal(next.defaultPrevented, false);
  },
);

/* ------------------------------------------------------------------ *
 * Unregistering a panel is a teardown, not a note that one happened.  *
 * ------------------------------------------------------------------ */

test(
  'an unregistered panel no longer responds to its drag handlers',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    const { details, summary } = panels.get('alpha');
    dockable.unregister(details);

    // Tearing the header off to the right of the sidebar is what undocks a
    // panel; an unregistered panel must not answer.
    dispatch(summary, 'pointerdown', { clientX: 20, clientY: 40 });
    dispatch(summary, 'pointermove', { clientX: 900, clientY: 90 });
    dispatch(summary, 'pointerup', { clientX: 900, clientY: 90 });

    assert.equal(
      details.classList.contains('accordion-floating'),
      false,
      'a panel that was unregistered must not still tear off',
    );
    assert.equal(details.parentElement?.className, 'accordion');
  },
);

test(
  'a floating panel unregistered mid-flight can still be docked',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    const alpha = panels.get('alpha').details;
    dockable.undock(alpha);
    assert.equal(alpha.parentElement, dockable.floatingRoot);

    // Unregistering drops the record. Whether the panel is floating is on the
    // element, so dropping the record must not strand it in the floating root.
    dockable.unregister(alpha);
    dockable.dock(alpha);

    assert.equal(
      alpha.classList.contains('accordion-floating'),
      false,
      'a panel visibly floating must never refuse to dock because a private '
      + 'record of its state was dropped',
    );
    assert.notEqual(alpha.parentElement, dockable.floatingRoot);
  },
);

test(
  're-registering a panel gives it exactly one live set of handlers',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    const { details, summary } = panels.get('alpha');
    dockable.unregister(details);
    dockable.register(details, { dockable: true });

    const pointerDownHandlers = summary.listeners.filter(
      record => record.type === 'pointerdown',
    ).length;
    assert.equal(
      pointerDownHandlers,
      2,
      'one docked-drag handler and one floating-drag handler, not two of each',
    );

    dispatch(summary, 'pointerdown', { clientX: 20, clientY: 40 });
    dispatch(summary, 'pointermove', { clientX: 900, clientY: 90 });
    dispatch(summary, 'pointerup', { clientX: 900, clientY: 90 });
    assert.equal(details.classList.contains('accordion-floating'), true);
  },
);

/* ------------------------------------------------------------------ *
 * Restoring must not measure what it was told.                        *
 * ------------------------------------------------------------------ */

test(
  'restoring a layout measures no panel whose geometry the payload carries',
  (t) => {
    const doc = installDom(t);
    const { sidebar, panels } = buildSidebar(doc, ['alpha', 'beta', 'gamma']);
    const dockable = initDockableAccordions({ sidebar });

    doc.measurements.length = 0;
    restoreDockableLayout({ dockableAccordions: dockable }, null, {
      panels: [
        panelPayload('alpha', {
          left: 500, top: 40, width: 320, height: 300, z: 91,
        }),
        panelPayload('beta', {
          left: 900, top: 60, width: 320, height: 300, z: 92,
        }),
        panelPayload('gamma', {
          left: 1200, top: 80, width: 320, height: 300, z: 93,
        }),
      ],
    });

    const perPanel = new Map();
    for (const element of doc.measurements) {
      if (!panels.has(element.id)) continue;
      perPanel.set(element.id, (perPanel.get(element.id) ?? 0) + 1);
    }

    for (const [panelId, count] of perPanel) {
      assert.ok(
        count <= 1,
        `restoring "${panelId}" forced ${count} layout measurements; the `
        + 'payload already carries its position and its size',
      );
    }
  },
);

test(
  'shrinking the viewport keeps a floating panel reachable',
  (t) => {
    const doc = installDom(t, { viewportWidth: 1600, viewportHeight: 900 });
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });

    // Placed against a wide window, near its right edge.
    restoreDockableLayout({ dockableAccordions: dockable }, null, {
      panels: [
        panelPayload('alpha', {
          left: 1200, top: 500, width: 320, height: 300, z: 90,
        }),
      ],
    });

    const details = panels.get('alpha').details;
    const readLeft = () => Number.parseFloat(
      details.style.getPropertyValue('--pos-x')
    );
    const readTop = () => Number.parseFloat(
      details.style.getPropertyValue('--pos-y')
    );
    assert.equal(readLeft(), 1200);
    assert.equal(readTop(), 500);

    // The user makes the window much smaller. Without a clamp the panel sits
    // entirely outside it, and its header - the drag handle, the dock button
    // and the close button - cannot be reached at all, leaving no way back
    // except clearing the saved layout.
    doc.defaultView.resizeTo(800, 600);

    const left = readLeft();
    const top = readTop();
    assert.ok(
      left + 320 <= 800,
      `panel right edge ${left + 320} must stay inside the 800px viewport`
    );
    assert.ok(
      top + 300 <= 600,
      `panel bottom edge ${top + 300} must stay inside the 600px viewport`
    );
    assert.ok(left >= 8 && top >= 8, 'the header must stay inside the margin');
  }
);

test(
  'a viewport resize does not move a panel that is already inside it',
  (t) => {
    const doc = installDom(t, { viewportWidth: 1600, viewportHeight: 900 });
    const { sidebar, panels } = buildSidebar(doc, ['alpha']);
    const dockable = initDockableAccordions({ sidebar });
    restoreDockableLayout({ dockableAccordions: dockable }, null, {
      panels: [
        panelPayload('alpha', {
          left: 100, top: 80, width: 320, height: 300, z: 90,
        }),
      ],
    });

    const details = panels.get('alpha').details;
    doc.defaultView.resizeTo(1400, 800);

    // Re-clamping must not become re-arranging: a panel the user placed
    // somewhere that is still legal stays exactly where they put it.
    assert.equal(
      Number.parseFloat(details.style.getPropertyValue('--pos-x')),
      100
    );
    assert.equal(
      Number.parseFloat(details.style.getPropertyValue('--pos-y')),
      80
    );
  }
);
