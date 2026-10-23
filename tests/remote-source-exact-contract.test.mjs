import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteDataSource } from '../assets/js/data/remote-source.js';

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

function anndataHealth(overrides = {}) {
  return {
    status: 'ok',
    type: 'anndata',
    version: '1.2.3',
    format: 'h5ad',
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
    ...overrides,
  };
}

function catalog(entries = [servedAnnDataEntry()]) {
  return { datasets: entries };
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

function installCanonicalServer(
  t,
  {
    origin = 'http://127.0.0.1:8765',
    health = anndataHealth(),
    info = anndataInfo(),
    listing = catalog(),
  } = {}
) {
  return installFetch(t, url => {
    if (url === `${origin}/_cellucid/health`) return jsonResponse(health);
    if (url === `${origin}/_cellucid/info`) return jsonResponse(info);
    if (url === `${origin}/_cellucid/datasets`) return jsonResponse(listing);
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

test('connect adopts one complete server and exact catalog transaction', async t => {
  const requests = installCanonicalServer(t);
  const source = new RemoteDataSource();

  const info = await source.connect({ url: 'http://127.0.0.1:8765' });
  assert.deepEqual(info, anndataInfo());
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

  await assert.rejects(
    source.getMetadata('undeclared'),
    /not declared/i
  );
});

function servedAnnDataEntry(overrides = {}) {
  return {
    id: 'cells',
    name: 'Cells',
    anndata: {
      file: {
        url: '_cellucid/anndata/cells.h5ad',
        kind: 'h5ad',
        layout: 'file',
        size: 1024,
      },
      defaults: { knn: 'connectivities', normalizeEmbeddings: true },
    },
    ...overrides,
  };
}

function installAnnDataServer(t, { entries = [servedAnnDataEntry()] } = {}) {
  return installFetch(t, url => {
    if (url.endsWith('/_cellucid/health')) {
      return jsonResponse(anndataHealth());
    }
    if (url.endsWith('/_cellucid/info')) {
      return jsonResponse(anndataInfo());
    }
    if (url.endsWith('/_cellucid/datasets')) {
      return jsonResponse(catalog(entries));
    }
    return jsonResponse({}, 404);
  });
}

test('connect accepts the exact current AnnData health, info and catalog', async t => {
  installAnnDataServer(t);
  const source = new RemoteDataSource();
  await source.connect({ url: 'http://127.0.0.1:8765' });
  assert.equal(source.isConnected(), true);
  assert.equal(source.getConnectionInfo().serverInfo.type, 'anndata');
  // The store is opened when its metadata is first asked for.
  assert.equal(source.getAnnDataSource(), null);
  assert.throws(() => source.getBaseUrl('cells'), /not open; load its metadata first/);
  source.disconnect();
  assert.equal(source.getAnnDataSource(), null);
});

test('an AnnData catalog entry is closed and checked before anything is read', async t => {
  const cases = [
    ['no store', [{ id: 'cells', name: 'Cells' }], /missing anndata/],
    ['a prepared-export directory', [{ ...servedAnnDataEntry(), path: '/' }], /unsupported path/],
    ['two datasets', [servedAnnDataEntry(), servedAnnDataEntry({ id: 'other' })], /exactly one dataset/],
    ['store outside the route', [servedAnnDataEntry({
      anndata: { file: { url: '/etc/passwd', kind: 'h5ad', layout: 'file', size: 1 }, defaults: {} },
    })], /route under _cellucid\/anndata\//],
    ['a folder without its slash', [servedAnnDataEntry({
      anndata: { file: { url: '_cellucid/anndata/cells.zarr', kind: 'zarr', layout: 'folder' }, defaults: {} },
    })], /store folder, ending in "\/"/],
    ['a sized folder', [servedAnnDataEntry({
      anndata: { file: { url: '_cellucid/anndata/cells.zarr/', kind: 'zarr', layout: 'folder', size: 3 }, defaults: {} },
    })], /unsupported size/],
    ['an h5ad in a zip', [servedAnnDataEntry({
      anndata: { file: { url: '_cellucid/anndata/cells.zip', kind: 'h5ad', layout: 'zip', size: 3 }, defaults: {} },
    })], /h5ad file, a zipped Zarr store or a Zarr store folder/],
    ['an unknown launch default', [servedAnnDataEntry({
      anndata: { file: servedAnnDataEntry().anndata.file, defaults: { knnKey: 'connectivities' } },
    })], /Unknown AnnData launch default/],
    ['the expression in the panel vocabulary', [servedAnnDataEntry({
      anndata: { file: servedAnnDataEntry().anndata.file, defaults: { expression: 'raw' } },
    })], /'X', 'raw\/X', 'layers\/<name>' or null/],
  ];
  for (const [label, entries, match] of cases) {
    await t.test(label, async t => {
      installAnnDataServer(t, { entries });
      const source = new RemoteDataSource();
      await assert.rejects(source.connect({ url: 'http://127.0.0.1:8765' }), match);
      assert.equal(source.isConnected(), false);
    });
  }
});

test('health, info, and catalog schemas are closed and cross-checked', async t => {
  const cases = [
    {
      label: 'health extra field',
      health: anndataHealth({ message: 'fine' }),
      info: anndataInfo(),
      listing: catalog(),
      match: /health.*noncanonical|unsupported message/i,
    },
    {
      label: 'health noncanonical status',
      health: anndataHealth({ status: 'healthy' }),
      info: anndataInfo(),
      listing: catalog(),
      match: /status must be exactly ok/i,
    },
    {
      label: 'the retired prepared-export server',
      health: { status: 'ok', type: 'exported', version: '1.2.3' },
      info: anndataInfo(),
      listing: catalog(),
      match: /missing format/i,
    },
    {
      label: 'server info version mismatch',
      health: anndataHealth(),
      info: anndataInfo({ version: '9.9.9' }),
      listing: catalog(),
      match: /versions must match/i,
    },
    {
      label: 'health and info describe different stores',
      health: anndataHealth(),
      info: anndataInfo({ n_cells: 4 }),
      listing: catalog(),
      match: /describe the same dataset/i,
    },
    {
      label: 'empty catalog',
      health: anndataHealth(),
      info: anndataInfo(),
      listing: catalog([]),
      match: /exactly one dataset/i,
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
        return jsonResponse(anndataHealth());
      }
      if (url.endsWith('/_cellucid/info')) {
        return jsonResponse(anndataInfo());
      }
      if (url.endsWith('/_cellucid/datasets')) {
        return jsonResponse(catalog());
      }
    }
    if (url === 'http://second.test/_cellucid/health') {
      return jsonResponse(anndataHealth({ status: 'not-ok' }));
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
  assert.equal(source.getConnectionInfo().serverInfo.type, 'anndata');
});

test('remote JSON endpoints require exact HTTP and media-type success', async t => {
  let responseMode = 'status';
  installFetch(t, url => {
    if (!url.endsWith('/_cellucid/health')) return jsonResponse({}, 404);
    if (responseMode === 'status') {
      return new Response(JSON.stringify(anndataHealth()), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(anndataHealth()), {
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

function streamingResponse(chunks, { failure = null } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        if (failure === null) {
          controller.close();
        } else {
          controller.error(failure);
        }
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

test('a remote body failure is reported by its own cause, never as bad JSON', async t => {
  // A response body can fail in ways that are not the server sending malformed
  // data: the reader can be cancelled, the connection can drop mid-transfer, or
  // the payload can be refused for exceeding its ceiling. Reporting all of them
  // as "must contain valid JSON" tells the user the server is broken when it is
  // not, and hides their own cancellation entirely.
  const cases = [
    {
      name: 'malformed JSON is the only INVALID_FORMAT',
      failure: null,
      chunks: ['{"status": "ok",'],
      expect: error => (
        error.code === 'INVALID_FORMAT' &&
        /must contain valid JSON/i.test(error.message)
      ),
    },
    {
      name: 'a dropped transfer is a network error',
      failure: new TypeError('network connection was lost'),
      chunks: ['{"status": '],
      expect: error => (
        error.code === 'NETWORK_ERROR' &&
        /body transfer failed/i.test(error.message) &&
        !/must contain valid JSON/i.test(error.message)
      ),
    },
    {
      name: 'a cancelled read stays a cancellation',
      failure: Object.assign(new Error('reader was cancelled'), {
        name: 'AbortError',
      }),
      chunks: ['{"status": '],
      expect: error => (
        error.name === 'AbortError' &&
        !/must contain valid JSON/i.test(error.message)
      ),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async subTest => {
      installFetch(subTest, url => {
        if (!url.endsWith('/_cellucid/health')) {
          return jsonResponse({}, 404);
        }
        return streamingResponse(testCase.chunks, {
          failure: testCase.failure,
        });
      });
      const source = new RemoteDataSource();
      await assert.rejects(
        source.connect({ url: 'http://127.0.0.1:8765' }),
        testCase.expect
      );
    });
  }
});

test('disconnected dataset operations fail instead of reporting empty success', async () => {
  const source = new RemoteDataSource();
  await assert.rejects(source.listDatasets(), /active connection/i);
  await assert.rejects(source.hasDataset('cells'), /active connection/i);
  await assert.rejects(source.getMetadata('cells'), /active connection/i);
  assert.throws(() => source.getBaseUrl('cells'), /active connection/i);
});

test('an advertised WebSocket is required to open before connection adoption', async t => {
  installWebSocket(t, OpeningWebSocket);
  installCanonicalServer(t, {
    info: anndataInfo({ ws_port: 9876 }),
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
  installCanonicalServer(t, {
    info: anndataInfo({ ws_port: 9876 }),
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
  installCanonicalServer(t, {
    info: anndataInfo({ ws_port: 9876 }),
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
  installCanonicalServer(t, {
    info: anndataInfo({ ws_port: 9876 }),
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
