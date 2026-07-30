import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationGitHubSync } from '../assets/js/app/community-annotations/github-sync.js';
import { parseExactJson } from '../assets/js/app/community-annotations/wire-contract.js';

const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';
const USER_PATH = 'annotations/users/ghid_42.json';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

function upstreamRepoInfo(
  fullName = 'owner/repo',
  { canPush = false } = {},
) {
  return {
    full_name: fullName,
    default_branch: 'main',
    private: false,
    allow_forking: true,
    permissions: {
      pull: true,
      triage: false,
      push: canPush,
      maintain: false,
      admin: false,
    },
  };
}

function forkIdentity({
  fullName = 'researcher/repo',
  parentFullName = 'owner/repo',
  fork = true,
} = {}) {
  return {
    full_name: fullName,
    fork,
    parent: fork ? { full_name: parentFullName } : null,
  };
}

function forkRecord({
  owner = 'researcher',
  name = 'repo',
  includeParent = true,
} = {}) {
  const record = {
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
  };
  if (includeParent) {
    record.parent = { full_name: 'owner/repo' };
  }
  return record;
}

function fillerForks(page) {
  return Array.from({ length: 100 }, (_unused, index) => {
    const identity = (page - 1) * 100 + index;
    return forkRecord({
      owner: `user-${identity}`,
      name: `repo-${identity}`,
      includeParent: false,
    });
  });
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

function errorResponse(message, status, operationId = null) {
  return jsonResponse(
    { error: message },
    {
      status,
      operationId,
      outcome: operationId === null ? null : 'not-applied',
    },
  );
}

function requestRecord(rawUrl, options = {}) {
  const url = new URL(rawUrl);
  return {
    method: options.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    headers: new Headers(options.headers),
    body: options.body === undefined
      ? null
      : parseExactJson(options.body, {
          path: `${options.method ?? 'GET'} ${url.pathname} body`,
        }),
    signal: options.signal ?? null,
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

async function withImmediateForkLookupDeadline(operation) {
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, delay, ...args) =>
    previousSetTimeout(
      handler,
      delay === 10_000 ? 0 : delay,
      ...args,
    );
  try {
    return await operation();
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
}

class ForkDiscoveryWorkerMock {
  constructor({
    canonical = null,
    createStatus = 202,
    completePublication = false,
    loseCreateResponse = false,
    sourceCanPush = false,
    sourceFullName = 'owner/repo',
    listPage = () => [],
    onListRequest = null,
  } = {}) {
    this.canonical = canonical;
    this.createStatus = createStatus;
    this.completePublication = completePublication;
    this.loseCreateResponse = loseCreateResponse;
    this.sourceCanPush = sourceCanPush;
    this.sourceFullName = sourceFullName;
    this.listPage = listPage;
    this.onListRequest = onListRequest;
    this.requests = [];
  }

  async fetch(rawUrl, options = {}) {
    const request = requestRecord(rawUrl, options);
    this.requests.push(request);
    const [sourceOwner, sourceRepo] = this.sourceFullName.split('/');
    const destinationRepo =
      this.canonical?.full_name?.split('/')[1] ?? sourceRepo;

    if (
      request.method === 'GET' &&
      request.path === `/api/repos/owner/repo/contents/${USER_PATH}`
    ) {
      return errorResponse('Not Found', 404);
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/repos/owner/repo'
    ) {
      return jsonResponse(
        upstreamRepoInfo(this.sourceFullName, {
          canPush: this.sourceCanPush,
        }),
      );
    }
    if (
      request.method === 'GET' &&
      request.path === '/auth/user'
    ) {
      return jsonResponse({ id: 42, login: 'researcher' });
    }
    if (
      request.method === 'GET' &&
      request.path === `/api/repos/researcher/${sourceRepo}`
    ) {
      assert.equal(
        request.query.get('fork_identity'),
        '1',
        'the canonical probe must request the exact fork-identity projection',
      );
      assert.equal(request.query.size, 1);
      return this.canonical === null
        ? errorResponse('Not Found', 404)
        : jsonResponse(this.canonical);
    }
    if (
      request.method === 'POST' &&
      request.path ===
        `/api/repos/${sourceOwner}/${sourceRepo}/forks`
    ) {
      const operationId = request.headers.get(OPERATION_ID_HEADER);
      assert.ok(operationId, 'fork creation must carry an operation id');
      assert.deepEqual(request.body, {});
      if (this.loseCreateResponse) {
        throw new TypeError(
          'Synthetic transport loss after fork creation dispatch',
        );
      }
      if (this.createStatus === 202) {
        return jsonResponse(
          forkRecord(),
          { status: 202, operationId, outcome: 'applied' },
        );
      }
      return errorResponse(
        'Fork already exists',
        this.createStatus,
        operationId,
      );
    }
    if (
      request.method === 'GET' &&
      request.path ===
        `/api/repos/${sourceOwner}/${sourceRepo}/forks`
    ) {
      assert.equal(request.query.get('sort'), 'newest');
      assert.equal(request.query.get('per_page'), '100');
      assert.equal(request.query.size, 3);
      const page = Number(request.query.get('page'));
      assert.ok(Number.isSafeInteger(page) && page > 0);
      if (this.onListRequest !== null) {
        return this.onListRequest(request, page);
      }
      return jsonResponse(this.listPage(page));
    }
    if (
      request.method === 'GET' &&
      request.path ===
        `/api/repos/${sourceOwner}/${sourceRepo}/git/ref/heads/main`
    ) {
      return jsonResponse({ object: { sha: SHA_A } });
    }
    if (this.completePublication) {
      if (
        request.method === 'PUT' &&
        request.path ===
          `/api/repos/${sourceOwner}/${sourceRepo}/contents/${USER_PATH}`
      ) {
        const operationId = request.headers.get(OPERATION_ID_HEADER);
        assert.ok(operationId);
        return jsonResponse(
          { content: { sha: SHA_B } },
          { status: 200, operationId, outcome: 'applied' },
        );
      }
      const destinationPrefix =
        `/api/repos/researcher/${destinationRepo}`;
      if (
        request.method === 'GET' &&
        request.path.startsWith(
          `${destinationPrefix}/git/ref/heads/cellucid-annotations/`,
        )
      ) {
        return errorResponse('Not Found', 404);
      }
      if (
        request.method === 'POST' &&
        request.path === `${destinationPrefix}/git/refs`
      ) {
        const operationId = request.headers.get(OPERATION_ID_HEADER);
        assert.ok(operationId);
        assert.equal(request.body.sha, SHA_A);
        return jsonResponse(
          {},
          { status: 201, operationId, outcome: 'applied' },
        );
      }
      if (
        request.method === 'GET' &&
        request.path === `${destinationPrefix}/contents/${USER_PATH}`
      ) {
        return errorResponse('Not Found', 404);
      }
      if (
        request.method === 'PUT' &&
        request.path === `${destinationPrefix}/contents/${USER_PATH}`
      ) {
        const operationId = request.headers.get(OPERATION_ID_HEADER);
        assert.ok(operationId);
        return jsonResponse(
          { content: { sha: SHA_B } },
          { status: 200, operationId, outcome: 'applied' },
        );
      }
      if (
        request.method === 'GET' &&
        request.path ===
          `/api/repos/${sourceOwner}/${sourceRepo}/pulls`
      ) {
        return jsonResponse([]);
      }
      if (
        request.method === 'POST' &&
        request.path ===
          `/api/repos/${sourceOwner}/${sourceRepo}/pulls`
      ) {
        const operationId = request.headers.get(OPERATION_ID_HEADER);
        assert.ok(operationId);
        return jsonResponse(
          {
            number: 7,
            html_url:
              `https://github.com/${sourceOwner}/${sourceRepo}/pull/7`,
          },
          { status: 201, operationId, outcome: 'applied' },
        );
      }
    }
    if (
      request.method === 'GET' &&
      request.path.startsWith('/api/repos/researcher/')
    ) {
      return errorResponse('Stop after exact fork selection', 418);
    }

    throw new Error(
      `Unexpected synthetic Worker request: ${request.method} ${request.path}`,
    );
  }
}

async function attemptForkPublication(worker, { signal = null } = {}) {
  return attemptPublication(worker, {
    publicationMode: 'fork-pull-request',
    signal,
  });
}

async function attemptPublication(
  worker,
  { publicationMode, signal = null },
) {
  return withGlobalFetch(
    worker.fetch.bind(worker),
    () => createSync().pushMyUserFile({
      userDoc: validUserDocument(),
      publicationMode,
      signal,
    }),
  );
}

function requestsFor(worker, method, path) {
  return worker.requests.filter(
    request => request.method === method && request.path === path,
  );
}

test(
  'a canonical owned fork is ancestry-verified without listing or creating forks',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      canonical: forkIdentity({
        fullName: 'researcher/renamed-repo',
      }),
    });

    await assert.rejects(
      attemptForkPublication(worker),
      error => error?.status === 418,
    );

    assert.equal(
      requestsFor(worker, 'GET', '/api/repos/researcher/repo').length,
      1,
    );
    assert.equal(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks').length,
      0,
    );
    assert.equal(
      requestsFor(worker, 'POST', '/api/repos/owner/repo/forks').length,
      0,
    );
    assert.ok(
      worker.requests.some(
        request =>
          request.path.startsWith(
            '/api/repos/researcher/renamed-repo/',
          ),
      ),
      'a GitHub rename redirect must retain the response repository name',
    );
  },
);

