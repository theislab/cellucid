/**
 * @fileoverview The State panel's one seam to the history core: what it
 * reads of the history shown, and the one way it acts on it.
 *
 * **Reads.** The tracker in use (`history.active`) holds the records of
 * `app/history/model.js`: its steps, branches, groups and
 * turns by id, its notes and journal, the step shown (`headId`), the active
 * and main branches and the recording switch. {@link trackerView} wraps it in
 * the accessors the panel draws from (`step(id)`, `branch(id)`, …) and in the
 * facts derived from it once per change (the path shown, the branches each
 * step starts, the steps a branch owns), each computed lazily and only for
 * what is drawn. Collections may be kept as maps by id (the core's working
 * form) or as the model's lists in id order.
 *
 * The history's runtime state that is not a record is read through the
 * history object, each by one name (as the core, H1, provides them):
 * `pending()` ("Branch here" waiting for the next change, `{name, from}`),
 * `stale()` (the results stale at the step shown: `[{step, cause,
 * inputs}]`), `pausedChanges()` (while paused, what a move would ask about:
 * `{domains, remembered}`, or null) and `setPausedChoice(choice, {remember})`
 * (the Keep / Discard card's answer for the next move). A core that does not
 * keep one yet reads as none.
 *
 * **Acts.** Every operation the panel offers is a catalog action
 * (`app/actions/definitions/history.js`), dispatched as the person's
 * (origin `user`) through the page's dispatcher, the same path an agent, a
 * notebook and a replay take. The panel never calls a
 * history mutator.
 *
 * **Plans.** What a destructive operation would do is stated before it is
 * done, by the core's own dry runs, read from the history object:
 * `branchDeletePlan(branch, {withSubBranches})` (`{branches, steps,
 * first, last, results, kept_views, replays, absorbed_by, head}`),
 * `deletePlan(step)` (`{reapply, ms}`) and `turnUndoPlan(turn)`
 * (`{first, own, since, contiguous, otherBranches}`). Why a menu item
 * is not offered is pure, from the records and the history's own sentences:
 * {@link revertProblem}, {@link squashProblem} and
 * {@link groupRange}.
 *
 * @module ui/modules/state/history-source
 */

import { HISTORY_SENTENCES } from '../../../history/model.js';
import { plainSentence } from '../../../actions/targets/names.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/** An id-keyed collection read as a lookup (a map, or a list in id order). */
const LIST_INDEXES = new WeakMap();

function lookupOf(collection) {
  if (collection instanceof Map) return id => collection.get(id);
  if (!Array.isArray(collection)) return () => undefined;
  let index = LIST_INDEXES.get(collection);
  const last = collection.length === 0 ? null : collection[collection.length - 1].id;
  if (index === undefined || index.size !== collection.length || index.last !== last) {
    index = Object.assign(new Map(collection.map(record => [record.id, record])), { last });
    LIST_INDEXES.set(collection, index);
  }
  return id => index.get(id);
}

function valuesOf(collection) {
  if (collection instanceof Map) return [...collection.values()];
  return Array.isArray(collection) ? collection : [];
}

function sizeOf(collection) {
  if (collection instanceof Map) return collection.size;
  return Array.isArray(collection) ? collection.length : 0;
}

/**
 * The tracker in use as the panel reads it, or null before a dataset is
 * open. A new view per change of the history: the facts it derives are
 * computed at most once each, and only when asked.
 *
 * @param {object|null} history - the page's current history
 * @returns {TrackerView|null}
 */
export function trackerView(history) {
  const tracker = history?.active ?? null;
  return tracker === null ? null : createTrackerView(tracker, history);
}

/**
 * @typedef {ReturnType<typeof createTrackerView>} TrackerView
 */

/**
 * @param {object} tracker - a `Tracker` record (model.js)
 * @param {object|null} [history] - the history it is of (its runtime state)
 */
