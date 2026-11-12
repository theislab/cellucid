// Work under way that can be stopped (a loading or progress card with
// `onCancel`) shows a button labeled Cancel, as its texts say ("Cancel stops
// it"; the walk of 2026-10-31 found only a "×" on the .h5ad export card). A
// settled card is dismissed with ×; work under way without `onCancel` has no
// button at all.

import assert from 'node:assert/strict';
import test from 'node:test';

import { NotificationCenter } from '../assets/js/app/notification-center.js';

class FakeButton {
  constructor(role) {
    this.dataset = { role };
    this.listeners = new Map();
    this.removed = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute() {}
  removeAttribute() {}
  remove() { this.removed = true; }
}

/** A card element: its markup kept, its buttons found by data-role. */
class FakeCard {
  constructor() {
    this.dataset = {};
    this.style = {};
    this.buttons = new Map();
    this.html = '';
  }
  set innerHTML(html) {
    this.html = html;
    this.buttons = new Map([...html.matchAll(/data-role="(cancel|dismiss)"/g)].map(([, role]) => [role, new FakeButton(role)]));
  }
  querySelector(selector) {
    const role = /\[data-role="(cancel|dismiss)"\]/.exec(selector)?.[1];
    return role === undefined ? null : this.buttons.get(role) ?? null;
  }
}

function withDocument(t) {
  const had = Object.hasOwn(globalThis, 'document');
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeCard() };
  t.after(() => {
    if (had) globalThis.document = previous;
    else delete globalThis.document;
  });
}

test('a card of work that can be stopped has a button labelled Cancel, which cancels it', async t => {
  withDocument(t);
  const center = new NotificationCenter();
  let cancelled = 0;
  const card = center._createNotificationElement('notif-1', {
    type: 'loading',
    category: 'download',
    message: 'Export the highlighted cells (.h5ad) · reads 345 MB, ~9 min…',
    onCancel: () => { cancelled += 1; },
  });
  assert.match(card.html, /<button type="button" class="btn btn-compact notification-cancel" data-role="cancel">Cancel<\/button>/);
  assert.doesNotMatch(card.html, />×</, 'no glyph stands for Cancel');
  assert.equal(card.buttons.has('dismiss'), false, 'work under way is never dismissed');
  card.buttons.get('cancel').listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('work under way without onCancel has no button; a settled card is dismissed with ×', t => {
  withDocument(t);
  const center = new NotificationCenter();
  const loading = center._createNotificationElement('notif-2', { type: 'loading', category: 'data', message: 'Reading' });
  assert.equal(loading.buttons.size, 0);
  const done = center._createNotificationElement('notif-3', { type: 'success', category: 'data', message: 'Read' });
  assert.deepEqual([...done.buttons.keys()], ['dismiss']);
  assert.match(done.html, /data-role="dismiss" aria-label="Dismiss">×<\/button>/);
});
