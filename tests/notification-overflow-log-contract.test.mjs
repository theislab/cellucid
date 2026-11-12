/**
 * The messages retired from the card stack to make room are the session's
 * log, listed under the stack. While that list is open, a message retired
 * adds its own row at the top; the list was rebuilt from every message so far
 * on each one, a cost that grew with the session.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { NotificationCenter } from '../assets/js/app/notification-center.js';

class Node {
  constructor(tag = 'div', fragment = false) {
    this.tagName = tag;
    this.fragment = fragment;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.attributes = new Map();
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
  }
  get childElementCount() { return this.children.length; }
  #adopt(nodes) { return nodes.flatMap(node => (node.fragment ? node.children.splice(0) : [node])); }
  append(...nodes) { this.children.push(...this.#adopt(nodes)); }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { this.children.unshift(...this.#adopt(nodes)); }
  replaceChildren(...nodes) { this.children = this.#adopt(nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { this.listeners ??= new Map(); this.listeners.set(type, listener); }
  remove() { this.removed = true; }
  querySelector() { return null; }
}

test('an open log of retired messages grows by the new rows only', t => {
  const previous = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.document = {
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node('#fragment', true),
  };
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.raf;
  });
  const center = new NotificationCenter();
  center.initialized = true;
  center.container = new Node();
  center._createNotificationElement = () => new Node();
  center._scheduleDismiss = () => {};
  center.maxNotifications = 2;
  for (let index = 0; index < 4; index++) center.error(`Failure ${index}.`, { category: 'data' });
  assert.equal(center.overflowMessages.length, 2);

  // Open the log.
  center._overflowExpanded = true;
  center._renderOverflow();
  const list = center._overflowParts.list;
  const firstRows = [...list.children];
  assert.equal(firstRows.length, 2);

  center.error('Failure 4.', { category: 'data' });
  assert.equal(center.overflowMessages.length, 3);
  assert.equal(list.children.length, 3);
  assert.deepEqual(list.children.slice(1), firstRows, 'the rows already listed are kept as they are');
  assert.equal(list.children[0].children.at(-1).textContent, center.overflowMessages.at(-1).message);
});

function fakeCenter(t) {
  const previous = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.document = {
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node('#fragment', true),
  };
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.raf;
  });
  const center = new NotificationCenter();
  center.initialized = true;
  center.container = new Node();
  center._createNotificationElement = () => new Node();
  center._scheduleDismiss = () => {};
  t.after(() => center.dismissAll());
  return center;
}

test('work held back takes no place on screen: it makes room only when it is shown (F71)', t => {
  const center = fakeCenter(t);
  center.maxNotifications = 2;
  const opening = center.show({ type: 'progress', message: 'Opening the file', progress: 0 });
  const guess = center.info('This file has no default UMAP.', { duration: 0, action: { label: 'Show', run: () => {} } });
  // A field read: held back for NOTICE_AFTER_MS, most end unseen.
  const read = center.loading('Loading field: cell_type');
  assert.equal(center.isShown(read), false);
  assert.equal(center.hasNotification(guess), true, 'a held-back card retired the card being read');
  assert.equal(center.overflowMessages.length, 0);
  center.complete(read, 'Loaded.');
  assert.equal(center.hasNotification(guess), true);

  // Shown, it makes room: the opening is work in progress, so the guess retires.
  center.reveal(opening);
  const slow = center.loading('Loading field: leiden');
  center.reveal(slow);
  assert.equal(center.hasNotification(guess), false);
  assert.equal(center.overflowMessages.at(-1).id, guess);
});

test('a card retired to make room keeps its follow-up in the earlier messages; its owner withdraws it', t => {
  const center = fakeCenter(t);
  center.maxNotifications = 1;
  const runs = [];
  const first = center.info('Opened on a best guess.', { duration: 0, action: { label: 'Show', run: () => runs.push('first') } });
  center.info('Saved.', { duration: 0 });
  assert.equal(center.hasNotification(first), false);
  center._overflowExpanded = true;
  center._renderOverflow();
  const [row] = center._overflowParts.list.children;
  const actions = row.children.at(-1);
  assert.equal(actions.className, 'notification-actions');
  const [show] = actions.children;
  assert.equal(show.textContent, 'Show');
  show.listeners.get('click')();
  assert.deepEqual(runs, ['first']);
  assert.equal(actions.removed, true, 'a follow-up taken is settled, as on the card');
  assert.equal(center.overflowMessages[0].action, null);

  const second = center.info('Retry the read?', { duration: 0, action: { label: 'Retry', run: () => runs.push('second') } });
  center.info('Saved again.', { duration: 0 });
  const record = center.overflowMessages.find(entry => entry.id === second);
  assert.equal(record.action.label, 'Retry');
  // Its owner dismisses it (the dataset it was about closed): the follow-up goes.
  assert.equal(center.dismiss(second), false);
  assert.equal(record.action, null);
  center._renderOverflow();
  assert.equal(center._overflowParts.list.children.every(item => item.children.every(child => child.className !== 'notification-actions' || child.removed)), true, 'no row offers a follow-up taken or withdrawn');
  assert.deepEqual(runs, ['first']);
});
