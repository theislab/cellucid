import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';
import { createTestDatasetIntents } from './helpers/dataset-intents.mjs';
import { DATA_LOAD_METHODS } from '../assets/js/app/data-load-methods.js';
import { loadPointsBinary } from '../assets/js/data/data-loaders.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import { debug } from '../assets/js/utils/debug.js';

const outcomeModuleUrl = new URL(
  '../assets/js/app/dataset-reload-outcome.js',
  import.meta.url
);

/**
 * Version-3 `embeddings` metadata: one item per `[id, dimension]`, in the
 * (dimension, id) item order, each on its exact producer path. Each dimension's
 * default is its first item unless `defaults` names another.
 */
function embeddingsMetadata(entries, { defaults = {}, defaultDimension, gzip = false } = {}) {
  const items = {};
  const slots = {};
  entries.forEach(([id, dimension], index) => {
    items[id] = {
      label: id,
      dimension,
      file: `embeddings/${index}_${dimension}d.bin${gzip ? '.gz' : ''}`,
      source: {
        key: id,
        columns: Array.from({ length: dimension }, (_, column) => column),
      },
    };
    slots[`${dimension}d`] ??= id;
  });
  const dimensions = entries.map(([, dimension]) => dimension);
  return {
    default_dimension: defaultDimension ?? Math.max(...dimensions),
    defaults: { ...slots, ...defaults },
    items,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFileInput() {
  const listeners = new Map();
  let pickerClicks = 0;
  return {
    value: '',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {
      pickerClicks++;
    },
    get pickerClicks() {
      return pickerClicks;
    },
    async select(files) {
      this.value = 'selected';
      await listeners.get('change')?.({ target: { files } });
    }
  };
}

function createButton() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    activate() {
      return listeners.get('click')?.();
    }
  };
}

function installBrowserStubs(
  t,
  initialHref = 'https://cellucid.test/?dataset=restored-demo'
) {
  const originals = {
    document: globalThis.document,
    history: globalThis.history,
    window: globalThis.window
  };
  const historyReplacements = [];
  globalThis.document = { addEventListener() {} };
  globalThis.window = {
    addEventListener() {},
    location: {
      href: initialHref,
      search: new URL(initialHref).search
    }
  };
  globalThis.history = {
    replaceState(_state, _title, nextHref) {
      const nextUrl = new URL(nextHref, globalThis.window.location.href);
      historyReplacements.push(nextUrl.href);
      globalThis.window.location.href = nextUrl.href;
      globalThis.window.location.search = nextUrl.search;
    }
  };
  globalThis.window.history = globalThis.history;
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { historyReplacements, initialHref };
}

function captureNotifications(t) {
  const notifications = getNotificationCenter();
  const originals = {
    complete: notifications.complete,
    dismiss: notifications.dismiss,
    fail: notifications.fail,
    loading: notifications.loading,
    success: notifications.success
  };
  const events = [];
  notifications.loading = message => {
    events.push({ kind: 'loading', message });
    return 'local-load';
  };
  notifications.complete = (id, message) => {
    events.push({ id, kind: 'complete', message });
  };
  notifications.dismiss = id => {
    events.push({ id, kind: 'dismiss' });
  };
  notifications.fail = (id, message) => {
    events.push({ id, kind: 'fail', message });
  };
  notifications.success = message => {
    events.push({ kind: 'success', message });
  };
  t.after(() => Object.assign(notifications, originals));
  return events;
}

function captureDownloadNotifications(t) {
  const notifications = getNotificationCenter();
  const originals = {
    completeDownload: notifications.completeDownload,
    dismissDownload: notifications.dismissDownload,
    failDownload: notifications.failDownload,
    startDownload: notifications.startDownload,
    updateDownload: notifications.updateDownload
  };
  const events = [];
  let nextId = 0;
  notifications.startDownload = (name, totalBytes, options) => {
    const id = `download-${++nextId}`;
    events.push({ id, kind: 'start', name, options, totalBytes });
    return id;
  };
  notifications.updateDownload = (id, loadedBytes, totalBytes) => {
    if (totalBytes !== null && loadedBytes > totalBytes) {
      throw new RangeError(
        `Download loadedBytes ${loadedBytes} exceeds totalBytes ${totalBytes}.`
      );
    }
    events.push({ id, kind: 'update', loadedBytes, totalBytes });
  };
  notifications.completeDownload = id => {
    events.push({ id, kind: 'complete' });
  };
  notifications.dismissDownload = id => {
    events.push({ id, kind: 'dismiss' });
  };
  notifications.failDownload = (id, message) => {
    events.push({ id, kind: 'fail', message });
  };
  t.after(() => Object.assign(notifications, originals));
  return events;
}

function installActiveAnnDataAdapter(t, adapter, sourceType = 'h5ad') {
  const manager = getDataSourceManager();
  const previous = {
    activeDatasetId: manager.activeDatasetId,
    activeDatasetMetadata: manager.activeDatasetMetadata,
    activeSource: manager.activeSource,
    lastLoadMethod: manager.lastLoadMethod
  };

  manager.activeSource = {
    datasetId: 'pending-direct-anndata',
    getAdapter: () => adapter,
    getType: () => sourceType
  };
  manager.activeDatasetId = 'pending-direct-anndata';
  manager.activeDatasetMetadata = null;

  t.after(() => {
    Object.assign(manager, previous);
  });
}

async function runLocalSelection(t, { activateDataset }) {
  const browserState = installBrowserStubs(t);
  const notificationEvents = captureNotifications(t);
  const originalDebugError = debug.error;
  debug.error = () => {};
  t.after(() => {
    debug.error = originalDebugError;
  });
  const input = createFileInput();
  const metadata = {
    id: 'local',
    name: 'Local data',
    stats: { n_cells: 2 }
  };
  const candidate = {
    datasetId: 'local',
    disconnectCalls: 0,
    disconnect() {
      this.disconnectCalls++;
    },
    getType() {
      return 'local-user';
    },
    loadFromH5adFile: async () => metadata,
  };
  const userSource = {
    candidateCreations: 0,
    createSelectionCandidate() {
      this.candidateCreations++;
      return candidate;
    },
    disconnect() {},
    getType() {
      return 'local-user';
    },
  };
  const sources = new Map([['local-user', userSource]]);
  let populateCalls = 0;

  initDatasetConnections({
    datasetIntents: createTestDatasetIntents(async (
      datasetId,
      sourceType,
      loadMethod,
      source
    ) => {
      const ready = await activateDataset({
        datasetId,
        loadMethod,
        source,
        sourceType,
      });
      if (ready === true) sources.set(sourceType, source);
      return ready;
    }),
    clearDataset: async () => true,
    dom: {
      select: { focus() {} },
      userDataH5adBtn: createButton(),
      userDataH5adInput: input,
    },
    dataSourceManager: {
      getCurrentSourceType: () => null,
      getSource: type => sources.get(type) ?? null,
      registerSource(type, source) {
        sources.set(type, source);
      },
      unregisterSource(type) {
        sources.delete(type);
      },
    },
    populateDatasetDropdown: () => {
      populateCalls++;
      return Object.freeze({ status: 'ready' });
    },
    noneDatasetValue: '__none__'
  });

  await input.select([{ name: 'example.h5ad' }]);
  return {
    browserState,
    candidate,
    metadata,
    notificationEvents,
    populateCalls,
    userSource,
  };
}

test('required dataset reload reports failure before rejecting the original error', async () => {
  const { reportRequiredDatasetReloadFailure } = await import(outcomeModuleUrl);
  const reloadError = new Error('required positions failed');
  const events = [];

  await assert.rejects(
    reportRequiredDatasetReloadFailure(
      reloadError,
      error => {
        assert.equal(error, reloadError);
        events.push('failure-ui-and-analytics');
      }
    ),
    error => error === reloadError
  );

  assert.deepEqual(events, ['failure-ui-and-analytics']);
});

test(
  'required dataset reload preserves its primary error when failure reporting also rejects',
  async () => {
    const { reportRequiredDatasetReloadFailure } =
      await import(outcomeModuleUrl);
    const reloadError = new Error('exact required reload failure');
    const reportingError = new Error('exact failure reporter rejection');

    await assert.rejects(
      reportRequiredDatasetReloadFailure(
        reloadError,
        async () => {
          throw reportingError;
        }
      ),
      error => error === reloadError
    );
    assert.equal(reloadError.cause, reportingError);
  }
);

test('dataset positions must exactly match the canonical cell axis before publication', async () => {
  const { validateDatasetPositionPayload } =
    await import(outcomeModuleUrl);
  const identity = { stats: { n_cells: 3 } };

  assert.throws(
    () => validateDatasetPositionPayload({
      positions: new Float32Array(8),
      identity,
      dimension: 2
    }),
    /8.*coordinates.*n_cells.*3.*exactly 6|exactly 6.*3.*2/i
  );
  // A non-finite coordinate never reaches this check: the decode boundary
  // refuses it (tests/position-finiteness-contract.test.mjs), so it is not
  // scanned a second and third time here.
  assert.throws(
    () => validateDatasetPositionPayload({
      positions: new Float64Array(6),
      identity,
      dimension: 2
    }),
    /exact Float32Array/i
  );

  const exact = new Float32Array([0, 1, 2, 3, 4, 5]);
  assert.equal(
    validateDatasetPositionPayload({
      positions: exact,
      identity,
      dimension: 2
    }),
    exact
  );
});

test('position staging rejects a misaligned raw payload before normalization or scene work', async () => {
  const { stageDatasetPositionPayload } =
    await import(outcomeModuleUrl);
  const controller = new AbortController();
  let renderLoads = 0;
  const manager = {
    nCells: 4,
    getDefaultLayoutKey: () => '2d',
    getLayout: layoutKey => ({ layoutKey, dimension: 2 }),
    loadLayout: async () => new Float32Array(8),
    clearCache() {},
    async getPositions() {
      renderLoads++;
      return new Float32Array(12);
    }
  };

  await assert.rejects(
    stageDatasetPositionPayload({
      generation: { identity: { stats: { n_cells: 3 } } },
      dimensionManager: manager,
      showProgress: false,
      signal: controller.signal
    }),
    /8.*coordinates.*n_cells.*3.*exactly 6|exactly 6.*3.*2/i
  );
  assert.equal(
    renderLoads,
    0,
    'normalization must not run for a misaligned raw cell axis'
  );
});

test('position staging validates raw and rendered buffers and is owner-abortable', async () => {
  const { stageDatasetPositionPayload } =
    await import(outcomeModuleUrl);
  const controller = new AbortController();
  const calls = [];
  const manager = {
    nCells: 3,
    // The dataset opens on its 2D default, named by its embedding id.
    getDefaultLayoutKey: () => 'X_umap',
    getLayout: layoutKey => ({ layoutKey, dimension: 2 }),
    clearCache() {},
    async loadLayout(layoutKey, options) {
      calls.push(['raw', layoutKey, options]);
      return new Float32Array([0, 0, 1, 1, 2, 2]);
    },
    async getPositions(layoutKey, options) {
      calls.push(['render', layoutKey, options]);
      // Rendered positions keep the embedding's two components per cell.
      return new Float32Array([
        -1, -1,
        0, 0,
        1, 1
      ]);
    }
  };
  const staged = await stageDatasetPositionPayload({
    generation: { identity: { stats: { n_cells: 3 } } },
    dimensionManager: manager,
    showProgress: true,
    signal: controller.signal
  });
  assert.deepEqual(staged, {
    defaultDimension: 2,
    positions: staged.positions
  });
  assert.deepEqual(calls, [
    ['raw', 'X_umap', { showProgress: true }],
    ['render', 'X_umap', { showProgress: false }]
  ]);
  assert.equal(staged.positions.length, 6);

  await assert.rejects(
    stageDatasetPositionPayload({
      generation: { identity: { stats: { n_cells: 3 } } },
      dimensionManager: {
        ...manager,
        getPositions: async () => new Float32Array(9)
      },
      showProgress: false,
      signal: new AbortController().signal
    }),
    /2D dataset positions contain 9 coordinates.*exactly 6/
  );

  const pendingRaw = deferred();
  let clearCalls = 0;
  const abortingManager = {
    nCells: 0,
    getDefaultLayoutKey: () => 'X_umap',
    getLayout: layoutKey => ({ layoutKey, dimension: 2 }),
    loadLayout: () => pendingRaw.promise,
    getPositions: async () => {
      assert.fail('render positions must not run after owner cancellation');
    },
    clearCache() {
      clearCalls++;
      const error = new Error('synthetic position abort');
      error.name = 'AbortError';
      pendingRaw.reject(error);
    }
  };
  const abortController = new AbortController();
  const pendingStage = stageDatasetPositionPayload({
    generation: { identity: { stats: { n_cells: 3 } } },
    dimensionManager: abortingManager,
    showProgress: false,
    signal: abortController.signal
  });
  abortController.abort();
  await assert.rejects(
    pendingStage,
    error => error?.name === 'AbortError'
  );
  assert.equal(clearCalls, 1);

  await assert.rejects(
    stageDatasetPositionPayload({
      generation: { identity: { stats: { n_cells: 3 } } },
      dimensionManager: manager,
      showProgress: false,
      signal: null
    }),
    /signal must be an AbortSignal/i
  );

  await assert.rejects(
    stageDatasetPositionPayload({
      generation: { identity: { stats: { n_cells: 3 } } },
      dimensionManager: {
        nCells: 3,
        getDefaultLayoutKey: () => '2d',
        getLayout: layoutKey => ({ layoutKey, dimension: 2 }),
        loadLayout: async () => new Float32Array(6),
        getPositions: async () => new Float32Array(9)
      },
      showProgress: false,
      signal: new AbortController().signal
    }),
    /requires a DimensionManager/i
  );
});

