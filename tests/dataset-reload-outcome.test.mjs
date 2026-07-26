import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';
import { DATA_LOAD_METHODS } from '../assets/js/analytics/tracker.js';
import {
  loadLatentEmbeddings,
  loadPointsBinary
} from '../assets/js/data/data-loaders.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import { debug } from '../assets/js/utils/debug.js';

const outcomeModuleUrl = new URL(
  '../assets/js/app/dataset-reload-outcome.js',
  import.meta.url
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test(
  'latent embedding loads reject an unavailable dimension without substitution or fetch',
  async t => {
    captureDownloadNotifications(t);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error('unexpected embedding fetch');
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    await assert.rejects(
      loadLatentEmbeddings({
        baseUrl: 'https://cellucid.test/data/',
        identity: {
          embeddings: {
            available_dimensions: [3],
            default_dimension: 3,
            files: { '3d': 'points_3d.bin' }
          }
        },
        dimension: 2
      }),
      /2D.*not available.*3D|available.*3D.*2D/i
    );
    assert.equal(fetchCalls, 0);
  }
);

test('latent embedding loading uses exactly the advertised file path', async t => {
  captureDownloadNotifications(t);
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async input => {
    requested.push(String(input));
    return new Response(
      new Float32Array([1, 2]).buffer,
      { status: 200 }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await loadLatentEmbeddings({
    baseUrl: 'https://cellucid.test/data/',
    identity: {
      embeddings: {
        available_dimensions: [2],
        default_dimension: 2,
        files: { '2d': 'advertised.bin' },
      },
    },
    dimension: 2,
  });

  assert.deepEqual(requested, [
    'https://cellucid.test/data/advertised.bin',
  ]);
  assert.deepEqual(Array.from(result.points), [1, 2]);
});

test('latent embedding loading rejects a missing advertised path before fetch', async t => {
  captureDownloadNotifications(t);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('unexpected embedding fetch');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    loadLatentEmbeddings({
      baseUrl: 'https://cellucid.test/data/',
      identity: {
        embeddings: {
          available_dimensions: [2],
          default_dimension: 2,
          files: {},
        },
      },
      dimension: 2,
    }),
    /2D.*file.*metadata|metadata.*2D.*file/i
  );
  assert.equal(fetchCalls, 0);
});

test('latent embedding loads preserve the exact advertised dimension and path', async t => {
  captureDownloadNotifications(t);
  const originalFetch = globalThis.fetch;
  const source = new Float32Array([0, 1, 2, 3]);
  const compressed = gzipSync(
    new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  );
  const requestedUrls = [];
  globalThis.fetch = async url => {
    requestedUrls.push(String(url));
    return new Response(compressed, {
      status: 200,
      headers: { 'Content-Length': String(compressed.byteLength) }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await loadLatentEmbeddings({
    baseUrl: 'https://cellucid.test/data/',
    identity: {
      embeddings: {
        available_dimensions: [2],
        default_dimension: 2,
        files: { '2d': 'custom_2d.bin.gz' }
      }
    },
    dimension: 2
  });

  assert.deepEqual(Array.from(result.points), [0, 1, 2, 3]);
  assert.equal(result.dimension, 2);
  assert.equal(result.cellCount, 2);
  assert.deepEqual(requestedUrls, [
    'https://cellucid.test/data/custom_2d.bin.gz'
  ]);
});

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

function unreadPositionProxy(values, onCoordinateRead) {
  const positions = new Float32Array(values);
  return new Proxy(positions, {
    get(target, property) {
      if (
        typeof property === 'string' &&
        /^(?:0|[1-9]\d*)$/.test(property)
      ) {
        onCoordinateRead();
        throw new Error('position coordinate touched before memory preflight');
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function runLocalSelection(t, { switchDataset, reloadDataset }) {
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
  const userSource = {
    datasetId: 'local',
    loadFromH5adFile: async () => metadata
  };
  let populateCalls = 0;

  initDatasetConnections({
    state: {},
    viewer: {},
    dom: { userDataH5adInput: input },
    dataSourceManager: {
      getSource: type => type === 'local-user' ? userSource : null,
      switchToDataset: switchDataset
    },
    reloadDataset,
    populateDatasetDropdown: () => {
      populateCalls++;
    },
    noneDatasetValue: '__none__'
  });

  await input.select([{ name: 'example.h5ad' }]);
  return { browserState, metadata, notificationEvents, populateCalls };
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
  assert.throws(
    () => validateDatasetPositionPayload({
      positions: new Float32Array([0, 1, 2, Number.NaN, 4, 5]),
      identity,
      dimension: 2
    }),
    /non-finite.*index 3/i
  );
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
    getDefaultDimension: () => 2,
    loadDimension: async () => new Float32Array(8),
    clearCache() {},
    async getPositions3D() {
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
    'normalization/padding must not run for a misaligned raw cell axis'
  );
});

test('position staging validates raw and rendered buffers and is owner-abortable', async () => {
  const { stageDatasetPositionPayload } =
    await import(outcomeModuleUrl);
  const controller = new AbortController();
  const calls = [];
  const manager = {
    nCells: 3,
    getDefaultDimension: () => 2,
    clearCache() {},
    async loadDimension(dimension, options) {
      calls.push(['raw', dimension, options]);
      return new Float32Array([0, 0, 1, 1, 2, 2]);
    },
    async getPositions3D(dimension, options) {
      calls.push(['render', dimension, options]);
      return new Float32Array([
        -1, -1, 0,
        0, 0, 0,
        1, 1, 0
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
    ['raw', 2, { showProgress: true }],
    ['render', 2, { showProgress: false }]
  ]);

  const pendingRaw = deferred();
  let clearCalls = 0;
  const abortingManager = {
    nCells: 0,
    getDefaultDimension: () => 2,
    loadDimension: () => pendingRaw.promise,
    getPositions3D: async () => {
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
        getDefaultDimension: () => 2,
        loadDimension: async () => new Float32Array(6),
        getPositions3D: async () => new Float32Array(9)
      },
      showProgress: false,
      signal: new AbortController().signal
    }),
    /requires a DimensionManager/i
  );
});

test('validated local activation distinguishes a retained source from reload failure', async t => {
  const { activateValidatedLocalDataset } = await import(outcomeModuleUrl);

  await t.test('auto-switch failure retains the validated source', async () => {
    const switchError = new Error('switch unavailable');
    let reloadCalls = 0;

    const outcome = await activateValidatedLocalDataset({
      switchDataset: async () => {
        throw switchError;
      },
      reloadDataset: async () => {
        reloadCalls++;
      }
    });

    assert.equal(outcome.status, 'validated-retained');
    assert.equal(outcome.error, switchError);
    assert.equal(reloadCalls, 0);
  });

  await t.test('post-switch reload failure rejects instead of becoming ready', async () => {
    const reloadError = new Error('required reload failed');
    let switchCalls = 0;

    await assert.rejects(
      activateValidatedLocalDataset({
        switchDataset: async () => {
          switchCalls++;
        },
        reloadDataset: async () => {
          throw reloadError;
        }
      }),
      error => error === reloadError
    );

    assert.equal(switchCalls, 1);
  });

  await t.test('successful switch and reload produce ready', async () => {
    const events = [];

    const outcome = await activateValidatedLocalDataset({
      switchDataset: async () => {
        events.push('switch');
      },
      reloadDataset: async () => {
        events.push('reload');
      }
    });

    assert.deepEqual(outcome, { status: 'ready' });
    assert.deepEqual(events, ['switch', 'reload']);
  });

  await t.test('reload ownership cannot be omitted or substituted', async () => {
    await assert.rejects(
      activateValidatedLocalDataset({
        switchDataset: async () => {},
        reloadDataset: null
      }),
      /handlers must be functions/i
    );
    await assert.rejects(
      activateValidatedLocalDataset({
        switchDataset: async () => {},
        reloadDataset: async () => {},
        legacyReloadDataset: async () => {}
      }),
      /unexpected key.*legacyReloadDataset/i
    );
  });
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
  const { settlePublishedDatasetUi } =
    await import(outcomeModuleUrl);
  const ready = settlePublishedDatasetUi({
    synchronize() {},
    reportFailure: () => assert.fail('ready UI was reported as failed')
  });
  assert.deepEqual(ready, { status: 'ready' });

  const uiError = new Error('dimension selector render failed');
  const reported = [];
  const impaired = settlePublishedDatasetUi({
    synchronize() {
      throw uiError;
    },
    reportFailure: error => reported.push(error)
  });
  assert.equal(impaired.status, 'ready-ui-error');
  assert.equal(impaired.error, uiError);
  assert.deepEqual(reported, [uiError]);

  assert.throws(
    () => settlePublishedDatasetUi({
      synchronize() {},
      reportFailure() {},
      fallbackToOldUi: true
    }),
    /unexpected key.*fallbackToOldUi/i
  );
});

test('dimension cache invalidation rejects delayed positions without republishing', async () => {
  const manager = new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'first.bin' }
    }
  });
  const oldPayload = deferred();
  manager.loadDimension = () => oldPayload.promise;

  const older = manager.getPositions3D(2, { showProgress: false });
  manager.clearCache();
  manager.initFromMetadata({
    available_dimensions: [2],
    default_dimension: 2,
    files: { '2d': 'second.bin' }
  });
  oldPayload.resolve(new Float32Array([0, 0, 1, 1]));

  await assert.rejects(older, /dimension.*(changed|superseded|cleared)/i);
  assert.equal(manager.paddedPositionCache.size, 0);
  assert.equal(manager.normTransformCache.size, 0);
  assert.equal(manager.nCells, 0);
});

test('dimension metadata accepts only exact advertised dimensions and paths', () => {
  for (const metadata of [
    {
      available_dimensions: [2],
      default_dimension: 2,
    },
    {
      available_dimensions: [2, 2],
      default_dimension: 2,
      files: { '2d': 'points.bin' },
    },
    {
      available_dimensions: [2.5],
      default_dimension: 2,
      files: { '2d': 'points.bin' },
    },
    {
      available_dimensions: ['2'],
      default_dimension: 2,
      files: { '2d': 'points.bin' },
    },
    {
      available_dimensions: [2],
      default_dimension: 3,
      files: { '2d': 'points.bin' },
    },
    {
      available_dimensions: [2],
      default_dimension: 2,
      files: {},
    },
    {
      available_dimensions: [2],
      default_dimension: 2,
      files: {
        '2d': 'points.bin',
        '3d': 'unadvertised.bin',
      },
    },
  ]) {
    assert.throws(
      () => new DimensionManager({ embeddingsMetadata: metadata }),
      /embedding|dimension|path/i
    );
  }

  const direct = new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [2],
      default_dimension: 2,
      obsm_keys: { '2d': 'X_umap' },
    },
  });
  assert.deepEqual(direct.dimensionFiles, { '2d': 'X_umap' });
});

test('dimension metadata replacement validates completely before mutation', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [3],
      default_dimension: 3,
      files: { '3d': 'working-3d.bin' },
    },
  });

  assert.throws(
    () => manager.initFromMetadata({
      available_dimensions: [1, 2],
      default_dimension: 2,
      files: { '1d': 'candidate-1d.bin' },
    }),
    /2d|path|embedding/i
  );
  assert.deepEqual(manager.availableDimensions, [3]);
  assert.equal(manager.defaultDimension, 3);
  assert.deepEqual(manager.dimensionFiles, {
    '3d': 'working-3d.bin',
  });
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
    embeddingsMetadata: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin.gz' }
    }
  });

  const loading = manager.getPositions3D(2, { showProgress: true });
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
    getEmbedding() {
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
    embeddingsMetadata: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin' }
    }
  });

  const first = manager.getPositions3D(2, { showProgress: true });
  const second = manager.getPositions3D(2, { showProgress: true });
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
  assert.equal(manager.paddedPositionCache.size, 0);
  assert.equal(manager.normTransformCache.size, 0);
});

