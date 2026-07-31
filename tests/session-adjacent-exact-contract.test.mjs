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
  decodeDeltaUvarint,
  encodeDeltaUvarint,
} from '../assets/js/app/session/codecs/delta-varint.js';
import {
  decodeTable,
  encodeTable,
} from '../assets/js/app/session/codecs/table-codec.js';
import {
  decodeUvarint,
  pushUvarint,
} from '../assets/js/app/session/codecs/varint.js';
import {
  UserDefinedFieldsRegistry,
} from '../assets/js/app/registries/user-defined-fields.js';
import {
  capture as captureCinematicCamera,
  restore as restoreCinematicCamera,
} from '../assets/js/app/session/contributors/cinematic-camera.js';
import {
  ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE,
  capture as captureAnalysisArtifacts,
  restore as restoreAnalysisArtifact,
} from '../assets/js/app/session/contributors/analysis-artifacts.js';
import {
  DataLayer,
} from '../assets/js/app/analysis/data/data-layer.js';
import {
  capture as captureFieldOverlays,
  restore as restoreFieldOverlays,
} from '../assets/js/app/session/contributors/field-overlays.js';
import {
  restore as restoreHighlightCells,
} from '../assets/js/app/session/contributors/highlights-cells.js';
import * as highlightsCellsContributor from '../assets/js/app/session/contributors/highlights-cells.js';
import {
  capture as captureHighlightMeta,
  restore as restoreHighlightMeta,
} from '../assets/js/app/session/contributors/highlights-meta.js';
import * as highlightsMetaContributor from '../assets/js/app/session/contributors/highlights-meta.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  capture as captureUserDefinedCodes,
  restore as restoreUserDefinedCodes,
} from '../assets/js/app/session/contributors/user-defined-codes.js';
import {
  buildSessionContext,
  createSessionRestoreTransaction,
  datasetFingerprintMatches,
  getDatasetFingerprint,
} from '../assets/js/app/session/session-context.js';
import {
  isSessionRestoreCanceledError,
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  initSessionControls,
} from '../assets/js/app/ui/modules/session-controls.js';
import {
  createKeyframeStore,
} from '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js';
import {
  createPlaybackController,
} from '../assets/js/app/ui/modules/cinematic-camera/playback-controller.js';
import {
  restoreActiveFields,
} from '../assets/js/app/state-serializer/active-fields.js';
import {
  createFilterSerializer,
} from '../assets/js/app/state-serializer/filters.js';
import {
  restoreMultiview,
} from '../assets/js/app/state-serializer/multiview.js';

const dockableSource = await readFile(
  new URL('../assets/js/app/session/contributors/dockable-layout.js', import.meta.url),
  'utf8',
);
const analysisArtifactsSource = await readFile(
  new URL('../assets/js/app/session/contributors/analysis-artifacts.js', import.meta.url),
  'utf8',
);
const mainSource = await readFile(
  new URL('../assets/js/app/main.js', import.meta.url),
  'utf8',
);

function exactCameraState(navigationMode = 'orbit') {
  return {
    navigationMode,
    orbit: {
      radius: 3,
      targetRadius: 3,
      theta: 0.25,
      phi: 1,
      target: [0, 0, 0],
    },
    freefly: {
      position: [0, 0, 3],
      yaw: 0,
      pitch: 0,
    },
  };
}

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

test('integer and delta codecs reject coercion, overflow, duplicates, and trailing bytes', async () => {
  for (const invalid of ['1', -1, 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(() => pushUvarint(invalid, []), /integer|safe|value/i);
  }
  for (const invalid of ['1', -1, 1.5, 2 ** 32]) {
    assert.throws(() => u32ToBytesLE(invalid), /u32|integer/i);
  }

  assert.throws(
    () => decodeUvarint(new Uint8Array([0x80, 0x00])),
    /canonical/i,
  );
  assert.throws(
    () => decodeUvarint(new Uint8Array([0x00]), -1),
    /offset/i,
  );
  assert.throws(
    () => encodeDeltaUvarint([3, 3]),
    /duplicate|strict/i,
  );
  assert.throws(
    () => encodeDeltaUvarint([2 ** 32]),
    /uint32|index/i,
  );

  const canonical = encodeDeltaUvarint([1, 4]);
  const withTrailing = new Uint8Array(canonical.byteLength + 1);
  withTrailing.set(canonical);
  await assert.rejects(
    decodeDeltaUvarint(withTrailing, {
      maxCount: null,
      maxIndex: null,
      signal: null,
    }),
    /trailing/i,
  );
});

test('table codec accepts only its closed current schema and consumes every byte', () => {
  assert.throws(
    () => encodeTable({
      rowCount: '2',
      columns: [{ name: 'x', dtype: 'uint8', data: new Uint8Array([1, 2]) }],
    }),
    /rowCount.*integer/i,
  );
  assert.throws(
    () => encodeTable({
      rowCount: 2,
      columns: [{ name: 'x', dtype: 'uint8', data: [1, 2] }],
    }),
    /Uint8Array|typed array/i,
  );
  assert.throws(
    () => encodeTable({
      rowCount: 2,
      columns: [{ name: 'flag', dtype: 'bool', data: [0, 1] }],
    }),
    /boolean/i,
  );

  const encoded = encodeTable({
    rowCount: 2,
    columns: [{ name: 'x', dtype: 'uint8', data: new Uint8Array([1, 2]) }],
  });
  const withTrailing = new Uint8Array(encoded.byteLength + 1);
  withTrailing.set(encoded);
  assert.throws(() => decodeTable(withTrailing), /trailing/i);

  const meta = {
    rowCount: 1,
    columns: [{
      name: 'x',
      dtype: 'uint8',
      byteLength: 1,
    }],
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const missingEncoding = new Uint8Array(4 + metaBytes.byteLength + 1);
  missingEncoding.set(u32ToBytesLE(metaBytes.byteLength), 0);
  missingEncoding.set(metaBytes, 4);
  missingEncoding[missingEncoding.length - 1] = 4;
  assert.throws(
    () => decodeTable(missingEncoding),
    /exact keys|encoding/i,
  );
});

test('table codec preserves every legal prototype-named column as an ordinary own record', () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );
  const encoded = encodeTable({
    rowCount: 1,
    columns: prototypeNames.map((name, index) => ({
      name,
      dtype: 'uint8',
      data: Uint8Array.of(index),
    })),
  });

  const decoded = decodeTable(encoded);
  assert.equal(Object.getPrototypeOf(decoded.columns), Object.prototype);
  assert.deepEqual(Object.keys(decoded.columns), prototypeNames);
  for (const [index, name] of prototypeNames.entries()) {
    assert.equal(Object.hasOwn(decoded.columns, name), true, name);
    assert.deepEqual(Array.from(decoded.columns[name]), [index], name);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(decoded.columns, name),
      {
        configurable: true,
        enumerable: true,
        value: decoded.columns[name],
        writable: true,
      },
      name,
    );
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    prototypeDescriptors,
  );
});

test('table codec boolean decode preserves every prototype-named column and exact descriptor', () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );
  const expectedValues = prototypeNames.map((_, index) => [
    index % 2 === 0,
    index % 3 === 0,
  ]);
  const decoded = decodeTable(encodeTable({
    rowCount: 2,
    columns: prototypeNames.map((name, index) => ({
      name,
      dtype: 'bool',
      data: expectedValues[index],
    })),
  }));

  assert.equal(Object.getPrototypeOf(decoded.columns), Object.prototype);
  assert.deepEqual(Object.keys(decoded.columns), prototypeNames);
  for (const [index, name] of prototypeNames.entries()) {
    assert.equal(Object.hasOwn(decoded.columns, name), true, name);
    assert.deepEqual(
      Array.from(decoded.columns[name]),
      expectedValues[index].map(Number),
      name,
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(decoded.columns, name),
      {
        configurable: true,
        enumerable: true,
        value: decoded.columns[name],
        writable: true,
      },
      name,
    );
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    prototypeDescriptors,
  );
});

test('table codec string decode preserves every prototype-named column and exact descriptor', () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );
  const expectedValues = prototypeNames.map((name, index) => [
    `${name}-${index}-first`,
    `${name}-${index}-second`,
  ]);
  const decoded = decodeTable(encodeTable({
    rowCount: 2,
    columns: prototypeNames.map((name, index) => ({
      name,
      dtype: 'string',
      data: expectedValues[index],
    })),
  }));

  assert.equal(Object.getPrototypeOf(decoded.columns), Object.prototype);
  assert.deepEqual(Object.keys(decoded.columns), prototypeNames);
  for (const [index, name] of prototypeNames.entries()) {
    assert.equal(Object.hasOwn(decoded.columns, name), true, name);
    assert.deepEqual(decoded.columns[name], expectedValues[index], name);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(decoded.columns, name),
      {
        configurable: true,
        enumerable: true,
        value: decoded.columns[name],
        writable: true,
      },
      name,
    );
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    prototypeDescriptors,
  );
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

function makeSessionSerializer(contributors, pointCount = 3) {
  return new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount,
      getViewDimensionLevel: () => 3,
      positionsArray: new Float32Array(pointCount * 3),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors,
  });
}

function exactSessionChunk(contributorId) {
  return {
    id: 'test/exact',
    contributorId,
    priority: 'eager',
    kind: 'json',
    codec: 'none',
    label: 'Exact test chunk',
    datasetDependent: false,
    payload: { exact: true },
  };
}

function userDefinedCodesChunkMeta(payload, overrides = {}) {
  return {
    id: 'user-defined/codes/field-a',
    contributorId: 'user-defined-codes',
    priority: 'lazy',
    kind: 'binary',
    codec: 'gzip',
    label: 'User-defined codes: restored_groups',
    datasetDependent: true,
    storedBytes: payload.byteLength,
    uncompressedBytes: payload.byteLength,
    ...overrides,
  };
}

function highlightCellsChunkMeta(payload, overrides = {}) {
  return {
    id: 'highlights/cells/highlight_1',
    contributorId: 'highlights-cells',
    priority: 'lazy',
    kind: 'binary',
    codec: 'gzip',
    label: 'Highlight cells: Two cells',
    datasetDependent: true,
    storedBytes: payload.byteLength,
    uncompressedBytes: payload.byteLength,
    ...overrides,
  };
}

function categoricalSessionMeta(id, key) {
  return {
    id,
    source: 'obs',
    kind: 'category',
    key,
    categories: ['A', 'B'],
    isDeleted: false,
    isPurged: false,
    codesLength: 3,
    codesType: 'Uint8Array',
    centroidsByDim: {},
    normalizedDims: [],
    sourceField: null,
    operation: null,
    sourcePages: [],
    overlapStrategy: 'first',
    overlapLabel: null,
    intersectionLabels: null,
    uncoveredLabel: null,
    createdAt: 123,
  };
}

function makeHighlightSessionState({ pages, activePageId, events }) {
  const state = Object.create(highlightStateMethods);
  state.getDatasetGeneration = () => 0;
  state.getViewDimensionLevel = () => 3;
  state.obsData = { fields: [] };
  state.pointCount = 4;
  state.positionsArray = new Float32Array(12);
  state.varData = { fields: [] };
  state.highlightPages = pages;
  state.activePageId = activePageId;
  state._highlightPageIdCounter = Math.max(
    ...pages.map(page => Number(page.id.slice('page_'.length))),
  );
  state._highlightIdCounter = Math.max(
    0,
    ...pages.flatMap(page => page.highlightedGroups).map(
      group => Number(group.id.slice('highlight_'.length)),
    ),
  );
  state._recomputeHighlightArray = () => {
    events.push({
      type: 'recompute',
      complete: state.highlightPages.every(page => (
        page.highlightedGroups.every(group => (
          group.cellIndices.length === group.cellCount
        ))
      )),
    });
  };
  state._notifyHighlightPageChange = () => {
    events.push({
      type: 'page',
      complete: state.highlightPages.every(page => (
        page.highlightedGroups.every(group => (
          group.cellIndices.length === group.cellCount
        ))
      )),
    });
  };
  state._notifyHighlightChange = () => {
    events.push({
      type: 'highlight',
      complete: state.highlightPages.every(page => (
        page.highlightedGroups.every(group => (
          group.cellIndices.length === group.cellCount
        ))
      )),
    });
  };
  return state;
}

