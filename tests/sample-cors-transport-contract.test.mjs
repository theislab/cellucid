import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DATA_CONFIG,
  DATASET_ARTIFACT_CACHE,
  fetchSampleArtifact,
} from '../assets/js/data/data-source.js';
import {
  DataSourceManager,
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
    `${SAMPLE_ROOT}suo/embeddings/0_2d.bin.gz`,
    {
      headers: { range: 'bytes=0-2' },
      signal: controller.signal,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SAMPLE_ROOT}suo/embeddings/0_2d.bin.gz`);
  assert.deepEqual(calls[0].init.headers, [['range', 'bytes=0-2']]);
  assert.equal(calls[0].init.cache, 'no-cache');
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

test('prepared sample paths decode once and retain no second-decoding escape', async t => {
  installSampleBrowser(t);
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return new Response(Uint8Array.of(1), {
      status: 200,
      headers: { 'content-length': '1' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const nestedEncoding of [
    '%252e%252e/escape.bin',
    'nested/%252fescape.bin',
    'nested/%255cescape.bin',
    'nested/%2541.bin',
  ]) {
    await assert.rejects(
      fetchSampleArtifact(`${SAMPLE_ROOT}${nestedEncoding}`),
      /non-canonical path segment/i,
      nestedEncoding,
    );
  }

  const canonicalPaths = [
    'cell%20atlas/points.bin',
    '%E7%BB%86%E8%83%9E/points.bin',
  ];
  for (const path of canonicalPaths) {
    const response = await fetchSampleArtifact(
      `${SAMPLE_ROOT}${path}`
    );
    assert.equal(response.ok, true);
  }
  assert.deepEqual(
    requested,
    canonicalPaths.map(path => `${SAMPLE_ROOT}${path}`),
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

  const manager = new DataSourceManager();
  await manager.initialize();

  assert.ok(manager.getSource('local-demo'));
  assert.ok(manager.getSource('github-repo'));
  assert.equal(manager.hasActiveDataset(), false);
  assert.equal(manager.getCurrentDatasetId(), null);
  assert.equal(manager.getCurrentSourceType(), null);
  assert.equal(fetchCalls, 0);
});

test('manager initialization rejects every undeclared control', async () => {
  const manager = new DataSourceManager();
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

  const manager = new DataSourceManager();
  await manager.initialize();

  // The failure belongs to the catalog that produced it. Enumerating sources
  // still succeeds, so an unreachable sample catalog cannot disable the
  // selector for datasets that need no network at all.
  const first = await manager.getAllDatasets();
  const firstDemo = first.find(entry => entry.sourceType === 'local-demo');
  assert.match(firstDemo.error.message, /CORS owner rejected the request/);
  assert.deepEqual(firstDemo.datasets, []);

  const second = await manager.getAllDatasets();
  assert.equal(
    second.find(entry => entry.sourceType === 'local-demo').error,
    firstDemo.error,
    'the cached failure must be republished, not re-fetched',
  );
  assert.equal(fetchCalls, 1);
  assert.equal(manager.hasActiveDataset(), false);

  // Only an explicit retry clears it, and it costs exactly one more request.
  await manager.getAllDatasets({ refresh: true });
  assert.equal(fetchCalls, 2);
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

test('every dataset artifact is revalidated, so a deploy is never half-seen', async t => {
  // A re-export at the same URL renumbers payload paths: var/3.values.u8.gz
  // can hold another gene with the same byte length. A cached copy reused
  // without asking the origin would show it under the new manifest's name, so
  // catalogs, manifests, payloads and presets are all fetched with no-cache,
  // and a caller cannot choose another mode.
  installSampleBrowser(t);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(new Uint8Array(0), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await fetchSampleArtifact(`${SAMPLE_ROOT}suo/var/3.values.u8.gz`);
  await fetchSampleArtifact('https://raw.githubusercontent.com/o/r/main/exports/a/obs/0.codes.u8.gz');
  await fetchSampleArtifact(`${SAMPLE_ROOT}datasets.json`, { signal: new AbortController().signal });
  assert.deepEqual(calls.map(call => call.init.cache), ['no-cache', 'no-cache', 'no-cache']);
  assert.equal(DATASET_ARTIFACT_CACHE, 'no-cache');

  for (const cache of ['force-cache', 'default', 'no-store', 'reload', 'no-cache']) {
    await assert.rejects(
      fetchSampleArtifact(`${SAMPLE_ROOT}suo/obs/0.values.f32`, { cache }),
      /always revalidated/,
      cache
    );
    await assert.rejects(
      fetchSampleArtifact('https://example.test/exports/a/var/0.values.f32', { cache }),
      /always revalidated/,
      cache
    );
  }
  assert.equal(calls.length, 3);

  const { readFile } = await import('node:fs/promises');
  for (const file of ['app/main.js', 'data/data-loaders.js', 'data/data-source.js']) {
    const source = await readFile(new URL(`../assets/js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /cache: 'force-cache'/, file);
  }
});
