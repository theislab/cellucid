import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationSession } from '../assets/js/app/community-annotations/session.js';
import {
  CommunityAnnotationGitHubSync,
  parseOwnerRepo,
  setDatasetAnnotationRepoFromUrlParamAsync,
} from '../assets/js/app/community-annotations/github-sync.js';
import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';
import {
  GitHubAuthSession,
  getGitHubWorkerOrigin,
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

const PROTOTYPE_IDENTITIES = Object.freeze([
  '__proto__',
  ...Object.getOwnPropertyNames(Object.prototype)
    .filter(key => key !== '__proto__')
    .sort(),
]);

function exactOwnRecord(entries) {
  return Object.fromEntries(entries);
}


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

test('community annotation state preserves every legal prototype-named field and dataset identity', () => {
  const objectPrototypeBefore =
    Object.getOwnPropertyDescriptors(Object.prototype);
  const session = createSession();
  assert.equal(session.getAnnotatableConsensusSettings('toString'), null);
  assert.equal(session.getAnnotatableConsensusSettings('constructor'), null);
  assert.equal(session.isFieldClosed('__proto__'), false);
  assert.equal(session.toBucketKey('__proto__', 0), null);
  const settings = exactOwnRecord(
    PROTOTYPE_IDENTITIES.map((fieldKey, index) => [
      fieldKey,
      {
        minAnnotators: index % 4,
        threshold: (index - PROTOTYPE_IDENTITIES.length / 2) /
          PROTOTYPE_IDENTITIES.length,
      },
    ])
  );

  for (const fieldKey of PROTOTYPE_IDENTITIES) {
    session.setFieldCategories(fieldKey, ['Exact category']);
    assert.equal(
      session.toBucketKey(fieldKey, 0),
      `${fieldKey}:Exact category`
    );
    session.setFieldAnnotated(fieldKey, true);
  }
  session.setAnnotatableConsensusSettingsMap(settings);
  session.setClosedAnnotatableFields(PROTOTYPE_IDENTITIES);

  for (const datasetId of PROTOTYPE_IDENTITIES) {
    session.recordDatasetAccess({
      datasetId,
      fieldsToAnnotate: PROTOTYPE_IDENTITIES,
    });
  }

  const settingsOut = session.getAnnotatableConsensusSettingsMap();
  const datasetsOut = session.getDatasetAccessMap();
  assert.equal(Object.getPrototypeOf(settingsOut), Object.prototype);
  assert.equal(Object.getPrototypeOf(datasetsOut), Object.prototype);
  assert.equal(Object.getPrototypeOf(session._categoriesByFieldKey), null);
  assert.equal(Object.getPrototypeOf(session._state.annotatableSettings), null);
  assert.equal(Object.getPrototypeOf(session._state.closedAnnotatableFields), null);
  assert.equal(Object.getPrototypeOf(session._state.datasets), null);
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    objectPrototypeBefore
  );
  assert.deepEqual(Object.keys(settingsOut).sort(), [...PROTOTYPE_IDENTITIES].sort());
  assert.deepEqual(Object.keys(datasetsOut).sort(), [...PROTOTYPE_IDENTITIES].sort());
  assert.deepEqual(
    session.getClosedAnnotatableFields(),
    [...PROTOTYPE_IDENTITIES].sort()
  );
  for (const fieldKey of PROTOTYPE_IDENTITIES) {
    assert.equal(Object.hasOwn(settingsOut, fieldKey), true);
    assert.deepEqual(settingsOut[fieldKey], settings[fieldKey]);
  }
  for (const datasetId of PROTOTYPE_IDENTITIES) {
    assert.equal(Object.hasOwn(datasetsOut, datasetId), true);
    assert.deepEqual(
      datasetsOut[datasetId].fieldsToAnnotate,
      PROTOTYPE_IDENTITIES
    );
  }
});

test('votes, comments, and user-file export preserve every legal prototype-named suggestion id', () => {
  const session = createSession();
  const remote = validRemoteUser({
    suggestions: {
      'cell_type:Alpha': PROTOTYPE_IDENTITIES.map((id, index) => ({
        id,
        label: `Prototype identity ${index + 1}`,
        ontologyId: null,
        evidence: null,
        markers: [],
        proposedBy: 'ghid_7',
        proposedAt: '2026-07-25T01:02:03.456Z',
        editedAt: null,
      })),
    },
  });
  session.mergeFromUserFiles([remote]);

  for (const id of PROTOTYPE_IDENTITIES) {
    assert.equal(session.vote('cell_type', 0, id, 'up'), true);
    assert.ok(session.addComment('cell_type', 0, id, `Comment for ${id}`));
  }

  const document = session.buildUserFileDocument({ githubUserId: 42 });
  assert.equal(Object.getPrototypeOf(document.votes), Object.prototype);
  assert.equal(Object.getPrototypeOf(document.comments), Object.prototype);
  assert.deepEqual(Object.keys(document.votes).sort(), [...PROTOTYPE_IDENTITIES].sort());
  assert.deepEqual(Object.keys(document.comments).sort(), [...PROTOTYPE_IDENTITIES].sort());
  for (const id of PROTOTYPE_IDENTITIES) {
    assert.equal(Object.hasOwn(document.votes, id), true);
    assert.equal(document.votes[id], 'up');
    assert.equal(Object.hasOwn(document.comments, id), true);
    assert.equal(document.comments[id].length, 1);
  }
  const roundTripped = parseExactJson(JSON.stringify(document));
  assert.deepEqual(Object.keys(roundTripped.votes).sort(), [...PROTOTYPE_IDENTITIES].sort());
  assert.deepEqual(Object.keys(roundTripped.comments).sort(), [...PROTOTYPE_IDENTITIES].sort());
  assert.doesNotThrow(() => assertUserDocument(roundTripped));

  const ownSession = createSession();
  const ownRemote = validRemoteUser({
    username: 'ghid_42',
    githubUserId: 42,
    login: 'researcher',
    suggestions: {
      'cell_type:Alpha': PROTOTYPE_IDENTITIES.map((id, index) => ({
        id,
        label: `Own-device identity ${index + 1}`,
        ontologyId: null,
        evidence: null,
        markers: [],
        proposedBy: 'ghid_42',
        proposedAt: '2026-07-25T01:02:03.456Z',
        editedAt: null,
      })),
    },
    comments: exactOwnRecord(
      PROTOTYPE_IDENTITIES.map((id, index) => [
        id,
        [
          {
            id: `hydrated-comment-${index + 1}`,
            text: `Hydrated comment for ${id}`,
            authorUsername: 'ghid_42',
            createdAt: '2026-07-25T01:02:03.456Z',
            editedAt: null,
          },
        ],
      ])
    ),
  });
  ownSession.mergeFromUserFiles([ownRemote]);
  assert.equal(Object.getPrototypeOf(ownSession._state.myComments), null);
  const hydratedDocument = ownSession.buildUserFileDocument({
    githubUserId: 42,
  });
  assert.deepEqual(
    Object.keys(hydratedDocument.comments).sort(),
    [...PROTOTYPE_IDENTITIES].sort()
  );
  for (const id of PROTOTYPE_IDENTITIES) {
    assert.equal(Object.hasOwn(ownSession._state.myComments, id), true);
    assert.equal(hydratedDocument.comments[id].length, 1);
  }
});

