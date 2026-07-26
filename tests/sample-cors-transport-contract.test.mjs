import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DATA_CONFIG,
  fetchSampleArtifact,
} from '../assets/js/data/data-source.js';
import {
  createDataSourceManager,
} from '../assets/js/data/data-source-manager.js';

const SAMPLE_ROOT = 'https://samples.cellucid.test/exports/';
const APP_ROOT = 'https://app.cellucid.test/';

function installSampleBrowser(t) {
  const originalWindow = globalThis.window;
  const originalBase = DATA_CONFIG.EXPORTS_BASE_URL;
  globalThis.window = {
    location: {
      href: `${APP_ROOT}index.html`,
      origin: APP_ROOT.slice(0, -1),
    },
  };
  DATA_CONFIG.EXPORTS_BASE_URL = SAMPLE_ROOT;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    DATA_CONFIG.EXPORTS_BASE_URL = originalBase;
  });
}

test('cross-origin sample artifacts use one direct CORS request and preserve streaming', async t => {
  installSampleBrowser(t);
  const originalFetch = globalThis.fetch;
  const calls = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
      controller.close();
    },
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, {
      status: 200,
      headers: { 'content-length': '3' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();
  const response = await fetchSampleArtifact(
    `${SAMPLE_ROOT}suo/points_2d.bin.gz`,
    {
      cache: 'force-cache',
      headers: { range: 'bytes=0-2' },
      signal: controller.signal,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SAMPLE_ROOT}suo/points_2d.bin.gz`);
  assert.deepEqual(calls[0].init.headers, [['range', 'bytes=0-2']]);
  assert.equal(calls[0].init.cache, 'force-cache');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.mode, 'cors');
  assert.equal(calls[0].init.redirect, 'error');
  assert.strictEqual(calls[0].init.signal, controller.signal);
  assert.strictEqual(response.body, body);
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [1, 2, 3],
  );
});

test('manager initialization registers the sample catalog without selecting science', async t => {
  installSampleBrowser(t);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('manager initialization must not request sample data');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const manager = createDataSourceManager();
  await manager.initialize();

  assert.ok(manager.getSource('local-demo'));
  assert.ok(manager.getSource('github-repo'));
  assert.equal(manager.hasActiveDataset(), false);
  assert.equal(manager.getCurrentDatasetId(), null);
  assert.equal(manager.getCurrentSourceType(), null);
  assert.equal(fetchCalls, 0);
});

test('manager initialization rejects every undeclared control', async () => {
  const manager = createDataSourceManager();
  await assert.rejects(
    manager.initialize({ catalogPolicy: 'eager' }),
    /unsupported.*catalogPolicy/i,
  );
  assert.equal(manager.getSourceTypes().length, 0);
});

test('a configured catalog transport failure is surfaced once and never retried implicitly', async t => {
  installSampleBrowser(t);
  const originalFetch = globalThis.fetch;
  const transportFailure = new Error('CORS owner rejected the request');
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw transportFailure;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const manager = createDataSourceManager();
  await manager.initialize();
  await assert.rejects(
    manager.getAllDatasets(),
    /CORS owner rejected the request/,
  );
  await assert.rejects(
    manager.getAllDatasets(),
    /CORS owner rejected the request/,
  );
  assert.equal(fetchCalls, 1);
  assert.equal(manager.hasActiveDataset(), false);
});

test('sample catalog UI has no detached timeout race and declares direct HTTP', async () => {
  const [controls, dataSource, index] = await Promise.all([
    readFile(
      new URL(
        '../assets/js/app/ui/modules/dataset-controls.js',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL('../assets/js/data/data-source.js', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(controls, /Promise\.race|timeoutPromise|getAllDatasets took/);
  assert.match(dataSource, /export async function fetchSampleArtifact/);
  assert.match(index, /Every sample artifact uses one direct HTTP request/);
  assert.match(controls, /Failed to load dataset catalog/);
});
