/**
 * The data mapping, from DataState to the interface: the representation
 * transaction (`state/managers/mapping-manager.js`) that enables any number of
 * embeddings and names each dimension's default, the Embeddings checklist that
 * stages it (`ui/modules/data-mapping-controls.js`), the best-guess
 * notification and the notification action it uses, the analytics it may
 * send, the session inventory it stays out of, and a figure export of views
 * that show different embeddings.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  EmbeddingLoadError,
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';
import {
  DEFAULT_UMAP_KEYS_TEXT,
  describeBestGuess,
  initDataMappingControls,
} from '../assets/js/app/ui/modules/data-mapping-controls.js';
import {
  DIMENSIONAL_UMAP_KEYS,
  UNSUFFIXED_UMAP_KEY,
  defaultEmbeddingSlots,
} from '../assets/js/data/data-mapping.js';
import { NotificationCenter } from '../assets/js/app/notification-center.js';
import {
  EMBEDDING_CANDIDATE_BUCKETS,
  FEATURES,
  embeddingCandidateBucket,
  validateEvent,
} from '../assets/js/analytics/schema.js';
import { createFigureExportEngine } from '../assets/js/app/ui/modules/figure-export/figure-export-engine.js';
import { installDataMappingMethods } from './helpers/data-mapping-state.mjs';
import { mappingProbes } from './helpers/anndata-mapping-mocks.mjs';

const N_OBS = 4;

const UMAP = Object.freeze({ key: 'X_umap', columns: [0, 1] });
const TSNE = Object.freeze({ key: 'X_tsne', columns: [0, 1] });

function anndataMapping({ enabled, defaults }) {
  return {
    kind: 'anndata',
    embeddings: {
      enabled,
      defaults: { '1d': null, '2d': null, '3d': null, ...defaults },
    },
    knn: null,
    geneNames: 'index',
    expression: 'X',
    latent: null,
    vectorFields: [{ key: 'velocity_umap', embedding: UMAP }],
  };
}

/**
 * A DataState stand-in with the real mapping methods, a real DimensionManager
 * and the one view transaction the mapping drives, reduced to what these
 * tests observe: a view shows one enabled layout, and records whether it
 * follows its dimension's default.
 *
 * The dataset is an AnnData file whose obsm holds X_umap (2 columns, the 2D
 * default), X_tsne (2), X_pca (6) and a UMAP vector field. Three views: the
 * live view and snapshot-1 show UMAP because it is the 2D default;
 * snapshot-2 shows t-SNE because the user chose it.
 */
function makeMappingState({ failLoads = {}, failMoveFor = null } = {}) {
  const described = describeAnnDataProbes(mappingProbes({
    nObs: N_OBS,
    obsm: { X_umap: 2, X_tsne: 2, X_pca: 6, velocity_umap: 2 },
    hasX: true,
  }));
  const candidates = assembleAnnDataCandidates(described, {
    slots: { '1d': null, '2d': UMAP, '3d': null },
    guessed: [],
  });
  const manager = new DimensionManager();
  manager.registerLayouts([{
    layoutKey: 'X_umap',
    dimension: 2,
    label: 'X_umap',
    path: 'obsm/0/0-1',
    provenance: { key: 'X_umap', columns: [0, 1] },
    origin: 'identity',
  }]);
  manager.setLayoutProvider(createMappingLayoutProvider(candidates));
  const loads = [];
  manager.getPositions = async layoutKey => {
    loads.push(layoutKey);
    const layout = manager.getLayout(layoutKey);
    if (Object.hasOwn(failLoads, layout.provenance.key)) {
      throw new EmbeddingLoadError(
        layout.provenance.key,
        layout.provenance.columns,
        failLoads[layout.provenance.key]
      );
    }
    return new Float32Array(N_OBS * layout.dimension);
  };

  const events = [];
  const moves = [];
  const state = {
    dimensionManager: manager,
    viewContexts: new Map([
      ['live', { id: 'live', followsDefault: true }],
      ['snapshot-1', { id: 'snapshot-1', followsDefault: true }],
      ['snapshot-2', { id: 'snapshot-2', followsDefault: false }],
    ]),
    emit(name, payload) {
      events.push([name, payload]);
    },
    on() {
      return () => {};
    },
    getDimensionManager() {
      return manager;
    },
    getViewLayoutKey(viewId) {
      return manager.getViewLayout(viewId);
    },
    viewFollowsDefault(viewId) {
      return this.viewContexts.get(viewId).followsDefault;
    },
    async setViewRepresentation(viewId, layoutKey, { followsDefault }) {
      if (viewId === failMoveFor) {
        throw new Error(`moving ${viewId} failed`);
      }
      // The real transaction refuses a layout the mapping does not enable;
      // the stand-in does too, so the order of publication is under test.
      if (!manager.isEnabled(layoutKey)) {
        throw new RangeError(`${layoutKey} is not enabled for this dataset.`);
      }
      manager.setViewLayout(viewId, layoutKey);
      this.viewContexts.get(viewId).followsDefault = followsDefault;
      moves.push([viewId, layoutKey, followsDefault]);
    },
  };
  installDataMappingMethods(state, { mapping: null });
  state.publishDatasetMapping({ mapping: candidates.defaults, candidates, origin: 'default' });
  manager.setViewLayout('live', 'X_umap');
  manager.setViewLayout('snapshot-1', 'X_umap');
  manager.setViewLayout('snapshot-2', manager.resolveRepresentation(TSNE));
  return { state, manager, loads, events, moves, candidates };
}