function makeHighlightSerializer(state, contributors) {
  return new SessionSerializer({
    state,
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors,
  });
}

async function withNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'failDownload',
    'info',
    'startDownload',
    'updateDownload',
    'warning',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  notifications.completeDownload = () => {};
  notifications.dismissDownload = () => {};
  notifications.failDownload = () => {};
  notifications.info = () => {};
  notifications.startDownload = () => 'session-adjacent-test';
  notifications.updateDownload = () => {};
  notifications.warning = () => {};
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
  }
}

async function withSessionNotificationRecorder(run) {
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
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  const events = [];
  const cancelHandlers = new Map();
  let nextId = 0;
  notifications.startDownload = (_label, _total, options) => {
    const id = `generic-session-${++nextId}`;
    events.push({ id, kind: 'start' });
    cancelHandlers.set(id, options.onCancel);
    return id;
  };
  notifications.updateDownload = () => {};
  notifications.completeDownload = id => {
    events.push({ id, kind: 'complete' });
  };
  notifications.dismissDownload = id => {
    events.push({ id, kind: 'dismiss' });
  };
  notifications.failDownload = (id, message) => {
    events.push({ id, kind: 'fail', message });
  };
  notifications.info = message => {
    events.push({ kind: 'info', message });
  };
  notifications.error = message => {
    events.push({ kind: 'ui-error', message });
  };
  notifications.success = message => {
    events.push({ kind: 'ui-success', message });
  };
  try {
    return await run(events, {
      cancel(id) {
        const handler = cancelHandlers.get(id);
        if (typeof handler !== 'function') {
          throw new Error(`Notification "${id}" has no cancel handler.`);
        }
        handler();
      },
    });
  } finally {
    for (const [name, original] of originals) {
      notifications[name] = original;
    }
  }
}

test('session capture rejects open/coercive chunks before bundle encoding', async () => {
  const contributorId = 'exact-contributor';
  const serializer = makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [{
        ...exactSessionChunk(contributorId),
        label: undefined,
        datasetDependent: 'false',
        legacyLabel: 'old',
      }];
    },
    restore() {},
  }]);
  await assert.rejects(
    serializer.createSessionBundle(),
    /exact keys|label|datasetDependent|legacyLabel/i,
  );
});

test('generic manifests require every registered singleton in exact contributor order', async () => {
  const profiles = [{
    id: 'core/state',
    contributorId: 'core-state',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Core state',
    datasetDependent: true,
  }, {
    id: 'cinematic/camera',
    contributorId: 'cinematic-camera',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Cinematic camera path',
    datasetDependent: true,
  }];
  const contributors = profiles.map(profile => ({
    id: profile.contributorId,
    capture() {
      return [{ ...profile, payload: {} }];
    },
    restore() {
      throw new Error('Malformed singleton manifest reached a contributor.');
    },
  }));
  const bundle = await makeSessionSerializer(contributors).createSessionBundle();
  const malformedBundles = [
    {
      message: /require singleton chunk "cinematic\/camera"/i,
      bundle: await rewriteSessionBundle(bundle, (manifest, chunks) => {
        manifest.chunks.pop();
        chunks.pop();
      }),
    },
    {
      message: /contributor groups.*registered order/i,
      bundle: await rewriteSessionBundle(bundle, (manifest, chunks) => {
        manifest.chunks.reverse();
        chunks.reverse();
      }),
    },
    {
      message: /canonical built-in chunk "cinematic\/camera"/i,
      bundle: await rewriteSessionBundle(bundle, manifest => {
        manifest.chunks[1].id = 'cinematic/camera-alias';
      }),
    },
  ];

  await withNotificationHarness(async () => {
    for (const malformed of malformedBundles) {
      await assert.rejects(
        makeSessionSerializer(contributors).restoreFromBlob(
          malformed.bundle,
        ),
        malformed.message,
      );
    }
  });
});

test('dataset mismatch rejects atomically before any contributor restore', async () => {
  const contributorId = 'exact-contributor';
  const bundle = await makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [exactSessionChunk(contributorId)];
    },
    restore() {},
  }], 3).createSessionBundle();

  let restoreCalls = 0;
  const serializer = makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [];
    },
    restore() {
      restoreCalls += 1;
    },
  }], 4);
  await withNotificationHarness(async () => {
    await assert.rejects(
      serializer.restoreFromBlob(bundle),
      error => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /different dataset than the one that is open/);
        assert.match(error.message, /3 cells .* 4 cells/);
        return true;
      },
    );
  });
  assert.equal(restoreCalls, 0);
});

