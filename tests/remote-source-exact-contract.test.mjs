import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteDataSource,
  isRemoteUrl,
  isSecureRemoteUrl,
  parseRemoteUrl,
} from '../assets/js/data/remote-source.js';

function jsonResponse(value, status = 200) {
  return new Response(
    JSON.stringify(value),
    {
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

function exportedHealth(overrides = {}) {
  return {
    status: 'ok',
    type: 'exported',
    version: '1.2.3',
    ...overrides,
  };
}

function exportedInfo(overrides = {}) {
  return {
    version: '1.2.3',
    host: '127.0.0.1',
    port: 8765,
    mode: 'standalone',
    ...overrides,
  };
}

function anndataHealth(overrides = {}) {
  return {
    status: 'ok',
    type: 'anndata',
    version: '1.2.3',
    format: 'h5ad',
    is_backed: true,
    n_cells: 3,
    n_genes: 2,
    ...overrides,
  };
}

function anndataInfo(overrides = {}) {
  return {
    version: '1.2.3',
    type: 'anndata',
    format: 'h5ad',
    host: '127.0.0.1',
    port: 8765,
    n_cells: 3,
    n_genes: 2,
    is_backed: true,
    ...overrides,
  };
}

function catalog(
  entries = [{ id: 'cells', path: '/', name: 'Cells' }]
) {
  return { datasets: entries };
}

function identity(id = 'cells', name = 'Cells') {
  return {
    version: 2,
    id,
    name,
    description: 'Synthetic remote contract fixture',
    cellucid_data_version: 'test-current',
    stats: {
      n_cells: 3,
      n_genes: 2,
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

function installFetch(t, implementation) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, options });
    return implementation(url, options, requests.length);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requests;
}

function installCanonicalExportedServer(
  t,
  {
    origin = 'http://127.0.0.1:8765',
    health = exportedHealth(),
    info = exportedInfo(),
    listing = catalog(),
    datasetIdentity = identity(),
  } = {}
) {
  return installFetch(t, url => {
    if (url === `${origin}/_cellucid/health`) return jsonResponse(health);
    if (url === `${origin}/_cellucid/info`) return jsonResponse(info);
    if (url === `${origin}/_cellucid/datasets`) return jsonResponse(listing);
    if (url === `${origin}/dataset_identity.json`) {
      return jsonResponse(datasetIdentity);
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
}

class OpeningWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = OpeningWebSocket.CONNECTING;
    this.sent = [];
    OpeningWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== OpeningWebSocket.CONNECTING) return;
      this.readyState = OpeningWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  send(value) {
    if (this.readyState !== OpeningWebSocket.OPEN) {
      throw new Error('socket is not open');
    }
    this.sent.push(value);
  }

  close() {
    this.readyState = OpeningWebSocket.CLOSED;
  }

  receive(data) {
    return this.onmessage?.({ data });
  }

  serverClose(code = 1006, reason = 'server closed') {
    const handler = this.onclose;
    this.readyState = OpeningWebSocket.CLOSED;
    return handler?.({ code, reason });
  }
}

class FailingWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FailingWebSocket.CONNECTING;
    FailingWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FailingWebSocket.CONNECTING) return;
      this.readyState = FailingWebSocket.CLOSED;
      this.onerror?.(new Error('refused'));
    });
  }

  close() {
    this.readyState = FailingWebSocket.CLOSED;
  }
}

function installWebSocket(t, implementation) {
  const original = globalThis.WebSocket;
  implementation.instances.length = 0;
  globalThis.WebSocket = implementation;
  t.after(() => {
    if (original === undefined) {
      delete globalThis.WebSocket;
    } else {
      globalThis.WebSocket = original;
    }
  });
}

