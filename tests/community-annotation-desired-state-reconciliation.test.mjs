import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationGitHubSync } from '../assets/js/app/community-annotations/github-sync.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';

const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccc';
const SHA_D = 'dddddddddddddddddddddddddddddddddddddddd';
const USER_PATH = 'annotations/users/ghid_42.json';
const MERGES_PATH = 'annotations/moderation/merges.json';

const OPERATION_IDS = Object.freeze([
  '018f5e3a-7b9c-4d2e-8f10-123456789a00',
  '018f5e3a-7b9c-4d2e-8f10-123456789a01',
  '018f5e3a-7b9c-4d2e-8f10-123456789a02',
  '018f5e3a-7b9c-4d2e-8f10-123456789a03',
]);

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

function validConfigDocument() {
  return {
    version: 1,
    supportedDatasets: [
      {
        datasetId: 'synthetic',
        name: 'Synthetic',
        fieldsToAnnotate: ['cell_type'],
        annotatableSettings: {
          cell_type: { minAnnotators: 1, threshold: 0.5 },
        },
        closedFields: [],
      },
    ],
  };
}

function validMergesDocument() {
  return {
    version: 1,
    updatedAt: '2026-07-25T01:02:03.456Z',
    merges: [],
  };
}

function exactPublishedJson(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function encodeBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeBase64(text) {
  return Buffer.from(text, 'base64').toString('utf8');
}

function contentDocument(text, sha = SHA_B) {
  return {
    type: 'file',
    encoding: 'base64',
    content: encodeBase64(text),
    sha,
  };
}

function rawContentDocument(content, sha = SHA_B) {
  return {
    type: 'file',
    encoding: 'base64',
    content,
    sha,
  };
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), { status });
}

function jsonResponse(document, {
  status = 200,
  operationId = null,
  outcome = null,
} = {}) {
  const headers = {};
  if (operationId !== null) headers[OPERATION_ID_HEADER] = operationId;
  if (outcome !== null) headers[OPERATION_OUTCOME_HEADER] = outcome;
  return new Response(JSON.stringify(document), { status, headers });
}

function directRepoInfo({ canManage = false } = {}) {
  return {
    full_name: 'owner/repo',
    default_branch: 'main',
    private: false,
    allow_forking: true,
    permissions: {
      pull: true,
      triage: false,
      push: true,
      maintain: canManage,
      admin: false,
    },
  };
}

function forkOnlyRepoInfo() {
  return {
    full_name: 'owner/repo',
    default_branch: 'main',
    private: false,
    allow_forking: true,
    permissions: {
      pull: true,
      triage: false,
      push: false,
      maintain: false,
      admin: false,
    },
  };
}

function forkRecord() {
  return {
    full_name: 'researcher/repo',
    name: 'repo',
    owner: { login: 'researcher' },
    parent: { full_name: 'owner/repo' },
  };
}

function forkIdentityRecord() {
  return {
    full_name: 'researcher/repo',
    fork: true,
    parent: { full_name: 'owner/repo' },
  };
}

function pullRequestRecord() {
  return {
    number: 7,
    html_url: 'https://github.com/owner/repo/pull/7',
  };
}

function schemaDocument(kind) {
  const ids = {
    user:
      'https://cellucid.com/contracts/community-annotation/user-v1.schema.json',
    config:
      'https://cellucid.com/contracts/community-annotation/config-v1.schema.json',
    merges:
      'https://cellucid.com/contracts/community-annotation/merges-v1.schema.json',
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: ids[kind],
  };
}

function createSync() {
  return new CommunityAnnotationGitHubSync({
    datasetId: 'synthetic',
    owner: 'owner',
    repo: 'repo',
    token: 'test-token',
    branch: 'main',
    workerOrigin: 'https://worker.example',
  });
}

async function withGlobalFetch(fetchImpl, operation) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function withImmediateReadinessTimers(operation) {
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, delay, ...args) =>
    previousSetTimeout(
      handler,
      Number(delay) < 5_000 ? 0 : delay,
      ...args,
    );
  try {
    return await operation();
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
}

async function withDeterministicOperationIds(operation) {
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
      const id = OPERATION_IDS[calls];
      calls += 1;
      if (id === undefined) {
        throw new Error('Unexpected unbounded mutation replay');
      }
      return id;
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

function requestRecord(rawUrl, options = {}) {
  const url = new URL(rawUrl);
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  const body = options.body === undefined
    ? null
    : parseExactJson(options.body, {
        path: `${method} ${url.pathname} request body`,
      });
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers,
    body,
  };
}

function mutationKind(request) {
  if (
    request.method === 'PUT' &&
    request.path.includes('/contents/')
  ) {
    return 'contents-put';
  }
  if (
    request.method === 'POST' &&
    request.path.endsWith('/git/refs')
  ) {
    return 'git-refs-post';
  }
  if (
    request.method === 'POST' &&
    request.path.endsWith('/forks')
  ) {
    return 'forks-post';
  }
  if (
    request.method === 'POST' &&
    request.path.endsWith('/pulls')
  ) {
    return 'pulls-post';
  }
  return null;
}

function requireMutationOperation(request, seenOperationIds) {
  const id = request.headers.get(OPERATION_ID_HEADER);
  assert.match(
    id ?? '',
    OPERATION_ID,
    `${request.method} ${request.path} must carry a canonical operation id`,
  );
  assert.equal(
    seenOperationIds.has(id),
    false,
    'each mutation dispatch must own a fresh operation id',
  );
  seenOperationIds.add(id);
  assert.equal(
    request.body !== null && Object.hasOwn(request.body, 'operation'),
    false,
    'operation metadata must not enter a GitHub request body',
  );
  return id;
}

