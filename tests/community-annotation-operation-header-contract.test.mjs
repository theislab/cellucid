import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import { CommunityAnnotationGitHubSync } from '../assets/js/app/community-annotations/github-sync.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';
import { WORKER_EXPOSED_RESPONSE_HEADERS } from './browser/helpers/worker-exposed-headers.mjs';
import {
  configFor,
  createVirtualTime,
  MockAnnotationGitHub,
  virtualTransport,
  WORKER_ORIGIN,
} from './helpers/community-annotation-worker.mjs';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';
const OPERATION_ID = '018f5e3a-7b9c-4d2e-8f10-123456789abc';
const OTHER_OPERATION_ID = '018f5e3a-7b9c-4d2e-af10-123456789abd';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function workerRequest(path, options = {}) {
  return new Request(`https://worker.example${path}`, options);
}

function mutationHeaders(operationId = OPERATION_ID, extra = []) {
  const entries = [
    ['Authorization', 'Bearer token'],
    ['Content-Type', 'application/json'],
    ['Origin', 'https://app.example'],
  ];
  if (operationId !== null) {
    entries.push([OPERATION_ID_HEADER, operationId]);
  }
  entries.push(...extra);
  return entries;
}

function contentsMutationRequest({
  operationId = OPERATION_ID,
  headers = null,
  body = null,
} = {}) {
  return workerRequest(
    '/api/repos/owner/repo/contents/annotations/users/ghid_42.json',
    {
      method: 'PUT',
      headers: headers ?? mutationHeaders(operationId),
      body: JSON.stringify(body ?? {
        message: 'Publish annotations',
        content: 'e30=',
        branch: 'main',
      }),
    },
  );
}

async function exactResponseJson(response) {
  return parseExactJson(await response.text(), {
    path: `operation header HTTP ${response.status} response`,
  });
}

