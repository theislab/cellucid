import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertDatasetStateManifest,
  classifyAdvertisedDatasetStateRestoreError,
  loadCurrentDatasetStateTarget,
  restoreCurrentDatasetState,
} from '../assets/js/app/session/dataset-state-manifest.js';
import {
  createSessionRestoreCanceledError,
} from '../assets/js/app/session/session-serializer.js';

const STATE_BYTES = Uint8Array.from([1, 2, 3, 4]);
const STATE_SHA256 = createHash('sha256').update(STATE_BYTES).digest('hex');
const FIXED_PUBLICATION_REVISION = () => 11;

test('advertised state user cancel has one non-error ready outcome', () => {
  const canceled = createSessionRestoreCanceledError();
  assert.deepEqual(
    classifyAdvertisedDatasetStateRestoreError(canceled, {
      ownerAborted: false,
    }),
    { status: 'ready-state-canceled' },
  );
  assert.deepEqual(
    classifyAdvertisedDatasetStateRestoreError(canceled, {
      ownerAborted: true,
    }),
    { status: 'superseded' },
  );
  assert.equal(
    classifyAdvertisedDatasetStateRestoreError(
      new Error('genuine state failure'),
      { ownerAborted: false },
    ),
    null,
  );
});

function createManager({
  sourceType = 'local-demo',
  baseUrl = 'https://datasets.example/exports/suo/',
  manifestUrl =
    'https://datasets.example/exports/suo/state-snapshots.json',
  datasetId = 'suo',
  identityId = 'suo-generation',
  selectionRevision = 7,
  stateSha256 = STATE_SHA256,
  advertised = true,
} = {}) {
  let descriptor = (
    sourceType === 'local-demo'
    && advertised
  )
    ? {
        baseUrl,
        datasetId,
        identityId,
        manifestUrl,
        selectionRevision,
        sourceType,
        stateSha256,
      }
    : null;
  return {
    getCurrentStateDescriptor() {
      return descriptor;
    },
    replaceDescriptor(nextDescriptor) {
      descriptor = nextDescriptor;
    },
  };
}

function createFetchArtifact(responses) {
  const queue = [...responses];
  const calls = [];
  const fetchArtifact = async (url, init) => {
    calls.push({ url, init });
    assert.ok(queue.length > 0, `Unexpected state request: ${url}`);
    return queue.shift();
  };
  return { calls, fetchArtifact };
}