test('a dataset opens with its best-guess slots and every narrow array enabled', () => {
  const { state, manager, candidates } = makeMappingState();
  // The catalog states the mapping the file opens on.
  assert.deepEqual(candidates.defaults.embeddings, {
    enabled: [TSNE, UMAP],
    defaults: { '1d': null, '2d': UMAP, '3d': null },
  });
  // Publishing it hands the enabled set and the defaults to the registry,
  // registering the AnnData layouts on demand (metadata only).
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_tsne', 'X_umap']);
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.equal(manager.getLayout('X_tsne').origin, 'mapping');
  assert.deepEqual(
    state.getEnabledRepresentations().map(item => [item.layoutKey, item.name, item.dimension, item.isDefault]),
    // Within a dimension, its default first, then the mapping's order.
    [['X_umap', 'UMAP', 2, true], ['X_tsne', 't-SNE', 2, false]],
  );
  // The checklist offers every plottable array, enabled or not; a wide array
  // it has not enabled is proposed at its first three columns, and a vector
  // field is never an embedding.
  assert.deepEqual(
    state.getRepresentationChoices().map(choice => [
      choice.ref.key, choice.ref.columns, choice.name, choice.dimension, choice.width,
      choice.enabled, choice.isDefault, choice.usable,
    ]),
    [
      ['X_umap', [0, 1], 'UMAP', 2, 2, true, true, true],
      ['X_tsne', [0, 1], 't-SNE', 2, 2, true, false, true],
      ['X_pca', [0, 1, 2], 'PCA 1,2,3', 3, 6, false, false, true],
    ],
  );
  assert.deepEqual(state.describeViewEmbedding('snapshot-2'), {
    dimension: 2,
    name: 't-SNE',
    label: 'X_tsne',
    layoutKey: 'X_tsne',
    isDefault: false,
  });
  assert.deepEqual(state.getViewEmbeddingRef('snapshot-2'), TSNE);
  assert.equal(state.canMapAnyEmbedding(), true);
  assert.deepEqual(state.getMappingAnalytics(), {
    origin: 'default',
    embeddingCandidates: 3,
    enabledRepresentations: 2,
    vectorFields: 1,
  });
});

test('changing a default loads it first, then moves only the views that follow it', async () => {
  const { state, manager, loads, events, moves } = makeMappingState();
  const pca = { key: 'X_pca', columns: [3, 1] };
  const next = anndataMapping({ enabled: [pca, TSNE, UMAP], defaults: { '2d': pca } });
  assert.equal(state.describeDataMappingRefusal(next), null);
  assert.equal(state.previewRepresentationMoves(next), 2);

  assert.equal(await state.applyDataMapping(next, { origin: 'user' }), true);
  assert.deepEqual(loads, ['X_pca[3,1]'], 'only the layout views move to is loaded');
  assert.equal(manager.getLayout('X_pca[3,1]').origin, 'mapping');
  assert.equal(
    manager.getLayout('X_pca[3,1]').path,
    'obsm/2/3-1'
  );
  assert.equal(manager.getDefaultLayout(2), 'X_pca[3,1]');
  assert.deepEqual(moves, [['live', 'X_pca[3,1]', true], ['snapshot-1', 'X_pca[3,1]', true]]);
  // A view the user put on an embedding keeps it.
  assert.equal(manager.getViewLayout('snapshot-2'), 'X_tsne');
  assert.deepEqual(state.getDataMapping(), next);
  assert.equal(state.getDataMappingOrigin(), 'user');
  assert.deepEqual(events.map(([name]) => name), ['mapping:changed', 'representations:changed']);
  assert.deepEqual(events[0][1], { mapping: state.getDataMapping(), cause: 'apply', origin: 'user' });
  assert.deepEqual(
    events[1][1].enabled.map(item => item.layoutKey),
    ['X_pca[3,1]', 'X_tsne', 'X_umap'],
  );

  // The same mapping again changes nothing and announces nothing.
  assert.equal(await state.applyDataMapping(next, { origin: 'user' }), false);
  assert.equal(events.length, 2);
});

test('enabling a representation loads nothing and moves no view', async () => {
  const { state, manager, loads, moves } = makeMappingState();
  const pca3 = { key: 'X_pca', columns: [0, 1, 2] };
  const next = anndataMapping({ enabled: [pca3, TSNE, UMAP], defaults: { '2d': UMAP } });
  assert.equal(state.previewRepresentationMoves(next), 0);
  assert.equal(await state.applyDataMapping(next, { origin: 'user' }), true);
  assert.deepEqual(loads, []);
  assert.deepEqual(moves, []);
  assert.equal(manager.isEnabled('X_pca[0,1,2]'), true);
  // 3D is offered now; without a default it opens on its first one.
  assert.deepEqual(manager.getAvailableDimensions(), [2, 3]);
  assert.equal(manager.getDefaultLayout(3), null);
  assert.equal(manager.getOpeningLayout(3), 'X_pca[0,1,2]');
});

test('a view showing a representation that is turned off moves to its dimension\'s default', async () => {
  const { state, manager, moves } = makeMappingState();
  const next = anndataMapping({ enabled: [UMAP], defaults: { '2d': UMAP } });
  assert.equal(state.previewRepresentationMoves(next), 1);
  assert.equal(await state.applyDataMapping(next, { origin: 'user' }), true);
  assert.deepEqual(moves, [['snapshot-2', 'X_umap', true]]);
  assert.equal(manager.isEnabled('X_tsne'), false);
  assert.equal(state.viewFollowsDefault('snapshot-2'), true);
});

