/**
 * The shared analysis form factories must emit output that is already correct,
 * rather than output a later pass has to repair.
 *
 * Three defects originated in `shared/dom-utils.js` and were previously worked
 * around from the call sites:
 *
 * - `createFormRow` emitted a `<label>` bound to nothing, so 38 selects across
 *   the analysis panels reached the accessibility tree anonymous.
 * - `createFormSelect` emitted a `<select>` with no id, so nothing could be
 *   bound to it without one being invented later.
 * - `createPerformanceSettings` rendered its disclosure header as a `<div>`
 *   with a click listener: unreachable by keyboard, announcing no state.
 * - Ids derived from the control's name alone (`form-checkbox-useCache`)
 *   repeated whenever an analysis mode was copied into a floating window.
 *
 * The repairs now live in the factories, so these assertions run against the
 * factories directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  associateRowLabel,
  createCollapsibleSection,
  createDisclosureHeader,
  createFormCheckbox,
  createFormRow,
  createFormSelect,
  createPerformanceSettings
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
    this.type = tagName.toLowerCase() === 'input' ? 'text' : '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
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
  globalThis.document = {
    createElement: tagName => new FakeElement(tagName)
  };
  try {
    return run();
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
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

test('createFormRow binds its label to the control it names', () => {
  withFakeDOM(() => {
    const select = createFormSelect('method', [
      { value: 'ttest', label: 't-test', selected: true },
      { value: 'wilcoxon', label: 'Wilcoxon' }
    ]);
    const row = createFormRow('Statistical method:', select);

    const label = row.querySelector('label');
    assert.equal(label.textContent, 'Statistical method:');
    assert.ok(select.id.length > 0, 'createFormSelect must emit an id');
    assert.equal(
      label.htmlFor,
      select.id,
      'the row label must target the row control',
    );
  });
});

test('createFormRow reaches the control inside a described-select wrapper', () => {
  withFakeDOM(() => {
    const wrapper = createFormSelect('batchSize', [
      { value: '32', label: '32', description: 'Small batches', selected: true },
      { value: '64', label: '64', description: 'Larger batches' }
    ]);
    assert.equal(wrapper.tagName, 'DIV', 'described selects come wrapped');

    const row = createFormRow('Batch size:', wrapper);
    const select = row.querySelector('select');
    assert.ok(select.id.length > 0, 'the wrapped select must carry an id');
    assert.equal(row.querySelector('label').htmlFor, select.id);
  });
});

test('a row holding two controls names both of them', () => {
  withFakeDOM(() => {
    const wrapper = document.createElement('div');
    const mode = createFormSelect('mode', [{ value: 'ranked', label: 'Ranked' }]);
    const method = createFormSelect('method', [{ value: 'ttest', label: 't-test' }]);
    wrapper.appendChild(mode);
    wrapper.appendChild(method);

    const row = createFormRow('Mode:', wrapper);
    assert.equal(row.querySelector('label').htmlFor, mode.id);
    assert.equal(method.getAttribute('aria-label'), 'Mode — method');
  });
});

test('associateRowLabel never re-binds a row that is already correct', () => {
  withFakeDOM(() => {
    const select = createFormSelect('method', [{ value: 'ttest', label: 't' }]);
    const row = createFormRow('Statistical method:', select);
    const boundId = row.querySelector('label').htmlFor;

    // The post-hoc pass runs over hand-assembled rows and must be a no-op here.
    associateRowLabel(row);
    assert.equal(row.querySelector('label').htmlFor, boundId);
    assert.equal(
      select.getAttribute('aria-label'),
      null,
      'a named control must not also collect a redundant aria-label',
    );
  });
});

test('form control ids are unique per call, not per control name', () => {
  withFakeDOM(() => {
    const sidebar = createFormCheckbox({ label: 'Use cached results', name: 'useCache' });
    const floating = createFormCheckbox({ label: 'Use cached results', name: 'useCache' });

    const sidebarBox = sidebar.querySelector('input');
    const floatingBox = floating.querySelector('input');
    assert.notEqual(
      sidebarBox.id,
      floatingBox.id,
      'a copied analysis window must not share the sidebar checkbox id',
    );
    assert.equal(sidebar.querySelector('label').htmlFor, sidebarBox.id);
    assert.equal(floating.querySelector('label').htmlFor, floatingBox.id);

    const first = createFormSelect('method', [{ value: 'a', label: 'A' }]);
    const second = createFormSelect('method', [{ value: 'a', label: 'A' }]);
    assert.notEqual(first.id, second.id);

    const labelledFirst = createFormSelect({
      label: 'Group By:', name: 'groupBy', options: [{ value: 'a', label: 'A' }]
    });
    const labelledSecond = createFormSelect({
      label: 'Group By:', name: 'groupBy', options: [{ value: 'a', label: 'A' }]
    });
    const idOf = wrapper => wrapper.querySelector('select').id;
    assert.notEqual(idOf(labelledFirst), idOf(labelledSecond));
    assert.equal(labelledFirst.querySelector('label').htmlFor, idOf(labelledFirst));
  });
});

test('createDisclosureHeader makes a header operable and announced', () => {
  withFakeDOM(() => {
    const header = document.createElement('div');
    const content = document.createElement('div');
    const glyph = document.createElement('span');

    const apply = createDisclosureHeader({
      header, content, glyph, expanded: false, contentId: 'region-1'
    });
    assert.equal(header.getAttribute('role'), 'button');
    assert.equal(header.tabIndex, 0);
    assert.equal(header.getAttribute('aria-controls'), 'region-1');
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(content.style.display, 'none');
    assert.equal(glyph.getAttribute('aria-hidden'), 'true');

    apply(true);
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(content.style.display, 'block');

    let clicks = 0;
    header.addEventListener('click', () => { clicks += 1; });
    header.dispatch('keydown', { key: 'Enter' });
    header.dispatch('keydown', { key: ' ' });
    header.dispatch('keydown', { key: 'a' });
    assert.equal(clicks, 2, 'Enter and Space operate the header, other keys do not');
  });
});

test('createCollapsibleSection builds an operable header, not a plain div', () => {
  withFakeDOM(() => {
    const { container, header, content } = createCollapsibleSection({
      title: 'Clustering',
      expanded: false,
      containerClassName: 'form-section cluster-params'
    });

    assert.equal(container.className, 'form-section cluster-params');
    assert.ok(header.classList.contains('analysis-perf-header'));
    assert.ok(content.classList.contains('analysis-perf-content'));
    assert.equal(header.getAttribute('role'), 'button');
    assert.equal(header.tabIndex, 0);
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(
      header.getAttribute('aria-controls'),
      content.id,
      'the header must control the region it hides',
    );
    assert.ok(content.id.length > 0);

    const caret = header.querySelector('span');
    assert.equal(header.children[1].getAttribute('aria-hidden'), 'true');
    assert.equal(caret.className, 'analysis-perf-title');

    // One click, one toggle: the visual caret and the announced state agree.
    header.click();
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(content.style.display, 'block');
    assert.equal(header.children[1].textContent, '▲');
    header.click();
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(content.style.display, 'none');
    assert.equal(header.children[1].textContent, '▼');
  });
});

test('createPerformanceSettings emits a keyboard-operable disclosure and named rows', () => {
  withFakeDOM(() => {
    const settings = createPerformanceSettings({
      dataLayer: performanceDataLayer()
    });

    const header = settings.children[0];
    const content = settings.children[1];
    assert.ok(header.classList.contains('analysis-perf-header'));
    assert.equal(header.getAttribute('role'), 'button');
    assert.equal(header.tabIndex, 0);
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(header.getAttribute('aria-controls'), content.id);

    // Every control the section hides is named by the row it sits in.
    const rows = content.children;
    assert.equal(rows.length, 4);
    const names = [];
    for (const row of rows) {
      const label = row.querySelector('label');
      const select = row.querySelector('select');
      assert.ok(select, 'each performance row holds a select');
      assert.ok(select.id.length > 0, 'each performance select has an id');
      assert.equal(label.htmlFor, select.id, label.textContent);
      names.push(select.name);
    }
    assert.deepEqual(
      names,
      ['batchSize', 'memoryBudget', 'networkConcurrency', 'parallelism'],
    );

    // Two sections in one document never share ids.
    const other = createPerformanceSettings({ dataLayer: performanceDataLayer() });
    const idsOf = section => [
      section.children[1].id,
      ...section.children[1].querySelectorAll('select').map(s => s.id)
    ];
    const overlap = idsOf(settings).filter(id => idsOf(other).includes(id));
    assert.deepEqual(overlap, []);
  });
});
