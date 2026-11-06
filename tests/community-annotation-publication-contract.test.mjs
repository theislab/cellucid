import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';
import {
  CommunityAnnotationGitHubSync,
  foldCachedFiles,
  parseOwnerRepo,
  toAnnotationHeadBranch,
} from '../assets/js/app/community-annotations/github-sync.js';
import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';
import {
  ANNOTATION_FILE_MAX_UTF8_BYTES,
  composeUserFile,
} from '../assets/js/app/community-annotations/wire-contract.js';
import { createFakeIndexedDB, FakeKeyRange } from './helpers/fake-indexeddb.mjs';
import {
  configFor,
  createVirtualTime,
  MockAnnotationGitHub,
  virtualTransport,
  WORKER_ORIGIN,
} from './helpers/community-annotation-worker.mjs';

const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';
const USER_PATH = 'annotations/users/ghid_42.json';
const DIRECT = { pull: true, triage: false, push: true, maintain: false, admin: false };
const FORK_ONLY = { pull: true, triage: false, push: false, maintain: false, admin: false };

function json(document, status = 200, headers = {}) {
  return new Response(JSON.stringify(document), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mutationResponseHeaders(request, outcome) {
  const operationId = request.headers.get(OPERATION_ID_HEADER);
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
        id: 'ghid_42_seed',
        label: 'Seed',
        proposedBy: 'ghid_42',
        proposedAt: '2026-07-25T01:02:03.456Z',
        evidence: 'x',
      }],
    },
    votes: {},
  };
  const encoder = new TextEncoder();
  // The bound is on the published file, which wraps the view's section.
  const canonicalByteLength = () => encoder.encode(
    JSON.stringify(composeUserFile(null, 'synthetic', document), null, 2) + '\n'
  ).byteLength;
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
        Math.floor((remaining - 1_000) / 146)
      )
    );
    assert.ok(rows >= 1, 'canonical fixture must remain tunable');
    for (let offset = 0; offset < rows; offset += 1) {
      const prefix = `ghid_42_vote-${String(nextVote).padStart(8, '0')}-`;
      document.votes[
        prefix + 'x'.repeat(128 - prefix.length)
      ] = 'up';
      nextVote += 1;
    }
  }

  assert.equal(canonicalByteLength(), targetBytes);
  return document;
}

/** A sync on virtual time over `fetchImpl` (the shared mock's fetch by default). */
function harness({ fetch: fetchImpl, time = createVirtualTime(), datasetId = 'synthetic' }) {
  const { transport } = virtualTransport(fetchImpl, time);
  const sync = new CommunityAnnotationGitHubSync({
    datasetId,
    owner: 'owner',
    repo: 'repo',
    token: 'test-token',
    branch: 'main',
    workerOrigin: WORKER_ORIGIN,
    transport,
  });
  return { time, transport, sync, run: (promise) => time.run(promise) };
}

function repository({ permissions = DIRECT, files = {} } = {}) {
  return new MockAnnotationGitHub({
    permissions,
    files: {
      'annotations/config.json': configFor('synthetic', ['cell_type']),
      'annotations/users/.gitkeep': '\n',
      ...files,
    },
  });
}

function requestLines(log) {
  return log.map((line) => line.replace(/\?.*$/, ''));
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
  let fetchCount = 0;
  const { sync } = harness({
    fetch: async () => {
      fetchCount += 1;
      throw new Error('unexpected network access');
    },
  });
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
});

test('canonical annotation publication enforces its exact UTF-8 byte boundary before auth or mutation network', async () => {
  const requested = [];
  const fetchImpl = async (rawUrl) => {
    requested.push(new URL(String(rawUrl)).pathname);
    return json({ error: 'exact annotation byte boundary reached network' }, 418);
  };

  const exact = userDocumentAtCanonicalByteLength(
    ANNOTATION_FILE_MAX_UTF8_BYTES
  );
  const exactHarness = harness({ fetch: fetchImpl });
  await assert.rejects(
    exactHarness.run(exactHarness.sync.pushMyUserFile({
      userDoc: exact,
      publicationMode: 'direct',
    })),
    /exact annotation byte boundary reached network/
  );
  assert.deepEqual(requested, ['/auth/user'], 'the exact boundary reaches the network, starting with auth');

  requested.length = 0;
  const oversized = userDocumentAtCanonicalByteLength(
    ANNOTATION_FILE_MAX_UTF8_BYTES + 1
  );
  const oversizedHarness = harness({ fetch: fetchImpl });
  await assert.rejects(
    oversizedHarness.run(oversizedHarness.sync.pushMyUserFile({
      userDoc: oversized,
      publicationMode: 'direct',
    })),
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
      assert.equal(error?.path, USER_PATH);
      assert.equal(error?.phase, 'publication-preflight');
      return true;
    }
  );
  assert.equal(requested.length, 0);
});