function manifestResponse(value = {
  states: ['default.cellucid-session'],
}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('dataset state manifests expose one exact current default bundle', () => {
  assert.deepEqual(
    assertDatasetStateManifest({
      states: ['default.cellucid-session'],
    }),
    { states: ['default.cellucid-session'] },
  );

  for (const invalid of [
    [],
    { files: ['default.cellucid-session'] },
    { snapshots: ['default.cellucid-session'] },
    { states: [] },
    { states: ['default.cellucid-session', 'second.cellucid-session'] },
    { states: ['../default.cellucid-session'] },
    { states: ['other.cellucid-session'] },
    {
      states: ['default.cellucid-session'],
      default: 'default.cellucid-session',
    },
  ]) {
    assert.throws(
      () => assertDatasetStateManifest(invalid),
      /state manifest|states|default\.cellucid-session|exact/i,
    );
  }
});

test('current local demos resolve one exact bounded state manifest', async () => {
  const manager = createManager();
  const controller = new AbortController();
  const transport = createFetchArtifact([manifestResponse()]);
  const target = await loadCurrentDatasetStateTarget({
    dataSourceManager: manager,
    fetchArtifact: transport.fetchArtifact,
    signal: controller.signal,
  });

  assert.deepEqual(target, {
    baseUrl: 'https://datasets.example/exports/suo/',
    datasetId: 'suo',
    identityId: 'suo-generation',
    manifestUrl:
      'https://datasets.example/exports/suo/state-snapshots.json',
    selectionRevision: 7,
    sourceType: 'local-demo',
    stateSha256: STATE_SHA256,
    stateUrl:
      'https://datasets.example/exports/suo/default.cellucid-session',
  });
  assert.deepEqual(transport.calls, [{
    url: 'https://datasets.example/exports/suo/state-snapshots.json',
    init: {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      method: 'GET',
      signal: controller.signal,
    },
  }]);
});

test('unadvertised and non-demo sources never probe for publication state', async () => {
  for (const manager of [
    createManager({ sourceType: 'github-repo' }),
    createManager({ sourceType: 'jupyter' }),
    createManager({ sourceType: 'local-user' }),
    createManager({ sourceType: 'remote' }),
    createManager({ advertised: false }),
  ]) {
    const transport = createFetchArtifact([]);
    assert.equal(
      await loadCurrentDatasetStateTarget({
        dataSourceManager: manager,
        fetchArtifact: transport.fetchArtifact,
        signal: new AbortController().signal,
      }),
      null,
    );
    assert.equal(transport.calls.length, 0);
  }
});

test('state URLs cannot escape the exact advertised dataset generation', async () => {
  const manager = createManager({
    manifestUrl:
      'https://attacker.example/other/state-snapshots.json?redirected=1',
  });
  const transport = createFetchArtifact([]);
  await assert.rejects(
    loadCurrentDatasetStateTarget({
      dataSourceManager: manager,
      fetchArtifact: transport.fetchArtifact,
      signal: new AbortController().signal,
    }),
    /exact dataset.*state-snapshots\.json|manifest URL/i,
  );
  assert.equal(transport.calls.length, 0);
});

test('a verified local-demo state refreshes UI only after exact restore', async () => {
  const manager = createManager();
  const transport = createFetchArtifact([
    manifestResponse(),
    new Response(STATE_BYTES, { status: 200 }),
  ]);
  const calls = [];
  const controller = new AbortController();
  const restored = await restoreCurrentDatasetState({
    dataSourceManager: manager,
    fetchArtifact: transport.fetchArtifact,
    getPublicationRevision: FIXED_PUBLICATION_REVISION,
    refreshUi() {
      calls.push('refresh');
    },
    sessionSerializer: {
      async restorePublishedDefaultState(blob, options) {
        calls.push([
          'restore',
          Array.from(new Uint8Array(await blob.arrayBuffer())),
          { signal: options.signal },
        ]);
        await options.refreshUi({ phase: 'commit' });
      },
    },
    signal: controller.signal,
  });

  assert.equal(restored, true);
  assert.deepEqual(calls, [
    [
      'restore',
      Array.from(STATE_BYTES),
      { signal: controller.signal },
    ],
    'refresh',
  ]);
  assert.equal(transport.calls.length, 2);
  assert.equal(
    transport.calls[1].url,
    'https://datasets.example/exports/suo/default.cellucid-session',
  );
  assert.deepEqual(transport.calls[1].init, {
    cache: 'no-store',
    headers: { accept: 'application/octet-stream' },
    method: 'GET',
    signal: controller.signal,
  });
});

test('caller abort reaches the session owner before stale state can apply', async () => {
  const manager = createManager();
  const transport = createFetchArtifact([
    manifestResponse(),
    new Response(STATE_BYTES, { status: 200 }),
  ]);
  const controller = new AbortController();
  let restoreApplied = false;
  let rollbackRefreshes = 0;
  let restoreStarted;
  const started = new Promise(resolve => {
    restoreStarted = resolve;
  });
  const restorePromise = restoreCurrentDatasetState({
    dataSourceManager: manager,
    fetchArtifact: transport.fetchArtifact,
    getPublicationRevision: FIXED_PUBLICATION_REVISION,
    refreshUi() {
      rollbackRefreshes += 1;
    },
    sessionSerializer: {
      async restorePublishedDefaultState(
        _blob,
        { refreshUi, signal },
      ) {
        restoreStarted();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', async () => {
            try {
              await refreshUi({ phase: 'rollback' });
              reject(new DOMException('Aborted', 'AbortError'));
            } catch (error) {
              reject(error);
            }
          }, { once: true });
        });
        restoreApplied = true;
      },
    },
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(restorePromise, { name: 'AbortError' });
  assert.equal(restoreApplied, false);
  assert.equal(rollbackRefreshes, 1);
});

