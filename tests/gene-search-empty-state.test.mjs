import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initGeneExpressionSelector,
} from '../assets/js/app/ui/modules/field-selector-gene-expression.js';
import { FieldSource } from '../assets/js/app/utils/field-constants.js';

/* ---------------------------------------------------------------------------
   Minimal exact DOM stand-in.

   The gene selector validates every node against the constructors published by
   its own window, so the fake window publishes the same constructor names.
   --------------------------------------------------------------------------- */

class FakeClassList {
  constructor(values = []) {
    this.values = new Set(values);
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    if (force === true) this.add(value);
    else if (force === false) this.remove(value);
    else if (this.values.has(value)) this.remove(value);
    else this.add(value);
    return this.values.has(value);
  }
}

class FakeNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
  }

  appendChild(child) {
    if (child instanceof FakeFragment) {
      for (const fragmentChild of [...child.children]) {
        this.appendChild(fragmentChild);
      }
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (this.parentNode === null) return;
    const index = this.parentNode.children.indexOf(this);
    if (index === -1) throw new Error('node is not mounted on its parent');
    this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains?.(node) === true);
  }

  querySelector(selector) {
    const className = selector.replace(/^\./, '');
    for (const child of this.children) {
      if (child.classList?.contains(className) === true) return child;
      const nested = child.querySelector?.(selector);
      if (nested !== null && nested !== undefined) return nested;
    }
    return null;
  }

  /** Every text node reachable from this node, in document order. */
  collectText() {
    const own = this.textContent === '' ? [] : [this.textContent];
    return [
      ...own,
      ...this.children.flatMap(child => child.collectText()),
    ];
  }

  /** The rendered copy, whitespace-normalized the way a reader sees it. */
  readText() {
    return this.collectText().join(' ').replace(/\s+/g, ' ').trim();
  }
}

class FakeFragment extends FakeNode {}

class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument);
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    this.title = '';
    this.listeners = new Map();
  }

  /** The real DOM keeps `className` and `classList` in step; so does this. */
  get className() {
    return [...this.classList.values].join(' ');
  }

  set className(value) {
    this.classList = new FakeClassList(
      String(value).split(/\s+/).filter(token => token !== '')
    );
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeInputElement extends FakeElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'input');
    this.value = '';
  }

  select() {}

  blur() {}
}

class FakeButtonElement extends FakeElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'button');
    this.disabled = false;
  }
}

class FakeSelectElement extends FakeElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'select');
    this.value = '';
  }
}

function createFakeDocument() {
  const ownerDocument = {
    addEventListener() {},
    createDocumentFragment() {
      return new FakeFragment(ownerDocument);
    },
    createElement(tagName) {
      if (tagName === 'input') return new FakeInputElement(ownerDocument);
      if (tagName === 'button') return new FakeButtonElement(ownerDocument);
      if (tagName === 'select') return new FakeSelectElement(ownerDocument);
      return new FakeElement(ownerDocument, tagName);
    },
  };
  ownerDocument.defaultView = {
    AbortController,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLButtonElement: FakeButtonElement,
    HTMLSelectElement: FakeSelectElement,
    Node: FakeNode,
  };
  return ownerDocument;
}

/** Build a var inventory whose entries mimic exported genes. */
function exportedGenes(...keys) {
  return keys.map(key => ({ key, kind: 'continuous' }));
}

function userDefinedGene(key) {
  return {
    key,
    kind: 'continuous',
    _isUserDefined: true,
    _fieldSource: FieldSource.VAR,
    _userDefinedId: `user:${key}`,
  };
}

function mountGeneSelector(varFields) {
  const ownerDocument = createFakeDocument();
  const dom = {
    geneContainer: ownerDocument.createElement('div'),
    geneSearch: ownerDocument.createElement('input'),
    geneDropdown: ownerDocument.createElement('div'),
    geneCopyBtn: ownerDocument.createElement('button'),
    geneRenameBtn: ownerDocument.createElement('button'),
    geneDeleteBtn: ownerDocument.createElement('button'),
    geneClearBtn: ownerDocument.createElement('button'),
  };
  const obsDom = {
    categoricalSelect: ownerDocument.createElement('select'),
    continuousSelect: ownerDocument.createElement('select'),
  };
  const state = {
    activeFieldSource: null,
    activeVarFieldIndex: -1,
    duplicateField() {
      throw new Error('not exercised');
    },
    ensureVarFieldLoaded() {
      throw new Error('not exercised');
    },
    getDatasetGeneration: () => 1,
    getVarFields: () => varFields,
    getVisibleFields: source => {
      assert.equal(source, FieldSource.VAR);
      return varFields
        .map((field, index) => ({ field, index }))
        .filter(({ field }) => field._isDeleted !== true);
    },
    setActiveVarField() {
      throw new Error('not exercised');
    },
  };
  const interactionOwner = {
    assertCurrent() {},
    isCurrent: () => true,
    isSuspended: () => false,
    run: worker => worker({ signal: new AbortController().signal }),
    track() {},
  };
  const api = initGeneExpressionSelector({
    state,
    interactionOwner,
    dom,
    obsDom,
    noneFieldValue: '-1',
    callbacks: {
      onActiveFieldChanged() {},
      onStartFieldRename() {},
      onStartFieldDelete() {},
      onBusyChanged() {},
      onActivateField: async () => null,
    },
  });
  api.initGeneExpressionDropdown();
  return { api, dom, obsDom };
}