function pullHarness(github) {
  const h = harness({ fetch: github.fetch });
  const fileCache = new CommunityAnnotationFileCache({ indexedDB: createFakeIndexedDB(), keyRange: FakeKeyRange });
  const cacheScope = { datasetId: 'synthetic', repoRef: 'owner/repo@main', userId: 42 };
  const pull = async () => {
    const { snapshot } = await h.sync.validateAndLoadConfig({ datasetId: 'synthetic' });
    return h.sync.pullFiles({ snapshot, fileCache, cacheScope, ownUserKey: 'ghid_42' });
  };
  return { ...h, fileCache, cacheScope, pull: () => h.run(pull()) };
}

function streamedJsonResponse(pieces) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('an incomplete streamed users tree fails the Pull before any annotation file is kept', async () => {
  const github = repository({ files: { [USER_PATH]: '{}\n' } });
  github.intercept = async (request) => {
    if (!request.path.includes('/git/trees/')) return undefined;
    return streamedJsonResponse(['{"sha":"', request.path.split('/').pop(), '","tree":[{"path":']);
  };
  const h = pullHarness(github);
  await assert.rejects(h.pull(), (error) => {
    assert.equal(error.code, 'COMMUNITY_ANNOTATION_RESPONSE_CUT');
    assert.equal(error.transient, true);
    return true;
  });
  assert.equal((await h.fileCache.getKnownShas(h.cacheScope)).size, 0);
  assert.equal(await h.fileCache.getPullMarker(h.cacheScope), null);
});

test('malformed base64 from the REST blob fallback fails the Pull before the file is kept', async () => {
  for (const content of ['\n', 'e30= ', 'e31=']) {
    const text = '{}';
    const github = repository({ files: { [USER_PATH]: text } });
    github.intercept = async (request) => {
      if (request.path === '/graphql/blobs') {
        const answer = await github._blobs(request.body);
        const document = await answer.json();
        for (const blob of Object.values(document.data.repository)) {
          if (blob !== null && blob.text === text) {
            blob.isTruncated = true;
            blob.text = '';
          }
        }
        return json(document);
      }
      if (request.path.includes('/git/blobs/')) {
        return json({ sha: request.path.split('/').pop(), size: 2, encoding: 'base64', content });
      }
      return undefined;
    };
    const h = pullHarness(github);
    await assert.rejects(h.pull(), /base64|padding bits/);
    assert.equal((await h.fileCache.getKnownShas(h.cacheScope)).has(USER_PATH), false);
  }
});