test('same-id runtime and selection replacements reject before state mutation', async () => {
  for (const replacementKind of ['runtime', 'selection']) {
    const manager = createManager();
    let publicationRevision = 11;
    let stateRequestCount = 0;
    let restoreCalls = 0;
    const fetchArtifact = async url => {
      if (url.endsWith('/state-snapshots.json')) {
        return manifestResponse();
      }
      stateRequestCount++;
      if (replacementKind === 'runtime') {
        publicationRevision++;
      } else {
        manager.replaceDescriptor({
          ...manager.getCurrentStateDescriptor(),
          selectionRevision: 8,
        });
      }
      return new Response(STATE_BYTES, { status: 200 });
    };

    await assert.rejects(
      restoreCurrentDatasetState({
        dataSourceManager: manager,
        fetchArtifact,
        getPublicationRevision: () => publicationRevision,
        refreshUi() {
          throw new Error('stale state must not refresh');
        },
        sessionSerializer: {
          async restorePublishedDefaultState() {
            restoreCalls++;
          },
        },
        signal: new AbortController().signal,
      }),
      replacementKind === 'runtime'
        ? /dataset runtime changed/i
        : /dataset generation changed/i,
    );
    assert.equal(stateRequestCount, 1);
    assert.equal(restoreCalls, 0);
  }
});

test('dataset state manifest and integrity failures remain public failures', async () => {
  const httpTransport = createFetchArtifact([
    new Response('missing', { status: 404 }),
  ]);
  await assert.rejects(
    loadCurrentDatasetStateTarget({
      dataSourceManager: createManager(),
      fetchArtifact: httpTransport.fetchArtifact,
      signal: new AbortController().signal,
    }),
    /state-snapshots\.json.*404/i,
  );

  const malformedTransport = createFetchArtifact([
    manifestResponse({ files: ['default.cellucid-session'] }),
  ]);
  await assert.rejects(
    loadCurrentDatasetStateTarget({
      dataSourceManager: createManager(),
      fetchArtifact: malformedTransport.fetchArtifact,
      signal: new AbortController().signal,
    }),
    /state manifest|states|exact/i,
  );

  const oversizedTransport = createFetchArtifact([
    new Response(' '.repeat(4097), { status: 200 }),
  ]);
  await assert.rejects(
    loadCurrentDatasetStateTarget({
      dataSourceManager: createManager(),
      fetchArtifact: oversizedTransport.fetchArtifact,
      signal: new AbortController().signal,
    }),
    /4096 bytes/i,
  );

  const corruptStateTransport = createFetchArtifact([
    manifestResponse(),
    new Response(Uint8Array.from([9, 9, 9]), { status: 200 }),
  ]);
  await assert.rejects(
    restoreCurrentDatasetState({
      dataSourceManager: createManager(),
      fetchArtifact: corruptStateTransport.fetchArtifact,
      getPublicationRevision: FIXED_PUBLICATION_REVISION,
      refreshUi() {},
      sessionSerializer: {
        async restorePublishedDefaultState() {
          throw new Error('integrity must reject before session restore');
        },
      },
      signal: new AbortController().signal,
    }),
    /SHA-256/i,
  );

  const oversizedStateTransport = createFetchArtifact([
    manifestResponse(),
    new Response(new Uint8Array(32769), { status: 200 }),
  ]);
  await assert.rejects(
    restoreCurrentDatasetState({
      dataSourceManager: createManager(),
      fetchArtifact: oversizedStateTransport.fetchArtifact,
      getPublicationRevision: FIXED_PUBLICATION_REVISION,
      refreshUi() {},
      sessionSerializer: {
        async restorePublishedDefaultState() {
          throw new Error('size must reject before session restore');
        },
      },
      signal: new AbortController().signal,
    }),
    /32768 bytes/i,
  );
});