test('remote custom URLs use one canonical explicit transport', () => {
  assert.equal(isRemoteUrl('remote://example.test/data/'), true);
  assert.equal(isRemoteUrl('remotes://example.test/data/'), true);
  assert.equal(isRemoteUrl({ startsWith: () => true }), false);
  assert.equal(isSecureRemoteUrl('remote://example.test/data/'), false);
  assert.equal(isSecureRemoteUrl('remotes://example.test/data/'), true);

  assert.deepEqual(
    parseRemoteUrl('remote://example.test:8765/data/points_2d.bin'),
    {
      serverUrl: 'http://example.test:8765',
      path: 'data/points_2d.bin',
      secure: false,
    }
  );
  assert.deepEqual(
    parseRemoteUrl('remotes://example.test/data/'),
    {
      serverUrl: 'https://example.test',
      path: 'data/',
      secure: true,
    }
  );
  assert.deepEqual(
    parseRemoteUrl(
      'remotes://example.test/cell%20atlas/%E7%BB%86%E8%83%9E.bin'
    ),
    {
      serverUrl: 'https://example.test',
      path:
        'cell%20atlas/%E7%BB%86%E8%83%9E.bin',
      secure: true,
    }
  );

  for (const malformed of [
    'remote://example.test',
    'remote://EXAMPLE.test/data/',
    'remote://user@example.test/data/',
    'remote://example.test/a/../data/',
    'remote://example.test/%252e%252e/data/',
    'remote://example.test/nested/%252fdata/',
    'remote://example.test/nested/%255cdata/',
    'remote://example.test/nested/%2541/',
    'remote://example.test/data/?query=1',
    ' remote://example.test/data/',
  ]) {
    assert.equal(parseRemoteUrl(malformed), null, malformed);
  }
});

test('remote connection configuration rejects normalization and retired reconnect controls', async () => {
  const source = new RemoteDataSource();
  const invalidConfigs = [
    null,
    {},
    { url: '127.0.0.1:8765' },
    { url: ' http://127.0.0.1:8765' },
    { url: 'http://127.0.0.1:8765/' },
    { url: 'HTTP://127.0.0.1:8765' },
    { url: 'http://user:secret@127.0.0.1:8765' },
    { url: 'http://127.0.0.1:8765?mode=remote' },
    { url: 'http://127.0.0.1:8765/%252e%252e' },
    { url: 'http://127.0.0.1:8765/nested/%252fdata' },
    { url: 'http://127.0.0.1:8765/nested/%255cdata' },
    { url: 'http://127.0.0.1:8765/nested/%2541' },
    { url: 'http://127.0.0.1:8765', timeout: 0 },
    { url: 'http://127.0.0.1:8765', timeout: 5000.5 },
    { url: 'http://127.0.0.1:8765', autoReconnect: true },
  ];
  for (const config of invalidConfigs) {
    await assert.rejects(source.connect(config), TypeError);
  }
});

test('HTTPS pages reject an HTTP remote URL instead of silently upgrading it', async t => {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { protocol: 'https:' } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  const source = new RemoteDataSource();
  await assert.rejects(
    source.connect({ url: 'http://127.0.0.1:8765' }),
    /requires an explicit HTTPS/i
  );
});

test('connect adopts one complete exported server and exact catalog transaction', async t => {
  const requests = installCanonicalExportedServer(t);
  const source = new RemoteDataSource();

  const info = await source.connect({ url: 'http://127.0.0.1:8765' });
  assert.deepEqual(info, exportedInfo());
  assert.equal(Object.isFrozen(info), true);
  assert.equal(source.isConnected(), true);
  assert.deepEqual(
    requests.map(request => request.url),
    [
      'http://127.0.0.1:8765/_cellucid/health',
      'http://127.0.0.1:8765/_cellucid/info',
      'http://127.0.0.1:8765/_cellucid/datasets',
    ]
  );
  assert.ok(requests.every(request => request.options.cache === 'no-store'));
  assert.ok(requests.every(request => request.options.redirect === 'error'));

  assert.equal(source.getBaseUrl('cells'), 'remote://127.0.0.1:8765/');
  assert.equal(
    await source.resolveUrl('remote://127.0.0.1:8765/points_2d.bin'),
    'http://127.0.0.1:8765/points_2d.bin'
  );
  await assert.rejects(
    source.resolveUrl('remote://other.test/points_2d.bin'),
    /does not belong/i
  );
  await assert.rejects(
    source.getMetadata('undeclared'),
    /not declared/i
  );
});

test('remote resolution is confined to current declared dataset paths', async t => {
  const origin = 'http://127.0.0.1:8765/viewer';
  installFetch(t, url => {
    if (url === `${origin}/_cellucid/health`) {
      return jsonResponse(exportedHealth());
    }
    if (url === `${origin}/_cellucid/info`) {
      return jsonResponse(exportedInfo());
    }
    if (url === `${origin}/_cellucid/datasets`) {
      return jsonResponse(catalog([
        { id: 'cells', path: '/cells/', name: 'Cells' },
      ]));
    }
    return jsonResponse({}, 404);
  });

  const source = new RemoteDataSource();
  await source.connect({ url: origin });
  assert.equal(
    source.getBaseUrl('cells'),
    'remote://127.0.0.1:8765/viewer/cells/'
  );
  assert.equal(
    await source.resolveUrl(
      'remote://127.0.0.1:8765/viewer/cells/points_2d.bin'
    ),
    `${origin}/cells/points_2d.bin`
  );
  for (const url of [
    'remote://127.0.0.1:8765/viewer/retired/private.json',
    'remote://127.0.0.1:8765/viewer/_cellucid/events',
  ]) {
    await assert.rejects(
      source.resolveUrl(url),
      /currently declared dataset/i,
      url
    );
  }
});

