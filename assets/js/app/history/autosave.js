/**
 * @fileoverview The history kept in this browser as it is made, and the
 * saved states: the autosave of each dataset's history and the named saves
 * the person makes on top.
 *
 * - **Every change, as it is made** (`createAutosave`): the write of each
 *   change of the history starts within a task of it, to this browser's
 *   IndexedDB (`autosave-store.js`, database `cellucid-history`), and holds
 *   only what changed (History v2 §3.6): the steps an event names (a new step and its
 *   parent; the steps a delete rewrote, and those it removed), the tracker's
 *   own record (its head, branches, groups, notes, recording switch and
 *   paused draft), the turns and journal entries that changed, the messages
 *   of a conversation that are new, each value, part and array once (cell
 *   sets in the session file's cell-set encoding). The saved state's record
 *   goes last, all in one transaction: a crash or a closed tab loses nothing
 *   written, and a write a crash interrupts is not kept at all. What a
 *   person can lose is the change of the last moments: one whose write was
 *   still being prepared (its header taken, its values digested) when the
 *   page went, some milliseconds after it was made; once the write is
 *   handed to the browser it is kept, whole, whatever becomes of the page
 *   (`utils/indexed-db-database.js`). A page that is left retires the
 *   autosave, which writes what is left if the browser gives it the time
 *   (`retire`); nothing can make it. A history is
 *   kept once it holds something of the person's ({@link keepsContent}): a
 *   step, a conversation, a note, another tracker, a paused draft, a loaded
 *   history; one that only opened writes nothing.
 * - **Paused draft** (§3.15.1): while recording is paused the tracker's
 *   record keeps what differs from its head (`Tracker.paused.draft`) and its
 *   values are written, so after a crash Continue brings the changes back
 *   (as one step once recording resumes).
 * - **Continue where you left off** (`offerContinue`): when a dataset opens
 *   whose autosave holds something, a notification offers to continue it
 *   (Continue) or not to be asked about it again (Start fresh). It is never
 *   loaded by itself. A history continued keeps writing into the same saved
 *   state.
 * - **One page writes a saved state** (§3.7). The page holds a Web Lock on
 *   the saved state it writes (`cellucid-history/<id>`). Continuing one
 *   another tab holds opens a copy here instead (a new saved state), and the
 *   offer says so first. The store refuses a write from a page that is not
 *   the saved state's writer any more (`SavedStateTaken`), so even without
 *   Web Locks two tabs never mix their steps: the page that lost it keeps
 *   its history as a copy.
 * - **Across tabs** (`BroadcastChannel('cellucid-history')`): a write, a
 *   rename and a removal in one tab update the lists of the others, and a
 *   removal resumes an autosave paused for room in any of them.
 * - **Named saves** (`keepAsSavedState`, through `dataset-history.js`
 *   `saveAs` and My datasets' import): what a save chose of a history (the
 *   whole history, the current state only or the steps only), kept under a
 *   name beside the autosave; it does not change afterwards.
 * - **Saved states** (`listSavedStates`, `openSavedState`, `renameSavedState`,
 *   `removeSavedStates`, `onSavedStatesChange`): every autosave and named save
 *   of this browser, what the State section and the Stored dialog list.
 * - **Room** (`savedStatesStorage`, `keepSavedStatesWhenSpaceIsLow`): the
 *   browser's figures, and its promise to keep the site's storage when the
 *   disk runs low, asked only on the person's click. A write the browser
 *   refuses for room pauses the autosave and says so once (`onQuotaExceeded`);
 *   any removal of saved states, wherever it is made (the Stored dialog, My
 *   datasets, Saved states, another tab), resumes it, and it writes
 *   everything again.
 * - Off (`history-settings.js` `autosave`), nothing is written; switched on
 *   again, everything is.
 *
 * Nothing leaves this browser; a browser that keeps no IndexedDB keeps no
 * saved state, and every listing is then empty.
 *
 * **What it reads of the history** (`history.js`): `allTrackers()` (live
 * trackers, those in Recently deleted included: the model's `Tracker`
 * fields, `steps`, `branches`, `groups` and `turns` as maps by id, `chats` a
 * map), `active`, `pool.get`, `reconcile`,
 * `snapshot()` (a named save) and `subscribe`, whose events say what changed:
 * `step {tracker, steps}`, `moved {tracker}`, `edited {tracker, op, journal,
 * steps, removed}`, `tracker {tracker}`, `loaded`, `replayed {tracker}`,
 * `recording {tracker}` (also as the paused draft changes) and `chat
 * {tracker, conversation}`.
 *
 * @module app/history/autosave
 */

import { createOpaqueId } from '../utils/opaque-id.js';
import { partJoiner, skeletonArrays, skeletonParts, splitValue, verifyArray } from './value-parts.js';
import { everyStep, stepHashes, storedJournalEntry, storedStep } from './step-records.js';
import { hashValue } from './value-pool.js';
import { recordFields } from './model.js';
import { SAVED_STATE_SCHEMA, SavedStateGone, SavedStateRecordsGone, SavedStateTaken, defaultHistoryStore } from './autosave-store.js';
import { historySettings } from './history-settings.js';
import { NO_PAGE_CHROME, assertPageChrome, decodeArray, encodeArray, valuesAtStep } from '../session/history-file.js';
import { formatCountOf } from '../../utils/format-units.js';

const listeners = new Set();
/** The autosaves of this page, so any removal of saved states resumes one paused for room. */
const liveAutosaves = new Set();
const CHANNEL_NAME = 'cellucid-history';
let channel;

function broadcastChannel() {
  if (channel === undefined) {
    channel = typeof globalThis.BroadcastChannel === 'function' ? new globalThis.BroadcastChannel(CHANNEL_NAME) : null;
    // Outside a page (Node), the channel does not keep the process alive.
    channel?.unref?.();
    channel?.addEventListener('message', event => {
      if (event.data?.removed === true) resumeAfterRemoval();
      tell();
    });
  }
  return channel;
}

/**
 * Hear whenever a saved state is written, renamed or removed, in this page
 * or another of this browser. Returns what stops it.
 *
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onSavedStatesChange(listener) {
  broadcastChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tell() {
  for (const listener of [...listeners]) {
    try { listener(); } catch (error) { console.error('[autosave] listener failed', error); }
  }
}

/** Tell this page and the others. */
function announce({ removed = false } = {}) {
  tell();
  try { broadcastChannel()?.postMessage({ removed }); } catch { /* a closed channel: this page was told */ }
}

