import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';
import { withMockedFetch } from './helpers/worker-fetch.mjs';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

// GitHub's own 10 s request timeout plus a 3 s connection set-up (the Worker's comment cites both).
const WORKER_STALL_TIMEOUT_MS = 13_000;
const CALLER_ABORT_DOCUMENT = Object.freeze({
  error: 'Worker request was canceled',
});
const STALL_DOCUMENT = Object.freeze({
  error: 'Worker request stalled: nothing moved for 13 s',
});
const USER_DOCUMENT = Object.freeze({
  id: 1,
  login: 'cellucid-user',
});
const TREE_SHA = 'b'.repeat(40);
const TREE_PATH = `/api/repos/owner/repo/git/trees/${TREE_SHA}`;
const TREE_DOCUMENT_TEXT = JSON.stringify({
  tree: [{
    path: 'annotations/users/ghid_1.json',
    mode: '100644',
    type: 'blob',
    sha: 'a'.repeat(40),
    size: 123,
    url: 'https://api.github.com/repos/owner/repo/git/blobs/' +
      'a'.repeat(40),
  }],
  truncated: false,
  unknown_upstream_field: 'streamed without Worker projection',
});
const PROMISE_STILL_PENDING = Symbol('promise still pending');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function abortError(message = 'Controlled upstream abort') {
  return new DOMException(message, 'AbortError');
}

function workerRequest(path, {
  method = 'GET',
  headers = null,
  body = null,
  signal = null,
} = {}) {
  const requestHeaders = new Headers(headers ?? undefined);
  if (!requestHeaders.has('Authorization')) {
    requestHeaders.set('Authorization', 'Bearer test-token');
  }
  return new Request(`https://worker.example${path}`, {
    method,
    headers: requestHeaders,
    body,
    signal,
  });
}

