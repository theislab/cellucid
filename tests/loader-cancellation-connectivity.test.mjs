import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { connectivityEdgesOf } from '../assets/js/data/sparse-utils.js';

const isAbortError = error => error?.name === 'AbortError';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/**
 * Observe a request without ever waiting on it.
 *
 * A dropped cancellation leaves requests pending forever, so every assertion
 * here reads a recorded outcome instead of awaiting one.
 */
function trackOutcome(promise) {
  const outcome = { reason: undefined, status: 'pending', value: undefined };
  promise.then(
    value => {
      outcome.status = 'fulfilled';
      outcome.value = value;
    },
    reason => {
      outcome.status = 'rejected';
      outcome.reason = reason;
    }
  );
  return outcome;
}

/**
 * Let every already-scheduled microtask, abort listener, and timer callback
 * run so background work that survived a cancellation can be observed.
 */
async function settleBackgroundWork() {
  for (let round = 0; round < 20; round++) {
    await Promise.resolve();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let round = 0; round < 20; round++) {
    await Promise.resolve();
  }
}

/**
 * One dense ring graph behind a gated loader read.
 *
 * The connectivity payload is exposed through a getter, so the scenario counts
 * every read of the matrix. The reader extracts the edges where it holds the
 * matrix (the AnnData reader worker in the browser), off the page, so a read
 * already under way finishes there; what cancellation owes the page is that
 * nothing is published and nothing is left in flight.
 */
function createGatedConnectivityLoader(nCells = 6) {
  const matrix = new Float32Array(nCells * nCells);
  for (let index = 0; index < nCells; index++) {
    const next = (index + 1) % nCells;
    matrix[index * nCells + next] = 1;
    matrix[next * nCells + index] = 1;
  }

  const state = {
    gates: [],
    loaderCalls: 0,
    matrixReads: 0,
  };

  const loader = {
    nObs: nCells,
    hasExpressionMatrix: false,
    clearCache() {},
    close() {},
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      const gate = deferred();
      state.gates.push(gate);
      state.loaderCalls++;
      await gate.promise;
      return {
        format: 'dense',
        shape: [nCells, nCells],
        get data() {
          state.matrixReads++;
          return matrix;
        },
      };
    },
  };

  return {
    expectedEdges: nCells,
    loader,
    async loaderStarted(index = 0) {
      for (let round = 0; round < 10 && state.gates.length <= index; round++) {
        await settleBackgroundWork();
      }
      assert.ok(
        state.gates.length > index,
        `loader read ${index} never started`
      );
    },
    openGate(index = 0) {
      state.gates[index].resolve();
    },
    state,
  };
}

test(
  'a cancelled connectivity request publishes nothing and leaves nothing in flight',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);
    const controller = new AbortController();

    const outcome = trackOutcome(
      adapter.getConnectivityEdges({ signal: controller.signal })
    );

    await scenario.loaderStarted();
    assert.equal(
      scenario.state.loaderCalls,
      1,
      'the loader read must start before the cancellation'
    );

    controller.abort();
    await settleBackgroundWork();
    assert.equal(
      outcome.status,
      'rejected',
      'a cancelled caller must be released without waiting for the read'
    );
    assert.ok(
      isAbortError(outcome.reason),
      `expected an AbortError, received ${String(outcome.reason)}`
    );

    // The reader's read and extraction, off the page, still complete.
    scenario.openGate();
    await settleBackgroundWork();

    assert.equal(
      adapter._connectivityCache.has('connectivities'),
      false,
      'a cancelled extraction must publish no adapter payload'
    );
    assert.equal(
      adapter._connectivityInFlight.size,
      0,
      'a cancelled extraction must release its in-flight entry'
    );
  }
);

test(
  'a pre-cancelled connectivity request never reaches the loader',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);
    const controller = new AbortController();
    controller.abort();

    const outcome = trackOutcome(
      adapter.getConnectivityEdges({ signal: controller.signal })
    );
    await settleBackgroundWork();

    assert.equal(outcome.status, 'rejected');
    assert.ok(isAbortError(outcome.reason));
    assert.equal(
      scenario.state.loaderCalls,
      0,
      'a pre-cancelled request must not start loader work'
    );
    assert.equal(scenario.state.matrixReads, 0);
    assert.equal(adapter._connectivityCache.has('connectivities'), false);
    assert.equal(adapter._connectivityInFlight.size, 0);
  }
);

test(
  'a connectivity request that is not cancelled is unaffected',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);
    const controller = new AbortController();

    const request = adapter.getConnectivityEdges({
      signal: controller.signal,
    });
    await scenario.loaderStarted();
    scenario.openGate();

    const edges = await request;
    assert.equal(edges.nEdges, scenario.expectedEdges);
    assert.equal(edges.nCells, scenario.loader.nObs);
    assert.ok(
      scenario.state.matrixReads > 0,
      'a completed request must run the extraction'
    );
    assert.equal(adapter._connectivityCache.has('connectivities'), true);

    // The warm cache still answers a second request without new loader work.
    const cached = await adapter.getConnectivityEdges({
      signal: controller.signal,
    });
    assert.strictEqual(cached, edges);
    assert.equal(scenario.state.loaderCalls, 1);
  }
);

