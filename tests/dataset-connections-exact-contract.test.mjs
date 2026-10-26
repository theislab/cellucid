import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DATA_LOAD_METHODS } from '../assets/js/app/data-load-methods.js';
import {
  createDatasetReloadSupersededError
} from '../assets/js/app/dataset-reload-outcome.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { recordOpenings } from './helpers/opening-events.mjs';
import { prepareUrlForDataSource } from '../assets/js/app/url-state.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';
import { createTestDatasetIntents } from './helpers/dataset-intents.mjs';

function createButton() {
  const listeners = new Map();
  return {
    disabled: false,
    textContent: '',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async activate() {
      return listeners.get('click')?.();
    },
  };
}

function createInput(value = '') {
  const listeners = new Map();
  return {
    clickCalls: 0,
    disabled: false,
    files: [],
    value,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {
      this.clickCalls++;
    },
    async selectFiles(files) {
      this.files = files;
      return listeners.get('change')?.({ target: this });
    },
  };
}

function createConnectionLine() {
  return { hidden: true };
}

function createConnectionTarget() {
  return { textContent: '', title: '' };
}

/** The Session panel's address bar, holding `value`. */
function createAddressBar(value) {
  return {
    dataAddressInput: createInput(value),
    dataAddressOpenBtn: createButton(),
  };
}

const REMOTE_ADDRESS = 'http://localhost:8765';
const LINK_ADDRESS = 'owner/repo/exports';

function createSelect() {
  return {
    disabled: false,
    focusCalls: 0,
    value: '__none__',
    focus() {
      this.focusCalls++;
    },
  };
}

