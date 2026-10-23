import assert from 'node:assert/strict';
import test from 'node:test';
import { UNCHANGEABLE_GROUP_CLAUSE } from '../assets/js/data/dataset-mapping.js';

import {
  readBundle,
} from '../assets/js/app/session/bundle/reader.js';
import {
  writeBundle,
} from '../assets/js/app/session/bundle/writer.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import * as highlightsCellsContributor from
  '../assets/js/app/session/contributors/highlights-cells.js';
import * as highlightsMetaContributor from
  '../assets/js/app/session/contributors/highlights-meta.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  NOT_A_SESSION_FILE_MESSAGE,
  SESSION_BUNDLE_MAGIC_BYTES,
} from '../assets/js/app/session/bundle/format.js';
import {
  assertDatasetFingerprint,
  datasetFingerprintMatches,
  describeDataMappingMismatch,
  describeMissingRequiredFields,
  digestCellOrder,
  getDatasetFingerprint,
  verifySessionFingerprint,
} from '../assets/js/app/session/session-context.js';
import {
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';
import {
  DimensionManager,
} from '../assets/js/data/dimension-manager.js';
import {
  validateDataMapping,
} from '../assets/js/data/data-mapping.js';
import { installDataMappingMethods } from './helpers/data-mapping-state.mjs';

const CELL_COUNT = 6;
const VAR_COUNT = 4;
const SELECTED_ROWS = [0, 2];
const IDENTITY_ORDER = [0, 1, 2, 3, 4, 5];

/**
 * The layouts of a file whose arrays are read whole: each layout is keyed by
 * its obsm key; the mapping enables every one and names each dimension's
 * default. `X_tsne_2d` is a second 2D embedding a view can show beside the 2D
 * default.
 */
const KEYED_COLUMNS = Object.freeze({
  X_umap_2d: Object.freeze([0, 1]),
  X_tsne_2d: Object.freeze([0, 1]),
  X_umap_3d: Object.freeze([0, 1, 2]),
});
const KEYED_LAYOUTS = Object.freeze([
  Object.freeze({ layoutKey: 'X_umap_2d', dimension: 2, scale: 1, provenance: { key: 'X_umap_2d', columns: [0, 1] } }),
  Object.freeze({ layoutKey: 'X_tsne_2d', dimension: 2, scale: 3, provenance: { key: 'X_tsne_2d', columns: [0, 1] } }),
  Object.freeze({ layoutKey: 'X_umap_3d', dimension: 3, scale: 1, provenance: { key: 'X_umap_3d', columns: [0, 1, 2] } }),
]);

/**
 * The layouts of an AnnData source: each one is named by the obsm key and the
 * columns it plots, whatever its layout key is.
 */
const ANNDATA_LAYOUTS = Object.freeze([
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
function keyedEmbeddings(enabled, { d2 = null, d3 = null } = {}) {
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

function keyedMapping(overrides = {}) {
  return validateDataMapping({
    kind: 'anndata',
    embeddings: keyedEmbeddings(
      ['X_tsne_2d', 'X_umap_2d', 'X_umap_3d'],
      { d2: 'X_umap_2d', d3: 'X_umap_3d' },
    ),
    knn: null,
    geneNames: 'index',
    expression: 'X',
    latent: null,
    vectorFields: [],
    ...overrides,
  });
}

const ANNDATA_REFS = Object.freeze({
  pca: Object.freeze({ key: 'X_pca', columns: Object.freeze([3, 1]) }),
  umap: Object.freeze({ key: 'X_umap', columns: Object.freeze([0, 1]) }),
  umap3d: Object.freeze({ key: 'X_umap_3d', columns: Object.freeze([0, 1, 2]) }),
});

/** The embeddings group of an AnnData mapping, from ANNDATA_REFS names. */
function anndataEmbeddings(enabled, { d2 = null, d3 = null } = {}) {
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

function anndataMapping(overrides = {}) {
  return validateDataMapping({
    kind: 'anndata',
    embeddings: anndataEmbeddings(['pca', 'umap', 'umap3d'], { d2: 'umap', d3: 'umap3d' }),
    knn: 'connectivities',
    geneNames: 'index',
    expression: 'X',
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
function positionsForCellOrder(cellOrder, dimension = 3, scale = 1) {
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
function makeDimensionManager({
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

function makeDatasetState({
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

function makeDataSourceManager() {
  return {
    getCurrentIdentityId: () => 'pancreas',
    getCurrentSourceType: () => 'local-demo',
    getCurrentDatasetId: () => 'pancreas',
  };
}

function makeSerializer(state) {
  return new SessionSerializer({
    state,
    viewer: {},
    sidebar: {},
    dataSourceManager: makeDataSourceManager(),
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    figureExport: null,
    contributors: [
      highlightsMetaContributor,
      highlightsCellsContributor,
    ],
  });
}

function fingerprintOf(state) {
  return getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state,
  });
}

function selectionPages(cellIndices) {
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

function emptyPages() {
  return [{
    id: 'page_1',
    name: 'Untouched',
    color: '#445566',
    highlightedGroups: [],
  }];
}

async function withNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'error',
    'failDownload',
    'info',
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

async function rewriteSessionBundle(blob, mutate) {
  const { manifest, chunkStream } = await readBundle(blob, {
    signal: null,
    onProgress: null,
  });
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk.bytes);
  mutate(manifest, chunks);
  return writeBundle({ manifest, chunks });
}

async function readManifest(blob) {
  const { manifest, chunkStream } = await readBundle(blob, {
    signal: null,
    onProgress: null,
  });
  for await (const _chunk of chunkStream) {
    // Drain the stream so the reader settles.
  }
  return manifest;
}

async function captureSelectionBundle(options = {}) {
  const source = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: selectionPages(SELECTED_ROWS),
    ...options,
  });
  return {
    bundle: await makeSerializer(source).createSessionBundle(),
    source,
  };
}

function restoredSelection(state) {
  return state.highlightPages.flatMap(page => (
    page.highlightedGroups.map(group => [...group.cellIndices])
  ));
}

function heldPins(state) {
  return state.dimensionManager._layoutPins.size;
}

async function refusal(state, bundle) {
  let message = null;
  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(state).restoreFromBlob(bundle),
      error => {
        assert.ok(error instanceof RangeError);
        message = error.message;
        return true;
      },
    );
  });
  return message;
}

test(
  're-exported dataset with permuted rows cannot silently restore a selection',
  async () => {
    const { bundle, source } = await captureSelectionBundle();
    // What the user actually selected, by cell, not by row.
    const selectedCells = SELECTED_ROWS.map(row => source.cellOrder[row]);
    assert.deepEqual(selectedCells, [0, 2]);

    // Same dataset id, same cell count, same gene count, same data mapping,
    // re-exported from re-sorted input: only the row order changed.
    const permutedOrder = [5, 4, 3, 2, 1, 0];
    const destination = makeDatasetState({
      cellOrder: permutedOrder,
      pages: emptyPages(),
    });
    assert.equal(destination.pointCount, source.pointCount);
    assert.equal(
      destination.varData.fields.length,
      source.varData.fields.length,
    );
    // The harm this refusal prevents: the saved rows point at other cells.
    assert.deepEqual(
      SELECTED_ROWS.map(row => permutedOrder[row]),
      [5, 3],
    );

    const untouchedPages = destination.highlightPages;
    const message = await refusal(destination, bundle);
    assert.match(message, /coordinates differ/);
    assert.match(message, /different order/);
    // Row order is one of the two things a coordinate difference can mean,
    // so it is offered, never asserted.
    assert.match(message, /Either the cells are stored/);
    assert.strictEqual(destination.highlightPages, untouchedPages);
    assert.deepEqual(restoredSelection(destination), []);
    assert.equal(heldPins(destination), 0);
  },
);

test('an unchanged dataset restores the exact selected set', async () => {
  const { bundle } = await captureSelectionBundle();
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });

  await withNotificationHarness(async () => {
    await makeSerializer(destination).restoreFromBlob(bundle);
  });

  assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
  assert.deepEqual(
    restoredSelection(destination)[0].map(row => destination.cellOrder[row]),
    [0, 2],
  );
  assert.ok(
    destination.highlightPages[0].highlightedGroups[0].cellIndices
      instanceof Uint32Array,
  );
  assert.deepEqual(
    destination.highlightPages[0].highlightedGroups[0].label,
    'CD8 T cells',
  );
  // The live layout was digested from its resident positions, pinned for the
  // duration and released.
  assert.deepEqual(destination.dimensionLog, [
    ['pin', 'X_umap_3d'],
    ['getPositions', 'X_umap_3d'],
    ['release', 'X_umap_3d'],
  ]);
  assert.equal(heldPins(destination), 0);
});

test('a file without the format-2 signature is refused by its signature, before anything is read', async () => {
  const { bundle } = await captureSelectionBundle();
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  // The same framing behind an unversioned signature.
  const signature = new TextEncoder().encode('CELLUCID_SESSION\n');
  const rest = bytes.subarray(SESSION_BUNDLE_MAGIC_BYTES.byteLength);
  const unversioned = new Uint8Array(signature.byteLength + rest.byteLength);
  unversioned.set(signature, 0);
  unversioned.set(rest, signature.byteLength);
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(new Blob([unversioned])),
      error => {
        assert.equal(error.message, NOT_A_SESSION_FILE_MESSAGE);
        return true;
      },
    );
  });
  assert.deepEqual(restoredSelection(destination), []);
  // Refused at the signature: no layout was even looked at.
  assert.deepEqual(destination.dimensionLog, []);
});

test('a fingerprint missing a format-2 field is a schema violation', async () => {
  const { bundle } = await captureSelectionBundle();
  const withoutName = await rewriteSessionBundle(bundle, manifest => {
    delete manifest.datasetFingerprint.name;
  });
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(withoutName),
      /exact keys/,
    );
  });
  assert.deepEqual(destination.dimensionLog, []);
});