test('dataset reload transactions reject stale commits across local selection epochs', async () => {
  const { createLatestDatasetReloadCoordinator } =
    await import(outcomeModuleUrl);
  const source = {};
  let identity = {
    baseUrl: 'zarr://first/',
    datasetId: 'first',
    selectionIdentity: 1,
    source
  };
  const coordinator = createLatestDatasetReloadCoordinator(
    () => identity
  );
  const oldGate = deferred();
  const committed = [];

  const older = coordinator.begin();
  const olderWork = (async () => {
    await oldGate.promise;
    older.assertCurrent();
    committed.push('older');
  })();

  identity = {
    baseUrl: 'zarr://second/',
    datasetId: 'second',
    selectionIdentity: 2,
    source
  };
  const newer = coordinator.begin();
  assert.equal(
    older.signal.aborted,
    true,
    'a newer reload must abort the previous staging owner'
  );
  assert.equal(newer.signal.aborted, false);
  newer.assertCurrent();
  committed.push('newer');
  oldGate.resolve();

  await assert.rejects(
    olderWork,
    error => {
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /reload.*superseded/i);
      return true;
    }
  );
  assert.equal(older.isCurrent(), false);
  assert.equal(newer.isCurrent(), true);
  assert.deepEqual(committed, ['newer']);

  const repeated = coordinator.begin();
  assert.deepEqual(
    newer.isCurrent(),
    false,
    'a newer reload must supersede an older reload even for one identity'
  );
  repeated.assertCurrent();
});

test('a dataset change supersedes the one in flight the moment it begins', async () => {
  const { createLatestDatasetReloadCoordinator } =
    await import(outcomeModuleUrl);
  const changes = createLatestDatasetReloadCoordinator(() => ({
    baseUrl: null,
    datasetId: null,
    selectionIdentity: null,
    source: null
  }));
  assert.equal(changes.actionSequence, 0);
  assert.equal(changes.settled, true);
  await changes.whenSettled();

  // The startup load is in flight; a file is chosen before it lands.
  const startupLoad = changes.begin();
  assert.equal(changes.settled, false);
  const file = changes.begin();
  assert.equal(startupLoad.signal.aborted, true);
  assert.equal(startupLoad.isLatest(), false);
  assert.equal(file.isLatest(), true);
  assert.equal(file.generation, startupLoad.generation + 1);

  // A superseded change no longer holds anything back; the newest one does
  // until it finishes, and finishing twice is harmless.
  let settled = false;
  const waiting = changes.whenSettled().then(() => {
    settled = true;
  });
  startupLoad.finish();
  await Promise.resolve();
  assert.equal(settled, false);
  file.finish();
  file.finish();
  await waiting;
  assert.equal(settled, true);
  assert.equal(changes.settled, true);

  // A waiter follows the newest change, even one begun while it waits.
  const sample = changes.begin();
  let followed = false;
  const following = changes.whenSettled().then(() => {
    followed = true;
  });
  const none = changes.begin();
  sample.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(followed, false);
  none.finish();
  await following;
  assert.equal(followed, true);
});

test('a change that may not touch the dataset never overrides a later action', async () => {
  const { createLatestDatasetReloadCoordinator } =
    await import(outcomeModuleUrl);
  const changes = createLatestDatasetReloadCoordinator(() => ({
    baseUrl: null,
    datasetId: null,
    selectionIdentity: null,
    source: null
  }));
  const running = changes.begin();
  // Connect is clicked while a load runs: it records the last action only.
  const atClick = changes.actionSequence;
  assert.equal(running.signal.aborted, false);

  // Nothing newer happened: the one-dataset activation replaces the load
  // that was running when Connect was clicked.
  const activation = changes.beginIfNoActionSince(atClick);
  assert.notEqual(activation, null);
  assert.equal(running.signal.aborted, true);
  activation.finish();

  // A choice made after the click wins; the late activation is refused and
  // the choice keeps running.
  const secondClick = changes.actionSequence;
  const laterChoice = changes.begin();
  assert.equal(changes.beginIfNoActionSince(secondClick), null);
  assert.equal(laterChoice.signal.aborted, false);
  assert.equal(laterChoice.isLatest(), true);
  laterChoice.finish();

  // A session applied after the click is an action too: it begins no
  // transaction and aborts nothing, yet the late activation is refused.
  const thirdClick = changes.actionSequence;
  const before = changes.actionSequence;
  assert.equal(changes.recordAction(), before + 1);
  assert.equal(laterChoice.isLatest(), true);
  assert.equal(changes.settled, true);
  assert.equal(changes.beginIfNoActionSince(thirdClick), null);

  assert.throws(() => changes.beginIfNoActionSince(-1), TypeError);
  assert.throws(() => changes.beginIfNoActionSince(1.5), TypeError);
});
test(
  'publication continuation remains current until a newer runtime actually publishes',
  async () => {
    const {
      createLatestDatasetPublicationContinuationOwner,
      createLatestDatasetReloadCoordinator,
      isDatasetReloadSupersededError
    } = await import(outcomeModuleUrl);
    const source = {};
    let identity = {
      baseUrl: 'zarr://first/',
      datasetId: 'first',
      selectionIdentity: 1,
      source
    };
    const requests = createLatestDatasetReloadCoordinator(() => identity);
    const publications =
      createLatestDatasetPublicationContinuationOwner();
    const requestA = requests.begin();
    const publicationA = publications.publish({ kind: 'dataset-a' });
    const continuationRelease = deferred();
    const events = [];
    const continuationA = (async () => {
      await continuationRelease.promise;
      publicationA.assertCurrent();
      events.push('a:reconciled');
    })();

    identity = {
      ...identity,
      baseUrl: 'zarr://failed-b/',
      datasetId: 'failed-b',
      selectionIdentity: 2
    };
    const requestB = requests.begin();
    assert.equal(requestA.signal.aborted, true);
    assert.equal(requestB.isCurrent(), true);
    assert.equal(publicationA.isCurrent(), true);
    assert.equal(publicationA.signal.aborted, false);

    // B fails before publication: its request can end without touching A's
    // already-live continuation owner.
    continuationRelease.resolve();
    await continuationA;
    assert.deepEqual(events, ['a:reconciled']);

    // A same-identity synthetic publication is still a real replacement.
    const publicationC = publications.publish({ kind: 'synthetic-c' });
    assert.equal(publicationA.signal.aborted, true);
    assert.equal(publicationA.isCurrent(), false);
    assert.equal(publicationC.isCurrent(), true);
    publicationC.assertCurrent();
    assert.throws(
      () => publicationA.assertCurrent(),
      isDatasetReloadSupersededError
    );
    assert.equal(publicationC.generation, publicationA.generation + 1);
  }
);

for (const runtimeKind of ['dataset', 'synthetic']) {
  test(
    `${runtimeKind} publication reconciles after a newer request fails before publication`,
    async () => {
      const {
        createLatestDatasetPublicationContinuationOwner,
        createLatestDatasetReloadCoordinator,
        handleDatasetReloadFailure
      } = await import(outcomeModuleUrl);
      const source = {};
      let identity = {
        baseUrl: 'zarr://live-a/',
        datasetId: 'live-a',
        selectionIdentity: 1,
        source
      };
      const requests = createLatestDatasetReloadCoordinator(
        () => identity
      );
      const publications =
        createLatestDatasetPublicationContinuationOwner();
      requests.begin();
      const publicationA = publications.publish({ runtimeKind });
      const reconciliationRelease = deferred();
      const events = [];
      const reconciliation = (async () => {
        await reconciliationRelease.promise;
        publicationA.assertCurrent();
        events.push('a:ui');
        publicationA.assertCurrent();
        events.push('a:state');
        publicationA.assertCurrent();
        events.push('a:terminal');
      })();

      if (runtimeKind === 'dataset') {
        identity = {
          ...identity,
          baseUrl: 'zarr://failed-b/',
          datasetId: 'failed-b',
          selectionIdentity: 2
        };
      }
      const requestB = requests.begin();
      const stagingError = new Error(
        `exact failed ${runtimeKind} replacement`
      );
      const reporterError = new Error(
        `exact failed ${runtimeKind} reporter`
      );
      await assert.rejects(
        handleDatasetReloadFailure({
          error: stagingError,
          transaction: requestB,
          cancel() {
            events.push('b:cancel');
          },
          reportFailure() {
            events.push('b:failure');
            throw reporterError;
          }
        }),
        error => error === stagingError
      );
      assert.equal(stagingError.cause, reporterError);
      assert.equal(publicationA.isCurrent(), true);

      reconciliationRelease.resolve();
      await reconciliation;
      assert.deepEqual(events, [
        'b:failure',
        'a:ui',
        'a:state',
        'a:terminal'
      ]);
    }
  );
}

test('dataset reload identity capture requires one exact explicit shape', async () => {
  const { createLatestDatasetReloadCoordinator } =
    await import(outcomeModuleUrl);
  for (const captureIdentity of [
    () => null,
    () => ({
      source: null,
      baseUrl: null,
      datasetId: null
    }),
    () => ({
      source: null,
      baseUrl: null,
      datasetId: null,
      selectionIdentity: null,
      priorDatasetId: null
    }),
    () => ({
      source: {},
      baseUrl: null,
      datasetId: 'selected',
      selectionIdentity: 1
    }),
    () => ({
      source: {},
      baseUrl: 'zarr://selected/',
      datasetId: 'selected',
      selectionIdentity: '1'
    })
  ]) {
    const coordinator = createLatestDatasetReloadCoordinator(
      captureIdentity
    );
    assert.throws(
      () => coordinator.begin(),
      /reload identity|missing key|unexpected key|explicit null|selectionIdentity/i
    );
  }

  const emptyCoordinator = createLatestDatasetReloadCoordinator(
    () => ({
      source: null,
      baseUrl: null,
      datasetId: null,
      selectionIdentity: null
    })
  );
  const empty = emptyCoordinator.begin();
  assert.equal(empty.isCurrent(), true);
  empty.assertCurrent();
});

test('supersession classification uses only the exact current error code', async () => {
  const {
    DATASET_RELOAD_SUPERSEDED_CODE,
    createDatasetReloadSupersededError,
    isDatasetReloadSupersededError
  } = await import(outcomeModuleUrl);
  const exact = createDatasetReloadSupersededError(
    'Dataset reload was superseded by a newer selection.'
  );
  assert.equal(exact.code, DATASET_RELOAD_SUPERSEDED_CODE);
  assert.equal(isDatasetReloadSupersededError(exact), true);

  const heuristicOnly = new Error(
    'Dataset reload was superseded by a newer selection.'
  );
  heuristicOnly.name = 'AbortError';
  assert.equal(
    isDatasetReloadSupersededError(heuristicOnly),
    false
  );
  assert.equal(
    isDatasetReloadSupersededError({
      code: 'CELLUCID_OLD_RELOAD_CANCELLED'
    }),
    false
  );
});