test('an embedding that fails its load check changes nothing and stays unusable', async () => {
  const { state, manager, moves } = makeMappingState({ failLoads: { X_pca: 'NaN at cell 2' } });
  const pca = { key: 'X_pca', columns: [0, 1] };
  const next = anndataMapping({ enabled: [pca, TSNE, UMAP], defaults: { '2d': pca } });
  await assert.rejects(
    state.applyDataMapping(next, { origin: 'user' }),
    error => error instanceof EmbeddingLoadError && error.reason === 'NaN at cell 2'
  );
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_tsne', 'X_umap']);
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.deepEqual(moves, []);
  assert.deepEqual(state.getDataMapping().embeddings.defaults['2d'], UMAP);
  assert.equal(state.getEmbeddingUnusableReason('X_pca'), 'NaN at cell 2');
  assert.equal(
    state.describeEmbeddingRefusal({ key: 'X_pca', columns: [2, 3] }),
    'this dataset cannot plot (NaN at cell 2)'
  );
  assert.equal(
    state.describeDataMappingRefusal(next),
    'X_pca is enabled, but this dataset cannot plot (NaN at cell 2).'
  );
  const pcaChoice = state.getRepresentationChoices().find(choice => choice.ref.key === 'X_pca');
  assert.deepEqual([pcaChoice.usable, pcaChoice.reason], [false, 'NaN at cell 2']);
});

test('a failure while moving views restores the previous representations and views', async () => {
  const { state, manager } = makeMappingState({ failMoveFor: 'snapshot-1' });
  await assert.rejects(
    state.applyDataMapping(
      anndataMapping({ enabled: [TSNE, UMAP], defaults: { '2d': TSNE } }),
      { origin: 'user' }
    ),
    /moving snapshot-1 failed/
  );
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_tsne', 'X_umap']);
  assert.equal(manager.getViewLayout('live'), 'X_umap');
  assert.equal(state.viewFollowsDefault('live'), true);
  assert.equal(manager.getViewLayout('snapshot-1'), 'X_umap');
  assert.deepEqual(state.getDataMapping().embeddings.defaults['2d'], UMAP);
});

test('a mapping the panel cannot apply is refused with its reason', async () => {
  const { state } = makeMappingState();
  const base = state.getDataMapping();
  assert.equal(
    state.describeDataMappingRefusal({ ...base, knn: 'connectivities' }),
    "This mapping uses obsp['connectivities'] as its neighbour graph, which this dataset does not have."
  );
  // Every other group is checked against the catalog the same way.
  assert.equal(state.describeDataMappingRefusal({ ...base, latent: 'X_pca' }), null);
  assert.equal(
    state.describeDataMappingRefusal({ ...base, latent: 'X_missing' }),
    "This mapping uses obsm['X_missing'] as its latent space, which this dataset does not have."
  );
  assert.equal(
    state.describeDataMappingRefusal(anndataMapping({
      enabled: [{ key: 'X_gone', columns: [0, 1] }, UMAP],
      defaults: { '2d': UMAP },
    })),
    'X_gone is enabled, but this dataset does not have.'
  );
  assert.match(
    state.describeDataMappingRefusal(anndataMapping({
      enabled: [{ key: 'X_tsne', columns: [0, 1, 2] }, UMAP],
      defaults: { '2d': UMAP },
    })),
    /^X_tsne is enabled, but this dataset cannot plot \(obsm\['X_tsne'\]: .*\)\.$/
  );
  assert.equal(
    state.describeEmbeddingRefusal({ key: 'X_gone', columns: [0, 1] }),
    'this dataset does not have'
  );
  // The shape itself is validated before any of this: nothing enabled, no
  // default, a default that is not enabled, a vector field bound to an
  // embedding that is off.
  for (const [mapping, code] of [
    [anndataMapping({ enabled: [], defaults: { '2d': UMAP } }), 'no_embedding'],
    [anndataMapping({ enabled: [UMAP], defaults: {} }), 'no_embedding'],
    [anndataMapping({ enabled: [UMAP], defaults: { '2d': TSNE } }), 'default_not_enabled'],
    [anndataMapping({ enabled: [TSNE], defaults: { '2d': TSNE } }), 'vector_not_enabled'],
  ]) {
    await assert.rejects(
      state.applyDataMapping(mapping, { origin: 'user' }),
      error => error.code === code
    );
  }
});

test('the best-guess notification names every key of the default embedding rule', () => {
  // The rule fills a dimension from X_umap_1d, X_umap_2d or X_umap_3d, and
  // otherwise from a bare X_umap: the message lists exactly those keys.
  assert.deepEqual([...DIMENSIONAL_UMAP_KEYS], ['X_umap_1d', 'X_umap_2d', 'X_umap_3d']);
  assert.equal(UNSUFFIXED_UMAP_KEY, 'X_umap');
  assert.equal(DEFAULT_UMAP_KEYS_TEXT, 'X_umap_1d, X_umap_2d, X_umap_3d or X_umap');
  for (const key of [...DIMENSIONAL_UMAP_KEYS, UNSUFFIXED_UMAP_KEY]) {
    const slots = defaultEmbeddingSlots([{ key, width: key === 'X_umap' ? 2 : Number(key.at(-2)) }]);
    assert.notEqual(
      Object.values(slots).find(ref => ref !== null),
      undefined,
      `${key} fills a slot by the default rule`
    );
    assert.ok(DEFAULT_UMAP_KEYS_TEXT.split(/, | or /).includes(key), `${key} is named`);
  }
});