test(
  'a session saved in 3D opens while 2D is shown: the saved layout is loaded, not the live one',
  async () => {
    const { bundle } = await captureSelectionBundle();
    const manifest = await readManifest(bundle);
    assert.deepEqual(manifest.datasetFingerprint.cellOrder.embedding, {
      key: 'X_umap_3d',
      columns: [0, 1, 2],
    });
    assert.equal(manifest.datasetFingerprint.cellOrder.dimension, 3);

    const destination = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      liveLayoutKey: 'X_umap_2d',
    });
    const livePositions = destination.positionsArray;
    assert.equal(
      destination.dimensionManager.getResidentPositions('X_umap_3d'),
      null,
    );

    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });

    assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
    // The 3D layout the session names was pinned, loaded without progress UI,
    // digested and released; the live view kept showing its 2D layout.
    assert.deepEqual(destination.dimensionLog, [
      ['pin', 'X_umap_3d'],
      ['getPositions', 'X_umap_3d'],
      ['load', 'X_umap_3d'],
      ['release', 'X_umap_3d'],
    ]);
    assert.equal(heldPins(destination), 0);
    assert.equal(destination.dimensionManager.getViewLayout('live'), 'X_umap_2d');
    assert.strictEqual(destination.positionsArray, livePositions);
  },
);