test('generic Blob and pre-delegation URL cancellation dismiss exactly once', async () => {
  const contributorId = 'cancel-probe';
  const bundle = await makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [exactSessionChunk(contributorId)];
    },
    restore() {},
  }]).createSessionBundle();

  let blobEnteredResolve;
  const blobEntered = new Promise(resolve => {
    blobEnteredResolve = resolve;
  });
  const blobSerializer = makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [exactSessionChunk(contributorId)];
    },
    async restore(ctx) {
      blobEnteredResolve();
      await new Promise((resolve, reject) => {
        ctx.abortSignal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  }]);
  await withSessionNotificationRecorder(async (events, controls) => {
    const restore = blobSerializer.restoreFromBlob(bundle);
    const rejection = assert.rejects(
      restore,
      error => (
        error?.name === 'AbortError'
        && isSessionRestoreCanceledError(error)
      ),
    );
    await blobEntered;
    controls.cancel('generic-session-1');
    await rejection;
    assert.deepEqual(
      events.filter(event => event.id === 'generic-session-1'),
      [
        { id: 'generic-session-1', kind: 'start' },
        { id: 'generic-session-1', kind: 'dismiss' },
      ],
    );
  });

  let urlEnteredResolve;
  const urlEntered = new Promise(resolve => {
    urlEnteredResolve = resolve;
  });
  const urlSerializer = new SessionSerializer({
    state: {
      getViewDimensionLevel: () => 3,
      pointCount: 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: {
      fetch(_url, options) {
        urlEnteredResolve();
        return new Promise((resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    },
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [],
  });
  await withSessionNotificationRecorder(async (events, controls) => {
    const restore = urlSerializer.restoreFromUrl(
      'https://example.invalid/session.cellucid-session',
      { cache: 'no-store' },
    );
    const rejection = assert.rejects(
      restore,
      error => (
        error?.name === 'AbortError'
        && isSessionRestoreCanceledError(error)
      ),
    );
    await urlEntered;
    controls.cancel('generic-session-1');
    await rejection;
    assert.deepEqual(
      events.filter(event => event.id === 'generic-session-1'),
      [
        { id: 'generic-session-1', kind: 'start' },
        { id: 'generic-session-1', kind: 'dismiss' },
      ],
    );
  });
});

test('session controls treat exact cancel and supersession as silent no-ops', async () => {
  const contributorId = 'session-controls-probe';
  const bundle = await makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [exactSessionChunk(contributorId)];
    },
    restore() {},
  }]).createSessionBundle();

  function createButton() {
    let clickHandler = null;
    return {
      addEventListener(type, handler) {
        assert.equal(type, 'click');
        clickHandler = handler;
      },
      click() {
        if (clickHandler === null) {
          throw new Error('Session control click handler was not registered.');
        }
        return clickHandler();
      },
    };
  }

  async function runUiCase(mode) {
    let enteredResolve;
    const entered = new Promise(resolve => {
      enteredResolve = resolve;
    });
    let restoreCalls = 0;
    const serializer = makeSessionSerializer([{
      id: contributorId,
      capture() {
        return [exactSessionChunk(contributorId)];
      },
      async restore(ctx) {
        restoreCalls += 1;
        if (restoreCalls !== 1) return;
        enteredResolve();
        await new Promise((resolve, reject) => {
          ctx.abortSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    }]);
    serializer._pickSessionFile = async () => bundle;
    const loadButton = createButton();
    let afterLoads = 0;
    initSessionControls({
      dom: { loadBtn: loadButton },
      sessionSerializer: serializer,
      onAfterLoad() {
        afterLoads += 1;
      },
    });

    const originalConsoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args);
    };
    try {
      await withSessionNotificationRecorder(async (events, controls) => {
        const click = loadButton.click();
        await entered;
        let replacement = null;
        if (mode === 'cancel') {
          controls.cancel('generic-session-1');
        } else {
          replacement = serializer.restoreFromBlob(bundle);
        }
        await click;
        if (replacement !== null) await replacement;
        assert.deepEqual(
          events.filter(event => event.id === 'generic-session-1'),
          [
            { id: 'generic-session-1', kind: 'start' },
            { id: 'generic-session-1', kind: 'dismiss' },
          ],
        );
        assert.deepEqual(
          events.filter(
            event => (
              event.kind === 'ui-error'
              || event.kind === 'ui-success'
            ),
          ),
          [],
        );
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.deepEqual(consoleErrors, []);
    assert.equal(afterLoads, 0);
  }

  await runUiCase('cancel');
  await runUiCase('supersede');
});

test('highlight restore commits once after exact lazy cells and preserves old state on failure', async () => {
  const sourcePages = [
    {
      id: 'page_1',
      name: 'First',
      color: '#112233',
      highlightedGroups: [
        {
          id: 'highlight_1',
          type: 'lasso',
          label: 'First cells',
          enabled: true,
          cellIndices: [0, 2],
          cellCount: 2,
        },
      ],
    },
    {
      id: 'page_2',
      name: 'Second',
      color: '#445566',
      highlightedGroups: [
        {
          id: 'highlight_2',
          type: 'proximity',
          label: 'Second cells',
          enabled: false,
          cellIndices: [1, 3],
          cellCount: 2,
        },
      ],
    },
  ];
  const sourceState = makeHighlightSessionState({
    pages: sourcePages,
    activePageId: 'page_2',
    events: [],
  });
  const sourceSerializer = makeHighlightSerializer(
    sourceState,
    [highlightsMetaContributor, highlightsCellsContributor],
  );
  const bundle = await sourceSerializer.createSessionBundle();

  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  try {
    await withNotificationHarness(async () => {
      const successEvents = [];
      const successState = makeHighlightSessionState({
        pages: [{
          id: 'page_9',
          name: 'Old',
          color: '#778899',
          highlightedGroups: [],
        }],
        activePageId: 'page_9',
        events: successEvents,
      });
      await makeHighlightSerializer(
        successState,
        [highlightsMetaContributor, highlightsCellsContributor],
      ).restoreFromBlob(bundle);

      assert.deepEqual(
        successEvents,
        [
          { type: 'recompute', complete: true },
          { type: 'page', complete: true },
          { type: 'highlight', complete: true },
        ],
      );
      assert.equal(successState.activePageId, 'page_2');
      assert.deepEqual(
        successState.highlightPages.map(page => page.id),
        ['page_1', 'page_2'],
      );
      assert.deepEqual(
        successState.highlightPages.flatMap(page => (
          page.highlightedGroups.map(group => group.id)
        )),
        ['highlight_1', 'highlight_2'],
      );
      assert.deepEqual(
        successState.highlightPages.flatMap(page => (
          page.highlightedGroups.map(group => [...group.cellIndices])
        )),
        [[0, 2], [1, 3]],
      );
      assert.ok(
        successState.highlightPages.every(page => (
          page.highlightedGroups.every(group => (
            group.cellIndices instanceof Uint32Array
          ))
        )),
      );

      const corruptCellsContributor = {
        id: highlightsCellsContributor.id,
        capture(ctx) {
          return highlightsCellsContributor.capture(ctx).map(
            (chunk, index) => {
              if (index !== 0) return chunk;
              const payload = new Uint8Array(chunk.payload.byteLength + 1);
              payload.set(chunk.payload);
              return { ...chunk, payload };
            },
          );
        },
        restore: highlightsCellsContributor.restore,
      };
      const corruptBundle = await makeHighlightSerializer(
        sourceState,
        [highlightsMetaContributor, corruptCellsContributor],
      ).createSessionBundle();
      const failureEvents = [];
      const oldPages = [{
        id: 'page_9',
        name: 'Old',
        color: '#778899',
        highlightedGroups: [],
      }];
      const failureState = makeHighlightSessionState({
        pages: oldPages,
        activePageId: 'page_9',
        events: failureEvents,
      });
      const oldPageCounter = failureState._highlightPageIdCounter;
      const oldGroupCounter = failureState._highlightIdCounter;
      await assert.rejects(
        makeHighlightSerializer(
          failureState,
          [highlightsMetaContributor, highlightsCellsContributor],
        ).restoreFromBlob(corruptBundle),
        /trailing bytes/i,
      );
      assert.strictEqual(failureState.highlightPages, oldPages);
      assert.equal(failureState.activePageId, 'page_9');
      assert.equal(failureState._highlightPageIdCounter, oldPageCounter);
      assert.equal(failureState._highlightIdCounter, oldGroupCounter);
      assert.deepEqual(failureEvents, []);

      const missingCellsContributor = {
        id: highlightsCellsContributor.id,
        capture(ctx) {
          return highlightsCellsContributor.capture(ctx).slice(0, 1);
        },
        restore: highlightsCellsContributor.restore,
      };
      const incompleteBundle = await makeHighlightSerializer(
        sourceState,
        [highlightsMetaContributor, missingCellsContributor],
      ).createSessionBundle();
      const incompleteEvents = [];
      const incompletePages = [{
        id: 'page_9',
        name: 'Old',
        color: '#778899',
        highlightedGroups: [],
      }];
      const incompleteState = makeHighlightSessionState({
        pages: incompletePages,
        activePageId: 'page_9',
        events: incompleteEvents,
      });
      await assert.rejects(
        makeHighlightSerializer(
          incompleteState,
          [highlightsMetaContributor, highlightsCellsContributor],
        ).restoreFromBlob(incompleteBundle),
        /missing exact cell membership chunks/i,
      );
      assert.strictEqual(incompleteState.highlightPages, incompletePages);
      assert.equal(incompleteState.activePageId, 'page_9');
      assert.deepEqual(incompleteEvents, []);

      const commitFailure = new Error('highlight recompute rejected');
      const commitFailureEvents = [];
      const commitFailurePages = [{
        id: 'page_9',
        name: 'Old',
        color: '#778899',
        highlightedGroups: [],
      }];
      const commitFailureState = makeHighlightSessionState({
        pages: commitFailurePages,
        activePageId: 'page_9',
        events: commitFailureEvents,
      });
      const commitFailurePageCounter =
        commitFailureState._highlightPageIdCounter;
      const commitFailureGroupCounter =
        commitFailureState._highlightIdCounter;
      commitFailureState._recomputeHighlightArray = () => {
        if (commitFailureState.activePageId === 'page_2') {
          throw commitFailure;
        }
        commitFailureEvents.push({
          type: 'recompute',
          complete: true,
        });
      };
      await assert.rejects(
        makeHighlightSerializer(
          commitFailureState,
          [highlightsMetaContributor, highlightsCellsContributor],
        ).restoreFromBlob(bundle),
        error => error === commitFailure,
      );
      assert.strictEqual(
        commitFailureState.highlightPages,
        commitFailurePages,
      );
      assert.equal(commitFailureState.activePageId, 'page_9');
      assert.equal(
        commitFailureState._highlightPageIdCounter,
        commitFailurePageCounter,
      );
      assert.equal(
        commitFailureState._highlightIdCounter,
        commitFailureGroupCounter,
      );
      assert.deepEqual(
        commitFailureEvents,
        [
          { type: 'recompute', complete: true },
          { type: 'page', complete: true },
          { type: 'highlight', complete: true },
        ],
      );
    });
  } finally {
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  }
});

test('dataset fingerprints are complete exact identities, never partial matches', () => {
  const manager = {
    getCurrentSourceType() {
      return 'local-user';
    },
    getCurrentDatasetId() {
      return 'dataset-a';
    },
  };
  const positionsArray = new Float32Array([
    0.5, 0.25, 0.125,
    -0.5, -0.25, -0.125,
    0.75, 0.375, 0.1875,
  ]);
  const fingerprint = getDatasetFingerprint({
    dataSourceManager: manager,
    state: {
      getViewDimensionLevel: () => 3,
      pointCount: 3,
      positionsArray,
      varData: { fields: [{}, {}] },
    },
  });
  assert.deepEqual(fingerprint, {
    sourceType: 'local-user',
    datasetId: 'dataset-a',
    cellCount: 3,
    varCount: 2,
    cellOrder: {
      dimension: 3,
      digest: fingerprint.cellOrder.digest,
    },
  });
  assert.match(fingerprint.cellOrder.digest, /^[0-9a-f]{16}$/);
  assert.equal(datasetFingerprintMatches(fingerprint, { ...fingerprint }), true);

  for (const incomplete of [
    { sourceType: 'local-user', datasetId: 'dataset-a' },
    { ...fingerprint, cellCount: '3' },
    { ...fingerprint, legacyDatasetName: 'A' },
    { ...fingerprint, cellOrder: { dimension: 3 } },
    { ...fingerprint, cellOrder: { dimension: 4, digest: fingerprint.cellOrder.digest } },
    { ...fingerprint, cellOrder: { dimension: 3, digest: 'NOTHEX0123456789' } },
  ]) {
    assert.throws(
      () => datasetFingerprintMatches(fingerprint, incomplete),
      /fingerprint|exact|cellCount|dimension|hexadecimal/i,
    );
  }

  // A record carrying only the four scalars is a session written before cell
  // identity existed. It cannot be checked against anything, so it is refused
  // rather than accepted on the strength of its scalars.
  assert.throws(
    () => datasetFingerprintMatches(
      {
        sourceType: 'local-user',
        datasetId: 'dataset-a',
        cellCount: 3,
        varCount: 2,
      },
      fingerprint,
    ),
    error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /which cells a selection contains/);
      return true;
    },
  );
});

test('session context uses only explicitly supplied current owners', () => {
  const restoreDocument = installDocumentById({
    sidebar: { id: 'legacy-sidebar' },
  });
  try {
    assert.throws(
      () => buildSessionContext({
        state: {},
        viewer: {},
        sidebar: null,
        dataSourceManager: {},
        comparisonModule: null,
        analysisWindowManager: null,
        cinematicCamera: null,
      }, {
        abortSignal: null,
        restoreTransaction: null,
      }),
      /sidebar/i,
    );
  } finally {
    restoreDocument();
  }
});

test('active-field restore rejects an unavailable exact field before loading or mutation', async () => {
  let loadCalls = 0;
  let mutationCalls = 0;
  const restoreDocument = installDocumentById();
  const state = {
    getFields() {
      return [{ key: 'known', kind: 'category' }];
    },
    getVarFields() {
      return [];
    },
    async ensureFieldLoaded() {
      loadCalls += 1;
    },
    async ensureVarFieldLoaded() {
      loadCalls += 1;
    },
    setActiveField() {
      mutationCalls += 1;
    },
    setActiveVarField() {
      mutationCalls += 1;
    },
  };
  try {
    await assert.rejects(
      restoreActiveFields(state, {
        activeFieldKey: 'removed',
        activeFieldSource: 'obs',
      }),
      /field.*removed.*not found|current field/i,
    );
    assert.equal(loadCalls, 0);
    assert.equal(mutationCalls, 0);
  } finally {
    restoreDocument();
  }
});