test('connect accepts the exact current AnnData health and info pair', async t => {
  installFetch(t, url => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(anndataHealth());
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(anndataInfo());
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(catalog());
    }
    return jsonResponse({}, 404);
  });
  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });
  assert.equal(source.isConnected(), true);
  assert.equal(source.getConnectionInfo().serverInfo.type, 'anndata');
});

test('health, info, and catalog schemas are closed and cross-checked', async t => {
  const cases = [
    {
      label: 'health extra field',
      health: exportedHealth({ message: 'fine' }),
      info: exportedInfo(),
      listing: catalog(),
      match: /health.*noncanonical|unsupported message/i,
    },
    {
      label: 'health noncanonical status',
      health: exportedHealth({ status: 'healthy' }),
      info: exportedInfo(),
      listing: catalog(),
      match: /status must be exactly ok/i,
    },
    {
      label: 'server info version mismatch',
      health: exportedHealth(),
      info: exportedInfo({ version: '9.9.9' }),
      listing: catalog(),
      match: /versions must match/i,
    },
    {
      label: 'server info retired mode',
      health: exportedHealth(),
      info: exportedInfo({ mode: 'async' }),
      listing: catalog(),
      match: /mode must be exactly standalone/i,
    },
    {
      label: 'catalog missing path',
      health: exportedHealth(),
      info: exportedInfo(),
      listing: catalog([{ id: 'cells', name: 'Cells' }]),
      match: /missing path/i,
    },
    {
      label: 'catalog duplicate path',
      health: exportedHealth(),
      info: exportedInfo(),
      listing: catalog([
        { id: 'first', path: '/same/', name: 'First' },
        { id: 'second', path: '/same/', name: 'Second' },
      ]),
      match: /duplicate path/i,
    },
    {
      label: 'empty catalog',
      health: exportedHealth(),
      info: exportedInfo(),
      listing: catalog([]),
      match: /at least one dataset/i,
    },
  ];

  let activeCase = cases[0];
  installFetch(t, url => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(activeCase.health);
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(activeCase.info);
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(activeCase.listing);
    }
    return jsonResponse({}, 404);
  });

  for (const candidate of cases) {
    activeCase = candidate;
    const source = new RemoteDataSource();
    await assert.rejects(
      source.connect({ url: 'http://127.0.0.1:8765' }),
      candidate.match,
      candidate.label
    );
    assert.equal(source.isConnected(), false, candidate.label);
    assert.equal(source.getConnectionInfo().url, null, candidate.label);
  }
});

test('a failed replacement connection preserves the previous complete connection', async t => {
  installFetch(t, url => {
    if (url.startsWith('http://first.test')) {
      if (url.endsWith('/_cellucid/health')) {
        return jsonResponse(exportedHealth());
      }
      if (url.endsWith('/_cellucid/info')) {
        return jsonResponse(exportedInfo());
      }
      if (url.endsWith('/_cellucid/datasets')) {
        return jsonResponse(catalog());
      }
    }
    if (url === 'http://second.test/_cellucid/health') {
      return jsonResponse(exportedHealth({ status: 'not-ok' }));
    }
    return jsonResponse({}, 404);
  });

  const source = new RemoteDataSource();
  await source.connect({ url: 'http://first.test' });
  await assert.rejects(
    source.connect({ url: 'http://second.test' }),
    /status must be exactly ok/i
  );
  assert.equal(source.isConnected(), true);
  assert.equal(source.getConnectionInfo().url, 'http://first.test');
  assert.equal(source.getBaseUrl('cells'), 'remote://first.test/');
});

test('dataset listing failure propagates without fabricated metadata or partial adoption', async t => {
  let identityStatus = 200;
  const listing = catalog();
  installFetch(t, url => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(exportedHealth());
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(exportedInfo());
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(listing);
    }
    if (url.endsWith('/dataset_identity.json')) {
      return identityStatus === 200
        ? jsonResponse(identity())
        : jsonResponse({}, identityStatus);
    }
    return jsonResponse({}, 404);
  });

  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });
  const datasets = await source.listDatasets();
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].stats.n_cells, 3);

  identityStatus = 404;
  await assert.rejects(
    source.listDatasets(),
    /dataset_identity|missing|required/i
  );
  assert.equal((await source.getMetadata('cells')).stats.n_cells, 3);
});

