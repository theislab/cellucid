import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  JupyterBridgeDataSource,
  getJupyterConfig,
  uploadJupyterSessionBundle,
} from '../assets/js/data/jupyter-source.js';
import {
  createDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  createJupyterHealthMonitor,
  createJupyterPointerDelivery,
} from '../assets/js/app/jupyter-pointer-delivery.js';

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
    type: 'exported',
    version: '1.0.0',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CURRENT_IDENTITY = JSON.parse(readFileSync(
  new URL(
    './browser/fixtures/exports/current-ui-prepared/dataset_identity.json',
    import.meta.url,
  ),
  'utf8',
));

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
      is_backed: false,
      n_cells: 120,
      n_genes: 6,
    }), { status: 200 });
    const source = new JupyterBridgeDataSource();
    assert.equal(await source.initialize(), true);
  });

  for (const [name, payload] of [
    ['fabricated type', { status: 'ok', type: 'prepared', version: '1.2.3' }],
    ['missing version', { status: 'ok', type: 'exported' }],
    ['AnnData default field missing', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData numeric coercion', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      is_backed: false,
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
      type: 'selection',
      cells: [1, 2],
    });
    assert.equal(
      captured.url,
      'http://127.0.0.1:8765/viewer/_cellucid/events',
    );
    assert.deepEqual(JSON.parse(captured.init.body), {
      type: 'selection',
      cells: [1, 2],
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    });
  });

  await t.test('server rejection', async () => {
    globalThis.fetch = async () => new Response('denied', { status: 403 });
    await assert.rejects(
      source._postEventToPython({ type: 'selection', cells: [] }),
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
    type: 'exported',
    version: '1.0.0',
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
    source._reportMessageFailure = error => {
      reported.push(error);
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
    assert.deepEqual(reported, [failure]);
    source.disconnect();
  },
);

test('Jupyter dataset listing rejects server and metadata failures atomically', async t => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  source._datasetPaths.set('retained', '/retained/');
  source._datasetCache.set('retained', { id: 'retained' });

  await t.test('HTTP failure', async () => {
    globalThis.fetch = async () => new Response('down', { status: 503 });
    await assert.rejects(source.listDatasets(), /dataset listing.*503/i);
    assert.equal(source._datasetPaths.get('retained'), '/retained/');
    assert.deepEqual(source._datasetCache.get('retained'), { id: 'retained' });
  });

  await t.test('metadata failure', async () => {
    globalThis.fetch = async url => {
      if (String(url).endsWith('/_cellucid/datasets')) {
        return new Response(JSON.stringify({
          datasets: [{ id: 'current', path: '/current/', name: 'Current' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('broken metadata', { status: 500 });
    };
    await assert.rejects(
      source.listDatasets(),
      error => error?.details?.status === 500
    );
    assert.equal(source._datasetPaths.get('retained'), '/retained/');
    assert.equal(source._datasetPaths.has('current'), false);
    assert.deepEqual(source._datasetCache.get('retained'), { id: 'retained' });
  });
});

test('Jupyter dataset listing rejects noncanonical entries before metadata work', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      datasets: [{ id: 'current', name: 'Current' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await assert.rejects(source.listDatasets(), /dataset.*path/i);
  assert.equal(calls, 1);
});

test('Jupyter dataset listing publishes one complete exact generation', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  source._datasetPaths.set('retained', '/retained/');
  source._datasetCache.set('retained', { id: 'retained' });
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/_cellucid/datasets')) {
      return new Response(JSON.stringify({
        datasets: [{
          id: CURRENT_IDENTITY.id,
          path: '/current-ui-prepared/',
          name: CURRENT_IDENTITY.name,
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify(CURRENT_IDENTITY), { status: 200 });
  };

  const datasets = await source.listDatasets();
  assert.deepEqual(datasets, [CURRENT_IDENTITY]);
  assert.deepEqual(calls, [
    'http://127.0.0.1:8765/viewer/_cellucid/datasets',
    'http://127.0.0.1:8765/viewer/current-ui-prepared/dataset_identity.json',
  ]);
  assert.deepEqual(
    [...source._datasetPaths],
    [[CURRENT_IDENTITY.id, '/current-ui-prepared/']],
  );
  assert.equal(source._datasetCache.get(CURRENT_IDENTITY.id), datasets[0]);
  assert.equal(
    source.getBaseUrl(CURRENT_IDENTITY.id),
    'jupyter://viewer-1/current-ui-prepared/',
  );
  assert.equal(
    await source.resolveUrl(
      'jupyter://viewer-1/current-ui-prepared/points_2d.bin',
    ),
    'http://127.0.0.1:8765/viewer/current-ui-prepared/points_2d.bin',
  );
  assert.throws(
    () => source.getBaseUrl('undeclared'),
    /not declared/i,
  );
  await assert.rejects(
    source.resolveUrl(
      'jupyter://other-viewer/current-ui-prepared/points_2d.bin',
    ),
    /viewer id/i,
  );
  assert.equal(
    await source.resolveUrl(
      'jupyter://viewer-1/current-ui-prepared/nested%20artifact.bin',
    ),
    'http://127.0.0.1:8765/viewer/current-ui-prepared/nested%20artifact.bin',
  );
  for (const url of [
    'jupyter://viewer-1/%2e%2e/private.json',
    'jupyter://viewer-1/%252e%252e/private.json',
    'jupyter://viewer-1/current-ui-prepared/%2fprivate.json',
    'jupyter://viewer-1/current-ui-prepared/%255cprivate.json',
    'jupyter://viewer-1/retired/private.json',
  ]) {
    await assert.rejects(
      source.resolveUrl(url),
      /invalid Jupyter artifact path|currently declared dataset/i,
      url,
    );
  }
});

test('Jupyter catalog and identity names must agree exactly', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/_cellucid/datasets')) {
      return new Response(JSON.stringify({
        datasets: [{
          id: CURRENT_IDENTITY.id,
          path: '/current-ui-prepared/',
          name: 'Contradictory catalog name',
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify(CURRENT_IDENTITY), {
      status: 200,
    });
  };

  await assert.rejects(
    source.listDatasets(),
    /catalog name.*does not match.*dataset_identity/i,
  );
  assert.deepEqual([...source._datasetPaths], []);
  assert.deepEqual([...source._datasetCache], []);
});

test('Jupyter listing aborts and drains metadata siblings after one exact failure', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  let heldSignal = null;
  let heldSettled = false;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/_cellucid/datasets')) {
      return new Response(JSON.stringify({
        datasets: [
          { id: 'invalid', path: '/invalid/', name: 'Invalid' },
          { id: 'held', path: '/held/', name: 'Held' },
        ],
      }), { status: 200 });
    }
    if (url.endsWith('/invalid/dataset_identity.json')) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.endsWith('/held/dataset_identity.json')) {
      heldSignal = options.signal ?? null;
      return new Promise((_resolve, reject) => {
        heldSignal.addEventListener('abort', () => {
          heldSettled = true;
          reject(heldSignal.reason);
        }, { once: true });
      });
    }
    return new Response('', { status: 404 });
  };

  await assert.rejects(
    source.listDatasets(),
    /dataset_identity|missing required field/i,
  );
  assert.ok(heldSignal instanceof AbortSignal);
  assert.equal(heldSignal.aborted, true);
  assert.equal(heldSettled, true);
});

test('concurrent Jupyter metadata reads coalesce within one catalog owner', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  source._datasetPaths.set(
    CURRENT_IDENTITY.id,
    '/current-ui-prepared/',
  );
  let identityCalls = 0;
  let releaseIdentity;
  const identityResponse = new Promise(resolve => {
    releaseIdentity = resolve;
  });
  globalThis.fetch = async () => {
    identityCalls += 1;
    return identityResponse;
  };

  const first = source.getMetadata(CURRENT_IDENTITY.id);
  const second = source.getMetadata(CURRENT_IDENTITY.id);
  assert.equal(identityCalls, 1);
  releaseIdentity(new Response(JSON.stringify(CURRENT_IDENTITY), {
    status: 200,
  }));
  const [firstMetadata, secondMetadata] = await Promise.all([
    first,
    second,
  ]);
  assert.equal(firstMetadata, secondMetadata);
  assert.equal(
    await source.getMetadata(CURRENT_IDENTITY.id),
    firstMetadata,
  );
  assert.equal(identityCalls, 1);
});

test('coalesced Jupyter metadata callers share one lifecycle cancellation', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  source._datasetPaths.set(
    CURRENT_IDENTITY.id,
    '/current-ui-prepared/',
  );
  let metadataSignal = null;
  globalThis.fetch = async (_input, options = {}) => {
    metadataSignal = options.signal ?? null;
    return new Promise((_resolve, reject) => {
      metadataSignal.addEventListener('abort', () => {
        reject(metadataSignal.reason);
      }, { once: true });
    });
  };

  const first = source.getMetadata(CURRENT_IDENTITY.id);
  const second = source.getMetadata(CURRENT_IDENTITY.id);
  assert.ok(metadataSignal instanceof AbortSignal);
  source.refresh();

  const [firstOutcome, secondOutcome] = await Promise.allSettled([
    first,
    second,
  ]);
  assert.equal(firstOutcome.status, 'rejected');
  assert.equal(secondOutcome.status, 'rejected');
  assert.equal(firstOutcome.reason, secondOutcome.reason);
  assert.equal(
    firstOutcome.reason.code,
    'CELLUCID_JUPYTER_LIFECYCLE_SUPERSEDED',
  );
  assert.match(firstOutcome.reason.message, /superseded/i);
  assert.equal(source._datasetCache.has(CURRENT_IDENTITY.id), false);
});

test(
  'Jupyter dataset listings cannot publish across reconnect or a newer listing',
  async t => {
    await t.test('reconnect retirement', async () => {
      installWindow(
        '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
      );
      const source = new JupyterBridgeDataSource(getJupyterConfig());
      globalThis.fetch = async () => jupyterHealthResponse();
      await source.initialize();

      const staleCatalog = deferred();
      let staleCatalogSignal = null;
      globalThis.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/_cellucid/datasets')) {
          staleCatalogSignal = init.signal ?? null;
          return staleCatalog.promise;
        }
        throw new Error(`Unexpected stale-listing URL: ${String(url)}`);
      };
      const staleListing = source.listDatasets();
      const staleRejection = assert.rejects(
        staleListing,
        /superseded|connection/i,
      );

      source.disconnect();
      assert.ok(staleCatalogSignal instanceof AbortSignal);
      assert.equal(staleCatalogSignal.aborted, true);
      globalThis.fetch = async url => {
        if (String(url).endsWith('/_cellucid/health')) {
          return jupyterHealthResponse();
        }
        if (String(url).endsWith('/dataset_identity.json')) {
          return new Response(JSON.stringify(CURRENT_IDENTITY), {
            status: 200,
          });
        }
        throw new Error(`Unexpected reconnected URL: ${String(url)}`);
      };
      assert.equal(await source.initialize(), true);

      staleCatalog.resolve(new Response(JSON.stringify({
        datasets: [{
          id: CURRENT_IDENTITY.id,
          path: '/current-ui-prepared/',
          name: CURRENT_IDENTITY.name,
        }],
      }), { status: 200 }));
      await staleRejection;
      assert.deepEqual([...source._datasetPaths], []);
      assert.deepEqual([...source._datasetCache], []);
      source.disconnect();
    });

    await t.test('newest listing ownership', async () => {
      installWindow(
        '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
      );
      const source = new JupyterBridgeDataSource(getJupyterConfig());
      globalThis.fetch = async () => jupyterHealthResponse();
      await source.initialize();

      const firstCatalog = deferred();
      const secondCatalog = deferred();
      const firstIdentity = {
        ...CURRENT_IDENTITY,
        id: 'first',
        name: 'First',
      };
      const secondIdentity = {
        ...CURRENT_IDENTITY,
        id: 'second',
        name: 'Second',
      };
      let catalogCalls = 0;
      const catalogSignals = [];
      globalThis.fetch = async (url, init = {}) => {
        const href = String(url);
        if (href.endsWith('/_cellucid/datasets')) {
          catalogCalls += 1;
          catalogSignals.push(init.signal ?? null);
          return catalogCalls === 1
            ? firstCatalog.promise
            : secondCatalog.promise;
        }
        if (href.endsWith('/first/dataset_identity.json')) {
          return new Response(JSON.stringify(firstIdentity), { status: 200 });
        }
        if (href.endsWith('/second/dataset_identity.json')) {
          return new Response(JSON.stringify(secondIdentity), { status: 200 });
        }
        throw new Error(`Unexpected concurrent-listing URL: ${href}`);
      };

      const firstListing = source.listDatasets();
      const firstRejection = assert.rejects(
        firstListing,
        /superseded/i,
      );
      const secondListing = source.listDatasets();
      assert.ok(catalogSignals[0] instanceof AbortSignal);
      assert.equal(catalogSignals[0].aborted, true);
      secondCatalog.resolve(new Response(JSON.stringify({
        datasets: [{
          id: 'second',
          path: '/second/',
          name: 'Second',
        }],
      }), { status: 200 }));
      assert.deepEqual(await secondListing, [secondIdentity]);

      firstCatalog.resolve(new Response(JSON.stringify({
        datasets: [{
          id: 'first',
          path: '/first/',
          name: 'First',
        }],
      }), { status: 200 }));
      await firstRejection;
      assert.deepEqual([...source._datasetPaths], [['second', '/second/']]);
      assert.equal(source._datasetCache.get('second').id, 'second');
      assert.equal(source._datasetCache.has('first'), false);
      source.disconnect();
    });

    await t.test('metadata cache refresh retirement', async () => {
      installWindow(
        '?jupyter=true&viewerId=viewer-1&viewerToken=secret-1',
      );
      const source = new JupyterBridgeDataSource(getJupyterConfig());
      globalThis.fetch = async () => jupyterHealthResponse();
      await source.initialize();
      source._datasetPaths.set(
        CURRENT_IDENTITY.id,
        '/current-ui-prepared/',
      );

      const identity = deferred();
      let metadataSignal = null;
      globalThis.fetch = async (_url, init = {}) => {
        metadataSignal = init.signal ?? null;
        return identity.promise;
      };
      const metadata = source.getMetadata(CURRENT_IDENTITY.id);
      const rejection = assert.rejects(metadata, /superseded/i);
      source.refresh();
      assert.ok(metadataSignal instanceof AbortSignal);
      assert.equal(metadataSignal.aborted, true);
      identity.resolve(new Response(JSON.stringify(CURRENT_IDENTITY), {
        status: 200,
      }));
      await rejection;
      assert.equal(source._datasetCache.has(CURRENT_IDENTITY.id), false);
      source.disconnect();
    });
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
        cells: [1, 1],
        color: '#ff0000',
        viewerId: 'viewer-1',
        viewerToken: 'secret-1',
      },
      origin: 'https://notebook.example',
      source: window.parent,
    }),
    /duplicate/i,
  );
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
  await assert.rejects(source.notifySelection([1, 2]), /source/i);
});

