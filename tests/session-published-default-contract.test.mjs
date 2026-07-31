import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readBundle,
} from '../assets/js/app/session/bundle/reader.js';
import {
  writeBundle,
} from '../assets/js/app/session/bundle/writer.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  isSessionRestoreCanceledError,
  isSessionRestoreSupersededError,
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';
import * as fieldOverlaysContributor from
  '../assets/js/app/session/contributors/field-overlays.js';
import {
  capture as captureCoreState,
  restore as restoreCoreState,
} from '../assets/js/app/session/contributors/core-state.js';
import {
  createSessionRestoreTransaction,
} from '../assets/js/app/session/session-context.js';

const PUBLISHED_PROFILE = Object.freeze([
  Object.freeze({
    id: 'core/field-overlays',
    contributorId: 'field-overlays',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Field overlays',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'core/state',
    contributorId: 'core-state',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Core state',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'ui/dockable-layout',
    contributorId: 'dockable-layout',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Floating panels',
    datasetDependent: false,
  }),
  Object.freeze({
    id: 'analysis/windows',
    contributorId: 'analysis-windows',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Analysis windows',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'highlights/meta',
    contributorId: 'highlights-meta',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Highlight metadata',
    datasetDependent: true,
  }),
]);

function makeContributor(
  profile,
  restore = () => {},
  payload = { chunkId: profile.id },
) {
  return {
    id: profile.contributorId,
    capture() {
      return [{
        ...profile,
        payload,
      }];
    },
    restore,
  };
}

function makeSerializer(contributors) {
  return new SessionSerializer({
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
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors,
  });
}

function createOverlayState(initialPayload) {
  class JsonRegistry {
    constructor(emptyValue, value) {
      this.emptyValue = emptyValue;
      this.value = structuredClone(value);
    }

    clear() {
      this.value = structuredClone(this.emptyValue);
    }

    fromJSON(value) {
      this.value = structuredClone(value);
    }

    toJSON() {
      return structuredClone(this.value);
    }
  }

  class UserRegistry {
    constructor(value) {
      this.value = structuredClone(value);
    }

    clear() {
      this.value = [];
    }

    fromSessionMeta(value) {
      this.value = structuredClone(value);
    }

    toSessionMeta() {
      return structuredClone(this.value);
    }
  }

  const renameRegistry = new JsonRegistry(
    { fields: {}, categories: {} },
    initialPayload.renames,
  );
  const deleteRegistry = new JsonRegistry(
    { deleted: [], purged: [] },
    initialPayload.deletedFields,
  );
  const userDefinedRegistry = new UserRegistry(
    initialPayload.userDefinedFields,
  );
  let applications = 0;
  const state = {
    getDatasetGeneration() {
      return 0;
    },
    obsData: { fields: [] },
    pointCount: 3,
    getViewDimensionLevel: () => 3,
    positionsArray: new Float32Array(9),
    varData: { fields: [] },
    applyFieldOverlays() {
      applications += 1;
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
  return {
    applications: () => applications,
    payload() {
      return {
        deletedFields: deleteRegistry.toJSON(),
        renames: renameRegistry.toJSON(),
        userDefinedFields: userDefinedRegistry.toSessionMeta(),
      };
    },
    state,
  };
}

function makeOverlaySerializer(overlayOwner, coreRestore) {
  const contributors = [
    fieldOverlaysContributor,
    ...PUBLISHED_PROFILE.slice(1).map((profile, index) => (
      makeContributor(
        profile,
        index === 0 ? coreRestore : () => {},
      )
    )),
  ];
  return new SessionSerializer({
    state: overlayOwner.state,
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors,
  });
}

function cameraState(radius) {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius,
      targetRadius: radius,
      theta: 0.5,
      phi: 1,
      target: [0, 0, 0],
    },
    freefly: {
      position: [1, 2, 3],
      yaw: 0.25,
      pitch: -0.1,
    },
  };
}

