/**
 * A dataset as session files see it: a stand-in DataState over a real
 * DimensionManager (layouts registered with their obsm provenance, positions
 * that name each cell by its original position), its data mapping and
 * highlight pages; the session files of it (`SessionSerializer`, format 4)
 * over a history of two domains (the data mapping and the highlight pages);
 * and a notification harness that keeps the page's notification center
 * quiet. Shared by the session suites.
 */
import assert from 'node:assert/strict';

import { getNotificationCenter } from '../../assets/js/app/notification-center.js';
import { highlightStateMethods } from '../../assets/js/app/state/managers/highlight-manager.js';
import { getDatasetFingerprint } from '../../assets/js/app/session/session-context.js';
import { SessionSerializer } from '../../assets/js/app/session/session-serializer.js';
import { DimensionManager } from '../../assets/js/data/dimension-manager.js';
import { validateDataMapping } from '../../assets/js/data/data-mapping.js';
import { createActionCatalog } from '../../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../../assets/js/app/actions/domains.js';
import { createHistory } from '../../assets/js/app/history/history.js';
import { historyActions } from '../../assets/js/app/actions/definitions/history.js';
import { installDataMappingMethods } from './data-mapping-state.mjs';

export const CELL_COUNT = 6;
export const VAR_COUNT = 4;
export const SELECTED_ROWS = [0, 2];
export const IDENTITY_ORDER = [0, 1, 2, 3, 4, 5];

/**
 * The layouts of a file whose arrays are read whole: each layout is keyed by
 * its obsm key; the mapping enables every one and names each dimension's
 * default. `X_tsne_2d` is a second 2D embedding a view can show beside the 2D
 * default.
 */
export const KEYED_COLUMNS = Object.freeze({
  X_umap_2d: Object.freeze([0, 1]),
  X_tsne_2d: Object.freeze([0, 1]),
  X_umap_3d: Object.freeze([0, 1, 2]),
});
export const KEYED_LAYOUTS = Object.freeze([
  Object.freeze({ layoutKey: 'X_umap_2d', dimension: 2, scale: 1, provenance: { key: 'X_umap_2d', columns: [0, 1] } }),
  Object.freeze({ layoutKey: 'X_tsne_2d', dimension: 2, scale: 3, provenance: { key: 'X_tsne_2d', columns: [0, 1] } }),
  Object.freeze({ layoutKey: 'X_umap_3d', dimension: 3, scale: 1, provenance: { key: 'X_umap_3d', columns: [0, 1, 2] } }),
]);

/**
 * The layouts of an AnnData source: each one is named by the obsm key and the
 * columns it plots, whatever its layout key is.
 */
export const ANNDATA_LAYOUTS = Object.freeze([
  Object.freeze({
    layoutKey: 'X_umap',
    dimension: 2,
    scale: 1,
    provenance: { key: 'X_umap', columns: [0, 1] },
  }),
  Object.freeze({
    layoutKey: 'X_pca:3,1',
    dimension: 2,
    scale: 5,
    provenance: { key: 'X_pca', columns: [3, 1] },
  }),
  Object.freeze({
    layoutKey: 'X_umap_3d',
    dimension: 3,
    scale: 1,
    provenance: { key: 'X_umap_3d', columns: [0, 1, 2] },
  }),
]);

/** The embeddings group of a keyed mapping: enabled keys and defaults. */
export function keyedEmbeddings(enabled, { d2 = null, d3 = null } = {}) {
  const ref = key => ({ key, columns: [...KEYED_COLUMNS[key]] });
  return {
    enabled: enabled.map(ref),
    defaults: {
      '1d': null,
      '2d': d2 === null ? null : ref(d2),
      '3d': d3 === null ? null : ref(d3),
    },
  };
}

export function keyedMapping(overrides = {}) {
  return validateDataMapping({
    kind: 'anndata',
    embeddings: keyedEmbeddings(
      ['X_tsne_2d', 'X_umap_2d', 'X_umap_3d'],
      { d2: 'X_umap_2d', d3: 'X_umap_3d' },
    ),
    knn: null,
    geneNames: 'index',
    expression: 'X',
    log1p: {},
    highlyVariable: null,
    latent: null,
    vectorFields: [],
    ...overrides,
  });
}

export const ANNDATA_REFS = Object.freeze({
  pca: Object.freeze({ key: 'X_pca', columns: Object.freeze([3, 1]) }),
  umap: Object.freeze({ key: 'X_umap', columns: Object.freeze([0, 1]) }),
  umap3d: Object.freeze({ key: 'X_umap_3d', columns: Object.freeze([0, 1, 2]) }),
});

/** The embeddings group of an AnnData mapping, from ANNDATA_REFS names. */
export function anndataEmbeddings(enabled, { d2 = null, d3 = null } = {}) {
  const ref = name => structuredClone(ANNDATA_REFS[name]);
  return {
    enabled: enabled.map(ref),
    defaults: {
      '1d': null,
      '2d': d2 === null ? null : ref(d2),
      '3d': d3 === null ? null : ref(d3),
    },
  };
}