test(
  'a session saved on a non-default embedding verifies that embedding, whatever is shown',
  async () => {
    // The session was saved while the live 2D view showed X_tsne_2d, not
    // the 2D default X_umap_2d.
    const { bundle } = await captureSelectionBundle({ liveLayoutKey: 'X_tsne_2d' });
    const manifest = await readManifest(bundle);
    assert.deepEqual(manifest.datasetFingerprint.cellOrder, {
      embedding: { key: 'X_tsne_2d', columns: [0, 1] },
      dimension: 2,
      digest: digestCellOrder(positionsForCellOrder(IDENTITY_ORDER, 2, 3), 2),
    });
    // The mapping records the enabled set and the defaults, not what one view
    // shows.
    assert.deepEqual(manifest.datasetFingerprint.dataMapping, keyedMapping());

    const destination = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
    });
    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });
    assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
    assert.deepEqual(destination.dimensionLog.map(entry => entry.slice(0, 2)), [
      ['pin', 'X_tsne_2d'],
      ['getPositions', 'X_tsne_2d'],
      ['load', 'X_tsne_2d'],
      ['release', 'X_tsne_2d'],
    ]);
    assert.equal(destination.dimensionManager.getViewLayout('live'), 'X_umap_3d');

    // The same check refuses that embedding when only it was re-ordered.
    const permutedTsne = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      positionsOverride: {
        X_tsne_2d: positionsForCellOrder([1, 0, 2, 3, 4, 5], 2, 3),
      },
    });
    const message = await refusal(permutedTsne, bundle);
    assert.match(message, /coordinates differ/);
    assert.deepEqual(restoredSelection(permutedTsne), []);
    assert.equal(heldPins(permutedTsne), 0);
  },
);

test('a session naming an embedding this dataset does not have is refused by name', async () => {
  const { bundle } = await captureSelectionBundle({ liveLayoutKey: 'X_tsne_2d' });
  // The same data mapping, but the dataset has no X_tsne_2d layout.
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_tsne_2d'),
  });
  const message = await refusal(destination, bundle);
  assert.equal(
    message,
    "This session recorded its cell order on obsm['X_tsne_2d'] columns [0, 1] in 2D, "
      + 'which this dataset does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(restoredSelection(destination), []);
  assert.deepEqual(destination.dimensionLog, []);

  // Other columns of an array the dataset plots are not the layout recorded.
  const otherColumns = await rewriteSessionBundle(bundle, manifest => {
    manifest.datasetFingerprint.cellOrder.embedding = {
      key: 'X_umap_3d',
      columns: [0, 1],
    };
  });
  const sameLayouts = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  assert.match(
    await refusal(sameLayouts, otherColumns),
    /^This session recorded its cell order on obsm\['X_umap_3d'\] columns \[0, 1\] in 2D, which this dataset does not have\./,
  );
  assert.deepEqual(sameLayouts.dimensionLog, []);
});

test('a session restores the embeddings it names, before its views', async () => {
  const { bundle } = await captureSelectionBundle();
  const saved = (await readManifest(bundle)).datasetFingerprint.dataMapping;

  // The dataset defaults to X_tsne_2d in 2D now; the session was saved with
  // X_umap_2d as that default, which this dataset also has, so the session
  // restores it.
  const otherSlot = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    mapping: keyedMapping({
      embeddings: keyedEmbeddings(
        ['X_tsne_2d', 'X_umap_2d', 'X_umap_3d'],
        { d2: 'X_tsne_2d', d3: 'X_umap_3d' },
      ),
    }),
  });
  await withNotificationHarness(async () => {
    await makeSerializer(otherSlot).restoreFromBlob(bundle);
  });
  assert.deepEqual(restoredSelection(otherSlot), [SELECTED_ROWS]);
  assert.deepEqual(otherSlot.appliedMappings, [{ mapping: saved, origin: 'session' }]);
  assert.deepEqual(otherSlot.getDataMapping(), saved);
});

