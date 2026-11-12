import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  bytesToU32LE,
  u32ToBytesLE,
} from '../assets/js/app/session/bundle/format.js';
import {
  readBundle,
} from '../assets/js/app/session/bundle/reader.js';
import {
  writeBundle,
} from '../assets/js/app/session/bundle/writer.js';
import {
  CELL_SET_BITSET,
  CELL_SET_RUNS,
  CELL_SET_SORTED_DELTA,
  decodeCellSet,
  encodeCellSet,
} from '../assets/js/app/session/codecs/cell-set.js';
import { joinValue, splitValue } from '../assets/js/app/history/value-parts.js';
import {
  decodeUvarint,
  encodeUvarints,
  uvarintLength,
  writeUvarint,
} from '../assets/js/app/session/codecs/varint.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  datasetFingerprintMatches,
  getDatasetFingerprint,
} from '../assets/js/app/session/session-context.js';
import {
  createInMemoryAnnDataDimensionManager,
  describeOwnVarCount,
  inMemoryAnnDataMapping,
} from './helpers/in-memory-anndata.mjs';
import { cellOrderDigest } from '../assets/js/data/cell-order-digest.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { installStateDomains } from '../assets/js/app/state/domains/index.js';
import { createActiveFieldDomain } from '../assets/js/app/state/domains/active-field.js';
import { createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { createCameraPathDomain } from '../assets/js/app/state/domains/camera-path.js';
import { createHighlightsDomain } from '../assets/js/app/state/domains/highlights.js';
import { createViewsDomain } from '../assets/js/app/state/domains/views.js';
import { sameValue } from '../assets/js/app/state/domains/same-value.js';
import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';

// The `layout` state domain reads and arranges the floating panels.
const layoutSource = await readFile(
  new URL('../assets/js/app/state/domains/layout.js', import.meta.url),
  'utf8',
);
const mainSource = await readFile(
  new URL('../assets/js/app/main.js', import.meta.url),
  'utf8',
);

function installDocumentById(entries = {}) {
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  globalThis.document = {
    getElementById(id) {
      return Object.hasOwn(entries, id) ? entries[id] : null;
    },
  };
  globalThis.Event = class {
    constructor(type) {
      this.type = type;
    }
  };
  return () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousEvent === undefined) delete globalThis.Event;
    else globalThis.Event = previousEvent;
  };
}

/**
 * A viewer with one view and no GPU: every method the state calls on it
 * exists; `onCall(name)` hears each call it does not answer itself.
 */
function headlessViewer(onCall = () => {}) {
  const own = {
    getSnapshotViews: () => [],
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }),
    getCentroidFlags: () => ({ points: false, labels: false }),
    getCamerasLocked: () => true,
    getFocusedViewId: () => 'live',
    isDisposed: () => false,
  };
  return new Proxy(own, {
    get: (target, key) => (key in target ? target[key] : (...args) => {
      onCall(String(key), args);
      return undefined;
    }),
  });
}

/**
 * A DataState of `cellCount` cells, every one open, with the given obs and
 * var fields and one highlight page. Its layouts are those of
 * `dimensionManager`; by default one 2-D layout whose positions are not
 * held (no centroid is computed).
 */
function headlessState({ obs = [], vars = [], cellCount = 6, dimensionManager = null, viewer = headlessViewer() } = {}) {
  const state = new DataState(viewer, null);
  state.pointCount = cellCount;
  state.cellIdentity = createCellIdentity({ nObs: cellCount });
  state.highlightArray = new Uint8Array(cellCount);
  state.colorsArray = new Uint8Array(cellCount * 4);
  state.categoryTransparency = new Uint8Array(cellCount).fill(1);
  state.cellVisibilityMask = new Uint8Array(cellCount).fill(1);
  state.dimensionManager = dimensionManager ?? {
    getViewLayout: () => 'umap',
    getLayout: () => ({ layoutKey: 'umap', dimension: 2, provenance: null }),
    getNormTransform: () => null,
    getRegisteredLayouts: () => [],
    getResidentPositions: () => null,
    unshownBytes: () => 0,
    trimUnshown: () => null,
  };
  state.obsData = { fields: obs };
  state.varData = { fields: vars };
  state._resetViewContexts();
  state.ensureHighlightPage();
  return { state, viewer };
}

/** The Camera Path's own state (`exportPath`), with `overrides`. */
function exactCameraPath(overrides = {}) {
  return {
    autoplay: false,
    defaultSpeed: '30',
    easing: 'linear',
    keyframes: [],
    loopBackKeyframeId: null,
    loopPlayback: false,
    nextIndex: 1,
    positionMethod: 'linear',
    rotationMethod: 'linear',
    ...overrides,
  };
}

