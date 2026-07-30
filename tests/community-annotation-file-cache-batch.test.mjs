import assert from 'node:assert/strict';
import test from 'node:test';

import { CommunityAnnotationFileCache } from '../assets/js/app/community-annotations/file-cache.js';
import { toFileShaIndexKey } from '../assets/js/app/community-annotations/cache-scope.js';

function userDocument(userId) {
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

function createDatabase({
  deferred = false,
  putError = null,
  transactionError = null,
} = {}) {
  const state = {
    aborts: 0,
    puts: [],
    transactions: 0,
    transaction: null,
  };
  const db = {
    transaction(storeNames, mode) {
      assert.deepEqual(storeNames, ['files']);
      assert.equal(mode, 'readwrite');
      state.transactions += 1;
      const transaction = {
        error: null,
        onabort: null,
        oncomplete: null,
        onerror: null,
        abort() {
          state.aborts += 1;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore(name) {
          assert.equal(name, 'files');
          return {
            put(record) {
              if (putError !== null) throw putError;
              state.puts.push(record);
            },
          };
        },
      };
      state.transaction = transaction;
      if (transactionError !== null) {
        queueMicrotask(() => {
          transaction.error = transactionError;
          transaction.onerror?.();
        });
      } else if (!deferred) {
        queueMicrotask(() => transaction.oncomplete?.());
      }
      return transaction;
    },
  };
  return { db, state };
}

async function settleMicrotasks(turns = 6) {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

test('raw annotation files persist in one transaction and one SHA-index commit', async () => {
  const scope = {
    datasetId: 'batch-dataset',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  const storageValues = new Map();
  let reads = 0;
  let writes = 0;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      reads += 1;
      return storageValues.get(String(key)) ?? null;
    },
    setItem(key, value) {
      writes += 1;
      storageValues.set(String(key), String(value));
    },
    removeItem(key) {
      storageValues.delete(String(key));
    },
  };
  const { db, state } = createDatabase();
  const cache = new CommunityAnnotationFileCache();
  cache._db = db;
  try {
    await cache.setManyJson({
      ...scope,
      records: [
        {
          path: 'annotations/users/ghid_1.json',
          sha: shaA,
          json: userDocument(1),
        },
        {
          path: 'annotations/moderation/merges.json',
          sha: shaB,
          json: {
            version: 1,
            updatedAt: '2026-07-30T01:02:03.456Z',
            merges: [],
          },
        },
      ],
    });

    assert.equal(state.transactions, 1);
    assert.equal(state.puts.length, 2);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.deepEqual(
      JSON.parse(storageValues.get(toFileShaIndexKey(scope))),
      {
        'annotations/users/ghid_1.json': shaA,
        'annotations/moderation/merges.json': shaB,
      }
    );
    assert.equal(state.puts[0].storedAt, state.puts[1].storedAt);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('batch validation is complete before opening an IndexedDB transaction', async () => {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  const { db, state } = createDatabase();
  const cache = new CommunityAnnotationFileCache();
  cache._db = db;
  try {
    await assert.rejects(
      () => cache.setManyJson({
        datasetId: 'batch-dataset',
        repoRef: 'owner/repo@main',
        userId: 42,
        records: [
          {
            path: 'annotations/users/ghid_1.json',
            sha: 'a'.repeat(40),
            json: userDocument(1),
          },
          {
            path: 'annotations/users/ghid_1.json',
            sha: 'b'.repeat(40),
            json: userDocument(1),
          },
        ],
      }),
      /duplicated/
    );
    assert.equal(state.transactions, 0);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('caller abort physically aborts the owned cache batch transaction', async () => {
  const previousLocalStorage = globalThis.localStorage;
  let indexWrites = 0;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {
      indexWrites += 1;
    },
    removeItem() {},
  };
  const { db, state } = createDatabase({ deferred: true });
  const cache = new CommunityAnnotationFileCache();
  cache._db = db;
  const controller = new AbortController();
  try {
    const operation = cache.setManyJson({
      datasetId: 'batch-dataset',
      repoRef: 'owner/repo@main',
      userId: 42,
      records: [{
        path: 'annotations/users/ghid_1.json',
        sha: 'a'.repeat(40),
        json: userDocument(1),
      }],
      signal: controller.signal,
    });
    await settleMicrotasks();
    controller.abort();
    await assert.rejects(
      operation,
      error => error?.code === 'LOCAL_RAW_CACHE_WRITE_ABORTED'
    );
    assert.equal(state.transactions, 1);
    assert.equal(state.aborts, 1);
    assert.equal(indexWrites, 0);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('a pre-aborted cache owner opens no transaction or SHA-index generation', async () => {
  const previousLocalStorage = globalThis.localStorage;
  let indexReads = 0;
  let indexWrites = 0;
  globalThis.localStorage = {
    getItem() {
      indexReads += 1;
      return null;
    },
    setItem() {
      indexWrites += 1;
    },
    removeItem() {},
  };
  const { db, state } = createDatabase();
  const cache = new CommunityAnnotationFileCache();
  cache._db = db;
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => cache.setManyJson({
        datasetId: 'batch-dataset',
        repoRef: 'owner/repo@main',
        userId: 42,
        records: [{
          path: 'annotations/users/ghid_1.json',
          sha: 'a'.repeat(40),
          json: userDocument(1),
        }],
        signal: controller.signal,
      }),
      error => error?.code === 'LOCAL_RAW_CACHE_WRITE_ABORTED'
    );
    assert.equal(state.transactions, 0);
    assert.equal(indexReads, 0);
    assert.equal(indexWrites, 0);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('a synchronous object-store failure aborts the batch and skips the SHA index', async () => {
  const previousLocalStorage = globalThis.localStorage;
  let indexWrites = 0;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {
      indexWrites += 1;
    },
    removeItem() {},
  };
  const putFailure = new Error('synthetic put failure');
  const { db, state } = createDatabase({ putError: putFailure });
  const cache = new CommunityAnnotationFileCache();
  cache._db = db;
  try {
    await assert.rejects(
      () => cache.setManyJson({
        datasetId: 'batch-dataset',
        repoRef: 'owner/repo@main',
        userId: 42,
        records: [{
          path: 'annotations/users/ghid_1.json',
          sha: 'a'.repeat(40),
          json: userDocument(1),
        }],
      }),
      error => error === putFailure
    );
    assert.equal(state.transactions, 1);
    assert.equal(state.aborts, 1);
    assert.equal(indexWrites, 0);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('an IndexedDB transaction failure is explicitly aborted before rejection', async () => {
  const previousLocalStorage = globalThis.localStorage;
  let indexWrites = 0;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {
      indexWrites += 1;
    },
    removeItem() {},
  };
  const transactionFailure = new Error('synthetic transaction failure');
  const { db, state } = createDatabase({ transactionError: transactionFailure });
  const cache = new CommunityAnnotationFileCache();
  cache._db = db;
  try {
    await assert.rejects(
      () => cache.setManyJson({
        datasetId: 'batch-dataset',
        repoRef: 'owner/repo@main',
        userId: 42,
        records: [{
          path: 'annotations/users/ghid_1.json',
          sha: 'a'.repeat(40),
          json: userDocument(1),
        }],
      }),
      error => error === transactionFailure
    );
    assert.equal(state.transactions, 1);
    assert.equal(state.aborts, 1);
    assert.equal(indexWrites, 0);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('failed exact-scope deletion still invalidates stale SHA advertisements for retry', async () => {
  const scope = {
    datasetId: 'recovery-dataset',
    repoRef: 'owner/repo@main',
    userId: 42,
  };
  const indexKey = toFileShaIndexKey(scope);
  const values = new Map([
    [
      indexKey,
      JSON.stringify({
        'annotations/users/ghid_1.json': 'a'.repeat(40),
      }),
    ],
  ]);
  const order = [];
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(String(key)) ?? null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      order.push('sha-index-invalidated');
      values.delete(String(key));
    },
  };
  const transactionFailure = new Error(
    'synthetic cache clear transaction failure'
  );
  const cache = new CommunityAnnotationFileCache();
  cache._db = {
    transaction() {
      order.push('indexeddb-delete-attempted');
      throw transactionFailure;
    },
  };
  try {
    await assert.rejects(
      () => cache.clearRepo(scope),
      error => error === transactionFailure
    );
    assert.deepEqual(order, [
      'sha-index-invalidated',
      'indexeddb-delete-attempted',
    ]);
    assert.deepEqual(
      cache.getKnownShas(scope, {
        prefixes: ['annotations/users/'],
      }),
      {}
    );
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});
