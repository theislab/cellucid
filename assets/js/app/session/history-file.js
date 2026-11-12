/**
 * @fileoverview Session format 4: a history in one file (History v2 §3.8).
 *
 * A `.cellucid-session` file holds what a Save or a Share chose of the
 * dataset's history (`scope`): trackers, each a tree of steps with its
 * branches, groups, turns, notes and, when chosen, its journal and
 * conversations (`app/history/model.js`'s records), and every value of the
 * history's pool the steps refer to (`app/history/value-pool.js`). The
 * framing is `bundle/format.js` (signature `CELLUCID_SESSION/4\n`, u32
 * frames); this module is what the manifest and the chunks say. The layout is
 * written out in `app/session/README.md`; Python and R read the same.
 *
 * **Manifest** (JSON, keys in this order): `createdAt`, `app`, `actions`,
 * `scope`, `datasetFingerprint`, `source`, `requires`, `chrome` (the page
 * chrome it carries outside its history: `assertPageChrome`), `cells`?,
 * `genes`?, `activeTracker`, `trackers`, `chunks`. A manifest tracker is the model's
 * `Tracker` whose `steps` is the list of its steps chunks, `journal` its
 * journal chunk (or null) and `chats` its conversation chunks.
 *
 * **Chunks**, each stored with gzip where gzip saves at least a sixteenth of
 * its bytes (measured per chunk: skeletons shrink 5-8×, float arrays and
 * cell sets barely), else as they are; every eager chunk before any lazy one:
 *
 * - `steps` (eager; `tracker`): a run of one tracker's steps, JSON, in id
 *   order; `params` and `outcome` are skeletons (below).
 * - `parts` (eager or lazy): `{<name>: <skeleton>}`, sub-values stored once
 *   (`value-parts.js`).
 * - `array` (`digest`, `encoding`): one typed array, once by its digest:
 *   `raw`, or `cell-set` (a strictly increasing Uint32Array as a uvarint
 *   bound then the cell-set codec's bytes, `codecs/cell-set.js`).
 * - `values` (eager or lazy): `{<hash>: <skeleton>}`.
 * - `journal` (lazy; `tracker`): one tracker's journal entries, JSON.
 * - `chat` (lazy; `tracker`, `conversation`): one conversation, JSON.
 *
 * JSON chunks (`steps`, `parts`, `values`) are cut where their text passes
 * {@link CHUNK_TEXT_CHARS}, so no single string nears the page's longest
 * (saving a 100k-step history once failed there) and a reader inflates one
 * piece at a time.
 *
 * **Eager and lazy.** The steps, the values the active head shows and the
 * parts and arrays those name are eager: once they are read the head is
 * shown. Everything else is lazy, read while the head is shown and before the
 * history accepts a step: every other value, the arrays and parts only steps'
 * parameters name (a step whose parameters need one comes with them still a
 * skeleton, and `readRest` gives them joined), the journal and the
 * conversations.
 *
 * **Untrusted input.** Every chunk is inflated to exactly its declared size;
 * every array is checked against its digest and every value against its hash
 * once joined; parts that name themselves or expand past what a page can
 * hold are refused before they are expanded; the trackers are checked whole
 * by the model's validators (`validateSession`); a value, an array or a part
 * nothing refers to, one a step needs that the file lacks, and trailing
 * bytes are refused. Nothing is applied before all of it passes.
 *
 * @module session/history-file
 */

import { everyStep, stepHashes, storedJournalEntry, storedStep } from '../history/step-records.js';
import { isStableId } from '../utils/stable-id.js';
import { readBundle } from './bundle/reader.js';
import { writeBundle } from './bundle/writer.js';
import { MAX_FRAME_BYTES } from './bundle/format.js';
import { gzipCompress, gzipDecompress } from './codecs/gzip.js';
import { decodeCellSet, encodeCellSet } from './codecs/cell-set.js';
import { decodeUvarint, uvarintLength, writeUvarint } from './codecs/varint.js';
import { assertDatasetFingerprint, assertSessionRequires } from './session-context.js';
import { assertDatasetSourceRecord } from './dataset-source-record.js';
import { decodeCellSubsetRecord, decodeGeneSampleRecord } from './cell-subset-record.js';
import {
  joinValue, parseArrayDigest, partJoiner, skeletonArrays, skeletonParts, splitValue, verifyArray,
} from '../history/value-parts.js';
import { hashValue } from '../history/value-pool.js';
import { HISTORY_ID_PATTERNS, HistoryModelError, emptyPatch, knownDomainsOnly, recordFields, validateSession } from '../history/model.js';
import { HOST_LITTLE_ENDIAN } from '../../formats/io/byte-order.js';
import { isPlainRecord, requireExactKeys, requirePlainRecord } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';
import { throwIfAborted } from '../../utils/abort.js';
import { markDamaged } from '../../utils/errors.js';

if (!HOST_LITTLE_ENDIAN) {
  throw new Error('Session files require a little-endian platform.');
}

/**
 * The text, in characters, a JSON chunk is cut after. Far below V8's longest
 * string (2^29 - 24) and large enough that gzip's gain per chunk is the
 * same as over one piece; one skeleton longer than it is a chunk of its own.
 */
export const CHUNK_TEXT_CHARS = 16 * 1024 * 1024;

