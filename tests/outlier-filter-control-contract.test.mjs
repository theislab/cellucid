/**
 * The outlier filter's slider: a value given and not committed yet is the
 * person's, and a redraw of the control leaves it.
 *
 * Found 2026-11-12 (WebKit, 1 run in 5 of `outlier-filtering.spec.mjs`): the
 * legend is drawn again a moment after a field is shown, the control's render
 * put the thumb back at the threshold in effect between the slider's `input`
 * and its `change`, and the commit read that value: nothing was filtered.
 * The same redraw while a committed value was still being applied (its
 * action waiting behind a coloring) jumped the thumb back likewise; that
 * path is exercised in the browser (`outlier-filtering.spec.mjs`), where the
 * action runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const { initOutlierFilterControl } = await import('../assets/js/app/ui/modules/outlier-filter-control.js');

function fakeInput() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    value: '100',
    disabled: false,
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    ownerDocument: { defaultView: { addEventListener() {} } },
    closest: () => null,
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute: name => attributes.has(name),
    fire(type) { listeners.get(type)?.({ type, target: this }); },
  };
}

function controlOn(threshold) {
  const field = { key: 'cell_type', kind: 'category', _outlierThreshold: threshold };
  const state = {
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    getActiveField: () => field,
    getOutlierFilterStatus: () => ({ state: 'ready' }),
    on: () => () => {},
  };
  const input = fakeInput();
  const control = initOutlierFilterControl({ state, dom: { container: null, input, display: null, note: null, progress: null, progressBar: null, action: null } });
  control.render(field);
  return { control, input, field };
}

test('a redraw between a value given and its commit leaves the value; given up, the threshold in effect shows again', () => {
  const { control, input } = controlOn(1);
  assert.equal(input.value, '100', 'the threshold in effect');
  // The person moves the thumb (keys, a typed value): `input`, no `change` yet.
  input.value = '50';
  input.fire('input');
  // The legend is drawn again, and the control with it.
  control.render();
  assert.equal(input.value, '50', 'the value not committed yet is the person\'s');
  // Focus leaves without a commit: the control shows what is in effect.
  input.fire('blur');
  assert.equal(input.value, '100');
  control.destroy();
});

test('with nothing being given, a redraw shows the threshold in effect', () => {
  const { control, input, field } = controlOn(1);
  field._outlierThreshold = 0.8;
  control.render();
  assert.equal(input.value, '80');
  control.destroy();
});