test('concurrent 3D position callers share one padding and progress transaction', async t => {
  const events = captureDownloadNotifications(t);
  const rawPositions = deferred();
  const loadStarted = deferred();
  const loadOptions = [];
  let loadCalls = 0;

  const manager = new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin' }
    }
  });
  manager.loadDimension = (dim, options) => {
    loadCalls++;
    loadOptions.push({ dim, options });
    loadStarted.resolve();
    return rawPositions.promise;
  };
  t.after(() => {
    rawPositions.resolve(new Float32Array([0, 0, 2, 2]));
  });

  const first = manager.getPositions3D(2, { showProgress: true });
  const second = manager.getPositions3D(2, { showProgress: true });
  await loadStarted.promise;
  rawPositions.resolve(new Float32Array([0, 0, 2, 2]));

  const [firstPositions, secondPositions] = await Promise.all([first, second]);
  assert.equal(loadCalls, 1, 'raw load must be entered once');
  assert.strictEqual(
    firstPositions,
    secondPositions,
    'all callers must receive the one normalized/padded result'
  );
  assert.equal(loadOptions[0].dim, 2);
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

test('position padding preflights the exact combined working set before coordinate access', async () => {
  const metadata = {
    available_dimensions: [2, 3],
    default_dimension: 2,
    files: {
      '2d': 'points_2d.bin',
      '3d': 'points_3d.bin'
    }
  };
  let coordinateReads = 0;
  const rejected = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: 39
  });
  rejected.loadDimension = async () => unreadPositionProxy(
    [0, 0, 1, 1],
    () => {
      coordinateReads++;
    }
  );

  await assert.rejects(
    rejected.getPositions3D(2, { showProgress: false }),
    /2D position.*working set.*browser limit.*Cellucid server/i
  );
  assert.equal(
    coordinateReads,
    0,
    'the raw 16-byte input must reject before reading or allocating its 24-byte padded output'
  );

  const exact = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: 40
  });
  exact.loadDimension = async () => new Float32Array([0, 0, 1, 1]);
  assert.equal(
    (await exact.getPositions3D(2, { showProgress: false })).byteLength,
    24,
    'raw plus padded bytes equal to the configured limit must remain valid'
  );

  const shared3D = new Float32Array([0, 0, 0, 1, 1, 1]);
  const noCopy = new DimensionManager({
    embeddingsMetadata: metadata,
    maxPositionBytes: shared3D.byteLength
  });
  noCopy.positionCache.set(3, shared3D);
  noCopy.loadDimension = async () => shared3D;
  assert.strictEqual(
    await noCopy.getPositions3D(3, { showProgress: false }),
    shared3D,
    'in-place 3D normalization must count its shared raw/output buffer once'
  );

  const copied3D = new DimensionManager({
    embeddingsMetadata: metadata,
    keepRawPositions: true,
    maxPositionBytes: shared3D.byteLength * 2
  });
  copied3D.positionCache.set(3, shared3D);
  copied3D.loadDimension = async () => shared3D;
  assert.notStrictEqual(
    await copied3D.getPositions3D(3, { showProgress: false }),
    shared3D,
    'keepRawPositions must reserve the exact additional 3D copy'
  );

  const rejectedCopy = new DimensionManager({
    embeddingsMetadata: metadata,
    keepRawPositions: true,
    maxPositionBytes: shared3D.byteLength * 2 - 1
  });
  rejectedCopy.positionCache.set(3, shared3D);
  rejectedCopy.loadDimension = async () => shared3D;
  await assert.rejects(
    rejectedCopy.getPositions3D(3, { showProgress: false }),
    /3D position.*working set.*browser limit.*Cellucid server/i
  );
});

