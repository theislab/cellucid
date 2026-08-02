import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DATA_LOAD_METHODS } from '../assets/js/analytics/tracker.js';
import {
  createDatasetReloadSupersededError
} from '../assets/js/app/dataset-reload-outcome.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { updateUrlForDataSource } from '../assets/js/app/url-state.js';
import { initDatasetConnections } from '../assets/js/app/ui/modules/dataset-connections.js';

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
  notifications.error = message => {
    events.push({ kind: 'error', message });
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

function dataset(index) {
  return {
    version: 2,
    id: `dataset-${index}`,
    name: `Dataset ${index}`,
    description: '',
    cellucid_data_version: '1.0.0',
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
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin' },
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
    onConnectionLost() {},
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
    onConnectionLost() {},
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
      connectionLostHandler: null,
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
      onConnectionLost(callback) {
        this.connectionLostHandler = callback;
      },
      offConnectionLost(callback) {
        if (this.connectionLostHandler === callback) {
          this.connectionLostHandler = null;
        }
      },
      loseConnection(error = new Error('transport lost')) {
        assert.equal(typeof this.connectionLostHandler, 'function');
        this.connected = false;
        this.connectionLostHandler(error);
      },
    };
    candidates.push(candidate);
    return candidate;
  }

  const registered = {
    connected: false,
    connectionLostHandler: null,
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
    onConnectionLost(callback) {
      this.connectionLostHandler = callback;
    },
    offConnectionLost(callback) {
      if (this.connectionLostHandler === callback) {
        this.connectionLostHandler = null;
      }
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
  const connectionValue = type === 'remote'
    ? 'https://remote.test'
    : 'owner/repo/exports';
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
  const dom = { select };
  if (type === 'remote') {
    Object.assign(dom, {
      remoteConnectBtn: createButton(),
      remoteDisconnectBtn: createButton(),
      remoteDisconnectContainer: { style: {} },
      remoteServerUrl: createInput('https://remote.test'),
    });
  } else {
    Object.assign(dom, {
      githubConnectBtn: createButton(),
      githubDisconnectBtn: createButton(),
      githubDisconnectContainer: { style: {} },
      githubRepoUrl: createInput('owner/repo/exports'),
    });
  }
  const activations = [];
  const clearCalls = [];
  const populationCalls = [];

  const connectionControls = initDatasetConnections({
    activateDataset: async (
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
    },
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
    connectButton:
      type === 'remote' ? dom.remoteConnectBtn : dom.githubConnectBtn,
    disconnectButton:
      type === 'remote'
        ? dom.remoteDisconnectBtn
        : dom.githubDisconnectBtn,
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
  const remoteValue = 'https://remote.test';
  const githubValue = 'owner/repo/exports';
  const remote = createConnectionSource('remote', datasets, remoteValue);
  const github = createConnectionSource(
    'github-repo',
    datasets,
    githubValue
  );
  const sources = new Map([
    ['remote', remote.registered],
    ['github-repo', github.registered],
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
    userDataBrowseBtn: createButton(),
    userDataFileInput: createInput(),
    userDataH5adBtn: createButton(),
    userDataH5adInput: createInput(),
    userDataZarrArchiveBtn: createButton(),
    userDataZarrArchiveInput: createInput(),
    remoteConnectBtn: createButton(),
    remoteDisconnectBtn: createButton(),
    remoteDisconnectContainer: { style: {} },
    remoteServerUrl: createInput(remoteValue),
    githubConnectBtn: createButton(),
    githubDisconnectBtn: createButton(),
    githubDisconnectContainer: { style: {} },
    githubRepoUrl: createInput(githubValue),
  };
  const activations = [];
  const populationCalls = [];
  const reloadCalls = [];
  const statuses = [];
  const infoUpdates = [];

  initDatasetConnections({
    activateDataset: async (
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
        updateUrlForDataSource('remote', {
          datasetId,
          serverUrl: connectionInfo.url,
        });
      } else {
        updateUrlForDataSource('github-repo', {
          datasetId,
          path: connectionInfo.inputPath,
        });
      }
      return true;
    },
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
    connectButton:
      type === 'remote' ? dom.remoteConnectBtn : dom.githubConnectBtn,
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
  for (const type of ['remote', 'github-repo']) {
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
          assert.equal(harness.connectButton.textContent, 'Connect');
          assert.equal(
            harness.dom[
              type === 'remote' ? 'remoteServerUrl' : 'githubRepoUrl'
            ].disabled,
            false
          );
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
        assert.equal(harness.connectButton.textContent, 'Reconnect');
        assert.equal(harness.manager.getSource(type), harness.candidate);
        assert.equal(harness.registeredSource.disconnectCalls, 1);
        const displaced =
          type === 'remote'
            ? harness.dom.remoteServerUrl
            : harness.dom.githubRepoUrl;
        assert.equal(displaced.disabled, true);

        if (count === 1) {
          assert.deepEqual(harness.activations, [{
            datasetId: 'dataset-1',
            loadMethod:
              type === 'remote'
                ? DATA_LOAD_METHODS.REMOTE_CONNECT
                : DATA_LOAD_METHODS.GITHUB_CONNECT,
            sourceType: type,
          }]);
          const url = new URL(harness.browser.href);
          assert.equal(url.searchParams.get('dataset'), 'dataset-1');
          assert.equal(
            url.searchParams.get(type === 'remote' ? 'remote' : 'github'),
            type === 'remote'
              ? 'https://remote.test'
              : 'owner/repo/exports'
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
        assert.match(terminal[0].message, /choose.*sample datasets/i);
      });
    }
  }
});

test('active Remote and GitHub reconnects are rejected before candidate mutation', async t => {
  for (const type of ['remote', 'github-repo']) {
    await t.test(type, async t => {
      const harness = makeLifecycleHarness(t, type, 1, {
        activeSourceType: type,
      });
      await harness.connectButton.activate();

      assert.equal(harness.factory.creationCount, 0);
      assert.equal(harness.factory.registered.createCandidateCalls, 0);
      assert.deepEqual(harness.activations, []);
      assert.equal(
        harness.manager.getSource(type),
        harness.factory.registered
      );
      assert.equal(harness.connectButton.disabled, false);
      assert.equal(
        harness.notifications.filter(event => event.kind === 'loading')
          .length,
        0
      );
      const errors = harness.notifications.filter(
        event => event.kind === 'error'
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /active.*disconnect.*reconnect/i);
    });
  }
});

test('failed connection candidates retire exactly once and preserve prior state', async t => {
  const failures = [
    ['connect', { connectError: new Error('connect rejected') }],
    ['inventory', { listError: new Error('inventory rejected') }],
    ['activation', null],
  ];
  for (const type of ['remote', 'github-repo']) {
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
        // must still carry the raw text as the only evidence there is.
        assert.match(terminal[0].message, /could not be reached/i);
        assert.doesNotMatch(terminal[0].message, /the server|the connection may/i);
        assert.match(terminal[0].message, /Details: .+ rejected/);
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
    assert.match(terminal[0].message, /could not be reached.*catalog rejected/i);
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
    assert.match(terminal[0].message, /candidate factory rejected/i);
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
        assert.match(terminal[0].message, /cleanup.*failed|cleanup rejected/i);
      }
    );
  }
});

test('multi-dataset cleanup failure retains the published candidate', async t => {
  for (const type of ['remote', 'github-repo']) {
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
  for (const type of ['remote', 'github-repo']) {
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

test('Remote connection loss clears only active science and retires transport once', async t => {
  for (const active of [false, true]) {
    await t.test(active ? 'active' : 'non-active', async t => {
      const harness = makeLifecycleHarness(
        t,
        'remote',
        active ? 1 : 2,
        { activationMakesActive: active }
      );
      await harness.connectButton.activate();
      const lost = harness.factory.candidates[0];
      lost.loseConnection();
      await waitFor(
        () => harness.notifications.some(
          event =>
            event.kind === 'error' &&
            /connection was lost.*reconnect/i.test(event.message)
        ),
        'connection-loss completion'
      );

      assert.equal(lost.disconnectCalls, 1);
      assert.notEqual(harness.manager.getSource('remote'), lost);
      assert.equal(harness.manager.getSource('remote').connected, false);
      assert.deepEqual(
        harness.clearCalls,
        active ? ['remote'] : []
      );
      assert.deepEqual(harness.unregistrations, ['remote']);
      assert.equal(harness.populationCalls.length, 2);
      assert.equal(
        harness.notifications.some(
          event =>
            event.kind === 'error' &&
            /connection was lost.*reconnect/i.test(event.message)
        ),
        true
      );
    });
  }

  await t.test('active clear failure blocks recovery without teardown', async t => {
    const harness = makeLifecycleHarness(t, 'remote', 1, {
      activationMakesActive: true,
      clearResult: false,
    });
    await harness.connectButton.activate();
    const lost = harness.factory.candidates[0];
    lost.loseConnection();
    await waitFor(
      () => harness.connectButton.disabled === true,
      'blocked connection-loss controls'
    );

    assert.equal(lost.disconnectCalls, 0);
    assert.equal(harness.manager.getSource('remote'), lost);
    assert.deepEqual(harness.clearCalls, ['remote']);
    assert.deepEqual(harness.unregistrations, []);
    assert.equal(harness.dom.remoteServerUrl.disabled, true);
    assert.equal(
      harness.notifications.some(
        event =>
          event.kind === 'error' &&
          /could not be cleared safely.*reload/i.test(event.message)
      ),
      true
    );
  });
});

test('superseded one-dataset connections cannot revoke the newer candidate', async t => {
  for (const type of ['remote', 'github-repo']) {
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
      assert.equal(
        harness.notifications.filter(event => event.kind === 'dismiss')
          .length,
        1
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
  for (const type of ['remote', 'github-repo']) {
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
      assert.equal(
        harness.notifications.filter(event => event.kind === 'dismiss')
          .length,
        1
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
    assert.equal(harness.connectButton.disabled, true);
    assert.equal(harness.disconnectButton.disabled, true);
    assert.equal(harness.dom.remoteServerUrl.disabled, true);
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
    assert.equal(harness.connectButton.disabled, true);
    assert.equal(harness.disconnectButton.disabled, true);
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

test('connection teardown unregisters transport listeners and disables DOM owners', async t => {
  const harness = makeLifecycleHarness(t, 'remote', 1);
  assert.equal(
    typeof harness.factory.registered.connectionLostHandler,
    'function'
  );
  assert.equal(harness.factory.creationCount, 0);

  const firstDestroy = harness.connectionControls.destroy();
  assert.equal(harness.connectionControls.destroy(), firstDestroy);
  await firstDestroy;

  assert.equal(
    harness.factory.registered.connectionLostHandler,
    null
  );
  await harness.connectButton.activate();
  await harness.disconnectButton.activate();
  assert.equal(harness.factory.creationCount, 0);
  assert.deepEqual(harness.activations, []);
  assert.deepEqual(harness.clearCalls, []);
  assert.deepEqual(harness.populationCalls, []);
});

test('every connect button ships the label its wiring writes', async () => {
  // `index.html` paints these buttons long before `initUI` runs — the sidebar
  // ships them disabled precisely because their listeners arrive tens of
  // seconds later on a slow link. Whatever the markup says is therefore on
  // screen for the whole of startup, and it is what a screenshot taken during
  // startup records. The GitHub button shipped "Load" and was relabelled
  // "Connect" the moment the wiring ran (CEL-0170), so the app documented
  // itself with a word it never shows once it is working.
  const [indexHtml, connectionsSource, domCacheSource] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(
      new URL('../assets/js/app/ui/modules/dataset-connections.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../assets/js/app/ui/core/dom-cache.js', import.meta.url),
      'utf8'
    ),
  ]);

  const label = /connectButton\.textContent =\s*connected \? '([^']+)' : '([^']+)';/
    .exec(connectionsSource);
  assert.ok(label !== null, 'the connect label must still be written in one place');
  const [, connectedLabel, disconnectedLabel] = label;

  // The buttons are whichever DOM keys the wiring is handed, resolved to their
  // element ids by the DOM cache, so a third connection source is covered the
  // day it is added rather than the day someone remembers this test.
  const wiredKeys = [
    ...connectionsSource.matchAll(/^\s+connectButton: \w+\.(\w+),$/gm),
  ].map(match => match[1]);
  assert.ok(wiredKeys.length >= 2, 'both connection sources must still be wired');

  for (const key of wiredKeys) {
    const idMatch = new RegExp(`${key}: byId\\('([^']+)'\\)`).exec(domCacheSource);
    assert.ok(idMatch !== null, `dom-cache must resolve ${key} to an element id`);
    const id = idMatch[1];
    const shipped = new RegExp(
      `<button[^>]*id="${id}"[^>]*>([^<]*)</button>`
    ).exec(indexHtml);
    assert.ok(shipped !== null, `index.html must carry a #${id} button`);
    assert.equal(
      shipped[1],
      disconnectedLabel,
      `#${id} must ship the label its wiring writes when nothing is connected, `
        + 'so startup never shows a word the app then replaces'
    );
    assert.notEqual(shipped[1], connectedLabel);
  }
});