export function createTrackerView(tracker, history = null) {
  const step = lookupOf(tracker.steps);
  const branch = lookupOf(tracker.branches);
  const group = lookupOf(tracker.groups);
  const turn = lookupOf(tracker.turns);
  const cache = new Map();
  const once = (key, compute) => {
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  };

  const view = {
    tracker,
    id: tracker.id,
    name: tracker.name,
    headId: tracker.headId,
    rootId: tracker.rootId,
    activeBranch: tracker.activeBranch,
    mainBranch: tracker.mainBranch,
    /** The recording switch (`Tracker.paused`: null while it records). */
    recording: tracker.paused === null,
    pausedAt: tracker.paused?.at ?? null,
    step,
    branch,
    group,
    turn,
    /** The tracker's steps, the opening not counted (as everywhere in the panel). */
    get stepCount() { return Math.max(0, sizeOf(tracker.steps) - 1); },
    branches: () => valuesOf(tracker.branches),
    groups: () => valuesOf(tracker.groups),
    turns: () => valuesOf(tracker.turns),
    steps: () => valuesOf(tracker.steps),
    journal: () => valuesOf(tracker.journal),
    /** How many conversations are kept with the tracker (a map by conversation id, or the model's pairs). */
    get chatCount() { return sizeOf(tracker.chats); },
    notes: () => tracker.notes ?? [],

    /** "Branch here" waiting for the next change: `{name, from}`, or null. */
    pending: typeof history?.pending === 'function' ? history.pending() : null,

    /** The steps of the active branch's path, root first. */
    path: () => once('path', () => pathTo(view, view.branch(view.activeBranch)?.tip ?? view.headId)),
    /** Step id → its index on the path shown (root 0). */
    pathIndex: () => once('pathIndex', () => new Map(view.path().map((s, index) => [s.id, index]))),
    /** Branches by the step they fork from (archived ones too). */
    branchesFrom: stepId => once('branchesByBase', () => {
      const out = new Map();
      for (const each of view.branches()) {
        if (each.base === null) continue;
        const list = out.get(each.base);
        if (list === undefined) out.set(each.base, [each]);
        else list.push(each);
      }
      return out;
    }).get(stepId) ?? [],
    /** The steps of a branch, its first to its tip (walked back from the tip). */
    ownSteps: branchId => once(`own:${branchId}`, () => {
      const record = view.branch(branchId);
      if (record === undefined) return [];
      const out = [];
      for (let at = view.step(record.tip); at !== undefined && at.branch === branchId; at = at.parent === null ? undefined : view.step(at.parent)) {
        out.push(at);
      }
      return out.reverse();
    }),
    /** How many steps branch `branchId` has, the opening not counted (as everywhere in the panel). */
    branchStepCount: branchId => view.ownSteps(branchId).filter(step => step.parent !== null).length,
    /**
     * The results stale at the step shown: step id → `{cause, inputs,
     * causes}` (`cause`: the first step after it that changed an input, or
     * null; `inputs`: the domains, or `history`, that differ; `causes`: each
     * input's own cause).
     */
    stale: () => once('stale', () => {
      const read = typeof history?.stale === 'function' && view.tracker === history.active ? history.stale() : [];
      return new Map(read.map(entry => [entry.step.id, { cause: entry.cause ?? null, inputs: entry.inputs ?? [], causes: entry.causes ?? {} }]));
    }),
    /** While paused, what a move would ask about: `{domains, remembered}`, or null (nothing to ask). */
    pausedChanges: () => once('paused', () => {
      if (view.recording || typeof history?.pausedChanges !== 'function') return null;
      const read = history.pausedChanges();
      return read === null ? null : { domains: read.domains ?? [], remembered: read.remembered ?? null };
    }),
  };
  return view;
}

/** The steps from the root to `stepId`, root first. */
export function pathTo(view, stepId) {
  const out = [];
  for (let at = view.step(stepId); at !== undefined; at = at.parent === null ? undefined : view.step(at.parent)) out.push(at);
  return out.reverse();
}

/** Whether `stepId` can be undone or redone from the step shown. */
export function canUndo(view) {
  return view !== null && (view.step(view.headId)?.parent ?? null) !== null;
}