test('a data mapping mismatch is refused naming the group, before any layout loads', async () => {
  const { bundle } = await captureSelectionBundle();

  // An enabled embedding this dataset does not have is refused by name.
  const missingSlot = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_umap_2d'),
    mapping: keyedMapping({
      embeddings: keyedEmbeddings(
        ['X_tsne_2d', 'X_umap_3d'],
        { d2: 'X_tsne_2d', d3: 'X_umap_3d' },
      ),
    }),
  });
  assert.equal(
    await refusal(missingSlot, bundle),
    "This session shows obsm['X_umap_2d'] columns [0, 1], which this dataset does not "
      + 'have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(missingSlot.dimensionLog, []);
  assert.deepEqual(missingSlot.appliedMappings, []);
  assert.deepEqual(restoredSelection(missingSlot), []);

  const otherGenes = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    mapping: keyedMapping({ geneNames: 'column:gene_symbols' }),
  });
  assert.equal(
    await refusal(otherGenes, bundle),
    'This session was saved with the var index as its gene names, and this '
      + "dataset is shown with var column 'gene_symbols'. The session was not opened."
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(otherGenes.dimensionLog, []);
});

test('every data mapping group is named the way the person loading the session knows it', () => {
  const base = anndataMapping();
  // The readers of a dataset that can show any embedding / none, and that
  // cannot change any other group.
  const fixed = () => UNCHANGEABLE_GROUP_CLAUSE;
  const canShowAny = { describeEmbeddingRefusal: () => null, describeChoiceRefusal: fixed };
  const hasNone = {
    describeEmbeddingRefusal: () => 'this dataset does not have',
    describeChoiceRefusal: fixed,
  };
  assert.equal(describeDataMappingMismatch(base, anndataMapping(), hasNone), null);
  const cases = [
    [
      anndataMapping({ knn: null }),
      "This session was saved with obsp['connectivities'] as its neighbour graph, "
        + 'and this dataset is shown with none. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({ expression: 'layer:log1p' }),
      'This session was saved with X as its expression matrix, and this dataset '
        + "is shown with layers['log1p']. The session was not opened."
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({ latent: 'X_pca' }),
      'This session was saved with none as its latent space, and this dataset '
        + "is shown with obsm['X_pca']. The session was not opened."
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({
        embeddings: anndataEmbeddings(['pca', 'umap3d'], { d2: 'pca', d3: 'umap3d' }),
      }),
      "This session shows obsm['X_umap'] columns [0, 1], which this dataset "
        + 'does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({
        embeddings: anndataEmbeddings(['pca', 'umap'], { d2: 'umap' }),
      }),
      "This session shows obsm['X_umap_3d'] columns [0, 1, 2], which this "
        + 'dataset does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
  ];
  for (const [current, expected] of cases) {
    assert.equal(describeDataMappingMismatch(base, current, hasNone), expected);
  }
  // Embeddings the dataset can show are restored, not refused.
  for (const [current] of cases.slice(3, 5)) {
    assert.equal(describeDataMappingMismatch(base, current, canShowAny), null);
  }
  // A session that enables fewer embeddings than the dataset shows now is
  // restored: every embedding it names is one this dataset has.
  assert.equal(
    describeDataMappingMismatch(
      anndataMapping({
        embeddings: anndataEmbeddings(['umap'], { d2: 'umap' }),
      }),
      base,
      hasNone,
    ),
    null,
  );
  assert.throws(() => describeDataMappingMismatch(base, base), /embedding and a choice refusal reader/);

  // A group the dataset can change is restored when it can use the saved
  // choice, and refused, naming it, when it cannot.
  const changeable = refusal => ({
    describeEmbeddingRefusal: () => null,
    describeChoiceRefusal: (group, value) => (group === 'knn' ? refusal(value) : fixed()),
  });
  assert.equal(
    describeDataMappingMismatch(base, anndataMapping({ knn: 'scvi_connectivities' }), changeable(() => null)),
    null,
  );
  assert.equal(
    describeDataMappingMismatch(
      base,
      anndataMapping({ knn: null }),
      changeable(() => 'this dataset does not have'),
    ),
    "This session uses obsp['connectivities'] as its neighbour graph, which this dataset "
      + 'does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.equal(
    describeDataMappingMismatch(
      anndataMapping({ knn: 'distances' }),
      base,
      changeable(() => 'this dataset cannot use (not symmetric — choose a connectivities matrix)'),
    ),
    "This session uses obsp['distances'] as its neighbour graph, which this dataset cannot "
      + 'use (not symmetric — choose a connectivities matrix). The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
});