function installBrowser(t) {
  const originals = {
    document: globalThis.document,
    history: globalThis.history,
    window: globalThis.window,
  };
  let href =
    'https://viewer.test/?dataset=prior&annotations=team%2Flabels#view';
  const historyCalls = [];
  const location = {};
  Object.defineProperties(location, {
    href: {
      get() {
        return href;
      },
    },
    search: {
      get() {
        return new URL(href).search;
      },
    },
  });
  const history = {
    replaceState(_state, _title, nextHref) {
      href = String(nextHref);
      historyCalls.push(href);
    },
  };
  globalThis.document = { addEventListener() {} };
  globalThis.history = history;
  globalThis.window = {
    addEventListener() {},
    history,
    location,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return {
    historyCalls,
    get href() {
      return href;
    },
  };
}

function captureNotifications(t) {
  const notifications = getNotificationCenter();
  const originals = {
    complete: notifications.complete,
    dismiss: notifications.dismiss,
    error: notifications.error,
    fail: notifications.fail,
    loading: notifications.loading,
    success: notifications.success,
  };
  const events = [];
  let nextId = 0;
  notifications.loading = message => {
    const id = `connection-${++nextId}`;
    events.push({ id, kind: 'loading', message });
    return id;
  };
  notifications.complete = (id, message) => {
    events.push({ id, kind: 'complete', message });
  };
  notifications.dismiss = id => {
    events.push({ id, kind: 'dismiss' });
  };
  notifications.error = (message, options = {}) => {
    const id = options.id ?? `connection-${++nextId}`;
    events.push({ id, kind: 'error', message });
    return id;
  };
  notifications.fail = (id, message) => {
    events.push({ id, kind: 'fail', message });
  };
  notifications.success = message => {
    events.push({ kind: 'success', message });
  };
  // A connection or a file is shown by the opening progress.
  recordOpenings(t, events);
  t.after(() => Object.assign(notifications, originals));
  return events;
}

function dataset(index) {
  return {
    id: `dataset-${index}`,
    name: `Dataset ${index}`,
    description: '',
    stats: {
      n_cells: index,
      n_genes: 0,
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

function createConnectionSource(type, datasets, connectionValue) {
  const candidate = {
    connected: false,
    disconnectCalls: 0,
    async connect(value) {
      if (type === 'remote') {
        assert.deepEqual(value, { url: connectionValue });
        this.connected = true;
        return { version: '0.9.1' };
      }
      assert.equal(value, connectionValue);
      this.connected = true;
      return {
        repoInfo: {
          owner: 'owner',
          repo: 'repo',
          branch: 'main',
          path: 'exports',
        },
        datasets,
      };
    },
    createConnectionCandidate() {
      throw new Error('A connection candidate cannot create another candidate.');
    },
    disconnect() {
      this.connected = false;
      this.disconnectCalls++;
    },
    getConnectionInfo() {
      return type === 'remote'
        ? {
            status: this.connected ? 'connected' : 'disconnected',
            url: this.connected ? connectionValue : null,
          }
        : {
            connected: this.connected,
            inputPath: this.connected ? connectionValue : null,
          };
    },
    getType() {
      return type;
    },
    isConnected() {
      return this.connected;
    },
    async listDatasets() {
      assert.equal(this.connected, true);
      return datasets;
    },
  };
  const registered = {
    disconnectCalls: 0,
    connect: candidate.connect.bind(candidate),
    createConnectionCandidate() {
      return candidate;
    },
    disconnect() {
      this.disconnectCalls++;
    },
    getConnectionInfo() {
      return type === 'remote'
        ? { status: 'disconnected', url: null }
        : { connected: false, inputPath: null };
    },
    getType() {
      return type;
    },
    isConnected() {
      return false;
    },
    listDatasets: candidate.listDatasets.bind(candidate),
  };
  return { candidate, registered };
}

function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

/**
 * A connection whose recovery could not finish is not opened again: the
 * address bar's Open says to reload instead of starting a connection.
 */
async function assertReopenRefused(harness) {
  const created = harness.factory.creationCount;
  harness.dom.dataAddressInput.value = harness.type === 'remote'
    ? 'http://localhost:9999'
    : 'owner/repo/other';
  await harness.connectButton.activate();
  assert.equal(harness.factory.creationCount, created);
  assert.match(
    harness.notifications.at(-1).message,
    /cannot be opened again until the page is reloaded/
  );
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

function createLifecycleSourceFactory(
  type,
  datasets,
  connectionValue,
  {
    candidateBehaviors = [],
    candidateFactoryError = null,
    priorDisconnectError = null,
  } = {}
) {
  const candidates = [];
  let creationCount = 0;

  function createCandidate() {
    const behavior = candidateBehaviors[creationCount] ?? {};
    creationCount++;
    const candidate = {
      connected: false,
        disconnectCalls: 0,
      async connect(value) {
        if (type === 'remote') {
          assert.deepEqual(value, { url: connectionValue });
        } else {
          assert.equal(value, connectionValue);
        }
        if (behavior.connectError) throw behavior.connectError;
        this.connected = true;
        return type === 'remote'
          ? { version: '0.9.1' }
          : {
              repoInfo: {
                owner: 'owner',
                repo: 'repo',
                branch: 'main',
                path: 'exports',
              },
              datasets,
            };
      },
      createConnectionCandidate() {
        return createCandidate();
      },
      disconnect() {
        this.disconnectCalls++;
        if (behavior.disconnectError) throw behavior.disconnectError;
        this.connected = false;
      },
      getConnectionInfo() {
        return type === 'remote'
          ? {
              status: this.connected ? 'connected' : 'disconnected',
              url: this.connected ? connectionValue : null,
            }
          : {
              connected: this.connected,
              inputPath: this.connected ? connectionValue : null,
            };
      },
      getType() {
        return type;
      },
      isConnected() {
        return this.connected;
      },
      async listDatasets() {
        if (behavior.listError) throw behavior.listError;
        if (behavior.listPromise) return behavior.listPromise;
        return datasets;
      },
    };
    candidates.push(candidate);
    return candidate;
  }

  const registered = {
    connected: false,
    createCandidateCalls: 0,
    disconnectCalls: 0,
    async connect() {
      throw new Error('Registered source cannot be connected in place.');
    },
    createConnectionCandidate() {
      this.createCandidateCalls++;
      if (candidateFactoryError !== null) {
        throw candidateFactoryError;
      }
      return createCandidate();
    },
    disconnect() {
      this.disconnectCalls++;
      if (priorDisconnectError) throw priorDisconnectError;
      this.connected = false;
    },
    getConnectionInfo() {
      return type === 'remote'
        ? { status: 'disconnected', url: null }
        : { connected: false, inputPath: null };
    },
    getType() {
      return type;
    },
    isConnected() {
      return false;
    },
    async listDatasets() {
      throw new Error('Disconnected source has no dataset inventory.');
    },
  };

  return {
    candidates,
    get creationCount() {
      return creationCount;
    },
    registered,
  };
}

function makeLifecycleHarness(
  t,
  type,
  count,
  {
    activationBehavior = null,
    activationMakesActive = false,
    activeSourceType = 'local-demo',
    candidateBehaviors = [],
    candidateFactoryError = null,
    clearResult = true,
    populateResults = [],
    priorDisconnectError = null,
  } = {}
) {
  installBrowser(t);
  const notifications = captureNotifications(t);
  const datasets = Array.from({ length: count }, (_, index) =>
    dataset(index + 1)
  );
  const connectionValue = type === 'remote' ? REMOTE_ADDRESS : LINK_ADDRESS;
  const factory = createLifecycleSourceFactory(
    type,
    datasets,
    connectionValue,
    {
      candidateBehaviors,
      candidateFactoryError,
      priorDisconnectError,
    }
  );
  const sources = new Map([[type, factory.registered]]);
  let currentSourceType = activeSourceType;
  const registrations = [];
  const unregistrations = [];
  const manager = {
    getCurrentSourceType() {
      return currentSourceType;
    },
    getSource(sourceType) {
      return sources.get(sourceType) ?? null;
    },
    registerSource(sourceType, source) {
      if (
        currentSourceType === sourceType &&
        sources.get(sourceType) !== source
      ) {
        throw new Error(
          `Cannot replace active data source "${sourceType}".`
        );
      }
      sources.set(sourceType, source);
      registrations.push({ source, sourceType });
    },
    unregisterSource(sourceType) {
      if (currentSourceType === sourceType) {
        throw new Error(
          `Cannot unregister active data source "${sourceType}".`
        );
      }
      sources.delete(sourceType);
      unregistrations.push(sourceType);
    },
  };
  const select = createSelect();
  const dom = { select, ...createAddressBar(connectionValue) };
  if (type === 'remote') {
    Object.assign(dom, {
      remoteDisconnectBtn: createButton(),
      remoteDisconnectContainer: createConnectionLine(),
      remoteConnectionTarget: createConnectionTarget(),
    });
  } else {
    Object.assign(dom, {
      dataLinkDisconnectBtn: createButton(),
      dataLinkDisconnectContainer: createConnectionLine(),
      dataLinkConnectionTarget: createConnectionTarget(),
    });
  }
  const activations = [];
  const clearCalls = [];
  const populationCalls = [];

  const datasetIntents = createTestDatasetIntents(async (
      datasetId,
      sourceType,
      loadMethod,
      candidate
    ) => {
      activations.push({
        candidate,
        datasetId,
        loadMethod,
        sourceType,
      });
      if (activationBehavior !== null) {
        return activationBehavior({
          candidate,
          datasetId,
          loadMethod,
          manager,
          setCurrentSourceType(value) {
            currentSourceType = value;
          },
          sourceType,
          sources,
        });
      }
      const priorSource = sources.get(sourceType);
      sources.set(sourceType, candidate);
      if (activationMakesActive) currentSourceType = sourceType;
      priorSource.disconnect();
      return true;
    });
  const connectionControls = initDatasetConnections({
    datasetIntents,
    clearDataset: async () => {
      clearCalls.push(currentSourceType);
      const result = typeof clearResult === 'function'
        ? await clearResult()
        : clearResult;
      if (result === true) currentSourceType = null;
      return result;
    },
    dataSourceManager: manager,
    dom,
    noneDatasetValue: '__none__',
    populateDatasetDropdown: async () => {
      const nextResult = populateResults.length > 0
        ? populateResults.shift()
        : true;
      populationCalls.push(nextResult);
      if (nextResult instanceof Error) {
        return Object.freeze({
          error: nextResult,
          status: 'failed',
        });
      }
      if (nextResult === false) {
        return Object.freeze({ status: 'superseded' });
      }
      select.disabled = false;
      return Object.freeze({ status: 'ready' });
    },
  });

  return {
    activations,
    clearCalls,
    connectButton: dom.dataAddressOpenBtn,
    connectionLine:
      type === 'remote'
        ? dom.remoteDisconnectContainer
        : dom.dataLinkDisconnectContainer,
    datasetIntents,
    disconnectButton:
      type === 'remote'
        ? dom.remoteDisconnectBtn
        : dom.dataLinkDisconnectBtn,
    connectionControls,
    dom,
    factory,
    manager,
    notifications,
    populationCalls,
    registrations,
    select,
    setCurrentSourceType(value) {
      currentSourceType = value;
    },
    sources,
    type,
    unregistrations,
  };
}

function makeHarness(t, type, count) {
  const browser = installBrowser(t);
  const notifications = captureNotifications(t);
  const datasets = Array.from({ length: count }, (_, index) =>
    dataset(index + 1)
  );
  const remoteValue = REMOTE_ADDRESS;
  const githubValue = LINK_ADDRESS;
  const remote = createConnectionSource('remote', datasets, remoteValue);
  const github = createConnectionSource(
    'link',
    datasets,
    githubValue
  );
  const sources = new Map([
    ['remote', remote.registered],
    ['link', github.registered],
  ]);
  const registrations = [];
  const switchCalls = [];
  const manager = {
    getCurrentSourceType() {
      return 'local-demo';
    },
    getSource(sourceType) {
      return sources.get(sourceType) ?? null;
    },
    registerSource(sourceType, source) {
      sources.set(sourceType, source);
      registrations.push({ source, sourceType });
    },
    unregisterSource(sourceType) {
      sources.delete(sourceType);
    },
    async switchToDataset(...args) {
      switchCalls.push(args);
    },
  };

  const select = createSelect();
  const dom = {
    select,
    ...createAddressBar(type === 'remote' ? remoteValue : githubValue),
    remoteDisconnectBtn: createButton(),
    remoteDisconnectContainer: createConnectionLine(),
    remoteConnectionTarget: createConnectionTarget(),
    dataLinkDisconnectBtn: createButton(),
    dataLinkDisconnectContainer: createConnectionLine(),
    dataLinkConnectionTarget: createConnectionTarget(),
  };
  const activations = [];
  const populationCalls = [];
  const reloadCalls = [];
  const statuses = [];
  const infoUpdates = [];

  initDatasetConnections({
    datasetIntents: createTestDatasetIntents(async (
      datasetId,
      sourceType,
      loadMethod,
      candidate
    ) => {
      activations.push({ datasetId, loadMethod, sourceType });
      const priorSource = manager.getSource(sourceType);
      manager.registerSource(sourceType, candidate);
      priorSource.disconnect();
      const connectionInfo = candidate.getConnectionInfo();
      if (sourceType === 'remote') {
        prepareUrlForDataSource('remote', {
          datasetId,
          serverUrl: connectionInfo.url,
        }).commit();
      } else {
        prepareUrlForDataSource('link', {
          datasetId,
          locator: connectionInfo.inputPath,
        }).commit();
      }
      return true;
    }),
    clearDataset: async () => true,
    dataSourceManager: manager,
    dom,
    noneDatasetValue: '__none__',
    populateDatasetDropdown: async () => {
      populationCalls.push(type);
      select.disabled = false;
      return Object.freeze({ status: 'ready' });
    },
  });

  return {
    activations,
    browser,
    candidate: type === 'remote' ? remote.candidate : github.candidate,
    connectButton: dom.dataAddressOpenBtn,
    connectionLine:
      type === 'remote'
        ? dom.remoteDisconnectContainer
        : dom.dataLinkDisconnectContainer,
    datasets,
    dom,
    infoUpdates,
    manager,
    notifications,
    populationCalls,
    registeredSource:
      type === 'remote' ? remote.registered : github.registered,
    registrations,
    reloadCalls,
    select,
    statuses,
    switchCalls,
    type,
  };
}

test('manual Remote and GitHub connections own exact zero/one/many behavior', async t => {
  for (const type of ['remote', 'link']) {
    for (const count of [0, 1, 2]) {
      await t.test(`${type} with ${count} datasets`, async t => {
        const harness = makeHarness(t, type, count);
        const priorHref = harness.browser.href;
        await harness.connectButton.activate();

        assert.equal(harness.manager.getCurrentSourceType(), 'local-demo');
        assert.deepEqual(harness.switchCalls, []);
        assert.deepEqual(harness.reloadCalls, []);
        assert.equal(harness.connectButton.disabled, false);

        const terminal = harness.notifications.filter(
          event => event.kind === 'complete' || event.kind === 'fail'
        );
        assert.equal(terminal.length, 1);

        if (count === 0) {
          assert.equal(harness.candidate.connected, false);
          assert.equal(harness.candidate.disconnectCalls, 1);
          assert.deepEqual(harness.registrations, []);
          assert.equal(
            harness.manager.getSource(type),
            harness.registeredSource
          );
          assert.equal(harness.registeredSource.disconnectCalls, 0);
          assert.equal(harness.populationCalls.length, 0);
          assert.equal(harness.connectionLine.hidden, true);
          assert.equal(harness.dom.dataAddressInput.disabled, false);
          assert.deepEqual(harness.activations, []);
          assert.equal(harness.browser.href, priorHref);
          assert.equal(harness.browser.historyCalls.length, 0);
          assert.equal(harness.select.focusCalls, 0);
          assert.equal(terminal[0].kind, 'fail');
          assert.match(terminal[0].message, /no datasets.*reconnect/i);
          return;
        }

        assert.equal(harness.candidate.connected, true);
        assert.deepEqual(
          harness.registrations.map(({ sourceType }) => sourceType),
          [type]
        );
        assert.equal(harness.populationCalls.length, 1);
        // One line under the bar names the connection, with Disconnect; the
        // bar itself stays free for the next address.
        assert.equal(harness.connectionLine.hidden, false);
        assert.equal(harness.dom.dataAddressInput.disabled, false);
        assert.equal(harness.manager.getSource(type), harness.candidate);
        assert.equal(harness.registeredSource.disconnectCalls, 1);

        if (count === 1) {
          assert.deepEqual(harness.activations, [{
            datasetId: 'dataset-1',
            loadMethod:
              type === 'remote'
                ? DATA_LOAD_METHODS.REMOTE_CONNECT
                : DATA_LOAD_METHODS.LINK_CONNECT,
            sourceType: type,
          }]);
          const url = new URL(harness.browser.href);
          assert.equal(url.searchParams.get('dataset'), 'dataset-1');
          assert.equal(
            url.searchParams.get(type === 'remote' ? 'remote' : 'data'),
            type === 'remote' ? REMOTE_ADDRESS : LINK_ADDRESS
          );
          assert.equal(url.searchParams.get('annotations'), 'team/labels');
          assert.equal(url.hash, '#view');
          assert.equal(harness.browser.historyCalls.length, 1);
          assert.equal(harness.select.focusCalls, 0);
          assert.equal(terminal[0].kind, 'complete');
          return;
        }

        assert.deepEqual(harness.activations, []);
        assert.equal(harness.browser.href, priorHref);
        assert.equal(harness.browser.historyCalls.length, 0);
        assert.equal(harness.select.disabled, false);
        assert.equal(harness.select.focusCalls, 1);
        assert.equal(terminal[0].kind, 'complete');
        assert.match(terminal[0].message, /choose.*dataset list/i);
      });
    }
  }
});

test('a new address of the open connection\'s kind replaces it only once its dataset is ready', async t => {
  // The address bar opens what is typed: when a server (or a link) is the
  // open dataset's source, another one is connected beside it and its
  // dataset replaces the one on screen only when it is ready; nothing is
  // cleared first, so a failure or Cancel leaves the dataset on screen.
  for (const type of ['remote', 'link']) {
    await t.test(type, async t => {
      const harness = makeLifecycleHarness(t, type, 1, {
        activeSourceType: type,
      });
      await harness.connectButton.activate();

      assert.deepEqual(harness.clearCalls, []);
      assert.deepEqual(harness.unregistrations, []);
      assert.equal(harness.activations.length, 1);
      assert.equal(harness.activations[0].sourceType, type);
      assert.equal(harness.manager.getSource(type), harness.factory.candidates[0]);
      assert.equal(harness.connectButton.disabled, false);
      assert.deepEqual(
        harness.notifications.filter(event => event.kind === 'error'),
        []
      );
    });
  }

  await t.test('a failed replacement leaves the dataset on screen', async t => {
    const harness = makeLifecycleHarness(t, 'link', 1, {
      activeSourceType: 'link',
      candidateBehaviors: [{ connectError: new Error('connect rejected') }],
    });
    await harness.connectButton.activate();
    assert.deepEqual(harness.clearCalls, []);
    assert.deepEqual(harness.activations, []);
    assert.equal(harness.manager.getSource('link'), harness.factory.registered);
    assert.equal(harness.manager.getCurrentSourceType(), 'link');
  });
});

test('a typed address the source cannot read is refused before any connection starts', async t => {
  // A malformed GitHub path used to start a connection, fail inside the source,
  // and come back classified as unreadable data: "what is published there is
  // not in a format Cellucid can read. Re-export it with cellucid prepare" -
  // advice that cannot help someone who mistyped a path. Empty input asked to
  // "Enter one remote server". Both are now refused with one sentence about
  // the input itself, and no candidate is created.
  const cases = [
    ['remote', '', /^Type an address first: /],
    ['remote', 'localhost:99999', /^99999 is not a port: a port is a number from 1 to 65535, as in localhost:8765\.$/],
    ['link', '   ', /^Type an address first: /],
    ['link', 'not a repo', /^Cellucid does not recognise "not a repo"\./],
  ];
  for (const [type, value, expected] of cases) {
    await t.test(`${type} ${JSON.stringify(value)}`, async t => {
      const harness = makeLifecycleHarness(t, type, 1);
      harness.dom.dataAddressInput.value = value;
      await harness.connectButton.activate();

      assert.equal(harness.factory.creationCount, 0);
      assert.deepEqual(harness.activations, []);
      assert.equal(harness.connectButton.disabled, false);
      assert.deepEqual(
        harness.notifications.map(event => event.kind),
        ['error'],
        'one refusal, no loading notification and no connection failure'
      );
      assert.match(harness.notifications[0].message, expected);
      assert.doesNotMatch(harness.notifications[0].message, /re-export/i);
    });
  }
});

test('failed connection candidates retire exactly once and preserve prior state', async t => {
  const failures = [
    ['connect', { connectError: new Error('connect rejected') }],
    ['inventory', { listError: new Error('inventory rejected') }],
    ['activation', null],
  ];
  for (const type of ['remote', 'link']) {
    for (const [stage, candidateBehavior] of failures) {
      await t.test(`${type} ${stage}`, async t => {
        const harness = makeLifecycleHarness(t, type, 1, {
          activationBehavior: stage === 'activation'
            ? async () => {
                throw new Error('activation rejected');
              }
            : null,
          candidateBehaviors:
            candidateBehavior === null ? [] : [candidateBehavior],
        });
        await harness.connectButton.activate();

        const candidate = harness.factory.candidates[0];
        assert.equal(candidate.disconnectCalls, 1);
        assert.equal(candidate.connected, false);
        assert.equal(
          harness.manager.getSource(type),
          harness.factory.registered
        );
        assert.equal(harness.factory.registered.disconnectCalls, 0);
        assert.deepEqual(harness.registrations, []);
        assert.deepEqual(harness.populationCalls, []);
        const terminal = harness.notifications.filter(
          event => event.kind === 'complete' || event.kind === 'fail'
        );
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].kind, 'fail');
        // The loader published no cause on these errors, so the notification
        // must say what happened without naming a cause it does not have, and
        // must still carry the raw text, under its Details, as the only
        // evidence there is.
        // A server is reached; a link is opened.
        assert.match(
          terminal[0].message,
          type === 'remote' ? /could not be reached/i : /could not be opened/i
        );
        assert.doesNotMatch(terminal[0].message, /the server|the connection may/i);
        assert.doesNotMatch(terminal[0].message, /Details:|rejected/);
        assert.match(terminal[0].details, /rejected/);
      });
    }
  }

  await t.test('multi-dataset catalog publication failure', async t => {
    const harness = makeLifecycleHarness(t, 'remote', 2, {
      populateResults: [new Error('catalog rejected'), true],
    });
    await harness.connectButton.activate();

    const candidate = harness.factory.candidates[0];
    assert.equal(candidate.disconnectCalls, 1);
    assert.equal(candidate.connected, false);
    assert.equal(
      harness.manager.getSource('remote'),
      harness.factory.registered
    );
    assert.equal(harness.factory.registered.disconnectCalls, 0);
    assert.equal(harness.populationCalls.length, 2);
    const terminal = harness.notifications.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].kind, 'fail');
    assert.match(terminal[0].message, /could not be reached/i);
    assert.match(terminal[0].details, /catalog rejected/i);
  });

  await t.test('candidate factory failure is terminal and contained', async t => {
    const harness = makeLifecycleHarness(t, 'remote', 1, {
      candidateFactoryError: new Error('candidate factory rejected'),
    });
    await harness.connectButton.activate();

    assert.equal(harness.factory.registered.createCandidateCalls, 1);
    assert.deepEqual(harness.factory.candidates, []);
    assert.equal(
      harness.manager.getSource('remote'),
      harness.factory.registered
    );
    const terminal = harness.notifications.filter(
      event => event.kind === 'complete' || event.kind === 'fail'
    );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].kind, 'fail');
    assert.match(terminal[0].details, /candidate factory rejected/i);
    assert.equal(harness.connectButton.disabled, false);
  });

  for (const count of [0, 1]) {
    await t.test(
      `candidate cleanup failure is attempted once (${count} datasets)`,
      async t => {
        const harness = makeLifecycleHarness(t, 'remote', count, {
          activationBehavior: count === 1
            ? async () => {
                throw new Error('activation rejected');
              }
            : null,
          candidateBehaviors: [{
            disconnectError: new Error('candidate cleanup rejected'),
          }],
        });
        await harness.connectButton.activate();

        const candidate = harness.factory.candidates[0];
        assert.equal(candidate.disconnectCalls, 1);
        assert.equal(
          harness.manager.getSource('remote'),
          harness.factory.registered
        );
        const terminal = harness.notifications.filter(
          event => event.kind === 'complete' || event.kind === 'fail'
        );
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].kind, 'fail');
        assert.match(terminal[0].details, /cleanup.*failed|cleanup rejected/i);
      }
    );
  }
});