/** A `field-overlays` value holding only `userFields`. */
function overlaysWith(userFields) {
  return { renamedFields: [], renamedCategories: [], deletedFields: [], userFields };
}

/** A user category field of three cells, as the `field-overlays` value holds it. */
function userCategoryField(id, key, values = Uint8Array.of(0, 1, 0)) {
  return {
    id,
    source: 'obs',
    kind: 'category',
    key,
    deleted: false,
    purged: false,
    createdAt: 123,
    sourceField: null,
    operation: null,
    categories: ['A', 'B'],
    codes: { cells: null, values },
    sourcePages: [],
    overlapStrategy: 'first',
    overlapLabel: null,
    intersectionLabels: null,
    uncoveredLabel: null,
    palette: null,
  };
}

test('integer codecs reject coercion, overflow, non-canonical bytes and bad offsets', () => {
  for (const invalid of ['1', -1, 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(() => uvarintLength(invalid), /integer|safe|value/i);
    assert.throws(() => writeUvarint(new Uint8Array(10), 0, invalid), /integer|safe|value/i);
  }
  for (const invalid of ['1', -1, 1.5, 2 ** 32]) {
    assert.throws(() => u32ToBytesLE(invalid), /u32|integer/i);
  }
  for (const value of [0, 1, 127, 128, 16383, 16384, 2 ** 31, 2 ** 32 + 5, 2 ** 53 - 1]) {
    const bytes = encodeUvarints([value]);
    assert.equal(bytes.byteLength, uvarintLength(value));
    assert.deepEqual(decodeUvarint(bytes), { value, nextOffset: bytes.byteLength });
  }
  assert.throws(
    () => decodeUvarint(new Uint8Array([0x80, 0x00])),
    /canonical/i,
  );
  assert.throws(
    () => decodeUvarint(new Uint8Array([0x00]), -1),
    /offset/i,
  );
});

test('cell sets round-trip in every encoding and the writer keeps the smallest', async () => {
  const cellCount = 1000;
  const decode = bytes => decodeCellSet(bytes, { cellCount, signal: null });
  // Sparse: sorted deltas. Dense and scattered: a bitset. Contiguous: runs.
  const sparse = Uint32Array.from([3, 500, 999]);
  const dense = Uint32Array.from({ length: 600 }, (_value, index) => index + Math.floor(index / 2));
  const contiguous = Uint32Array.from({ length: 400 }, (_value, index) => 100 + index);
  for (const [cells, encoding] of [
    [sparse, CELL_SET_SORTED_DELTA],
    [dense, CELL_SET_BITSET],
    [contiguous, CELL_SET_RUNS],
  ]) {
    const bytes = encodeCellSet(cells, { cellCount });
    assert.equal(bytes[0], encoding);
    assert.deepEqual(await decode(bytes), cells);
  }
  // Unsorted input is sorted once; duplicates and out-of-range cells are refused.
  assert.deepEqual(await decode(encodeCellSet([999, 3, 500], { cellCount })), sparse);
  assert.throws(() => encodeCellSet([3, 3], { cellCount }), /duplicates/i);
  assert.throws(() => encodeCellSet([cellCount], { cellCount }), /exceeds/i);
  assert.throws(() => encodeCellSet([2 ** 32], { cellCount }), /32-bit/i);

  // Trailing bytes, bits past the cell count, and an unknown encoding.
  const delta = encodeCellSet(sparse, { cellCount });
  const withTrailing = new Uint8Array(delta.byteLength + 1);
  withTrailing.set(delta);
  await assert.rejects(decode(withTrailing), /trailing/i);
  const bitset = encodeCellSet(dense, { cellCount });
  const pastEnd = bitset.slice();
  pastEnd[pastEnd.byteLength - 1] |= 0x80;
  await assert.rejects(decodeCellSet(pastEnd, { cellCount: 999, signal: null }), /wrong length|past/i);
  await assert.rejects(decode(Uint8Array.from([9, 0])), /encoding 9/);
  // Nothing writes a set relative to another (the former encodings 3 and 4): they are refused as unknown.
  for (const encoding of [3, 4]) await assert.rejects(decode(Uint8Array.from([encoding, 1, 0, 0, 0, 0])), new RegExp(`encoding ${encoding} is not one`));
  // Runs that overlap or touch are not canonical.
  await assert.rejects(decode(Uint8Array.from([CELL_SET_RUNS, 2, 0, 2, 0, 2])), /separated/i);
});

test('stored value keys named like prototype members join as own keys', async () => {
  const value = JSON.parse(
    '{"__proto__": {"polluted": true}, "constructor": [1], "prototype": "x", "nested": {"__proto__": 2}}',
  );
  assert.ok(Object.hasOwn(value, '__proto__'), 'the fixture itself holds an own "__proto__" key');
  // As a session file and the autosave keep a history value (`value-parts.js`):
  // its skeleton as JSON text, its arrays by digest.
  const arrays = new Map();
  const skeleton = JSON.parse(JSON.stringify(await splitValue(value, arrays)));
  const decoded = joinValue(skeleton, digest => arrays.get(digest));
  for (const key of ['__proto__', 'constructor', 'prototype', 'nested']) {
    assert.ok(Object.hasOwn(decoded, key), `"${key}" is an own key`);
  }
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(decoded, '__proto__').value, { polluted: true });
  assert.deepEqual(decoded.constructor, [1]);
  assert.equal(decoded.prototype, 'x');
  assert.ok(Object.hasOwn(decoded.nested, '__proto__'));
  assert.equal(Object.getPrototypeOf(decoded.nested), Object.prototype);
  assert.equal(({}).polluted, undefined, 'no prototype was touched');
});