test('the best-guess notification names what is shown and where to change it', () => {
  const widths = { X_tsne: 2, X_pca: 50, X_draw_graph_fa: 3 };
  const widthOf = key => widths[key] ?? null;
  assert.equal(
    describeBestGuess(
      anndataMapping({ enabled: [TSNE], defaults: { '2d': TSNE } }),
      ['embeddings.2d'], widthOf
    ),
    "This file has no default UMAP (X_umap_1d, X_umap_2d, X_umap_3d or X_umap). Showing 'X_tsne' as 2D. "
      + 'Change it under Session › Data mapping.'
  );
  const pca = { key: 'X_pca', columns: [0, 1] };
  assert.equal(
    describeBestGuess(
      anndataMapping({ enabled: [pca], defaults: { '2d': pca } }),
      ['embeddings.2d'], widthOf
    ),
    "This file has no default UMAP (X_umap_1d, X_umap_2d, X_umap_3d or X_umap). Showing columns 0 and 1 of 'X_pca' as 2D. "
      + 'Change it under Session › Data mapping.'
  );
  const fa = { key: 'X_draw_graph_fa', columns: [0, 1, 2] };
  assert.match(
    describeBestGuess(
      anndataMapping({ enabled: [fa, TSNE], defaults: { '2d': TSNE, '3d': fa } }),
      ['embeddings.2d', 'embeddings.3d'], widthOf
    ),
    /Showing 'X_draw_graph_fa' as 3D and 'X_tsne' as 2D\./
  );
});

/* -------------------------------------------------------------------------- *
 * The Embeddings checklist, driven through a DOM small enough to read.       *
 * -------------------------------------------------------------------------- */

class FakeNode {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.id = '';
  }

  get classList() {
    const owner = this;
    const names = () => owner.className.split(/\s+/).filter(Boolean);
    return {
      contains: name => names().includes(name),
      add(...added) {
        owner.className = [...new Set([...names(), ...added])].join(' ');
      },
      remove(...removed) {
        owner.className = names().filter(name => !removed.includes(name)).join(' ');
      },
    };
  }

  set innerHTML(html) {
    this._html = html;
    this.children = [];
  }

  get innerHTML() {
    return this._html ?? '';
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(child, reference) {
    if (reference === null) return this.appendChild(child);
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }

  get isConnected() {
    let node = this;
    while (node.parentElement !== null) node = node.parentElement;
    return node === this.ownerDocument.body;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
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

  addEventListener(type, listener, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, signal: options?.signal ?? null });
  }

  /** Dispatch a bubbling event from this node. */
  dispatch(type) {
    const event = { type, target: this };
    for (let node = this; node !== null; node = node.parentElement) {
      for (const { listener, signal } of node.listeners.get(type) ?? []) {
        if (signal?.aborted) continue;
        listener({ ...event, currentTarget: node });
      }
    }
  }

  matches(selector) {
    return selector.startsWith('.') && this.classList.contains(selector.slice(1));
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parentElement) {
      if (node.matches?.(selector)) return node;
    }
    return null;
  }

  *walk() {
    for (const child of this.children) {
      if (!(child instanceof FakeNode)) continue;
      yield child;
      yield* child.walk();
    }
  }

  querySelector(selector) {
    for (const node of this.walk()) if (node.matches(selector)) return node;
    return null;
  }

  querySelectorAll(selector) {
    return [...this.walk()].filter(node => node.matches(selector));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView() {}
}

class FakeInput extends FakeNode {}
class FakeSelect extends FakeNode {}
class FakeButton extends FakeNode {}

function installDom(t) {
  const names = ['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement',
    'HTMLDetailsElement', 'Element', 'document'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
  });
  const ownerDocument = {
    activeElement: null,
    defaultView: { matchMedia: () => ({ matches: false }) },
    body: null,
    createElement(tagName) {
      const Type = { input: FakeInput, select: FakeSelect, button: FakeButton }[tagName] ?? FakeNode;
      return new Type(ownerDocument, tagName);
    },
    createTextNode(text) {
      return { textContent: text, parentElement: null };
    },
    getElementById(id) {
      for (const node of ownerDocument.body.walk()) if (node.id === id) return node;
      return null;
    },
  };
  ownerDocument.body = new FakeNode(ownerDocument, 'body');
  globalThis.HTMLElement = FakeNode;
  globalThis.Element = FakeNode;
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLSelectElement = FakeSelect;
  globalThis.HTMLButtonElement = FakeButton;
  globalThis.HTMLDetailsElement = class FakeDetails extends FakeNode {};
  globalThis.document = ownerDocument;
  const root = ownerDocument.createElement('div');
  ownerDocument.body.appendChild(root);
  return { ownerDocument, root };
}

function mountPanel(t, options) {
  const { root } = installDom(t);
  const scene = makeMappingState(options);
  const applied = [];
  const realApply = scene.state.applyDataMapping.bind(scene.state);
  scene.state.applyDataMapping = async (next, applyOptions) => {
    applied.push(structuredClone(next));
    return realApply(next, applyOptions);
  };
  const controls = initDataMappingControls({ state: scene.state, root });
  t.after(() => controls.destroy());
  const rows = () => root.querySelector('.data-mapping-list').children
    .filter(node => node.matches('.data-mapping-row'))
    .map(row => ({
      name: row.querySelector('.data-mapping-name').textContent,
      enabled: row.querySelector('.data-mapping-enable').checked,
      enableDisabled: row.querySelector('.data-mapping-enable').disabled,
      enableTitle: row.querySelector('.data-mapping-enable').title,
      dimension: row.querySelector('.data-mapping-dim')?.textContent ?? null,
      isDefault: row.querySelector('.data-mapping-default')?.getAttribute('aria-pressed') ?? null,
      // The editor's dimension, then the column of each axis it shows.
      columns: row.querySelector('.data-mapping-editor') === null
        ? null
        : [
            row.querySelector('.data-mapping-axes').value,
            ...row.querySelectorAll('.data-mapping-axis-field')
              .filter(field => !field.hidden)
              .map(field => field.querySelector('.obs-select').value),
          ],
    }));
  const row = name => root.querySelector('.data-mapping-list').children
    .find(node => node.matches('.data-mapping-row')
      && node.querySelector('.data-mapping-name').textContent === name);
  const status = () => root.querySelector('.data-mapping-status');
  const apply = root.querySelector('#data-mapping-apply') ?? [...root.walk()].find(node => node.id === 'data-mapping-apply');
  const revert = [...root.walk()].find(node => node.id === 'data-mapping-revert');
  return { ...scene, applied, controls, root, rows, row, status, apply, revert };
}

