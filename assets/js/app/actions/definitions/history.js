/**
 * @fileoverview The history's own actions: everything a person, an agent, a
 * Python or R host does to the history itself, one path for all of them.
 *
 * - **Reads** (effect `read`): `history.get`, `history.summary`,
 *   `history.step`, `history.diff`, `history.stale`, `history.search`,
 *   `history.methods`, `history.pseudocode`, `history.saved.list`.
 * - **Deleting a saved state of this browser** (`history.saved.delete`,
 *   effect `outside`, asked of an agent as `deletes-saved`): nothing in the
 *   history shown changes, and nothing brings it back.
 * - **Moves** (effect `history`, nothing to undo but the move itself):
 *   undo, redo, a jump, switching branch, using another tracker, starting a
 *   branch from a step (`history.branch.create`, which names the branch the
 *   next step starts) and cancelling it; the recording switch
 *   (`history.recording.pause`: changes apply without a step, asked of an
 *   agent as `pauses-recording`; `history.recording.resume`: one squashed
 *   step holds what differs, never asked).
 * - **Edits** (effect `history`, kept in the tracker's journal, undoable from
 *   Recently deleted): renaming, archiving, making main and locking a
 *   branch; notes and bookmarks; groups (a named folder over consecutive
 *   steps: made, renamed, extended, removed); squashing consecutive steps
 *   into one (`history.squash`) and clearing the history while keeping the
 *   state (`history.clear`); deleting a step or a branch; renaming and
 *   removing a tracker; undoing a turn's own steps; a restore itself
 *   (`app/history/model.js` `JOURNAL_OPS`: each op is its action's type
 *   without `history.`).
 * - **Writing it out** (effect `outside`, nothing recorded): a session file
 *   to share (`history.share`, asked as `writes-file`) and a named saved
 *   state of this browser (`history.save`), each as the history, the current
 *   state only, or the steps only (`content`), with analysis results kept or
 *   left to compute again (`results`); a new AnnData file of the dataset
 *   with the state shown applied (`history.anndata.save`, asked as
 *   `writes-file`; the apply plan Python and R follow); and the printable
 *   report of the branch shown (`history.report`: as a file, asked as
 *   `writes-file` by its implementation once it writes one, or as its
 *   text). The State panel opens the report in a window of its own, which a
 *   browser lets only a click open, so an agent gets the same document as
 *   an `.html` file downloaded, or as text.
 * - **The guided tour** (`history.tour.start`, `history.tour.stop`, effect
 *   `history`: each step is shown by a jump, and Stop returns to the step
 *   shown before): the panel's Tour, started and stopped.
 * - **Work that makes steps** (effect `history`): replaying a saved state,
 *   branching without a step, applying a branch's steps here, verifying a
 *   branch, and starting another tracker. Their steps are recorded as any
 *   other (origin `replay`); what they cost is told to the agent's
 *   permissions by their estimate (`provideEstimate`), not by `confirm`.
 * - **Revert** (`history.step.revert`, effect `state`): a step like any other,
 *   whose after-values are the reverted step's before-values.
 *
 * `confirm` (`deletes-saved`) asks the person before an agent's delete of a
 * step, a branch or a tracker, a squash, a clear, an emptying of Recently
 * deleted, or a saved state of this browser; `writes-file` before it writes a session file or an AnnData copy; a host's call is
 * its person's own code, and the panel asks with its own dialog. Every other
 * history action of an agent is asked as a `change`, but pausing the
 * recording, asked as `pauses-recording` (while paused, an agent's change
 * cannot be undone on its own).
 *
 * The history provides them (`app/history/history.js`), but for those that
 * write it down or read it out, which its persistence provides
 * (`app/history/persistence-actions.js`: the methods, the pseudocode, the
 * saved states listed and deleted, Share and Save in this browser; and
 * `app/history/anndata-copy-save.js`: the AnnData copy), and the tour and the
 * report, which the State panel provides (`ui/modules/state/index.js`,
 * through `tour.js` and `share.js`).
 *
 * Branches, groups and trackers are named by name or by id (`b3`, `g1`,
 * `t-…`), which cannot be confused (`app/history/model.js` `nameProblem`);
 * steps by id (`s12`), notes `n4`, journal entries `j2`, turns by their id.
 *
 * @module app/actions/definitions/history
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { DOMAIN_IDS } from '../domains.js';
import {
  APPLY_ROW_KINDS, APPLY_ROW_STATUSES, BY_ORIGINS, HISTORY_HOSTS, HISTORY_ID_PATTERNS, REPLAY_MISSING_KINDS, REPLAY_OUTCOMES, SHARE_CONTENTS, SHARE_RESULTS, SHARE_SOURCES,
  SHARE_TIMES, SQUASH_CAUSES, STEP_KINDS, STEP_STATUSES, TRACKER_START_KINDS,
} from '../../history/model.js';
import { RESULT_TEXT_CHARS } from '../../agent/bridge/relay-protocol.js';

const GROUP = 'History';

/**
 * The steps one page of `history.get` holds when the caller names no
 * `limit`: a step is about 340 characters there (the stress suite measured
 * 293 before `kind`, `v`, `group` and `squash`), so 200 steps are about
 * 68,000 characters, well under what a connector's tool result carries
 * (`RESULT_TEXT_CHARS`). Not a cap: any `limit` is answered.
 */
export const HISTORY_PAGE_STEPS = 200;
if (HISTORY_PAGE_STEPS * 340 > RESULT_TEXT_CHARS / 2) throw new Error('A page of history_get must stay well under a tool result');

const NO_PARAMS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });

function pattern(kind, example, description) {
  return Object.freeze({ type: 'string', pattern: HISTORY_ID_PATTERNS[kind].source, examples: [example], description });
}

/** A step of the tracker in use, by its id (`history.get` lists them). */
const STEP_ID = pattern('step', 's3', 'A step of the tracker in use, by its id (history_get lists the steps).');
/** A step of a tracker named beside it. */
const ANY_STEP_ID = pattern('step', 's3', 'A step, by its id (history_get lists the steps).');
const NOTE_ID = pattern('note', 'n0', 'A note, by its id (history_step and history_summary list them).');
const JOURNAL_ID = pattern('journal', 'j0', 'An entry of Recently deleted, by its id (history_summary counts them).');
const TRACKER = Object.freeze({
  type: 'string', minLength: 1, examples: ['Tracker 1'],
  description: 'A tracker by its name or its id (history_summary lists them); the tracker in use when left out.',
});
const TRACKER_REQUIRED = Object.freeze({ ...TRACKER, description: 'A tracker by its name or its id (history_summary lists them).' });
const BRANCH = Object.freeze({
  type: 'string', minLength: 1, examples: ['Main'],
  description: 'A branch by its name or its id (history_summary lists them).',
});
const NAME = Object.freeze({
  type: 'string', minLength: 1, examples: ['Without alpha'],
  description: 'A name, unique among its kind (compared without case and extra spaces); no length limit.',
});
const GROUP_REF = Object.freeze({
  type: 'string', minLength: 1, examples: ['QC'],
  description: 'A group by its name or its id (history_summary lists them).',
});
const TURN_ID = Object.freeze({ type: 'string', minLength: 1, examples: ['turn-1'], description: 'A turn, by its id (history_summary lists them).' });
const TEXT = Object.freeze({
  type: 'string', minLength: 1, examples: ['Top hits match the paper.'],
  description: 'Markdown: emphasis, inline code and http(s) links; shown without HTML.',
});

const ID_NAME = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' } },
});
const HEAD = Object.freeze({ type: 'string', description: 'The step shown now.' });
const BY = Object.freeze({
  type: 'object', additionalProperties: false, required: ['origin', 'agent', 'model', 'host', 'person', 'turn'],
  description: 'Who acted.',
  properties: {
    origin: { enum: [...BY_ORIGINS], description: 'user (the person), agent, host (a notebook), session, replay, startup, or outside (not recorded as an action).' },
    agent: { type: ['string', 'null'], description: 'The agent, for an agent.' },
    model: { type: ['string', 'null'], description: 'The agent\'s model, when known.' },
    host: { enum: [...HISTORY_HOSTS, null], description: 'The notebook language, for a host.' },
    person: { type: ['string', 'null'], description: 'The person\'s name, only when they chose to record it.' },
    turn: { type: ['string', 'null'], description: 'The turn it belongs to.' },
  },
});
const NOTE = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id', 'text', 'by', 'at', 'edited_at', 'from_reply'],
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    by: BY,
    at: { type: ['number', 'null'], description: 'When, in milliseconds since 1970.' },
    edited_at: { type: ['number', 'null'] },
    from_reply: { type: 'boolean', description: 'Taken from an agent\'s final reply (a turn summary it did not write).' },
  },
});