test('bundle framing rejects chunk-count mismatches and trailing bytes', async () => {
  const manifest = {
    chunks: [{
      id: 'test/chunk',
      storedBytes: 1,
    }],
  };
  assert.throws(
    () => writeBundle({ manifest, chunks: [] }),
    /chunk count/i,
  );

  const blob = writeBundle({
    manifest,
    chunks: [new Uint8Array([7])],
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const withTrailing = new Uint8Array(bytes.byteLength + 1);
  withTrailing.set(bytes);
  const { chunkStream } = await readBundle(new Blob([withTrailing]), {
    signal: null,
    onProgress: null,
  });
  await assert.rejects(
    async () => {
      for await (const _chunk of chunkStream) {
        // Consume the public iterator completely.
      }
    },
    /trailing/i,
  );
});

/**
 * The data mapping of a dataset whose one embedding is an in-memory 3D
 * layout (keyed "3d").
 */
const IN_MEMORY_3D_MAPPING = Object.freeze(inMemoryAnnDataMapping());

/**
 * What a session fingerprint reads from a DataState besides its counts: the
 * live positions, the dimension manager that owns them as the live view's 3D
 * layout, the live layout key and the dataset's data mapping.
 */
function fingerprintOwners(positionsArray) {
  const dimensionManager = createInMemoryAnnDataDimensionManager({
    positions: positionsArray,
    dimension: 3,
  });
  return {
    positionsArray,
    dimensionManager,
    getDataMapping: () => IN_MEMORY_3D_MAPPING,
    describeMappingVarCount: describeOwnVarCount,
    getViewLayoutKey: viewId => dimensionManager.getViewLayout(viewId),
    // The manifest's `requires` is read from the focused view's state.
    getActiveViewId: () => 'live',
  };
}

test('dataset fingerprints are complete exact identities, never partial matches', async () => {
  const manager = {
    getCurrentIdentityId() {
      return 'dataset-a';
    },
  };
  const positionsArray = new Float32Array([
    0.5, 0.25, 0.125,
    -0.5, -0.25, -0.125,
    0.75, 0.375, 0.1875,
  ]);
  const fingerprint = await getDatasetFingerprint({
    dataSourceManager: manager,
    state: {
      getViewDimensionLevel: () => 3,
      pointCount: 3,
      ...fingerprintOwners(positionsArray),
      varData: { fields: [{}, {}] },
    },
  });
  assert.deepEqual(fingerprint, {
    datasetId: 'dataset-a',
    // The manager publishes no metadata, so no name.
    name: null,
    cellCount: 3,
    varCount: 2,
    cellOrder: {
      embedding: { key: 'X_umap', columns: [0, 1, 2] },
      dimension: 3,
      // An in-memory layout: the digest of the coordinates it holds.
      digest: cellOrderDigest(positionsArray, 3),
    },
    dataMapping: IN_MEMORY_3D_MAPPING,
  });
  assert.equal(datasetFingerprintMatches(fingerprint, { ...fingerprint }), true);

  for (const incomplete of [
    { datasetId: 'dataset-a' },
    { ...fingerprint, sourceType: 'local-user' },
    { ...fingerprint, cellCount: '3' },
    { ...fingerprint, legacyDatasetName: 'A' },
    { ...fingerprint, cellOrder: { ...fingerprint.cellOrder, digest: undefined } },
    { ...fingerprint, cellOrder: { ...fingerprint.cellOrder, dimension: 4 } },
    { ...fingerprint, cellOrder: { ...fingerprint.cellOrder, digest: 'NOTHEX0123456789' } },
    { ...fingerprint, cellOrder: { dimension: 3, digest: fingerprint.cellOrder.digest } },
    {
      ...fingerprint,
      cellOrder: { ...fingerprint.cellOrder, embedding: { key: 'X_umap', columns: null } },
    },
    {
      ...fingerprint,
      cellOrder: { ...fingerprint.cellOrder, embedding: { key: 'X_umap', columns: [0, 1] } },
    },
    { ...fingerprint, dataMapping: { ...IN_MEMORY_3D_MAPPING, kind: 'export' } },
    { ...fingerprint, dataMapping: { ...IN_MEMORY_3D_MAPPING, dimension: 3 } },
    { ...fingerprint, dataMapping: null },
  ]) {
    assert.throws(
      () => datasetFingerprintMatches(fingerprint, incomplete),
      /fingerprint|exact|cellCount|dimension|hexadecimal|embedding|dataMapping/i,
    );
  }
  // The name is for messages only; it is not part of the identity.
  assert.equal(
    datasetFingerprintMatches(fingerprint, { ...fingerprint, name: 'Another title' }),
    true,
  );
  // Every other field is part of the identity, the embedding and the data
  // mapping included.
  for (const different of [
    { ...fingerprint, datasetId: 'dataset-b' },
    { ...fingerprint, cellCount: 4 },
    { ...fingerprint, varCount: 3 },
    {
      ...fingerprint,
      cellOrder: { ...fingerprint.cellOrder, embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } },
    },
    { ...fingerprint, cellOrder: { ...fingerprint.cellOrder, digest: '0123456789abcdef' } },
    { ...fingerprint, dataMapping: { ...IN_MEMORY_3D_MAPPING, geneNames: 'column:symbol' } },
  ]) {
    assert.equal(datasetFingerprintMatches(fingerprint, different), false);
  }

  // A record carrying only the four scalars is not a fingerprint.
  assert.throws(
    () => datasetFingerprintMatches(
      {
        datasetId: 'dataset-a',
        cellCount: 3,
        varCount: 2,
      },
      fingerprint,
    ),
    /must contain exactly/,
  );
});

test('the state domains use only the owners they are given, never one found in the page', () => {
  const restoreDocument = installDocumentById({
    sidebar: { id: 'legacy-sidebar', querySelectorAll: () => [] },
  });
  try {
    const { state, viewer } = headlessState();
    assert.throws(
      () => installStateDomains({
        domains: createDomainRegistry(),
        state,
        viewer,
        sidebar: null,
        refreshUi() {},
        cinematicCamera: null,
        figureExport: null,
        analysis: async () => null,
        getDockable: () => null,
        openCells: {},
      }),
      /sidebar/i,
    );
    // The control inventory the settings and layout domains read.
    assert.throws(
      () => createUiControlSerializer({ sidebar: null }),
      /sidebar/i,
    );
  } finally {
    restoreDocument();
  }
});

/** Count every load, and every change of the active field, of `state`. */
function countActiveFieldWork(state) {
  const counts = { loads: 0, mutations: 0 };
  state.ensureFieldLoaded = async () => {
    counts.loads += 1;
  };
  state.ensureVarFieldLoaded = async () => {
    counts.loads += 1;
  };
  for (const method of ['setActiveField', 'setActiveVarField', 'clearActiveField']) {
    state[method] = () => {
      counts.mutations += 1;
      return null;
    };
  }
  return counts;
}

test('active-field restore rejects an unavailable exact field before loading or mutation', async () => {
  const { state, viewer } = headlessState({
    obs: [{ key: 'known', kind: 'category', loaded: false }],
  });
  const counts = countActiveFieldWork(state);
  let refreshes = 0;
  const active = createActiveFieldDomain({ state, viewer, refreshUi: () => { refreshes += 1; } });
  await assert.rejects(
    active.restore({ views: [{ source: 'obs', key: 'removed' }] }),
    /names the obs field "removed", which this dataset does not have now/,
  );
  assert.equal(counts.loads, 0);
  assert.equal(counts.mutations, 0);
  assert.equal(refreshes, 0);
  assert.deepEqual(active.capture(), { views: [null] });
});

test('active-field restore threads cancellation through deferred field loading', async () => {
  const { state, viewer } = headlessState({
    obs: [{ key: 'cell_type', kind: 'category', loaded: false }],
  });
  const counts = countActiveFieldWork(state);
  const controller = new AbortController();
  const exactAbort = new Error('exact active-field restore cancellation');
  let receivedSignal = null;
  let started;
  const loadStarted = new Promise(resolve => { started = resolve; });
  state.ensureFieldLoaded = (_index, options) => {
    receivedSignal = options?.signal ?? null;
    started();
    return new Promise((resolve, reject) => {
      receivedSignal.addEventListener(
        'abort',
        () => reject(receivedSignal.reason),
        { once: true },
      );
    });
  };
  const active = createActiveFieldDomain({ state, viewer, refreshUi() {} });

  // The history hands each owner the load's signal (`history.js` `putBack`).
  const rejection = assert.rejects(
    active.restore({ views: [{ source: 'obs', key: 'cell_type' }] }, { signal: controller.signal }),
    error => error === exactAbort,
  );
  await loadStarted;
  controller.abort(exactAbort);

  await rejection;
  assert.strictEqual(receivedSignal, controller.signal);
  assert.equal(counts.mutations, 0);
});

/** Count every load, and every batch of filter changes, of `state`. */
function countFilterWork(state) {
  const counts = { loads: 0, batches: 0 };
  state.ensureFieldLoaded = async () => {
    counts.loads += 1;
  };
  state.ensureVarFieldLoaded = async () => {
    counts.loads += 1;
  };
  state.beginBatch = () => {
    counts.batches += 1;
  };
  state.endBatch = () => {
    counts.batches += 1;
  };
  return counts;
}

test('filter restore resolves every field it names before any preload or batch mutation', async () => {
  const { state, viewer } = headlessState({
    obs: [{ key: 'cluster', kind: 'category', loaded: false }],
  });
  const counts = countFilterWork(state);
  const filters = createFiltersDomain({ state, viewer, refreshUi() {} });
  await assert.rejects(
    filters.restore({
      views: [[
        { field: { source: 'obs', key: 'cluster' }, off: true },
        { field: { source: 'obs', key: 'removed' }, off: true },
      ]],
    }),
    /names the obs field "removed", which this dataset does not have now/,
  );
  assert.equal(counts.loads, 0);
  assert.equal(counts.batches, 0);
  assert.deepEqual(filters.capture(), { views: [[]] });
});

/** An observation field and a gene, neither read yet, filtered off. */
function unreadScoreAndGene() {
  const { state, viewer } = headlessState({
    obs: [{ key: 'score', kind: 'continuous', loaded: false }],
    vars: [{ key: 'GAPDH', kind: 'continuous', loaded: false }],
  });
  const value = {
    views: [[
      { field: { source: 'obs', key: 'score' }, off: true },
      { field: { source: 'var', key: 'GAPDH' }, off: true },
    ]],
  };
  return { state, viewer, value };
}

test('filter restore cancels every deferred preload before batch mutation', async () => {
  const { state, viewer, value } = unreadScoreAndGene();
  const counts = countFilterWork(state);
  const controller = new AbortController();
  const exactAbort = new Error('exact filter restore cancellation');
  const receivedSignals = [];
  let started;
  const bothStarted = new Promise(resolve => { started = resolve; });
  const waitForAbort = options => {
    const signal = options?.signal ?? null;
    receivedSignals.push(signal);
    if (receivedSignals.length === 2) started();
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(signal.reason),
        { once: true },
      );
    });
  };
  state.ensureFieldLoaded = (_index, options) => waitForAbort(options);
  state.ensureVarFieldLoaded = (_index, options) => waitForAbort(options);
  const filters = createFiltersDomain({ state, viewer, refreshUi() {} });

  const rejection = assert.rejects(
    filters.restore(value, { signal: controller.signal }),
    error => error === exactAbort,
  );
  await bothStarted;
  controller.abort(exactAbort);

  await rejection;
  assert.deepEqual(receivedSignals, [
    controller.signal,
    controller.signal,
  ]);
  assert.equal(counts.batches, 0);
});

