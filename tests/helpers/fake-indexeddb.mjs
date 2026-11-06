/**
 * A small in-memory IndexedDB for tests: what `file-cache.js` uses and no
 * more -- version upgrades, object stores with a key path (a member or an
 * array of members), key ranges, put / delete (by key or range) / get /
 * getAll / getAllKeys / openCursor, and transactions that complete once no
 * request is left and roll their writes back when aborted. Keys are ordered
 * as IndexedDB orders them for numbers, strings and arrays.
 */

function typeRank(key) {
  if (typeof key === 'number') return 1;
  if (typeof key === 'string') return 3;
  if (Array.isArray(key)) return 5;
  throw new TypeError(`Unsupported IndexedDB key ${JSON.stringify(key)}`);
}

export function compareKeys(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export const FakeKeyRange = Object.freeze({
  bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return Object.freeze({ fake: true, lower, upper, lowerOpen, upperOpen });
  },
  only(value) {
    return FakeKeyRange.bound(value, value);
  },
});

/** The first index whose key is not below `key` (`open`: above it). Rows are kept sorted by key. */
function lowerIndex(rows, key, open) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = compareKeys(rows[mid].key, key);
    if (c < 0 || (open && c === 0)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The rows a query (a key, a range, or nothing) selects: `[start, end)`. */
function spanOf(rows, query) {
  if (query === undefined || query === null) return [0, rows.length];
  const range = query?.fake === true ? query : { lower: query, upper: query, lowerOpen: false, upperOpen: false };
  const start = lowerIndex(rows, range.lower, range.lowerOpen);
  const end = lowerIndex(rows, range.upper, !range.upperOpen);
  return [start, Math.max(start, end)];
}

function keyOf(record, keyPath) {
  return Array.isArray(keyPath) ? keyPath.map((member) => record[member]) : record[keyPath];
}

/** A structured copy, as IndexedDB stores and answers values. */
const copy = (value) => (value === undefined ? undefined : structuredClone(value));

export function createFakeIndexedDB() {
  /** @type {Map<string, {version: number, stores: Map<string, {keyPath: any, rows: Array<{key: any, value: any}>}>}>} */
  const databases = new Map();
  const stats = { transactions: 0, aborts: 0 };

  const selected = (store, query) => {
    const [start, end] = spanOf(store.rows, query);
    return store.rows.slice(start, end);
  };

  function makeTransaction(db, names, mode) {
    stats.transactions += 1;
    const snapshot = new Map(names.map((name) => [name, db.stores.get(name).rows.map((row) => ({ ...row }))]));
    let pending = 0;
    let finished = false;
    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort() {
        if (finished) throw new Error('Transaction already finished');
        finished = true;
        stats.aborts += 1;
        for (const [name, rows] of snapshot) db.stores.get(name).rows = rows;
        queueMicrotask(() => tx.onabort?.());
      },
      objectStore(name) {
        if (!names.includes(name)) throw new Error(`Store ${name} is not in this transaction`);
        const store = db.stores.get(name);
        const request = (work) => {
          if (finished) throw new Error('Transaction is not active');
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };
          pending += 1;
          queueMicrotask(() => {
            if (finished) return;
            try {
              req.result = work();
              req.onsuccess?.();
            } catch (error) {
              req.error = error;
              tx.error = error;
              req.onerror?.();
              tx.onerror?.();
            }
            pending -= 1;
            queueMicrotask(() => {
              if (!finished && pending === 0) {
                finished = true;
                tx.oncomplete?.();
              }
            });
          });
          return req;
        };
        const write = () => {
          if (mode !== 'readwrite') throw new Error('Read-only transaction');
        };
        return {
          put(value) {
            write();
            const stored = copy(value);
            return request(() => {
              const key = keyOf(stored, store.keyPath);
              const at = lowerIndex(store.rows, key, false);
              const same = at < store.rows.length && compareKeys(store.rows[at].key, key) === 0;
              store.rows.splice(at, same ? 1 : 0, { key, value: stored });
              return key;
            });
          },
          delete(query) {
            write();
            return request(() => {
              const [start, end] = spanOf(store.rows, query);
              store.rows.splice(start, end - start);
            });
          },
          get(query) {
            return request(() => copy(selected(store, query)[0]?.value));
          },
          getAll(query) {
            return request(() => selected(store, query).map((row) => copy(row.value)));
          },
          getAllKeys(query) {
            return request(() => selected(store, query).map((row) => copy(row.key)));
          },
          openCursor(query) {
            const rows = selected(store, query);
            let index = 0;
            let req = null;
            const step = () => (index < rows.length
              ? { value: copy(rows[index].value), key: rows[index].key, continue: advance }
              : null);
            function advance() {
              index += 1;
              const next = request(step);
              next.onsuccess = () => {
                req.result = next.result;
                req.onsuccess?.();
              };
            }
            req = request(step);
            return req;
          },
        };
      },
    };
    queueMicrotask(() => queueMicrotask(() => {
      if (!finished && pending === 0) {
        finished = true;
        tx.oncomplete?.();
      }
    }));
    return tx;
  }

  const factory = {
    stats,
    databases,
    open(name, version) {
      const req = { result: null, error: null, transaction: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = { version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const connection = {
          get objectStoreNames() {
            return [...db.stores.keys()];
          },
          createObjectStore(storeName, { keyPath }) {
            db.stores.set(storeName, { keyPath, rows: [] });
          },
          deleteObjectStore(storeName) {
            db.stores.delete(storeName);
          },
          transaction(names, mode = 'readonly') {
            return makeTransaction(db, Array.isArray(names) ? names : [names], mode);
          },
          close() {},
        };
        req.result = connection;
        if (db.version < version) {
          req.transaction = { abort() {} };
          req.onupgradeneeded?.();
          db.version = version;
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
  return factory;
}