function search(dom, query) {
  dom.geneSearch.value = query;
  dom.geneSearch.dispatch('input');
}

/** The one empty-state node the dropdown publishes, or null. */
function emptyState(dom) {
  return dom.geneDropdown.querySelector('.dropdown-no-results');
}

/** The persistent status region the selector owns, or null. */
function statusRegion(dom) {
  for (const child of dom.geneContainer.children) {
    if (child.getAttribute('role') === 'status') return child;
  }
  return null;
}

test('a gene search with no match explains the dataset gene panel', () => {
  const { dom } = mountGeneSelector(
    exportedGenes('GAPDH', 'ACTB', 'CD3E', 'MS4A1', 'NKG7', 'LYZ')
  );

  search(dom, 'EGFR');

  const state = emptyState(dom);
  assert.notEqual(state, null, 'a no-match search must render one empty state');
  const text = state.readText();

  // It names the query the reader typed, on a line that can never widen the
  // sidebar however long the query is.
  assert.match(text, /No gene matches “EGFR”\./);
  const echo = state.querySelector('.truncate');
  assert.notEqual(echo, null, 'the echoed query must be truncatable');
  assert.equal(echo.textContent, '“EGFR”.');
  // It states, exactly, how many gene names this dataset publishes.
  assert.match(
    text,
    new RegExp(`This dataset publishes ${(6).toLocaleString()} gene names`)
  );
  // It says the panel is decided upstream, at preparation time.
  assert.match(text, /chosen when it was prepared/);
  assert.match(text, /possibly a subset of the source data/);
  // It offers the other cause it cannot rule out, and claims neither.
  assert.match(text, /Check for typos too\./);

  // It points at the documentation that carries the full explanation.
  const link = dom.geneDropdown.querySelector('.text-link');
  assert.notEqual(link, null, 'the empty state must link to the explanation');
  assert.equal(link.tagName, 'A');
  assert.equal(
    link.href,
    'https://cellucid.readthedocs.io/en/latest/user_guide/web_app/'
      + 'd_fields_coloring_legends/05_troubleshooting_fields_legends.html'
      + '#symptom-gene-search-returns-nothing-enter-selects-the-wrong-gene'
  );
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
});

test('the empty state never claims to know that a gene was removed', () => {
  const { dom } = mountGeneSelector(exportedGenes('GAPDH', 'ACTB'));

  search(dom, 'EGFR');

  const text = emptyState(dom).readText().toLowerCase();
  for (const forbidden of [
    'was removed',
    'were removed',
    'was dropped',
    'were dropped',
    'excluded',
    'filtered out',
    'unnamed',
    'no symbol',
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `the empty state must not claim "${forbidden}" — the app cannot know it`
    );
  }
});

test('the published gene count counts exported genes only', () => {
  const { dom } = mountGeneSelector([
    ...exportedGenes('GAPDH', 'ACTB', 'CD3E'),
    userDefinedGene('CD3E (copy)'),
  ]);

  search(dom, 'EGFR');

  const text = emptyState(dom).readText();
  assert.match(
    text,
    new RegExp(`This dataset publishes ${(3).toLocaleString()} gene names`)
  );
});

test('a matching gene search publishes results and no empty state', () => {
  const { dom } = mountGeneSelector(
    exportedGenes('GAPDH', 'ACTB', 'CD3E', 'MS4A1', 'NKG7', 'LYZ')
  );

  search(dom, 'CD3');

  assert.equal(emptyState(dom), null, 'a matching search has no empty state');
  const items = dom.geneDropdown.children.filter(
    child => child.classList.contains('dropdown-item')
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].textContent, 'CD3E');
  assert.equal(
    dom.geneDropdown.readText().includes('This dataset publishes'),
    false,
    'the gene panel note must not follow the reader into a matching search'
  );
});

test('the empty state is announced through one persistent status region', () => {
  const { dom, api } = mountGeneSelector(
    exportedGenes('GAPDH', 'ACTB', 'CD3E', 'MS4A1', 'NKG7', 'LYZ')
  );

  // The region exists before any search, so a screen reader is already
  // observing it when the empty state first appears.
  const region = statusRegion(dom);
  assert.notEqual(region, null, 'the selector must own one status region');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.classList.contains('sr-only'), true);
  assert.equal(region.textContent, '');

  search(dom, 'EGFR');
  assert.equal(statusRegion(dom), region, 'the region must not be recreated');
  assert.match(region.textContent, /No gene matches your search/);
  assert.match(
    region.textContent,
    new RegExp(`This dataset publishes ${(6).toLocaleString()} gene names`)
  );

  // The announcement is query-independent, so extending a no-match query does
  // not re-announce the same explanation on every keystroke.
  const announced = region.textContent;
  search(dom, 'EGFR1');
  assert.equal(region.textContent, announced);

  // A matching search clears it, so the next no-match announces again.
  search(dom, 'CD3');
  assert.equal(region.textContent, '');

  api.destroy();
  assert.equal(statusRegion(dom), null, 'destroy must release the region');
});