export function anndataMapping(overrides = {}) {
  return validateDataMapping({
    kind: 'anndata',
    embeddings: anndataEmbeddings(['pca', 'umap', 'umap3d'], { d2: 'umap', d3: 'umap3d' }),
    knn: 'connectivities',
    geneNames: 'index',
    expression: 'X',
    log1p: {},
    highlyVariable: null,
    latent: null,
    vectorFields: [],
    ...overrides,
  });
}

/**
 * One coordinate per embedding axis per cell, distinct per cell, so a row
 * permutation is observable in the bytes exactly as it is in a real export.
 * The viewer holds exactly `dimension` components per cell; `scale` makes
 * two embeddings of one dimension hold different coordinates.
 *
 * @param {readonly number[]} cellOrder Original cell id at each dataset row.
 * @param {number} [dimension=3]
 * @param {number} [scale=1]
 * @returns {Float32Array}
 */
export function positionsForCellOrder(cellOrder, dimension = 3, scale = 1) {
  const axisScale = [0.125, 0.25, 0.5];
  const positions = new Float32Array(cellOrder.length * dimension);
  for (let row = 0; row < cellOrder.length; row++) {
    const cellId = cellOrder[row];
    for (let axis = 0; axis < dimension; axis++) {
      positions[row * dimension + axis] = (cellId + 1) * axisScale[axis] * scale;
    }
  }
  return positions;
}

/**
 * A real DimensionManager holding the given layouts. Only the live layout's
 * positions are resident; every other layout is "fetched" by `getPositions`
 * the first time it is asked for, which the manager records in `log`.
 */
export function makeDimensionManager({
  cellOrder,
  layouts,
  mapping,
  liveLayoutKey,
  positionsOverride = null,
  deferLoads = false,
}) {
  const manager = new DimensionManager();
  manager.registerLayouts(layouts.map(layout => ({
    layoutKey: layout.layoutKey,
    dimension: layout.dimension,
    label: layout.layoutKey,
    path: null,
    provenance: layout.provenance,
    origin: 'identity',
  })));
  // The representations the mapping enables, as far as these layouts plot
  // them: a test dataset may lack one its mapping names.
  const layoutOf = ref => layouts.find(candidate => (
    ref.columns === null
      ? candidate.layoutKey === ref.key
      : candidate.provenance?.key === ref.key
        && candidate.provenance.columns.join(',') === ref.columns.join(',')
  ));
  const enabled = mapping.embeddings.enabled
    .map(layoutOf)
    .filter(layout => layout !== undefined)
    .map(layout => layout.layoutKey);
  const defaults = new Map();
  for (const slot of ['1d', '2d', '3d']) {
    const ref = mapping.embeddings.defaults[slot];
    const layout = ref === null ? undefined : layoutOf(ref);
    if (layout !== undefined) defaults.set(Number(slot[0]), layout.layoutKey);
  }
  manager.setRepresentations(enabled, defaults);
  manager.publishCellCount(cellOrder.length);
  const stored = new Map(layouts.map(layout => [
    layout.layoutKey,
    positionsOverride?.[layout.layoutKey]
      ?? positionsForCellOrder(cellOrder, layout.dimension, layout.scale),
  ]));
  manager.normalizedPositionCache.set(liveLayoutKey, stored.get(liveLayoutKey));
  manager.viewLayouts.set('live', liveLayoutKey);

  const log = [];
  const pendingLoads = [];
  const prototypePin = DimensionManager.prototype.pinLayout;
  const prototypeGet = DimensionManager.prototype.getPositions;
  manager.pinLayout = layoutKey => {
    log.push(['pin', layoutKey]);
    const release = prototypePin.call(manager, layoutKey);
    return () => {
      log.push(['release', layoutKey]);
      release();
    };
  };
  manager.getPositions = async (...args) => {
    const [layoutKey] = args;
    log.push(['getPositions', ...args]);
    if (!manager.normalizedPositionCache.has(layoutKey)) {
      log.push(['load', layoutKey]);
      if (deferLoads) {
        await new Promise(resolve => pendingLoads.push(resolve));
      }
      manager.normalizedPositionCache.set(layoutKey, stored.get(layoutKey));
    }
    return prototypeGet.call(manager, layoutKey);
  };
  return { manager, log, pendingLoads, stored };
}

