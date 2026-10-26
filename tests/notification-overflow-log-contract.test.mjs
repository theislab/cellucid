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
  addEventListener() {}
  remove() {}
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