test('reload owner suppresses stale failure reporting and cancels bookkeeping', async () => {
  const {
    createLatestDatasetReloadCoordinator,
    handleDatasetReloadFailure
  } = await import(outcomeModuleUrl);
  let identity = {
    source: {},
    baseUrl: 'zarr://first/',
    datasetId: 'first',
    selectionIdentity: 1
  };
  const coordinator = createLatestDatasetReloadCoordinator(() => identity);
  const older = coordinator.begin();
  const reported = [];
  const cancelled = [];

  identity = {
    ...identity,
    baseUrl: 'zarr://second/',
    datasetId: 'second',
    selectionIdentity: 2
  };
  coordinator.begin();

  await assert.rejects(
    handleDatasetReloadFailure({
      error: new Error('old payload failed after replacement'),
      transaction: older,
      cancel: () => cancelled.push('old-token'),
      reportFailure: error => reported.push(error)
    }),
    error => error?.name === 'AbortError' && /superseded/i.test(error.message)
  );
  assert.deepEqual(cancelled, ['old-token']);
  assert.deepEqual(reported, []);
});

test(
  'stale reload preserves exact supersession when bookkeeping cancellation fails',
  async () => {
    const {
      createLatestDatasetReloadCoordinator,
      handleDatasetReloadFailure,
      isDatasetReloadSupersededError
    } = await import(outcomeModuleUrl);
    let identity = {
      source: {},
      baseUrl: 'zarr://first/',
      datasetId: 'first',
      selectionIdentity: 1
    };
    const coordinator = createLatestDatasetReloadCoordinator(() => identity);
    const older = coordinator.begin();
    identity = {
      ...identity,
      baseUrl: 'zarr://second/',
      datasetId: 'second',
      selectionIdentity: 2
    };
    coordinator.begin();
    const cancelError = new Error('exact stale bookkeeping failure');
    let reported = false;

    let supersessionError = null;
    await assert.rejects(
      handleDatasetReloadFailure({
        error: new Error('stale payload failure'),
        transaction: older,
        cancel() {
          throw cancelError;
        },
        reportFailure() {
          reported = true;
        }
      }),
      error => {
        supersessionError = error;
        return isDatasetReloadSupersededError(error);
      }
    );

    assert.equal(reported, false);
    assert.equal(supersessionError.cause, cancelError);
  }
);

test('published-state settlement gives superseded reloads one cancel and no success', async () => {
  const {
    createDatasetReloadSupersededError,
    isDatasetReloadSupersededError,
    settlePublishedDatasetStateOutcome
  } = await import(outcomeModuleUrl);

  for (const {
    current,
    outcome
  } of [
    {
      current: true,
      outcome: { status: 'superseded' }
    },
    {
      current: false,
      outcome: { status: 'ready-state-restored' }
    }
  ]) {
    let cancellations = 0;
    let completions = 0;
    const transaction = {
      isCurrent: () => current,
      assertCurrent() {
        if (!current) {
          throw createDatasetReloadSupersededError(
            'Dataset reload was superseded by a newer selection.'
          );
        }
      }
    };
    await assert.rejects(
      settlePublishedDatasetStateOutcome({
        outcome,
        transaction,
        cancel() {
          cancellations += 1;
        },
        complete() {
          completions += 1;
        }
      }),
      error => isDatasetReloadSupersededError(error)
    );
    assert.equal(cancellations, 1);
    assert.equal(completions, 0);
  }

  let cancellations = 0;
  let completions = 0;
  for (const status of [
    'ready-state-replaced',
    'ready-state-canceled'
  ]) {
    const readyOutcome = { status };
    const settled = await settlePublishedDatasetStateOutcome({
      outcome: readyOutcome,
      transaction: {
        isCurrent: () => true,
        assertCurrent() {}
      },
      cancel() {
        cancellations += 1;
      },
      complete() {
        completions += 1;
      }
    });
    assert.strictEqual(settled, readyOutcome);
  }
  assert.equal(cancellations, 0);
  assert.equal(completions, 2);

  assert.equal(
    (await import(outcomeModuleUrl)).settleInitialPublishedDatasetStateOutcome,
    undefined,
    'startup settles its published state through the one reload path'
  );
});

test('reload owner adopts one committed identity before published-state success', async () => {
  const {
    createLatestDatasetReloadCoordinator,
    isDatasetReloadSupersededError,
    settlePublishedDatasetStateOutcome
  } = await import(outcomeModuleUrl);
  const oldSource = {};
  const newSource = {};
  let identity = {
    source: oldSource,
    baseUrl: 'zarr://old/',
    datasetId: 'old',
    selectionIdentity: null
  };
  const coordinator = createLatestDatasetReloadCoordinator(
    () => identity
  );
  const transaction = coordinator.begin();
  transaction.assertCurrent();

  identity = {
    source: newSource,
    baseUrl: 'zarr://new/',
    datasetId: 'new',
    selectionIdentity: null
  };
  assert.equal(transaction.isCurrent(), false);
  transaction.adoptCurrentIdentity();
  assert.equal(transaction.isCurrent(), true);
  assert.throws(
    () => transaction.adoptCurrentIdentity(),
    /already adopted/i
  );

  let cancellations = 0;
  let completions = 0;
  await settlePublishedDatasetStateOutcome({
    outcome: { status: 'ready-state-restored' },
    transaction,
    cancel() {
      cancellations += 1;
    },
    complete() {
      completions += 1;
    }
  });
  assert.equal(cancellations, 0);
  assert.equal(completions, 1);

  const superseded = coordinator.begin();
  assert.equal(transaction.signal.aborted, true);
  assert.throws(
    () => transaction.adoptCurrentIdentity(),
    error => isDatasetReloadSupersededError(error)
  );
  superseded.assertCurrent();

  identity = {
    source: {},
    baseUrl: 'zarr://reentrant-publication/',
    datasetId: 'reentrant-publication',
    selectionIdentity: null
  };
  superseded.adoptCurrentIdentity();
  const listenerReplacement = coordinator.begin();
  assert.equal(superseded.signal.aborted, true);
  cancellations = 0;
  completions = 0;
  await assert.rejects(
    settlePublishedDatasetStateOutcome({
      outcome: { status: 'ready-state-restored' },
      transaction: superseded,
      cancel() {
        cancellations += 1;
      },
      complete() {
        completions += 1;
      }
    }),
    error => isDatasetReloadSupersededError(error)
  );
  assert.equal(cancellations, 1);
  assert.equal(completions, 0);
  listenerReplacement.assertCurrent();
});

test('manual session replacement is a ready state outcome without an error banner', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const restoreOwnerStart = mainSource.indexOf(
    'async function restoreAdvertisedDatasetState({ requestStep, signal })'
  );
  const restoreOwnerEnd = mainSource.indexOf(
    '// -----------------------------------------------------------------------',
    restoreOwnerStart
  );
  const restoreOwner = mainSource.slice(
    restoreOwnerStart,
    restoreOwnerEnd
  );
  const classificationIndex = restoreOwner.indexOf(
    'classifyAdvertisedDatasetStateRestoreError(error'
  );
  const consoleErrorIndex = restoreOwner.indexOf(
    'console.error(',
    classificationIndex
  );
  assert.ok(classificationIndex >= 0);
  assert.ok(consoleErrorIndex > classificationIndex);
  assert.match(
    restoreOwner.slice(classificationIndex, consoleErrorIndex),
    /if \(classified !== null\) return classified;/
  );
  assert.doesNotMatch(
    restoreOwner.slice(classificationIndex, consoleErrorIndex),
    /notifications\.error|console\.error/
  );
});

test('reload failure handling requires exact transaction and handler ownership', async () => {
  const { handleDatasetReloadFailure } =
    await import(outcomeModuleUrl);
  const error = new Error('candidate failed');
  const transaction = {
    isCurrent: () => true,
    assertCurrent() {}
  };
  await assert.rejects(
    handleDatasetReloadFailure({
      error,
      transaction,
      reportFailure: () => {}
    }),
    /missing key.*cancel/i
  );
  await assert.rejects(
    handleDatasetReloadFailure({
      error,
      transaction,
      cancel: null,
      reportFailure: () => {}
    }),
    /handlers must be functions/i
  );
  await assert.rejects(
    handleDatasetReloadFailure({
      error,
      transaction,
      cancel: () => {},
      reportFailure: () => {},
      legacyRecovery: true
    }),
    /unexpected key.*legacyRecovery/i
  );
});

test('post-publication UI errors remain truthful ready outcomes', async () => {
  const {
    createDatasetRuntimeRetirementOwner,
    settlePublishedDatasetUi
  } =
    await import(outcomeModuleUrl);
  let readyFinalizations = 0;
  const ready = await settlePublishedDatasetUi({
    synchronize() {},
    finalize() {
      readyFinalizations++;
    },
    reportFailure: () => assert.fail('ready UI was reported as failed')
  });
  assert.deepEqual(ready, { status: 'ready' });
  assert.equal(readyFinalizations, 1);

  const uiError = new Error('dimension selector render failed');
  const reported = [];
  let impairedFinalizations = 0;
  const impaired = await settlePublishedDatasetUi({
    synchronize() {
      throw uiError;
    },
    finalize() {
      impairedFinalizations++;
    },
    reportFailure: error => reported.push(error)
  });
  assert.equal(impaired.status, 'ready-ui-error');
  assert.equal(impaired.error, uiError);
  assert.deepEqual(reported, [uiError]);
  assert.equal(impairedFinalizations, 1);

  const retirementError = new Error('coordinate cache release failed');
  const retirementReports = [];
  const retirementImpaired = await settlePublishedDatasetUi({
    synchronize() {},
    finalize() {
      throw retirementError;
    },
    reportFailure: error => retirementReports.push(error)
  });
  assert.equal(retirementImpaired.status, 'ready-ui-error');
  assert.equal(retirementImpaired.error, retirementError);
  assert.deepEqual(retirementReports, [retirementError]);

  const combinedReports = [];
  const combined = await settlePublishedDatasetUi({
    synchronize() {
      throw uiError;
    },
    finalize() {
      throw retirementError;
    },
    reportFailure: error => combinedReports.push(error)
  });
  assert.equal(combined.status, 'ready-ui-error');
  assert.ok(combined.error instanceof AggregateError);
  assert.deepEqual(combined.error.errors, [uiError, retirementError]);
  assert.deepEqual(combinedReports, [combined.error]);

  const retirementOwner = createDatasetRuntimeRetirementOwner();
  let successfulClears = 0;
  const successfulResource = {
    clearCache() {
      successfulClears++;
    }
  };
  assert.equal(retirementOwner.retire(successfulResource), true);
  assert.equal(retirementOwner.retire(successfulResource), false);
  assert.equal(successfulClears, 1);

  let failedClears = 0;
  const failedResource = {
    clearCache() {
      failedClears++;
      throw retirementError;
    }
  };
  assert.throws(
    () => retirementOwner.retire(failedResource),
    error => error === retirementError
  );
  assert.equal(retirementOwner.retire(failedResource), false);
  assert.equal(failedClears, 1);

  await assert.rejects(
    settlePublishedDatasetUi({
      synchronize() {},
      finalize() {},
      reportFailure() {},
      fallbackToOldUi: true
    }),
    /unexpected key.*fallbackToOldUi/i
  );
});

test(
  'superseded published UI synchronization finalizes silently without impaired-controls diagnostics',
  async () => {
    const {
      createDatasetReloadSupersededError,
      settlePublishedDatasetUi
    } = await import(outcomeModuleUrl);
    const events = [];
    const outcome = await settlePublishedDatasetUi({
      synchronize() {
        throw createDatasetReloadSupersededError(
          'Dataset reload was superseded by a newer selection.'
        );
      },
      finalize() {
        events.push('finalize');
      },
      reportFailure() {
        events.push('report');
      }
    });

    assert.deepEqual(outcome, { status: 'superseded' });
    assert.deepEqual(events, ['finalize']);
  }
);

test(
  'superseded published UI synchronization preserves a finalization failure without reporting stale diagnostics',
  async () => {
    const {
      createDatasetReloadSupersededError,
      settlePublishedDatasetUi
    } = await import(outcomeModuleUrl);
    const finalizationError = new Error(
      'exact stale publication finalization failure'
    );
    const reports = [];
    const outcome = await settlePublishedDatasetUi({
      synchronize() {
        throw createDatasetReloadSupersededError(
          'Dataset reload was superseded by a newer selection.'
        );
      },
      finalize() {
        throw finalizationError;
      },
      reportFailure(error) {
        reports.push(error);
      }
    });

    assert.equal(outcome.status, 'superseded');
    assert.equal(outcome.finalizationError, finalizationError);
    assert.deepEqual(reports, []);
  }
);