test('position padding evicts stale dimension buffers before exceeding the cumulative bound', async () => {
  const manager = new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [1, 2],
      default_dimension: 2,
      files: {
        '1d': 'points_1d.bin',
        '2d': 'points_2d.bin'
      }
    },
    maxPositionBytes: 40
  });
  const rawByDimension = new Map([
    [1, new Float32Array([0, 1])],
    [2, new Float32Array([0, 0, 1, 1])]
  ]);
  manager.loadDimension = async dim => rawByDimension.get(dim);

  await manager.getPositions3D(1, { showProgress: false });
  assert.deepEqual([...manager.paddedPositionCache.keys()], [1]);

  await manager.getPositions3D(2, { showProgress: false });
  assert.deepEqual(
    [...manager.paddedPositionCache.keys()],
    [2],
    'the stale 24-byte 1D cache must be evicted before the 16+24-byte 2D peak'
  );
  assert.ok(
    [...manager.paddedPositionCache.values()]
      .reduce((bytes, positions) => bytes + positions.byteLength, 0) <= 40
  );

  const protectedManager = new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [1, 2],
      default_dimension: 2,
      files: {
        '1d': 'points_1d.bin',
        '2d': 'points_2d.bin'
      }
    },
    maxPositionBytes: 40
  });
  protectedManager.loadDimension = async dim => rawByDimension.get(dim);
  await protectedManager.getPositions3D(1, { showProgress: false });
  protectedManager.setViewDimension('snapshot', 1);
  await assert.rejects(
    protectedManager.getPositions3D(2, { showProgress: false }),
    /2D position.*working set.*browser limit.*Cellucid server/i
  );
  assert.deepEqual(
    [...protectedManager.paddedPositionCache.keys()],
    [1],
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
      'https://cellucid.test/data/points_2d.bin.gz',
      { showProgress: true }
    ),
    /byte length|multiple of 4|Float32Array/i
  );
  assert.deepEqual(
    events.filter(event => ['start', 'complete', 'fail', 'dismiss'].includes(event.kind))
      .map(event => event.kind),
    ['start', 'fail']
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
      'https://cellucid.test/data/points_2d.bin.gz',
      { showProgress: false }
    ),
    /gzip payload.*requires browser DecompressionStream support/i
  );
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
      progressSource.indexOf('resolveAnyUrl(url, signal)')
  );
  assert.equal(
    progressSource.match(/new GzipDecompressionStream\('gzip'\)/g)
      ?.length,
    2
  );
  assert.match(
    localUserSource,
    /requirePreparedGzipDecompressionStream\(filename, this\.type\)/
  );
});

