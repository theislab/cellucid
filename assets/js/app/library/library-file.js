/**
 * @fileoverview A `.cellucid-library` file: datasets of My datasets and the
 * saved states chosen, in one file, to take to Cellucid in another browser
 * (or keep as a backup). Importing it adds beside what that browser keeps:
 * nothing there is replaced.
 *
 * **Framing**: the session bundle's (`session/bundle/`: signature, u32
 * manifest length, JSON manifest, u32-framed chunks, with the reader's
 * bounds and refusals), under its own signature `CELLUCID_LIBRARY/1\n`
 * ({@link LIBRARY_SIGNATURE}). A session file given to the importer is
 * refused saying it is one, and a library file given to the session loader
 * too (`bundle/format.js`).
 *
 * **Manifest** (JSON, keys in this order):
 * - `createdAt`: canonical ISO time of the export;
 * - `app`: `{version}`, the Cellucid that wrote it;
 * - `datasets`: My datasets records, each as `readRecord` gives it
 *   (`my-datasets.js`, `LIBRARY_RECORD_VERSION`): how it opens again, never
 *   what a link carried to grant access;
 * - `histories`: `{chunk, name, kind, dataset: {id, name}, createdAt,
 *   updatedAt}` per saved state: the chunk holding it, its name (null for an
 *   autosave), `autosave` or `named`, the dataset it is kept under, and its
 *   times (ms);
 * - `chunks`: `{id, kind: 'session', codec: 'none', storedBytes}`, one per
 *   history, in the order of `histories`.
 *
 * **A chunk** is one complete `.cellucid-session` file (format 4,
 * `session/history-file.js`) of the saved state, read whole from this
 * browser (`openSavedState`): every tracker and branch, with every value,
 * analysis results, notes, conversations and Recently deleted, exact times
 * and where the dataset opens from (its scope is {@link LIBRARY_SCOPE}). It
 * is stored as it is (`codec: 'none'`): a session file's chunks are already
 * compressed. Changes made while recording was paused (a paused draft) are
 * not a step and no session file holds one (a page squashes it into a step
 * before it writes): they are left out, the tracker stays paused, and the
 * export says how many histories had one.
 *
 * **Untrusted input** (`importLibrary`): the manifest is checked exactly,
 * every dataset record with `readRecord`, and every history read whole and
 * checked (`readHistoryFile`) before anything is added. Then every dataset
 * the list does not hold is added (`library.add`, which never replaces one),
 * and every history is kept as a named saved state "<name> (imported)"
 * beside the others (`keepAsSavedStates`, in one transaction), so importing twice keeps two
 * copies.
 *
 * @module app/library/library-file
 */

import { readBundle } from '../session/bundle/reader.js';
import { writeBundle } from '../session/bundle/writer.js';
import { LIBRARY_SIGNATURE_PREFIX, SESSION_SIGNATURE } from '../session/bundle/format.js';
import { readHistoryFile, sessionHeaderOf, writeHistoryFile } from '../session/history-file.js';
import { actionStamps, appStamp } from '../session/app-stamp.js';
import { recordFields } from '../history/model.js';
import { keepAsSavedStates, listSavedStates, openSavedState, removeSavedStates } from '../history/autosave.js';
import { defaultHistoryStore } from '../history/autosave-store.js';
import { getActionCatalog } from '../actions/index.js';
import { PLACES, placePath } from '../ui/place-names.js';
import { pageVersion } from '../utils/page-version.js';
import { myDatasets, readRecord } from './my-datasets.js';
import { isPlainRecord } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';

/** The file name's extension. */
export const LIBRARY_FILE_EXTENSION = '.cellucid-library';

/** The library file format this release writes and reads. */
export const LIBRARY_FORMAT_VERSION = 1;

/** What an imported saved state's name ends with. */
export const IMPORTED_SUFFIX = ' (imported)';

