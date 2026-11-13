/**
 * @fileoverview The saved states kept in this browser: the records of the
 * history's autosave and of named saves, in the IndexedDB database
 * `cellucid-history` (`utils/indexed-db-database.js`).
 *
 * Object stores, all written together in one transaction, so a crash or a
 * closed tab leaves either the whole of a write or none of it: every
 * transaction here reads what it needs first and then makes all its writes
 * at once (`utils/indexed-db-database.js` says why writes awaited one after
 * another are not all or none when the page goes away). Each store holds
 * one record per thing that changes on its own, so a write costs what
 * changed, not the history:
 *
 * - `entries` (key: the saved state's id): one record per saved state
 *   ({@link SAVED_STATE_SCHEMA}): its kind (`autosave` or `named`), name,
 *   dataset, the session header that says how to reopen it (fingerprint,
 *   source, cells, genes, requires; `app/session/history-file.js`), when it
 *   was made and last written, its active tracker and trackers listed (id,
 *   name, steps), what it keeps (steps, conversations, notes, a paused
 *   draft), its size, and which page writes it (`owner`).
 * - `trackers` (`[state, tracker]`): a tracker's record (the model's
 *   `Tracker`, `app/history/model.js`) without its steps, turns, journal and
 *   conversations, which have stores of their own.
 * - `steps` (`[state, tracker, step]`): one step, its parameters and outcome
 *   as skeletons (`value-parts.js`).
 * - `turns` (`[state, tracker, turn]`), `journal` (`[state, tracker,
 *   entry]`, its patches' steps as skeletons).
 * - `chats` (`[state, tracker, conversation]`): a conversation's transcript
 *   without its messages, and how many it has; `messages` (`[state, tracker,
 *   conversation, index]`): one message each, so a message added writes one
 *   record, not the whole conversation again.
 * - `values` (key: the value's hash): `{skeleton, arrays, parts}`, written
 *   once whatever number of saved states refer to it.
 * - `parts` (key: the part's name): `{skeleton, arrays, parts}`, a sub-value
 *   several values share, written once (`value-parts.js`).
 * - `arrays` (key: the array's digest): `{encoding, data}`: `raw` (the typed
 *   array) or `cell-set` (a strictly increasing Uint32Array in the session
 *   file's cell-set encoding, where that is smaller: a brush of a million cells
 *   is a few kilobytes, not megabytes).
 *
 * A value, part or array no saved state refers to any more is removed by
 * `collect` (with a removal, and once a page has started its history), in
 * the same transaction as it reads what the saved states refer to.
 *
 * **One writer per saved state.** A write names its `owner` (the page's
 * autosave); a saved state another page has taken over since is refused
 * ({@link SavedStateTaken}) and nothing of the write is kept, so two pages
 * can never mix their steps into one history. Taking
 * one over (`claim`) rewrites it whole.
 *
 * @module app/history/autosave-store
 */

import { stepHashes } from './step-records.js';
import { indexedDbDatabase } from '../../utils/indexed-db-database.js';
import { skeletonArrays, skeletonParts } from './value-parts.js';

export const HISTORY_DATABASE = 'cellucid-history';
const HISTORY_DATABASE_VERSION = 2;
const STORES = Object.freeze(['entries', 'trackers', 'steps', 'turns', 'journal', 'chats', 'messages', 'values', 'parts', 'arrays']);
/** The stores keyed by `[state, tracker, …]`: what one saved state's trackers hold. */
const TRACKER_STORES = Object.freeze(['trackers', 'steps', 'turns', 'journal', 'chats', 'messages']);

/** The layout of a saved state's records; a record of another layout is listed, never opened. */
export const SAVED_STATE_SCHEMA = 2;

/** A saved state written in part was removed meanwhile: it is written whole again. */
export class SavedStateGone extends Error {
  constructor(id) {
    super(`The saved state ${id} was removed`);
    this.name = 'SavedStateGone';
    this.id = id;
  }
}

/** Another page took the saved state over since: this page keeps its history as a copy. */
export class SavedStateTaken extends Error {
  constructor(id) {
    super(`The saved state ${id} is written by another page now`);
    this.name = 'SavedStateTaken';
    this.id = id;
  }
}

/**
 * A write left out values, parts or arrays the saved state was thought to
 * hold, and one of them is gone (a removal anywhere collected what no saved
 * state named at that moment): nothing was written, and the saved state is
 * written whole again.
 */
