/**
 * A transaction of `indexedDbDatabase` is all of it or none, whatever becomes
 * of the page (`assets/js/utils/indexed-db-database.js`).
 *
 * The browser commits a transaction once it has no request left to run. A
 * page that goes away while its work awaits a request never makes the next
 * one, so writes awaited one after another were committed as far as they had
 * got (Firefox, a tab closed mid-write: 98 and 252 of 400 writes kept; a
 * saved state with a conversation's count and not its messages, Web contracts
 * run 42202865024). So every write of a transaction is made in the task its
 * last read was answered in, none waiting for another, a read after a write
 * is refused, and the transaction is told to commit.
 *
 * The factory here is IndexedDB as far as the wrapper uses it, with one
 * difference that is the point: it answers each request in a task of its
 * own and counts those tasks, so the test sees in which task a request was
 * made.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { READ_AFTER_WRITE, indexedDbDatabase } from '../assets/js/utils/indexed-db-database.js';
import { memoryDatabase } from './helpers/memory-history-database.mjs';

function countingFactory() {
  const stores = new Map();
  const made = [];
  const commits = [];
  let answered = 0;
  const factory = {
    made,
    commits,
    stores,
    open() {
      const request = { result: null };
      const db = {
        objectStoreNames: { contains: name => stores.has(name) },
        createObjectStore: name => { stores.set(name, new Map()); },
        transaction(names) {
          let pending = 0;
          let finished = false;
          const staged = new Map(names.map(name => [name, new Map(stores.get(name))]));
          const transaction = {
            error: null,
            objectStore(name) {
              const rows = staged.get(name);
              const ask = (kind, key, run) => {
                made.push({ kind, store: name, key, afterAnswers: answered });
                const asked = { result: undefined };
                pending += 1;
                setTimeout(() => {
                  if (finished) return;
                  asked.result = run();
                  answered += 1;
                  asked.onsuccess?.();
                  pending -= 1;
                  // Once the callbacks of the task have run (the wrapper's continuation among them).
                  setTimeout(() => {
                    if (pending > 0 || finished) return;
                    finished = true;
                    for (const [store, map] of staged) stores.set(store, map);
                    transaction.oncomplete?.();
                  }, 0);
                }, 0);
                return asked;
              };
              return {
                get: key => ask('get', key, () => rows.get(JSON.stringify(key))),
                count: key => ask('count', key, () => (rows.has(JSON.stringify(key)) ? 1 : 0)),
                getAll: () => ask('getAll', null, () => [...rows.values()]),
                getAllKeys: () => ask('getAllKeys', null, () => [...rows.keys()].map(text => JSON.parse(text))),
                put: (value, key) => ask('put', key, () => { rows.set(JSON.stringify(key), value); }),
                delete: key => ask('delete', key, () => { rows.delete(JSON.stringify(key)); }),
              };
            },
            commit() { commits.push(made.length); },
            abort() {
              if (finished) return;
              finished = true;
              transaction.onabort?.();
            },
          };
          return transaction;
        },
      };
      setTimeout(() => {
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  return factory;
}

test('every write of a transaction is made in one task, after its reads, and the transaction is told to commit', async () => {
  const factory = countingFactory();
  const database = indexedDbDatabase('probe', { version: 1, stores: ['a', 'b'] }, factory);
  await database.transaction(['a', 'b'], 'readwrite', async tx => {
    assert.equal(await tx.get('a', 'first'), undefined);
    assert.equal(await tx.has('b', 'marker'), false);
    for (let index = 0; index < 50; index++) await tx.put('a', index, { index });
    tx.delete('a', 3);
    tx.put('b', 'marker', true);
  });
  const writes = factory.made.filter(request => request.kind === 'put' || request.kind === 'delete');
  assert.equal(writes.length, 52);
  // Two reads were answered before the first write; no request was answered between the writes.
  assert.deepEqual([...new Set(writes.map(request => request.afterAnswers))], [2]);
  assert.deepEqual(factory.commits, [factory.made.length], 'told to commit once every write was made');
  assert.equal(factory.stores.get('a').size, 49);
  assert.equal(factory.stores.get('b').get(JSON.stringify('marker')), true);
});

test('a read after a write is refused, and nothing of the transaction is kept', async () => {
  const factory = countingFactory();
  const database = indexedDbDatabase('probe', { version: 1, stores: ['a'] }, factory);
  await assert.rejects(
    database.transaction(['a'], 'readwrite', async tx => {
      tx.put('a', 1, 'one');
      await tx.get('a', 1);
    }),
    error => error.message === READ_AFTER_WRITE,
  );
  assert.equal(factory.stores.get('a').size, 0);
  assert.deepEqual(factory.commits, []);
});

test('the history tests\' database holds its transactions to the same rule', async () => {
  const database = memoryDatabase();
  await assert.rejects(
    database.transaction(['entries'], 'readwrite', async tx => {
      tx.put('entries', 'one', {});
      await tx.has('entries', 'one');
    }),
    error => error.message === READ_AFTER_WRITE,
  );
  assert.equal(database.stores.get('entries').size, 0);
});
