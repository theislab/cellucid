import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';
import {
  CommunityAnnotationGitHubSync,
  parseOwnerRepo,
} from '../assets/js/app/community-annotations/github-sync.js';
import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';
import {
  GitHubAuthSession,
  getGitHubWorkerOrigin,
  getLastGitHubUserKey,
  toGitHubUserKey,
} from '../assets/js/app/community-annotations/github-auth.js';
import {
  ANNOTATION_CONTRACT_IDS,
  assertConfigDocument,
  assertMergesDocument,
  assertSchemaIdentity,
  assertUserDocument,
  parseExactJson,
} from '../assets/js/app/community-annotations/wire-contract.js';
import {
  toCacheScopeKey,
  toFileShaIndexKey,
  toSessionStorageKey,
} from '../assets/js/app/community-annotations/cache-scope.js';
import {
  getAnnotationRepoForDataset,
  getAnnotationRepoMetaForDataset,
  setAnnotationRepoForDataset,
} from '../assets/js/app/community-annotations/repo-store.js';
import { isAnnotationRepoConnected } from '../assets/js/app/community-annotations/access-store.js';
import { CommunityAnnotationScopeLock } from '../assets/js/app/community-annotations/scope-lock.js';
import {
  getCommunityFeedback,
  lookupByName,
  lookupByOntologyId,
  searchCellTypes,
} from '../assets/js/app/community-annotations/cap-api.js';


function createSession() {
  const session = new CommunityAnnotationSession();
  session.setProfile({
    username: 'ghid_42',
    githubUserId: 42,
    login: 'researcher',
  });
  session.setFieldCategories('cell_type', ['Alpha', 'Beta']);
  return session;
}


function validRemoteUser(overrides = {}) {
  return {
    version: 1,
    username: 'ghid_7',
    githubUserId: 7,
    updatedAt: '2026-07-25T01:02:03.456Z',
    suggestions: {
      'cell_type:Alpha': [
        {
          id: 'suggestion-remote',
          label: 'T cell',
          ontologyId: null,
          evidence: null,
          markers: ['CD3D'],
          proposedBy: 'ghid_7',
          proposedAt: '2026-07-25T01:02:03.456Z',
          editedAt: null,
        },
      ],
    },
    votes: {},
    comments: {},
    deletedSuggestions: {},
    ...overrides,
  };
}


function validConfig(overrides = {}) {
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
    ...overrides,
  };
}


function validMerges(overrides = {}) {
  return {
    version: 1,
    updatedAt: '2026-07-25T01:02:03.456Z',
    merges: [
      {
        bucket: 'cell_type:Alpha',
        fromSuggestionId: 'from',
        intoSuggestionId: 'into',
        by: 'ghid_42',
        at: '2026-07-25T01:02:03.456Z',
      },
    ],
    ...overrides,
  };
}


test('local suggestion producer rejects overlong values instead of clipping them', () => {
  const session = createSession();
  assert.throws(
    () => session.addSuggestion('cell_type', 0, { label: 'x'.repeat(121) }),
    /label.*120|120.*label/i
  );
  assert.deepEqual(session.getSuggestions('cell_type', 0), []);
});


test('local marker producer rejects blank and overlong marker strings', () => {
  const session = createSession();
  assert.throws(
    () =>
      session.addSuggestion('cell_type', 0, {
        label: 'T cell',
        markers: ['   ', 'G'.repeat(65)],
      }),
    /marker.*nonblank|marker.*64|64.*marker/i
  );
  assert.deepEqual(session.getSuggestions('cell_type', 0), []);
  assert.throws(
    () =>
      session.addSuggestion('cell_type', 0, {
        label: 'T cell',
        markers: [' CD3D'],
      }),
    /leading or trailing whitespace/i
  );
  assert.throws(
    () => session.addSuggestion('cell_type', 0, { label: 7 }),
    /label must be a string/i
  );
});


test('remote user documents reject unknown fields atomically', () => {
  const session = createSession();
  const invalid = validRemoteUser({ unknownField: true });
  const before = session.getStateSnapshot();
  assert.throws(
    () => session.mergeFromUserFiles([invalid]),
    /unknown field.*unknownField|unknownField.*unknown field/i
  );
  assert.deepEqual(session.getStateSnapshot(), before);
});

