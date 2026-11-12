/**
 * @fileoverview The history's records: trackers, branches, groups, steps,
 * notes, turns and the journal, with their exact fields, the rules every
 * history holds, and pure constructors and validators. Importable in Node,
 * no page.
 *
 * The history (`history.js`), the autosave, the session file, the State
 * panel and the agents' reads all hold these records, and Python and R build
 * their reading model from the same description (`historyModelDocument`,
 * written as `history_model.schema.json` by
 * `scripts/generate-history-model.mjs` and pinned by digest in the three
 * repositories). A field is added here first, or nowhere.
 *
 * **The records** (every key always present; `null` where a field does not
 * apply; times in milliseconds since 1970 UTC, or `null` in a file shared
 * without times):
 *
 * - `History`: `{dataset, activeTracker, trackers}`, one per open dataset.
 * - `Tracker`: one tree of steps. Ids never reused: steps `s<n>` (the root
 *   is `s0`), branches `b<n>`, groups `g<n>`, notes `n<n>`, journal entries
 *   `j<n>`, each numbered by the tracker's own counter (`nextStep`, …); a
 *   tracker is `t-<uuid>`. `start` says what it started from; `removed` is
 *   set while it sits in Recently deleted. `paused` is its recording switch
 *   (History v2 §3.15.1): null while it records; while paused, changes still
 *   apply but make no step, and `paused` says since when, who acted, and
 *   (in this browser's autosave) the draft of what differs from the head,
 *   kept as values; resuming adds one squashed step for what differs.
 * - `Branch`: an object with a unique name, a fork step (`base`, null for
 *   the branch that holds the root), its last step (`tip`), who made it, a
 *   color slot (`lane`), and the flags `locked` and `archived`. Which branch
 *   is main is the tracker's `mainBranch`.
 * - `Group`: a named folder over consecutive steps of one branch, metadata
 *   only (§3.15.2). Each step names its group (`Step.group`); the group holds
 *   no list of its steps, so it costs the same whatever it spans, and
 *   deleting steps shrinks it. One level: a group holds no group; it holds
 *   whole turns, never part of one.
 * - `Step`: of a `kind`. An `action` (type and parameters, by name, at the
 *   parameters' version `v`), a change made `outside` an action, the `root`,
 *   or a `squashed` step (§3.15.1-3): the net change of steps merged into
 *   one, or of what changed while recording was paused, with no action of
 *   its own (`squashed` says why and from what). Each records the branch it
 *   was made on, who took it (`by`), when (`at`, `until`, `merged`), how
 *   long (`ms`), the hash of each touched domain's value before and after,
 *   the hash of each input it read (`reads`), its status and the system's
 *   reason, notes, a bookmark and its group. No picture of a step is ever
 *   stored (§3.15.7): a picture is drawn from the live view when asked for.
 * - `By`: who acted (`origin`), the agent and model, the notebook host, the
 *   person's name when they chose to record it, and the turn.
 * - `Turn`: one agent or notebook turn: its label, where it started, its
 *   conversation and message, its notes (the first is its summary).
 * - `Note`: authored, timestamped Markdown-subset text on a step, a branch,
 *   a turn or the tracker.
 * - `JournalEntry`: one structural edit (a delete, a rename, a note, a group,
 *   a squash, …) with the exact records it replaced (`before`) and made
 *   (`after`), so it can be undone; `purged` once Recently deleted is emptied
 *   of it.
 *
 * **Branch membership is stored.** Each step records the branch it was made
 * on, and the steps of a branch form one chain from its fork step to its tip.
 * A step's id is always greater than its parent's, so the steps in id order
 * are parents before children (the order every reader lists them in).
 *
 * **Names** (branches, groups, bookmarks, trackers) are kept in their stored
 * form (`normalizeName`: NFC, trimmed, inner white space one space) and
 * compared in their key form (`nameKey`: the stored form lower-cased).
 * Branch, group and bookmark names are unique per tracker, tracker names per
 * history (removed trackers aside). A branch, group or tracker cannot be
 * named like an id of its kind, since actions accept either.
 *
 * **Validators** (`validateTracker`, `validateHistory`, `validateSession`,
 * and one per record) throw a `HistoryModelError` (a TypeError) whose message
 * names the path and the rule: `tracker.steps["s3"].by.origin must be one of
 * …`. A session file reader says them after "This session file is damaged:".
 *
 * @module app/history/model
 */

import { DOMAIN_IDS } from '../actions/domains.js';
import { ACTION_HOSTS, ACTION_ORIGINS } from '../actions/dispatcher.js';
import { ACTION_READ_INPUTS } from '../actions/catalog.js';
import { isPlainRecord } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';
import { plainSentence, quoteName } from '../actions/targets/names.js';
import { lowerFirst } from '../../utils/text-case.js';

/** The version of the description (`historyModelDocument`); bumped with any change to it. */
export const HISTORY_MODEL_VERSION = 2;

/** Id forms. A tracker id is `t-` and a lower-case UUID (`createOpaqueId`). */
export const HISTORY_ID_PATTERNS = Object.freeze({
  tracker: /^t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  step: /^s(0|[1-9][0-9]*)$/,
  branch: /^b(0|[1-9][0-9]*)$/,
  group: /^g(0|[1-9][0-9]*)$/,
  note: /^n(0|[1-9][0-9]*)$/,
  journal: /^j(0|[1-9][0-9]*)$/,
});
const ID_EXAMPLES = Object.freeze({
  tracker: 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10', step: 's12', branch: 'b3', group: 'g1', note: 'n4', journal: 'j2',
});

/** The root step of every tracker, the branch that first holds it, and that branch's name. */
export const ROOT_STEP_ID = 's0';
export const FIRST_BRANCH_ID = 'b0';
export const FIRST_BRANCH_NAME = 'Main';

/** A value's content hash (`value-pool.js`): SHA-256, lower-case hex. */
export const VALUE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The type of the step the history keeps for a change made outside an action. */
export const OUTSIDE_CHANGE_TYPE = 'history.outside-change';

/**
 * What a step is: the tracker's `root` (no action), an `action` of the
 * catalog, a change made `outside` an action (`OUTSIDE_CHANGE_TYPE`), or a
 * `squashed` step (no action of its own: the net change of several, `Squash`).
 */
export const STEP_KINDS = Object.freeze(['root', 'action', 'outside', 'squashed']);

/**
 * Why a squashed step was made (`Squash.cause`): recording was `paused` (the
 * changes made meanwhile, added on resuming or before the history moved);
 * consecutive `steps` were squashed into one (Merge into one step, a group or
 * a turn squashed); the history was `clear`ed keeping the state (the path
 * from the root to the head, on the branch "Fresh start"); or a state was
 * `share`d without its history (Current state only).
 */
export const SQUASH_CAUSES = Object.freeze(['paused', 'steps', 'clear', 'share']);

/** The branch "Clear history, keep the state" makes (§3.15.2). */
export const FRESH_START_BRANCH_NAME = 'Fresh start';

/**
 * Who a step, a note or a turn is by. The dispatcher's origins, and
 * `outside`: a change made outside an action, whose author is not known
 * (written only by the history itself).
 */
export const BY_ORIGINS = Object.freeze([...ACTION_ORIGINS, 'outside']);

export const STEP_STATUSES = Object.freeze(['applied', 'unapplicable']);

/**
 * What a tracker started from: the dataset as opened (its first tracker's
 * root values), what was shown, a replay of recorded steps, or a session
 * file loaded beside the person's own trackers.
 */
export const TRACKER_START_KINDS = Object.freeze(['opened', 'shown', 'replay', 'import']);

/** The root step's label for each start. */
export const ROOT_LABELS = Object.freeze({
  opened: 'Opened',
  shown: 'Started from the state shown',
  replay: 'Started a replay',
  import: 'Loaded from a session file',
});

/**
 * What became of one step of a replay: applied and recorded; applied and
 * changing nothing here (no step); not applied, kept flagged with the reason;
 * skipped (a change made outside the recorded steps names no action);
 * stopped before it was reached.
 */
export const REPLAY_OUTCOMES = Object.freeze(['applied', 'unchanged', 'unmatched', 'skipped', 'stopped']);

/** What a name a replayed step gave and nothing here resolves can be (`ReplayEntry.missing`). */
export const REPLAY_MISSING_KINDS = Object.freeze(['field', 'category', 'gene']);

/**
 * The structural edits the journal keeps, each named by its action without
 * `history.` (`branch.delete` is `history.branch.delete`). `turn.undo` is
 * kept only when it deletes the turn's own steps; `journal.undo` is a
 * restore, itself undoable. `load` is a tracker loaded beside the others
 * from a file (a session file, Load): it records no change of its own, and
 * undoing it removes the tracker to Recently deleted (`tracker.remove`).
 */
export const JOURNAL_OPS = Object.freeze([
  'step.delete', 'branch.delete', 'branch.rename', 'branch.archive', 'branch.set-main', 'branch.lock',
  'group.create', 'group.rename', 'group.extend', 'group.remove', 'squash', 'clear',
  'note.add', 'note.edit', 'note.remove', 'bookmark.set', 'tracker.rename', 'tracker.remove',
  'turn.undo', 'journal.undo', 'load',
]);

/** The tracker fields a journal entry may put back. */
export const TRACKER_PATCH_FIELDS = Object.freeze(['name', 'headId', 'activeBranch', 'mainBranch', 'notes', 'removed']);

/** The branch color slots (`--history-lane-0` … `--history-lane-7`); a branch keeps its slot. */
export const HISTORY_LANE_COUNT = 8;

/**
 * What a Share or a Save chose (`Scope`). `content` (§3.15.3): the
 * `history` (the trackers and branches chosen, with every value), the
 * current `state` only (one tracker: the root and one squashed step), or the
 * `steps` only (a replay plan: no values, no cells). `results`: analysis
 * results `include`d, or left out to `recompute` on open from their recorded
 * provenance.
 */
export const SHARE_CONTENTS = Object.freeze(['history', 'state', 'steps']);
export const SHARE_RESULTS = Object.freeze(['include', 'recompute']);
export const SHARE_TIMES = Object.freeze(['exact', 'dates', 'none']);
export const SHARE_SOURCES = Object.freeze(['full', 'name']);

/**
 * Rows of an apply plan (Python, R and the browser's AnnData copy plan alike).
 * `column-colors`: a dataset column the session recolored, written with the
 * colors it is shown in (`uns['<column>_colors']`).
 */
export const APPLY_ROW_KINDS = Object.freeze([
  'user-field', 'highlight', 'column-renamed', 'categories-renamed', 'categories-merged', 'field-deleted',
  'gene-set', 'column-colors', 'presentation',
]);
export const APPLY_ROW_STATUSES = Object.freeze(['write', 'replace', 'unchanged', 'not-applied']);
export const APPLY_PACKAGES = Object.freeze(['python', 'r', 'web']);

export class HistoryModelError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'HistoryModelError';
  }
}

function fail(message) {
  throw new HistoryModelError(message);
}

/** The number of an id (`s12` → 12). */
export function idNumber(id) {
  return Number(id.slice(1));
}

/** The next id of a kind from a tracker's counter (`nextStep` 4 → `s4`). */
export function idOf(kind, number) {
  const prefix = { step: 's', branch: 'b', group: 'g', note: 'n', journal: 'j' }[kind];
  if (prefix === undefined || !Number.isSafeInteger(number) || number < 0) {
    fail(`An id is a step, branch, group, note or journal number, not ${kind} ${number}`);
  }
  return `${prefix}${number}`;
}

/** A branch's color slot from its number. */
export function laneOf(branchId) {
  return idNumber(branchId) % HISTORY_LANE_COUNT;
}

// ---------------------------------------------------------------------------
// Names

/**
 * White space in a name, as code points: trimmed from both ends, and each run
 * inside becomes one space. The same set as JavaScript's `\s`, spelled out so
 * Python and R match it exactly.
 */