class ForkPublicationWorkerMock {
  constructor({
    lossKind = null,
    forkExists = true,
    branchExists = true,
    branchSha = SHA_A,
    createdBranchSha = SHA_A,
    forkFileText = exactPublishedJson(validUserDocument()),
    pullRequestExists = true,
    malformedAppliedKind = null,
    forkReady = true,
    forkTransient404s = 0,
    abortOnForkProbe = null,
    enforceForkReadiness = false,
  } = {}) {
    this.lossKind = lossKind;
    this.forkExists = forkExists;
    this.branchExists = branchExists;
    this.branchSha = branchSha;
    this.createdBranchSha = createdBranchSha;
    this.forkFileText = forkFileText;
    this.pullRequestExists = pullRequestExists;
    this.malformedAppliedKind = malformedAppliedKind;
    this.forkReady = forkReady;
    this.forkTransient404s = forkTransient404s;
    this.abortOnForkProbe = abortOnForkProbe;
    this.enforceForkReadiness = enforceForkReadiness;
    this.forkProbeCount = 0;
    this.requests = [];
    this.seenOperationIds = new Set();
    this.lossRequestIndex = null;
    this.branch = null;
    this.mutationCounts = new Map();
  }

  countMutations(kind = null) {
    if (kind !== null) return this.mutationCounts.get(kind) ?? 0;
    return [...this.mutationCounts.values()]
      .reduce((sum, count) => sum + count, 0);
  }

  requestsAfterLoss(predicate) {
    assert.notEqual(
      this.lossRequestIndex,
      null,
      'the configured response loss must occur',
    );
    return this.requests
      .slice(this.lossRequestIndex + 1)
      .filter(predicate);
  }

  async fetch(rawUrl, options = {}) {
    const request = requestRecord(rawUrl, options);
    const kind = mutationKind(request);
    if (kind !== null) {
      request.operationId = requireMutationOperation(
        request,
        this.seenOperationIds,
      );
      this.mutationCounts.set(
        kind,
        (this.mutationCounts.get(kind) ?? 0) + 1,
      );
    }
    this.requests.push(request);

    if (
      request.method === 'GET' &&
      request.path === '/auth/user'
    ) {
      return jsonResponse({ id: 42, login: 'researcher' });
    }
    if (
      request.method === 'GET' &&
      request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
    ) {
      assert.equal(request.query.get('ref'), 'main');
      return errorResponse('Not Found', 404);
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo'
    ) {
      return jsonResponse(forkOnlyRepoInfo());
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/researcher/repo'
    ) {
      assert.equal(request.query.get('fork_identity'), '1');
      assert.equal(request.query.size, 1);
      return this.forkExists
        ? jsonResponse(forkIdentityRecord())
        : errorResponse('Not Found', 404);
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo/forks'
    ) {
      assert.equal(request.query.get('sort'), 'newest');
      assert.equal(request.query.get('per_page'), '100');
      assert.equal(request.query.get('page'), '1');
      return jsonResponse(this.forkExists ? [forkRecord()] : []);
    }
    if (
      request.method === 'POST' &&
      request.path === '/api/repos/owner/repo/forks'
    ) {
      assert.deepEqual(request.body, {});
      this.forkExists = true;
      return this.#mutationResult(
        request,
        kind,
        forkRecord(),
        202,
      );
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo/git/ref/heads/main'
    ) {
      return jsonResponse({ object: { sha: SHA_A } });
    }
    if (
      request.method === 'GET' &&
      request.path ===
        '/api/repos/researcher/repo/git/ref/heads/main'
    ) {
      this.forkProbeCount += 1;
      if (
        this.abortOnForkProbe !== null &&
        this.forkProbeCount === this.abortOnForkProbe.probe
      ) {
        this.abortOnForkProbe.controller.abort(
          this.abortOnForkProbe.reason,
        );
      }
      if (
        !this.forkReady &&
        this.forkProbeCount <= this.forkTransient404s
      ) {
        return errorResponse('Fork is not ready', 404);
      }
      this.forkReady = true;
      return jsonResponse({ object: { sha: SHA_A } });
    }
    if (
      this.enforceForkReadiness &&
      (
        request.path.startsWith(
          '/api/repos/researcher/repo/git/ref/heads/cellucid-annotations/',
        ) ||
        request.path === '/api/repos/researcher/repo/git/refs' ||
        request.path ===
          `/api/repos/researcher/repo/contents/${USER_PATH}` ||
        request.path === '/api/repos/owner/repo/pulls'
      )
    ) {
      assert.equal(
        this.forkReady,
        true,
        'branch/file/PR operations must wait for exact fork ref readiness',
      );
    }
    if (
      request.method === 'GET' &&
      request.path.startsWith(
        '/api/repos/researcher/repo/git/ref/heads/cellucid-annotations/',
      )
    ) {
      const branch = request.path.replace(
        '/api/repos/researcher/repo/git/ref/heads/',
        '',
      );
      this.#observeBranch(branch);
      return this.branchExists
        ? jsonResponse({ object: { sha: this.branchSha } })
        : errorResponse('Not Found', 404);
    }
    if (
      request.method === 'POST' &&
      request.path === '/api/repos/researcher/repo/git/refs'
    ) {
      assert.equal(request.body.sha, SHA_A);
      assert.match(
        request.body.ref,
        /^refs\/heads\/cellucid-annotations\/ghid_42\/[a-z0-9]+$/,
      );
      this.#observeBranch(request.body.ref.replace('refs/heads/', ''));
      this.branchExists = true;
      this.branchSha = this.createdBranchSha;
      return this.#mutationResult(request, kind, {}, 201);
    }
    if (
      request.method === 'GET' &&
      request.path ===
        `/api/repos/researcher/repo/contents/${USER_PATH}`
    ) {
      assert.notEqual(this.branch, null);
      assert.equal(request.query.get('ref'), this.branch);
      return this.forkFileText === null
        ? errorResponse('Not Found', 404)
        : jsonResponse(contentDocument(this.forkFileText, SHA_B));
    }
    if (
      request.method === 'PUT' &&
      request.path ===
        `/api/repos/researcher/repo/contents/${USER_PATH}`
    ) {
      assert.notEqual(this.branch, null);
      assert.equal(request.body.branch, this.branch);
      assert.equal(
        request.body.content,
        encodeBase64(exactPublishedJson(validUserDocument())),
      );
      this.forkFileText = decodeBase64(request.body.content);
      return this.#mutationResult(
        request,
        kind,
        { content: { sha: SHA_C } },
        200,
      );
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo/pulls'
    ) {
      assert.notEqual(this.branch, null);
      assert.equal(request.query.get('state'), 'open');
      assert.equal(
        request.query.get('head'),
        `researcher:${this.branch}`,
      );
      assert.equal(request.query.get('base'), 'main');
      assert.equal(request.query.get('per_page'), '100');
      return jsonResponse(
        this.pullRequestExists ? [pullRequestRecord()] : [],
      );
    }
    if (
      request.method === 'POST' &&
      request.path === '/api/repos/owner/repo/pulls'
    ) {
      assert.notEqual(this.branch, null);
      assert.equal(request.body.head, `researcher:${this.branch}`);
      assert.equal(request.body.base, 'main');
      assert.equal(request.body.maintainer_can_modify, true);
      this.pullRequestExists = true;
      return this.#mutationResult(
        request,
        kind,
        this.malformedAppliedKind === kind
          ? {
              number: 0,
              html_url: 'http://github.com/owner/repo/pull/7',
            }
          : pullRequestRecord(),
        201,
      );
    }

    throw new Error(
      `Unexpected synthetic Worker request: ${request.method} ${request.path}`,
    );
  }

  #observeBranch(branch) {
    if (this.branch === null) {
      this.branch = branch;
    } else {
      assert.equal(branch, this.branch);
    }
  }

  #mutationResult(request, kind, document, status) {
    if (
      kind === this.lossKind &&
      this.lossRequestIndex === null
    ) {
      this.lossRequestIndex = this.requests.length - 1;
      throw new TypeError(
        `Synthetic Worker response loss after GitHub applied ${kind}`,
      );
    }
    return jsonResponse(document, {
      status,
      operationId: request.operationId,
      outcome: 'applied',
    });
  }
}

