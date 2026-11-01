/**
 * `revealSidebar` opens the sidebar for a control outside it that leads to
 * one inside it (Data mapping's way to its checklist, a gene sample's way to
 * Genes read for), from the first frame on.
 *
 * On a phone the panel starts as its peek bar. Until the sidebar controls
 * take that state over it is only the root's mark (`viewport-init.js`): the
 * toggle has no listener yet, so clicking it would do nothing. The mark is
 * dropped instead, so the panel starts open. Afterwards the toggle opens it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { revealSidebar } from '../assets/js/app/ui/modules/sidebar-controls.js';

function fakeDocument({ peek, hidden }) {
  const stored = new Map();
  const clicks = [];
  const sidebar = { classList: { contains: name => name === 'hidden' && hidden } };
  const toggle = { click: () => clicks.push('sidebar-toggle') };
  const documentOwner = {
    documentElement: { dataset: peek ? { phoneSheet: 'peek' } : {} },
    defaultView: { sessionStorage: { setItem: (key, value) => stored.set(key, value) } },
    getElementById: id => ({ sidebar, 'sidebar-toggle': toggle })[id] ?? null,
  };
  return { documentOwner, stored, clicks };
}

test('before the sidebar controls are wired, a phone panel starts open instead of as its peek bar', () => {
  const { documentOwner, stored, clicks } = fakeDocument({ peek: true, hidden: false });
  revealSidebar(documentOwner);
  assert.equal('phoneSheet' in documentOwner.documentElement.dataset, false);
  // Kept for the tab, as opening it from the bar is.
  assert.equal(stored.get('cellucid:phone-sheet'), 'open');
  assert.deepEqual(clicks, []);
});

test('once wired, a closed sidebar opens through its toggle, and an open one is left alone', () => {
  const closed = fakeDocument({ peek: false, hidden: true });
  revealSidebar(closed.documentOwner);
  assert.deepEqual(closed.clicks, ['sidebar-toggle']);
  assert.equal(closed.stored.size, 0);

  const open = fakeDocument({ peek: false, hidden: false });
  revealSidebar(open.documentOwner);
  assert.deepEqual(open.clicks, []);
});

test('Data mapping opens the sidebar through revealSidebar, not a toggle click of its own', async () => {
  const source = await readFile(new URL('../assets/js/app/ui/modules/data-mapping-controls.js', import.meta.url), 'utf8');
  assert.match(source, /revealSidebar\(ownerDocument\)/);
  assert.doesNotMatch(source, /getElementById\('sidebar-toggle'\)\?\.click\(\)/);
});