test('dimension cache invalidation rejects delayed positions without republishing', async () => {
  const manager = new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap', 2]])
  });
  const oldPayload = deferred();
  manager.loadLayout = () => oldPayload.promise;

  const older = manager.getPositions('X_umap', { showProgress: false });
  manager.clearCache();
  // The replacement declares an embedding of the same id at another path;
  // the delayed payload of the cleared generation still cannot land.
  manager.initFromMetadata(
    embeddingsMetadata([['X_pca', 2], ['X_umap', 2]])
  );
  oldPayload.resolve(new Float32Array([0, 0, 1, 1]));

  await assert.rejects(older, /dimension.*(changed|superseded|cleared)/i);
  assert.equal(manager.normalizedPositionCache.size, 0);
  assert.equal(manager.normTransformCache.size, 0);
  assert.equal(manager.nCells, 0);
});

test('dimension metadata accepts only exact embedding items, defaults, and dimensions', () => {
  const valid = () => embeddingsMetadata([['X_umap', 2], ['X_umap_3d', 3]]);
  const rejected = [];
  const mutate = (change) => {
    const metadata = valid();
    change(metadata);
    rejected.push(metadata);
  };
  mutate(metadata => { delete metadata.defaults; });
  mutate(metadata => { metadata.items = {}; });
  mutate(metadata => { metadata.items.X_umap.dimension = 2.5; });
  mutate(metadata => { metadata.items.X_umap.dimension = '2'; });
  mutate(metadata => { metadata.items.X_umap.dimension = 4; });
  mutate(metadata => { metadata.default_dimension = 1; });
  mutate(metadata => { metadata.defaults = { '2d': 'X_umap' }; });
  mutate(metadata => { metadata.defaults['1d'] = 'X_umap'; });
  mutate(metadata => { metadata.defaults['2d'] = 'X_umap_3d'; });
  mutate(metadata => { metadata.defaults['2d'] = 'X_missing'; });
  mutate(metadata => { metadata.items.X_umap.file = ''; });
  mutate(metadata => { metadata.items.X_umap.label = ''; });
  mutate(metadata => { delete metadata.items.X_umap.source; });
  mutate(metadata => { metadata.items.X_umap.source.columns = [0]; });
  mutate(metadata => { metadata.items.X_umap.obsm_key = 'X_umap'; });
  mutate(metadata => { metadata.files = { '2d': 'points_2d.bin' }; });
  for (const metadata of rejected) {
    assert.throws(
      () => new DimensionManager({ embeddingsMetadata: metadata }),
      /embedding|dimension|default|item|label|path|source|provenance/i
    );
  }

  // Neither version-2 path map is read any more.
  for (const legacy of [
    { available_dimensions: [2], default_dimension: 2, files: { '2d': 'points_2d.bin' } },
    { available_dimensions: [2], default_dimension: 2, obsm_keys: { '2d': 'X_umap' } },
  ]) {
    assert.throws(
      () => new DimensionManager({ embeddingsMetadata: legacy }),
      /exactly default_dimension, defaults, and items/
    );
  }

  // A direct AnnData identity is an ordinary version-3 identity: its layout
  // reads the item's file and records the obsm array it was read from.
  const direct = new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap', 2]]),
  });
  assert.equal(direct.getLayout('X_umap').path, 'embeddings/0_2d.bin');
  assert.deepEqual(
    direct.getLayout('X_umap').provenance,
    { key: 'X_umap', columns: [0, 1] }
  );
});

test('dimension metadata replacement validates completely before mutation', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap_3d', 3]]),
  });

  // A complete candidate except that 2D has no default.
  const candidate = embeddingsMetadata([['X_umap_1d', 1], ['X_umap', 2]]);
  delete candidate.defaults['2d'];
  assert.throws(
    () => manager.initFromMetadata(candidate),
    /defaults must name exactly one embedding per dimension/i
  );
  assert.deepEqual(manager.getAvailableDimensions(), [3]);
  assert.equal(manager.getDefaultDimension(), 3);
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_umap_3d']);
  assert.equal(manager.getDefaultLayoutKey(), 'X_umap_3d');
  assert.equal(manager.hasLayout('X_umap_1d'), false);
  assert.deepEqual(
    manager.getLayoutsForDimension(3).map(layout => layout.path),
    ['embeddings/0_3d.bin'],
  );
});

test('dimension cache invalidation aborts fetch and dismisses stale progress', async t => {
  const originalFetch = globalThis.fetch;
  const fetchStarted = deferred();
  const events = captureDownloadNotifications(t);
  let requestSignal = null;

  globalThis.fetch = (_url, options = {}) => {
    requestSignal = options.signal ?? null;
    fetchStarted.resolve();
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error('synthetic fetch abort');
        error.name = 'AbortError';
        reject(error);
      };
      if (requestSignal?.aborted) {
        rejectAbort();
        return;
      }
      requestSignal?.addEventListener('abort', rejectAbort, { once: true });
    });
  };
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });

  const manager = new DimensionManager({
    baseUrl: 'https://cellucid.test/data/',
    embeddingsMetadata: embeddingsMetadata([['X_umap', 2]], { gzip: true })
  });

  const loading = manager.getPositions('X_umap', { showProgress: true });
  await fetchStarted.promise;
  manager.clearCache();

  assert.ok(requestSignal, 'dimension fetch must receive an AbortSignal');
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(loading, error => error?.name === 'AbortError');
  assert.deepEqual(
    events.filter(event => ['start', 'complete', 'fail', 'dismiss'].includes(event.kind))
      .map(event => event.kind),
    ['start', 'dismiss']
  );
});

test('dimension clear promptly rejects coalesced direct AnnData work without stale success', async t => {
  const decoderStarted = deferred();
  const decoderFinished = deferred();
  const decoderPayload = deferred();
  let decoderCalls = 0;

  installActiveAnnDataAdapter(t, {
    getEmbeddingPayload(path, dimension) {
      // The layout's identity file and dimension name the payload.
      assert.equal(path, 'embeddings/0_2d.bin');
      assert.equal(dimension, 2);
      decoderCalls++;
      decoderStarted.resolve();
      return decoderPayload.promise.finally(() => decoderFinished.resolve());
    }
  });
  t.after(() => {
    decoderPayload.resolve(new Float32Array([0, 0, 1, 1]));
  });

  const events = captureDownloadNotifications(t);
  const manager = new DimensionManager({
    baseUrl: 'h5ad://pending-direct-anndata/',
    embeddingsMetadata: embeddingsMetadata([['X_umap', 2]])
  });

  const first = manager.getPositions('X_umap', { showProgress: true });
  const second = manager.getPositions('X_umap', { showProgress: true });
  const observe = promise => promise.then(
    value => ({ status: 'fulfilled', value }),
    error => ({ error, status: 'rejected' })
  );
  const firstObserved = observe(first);
  const secondObserved = observe(second);

  await decoderStarted.promise;
  assert.equal(decoderCalls, 1, 'direct AnnData embedding decode must be shared');
  manager.clearCache();

  const promptOutcome = await Promise.race([
    Promise.all([firstObserved, secondObserved]),
    new Promise(resolve => {
      setTimeout(() => resolve('still-pending'), 50);
    })
  ]);
  assert.notEqual(
    promptOutcome,
    'still-pending',
    'cache clear must reject callers without waiting for a non-abortable decoder'
  );
  for (const outcome of promptOutcome) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.error?.name, 'AbortError');
  }

  const terminalKinds = () => events
    .filter(event => ['start', 'complete', 'fail', 'dismiss'].includes(event.kind))
    .map(event => event.kind);
  assert.deepEqual(terminalKinds(), ['start', 'dismiss']);

  decoderPayload.resolve(new Float32Array([0, 0, 1, 1]));
  await decoderFinished.promise;
  await Promise.resolve();
  assert.deepEqual(
    terminalKinds(),
    ['start', 'dismiss'],
    'late decoder completion must not publish success'
  );
  assert.equal(manager.normalizedPositionCache.size, 0);
  assert.equal(manager.normTransformCache.size, 0);
});

test('concurrent 2D position callers share one normalization and progress transaction', async t => {
  const events = captureDownloadNotifications(t);
  const rawPositions = deferred();
  const loadStarted = deferred();
  const loadOptions = [];
  let loadCalls = 0;

  const manager = new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap', 2]])
  });
  manager.loadLayout = (layoutKey, options) => {
    loadCalls++;
    loadOptions.push({ layoutKey, options });
    loadStarted.resolve();
    return rawPositions.promise;
  };
  t.after(() => {
    rawPositions.resolve(new Float32Array([0, 0, 2, 2]));
  });

  const first = manager.getPositions('X_umap', { showProgress: true });
  const second = manager.getPositions('X_umap', { showProgress: true });
  await loadStarted.promise;
  rawPositions.resolve(new Float32Array([0, 0, 2, 2]));

  const [firstPositions, secondPositions] = await Promise.all([first, second]);
  assert.equal(loadCalls, 1, 'raw load must be entered once');
  assert.strictEqual(
    firstPositions,
    secondPositions,
    'all callers must receive the one normalized result'
  );
  assert.equal(loadOptions[0].layoutKey, 'X_umap');
  assert.equal(loadOptions[0].options.showProgress, false);
  assert.equal(
    loadOptions[0].options.progressTrackerId,
    events.find(event => event.kind === 'start')?.id
  );
  assert.deepEqual(
    events.filter(event => ['start', 'complete', 'fail', 'dismiss'].includes(event.kind))
      .map(event => event.kind),
    ['start', 'complete']
  );
});

test('position normalization admits every layout beyond the budget and keeps pinned ones', async () => {
  const metadata = embeddingsMetadata(
    [['X_umap', 2], ['X_umap_3d', 3]],
    { defaultDimension: 2 }
  );
  // A pinned layout no view shows keeps its 24 bytes; 16 more exceed 31, and
  // the budget is a residency policy: the second layout still loads.
  const overBudget = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: 31
  });
  overBudget.loadLayout = async layoutKey => (
    layoutKey === 'X_umap_3d'
      ? new Float32Array([0, 0, 0, 1, 1, 1])
      : new Float32Array([0, 0, 1, 1])
  );
  overBudget.pinLayout('X_umap_3d');
  await overBudget.getPositions('X_umap_3d', { showProgress: false });
  assert.equal(
    (await overBudget.getPositions('X_umap', { showProgress: false })).byteLength,
    16
  );
  assert.ok(overBudget.getResidentPositions('X_umap_3d'), 'the pinned layout stays');

  // What the views show, plus the layout being shown, is never refused --
  // not even above the budget (a browser that reports little memory).
  const shown = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: 15
  });
  shown.loadLayout = async () => new Float32Array([0, 0, 1, 1]);
  assert.equal((await shown.getPositions('X_umap', { showProgress: false })).byteLength, 16);

  const exact = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: 16
  });
  const raw2D = new Float32Array([0, 0, 1, 1]);
  exact.loadLayout = async () => raw2D;
  const normalized2D = await exact.getPositions('X_umap', { showProgress: false });
  assert.strictEqual(
    normalized2D,
    raw2D,
    'a 2D embedding is normalized in place: no padded or second buffer exists'
  );
  assert.equal(
    normalized2D.byteLength,
    16,
    'raw bytes equal to the configured limit must remain valid'
  );
  assert.deepEqual([...normalized2D], [-1, -1, 1, 1]);
  assert.deepEqual(exact.getNormTransform('X_umap'), { center: [0.5, 0.5, 0], scale: 2 });

  const shared3D = new Float32Array([0, 0, 0, 1, 1, 1]);
  const noCopy = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: shared3D.byteLength
  });
  noCopy.positionCache.set('X_umap_3d', shared3D);
  noCopy.loadLayout = async () => shared3D;
  assert.strictEqual(
    await noCopy.getPositions('X_umap_3d', { showProgress: false }),
    shared3D,
    'in-place 3D normalization must count its shared raw/output buffer once'
  );
  assert.equal(
    noCopy.positionCache.has('X_umap_3d'),
    false,
    'no raw copy of a normalized layout stays resident'
  );
  assert.strictEqual(noCopy.getResidentPositions('X_umap_3d'), shared3D);
});