const STEP = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['id', 'parent', 'kind', 'squash', 'label', 'type', 'v', 'code', 'origin', 'agent', 'host', 'turn', 'at', 'status', 'note', 'touches', 'group', 'shown'],
  properties: {
    id: { type: 'string' },
    parent: { type: ['string', 'null'] },
    kind: { enum: [...STEP_KINDS], description: 'root (the opening step), action, outside (a change made outside an action) or squashed (several steps merged into one, or what changed while recording was paused).' },
    squash: { enum: [...SQUASH_CAUSES, null], description: 'Why a squashed step was made (paused, steps, clear, share); null for every other kind.' },
    label: { type: 'string', description: 'What the step did, in a sentence.' },
    type: { type: ['string', 'null'], description: 'The action it applied (null for the opening step and a squashed step).' },
    v: { type: ['integer', 'null'], description: 'The version of the action\'s parameters it was recorded with (null but for an action).' },
    code: { type: ['string', 'null'], description: 'The step as one line of pseudocode.' },
    origin: { type: 'string', description: 'Who took it: user, agent, host (a notebook), session, replay, startup.' },
    agent: { type: ['string', 'null'], description: 'The agent that took it (Claude, ChatGPT), for an agent\'s step.' },
    host: { type: ['string', 'null'], description: 'The notebook host (Python, R), for a host\'s step.' },
    turn: { type: ['string', 'null'], description: 'The agent turn it belongs to (one click undoes a turn).' },
    at: { type: 'number', description: 'When, in milliseconds since 1970.' },
    status: { type: 'string', enum: ['applied', 'unapplicable'] },
    note: { type: ['string', 'null'], description: 'Why a step no longer applies.' },
    touches: { type: 'array', items: { type: 'string' }, description: 'The state it changed.' },
    group: { type: ['string', 'null'], description: 'The group it is in (its id; history_summary names the groups), or null.' },
    shown: { type: 'boolean', description: 'On the path to the step shown now.' },
    params: {
      type: 'array', description: 'Its parameters, each as a label and a value in words (fields: params).',
      items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } },
    },
    notes: { type: 'array', items: NOTE, description: 'Its notes (fields: notes).' },
    bookmark: { type: ['string', 'null'], description: 'Its bookmark (fields: bookmark).' },
  },
});

