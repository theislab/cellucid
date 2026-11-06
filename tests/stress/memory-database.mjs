/**
 * An IndexedDB stand-in for the history stress suite: the transaction
 * interface `app/history/autosave-store.js` writes through
 * (`utils/indexed-db-database.js`), with IndexedDB's semantics where they
 * cost (one transaction at a time; every `put` a structured clone; a
 * transaction's writes kept only when its work resolves), and none of the
 * whole-store copies the contract tests' stand-in makes per transaction
 * (`tests/history-autosave.test.mjs`), which would measure the stand-in at
 * 100k steps instead of the autosave.
 *
 * It counts what it holds: each store's records and their bytes (a typed
 * array by its byte length, anything else by the length of its JSON with
 * every typed array counted by its bytes), the figure the suite reports as
 * the autosave's IndexedDB bytes (`dropContents` keeps counting records
 * without holding them, for runs too large to hold the history twice). A browser's own figure
 * (`navigator.storage.estimate()`) adds its on-disk overhead; the browser
 * spec reads that one.
 */

// The object stores of `cellucid-history` (`app/history/autosave-store.js`).
const STORES = ['entries', 'trackers', 'steps', 'turns', 'journal', 'chats', 'messages', 'values', 'parts', 'arrays'];

/** IndexedDB's key order: numbers < strings < arrays, arrays element by element. */
function compareKeys(a, b) {
  const rank = key => (typeof key === 'number' ? 0 : typeof key === 'string' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = compareKeys(a[i], b[i]);
      if (order !== 0) return order;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function startsWith(key, prefix) {
  return Array.isArray(key) && prefix.every((part, i) => compareKeys(part, key[i]) === 0);
}

/** The bytes a record holds: typed arrays by their bytes, the rest by its JSON. */
export function recordBytes(value) {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  let arrays = 0;
  const text = JSON.stringify(value, (key, item) => {
    if (ArrayBuffer.isView(item)) {
      arrays += item.byteLength;
      return 0;
    }
    return item;
  });
  return arrays + (text?.length ?? 0);
}

export function memoryDatabase() {
  /** name → Map(keyText → {key, value, bytes}) */
  const stores = new Map(STORES.map(name => [name, new Map()]));
  const totals = new Map(STORES.map(name => [name, 0]));
  let tail = Promise.resolve();
  let transactions = 0;
  let putCount = 0;
  /** Whether a put keeps the record (a saved state read back needs it) or only counts its bytes. */
  let retain = true;

  function rangeOf(name, range) {
    const out = [];
    for (const record of stores.get(name).values()) {
      if (range === null || range === undefined
        || (range.prefix ? startsWith(record.key, range.prefix) : compareKeys(record.key, range) === 0)) {
        out.push(record);
      }
    }
    return out.sort((a, b) => compareKeys(a.key, b.key));
  }

  const database = {
    transaction(names, mode, work) {
      const run = tail.then(async () => {
        transactions++;
        /** keyText → {name, key, value|undefined (a delete)} in write order */
        const staged = new Map(names.map(name => [name, new Map()]));
        const read = (name, keyText) => {
          const pending = staged.get(name).get(keyText);
          if (pending !== undefined) return pending.deleted ? undefined : pending;
          return stores.get(name).get(keyText);
        };
        const tx = {
          get: async (name, key) => read(name, JSON.stringify(key))?.value,
          has: async (name, key) => read(name, JSON.stringify(key)) !== undefined,
          getAll: async (name, range = null) => {
            if ([...staged.get(name).values()].length > 0) throw new Error('getAll after a write in one transaction is not modelled');
            return rangeOf(name, range).map(record => record.value);
          },
          getAllKeys: async (name, range = null) => {
            if ([...staged.get(name).values()].length > 0) throw new Error('getAllKeys after a write in one transaction is not modelled');
            return rangeOf(name, range).map(record => record.key);
          },
          put: async (name, key, value) => {
            if (mode !== 'readwrite') throw new Error('readonly transaction');
            putCount++;
            // The entry record stays whole: the autosave's own reads (`list`, the Continue offer) use it.
            const kept = !retain && name !== 'entries'
              ? { bytes: recordBytes(value) }
              : (() => { const copy = structuredClone(value); return { value: copy, bytes: recordBytes(copy) }; })();
            staged.get(name).set(JSON.stringify(key), { key, ...kept, value: kept.value ?? null });
          },
          delete: async (name, key) => {
            if (key?.prefix) {
              for (const record of rangeOf(name, key)) staged.get(name).set(JSON.stringify(record.key), { key: record.key, deleted: true });
            } else {
              staged.get(name).set(JSON.stringify(key), { key, deleted: true });
            }
          },
        };
        const result = await work(tx);
        for (const [name, writes] of staged) {
          const store = stores.get(name);
          let total = totals.get(name);
          for (const [keyText, write] of writes) {
            const before = store.get(keyText);
            if (before !== undefined) total -= before.bytes;
            if (write.deleted) store.delete(keyText);
            else {
              store.set(keyText, write);
              total += write.bytes;
            }
          }
          totals.set(name, total);
        }
        return result;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    /**
     * From now on count every record's bytes without holding it, and let go
     * of the records held (a browser keeps them on disk; this process would
     * hold the history twice): saved states cannot be read back afterwards.
     */
    /** Whether the records are held (they are, until `dropContents`): what reads them back needs them. */
    get retaining() { return retain; },
    dropContents() {
      retain = false;
      for (const [name, store] of stores) {
        if (name === 'entries') continue;
        for (const record of store.values()) record.value = null;
      }
    },
    /** What it holds now: records and bytes per store, and how many transactions and puts it ran. */
    usage() {
      const out = { transactions, puts: putCount, bytes: 0, stores: {} };
      for (const name of STORES) {
        out.stores[name] = { records: stores.get(name).size, bytes: totals.get(name) };
        out.bytes += totals.get(name);
      }
      return out;
    },
  };
  return database;
}
