/**
 * @fileoverview Several object stores of one IndexedDB database read and
 * written together in one transaction, all of it or none: the history's
 * saved states (`app/history/autosave-store.js`). One object store as a
 * key-value store is `indexed-db-store.js`.
 *
 * **All of it or none, whatever becomes of the page.** A transaction's work
 * reads first and writes after: reads are awaited as promises, and every
 * write is handed to the browser at once, none waiting for the one before
 * it, with nothing read in between (a read after a write throws). The
 * browser commits a transaction as soon as it has no request left to run. A
 * page that goes away while its work waits on a request never makes the
 * next one, so writes made one at a time, each awaited, were committed as
 * far as they had got: Firefox kept 98 and 252 of 400 such writes of one
 * transaction when its tab closed (3 closes in 30), and a history's saved
 * state came back with a conversation's count and not its messages ("This
 * saved state is missing messages of a conversation; it cannot be opened",
 * hosted macOS Firefox, Web contracts run 42202865024). Written at once, the
 * writes are all in the transaction before any has run: the browser runs
 * them all and commits, or the page was gone first and it keeps none. The
 * transaction is then told to commit (`IDBTransaction.commit`), so the
 * browser finishes it without waiting to tell the page of each write.
 *
 * A transaction stays open while the work awaits its own reads, and commits
 * once it awaits anything else (a digest, a timer), so the work prepares
 * everything else first.
 *
 * @module utils/indexed-db-database
 */

/**
 * @typedef {{prefix: unknown[], from?: IDBValidKey}} KeyPrefix - every array key that
 *   starts with `prefix`; with `from`, those whose next part is `from` or above
 *
 * @typedef {{
 *   get: (store: string, key: IDBValidKey) => Promise<unknown>,
 *   has: (store: string, key: IDBValidKey) => Promise<boolean>,
 *   getAll: (store: string, range?: KeyPrefix|null) => Promise<unknown[]>,
 *   getAllKeys: (store: string, range?: KeyPrefix|null) => Promise<IDBValidKey[]>,
 *   put: (store: string, key: IDBValidKey, value: unknown) => void,
 *   delete: (store: string, key: IDBValidKey|KeyPrefix) => void,
 * }} DatabaseTransaction - one transaction's requests: its reads, awaited (awaiting
 *   anything else, a digest or a timer, lets it commit), then its writes, each made at
 *   once and none awaited; a read after a write throws
 *
 * @typedef {{
 *   transaction: <T>(stores: string[], mode: 'readonly'|'readwrite',
 *     work: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>,
 * }} Database
 */

function keyRangeOf(range) {
  if (range === null || range === undefined) return undefined;
  if (Array.isArray(range?.prefix)) {
    // Arrays sort after every other key, so [...prefix, []] is above every key that starts with prefix.
    const lower = range.from === undefined ? range.prefix : [...range.prefix, range.from];
    return IDBKeyRange.bound(lower, [...range.prefix, []]);
  }
  return range;
}

/** What a transaction that reads after it has written is refused with (see the module's note). */
export const READ_AFTER_WRITE = 'A storage transaction reads first and writes after: a read was made after a write, '
  + 'so a page that went away during it would leave a part of the writes kept.';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The database `databaseName` with the object stores `stores` (out-of-line
 * keys), made at `version` on its first use, or null when this page has no
 * IndexedDB it can use. A transaction runs `work` with its requests and
 * resolves to what `work` resolves once it has committed; a failure in
 * `work`, or of one of its writes, aborts it, so nothing it wrote is kept.
 *
 * @param {string} databaseName
 * @param {{version: number, stores: string[]}} schema
 * @param {IDBFactory|undefined} [factory]
 * @returns {Database|null}
 */
export function indexedDbDatabase(databaseName, { version, stores }, factory = globalThis.indexedDB) {
  if (factory === undefined || factory === null || typeof factory.open !== 'function') return null;
  let opening = null;
  const database = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open(databaseName, version);
      request.onupgradeneeded = () => {
        for (const name of stores) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Another tab holds an older version of the ${databaseName} storage; close it and try again.`));
    }).catch(error => {
      opening = null;
      throw error;
    });
    return opening;
  };
  return {
    async transaction(storeNames, mode, work) {
      const db = await database();
      const transaction = db.transaction(storeNames, mode);
      const done = new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('The storage transaction was aborted.'));
      });
      let wrote = false;
      const read = request => {
        if (wrote) throw new Error(READ_AFTER_WRITE);
        return requestResult(request());
      };
      const tx = {
        get: (store, key) => read(() => transaction.objectStore(store).get(key)),
        has: async (store, key) => (await read(() => transaction.objectStore(store).count(key))) > 0,
        getAll: (store, range = null) => read(() => transaction.objectStore(store).getAll(keyRangeOf(range))),
        getAllKeys: (store, range = null) => read(() => transaction.objectStore(store).getAllKeys(keyRangeOf(range))),
        // Made at once and not awaited: a write that fails aborts the transaction (`done`).
        put: (store, key, value) => {
          wrote = true;
          transaction.objectStore(store).put(value, key);
        },
        delete: (store, key) => {
          wrote = true;
          transaction.objectStore(store).delete(keyRangeOf(key));
        },
      };
      let result;
      try {
        result = await work(tx);
      } catch (error) {
        try { transaction.abort(); } catch { /* already finished */ }
        await done.catch(() => {});
        throw error;
      }
      // Every write is in the transaction: the browser is told to commit it now.
      if (wrote) {
        try { transaction.commit(); } catch { /* finished already, or an engine without commit(): it commits by itself */ }
      }
      await done;
      return result;
    },
  };
}
