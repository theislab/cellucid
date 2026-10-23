/**
 * The default view a dataset catalog names for a dataset (`datasets.json`
 * `session`): one `.cellucid-session` file, pinned by its byte length and
 * SHA-256, fetched and applied when the dataset opens from the catalog.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  classifyAdvertisedDatasetStateRestoreError,
  restoreCurrentDatasetState,
} from '../assets/js/app/session/catalog-default-session.js';
import {
  createSessionRestoreCanceledError,
} from '../assets/js/app/session/session-serializer.js';
import {
  STARTUP_STALL_CODE,
  createStartupPhaseOwner,
} from '../assets/js/app/startup-phase.js';

const STATE_BYTES = Uint8Array.from([1, 2, 3, 4]);
const STATE_SHA256 = createHash('sha256').update(STATE_BYTES).digest('hex');
const FIXED_PUBLICATION_REVISION = () => 11;
const SESSION_URL = 'https://datasets.example/anndata/suo.cellucid-session';

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
  sessionUrl = SESSION_URL,
  datasetId = 'suo',
  identityId = 'suo',
  selectionRevision = 7,
  sessionSha256 = STATE_SHA256,
  sessionBytes = STATE_BYTES.byteLength,
  advertised = true,
} = {}) {
  let descriptor = advertised
    ? {
        datasetId,
        identityId,
        selectionRevision,
        sessionBytes,
        sessionSha256,
        sessionUrl,
        sourceType,
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

// Past startup, a request step is the request itself under the restore's
// own signal.
const directRequestStep = (_url, operation) =>
  operation(new AbortController().signal);

/**
 * The request carries the exact transport options and a signal that follows
 * the restore owner (the request step may abort it too).
 */