/** Shown verbatim for a file that does not start with a library signature. */
export const NOT_A_LIBRARY_FILE_MESSAGE =
  `This file is not a Cellucid library file of format ${LIBRARY_FORMAT_VERSION} `
  + `(it does not start with ${LIBRARY_SIGNATURE_PREFIX}${LIBRARY_FORMAT_VERSION}).`;

/** Shown verbatim for a session file given to the library importer. */
export const SESSION_FILE_NOT_A_LIBRARY_MESSAGE =
  'This file is a Cellucid session file (the history of one dataset), not a library file. '
  + `Open it with ${placePath(PLACES.state, PLACES.sessionFile)} › Load… › Open a session file…`;

const SESSION_PREFIX = new TextDecoder('ascii').decode(SESSION_SIGNATURE.bytes).replace(/\d+\n$/, '');

/**
 * Why a file whose first bytes are `magic` is not read as a library file: a
 * session file, a library file of another format version, or neither.
 *
 * @param {Uint8Array} magic
 * @returns {string}
 */
export function librarySignatureRefusal(magic) {
  const text = new TextDecoder('ascii').decode(magic);
  if (text.startsWith(SESSION_PREFIX)) return SESSION_FILE_NOT_A_LIBRARY_MESSAGE;
  const match = text.startsWith(LIBRARY_SIGNATURE_PREFIX)
    ? /^(\d+)(?:\n|$)/.exec(text.slice(LIBRARY_SIGNATURE_PREFIX.length))
    : null;
  const version = match === null ? null : Number(match[1]);
  if (version === null || version === 0 || version === LIBRARY_FORMAT_VERSION) return NOT_A_LIBRARY_FILE_MESSAGE;
  return `This library file was written by ${version > LIBRARY_FORMAT_VERSION ? 'a newer' : 'an earlier'} version of Cellucid `
    + `(library format ${version}), which this version cannot read. Import it in that version of Cellucid.`;
}

/** @type {import('../session/bundle/format.js').BundleSignature} */
export const LIBRARY_SIGNATURE = Object.freeze({
  bytes: new TextEncoder().encode(`${LIBRARY_SIGNATURE_PREFIX}${LIBRARY_FORMAT_VERSION}\n`),
  file: 'library file',
  label: 'Library',
  refusal: librarySignatureRefusal,
});

/**
 * What each history of a library file holds: all of what its saved state
 * keeps, as the person's own backup, conversations included (they can be
 * private: the export says so). `content` is the saved state's own (the
 * history, the current state only, or the steps only).
 */
export const LIBRARY_SCOPE = Object.freeze({
  content: 'history', results: 'include', notes: true, chats: true, journal: true, times: 'exact', source: 'full',
});

const MANIFEST_KEYS = Object.freeze(['createdAt', 'app', 'datasets', 'histories', 'chunks']);
const HISTORY_KEYS = Object.freeze(['chunk', 'name', 'kind', 'dataset', 'createdAt', 'updatedAt']);
const CHUNK_KEYS = Object.freeze(['id', 'kind', 'codec', 'storedBytes']);
const TRACKER_KEYS = Object.freeze(recordFields('Tracker'));

