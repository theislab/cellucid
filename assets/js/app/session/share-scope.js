/**
 * @fileoverview What a Save or a Share chose, made into the trackers a
 * session file holds (History v2 §3.11, §3.15.3). Pure: no page, no pool
 * reads beyond the values it is handed; importable in Node.
 *
 * A **choice** (`ShareChoice`) names:
 * - `content`: `history` (the trackers and branches chosen, with every
 *   value), `state` (Current state only: one tracker of the dataset as
 *   opened and one squashed step "Shared state" holding what is shown), or
 *   `steps` (Steps only: a replay plan, no values and no cells);
 * - `trackers` and `branches` (`[{tracker, branches}]`): what of the history
 *   goes. A branch brings the steps it starts from: a branch it forks from
 *   comes along up to its fork step (named in the file, not in `scope`);
 * - `notes` (notes and bookmarks), `chats` (conversations; one saved
 *   during a turn ends where the save took it, said so:
 *   `agent/chat/conversation.js` `transcriptForSave`), `journal`
 *   (Recently deleted, and with it the trackers that are in it);
 * - `times`: `exact`, `dates` (every time rounded down to its UTC day) or
 *   `none` (every time null; the file's own time is then 1970-01-01);
 * - `source`: `full`, or `name` (where the dataset opens from is left out);
 * - `results`: `include`, or `recompute` (each analysis result is left out,
 *   its settings and what it was computed on kept, and computed again when
 *   the file is opened; always so for steps only).
 *
 * The defaults are what the dialogs open with: {@link SAVE_DEFAULTS} (all of
 * the history, as a backup), {@link SHARE_DEFAULTS} (the tracker shown, its
 * main and shown branches, notes; no conversation or Recently deleted) and
 * {@link STATE_DEFAULTS} (Current state only leaves out notes,
 * conversations, who acted and times: what remains is the state's own
 * values and the dataset reference); the last two are the catalog's rule
 * for `history.share` (`shareScopeOf`).
 *
 * @module session/share-scope
 */

import {
  FIRST_BRANCH_ID, ROOT_STEP_ID, SHARE_CONTENTS, SHARE_RESULTS, SHARE_SOURCES, SHARE_TIMES, createBy, createStep,
  createTracker, historyModelDocument, squashedLabel,
} from '../history/model.js';
import { DOMAIN_IDS } from '../actions/domains.js';
import { setOwnDataProperty } from '../../utils/exact-record.js';
import { shareScopeOf } from '../actions/definitions/history.js';
import { hashValue } from '../history/value-pool.js';
import { NO_PAGE_CHROME, writeHistoryFile } from './history-file.js';
import { actionStamps, appStamp } from './app-stamp.js';
import { leftOutResultOf } from '../analysis/shared/analysis-result-session.js';
import { transcriptForSave } from '../agent/chat/conversation.js';

/** Save: the whole history as a backup of one's own work. */
export const SAVE_DEFAULTS = Object.freeze({
  content: 'history', trackers: null, branches: null, notes: true, chats: false, journal: true, times: 'exact', source: 'full', results: 'include',
});

/**
 * Share: the tracker shown with its main and shown branches, and the notes;
 * what `history.share` writes when its parameters are left out
 * (`shareScopeOf`, the catalog's one rule).
 */
export const SHARE_DEFAULTS = Object.freeze({ ...shareScopeOf({}), trackers: 'active', branches: 'main-and-shown' });

/** Current state only: the state's values and the dataset reference, nothing of who did what when (`shareScopeOf`). */
export const STATE_DEFAULTS = Object.freeze({ ...shareScopeOf({ content: 'state' }), trackers: 'active', branches: 'main-and-shown' });

/** The file's own time when it is shared without times. */
export const TIMELESS_CREATED_AT = '1970-01-01T00:00:00.000Z';

/** The name of the one tracker of a state shared without its history. */
export const SHARED_STATE_TRACKER_NAME = 'Shared state';

const DAY_MS = 24 * 60 * 60 * 1000;

function refuse(message) {
  return new RangeError(message);
}

// ---------------------------------------------------------------------------
// Times, wherever the model holds one (its document says which fields: `x-time`).

