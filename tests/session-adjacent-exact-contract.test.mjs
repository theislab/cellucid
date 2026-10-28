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
  CELL_SET_REFERENCE_ALL,
  CELL_SET_REFERENCE_MASK,
  CELL_SET_RUNS,
  CELL_SET_SORTED_DELTA,
  decodeCellSet,
  digestCellSet,
  encodeCellSet,
} from '../assets/js/app/session/codecs/cell-set.js';
import {
  decodeTypedJson,
  encodeTypedJson,
} from '../assets/js/app/session/codecs/typed-json.js';
import {
  decodeUvarint,
  encodeUvarints,
  uvarintLength,
  writeUvarint,
} from '../assets/js/app/session/codecs/varint.js';
import {
  UserDefinedFieldsRegistry,
} from '../assets/js/app/registries/user-defined-fields.js';
import {
  capture as captureCinematicCamera,
  restore as restoreCinematicCamera,
} from '../assets/js/app/session/contributors/cinematic-camera.js';
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
  createInMemoryAnnDataDimensionManager,
  describeOwnVarCount,
  inMemoryAnnDataMapping,
} from './helpers/in-memory-anndata.mjs';
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
import { untilEntered } from './helpers/entered.mjs';

const dockableSource = await readFile(
  new URL('../assets/js/app/session/contributors/dockable-layout.js', import.meta.url),
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
  const decode = (bytes, reference = null) => decodeCellSet(bytes, { cellCount, reference, signal: null });
  // Sparse: sorted deltas. Dense and scattered: a bitset. Contiguous: runs.
  const sparse = Uint32Array.from([3, 500, 999]);
  const dense = Uint32Array.from({ length: 600 }, (_value, index) => index + Math.floor(index / 2));
  const contiguous = Uint32Array.from({ length: 400 }, (_value, index) => 100 + index);
  for (const [cells, encoding] of [
    [sparse, CELL_SET_SORTED_DELTA],
    [dense, CELL_SET_BITSET],
    [contiguous, CELL_SET_RUNS],
  ]) {
    const bytes = encodeCellSet(cells, { cellCount, reference: null });
    assert.equal(bytes[0], encoding);
    assert.deepEqual(await decode(bytes), cells);
  }
  // Unsorted input is sorted once; duplicates and out-of-range cells are refused.
  assert.deepEqual(await decode(encodeCellSet([999, 3, 500], { cellCount, reference: null })), sparse);
  assert.throws(() => encodeCellSet([3, 3], { cellCount, reference: null }), /duplicates/i);
  assert.throws(() => encodeCellSet([cellCount], { cellCount, reference: null }), /exceeds/i);
  assert.throws(() => encodeCellSet([2 ** 32], { cellCount, reference: null }), /32-bit/i);

  // Trailing bytes, bits past the cell count, and an unknown encoding.
  const delta = encodeCellSet(sparse, { cellCount, reference: null });
  const withTrailing = new Uint8Array(delta.byteLength + 1);
  withTrailing.set(delta);
  await assert.rejects(decode(withTrailing), /trailing/i);
  const bitset = encodeCellSet(dense, { cellCount, reference: null });
  const pastEnd = bitset.slice();
  pastEnd[pastEnd.byteLength - 1] |= 0x80;
  await assert.rejects(decodeCellSet(pastEnd, { cellCount: 999, reference: null, signal: null }), /wrong length|past/i);
  await assert.rejects(decode(Uint8Array.from([9, 0])), /encoding 9/);
  // Runs that overlap or touch are not canonical.
  await assert.rejects(decode(Uint8Array.from([CELL_SET_RUNS, 2, 0, 2, 0, 2])), /separated/i);
});

