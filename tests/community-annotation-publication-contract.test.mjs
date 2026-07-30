import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';
import {
  CommunityAnnotationGitHubSync,
  parseOwnerRepo,
} from '../assets/js/app/community-annotations/github-sync.js';
import {
  ANNOTATION_FILE_MAX_UTF8_BYTES,
} from '../assets/js/app/community-annotations/wire-contract.js';

const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';


function mutationResponseHeaders(options, outcome) {
  const operationId = new Headers(options.headers).get(OPERATION_ID_HEADER);
  assert.equal(typeof operationId, 'string');
  return {
    [OPERATION_ID_HEADER]: operationId,
    [OPERATION_OUTCOME_HEADER]: outcome,
  };
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

function userDocumentAtCanonicalByteLength(targetBytes) {
  assert.ok(
    Number.isSafeInteger(targetBytes) &&
      targetBytes >= 1 &&
      targetBytes <= ANNOTATION_FILE_MAX_UTF8_BYTES + 1
  );
  const document = {
    ...validUserDocument(),
    suggestions: {
      'field:category': [{
        id: 'seed',
        label: 'Seed',
        proposedBy: 'ghid_42',
        proposedAt: '2026-07-25T01:02:03.456Z',
        evidence: 'x',
      }],
    },
    votes: {},
  };
  const encoder = new TextEncoder();
  const canonicalByteLength = () =>
    encoder.encode(JSON.stringify(document, null, 2) + '\n').byteLength;
  let nextVote = 0;

  while (true) {
    const remaining = targetBytes - canonicalByteLength();
    if (remaining >= 1 && remaining <= 1_999) {
      document.suggestions['field:category'][0].evidence =
        'x'.repeat(1 + remaining);
      break;
    }
    assert.ok(remaining > 0, 'canonical fixture must not overshoot');
    const rows = Math.max(
      1,
      Math.min(
        50_000 - nextVote,
        Math.floor((remaining - 1_000) / 142)
      )
    );
    assert.ok(rows >= 1, 'canonical fixture must remain tunable');
    for (let offset = 0; offset < rows; offset += 1) {
      const prefix = `vote-${String(nextVote).padStart(8, '0')}-`;
      document.votes[
        prefix + 'x'.repeat(128 - prefix.length)
      ] = 'up';
      nextVote += 1;
    }
  }

  assert.equal(canonicalByteLength(), targetBytes);
  return document;
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


test('repository references accept only canonical owner/repo[@branch] syntax', () => {
  assert.deepEqual(parseOwnerRepo('owner/repo'), {
    owner: 'owner',
    repo: 'repo',
    ownerRepo: 'owner/repo',
    ref: null,
    ownerRepoRef: 'owner/repo',
  });
  assert.deepEqual(parseOwnerRepo('owner/repo@feature/exact'), {
    owner: 'owner',
    repo: 'repo',
    ownerRepo: 'owner/repo',
    ref: 'feature/exact',
    ownerRepoRef: 'owner/repo@feature/exact',
  });
  assert.deepEqual(parseOwnerRepo('owner/.github'), {
    owner: 'owner',
    repo: '.github',
    ownerRepo: 'owner/.github',
    ref: null,
    ownerRepoRef: 'owner/.github',
  });
  for (const alias of [
    ' https://github.com/owner/repo ',
    'https://github.com/owner/repo',
    'git@github.com:owner/repo.git',
    'owner/repo.git',
    'owner/repo#main',
    'owner/repo?tab=readme',
    'owner/repo/tree/main',
    'owner.name/repo',
    'owner/repo@refs/heads/main',
    'owner/repo@feature..branch',
    'owner/repo@feature/.hidden',
    `owner/repo@${'a'.repeat(40)}`,
  ]) {
    assert.equal(
      parseOwnerRepo(alias),
      null,
      `${JSON.stringify(alias)} must not be interpreted as a repository reference`
    );
  }
});


test('publication mode is explicit and validated before network access', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error('unexpected network access');
  };
  try {
    const sync = createSync();
    await assert.rejects(
      () => sync.pushMyUserFile({ userDoc: validUserDocument() }),
      /publicationMode must equal "direct" or "fork-pull-request"/
    );
    await assert.rejects(
      () => sync.pushMyUserFile({
        userDoc: validUserDocument(),
        publicationMode: 'automatic',
      }),
      /publicationMode must equal "direct" or "fork-pull-request"/
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('canonical annotation publication enforces its exact UTF-8 byte boundary before auth or mutation network', async () => {
  const previousFetch = globalThis.fetch;
  const exactBoundaryReachedNetwork = new Error(
    'exact annotation byte boundary reached network'
  );
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw exactBoundaryReachedNetwork;
  };

  try {
    const sync = createSync();
    const exact = userDocumentAtCanonicalByteLength(
      ANNOTATION_FILE_MAX_UTF8_BYTES
    );
    await assert.rejects(
      () => sync.pushMyUserFile({
        userDoc: exact,
        publicationMode: 'direct',
      }),
      error => error === exactBoundaryReachedNetwork
    );
    assert.equal(fetchCount, 1);

    fetchCount = 0;
    const oversized = userDocumentAtCanonicalByteLength(
      ANNOTATION_FILE_MAX_UTF8_BYTES + 1
    );
    await assert.rejects(
      () => sync.pushMyUserFile({
        userDoc: oversized,
        publicationMode: 'direct',
      }),
      error => {
        assert.equal(
          error?.code,
          'COMMUNITY_ANNOTATION_FILE_TOO_LARGE'
        );
        assert.equal(error?.maxBytes, ANNOTATION_FILE_MAX_UTF8_BYTES);
        assert.equal(
          error?.actualBytes,
          ANNOTATION_FILE_MAX_UTF8_BYTES + 1
        );
        assert.equal(
          error?.path,
          'annotations/users/ghid_42.json'
        );
        assert.equal(error?.phase, 'publication-preflight');
        return true;
      }
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the browser validator rejects malformed streamed tree JSON before annotation state changes', async () => {
  const previousFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let fetchCount = 0;
  globalThis.fetch = async rawUrl => {
    fetchCount += 1;
    assert.match(
      String(rawUrl),
      /\/api\/repos\/owner\/repo\/git\/trees\/main\?recursive=1$/
    );
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"tree":[],"\\u0074'));
        controller.enqueue(
          encoder.encode('ree":[],"truncated":false}')
        );
        controller.close();
      },
    }), { status: 200 });
  };

  try {
    const sync = createSync();
    await assert.rejects(
      () => sync.pullAllUsers(),
      /duplicate JSON object key "tree"/
    );
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the browser validator rejects malformed streamed blob base64 before annotation state changes', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const content of ['\n', 'e30= ', 'e31=']) {
      const responses = [
        {
          tree: [{
            type: 'blob',
            path: 'annotations/users/ghid_42.json',
            sha: 'a'.repeat(40),
            size: 2,
          }],
          truncated: false,
        },
        {
          encoding: 'base64',
          content,
        },
      ];
      globalThis.fetch = async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
        });
      const sync = createSync();
      await assert.rejects(
        () => sync.pullAllUsers(),
        /base64|padding bits/
      );
      assert.equal(responses.length, 0);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('oversized remote Contents and blob payloads retain typed path-aware pull errors', async () => {
  const previousFetch = globalThis.fetch;
  const oversizedContent = Buffer.alloc(
    ANNOTATION_FILE_MAX_UTF8_BYTES + 1
  ).toString('base64');
  const assertOversizedPullError = error => {
    assert.equal(
      error?.code,
      'COMMUNITY_ANNOTATION_FILE_TOO_LARGE'
    );
    assert.equal(
      error?.path,
      'annotations/users/ghid_42.json'
    );
    assert.equal(error?.phase, 'remote-read');
    assert.equal(error?.maxBytes, ANNOTATION_FILE_MAX_UTF8_BYTES);
    assert.equal(
      error?.actualBytes,
      ANNOTATION_FILE_MAX_UTF8_BYTES + 1
    );
    assert.doesNotMatch(String(error), /ReferenceError/);
    return true;
  };

  try {
    const contentsResponses = [{
      type: 'file',
      encoding: 'base64',
      content: oversizedContent,
      sha: 'a'.repeat(40),
    }];
    globalThis.fetch = async () =>
      new Response(JSON.stringify(contentsResponses.shift()), {
        status: 200,
      });
    await assert.rejects(
      () => createSync().pullUserFile({ userKey: 'ghid_42' }),
      assertOversizedPullError
    );
    assert.equal(contentsResponses.length, 0);

    const blobResponses = [
      {
        tree: [{
          type: 'blob',
          path: 'annotations/users/ghid_42.json',
          sha: 'b'.repeat(40),
          size: ANNOTATION_FILE_MAX_UTF8_BYTES,
        }],
        truncated: false,
      },
      {
        encoding: 'base64',
        content: oversizedContent,
      },
    ];
    globalThis.fetch = async () =>
      new Response(JSON.stringify(blobResponses.shift()), {
        status: 200,
      });
    await assert.rejects(
      () => createSync().pullAllUsers(),
      assertOversizedPullError
    );
    assert.equal(blobResponses.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test('direct publication never recovers through a branch, Pull Request, or fork', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    if (method === 'GET' && url.pathname === '/auth/user') {
      return new Response('{"id":42,"login":"researcher"}', {
        status: 200,
      });
    }
    if (
      method === 'GET' &&
      url.pathname.endsWith('/contents/annotations/users/ghid_42.json')
    ) {
      return new Response('{"error":"Not Found"}', { status: 404 });
    }
    if (method === 'GET' && url.pathname === '/api/repos/owner/repo') {
      return new Response(JSON.stringify({
        full_name: 'owner/repo',
        default_branch: 'main',
        private: false,
        allow_forking: true,
        permissions: {
          pull: true,
          triage: false,
          push: true,
          maintain: false,
          admin: false,
        },
      }), { status: 200 });
    }
    if (
      method === 'PUT' &&
      url.pathname.endsWith('/contents/annotations/users/ghid_42.json')
    ) {
      return new Response('{"error":"write denied"}', {
        status: 403,
        headers: mutationResponseHeaders(options, 'not-applied'),
      });
    }
    return new Response('{"error":"unexpected publication route"}', {
      status: 500,
    });
  };
  try {
    const sync = createSync();
    await assert.rejects(
      () => sync.pushMyUserFile({
        userDoc: validUserDocument(),
        publicationMode: 'direct',
      }),
      /write denied/
    );
    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      [
        'GET /auth/user',
        'GET /api/repos/owner/repo/contents/annotations/users/ghid_42.json',
        'GET /api/repos/owner/repo',
        'PUT /api/repos/owner/repo/contents/annotations/users/ghid_42.json',
      ]
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test('fork Pull Request publication follows only its preselected route', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const upstreamSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const branchSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const contentSha = 'cccccccccccccccccccccccccccccccccccccccc';
  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    requests.push({
      method,
      path: url.pathname,
      query: url.search,
      body: options.body ?? null,
    });

    if (method === 'GET' && url.pathname === '/auth/user') {
      return new Response('{"id":42,"login":"researcher"}', {
        status: 200,
      });
    }
    if (
      method === 'GET' &&
      url.pathname ===
        '/api/repos/owner/repo/contents/annotations/users/ghid_42.json'
    ) {
      return new Response('{"error":"Not Found"}', { status: 404 });
    }
    if (method === 'GET' && url.pathname === '/api/repos/owner/repo') {
      return new Response(JSON.stringify({
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
      }), { status: 200 });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/repos/researcher/repo' &&
      url.search === '?fork_identity=1'
    ) {
      return new Response(JSON.stringify({
        full_name: 'researcher/repo',
        fork: true,
        parent: { full_name: 'owner/repo' },
      }), { status: 200 });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/repos/owner/repo/forks'
    ) {
      return new Response(JSON.stringify([{
        full_name: 'researcher/repo',
        owner: { login: 'researcher' },
        name: 'repo',
        parent: { full_name: 'owner/repo' },
      }]), { status: 200 });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/repos/owner/repo/git/ref/heads/main'
    ) {
      return new Response(JSON.stringify({
        object: { sha: upstreamSha },
      }), { status: 200 });
    }
    if (
      method === 'GET' &&
      url.pathname.startsWith(
        '/api/repos/researcher/repo/git/ref/heads/cellucid-annotations/'
      )
    ) {
      return new Response(JSON.stringify({
        object: { sha: branchSha },
      }), { status: 200 });
    }
    if (
      method === 'GET' &&
      url.pathname ===
        '/api/repos/researcher/repo/contents/annotations/users/ghid_42.json'
    ) {
      return new Response('{"error":"Not Found"}', { status: 404 });
    }
    if (
      method === 'PUT' &&
      url.pathname ===
        '/api/repos/researcher/repo/contents/annotations/users/ghid_42.json'
    ) {
      return new Response(JSON.stringify({
        content: { sha: contentSha },
      }), {
        status: 200,
        headers: mutationResponseHeaders(options, 'applied'),
      });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/repos/owner/repo/pulls'
    ) {
      return new Response('[]', { status: 200 });
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/repos/owner/repo/pulls'
    ) {
      return new Response(JSON.stringify({
        number: 7,
        html_url: 'https://github.com/owner/repo/pull/7',
      }), {
        status: 201,
        headers: mutationResponseHeaders(options, 'applied'),
      });
    }
    return new Response('{"error":"unexpected publication request"}', {
      status: 500,
    });
  };
  try {
    const sync = createSync();
    const result = await sync.pushMyUserFile({
      userDoc: validUserDocument(),
      publicationMode: 'fork-pull-request',
    });
    assert.deepEqual(result, {
      mode: 'fork-pull-request',
      prUrl: 'https://github.com/owner/repo/pull/7',
      prNumber: 7,
      reused: false,
      path: 'annotations/users/ghid_42.json',
      remoteUpdatedAt: null,
    });
    assert.equal(
      requests.some(({ method, path }) =>
        method === 'PUT' && path.startsWith('/api/repos/owner/repo/')
      ),
      false
    );
    assert.equal(
      requests.filter(({ method, path }) =>
        method === 'POST' && path === '/api/repos/owner/repo/pulls'
      ).length,
      1
    );
    assert.equal(
      requests.filter(({ method, path, query }) =>
        method === 'GET' &&
        path === '/api/repos/researcher/repo' &&
        query === '?fork_identity=1'
      ).length,
      1
    );
    assert.equal(
      requests.some(({ path }) => path === '/api/repos/owner/repo/forks'),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test('session mutations reject aliases and invalid vote directions', () => {
  const session = new CommunityAnnotationSession();
  assert.throws(
    () => session.setProfile({
      username: '@ghid_42',
      githubUserId: 42,
      login: 'researcher',
    }),
    /username/
  );
  assert.throws(
    () => session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
      legacyLogin: 'researcher',
    }),
    /unknown field/
  );
  assert.throws(
    () => session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
      orcid: 'https://orcid.org/0000-0002-1825-0097',
    }),
    /ORCID/i
  );
  assert.throws(
    () => session.setFieldAnnotated(' cell_type ', true),
    /leading or trailing whitespace/
  );

  session.setProfile({
    username: 'ghid_42',
    githubUserId: 42,
    login: 'researcher',
  });
  session.setFieldCategories('cell_type', ['Alpha']);
  const suggestionId = session.addSuggestion(
    'cell_type',
    0,
    { label: 'T cell' }
  );
  const before = session.getStateSnapshot();
  assert.throws(
    () => session.vote('cell_type', 0, suggestionId, 'sideways'),
    /direction must equal "up" or "down"/
  );
  assert.deepEqual(session.getStateSnapshot(), before);
});


test('session mutation boundaries reject coercive values atomically', () => {
  const session = new CommunityAnnotationSession();
  session.setProfile({
    username: 'ghid_42',
    githubUserId: 42,
    login: 'researcher',
  });
  session.setFieldAnnotated('cell_type', true);
  session.setFieldCategories('cell_type', ['Alpha']);
  const suggestionId = session.addSuggestion(
    'cell_type',
    0,
    { label: 'T cell' }
  );
  const before = session.getStateSnapshot();

  const rejectedMutations = [
    () => session.setCacheContext({ datasetId: ' synthetic ' }),
    () => session.recordDatasetAccess({
      datasetId: ' synthetic ',
      fieldsToAnnotate: ['cell_type'],
    }),
    () => session.setFieldClosed('cell_type', 1),
    () => session.setClosedAnnotatableFields([' cell_type ']),
    () => session.setAnnotatableConsensusSettings(
      ' cell_type ',
      { minAnnotators: 1, threshold: 0.5 }
    ),
    () => session.setAnnotatableConsensusSettingsMap({
      ' cell_type ': { minAnnotators: 1, threshold: 0.5 },
    }),
    () => session.setFieldCategories(' cell_type ', ['Alpha']),
    () => session.addSuggestion(
      ' cell_type ',
      0,
      { label: 'B cell' }
    ),
    () => session.vote('cell_type', 0, ` ${suggestionId}`, 'up'),
    () => session.computeConsensus(
      'cell_type',
      0,
      { minAnnotators: '1', threshold: '0.5' }
    ),
  ];
  for (const mutate of rejectedMutations) {
    assert.throws(mutate);
    assert.deepEqual(session.getStateSnapshot(), before);
  }
});