function commaSeparatedHeaderSet(response, name) {
  const raw = response.headers.get(name);
  assert.notEqual(raw, null, `${name} must be present`);
  return new Set(
    raw
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

// A write bound to its caller (a user file, a contribution branch, a Pull
// Request) first asks GitHub who the token belongs to: user 42, researcher.
const CALLER = Object.freeze({ id: 42, login: 'researcher' });

async function withGlobalFetch(fetchImpl, operation) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    String(url) === 'https://api.github.com/user'
      ? Promise.resolve(new Response(JSON.stringify(CALLER), { status: 200 }))
      : fetchImpl(url, options);
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function withDeterministicRandomUuid(uuid, operation) {
  const cryptoObject = globalThis.crypto;
  const ownDescriptor = Object.getOwnPropertyDescriptor(
    cryptoObject,
    'randomUUID',
  );
  let calls = 0;
  Object.defineProperty(cryptoObject, 'randomUUID', {
    configurable: true,
    enumerable: true,
    writable: true,
    value() {
      calls += 1;
      return uuid;
    },
  });
  try {
    const value = await operation();
    return { calls, value };
  } finally {
    if (ownDescriptor === undefined) {
      delete cryptoObject.randomUUID;
    } else {
      Object.defineProperty(cryptoObject, 'randomUUID', ownDescriptor);
    }
  }
}

function validUserDocument() {
  return {
    version: 1,
    username: 'ghid_42',
    githubUserId: 42,
    login: 'researcher',
    updatedAt: '2026-07-25T01:02:03.456Z',
    suggestions: {},
    votes: {},
  };
}

/** A direct-mode sync on virtual time over `fetchImpl`: `{sync, run}`. */
function createDirectSync(fetchImpl, time = createVirtualTime()) {
  const { transport } = virtualTransport(fetchImpl, time);
  const sync = new CommunityAnnotationGitHubSync({
    datasetId: 'synthetic',
    owner: 'owner',
    repo: 'repo',
    token: 'test-token',
    branch: 'main',
    workerOrigin: WORKER_ORIGIN,
    transport,
  });
  return { sync, time, run: (promise) => time.run(promise) };
}

/** Run `operation(sync)` on a fresh direct sync over `fetchImpl`, on virtual time. */
function runDirect(fetchImpl, operation) {
  const { sync, run } = createDirectSync(fetchImpl);
  return run(operation(sync));
}

/** An error and its causes, outermost first. */
function causeChain(error) {
  const chain = [];
  for (let at = error; at !== undefined && at !== null && chain.length < 10; at = at.cause) chain.push(at);
  return chain;
}

/** Everything but the mutation answered by the shared in-memory GitHub (contract 3). */
function directRepository() {
  return new MockAnnotationGitHub({
    files: {
      'annotations/config.json': configFor('synthetic', ['cell_type']),
      'annotations/users/.gitkeep': '\n',
    },
  });
}

function createDirectBrowserFetch({
  echoedOperationId = OPERATION_ID,
  outcome = 'applied',
  mutationStatus = 200,
  mutationDocument = { content: { sha: SHA_B } },
  mutationError = null,
  capture,
}) {
  const repository = directRepository();
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';

    if (
      method === 'PUT' &&
      url.pathname ===
        '/api/repos/owner/repo/contents/annotations/users/ghid_42.json'
    ) {
      const headers = new Headers(options.headers);
      const document = parseExactJson(options.body, {
        path: 'browser contents mutation request',
      });
      capture.operationId = headers.get(OPERATION_ID_HEADER);
      capture.body = document;
      if (mutationError !== null) throw mutationError;
      const responseHeaders = {};
      if (echoedOperationId !== null) {
        responseHeaders[OPERATION_ID_HEADER] = echoedOperationId;
      }
      if (outcome !== null) {
        responseHeaders[OPERATION_OUTCOME_HEADER] = outcome;
      }
      // As the Worker answers: JSON with its length.
      const text = JSON.stringify(mutationDocument);
      responseHeaders['Content-Type'] = 'application/json';
      responseHeaders['Content-Length'] = String(Buffer.byteLength(text));
      return new Response(text, {
        status: mutationStatus,
        headers: responseHeaders,
      });
    }
    if (method === 'GET' || url.pathname.startsWith('/graphql/')) {
      return repository.fetch(rawUrl, options);
    }
    throw new Error(`Unexpected browser request: ${method} ${url.pathname}`);
  };
}

function syntheticAbortError(message = 'Synthetic transport abort') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

test(
  'mutation preflight allows the operation id while outcome remains response-only',
  { concurrency: false },
  async () => {
    const response = await worker.fetch(
      workerRequest(
        '/api/repos/owner/repo/contents/annotations/users/ghid_42.json',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://app.example',
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers':
              'Authorization, Content-Type, X-Cellucid-Operation-Id',
          },
        },
      ),
      ENV,
    );

    assert.equal(response.status, 204);
    assert.deepEqual(
      commaSeparatedHeaderSet(response, 'Access-Control-Allow-Headers'),
      new Set([
        'authorization',
        'content-type',
        'if-none-match',
        'x-cellucid-operation-id',
      ]),
    );

    const forbiddenOutcome = await worker.fetch(
      workerRequest(
        '/api/repos/owner/repo/contents/annotations/users/ghid_42.json',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://app.example',
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers':
              'Authorization, Content-Type, X-Cellucid-Operation-Outcome',
          },
        },
      ),
      ENV,
    );
    assert.equal(forbiddenOutcome.status, 400);
  },
);

test(
  'actual cross-origin responses expose only the operation, conditional-request and rate-limit headers',
  { concurrency: false },
  async () => {
    await withGlobalFetch(
      async () => new Response(JSON.stringify({
        content: { sha: SHA_B },
      }), { status: 200 }),
      async () => {
        const response = await worker.fetch(contentsMutationRequest(), ENV);
        const exposed =
          commaSeparatedHeaderSet(response, 'Access-Control-Expose-Headers');
        assert.deepEqual(
          exposed,
          new Set([
            'etag',
            'retry-after',
            'x-ratelimit-limit',
            'x-ratelimit-remaining',
            'x-ratelimit-reset',
            'x-ratelimit-used',
            'x-ratelimit-resource',
            'x-github-request-id',
            'x-cellucid-operation-id',
            'x-cellucid-operation-outcome',
          ]),
        );
        // The browser specs' stand-in worker must expose exactly the same
        // headers, or the app cannot read the retry metadata they serve.
        assert.deepEqual(
          new Set(
            WORKER_EXPOSED_RESPONSE_HEADERS.map(name => name.toLowerCase()),
          ),
          exposed,
        );
      },
    );
  },
);