test('the checklist lists every representation, its dimension, its default and why a box is locked', t => {
  const panel = mountPanel(t);
  // Listed like the picker: highest dimension first, each dimension's
  // default first, then by name.
  assert.deepEqual(panel.rows(), [
    {
      name: 'PCA 1,2,3', enabled: false, enableDisabled: false,
      enableTitle: 'Offer PCA 1,2,3 to views',
      // A selection of a wider array names its axis count and its columns.
      dimension: '3D', isDefault: 'false', columns: ['3', '0', '1', '2'],
    },
    {
      name: 'UMAP', enabled: true, enableDisabled: true,
      enableTitle: 'A vector field is drawn on this embedding, so it stays on.',
      // A 2-column array, too, can be shown in another dimension.
      dimension: '2D', isDefault: 'true', columns: ['2', '0', '1'],
    },
    {
      name: 't-SNE', enabled: true, enableDisabled: false,
      enableTitle: 'Stop offering t-SNE to views',
      dimension: '2D', isDefault: 'false', columns: ['2', '0', '1'],
    },
  ]);
  // A wide array can be enabled at further column selections.
  const add = panel.root.querySelector('.data-mapping-add');
  assert.equal(add.textContent, 'Add columns');
  assert.equal(add.getAttribute('aria-label'), 'Add columns of PCA');
  // Only a wide array offers it; it is in the row's editor, closed at first.
  assert.equal(panel.root.querySelectorAll('.data-mapping-add').filter(node => !node.hidden).length, 1);
  assert.equal(panel.row('PCA 1,2,3').querySelector('.data-mapping-editor').hidden, true);
  assert.equal(add.dataset.key, 'X_pca');
  assert.equal(panel.root.querySelector('.disclosure-desc').textContent, '2 on · UMAP 2D');
  // Nothing staged: nothing to apply or revert, and each says why.
  assert.equal(panel.apply.disabled, true);
  assert.equal(panel.apply.title, 'Change something above first.');
  assert.equal(panel.revert.disabled, true);
  assert.equal(panel.status().textContent, '');
});

test('turning a representation off stages its views\' move to the default, and Revert drops it', t => {
  const panel = mountPanel(t);
  const tsne = panel.row('t-SNE').querySelector('.data-mapping-enable');
  tsne.checked = false;
  tsne.dispatch('change');
  assert.equal(panel.status().textContent, 'Apply also switches 1 view to the new default.');
  assert.equal(panel.apply.disabled, false);
  assert.equal(panel.revert.disabled, false);
  // UMAP is now the last one on: it cannot be turned off too.
  assert.equal(
    panel.row('UMAP').querySelector('.data-mapping-enable').title,
    'A vector field is drawn on this embedding, so it stays on.'
  );

  panel.revert.dispatch('click');
  assert.equal(panel.row('t-SNE').querySelector('.data-mapping-enable').checked, true);
  assert.equal(panel.apply.disabled, true);
  assert.deepEqual(panel.applied, []);
});

test('Default makes one representation per dimension the default, and Apply moves the views that follow it', async t => {
  const panel = mountPanel(t);
  panel.row('t-SNE').querySelector('.data-mapping-default').dispatch('click');
  assert.equal(panel.row('t-SNE').querySelector('.data-mapping-default').getAttribute('aria-pressed'), 'true');
  assert.equal(panel.row('UMAP').querySelector('.data-mapping-default').getAttribute('aria-pressed'), 'false');
  assert.equal(panel.status().textContent, 'Apply also switches 2 views to the new default.');

  panel.apply.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(panel.applied.map(mapping => mapping.embeddings), [{
    enabled: [TSNE, UMAP],
    defaults: { '1d': null, '2d': TSNE, '3d': null },
  }]);
  assert.deepEqual(panel.moves, [['live', 'X_tsne', true], ['snapshot-1', 'X_tsne', true]]);
  assert.equal(panel.status().textContent, 'Applied.');
  assert.equal(panel.apply.disabled, true);
  assert.equal(panel.root.querySelector('.disclosure-desc').textContent, '2 on · t-SNE 2D');
});

test('turning a representation of a new dimension on makes it that dimension\'s default', t => {
  const panel = mountPanel(t);
  const pca = panel.row('PCA 1,2,3').querySelector('.data-mapping-enable');
  pca.checked = true;
  pca.dispatch('change');
  assert.equal(panel.row('PCA 1,2,3').querySelector('.data-mapping-default').getAttribute('aria-pressed'), 'true');
  assert.equal(panel.status().textContent, 'Apply offers these embeddings to every view.');
});