export const NAME_WHITE_SPACE = Object.freeze([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const WHITE_CLASS = NAME_WHITE_SPACE.map(code => `\\u{${code.toString(16)}}`).join('');
const WHITE_RUN = new RegExp(`[${WHITE_CLASS}]+`, 'gu');
const WHITE_EDGES = new RegExp(`^[${WHITE_CLASS}]+|[${WHITE_CLASS}]+$`, 'gu');
/** Control characters (C0 and C1) a name may not hold once its white space is folded. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * A name in its stored form: NFC, white space trimmed, each inner run of
 * white space one space. Empty when nothing is left.
 * @param {string} text
 */
export function normalizeName(text) {
  if (typeof text !== 'string') fail('A name is text');
  return text.normalize('NFC').replace(WHITE_EDGES, '').replace(WHITE_RUN, ' ');
}

/**
 * A name's key, what uniqueness compares: its stored form lower-cased with
 * the Unicode default mapping (JavaScript `toLowerCase`, Python `str.lower`),
 * then NFC.
 * @param {string} text
 */
export function nameKey(text) {
  return normalizeName(text).toLowerCase().normalize('NFC');
}

/** Names that would read as an id of their kind, so a reference could mean either. */
const ID_LIKE = Object.freeze({
  branch: HISTORY_ID_PATTERNS.branch,
  group: HISTORY_ID_PATTERNS.group,
  tracker: HISTORY_ID_PATTERNS.tracker,
  bookmark: null,
});

/**
 * Why `text` cannot name a `kind` ('branch', 'group', 'tracker', 'bookmark'),
 * or null. Uniqueness is the caller's (it knows the other names).
 * @param {'branch'|'group'|'tracker'|'bookmark'} kind
 * @param {string} text
 */
export function nameProblem(kind, text) {
  if (!Object.hasOwn(ID_LIKE, kind)) fail(`There is no kind of name "${kind}"`);
  const name = normalizeName(text);
  if (name.length === 0) return HISTORY_SENTENCES.nameEmpty({ kind });
  if (CONTROL.test(name)) return HISTORY_SENTENCES.nameControl({ kind });
  if (ID_LIKE[kind]?.test(nameKey(name))) return HISTORY_SENTENCES.nameLikeId({ kind, name });
  return null;
}

/**
 * `${prefix} ${n}` for the first n from `start` whose key no name in `taken`
 * has: the default names `Branch 4`, `Tracker 2`.
 * @param {string} prefix
 * @param {number} start
 * @param {Iterable<string>} taken - names (any form)
 */
export function defaultName(prefix, start, taken) {
  const keys = new Set([...taken].map(nameKey));
  let n = start;
  while (keys.has(nameKey(`${prefix} ${n}`))) n++;
  return `${prefix} ${n}`;
}

/**
 * `name` itself when free, else `name (suffix)`, `name (suffix 2)`, …: a
 * session's tracker loaded beside one of the same name ("Tracker 1
 * (shared)"), a branch restored over a name taken since ("X (restored)").
 * @param {string} name
 * @param {string} suffix
 * @param {Iterable<string>} taken
 */
export function suffixedName(name, suffix, taken) {
  const keys = new Set([...taken].map(nameKey));
  if (!keys.has(nameKey(name))) return normalizeName(name);
  let candidate = `${normalizeName(name)} (${suffix})`;
  for (let n = 2; keys.has(nameKey(candidate)); n++) candidate = `${normalizeName(name)} (${suffix} ${n})`;
  return candidate;
}

// ---------------------------------------------------------------------------
// Sentences: the refusals the history's actions give, said once.

function quotedList(items) {
  const quoted = items.map(quoteName);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** `ActionRefused` codes of the history's actions (beyond the dispatcher's own). */
export const HISTORY_REFUSAL_CODES = Object.freeze([
  'no-target', 'name-taken', 'name-invalid', 'main-branch', 'locked', 'moved', 'not-author', 'not-revertible',
  'restore-conflict', 'not-consecutive', 'splits-turn', 'forks-inside', 'in-group', 'cuts-group',
]);

/** Every sentence the history says when it refuses or tells, built from its facts. */
export const HISTORY_SENTENCES = Object.freeze({
  nameEmpty: ({ kind }) => `A ${kind} needs a name.`,
  nameControl: ({ kind }) => `A ${kind} name cannot hold control characters.`,
  nameLikeId: ({ kind, name }) => `A ${kind} cannot be called ${quoteName(name)}: that is the form of a ${kind} id. Choose another name.`,
  /** `where`: what tells the other apart ("from step 2"), or null. */
  nameTaken: ({ kind, name, where = null }) => `A ${kind} is already called ${quoteName(name)}${where === null ? '' : ` (${where})`}; choose another name.`,
  bookmarkTaken: ({ name, step }) => `Step ${idNumber(step)} is already bookmarked ${quoteName(name)}; choose another name.`,
  mainBranch: () => 'Make another branch main first.',
  locked: ({ name }) => `${quoteName(name)} is locked; unlock it first.`,
  lockedStarted: ({ name, started }) => `${quoteName(name)} is locked; your change started ${quoteName(started)}.`,
  pending: ({ name, step }) => `Next change starts ${quoteName(name)} from step ${idNumber(step)}.`,
  moved: ({ name }) => `The person is now on branch ${quoteName(name)}. Ask before continuing there, or call history_branch_switch.`,
  notAuthor: () => 'Notes are edited by their author; add a reply note instead.',
  notRevertible: ({ domains }) => `Later steps also change ${domains.join(', ')}; use Branch without this step.`,
  restoreConflict: ({ label }) => `${quoteName(label)} was changed since; it is restored as new objects instead.`,
  noBranch: ({ ref, names }) => `There is no branch ${quoteName(ref)}; the branches are ${quotedList(names)}.`,
  noTracker: ({ ref, names }) => `There is no tracker ${quoteName(ref)}; the trackers are ${quotedList(names)}.`,
  // Said to agents and to a notebook's viewer actions (history_get, viewer.history_get(),
  // cellucid_history_get()); the packages' session readers name their own call instead
  // (cellucid-python `Tracker.steps`, cellucid-r `cellucid_steps(tracker)`).
  noStep: ({ step, tracker }) => `There is no step ${quoteName(step)} in the tracker ${quoteName(tracker)}; history_get lists its steps.`,
  /**
   * A turn the tracker has no record of: a turn is recorded with its first
   * step (or act outside the state), so one that only read or changed
   * nothing has none. `then`: what that means for the action ("nothing to undo").
   */
  noTurn: ({ turn, tracker, then }) => `The tracker ${quoteName(tracker)} has no record of the turn ${quoteName(turn)}: a turn is recorded with its first step, so one that only read or changed nothing has ${then}; history_summary lists the turns it has.`,
  noGroup: ({ ref, names }) => (names.length === 0
    ? `There is no group ${quoteName(ref)}; the tracker has no group.`
    : `There is no group ${quoteName(ref)}; the groups are ${quotedList(names)}.`),
  /** A group or a squash over steps that are not one run of one branch's own steps. */
  notConsecutive: ({ from, to }) => `Steps ${idNumber(from)} to ${idNumber(to)} are not consecutive steps of one branch; group or squash a run of one branch's own steps.`,
  /** A group would hold part of a turn: `from`, `to` widened to whole turns. */
  splitsTurn: ({ label, from, to }) => `That would split the turn ${quoteName(label)}; a group holds whole turns: steps ${idNumber(from)} to ${idNumber(to)}.`,
  /** A group is extended to a step it holds already (a turn's later steps join its group, `history.js`). */
  alreadyInGroup: ({ step, name }) => `Step ${idNumber(step)} is in the group ${quoteName(name)} already: a turn's later steps join its group; extend it to a step after it.`,
  /** A step of the range is in another group already (one level of groups). */
  inGroup: ({ step, name }) => `Step ${idNumber(step)} is in the group ${quoteName(name)} already; extend it, or ungroup it first.`,
  /** A squash would cut a group: it stays inside one group or covers whole groups. */
  cutsGroup: ({ name }) => `That would cut the group ${quoteName(name)}; squash inside it, or all of its steps.`,
  /** Branches start inside a range to squash; `upTo`: the last step a squash may reach, or null. */
  forksInside: ({ names, upTo }) => `${names.length === 1 ? `The branch ${quotedList(names)} starts inside` : `${formatCountOf(names.length, 'branch', 'branches')} start inside (${quotedList(names)})`}: group instead${upTo === null ? '' : `, or squash up to step ${idNumber(upTo)}`}.`,
  /** An agent squashes only its own turn's steps. */
  notOwnSteps: () => 'An agent squashes only its own turn\'s steps; ask the person to squash the others.',
});

/**
 * The label of a squashed step, from why it was made and the domains it
 * changes (each by its name, "Colors"): "While paused: Colors, Filters",
 * "Merged 6 steps: Camera", "Fresh start: Fields and labels, Highlights",
 * "Shared state".
 * @param {{cause: string, count: number|null, domains: string[]}} facts - `domains`: names, in domain order
 */
export function squashedLabel({ cause, count, domains }) {
  const listed = domains.length === 0 ? 'nothing changed' : domains.join(', ');
  switch (cause) {
    case 'paused': return `While paused: ${listed}`;
    case 'steps': return `Merged ${formatCountOf(count, 'step')}: ${listed}`;
    case 'clear': return `Fresh start: ${listed}`;
    case 'share': return 'Shared state';
    default: return fail(`A squashed step is made for one of ${SQUASH_CAUSES.join(', ')}, not ${cause}`);
  }
}

// ---------------------------------------------------------------------------
// Field specs: one table the validators check and the document describes.

const T = Object.freeze({
  text: Object.freeze({ type: 'text' }),
  string: Object.freeze({ type: 'string' }),
  name: Object.freeze({ type: 'name' }),
  time: Object.freeze({ type: 'time' }),
  boolean: Object.freeze({ type: 'boolean' }),
  hash: Object.freeze({ type: 'hash' }),
  json: Object.freeze({ type: 'json' }),
  object: Object.freeze({ type: 'object' }),
});
const id = kind => Object.freeze({ type: 'id', kind });
const integer = (minimum, maximum = null) => Object.freeze({ type: 'integer', minimum, maximum });
const number = minimum => Object.freeze({ type: 'number', minimum });
const oneOf = values => Object.freeze({ type: 'enum', values });
const list = item => Object.freeze({ type: 'array', item });
const pair = (first, second) => Object.freeze({ type: 'pair', items: Object.freeze([first, second]) });
const record = name => Object.freeze({ type: 'record', name });
const nullable = spec => Object.freeze({ ...spec, nullable: true });
const optional = spec => Object.freeze({ ...spec, optional: true });
/** `spec` with its description (what the document and the reading models say of the field). */
const about = (spec, description) => Object.freeze({ ...spec, description });

const DOMAIN_HASHES = Object.freeze(Object.fromEntries(DOMAIN_IDS.map(domain => [
  domain, about(optional(T.hash), `The value hash of "${domain}".`),
])));

/**
 * Every record: its description and fields, in the order a reader lists them.
 * @type {Record<string, {description: string, fields: Record<string, object>}>}
 */
const RECORDS = {
  By: {
    description: 'Who acted: a person, an agent for them, a notebook, a replay, a session, the opening, or a change made outside an action.',
    fields: {
      origin: about(oneOf(BY_ORIGINS), 'Who acted.'),
      agent: about(nullable(T.text), 'The agent (Claude, ChatGPT, …) when the origin is agent.'),
      model: about(nullable(T.text), 'The agent\'s model when known (claude-sonnet-4-6, …).'),
      host: about(nullable(oneOf(ACTION_HOSTS)), 'The notebook language when the origin is host.'),
      person: about(nullable(T.text), 'The person\'s display name, only when they chose to record it.'),
      turn: about(nullable(T.text), 'The agent or notebook turn it belongs to.'),
    },
  },
  Note: {
    description: 'A note on a step, a branch, a turn or the tracker: history metadata, never part of a step\'s identity.',
    fields: {
      id: about(id('note'), 'n<n>, unique in its tracker.'),
      text: about(T.text, 'Markdown subset: emphasis, inline code, http(s) links; rendered without HTML.'),
      by: about(record('By'), 'Its author.'),
      at: about(T.time, 'When it was written.'),
      editedAt: about(T.time, 'When it was last edited, or null.'),
      fromReply: about(T.boolean, 'Written for an agent from the first sentence of its final reply (a turn summary it did not write).'),
    },
  },
  Branch: {
    description: 'A line of steps with a unique name, from its fork step to its tip.',
    fields: {
      id: about(id('branch'), 'b<n>, never reused in its tracker.'),
      name: about(T.name, 'Unique in its tracker (by its key).'),
      base: about(nullable(id('step')), 'The step it forks from; null for the branch that holds the root.'),
      tip: about(id('step'), 'Its last step, one of its own.'),
      createdAt: about(T.time, 'When its first step was made.'),
      by: about(record('By'), 'Who made it.'),
      lane: about(integer(0, HISTORY_LANE_COUNT - 1), 'Its color slot (--history-lane-<lane>).'),
      locked: about(T.boolean, 'No new step, rename, delete or compaction until unlocked.'),
      archived: about(T.boolean, 'Hidden from the graph and the pickers; kept.'),
      notes: about(list(record('Note')), 'Its notes, oldest first.'),
    },
  },
  Group: {
    description: 'A named folder over consecutive steps of one branch (metadata only): each of its steps names it (Step.group).',
    fields: {
      id: about(id('group'), 'g<n>, never reused in its tracker.'),
      name: about(T.name, 'Unique in its tracker (by its key).'),
      createdAt: about(T.time, 'When it was made.'),
      by: about(record('By'), 'Who made it.'),
      notes: about(list(record('Note')), 'Its notes, oldest first.'),
    },
  },
  Squash: {
    description: 'What a squashed step stands for: why it was made and from what.',
    fields: {
      cause: about(oneOf(SQUASH_CAUSES), 'paused (changes made while recording was paused), steps (consecutive steps merged into one), clear (the history cleared, the state kept) or share (a state shared without its history).'),
      count: about(nullable(integer(1)), 'How many steps it replaced; null for paused (no step was recorded) and share (left out).'),
      by: about(list(record('By')), 'Everyone who acted in what it replaced, in the order they first acted; empty for share.'),
      carried: about(record('Carried'), 'What the steps it replaced carried that it keeps: their notes (now its own) and bookmarks.'),
    },
  },
  Carried: {
    description: 'The notes and bookmarks of the steps a squash replaced, kept by the squashed step.',
    fields: {
      notes: about(list(id('note')), 'Its notes that were on the steps it replaced, the last one\'s included, each once (they keep their ids).'),
      bookmarks: about(list(T.name), 'The bookmarks of the steps it replaced: jumping to one shows this step.'),
    },
  },
  Pause: {
    description: 'A tracker\'s recording, paused: since when, who acted, and what differs from its head.',
    fields: {
      at: about(T.time, 'When recording was paused.'),
      by: about(list(record('By')), 'Who paused it, then everyone who acted while it was paused, each once.'),
      draft: about(nullable(record('DomainValues')), 'The value hash of each domain that differs from the head (this browser\'s autosave keeps it, so a crash loses nothing; its values are referenced, never pruned); null in a file, which squashes it first, and when nothing differs.'),
    },
  },
  Membership: {
    description: 'Which steps a group held: a run of consecutive steps of one branch, from its first to its last.',
    fields: {
      group: about(id('group'), 'The group.'),
      from: about(id('step'), 'Its first step.'),
      to: about(id('step'), 'Its last step (from itself for one step).'),
    },
  },
  DomainValues: {
    description: 'The value hash of each state domain a step changed (or, for the root, of every domain).',
    fields: DOMAIN_HASHES,
  },
  BranchTip: {
    description: 'Another branch\'s last step, an input a kept view of a branch reads.',
    fields: {
      tracker: about(id('tracker'), 'The tracker of the branch.'),
      branch: about(id('branch'), 'The branch.'),
      tip: about(id('step'), 'Its tip when the step was recorded.'),
    },
  },
  Reads: {
    description: 'What a step\'s result depends on, as recorded: the value hash of each state domain its action reads, and another branch\'s tip for a view of a branch.',
    fields: {
      ...DOMAIN_HASHES,
      history: about(optional(record('BranchTip')), 'The branch a kept view of a branch shows.'),
    },
  },
  DatasetName: {
    description: 'A dataset as a link names it.',
    fields: {
      id: about(nullable(T.text), 'Its identity id.'),
      name: about(nullable(T.text), 'Its name.'),
    },
  },
  ReplayOf: {
    description: 'The recorded step a replayed step was made from.',
    fields: {
      tracker: about(id('tracker'), 'Its tracker.'),
      step: about(id('step'), 'Its step.'),
      dataset: about(record('DatasetName'), 'The dataset it was recorded on.'),
    },
  },
  Step: {
    description: 'One action as recorded, or the root (which records none).',
    fields: {
      id: about(id('step'), 's<n>, greater than its parent\'s; the root is s0.'),
      parent: about(nullable(id('step')), 'The step it was made after; null for the root.'),
      children: about(list(id('step')), 'The steps made after it, oldest first.'),
      branch: about(id('branch'), 'The branch it was made on.'),
      kind: about(oneOf(STEP_KINDS), 'root, action, outside (a change made outside an action) or squashed (several merged into one, or what changed while paused).'),
      type: about(nullable(T.text), 'The action (history.outside-change for a change made outside one); null for the root and a squashed step.'),
      params: about(nullable(T.object), 'The action\'s parameters, by name (cells by original position); null for the root and a squashed step.'),
      v: about(nullable(integer(1)), 'The version of the action\'s parameters it was recorded with (the catalog\'s version); null but for an action.'),
      code: about(nullable(T.text), 'Its pseudocode line as recorded; null for the root, an outside change and a squashed step.'),
      label: about(T.text, 'What it did, in a sentence.'),
      by: about(record('By'), 'Who took it.'),
      at: about(T.time, 'When it was made (the first change, when several merged).'),
      until: about(T.time, 'Its last merged change (equal to at when one).'),
      merged: about(integer(1), 'How many changes it holds (a drag, a gesture).'),
      ms: about(nullable(number(0)), 'How long its action took; null when not measured.'),
      touches: about(list(oneOf(DOMAIN_IDS)), 'The state domains it changed, in domain order.'),
      before: about(record('DomainValues'), 'Each touched domain\'s value hash before it.'),
      after: about(record('DomainValues'), 'Each touched domain\'s value hash after it (the root: every domain).'),
      reads: about(record('Reads'), 'Each input its action declares (reads), as it was when it was recorded.'),
      status: about(oneOf(STEP_STATUSES), 'Whether it still applies.'),
      reason: about(nullable(T.text), 'The system\'s sentence: why it no longer applies, or why it changes nothing.'),
      outcome: about(nullable(T.object), 'What its action answered: counts, names, ids (never cells).'),
      coalesceKey: about(nullable(T.text), 'What a following change must share to merge into it.'),
      replayOf: about(nullable(record('ReplayOf')), 'The recorded step it replays.'),
      squashed: about(nullable(record('Squash')), 'What a squashed step stands for; null for every other kind.'),
      notes: about(list(record('Note')), 'Its notes, oldest first.'),
      bookmark: about(nullable(T.name), 'Its bookmark, unique in its tracker.'),
      group: about(nullable(id('group')), 'The group it is in, or null.'),
    },
  },
  OutsideAct: {
    description: 'What a turn did outside the state that no undo takes back (a vote published, a file written): no step records it.',
    fields: {
      type: about(T.text, 'The action (annotation.publish, figure.export, …).'),
      label: about(T.text, 'What it did, as its step would be labeled.'),
      at: about(T.time, 'When it was done.'),
    },
  },
  Turn: {
    description: 'One agent or notebook turn: its steps undo together; what it did outside the state stays done.',
    fields: {
      id: about(T.text, 'The turn id the dispatch carried.'),
      by: about(record('By'), 'The agent or notebook (by.turn is this id).'),
      label: about(T.text, 'What it was asked to do, in a few words.'),
      conversation: about(nullable(T.text), 'Its conversation, when a chat holds it.'),
      message: about(nullable(T.text), 'The message that acted.'),
      startedAt: about(T.time, 'Its first step.'),
      endedAt: about(T.time, 'Its last step.'),
      branch: about(id('branch'), 'The branch it acts on (where it started, or where it switched to).'),
      notes: about(list(record('Note')), 'Its notes; the first is its summary.'),
      outside: about(list(record('OutsideAct')), 'What it did outside the state, which Undo turn does not take back, oldest first.'),
    },
  },
  TrackerPatch: {
    description: 'Tracker fields a journal entry replaced.',
    fields: {
      name: about(optional(T.name), 'The tracker\'s name.'),
      headId: about(optional(id('step')), 'The step shown.'),
      activeBranch: about(optional(id('branch')), 'The active branch.'),
      mainBranch: about(optional(id('branch')), 'The main branch.'),
      notes: about(optional(list(record('Note'))), 'The tracker\'s notes.'),
      removed: about(optional(nullable(record('Removal'))), 'Whether it was removed.'),
    },
  },
  Patch: {
    description: 'The exact records an edit replaced or removed (before) or made (after), by id: in before only, it removed them; in after only, it made them.',
    fields: {
      steps: about(list(record('Step')), 'Steps.'),
      branches: about(list(record('Branch')), 'Branches.'),
      groups: about(list(record('Group')), 'Groups.'),
      memberships: about(list(record('Membership')), 'Which steps each group held (a group edit records these, never the member steps).'),
      turns: about(list(record('Turn')), 'Turns.'),
      tracker: about(record('TrackerPatch'), 'Tracker fields.'),
    },
  },
  JournalEntry: {
    description: 'One structural edit of the history, undoable from Recently deleted or the toast.',
    fields: {
      id: about(id('journal'), 'j<n>, never reused in its tracker.'),
      op: about(oneOf(JOURNAL_OPS), 'The edit.'),
      at: about(T.time, 'When.'),
      by: about(record('By'), 'Who.'),
      label: about(T.text, 'What it did, in a sentence ("Deleted branch "X" (4 steps)").'),
      before: about(nullable(record('Patch')), 'What it replaced; null once purged.'),
      after: about(nullable(record('Patch')), 'What it made; null once purged.'),
      purged: about(T.boolean, 'Emptied from Recently deleted: it can no longer be undone.'),
    },
  },
  CellOrderEmbedding: {
    description: 'The embedding a cell-order digest is over.',
    fields: {
      key: about(T.text, 'Its obsm key.'),
      columns: about(list(integer(0)), 'Its 0-based columns.'),
    },
  },
  CellOrder: {
    description: 'The cell-order digest of a dataset (session-context.js).',
    fields: {
      embedding: about(record('CellOrderEmbedding'), 'The embedding it is over.'),
      dimension: about(integer(1, 3), 'Its dimension.'),
      digest: about(Object.freeze({ type: 'string', pattern: /^[0-9a-f]{16}$/ }), '16 lower-case hex digits.'),
    },
  },
  DatasetIdentity: {
    description: 'The dataset a history is of.',
    fields: {
      id: about(nullable(T.text), 'Its identity id.'),
      name: about(nullable(T.text), 'Its name.'),
      cellOrder: about(nullable(record('CellOrder')), 'Its cell order, when known.'),
    },
  },
  TrackerName: {
    description: 'A tracker as a link names it.',
    fields: { id: about(id('tracker'), 'Its id.'), name: about(T.text, 'Its name then.') },
  },
  BranchName: {
    description: 'A branch as a link names it.',
    fields: { id: about(id('branch'), 'Its id.'), name: about(T.text, 'Its name then.') },
  },
  Link: {
    description: 'Where a replayed or loaded tracker comes from.',
    fields: {
      dataset: about(record('DatasetName'), 'The dataset its steps were recorded on.'),
      tracker: about(record('TrackerName'), 'The tracker they come from.'),
      branch: about(nullable(record('BranchName')), 'The branch replayed; null for a loaded tracker.'),
      step: about(nullable(id('step')), 'The last step replayed; null for a loaded tracker.'),
      file: about(nullable(T.text), 'The session file\'s name, when it came from one.'),
      saved: about(nullable(T.text), 'The saved state\'s id, when it came from one of this browser.'),
    },
  },
  ReplayEntry: {
    description: 'What became of one step of a replay.',
    fields: {
      source: about(id('step'), 'The step replayed.'),
      label: about(T.text, 'Its label.'),
      outcome: about(oneOf(REPLAY_OUTCOMES), 'What became of it.'),
      step: about(nullable(id('step')), 'The step it became here.'),
      reason: about(nullable(T.text), 'Why it was not applied.'),
      missing: about(nullable(record('ReplayMissing')), 'The name it gave that resolves to nothing here (a field, a category or a gene), so another can be used instead; null otherwise.'),
    },
  },
  ReplayMissing: {
    description: 'A name a replayed step gave that resolves to nothing here.',
    fields: {
      kind: about(oneOf(REPLAY_MISSING_KINDS), 'What it names: field, category or gene.'),
      name: about(T.text, 'The name as the step gave it.'),
      field: about(nullable(T.text), 'For a category, the field it was looked for in; null otherwise.'),
    },
  },
  NameMap: {
    description: 'One name used in place of another.',
    fields: { from: about(T.text, 'The recorded name.'), to: about(T.text, 'The name used here.') },
  },
  CategoryMap: {
    description: 'One category label used in place of another, in a field.',
    fields: {
      field: about(T.text, 'The obs field (its recorded key).'),
      from: about(T.text, 'The recorded label.'),
      to: about(T.text, 'The label used here.'),
    },
  },
  Mapping: {
    description: 'The names a replay used in place of the recorded ones, applied before names resolve.',
    fields: {
      fields: about(list(record('NameMap')), 'obs fields.'),
      categories: about(list(record('CategoryMap')), 'Categories.'),
      genes: about(list(record('NameMap')), 'Genes.'),
    },
  },
  Start: {
    description: 'What a tracker started from.',
    fields: {
      kind: about(oneOf(TRACKER_START_KINDS), 'opened, shown, replay or import.'),
      from: about(nullable(record('Link')), 'Where its steps come from (replay, import).'),
      report: about(nullable(list(record('ReplayEntry'))), 'The replay\'s report (replay only).'),
      mapping: about(nullable(record('Mapping')), 'The names the replay mapped (replay only).'),
    },
  },
  Removal: {
    description: 'A tracker in Recently deleted.',
    fields: { at: about(T.time, 'When it was removed.'), by: about(record('By'), 'Who removed it.') },
  },
  Tracker: {
    description: 'One tree of steps on the dataset, with its branches, turns, notes and journal.',
    fields: {
      id: about(id('tracker'), 't-<uuid>, unique in its history.'),
      name: about(T.name, 'Unique among the history\'s trackers that are not removed.'),
      dataset: about(record('DatasetIdentity'), 'The dataset.'),
      createdAt: about(T.time, 'When it started.'),
      by: about(record('By'), 'Who started it (the root step\'s by).'),
      start: about(record('Start'), 'What it started from.'),
      removed: about(nullable(record('Removal')), 'Set while it is in Recently deleted.'),
      rootId: about(id('step'), 'Its root, s0.'),
      headId: about(id('step'), 'The step shown, on the active branch\'s path.'),
      activeBranch: about(id('branch'), 'The branch redo follows and the panel shows.'),
      mainBranch: about(id('branch'), 'What sharing, replay and load default to.'),
      paused: about(nullable(record('Pause')), 'Null while it records; while paused, changes apply without a step, and resuming adds one squashed step for what differs.'),
      branches: about(list(record('Branch')), 'Its branches in id order.'),
      groups: about(list(record('Group')), 'Its groups in id order.'),
      steps: about(list(record('Step')), 'Its steps in id order (parents before children).'),
      turns: about(list(record('Turn')), 'Its turns, in the order they started.'),
      notes: about(list(record('Note')), 'Notes on the tracker (the first is its abstract).'),
      journal: about(list(record('JournalEntry')), 'Its structural edits in id order.'),
      chats: about(list(pair(T.text, T.json)), 'Conversations kept with it: [conversation id, transcript].'),
      nextStep: about(integer(1), 'The number of its next step.'),
      nextBranch: about(integer(1), 'The number of its next branch.'),
      nextGroup: about(integer(0), 'The number of its next group.'),
      nextNote: about(integer(0), 'The number of its next note.'),
      nextJournal: about(integer(0), 'The number of its next journal entry.'),
    },
  },
  History: {
    description: 'Every tracker of the open dataset.',
    fields: {
      dataset: about(record('DatasetIdentity'), 'The dataset.'),
      activeTracker: about(id('tracker'), 'The tracker in use.'),
      trackers: about(list(record('Tracker')), 'Its trackers, in the order they started.'),
    },
  },
  AppStamp: {
    description: 'What wrote a session file.',
    fields: {
      version: about(T.text, 'The Cellucid version.'),
      catalog: about(T.hash, 'The SHA-256 of the action catalog document it was written with.'),
    },
  },
  ActionStamp: {
    description: 'One version of one action a session\'s steps use (one stamp per type and version present).',
    fields: {
      type: about(T.text, 'The action.'),
      version: about(integer(1), 'The version of its parameters the steps were recorded with (Step.v).'),
      params: about(nullable(T.hash), 'SHA-256 of the shape of that version\'s params schema (actionParamsShape, canonical JSON) when the writer\'s catalog is at that version; null for an earlier version, whose upgraders take it forward.'),
    },
  },
  ScopeBranches: {
    description: 'The branches of one tracker a share includes.',
    fields: { tracker: about(id('tracker'), 'The tracker.'), branches: about(list(id('branch')), 'Its branches included.') },
  },
  Scope: {
    description: 'What a Share or a Save chose to include.',
    fields: {
      trackers: about(list(id('tracker')), 'The trackers included.'),
      branches: about(list(record('ScopeBranches')), 'The branches included, per tracker.'),
      content: about(oneOf(SHARE_CONTENTS), 'history: the trackers and branches with their values; state: the current state only (one tracker: the root and one squashed step); steps: steps only, no values (a replay plan).'),
      results: about(oneOf(SHARE_RESULTS), 'include: analysis results kept; recompute: left out, computed again on open from their recorded inputs (always so for steps).'),
      notes: about(T.boolean, 'Notes and bookmarks included.'),
      chats: about(T.boolean, 'Conversations included.'),
      journal: about(T.boolean, 'Recently deleted included.'),
      times: about(oneOf(SHARE_TIMES), 'exact; dates (each time rounded down to its UTC day); none (every time null).'),
      source: about(oneOf(SHARE_SOURCES), 'full: where the dataset opens from; name: its name only (source null).'),
    },
  },
  Requires: {
    description: 'The dataset fields a state uses.',
    fields: { obs: about(list(T.text), 'obs fields.'), var: about(list(T.text), 'Genes.') },
  },
  Session: {
    description: 'A session file as read: its header and every tracker it holds.',
    fields: {
      createdAt: about(T.text, 'Canonical ISO time of the save.'),
      app: about(record('AppStamp'), 'What wrote it.'),
      actions: about(list(record('ActionStamp')), 'Each action type and version its steps use, sorted by type then version.'),
      scope: about(record('Scope'), 'What was shared.'),
      datasetFingerprint: about(T.object, 'The dataset it was saved on (session-context.js).'),
      source: about(nullable(T.object), 'Where that dataset opens from (dataset-source-record.js).'),
      requires: about(record('Requires'), 'The fields the shown state uses.'),
      cells: about(nullable(T.object), 'The subsample it was saved on (cell-subset-record.js).'),
      genes: about(nullable(T.object), 'The cells genes were read for.'),
      activeTracker: about(id('tracker'), 'The tracker shown.'),
      trackers: about(list(record('Tracker')), 'Its trackers.'),
    },
  },
  ApplyPlanRow: {
    description: 'One change an apply makes to an AnnData, a Seurat object or a SingleCellExperiment.',
    fields: {
      kind: about(oneOf(APPLY_ROW_KINDS), 'What it is.'),
      domain: about(oneOf(DOMAIN_IDS), 'The state domain it comes from.'),
      name: about(T.text, 'The column, gene set or domain it writes or reports.'),
      column: about(nullable(T.text), 'The column a category row is in.'),
      from: about(list(T.text), 'The earlier names (renames, merges).'),
      cells: about(nullable(integer(0)), 'The cells it marks or labels.'),
      status: about(oneOf(APPLY_ROW_STATUSES), 'write, replace (an earlier apply\'s column, with overwrite), unchanged (already applied) or not-applied.'),
      note: about(nullable(T.text), 'Why, when not applied or replaced.'),
    },
  },
  ApplyPlan: {
    description: 'What applying a step would change, written nowhere yet (a dry run).',
    fields: {
      session_sha256: about(T.hash, 'The session file\'s SHA-256.'),
      tracker: about(id('tracker'), 'The tracker.'),
      branch: about(id('branch'), 'The branch.'),
      step: about(id('step'), 'The step applied.'),
      requires: about(record('Requires'), 'The fields the step\'s state uses.'),
      rows: about(list(record('ApplyPlanRow')), 'Every change, in domain order.'),
    },
  },
  Renamed: {
    description: 'One rename an apply made.',
    fields: {
      kind: about(oneOf(['column', 'category']), 'A column or a category.'),
      column: about(nullable(T.text), 'The column of a category.'),
      from: about(T.text, 'The earlier name.'),
      to: about(T.text, 'The new name.'),
    },
  },
  Skipped: {
    description: 'One change an apply did not make.',
    fields: { kind: about(oneOf(APPLY_ROW_KINDS), 'What it is.'), name: about(T.text, 'Its name.'), note: about(T.text, 'Why.') },
  },
  ExpressionValues: {
    description: 'The expression values the genes were shown and analyzed in at a step (its `expression` value: the Data mapping\'s Expression values): the transform asked, which never changes the values an object stores.',
    fields: {
      normalize: about(T.boolean, 'Each cell scaled to 10,000 total counts (scanpy\'s normalize_total(target_sum=1e4)).'),
      log1p: about(T.boolean, 'Then ln(1 + x) (scanpy\'s log1p); both false: the values as stored.'),
    },
  },
  Provenance: {
    description: 'One apply, recorded in uns[\'cellucid\'][\'history_applied\'] (misc / metadata in R).',
    fields: {
      session_sha256: about(T.hash, 'The session file\'s SHA-256.'),
      tracker: about(id('tracker'), 'The tracker.'),
      branch: about(id('branch'), 'The branch.'),
      step: about(id('step'), 'The step applied.'),
      applied_at: about(T.text, 'Canonical ISO time (UTC).'),
      cellucid_version: about(T.text, 'The package version.'),
      package: about(oneOf(APPLY_PACKAGES), 'What applied it.'),
      columns: about(list(T.text), 'The columns it owns (replaced only with overwrite).'),
      renamed: about(list(record('Renamed')), 'What it renamed.'),
      skipped: about(list(record('Skipped')), 'What it did not apply.'),
      expression: about(nullable(record('ExpressionValues')), 'The expression values of the step applied (what the person looked at the genes in), recorded, never applied: X keeps its values. Null when the session holds none (a session from before them: the values as stored).'),
      session: about(nullable(T.text), 'The session file itself, base64, when kept to rebuild the history.'),
    },
  },
  ApplyReport: {
    description: 'What an apply did.',
    fields: {
      plan: about(record('ApplyPlan'), 'Its plan.'),
      applied: about(T.boolean, 'False when every row was already applied (nothing written).'),
      provenance: about(nullable(record('Provenance')), 'The record written; null when nothing was.'),
    },
  },
};
for (const definition of Object.values(RECORDS)) Object.freeze(definition.fields);
Object.freeze(RECORDS);

/** The record names, as the document lists them. */
export const HISTORY_RECORDS = Object.freeze(Object.keys(RECORDS));

/** A record's field names, in order (what a reader exposes). */
export function recordFields(name) {
  const definition = RECORDS[name];
  if (definition === undefined) fail(`There is no history record "${name}"`);
  return Object.keys(definition.fields);
}

// ---------------------------------------------------------------------------
// Shape checks, from the specs.

function expected(spec) {
  const base = (() => {
    switch (spec.type) {
      case 'text': return 'a non-empty text';
      case 'string': return spec.pattern ? `text of the form ${spec.pattern.source}` : 'text';
      case 'name': return 'a name in its stored form (NFC, trimmed, single-spaced)';
      case 'time': return 'a time in milliseconds since 1970 or null';
      case 'boolean': return 'true or false';
      case 'hash': return 'a value hash (64 lower-case hex digits)';
      case 'id': return `a ${spec.kind} id like "${ID_EXAMPLES[spec.kind]}"`;
      case 'integer': return spec.maximum === null ? `a whole number from ${spec.minimum}` : `a whole number from ${spec.minimum} to ${spec.maximum}`;
      case 'number': return `a number from ${spec.minimum}`;
      case 'enum': return `one of ${spec.values.map(value => JSON.stringify(value)).join(', ')}`;
      case 'array': return 'a list';
      case 'pair': return 'a pair';
      case 'record': return `a ${spec.name} record`;
      case 'object': return 'a record';
      default: return 'a value';
    }
  })();
  return spec.nullable && spec.type !== 'time' ? `${base} or null` : base;
}

function itemPath(path, item, index) {
  return isPlainRecord(item) && typeof item.id === 'string' ? `${path}[${JSON.stringify(item.id)}]` : `${path}[${index}]`;
}

function checkValue(spec, value, path) {
  if (value === null && (spec.nullable || spec.type === 'time' || spec.type === 'json')) return;
  const wrong = () => fail(`${path} must be ${expected(spec)}`);
  switch (spec.type) {
    case 'text': if (typeof value !== 'string' || value.length === 0) wrong(); return;
    case 'string': if (typeof value !== 'string' || (spec.pattern && !spec.pattern.test(value))) wrong(); return;
    case 'name': if (typeof value !== 'string' || value.length === 0 || normalizeName(value) !== value) wrong(); return;
    case 'time': if (typeof value !== 'number' || !Number.isFinite(value)) wrong(); return;
    case 'boolean': if (typeof value !== 'boolean') wrong(); return;
    case 'hash': if (typeof value !== 'string' || !VALUE_HASH_PATTERN.test(value)) wrong(); return;
    case 'id': if (typeof value !== 'string' || !HISTORY_ID_PATTERNS[spec.kind].test(value)) wrong(); return;
    case 'integer':
      if (!Number.isSafeInteger(value) || value < spec.minimum || (spec.maximum !== null && value > spec.maximum)) wrong();
      return;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.minimum) wrong(); return;
    case 'enum': if (!spec.values.includes(value)) wrong(); return;
    case 'array':
      if (!Array.isArray(value)) wrong();
      value.forEach((item, index) => checkValue(spec.item, item, itemPath(path, item, index)));
      return;
    case 'pair':
      if (!Array.isArray(value) || value.length !== 2) wrong();
      spec.items.forEach((item, index) => checkValue(item, value[index], `${path}[${index}]`));
      return;
    case 'record': checkRecord(spec.name, value, path); return;
    case 'object': if (value === null || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) wrong(); return;
    case 'json': if (value === undefined || typeof value === 'function' || typeof value === 'symbol') wrong(); return;
    default: fail(`${path} has an unknown spec`);
  }
}

function checkRecord(name, value, path) {
  const { fields } = RECORDS[name];
  if (!isPlainRecord(value)) fail(`${path} must be a ${name} record`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) fail(`${path} has an unknown field "${key}"`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      if (spec.optional) continue;
      fail(`${path} lacks "${key}"`);
    }
    checkValue(spec, value[key], `${path}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Record rules beyond their shape.

function checkBy(by, path) {
  if ((by.origin === 'agent') !== (by.agent !== null)) fail(`${path} names an agent exactly when its origin is "agent"`);
  if (by.model !== null && by.origin !== 'agent') fail(`${path} names a model only for an agent`);
  if ((by.origin === 'host') !== (by.host !== null)) fail(`${path} names a host exactly when its origin is "host"`);
  if (by.turn !== null && by.origin !== 'agent' && by.origin !== 'host') fail(`${path} belongs to a turn only for an agent or a host`);
}

/** Whether two `By` records say the same. */
export function sameBy(a, b) {
  return Object.keys(RECORDS.By.fields).every(key => a[key] === b[key]);
}

function checkNote(note, path) {
  checkBy(note.by, `${path}.by`);
  if (note.fromReply && note.by.origin !== 'agent') fail(`${path} is from an agent's reply only when an agent is its author`);
}

function checkNotes(notes, path) {
  notes.forEach(note => checkNote(note, `${path}[${JSON.stringify(note.id)}]`));
}

function sameKeys(record, keys) {
  const own = Object.keys(record).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((key, index) => key === want[index]);
}

/** One step's own rules (whatever tree it is in). */
function checkStepRules(step, path) {
  checkBy(step.by, `${path}.by`);
  checkNotes(step.notes, `${path}.notes`);
  const number = idNumber(step.id);
  if (new Set(step.children).size !== step.children.length) fail(`${path} lists a child twice`);
  if (step.children.some(child => idNumber(child) <= number)) fail(`${path} has a child numbered before it`);
  if (step.at !== null && step.until !== null && step.until < step.at) fail(`${path} ends (until) before it starts (at)`);
  if (step.status === 'unapplicable' && step.reason === null) fail(`${path} no longer applies and must say why (reason)`);
  if ((step.parent === null) !== (step.kind === 'root')) fail(`${path} is the root (kind "root") exactly when it has no parent`);
  if ((step.kind === 'squashed') !== (step.squashed !== null)) fail(`${path} says what it stands for (squashed) exactly when it is squashed`);
  if (step.kind !== 'action' && step.v !== null) fail(`${path} records a parameters version (v) only for an action`);
  if (step.parent === null) {
    if (step.id !== ROOT_STEP_ID) fail(`${path} has no parent, and only the root (${ROOT_STEP_ID}) has none`);
    if (step.type !== null || step.params !== null || step.code !== null || step.touches.length !== 0
      || Object.keys(step.before).length !== 0 || Object.keys(step.reads).length !== 0 || step.outcome !== null
      || step.coalesceKey !== null || step.replayOf !== null || step.merged !== 1 || step.ms !== null
      || step.status !== 'applied' || step.reason !== null || step.group !== null) {
      fail(`${path} is the root and records no action`);
    }
    return;
  }
  if (idNumber(step.parent) >= number) fail(`${path} is numbered before its parent`);
  if ((step.kind === 'outside') !== (step.type === OUTSIDE_CHANGE_TYPE)) {
    fail(`${path} is of kind "outside" exactly when it is a change made outside an action (${OUTSIDE_CHANGE_TYPE})`);
  }
  if ((step.type === OUTSIDE_CHANGE_TYPE) !== (step.by.origin === 'outside')) {
    fail(`${path} is by "outside" exactly when it is a change made outside an action (${OUTSIDE_CHANGE_TYPE})`);
  }
  if (step.kind === 'squashed') {
    if (step.type !== null || step.params !== null || step.code !== null || step.coalesceKey !== null || step.replayOf !== null) {
      fail(`${path} is squashed and records no action of its own (type, params, code, coalesceKey and replayOf null)`);
    }
    checkSquashRules(step.squashed, `${path}.squashed`);
  } else {
    if (step.type === null) fail(`${path} names no action`);
    if (step.params === null) fail(`${path} records an action and its parameters (params)`);
  }
  if (step.kind === 'action' && step.v === null) fail(`${path} records the version of its action's parameters (v)`);
  if (new Set(step.touches).size !== step.touches.length) fail(`${path} lists a touched domain twice`);
  const ordered = DOMAIN_IDS.filter(domain => step.touches.includes(domain));
  if (ordered.some((domain, index) => step.touches[index] !== domain)) fail(`${path} lists its touched domains out of domain order`);
  if (!sameKeys(step.before, step.touches) || !sameKeys(step.after, step.touches)) {
    fail(`${path} must hold a value before and after for exactly the domains it touches`);
  }
}

function checkSquashRules(squash, path) {
  const counted = squash.cause === 'steps' || squash.cause === 'clear';
  if (counted !== (squash.count !== null)) fail(`${path} counts the steps it replaced (count) exactly when they were recorded and shown (steps, clear)`);
  if ((squash.cause === 'share') !== (squash.by.length === 0)) fail(`${path} names who acted (by) exactly unless it is a shared state`);
  checkDistinctBys(squash.by, `${path}.by`);
  const { notes, bookmarks } = squash.carried;
  if (squash.cause !== 'steps' && (notes.length > 0 || bookmarks.length > 0)) {
    fail(`${path} carries notes or bookmarks only for squashed steps (cause steps)`);
  }
  if (new Set(notes).size !== notes.length) fail(`${path}.carried names a note twice`);
  if (new Set(bookmarks.map(nameKey)).size !== bookmarks.length) fail(`${path}.carried names a bookmark twice`);
}

function checkDistinctBys(list, path) {
  list.forEach((by, index) => checkBy(by, `${path}[${index}]`));
  for (let index = 1; index < list.length; index++) {
    if (list.slice(0, index).some(other => sameBy(other, list[index]))) fail(`${path} names one author twice`);
  }
}

function checkPauseRules(pause, path) {
  if (pause.by.length === 0) fail(`${path} names who paused it (by)`);
  checkDistinctBys(pause.by, `${path}.by`);
}

/** How many recorded steps a step stands for: a squashed step its count (one when none was recorded), any other one. */
function stepCount(step) {
  return step.kind === 'squashed' && step.squashed.count !== null ? step.squashed.count : 1;
}

/**
 * A squash's journal entry (op `squash`): what it replaced (`before`) and
 * made (`after`), held to the squash rules. The squashed step takes the id
 * of the range's last step, the one exception to ids never being reused, so
 * a step or a branch after the range keeps its parent; the range is one
 * line of one branch; its count adds up the counts of what it replaced; the
 * notes and bookmarks of the replaced steps are carried; and it stays inside
 * one group (and keeps it) or leaves no group.
 */
function checkSquashEntry(entry, path) {
  // The step it made: squashed (cause steps) here, and not before with the
  // same squash. The range's parent is in the patch too (its children
  // change) and may itself be a squashed step of an earlier squash.
  const was = new Map(entry.before.steps.map(step => [step.id, step]));
  const made = entry.after.steps.filter(step => {
    if (step.kind !== 'squashed' || step.squashed.cause !== 'steps') return false;
    const before = was.get(step.id);
    return before === undefined || before.kind !== 'squashed' || JSON.stringify(before.squashed) !== JSON.stringify(step.squashed);
  });
  if (made.length !== 1) fail(`${path} makes exactly one squashed step (cause steps)`);
  const [squashed] = made;
  const kept = new Set(entry.after.steps.map(step => step.id));
  const replaced = entry.before.steps.filter(step => !kept.has(step.id) || step.id === squashed.id);
  const last = replaced.find(step => step.id === squashed.id);
  if (last === undefined || replaced.some(step => idNumber(step.id) > idNumber(squashed.id))) {
    fail(`${path}: the squashed step takes the id of the last step it replaced`);
  }
  const ordered = [...replaced].sort((a, b) => idNumber(a.id) - idNumber(b.id));
  if (ordered.some((step, index) => step.branch !== squashed.branch || (index > 0 && step.parent !== ordered[index - 1].id))) {
    fail(`${path} replaces consecutive steps of one branch`);
  }
  if (squashed.parent !== ordered[0].parent || squashed.children.join() !== last.children.join()) {
    fail(`${path}: the squashed step keeps the first replaced step's parent and the last one's children`);
  }
  if (squashed.squashed.count !== replaced.reduce((sum, step) => sum + stepCount(step), 0)) {
    fail(`${path}: its count adds up the steps it replaced (a squashed one counts its own)`);
  }
  const notes = replaced.flatMap(step => [...step.notes.map(note => note.id), ...(step.kind === 'squashed' ? step.squashed.carried.notes : [])]);
  const bookmarks = replaced.flatMap(step => [...(step.bookmark === null ? [] : [step.bookmark]), ...(step.kind === 'squashed' ? step.squashed.carried.bookmarks : [])]);
  const own = new Set(squashed.notes.map(note => note.id));
  if (notes.some(note => !own.has(note)) || [...new Set(notes)].sort().join() !== [...squashed.squashed.carried.notes].sort().join()) {
    fail(`${path}: the notes of the steps it replaced are carried by the squashed step`);
  }
  if ([...bookmarks].sort().join('\u0000') !== [...squashed.squashed.carried.bookmarks].sort().join('\u0000')) {
    fail(`${path}: the bookmarks of the steps it replaced are carried by the squashed step`);
  }
  const groups = new Set(replaced.map(step => step.group));
  if (squashed.group !== null && (groups.size !== 1 || !groups.has(squashed.group))) {
    fail(`${path}: a squash inside a group keeps it, and one that covers whole groups leaves none`);
  }
}

function checkGroupRules(group, path) {
  checkBy(group.by, `${path}.by`);
  checkNotes(group.notes, `${path}.notes`);
}

function checkTurnRules(turn, path) {
  checkBy(turn.by, `${path}.by`);
  if (turn.by.origin !== 'agent' && turn.by.origin !== 'host') fail(`${path} is an agent's or a notebook's`);
  if (turn.by.turn !== turn.id) fail(`${path}.by.turn must be the turn's own id`);
  if (turn.startedAt !== null && turn.endedAt !== null && turn.endedAt < turn.startedAt) fail(`${path} ends before it starts`);
  checkNotes(turn.notes, `${path}.notes`);
}

function checkStartRules(start, path) {
  const replay = start.kind === 'replay';
  const linked = replay || start.kind === 'import';
  if (linked !== (start.from !== null)) fail(`${path} names where it comes from (from) exactly for a replay or an import`);
  if (replay !== (start.report !== null)) fail(`${path} keeps a report exactly for a replay`);
  if (!replay && start.mapping !== null) fail(`${path} keeps a name mapping only for a replay`);
  if (start.kind === 'import' && start.from.file === null) fail(`${path} of an import names its file`);
}

function checkPatchRules(patch, path) {
  patch.steps.forEach(step => checkStepRules(step, `${path}.steps[${JSON.stringify(step.id)}]`));
  patch.branches.forEach(branch => {
    checkBy(branch.by, `${path}.branches[${JSON.stringify(branch.id)}].by`);
    checkNotes(branch.notes, `${path}.branches[${JSON.stringify(branch.id)}].notes`);
  });
  patch.groups.forEach(group => checkGroupRules(group, `${path}.groups[${JSON.stringify(group.id)}]`));
  patch.memberships.forEach((membership, index) => {
    if (idNumber(membership.from) > idNumber(membership.to)) fail(`${path}.memberships[${index}] runs from a later step to an earlier one`);
  });
  if (new Set(patch.memberships.map(membership => membership.group)).size !== patch.memberships.length) {
    fail(`${path}.memberships names one group twice`);
  }
  patch.turns.forEach(turn => checkTurnRules(turn, `${path}.turns[${JSON.stringify(turn.id)}]`));
  for (const kind of ['steps', 'branches', 'groups', 'turns']) {
    const ids = patch[kind].map(item => item.id);
    if (new Set(ids).size !== ids.length) fail(`${path}.${kind} holds one record twice`);
  }
}

function checkJournalRules(entry, path) {
  checkBy(entry.by, `${path}.by`);
  if (entry.purged !== (entry.before === null) || entry.purged !== (entry.after === null)) {
    fail(`${path} keeps what it replaced and made (before, after) exactly until it is purged`);
  }
  if (entry.purged) return;
  checkPatchRules(entry.before, `${path}.before`);
  checkPatchRules(entry.after, `${path}.after`);
  if (!sameKeys(entry.before.tracker, Object.keys(entry.after.tracker))) {
    fail(`${path} must replace the same tracker fields it puts back`);
  }
  if (entry.op.startsWith('group.') && (entry.before.steps.length > 0 || entry.after.steps.length > 0)) {
    fail(`${path} records which steps a group held (memberships), never the steps`);
  }
  if (entry.op === 'squash') checkSquashEntry(entry, path);
  if (entry.op === 'load' && (!isEmptyPatch(entry.before) || !isEmptyPatch(entry.after))) {
    fail(`${path} records a tracker loaded beside the others: no change of its own (undoing it removes the tracker)`);
  }
}

function isEmptyPatch(patch) {
  return Object.keys(patch.tracker).length === 0 && ['steps', 'branches', 'groups', 'turns', 'memberships'].every(kind => patch[kind].length === 0);
}

function inIdOrder(items) {
  for (let index = 1; index < items.length; index++) {
    if (idNumber(items[index - 1].id) >= idNumber(items[index].id)) return false;
  }
  return true;
}

function checkUniqueNames(items, kind, label, nameOf, path) {
  const seen = new Map();
  for (const item of items) {
    const name = nameOf(item);
    if (name === null) continue;
    const problem = nameProblem(kind, name);
    if (problem !== null) fail(`${path}: ${plainSentence(problem)}`);
    const key = nameKey(name);
    if (seen.has(key)) fail(`${path}: ${label(seen.get(key))} and ${label(item)} share the name "${name}"`);
    seen.set(key, item);
  }
}

/**
 * A tracker record as this version holds it, and the state domains it held
 * that this version does not have (F164): a history written by another
 * version of Cellucid (a domain since added, renamed or removed). Each
 * step's `touches`, `before`, `after` and `reads` (every journal entry's
 * steps too) and a paused draft keep this version's domains only; a step
 * that changed only such a domain stays, changing nothing here. The record
 * is copied where it changes; a field of a shape the model refuses is left
 * for `validateTracker` to refuse.
 * @param {object} tracker - a tracker record as read
 * @returns {{tracker: object, unknown: string[]}}
 */
export function knownDomainsOnly(tracker) {
  if (!isPlainRecord(tracker)) return { tracker, unknown: [] };
  const unknown = new Set();
  const isUnknown = (key, keep) => typeof key === 'string' && !DOMAIN_IDS.includes(key) && key !== keep;
  const known = (values, keep = null) => (isPlainRecord(values)
    ? Object.fromEntries(Object.entries(values).filter(([key]) => !isUnknown(key, keep)))
    : values);
  const step = record => (isPlainRecord(record) ? {
    ...record,
    touches: Array.isArray(record.touches) ? record.touches.filter(id => !isUnknown(id)) : record.touches,
    before: known(record.before), after: known(record.after), reads: known(record.reads, 'history'),
  } : record);
  const steps = list => (Array.isArray(list) ? list.filter(isPlainRecord) : []);
  const journalSteps = Array.isArray(tracker.journal)
    ? tracker.journal.flatMap(entry => [entry?.before?.steps, entry?.after?.steps].flatMap(steps))
    : [];
  for (const record of [...steps(tracker.steps), ...journalSteps]) {
    for (const id of Array.isArray(record.touches) ? record.touches : []) if (isUnknown(id)) unknown.add(id);
    for (const [values, keep] of [[record.before], [record.after], [record.reads, 'history']]) {
      if (isPlainRecord(values)) for (const key of Object.keys(values)) if (isUnknown(key, keep)) unknown.add(key);
    }
  }
  const draft = isPlainRecord(tracker.paused) ? tracker.paused.draft : null;
  if (isPlainRecord(draft)) for (const key of Object.keys(draft)) if (isUnknown(key)) unknown.add(key);
  if (unknown.size === 0) return { tracker, unknown: [] };
  const side = patch => (isPlainRecord(patch) && Array.isArray(patch.steps) ? { ...patch, steps: patch.steps.map(step) } : patch);
  return {
    tracker: {
      ...tracker,
      steps: Array.isArray(tracker.steps) ? tracker.steps.map(step) : tracker.steps,
      journal: Array.isArray(tracker.journal)
        ? tracker.journal.map(entry => (isPlainRecord(entry) ? { ...entry, before: side(entry.before), after: side(entry.after) } : entry))
        : tracker.journal,
      paused: isPlainRecord(draft) ? { ...tracker.paused, draft: known(draft) } : tracker.paused,
    },
    unknown: [...unknown].sort(),
  };
}

/**
 * Check one tracker whole: every record's shape and rules, and the tree's.
 * @param {object} tracker
 * @param {string} [path]
 * @returns {object} the tracker
 */
export function validateTracker(tracker, path = 'tracker') {
  checkRecord('Tracker', tracker, path);
  return checkTrackerRules(tracker, path);
}

/** A tracker's rules beyond its records' shapes (checked already). */
function checkTrackerRules(tracker, path) {
  const where = `${path} "${tracker.id}"`;
  checkBy(tracker.by, `${path}.by`);
  checkStartRules(tracker.start, `${path}.start`);
  if (tracker.removed !== null) checkBy(tracker.removed.by, `${path}.removed.by`);
  checkNotes(tracker.notes, `${path}.notes`);

  // Steps: a tree rooted at s0, ids above their parents, children that agree.
  const steps = new Map();
  for (const step of tracker.steps) {
    if (steps.has(step.id)) fail(`${where} holds the step "${step.id}" twice`);
    steps.set(step.id, step);
    checkStepRules(step, `${path}.steps[${JSON.stringify(step.id)}]`);
    if (idNumber(step.id) >= tracker.nextStep) fail(`${where}: step "${step.id}" is numbered past nextStep`);
  }
  if (!inIdOrder(tracker.steps)) fail(`${where} lists its steps out of id order`);
  if (tracker.rootId !== ROOT_STEP_ID) fail(`${where}'s root must be ${ROOT_STEP_ID}`);
  const root = steps.get(ROOT_STEP_ID);
  if (root === undefined) fail(`${where} has no root step ${ROOT_STEP_ID}`);
  if (!sameBy(root.by, tracker.by)) fail(`${where}'s root is by whoever started it (tracker.by)`);
  for (const step of tracker.steps) {
    if (step.parent !== null) {
      const parent = steps.get(step.parent);
      if (parent === undefined || !parent.children.includes(step.id)) fail(`${where}: step "${step.id}" and its parent disagree`);
    }
    for (const child of step.children) {
      if (steps.get(child)?.parent !== step.id) fail(`${where}: step "${step.id}" lists a child that is not its own`);
    }
  }

  // Branches: unique names, one holding the root, each a chain from its base to its tip.
  const branches = new Map();
  for (const branch of tracker.branches) {
    if (branches.has(branch.id)) fail(`${where} holds the branch "${branch.id}" twice`);
    branches.set(branch.id, branch);
    checkBy(branch.by, `${path}.branches[${JSON.stringify(branch.id)}].by`);
    checkNotes(branch.notes, `${path}.branches[${JSON.stringify(branch.id)}].notes`);
    if (idNumber(branch.id) >= tracker.nextBranch) fail(`${where}: branch "${branch.id}" is numbered past nextBranch`);
  }
  if (!inIdOrder(tracker.branches)) fail(`${where} lists its branches out of id order`);
  checkUniqueNames(tracker.branches, 'branch', branch => `branch "${branch.id}"`, branch => branch.name, where);
  const ownSteps = new Map([...branches.keys()].map(branchId => [branchId, []]));
  for (const step of tracker.steps) {
    const own = ownSteps.get(step.branch);
    if (own === undefined) fail(`${where}: step "${step.id}" is on the branch "${step.branch}", which it does not hold`);
    own.push(step);
  }
  const rootBranches = tracker.branches.filter(branch => branch.base === null);
  if (rootBranches.length !== 1) fail(`${where} must have exactly one branch without a fork step (the one holding the root)`);
  if (root.branch !== rootBranches[0].id) fail(`${where}: the root must be on the branch without a fork step`);
  for (const branch of tracker.branches) {
    const label = `${where}: branch "${branch.id}"`;
    const own = ownSteps.get(branch.id);
    if (own.length === 0) fail(`${label} has no step of its own`);
    if (branch.base !== null) {
      const base = steps.get(branch.base);
      if (base === undefined) fail(`${label} forks from a step the tracker does not hold`);
      if (base.branch === branch.id) fail(`${label} forks from one of its own steps`);
    }
    const firsts = own.filter(step => step.parent === null || steps.get(step.parent).branch !== branch.id);
    if (firsts.length !== 1 || firsts[0].parent !== branch.base) {
      fail(`${label}'s steps must form one line starting right after its fork step`);
    }
    let count = 1;
    let step = firsts[0];
    for (;;) {
      const next = step.children.filter(child => steps.get(child).branch === branch.id);
      if (next.length > 1) fail(`${label} splits at step "${step.id}"; a branch is one line`);
      if (next.length === 0) break;
      step = steps.get(next[0]);
      count++;
    }
    if (count !== own.length) fail(`${label}'s steps must form one line starting right after its fork step`);
    if (step.id !== branch.tip) fail(`${label}'s tip must be its last step ("${step.id}")`);
  }

  // Head, active and main branches.
  const head = steps.get(tracker.headId);
  if (head === undefined) fail(`${where}'s head is not one of its steps`);
  const active = branches.get(tracker.activeBranch);
  if (active === undefined) fail(`${where}'s active branch is not one of its branches`);
  let onPath = false;
  for (let step = steps.get(active.tip); step !== undefined; step = step.parent === null ? undefined : steps.get(step.parent)) {
    if (step.id === head.id) { onPath = true; break; }
  }
  if (!onPath) fail(`${where}'s head must be on its active branch's path`);
  if (active.archived && head.branch !== active.id) fail(`${where}'s active branch is archived, so the head must be on it`);
  const main = branches.get(tracker.mainBranch);
  if (main === undefined) fail(`${where}'s main branch is not one of its branches`);
  if (main.archived) fail(`${where}'s main branch cannot be archived`);
  if (tracker.paused !== null) checkPauseRules(tracker.paused, `${path}.paused`);

  // Groups: unique names; each a run of consecutive steps of one branch, holding whole turns.
  const groups = new Map();
  for (const group of tracker.groups) {
    if (groups.has(group.id)) fail(`${where} holds the group "${group.id}" twice`);
    groups.set(group.id, []);
    checkGroupRules(group, `${path}.groups[${JSON.stringify(group.id)}]`);
    if (idNumber(group.id) >= tracker.nextGroup) fail(`${where}: group "${group.id}" is numbered past nextGroup`);
  }
  if (!inIdOrder(tracker.groups)) fail(`${where} lists its groups out of id order`);
  checkUniqueNames(tracker.groups, 'group', group => `group "${group.id}"`, group => group.name, where);
  for (const step of tracker.steps) {
    if (step.group === null) continue;
    const members = groups.get(step.group);
    if (members === undefined) fail(`${where}: step "${step.id}" is in the group "${step.group}", which it does not hold`);
    members.push(step);
  }
  for (const [groupId, members] of groups) {
    if (members.length === 0) fail(`${where}: group "${groupId}" has no step`);
    // Steps are in id order, and along one branch a child's id is above its parent's.
    for (let index = 1; index < members.length; index++) {
      if (members[index].branch !== members[0].branch || members[index].parent !== members[index - 1].id) {
        fail(`${where}: group "${groupId}"'s steps must be consecutive steps of one branch`);
      }
    }
  }
  // A group never cuts a run of one turn's consecutive steps on its branch: a
  // grouped step's neighbor on the line (its parent, its child on the same
  // branch) of the same turn is in the same group. A turn that acts again
  // after someone else's step starts a new run, which the group need not hold.
  for (const step of tracker.steps) {
    if (step.by.turn === null) continue;
    const parent = step.parent === null ? undefined : steps.get(step.parent);
    if (parent !== undefined && parent.branch === step.branch && parent.by.turn === step.by.turn && parent.group !== step.group) {
      fail(`${where}: a group cuts the run of turn "${step.by.turn}" between steps "${parent.id}" and "${step.id}"; a group holds whole runs of a turn`);
    }
  }

  // Bookmarks, notes, turns.
  const bookmarked = tracker.steps.flatMap(step => [
    ...(step.bookmark === null ? [] : [{ id: step.id, name: step.bookmark }]),
    ...(step.kind === 'squashed' ? step.squashed.carried.bookmarks.map(name => ({ id: step.id, name })) : []),
  ]);
  checkUniqueNames(bookmarked, 'bookmark', item => `step "${item.id}"`, item => item.name, where);
  for (const step of tracker.steps) {
    if (step.kind !== 'squashed') continue;
    const own = new Set(step.notes.map(note => note.id));
    if (step.squashed.carried.notes.some(note => !own.has(note))) fail(`${where}: step "${step.id}" carries a note it does not hold`);
  }
  const noteIds = new Set();
  const notesOf = [
    tracker.notes, ...tracker.branches.map(b => b.notes), ...tracker.groups.map(g => g.notes), ...tracker.steps.map(s => s.notes),
    ...tracker.turns.map(t => t.notes),
  ];
  for (const note of notesOf.flat()) {
    if (noteIds.has(note.id)) fail(`${where} holds the note "${note.id}" twice`);
    noteIds.add(note.id);
    if (idNumber(note.id) >= tracker.nextNote) fail(`${where}: note "${note.id}" is numbered past nextNote`);
  }
  const turns = new Map();
  for (const turn of tracker.turns) {
    if (turns.has(turn.id)) fail(`${where} holds the turn "${turn.id}" twice`);
    turns.set(turn.id, turn);
    checkTurnRules(turn, `${path}.turns[${JSON.stringify(turn.id)}]`);
    if (!branches.has(turn.branch)) fail(`${where}: turn "${turn.id}" acts on a branch the tracker does not hold`);
  }
  const turnSteps = new Set();
  for (const step of tracker.steps) {
    if (step.by.turn === null) continue;
    if (!turns.has(step.by.turn)) fail(`${where}: step "${step.id}" belongs to the turn "${step.by.turn}", which it does not hold`);
    turnSteps.add(step.by.turn);
  }
  for (const turn of tracker.turns) {
    if (!turnSteps.has(turn.id) && turn.outside.length === 0) fail(`${where}: turn "${turn.id}" has no step and did nothing outside the state`);
  }

  // Journal.
  const journalIds = new Set();
  tracker.journal.forEach(entry => {
    if (journalIds.has(entry.id)) fail(`${where} holds the journal entry "${entry.id}" twice`);
    journalIds.add(entry.id);
    if (idNumber(entry.id) >= tracker.nextJournal) fail(`${where}: journal entry "${entry.id}" is numbered past nextJournal`);
    checkJournalRules(entry, `${path}.journal[${JSON.stringify(entry.id)}]`);
  });
  if (!inIdOrder(tracker.journal)) fail(`${where} lists its journal out of id order`);
  if (tracker.removed !== null && !tracker.journal.some(entry => entry.op === 'tracker.remove' && !entry.purged)) {
    fail(`${where} is removed, so its journal must keep the removal (to restore it)`);
  }
  return tracker;
}

/**
 * The trackers together: each one's rules (`rules`: false when each was
 * checked whole already), distinct ids and names, and the active one held
 * and not removed. `others`: the ids of trackers left out as unreadable
 * (`validateSession`'s `unreadable`), which count as held: the active one
 * may be one of them.
 */
function checkTrackers(trackers, activeTracker, path, { rules = true, others = [] } = {}) {
  const ids = new Set(others);
  trackers.forEach(tracker => {
    if (rules) checkTrackerRules(tracker, 'tracker');
    if (ids.has(tracker.id)) fail(`${path} holds the tracker "${tracker.id}" twice`);
    ids.add(tracker.id);
  });
  checkUniqueNames(
    trackers.filter(tracker => tracker.removed === null), 'tracker', tracker => `tracker "${tracker.id}"`,
    tracker => tracker.name, path,
  );
  if (others.includes(activeTracker)) return;
  const active = trackers.find(tracker => tracker.id === activeTracker);
  if (active === undefined) fail(`${path}'s active tracker is not one of its trackers`);
  if (active.removed !== null) fail(`${path}'s active tracker cannot be removed`);
}

/**
 * Check a history whole (`history.snapshot()`'s form, the autosave's).
 * @param {object} history
 */
export function validateHistory(history) {
  checkRecord('History', history, 'history');
  checkTrackers(history.trackers, history.activeTracker, 'history');
  return history;
}

/**
 * Check a session file as read: its header records and every tracker, and
 * that its scope names exactly the trackers it holds.
 *
 * `unreadable` (a reader's list, F164): given, a tracker whose own records
 * or rules this version refuses (`validateTracker`: one another version of
 * the model wrote) is listed `{id, name, error}` (its id and name as read,
 * null when not text) and left out of the checks that span trackers, which
 * the others still pass: the reader restores the others (`history.js`
 * `readSaved` says which was left out). The header, and how the trackers
 * agree with each other and with the scope, are checked whole. Not given
 * (a writer), one tracker refused refuses the session.
 * @param {object} session
 * @param {{unreadable?: Array<{id: string|null, name: string|null, error: HistoryModelError}>|null}} [options]
 */
export function validateSession(session, { unreadable = null } = {}) {
  let trackers = session?.trackers;
  if (unreadable === null) {
    checkRecord('Session', session, 'session');
    checkTrackers(trackers, session.activeTracker, 'session');
  } else {
    if (!Array.isArray(trackers)) fail('session.trackers must be a list');
    checkRecord('Session', { ...session, trackers: [] }, 'session');
    const textOrNull = value => (typeof value === 'string' ? value : null);
    trackers = trackers.filter((tracker, index) => {
      try {
        validateTracker(tracker, `session.trackers[${index}]`);
        return true;
      } catch (error) {
        if (!(error instanceof HistoryModelError)) throw error;
        unreadable.push({ id: textOrNull(tracker?.id), name: textOrNull(tracker?.name), error });
        return false;
      }
    });
    checkTrackers(trackers, session.activeTracker, 'session', { rules: false, others: unreadable.map(each => each.id) });
  }
  const held = session.trackers.map(tracker => tracker?.id);
  if (JSON.stringify(session.scope.trackers) !== JSON.stringify(held)) fail('session.scope must name exactly the trackers it holds, in order');
  const left = new Set((unreadable ?? []).map(each => each.id));
  for (const entry of session.scope.branches) {
    if (left.has(entry.tracker)) continue;
    const tracker = trackers.find(candidate => candidate.id === entry.tracker);
    if (tracker === undefined) fail(`session.scope names branches of a tracker it does not hold ("${entry.tracker}")`);
    const known = new Set(tracker.branches.map(branch => branch.id));
    if (entry.branches.some(branch => !known.has(branch))) fail(`session.scope names a branch the tracker "${entry.tracker}" does not hold`);
  }
  const stamps = session.actions.map(stamp => [stamp.type, stamp.version]);
  if (stamps.some(([type, version], index) => index > 0 && (stamps[index - 1][0] > type
    || (stamps[index - 1][0] === type && stamps[index - 1][1] >= version)))) {
    fail('session.actions must be sorted by type then version, each pair once');
  }
  const used = new Set();
  for (const tracker of trackers) {
    const steps = [...tracker.steps, ...tracker.journal.flatMap(entry => (entry.purged ? [] : [...entry.before.steps, ...entry.after.steps]))];
    for (const step of steps) if (step.kind === 'action') used.add(`${step.type}@${step.v}`);
    if (tracker.paused !== null && tracker.paused.draft !== null) {
      fail(`session: tracker "${tracker.id}" keeps a paused draft; a file squashes it into a step first`);
    }
  }
  const stamped = stamps.map(([type, version]) => `${type}@${version}`);
  // With a tracker left out, the actions its steps use are not known: the others' must be stamped.
  if ([...used].some(stamp => !stamped.includes(stamp)) || (left.size === 0 && stamped.length !== used.size)) {
    fail('session.actions must stamp exactly each action and version its steps use');
  }
  checkScopeHolds(session.scope, trackers);
  return session;
}

/** What the share chose is what the file holds (`Scope`). */
function checkScopeHolds(scope, trackers) {
  if (scope.content === 'steps' && scope.results !== 'recompute') fail('session.scope of steps only holds no results (results is recompute)');
  for (const tracker of trackers) {
    const where = `session: tracker "${tracker.id}"`;
    if (!scope.chats && tracker.chats.length > 0) fail(`${where} holds conversations its scope leaves out (chats)`);
    if (!scope.journal && tracker.journal.length > 0) fail(`${where} holds Recently deleted, which its scope leaves out (journal)`);
    if (!scope.notes) {
      const noted = [tracker, ...tracker.branches, ...tracker.groups, ...tracker.steps, ...tracker.turns].some(item => item.notes.length > 0);
      if (noted || tracker.steps.some(step => step.bookmark !== null)) fail(`${where} holds notes or bookmarks its scope leaves out (notes)`);
    }
  }
  if (scope.content !== 'state') return;
  const [tracker] = trackers;
  if (trackers.length !== 1 || tracker.branches.length !== 1) fail('session.scope of a state holds one tracker of one branch');
  const [root, state] = tracker.steps;
  if (tracker.steps.length !== 2 || state.kind !== 'squashed' || state.squashed.cause !== 'share' || tracker.headId !== state.id) {
    fail('session.scope of a state holds the root and one squashed step (cause share), shown');
  }
  if (tracker.turns.length > 0 || tracker.groups.length > 0 || tracker.notes.length > 0 || root.notes.length > 0 || state.notes.length > 0
    || tracker.journal.length > 0 || tracker.chats.length > 0) {
    fail('session.scope of a state holds no turn, group, note, journal or conversation');
  }
  // Privacy: a state shared without its history names nobody (no agent, model, notebook, person or turn).
  const anonymous = by => by.agent === null && by.model === null && by.host === null && by.person === null && by.turn === null
    && (by.origin === 'user' || by.origin === 'startup');
  if (![tracker.by, root.by, state.by, ...(tracker.paused === null ? [] : tracker.paused.by)].every(anonymous)) {
    fail('session.scope of a state names nobody: every by is the person or the opening, with no agent, model, notebook, name or turn');
  }
}

/**
 * Check one record of the model by its name (`HISTORY_RECORDS`), with its
 * own rules where it has them (a step's, a turn's, a note's, a journal
 * entry's; a tracker's whole tree with `validateTracker`).
 * @param {string} name
 * @param {unknown} value
 * @param {string} [path]
 */
export function validateRecord(name, value, path = lowerFirst(name)) {
  if (!Object.hasOwn(RECORDS, name)) fail(`There is no history record "${name}"`);
  if (name === 'Tracker') return validateTracker(value, path);
  if (name === 'History') return validateHistory(value);
  if (name === 'Session') return validateSession(value);
  checkRecord(name, value, path);
  switch (name) {
    case 'By': checkBy(value, path); break;
    case 'Note': checkNote(value, path); break;
    case 'Step': checkStepRules(value, path); break;
    case 'Turn': checkTurnRules(value, path); break;
    case 'Branch': checkBy(value.by, `${path}.by`); checkNotes(value.notes, `${path}.notes`); break;
    case 'Group': checkGroupRules(value, path); break;
    case 'Squash': checkSquashRules(value, path); break;
    case 'Pause': checkPauseRules(value, path); break;
    case 'Start': checkStartRules(value, path); break;
    case 'Patch': checkPatchRules(value, path); break;
    case 'JournalEntry': checkJournalRules(value, path); break;
    default: break;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Constructors: exact records, checked.

/**
 * @param {{origin: string, agent?: string|null, model?: string|null, host?: string|null,
 *   person?: string|null, turn?: string|null}} fields
 */
export function createBy({ origin, agent = null, model = null, host = null, person = null, turn = null }) {
  return validateRecord('By', { origin, agent, model, host, person, turn });
}

/** @param {{id: string, text: string, by: object, at: number|null, fromReply?: boolean}} fields */
export function createNote({ id: noteId, text, by, at, fromReply = false }) {
  return validateRecord('Note', { id: noteId, text, by, at, editedAt: null, fromReply });
}

/**
 * @param {{id: string, name: string, base: string|null, tip: string, createdAt: number|null, by: object,
 *   lane?: number, locked?: boolean, archived?: boolean}} fields
 */
export function createBranch({ id: branchId, name, base, tip, createdAt, by, lane = laneOf(branchId), locked = false, archived = false }) {
  return validateRecord('Branch', { id: branchId, name, base, tip, createdAt, by, lane, locked, archived, notes: [] });
}

/**
 * A step as recorded (not the root): `status` applied, no reason or bookmark
 * yet, no children. An `action` names its type, parameters and their version
 * `v`; an `outside` change its type (`OUTSIDE_CHANGE_TYPE`) and parameters; a
 * `squashed` step none of them, and what it stands for (`squashed`, a
 * `Squash`), with the notes it carries (`notes`).
 *
 * A squash of consecutive steps (cause `steps`) gives the squashed step the
 * id of the range's last step: the one exception to ids never being reused,
 * so a step or a branch after the range keeps its parent and no other branch
 * is rewritten (`checkSquashEntry` holds its journal entry to it).
 *
 * @param {{id: string, parent: string, branch: string, kind?: string, type?: string|null, params?: object|null,
 *   v?: number|null, code?: string|null, label: string, by: object, at: number|null, until?: number|null,
 *   merged?: number, ms?: number|null, touches: string[], before: object, after: object, reads?: object,
 *   outcome?: object|null, coalesceKey?: string|null, replayOf?: object|null, squashed?: object|null,
 *   group?: string|null}} fields
 */
export function createStep({
  id: stepId, parent, branch, kind = 'action', type = null, params = null, v = null, code = null, label, by, at,
  until = at, merged = 1, ms = null, touches, before, after, reads = {}, outcome = null, coalesceKey = null,
  replayOf = null, squashed = null, group = null, notes = [],
}) {
  if (parent === null) fail('A step made by an action has a parent; createTracker makes the root');
  return validateRecord('Step', {
    id: stepId, parent, children: [], branch, kind, type, params, v, code, label, by, at, until, merged, ms,
    touches: [...touches], before: { ...before }, after: { ...after }, reads: { ...reads },
    status: 'applied', reason: null, outcome, coalesceKey, replayOf,
    squashed: squashed === null ? null : {
      ...squashed, by: [...squashed.by], carried: { notes: [...squashed.carried.notes], bookmarks: [...squashed.carried.bookmarks] },
    },
    notes: [...notes], bookmark: null, group,
  });
}

/** @param {{id: string, name: string, createdAt: number|null, by: object}} fields */
export function createGroup({ id: groupId, name, createdAt, by }) {
  return validateRecord('Group', { id: groupId, name, createdAt, by, notes: [] });
}

/**
 * @param {{id: string, by: object, label: string, conversation?: string|null, message?: string|null,
 *   startedAt: number|null, branch: string}} fields
 */
export function createTurn({ id: turnId, by, label, conversation = null, message = null, startedAt, branch }) {
  return validateRecord('Turn', { id: turnId, by, label, conversation, message, startedAt, endedAt: startedAt, branch, notes: [], outside: [] });
}

/** @param {{type: string, label: string, at: number|null}} fields */
export function createOutsideAct({ type, label, at }) {
  return validateRecord('OutsideAct', { type, label, at });
}

/** @param {{id: string, op: string, at: number|null, by: object, label: string, before: object, after: object}} fields */
export function createJournalEntry({ id: entryId, op, at, by, label, before, after }) {
  return validateRecord('JournalEntry', { id: entryId, op, at, by, label, before, after, purged: false });
}

/** An empty patch: what an edit that replaced nothing of a kind holds for it. */
export function emptyPatch() {
  return { steps: [], branches: [], groups: [], memberships: [], turns: [], tracker: {} };
}

/**
 * A new tracker: its root `s0` (holding `rootValues`, every domain's value
 * hash) on its first branch `b0` "Main", shown, active and main; recording
 * unless `recording` is false (Settings › History › Record history for new
 * datasets), paused then since it started.
 *
 * @param {{id: string, name: string, dataset: object, createdAt: number|null, by: object,
 *   start?: object, rootValues: Record<string, string>, recording?: boolean}} fields - `recording` false:
 *   started paused, by whoever started it
 */
export function createTracker({
  id: trackerId, name, dataset, createdAt, by,
  start = { kind: 'opened', from: null, report: null, mapping: null }, rootValues, recording = true,
}) {
  const root = {
    id: ROOT_STEP_ID, parent: null, children: [], branch: FIRST_BRANCH_ID, kind: 'root', type: null, params: null, v: null,
    code: null, label: ROOT_LABELS[start?.kind] ?? ROOT_LABELS.opened, by, at: createdAt, until: createdAt, merged: 1, ms: null,
    touches: [], before: {}, after: { ...rootValues }, reads: {}, status: 'applied', reason: null, outcome: null,
    coalesceKey: null, replayOf: null, squashed: null, notes: [], bookmark: null, group: null,
  };
  const branch = {
    id: FIRST_BRANCH_ID, name: FIRST_BRANCH_NAME, base: null, tip: ROOT_STEP_ID, createdAt, by,
    lane: laneOf(FIRST_BRANCH_ID), locked: false, archived: false, notes: [],
  };
  return validateTracker({
    id: trackerId, name, dataset, createdAt, by, start, removed: null, rootId: ROOT_STEP_ID, headId: ROOT_STEP_ID,
    activeBranch: FIRST_BRANCH_ID, mainBranch: FIRST_BRANCH_ID, paused: recording ? null : { at: createdAt, by: [by], draft: null },
    branches: [branch], groups: [], steps: [root], turns: [], notes: [], journal: [], chats: [],
    nextStep: 1, nextBranch: 1, nextGroup: 0, nextNote: 0, nextJournal: 0,
  });
}

// ---------------------------------------------------------------------------
// The language-neutral description (history_model.schema.json).

function specSchema(spec) {
  let schema;
  switch (spec.type) {
    case 'text': schema = { type: 'string', minLength: 1 }; break;
    case 'string': schema = spec.pattern ? { type: 'string', pattern: spec.pattern.source } : { type: 'string' }; break;
    case 'name': schema = { type: 'string', minLength: 1, 'x-name': true }; break;
    case 'time': schema = { type: ['number', 'null'], 'x-time': 'ms-since-1970-utc' }; break;
    case 'boolean': schema = { type: 'boolean' }; break;
    case 'hash': schema = { type: 'string', pattern: VALUE_HASH_PATTERN.source }; break;
    case 'id': schema = { type: 'string', pattern: HISTORY_ID_PATTERNS[spec.kind].source, 'x-id': spec.kind }; break;
    case 'integer':
      schema = { type: 'integer', minimum: spec.minimum, ...(spec.maximum === null ? {} : { maximum: spec.maximum }) };
      break;
    case 'number': schema = { type: 'number', minimum: spec.minimum }; break;
    case 'enum': schema = { enum: [...spec.values] }; break;
    case 'array': schema = { type: 'array', items: specSchema(spec.item) }; break;
    case 'pair': schema = { type: 'array', prefixItems: spec.items.map(specSchema), minItems: 2, maxItems: 2, items: false }; break;
    case 'record': schema = { $ref: `#/$defs/${spec.name}` }; break;
    case 'object': schema = { type: 'object' }; break;
    case 'json': schema = {}; break;
    default: fail(`Unknown spec ${spec.type}`);
  }
  if (spec.nullable && spec.type !== 'time') {
    if (schema.$ref !== undefined) schema = { anyOf: [schema, { type: 'null' }] };
    else if (schema.enum !== undefined) schema = { enum: [...schema.enum, null] };
    else schema = { ...schema, type: [schema.type, 'null'] };
  }
  if (spec.description !== undefined) schema.description = spec.description;
  return schema;
}

/** The rules each record keeps beyond its fields' types, as the validators check them. */
const INVARIANTS = Object.freeze({
  By: [
    'agent is set exactly when origin is "agent"; model only for an agent.',
    'host is set exactly when origin is "host".',
    'turn is set only for an agent or a host.',
  ],
  Note: ['fromReply only for a note by an agent.'],
  Squash: [
    'count is set exactly for steps and clear (the steps it replaced); paused and share leave it null.',
    'by names each author once, in the order they first acted; it is empty exactly for share.',
    'carried is empty but for cause steps.',
  ],
  Pause: ['by is not empty and names each author once.'],
  Patch: ['memberships run from an earlier step to a later one, one per group.'],
  JournalEntry: [
    'before and after are set exactly until it is purged, and replace the same tracker fields.',
    'A group edit (group.*) records memberships, never steps.',
    'A load (a tracker loaded beside the others from a file) records no change of its own: both patches are empty; undoing it removes the tracker to Recently deleted.',
    'A squash makes one squashed step (cause steps) with the id of the last step it replaced (the one exception to ids never being reused), the first one\'s parent and the last one\'s children; the replaced steps are consecutive steps of one branch; its count adds up theirs (a squashed one counts its own); it carries their notes and bookmarks; it keeps a group only when every replaced step was in it.',
  ],
  Step: [
    'kind is root exactly for the root, s0: no parent, no action (type, params, v, code null; touches, before, reads empty; merged 1; ms null; status applied; no group).',
    'Every other step\'s id is greater than its parent\'s.',
    'An action names its type, its parameters and their version (v); an outside change its type (history.outside-change) and parameters; a squashed step none of them (type, params, v, code, coalesceKey, replayOf null) and says what it stands for (squashed).',
    'squashed is set exactly for kind squashed; v only for kind action.',
    'touches are distinct, in domain order, and before and after hold exactly those domains.',
    'unapplicable steps say why (reason).',
    'until is not before at.',
    'kind is outside exactly when type is history.outside-change, and exactly when by.origin is "outside".',
  ],
  Turn: ['by.origin is agent or host, and by.turn is the turn\'s id.', 'Every turn has at least one step of its tracker.'],
  Start: [
    'from is set exactly for replay and import; report exactly for replay; mapping only for replay.',
    'An import names its file (from.file).',
  ],
  Tracker: [
    'Steps, branches and the journal are listed in id order; every id is below its counter (nextStep, …).',
    'One root (s0); every step is its parent\'s child and every child its step\'s.',
    'Exactly one branch has no fork step (base null); it holds the root.',
    'The steps of a branch form one line, from the child of its base to its tip, with no other step.',
    'A branch does not fork from its own step.',
    'Branch and group names are unique by key, and none has the form of an id of its kind; bookmarks are unique by key.',
    'Every group has at least one step; its steps (those naming it) are consecutive steps of one branch.',
    'A group never cuts a run of one turn\'s consecutive steps on its branch: a step and its parent on the same branch, of the same turn, are in the same group (or both in none). A turn acting again after someone else\'s step starts a new run.',
    'A paused tracker names who paused it, then who acted while paused, each once.',
    'Bookmarks are unique by key across steps and the bookmarks squashed steps carry; a squashed step holds the notes it carries.',
    'The head is on the path of the active branch\'s tip; an archived active branch holds the head.',
    'The main branch is not archived.',
    'Note ids are unique across the tracker (its notes, branches, groups, steps and turns).',
    'Every step\'s turn is one of its turns; the root is by whoever started the tracker.',
    'A removed tracker keeps its removal (an unpurged tracker.remove entry) in its journal.',
  ],
  History: [
    'Tracker ids are unique; names of trackers not removed are unique by key and none has the form of a tracker id.',
    'The active tracker is one of them and is not removed.',
  ],
  Session: [
    'scope.trackers names exactly its trackers, in order; scope.branches only theirs.',
    'actions stamp exactly each action type and version its steps use (journal included), sorted by type then version.',
    'No tracker keeps a paused draft (a file squashes it first).',
    'What scope leaves out is not held: no conversation without chats, no journal without journal, no note or bookmark without notes.',
    'scope.content steps has results recompute.',
    'scope.content state holds one tracker of one branch: the root and one squashed step (cause share), shown, with no turn, group, note, journal or conversation, and names nobody (every by the person or the opening).',
  ],
});

/**
 * The model as a JSON Schema (draft 2020-12) document: one `$defs` entry per
 * record, plus what the types cannot say (`x-…`): id forms, the name rule,
 * the enumerations, and every record's rules. Byte-stable for a given model.
 */
export function historyModelDocument() {
  const defs = {};
  for (const [name, { description, fields }] of Object.entries(RECORDS)) {
    defs[name] = {
      type: 'object',
      additionalProperties: false,
      required: Object.entries(fields).filter(([, spec]) => !spec.optional).map(([key]) => key),
      properties: Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, specSchema(spec)])),
      description,
      ...(INVARIANTS[name] ? { 'x-invariants': [...INVARIANTS[name]] } : {}),
    };
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Cellucid history model',
    description: 'The records of a Cellucid history (app/history/model.js): what a session file and a saved state hold, and what Python and R read.',
    version: HISTORY_MODEL_VERSION,
    $defs: defs,
    'x-ids': Object.fromEntries(Object.entries(HISTORY_ID_PATTERNS).map(([kind, pattern]) => [kind, pattern.source])),
    'x-constants': {
      rootStep: ROOT_STEP_ID,
      firstBranch: FIRST_BRANCH_ID,
      firstBranchName: FIRST_BRANCH_NAME,
      laneCount: HISTORY_LANE_COUNT,
      outsideChangeType: OUTSIDE_CHANGE_TYPE,
      freshStartBranchName: FRESH_START_BRANCH_NAME,
      rootLabels: { ...ROOT_LABELS },
    },
    'x-names': {
      whiteSpace: NAME_WHITE_SPACE.map(code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`),
      stored: 'NFC; white space (whiteSpace) trimmed from both ends; each inner run of it one U+0020.',
      key: 'The stored form lower-cased with the Unicode default full case mapping (JavaScript toLowerCase, Python str.lower), then NFC.',
      refused: 'Empty; holding a control character (U+0000-U+001F, U+007F-U+009F); for a branch, a group or a tracker, a key of the form of its id.',
    },
    'x-domains': [...DOMAIN_IDS],
    'x-readInputs': [...ACTION_READ_INPUTS],
    'x-journalOps': [...JOURNAL_OPS],
    'x-trackerPatchFields': [...TRACKER_PATCH_FIELDS],
  };
}