test(
  'Worker accepts only one canonical lowercase UUIDv4 operation id before dispatch',
  { concurrency: false },
  async t => {
    const invalidCases = [
      ['missing', null, null],
      ['uppercase', OPERATION_ID.toUpperCase(), null],
      [
        'wrong UUID version',
        '018f5e3a-7b9c-1d2e-8f10-123456789abc',
        null,
      ],
      [
        'wrong UUID variant',
        '018f5e3a-7b9c-4d2e-7f10-123456789abc',
        null,
      ],
      [
        'embedded whitespace',
        OPERATION_ID.replace('-', ' -'),
        null,
      ],
      ['non-UUID text', 'cellucid-operation-1', null],
      [
        'duplicate header',
        null,
        mutationHeaders(null, [
          [OPERATION_ID_HEADER, OPERATION_ID],
          [OPERATION_ID_HEADER, OTHER_OPERATION_ID],
        ]),
      ],
    ];

    for (const [label, operationId, headers] of invalidCases) {
      await t.test(label, async () => {
        let dispatched = false;
        await withGlobalFetch(
          async () => {
            dispatched = true;
            return new Response(JSON.stringify({
              content: { sha: SHA_B },
            }), { status: 200 });
          },
          async () => {
            const response = await worker.fetch(
              contentsMutationRequest({ operationId, headers }),
              ENV,
            );
            assert.equal(dispatched, false);
            assert.equal(response.status, 400);
            const document = await exactResponseJson(response);
            assert.deepEqual(Object.keys(document), ['error']);
            assert.match(document.error, /X-Cellucid-Operation-Id/i);
            assert.equal(
              response.headers.get(OPERATION_ID_HEADER),
              null,
            );
            assert.equal(
              response.headers.get(OPERATION_OUTCOME_HEADER),
              'not-applied',
            );
          },
        );
      });
    }
  },
);

test(
  'valid operation ids are echoed as applied on every mutation route without entering GitHub bodies',
  { concurrency: false },
  async t => {
    const cases = [
      {
        label: 'contents PUT',
        path:
          '/api/repos/owner/repo/contents/annotations/users/ghid_42.json',
        method: 'PUT',
        requestDocument: {
          message: 'Publish annotations',
          content: 'e30=',
          branch: 'main',
        },
        upstreamStatus: 200,
        upstreamDocument: {
          content: { sha: SHA_B },
          commit: { sha: SHA_A },
        },
        expectedStatus: 200,
        expectedDocument: { content: { sha: SHA_B } },
      },
      {
        label: 'git ref POST',
        path: '/api/repos/researcher/repo/git/refs',
        method: 'POST',
        requestDocument: {
          ref: 'refs/heads/cellucid-annotations/ghid_42/exact',
          sha: SHA_A,
        },
        upstreamStatus: 201,
        upstreamDocument: {
          ref: 'refs/heads/cellucid-annotations/ghid_42/exact',
          object: { sha: SHA_A },
        },
        expectedStatus: 201,
        expectedDocument: {},
      },
      {
        label: 'git ref PATCH',
        path: '/api/repos/researcher/repo/git/refs/heads/cellucid-annotations/ghid_42/exact',
        method: 'PATCH',
        requestDocument: { sha: SHA_B, force: true },
        upstreamStatus: 200,
        upstreamDocument: {
          ref: 'refs/heads/cellucid-annotations/ghid_42/exact',
          object: { sha: SHA_B, type: 'commit' },
        },
        expectedStatus: 200,
        expectedDocument: { object: { sha: SHA_B } },
      },
      {
        label: 'pull request POST',
        path: '/api/repos/owner/repo/pulls',
        method: 'POST',
        requestDocument: {
          title: 'Publish annotations',
          head: 'researcher:cellucid-annotations/ghid_42/exact',
          base: 'main',
          body: 'Community annotation update from Cellucid.',
          maintainer_can_modify: true,
        },
        upstreamStatus: 201,
        upstreamDocument: {
          number: 7,
          html_url: 'https://github.com/owner/repo/pull/7',
          unknown_upstream_field: true,
        },
        expectedStatus: 201,
        expectedDocument: {
          number: 7,
          html_url: 'https://github.com/owner/repo/pull/7',
        },
      },
    ];

    for (const contract of cases) {
      await t.test(contract.label, async () => {
        let upstreamBody = null;
        let upstreamOperationId = null;
        await withGlobalFetch(
          async (_url, options = {}) => {
            const headers = new Headers(options.headers);
            upstreamOperationId = headers.get(OPERATION_ID_HEADER);
            upstreamBody = parseExactJson(options.body, {
              path: `${contract.label} upstream request`,
            });
            return new Response(JSON.stringify(contract.upstreamDocument), {
              status: contract.upstreamStatus,
            });
          },
          async () => {
            const response = await worker.fetch(
              workerRequest(contract.path, {
                method: contract.method,
                headers: mutationHeaders(),
                body: JSON.stringify(contract.requestDocument),
              }),
              ENV,
            );
            assert.equal(response.status, contract.expectedStatus);
            assert.deepEqual(
              await exactResponseJson(response),
              contract.expectedDocument,
            );
            assert.deepEqual(upstreamBody, contract.requestDocument);
            assert.equal(
              Object.hasOwn(upstreamBody, 'operation'),
              false,
            );
            assert.equal(upstreamOperationId, null);
            assert.equal(
              response.headers.get(OPERATION_ID_HEADER),
              OPERATION_ID,
            );
            assert.equal(
              response.headers.get(OPERATION_OUTCOME_HEADER),
              'applied',
            );
          },
        );
      });
    }
  },
);