test(
  'an absent canonical fork is created before any fork-network listing',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock();

    await assert.rejects(
      attemptForkPublication(worker),
      error => error?.status === 418,
    );

    const canonicalIndex = worker.requests.findIndex(
      request =>
        request.method === 'GET' &&
        request.path === '/api/repos/researcher/repo',
    );
    const createIndex = worker.requests.findIndex(
      request =>
        request.method === 'POST' &&
        request.path === '/api/repos/owner/repo/forks',
    );
    assert.ok(canonicalIndex >= 0 && canonicalIndex < createIndex);
    assert.equal(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks').length,
      0,
    );
  },
);

test(
  'source rename or transfer uses the resolved repository identity for ancestry',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      canonical: forkIdentity({
        fullName: 'researcher/renamed-fork',
        parentFullName: 'new-owner/new-repo',
      }),
      completePublication: true,
      sourceFullName: 'new-owner/new-repo',
    });

    const result = await attemptForkPublication(worker);
    assert.equal(result.mode, 'fork-pull-request');
    assert.equal(result.prNumber, 7);
    assert.equal(
      result.prUrl,
      'https://github.com/new-owner/new-repo/pull/7',
    );

    assert.equal(
      requestsFor(
        worker,
        'GET',
        '/api/repos/new-owner/new-repo/forks',
      ).length,
      0,
    );
    assert.equal(
      requestsFor(
        worker,
        'POST',
        '/api/repos/new-owner/new-repo/forks',
      ).length,
      0,
    );
    assert.ok(
      worker.requests.some(
        request =>
          request.path.startsWith(
            '/api/repos/researcher/renamed-fork/',
        ),
      ),
    );
    const metadataIndex = worker.requests.findIndex(
      request =>
        request.method === 'GET' &&
        request.path === '/api/repos/owner/repo',
    );
    assert.ok(metadataIndex >= 0);
    assert.equal(
      worker.requests.slice(metadataIndex + 1).some(
        request =>
          request.path.startsWith('/api/repos/owner/repo/'),
      ),
      false,
      'no publication request after resolved metadata may use the stale source path',
    );
    assert.ok(
      worker.requests.some(
        request =>
          request.method === 'POST' &&
          request.path === '/api/repos/new-owner/new-repo/pulls',
      ),
      'the final Pull Request mutation must use the resolved source path',
    );
  },
);

