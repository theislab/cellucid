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
  capture as captureAnalysisArtifacts,
  restore as restoreAnalysisArtifact,
} from '../assets/js/app/session/contributors/analysis-artifacts.js';
import {
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
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
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

test('integer and delta codecs reject coercion, overflow, duplicates, and trailing bytes', () => {
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
  assert.throws(
    () => decodeDeltaUvarint(withTrailing, {
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

function makeSessionSerializer(contributors, pointCount = 3) {
  return new SessionSerializer({
    state: {
      pointCount,
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

function makeHighlightSessionState({ pages, activePageId, events }) {
  const state = Object.create(highlightStateMethods);
  state.pointCount = 4;
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
    'failDownload',
    'info',
    'startDownload',
    'updateDownload',
    'warning',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  notifications.completeDownload = () => {};
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
      /dataset.*mismatch/i,
    );
  });
  assert.equal(restoreCalls, 0);
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
  const fingerprint = getDatasetFingerprint({
    dataSourceManager: manager,
    state: {
      pointCount: 3,
      varData: { fields: [{}, {}] },
    },
  });
  assert.deepEqual(fingerprint, {
    sourceType: 'local-user',
    datasetId: 'dataset-a',
    cellCount: 3,
    varCount: 2,
  });
  assert.equal(datasetFingerprintMatches(fingerprint, { ...fingerprint }), true);

  for (const incomplete of [
    { sourceType: 'local-user', datasetId: 'dataset-a' },
    { ...fingerprint, cellCount: '3' },
    { ...fingerprint, legacyDatasetName: 'A' },
  ]) {
    assert.throws(
      () => datasetFingerprintMatches(fingerprint, incomplete),
      /fingerprint|exact|cellCount/i,
    );
  }
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

  restoreCinematicCamera(
    {
      cinematicCamera: {
        restoreSessionState(data) {
          assert.strictEqual(data, payload);
          restores += 1;
        },
        startAutoplay() {
          starts += 1;
          return true;
        },
        stopAutoplay() {
          stops += 1;
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

  const invalidResultTransaction = createSessionRestoreTransaction();
  restoreCinematicCamera(
    {
      cinematicCamera: {
        restoreSessionState() {},
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

test('highlight cell restore requires staged metadata and rejects count mismatches atomically', () => {
  const payload = encodeDeltaUvarint([1]);
  const stateWithoutGroup = {
    pointCount: 3,
    highlightPages: [],
  };
  assert.throws(
    () => restoreHighlightCells(
      { state: stateWithoutGroup, abortSignal: null },
      { id: 'highlights/cells/highlight_99' },
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
  assert.throws(
    () => restoreHighlightCells(
      context,
      { id: 'highlights/cells/highlight_1' },
      payload,
    ),
    /decoded cell count does not match metadata/i,
  );
  restoreTransaction.rollback();
  assert.strictEqual(state.highlightPages, oldPages);
  assert.equal(state.activePageId, 'page_9');
});

test('user-defined codes reject trailing bytes and dataset length mismatch before mutation', () => {
  function makeState(pointCount) {
    const template = {
      _userDefinedId: 'field-a',
      _isUserDefined: true,
      kind: 'category',
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
  assert.throws(
    () => restoreUserDefinedCodes(
      { state: trailing.state, abortSignal: null },
      { id: 'user-defined/codes/field-a' },
      new Uint8Array([0, 2, 4, 5, 99]),
    ),
    /trailing/i,
  );
  assert.equal(trailing.template.codes, null);

  const mismatched = makeState(3);
  assert.throws(
    () => restoreUserDefinedCodes(
      { state: mismatched.state, abortSignal: null },
      { id: 'user-defined/codes/field-a' },
      new Uint8Array([0, 2, 4, 5]),
    ),
    /pointCount|length/i,
  );
  assert.equal(mismatched.template.codes, null);

  const invalidViewIdentity = makeState(2);
  invalidViewIdentity.state.viewContexts.set(7, {
    obsData: { fields: [] },
    varData: { fields: [] },
  });
  assert.throws(
    () => restoreUserDefinedCodes(
      { state: invalidViewIdentity.state, abortSignal: null },
      { id: 'user-defined/codes/field-a' },
      new Uint8Array([0, 2, 4, 5]),
    ),
    /snapshot view id.*non.?empty.*string/i,
  );
  assert.equal(invalidViewIdentity.template.codes, null);
});

test('user-defined categorical hydration publishes no placeholder codes and becomes terminally loaded', () => {
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
  restoreUserDefinedCodes(
    { state, abortSignal: null },
    { id: 'user-defined/codes/field-a' },
    new Uint8Array([0, 3, 0, 1, 0]),
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

function analysisChunkMeta(chunk, overrides = {}) {
  return {
    id: chunk.id,
    contributorId: chunk.contributorId,
    priority: chunk.priority,
    kind: chunk.kind,
    codec: chunk.codec,
    label: chunk.label,
    datasetDependent: chunk.datasetDependent,
    storedBytes: chunk.payload.byteLength,
    uncompressedBytes: chunk.payload.byteLength,
    ...overrides,
  };
}

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
  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0].id,
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
  }, analysisChunkMeta(chunks[0]), chunks[0].payload);

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
  const [chunk] = captureAnalysisArtifacts({
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [artifact];
        },
      },
    },
  });
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
  const [chunk] = captureAnalysisArtifacts({
    comparisonModule: {
      dataLayer: {
        exportSessionCache() {
          return [artifact];
        },
      },
    },
  });
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