class DirectContentsWorkerMock {
  constructor({
    remoteText = null,
    remoteSha = SHA_B,
    loseFirstPut = false,
    abortController = null,
    abortReason = null,
  } = {}) {
    this.remoteText = remoteText;
    this.remoteSha = remoteSha;
    this.loseFirstPut = loseFirstPut;
    this.abortController = abortController;
    this.abortReason = abortReason;
    this.requests = [];
    this.seenOperationIds = new Set();
    this.putCount = 0;
    this.putRequestIndex = null;
  }

  async fetch(rawUrl, options = {}) {
    const request = requestRecord(rawUrl, options);
    const kind = mutationKind(request);
    if (kind !== null) {
      request.operationId = requireMutationOperation(
        request,
        this.seenOperationIds,
      );
    }
    this.requests.push(request);

    if (
      request.method === 'GET' &&
      request.path === '/auth/user'
    ) {
      return jsonResponse({ id: 42, login: 'researcher' });
    }
    if (
      request.method === 'GET' &&
      request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
    ) {
      assert.equal(request.query.get('ref'), 'main');
      return this.remoteText === null
        ? errorResponse('Not Found', 404)
        : jsonResponse(contentDocument(this.remoteText, this.remoteSha));
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo'
    ) {
      return jsonResponse(directRepoInfo());
    }
    if (
      request.method === 'PUT' &&
      request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
    ) {
      this.putCount += 1;
      if (this.putRequestIndex === null) {
        this.putRequestIndex = this.requests.length - 1;
      }
      assert.equal(request.body.branch, 'main');
      assert.equal(
        request.body.content,
        encodeBase64(exactPublishedJson(validUserDocument())),
      );
      this.remoteText = decodeBase64(request.body.content);
      this.remoteSha = SHA_C;
      if (this.loseFirstPut && this.putCount === 1) {
        this.abortController?.abort(this.abortReason);
        const error = new TypeError(
          'Synthetic Worker response loss after GitHub applied contents PUT',
        );
        if (this.abortController !== null) error.name = 'AbortError';
        throw error;
      }
      return jsonResponse(
        { content: { sha: this.remoteSha } },
        {
          status: 200,
          operationId: request.operationId,
          outcome: 'applied',
        },
      );
    }
    throw new Error(
      `Unexpected synthetic Worker request: ${request.method} ${request.path}`,
    );
  }
}

class DirectMutationWorkerMock {
  constructor({
    initialContent = null,
    reconciliationContent = contentDocument(
      exactPublishedJson(validUserDocument()),
      SHA_C,
    ),
    mutation,
    abortDuringReconciliation = null,
  }) {
    this.initialContent = initialContent;
    this.reconciliationContent = reconciliationContent;
    this.mutation = mutation;
    this.abortDuringReconciliation = abortDuringReconciliation;
    this.requests = [];
    this.seenOperationIds = new Set();
    this.contentReads = 0;
    this.putCount = 0;
  }

  async fetch(rawUrl, options = {}) {
    const request = requestRecord(rawUrl, options);
    const kind = mutationKind(request);
    if (kind !== null) {
      request.operationId = requireMutationOperation(
        request,
        this.seenOperationIds,
      );
    }
    this.requests.push(request);

    if (
      request.method === 'GET' &&
      request.path === '/auth/user'
    ) {
      return jsonResponse({ id: 42, login: 'researcher' });
    }
    if (
      request.method === 'GET' &&
      request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
    ) {
      assert.equal(request.query.get('ref'), 'main');
      this.contentReads += 1;
      const document = this.contentReads === 1
        ? this.initialContent
        : this.reconciliationContent;
      if (
        this.contentReads > 1 &&
        this.abortDuringReconciliation !== null
      ) {
        this.abortDuringReconciliation.controller.abort(
          this.abortDuringReconciliation.reason,
        );
      }
      return document === null
        ? errorResponse('Not Found', 404)
        : jsonResponse(document);
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo'
    ) {
      return jsonResponse(directRepoInfo());
    }
    if (
      request.method === 'PUT' &&
      request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
    ) {
      this.putCount += 1;
      assert.equal(kind, 'contents-put');
      assert.equal(request.body.branch, 'main');
      assert.equal(
        request.body.content,
        encodeBase64(exactPublishedJson(validUserDocument())),
      );
      if (this.mutation.type === 'throw') {
        throw this.mutation.error;
      }
      return jsonResponse(this.mutation.document, {
        status: this.mutation.status,
        operationId: request.operationId,
        outcome: this.mutation.outcome,
      });
    }
    throw new Error(
      `Unexpected direct mutation request: ${request.method} ${request.path}`,
    );
  }
}