test('remote user documents require one exact checksum-valid ORCID representation', () => {
  const session = createSession();
  const before = session.getStateSnapshot();
  for (const orcid of [
    'https://orcid.org/0000-0002-1825-0097',
    '0000000218250097',
    '0000-0002-1825-0098',
  ]) {
    assert.throws(
      () => session.mergeFromUserFiles([validRemoteUser({ orcid })]),
      /ORCID/i
    );
    assert.deepEqual(session.getStateSnapshot(), before);
  }
});

test('repository merge rejects cross-user suggestion id collisions atomically', () => {
  const session = createSession();
  const first = validRemoteUser();
  const second = validRemoteUser({
    username: 'ghid_8',
    githubUserId: 8,
  });
  second.suggestions['cell_type:Alpha'][0].proposedBy = 'ghid_8';
  const before = session.getStateSnapshot();
  assert.throws(
    () => session.mergeFromUserFiles([first, second]),
    /conflicts with the suggestion owned by "ghid_7"/
  );
  assert.deepEqual(session.getStateSnapshot(), before);
});

test('repository merge preserves equal comment ids from different users', () => {
  const session = createSession();
  const first = validRemoteUser({
    comments: {
      'suggestion-remote': [
        {
          id: 'same-comment-id',
          text: 'First author',
          authorUsername: 'ghid_7',
          createdAt: '2026-07-25T01:02:03.456Z',
        },
      ],
    },
  });
  const second = validRemoteUser({
    username: 'ghid_8',
    githubUserId: 8,
    suggestions: {},
    comments: {
      'suggestion-remote': [
        {
          id: 'same-comment-id',
          text: 'Second author',
          authorUsername: 'ghid_8',
          createdAt: '2026-07-25T01:02:04.456Z',
        },
      ],
    },
  });
  session.mergeFromUserFiles([first, second]);
  const [suggestion] = session.getSuggestions('cell_type', 'Alpha');
  assert.deepEqual(
    suggestion.comments.map((comment) => comment.authorUsername).sort(),
    ['ghid_7', 'ghid_8']
  );
});


test('numeric category labels remain exact and are never migrated by index', () => {
  const session = createSession();
  const numericLabelDoc = validRemoteUser({
    suggestions: {
      'cell_type:0': [
        {
          id: 'suggestion-numeric-label',
          label: 'Numeric category',
          ontologyId: null,
          evidence: null,
          markers: null,
          proposedBy: 'ghid_7',
          proposedAt: '2026-07-25T01:02:03.456Z',
          editedAt: null,
        },
      ],
    },
  });
  session.mergeFromUserFiles([numericLabelDoc]);
  assert.equal(session.getSuggestions('cell_type', '0').length, 1);
  assert.equal(session.getSuggestions('cell_type', 'Alpha').length, 0);
});


test('moderation document rejects invalid entries instead of filtering them', () => {
  const session = createSession();
  const before = session.getStateSnapshot();
  assert.throws(
    () =>
      session.setModerationMergesFromDoc({
        version: 1,
        updatedAt: '2026-07-25T01:02:03.456Z',
        merges: [
          {
            bucket: 'cell_type:Alpha',
            fromSuggestionId: 'same',
            intoSuggestionId: 'same',
            by: 'ghid_42',
            at: '2026-07-25T01:02:03.456Z',
          },
        ],
      }),
    /fromSuggestionId.*differ|intoSuggestionId.*differ/i
  );
  assert.deepEqual(session.getStateSnapshot(), before);
});


test('user contract enforces file ownership and globally unique suggestion ids', () => {
  const wrongOwner = validRemoteUser();
  wrongOwner.suggestions['cell_type:Alpha'][0].proposedBy = 'ghid_8';
  assert.throws(
    () => assertUserDocument(wrongOwner, { filename: 'ghid_7.json' }),
    /must equal file identity/
  );

  const duplicate = validRemoteUser();
  duplicate.suggestions['cell_type:Beta'] = [
    { ...duplicate.suggestions['cell_type:Alpha'][0] },
  ];
  assert.throws(
    () => assertUserDocument(duplicate, { filename: 'ghid_7.json' }),
    /globally unique/
  );
});