let timeFieldsOf = null;
/** Record name → {time fields, record fields (field → record name, list or not)}, from the model's document. */
function timeFields() {
  if (timeFieldsOf !== null) return timeFieldsOf;
  const { $defs: defs } = historyModelDocument();
  const refOf = schema => {
    if (schema === undefined) return null;
    if (typeof schema.$ref === 'string') return schema.$ref.split('/').pop();
    if (Array.isArray(schema.anyOf)) return schema.anyOf.map(refOf).find(name => name !== null) ?? null;
    return null;
  };
  timeFieldsOf = new Map(Object.entries(defs).map(([name, def]) => {
    const times = [];
    const records = [];
    for (const [field, schema] of Object.entries(def.properties)) {
      if (schema['x-time'] !== undefined) times.push(field);
      const direct = refOf(schema);
      const item = schema.type === 'array' ? refOf(schema.items) : null;
      if (direct !== null) records.push([field, direct, false]);
      else if (item !== null) records.push([field, item, true]);
    }
    return [name, { times, records }];
  }));
  return timeFieldsOf;
}

/** `record` (of the model's `name`) with every time it holds mapped by `map`; a copy. */
function mapTimes(record, name, map) {
  if (record === null || typeof record !== 'object') return record;
  const { times, records } = timeFields().get(name);
  const out = { ...record };
  for (const field of times) if (Object.hasOwn(out, field) && out[field] !== null) out[field] = map(out[field]);
  for (const [field, inner, many] of records) {
    if (!Object.hasOwn(out, field) || out[field] === null) continue;
    out[field] = many ? out[field].map(item => mapTimes(item, inner, map)) : mapTimes(out[field], inner, map);
  }
  return out;
}

/** The time map a choice's `times` asks for. */
function timeMap(times) {
  if (times === 'exact') return null;
  if (times === 'dates') return at => Math.floor(at / DAY_MS) * DAY_MS;
  return () => null;
}

// ---------------------------------------------------------------------------
// Notes, cells, results

function withoutNotes(tracker) {
  const strip = item => ({ ...item, notes: [] });
  return {
    ...tracker,
    notes: [],
    branches: tracker.branches.map(strip),
    groups: tracker.groups.map(strip),
    turns: tracker.turns.map(strip),
    steps: tracker.steps.map(step => ({
      ...step, notes: [], bookmark: null,
      // A squashed step's carried notes and bookmarks go with them.
      squashed: step.squashed === null ? null : { ...step.squashed, carried: { notes: [], bookmarks: [] } },
    })),
  };
}

/**
 * A tracker without its conversations: and without what its turns say of
 * them (the conversation and the message that acted), so a file that leaves
 * them out names none. Each turn keeps its label and who acted.
 */
function withoutConversations(tracker) {
  return { ...tracker, chats: [], turns: tracker.turns.map(turn => ({ ...turn, conversation: null, message: null })) };
}

/** Parameters with `null` in place of every array that names cells (`x-cells`) or holds a value per cell (`x-values`). */
export function withoutCells(params, schema) {
  if (params === null || typeof params !== 'object' || schema === null || typeof schema !== 'object') return params;
  if (schema['x-cells'] === true || schema['x-values'] === true) return null;
  if (Array.isArray(params)) return schema.items ? params.map(item => withoutCells(item, schema.items)) : params;
  if (ArrayBuffer.isView(params)) return params;
  const out = { ...params };
  for (const [key, inner] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(out, key)) out[key] = withoutCells(out[key], inner);
  }
  return out;
}

/**
 * An `analysis` value without its results (`app/state/domains/analysis.js`:
 * each window's and each docked mode's `{settings, result}`): every `result`
 * beside `settings` becomes the record of a result left out
 * (`analysis-result-session.js` `leftOutResultOf`: its kind and what it was
 * computed on, no payload; null stays null), the settings stay, so opening
 * the file runs each again from them (`recompute-results.js`).
 */
export function analysisWithoutResults(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(analysisWithoutResults);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    // Keys can be the data's own (a category named `__proto__` too): own properties, never the prototype.
    setOwnDataProperty(out, key, key === 'result' && Object.hasOwn(value, 'settings') ? leftOutResultOf(child) : analysisWithoutResults(child));
  }
  return out;
}

/** `value` with every number under the key `name`, at any depth, mapped by `map`; a copy. */
function mapKeyed(value, name, map) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(item => mapKeyed(item, name, map));
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = key === name && typeof child === 'number' ? map(child) : mapKeyed(child, name, map);
  return out;
}