test('nothing is applied before verification passes', async () => {
  const { bundle } = await captureSelectionBundle();

  async function restoreWhileLoading(destination, settle) {
    const untouchedPages = destination.highlightPages;
    await withNotificationHarness(async () => {
      const restore = makeSerializer(destination).restoreFromBlob(bundle);
      restore.catch(() => {});
      while (destination.pendingLoads.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      // The saved layout is still loading: the session is not verified, so
      // no contributor has run and no state has changed.
      for (let tick = 0; tick < 5; tick++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.strictEqual(destination.highlightPages, untouchedPages);
      assert.deepEqual(restoredSelection(destination), []);
      assert.equal(heldPins(destination), 1);
      destination.pendingLoads.shift()();
      await settle(restore);
    });
    assert.equal(heldPins(destination), 0);
  }

  // A saved layout whose rows differ: refused once loaded, and nothing was
  // applied while it loaded or after.
  const permuted = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_umap_2d',
    positionsOverride: {
      X_umap_3d: positionsForCellOrder([5, 4, 3, 2, 1, 0], 3),
    },
    deferLoads: true,
  });
  await restoreWhileLoading(permuted, restore => assert.rejects(
    restore,
    error => error instanceof RangeError && /coordinates differ/.test(error.message),
  ));
  assert.deepEqual(restoredSelection(permuted), []);

  // The same wait on a matching layout ends in the restore.
  const matching = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_umap_2d',
    deferLoads: true,
  });
  await restoreWhileLoading(matching, restore => restore);
  assert.deepEqual(restoredSelection(matching), [SELECTED_ROWS]);
});

test('verifySessionFingerprint checks identity, then mapping, then the digest', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const saved = fingerprintOf(source);
  const ctx = state => ({ dataSourceManager: makeDataSourceManager(), state });

  const same = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_tsne_2d',
  });
  assert.equal(await verifySessionFingerprint(ctx(same), saved), null);
  assert.equal(same.dimensionManager.getViewLayout('live'), 'X_tsne_2d');

  // A count difference wins over a mapping difference, which wins over the
  // digest: each refusal names the first thing that differs.
  const everythingDiffers = makeDatasetState({
    cellOrder: [0, 1, 2, 3, 4],
    pages: emptyPages(),
    mapping: keyedMapping({ geneNames: 'column:symbol' }),
  });
  assert.match(
    await verifySessionFingerprint(ctx(everythingDiffers), saved),
    /6 cells and 4 genes when it was saved, 5 cells and 4 genes now/,
  );
  assert.deepEqual(everythingDiffers.dimensionLog, []);

  const mappingAndRows = makeDatasetState({
    cellOrder: [5, 4, 3, 2, 1, 0],
    pages: emptyPages(),
    mapping: keyedMapping({ geneNames: 'column:symbol' }),
  });
  assert.match(
    await verifySessionFingerprint(ctx(mappingAndRows), saved),
    /as its gene names/,
  );
  assert.deepEqual(mappingAndRows.dimensionLog, []);

  const otherCopy = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  assert.match(
    await verifySessionFingerprint(
      {
        dataSourceManager: {
          getCurrentIdentityId: () => 'pancreas-mirror',
        },
        state: otherCopy,
      },
      saved,
    ),
    /saved on a different dataset\. It has the same.*"pancreas" and "pancreas-mirror" is open now/,
  );

  // Validation precedes everything: a malformed record never reaches the
  // dataset.
  await assert.rejects(
    verifySessionFingerprint(ctx(same), {
      datasetId: saved.datasetId,
      cellCount: saved.cellCount,
      varCount: saved.varCount,
      cellOrder: { dimension: 3, digest: saved.cellOrder.digest },
    }),
    /exact keys/,
  );
});

test(
  'a re-computed embedding at the same dimension is not called a re-ordering',
  async () => {
    const { bundle } = await captureSelectionBundle();
    // Same cells in the same rows: only the embedding was computed again, so
    // the coordinates moved and the digest changed. Nothing here re-ordered
    // any row, and the refusal must not say that it did.
    const destination = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      positionsOverride: {
        X_umap_3d: positionsForCellOrder(IDENTITY_ORDER, 3).map(
          value => value + 0.0009765625,
        ),
      },
    });

    const message = await refusal(destination, bundle);
    // The one thing the digest establishes.
    assert.match(message, /coordinates differ/);
    // Both causes it cannot separate, offered as alternatives.
    assert.match(message, /Either the cells are stored in a different order/);
    assert.match(message, /re-computed embedding/);
    // Never the old claim that a re-ordering is what happened.
    assert.doesNotMatch(message, /would mark the wrong cells/);
    assert.doesNotMatch(message, /but its cells are stored in a different order/);
    assert.deepEqual(restoredSelection(destination), []);
  },
);