function countRequests(requests, method, path) {
  return requests.filter(
    request => request.method === method && request.path === path,
  ).length;
}

test(
  'live transport loss after a direct contents PUT reconciles exact bytes once without replay',
  { concurrency: false },
  async () => {
    const worker = new DirectContentsWorkerMock({
      loseFirstPut: true,
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'direct',
          }),
        ));

    assert.equal(calls, 1);
    assert.equal(worker.putCount, 1);
    assert.notEqual(worker.putRequestIndex, null);
    assert.equal(
      worker.requests[worker.putRequestIndex + 1]?.method,
      'GET',
      'direct reconciliation must begin with a read, not a flow replay',
    );
    assert.equal(
      worker.requests[worker.putRequestIndex + 1]?.path,
      `/api/repos/owner/repo/contents/${USER_PATH}`,
      'direct reconciliation must immediately inspect the mutated file',
    );
    const readsAfterLoss = worker.requests
      .slice(worker.putRequestIndex + 1)
      .filter(request =>
        request.method === 'GET' &&
        request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
      );
    assert.equal(
      readsAfterLoss.length,
      1,
      'contents uncertainty must use one exact-byte reconciliation read',
    );
    assert.equal(result.mode, 'direct');
    assert.equal(result.sha, SHA_C);
    assert.equal(result.path, USER_PATH);
  },
);

test(
  'unproved contents reconciliation preserves the original unknown outcome without replay',
  { concurrency: false },
  async t => {
    const cases = [
      {
        label: 'mismatched bytes',
        reconciliationContent: contentDocument(
          '{"different":true}\n',
          SHA_D,
        ),
      },
      {
        label: '404 after the mutation',
        reconciliationContent: null,
      },
    ];

    for (const contract of cases) {
      await t.test(contract.label, { concurrency: false }, async () => {
        const transportError = new TypeError(
          `Synthetic lost contents response: ${contract.label}`,
        );
        const worker = new DirectMutationWorkerMock({
          reconciliationContent: contract.reconciliationContent,
          mutation: {
            type: 'throw',
            error: transportError,
          },
        });
        const { calls } = await withDeterministicOperationIds(() =>
          withGlobalFetch(
            worker.fetch.bind(worker),
            () => assert.rejects(
              createSync().pushMyUserFile({
                userDoc: validUserDocument(),
                publicationMode: 'direct',
              }),
              error => {
                assert.equal(
                  error?.message,
                  'GitHub mutation outcome is unknown after a transport failure',
                );
                assert.equal(
                  error?.code,
                  'GITHUB_MUTATION_OUTCOME_UNKNOWN',
                );
                assert.equal(error?.cause, transportError);
                assert.deepEqual(error?.operation, {
                  id: OPERATION_IDS[0],
                  kind: 'contents-put',
                  outcome: 'unknown',
                });
                return true;
              },
            ),
          ));

        assert.equal(calls, 1);
        assert.equal(worker.putCount, 1);
        assert.equal(worker.contentReads, 2);
        assert.equal(worker.seenOperationIds.size, 1);
        const requestsAfterPut = worker.requests.slice(
          worker.requests.findIndex(request => request.method === 'PUT') + 1,
        );
        assert.equal(
          requestsAfterPut.filter(request => request.method !== 'GET').length,
          0,
          'a failed desired-state proof must never replay a mutation',
        );
      });
    }
  },
);

test(
  'caller abort during reconciliation cannot replace the original unknown mutation',
  { concurrency: false },
  async () => {
    const owner = new AbortController();
    const callerReason = new Error('Dialog closed during reconciliation');
    const transportError = new TypeError(
      'Synthetic lost contents response before caller abort',
    );
    const worker = new DirectMutationWorkerMock({
      mutation: {
        type: 'throw',
        error: transportError,
      },
      abortDuringReconciliation: {
        controller: owner,
        reason: callerReason,
      },
    });

    const { calls } = await withDeterministicOperationIds(() =>
      withGlobalFetch(
        worker.fetch.bind(worker),
        () => assert.rejects(
          createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'direct',
            signal: owner.signal,
          }),
          error => {
            assert.equal(
              error?.code,
              'GITHUB_MUTATION_OUTCOME_UNKNOWN',
            );
            assert.equal(error?.cause, transportError);
            assert.deepEqual(error?.operation, {
              id: OPERATION_IDS[0],
              kind: 'contents-put',
              outcome: 'unknown',
            });
            assert.notEqual(error?.cause, callerReason);
            return true;
          },
        ),
      ));

    assert.equal(owner.signal.aborted, true);
    assert.equal(owner.signal.reason, callerReason);
    assert.equal(calls, 1);
    assert.equal(worker.putCount, 1);
    assert.equal(worker.contentReads, 2);
    assert.equal(worker.seenOperationIds.size, 1);
  },
);

test(
  'contents 409 and 422 races converge only after exact-state proof',
  { concurrency: false },
  async t => {
    for (const status of [409, 422]) {
      await t.test(`HTTP ${status}`, { concurrency: false }, async () => {
        const worker = new DirectMutationWorkerMock({
          mutation: {
            type: 'response',
            status,
            outcome: 'not-applied',
            document: { error: `Synthetic ${status} contents race` },
          },
        });
        const { calls, value: result } =
          await withDeterministicOperationIds(() =>
            withGlobalFetch(
              worker.fetch.bind(worker),
              () => createSync().pushMyUserFile({
                userDoc: validUserDocument(),
                publicationMode: 'direct',
              }),
            ));

        assert.equal(calls, 1);
        assert.equal(worker.putCount, 1);
        assert.equal(worker.contentReads, 2);
        assert.equal(result.mode, 'direct');
        assert.equal(result.sha, SHA_C);
        assert.equal(result.path, USER_PATH);
      });
    }
  },
);

