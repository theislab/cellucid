import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStableTerminalDestroy,
} from '../assets/js/app/ui/core/ui-coordinator.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test('UI teardown publishes one stable Promise before child cleanup can re-enter', async () => {
  const childDrain = createDeferred();
  const events = [];
  let reentrantPromise = null;
  let destroy = null;

  destroy = createStableTerminalDestroy({
    closeAdmission() {
      events.push('closed');
    },
    getOperations() {
      return [
        () => {
          events.push('re-entered');
          reentrantPromise = destroy();
        },
        () => {
          events.push('draining');
          return childDrain.promise;
        },
      ];
    },
    failureMessage: 'UI teardown failed.',
  });

  const terminalPromise = destroy();
  assert.strictEqual(reentrantPromise, terminalPromise);
  assert.strictEqual(destroy(), terminalPromise);
  assert.deepEqual(events, ['closed', 're-entered', 'draining']);

  let settled = false;
  terminalPromise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  childDrain.resolve();
  await terminalPromise;
  assert.equal(settled, true);
  assert.strictEqual(destroy(), terminalPromise);
});

test('UI teardown attempts every owner and aggregates exact sync and async failures', async () => {
  const syncFailure = new Error('sync cleanup failed');
  const asyncFailure = new Error('async cleanup failed');
  const operations = [];
  const destroy = createStableTerminalDestroy({
    closeAdmission() {
      operations.push('closed');
    },
    getOperations() {
      return [
        () => {
          operations.push('sync');
          throw syncFailure;
        },
        () => {
          operations.push('async');
          return Promise.reject(asyncFailure);
        },
        () => {
          operations.push('last');
        },
      ];
    },
    failureMessage: 'UI teardown failed.',
  });

  const terminalPromise = destroy();
  await assert.rejects(terminalPromise, error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'UI teardown failed.');
    assert.deepEqual(error.errors, [syncFailure, asyncFailure]);
    return true;
  });
  assert.deepEqual(operations, ['closed', 'sync', 'async', 'last']);
  assert.strictEqual(destroy(), terminalPromise);
});