test(
  'valid-id request validation failures are not-applied and never dispatched',
  { concurrency: false },
  async () => {
    let dispatched = false;
    await withGlobalFetch(
      async () => {
        dispatched = true;
        throw new Error('Invalid requests must not reach GitHub');
      },
      async () => {
        const response = await worker.fetch(
          contentsMutationRequest({
            body: {
              message: 'Publish annotations',
              content: 'e30=',
              branch: 'main',
              sha: 'short-sha',
            },
          }),
          ENV,
        );
        assert.equal(dispatched, false);
        assert.equal(response.status, 400);
        const document = await exactResponseJson(response);
        assert.deepEqual(Object.keys(document), ['error']);
        assert.equal(
          response.headers.get(OPERATION_ID_HEADER),
          OPERATION_ID,
        );
        assert.equal(
          response.headers.get(OPERATION_OUTCOME_HEADER),
          'not-applied',
        );
      },
    );
  },
);

test(
  'a dispatched transport failure preserves the exact error body and reports unknown',
  { concurrency: false },
  async () => {
    let dispatched = false;
    await withGlobalFetch(
      async () => {
        dispatched = true;
        throw new TypeError('Synthetic upstream network loss');
      },
      async () => {
        const response = await worker.fetch(contentsMutationRequest(), ENV);
        assert.equal(dispatched, true);
        assert.equal(response.status, 502);
        assert.deepEqual(await exactResponseJson(response), {
          error:
            'GitHub API PUT /repos/owner/repo/contents/annotations/users/ghid_42.json could not be reached',
        });
        assert.equal(
          response.headers.get(OPERATION_ID_HEADER),
          OPERATION_ID,
        );
        assert.equal(
          response.headers.get(OPERATION_OUTCOME_HEADER),
          'unknown',
        );
      },
    );
  },
);

test(
  'post-2xx JSON loss preserves the exact error body and reports unknown',
  { concurrency: false },
  async () => {
    await withGlobalFetch(
      async () => new Response('{"content":', { status: 200 }),
      async () => {
        const response = await worker.fetch(contentsMutationRequest(), ENV);
        assert.equal(response.status, 502);
        assert.deepEqual(await exactResponseJson(response), {
          error:
            'GitHub API PUT /repos/owner/repo/contents/annotations/users/ghid_42.json response contains invalid JSON',
        });
        assert.equal(
          response.headers.get(OPERATION_ID_HEADER),
          OPERATION_ID,
        );
        assert.equal(
          response.headers.get(OPERATION_OUTCOME_HEADER),
          'unknown',
        );
      },
    );
  },
);

