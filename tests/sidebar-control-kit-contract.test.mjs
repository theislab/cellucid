/**
 * The shared sidebar control kit (`ui/components/controls.js`) and the one
 * number formatter (`ui/components/display-format.js`) behave as the standard
 * in `assets/css/README.md` says: labels never end in a colon, a slider's
 * work runs once per frame and commits on release, disclosures own
 * aria-expanded/aria-controls/hidden, and the same quantity always reads the
 * same way.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCompactCount, formatDecimal, formatMultiplier, formatPercent, formatWithUnit } from '../assets/js/app/ui/components/display-format.js';
import { formatCells, formatCount, formatCountOf } from '../assets/js/utils/format-units.js';

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.parentElement = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, ...event });
    }
  }
}

const frames = [];
globalThis.HTMLElement = FakeNode;
globalThis.document = {
  createElement: tagName => new FakeNode(tagName),
  createTextNode: text => ({ textContent: text, parentElement: null })
};
globalThis.requestAnimationFrame = callback => frames.push(callback);
globalThis.cancelAnimationFrame = handle => {
  frames[handle - 1] = null;
};
function runFrames() {
  const pending = frames.splice(0);
  for (const frame of pending) frame?.();
}

const {
  coalesceToFrame,
  createButton,
  createCheckbox,
  createDisclosure,
  createField,
  createIconButton,
  createListItem,
  createSegmented,
  createSliderField,
  createStatusLine,
  createSwitch,
  ICONS
} = await import('../assets/js/app/ui/components/controls.js');

test('counts, units and multipliers read one way everywhere', () => {
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCountOf(1, 'cell'), '1 cell');
  assert.equal(formatCells(12000), '12,000 cells');
  assert.equal(formatCompactCount(950), '950');
  assert.equal(formatCompactCount(1500), '1.5K');
  assert.equal(formatCompactCount(15000), '15K');
  assert.equal(formatCompactCount(250000), '250K');
  assert.equal(formatCompactCount(2500000), '2.5M');
  assert.equal(formatDecimal(0.5, 2), '0.50');
  assert.equal(formatMultiplier(3, 1), '3.0×');
  assert.equal(formatPercent(60), '60%');
  assert.equal(formatWithUnit(8, 1, 's'), '8.0 s');
  assert.throws(() => formatCount(Number.NaN), /finite/);
});

test('a label above its control never ends in a colon and always names it', () => {
  const control = new FakeNode('select');
  const field = createField({ label: 'Statistical method', control });
  const [label] = field.children;
  assert.equal(label.localName, 'label');
  assert.equal(label.htmlFor, control.id);
  assert.match(control.id, /\S/);
  assert.throws(
    () => createField({ label: 'Statistical method:', control: new FakeNode('select') }),
    /colon/
  );
});

test('a slider paints and works once per frame and commits on release', () => {
  const inputs = [];
  const commits = [];
  const slider = createSliderField({
    label: 'Opacity',
    min: 0,
    max: 100,
    step: 1,
    value: 10,
    format: formatPercent,
    onInput: value => inputs.push(value),
    onCommit: value => commits.push(value)
  });
  assert.equal(slider.readout.textContent, '10%');
  assert.equal(slider.readout.getAttribute('for'), slider.input.id);
  for (const value of ['20', '30', '40']) {
    slider.input.value = value;
    slider.input.dispatch('input');
  }
  assert.deepEqual(inputs, [], 'no work before the frame');
  runFrames();
  assert.deepEqual(inputs, [40], 'one run per frame, with the latest value');
  assert.equal(slider.readout.textContent, '40%');
  slider.input.value = '55';
  slider.input.dispatch('input');
  slider.input.dispatch('change');
  assert.deepEqual(inputs, [40, 55], 'release flushes the pending frame');
  assert.deepEqual(commits, [55]);
});

test('coalesceToFrame keeps only the latest arguments and can be cancelled', () => {
  const calls = [];
  const scheduled = coalesceToFrame((...args) => calls.push(args));
  scheduled(1);
  scheduled(2, 'b');
  runFrames();
  scheduled(3);
  scheduled.cancel();
  runFrames();
  assert.deepEqual(calls, [[2, 'b']]);
});

test('switches, segments and disclosures carry their state in ARIA', () => {
  const changes = [];
  const sw = createSwitch({ label: 'Live filtering', checked: true, onChange: v => changes.push(v) });
  assert.equal(sw.root.getAttribute('role'), 'switch');
  assert.equal(sw.root.getAttribute('aria-checked'), 'true');
  sw.root.dispatch('click');
  assert.equal(sw.root.getAttribute('aria-checked'), 'false');
  assert.deepEqual(changes, [false]);

  const segmented = createSegmented({
    label: 'Combine',
    options: [{ value: 'a', label: 'Add' }, { value: 's', label: 'Subtract' }],
    value: 'a'
  });
  assert.equal(segmented.root.getAttribute('role'), 'group');
  assert.deepEqual(
    segmented.root.children.map(button => button.getAttribute('aria-pressed')),
    ['true', 'false']
  );

  const disclosure = createDisclosure({ title: 'Details', expanded: false });
  assert.equal(disclosure.header.getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure.header.getAttribute('aria-controls'), disclosure.content.id);
  assert.equal(disclosure.content.hidden, true);
  disclosure.header.dispatch('click');
  assert.equal(disclosure.header.getAttribute('aria-expanded'), 'true');
  assert.equal(disclosure.content.hidden, false);
});

test('buttons come from one family and icon buttons say what they do', () => {
  assert.equal(createButton({ label: 'Reset' }).className, 'btn');
  assert.equal(createButton({ label: 'Run', variant: 'primary' }).className, 'btn btn-primary');
  const icon = createIconButton({ label: 'Rename category', icon: ICONS.rename });
  assert.equal(icon.className, 'icon-btn');
  assert.equal(icon.getAttribute('aria-label'), 'Rename category');
  assert.equal(icon.title, 'Rename category');
  assert.match(icon.innerHTML, /^<svg aria-hidden="true" focusable="false" /);
});

test('checkboxes, list rows and status lines are named and announced', () => {
  const { root, input } = createCheckbox({ label: 'Use cached results', checked: true });
  assert.equal(root.className, 'checkbox-inline');
  assert.equal(root.htmlFor, input.id);
  assert.equal(input.checked, true);

  const row = createListItem({ text: 'cell_type: 2 of 3', enabled: false, noun: 'filter' });
  assert.equal(row.root.dataset.disabled, 'true');
  assert.equal(row.checkbox.getAttribute('aria-label'), 'Apply filter: cell_type: 2 of 3');
  assert.equal(row.remove.getAttribute('aria-label'), 'Remove filter: cell_type: 2 of 3');
  assert.equal(row.remove.title, 'Remove this filter');

  const status = createStatusLine({ tone: 'danger', text: 'Failed.' });
  assert.equal(status.root.getAttribute('role'), 'status');
  assert.equal(status.root.getAttribute('aria-live'), 'polite');
  assert.equal(status.root.dataset.tone, 'danger');
  status.set('');
  assert.equal(status.root.hidden, false, 'an empty live region stays in the tree');
});