test('filter restore retires and drains sibling preloads after one exact failure', async () => {
  const { state, viewer, value } = unreadScoreAndGene();
  const counts = countFilterWork(state);
  const exactFailure = new Error('exact observation preload failure');
  let siblingSignal = null;
  let siblingSettled = false;
  state.ensureFieldLoaded = async () => {
    throw exactFailure;
  };
  state.ensureVarFieldLoaded = (_index, options) => {
    siblingSignal = options?.signal ?? null;
    return new Promise((resolve, reject) => {
      siblingSignal.addEventListener(
        'abort',
        () => {
          siblingSettled = true;
          reject(siblingSignal.reason);
        },
        { once: true },
      );
    });
  };
  const filters = createFiltersDomain({ state, viewer, refreshUi() {} });

  await assert.rejects(filters.restore(value), error => error === exactFailure);
  assert.equal(siblingSignal instanceof AbortSignal, true);
  assert.equal(siblingSettled, true);
  assert.equal(counts.batches, 0);
});

test('field-overlay restore validates its lists before replacing any registry', async () => {
  const { state, viewer } = headlessState({
    obs: [{ key: 'score', kind: 'continuous', values: Float32Array.of(0, 1, 2, 3, 4, 5), loaded: true }],
  });
  state.getRenameRegistry().setFieldRename('obs', 'score', 'Score');
  state.applyFieldOverlays();
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi() {} });
  const before = overlays.capture();
  let replacements = 0;
  for (const registry of [state.getRenameRegistry(), state.getDeleteRegistry()]) {
    const fromEntries = registry.fromEntries.bind(registry);
    registry.fromEntries = entries => {
      replacements += 1;
      return fromEntries(entries);
    };
  }
  const userFields = state.getUserDefinedFieldsRegistry();
  const adoptFields = userFields.adoptFields.bind(userFields);
  userFields.adoptFields = fields => {
    replacements += 1;
    return adoptFields(fields);
  };
  await assert.rejects(
    overlays.restore({
      renamedFields: [],
      renamedCategories: [],
      deletedFields: [],
      userFields: 'not-an-array',
    }),
    /must list renames, deletions and user fields/,
  );
  assert.equal(replacements, 0);
  assert.deepEqual(overlays.capture(), before);
});