/** The step redo shows: the head's child on the path to the active branch's tip, or null. */
export function redoTarget(view) {
  if (view === null) return null;
  const index = view.pathIndex().get(view.headId);
  if (index === undefined) return null;
  return view.path()[index + 1]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Acting: catalog actions as the person's.

/**
 * The one way the panel acts: a history action dispatched as the person's.
 *
 * @param {(type: string, params: object, meta?: object) => Promise<{outcome: unknown}>} dispatch -
 *   the page's dispatcher (`getActions().dispatch`)
 */
export function createHistoryActions(dispatch) {
  if (typeof dispatch !== 'function') throw new TypeError('The State panel acts through the action dispatcher.');
  return Object.freeze({
    /**
     * @param {string} type - `history.*`
     * @param {object} [params]
     * @param {{signal?: AbortSignal|null}} [how] - What stops it besides the person (the action a
     *   report's picture steps are made for: its Stop ends the jump under way)
     * @returns {Promise<unknown>} the action's outcome
     */
    async act(type, params = {}, { signal = null } = {}) {
      if (!type.startsWith('history.')) throw new RangeError(`The State panel acts only through history actions, not "${type}"`);
      const { outcome } = await dispatch(type, params, signal === null ? { origin: 'user' } : { origin: 'user', signal });
      return outcome;
    },
  });
}

// ---------------------------------------------------------------------------
// Plans: what an operation would do, in words, before it is done.

/**
 * Why a step cannot be reverted as a new step, or null: a later
 * step on the path to the step shown changed one of its parts too.
 *
 * @param {TrackerView} view
 * @param {string} stepId
 * @param {(domain: string) => string} domainName
 */
export function revertProblem(view, stepId, domainName) {
  const target = view.step(stepId);
  if (target === undefined || target.parent === null) return 'The opening of a history has nothing to revert.';
  if (target.status === 'unapplicable' || target.touches.length === 0) return 'This step changes nothing to revert.';
  const path = pathTo(view, view.headId);
  const at = path.findIndex(each => each.id === stepId);
  if (at === -1) return 'Show a step after this one to revert it.';
  const touched = new Set(target.touches);
  const later = new Set();
  for (const each of path.slice(at + 1)) for (const domain of each.touches) if (touched.has(domain)) later.add(domain);
  if (later.size === 0) return null;
  return plainSentence(HISTORY_SENTENCES.notRevertible({ domains: target.touches.filter(domain => later.has(domain)).map(domainName) }));
}

/**
 * Consecutive steps of one branch, `from` to `to` (inclusive), as a list, or
 * a problem: the steps a group or a squash takes.
 *
 * @param {TrackerView} view
 * @param {string} from
 * @param {string} to
 * @returns {{steps: object[], problem: string|null}}
 */
export function stepRun(view, from, to) {
  const first = view.step(from);
  const last = view.step(to);
  if (first === undefined || last === undefined || first.parent === null) {
    return { steps: [], problem: 'The opening of a history is not grouped or merged.' };
  }
  const steps = [];
  for (let at = last; at !== undefined; at = at.parent === null ? undefined : view.step(at.parent)) {
    steps.push(at);
    if (at.id === from) break;
    if (at.branch !== first.branch || at.parent === null) return { steps: [], problem: plainSentence(HISTORY_SENTENCES.notConsecutive({ from, to })) };
  }
  if (steps[steps.length - 1]?.id !== from || last.branch !== first.branch) {
    return { steps: [], problem: plainSentence(HISTORY_SENTENCES.notConsecutive({ from, to })) };
  }
  return { steps: steps.reverse(), problem: null };
}

/**
 * The steps a group of `from`..`to` takes: widened to whole turns,
 * with the sentence that says so, or the reason it cannot be made.
 *
 * @param {TrackerView} view
 * @param {string} from
 * @param {string} to
 * @returns {{from: string, to: string, steps: object[], widened: string|null, problem: string|null}}
 */
export function groupRange(view, from, to) {
  let run = stepRun(view, from, to);
  if (run.problem !== null) return { from, to, steps: [], widened: null, problem: run.problem };
  let first = run.steps[0];
  let last = run.steps[run.steps.length - 1];
  // Whole turns: the turn of the first step back to its start, of the last to its end.
  const turnOf = each => each.by?.turn ?? null;
  const branchId = first.branch;
  let widened = null;
  const firstTurn = turnOf(first);
  if (firstTurn !== null) {
    for (let at = view.step(first.parent); at !== undefined && at.branch === branchId && turnOf(at) === firstTurn; at = view.step(at.parent)) first = at;
  }
  const lastTurn = turnOf(last);
  if (lastTurn !== null) {
    const own = view.ownSteps(branchId);
    for (let index = own.findIndex(each => each.id === last.id) + 1; index < own.length && turnOf(own[index]) === lastTurn; index++) last = own[index];
  }
  if (first.id !== from || last.id !== to) {
    const record = view.turn(first.id !== from ? firstTurn : lastTurn);
    widened = plainSentence(HISTORY_SENTENCES.splitsTurn({ label: record?.label ?? 'turn', from: first.id, to: last.id }));
    run = stepRun(view, first.id, last.id);
  }
  const grouped = run.steps.find(each => each.group !== null && each.group !== undefined);
  if (grouped !== undefined) {
    return {
      from: first.id, to: last.id, steps: [], widened,
      problem: plainSentence(HISTORY_SENTENCES.inGroup({ step: grouped.id, name: view.group(grouped.group)?.name ?? grouped.group })),
    };
  }
  return { from: first.id, to: last.id, steps: run.steps, widened, problem: null };
}

/**
 * Why `from`..`to` cannot be squashed into one step, or null: a
 * branch starts inside the run (anywhere but its last step).
 *
 * @param {TrackerView} view
 * @param {string} from
 * @param {string} to
 */
/**
 * The group a step can be added to (`history.group.extend`): the nearest
 * group before it on its own branch, with nothing grouped between, so the
 * group grows to it taking in every step between. Null when the step is
 * grouped itself, or no group comes before it on its branch.
 *
 * @param {TrackerView} view
 * @param {string} to - the step the group would end at
 * @returns {{group: object, steps: number}|null} - `steps`: how many it takes in
 */
export function extendableGroup(view, to) {
  const step = view.step(to);
  if (step === undefined || step.parent === null || (step.group ?? null) !== null) return null;
  let steps = 1;
  for (let at = view.step(step.parent); at !== undefined && at.branch === step.branch; at = at.parent === null ? undefined : view.step(at.parent)) {
    if ((at.group ?? null) !== null) {
      const group = view.group(at.group);
      return group === undefined ? null : { group, steps };
    }
    steps += 1;
  }
  return null;
}

export function squashProblem(view, from, to) {
  const run = stepRun(view, from, to);
  if (run.problem !== null) return run.problem;
  if (run.steps.length < 2) return 'Choose two or more consecutive steps to merge.';
  const inside = run.steps.slice(0, -1).flatMap(each => view.branchesFrom(each.id));
  if (inside.length === 0) return null;
  const firstFork = run.steps.findIndex(each => view.branchesFrom(each.id).length > 0);
  const upTo = firstFork >= 1 ? run.steps[firstFork].id : null;
  return plainSentence(HISTORY_SENTENCES.forksInside({ names: inside.map(each => each.name), upTo }));
}

/** "5 steps, from “Hid gamma” to “Colored by score”" for a list of steps. */
export function stepSpan(steps) {
  if (steps.length === 0) return 'No steps';
  if (steps.length === 1) return `1 step, “${steps[0].label}”`;
  return `${formatCountOf(steps.length, 'step')}, from “${steps[0].label}” to “${steps[steps.length - 1].label}”`;
}

/** The same for a count and its first and last steps (a dry run's words). */
export function spanOf(view, count, first, last) {
  const label = id => view.step(id)?.label ?? id;
  if (count === 0) return 'No steps';
  if (count === 1) return `1 step, “${label(first)}”`;
  return `${formatCountOf(count, 'step')}, from “${label(first)}” to “${label(last)}”`;
}