function createCoreHarness(t) {
  const previousDocument = globalThis.document;
  let dimension = 3;
  let viewerSnapshots = [];
  let visibilityGeneration = 0;
  const renderModeEvents = [];
  const renderModeControl = {
    id: 'render-mode',
    tagName: 'SELECT',
    value: 'points',
    options: ['points', 'smoke'].map(value => ({ value })),
    closest() {
      return null;
    },
    dispatchEvent(event) {
      renderModeEvents.push({
        dimension,
        snapshotCount: viewerSnapshots.length,
        type: event.type,
        value: this.value,
        visibilityGeneration,
      });
      return true;
    },
  };
  const controls = new Map([
    ['dimension-select', {
      options: ['1', '2', '3'].map(value => ({ value })),
      value: '3',
    }],
    ['render-mode', renderModeControl],
    ['categorical-field', { value: '-1' }],
    ['continuous-field', { value: '-1' }],
    ['gene-expression-search', { value: '' }],
    ['outlier-filter', { value: '100' }],
    ['outlier-filter-display', { textContent: '100%' }],
    ['navigation-mode', {
      options: ['orbit', 'planar', 'free'].map(value => ({ value })),
      value: 'orbit',
    }],
    ['freefly-controls', { style: { display: 'none' } }],
    ['orbit-controls', { style: { display: 'block' } }],
    ['planar-controls', { style: { display: 'none' } }],
  ]);
  globalThis.document = {
    getElementById(id) {
      return controls.get(id) ?? null;
    },
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  let activeViewId = 'live';
  let abortOnTargetDimension = null;
  const dimensionManager = {
    copyViewDimension() {
      throw new Error('No snapshot dimension copy is expected.');
    },
    getViewDimension() {
      return dimension;
    },
  };
  const state = {
    pointCount: 3,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    viewContexts: new Map([['live', { id: 'live' }]]),
    applySnapshotConfigToView() {
      throw new Error('No snapshot state publication is expected.');
    },
    beginBatch() {},
    captureCurrentContext() {
      return { dimensionLevel: dimension };
    },
    clearActiveField() {
      this.activeFieldIndex = -1;
      this.activeVarFieldIndex = -1;
      this.activeFieldSource = null;
    },
    clearSnapshotViews() {},
    computeGlobalVisibility() {},
    createViewFromSource() {
      throw new Error('No snapshot state publication is expected.');
    },
    createViewFromActive() {},
    endBatch() {},
    async ensureFieldLoaded() {},
    async ensureVarFieldLoaded() {},
    getActiveViewId() {
      return activeViewId;
    },
    getCurrentOutlierThreshold() {
      return 1;
    },
    getDimensionManager() {
      return dimensionManager;
    },
    getFields() {
      return this.obsData.fields;
    },
    getSnapshotPayload() {
      throw new Error('No snapshot payload is expected.');
    },
    getVarFields() {
      return this.varData.fields;
    },
    getViewDimensionLevel() {
      return dimension;
    },
    restoreContext() {},
    removeView() {},
    setActiveView(viewId) {
      activeViewId = viewId;
      return viewId;
    },
    async setDimensionLevel(nextDimension) {
      dimension = nextDimension;
      if (
        nextDimension === 2
        && abortOnTargetDimension !== null
      ) {
        const abort = abortOnTargetDimension;
        abortOnTargetDimension = null;
        abort();
      }
    },
    syncSnapshotContexts() {},
    updateFilterSummary() {},
    updateFilteredCount() {},
    updateOutlierQuantiles() {},
    _notifyVisibilityChange() {
      visibilityGeneration += 1;
    },
    _pushCentroidsToViewer() {},
    _pushColorsToViewer() {},
    _pushTransparencyToViewer() {},
  };

  let camera = cameraState(3);
  let camerasLocked = true;
  let layout = {
    mode: 'single',
    activeId: 'live',
    liveViewHidden: false,
  };
  const viewer = {
    clearSnapshotViews() {
      viewerSnapshots = [];
    },
    createSnapshotView() {
      throw new Error('No snapshot view is expected.');
    },
    getCameraState() {
      return structuredClone(camera);
    },
    getCamerasLocked() {
      return camerasLocked;
    },
    getSnapshotViews() {
      return [...viewerSnapshots];
    },
    getViewCameraState() {
      return structuredClone(camera);
    },
    getViewDimension() {
      return dimension;
    },
    getViewLayout() {
      return { ...layout };
    },
    removeSnapshotView() {
      throw new Error('Snapshot clearing must use the viewer clear owner.');
    },
    setCameraState(nextCamera) {
      camera = structuredClone(nextCamera);
    },
    setCamerasLocked(value) {
      camerasLocked = value;
    },
    setLiveViewHidden(value) {
      layout.liveViewHidden = value;
    },
    setNavigationMode(mode) {
      camera.navigationMode = mode;
    },
    setViewCameraState(_viewId, nextCamera) {
      camera = structuredClone(nextCamera);
    },
    setViewLayout(mode, activeId) {
      layout.mode = mode;
      layout.activeId = activeId;
    },
  };
  const sidebar = {
    querySelectorAll(selector) {
      if (selector === 'select[id]') return [renderModeControl];
      return [];
    },
  };
  return {
    abortWhenApplyingTarget(abort) {
      abortOnTargetDimension = abort;
    },
    cameraRadius: () => camera.orbit.radius,
    context(restoreTransaction, abortSignal) {
      return {
        abortSignal,
        restoreTransaction,
        sidebar,
        state,
        viewer,
      };
    },
    dimension: () => dimension,
    renderMode: () => renderModeControl.value,
    renderModeEvents: () => structuredClone(renderModeEvents),
    seedViewerSnapshot() {
      viewerSnapshots = [{
        id: 'snap_1',
        label: 'Existing view',
      }];
    },
    setRenderMode(value) {
      renderModeControl.value = value;
    },
    snapshotCount: () => viewerSnapshots.length,
    sidebar,
    state,
    viewer,
  };
}

function makeProfileContributors(restore = () => {}) {
  return PUBLISHED_PROFILE.map((profile, index) => (
    makeContributor(
      profile,
      (ctx, meta, payload) => restore(ctx, meta, payload, index),
    )
  ));
}

async function createPublishedBundle(extraContributors = []) {
  return makeSerializer([
    ...makeProfileContributors(),
    ...extraContributors,
  ]).createSessionBundle();
}

function jsonPayloadWithEncodedBytes(byteLength) {
  const emptyPayloadBytes = new TextEncoder().encode(
    JSON.stringify({ data: '' }),
  ).byteLength;
  assert.ok(byteLength >= emptyPayloadBytes);
  const payload = {
    data: 'A'.repeat(byteLength - emptyPayloadBytes),
  };
  assert.equal(
    new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    byteLength,
  );
  return payload;
}

async function createSizedPublishedBundle(encodedByteLengths) {
  assert.equal(encodedByteLengths.length, PUBLISHED_PROFILE.length);
  return makeSerializer(PUBLISHED_PROFILE.map((profile, index) => ({
    id: profile.contributorId,
    capture() {
      return [{
        ...profile,
        payload: jsonPayloadWithEncodedBytes(
          encodedByteLengths[index],
        ),
      }];
    },
    restore() {},
  }))).createSessionBundle();
}

async function rewriteBundle(blob, mutate) {
  const { manifest, chunkStream } = await readBundle(blob, {
    signal: null,
    onProgress: null,
  });
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk.bytes);
  mutate(manifest, chunks);
  return writeBundle({ manifest, chunks });
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
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  notifications.completeDownload = () => {};
  notifications.dismissDownload = () => {};
  notifications.failDownload = () => {};
  notifications.info = () => {};
  notifications.startDownload = () => 'published-default-test';
  notifications.updateDownload = () => {};
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
  }
}