export class SavedStateRecordsGone extends Error {
  constructor(id, missing) {
    super(`The saved state ${id} no longer holds ${missing}`);
    this.name = 'SavedStateRecordsGone';
    this.id = id;
  }
}

/** The page's store, opened once (null without IndexedDB). */
let pageStore;

/**
 * The saved states of this browser, or null where the page has no IndexedDB
 * (a private window of some browsers).
 *
 * @returns {ReturnType<typeof createHistoryStore>|null}
 */
export function defaultHistoryStore() {
  if (pageStore === undefined) {
    const database = indexedDbDatabase(HISTORY_DATABASE, { version: HISTORY_DATABASE_VERSION, stores: [...STORES] });
    pageStore = database === null ? null : createHistoryStore(database);
  }
  return pageStore;
}


/**
 * The batch of one write.
 *
 * @typedef {{
 *   entry: object,
 *   owner: string,
 *   mode: 'update'|'whole'|'claim',
 *   trackers: Array<object>,
 *   removedTrackers: string[],
 *   steps: Array<{tracker: string, step: object}>,
 *   removedSteps: Array<{tracker: string, step: string}>,
 *   turns: Array<{tracker: string, turn: object}>,
 *   removedTurns: Array<{tracker: string, turn: string}>,
 *   journal: Array<{tracker: string, entry: object}>,
 *   removedJournal: Array<{tracker: string, entry: string}>,
 *   chats: Array<{tracker: string, conversation: string, head: unknown, messages: Array<{index: number, message: unknown}>, count: number}>,
 *   values: Array<{hash: string, record: object}>,
 *   parts: Array<{name: string, record: object}>,
 *   arrays: Array<{digest: string, record: {encoding: string, data: ArrayBufferView}}>,
 *   relies?: {values: string[], parts: string[], arrays: string[]},
 * }} HistoryWrite - `relies`: the values, parts and arrays left out because the
 *   saved state holds them already, checked in the same transaction
 */

/**
 * One batch of `write`, inside its transaction (`HistoryWrite`): what it
 * reads first (whether this page may write the saved state, that what the
 * batch left out is still held, which arrays, parts and values the store
 * lacks), refusing the write there. Resolves to the batch's writes, which
 * the caller makes at once.
 *
 * @returns {Promise<() => void>}
 */
async function planWrite(tx, batch) {
  const { entry, owner, mode } = batch;
  const stored = await tx.get('entries', entry.id);
  if (mode === 'update') {
    if (stored === undefined) throw new SavedStateGone(entry.id);
    if (stored.owner !== owner) throw new SavedStateTaken(entry.id);
  }
  // Written whole again (after a failed write, room made, the autosave switched on again):
  // still this page's, or it was continued elsewhere meanwhile and is left to that page.
  if (mode === 'whole' && stored !== undefined && stored.owner !== owner) throw new SavedStateTaken(entry.id);
  for (const [name, kind] of [['values', 'value'], ['parts', 'part'], ['arrays', 'array']]) {
    for (const key of batch.relies?.[name] ?? []) {
      if (!await tx.has(name, key)) throw new SavedStateRecordsGone(entry.id, `the ${kind} ${String(key).slice(0, 24)}…`);
    }
  }
  // Written once whatever number of saved states refer to them: only those the store lacks.
  const arrays = [];
  for (const item of batch.arrays) if (!await tx.has('arrays', item.digest)) arrays.push(item);
  const parts = [];
  for (const item of batch.parts) if (!await tx.has('parts', item.name)) parts.push(item);
  const values = [];
  for (const item of batch.values) if (!await tx.has('values', item.hash)) values.push(item);
  return () => {
    if (mode === 'claim' || (mode === 'whole' && stored !== undefined)) {
      for (const name of TRACKER_STORES) tx.delete(name, { prefix: [entry.id] });
    }
    for (const { digest, record } of arrays) tx.put('arrays', digest, record);
    for (const { name, record } of parts) tx.put('parts', name, record);
    for (const { hash, record } of values) tx.put('values', hash, record);
    for (const tracker of batch.removedTrackers) {
      for (const name of TRACKER_STORES) {
        if (name === 'trackers') tx.delete(name, [entry.id, tracker]);
        else tx.delete(name, { prefix: [entry.id, tracker] });
      }
    }
    for (const { tracker, step } of batch.removedSteps) tx.delete('steps', [entry.id, tracker, step]);
    for (const { tracker, turn } of batch.removedTurns) tx.delete('turns', [entry.id, tracker, turn]);
    for (const { tracker, entry: id } of batch.removedJournal) tx.delete('journal', [entry.id, tracker, id]);
    for (const record of batch.trackers) tx.put('trackers', [entry.id, record.id], record);
    for (const { tracker, step } of batch.steps) tx.put('steps', [entry.id, tracker, step.id], step);
    for (const { tracker, turn } of batch.turns) tx.put('turns', [entry.id, tracker, turn.id], turn);
    for (const { tracker, entry: record } of batch.journal) tx.put('journal', [entry.id, tracker, record.id], record);
    for (const { tracker, conversation, head, messages, count } of batch.chats) {
      tx.put('chats', [entry.id, tracker, conversation], { head, count });
      for (const { index, message } of messages) tx.put('messages', [entry.id, tracker, conversation, index], message);
      // Messages past the count (a conversation cut short) go.
      tx.delete('messages', { prefix: [entry.id, tracker, conversation], from: count });
    }
    tx.put('entries', entry.id, { ...entry, owner });
  };
}