test('multi-dataset cleanup failure retains the published candidate', async t => {
  for (const type of ['remote', 'link']) {
    await t.test(type, async t => {
      const cleanupError = new Error('prior transport release failed');
      const harness = makeLifecycleHarness(t, type, 2, {
        priorDisconnectError: cleanupError,
      });
      await harness.connectButton.activate();

      const candidate = harness.factory.candidates[0];
      assert.equal(candidate.connected, true);
      assert.equal(candidate.disconnectCalls, 0);
      assert.equal(harness.manager.getSource(type), candidate);
      assert.equal(harness.factory.registered.disconnectCalls, 1);
      assert.equal(harness.populationCalls.length, 1);
      assert.equal(harness.select.focusCalls, 1);
      const terminal = harness.notifications.filter(
        event => event.kind === 'complete' || event.kind === 'fail'
      );
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].kind, 'fail');
      assert.match(
        terminal[0].message,
        /connected.*prior connection could not be released/i
      );
    });
  }
});

test('connected sources disconnect through exact active and non-active paths', async t => {
  for (const type of ['remote', 'link']) {
    for (const active of [false, true]) {
      await t.test(`${type} ${active ? 'active' : 'non-active'}`, async t => {
        const harness = makeLifecycleHarness(
          t,
          type,
          active ? 1 : 2,
          { activationMakesActive: active }
        );
        await harness.connectButton.activate();
        const connected = harness.factory.candidates[0];
        assert.equal(harness.manager.getSource(type), connected);

        await harness.disconnectButton.activate();

        assert.equal(connected.disconnectCalls, 1);
        assert.equal(connected.connected, false);
        assert.notEqual(harness.manager.getSource(type), connected);
        assert.equal(harness.manager.getSource(type).connected, false);
        assert.deepEqual(
          harness.clearCalls,
          active ? [type] : []
        );
        assert.deepEqual(harness.unregistrations, [type]);
        assert.equal(harness.populationCalls.length, 2);
        assert.equal(
          harness.notifications.some(
            event =>
              event.kind === 'success' &&
              /disconnected/i.test(event.message)
          ),
          true
        );
      });
    }
  }

  await t.test('active clear failure preserves the connection', async t => {
    const harness = makeLifecycleHarness(t, 'remote', 1, {
      activationMakesActive: true,
      clearResult: false,
    });
    await harness.connectButton.activate();
    const connected = harness.factory.candidates[0];
    await harness.disconnectButton.activate();

    assert.equal(connected.disconnectCalls, 0);
    assert.equal(connected.connected, true);
    assert.equal(harness.manager.getSource('remote'), connected);
    assert.deepEqual(harness.clearCalls, ['remote']);
    assert.deepEqual(harness.unregistrations, []);
    assert.equal(
      harness.notifications.some(
        event =>
          event.kind === 'error' &&
          /remains connected.*could not be cleared/i.test(event.message)
      ),
      true
    );
  });
});

