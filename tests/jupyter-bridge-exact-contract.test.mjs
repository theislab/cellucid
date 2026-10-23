import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  JUPYTER_HEALTH_TIMEOUT_MS,
  JupyterBridgeDataSource,
  describeJupyterCommandFailure,
  describeJupyterCommandType,
  encodeJupyterSelectionCells,
  getJupyterConfig,
  uploadJupyterSessionBundle,
} from '../assets/js/data/jupyter-source.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  DataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  createJupyterHealthMonitor,
  createJupyterPointerDelivery,
} from '../assets/js/app/jupyter-pointer-delivery.js';

// Every test here talks to a current notebook server, which answers
// `/_cellucid/protocol` with the event and command lists below (the copy of
// `cellucid.jupyter._wire` is pinned against the original further down).
// Tests that exercise the protocol request itself set
// `protocolFixture.passthrough` so their own fetch answers it.
// The sibling cellucid-python checkout whose wire module the copies here are
// pinned against: beside this repository, or CELLUCID_PYTHON_ROOT.
const PYTHON_WIRE_PATH = process.env.CELLUCID_PYTHON_ROOT
  ? new URL(`file://${process.env.CELLUCID_PYTHON_ROOT.replace(/\/$/, '')}/src/cellucid/jupyter/_wire.py`)
  : new URL('../../cellucid-python/src/cellucid/jupyter/_wire.py', import.meta.url);

const CURRENT_PROTOCOL = Object.freeze({
  events: [
    'click', 'command_error', 'data_mapping', 'debug_snapshot', 'hover',
    'pong', 'ready', 'selection', 'session_bundle',
  ],
  commands: [
    'clearHighlights', 'debug_snapshot', 'freeze', 'highlight', 'ping',
    'requestSessionBundle', 'resetCamera', 'setColorBy', 'setDataMapping',
    'setVisibility',
  ],
});
const protocolFixture = { passthrough: false, document: CURRENT_PROTOCOL };
const nativeFetch = globalThis.fetch;
let assignedFetch = nativeFetch;
function fixtureFetch(input, init) {
  if (
    !protocolFixture.passthrough &&
    String(input).endsWith('/_cellucid/protocol')
  ) {
    return Promise.resolve(new Response(JSON.stringify(protocolFixture.document), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  return assignedFetch(input, init);
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  get() {
    return fixtureFetch;
  },
  set(value) {
    assignedFetch = value === fixtureFetch ? nativeFetch : value;
  },
});

function installWindow(search) {
  const href = `http://127.0.0.1:8765/viewer/${search}`;
  const parent = {};
  const listeners = new Map();
  globalThis.window = {
    location: new URL(href),
    parent,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
  };
  return {
    parent,
    listeners,
    dispatch(type, event) {
      for (const callback of [...(listeners.get(type) ?? [])]) {
        callback(event);
      }
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function hoverIntent(viewId, cellIndex, offset = 0) {
  return {
    viewId,
    cellIndex,
    position: {
      x: cellIndex + offset,
      y: cellIndex + offset + 0.25,
      z: cellIndex + offset + 0.5,
    },
  };
}

async function nextTask() {
  await new Promise(resolve => setImmediate(resolve));
}

function createDeterministicTimeoutClock() {
  let nextId = 1;
  const pending = new Map();
  return Object.freeze({
    schedule(callback, delay) {
      assert.equal(typeof callback, 'function');
      assert.equal(Number.isFinite(delay) && delay >= 0, true);
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    get pendingCount() {
      return pending.size;
    },
    runNext() {
      const entry = pending.entries().next();
      assert.equal(entry.done, false, 'Expected one scheduled timeout.');
      const [id, callback] = entry.value;
      pending.delete(id);
      callback();
    },
  });
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return;
    await nextTask();
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

function jupyterHealthResponse() {
  return new Response(JSON.stringify({
    status: 'ok',
    type: 'anndata',
    version: '1.0.0',
    format: 'h5ad',
    n_cells: 3,
    n_genes: 2,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Jupyter configuration requires one exact viewer id and token', async t => {
  await t.test('current Python URL', () => {
    installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
    assert.deepEqual(getJupyterConfig(), {
      serverUrl: 'http://127.0.0.1:8765/viewer',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    });
  });
  await t.test('current direct AnnData Python URL', () => {
    installWindow(
      '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true',
    );
    assert.deepEqual(getJupyterConfig(), {
      serverUrl: 'http://127.0.0.1:8765/viewer',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    });
  });

  for (const [name, search] of [
    ['missing viewer id', '?jupyter=true&viewerToken=secret-1'],
    ['missing viewer token', '?jupyter=true&viewerId=viewer-1'],
    ['noncanonical mode', '?jupyter=1&viewerId=viewer-1&viewerToken=secret-1'],
    ['duplicate viewer id', '?jupyter=true&viewerId=viewer-1&viewerId=viewer-2&viewerToken=secret-1'],
    ['duplicate viewer token', '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&viewerToken=secret-2'],
    ['whitespace viewer id', '?jupyter=true&viewerId=%20viewer-1&viewerToken=secret-1'],
    ['whitespace viewer token', '?jupyter=true&viewerId=viewer-1&viewerToken=secret%201'],
    ['undeclared remote route', '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&remote=https%3A%2F%2Fexample.test'],
    ['undeclared query field', '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&extra=true'],
    ['noncanonical AnnData discriminator', '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&anndata=1'],
    ['duplicate AnnData discriminator', '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true&anndata=true'],
  ]) {
    await t.test(name, () => {
      installWindow(search);
      assert.throws(
        () => getJupyterConfig(),
        /Jupyter.*viewerId.*viewerToken|Jupyter mode/i,
      );
    });
  }
});

test('Jupyter initialization validates both exact Python health variants', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');

  await t.test('current direct AnnData server', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      n_cells: 120,
      n_genes: 6,
    }), { status: 200 });
    const source = new JupyterBridgeDataSource();
    assert.equal(await source.initialize(), true);
  });

  for (const [name, payload] of [
    ['fabricated type', { status: 'ok', type: 'prepared', version: '1.2.3' }],
    ['retired prepared-export server', { status: 'ok', type: 'exported', version: '1.2.3' }],
    ['AnnData format missing', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData retired is_backed field', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      is_backed: false,
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData retired in-memory format', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'in-memory',
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData numeric coercion', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      n_cells: '120',
      n_genes: 6,
    }],
  ]) {
    await t.test(name, async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify(payload),
        { status: 200 },
      );
      const source = new JupyterBridgeDataSource();
      await assert.rejects(source.initialize(), /health/i);
      assert.equal(source.isConnected(), false);
      assert.equal(source._config, null);
    });
  }
});

test('a Jupyter health request that never answers fails within its deadline', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // The deadline is an ordinary timer, so mock time drives it exactly.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetchSignal = null;
  globalThis.fetch = (_url, init) => {
    fetchSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {
        once: true,
      });
    });
  };
  const source = new JupyterBridgeDataSource();
  let settled = false;
  const initialization = source.initialize().finally(() => {
    settled = true;
  });
  initialization.catch(() => {});
  const turn = () => new Promise(resolve => setImmediate(resolve));
  await turn();
  assert.notEqual(fetchSignal, null, 'the health request must be in flight');

  t.mock.timers.tick(JUPYTER_HEALTH_TIMEOUT_MS - 1);
  await turn();
  assert.equal(settled, false, 'the request may run until its deadline');

  t.mock.timers.tick(1);
  await assert.rejects(
    initialization,
    /did not answer http:\/\/127\.0\.0\.1:8765.*\/_cellucid\/health within 30 s/
  );
  assert.equal(JUPYTER_HEALTH_TIMEOUT_MS, 30_000);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(source.isConnected(), false);
});

