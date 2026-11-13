/**
 * `revealSidebar` opens the sidebar for a control outside it that leads to
 * one inside it (Data mapping's way to its checklist, a gene sample's way to
 * Genes read for), from the first frame on.
 *
 * On a phone the panel starts as its peek bar. Until the sidebar controls
 * take that state over it is only the root's mark (`viewport-init.js`): the
 * toggle has no listener yet, so clicking it would do nothing. The mark is
 * dropped instead, so the panel starts open. Afterwards the toggle opens it,
 * through an action, so the sidebar opens later: the promise resolves once it
 * is shown, when a control in it can take focus (`?` would focus nothing with
 * the sidebar hidden).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { revealInSidebar, revealSidebar } from '../assets/js/app/ui/modules/sidebar-controls.js';

function fakeDocument({ peek, hidden }) {
  const stored = new Map();
  const clicks = [];
  const observers = [];
  const sidebar = {
    hidden,
    classList: { contains: name => name === 'hidden' && sidebar.hidden },
  };
  // The toggle asks through an action: the sidebar opens later (`show()`).
  const toggle = { click: () => clicks.push('sidebar-toggle') };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.on = false; }
    observe(target, options) {
      assert.equal(target, sidebar);
      assert.deepEqual(options, { attributes: true, attributeFilter: ['class'] });
      this.on = true;
      observers.push(this);
    }
    disconnect() { this.on = false; }
  }
  const documentOwner = {
    documentElement: { dataset: peek ? { phoneSheet: 'peek' } : {} },
    defaultView: {
      sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
      MutationObserver: FakeMutationObserver,
    },
    getElementById: id => ({ sidebar, 'sidebar-toggle': toggle })[id] ?? null,
  };
  const show = () => {
    sidebar.hidden = false;
    for (const observer of observers.filter(each => each.on)) observer.callback([]);
  };
  return { documentOwner, stored, clicks, observers, show };
}

test('before the sidebar controls are wired, a phone panel starts open instead of as its peek bar', () => {
  const { documentOwner, stored, clicks } = fakeDocument({ peek: true, hidden: false });
  revealSidebar(documentOwner);
  assert.equal('phoneSheet' in documentOwner.documentElement.dataset, false);
  // Kept for the tab, as opening it from the bar is.
  assert.equal(stored.get('cellucid:phone-sheet'), 'open');
  assert.deepEqual(clicks, []);
});

test('once wired, a closed sidebar opens through its toggle, and an open one is left alone', async () => {
  const closed = fakeDocument({ peek: false, hidden: true });
  let resolved = false;
  const shown = revealSidebar(closed.documentOwner).then(() => { resolved = true; });
  assert.deepEqual(closed.clicks, ['sidebar-toggle']);
  assert.equal(closed.stored.size, 0);
  // A second reveal while the first waits shares it: one toggle press.
  void revealSidebar(closed.documentOwner);
  assert.deepEqual(closed.clicks, ['sidebar-toggle']);

  const open = fakeDocument({ peek: false, hidden: false });
  await revealSidebar(open.documentOwner);
  assert.deepEqual(open.clicks, []);

  // The reveal resolves only once the sidebar is shown (until then it is
  // inert and nothing in it can take focus), and stops watching then.
  await Promise.resolve();
  assert.equal(resolved, false);
  closed.show();
  await shown;
  assert.equal(resolved, true);
  assert.deepEqual(closed.observers.map(observer => observer.on), [false]);
});

test('every way into the sidebar opens it first and its sections after, through revealInSidebar', async () => {
  for (const file of ['ui/modules/data-mapping-controls.js', 'ui/modules/gene-read-control.js', 'ui/onboarding/keyboard-shortcuts.js']) {
    const source = await readFile(new URL(`../assets/js/app/${file}`, import.meta.url), 'utf8');
    assert.match(source, /revealInSidebar\(ownerDocument, /, file);
    assert.doesNotMatch(source, /revealSidebar\(/, `${file} opens nothing before the sidebar is shown`);
    assert.doesNotMatch(source, /getElementById\('sidebar-toggle'\)\?\.click\(\)/, file);
  }
});

test('revealInSidebar opens what it is given only once the sidebar is shown', async () => {
  const closed = fakeDocument({ peek: false, hidden: true });
  const order = [];
  const done = revealInSidebar(closed.documentOwner, () => { order.push('opened'); return 'focused'; });
  await Promise.resolve();
  assert.deepEqual(order, [], 'nothing opens while the sidebar action is starting');
  closed.show();
  assert.equal(await done, 'focused');
  assert.deepEqual(order, ['opened']);
});