test('prototype-named annotation identities survive local persistence and atomic Pull application', () => {
  const identities = ['__proto__', 'constructor', 'toString'];
  const values = new Map();
  const storage = {
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  const scope = {
    datasetId: 'prototype-lifecycle',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const settings = exactOwnRecord(
    identities.map((fieldKey, index) => [
      fieldKey,
      { minAnnotators: index + 1, threshold: index / 4 },
    ])
  );
  const remote = validRemoteUser({
    suggestions: {
      'cell_type:Alpha': identities.map((id, index) => ({
        id,
        label: `Lifecycle identity ${index + 1}`,
        ontologyId: null,
        evidence: null,
        markers: [],
        proposedBy: 'ghid_7',
        proposedAt: '2026-07-25T01:02:03.456Z',
        editedAt: null,
      })),
    },
  });
  const producer = new CommunityAnnotationSession();
  let consumer = null;
  let localSuggestionId = null;
  try {
    producer.setCacheContext(scope);
    producer.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
    });
    producer.setFieldCategories('cell_type', ['Alpha']);
    producer.mergeFromUserFiles([remote]);
    localSuggestionId = producer.addSuggestion(
      'cell_type',
      0,
      { label: 'Local rollback sentinel' }
    );
    for (const id of identities) {
      producer.vote('cell_type', 0, id, 'up');
      producer.addComment('cell_type', 0, id, `Persisted comment for ${id}`);
      producer.setFieldCategories(id, ['Exact category']);
      producer.setFieldAnnotated(id, true);
    }
    producer.setAnnotatableConsensusSettingsMap(settings);
    producer.setClosedAnnotatableFields(identities);
    producer.recordDatasetAccess({
      datasetId: '__proto__',
      fieldsToAnnotate: identities,
    });
    producer._saveNow();

    const persisted = parseExactJson(
      values.get(toSessionStorageKey(scope))
    );
    assert.deepEqual(Object.keys(persisted.myComments).sort(), [...identities].sort());
    assert.deepEqual(Object.keys(persisted.annotatableSettings).sort(), [...identities].sort());
    assert.deepEqual(Object.keys(persisted.datasets), ['__proto__']);

    if (producer._saveTimer !== null) {
      clearTimeout(producer._saveTimer);
      producer._saveTimer = null;
    }
    producer._scopeLock.release();

    consumer = new CommunityAnnotationSession();
    consumer.setCacheContext(scope);
    consumer.setFieldCategories('cell_type', ['Alpha']);
    for (const fieldKey of identities) {
      consumer.setFieldCategories(fieldKey, ['Exact category']);
      assert.deepEqual(
        consumer.getAnnotatableConsensusSettings(fieldKey),
        settings[fieldKey]
      );
      assert.equal(consumer.isFieldClosed(fieldKey), true);
    }
    assert.equal(Object.getPrototypeOf(consumer._state.myComments), null);
    assert.equal(Object.getPrototypeOf(consumer._state.annotatableSettings), null);
    assert.equal(Object.getPrototypeOf(consumer._state.datasets), null);

    const conflicting = validRemoteUser({
      suggestions: {
        'cell_type:Beta': [
          {
            id: localSuggestionId,
            label: 'Conflicting remote owner',
            ontologyId: null,
            evidence: null,
            markers: [],
            proposedBy: 'ghid_7',
            proposedAt: '2026-07-25T01:02:03.456Z',
            editedAt: null,
          },
        ],
      },
    });
    assert.throws(
      () => consumer.rebuildMergedViewFromUserFiles([conflicting]),
      /conflicts with the suggestion owned by/
    );
    assert.equal(Object.getPrototypeOf(consumer._state.myComments), null);
    assert.equal(Object.getPrototypeOf(consumer._state.annotatableSettings), null);
    assert.equal(Object.getPrototypeOf(consumer._state.closedAnnotatableFields), null);
    assert.equal(Object.getPrototypeOf(consumer._state.datasets), null);
    assert.equal(
      consumer.getSuggestions('cell_type', 0)
        .some(suggestion => suggestion.id === localSuggestionId),
      true
    );

    const pullInput = {
      remoteUserDocs: [remote],
      moderationDocument: null,
      categoricalFieldKeys: ['cell_type', ...identities],
      fieldsToAnnotate: identities,
      annotatableSettings: settings,
      closedFields: identities,
      datasetId: '__proto__',
      remoteFileShas: {},
    };
    const abortController = new AbortController();
    const originalRebuild = consumer.rebuildMergedViewFromUserFiles;
    consumer.rebuildMergedViewFromUserFiles = function (...args) {
      const result = originalRebuild.apply(this, args);
      abortController.abort(new Error('Synthetic post-merge Pull abort'));
      return result;
    };
    assert.throws(
      () => consumer.applyPulledRepositoryState({
        ...pullInput,
        signal: abortController.signal,
      }),
      /Synthetic post-merge Pull abort/
    );
    consumer.rebuildMergedViewFromUserFiles = originalRebuild;
    assert.equal(Object.getPrototypeOf(consumer._state.myComments), null);
    assert.equal(Object.getPrototypeOf(consumer._state.annotatableSettings), null);
    assert.equal(Object.getPrototypeOf(consumer._state.closedAnnotatableFields), null);
    assert.equal(Object.getPrototypeOf(consumer._state.datasets), null);
    assert.equal(
      consumer.getSuggestions('cell_type', 0)
        .some(suggestion => suggestion.id === localSuggestionId),
      true
    );

    consumer.applyPulledRepositoryState(pullInput);
    assert.ok(
      consumer.addComment(
        'cell_type',
        0,
        '__proto__',
        'Comment added after rollback and successful Pull'
      )
    );
    consumer._saveNow();

    const document = consumer.buildUserFileDocument({ githubUserId: 42 });
    for (const id of identities) {
      assert.equal(Object.hasOwn(document.votes, id), true);
    }
    assert.equal(Object.hasOwn(document.votes, localSuggestionId), true);
    assert.deepEqual(Object.keys(document.comments).sort(), [...identities].sort());
    assert.equal(document.comments.__proto__.length, 2);
    assert.deepEqual(Object.keys(document.datasets), ['__proto__']);
    assert.equal(Object.getPrototypeOf(document.votes), Object.prototype);
    assert.equal(Object.getPrototypeOf(document.comments), Object.prototype);
    assert.equal(Object.getPrototypeOf(document.datasets), Object.prototype);
    assert.equal(Object.getPrototypeOf(consumer._state.myComments), null);
    assert.equal(Object.getPrototypeOf(consumer._state.annotatableSettings), null);
    assert.equal(Object.getPrototypeOf(consumer._state.datasets), null);
    assert.doesNotThrow(() =>
      assertUserDocument(parseExactJson(JSON.stringify(document)))
    );
  } finally {
    if (producer._saveTimer !== null) clearTimeout(producer._saveTimer);
    if (consumer && consumer._saveTimer !== null) {
      clearTimeout(consumer._saveTimer);
    }
    producer._scopeLock.release();
    consumer?._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('config publication detects a prototype-named field settings-only change', async () => {
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const publishedSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const currentSettings = exactOwnRecord([
    ['__proto__', { minAnnotators: 1, threshold: 0.25 }],
  ]);
  const nextSettings = exactOwnRecord([
    ['__proto__', { minAnnotators: 1, threshold: 0.75 }],
  ]);
  const current = validConfig({
    supportedDatasets: [
      {
        datasetId: 'synthetic',
        name: 'Synthetic',
        fieldsToAnnotate: ['__proto__'],
        annotatableSettings: currentSettings,
        closedFields: [],
      },
    ],
  });
  const repoInfo = {
    full_name: 'owner/repo',
    default_branch: 'main',
    private: false,
    allow_forking: true,
    permissions: {
      pull: true,
      triage: false,
      push: true,
      maintain: true,
      admin: false,
    },
  };
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          sha,
          content: Buffer.from(JSON.stringify(current), 'utf8').toString('base64'),
        }),
        { status: 200 }
      );
    }
    const operationId = new Headers(options.headers).get(
      'x-cellucid-operation-id'
    );
    return new Response(
      JSON.stringify({ content: { sha: publishedSha } }),
      {
        status: 200,
        headers: {
          'x-cellucid-operation-id': operationId,
          'x-cellucid-operation-outcome': 'applied',
        },
      }
    );
  };
  try {
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    sync.validateAndLoadConfig = async () => ({
      repoInfo,
      branch: 'main',
    });

    const result = await sync.updateDatasetFieldsToAnnotate({
      datasetId: 'synthetic',
      datasetName: 'Synthetic',
      fieldsToAnnotate: ['__proto__'],
      annotatableSettings: nextSettings,
      closedFields: [],
      conflictIfRemoteShaNotEqual: sha,
      publicationMode: 'direct',
    });
    assert.equal(result.changed, true);
    assert.equal(result.sha, publishedSha);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.method, 'PUT');
    const requestBody = parseExactJson(requests[1].options.body);
    const published = parseExactJson(
      Buffer.from(requestBody.content, 'base64').toString('utf8')
    );
    const publishedSettings =
      published.supportedDatasets[0].annotatableSettings;
    assert.equal(Object.hasOwn(publishedSettings, '__proto__'), true);
    assert.deepEqual(
      publishedSettings.__proto__,
      { minAnnotators: 1, threshold: 0.75 }
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('annotation field-key encoding is injective across exact supported raw keys', () => {
  const colonField = createSession();
  colonField.setFieldCategories('foo:bar', ['Category:with:colon']);
  const colonSuggestion = colonField.addSuggestion('foo:bar', 0, {
    label: 'Colon field suggestion',
  });

  assert.throws(
    () => colonField.setFieldCategories(
      'fk~foo%3Abar',
      ['Category:with:colon']
    ),
    /fieldKey.*reserved|reserved.*fieldKey/i
  );
  assert.deepEqual(
    colonField.getSuggestions('foo:bar', 0).map((suggestion) => suggestion.id),
    [colonSuggestion]
  );
  const colonDocument = colonField.buildUserFileDocument({
    githubUserId: 42,
  });
  assert.deepEqual(
    Object.keys(colonDocument.suggestions),
    ['fk~foo%3Abar:Category:with:colon']
  );
  assert.deepEqual(colonDocument.votes, {
    [colonSuggestion]: 'up',
  });
  assert.doesNotThrow(() => assertUserDocument(colonDocument));

  for (const safeFieldKey of [
    'fk~foo',
    'FK~foo%3Abar',
    'plain%3Afoo',
    'fk~foo%253Abar',
    'fk~literal%3A:real-colon',
  ]) {
    const session = createSession();
    session.setFieldCategories(safeFieldKey, ['Category:with:colon']);
    const id = session.addSuggestion(safeFieldKey, 0, {
      label: `Suggestion for ${safeFieldKey}`,
    });
    assert.equal(session.getSuggestions(safeFieldKey, 0)[0].id, id);
  }
});

test('config, user access metadata, and authoring reject only reserved raw field keys', () => {
  const reserved = 'fk~foo%3Abar';
  const config = validConfig();
  config.supportedDatasets[0].fieldsToAnnotate = [reserved];
  config.supportedDatasets[0].annotatableSettings = {
    [reserved]: { minAnnotators: 1, threshold: 0.5 },
  };
  assert.throws(
    () => assertConfigDocument(config),
    /fieldsToAnnotate.*reserved|reserved.*field/i
  );

  const user = validRemoteUser({
    datasets: {
      synthetic: {
        fieldsToAnnotate: [reserved],
        lastAccessedAt: '2026-07-25T01:02:03.456Z',
      },
    },
  });
  assert.throws(
    () => assertUserDocument(user),
    /fieldsToAnnotate.*reserved|reserved.*field/i
  );

  const session = createSession();
  assert.throws(
    () => session.setFieldAnnotated(reserved, true),
    /fieldKey.*reserved|reserved.*fieldKey/i
  );
  assert.throws(
    () => session.recordDatasetAccess({
      datasetId: 'synthetic',
      fieldsToAnnotate: [reserved],
    }),
    /fieldsToAnnotate.*reserved|reserved.*field/i
  );

  for (const safeFieldKey of [
    'fk~foo',
    'FK~foo%3Abar',
    'plain%3Afoo',
    'fk~foo%253Abar',
    'fk~literal%3A:real-colon',
  ]) {
    const safe = validConfig();
    safe.supportedDatasets[0].fieldsToAnnotate = [safeFieldKey];
    safe.supportedDatasets[0].annotatableSettings = {
      [safeFieldKey]: { minAnnotators: 1, threshold: 0.5 },
    };
    assert.doesNotThrow(() => assertConfigDocument(safe));
  }
});

test('suggestion identifiers reject the vote-key delimiter at every wire boundary', () => {
  const invalidUserDocuments = [];

  const definition = validRemoteUser();
  definition.suggestions['cell_type:Alpha'][0].id = 'B:C';
  invalidUserDocuments.push(definition);

  invalidUserDocuments.push(validRemoteUser({ votes: { 'B:C': 'up' } }));
  invalidUserDocuments.push(validRemoteUser({ comments: { 'B:C': [] } }));
  invalidUserDocuments.push(validRemoteUser({
    deletedSuggestions: { 'cell_type:Alpha': ['B:C'] },
  }));

  for (const document of invalidUserDocuments) {
    assert.throws(
      () => assertUserDocument(document),
      /suggestion.*colon|suggestion.*":"|must not contain.*:/i
    );
  }

  for (const field of ['fromSuggestionId', 'intoSuggestionId']) {
    const document = validMerges();
    document.merges[0][field] = 'B:C';
    assert.throws(
      () => assertMergesDocument(document),
      /suggestion.*colon|suggestion.*":"|must not contain.*:/i
    );
  }

  const encodedColonField = validRemoteUser({
    suggestions: {
      'fk~foo%3Abar:Category:with:colon': [{
        id: 'legal-id',
        label: 'Legal',
        proposedBy: 'ghid_7',
        proposedAt: '2026-07-25T01:02:03.456Z',
      }],
    },
    votes: { 'legal-id': 'up' },
    comments: { 'legal-id': [] },
    deletedSuggestions: {
      'fk~foo%3Abar:Category:with:colon': ['legal-deleted-id'],
    },
  });
  assert.doesNotThrow(() => assertUserDocument(encodedColonField));
});

test('local suggestion references reject colons before compound vote-key mutation', () => {
  const session = createSession();
  const suggestionId = session.addSuggestion('cell_type', 0, {
    label: 'Legal suggestion',
  });
  const before = session.getStateSnapshot();

  for (const mutate of [
    () => session.vote('cell_type', 0, 'B:C', 'up'),
    () => session.addComment('cell_type', 0, 'B:C', 'Comment'),
    () => session.editMySuggestion('cell_type', 0, 'B:C', { label: 'Edit' }),
    () => session.deleteMySuggestion('cell_type', 0, 'B:C'),
    () => session.getMyVoteDirect('cell_type', 0, 'B:C'),
    () => session.getMyBundleVoteInfo('cell_type', 0, 'B:C'),
    () => session.getMyVote('cell_type', 0, 'B:C'),
    () => session.getComments('cell_type', 0, 'B:C'),
    () => session.editComment('cell_type', 0, 'B:C', 'comment-id', 'Edit'),
    () => session.deleteComment('cell_type', 0, 'B:C', 'comment-id'),
    () => session.addModerationMerge({
      fieldKey: 'cell_type',
      catIdx: 0,
      fromSuggestionId: 'B:C',
      intoSuggestionId: suggestionId,
    }),
    () => session.addModerationMerge({
      fieldKey: 'cell_type',
      catIdx: 0,
      fromSuggestionId: suggestionId,
      intoSuggestionId: 'B:C',
    }),
    () => session.editModerationMergeNote({
      fieldKey: 'cell_type',
      catIdx: 0,
      fromSuggestionId: 'B:C',
      note: 'Edit',
    }),
    () => session.detachModerationMerge({
      fieldKey: 'cell_type',
      catIdx: 0,
      fromSuggestionId: 'B:C',
    }),
    () => session.detachLastModerationMerge({
      fieldKey: 'cell_type',
      catIdx: 0,
      intoSuggestionId: 'B:C',
    }),
  ]) {
    assert.throws(
      mutate,
      /suggestion.*colon|suggestion.*":"|must not contain.*:/i
    );
    assert.deepEqual(session.getStateSnapshot(), before);
  }
});

test('every session field-key boundary rejects the reserved raw alias atomically', () => {
  const session = createSession();
  const suggestionId = session.addSuggestion('cell_type', 0, {
    label: 'Legal suggestion',
  });
  const reserved = 'fk~foo%3Abar';
  const before = session.getStateSnapshot();

  for (const invoke of [
    () => session.isFieldAnnotated(reserved),
    () => session.setFieldAnnotated(reserved, true),
    () => session.isFieldClosed(reserved),
    () => session.setFieldClosed(reserved, true),
    () => session.setClosedAnnotatableFields([reserved]),
    () => session.getAnnotatableConsensusSettings(reserved),
    () => session.setAnnotatableConsensusSettings(reserved, {
      minAnnotators: 1,
      threshold: 0.5,
    }),
    () => session.setAnnotatableConsensusSettingsMap({
      [reserved]: { minAnnotators: 1, threshold: 0.5 },
    }),
    () => session.toBucketKey(reserved, 'Alpha'),
    () => session.setFieldCategories(reserved, ['Alpha']),
    () => session.getSuggestions(reserved, 'Alpha'),
    () => session.addSuggestion(reserved, 'Alpha', { label: 'Alias' }),
    () => session.editMySuggestion(reserved, 'Alpha', suggestionId, {
      label: 'Alias',
    }),
    () => session.deleteMySuggestion(reserved, 'Alpha', suggestionId),
    () => session.vote(reserved, 'Alpha', suggestionId, 'up'),
    () => session.getMyVoteDirect(reserved, 'Alpha', suggestionId),
    () => session.getMyBundleVoteInfo(reserved, 'Alpha', suggestionId),
    () => session.getMyVote(reserved, 'Alpha', suggestionId),
    () => session.addComment(reserved, 'Alpha', suggestionId, 'Comment'),
    () => session.editComment(
      reserved,
      'Alpha',
      suggestionId,
      'comment-id',
      'Edit'
    ),
    () => session.deleteComment(
      reserved,
      'Alpha',
      suggestionId,
      'comment-id'
    ),
    () => session.getComments(reserved, 'Alpha', suggestionId),
    () => session.addModerationMerge({
      fieldKey: reserved,
      catIdx: 'Alpha',
      fromSuggestionId: 'from',
      intoSuggestionId: 'into',
    }),
    () => session.editModerationMergeNote({
      fieldKey: reserved,
      catIdx: 'Alpha',
      fromSuggestionId: 'from',
      note: 'Edit',
    }),
    () => session.detachModerationMerge({
      fieldKey: reserved,
      catIdx: 'Alpha',
      fromSuggestionId: 'from',
    }),
    () => session.detachLastModerationMerge({
      fieldKey: reserved,
      catIdx: 'Alpha',
      intoSuggestionId: 'into',
    }),
    () => session.computeConsensus(reserved, 'Alpha'),
  ]) {
    assert.throws(invoke, /reserved.*field-key|fieldKey.*reserved/i);
    assert.deepEqual(session.getStateSnapshot(), before);
  }

  assert.throws(
    () => session.getSuggestions(' cell_type', 0),
    /leading or trailing whitespace/i
  );
  assert.deepEqual(session.getStateSnapshot(), before);
});

test('safe suggestion lookalikes and non-suggestion identifiers retain colons', () => {
  const user = validRemoteUser();
  const suggestion = user.suggestions['cell_type:Alpha'][0];
  suggestion.id = 'suggestion%3A1';
  suggestion.ontologyId = 'CL:0000084';
  user.votes = { 'suggestion%3A1': 'up' };
  user.comments = {
    'suggestion%3A1': [{
      id: 'comment:1',
      text: 'Exact',
      authorUsername: 'ghid_7',
      createdAt: '2026-07-25T01:02:03.456Z',
    }],
  };
  user.deletedSuggestions = {
    'cell_type:Alpha': ['suggestion：fullwidth-colon'],
  };
  assert.doesNotThrow(() => assertUserDocument(user));
});

test('user export preserves a valid dangling cross-user vote before the next Pull', () => {
  const session = createSession();
  session.mergeFromUserFiles([validRemoteUser()]);
  assert.equal(
    session.vote('cell_type', 0, 'suggestion-remote', 'up'),
    true
  );

  // Local persistence intentionally stores only this user's suggestions. A
  // restored vote can therefore precede the remote suggestion inventory.
  session._state.suggestions = {};
  const document = session.buildUserFileDocument({ githubUserId: 42 });
  assert.deepEqual(document.suggestions, {});
  assert.deepEqual(document.votes, { 'suggestion-remote': 'up' });
  assert.doesNotThrow(() => assertUserDocument(document));
});


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

test('remote merge rejects every colon-bearing suggestion reference atomically', () => {
  const invalidDocuments = [];

  const definition = validRemoteUser();
  definition.suggestions['cell_type:Alpha'][0].id = 'B:C';
  invalidDocuments.push(definition);
  invalidDocuments.push(validRemoteUser({ votes: { 'B:C': 'up' } }));
  invalidDocuments.push(validRemoteUser({ comments: { 'B:C': [] } }));
  invalidDocuments.push(validRemoteUser({
    deletedSuggestions: { 'cell_type:Alpha': ['B:C'] },
  }));

  for (const document of invalidDocuments) {
    const session = createSession();
    const before = session.getStateSnapshot();
    assert.throws(
      () => session.mergeFromUserFiles([document]),
      /suggestion.*":"|must not contain.*:/i
    );
    assert.deepEqual(session.getStateSnapshot(), before);
  }
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

test('annotation identities reject every true trailing line terminator', () => {
  for (const terminator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const field = `cell_type${terminator}`;
    const config = validConfig();
    config.supportedDatasets[0].fieldsToAnnotate = [field];
    config.supportedDatasets[0].annotatableSettings = {
      [field]: { minAnnotators: 1, threshold: 0.5 },
    };
    assert.throws(() => assertConfigDocument(config), /trailing whitespace/i);

    const bucket = validRemoteUser();
    bucket.suggestions = {
      [`cell_type:Alpha${terminator}`]:
        bucket.suggestions['cell_type:Alpha'],
    };
    assert.throws(
      () => assertUserDocument(bucket),
      /edge whitespace|leading or trailing whitespace/i
    );

    const definition = validRemoteUser();
    definition.suggestions['cell_type:Alpha'][0].id =
      `suggestion${terminator}`;
    assert.throws(
      () => assertUserDocument(definition),
      /trailing whitespace/i
    );

    for (const reference of ['votes', 'comments']) {
      const document = validRemoteUser({
        [reference]: {
          [`suggestion${terminator}`]:
            reference === 'votes' ? 'up' : [],
        },
      });
      assert.throws(
        () => assertUserDocument(document),
        /trailing whitespace/i
      );
    }

    const deleted = validRemoteUser({
      deletedSuggestions: {
        'cell_type:Alpha': [`suggestion${terminator}`],
      },
    });
    assert.throws(
      () => assertUserDocument(deleted),
      /trailing whitespace/i
    );

    for (const mergeField of ['fromSuggestionId', 'intoSuggestionId']) {
      const document = validMerges();
      document.merges[0][mergeField] = `suggestion${terminator}`;
      assert.throws(
        () => assertMergesDocument(document),
        /trailing whitespace/i
      );
    }

    const session = createSession();
    assert.throws(
      () => session.setFieldCategories(field, ['Alpha']),
      /leading or trailing whitespace/i
    );
    assert.throws(
      () => session.getMyVoteDirect(
        'cell_type',
        0,
        `suggestion${terminator}`
      ),
      /leading or trailing whitespace/i
    );
  }
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

test('GitHub annotation requests compose and physically honor an owner abort signal', async () => {
  const previousFetch = globalThis.fetch;
  let requestSignal = null;
  let abortEvents = 0;
  let markStarted;
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  globalThis.fetch = async (_url, options = {}) => {
    requestSignal = options.signal;
    markStarted();
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        abortEvents += 1;
        const error = new Error('synthetic fetch abort');
        error.name = 'AbortError';
        reject(error);
      };
      if (requestSignal.aborted) rejectAbort();
      else requestSignal.addEventListener('abort', rejectAbort, { once: true });
    });
  };
  try {
    const ownerAbort = new AbortController();
    const sync = new CommunityAnnotationGitHubSync({
      datasetId: 'synthetic',
      owner: 'owner',
      repo: 'repo',
      token: 'test-token',
      branch: 'main',
      workerOrigin: 'https://worker.example',
    });
    const pending = sync.validateAndLoadConfig({
      signal: ownerAbort.signal,
    });
    await started;
    assert.notEqual(requestSignal, ownerAbort.signal);
    assert.equal(requestSignal.aborted, false);

    const rejection = assert.rejects(
      pending,
      error => {
        assert.equal(error?.name, 'AbortError');
        assert.equal(error?.code, 'GITHUB_REQUEST_ABORTED');
        assert.deepEqual(error?.github, {
          path: '/repos/owner/repo',
          method: 'GET',
        });
        return true;
      },
    );
    ownerAbort.abort(new Error('annotation context changed'));
    await rejection;
    assert.equal(requestSignal.aborted, true);
    assert.equal(abortEvents, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub annotation errors expose an exact Retry-After header', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'try later' }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': '7',
        'x-ratelimit-reset': '2000000000',
      },
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
    await assert.rejects(
      () => sync.validateAndLoadConfig(),
      error => {
        assert.equal(error?.status, 503);
        assert.equal(error?.retryAfter, '7');
        assert.equal(
          Object.hasOwn(error, 'rateLimitResetEpochSeconds'),
          false,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub retry metadata accepts only a canonical x-ratelimit-reset when Retry-After is absent', async (t) => {
  const previousFetch = globalThis.fetch;
  const createSync = () => new CommunityAnnotationGitHubSync({
    datasetId: 'synthetic',
    owner: 'owner',
    repo: 'repo',
    token: 'test-token',
    branch: 'main',
    workerOrigin: 'https://worker.example',
  });
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-reset': '2000000000',
        },
      });
    await assert.rejects(
      () => createSync().validateAndLoadConfig(),
      error => {
        assert.equal(error?.rateLimitResetEpochSeconds, 2_000_000_000);
        assert.equal(Object.hasOwn(error, 'retryAfter'), false);
        return true;
      },
    );

    await t.test(
      'present Retry-After wins even when its value is unusable',
      async () => {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: 'rate limited' }), {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': 'not-a-retry-delay',
              'x-ratelimit-reset': '2000000000',
            },
          });
        await assert.rejects(
          () => createSync().validateAndLoadConfig(),
          error => {
            assert.equal(error?.retryAfter, 'not-a-retry-delay');
            assert.equal(
              Object.hasOwn(error, 'rateLimitResetEpochSeconds'),
              false,
            );
            return true;
          },
        );
      },
    );

    for (const invalidReset of [
      '02000000000',
      '-1',
      '+2000000000',
      '2000000000.5',
      '9007199254740992',
    ]) {
      await t.test(
        `invalid reset ${JSON.stringify(invalidReset)} is ignored`,
        async () => {
          globalThis.fetch = async () =>
            new Response(JSON.stringify({ error: 'rate limited' }), {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'x-ratelimit-reset': invalidReset,
              },
            });
          await assert.rejects(
            () => createSync().validateAndLoadConfig(),
            error => {
              assert.equal(
                Object.hasOwn(error, 'rateLimitResetEpochSeconds'),
                false,
              );
              return true;
            },
          );
        },
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('unauthenticated default-branch resolution returns false without storage mutation', async () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'sessionStorage'
  );
  const values = new Map();
  let mutations = 0;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(key) {
        const exactKey = String(key);
        return values.has(exactKey) ? values.get(exactKey) : null;
      },
      setItem(key, value) {
        mutations += 1;
        values.set(String(key), String(value));
      },
      removeItem(key) {
        mutations += 1;
        values.delete(String(key));
      },
    },
  });
  try {
    assert.equal(
      await setDatasetAnnotationRepoFromUrlParamAsync({
        datasetId: 'synthetic',
        urlParamValue: 'owner/repo',
        username: 'ghid_42',
      }),
      false
    );
    assert.equal(mutations, 0);
    assert.equal(values.size, 0);
  } finally {
    if (previousDescriptor === undefined) {
      delete globalThis.sessionStorage;
    } else {
      Object.defineProperty(
        globalThis,
        'sessionStorage',
        previousDescriptor
      );
    }
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
    // A malformed persisted session is never adopted as an identity, and it is
    // discarded rather than left to fail every later construction.
    const session = new GitHubAuthSession();
    assert.equal(session.isAuthenticated(), false);
    assert.equal(session.getToken(), null);
    assert.equal(session.getUser(), null);
    assert.equal(values.has('cellucid:github-app-auth:session'), false);
  } finally {
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('unreadable persisted auth state degrades to signed out instead of failing construction', () => {
  const previousSessionStorage = globalThis.sessionStorage;
  const poisoned = [
    ['truncated JSON', '{"token":"t","user":{"id":42,"log'],
    ['empty document', ''],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['unknown session key', '{"token":"t","user":{"id":42,"login":"r"},"extra":1}'],
    ['non-positive user id', '{"token":"t","user":{"id":0,"login":"r"}}'],
    ['blank token', '{"token":"","user":{"id":42,"login":"r"}}'],
    ['unknown user key', '{"token":"t","user":{"id":42,"login":"r","legacy":true}}'],
  ];
  try {
    for (const [label, raw] of poisoned) {
      const values = new Map([['cellucid:github-app-auth:session', raw]]);
      globalThis.sessionStorage = {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(String(key), String(value)),
        removeItem: (key) => values.delete(String(key)),
      };
      const session = new GitHubAuthSession();
      assert.equal(session.isAuthenticated(), false, label);
      assert.equal(session.getToken(), null, label);
      assert.equal(
        values.has('cellucid:github-app-auth:session'),
        false,
        `${label}: the poisoned entry must be discarded so a reload recovers`
      );
      // A second construction over the same storage still succeeds: the
      // failure is not sticky.
      assert.equal(new GitHubAuthSession().isAuthenticated(), false, label);
    }

    // Storage that refuses every operation must not prevent the app from
    // starting; the feature simply has no persisted session.
    globalThis.sessionStorage = {
      getItem() { throw new DOMException('denied', 'SecurityError'); },
      setItem() { throw new DOMException('denied', 'SecurityError'); },
      removeItem() { throw new DOMException('denied', 'SecurityError'); },
    };
    const denied = new GitHubAuthSession();
    assert.equal(denied.isAuthenticated(), false);
    assert.equal(denied.getToken(), null);

    // An absent sessionStorage binding is the same class of environment fault.
    delete globalThis.sessionStorage;
    const absent = new GitHubAuthSession();
    assert.equal(absent.isAuthenticated(), false);
  } finally {
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('persisting a new GitHub session still fails loudly when storage refuses', async () => {
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  try {
    globalThis.sessionStorage = {
      getItem: () => null,
      setItem() { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem() {},
    };
    globalThis.window = {
      location: {
        href: `https://example.test/#cellucid_github_auth=1&cellucid_github_token=${'t'.repeat(8)}`,
        hash: `#cellucid_github_auth=1&cellucid_github_token=${'t'.repeat(8)}`,
        origin: 'https://example.test',
        pathname: '/',
        search: '',
        assign() {},
      },
      history: { state: null, replaceState() {} },
    };
    globalThis.fetch = async (url) => {
      const target = String(url);
      const body = target.endsWith('/auth/user')
        ? { id: 42, login: 'researcher' }
        : {
          status: 'ok',
          service: 'Cellucid GitHub Auth',
          contractVersion: 1,
          endpoints: [
            '/auth/login',
            '/auth/callback',
            '/auth/user',
            '/auth/installations',
            '/auth/installation-repos',
            '/cap/lookup-cells',
            '/cap/search-datasets',
            '/api/repos/*',
          ],
        };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const session = new GitHubAuthSession();
    await assert.rejects(
      () => session.completeSignInFromRedirect(),
      /GITHUB_AUTH_STORAGE_FAILED|sessionStorage write failed/
    );
    // The unpersistable candidate is never published as an authenticated identity.
    assert.equal(session.isAuthenticated(), false);
  } finally {
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('GitHub auth callbacks scrub every owned fragment before validation', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const replacements = [];
  const historyState = Object.freeze({ route: 'synthetic' });
  globalThis.sessionStorage = storage;
  globalThis.window = {
    location: {
      href: 'https://app.example/view?dataset=synthetic',
    },
    history: {
      state: historyState,
      replaceState(state, title, nextHref) {
        replacements.push({ state, title, nextHref });
      },
    },
  };
  const retainedBefore =
    'view=umap&duplicate=first&lower=%2f&upper=%2F' +
    '&space=%20&encoded=%7E%20&bare&&empty=';
  const retainedAfter =
    'tail=%FF&duplicate=second' +
    '&payload=cellucid_github_token%3Dnot-a-field';
  const cleanedUrl =
    `https://app.example/view?dataset=synthetic` +
    `#${retainedBefore}&${retainedAfter}`;
  const cases = [
    {
      fragment:
        'cellucid_github_auth=1&cellucid_github_token=secret-one' +
        '&cellucid_github_token=secret-two',
      error: /exactly one token or one error/,
    },
    {
      fragment:
        'cellucid_github_auth=1&cellucid_github_token=secret' +
        '&cellucid_github_error=denied',
      error: /exactly one token or one error/,
    },
    {
      fragment:
        'cellucid_github_auth=1&cellucid_github_auth=1' +
        '&cellucid_github_token=secret',
      error: /flag must occur once/,
    },
    {
      fragment:
        'cellucid_github_auth=0&cellucid_github_token=secret',
      error: /flag must occur once/,
    },
    {
      fragment: 'cellucid_github_auth=1&cellucid_github_token=',
      error: /token must be an exact nonblank string/,
    },
    {
      fragment: 'cellucid_github_auth=1&cellucid_github_error=%20denied',
      error: /error must be an exact nonblank string/,
    },
    {
      fragment: 'cellucid_github_token=secret-without-flag',
      error: /flag must occur once/,
    },
    {
      fragment: 'cellucid_github_error=denied-without-flag',
      error: /flag must occur once/,
    },
    {
      fragment: 'cellucid_github_auth=1',
      error: /exactly one token or one error/,
    },
    {
      fragment:
        'cellucid_github_auth=1&%63ellucid_github_token=encoded-secret' +
        '&cellucid_github_token=plain-secret',
      error: /exactly one token or one error/,
    },
    {
      fragment: 'cellucid_github_auth=1&cellucid_github_error=access_denied',
      error: Object.assign(/access_denied/, { code: 'GITHUB_AUTH_ERROR' }),
    },
  ];
  try {
    const auth = new GitHubAuthSession();
    for (const entry of cases) {
      const replacementCount = replacements.length;
      const callbackUrl =
        `https://app.example/view?dataset=synthetic` +
        `#${retainedBefore}&${entry.fragment}&${retainedAfter}`;
      await assert.rejects(
        () => auth.completeSignInFromRedirect({ url: callbackUrl }),
        (error) => {
          assert.match(error.message, entry.error);
          if (entry.error.code) assert.equal(error.code, entry.error.code);
          return true;
        }
      );
      assert.equal(
        replacements.length,
        replacementCount + 1,
        `callback fragment was not scrubbed for ${entry.fragment}`
      );
      assert.deepEqual(replacements.at(-1), {
        state: historyState,
        title: '',
        nextHref: cleanedUrl,
      });
      assert.equal(
        replacements.at(-1).nextHref.includes('secret'),
        false,
        'the cleaned URL must not retain a bearer token'
      );
    }

    const replacementCountBeforeEmpty = replacements.length;
    await assert.rejects(
      () =>
        auth.completeSignInFromRedirect({
          url:
            'https://app.example/view?dataset=synthetic' +
            '#&cellucid_github_auth=1' +
            '&cellucid_github_error=access_denied',
        }),
      { code: 'GITHUB_AUTH_ERROR' }
    );
    assert.equal(
      replacements.length,
      replacementCountBeforeEmpty + 1
    );
    assert.deepEqual(replacements.at(-1), {
      state: historyState,
      title: '',
      nextHref: 'https://app.example/view?dataset=synthetic#',
    });

    const replacementCount = replacements.length;
    assert.equal(
      await auth.completeSignInFromRedirect({
        url:
          `https://app.example/view?dataset=synthetic` +
          `#${retainedBefore}&${retainedAfter}`,
      }),
      null
    );
    assert.equal(
      replacements.length,
      replacementCount,
      'unowned fragment state must not rewrite browser history'
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('GitHub sign-in verifies the exact current Worker before navigation and preserves unrelated hash state', async () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const assignments = [];
  const requests = [];
  globalThis.sessionStorage = storage;
  globalThis.window = {
    location: {
      origin: 'https://app.example',
      pathname: '/view',
      search: '?dataset=synthetic',
      hash:
        '#view=umap&cellucid_github_auth=1&' +
        'cellucid_github_token=stale&panel=genes',
      assign(url) {
        assignments.push(url);
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      status: 'ok',
      service: 'Cellucid GitHub Auth',
      contractVersion: 1,
      endpoints: [
        '/auth/login',
        '/auth/callback',
        '/auth/user',
        '/auth/installations',
        '/auth/installation-repos',
        '/cap/lookup-cells',
        '/cap/search-datasets',
        '/api/repos/*',
      ],
    }), { status: 200 });
  };
  try {
    const auth = new GitHubAuthSession();
    const navigation = await auth.signIn();
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0], navigation);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, '/');
    assert.equal(
      Object.hasOwn(requests[0].options.headers ?? {}, 'Authorization'),
      false
    );
    const loginUrl = new URL(assignments[0]);
    assert.equal(loginUrl.pathname, '/auth/login');
    assert.equal(
      loginUrl.searchParams.get('return_to'),
      'https://app.example/view?dataset=synthetic#view=umap&panel=genes'
    );
    assert.equal(assignments[0].includes('stale'), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('stale Worker capabilities fail before OAuth navigation or token exposure', async () => {
  const storage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const assignments = [];
  let authorizationObserved = false;
  globalThis.sessionStorage = storage;
  globalThis.window = {
    location: {
      origin: 'https://app.example',
      pathname: '/view',
      search: '',
      hash: '',
      assign(url) {
        assignments.push(url);
      },
    },
  };
  globalThis.fetch = async (_url, options) => {
    authorizationObserved =
      Object.hasOwn(options.headers ?? {}, 'Authorization');
    return new Response(JSON.stringify({
      status: 'ok',
      service: 'Cellucid GitHub Auth',
      contractVersion: 0,
      endpoints: [
        '/auth/login',
        '/auth/callback',
        '/auth/user',
        '/auth/installations',
        '/auth/installation-repos',
        '/cap/lookup-cells',
        '/cap/search-datasets',
        '/api/repos/*',
      ],
    }), { status: 200 });
  };
  try {
    const auth = new GitHubAuthSession();
    await assert.rejects(
      () => auth.signIn(),
      error =>
        error?.code === 'GITHUB_WORKER_INCOMPATIBLE' &&
        /Deploy the current Cellucid Worker/.test(error.message)
    );
    assert.deepEqual(assignments, []);
    assert.equal(authorizationObserved, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('chunked oversized Worker health responses are cancelled before trust or navigation', async () => {
  const storage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const assignments = [];
  let cancelled = false;
  globalThis.sessionStorage = storage;
  globalThis.window = {
    location: {
      origin: 'https://app.example',
      pathname: '/',
      search: '',
      hash: '',
      assign(url) {
        assignments.push(url);
      },
    },
  };
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(10_000));
        controller.enqueue(new Uint8Array(10_000));
      },
    }),
    { status: 200 }
  );
  try {
    const auth = new GitHubAuthSession();
    await assert.rejects(
      () => auth.signIn(),
      error =>
        error?.code === 'GITHUB_WORKER_INCOMPATIBLE' &&
        error?.cause?.code === 'GITHUB_AUTH_RESPONSE_TOO_LARGE'
    );
    assert.equal(cancelled, true);
    assert.deepEqual(assignments, []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('Worker health trust failures cancel known oversize and invalid UTF-8 bodies', async (t) => {
  async function runSignIn(fetchImpl, verify) {
    const previousSessionStorage = globalThis.sessionStorage;
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    const assignments = [];
    globalThis.sessionStorage = {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    globalThis.window = {
      location: {
        origin: 'https://app.example',
        pathname: '/',
        search: '',
        hash: '',
        assign(url) {
          assignments.push(url);
        },
      },
    };
    globalThis.fetch = fetchImpl;
    try {
      const auth = new GitHubAuthSession();
      await verify(auth);
      assert.deepEqual(assignments, []);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousSessionStorage === undefined) {
        delete globalThis.sessionStorage;
      } else {
        globalThis.sessionStorage = previousSessionStorage;
      }
    }
  }

  await t.test('known oversized Content-Length', async () => {
    let cancelled = false;
    let readerOpened = false;
    await runSignIn(
      async () => ({
        status: 200,
        ok: true,
        headers: {
          get(name) {
            return name.toLowerCase() === 'content-length'
              ? '16385'
              : null;
          },
        },
        body: {
          async cancel() {
            cancelled = true;
          },
          getReader() {
            readerOpened = true;
            throw new Error('known oversized body reader must not open');
          },
        },
      }),
      auth => assert.rejects(
        () => auth.signIn(),
        error =>
          error?.code === 'GITHUB_WORKER_INCOMPATIBLE' &&
          error?.cause?.code === 'GITHUB_AUTH_RESPONSE_TOO_LARGE'
      )
    );
    assert.equal(cancelled, true);
    assert.equal(readerOpened, false);
  });

  await t.test('invalid UTF-8', async () => {
    let cancelled = false;
    await runSignIn(
      async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              async read() {
                return {
                  done: false,
                  value: new Uint8Array([0xc3, 0x28]),
                };
              },
              async cancel() {
                cancelled = true;
              },
              releaseLock() {},
            };
          },
        },
      }),
      auth => assert.rejects(
        () => auth.signIn(),
        error =>
          error?.code === 'GITHUB_WORKER_INCOMPATIBLE' &&
          error?.cause?.code === 'GITHUB_AUTH_RESPONSE_INVALID'
      )
    );
    assert.equal(cancelled, true);
  });

  await t.test('caller abort cancels the active response reader', async () => {
    let cancelled = false;
    let markReaderStarted;
    const readerStarted = new Promise(resolve => {
      markReaderStarted = resolve;
    });
    await runSignIn(
      async (_url, options) => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              read() {
                markReaderStarted();
                return new Promise((resolve, reject) => {
                  options.signal.addEventListener('abort', () => {
                    reject(new DOMException(
                      'Synthetic Worker health read aborted',
                      'AbortError'
                    ));
                  }, { once: true });
                });
              },
              async cancel() {
                cancelled = true;
              },
              releaseLock() {},
            };
          },
        },
      }),
      async auth => {
        const caller = new AbortController();
        const pending = auth.signIn({ signal: caller.signal });
        await readerStarted;
        const reason = new Error('caller retired Worker health ownership');
        caller.abort(reason);
        await assert.rejects(
          () => pending,
          error => error?.code === 'GITHUB_REQUEST_ABORTED'
        );
      }
    );
    assert.equal(cancelled, true);
  });

  await t.test('response read failure cancels the active reader', async () => {
    let cancelled = false;
    const readFailure = new Error('synthetic Worker health read failure');
    await runSignIn(
      async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              async read() {
                throw readFailure;
              },
              async cancel() {
                cancelled = true;
              },
              releaseLock() {},
            };
          },
        },
      }),
      auth => assert.rejects(
        () => auth.signIn(),
        error =>
          error?.code === 'GITHUB_WORKER_INCOMPATIBLE' &&
          error?.cause === readFailure
      )
    );
    assert.equal(cancelled, true);
  });
});