test('a category highlight is stored relative to its category and refused when the category moved', async () => {
  const cellCount = 100_000;
  const reference = Uint32Array.from({ length: 30_000 }, (_value, index) => index * 3);
  const all = encodeCellSet(reference, { cellCount, reference });
  assert.equal(all[0], CELL_SET_REFERENCE_ALL);
  assert.ok(all.byteLength < 10, 'a whole category costs a few bytes');
  assert.deepEqual(await decodeCellSet(all, { cellCount, reference, signal: null }), reference);

  const subset = reference.filter((_cell, index) => index % 4 !== 0);
  const mask = encodeCellSet(subset, { cellCount, reference });
  assert.equal(mask[0], CELL_SET_REFERENCE_MASK);
  assert.deepEqual(await decodeCellSet(mask, { cellCount, reference, signal: null }), subset);

  // A selection that is not inside the category is stored on its own.
  const outside = Uint32Array.from([1, ...subset.subarray(1)]).sort();
  assert.notEqual(encodeCellSet(outside, { cellCount, reference })[0], CELL_SET_REFERENCE_MASK);

  // The reader derives the category again and checks it is the same cells.
  const moved = reference.slice();
  moved[0] = 1;
  await assert.rejects(
    decodeCellSet(all, { cellCount, reference: moved, signal: null }),
    /no longer holds the same cells/,
  );
  await assert.rejects(
    decodeCellSet(all, { cellCount, reference: null, signal: null }),
    /relative to a category/,
  );
  // The digest is order-independent within a set and sensitive to membership.
  assert.equal(digestCellSet(reference), digestCellSet(reference.slice()));
  assert.notEqual(digestCellSet(reference), digestCellSet(moved));
});

test('typed JSON keys named like prototype members decode as own keys', () => {
  const value = JSON.parse(
    '{"__proto__": {"polluted": true}, "constructor": [1], "prototype": "x", "nested": {"__proto__": 2}}',
  );
  assert.ok(Object.hasOwn(value, '__proto__'), 'the fixture itself holds an own "__proto__" key');
  const decoded = decodeTypedJson(encodeTypedJson(value));
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

test('typed JSON stores numeric columns as their bytes and refuses ambiguous values', () => {
  const value = {
    genes: ['CD3E', 'MS4A1'],
    columns: { log2fc: Float32Array.from([1.5, -2]), padj: Float64Array.from([1e-300, 0.5]) },
    counts: [Uint32Array.from([7, 8]), Int32Array.from([-1, 2])],
    note: null,
  };
  const bytes = encodeTypedJson(value);
  const decoded = decodeTypedJson(bytes);
  assert.deepEqual(decoded, value);
  assert.ok(decoded.columns.log2fc instanceof Float32Array);
  assert.ok(decoded.columns.padj instanceof Float64Array);
  assert.throws(() => encodeTypedJson({ $typed: 0 }), /reserved key/);
  assert.throws(() => encodeTypedJson({ x: Number.NaN }), /finite/);
  assert.throws(() => encodeTypedJson({ x: new BigInt64Array(1) }), /unsupported/);
  // An array the value does not name, or a name with no array, is refused.
  const withExtra = new Uint8Array(bytes.byteLength + 2);
  withExtra.set(bytes);
  withExtra.set([1, 0], bytes.byteLength);
  assert.throws(() => decodeTypedJson(withExtra), /does not name/);
  const dangling = encodeTypedJson({ a: [1] });
  const text = new TextDecoder().decode(dangling.subarray(4)).replace('[1]', '{"$typed":0}');
  const forged = new Uint8Array(4 + text.length);
  new DataView(forged.buffer).setUint32(0, text.length, true);
  forged.set(new TextEncoder().encode(text), 4);
  assert.throws(() => decodeTypedJson(forged), /does not hold/);
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
      ...fingerprintOwners(new Float32Array(pointCount * 3)),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    figureExport: null,
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
  Object.assign(state, fingerprintOwners(new Float32Array(12)));
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
    figureExport: null,
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
    /must contain exactly|label|datasetDependent|legacyLabel/i,
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

test('a failed restore releases the session file it was reading', async () => {
  const contributorId = 'exact-contributor';
  const bundle = await makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [exactSessionChunk(contributorId)];
    },
    restore() {},
  }], 3).createSessionBundle();

  // A Blob whose stream records whether its reader was released by cancel.
  const sources = [];
  class TrackedBlob extends Blob {
    stream() {
      const inner = super.stream().getReader();
      const record = { cancelled: false };
      sources.push(record);
      return new ReadableStream({
        async pull(controller) {
          const { value, done } = await inner.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          record.cancelled = true;
          return inner.cancel(reason);
        },
      }, { highWaterMark: 0 });
    }
  }
  const tracked = new TrackedBlob([await bundle.arrayBuffer()]);

  // The fingerprint refusal happens after the manifest is read and before
  // any chunk is: the source must still be released.
  const serializer = makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [];
    },
    restore() {},
  }], 4);
  await withNotificationHarness(async () => {
    await assert.rejects(serializer.restoreFromBlob(tracked), RangeError);
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].cancelled, true);

  // A contributor failure mid-stream releases it too.
  const failure = new Error('contributor refused its chunk');
  const failing = makeSessionSerializer([{
    id: contributorId,
    capture() {
      return [];
    },
    restore() {
      throw failure;
    },
  }], 3);
  await withNotificationHarness(async () => {
    await assert.rejects(failing.restoreFromBlob(tracked), failure);
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[1].cancelled, true);
});