test('dataset catalog and identity names must agree exactly', async t => {
  installCanonicalExportedServer(t, {
    listing: catalog([
      { id: 'cells', path: '/', name: 'Catalog name' },
    ]),
    datasetIdentity: identity('cells', 'Identity name'),
  });
  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });
  await assert.rejects(source.listDatasets(), /catalog name.*does not match/i);
});

test('remote listing aborts and drains metadata siblings after one exact failure', async t => {
  let heldSignal = null;
  let heldSettled = false;
  installFetch(t, (url, options) => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(exportedHealth());
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(exportedInfo());
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(catalog([
        { id: 'invalid', path: '/invalid/', name: 'Invalid' },
        { id: 'held', path: '/held/', name: 'Held' },
      ]));
    }
    if (url.endsWith('/invalid/dataset_identity.json')) {
      return jsonResponse({});
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
    return jsonResponse({}, 404);
  });

  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });
  await assert.rejects(
    source.listDatasets(),
    /dataset_identity|missing required field/i
  );
  assert.ok(heldSignal instanceof AbortSignal);
  assert.equal(heldSignal.aborted, true);
  assert.equal(heldSettled, true);
});

test('concurrent remote metadata reads coalesce within one catalog owner', async t => {
  let identityCalls = 0;
  let releaseIdentity;
  const identityResponse = new Promise(resolve => {
    releaseIdentity = resolve;
  });
  installFetch(t, url => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(exportedHealth());
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(exportedInfo());
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(catalog());
    }
    if (url.endsWith('/dataset_identity.json')) {
      identityCalls += 1;
      return identityResponse;
    }
    return jsonResponse({}, 404);
  });

  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });
  const first = source.getMetadata('cells');
  const second = source.getMetadata('cells');
  assert.equal(identityCalls, 1);
  releaseIdentity(jsonResponse(identity()));
  const [firstMetadata, secondMetadata] = await Promise.all([
    first,
    second,
  ]);
  assert.equal(firstMetadata, secondMetadata);
  assert.equal(await source.getMetadata('cells'), firstMetadata);
  assert.equal(identityCalls, 1);
});

test('a newer remote catalog generation aborts and rejects stale metadata work', async t => {
  let listing = catalog([
    { id: 'cells', path: '/old/', name: 'Cells' },
  ]);
  let oldMetadataSignal = null;
  let releaseOldMetadata;
  let markOldMetadataStarted;
  const oldMetadataStarted = new Promise(resolve => {
    markOldMetadataStarted = resolve;
  });
  const oldMetadataResponse = new Promise(resolve => {
    releaseOldMetadata = resolve;
  });

  installFetch(t, (url, options) => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(exportedHealth());
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(exportedInfo());
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(listing);
    }
    if (url.endsWith('/old/dataset_identity.json')) {
      oldMetadataSignal = options.signal ?? null;
      markOldMetadataStarted();
      return oldMetadataResponse;
    }
    if (url.endsWith('/new/dataset_identity.json')) {
      const current = identity();
      current.description = 'Current catalog generation';
      return jsonResponse(current);
    }
    return jsonResponse({}, 404);
  });

  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });

  const staleMetadata = source.getMetadata('cells');
  await oldMetadataStarted;
  listing = catalog([
    { id: 'cells', path: '/new/', name: 'Cells' },
  ]);
  const [currentMetadata] = await source.listDatasets();

  assert.ok(oldMetadataSignal instanceof AbortSignal);
  assert.equal(oldMetadataSignal.aborted, true);
  releaseOldMetadata(jsonResponse(identity()));
  await assert.rejects(staleMetadata, /abort|cancel|supersed/i);
  assert.equal(
    (await source.getMetadata('cells')).description,
    currentMetadata.description
  );
  assert.equal(
    source.getBaseUrl('cells'),
    'remote://127.0.0.1:8765/new/'
  );
});