test('dataset fingerprints are exactly six fields with a cell-order digest over every cell', () => {
  const state = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  const fingerprint = fingerprintOf(state);
  assert.deepEqual(Object.keys(fingerprint).sort(), [
    'cellCount',
    'cellOrder',
    'dataMapping',
    'datasetId',
    'name',
    'varCount',
  ]);
  assert.equal(fingerprint.datasetId, 'pancreas');
  assert.equal(fingerprint.cellCount, CELL_COUNT);
  assert.equal(fingerprint.varCount, VAR_COUNT);
  assert.deepEqual(Object.keys(fingerprint.cellOrder), ['embedding', 'dimension', 'digest']);
  assert.deepEqual(fingerprint.cellOrder.embedding, { key: 'X_umap_3d', columns: [0, 1, 2] });
  assert.equal(fingerprint.cellOrder.dimension, 3);
  assert.match(fingerprint.cellOrder.digest, /^[0-9a-f]{16}$/);
  assert.equal(
    fingerprint.cellOrder.digest,
    digestCellOrder(positionsForCellOrder(IDENTITY_ORDER, 3), 3),
  );
  assert.equal(Object.isFrozen(fingerprint.cellOrder), true);
  assert.equal(Object.isFrozen(fingerprint.cellOrder.embedding), true);
  // The mapping is the canonical one, key order included, so its JSON is the
  // same bytes on every writer.
  assert.equal(
    JSON.stringify(fingerprint.dataMapping),
    JSON.stringify(validateDataMapping(keyedMapping())),
  );
  assert.deepEqual(Object.keys(fingerprint.dataMapping), [
    'kind',
    'embeddings',
    'knn',
    'geneNames',
    'expression',
    'latent',
    'vectorFields',
  ]);
  assert.strictEqual(assertDatasetFingerprint(fingerprint, 'Fingerprint'), fingerprint);

  // Swapping the two last cells is enough to change the digest: the check is
  // not a sample.
  const swappedFingerprint = fingerprintOf(makeDatasetState({
    cellOrder: [0, 1, 2, 3, 5, 4],
    pages: emptyPages(),
  }));
  assert.equal(swappedFingerprint.cellCount, fingerprint.cellCount);
  assert.equal(swappedFingerprint.varCount, fingerprint.varCount);
  assert.notEqual(
    swappedFingerprint.cellOrder.digest,
    fingerprint.cellOrder.digest,
  );
  assert.equal(datasetFingerprintMatches(fingerprint, swappedFingerprint), false);
  assert.equal(
    datasetFingerprintMatches(
      fingerprint,
      fingerprintOf(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() })),
    ),
    true,
  );
  // The embedding and the mapping are part of the identity.
  assert.equal(
    datasetFingerprintMatches(
      fingerprint,
      fingerprintOf(makeDatasetState({
        cellOrder: IDENTITY_ORDER,
        pages: emptyPages(),
        mapping: keyedMapping({ geneNames: 'column:symbol' }),
      })),
    ),
    false,
  );

  // The fingerprint needs the mapping the dataset is shown with.
  const unmapped = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  unmapped.getDataMapping = () => null;
  assert.throws(() => fingerprintOf(unmapped), /requires the loaded data mapping/);
  const noLayoutKey = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  delete noLayoutKey.getViewLayoutKey;
  assert.throws(() => fingerprintOf(noLayoutKey), /getViewLayoutKey/);
});

test('cellOrder.embedding names the live layout by obsm key and columns, whatever its layout key', () => {
  const keyedFingerprint = fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_tsne_2d',
  }));
  assert.deepEqual(keyedFingerprint.cellOrder.embedding, { key: 'X_tsne_2d', columns: [0, 1] });
  assert.equal(keyedFingerprint.cellOrder.dimension, 2);

  const anndataFingerprint = fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    liveLayoutKey: 'X_pca:3,1',
  }));
  assert.deepEqual(anndataFingerprint.cellOrder.embedding, { key: 'X_pca', columns: [3, 1] });
  assert.equal(anndataFingerprint.cellOrder.dimension, 2);
  assert.deepEqual(anndataFingerprint.dataMapping, anndataMapping());
  assert.deepEqual(Object.keys(anndataFingerprint.dataMapping), [
    'kind',
    'embeddings',
    'knn',
    'geneNames',
    'expression',
    'latent',
    'vectorFields',
  ]);

  // An AnnData layout with no obsm provenance cannot be named in a session.
  const unnamed = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    layouts: [
      ...ANNDATA_LAYOUTS,
      { layoutKey: 'scratch', dimension: 2, scale: 7, provenance: null },
    ],
    liveLayoutKey: 'scratch',
  });
  assert.throws(() => fingerprintOf(unnamed), /no AnnData obsm provenance/);
});

