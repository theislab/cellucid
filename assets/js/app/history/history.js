/**
 * @fileoverview The action history of the open dataset (History v2): its
 * trackers, each a tree of steps with branches, groups, turns, notes,
 * bookmarks and a journal of its own edits; the recorder the dispatcher
 * tells of every action; every move (undo, redo, jump, switch); every edit
 * (journaled, undoable from Recently deleted); replays; and the history's
 * own catalogue actions (`definitions/history.js`), the one path the State
 * panel, agents, Python and R take.
 *
 * **Recording.** Before an action the touched domains' values are captured
 * (a change made outside an action is kept first as its own step), after it
 * again; one step is added when anything changed, on the branch the head is
 * on (`branches.js` `branchForNewStep`: a new branch when the head is not
 * its branch's tip, the branch is locked or "Branch here" is pending). A
 * step records who acted (`By`, the dispatch's meta), how long, its
 * parameters' version (`v`), its pseudocode line, and the hash of each input
 * its action reads (`provenance.js`). An agent's or a notebook's turn is a
 * record of its own (`turns.js`); an agent whose branch the person left
 * mid-turn is refused (`moved`).
 *
 * **Paused** (`Tracker.paused`, §3.15.1): changes apply and make no step;
 * the draft of what differs from the head is kept on the tracker (the
 * autosave keeps it); resuming adds one squashed step for it. A move while
 * paused with changes keeps them as one step first or discards them, as
 * `setPausedChoice` says (keep when nothing was said: work is never lost
 * silently).
 *
 * **Detail switches** (§3.15.5, `offDomains()`): a domain switched off
 * (camera, layout) is not recorded (its change makes no step and is never a
 * change "outside the history"), is not moved by the history (a move leaves
 * it as it is), and is still captured (a step made while it is off holds its
 * value where it differs from the head's).
 *
 * **Moves** cost the steps between the two steps and the domains restored
 * (`tree.js` `valuesFrom`); the head's values are kept current. A move holds
 * the dispatcher's gate and waits for the actions running (`exclusive`).
 *
 * **Edits** (`journal.js`) record the exact records they replaced and made;
 * a restore puts them back exactly, or as new objects when later edits
 * changed what they made (a deleted step or branch is applied again by name
 * on its nearest surviving step). Deleting a step applies again only the
 * steps below it that changed or read what it changed (§3.3.4), with Cancel.
 *
 * Subscribers hear `{kind, tracker, ...}`: `step` (`steps`: records
 * written), `moved` (`head`), `edited` (`op`, `journal`, `steps`, `removed`),
 * `tracker`, `loaded`, `replayed` (`report`), `recording` (`on`), `chat`.
 *
 * @module app/history/history
 */

import { DOMAIN_IDS, REREADING_DOMAINS, domainName, withDerivedDomains } from '../actions/domains.js';
import { ActionRefused } from '../actions/dispatcher.js';
import { ParamsNotUpgradable, outsideActOf, upgradeParams } from '../actions/catalog.js';
import { throwIfAborted } from '../../utils/abort.js';
import { formatCountOf } from '../../utils/format-units.js';
import {
  createBy, createStep, HISTORY_ID_PATTERNS, HISTORY_SENTENCES, idNumber, idOf, nameKey, OUTSIDE_CHANGE_TYPE,
  sameBy, squashedLabel, suffixedName, validateHistory,
} from './model.js';
import {
  branchOf, commonAncestor, insertStep, isOnPath, liveTracker, newTracker, orderedDomains, redoTarget,
  referencedHashes, stepHashes, stepOf, trackerRecord, valuesAt, valuesFrom,
} from './tree.js';
import { activeBranchAt, branchForNewStep, branchNamed, checkedName, placeStep, planBranchDelete, stepNamed } from './branches.js';
import { beginEdit, commitEdit, rollbackEdit } from './journal.js';
import { bindingRefusal, byOfMeta, noteTurnOutside, noteTurnStep, turnUndoPlan } from './turns.js';
import { readsOf, staleOnPath } from './provenance.js';
import { searchSteps } from './search.js';
import { createValuePool, hashValue } from './value-pool.js';
import { createDeleteRestore } from './delete-restore.js';
import { createHistoryActions } from './actions.js';
import { isReplayable, mapParams, namesCells, replayPlanOf, stepParamsIn } from './replay.js';
import { quoteName } from '../actions/targets/names.js';

function unknownDomainsMessage(ids) {
  return `This history holds state this version of Cellucid does not have (${ids.map(id => `"${id}"`).join(', ')}). `
    + 'Open it in the version of Cellucid it was saved with.';
}