test('Add columns adds another column selection of a wide array, edited per axis and checked for repeats', async t => {
  const panel = mountPanel(t);
  panel.root.querySelector('.data-mapping-add').dispatch('click');
  // The new selection takes the first columns no selection of the array uses,
  // two of them, and is on; it is listed under the array's other selections
  // and can be removed again before Apply.
  assert.deepEqual(
    panel.rows().map(row => [row.name, row.enabled, row.dimension, row.columns]),
    [
      ['PCA 1,2,3', false, '3D', ['3', '0', '1', '2']],
      ['PCA 4,5', true, '2D', ['2', '3', '4']],
      ['UMAP', true, '2D', ['2', '0', '1']],
      ['t-SNE', true, '2D', ['2', '0', '1']],
    ],
  );
  assert.equal(panel.status().textContent, 'Apply offers these embeddings to every view.');

  // Point it at the columns another enabled row plots: refused until fixed.
  const added = panel.row('PCA 4,5');
  const pca = panel.row('PCA 1,2,3').querySelector('.data-mapping-enable');
  pca.checked = true;
  pca.dispatch('change');
  const axes = panel.row('PCA 4,5').querySelector('.data-mapping-axes');
  axes.value = '3';
  axes.dispatch('change');
  assert.ok(added);
  // A third axis takes the first column no selection of the array uses.
  assert.deepEqual(panel.rows()[1].columns, ['3', '3', '4', '5']);
  assert.equal(panel.rows()[1].name, 'PCA 4,5,6');
  for (const [axis, column] of [['x', '0'], ['y', '1'], ['z', '2']]) {
    const select = panel.row(panel.rows()[1].name)
      .querySelectorAll('.obs-select')
      .find(node => node.id.endsWith(`-${axis}`));
    select.value = column;
    select.dispatch('change');
  }
  assert.equal(panel.status().textContent, 'PCA 1,2,3 is listed twice. Remove one of them.');
  assert.equal(panel.apply.disabled, true);

  // Removing the added selection settles it; the original shows no remove
  // button, only its checkbox.
  const sameName = panel.root.querySelector('.data-mapping-list').children
    .filter(node => node.matches('.data-mapping-row')
      && node.querySelector('.data-mapping-name').textContent === 'PCA 1,2,3');
  assert.equal(sameName.length, 2);
  assert.equal(sameName[0].querySelector('.data-mapping-remove').hidden, true);
  assert.equal(sameName[1].querySelector('.data-mapping-remove').hidden, false);
  sameName[1].querySelector('.data-mapping-remove').dispatch('click');
  const remaining = panel.rows().filter(row => row.name === 'PCA 1,2,3');
  assert.equal(remaining.length, 1);
  assert.equal(panel.apply.disabled, false);
  panel.apply.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(panel.applied.at(-1).embeddings.enabled, [
    { key: 'X_pca', columns: [0, 1, 2] },
    TSNE,
    UMAP,
  ]);
  assert.deepEqual(panel.applied.at(-1).embeddings.defaults['3d'], { key: 'X_pca', columns: [0, 1, 2] });
});

test('every array of two or more columns offers each dimension its columns allow, in an editor closed until opened', async t => {
  const panel = mountPanel(t);
  const tsne = () => panel.row(panel.rows().find(row => row.name.startsWith('t-SNE')).name);
  const edit = tsne().querySelector('.data-mapping-edit');
  const editor = tsne().querySelector('.data-mapping-editor');
  assert.equal(edit.textContent, '2D');
  assert.equal(edit.getAttribute('aria-expanded'), 'false');
  assert.equal(editor.hidden, true);
  assert.equal(edit.getAttribute('aria-controls'), editor.id);
  edit.dispatch('click');
  assert.equal(edit.getAttribute('aria-expanded'), 'true');
  assert.equal(editor.hidden, false);
  // Two columns: 1D or 2D, never a third axis.
  const axes = tsne().querySelector('.data-mapping-axes');
  assert.deepEqual(axes.children.map(option => option.textContent), ['1D', '2D']);
  assert.equal(tsne().querySelector('.data-mapping-add').hidden, true);

  // 2D to 1D: t-SNE's first column, the only 1D embedding, so the 1D default.
  axes.value = '1';
  axes.dispatch('change');
  assert.deepEqual(
    panel.rows().find(row => row.name.startsWith('t-SNE')),
    {
      name: 't-SNE 1', enabled: true, enableDisabled: false,
      enableTitle: 'Stop offering t-SNE 1 to views',
      dimension: '1D', isDefault: 'true', columns: ['1', '0'],
    },
  );
  // The same row, still open: the editor the user is in stays where it is.
  assert.equal(tsne().querySelector('.data-mapping-editor'), editor);
  assert.equal(editor.hidden, false);
  const x = tsne().querySelectorAll('.obs-select').find(node => node.id.endsWith('-x'));
  x.value = '1';
  x.dispatch('change');
  assert.equal(panel.rows().find(row => row.name.startsWith('t-SNE')).name, 't-SNE 2');

  panel.apply.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(panel.applied.at(-1).embeddings, {
    enabled: [{ key: 'X_tsne', columns: [1] }, UMAP],
    defaults: { '1d': { key: 'X_tsne', columns: [1] }, '2d': UMAP, '3d': null },
  });
  // Applied and restaged: the row is the same node, its editor still open.
  assert.equal(tsne().querySelector('.data-mapping-editor'), editor);
  assert.equal(editor.hidden, false);
  assert.equal(panel.root.querySelector('.disclosure-desc').textContent, '2 on · UMAP 2D · t-SNE 2 1D');
});