/** A chunk is kept gzip'd only when that saves at least a sixteenth of its bytes. */
const GZIP_KEEP_NUMERATOR = 15;
const GZIP_KEEP_DENOMINATOR = 16;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HEADER_KEYS = Object.freeze(['createdAt', 'app', 'actions', 'scope', 'datasetFingerprint', 'source', 'requires', 'chrome']);
/** The manifest keys that are not the dataset part (`sessionHeaderOf`). */
const NOT_DATASET = Object.freeze(['app', 'actions', 'scope', 'chrome']);
const TRACKER_RECORD_KEYS = Object.freeze(recordFields('Tracker'));
const CHUNK_BASE_KEYS = Object.freeze(['id', 'kind', 'priority', 'codec', 'storedBytes', 'uncompressedBytes']);
const CHUNK_KEYS_BY_KIND = Object.freeze({
  steps: Object.freeze([...CHUNK_BASE_KEYS, 'tracker']),
  parts: CHUNK_BASE_KEYS,
  array: Object.freeze([...CHUNK_BASE_KEYS, 'digest', 'encoding']),
  values: CHUNK_BASE_KEYS,
  journal: Object.freeze([...CHUNK_BASE_KEYS, 'tracker']),
  chat: Object.freeze([...CHUNK_BASE_KEYS, 'tracker', 'conversation']),
});
/** The kinds in the order a file holds them within a priority. */
const KIND_ORDER = Object.freeze(['steps', 'parts', 'array', 'values', 'journal', 'chat']);
const ARRAY_ENCODINGS = Object.freeze(['raw', 'cell-set']);

/**
 * A file that breaks the format: its message says what, for the console and
 * the notification's Details; the person reads that the file is damaged
 * (`session-serializer.js` `describeLoadFailure`), never the ids it names.
 */
