/**
 * The Pull's file cache (`file-cache.js`): records keyed by blob id, one
 * transaction per batch, exclusion verdicts, the completed-Pull marker, and
 * no localStorage index.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';
import { createFakeIndexedDB, FakeKeyRange } from './helpers/fake-indexeddb.mjs';

const SCOPE = { datasetId: 'dataset-a', repoRef: 'owner/repo@main', userId: 42 };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function view(userId) {
  return {
    version: 1,
    username: `ghid_${userId}`,
    githubUserId: userId,
    updatedAt: '2026-07-30T01:02:03.456Z',
    suggestions: {},
    votes: {},
    comments: {},
    deletedSuggestions: {},
  };
}

function createCache() {
  const factory = createFakeIndexedDB();
  return { factory, cache: new CommunityAnnotationFileCache({ indexedDB: factory, keyRange: FakeKeyRange }) };
}

test('a batch of files is kept in one transaction and its blob ids read back without bodies', async () => {
  const { factory, cache } = createCache();
  await cache.init();
  const before = factory.stats.transactions;
  await cache.putRecords(SCOPE, [
    { path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) },
    { path: 'annotations/users/ghid_2.json', sha: SHA_B, rejection: { code: 'COMMUNITY_ANNOTATION_CONTRACT_INVALID', message: 'bad' } },
  ]);
  assert.equal(factory.stats.transactions - before, 1);
  const known = await cache.getKnownShas(SCOPE);
  assert.deepEqual([...known], [['annotations/users/ghid_1.json', SHA_A], ['annotations/users/ghid_2.json', SHA_B]]);
});

test('a new version of a path replaces the old one', async () => {
  const { cache } = createCache();
  await cache.putRecords(SCOPE, [{ path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) }]);
  await cache.putRecords(SCOPE, [{ path: 'annotations/users/ghid_1.json', sha: SHA_B, view: view(1) }]);
  const record = await cache.getRecord(SCOPE, 'annotations/users/ghid_1.json');
  assert.equal(record.sha, SHA_B);
  assert.equal((await cache.getKnownShas(SCOPE)).size, 1);
});

test('an excluded file is kept with its reason and folded as excluded', async () => {
  const { cache } = createCache();
  await cache.putRecords(SCOPE, [
    { path: 'annotations/users/ghid_3.json', sha: SHA_A, rejection: { code: 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE', message: 'too large' } },
  ]);
  const seen = [];
  await cache.forEachRecord(SCOPE, (record) => seen.push(record));
  assert.deepEqual(seen, [{
    path: 'annotations/users/ghid_3.json',
    sha: SHA_A,
    view: null,
    rejection: { code: 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE', message: 'too large' },
  }]);
});

test('every record of a batch is checked before a transaction opens', async () => {
  const { factory, cache } = createCache();
  await cache.init();
  const before = factory.stats.transactions;
  await assert.rejects(cache.putRecords(SCOPE, [
    { path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) },
    { path: 'annotations/users/ghid_2.json', sha: 'not-a-sha', view: view(2) },
  ]), /40 lowercase hexadecimal/);
  await assert.rejects(cache.putRecords(SCOPE, [
    { path: 'annotations/users/README.md', sha: SHA_A, view: view(1) },
  ]), /Unsupported community annotation cache path/);
  await assert.rejects(cache.putRecords(SCOPE, [
    { path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1), rejection: { code: 'x', message: 'y' } },
  ]), /exactly path, sha and either view or rejection/);
  assert.equal(factory.stats.transactions, before);
});

test('a caller abort aborts the batch transaction and keeps nothing of it', async () => {
  const { factory, cache } = createCache();
  await cache.init();
  const controller = new AbortController();
  const before = factory.stats.transactions;
  const writing = cache.putRecords(SCOPE, [{ path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) }], { signal: controller.signal });
  // Abort once the batch's transaction is open.
  while (factory.stats.transactions === before) await Promise.resolve();
  controller.abort();
  await assert.rejects(writing, (error) => error.name === 'AbortError');
  assert.equal(factory.stats.aborts, 1);
  assert.equal((await cache.getKnownShas(SCOPE)).size, 0);
});

test('a pre-aborted batch opens no transaction', async () => {
  const { factory, cache } = createCache();
  await cache.init();
  const before = factory.stats.transactions;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cache.putRecords(SCOPE, [{ path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) }], { signal: controller.signal }),
    (error) => error.name === 'AbortError'
  );
  assert.equal(factory.stats.transactions, before);
});

test('the completed-Pull marker round-trips, and a damaged one is a corrupt cache', async () => {
  const { factory, cache } = createCache();
  assert.equal(await cache.getPullMarker(SCOPE), null);
  await cache.setPullMarker(SCOPE, {
    commitOid: SHA_A,
    annotationsOid: SHA_B,
    usersOid: SHA_A,
    ignored: [{ path: 'annotations/users/README.md', reason: 'not a user file' }],
  });
  const marker = await cache.getPullMarker(SCOPE);
  assert.equal(marker.annotationsOid, SHA_B);
  assert.deepEqual(marker.ignored, [{ path: 'annotations/users/README.md', reason: 'not a user file' }]);
  await cache.deletePullMarker(SCOPE);
  assert.equal(await cache.getPullMarker(SCOPE), null);
  const db = factory.databases.get('cellucid_community_annotation_file_cache');
  // A record of another shape under the scope's key.
  const scopeKey = 'dataset-a|owner%2Frepo|main|42';
  db.stores.get('pulls').rows = [{ key: scopeKey, value: { scopeKey, annotationsOid: 'nope' } }];
  await assert.rejects(cache.getPullMarker(SCOPE), (error) => error.code === 'LOCAL_RAW_CACHE_CORRUPT');
});

test('pruning keeps only the paths still in the repository; clearing removes files and marker', async () => {
  const { cache } = createCache();
  await cache.putRecords(SCOPE, [
    { path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) },
    { path: 'annotations/users/ghid_2.json', sha: SHA_A, view: view(2) },
  ]);
  assert.equal(await cache.pruneToPaths(SCOPE, new Set(['annotations/users/ghid_2.json'])), 1);
  assert.deepEqual([...(await cache.getKnownShas(SCOPE)).keys()], ['annotations/users/ghid_2.json']);
  await cache.setPullMarker(SCOPE, { commitOid: SHA_A, annotationsOid: SHA_A, usersOid: SHA_A, ignored: [] });
  await cache.clearRepo(SCOPE);
  assert.equal((await cache.getKnownShas(SCOPE)).size, 0);
  assert.equal(await cache.getPullMarker(SCOPE), null);
});

test('scopes never see each other\'s files', async () => {
  const { cache } = createCache();
  await cache.putRecords(SCOPE, [{ path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) }]);
  const other = { ...SCOPE, datasetId: 'dataset-b' };
  assert.equal((await cache.getKnownShas(other)).size, 0);
  assert.equal(await cache.getRecord(other, 'annotations/users/ghid_1.json'), null);
});

test('an earlier cache layout is dropped whole on upgrade; nothing is kept in localStorage', async () => {
  const factory = createFakeIndexedDB();
  factory.databases.set('cellucid_community_annotation_file_cache', {
    version: 1,
    stores: new Map([['files', { keyPath: 'key', rows: [{ key: 'old', value: { key: 'old' } }] }]]),
  });
  const writes = [];
  const previous = globalThis.localStorage;
  globalThis.localStorage = { setItem: (key) => writes.push(key), getItem: () => null, removeItem: () => {} };
  try {
    const cache = new CommunityAnnotationFileCache({ indexedDB: factory, keyRange: FakeKeyRange });
    await cache.putRecords(SCOPE, [{ path: 'annotations/users/ghid_1.json', sha: SHA_A, view: view(1) }]);
    const db = factory.databases.get('cellucid_community_annotation_file_cache');
    assert.deepEqual([...db.stores.keys()].sort(), ['files', 'pulls']);
    assert.equal(db.stores.get('files').rows.length, 1);
    assert.deepEqual(writes, [], 'no localStorage SHA index');
  } finally {
    globalThis.localStorage = previous;
  }
});