test('Jupyter browser notifications publish only exact current payloads', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
  source._connected = true;
  const delivered = [];
  globalThis.fetch = async (_url, init) => {
    delivered.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ status: 'ok', delivered: true }),
      { status: 200 },
    );
  };

  await source.notifySelection([1, 2], 'lasso');
  await source.notifyHover(1, { x: 1, y: 2, z: 3 });
  await source.notifyHover(null, null);
  await source.notifyClick(2, {
    button: 0,
    shift: false,
    ctrl: true,
  });
  await source.notifyReady({ nCells: 120, dimensions: 2 });
  await source.notifyCustomEvent('analysis', { result: 7 });

  assert.deepEqual(delivered.map(event => event.type), [
    'selection',
    'hover',
    'hover',
    'click',
    'ready',
    'analysis',
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
  await assert.rejects(
    source.notifyCustomEvent('analysis', { value: undefined }),
    /JSON/i,
  );
  assert.equal(delivered.length, callsBeforeInvalid);
});

test('Jupyter mode does not register or enumerate the unrelated demo catalog', async () => {
  const manager = createDataSourceManager();
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

  assert.deepEqual(manager.getSourceTypes(), ['jupyter', 'github-repo']);
  assert.deepEqual(await manager.getAllDatasets(), [{
    sourceType: 'jupyter',
    datasets: [{ id: 'python-dataset', name: 'Python dataset' }],
    error: null,
  }]);
  assert.equal(jupyterAvailabilityCalls, 1);
  assert.equal(jupyterListingCalls, 1);
  assert.equal(manager.getSource('local-demo'), null);
  assert.notEqual(manager.getSource('github-repo'), null);
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