/**
 * The times domain values hold (their owners: `field-overlays.js` user
 * fields' `createdAt`, an analysis result's `computedAt`), mapped as the
 * records' times are when a share leaves exact times out.
 */
const VALUE_TIMES = Object.freeze({
  'field-overlays': (value, map) => (!Array.isArray(value?.userFields) ? value : {
    ...value, userFields: value.userFields.map(item => (item.createdAt == null ? item : { ...item, createdAt: map(item.createdAt) })),
  }),
  analysis: (value, map) => mapKeyed(value, 'computedAt', map),
});

/** Each domain's value as a share writes it (results left out, times mapped), by domain; only domains that change. */
function valueTransforms({ results, map }) {
  const out = new Map();
  for (const domain of new Set([...(map === null ? [] : Object.keys(VALUE_TIMES)), ...(results === 'recompute' ? ['analysis'] : [])])) {
    out.set(domain, value => {
      let next = domain === 'analysis' && results === 'recompute' ? analysisWithoutResults(value) : value;
      if (map !== null && VALUE_TIMES[domain] !== undefined) next = VALUE_TIMES[domain](next, map);
      return next;
    });
  }
  return out;
}

/** A conversation's own times (`agent/chat/conversation.js` transcript), mapped as the records' are. */
function transcriptWithTimes(transcript, map) {
  if (transcript === null || typeof transcript !== 'object') return transcript;
  const time = at => (typeof at === 'number' ? map(at) : at);
  return {
    ...transcript,
    createdAt: time(transcript.createdAt),
    updatedAt: time(transcript.updatedAt),
    summary: transcript.summary == null ? transcript.summary : { ...transcript.summary, at: time(transcript.summary.at) },
    messages: Array.isArray(transcript.messages)
      ? transcript.messages.map(message => (Object.hasOwn(message, 'at') ? { ...message, at: time(message.at) } : message)) : transcript.messages,
  };
}

// ---------------------------------------------------------------------------
// The trackers and branches chosen

/** The ids of the steps on the path root → `stepId`. */
function pathIds(byId, stepId) {
  const out = [];
  for (let step = byId.get(stepId); step !== undefined; step = step.parent === null ? undefined : byId.get(step.parent)) out.push(step.id);
  return out;
}

/** The branches of `tracker` a choice names. */
function chosenBranches(tracker, branches) {
  if (branches === null) return new Set(tracker.branches.map(branch => branch.id));
  if (branches === 'main-and-shown') return new Set([tracker.mainBranch, tracker.activeBranch]);
  const entry = branches.find(candidate => candidate.tracker === tracker.id);
  if (entry === undefined) return new Set([tracker.mainBranch, tracker.activeBranch]);
  const known = new Set(tracker.branches.map(branch => branch.id));
  for (const id of entry.branches) if (!known.has(id)) throw refuse(`The tracker "${tracker.name}" has no branch "${id}" to share.`);
  if (entry.branches.length === 0) throw refuse(`Choose at least one branch of "${tracker.name}" to share.`);
  return new Set(entry.branches);
}

/**
 * One tracker cut to the branches chosen: their steps and the steps they
 * start from; a branch only part of whose steps come along ends at the last
 * of them; the head, the active and the main branch stay where they can.
 */