test('an AnnData session is verified on the obsm columns it names', async () => {
  const { bundle } = await captureSelectionBundle({
    kind: 'anndata',
    liveLayoutKey: 'X_pca:3,1',
  });
  const manifest = await readManifest(bundle);
  assert.deepEqual(manifest.datasetFingerprint.cellOrder.embedding, {
    key: 'X_pca',
    columns: [3, 1],
  });

  // The same obsm columns registered under another layout key resolve by
  // their provenance, while the live view shows the 3D UMAP.
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    layouts: ANNDATA_LAYOUTS.map(layout => (
      layout.layoutKey === 'X_pca:3,1' ? { ...layout, layoutKey: 'pca-view' } : layout
    )),
  });
  await withNotificationHarness(async () => {
    await makeSerializer(destination).restoreFromBlob(bundle);
  });
  assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
  assert.deepEqual(destination.dimensionLog.map(entry => entry.slice(0, 2)), [
    ['pin', 'pca-view'],
    ['getPositions', 'pca-view'],
    ['load', 'pca-view'],
    ['release', 'pca-view'],
  ]);

  // Other columns of the same array are another embedding.
  const otherColumns = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    layouts: ANNDATA_LAYOUTS.map(layout => (
      layout.layoutKey === 'X_pca:3,1'
        ? { ...layout, provenance: { key: 'X_pca', columns: [1, 3] } }
        : layout
    )),
  });
  assert.equal(
    await refusal(otherColumns, bundle),
    "This session recorded its cell order on obsm['X_pca'] columns [3, 1] in 2D, "
      + 'which this dataset does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(otherColumns.dimensionLog, []);

});

test('a fingerprint record must be exact and its data mapping canonical', () => {
  const keyedFingerprint = fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  }));
  const anndataFingerprint = fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
  }));
  const clone = value => structuredClone({
    ...value,
    cellOrder: { ...value.cellOrder },
  });
  const rejects = (mutate, pattern, base = keyedFingerprint) => {
    const record = clone(base);
    mutate(record);
    assert.throws(
      () => assertDatasetFingerprint(record, 'Saved dataset fingerprint'),
      error => error instanceof TypeError && pattern.test(error.message),
    );
  };

  assert.doesNotThrow(() => assertDatasetFingerprint(clone(keyedFingerprint), 'Saved'));
  assert.doesNotThrow(() => assertDatasetFingerprint(clone(anndataFingerprint), 'Saved'));

  // Exact top-level and cellOrder keys.
  rejects(record => { record.legacyDimension = 3; }, /exact keys|legacyDimension/);
  rejects(record => { record.cellOrder.layoutKey = 'X_umap_3d'; }, /cellOrder/);
  // A record with a mapping but a cell order without its embedding is a
  // schema violation, not the pre-mapping file.
  rejects(record => { delete record.cellOrder.embedding; }, /cellOrder/);
  rejects(record => { record.cellOrder.digest = 'ABCDEF0123456789'; }, /hexadecimal/);
  rejects(record => { record.cellOrder.dimension = 4; }, /dimension/);
  // An embedding is named by its obsm key and columns, one column per axis.
  rejects(
    record => { record.cellOrder.embedding = { key: 'X_umap_3d', columns: [0, 1] }; },
    /exactly 3 columns/,
    anndataFingerprint,
  );
  rejects(
    record => { record.cellOrder.embedding = { key: 'X_umap_3d', columns: null }; },
    /must be a list/,
    anndataFingerprint,
  );
  // The mapping must validate and already be canonical.
  rejects(record => { record.dataMapping.kind = 'h5ad'; }, /kind/);
  rejects(
    record => {
      const { kind, embeddings, knn, geneNames, expression, latent, vectorFields } = record.dataMapping;
      record.dataMapping = { kind, geneNames, embeddings, knn, expression, latent, vectorFields };
    },
    /canonical form/,
  );
  rejects(
    record => {
      record.dataMapping.vectorFields = [
        { key: 'velocity_umap_3d', embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } },
        { key: 'drift_umap_2d', embedding: { key: 'X_umap_2d', columns: [0, 1] } },
      ];
    },
    /sorted/,
  );
  rejects(
    record => {
      record.dataMapping.embeddings.defaults = { '1d': null, '2d': null, '3d': null };
    },
    /at least one default/,
  );
  rejects(
    record => {
      record.dataMapping.embeddings = record.dataMapping.embeddings.defaults;
    },
    /missing defaults, enabled/,
  );

  // A record without its name, or with a name that is not a string, is a
  // schema violation; null is a dataset that states none.
  rejects(record => { delete record.name; }, /exact keys/);
  rejects(record => { record.name = 7; }, /name/);
  assert.doesNotThrow(() => assertDatasetFingerprint({ ...clone(keyedFingerprint), name: null }, 'Saved'));
});

test('cell-order digests are stable and dataset-wide', () => {
  const cellOrder = Array.from({ length: 4096 }, (_value, index) => index);
  const first = fingerprintOf(makeDatasetState({ cellOrder, pages: emptyPages() }));
  const second = fingerprintOf(makeDatasetState({ cellOrder, pages: emptyPages() }));
  assert.equal(second.cellOrder.digest, first.cellOrder.digest);

  for (const row of [0, 1, 2047, 4094, 4095]) {
    const moved = [...cellOrder];
    const other = row === 0 ? 1 : row - 1;
    [moved[row], moved[other]] = [moved[other], moved[row]];
    const mutated = fingerprintOf(makeDatasetState({ cellOrder: moved, pages: emptyPages() }));
    assert.notEqual(
      mutated.cellOrder.digest,
      first.cellOrder.digest,
      `swapping rows ${row} and ${other} must change the digest`,
    );
  }
});

