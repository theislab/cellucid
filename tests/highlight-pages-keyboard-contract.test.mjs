import assert from 'node:assert/strict';
import test from 'node:test';

import { initHighlightPagesUI } from '../assets/js/app/ui/modules/highlight/highlight-pages-ui.js';

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...names) {
    const values = this.values();
    for (const name of names) values.add(name);
    this.write(values);
  }

  remove(...names) {
    const values = this.values();
    for (const name of names) values.delete(name);
    this.write(values);
  }

  contains(name) {
    return this.values().has(name);
  }

  toggle(name, force) {
    const values = this.values();
    const shouldAdd = force === undefined ? !values.has(name) : force;
    if (shouldAdd) values.add(name);
    else values.delete(name);
    this.write(values);
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.style = {
      setProperty(name, value) {
        this[name] = String(value);
      }
    };
    this.disabled = false;
    this.draggable = false;
    this.hidden = false;
    this.id = '';
    this.isConnected = false;
    this.tabIndex = 0;
    this.title = '';
    this.type = '';
    this.value = '';
    this._textContent = '';
  }

  get nextSibling() {
    if (this.parentNode === null) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] ?? null;
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.children) {
      child.parentNode = null;
      child.setConnected(false);
    }
    this.children = [];
    this._textContent = String(value);
  }

  set innerHTML(value) {
    this.textContent = value;
  }

  get innerHTML() {
    return this._textContent;
  }

  setConnected(value) {
    this.isConnected = value;
    for (const child of this.children) child.setConnected(value);
  }

  appendChild(child) {
    if (child.parentNode !== null) child.remove();
    this._textContent = '';
    this.children.push(child);
    child.parentNode = this;
    child.setConnected(this.isConnected);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode !== null) child.remove();
    const index = reference === null
      ? this.children.length
      : this.children.indexOf(reference);
    if (index < 0) throw new Error('Fake insertion reference is missing.');
    this.children.splice(index, 0, child);
    child.parentNode = this;
    child.setConnected(this.isConnected);
    return child;
  }

  remove() {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1);
    this.parentNode = null;
    this.setConnected(false);
    if (this.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  contains(candidate) {
    let current = candidate;
    while (current !== null && current !== undefined) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener)
    );
  }

  dispatch(type, init = {}) {
    const event = {
      key: '',
      preventDefault() {},
      stopPropagation() {},
      target: this,
      ...init,
      currentTarget: this,
      type
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  matchesClassSelector(selector) {
    if (!selector.startsWith('.')) return false;
    return selector
      .slice(1)
      .split('.')
      .every(name => this.classList.contains(name));
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = element => {
      if (element.matchesClassSelector(selector)) matches.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    let current = this;
    while (current !== null) {
      if (current.matchesClassSelector(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    if (this.classList.contains('page-combine-menu')) {
      return {
        bottom: 1080,
        height: 120,
        left: 10,
        right: 160,
        top: 960,
        width: 150
      };
    }
    return {
      bottom: 40,
      height: 20,
      left: 10,
      right: 110,
      top: 20,
      width: 100
    };
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    this.dispatch('blur');
  }

  select() {}

  setCustomValidity(message) {
    this.validationMessage = message;
  }

  reportValidity() {
    return this.validationMessage === '';
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.body = new FakeElement('body', this);
    this.documentElement = {
      clientHeight: 1000,
      clientWidth: 1440
    };
    this.body.setConnected(true);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    const visit = element => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = visit(child);
        if (match !== null) return match;
      }
      return null;
    };
    return visit(this.body);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener)
    );
  }

  dispatch(type, init = {}) {
    const event = {
      key: '',
      preventDefault() {},
      stopPropagation() {},
      target: this.body,
      ...init,
      type
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makePage(id, name) {
  return {
    color: '#2563eb',
    highlightedGroups: [],
    id,
    name
  };
}

function createState() {
  const operations = [];
  const state = {
    activePageId: 'page_1',
    nextPageId: 3,
    onChange: null,
    pages: [
      makePage('page_1', 'Page 1'),
      makePage('page_2', 'Page 2')
    ],
    combineHighlightPages(sourceId, targetId, operation) {
      operations.push(['combine', sourceId, targetId, operation]);
      const page = makePage(
        `page_${this.nextPageId++}`,
        `${sourceId} ${operation} ${targetId}`
      );
      this.pages.push(page);
      this.onChange();
      return page;
    },
    createHighlightPage(name = null) {
      const id = `page_${this.nextPageId++}`;
      const page = makePage(id, name ?? `Page ${this.pages.length + 1}`);
      operations.push(['create', id]);
      this.pages.push(page);
      this.onChange();
      return page;
    },
    deleteHighlightPage(pageId) {
      operations.push(['delete', pageId]);
      this.pages = this.pages.filter(page => page.id !== pageId);
      if (!this.pages.some(page => page.id === this.activePageId)) {
        this.activePageId = this.pages[0].id;
      }
      this.onChange();
      return true;
    },
    ensureHighlightPage() {},
    getActivePageId() {
      return this.activePageId;
    },
    getHighlightedCellCountForPage() {
      return 0;
    },
    getHighlightPages() {
      return this.pages;
    },
    renameHighlightPage(pageId, name) {
      operations.push(['rename', pageId, name]);
      this.pages.find(page => page.id === pageId).name = name;
      this.onChange();
      return true;
    },
    setHighlightPageColor(pageId, color) {
      operations.push(['color', pageId, color]);
      this.pages.find(page => page.id === pageId).color = color;
      this.onChange();
      return true;
    },
    switchToPage(pageId) {
      operations.push(['switch', pageId]);
      this.activePageId = pageId;
      this.onChange();
      return true;
    }
  };
  return { operations, state };
}

async function withFakeDOM(run) {
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const document = new FakeDocument();
  globalThis.document = document;
  globalThis.HTMLElement = FakeElement;
  try {
    await run(document);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
  }
}

test('highlight pages expose roving tabs and complete keyboard operations with focus continuity', { concurrency: false }, async () => {
  await withFakeDOM(async document => {
    const tabs = document.createElement('div');
    const addButton = document.createElement('button');
    document.body.appendChild(tabs);
    document.body.appendChild(addButton);
    const { operations, state } = createState();
    const pagesUi = initHighlightPagesUI({
      state,
      dom: {
        addPageBtn: addButton,
        pagesTabsEl: tabs
      }
    });
    state.onChange = pagesUi.renderHighlightPages;

    assert.equal(tabs.getAttribute('role'), 'tablist');
    assert.equal(tabs.getAttribute('aria-label'), 'Highlight pages');
    assert.equal(tabs.getAttribute('aria-orientation'), 'horizontal');

    let tabControls = tabs.querySelectorAll('.highlight-page-tab-activate');
    assert.equal(tabControls.length, 2);
    assert.deepEqual(
      tabControls.map(control => ({
        role: control.getAttribute('role'),
        selected: control.getAttribute('aria-selected'),
        tabIndex: control.tabIndex
      })),
      [
        { role: 'tab', selected: 'true', tabIndex: 0 },
        { role: 'tab', selected: 'false', tabIndex: -1 }
      ]
    );

    tabControls[0].focus();
    tabControls[0].dispatch('keydown', { key: 'ArrowRight' });
    tabControls = tabs.querySelectorAll('.highlight-page-tab-activate');
    assert.equal(state.activePageId, 'page_2');
    assert.equal(document.activeElement, tabControls[1]);
    assert.equal(tabControls[0].getAttribute('aria-selected'), 'false');
    assert.equal(tabControls[0].tabIndex, -1);
    assert.equal(tabControls[1].getAttribute('aria-selected'), 'true');
    assert.equal(tabControls[1].tabIndex, 0);

    tabControls[1].dispatch('keydown', { key: 'Enter' });
    const renameInput = tabs.querySelector('.highlight-page-tab-input');
    assert.notEqual(renameInput, null);
    assert.equal(document.activeElement, renameInput);
    renameInput.value = 'Activated cells';
    renameInput.dispatch('keydown', { key: 'Enter' });
    assert.equal(state.pages[1].name, 'Activated cells');
    assert.equal(tabs.querySelector('.highlight-page-tab-input'), null);
    const renamedTab = tabs.querySelectorAll(
      '.highlight-page-tab-activate'
    )[1];
    assert.equal(document.activeElement, renamedTab);
    assert.equal(
      renamedTab.querySelector('.highlight-page-tab-name').textContent,
      'Activated cells'
    );

    let combineButton = tabs.querySelectorAll(
      '.highlight-page-tab-combine'
    )[1];
    combineButton.dispatch('click');
    let combineMenu = document.getElementById('page-combine-menu');
    assert.notEqual(combineMenu, null);
    assert.equal(combineMenu.getAttribute('role'), 'menu');
    assert.equal(combineButton.getAttribute('aria-haspopup'), 'menu');
    assert.equal(combineButton.getAttribute('aria-expanded'), 'true');
    assert.equal(
      combineButton.getAttribute('aria-controls'),
      'page-combine-menu'
    );
    assert.equal(combineMenu.style.top, '8px');
    assert.equal(combineMenu.style.maxHeight, '984px');
    assert.equal(
      document.activeElement,
      combineMenu.querySelector('.page-combine-option')
    );
    const menuOptions = combineMenu.querySelectorAll(
      '.page-combine-option'
    );
    document.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(document.activeElement, menuOptions[1]);
    document.dispatch('keydown', { key: 'Home' });
    assert.equal(document.activeElement, menuOptions[0]);
    document.dispatch('keydown', { key: 'Escape' });
    assert.equal(document.getElementById('page-combine-menu'), null);
    assert.equal(document.activeElement, combineButton);
    assert.equal(combineButton.getAttribute('aria-expanded'), 'false');

    combineButton.dispatch('click');
    combineMenu = document.getElementById('page-combine-menu');
    combineMenu.querySelector('.page-combine-option').dispatch('click');
    assert.equal(state.pages.length, 3);
    assert.equal(state.activePageId, 'page_3');
    assert.deepEqual(
      operations.find(operation => operation[0] === 'combine'),
      ['combine', 'page_2', 'page_1', 'intersection']
    );
    let activeTab = tabs.querySelectorAll(
      '.highlight-page-tab-activate'
    ).find(control => control.getAttribute('aria-selected') === 'true');
    assert.equal(document.activeElement, activeTab);

    activeTab.dispatch('keydown', { key: 'Delete' });
    assert.equal(state.pages.length, 2);
    assert.equal(state.activePageId, 'page_1');
    activeTab = tabs.querySelectorAll(
      '.highlight-page-tab-activate'
    ).find(control => control.getAttribute('aria-selected') === 'true');
    assert.equal(document.activeElement, activeTab);
    assert.equal(activeTab.tabIndex, 0);

    addButton.focus();
    addButton.dispatch('click');
    assert.equal(state.pages.length, 3);
    assert.equal(state.activePageId, 'page_4');
    activeTab = tabs.querySelectorAll(
      '.highlight-page-tab-activate'
    ).find(control => control.getAttribute('aria-selected') === 'true');
    assert.equal(document.activeElement, activeTab);
    assert.equal(activeTab.getAttribute('role'), 'tab');
  });
});
