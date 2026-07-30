import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const WORKER_REQUEST_BODY_MAX_BYTES = 1_400_000;
const ANNOTATION_FILE_MAX_UTF8_BYTES = 1_000_000;
const MUTATION_PATH =
  '/api/repos/owner/repo/contents/annotations/users/ghid_1.json';
const OPERATION_ID =
  '018f5e3a-7b9c-4d2e-8f10-123456789abc';
const CALLER_ABORT_DOCUMENT = Object.freeze({
  error: 'Worker request was cancelled',
});
const OVERSIZED_BODY_DOCUMENT = Object.freeze({
  error:
    `GitHub API proxy request body exceeds ` +
    `${WORKER_REQUEST_BODY_MAX_BYTES} bytes`,
});
const INVALID_UTF8_DOCUMENT = Object.freeze({
  error: 'GitHub API proxy request body contains invalid UTF-8',
});
const CONTENT_SHA = 'a'.repeat(40);
const VALID_MUTATION_DOCUMENT = Object.freeze({
  message: 'Update community annotation',
  content: 'e30=',
  branch: 'main',
});
const encoder = new TextEncoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function abortError(message) {
  return new DOMException(message, 'AbortError');
}

function mutationRequest(body, signal) {
  return new Request(`https://worker.example${MUTATION_PATH}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'X-Cellucid-Operation-Id': OPERATION_ID,
    },
    body,
    duplex: 'half',
    signal,
  });
}

function upstreamMutationResponse() {
  return new Response(
    JSON.stringify({ content: { sha: CONTENT_SHA } }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
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

function oneChunkBody(bytes) {
  let pulls = 0;
  let cancellations = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      cancellations += 1;
    },
  });
  return {
    cancellations: () => cancellations,
    pulls: () => pulls,
    stream,
  };
}

function splitStalledBody(bytes, splitIndex) {
  const stalled = deferred();
  const pullGate = deferred();
  let bodyController = null;
  let cancellations = 0;
  let finished = false;
  let pullIndex = 0;

  const stream = new ReadableStream({
    start(controller) {
      bodyController = controller;
    },
    pull(controller) {
      if (pullIndex === 0) {
        pullIndex += 1;
        controller.enqueue(bytes.subarray(0, splitIndex));
        return;
      }
      stalled.resolve();
      return pullGate.promise;
    },
    cancel() {
      cancellations += 1;
      finished = true;
      pullGate.resolve();
    },
  });

  return {
    cancellations: () => cancellations,
    finish() {
      if (finished) return;
      finished = true;
      bodyController.enqueue(bytes.subarray(splitIndex));
      bodyController.close();
      pullGate.resolve();
    },
    stalled: stalled.promise,
    stream,
  };
}

function oversizedStalledBody() {
  const cancelled = deferred();
  const stalled = deferred();
  const pullGate = deferred();
  let bodyController = null;
  let cancellations = 0;
  let finished = false;
  let pullIndex = 0;

  const stream = new ReadableStream({
    start(controller) {
      bodyController = controller;
    },
    pull(controller) {
      if (pullIndex === 0) {
        pullIndex += 1;
        const atLimit = new Uint8Array(
          WORKER_REQUEST_BODY_MAX_BYTES
        );
        atLimit.fill(0x61);
        controller.enqueue(atLimit);
        return;
      }
      if (pullIndex === 1) {
        pullIndex += 1;
        controller.enqueue(Uint8Array.of(0x61));
        return;
      }
      stalled.resolve('stalled');
      return pullGate.promise;
    },
    cancel() {
      cancellations += 1;
      finished = true;
      cancelled.resolve('cancelled');
      pullGate.resolve();
    },
  });

  return {
    cancellations: () => cancellations,
    event: Promise.race([cancelled.promise, stalled.promise]),
    finish() {
      if (finished) return;
      finished = true;
      bodyController.close();
      pullGate.resolve();
    },
    stream,
  };
}

function malformedUtf8MutationBytes() {
  const prefix = encoder.encode('{"message":"');
  const suffix = encoder.encode(
    '","content":"e30=","branch":"main"}'
  );
  const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
  bytes.set(prefix, 0);
  bytes[prefix.byteLength] = 0xff;
  bytes.set(suffix, prefix.byteLength + 1);
  return bytes;
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

function observeBodyOwnership(body) {
  const originalGetReader = body.getReader;
  let acquisitions = 0;
  body.getReader = function getReader(...args) {
    acquisitions += 1;
    return Reflect.apply(originalGetReader, this, args);
  };
  return {
    acquisitions: () => acquisitions,
    restore() {
      body.getReader = originalGetReader;
    },
  };
}

test('Wrangler enables only the exact incoming Request.signal flag', () => {
  const config = parseExactJson(
    readFileSync(
      new URL('../wrangler.community-annotations.jsonc', import.meta.url),
      'utf8'
    ),
    { path: 'Wrangler community-annotation configuration' }
  );
  assert.deepEqual(
    config.compatibility_flags,
    ['enable_request_signal']
  );
  assert.deepEqual(config.limits, { cpu_ms: 1_000 });
});

test('Worker bundle validation pins Wrangler and runs only on Node 24 in CI', () => {
  const packageDocument = parseExactJson(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    { path: 'Web package manifest' }
  );
  assert.equal(
    packageDocument.scripts?.['test:worker-bundle'],
    'npx --yes wrangler@4.115.0 deploy --dry-run ' +
      '--config wrangler.community-annotations.jsonc'
  );

  const workflow = readFileSync(
    new URL('../.github/workflows/test.yml', import.meta.url),
    'utf8'
  );
  assert.match(
    workflow,
    /if: matrix\.os == 'ubuntu-latest' && matrix\.node == '24'\n\s+run: npm run test:worker-bundle/
  );

  const guide = readFileSync(
    new URL('../docs/github-oauth-cloudflare-setup.md', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(guide, /\bnpx\s+wrangler(?:\s|$)/);
  assert.ok(
    (guide.match(/\bwrangler@4\.115\.0\b/g) ?? []).length >= 6,
    'every direct Wrangler command must retain the exact audited release'
  );
});

test('already-aborted mutation owns no body and dispatches no upstream request', async () => {
  const owner = new AbortController();
  const body = oneChunkBody(
    encoder.encode(JSON.stringify(VALID_MUTATION_DOCUMENT))
  );
  const request = mutationRequest(body.stream, owner.signal);
  const ownership = observeBodyOwnership(request.body);
  let upstreamCalls = 0;
  owner.abort(abortError('Caller cancelled before body ownership'));

  try {
    await withMockedFetch(async () => {
      upstreamCalls += 1;
      return upstreamMutationResponse();
    }, async () => {
      const response = await worker.fetch(request, ENV);
      assert.deepEqual(
        {
          bodyLocked: request.body.locked,
          document: await responseDocument(response),
          readerAcquisitions: ownership.acquisitions(),
          status: response.status,
          upstreamCalls,
        },
        {
          bodyLocked: false,
          document: CALLER_ABORT_DOCUMENT,
          readerAcquisitions: 0,
          status: 499,
          upstreamCalls: 0,
        }
      );
    });
  } finally {
    ownership.restore();
  }
});

test('mid-body caller abort cancels and releases ownership before mutation dispatch', async () => {
  const owner = new AbortController();
  const bytes = encoder.encode(
    JSON.stringify(VALID_MUTATION_DOCUMENT)
  );
  const body = splitStalledBody(bytes, Math.floor(bytes.byteLength / 2));
  const request = mutationRequest(body.stream, owner.signal);
  let upstreamCalls = 0;
  let workerPromise = null;

  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return upstreamMutationResponse();
  }, async () => {
    try {
      workerPromise = worker.fetch(request, ENV);
      await body.stalled;
      owner.abort(abortError('Caller cancelled during request body'));
      await Promise.resolve();
      const cancelledOnAbort = body.cancellations() === 1;
      if (!cancelledOnAbort) body.finish();
      const response = await workerPromise;

      assert.deepEqual(
        {
          bodyCancellations: body.cancellations(),
          bodyLocked: request.body.locked,
          cancelledOnAbort,
          document: await responseDocument(response),
          status: response.status,
          upstreamCalls,
        },
        {
          bodyCancellations: 1,
          bodyLocked: false,
          cancelledOnAbort: true,
          document: CALLER_ABORT_DOCUMENT,
          status: 499,
          upstreamCalls: 0,
        }
      );
    } finally {
      body.finish();
      if (workerPromise !== null) await workerPromise;
    }
  });
});

test('streamed body over the byte ceiling is rejected and released before dispatch', async () => {
  const owner = new AbortController();
  const body = oversizedStalledBody();
  const request = mutationRequest(body.stream, owner.signal);
  let upstreamCalls = 0;
  let workerPromise = null;

  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return upstreamMutationResponse();
  }, async () => {
    try {
      workerPromise = worker.fetch(request, ENV);
      await body.event;
      await Promise.resolve();
      const cancelledBeforeFallback = body.cancellations() === 1;
      if (!cancelledBeforeFallback) body.finish();
      const response = await workerPromise;

      assert.deepEqual(
        {
          bodyCancellations: body.cancellations(),
          bodyLocked: request.body.locked,
          cancelledBeforeFallback,
          document: await responseDocument(response),
          status: response.status,
          upstreamCalls,
        },
        {
          bodyCancellations: 1,
          bodyLocked: false,
          cancelledBeforeFallback: true,
          document: OVERSIZED_BODY_DOCUMENT,
          status: 413,
          upstreamCalls: 0,
        }
      );
    } finally {
      body.finish();
      if (workerPromise !== null) await workerPromise;
    }
  });
});

test('malformed request bytes fail exact UTF-8 decoding before dispatch', async () => {
  const owner = new AbortController();
  const body = oneChunkBody(malformedUtf8MutationBytes());
  const request = mutationRequest(body.stream, owner.signal);
  let upstreamCalls = 0;

  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return upstreamMutationResponse();
  }, async () => {
    const response = await worker.fetch(request, ENV);
    assert.deepEqual(
      {
        bodyLocked: request.body.locked,
        document: await responseDocument(response),
        status: response.status,
        upstreamCalls,
      },
      {
        bodyLocked: false,
        document: INVALID_UTF8_DOCUMENT,
        status: 400,
        upstreamCalls: 0,
      }
    );
  });
});

test('contents PUT owns the exact decoded annotation byte boundary rather than base64 length', async () => {
  const exactContent = btoa(
    'a'.repeat(ANNOTATION_FILE_MAX_UTF8_BYTES)
  );
  const oversizedContent = btoa(
    'a'.repeat(ANNOTATION_FILE_MAX_UTF8_BYTES + 1)
  );
  assert.equal(
    exactContent.length,
    oversizedContent.length,
    'padding must make decoded length the deciding boundary'
  );

  const seenDecodedBytes = [];
  await withMockedFetch(async (_url, options = {}) => {
    const document = parseExactJson(options.body, {
      path: 'forwarded GitHub contents mutation',
    });
    seenDecodedBytes.push(atob(document.content).length);
    return upstreamMutationResponse();
  }, async () => {
    const exactResponse = await worker.fetch(
      mutationRequest(
        JSON.stringify({
          message: 'Publish exact annotation boundary',
          content: exactContent,
          branch: 'main',
        })
      ),
      ENV
    );
    assert.equal(exactResponse.status, 200);
    assert.deepEqual(
      await responseDocument(exactResponse),
      { content: { sha: CONTENT_SHA } }
    );

    const oversizedResponse = await worker.fetch(
      mutationRequest(
        JSON.stringify({
          message: 'Reject oversized annotation boundary',
          content: oversizedContent,
          branch: 'main',
        })
      ),
      ENV
    );
    assert.equal(oversizedResponse.status, 413);
    assert.match(
      (await responseDocument(oversizedResponse)).error,
      /content.*1000000.*decoded bytes/i
    );
  });
  assert.deepEqual(seenDecodedBytes, [
    ANNOTATION_FILE_MAX_UTF8_BYTES,
  ]);
});

test('accepted CRLF-folded GitHub base64 fits the response-byte owner', async () => {
  const canonical = btoa(
    'a'.repeat(ANNOTATION_FILE_MAX_UTF8_BYTES)
  );
  const content =
    canonical.match(/.{1,60}/g).join('\r\n') + '\r\n';
  assert.equal(canonical.length, 1_333_336);
  assert.equal(content.length, 1_377_782);
  const upstreamDocument = JSON.stringify({
    type: 'file',
    encoding: 'base64',
    content,
    sha: CONTENT_SHA,
  });
  assert.equal(
    new TextEncoder().encode(upstreamDocument).byteLength,
    1_422_325
  );

  await withMockedFetch(
    async () => new Response(upstreamDocument, { status: 200 }),
    async () => {
      const response = await worker.fetch(
        new Request(
          'https://worker.example' +
            `${MUTATION_PATH}?ref=main`,
          {
            headers: {
              Authorization: 'Bearer test-token',
            },
          }
        ),
        ENV
      );
      assert.equal(response.status, 200);
      const document = await responseDocument(response);
      assert.equal(document.content.length, content.length);
      assert.equal(document.content, content);
    }
  );
});

test('successful bounded body read releases ownership and its abort listener', async () => {
  const owner = new AbortController();
  const body = oneChunkBody(
    encoder.encode(JSON.stringify(VALID_MUTATION_DOCUMENT))
  );
  const request = mutationRequest(body.stream, owner.signal);
  const listenerObserver = observeAbortListeners(request.signal);
  let upstreamCalls = 0;

  try {
    await withMockedFetch(async () => {
      upstreamCalls += 1;
      return upstreamMutationResponse();
    }, async () => {
      const response = await worker.fetch(request, ENV);
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
          bodyCancellations: body.cancellations(),
          bodyLocked: request.body.locked,
          bodyPulls: body.pulls(),
          document: await responseDocument(response),
          listenerAdditions,
          listenerRemovals,
          status: response.status,
          upstreamCalls,
        },
        {
          bodyCancellations: 0,
          bodyLocked: false,
          bodyPulls: 1,
          document: { content: { sha: CONTENT_SHA } },
          listenerAdditions: 1,
          listenerRemovals: 1,
          status: 200,
          upstreamCalls: 1,
        }
      );
    });
  } finally {
    listenerObserver.restore();
  }
});
