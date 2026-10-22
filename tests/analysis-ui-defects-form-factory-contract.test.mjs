/**
 * The analysis form helpers must emit output that is already correct, rather
 * than output a later pass has to repair. They are built on the shared control
 * kit (`ui/components/controls.js`), so these assertions pin the analysis
 * surface of that kit:
 *
 * - A labelled select binds its `<label for>` to the select, with an id that is
 *   unique per call: ids derived from the control's name alone repeated
 *   whenever an analysis mode was copied into a floating window, and the
 *   copy's label then operated the sidebar's control.
 * - A labelled select whose options carry descriptions shows the chosen
 *   option's description as its help line and announces it with the select.
 * - Labels never end in a colon.
 * - The performance settings are a keyboard-operable disclosure (a real
 *   `<button>` with `aria-expanded`/`aria-controls`, the region `hidden`) and
 *   every control inside it is named by its label.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPerformanceSettings,
  createSelectField
} from '../assets/js/app/analysis/shared/dom-utils.js';

// =============================================================================
// Minimal DOM
// =============================================================================

class FakeStyle {
  setProperty(name, value) {
    this[name] = String(value);
  }

  getPropertyValue(name) {
    return this[name] ?? '';
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  _set() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const values = this._set();
    for (const name of names) values.add(name);
    this.element.className = [...values].join(' ');
  }

  contains(name) {
    return this._set().has(name);
  }
}

const SELECTOR_TAGS = new Map([
  ['input', 'INPUT'],
  ['select', 'SELECT'],
  ['textarea', 'TEXTAREA'],
  ['meter', 'METER'],
  ['output', 'OUTPUT'],
  ['progress', 'PROGRESS'],
  ['label', 'LABEL'],
  ['option', 'OPTION'],
  ['span', 'SPAN'],
  ['div', 'DIV']
]);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = '';
    this.htmlFor = '';
    this.name = '';
    this.textContent = '';
    this.tabIndex = -1;
    this.hidden = false;
    this.value = '';
    this.type = tagName.toLowerCase() === 'input' ? 'text' : '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  get ownerDocument() {
    return globalThis.document;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (name === 'name') return this.name.length > 0 ? this.name : null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, { preventDefault() {}, target: this, ...event });
    }
  }

  click() {
    this.dispatch('click');
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }

  /** Supports only the comma-separated tag-name lists the factories use. */
  _matchesTags(selector) {
    return selector
      .split(',')
      .map(part => part.trim().toLowerCase())
      .some(part => SELECTOR_TAGS.get(part) === this.tagName);
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child._matchesTags(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function withFakeDOM(run) {
  const original = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  globalThis.document = {
    createElement: tagName => new FakeElement(tagName),
    createTextNode: text => ({ nodeType: 3, textContent: String(text), contains: () => false, querySelectorAll: () => [], _matchesTags: () => false })
  };
  globalThis.HTMLElement = FakeElement;
  try {
    return run();
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
  }
}

function performanceDataLayer() {
  return {
    state: { pointCount: 1200 },
    getAvailableVariables: () => [{ key: 'GAPDH' }, { key: 'ACTB' }]
  };
}

// =============================================================================
// Tests
// =============================================================================

test('a select field binds its label to the select it names', () => {
  withFakeDOM(() => {
    const { root, select } = createSelectField({
      label: 'Statistical method',
      name: 'method',
      options: [
        { value: 'ttest', label: 't-test', selected: true },
        { value: 'wilcoxon', label: 'Wilcoxon' }
      ]
    });

    const label = root.querySelector('label');
    assert.equal(label.textContent, 'Statistical method');
    assert.equal(select.name, 'method');
    assert.ok(select.id.length > 0, 'the select must carry an id');
    assert.equal(label.htmlFor, select.id, 'the label must target its select');
    assert.ok(root.classList.contains('control-block'));
  });
});

test('a label never ends in a colon', () => {
  withFakeDOM(() => {
    assert.throws(
      () => createSelectField({
        label: 'Statistical method:',
        name: 'method',
        options: [{ value: 'ttest', label: 't-test' }]
      }),
      /must not end with a colon/
    );
  });
});

test('a field that needs explaining carries an (i) beside its label, never a help line', () => {
  withFakeDOM(() => {
    const { root, select } = createSelectField({
      label: 'Statistical method',
      name: 'method',
      tip: 'analysis-test-method',
      options: [
        { value: 'wilcox', label: 'Wilcoxon', selected: true },
        { value: 'ttest', label: 't-test' }
      ]
    });
    const [labelRow, popover, control] = root.children;
    assert.equal(labelRow.className, 'field-label-row');
    const [label, info] = labelRow.children;
    assert.equal(label.htmlFor, select.id);
    assert.equal(info.className, 'info-btn');
    assert.equal(info.getAttribute('aria-controls'), popover.id);
    assert.equal(popover.className, 'info-tooltip');
    assert.equal(popover.dataset.infoTip, 'analysis-test-method');
    assert.equal(control, select);
    assert.equal(select.getAttribute('aria-describedby'), null);
    assert.equal(
      root.children.some(child => child.className === 'field-help'),
      false,
      'the explanation is the tip, not a line under the select',
    );
  });
});

test('form control ids are unique per call, not per control name', () => {
  withFakeDOM(() => {
    const options = [{ value: 'a', label: 'A' }];
    const first = createSelectField({ label: 'Group by', name: 'groupBy', options });
    const second = createSelectField({ label: 'Group by', name: 'groupBy', options });
    assert.notEqual(
      first.select.id,
      second.select.id,
      'a copied analysis window must not share the sidebar control id',
    );
    assert.equal(first.root.querySelector('label').htmlFor, first.select.id);
    assert.equal(second.root.querySelector('label').htmlFor, second.select.id);
  });
});

test('createPerformanceSettings emits a keyboard-operable disclosure and named rows', () => {
  withFakeDOM(() => {
    const settings = createPerformanceSettings({
      dataLayer: performanceDataLayer()
    });

    // The header row pairs the toggle with its (i); the popover follows it.
    const [headerRow, popover, content] = settings.children;
    const [header, info] = headerRow.children;
    assert.equal(headerRow.className, 'disclosure-header-row');
    assert.equal(info.getAttribute('aria-controls'), popover.id);
    assert.equal(popover.dataset.infoTip, 'analysis-performance');
    assert.ok(settings.classList.contains('disclosure'));
    assert.equal(header.tagName, 'BUTTON', 'the header is a native button');
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(header.getAttribute('aria-controls'), content.id);
    assert.equal(content.hidden, true);

    header.click();
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(content.hidden, false);

    // Every control the section hides is named by its label.
    const rows = content.children;
    assert.equal(rows.length, 4);
    const names = [];
    for (const row of rows) {
      const label = row.querySelector('label');
      const select = row.querySelector('select');
      assert.ok(select, 'each performance row holds a select');
      assert.ok(select.id.length > 0, 'each performance select has an id');
      assert.equal(label.htmlFor, select.id, label.textContent);
      assert.doesNotMatch(label.textContent, /:$/);
      names.push(select.name);
    }
    assert.deepEqual(
      names,
      ['batchSize', 'memoryBudget', 'networkConcurrency', 'parallelism'],
    );

    // Two sections in one document never share ids.
    const other = createPerformanceSettings({ dataLayer: performanceDataLayer() });
    const idsOf = section => [
      section.children[2].id,
      ...section.children[2].querySelectorAll('select').map(s => s.id)
    ];
    const overlap = idsOf(settings).filter(id => idsOf(other).includes(id));
    assert.deepEqual(overlap, []);
  });
});
