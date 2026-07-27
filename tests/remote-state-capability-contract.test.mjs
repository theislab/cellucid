import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteDataSource,
} from '../assets/js/data/remote-source.js';

const ORIGIN = 'http://127.0.0.1:8765';
const STATE_MANIFEST = 'state-snapshots.json';
const STATE_SHA256 = 'a'.repeat(64);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function identity() {
  return {
    version: 2,
    id: 'cells',
    name: 'Cells',
    description: 'Remote state capability fixture',
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

function installServer(t, entry) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, options });
    if (url === `${ORIGIN}/_cellucid/health`) {
      return jsonResponse({
        status: 'ok',
        type: 'exported',
        version: '1.2.3',
      });
    }
    if (url === `${ORIGIN}/_cellucid/info`) {
      return jsonResponse({
        version: '1.2.3',
        host: '127.0.0.1',
        port: 8765,
        mode: 'standalone',
      });
    }
    if (url === `${ORIGIN}/_cellucid/datasets`) {
      return jsonResponse({
        datasets: [typeof entry === 'function' ? entry() : entry],
      });
    }
    if (url === `${ORIGIN}/dataset_identity.json`) {
      return jsonResponse(identity());
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requests;
}

function baseEntry() {
  return { id: 'cells', path: '/', name: 'Cells' };
}

function assertZeroStateRequests(requests) {
  assert.equal(
    requests.some(({ url }) => (
      url.endsWith(`/${STATE_MANIFEST}`)
      || url.endsWith('/default.cellucid-session')
    )),
    false,
  );
}

test('remote catalogs preserve their exact three-field shape when state is absent', async t => {
  const requests = installServer(t, baseEntry());
  const source = new RemoteDataSource();

  await source.connect({ url: ORIGIN });
  const validated = await source._requestDatasetCatalog(
    ORIGIN,
    new AbortController().signal,
  );
  assert.deepEqual(validated, [baseEntry()]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated[0]), true);
  const datasets = await source.listDatasets();
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].id, 'cells');
  assertZeroStateRequests(requests);
});

test('remote catalogs accept and preserve one strict paired state capability without probing it', async t => {
  const advertised = {
    ...baseEntry(),
    state_manifest: STATE_MANIFEST,
    state_sha256: STATE_SHA256,
  };
  const requests = installServer(t, advertised);
  const source = new RemoteDataSource();

  await source.connect({ url: ORIGIN });
  const validated = await source._requestDatasetCatalog(
    ORIGIN,
    new AbortController().signal,
  );
  assert.deepEqual(validated, [advertised]);
  assert.equal(Object.isFrozen(validated[0]), true);

  const datasets = await source.listDatasets();
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].id, 'cells');
  assert.equal(source.getBaseUrl('cells'), 'remote://127.0.0.1:8765/');
  assertZeroStateRequests(requests);
});

test('remote catalogs reject partial and malformed state capabilities before adoption', async t => {
  const invalidEntries = [
    {
      label: 'manifest only',
      entry: { ...baseEntry(), state_manifest: STATE_MANIFEST },
      match: /state_manifest.*state_sha256|together|pair/i,
    },
    {
      label: 'digest only',
      entry: { ...baseEntry(), state_sha256: STATE_SHA256 },
      match: /state_manifest.*state_sha256|together|pair/i,
    },
    {
      label: 'alternate manifest',
      entry: {
        ...baseEntry(),
        state_manifest: 'other.json',
        state_sha256: STATE_SHA256,
      },
      match: /state_manifest.*state-snapshots\.json/i,
    },
    {
      label: 'manifest path',
      entry: {
        ...baseEntry(),
        state_manifest: 'states/state-snapshots.json',
        state_sha256: STATE_SHA256,
      },
      match: /state_manifest.*state-snapshots\.json/i,
    },
    {
      label: 'uppercase digest',
      entry: {
        ...baseEntry(),
        state_manifest: STATE_MANIFEST,
        state_sha256: STATE_SHA256.toUpperCase(),
      },
      match: /state_sha256.*lowercase.*sha-256/i,
    },
    {
      label: 'short digest',
      entry: {
        ...baseEntry(),
        state_manifest: STATE_MANIFEST,
        state_sha256: 'a'.repeat(63),
      },
      match: /state_sha256.*lowercase.*sha-256/i,
    },
    {
      label: 'non-string digest',
      entry: {
        ...baseEntry(),
        state_manifest: STATE_MANIFEST,
        state_sha256: 7,
      },
      match: /state_sha256.*lowercase.*sha-256/i,
    },
  ];

  let activeEntry = invalidEntries[0].entry;
  const requests = installServer(t, () => activeEntry);

  for (const candidate of invalidEntries) {
    activeEntry = candidate.entry;
    const source = new RemoteDataSource();
    await assert.rejects(
      source.connect({ url: ORIGIN }),
      candidate.match,
      candidate.label,
    );
    assert.equal(source.isConnected(), false, candidate.label);
  }
  assertZeroStateRequests(requests);
});

test('remote catalog state support does not open the entry schema', async t => {
  const requests = installServer(t, {
    ...baseEntry(),
    state_manifest: STATE_MANIFEST,
    state_sha256: STATE_SHA256,
    state_url: 'default.cellucid-session',
  });
  const source = new RemoteDataSource();

  await assert.rejects(
    source.connect({ url: ORIGIN }),
    /noncanonical fields|unsupported state_url/i,
  );
  assert.equal(source.isConnected(), false);
  assertZeroStateRequests(requests);
});
