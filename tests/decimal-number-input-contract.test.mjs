/**
 * No box a person types a decimal number into is `<input type="number">`.
 *
 * A number box of a page marked English refuses a typed decimal comma in
 * Firefox ("12,5" reads as empty) and Chromium shows it in the system's
 * locale, so a decimal is typed in the one decimal box of the control kit
 * (`createDecimalInput`, `ui/components/controls.js`: a text field with the
 * decimal keypad), read by `parseDecimalText` (a point or a comma). A whole
 * number may stay a number box, with an integer `step`.
 *
 * The sweep reads every page and script: markup (`index.html`, template
 * strings), element configs (`type: 'number'`) and imperative builders
 * (`input.type = 'number'`).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources() {
  const files = readdirSync(ROOT).filter(name => name.endsWith('.html')).map(name => path.join(ROOT, name));
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(m?js|html)$/.test(entry.name)) files.push(full);
    }
  };
  // The worker bundles are built from these sources.
  walk(path.join(ROOT, 'assets', 'js'));
  return files.map(file => ({ file: path.relative(ROOT, file), text: readFileSync(file, 'utf8') }));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const WHOLE = /^\d+$/;

test('no number box in markup takes a decimal', () => {
  const found = [];
  for (const { file, text } of sources()) {
    for (const match of text.matchAll(/<input\b[^>]*>/gs)) {
      const tag = match[0];
      if (!/\btype\s*=\s*["']number["']/.test(tag)) continue;
      const step = /\bstep\s*=\s*["']([^"']*)["']/.exec(tag)?.[1] ?? null;
      if ((step !== null && !WHOLE.test(step)) || /\binputmode\s*=\s*["']decimal["']/i.test(tag)) {
        found.push(`${file}:${lineOf(text, match.index)}`);
      }
    }
  }
  assert.deepEqual(found, [], 'a decimal is typed in a decimal box (createDecimalInput), never <input type="number">');
});

test('no number box built by a script takes a decimal', () => {
  const found = [];
  for (const { file, text } of sources()) {
    if (!file.endsWith('.js')) continue;
    // Element configs: `createElement('input', { type: 'number', step: '0.05', ... })`.
    for (const match of text.matchAll(/type:\s*['"]number['"]/g)) {
      const open = text.lastIndexOf('{', match.index);
      const close = text.indexOf('}', match.index);
      const config = text.slice(open, close);
      if (!/\b(step|inputMode|inputmode)\s*:/.test(config) && !/\bmin:|\bmax:/.test(config)) continue;
      const step = /\bstep:\s*['"]([^'"]*)['"]/.exec(config)?.[1] ?? null;
      if ((step !== null && !WHOLE.test(step)) || /\binputMode:\s*['"]decimal['"]/.test(config)) {
        found.push(`${file}:${lineOf(text, match.index)}`);
      }
    }
    // Imperative builders: `input.type = 'number'` then its step and keypad.
    for (const match of text.matchAll(/(\w+)\.type\s*=\s*['"]number['"]/g)) {
      const name = match[1];
      const following = text.slice(match.index, match.index + 800);
      const step = new RegExp(`\\b${name}\\.step\\s*=\\s*([^;\\n]+)`).exec(following)?.[1]?.trim() ?? null;
      const keypad = new RegExp(`\\b${name}\\.inputMode\\s*=\\s*([^;\\n]+)`).exec(following)?.[1] ?? '';
      if ((step !== null && !/^['"]\d+['"]$/.test(step)) || /decimal/.test(keypad)) {
        found.push(`${file}:${lineOf(text, match.index)}`);
      }
    }
  }
  assert.deepEqual(found, [], 'a decimal is typed in a decimal box (createDecimalInput), never input.type = "number"');
});

test('the decimal boxes are the control kit\'s, read by the one rule', async () => {
  const { createDecimalInput, readDecimalInput } = await import('../assets/js/app/ui/components/controls.js');
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }) };
  try {
    const box = createDecimalInput({ id: 'rate', ariaLabel: 'Rate', value: 0.15 });
    assert.equal(box.type, 'text');
    assert.equal(box.inputMode, 'decimal');
    assert.equal(box.value, '0.15');
    assert.equal(box.attributes['aria-label'], 'Rate');
    box.value = '2,5';
    assert.equal(readDecimalInput(box), 2.5);
    box.value = '';
    assert.ok(Number.isNaN(readDecimalInput(box)));
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  // A plot option of a type chosen at run time routes a fractional step to it.
  const options = readFileSync(path.join(ROOT, 'assets/js/app/analysis/ui/components/options.js'), 'utf8');
  assert.match(options, /if \(type === 'number' && !Number\.isInteger\(step\)\) \{\s*\n\s*input = createDecimalInput\(/);
  // Static boxes in index.html carry the same attributes.
  const page = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['subsample-percent', 'cinematic-set-all-duration']) {
    const tag = new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, 's').exec(page)?.[0] ?? '';
    assert.match(tag, /type="text"/, id);
    assert.match(tag, /inputmode="decimal"/, id);
  }
  const { parseDecimalText } = await import('../assets/js/utils/format-units.js');
  assert.equal(parseDecimalText('0,15'), 0.15);
  assert.equal(parseDecimalText('2.5'), 2.5);
});
