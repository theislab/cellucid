import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';
import {
  CommunityAnnotationGitHubSync,
  parseOwnerRepo,
} from '../assets/js/app/community-annotations/github-sync.js';


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
      return new Response('{"error":"write denied"}', { status: 403 });
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
      }), { status: 200 });
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
      }), { status: 201 });
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
