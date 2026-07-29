import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  settlePublishedDatasetUi
} from '../assets/js/app/dataset-reload-outcome.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function handledRejection(error) {
  const promise = Promise.reject(error);
  void promise.catch(() => {});
  return promise;
}

test(
  'published dataset UI settlement waits for synchronization and final teardown',
  async () => {
    const synchronization = deferred();
    const teardown = deferred();
    const events = [];
    let resolved = false;

    const settlement = settlePublishedDatasetUi({
      async synchronize() {
        events.push('synchronize:start');
        await synchronization.promise;
        events.push('synchronize:end');
      },
      async finalize() {
        events.push('finalize:start');
        await teardown.promise;
        events.push('finalize:end');
      },
      reportFailure: () => assert.fail('successful settlement reported failure')
    });

    assert.equal(
      typeof settlement?.then,
      'function',
      'settlement must expose completion of asynchronous UI ownership'
    );
    void settlement.then(() => {
      resolved = true;
    });

    await flushMicrotasks();
    assert.deepEqual(events, ['synchronize:start']);
    assert.equal(resolved, false);

    synchronization.resolve();
    await flushMicrotasks();
    assert.deepEqual(events, [
      'synchronize:start',
      'synchronize:end',
      'finalize:start'
    ]);
    assert.equal(
      resolved,
      false,
      'ready must not publish while UI teardown is still pending'
    );

    teardown.resolve();
    assert.deepEqual(await settlement, { status: 'ready' });
    assert.deepEqual(events, [
      'synchronize:start',
      'synchronize:end',
      'finalize:start',
      'finalize:end'
    ]);
  }
);

test(
  'rejected asynchronous synchronization still runs and awaits finalization',
  async () => {
    const synchronization = deferred();
    const teardown = deferred();
    const synchronizationError = new Error('async UI synchronization failed');
    const reports = [];
    const events = [];
    let resolved = false;

    // The current synchronous implementation ignores returned promises. Keep
    // this deliberately rejected owner handled while the red contract proves
    // that the production owner must await it.
    void synchronization.promise.catch(() => {});
    const settlement = settlePublishedDatasetUi({
      synchronize() {
        events.push('synchronize:start');
        return synchronization.promise;
      },
      async finalize() {
        events.push('finalize:start');
        await teardown.promise;
        events.push('finalize:end');
      },
      reportFailure(error) {
        reports.push(error);
        events.push('report');
      }
    });

    assert.equal(typeof settlement?.then, 'function');
    void settlement.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    assert.deepEqual(events, ['synchronize:start']);

    synchronization.reject(synchronizationError);
    await flushMicrotasks();
    assert.deepEqual(events, [
      'synchronize:start',
      'finalize:start'
    ]);
    assert.equal(resolved, false);
    assert.deepEqual(reports, []);

    teardown.resolve();
    const outcome = await settlement;
    assert.equal(outcome.status, 'ready-ui-error');
    assert.equal(outcome.error, synchronizationError);
    assert.deepEqual(reports, [synchronizationError]);
    assert.deepEqual(events, [
      'synchronize:start',
      'finalize:start',
      'finalize:end',
      'report'
    ]);
  }
);

test('asynchronous UI and finalization failures retain exact ownership', async () => {
  const synchronizationError = new Error('async selector teardown failed');
  const finalizationError = new Error('async runtime retirement failed');
  const reports = [];
  let finalizations = 0;

  const outcome = await settlePublishedDatasetUi({
    synchronize: () => handledRejection(synchronizationError),
    finalize() {
      finalizations++;
      return handledRejection(finalizationError);
    },
    reportFailure(error) {
      reports.push(error);
    }
  });

  assert.equal(finalizations, 1);
  assert.equal(outcome.status, 'ready-ui-error');
  assert.ok(outcome.error instanceof AggregateError);
  assert.deepEqual(
    outcome.error.errors,
    [synchronizationError, finalizationError]
  );
  assert.deepEqual(reports, [outcome.error]);
});

test('each asynchronous UI failure remains the exact reported error', async () => {
  const synchronizationError = new Error('async synchronization failed');
  const synchronizationReports = [];
  const synchronizationOutcome = await settlePublishedDatasetUi({
    synchronize: () => handledRejection(synchronizationError),
    finalize: async () => {},
    reportFailure: error => synchronizationReports.push(error)
  });
  assert.equal(synchronizationOutcome.error, synchronizationError);
  assert.deepEqual(synchronizationReports, [synchronizationError]);

  const finalizationError = new Error('async finalization failed');
  const finalizationReports = [];
  const finalizationOutcome = await settlePublishedDatasetUi({
    synchronize: async () => {},
    finalize: () => handledRejection(finalizationError),
    reportFailure: error => finalizationReports.push(error)
  });
  assert.equal(finalizationOutcome.error, finalizationError);
  assert.deepEqual(finalizationReports, [finalizationError]);
});

test('published dataset UI settlement awaits asynchronous failure reporting', async () => {
  const synchronizationError = new Error('async synchronization failed');
  const report = deferred();
  const events = [];
  let resolved = false;

  const settlement = settlePublishedDatasetUi({
    synchronize: () => handledRejection(synchronizationError),
    finalize: async () => {},
    async reportFailure(error) {
      assert.equal(error, synchronizationError);
      events.push('report:start');
      await report.promise;
      events.push('report:end');
    }
  });
  void settlement.then(() => {
    resolved = true;
  });

  await flushMicrotasks();
  assert.deepEqual(events, ['report:start']);
  assert.equal(
    resolved,
    false,
    'settlement must not publish ready while failure reporting is pending'
  );

  report.resolve();
  const outcome = await settlement;
  assert.equal(outcome.status, 'ready-ui-error');
  assert.equal(outcome.error, synchronizationError);
  assert.deepEqual(events, ['report:start', 'report:end']);
});

test('failure reporting cannot erase the published UI lifecycle failure', async () => {
  const synchronizationError = new Error('exact UI synchronization failure');
  const reportingError = new Error('exact UI failure reporting failure');

  await assert.rejects(
    settlePublishedDatasetUi({
      synchronize: () => handledRejection(synchronizationError),
      finalize: async () => {},
      reportFailure: () => handledRejection(reportingError)
    }),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [
        synchronizationError,
        reportingError
      ]);
      return true;
    }
  );
});

test('main awaits every published dataset UI settlement owner', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const settlementCalls = [
    ...mainSource.matchAll(/\bsettlePublishedDatasetUi\s*\(\{/g)
  ];
  assert.equal(
    settlementCalls.length,
    3,
    'all direct publication settlement owners must remain explicit'
  );
  for (const call of settlementCalls) {
    const lineStart = mainSource.lastIndexOf('\n', call.index) + 1;
    assert.match(
      mainSource.slice(lineStart, call.index),
      /\bawait\s*$/,
      'a direct settlement owner must finish before publication continues'
    );
  }

  assert.match(
    mainSource,
    /async function synchronizePublishedDatasetUi\s*\(/
  );
  const synchronizationCalls = [
    ...mainSource.matchAll(/\bsynchronizePublishedDatasetUi\s*\(/g)
  ];
  assert.equal(
    synchronizationCalls.length,
    3,
    'the helper declaration and its two publication callers must stay exact'
  );
  for (const call of synchronizationCalls.slice(1)) {
    const lineStart = mainSource.lastIndexOf('\n', call.index) + 1;
    assert.match(
      mainSource.slice(lineStart, call.index),
      /\bawait\s*$/,
      'callers must await the helper-owned settlement promise'
    );
  }
});