/**
 * The saved-state records over one database (`indexedDbDatabase`, or a
 * stand-in with the same transaction interface in tests).
 *
 * @param {import('../../utils/indexed-db-database.js').Database} database
 */
export function createHistoryStore(database) {
  return Object.freeze({
    /**
     * Write one batch, all of it or none.
     *
     * - `update`: only what changed since this owner's last write; refused
     *   with {@link SavedStateGone} when the saved state was removed
     *   meanwhile (here, or in another tab) and with {@link SavedStateTaken}
     *   when another owner writes it now.
     * - `whole`: the saved state as it is, every record of it (a new saved
     *   state, a named save, a history written again); refused with
     *   {@link SavedStateTaken} when another owner writes it now.
     * - `claim`: take a saved state over (continuing it here): whatever it
     *   held is replaced by this batch, which holds it whole.
     *
     * Values, parts and arrays already stored are not written again. Those
     * a batch left out as already held (`relies`) are checked first: one
     * that is gone refuses the write with {@link SavedStateRecordsGone}.
     *
     * @param {HistoryWrite} batch
     */
    write(batch) {
      return database.transaction([...STORES], 'readwrite', async tx => {
        const write = await planWrite(tx, batch);
        write();
      });
    },
    /**
     * Write several new saved states (whole batches of new ids) in one
     * transaction: all of them, or none (a library file imported).
     *
     * @param {HistoryWrite[]} batches
     */
    writeAll(batches) {
      return database.transaction([...STORES], 'readwrite', async tx => {
        const writes = [];
        for (const batch of batches) writes.push(await planWrite(tx, batch));
        for (const write of writes) write();
      });
    },
    /** Every saved state's record. */
    list() {
      return database.transaction(['entries'], 'readonly', tx => tx.getAll('entries'));
    },
    /**
     * One saved state whole: its record and every record of its trackers
     * (each with the tracker's id), or null when it is gone.
     */
    read(id) {
      return database.transaction(['entries', ...TRACKER_STORES], 'readonly', async tx => {
        const entry = await tx.get('entries', id);
        if (entry === undefined) return null;
        const keyed = async name => {
          const keys = await tx.getAllKeys(name, { prefix: [id] });
          const records = await tx.getAll(name, { prefix: [id] });
          return keys.map((key, i) => ({ key, record: records[i] }));
        };
        return {
          entry,
          trackers: (await keyed('trackers')).map(({ record }) => record),
          steps: (await keyed('steps')).map(({ key, record }) => ({ tracker: key[1], step: record })),
          turns: (await keyed('turns')).map(({ key, record }) => ({ tracker: key[1], turn: record })),
          journal: (await keyed('journal')).map(({ key, record }) => ({ tracker: key[1], entry: record })),
          chats: (await keyed('chats')).map(({ key, record }) => ({ tracker: key[1], conversation: key[2], ...record })),
          messages: (await keyed('messages')).map(({ key, record }) => ({ tracker: key[1], conversation: key[2], index: key[3], message: record })),
        };
      });
    },
    /** The records of `keys` in `store` (`values`, `parts` or `arrays`); a key not stored is missing from the map. */
    readMany(store, keys) {
      return database.transaction([store], 'readonly', async tx => {
        const out = new Map();
        for (const key of keys) {
          const record = await tx.get(store, key);
          if (record !== undefined) out.set(key, record);
        }
        return out;
      });
    },
    /** Change one saved state's record (`change(record)` returns the new one); false when it is gone. */
    update(id, change) {
      return database.transaction(['entries'], 'readwrite', async tx => {
        const entry = await tx.get('entries', id);
        if (entry === undefined) return false;
        tx.put('entries', id, change(entry));
        return true;
      });
    },
    /**
     * Remove the saved states `ids` with their records, and every value,
     * part and array no saved state left refers to, in one transaction.
     * Resolves to how many saved states were removed.
     *
     * @param {Iterable<string>} ids
     */
    remove(ids) {
      const wanted = [...ids];
      return database.transaction([...STORES], 'readwrite', async tx => {
        let removed = 0;
        for (const id of wanted) if (await tx.has('entries', id)) removed++;
        // What no saved state refers to once these are gone, read before anything is removed.
        const collect = await planCollect(tx, new Set(wanted));
        for (const id of wanted) {
          tx.delete('entries', id);
          for (const name of TRACKER_STORES) tx.delete(name, { prefix: [id] });
        }
        collect();
        return removed;
      });
    },
    /** Remove every value, part and array no saved state refers to (what replaced work left behind). */
    collect() {
      return database.transaction([...STORES], 'readwrite', async tx => {
        const collect = await planCollect(tx);
        collect();
      });
    },
  });
}