test('active-field restore threads cancellation through deferred field loading', async () => {
  const field = {
    key: 'cell_type',
    kind: 'category',
    _isDeleted: false,
  };
  const controller = new AbortController();
  const exactAbort = new Error('exact active-field restore cancellation');
  let receivedSignal = null;
  let mutations = 0;
  const state = {
    getFields: () => [field],
    getVarFields: () => [],
    ensureFieldLoaded(_index, options) {
      receivedSignal = options?.signal ?? null;
      return new Promise((resolve, reject) => {
        receivedSignal.addEventListener(
          'abort',
          () => reject(receivedSignal.reason),
          { once: true },
        );
      });
    },
    async ensureVarFieldLoaded() {},
    setActiveField() {
      mutations++;
      return { field };
    },
    setActiveVarField() {
      mutations++;
      return { field };
    },
  };

  const restore = restoreActiveFields(
    state,
    {
      activeFieldKey: 'cell_type',
      activeFieldSource: 'obs',
    },
    { signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort(exactAbort);

  await assert.rejects(restore, error => error === exactAbort);
  assert.strictEqual(receivedSignal, controller.signal);
  assert.equal(mutations, 0);
});

test('filter restore validates the closed candidate before any preload or batch mutation', async () => {
  let preloadCalls = 0;
  let batchCalls = 0;
  const field = {
    key: 'cluster',
    kind: 'category',
    _isDeleted: false,
  };
  const serializer = createFilterSerializer({
    state: {
      getFields() {
        return [field];
      },
      getVarFields() {
        return [];
      },
      async ensureFieldLoaded() {
        preloadCalls += 1;
      },
      async ensureVarFieldLoaded() {
        preloadCalls += 1;
      },
      beginBatch() {
        batchCalls += 1;
      },
      endBatch() {
        batchCalls += 1;
      },
      setVisibilityForCategory() {},
      setColorForCategory() {},
    },
  });

  await assert.rejects(
    serializer.restoreFilters({
      'obs:cluster': {
        kind: 'category',
        filterEnabled: false,
        visibility: {},
        colors: {},
        colormapId: null,
        legacyPalette: 'old',
      },
    }),
    /exact keys|legacyPalette/i,
  );
  assert.equal(preloadCalls, 0);
  assert.equal(batchCalls, 0);
});

test('filter restore cancels every deferred preload before batch mutation', async () => {
  const obsField = {
    key: 'score',
    kind: 'continuous',
    _isDeleted: false,
  };
  const varField = {
    key: 'GAPDH',
    kind: 'continuous',
    _isDeleted: false,
  };
  const controller = new AbortController();
  const exactAbort = new Error('exact filter restore cancellation');
  const receivedSignals = [];
  let batchCalls = 0;
  const waitForAbort = options => {
    const signal = options?.signal ?? null;
    receivedSignals.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(signal.reason),
        { once: true },
      );
    });
  };
  const serializer = createFilterSerializer({
    state: {
      getFields: () => [obsField],
      getVarFields: () => [varField],
      ensureFieldLoaded: (_index, options) => waitForAbort(options),
      ensureVarFieldLoaded: (_index, options) => waitForAbort(options),
      beginBatch() {
        batchCalls++;
      },
      endBatch() {
        batchCalls++;
      },
    },
  });

  const restore = serializer.restoreFilters(
    {
      'obs:score': {
        kind: 'continuous',
        filterEnabled: false,
        filter: null,
        colorRange: null,
        useLogScale: null,
        useFilterColorRange: null,
        outlierFilterEnabled: null,
        outlierThreshold: null,
        colormapId: null,
      },
      'var:GAPDH': {
        kind: 'continuous',
        filterEnabled: false,
        filter: null,
        colorRange: null,
        useLogScale: null,
        useFilterColorRange: null,
        outlierFilterEnabled: null,
        outlierThreshold: null,
        colormapId: null,
      },
    },
    { signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort(exactAbort);

  await assert.rejects(restore, error => error === exactAbort);
  assert.deepEqual(receivedSignals, [
    controller.signal,
    controller.signal,
  ]);
  assert.equal(batchCalls, 0);
});

test('filter restore retires and drains sibling preloads after one exact failure', async () => {
  const obsField = {
    key: 'score',
    kind: 'continuous',
    _isDeleted: false,
  };
  const varField = {
    key: 'GAPDH',
    kind: 'continuous',
    _isDeleted: false,
  };
  const exactFailure = new Error('exact observation preload failure');
  let siblingSignal = null;
  let siblingSettled = false;
  let batchCalls = 0;
  const serializer = createFilterSerializer({
    state: {
      getFields: () => [obsField],
      getVarFields: () => [varField],
      ensureFieldLoaded: async () => {
        throw exactFailure;
      },
      ensureVarFieldLoaded(_index, options) {
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
      },
      beginBatch() {
        batchCalls++;
      },
      endBatch() {
        batchCalls++;
      },
    },
  });

  const restore = serializer.restoreFilters({
    'obs:score': {
      kind: 'continuous',
      filterEnabled: false,
      filter: null,
      colorRange: null,
      useLogScale: null,
      useFilterColorRange: null,
      outlierFilterEnabled: null,
      outlierThreshold: null,
      colormapId: null,
    },
    'var:GAPDH': {
      kind: 'continuous',
      filterEnabled: false,
      filter: null,
      colorRange: null,
      useLogScale: null,
      useFilterColorRange: null,
      outlierFilterEnabled: null,
      outlierThreshold: null,
      colormapId: null,
    },
  });

  await assert.rejects(restore, error => error === exactFailure);
  assert.equal(siblingSignal instanceof AbortSignal, true);
  assert.equal(siblingSettled, true);
  assert.equal(batchCalls, 0);
});

test('field-overlay restore validates all registries and payload before clearing', () => {
  let clears = 0;
  const registry = {
    clear() {
      clears += 1;
    },
    fromJSON() {},
    fromSessionMeta() {},
  };
  assert.throws(
    () => restoreFieldOverlays(
      {
        state: {
          getRenameRegistry() {
            return registry;
          },
          getDeleteRegistry() {
            return registry;
          },
          getUserDefinedFieldsRegistry() {
            return registry;
          },
          applyFieldOverlays() {},
        },
      },
      {},
      {
        renames: { fields: {}, categories: {} },
        deletedFields: { deleted: [], purged: [] },
        userDefinedFields: 'not-an-array',
      },
    ),
    /userDefinedFields.*array/i,
  );
  assert.equal(clears, 0);
});

test('field-overlay rollback reconstructs exact categorical user-defined codes', () => {
  class JsonRegistry {
    constructor(value) {
      this.value = structuredClone(value);
    }
    clear() {
      this.value = {};
    }
    fromJSON(value) {
      this.value = structuredClone(value);
    }
    toJSON() {
      return structuredClone(this.value);
    }
  }

  const userDefinedRegistry = new UserDefinedFieldsRegistry();
  userDefinedRegistry.fromSessionMeta([{
    id: 'field-a',
    source: 'obs',
    kind: 'category',
    key: 'restored_groups',
    categories: ['A', 'B'],
    isDeleted: false,
    isPurged: false,
    codesLength: 3,
    codesType: 'Uint8Array',
    centroidsByDim: {},
    normalizedDims: [],
    sourceField: null,
    operation: null,
    sourcePages: [],
    overlapStrategy: 'first',
    overlapLabel: null,
    intersectionLabels: null,
    uncoveredLabel: null,
    createdAt: 123,
  }]);
  const previousField = userDefinedRegistry.getField('field-a');
  previousField.codes = new Uint8Array([0, 1, 0]);
  const previousCodes = previousField.codes;
  previousField.loaded = true;
  delete previousField._codesLengthHint;
  delete previousField._codesTypeHint;

  const renameRegistry = new JsonRegistry({
    fields: { restored_groups: 'Original groups' },
    categories: {},
  });
  const deleteRegistry = new JsonRegistry({
    deleted: [],
    purged: [],
  });
  let overlayApplications = 0;
  const state = {
    applyFieldOverlays() {
      overlayApplications += 1;
    },
    getDeleteRegistry() {
      return deleteRegistry;
    },
    getRenameRegistry() {
      return renameRegistry;
    },
    getUserDefinedFieldsRegistry() {
      return userDefinedRegistry;
    },
  };
  const transaction = createSessionRestoreTransaction();
  restoreFieldOverlays(
    { state, restoreTransaction: transaction },
    {},
    {
      renames: { fields: {}, categories: {} },
      deletedFields: { deleted: [], purged: [] },
      userDefinedFields: [],
    },
  );
  assert.equal(userDefinedRegistry.getField('field-a'), undefined);

  transaction.rollback();
  const restoredField = userDefinedRegistry.getField('field-a');
  assert.strictEqual(restoredField.codes, previousCodes);
  assert.deepEqual(Array.from(restoredField.codes), [0, 1, 0]);
  assert.equal(restoredField.loaded, true);
  assert.equal(Object.hasOwn(restoredField, '_codesLengthHint'), false);
  assert.equal(Object.hasOwn(restoredField, '_codesTypeHint'), false);
  assert.equal(overlayApplications, 3);
});

test('cinematic-camera owner failures are public restore failures', () => {
  const failure = new Error('camera path rejected');
  const payload = {
    autoplay: false,
    defaultSpeed: '30',
    easing: 'linear',
    keyframes: [],
    invertLook: false,
    lookSensitivity: '5',
    loopBackKeyframeId: null,
    loopPlayback: false,
    moveSpeed: '100',
    navigationMode: 'orbit',
    nextIndex: 1,
    orbitKeySpeed: '40',
    orbitReverse: true,
    planarInvertAxes: false,
    planarPanSpeed: '100',
    planarZoomToCursor: true,
    positionMethod: 'linear',
    rotationMethod: 'linear',
    showOrbitAnchor: true,
  };
  assert.throws(
    () => restoreCinematicCamera(
      {
        cinematicCamera: {
          restoreSessionState() {
            throw failure;
          },
        },
      },
      {},
      payload,
    ),
    error => error === failure,
  );
  assert.throws(
    () => captureCinematicCamera({ cinematicCamera: null }),
    /cinematic camera/i,
  );
});

test('camera autoplay starts only on complete session commit and stops on rollback', () => {
  const restoreTransaction = createSessionRestoreTransaction();
  let restores = 0;
  let starts = 0;
  let stops = 0;
  const payload = {
    autoplay: true,
    defaultSpeed: '30',
    easing: 'linear',
    keyframes: [],
    invertLook: false,
    lookSensitivity: '5',
    loopBackKeyframeId: null,
    loopPlayback: false,
    moveSpeed: '100',
    navigationMode: 'orbit',
    nextIndex: 1,
    orbitKeySpeed: '40',
    orbitReverse: true,
    planarInvertAxes: false,
    planarPanSpeed: '100',
    planarZoomToCursor: true,
    positionMethod: 'linear',
    rotationMethod: 'linear',
    showOrbitAnchor: true,
  };
  const previousPayload = {
    ...payload,
    autoplay: true,
    defaultSpeed: '20',
  };

  restoreCinematicCamera(
    {
      cinematicCamera: {
        exportSessionState() {
          return previousPayload;
        },
        capturePlaybackSnapshot() {
          return {
            state: 'STOPPED',
            globalT: 0,
            camera: exactCameraState(),
          };
        },
        getNavigationMode() {
          return 'orbit';
        },
        restoreSessionState(data) {
          assert.ok(data === payload || data.defaultSpeed === '20');
          restores += 1;
        },
        startAutoplay() {
          starts += 1;
          return true;
        },
        stopAutoplay() {
          stops += 1;
        },
        restorePlaybackSnapshot(snapshot) {
          assert.equal(snapshot.state, 'STOPPED');
          assert.equal(snapshot.globalT, 0);
        },
      },
      restoreTransaction,
    },
    {},
    payload,
  );

  assert.equal(restores, 1);
  assert.equal(starts, 0);
  restoreTransaction.commit();
  assert.equal(starts, 1);
  restoreTransaction.rollback();
  assert.equal(stops, 1);
  assert.equal(restores, 2);

  const invalidResultTransaction = createSessionRestoreTransaction();
  restoreCinematicCamera(
    {
      cinematicCamera: {
        exportSessionState() {
          return previousPayload;
        },
        capturePlaybackSnapshot() {
          return {
            state: 'STOPPED',
            globalT: 0,
            camera: exactCameraState(),
          };
        },
        getNavigationMode() {
          return 'orbit';
        },
        restoreSessionState() {},
        restorePlaybackSnapshot() {},
        startAutoplay() {},
        stopAutoplay() {},
      },
      restoreTransaction: invalidResultTransaction,
    },
    {},
    payload,
  );
  assert.throws(
    () => invalidResultTransaction.commit(),
    /must report a boolean start result/i,
  );
});

test('cinematic rollback restores nonzero playing and paused timeline snapshots exactly', () => {
  const target = exactCameraPathState({
    autoplay: false,
    defaultSpeed: '80',
  });
  for (const state of ['PLAYING', 'PAUSED']) {
    const previousPath = exactCameraPathState({
      autoplay: true,
      defaultSpeed: '20',
    });
    const previousPlayback = {
      state,
      globalT: state === 'PLAYING' ? 0.63 : 0.41,
      camera: exactCameraState(
        state === 'PLAYING' ? 'free' : 'planar',
      ),
    };
    const restoredPlayback = [];
    const transaction = createSessionRestoreTransaction();
    const cameraOwner = {
      exportSessionState() {
        return previousPath;
      },
      capturePlaybackSnapshot() {
        return previousPlayback;
      },
      getNavigationMode() {
        return target.navigationMode;
      },
      restoreSessionState() {},
      restorePlaybackSnapshot(snapshot) {
        restoredPlayback.push(structuredClone(snapshot));
      },
      startAutoplay() {
        return false;
      },
      stopAutoplay() {},
    };
    restoreCinematicCamera(
      {
        cinematicCamera: cameraOwner,
        restoreTransaction: transaction,
      },
      {},
      target,
    );
    transaction.register(`late-${state}`, {
      value: null,
      prepare() {},
      commit() {
        throw new Error(`late ${state} failure`);
      },
      rollback() {},
    });
    assert.throws(
      () => transaction.commit(),
      new RegExp(`late ${state} failure`, 'i'),
    );
    assert.deepEqual(restoredPlayback, [previousPlayback]);
  }
});

test('cinematic transaction stops stale RAF and resumes exact old timeline after late failure', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalPerformance = globalThis.performance;
  const frames = new Map();
  let nextFrameId = 1;
  let nowMs = 1_000;
  globalThis.requestAnimationFrame = callback => {
    const frameId = nextFrameId++;
    frames.set(frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = frameId => {
    frames.delete(frameId);
  };
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => nowMs },
  });

  function cameraAt(theta) {
    const camera = exactCameraState('orbit');
    camera.orbit.theta = theta;
    camera.freefly.position[0] = theta;
    return camera;
  }

  function pathFrom(first, second, defaultSpeed) {
    const store = createKeyframeStore();
    store.add(first);
    store.add(second);
    const exported = store.exportAll();
    return exactCameraPathState({
      autoplay: false,
      defaultSpeed,
      keyframes: exported.keyframes,
      navigationMode: first.navigationMode,
      nextIndex: exported.nextIndex,
    });
  }

  const oldPath = pathFrom(cameraAt(0), cameraAt(2), '20');
  const targetPath = pathFrom(cameraAt(10), cameraAt(12), '80');
  const targetCamera = cameraAt(11);

  function runScenario({ fail }) {
    frames.clear();
    let viewerCamera = cameraAt(0);
    const viewer = {
      getCameraState() {
        return structuredClone(viewerCamera);
      },
      setCameraState(value) {
        viewerCamera = structuredClone(value);
      },
    };
    const store = createKeyframeStore();
    assert.equal(store.importAll({
      keyframes: oldPath.keyframes,
      nextIndex: oldPath.nextIndex,
    }), true);
    let currentPath = structuredClone(oldPath);
    const controller = createPlaybackController({
      viewer,
      keyframeStore: store,
      getInterpolationOptions: () => ({
        positionMethod: currentPath.positionMethod,
        rotationMethod: currentPath.rotationMethod,
        easing: currentPath.easing,
        loop: currentPath.loopPlayback,
        autoPaceSpeed: 1,
      }),
    });
    controller.play();
    controller.seekTo(0.6);
    const oldProgress = controller.getProgress();
    const oldCamera = viewer.getCameraState();
    assert.equal(frames.size, 1);

    const owner = {
      exportSessionState() {
        return structuredClone(currentPath);
      },
      capturePlaybackSnapshot() {
        return {
          state: controller.getState(),
          globalT: controller.getProgress(),
          camera: viewer.getCameraState(),
        };
      },
      getNavigationMode() {
        return viewerCamera.navigationMode;
      },
      restoreSessionState(value) {
        if (controller.getState() !== 'STOPPED') {
          controller.stop({ resetCamera: false });
        }
        currentPath = structuredClone(value);
        assert.equal(store.importAll({
          keyframes: currentPath.keyframes,
          nextIndex: currentPath.nextIndex,
        }), true);
      },
      restorePlaybackSnapshot(snapshot) {
        if (controller.getState() !== 'STOPPED') {
          controller.stop({ resetCamera: false });
        }
        if (snapshot.state !== 'STOPPED') {
          controller.play();
          controller.seekTo(snapshot.globalT);
          if (snapshot.state === 'PAUSED') controller.pause();
        }
        viewer.setCameraState(snapshot.camera);
      },
      startAutoplay() {
        return false;
      },
      stopAutoplay() {
        if (controller.getState() !== 'STOPPED') {
          controller.stop({ resetCamera: false });
        }
      },
    };
    const transaction = createSessionRestoreTransaction();
    restoreCinematicCamera(
      {
        cinematicCamera: owner,
        restoreTransaction: transaction,
      },
      {},
      targetPath,
    );
    assert.equal(controller.getState(), 'STOPPED');
    assert.equal(frames.size, 0);

    viewer.setCameraState(targetCamera);
    transaction.register('test/core-camera', {
      value: null,
      prepare() {},
      commit() {},
      rollback() {
        viewer.setCameraState(oldCamera);
      },
    });
    if (fail) {
      transaction.register('test/late-camera-failure', {
        value: null,
        prepare() {},
        commit() {
          throw new Error('late camera failure');
        },
        rollback() {},
      });
      assert.throws(
        () => transaction.commit(),
        /late camera failure/i,
      );
      assert.deepEqual(viewer.getCameraState(), oldCamera);
      assert.equal(controller.getState(), 'PLAYING');
      assert.equal(controller.getProgress(), oldProgress);
      assert.equal(frames.size, 1);
      nowMs += 100;
      const [frameId, frame] = frames.entries().next().value;
      frames.delete(frameId);
      frame(nowMs);
      assert.ok(controller.getProgress() > oldProgress);
      assert.notDeepEqual(viewer.getCameraState(), targetCamera);
    } else {
      assert.doesNotThrow(() => transaction.commit());
      nowMs += 100;
      assert.equal(frames.size, 0);
      assert.deepEqual(viewer.getCameraState(), targetCamera);
    }
    controller.destroy();
  }

  try {
    runScenario({ fail: false });
    runScenario({ fail: true });
  } finally {
    if (originalRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame === undefined) {
      delete globalThis.cancelAnimationFrame;
    } else {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: originalPerformance,
    });
  }
});