test(
  'applied contents response with a malformed projection reconciles exact bytes',
  { concurrency: false },
  async () => {
    const worker = new DirectMutationWorkerMock({
      mutation: {
        type: 'response',
        status: 200,
        outcome: 'applied',
        document: {
          content: { sha: 'not-a-github-sha' },
        },
      },
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'direct',
          }),
        ));

    assert.equal(calls, 1);
    assert.equal(worker.putCount, 1);
    assert.equal(worker.contentReads, 2);
    assert.equal(result.mode, 'direct');
    assert.equal(result.sha, SHA_C);
  },
);

test(
  'fork publication reconciles each applied-but-unobserved create exactly once',
  { concurrency: false },
  async t => {
    const cases = [
      {
        label: 'fork POST',
        kind: 'forks-post',
        state: {
          forkExists: false,
          branchExists: true,
          forkFileText: exactPublishedJson(validUserDocument()),
          pullRequestExists: true,
        },
        isReconciliationRead(request) {
          return (
            request.method === 'GET' &&
            request.path === '/api/repos/researcher/repo' &&
            request.query.get('fork_identity') === '1'
          );
        },
      },
      {
        label: 'ref POST',
        kind: 'git-refs-post',
        state: {
          forkExists: true,
          branchExists: false,
          forkFileText: exactPublishedJson(validUserDocument()),
          pullRequestExists: true,
        },
        isReconciliationRead(request) {
          return (
            request.method === 'GET' &&
            request.path.startsWith(
              '/api/repos/researcher/repo/git/ref/heads/',
            )
          );
        },
      },
      {
        label: 'fork-branch contents PUT',
        kind: 'contents-put',
        state: {
          forkExists: true,
          branchExists: true,
          forkFileText: null,
          pullRequestExists: true,
        },
        isReconciliationRead(request) {
          return (
            request.method === 'GET' &&
            request.path ===
              `/api/repos/researcher/repo/contents/${USER_PATH}`
          );
        },
      },
      {
        label: 'pull request POST',
        kind: 'pulls-post',
        state: {
          forkExists: true,
          branchExists: true,
          forkFileText: exactPublishedJson(validUserDocument()),
          pullRequestExists: false,
        },
        isReconciliationRead(request) {
          return (
            request.method === 'GET' &&
            request.path === '/api/repos/owner/repo/pulls'
          );
        },
      },
    ];

    for (const contract of cases) {
      await t.test(contract.label, { concurrency: false }, async () => {
        const worker = new ForkPublicationWorkerMock({
          lossKind: contract.kind,
          ...contract.state,
        });
        const { calls, value: result } =
          await withDeterministicOperationIds(() =>
            withGlobalFetch(
              worker.fetch.bind(worker),
              () => createSync().pushMyUserFile({
                userDoc: validUserDocument(),
                publicationMode: 'fork-pull-request',
              }),
            ));

        assert.equal(calls, 1);
        assert.equal(worker.countMutations(), 1);
        assert.equal(worker.countMutations(contract.kind), 1);
        assert.equal(
          contract.isReconciliationRead(
            worker.requests[worker.lossRequestIndex + 1],
          ),
          true,
          `${contract.label} must reconcile locally before resuming the flow`,
        );
        assert.equal(
          worker.requestsAfterLoss(
            contract.isReconciliationRead,
          ).length,
          1,
          `${contract.label} uncertainty must have one bounded exact-state read`,
        );
        assert.equal(result.mode, 'fork-pull-request');
        assert.equal(result.prNumber, 7);
        assert.equal(
          result.prUrl,
          'https://github.com/owner/repo/pull/7',
        );
        assert.equal(result.path, USER_PATH);
      });
    }
  },
);

test(
  'new and reconciled forks wait for exact base-ref readiness without replay',
  { concurrency: false, timeout: 2_000 },
  async t => {
    const cases = [
      {
        label: 'successful 202 creation',
        lossKind: null,
      },
      {
        label: 'applied creation reconciled after response loss',
        lossKind: 'forks-post',
      },
    ];

    for (const contract of cases) {
      await t.test(
        contract.label,
        { concurrency: false, timeout: 2_000 },
        async () => {
          const worker = new ForkPublicationWorkerMock({
            lossKind: contract.lossKind,
            forkExists: false,
            forkReady: false,
            forkTransient404s: 2,
            enforceForkReadiness: true,
            branchExists: true,
            forkFileText: exactPublishedJson(validUserDocument()),
            pullRequestExists: true,
          });
          const { calls, value: result } =
            await withImmediateReadinessTimers(() =>
              withDeterministicOperationIds(() =>
                withGlobalFetch(
                  worker.fetch.bind(worker),
                  () => createSync().pushMyUserFile({
                    userDoc: validUserDocument(),
                    publicationMode: 'fork-pull-request',
                  }),
                )));

          assert.equal(calls, 1);
          assert.equal(worker.countMutations('forks-post'), 1);
          assert.equal(worker.countMutations(), 1);
          assert.equal(
            worker.forkProbeCount,
            3,
            'two transient 404s must be followed by one exact readable ref',
          );
          assert.equal(
            countRequests(
              worker.requests,
              'POST',
              '/api/repos/owner/repo/forks',
            ),
            1,
            'readiness must never replay fork creation',
          );
          const lastProbeIndex = worker.requests.findLastIndex(request =>
            request.method === 'GET' &&
            request.path ===
              '/api/repos/researcher/repo/git/ref/heads/main'
          );
          const firstPublicationIndex = worker.requests.findIndex(request =>
            request.path.startsWith(
              '/api/repos/researcher/repo/git/ref/heads/cellucid-annotations/',
            ) ||
            request.path ===
              `/api/repos/researcher/repo/contents/${USER_PATH}` ||
            request.path === '/api/repos/owner/repo/pulls'
          );
          assert.notEqual(lastProbeIndex, -1);
          assert.notEqual(firstPublicationIndex, -1);
          assert.ok(
            lastProbeIndex < firstPublicationIndex,
            'fork readiness must precede branch/file/PR operations',
          );
          assert.equal(result.mode, 'fork-pull-request');
          assert.equal(result.prNumber, 7);
        },
      );
    }
  },
);

