/**
 * IndexedDB stand-ins for the autosave tests: a database over maps with
 * `indexedDbDatabase`'s transactions (one at a time, its writes kept only
 * when its work resolves, reads before writes; array keys with prefix
 * ranges), a
 * schedule the test runs, Web Locks shared by fake tabs, and a
 * notifications recorder.
 */

import { READ_AFTER_WRITE } from '../../assets/js/utils/indexed-db-database.js';

/** The object stores of `cellucid-history` (`autosave-store.js`). */
export const STORE_NAMES = Object.freeze(['entries', 'trackers', 'steps', 'turns', 'journal', 'chats', 'messages', 'values', 'parts', 'arrays']);

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

/**
 * A database over maps with IndexedDB's transaction semantics: one
 * transaction at a time, its writes kept only when its work resolves.
 * `failPuts(name)` makes the next puts throw a DOMException-like error.
 */
export function memoryDatabase() {
  const stores = new Map(STORE_NAMES.map(name => [name, new Map()]));
  let tail = Promise.resolve();
  let failure = null;
  const log = [];
  const database = {
    stores,
    log,
    failPuts(name) { failure = name; },
    transaction(names, mode, work) {
      const run = tail.then(async () => {
        const staged = new Map(names.map(name => [name, new Map(stores.get(name))]));
        const writes = [];
        const keyed = name => [...staged.get(name)].map(([text, value]) => [JSON.parse(text), value]).sort((a, b) => compareKeys(a[0], b[0]));
        const inRange = (key, range) => {
          if (range === null || range === undefined) return true;
          if (!range.prefix) return compareKeys(key, range) === 0;
          if (!startsWith(key, range.prefix)) return false;
          return range.from === undefined || compareKeys(key[range.prefix.length], range.from) >= 0;
        };
        // As `indexedDbDatabase`'s transactions: reads first, awaited; then the
        // writes, made at once and not awaited; a read after a write throws.
        let wrote = false;
        let failed = null;
        const read = value => {
          if (wrote) throw new Error(READ_AFTER_WRITE);
          return value();
        };
        const tx = {
          get: async (name, key) => read(() => staged.get(name).get(JSON.stringify(key))),
          has: async (name, key) => read(() => staged.get(name).has(JSON.stringify(key))),
          getAll: async (name, range = null) => read(() => keyed(name).filter(([key]) => inRange(key, range)).map(([, value]) => value)),
          getAllKeys: async (name, range = null) => read(() => keyed(name).filter(([key]) => inRange(key, range)).map(([key]) => key)),
          put: (name, key, value) => {
            if (mode !== 'readwrite') throw new Error('readonly transaction');
            wrote = true;
            if (failure !== null) {
              // A write the browser refuses aborts its transaction: nothing of it is kept.
              failed ??= Object.assign(new Error('The quota has been exceeded.'), { name: failure });
              return;
            }
            staged.get(name).set(JSON.stringify(key), structuredClone(value));
            writes.push([name, key]);
          },
          delete: (name, key) => {
            wrote = true;
            for (const [text] of [...staged.get(name)]) {
              if (inRange(JSON.parse(text), key)) staged.get(name).delete(text);
            }
          },
        };
        const result = await work(tx);
        if (failed !== null) throw failed;
        for (const [name, map] of staged) stores.set(name, map);
        log.push(writes);
        return result;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return database;
}

/**
 * Writes run when the test says (`await writes.run()`), as the page's next
 * task would run them, and `run` ends when they have ended: a write digests
 * its arrays on other threads, so no count of event-loop turns is enough for
 * it (a million-cell array is not yet stored after dozens of turns).
 */
export function manualSchedule() {
  const queue = [];
  return {
    schedule: write => queue.push(write),
    /** Start the writes queued now; resolves when they have ended (a test that holds one starts it and waits elsewhere). */
    start() {
      const started = queue.splice(0).map(write => write());
      return Promise.all(started);
    },
    async run() {
      while (queue.length > 0) await queue.shift()();
    },
  };
}

export function recorder() {
  const shown = [];
  const dismissed = [];
  return {
    shown,
    dismissed,
    show: notice => { shown.push(notice); return `n${shown.length}`; },
    dismiss: id => { dismissed.push(id); },
    warning: (message, options) => { shown.push({ type: 'warning', message, ...options }); },
  };
}


/**
 * Web Locks shared by the fake tabs of one browser (`navigator.locks`):
 * `request(name, {ifAvailable: true}, callback)` and `query()`.
 */
export function sharedLocks() {
  const held = new Map();
  return {
    held,
    async request(name, options, callback) {
      if (held.has(name)) return callback(null);
      let release;
      const done = new Promise(resolve => { release = resolve; });
      held.set(name, done);
      const result = callback({ name });
      await result;
      held.delete(name);
      return undefined;
    },
    async query() {
      return { held: [...held.keys()].map(name => ({ name })), pending: [] };
    },
  };
}