test('cinematic prepare rejects a core navigation-mode mismatch and rolls back', () => {
  const previousPath = exactCameraPathState({
    navigationMode: 'free',
  });
  const targetPath = exactCameraPathState({
    navigationMode: 'orbit',
  });
  const previousPlayback = {
    state: 'STOPPED',
    globalT: 0,
    camera: exactCameraState('free'),
  };
  let currentPath = previousPath;
  let restoredPlayback = null;
  const transaction = createSessionRestoreTransaction();
  restoreCinematicCamera(
    {
      cinematicCamera: {
        exportSessionState() {
          return currentPath;
        },
        capturePlaybackSnapshot() {
          return previousPlayback;
        },
        getNavigationMode() {
          return 'free';
        },
        restoreSessionState(value) {
          currentPath = value;
        },
        restorePlaybackSnapshot(value) {
          restoredPlayback = value;
        },
        startAutoplay() {
          return false;
        },
        stopAutoplay() {},
      },
      restoreTransaction: transaction,
    },
    {},
    targetPath,
  );
  assert.throws(
    () => transaction.commit(),
    /navigation mode.*restored core camera mode/i,
  );
  assert.deepEqual(currentPath, previousPath);
  assert.deepEqual(restoredPlayback, previousPlayback);
});

test('highlight metadata rejects alternate active-page identity before replacing state', () => {
  const initialPages = [{ id: 'initial' }];
  const state = {
    pointCount: 3,
    highlightPages: initialPages,
    activePageId: 'initial',
    _highlightPageIdCounter: 1,
    _highlightIdCounter: 0,
    _recomputeHighlightArray() {},
    _notifyHighlightPageChange() {},
    _notifyHighlightChange() {},
  };

  assert.throws(
    () => restoreHighlightMeta(
      { state },
      {},
      {
        pages: [{
          id: 'page_2',
          name: 'Chosen by label',
          color: '#112233',
          highlightedGroups: [],
        }],
        activePageId: 'missing-id',
        activePageName: 'Chosen by label',
      },
    ),
    /activePageName|exact keys|activePageId/i,
  );
  assert.equal(state.highlightPages, initialPages);
  assert.equal(state.activePageId, 'initial');
});

test('highlight constructors publish explicit enabled state and metadata uses exact tagged variants', () => {
  const owner = Object.create(highlightStateMethods);
  owner.pointCount = 3;
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
  owner.getCellIndicesForCategory = () => [0, 2];
  owner.getCellIndicesForRange = () => [1];
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
  const [{ payload }] = captureHighlightMeta({ state: owner });
  assert.deepEqual(Object.keys(payload.pages[0].highlightedGroups[0]).sort(), [
    'categoryIndex',
    'categoryName',
    'cellCount',
    'enabled',
    'fieldIndex',
    'fieldKey',
    'fieldSource',
    'id',
    'label',
    'type',
  ]);
  assert.deepEqual(Object.keys(payload.pages[0].highlightedGroups[1]).sort(), [
    'cellCount',
    'enabled',
    'fieldIndex',
    'fieldKey',
    'fieldSource',
    'id',
    'label',
    'rangeMax',
    'rangeMin',
    'type',
  ]);
  assert.deepEqual(Object.keys(payload.pages[0].highlightedGroups[2]).sort(), [
    'cellCount',
    'enabled',
    'id',
    'label',
    'type',
  ]);
});

test('highlight cell restore requires staged metadata and rejects count mismatches atomically', async () => {
  const payload = encodeDeltaUvarint([1]);
  const stateWithoutGroup = {
    pointCount: 3,
    highlightPages: [],
  };
  await assert.rejects(
    restoreHighlightCells(
      { state: stateWithoutGroup, abortSignal: null },
      highlightCellsChunkMeta(payload, {
        id: 'highlights/cells/highlight_99',
      }),
      payload,
    ),
    /restore transaction/i,
  );

  const oldPages = [{
    id: 'page_9',
    name: 'Old',
    color: '#778899',
    highlightedGroups: [],
  }];
  const state = {
    pointCount: 3,
    highlightPages: oldPages,
    activePageId: 'page_9',
    _highlightPageIdCounter: 9,
    _highlightIdCounter: 0,
    _recomputeHighlightArray() {},
    _notifyHighlightPageChange() {},
    _notifyHighlightChange() {},
  };
  const restoreTransaction = createSessionRestoreTransaction();
  const context = {
    state,
    abortSignal: null,
    restoreTransaction,
  };
  restoreHighlightMeta(
    context,
    { id: 'highlights/meta' },
    {
      pages: [{
        id: 'page_1',
        name: 'Restored',
        color: '#112233',
        highlightedGroups: [{
          id: 'highlight_1',
          type: 'lasso',
          label: 'Two cells',
          enabled: true,
          cellCount: 2,
        }],
      }],
      activePageId: 'page_1',
    },
  );
  await assert.rejects(
    restoreHighlightCells(
      context,
      highlightCellsChunkMeta(payload),
      payload,
    ),
    /decoded cell count does not match metadata/i,
  );
  restoreTransaction.rollback();
  assert.strictEqual(state.highlightPages, oldPages);
  assert.equal(state.activePageId, 'page_9');
});

test('user-defined codes reject trailing bytes and dataset length mismatch before mutation', async () => {
  function makeState(pointCount) {
    const template = {
      _userDefinedId: 'field-a',
      _isUserDefined: true,
      kind: 'category',
      key: 'restored_groups',
      codes: null,
      loaded: false,
      _codesLengthHint: pointCount,
      _codesTypeHint: 'Uint8Array',
      centroidsByDim: {},
    };
    return {
      template,
      state: {
        pointCount,
        obsData: { fields: [] },
        varData: { fields: [] },
        viewContexts: new Map(),
        getUserDefinedFieldsRegistry() {
          return {
            getField(id) {
              return id === 'field-a' ? template : null;
            },
          };
        },
        getActiveField() {
          return null;
        },
      },
    };
  }

  const trailing = makeState(2);
  const trailingPayload = new Uint8Array([0, 2, 4, 5, 99]);
  await assert.rejects(
    restoreUserDefinedCodes(
      { state: trailing.state, abortSignal: null },
      userDefinedCodesChunkMeta(trailingPayload),
      trailingPayload,
    ),
    /trailing/i,
  );
  assert.equal(trailing.template.codes, null);

  const mismatched = makeState(3);
  const mismatchedPayload = new Uint8Array([0, 2, 4, 5]);
  await assert.rejects(
    restoreUserDefinedCodes(
      { state: mismatched.state, abortSignal: null },
      userDefinedCodesChunkMeta(mismatchedPayload),
      mismatchedPayload,
    ),
    /pointCount|length/i,
  );
  assert.equal(mismatched.template.codes, null);

  const invalidViewIdentity = makeState(2);
  invalidViewIdentity.state.viewContexts.set(7, {
    obsData: { fields: [] },
    varData: { fields: [] },
  });
  const invalidViewPayload = new Uint8Array([0, 2, 4, 5]);
  await assert.rejects(
    restoreUserDefinedCodes(
      { state: invalidViewIdentity.state, abortSignal: null },
      userDefinedCodesChunkMeta(invalidViewPayload),
      invalidViewPayload,
    ),
    /snapshot view id.*non.?empty.*string/i,
  );
  assert.equal(invalidViewIdentity.template.codes, null);
});