test('3D position padding owns one outer progress transaction', async t => {
  const createManager = () => new DimensionManager({
    embeddingsMetadata: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points.bin' }
    }
  });

  const silentManager = createManager();
  const silentOptions = [];
  silentManager.loadDimension = async (dim, options) => {
    silentOptions.push({ dim, options });
    return new Float32Array([0, 0, 1, 1]);
  };
  await silentManager.getPositions3D(2, { showProgress: false });
  assert.equal(silentOptions[0].dim, 2);
  assert.equal(silentOptions[0].options.showProgress, false);
  assert.equal(silentOptions[0].options.progressTrackerId, null);

  const events = captureDownloadNotifications(t);
  const directManager = createManager();
  const directOptions = [];
  directManager.loadDimension = async (dim, options) => {
    directOptions.push({ dim, options });
    return new Float32Array([0, 0, 1, 1]);
  };
  await directManager.getPositions3D(2);
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

test('in-place reload stages silently and publishes through one synchronous commit', async () => {
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
  assert.match(
    reloadSource,
    /await stageDatasetRuntime\(\{\s*baseUrl,\s*expectedIdentityId,\s*showProgress:\s*false,\s*signal:\s*reloadTransaction\.signal\s*\}\)/
  );
  assert.equal(
    reloadSource.match(/commitDatasetRuntimeStage\(/g)?.length,
    1
  );
  const stagingCatch = reloadSource.indexOf('} catch (err) {');
  const analysisResetIndex = reloadSource.indexOf(
    'window._comparisonModule.resetForDatasetReload({'
  );
  const commitIndex = reloadSource.indexOf(
    'commitDatasetRuntimeStage(stage)'
  );
  const resourceReplacementIndex = reloadSource.indexOf(
    'connectivityRuntimeOwner.prepareDatasetReplacement()'
  );
  const successIndex = reloadSource.indexOf(
    'completeDataLoadSuccess(loadToken'
  );
  const uiSyncIndex = reloadSource.indexOf(
    'const synchronizationOutcome = synchronizePublishedDatasetUi('
  );
  assert.ok(
    analysisResetIndex >= 0 &&
    analysisResetIndex < stagingCatch &&
    resourceReplacementIndex > stagingCatch &&
    resourceReplacementIndex < commitIndex &&
    commitIndex > stagingCatch &&
    uiSyncIndex > commitIndex &&
    successIndex > uiSyncIndex
  );
  const uiSyncFunctionStart = mainSource.indexOf(
    'function synchronizePublishedDatasetUi'
  );
  const initialSelectionStart = mainSource.indexOf(
    'const hasInitialDataset =',
    uiSyncFunctionStart
  );
  assert.ok(
    uiSyncFunctionStart >= 0 &&
    initialSelectionStart > uiSyncFunctionStart
  );
  assert.doesNotMatch(
    mainSource.slice(uiSyncFunctionStart, initialSelectionStart),
    /resetForDatasetReload/
  );
  assert.doesNotMatch(
    reloadSource,
    /state\.(?:setDimensionManager|setFieldLoader|setVarFieldLoader|initVarData|initScene|setVectorFieldManager)/
  );
  assert.doesNotMatch(
    reloadSource,
    /notifications\.(?:complete|error|fail|success)|showSessionStatus/
  );
});

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
    'const hasInitialDataset =',
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
  assert.match(
    connectivitySource,
    /loadEdges\(\s*getConnectivityManifestUrl\(owner\.exportBaseUrl\),\s*owner\.manifest,\s*\{ signal: owner\.controller\.signal \}/s
  );
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
  assert.match(
    connectivitySource,
    /sources: edgeData\.sources\.slice\(\)/
  );
  assert.match(
    connectivitySource,
    /destinations: edgeData\.destinations\.slice\(\)/
  );
  assert.match(
    connectivitySource,
    /weights: edgeData\.weights\.slice\(\)/
  );
  assert.match(
    connectivitySource,
    /shuffleEdges\(\s*renderEdgeData\.sources,\s*renderEdgeData\.destinations,\s*renderEdgeData\.weights\s*\)/s
  );
  assert.match(connectivitySource, /loadedEdgeData = edgeData/);
  assert.doesNotMatch(
    connectivitySource,
    /shuffleEdges\(edgeData\.sources,\s*edgeData\.destinations\)/s
  );
  assert.doesNotMatch(connectivitySource, /ratio-based approximation/i);
  assert.match(
    connectivitySource,
    /const combinedVisibilityBuffers = new Map\(\)/
  );
  assert.match(
    connectivitySource,
    /viewer\.getViewTransparency\(viewId\)/
  );
  assert.match(
    connectivitySource,
    /viewer\.getViewDimension\(snapshot\.id\)/
  );
  assert.match(
    connectivitySource,
    /getCombinedVisibility\(\s*'live',\s*viewer\.getViewDimension\('live'\)\s*\)/s
  );
  assert.doesNotMatch(
    connectivitySource,
    /getCombinedVisibility\(\s*\)/
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
  assert.match(failedPublicationCleanupSource, /visibleEdgePrefixSum = null/);
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

test('local dataset connection publishes exactly one truthful terminal outcome', async t => {
  await t.test('auto-switch failure completes with the validated source retained', async t => {
    const result = await runLocalSelection(t, {
      switchDataset: async () => {
        throw new Error('synthetic switch failure');
      },
      reloadDataset: async () => {
        assert.fail('reload must not run after a failed switch');
      }
    });

    const terminal = result.notificationEvents.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.deepEqual(
      terminal.map(event => event.kind),
      ['complete']
    );
    assert.deepEqual(
      {
        historyReplacements: result.browserState.historyReplacements,
        instructionIsTruthful:
          /validated.*"Sample datasets".*apply/i.test(terminal[0].message),
        locationHref: globalThis.window.location.href,
        populateCalls: result.populateCalls
      },
      {
        historyReplacements: [],
        instructionIsTruthful: true,
        locationHref: result.browserState.initialHref,
        populateCalls: 1
      }
    );
  });

  await t.test('post-switch reload failure publishes failure only', async t => {
    const result = await runLocalSelection(t, {
      switchDataset: async () => {},
      reloadDataset: async () => {
        throw new Error('synthetic required reload failure');
      }
    });

    const terminal = result.notificationEvents.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.deepEqual(
      terminal.map(event => event.kind),
      ['fail']
    );
    assert.match(terminal[0].message, /required reload failure/i);
    assert.equal(result.populateCalls, 0);
  });

  await t.test('superseded reload dismisses without a failed terminal outcome', async t => {
    const { createDatasetReloadSupersededError } =
      await import(outcomeModuleUrl);
    const result = await runLocalSelection(t, {
      switchDataset: async () => {},
      reloadDataset: async () => {
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
    assert.equal(result.populateCalls, 0);
  });

  await t.test('successful switch and reload complete as ready', async t => {
    const result = await runLocalSelection(t, {
      switchDataset: async () => {},
      reloadDataset: async metadata => {
        assert.equal(metadata.name, 'Local data');
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
    assert.equal(result.browserState.historyReplacements.length, 1);
    assert.equal(globalThis.window.location.search, '');

    const connectionSource = await readFile(
      new URL(
        '../assets/js/app/ui/modules/dataset-connections.js',
        import.meta.url
      ),
      'utf8'
    );
    const localSelectionStart = connectionSource.indexOf(
      'async function loadLocalUserSelection'
    );
    const localSelectionEnd = connectionSource.indexOf(
      '// ---------------------------------------------------------------------------',
      localSelectionStart
    );
    assert.ok(
      localSelectionStart >= 0 && localSelectionEnd > localSelectionStart
    );
    const localSelectionSource = connectionSource.slice(
      localSelectionStart,
      localSelectionEnd
    );
    assert.match(
      localSelectionSource,
      /updateUrlForDataSource\('local-user', \{\}\)/
    );
    assert.doesNotMatch(localSelectionSource, /clearUrlDataSource\(\)/);
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

  initDatasetConnections({
    state: {},
    viewer: {},
    dom: { userDataZarrArchiveInput: input },
    dataSourceManager: {
      getSource: type => type === 'local-user'
        ? {
            async loadFromZarrArchive() {
              throw validationError;
            },
          }
        : null,
    },
    noneDatasetValue: '__none__',
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
});

test('connection analytics expose only exact current load methods', () => {
  assert.equal(
    DATA_LOAD_METHODS.LOCAL_ZARR_DIRECTORY,
    'local-user-zarr-directory'
  );
  assert.equal(
    DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
    'local-user-zarr-zip'
  );
  assert.deepEqual(
    Object.keys(DATA_LOAD_METHODS)
      .filter(key => key.startsWith('LOCAL_ZARR')),
    ['LOCAL_ZARR_DIRECTORY', 'LOCAL_ZARR_ZIP']
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
      disconnectedMessage: 'Disconnected',
      fieldKey: 'remoteServerUrl',
      initialHref:
        'https://cellucid.test/?remote=https%3A%2F%2Fserver.test%2F',
      sourceType: 'remote',
    },
    {
      connectButtonKey: 'githubConnectBtn',
      disconnectButtonKey: 'githubDisconnectBtn',
      disconnectContainerKey: 'githubDisconnectContainer',
      disconnectedMessage: 'Disconnected from GitHub',
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
      const disconnectContainer = { style: {} };
      const field = { disabled: false, value: '' };
      const dom = {
        [connection.connectButtonKey]: connectButton,
        [connection.disconnectButtonKey]: disconnectButton,
        [connection.disconnectContainerKey]: disconnectContainer,
        [connection.fieldKey]: field,
      };
      let disconnectCalls = 0;
      let populateCalls = 0;
      let reloadCalls = 0;
      let switchCalls = 0;
      const sourceLookups = [];
      const connectionSource = {
        disconnect() {
          disconnectCalls++;
        },
        getConnectionInfo() {
          return connection.sourceType === 'remote'
            ? { connected: true, url: 'https://server.test/' }
            : { connected: true };
        },
        isConnected() {
          return true;
        },
      };

      initDatasetConnections({
        state: {},
        viewer: {},
        dom,
        dataSourceManager: {
          getCurrentSourceType: () => connection.sourceType,
          getSource(type) {
            sourceLookups.push(type);
            if (type === connection.sourceType) return connectionSource;
            if (type === 'local-demo') {
              return {
                async getDefaultDatasetId() {
                  return 'demo-that-must-not-be-selected';
                },
              };
            }
            return null;
          },
          async switchToDataset() {
            switchCalls++;
          },
          getCurrentMetadata() {
            return { id: 'demo-that-must-not-be-selected' };
          },
        },
        async reloadDataset() {
          reloadCalls++;
        },
        populateDatasetDropdown() {
          populateCalls++;
        },
        noneDatasetValue: '__none__',
      });

      await disconnectButton.activate();

      assert.equal(disconnectCalls, 1);
      assert.equal(connectButton.textContent, 'Connect');
      assert.equal(disconnectContainer.style.display, 'none');
      assert.equal(field.disabled, false);
      assert.deepEqual(sourceLookups, [connection.sourceType]);
      assert.equal(switchCalls, 0);
      assert.equal(reloadCalls, 0);
      assert.equal(populateCalls, 0);
      assert.deepEqual(
        notificationEvents.filter(event => event.kind === 'success'),
        [{
          kind: 'success',
          message: connection.disconnectedMessage,
        }]
      );
      assert.equal(browserState.historyReplacements.length, 1);
      assert.equal(globalThis.window.location.search, '');
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
  let reloadMetadata = null;
  let switchArguments = null;
  const metadata = {
    id: 'portable',
    name: 'portable.zarr',
    stats: { n_cells: 3 }
  };
  const userSource = {
    datasetId: 'portable',
    async loadFromZarrArchive(file) {
      selectedFiles = [file];
      return metadata;
    }
  };

  initDatasetConnections({
    state: {},
    viewer: {},
    dom: {
      userDataZarrArchiveBtn: button,
      userDataZarrArchiveInput: input
    },
    dataSourceManager: {
      getSource: type => type === 'local-user' ? userSource : null,
      async switchToDataset(...args) {
        switchArguments = args;
      }
    },
    async reloadDataset(value) {
      reloadMetadata = value;
    },
    noneDatasetValue: '__none__'
  });

  button.activate();
  assert.equal(input.pickerClicks, 1);
  await input.select([archive]);

  assert.deepEqual(selectedFiles, [archive]);
  assert.deepEqual(switchArguments, [
    'local-user',
    'portable',
    { loadMethod: 'local-user-zarr-zip' }
  ]);
  assert.equal(reloadMetadata, metadata);
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
  const switches = [];
  const userSource = {
    datasetId: null,
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
    async loadFromZarrDirectory(files) {
      calls.push(['zarr-directory', files]);
      this.datasetId = 'zarr-directory';
      return {
        id: this.datasetId,
        name: 'Zarr directory',
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

  initDatasetConnections({
    state: {},
    viewer: {},
    dom: {
      userDataFileInput: preparedInput,
      userDataH5adInput: h5adInput,
      userDataZarrInput: zarrInput,
      userDataZarrArchiveInput: archiveInput,
    },
    dataSourceManager: {
      getSource: type => type === 'local-user' ? userSource : null,
      async switchToDataset(...args) {
        switches.push(args);
      },
    },
    reloadDataset: async () => {},
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
    switches.map(([, datasetId, options]) => [
      datasetId,
      options.loadMethod,
    ]),
    [
      ['prepared', 'local-user-prepared'],
      ['h5ad', 'local-user-h5ad'],
      ['zarr-archive', 'local-user-zarr-zip'],
    ]
  );
});
