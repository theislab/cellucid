/**
 * The inline editor (`ui/components/inline-editor.js`) names a field, a
 * category and a saved state in place. Leaving the box names it, as Enter
 * does, like a view's and a highlight page's names; a name refused is said on
 * the box as the browser says a refused entry, and goes as the name is changed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { InlineEditor } = await import('../assets/js/app/ui/components/inline-editor.js');

function fakeInput() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    listeners,
    value: '',
    title: '',
    style: {},
    validity: '',
    reported: 0,
    focused: 0,
    removed: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    setCustomValidity(message) { this.validity = message; },
    reportValidity() { this.reported += 1; return this.validity === ''; },
    focus() { this.focused += 1; },
    select() {},
    remove() { this.removed = true; },
  };
}

async function editor(options) {
  const input = fakeInput();
  const previous = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.document = { createElement: () => input };
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  const target = { hidden: false, getBoundingClientRect: () => ({ width: 100 }), parentNode: { insertBefore() {} } };
  try {
    InlineEditor.create(target, 'before', options);
  } finally {
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.raf;
  }
  const blur = async () => {
    input.listeners.get('blur')();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { input, target, blur };
}

test('leaving the box names it, as Enter does; Escape leaves it as it was', async () => {
  const saved = [];
  const left = await editor({ onSave: value => saved.push(value) });
  left.input.value = ' after ';
  await left.blur();
  assert.deepEqual(saved, ['after']);
  assert.equal(left.input.removed, true);
  assert.equal(left.target.hidden, false);

  let cancelled = 0;
  const escaped = await editor({ onSave: value => saved.push(value), onCancel: () => { cancelled += 1; } });
  escaped.input.value = 'typed';
  escaped.input.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  await escaped.blur();
  assert.deepEqual(saved, ['after']);
  assert.equal(cancelled, 1);
});

test('a refused name is said on the box until it is changed, and the box stays open', async () => {
  const saved = [];
  const { input, blur } = await editor({
    onSave: value => saved.push(value),
    validate: value => (value === 'taken' ? 'A field with this name already exists' : true),
  });
  input.value = 'taken';
  input.listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.equal(input.validity, 'A field with this name already exists');
  assert.equal(input.reported, 1);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.removed, false);
  // Leaving it refused keeps it open and says why again.
  await blur();
  assert.equal(input.removed, false);
  assert.equal(input.reported, 2);
  // Typing clears the refusal; a free name is taken.
  input.value = 'free';
  input.listeners.get('input')();
  assert.equal(input.validity, '');
  assert.equal(input.getAttribute('aria-invalid'), null);
  input.listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(saved, ['free']);
  assert.equal(input.removed, true);
});