test('superseded one-dataset connections cannot revoke the newer candidate', async t => {
  for (const type of ['remote', 'link']) {
    await t.test(type, async t => {
      const firstActivation = createDeferred();
      let activationCount = 0;
      const harness = makeLifecycleHarness(t, type, 1, {
        activationBehavior: async ({
          candidate,
          sourceType,
          sources,
        }) => {
          activationCount++;
          if (activationCount === 1) return firstActivation.promise;
          const prior = sources.get(sourceType);
          sources.set(sourceType, candidate);
          prior.disconnect();
          return true;
        },
      });

      const firstConnect = harness.connectButton.activate();
      await waitFor(
        () => harness.activations.length === 1,
        'first activation'
      );
      const secondConnect = harness.connectButton.activate();
      await secondConnect;
      const newer = harness.factory.candidates[1];
      assert.equal(harness.manager.getSource(type), newer);

      firstActivation.reject(
        createDatasetReloadSupersededError('newer connection won')
      );
      await firstConnect;

      const older = harness.factory.candidates[0];
      assert.equal(older.disconnectCalls, 1);
      assert.equal(newer.disconnectCalls, 0);
      assert.equal(newer.connected, true);
      assert.equal(harness.manager.getSource(type), newer);
      assert.equal(harness.factory.registered.disconnectCalls, 1);
      // One opening on screen: the newer connection joined it, and the
      // older one only let go of it, so it ends once, opened.
      assert.equal(
        harness.notifications.filter(event => event.kind === 'dismiss')
          .length,
        0
      );
      assert.equal(
        harness.notifications.filter(event => event.kind === 'complete')
          .length,
        1
      );
      assert.equal(
        harness.notifications.filter(event => event.kind === 'fail')
          .length,
        0
      );
    });
  }
});