test(
  'a connectivity re-load after a cancellation succeeds from a clean adapter',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);
    const cancelled = new AbortController();

    const abandoned = trackOutcome(
      adapter.getConnectivityEdges({ signal: cancelled.signal })
    );
    await scenario.loaderStarted(0);
    cancelled.abort();
    await settleBackgroundWork();
    scenario.openGate(0);
    await settleBackgroundWork();
    assert.equal(abandoned.status, 'rejected');

    const reload = new AbortController();
    const request = adapter.getConnectivityEdges({ signal: reload.signal });
    await scenario.loaderStarted(1);
    scenario.openGate(1);

    const edges = await request;
    assert.equal(
      scenario.state.loaderCalls,
      2,
      'the re-load must run its own loader read'
    );
    assert.equal(edges.nEdges, scenario.expectedEdges);
    assert.deepEqual(Array.from(edges.sources), [0, 0, 1, 2, 3, 4]);
    assert.deepEqual(Array.from(edges.destinations), [1, 5, 2, 3, 4, 5]);
    assert.strictEqual(adapter._connectivityCache.get('connectivities'), edges);
  }
);

test(
  'one cancelled connectivity caller cannot strand a coalesced sibling',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);
    const cancelled = new AbortController();
    const retained = new AbortController();

    const abandoned = trackOutcome(
      adapter.getConnectivityEdges({ signal: cancelled.signal })
    );
    const kept = adapter.getConnectivityEdges({ signal: retained.signal });

    await scenario.loaderStarted();
    cancelled.abort();
    await settleBackgroundWork();
    scenario.openGate();

    const edges = await kept;
    assert.equal(
      scenario.state.loaderCalls,
      1,
      'coalesced callers must share exactly one loader read'
    );
    assert.equal(edges.nEdges, scenario.expectedEdges);
    assert.equal(abandoned.status, 'rejected');
    assert.ok(isAbortError(abandoned.reason));
  }
);

test(
  'an uncancellable coalesced caller keeps shared connectivity work alive',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);
    const cancelled = new AbortController();

    const identityRead = adapter.getConnectivityEdges();
    const abandoned = trackOutcome(
      adapter.getConnectivityEdges({ signal: cancelled.signal })
    );

    await scenario.loaderStarted();
    cancelled.abort();
    await settleBackgroundWork();
    scenario.openGate();

    const edges = await identityRead;
    assert.equal(edges.nEdges, scenario.expectedEdges);
    assert.equal(scenario.state.loaderCalls, 1);
    assert.equal(abandoned.status, 'rejected');
  }
);

test(
  'a cancelled warm-cache connectivity read reports cancellation',
  async () => {
    const scenario = createGatedConnectivityLoader();
    const adapter = new BaseAnnDataAdapter(scenario.loader);

    const request = adapter.getConnectivityEdges();
    await scenario.loaderStarted();
    scenario.openGate();
    const edges = await request;

    const controller = new AbortController();
    controller.abort();
    const outcome = trackOutcome(
      adapter.getConnectivityEdges({ signal: controller.signal })
    );
    await settleBackgroundWork();

    assert.equal(outcome.status, 'rejected');
    assert.ok(isAbortError(outcome.reason));
    assert.strictEqual(
      adapter._connectivityCache.get('connectivities'),
      edges,
      'a cancelled read must not disturb the warm cache'
    );
  }
);

for (const [label, SourceClass] of [
  ['H5AD', H5adDataSource],
  ['Zarr', ZarrDataSource],
]) {
  test(
    `${label} source connectivity edges forward their cancellation signal`,
    async () => {
      const scenario = createGatedConnectivityLoader();
      const adapter = new BaseAnnDataAdapter(scenario.loader);
      const source = new SourceClass();
      source._loader = scenario.loader;
      source._adapter = adapter;

      const controller = new AbortController();
      const outcome = trackOutcome(
        source.getConnectivityEdges({ signal: controller.signal })
      );

      await scenario.loaderStarted();
      controller.abort();
      await settleBackgroundWork();
      scenario.openGate();
      await settleBackgroundWork();

      assert.equal(outcome.status, 'rejected');
      assert.ok(isAbortError(outcome.reason));
      assert.equal(adapter._connectivityCache.has('connectivities'), false);
      assert.equal(adapter._connectivityInFlight.size, 0);
    }
  );

  test(
    `${label} source connectivity edges reject a pre-cancelled read`,
    async () => {
      const scenario = createGatedConnectivityLoader();
      const source = new SourceClass();
      source._loader = scenario.loader;
      source._adapter = new BaseAnnDataAdapter(scenario.loader);

      const controller = new AbortController();
      controller.abort();
      const outcome = trackOutcome(
        source.getConnectivityEdges({ signal: controller.signal })
      );
      await settleBackgroundWork();

      assert.equal(outcome.status, 'rejected');
      assert.ok(isAbortError(outcome.reason));
      assert.equal(scenario.state.loaderCalls, 0);
    }
  );

  test(
    `${label} source connectivity edges reject an unexpected options key`,
    async () => {
      const scenario = createGatedConnectivityLoader();
      const source = new SourceClass();
      source._loader = scenario.loader;
      source._adapter = new BaseAnnDataAdapter(scenario.loader);

      const outcome = trackOutcome(
        source.getConnectivityEdges({
          legacyAbort: true,
          signal: new AbortController().signal,
        })
      );
      await settleBackgroundWork();

      assert.equal(outcome.status, 'rejected');
      assert.match(String(outcome.reason?.message), /unexpected key.*legacyAbort/i);
      assert.equal(scenario.state.loaderCalls, 0);
    }
  );
}