test(
  'post-2xx projection failure preserves the exact error body and reports unknown',
  { concurrency: false },
  async () => {
    await withGlobalFetch(
      async () => new Response(JSON.stringify({
        content: { sha: 'short-sha' },
      }), { status: 200 }),
      async () => {
        const response = await worker.fetch(contentsMutationRequest(), ENV);
        assert.equal(response.status, 502);
        assert.deepEqual(await exactResponseJson(response), {
          error:
            'GitHub contents mutation response.content.sha must be exactly 40 lowercase hexadecimal characters',
        });
        assert.equal(
          response.headers.get(OPERATION_ID_HEADER),
          OPERATION_ID,
        );
        assert.equal(
          response.headers.get(OPERATION_OUTCOME_HEADER),
          'unknown',
        );
      },
    );
  },
);

test(
  'safe upstream retry metadata is forwarded and unsafe headers remain private',
  { concurrency: false },
  async () => {
    await withGlobalFetch(
      async () => new Response(
        '{"message":"rate limited","documentation_url":"https://docs.github.com/rest"}',
        {
          status: 429,
          headers: {
            'Retry-After': '7',
            'X-RateLimit-Reset': '2000000000',
            'X-GitHub-Request-Id': 'ABCD:1234:5678:9ABC:DEF0',
            'Set-Cookie': 'github-secret=must-not-leak',
            'X-OAuth-Scopes': 'repo',
          },
        },
      ),
      async () => {
        const response = await worker.fetch(contentsMutationRequest(), ENV);
        assert.equal(response.status, 429);
        assert.deepEqual(await exactResponseJson(response), {
          error: 'rate limited',
        });
        assert.equal(response.headers.get('Retry-After'), '7');
        assert.equal(
          response.headers.get('X-RateLimit-Reset'),
          '2000000000',
        );
        assert.equal(
          response.headers.get('X-GitHub-Request-Id'),
          'ABCD:1234:5678:9ABC:DEF0',
        );
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.equal(response.headers.get('X-OAuth-Scopes'), null);
        assert.equal(
          response.headers.get(OPERATION_ID_HEADER),
          OPERATION_ID,
        );
        assert.equal(
          response.headers.get(OPERATION_OUTCOME_HEADER),
          'not-applied',
        );
      },
    );
  },
);

test(
  'a caller abort is a cancellation carrying its reason; a silent Worker is stalled, never a total deadline',
  { concurrency: false },
  async () => {
    // Every request hangs until its own signal ends it.
    const hanging = async (_rawUrl, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason));
    });

    const caller = createDirectSync(hanging);
    const owner = new AbortController();
    const callerReason = new Error('first caller cancellation');
    caller.time.after(500, () => owner.abort(callerReason));
    await assert.rejects(
      caller.run(caller.sync.validateAndLoadConfig({ signal: owner.signal })),
      error => {
        assert.equal(error?.name, 'AbortError');
        assert.equal(error?.cause, callerReason);
        return true;
      },
    );
    assert.equal(caller.time.now(), 500, 'cancelled at once, not after a timeout');

    const stalled = createDirectSync(hanging);
    await assert.rejects(
      stalled.run(stalled.sync.validateAndLoadConfig({})),
      error => {
        assert.notEqual(error?.name, 'AbortError');
        assert.equal(error?.code, 'GITHUB_WORKER_UNREACHABLE');
        assert.equal(error?.answeredBefore, false);
        assert.match(error.message, /no answer for/);
        return true;
      },
    );
    // Stalls are asked again for RFC 1122's patience (at least 100 s), with
    // no 20 s total deadline anywhere.
    assert.ok(stalled.time.now() >= 100_000, `gave up after ${stalled.time.now()} ms`);
  },
);

test(
  'independent transport AbortError after mutation dispatch is conservatively unknown',
  { concurrency: false },
  async () => {
    const capture = {};
    const transportError = syntheticAbortError(
      'Synthetic independent transport abort',
    );
    const fetchImpl = createDirectBrowserFetch({
      capture,
      mutationError: transportError,
    });

    await withDeterministicRandomUuid(
      OPERATION_ID,
      () => assert.rejects(
        runDirect(fetchImpl, (sync) => sync.pushMyUserFile({
          userDoc: validUserDocument(),
          publicationMode: 'direct',
        })),
        error => {
          assert.equal(error?.code, 'GITHUB_MUTATION_OUTCOME_UNKNOWN');
          assert.notEqual(error?.name, 'AbortError');
          assert.ok(causeChain(error).includes(transportError), 'the transport failure is its cause');
          assert.deepEqual(error?.operation, {
            id: OPERATION_ID,
            kind: 'contents-put',
            outcome: 'unknown',
          });
          return true;
        },
      ),
    );
    assert.equal(capture.operationId, OPERATION_ID);
  },
);