test('config contract requires a nonempty field list and exact settings coverage', () => {
  const empty = validConfig();
  empty.supportedDatasets[0].fieldsToAnnotate = [];
  empty.supportedDatasets[0].annotatableSettings = {};
  assert.throws(() => assertConfigDocument(empty), /at least 1 item/);

  const missing = validConfig();
  missing.supportedDatasets[0].fieldsToAnnotate.push('batch');
  assert.throws(() => assertConfigDocument(missing), /missing settings.*batch/);

  const extra = validConfig();
  extra.supportedDatasets[0].annotatableSettings.batch = {
    minAnnotators: 1,
    threshold: 0.5,
  };
  assert.throws(() => assertConfigDocument(extra), /unknown field.*batch/);
});

test('wire strings reject edge whitespace instead of normalizing it', () => {
  const document = validRemoteUser();
  document.suggestions['cell_type:Alpha'][0].label = ' T cell';
  assert.throws(
    () => assertUserDocument(document, { filename: 'ghid_7.json' }),
    /leading or trailing whitespace/
  );
});

test('wire length limits count Unicode code points identically to JSON Schema', () => {
  const boundary = validRemoteUser();
  boundary.suggestions['cell_type:Alpha'][0].label = '😀'.repeat(120);
  assert.doesNotThrow(() =>
    assertUserDocument(boundary, { filename: 'ghid_7.json' })
  );

  const over = validRemoteUser();
  over.suggestions['cell_type:Alpha'][0].label = '😀'.repeat(121);
  assert.throws(
    () => assertUserDocument(over, { filename: 'ghid_7.json' }),
    /at most 120/
  );
});

test('remote SHA state rejects unknown paths and values without filtering', () => {
  const session = createSession();
  const before = session.getStateSnapshot();
  assert.throws(
    () =>
      session.setRemoteFileShas({
        'annotations/users/researcher.json': 'sha',
      }),
    /invalid path or SHA/
  );
  assert.deepEqual(session.getStateSnapshot(), before);
});

test('invalid explicit GitHub refs never become default-branch connections', () => {
  assert.equal(parseOwnerRepo('owner/repo@'), null);
  assert.equal(parseOwnerRepo('owner/repo#'), null);
  assert.equal(parseOwnerRepo('owner/repo@bad ref'), null);
  assert.deepEqual(
    parseOwnerRepo('owner/repo@feature/exact'),
    {
      owner: 'owner',
      repo: 'repo',
      ownerRepo: 'owner/repo',
      ref: 'feature/exact',
      ownerRepoRef: 'owner/repo@feature/exact',
    }
  );
});