/** What `history.get` may add to each step (`fields`). */
export const HISTORY_STEP_FIELDS = Object.freeze(['params', 'notes', 'bookmark']);
const REPLAY_REPORT = Object.freeze({
  type: 'array',
  description: 'Every step replayed and what became of it.',
  items: {
    type: 'object', additionalProperties: false, required: ['source', 'label', 'outcome', 'step', 'reason', 'missing'],
    properties: {
      source: { type: 'string', description: 'The step replayed.' },
      label: { type: 'string' },
      outcome: { enum: [...REPLAY_OUTCOMES] },
      step: { type: ['string', 'null'], description: 'The step it became here.' },
      reason: { type: ['string', 'null'], description: 'Why it was not applied.' },
      missing: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, required: ['kind', 'name', 'field'],
            properties: {
              kind: { enum: [...REPLAY_MISSING_KINDS] },
              name: { type: 'string', description: 'The name the step gave.' },
              field: { type: ['string', 'null'], description: 'For a category, the field it was looked for in.' },
            },
          },
          { type: 'null' },
        ],
        description: 'The name it gave that resolves to nothing here (a field, a category or a gene): replay again with a mapping that uses another.',
      },
    },
  },
});
const NEW_BRANCH = Object.freeze({
  type: 'object', additionalProperties: false, required: ['branch', 'head', 'report'],
  properties: {
    branch: { oneOf: [ID_NAME, { type: 'null', description: 'No step applied, so no branch was made.' }] },
    head: HEAD,
    report: REPLAY_REPORT,
  },
});
const TEXT_RESULT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['tracker', 'branch', 'text'],
  properties: { tracker: ID_NAME, branch: ID_NAME, text: { type: 'string' } },
});
const NAME_MAP = Object.freeze({
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['from', 'to'],
    properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } },
  },
});
const MAPPING = Object.freeze({
  type: 'object', additionalProperties: false, required: ['fields', 'categories', 'genes'],
  description: 'Names to use in place of the recorded ones, each from its recorded name (the replay report offers them: a step\'s missing names what matched nothing here). A category is named by its field\'s recorded key.',
  properties: {
    fields: { ...NAME_MAP, description: 'obs fields: recorded key → key here.' },
    categories: {
      type: 'array', description: 'Categories: in a field (its recorded key), recorded label → label here.',
      items: {
        type: 'object', additionalProperties: false, required: ['field', 'from', 'to'],
        properties: { field: { type: 'string', minLength: 1 }, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } },
      },
    },
    genes: { ...NAME_MAP, description: 'Genes: recorded name → name here.' },
  },
});
const NOTE_TARGET = Object.freeze({
  description: 'What the note is on: a step, a branch, a group, a turn, or a tracker itself.',
  examples: [{ step: 's3' }],
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['step'], properties: { step: ANY_STEP_ID, tracker: TRACKER } },
    { type: 'object', additionalProperties: false, required: ['branch'], properties: { branch: BRANCH, tracker: TRACKER } },
    { type: 'object', additionalProperties: false, required: ['group'], properties: { group: GROUP_REF, tracker: TRACKER } },
    { type: 'object', additionalProperties: false, required: ['turn'], properties: { turn: TURN_ID, tracker: TRACKER } },
    { type: 'object', additionalProperties: false, required: ['tracker'], properties: { tracker: TRACKER_REQUIRED } },
  ],
});
const STEP_REF = Object.freeze({
  type: 'object', additionalProperties: false, required: ['step'],
  properties: { step: ANY_STEP_ID, tracker: TRACKER },
});
const SQUASHED = Object.freeze({
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['cause', 'count', 'by', 'carried'],
      properties: {
        cause: { enum: [...SQUASH_CAUSES], description: 'paused (changed while recording was paused), steps (merged into one), clear (the history cleared, the state kept), share (a state shared without its history).' },
        count: { type: ['integer', 'null'], description: 'The steps it replaced; null when none was recorded (paused) or the count was left out (share).' },
        by: { type: 'array', items: BY, description: 'Everyone who acted in what it replaced.' },
        carried: {
          type: 'object', additionalProperties: false, required: ['notes', 'bookmarks'],
          description: 'The notes (now its own) and bookmarks of the steps it replaced.',
          properties: { notes: { type: 'array', items: { type: 'string' } }, bookmarks: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    { type: 'null', description: 'Not a squashed step.' },
  ],
});
const CONTENT = Object.freeze({
  enum: [...SHARE_CONTENTS], default: 'history',
  description: 'history: the trackers and branches with their values; state: the current state only, without its history (one squashed step "Shared state"); steps: the steps only, no cells or values (a replay plan for any dataset).',
});
const RESULTS = Object.freeze({
  enum: [...SHARE_RESULTS], default: 'include',
  description: 'Analysis results: include them, or leave them out to compute again on open from their recorded inputs (smaller; always so for steps).',
});

function object(required, properties) {
  return { type: 'object', additionalProperties: false, required, properties };
}

/** Pseudocode arguments: each given parameter as `name=value`, in schema order. */
function args(params, order) {
  return order.filter(key => params[key] !== undefined).map(key => `${key}=${JSON.stringify(params[key])}`).join(', ');
}

function onTracker(params, quote = PLAIN_QUOTE) {
  return params.tracker === undefined ? '' : ` of tracker ${quote(params.tracker)}`;
}

function targetText(target, quote = PLAIN_QUOTE) {
  if (target.step !== undefined) return `step ${target.step}`;
  if (target.branch !== undefined) return `branch ${quote(target.branch)}`;
  if (target.turn !== undefined) return 'a turn';
  return `tracker ${quote(target.tracker)}`;
}

/**
 * The history's actions every surface reaches (the State panel, agents,
 * Python, R). The undo, redo and jump of `history.js`, and `history.get`,
 * are provided now.
 */
export const historyActions = Object.freeze([
  defineAction({
    type: 'history.get',
    title: 'Read the history',
    summary: 'The steps taken on this dataset, who took each (person, agent, notebook), branches and the step shown.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        tracker: TRACKER,
        branch: { ...BRANCH, description: 'The path to this branch\'s tip (by its name or id) instead of the path to the step shown; not with all_branches.' },
        all_branches: { type: 'boolean', default: false, description: 'Every branch, not only the path to the step shown.' },
        since: { type: 'number', description: 'Only the steps recorded at or after this time (milliseconds since 1970: a step\'s "at"), so a second read lists what came since.' },
        limit: { type: 'integer', minimum: 1, default: HISTORY_PAGE_STEPS, description: `The steps of one page (${HISTORY_PAGE_STEPS} when left out: well under what a tool result carries).` },
        cursor: { type: 'string', minLength: 1, examples: ['s200'], description: 'Where the page starts: the next of the last page (its last step\'s id); the first page when left out.' },
        fields: {
          type: 'array', uniqueItems: true, items: { enum: [...HISTORY_STEP_FIELDS] },
          description: 'What to add to each step: params (each parameter in words), notes, bookmark.',
        },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['tracker', 'trackers', 'head', 'branches', 'steps', 'total', 'next'],
      properties: {
        tracker: {
          type: 'object', additionalProperties: false, required: ['id', 'name'],
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
        trackers: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'name', 'active'],
            properties: { id: { type: 'string' }, name: { type: 'string' }, active: { type: 'boolean' } },
          },
        },
        head: { type: 'string', description: 'The step shown now.' },
        branches: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'tip', 'active'],
            properties: { name: { type: 'string' }, tip: { type: 'string' }, active: { type: 'boolean' } },
          },
        },
        steps: { type: 'array', items: STEP, description: 'One page: root first; parents before children.' },
        total: { type: 'integer', description: 'Steps on every page (the path to the step shown, or every branch).' },
        next: { type: ['string', 'null'], description: 'The cursor of the next page; null on the last.' },
      },
    },
    describe: () => 'Read the history',
    code: params => `get_history(${args(params, ['all_branches', 'limit', 'cursor'])})`,
  }),
  defineAction({
    type: 'history.summary',
    title: 'Summarise the history',
    summary: 'The history at a glance: trackers, branches (fork step, tip, steps, main, locked, archived), bookmarks, turns with their summaries, stale results and Recently deleted, without the steps. Read it before acting on the history.',
    group: GROUP,
    params: object([], { tracker: TRACKER }),
    reads: [],
    effect: 'read',
    result: object(
      ['tracker', 'trackers', 'head', 'active_branch', 'main_branch', 'recording', 'pending', 'steps', 'branches', 'groups', 'bookmarks', 'turns', 'stale', 'recently_deleted'],
      {
        tracker: ID_NAME,
        trackers: {
          type: 'array', description: 'Every tracker not removed.',
          items: object(['id', 'name', 'active', 'steps', 'start'], {
            id: { type: 'string' }, name: { type: 'string' }, active: { type: 'boolean' }, steps: { type: 'integer' },
            start: { enum: [...TRACKER_START_KINDS], description: 'What it started from.' },
          }),
        },
        head: HEAD,
        active_branch: { type: 'string' },
        main_branch: { type: 'string' },
        recording: object(['on', 'since'], {
          on: { type: 'boolean', description: 'Whether changes become steps; while paused they apply without one.' },
          since: { type: ['number', 'null'], description: 'When it was paused (milliseconds since 1970); null while recording.' },
        }),
        pending: {
          oneOf: [
            object(['name', 'from'], { name: { type: 'string' }, from: { type: 'string', description: 'The step the next change starts it from.' } }),
            { type: 'null' },
          ],
        },
        steps: { type: 'integer', description: 'Steps of the tracker, the root included.' },
        branches: {
          type: 'array', description: 'Every branch, in id order (archived ones flagged).',
          items: object(['id', 'name', 'base', 'tip', 'steps', 'main', 'locked', 'archived', 'active', 'notes'], {
            id: { type: 'string' }, name: { type: 'string' },
            base: { type: ['string', 'null'], description: 'The step it forks from.' },
            tip: { type: 'string' }, steps: { type: 'integer', description: 'Its own steps.' },
            main: { type: 'boolean' }, locked: { type: 'boolean' }, archived: { type: 'boolean' }, active: { type: 'boolean' },
            notes: { type: 'integer' },
          }),
        },
        groups: {
          type: 'array', description: 'Every group, in id order: a named run of consecutive steps of one branch.',
          items: object(['id', 'name', 'branch', 'first', 'last', 'steps', 'notes'], {
            id: { type: 'string' }, name: { type: 'string' }, branch: { type: 'string' },
            first: { type: 'string', description: 'Its first step.' }, last: { type: 'string', description: 'Its last step.' },
            steps: { type: 'integer' }, notes: { type: 'integer' },
          }),
        },
        bookmarks: { type: 'array', items: object(['name', 'step'], { name: { type: 'string' }, step: { type: 'string' } }) },
        turns: {
          type: 'array',
          items: object(['id', 'label', 'by', 'steps', 'branch', 'summary'], {
            id: { type: 'string' }, label: { type: 'string' }, by: BY, steps: { type: 'integer' },
            branch: { type: 'string' }, summary: { type: ['string', 'null'], description: 'Its first note.' },
          }),
        },
        stale: { type: 'integer', description: 'Results whose inputs changed since (history_stale lists them).' },
        recently_deleted: { type: 'integer', description: 'Entries that can be undone.' },
      },
    ),
    describe: () => 'Read the history\'s summary',
    code: params => `history_summary(${args(params, ['tracker'])})`,
  }),
  defineAction({
    type: 'history.step',
    title: 'Read a step',
    summary: 'One step in full: its parameters, pseudocode, who took it and when, what it changed and read, its notes and bookmark, and why it is stale.',
    group: GROUP,
    params: object(['step'], { step: ANY_STEP_ID, tracker: TRACKER }),
    reads: [],
    effect: 'read',
    result: object(
      ['tracker', 'id', 'parent', 'children', 'branch', 'kind', 'type', 'v', 'label', 'code', 'params', 'by', 'at', 'until', 'merged', 'ms',
        'touches', 'reads', 'status', 'reason', 'squashed', 'notes', 'bookmark', 'group', 'replay_of', 'stale', 'shown'],
      {
        tracker: ID_NAME, id: { type: 'string' }, parent: { type: ['string', 'null'] },
        children: { type: 'array', items: { type: 'string' } }, branch: ID_NAME, kind: { enum: [...STEP_KINDS] },
        type: { type: ['string', 'null'] }, v: { type: ['integer', 'null'] }, label: { type: 'string' }, code: { type: ['string', 'null'] },
        params: {
          type: 'array', description: 'Its parameters as the details show them (cells as counts).',
          items: object(['label', 'value'], { label: { type: 'string' }, value: { type: 'string' } }),
        },
        by: BY,
        at: { type: ['number', 'null'] }, until: { type: ['number', 'null'] },
        merged: { type: 'integer', description: 'Changes merged into it (a drag, a gesture).' },
        ms: { type: ['number', 'null'], description: 'How long its action took.' },
        touches: { type: 'array', items: { enum: [...DOMAIN_IDS] } },
        reads: { type: 'array', items: { type: 'string' }, description: 'The inputs its result depends on.' },
        status: { enum: [...STEP_STATUSES] }, reason: { type: ['string', 'null'] }, squashed: SQUASHED,
        notes: { type: 'array', items: NOTE }, bookmark: { type: ['string', 'null'] },
        group: { oneOf: [ID_NAME, { type: 'null', description: 'In no group.' }] },
        replay_of: {
          oneOf: [object(['tracker', 'step'], { tracker: { type: 'string' }, step: { type: 'string' } }), { type: 'null' }],
        },
        stale: {
          oneOf: [
            object(['cause', 'reasons'], {
              cause: { oneOf: [object(['step', 'label'], { step: { type: 'string' }, label: { type: 'string' } }), { type: 'null' }] },
              reasons: { type: 'array', items: { type: 'string' } },
            }),
            { type: 'null', description: 'Not stale.' },
          ],
        },
        shown: { type: 'boolean', description: 'On the path to the step shown now.' },
      },
    ),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Read step ${quote.bare(params.step)}`,
    code: params => `history_step(${args(params, ['step', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.diff',
    title: 'Compare two steps',
    summary: 'What differs between the state after two steps, part by part (filters, labels, highlights, …); the steps may be of two trackers.',
    group: GROUP,
    params: object(['a', 'b'], {
      a: { ...STEP_REF, examples: [{ step: 's1' }], description: 'The first step.' },
      b: { ...STEP_REF, examples: [{ step: 's2' }], description: 'The second step.' },
    }),
    reads: [],
    effect: 'read',
    result: object(['a', 'b', 'common', 'domains'], {
      a: object(['tracker', 'step'], { tracker: ID_NAME, step: { type: 'string' } }),
      b: object(['tracker', 'step'], { tracker: ID_NAME, step: { type: 'string' } }),
      common: { type: ['string', 'null'], description: 'Their last common step (null across trackers).' },
      domains: {
        type: 'array',
        items: object(['domain', 'name', 'lines'], {
          domain: { enum: [...DOMAIN_IDS] }, name: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } },
        }),
      },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Compared step ${quote.bare(params.a.step)} with step ${quote.bare(params.b.step)}`,
    code: params => `history_diff(${JSON.stringify(params.a.step)}, ${JSON.stringify(params.b.step)})`,
  }),
  defineAction({
    type: 'history.stale',
    title: 'List stale results',
    summary: 'Steps whose result no longer matches its inputs (the cells, the mapping, a highlight changed since), each with the step that made it stale and why.',
    group: GROUP,
    params: object([], { tracker: TRACKER }),
    reads: [],
    effect: 'read',
    result: object(['tracker', 'stale'], {
      tracker: ID_NAME,
      stale: {
        type: 'array',
        items: object(['step', 'label', 'cause', 'reasons'], {
          step: { type: 'string' }, label: { type: 'string' },
          cause: { oneOf: [object(['step', 'label'], { step: { type: 'string' }, label: { type: 'string' } }), { type: 'null' }] },
          reasons: { type: 'array', items: { type: 'string' } },
        }),
      },
    }),
    describe: () => 'Listed stale results',
    code: params => `history_stale(${args(params, ['tracker'])})`,
  }),
  defineAction({
    type: 'history.search',
    title: 'Search the history',
    summary: 'The steps whose label, parameters, notes or bookmark match, filtered by who took them, their kind, the part of the state they changed, notes, bookmarks and flags.',
    group: GROUP,
    params: object([], {
      text: { type: 'string', minLength: 1, description: 'Words to find (any case).' },
      by: { enum: ['person', 'agent', 'python', 'r', 'replay', 'outside'], description: 'Who took them.' },
      kind: { enum: ['state', 'view', 'layout'], description: 'What their action changes.' },
      step_kind: { enum: [...STEP_KINDS], description: 'What they are: root, action, outside (changed outside an action) or squashed.' },
      domain: { enum: [...DOMAIN_IDS], description: 'The part of the state they changed.' },
      has_note: { type: 'boolean' },
      bookmarked: { type: 'boolean' },
      flagged: { type: 'boolean', description: 'Stale, or no longer applying.' },
      tracker: TRACKER,
    }),
    reads: [],
    effect: 'read',
    result: object(['tracker', 'steps', 'total'], {
      tracker: ID_NAME,
      steps: { type: 'array', items: { type: 'string' }, description: 'The matching steps, in step order.' },
      total: { type: 'integer', description: 'Steps in the tracker.' },
    }),
    describe: () => 'Searched the history',
    code: params => `history_search(${args(params, ['text', 'by', 'kind', 'step_kind', 'domain', 'has_note', 'bookmarked', 'flagged', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.methods',
    title: 'Write the methods paragraph',
    summary: 'The methods paragraph of a branch (main when left out): the dataset and its citation, the cells used, each step that changed the analysis, the tracker\'s notes as its opening, and the Cellucid version.',
    group: GROUP,
    params: object([], { branch: BRANCH, tracker: TRACKER }),
    reads: [],
    effect: 'read',
    result: TEXT_RESULT,
    describe: () => 'Wrote the methods paragraph',
    code: params => `history_methods(${args(params, ['branch', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.pseudocode',
    title: 'Write the pseudocode',
    summary: 'A branch\'s steps (main when left out) as pseudocode, one line each, as recorded.',
    group: GROUP,
    params: object([], { branch: BRANCH, tracker: TRACKER }),
    reads: [],
    effect: 'read',
    result: TEXT_RESULT,
    describe: () => 'Wrote the pseudocode',
    code: params => `history_pseudocode(${args(params, ['branch', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.saved.list',
    title: 'List saved states',
    summary: 'The histories kept in this browser (each dataset\'s autosave and the named saves): name, dataset, trackers, steps, size, and whether this version opens them.',
    group: GROUP,
    params: NO_PARAMS,
    reads: [],
    effect: 'read',
    result: object(['saved'], {
      saved: {
        type: 'array', description: 'Most recently written first.',
        items: object(['id', 'kind', 'name', 'dataset', 'this_dataset', 'created_at', 'updated_at', 'steps', 'trackers', 'bytes', 'openable'], {
          id: { type: 'string' }, kind: { enum: ['autosave', 'named'] }, name: { type: ['string', 'null'] },
          dataset: object(['id', 'name'], { id: { type: ['string', 'null'] }, name: { type: ['string', 'null'] } }),
          this_dataset: { type: 'boolean', description: 'Of the dataset open now.' },
          created_at: { type: 'number' }, updated_at: { type: 'number' }, steps: { type: 'integer' },
          trackers: { type: 'array', items: object(['id', 'name', 'steps'], { id: { type: 'string' }, name: { type: 'string' }, steps: { type: 'integer' } }) },
          bytes: { type: 'integer' }, openable: { type: 'boolean' },
        }),
      },
    }),
    describe: () => 'Listed the saved states',
    code: () => 'history_saved_list()',
  }),
  defineAction({
    type: 'history.saved.delete',
    title: 'Delete a saved state',
    summary: 'Remove one saved state of this browser (an autosave or a named save, by its id from history_saved_list) with every value only it held; it cannot be brought back. The history shown stays open.',
    group: GROUP,
    params: object(['saved'], {
      saved: { type: 'string', minLength: 1, examples: ['state-1'], description: 'Its id (history_saved_list).' },
    }),
    reads: [],
    effect: 'outside',
    confirm: 'deletes-saved',
    acts: { one: 'saved state deleted', other: 'saved states deleted' },
    result: object(['saved', 'name', 'dataset', 'steps'], {
      saved: { type: 'string' }, name: { type: ['string', 'null'] },
      dataset: { type: ['string', 'null'], description: 'The name of its dataset.' }, steps: { type: 'integer' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Deleted the saved state ${quote.bare(params.saved)}`,
    code: params => `history_saved_delete(${JSON.stringify(params.saved)})`,
  }),
  defineAction({
    type: 'history.undo',
    title: 'Undo',
    summary: 'Show the state before the step shown now, as the State panel\'s Undo does; the step stays in the history, to redo.',
    group: GROUP,
    params: NO_PARAMS,
    reads: [],
    effect: 'history',
    result: object(['moved', 'head'], {
      moved: { type: 'boolean', description: 'Whether the history moved: not when there was no step to move to (nothing to undo, or nothing to redo).' },
      head: HEAD,
    }),
    describe: () => 'Undid a step',
    code: () => 'undo()',
  }),
  defineAction({
    type: 'history.redo',
    title: 'Redo',
    summary: 'Show the step after the one shown now on the branch last taken, as the State panel\'s Redo does.',
    group: GROUP,
    params: NO_PARAMS,
    reads: [],
    effect: 'history',
    result: object(['moved', 'head'], {
      moved: { type: 'boolean', description: 'Whether the history moved: not when there was no step to move to (nothing to undo, or nothing to redo).' },
      head: HEAD,
    }),
    describe: () => 'Redid a step',
    code: () => 'redo()',
  }),
  defineAction({
    type: 'history.jump',
    title: 'Show a step',
    summary: 'Show the state after any step of the tracker in use, on any branch, as clicking it in the timeline does; nothing is undone or lost. Name exactly one of step, bookmark or at.',
    group: GROUP,
    params: object([], {
      step: STEP_ID,
      bookmark: { type: 'string', minLength: 1, examples: ['Before reclustering'], description: 'A bookmark\'s name (any case): show the step it marks.' },
      at: { type: 'number', examples: [1767225600000], description: 'A time (milliseconds since 1970): show the last step at or before it on the branch shown.' },
    }),
    reads: [],
    effect: 'history',
    result: object(['head'], { head: HEAD }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.step !== undefined ? `Showed step ${quote.bare(params.step)}`
      : params.bookmark !== undefined ? `Showed the bookmark ${quote(params.bookmark)}` : 'Showed the step at a time'),
    code: params => `jump(${args(params, ['step', 'bookmark', 'at'])})`,
  }),
  defineAction({
    type: 'history.branch.switch',
    title: 'Switch branch',
    summary: 'Show a branch\'s last step and continue on it; an agent\'s turn continues on it too.',
    group: GROUP,
    params: object(['branch'], { branch: BRANCH, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['branch', 'head'], { branch: ID_NAME, head: HEAD }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Switched to branch ${quote(params.branch)}${onTracker(params, quote)}`,
    code: params => `switch_branch(${args(params, ['branch', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.branch.create',
    title: 'Branch here',
    summary: 'Show a step and start a new branch from it with the next change (a branch exists from its first step); the name defaults to the next "Branch n".',
    group: GROUP,
    params: object(['step'], { step: STEP_ID, name: NAME }),
    reads: [],
    effect: 'history',
    result: object(['pending', 'from', 'head'], {
      pending: { type: 'string', description: 'The name the next change\'s branch takes.' }, from: { type: 'string' }, head: HEAD,
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.name === undefined ? `Branched from step ${quote.bare(params.step)}` : `Branched ${quote(params.name)} from step ${quote.bare(params.step)}`),
    code: params => `branch_here(${args(params, ['step', 'name'])})`,
  }),
  defineAction({
    type: 'history.branch.cancel',
    title: 'Cancel a new branch',
    summary: 'Forget the branch "Branch here" set to start with the next change.',
    group: GROUP,
    params: NO_PARAMS,
    reads: [],
    effect: 'history',
    result: object(['cancelled'], { cancelled: { type: ['string', 'null'], description: 'The name forgotten; null when none was set.' } }),
    describe: () => 'Cancelled the new branch',
    code: () => 'cancel_branch()',
  }),
  defineAction({
    type: 'history.branch.rename',
    title: 'Rename a branch',
    summary: 'Give a branch another name, unique in its tracker.',
    group: GROUP,
    params: object(['branch', 'name'], { branch: BRANCH, name: NAME, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['branch', 'journal'], { branch: ID_NAME, journal: { type: 'string', description: 'Its Recently changed entry.' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Renamed branch ${quote(params.branch)} to ${quote(params.name)}${onTracker(params, quote)}`,
    code: params => `rename_branch(${args(params, ['branch', 'name', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.branch.archive',
    title: 'Archive a branch',
    summary: 'Hide a branch from the graph and the pickers, or show it again; it is kept and can be shared. Main cannot be archived.',
    group: GROUP,
    params: object(['branch', 'archived'], { branch: BRANCH, archived: { type: 'boolean', examples: [true] }, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['branch', 'archived', 'journal'], { branch: ID_NAME, archived: { type: 'boolean' }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `${params.archived ? 'Archived' : 'Unarchived'} branch ${quote(params.branch)}${onTracker(params, quote)}`,
    code: params => `archive_branch(${args(params, ['branch', 'archived', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.branch.set-main',
    title: 'Make a branch main',
    summary: 'Make a branch the tracker\'s main one, what sharing, replay and loading default to.',
    group: GROUP,
    params: object(['branch'], { branch: BRANCH, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['branch', 'journal'], { branch: ID_NAME, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Made branch ${quote(params.branch)} main${onTracker(params, quote)}`,
    code: params => `set_main_branch(${args(params, ['branch', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.branch.lock',
    title: 'Lock a branch',
    summary: 'Lock a branch (no new step, rename, delete or compaction until unlocked; a change at its tip starts a new branch), or unlock it.',
    group: GROUP,
    params: object(['branch', 'locked'], { branch: BRANCH, locked: { type: 'boolean', examples: [true] }, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['branch', 'locked', 'journal'], { branch: ID_NAME, locked: { type: 'boolean' }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `${params.locked ? 'Locked' : 'Unlocked'} branch ${quote(params.branch)}${onTracker(params, quote)}`,
    code: params => `lock_branch(${args(params, ['branch', 'locked', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.branch.delete',
    title: 'Delete a branch',
    summary: 'Move a branch\'s own steps (those no other branch starts from) to Recently deleted, where they can be restored; with with_sub_branches, the branches that start from it too. Main and locked branches cannot be deleted.',
    group: GROUP,
    params: object(['branch'], {
      branch: BRANCH,
      with_sub_branches: { type: 'boolean', default: false, description: 'Also delete every branch that starts from it.' },
      tracker: TRACKER,
    }),
    reads: [],
    effect: 'history',
    confirm: 'deletes-saved',
    result: object(['branches', 'steps', 'results', 'kept_views', 'replays', 'absorbed_by', 'head', 'journal'], {
      branches: { type: 'array', items: ID_NAME, description: 'The branches deleted.' },
      steps: { type: 'integer', description: 'Steps moved to Recently deleted.' },
      results: { type: 'integer', description: 'Results computed on them.' },
      kept_views: { type: 'integer', description: 'Kept views elsewhere made from it (they keep their picture).' },
      replays: { type: 'integer', description: 'Trackers replayed from it.' },
      absorbed_by: { oneOf: [ID_NAME, { type: 'null' }], description: 'The branch that keeps its shared steps.' },
      head: HEAD,
      journal: { type: 'string', description: 'Its Recently deleted entry.' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Deleted branch ${quote(params.branch)}${params.with_sub_branches ? ' and the branches that start from it' : ''}${onTracker(params, quote)}`,
    code: params => `delete_branch(${args(params, ['branch', 'with_sub_branches', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.branch.without',
    title: 'Branch without a step',
    summary: 'Make a new branch from a step\'s parent that applies the later steps of the path again without it, by name; nothing existing changes. The report says what did not apply.',
    group: GROUP,
    params: object(['step'], { step: STEP_ID, name: NAME }),
    reads: [],
    effect: 'history',
    result: NEW_BRANCH,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Branched without step ${quote.bare(params.step)}`,
    code: params => `branch_without(${args(params, ['step', 'name'])})`,
  }),
  defineAction({
    type: 'history.branch.apply',
    title: 'Apply a branch\'s steps here',
    summary: 'Apply a branch\'s own steps again, by name, on top of the step shown, as a new branch (no values are merged; a step that does not apply here is flagged).',
    group: GROUP,
    params: object(['branch'], { branch: BRANCH, name: NAME, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: NEW_BRANCH,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Applied the steps of branch ${quote(params.branch)} here${onTracker(params, quote)}`,
    code: params => `apply_branch(${args(params, ['branch', 'name', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.verify',
    title: 'Verify a branch',
    summary: 'Replay a branch on this dataset into a scratch tracker and compare every part of the state at the end with its last step: reproduced exactly, or the first step whose values differ.',
    group: GROUP,
    params: object(['branch'], {
      branch: BRANCH, tracker: TRACKER,
      keep: { type: 'boolean', default: false, description: 'Keep the scratch tracker afterwards.' },
    }),
    reads: [],
    effect: 'history',
    result: object(['reproduced', 'steps', 'domains', 'scratch'], {
      reproduced: { type: 'boolean' },
      steps: { type: 'integer', description: 'Steps replayed.' },
      domains: {
        type: 'array', description: 'Each part of the state that differs.',
        items: object(['domain', 'first_step', 'lines'], {
          domain: { enum: [...DOMAIN_IDS] }, first_step: { type: ['string', 'null'] }, lines: { type: 'array', items: { type: 'string' } },
        }),
      },
      scratch: { oneOf: [ID_NAME, { type: 'null', description: 'Removed.' }] },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Verified branch ${quote(params.branch)}${onTracker(params, quote)}`,
    code: params => `verify_branch(${args(params, ['branch', 'tracker', 'keep'])})`,
  }),
  defineAction({
    type: 'history.step.delete',
    title: 'Delete a step',
    summary: 'Move one step to Recently deleted; only the later steps that changed or read what it changed are applied again, and one that no longer applies is kept, flagged.',
    group: GROUP,
    params: object(['step'], { step: STEP_ID }),
    reads: [],
    effect: 'history',
    confirm: 'deletes-saved',
    result: object(['reapplied', 'flagged', 'head', 'journal'], {
      reapplied: { type: 'array', items: { type: 'string' }, description: 'Steps applied again.' },
      flagged: {
        type: 'array', description: 'Steps that no longer apply.',
        items: object(['step', 'reason'], { step: { type: 'string' }, reason: { type: 'string' } }),
      },
      head: HEAD,
      journal: { type: 'string', description: 'Its Recently deleted entry.' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Deleted step ${quote.bare(params.step)}`,
    code: params => `delete_step(${JSON.stringify(params.step)})`,
  }),
  defineAction({
    type: 'history.step.revert',
    title: 'Revert a step',
    summary: 'Add a step that puts back exactly what a step changed, when no later step on the path changed the same parts (else use Branch without a step).',
    group: GROUP,
    params: object(['step'], { step: STEP_ID }),
    touches: [...DOMAIN_IDS],
    reads: [],
    context: ['history'],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Reverted step ${quote.bare(params.step)}`,
    code: params => `revert_step(${JSON.stringify(params.step)})`,
  }),
  defineAction({
    type: 'history.squash',
    title: 'Merge steps into one',
    summary: 'Replace consecutive steps of one branch (from first to last, whole turns; a group\'s are its steps) with one squashed step from the first one\'s state to the last one\'s; elsewhere it replays as values only. Refused when another branch starts inside; the steps go to Recently deleted. An agent squashes only its own turn\'s steps.',
    group: GROUP,
    params: object(['from', 'to'], {
      from: { ...STEP_ID, examples: ['s4'], description: 'The first step to merge.' },
      to: { ...STEP_ID, examples: ['s9'], description: 'The last step to merge.' },
    }),
    reads: [],
    effect: 'history',
    confirm: 'deletes-saved',
    result: object(['step', 'squashed', 'groups_removed', 'head', 'journal'], {
      step: { type: 'string', description: 'The squashed step.' },
      squashed: { type: 'integer', description: 'Steps it replaced.' },
      groups_removed: { type: 'array', items: ID_NAME, description: 'Groups that held only these steps, removed with them.' },
      head: HEAD,
      journal: { type: 'string', description: 'Its Recently deleted entry.' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Merged steps ${quote.bare(params.from)} to ${quote.bare(params.to)} into one`,
    code: params => `squash(${JSON.stringify(params.from)}, ${JSON.stringify(params.to)})`,
  }),
  defineAction({
    type: 'history.clear',
    title: 'Clear the history',
    summary: 'Start the branch "Fresh start" from the opening step with nothing behind it: keeping the state shown (one squashed step from the dataset as opened to it), or from the dataset as opened (the branch starts with the next change). Every branch stays, archivable; either way it is kept in Recently changed and can be undone there.',
    group: GROUP,
    params: object(['keep_state'], {
      keep_state: { type: 'boolean', examples: [true], description: 'True keeps the state shown as one step; false starts over from the dataset as opened.' },
    }),
    reads: [],
    effect: 'history',
    confirm: 'deletes-saved',
    result: object(['branch', 'head', 'journal'], {
      branch: { oneOf: [ID_NAME, { type: 'null', description: 'Not made yet: it starts with the next change.' }] },
      head: HEAD,
      journal: { type: 'string', description: 'Its Recently changed entry.' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.keep_state ? 'Cleared the history, keeping the state' : 'Cleared the history, starting over'),
    code: params => `clear_history(keep_state=${params.keep_state ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'history.recording.pause',
    title: 'Pause recording',
    summary: 'Pause the history of a tracker: changes still apply but make no step until it is resumed, and an agent\'s change cannot be undone on its own meanwhile. Ask the person first.',
    group: GROUP,
    params: object([], { tracker: TRACKER }),
    reads: [],
    effect: 'history',
    confirm: 'pauses-recording',
    result: object(['since', 'head'], {
      since: { type: ['number', 'null'], description: 'When it was paused (milliseconds since 1970).' },
      head: HEAD,
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Paused recording${onTracker(params, quote)}`,
    code: params => `pause_history(${args(params, ['tracker'])})`,
  }),
  defineAction({
    type: 'history.recording.resume',
    title: 'Resume recording',
    summary: 'Record again: what differs from the step shown becomes one squashed step ("While paused: …"), by everyone who acted meanwhile; nothing when nothing differs.',
    group: GROUP,
    params: object([], { tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['squashed', 'head'], {
      squashed: { type: ['string', 'null'], description: 'The squashed step resuming made; null when nothing differed.' },
      head: HEAD,
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Resumed recording${onTracker(params, quote)}`,
    code: params => `resume_history(${args(params, ['tracker'])})`,
  }),
  defineAction({
    type: 'history.group.create',
    title: 'Group steps',
    summary: 'Name a run of consecutive steps of one branch as a group (a folder; nothing is changed or merged). It holds whole turns; a step is in one group at most. Group a multi-step analysis under a short name.',
    group: GROUP,
    params: object(['from', 'to', 'name'], {
      from: { ...STEP_ID, examples: ['s4'], description: 'Its first step.' },
      to: { ...STEP_ID, examples: ['s9'], description: 'Its last step.' },
      name: { ...NAME, examples: ['QC'] },
    }),
    reads: [],
    effect: 'history',
    result: object(['group', 'steps', 'journal'], {
      group: ID_NAME, steps: { type: 'integer', description: 'Steps in it.' }, journal: { type: 'string', description: 'Its Recently changed entry.' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Grouped steps ${quote.bare(params.from)} to ${quote.bare(params.to)} as ${quote(params.name)}`,
    code: params => `group_steps(${JSON.stringify(params.from)}, ${JSON.stringify(params.to)}, ${JSON.stringify(params.name)})`,
  }),
  defineAction({
    type: 'history.group.rename',
    title: 'Rename a group',
    summary: 'Give a group another name, unique in its tracker.',
    group: GROUP,
    params: object(['group', 'name'], { group: GROUP_REF, name: NAME, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['group', 'journal'], { group: ID_NAME, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Renamed the group ${quote(params.group)} to ${quote(params.name)}${onTracker(params, quote)}`,
    code: params => `rename_group(${args(params, ['group', 'name', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.group.extend',
    title: 'Add steps to a group',
    summary: 'Extend a group to a later step of its branch, taking in every step between (whole turns, none of another group).',
    group: GROUP,
    params: object(['group', 'to'], {
      group: GROUP_REF,
      to: { ...ANY_STEP_ID, examples: ['s12'], description: 'Its new last step.' },
      tracker: TRACKER,
    }),
    reads: [],
    effect: 'history',
    result: object(['group', 'steps', 'journal'], { group: ID_NAME, steps: { type: 'integer', description: 'Steps in it now.' }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Extended the group ${quote(params.group)} to step ${quote.bare(params.to)}${onTracker(params, quote)}`,
    code: params => `extend_group(${args(params, ['group', 'to', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.group.remove',
    title: 'Ungroup',
    summary: 'Remove a group; its steps stay as they are.',
    group: GROUP,
    params: object(['group'], { group: GROUP_REF, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['group', 'journal'], { group: ID_NAME, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Ungrouped ${quote(params.group)}${onTracker(params, quote)}`,
    code: params => `ungroup(${args(params, ['group', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.note.add',
    title: 'Add a note',
    summary: 'Write a note on a step, a branch, a turn or a tracker. End each turn that changed something with a one-line summary note on the turn.',
    group: GROUP,
    params: object(['target', 'text'], {
      target: NOTE_TARGET, text: TEXT,
      from_reply: { type: 'boolean', default: false, description: 'Taken from the agent\'s final reply (the turn summary written for an agent that wrote none).' },
    }),
    reads: [],
    effect: 'history',
    result: object(['note', 'journal'], { note: { type: 'string' }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Added a note on ${targetText(params.target, quote)}`,
    code: params => `add_note(${JSON.stringify(params.target)}, ${JSON.stringify(params.text)})`,
  }),
  defineAction({
    type: 'history.note.edit',
    title: 'Edit a note',
    summary: 'Change a note\'s text. An agent edits only its own notes; the person edits any.',
    group: GROUP,
    params: object(['note', 'text'], { note: NOTE_ID, text: TEXT, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['note', 'journal'], { note: { type: 'string' }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Edited note ${quote.bare(params.note)}`,
    code: params => `edit_note(${args(params, ['note', 'text', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.note.remove',
    title: 'Remove a note',
    summary: 'Remove a note. An agent removes only its own notes; the person removes any.',
    group: GROUP,
    params: object(['note'], { note: NOTE_ID, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['note', 'journal'], { note: { type: 'string' }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Removed note ${quote.bare(params.note)}`,
    code: params => `remove_note(${args(params, ['note', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.bookmark.set',
    title: 'Bookmark a step',
    summary: 'Give a step a bookmark name, unique in its tracker (jump to it by name), or remove it with null. Bookmark before destructive or heavy work.',
    group: GROUP,
    params: object(['step', 'name'], {
      step: STEP_ID,
      name: { type: ['string', 'null'], minLength: 1, examples: ['Before reclustering'], description: 'The bookmark, or null to remove it.' },
    }),
    reads: [],
    effect: 'history',
    result: object(['step', 'bookmark', 'journal'], { step: { type: 'string' }, bookmark: { type: ['string', 'null'] }, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.name === null ? `Removed the bookmark of step ${quote.bare(params.step)}` : `Bookmarked step ${quote.bare(params.step)} ${quote(params.name)}`),
    code: params => `bookmark(${JSON.stringify(params.step)}, ${JSON.stringify(params.name)})`,
  }),
  defineAction({
    type: 'history.tracker.start',
    title: 'Start another tracker',
    summary: 'Start a new tracker, an independent tree of steps on this dataset: from the dataset as opened (the default), or from what is shown.',
    group: GROUP,
    params: object([], {
      start: { enum: ['opened', 'shown'], default: 'opened', description: 'opened: the dataset as it was opened; shown: what is shown now.' },
      name: NAME,
    }),
    reads: [],
    effect: 'history',
    result: object(['tracker', 'head'], { tracker: ID_NAME, head: HEAD }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.name === undefined ? 'Started another tracker' : `Started the tracker ${quote(params.name)}`),
    code: params => `start_tracker(${args(params, ['start', 'name'])})`,
  }),
  defineAction({
    type: 'history.tracker.use',
    title: 'Use another tracker',
    summary: 'Show another tracker\'s step shown and record into it.',
    group: GROUP,
    params: object(['tracker'], { tracker: TRACKER_REQUIRED }),
    reads: [],
    effect: 'history',
    result: object(['tracker', 'head'], { tracker: ID_NAME, head: HEAD }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Used the tracker ${quote(params.tracker)}`,
    code: params => `use_tracker(${JSON.stringify(params.tracker)})`,
  }),
  defineAction({
    type: 'history.tracker.rename',
    title: 'Rename a tracker',
    summary: 'Give a tracker another name, unique among this dataset\'s trackers.',
    group: GROUP,
    params: object(['tracker', 'name'], { tracker: TRACKER_REQUIRED, name: NAME }),
    reads: [],
    effect: 'history',
    result: object(['tracker', 'journal'], { tracker: ID_NAME, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Renamed the tracker ${quote(params.tracker)} to ${quote(params.name)}`,
    code: params => `rename_tracker(${JSON.stringify(params.tracker)}, ${JSON.stringify(params.name)})`,
  }),
  defineAction({
    type: 'history.tracker.remove',
    title: 'Remove a tracker',
    summary: 'Move a tracker to Recently deleted, where it can be restored; when it is the one in use, the one used before it is shown first.',
    group: GROUP,
    params: object(['tracker'], { tracker: TRACKER_REQUIRED }),
    reads: [],
    effect: 'history',
    confirm: 'deletes-saved',
    result: object(['tracker', 'shown', 'journal'], { tracker: ID_NAME, shown: ID_NAME, journal: { type: 'string' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Removed the tracker ${quote(params.tracker)}`,
    code: params => `remove_tracker(${JSON.stringify(params.tracker)})`,
  }),
  defineAction({
    type: 'history.turn.undo',
    title: 'Undo a turn',
    summary: 'Take back one agent or notebook turn on the branch shown: show the step before it, or, with only_own, delete only the turn\'s own steps (applying the others again) when someone else\'s steps came in between.',
    group: GROUP,
    params: object(['turn'], {
      turn: TURN_ID,
      only_own: { type: 'boolean', default: false, description: 'Delete only the turn\'s own steps, keeping the others (to Recently deleted).' },
    }),
    reads: [],
    effect: 'history',
    result: object(['head', 'removed', 'other_branches', 'journal'], {
      head: HEAD,
      removed: { type: 'integer', description: 'Steps deleted (only_own).' },
      other_branches: { type: 'array', items: ID_NAME, description: 'Branches holding more of its steps, undone there separately.' },
      journal: { type: ['string', 'null'] },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.only_own ? 'Undid only the turn\'s own steps' : 'Undid a turn'),
    code: params => `undo_turn(${args(params, ['turn', 'only_own'])})`,
  }),
  defineAction({
    type: 'history.journal.undo',
    title: 'Restore from Recently deleted',
    summary: 'Undo an edit of the history (a delete, a rename, a note, …) from Recently deleted: exactly as it was when nothing changed it since, else as new objects ("X (restored)", removed steps applied again as a branch). Undoing a rename whose old name was taken since is refused, naming the name to use instead.',
    group: GROUP,
    params: object(['entry'], { entry: JOURNAL_ID, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    result: object(['entry', 'restored', 'journal', 'branch', 'report'], {
      entry: { type: 'string' },
      restored: { enum: ['exact', 'as-new'] },
      journal: { type: 'string', description: 'The entry the restore itself made (undoable).' },
      branch: { oneOf: [ID_NAME, { type: 'null', description: 'Restored exactly, or no step was applied again.' }], description: 'The first branch a restore as new made of the steps it applied again.' },
      report: { ...REPLAY_REPORT, description: 'The steps a restore as new applied again and what became of each (empty for an exact restore).' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Restored ${quote.bare(params.entry)}${onTracker(params, quote)}`,
    code: params => `restore(${args(params, ['entry', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.journal.empty',
    title: 'Empty Recently deleted',
    summary: 'Drop what Recently deleted keeps (one entry, or all of them) so its values can be freed; it can no longer be restored.',
    group: GROUP,
    params: object([], { entry: JOURNAL_ID, tracker: TRACKER }),
    reads: [],
    effect: 'history',
    confirm: 'deletes-saved',
    result: object(['purged', 'bytes'], { purged: { type: 'integer' }, bytes: { type: 'integer', description: 'Memory freed.' } }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.entry === undefined ? 'Emptied Recently deleted' : `Emptied ${quote.bare(params.entry)} from Recently deleted`),
    code: params => `empty_recently_deleted(${args(params, ['entry', 'tracker'])})`,
  }),
  defineAction({
    type: 'history.replay',
    title: 'Replay a saved history',
    summary: 'Apply a saved state\'s branch (its main branch when left out) again here, step by step by name, in a new tracker linked to it; with a mapping, other names are used for fields, categories and genes. The report says what did not match.',
    group: GROUP,
    params: object(['saved'], {
      saved: { type: 'string', minLength: 1, examples: ['state-1'], description: 'A saved state of this browser (history_saved_list).' },
      tracker: { ...TRACKER, description: 'Its tracker, by name or id; its tracker shown when left out.' },
      branch: { ...BRANCH, description: 'Its branch; its main branch when left out.' },
      mapping: MAPPING,
      name: NAME,
    }),
    reads: [],
    effect: 'history',
    result: object(['tracker', 'report'], { tracker: ID_NAME, report: REPLAY_REPORT }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Replayed the saved state ${quote(params.saved)}`,
    code: params => `replay(${args(params, ['saved', 'tracker', 'branch', 'mapping', 'name'])})`,
  }),
  defineAction({
    type: 'history.share',
    title: 'Share the history as a file',
    summary: 'Write a session file to share: the history (trackers and branches chosen; the tracker in use, its main and shown branches by default), the current state only, or the steps only; with or without notes, conversations, Recently deleted, times and where the dataset opens from.',
    group: GROUP,
    params: object([], {
      include: {
        type: 'array', minItems: 1,
        description: 'The trackers to include, each with its branches (its main and shown branches when left out); the tracker in use when left out.',
        items: object(['tracker'], {
          tracker: TRACKER_REQUIRED,
          branches: { type: 'array', items: BRANCH, minItems: 1, uniqueItems: true },
        }),
      },
      content: CONTENT,
      results: { ...RESULTS, description: `${RESULTS.description} Steps only always recompute, whatever is given.` },
      notes: { type: 'boolean', default: true, description: 'Notes and bookmarks (never with a state).' },
      chats: { type: 'boolean', default: false, description: 'Conversations kept with the trackers (never with a state).' },
      journal: { type: 'boolean', default: false, description: 'Recently deleted (never with a state).' },
      times: { enum: [...SHARE_TIMES], description: 'exact; dates (each rounded down to its day); none. When left out: exact for a history or steps, none for a state.' },
      source: { enum: [...SHARE_SOURCES], default: 'full', description: 'full: the dataset\'s name and where it opens from; name: its name only.' },
      file: { type: 'string', minLength: 1, examples: ['T cell analysis.cellucid-session'], description: 'The file\'s name; the dataset\'s name when left out.' },
    }),
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'file written', other: 'files written' },
    result: object(['file', 'bytes', 'content', 'trackers', 'steps'], {
      file: { type: 'string' }, bytes: { type: 'integer' }, content: { enum: [...SHARE_CONTENTS] },
      trackers: { type: 'array', items: ID_NAME }, steps: { type: 'integer', description: 'Steps written.' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Shared ${params.content === 'state' ? 'the current state' : params.content === 'steps' ? 'the steps' : 'the history'} as a file`,
    code: params => `share_history(${args(params, ['include', 'content', 'results', 'notes', 'chats', 'journal', 'times', 'source', 'file'])})`,
  }),
  defineAction({
    type: 'history.save',
    title: 'Save the history in this browser',
    summary: 'Keep the history (every tracker), the current state only, or the steps only as a named saved state of this browser (history_saved_list lists them; replay or load it later).',
    group: GROUP,
    params: object([], {
      name: { ...NAME, examples: ['Before reclustering'], description: 'Its name; the dataset\'s name and the time when left out.' },
      content: CONTENT,
      results: RESULTS,
    }),
    reads: [],
    effect: 'outside',
    result: object(['saved', 'name', 'content', 'bytes', 'steps'], {
      saved: { type: 'string', description: 'Its id (history_saved_list).' }, name: { type: 'string' }, content: { enum: [...SHARE_CONTENTS] },
      bytes: { type: 'integer' }, steps: { type: 'integer' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.name === undefined ? 'Saved the history in this browser' : `Saved the history as ${quote(params.name)}`),
    code: params => `save_history(${args(params, ['name', 'content', 'results'])})`,
  }),
  defineAction({
    type: 'history.anndata.save',
    title: 'Save AnnData with this state',
    summary: 'Write a new Cellucid-ready AnnData file (.zarr.zip) of the whole open dataset with the state shown applied, as Python and R apply a session: renamed labels, user-defined fields and highlight groups as obs columns, gene sets in uns and var, and a record of what was applied; never over the dataset\'s own file.',
    group: GROUP,
    params: object([], {
      file: {
        type: 'string', minLength: 1, examples: ['PBMC annotated.zarr.zip'],
        description: 'The new file\'s name (.zarr.zip is added when it does not end so); "<dataset> with this state.zarr.zip" when left out.',
      },
    }),
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'AnnData copy written', other: 'AnnData copies written' },
    result: object(['file', 'to', 'bytes', 'layout', 'cells', 'tracker', 'branch', 'step', 'applied', 'rows', 'left_out'], {
      file: { type: 'string', description: 'The file\'s name.' },
      to: { enum: ['file', 'download'], description: 'file: a file the person chose in the save dialog; download: the browser\'s downloads.' },
      bytes: { type: 'integer' },
      layout: { enum: ['anndata', 'mudata'], description: 'A Cellucid-ready AnnData, or a MuData for a dataset of several modalities.' },
      cells: { type: 'integer', description: 'Cells written: every cell of the dataset, whichever were open.' },
      tracker: ID_NAME,
      branch: ID_NAME,
      step: { type: 'string', description: 'The step applied: the one shown.' },
      applied: { type: 'boolean', description: 'False when every change was in the dataset already (no record added).' },
      rows: {
        type: 'array', description: 'Every change of the apply plan, in domain order, as Python and R plan it.',
        items: object(['kind', 'name', 'status', 'cells', 'note'], {
          kind: { enum: [...APPLY_ROW_KINDS] },
          name: { type: 'string' },
          status: { enum: [...APPLY_ROW_STATUSES] },
          cells: { type: ['integer', 'null'], description: 'The cells it marks or labels.' },
          note: { type: ['string', 'null'], description: 'Why, when not applied or replaced.' },
        }),
      },
      left_out: { type: 'array', items: { type: 'string' }, description: 'What the copy does not hold of the state, or of the dataset, one sentence each.' },
    }),
    describe: () => 'Saved an AnnData copy with this state',
    code: params => `save_anndata(${args(params, ['file'])})`,
  }),
  defineAction({
    type: 'history.report',
    title: 'Make the printable report',
    summary: 'The State panel\'s printable report of the branch shown up to the step shown (the dataset, the methods text, every step with who took it, its parameters, what it changed and its notes, then the pseudocode), as an .html file the person receives (asked first) or as its text; with pictures of the views after the steps chosen (a file only).',
    group: GROUP,
    params: object([], {
      as: { enum: ['file', 'text'], default: 'file', description: 'file: an .html file downloaded to the person\'s computer, which they open, print or save as PDF; text: the same HTML document in the result (no pictures).' },
      pictures: {
        oneOf: [
          { enum: ['none', 'default'], description: 'none; or default: the bookmarks, the last step of each group and the step shown.' },
          { type: 'array', items: STEP_ID, minItems: 1, uniqueItems: true, description: 'These steps of the branch shown.' },
        ],
        default: 'none',
        description: 'The steps that get a picture of the views after them (each is shown in turn and drawn, then the history returns to the step shown). A file only.',
      },
      file: { type: 'string', minLength: 1, examples: ['T cell analysis report.html'], description: 'The file\'s name; the dataset\'s name and "history report" when left out.' },
    }),
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'report written', other: 'reports written', when: params => params.as !== 'text' },
    confirmAt: 'handler',
    result: object(['as', 'tracker', 'branch', 'to', 'steps', 'pictures', 'file', 'bytes', 'html'], {
      as: { enum: ['file', 'text'] },
      tracker: ID_NAME,
      branch: ID_NAME,
      to: { type: ['string', 'null'], description: 'The last step it covers, or null at the branch\'s tip.' },
      steps: { type: 'integer', description: 'Steps in it.' },
      pictures: { type: 'integer', description: 'Pictures in it.' },
      file: { type: ['string', 'null'], description: 'The file written (as file).' },
      bytes: { type: 'integer', description: 'Its size.' },
      html: { type: ['string', 'null'], description: 'The report as one HTML document (as text).' },
    }),
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.as === 'text' ? 'Read the printable report' : 'Wrote the printable report as a file'),
    code: params => `history_report(${args(params, ['as', 'pictures', 'file'])})`,
  }),
  defineAction({
    type: 'history.tour.start',
    title: 'Start the guided tour',
    summary: 'Play the State panel\'s guided tour of the branch shown, from the opening to the step shown: each step is shown in turn with its caption and notes (a camera step is flown to), for a talk or a class. It returns once the tour plays; the person pauses, steps or stops it, or history_tour_stop does.',
    group: GROUP,
    params: NO_PARAMS,
    reads: [],
    effect: 'history',
    result: object(['tracker', 'branch', 'steps', 'returns_to'], {
      tracker: ID_NAME,
      branch: ID_NAME,
      steps: { type: 'integer', description: 'Steps the tour shows after the opening.' },
      returns_to: { type: 'string', description: 'The step shown again when the tour ends.' },
    }),
    describe: () => 'Started the guided tour',
    code: () => 'tour_start()',
  }),
  defineAction({
    type: 'history.tour.stop',
    title: 'Stop the guided tour',
    summary: 'Stop the guided tour, as its Stop button does: the history returns to the step shown before it began (unless the person made a step meanwhile).',
    group: GROUP,
    params: NO_PARAMS,
    reads: [],
    effect: 'history',
    result: object(['stopped', 'head'], {
      stopped: { type: 'boolean', description: 'False when no tour was playing.' },
      head: { type: ['string', 'null'], description: 'The step shown now.' },
    }),
    describe: () => 'Stopped the guided tour',
    code: () => 'tour_stop()',
  }),
]);

/**
 * What a `history.share` or `history.save` writes, from its parameters (the
 * catalogue's defaults applied): one rule for the panel, agents, Python and R.
 * A state names nobody and keeps no notes, conversations, Recently deleted or
 * times unless asked; steps only never hold results.
 *
 * @param {{content?: string, results?: string, notes?: boolean, chats?: boolean, journal?: boolean,
 *   times?: string, source?: string}} params
 * @returns {{content: string, results: string, notes: boolean, chats: boolean, journal: boolean, times: string, source: string}}
 */
export function shareScopeOf({ content = 'history', results = 'include', notes = true, chats = false, journal = false, times, source = 'full' }) {
  const state = content === 'state';
  return {
    content,
    results: content === 'steps' ? 'recompute' : results,
    notes: state ? false : notes,
    chats: state ? false : chats,
    journal: state ? false : journal,
    times: times ?? (state ? 'none' : 'exact'),
    source,
  };
}