test(
  'caller abort stops fork-readiness probes before publication operations',
  { concurrency: false, timeout: 2_000 },
  async () => {
    const owner = new AbortController();
    const callerReason = new Error('Annotation dialog closed during fork readiness');
    const worker = new ForkPublicationWorkerMock({
      forkExists: false,
      forkReady: false,
      forkTransient404s: Number.MAX_SAFE_INTEGER,
      abortOnForkProbe: {
        probe: 1,
        controller: owner,
        reason: callerReason,
      },
      enforceForkReadiness: true,
      branchExists: true,
      forkFileText: exactPublishedJson(validUserDocument()),
      pullRequestExists: true,
    });

    const { calls } = await withImmediateReadinessTimers(() =>
      withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => assert.rejects(
            createSync().pushMyUserFile({
              userDoc: validUserDocument(),
              publicationMode: 'fork-pull-request',
              signal: owner.signal,
            }),
            error => {
              assert.equal(error?.code, 'GITHUB_REQUEST_ABORTED');
              assert.equal(error?.cause, callerReason);
              return true;
            },
          ),
        )));

    assert.equal(calls, 1);
    assert.equal(worker.countMutations('forks-post'), 1);
    assert.equal(worker.forkProbeCount, 1);
    assert.equal(
      worker.requests.some(request =>
        request.path.startsWith(
          '/api/repos/researcher/repo/git/ref/heads/cellucid-annotations/',
        ) ||
        request.path ===
          `/api/repos/researcher/repo/contents/${USER_PATH}` ||
        request.path === '/api/repos/owner/repo/pulls'
      ),
      false,
    );
  },
);

test(
  'fork-readiness exhaustion is bounded and actionable without replay',
  { concurrency: false, timeout: 2_000 },
  async () => {
    const worker = new ForkPublicationWorkerMock({
      forkExists: false,
      forkReady: false,
      forkTransient404s: Number.MAX_SAFE_INTEGER,
      enforceForkReadiness: true,
      branchExists: true,
      forkFileText: exactPublishedJson(validUserDocument()),
      pullRequestExists: true,
    });

    const { calls } = await withImmediateReadinessTimers(() =>
      withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => assert.rejects(
            createSync().pushMyUserFile({
              userDoc: validUserDocument(),
              publicationMode: 'fork-pull-request',
            }),
            error => {
              assert.equal(error?.code, 'GITHUB_FORK_NOT_READY');
              assert.match(error?.message ?? '', /researcher\/repo/);
              assert.match(error?.message ?? '', /main/);
              assert.match(error?.message ?? '', /retry|try again/i);
              return true;
            },
          ),
        )));

    assert.equal(calls, 1);
    assert.equal(worker.countMutations('forks-post'), 1);
    assert.ok(
      worker.forkProbeCount >= 2 && worker.forkProbeCount <= 8,
      `readiness used an unbounded attempt count: ${worker.forkProbeCount}`,
    );
    assert.equal(
      countRequests(
        worker.requests,
        'POST',
        '/api/repos/owner/repo/forks',
      ),
      1,
    );
    assert.equal(
      worker.requests.some(request =>
        request.path.startsWith(
          '/api/repos/researcher/repo/git/ref/heads/cellucid-annotations/',
        ) ||
        request.path ===
          `/api/repos/researcher/repo/contents/${USER_PATH}` ||
        request.path === '/api/repos/owner/repo/pulls'
      ),
      false,
    );
  },
);

test(
  'applied Pull Request response with a malformed projection reconciles the open PR',
  { concurrency: false },
  async () => {
    const worker = new ForkPublicationWorkerMock({
      forkExists: true,
      branchExists: true,
      forkFileText: exactPublishedJson(validUserDocument()),
      pullRequestExists: false,
      malformedAppliedKind: 'pulls-post',
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'fork-pull-request',
          }),
        ));

    assert.equal(calls, 1);
    assert.equal(worker.countMutations(), 1);
    assert.equal(worker.countMutations('pulls-post'), 1);
    assert.equal(
      countRequests(
        worker.requests,
        'GET',
        '/api/repos/owner/repo/pulls',
      ),
      2,
      'one initial lookup and one applied-projection reconciliation are required',
    );
    assert.equal(result.mode, 'fork-pull-request');
    assert.equal(result.prNumber, 7);
    assert.equal(
      result.prUrl,
      'https://github.com/owner/repo/pull/7',
    );
  },
);

test(
  'an existing deterministic branch remains reusable at a different tip',
  { concurrency: false },
  async () => {
    const worker = new ForkPublicationWorkerMock({
      forkExists: true,
      branchExists: true,
      branchSha: SHA_D,
      forkFileText: exactPublishedJson(validUserDocument()),
      pullRequestExists: true,
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'fork-pull-request',
          }),
        ));

    assert.equal(calls, 0);
    assert.equal(worker.countMutations(), 0);
    assert.equal(
      countRequests(
        worker.requests,
        'POST',
        '/api/repos/researcher/repo/git/refs',
      ),
      0,
      'a persistent publication branch must not be recreated or reset',
    );
    assert.equal(result.mode, 'fork-pull-request');
    assert.equal(result.prNumber, 7);
  },
);

test(
  'post-create ref reconciliation rejects a different branch tip without replay',
  { concurrency: false },
  async () => {
    const worker = new ForkPublicationWorkerMock({
      lossKind: 'git-refs-post',
      forkExists: true,
      branchExists: false,
      createdBranchSha: SHA_D,
      forkFileText: exactPublishedJson(validUserDocument()),
      pullRequestExists: true,
    });
    const { calls } = await withDeterministicOperationIds(() =>
      withGlobalFetch(
        worker.fetch.bind(worker),
        () => assert.rejects(
          createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'fork-pull-request',
          }),
          error => {
            assert.equal(
              error?.code,
              'GITHUB_MUTATION_OUTCOME_UNKNOWN',
            );
            assert.deepEqual(error?.operation, {
              id: OPERATION_IDS[0],
              kind: 'git-refs-post',
              outcome: 'unknown',
            });
            assert.match(
              error?.cause?.message ?? '',
              /applied git-refs-post/,
            );
            return true;
          },
        ),
      ));

    assert.equal(calls, 1);
    assert.equal(worker.countMutations(), 1);
    assert.equal(worker.countMutations('git-refs-post'), 1);
    assert.equal(
      worker.requestsAfterLoss(request =>
        request.method === 'GET' &&
        request.path.startsWith(
          '/api/repos/researcher/repo/git/ref/heads/',
        )
      ).length,
      1,
    );
    assert.equal(
      worker.requestsAfterLoss(request => request.method !== 'GET').length,
      0,
      'a mismatched reconciliation tip must stop the flow',
    );
  },
);