test('missing GitHub default branch never becomes main implicitly', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{}', { status: 200 });
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: null,
      workerOrigin: 'https://worker.example',
    });
    await assert.rejects(
      () => sync.validateAndLoadConfig(),
      /metadata must contain exactly/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('cache scopes preserve exact dataset ids and reject coerced user ids', () => {
  const datasetId = 'd'.repeat(200);
  const exact = toCacheScopeKey({
    datasetId,
    repoRef: 'owner/repo@main',
    userId: 42,
  });
  assert.match(exact, new RegExp(`^${datasetId}\\|`));
  assert.equal(
    toCacheScopeKey({
      datasetId,
      repoRef: 'owner/repo@main',
      userId: '42',
    }),
    null
  );
  assert.equal(
    toCacheScopeKey({
      datasetId,
      repoRef: 'owner/repo@main',
      userId: 42.9,
    }),
    null
  );
});

test('GitHub identities reject strings, fractions, and malformed persisted state', () => {
  assert.equal(
    toGitHubUserKey({ id: 42, login: 'researcher' }),
    'ghid_42'
  );
  assert.throws(() => toGitHubUserKey({ id: '42', login: 'researcher' }));
  assert.throws(() => toGitHubUserKey({ id: 42.5, login: 'researcher' }));
  assert.throws(() => toGitHubUserKey({ id: 42 }));
  assert.throws(() =>
    toGitHubUserKey({ id: 42, login: 'researcher', legacy: true })
  );

  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token","user":{"id":42,"\\u0069d":43,"login":"researcher"}}',
    ],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = storage;
  try {
    assert.throws(() => new GitHubAuthSession(), /duplicate JSON object key "id"/);
  } finally {
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('GitHub auth stores only the exact current identity projection', async () => {
  const makeStorage = () => {
    const values = new Map();
    return {
      values,
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
  };
  const sessionStore = makeStorage();
  const localStore = makeStorage();
  const previousSessionStorage = globalThis.sessionStorage;
  const previousLocalStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = sessionStore;
  globalThis.localStorage = localStore;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: 42,
        login: 'researcher',
      }),
      { status: 200 }
    );
  try {
    const auth = new GitHubAuthSession();
    await auth._acceptToken('test-token');
    assert.deepEqual(auth.getUser(), { id: 42, login: 'researcher' });
    assert.deepEqual(
      parseExactJson(
        sessionStore.values.get('cellucid:github-app-auth:session')
      ),
      {
        token: 'test-token',
        user: { id: 42, login: 'researcher' },
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('GitHub worker origin overrides must already be exact origins', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: {
      hostname: 'localhost',
      protocol: 'http:',
    },
    __CELLUCID_GITHUB_WORKER_ORIGIN__: 'https://worker.example/path',
  };
  try {
    assert.throws(
      () => getGitHubWorkerOrigin(),
      /Invalid GitHub worker origin override/
    );
    globalThis.window.__CELLUCID_GITHUB_WORKER_ORIGIN__ =
      'https://worker.example/';
    assert.throws(
      () => getGitHubWorkerOrigin(),
      /Invalid GitHub worker origin override/
    );
    globalThis.window.__CELLUCID_GITHUB_WORKER_ORIGIN__ =
      'https://worker.example';
    assert.equal(getGitHubWorkerOrigin(), 'https://worker.example');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('GitHub installation discovery rejects response fields outside its contract', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token","user":{"id":42,"login":"researcher"}}',
    ],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = storage;
  globalThis.fetch = async () =>
    new Response(
      '{"installations":[{"id":7,"account":{"login":"owner"},"extra":true}]}',
      { status: 200 }
    );
  try {
    const auth = new GitHubAuthSession();
    await assert.rejects(
      () => auth.listInstallations(),
      /must contain exactly id, account/
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('malformed last GitHub identity fails visibly instead of being ignored', () => {
  const values = new Map([
    ['cellucid:community-annotations:last-github-user-key', 'ghid_0042'],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    assert.throws(() => getLastGitHubUserKey(), /invalid exact identity/);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('annotation repository storage preserves exact current values', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    const datasetId = 'dataset::with delimiters';
    assert.equal(
      setAnnotationRepoForDataset(
        datasetId,
        'owner/repo@feature/exact',
        'ghid_42',
        {
        branchMode: 'explicit',
        }
      ),
      true
    );
    assert.equal(
      getAnnotationRepoForDataset(datasetId, 'ghid_42'),
      'owner/repo@feature/exact'
    );
    assert.deepEqual(
      getAnnotationRepoMetaForDataset(datasetId, 'ghid_42'),
      { branchMode: 'explicit' }
    );
    assert.deepEqual(
      parseExactJson(
        values.get('cellucid:community-annotations:repo-map')
      )[`${datasetId}::ghid_42`],
      {
        repoRef: 'owner/repo@feature/exact',
        branchMode: 'explicit',
      }
    );
    assert.equal(
      values.has('cellucid:community-annotations:repo-meta'),
      false
    );
    assert.throws(
      () => getAnnotationRepoForDataset(datasetId, '@ghid_42'),
      /exact ghid identity/
    );
    assert.throws(
      () => setAnnotationRepoForDataset(
        datasetId,
        'owner/repo@main',
        'ghid_42'
      ),
      /contain exactly branchMode/
    );
    assert.throws(
      () => setAnnotationRepoForDataset(
        datasetId,
        'owner/repo',
        'ghid_42',
        { branchMode: 'default' }
      ),
      /resolved-branch/
    );
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('annotation repository storage rejects corrupt maps without repair or overwrite', () => {
  const repoMapKey = 'cellucid:community-annotations:repo-map';
  const malformed =
    '{"synthetic::ghid_42":{"repoRef":"owner/repo@main","branchMode":"default"},' +
    '"synthetic::\\u0067hid_42":{"repoRef":"other/repo@main","branchMode":"default"}}';
  const values = new Map([[repoMapKey, malformed]]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    assert.throws(
      () => getAnnotationRepoForDataset('synthetic', 'ghid_42'),
      /duplicate JSON object key "synthetic::ghid_42"/
    );
    assert.throws(
      () => setAnnotationRepoForDataset(
        'synthetic',
        'owner/repo@main',
        'ghid_42',
        { branchMode: 'default' }
      ),
      /duplicate JSON object key "synthetic::ghid_42"/
    );
    assert.equal(values.get(repoMapKey), malformed);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('annotation access treats the explicit no-dataset state as disconnected', () => {
  assert.equal(isAnnotationRepoConnected(null, 'local'), false);
  assert.equal(isAnnotationRepoConnected(undefined, 'local'), false);
  assert.equal(isAnnotationRepoConnected('', 'local'), false);
  assert.equal(getAnnotationRepoForDataset(null, 'local'), null);
  assert.equal(getAnnotationRepoForDataset(undefined, 'local'), null);
  assert.equal(getAnnotationRepoForDataset('', 'local'), null);
  assert.equal(getAnnotationRepoMetaForDataset(null, 'local'), null);
  assert.throws(
    () => getAnnotationRepoForDataset('   ', 'local'),
    /exact nonblank string/
  );
});

test('scope locking rejects malformed current records instead of treating them as absent', () => {
  const scopeKey = toCacheScopeKey({
    datasetId: 'synthetic',
    repoRef: 'owner/repo@main',
    userId: 42,
  });
  const lockKey = `cellucid:community-annotations:lock:${scopeKey}`;
  const localValues = new Map([[lockKey, '{"owner":"bad","expiresAtMs":1}']]);
  const sessionValues = new Map([
    [
      'cellucid:community-annotations:tab-id:v1',
      '123e4567-e89b-42d3-a456-426614174000',
    ],
  ]);
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = {
    getItem: (key) => localValues.has(key) ? localValues.get(key) : null,
    setItem: (key, value) => localValues.set(String(key), String(value)),
    removeItem: (key) => localValues.delete(String(key)),
  };
  globalThis.sessionStorage = {
    getItem: (key) => sessionValues.has(key) ? sessionValues.get(key) : null,
    setItem: (key, value) => sessionValues.set(String(key), String(value)),
    removeItem: (key) => sessionValues.delete(String(key)),
  };
  try {
    const lock = new CommunityAnnotationScopeLock();
    const result = lock.setScopeKey(scopeKey);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOCK_RECORD_INVALID');
    assert.match(result.message, /contain exactly owner, acquiredAt, and expiresAtMs/);
    assert.equal(localValues.get(lockKey), '{"owner":"bad","expiresAtMs":1}');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('scope lock ownership is checked against the authoritative storage record', () => {
  const scopeKey = toCacheScopeKey({
    datasetId: 'synthetic-lock-owner',
    repoRef: 'owner/repo@main',
    userId: 42,
  });
  const lockKey = `cellucid:community-annotations:lock:${scopeKey}`;
  const localValues = new Map();
  const sessionValues = new Map([
    [
      'cellucid:community-annotations:tab-id:v1',
      '123e4567-e89b-42d3-a456-426614174000',
    ],
  ]);
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = {
    getItem: (key) => localValues.has(key) ? localValues.get(key) : null,
    setItem: (key, value) => localValues.set(String(key), String(value)),
    removeItem: (key) => localValues.delete(String(key)),
  };
  globalThis.sessionStorage = {
    getItem: (key) => sessionValues.has(key) ? sessionValues.get(key) : null,
    setItem: (key, value) => sessionValues.set(String(key), String(value)),
    removeItem: (key) => sessionValues.delete(String(key)),
  };
  const lock = new CommunityAnnotationScopeLock();
  try {
    assert.equal(lock.setScopeKey(scopeKey).ok, true);
    assert.equal(lock.isHolding(scopeKey), true);
    localValues.delete(lockKey);
    assert.equal(lock.isHolding(scopeKey), false);
    assert.equal(lock.setScopeKey(scopeKey).ok, true);
    assert.equal(lock.isHolding(scopeKey), true);
  } finally {
    lock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});


test('merge contract rejects duplicate mappings and cycles', () => {
  const duplicate = validMerges();
  duplicate.merges.push({
    ...duplicate.merges[0],
    intoSuggestionId: 'other',
  });
  assert.throws(() => assertMergesDocument(duplicate), /duplicates an existing/);

  const cycle = validMerges();
  cycle.merges.push({
    bucket: 'cell_type:Alpha',
    fromSuggestionId: 'into',
    intoSuggestionId: 'from',
    by: 'ghid_42',
    at: '2026-07-25T01:02:04.456Z',
  });
  assert.throws(() => assertMergesDocument(cycle), /contains a cycle/);
});


test('local publisher emits one exact current user document without undefined fields', () => {
  const session = createSession();
  session.addSuggestion('cell_type', 0, {
    label: 'T cell',
    markers: ['CD3D'],
  });
  session.recordDatasetAccess({
    datasetId: 'synthetic',
    fieldsToAnnotate: ['cell_type'],
  });
  assert.throws(
    () => session.buildUserFileDocument(),
    /options must contain exactly/
  );
  assert.throws(
    () => session.buildUserFileDocument({ githubUserId: '42' }),
    /options must contain exactly/
  );
  const document = session.buildUserFileDocument({ githubUserId: 42 });
  assert.doesNotThrow(() =>
    assertUserDocument(document, { filename: 'ghid_42.json' })
  );
  assert.equal(JSON.stringify(document).includes('undefined'), false);
  assert.equal(Object.hasOwn(document, 'displayName'), false);
});

test('local publisher rejects unknown in-memory suggestion fields instead of dropping them', () => {
  const session = createSession();
  session.addSuggestion('cell_type', 0, { label: 'T cell' });
  session._state.suggestions['cell_type:Alpha'][0].unknown = true;
  assert.throws(
    () => session.buildUserFileDocument({ githubUserId: 42 }),
    /suggestion contains unknown field "unknown"/
  );
});


test('schema identities are exact and do not accept alternate ids', () => {
  for (const [kind, id] of Object.entries(ANNOTATION_CONTRACT_IDS)) {
    assert.doesNotThrow(() =>
      assertSchemaIdentity({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: id,
      }, kind)
    );
    assert.throws(
      () =>
        assertSchemaIdentity({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: `${id}.alternate`,
        }, kind),
      /must equal/
    );
  }
});


test('invalid local state fails visibly before any persisted content is applied', () => {
  const makeStorage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = makeStorage();
  globalThis.sessionStorage = makeStorage();

  const scope = {
    datasetId: 'synthetic',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const key = toSessionStorageKey(scope);
  globalThis.localStorage.setItem(key, '{"version":1');
  const session = new CommunityAnnotationSession();
  const before = session.getStateSnapshot();
  let integrityEvent = null;
  session.on('integrity:error', (event) => {
    integrityEvent = event;
  });
  try {
    assert.throws(
      () => session.setCacheContext(scope),
      (error) => error?.code === 'LOCAL_ANNOTATION_STATE_INVALID'
    );
    assert.equal(integrityEvent?.scopeKey, key);
    assert.deepEqual(session.getStateSnapshot(), {
      ...before,
      datasetId: 'synthetic',
    });
  } finally {
    session._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('local persistence stores only exact wire suggestion fields', () => {
  const makeStorage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = makeStorage();
  globalThis.sessionStorage = makeStorage();
  const scope = {
    datasetId: 'persistence-exact',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const session = new CommunityAnnotationSession();
  try {
    session.setCacheContext(scope);
    session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
    });
    session.setFieldCategories('cell_type', ['Alpha']);
    session.addSuggestion('cell_type', 0, { label: 'T cell' });
    session._saveNow();
    const persisted = parseExactJson(
      globalThis.localStorage.getItem(toSessionStorageKey(scope))
    );
    const suggestion = persisted.suggestions['cell_type:Alpha'][0];
    assert.deepEqual(Object.keys(suggestion).sort(), [
      'editedAt',
      'evidence',
      'id',
      'label',
      'markers',
      'ontologyId',
      'proposedAt',
      'proposedBy',
    ]);
    assert.equal(Object.hasOwn(suggestion, 'upvotes'), false);
    assert.equal(Object.hasOwn(suggestion, 'downvotes'), false);
    assert.equal(Object.hasOwn(suggestion, 'comments'), false);
  } finally {
    session._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});


test('GitHub pull returns only exact path/SHA/document records', async () => {
  const previousFetch = globalThis.fetch;
  const document = validRemoteUser();
  const responses = [
    {
      tree: [
        {
          type: 'blob',
          path: 'annotations/users/ghid_7.json',
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    },
    {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(document), 'utf8').toString('base64'),
    },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    const result = await sync.pullAllUsers();
    assert.deepEqual(result.docs, [
      {
        path: 'annotations/users/ghid_7.json',
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        doc: document,
      },
    ]);
    assert.equal(Object.hasOwn(result.docs[0], '__path'), false);
    assert.equal(Object.hasOwn(result.docs[0].doc, '__invalid'), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test('GitHub pull rejects one invalid user blob instead of returning a partial set', async () => {
  const previousFetch = globalThis.fetch;
  const invalid = validRemoteUser({ unknownField: true });
  const responses = [
    {
      tree: [
        {
          type: 'blob',
          path: 'annotations/users/ghid_7.json',
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    },
    {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(invalid), 'utf8').toString('base64'),
    },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses.shift()), { status: 200 });
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    await assert.rejects(
      () => sync.pullAllUsers(),
      /unknown field.*unknownField|unknownField.*unknown field/i
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('browser JSON boundary rejects decoded duplicate object keys', async () => {
  const previousFetch = globalThis.fetch;
  const encodedDuplicate = JSON.stringify(validRemoteUser()).replace(
    '{"version":1,',
    '{"version":1,"\\u0076ersion":1,'
  );
  const responses = [
    {
      tree: [
        {
          type: 'blob',
          path: 'annotations/users/ghid_7.json',
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    },
    {
      encoding: 'base64',
      content: Buffer.from(encodedDuplicate, 'utf8').toString('base64'),
    },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses.shift()), { status: 200 });
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    await assert.rejects(() => sync.pullAllUsers(), /duplicate JSON object key "version"/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub HTTP success requires one exact JSON response document', async (t) => {
  for (const scenario of [
    {
      name: 'duplicate response keys',
      body: '{"tree":[],"\\u0074ree":[]}',
      pattern: /duplicate JSON object key "tree"/,
    },
    {
      name: 'non-JSON response',
      body: 'ok',
      pattern: /returned invalid JSON/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(scenario.body, { status: 200 });
      try {
        const sync = new CommunityAnnotationGitHubSync({
          datasetId: 'synthetic',
          owner: 'owner',
          repo: 'repo',
          token: 'test-token',
          branch: 'main',
          workerOrigin: 'https://worker.example',
        });
        await assert.rejects(() => sync.pullAllUsers(), scenario.pattern);
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});

test('CAP exact lookups never substitute the first approximate result', async (t) => {
  const responseFor = (lookupCells) =>
    new Response(JSON.stringify({ data: { lookupCells } }), { status: 200 });

  await t.test('ontology id', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => responseFor([
      {
        name: 'CL candidate',
        fullName: 'CL candidate',
        ontologyTerm: 'CL candidate',
        ontologyTermId: 'CL:0000999',
        markerGenes: [],
        canonicalMarkerGenes: [],
        synonyms: [],
        rationale: '',
      },
    ]);
    try {
      assert.equal(await lookupByOntologyId('CL:0000625'), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  await t.test('cell type name', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => responseFor([
      {
        name: 'T cell',
        fullName: 'T cell',
        ontologyTerm: 'T cell',
        ontologyTermId: 'CL:0000084',
        markerGenes: [],
        canonicalMarkerGenes: [],
        synonyms: [],
        rationale: '',
      },
    ]);
    try {
      assert.equal(await lookupByName('B cell'), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  await t.test('community feedback', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => responseFor([
      {
        name: 'T cell',
        fullName: 'T cell',
        scores: { agree: 10, disagree: 1, idk: 2, total: 13 },
      },
    ]);
    try {
      assert.equal(await getCommunityFeedback('B cell'), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('CAP HTTP success rejects duplicate JSON keys', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      '{"data":{"lookupCells":[]},"\\u0064ata":{"lookupCells":[]}}',
      { status: 200 }
    );
  try {
    await assert.rejects(
      () => searchCellTypes('T cell'),
      /duplicate JSON object key "data"/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub pull rejects non-current JSON filenames under annotations/users', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      tree: [
        {
          type: 'blob',
          path: 'annotations/users/researcher.json',
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    }), { status: 200 });
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    await assert.rejects(() => sync.pullAllUsers(), /Invalid annotation user-file path/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub pull rejects truncated trees instead of compiling a partial repository', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ tree: [], truncated: true }), { status: 200 });
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    await assert.rejects(() => sync.pullAllUsers(), /truncated git tree/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub pull rejects alternate blob encodings and UTF-8 BOM input', async (t) => {
  const document = validRemoteUser();
  for (const scenario of [
    {
      name: 'alternate encoding',
      blob: { encoding: 'utf-8', content: JSON.stringify(document) },
      pattern: /must use base64 encoding/,
    },
    {
      name: 'UTF-8 BOM',
      blob: {
        encoding: 'base64',
        content: Buffer.from(`\uFEFF${JSON.stringify(document)}`, 'utf8').toString('base64'),
      },
      pattern: /invalid JSON value/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const previousFetch = globalThis.fetch;
      const responses = [
        {
          tree: [
            {
              type: 'blob',
              path: 'annotations/users/ghid_7.json',
              sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          ],
        },
        scenario.blob,
      ];
      globalThis.fetch = async () =>
        new Response(JSON.stringify(responses.shift()), { status: 200 });
      try {
        const sync = new CommunityAnnotationGitHubSync({
          datasetId: 'synthetic',
          owner: 'owner',
          repo: 'repo',
          token: 'test-token',
          branch: 'main',
          workerOrigin: 'https://worker.example',
        });
        await assert.rejects(() => sync.pullAllUsers(), scenario.pattern);
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});

test('session persistence write failures throw after emitting the visible error', () => {
  const values = new Map();
  const workingStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const failingStorage = {
    ...workingStorage,
    setItem: () => {
      throw new Error('quota denied');
    },
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = workingStorage;
  globalThis.sessionStorage = workingStorage;
  const session = new CommunityAnnotationSession();
  let persistenceEvent = null;
  session.on('persistence:error', (event) => {
    persistenceEvent = event;
  });
  try {
    session.setCacheContext({
      datasetId: 'persistence-failure',
      repoRef: 'owner/repo@main',
      userId: 42,
    });
    session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
    });
    globalThis.localStorage = failingStorage;
    assert.throws(
      () => session._saveNow(),
      (error) => error?.code === 'LOCAL_ANNOTATION_PERSISTENCE_FAILED'
    );
    assert.match(persistenceEvent?.message || '', /browser storage write error/);
    globalThis.localStorage = workingStorage;
    assert.throws(
      () => session.setCacheContext({
        datasetId: 'persistence-failure',
        repoRef: 'owner/repo@main',
        userId: 42,
      }),
      (error) => error?.code === 'LOCAL_ANNOTATION_PERSISTENCE_UNAVAILABLE'
    );
  } finally {
    if (session._saveTimer) clearTimeout(session._saveTimer);
    globalThis.localStorage = workingStorage;
    session._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('raw-file cache fails visibly when IndexedDB is unavailable', async () => {
  const previousIndexedDB = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    const cache = new CommunityAnnotationFileCache();
    await assert.rejects(
      () => cache.init(),
      (error) => error?.code === 'LOCAL_RAW_CACHE_UNAVAILABLE'
    );
    assert.equal(cache.getCacheMode(), 'unavailable');
  } finally {
    if (previousIndexedDB !== undefined) globalThis.indexedDB = previousIndexedDB;
  }
});

test('raw-file SHA index and prefix filters use one exact representation', () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const scope = {
    datasetId: 'cache-exact',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const indexKey = toFileShaIndexKey(scope);
  const cache = new CommunityAnnotationFileCache();
  cache._db = {};
  try {
    values.set(indexKey, JSON.stringify({
      'annotations/users/ghid_42.json':
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }));
    assert.deepEqual(
      cache.getKnownShas(scope, {
        prefixes: ['annotations/users/'],
      }),
      {
        'annotations/users/ghid_42.json':
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }
    );
    assert.throws(
      () => cache.getKnownShas(scope, { prefixes: 'annotations/users/' }),
      /array or null/
    );
    values.set(indexKey, JSON.stringify({
      'annotations/users/ghid_42.json': 'short-sha',
    }));
    assert.throws(
      () => cache.getKnownShas(scope),
      /SHA index/
    );
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});