test('field-overlay restore of an earlier value reconstructs exact categorical user-defined codes', async () => {
  const { state, viewer } = headlessState({
    cellCount: 3,
    obs: [{ key: 'score', kind: 'continuous', values: Float32Array.of(0, 1, 2), loaded: true }],
  });
  state.upsertUserDefinedCategoricalField({
    key: 'restored_groups',
    categories: ['A', 'B'],
    codes: Uint8Array.of(0, 1, 0),
  });
  state.getRenameRegistry().setFieldRename('obs', 'score', 'Original score');
  state.applyFieldOverlays();
  const registry = state.getUserDefinedFieldsRegistry();
  const [previousField] = registry.getAllFields();
  const previousCodes = previousField.codes;
  let overlayApplications = 0;
  const applyFieldOverlays = state.applyFieldOverlays.bind(state);
  state.applyFieldOverlays = () => {
    overlayApplications += 1;
    return applyFieldOverlays();
  };
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi() {} });
  const earlier = overlays.capture();

  await overlays.restore(overlaysWith([]));
  assert.equal(registry.getField(previousField._userDefinedId), undefined);
  assert.deepEqual(state.getRenameRegistry().toEntries().fields, []);

  await overlays.restore(earlier);
  const restoredField = registry.getField(previousField._userDefinedId);
  assert.strictEqual(restoredField.codes, previousCodes);
  assert.deepEqual(Array.from(restoredField.codes), [0, 1, 0]);
  assert.equal(restoredField.loaded, true);
  assert.deepEqual(state.getRenameRegistry().toEntries().fields, [{ source: 'obs', key: 'score', name: 'Original score' }]);
  assert.ok(sameValue(overlays.capture(), earlier));
  // The overlays are read again once for each restore that changed them.
  assert.equal(overlayApplications, 2);
});