test('remote JSON endpoints require exact HTTP and media-type success', async t => {
  let responseMode = 'status';
  installFetch(t, url => {
    if (!url.endsWith('/_cellucid/health')) return jsonResponse({}, 404);
    if (responseMode === 'status') {
      return new Response(JSON.stringify(exportedHealth()), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(exportedHealth()), {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  });

  const statusSource = new RemoteDataSource();
  await assert.rejects(
    statusSource.connect({ url: 'http://127.0.0.1:8765' }),
    /HTTP 201/i
  );
  responseMode = 'content-type';
  const mediaSource = new RemoteDataSource();
  await assert.rejects(
    mediaSource.connect({ url: 'http://127.0.0.1:8765' }),
    /Content-Type must be exactly application\/json/i
  );
});

test('disconnected dataset operations fail instead of reporting empty success', async () => {
  const source = new RemoteDataSource();
  await assert.rejects(source.listDatasets(), /active connection/i);
  await assert.rejects(source.hasDataset('cells'), /active connection/i);
  await assert.rejects(source.getMetadata('cells'), /active connection/i);
  assert.throws(() => source.getBaseUrl('cells'), /active connection/i);
  await assert.rejects(
    source.resolveUrl('remote://example.test/data/'),
    /active connection/i
  );
});

test('an advertised WebSocket is required to open before connection adoption', async t => {
  installWebSocket(t, OpeningWebSocket);
  installCanonicalExportedServer(t, {
    info: exportedInfo({ ws_port: 9876 }),
  });
  const source = new RemoteDataSource();
  const messages = [];
  source.onMessage(message => messages.push(message));

  await source.connect({ url: 'http://127.0.0.1:8765' });
  assert.equal(source.isConnected(), true);
  assert.equal(OpeningWebSocket.instances.length, 1);
  const socket = OpeningWebSocket.instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:9876/');

  const outbound = { type: 'request', payload: { dataset: 'cells' } };
  source.sendMessage(outbound);
  assert.deepEqual(socket.sent, [JSON.stringify(outbound)]);
  assert.throws(
    () => source.sendMessage({ type: 'request', dataset: 'cells' }),
    /noncanonical fields|missing payload/i
  );

  await socket.receive(JSON.stringify({
    type: 'datasetChanged',
    payload: { dataset: 'cells' },
  }));
  assert.deepEqual(messages, [{
    type: 'datasetChanged',
    payload: { dataset: 'cells' },
  }]);
});

test('an advertised WebSocket failure rejects the whole connection', async t => {
  installWebSocket(t, FailingWebSocket);
  installCanonicalExportedServer(t, {
    info: exportedInfo({ ws_port: 9876 }),
  });
  const source = new RemoteDataSource();
  await assert.rejects(
    source.connect({ url: 'http://127.0.0.1:8765' }),
    /advertised a WebSocket that failed to open/i
  );
  assert.equal(source.isConnected(), false);
  assert.equal(source.getConnectionInfo().url, null);
});

test('advertised WebSocket closure is terminal and never reconnects', async t => {
  installWebSocket(t, OpeningWebSocket);
  installCanonicalExportedServer(t, {
    info: exportedInfo({ ws_port: 9876 }),
  });
  const source = new RemoteDataSource();
  const losses = [];
  source.onConnectionLost(error => losses.push(error));
  await source.connect({ url: 'http://127.0.0.1:8765' });

  await OpeningWebSocket.instances[0].serverClose(1006, 'network gone');
  await Promise.resolve();

  assert.equal(source.isConnected(), false);
  assert.equal(OpeningWebSocket.instances.length, 1);
  assert.equal(losses.length, 1);
  assert.match(losses[0].message, /closed \(code 1006\)/i);
  assert.throws(
    () => source.sendMessage({ type: 'request', payload: null }),
    /not connected/i
  );
});

test('malformed WebSocket messages terminate the advertised channel', async t => {
  installWebSocket(t, OpeningWebSocket);
  installCanonicalExportedServer(t, {
    info: exportedInfo({ ws_port: 9876 }),
  });
  const source = new RemoteDataSource();
  const losses = [];
  source.onConnectionLost(error => losses.push(error));
  await source.connect({ url: 'http://127.0.0.1:8765' });

  await OpeningWebSocket.instances[0].receive(JSON.stringify({
    type: 'update',
    data: { value: 1 },
  }));
  assert.equal(source.isConnected(), false);
  assert.equal(losses.length, 1);
  assert.match(losses[0].message, /valid JSON|finite|noncanonical/i);
});

test('remote callbacks require functions and callback failures are not swallowed', async () => {
  const source = new RemoteDataSource();
  assert.throws(() => source.onMessage(null), /must be a function/i);
  assert.throws(() => source.offMessage('handler'), /must be a function/i);
  assert.throws(() => source.onConnectionLost({}), /must be a function/i);
  assert.throws(() => source.offConnectionLost(1), /must be a function/i);

  source.onMessage(async () => {
    throw new Error('consumer failed');
  });
  await assert.rejects(
    source._handleMessage({ type: 'update', payload: null }),
    /consumer failed/i
  );
});