/** Keep only what a timeline needs of an outcome (counts, names), never arrays of cells. */
function summarizeOutcome(outcome) {
  if (outcome === null || outcome === undefined || typeof outcome !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(outcome)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

const refuse = (message, code, type = null) => new ActionRefused(message, { code, type });

/** The `By` of the history's own steps for a change made outside an action. */
const OUTSIDE_BY = Object.freeze({ origin: 'outside', agent: null, model: null, host: null, person: null, turn: null });

/** A move's choice while paused with changes: keep them as one step first, or discard them. */
export const PAUSED_CHOICES = Object.freeze(['keep', 'discard']);

/** Run `fn` in a task of its own, after the one running now (a message to itself, never a timer). */
function runInNextTask(fn) {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    fn();
  };
  channel.port2.postMessage(null);
}

/**
 * @param {{
 *   dispatcher: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   domains: ReturnType<typeof import('../actions/domains.js').createDomainRegistry>,
 *   dataset: {id: string|null, name: string|null, cellOrder: object|null},
 *   newTrackerId: () => string,
 *   now?: () => number,
 *   pool?: ReturnType<typeof createValuePool>,
 *   offDomains?: () => string[],
 *   recordNewTrackers?: () => boolean,
 *   person?: () => (string|null),
 *   openSaved?: ((id: string) => Promise<object>)|null,
 * }} options - `offDomains`: the domains History settings switched off (camera, layout); `recordNewTrackers`:
 *   Settings › Record history for new datasets; `person`: the name the person chose to record, or null;
 *   `openSaved`: the source of a saved state of this browser (`autosave.js` `openSavedState`), for `history.replay`;
 *   `nextTask`: run a function in the page's next task (what tells one gesture's events, fired in one
 *   task, from the next gesture's; a test passes its own to step tasks by hand)
 */
export function createHistory({
  dispatcher, domains, dataset, newTrackerId, now = () => Date.now(), pool = createValuePool(),
  offDomains = () => [], recordNewTrackers = () => true, person = () => null, openSaved = null,
  nextTask = runInNextTask,
}) {
  if (typeof newTrackerId !== 'function') throw new TypeError('The history needs newTrackerId()');
  const catalog = dispatcher.catalog;
  /** Every tracker, removed ones (in Recently deleted) included, in the order they started. */
  const trackers = new Map();
  let active = null;
  /** The value hash of every domain as shown now. */
  let shown = {};
  /** The value hash of every domain at the active tracker's head (kept current). */
  let headValues = {};
  /** "Branch here": the name the next step's new branch takes, from the step shown. */
  let pending = null;
  /**
   * The step the next change of its kind may merge into: the one just
   * recorded in this live sequence, never a step reached by a move (a tip
   * jumped to keeps what it recorded). Any other event ends it.
   */
  let coalesceStep = null;
  /** Trackers by recency of use (the one shown first after removing the one in use). */
  let usedOrder = [];
  /** What a move while paused with changes does: one move's choice, or the paused period's. */
  let pausedChoice = { next: null, remembered: null };
  let exclusiveTail = Promise.resolve();
  /** Whether an exclusive task runs now, and its end (an observed change waits for it). */
  let exclusiveBusy = false;
  let exclusiveDone = Promise.resolve();
  let restoringDepth = 0;
  let observedTail = Promise.resolve();
  const pendingObserved = new Set();
  /** The person's moves so far, and the count each turn last saw (`carryTurn`, `bindingRefusal`). */
  let personMoves = 0;
  const turnSeen = new Map();
  /** The observed changes not yet recorded, with the domains each touches and its task (`recordObservedNow`). */
  const observedChanges = new Set();
  /** The page's task the changes observed now are in: counted up when a task that observed one ends. */
  let taskCount = 0;
  let taskEnding = false;
  function observedTask() {
    if (!taskEnding) {
      taskEnding = true;
      nextTask(() => { taskCount++; taskEnding = false; });
    }
    return taskCount;
  }
  /**
   * Values a capture added to the pool that no record holds yet: only what is
   * shown, the head's values or the paused draft of the tracker in use name
   * them. Each goes from the pool once none of those does (`sweep`), or stays
   * once a record takes it (`claim`). §3.5: an action that changed nothing,
   * a cancelled one and a paused change keep nothing.
   */
  const transient = new Set();
  /**
   * The values the step being merged into (a camera gesture, a slider drag)
   * made and only its after-values hold: one a later merge replaces goes from
   * the pool, so a gesture of 200 changes keeps one value.
   */
  let gesture = { step: null, owned: new Set() };
  const listeners = new Set();
  let destroyed = false;
  /** Stops keeping what turns do outside the state (set once the history listens). */
  let stopOutside = () => {};

  function notify(kind, detail = {}) {
    for (const listener of [...listeners]) {
      try { listener({ kind, ...detail }); } catch (error) { console.error('[history] listener failed', error); }
    }
  }

  function off() {
    const ids = offDomains();
    return Array.isArray(ids) ? ids.filter(id => DOMAIN_IDS.includes(id)) : [];
  }

  function requireActive() {
    if (active === null) throw new Error('The history has no tracker yet');
    return active;
  }

  function liveTrackers() {
    return [...trackers.values()].filter(tracker => tracker.removed === null);
  }

  async function capture(ids) {
    const hashes = {};
    for (const id of orderedDomains(ids)) {
      const value = await domains.owner(id).capture();
      const { hash, added } = await pool.putNew(value);
      if (added) transient.add(hash);
      hashes[id] = hash;
    }
    return hashes;
  }

  /** A record holds these hashes now: they stay in the pool until a prune finds nothing refers to them. */
  function claim(hashes) {
    if (transient.size === 0) return;
    for (const hash of hashes) transient.delete(hash);
  }

  /** `${domain}\0${hash}` → the hash of the value's canonical form (its owner's `canonical`), computed once. */
  const canonicalHashes = new Map();

  /**
   * The hash of a value's canonical form: its generated ids renamed and its
   * times dropped by its domain's owner (`domains.js`), or the hash itself
   * for a domain whose values have none. Verify and a delete's "did this
   * input change" compare these; a restore puts back the value itself.
   */
  async function canonicalOf(domain, hash) {
    if (hash === undefined || !domains.has(domain)) return hash;
    const owner = domains.owner(domain);
    if (typeof owner.canonical !== 'function') return hash;
    const key = `${domain}\u0000${hash}`;
    let out = canonicalHashes.get(key);
    if (out === undefined) {
      out = await hashValue(owner.canonical(pool.get(hash)));
      canonicalHashes.set(key, out);
    }
    return out;
  }

  /** Whether two values of a domain are the same but for generated ids and times. */
  async function sameCanonical(domain, a, b) {
    return a === b || (await canonicalOf(domain, a)) === (await canonicalOf(domain, b));
  }

  /** Every hash a step record names. */
  function hashesOfStep(step) {
    return [...Object.values(step.before), ...Object.values(step.after), ...Object.entries(step.reads).filter(([key]) => key !== 'history').map(([, hash]) => hash)];
  }

  /** Drop the values a capture made that nothing holds any more (shown, the head, the paused draft in use). */
  function sweep() {
    if (transient.size === 0) return;
    // The paused draft is what is shown against the head: kept current before it is read.
    if (active !== null && active.paused !== null) notePaused(active);
    const held = new Set([...Object.values(shown), ...Object.values(headValues), ...Object.values(active?.paused?.draft ?? {})]);
    for (const hash of [...transient]) {
      if (held.has(hash)) continue;
      transient.delete(hash);
      pool.release(hash);
    }
  }

  // -------------------------------------------------------------------------
  // Showing values

  /**
   * Put back `target` (domain → hash), in domain order, for each domain whose
   * value differs from what is shown when its turn comes; what is shown is
   * captured again after each (after a domain whose restore reads the dataset
   * again, every domain is).
   */
  async function putBack(target, signal) {
    for (const id of orderedDomains(Object.keys(target))) {
      if (shown[id] === target[id]) continue;
      if (destroyed) throw new Error('The dataset was replaced; its history no longer applies');
      throwIfAborted(signal);
      try {
        await domains.owner(id).restore(pool.get(target[id]), { signal });
      } catch (error) {
        if (!destroyed) {
          try { shown = { ...shown, ...await capture([id]) }; } catch { /* the restore's own failure is reported */ }
        }
        throw error;
      }
      // Captured again: the domain, the domains that follow it, or every domain after one that reads the dataset again.
      shown = { ...shown, ...await capture(REREADING_DOMAINS.includes(id) ? DOMAIN_IDS : withDerivedDomains([id])) };
    }
  }

  /** Put back `target`; on a failure what was shown comes back. */
  async function restoreTo(target, { signal = null } = {}) {
    const from = { ...shown };
    restoringDepth++;
    try {
      await putBack(target, signal);
    } catch (error) {
      if (!destroyed) {
        try { await putBack(from, null); } catch (rollbackError) { error.rollbackError = rollbackError; }
      }
      throw error;
    } finally {
      restoringDepth--;
    }
  }

  /** `values` with the domains switched off left as they are shown (a move never moves them). */
  function withoutOff(values) {
    const out = { ...values };
    for (const id of off()) if (shown[id] !== undefined) out[id] = shown[id];
    return out;
  }

  /**
   * Run `task` alone: actions wait at the gate, and the ones running finish
   * first. Not reentrant: code inside a task calls the inner functions
   * (`requireExclusive`), never `exclusive` again (it would wait for itself).
   * A change observed while a task runs is recorded after it, against what is
   * shown then (`recordObservedNow`).
   */
  function exclusive(task) {
    const run = exclusiveTail.then(async () => {
      // A gesture still settling (a camera drag recorded at its settle) is
      // ended now and recorded first, and a change waiting for the work it set
      // off is recorded first: a move never starts before the change it would
      // move away from is a step.
      await dispatcher.settle();
      await dispatcher.idle();
      for (;;) {
        const tail = observedTail;
        await Promise.all([tail, ...pendingObserved]);
        if (tail === observedTail && pendingObserved.size === 0) break;
      }
      exclusiveBusy = true;
      // Every value it holds stays readable while it runs (a rollback puts back what was shown).
      const unhold = pool.hold();
      let release;
      exclusiveDone = new Promise(resolve => { release = resolve; });
      try {
        return await task();
      } finally {
        exclusiveBusy = false;
        sweep();
        unhold();
        release();
      }
    });
    exclusiveTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Inner operations (moves, edits) run only inside `exclusive`. */
  function requireExclusive(what) {
    if (!exclusiveBusy) throw new Error(`${what} runs only inside an exclusive operation of the history`);
  }

  /** Move the active tracker's head to `stepId` and show it (inside an exclusive operation). */
  async function show(tracker, stepId, { signal = null } = {}) {
    stepOf(tracker, stepId);
    const target = tracker === active ? valuesFrom(tracker, tracker.headId, headValues, stepId) : valuesAt(tracker, stepId);
    await restoreTo(withoutOff(target), { signal });
    tracker.headId = stepId;
    tracker.activeBranch = activeBranchAt(tracker, stepId);
    if (tracker === active) headValues = target;
    pending = null;
    coalesceStep = null;
    notify('moved', { tracker: tracker.id, head: stepId, branch: tracker.activeBranch });
  }

  // -------------------------------------------------------------------------
  // Paused

  /** The domains (and their hashes as shown) that differ from the head while paused. */
  function pausedDraft(tracker = active) {
    if (tracker === null || tracker !== active) return tracker?.paused?.draft ?? null;
    const offIds = new Set(off());
    const draft = {};
    for (const id of DOMAIN_IDS) {
      if (offIds.has(id)) continue;
      if (shown[id] !== undefined && shown[id] !== headValues[id]) draft[id] = shown[id];
    }
    return Object.keys(draft).length === 0 ? null : draft;
  }

  /** The paused draft laid over `target` when the head's values change under it: its domains stay as shown. */
  function pausedDraftAt(tracker, target) {
    if (tracker.paused === null) return null;
    const draft = {};
    for (const id of DOMAIN_IDS) if (shown[id] !== undefined && shown[id] !== target[id] && tracker.paused.draft?.[id] !== undefined) draft[id] = shown[id];
    return draft;
  }

  /** Keep the paused draft current on the tracker (what the autosave keeps), and who acted. */
  function notePaused(tracker, by = null) {
    if (tracker.paused === null) return;
    const draft = pausedDraft(tracker);
    const authors = tracker.paused.by;
    const changedAuthors = by !== null && !authors.some(other => sameBy(other, by));
    if (changedAuthors) authors.push({ ...by });
    if (JSON.stringify(draft) !== JSON.stringify(tracker.paused.draft) || changedAuthors) {
      tracker.paused.draft = draft;
      notify('recording', { tracker: tracker.id, on: false, draft: draft !== null });
    }
  }

  /**
   * Keep what changed while paused as one squashed step (cause `paused`) at
   * the head, by `by`. Returns the step, or null when nothing differs.
   */
  function squashPaused(tracker, by) {
    // The tracker in use: what is shown differs from its head; another: the draft its record keeps.
    const base = tracker === active ? headValues : valuesAt(tracker, tracker.headId);
    const kept = tracker === active ? pausedDraft(tracker) : tracker.paused.draft;
    const draft = kept === null ? {} : Object.fromEntries(Object.entries(kept).filter(([id, hash]) => base[id] !== hash));
    if (Object.keys(draft).length === 0) {
      tracker.paused.draft = null;
      return null;
    }
    const touches = orderedDomains(Object.keys(draft));
    const authors = tracker.paused.by.length > 0 ? tracker.paused.by.map(each => ({ ...each })) : [{ ...by }];
    const step = appendRecord(tracker, {
      kind: 'squashed', by, at: tracker.paused.at ?? now(), until: now(), touches,
      before: Object.fromEntries(touches.map(id => [id, base[id]])),
      after: Object.fromEntries(touches.map(id => [id, draft[id]])),
      squashed: { cause: 'paused', count: null, by: authors, carried: { notes: [], bookmarks: [] } },
      label: null,
    }, { turnLabel: null });
    tracker.paused.draft = null;
    tracker.paused.by = [{ ...by }];
    tracker.paused.at = now();
    return step;
  }

  /** Before a move while paused: keep the changes as one step (returned), or let the move discard them (null). */
  function settleBeforeMove(tracker, by) {
    if (tracker !== active || tracker.paused === null || pausedDraft(tracker) === null) return null;
    const choice = pausedChoice.next ?? pausedChoice.remembered ?? 'keep';
    pausedChoice.next = null;
    if (choice === 'keep') return squashPaused(tracker, by);
    // Discarded: the draft goes with the move, so leaving the tracker and coming back never brings it back.
    tracker.paused.draft = null;
    notify('recording', { tracker: tracker.id, on: false, draft: false });
    return null;
  }

  // -------------------------------------------------------------------------
  // Recording

  function coalesceKeyOf(definition, params) {
    return definition.coalesce === null ? null : `${definition.type}:${definition.coalesce(params)}`;
  }

  function codeOf(definition, params) {
    try { return definition.code(params); } catch { return null; }
  }

  /**
   * Add a step at the head of `tracker` from its facts: on the head's branch
   * or a new one (`branchForNewStep`), its turn kept (`turns.js`). The
   * squashed and outside kinds name their facts; an action's come from its
   * definition. Returns the step.
   */
  function appendRecord(tracker, fields, meta) {
    const id = idOf('step', tracker.nextStep);
    // A squashed step says what it stands for unless it keeps the label it was recorded with (a replay's).
    const domainLabel = fields.label ?? (fields.kind === 'squashed' ? squashedText(fields.squashed, fields.touches) : fields.type);
    const mine = tracker === active;
    const where = branchForNewStep(tracker, { pending: mine ? pending : null, by: fields.by, label: domainLabel, at: fields.at, stepId: id });
    const step = createStep({
      id, parent: tracker.headId, branch: where.branch, kind: fields.kind ?? 'action', type: fields.type ?? null,
      params: fields.params ?? null, v: fields.v ?? null, code: fields.code ?? null, label: domainLabel,
      by: fields.by, at: fields.at, until: fields.until ?? fields.at, merged: fields.merged ?? 1, ms: fields.ms ?? null,
      touches: fields.touches, before: fields.before, after: fields.after, reads: fields.reads ?? {},
      outcome: fields.outcome ?? null, coalesceKey: fields.coalesceKey ?? null, replayOf: fields.replayOf ?? null,
      squashed: fields.squashed ?? null, group: null,
    });
    // A turn going on right after its own steps in a group stays in that group (a group holds whole turns).
    const parentStep = stepOf(tracker, tracker.headId);
    if (step.by.turn !== null && parentStep.group !== null && parentStep.by.turn === step.by.turn && parentStep.branch === step.branch) {
      step.group = parentStep.group;
    }
    insertStep(tracker, step);
    tracker.nextStep = idNumber(id) + 1;
    // The step holds its values now; a gesture's first after-values are its own (a merge may replace them).
    const owned = new Set();
    if (mine && step.coalesceKey !== null) for (const hash of Object.values(step.after)) if (transient.has(hash)) owned.add(hash);
    claim(hashesOfStep(step));
    if (mine) gesture = { step: step.coalesceKey === null ? null : step.id, owned };
    placeStep(tracker, where, step);
    if (noteTurnStep(tracker, step, meta) !== null) turnSeen.set(step.by.turn, personMoves);
    if (mine) {
      headValues = { ...headValues, ...step.after };
      pending = null;
      coalesceStep = step.coalesceKey !== null ? step.id : null;
    }
    notify('step', { tracker: tracker.id, step: id, steps: [id, step.parent], branch: step.branch, sentence: where.sentence });
    return step;
  }

  function squashedText(squashed, touches) {
    return squashedLabelOf(squashed.cause, squashed.count, touches);
  }

  /**
   * A capture that disagrees with what the history shows (a domain not
   * switched off): a change made outside the actions, kept as its own step
   * and warned about. While paused it is part of the draft instead.
   */
  function healOutsideChange(tracker, captured) {
    const offIds = new Set(off());
    const drifted = orderedDomains(Object.keys(captured).filter(id => !offIds.has(id) && shown[id] !== captured[id]));
    if (drifted.length === 0) {
      shown = { ...shown, ...captured };
      return;
    }
    shown = { ...shown, ...captured };
    if (tracker.paused !== null) {
      notePaused(tracker);
      return;
    }
    const at = now();
    appendRecord(tracker, {
      kind: 'outside', type: OUTSIDE_CHANGE_TYPE, params: { domains: drifted }, by: { ...OUTSIDE_BY }, at,
      label: 'Changed outside the history', touches: drifted,
      before: Object.fromEntries(drifted.map(id => [id, headValues[id]])),
      after: Object.fromEntries(drifted.map(id => [id, captured[id]])),
    }, {});
    console.warn(`[history] ${drifted.join(', ')} changed outside an action; kept as its own step`);
  }

  /**
   * The step an action makes from what it changed, or null: nothing changed
   * but domains switched off (they never make a step), or nothing at all. A
   * domain switched off is still captured: where it differs from the head it
   * is kept in the step.
   */
  /** Whether `step` left the domains of `ids` it touches as they are shown now (it touches at least one). */
  function holdsShown(step, ids) {
    const held = ids.filter(id => id in step.after);
    return held.length > 0 && held.every(id => step.after[id] === shown[id]);
  }

  async function recordAction(tracker, { definition, params, meta, after, outcome, reads, startedAt, observed = false }) {
    const offIds = new Set(off());
    shown = { ...shown, ...after };
    const by = byOfMeta(meta, person());
    if (tracker.paused !== null) {
      notePaused(tracker, by);
      return null;
    }
    const changed = orderedDomains(Object.keys(after).filter(id => after[id] !== headValues[id]));
    if (!changed.some(id => !offIds.has(id))) {
      // An observed change that finds nothing new but would merge into the step just recorded, which shows
      // what it says: that step takes its parameters (a record read late held its value already), so a
      // step never shows one value and names another.
      const head = stepOf(tracker, tracker.headId);
      const key = coalesceKeyOf(definition, params);
      if (observed && key !== null && coalesceStep === head.id && head.coalesceKey === key && head.kind === 'action'
        && sameBy(head.by, byOfMeta(meta, person())) && holdsShown(head, definition.touches)) {
        const at = now();
        head.params = params;
        head.code = codeOf(definition, params);
        head.label = definition.describe(params, outcome);
        head.outcome = summarizeOutcome(outcome) ?? head.outcome;
        head.until = at;
        head.merged += 1;
        notify('step', { tracker: tracker.id, step: head.id, steps: [head.id], branch: head.branch });
        return head;
      }
      return null;
    }
    let offNow = {};
    if (offIds.size > 0) {
      offNow = await capture([...offIds]);
      shown = { ...shown, ...offNow };
    }
    const touches = orderedDomains([...new Set([
      ...changed, ...Object.keys(offNow).filter(id => offNow[id] !== headValues[id]),
    ])]);
    const values = { ...after, ...offNow };
    const at = now();
    const fields = {
      kind: 'action', type: definition.type, params, v: definition.version, code: codeOf(definition, params),
      label: definition.describe(params, outcome), by, at, until: at, ms: Math.max(0, at - startedAt), touches,
      before: Object.fromEntries(touches.map(id => [id, headValues[id]])),
      after: Object.fromEntries(touches.map(id => [id, values[id]])),
      reads, outcome: summarizeOutcome(outcome), coalesceKey: coalesceKeyOf(definition, params),
      replayOf: meta.replayOf ?? null,
    };
    const head = stepOf(tracker, tracker.headId);
    const branch = branchOf(tracker, tracker.activeBranch);
    if (fields.coalesceKey !== null && coalesceStep === head.id && head.coalesceKey === fields.coalesceKey && head.children.length === 0
      && sameBy(head.by, by) && head.notes.length === 0 && head.bookmark === null && head.branch === branch.id
      && branch.tip === head.id && !branch.locked && pending === null && head.kind === 'action') {
      return amendHead(tracker, head, fields);
    }
    return appendRecord(tracker, fields, meta);
  }

  /** Merge a change into the head step (a slider drag, one camera gesture): it keeps its start and counts the change. */
  function amendHead(tracker, head, fields) {
    const owned = gesture.step === head.id ? gesture.owned : null;
    const replaced = Object.values(head.after);
    if (owned !== null) for (const hash of Object.values(fields.after)) if (transient.has(hash)) owned.add(hash);
    for (const id of fields.touches) {
      if (!head.touches.includes(id)) {
        head.touches.push(id);
        head.before[id] = fields.before[id];
      }
      head.after[id] = fields.after[id];
    }
    head.touches = orderedDomains(head.touches);
    // A domain the merged changes put back where it was before them is no longer changed.
    for (const id of [...head.touches]) {
      if (head.before[id] === head.after[id]) {
        head.touches = head.touches.filter(other => other !== id);
        delete head.before[id];
        delete head.after[id];
      }
    }
    head.params = fields.params;
    head.code = fields.code;
    head.label = fields.label;
    head.until = fields.until;
    head.merged += 1;
    head.ms = head.ms === null ? fields.ms : head.ms + fields.ms;
    head.outcome = fields.outcome ?? head.outcome;
    head.reads = fields.reads;
    if (tracker === active) headValues = { ...headValues, ...fields.after };
    claim(hashesOfStep(head));
    if (owned !== null) {
      // The values of the gesture this merge replaced, which nothing else holds, go.
      const still = new Set([...Object.values(head.before), ...Object.values(head.after), ...Object.values(shown), ...Object.values(headValues)]);
      for (const hash of replaced) {
        if (!owned.has(hash) || still.has(hash)) continue;
        owned.delete(hash);
        pool.release(hash);
      }
    }
    const turn = head.by.turn === null ? null : tracker.turns.get(head.by.turn);
    if (turn) turn.endedAt = head.until;
    notify('step', { tracker: tracker.id, step: head.id, steps: [head.id], branch: head.branch });
    return head;
  }

  /** Write a re-applied action into the step it re-applies (a deleted step's dependants). */
  function rewrite(tracker, stepId, { definition, params, before, after, outcome, reads, startedAt }) {
    const step = stepOf(tracker, stepId);
    const touches = orderedDomains(Object.keys(after).filter(id => after[id] !== before[id]));
    step.touches = touches;
    step.before = Object.fromEntries(touches.map(id => [id, before[id]]));
    step.after = Object.fromEntries(touches.map(id => [id, after[id]]));
    step.reads = reads;
    step.label = definition.describe(params, outcome);
    step.params = params;
    step.v = definition.version;
    step.code = codeOf(definition, params);
    step.outcome = summarizeOutcome(outcome);
    step.ms = Math.max(0, now() - startedAt);
    step.status = 'applied';
    step.reason = touches.length === 0 ? 'No longer changes anything' : null;
    shown = { ...shown, ...after };
    claim(hashesOfStep(step));
    return step;
  }

  /** The branch tip a kept view of a branch reads (`reads.history`), or null. */
  function branchTipRead(tracker, params) {
    if (typeof params?.branch !== 'string') return null;
    try {
      const branch = branchNamed(tracker, params.branch);
      return { tracker: tracker.id, branch: branch.id, tip: branch.tip };
    } catch {
      return null;
    }
  }

  const recorder = Object.freeze({
    /**
     * Before the dataset's first tracker starts (while its starting view is
     * put back), an action is applied and not recorded: what it did is part
     * of the state the tracker starts from.
     */
    async before({ definition, params, meta }) {
      if (active === null) return null;
      // A change observed before this action (a gesture ended as it starts) is recorded first, so the
      // capture below never reads it as a change made outside the history.
      // Inside an exclusive task (a replay, a re-apply) the observed changes wait for the task instead.
      if (meta.rewrite === null && !exclusiveBusy) await observedTail;
      if (active === null || destroyed) return null;
      const tracker = active;
      if (meta.rewrite === null) {
        const refusal = bindingRefusal(tracker, meta, personMovedSince);
        if (refusal !== null) throw refusal;
      }
      // What it touches and what follows that (`DERIVED_DOMAINS`): a selection that follows the pages is part of the step.
      const captured = await capture(withDerivedDomains(definition.touches));
      if (meta.rewrite === null) healOutsideChange(tracker, captured);
      else shown = { ...shown, ...captured };
      const reads = readsOf(definition.reads, shown, (definition.reads ?? []).includes('history') ? branchTipRead(tracker, params) : null);
      // The values it captured stay readable until it is recorded or put back.
      return { tracker, definition, params, meta, before: captured, reads, startedAt: now(), unhold: pool.hold() };
    },
    async after(token, outcome) {
      try {
        if (destroyed) return null;
        const after = await capture(withDerivedDomains(token.definition.touches));
        if (token.meta.rewrite !== null) {
          return rewrite(token.tracker, token.meta.rewrite, { ...token, after, outcome });
        }
        if (token.tracker !== active) {
          shown = { ...shown, ...after };
          return null;
        }
        return await recordAction(token.tracker, { ...token, after, outcome });
      } finally {
        sweep();
        token.unhold();
      }
    },
    /** A failed handler leaves nothing half done: what it changed is put back. */
    async failed(token) {
      try {
        if (destroyed) return;
        shown = { ...shown, ...await capture(withDerivedDomains(token.definition.touches)) };
        restoringDepth++;
        try {
          await putBack(token.before, null);
        } finally {
          restoringDepth--;
        }
      } finally {
        sweep();
        token.unhold();
      }
    },
    /**
     * Observed changes are recorded one after the other, in the order they
     * were observed, each against what is shown when it is recorded. `after`,
     * when given, is the work the change set off: the change is recorded once
     * it has settled, so its step holds all of it.
     */
    observed({ definition, params, meta, outcome = null, after = null }) {
      if (restoringDepth > 0 || active === null) return Promise.resolve(null);
      const tracker = active;
      if (after !== null) {
        const recorded = Promise.resolve(after).then(() => recordObservedNow(tracker, { definition, params, meta, outcome }));
        const done = recorded.then(() => undefined, () => undefined).then(() => { pendingObserved.delete(done); });
        pendingObserved.add(done);
        return recorded;
      }
      return recordObservedNow(tracker, { definition, params, meta, outcome });
    },
  });

  /**
   * Record an observed change once the changes observed before it are
   * recorded. Its state is read twice: as its event ends (its control's own
   * listeners have run), and when its turn comes. The turn's reading holds
   * effects that finish later (a camera settling on a pane, a size preset
   * laying out) and is used, unless a change of the same domains was
   * observed in a later task meanwhile: then the turn would read that change
   * too (four key presses on a slider, the first record reading the last
   * position; two settings changed quickly, the first step holding both), and
   * the first reading is used, so each gesture is its own. The changes
   * observed in one task are one gesture (a select fires `input`, then
   * `change`, whose listener sets the sizes a preset names): they share the
   * last reading, so its later records find nothing new.
   */
  function recordObservedNow(tracker, { definition, params, meta, outcome }) {
    const touches = withDerivedDomains(definition.touches);
    const unhold = pool.hold();
    const task = observedTask();
    const change = { touches, superseded: false, task, early: null };
    const early = capture(touches);
    early.catch(() => {});
    for (const other of observedChanges) {
      if (!other.touches.some(id => touches.includes(id))) continue;
      if (other.task === task) other.early = early; else other.superseded = true;
    }
    change.early = early;
    observedChanges.add(change);
    const run = observedTail.then(async () => {
      try {
        // A change observed while an exclusive operation runs (a camera drag during a delete's re-apply) is
        // recorded once it ends, against what is shown then.
        while (exclusiveBusy) await exclusiveDone;
        if (restoringDepth > 0 || active !== tracker || destroyed) return null;
        const startedAt = now();
        const after = change.superseded ? await change.early : await capture(touches);
        const reads = readsOf(definition.reads, shown, null);
        return await recordAction(tracker, { definition, params, meta, after, outcome, reads, startedAt, observed: true });
      } finally {
        observedChanges.delete(change);
        sweep();
        unhold();
      }
    });
    observedTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // -------------------------------------------------------------------------
  // Edits (journaled)

  /** Who an edit is by, from a dispatch's meta (the panel's own calls are the person's). */
  function byOf(meta = {}) {
    return createBy(byOfMeta({ origin: 'user', ...meta, turn: meta.turn ?? null }, person()));
  }

  /**
   * Run a structural edit of `tracker` and journal it. Afterwards the shown
   * state follows the head when the edit moved it or changed its values.
   * Returns `{entry, result}`.
   */
  async function journaled(tracker, { op, label, meta }, change) {
    requireExclusive('A journaled edit');
    const by = byOf(meta);
    const edit = beginEdit(tracker, { op, by, at: now(), label });
    let result;
    try {
      result = change(edit);
    } catch (error) {
      rollbackEdit(edit);
      throw error;
    }
    const entry = commitEdit(edit, { always: true });
    coalesceStep = null;
    if (tracker === active) {
      // Only an edit that moved the head or changed its values changes what is shown (a paused draft stays).
      const target = valuesAt(tracker, tracker.headId);
      const changed = DOMAIN_IDS.filter(id => target[id] !== headValues[id]);
      headValues = target;
      if (changed.length > 0) await restoreTo(withoutOff({ ...target, ...(pausedDraftAt(tracker, target) ?? {}) }));
    }
    if (entry !== null) notifyEdit(tracker, entry, edit);
    return { entry, result };
  }

  function notifyEdit(tracker, entry, edit) {
    const steps = [];
    const removed = [];
    for (const id of edit.kept.steps.keys()) (tracker.steps.has(id) ? steps : removed).push(id);
    notify('edited', { tracker: tracker.id, op: entry.op, journal: entry.id, label: entry.label, steps, removed });
  }

  // -------------------------------------------------------------------------
  // Values kept

  function prune() {
    const keep = new Set();
    for (const tracker of trackers.values()) {
      if (tracker === active) {
        // The paused draft of the tracker in use is what is shown: held as shown is.
        const { paused } = tracker;
        tracker.paused = paused === null ? null : { ...paused, draft: null };
        referencedHashes(tracker, keep);
        tracker.paused = paused;
      } else {
        referencedHashes(tracker, keep);
      }
    }
    // A value only what is shown holds is held as a capture's is: it goes once nothing shows it.
    for (const hash of [...Object.values(shown), ...Object.values(headValues), ...Object.values(active?.paused?.draft ?? {})]) {
      if (!keep.has(hash)) transient.add(hash);
      keep.add(hash);
    }
    pool.prune(keep);
    for (const key of [...canonicalHashes.keys()]) if (!pool.has(key.slice(key.indexOf('\u0000') + 1))) canonicalHashes.delete(key);
  }

  // -------------------------------------------------------------------------
  // Trackers

  function trackerNamed(ref, { removed = false } = {}) {
    const candidates = removed ? [...trackers.values()] : liveTrackers();
    if (HISTORY_ID_PATTERNS.tracker.test(ref)) {
      const byId = trackers.get(ref);
      if (byId !== undefined && (removed || byId.removed === null)) return byId;
    }
    const key = nameKey(ref);
    const named = candidates.filter(tracker => nameKey(tracker.name) === key);
    if (named.length > 0) return named.find(tracker => tracker.removed === null) ?? named[0];
    throw refuse(HISTORY_SENTENCES.noTracker({ ref, names: liveTrackers().map(tracker => tracker.name) }), 'no-target');
  }

  function trackerOf(params, type, { removed = false } = {}) {
    requireStarted(type);
    return params?.tracker === undefined ? active : trackerNamed(params.tracker, { removed });
  }

  function use(tracker) {
    // A tracker left keeps its paused draft on its record: its values are held by that record now.
    if (active !== null && active !== tracker && active.paused?.draft) claim(Object.values(active.paused.draft));
    // The draft of the tracker used again is what is shown again: a value only it holds goes once nothing shows it.
    if (active !== tracker && tracker.paused?.draft) {
      const draft = new Set(Object.values(tracker.paused.draft));
      const recorded = new Set();
      for (const each of trackers.values()) {
        const { paused } = each;
        if (each === tracker) each.paused = { ...paused, draft: null };
        referencedHashes(each, recorded);
        each.paused = paused;
      }
      for (const hash of draft) if (!recorded.has(hash)) transient.add(hash);
    }
    active = tracker;
    usedOrder = [tracker.id, ...usedOrder.filter(id => id !== tracker.id)];
  }

  /** A new tracker on `rootValues`, in use from now on (inside an exclusive operation). */
  function beginTracker({ name, start, rootValues, by }) {
    const taken = liveTrackers().map(tracker => tracker.name);
    const tracker = newTracker({
      id: newTrackerId(), name: name === null ? suffixedName(`Tracker ${liveTrackers().length + 1}`, 'new', taken) : name,
      dataset: { id: dataset.id ?? null, name: dataset.name ?? null, cellOrder: dataset.cellOrder ?? null },
      createdAt: now(), by, start, rootValues, recording: recordNewTrackers(),
    });
    trackers.set(tracker.id, tracker);
    claim(Object.values(rootValues));
    use(tracker);
    headValues = { ...rootValues };
    pending = null;
    coalesceStep = null;
    notify('tracker', { tracker: tracker.id });
    return tracker;
  }

  /** The values a tracker "from the dataset as opened" starts with: the first tracker's root. */
  function openedValues() {
    const first = trackers.values().next().value;
    return first === undefined ? null : { ...stepOf(first, first.rootId).after };
  }

  async function startTracker({ start = 'opened', name = null, meta = {} } = {}) {
    // The dataset's first tracker starts with the dataset's opening; any other is started by someone.
    const by = active === null && trackers.size === 0 ? createBy({ origin: 'startup' }) : byOf(meta);
    const checked = name === null ? null : checkedName('tracker', name);
    if (checked !== null && liveTrackers().some(tracker => nameKey(tracker.name) === nameKey(checked))) {
      throw refuse(HISTORY_SENTENCES.nameTaken({ kind: 'tracker', name: checked }), 'name-taken');
    }
    if (active !== null) settleBeforeMove(active, by);
    const opened = start === 'opened' ? openedValues() : null;
    let rootValues;
    if (opened === null) {
      rootValues = await capture(DOMAIN_IDS);
      shown = { ...shown, ...rootValues };
    } else {
      await restoreTo(withoutOff(opened));
      rootValues = { ...opened };
    }
    const kind = active === null ? 'opened' : start;
    const tracker = beginTracker({ name: checked, start: { kind, from: null, report: null, mapping: null }, rootValues, by });
    return tracker;
  }

  // -------------------------------------------------------------------------
  // Replays (a saved history, a branch without a step, a branch's steps here, verify)

  /** A source step's parameters at this catalogue's version, or why they cannot be replayed here. */
  function replayableParams(step, mapping) {
    if (!catalog.has(step.type)) return { reason: `"${step.type}" is not an action of this version of Cellucid; it was recorded with another version and cannot be replayed here.` };
    const definition = catalog.get(step.type);
    const v = step.v ?? 1;
    if (v > definition.version) return { reason: `It was recorded with a newer Cellucid (version ${v} of "${step.type}"; this one knows ${definition.version}) and cannot be replayed here.` };
    let params;
    try {
      params = upgradeParams(definition, v, step.params ?? {});
    } catch (error) {
      // Its parameters hold nothing this version can be made from: its values only (`valuesOnlyUpgrade`).
      if (error instanceof ParamsNotUpgradable) return { reason: error.reason, valuesOnly: true };
      throw error;
    }
    if (mapping !== null) params = mapParams(definition, params, mapping);
    return { params };
  }

  /** Keep a step that did not apply here, flagged with the reason (it changed nothing). */
  function keepUnmatched(tracker, step, reason, replayOf) {
    const kept = appendRecord(tracker, {
      kind: step.kind === 'squashed' ? 'squashed' : 'action', type: step.kind === 'squashed' ? null : step.type,
      params: step.kind === 'squashed' ? null : (step.params ?? {}), v: step.kind === 'squashed' ? null : (step.v ?? 1),
      code: step.code ?? null, label: step.label, by: createBy({ origin: 'replay' }), at: now(), touches: [], before: {}, after: {},
      squashed: step.kind === 'squashed' ? { cause: step.squashed.cause, count: step.squashed.count, by: step.squashed.by.length ? step.squashed.by : [createBy({ origin: 'replay' })], carried: { notes: [], bookmarks: [] } } : null,
      // A squashed step names no action, so nothing it replays (the report names its source).
      replayOf: step.kind === 'squashed' ? null : replayOf,
    }, {});
    kept.status = 'unapplicable';
    kept.reason = reason;
    return kept;
  }

  /**
   * Put a squashed step's or an outside change's values back as a step of
   * the same kind at the head (a replay on the dataset they were recorded
   * on; paused, they are put back and make no step, as an action's). Returns
   * `{step}` (null when nothing differs or recording is paused), or
   * `{reason}` when a value is not held here.
   */
  async function replayValues(tracker, step, values) {
    const offIds = new Set(off());
    const touches = orderedDomains(Object.keys(step.after).filter(id => !offIds.has(id) && headValues[id] !== step.after[id]));
    if (touches.length === 0) return { step: null };
    for (const id of touches) {
      const hash = step.after[id];
      if (!pool.has(hash) && values?.has(hash)) pool.adopt(hash, values.get(hash));
      if (!pool.has(hash)) return { reason: `Its ${domainName(id).toLowerCase()} values are not held here, so they cannot be put back.` };
    }
    const after = Object.fromEntries(touches.map(id => [id, step.after[id]]));
    await restoreTo(after);
    if (tracker.paused !== null) {
      notePaused(tracker);
      return { step: null };
    }
    const outside = step.kind === 'outside';
    // An action's step whose parameters this version cannot apply again (`valuesOnlyUpgrade`): its values, as recorded.
    const action = step.kind === 'action';
    return { step: appendRecord(tracker, {
      kind: step.kind, type: outside ? OUTSIDE_CHANGE_TYPE : action ? step.type : null,
      params: outside ? { domains: touches } : action ? structuredClone(step.params ?? {}) : null,
      ...(action ? { v: step.v ?? 1, code: step.code ?? null } : {}),
      by: outside ? { ...OUTSIDE_BY } : createBy({ origin: 'replay' }), at: now(), touches,
      before: Object.fromEntries(touches.map(id => [id, headValues[id]])), after,
      squashed: outside || action ? null : { ...structuredClone(step.squashed), carried: { notes: [], bookmarks: [] } },
      label: step.label,
    }, {}) };
  }

  /**
   * Apply `steps` again, by name, one after the other at the head of
   * `tracker` (origin `replay`, while the person's actions wait at the gate).
   * A squashed step or an outside change has its values put back on the
   * dataset it was recorded on (`replayValues`), and is flagged on another.
   * A parameter naming a step names the step this replay made of it
   * (`made`, source → new, filled here), or the same step when the replay
   * is on the source's own path (`keptSteps`). Returns the report
   * (`ReplayEntry[]`).
   */
  async function replaySteps(tracker, steps, { source, mapping = null, signal = null, onStep = null, made = new Map(), keptSteps = () => false, values = null, failures = null }) {
    requireExclusive('A replay');
    const report = [];
    // The steps' own dataset (a branch applied here, a verify: `source.own`), or the same file by its
    // identity: the same cells at the same original positions, which a step naming cells needs.
    const sameDataset = source !== null && (source.own === true || (source.dataset?.id != null && source.dataset.id === dataset.id));
    const say = (step, outcome, step2 = null, reason = null, missing = null) => {
      const entry = { source: step.id, label: step.label, outcome, step: step2, reason, missing };
      if (step2 !== null && outcome === 'applied') made.set(step.id, step2);
      report.push(entry);
      try { onStep?.(entry, report.length - 1, steps.length); } catch (error) { console.error('[history] replay listener failed', error); }
    };
    for (const step of steps) {
      const replayOf = source === null ? null : { tracker: source.tracker, step: step.id, dataset: { ...source.dataset } };
      if (signal?.aborted || destroyed) { say(step, 'stopped'); continue; }
      if (!isReplayable(step)) {
        if (sameDataset && (step.kind === 'squashed' || step.kind === 'outside')) {
          const put = await replayValues(tracker, step, values);
          if (put.reason === undefined) say(step, put.step === null ? 'unchanged' : 'applied', put.step?.id ?? null);
          else if (step.kind === 'squashed') say(step, 'unmatched', keepUnmatched(tracker, step, put.reason, replayOf).id, put.reason);
          else say(step, 'skipped', null, put.reason);
        } else if (step.kind === 'squashed') {
          const reason = `Changes made as one step (${step.label}): values only, not replayable on another dataset.`;
          say(step, 'unmatched', keepUnmatched(tracker, step, reason, replayOf).id, reason);
        } else {
          say(step, 'skipped', null, 'A change made outside the recorded steps names no action to apply again on another dataset.');
        }
        continue;
      }
      if (step.status === 'unapplicable') {
        const reason = `It did not apply where it was recorded either: ${step.reason ?? 'no reason was kept'}`;
        say(step, 'unmatched', keepUnmatched(tracker, step, reason, replayOf).id, reason);
        continue;
      }
      const prepared = replayableParams(step, mapping);
      if (prepared.valuesOnly === true && sameDataset) {
        const put = await replayValues(tracker, step, values);
        if (put.reason === undefined) say(step, put.step === null ? 'unchanged' : 'applied', put.step?.id ?? null);
        else say(step, 'unmatched', keepUnmatched(tracker, step, `${prepared.reason} ${put.reason}`, replayOf).id, `${prepared.reason} ${put.reason}`);
        continue;
      }
      if (prepared.reason !== undefined) {
        say(step, 'unmatched', keepUnmatched(tracker, step, prepared.reason, replayOf).id, prepared.reason);
        continue;
      }
      const definition = catalog.get(step.type);
      // Cells named by their original positions (a pushed column, a selection) are those of the
      // dataset the step was recorded on: another lists its cells in its own order, whatever their count.
      if (!sameDataset && namesCells(definition)) {
        const reason = `It names cells of ${source?.dataset?.name == null ? 'the dataset it was recorded on' : `"${source.dataset.name}"`} by their positions, which are not this dataset's cells, so it is not applied here.`;
        say(step, 'unmatched', keepUnmatched(tracker, step, reason, replayOf).id, reason);
        continue;
      }
      const named = stepParamsIn(definition, prepared.params, made, id => keptSteps(id) && tracker.steps.has(id) && isOnPath(tracker, id, tracker.headId));
      if (named.missing !== undefined) {
        const reason = `The step it names (step ${idNumber(named.missing)}) was not applied again here.`;
        say(step, 'unmatched', keepUnmatched(tracker, step, reason, replayOf).id, reason);
        continue;
      }
      const offIds = off();
      if (definition.touches.length > 0 && definition.touches.every(id => offIds.includes(id))) {
        say(step, 'unchanged', null, `Not recorded (${definition.touches.map(domainName).join(', ').toLowerCase()} recording is off).`);
        continue;
      }
      try {
        const { step: result } = await dispatcher.dispatch(step.type, named.params, {
          origin: 'replay', internal: true, signal, replayOf,
        });
        say(step, result === null ? 'unchanged' : 'applied', result?.id ?? null);
      } catch (error) {
        if (destroyed || signal?.aborted) { say(step, 'stopped'); continue; }
        const reason = error?.message || String(error);
        const missing = error instanceof ActionRefused && error.missing !== null ? { ...error.missing } : null;
        // A refusal is the step's answer here; anything else (a field that could not be read) is what got in its way.
        if (!(error instanceof ActionRefused)) failures?.push({ step, error });
        say(step, 'unmatched', keepUnmatched(tracker, step, reason, replayOf).id, reason, missing);
      }
    }
    return report;
  }

  /**
   * Replay recorded steps in a new tracker on the state shown, linked to
   * where they come from (`start.kind 'replay'`, its report and mapping
   * kept). The tracker in use before keeps its steps.
   *
   * @param {{steps: object[], from: object, name: string, mapping?: object|null}} plan - `from`: a `Link`
   */
  async function replayIntoNewTracker({ steps, from, name, mapping = null, values = null }, { signal = null, onStep = null, meta = {} } = {}) {
    requireActive();
    throwIfAborted(signal);
    const by = createBy({ origin: 'replay' });
    settleBeforeMove(active, byOf(meta));
    const rootValues = await capture(DOMAIN_IDS);
    shown = { ...shown, ...rootValues };
    const taken = liveTrackers().map(tracker => tracker.name);
    const tracker = beginTracker({
      name: suffixedName(name, 'replay', taken),
      start: { kind: 'replay', from: structuredClone(from), report: [], mapping: mapping === null ? null : structuredClone(mapping) },
      rootValues, by,
    });
    // A replay records whatever the tracker's recording switch said; it never runs paused.
    tracker.paused = null;
    const report = await replaySteps(tracker, steps, {
      source: { tracker: from.tracker.id, dataset: from.dataset }, mapping, signal, onStep, values,
    });
    tracker.start.report = report;
    if (!destroyed) notify('replayed', { tracker: tracker.id, report });
    return { tracker: tracker.id, report };
  }

  /**
   * Apply `steps` (of this tracker) again as a new branch from `fromStep`
   * named `name` (Branch without a step, Apply a branch here, a restore as
   * new). `made` gathers source → new step ids (a restore hangs a sub-branch
   * on its restored parent with it).
   */
  async function replayAsBranch(tracker, fromStep, steps, name, { signal = null, meta = {}, made = new Map() } = {}) {
    settleBeforeMove(tracker, byOf(meta));
    if (tracker.headId !== fromStep) await show(tracker, fromStep);
    const before = tracker.nextBranch;
    pending = { name, from: fromStep };
    const report = await replaySteps(tracker, steps, {
      source: { tracker: tracker.id, dataset: { id: dataset.id ?? null, name: dataset.name ?? null }, own: true }, signal, made,
      // A step named before the steps applied again is on the path shown: it stays the one named.
      keptSteps: () => true,
    });
    pending = null;
    const branch = [...tracker.branches.values()].find(each => idNumber(each.id) >= before && each.base === fromStep) ?? null;
    if (!destroyed) notify('replayed', { tracker: tracker.id, report });
    return { branch: branch === null ? null : { id: branch.id, name: branch.name }, head: tracker.headId, report };
  }

  // -------------------------------------------------------------------------
  // Load and import

  /** The values of `stepId` in a saved tracker record (steps by id), read from its root. */
  function valuesAtRecord(record, stepId) {
    const byId = new Map(record.steps.map(step => [step.id, step]));
    const path = [];
    for (let step = byId.get(stepId); step !== undefined; step = step.parent === null ? undefined : byId.get(step.parent)) path.push(step);
    const values = {};
    for (const step of path.reverse()) Object.assign(values, step.after);
    return values;
  }

  function checkDomains(record) {
    const unknown = new Set();
    for (const step of record.steps) {
      for (const id of [...step.touches, ...Object.keys(step.before), ...Object.keys(step.after)]) {
        if (!DOMAIN_IDS.includes(id)) unknown.add(id);
      }
    }
    if (unknown.size > 0) throw new RangeError(unknownDomainsMessage([...unknown]));
  }

  /**
   * Read a saved history: show its active tracker's head, read the rest, and
   * hand back its trackers live (`replace`: every tracker; `add`: beside the
   * ones there). On any failure what was shown comes back.
   */
  async function readSaved(saved, { values = new Map(), rest = null, signal = null }) {
    for (const [hash, value] of values) pool.adopt(hash, value);
    const records = saved.trackers.map(record => ({ ...record, steps: record.steps.map(step => ({ ...step })), journal: [...record.journal] }));
    const activeRecord = records.find(record => record.id === saved.activeTracker);
    if (activeRecord === undefined) throw new RangeError('A saved history names an active tracker it does not hold');
    for (const record of records) checkDomains(record);
    const previous = await capture(DOMAIN_IDS);
    shown = { ...previous };
    // A domain a saved root does not hold (one this version added later) keeps the value shown now.
    for (const record of records) {
      const root = record.steps.find(step => step.parent === null);
      if (root !== undefined) {
        root.after = { ...root.after };
        for (const id of DOMAIN_IDS) if (!(id in root.after)) root.after[id] = previous[id];
      }
    }
    const target = valuesAtRecord(activeRecord, activeRecord.headId);
    const draft = activeRecord.paused?.draft ?? null;
    const shownTarget = draft === null ? target : { ...target, ...draft };
    if (Object.values(shownTarget).some(hash => !pool.has(hash))) throw new RangeError('A saved history does not hold the values of the step it shows');
    try {
      await restoreTo(shownTarget, { signal });
      if (rest !== null) {
        const more = await rest();
        throwIfAborted(signal);
        for (const [hash, value] of more.values ?? []) pool.adopt(hash, value);
        for (const { tracker, conversation, transcript } of more.chats ?? []) {
          const record = records.find(each => each.id === tracker);
          if (record === undefined) throw new RangeError(`A saved conversation names a tracker the history does not hold ("${tracker}")`);
          record.chats = [...record.chats.filter(([id]) => id !== conversation), [conversation, transcript]];
        }
        for (const { tracker, journal } of more.journals ?? []) {
          const record = records.find(each => each.id === tracker);
          if (record === undefined) throw new RangeError(`A saved journal names a tracker the history does not hold ("${tracker}")`);
          record.journal = journal;
        }
        for (const { tracker, step, params, outcome } of more.params ?? []) {
          const record = records.find(each => each.id === tracker);
          const held = record?.steps.find(each => each.id === step);
          if (held === undefined) throw new RangeError(`Saved parameters name a step the history does not hold ("${tracker}" "${step}")`);
          held.params = params;
          held.outcome = outcome;
        }
      }
      validateHistory({ dataset: saved.dataset, activeTracker: saved.activeTracker, trackers: records });
      const live = records.map(liveTracker);
      for (const tracker of live) {
        const hashes = referencedHashes(tracker);
        for (const hash of Object.values(tracker.paused?.draft ?? {})) hashes.add(hash);
        for (const hash of hashes) {
          if (!pool.has(hash)) throw new RangeError(`A saved history does not hold the value ${hash.slice(0, 12)} its steps refer to`);
        }
      }
      return { live, activeId: saved.activeTracker, target };
    } catch (error) {
      try { await restoreTo(previous); } catch (rollbackError) { if (error && typeof error === 'object') error.rollbackError ??= rollbackError; }
      throw error;
    }
  }

  /** Re-issue tracker ids taken here, and every reference to them in the file (H2 note b). */
  function reissue(records) {
    // A new id is free of the history's trackers and of every tracker of the file, and of those issued now.
    const remap = new Map();
    const taken = new Set([...trackers.keys(), ...records.map(record => record.id)]);
    for (const record of records) {
      if (!trackers.has(record.id)) continue;
      let id = newTrackerId();
      while (taken.has(id)) id = newTrackerId();
      taken.add(id);
      remap.set(record.id, id);
    }
    if (remap.size === 0) return { records, rest: more => more };
    const fix = id => remap.get(id) ?? id;
    const fixStep = step => ({
      ...step,
      replayOf: step.replayOf === null ? null : { ...step.replayOf, tracker: fix(step.replayOf.tracker) },
      reads: step.reads.history === undefined ? step.reads : { ...step.reads, history: { ...step.reads.history, tracker: fix(step.reads.history.tracker) } },
    });
    const fixPatch = patch => (patch === null ? null : { ...patch, steps: patch.steps.map(fixStep) });
    const fixJournal = journal => journal.map(entry => ({ ...entry, before: fixPatch(entry.before), after: fixPatch(entry.after) }));
    return {
      records: records.map(record => ({
        ...record,
        id: fix(record.id),
        start: record.start.from === null ? record.start
          : { ...record.start, from: { ...record.start.from, tracker: { ...record.start.from.tracker, id: fix(record.start.from.tracker.id) } } },
        steps: record.steps.map(fixStep),
        journal: fixJournal(record.journal),
      })),
      // What a file reads behind its head (conversations, Recently deleted, late parameters) names
      // its trackers by the file's ids: re-issued the same way.
      rest: more => ({
        ...more,
        chats: (more.chats ?? []).map(chat => ({ ...chat, tracker: fix(chat.tracker) })),
        journals: (more.journals ?? []).map(({ tracker, journal }) => ({ tracker: fix(tracker), journal: fixJournal(journal) })),
        params: (more.params ?? []).map(entry => ({ ...entry, tracker: fix(entry.tracker) })),
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Moves (inside an exclusive operation)

  /**
   * After a move: an agent's own move carries its turn on to the branch it
   * shows (its next step is not refused as moved); the person's is counted,
   * so a turn knows whether the person moved since its last step.
   */
  function carryTurn(tracker, meta) {
    if (byOf(meta).origin === 'user') {
      personMoves++;
      return;
    }
    if (meta?.origin !== 'agent' || typeof meta.turn !== 'string') return;
    const turn = tracker.turns.get(meta.turn);
    if (turn !== undefined) {
      turn.branch = tracker.activeBranch;
      turnSeen.set(turn.id, personMoves);
    }
  }

  /** Whether the person moved since the turn's last step, its own move or its undo (`turns.js` `bindingRefusal`). */
  function personMovedSince(turnId) {
    return (turnSeen.get(turnId) ?? -1) < personMoves;
  }

  async function setRecordingNow(on, { tracker: ref = null, meta = {} } = {}) {
    requireExclusive('Pausing or resuming');
    const tracker = ref === null ? requireActive() : trackerNamed(ref);
    const by = byOf(meta);
    let squashed = null;
    if (on && tracker.paused !== null) {
      // A tracker not in use keeps its draft on its record (a reload kept it): squashed against its own head.
      squashed = squashPaused(tracker, by)?.id ?? null;
      tracker.paused = null;
      if (tracker === active) pausedChoice = { next: null, remembered: null };
    } else if (!on && tracker.paused === null) {
      tracker.paused = { at: now(), by: [by], draft: null };
      if (tracker === active) coalesceStep = null;
    }
    notify('recording', { tracker: tracker.id, on: tracker.paused === null });
    return { recording: tracker.paused === null, since: tracker.paused?.at ?? null, squashed, head: tracker.headId };
  }

  async function undoNow(meta = {}) {
    requireExclusive('Undo');
    const tracker = requireActive();
    settleBeforeMove(tracker, byOf(meta));
    const head = stepOf(tracker, tracker.headId);
    if (head.parent === null) {
      if (Object.keys(pausedDraft(tracker) ?? {}).length > 0) await show(tracker, head.id);
      return false;
    }
    await show(tracker, head.parent);
    carryTurn(tracker, meta);
    return true;
  }

  async function redoNow(meta = {}) {
    requireExclusive('Redo');
    const tracker = requireActive();
    settleBeforeMove(tracker, byOf(meta));
    const target = redoTarget(tracker);
    if (target === null) return false;
    await show(tracker, target);
    carryTurn(tracker, meta);
    return true;
  }

  async function jumpNow(stepId, meta = {}) {
    requireExclusive('A jump');
    const tracker = requireActive();
    stepNamed(tracker, stepId);
    settleBeforeMove(tracker, byOf(meta));
    await show(tracker, stepId);
    carryTurn(tracker, meta);
  }

  async function useTrackerNow(ref, meta = {}) {
    requireExclusive('Using a tracker');
    const tracker = trackerNamed(ref);
    if (tracker === active) return;
    if (active !== null) settleBeforeMove(active, byOf(meta));
    const target = valuesAt(tracker, tracker.headId);
    await restoreTo(withoutOff({ ...target, ...(tracker.paused?.draft ?? {}) }));
    use(tracker);
    headValues = target;
    pending = null;
    coalesceStep = null;
    notify('tracker', { tracker: tracker.id });
  }

  async function undoTurnNow(turnId, { onlyOwn = false, meta = {}, signal = null } = {}) {
    requireExclusive('Undoing a turn');
    const tracker = requireActive();
    const plan = turnUndoPlan(tracker, turnId);
    if (plan.first === null) return { head: tracker.headId, removed: 0, other_branches: plan.otherBranches, journal: null, flagged: [] };
    if (!onlyOwn || plan.contiguous) {
      settleBeforeMove(tracker, byOf(meta));
      await show(tracker, stepOf(tracker, plan.first).parent);
      // Undoing a turn is no move away from it: it goes on from here.
      plan.turn.branch = tracker.activeBranch;
      turnSeen.set(plan.turn.id, personMoves);
      return { head: tracker.headId, removed: 0, other_branches: plan.otherBranches, journal: null, flagged: [] };
    }
    const steps = plan.own.map(id => stepOf(tracker, id));
    const result = await removeSteps(tracker, steps, {
      signal, meta, op: 'turn.undo', label: `Undid ${plan.turn.by.agent ?? 'the notebook'}'s turn "${plan.turn.label}" (${formatCountOf(steps.length, 'step')})`,
    });
    return { head: result.head, removed: steps.length, other_branches: plan.otherBranches, journal: result.journal, flagged: result.flagged };
  }

  // -------------------------------------------------------------------------
  // The history's own context: what its parts (`delete-restore.js`, `actions.js`) share with it

  /**
   * Remove `tracker` to Recently deleted (inside an exclusive operation): the
   * one way a tracker goes (`history.tracker.remove`, undoing a load). The
   * tracker shown moves to the one used last; the only live tracker cannot
   * go. Resolves to the `tracker.remove` journal entry.
   */
  async function removeTracker(tracker, by, action) {
    if (tracker.removed !== null) throw refuse(`${quoteName(tracker.name)} is in Recently deleted already.`, 'refused', action);
    const others = liveTrackers().filter(other => other !== tracker);
    if (others.length === 0) throw refuse(`${quoteName(tracker.name)} is the only tracker; start another first.`, 'refused', action);
    if (tracker === active) {
      settleBeforeMove(tracker, by);
      const next = usedOrder.map(id => trackers.get(id)).find(other => other !== undefined && other !== tracker && other.removed === null) ?? others[others.length - 1];
      const target = valuesAt(next, next.headId);
      await restoreTo(withoutOff({ ...target, ...(next.paused?.draft ?? {}) }));
      use(next);
      headValues = target;
      pending = null;
    }
    const edit = beginEdit(tracker, { op: 'tracker.remove', by, at: now(), label: `Removed the tracker "${tracker.name}"` });
    edit.field('removed');
    tracker.removed = { at: now(), by };
    const entry = commitEdit(edit);
    usedOrder = usedOrder.filter(id => id !== tracker.id);
    notify('tracker', { tracker: tracker.id });
    notify('edited', { tracker: tracker.id, op: 'tracker.remove', journal: entry.id, label: entry.label, steps: [], removed: [] });
    return entry;
  }

  /**
   * The operations and the state a part of the history works with: the
   * state through getters and setters (it changes as the history works), the
   * operations as they are. Only the history's own modules hold it.
   */
  const h = {
    get active() { return active; },
    set active(value) { active = value; },
    get coalesceStep() { return coalesceStep; },
    set coalesceStep(value) { coalesceStep = value; },
    get headValues() { return headValues; },
    set headValues(value) { headValues = value; },
    get pending() { return pending; },
    set pending(value) { pending = value; },
    get restoringDepth() { return restoringDepth; },
    set restoringDepth(value) { restoringDepth = value; },
    get shown() { return shown; },
    set shown(value) { shown = value; },
    get usedOrder() { return usedOrder; },
    set usedOrder(value) { usedOrder = value; },
    get destroyed() { return destroyed; },
    get api() { return api; },
    get restoreEntry() { return deleteRestore.restoreEntry; },
    catalog, dataset, dispatcher, domains, now, openSaved, person, pool, trackers,
    appendRecord, beginTracker, byOf, carryTurn, exclusive, journaled, jumpNow, liveTrackers, notify, removeTracker,
    notifyEdit, off, pausedDraftAt, prune, putBack, replayAsBranch, replaySteps, replayableParams,
    requireExclusive, requireStarted, restoreTo, sameCanonical, settleBeforeMove, show, startTracker,
    trackerNamed, trackerOf, use, useTrackerNow, withoutOff,
  };
  const deleteRestore = createDeleteRestore(h);
  const { dependantsOf, deleteStepNow, removeSteps } = deleteRestore;
  const { handlers: ownActions, estimators, branchMoved, describeBranchDelete } = createHistoryActions(h);

  // -------------------------------------------------------------------------
  // The API

  function requireStarted(type) {
    if (active === null) throw refuse('The history starts once the dataset is open.', 'unavailable', type);
    return active;
  }

  const api = {
    recorder,
    pool,
    dataset,
    catalog,
    /** Start a tracker: the dataset's first on what is shown, another from the dataset as opened or from what is shown. */
    startTracker(options = {}) {
      return exclusive(() => startTracker(options));
    },
    /**
     * Put a saved state back without recording it: a dataset's starting view,
     * before the dataset's first tracker starts.
     */
    showValues(values) {
      return exclusive(async () => {
        if (active !== null) throw new Error('A state is put back without a step only before the first tracker starts');
        const unknown = Object.keys(values).filter(id => !DOMAIN_IDS.includes(id));
        if (unknown.length > 0) throw new RangeError(unknownDomainsMessage(unknown));
        const target = {};
        for (const id of orderedDomains(Object.keys(values))) target[id] = await pool.put(values[id]);
        shown = { ...shown, ...await capture(Object.keys(target)) };
        await restoreTo(target);
      });
    },
    /**
     * Record what is shown: a change made outside an action becomes its own
     * step (while paused, part of the draft), so a session saved now holds
     * what the person sees.
     */
    reconcile() {
      return exclusive(async () => {
        if (active === null) return;
        healOutsideChange(active, await capture(DOMAIN_IDS));
      });
    },
    /**
     * The live tracker in use (`tree.js`'s live record), or null. **Read-only**:
     * a view (the State panel, an agent's reads) reads it and never writes it;
     * every change goes through the history's actions, which journal it and keep
     * its indexes. Its records change in place as the history works, so a reader
     * that keeps something across awaits copies it (`trackerRecord`).
     */
    get active() { return active; },
    /** The trackers not removed, in the order they started. */
    trackers: () => liveTrackers(),
    /** Every tracker, those in Recently deleted included. */
    allTrackers: () => [...trackers.values()],
    canUndo: () => active !== null && stepOf(active, active.headId).parent !== null,
    canRedo: () => active !== null && redoTarget(active) !== null,
    /**
     * The move's choice while paused with changes (the Keep / Discard card):
     * `remember` keeps it for the rest of the paused period ("Don't ask again
     * while paused"). A move made with none keeps the changes.
     * @param {'keep'|'discard'} choice
     */
    setPausedChoice(choice, { remember = false } = {}) {
      if (!PAUSED_CHOICES.includes(choice)) throw new TypeError(`A paused choice is one of ${PAUSED_CHOICES.join(', ')}`);
      if (remember) pausedChoice.remembered = choice; else pausedChoice.next = choice;
    },
    /**
     * What a move would ask while paused: the domains changed since the head
     * (null when recording, or when nothing differs, or a choice is
     * remembered), so the panel shows its Keep / Discard / Cancel card.
     */
    pausedChanges() {
      if (active === null || active.paused === null) return null;
      const draft = pausedDraft(active);
      return draft === null ? null : { tracker: active.id, values: draft, domains: Object.keys(draft), remembered: pausedChoice.remembered };
    },
    /** Squash what changed while paused into one step now (Save, Share, a load or a dataset switch first). Returns its id or null. */
    settlePaused(meta = {}) {
      return exclusive(async () => {
        if (active === null || active.paused === null) return null;
        return squashPaused(active, byOf(meta))?.id ?? null;
      });
    },
    /** Put a paused draft back after a reopen (the autosave's), without a step: resuming squashes it. */
    restorePausedDraft(values) {
      return exclusive(async () => {
        const tracker = requireActive();
        if (tracker.paused === null) throw new Error('A paused draft goes back only into a paused tracker');
        await restoreTo({ ...headValues, ...values });
        notePaused(tracker);
      });
    },
    /** Pause or resume the recording of `tracker` (the one in use by default). */
    setRecording(on, options = {}) {
      return exclusive(() => setRecordingNow(on, options));
    },
    undo(meta = {}) {
      return exclusive(() => undoNow(meta));
    },
    redo(meta = {}) {
      return exclusive(() => redoNow(meta));
    },
    /** Show the state after `stepId` (any step of the tracker in use, on any branch). */
    jump(stepId, meta = {}) {
      return exclusive(() => jumpNow(stepId, meta));
    },
    /** Show another tracker and record into it. */
    useTracker(ref, meta = {}) {
      return exclusive(() => useTrackerNow(ref, meta));
    },
    /**
     * Undo one turn on the branch shown (§3.3.10): back to before its first
     * step (`onlyOwn` false, kept for redo), or only its own steps deleted
     * with their dependants applied again (journaled).
     */
    undoTurn(turnId, options = {}) {
      return exclusive(() => undoTurnNow(turnId, options));
    },
    /** What undoing a turn would do (the panel's two-choice dialog). */
    turnUndoPlan: turnId => turnUndoPlan(requireActive(), turnId),
    /** Delete a step (journaled; only its dependants applied again). */
    deleteStep(stepId, { signal = null, meta = {} } = {}) {
      return exclusive(() => deleteStepNow(requireActive(), stepId, { signal, meta }));
    },
    /** The steps a delete of `stepId` would apply again, and their recorded time (the dialog's estimate). */
    deletePlan(stepId) {
      const tracker = requireActive();
      const dependants = dependantsOf(tracker, stepNamed(tracker, stepId));
      return { reapply: dependants.map(step => step.id), ms: dependants.reduce((sum, step) => sum + (step.ms ?? 0), 0) };
    },
    /** What deleting a branch would do (the dialog's dry run, from the delete's own rule). */
    branchDeletePlan(ref, { withSubBranches = false, tracker: trackerRef = null } = {}) {
      const tracker = trackerRef === null ? requireActive() : trackerNamed(trackerRef);
      return describeBranchDelete(tracker, planBranchDelete(tracker, branchNamed(tracker, ref), { withSubBranches }));
    },
    /** Replay recorded steps in a new tracker (`{steps, from, name, mapping}`, `replay.js` `replayPlanOf`). */
    replay(plan, { signal = null, onStep = null, meta = {} } = {}) {
      if (!Array.isArray(plan?.steps)) throw new TypeError('A replay names the steps it applies');
      if (plan.from === null || typeof plan.from !== 'object' || typeof plan.from.tracker?.id !== 'string') {
        throw new TypeError('A replay names the tracker its steps come from (a Link)');
      }
      return exclusive(() => replayIntoNewTracker(plan, { signal, onStep, meta }));
    },
    /** What differs between two steps, domain by domain; the steps may be of two trackers. */
    async diff(a, b) {
      const ta = typeof a === 'string' ? requireActive() : trackerNamed(a.tracker ?? requireActive().id);
      const tb = typeof b === 'string' ? requireActive() : trackerNamed(b.tracker ?? requireActive().id);
      const sa = typeof a === 'string' ? a : a.step;
      const sb = typeof b === 'string' ? b : b.step;
      stepNamed(ta, sa);
      stepNamed(tb, sb);
      const va = valuesAt(ta, sa);
      const vb = valuesAt(tb, sb);
      const out = [];
      const context = { liveHidden: vb.views !== undefined && pool.get(vb.views)?.liveHidden === true };
      for (const id of DOMAIN_IDS) {
        if (va[id] === vb[id]) continue;
        const owner = domains.owner(id);
        const lines = typeof owner.describe === 'function' ? await owner.describe(pool.get(va[id]), pool.get(vb[id]), context) : ['changed'];
        out.push({ domain: id, lines });
      }
      return { common: ta === tb ? commonAncestor(ta, sa, sb) : null, domains: out };
    },
    /** One domain's value at a step of the tracker in use (or of `tracker`). */
    valueAt(stepId, domainId, trackerRef = null) {
      const tracker = trackerRef === null ? requireActive() : trackerNamed(trackerRef);
      return pool.get(valuesAt(tracker, stepId)[domainId]);
    },
    /**
     * Where the history's memory goes (History v2 §3.5, §3.15.4: "Highlights
     * at step 31: 8 MB"): each part that holds typed arrays no part before
     * it holds, largest first. A part is a domain's value a step brought
     * (`step`), what a Recently deleted entry keeps (`deleted`: its steps,
     * or a removed tracker's), a paused draft (`paused`), or what is shown
     * now and no step holds (`shown`). The bytes are the pool's own count
     * (`bytesAdded`), each buffer once, so they sum to `pool.byteLength()`.
     * A walk over every step, made when asked.
     *
     * @returns {{total: number, parts: Array<{bytes: number, kind: 'step'|'deleted'|'paused'|'shown',
     *   tracker: string|null, step: string|null, domain: string|null, label: string}>}}
     */
    memoryParts() {
      const order = [];
      const add = (hash, part) => order.push({ hash, part });
      const all = [...trackers.values()];
      // Steps first, in the order they were made (a value counts for the step that brought it).
      for (const tracker of all.filter(each => each.removed === null)) {
        for (const step of tracker.steps.values()) {
          for (const [domain, hash] of Object.entries(step.after)) {
            add(hash, { kind: 'step', tracker: tracker.id, step: step.id, domain, label: step.label });
          }
        }
      }
      for (const tracker of all) {
        if (tracker.removed !== null) {
          const label = `the removed tracker “${tracker.name}”`;
          for (const hash of referencedHashes({ ...tracker, journal: [] })) add(hash, { kind: 'deleted', tracker: tracker.id, step: null, domain: null, label });
        }
        for (const entry of tracker.journal) {
          if (entry.purged) continue;
          for (const step of [...entry.before.steps, ...entry.after.steps]) {
            for (const hash of stepHashes(step)) add(hash, { kind: 'deleted', tracker: tracker.id, step: null, domain: null, label: entry.label });
          }
        }
        for (const hash of Object.values(tracker.paused?.draft ?? {})) add(hash, { kind: 'paused', tracker: tracker.id, step: null, domain: null, label: 'changes made while paused' });
      }
      for (const [domain, hash] of [...Object.entries(shown), ...Object.entries(headValues)]) {
        add(hash, { kind: 'shown', tracker: active?.id ?? null, step: null, domain, label: 'what is shown now' });
      }
      const added = pool.bytesAdded(order.map(item => item.hash));
      // One part per step and domain, per Recently deleted entry, per draft.
      const parts = new Map();
      order.forEach(({ part }, index) => {
        if (added[index] === 0) return;
        const key = `${part.kind}\u0000${part.tracker}\u0000${part.step}\u0000${part.kind === 'step' || part.kind === 'shown' ? part.domain : part.label}`;
        const kept = parts.get(key);
        if (kept === undefined) parts.set(key, { ...part, bytes: added[index] }); else kept.bytes += added[index];
      });
      return { total: pool.byteLength(), parts: [...parts.values()].sort((a, b) => b.bytes - a.bytes) };
    },
    /** One domain's value as it is shown now (a domain switched off, or while paused, may differ from the head's). */
    shownValue(domainId) {
      requireActive();
      if (shown[domainId] === undefined) throw new RangeError(unknownDomainsMessage([domainId]));
      return pool.get(shown[domainId]);
    },
    /** The last step of the branch named `ref` (name or id) of the tracker in use. */
    tipNamed: ref => branchNamed(requireActive(), ref).tip,
    /** The branch of the tracker in use a step is on. */
    branchOf: stepId => branchOf(requireActive(), stepOf(requireActive(), stepId).branch),
    shownHashes: () => ({ ...shown }),
    headHashes: () => ({ ...headValues }),
    /** Stale steps on the path to the head (`provenance.js`). */
    stale(trackerRef = null) {
      const tracker = trackerRef === null ? requireActive() : trackerNamed(trackerRef);
      return staleOnPath(tracker, tracker.headId, read => branchMoved(read));
    },
    /** The steps that match (`search.js`). */
    search(criteria, trackerRef = null) {
      const tracker = trackerRef === null ? requireActive() : trackerNamed(trackerRef);
      const stale = new Set(staleOnPath(tracker, tracker.headId, read => branchMoved(read)).map(entry => entry.step.id));
      return searchSteps(tracker, criteria, { catalog, isStale: id => stale.has(id) });
    },
    /** The pending "Branch here", or null. */
    pending: () => (pending === null ? null : { ...pending }),
    /** What is running now that a move waits for (the panel's "Waiting for …"). */
    waitingFor: () => dispatcher.running?.() ?? [],
    async idle() {
      const quiet = tails => tails[0] === exclusiveTail && tails[1] === observedTail && pendingObserved.size === 0;
      for (;;) {
        const tails = [exclusiveTail, observedTail];
        await dispatcher.idle();
        await Promise.all([...tails, ...pendingObserved]);
        if (quiet(tails)) {
          await dispatcher.idle();
          if (quiet(tails)) return;
        }
      }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** The history as the model's `History` record (every tracker, removed ones included); the pool holds the values. */
    snapshot() {
      if (active !== null && active.paused !== null) active.paused.draft = pausedDraft(active);
      return {
        dataset: { id: dataset.id ?? null, name: dataset.name ?? null, cellOrder: dataset.cellOrder ?? null },
        activeTracker: active?.id ?? null,
        trackers: [...trackers.values()].map(trackerRecord),
      };
    },
    /** One tracker as the model's record. */
    trackerRecord: id => trackerRecord(trackerNamed(id, { removed: true })),
    setChat(trackerId, conversationId, transcript) {
      const tracker = trackers.get(trackerId);
      if (tracker === undefined) throw new RangeError(`There is no tracker "${trackerId}"`);
      if (typeof conversationId !== 'string' || conversationId.length === 0) throw new TypeError('A conversation id must be a non-empty string');
      tracker.chats.set(conversationId, structuredClone(transcript));
      notify('chat', { tracker: trackerId, conversation: conversationId });
    },
    chatsOf(trackerId) {
      const tracker = trackers.get(trackerId);
      if (tracker === undefined) throw new RangeError(`There is no tracker "${trackerId}"`);
      return [...tracker.chats];
    },
    /**
     * Load a saved history (`snapshot()`'s form) in place of the trackers:
     * the autosave's Continue, a saved state of this browser. Nothing changes
     * unless all of it loads.
     */
    load(saved, options = {}) {
      return exclusive(async () => {
        try {
          const { live, activeId, target } = await readSaved(saved, options);
          trackers.clear();
          for (const tracker of live) trackers.set(tracker.id, tracker);
          usedOrder = [];
          use(trackers.get(activeId));
          headValues = target;
          pending = null;
          coalesceStep = null;
        } finally {
          prune();
        }
        notify('loaded', {});
      });
    },
    /**
     * Load a session file's trackers beside the ones here (§3.3.7, Q2): each
     * says it was loaded (`start.kind 'import'` with the file; a replay keeps
     * its own start), gets a new id when its id is taken (every reference to
     * it remapped) and "(shared)" when its name is; the file's active
     * tracker is shown.
     */
    importTrackers(saved, { file, values = new Map(), rest = null, signal = null }) {
      if (typeof file !== 'string' || file.length === 0) throw new TypeError('An import names its file');
      return exclusive(async () => {
        let added;
        const loads = new Map();
        try {
          const { records: remapped, rest: reissuedRest } = reissue(saved.trackers);
          const activeIndex = saved.trackers.findIndex(record => record.id === saved.activeTracker);
          const taken = liveTrackers().map(tracker => tracker.name);
          const named = remapped.map((record, index) => {
            const name = record.removed === null ? suffixedName(record.name, 'shared', taken) : record.name;
            if (record.removed === null) taken.push(name);
            const start = record.start.kind === 'replay' ? record.start : {
              kind: 'import', report: null, mapping: null,
              from: {
                // The tracker as the file names it (its id there, before any re-issue here).
                dataset: { id: record.dataset.id, name: record.dataset.name }, tracker: { id: saved.trackers[index].id, name: saved.trackers[index].name },
                branch: null, step: null, file, saved: null,
              },
            };
            return { ...record, name, start };
          });
          const restHere = rest === null ? null : async () => reissuedRest(await rest());
          const { live, target } = await readSaved({ ...saved, activeTracker: named[activeIndex].id, trackers: named }, { values, rest: restHere, signal });
          for (const tracker of live) trackers.set(tracker.id, tracker);
          // Each tracker loaded beside the others is journaled: undoing the load removes it to Recently deleted.
          for (const tracker of live) {
            if (tracker.removed !== null) continue;
            const entry = commitEdit(beginEdit(tracker, { op: 'load', by: byOf({}), at: now(), label: `Loaded "${tracker.name}" from ${file}` }), { always: true });
            loads.set(tracker.id, entry.id);
          }
          const shownTracker = trackers.get(named[activeIndex].id);
          use(shownTracker);
          headValues = target;
          pending = null;
          coalesceStep = null;
          added = live.map(tracker => ({ id: tracker.id, name: tracker.name, journal: loads.get(tracker.id) ?? null }));
        } finally {
          prune();
        }
        notify('loaded', { added: added.map(each => each.id) });
        return { trackers: added, tracker: { id: active.id, name: active.name }, head: active.headId };
      });
    },
    destroy() {
      destroyed = true;
      stopOutside();
      removeOwnActions();
      listeners.clear();
      dispatcher.setRecorder(null);
      dispatcher.setGate(() => undefined);
    },
    get destroyed() { return destroyed; },
  };

  const removers = Object.entries(ownActions)
    .filter(([type]) => catalog?.has?.(type) === true)
    .map(([type, handler]) => dispatcher.provide(type, handler));
  for (const [type, estimate] of estimators) {
    if (catalog?.has?.(type) === true && typeof dispatcher.provideEstimate === 'function') removers.push(dispatcher.provideEstimate(type, estimate));
  }
  function removeOwnActions() {
    for (const remove of removers) remove();
  }
  dispatcher.setRecorder(recorder);
  dispatcher.setGate(() => exclusiveTail);
  // What an agent's or a notebook's turn does outside the state (a vote
  // published, a file written) makes no step, and no undo takes it back: its
  // turn record keeps it, so Undo turn and a shared history say what stays.
  const unsubscribeOutside = typeof dispatcher.subscribe === 'function' ? dispatcher.subscribe(event => {
    if (destroyed || event.kind !== 'done' || (event.step !== null && event.step !== undefined)) return;
    const meta = event.meta ?? {};
    if ((meta.origin !== 'agent' && meta.origin !== 'host') || typeof meta.turn !== 'string' || active === null) return;
    const definition = catalog?.has?.(event.type) ? catalog.get(event.type) : null;
    if (definition === null || outsideActOf(definition, event.params, event.outcome) === null) return;
    let label;
    try {
      label = definition.describe(event.params, event.outcome ?? null);
    } catch {
      label = definition.title;
    }
    const turn = noteTurnOutside(active, { type: event.type, label, at: now() }, meta, byOf(meta));
    if (turn !== null) notify('turn', { tracker: active.id, turn: turn.id });
  }) : () => {};
  stopOutside = unsubscribeOutside;
  return Object.freeze(api);
}

/** A squashed step's label from why it was made, how many it replaced and the domains it changes. */
function squashedLabelOf(cause, count, touches) {
  return squashedLabel({ cause, count, domains: touches.map(domainName) });
}
