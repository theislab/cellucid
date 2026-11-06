/**
 * @fileoverview One object store of this browser's IndexedDB as a key-value
 * store: the per-viewer records the app keeps in IndexedDB (the handles of
 * files opened from this computer, `app/library/local-file-handles.js`; the
 * decoders the probe decided on, `formats/io/decoder-memory.js`), each in a
 * database of its own. Several object stores written together in one
 * transaction (the history's saved states) are `indexed-db-database.js`.
 *
 * @module utils/indexed-db-store
 */

/**
 * @typedef {{get: (key: string) => Promise<unknown>, put: (key: string, value: unknown) => Promise<void>,
 *   delete: (key: string) => Promise<void>, entries: () => Promise<Array<{key: string, value: unknown}>>}} KeyValueStore
 */

/**
 * The object store `storeName` of the database `databaseName`, made on its
 * first use, or null when this page has no IndexedDB it can use.
 *
 * @param {string} databaseName
 * @param {string} storeName
 * @param {IDBFactory|undefined} [factory]
 * @returns {KeyValueStore|null}
 */
export function indexedDbKeyValueStore(databaseName, storeName, factory = globalThis.indexedDB) {
  if (factory === undefined || factory === null || typeof factory.open !== 'function') return null;
  let opening = null;
  const database = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opening;
  };
  const run = async (mode, act) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = act(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    get: key => run('readonly', store => store.get(key)),
    put: async (key, value) => { await run('readwrite', store => store.put(value, key)); },
    delete: async key => { await run('readwrite', store => store.delete(key)); },
    entries: async () => {
      const [keys, values] = await Promise.all([
        run('readonly', store => store.getAllKeys()),
        run('readonly', store => store.getAll()),
      ]);
      return keys.map((key, i) => ({ key, value: values[i] }));
    },
  };
}