test(
  'browser sends one generated operation id in the header and accepts an exact applied echo',
  { concurrency: false },
  async () => {
    const capture = {};
    const fetchImpl = createDirectBrowserFetch({ capture });
    const { calls, value: result } = await withDeterministicRandomUuid(
      OPERATION_ID,
      () => runDirect(fetchImpl, (sync) => sync.pushMyUserFile({
        userDoc: validUserDocument(),
        publicationMode: 'direct',
      })),
    );

    assert.equal(calls, 1);
    assert.equal(capture.operationId, OPERATION_ID);
    assert.deepEqual(
      Object.keys(capture.body).sort(),
      ['branch', 'content', 'message'],
    );
    assert.equal(Object.hasOwn(capture.body, 'operation'), false);
    // The view written comes back with it (what this browser keeps as published).
    const { view, ...written } = result;
    assert.deepEqual(written, {
      mode: 'direct',
      sha: SHA_B,
      branch: 'main',
      path: 'annotations/users/ghid_42.json',
      remoteUpdatedAt: null,
    });
    assert.equal(view.username, 'ghid_42');
  },
);

test(
  'browser treats a mismatched Worker operation echo as an unknown mutation outcome',
  { concurrency: false },
  async () => {
    const capture = {};
    const fetchImpl = createDirectBrowserFetch({
      capture,
      echoedOperationId: OTHER_OPERATION_ID,
    });

    await withDeterministicRandomUuid(
      OPERATION_ID,
      () => assert.rejects(
        runDirect(fetchImpl, (sync) => sync.pushMyUserFile({
          userDoc: validUserDocument(),
          publicationMode: 'direct',
        })),
        error => {
          assert.equal(error?.code, 'GITHUB_MUTATION_OUTCOME_UNKNOWN');
          assert.match(error?.message ?? '', /operation.*mismatch/i);
          assert.deepEqual(error?.operation, {
            id: OPERATION_ID,
            kind: 'contents-put',
            outcome: 'unknown',
          });
          return true;
        },
      ),
    );
    assert.equal(capture.operationId, OPERATION_ID);
  },
);

test(
  'browser treats a missing Worker outcome as unknown after dispatch',
  { concurrency: false },
  async () => {
    const capture = {};
    const fetchImpl = createDirectBrowserFetch({
      capture,
      outcome: null,
    });

    await withDeterministicRandomUuid(
      OPERATION_ID,
      () => assert.rejects(
        runDirect(fetchImpl, (sync) => sync.pushMyUserFile({
          userDoc: validUserDocument(),
          publicationMode: 'direct',
        })),
        error => {
          assert.equal(error?.code, 'GITHUB_MUTATION_OUTCOME_UNKNOWN');
          assert.match(error?.message ?? '', /operation.*outcome/i);
          assert.deepEqual(error?.operation, {
            id: OPERATION_ID,
            kind: 'contents-put',
            outcome: 'unknown',
          });
          return true;
        },
      ),
    );
    assert.equal(capture.operationId, OPERATION_ID);
  },
);

test(
  'browser keeps exact error JSON compatibility while attaching Worker outcome metadata',
  { concurrency: false },
  async () => {
    const capture = {};
    const fetchImpl = createDirectBrowserFetch({
      capture,
      outcome: 'unknown',
      mutationStatus: 503,
      mutationDocument: { error: 'upstream unavailable' },
    });

    await withDeterministicRandomUuid(
      OPERATION_ID,
      () => assert.rejects(
        runDirect(fetchImpl, (sync) => sync.pushMyUserFile({
          userDoc: validUserDocument(),
          publicationMode: 'direct',
        })),
        error => {
          assert.equal(error?.message, 'upstream unavailable');
          assert.equal(error?.status, 503);
          assert.deepEqual(error?.operation, {
            id: OPERATION_ID,
            kind: 'contents-put',
            outcome: 'unknown',
          });
          return true;
        },
      ),
    );
    assert.equal(capture.operationId, OPERATION_ID);
  },
);