function invalid(what, cause = undefined) {
  return markDamaged(new TypeError(`This session file is damaged: ${what}`, cause === undefined ? undefined : { cause }));
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty text.`);
  return value;
}

/** The manifest keys a header (or a manifest) has, in order. */
function headerKeys(record) {
  return [
    ...HEADER_KEYS,
    ...(Object.hasOwn(record ?? {}, 'cells') ? ['cells'] : []),
    ...(Object.hasOwn(record ?? {}, 'genes') ? ['genes'] : []),
  ];
}

/**
 * Check the dataset part of a manifest or a saved state's header: when it
 * was written, the dataset it was saved on, where that opens from, the
 * fields its state uses, and the cells and genes it was saved on.
 *
 * @param {unknown} header
 * @returns {object} the same record
 */
export function assertSessionHeader(header) {
  requirePlainRecord(header, 'Session manifest');
  if (typeof header.createdAt !== 'string' || Number.isNaN(Date.parse(header.createdAt))
    || new Date(header.createdAt).toISOString() !== header.createdAt) {
    throw invalid('its manifest createdAt must be a canonical ISO time.');
  }
  assertDatasetFingerprint(header.datasetFingerprint, 'Session manifest datasetFingerprint');
  assertDatasetSourceRecord(header.source, 'Session manifest source');
  assertSessionRequires(header.requires, 'Session manifest requires');
  if (Object.hasOwn(header, 'chrome')) assertPageChrome(header.chrome);
  if (Object.hasOwn(header, 'cells')) {
    const cells = decodeCellSubsetRecord(header.cells, 'Session manifest cells');
    if (cells.spec.k !== header.datasetFingerprint.cellCount) {
      throw invalid('its manifest cells must keep exactly the fingerprint cell count.');
    }
  }
  if (Object.hasOwn(header, 'genes')) {
    decodeGeneSampleRecord(header.genes, header.datasetFingerprint.cellCount, 'Session manifest genes');
  }
  return header;
}

/**
 * Check the page chrome a session carries outside its history (`chrome`):
 * `{pressed: {<group id>: <button id>}}`, the button pressed in each
 * pressed-button group of the sidebar (`data-state-serializer-pressed-group`,
 * today the selection tool `highlight-mode`, CEL-0249), which decides what
 * the next drag does and which the history does not record. Kept in every
 * form a file takes (it is not private). The page puts back the groups and
 * buttons it has and says which it does not (`state-serializer/ui-controls.js`
 * `planPageChrome`).
 *
 * @param {unknown} chrome
 * @returns {object} the same record
 */
export function assertPageChrome(chrome) {
  if (!isPlainRecord(chrome) || Object.keys(chrome).length !== 1 || !Object.hasOwn(chrome, 'pressed')) {
    throw invalid('its page chrome must be exactly {pressed}.');
  }
  if (!isPlainRecord(chrome.pressed)) throw invalid('its page chrome must map pressed-button groups to their pressed button.');
  for (const [group, button] of Object.entries(chrome.pressed)) {
    // The page's own rule for the ids it puts back (`ui-controls.js` `planPageChrome`).
    if (!isStableId(group) || !isStableId(button)) {
      throw invalid(`its page chrome must name the pressed button of the group "${group}" by its id.`);
    }
  }
  return chrome;
}

/** No page chrome: what a session written without a page carries. */
export const NO_PAGE_CHROME = Object.freeze({ pressed: Object.freeze({}) });

/** The dataset part of a manifest (or of a header record), and nothing else. */
export function sessionHeaderOf(record) {
  return Object.fromEntries(headerKeys(record).filter(key => !NOT_DATASET.includes(key)).map(key => [key, record[key]]));
}

/** A session as the model checks it (`validateSession`): the manifest's header with the trackers. */
function sessionRecord(manifest, trackers) {
  return {
    createdAt: manifest.createdAt, app: manifest.app, actions: manifest.actions, scope: manifest.scope,
    datasetFingerprint: manifest.datasetFingerprint, source: manifest.source, requires: manifest.requires,
    cells: manifest.cells ?? null, genes: manifest.genes ?? null, activeTracker: manifest.activeTracker, trackers,
  };
}

/** Run a model check, saying a refusal as a damaged file. */
function modelCheck(check) {
  try {
    return check();
  } catch (error) {
    if (error instanceof HistoryModelError) throw invalid(`${error.message}.`, error);
    throw error;
  }
}

/**
 * Check the session as read, tracker by tracker (`validateSession`'s
 * `unreadable`, F164): each tracker as this version holds it
 * (`knownDomainsOnly`: a state domain it does not have is left for the
 * history to leave out), one this version cannot read left for the history
 * to leave out (`history.js` `readSaved` names both). Returns the ids of the
 * trackers it could not read. The header, and how the trackers agree with
 * each other and the scope, are checked whole (a refusal says the file is
 * damaged).
 */
function checkSession(manifest, trackers) {
  const unreadable = [];
  modelCheck(() => validateSession(sessionRecord(manifest, trackers.map(tracker => knownDomainsOnly(tracker).tracker)), { unreadable }));
  return new Set(unreadable.map(each => each.id));
}

/** The value hash of every domain at `stepId` (the after-values on the path from the root). */
export function valuesAtStep(steps, stepId) {
  const byId = steps instanceof Map ? steps : new Map(steps.map(step => [step.id, step]));
  const path = [];
  for (let step = byId.get(stepId); step !== undefined; step = step.parent === null ? undefined : byId.get(step.parent)) {
    path.push(step);
  }
  const values = {};
  for (const step of path.reverse()) Object.assign(values, step.after);
  return values;
}

function assertTrackerRecord(record, index) {
  const label = `Session manifest tracker ${index}`;
  requireExactKeys(record, TRACKER_RECORD_KEYS, label);
  if (!Array.isArray(record.steps) || record.steps.length === 0) throw invalid(`tracker ${index} steps must list its steps chunks.`);
  record.steps.forEach((id, i) => requireText(id, `tracker ${index} steps[${i}]`));
  if (record.journal !== null) requireText(record.journal, `tracker ${index} journal`);
  if (!Array.isArray(record.chats)) throw invalid(`tracker ${index} chats must be a list of chunk ids.`);
  record.chats.forEach((id, i) => requireText(id, `tracker ${index} chats[${i}]`));
}

function assertChunkRecord(entry, index) {
  const label = `chunk ${index}`;
  const keys = CHUNK_KEYS_BY_KIND[entry?.kind];
  if (keys === undefined) throw invalid(`${label} kind must be one of ${KIND_ORDER.join(', ')}.`);
  requireExactKeys(entry, keys, `Session manifest ${label}`);
  requireText(entry.id, `${label} id`);
  if (entry.priority !== 'eager' && entry.priority !== 'lazy') throw invalid(`${label} priority must be eager or lazy.`);
  if (entry.codec !== 'gzip' && entry.codec !== 'none') throw invalid(`${label} codec must be gzip or none.`);
  if (!Number.isSafeInteger(entry.storedBytes) || entry.storedBytes < 0 || entry.storedBytes > MAX_FRAME_BYTES) {
    throw invalid(`${label} storedBytes must be a frame length.`);
  }
  if (!Number.isSafeInteger(entry.uncompressedBytes) || entry.uncompressedBytes < 0) {
    throw invalid(`${label} uncompressedBytes must be a byte count.`);
  }
  if (entry.codec === 'none' && entry.storedBytes !== entry.uncompressedBytes) throw invalid(`${label} is stored as it is, at another size.`);
  if (entry.kind === 'steps' && entry.priority !== 'eager') throw invalid(`${label}: steps are read first.`);
  if ((entry.kind === 'journal' || entry.kind === 'chat') && entry.priority !== 'lazy') throw invalid(`${label}: a ${entry.kind} is read last.`);
  if (['steps', 'journal', 'chat'].includes(entry.kind) && !HISTORY_ID_PATTERNS.tracker.test(entry.tracker)) {
    throw invalid(`${label} tracker must be a tracker id.`);
  }
  if (entry.kind === 'chat') requireText(entry.conversation, `${label} conversation`);
  if (entry.kind === 'array') {
    const { type } = parseArrayDigest(entry.digest);
    if (!ARRAY_ENCODINGS.includes(entry.encoding) || (entry.encoding === 'cell-set' && type !== Uint32Array)) {
      throw invalid(`${label} encoding must be raw, or cell-set for a Uint32Array.`);
    }
  }
}

/**
 * Check a whole format-4 manifest (untrusted input) before any chunk is
 * read: its keys, its dataset part, its trackers' records, and that its
 * chunks are exactly what the trackers name, eager before lazy, in the
 * order of their kinds. The records themselves are checked once their
 * steps are read (`validateSession`).
 *
 * @param {unknown} manifest
 * @returns {object} the same manifest
 */
export function assertHistoryManifest(manifest) {
  requirePlainRecord(manifest, 'Session manifest');
  requireExactKeys(manifest, [...headerKeys(manifest), 'activeTracker', 'trackers', 'chunks'], 'Session manifest');
  assertSessionHeader(manifest);
  if (!Array.isArray(manifest.trackers) || manifest.trackers.length === 0) throw invalid('it holds no tracker.');
  if (!Array.isArray(manifest.chunks)) throw invalid('its manifest has no chunk list.');
  manifest.trackers.forEach(assertTrackerRecord);
  manifest.chunks.forEach(assertChunkRecord);
  const trackerIds = new Set();
  for (const tracker of manifest.trackers) {
    if (trackerIds.has(tracker.id)) throw invalid(`it holds the tracker "${tracker.id}" twice.`);
    trackerIds.add(tracker.id);
  }
  if (!trackerIds.has(manifest.activeTracker)) throw invalid('its active tracker is not one it holds.');
  const chunkById = new Map();
  let last = { priority: 0, kind: 0 };
  const digests = new Set();
  let eagerValues = 0;
  for (const entry of manifest.chunks) {
    if (chunkById.has(entry.id)) throw invalid(`it lists the chunk "${entry.id}" twice.`);
    chunkById.set(entry.id, entry);
    const at = { priority: entry.priority === 'eager' ? 0 : 1, kind: KIND_ORDER.indexOf(entry.kind) };
    if (at.priority < last.priority || (at.priority === last.priority && at.kind < last.kind)) {
      throw invalid(`its chunk "${entry.id}" is out of order (eager before lazy; ${KIND_ORDER.join(', ')}).`);
    }
    last = at;
    if (entry.kind === 'values' && entry.priority === 'eager') eagerValues += 1;
    if (entry.kind === 'array') {
      if (digests.has(entry.digest)) throw invalid('it stores one array twice.');
      digests.add(entry.digest);
    }
  }
  const stepsOnly = manifest.scope?.content === 'steps';
  if (stepsOnly ? manifest.chunks.some(entry => entry.kind === 'values') : eagerValues === 0) {
    throw invalid(stepsOnly ? 'a file of steps only holds no values.' : 'it holds no values of the step it shows.');
  }
  const named = new Set();
  const position = new Map(manifest.chunks.map((entry, index) => [entry.id, index]));
  for (const tracker of manifest.trackers) {
    for (const id of tracker.steps) {
      const steps = chunkById.get(id);
      if (steps?.kind !== 'steps' || steps.tracker !== tracker.id || named.has(id)) throw invalid(`tracker "${tracker.id}" names a steps chunk that is not its own.`);
      named.add(id);
    }
    // A tracker's steps are read as one list, in the order it names its chunks: the file holds them in that order.
    if (tracker.steps.some((id, index) => index > 0 && position.get(id) < position.get(tracker.steps[index - 1]))) {
      throw invalid(`tracker "${tracker.id}" names its steps chunks in another order than the file holds them.`);
    }
    if (tracker.journal !== null) {
      const journal = chunkById.get(tracker.journal);
      if (journal?.kind !== 'journal' || journal.tracker !== tracker.id || named.has(tracker.journal)) {
        throw invalid(`tracker "${tracker.id}" names a journal chunk that is not its own.`);
      }
      named.add(tracker.journal);
    }
    const conversations = new Set();
    for (const id of tracker.chats) {
      const chat = chunkById.get(id);
      if (chat?.kind !== 'chat' || chat.tracker !== tracker.id || conversations.has(chat.conversation) || named.has(id)) {
        throw invalid(`tracker "${tracker.id}" names a conversation chunk that is not its own.`);
      }
      conversations.add(chat.conversation);
      named.add(id);
    }
  }
  for (const entry of manifest.chunks) {
    if (['steps', 'journal', 'chat'].includes(entry.kind) && !named.has(entry.id)) throw invalid(`its chunk "${entry.id}" belongs to no tracker.`);
  }
  return manifest;
}

function isStrictlyIncreasing(array) {
  for (let i = 1; i < array.length; i++) if (array[i] <= array[i - 1]) return false;
  return true;
}

/**
 * Each Uint32Array's cell-set bytes once measured (null: kept raw). An array
 * of the history's values is never changed (its digest is cached the same
 * way, `value-pool.js`), and the autosave, a named save and a session file
 * each store the same arrays: measuring the cell-set encodings was half of a
 * named save (`tests/stress/RESULTS.md` §15). Callers only read the bytes.
 */
const cellSetBytes = new WeakMap();

/** One array's stored bytes: a cell set where that is smaller, else its elements. */
export function encodeArray(array) {
  const raw = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  if (!(array instanceof Uint32Array) || array.length === 0) return { encoding: 'raw', bytes: raw };
  let cells = cellSetBytes.get(array);
  if (cells === undefined) {
    cells = cellSetEncoding(array, raw.byteLength);
    cellSetBytes.set(array, cells);
  }
  return cells === null ? { encoding: 'raw', bytes: raw } : { encoding: 'cell-set', bytes: cells };
}

/** A strictly increasing array's cell-set bytes (a uvarint bound, then the encoding), when smaller than `rawBytes`; else null. */
function cellSetEncoding(array, rawBytes) {
  if (!isStrictlyIncreasing(array)) return null;
  const bound = array[array.length - 1] + 1;
  const cells = encodeCellSet(array, { cellCount: bound });
  const head = uvarintLength(bound);
  if (head + cells.byteLength >= rawBytes) return null;
  const out = new Uint8Array(head + cells.byteLength);
  out.set(cells, writeUvarint(out, 0, bound));
  return out;
}

/**
 * An array from its stored bytes, checked against its digest.
 * @param {{digest: string, encoding: string}} entry
 * @param {Uint8Array} bytes
 * @param {AbortSignal|null} signal
 */
export async function decodeArray(entry, bytes, signal) {
  const { type, length } = parseArrayDigest(entry.digest);
  let array;
  if (entry.encoding === 'cell-set') {
    const { value: bound, nextOffset } = decodeUvarint(bytes, 0);
    array = await decodeCellSet(bytes.subarray(nextOffset), { cellCount: bound, signal });
  } else {
    if (bytes.byteLength !== length * type.BYTES_PER_ELEMENT) throw invalid(`the array ${entry.digest.slice(0, 40)}… has the wrong length.`);
    array = new type(length);
    new Uint8Array(array.buffer).set(bytes);
  }
  await verifyArray(array, entry.digest).catch(error => { throw invalid(`the array ${entry.digest.slice(0, 40)}… does not match its digest.`, error); });
  return array;
}

const encoder = new TextEncoder();

/**
 * JSON text cut into pieces of about {@link CHUNK_TEXT_CHARS}: a list
 * (`kind: 'list'`, items) or a map (`kind: 'map'`, [key, value] entries).
 * One item is never split.
 */
function* jsonPieces(kind, items) {
  let texts = [];
  let length = 0;
  const open = kind === 'list' ? '[' : '{';
  const close = kind === 'list' ? ']' : '}';
  for (const item of items) {
    const text = kind === 'list' ? JSON.stringify(item) : `${JSON.stringify(item[0])}:${JSON.stringify(item[1])}`;
    if (texts.length > 0 && length + text.length > CHUNK_TEXT_CHARS) {
      yield encoder.encode(`${open}${texts.join(',')}${close}`);
      texts = [];
      length = 0;
    }
    texts.push(text);
    length += text.length + 1;
  }
  if (texts.length > 0) yield encoder.encode(`${open}${texts.join(',')}${close}`);
}

/** A chunk's frame: gzip'd where that saves at least a sixteenth, else as it is. */
async function storeChunk(meta, payload, signal) {
  throwIfAborted(signal);
  const zipped = await gzipCompress(payload, { signal });
  const keep = zipped.byteLength * GZIP_KEEP_DENOMINATOR <= payload.byteLength * GZIP_KEEP_NUMERATOR;
  const stored = keep ? zipped : payload;
  if (stored.byteLength > MAX_FRAME_BYTES) {
    throw new RangeError(
      `Session chunk "${meta.id}" holds ${formatCountOf(stored.byteLength, 'byte')}; `
      + 'a session chunk frame holds at most 4 GiB − 1 (its length is a u32).'
    );
  }
  return { meta: { ...meta, codec: keep ? 'gzip' : 'none', storedBytes: stored.byteLength, uncompressedBytes: payload.byteLength }, bytes: stored };
}

/** Every array and part a set of skeletons reaches, through the parts. */
function reachOf(skeletons, parts) {
  const arrays = new Set();
  const reached = new Set();
  const queue = [...skeletons];
  while (queue.length > 0) {
    const skeleton = queue.pop();
    for (const digest of skeletonArrays(skeleton)) arrays.add(digest);
    for (const name of skeletonParts(skeleton)) {
      if (reached.has(name)) continue;
      reached.add(name);
      queue.push(parts.get(name));
    }
  }
  return { arrays, parts: reached };
}

/**
 * Write a history as a format-4 session file.
 *
 * The history is what the share or save chose (`app/session/share-scope.js`
 * makes it from the history's snapshot): it is checked whole against the
 * model and its scope before anything is written.
 *
 * @param {{
 *   header: {createdAt: string, datasetFingerprint: object, source: object|null, requires: object,
 *     cells?: object, genes?: object},
 *   app: {version: string, catalog: string},
 *   actions: Array<{type: string, params: string}>,
 *   scope: object,
 *   history: {activeTracker: string, trackers: Array<object>},
 *   valueOf: (hash: string) => unknown,
 *   chrome?: {pressed: Record<string, string>},
 *   signal?: AbortSignal|null,
 * }} options - `app` and `actions`: `app-stamp.js`; `scope`: the model's `Scope`;
 *   `valueOf`: the pool's value of a hash; `chrome`: the page chrome it carries
 *   outside its history (`assertPageChrome`; none by default)
 * @returns {Promise<Blob>}
 */
export async function writeHistoryFile({ header, app, actions, scope, history, valueOf, chrome = NO_PAGE_CHROME, signal = null }) {
  const keys = headerKeys(header).filter(key => !NOT_DATASET.includes(key));
  requireExactKeys(header, keys, 'Session header');
  const manifestHead = {
    createdAt: header.createdAt, app, actions, scope, datasetFingerprint: header.datasetFingerprint,
    source: header.source, requires: header.requires, chrome: structuredClone(chrome),
    ...(Object.hasOwn(header, 'cells') ? { cells: header.cells } : {}),
    ...(Object.hasOwn(header, 'genes') ? { genes: header.genes } : {}),
  };
  assertSessionHeader(manifestHead);
  validateSession(sessionRecord({ ...manifestHead, activeTracker: history.activeTracker }, history.trackers));
  const withValues = scope.content !== 'steps';

  const arrays = new Map();
  const parts = new Map();
  const stored = [];
  const trackerSteps = [];
  for (const tracker of history.trackers) {
    const steps = [];
    for (const step of tracker.steps) {
      throwIfAborted(signal);
      steps.push(await storedStep(step, arrays, parts));
    }
    const journal = [];
    for (const entry of tracker.journal) journal.push(await storedJournalEntry(entry, arrays, parts));
    trackerSteps.push({ tracker, steps, journal });
  }

  // Values: the active head's are eager, every other one a step or a journal patch names is lazy.
  const eagerValues = [];
  const lazyValues = [];
  if (withValues) {
    const active = history.trackers.find(tracker => tracker.id === history.activeTracker);
    const eagerHashes = new Set(Object.values(valuesAtStep(active.steps, active.headId)));
    const referenced = new Set();
    for (const tracker of history.trackers) for (const step of everyStep(tracker)) for (const hash of stepHashes(step)) referenced.add(hash);
    for (const hash of [...eagerHashes, ...[...referenced].filter(hash => !eagerHashes.has(hash))]) {
      throwIfAborted(signal);
      const value = valueOf(hash);
      if (value === undefined) throw new RangeError(`The history does not hold the value ${hash.slice(0, 12)}… its steps refer to.`);
      (eagerHashes.has(hash) ? eagerValues : lazyValues).push([hash, await splitValue(value, arrays, parts)]);
    }
  }
  const eager = reachOf(eagerValues.map(([, skeleton]) => skeleton), parts);

  for (let index = 0; index < trackerSteps.length; index++) {
    const { tracker, steps } = trackerSteps[index];
    let piece = 0;
    for (const payload of jsonPieces('list', steps)) {
      stored.push(await storeChunk({ id: `steps/${index}/${piece++}`, kind: 'steps', tracker: tracker.id, priority: 'eager' }, payload, signal));
    }
  }
  const partChunks = async priority => {
    let piece = 0;
    const entries = [...parts].filter(([name]) => (priority === 'eager') === eager.parts.has(name));
    for (const payload of jsonPieces('map', entries)) {
      stored.push(await storeChunk({ id: `parts/${priority}/${piece++}`, kind: 'parts', priority }, payload, signal));
    }
  };
  const arrayChunks = async priority => {
    for (const [digest, array] of arrays) {
      if ((priority === 'eager') !== eager.arrays.has(digest)) continue;
      const { encoding, bytes } = encodeArray(array);
      stored.push(await storeChunk({ id: `array/${digest}`, kind: 'array', digest, encoding, priority }, bytes, signal));
    }
  };
  const valueChunks = async (priority, entries) => {
    let piece = 0;
    for (const payload of jsonPieces('map', entries)) {
      stored.push(await storeChunk({ id: `values/${priority}/${piece++}`, kind: 'values', priority }, payload, signal));
    }
  };
  await partChunks('eager');
  await arrayChunks('eager');
  await valueChunks('eager', eagerValues);
  await partChunks('lazy');
  await arrayChunks('lazy');
  await valueChunks('lazy', lazyValues);
  const records = [];
  for (let index = 0; index < trackerSteps.length; index++) {
    const { tracker, journal } = trackerSteps[index];
    if (journal.length > 0) {
      stored.push(await storeChunk({ id: `journal/${index}`, kind: 'journal', tracker: tracker.id, priority: 'lazy' }, encoder.encode(JSON.stringify(journal)), signal));
    }
  }
  for (let index = 0; index < trackerSteps.length; index++) {
    const { tracker } = trackerSteps[index];
    for (let j = 0; j < tracker.chats.length; j++) {
      const [conversation, transcript] = tracker.chats[j];
      stored.push(await storeChunk({
        id: `chat/${index}/${j}`, kind: 'chat', tracker: tracker.id, conversation, priority: 'lazy',
      }, encoder.encode(JSON.stringify(transcript)), signal));
    }
  }
  for (let index = 0; index < trackerSteps.length; index++) {
    const { tracker, journal } = trackerSteps[index];
    const record = {};
    for (const key of TRACKER_RECORD_KEYS) record[key] = tracker[key];
    record.steps = stored.filter(chunk => chunk.meta.kind === 'steps' && chunk.meta.tracker === tracker.id).map(chunk => chunk.meta.id);
    record.journal = journal.length > 0 ? `journal/${index}` : null;
    record.chats = tracker.chats.map((_, j) => `chat/${index}/${j}`);
    records.push(record);
  }
  const manifest = { ...manifestHead, activeTracker: history.activeTracker, trackers: records, chunks: stored.map(chunk => chunk.meta) };
  // What is written is what the reader accepts.
  assertHistoryManifest(manifest);
  return writeBundle({ manifest, chunks: stored.map(chunk => chunk.bytes) });
}

/**
 * Open a format-4 session file: its manifest is read and checked, and its
 * chunks are read in two stages, eager then lazy, as a stream (the file is
 * never held whole).
 *
 * - `readEager()` resolves `{history, values}` once the eager chunks are
 *   read: `history` is the model's `History` (`dataset` the active
 *   tracker's), each tracker with its steps, no journal and no conversation
 *   yet; a step whose parameters or outcome name an array or a part the lazy
 *   chunks hold has them as the stored skeleton. `values` holds every value
 *   the active head shows.
 * - `readRest()` resolves `{values, chats, journals, params}`: every other
 *   value, the conversations `{tracker, conversation, transcript}`, each
 *   tracker's journal `{tracker, journal}`, and the joined parameters and
 *   outcomes of the steps that had skeletons `{tracker, step, params,
 *   outcome}` (journal patches' steps come joined). The whole session has
 *   then been checked by the model (`validateSession`).
 *
 * @param {Blob|ReadableStream<Uint8Array>} source
 * @param {{signal: AbortSignal|null, onProgress: ((loadedBytes: number) => void)|null}} options
 */
export async function openHistoryFile(source, { signal, onProgress }) {
  const bundle = await readBundle(source, { signal, onProgress });
  try {
    assertHistoryManifest(bundle.manifest);
  } catch (error) {
    await bundle.cancel(error);
    throw error;
  }
  const { manifest } = bundle;
  const iterator = bundle.chunkStream[Symbol.asyncIterator]();
  let pending = null;
  const arrays = new Map();
  const partSkeletons = new Map();
  const referencedArrays = new Set();
  const values = new Map();
  const valueSkeletons = new Map();
  /** tracker id → its steps as stored (skeleton params) */
  const storedSteps = new Map(manifest.trackers.map(tracker => [tracker.id, []]));
  let trackers = null;
  /** The steps whose params or outcome wait for the lazy chunks: `{tracker, stored, label}`. */
  let late = [];
  let stage = 'header';

  function arrayOf(digest) {
    const array = arrays.get(digest);
    if (array === undefined) throw invalid(`a value names an array the file does not hold (${String(digest).slice(0, 40)}…).`);
    referencedArrays.add(digest);
    return array;
  }
  const joiner = partJoiner({
    skeletonOf: name => {
      if (!partSkeletons.has(name)) throw invalid(`a value names a part the file does not hold (${name.slice(0, 12)}…).`);
      return partSkeletons.get(name);
    },
    arrayOf,
  });

  function join(skeleton, label) {
    try {
      return joiner.join(skeleton);
    } catch (error) {
      throw error instanceof TypeError && error.message.startsWith('This session file') ? error : invalid(`${label}: ${error.message}`, error);
    }
  }

  /** Whether every array and part a skeleton reaches is read already. */
  function readable(skeleton) {
    const queue = [skeleton];
    const seen = new Set();
    while (queue.length > 0) {
      const node = queue.pop();
      if (skeletonArrays(node).some(digest => !arrays.has(digest))) return false;
      for (const name of skeletonParts(node)) {
        // A malformed part's name is the join's to refuse, naming it as malformed.
        if (seen.has(name) || !HASH_PATTERN.test(name)) continue;
        if (!partSkeletons.has(name)) return false;
        seen.add(name);
        queue.push(partSkeletons.get(name));
      }
    }
    return true;
  }

  async function payloadOf({ meta, bytes }) {
    const raw = meta.codec === 'gzip'
      ? await gzipDecompress(bytes, { maxOutputBytes: meta.uncompressedBytes, signal })
      : bytes;
    if (raw.byteLength !== meta.uncompressedBytes) throw invalid(`the chunk "${meta.id}" holds another size than its manifest says.`);
    return raw;
  }

  function parseJson(bytes, label) {
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw invalid(`${label} is not JSON.`, error);
    }
  }

  function takeMap(target, record, label, keyPattern) {
    if (!isPlainRecord(record)) throw invalid(`${label} must map names to skeletons.`);
    for (const [key, skeleton] of Object.entries(record)) {
      if (!keyPattern.test(key) || target.has(key)) throw invalid(`${label} holds a name twice or malformed.`);
      target.set(key, skeleton);
    }
  }

  /** Read chunks of `priority` and hand each to `take`, stopping before the first chunk of the next stage. */
  async function readStage(priority, take) {
    while (true) {
      const next = pending ?? await iterator.next();
      pending = null;
      if (next.done) return;
      if (next.value.meta.priority !== priority) {
        pending = next;
        return;
      }
      throwIfAborted(signal);
      await take(next.value.meta, await payloadOf(next.value));
    }
  }

  async function takeChunk(meta, bytes, rest) {
    if (meta.kind === 'steps') {
      const steps = parseJson(bytes, `the steps of tracker "${meta.tracker}"`);
      if (!Array.isArray(steps)) throw invalid(`the steps of tracker "${meta.tracker}" must be a list.`);
      storedSteps.get(meta.tracker).push(...steps);
    } else if (meta.kind === 'parts') {
      takeMap(partSkeletons, parseJson(bytes, 'its parts'), 'its parts', HASH_PATTERN);
    } else if (meta.kind === 'array') {
      arrays.set(meta.digest, await decodeArray(meta, bytes, signal));
    } else if (meta.kind === 'values') {
      takeMap(valueSkeletons, parseJson(bytes, 'its values'), 'its values', HASH_PATTERN);
    } else if (meta.kind === 'journal') {
      const journal = parseJson(bytes, `the journal of tracker "${meta.tracker}"`);
      if (!Array.isArray(journal)) throw invalid(`the journal of tracker "${meta.tracker}" must be a list.`);
      rest.journals.set(meta.tracker, journal);
    } else if (meta.kind === 'chat') {
      rest.chats.push({ tracker: meta.tracker, conversation: meta.conversation, transcript: parseJson(bytes, `the conversation "${meta.conversation}"`) });
    }
  }

  /** Join and hash every value read and not joined yet. */
  async function joinValues(label) {
    const added = new Map();
    for (const [hash, skeleton] of valueSkeletons) {
      if (values.has(hash)) continue;
      throwIfAborted(signal);
      const value = join(skeleton, label);
      if (await hashValue(value) !== hash) throw invalid(`${label} holds a value that does not match its hash.`);
      values.set(hash, value);
      added.set(hash, value);
    }
    return added;
  }

  /** A step with its params and outcome joined where everything they name is read (else as stored, listed in `late`). */
  function stepRecord(step, label, { late, tracker = null }) {
    if (!isPlainRecord(step)) throw invalid(`${label} must be a step record.`);
    const ready = readable(step.params) && readable(step.outcome);
    if (!ready) {
      if (late === null) throw invalid(`${label} names an array or a part the file does not hold.`);
      late.push({ tracker, stored: step, label });
      return { ...step };
    }
    return { ...step, params: join(step.params, label), outcome: join(step.outcome, label) };
  }

  async function readEager() {
    if (stage !== 'header') throw new Error('A session file is read once, eager chunks first.');
    stage = 'eager';
    await readStage('eager', (meta, bytes) => takeChunk(meta, bytes, null));
    const eagerValues = await joinValues('its eager values');
    late = [];
    trackers = manifest.trackers.map(record => {
      const steps = storedSteps.get(record.id).map((step, i) => stepRecord(step, `tracker "${record.id}" step ${i}`, { late, tracker: record.id }));
      return { ...record, steps, journal: [], chats: [] };
    });
    // Checked whole now but for its journal, read last: a removed tracker keeps its removal there, so
    // it stands in for it here (by the journal entry the removal needs) and is checked whole after it.
    const unreadable = checkSession(manifest, trackers.map(tracker => (tracker.removed === null ? tracker : {
      ...tracker,
      journal: [{
        id: `j${tracker.nextJournal - 1}`, op: 'tracker.remove', at: tracker.removed.at, by: tracker.removed.by, label: 'Removed',
        before: emptyPatch(), after: emptyPatch(), purged: false,
      }],
    })));
    const active = trackers.find(tracker => tracker.id === manifest.activeTracker);
    // The values the head shows are first, as the file was written; one this version cannot read is put back as read.
    if (manifest.scope.content !== 'steps' && !unreadable.has(active.id)) {
      for (const hash of Object.values(valuesAtStep(active.steps, active.headId))) {
        if (!eagerValues.has(hash)) throw invalid('the values of the step it shows are not among its first chunks.');
      }
    }
    return {
      history: { dataset: active.dataset, activeTracker: manifest.activeTracker, trackers },
      values: eagerValues,
    };
  }

  async function readRest() {
    if (stage !== 'eager') throw new Error('A session file\'s lazy chunks are read after its eager ones, once.');
    stage = 'rest';
    const rest = { journals: new Map(), chats: [] };
    await readStage('lazy', (meta, bytes) => takeChunk(meta, bytes, rest));
    // The chunk stream ended where the manifest said, with no trailing bytes.
    const end = await iterator.next();
    if (!end.done) throw invalid('it holds chunks after its lazy ones.');
    const more = await joinValues('its other values');
    const params = late.map(({ tracker, stored, label }) => (
      { tracker, step: stored.id, params: join(stored.params, label), outcome: join(stored.outcome, label) }
    ));
    const journals = [];
    for (const [trackerId, stored] of rest.journals) {
      const journal = stored.map((entry, i) => {
        if (!isPlainRecord(entry) || entry.purged !== false || !isPlainRecord(entry.before) || !isPlainRecord(entry.after)) return entry;
        const patch = (side, which) => ({
          ...side,
          steps: Array.isArray(side.steps)
            ? side.steps.map((step, j) => stepRecord(step, `tracker "${trackerId}" journal ${i} ${which} step ${j}`, { late: null }))
            : side.steps,
        });
        return { ...entry, before: patch(entry.before, 'before'), after: patch(entry.after, 'after') };
      });
      journals.push({ tracker: trackerId, journal });
    }
    // The session whole: every tracker with its steps joined, its journal and its conversations.
    const whole = trackers.map(tracker => {
      const joined = new Map(params.filter(entry => entry.tracker === tracker.id).map(entry => [entry.step, entry]));
      return {
        ...tracker,
        steps: tracker.steps.map(step => (joined.has(step.id) ? { ...step, params: joined.get(step.id).params, outcome: joined.get(step.id).outcome } : step)),
        journal: journals.find(entry => entry.tracker === tracker.id)?.journal ?? [],
        chats: rest.chats.filter(chat => chat.tracker === tracker.id).map(chat => [chat.conversation, chat.transcript]),
      };
    });
    const unreadable = checkSession(manifest, whole);
    if (manifest.scope.content !== 'steps') {
      const referenced = new Set();
      for (const tracker of whole) {
        if (!unreadable.has(tracker.id)) for (const step of everyStep(tracker)) for (const hash of stepHashes(step)) referenced.add(hash);
      }
      for (const hash of referenced) if (!values.has(hash)) throw invalid('a step refers to a value the file does not hold.');
      // A tracker this version cannot read names values it cannot list: each value is then held for it.
      if (unreadable.size === 0) for (const hash of values.keys()) if (!referenced.has(hash)) throw invalid('it holds a value no step refers to.');
    }
    const used = joiner.used();
    for (const name of partSkeletons.keys()) if (!used.has(name)) throw invalid('it holds a part nothing refers to.');
    for (const digest of arrays.keys()) if (!referencedArrays.has(digest)) throw invalid('it holds an array nothing refers to.');
    stage = 'done';
    return { values: more, chats: rest.chats, journals, params };
  }

  return { manifest, readEager, readRest, cancel: reason => bundle.cancel(reason) };
}

/**
 * Read only a session file's manifest (its header) and check it, without
 * reading any chunk.
 *
 * @param {Blob} source
 * @returns {Promise<object>} the manifest
 */
export async function readHistoryFileManifest(source) {
  const file = await openHistoryFile(source, { signal: null, onProgress: null });
  await file.cancel('Only the session manifest was needed.');
  return file.manifest;
}

/**
 * Read a whole session file and give it as the model's `Session` (every
 * tracker with its steps, journal and conversations) with every value: what
 * a replay, the published-view step and a test read.
 *
 * @param {Blob} source
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<{manifest: object, history: {dataset: object, activeTracker: string, trackers: object[]}, values: Map<string, unknown>}>}
 */
export async function readHistoryFile(source, { signal = null } = {}) {
  const file = await openHistoryFile(source, { signal, onProgress: null });
  try {
    const eager = await file.readEager();
    const rest = await file.readRest();
    return { manifest: file.manifest, ...assembleHistory(eager, rest), values: new Map([...eager.values, ...rest.values]) };
  } catch (error) {
    await file.cancel(error);
    throw error;
  }
}

/**
 * The history a file's two stages give together: `readEager().history` with
 * `readRest()`'s parameters, journals and conversations in place.
 *
 * @param {{history: object}} eager
 * @param {{params: object[], journals: object[], chats: object[]}} rest
 */
export function assembleHistory(eager, rest) {
  const params = new Map(rest.params.map(entry => [`${entry.tracker}/${entry.step}`, entry]));
  return {
    history: {
      ...eager.history,
      trackers: eager.history.trackers.map(tracker => ({
        ...tracker,
        steps: tracker.steps.map(step => {
          const late = params.get(`${tracker.id}/${step.id}`);
          return late === undefined ? step : { ...step, params: late.params, outcome: late.outcome };
        }),
        journal: rest.journals.find(entry => entry.tracker === tracker.id)?.journal ?? [],
        chats: rest.chats.filter(chat => chat.tracker === tracker.id).map(chat => [chat.conversation, chat.transcript]),
      })),
    },
  };
}

export { joinValue };