test('an oversized own file read through Contents keeps its typed, path-aware error', async () => {
  const oversizedContent = Buffer.alloc(ANNOTATION_FILE_MAX_UTF8_BYTES + 1).toString('base64');
  const github = repository();
  github.intercept = async (request) => {
    if (request.method === 'GET' && request.path.endsWith(`/contents/${USER_PATH}`)) {
      return json({ type: 'file', encoding: 'base64', content: oversizedContent, sha: 'a'.repeat(40) });
    }
    return undefined;
  };
  const h = harness({ fetch: github.fetch });
  await assert.rejects(h.run(h.sync.pullUserFile({ userKey: 'ghid_42' })), (error) => {
    assert.equal(error?.code, 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE');
    assert.equal(error?.path, USER_PATH);
    assert.equal(error?.phase, 'remote-read');
    assert.equal(error?.maxBytes, ANNOTATION_FILE_MAX_UTF8_BYTES);
    assert.equal(error?.actualBytes, ANNOTATION_FILE_MAX_UTF8_BYTES + 1);
    assert.doesNotMatch(String(error), /ReferenceError/);
    return true;
  });
});

test('an oversized user file in the tree is excluded by its blob id, typed and path-aware, without being read', async () => {
  const oversized = `{"pad":"${'x'.repeat(ANNOTATION_FILE_MAX_UTF8_BYTES)}"}`;
  const github = repository({ files: { [USER_PATH]: oversized } });
  const asked = [];
  github.intercept = async (request) => {
    if (request.path === '/graphql/blobs') asked.push(...request.body.oids);
    return undefined;
  };
  const h = pullHarness(github);
  const result = await h.pull();
  assert.equal(result.userCount, 1);
  const record = await h.fileCache.getRecord(h.cacheScope, USER_PATH);
  assert.equal(record.view, null);
  assert.equal(record.rejection.code, 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE');
  assert.match(record.rejection.message, /annotations\/users\/ghid_42\.json/);
  assert.ok(!asked.includes(record.sha), 'the oversized blob is never downloaded');
  const { excluded } = await foldCachedFiles({
    fileCache: h.fileCache,
    cacheScope: h.cacheScope,
    remoteUserFiles: { add() { throw new Error('nothing to fold'); } },
  });
  assert.deepEqual(excluded.map((entry) => entry.path), [USER_PATH]);
});


test('direct publication never recovers through a branch, Pull Request, or fork', async () => {
  const github = repository({ permissions: DIRECT });
  github.intercept = async (request) => {
    if (request.method === 'PUT') {
      return json({ error: 'write denied' }, 403, mutationResponseHeaders(request, 'not-applied'));
    }
    return undefined;
  };
  const h = harness({ fetch: github.fetch });
  await assert.rejects(
    h.run(h.sync.pushMyUserFile({
      userDoc: validUserDocument(),
      publicationMode: 'direct',
    })),
    (error) => {
      assert.match(error.message, /write denied/);
      assert.equal(error.status, 403);
      assert.equal(error.operation.outcome, 'not-applied');
      return true;
    }
  );
  assert.deepEqual(requestLines(github.log), [
    'GET /auth/user',
    'GET /api/repos/owner/repo',
    'POST /graphql/snapshot',
    `GET /api/repos/owner/repo/contents/${USER_PATH}`,
    `PUT /api/repos/owner/repo/contents/${USER_PATH}`,
  ]);
});


test('fork Pull Request publication follows only its preselected route', async () => {
  const github = repository({ permissions: FORK_ONLY });
  // The contributor's fork already exists under the canonical name.
  github.repos.set('researcher/repo', {
    fullName: 'researcher/repo',
    fork: true,
    parent: 'owner/repo',
    branches: new Map(github.repos.get('owner/repo').branches),
  });
  const h = harness({ fetch: github.fetch });
  const result = await h.run(h.sync.pushMyUserFile({
    userDoc: validUserDocument(),
    publicationMode: 'fork-pull-request',
  }));
  const { view, ...written } = result;
  assert.deepEqual(written, {
    mode: 'fork-pull-request',
    prUrl: 'https://github.com/owner/repo/pull/1',
    prNumber: 1,
    reused: false,
    changed: true,
    branch: 'main',
    path: USER_PATH,
    remoteUpdatedAt: null,
  });
  assert.equal(view.username, 'ghid_42');
  const lines = github.log;
  assert.equal(lines.some((line) => line.startsWith('PUT /api/repos/owner/repo/')), false, 'never writes upstream');
  assert.equal(lines.filter((line) => line === 'POST /api/repos/owner/repo/pulls').length, 1);
  assert.equal(lines.filter((line) => line === 'GET /api/repos/researcher/repo?fork_identity=1').length, 1);
  assert.equal(lines.some((line) => line.startsWith('GET /api/repos/owner/repo/forks')), false);
  assert.equal(lines.some((line) => line.startsWith('POST /api/repos/owner/repo/forks')), false);
  const head = toAnnotationHeadBranch({ baseBranch: 'main', fileUser: 'ghid_42' });
  assert.ok(lines.includes('POST /api/repos/researcher/repo/git/refs'), 'the head branch is created at the upstream tip');
  assert.ok(github.filesAt('researcher/repo', head).has(USER_PATH));
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