test('a render updates the rows in place: a change elsewhere replaces no row and keeps the focus', t => {
  const panel = mountPanel(t);
  const before = panel.root.querySelector('.data-mapping-list').children.slice();
  const button = panel.row('t-SNE').querySelector('.data-mapping-default');
  button.focus();
  button.dispatch('click');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  // Pressed, it stays focusable: aria-disabled, not disabled.
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(panel.root.ownerDocument.activeElement, button);
  const after = panel.root.querySelector('.data-mapping-list').children;
  assert.equal(after.length, before.length);
  after.forEach((node, index) => assert.equal(node, before[index]));
});

test('a representation that fails its load check is refused, named, and stays off', async t => {
  const panel = mountPanel(t, { failLoads: { X_tsne: 'NaN at cell 2' } });
  panel.row('t-SNE').querySelector('.data-mapping-default').dispatch('click');
  panel.apply.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(panel.status().textContent, "Embedding 'X_tsne' cannot be plotted: NaN at cell 2.");
  assert.equal(panel.status().dataset.tone, 'danger');
  const tsne = panel.rows().find(row => row.name === 't-SNE');
  assert.equal(tsne.enableDisabled, true);
  assert.equal(tsne.enableTitle, 'NaN at cell 2');
  assert.deepEqual(panel.state.getDataMapping().embeddings.defaults['2d'], UMAP);
});

test('a notification carries one action, which settles it when taken', t => {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const hadRaf = Object.hasOwn(globalThis, 'requestAnimationFrame');
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new FakeNotificationElement() };
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    if (!hadDocument) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (!hadRaf) delete globalThis.requestAnimationFrame;
  });
  const center = new NotificationCenter();
  center.initialized = true;
  center.container = new FakeNotificationElement();
  center._scheduleDismiss = () => {};
  let runs = 0;
  const id = center.info('Shown.', { duration: 0, action: { label: 'Show', run: () => { runs += 1; } } });
  const element = center.notifications.get(id).element;
  assert.match(element.html, /<button type="button" class="btn btn-compact notification-action">Show<\/button>/);
  element.querySelector('.notification-action').listeners.click();
  assert.equal(runs, 1);
  assert.equal(center.hasNotification(id), false);

  assert.throws(
    () => center.info('x', { action: { label: '', run() {} } }),
    /exactly \{ label, run \}/
  );
  assert.throws(
    () => center.loading('x', { action: { label: 'Show', run() {} } }),
    /not in progress/
  );
  const other = center.info('y', { duration: 0, action: { label: 'Show', run() {} } });
  assert.throws(
    () => center.show({ id: other, action: { label: 'Other', run() {} } }),
    /cannot replace the "action" owner/
  );
});

class FakeNotificationElement {
  constructor() {
    this.listeners = {};
    this.children = [];
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
    this.parts = new Map();
  }

  set innerHTML(html) {
    this.html = html;
  }

  querySelector(selector) {
    const className = selector.replace(/^\./, '').split('[')[0];
    if (!this.html?.includes(className)) return null;
    if (!this.parts.has(selector)) this.parts.set(selector, new FakeNotificationElement());
    return this.parts.get(selector);
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute() {}

  removeAttribute() {}

  remove() {}
}

test('analytics may send how a mapping was chosen and how many embeddings are on, never what they name', () => {
  const base = {
    load_method: 'local-user-h5ad',
    source_type: 'local-user',
    outcome: 'success',
    duration_ms: 10,
    duration_bucket: '<1s',
  };
  assert.doesNotThrow(() => validateEvent('data_load', {
    ...base,
    mapping_origin: 'best_guess',
    embedding_candidates: '4-9',
    enabled_representations: '2-3',
  }));
  for (const value of ['url', 'session', 'X_tsne']) {
    assert.throws(() => validateEvent('data_load', { ...base, mapping_origin: value }));
  }
  assert.throws(() => validateEvent('data_load', { ...base, embedding_candidates: '7' }));
  assert.throws(() => validateEvent('data_load', { ...base, enabled_representations: 'X_umap' }));
  assert.deepEqual(EMBEDDING_CANDIDATE_BUCKETS, ['1', '2-3', '4-9', '10+']);
  assert.deepEqual(
    [1, 2, 3, 4, 9, 10, 400].map(embeddingCandidateBucket),
    ['1', '2-3', '2-3', '4-9', '4-9', '10+', '10+']
  );
  assert.deepEqual(FEATURES.data_mapping, [
    'embedding', 'embedding_columns', 'default', 'knn', 'gene_names', 'expression',
    'latent', 'vector_fields',
  ]);
  for (const variant of FEATURES.data_mapping) {
    assert.doesNotThrow(() => validateEvent('feature_used', { feature: 'data_mapping', variant }));
  }
  assert.throws(() => validateEvent('feature_used', { feature: 'data_mapping', variant: 'view_embedding' }));
});

test('the data mapping sits at the bottom of the Session panel and stays out of the session UI inventory', async () => {
  const [html, uiControls] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/app/state-serializer/ui-controls.js', import.meta.url), 'utf8'),
  ]);
  const session = html.slice(
    html.indexOf('id="session-section"'),
    html.indexOf('</details>', html.indexOf('id="session-section"'))
  );
  // Its own heading, after the Session file block and last in the panel.
  const sessionFile = session.indexOf('id="session-state-controls"');
  const mapping = session.indexOf('id="data-mapping-controls"');
  assert.ok(sessionFile >= 0 && mapping > sessionFile, 'Data mapping follows Session file');
  assert.match(
    session.slice(mapping),
    /<h3 class="section-title" id="data-mapping-title">Data mapping<\/h3>[\s\S]*data-info-tip="data-mapping"[\s\S]*<div id="data-mapping-root" data-state-serializer-skip="true"><\/div>\s*<\/div>\s*<\/div>\s*$/
  );
  assert.doesNotMatch(
    html.slice(html.indexOf('id="dataset-facts"'), html.indexOf('id="open-data-controls"')),
    /data-mapping-root/,
    'the mapping is no longer part of the dataset facts'
  );
  // The picker is drawn from the state and restored by core/state.
  assert.match(
    html,
    /<select id="view-representation-select" class="obs-select" data-state-serializer-skip="true"><\/select>/
  );
  const owned = /const DOMAIN_OWNED_IDS = new Set\(\[([\s\S]*?)\]\)/.exec(uiControls)[1];
  assert.match(owned, /'view-representation-select'/);
  assert.doesNotMatch(owned, /'dimension-select'|'view-embedding-select'/);
});