test('position normalization evicts stale dimension buffers before exceeding the cumulative bound', async () => {
  const manager = new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap_1d', 1], ['X_umap', 2]]),
    maxPositionBytes: 20
  });
  const rawByLayout = new Map([
    ['X_umap_1d', new Float32Array([0, 1])],
    ['X_umap', new Float32Array([0, 0, 1, 1])]
  ]);
  manager.loadLayout = async layoutKey => rawByLayout.get(layoutKey);

  await manager.getPositions('X_umap_1d', { showProgress: false });
  assert.deepEqual([...manager.normalizedPositionCache.keys()], ['X_umap_1d']);

  await manager.getPositions('X_umap', { showProgress: false });
  assert.deepEqual(
    [...manager.normalizedPositionCache.keys()],
    ['X_umap'],
    'the stale 8-byte 1D cache must be evicted before the 16-byte 2D load exceeds 20 bytes'
  );
  assert.ok(
    [...manager.normalizedPositionCache.values()]
      .reduce((bytes, positions) => bytes + positions.byteLength, 0) <= 20
  );

  const protectedManager = new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap_1d', 1], ['X_umap', 2]]),
    maxPositionBytes: 20
  });
  protectedManager.loadLayout = async layoutKey => rawByLayout.get(layoutKey);
  await protectedManager.getPositions('X_umap_1d', { showProgress: false });
  protectedManager.setViewLayout('snapshot', 'X_umap_1d');
  // 24 bytes is over the 20-byte budget, but it is exactly what the views
  // show plus the layout being shown, which the budget never refuses.
  await protectedManager.getPositions('X_umap', { showProgress: false });
  assert.deepEqual(
    [...protectedManager.normalizedPositionCache.keys()],
    ['X_umap_1d', 'X_umap'],
    'a cache still assigned to a view must not be evicted as stale'
  );
});

test('direct position loading fails before publishing success for malformed bytes', async t => {
  const originalFetch = globalThis.fetch;
  const events = captureDownloadNotifications(t);
  const malformedGzip = gzipSync(Uint8Array.of(7));
  globalThis.fetch = async () => new Response(malformedGzip, {
    headers: { 'content-length': String(malformedGzip.byteLength) },
    status: 200
  });
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    loadPointsBinary(
      'https://cellucid.test/data/embeddings/0_2d.bin.gz',
      { dimension: 2, expectedBytes: null, showProgress: true }
    ),
    /byte length|multiple of 4|Float32Array/i
  );
  assert.deepEqual(
    events.filter(event => ['start', 'complete', 'fail', 'dismiss'].includes(event.kind))
      .map(event => event.kind),
    ['start', 'fail']
  );
});

test('Fetch-decoded response progress never compares decoded bytes with encoded length', async t => {
  const originalFetch = globalThis.fetch;
  const events = captureDownloadNotifications(t);
  const decoded = new Float32Array([0, 1, 2, 3, 4, 5]);
  globalThis.fetch = async () => new Response(decoded.buffer, {
    headers: {
      'content-encoding': 'gzip',
      'content-length': '8',
    },
    status: 200,
  });
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });

  const points = await loadPointsBinary(
    'https://cellucid.test/data/embeddings/0_2d.bin',
    { dimension: 2, expectedBytes: null, showProgress: true }
  );

  assert.deepEqual(Array.from(points), Array.from(decoded));
  assert.deepEqual(
    events.map(event => event.kind),
    ['start', 'update', 'complete']
  );
  assert.deepEqual(
    events.find(event => event.kind === 'update'),
    {
      id: 'download-1',
      kind: 'update',
      loadedBytes: decoded.byteLength,
      totalBytes: null,
    }
  );
});

test('gzip loading requires its one native backend before any request', async t => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'DecompressionStream'
  );
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  Object.defineProperty(globalThis, 'DecompressionStream', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('gzip capability rejection must precede fetch');
  };
  t.after(() => {
    if (originalDescriptor) {
      Object.defineProperty(
        globalThis,
        'DecompressionStream',
        originalDescriptor
      );
    } else {
      delete globalThis.DecompressionStream;
    }
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    loadPointsBinary(
      'https://cellucid.test/data/embeddings/0_2d.bin.gz',
      { dimension: 2, expectedBytes: null, showProgress: false }
    ),
    /gzip payload.*requires browser DecompressionStream support/i
  );
  assert.equal(fetchCalls, 0);
});

test('position loading takes its dimension from the caller, never from the path', async t => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('a payload without a dimension must not be requested');
  };
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
  // A path that names a dimension does not state it; only the caller does.
  for (const url of [
    'https://cellucid.test/data/points_3d.bin',
    'https://cellucid.test/data/embeddings/0_2d.bin',
  ]) {
    for (const dimension of [undefined, 0, 4, '2', 2.5, null]) {
      const options = { expectedBytes: null };
      if (dimension !== undefined) options.dimension = dimension;
      await assert.rejects(
        loadPointsBinary(url, options),
        /requires the payload dimension: exactly 1, 2, or 3/
      );
    }
  }
  assert.equal(fetchCalls, 0);
});

