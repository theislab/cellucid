import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const WORKER_DEADLINE_MS = 15_000;
const CALLER_ABORT_DOCUMENT = Object.freeze({
  error: 'Worker request was cancelled',
});
const TIMEOUT_DOCUMENT = Object.freeze({
  error: `Worker request timed out after ${WORKER_DEADLINE_MS}ms`,
});
const USER_DOCUMENT = Object.freeze({
  id: 1,
  login: 'cellucid-user',
});
const TREE_PATH =
  '/api/repos/owner/repo/git/trees/main?recursive=1';
const CONTENT_PATH =
  '/api/repos/owner/repo/contents/' +
  'annotations/users/ghid_42.json?ref=main';
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

async function withMockedFetch(mockFetch, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
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
      assert.match(String(url), /\/git\/trees\/main\?recursive=1$/);
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

test('timeout first remains the first cause when caller aborts later', async () => {
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
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];

      timers.fire(deadline);
      owner.abort(abortError('Caller cancelled after deadline'));
      const response = await workerPromise;

      assert.deepEqual(
        {
          deadlineMs: deadline.delay,
          document: await responseDocument(response),
          status: response.status,
        },
        {
          deadlineMs: WORKER_DEADLINE_MS,
          document: TIMEOUT_DOCUMENT,
          status: 504,
        }
      );
      assert.equal(deadline.cleared, true);
    });
  } finally {
    harness.resolve();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('caller first remains the first cause when timeout fires later', async () => {
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
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];

      owner.abort(abortError('Caller won the cancellation race'));
      timers.fire(deadline);
      const response = await workerPromise;

      assert.deepEqual(
        {
          deadlineMs: deadline.delay,
          document: await responseDocument(response),
          status: response.status,
        },
        {
          deadlineMs: WORKER_DEADLINE_MS,
          document: CALLER_ABORT_DOCUMENT,
          status: 499,
        }
      );
      assert.equal(deadline.cleared, true);
    });
  } finally {
    harness.resolve();
    if (workerPromise !== null) await workerPromise;
    timers.restore();
  }
});