test('dynamic code and highlight chunks reject each dishonest metadata field before mutation', async () => {
  const codePayload = new Uint8Array([0, 3, 0, 1, 0]);
  const codeTemplate = {
    _userDefinedId: 'field-a',
    _isUserDefined: true,
    kind: 'category',
    key: 'restored_groups',
    codes: null,
    loaded: false,
    _codesLengthHint: 3,
    _codesTypeHint: 'Uint8Array',
    centroidsByDim: {},
  };
  const codeState = {
    pointCount: 3,
    obsData: { fields: [] },
    varData: { fields: [] },
    viewContexts: new Map(),
    getUserDefinedFieldsRegistry() {
      return {
        getField(fieldId) {
          return fieldId === 'field-a' ? codeTemplate : null;
        },
      };
    },
    getActiveField() {
      return null;
    },
  };
  const invalidCodeMetadata = [
    [{ contributorId: 'other' }, /contributorId/i],
    [{ priority: 'critical' }, /priority/i],
    [{ kind: 'json' }, /binary/i],
    [{ codec: 'none' }, /gzip/i],
    [{ label: 'Wrong' }, /label/i],
    [{ datasetDependent: false }, /dataset-dependent/i],
    [{ storedBytes: -1 }, /storedBytes|nonnegative/i],
    [{ uncompressedBytes: codePayload.byteLength + 1 }, /payload length/i],
    [{ id: 'user-defined/other/field-a' }, /chunk id/i],
    [{ unexpected: true }, /exact keys|unexpected/i],
  ];
  for (const [overrides, expected] of invalidCodeMetadata) {
    await assert.rejects(
      restoreUserDefinedCodes(
        { state: codeState, abortSignal: null },
        userDefinedCodesChunkMeta(codePayload, overrides),
        codePayload,
      ),
      expected,
    );
    assert.equal(codeTemplate.codes, null);
  }

  const highlightPayload = encodeDeltaUvarint([1, 2]);
  const oldPages = [{
    id: 'page_9',
    name: 'Old',
    color: '#778899',
    highlightedGroups: [],
  }];
  const highlightState = {
    pointCount: 3,
    highlightPages: oldPages,
    activePageId: 'page_9',
    _highlightPageIdCounter: 9,
    _highlightIdCounter: 0,
    _recomputeHighlightArray() {},
    _notifyHighlightPageChange() {},
    _notifyHighlightChange() {},
  };
  const restoreTransaction = createSessionRestoreTransaction();
  const highlightContext = {
    state: highlightState,
    abortSignal: null,
    restoreTransaction,
  };
  restoreHighlightMeta(
    highlightContext,
    { id: 'highlights/meta' },
    {
      pages: [{
        id: 'page_1',
        name: 'Restored',
        color: '#112233',
        highlightedGroups: [{
          id: 'highlight_1',
          type: 'lasso',
          label: 'Two cells',
          enabled: true,
          cellCount: 2,
        }],
      }],
      activePageId: 'page_1',
    },
  );
  const invalidHighlightMetadata = [
    [{ contributorId: 'other' }, /contributorId/i],
    [{ priority: 'eager' }, /lazy/i],
    [{ kind: 'json' }, /binary/i],
    [{ codec: 'none' }, /gzip/i],
    [{ label: 'Wrong' }, /label/i],
    [{ datasetDependent: false }, /dataset-dependent/i],
    [{ storedBytes: -1 }, /storedBytes|nonnegative/i],
    [{ uncompressedBytes: highlightPayload.byteLength + 1 }, /payload length/i],
    [{ id: 'highlights/other/highlight_1' }, /chunk id/i],
    [{ unexpected: true }, /exact keys|unexpected/i],
  ];
  for (const [overrides, expected] of invalidHighlightMetadata) {
    await assert.rejects(
      restoreHighlightCells(
        highlightContext,
        highlightCellsChunkMeta(highlightPayload, overrides),
        highlightPayload,
      ),
      expected,
    );
    assert.strictEqual(highlightState.highlightPages, oldPages);
  }
  restoreTransaction.rollback();
});

test('user-defined categorical hydration publishes no placeholder codes and becomes terminally loaded', async () => {
  const registry = new UserDefinedFieldsRegistry();
  registry.fromSessionMeta([{
    id: 'field-a',
    source: 'obs',
    kind: 'category',
    key: 'restored_groups',
    categories: ['A', 'B'],
    isDeleted: false,
    isPurged: false,
    codesLength: 3,
    codesType: 'Uint8Array',
    centroidsByDim: {},
    normalizedDims: [],
    sourceField: null,
    operation: null,
    sourcePages: [],
    overlapStrategy: 'first',
    overlapLabel: null,
    intersectionLabels: null,
    uncoveredLabel: null,
    createdAt: 123,
  }]);

  const template = registry.getField('field-a');
  assert.equal(template.codes, null);
  assert.equal(template.loaded, false);
  assert.equal(template._loadingPromise, null);
  assert.equal(template._codesLengthHint, 3);
  assert.equal(template._codesTypeHint, 'Uint8Array');
  assert.throws(
    () => registry.toSessionMeta(),
    /exact typed codes|loaded before session capture/i,
  );

  const injected = { ...template };
  const state = {
    pointCount: 3,
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    obsData: { fields: [injected] },
    varData: { fields: [] },
    viewContexts: new Map(),
    getUserDefinedFieldsRegistry() {
      return registry;
    },
    getActiveField() {
      return null;
    },
  };
  const restoredCodesPayload = new Uint8Array([0, 3, 0, 1, 0]);
  await restoreUserDefinedCodes(
    { state, abortSignal: null },
    userDefinedCodesChunkMeta(restoredCodesPayload),
    restoredCodesPayload,
  );

  assert.ok(template.codes instanceof Uint8Array);
  assert.deepEqual(Array.from(template.codes), [0, 1, 0]);
  assert.equal(template.loaded, true);
  assert.equal(Object.hasOwn(template, '_codesLengthHint'), false);
  assert.equal(Object.hasOwn(template, '_codesTypeHint'), false);
  assert.equal(injected.codes, template.codes);
  assert.equal(injected.loaded, true);
  assert.equal(Object.hasOwn(injected, '_codesLengthHint'), false);
  assert.equal(Object.hasOwn(injected, '_codesTypeHint'), false);

  const [metadata] = registry.toSessionMeta();
  assert.equal(metadata.codesLength, 3);
  assert.equal(metadata.codesType, 'Uint8Array');

  const [chunk] = captureUserDefinedCodes({
    state: {
      ...state,
      getUserDefinedFieldsRegistry() {
        return registry;
      },
    },
  });
  assert.equal(chunk.id, 'user-defined/codes/field-a');
  assert.equal(chunk.priority, 'lazy');
});

test('field overlays require every categorical code chunk with truthful active priority', async () => {
  class JsonRegistry {
    constructor(value) {
      this.value = structuredClone(value);
    }
    clear() {
      this.value = {};
    }
    fromJSON(value) {
      this.value = structuredClone(value);
    }
    toJSON() {
      return structuredClone(this.value);
    }
  }

  function createHarness() {
    const registry = new UserDefinedFieldsRegistry();
    registry.fromSessionMeta([
      categoricalSessionMeta('old-field', 'old_groups'),
    ]);
    const oldField = registry.getField('old-field');
    oldField.codes = new Uint8Array([0, 1, 0]);
    oldField.loaded = true;
    delete oldField._codesLengthHint;
    delete oldField._codesTypeHint;
    const oldCodes = oldField.codes;
    const renameRegistry = new JsonRegistry({
      fields: {},
      categories: {},
    });
    const deleteRegistry = new JsonRegistry({
      deleted: [],
      purged: [],
    });
    const state = {
      pointCount: 3,
      activeFieldSource: null,
      activeFieldIndex: -1,
      activeVarFieldIndex: -1,
      obsData: { fields: [] },
      varData: { fields: [] },
      viewContexts: new Map(),
      applyFieldOverlays() {
        this.obsData = {
          fields: registry.getAllFields().filter(
            field => field._fieldSource === 'obs',
          ),
        };
        this.varData = { fields: [] };
      },
      getActiveField() {
        if (this.activeFieldSource === null) return null;
        return this.obsData.fields[this.activeFieldIndex];
      },
      updateColorsCategorical() {},
      buildCentroidsForField() {},
      getActiveViewId() {
        return 'live';
      },
      _pushColorsToViewer() {},
      _pushCentroidsToViewer() {},
      computeGlobalVisibility() {},
      getDeleteRegistry() {
        return deleteRegistry;
      },
      getRenameRegistry() {
        return renameRegistry;
      },
      getUserDefinedFieldsRegistry() {
        return registry;
      },
    };
    state.applyFieldOverlays();
    const transaction = createSessionRestoreTransaction();
    const context = {
      state,
      abortSignal: null,
      restoreTransaction: transaction,
    };
    restoreFieldOverlays(context, {}, {
      renames: { fields: {}, categories: {} },
      deletedFields: { deleted: [], purged: [] },
      userDefinedFields: [
        categoricalSessionMeta('field-active', 'active_groups'),
        categoricalSessionMeta('field-unused', 'unused_groups'),
      ],
    });
    state.activeFieldSource = 'obs';
    state.activeFieldIndex = state.obsData.fields.findIndex(
      field => field._userDefinedId === 'field-active',
    );
    state.activeVarFieldIndex = -1;
    assert.notEqual(state.activeFieldIndex, -1);

    const payload = new Uint8Array([0, 3, 0, 1, 0]);
    const restoreCodes = (fieldId, fieldKey, priority) => (
      restoreUserDefinedCodes(
        context,
        userDefinedCodesChunkMeta(payload, {
          id: `user-defined/codes/${fieldId}`,
          label: `User-defined codes: ${fieldKey}`,
          priority,
        }),
        payload,
      )
    );
    return {
      context,
      oldCodes,
      registry,
      restoreCodes,
      transaction,
    };
  }

  const missing = createHarness();
  await missing.restoreCodes('field-active', 'active_groups', 'eager');
  assert.throws(
    () => missing.transaction.commit(),
    /advertise 2 categorical code chunks but restored 1/i,
  );
  assert.strictEqual(
    missing.registry.getField('old-field').codes,
    missing.oldCodes,
  );

  const dishonest = createHarness();
  await dishonest.restoreCodes('field-unused', 'unused_groups', 'eager');
  await dishonest.restoreCodes('field-active', 'active_groups', 'lazy');
  assert.throws(
    () => dishonest.transaction.commit(),
    /must be (eager|lazy).*active-field graph/i,
  );
  assert.strictEqual(
    dishonest.registry.getField('old-field').codes,
    dishonest.oldCodes,
  );

  const exact = createHarness();
  await exact.restoreCodes('field-active', 'active_groups', 'eager');
  await exact.restoreCodes('field-unused', 'unused_groups', 'lazy');
  assert.doesNotThrow(() => exact.transaction.commit());
  assert.deepEqual(
    exact.registry.getAllFields().map(field => ({
      id: field._userDefinedId,
      loaded: field.loaded,
    })),
    [
      { id: 'field-active', loaded: true },
      { id: 'field-unused', loaded: true },
    ],
  );
});