test('camera path owner failures are public restore failures', () => {
  const failure = new Error('camera path rejected');
  const path = exactCameraPath();
  const cameraPath = createCameraPathDomain({
    cinematicCamera: {
      exportPath: () => structuredClone(path),
      restorePath() {
        throw failure;
      },
    },
  });
  assert.throws(
    () => cameraPath.restore(exactCameraPath({ loopPlayback: true })),
    error => error === failure,
  );
  // A page without the Camera Path holds no path, and cannot take one.
  const none = createCameraPathDomain({ cinematicCamera: null });
  assert.equal(none.capture(), null);
  assert.doesNotThrow(() => none.restore(null));
  assert.throws(
    () => none.restore(path),
    /Camera Path is not available on this page/,
  );
});

test('a camera path put back with autoplay on is a setting, never a start', () => {
  let starts = 0;
  const restored = [];
  const owner = {
    path: exactCameraPath(),
    exportPath() {
      return structuredClone(this.path);
    },
    restorePath(value) {
      restored.push(structuredClone(value));
      this.path = structuredClone(value);
    },
    startAutoplay() {
      starts += 1;
      return true;
    },
  };
  const cameraPath = createCameraPathDomain({ cinematicCamera: owner });
  cameraPath.restore(exactCameraPath({ autoplay: true, defaultSpeed: '20' }));
  assert.deepEqual(restored, [exactCameraPath({ autoplay: true, defaultSpeed: '20' })]);
  assert.equal(starts, 0);
  // What is shown is not put back again.
  cameraPath.restore(exactCameraPath({ autoplay: true, defaultSpeed: '20' }));
  assert.equal(restored.length, 1);
  assert.equal(starts, 0);
});

test('highlight restore rejects an active page it does not hold before replacing state', async () => {
  const { state } = headlessState();
  const initialPages = state.highlightPages;
  const initialActive = state.activePageId;
  const highlights = createHighlightsDomain({ state, refreshUi() {} });

  await assert.rejects(
    highlights.restore({
      active: 'missing-id',
      pages: [{
        id: 'page_2',
        name: 'Chosen by label',
        color: '#112233',
        groups: [],
      }],
    }),
    /The highlight page shown, "missing-id", is not among the pages to restore/,
  );
  assert.equal(state.highlightPages, initialPages);
  assert.equal(state.activePageId, initialActive);
});