function assertRequestInit(init, accept, owner) {
  const { signal, ...options } = init;
  assert.deepEqual(options, {
    headers: { accept },
    method: 'GET',
  });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  owner.abort();
  assert.equal(signal.aborted, true);
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

function restoreWith(manager, transport) {
  return restoreCurrentDatasetState({
    dataSourceManager: manager,
    fetchArtifact: transport.fetchArtifact,
    requestStep: directRequestStep,
    getPublicationRevision: FIXED_PUBLICATION_REVISION,
    refreshUi() {
      throw new Error('nothing to refresh');
    },
    sessionSerializer: {
      async restorePublishedDefaultState() {
        throw new Error('nothing to restore');
      },
    },
    signal: new AbortController().signal,
  });
}

test('a dataset without a catalog session never requests one', async () => {
  const manager = createManager({ advertised: false });
  const transport = createFetchArtifact([]);
  assert.equal(await restoreWith(manager, transport), false);
  assert.equal(transport.calls.length, 0);
});

test('a session descriptor must be exact before any request', async t => {
  for (const [name, options, error] of [
    ['a source without catalogs', { sourceType: 'local-user' }, /local-demo or link/],
    ['a non-HTTP session URL', { sessionUrl: 'file:///tmp/a.cellucid-session' }, /HTTP\(S\) URL/],
    ['a credentialed session URL', { sessionUrl: 'https://user:pw@datasets.example/a.cellucid-session' }, /canonical HTTP\(S\) URL/],
    ['an uppercase digest', { sessionSha256: STATE_SHA256.toUpperCase() }, /SHA-256/],
    ['a zero byte length', { sessionBytes: 0 }, /byte length/],
  ]) {
    await t.test(name, async () => {
      const transport = createFetchArtifact([]);
      await assert.rejects(restoreWith(createManager(options), transport), error);
      assert.equal(transport.calls.length, 0);
    });
  }
});

test('a verified catalog session refreshes UI only after exact restore', async () => {
  const manager = createManager();
  const transport = createFetchArtifact([
    new Response(STATE_BYTES, { status: 200 }),
  ]);
  const calls = [];
  const controller = new AbortController();
  const restored = await restoreCurrentDatasetState({
    dataSourceManager: manager,
    fetchArtifact: transport.fetchArtifact,
    requestStep: directRequestStep,
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
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0].url,
    SESSION_URL,
  );
  assertRequestInit(
    transport.calls[0].init,
    'application/octet-stream',
    controller,
  );
});

test('caller abort reaches the session owner before stale state can apply', async () => {
  const manager = createManager();
  const transport = createFetchArtifact([
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
    requestStep: directRequestStep,
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
    const fetchArtifact = async () => {
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
        requestStep: directRequestStep,
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

test('session integrity failures remain public failures', async () => {
  const corruptStateTransport = createFetchArtifact([
    new Response(Uint8Array.from([9, 9, 9, 9]), { status: 200 }),
  ]);
  await assert.rejects(
    restoreCurrentDatasetState({
      dataSourceManager: createManager(),
      fetchArtifact: corruptStateTransport.fetchArtifact,
      requestStep: directRequestStep,
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

  // The catalog declares the state's exact length: a shorter state is
  // refused by length, a longer one is cut off past the declared length.
  const shortStateTransport = createFetchArtifact([
    new Response(Uint8Array.from([1, 2, 3]), { status: 200 }),
  ]);
  await assert.rejects(
    restoreCurrentDatasetState({
      dataSourceManager: createManager(),
      fetchArtifact: shortStateTransport.fetchArtifact,
      requestStep: directRequestStep,
      getPublicationRevision: FIXED_PUBLICATION_REVISION,
      refreshUi() {},
      sessionSerializer: {
        async restorePublishedDefaultState() {
          throw new Error('length must reject before session restore');
        },
      },
      signal: new AbortController().signal,
    }),
    /3 bytes; the catalog declares 4/,
  );

  const oversizedStateTransport = createFetchArtifact([
    new Response(new Uint8Array(5), { status: 200 }),
  ]);
  await assert.rejects(
    restoreCurrentDatasetState({
      dataSourceManager: createManager(),
      fetchArtifact: oversizedStateTransport.fetchArtifact,
      requestStep: directRequestStep,
      getPublicationRevision: FIXED_PUBLICATION_REVISION,
      refreshUi() {},
      sessionSerializer: {
        async restorePublishedDefaultState() {
          throw new Error('size must reject before session restore');
        },
      },
      signal: new AbortController().signal,
    }),
    /4 bytes/i,
  );
});

function stalledFetch(signals) {
  return (url, init) => {
    signals.push(init.signal);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(init.signal.reason),
        { once: true },
      );
    });
  };
}

function stallingBodyResponse() {
  return new Response(new ReadableStream({ pull() {} }), { status: 200 });
}

test('a stalled startup session request ends at the startup deadline naming phase and URL', async () => {
  for (const [stalledUrl, fetchFor] of [
    [SESSION_URL, signals => stalledFetch(signals)],
    [
      SESSION_URL,
      signals => (url, init) => {
        // The state response arrives, but its body never ends.
        signals.push(init.signal);
        return Promise.resolve(stallingBodyResponse());
      },
    ],
  ]) {
    const root = { dataset: {} };
    const startup = createStartupPhaseOwner({ root, deadlineMs: 20 });
    const signals = [];
    await assert.rejects(
      restoreCurrentDatasetState({
        dataSourceManager: createManager(),
        fetchArtifact: fetchFor(signals),
        getPublicationRevision: FIXED_PUBLICATION_REVISION,
        refreshUi() {
          throw new Error('a stalled restore must not refresh');
        },
        requestStep: (url, operation) =>
          startup.step('session', url, operation),
        sessionSerializer: {
          async restorePublishedDefaultState() {
            throw new Error('a stalled restore must not apply');
          },
        },
        signal: new AbortController().signal,
      }),
      error => {
        assert.equal(error.code, STARTUP_STALL_CODE);
        assert.equal(error.phase, 'session');
        assert.equal(error.target, stalledUrl);
        assert.match(
          error.message,
          /reading the published default session: .* did not answer within 0\.02 s/,
        );
        return true;
      },
    );
    assert.equal(root.dataset.startupPhase, 'session');
    assert.ok(signals.length > 0);
    assert.equal(signals.at(-1).aborted, true, 'the stalled request is aborted');
  }
});