test('GitHub capability setup retires abort listeners when timer creation fails', async () => {
  const storage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const signalPrototype = Object.getPrototypeOf(new AbortController().signal);
  const previousAddEventListener = signalPrototype.addEventListener;
  const previousRemoveEventListener = signalPrototype.removeEventListener;
  const activeAbortListeners = new Map();
  let fetchCalls = 0;
  const setupFailure = new Error('synthetic timer creation failure');

  signalPrototype.addEventListener = function (type, listener, options) {
    if (type === 'abort') {
      const listeners = activeAbortListeners.get(this) ?? new Set();
      listeners.add(listener);
      activeAbortListeners.set(this, listeners);
    }
    return previousAddEventListener.call(this, type, listener, options);
  };
  signalPrototype.removeEventListener = function (type, listener, options) {
    if (type === 'abort') {
      activeAbortListeners.get(this)?.delete(listener);
    }
    return previousRemoveEventListener.call(this, type, listener, options);
  };
  globalThis.sessionStorage = storage;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };
  globalThis.setTimeout = () => {
    throw setupFailure;
  };

  try {
    const auth = new GitHubAuthSession();
    const caller = new AbortController();
    await assert.rejects(
      () => auth.ensureWorkerCompatible({ signal: caller.signal }),
      error =>
        error?.code === 'GITHUB_WORKER_INCOMPATIBLE' &&
        error?.cause === setupFailure
    );
    assert.equal(fetchCalls, 0);
    for (const listeners of activeAbortListeners.values()) {
      assert.equal(listeners.size, 0);
    }
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.fetch = previousFetch;
    signalPrototype.addEventListener = previousAddEventListener;
    signalPrototype.removeEventListener = previousRemoveEventListener;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('OAuth callback proves Worker capabilities before exposing its candidate token', async () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.sessionStorage = storage;
  globalThis.window = {
    location: {
      href: 'https://app.example/',
    },
    history: {
      state: null,
      replaceState() {},
    },
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({
      authorization: options.headers?.Authorization ?? null,
      path,
    });
    if (path === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'Cellucid GitHub Auth',
        contractVersion: 1,
        endpoints: [
          '/auth/login',
          '/auth/callback',
          '/auth/user',
          '/auth/installations',
          '/auth/installation-repos',
          '/cap/lookup-cells',
          '/cap/search-datasets',
          '/api/repos/*',
        ],
      }), { status: 200 });
    }
    return new Response(
      '{"id":42,"login":"researcher"}',
      { status: 200 }
    );
  };
  try {
    const auth = new GitHubAuthSession();
    await auth.completeSignInFromRedirect({
      url:
        'https://app.example/' +
        '#cellucid_github_auth=1&cellucid_github_token=candidate-token',
    });
    assert.deepEqual(requests, [
      { path: '/', authorization: null },
      { path: '/auth/user', authorization: 'Bearer candidate-token' },
    ]);
    assert.equal(auth.getToken(), 'candidate-token');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('restored GitHub sessions prove Worker capabilities before token-bearing refresh', async () => {
  const values = new Map([[
    'cellucid:github-app-auth:session',
    '{"token":"restored-token","user":{"id":42,"login":"researcher"}}',
  ]]);
  const storage = {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.sessionStorage = storage;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({
      authorization: options.headers?.Authorization ?? null,
      path,
    });
    if (path === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'Cellucid GitHub Auth',
        contractVersion: 1,
        endpoints: [
          '/auth/login',
          '/auth/callback',
          '/auth/user',
          '/auth/installations',
          '/auth/installation-repos',
          '/cap/lookup-cells',
          '/cap/search-datasets',
          '/api/repos/*',
        ],
      }), { status: 200 });
    }
    return new Response(
      '{"id":42,"login":"researcher"}',
      { status: 200 }
    );
  };
  try {
    const auth = new GitHubAuthSession();
    await auth.fetchUser();
    assert.deepEqual(requests, [
      { path: '/', authorization: null },
      { path: '/auth/user', authorization: 'Bearer restored-token' },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('overlapping GitHub sign-in preflights are generation-owned and caller-abortable', async () => {
  const storage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const assignments = [];
  const requests = [];
  globalThis.sessionStorage = storage;
  globalThis.window = {
    location: {
      origin: 'https://app.example',
      pathname: '/',
      search: '',
      hash: '',
      assign(url) {
        assignments.push(url);
      },
    },
  };
  globalThis.fetch = (_url, options) => {
    let resolve;
    let reject;
    const promise = new Promise((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    options.signal.addEventListener('abort', () => {
      const error = new Error('synthetic preflight abort');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
    requests.push({ options, promise, reject, resolve });
    return promise;
  };
  const liveResponse = () => new Response(JSON.stringify({
    status: 'ok',
    service: 'Cellucid GitHub Auth',
    contractVersion: 1,
    endpoints: [
      '/auth/login',
      '/auth/callback',
      '/auth/user',
      '/auth/installations',
      '/auth/installation-repos',
      '/cap/lookup-cells',
      '/cap/search-datasets',
      '/api/repos/*',
    ],
  }), { status: 200 });
  try {
    const auth = new GitHubAuthSession();
    const first = auth.signIn();
    const second = auth.signIn();
    assert.equal(requests[0].options.signal.aborted, true);
    requests[1].resolve(liveResponse());
    await second;
    await assert.rejects(first, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    assert.equal(assignments.length, 1);

    const authAfterNavigation = new GitHubAuthSession();
    const controller = new AbortController();
    const cancelled = authAfterNavigation.signIn({
      signal: controller.signal,
    });
    controller.abort('user cancelled');
    await assert.rejects(cancelled, {
      code: 'GITHUB_REQUEST_ABORTED',
    });
    assert.equal(assignments.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
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
  const previousSessionStorage = globalThis.sessionStorage;
  const previousLocalStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = sessionStore;
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('GitHub auth must not read localStorage');
    },
    setItem: () => {
      throw new Error('GitHub auth must not write localStorage');
    },
    removeItem: () => {
      throw new Error('GitHub auth must not remove localStorage');
    },
  };
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
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
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

test('GitHub auth generations fence overlapping token adoption and sign-out', async () => {
  const makeStorage = (entries = []) => {
    const values = new Map(entries);
    return {
      values,
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(String(key), String(value)),
      removeItem: (key) => values.delete(String(key)),
    };
  };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const sessionStore = makeStorage();
  const localStore = makeStorage();
  const previousSessionStorage = globalThis.sessionStorage;
  const previousLocalStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = sessionStore;
  globalThis.localStorage = localStore;
  const requests = new Map();
  globalThis.fetch = (_url, options) => {
    const token = options.headers.Authorization.slice('Bearer '.length);
    const request = deferred();
    requests.set(token, { ...request, signal: options.signal });
    return request.promise;
  };
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const first = auth._acceptToken('token-a');
    const second = auth._acceptToken('token-b');
    assert.equal(
      requests.get('token-a').signal.aborted,
      true,
      'adopting token B must cancel token A transport'
    );

    requests.get('token-b').resolve(
      new Response('{"id":202,"login":"user-b"}', { status: 200 })
    );
    const secondResult = await second;
    secondResult.user.login = 'mutated-result';
    assert.deepEqual(
      auth.getUser(),
      { id: 202, login: 'user-b' },
      'token adoption results must not expose the authoritative identity'
    );
    requests.get('token-a').resolve(
      new Response('{"id":101,"login":"user-a"}', { status: 200 })
    );
    await assert.rejects(first, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    assert.equal(auth.getToken(), 'token-b');
    assert.deepEqual(auth.getUser(), { id: 202, login: 'user-b' });
    assert.deepEqual(
      parseExactJson(
        sessionStore.values.get('cellucid:github-app-auth:session')
      ),
      {
        token: 'token-b',
        user: { id: 202, login: 'user-b' },
      }
    );

    let emittedUser = null;
    auth.on('changed', (event) => {
      if (event.user === null) return;
      emittedUser = event.user;
      event.user.login = 'mutated-event';
    });
    let secondListenerLogin = null;
    auth.on('changed', (event) => {
      if (event.user !== null) secondListenerLogin = event.user.login;
    });
    const staleFailure = auth._acceptToken('token-c');
    const current = auth._acceptToken('token-d');
    requests.get('token-d').resolve(
      new Response('{"id":404,"login":"user-d"}', { status: 200 })
    );
    await current;
    assert.equal(emittedUser?.login, 'mutated-event');
    assert.equal(
      secondListenerLogin,
      'user-d',
      'each changed listener must receive an isolated identity projection'
    );
    assert.deepEqual(
      auth.getUser(),
      { id: 404, login: 'user-d' },
      'changed events must not expose the authoritative identity'
    );
    requests.get('token-c').reject(new TypeError('stale network failure'));
    await assert.rejects(staleFailure, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    assert.equal(auth.getToken(), 'token-d');
    assert.deepEqual(auth.getUser(), { id: 404, login: 'user-d' });

    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const discoveryAbort = new AbortController();
    const discovery = auth.listInstallations({
      signal: discoveryAbort.signal,
    });
    const discoveryRequest = requests.get('token-d');
    discoveryAbort.abort();
    assert.equal(
      discoveryRequest.signal.aborted,
      true,
      'caller cancellation must reach repository discovery transport'
    );
    discoveryRequest.resolve(
      new Response('{"installations":[]}', { status: 200 })
    );
    await assert.rejects(discovery, {
      code: 'GITHUB_REQUEST_ABORTED',
    });
    assert.equal(auth.isAuthenticated(), true);
    assert.deepEqual(auth.getUser(), { id: 404, login: 'user-d' });

    const changed = [];
    auth.on('changed', (event) => changed.push(event));
    const refresh = auth.fetchUser();
    const refreshRequest = requests.get('token-d');
    auth.signOut();
    assert.equal(
      refreshRequest.signal.aborted,
      true,
      'sign-out must cancel the current profile transport'
    );
    refreshRequest.resolve(
      new Response('{"id":404,"login":"user-d"}', { status: 200 })
    );
    await assert.rejects(refresh, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    assert.equal(auth.getToken(), null);
    assert.equal(auth.getUser(), null);
    assert.equal(auth.isAuthenticated(), false);
    assert.equal(
      sessionStore.values.has('cellucid:github-app-auth:session'),
      false
    );
    assert.deepEqual(changed, [{ token: null, user: null }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('candidate authentication exclusively owns its transition generation', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token-a","user":{"id":101,"login":"user-a"}}',
    ],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  };
  const requests = [];
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = storage;
  globalThis.fetch = (url, options) => {
    const request = deferred();
    requests.push({
      ...request,
      path: new URL(url).pathname,
      signal: options.signal,
      token: options.headers.Authorization.slice('Bearer '.length),
    });
    return request.promise;
  };
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const adoption = auth._acceptToken('token-b');
    const refresh = auth.fetchUser();
    const discovery = auth.listInstallations();
    const candidateRequest = requests.find(
      (request) => request.path === '/auth/user' && request.token === 'token-b'
    );
    const refreshRequest = requests.find(
      (request) => request.path === '/auth/user' && request.token === 'token-a'
    );
    const discoveryRequest = requests.find(
      (request) =>
        request.path === '/auth/installations' &&
        request.token === 'token-a'
    );

    candidateRequest.resolve(
      new Response('{"id":202,"login":"user-b"}', { status: 200 })
    );
    await adoption;
    assert.equal(
      refreshRequest.signal.aborted,
      true,
      'candidate publication must retire prior-account profile work'
    );
    assert.equal(
      discoveryRequest.signal.aborted,
      true,
      'candidate publication must retire prior-account discovery work'
    );

    refreshRequest.resolve(
      new Response('{"id":101,"login":"user-a"}', { status: 200 })
    );
    discoveryRequest.resolve(
      new Response('{"installations":[]}', { status: 200 })
    );
    await assert.rejects(refresh, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    await assert.rejects(discovery, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    assert.equal(auth.getToken(), 'token-b');
    assert.deepEqual(auth.getUser(), { id: 202, login: 'user-b' });
    assert.deepEqual(
      parseExactJson(values.get('cellucid:github-app-auth:session')),
      {
        token: 'token-b',
        user: { id: 202, login: 'user-b' },
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('reentrant abort listeners cannot publish a retired auth candidate', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token-a","user":{"id":101,"login":"user-a"}}',
    ],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const requests = [];
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = storage;
  let auth;
  globalThis.fetch = (url, options) => {
    const request = deferred();
    const path = new URL(url).pathname;
    if (path === '/auth/installations') {
      options.signal.addEventListener('abort', () => auth.signOut(), {
        once: true,
      });
    }
    options.signal.addEventListener('abort', () => {
      const error = new Error('synthetic transport abort');
      error.name = 'AbortError';
      request.reject(error);
    }, { once: true });
    requests.push({
      ...request,
      path,
      token: options.headers.Authorization.slice('Bearer '.length),
    });
    return request.promise;
  };
  try {
    auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const changed = [];
    auth.on('changed', (event) => changed.push(event));
    const adoption = auth._acceptToken('token-b');
    const discovery = auth.listInstallations();
    const candidateRequest = requests.find(
      (request) => request.path === '/auth/user' && request.token === 'token-b'
    );
    candidateRequest.resolve(
      new Response('{"id":202,"login":"user-b"}', { status: 200 })
    );

    await assert.rejects(adoption, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    await assert.rejects(discovery, {
      code: 'GITHUB_AUTH_SUPERSEDED',
    });
    assert.equal(auth.getToken(), null);
    assert.equal(auth.getUser(), null);
    assert.equal(auth.isAuthenticated(), false);
    assert.equal(values.has('cellucid:github-app-auth:session'), false);
    assert.deepEqual(changed, [{ token: null, user: null }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('reentrant changed-listener sign-out supersedes login without recursion', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = storage;
  globalThis.fetch = async () =>
    new Response('{"id":202,"login":"user-b"}', { status: 200 });
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const events = [];
    auth.on('changed', (event) => {
      events.push(event.user?.login ?? null);
      auth.signOut();
    });

    await assert.rejects(
      () => auth._acceptToken('token-b'),
      { code: 'GITHUB_AUTH_SUPERSEDED' }
    );
    assert.deepEqual(events, ['user-b', null]);
    assert.equal(auth.getToken(), null);
    assert.equal(auth.getUser(), null);
    assert.equal(auth.isAuthenticated(), false);
    assert.equal(values.has('cellucid:github-app-auth:session'), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('changed-listener failures are reported without rewriting auth outcome', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const reported = [];
  const listenerFailure = new Error('synthetic changed-listener failure');
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  const previousReportError = globalThis.reportError;
  globalThis.sessionStorage = storage;
  globalThis.reportError = (error) => reported.push(error);
  globalThis.fetch = async () =>
    new Response('{"id":202,"login":"user-b"}', { status: 200 });
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    let laterListenerLogin = null;
    auth.on('changed', () => {
      throw listenerFailure;
    });
    auth.on('changed', (event) => {
      laterListenerLogin = event.user?.login ?? null;
    });

    const result = await auth._acceptToken('token-b');
    assert.deepEqual(result, {
      token: 'token-b',
      user: { id: 202, login: 'user-b' },
    });
    assert.equal(laterListenerLogin, 'user-b');
    assert.deepEqual(reported, [listenerFailure]);
    assert.equal(auth.getToken(), 'token-b');
    assert.deepEqual(auth.getUser(), { id: 202, login: 'user-b' });
    assert.deepEqual(
      parseExactJson(values.get('cellucid:github-app-auth:session')),
      {
        token: 'token-b',
        user: { id: 202, login: 'user-b' },
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousReportError === undefined) delete globalThis.reportError;
    else globalThis.reportError = previousReportError;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('GitHub auth observes caller cancellation at the final publication boundary', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token-a","user":{"id":101,"login":"user-a"}}',
    ],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const controller = new AbortController();
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = storage;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (!sent) {
              sent = true;
              return {
                done: false,
                value: new TextEncoder().encode(
                  '{"id":101,"login":"renamed-user-a"}'
                ),
              };
            }
            controller.abort();
            return { done: true, value: undefined };
          },
          releaseLock() {},
        };
      },
    },
  });
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    await assert.rejects(
      () => auth.fetchUser({ signal: controller.signal }),
      { code: 'GITHUB_REQUEST_ABORTED' }
    );
    assert.equal(auth.getToken(), 'token-a');
    assert.deepEqual(auth.getUser(), { id: 101, login: 'user-a' });
    assert.deepEqual(
      parseExactJson(values.get('cellucid:github-app-auth:session')),
      {
        token: 'token-a',
        user: { id: 101, login: 'user-a' },
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('GitHub auth request cancellation preserves the first abort cause', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token-a","user":{"id":101,"login":"user-a"}}',
    ],
  ]);
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
  const timers = [];
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  globalThis.sessionStorage = storage;
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          const error = new Error('synthetic transport abort');
          error.name = 'AbortError';
          reject(error);
        });
      }, { once: true });
    });
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();

    const timeoutThenCaller = new AbortController();
    const timeoutFirst = auth.listInstallations({
      signal: timeoutThenCaller.signal,
    });
    timers[0]();
    timeoutThenCaller.abort();
    await assert.rejects(timeoutFirst, {
      code: 'TIMEOUT',
    });

    const callerThenTimeout = new AbortController();
    const callerFirst = auth.listInstallations({
      signal: callerThenTimeout.signal,
    });
    callerThenTimeout.abort();
    timers[1]();
    await assert.rejects(callerFirst, {
      code: 'GITHUB_REQUEST_ABORTED',
    });
    assert.equal(auth.isAuthenticated(), true);
    assert.deepEqual(auth.getUser(), { id: 101, login: 'user-a' });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('GitHub auth publishes only storage-durable generations', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token-a","user":{"id":101,"login":"user-a"}}',
    ],
  ]);
  let failSet = false;
  let failRemove = false;
  const sessionStore = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
      if (failSet) throw new Error('synthetic session write failure');
      values.set(String(key), String(value));
    },
    removeItem: (key) => {
      if (failRemove) throw new Error('synthetic session remove failure');
      values.delete(String(key));
    },
  };
  const localStore = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const previousSessionStorage = globalThis.sessionStorage;
  const previousLocalStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = sessionStore;
  globalThis.localStorage = localStore;
  globalThis.fetch = async (_url, options) => {
    const token = options.headers.Authorization.slice('Bearer '.length);
    if (token !== 'token-b') {
      throw new Error(`Unexpected token: ${token}`);
    }
    return new Response('{"id":202,"login":"user-b"}', { status: 200 });
  };
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    const changed = [];
    auth.on('changed', (event) => changed.push(event));

    failSet = true;
    await assert.rejects(
      () => auth._acceptToken('token-b'),
      { code: 'GITHUB_AUTH_STORAGE_FAILED' }
    );
    assert.equal(auth.getToken(), 'token-a');
    assert.deepEqual(auth.getUser(), { id: 101, login: 'user-a' });
    assert.equal(auth.isAuthenticated(), true);
    assert.deepEqual(
      parseExactJson(values.get('cellucid:github-app-auth:session')),
      {
        token: 'token-a',
        user: { id: 101, login: 'user-a' },
      }
    );
    assert.deepEqual(changed, []);

    failSet = false;
    await auth._acceptToken('token-b');
    assert.equal(auth.getToken(), 'token-b');
    assert.deepEqual(auth.getUser(), { id: 202, login: 'user-b' });
    assert.equal(changed.length, 1);

    failRemove = true;
    assert.throws(
      () => auth.signOut(),
      { code: 'GITHUB_AUTH_STORAGE_FAILED' }
    );
    assert.equal(auth.getToken(), 'token-b');
    assert.deepEqual(auth.getUser(), { id: 202, login: 'user-b' });
    assert.equal(auth.isAuthenticated(), true);
    assert.deepEqual(
      parseExactJson(values.get('cellucid:github-app-auth:session')),
      {
        token: 'token-b',
        user: { id: 202, login: 'user-b' },
      }
    );
    assert.equal(changed.length, 1);

    failRemove = false;
    auth.signOut();
    assert.equal(auth.getToken(), null);
    assert.equal(auth.getUser(), null);
    assert.equal(values.has('cellucid:github-app-auth:session'), false);
    assert.deepEqual(changed.at(-1), { token: null, user: null });
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

    const ipv6Location = new URL('http://[::1]:8000/cellucid/');
    globalThis.window.location = {
      hostname: ipv6Location.hostname,
      protocol: ipv6Location.protocol,
    };
    globalThis.window.__CELLUCID_GITHUB_WORKER_ORIGIN__ =
      'http://[::1]:8787';
    assert.equal(ipv6Location.hostname, '[::1]');
    assert.equal(getGitHubWorkerOrigin(), 'http://[::1]:8787');

    const localhostSubdomain =
      new URL('http://viewer.localhost:8000/cellucid/');
    globalThis.window.location = {
      hostname: localhostSubdomain.hostname,
      protocol: localhostSubdomain.protocol,
    };
    globalThis.window.__CELLUCID_GITHUB_WORKER_ORIGIN__ =
      'http://auth.localhost:8787';
    assert.equal(
      getGitHubWorkerOrigin(),
      'http://auth.localhost:8787'
    );

    const ipv4Loopback =
      new URL('http://127.23.45.67:8000/cellucid/');
    globalThis.window.location = {
      hostname: ipv4Loopback.hostname,
      protocol: ipv4Loopback.protocol,
    };
    globalThis.window.__CELLUCID_GITHUB_WORKER_ORIGIN__ =
      'http://127.0.0.1:8787';
    assert.equal(
      getGitHubWorkerOrigin(),
      'http://127.0.0.1:8787'
    );
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
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
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

test('GitHub installation discovery bounds every client-side collection', async () => {
  const values = new Map([
    [
      'cellucid:github-app-auth:session',
      '{"token":"token","user":{"id":42,"login":"researcher"}}',
    ],
  ]);
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const installations = Array.from({ length: 10_001 }, (_, index) => ({
    id: index + 1,
    account: { login: `owner-${index}` },
  }));
  const repositories = Array.from({ length: 10_001 }, (_, index) => ({
    id: index + 1,
    full_name: `owner/repository-${index}`,
    private: false,
  }));
  const previousSessionStorage = globalThis.sessionStorage;
  const previousFetch = globalThis.fetch;
  globalThis.sessionStorage = storage;
  globalThis.fetch = async url => new Response(
    JSON.stringify(
      String(url).endsWith('/auth/installations')
        ? { installations }
        : { repositories }
    ),
    { status: 200 }
  );
  try {
    const auth = new GitHubAuthSession();
    auth._verifiedWorkerOrigin = auth.getWorkerOrigin();
    await assert.rejects(
      () => auth.listInstallations(),
      /array of at most 10000 items/
    );
    await assert.rejects(
      () => auth.listInstallationRepos(7),
      /array of at most 10000 items/
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
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

test('local persistence rejects ambiguous compound vote keys before applying state', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  const scope = {
    datasetId: 'identity-contract',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const key = toSessionStorageKey(scope);
  const producer = new CommunityAnnotationSession();
  try {
    producer.setCacheContext(scope);
    producer.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
    });
    producer.setFieldCategories('cell_type', ['Alpha']);
    producer.addSuggestion('cell_type', 0, { label: 'Local' });
    producer._saveNow();

    const payload = parseExactJson(values.get(key));
    payload.suggestions['cell_type:Alpha'][0].id = 'C';
    payload.myVotes = {
      // If an ID containing ":" were parsed by the old last-delimiter rule,
      // this would silently move B:C from Alpha to legal id C in Alpha:B.
      'cell_type:Alpha:B:C': 'up',
    };
    values.set(key, JSON.stringify(payload));
    producer._scopeLock.release();

    const consumer = new CommunityAnnotationSession();
    const before = consumer.getStateSnapshot();
    assert.throws(
      () => consumer.setCacheContext(scope),
      error => (
        error?.code === 'LOCAL_ANNOTATION_STATE_INVALID' &&
        /does not reference.*exact bucket/i.test(error.message)
      )
    );
    assert.deepEqual(consumer.getStateSnapshot(), before);
    assert.equal(consumer.getDatasetId(), null);
    assert.equal(consumer.getRepoRef(), null);
    assert.equal(consumer.getCacheUserId(), null);
    consumer._scopeLock.release();

    const suggestion = payload.suggestions['cell_type:Alpha'][0];
    payload.suggestions = {
      'cell_type:Alpha:B': [suggestion],
    };
    payload.myVotes = {
      'cell_type:Alpha:B:C': 'up',
    };
    values.set(key, JSON.stringify(payload));

    const accepted = new CommunityAnnotationSession();
    accepted.setCacheContext(scope);
    assert.equal(accepted.getSuggestions('cell_type', 'Alpha:B')[0].id, 'C');
    assert.equal(
      accepted.getMyVoteDirect('cell_type', 'Alpha:B', 'C'),
      'up'
    );
    accepted._scopeLock.release();
  } finally {
    producer._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
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
    assert.deepEqual(session.getStateSnapshot(), before);
    assert.equal(session.getDatasetId(), null);
    assert.equal(session.getRepoRef(), null);
    assert.equal(session.getCacheUserId(), null);
  } finally {
    session._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('local persistence read failures restore the complete previous cache scope', () => {
  const values = new Map();
  const workingStorage = {
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = workingStorage;
  globalThis.sessionStorage = workingStorage;

  const initialScope = {
    datasetId: 'read-failure-before',
    repoRef: 'owner/before@main',
    userId: 42,
  };
  const rejectedScope = {
    datasetId: 'read-failure-after',
    repoRef: 'owner/after@main',
    userId: 42,
  };
  const rejectedKey = toSessionStorageKey(rejectedScope);
  const session = new CommunityAnnotationSession();
  try {
    session.setCacheContext(initialScope);
    session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
    });
    session.setFieldCategories('cell_type', ['Alpha']);
    session.addSuggestion('cell_type', 0, { label: 'Before' });
    session._saveNow();
    const before = session.getStateSnapshot();

    globalThis.localStorage = {
      ...workingStorage,
      getItem: key => {
        if (String(key) === rejectedKey) {
          throw new Error('storage access denied');
        }
        return workingStorage.getItem(key);
      },
    };
    assert.throws(
      () => session.setCacheContext(rejectedScope),
      error =>
        error?.code === 'LOCAL_ANNOTATION_PERSISTENCE_FAILED' &&
        error?.cause?.message === 'storage access denied'
    );

    assert.equal(session.getDatasetId(), initialScope.datasetId);
    assert.equal(session.getRepoRef(), initialScope.repoRef);
    assert.equal(session.getCacheUserId(), initialScope.userId);
    assert.deepEqual(session.getStateSnapshot(), before);
    assert.equal(
      session._scopeLock.isHolding(toCacheScopeKey(initialScope)),
      true
    );
    assert.doesNotThrow(() => session.setCacheContext(initialScope));
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

test('a throwing cache-lock restoration preserves the primary load failure and prior logical generation', () => {
  const values = new Map();
  const workingStorage = {
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.localStorage = workingStorage;
  globalThis.sessionStorage = workingStorage;
  const initialScope = {
    datasetId: 'restore-throw-before',
    repoRef: 'owner/before@main',
    userId: 42,
  };
  const rejectedScope = {
    datasetId: 'restore-throw-after',
    repoRef: 'owner/after@main',
    userId: 42,
  };
  const initialScopeKey = toCacheScopeKey(initialScope);
  const rejectedKey = toSessionStorageKey(rejectedScope);
  const session = new CommunityAnnotationSession();
  const originalSetScopeKey = session._scopeLock.setScopeKey.bind(
    session._scopeLock
  );
  try {
    session.setCacheContext(initialScope);
    session.setProfile({
      username: 'ghid_42',
      githubUserId: 42,
      login: 'researcher',
    });
    const before = session.getStateSnapshot();
    globalThis.localStorage = {
      ...workingStorage,
      getItem: key => {
        if (String(key) === rejectedKey) {
          throw new Error('primary read failure');
        }
        return workingStorage.getItem(key);
      },
    };
    const restoreFailure = new Error('hostile restoration failure');
    session._scopeLock.setScopeKey = scopeKey => {
      if (scopeKey === initialScopeKey) throw restoreFailure;
      return originalSetScopeKey(scopeKey);
    };

    assert.throws(
      () => session.setCacheContext(rejectedScope),
      error => {
        assert.equal(error?.code, 'LOCAL_ANNOTATION_PERSISTENCE_FAILED');
        assert.equal(error?.cause?.message, 'primary read failure');
        assert.equal(
          error?.restorationFailure?.cause,
          restoreFailure
        );
        return true;
      }
    );
    assert.equal(session.getDatasetId(), initialScope.datasetId);
    assert.equal(session.getRepoRef(), initialScope.repoRef);
    assert.equal(session.getCacheUserId(), initialScope.userId);
    assert.deepEqual(session.getStateSnapshot(), before);
    assert.equal(session._lockScopeKey, null);
    assert.equal(session._persistenceOk, false);
  } finally {
    if (session._saveTimer) clearTimeout(session._saveTimer);
    session._scopeLock.setScopeKey = originalSetScopeKey;
    globalThis.localStorage = workingStorage;
    session._scopeLock.release();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSessionStorage;
  }
});

test('consensus ranking is invariant to suggestion iteration order', () => {
  const session = createSession();
  const bucket = 'cell_type:Alpha';
  const makeSuggestion = ({
    id,
    label,
    upvotes,
    downvotes,
  }) => ({
    id,
    label,
    ontologyId: null,
    evidence: null,
    markers: [],
    proposedBy: 'ghid_42',
    proposedAt: '2026-07-25T01:02:03.456Z',
    editedAt: null,
    upvotes,
    downvotes,
    comments: [],
  });
  const stronger = makeSuggestion({
    id: 'stronger',
    label: 'Alpha label',
    upvotes: ['ghid_1', 'ghid_2'],
    downvotes: ['ghid_3'],
  });
  const weakerSameNet = makeSuggestion({
    id: 'weaker',
    label: 'Beta label',
    upvotes: ['ghid_4'],
    downvotes: [],
  });

  session._state.suggestions[bucket] = [stronger, weakerSameNet];
  const forward = session.computeConsensus(
    'cell_type',
    0,
    { minAnnotators: 1, threshold: 0 }
  );
  session._state.suggestions[bucket] = [weakerSameNet, stronger];
  const reversed = session.computeConsensus(
    'cell_type',
    0,
    { minAnnotators: 1, threshold: 0 }
  );

  assert.deepEqual(forward, reversed);
  assert.equal(forward.status, 'consensus');
  assert.equal(forward.label, 'Alpha label');
  assert.equal(forward.suggestionId, 'stronger');

  const exactTieA = { ...stronger, id: 'tie-a', label: 'áccent' };
  const exactTieB = { ...stronger, id: 'tie-b', label: 'Zulu' };
  const exactTieC = { ...stronger, id: 'tie-c', label: 'alpha' };
  session._state.suggestions[bucket] = [
    exactTieA,
    exactTieB,
    exactTieC,
  ];
  const tieForward = session.computeConsensus(
    'cell_type',
    0,
    { minAnnotators: 1, threshold: 0 }
  );
  session._state.suggestions[bucket] = [
    exactTieC,
    exactTieA,
    exactTieB,
  ];
  const tieReversed = session.computeConsensus(
    'cell_type',
    0,
    { minAnnotators: 1, threshold: 0 }
  );
  assert.deepEqual(tieForward, tieReversed);
  assert.equal(tieForward.status, 'disputed');
  assert.equal(tieForward.label, 'Zulu, alpha, áccent');
  assert.equal(tieForward.suggestionId, null);
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
          size: Buffer.byteLength(JSON.stringify(document), 'utf8'),
        },
      ],
      truncated: false,
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
          size: Buffer.byteLength(JSON.stringify(invalid), 'utf8'),
        },
      ],
      truncated: false,
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
          size: Buffer.byteLength(encodedDuplicate, 'utf8'),
        },
      ],
      truncated: false,
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
  const capResult = (overrides = {}) => ({
    id: 'cap-result-1',
    name: 'T cell',
    fullName: 'T cell',
    ontologyTerm: 'T cell',
    ontologyTermId: 'CL:0000084',
    synonyms: [],
    markerGenes: [],
    canonicalMarkerGenes: [],
    count: 1,
    scores: { agree: 0, disagree: 0, idk: 0 },
    ...overrides,
  });
  const responseFor = results =>
    new Response(JSON.stringify({
      contractVersion: 1,
      results,
      omittedInvalidCount: 0,
    }), {
      status: 200,
    });

  await t.test('ontology id', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => responseFor([
      capResult({
        name: 'CL candidate',
        fullName: 'CL candidate',
        ontologyTerm: 'CL candidate',
        ontologyTermId: 'CL:0000999',
      }),
    ]);
    try {
      assert.deepEqual(await lookupByOntologyId('CL:0000625'), {
        results: [],
        omittedInvalidCount: 0,
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  await t.test('cell type name', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => responseFor([
      capResult({
        name: 'T cell',
        fullName: 'T cell',
        ontologyTerm: 'T cell',
        ontologyTermId: 'CL:0000084',
      }),
    ]);
    try {
      assert.deepEqual(await lookupByName('B cell'), {
        results: [],
        omittedInvalidCount: 0,
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  await t.test('community feedback', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => responseFor([
      capResult({
        name: 'T cell',
        fullName: 'T cell',
        scores: { agree: 10, disagree: 1, idk: 2 },
      }),
    ]);
    try {
      assert.deepEqual(await getCommunityFeedback('B cell'), {
        results: [],
        omittedInvalidCount: 0,
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('CAP HTTP success rejects duplicate JSON keys', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      '{"contractVersion":1,"results":[],"\\u0072esults":[],"omittedInvalidCount":0}',
      { status: 200 }
    );
  try {
    await assert.rejects(
      () => searchCellTypes('T cell'),
      /duplicate JSON object key "results"/
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
          size: 0,
        },
      ],
      truncated: false,
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
              size: Buffer.from(
                scenario.blob.content,
                scenario.blob.encoding === 'base64' ? 'base64' : 'utf8'
              ).byteLength,
            },
          ],
          truncated: false,
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