test('an older multi-dataset inventory cannot publish after a newer connection', async t => {
  for (const type of ['remote', 'link']) {
    await t.test(type, async t => {
      const firstInventory = createDeferred();
      const harness = makeLifecycleHarness(t, type, 2, {
        candidateBehaviors: [
          { listPromise: firstInventory.promise },
          {},
        ],
      });

      const firstConnect = harness.connectButton.activate();
      await waitFor(
        () => harness.factory.candidates[0]?.connected === true,
        'older connected candidate'
      );
      const secondConnect = harness.connectButton.activate();
      await secondConnect;
      const newer = harness.factory.candidates[1];
      assert.equal(harness.manager.getSource(type), newer);

      firstInventory.resolve([
        dataset(1),
        dataset(2),
      ]);
      await firstConnect;
      const older = harness.factory.candidates[0];

      assert.equal(older.disconnectCalls, 1);
      assert.equal(newer.disconnectCalls, 0);
      assert.equal(harness.manager.getSource(type), newer);
      assert.equal(harness.select.focusCalls, 1);
      // One opening on screen: the newer connection joined it, and the
      // older one only let go of it, so it ends once, opened.
      assert.equal(
        harness.notifications.filter(event => event.kind === 'dismiss')
          .length,
        0
      );
      assert.equal(
        harness.notifications.filter(event => event.kind === 'complete')
          .length,
        1
      );
    });
  }
});

