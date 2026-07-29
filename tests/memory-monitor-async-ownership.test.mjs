import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryMonitor,
} from '../assets/js/app/analysis/shared/memory-monitor.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function isThenable(value) {
  return value !== null && typeof value?.then === 'function';
}

function createTestMonitor() {
  const monitor = createMemoryMonitor();
  monitor.setShowNotifications(false);
  monitor._notifications = {
    show() {
      throw new Error('disabled test notifications must not be shown');
    },
  };
  return monitor;
}

function rejectedThenable(error) {
  return {
    then(_onFulfilled, onRejected) {
      if (typeof onRejected === 'function') {
        return onRejected(error);
      }
      return undefined;
    },
  };
}

function rejectionObservationProbe(error) {
  let observationCount = 0;
  const observe = onRejected => {
    observationCount += 1;
    return typeof onRejected === 'function'
      ? onRejected(error)
      : undefined;
  };

  return {
    then(_onFulfilled, onRejected) {
      return observe(onRejected);
    },
    catch(onRejected) {
      return observe(onRejected);
    },
    get observationCount() {
      return observationCount;
    },
  };
}

test(
  'MemoryMonitor cleanup awaits async handlers before measuring memory or settling',
  async () => {
    const monitor = createTestMonitor();
    const cleanupGate = deferred();
    const events = [];
    let handlerFinished = false;

    monitor.getMemoryUsage = () => {
      events.push(handlerFinished ? 'measure:after' : 'measure:before');
      const usedMB = handlerFinished ? 40 : 100;
      return {
        available: true,
        usedJSHeapSize: usedMB * 1024 * 1024,
        totalJSHeapSize: 200 * 1024 * 1024,
        jsHeapSizeLimit: 400 * 1024 * 1024,
        usedMB,
        totalMB: 200,
        limitMB: 400,
        percentUsed: usedMB / 4,
      };
    };
    monitor.registerCleanupHandler('async-owner', async reason => {
      assert.equal(reason, 'threshold');
      events.push('handler:start');
      await cleanupGate.promise;
      handlerFinished = true;
      events.push('handler:done');
    });

    const cleanupTask = monitor.performCleanup('threshold');
    let settled = false;
    Promise.resolve(cleanupTask).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();

    const taskWasThenable = isThenable(cleanupTask);
    const settledBeforeHandler = settled;
    const eventsBeforeHandler = [...events];

    cleanupGate.resolve();
    const result = await Promise.resolve(cleanupTask);
    await Promise.resolve();

    assert.equal(taskWasThenable, true, 'async cleanup must expose its owned task');
    assert.equal(settledBeforeHandler, false);
    assert.deepEqual(eventsBeforeHandler, [
      'measure:before',
      'handler:start',
    ]);
    assert.deepEqual(events, [
      'measure:before',
      'handler:start',
      'handler:done',
      'measure:after',
    ]);
    assert.equal(result.handlersRun, 1);
    assert.equal(result.beforeMB, 100);
    assert.equal(result.afterMB, 40);
    assert.equal(result.freedMB, 60);
  },
);

test('MemoryMonitor propagates the exact sole async cleanup rejection', async () => {
  const monitor = createTestMonitor();
  const exactFailure = new TypeError('exact asynchronous cleanup failure');
  monitor.registerCleanupHandler(
    'sole-failure',
    () => rejectedThenable(exactFailure),
  );

  await assert.rejects(
    Promise.resolve(monitor.performCleanup('manual')),
    error => error === exactFailure,
  );
});

test('MemoryMonitor aggregates every distinct async cleanup rejection once', async () => {
  const monitor = createTestMonitor();
  const firstFailure = new Error('first cleanup failure');
  const secondFailure = new RangeError('second cleanup failure');
  monitor.registerCleanupHandler(
    'first-failure',
    () => rejectedThenable(firstFailure),
  );
  monitor.registerCleanupHandler(
    'second-failure',
    () => rejectedThenable(secondFailure),
  );

  await assert.rejects(
    Promise.resolve(monitor.performCleanup('critical')),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [firstFailure, secondFailure]);
      return true;
    },
  );
});

test(
  'MemoryMonitor coalesces concurrent cleanup requests for the same pressure reason',
  async () => {
    const monitor = createTestMonitor();
    const cleanupGate = deferred();
    let handlerStarts = 0;
    monitor.registerCleanupHandler('shared-owner', async reason => {
      assert.equal(reason, 'threshold');
      handlerStarts += 1;
      await cleanupGate.promise;
    });

    const firstTask = monitor.performCleanup('threshold');
    const secondTask = monitor.performCleanup('threshold');
    await Promise.resolve();

    const bothTasksWereOwned = isThenable(firstTask) && isThenable(secondTask);
    const startsBeforeRelease = handlerStarts;
    cleanupGate.resolve();
    const [firstResult, secondResult] = await Promise.all([
      Promise.resolve(firstTask),
      Promise.resolve(secondTask),
    ]);

    assert.equal(bothTasksWereOwned, true);
    assert.equal(startsBeforeRelease, 1);
    assert.equal(handlerStarts, 1);
    assert.equal(firstResult.reason, 'threshold');
    assert.equal(secondResult.reason, 'threshold');
  },
);