/** A file that breaks the format: says what, for the person who chose it. */
function damaged(what, cause = undefined) {
  return new TypeError(`This library file is damaged: ${what}`, cause === undefined ? undefined : { cause });
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function textOrNull(value) {
  return value === null || isText(value);
}

/** Branch ids in their order (`b1`, `b2`, … by number). */
function branchOrder(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

/**
 * A saved state of this browser, read whole, as a `.cellucid-session` file.
 *
 * @returns {Promise<{blob: Blob, paused: boolean}>} `paused`: a paused draft was left out
 */
async function savedStateAsSessionFile(id, { store, app, catalog }) {
  const source = await openSavedState(id, store);
  const eager = await source.readEager();
  const rest = await source.readRest();
  const values = new Map([...eager.values, ...rest.values]);
  const paused = eager.history.trackers.some(tracker => tracker.paused?.draft != null);
  // A file holds no paused draft (a page squashes it into a step first; a
  // saved state is not a page): it is left out, the recording stays paused.
  const trackers = eager.history.trackers.map(tracker => ({
    ...Object.fromEntries(TRACKER_KEYS.map(key => [key, tracker[key]])),
    paused: tracker.paused === null ? null : { ...tracker.paused, draft: null },
  }));
  const scope = {
    trackers: trackers.map(tracker => tracker.id),
    branches: trackers.map(tracker => ({ tracker: tracker.id, branches: tracker.branches.map(branch => branch.id).sort(branchOrder) })),
    ...LIBRARY_SCOPE,
    // What the saved state holds: the history, the current state only, or the steps only (no values, results run again).
    content: source.content,
    results: source.content === 'steps' ? 'recompute' : LIBRARY_SCOPE.results,
  };
  const steps = trackers.flatMap(tracker => [
    ...tracker.steps, ...tracker.journal.flatMap(entry => (entry.purged ? [] : [...entry.before.steps, ...entry.after.steps])),
  ]);
  const blob = await writeHistoryFile({
    header: source.header,
    app,
    actions: await actionStamps(steps, catalog),
    scope,
    history: { activeTracker: eager.history.activeTracker, trackers },
    valueOf: hash => values.get(hash),
    chrome: source.chrome,
  });
  return { blob, paused };
}

/**
 * Write a `.cellucid-library` file of the datasets `datasets` (ids; null:
 * every one of My datasets) and the saved states `savedStates` (ids; left
 * out: the saved states of the datasets chosen this version can open).
 * Every saved state is read whole from this browser; one that cannot be
 * read fails the export, naming it.
 *
 * @param {{datasets?: Iterable<string>|null, savedStates?: Iterable<string>,
 *   library?: ReturnType<typeof myDatasets>,
 *   store?: ReturnType<typeof import('../history/autosave-store.js').createHistoryStore>|null,
 *   version?: string, catalog?: {has: Function, get: Function}, now?: () => number}} [options] -
 *   `version`: the Cellucid version that writes (the page's by default)
 * @returns {Promise<{blob: Blob, datasets: number, histories: number, paused: number}>} `paused`:
 *   how many histories had changes made while paused, which are left out
 */
export async function exportLibrary({
  datasets = null, savedStates = undefined, library = myDatasets(), store = defaultHistoryStore(),
  version = undefined, catalog = getActionCatalog(), now = Date.now,
} = {}) {
  const listed = await library.list();
  const chosenIds = datasets === null ? null : new Set(datasets);
  const chosen = listed.filter(record => chosenIds === null || chosenIds.has(record.id));
  if (chosenIds !== null && chosen.length !== chosenIds.size) {
    throw new RangeError(`A dataset chosen for the library file is no longer in ${PLACES.myDatasets.name}.`);
  }
  const states = await listSavedStates(store);
  let wanted;
  if (savedStates === undefined) {
    const of = new Set(chosen.map(record => record.id));
    wanted = states.filter(state => of.has(state.dataset.id) && state.openable);
  } else {
    const ids = new Set(savedStates);
    wanted = states.filter(state => ids.has(state.id));
    if (wanted.length !== ids.size) throw new RangeError('A saved state chosen for the library file is no longer kept in this browser.');
  }
  const named = version ?? pageVersion();
  if (named === null) throw new Error('This page names no Cellucid version, so a library file cannot say what wrote it.');
  const app = await appStamp({ catalog, version: named });

  const chunks = [];
  const metas = [];
  const histories = [];
  let paused = 0;
  for (const state of wanted) {
    let written;
    try {
      written = await savedStateAsSessionFile(state.id, { store, app, catalog });
    } catch (error) {
      const name = state.name ?? `the autosave of ${state.dataset.name ?? 'a dataset'}`;
      throw new Error(`The saved state "${name}" could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (written.paused) paused++;
    const bytes = new Uint8Array(await written.blob.arrayBuffer());
    const id = `history/${histories.length}`;
    chunks.push(bytes);
    metas.push({ id, kind: 'session', codec: 'none', storedBytes: bytes.byteLength });
    histories.push({
      chunk: id, name: state.name, kind: state.kind, dataset: { id: state.dataset.id, name: state.dataset.name },
      createdAt: state.createdAt, updatedAt: state.updatedAt,
    });
  }
  const manifest = {
    createdAt: new Date(now()).toISOString(),
    app: { version: app.version },
    datasets: chosen.map(record => structuredClone(record)),
    histories,
    chunks: metas,
  };
  // What is written is what the importer accepts.
  assertLibraryManifest(manifest);
  return {
    blob: writeBundle({ manifest, chunks, signature: LIBRARY_SIGNATURE }),
    datasets: chosen.length,
    histories: histories.length,
    paused,
  };
}

/**
 * Check a library file's manifest exactly: its keys, every dataset record
 * (`readRecord`), every history and chunk, each chunk named by one history.
 *
 * @param {unknown} manifest
 * @returns {{createdAt: string, app: {version: string}, datasets: Object[], histories: Object[], chunks: Object[]}}
 */
export function assertLibraryManifest(manifest) {
  if (!isPlainRecord(manifest) || !sameKeys(manifest, MANIFEST_KEYS)) throw damaged(`its manifest must be exactly {${MANIFEST_KEYS.join(', ')}}.`);
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))
    || new Date(manifest.createdAt).toISOString() !== manifest.createdAt) {
    throw damaged('its manifest createdAt must be a canonical ISO time.');
  }
  if (!isPlainRecord(manifest.app) || Object.keys(manifest.app).length !== 1 || !isText(manifest.app.version)) {
    throw damaged('its manifest app must be exactly {version}.');
  }
  for (const key of ['datasets', 'histories', 'chunks']) {
    if (!Array.isArray(manifest[key])) throw damaged(`its manifest ${key} must be a list.`);
  }
  const ids = new Set();
  manifest.datasets.forEach((record, index) => {
    if (readRecord(record?.id, record) === null) throw damaged(`dataset ${index + 1} is not a My datasets record this version reads.`);
    if (ids.has(record.id)) throw damaged(`the dataset "${record.id}" is listed twice.`);
    ids.add(record.id);
  });
  const chunkIds = new Set();
  manifest.chunks.forEach((chunk, index) => {
    if (!isPlainRecord(chunk) || !sameKeys(chunk, CHUNK_KEYS) || !isText(chunk.id) || chunk.kind !== 'session' || chunk.codec !== 'none'
      || !Number.isSafeInteger(chunk.storedBytes) || chunk.storedBytes <= 0) {
      throw damaged(`chunk ${index + 1} must be exactly {id, kind: "session", codec: "none", storedBytes}.`);
    }
    if (chunkIds.has(chunk.id)) throw damaged(`the chunk "${chunk.id}" is listed twice.`);
    chunkIds.add(chunk.id);
  });
  if (manifest.histories.length !== manifest.chunks.length) throw damaged('it must name one history per chunk.');
  manifest.histories.forEach((history, index) => {
    const label = `history ${index + 1}`;
    if (!isPlainRecord(history) || !sameKeys(history, HISTORY_KEYS)) throw damaged(`${label} must be exactly {${HISTORY_KEYS.join(', ')}}.`);
    if (history.chunk !== manifest.chunks[index].id) throw damaged(`${label} must name its chunk, in order.`);
    if (!textOrNull(history.name)) throw damaged(`${label} name must be a text or null.`);
    if (history.kind !== 'autosave' && history.kind !== 'named') throw damaged(`${label} kind must be autosave or named.`);
    if (!isPlainRecord(history.dataset) || !sameKeys(history.dataset, ['id', 'name'])
      || !textOrNull(history.dataset.id) || !textOrNull(history.dataset.name)) {
      throw damaged(`${label} dataset must be exactly {id, name}.`);
    }
    for (const key of ['createdAt', 'updatedAt']) {
      if (!Number.isFinite(history[key])) throw damaged(`${label} ${key} must be a time.`);
    }
  });
  return manifest;
}

function sameKeys(record, keys) {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

/** The name an imported saved state is kept under. */
export function importedName(history) {
  return `${history.name ?? (history.dataset.name === null ? 'Autosave' : `Autosave of ${history.dataset.name}`)}${IMPORTED_SUFFIX}`;
}

/**
 * Read a library file whole and check it: its manifest, every dataset
 * record, every history (each a session file read whole and checked by
 * `readHistoryFile`). Nothing is kept.
 *
 * @param {Blob} blob
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<{manifest: Object, sessions: Blob[]}>} `sessions`: each history's session file, in order
 */
export async function readLibraryFile(blob, { signal = null } = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('A library file is a Blob or a File.');
  const bundle = await readBundle(blob, { signal, onProgress: null, signature: LIBRARY_SIGNATURE });
  let manifest;
  try {
    manifest = assertLibraryManifest(bundle.manifest);
  } catch (error) {
    await bundle.cancel(error);
    throw error;
  }
  const sessions = [];
  for await (const { bytes } of bundle.chunkStream) sessions.push(new Blob([bytes]));
  for (let index = 0; index < sessions.length; index++) {
    try {
      await readHistoryFile(sessions[index], { signal });
    } catch (error) {
      throw damaged(`its history "${importedName(manifest.histories[index]).slice(0, -IMPORTED_SUFFIX.length)}" is not a session file this version reads: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }
  return { manifest, sessions };
}

/**
 * Import a library file: check it whole (`readLibraryFile`), keep every
 * history as a named saved state "<name> (imported)" beside the others, all
 * in one transaction, and only then add every dataset My datasets does not
 * hold (one it holds is never replaced). Nothing is added on any failure:
 * the histories kept are removed again if the datasets cannot be added, and
 * the failure is thrown, saying why.
 *
 * @param {Blob} blob
 * @param {{library?: ReturnType<typeof myDatasets>,
 *   store?: ReturnType<typeof import('../history/autosave-store.js').createHistoryStore>|null,
 *   signal?: AbortSignal|null}} [options]
 * @returns {Promise<{datasets: {added: string[], present: string[]}, histories: {added: Array<{id: string, name: string}>}}>}
 *   dataset names
 */
export async function importLibrary(blob, { library = myDatasets(), store = defaultHistoryStore(), signal = null } = {}) {
  const { manifest, sessions } = await readLibraryFile(blob, { signal });
  if (sessions.length > 0 && store === null) throw new Error('This browser keeps no saved states (it gives this site no IndexedDB), so the histories of this file cannot be imported.');
  const nameOf = new Map(manifest.datasets.map(record => [record.id, record.name]));
  const names = ids => ids.map(id => nameOf.get(id) ?? id);
  const keeping = [];
  for (let index = 0; index < sessions.length; index++) {
    const history = manifest.histories[index];
    const read = await readHistoryFile(sessions[index], { signal });
    keeping.push({
      history: read.history, valueOf: hash => read.values.get(hash), content: read.manifest.scope.content,
      header: sessionHeaderOf(read.manifest), dataset: history.dataset, name: importedName(history),
      createdAt: history.createdAt, updatedAt: history.updatedAt,
      chrome: read.manifest.chrome, app: read.manifest.app, actions: read.manifest.actions,
    });
  }
  const kept = keeping.length === 0 ? [] : await keepAsSavedStates(keeping, store);
  let datasets;
  try {
    datasets = await library.add(manifest.datasets);
    if (datasets.failed.length > 0) {
      await library.forget(datasets.added);
      throw new Error(`${formatCountOf(datasets.failed.length, 'dataset')} could not be added to ${PLACES.myDatasets.name}.`);
    }
  } catch (error) {
    if (kept.length > 0) await removeSavedStates(kept.map(({ id }) => id), store);
    throw error;
  }
  return {
    datasets: { added: names(datasets.added), present: names(datasets.present) },
    histories: { added: kept.map(({ id }, index) => ({ id, name: keeping[index].name })) },
  };
}