async function verifyRefusals() {
  const saved = fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_tsne_2d',
  }));
  const verify = (state, manager = makeDataSourceManager()) => (
    verifySessionFingerprint({ dataSourceManager: manager, state }, saved)
  );
  return {
    counts: await verify(makeDatasetState({ cellOrder: [0, 1, 2, 3, 4], pages: emptyPages() })),
    copy: await verify(
      makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }),
      { getCurrentIdentityId: () => null },
    ),
    kind: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      kind: 'anndata',
    })),
    slot: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_umap_2d'),
      mapping: keyedMapping({
        embeddings: keyedEmbeddings(
          ['X_tsne_2d', 'X_umap_3d'],
          { d2: 'X_tsne_2d', d3: 'X_umap_3d' },
        ),
      }),
    })),
    group: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      mapping: keyedMapping({ geneNames: 'column:symbol' }),
    })),
    missingEmbedding: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_tsne_2d'),
    })),
    digest: await verify(makeDatasetState({
      cellOrder: [5, 4, 3, 2, 1, 0],
      pages: emptyPages(),
    })),
    // Choosing None leaves zero cells open: no dataset at all.
    none: await verify(
      { pointCount: 0, varData: { fields: [] } },
      { getCurrentIdentityId: () => null },
    ),
    missingFields: describeMissingRequiredFields(
      makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }),
      { obs: ['cell_type', 'donor'], var: ['Cd8a'] },
    ),
  };
}

test('mismatch messages are written for the person loading the session', async () => {
  const refusals = await verifyRefusals();
  for (const [cause, message] of Object.entries(refusals)) {
    assert.equal(typeof message, 'string', cause);
    assert.doesNotMatch(
      message,
      /fingerprint|digest|hash|manifest|chunk|serializ|null|undefined|[A-Z]{4,}/,
      cause,
    );
    assert.match(message, /\.$/, cause);
  }
  // Each cause has its own sentence.
  assert.equal(new Set(Object.values(refusals)).size, Object.keys(refusals).length);
});

test('with no dataset open there are no counts to compare, only a dataset to name', async () => {
  const { none } = await verifyRefusals();
  assert.match(none, /^No dataset is open\. /);
  assert.doesNotMatch(none, /\b0 cells\b/);
});

test('every refusal tells the person loading the session what to do next', async () => {
  const refusals = await verifyRefusals();
  const withoutNextStep = Object.entries(refusals)
    .filter(([, message]) => !/Open the dataset|Open its dataset|Load the version|Re-create/.test(message))
    .map(([cause, message]) => `${cause}: ${message}`);
  assert.deepEqual(withoutNextStep, []);
});

test('a session saved with a duplicated gene restores on the reloaded dataset', async () => {
  // Duplicating a gene appends a user-defined var field. That field is session
  // content, restored from the session itself, so it is not part of the
  // dataset the fingerprint describes: the reloaded dataset, which has only
  // its source genes, must still be accepted.
  const source = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: selectionPages(SELECTED_ROWS),
  });
  source.varData.fields.push({
    key: 'GENE_A (copy)',
    _isUserDefined: true,
    _userDefinedId: 'user_var_1',
    _fieldSource: 'var',
  });
  const savedFingerprint = fingerprintOf(source);
  assert.equal(savedFingerprint.varCount, VAR_COUNT);
  const bundle = await makeSerializer(source).createSessionBundle();

  const reloaded = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  assert.equal(reloaded.varData.fields.length, VAR_COUNT);
  await withNotificationHarness(async () => {
    await makeSerializer(reloaded).restoreFromBlob(bundle);
  });
  assert.deepEqual(restoredSelection(reloaded), [SELECTED_ROWS]);
});

test('the digest of a compact 1D/2D embedding equals the digest of its zero-padded XYZ triples', () => {
  for (const dimension of [1, 2]) {
    const compact = positionsForCellOrder([3, 0, 5, 1, 4, 2], dimension);
    const padded = new Float32Array((compact.length / dimension) * 3);
    for (let cell = 0; cell < compact.length / dimension; cell++) {
      for (let axis = 0; axis < dimension; axis++) {
        padded[cell * 3 + axis] = compact[cell * dimension + axis];
      }
    }
    assert.equal(
      digestCellOrder(compact, dimension),
      digestCellOrder(padded, 3),
      `${dimension}D digest must not depend on the in-memory layout`,
    );
  }
  assert.throws(
    () => digestCellOrder(new Float32Array(5), 2),
    /2 values per cell/,
  );
});