test('generic restore rejects reordered same-priority user code chunks and rolls back', async () => {
  class JsonRegistry {
    constructor(value) {
      this.value = structuredClone(value);
    }
    clear() {
      this.value = {};
    }
    fromJSON(value) {
      this.value = structuredClone(value);
    }
    toJSON() {
      return structuredClone(this.value);
    }
  }

  const targetPayload = {
    renames: { fields: {}, categories: {} },
    deletedFields: { deleted: [], purged: [] },
    userDefinedFields: [
      categoricalSessionMeta('field-a', 'groups_a'),
      categoricalSessionMeta('field-b', 'groups_b'),
    ],
  };
  const codePayload = new Uint8Array([0, 3, 0, 1, 0]);
  const source = makeSessionSerializer([{
    id: 'field-overlays',
    capture() {
      return [{
        id: 'core/field-overlays',
        contributorId: 'field-overlays',
        priority: 'eager',
        kind: 'json',
        codec: 'gzip',
        label: 'Field overlays',
        datasetDependent: true,
        payload: targetPayload,
      }];
    },
    restore() {},
  }, {
    id: 'user-defined-codes',
    capture() {
      return [
        {
          id: 'user-defined/codes/field-a',
          contributorId: 'user-defined-codes',
          priority: 'lazy',
          kind: 'binary',
          codec: 'gzip',
          label: 'User-defined codes: groups_a',
          datasetDependent: true,
          payload: codePayload,
        },
        {
          id: 'user-defined/codes/field-b',
          contributorId: 'user-defined-codes',
          priority: 'lazy',
          kind: 'binary',
          codec: 'gzip',
          label: 'User-defined codes: groups_b',
          datasetDependent: true,
          payload: codePayload,
        },
      ];
    },
    restore() {},
  }]);
  const bundle = await source.createSessionBundle();
  const reordered = await rewriteSessionBundle(
    bundle,
    (manifest, chunks) => {
      [manifest.chunks[1], manifest.chunks[2]] = [
        manifest.chunks[2],
        manifest.chunks[1],
      ];
      [chunks[1], chunks[2]] = [chunks[2], chunks[1]];
    },
  );

  const registry = new UserDefinedFieldsRegistry();
  registry.fromSessionMeta([
    categoricalSessionMeta('old-field', 'old_groups'),
  ]);
  const oldField = registry.getField('old-field');
  oldField.codes = new Uint8Array([0, 1, 0]);
  oldField.loaded = true;
  delete oldField._codesLengthHint;
  delete oldField._codesTypeHint;
  const oldCodes = oldField.codes;
  const renameRegistry = new JsonRegistry({
    fields: {},
    categories: {},
  });
  const deleteRegistry = new JsonRegistry({
    deleted: [],
    purged: [],
  });
  const state = {
    pointCount: 3,
    positionsArray: new Float32Array(9),
    getViewDimensionLevel: () => 3,
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    obsData: { fields: [] },
    varData: { fields: [] },
    viewContexts: new Map(),
    applyFieldOverlays() {
      this.obsData = { fields: registry.getAllFields() };
      this.varData = { fields: [] };
    },
    getActiveField() {
      return null;
    },
    getDeleteRegistry() {
      return deleteRegistry;
    },
    getRenameRegistry() {
      return renameRegistry;
    },
    getUserDefinedFieldsRegistry() {
      return registry;
    },
  };
  state.applyFieldOverlays();
  const destination = new SessionSerializer({
    state,
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [{
      id: 'field-overlays',
      capture: captureFieldOverlays,
      restore: restoreFieldOverlays,
    }, {
      id: 'user-defined-codes',
      capture: captureUserDefinedCodes,
      restore: restoreUserDefinedCodes,
    }],
  });

  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  try {
    await withNotificationHarness(async () => {
      await assert.rejects(
        destination.restoreFromBlob(reordered),
        /lazy code chunks.*exact.*inventory order/i,
      );
    });
  } finally {
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  }
  assert.strictEqual(registry.getField('old-field').codes, oldCodes);
});

function exactAnalysisArtifact() {
  return {
    kind: 'bulk-gene',
    cacheKey: 'bulk_genes:page/α',
    gene: 'IL/7',
    pageId: 'page/1',
    pageName: 'Memory T',
    cellCount: 2,
    timestamp: 123456789,
    geneCount: 4,
    values: new Float32Array([1.25, -2.5]),
    cellIndices: new Uint32Array([3, 9]),
  };
}

function exactCameraPathState(overrides = {}) {
  return {
    autoplay: false,
    defaultSpeed: '30',
    easing: 'linear',
    keyframes: [],
    invertLook: false,
    lookSensitivity: '5',
    loopBackKeyframeId: null,
    loopPlayback: false,
    moveSpeed: '100',
    navigationMode: 'orbit',
    nextIndex: 1,
    orbitKeySpeed: '40',
    orbitReverse: true,
    planarInvertAxes: false,
    planarPanSpeed: '100',
    planarZoomToCursor: true,
    positionMethod: 'linear',
    rotationMethod: 'linear',
    showOrbitAnchor: true,
    ...overrides,
  };
}

function analysisChunkMeta(chunk, overrides = {}) {
  const payloadBytes = chunk.kind === 'json'
    ? new TextEncoder().encode(JSON.stringify(chunk.payload)).byteLength
    : chunk.payload.byteLength;
  return {
    id: chunk.id,
    contributorId: chunk.contributorId,
    priority: chunk.priority,
    kind: chunk.kind,
    codec: chunk.codec,
    label: chunk.label,
    datasetDependent: chunk.datasetDependent,
    storedBytes: payloadBytes,
    uncompressedBytes: payloadBytes,
    ...overrides,
  };
}

test('generic restore rolls back cinematic state and analysis cache after a later artifact failure', async () => {
  const initialArtifact = exactAnalysisArtifact();
  const firstTargetArtifact = {
    ...exactAnalysisArtifact(),
    cacheKey: 'bulk_genes:target-a',
    gene: 'TARGET_A',
    pageId: 'target-a',
    pageName: 'Target A',
  };
  const failingTargetArtifact = {
    ...exactAnalysisArtifact(),
    cacheKey: 'bulk_genes:target-b',
    gene: 'TARGET_FAIL',
    pageId: 'target-b',
    pageName: 'Target B',
  };
  const initialCamera = exactCameraPathState({
    defaultSpeed: '20',
    navigationMode: 'planar',
  });
  const targetCamera = exactCameraPathState({
    defaultSpeed: '80',
    navigationMode: 'free',
  });
  const analysisContributor = {
    id: 'analysis-artifacts',
    capture: captureAnalysisArtifacts,
    restore: restoreAnalysisArtifact,
  };
  const sourceSerializer = new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 3,
      getViewDimensionLevel: () => 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [firstTargetArtifact, failingTargetArtifact];
        },
      },
    },
    analysisWindowManager: null,
    cinematicCamera: {},
    contributors: [{
      id: 'cinematic-camera',
      capture() {
        return [{
          id: 'cinematic/camera',
          contributorId: 'cinematic-camera',
          priority: 'eager',
          kind: 'json',
          codec: 'gzip',
          label: 'Cinematic camera path',
          datasetDependent: true,
          payload: targetCamera,
        }];
      },
      restore() {},
    }, analysisContributor],
  });
  const bundle = await sourceSerializer.createSessionBundle();

  let cameraState = structuredClone(initialCamera);
  const cameraOwner = {
    exportSessionState() {
      return structuredClone(cameraState);
    },
    capturePlaybackSnapshot() {
      return {
        state: 'STOPPED',
        globalT: 0,
        camera: exactCameraState(),
      };
    },
    getNavigationMode() {
      return cameraState.navigationMode;
    },
    restoreSessionState(value) {
      cameraState = structuredClone(value);
    },
    startAutoplay() {
      return false;
    },
    restorePlaybackSnapshot(snapshot) {
      assert.equal(snapshot.state, 'STOPPED');
      assert.equal(snapshot.globalT, 0);
    },
    stopAutoplay() {},
  };
  const initialCacheArtifact = structuredClone(initialArtifact);
  let cache = [initialCacheArtifact];
  let rollbackPreservedBuffers = false;
  const dataLayer = {
    beginSessionCacheReplacement() {
      const previousCache = cache;
      cache = [];
      return {
        commit() {},
        rollback() {
          cache = previousCache;
          rollbackPreservedBuffers =
            cache[0].values === initialCacheArtifact.values
            && cache[0].cellIndices === initialCacheArtifact.cellIndices;
        },
      };
    },
    exportSessionCache() {
      return cache;
    },
    importSessionCache(value) {
      const artifacts = Array.isArray(value) ? value : [value];
      if (artifacts.some(artifact => artifact.gene === 'TARGET_FAIL')) {
        return 0;
      }
      cache.push(...structuredClone(artifacts));
      return artifacts.length;
    },
  };
  const destinationSerializer = new SessionSerializer({
    state: {
      getViewDimensionLevel: () => 3,
      pointCount: 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: { dataLayer },
    analysisWindowManager: null,
    cinematicCamera: cameraOwner,
    contributors: [{
      id: 'cinematic-camera',
      capture: captureCinematicCamera,
      restore: restoreCinematicCamera,
    }, analysisContributor],
  });

  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  try {
    await withNotificationHarness(async () => {
      await assert.rejects(
        destinationSerializer.restoreFromBlob(bundle),
        /importSessionCache.*exactly one/i,
      );
    });
  } finally {
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  }

  assert.deepEqual(cameraState, initialCamera);
  assert.deepEqual(cache, [initialArtifact]);
  assert.equal(rollbackPreservedBuffers, true);
});

test('generic empty analysis inventory replaces stale cache and cannot be omitted', async () => {
  const analysisContributor = {
    id: 'analysis-artifacts',
    capture: captureAnalysisArtifacts,
    restore: restoreAnalysisArtifact,
  };
  const source = new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 3,
      getViewDimensionLevel: () => 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [];
        },
      },
    },
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [analysisContributor],
  });
  const bundle = await source.createSessionBundle();
  const { manifest } = await readBundle(bundle, {
    signal: null,
    onProgress: null,
  });
  assert.deepEqual(
    manifest.chunks.map(chunk => chunk.id),
    ['analysis/cache-inventory'],
  );

  const oldArtifact = exactAnalysisArtifact();
  const oldCache = [oldArtifact];
  let cache = oldCache;
  let replacements = 0;
  let imports = 0;
  const dataLayer = {
    beginSessionCacheReplacement() {
      replacements += 1;
      const previous = cache;
      cache = [];
      return {
        commit() {},
        rollback() {
          cache = previous;
        },
      };
    },
    importSessionCache(value) {
      imports += 1;
      cache.push(value);
      return 1;
    },
  };
  const destination = new SessionSerializer({
    state: {
      getViewDimensionLevel: () => 3,
      pointCount: 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: { dataLayer },
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [analysisContributor],
  });
  await withNotificationHarness(
    () => destination.restoreFromBlob(bundle),
  );
  assert.deepEqual(cache, []);
  assert.equal(replacements, 1);
  assert.equal(imports, 0);

  const omitted = await rewriteSessionBundle(
    bundle,
    (rewrittenManifest, chunks) => {
      rewrittenManifest.chunks.length = 0;
      chunks.length = 0;
    },
  );
  cache = oldCache;
  replacements = 0;
  await withNotificationHarness(async () => {
    await assert.rejects(
      destination.restoreFromBlob(omitted),
      /require singleton chunk "analysis\/cache-inventory"/i,
    );
  });
  assert.strictEqual(cache, oldCache);
  assert.equal(replacements, 0);
});