export function makeDatasetState({
  cellOrder,
  pages,
  activePageId = 'page_1',
  kind = 'keyed',
  mapping = kind === 'keyed' ? keyedMapping() : anndataMapping(),
  layouts = kind === 'keyed' ? KEYED_LAYOUTS : ANNDATA_LAYOUTS,
  liveLayoutKey = 'X_umap_3d',
  positionsOverride = null,
  deferLoads = false,
}) {
  const { manager, log, pendingLoads } = makeDimensionManager({
    cellOrder,
    layouts,
    mapping,
    liveLayoutKey,
    positionsOverride,
    deferLoads,
  });
  const state = Object.create(highlightStateMethods);
  state.getDatasetGeneration = () => 0;
  state.obsData = { fields: [] };
  state.pointCount = cellOrder.length;
  state.dimensionManager = manager;
  state.positionsArray = manager.normalizedPositionCache.get(liveLayoutKey);
  state.varData = { fields: Array.from({ length: VAR_COUNT }, () => ({})) };
  installDataMappingMethods(state, { mapping });
  // The embedding transaction itself is DataState's (mapping-manager tests);
  // here it records what a restore asks for and publishes it.
  state.appliedMappings = [];
  state.applyDataMapping = async (next, { origin }) => {
    state.appliedMappings.push({ mapping: next, origin });
    state.dataMapping = next;
    state._mappingOrigin = origin;
    return true;
  };
  state.getViewDimensionLevel = viewId => {
    assert.equal(viewId, 'live');
    return manager.getViewDimension('live');
  };
  state.getViewLayoutKey = viewId => {
    assert.equal(viewId, 'live');
    return manager.getViewLayout('live');
  };
  state.getActiveViewId = () => 'live';
  state.highlightPages = pages;
  state.activePageId = activePageId;
  state._highlightPageIdCounter = 1;
  state._highlightIdCounter = pages.flatMap(
    page => page.highlightedGroups,
  ).length;
  state._recomputeHighlightArray = () => {};
  state._notifyHighlightPageChange = () => {};
  state._notifyHighlightChange = () => {};
  // The cell ids the dataset rows actually carry, used only by assertions.
  state.cellOrder = [...cellOrder];
  state.dimensionLog = log;
  state.pendingLoads = pendingLoads;
  return state;
}

export function makeDataSourceManager() {
  return {
    getCurrentIdentityId: () => 'pancreas',
    getCurrentSourceType: () => 'local-demo',
    getCurrentDatasetId: () => 'pancreas',
  };
}

/**
 * The session files of a dataset whose history holds two domains: its data
 * mapping and its highlight pages (cells as Uint32Arrays); every other
 * domain holds nothing. `serializer.history` is that history, with no
 * tracker yet.
 */
export function makeSerializer(state, { chrome = null } = {}) {
  const domains = createDomainRegistry();
  domains.provide('mapping', {
    capture: () => state.getDataMapping(),
    restore: value => state.applyDataMapping(value, { origin: 'session' }),
  });
  domains.provide('highlights', {
    capture: () => ({
      activePageId: state.activePageId,
      pages: state.highlightPages.map(page => ({
        id: page.id,
        name: page.name,
        color: page.color,
        groups: page.highlightedGroups.map(group => ({
          id: group.id, type: group.type, label: group.label, enabled: group.enabled,
          cells: Uint32Array.from(group.cellIndices),
        })),
      })),
    }),
    restore: value => {
      state.activePageId = value.activePageId;
      state.highlightPages = value.pages.map(page => ({
        id: page.id,
        name: page.name,
        color: page.color,
        highlightedGroups: page.groups.map(group => ({
          id: group.id, type: group.type, label: group.label, enabled: group.enabled,
          cellIndices: group.cells.slice(), cellCount: group.cells.length,
        })),
      }));
    },
  });
  // Settings as the app holds them (every control listed): a starting view
  // leaves the viewer background as shown (`published-default.js` `keepShownControls`).
  domains.provide('settings', { capture: () => ({ controls: {}, figureExport: null }), restore: () => {} });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  // The history's own actions (journal undo among them), which the history provides itself.
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(historyActions) });
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'pancreas', name: null, cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-9000-${String(++trackerIds).padStart(12, '0')}`,
  });
  const loads = { count: 0 };
  return Object.assign(new SessionSerializer({
    state,
    dataSourceManager: makeDataSourceManager(),
    getHistory: () => history,
    dispatcher,
    onLoaded: () => { loads.count += 1; },
    version: () => SESSION_TEST_VERSION,
    ...(chrome === null ? {} : { chrome }),
  }), { history, loads });
}

/** Tracker ids unique across the test pages, as the app's random ones are. */
let trackerIds = 0;

/** The Cellucid version the test pages' session files say wrote them (no page names one here). */
export const SESSION_TEST_VERSION = '0.9.6';

/** A session file of `state`: its history started on what it shows. */
export async function sessionOf(state) {
  const serializer = makeSerializer(state);
  await serializer.history.startTracker();
  return serializer.createSessionBundle();
}

export async function fingerprintOf(state) {
  return getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state,
  });
}

export function selectionPages(cellIndices) {
  return [{
    id: 'page_1',
    name: 'Lasso work',
    color: '#112233',
    highlightedGroups: [{
      id: 'highlight_1',
      type: 'lasso',
      label: 'CD8 T cells',
      enabled: true,
      cellIndices: [...cellIndices],
      cellCount: cellIndices.length,
    }],
  }];
}

export function emptyPages() {
  return [{
    id: 'page_1',
    name: 'Untouched',
    color: '#445566',
    highlightedGroups: [],
  }];
}

export async function withNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'error',
    'failDownload',
    'info',
    'show',
    'dismiss',
    'startDownload',
    'success',
    'updateDownload',
    'warning',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => {};
  notifications.startDownload = () => 'session-cell-order-test';
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  }
}