function resumeAfterRemoval() {
  for (const autosave of liveAutosaves) if (autosave.paused) autosave.resume();
}

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.inner?.name === 'QuotaExceededError';
}

/** The Web Lock name of a saved state. */
export function savedStateLockName(id) {
  return `cellucid-history/${id}`;
}

/**
 * Hold the lock of saved state `id` until the returned release is called,
 * or resolve null when another page holds it. Without Web Locks every lock
 * is free (the store's owner check still keeps writers apart).
 */
function holdLock(locks, id) {
  if (typeof locks?.request !== 'function') return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    locks.request(savedStateLockName(id), { ifAvailable: true }, lock => {
      if (lock === null) {
        resolve(null);
        return undefined;
      }
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

/** Whether a page of this browser holds saved state `id` (one other than the asking autosave's own). */
async function heldElsewhere(locks, id) {
  if (typeof locks?.query !== 'function') return false;
  try {
    const { held = [] } = await locks.query();
    return held.some(lock => lock.name === savedStateLockName(id));
  } catch {
    return false;
  }
}

/**
 * An array as IndexedDB keeps it: a cell set in the cell-set encoding when
 * that is smaller (`history-file.js` `encodeArray`), else the typed array
 * (a view of part of a larger buffer as a copy of its own elements: a
 * structured clone keeps the whole buffer).
 */
function storedArray(array) {
  const { encoding, bytes } = encodeArray(array);
  if (encoding !== 'raw') return { encoding, data: bytes.slice() };
  return { encoding, data: array.byteOffset === 0 && array.byteLength === array.buffer.byteLength ? array : array.slice() };
}

function storedBytes(record) {
  return record.data.byteLength;
}

/**
 * A live step as it is now. The history changes its steps in place (a child
 * added, a coalesced step's values, a note, a group), and a write's records
 * must be one moment's: a batch taken across awaits would otherwise keep a
 * parent naming a child the batch does not hold, which a page closed before
 * the next write leaves behind. Its parameters and outcome are replaced,
 * never changed, so they are kept as they are (they can hold big arrays).
 */
function stepNow(step) {
  return { ...structuredClone({ ...step, params: null, outcome: null }), params: step.params, outcome: step.outcome };
}


function inIdOrder(records) {
  return [...records].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** The tracker fields the `trackers` store keeps (the rest have stores of their own). */
const OWN_RECORDS = new Set(['steps', 'turns', 'journal', 'chats']);
const TRACKER_HEAD_FIELDS = Object.freeze(recordFields('Tracker').filter(field => !OWN_RECORDS.has(field)));

/**
 * A live tracker's own record, as it is now (a copy: its branches and groups
 * change in place): the model's `Tracker` fields but its steps, turns,
 * journal and conversations.
 */
export function trackerHeadRecord(tree) {
  const out = {};
  for (const field of TRACKER_HEAD_FIELDS) {
    const value = tree[field];
    out[field] = structuredClone(value instanceof Map ? inIdOrder(value.values()) : value);
  }
  return out;
}

function listOf(collection) {
  return collection instanceof Map ? [...collection.values()] : [...collection];
}

function journalOf(tree) {
  return listOf(tree.journal ?? []);
}

function chatsOf(tree) {
  return tree.chats instanceof Map ? [...tree.chats] : [...(tree.chats ?? [])];
}

/**
 * Whether a history holds anything of the person's worth keeping: a step, a
 * conversation, a note, a group, more than one tracker, a paused draft, or
 * something in Recently deleted.
 *
 * @param {Array<object>} trees - `history.allTrackers()`
 */
export function keepsContent(trees) {
  if (trees.length > 1) return true;
  return trees.some(tree => tree.steps.size > 1 || chatsOf(tree).length > 0 || (tree.notes?.length ?? 0) > 0
    || listOf(tree.groups ?? []).length > 0 || tree.paused?.draft != null || journalOf(tree).length > 0
    || listOf(tree.branches ?? []).some(branch => branch.notes.length > 0));
}

/** What a saved state keeps, as its listing says it. */
function keptOf(trees) {
  return {
    steps: trees.reduce((sum, tree) => sum + tree.steps.size - 1, 0),
    chats: trees.reduce((sum, tree) => sum + chatsOf(tree).length, 0),
    notes: trees.reduce((sum, tree) => sum + (tree.notes?.length ?? 0) + listOf(tree.branches ?? []).reduce((n, branch) => n + branch.notes.length, 0), 0),
    paused: trees.some(tree => tree.paused?.draft != null),
  };
}

/** A conversation's messages as stored one each (F1's transcript, `agent/chat/conversation.js`: `{…, messages}`). */
function splitTranscript(transcript) {
  if (transcript !== null && typeof transcript === 'object' && Array.isArray(transcript.messages)) {
    const { messages, ...head } = transcript;
    return { head: { ...head, messages: true }, messages };
  }
  return { head: { whole: transcript }, messages: [] };
}

function joinTranscript(head, messages) {
  if (head.messages === true) {
    const { messages: _flag, ...rest } = head;
    return { ...rest, messages };
  }
  return head.whole;
}

/** What a saved state's listing reads as content (a step, a conversation, notes, a paused draft). */
function hasKept(entry) {
  const kept = entry.kept ?? {};
  return (kept.steps ?? 0) > 0 || (kept.chats ?? 0) > 0 || (kept.notes ?? 0) > 0 || kept.paused === true;
}

/** "12 steps, 1 conversation and changes made while paused". */
function keptPhrase(entry) {
  const kept = entry.kept ?? {};
  const parts = [];
  if (kept.steps > 0) parts.push(formatCountOf(kept.steps, 'step'));
  if (kept.chats > 0) parts.push(formatCountOf(kept.chats, 'conversation'));
  if (kept.notes > 0 && parts.length === 0) parts.push(formatCountOf(kept.notes, 'note'));
  if (kept.paused) parts.push('changes made while paused');
  return parts.length <= 1 ? (parts[0] ?? 'your work') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The records of one write of a saved state (`autosave-store.js`
 * `HistoryWrite`, without its entry): from `changes` (tracker id → what
 * changed, as the autosave notes it) or, with `changes` null, every record
 * of every tracker. Values, parts and arrays in `skip` are stored already;
 * `writtenMessages` (conversation key → each message's JSON as written)
 * keeps a conversation's write to its new messages.
 *
 * Every record is taken from the live trackers in one synchronous pass
 * before anything is encoded, so a batch is the history at one moment
 * whatever is recorded while it is encoded (that goes in the next write).
 *
 * @param {Array<object>} trees - live trackers (`history.allTrackers()`'s shape)
 * @param {(hash: string) => unknown} valueOf
 * @param {{changes: Map<string, object>|null, skip?: {values: Set<string>, parts: Set<string>, arrays: Set<string>}|null,
 *   writtenMessages?: Map<string, string[]>|null}} options
 */
async function batchOf(trees, valueOf, { changes, skip = null, writtenMessages = null, values: withValues = true }) {
  const live = new Map(trees.map(tree => [tree.id, tree]));
  const all = changes === null;
  const batch = {
    trackers: [], removedTrackers: [], steps: [], removedSteps: [], turns: [], removedTurns: [], journal: [],
    removedJournal: [], chats: [], values: [], parts: [], arrays: [], relies: { values: [], parts: [], arrays: [] },
  };
  const skipped = skip ?? { values: new Set(), parts: new Set(), arrays: new Set() };
  const arrays = new Map();
  const parts = new Map();
  const hashes = new Set();
  /** The records as they are now, encoded once all are taken. */
  const steps = [];
  const journalEntries = [];
  const addValues = step => stepHashes(step, hashes);

  const ids = all ? [...live.keys()] : [...changes.keys()];
  for (const id of ids) {
    const tree = live.get(id);
    const change = all ? null : changes.get(id);
    if (tree === undefined) {
      batch.removedTrackers.push(id);
      continue;
    }
    const wholeTracker = change === null || change.whole;
    if (wholeTracker && !all) batch.removedTrackers.push(id);
    if (wholeTracker || change.head) {
      const record = trackerHeadRecord(tree);
      batch.trackers.push(record);
      for (const hash of Object.values(record.paused?.draft ?? {})) hashes.add(hash);
    }
    const stepIds = wholeTracker ? [...tree.steps.keys()] : [...change.steps];
    for (const stepId of stepIds) {
      const step = tree.steps.get(stepId);
      if (step === undefined) continue;
      const now = stepNow(step);
      steps.push({ tracker: id, step: now });
      addValues(now);
    }
    if (!wholeTracker) for (const stepId of change.removedSteps) if (!tree.steps.has(stepId)) batch.removedSteps.push({ tracker: id, step: stepId });
    const turns = tree.turns instanceof Map ? tree.turns : new Map(listOf(tree.turns ?? []).map(turn => [turn.id, turn]));
    if (wholeTracker || change.allTurns) {
      if (!wholeTracker) for (const turnId of change.turns) if (!turns.has(turnId)) batch.removedTurns.push({ tracker: id, turn: turnId });
      for (const turn of turns.values()) batch.turns.push({ tracker: id, turn: structuredClone(turn) });
    } else {
      for (const turnId of change.turns) {
        if (turns.has(turnId)) batch.turns.push({ tracker: id, turn: structuredClone(turns.get(turnId)) });
      }
    }
    const journal = journalOf(tree);
    const writeEntry = entry => {
      const now = entry.purged ? structuredClone(entry) : {
        ...entry,
        before: { ...structuredClone({ ...entry.before, steps: [] }), steps: entry.before.steps.map(stepNow) },
        after: { ...structuredClone({ ...entry.after, steps: [] }), steps: entry.after.steps.map(stepNow) },
      };
      journalEntries.push({ tracker: id, entry: now });
      if (!now.purged) for (const step of [...now.before.steps, ...now.after.steps]) addValues(step);
    };
    if (wholeTracker || change.allJournal) {
      for (const entry of journal) writeEntry(entry);
    } else {
      for (const entryIdOf of change.journal) {
        const entry = journal.find(candidate => candidate.id === entryIdOf);
        if (entry === undefined) batch.removedJournal.push({ tracker: id, entry: entryIdOf });
        else writeEntry(entry);
      }
    }
    const chats = chatsOf(tree);
    const conversations = wholeTracker ? chats : chats.filter(([conversation]) => change.chats.has(conversation));
    for (const [conversation, transcript] of conversations) {
      const key = `${id}\u0000${conversation}`;
      const { head, messages } = splitTranscript(transcript);
      const before = wholeTracker || writtenMessages === null ? [] : (writtenMessages.get(key) ?? []);
      const texts = messages.map(message => JSON.stringify(message));
      const changed = [];
      texts.forEach((text, index) => { if (before[index] !== text) changed.push({ index, message: structuredClone(messages[index]) }); });
      batch.chats.push({ tracker: id, conversation, head: structuredClone(head), messages: changed, count: messages.length, texts, key });
    }
  }

  // Then encoded: parameters, outcomes and patches as skeletons.
  for (const { tracker, step } of steps) batch.steps.push({ tracker, step: await storedStep(step, arrays, parts) });
  for (const { tracker, entry } of journalEntries) batch.journal.push({ tracker, entry: await storedJournalEntry(entry, arrays, parts) });

  // Values, parts and arrays not stored yet; those left out as held already are checked by the write.
  for (const hash of withValues ? hashes : []) {
    if (skipped.values.has(hash)) {
      batch.relies.values.push(hash);
      continue;
    }
    const value = valueOf(hash);
    if (value === undefined) throw new RangeError(`The history does not hold the value ${hash.slice(0, 12)}… its steps refer to`);
    const skeleton = await splitValue(value, arrays, parts);
    batch.values.push({ hash, record: { skeleton, arrays: skeletonArrays(skeleton), parts: skeletonParts(skeleton) } });
  }
  for (const [name, skeleton] of parts) {
    if (skipped.parts.has(name)) {
      batch.relies.parts.push(name);
      continue;
    }
    batch.parts.push({ name, record: { skeleton, arrays: skeletonArrays(skeleton), parts: skeletonParts(skeleton) } });
  }
  for (const [digest, array] of arrays) {
    if (skipped.arrays.has(digest)) {
      batch.relies.arrays.push(digest);
      continue;
    }
    batch.arrays.push({ digest, record: storedArray(array) });
  }
  return batch;
}

/** The records a stored step names: its values, and the parts and arrays of its parameters and outcome. */
function storedStepRoots(step) {
  const roots = [];
  for (const hash of stepHashes(step)) roots.push(`v:${hash}`);
  for (const skeleton of [step.params, step.outcome]) {
    for (const name of skeletonParts(skeleton)) roots.push(`p:${name}`);
    for (const digest of skeletonArrays(skeleton)) roots.push(`a:${digest}`);
  }
  return roots;
}

/**
 * What one saved state holds, record by record, so its size is what a walk
 * of all of it counts (History v2 §6 test 6): each value, part and array it
 * names once, by its stored size, reached from its steps, its Recently
 * deleted and its paused drafts. Each record is counted by the references
 * to it (from those roots and from the values and parts that name it): a
 * write costs what it changes, a removal subtracts what nothing names any
 * more, and a whole write counts the state again from nothing. A write that
 * fails is followed by a whole one (`writeOnce`), which recounts.
 */
function sizeLedger() {
  let sizes = new Map();
  let refs = new Map();
  /** `<tracker>\0s\0<step>`, `<tracker>\0j\0<entry>`, `<tracker>\0p` → the records it names. */
  let roots = new Map();
  let counts = new Map();
  let total = 0;

  function addRef(key) {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > 1) return;
    total += sizes.get(key) ?? 0;
    for (const child of refs.get(key) ?? []) addRef(child);
  }

  function dropRef(key) {
    const count = (counts.get(key) ?? 0) - 1;
    if (count > 0) {
      counts.set(key, count);
      return;
    }
    counts.delete(key);
    total -= sizes.get(key) ?? 0;
    for (const child of refs.get(key) ?? []) dropRef(child);
  }

  function setRoot(key, list) {
    for (const child of list) addRef(child);
    for (const child of roots.get(key) ?? []) dropRef(child);
    if (list.length > 0) roots.set(key, list);
    else roots.delete(key);
  }

  return {
    get bytes() { return total; },
    reset() {
      sizes = new Map();
      refs = new Map();
      roots = new Map();
      counts = new Map();
      total = 0;
    },
    /** Count `batch` in (`whole`: it replaces every record the state held); resolves to the size after it. */
    apply(batch, whole) {
      if (whole) {
        roots = new Map();
        counts = new Map();
        total = 0;
      }
      for (const { hash, record } of batch.values) {
        sizes.set(`v:${hash}`, JSON.stringify(record.skeleton).length);
        refs.set(`v:${hash}`, [...record.parts.map(name => `p:${name}`), ...record.arrays.map(digest => `a:${digest}`)]);
      }
      for (const { name, record } of batch.parts) {
        sizes.set(`p:${name}`, JSON.stringify(record.skeleton).length);
        refs.set(`p:${name}`, [...record.parts.map(part => `p:${part}`), ...record.arrays.map(digest => `a:${digest}`)]);
      }
      for (const { digest, record } of batch.arrays) sizes.set(`a:${digest}`, storedBytes(record));
      for (const { tracker, step } of batch.steps) setRoot(`${tracker}\0s\0${step.id}`, storedStepRoots(step));
      for (const { tracker, entry } of batch.journal) {
        setRoot(`${tracker}\0j\0${entry.id}`, entry.purged ? [] : [...entry.before.steps, ...entry.after.steps].flatMap(storedStepRoots));
      }
      for (const record of batch.trackers) setRoot(`${record.id}\0p`, Object.values(record.paused?.draft ?? {}).map(hash => `v:${hash}`));
      for (const { tracker, step } of batch.removedSteps) setRoot(`${tracker}\0s\0${step}`, []);
      for (const { tracker, entry } of batch.removedJournal) setRoot(`${tracker}\0j\0${entry}`, []);
      for (const tracker of batch.removedTrackers) {
        for (const key of [...roots.keys()]) if (key.startsWith(`${tracker}\0`)) setRoot(key, []);
      }
      return total;
    },
  };
}

/** A batch as the store takes it (what the autosave remembers of a conversation stays here). */
function storeBatch(batch) {
  return {
    ...batch,
    chats: batch.chats.map(({ tracker, conversation, head, messages, count }) => ({ tracker, conversation, head, messages, count })),
  };
}

function batchBytes(batch) {
  let bytes = 0;
  for (const { record } of [...batch.values, ...batch.parts]) bytes += JSON.stringify(record.skeleton).length;
  for (const { record } of batch.arrays) bytes += storedBytes(record);
  return bytes;
}

/**
 * A saved state's record (`entries`): what it is, its dataset and header,
 * the page chrome it carries outside its history (`chrome`, CEL-0249), what
 * wrote it (`app`; `actions` for one kept from a file), its trackers listed,
 * what it keeps.
 */
function savedStateRecord(listing, {
  id, kind, name, dataset, header, createdAt, updatedAt, activeTracker, bytes, chrome, app = null, actions = null, content = 'history',
}) {
  assertPageChrome(chrome);
  return {
    schema: SAVED_STATE_SCHEMA, id, kind, name, dataset: { id: dataset.id, name: dataset.name }, header, chrome, app, actions, content,
    createdAt, updatedAt, activeTracker: activeTracker ?? listing.trackers[0]?.id ?? null,
    ...listing, bytes, offered: true,
  };
}

/** What a saved state's record lists of its trackers, taken with its records (`batchOf`): the same moment. */
function listingOf(trees) {
  return {
    trackers: trees.map(tree => ({ id: tree.id, name: tree.name, steps: tree.steps.size - 1, removed: tree.removed !== null && tree.removed !== undefined })),
    stepCount: trees.reduce((sum, tree) => sum + tree.steps.size - 1, 0),
    kept: keptOf(trees),
  };
}

/** A tracker record (the model's `Tracker`) as a live tracker: steps, branches, groups and turns by id, conversations a map. */
function liveTrackerOf(record) {
  const byId = list => new Map(list.map(item => [item.id, item]));
  return {
    ...record, steps: byId(record.steps), branches: byId(record.branches), groups: byId(record.groups), turns: byId(record.turns),
    chats: new Map(record.chats), journal: [...record.journal],
  };
}

/**
 * Keep a history (the model's `History`: what a Save or Share chose of the
 * page's, a session file's, another browser's) as a named saved state of
 * this browser, beside the others: `history.save` and My datasets' import.
 * `content` says what it holds (`history`, `state` or `steps`: a steps-only
 * saved state opens as a replay plan). Resolves to `{id, bytes, steps}`.
 *
 * @param {{history: {activeTracker: string, trackers: object[]}, valueOf: (hash: string) => unknown,
 *   content?: 'history'|'state'|'steps', header: object, dataset: {id: string|null, name: string|null}, name: string,
 *   createdAt: number, updatedAt: number, chrome?: {pressed: Record<string, string>}, app?: object|null, actions?: Array<object>|null}} saved -
 *   `chrome`: the page chrome it carries; `app`, `actions`: what wrote it (a file's stamps)
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 * @returns {Promise<{id: string, bytes: number, steps: number}>}
 */
export async function keepAsSavedState(saved, store = defaultHistoryStore()) {
  const [kept] = await keepAsSavedStates([saved], store);
  return kept;
}

/**
 * Keep several histories as named saved states in one transaction: every
 * one of them, or none (a library file imported, `library-file.js`). Each
 * is what {@link keepAsSavedState} takes; resolves to `{id, bytes, steps}`
 * for each, in order.
 *
 * @param {Array<Parameters<typeof keepAsSavedState>[0]>} list
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 */
export async function keepAsSavedStates(list, store = defaultHistoryStore()) {
  if (store === null) throw new Error('This browser keeps no saved states (it gives this site no IndexedDB).');
  const writes = [];
  for (const saved of list) writes.push(await namedStateWrite(saved));
  try {
    await store.writeAll(writes);
  } catch (error) {
    if (isQuotaError(error)) {
      throw new Error('This browser has no room left for another saved state. Remove saved states you no longer need, then try again.', { cause: error });
    }
    throw error;
  }
  announce();
  return writes.map(({ entry }) => ({ id: entry.id, bytes: entry.bytes, steps: entry.stepCount }));
}

/** One named saved state's write (`HistoryWrite`, whole, under a new id). */
async function namedStateWrite({
  history, valueOf, content = 'history', header, dataset, name, createdAt, updatedAt, chrome = NO_PAGE_CHROME, app = null, actions = null,
}) {
  const trees = history.trackers.map(liveTrackerOf);
  // A steps-only saved state holds no value (it opens as a replay plan, as a steps-only file does).
  const batch = await batchOf(trees, valueOf, { changes: null, values: content !== 'steps' });
  const entry = {
    ...savedStateRecord(listingOf(trees), {
      id: createOpaqueId(), kind: 'named', name, dataset, header, createdAt, updatedAt, activeTracker: history.activeTracker,
      bytes: batchBytes(batch), chrome, app, actions, content,
    }),
  };
  return { entry, owner: createOpaqueId(), mode: 'whole', ...storeBatch(batch) };
}

/**
 * Keep one dataset's history in this browser as it is made.
 *
 * @param {{
 *   history: ReturnType<typeof import('./history.js').createHistory>,
 *   dataset: {id: string|null, name: string|null},
 *   header: () => Promise<object>,
 *   store?: ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null,
 *   enabled?: () => boolean,
 *   onQuotaExceeded?: () => void,
 *   onResume?: () => void,
 *   now?: () => number,
 *   schedule?: (write: () => void) => void,
 *   locks?: LockManager|null,
 *   chrome?: () => {pressed: Record<string, string>},
 *   stamp?: () => Promise<{version: string, catalog: string}|null>,
 * }} options - `header`: the session header of the dataset open now
 *   (`SessionSerializer.captureSessionHeader`), how the saved state reopens;
 *   `onResume`: writing resumed after it was paused for room; `locks`: the
 *   page's Web Locks (`navigator.locks`)
 */
export function createAutosave({
  history, dataset, header, store = defaultHistoryStore(), enabled = () => historySettings().autosave,
  onQuotaExceeded = () => {}, onResume = () => {}, now = Date.now, schedule = write => setTimeout(write, 0),
  locks = globalThis.navigator?.locks ?? null, chrome = () => NO_PAGE_CHROME, stamp = async () => null,
}) {
  /** This page's name as the writer of its saved state. */
  const owner = createOpaqueId();
  let entryId = null;
  let entryCreatedAt = null;
  let release = null;
  let lastHeader = null;
  let retired = false;
  /** Set as it retires: the page may already show another dataset. */
  let closing = false;
  let paused = false;
  let adoptNext = null;
  /** The next write takes a saved state over (a continued one): it is written whole. */
  let claiming = false;
  /** The Continue offer shown for this history, while it stands: `{notifications, id}`. */
  let offer = null;
  /** Values, parts and arrays this saved state already holds. */
  const known = { values: new Set(), parts: new Set(), arrays: new Set() };
  /** conversation key → the JSON of each message written */
  const writtenMessages = new Map();
  /** This saved state's size, record by record (`sizeLedger`). */
  const ledger = sizeLedger();

  /** What changed since the last write, per tracker. */
  let dirty = new Map();
  let dirtyAll = false;
  let dirtyEntry = false;
  let scheduled = false;
  let running = null;

  function withdrawOffer() {
    if (offer === null) return;
    offer.notifications.dismiss?.(offer.id);
    offer = null;
  }

  function dirtyOf(tracker) {
    if (!dirty.has(tracker)) {
      dirty.set(tracker, {
        whole: false, head: false, steps: new Set(), removedSteps: new Set(), turns: new Set(), allTurns: false,
        journal: new Set(), allJournal: false, chats: new Set(),
      });
    }
    return dirty.get(tracker);
  }

  function markAll() {
    dirtyAll = true;
    dirtyEntry = true;
  }

  function scheduleFlush() {
    if (scheduled || retired) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      return flush();
    });
  }

  function treeOf(id) {
    return history.allTrackers().find(tree => tree.id === id);
  }

  const unsubscribe = history.subscribe(event => {
    if (closing) return;
    const tracker = event.tracker ?? null;
    switch (event.kind) {
      case 'step': {
        const changes = dirtyOf(tracker);
        changes.head = true;
        const tree = treeOf(tracker);
        for (const id of event.steps ?? [event.step]) {
          changes.steps.add(id);
          const turn = tree?.steps.get(id)?.by?.turn ?? null;
          if (turn !== null) changes.turns.add(turn);
        }
        break;
      }
      case 'moved':
      case 'recording':
        dirtyOf(tracker).head = true;
        break;
      case 'turn':
        // A turn's record changed without a step (what it did outside the state).
        dirtyOf(tracker).turns.add(event.turn);
        break;
      case 'edited': {
        const changes = dirtyOf(tracker);
        changes.head = true;
        changes.allTurns = true;
        for (const id of event.steps ?? []) changes.steps.add(id);
        for (const id of event.removed ?? []) changes.removedSteps.add(id);
        if (event.journal != null) changes.journal.add(event.journal);
        if (typeof event.op === 'string' && event.op.startsWith('journal.')) changes.allJournal = true;
        if (event.steps === undefined && event.removed === undefined) changes.whole = true;
        break;
      }
      case 'chat':
        dirtyOf(tracker).chats.add(event.conversation);
        break;
      case 'loaded':
        // An offer to continue is moot once a history is loaded here.
        withdrawOffer();
        if (adoptNext !== null) {
          // A continued saved state is written into again, taken over whole by its first write.
          if (entryId !== adoptNext.id) releaseLock();
          entryId = adoptNext.id;
          entryCreatedAt = adoptNext.createdAt;
          release = adoptNext.release;
          adoptNext.release = null;
          claiming = true;
          resetKnown();
        } else if (event.added === undefined && entryId !== null) {
          // The history was replaced (a named saved state, a file opened in place of it): the
          // saved state this page wrote keeps the work it had, and what was opened is kept
          // as a saved state of its own, never written over it.
          releaseLock();
          entryId = null;
          entryCreatedAt = null;
          resetKnown();
        }
        markAll();
        break;
      default:
        if (tracker === null) markAll();
        else dirtyOf(tracker).whole = true;
    }
    dirtyEntry = true;
    scheduleFlush();
  });

  function resetKnown() {
    known.values.clear();
    known.parts.clear();
    known.arrays.clear();
    writtenMessages.clear();
    ledger.reset();
  }

  function releaseLock() {
    release?.();
    release = null;
  }

  /**
   * The records of one write of this autosave's saved state (`batchOf`):
   * what changed since the last write (`whole`: every tracker, every
   * record), without what that saved state holds already, and its listing,
   * all as the history is at this moment.
   */
  async function prepare(whole) {
    const trees = history.allTrackers();
    const changes = dirty;
    const all = whole || dirtyAll;
    dirty = new Map();
    dirtyAll = false;
    dirtyEntry = false;
    const listing = listingOf(trees);
    const batch = await batchOf(trees, hash => history.pool.get(hash), {
      changes: all ? null : changes, skip: known, writtenMessages,
    });
    return { listing, batch };
  }

  function entryRecord(listing, id, { kind, name, createdAt, bytes, app }) {
    return savedStateRecord(listing, {
      id, kind, name, dataset, header: lastHeader, createdAt, updatedAt: now(), activeTracker: history.active?.id, bytes,
      chrome: chrome(), app,
    });
  }

  /** What the store keeps once a batch is written. */
  function remember(batch) {
    for (const { hash } of batch.values) known.values.add(hash);
    for (const { name } of batch.parts) known.parts.add(name);
    for (const { digest } of batch.arrays) known.arrays.add(digest);
    for (const chat of batch.chats) writtenMessages.set(chat.key, chat.texts);
  }

  /**
   * The header of the dataset this history is of. Once it is retiring, the
   * page may already show another dataset: the last header taken stands.
   */
  async function refreshHeader() {
    if (closing) return;
    try {
      lastHeader = await header();
    } catch (error) {
      // A dataset changing under the capture keeps the last header; the next write takes a new one.
      if (lastHeader === null) throw error;
    }
  }

  /** Start a saved state of its own for this history (a new one, or a copy of one taken elsewhere). */
  async function startEntry() {
    releaseLock();
    const id = createOpaqueId();
    release = await holdLock(locks, id) ?? (() => {});
    entryId = id;
    entryCreatedAt = now();
    resetKnown();
    markAll();
  }

  async function writeOnce() {
    if (store === null || !enabled() || paused) return;
    const trees = history.allTrackers();
    if (trees.length === 0 || !keepsContent(trees)) return;
    if (dirty.size === 0 && !dirtyAll && !dirtyEntry && entryId !== null) return;
    await refreshHeader();
    if (lastHeader === null) return;
    if (entryId === null) await startEntry();
    const mode = claiming ? 'claim' : (dirtyAll ? 'whole' : 'update');
    // The values it reads across awaits stay readable while it reads them (`value-pool.js` hold).
    const unhold = history.pool.hold();
    let prepared;
    try {
      prepared = await prepare(mode !== 'update');
    } finally {
      unhold();
    }
    const { listing, batch } = prepared;
    // Counted before the write: one that fails is followed by a whole write, which counts again.
    const bytes = ledger.apply(batch, mode !== 'update');
    const entry = entryRecord(listing, entryId, { kind: 'autosave', name: null, createdAt: entryCreatedAt, bytes, app: await stamp() });
    try {
      await store.write({ entry, owner, mode, ...storeBatch(batch) });
    } catch (error) {
      // What was taken is written again next time, whole.
      markAll();
      if (error instanceof SavedStateRecordsGone) {
        // Something it left out as held was collected meanwhile: written whole, nothing assumed held.
        resetKnown();
        scheduleFlush();
        return;
      }
      if (error instanceof SavedStateGone || error instanceof SavedStateTaken) {
        // Removed meanwhile (the Stored dialog, another tab), or continued in another tab:
        // this history is kept again, whole, as a saved state of its own.
        releaseLock();
        entryId = null;
        claiming = false;
        resetKnown();
        scheduleFlush();
        return;
      }
      if (isQuotaError(error)) {
        paused = true;
        onQuotaExceeded();
        return;
      }
      throw error;
    }
    claiming = false;
    remember(batch);
    announce();
  }

  /** Write what changed (serialized: a change during a write is written next). */
  async function flush() {
    while (running !== null) await running.catch(() => {});
    running = writeOnce().catch(error => {
      console.warn('[autosave] The history could not be kept in this browser:', error);
    });
    try {
      await running;
    } finally {
      running = null;
    }
  }

  // Taken now, while the dataset is the one shown: a history retired before
  // its first write still has a header to be written with.
  void refreshHeader().catch(() => {});

  const autosave = Object.freeze({
    flush,
    /** The saved state this history is written into, or null before its first write. */
    get entryId() { return entryId; },
    get paused() { return paused; },
    /** Write everything again (the autosave switched on again, room made after it was full). */
    resume() {
      const wasPaused = paused;
      paused = false;
      if (wasPaused) onResume();
      markAll();
      scheduleFlush();
    },
    /**
     * Load the saved state `saved` with `load` (which calls `history.load`)
     * and keep writing into it, not into a new one, unless another page
     * holds it: then it is loaded here as a copy (a saved state of its own).
     * Resolves to whether it was continued (false: a copy).
     *
     * @param {{id: string, createdAt: number}} saved
     * @param {() => Promise<void>} load
     * @returns {Promise<boolean>}
     */
    async continueFrom(saved, load) {
      const own = saved.id === entryId;
      const lock = own ? null : await holdLock(locks, saved.id);
      if (!own && lock === null) {
        await load();
        return false;
      }
      adoptNext = { ...saved, release: own ? release : lock };
      try {
        await load();
      } finally {
        if (adoptNext?.release !== null && adoptNext?.release !== undefined && !own) {
          // The load failed before it was taken: the lock goes.
          adoptNext.release();
        }
        adoptNext = null;
      }
      return true;
    },
    /**
     * Offer to continue this dataset's latest autosave (not this history's
     * own, and not one the person chose to start fresh from): a compact
     * notification with Continue and Start fresh. One open in another tab
     * is offered as a copy. Resolves to the offered saved state's id, or
     * null when there is none.
     *
     * @param {{notifications: {show: Function}, onContinue: (saved: {id: string, createdAt: number}) => void}} options
     * @returns {Promise<string|null>}
     */
    async offerContinue({ notifications, onContinue }) {
      if (store === null || dataset.id === null) return null;
      let entries;
      try {
        entries = await store.list();
      } catch {
        return null;
      }
      const candidate = entries
        .filter(entry => entry?.schema === SAVED_STATE_SCHEMA && entry.kind === 'autosave' && entry.dataset?.id === dataset.id
          && entry.offered !== false && entry.id !== entryId && hasKept(entry))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (candidate === undefined || closing) return null;
      const elsewhere = await heldElsewhere(locks, candidate.id);
      if (closing) return null;
      const when = new Date(candidate.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      const what = keptPhrase(candidate);
      const pausedNote = candidate.kept?.paused ? ' Your changes while paused come back as one step.' : '';
      withdrawOffer();
      const id = notifications.show({
        type: 'info',
        category: 'session',
        message: elsewhere
          ? `This history is open in another tab (${what} from ${when} on this dataset). Open a copy here?`
          : `Continue where you left off? Kept in this browser from ${when} on this dataset: ${what}.${pausedNote}`,
        duration: 0,
        action: { label: elsewhere ? 'Open a copy here' : 'Continue', run: () => onContinue({ id: candidate.id, createdAt: candidate.createdAt }) },
        secondaryAction: {
          label: 'Start fresh',
          run: () => {
            void store.update(candidate.id, entry => ({ ...entry, offered: false })).then(() => announce(), () => {});
          },
        },
      });
      offer = { notifications, id };
      return candidate.id;
    },
    /**
     * Stop following the history, once what changed is written. Call it
     * before the page shows another dataset: the writes it finishes keep the
     * last header taken of this one; its offer to continue goes.
     */
    retire() {
      closing = true;
      withdrawOffer();
      unsubscribe();
      return flush().finally(() => {
        retired = true;
        liveAutosaves.delete(autosave);
        releaseLock();
      });
    },
  });
  liveAutosaves.add(autosave);
  broadcastChannel();
  return autosave;
}

/**
 * Every saved state of this browser, most recently written first, as the
 * lists show it: its kind and name, its dataset, when it was made and last
 * written, its steps, conversations and trackers, its size, and whether this
 * version can open it. Empty without IndexedDB; never throws.
 *
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 * @returns {Promise<Array<{id: string, kind: 'autosave'|'named', name: string|null,
 *   dataset: {id: string|null, name: string|null}, createdAt: number, updatedAt: number, steps: number,
 *   chats: number, content: 'history'|'state'|'steps', paused: boolean, trackers: Array<{id: string, name: string, steps: number}>, bytes: number,
 *   openable: boolean}>>}
 */
export async function listSavedStates(store = defaultHistoryStore()) {
  if (store === null) return [];
  let entries;
  try {
    entries = await store.list();
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
    .map(entry => ({
      id: entry.id,
      kind: entry.kind === 'named' ? 'named' : 'autosave',
      name: typeof entry.name === 'string' ? entry.name : null,
      dataset: { id: entry.dataset?.id ?? null, name: entry.dataset?.name ?? null },
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      steps: Number.isSafeInteger(entry.stepCount) ? entry.stepCount : 0,
      chats: Number.isSafeInteger(entry.kept?.chats) ? entry.kept.chats : 0,
      content: ['state', 'steps'].includes(entry.content) ? entry.content : 'history',
      paused: entry.kept?.paused === true,
      trackers: Array.isArray(entry.trackers)
        ? entry.trackers.map(tracker => ({ id: tracker.id, name: tracker.name, steps: tracker.steps }))
        : [],
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
      openable: entry.schema === SAVED_STATE_SCHEMA,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

/**
 * Open a saved state for loading into the history
 * (`SessionSerializer.loadSavedHistory`): its session header, then its
 * trackers whole (steps, turns, journal and conversations) with the values
 * the active head shows, then every other value. Every array is checked
 * against its digest and every value against its hash.
 *
 * @param {string} id
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 * @returns {Promise<import('../session/session-serializer.js').SavedHistorySource & {entry: object}>}
 */
export async function openSavedState(id, store = defaultHistoryStore()) {
  if (store === null) throw new Error('This browser keeps no saved states (it gives this site no IndexedDB).');
  const read = await store.read(id);
  if (read === null) throw new Error('This saved state is no longer kept in this browser.');
  const { entry } = read;
  if (entry.schema !== SAVED_STATE_SCHEMA) {
    throw new Error('This saved state was kept by another version of Cellucid, which this version cannot open.');
  }
  const damaged = what => new Error(`This saved state is missing ${what}; it cannot be opened.`);
  const arrays = new Map();
  const partSkeletons = new Map();
  const values = new Map();
  const joiner = partJoiner({
    skeletonOf: name => {
      if (!partSkeletons.has(name)) throw damaged('a part of a value');
      return partSkeletons.get(name);
    },
    arrayOf: digest => {
      if (!arrays.has(digest)) throw damaged('an array its values hold');
      return arrays.get(digest);
    },
  });

  /** Read the parts and arrays `skeletons` reach, through the parts. */
  async function loadReach(skeletons) {
    let queue = [...skeletons];
    while (queue.length > 0) {
      const names = [...new Set(queue.flatMap(skeletonParts))].filter(name => !partSkeletons.has(name));
      const digests = [...new Set(queue.flatMap(skeletonArrays))].filter(digest => !arrays.has(digest));
      const [parts, records] = await Promise.all([store.readMany('parts', names), store.readMany('arrays', digests)]);
      for (const digest of digests) {
        const record = records.get(digest);
        if (record === undefined) throw damaged('an array its values hold');
        const array = record.encoding === 'raw' ? record.data : await decodeArray({ digest, encoding: record.encoding }, record.data, null);
        await verifyArray(array, digest);
        arrays.set(digest, array);
      }
      queue = [];
      for (const name of names) {
        const part = parts.get(name);
        if (part === undefined) throw damaged('a part of a value');
        partSkeletons.set(name, part.skeleton);
        queue.push(part.skeleton);
      }
    }
  }

  async function loadValues(hashes) {
    const wanted = [...hashes].filter(hash => !values.has(hash));
    const records = await store.readMany('values', wanted);
    for (const hash of wanted) if (!records.has(hash)) throw damaged('a value its steps refer to');
    await loadReach([...records.values()].map(record => record.skeleton));
    const out = new Map();
    for (const [hash, record] of records) {
      const value = joiner.join(record.skeleton);
      if (await hashValue(value) !== hash) throw new Error('A value of this saved state does not match its hash; it cannot be opened.');
      values.set(hash, value);
      out.set(hash, value);
    }
    return out;
  }

  const by = (list, tracker) => list.filter(item => item.tracker === tracker);
  const trackers = [];
  const stepSkeletons = [];
  for (const head of read.trackers) {
    const steps = by(read.steps, head.id).map(({ step }) => step);
    const journal = by(read.journal, head.id).map(({ entry: record }) => record);
    for (const step of [...steps, ...journal.flatMap(record => (record.purged ? [] : [...record.before.steps, ...record.after.steps]))]) {
      stepSkeletons.push(step.params, step.outcome);
    }
    const chats = by(read.chats, head.id).map(chat => {
      const messages = read.messages
        .filter(message => message.tracker === head.id && message.conversation === chat.conversation)
        .sort((a, b) => a.index - b.index)
        .map(message => message.message);
      if (messages.length !== chat.count) throw damaged('messages of a conversation');
      return [chat.conversation, joinTranscript(chat.head, messages)];
    });
    trackers.push({
      ...head,
      steps: inIdOrder(steps),
      turns: by(read.turns, head.id).map(({ turn }) => turn).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      journal: inIdOrder(journal),
      chats,
    });
  }
  const joinSteps = list => list.map(step => ({ ...step, params: joiner.join(step.params), outcome: joiner.join(step.outcome) }));

  return {
    entry,
    header: entry.header,
    content: entry.content,
    chrome: entry.chrome,
    stamps: { app: entry.app, actions: entry.actions },
    async readEager() {
      await loadReach(stepSkeletons);
      const active = trackers.find(tracker => tracker.id === entry.activeTracker);
      if (active === undefined) throw new Error('This saved state names an active tracker it does not hold; it cannot be opened.');
      const history = {
        dataset: active.dataset,
        activeTracker: entry.activeTracker,
        trackers: trackers.map(tracker => ({
          ...tracker,
          steps: joinSteps(tracker.steps),
          journal: tracker.journal.map(record => (record.purged ? record : {
            ...record, before: { ...record.before, steps: joinSteps(record.before.steps) }, after: { ...record.after, steps: joinSteps(record.after.steps) },
          })),
        })),
      };
      const shown = valuesAtStep(active.steps, active.headId);
      // A saved state of steps only holds no value: it opens as a replay plan.
      const eager = entry.content === 'steps' ? new Map()
        : await loadValues(new Set([...Object.values(shown), ...Object.values(active.paused?.draft ?? {})]));
      return { history, values: eager };
    },
    async readRest() {
      const hashes = new Set();
      for (const tracker of trackers) {
        for (const step of everyStep(tracker)) stepHashes(step, hashes);
        for (const hash of Object.values(tracker.paused?.draft ?? {})) hashes.add(hash);
      }
      return { values: entry.content === 'steps' ? new Map() : await loadValues(hashes), chats: [], journals: [], params: [] };
    },
    async cancel() {},
  };
}

/**
 * Rename a saved state.
 *
 * @param {string} id
 * @param {string} name
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 */
export async function renameSavedState(id, name, store = defaultHistoryStore()) {
  const exact = String(name).trim();
  if (exact.length === 0) throw new TypeError('A saved state needs a name');
  if (store === null) return false;
  const renamed = await store.update(id, entry => ({ ...entry, name: exact }));
  if (renamed) announce();
  return renamed;
}

/**
 * Remove the saved states `ids` (null: every one), with every value, part
 * and array no saved state left refers to. The one way saved states are
 * removed (the Stored dialog, My datasets, Saved states): a removal resumes
 * an autosave paused for room, in this page and the others. Resolves to how
 * many were removed; never throws.
 *
 * @param {Iterable<string>|null} ids
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 * @returns {Promise<number>}
 */
export async function removeSavedStates(ids, store = defaultHistoryStore()) {
  if (store === null) return 0;
  let removed = 0;
  try {
    const wanted = ids === null ? (await store.list()).map(entry => entry.id) : [...ids];
    removed = await store.remove(wanted);
  } catch {
    // What could not be removed stays listed.
  }
  if (removed > 0) {
    resumeAfterRemoval();
    announce({ removed: true });
  }
  return removed;
}

/**
 * The browser's figures for this site's storage, and whether it keeps it
 * when the disk runs low; null where it says nothing.
 *
 * @param {Navigator|undefined} [navigatorLike]
 * @returns {Promise<{usage: number, quota: number, persisted: boolean|null}|null>}
 */
export async function savedStatesStorage(navigatorLike = globalThis.navigator) {
  const storage = navigatorLike?.storage;
  if (typeof storage?.estimate !== 'function') return null;
  try {
    const { usage = 0, quota = 0 } = await storage.estimate();
    const persisted = typeof storage.persisted === 'function' ? await storage.persisted() : null;
    return { usage, quota, persisted };
  } catch {
    return null;
  }
}

/**
 * Ask the browser to keep this site's storage when the disk runs low (on the
 * person's click only). Resolves to whether it will.
 *
 * @param {Navigator|undefined} [navigatorLike]
 * @returns {Promise<boolean>}
 */
export async function keepSavedStatesWhenSpaceIsLow(navigatorLike = globalThis.navigator) {
  try {
    return typeof navigatorLike?.storage?.persist === 'function' ? await navigatorLike.storage.persist() : false;
  } catch {
    return false;
  }
}

/**
 * Remove values, parts and arrays that no saved state refers to any more
 * (once a page has started its history: what a replaced value or a removed
 * state left). Never throws.
 *
 * @param {ReturnType<typeof import('./autosave-store.js').createHistoryStore>|null} [store]
 */
export async function collectSavedStates(store = defaultHistoryStore()) {
  if (store === null) return;
  try {
    await store.collect();
  } catch {
    // Collected next time.
  }
}