test('generic Blob cancellation dismisses exactly once', async () => {
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
    await untilEntered(blobEntered, restore, 'the contributor restore');
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
      // No dataset change is in flight, so a chosen session restores at once.
      datasetChanges: {
        recordAction: () => 1,
        settled: true,
        whenSettled: async () => {},
      },
      currentDatasetIdentityId: () => null,
      currentCellIdentity: () => null,
      reopenDataset: async () => ({ shown: false, inPlace: false }),
      openDatasetSource: async () => false,
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
        await untilEntered(entered, click, 'the contributor restore');
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
        // A sorted-delta or runs payload has trailing bytes; a bitset has the
        // wrong length for the cell count. Both are refused before staging.
        /trailing bytes|wrong length/i,
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
    getCurrentIdentityId() {
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
      digest: fingerprint.cellOrder.digest,
    },
    dataMapping: IN_MEMORY_3D_MAPPING,
  });
  assert.match(fingerprint.cellOrder.digest, /^[0-9a-f]{16}$/);
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

  // A record carrying only the four scalars is not a format-2 fingerprint.
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
        figureExport: null,
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
    /must contain exactly|legacyPalette/i,
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
        colormapId: null,
      },
      'var:GAPDH': {
        kind: 'continuous',
        filterEnabled: false,
        filter: null,
        colorRange: null,
        useLogScale: null,
        useFilterColorRange: null,
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
      colormapId: null,
    },
    'var:GAPDH': {
      kind: 'continuous',
      filterEnabled: false,
      filter: null,
      colorRange: null,
      useLogScale: null,
      useFilterColorRange: null,
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
        figureExport: null,
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
    store.add(first, undefined, null);
    store.add(second, undefined, null);
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
        figureExport: null,
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
    /activePageName|must contain exactly|activePageId/i,
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
  const [{ payload }] = captureHighlightMeta({ state: owner });
  // Field-bound groups are saved by name; positions are resolved on restore.
  assert.deepEqual(Object.keys(payload.pages[0].highlightedGroups[0]).sort(), [
    'categoryName',
    'cellCount',
    'enabled',
    'fieldKey',
    'fieldSource',
    'id',
    'label',
    'type',
  ]);
  assert.deepEqual(Object.keys(payload.pages[0].highlightedGroups[1]).sort(), [
    'cellCount',
    'enabled',
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
  const payload = encodeCellSet([1], { cellCount: 3, reference: null });
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
      centroidsByLayout: new Map(),
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

test('user-defined codes decode raw, runs and packed payloads exactly and refuse non-canonical ones', async () => {
  function restoreInto(pointCount, payload) {
    const template = {
      _userDefinedId: 'field-a',
      _isUserDefined: true,
      kind: 'category',
      key: 'restored_groups',
      codes: null,
      loaded: false,
      _codesLengthHint: pointCount,
      _codesTypeHint: 'Uint8Array',
      centroidsByLayout: new Map(),
      categories: ['a', 'b', 'c', 'd', 'e'],
    };
    const state = {
      pointCount,
      dimensionManager: createInMemoryAnnDataDimensionManager({
        positions: new Float32Array(pointCount * 3),
        dimension: 3,
      }),
      obsData: { fields: [] },
      varData: { fields: [] },
      viewContexts: new Map(),
      getUserDefinedFieldsRegistry() {
        return { getField: id => (id === 'field-a' ? template : null) };
      },
      getActiveField() {
        return null;
      },
    };
    return restoreUserDefinedCodes(
      { state, abortSignal: null },
      userDefinedCodesChunkMeta(payload),
      payload,
    ).then(() => template.codes);
  }
  const codes = [0, 1, 2, 3, 3, 1];
  // 0 raw, 1 runs (value, length), 2 packed (2 bits per code, LSB first).
  assert.deepEqual([...await restoreInto(6, Uint8Array.from([0, 6, ...codes]))], codes);
  assert.deepEqual(
    [...await restoreInto(6, Uint8Array.from([1, 6, 5, 0, 1, 1, 1, 2, 1, 3, 2, 1, 1]))],
    codes,
  );
  const packed = Uint8Array.from([2, 6, 2, 0b11100100, 0b0111]);
  assert.deepEqual([...await restoreInto(6, packed)], codes);

  // Bits past the last code, an unsupported width, and adjacent equal runs.
  await assert.rejects(restoreInto(6, Uint8Array.from([2, 6, 2, 0b11100100, 0b10111])), /past their length/);
  await assert.rejects(restoreInto(6, Uint8Array.from([2, 6, 3, 0, 0, 0])), /1, 2 or 4 bits/);
  await assert.rejects(restoreInto(2, Uint8Array.from([1, 2, 2, 1, 1, 1, 1])), /distinct/);
  await assert.rejects(restoreInto(2, Uint8Array.from([7, 2, 0, 0])), /encoding/);
});

test('user-defined codes are written in their smallest encoding', () => {
  function captureCodes(codes) {
    const field = { _userDefinedId: 'field-a', kind: 'category', key: 'groups', codes };
    const [chunk] = captureUserDefinedCodes({
      state: {
        pointCount: codes.length,
        obsData: { fields: [] },
        varData: { fields: [] },
        viewContexts: new Map(),
        activeFieldSource: null,
        activeFieldIndex: -1,
        activeVarFieldIndex: -1,
        getUserDefinedFieldsRegistry: () => ({ getAllFields: () => [field] }),
        getActiveField: () => null,
      },
    });
    return chunk.payload;
  }
  const n = 4096;
  // Few long runs: runs. Scattered among 3 codes: 2-bit packed (a quarter of
  // raw). Scattered among 200 codes: raw.
  assert.equal(captureCodes(new Uint8Array(n).fill(1, n / 2))[0], 1);
  const scattered3 = Uint8Array.from({ length: n }, (_v, i) => (i * 7919) % 3);
  const packed = captureCodes(scattered3);
  assert.equal(packed[0], 2);
  assert.equal(packed[packed.length - Math.ceil(n * 2 / 8) - 1], 2, 'two bits per code');
  assert.equal(captureCodes(Uint8Array.from({ length: n }, (_v, i) => (i * 7919) % 200))[0], 0);
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
    centroidsByLayout: new Map(),
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
    [{ unexpected: true }, /must contain exactly|unexpected/i],
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

  const highlightPayload = encodeCellSet([1, 2], { cellCount: 3, reference: null });
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
    [{ unexpected: true }, /must contain exactly|unexpected/i],
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
  const owners = fingerprintOwners(Float32Array.from([
    0, 0, 0,
    1, 2, 3,
    4, 4, 4,
  ]));
  const state = {
    pointCount: 3,
    dimensionManager: owners.dimensionManager,
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
  // The record carried no centroids: restoring the codes computed them from
  // the resident layout's positions, and every copy shares them.
  assert.deepEqual([...template._normalizedLayouts], ['3d']);
  assert.deepEqual(template.centroidsByLayout.get('3d'), [
    { category: 'A', position: [2, 2, 2], n_points: 2 },
    { category: 'B', position: [1, 2, 3], n_points: 1 },
  ]);
  assert.strictEqual(injected.centroidsByLayout, template.centroidsByLayout);
  assert.strictEqual(injected._normalizedLayouts, template._normalizedLayouts);

  const [metadata] = registry.toSessionMeta();
  assert.equal(metadata.codesLength, 3);
  assert.equal(metadata.codesType, 'Uint8Array');
  assert.equal(Object.hasOwn(metadata, 'centroidsByDim'), false);
  assert.equal(Object.hasOwn(metadata, 'normalizedDims'), false);

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
    const { dimensionManager } = fingerprintOwners(new Float32Array(9));
    const state = {
      pointCount: 3,
      dimensionManager,
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
      getViewLayoutKey(viewId) {
        return dimensionManager.getViewLayout(viewId);
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
    ...fingerprintOwners(new Float32Array(9)),
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
    figureExport: null,
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

test('generic restore rolls back cinematic state after a later lazy chunk fails', async () => {
  const initialCamera = exactCameraPathState({
    defaultSpeed: '20',
    navigationMode: 'planar',
  });
  const targetCamera = exactCameraPathState({
    defaultSpeed: '80',
    navigationMode: 'free',
  });
  // A lazy chunk applied after the camera path, whose restore fails.
  const lateFailure = new Error('late chunk failed');
  const lateContributor = {
    id: 'late-content',
    capture() {
      return [{
        id: 'late/one',
        contributorId: 'late-content',
        priority: 'lazy',
        kind: 'binary',
        codec: 'gzip',
        label: 'Late content',
        datasetDependent: true,
        payload: Uint8Array.from([1, 2, 3]),
      }];
    },
    restore() {
      throw lateFailure;
    },
  };
  const sourceSerializer = new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 3,
      getViewDimensionLevel: () => 3,
      ...fingerprintOwners(new Float32Array(9)),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: {},
    figureExport: null,
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
    }, lateContributor],
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
  const destinationSerializer = new SessionSerializer({
    state: {
      getViewDimensionLevel: () => 3,
      pointCount: 3,
      ...fingerprintOwners(new Float32Array(9)),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: cameraOwner,
    figureExport: null,
    contributors: [{
      id: 'cinematic-camera',
      capture: captureCinematicCamera,
      restore: restoreCinematicCamera,
    }, lateContributor],
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
        error => error === lateFailure,
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
});

test('multiview validates its closed graph before clearing current views', async () => {
  let clearCalls = 0;
  const state = {
    clearSnapshotViews() {
      clearCalls += 1;
    },
    getActiveViewId() {
      return 'live';
    },
    getFields() {
      return [];
    },
    getVarFields() {
      return [];
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
    }, {
      layout: {
        mode: 'single',
        activeId: 'live',
        liveViewHidden: false,
      },
      camerasLocked: true,
      live: {
        cameraState: exactCameraState(),
        centroids: { points: false, labels: false },
      },
      snapshots: [],
      focusedView: 'live',
    }, {
      embedding: { key: 'X_umap', columns: [0, 1, 2] },
      filters: {},
      activeFields: { activeFieldKey: null, activeFieldSource: null },
    }),
    /must contain exactly/i,
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
