/**
 * A gene expression selector (`ui/modules/field-selector-gene-expression.js`)
 * mounted on an exact DOM stand-in, for node contract tests: the gene search
 * as a person types, pastes and presses Enter in it.
 */
import assert from 'node:assert/strict';

import {
  initGeneExpressionSelector,
} from '../../assets/js/app/ui/modules/field-selector-gene-expression.js';
import { FieldSource } from '../../assets/js/app/utils/field-constants.js';
import { getActions } from '../../assets/js/app/actions/index.js';
import { abortReason, cancelled, onAbort } from '../../assets/js/utils/abort.js';
import { resolveField } from '../../assets/js/app/actions/targets/fields.js';

/** The `color.by` implementation of the selector mounted last (the field selector's, for a gene). */
let removeColorBy = null;

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

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index === -1) throw new Error('reference node is not a child');
    const nodes = child instanceof FakeFragment ? [...child.children] : [child];
    if (child instanceof FakeFragment) child.children = [];
    for (const node of nodes) node.parentNode = this;
    this.children.splice(index, 0, ...nodes);
    return child;
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

  removeAttribute(name) {
    this.attributes.delete(name);
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

  /** As a browser's: leaving the box fires `blur` on it. */
  blur() {
    this.dispatch('blur', { relatedTarget: null });
  }
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

export function createFakeDocument() {
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
export function exportedGenes(...keys) {
  return keys.map(key => ({ key, kind: 'continuous' }));
}

export function userDefinedGene(key) {
  return {
    key,
    kind: 'continuous',
    _isUserDefined: true,
    _fieldSource: FieldSource.VAR,
    _userDefinedId: `user:${key}`,
  };
}

/**
 * Mount the selector on `varFields`.
 *
 * @param {object[]} varFields
 * @param {{
 *   onLoad?: ((index: number, options: object) => (Promise<unknown>|void))|null,
 *   geneNames?: object|null,
 *   listing?: {pending: boolean, failure: Error|null},
 *   state?: object,
 *   interactionOwner?: object|null,
 *   generation?: () => number,
 * }} [options] - `onLoad` answers each gene load (held pending unless it
 *   returns a Promise); `state` adds to or replaces the state stand-in's
 *   members; `interactionOwner` replaces the always-current stand-in (a real
 *   `createFieldInteractionOwner()`); `generation` is the dataset generation.
 */
export function mountGeneSelector(varFields, {
  onLoad = null,
  geneNames = null,
  listing = { pending: false, failure: null },
  state: stateOverrides = {},
  interactionOwner: ownerOverride = null,
  generation = () => 1,
} = {}) {
  const chooseGeneNames = { count: 0 };
  const shown = [];
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
    varData: geneNames === null ? null : { fields: varFields, geneNames },
    duplicateField() {
      throw new Error('not exercised');
    },
    ensureVarFieldLoaded(index, options) {
      if (onLoad === null) throw new Error('not exercised');
      const answer = onLoad(index, options);
      // Held pending unless answered: a test may assert only which gene was
      // chosen, not the load. Like every load, it ends when its signal aborts
      // (a newer choice, the action superseded).
      return answer instanceof Promise
        ? answer
        : new Promise((_resolve, reject) => onAbort(options.signal, () => reject(abortReason(options.signal))));
    },
    getDatasetGeneration: generation,
    // The gene list of a dataset just shown is read after its first view
    // (`DataState.listPublishedGenes`).
    areGenesPending: () => listing.pending,
    getGeneListFailure: () => listing.failure,
    getVarFields: () => varFields,
    getVisibleFields: source => {
      assert.equal(source, FieldSource.VAR);
      return varFields
        .map((field, index) => ({ field, index }))
        .filter(({ field }) => field._isDeleted !== true);
    },
    // A list replaced (Data mapping) carries each gene to its new field;
    // a test that replaces the list says where (`successors`).
    successors: new Map(),
    locateVarField(field) {
      for (let current = field; current !== undefined; current = state.successors.get(current)) {
        const index = varFields.indexOf(current);
        if (index >= 0) return index;
      }
      return -1;
    },
    setActiveVarField(index) {
      state.activeFieldSource = FieldSource.VAR;
      state.activeVarFieldIndex = index;
      return { field: varFields[index], pointCount: 0, centroidInfo: '' };
    },
    ...stateOverrides,
  };
  // As the field interaction owner: the latest choice is current, and the
  // action's signal, aborted, supersedes it.
  let current = null;
  const interactionOwner = ownerOverride ?? {
    assertCurrent(token) {
      if (token !== current || token.signal.aborted) throw cancelled('superseded', 'Field interaction was superseded by a newer intent.');
    },
    isCurrent: token => token === current && !token.signal.aborted,
    isSuspended: () => false,
    retirementOf: () => null,
    run: (worker, { signal = null } = {}) => {
      const controller = new AbortController();
      onAbort(signal, () => controller.abort(cancelled('superseded', 'Field interaction was superseded by a newer intent.')));
      const token = { signal: controller.signal };
      current = token;
      return worker(token);
    },
    suspensionReason: () => null,
    track() {},
  };
  const api = initGeneExpressionSelector({
    state,
    interactionOwner,
    dom,
    obsDom,
    noneFieldValue: '-1',
    callbacks: {
      onActiveFieldChanged(info) { shown.push(info.field.key); },
      onStartFieldRename() {},
      onStartFieldDelete() {},
      onBusyChanged() {},
      onActivateField: async () => null,
      onAdoptDatasetGeneration: () => state.getDatasetGeneration(),
      onChooseGeneNames() { chooseGeneNames.count++; },
      onDuplicateField() {},
      onClearColoring() {},
    },
  });
  // A gene chosen here is the action color.by, implemented as the field
  // selector implements it for a gene: the gene by name, then this choice.
  removeColorBy?.();
  removeColorBy = getActions().provide('color.by', async ({ field }, { signal }) => {
    if (field === null) return null;
    const info = await api.selectGene(resolveField(state, field).index, { signal });
    return info === null ? null : { field: field.key, source: field.source, kind: 'continuous' };
  });
  api.initGeneExpressionDropdown();
  return { api, dom, obsDom, listing, chooseGeneNames, state, shown };
}

/** Type `query` into the search box, as a keystroke or a paste does. */
export function search(dom, query) {
  dom.geneSearch.value = query;
  dom.geneSearch.dispatch('input');
}

/** Press `key` in the search box; whether the selector took it (`preventDefault`). */
export function press(dom, key) {
  let prevented = false;
  dom.geneSearch.dispatch('keydown', { key, preventDefault() { prevented = true; } });
  return prevented;
}

/** Let the turns a choice takes before it reads its gene pass. */
export function settleTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

/** The one empty-state node the dropdown publishes, or null. */
export function emptyState(dom) {
  return dom.geneDropdown.querySelector('.dropdown-no-results');
}

/** The persistent status region the selector owns, or null. */
export function statusRegion(dom) {
  for (const child of dom.geneContainer.children) {
    if (child.getAttribute('role') === 'status') return child;
  }
  return null;
}