test(
  'a renamed owned fork is recovered newest-first after a creation conflict',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      createStatus: 422,
      listPage(page) {
        if (page === 1) return fillerForks(page);
        if (page === 2) {
          return [
            forkRecord({
              owner: 'researcher',
              name: 'renamed-repo',
              includeParent: false,
            }),
          ];
        }
        throw new Error(`Unexpected fork page ${page}`);
      },
    });

    await assert.rejects(
      attemptForkPublication(worker),
      error => error?.status === 418,
    );

    const createIndex = worker.requests.findIndex(
      request => request.method === 'POST',
    );
    const listIndex = worker.requests.findIndex(
      request =>
        request.method === 'GET' &&
        request.path === '/api/repos/owner/repo/forks',
    );
    assert.ok(createIndex >= 0 && createIndex < listIndex);
    assert.deepEqual(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks')
        .map(request => request.query.get('page')),
      ['1', '2'],
    );
    assert.ok(
      worker.requests.some(
        request =>
          request.method === 'GET' &&
          request.path.startsWith(
            '/api/repos/researcher/renamed-repo/',
          ),
      ),
      'publication must continue through the exact renamed fork',
    );
  },
);

test(
  'direct publication also mutates only the resolved source repository',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      completePublication: true,
      sourceCanPush: true,
      sourceFullName: 'new-owner/new-repo',
    });

    const result = await attemptPublication(worker, {
      publicationMode: 'direct',
    });
    assert.equal(result.mode, 'direct');
    assert.equal(result.sha, SHA_B);
    assert.equal(
      requestsFor(
        worker,
        'PUT',
        `/api/repos/new-owner/new-repo/contents/${USER_PATH}`,
      ).length,
      1,
    );
    assert.equal(
      requestsFor(
        worker,
        'PUT',
        `/api/repos/owner/repo/contents/${USER_PATH}`,
      ).length,
      0,
    );
  },
);

test(
  'a same-name repository with the wrong parent is never treated as the fork',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      canonical: forkIdentity({ parentFullName: 'other/project' }),
      createStatus: 422,
      listPage(page) {
        assert.equal(page, 1);
        return [
          forkRecord({
            owner: 'researcher',
            name: 'renamed-repo',
            includeParent: false,
          }),
        ];
      },
    });

    await assert.rejects(
      attemptForkPublication(worker),
      error => error?.status === 418,
    );

    assert.equal(
      requestsFor(worker, 'POST', '/api/repos/owner/repo/forks').length,
      0,
      'a canonical name collision cannot be repaired by blind creation',
    );
    assert.ok(
      worker.requests.some(
        request =>
          request.path.startsWith(
            '/api/repos/researcher/renamed-repo/',
          ),
      ),
    );
  },
);