test(
  'MemoryMonitor serializes different cleanup reasons through one handler owner',
  async () => {
    const monitor = createTestMonitor();
    const thresholdGate = deferred();
    const events = [];
    let activeHandlers = 0;
    let maximumConcurrency = 0;
    monitor.registerCleanupHandler('non-reentrant-owner', async reason => {
      activeHandlers++;
      maximumConcurrency = Math.max(maximumConcurrency, activeHandlers);
      events.push(`${reason}:start`);
      if (reason === 'threshold') await thresholdGate.promise;
      events.push(`${reason}:end`);
      activeHandlers--;
    });

    const thresholdTask = monitor.performCleanup('threshold');
    const criticalTask = monitor.performCleanup('critical');
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(events, ['threshold:start']);
    thresholdGate.resolve();
    await Promise.all([thresholdTask, criticalTask]);

    assert.equal(maximumConcurrency, 1);
    assert.deepEqual(events, [
      'threshold:start',
      'threshold:end',
      'critical:start',
      'critical:end',
    ]);
  },
);

test(
  'MemoryMonitor unregister drains the exact running handler generation and prevents queued re-invocation',
  async () => {
    const monitor = createTestMonitor();
    const runningGate = deferred();
    const events = [];
    monitor.registerCleanupHandler('retiring-owner', async reason => {
      events.push(`${reason}:start`);
      await runningGate.promise;
      events.push(`${reason}:end`);
    });

    const runningCleanup = monitor.performCleanup('threshold');
    await Promise.resolve();
    const queuedCleanup = monitor.performCleanup('critical');
    const firstDrain = monitor.unregisterCleanupHandler('retiring-owner');
    const secondDrain = monitor.unregisterCleanupHandler('retiring-owner');
    let drainSettled = false;
    void firstDrain.then(() => {
      drainSettled = true;
    });
    await Promise.resolve();

    assert.equal(firstDrain, secondDrain);
    assert.equal(isThenable(firstDrain), true);
    assert.equal(monitor.getCleanupHandlerCount(), 0);
    assert.equal(drainSettled, false);
    assert.deepEqual(events, ['threshold:start']);

    runningGate.resolve();
    await Promise.all([runningCleanup, queuedCleanup, firstDrain]);

    assert.deepEqual(events, [
      'threshold:start',
      'threshold:end',
    ]);
  },
);

test(
  'MemoryMonitor unregister drain propagates the exact running handler rejection',
  async () => {
    const monitor = createTestMonitor();
    const cleanupGate = deferred();
    const exactFailure = new Error('exact retiring handler failure');
    monitor.registerCleanupHandler('failing-retirement', async () => {
      await cleanupGate.promise;
      throw exactFailure;
    });

    const cleanupTask = monitor.performCleanup('manual');
    await Promise.resolve();
    const drainTask = monitor.unregisterCleanupHandler('failing-retirement');
    cleanupGate.resolve();

    await assert.rejects(cleanupTask, error => error === exactFailure);
    await assert.rejects(drainTask, error => error === exactFailure);
  },
);

test(
  'MemoryMonitor periodic fire-and-forget cleanup observes task rejection',
  { concurrency: false },
  async () => {
    const monitor = createTestMonitor();
    const cleanupFailure = new Error('periodic cleanup failure');
    const rejectionProbe = rejectionObservationProbe(cleanupFailure);
    const intervals = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;

    globalThis.setInterval = (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    };
    globalThis.clearInterval = () => {};
    monitor.performCleanup = reason => {
      assert.equal(reason, 'periodic');
      return rejectionProbe;
    };

    try {
      monitor.start({ checkInterval: 10, cleanupInterval: 20 });
      const periodicTimer = intervals.find(({ delay }) => delay === 20);
      assert.ok(periodicTimer, 'periodic cleanup timer must be installed');

      periodicTimer.callback();
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(
        rejectionProbe.observationCount,
        1,
        'the timer callback must attach an exact rejection observer',
      );
    } finally {
      monitor.stop();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  },
);

test(
  'MemoryMonitor threshold fire-and-forget cleanup observes task rejection',
  async () => {
    const monitor = createTestMonitor();
    const cleanupFailure = new Error('threshold cleanup failure');
    const rejectionProbe = rejectionObservationProbe(cleanupFailure);
    let requestedReason = null;
    monitor._maybeSampleUserAgentMemory = () => {};
    monitor.getMemoryUsage = () => ({
      available: true,
      usedJSHeapSize: 1000,
      totalJSHeapSize: 1000,
      jsHeapSizeLimit: 1000,
      usedMB: 1,
      totalMB: 1,
      limitMB: 1,
      percentUsed: 100,
    });
    monitor.performCleanup = reason => {
      requestedReason = reason;
      return rejectionProbe;
    };

    monitor._performCheck();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(requestedReason, 'critical');
    assert.equal(
      rejectionProbe.observationCount,
      1,
      'the threshold callback must attach an exact rejection observer',
    );
  },
);