test('independent upstream AbortError is a gateway failure, not a timeout', async () => {
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
    assert.doesNotMatch(document.error, /timed out/i);
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

test('deadline after headers cancels stalled response-body consumption', async () => {
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
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];
      const activeDuringBody = !deadline.cleared && !deadline.fired;

      if (activeDuringBody) timers.fire(deadline);
      else harness.finish();
      const response = await workerPromise;

      assert.deepEqual(
        {
          activeDuringBody,
          bodyAbortEvents: upstream.abortEvents(),
          deadlineMs: deadline.delay,
          document: await responseDocument(response),
          status: response.status,
        },
        {
          activeDuringBody: true,
          bodyAbortEvents: 1,
          deadlineMs: WORKER_DEADLINE_MS,
          document: TIMEOUT_DOCUMENT,
          status: 504,
        }
      );
      assert.equal(deadline.cleared, true);
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

test('deadline ownership remains active while a streamed tree response drains', async () => {
  const harness = createStalledTreeFetchHarness();
  const timers = installFakeTimers();
  let workerPromise = null;

  try {
    await withMockedFetch(harness.fetch, async () => {
      workerPromise = worker.fetch(
        workerRequest(TREE_PATH),
        ENV
      );
      const earlyResponse = await settleBeforeImmediate(workerPromise);
      const returnedBeforeDrain =
        earlyResponse !== PROMISE_STILL_PENDING;
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];
      if (!returnedBeforeDrain) {
        timers.fire(deadline);
        harness.finish();
        await workerPromise;
      }
      assert.equal(
        returnedBeforeDrain,
        true,
        'tree response must stream while its deadline remains active'
      );
      assert.equal(deadline.cleared, false);
      assert.equal(deadline.fired, false);

      const bodyOutcomePromise = earlyResponse.text().then(
        value => ({ kind: 'resolved', value }),
        error => ({ error, kind: 'rejected' })
      );
      await harness.bodyPulled;
      timers.fire(deadline);
      const bodyOutcome = await settleBeforeImmediate(
        bodyOutcomePromise
      );
      if (bodyOutcome === PROMISE_STILL_PENDING) harness.finish();

      assert.notEqual(bodyOutcome, PROMISE_STILL_PENDING);
      assert.equal(bodyOutcome.kind, 'rejected');
      assert.equal(deadline.delay, WORKER_DEADLINE_MS);
      assert.equal(deadline.cleared, true);
      assert.equal(harness.signal()?.aborted, true);
      assert.equal(harness.abortEvents(), 1);
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
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];
      assert.equal(deadline.cleared, false);

      await response.body.cancel(cancellationReason);
      assert.equal(harness.cancellations(), 1);
      assert.equal(harness.cancellationReason(), cancellationReason);
      assert.equal(deadline.cleared, true);

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

test('a streamed byte overrun without Content-Length cancels upstream and releases ownership', async () => {
  const harness = createOpenChunkedFetchHarness([
    new Uint8Array(1_000_000).fill(0x61),
    new Uint8Array(500_001).fill(0x62),
  ]);
  const timers = installFakeTimers();

  try {
    await withMockedFetch(harness.fetch, async () => {
      const response = await worker.fetch(
        workerRequest(CONTENT_PATH),
        ENV
      );
      assert.equal(response.status, 200);
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];
      assert.equal(deadline.cleared, false);

      await assert.rejects(
        response.text(),
        /body exceeds 1500000 bytes/
      );
      await harness.cancellationStarted;
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(harness.cancellations(), 1);
      assert.equal(harness.pulls(), 3);
      assert.equal(harness.signal()?.aborted, false);
      assert.equal(deadline.cleared, true);
    });
  } finally {
    harness.finish();
    timers.restore();
  }
});

test('invalid UTF-8 in a streamed response cancels upstream and releases ownership', async () => {
  const encoder = new TextEncoder();
  const harness = createOpenChunkedFetchHarness([
    encoder.encode('{"tree":['),
    new Uint8Array([0xff]),
  ]);
  const timers = installFakeTimers();

  try {
    await withMockedFetch(harness.fetch, async () => {
      const response = await worker.fetch(
        workerRequest(TREE_PATH),
        ENV
      );
      assert.equal(response.status, 200);
      assert.equal(timers.records.length, 1);
      const deadline = timers.records[0];
      assert.equal(deadline.cleared, false);

      await assert.rejects(
        response.text(),
        /body contains invalid UTF-8/
      );
      await harness.cancellationStarted;
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(harness.cancellations(), 1);
      assert.equal(harness.pulls(), 3);
      assert.equal(harness.signal()?.aborted, false);
      assert.equal(deadline.cleared, true);
    });
  } finally {
    harness.finish();
    timers.restore();
  }
});

test('pagination abort at a page boundary prevents the next fetch', async () => {
  const owner = new AbortController();
  const firstBody = deferred();
  const firstFetch = deferred();
  const upstreamUrls = [];

  firstBody.promise.then(() => {
    owner.abort(abortError('Caller cancelled between pages'));
  });

  await withMockedFetch(async (url, options = {}) => {
    upstreamUrls.push(String(url));
    if (upstreamUrls.length === 1) {
      firstFetch.resolve();
      return {
        ok: true,
        status: 200,
        text: () => firstBody.promise,
      };
    }
    if (options.signal?.aborted) throw abortError();
    return jsonResponse({
      total_count: 2,
      installations: [
        { id: 2, account: { login: 'second-user' } },
      ],
    });
  }, async () => {
    const workerPromise = worker.fetch(
      workerRequest('/auth/installations', { signal: owner.signal }),
      ENV
    );
    await firstFetch.promise;
    firstBody.resolve(JSON.stringify({
      total_count: 2,
      installations: [
        { id: 1, account: { login: 'first-user' } },
      ],
    }));
    const response = await workerPromise;

    assert.deepEqual(
      {
        document: await responseDocument(response),
        status: response.status,
        upstreamUrls,
      },
      {
        document: CALLER_ABORT_DOCUMENT,
        status: 499,
        upstreamUrls: [
          'https://api.github.com/user/installations?per_page=100&page=1',
        ],
      }
    );
  });
});

test('successful read removes caller listener and clears its deadline', async () => {
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

      assert.equal(timers.records.length, 1);
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
      assert.deepEqual(
        {
          activeDeadlines:
            timers.records.filter(
              record => !record.cleared && !record.fired
            ).length,
          deadlineMs: timers.records[0].delay,
          listenerAdditions,
          listenerRemovals,
        },
        {
          activeDeadlines: 0,
          deadlineMs: WORKER_DEADLINE_MS,
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