test('highlight constructors publish explicit enabled state and the highlights value names fields', () => {
  const owner = Object.create(highlightStateMethods);
  owner.pointCount = 3;
  owner.cellIdentity = createCellIdentity({ nObs: 3 });
  owner.obsData = {
    fields: [
      {
        key: 'cluster',
        kind: 'category',
        categories: [false],
      },
      {
        key: 'score',
        kind: 'continuous',
      },
    ],
  };
  owner.varData = { fields: [] };
  owner.highlightPages = [{
    id: 'page_1',
    name: 'Page 1',
    color: '#112233',
    highlightedGroups: [],
  }];
  owner.activePageId = 'page_1';
  owner._highlightIdCounter = 0;
  owner.getCellIndicesForCategory = () => Uint32Array.from([0, 2]);
  owner.getCellIndicesForRange = () => Uint32Array.from([1]);
  owner._recomputeHighlightArray = () => {};
  owner._notifyHighlightChange = () => {};

  const category = highlightStateMethods.addHighlightFromCategory.call(
    owner,
    0,
    0,
    'obs',
  );
  const range = highlightStateMethods.addHighlightFromRange.call(
    owner,
    1,
    0.25,
    0.75,
    'obs',
  );
  const direct = highlightStateMethods.addHighlightDirect.call(owner, {
    type: 'lasso',
    label: 'Lasso selection',
    cellIndices: new Uint32Array([0, 1]),
  });
  assert.equal(category.enabled, true);
  assert.equal(range.enabled, true);
  assert.deepEqual(Object.keys(direct).sort(), [
    'cellCount',
    'cellIndices',
    'enabled',
    'id',
    'label',
    'type',
  ]);

  owner.getHighlightPages = () => owner.highlightPages;
  owner.getActivePageId = () => owner.activePageId;
  const { pages } = createHighlightsDomain({ state: owner, refreshUi() {} }).capture();
  const [categoryGroup, rangeGroup, directGroup] = pages[0].groups;
  // Field-bound groups are held by name; positions are resolved on restore.
  assert.deepEqual(Object.keys(categoryGroup).sort(), [
    'category',
    'cells',
    'enabled',
    'field',
    'id',
    'label',
    'type',
  ]);
  assert.deepEqual(categoryGroup.field, { source: 'obs', key: 'cluster' });
  assert.equal(categoryGroup.category, false);
  assert.deepEqual(Object.keys(rangeGroup).sort(), [
    'cells',
    'enabled',
    'field',
    'id',
    'label',
    'range',
    'type',
  ]);
  assert.deepEqual(rangeGroup.field, { source: 'obs', key: 'score' });
  assert.deepEqual(rangeGroup.range, { min: 0.25, max: 0.75 });
  assert.deepEqual(Object.keys(directGroup).sort(), [
    'cells',
    'enabled',
    'id',
    'label',
    'type',
  ]);
});

test('user-defined codes that do not fit the open cells are refused before the field changes', async () => {
  const { state, viewer } = headlessState({ cellCount: 3 });
  state.upsertUserDefinedCategoricalField({
    key: 'restored_groups',
    categories: ['A', 'B'],
    codes: Uint8Array.of(0, 1, 0),
  });
  const registry = state.getUserDefinedFieldsRegistry();
  const [template] = registry.getAllFields();
  const codes = template.codes;
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi() {} });
  const before = overlays.capture();
  const mismatched = structuredClone(before);
  mismatched.userFields[0].codes = { cells: null, values: Uint8Array.of(0, 1) };
  await assert.rejects(
    overlays.restore(mismatched),
    /A column of 2 values does not fit the 3 cells of this dataset/,
  );
  assert.strictEqual(template.codes, codes);
  assert.ok(sameValue(overlays.capture(), before));
});

test('a user category field put back publishes its codes at once, loaded, with centroids every copy shares', async () => {
  const { state, viewer } = headlessState({
    cellCount: 3,
    dimensionManager: createInMemoryAnnDataDimensionManager({
      positions: Float32Array.from([
        0, 0, 0,
        1, 2, 3,
        4, 4, 4,
      ]),
      dimension: 3,
    }),
  });
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi() {} });
  const item = userCategoryField('field-a', 'restored_groups');
  await overlays.restore(overlaysWith([item]));

  const template = state.getUserDefinedFieldsRegistry().getField('field-a');
  const injected = state.obsData.fields.find(field => field._userDefinedId === 'field-a');
  assert.notEqual(injected, template, 'the view holds its own copy');
  assert.ok(template.codes instanceof Uint8Array);
  assert.deepEqual(Array.from(template.codes), [0, 1, 0]);
  assert.equal(template.loaded, true);
  assert.equal(injected.codes, template.codes);
  assert.equal(injected.loaded, true);
  // The value carries no centroids: restoring the codes computed them from
  // the resident layout's positions, and every copy shares them.
  assert.deepEqual([...template._normalizedLayouts], ['3d']);
  assert.deepEqual(template.centroidsByLayout.get('3d'), [
    { category: 'A', position: [2, 2, 2], n_points: 2 },
    { category: 'B', position: [1, 2, 3], n_points: 1 },
  ]);
  assert.strictEqual(injected.centroidsByLayout, template.centroidsByLayout);
  assert.strictEqual(injected._normalizedLayouts, template._normalizedLayouts);

  const [captured] = overlays.capture().userFields;
  assert.ok(sameValue(captured, item));
  assert.equal(Object.hasOwn(captured, 'centroidsByLayout'), false);
  assert.equal(Object.hasOwn(captured, 'normalizedLayouts'), false);
});