function cutTracker(tracker, chosen) {
  const byId = new Map(tracker.steps.map(step => [step.id, step]));
  const kept = new Set();
  for (const branch of tracker.branches) if (chosen.has(branch.id)) for (const id of pathIds(byId, branch.tip)) kept.add(id);
  const steps = tracker.steps.filter(step => kept.has(step.id)).map(step => ({ ...step, children: step.children.filter(id => kept.has(id)) }));
  const keptById = new Map(steps.map(step => [step.id, step]));
  const branches = [];
  for (const branch of tracker.branches) {
    const own = steps.filter(step => step.branch === branch.id);
    if (own.length === 0) continue;
    // A branch's steps are a line in id order: its last kept step is its tip here.
    branches.push({ ...branch, tip: own[own.length - 1].id });
  }
  const held = new Map(branches.map(branch => [branch.id, branch]));
  const order = [...chosen].filter(id => held.has(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const activeBranch = chosen.has(tracker.activeBranch) ? tracker.activeBranch : (chosen.has(tracker.mainBranch) ? tracker.mainBranch : order[0]);
  const active = held.get(activeBranch);
  const headId = pathIds(keptById, active.tip).includes(tracker.headId) ? tracker.headId : active.tip;
  if (active.archived && keptById.get(headId).branch !== active.id) throw refuse(`The archived branch "${active.name}" is shared without the step shown; share it with the branch shown.`);
  const mainCandidate = [tracker.mainBranch, activeBranch, ...order].find(id => held.has(id) && !held.get(id).archived);
  const mainBranch = mainCandidate ?? activeBranch;
  if (held.get(mainBranch).archived) held.set(mainBranch, { ...held.get(mainBranch), archived: false });
  const groups = tracker.groups.filter(group => steps.some(step => step.group === group.id));
  const turns = tracker.turns
    .filter(turn => steps.some(step => step.by.turn === turn.id))
    .map(turn => (held.has(turn.branch) ? turn : { ...turn, branch: steps.find(step => step.by.turn === turn.id).branch }));
  return {
    ...tracker, steps, branches: branches.map(branch => held.get(branch.id)), groups, turns, headId, activeBranch, mainBranch,
  };
}

/**
 * The one tracker of a state shared without its history: the dataset as
 * opened (the root of the tracker shown) and one squashed step to `shown`.
 */
function stateTracker(source, shown, { trackerId, at }) {
  const root = source.steps.find(step => step.id === ROOT_STEP_ID);
  // Nobody is named: the dataset as it opened, and the person's state.
  const opening = createBy({ origin: 'startup' });
  const person = createBy({ origin: 'user' });
  const touches = DOMAIN_IDS.filter(domain => Object.hasOwn(root.after, domain) && Object.hasOwn(shown, domain) && shown[domain] !== root.after[domain]);
  const tracker = createTracker({
    id: trackerId, name: SHARED_STATE_TRACKER_NAME, dataset: source.dataset, createdAt: at, by: opening, rootValues: root.after,
  });
  const step = createStep({
    id: 's1', parent: ROOT_STEP_ID, branch: FIRST_BRANCH_ID, kind: 'squashed', label: squashedLabel({ cause: 'share', count: null, domains: [] }),
    by: person, at, touches,
    before: Object.fromEntries(touches.map(domain => [domain, root.after[domain]])),
    after: Object.fromEntries(touches.map(domain => [domain, shown[domain]])),
    squashed: { cause: 'share', count: null, by: [], carried: { notes: [], bookmarks: [] } },
  });
  return {
    ...tracker,
    steps: [{ ...tracker.steps[0], children: ['s1'] }, step],
    branches: tracker.branches.map(branch => ({ ...branch, tip: step.id })),
    headId: step.id,
    nextStep: 2,
  };
}

function requireChoice(choice) {
  if (!SHARE_CONTENTS.includes(choice.content)) throw refuse(`A share holds one of ${SHARE_CONTENTS.join(', ')}, not ${choice.content}.`);
  if (!SHARE_RESULTS.includes(choice.results)) throw refuse(`Analysis results are one of ${SHARE_RESULTS.join(', ')}, not ${choice.results}.`);
  if (!SHARE_TIMES.includes(choice.times)) throw refuse(`Times are one of ${SHARE_TIMES.join(', ')}, not ${choice.times}.`);
  if (!SHARE_SOURCES.includes(choice.source)) throw refuse(`The dataset is named ${SHARE_SOURCES.join(' or ')}, not ${choice.source}.`);
  for (const key of ['notes', 'chats', 'journal']) if (typeof choice[key] !== 'boolean') throw refuse(`A share says whether it holds ${key}.`);
}

/**
 * Make what a choice holds from the history as it is.
 *
 * @param {{
 *   snapshot: {activeTracker: string, trackers: object[]},
 *   shown: Record<string, string>,
 *   choice: object,
 *   valueOf: (hash: string) => unknown,
 *   catalog: {has: Function, get: Function},
 *   newTrackerId: () => string,
 *   now: number,
 * }} options - `snapshot`: `history.snapshot()` (the model's `History`);
 *   `shown`: the value hash of every domain shown now (`history.shownHashes()`,
 *   after the history settled what is shown); `choice`: a {@link SHARE_DEFAULTS}
 *   shape; `valueOf`: the pool's values
 * @returns {Promise<{history: {activeTracker: string, trackers: object[]}, scope: object,
 *   valueOf: (hash: string) => unknown, createdAt: (iso: string) => string, keepSource: boolean}>}
 *   `valueOf` answers the values the file names (results left out included);
 *   `createdAt` maps the file's own time as the times choice asks
 */
export async function shareHistory({ snapshot, shown, choice, valueOf, catalog, newTrackerId, now }) {
  requireChoice(choice);
  const results = choice.content === 'steps' ? 'recompute' : choice.results;
  const active = snapshot.trackers.find(tracker => tracker.id === snapshot.activeTracker);
  if (active === undefined) throw refuse('There is no tracker shown to share.');

  let trackers;
  let branchesScope;
  if (choice.content === 'state') {
    trackers = [stateTracker(active, shown, { trackerId: newTrackerId(), at: now })];
    branchesScope = [{ tracker: trackers[0].id, branches: [FIRST_BRANCH_ID] }];
  } else {
    let chosen;
    if (choice.trackers === null) chosen = snapshot.trackers.filter(tracker => choice.journal || tracker.removed === null);
    else if (choice.trackers === 'active') chosen = [active];
    else {
      chosen = choice.trackers.map(id => {
        const tracker = snapshot.trackers.find(candidate => candidate.id === id);
        if (tracker === undefined) throw refuse(`There is no tracker "${id}" to share.`);
        return tracker;
      });
      if (!chosen.includes(active)) throw refuse('A share holds the tracker shown.');
    }
    branchesScope = [];
    trackers = chosen.map(tracker => {
      const branches = chosenBranches(tracker, choice.branches);
      branchesScope.push({ tracker: tracker.id, branches: [...branches].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) });
      const all = branches.size === tracker.branches.length;
      return all ? tracker : cutTracker(tracker, branches);
    });
    if (!choice.journal) {
      trackers = trackers.filter(tracker => tracker.removed === null).map(tracker => ({ ...tracker, journal: [] }));
    }
    if (!choice.notes) trackers = trackers.map(withoutNotes);
    if (!choice.chats) trackers = trackers.map(withoutConversations);
    // A conversation saved during a turn ends where the save took it, said so (not "the page closed").
    else trackers = trackers.map(tracker => ({ ...tracker, chats: tracker.chats.map(([conversation, transcript]) => [conversation, transcriptForSave(transcript)]) }));
    if (choice.content === 'steps') {
      const strip = step => (step.params === null || !catalog.has(step.type) ? step : { ...step, params: withoutCells(step.params, catalog.get(step.type).params) });
      trackers = trackers.map(tracker => ({
        ...tracker,
        steps: tracker.steps.map(strip),
        journal: tracker.journal.map(entry => (entry.purged ? entry : {
          ...entry, before: { ...entry.before, steps: entry.before.steps.map(strip) }, after: { ...entry.after, steps: entry.after.steps.map(strip) },
        })),
      }));
    }
    branchesScope = branchesScope.filter(entry => trackers.some(tracker => tracker.id === entry.tracker));
  }

  // What a domain's value is shared as: analysis without its results (recompute), and the times
  // values hold mapped as the records' are (times other than exact). Each is written under its own hash.
  const map = timeMap(choice.times);
  const transforms = choice.content === 'steps' ? new Map() : valueTransforms({ results, map });
  const extra = new Map();
  if (transforms.size > 0) {
    const renamed = new Map();
    const rename = async (domain, hash) => {
      const key = `${domain}\u0000${hash}`;
      if (!renamed.has(key)) {
        const shared = transforms.get(domain)(valueOf(hash));
        const sharedHash = await hashValue(shared);
        extra.set(sharedHash, shared);
        renamed.set(key, sharedHash);
      }
      return renamed.get(key);
    };
    // Every value a step names: what it changed (before, after) and what it read (`reads`, by domain).
    const renameStep = async step => {
      const out = { ...step, before: { ...step.before }, after: { ...step.after }, reads: { ...step.reads } };
      for (const side of ['before', 'after', 'reads']) {
        for (const domain of Object.keys(out[side])) if (transforms.has(domain)) out[side][domain] = await rename(domain, out[side][domain]);
      }
      return out;
    };
    const next = [];
    for (const tracker of trackers) {
      const steps = [];
      for (const step of tracker.steps) steps.push(await renameStep(step));
      const journal = [];
      for (const entry of tracker.journal) {
        if (entry.purged) { journal.push(entry); continue; }
        const side = async patch => ({ ...patch, steps: await Promise.all(patch.steps.map(renameStep)) });
        journal.push({ ...entry, before: await side(entry.before), after: await side(entry.after) });
      }
      const paused = tracker.paused?.draft == null ? tracker.paused : {
        ...tracker.paused,
        draft: Object.fromEntries(await Promise.all(Object.entries(tracker.paused.draft).map(async ([domain, hash]) => [domain, transforms.has(domain) ? await rename(domain, hash) : hash]))),
      };
      // A step whose value differed only in what is left out (results, a time) changes nothing now in that domain.
      const sameNow = step => step.touches.filter(domain => transforms.has(domain) && step.before[domain] === step.after[domain]);
      next.push({
        ...tracker,
        paused,
        steps: steps.map(step => sameNow(step).reduce((out, domain) => (out.touches.length > 0 ? dropDomain(out, domain) : out), step)),
        journal,
      });
    }
    trackers = next;
  }
  if (map !== null) {
    trackers = trackers.map(tracker => ({
      ...tracker,
      chats: tracker.chats.map(([conversation, transcript]) => [conversation, transcriptWithTimes(transcript, map)]),
    }));
  }

  if (map !== null) trackers = trackers.map(tracker => mapTimes(tracker, 'Tracker', map));

  const scope = {
    trackers: trackers.map(tracker => tracker.id),
    branches: branchesScope,
    content: choice.content,
    results,
    notes: choice.content === 'state' ? false : choice.notes,
    chats: choice.content === 'state' ? false : choice.chats,
    journal: choice.content === 'state' ? false : choice.journal,
    times: choice.times,
    source: choice.source,
  };
  const activeTracker = choice.content === 'state' ? trackers[0].id : snapshot.activeTracker;
  const createdAt = iso => (choice.times === 'exact' ? iso : choice.times === 'none' ? TIMELESS_CREATED_AT
    : new Date(Math.floor(Date.parse(iso) / DAY_MS) * DAY_MS).toISOString());
  return {
    history: { activeTracker, trackers },
    scope,
    valueOf: hash => (extra.has(hash) ? extra.get(hash) : valueOf(hash)),
    createdAt,
    keepSource: choice.source === 'full',
  };
}

/** A step without one of its domains (its value is the same before and after). */
function dropDomain(step, domain) {
  const { [domain]: _before, ...before } = step.before;
  const { [domain]: _after, ...after } = step.after;
  return { ...step, touches: step.touches.filter(id => id !== domain), before, after };
}

/**
 * A Save's or a Share's session file: what `choice` holds of the history
 * (`shareHistory`), stamped with what wrote it (`app-stamp.js`) and written
 * (`history-file.js`). The one way a file is made of a history: the page's
 * Save and Share (`session-serializer.js`), the `history.share` action, My
 * datasets' export and the tests.
 *
 * @param {{
 *   snapshot: object, shown: Record<string, string>, valueOf: (hash: string) => unknown,
 *   choice: object, header: object, catalog: {has: Function, get: Function}, version: string,
 *   newTrackerId: () => string, now: number, chrome?: {pressed: Record<string, string>}, signal?: AbortSignal|null,
 * }} options - `header`: the dataset part (`SessionSerializer.captureSessionHeader`);
 *   `chrome`: the page chrome the file carries outside its history (`history-file.js` `assertPageChrome`)
 * @returns {Promise<{blob: Blob, shared: Awaited<ReturnType<typeof shareHistory>>}>}
 */
export async function writeSharedHistory({ snapshot, shown, valueOf, choice, header, catalog, version, newTrackerId, now, chrome = NO_PAGE_CHROME, signal = null }) {
  const shared = await shareHistory({ snapshot, shown, choice, valueOf, catalog, newTrackerId, now });
  const steps = shared.history.trackers.flatMap(tracker => [
    ...tracker.steps, ...tracker.journal.flatMap(entry => (entry.purged ? [] : [...entry.before.steps, ...entry.after.steps])),
  ]);
  const blob = await writeHistoryFile({
    header: { ...header, createdAt: shared.createdAt(header.createdAt), source: shared.keepSource ? header.source : null },
    app: await appStamp({ catalog, version }),
    actions: await actionStamps(steps, catalog),
    scope: shared.scope,
    history: shared.history,
    valueOf: shared.valueOf,
    chrome,
    signal,
  });
  return { blob, shared };
}