/** What the trackers' records name: value hashes, and the parts and arrays their skeletons name directly. */
function referencedBy({ steps, journal, trackers }) {
  const hashes = new Set();
  const parts = new Set();
  const arrays = new Set();
  const stepRefs = step => {
    for (const hash of stepHashes(step)) hashes.add(hash);
    for (const skeleton of [step.params, step.outcome]) {
      for (const digest of skeletonArrays(skeleton)) arrays.add(digest);
      for (const name of skeletonParts(skeleton)) parts.add(name);
    }
  };
  steps.forEach(stepRefs);
  for (const entry of journal) if (!entry.purged) for (const step of [...entry.before.steps, ...entry.after.steps]) stepRefs(step);
  // A paused draft's values are the person's work too.
  for (const tracker of trackers) for (const hash of Object.values(tracker.paused?.draft ?? {})) hashes.add(hash);
  return { hashes, parts, arrays };
}

/**
 * What `collect` reads inside its transaction: every value, part and array
 * no saved state refers to, the saved states `without` left out as if they
 * were gone already. Resolves to their removal, which the caller makes at
 * once.
 *
 * @param {import('../../utils/indexed-db-database.js').DatabaseTransaction} tx
 * @param {Set<string>} [without]
 * @returns {Promise<() => void>}
 */
async function planCollect(tx, without = new Set()) {
  const kept = async name => {
    const keys = await tx.getAllKeys(name);
    const records = await tx.getAll(name);
    return records.filter((_, index) => !without.has(keys[index][0]));
  };
  const { hashes, parts, arrays } = referencedBy({
    steps: await kept('steps'), journal: await kept('journal'), trackers: await kept('trackers'),
  });
  const gone = { values: [], parts: [], arrays: [] };
  const valueKeys = await tx.getAllKeys('values');
  const valueRecords = await tx.getAll('values');
  for (let i = 0; i < valueKeys.length; i++) {
    if (!hashes.has(valueKeys[i])) {
      gone.values.push(valueKeys[i]);
      continue;
    }
    for (const name of valueRecords[i]?.parts ?? []) parts.add(name);
    for (const digest of valueRecords[i]?.arrays ?? []) arrays.add(digest);
  }
  // Parts name parts: what is reached from a kept one is kept.
  const partKeys = await tx.getAllKeys('parts');
  const partRecords = new Map((await tx.getAll('parts')).map((record, i) => [partKeys[i], record]));
  const queue = [...parts];
  while (queue.length > 0) {
    const record = partRecords.get(queue.pop());
    if (record === undefined) continue;
    for (const digest of record.arrays ?? []) arrays.add(digest);
    for (const name of record.parts ?? []) if (!parts.has(name)) { parts.add(name); queue.push(name); }
  }
  for (const key of partKeys) if (!parts.has(key)) gone.parts.push(key);
  for (const digest of await tx.getAllKeys('arrays')) if (!arrays.has(digest)) gone.arrays.push(digest);
  return () => {
    for (const name of ['values', 'parts', 'arrays']) for (const key of gone[name]) tx.delete(name, key);
  };
}