test('a grid export draws each view with the embedding it shows', async () => {
  const controller = new AbortController();
  const reason = new DOMException('stop after the snapshots', 'AbortError');
  const layouts = { live: 'X_umap', 'snapshot-1': 'X_tsne' };
  const transforms = {
    X_umap: { center: [1, 2, 0], scale: 0.5 },
    X_tsne: { center: [-4, 3, 0], scale: 0.25 },
  };
  const normTransformReads = [];
  const borrowed = [];
  const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const presented = {
    cameraState: {
      navigationMode: 'planar',
      orbit: { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 2, target: [0, 0, 0] },
      freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 },
    },
    dimensionLevel: 2,
    geometryGeneration: 3,
    lodMembership: null,
    drawOrder: null,
    lodSizeMultiplier: 1,
    renderState: {
      antialias: true,
      backdrop: {
        centerY: 0, extentX: 1, extentY: 1, extentZ: 1, flat: true, floorY: -1.12,
        glowCenterX: 0, look: null, pixelRatio: 1, planarity: 1, stageX: 0, stageZ: 0,
      },
      bgColor: Float32Array.from([1, 1, 1]), cameraDistance: 3,
      cameraPosition: [0, 0, 3], far: 100, fogColor: Float32Array.from([1, 1, 1]),
      fogDensity: 0, fogFar: 3.5, fogNear: 2.5, fov: Math.PI / 4,
      lightDir: Float32Array.from([0, 0, 1]), lightingStrength: 1,
      modelMatrix: new Float32Array(identity), mvpMatrix: new Float32Array(identity),
      near: 0.01, pointSize: 4, projectionMatrix: new Float32Array(identity),
      shaderQuality: 'full', sizeAttenuation: 1, viewMatrix: new Float32Array(identity),
      viewportHeight: 100, viewportWidth: 100,
    },
  };
  const context = () => ({ centroidColors: null, centroidLabels: [], centroidPositions: null });
  const state = {
    centroidColors: null,
    centroidLabels: [],
    centroidPositions: null,
    dimensionManager: {
      getNormTransform(layoutKey) {
        normTransformReads.push(layoutKey);
        return transforms[layoutKey];
      },
    },
    getActiveViewId: () => 'live',
    getDatasetGeneration: () => 1,
    getFieldForView: () => null,
    getFilterSummaryForView: () => [],
    getHighlightedCellCount: () => 0,
    getLegendModel: () => null,
    getTotalHighlightedCellCount: () => 0,
    getViewDimensionLevel: () => 2,
    getViewLayoutKey: viewId => layouts[viewId],
    pointCount: 1,
    viewContexts: new Map([['snapshot-1', context()]]),
  };
  const viewer = {
    getAntialiasing: () => true,
    getCentroidFlags: () => ({ labels: false, points: false }),
    getLiveViewLabel: () => 'Live',
    getPointCount: () => 1,
    getPresentedViewState: () => presented,
    getSnapshotViews: () => [{ id: 'snapshot-1', label: 't-SNE' }],
    getViewLayout: () => ({ liveViewHidden: false, mode: 'grid' }),
    withBorrowedViewData(viewId, callback) {
      borrowed.push(viewId);
      if (viewId === 'snapshot-1') controller.abort(reason);
      return callback({
        colors: Uint8Array.from([255, 255, 255, 255]),
        dimensionLevel: 2,
        geometryGeneration: 3,
        lodMembership: null,
        drawOrder: null,
        pointCount: 1,
        positions: viewId === 'live' ? Float32Array.from([0.5, 0.5]) : Float32Array.from([-0.5, 0.25]),
        transparency: Uint8Array.from([1]),
      });
    },
  };
  const engine = createFigureExportEngine({ state, viewer });
  await assert.rejects(
    engine.exportFigure({
      axisLabelFontSizePx: 12, background: 'viewer', backgroundColor: '#ffffff',
      centroidLabelFontSizePx: 12, crop: null, depthSort3d: false, dpi: 300,
      emphasizeSelection: false, exportAllViews: true, fontFamily: 'Arial, sans-serif',
      fontSizePx: 12, format: 'png', height: 100, includeAxes: true, includeLegend: false,
      legendFontSizePx: 12, legendPosition: 'right', optimizedTargetCount: null,
      referenceGrid: null, selectionMutedOpacity: 0.15, showOrientation: true,
      signal: controller.signal, strategy: null, tickFontSizePx: 12, title: '',
      titleFontSizePx: 15, width: 100, xLabel: 'X', yLabel: 'Y',
    }),
    error => error === reason
  );
  // Each view's normalization comes from the layout it shows.
  assert.deepEqual(normTransformReads, ['X_umap', 'X_tsne']);
  assert.deepEqual(borrowed, ['live', 'snapshot-1']);
});