test('analysis inventory enforces exact artifact order and count transactionally', () => {
  const first = exactAnalysisArtifact();
  const second = {
    ...exactAnalysisArtifact(),
    cacheKey: 'bulk_genes:second',
    gene: 'SECOND',
    pageId: 'page-2',
    pageName: 'Second',
  };
  const chunks = captureAnalysisArtifacts({
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [first, second];
        },
      },
    },
  });

  function createHarness() {
    const oldArtifact = exactAnalysisArtifact();
    const oldCache = [oldArtifact];
    let cache = oldCache;
    let importCalls = 0;
    const dataLayer = {
      beginSessionCacheReplacement() {
        const previous = cache;
        cache = [];
        return {
          commit() {},
          rollback() {
            cache = previous;
          },
        };
      },
      importSessionCache(value) {
        importCalls += 1;
        cache.push(value);
        return 1;
      },
    };
    const transaction = createSessionRestoreTransaction();
    return {
      context: {
        comparisonModule: { dataLayer },
        restoreTransaction: transaction,
      },
      getCache() {
        return cache;
      },
      getImportCalls() {
        return importCalls;
      },
      oldCache,
      transaction,
    };
  }

  const reordered = createHarness();
  restoreAnalysisArtifact(
    reordered.context,
    analysisChunkMeta(chunks[0]),
    chunks[0].payload,
  );
  assert.throws(
    () => restoreAnalysisArtifact(
      reordered.context,
      analysisChunkMeta(chunks[2]),
      chunks[2].payload,
    ),
    /does not match advertised cache inventory/i,
  );
  assert.equal(reordered.getImportCalls(), 0);
  reordered.transaction.rollback();
  assert.strictEqual(reordered.getCache(), reordered.oldCache);

  const incomplete = createHarness();
  restoreAnalysisArtifact(
    incomplete.context,
    analysisChunkMeta(chunks[0]),
    chunks[0].payload,
  );
  restoreAnalysisArtifact(
    incomplete.context,
    analysisChunkMeta(chunks[1]),
    chunks[1].payload,
  );
  assert.throws(
    () => incomplete.transaction.commit(),
    /advertised 2 artifacts but restored 1/i,
  );
  assert.strictEqual(incomplete.getCache(), incomplete.oldCache);

  const exact = createHarness();
  for (const chunk of chunks) {
    restoreAnalysisArtifact(
      exact.context,
      analysisChunkMeta(chunk),
      chunk.payload,
    );
  }
  assert.doesNotThrow(() => exact.transaction.commit());
  assert.deepEqual(
    exact.getCache().map(artifact => artifact.gene),
    ['IL/7', 'SECOND'],
  );
});

test('analysis cache replacement swaps exact Map and LRU identities without copying', () => {
  const layer = Object.create(DataLayer.prototype);
  const values = new Float32Array([1, 2]);
  const previousCache = new Map([['cache-a', {
    data: { GENE: { page: { values } } },
  }]]);
  const previousOrder = ['cache-a'];
  layer._bulkGeneCache = previousCache;
  layer._bulkGeneCacheAccessOrder = previousOrder;
  layer._bulkGeneCacheGeneration = 0;
  layer._bulkGeneCacheReplacementOwner = null;

  const replacement = layer.beginSessionCacheReplacement();
  assert.notStrictEqual(layer._bulkGeneCache, previousCache);
  assert.notStrictEqual(layer._bulkGeneCacheAccessOrder, previousOrder);
  layer._bulkGeneCache.set('target', {});
  layer._bulkGeneCacheAccessOrder.push('target');
  replacement.commit();
  replacement.rollback();
  assert.strictEqual(layer._bulkGeneCache, previousCache);
  assert.strictEqual(layer._bulkGeneCacheAccessOrder, previousOrder);
  assert.strictEqual(
    layer._bulkGeneCache.get('cache-a').data.GENE.page.values,
    values,
  );
});

test('session cache replacement generation-isolates in-flight analysis writes', async () => {
  function createLayer() {
    const layer = Object.create(DataLayer.prototype);
    const oldCache = new Map([['old', {
      data: {},
      timestamp: Date.now(),
      geneCount: 0,
    }]]);
    const oldOrder = ['old'];
    layer._bulkGeneCache = oldCache;
    layer._bulkGeneCacheAccessOrder = oldOrder;
    layer._bulkGeneCacheGeneration = 0;
    layer._bulkGeneCacheReplacementOwner = null;
    layer._bulkGeneCacheMaxAge = 60_000;
    layer._bulkGeneCacheMaxSize = 5;
    layer._notifications = null;
    layer.refreshPageVersions = () => {};
    layer.getAvailableVariables = () => [{
      key: 'GENE',
    }];
    let enter;
    let release;
    const entered = new Promise(resolve => {
      enter = resolve;
    });
    layer.getDataForPages = () => new Promise(resolve => {
      release = () => resolve([{
        pageId: 'page_1',
        pageName: 'Page 1',
        values: new Float32Array([1]),
        cellIndices: new Uint32Array([0]),
        cellCount: 1,
      }]);
      enter();
    });
    return {
      entered,
      layer,
      oldCache,
      oldOrder,
      release() {
        release();
      },
    };
  }

  const before = createLayer();
  const beforeFetch = before.layer.fetchBulkGeneExpression({
    pageIds: ['page_1'],
    geneList: ['GENE'],
  });
  await before.entered;
  const beforeReplacement = before.layer.beginSessionCacheReplacement();
  before.layer._bulkGeneCache.set('session', {
    data: {},
    timestamp: 1,
    geneCount: 0,
  });
  before.layer._bulkGeneCacheAccessOrder.push('session');
  before.release();
  await beforeFetch;
  assert.deepEqual([...before.layer._bulkGeneCache.keys()], ['session']);
  beforeReplacement.rollback();
  assert.strictEqual(before.layer._bulkGeneCache, before.oldCache);
  assert.strictEqual(
    before.layer._bulkGeneCacheAccessOrder,
    before.oldOrder,
  );

  const during = createLayer();
  const duringReplacement = during.layer.beginSessionCacheReplacement();
  during.layer._bulkGeneCache.set('session', {
    data: {},
    timestamp: 1,
    geneCount: 0,
  });
  during.layer._bulkGeneCacheAccessOrder.push('session');
  const duringFetch = during.layer.fetchBulkGeneExpression({
    pageIds: ['page_1'],
    geneList: ['GENE'],
  });
  await during.entered;
  duringReplacement.commit();
  during.release();
  await duringFetch;
  assert.deepEqual([...during.layer._bulkGeneCache.keys()], ['session']);
});

test('analysis artifacts round-trip every exact cache identity and metadata field', () => {
  const artifact = exactAnalysisArtifact();
  const chunks = captureAnalysisArtifacts({
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [artifact];
        },
      },
    },
  });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], {
    ...ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE,
    payload: {
      artifactIds: [
        'analysis/artifacts/bulk-gene/bulk_genes%3Apage%2F%CE%B1/IL%2F7/page%2F1',
      ],
    },
  });
  assert.equal(
    chunks[1].id,
    'analysis/artifacts/bulk-gene/bulk_genes%3Apage%2F%CE%B1/IL%2F7/page%2F1',
  );

  const imported = [];
  restoreAnalysisArtifact({
    comparisonModule: {
      dataLayer: {
        importSessionCache(value) {
          imported.push(value);
          return 1;
        },
      },
    },
  }, analysisChunkMeta(chunks[1]), chunks[1].payload);

  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0], artifact);
  assert.notEqual(imported[0].values, artifact.values);
  assert.notEqual(imported[0].cellIndices, artifact.cellIndices);
});

test('analysis artifacts reject missing owners, malformed exports, and noncanonical identities', () => {
  assert.throws(
    () => captureAnalysisArtifacts({ comparisonModule: null }),
    /comparisonModule|dataLayer.*exportSessionCache/i,
  );

  const malformed = exactAnalysisArtifact();
  malformed.cacheKey = 7;
  assert.throws(
    () => captureAnalysisArtifacts({
      comparisonModule: {
        dataLayer: {
          exportSessionCache() {
            return [malformed];
          },
        },
      },
    }),
    /cacheKey.*string/i,
  );

  const artifact = exactAnalysisArtifact();
  const chunks = captureAnalysisArtifacts({
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [artifact];
        },
      },
    },
  });
  const chunk = chunks[1];
  let importCalls = 0;
  const restoreContext = {
    comparisonModule: {
      dataLayer: {
        importSessionCache() {
          importCalls += 1;
          return 1;
        },
      },
    },
  };
  assert.throws(
    () => restoreAnalysisArtifact(
      restoreContext,
      analysisChunkMeta(chunk, {
        id: chunk.id.replace('%2F', '%2f'),
      }),
      chunk.payload,
    ),
    /canonical|chunk id/i,
  );
  assert.equal(importCalls, 0);
  assert.throws(
    () => restoreAnalysisArtifact(
      restoreContext,
      analysisChunkMeta(chunk),
      new Uint8Array([0]),
    ),
    /payload|metadata|table/i,
  );
  assert.equal(importCalls, 0);
});

test('analysis artifact import refusal is a public restore failure', () => {
  const artifact = exactAnalysisArtifact();
  const chunks = captureAnalysisArtifacts({
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [artifact];
        },
      },
    },
  });
  const chunk = chunks[1];
  assert.throws(
    () => restoreAnalysisArtifact({
      comparisonModule: {
        dataLayer: {
          importSessionCache() {
            return 0;
          },
        },
      },
    }, analysisChunkMeta(chunk), chunk.payload),
    /importSessionCache.*exactly one/i,
  );
});

test('analysis artifact contributor has no optional, coercive, or malformed-skip route', () => {
  assert.doesNotMatch(
    analysisArtifactsSource,
    /\?\.|\bString\(|catch\s*\{[^}]*return|continue;|return\s*\[\s*\]\s*;/s,
  );
});

test('multiview validates its closed graph before clearing current views', async () => {
  let clearCalls = 0;
  const state = {
    clearSnapshotViews() {
      clearCalls += 1;
    },
    captureCurrentContext() {
      return {};
    },
    restoreContext() {},
    getActiveViewId() {
      return 'live';
    },
    setActiveView() {},
  };
  const viewer = {
    clearSnapshotViews() {
      clearCalls += 1;
    },
    setCamerasLocked() {},
    setViewCameraState() {},
    setLiveViewHidden() {},
    setViewLayout() {},
    getCamerasLocked() {
      return true;
    },
  };

  await assert.rejects(
    restoreMultiview({
      state,
      viewer,
      async restoreFilters() {
        return { restored: 0, skippedNoop: 0 };
      },
      async restoreActiveFields() {},
      pushViewerState() {},
    }, {
      layout: {
        mode: 'single',
        activeId: 'live',
        liveViewHidden: false,
      },
      camerasLocked: true,
      liveCameraState: exactCameraState(),
      snapshots: [],
      legacyFocusedView: 'live',
    }),
    /exact keys|legacyFocusedView/i,
  );
  assert.equal(clearCalls, 0);
});

test('dockable session layout uses stable DOM ids only', () => {
  assert.doesNotMatch(
    dockableSource,
    /summaryText\s*===\s*panelId|fall back to the summary label/i,
  );
  assert.doesNotMatch(
    dockableSource,
    /best-effort|cascadeToSafePosition|normalizeFloatGeometry/,
  );
  assert.match(
    dockableSource,
    /stable nonempty DOM id|stable.*id/i,
  );
});

test('main wires all required session owners directly without optional probes or warning-only catches', () => {
  assert.doesNotMatch(
    mainSource,
    /setCinematicCameraRef\?\.\(|setAnalysisRefs\?\.\(|getAnalysisWindowManager\?\.\(/,
  );
  assert.match(
    mainSource,
    /sessionSerializer\.setCinematicCameraRef\(ui\.cinematicCamera\);/,
  );
  assert.match(
    mainSource,
    /const analysisWindowManager = comparisonModule\.getAnalysisWindowManager\(\);/,
  );
  assert.match(
    mainSource,
    /sessionSerializer\.setAnalysisRefs\(\{\s*comparisonModule,\s*analysisWindowManager\s*\}\);/s,
  );
});

test('u32 decoding still round-trips the exact maximum value', () => {
  assert.equal(bytesToU32LE(u32ToBytesLE(0xffff_ffff)), 0xffff_ffff);
});
