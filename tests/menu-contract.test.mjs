/**
 * Menus: one look and one set of keys (`ui/components/menu.js`; "Menu" in
 * assets/css/README.md).
 *
 * - `menuKeyDown` is every menu's keys: ↑/↓ wrap, Home/End, Escape closes
 *   and returns to the opener, and Tab closes and hands focus back to the
 *   opener without taking the key, so the browser's Tab moves on from the
 *   opener. An open menu sits at the end of the page, so a Tab the browser
 *   took from an item would land on the page's first stop, the plot.
 * - A menu is built in one module only: `openMenu` for a menu of the moment;
 *   a menu written in the markup is bound by `initOpenDataMenu`, which answers
 *   the same keys. A second builder (with its own look and no touch size)
 *   fails here.
 * - A menu button in the markup states whether its menu is open.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { menuKeyDown } from '../assets/js/app/ui/components/menu.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function keyEvent(key, active) {
  return {
    key,
    target: { ownerDocument: { activeElement: active } },
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

function items(count) {
  const focused = [];
  const list = Array.from({ length: count }, (_, index) => ({ index, focus() { focused.push(index); } }));
  return { list, focused };
}

test('menu keys: arrows wrap, Home and End, Escape returns to the opener', () => {
  const { list, focused } = items(3);
  const closes = [];
  const close = refocus => closes.push(refocus);
  for (const [key, from, to] of [['ArrowDown', 2, 0], ['ArrowUp', 0, 2], ['ArrowDown', 0, 1], ['Home', 2, 0], ['End', 0, 2]]) {
    const event = keyEvent(key, list[from]);
    assert.equal(menuKeyDown(event, list, close), true, key);
    assert.equal(event.prevented, true, `${key} is the menu's`);
    assert.equal(focused.at(-1), to, `${key} from ${from}`);
  }
  const escape = keyEvent('Escape', list[1]);
  assert.equal(menuKeyDown(escape, list, close), true);
  assert.equal(escape.prevented, true);
  assert.deepEqual(closes, [true]);
});

test('Tab closes the menu, returns focus to the opener and leaves the key to the browser', () => {
  const { list } = items(2);
  const closes = [];
  const tab = keyEvent('Tab', list[0]);
  assert.equal(menuKeyDown(tab, list, refocus => closes.push(refocus)), true);
  assert.deepEqual(closes, [true], 'focus goes back to the opener first');
  assert.equal(tab.prevented, false, 'the browser moves on from the opener');
  const other = keyEvent('a', list[0]);
  assert.equal(menuKeyDown(other, list, () => assert.fail('a letter closes nothing')), false);
  assert.equal(other.prevented, false);
});

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(relative));
    else if (entry.name.endsWith('.js')) out.push(relative);
  }
  return out;
}

test('a menu is built only by the shared menu module', async () => {
  const builders = [];
  for (const file of await sources('assets/js')) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    if (/setAttribute\(\s*'role',\s*'menu'\s*\)|role:\s*'menu'|[^[]role="menu"/.test(source)) builders.push(file);
  }
  assert.deepEqual(builders, ['assets/js/app/ui/components/menu.js']);
});

test('the markup menus are bound by the one binder, and every menu button states its menu', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const menus = [...html.matchAll(/<div\b[^>]*\bid="([^"]+)"[^>]*\brole="menu"/g)].map(match => match[1]);
  assert.ok(menus.length > 0);
  for (const id of menus) {
    assert.match(html, new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*\\bclass="open-menu-list\\b`), `#${id} draws the menu look`);
  }
  for (const match of html.matchAll(/<button\b[^>]*aria-haspopup="menu"[^>]*>/g)) {
    assert.match(match[0], /aria-expanded="false"/, `a menu button says its menu is closed: ${match[0]}`);
  }
});