test(
  'a canonical name collision without a recoverable fork is actionable',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      canonical: forkIdentity({ fork: false }),
    });

    await assert.rejects(
      attemptForkPublication(worker),
      error => (
        error?.code === 'GITHUB_FORK_NAME_CONFLICT' &&
        /researcher\/repo/.test(error.message) &&
        /not a fork of owner\/repo/.test(error.message)
      ),
    );
    assert.equal(
      requestsFor(worker, 'POST', '/api/repos/owner/repo/forks').length,
      0,
    );
  },
);

test(
  'renamed-fork discovery has an exact 1,000-item bound and typed recovery',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      createStatus: 422,
      listPage(page) {
        return fillerForks(page);
      },
    });

    await assert.rejects(
      attemptForkPublication(worker),
      error => (
        error?.code === 'GITHUB_FORK_LOOKUP_LIMIT' &&
        /newest 1,000 forks/.test(error.message) &&
        /rename/.test(error.message)
      ),
    );

    assert.deepEqual(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks')
        .map(request => request.query.get('page')),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    );
  },
);

test(
  'caller cancellation owns an in-flight renamed-fork lookup',
  { concurrency: false },
  async () => {
    const controller = new AbortController();
    const reason = new Error('Annotation modal closed');
    const worker = new ForkDiscoveryWorkerMock({
      createStatus: 422,
      onListRequest(request, page) {
        assert.equal(page, 1);
        queueMicrotask(() => controller.abort(reason));
        return new Promise((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error('Synthetic transport abort');
            error.name = 'AbortError';
            reject(error);
          };
          request.signal.addEventListener('abort', rejectAbort, {
            once: true,
          });
          if (request.signal.aborted) rejectAbort();
        });
      },
    });

    await assert.rejects(
      attemptForkPublication(worker, { signal: controller.signal }),
      error => (
        error?.code === 'GITHUB_REQUEST_ABORTED' &&
        error.cause === reason
      ),
    );

    const createIndex = worker.requests.findIndex(
      request => request.method === 'POST',
    );
    const listIndex = worker.requests.findIndex(
      request =>
        request.method === 'GET' &&
        request.path === '/api/repos/owner/repo/forks',
    );
    assert.ok(createIndex >= 0 && createIndex < listIndex);
    assert.equal(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks').length,
      1,
    );
  },
);

test(
  'renamed-fork discovery deadline cancels the active page with an actionable error',
  { concurrency: false },
  async () => {
    let pageSignal = null;
    const worker = new ForkDiscoveryWorkerMock({
      createStatus: 422,
      onListRequest(request, page) {
        assert.equal(page, 1);
        pageSignal = request.signal;
        return new Promise((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error('Synthetic deadline abort');
            error.name = 'AbortError';
            reject(error);
          };
          request.signal.addEventListener('abort', rejectAbort, {
            once: true,
          });
          if (request.signal.aborted) rejectAbort();
        });
      },
    });

    await withImmediateForkLookupDeadline(() =>
      assert.rejects(
        attemptForkPublication(worker),
        error => (
          error?.code === 'GITHUB_FORK_LOOKUP_LIMIT' &&
          /10s/.test(error.message)
        ),
      ));

    assert.equal(pageSignal?.aborted, true);
    assert.equal(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks').length,
      1,
    );
  },
);

test(
  'a reconciliation deadline cannot replace an unknown fork-creation outcome',
  { concurrency: false },
  async () => {
    const worker = new ForkDiscoveryWorkerMock({
      loseCreateResponse: true,
      onListRequest(request, page) {
        assert.equal(page, 1);
        return new Promise((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error('Synthetic reconciliation abort');
            error.name = 'AbortError';
            reject(error);
          };
          request.signal.addEventListener('abort', rejectAbort, {
            once: true,
          });
          if (request.signal.aborted) rejectAbort();
        });
      },
    });

    await withImmediateForkLookupDeadline(() =>
      assert.rejects(
        attemptForkPublication(worker),
        error => (
          error?.code === 'GITHUB_MUTATION_OUTCOME_UNKNOWN' &&
          error?.operation?.kind === 'forks-post' &&
          error?.operation?.outcome === 'unknown' &&
          !/rename/i.test(error.message)
        ),
      ));

    assert.equal(
      requestsFor(worker, 'POST', '/api/repos/owner/repo/forks').length,
      1,
    );
    assert.equal(
      requestsFor(worker, 'GET', '/api/repos/owner/repo/forks').length,
      1,
    );
  },
);