test(
  'an exact fork-branch user file is a no-op before any blind contents PUT',
  { concurrency: false },
  async () => {
    const worker = new ForkPublicationWorkerMock({
      forkExists: true,
      branchExists: true,
      forkFileText: exactPublishedJson(validUserDocument()),
      pullRequestExists: true,
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'fork-pull-request',
          }),
        ));

    assert.equal(calls, 0);
    assert.equal(worker.countMutations(), 0);
    assert.equal(result.mode, 'fork-pull-request');
    assert.equal(result.prNumber, 7);
  },
);

test(
  'exact user bytes short-circuit a stale baseline before metadata or PUT',
  { concurrency: false },
  async () => {
    const worker = new DirectContentsWorkerMock({
      remoteText: exactPublishedJson(validUserDocument()),
      remoteSha: SHA_B,
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
        ));

    assert.equal(calls, 0);
    assert.equal(worker.putCount, 0);
    assert.equal(
      countRequests(
        worker.requests,
        'GET',
        '/api/repos/owner/repo',
      ),
      0,
      'an exact user no-op must finish before repository metadata',
    );
    assert.equal(result.mode, 'none');
    assert.equal(result.sha, SHA_B);
    assert.equal(result.path, USER_PATH);
  },
);

test(
  'folded base64 with exact decoded bytes remains a user-file no-op',
  { concurrency: false },
  async () => {
    const canonical = encodeBase64(
      exactPublishedJson(validUserDocument()),
    );
    const folded =
      `${canonical.slice(0, 16)}\r\n` +
      `${canonical.slice(16, 40)}\n` +
      canonical.slice(40);
    const worker = new DirectMutationWorkerMock({
      initialContent: rawContentDocument(folded, SHA_B),
      mutation: {
        type: 'throw',
        error: new Error('A folded exact no-op must not publish'),
      },
    });
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch.bind(worker),
          () => createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
        ));

    assert.equal(calls, 0);
    assert.equal(worker.contentReads, 1);
    assert.equal(worker.putCount, 0);
    assert.equal(
      countRequests(
        worker.requests,
        'GET',
        '/api/repos/owner/repo',
      ),
      0,
    );
    assert.equal(result.mode, 'none');
    assert.equal(result.sha, SHA_B);
  },
);

test(
  'a lone carriage return is rejected instead of becoming an exact-byte no-op',
  { concurrency: false },
  async () => {
    const canonical = encodeBase64(
      exactPublishedJson(validUserDocument()),
    );
    const malformed =
      `${canonical.slice(0, 16)}\r${canonical.slice(16)}`;
    const worker = new DirectMutationWorkerMock({
      initialContent: rawContentDocument(malformed, SHA_B),
      mutation: {
        type: 'throw',
        error: new Error('Invalid base64 must not reach publication'),
      },
    });
    const { calls } = await withDeterministicOperationIds(() =>
      withGlobalFetch(
        worker.fetch.bind(worker),
        () => assert.rejects(
          createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
          error => {
            assert.match(
              error?.message ?? '',
              /valid base64 with optional line folding/i,
            );
            return true;
          },
        ),
      ));

    assert.equal(calls, 0);
    assert.equal(worker.contentReads, 1);
    assert.equal(worker.putCount, 0);
    assert.equal(
      countRequests(
        worker.requests,
        'GET',
        '/api/repos/owner/repo',
      ),
      0,
    );
  },
);