test('disconnect failures are contained in a deterministic blocked state', async t => {
  await t.test('transport cleanup failure', async t => {
    const harness = makeLifecycleHarness(t, 'remote', 2, {
      candidateBehaviors: [{
        disconnectError: new Error('socket cleanup rejected'),
      }],
    });
    await harness.connectButton.activate();
    const connected = harness.factory.candidates[0];

    await harness.disconnectButton.activate();

    assert.equal(connected.disconnectCalls, 1);
    assert.equal(connected.connected, true);
    assert.equal(harness.manager.getSource('remote'), connected);
    assert.deepEqual(harness.unregistrations, []);
    assert.equal(harness.disconnectButton.disabled, true);
    await assertReopenRefused(harness);
    assert.equal(
      harness.notifications.some(
        event =>
          event.kind === 'error' &&
          /disconnect could not finish safely.*reload/i.test(event.message)
      ),
      true
    );
  });

  await t.test('post-disconnect catalog failure', async t => {
    const harness = makeLifecycleHarness(t, 'remote', 2, {
      populateResults: [
        true,
        new Error('catalog refresh rejected'),
      ],
    });
    await harness.connectButton.activate();
    const connected = harness.factory.candidates[0];

    await harness.disconnectButton.activate();

    assert.equal(connected.disconnectCalls, 1);
    assert.equal(connected.connected, false);
    assert.notEqual(harness.manager.getSource('remote'), connected);
    assert.equal(harness.manager.getSource('remote').connected, false);
    assert.deepEqual(harness.unregistrations, ['remote']);
    assert.equal(harness.disconnectButton.disabled, true);
    await assertReopenRefused(harness);
    assert.equal(
      harness.notifications.some(
        event =>
          event.kind === 'error' &&
          /disconnect could not finish safely.*catalog refresh rejected/i
            .test(event.message)
      ),
      true
    );
  });
});

