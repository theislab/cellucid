/**
 * The Sample dataset list (`LocalDemoDataSource`): the AnnData dataset
 * catalog the page names, listed from each file's metadata and opened when
 * chosen; and what a rejected catalog leaves usable.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { getOpeningProgress } from '../assets/js/data/opening-progress.js';
import { initRepresentationControls } from '../assets/js/app/ui/modules/representation-controls.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';
import { createOpenMenuDom } from './helpers/open-menu-dom.mjs';
import { createTestDatasetIntents } from './helpers/dataset-intents.mjs';
import {
  DATA_CONFIG,
} from '../assets/js/data/data-source.js';
import {
  DataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import { LocalDemoDataSource } from '../assets/js/data/local-demo-source.js';
import { serveFixtureHost } from './helpers/fixture-web-host.mjs';

const BASE = 'https://catalog.cellucid.test/anndata/';
const FIXTURES = new URL('./fixtures/cellucid-ready/', import.meta.url);
const SESSION_SHA = 'b'.repeat(64);

function quiet(t) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    console.log = log;
    console.warn = warn;
  });
}

function serveCatalog(t, catalog) {
  return serveFixtureHost(t, {
    prefix: BASE,
    root: FIXTURES,
    files: new Map([['datasets.json', JSON.stringify(catalog)]]),
  });
}

const CATALOG = Object.freeze({
  schema: 2,
  default: 'tiny-ready',
  datasets: [
    {
      id: 'tiny-ready',
      path: 'ready.zarr/',
      session: { path: 'tiny-ready.cellucid-session', bytes: 7, sha256: SESSION_SHA },
    },
  ],
});

test('an unconfigured page has no sample list, and a misconfigured one says how to configure it', async () => {
  const unconfigured = new LocalDemoDataSource(null, null);
  assert.equal(await unconfigured.isAvailable(), false);
  const misconfigured = new LocalDemoDataSource(null, new Error('Sample dataset configuration: exactly one meta'));
  await assert.rejects(misconfigured.isAvailable(), /exactly one meta/);
  assert.throws(() => new LocalDemoDataSource('https://x.test/no-slash'), /folder URL/);
});

test('the sample list names each dataset from its own file, reading its metadata only', async t => {
  quiet(t);
  const host = serveCatalog(t, CATALOG);
  const source = new LocalDemoDataSource(BASE, null);
  assert.equal(await source.isAvailable(), true);
  assert.equal(await source.getDefaultDatasetId(), 'tiny-ready');
  assert.equal(await source.hasDataset('tiny-ready'), true);
  assert.equal(await source.hasDataset('other'), false);
  const [first, second] = await Promise.all([source.listDatasets(), source.listDatasets()]);
  assert.strictEqual(first, second, 'concurrent listings share one generation');
  assert.deepEqual(first, [{
    id: 'tiny-ready',
    name: 'Tiny ready dataset',
    description: 'Six cells written for the Cellucid web contract tests.',
    stats: { n_cells: 6, n_genes: 3 },
  }]);
  assert.equal(host.requests.filter(request => request.url.endsWith('/datasets.json')).length, 1);
  // Metadata documents only: no chunk of a matrix, an obs column or an
  // embedding (a `.zarray`/`.zattrs`/`.zgroup`/`zarr.json` describes one).
  assert.deepEqual(
    host.requests
      .map(request => request.url)
      .filter(url => /ready\.zarr\/(X|layers|obs|obsm|obsp|var|varm|varp)\//.test(url))
      .filter(url => !/\/(\.zarray|\.zattrs|\.zgroup|zarr\.json)$/.test(url)),
    [],
    'listing reads no data'
  );
  assert.equal(source.getStateDescriptor('tiny-ready').sessionUrl, `${BASE}tiny-ready.cellucid-session`);
});

test('choosing a sample opens its file once; its default view and AnnData source follow', async t => {
  quiet(t);
  serveCatalog(t, CATALOG);
  const source = new LocalDemoDataSource(BASE, null);
  assert.throws(() => source.getBaseUrl('tiny-ready'), /is not open/);
  const metadata = await source.getMetadata('tiny-ready');
  assert.equal(metadata.id, 'tiny-ready');
  assert.equal(metadata.source.name, 'Example lab', 'the file names its source');
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
  assert.equal(source.datasetId, 'tiny-ready');
  const annData = source.getAnnDataSource('tiny-ready');
  assert.equal(annData.getType(), 'anndata');
  assert.equal(annData.format, 'zarr');
  assert.strictEqual(await source.getMetadata('tiny-ready'), metadata, 'opened once');
  assert.deepEqual(source.getStateDescriptor('tiny-ready'), {
    sessionUrl: `${BASE}tiny-ready.cellucid-session`,
    sessionBytes: 7,
    sessionSha256: SESSION_SHA,
  });
  await assert.rejects(source.getMetadata('missing'), /not found/);
  source.onDeactivate();
  assert.equal(source.getAnnDataSource('tiny-ready'), null, 'another source shown releases it');
});

test('a refresh reads the catalog again while the dataset shown stays readable', async t => {
  quiet(t);
  const host = serveCatalog(t, CATALOG);
  const source = new LocalDemoDataSource(BASE, null);
  await source.getMetadata('tiny-ready');
  const shown = source.getAnnDataSource('tiny-ready');
  source.refresh();
  assert.strictEqual(source.getAnnDataSource('tiny-ready'), shown);
  await source.listDatasets();
  assert.equal(host.requests.filter(request => request.url.endsWith('/datasets.json')).length, 2);
  source.releaseExcept('tiny-ready');
  assert.strictEqual(source.getAnnDataSource('tiny-ready'), shown, 'the shown dataset is kept');
  source.releaseExcept(null);
  assert.equal(source.getAnnDataSource('tiny-ready'), null);
});

test('a listing failure names its dataset and is kept until a refresh', async t => {
  quiet(t);
  const host = serveCatalog(t, { schema: 2, default: 'tiny-ready', datasets: [{ id: 'tiny-ready', path: 'missing.h5ad' }] });
  const source = new LocalDemoDataSource(BASE, null);
  const error = await source.listDatasets().catch(failure => failure);
  assert.match(error.message, /Dataset 'tiny-ready' \(missing\.h5ad\) cannot be listed/);
  assert.strictEqual(await source.listDatasets().catch(failure => failure), error);
  const before = host.requests.length;
  source.refresh();
  await source.listDatasets().catch(() => {});
  assert.ok(host.requests.length > before, 'a refresh tries again');
});

function identity(id, name, cells) {
  return {
    id,
    name,
    description: `${name} description`,
    stats: {
      n_cells: cells,
      n_genes: 2,
      n_obs_fields: 0,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: false,
      n_edges: null,
    },
    embeddings: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: {
          label: 'X_umap',
          dimension: 2,
          path: 'obsm/0/0-1',
          source: { key: 'X_umap', columns: [0, 1] },
        },
      },
    },
    obs_fields: [],
  };
}

test('startup publishes the empty runtime and loads its selection as one dataset change', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const emptyStart = mainSource.indexOf(
    '// Startup publishes the empty runtime'
  );
  const emptyEnd = mainSource.indexOf(
    '// Stage one exact manager/source/runtime/URL generation',
    emptyStart
  );
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart);
  const emptyBootstrap = mainSource.slice(emptyStart, emptyEnd);
  // No startup path of its own: the empty runtime is published whatever
  // startup selected, and nothing here stages or publishes a dataset.
  assert.match(
    emptyBootstrap,
    /publishEmptyDatasetRuntime\(\);/
  );
  assert.doesNotMatch(
    emptyBootstrap,
    /stageDatasetRuntime|commitDatasetRuntimeStage|hasInitialDataset|initialPublication/
  );
  assert.doesNotMatch(
    emptyBootstrap,
    /Promise\.resolve\(new Float32Array\(0\)\)|state\.initScene\(/
  );

  // The reload owns the startup load: its progress is shown, its steps are
  // deadline-bound startup steps, and its failure is logged once, by the
  // terminal startup failure it becomes.
  const reloadStart = mainSource.indexOf(
    'async function reloadActiveDatasetInPlace'
  );
  const reloadEnd = mainSource.indexOf(
    'async function clearActiveDatasetInPlace',
    reloadStart
  );
  const reloadSource = mainSource.slice(reloadStart, reloadEnd);
  assert.match(
    reloadSource,
    /const stagePhases = isStartupLoad \? startup : RELOAD_STAGE_PHASES;/
  );
  assert.match(
    reloadSource,
    /if \(!isStartupLoad\) \{\s*console\.error\(\s*'\[Main\] Failed to reload dataset in-place:'/
  );
  assert.doesNotMatch(mainSource, /initialDataLoad/);

  // The startup selection loads only after every control and the render
  // loop exist, and before startup is published ready.
  const admission = mainSource.indexOf('admitDeferredControls();');
  const viewerStart = mainSource.indexOf('viewer.start();', admission);
  const startupLoad = mainSource.indexOf(
    'startupOutcome = await ui.loadStartupDataset(startupSelection);',
    viewerStart
  );
  const ready = mainSource.indexOf("startup.enter('ready');", startupLoad);
  assert.ok(
    admission > 0 &&
    viewerStart > admission &&
    startupLoad > viewerStart &&
    ready > startupLoad
  );
});

test('single-representation adoption publishes the exact picker option', t => {
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLSelectElement = globalThis.HTMLSelectElement;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalHTMLSelectElement === undefined) {
      delete globalThis.HTMLSelectElement;
    } else {
      globalThis.HTMLSelectElement = originalHTMLSelectElement;
    }
  });

  class FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLSelectElement = FakeHTMLSelectElement;

  const ownerDocument = {
    createElement(tagName) {
      assert.ok(tagName === 'option' || tagName === 'optgroup', tagName);
      return {
        tagName,
        label: '',
        title: '',
        value: '',
        textContent: '',
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
  };
  globalThis.document = ownerDocument;
  const select = Object.assign(new FakeHTMLSelectElement(), {
    groups: [],
    value: '',
    title: '',
    disabled: false,
    ownerDocument,
    addEventListener() {},
    replaceChildren(...groups) {
      this.groups = groups;
    },
  });
  const label = Object.assign(new FakeHTMLElement(), { textContent: '' });
  const controls = Object.assign(new FakeHTMLElement(), {
    ownerDocument,
    hidden: false,
  });

  let representations = [];
  let liveLayoutKey = null;
  const state = {
    getActiveViewId() {
      return 'live';
    },
    getEnabledRepresentations() {
      return representations;
    },
    getViewLayoutKey() {
      if (liveLayoutKey === null) {
        throw new RangeError('Layout state is not published for view "live".');
      }
      return liveLayoutKey;
    },
    on() {
      return () => {};
    },
    async setViewRepresentation() {},
    async cycleRepresentation() {},
  };
  const picker = initRepresentationControls({
    state,
    dom: { controls, label, select },
    callbacks: {
      viewLabel: () => null,
      onViewBadgesMaybeChanged() {},
    },
  });

  // No dataset: no representation, nothing to pick, the block hidden.
  assert.deepEqual(select.groups, []);
  assert.equal(controls.hidden, true);

  representations = [Object.freeze({
    layoutKey: 'X_umap',
    dimension: 2,
    name: 'UMAP',
    label: 'UMAP',
    ref: { key: 'X_umap', columns: null },
    isDefault: true,
  })];
  liveLayoutKey = 'X_umap';
  picker.render();

  assert.equal(controls.hidden, false);
  assert.equal(label.textContent, 'Shows');
  assert.deepEqual(
    select.groups.map(group => ({
      label: group.label,
      options: group.children.map(option => ({
        value: option.value,
        text: option.textContent,
      })),
    })),
    [{ label: '2D', options: [{ value: 'X_umap', text: 'UMAP · 2D' }] }]
  );
  assert.equal(select.value, 'X_umap');
  // One representation names what the view shows; there is nothing to switch
  // to, and the picker says where more come from.
  assert.equal(select.disabled, true);
  assert.match(select.title, /one embedding.*Data mapping/i);
  picker.destroy();
});

test(
  'a rejected sample catalog leaves explicit H5AD, Zarr ZIP, Zarr folder, and server loaders usable',
  async t => {
    const originalCatalogUrl = DATA_CONFIG.SAMPLE_CATALOG_URL;
    const originalFetch = globalThis.fetch;
    const originalDocument = globalThis.document;
    const originalHistory = globalThis.history;
    const originalWindow = globalThis.window;
    const notifications = getNotificationCenter();
    const originalNotifications = {
      complete: notifications.complete,
      dismiss: notifications.dismiss,
      fail: notifications.fail,
      loading: notifications.loading,
    };
    t.after(() => {
      DATA_CONFIG.SAMPLE_CATALOG_URL = originalCatalogUrl;
      globalThis.fetch = originalFetch;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalHistory === undefined) delete globalThis.history;
      else globalThis.history = originalHistory;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
      Object.assign(notifications, originalNotifications);
    });

    DATA_CONFIG.SAMPLE_CATALOG_URL =
      'https://catalog.cellucid.test/anndata/';
    globalThis.window = {
      addEventListener() {},
      location: {
        href: 'https://catalog.cellucid.test/index.html',
        origin: 'https://catalog.cellucid.test',
        search: '',
      },
    };
    // A catalog that does not state its schema: refused as a whole.
    let invalidIdentityRequests = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      if (url === 'https://catalog.cellucid.test/anndata/datasets.json') {
        invalidIdentityRequests++;
        return new Response(JSON.stringify({
          default: 'rejected',
          datasets: [{ id: 'rejected', path: 'rejected.h5ad' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    };

    const failingCatalogManager = new DataSourceManager();
    await failingCatalogManager.initialize();
    assert.equal(invalidIdentityRequests, 0, 'registering the source reads nothing');
    const firstPass = await failingCatalogManager.getAllDatasets();
    const firstDemoFailure = firstPass.find(
      entry => entry.sourceType === 'local-demo'
    );
    assert.match(
      firstDemoFailure.error.message,
      /datasets\.json.*\(missing: schema\)/i
    );
    assert.deepEqual(firstDemoFailure.datasets, []);
    assert.equal(invalidIdentityRequests, 1);
    const secondPass = await failingCatalogManager.getAllDatasets();
    assert.equal(
      secondPass.find(entry => entry.sourceType === 'local-demo').error,
      firstDemoFailure.error,
      'the rejected catalog must be republished from cache, never re-fetched'
    );
    assert.equal(invalidIdentityRequests, 1);
    assert.equal(failingCatalogManager.hasActiveDataset(), false);

    const localMetadata = identity('local-user', 'Local H5AD', 2);
    const zarrMetadata = identity(
      'local-user',
      'Local Zarr ZIP',
      3
    );
    const folderMetadata = identity(
      'local-user',
      'Local Zarr folder',
      4
    );
    const localCandidates = [];

    function createLocalCandidate() {
      let activeMetadata = null;
      const candidate = {
        datasetId: 'local-user',
        disconnectCalls: 0,
        createSelectionCandidate: createLocalCandidate,
        disconnect() {
          this.disconnectCalls++;
        },
        getBaseUrl(datasetId) {
          assert.equal(datasetId, 'local-user');
          return 'anndata://local-user/';
        },
        async getMetadata(datasetId) {
          assert.equal(datasetId, 'local-user');
          assert.ok(activeMetadata);
          return activeMetadata;
        },
        getType() {
          return 'local-user';
        },
        async isAvailable() {
          return false;
        },
        async listDatasets() {
          return [];
        },
        async loadFromFile(file) {
          assert.ok(['working.h5ad', 'working.zarr.zip'].includes(file?.name));
          activeMetadata = file.name === 'working.h5ad' ? localMetadata : zarrMetadata;
          return activeMetadata;
        },
        async loadFromFolder(files) {
          assert.deepEqual(
            Array.from(files, file => file.webkitRelativePath),
            ['working.zarr/.zgroup', 'working.zarr/.zmetadata']
          );
          activeMetadata = folderMetadata;
          return activeMetadata;
        },
      };
      localCandidates.push(candidate);
      return candidate;
    }

    const manager = new DataSourceManager();
    const localSource = createLocalCandidate();
    manager.registerSource('local-user', localSource);
    await manager.initialize();
    assert.equal(manager.hasActiveDataset(), false);

    // A rejected sample catalog is that catalog's failure. Enumerating sources
    // still succeeds, so every explicit local loader below stays reachable.
    const catalogPass = await manager.getAllDatasets();
    const rejectedEntry = catalogPass.find(
      entry => entry.sourceType === 'local-demo'
    );
    assert.match(
      rejectedEntry.error.message,
      /datasets\.json.*\(missing: schema\)/i
    );
    const rejectedCatalogError = rejectedEntry.error;
    assert.equal(
      catalogPass.some(entry => entry.sourceType === 'local-user'),
      false,
      'an unavailable local source stays omitted rather than reported failed'
    );
    const requestsAfterCatalogRejection = invalidIdentityRequests;
    assert.equal(
      (await manager.getAllDatasets()).find(
        entry => entry.sourceType === 'local-demo'
      ).error,
      rejectedCatalogError
    );
    assert.equal(manager.hasActiveDataset(), false);
    assert.equal(manager.getCurrentDatasetId(), null);
    assert.equal(manager.getCurrentSourceType(), null);
    assert.ok(manager.getSource('local-demo'));
    assert.ok(manager.getSource('link'));
    assert.equal(manager.getSource('local-user'), localSource);
    assert.equal(
      invalidIdentityRequests,
      requestsAfterCatalogRejection,
      'the rejected configured sample must not be retried and republished'
    );

    const createButton = () => {
      const listeners = new Map();
      return {
        disabled: false,
        listeners,
        textContent: '',
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
      };
    };
    const createInput = (value = '') => {
      const listeners = new Map();
      return {
        disabled: false,
        listeners,
        value,
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        click() {},
      };
    };
    const select = {
      disabled: true,
      focusCalls: 0,
      focus() {
        this.focusCalls++;
      },
    };
    const fileInput = createInput();
    const folderInput = createInput();
    globalThis.document = { addEventListener() {} };
    globalThis.window = {
      addEventListener() {},
      innerHeight: 800,
      location: {
        href: 'https://cellucid.test/?dataset=rejected',
        search: '?dataset=rejected',
      },
    };
    const notificationEvents = [];
    // How each opening ended, as the opening progress publishes it.
    const openingOutcomes = [];
    const stopOutcomes = getOpeningProgress().subscribe(snapshot => {
      if (snapshot !== null && snapshot.state !== 'running' && openingOutcomes.at(-1)?.id !== snapshot.id) {
        openingOutcomes.push({ id: snapshot.id, state: snapshot.state });
      }
    });
    t.after(stopOutcomes);
    notifications.loading = message => {
      const id = `dataset-load-${notificationEvents.length}`;
      notificationEvents.push(['loading', id, message]);
      return id;
    };
    notifications.complete = (id, message) => {
      notificationEvents.push(['complete', id, message]);
    };
    notifications.dismiss = id => {
      notificationEvents.push(['dismiss', id]);
    };
    notifications.fail = (id, message) => {
      notificationEvents.push(['fail', id, message]);
    };

    const activatedMetadata = [];
    const activateDataset = async (
      datasetId,
      sourceType,
      loadMethod,
      source
    ) => {
      const stage = await manager.stageDatasetSelection(
        sourceType,
        datasetId,
        { loadMethod, source }
      );
      const publication = manager.commitDatasetSelection(stage);
      manager.publishDatasetSelection(publication);
      manager.finalizeDatasetSelection(publication);
      activatedMetadata.push(stage.metadata);
      return true;
    };
    const failedCatalogOutcome = async () => Object.freeze({
      error: rejectedCatalogError,
      status: 'failed',
    });

    const datasetIntents = createTestDatasetIntents(activateDataset);

    initDatasetConnections({
      datasetIntents,
      clearDataset: async () => true,
      dataSourceManager: manager,
      dom: {
        select,
        ...createOpenMenuDom({ fileInput, folderInput }),
      },
      noneDatasetValue: '__none__',
      populateDatasetDropdown: failedCatalogOutcome,
    });

    await fileInput.listeners.get('change')({
      target: {
        files: [{ name: 'working.h5ad' }],
      },
    });
    await fileInput.listeners.get('change')({
      target: {
        files: [{ name: 'working.zarr.zip' }],
      },
    });
    await folderInput.listeners.get('change')({
      target: {
        files: [
          { name: '.zgroup', webkitRelativePath: 'working.zarr/.zgroup' },
          { name: '.zmetadata', webkitRelativePath: 'working.zarr/.zmetadata' },
        ],
      },
    });

    assert.equal(fileInput.value, '');
    assert.equal(folderInput.value, '');
    assert.deepEqual(
      activatedMetadata,
      [localMetadata, zarrMetadata, folderMetadata]
    );
    assert.equal(localCandidates.length, 4);
    assert.equal(manager.getCurrentSourceType(), 'local-user');
    assert.equal(manager.getCurrentDatasetId(), 'local-user');
    // Each load is one opening (`data/opening-progress.js`); the rejected
    // catalog cannot be listed after it, so each ends failed.
    assert.deepEqual(openingOutcomes.map(outcome => outcome.state), ['failed', 'failed', 'failed']);

    const remoteMetadata = identity(
      'served',
      'Server AnnData',
      5
    );
    const remoteCandidates = [];
    function createRemoteCandidate() {
      const candidate = {
        connected: false,
        disconnectCalls: 0,
        async connect({ url }) {
          assert.equal(url, 'http://127.0.0.1:8765');
          this.connected = true;
        },
        createConnectionCandidate: createRemoteCandidate,
        disconnect() {
          this.connected = false;
          this.disconnectCalls++;
        },
        getBaseUrl(datasetId) {
          assert.equal(datasetId, 'served');
          return 'anndata://served/';
        },
        getConnectionInfo() {
          return {
            status: this.connected ? 'connected' : 'disconnected',
            url: this.connected ? 'http://127.0.0.1:8765' : null,
          };
        },
        async getMetadata(datasetId) {
          assert.equal(datasetId, 'served');
          return remoteMetadata;
        },
        getType() {
          return 'remote';
        },
        async listDatasets() {
          assert.equal(this.connected, true);
          return [remoteMetadata];
        },
      };
      remoteCandidates.push(candidate);
      return candidate;
    }
    const remoteSource = createRemoteCandidate();
    manager.registerSource('remote', remoteSource);
    const remoteConnectBtn = createButton();
    const remoteDisconnectContainer = { hidden: true };
    initDatasetConnections({
      datasetIntents,
      clearDataset: async () => true,
      dataSourceManager: manager,
      dom: {
        dataAddressInput: createInput('127.0.0.1:8765'),
        dataAddressOpenBtn: remoteConnectBtn,
        remoteDisconnectBtn: createButton(),
        remoteDisconnectContainer,
        remoteConnectionTarget: { textContent: '', title: '' },
        select,
      },
      noneDatasetValue: '__none__',
      populateDatasetDropdown: failedCatalogOutcome,
    });
    await remoteConnectBtn.listeners.get('click')();
    assert.equal(remoteConnectBtn.disabled, false);
    assert.equal(remoteDisconnectContainer.hidden, false);
    assert.equal(manager.getCurrentSourceType(), 'remote');
    assert.equal(manager.getCurrentDatasetId(), 'served');
    assert.equal(activatedMetadata.at(-1), remoteMetadata);
    assert.equal(remoteCandidates.length, 2);
    assert.deepEqual(openingOutcomes.map(outcome => outcome.state), ['failed', 'failed', 'failed', 'failed']);
  }
);
