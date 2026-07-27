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

function installWindow(search) {
  const href = `http://127.0.0.1:8765/viewer/${search}`;
  globalThis.window = {
    location: new URL(href),
    addEventListener() {},
    removeEventListener() {},
  };
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
  source._config = getJupyterConfig();
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
});

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
  source._config = getJupyterConfig();
  let calls = 0;
  source.onMessage(() => {
    calls += 1;
  });

  assert.throws(
    () => source._handleMessage({
      data: { type: 'freeze', viewerToken: 'secret-1' },
      origin: 'https://notebook.example',
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
    }),
    /origin/i,
  );
  assert.equal(calls, 1);
});

test('Jupyter callback registration and delivery preserve the original failure', () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
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
    }),
    error => error === failure,
  );
});

test('Jupyter authenticated commands validate exact payloads and async delivery', async () => {
  installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
  const source = new JupyterBridgeDataSource();
  source._config = getJupyterConfig();
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
  }]);
  assert.equal(jupyterAvailabilityCalls, 1);
  assert.equal(jupyterListingCalls, 1);
  assert.equal(manager.getSource('local-demo'), null);
  assert.notEqual(manager.getSource('github-repo'), null);
});