test('views restore refuses a value that does not list its views before changing any view', async () => {
  const calls = [];
  const viewer = headlessViewer(name => calls.push(name));
  const { state } = headlessState({ viewer });
  let refreshes = 0;
  const views = createViewsDomain({ state, viewer, refreshUi: () => { refreshes += 1; } });
  calls.length = 0;
  for (const malformed of [
    null,
    { layout: 'single', focus: 0, liveHidden: false, camerasLinked: true },
    { layout: 'single', focus: 0, liveHidden: false, camerasLinked: true, views: [] },
  ]) {
    await assert.rejects(
      views.restore(malformed),
      /must list the live view and each kept view/,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(refreshes, 0);
  assert.equal(state.getActiveViewId(), 'live');
});

test('dockable session layout uses stable DOM ids only', () => {
  assert.doesNotMatch(
    layoutSource,
    /summaryText\s*===\s*panelId|fall back to the summary label/i,
  );
  assert.doesNotMatch(
    layoutSource,
    /best-effort|cascadeToSafePosition|normalizeFloatGeometry/,
  );
  assert.match(
    layoutSource,
    /stable nonempty DOM id|stable.*id/i,
  );
});

test('main wires the session files, the dataset history and the view carry directly, without optional probes', () => {
  assert.doesNotMatch(mainSource, /getAnalysisWindowManager\?\.\(|datasetHistories\?\.(?:open|begin|loadSaved)\(/);
  assert.match(
    mainSource,
    /const analysisWindowManager = comparisonModule\.getAnalysisWindowManager\(\);\s*return \{ comparisonModule, analysisWindowManager \};/,
  );
  // The analysis module is imported on demand; the state domains wait for
  // its arrival, and a re-read of the open cells (the view carry) keeps the
  // analyses through the same owners (the page's state-domain registry).
  assert.match(mainSource, /const analysisRefs = analysisCode\.then\(/);
  assert.match(mainSource, /analysis: \(\) => analysisRefs,/);
  assert.match(mainSource, /const viewCarry = createViewCarry\(\{ domains: getStateDomains\(\) \}\);/);
  // Session files hold the history of the dataset shown.
  assert.match(mainSource, /getHistory: \(\) => datasetHistories\?\.current\(\) \?\? null/);
  // The history goes first whenever a runtime is replaced, before anything of the dataset is touched.
  assert.match(mainSource, /function retireDatasetInteractions\(\{ keepHistory = false \} = \{\}\) \{\s*if \(!keepHistory\) void datasetHistories\?\.retire\(\);/);
  // It begins once the starting view is applied, and the first coloring
  // (`first-coloring.js`) shown before it: part of the state it opens on.
  assert.match(mainSource, /restoreAdvertisedDatasetState\(\{[\s\S]*?\}\);\s*(?:\/\/[^\n]*\n\s*)+if \(!keepHistory && \(stateOutcome\.status === 'ready' \|\| stateOutcome\.status === 'ready-state-error'\)[\s\S]*?await colorByFirstField\(\{[\s\S]*?\}\);[\s\S]*?\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(publication\.isCurrent\(\) === true\) await beginShownDatasetHistory\(shownHistory\);/);
  // The same dataset read again on other cells keeps its history and puts no starting view back.
  assert.match(mainSource, /const keepHistory = loadMethod === DATA_LOAD_METHODS\.SUBSAMPLE && \(datasetHistories\?\.current\(\) \?\? null\) !== null;/);
  assert.match(mainSource, /const shownHistory = keepHistory\s*\? datasetHistories\.current\(\)\s*: datasetHistories\.open\(/);
  assert.match(mainSource, /const stateOutcome = keepHistory\s*\? \{ status: 'ready' \}\s*: await restoreAdvertisedDatasetState\(/);
});

test('u32 decoding still round-trips the exact maximum value', () => {
  assert.equal(bytesToU32LE(u32ToBytesLE(0xffff_ffff)), 0xffff_ffff);
});