test('prepared gzip loaders expose one exact decompression backend', async () => {
  const dataLoadersSource = await readFile(
    new URL('../assets/js/data/data-loaders.js', import.meta.url),
    'utf8'
  );
  const localUserSource = await readFile(
    new URL('../assets/js/data/local-user-source.js', import.meta.url),
    'utf8'
  );
  for (const source of [dataLoadersSource, localUserSource]) {
    assert.doesNotMatch(source, /\bpako\b|HAS_PAKO/i);
  }

  const progressStart = dataLoadersSource.indexOf(
    'async function fetchBinaryWithProgressInternal'
  );
  const progressEnd = dataLoadersSource.indexOf(
    '/**\n * Convert filename to safe version',
    progressStart
  );
  const progressSource = dataLoadersSource.slice(
    progressStart,
    progressEnd
  );
  assert.ok(
    progressSource.indexOf('requireGzipDecompressionStream(url)') <
      progressSource.indexOf('resolveAnyUrl(')
  );
  // Decompression is delegated to the one bounded gzip codec, so the progress
  // path constructs no decompression stream of its own.
  assert.equal(
    progressSource.match(/new GzipDecompressionStream\(/g),
    null
  );
  assert.match(
    dataLoadersSource,
    /import \{ gzipDecompress \} from '\.\.\/app\/session\/codecs\/gzip\.js';/
  );
  assert.equal(
    dataLoadersSource.match(/new GzipDecompressionStream\(/g),
    null
  );
  assert.match(
    localUserSource,
    /requirePreparedGzipDecompressionStream\(filename, this\.type\)/
  );
});

test('position normalization owns one outer progress transaction', async t => {
  const createManager = () => new DimensionManager({
    embeddingsMetadata: embeddingsMetadata([['X_umap', 2]])
  });

  const silentManager = createManager();
  const silentOptions = [];
  silentManager.loadLayout = async (layoutKey, options) => {
    silentOptions.push({ layoutKey, options });
    return new Float32Array([0, 0, 1, 1]);
  };
  await silentManager.getPositions('X_umap', { showProgress: false });
  assert.equal(silentOptions[0].layoutKey, 'X_umap');
  assert.equal(silentOptions[0].options.showProgress, false);
  assert.equal(silentOptions[0].options.progressTrackerId, null);

  const events = captureDownloadNotifications(t);
  const directManager = createManager();
  const directOptions = [];
  directManager.loadLayout = async (layoutKey, options) => {
    directOptions.push({ layoutKey, options });
    return new Float32Array([0, 0, 1, 1]);
  };
  await directManager.getPositions('X_umap');
  assert.equal(directOptions[0].options.showProgress, false);
  assert.equal(
    directOptions[0].options.progressTrackerId,
    events.find(event => event.kind === 'start')?.id
  );
  assert.deepEqual(
    events.filter(event => ['start', 'complete', 'fail', 'dismiss'].includes(event.kind))
      .map(event => event.kind),
    ['start', 'complete']
  );
});

test('in-place reload stages one generation before reversible publication', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const start = mainSource.indexOf(
    'async function reloadActiveDatasetInPlace'
  );
  const end = mainSource.indexOf(
    '// One-time helper to rebuild density',
    start
  );
  assert.ok(start >= 0 && end > start);
  const reloadSource = mainSource.slice(start, end);

  assert.match(
    mainSource,
    /!baseUrl\.endsWith\('\/'\)/
  );
  assert.doesNotMatch(
    mainSource,
    /baseUrl\.endsWith\('\/'\)\s*\?\s*baseUrl\s*:\s*`\$\{baseUrl\}\//,
    'application staging must reject a non-directory source URL, not repair it'
  );
  const selectionStageIndex = reloadSource.indexOf(
    'dataSourceManager.stageDatasetSelection('
  );
  const urlStageIndex = reloadSource.indexOf(
    'prepareUrlForDatasetSelection({'
  );
  const runtimeStageIndex = reloadSource.indexOf(
    'runtimeStage = await stageDatasetRuntime({'
  );
  const candidateBindingIndex = reloadSource.indexOf(
    'createCandidateAnnDataBinding('
  );
  const stagedSourceIndex = reloadSource.indexOf(
    'dataSourceManager.isCustomProtocolUrl('
  );
  const ownerRecheckIndex = reloadSource.indexOf(
    'reloadTransaction.assertCurrent();',
    runtimeStageIndex
  );
  const priorStateSettlementIndex = reloadSource.indexOf(
    'await cancelPublishedDatasetStateAndWait();',
    ownerRecheckIndex
  );
  const publicationOwnerRecheckIndex = reloadSource.indexOf(
    'reloadTransaction.assertCurrent();',
    priorStateSettlementIndex
  );
  const stagingCatch = reloadSource.indexOf('} catch (err) {');
  const stagingCatchEnd = reloadSource.indexOf(
    '// All fallible dataset I/O and validation has completed',
    stagingCatch
  );
  const stagingCatchSource = reloadSource.slice(
    stagingCatch,
    stagingCatchEnd
  );
  assert.ok(
    selectionStageIndex >= 0 &&
    urlStageIndex > selectionStageIndex &&
    candidateBindingIndex > urlStageIndex &&
    stagedSourceIndex > candidateBindingIndex &&
    runtimeStageIndex > urlStageIndex &&
    runtimeStageIndex > stagedSourceIndex &&
    ownerRecheckIndex > runtimeStageIndex &&
    priorStateSettlementIndex > ownerRecheckIndex &&
    publicationOwnerRecheckIndex > priorStateSettlementIndex &&
    stagingCatch > publicationOwnerRecheckIndex
  );
  assert.match(
    reloadSource.slice(runtimeStageIndex, stagingCatch),
    /baseUrl:\s*selectionStage\.baseUrl[\s\S]*candidateAnnDataBinding,[\s\S]*expectedIdentityId:\s*selectionStage\.identityId[\s\S]*showProgress:\s*isStartupLoad[\s\S]*signal:\s*reloadTransaction\.signal,[\s\S]*stagedSource/
  );
  assert.match(stagingCatchSource, /if \(runtimeStage !== null\)/);
  assert.equal(
    stagingCatchSource.match(
      /runtimeRetirementOwner\.retire\(\s*runtimeStage\.dimensionManager\s*\)/g
    )?.length,
    1
  );
  assert.match(
    stagingCatchSource,
    /dataSourceManager\.discardDatasetSelection\(selectionStage\)/
  );
  assert.doesNotMatch(
    reloadSource.slice(selectionStageIndex, stagingCatchEnd),
    /urlPublication\.commit|commitDatasetSelection|commitDatasetRuntimeStage/
  );

  const urlCommitIndex = reloadSource.indexOf(
    'urlPublication.commit()',
    stagingCatchEnd
  );
  const managerCommitIndex = reloadSource.indexOf(
    'dataSourceManager.commitDatasetSelection(selectionStage)',
    urlCommitIndex
  );
  const runtimeCommitIndex = reloadSource.indexOf(
    'commitDatasetRuntimeStage(runtimeStage)',
    managerCommitIndex
  );
  const publicationContinuationIndex = reloadSource.indexOf(
    'let managerListenerError = null;',
    runtimeCommitIndex
  );
  const managerPublishIndex = reloadSource.indexOf(
    'dataSourceManager.publishDatasetSelection(managerPublication)',
    runtimeCommitIndex
  );
  const successIndex = reloadSource.indexOf(
    'complete: () => dataLoad.succeed({'
  );
  const uiSyncIndex = reloadSource.indexOf(
    'const synchronizationOutcome = await synchronizePublishedDatasetUi('
  );
  const finalizationIndex = reloadSource.indexOf(
    'dataSourceManager.finalizeDatasetSelection(managerPublication)',
    uiSyncIndex
  );
  const stateRestoreIndex = reloadSource.indexOf(
    'const stateOutcome = await restoreAdvertisedDatasetState({',
    finalizationIndex
  );
  const stateSettlementIndex = reloadSource.indexOf(
    'await settlePublishedDatasetStateOutcome({',
    stateRestoreIndex
  );
  assert.ok(
    urlCommitIndex > stagingCatchEnd &&
    managerCommitIndex > urlCommitIndex &&
    runtimeCommitIndex > managerCommitIndex &&
    publicationContinuationIndex > runtimeCommitIndex &&
    managerPublishIndex > publicationContinuationIndex &&
    uiSyncIndex > managerPublishIndex &&
    finalizationIndex > uiSyncIndex &&
    stateRestoreIndex > finalizationIndex &&
    stateSettlementIndex > stateRestoreIndex &&
    successIndex > stateSettlementIndex
  );
  assert.doesNotMatch(
    reloadSource.slice(runtimeCommitIndex),
    /reloadTransaction\.adoptCurrentIdentity\(\)/
  );
  const managerPublicationCatch = reloadSource.slice(
    reloadSource.indexOf('} catch (error) {', urlCommitIndex),
    reloadSource.indexOf('let publication;', managerCommitIndex)
  );
  assert.match(managerPublicationCatch, /urlPublication\.rollback\(\)/);
  assert.match(
    managerPublicationCatch,
    /runtimeRetirementOwner\.retire\(\s*runtimeStage\.dimensionManager\s*\)/
  );
  assert.match(
    managerPublicationCatch,
    /return handleDatasetReloadFailure\(\{/
  );
  assert.doesNotMatch(
    reloadSource,
    /state\.(?:setDimensionManager|setFieldLoader|setVarFieldLoader|initVarData|initScene|setVectorFieldManager)/
  );
});

test(
  'every post-await dataset continuation rechecks its exact publication owner',
  async () => {
    const mainSource = await readFile(
      new URL('../assets/js/app/main.js', import.meta.url),
      'utf8'
    );
    const slice = (startNeedle, endNeedle, from = 0) => {
      const start = mainSource.indexOf(startNeedle, from);
      const end = mainSource.indexOf(endNeedle, start);
      assert.ok(start >= 0 && end > start);
      return mainSource.slice(start, end);
    };
    const requireCheckAfter = (
      source,
      awaitNeedle,
      checkNeedle,
      from = 0
    ) => {
      const awaitIndex = source.indexOf(awaitNeedle, from);
      const checkIndex = source.indexOf(checkNeedle, awaitIndex);
      assert.ok(
        awaitIndex >= 0 && checkIndex > awaitIndex,
        `expected ${checkNeedle} after ${awaitNeedle}`
      );
      return checkIndex;
    };
    const requireBefore = (source, firstNeedle, secondNeedle, message) => {
      const firstIndex = source.indexOf(firstNeedle);
      const secondIndex = source.indexOf(secondNeedle);
      assert.ok(
        firstIndex >= 0 && secondIndex > firstIndex,
        message
      );
    };

    const emptyPublication = slice(
      'function publishEmptyDatasetRuntime',
      'async function stageDatasetRuntime'
    );
    assert.match(
      emptyPublication,
      /publishRuntimeContinuation\(\{ runtimeKind: 'empty' \}\)/
    );
    requireBefore(
      emptyPublication,
      'requireRestorablePublication(restorationPublication)',
      'ui?.prepareDatasetReplacement?.()',
      'empty-runtime restoration must reject a stale publication before mutation'
    );
    const datasetCommit = slice(
      'function commitDatasetRuntimeStage',
      'function commitSyntheticRuntimeStage'
    );
    requireBefore(
      datasetCommit,
      'requireRestorablePublication(restorationPublication)',
      'ui?.prepareDatasetReplacement?.()',
      'dataset restoration must reject a stale publication before mutation'
    );
    const syntheticCommit = slice(
      'function commitSyntheticRuntimeStage',
      'function restoreRuntimeStage'
    );
    requireBefore(
      syntheticCommit,
      'requireRestorablePublication(restorationPublication)',
      'ui?.prepareDatasetReplacement?.()',
      'synthetic restoration must reject a stale publication before mutation'
    );
    const publicationOwner = slice(
      'function publishRuntimeContinuation',
      'function requireRestorablePublication'
    );
    assert.match(
      publicationOwner,
      /datasetPublicationOwner\.publish\(details\)/
    );
    assert.match(
      publicationOwner,
      /datasetPublicationGeneration = publication\.generation/
    );

    const uiSynchronization = slice(
      'async function synchronizePublishedDatasetUi',
      '// Startup publishes the empty runtime'
    );
    requireBefore(
      uiSynchronization,
      'retirePublishedDatasetSnapshotViews(publication)',
      'await ui?.settleFieldInteractions?.()',
      'published kept views must retire before the first asynchronous UI settlement'
    );
    const fieldSettlementCheck = requireCheckAfter(
      uiSynchronization,
      'await ui?.settleFieldInteractions?.()',
      'assertCurrentDatasetPublication(publication)'
    );
    requireCheckAfter(
      uiSynchronization,
      'await ui?.settleFieldInteractions?.()',
      'assertCurrentDatasetPublication(publication)'
    );
    requireCheckAfter(
      uiSynchronization,
      'await window._comparisonModule.resetForDatasetReload({',
      'assertCurrentDatasetPublication(publication)',
      fieldSettlementCheck + 1
    );
    assert.doesNotMatch(
      uiSynchronization,
      /transaction\.(?:assertCurrent|isCurrent|signal)/
    );

    const reload = slice(
      'async function reloadActiveDatasetInPlace',
      'async function clearActiveDatasetInPlace'
    );
    const reloadUiCheck = requireCheckAfter(
      reload,
      'const synchronizationOutcome = await synchronizePublishedDatasetUi(',
      'assertCurrentDatasetPublication(publication)'
    );
    const reloadManagerFinalization = reload.indexOf(
      'dataSourceManager.finalizeDatasetSelection(managerPublication)'
    );
    assert.ok(
      reloadManagerFinalization > reload.indexOf(
        'const synchronizationOutcome = await synchronizePublishedDatasetUi('
      ) &&
      reloadUiCheck > reloadManagerFinalization,
      'live publication must finalize its prior source before a stale continuation exits'
    );
    // Startup's sample-view requests are deadline-bound startup steps; both
    // end with the publication that owns them.
    assert.match(
      reload,
      /restoreAdvertisedDatasetState\(\{\s*requestStep: isStartupLoad\s*\? \(url, operation\) => startup\.step\('session', url, operation\)\s*: \(_url, operation\) => operation\(publication\.signal\),\s*signal: publication\.signal/s
    );
    assert.match(
      reload,
      /settlePublishedDatasetStateOutcome\(\{[\s\S]*transaction:\s*publication/
    );
    const reloadPublishedContinuation = reload.slice(
      reload.indexOf('let managerListenerError = null;')
    );
    assert.doesNotMatch(
      reloadPublishedContinuation,
      /reloadTransaction\.(?:adoptCurrentIdentity|assertCurrent|isCurrent|signal)/
    );

    const clear = slice(
      'async function clearActiveDatasetInPlace',
      '// One-time helper to rebuild density'
    );
    assert.match(
      clear,
      /emptyPublication\s*=\s*publishEmptyDatasetRuntime\(\{ clearViews: true \}\)/
    );
    const clearUiSettlement = clear.indexOf(
      'const synchronizationOutcome = await settlePublishedDatasetUi({'
    );
    requireCheckAfter(
      clear,
      'await ui?.settleFieldInteractions?.()',
      'assertCurrentDatasetPublication(emptyPublication)'
    );
    requireCheckAfter(
      clear,
      'await window._comparisonModule.resetForDatasetReload({',
      'assertCurrentDatasetPublication(emptyPublication)'
    );
    const clearManagerFinalization = clear.indexOf(
      'dataSourceManager.finalizeDatasetSelection(managerPublication)'
    );
    const clearPostSettlementCheck = clear.indexOf(
      'assertCurrentDatasetPublication(emptyPublication)',
      clearManagerFinalization
    );
    assert.ok(
      clear.indexOf(
        'assertCurrentDatasetPublication(emptyPublication)',
        clearManagerFinalization
      ) > clearManagerFinalization
    );
    assert.ok(
      clearManagerFinalization > clearUiSettlement &&
      clearPostSettlementCheck > clearManagerFinalization,
      'None publication must keep its previous source alive until field interaction settlement, then finalize it before stale exit'
    );
    const clearPublishedContinuation = clear.slice(
      clear.indexOf('let managerListenerError = null;')
    );
    assert.doesNotMatch(
      clearPublishedContinuation,
      /reloadTransaction\.(?:adoptCurrentIdentity|assertCurrent|isCurrent|signal)/
    );

    const synthetic = slice(
      'async function runBenchmark',
      'async function generateSituationReport'
    );
    let syntheticSearch = requireCheckAfter(
      synthetic,
      'await ensureBenchmarkModule()',
      'syntheticTransaction.isCurrent()'
    );
    // Generation is off-thread for every pattern now, so the one await that
    // used to belong to the GLB branch alone covers all of them.
    syntheticSearch = requireCheckAfter(
      synthetic,
      'data = await generateSyntheticDataOffThread({',
      'syntheticTransaction.isCurrent()',
      syntheticSearch + 1
    );
    assert.match(
      synthetic,
      /generateSyntheticDataOffThread\(\{[\s\S]*?signal: syntheticTransaction\.signal/,
      'a superseded run must terminate its generation worker'
    );
    syntheticSearch = requireCheckAfter(
      synthetic,
      'await cancelPublishedDatasetStateAndWait()',
      'syntheticTransaction.isCurrent()',
      syntheticSearch + 1
    );
    const syntheticSettlement = synthetic.indexOf(
      'const synchronizationOutcome = await settlePublishedDatasetUi({'
    );
    const syntheticFinalCheck = synthetic.indexOf(
      'syntheticPublication.isCurrent()',
      syntheticSettlement
    );
    const firstPostSettlementWrite = synthetic.indexOf(
      'if (renderModeSelect',
      syntheticSettlement
    );
    assert.ok(
      syntheticSettlement >= 0 &&
      syntheticFinalCheck > syntheticSettlement &&
      firstPostSettlementWrite > syntheticFinalCheck
    );
    assert.match(
      synthetic.slice(syntheticFinalCheck, firstPostSettlementWrite),
      /dismissSupersededBenchmark\(\)/
    );
    assert.doesNotMatch(
      synthetic.slice(syntheticSettlement),
      /syntheticTransaction\.(?:assertCurrent|isCurrent|signal)/
    );
    assert.match(
      synthetic,
      /const dismissSupersededBenchmark[\s\S]*notifications\.dismiss\(benchNotifId\)/
    );

    // A superseded run used to exit in silence: `return false` with the run's
    // own notification already dismissed, so a click that landed while a
    // dataset change was still settling was indistinguishable from a dead
    // button. Every superseded exit now names itself to the user.
    assert.doesNotMatch(
      synthetic,
      /if \(!syntheticTransaction\.isCurrent\(\)\) return false;/,
      'a superseded run must report itself rather than returning in silence'
    );
    assert.match(
      synthetic,
      /const dismissSupersededBenchmark[\s\S]*?return reportSupersededBenchmark\(\)/
    );
    assert.match(
      slice('function reportSupersededBenchmark', 'async function runBenchmark'),
      /notifications\.warning\(/
    );

    // `runBenchmark` rejects on publication failure, so a control that drops
    // its promise turns that into an unhandled rejection nobody sees.
    const controls = slice(
      '// Wire up run button',
      '// BOTTLENECK ANALYSIS (Single Button)'
    );
    assert.equal(
      [...controls.matchAll(/\brunBenchmark\(/g)].length,
      0,
      'controls must start runs through one owner that handles rejection'
    );
    assert.equal(
      [...controls.matchAll(/\bstartBenchmarkRun\(/g)].length,
      2,
      'the run button and the presets must both go through that owner'
    );
    assert.match(
      slice('function startBenchmarkRun', '// Wire up run button'),
      /runBenchmark\([\s\S]*?\)\.catch\(/
    );
  }
);

test('scientific publication excludes fallible UI and global reset work', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const commitStart = mainSource.indexOf(
    'function commitDatasetRuntimeStage'
  );
  const synchronizeStart = mainSource.indexOf(
    'function synchronizePublishedDatasetUi',
    commitStart
  );
  const initialStart = mainSource.indexOf(
    '// Startup publishes the empty runtime',
    synchronizeStart
  );
  assert.ok(
    commitStart >= 0 &&
    synchronizeStart > commitStart &&
    initialStart > synchronizeStart
  );

  const commitSource = mainSource.slice(commitStart, synchronizeStart);
  const synchronizeSource = mainSource.slice(
    synchronizeStart,
    initialStart
  );
  const ownerInitialization = mainSource.indexOf(
    'const connectivityRuntimeOwner = initializeConnectivityControls()'
  );
  const ownerValidation = mainSource.indexOf(
    "typeof connectivityRuntimeOwner.prepareDatasetReplacement !=="
  );
  const firstPublication = commitSource.indexOf(
    'EXPORT_BASE_URL = stage.baseUrl'
  );

  assert.ok(
    ownerInitialization >= 0 &&
    ownerValidation > ownerInitialization &&
    ownerValidation < commitStart &&
    firstPublication >= 0
  );
  assert.doesNotMatch(
    commitSource,
    /connectivityRuntimeOwner|connectivityCheckbox|connectivitySliders|connectivityControls|notifyUmapResolution|debug\.log|__resetConnectivityState/
  );
  assert.match(
    synchronizeSource,
    /connectivityRuntimeOwner\.synchronizeDatasetPublication\(\)/
  );
  assert.match(
    synchronizeSource,
    /ui\.refreshDatasetUI\(activeMetadata\)/
  );
  const connectivitySynchronizationStart = mainSource.indexOf(
    'function synchronizeDatasetPublication()'
  );
  const connectivitySynchronizationEnd = mainSource.indexOf(
    "connectivityCheckbox.addEventListener('change'",
    connectivitySynchronizationStart
  );
  const connectivitySynchronizationSource = mainSource.slice(
    connectivitySynchronizationStart,
    connectivitySynchronizationEnd
  );
  assert.doesNotMatch(commitSource, /clearKnnEdges/);
  assert.doesNotMatch(mainSource, /__resetConnectivityState/);
  assert.doesNotMatch(
    mainSource,
    /notifyUmapResolution|umap_resolution/
  );
});

test('connectivity edge publication has one abortable generation owner', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const connectivityStart = mainSource.indexOf(
    'function initializeConnectivityControls()'
  );
  const connectivityEnd = mainSource.indexOf(
    '// PERFORMANCE BENCHMARK CONTROLS',
    connectivityStart
  );
  assert.ok(connectivityStart >= 0 && connectivityEnd > connectivityStart);
  const connectivitySource = mainSource.slice(
    connectivityStart,
    connectivityEnd
  );

  assert.equal(connectivitySource.match(/loadEdges\(/g)?.length, 1);
  assert.equal(
    connectivitySource.match(/await ensureConnectivityEdgesLoaded\(\)/g)
      ?.length,
    2
  );
  // The graph in use is read from where its manifest was published: the
  // dataset's own connectivity_manifest.json or a mapped graph's.
  assert.match(
    connectivitySource,
    /loadEdges\(\s*owner\.manifestUrl,\s*owner\.manifest,\s*\{ signal: owner\.controller\.signal \}/s
  );
  assert.match(connectivitySource, /manifestUrl: connectivityManifestUrl/);
  assert.match(connectivitySource, /owner\.manifestUrl !== connectivityManifestUrl/);
  assert.match(
    connectivitySource,
    /publicationGeneration: datasetPublicationGeneration/
  );
  assert.match(connectivitySource, /manifest: connectivityManifest/);
  assert.match(connectivitySource, /exportBaseUrl: EXPORT_BASE_URL/);
  assert.match(
    connectivitySource,
    /sourceType,\s*datasetId,\s*identityId,\s*managerBaseUrl,/s
  );
  assert.match(
    connectivitySource,
    /localSelectionIdentity: userSource\.getSelectionIdentity\(\)/
  );
  assert.match(
    connectivitySource,
    /localAdoptionIdentity: userSource\.getAdoptionIdentity\(\)/
  );
  assert.doesNotMatch(
    connectivitySource,
    /(?:sources|destinations|weights): edgeData\.\w+\.slice\(\)/
  );
  // The shown order is computed, never stored: the loaded arrays are not
  // reordered or copied.
  assert.doesNotMatch(connectivitySource, /shuffle/i);
  assert.match(
    connectivitySource,
    /loadedEdgeData = publishedEdgeData/
  );
  assert.doesNotMatch(connectivitySource, /ratio-based approximation/i);
  assert.doesNotMatch(
    connectivitySource,
    /combinedVisibilityBuffers|cachedCombinedVisibility/
  );
  assert.match(
    connectivitySource,
    /viewer\.getViewTransparency\(viewId\)/
  );
  assert.match(
    connectivitySource,
    /viewer\.getViewDimension\(viewId\)/
  );
  assert.match(
    connectivitySource,
    /getConnectivityVisibilityOwner\(\s*'live',\s*viewer\.getViewDimension\('live'\)\s*\)/s
  );
  assert.doesNotMatch(
    connectivitySource,
    /getCombinedVisibility|getLodVisibilityArray/
  );
  assert.match(
    connectivitySource,
    /viewer\.getCurrentLodMembership\(viewId,\s*dimensionLevel\)/
  );
  assert.match(
    connectivitySource,
    /viewer\.updateEdgeVisibilityV2FromLod\(\s*visibility\.transparency,\s*visibility\.lodMembership\s*\)/s
  );
  assert.match(
    connectivitySource,
    /viewer\.updateEdgeVisibilityV2ForViewFromLod\(\s*viewId,\s*visibility\.transparency,\s*visibility\.lodMembership\s*\)/s
  );
  assert.doesNotMatch(mainSource, /POINT_VISIBILITY_THRESHOLD/);
  assert.match(
    connectivitySource,
    /viewer\.refreshEdgeSelectionForView\(viewId\)/
  );
  assert.match(
    connectivitySource,
    /viewer\.setEdgeVisibleTarget\(\s*Math\.min\(currentEdgeLimit, getTotalEdges\(\)\)\s*\)/s
  );
  assert.match(connectivitySource, /viewer\.onLodChanged\(event =>/);
  assert.match(
    connectivitySource,
    /updateEdgeVisibilityForView\(viewId\)/
  );
  assert.doesNotMatch(
    connectivitySource,
    /new Float32Array\(n\)/
  );

  const ensureStart = connectivitySource.indexOf(
    'function ensureConnectivityEdgesLoaded()'
  );
  const checkboxStart = connectivitySource.indexOf(
    "connectivityCheckbox.addEventListener('change'",
    ensureStart
  );
  const ensureSource = connectivitySource.slice(ensureStart, checkboxStart);
  const awaitLoad = ensureSource.indexOf('const edgeData = await loadEdges(');
  const postAwaitOwnerCheck = ensureSource.indexOf(
    'assertCurrentConnectivityLoadOwner(owner)',
    awaitLoad
  );
  const rendererPublication = ensureSource.indexOf(
    'rendererPublicationStarted = true',
    postAwaitOwnerCheck
  );
  assert.ok(
    awaitLoad >= 0 &&
    postAwaitOwnerCheck > awaitLoad &&
    rendererPublication > postAwaitOwnerCheck
  );
  assert.match(ensureSource, /Object\.freeze\(owner\)/);

  const resetStart = connectivitySource.indexOf(
    'function prepareDatasetReplacement()'
  );
  const synchronizationStart = connectivitySource.indexOf(
    'function synchronizeDatasetPublication()',
    resetStart
  );
  const resetSource = connectivitySource.slice(
    resetStart,
    synchronizationStart
  );
  assert.match(resetSource, /abortConnectivityLoad\(\)/);
  assert.match(resetSource, /loadedEdgeData = null/);
  assert.match(resetSource, /connectivityToggleGeneration\+\+/);
  assert.match(resetSource, /viewer\.clearEdgesV2\(\)/);
  assert.match(resetSource, /viewer\.clearKnnEdges\(\)/);
  const failedPublicationCleanupStart = connectivitySource.indexOf(
    'function clearPublishedConnectivityEdges()'
  );
  assert.ok(
    failedPublicationCleanupStart >= 0,
    'a failed renderer publication must have one defined exact cleanup'
  );
  const failedPublicationCleanupEnd = connectivitySource.indexOf(
    'function ensureConnectivityEdgesLoaded()',
    failedPublicationCleanupStart
  );
  const failedPublicationCleanupSource = connectivitySource.slice(
    failedPublicationCleanupStart,
    failedPublicationCleanupEnd
  );
  assert.match(failedPublicationCleanupSource, /viewer\.clearEdgesV2\(\)/);
  assert.match(failedPublicationCleanupSource, /viewer\.clearKnnEdges\(\)/);
  assert.match(failedPublicationCleanupSource, /edgesLoaded = false/);
  assert.match(failedPublicationCleanupSource, /loadedEdgeData = null/);
  assert.match(failedPublicationCleanupSource, /edgeSources = null/);
  assert.match(failedPublicationCleanupSource, /edgeDestinations = null/);
  assert.match(
    failedPublicationCleanupSource,
    /activeConnectivityStatsViewId = null/
  );
  assert.doesNotMatch(
    connectivitySource,
    /visibleEdgePrefixSum|cachedConnectivityVisibility/
  );
  assert.match(
    ensureSource,
    /clearPublishedConnectivityEdges\(\)/
  );
  assert.doesNotMatch(ensureSource, /resetEdgeState\(\)/);
  assert.match(
    connectivitySource,
    /isDatasetReloadSupersededError\(err\)/
  );
  const publicationSynchronizationSource = connectivitySource.slice(
    synchronizationStart,
    connectivitySource.indexOf(
      'function publishConnectivityEdges',
      synchronizationStart
    )
  );
  assert.doesNotMatch(
    publicationSynchronizationSource,
    /viewer\.clearEdgesV2|viewer\.clearKnnEdges|resetEdgeState/
  );
});

test('isolated local dataset candidates publish one truthful terminal outcome', async t => {
  await t.test('activation failure retires the candidate and preserves the source', async t => {
    const result = await runLocalSelection(t, {
      activateDataset: async () => {
        throw new Error('synthetic activation failure');
      }
    });

    const terminal = result.notificationEvents.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.deepEqual(
      terminal.map(event => event.kind),
      ['fail']
    );
    assert.match(terminal[0].message, /activation failure/i);
    assert.equal(result.candidate.disconnectCalls, 1);
    assert.equal(result.userSource.candidateCreations, 1);
    assert.equal(result.populateCalls, 0);
    assert.deepEqual(result.browserState.historyReplacements, []);
  });

  await t.test('false activation outcome is never ready and never announced twice', async t => {
    // `false` is the dataset controls saying they have already explained the
    // failure next to the dataset select, so the file's own progress entry is
    // withdrawn rather than failed with a second message.
    const result = await runLocalSelection(t, {
      activateDataset: async () => false
    });

    const terminal = result.notificationEvents.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.deepEqual(terminal, []);
    assert.equal(
      result.notificationEvents.some(event => event.kind === 'dismiss'),
      true
    );
    assert.equal(result.candidate.disconnectCalls, 1);
    assert.equal(result.populateCalls, 0);
  });

  await t.test('superseded reload dismisses without a failed terminal outcome', async t => {
    const { createDatasetReloadSupersededError } =
      await import(outcomeModuleUrl);
    const result = await runLocalSelection(t, {
      activateDataset: async () => {
        throw createDatasetReloadSupersededError(
          'Dataset reload was superseded by a newer selection.'
        );
      }
    });

    const terminal = result.notificationEvents.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.deepEqual(terminal, []);
    assert.equal(
      result.notificationEvents.some(event => event.kind === 'dismiss'),
      true
    );
    assert.equal(result.candidate.disconnectCalls, 1);
    assert.equal(result.populateCalls, 0);
  });

  await t.test('successful activation adopts the isolated candidate', async t => {
    const activations = [];
    const result = await runLocalSelection(t, {
      activateDataset: async selection => {
        activations.push(selection);
        return true;
      }
    });

    const terminal = result.notificationEvents.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.deepEqual(
      terminal.map(event => event.kind),
      ['complete']
    );
    assert.match(terminal[0].message, /ready.*2 cells/i);
    assert.equal(result.populateCalls, 1);
    assert.equal(result.candidate.disconnectCalls, 0);
    assert.equal(activations.length, 1);
    assert.equal(activations[0].source, result.candidate);
    assert.deepEqual(
      {
        datasetId: activations[0].datasetId,
        loadMethod: activations[0].loadMethod,
        sourceType: activations[0].sourceType,
      },
      {
        datasetId: 'local',
        loadMethod: DATA_LOAD_METHODS.LOCAL_H5AD,
        sourceType: 'local-user',
      }
    );
    assert.deepEqual(result.browserState.historyReplacements, []);
  });
});

test('local validation failures publish the validator error message exactly', async t => {
  installBrowserStubs(t);
  const notificationEvents = captureNotifications(t);
  const originalDebugError = debug.error;
  debug.error = () => {};
  t.after(() => {
    debug.error = originalDebugError;
  });

  const input = createFileInput();
  const validationError = new Error(
    'Zarr archive is missing required .zgroup metadata'
  );
  validationError.getUserMessage = () => 'Could not load this dataset';
  const candidate = {
    datasetId: null,
    disconnectCalls: 0,
    disconnect() {
      this.disconnectCalls++;
    },
    getType() {
      return 'local-user';
    },
    async loadFromZarrArchive() {
      throw validationError;
    },
  };
  const registered = {
    createSelectionCandidate: () => candidate,
    disconnect() {},
    getType: () => 'local-user',
  };
  let activationCalls = 0;

  initDatasetConnections({
    datasetIntents: createTestDatasetIntents(async () => {
      activationCalls++;
      return true;
    }),
    clearDataset: async () => true,
    dom: {
      select: { focus() {} },
      userDataZarrArchiveBtn: createButton(),
      userDataZarrArchiveInput: input,
    },
    dataSourceManager: {
      getCurrentSourceType: () => null,
      getSource: type => type === 'local-user' ? registered : null,
      registerSource() {},
      unregisterSource() {},
    },
    noneDatasetValue: '__none__',
    populateDatasetDropdown: async () =>
      Object.freeze({ status: 'ready' }),
  });

  await input.select([
    { name: 'broken.zarr.zip' },
  ]);

  assert.deepEqual(
    notificationEvents.filter(event => event.kind === 'fail'),
    [{
      id: 'local-load',
      kind: 'fail',
      message: validationError.message,
    }]
  );
  assert.equal(candidate.disconnectCalls, 1);
  assert.equal(activationCalls, 0);
});

test('connection analytics expose only exact current load methods', () => {
  // The browser opens Zarr only as a ZIP archive; a directory method would
  // name a load path that no longer exists.
  assert.equal(
    DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
    'local-user-zarr-zip'
  );
  assert.deepEqual(
    Object.keys(DATA_LOAD_METHODS)
      .filter(key => key.startsWith('LOCAL_ZARR')),
    ['LOCAL_ZARR_ZIP']
  );
  assert.equal(
    Object.values(DATA_LOAD_METHODS)
      .some(method => method.includes('disconnect')),
    false
  );
});

test('disconnect controls clear only their connection and never choose science', async t => {
  for (const connection of [
    {
      connectButtonKey: 'remoteConnectBtn',
      disconnectButtonKey: 'remoteDisconnectBtn',
      disconnectContainerKey: 'remoteDisconnectContainer',
      fieldKey: 'remoteServerUrl',
      initialHref:
        'https://cellucid.test/?remote=https%3A%2F%2Fserver.test%2F',
      sourceType: 'remote',
    },
    {
      connectButtonKey: 'githubConnectBtn',
      disconnectButtonKey: 'githubDisconnectBtn',
      disconnectContainerKey: 'githubDisconnectContainer',
      fieldKey: 'githubRepoUrl',
      initialHref: 'https://cellucid.test/?github=owner%2Frepository',
      sourceType: 'github-repo',
    },
  ]) {
    await t.test(connection.sourceType, async t => {
      const browserState = installBrowserStubs(t, connection.initialHref);
      const notificationEvents = captureNotifications(t);
      const connectButton = Object.assign(createButton(), {
        disabled: false,
        textContent: '',
      });
      const disconnectButton = createButton();
      const disconnectContainer = { hidden: false };
      const field = { disabled: false, value: '' };
      const dom = {
        select: { focus() {} },
        [connection.connectButtonKey]: connectButton,
        [connection.disconnectButtonKey]: disconnectButton,
        [connection.disconnectContainerKey]: disconnectContainer,
        [connection.fieldKey]: field,
      };
      let disconnectCalls = 0;
      let populateCalls = 0;
      let clearCalls = 0;
      const sourceLookups = [];
      const createConnectionSource = connected => ({
        async connect() {},
        createConnectionCandidate() {
          return createConnectionSource(false);
        },
        disconnect() {
          disconnectCalls++;
        },
        getConnectionInfo() {
          return connection.sourceType === 'remote'
            ? {
                status: connected ? 'connected' : 'disconnected',
                url: connected ? 'https://server.test/' : null,
              }
            : {
                connected,
                inputPath: connected ? 'owner/repository' : null,
              };
        },
        getType() {
          return connection.sourceType;
        },
        async listDatasets() {
          return [];
        },
        onConnectionLost() {},
      });
      const connectionSource = createConnectionSource(true);
      const sources = new Map([
        [connection.sourceType, connectionSource],
      ]);
      let currentSourceType = connection.sourceType;

      initDatasetConnections({
        datasetIntents: createTestDatasetIntents(async () => {
          assert.fail('disconnect must not activate a dataset');
        }),
        clearDataset: async () => {
          clearCalls++;
          currentSourceType = null;
          return true;
        },
        dom,
        dataSourceManager: {
          getCurrentSourceType: () => currentSourceType,
          getSource(type) {
            sourceLookups.push(type);
            return sources.get(type) ?? null;
          },
          registerSource(type, source) {
            sources.set(type, source);
          },
          unregisterSource(type) {
            sources.delete(type);
          },
        },
        populateDatasetDropdown() {
          populateCalls++;
          return Object.freeze({ status: 'ready' });
        },
        noneDatasetValue: '__none__',
      });

      await disconnectButton.activate();

      assert.equal(disconnectCalls, 1);
      assert.equal(connectButton.textContent, 'Connect');
      assert.equal(disconnectContainer.hidden, true);
      assert.equal(field.disabled, false);
      assert.deepEqual(sourceLookups, [connection.sourceType]);
      assert.equal(clearCalls, 1);
      assert.equal(populateCalls, 1);
      assert.notEqual(
        sources.get(connection.sourceType),
        connectionSource
      );
      const successes = notificationEvents.filter(
        event => event.kind === 'success'
      );
      assert.equal(successes.length, 1);
      assert.match(successes[0].message, /disconnected/i);
      assert.equal(browserState.historyReplacements.length, 0);
      assert.equal(
        globalThis.window.location.href,
        connection.initialHref
      );
    });
  }
});

test('dedicated Zarr ZIP control opens and activates the portable archive input', async t => {
  installBrowserStubs(t);
  const notificationEvents = captureNotifications(t);
  const input = createFileInput();
  const button = createButton();
  const archive = { name: 'portable.zarr.zip' };
  let selectedFiles = null;
  let activation = null;
  const metadata = {
    id: 'portable',
    name: 'portable.zarr',
    stats: { n_cells: 3 }
  };
  const userSource = {
    datasetId: 'portable',
    disconnect() {},
    getType: () => 'local-user',
    async loadFromZarrArchive(file) {
      selectedFiles = [file];
      return metadata;
    }
  };
  const registeredSource = {
    createSelectionCandidate: () => userSource,
    disconnect() {},
    getType: () => 'local-user',
  };
  const sources = new Map([['local-user', registeredSource]]);

  initDatasetConnections({
    datasetIntents: createTestDatasetIntents(async (
      datasetId,
      sourceType,
      loadMethod,
      source
    ) => {
      activation = { datasetId, loadMethod, source, sourceType };
      sources.set(sourceType, source);
      return true;
    }),
    clearDataset: async () => true,
    dom: {
      select: { focus() {} },
      userDataZarrArchiveBtn: button,
      userDataZarrArchiveInput: input
    },
    dataSourceManager: {
      getCurrentSourceType: () => null,
      getSource: type => sources.get(type) ?? null,
      registerSource(type, source) {
        sources.set(type, source);
      },
      unregisterSource(type) {
        sources.delete(type);
      },
    },
    noneDatasetValue: '__none__',
    populateDatasetDropdown: async () =>
      Object.freeze({ status: 'ready' }),
  });

  button.activate();
  assert.equal(input.pickerClicks, 1);
  await input.select([archive]);

  assert.deepEqual(selectedFiles, [archive]);
  assert.deepEqual(activation, {
    datasetId: 'portable',
    loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
    source: userSource,
    sourceType: 'local-user',
  });
  assert.equal(input.value, '');
  assert.deepEqual(
    notificationEvents
      .filter(event => event.kind === 'complete' || event.kind === 'fail')
      .map(event => event.kind),
    ['complete']
  );
});

test('browser local-data wiring invokes only portable current transports', async t => {
  installBrowserStubs(t);
  captureNotifications(t);
  const preparedInput = createFileInput();
  const h5adInput = createFileInput();
  const zarrInput = createFileInput();
  const archiveInput = createFileInput();
  const calls = [];
  const activations = [];
  function createUserSource() {
    return {
      datasetId: null,
      createSelectionCandidate: createUserSource,
      disconnect() {},
      getType: () => 'local-user',
      async loadFromPreparedDirectory(files) {
        calls.push(['prepared', files]);
        this.datasetId = 'prepared';
        return {
          id: this.datasetId,
          name: 'Prepared',
          stats: { n_cells: 1 },
        };
      },
      async loadFromH5adFile(file) {
        calls.push(['h5ad', file]);
        this.datasetId = 'h5ad';
        return {
          id: this.datasetId,
          name: 'H5AD',
          stats: { n_cells: 1 },
        };
      },
      async loadFromZarrArchive(file) {
        calls.push(['zarr-archive', file]);
        this.datasetId = 'zarr-archive';
        return {
          id: this.datasetId,
          name: 'Zarr archive',
          stats: { n_cells: 1 },
        };
      },
    };
  }
  const sources = new Map([['local-user', createUserSource()]]);

  initDatasetConnections({
    datasetIntents: createTestDatasetIntents(async (
      datasetId,
      sourceType,
      loadMethod,
      source
    ) => {
      activations.push({
        datasetId,
        loadMethod,
        source,
        sourceType,
      });
      sources.set(sourceType, source);
      return true;
    }),
    clearDataset: async () => true,
    dom: {
      select: { focus() {} },
      userDataBrowseBtn: createButton(),
      userDataFileInput: preparedInput,
      userDataH5adBtn: createButton(),
      userDataH5adInput: h5adInput,
      userDataZarrInput: zarrInput,
      userDataZarrArchiveBtn: createButton(),
      userDataZarrArchiveInput: archiveInput,
    },
    dataSourceManager: {
      getCurrentSourceType: () => null,
      getSource: type => sources.get(type) ?? null,
      registerSource(type, source) {
        sources.set(type, source);
      },
      unregisterSource(type) {
        sources.delete(type);
      },
    },
    populateDatasetDropdown: async () =>
      Object.freeze({ status: 'ready' }),
    noneDatasetValue: '__none__',
  });

  const preparedFiles = [
    { name: 'dataset_identity.json', webkitRelativePath: 'named.zarr/dataset_identity.json' },
    { name: 'stray.h5ad', webkitRelativePath: 'named.zarr/stray.h5ad' },
  ];
  const h5adFile = { name: 'direct.h5ad' };
  const zarrFiles = [
    { name: '.zgroup', webkitRelativePath: 'direct.zarr/.zgroup' },
    { name: 'stray.h5ad', webkitRelativePath: 'direct.zarr/stray.h5ad' },
  ];
  const archiveFile = { name: 'direct.zarr.zip' };

  await preparedInput.select(preparedFiles);
  await h5adInput.select([h5adFile]);
  await zarrInput.select(zarrFiles);
  await archiveInput.select([archiveFile]);

  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['prepared', 'h5ad', 'zarr-archive']
  );
  assert.equal(calls[0][1], preparedFiles);
  assert.equal(calls[1][1], h5adFile);
  assert.equal(calls[2][1], archiveFile);
  assert.deepEqual(
    activations.map(({ datasetId, loadMethod }) => [
      datasetId,
      loadMethod,
    ]),
    [
      ['prepared', 'local-user-prepared'],
      ['h5ad', 'local-user-h5ad'],
      ['zarr-archive', 'local-user-zarr-zip'],
    ]
  );
});