test('Jupyter events carry exact token routing and propagate HTTP failure', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = source._declaredConfig;
  source._connected = true;

  await t.test('authenticated success', async () => {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ status: 'ok', delivered: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    await source._postEventToPython({
      type: 'pong',
      requestId: 'ping-1',
      t: 7,
    });
    assert.equal(
      captured.url,
      'http://127.0.0.1:8765/viewer/_cellucid/events',
    );
    assert.deepEqual(JSON.parse(captured.init.body), {
      type: 'pong',
      requestId: 'ping-1',
      t: 7,
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    });
    // keepalive bodies share one 64 KiB budget and are refused above it.
    assert.equal(Object.hasOwn(captured.init, 'keepalive'), false);
  });

  await t.test('server rejection', async () => {
    globalThis.fetch = async () => new Response('denied', { status: 403 });
    await assert.rejects(
      source._postEventToPython({ type: 'pong', requestId: 'ping-1', t: 7 }),
      /Jupyter event delivery failed.*403/i,
    );
  });
});

test('session bundle upload includes exact token query and rejects coercion', async t => {
  const config = {
    serverUrl: 'http://127.0.0.1:8765/viewer',
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  };

  await t.test('authenticated upload', async () => {
    let captured = null;
    await uploadJupyterSessionBundle({
      config,
      message: {
        type: 'requestSessionBundle',
        requestId: 'request-1',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      createSessionBundle: async () => new Blob([Uint8Array.of(1, 2, 3)]),
      fetchImpl: async function (url, init) {
        assert.equal(this, undefined);
        captured = { url, init };
        return new Response(
          JSON.stringify({ status: 'ok', bytes: 3 }),
          { status: 200 },
        );
      },
    });

    const url = new URL(captured.url);
    assert.equal(url.pathname, '/viewer/_cellucid/session_bundle');
    assert.deepEqual(
      [...url.searchParams.entries()],
      [
        ['viewerId', 'viewer-1'],
        ['viewerToken', 'secret-1'],
        ['requestId', 'request-1'],
      ],
    );
    assert.equal(
      captured.init.headers['Content-Type'],
      'application/octet-stream',
    );
  });

  await t.test('upload owns one immutable call generation', async () => {
    const bundle = deferred();
    const mutableConfig = { ...config };
    const mutableMessage = {
      type: 'requestSessionBundle',
      requestId: 'request-original',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    };
    let capturedUrl = null;
    let replacementFetchCalls = 0;
    const options = {
      config: mutableConfig,
      message: mutableMessage,
      createSessionBundle: async () => bundle.promise,
      fetchImpl: async url => {
        capturedUrl = String(url);
        return new Response(
          JSON.stringify({ status: 'ok', bytes: 1 }),
          { status: 200 },
        );
      },
    };
    const upload = uploadJupyterSessionBundle(options);

    mutableConfig.viewerId = 'viewer-mutated';
    mutableConfig.viewerToken = 'secret-mutated';
    mutableMessage.requestId = 'request-mutated';
    mutableMessage.viewerId = 'viewer-mutated';
    mutableMessage.viewerToken = 'secret-mutated';
    options.fetchImpl = async () => {
      replacementFetchCalls += 1;
      throw new Error('replacement fetch must not own the upload');
    };
    bundle.resolve(new Blob([Uint8Array.of(1)]));

    await upload;
    const url = new URL(capturedUrl);
    assert.deepEqual([...url.searchParams.entries()], [
      ['viewerId', 'viewer-1'],
      ['viewerToken', 'secret-1'],
      ['requestId', 'request-original'],
    ]);
    assert.equal(replacementFetchCalls, 0);
  });

  await t.test('numeric request id', async () => {
    let bundleCalls = 0;
    let fetchCalls = 0;
    await assert.rejects(
      uploadJupyterSessionBundle({
        config,
        message: {
          type: 'requestSessionBundle',
          requestId: 7,
          viewerId: 'viewer-1',
          viewerToken: 'secret-1',
        },
        createSessionBundle: async () => {
          bundleCalls++;
          return new Blob([Uint8Array.of(1)]);
        },
        fetchImpl: async () => {
          fetchCalls++;
          return new Response(null, { status: 200 });
        },
      }),
      /requestId must be exact non-empty text/i,
    );
    assert.equal(bundleCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  await t.test('server byte-count mismatch', async () => {
    await assert.rejects(
      uploadJupyterSessionBundle({
        config,
        message: {
          type: 'requestSessionBundle',
          requestId: 'request-1',
          viewerId: 'viewer-1',
          viewerToken: 'secret-1',
        },
        createSessionBundle: async () =>
          new Blob([Uint8Array.of(1, 2, 3)]),
        fetchImpl: async () => new Response(
          JSON.stringify({ status: 'ok', bytes: 2 }),
          { status: 200 },
        ),
      }),
      /bytes.*match/i,
    );
  });
});

test('Jupyter initialization propagates the exact health failure', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const failure = new Error('health transport failed');
  globalThis.fetch = async () => {
    throw failure;
  };
  const source = new JupyterBridgeDataSource();
  await assert.rejects(source.initialize(), error => error === failure);
  assert.equal(source.isConnected(), false);
});

test('Jupyter initialization accepts one exact current server health response', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'ok',
    type: 'anndata',
    version: '1.0.0',
    format: 'h5ad',
    n_cells: 3,
    n_genes: 2,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const source = new JupyterBridgeDataSource();
  assert.equal(await source.initialize(), true);
  assert.equal(source.isConnected(), true);
});

test(
  'Jupyter initialization owns one immutable config and one live listener',
  async () => {
    const runtime = installWindow(
      '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
    );
    const config = getJupyterConfig();
    const source = new JupyterBridgeDataSource(config);
    assert.equal(runtime.listeners.get('message')?.size ?? 0, 0);

    config.viewerId = 'mutated-viewer';
    config.viewerToken = 'mutated-token';
    window.location = new URL(
      'http://127.0.0.1:9999/other/' +
      '?jupyter=true&viewerId=viewer-2&viewerToken=secret-2',
    );
    const requested = [];
    globalThis.fetch = async url => {
      requested.push(String(url));
      return jupyterHealthResponse();
    };

    assert.equal(await source.initialize(), true);
    assert.deepEqual(requested, [
      'http://127.0.0.1:8765/viewer/_cellucid/health',
    ]);
    assert.deepEqual(source.getConnectionInfo(), {
      serverUrl: 'http://127.0.0.1:8765/viewer',
      viewerId: 'viewer-1',
      status: 'connected',
    });
    assert.equal(runtime.listeners.get('message')?.size ?? 0, 1);

    source.disconnect();
    assert.equal(runtime.listeners.get('message')?.size ?? 0, 0);
  },
);

test('Jupyter deactivation keeps its authenticated transport reusable', async () => {
  const runtime = installWindow(
    '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
  );
  globalThis.fetch = async () => jupyterHealthResponse();
  const source = new JupyterBridgeDataSource(getJupyterConfig());
  await source.initialize();
  let calls = 0;
  source.onMessage(() => {
    calls += 1;
  });

  assert.equal(source.onDeactivate(), undefined);
  assert.equal(source.isConnected(), true);
  assert.equal(runtime.listeners.get('message')?.size ?? 0, 1);
  runtime.dispatch('message', {
    data: {
      type: 'freeze',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    },
    origin: 'https://notebook.example',
    source: runtime.parent,
  });
  assert.equal(calls, 1);

  source.disconnect();
  assert.equal(source.isConnected(), false);
  assert.equal(runtime.listeners.get('message')?.size ?? 0, 0);
});

test(
  'Jupyter initialization and disconnect fence every deferred health result',
  async t => {
    await t.test('newest initialization owns publication', async () => {
      installWindow(
        '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
      );
      const firstHealth = deferred();
      const secondHealth = deferred();
      const healthSignals = [];
      let healthCalls = 0;
      globalThis.fetch = async (_url, init = {}) => {
        healthCalls += 1;
        healthSignals.push(init.signal ?? null);
        return healthCalls === 1
          ? firstHealth.promise
          : secondHealth.promise;
      };
      const source = new JupyterBridgeDataSource(getJupyterConfig());
      const first = source.initialize();
      const firstRejection = assert.rejects(first, /superseded/i);
      const second = source.initialize();
      assert.ok(healthSignals[0] instanceof AbortSignal);
      assert.equal(healthSignals[0].aborted, true);

      secondHealth.resolve(jupyterHealthResponse());
      assert.equal(await second, true);
      firstHealth.resolve(jupyterHealthResponse());
      await firstRejection;
      assert.equal(source.isConnected(), true);
      source.disconnect();
    });

    await t.test('disconnect retires pending initialization', async () => {
      const runtime = installWindow(
        '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
      );
      const health = deferred();
      let healthSignal = null;
      globalThis.fetch = async (_url, init = {}) => {
        healthSignal = init.signal ?? null;
        return health.promise;
      };
      const source = new JupyterBridgeDataSource(getJupyterConfig());
      const initialization = source.initialize();
      const rejection = assert.rejects(initialization, /superseded/i);

      source.disconnect();
      assert.ok(healthSignal instanceof AbortSignal);
      assert.equal(healthSignal.aborted, true);
      health.resolve(jupyterHealthResponse());
      await rejection;
      assert.equal(source.isConnected(), false);
      assert.equal(runtime.listeners.get('message')?.size ?? 0, 0);
    });
  },
);

test(
  'Jupyter message dispatch pins the exact parent and observes async failure',
  async () => {
    const runtime = installWindow(
      '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
    );
    globalThis.fetch = async () => jupyterHealthResponse();
    const source = new JupyterBridgeDataSource(getJupyterConfig());
    await source.initialize();

    let calls = 0;
    source.onMessage(() => {
      calls += 1;
    });
    const freeze = {
      data: {
        type: 'freeze',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
    };
    source._handleMessage({
      ...freeze,
      source: {},
    });
    assert.equal(calls, 0);
    assert.equal(source._parentOrigin, null);

    source._handleMessage({
      ...freeze,
      source: runtime.parent,
    });
    assert.equal(calls, 1);

    const failure = new Error('async notebook dispatch failed');
    const reported = [];
    source._reportMessageFailure = (commandType, error) => {
      reported.push([commandType, error]);
    };
    source.onMessage(message => (
      message.type === 'requestSessionBundle'
        ? Promise.reject(failure)
        : undefined
    ));
    runtime.dispatch('message', {
      data: {
        type: 'requestSessionBundle',
        requestId: 'request-1',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: runtime.parent,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reported, [['requestSessionBundle', failure]]);
    source.disconnect();
  },
);

test('Jupyter bridge has no unused frontend-to-parent request protocol', () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  assert.equal('sendRequest' in source, false);
  assert.equal('_pendingRequests' in source, false);
  assert.equal('_requestId' in source, false);
  assert.equal('_postToParent' in source, false);
});

test('authenticated Jupyter messages require exact viewer identity and pinned origin', () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = source._declaredConfig;
  source._connected = true;
  let calls = 0;
  source.onMessage(() => {
    calls += 1;
  });

  assert.throws(
    () => source._handleMessage({
      data: { type: 'freeze', viewerToken: 'secret-1' },
      origin: 'https://notebook.example',
      source: window.parent,
    }),
    /viewerId/i,
  );
  assert.equal(calls, 0);

  source._handleMessage({
    data: {
      type: 'freeze',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    },
    origin: 'https://notebook.example',
    source: window.parent,
  });
  assert.equal(calls, 1);

  assert.throws(
    () => source._handleMessage({
      data: {
        type: 'freeze',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://other.example',
      source: window.parent,
    }),
    /origin/i,
  );
  assert.equal(calls, 1);
});

test('Jupyter callback registration and delivery preserve the original failure', () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = source._declaredConfig;
  source._connected = true;
  assert.throws(() => source.onMessage(null), /callback.*function/i);

  const failure = new Error('notebook command failed');
  source.onMessage(() => {
    throw failure;
  });
  assert.throws(
    () => source._handleMessage({
      data: {
        type: 'freeze',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: window.parent,
    }),
    error => error === failure,
  );
});

test('Jupyter authenticated commands validate exact payloads and async delivery', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = source._declaredConfig;
  source._connected = true;
  let highlightCalls = 0;
  source.onHighlight(() => {
    highlightCalls += 1;
  });

  assert.throws(
    () => source._handleMessage({
      data: {
        type: 'highlight',
        cells: '1,2',
        color: '#ff0000',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: window.parent,
    }),
    /must be an array/i,
  );
  // Indices are checked against the dataset, and ordered once, by the state
  // that applies them (`cellListFrom`, `setCellVisibility`), not here.
  assert.equal(highlightCalls, 0);
  assert.throws(
    () => source._handleMessage({
      data: {
        type: 'highlight',
        cells: [],
        color: '#ff0000',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: window.parent,
    }),
    /non-empty/i,
  );

  source._handleMessage({
    data: {
      type: 'highlight',
      cells: [1, 2],
      color: '#ff0000',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    },
    origin: 'https://notebook.example',
    source: window.parent,
  });
  assert.equal(highlightCalls, 1);

  source._handleMessage({
    data: {
      type: 'highlight',
      cells: [3],
      color: '#00ff00',
      viewerId: 'viewer-1',
      viewerToken: 'unrelated-token',
    },
    origin: 'https://other.example',
    source: window.parent,
  });
  assert.equal(highlightCalls, 1);

  const failure = new Error('async notebook command failed');
  source.onMessage(async () => {
    throw failure;
  });
  await assert.rejects(
    source._handleMessage({
      data: {
        type: 'freeze',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: window.parent,
    }),
    error => error === failure,
  );
  assert.throws(
    () => source.onHighlight(null),
    /callback.*function/i,
  );
  assert.equal('onSelectionSync' in source, false);
});

test('Jupyter ready and selection events reject invented defaults', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ status: 'ok', delivered: true }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  await assert.rejects(source.notifyReady({}), /nCells.*dimensions/i);
  await assert.rejects(source.notifySelection(Uint32Array.of(1, 2)), /source/i);
});

test('Jupyter browser notifications publish only exact current payloads', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  const delivered = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/_cellucid/selection')) {
      delivered.push({
        type: 'selection',
        cells: Array.from(decodeSelectionBody(init.body)),
      });
    } else {
      delivered.push(JSON.parse(init.body));
    }
    return new Response(
      JSON.stringify({ status: 'ok', delivered: true }),
      { status: 200 },
    );
  };

  await source.notifySelection(Uint32Array.of(1, 2), 'lasso');
  await source.notifyHover(1, { x: 1, y: 2, z: 3 });
  await source.notifyHover(null, null);
  await source.notifyClick(2, {
    button: 0,
    shift: false,
    ctrl: true,
  });
  await source.notifyReady({ nCells: 120, dimensions: 2 });

  assert.deepEqual(delivered.map(event => event.type), [
    'selection',
    'hover',
    'hover',
    'click',
    'ready',
  ]);
  assert.deepEqual(delivered[4], {
    type: 'ready',
    n_cells: 120,
    dimensions: 2,
    viewerId: 'viewer-1',
    viewerToken: 'secret-1',
  });

  const callsBeforeInvalid = delivered.length;
  await assert.rejects(
    source.notifyClick(2, { button: '0', shift: false, ctrl: false }),
    /button/i,
  );
  await assert.rejects(
    source.notifyHover(2, { x: 1, y: Number.NaN, z: 3 }),
    /finite/i,
  );
  assert.equal(delivered.length, callsBeforeInvalid);
});

/** Read one `POST /_cellucid/selection` body the way Python does. */
function decodeSelectionBody(body) {
  assert.ok(body instanceof Uint8Array, 'the selection body must be bytes');
  assert.equal(body.byteLength % 4, 0);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const cells = new Array(body.byteLength / 4);
  for (let index = 0; index < cells.length; index++) {
    cells[index] = view.getUint32(index * 4, true);
  }
  return cells;
}

test('a selection travels as exact little-endian uint32 bytes on its own route', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(url), init });
    return new Response(
      JSON.stringify({ status: 'ok', delivered: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  await t.test('the wire form is pinned byte for byte', async () => {
    requests.length = 0;
    await source.notifySelection(Uint32Array.of(0, 10, 42), 'lasso');
    assert.equal(requests.length, 1);
    const [{ url, init }] = requests;
    assert.equal(url.origin + url.pathname, 'http://127.0.0.1:8765/viewer/_cellucid/selection');
    assert.deepEqual([...url.searchParams.entries()], [
      ['viewerId', 'viewer-1'],
      ['viewerToken', 'secret-1'],
      ['source', 'lasso'],
    ]);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/octet-stream' });
    assert.equal(Object.hasOwn(init, 'keepalive'), false);
    assert.deepEqual(
      Array.from(init.body),
      [0, 0, 0, 0, 10, 0, 0, 0, 42, 0, 0, 0],
    );
  });

  await t.test('a selection far above 64 KiB round-trips exactly', async () => {
    // 1,000,000 cells: 4 MB as uint32, well past the 64 KiB keepalive budget
    // and the 1 MiB JSON event limit that stopped selections before. The
    // selection tools hand over a cell list (ascending), up to the largest
    // uint32 index.
    const count = 1_000_000;
    const cells = new Uint32Array(count);
    for (let index = 0; index < count; index++) {
      cells[index] = (index * 7_919) % 4_000_003;
    }
    cells[count - 1] = 0xFFFFFFFF;
    cells.sort();
    requests.length = 0;
    await source.notifySelection(cells, 'annotation');
    const [{ init }] = requests;
    assert.equal(init.body.byteLength, count * 4);
    assert.ok(init.body.byteLength > 64 * 1024);
    assert.equal(Object.hasOwn(init, 'keepalive'), false);
    const expected = Float64Array.from(cells).sort();
    const decoded = decodeSelectionBody(init.body);
    assert.equal(decoded.length, expected.length);
    for (let index = 0; index < decoded.length; index++) {
      if (decoded[index] !== expected[index]) {
        assert.fail(`cell ${index} decoded as ${decoded[index]}, expected ${expected[index]}`);
      }
    }
  });

  await t.test('invalid selections are refused before any request', async () => {
    requests.length = 0;
    for (const [cells, pattern] of [
      [new Uint32Array(0), /at least one cell/],
      [Uint32Array.of(1, 3, 3), /unique cell indices in ascending order/],
      [Uint32Array.of(3, 1), /unique cell indices in ascending order/],
      [[1, 2], /must be a cell list \(Uint32Array\)/],
    ]) {
      await assert.rejects(source.notifySelection(cells, 'lasso'), pattern);
    }
    await assert.rejects(source.notifySelection(Uint32Array.of(1), ''), /source/);
    assert.equal(requests.length, 0);
  });

  await t.test('a refused delivery names its route and status', async () => {
    globalThis.fetch = async () => new Response('Viewer is not registered', { status: 404 });
    await assert.rejects(
      source.notifySelection(Uint32Array.of(1), 'lasso'),
      /Jupyter selection delivery failed with HTTP 404/,
    );
  });
});

test('selection encoding and cell validation build no per-cell hash set', () => {
  // A JavaScript Set or Map holds at most 2^24 entries, and a selection can
  // exceed 16,777,216 cells; one of either on this path caps every selection.
  const source = readFileSync(
    new URL('../assets/js/data/jupyter-source.js', import.meta.url),
    'utf8',
  );
  const notification = readFileSync(
    new URL('../assets/js/app/ui/modules/highlight/selection-notification.js', import.meta.url),
    'utf8',
  );
  const bodyOf = (text, signature) => {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist`);
    const end = text.indexOf('\n}\n', start);
    return text.slice(start, end);
  };
  const cellSet = readFileSync(
    new URL('../assets/js/app/utils/cell-set.js', import.meta.url),
    'utf8',
  );
  for (const body of [
    bodyOf(source, 'export function encodeJupyterSelectionCells('),
    bodyOf(cellSet, 'export function cellListFrom('),
    bodyOf(notification, 'function requireDelivery('),
  ]) {
    assert.doesNotMatch(body, /new (?:Set|Map)\b/);
  }
  assert.doesNotMatch(source, /keepalive\s*:/);

  const many = new Uint32Array(17_000_000);
  for (let index = 0; index < many.length; index++) many[index] = index;
  const encoded = encodeJupyterSelectionCells(many);
  assert.equal(encoded.byteLength, many.length * 4);
  const view = new DataView(encoded.buffer);
  assert.equal(view.getUint32((many.length - 1) * 4, true), many.length - 1);
});

test('the selection wire matches the Python reader', () => {
  // Python reads the body in `cellucid.jupyter._wire` and serves the route in
  // `cellucid._server_base`; both are pinned here when the sibling checkout
  // is present.
  let wireSource = null;
  let serverSource = null;
  try {
    wireSource = readFileSync(PYTHON_WIRE_PATH, 'utf8');
    serverSource = readFileSync(new URL('../_server_base.py', PYTHON_WIRE_PATH), 'utf8');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
  if (wireSource === null || serverSource === null) return;
  assert.match(wireSource, /^_SELECTION_CELL_DTYPE = np\.dtype\("<u4"\)$/m);
  assert.match(wireSource, /np\.all\(cells\[1:\] > cells\[:-1\]\)/);
  assert.match(serverSource, /if parsed\.path != "\/_cellucid\/selection":/);
  assert.match(
    serverSource,
    /frozenset\(\{"viewerId", "viewerToken", "source"\}\)/,
  );
  assert.match(serverSource, /_require_exact_content_type\(headers, "application\/octet-stream"\)/);
});

test('the viewer publishes only event types Python accepts', async () => {
  // `_postEventToPython` is the single outbound door, and Python is the reader:
  // `_require_inbound_jupyter_event` looks the type up in `_INBOUND_EVENT_FIELDS`
  // and raises `Unknown inbound Jupyter event type` for anything else, which the
  // user sees as a kernel traceback and an HTTP 500. So the viewer may not build
  // an event type from a caller-supplied value: there is no type it could pass
  // that the reader would accept, and offering one is offering a guaranteed
  // failure. Every type in this file must be a literal from the accepted set.
  const accepted = new Set([
    'selection',
    'hover',
    'click',
    'ready',
    'pong',
    'debug_snapshot',
    'session_bundle',
    'command_error',
    'data_mapping',
  ]);

  const source = readFileSync(
    new URL('../assets/js/data/jupyter-source.js', import.meta.url),
    'utf8'
  );
  const lines = source.split('\n');
  const published = [];
  for (const [index, line] of lines.entries()) {
    const match = /(?:^|[^\w.$])type:\s*(.+?),?\s*$/.exec(line);
    if (match === null) continue;
    published.push({ line: index + 1, value: match[1] });
  }
  assert.ok(
    published.length > 0,
    'jupyter-source.js must still publish outbound event types'
  );

  for (const { line, value } of published) {
    const literal = /^'([a-z_]+)'$/.exec(value);
    assert.ok(
      literal !== null,
      `jupyter-source.js:${line} publishes a computed event type (${value}); `
        + 'Python accepts a fixed set and rejects everything else'
    );
    assert.ok(
      accepted.has(literal[1]),
      `jupyter-source.js:${line} publishes "${literal[1]}", which Python's `
        + 'inbound validator does not accept'
    );
  }

  // The accepted set above is a copy of Python's, so it is checked against the
  // original when the sibling repository is present and skipped explicitly when
  // it is not.
  let wireSource = null;
  try {
    wireSource = readFileSync(PYTHON_WIRE_PATH, 'utf8');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
  if (wireSource === null) return;
  const mapping = wireSource.slice(
    wireSource.indexOf('_INBOUND_EVENT_FIELDS: dict[str, frozenset[str]] = {'),
    wireSource.indexOf('\n}\n', wireSource.indexOf('_INBOUND_EVENT_FIELDS'))
  );
  assert.ok(mapping.length > 0, '_INBOUND_EVENT_FIELDS must still be findable');
  const declared = new Set(
    [...mapping.matchAll(/^ {4}"([a-z_]+)": frozenset\(/gm)].map(
      match => match[1]
    )
  );
  assert.deepEqual(
    [...declared].sort(),
    [...accepted].sort(),
    'the accepted event types must match cellucid-python _INBOUND_EVENT_FIELDS'
  );
});

test('Jupyter mode does not register or enumerate the unrelated demo catalog', async () => {
  const manager = new DataSourceManager();
  let jupyterAvailabilityCalls = 0;
  let jupyterListingCalls = 0;
  manager.registerSource('jupyter', {
    async isAvailable() {
      jupyterAvailabilityCalls += 1;
      return true;
    },
    async listDatasets() {
      jupyterListingCalls += 1;
      return [{ id: 'python-dataset', name: 'Python dataset' }];
    },
  });

  await manager.initialize({
    registerDemoCatalog: false,
  });

  assert.deepEqual(manager.getSourceTypes(), ['jupyter', 'link']);
  assert.deepEqual(await manager.getAllDatasets(), [{
    sourceType: 'jupyter',
    datasets: [{ id: 'python-dataset', name: 'Python dataset' }],
    error: null,
  }]);
  assert.equal(jupyterAvailabilityCalls, 1);
  assert.equal(jupyterListingCalls, 1);
  assert.equal(manager.getSource('local-demo'), null);
  assert.notEqual(manager.getSource('link'), null);
});

test('main binds bridge initialization and session upload to one captured config', () => {
  const mainSource = readFileSync(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8',
  );
  assert.match(
    mainSource,
    /const jupyterConfig = getJupyterConfig\(\);/,
  );
  assert.match(
    mainSource,
    /createJupyterBridgeDataSource\(jupyterConfig\)/,
  );
  assert.match(
    mainSource,
    /uploadJupyterSessionBundle\(\{[\s\S]*config:\s*jupyterConfig,/,
  );
});

test('Jupyter health probes are single-flight and fence late lifecycle failures', async () => {
  const probes = [];
  const failures = [];
  const clock = createDeterministicTimeoutClock();
  let activeProbeCount = 0;
  let maximumActiveProbeCount = 0;
  const monitor = createJupyterHealthMonitor({
    checkHealth() {
      activeProbeCount += 1;
      maximumActiveProbeCount = Math.max(
        maximumActiveProbeCount,
        activeProbeCount,
      );
      const operation = deferred();
      probes.push(operation);
      return operation.promise.finally(() => {
        activeProbeCount -= 1;
      });
    },
    onFailure(error) {
      failures.push(error);
    },
    intervalMs: 0,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
  });

  assert.equal(monitor.start(), true);
  assert.equal(monitor.start(), false);
  assert.equal(clock.pendingCount, 1);
  clock.runNext();
  assert.equal(probes.length, 1);
  assert.equal(monitor.isProbeInFlight(), true);
  await nextTask();
  assert.equal(probes.length, 1);
  assert.equal(clock.pendingCount, 0);

  probes[0].resolve();
  await nextTask();
  assert.equal(clock.pendingCount, 1);
  clock.runNext();
  assert.equal(probes.length, 2);
  const terminalFailure = new Error('synthetic health failure');
  probes[1].reject(terminalFailure);
  await nextTask();
  assert.equal(monitor.isFrozen(), true);
  assert.deepEqual(failures, [terminalFailure]);
  assert.equal(maximumActiveProbeCount, 1);
  await nextTask();
  assert.equal(probes.length, 2);
  assert.equal(clock.pendingCount, 0);

  const staleProbe = deferred();
  const staleFailures = [];
  const staleClock = createDeterministicTimeoutClock();
  const frozenMonitor = createJupyterHealthMonitor({
    checkHealth: () => staleProbe.promise,
    onFailure: error => {
      staleFailures.push(error);
    },
    intervalMs: 0,
    scheduleTimeout: staleClock.schedule,
    cancelTimeout: staleClock.cancel,
  });
  frozenMonitor.start();
  assert.equal(staleClock.pendingCount, 1);
  staleClock.runNext();
  assert.equal(frozenMonitor.isProbeInFlight(), true);
  assert.equal(frozenMonitor.freeze(), true);
  staleProbe.reject(new Error('late retired health failure'));
  await nextTask();
  assert.equal(frozenMonitor.isProbeInFlight(), false);
  assert.deepEqual(staleFailures, []);
  assert.equal(frozenMonitor.isFrozen(), true);
  assert.equal(staleClock.pendingCount, 0);
});

test('Jupyter hover delivery serializes sends and coalesces to the latest intent', async () => {
  const sends = [];
  const pending = [];
  let active = 0;
  let maximumActive = 0;
  const errors = [];
  const delivery = createJupyterPointerDelivery({
    notifyHover(cellIndex, position) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      sends.push({ cellIndex, position });
      const operation = deferred();
      pending.push(operation);
      return operation.promise.finally(() => {
        active -= 1;
      });
    },
    notifyClick: async () => {},
    reportError: (error, channel) => {
      errors.push({ error, channel });
    },
  });

  const first = hoverIntent('left', 1);
  const intermediate = hoverIntent('right', 2);
  const latest = hoverIntent('right', 3);
  assert.equal(delivery.requestHover(first), true);
  assert.equal(delivery.requestHover(intermediate), true);
  assert.equal(delivery.requestHover(latest), true);
  assert.equal(delivery.requestHover(latest), false);
  assert.deepEqual(sends.map(send => send.cellIndex), [1]);

  pending[0].resolve();
  await nextTask();
  assert.deepEqual(sends.map(send => send.cellIndex), [1, 3]);
  pending[1].resolve();
  await delivery.whenIdle();

  assert.equal(maximumActive, 1);
  assert.deepEqual(sends.map(send => send.cellIndex), [1, 3]);
  assert.equal(delivery.requestHover(latest), false);
  assert.deepEqual(errors, []);
});

test('Jupyter hover preserves a final leave while an older hover is in flight', async () => {
  const sends = [];
  const pending = [];
  const delivery = createJupyterPointerDelivery({
    notifyHover(cellIndex, position) {
      sends.push({ cellIndex, position });
      const operation = deferred();
      pending.push(operation);
      return operation.promise;
    },
    notifyClick: async () => {},
    reportError: error => {
      throw error;
    },
  });

  delivery.requestHover(hoverIntent('pane', 8));
  delivery.requestHover(hoverIntent('pane', 9));
  delivery.requestHover(null);
  assert.deepEqual(sends.map(send => send.cellIndex), [8]);
  pending[0].resolve();
  await nextTask();
  assert.deepEqual(sends.map(send => send.cellIndex), [8, null]);
  pending[1].resolve();
  await delivery.whenIdle();
  assert.deepEqual(sends.map(send => send.cellIndex), [8, null]);
});

test('a repeated in-flight Jupyter hover delivers exactly once after success', async () => {
  const sends = [];
  const operation = deferred();
  const delivery = createJupyterPointerDelivery({
    notifyHover(cellIndex) {
      sends.push(cellIndex);
      return operation.promise;
    },
    notifyClick: async () => {},
    reportError: error => {
      throw error;
    },
  });
  const intent = hoverIntent('pane', 12);

  assert.equal(delivery.requestHover(intent), true);
  assert.equal(delivery.requestHover(intent), true);
  assert.deepEqual(sends, [12]);
  operation.resolve();
  await delivery.whenIdle();
  assert.deepEqual(sends, [12]);
  assert.equal(delivery.requestHover(intent), false);
});

test('failed Jupyter hover remains retryable and commits deduplication only on success', async () => {
  const attempts = [];
  const errors = [];
  const firstFailure = new Error('synthetic hover delivery failure');
  const firstAttempt = deferred();
  const retryAttempt = deferred();
  const delivery = createJupyterPointerDelivery({
    notifyHover(cellIndex) {
      attempts.push(cellIndex);
      return attempts.length === 1
        ? firstAttempt.promise
        : retryAttempt.promise;
    },
    notifyClick: async () => {},
    reportError: (error, channel) => {
      errors.push({ error, channel });
    },
  });
  const intent = hoverIntent('pane', 5);

  assert.equal(delivery.requestHover(intent), true);
  // A duplicate arriving before settlement remains pending. Success would
  // deduplicate it; failure must retry it.
  assert.equal(delivery.requestHover(intent), true);
  assert.deepEqual(attempts, [5]);
  firstAttempt.reject(firstFailure);
  await nextTask();
  assert.deepEqual(attempts, [5, 5]);
  retryAttempt.resolve();
  await delivery.whenIdle();
  assert.deepEqual(errors, [{
    error: firstFailure,
    channel: 'hover',
  }]);

  assert.deepEqual(attempts, [5, 5]);
  assert.equal(delivery.requestHover(intent), false);
});

test('Jupyter click delivery preserves exact FIFO order across deferred sends', async () => {
  const starts = [];
  const pending = [];
  const delivery = createJupyterPointerDelivery({
    notifyHover: async () => {},
    notifyClick(cellIndex, modifiers) {
      starts.push({ cellIndex, modifiers });
      const operation = deferred();
      pending.push(operation);
      return operation.promise;
    },
    reportError: error => {
      throw error;
    },
  });

  assert.throws(
    () => delivery.requestClick({
      cellIndex: 9,
      button: 3,
      shift: false,
      ctrl: false,
    }),
    /button/i,
  );
  for (const cellIndex of [4, 2, 7]) {
    assert.equal(delivery.requestClick({
      cellIndex,
      button: 0,
      shift: cellIndex === 2,
      ctrl: cellIndex === 7,
    }), true);
  }
  assert.deepEqual(starts.map(entry => entry.cellIndex), [4]);
  pending[0].resolve();
  await nextTask();
  assert.deepEqual(starts.map(entry => entry.cellIndex), [4, 2]);
  pending[1].resolve();
  await nextTask();
  assert.deepEqual(starts.map(entry => entry.cellIndex), [4, 2, 7]);
  pending[2].resolve();
  await delivery.whenIdle();
  assert.deepEqual(
    starts.map(entry => entry.modifiers),
    [
      { button: 0, shift: false, ctrl: false },
      { button: 0, shift: true, ctrl: false },
      { button: 0, shift: false, ctrl: true },
    ],
  );
});

test('Jupyter pointer freeze fences queued and future lifecycle work', async () => {
  const hoverStarts = [];
  const clickStarts = [];
  const hoverFirst = deferred();
  const clickFirst = deferred();
  const delivery = createJupyterPointerDelivery({
    notifyHover(cellIndex) {
      hoverStarts.push(cellIndex);
      return hoverFirst.promise;
    },
    notifyClick(cellIndex) {
      clickStarts.push(cellIndex);
      return clickFirst.promise;
    },
    reportError: error => {
      throw error;
    },
  });

  delivery.requestHover(hoverIntent('pane', 1));
  delivery.requestHover(hoverIntent('pane', 2));
  delivery.requestClick({
    cellIndex: 3,
    button: 0,
    shift: false,
    ctrl: false,
  });
  delivery.requestClick({
    cellIndex: 4,
    button: 0,
    shift: false,
    ctrl: false,
  });
  assert.equal(delivery.freeze(), true);
  assert.equal(delivery.freeze(), false);
  assert.equal(delivery.isFrozen(), true);
  assert.equal(delivery.requestHover(null), false);
  assert.equal(delivery.requestClick({
    cellIndex: 5,
    button: 0,
    shift: false,
    ctrl: false,
  }), false);

  hoverFirst.resolve();
  clickFirst.resolve();
  await delivery.whenIdle();
  assert.deepEqual(hoverStarts, [1]);
  assert.deepEqual(clickStarts, [3]);
});

test('Jupyter pointer hooks use per-view pick records without changing wire payloads', () => {
  const mainSource = readFileSync(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8',
  );
  assert.match(
    mainSource,
    /viewer\.pickCellRecordAtScreen\(\s*event\.clientX,\s*event\.clientY\s*\)/,
  );
  assert.match(
    mainSource,
    /createJupyterPointerDelivery\(\{/,
  );
  assert.match(
    mainSource,
    /jupyterPointerDelivery\.requestHover\(pickRecord\)/,
  );
  assert.match(
    mainSource,
    /jupyterPointerDelivery\.requestClick\(\{\s*cellIndex:\s*pickRecord\.cellIndex,/,
  );
  assert.match(
    mainSource,
    /jupyterPointerDelivery\?\.freeze\(\)/,
  );
  assert.match(
    mainSource,
    /createJupyterHealthMonitor\(\{[\s\S]*checkHealth:\s*\(\)\s*=>\s*jupyterSource\.checkHealth\(\)/,
  );
  assert.doesNotMatch(
    mainSource,
    /setInterval\(\s*async\s*\(\)\s*=>[\s\S]*checkHealth/,
  );
  assert.doesNotMatch(
    mainSource,
    /getCellPosition\([^)]*,\s*['"]live['"]\)/,
  );
  assert.match(
    mainSource,
    /const retireJupyterView = event => \{\s*if \(event\.persisted === true\) return;\s*window\.removeEventListener\('pagehide', retireJupyterView\);\s*freezeJupyterView\(\);\s*\};\s*window\.addEventListener\('pagehide', retireJupyterView\);/,
  );
  assert.doesNotMatch(
    mainSource,
    /freezeJupyterView\(\);\s*\},\s*\{ once: true \}/,
  );

  const freezeStart = mainSource.indexOf(
    'const freezeJupyterView = () => {',
  );
  const freezeEnd = mainSource.indexOf(
    '\n      };',
    freezeStart,
  );
  const freezeSource = mainSource.slice(freezeStart, freezeEnd);
  assert.ok(freezeStart >= 0 && freezeEnd > freezeStart);
  assert.ok(
    freezeSource.indexOf('jupyterFrozen = true;') <
      freezeSource.indexOf('retireJupyterPointerInputs()'),
  );
  assert.ok(
    freezeSource.indexOf('jupyterFrozen = true;') <
      freezeSource.indexOf('viewer.pause()'),
  );

  const healthFailureStart = mainSource.indexOf(
    'onFailure: error => {',
    freezeEnd,
  );
  const healthFailureEnd = mainSource.indexOf(
    '\n        },',
    healthFailureStart,
  );
  const healthFailureSource = mainSource.slice(
    healthFailureStart,
    healthFailureEnd,
  );
  assert.ok(
    healthFailureSource.indexOf('freezeJupyterView();') <
      healthFailureSource.indexOf('notifications.error('),
  );
});

test('Jupyter command failure names the command for the person watching', () => {
  assert.deepEqual(
    describeJupyterCommandFailure(
      'setColorBy',
      new Error('Jupyter set-color-by command requires exactly one field "CD8A"'),
    ),
    {
      title: 'Notebook command failed',
      message:
        'The notebook "setColorBy" command did not run: Jupyter set-color-by ' +
        'command requires exactly one field "CD8A". The viewer is unchanged; ' +
        'correct the notebook cell and run it again.',
    },
  );

  assert.equal(
    describeJupyterCommandFailure(null, new Error('boom')).message,
    'A notebook command did not run: boom. The viewer is unchanged; ' +
    'correct the notebook cell and run it again.',
  );

  // A thrown non-Error, or an Error with no message, still produces text a
  // reader can act on rather than an empty or "undefined" notification.
  for (const thrown of [new Error(''), 'plain string', null, undefined, { a: 1 }]) {
    assert.equal(
      describeJupyterCommandFailure('highlight', thrown).message,
      'The notebook "highlight" command did not run: the viewer reported no ' +
      'reason. The viewer is unchanged; correct the notebook cell and run it ' +
      'again.',
    );
  }

  // Newlines and stack-shaped text are collapsed, and an unbounded message is
  // truncated so one failure cannot fill the notification surface.
  assert.equal(
    describeJupyterCommandFailure(
      'highlight',
      new Error('first line\n  second line\tthird'),
    ).message.startsWith(
      'The notebook "highlight" command did not run: first line second line third.',
    ),
    true,
  );
  const truncated = describeJupyterCommandFailure(
    'highlight',
    new Error('x'.repeat(4000)),
  ).message;
  assert.equal(truncated.includes(`${'x'.repeat(239)}…`), true);
  assert.equal(truncated.includes('x'.repeat(241)), false);

  // Only recognised command types may be named.
  assert.throws(
    () => describeJupyterCommandFailure('notACommand', new Error('boom')),
    /one recognised command or null/,
  );
});

test('Jupyter command labels are drawn from the exact command set', () => {
  for (const type of [
    'ping',
    'debug_snapshot',
    'highlight',
    'setColorBy',
    'setVisibility',
    'clearHighlights',
    'resetCamera',
    'freeze',
    'requestSessionBundle',
    'setDataMapping',
  ]) {
    assert.equal(describeJupyterCommandType({ type }), type);
  }
  for (const data of [
    { type: 'javascript:alert(1)' },
    { type: '__proto__' },
    { type: 'constructor' },
    { type: '' },
    { type: 7 },
    { type: ['highlight'] },
    {},
    null,
    'highlight',
    ['highlight'],
  ]) {
    assert.equal(describeJupyterCommandType(data), null);
  }
});

test(
  'A failed notebook command is announced in the viewer, not only the console',
  async t => {
    const runtime = installWindow(
      '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
    );
    const posted = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/_cellucid/events')) {
        posted.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ status: 'ok', delivered: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jupyterHealthResponse();
    };
    const source = new JupyterBridgeDataSource(getJupyterConfig());
    await source.initialize();

    const notifications = getNotificationCenter();
    const originalNotify = notifications.error;
    const originalConsoleError = console.error;
    const raised = [];
    const logged = [];
    notifications.error = (message, options) => {
      raised.push({ message, options });
      return 'jupyter-command-failure-test';
    };
    console.error = (...args) => {
      logged.push(args);
    };
    t.after(() => {
      notifications.error = originalNotify;
      console.error = originalConsoleError;
      source.disconnect();
    });

    // The real case: `viewer.set_color_by("CD8A")` in a notebook. The Python
    // wire check accepts it, the browser handler is the first thing that can
    // reject it, and the protocol has no reply channel to tell the notebook.
    source.onMessage(message => {
      if (message.type === 'setColorBy') {
        throw new Error(
          'Jupyter set-color-by command requires exactly one field "CD8A"',
        );
      }
      if (message.type === 'javascript:alert(1)') {
        throw new Error('no handler accepted this command');
      }
    });

    // Must not throw out of the window `message` listener.
    runtime.dispatch('message', {
      data: {
        type: 'setColorBy',
        field: 'CD8A',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: runtime.parent,
    });

    assert.equal(raised.length, 1);
    assert.equal(
      raised[0].message,
      'The notebook "setColorBy" command did not run: Jupyter set-color-by ' +
      'command requires exactly one field "CD8A". The viewer is unchanged; ' +
      'correct the notebook cell and run it again.',
    );
    assert.deepEqual(raised[0].options, {
      category: 'connectivity',
      title: 'Notebook command failed',
      duration: 0,
    });
    // The developer trace is kept alongside the user-facing notice.
    assert.equal(logged.length, 1);
    assert.match(logged[0][0], /^\[JupyterBridge\] The notebook "setColorBy"/);
    // The notebook lists command_error in /_cellucid/protocol, so it learns
    // the failure too, with the same bounded reason.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(posted.map(event => [event.type, event.command, event.reason]), [[
      'command_error',
      'setColorBy',
      'Jupyter set-color-by command requires exactly one field "CD8A"',
    ]]);
    posted.length = 0;

    // An asynchronous rejection reaches the same surface.
    raised.length = 0;
    logged.length = 0;
    source.onHighlight(() => Promise.reject(new Error('highlight page missing')));
    runtime.dispatch('message', {
      data: {
        type: 'highlight',
        cells: [1, 2, 3],
        color: '#ff0000',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: runtime.parent,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(raised.length, 1);
    assert.match(
      raised[0].message,
      /^The notebook "highlight" command did not run: highlight page missing\./,
    );

    // An unrecognised command type is never echoed into the notification.
    raised.length = 0;
    runtime.dispatch('message', {
      data: {
        type: 'javascript:alert(1)',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: runtime.parent,
    });
    assert.equal(raised.length, 1);
    assert.match(raised[0].message, /^A notebook command did not run:/);
    assert.equal(raised[0].message.includes('javascript:alert(1)'), false);

    // A type that fails the message check itself is reported the same way,
    // and its raw text stays out of the notification surface.
    raised.length = 0;
    runtime.dispatch('message', {
      data: {
        type: '<img src=x onerror=alert(1)>',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: runtime.parent,
    });
    assert.equal(raised.length, 1);
    assert.match(raised[0].message, /^A notebook command did not run:/);
    assert.equal(raised[0].message.includes('onerror'), false);

    // Reporting is last-resort: a notification surface that is itself broken
    // must not turn the message listener into a thrown failure.
    raised.length = 0;
    logged.length = 0;
    notifications.error = () => {
      throw new Error('notification surface unavailable');
    };
    runtime.dispatch('message', {
      data: {
        type: 'setColorBy',
        field: 'CD8A',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: runtime.parent,
    });
    assert.equal(raised.length, 0);
    assert.equal(logged.length, 2);
    assert.match(
      logged[1][0],
      /^\[JupyterBridge\] Notebook command failure notice failed:/,
    );
  },
);

test('the protocol fixture is cellucid-python\'s published document', () => {
  let wireSource = null;
  try {
    wireSource = readFileSync(PYTHON_WIRE_PATH, 'utf8');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
  if (wireSource === null) return;
  const names = declaration => {
    const start = wireSource.indexOf(`${declaration}: dict[str, frozenset[str]] = {`);
    assert.ok(start >= 0, `${declaration} must still be findable`);
    const body = wireSource.slice(start, wireSource.indexOf('\n}\n', start));
    return [...body.matchAll(/^ {4}"([A-Za-z_]+)": frozenset\(/gm)].map(match => match[1]).sort();
  };
  assert.deepEqual(names('_INBOUND_EVENT_FIELDS'), [...CURRENT_PROTOCOL.events].sort());
  assert.deepEqual(names('_COMMAND_MESSAGE_FIELDS'), [...CURRENT_PROTOCOL.commands].sort());
});

function protocolServer(protocolResponse, posted = []) {
  return async (url, init = {}) => {
    const text = String(url);
    if (text.endsWith('/_cellucid/health')) return jupyterHealthResponse();
    if (text.endsWith('/_cellucid/protocol')) return protocolResponse();
    if (text.endsWith('/_cellucid/events')) {
      posted.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ status: 'ok', delivered: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${text}`);
  };
}

const REPORTED_MAPPING = Object.freeze({
  kind: 'anndata',
  embeddings: {
    enabled: [{ key: 'X_umap', columns: [0, 1] }],
    defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
  },
  knn: 'connectivities',
  geneNames: 'index',
  expression: 'X',
  latent: null,
  vectorFields: [],
});

test('initialization reads the notebook protocol and gates events on it', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  t.after(() => {
    protocolFixture.passthrough = false;
  });
  const posted = [];
  const requested = [];
  const server = protocolServer(() => new Response(JSON.stringify(CURRENT_PROTOCOL), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }), posted);
  globalThis.fetch = async (url, init) => {
    requested.push(String(url));
    return server(url, init);
  };
  const source = new JupyterBridgeDataSource(getJupyterConfig());
  assert.equal(await source.initialize(), true);
  assert.deepEqual(requested, [
    'http://127.0.0.1:8765/viewer/_cellucid/health',
    'http://127.0.0.1:8765/viewer/_cellucid/protocol',
  ]);
  assert.equal(source.acceptsEvent('data_mapping'), true);
  assert.equal(
    await source.notifyDataMapping({ origin: 'user', requestId: null, mapping: REPORTED_MAPPING }),
    true
  );
  assert.equal(
    await source.notifyDataMapping({ origin: 'notebook', requestId: 'req-9', mapping: REPORTED_MAPPING }),
    true
  );
  assert.deepEqual(posted.map(event => [event.type, event.origin, event.requestId]), [
    ['data_mapping', 'user', null],
    ['data_mapping', 'notebook', 'req-9'],
  ]);
  assert.deepEqual(posted[0].mapping, REPORTED_MAPPING);
  await assert.rejects(
    source.notifyDataMapping({ origin: 'notebook', requestId: null, mapping: REPORTED_MAPPING }),
    /requestId/
  );
  await assert.rejects(
    source.notifyDataMapping({ origin: 'user', requestId: 'req-1', mapping: REPORTED_MAPPING }),
    /requestId must be null/
  );
  await assert.rejects(
    source.notifyDataMapping({ origin: 'url', requestId: null, mapping: REPORTED_MAPPING }),
    /origin must be one of/
  );
  source.disconnect();
});

test('a notebook server without the protocol route accepts no new event', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  t.after(() => {
    protocolFixture.passthrough = false;
  });
  const posted = [];
  globalThis.fetch = protocolServer(() => new Response('missing', { status: 404 }), posted);
  const source = new JupyterBridgeDataSource(getJupyterConfig());
  assert.equal(await source.initialize(), true);
  assert.equal(source.acceptsEvent('data_mapping'), false);
  assert.equal(source.acceptsEvent('command_error'), false);
  assert.equal(
    await source.notifyDataMapping({ origin: 'default', requestId: null, mapping: REPORTED_MAPPING }),
    false
  );
  assert.deepEqual(posted, []);
  source.disconnect();
});

test('a malformed protocol document fails initialization', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  t.after(() => {
    protocolFixture.passthrough = false;
  });
  for (const body of [
    { events: ['ready'] },
    { events: ['ready', 'ready'], commands: [] },
    { events: ['ready'], commands: [7] },
    { events: 'ready', commands: [] },
    { events: [], commands: [], version: '1' },
  ]) {
    globalThis.fetch = protocolServer(() => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const source = new JupyterBridgeDataSource(getJupyterConfig());
    await assert.rejects(source.initialize(), /Jupyter protocol/);
    assert.equal(source.isConnected(), false);
  }
  globalThis.fetch = protocolServer(() => new Response('down', { status: 503 }));
  const source = new JupyterBridgeDataSource(getJupyterConfig());
  await assert.rejects(source.initialize(), /HTTP 503/);
});

test('setDataMapping is validated before delivery, and a failure reaches the notebook', async t => {
  const runtime = installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  const notifications = getNotificationCenter();
  const originalNotify = notifications.error;
  const originalConsoleError = console.error;
  notifications.error = () => 'notice';
  console.error = () => {};
  t.after(() => {
    protocolFixture.passthrough = false;
    notifications.error = originalNotify;
    console.error = originalConsoleError;
  });
  const posted = [];
  globalThis.fetch = protocolServer(() => new Response(JSON.stringify(CURRENT_PROTOCOL), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }), posted);
  const source = new JupyterBridgeDataSource(getJupyterConfig());
  await source.initialize();
  const delivered = [];
  source.onMessage(message => {
    delivered.push(message);
    if (message.type === 'setDataMapping') {
      throw new RangeError("obsp['distances'] is not symmetric — choose a connectivities matrix");
    }
  });
  const send = data => runtime.dispatch('message', {
    data: { ...data, viewerId: 'viewer-1', viewerToken: 'secret-1' },
    origin: 'https://notebook.example',
    source: runtime.parent,
  });
  // A mapping that is not canonical never reaches a handler.
  send({ type: 'setDataMapping', requestId: 'req-1', mapping: { kind: 'anndata' } });
  assert.equal(delivered.length, 0);
  send({ type: 'setDataMapping', requestId: 'req-2', mapping: REPORTED_MAPPING, extra: 1 });
  assert.equal(delivered.length, 0);
  send({ type: 'setDataMapping', requestId: 'req-3', mapping: REPORTED_MAPPING });
  assert.equal(delivered.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    posted.map(event => [event.type, event.command]),
    [
      ['command_error', 'setDataMapping'],
      ['command_error', 'setDataMapping'],
      ['command_error', 'setDataMapping'],
    ]
  );
  assert.match(posted[2].reason, /not symmetric/);
  source.disconnect();
});