function jsonResponse(document, status = 200) {
  return new Response(JSON.stringify(document), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function responseDocument(response) {
  return parseExactJson(await response.text(), {
    path: `Worker HTTP ${response.status} response`,
  });
}

function installFakeTimers() {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const records = [];

  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Fake timer callback must be a function');
    }
    const record = {
      args,
      callback,
      cleared: false,
      delay,
      fired: false,
    };
    records.push(record);
    return record;
  };
  globalThis.clearTimeout = (handle) => {
    if (records.includes(handle)) {
      handle.cleared = true;
      return;
    }
    previousClearTimeout(handle);
  };

  return {
    records,
    fire(record) {
      assert.equal(records.includes(record), true);
      assert.equal(record.cleared, false);
      assert.equal(record.fired, false);
      record.fired = true;
      record.callback(...record.args);
    },
    /** The timers armed and neither cleared nor fired: the stall clock while it runs. */
    live() {
      return records.filter(record => !record.cleared && !record.fired);
    },
    restore() {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}

function createPendingFetchHarness() {
  const called = deferred();
  const result = deferred();
  let abortEvents = 0;
  let settled = false;

  const settle = (kind, value) => {
    if (settled) return;
    settled = true;
    result[kind](value);
  };

  return {
    called: called.promise,
    fetch(url, options = {}) {
      const signal = options.signal;
      assert.ok(signal, 'Worker upstream fetch must receive a signal');
      const onAbort = () => {
        abortEvents += 1;
        settle('reject', abortError());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      called.resolve({
        abortEvents: () => abortEvents,
        signal,
        url: String(url),
      });
      return result.promise.finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    },
    resolve(response = jsonResponse(USER_DOCUMENT)) {
      settle('resolve', response);
    },
  };
}

function createStalledBodyFetchHarness() {
  const bodyPulled = deferred();
  const called = deferred();
  const encoder = new TextEncoder();
  let abortEvents = 0;
  let bodyController = null;
  let bodyState = 'open';

  return {
    bodyPulled: bodyPulled.promise,
    called: called.promise,
    fetch(url, options = {}) {
      const signal = options.signal;
      assert.ok(signal, 'Worker upstream fetch must receive a signal');
      const stream = new ReadableStream({
        start(controller) {
          bodyController = controller;
        },
        pull() {
          bodyPulled.resolve();
        },
      });
      const onAbort = () => {
        abortEvents += 1;
        if (bodyState !== 'open') return;
        bodyState = 'errored';
        bodyController.error(abortError('Controlled response-body abort'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      called.resolve({
        abortEvents: () => abortEvents,
        signal,
        url: String(url),
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    finish(document = USER_DOCUMENT) {
      if (bodyState !== 'open') return;
      bodyState = 'closed';
      bodyController.enqueue(encoder.encode(JSON.stringify(document)));
      bodyController.close();
    },
  };
}

function createStalledTreeFetchHarness() {
  const bodyPulled = deferred();
  const encoder = new TextEncoder();
  const split = Math.floor(TREE_DOCUMENT_TEXT.length / 2);
  let abortEvents = 0;
  let bodyCancellations = 0;
  let bodyController = null;
  let bodyState = 'open';
  let upstreamSignal = null;
  let onAbort = null;

  const finish = () => {
    if (bodyState !== 'open') return;
    bodyState = 'closed';
    bodyController.enqueue(
      encoder.encode(TREE_DOCUMENT_TEXT.slice(split))
    );
    bodyController.close();
    upstreamSignal?.removeEventListener('abort', onAbort);
  };

  return {
    abortEvents: () => abortEvents,
    bodyCancellations: () => bodyCancellations,
    bodyPulled: bodyPulled.promise,
    fetch(url, options = {}) {
      assert.equal(String(url), `https://api.github.com/repos/owner/repo/git/trees/${TREE_SHA}`);
      upstreamSignal = options.signal;
      assert.ok(
        upstreamSignal,
        'streamed Worker upstream fetch must receive a signal'
      );
      const stream = new ReadableStream({
        start(controller) {
          bodyController = controller;
          controller.enqueue(
            encoder.encode(TREE_DOCUMENT_TEXT.slice(0, split))
          );
        },
        pull() {
          bodyPulled.resolve();
        },
        cancel() {
          bodyCancellations += 1;
          bodyState = 'cancelled';
          upstreamSignal?.removeEventListener('abort', onAbort);
        },
      });
      onAbort = () => {
        abortEvents += 1;
        if (bodyState !== 'open') return;
        bodyState = 'errored';
        bodyController.error(
          abortError('Controlled streamed tree abort')
        );
        upstreamSignal.removeEventListener('abort', onAbort);
      };
      if (upstreamSignal.aborted) onAbort();
      else upstreamSignal.addEventListener('abort', onAbort, { once: true });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    finish,
    signal: () => upstreamSignal,
  };
}

function createOpenChunkedFetchHarness(chunks) {
  const pendingPull = deferred();
  const cancellationStarted = deferred();
  const remaining = [...chunks];
  let cancellationReason = null;
  let cancellations = 0;
  let pulls = 0;
  let upstreamSignal = null;

  return {
    cancellationReason: () => cancellationReason,
    cancellationStarted: cancellationStarted.promise,
    cancellations: () => cancellations,
    fetch(_url, options = {}) {
      upstreamSignal = options.signal;
      assert.ok(
        upstreamSignal,
        'streamed Worker upstream fetch must receive a signal'
      );
      return new Response(new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (remaining.length !== 0) {
            controller.enqueue(remaining.shift());
            return;
          }
          return pendingPull.promise;
        },
        cancel(reason) {
          cancellations += 1;
          cancellationReason = reason;
          cancellationStarted.resolve();
          pendingPull.resolve();
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    finish() {
      pendingPull.resolve();
    },
    pulls: () => pulls,
    signal: () => upstreamSignal,
  };
}

/** Let queued work run until `condition` holds (a bounded number of macrotasks, never a clock). */
async function until(condition, label) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`never reached: ${label}`);
}

async function settleBeforeImmediate(promise) {
  return Promise.race([
    promise,
    new Promise(resolve => {
      setImmediate(() => resolve(PROMISE_STILL_PENDING));
    }),
  ]);
}

function observeAbortListeners(signal) {
  const originalAddEventListener = signal.addEventListener;
  const originalRemoveEventListener = signal.removeEventListener;
  const additions = new Map();
  const removals = new Map();

  signal.addEventListener = function addEventListener(
    type,
    listener,
    options
  ) {
    if (type === 'abort') {
      additions.set(listener, (additions.get(listener) ?? 0) + 1);
    }
    return Reflect.apply(originalAddEventListener, this, [
      type,
      listener,
      options,
    ]);
  };
  signal.removeEventListener = function removeEventListener(
    type,
    listener,
    options
  ) {
    if (type === 'abort') {
      removals.set(listener, (removals.get(listener) ?? 0) + 1);
    }
    return Reflect.apply(originalRemoveEventListener, this, [
      type,
      listener,
      options,
    ]);
  };

  return {
    additions,
    removals,
    restore() {
      signal.addEventListener = originalAddEventListener;
      signal.removeEventListener = originalRemoveEventListener;
    },
  };
}

test('pre-aborted inbound request never invokes upstream fetch', async () => {
  const owner = new AbortController();
  owner.abort(abortError('Caller cancelled before dispatch'));
  let upstreamCalls = 0;

  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return jsonResponse(USER_DOCUMENT);
  }, async () => {
    const response = await worker.fetch(
      workerRequest('/auth/user', { signal: owner.signal }),
      ENV
    );
    assert.deepEqual(
      {
        document: await responseDocument(response),
        status: response.status,
        upstreamCalls,
      },
      {
        document: CALLER_ABORT_DOCUMENT,
        status: 499,
        upstreamCalls: 0,
      }
    );
  });
});

test('caller abort while fetch is pending reaches the exact upstream signal', async () => {
  const owner = new AbortController();
  const harness = createPendingFetchHarness();
  let workerPromise = null;

  await withMockedFetch(harness.fetch, async () => {
    try {
      workerPromise = worker.fetch(
        workerRequest('/auth/user', { signal: owner.signal }),
        ENV
      );
      const upstream = await harness.called;
      owner.abort(abortError('Caller cancelled pending read'));
      assert.equal(upstream.signal.aborted, true);
      assert.equal(upstream.abortEvents(), 1);

      const response = await workerPromise;
      assert.equal(response.status, 499);
      assert.deepEqual(
        await responseDocument(response),
        CALLER_ABORT_DOCUMENT
      );
    } finally {
      harness.resolve();
      if (workerPromise !== null) await workerPromise;
    }
  });
});

test('an upstream silent for a whole stall window stops the request with 504; a later caller abort changes nothing', async () => {
  const owner = new AbortController();
  const harness = createPendingFetchHarness();
  const timers = installFakeTimers();
  let workerPromise = null;

  try {
    await withMockedFetch(harness.fetch, async () => {
      workerPromise = worker.fetch(
        workerRequest('/auth/user', { signal: owner.signal }),
        ENV
      );
      const upstream = await harness.called;
      const [stall] = timers.live();
      assert.equal(timers.live().length, 1, 'the stall clock runs while the answer is awaited');
      assert.equal(stall.delay, WORKER_STALL_TIMEOUT_MS);

      timers.fire(stall);
      owner.abort(abortError('Caller cancelled after the stall'));
      const response = await workerPromise;

      assert.equal(response.status, 504);
      assert.deepEqual(await responseDocument(response), STALL_DOCUMENT);
      assert.equal(upstream.signal.aborted, true);
      assert.equal(upstream.abortEvents(), 1);
      assert.deepEqual(timers.live(), []);
    });
  } finally {
    harness.resolve();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('a caller abort first stops the stall clock, so no stall follows it', async () => {
  const owner = new AbortController();
  const harness = createPendingFetchHarness();
  const timers = installFakeTimers();
  let workerPromise = null;

  try {
    await withMockedFetch(harness.fetch, async () => {
      workerPromise = worker.fetch(
        workerRequest('/auth/user', { signal: owner.signal }),
        ENV
      );
      await harness.called;
      const [stall] = timers.live();

      owner.abort(abortError('Caller won the cancellation race'));
      assert.equal(stall.cleared, true);
      const response = await workerPromise;

      assert.equal(response.status, 499);
      assert.deepEqual(await responseDocument(response), CALLER_ABORT_DOCUMENT);
      assert.deepEqual(timers.live(), []);
    });
  } finally {
    harness.resolve();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('independent upstream AbortError is a gateway failure, not a stall', async () => {
  await withMockedFetch(async () => {
    throw abortError('Upstream aborted independently');
  }, async () => {
    const response = await worker.fetch(
      workerRequest('/auth/user'),
      ENV
    );
    const document = await responseDocument(response);
    assert.equal(response.status, 502);
    assert.deepEqual(Object.keys(document), ['error']);
    assert.equal(typeof document.error, 'string');
    assert.doesNotMatch(document.error, /stalled/i);
  });
});

test('caller abort after headers cancels stalled response-body consumption', async () => {
  const owner = new AbortController();
  const harness = createStalledBodyFetchHarness();
  let workerPromise = null;

  await withMockedFetch(harness.fetch, async () => {
    try {
      workerPromise = worker.fetch(
        workerRequest('/auth/user', { signal: owner.signal }),
        ENV
      );
      const upstream = await harness.called;
      await harness.bodyPulled;
      owner.abort(abortError('Caller cancelled during response body'));

      const propagated = upstream.signal.aborted;
      if (!propagated) harness.finish();
      const response = await workerPromise;
      assert.deepEqual(
        {
          bodyAbortEvents: upstream.abortEvents(),
          document: await responseDocument(response),
          propagated,
          status: response.status,
        },
        {
          bodyAbortEvents: 1,
          document: CALLER_ABORT_DOCUMENT,
          propagated: true,
          status: 499,
        }
      );
    } finally {
      harness.finish();
      if (workerPromise !== null) await workerPromise;
    }
  });
});

test('a response body silent for a whole stall window stops the request with 504', async () => {
  const harness = createStalledBodyFetchHarness();
  const timers = installFakeTimers();
  let workerPromise = null;

  try {
    await withMockedFetch(harness.fetch, async () => {
      workerPromise = worker.fetch(
        workerRequest('/auth/user'),
        ENV
      );
      const upstream = await harness.called;
      await harness.bodyPulled;
      // The answer's arrival was progress: its timer is gone, and a fresh one
      // runs while the body is awaited.
      await until(() => timers.records.length === 2, 'the body is awaited');
      assert.equal(timers.records[0].cleared, true);
      const [stall] = timers.live();
      assert.equal(stall, timers.records[1]);

      timers.fire(stall);
      const response = await workerPromise;

      assert.equal(response.status, 504);
      assert.deepEqual(await responseDocument(response), STALL_DOCUMENT);
      assert.equal(upstream.abortEvents(), 1);
      assert.deepEqual(timers.live(), []);
    });
  } finally {
    harness.finish();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('successful tree reads return an exact unprojected stream before the upstream body drains', async () => {
  const harness = createStalledTreeFetchHarness();
  let workerPromise = null;

  await withMockedFetch(harness.fetch, async () => {
    try {
      workerPromise = worker.fetch(
        workerRequest(TREE_PATH),
        ENV
      );
      const earlyResponse = await settleBeforeImmediate(workerPromise);
      const returnedBeforeDrain =
        earlyResponse !== PROMISE_STILL_PENDING;
      if (!returnedBeforeDrain) {
        harness.finish();
        await workerPromise;
      }
      assert.equal(
        returnedBeforeDrain,
        true,
        'tree response headers must not wait for full-body buffering'
      );
      assert.equal(earlyResponse.status, 200);
      assert.equal(earlyResponse.headers.get('content-type'), 'application/json');

      const textPromise = earlyResponse.text();
      await harness.bodyPulled;
      harness.finish();
      assert.equal(await textPromise, TREE_DOCUMENT_TEXT);
      assert.equal(harness.abortEvents(), 0);
      assert.equal(harness.bodyCancellations(), 0);
    } finally {
      harness.finish();
      if (workerPromise !== null) await workerPromise;
    }
  });
});

test('caller ownership remains active while a streamed tree response drains', async () => {
  const owner = new AbortController();
  const harness = createStalledTreeFetchHarness();
  let workerPromise = null;

  await withMockedFetch(harness.fetch, async () => {
    try {
      workerPromise = worker.fetch(
        workerRequest(TREE_PATH, { signal: owner.signal }),
        ENV
      );
      const earlyResponse = await settleBeforeImmediate(workerPromise);
      const returnedBeforeDrain =
        earlyResponse !== PROMISE_STILL_PENDING;
      if (!returnedBeforeDrain) {
        owner.abort(abortError('Caller cancelled buffered tree'));
        harness.finish();
        await workerPromise;
      }
      assert.equal(
        returnedBeforeDrain,
        true,
        'tree response must stream before caller-owned drain completes'
      );

      const bodyOutcomePromise = earlyResponse.text().then(
        value => ({ kind: 'resolved', value }),
        error => ({ error, kind: 'rejected' })
      );
      await harness.bodyPulled;
      owner.abort(abortError('Caller cancelled streamed tree drain'));
      const bodyOutcome = await settleBeforeImmediate(
        bodyOutcomePromise
      );
      if (bodyOutcome === PROMISE_STILL_PENDING) harness.finish();

      assert.notEqual(bodyOutcome, PROMISE_STILL_PENDING);
      assert.equal(bodyOutcome.kind, 'rejected');
      assert.equal(harness.signal()?.aborted, true);
      assert.equal(harness.abortEvents(), 1);
    } finally {
      harness.finish();
      if (workerPromise !== null) await workerPromise;
    }
  });
});

test('a relayed body runs the stall clock only while it waits on the upstream, never while the browser has not asked for more', async () => {
  const harness = createStalledTreeFetchHarness();
  const timers = installFakeTimers();
  let workerPromise = null;

  try {
    await withMockedFetch(harness.fetch, async () => {
      workerPromise = worker.fetch(workerRequest(TREE_PATH), ENV);
      const response = await workerPromise;
      assert.equal(response.status, 200);
      // The relay reads one chunk ahead (the first half) and stops: the
      // browser has not asked for more, so no clock runs.
      await until(() => timers.records.length === 2, 'the first chunk is read ahead');
      assert.deepEqual(timers.live(), []);

      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      // The browser asked: the relay waits on the upstream for the rest, and
      // its stall clock runs.
      await until(() => timers.live().length === 1, 'the rest is awaited');
      // The rest arrives: progress, and nothing more is awaited while the
      // browser has not read it, so no clock runs however long it waits.
      harness.finish();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(timers.live(), []);

      const rest = await reader.read();
      assert.equal(rest.done, false);
      // The browser asks again: waiting on the upstream, the clock runs; the
      // upstream ends at once, and the clock stops for good.
      assert.equal((await reader.read()).done, true);
      assert.deepEqual(timers.live(), []);
      for (const record of timers.records) assert.equal(record.delay, WORKER_STALL_TIMEOUT_MS);
    });
  } finally {
    harness.finish();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('a relayed body silent for a whole stall window ends in a stall error and stops the upstream', async () => {
  const harness = createStalledTreeFetchHarness();
  const timers = installFakeTimers();
  let workerPromise = null;

  try {
    await withMockedFetch(harness.fetch, async () => {
      workerPromise = worker.fetch(workerRequest(TREE_PATH), ENV);
      const response = await workerPromise;
      const bodyOutcomePromise = response.text().then(
        value => ({ kind: 'resolved', value }),
        error => ({ error, kind: 'rejected' })
      );
      await until(() => timers.live().length === 1, 'the rest is awaited');
      const [stall] = timers.live();
      timers.fire(stall);
      const bodyOutcome = await settleBeforeImmediate(bodyOutcomePromise);
      if (bodyOutcome === PROMISE_STILL_PENDING) harness.finish();

      assert.notEqual(bodyOutcome, PROMISE_STILL_PENDING);
      assert.equal(bodyOutcome.kind, 'rejected');
      assert.equal(bodyOutcome.error.status, 504);
      assert.equal(bodyOutcome.error.message, STALL_DOCUMENT.error);
      assert.equal(harness.signal()?.aborted, true);
      assert.equal(harness.abortEvents(), 1);
      assert.deepEqual(timers.live(), []);
    });
  } finally {
    harness.finish();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('downstream cancellation cancels its streamed upstream and releases request ownership', async () => {
  const owner = new AbortController();
  const encoder = new TextEncoder();
  const harness = createOpenChunkedFetchHarness([
    encoder.encode('{"tree":['),
  ]);
  const request = workerRequest(TREE_PATH, { signal: owner.signal });
  const listenerObserver = observeAbortListeners(request.signal);
  const timers = installFakeTimers();
  const cancellationReason = new Error(
    'Controlled downstream cancellation'
  );

  try {
    await withMockedFetch(harness.fetch, async () => {
      const response = await worker.fetch(request, ENV);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      await until(() => timers.live().length === 1, 'the relay waits on the upstream body');

      await reader.cancel(cancellationReason);
      assert.equal(harness.cancellations(), 1);
      assert.equal(harness.cancellationReason(), cancellationReason);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(timers.live(), []);

      for (const [listener, additions] of listenerObserver.additions) {
        assert.equal(
          listenerObserver.removals.get(listener) ?? 0,
          additions
        );
      }
      owner.abort(abortError('Caller abort after downstream cancellation'));
      assert.equal(harness.signal()?.aborted, false);
    });
  } finally {
    harness.finish();
    listenerObserver.restore();
    timers.restore();
  }
});

test('successful read removes caller listener and leaves no stall clock running', async () => {
  const owner = new AbortController();
  const request = workerRequest('/auth/user', { signal: owner.signal });
  const listenerObserver = observeAbortListeners(request.signal);
  const timers = installFakeTimers();
  let upstreamSignal = null;

  try {
    await withMockedFetch(async (_url, options = {}) => {
      upstreamSignal = options.signal;
      return jsonResponse(USER_DOCUMENT);
    }, async () => {
      const response = await worker.fetch(request, ENV);
      assert.equal(response.status, 200);
      assert.deepEqual(await responseDocument(response), USER_DOCUMENT);

      const listenerAdditions = Array.from(
        listenerObserver.additions.values()
      ).reduce((sum, count) => sum + count, 0);
      const listenerRemovals = Array.from(
        listenerObserver.removals.values()
      ).reduce((sum, count) => sum + count, 0);
      for (const [listener, additions] of listenerObserver.additions) {
        assert.equal(
          listenerObserver.removals.get(listener) ?? 0,
          additions
        );
      }
      assert.ok(timers.records.length >= 1);
      assert.deepEqual(
        {
          live: timers.live().length,
          delays: [...new Set(timers.records.map(record => record.delay))],
          listenerAdditions,
          listenerRemovals,
        },
        {
          live: 0,
          delays: [WORKER_STALL_TIMEOUT_MS],
          listenerAdditions: 1,
          listenerRemovals: 1,
        }
      );

      owner.abort(abortError('Caller abort after completed response'));
      assert.ok(upstreamSignal);
      assert.equal(upstreamSignal.aborted, false);
    });
  } finally {
    listenerObserver.restore();
    timers.restore();
  }
});
