/**
 * The decoders the probe decided on (`decoder-choice.js`), kept in this
 * browser so that only a first visit measures them.
 *
 * - **Where**: IndexedDB, database `cellucid-decoders`, one record
 *   (`DECODER_MEMORY_KEY`): `{version, decided, at}`, `decided` the decoder
 *   of each key (`deflate:15` → `fflate`). Nothing about a dataset, a link
 *   or a person: codec families, size classes and decoder names.
 * - **Version** (`decoderMemoryVersion`): the WebAssembly module's digest
 *   (`assets/workers/scripts.js` `codecsWasm`, its `?v=`), every family's
 *   decoder list, the browser's user agent (its engine and version) and its
 *   cores. A record of another version is not used: a new module, a decoder
 *   added or removed, a browser update or another machine's profile
 *   measures again, and the record is replaced by the first decision made.
 * - **Read** once, by the thread that runs the decode pool, when the pool
 *   is made (`decode-pool.js`); until it is read the pool decodes with the
 *   priors and measures nothing. **Written** on each decision, merged into
 *   the record of the same version.
 * - A browser that keeps nothing (no IndexedDB, a private window that
 *   refuses it, an error) measures on every visit, as before: keeping is a
 *   convenience, never required. The Stored dialog's Remove all forgets
 *   the record (`forgetDecoderDecisions`).
 *
 * @module formats/io/decoder-memory
 */

import { codecsWasm } from '../../../workers/scripts.js';
import { indexedDbKeyValueStore } from '../../utils/indexed-db-store.js';
import { DECODERS } from './decoder-choice.js';

/** The database the record is kept in, and its object store. */
export const DECODER_MEMORY_DATABASE = 'cellucid-decoders';
export const DECODER_MEMORY_STORE = 'decisions';
/** The record's key in its store. */
export const DECODER_MEMORY_KEY = 'decided';

/**
 * The version a record is kept under (see the module notes).
 *
 * @param {{navigator?: {userAgent?: string, hardwareConcurrency?: number}}} [environment]
 * @returns {string}
 */
export function decoderMemoryVersion(environment = globalThis) {
  const navigator = environment?.navigator ?? {};
  return JSON.stringify({
    module: codecsWasm().searchParams.get('v'),
    decoders: DECODERS,
    agent: String(navigator.userAgent ?? ''),
    cores: Number(navigator.hardwareConcurrency) || 0,
  });
}

/** This browser's store of the record, or null where it keeps none. */
export function decoderMemoryStore(factory = globalThis.indexedDB) {
  return indexedDbKeyValueStore(DECODER_MEMORY_DATABASE, DECODER_MEMORY_STORE, factory);
}

/**
 * The decisions kept under `version`, by key; empty when none are (another
 * version, nothing kept, a store that fails).
 *
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} store
 * @param {string} version
 * @returns {Promise<Object<string, string>>}
 */
export async function recallDecoderDecisions(store, version) {
  if (store === null) return {};
  try {
    const record = await store.get(DECODER_MEMORY_KEY);
    if (record === null || typeof record !== 'object' || record.version !== version) return {};
    const decided = record.decided;
    if (decided === null || typeof decided !== 'object') return {};
    return Object.fromEntries(Object.entries(decided).filter(([key, decoder]) => typeof key === 'string' && typeof decoder === 'string'));
  } catch {
    return {};
  }
}

/**
 * Keep `decided` (by key) under `version`: merged into the record of the
 * same version, replacing one of another. A store that fails keeps nothing.
 *
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} store
 * @param {string} version
 * @param {Object<string, string>} decided
 * @param {number} [now]
 * @returns {Promise<void>}
 */
export async function keepDecoderDecisions(store, version, decided, now = Date.now()) {
  if (store === null) return;
  try {
    const kept = await recallDecoderDecisions(store, version);
    await store.put(DECODER_MEMORY_KEY, { version, decided: { ...kept, ...decided }, at: now });
  } catch {
    // Kept only as a convenience: the next visit measures again.
  }
}

/**
 * How many decisions this browser keeps (any version): what the Stored
 * dialog lists. 0 where none are, or the store fails.
 *
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<number>}
 */
export async function countDecoderDecisions(store = decoderMemoryStore()) {
  if (store === null) return 0;
  try {
    const decided = (await store.get(DECODER_MEMORY_KEY))?.decided;
    return decided !== null && typeof decided === 'object' ? Object.keys(decided).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Forget the decisions kept in this browser (the Stored dialog's Remove all).
 *
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<boolean>} Whether a record was there
 */
export async function forgetDecoderDecisions(store = decoderMemoryStore()) {
  if (store === null) return false;
  try {
    const had = (await store.get(DECODER_MEMORY_KEY)) !== undefined;
    await store.delete(DECODER_MEMORY_KEY);
    return had;
  } catch {
    return false;
  }
}