async function withNotificationRecorder(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'failDownload',
    'info',
    'startDownload',
    'updateDownload',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  const events = [];
  let nextId = 0;
  const cancelHandlers = new Map();
  notifications.startDownload = (_name, _totalBytes, options) => {
    const id = `published-default-${++nextId}`;
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
  notifications.info = () => {};
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
    for (const [name, original] of originals) notifications[name] = original;
  }
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

test('published defaults accept only the exact ordered five-chunk static profile', async () => {
  const validBundle = await createPublishedBundle();
  const restored = [];
  const serializer = makeSerializer(makeProfileContributors(
    (_ctx, meta) => restored.push(meta.id),
  ));

  await withNotificationHarness(async () => {
    await serializer.restorePublishedDefaultState(validBundle, {
      refreshUi() {},
      signal: new AbortController().signal,
    });
  });
  assert.deepEqual(restored, PUBLISHED_PROFILE.map(entry => entry.id));

  const malformedBundles = [
    await rewriteBundle(validBundle, (manifest, chunks) => {
      [manifest.chunks[0], manifest.chunks[1]] = [
        manifest.chunks[1],
        manifest.chunks[0],
      ];
      [chunks[0], chunks[1]] = [chunks[1], chunks[0]];
    }),
    await rewriteBundle(validBundle, (manifest) => {
      manifest.chunks.at(-1).priority = 'lazy';
    }),
    await rewriteBundle(validBundle, (manifest, chunks) => {
      manifest.chunks.pop();
      chunks.pop();
    }),
    await rewriteBundle(validBundle, (manifest) => {
      manifest.chunks[2].label = 'Changed label';
    }),
  ];

  for (const malformedBundle of malformedBundles) {
    restored.length = 0;
    await withNotificationHarness(async () => {
      await assert.rejects(
        serializer.restorePublishedDefaultState(malformedBundle, {
          refreshUi() {},
          signal: new AbortController().signal,
        }),
        /published default.*profile|static profile/i,
      );
    });
    assert.deepEqual(restored, []);
  }
});

test('published defaults reject oversize blobs before bundle or contributor work', async () => {
  const restored = [];
  const serializer = makeSerializer(makeProfileContributors(
    (_ctx, meta) => restored.push(meta.id),
  ));
  const oversize = new Blob([new Uint8Array((32 * 1024) + 1)]);

  await assert.rejects(
    serializer.restorePublishedDefaultState(oversize, {
      refreshUi() {},
      signal: new AbortController().signal,
    }),
    /32 KiB|32 kib|byte limit/i,
  );
  assert.deepEqual(restored, []);
});

test('published defaults bound every chunk and aggregate raw bytes before dispatch', async () => {
  const exactAggregateSizes = [
    13_108,
    13_107,
    13_107,
    13_107,
    13_107,
  ];
  assert.equal(
    exactAggregateSizes.reduce((sum, value) => sum + value, 0),
    64 * 1024,
  );
  const exactBoundaryBundle = await createSizedPublishedBundle(
    exactAggregateSizes,
  );
  assert.ok(exactBoundaryBundle.size <= 32 * 1024);
  const restored = [];
  const serializer = makeSerializer(makeProfileContributors(
    (_ctx, meta) => restored.push(meta.id),
  ));

  await withNotificationHarness(async () => {
    await serializer.restorePublishedDefaultState(exactBoundaryBundle, {
      refreshUi() {},
      signal: new AbortController().signal,
    });
  });
  assert.deepEqual(restored, PUBLISHED_PROFILE.map(entry => entry.id));

  restored.length = 0;
  const aggregateBomb = await createSizedPublishedBundle([
    ...exactAggregateSizes.slice(0, -1),
    exactAggregateSizes.at(-1) + 1,
  ]);
  assert.ok(aggregateBomb.size <= 32 * 1024);
  await withNotificationHarness(async () => {
    await assert.rejects(
      serializer.restorePublishedDefaultState(aggregateBomb, {
        refreshUi() {},
        signal: new AbortController().signal,
      }),
      /64 KiB aggregate uncompressed byte limit/i,
    );
  });
  assert.deepEqual(restored, []);

  const perChunkBomb = await createSizedPublishedBundle([
    (64 * 1024) + 1,
    11,
    11,
    11,
    11,
  ]);
  assert.ok(perChunkBomb.size <= 32 * 1024);
  await withNotificationHarness(async () => {
    await assert.rejects(
      serializer.restorePublishedDefaultState(perChunkBomb, {
        refreshUi() {},
        signal: new AbortController().signal,
      }),
      /core\/field-overlays.*uncompressedBytes/i,
    );
  });
  assert.deepEqual(restored, []);
});

test('published defaults stop a gzip stream that expands beyond its bounded declaration', async () => {
  const actualRawBytes = 128 * 1024;
  const minimumJsonBytes = 11;
  const declaredFirstChunkBytes =
    (64 * 1024) - (4 * minimumJsonBytes);
  const sourceBundle = await createSizedPublishedBundle([
    actualRawBytes,
    minimumJsonBytes,
    minimumJsonBytes,
    minimumJsonBytes,
    minimumJsonBytes,
  ]);
  const lyingBundle = await rewriteBundle(
    sourceBundle,
    manifest => {
      manifest.chunks[0].uncompressedBytes =
        declaredFirstChunkBytes;
    },
  );
  assert.ok(lyingBundle.size <= 32 * 1024);
  const { manifest } = await readBundle(lyingBundle, {
    signal: null,
    onProgress: null,
  });
  assert.equal(
    manifest.chunks.reduce(
      (sum, chunk) => sum + chunk.uncompressedBytes,
      0,
    ),
    64 * 1024,
  );
  assert.equal(
    manifest.chunks.every(
      chunk => chunk.uncompressedBytes <= 64 * 1024,
    ),
    true,
  );

  const restored = [];
  const serializer = makeSerializer(makeProfileContributors(
    (_ctx, meta) => restored.push(meta.id),
  ));
  await withNotificationHarness(async () => {
    await assert.rejects(
      serializer.restorePublishedDefaultState(lyingBundle, {
        refreshUi() {},
        signal: new AbortController().signal,
      }),
      /Decompressed data exceeds limit/i,
    );
  });
  assert.deepEqual(restored, []);
});

test('published restore stays pending until deferred async rollback settles', async () => {
  const bundle = await createPublishedBundle();
  let releaseRollback;
  const rollbackGate = new Promise(resolve => {
    releaseRollback = resolve;
  });
  let reportRollbackStarted;
  const rollbackStarted = new Promise(resolve => {
    reportRollbackStarted = resolve;
  });
  const contributors = makeProfileContributors(
    (ctx, meta, _payload, index) => {
      if (index === 0) {
        ctx.restoreTransaction.register('test/deferred-rollback', {
          value: null,
          prepare() {},
          commit() {},
          async rollback() {
            reportRollbackStarted();
            await rollbackGate;
          },
        });
      }
      if (index === 1) {
        throw new Error(`late contributor failure at ${meta.id}`);
      }
    },
  );
  const serializer = makeSerializer(contributors);

  await withNotificationHarness(async () => {
    const restore = serializer.restorePublishedDefaultState(bundle, {
      refreshUi() {},
      signal: new AbortController().signal,
    });
    let settled = false;
    restore.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await rollbackStarted;
    await Promise.resolve();
    assert.equal(
      settled,
      false,
      'restore must not reject before asynchronous rollback completes',
    );

    releaseRollback();
    await assert.rejects(
      restore,
      /late contributor failure at core\/state/i,
    );
    assert.equal(settled, true);
  });
});

test('real field overlays roll back on late failure, abort, commit, and UI refresh errors', async t => {
  const initialPayload = {
    renames: {
      fields: { cell_type: 'Original label' },
      categories: {},
    },
    deletedFields: {
      deleted: [],
      purged: [],
    },
    userDefinedFields: [],
  };
  const targetPayload = {
    renames: {
      fields: { cell_type: 'Published label' },
      categories: {},
    },
    deletedFields: {
      deleted: [],
      purged: [],
    },
    userDefinedFields: [],
  };
  const bundle = await makeSerializer([
    makeContributor(
      PUBLISHED_PROFILE[0],
      () => {},
      targetPayload,
    ),
    ...makeProfileContributors().slice(1),
  ]).createSessionBundle();

  async function assertRestoredAfter(run, expectedRefreshCalls = null) {
    const owner = createOverlayState(initialPayload);
    let refreshCalls = 0;
    await withNotificationHarness(async () => {
      await run(owner, () => {
        refreshCalls += 1;
      });
    });
    assert.deepEqual(owner.payload(), {
      deletedFields: initialPayload.deletedFields,
      renames: initialPayload.renames,
      userDefinedFields: initialPayload.userDefinedFields,
    });
    assert.ok(
      owner.applications() >= 2,
      'target and rollback overlays must both be applied',
    );
    if (expectedRefreshCalls !== null) {
      assert.equal(refreshCalls, expectedRefreshCalls);
    }
  }

  await t.test('late contributor failure', async () => {
    await assertRestoredAfter(async (owner, refreshUi) => {
      const serializer = makeOverlaySerializer(owner, () => {
        throw new Error('late core failure');
      });
      await assert.rejects(
        serializer.restorePublishedDefaultState(bundle, {
          refreshUi,
          signal: new AbortController().signal,
        }),
        /late core failure/i,
      );
    });
  });

  await t.test('caller abort', async () => {
    await assertRestoredAfter(async (owner, refreshUi) => {
      const controller = new AbortController();
      let enteredResolve;
      const entered = new Promise(resolve => {
        enteredResolve = resolve;
      });
      const serializer = makeOverlaySerializer(
        owner,
        async ctx => {
          enteredResolve();
          await new Promise((resolve, reject) => {
            ctx.abortSignal.addEventListener(
              'abort',
              () => reject(abortError()),
              { once: true },
            );
          });
        },
      );
      const restore = serializer.restorePublishedDefaultState(bundle, {
        refreshUi,
        signal: controller.signal,
      });
      const rejected = assert.rejects(restore, { name: 'AbortError' });
      await entered;
      controller.abort();
      await rejected;
    }, 1);
  });

  await t.test('transaction commit failure', async () => {
    await assertRestoredAfter(async (owner, refreshUi) => {
      const serializer = makeOverlaySerializer(
        owner,
        ctx => {
          ctx.restoreTransaction.register('test/commit-failure', {
            value: null,
            prepare() {},
            commit() {
              throw new Error('late commit failure');
            },
            rollback() {},
          });
        },
      );
      await assert.rejects(
        serializer.restorePublishedDefaultState(bundle, {
          refreshUi,
          signal: new AbortController().signal,
        }),
        /late commit failure/i,
      );
    });
  });

  await t.test('final UI refresh failure', async () => {
    await assertRestoredAfter(
      async (owner, recordRefresh) => {
        let refreshAttempt = 0;
        const serializer = makeOverlaySerializer(owner, () => {});
        await assert.rejects(
          serializer.restorePublishedDefaultState(bundle, {
            refreshUi() {
              recordRefresh();
              refreshAttempt += 1;
              if (refreshAttempt === 1) {
                throw new Error('final UI refresh failure');
              }
            },
            signal: new AbortController().signal,
          }),
          /final UI refresh failure/i,
        );
      },
      2,
    );
  });
});

test('real core state rolls back exact dimension and camera after commit failure or abort', async t => {
  async function targetPayload(harness) {
    const [chunk] = captureCoreState({
      sidebar: harness.sidebar,
      state: harness.state,
      viewer: harness.viewer,
    });
    const payload = structuredClone(chunk.payload);
    const targetCamera = cameraState(9);
    payload.camera = targetCamera;
    payload.liveDimensionLevel = 2;
    payload.multiview.liveCameraState = structuredClone(targetCamera);
    return payload;
  }

  await t.test('late commit failure', async t => {
    const harness = createCoreHarness(t);
    const transaction = createSessionRestoreTransaction();
    await restoreCoreState(
      harness.context(transaction, new AbortController().signal),
      { id: 'core/state' },
      await targetPayload(harness),
    );
    assert.equal(harness.dimension(), 2);
    assert.equal(harness.cameraRadius(), 9);
    transaction.register('test/core-late-commit', {
      value: null,
      prepare() {},
      commit() {
        throw new Error('core late commit failure');
      },
      rollback() {},
    });
    await assert.rejects(
      Promise.resolve().then(() => transaction.commit()),
      /core late commit failure/i,
    );
    assert.equal(harness.dimension(), 3);
    assert.equal(harness.cameraRadius(), 3);
  });

  await t.test('abort during core application', async t => {
    const harness = createCoreHarness(t);
    const transaction = createSessionRestoreTransaction();
    const controller = new AbortController();
    harness.abortWhenApplyingTarget(() => controller.abort());
    await assert.rejects(
      restoreCoreState(
        harness.context(transaction, controller.signal),
        { id: 'core/state' },
        await targetPayload(harness),
      ),
      { name: 'AbortError' },
    );
    await transaction.rollback();
    assert.equal(harness.dimension(), 3);
    assert.equal(harness.cameraRadius(), 3);
  });
});

test('real core state replays in neutral points mode before publishing saved smoke', async t => {
  async function captureTarget(harness) {
    const [chunk] = captureCoreState({
      sidebar: harness.sidebar,
      state: harness.state,
      viewer: harness.viewer,
    });
    const payload = structuredClone(chunk.payload);
    payload.liveDimensionLevel = 2;
    return payload;
  }

  await t.test('current smoke is retired before restored state mutates', async t => {
    const harness = createCoreHarness(t);
    harness.setRenderMode('smoke');
    const payload = await captureTarget(harness);

    await restoreCoreState(
      harness.context(null, new AbortController().signal),
      { id: 'core/state' },
      payload,
    );

    assert.equal(harness.dimension(), 2);
    assert.equal(harness.renderMode(), 'smoke');
    assert.deepEqual(harness.renderModeEvents(), [
      {
        dimension: 3,
        snapshotCount: 0,
        type: 'change',
        value: 'points',
        visibilityGeneration: 0,
      },
      {
        dimension: 2,
        snapshotCount: 0,
        type: 'change',
        value: 'smoke',
        visibilityGeneration: 1,
      },
    ]);
  });

  await t.test('saved smoke publishes only after current snapshots are cleared', async t => {
    const harness = createCoreHarness(t);
    const payload = await captureTarget(harness);
    payload.uiControls['render-mode'].value = 'smoke';
    harness.seedViewerSnapshot();

    await restoreCoreState(
      harness.context(null, new AbortController().signal),
      { id: 'core/state' },
      payload,
    );

    assert.equal(harness.dimension(), 2);
    assert.equal(harness.snapshotCount(), 0);
    assert.equal(harness.renderMode(), 'smoke');
    assert.deepEqual(harness.renderModeEvents(), [{
      dimension: 2,
      snapshotCount: 0,
      type: 'change',
      value: 'smoke',
      visibilityGeneration: 1,
    }]);
  });
});

test('published defaults reject cinematic data before applying any contributor', async () => {
  const cinematicProfile = {
    id: 'cinematic/camera',
    contributorId: 'cinematic-camera',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Cinematic camera path',
    datasetDependent: true,
  };
  const bundle = await createPublishedBundle([
    makeContributor(cinematicProfile),
  ]);
  const restored = [];
  const serializer = makeSerializer([
    ...makeProfileContributors((_ctx, meta) => restored.push(meta.id)),
    makeContributor(
      cinematicProfile,
      (_ctx, meta) => restored.push(meta.id),
    ),
  ]);

  await withNotificationHarness(async () => {
    await assert.rejects(
      serializer.restorePublishedDefaultState(bundle, {
        refreshUi() {},
        signal: new AbortController().signal,
      }),
      /cinematic/i,
    );
  });
  assert.deepEqual(restored, []);
});

test('published defaults forward caller aborts into contributor restore', async () => {
  const bundle = await createPublishedBundle();
  const callerAbort = new AbortController();
  let enteredResolve;
  const entered = new Promise(resolve => {
    enteredResolve = resolve;
  });
  const restored = [];
  const serializer = makeSerializer(makeProfileContributors(
    async (ctx, meta, _payload, index) => {
      restored.push(meta.id);
      if (index !== 0) return;
      enteredResolve();
      await new Promise((resolve, reject) => {
        if (ctx.abortSignal.aborted) {
          reject(abortError());
          return;
        }
        ctx.abortSignal.addEventListener(
          'abort',
          () => reject(abortError()),
          { once: true },
        );
      });
    },
  ));

  await withNotificationHarness(async () => {
    const restore = serializer.restorePublishedDefaultState(bundle, {
      refreshUi() {},
      signal: callerAbort.signal,
    });
    const rejected = assert.rejects(restore, { name: 'AbortError' });
    await entered;
    callerAbort.abort();
    await rejected;
  });
  assert.deepEqual(restored, ['core/field-overlays']);
});

test('published notification cancel reports one exact canceled outcome without failure UI', async () => {
  const bundle = await createPublishedBundle();
  let reportEntered;
  const entered = new Promise(resolve => {
    reportEntered = resolve;
  });
  const serializer = makeSerializer(makeProfileContributors(
    async (ctx, _meta, _payload, index) => {
      if (index !== 0) return;
      reportEntered();
      await new Promise((resolve, reject) => {
        ctx.abortSignal.addEventListener(
          'abort',
          () => reject(abortError()),
          { once: true },
        );
      });
    },
  ));

  await withNotificationRecorder(async (events, controls) => {
    const restore = serializer.restorePublishedDefaultState(bundle, {
      refreshUi() {},
      signal: new AbortController().signal,
    });
    const rejected = assert.rejects(
      restore,
      error => (
        error?.name === 'AbortError'
        && isSessionRestoreCanceledError(error)
      ),
    );
    await entered;
    controls.cancel('published-default-1');
    await rejected;
    assert.deepEqual(
      events.filter(
        event => event.id === 'published-default-1',
      ),
      [
        { id: 'published-default-1', kind: 'start' },
        { id: 'published-default-1', kind: 'dismiss' },
      ],
    );
  });
});

test('replacement and explicit cancellation await prior restore settlement', async () => {
  const bundle = await createPublishedBundle();
  let firstEntryResolve;
  const firstEntry = new Promise(resolve => {
    firstEntryResolve = resolve;
  });
  let firstAbortResolve;
  const firstAbort = new Promise(resolve => {
    firstAbortResolve = resolve;
  });
  let releaseFirstResolve;
  const releaseFirst = new Promise(resolve => {
    releaseFirstResolve = resolve;
  });
  let firstSettled = false;
  let firstChunkCalls = 0;
  const serializer = makeSerializer(makeProfileContributors(
    async (ctx, _meta, _payload, index) => {
      if (index !== 0) return;
      firstChunkCalls += 1;
      if (firstChunkCalls !== 1) {
        assert.equal(firstSettled, true);
        return;
      }
      firstEntryResolve();
      await new Promise(resolve => {
        ctx.abortSignal.addEventListener('abort', resolve, { once: true });
      });
      firstAbortResolve();
      await releaseFirst;
      firstSettled = true;
      throw abortError();
    },
  ));

  await withNotificationRecorder(async events => {
    const firstOwner = new AbortController();
    const firstRestore = serializer.restorePublishedDefaultState(bundle, {
      refreshUi() {},
      signal: firstOwner.signal,
    });
    const firstRejected = assert.rejects(
      firstRestore,
      error => (
        error?.name === 'AbortError'
        && isSessionRestoreSupersededError(error)
      ),
    );
    await firstEntry;

    const replacement = serializer.restorePublishedDefaultState(bundle, {
      refreshUi() {},
      signal: new AbortController().signal,
    });
    await firstAbort;
    assert.equal(firstChunkCalls, 1);
    releaseFirstResolve();
    await firstRejected;
    assert.equal(firstOwner.signal.aborted, false);
    await replacement;
    assert.equal(firstChunkCalls, 2);
    assert.deepEqual(
      events.filter(event => event.id === 'published-default-1'),
      [
        { id: 'published-default-1', kind: 'start' },
        { id: 'published-default-1', kind: 'dismiss' },
      ],
      'manual replacement must dismiss its predecessor without an error terminal',
    );
    assert.deepEqual(
      events.filter(
        event =>
          event.id === 'published-default-1'
          && event.kind === 'fail',
      ),
      [],
    );

    let cancelEntryResolve;
    const cancelEntry = new Promise(resolve => {
      cancelEntryResolve = resolve;
    });
    let cancelReleaseResolve;
    const cancelRelease = new Promise(resolve => {
      cancelReleaseResolve = resolve;
    });
    let canceledRestoreSettled = false;
    const cancelSerializer = makeSerializer(makeProfileContributors(
      async (ctx, _meta, _payload, index) => {
        if (index !== 0) return;
        cancelEntryResolve();
        await new Promise(resolve => {
          ctx.abortSignal.addEventListener('abort', resolve, { once: true });
        });
        await cancelRelease;
        canceledRestoreSettled = true;
        throw abortError();
      },
    ));
    const canceledRestore = cancelSerializer.restorePublishedDefaultState(
      bundle,
      {
        refreshUi() {},
        signal: new AbortController().signal,
      },
    );
    const canceledRejected = assert.rejects(
      canceledRestore,
      { name: 'AbortError' },
    );
    await cancelEntry;
    const cancellation = cancelSerializer.cancelRestoreAndWait();
    await Promise.resolve();
    assert.equal(canceledRestoreSettled, false);
    cancelReleaseResolve();
    await cancellation;
    assert.equal(canceledRestoreSettled, true);
    await canceledRejected;
    assert.deepEqual(
      events.filter(event => event.id === 'published-default-3'),
      [
        { id: 'published-default-3', kind: 'start' },
        { id: 'published-default-3', kind: 'dismiss' },
      ],
      'published-default cancellation must dismiss without an error terminal',
    );
  });
});