test(
  'semantic-only user equality does not bypass a stale baseline',
  { concurrency: false },
  async () => {
    const worker = new DirectContentsWorkerMock({
      remoteText: JSON.stringify(validUserDocument()),
      remoteSha: SHA_B,
    });
    await withDeterministicOperationIds(() =>
      withGlobalFetch(
        worker.fetch.bind(worker),
        () => assert.rejects(
          createSync().pushMyUserFile({
            userDoc: validUserDocument(),
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
          error => {
            assert.equal(error?.code, 'COMMUNITY_ANNOTATION_CONFLICT');
            assert.equal(error?.remoteSha, SHA_B);
            assert.equal(error?.expectedSha, SHA_A);
            return true;
          },
        ),
      ));
    assert.equal(worker.putCount, 0);
  },
);

function createConfigNoOpWorker(remoteText) {
  const requests = [];
  const fetch = async (rawUrl, options = {}) => {
    const request = requestRecord(rawUrl, options);
    requests.push(request);
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo'
    ) {
      return jsonResponse(directRepoInfo({ canManage: true }));
    }
    if (
      request.method === 'GET' &&
      request.path ===
        '/api/repos/owner/repo/contents/annotations/schema.json'
    ) {
      return jsonResponse(contentDocument(
        JSON.stringify(schemaDocument('user')),
        SHA_A,
      ));
    }
    if (
      request.method === 'GET' &&
      request.path ===
        '/api/repos/owner/repo/contents/annotations/config.schema.json'
    ) {
      return jsonResponse(contentDocument(
        JSON.stringify(schemaDocument('config')),
        SHA_B,
      ));
    }
    if (
      request.method === 'GET' &&
      request.path ===
        '/api/repos/owner/repo/contents/annotations/moderation/merges.schema.json'
    ) {
      return jsonResponse(contentDocument(
        JSON.stringify(schemaDocument('merges')),
        SHA_C,
      ));
    }
    if (
      request.method === 'GET' &&
      request.path ===
        '/api/repos/owner/repo/contents/annotations/config.json'
    ) {
      assert.equal(request.query.get('ref'), 'main');
      return jsonResponse(contentDocument(remoteText, SHA_D));
    }
    throw new Error(
      `Unexpected config Worker request: ${request.method} ${request.path}`,
    );
  };
  return { fetch, requests };
}

test(
  'exact config bytes short-circuit a stale baseline before publication',
  { concurrency: false },
  async () => {
    const config = validConfigDocument();
    const worker = createConfigNoOpWorker(exactPublishedJson(config));
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch,
          () => createSync().updateDatasetFieldsToAnnotate({
            datasetId: 'synthetic',
            datasetName: 'Synthetic',
            fieldsToAnnotate: ['cell_type'],
            annotatableSettings: {
              cell_type: { minAnnotators: 1, threshold: 0.5 },
            },
            closedFields: [],
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
        ));

    assert.equal(calls, 0);
    assert.equal(
      worker.requests.some(request => request.method !== 'GET'),
      false,
    );
    assert.equal(result.mode, 'none');
    assert.equal(result.sha, SHA_D);
    assert.equal(result.changed, false);
  },
);

test(
  'semantic-only config equality does not bypass a stale baseline',
  { concurrency: false },
  async () => {
    const config = validConfigDocument();
    const worker = createConfigNoOpWorker(JSON.stringify(config));
    await withDeterministicOperationIds(() =>
      withGlobalFetch(
        worker.fetch,
        () => assert.rejects(
          createSync().updateDatasetFieldsToAnnotate({
            datasetId: 'synthetic',
            datasetName: 'Synthetic',
            fieldsToAnnotate: ['cell_type'],
            annotatableSettings: {
              cell_type: { minAnnotators: 1, threshold: 0.5 },
            },
            closedFields: [],
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
          error => {
            assert.equal(error?.code, 'COMMUNITY_ANNOTATION_CONFLICT');
            assert.equal(error?.remoteSha, SHA_D);
            assert.equal(error?.expectedSha, SHA_A);
            return true;
          },
        ),
      ));
    assert.equal(
      worker.requests.some(request => request.method !== 'GET'),
      false,
    );
  },
);

function createMergesNoOpWorker(remoteText) {
  const requests = [];
  const fetch = async (rawUrl, options = {}) => {
    const request = requestRecord(rawUrl, options);
    requests.push(request);
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo'
    ) {
      return jsonResponse(directRepoInfo({ canManage: true }));
    }
    if (
      request.method === 'GET' &&
      request.path ===
        `/api/repos/owner/repo/contents/${MERGES_PATH}`
    ) {
      assert.equal(request.query.get('ref'), 'main');
      return jsonResponse(contentDocument(remoteText, SHA_B));
    }
    throw new Error(
      `Unexpected merges Worker request: ${request.method} ${request.path}`,
    );
  };
  return { fetch, requests };
}

test(
  'exact merges bytes short-circuit a stale baseline before publication',
  { concurrency: false },
  async () => {
    const merges = validMergesDocument();
    const worker = createMergesNoOpWorker(exactPublishedJson(merges));
    const { calls, value: result } =
      await withDeterministicOperationIds(() =>
        withGlobalFetch(
          worker.fetch,
          () => createSync().pushModerationMerges({
            mergesDoc: merges,
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
        ));

    assert.equal(calls, 0);
    assert.equal(
      worker.requests.some(request => request.method !== 'GET'),
      false,
    );
    assert.equal(result.mode, 'none');
    assert.equal(result.sha, SHA_B);
    assert.equal(result.changed, false);
  },
);

test(
  'semantic-only merges equality does not bypass a stale baseline',
  { concurrency: false },
  async () => {
    const merges = validMergesDocument();
    const worker = createMergesNoOpWorker(JSON.stringify(merges));
    await withDeterministicOperationIds(() =>
      withGlobalFetch(
        worker.fetch,
        () => assert.rejects(
          createSync().pushModerationMerges({
            mergesDoc: merges,
            conflictIfRemoteShaNotEqual: SHA_A,
            publicationMode: 'direct',
          }),
          error => {
            assert.equal(error?.code, 'COMMUNITY_ANNOTATION_CONFLICT');
            assert.equal(error?.remoteSha, SHA_B);
            assert.equal(error?.expectedSha, SHA_A);
            return true;
          },
        ),
      ));
    assert.equal(
      worker.requests.some(request => request.method !== 'GET'),
      false,
    );
  },
);

test(
  'caller-aborted unknown skips stale reconciliation and the next explicit retry converges',
  { concurrency: false },
  async () => {
    const owner = new AbortController();
    const callerReason = new Error('Annotation dialog closed by caller');
    const worker = new DirectContentsWorkerMock({
      loseFirstPut: true,
      abortController: owner,
      abortReason: callerReason,
    });
    const sync = createSync();

    const { calls, value: retryResult } =
      await withDeterministicOperationIds(async () =>
        withGlobalFetch(worker.fetch.bind(worker), async () => {
          await assert.rejects(
            sync.pushMyUserFile({
              userDoc: validUserDocument(),
              publicationMode: 'direct',
              signal: owner.signal,
            }),
            error => {
              assert.equal(
                error?.code,
                'GITHUB_MUTATION_OUTCOME_UNKNOWN',
              );
              assert.equal(error?.operation?.kind, 'contents-put');
              assert.equal(error?.operation?.outcome, 'unknown');
              assert.equal(
                error?.cause?.code,
                'GITHUB_REQUEST_ABORTED',
              );
              assert.equal(error?.cause?.cause, callerReason);
              return true;
            },
          );

          assert.notEqual(worker.putRequestIndex, null);
          assert.equal(
            worker.requests
              .slice(worker.putRequestIndex + 1)
              .filter(request =>
                request.method === 'GET' &&
                request.path ===
                  `/api/repos/owner/repo/contents/${USER_PATH}`
              ).length,
            0,
            'an aborted caller must not start stale reconciliation',
          );

          return sync.pushMyUserFile({
            userDoc: validUserDocument(),
            publicationMode: 'direct',
          });
        }));

    assert.equal(calls, 1);
    assert.equal(worker.putCount, 1);
    assert.equal(retryResult.mode, 'none');
    assert.equal(retryResult.sha, SHA_C);
    assert.equal(retryResult.path, USER_PATH);
  },
);
