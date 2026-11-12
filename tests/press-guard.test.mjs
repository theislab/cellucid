// One gesture is one press of a start/stop or commit button (`assets/js/app/ui/core/press-guard.js`):
// the further clicks of a double click and a held Enter never press such a button again, wherever
// the next click lands. Round 9 R9W-1: a double click on Export started the figure export and
// canceled it at once, silently (the button had become "Cancel export").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'assets/js/app/ui/core/press-guard.js'), 'utf8');

/** A document whose capture listeners run before the page's own handlers, as in a browser. */
function page() {
  const capture = { click: [], keydown: [] };
  const document = {
    addEventListener(type, listener, useCapture) {
      assert.equal(useCapture, true, `${type} is guarded in the capture phase, before the page's handlers`);
      capture[type].push(listener);
    },
  };
  vm.runInNewContext(SOURCE, { document });
  /** An element matching `.btn-primary, [data-single-press]` when `single` is true. */
  const element = (name, single) => ({ name, closest: selector => {
    assert.equal(selector, '.btn-primary, [data-single-press]');
    return single ? { name } : null;
  } });
  const presses = [];
  function dispatch(type, init) {
    const event = { ...init, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; } };
    for (const listener of capture[type]) listener(event);
    // The page's own handler sees the event unless the guard stopped it.
    if (type === 'click' && !event.stopped) presses.push(init.target.name);
    if (type === 'keydown' && !event.defaultPrevented && init.key === 'Enter') presses.push(init.target.name);
    return event;
  }
  return {
    element, presses,
    click: (target, detail) => dispatch('click', { target, detail }),
    key: (target, key, repeat) => dispatch('keydown', { target, key, repeat }),
  };
}

test('a double click on a single-press button presses it once', () => {
  const p = page();
  const exportButton = p.element('export', true);
  p.click(exportButton, 1);
  const second = p.click(exportButton, 2);
  assert.deepEqual(p.presses, ['export']);
  assert.equal(second.defaultPrevented, true, 'a submit button does not submit again');
  p.click(exportButton, 3);
  assert.deepEqual(p.presses, ['export'], 'a triple click too');
});

test('the next click of a sequence begun on one is dropped wherever it lands (Send gives its place to Stop, a dialog uncovers a control)', () => {
  const p = page();
  p.click(p.element('send', true), 1);
  p.click(p.element('control under it', false), 2);
  assert.deepEqual(p.presses, ['send']);
});

test('a double click begun elsewhere is dropped only on a single-press button', () => {
  const p = page();
  const row = p.element('list row', false);
  p.click(row, 1);
  p.click(row, 2);
  assert.deepEqual(p.presses, ['list row', 'list row'], 'ordinary controls keep their double clicks');
  p.click(row, 1);
  p.click(p.element('confirm', true), 2);
  assert.deepEqual(p.presses, ['list row', 'list row', 'list row']);
});

test('separate clicks, keyboard and programmatic clicks always act', () => {
  const p = page();
  const button = p.element('export', true);
  p.click(button, 1);
  p.click(button, 1); // after the platform's double-click time
  p.click(button, 0); // Enter, Space or element.click()
  p.click(button, 0);
  assert.deepEqual(p.presses, ['export', 'export', 'export', 'export']);
  // A plain click elsewhere ends the sequence begun on the button.
  p.click(button, 1);
  p.click(p.element('other', false), 1);
  p.click(p.element('other', false), 2);
  assert.deepEqual(p.presses.slice(4), ['export', 'other', 'other']);
});

test('a held Enter presses a single-press button once; other keys and other buttons repeat', () => {
  const p = page();
  const button = p.element('read', true);
  p.key(button, 'Enter', false);
  p.key(button, 'Enter', true);
  p.key(button, 'Enter', true);
  assert.deepEqual(p.presses, ['read']);
  assert.equal(p.key(button, ' ', true).defaultPrevented, true, 'a held Space neither');
  assert.equal(p.key(button, 'ArrowDown', true).defaultPrevented, false);
  const stepper = p.element('stepper', false);
  p.key(stepper, 'Enter', false);
  p.key(stepper, 'Enter', true);
  assert.deepEqual(p.presses, ['read', 'stepper', 'stepper']);
});

test('every button that turns into its own Stop, Cancel or Run again is single-press', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<script src="assets\/js\/app\/ui\/core\/press-guard\.js(\?v=[0-9a-f]+)?"><\/script>/,
    'the page loads the guard as a classic script, before the module graph');
  // Each also turns into its own Stop/Cancel, or starts a read that a second press would start over.
  for (const id of ['gene-read-action', 'outlier-filter-action', 'agent-chat-stop', 'subsample-apply', 'subsample-open-all', 'data-address-open-btn']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*data-single-press`), `#${id}`);
  }
  assert.match(html, /<button[^>]*id="agent-chat-send"[^>]*btn-primary/, 'Send (Stop takes its place)');
  const js = file => readFileSync(path.join(ROOT, 'assets/js', file), 'utf8');
  assert.match(js('app/ui/modules/figure-export/figure-export-ui.js'), /className: 'btn btn-primary', id: 'figure-export-btn'/,
    'Export (Cancel export)');
  assert.match(js('app/jobs/job-status-view.js'), /button\.dataset\.singlePress = ''/, 'Cancel (Run again)');
  assert.match(js('app/agent/presence/index.js'), /stop\.dataset\.singlePress = ''/, 'an agent turn\'s Stop (Undo turn)');
});