test('connection teardown disables DOM owners', async t => {
  const harness = makeLifecycleHarness(t, 'remote', 1);
  assert.equal(harness.factory.creationCount, 0);

  const firstDestroy = harness.connectionControls.destroy();
  assert.equal(harness.connectionControls.destroy(), firstDestroy);
  await firstDestroy;

  await harness.connectButton.activate();
  await harness.disconnectButton.activate();
  assert.equal(harness.factory.creationCount, 0);
  assert.deepEqual(harness.activations, []);
  assert.deepEqual(harness.clearCalls, []);
  assert.deepEqual(harness.populationCalls, []);
});

test('the address bar ships the label it keeps', async () => {
  // `index.html` paints the bar long before `initUI` runs, so whatever the
  // markup says is on screen for the whole of startup. Its Open button is
  // never relabelled: a connection is shown on its own line under the bar.
  const [indexHtml, connectionsSource] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(
      new URL('../assets/js/app/ui/modules/dataset-connections.js', import.meta.url),
      'utf8'
    ),
  ]);
  assert.match(
    indexHtml,
    /<button[^>]*id="data-address-open-btn"[^>]*>Open<\/button>/
  );
  assert.doesNotMatch(connectionsSource, /(addressOpenButton|dataAddressOpenBtn)\.textContent\s*=/);
  assert.doesNotMatch(connectionsSource, /Reconnect/);
});
