/**
 * A row cut to one line shows its whole text on a click or a tap
 * (`app/ui/components/full-text-reveal.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fullTextOf, initFullTextReveal, isTextCut } from '../assets/js/app/ui/components/full-text-reveal.js';

class FakeElement {
  constructor(document, { text = '', fullText = null, cut = false, parent = null } = {}) {
    this.document = document;
    this.textContent = text;
    this.attributes = new Map(fullText === null ? [] : [['data-full-text', fullText]]);
    this.scrollWidth = cut ? 300 : 100;
    this.clientWidth = 100;
    this.parent = parent;
    this.children = [];
    this.style = {};
    this.className = '';
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  closest(selector) {
    for (let node = this; node !== null; node = node.parent) {
      if (selector === '[data-full-text]' && node.attributes?.has('data-full-text')) return node;
      if (selector === 'dialog[open]') return null;
    }
    return null;
  }
  contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
  appendChild(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }; }
}

function fakeDocument() {
  const listeners = new Map();
  const view = { Element: FakeElement, innerWidth: 800, innerHeight: 600, addEventListener() {} };
  const document = {
    defaultView: view,
    addEventListener(type, listener) { listeners.set(type, listener); },
    createElement() { return new FakeElement(document); },
  };
  document.body = new FakeElement(document);
  return { document, click: target => listeners.get('click')({ target }), key: key => listeners.get('keydown')({ key }) };
}

test('the text a marked element stands for: the mark\'s value, else its own text', () => {
  const { document } = fakeDocument();
  assert.equal(fullTextOf(new FakeElement(document, { text: ' Proliferating double-negative thymocytes ', fullText: '' })), 'Proliferating double-negative thymocytes');
  assert.equal(fullTextOf(new FakeElement(document, { text: 'Suo', fullText: 'Developing human immune system (Suo)' })), 'Developing human immune system (Suo)');
  assert.equal(isTextCut(new FakeElement(document, { cut: true })), true);
  assert.equal(isTextCut(new FakeElement(document)), false);
});

test('a click on a cut, marked row shows its whole text; again, elsewhere or Escape closes it; a row that fits shows nothing', t => {
  const { document, click, key } = fakeDocument();
  const reveal = initFullTextReveal({ root: document });
  t.after(() => reveal.destroy());
  const cut = new FakeElement(document, { text: 'Macrophage phagocytosing erythrocytes', fullText: '', cut: true });
  const fits = new FakeElement(document, { text: 'B cells', fullText: '' });
  const plain = new FakeElement(document, { text: 'elsewhere' });
  const shown = () => document.body.children.map(child => child.textContent);

  click(fits);
  assert.deepEqual(shown(), []);
  click(cut);
  assert.deepEqual(shown(), ['Macrophage phagocytosing erythrocytes']);
  assert.equal(document.body.children[0].getAttribute('role'), 'tooltip');
  click(cut);
  assert.deepEqual(shown(), [], 'a second click closes it');
  click(cut);
  click(plain);
  assert.deepEqual(shown(), [], 'a click elsewhere closes it');
  click(cut);
  key('Escape');
  assert.deepEqual(shown(), []);
  // A child of the marked element (the name's own text node's parent) opens it too.
  const inner = new FakeElement(document, { parent: cut });
  click(inner);
  assert.deepEqual(shown(), ['Macrophage phagocytosing erythrocytes']);
});
