/**
 * History trackers built from the contract's own constructors
 * (`app/history/model.js`), for the State panel's tests: steps appended at
 * the step shown with the history's branching rule (a step made where the
 * active branch does not end starts a new branch), undo and jumps,
 * "Branch here", groups, turns, notes, bookmarks, archived and locked
 * branches, and the recording switch. Every tracker it gives back is checked
 * whole by `validateTracker`.
 *
 * Values are not kept: each touched domain gets a fresh hash, so the graph,
 * the plans and the dialogs read real records without a page.
 */
import {
  FIRST_BRANCH_NAME, createBranch, createBy, createGroup, createNote, createStep, createTracker, createTurn,
  defaultName, idOf, validateTracker,
} from '../../assets/js/app/history/model.js';
import { DOMAIN_IDS } from '../../assets/js/app/actions/domains.js';

const hash = n => n.toString(16).padStart(64, '0');
const TRACKER_ID = 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10';

/**
 * @param {{name?: string, at?: number, recording?: boolean}} [options]
 */
export function trackerBuilder({ name = 'Tracker 1', at = Date.UTC(2026, 10, 4, 9, 12), recording = true } = {}) {
  let clock = at;
  let nextHash = 1;
  let by = createBy({ origin: 'user' });
  let pending = null;
  const rootValues = Object.fromEntries(DOMAIN_IDS.map(domain => [domain, hash(nextHash++)]));
  const tracker = createTracker({
    id: TRACKER_ID, name, dataset: { id: 'fixture', name: 'Fixture', cellOrder: null }, createdAt: clock, by, rootValues, recording,
  });
  const steps = new Map(tracker.steps.map(step => [step.id, step]));
  /** Branches made since the last build, added to the tracker's list then. */
  const fresh = new Set();
  const branches = new Map(tracker.branches.map(branch => [branch.id, branch]));
  const tick = () => { clock += 60_000; return clock; };

  function stepOf(id) {
    const step = steps.get(id);
    if (step === undefined) throw new RangeError(`no step ${id}`);
    return step;
  }

  function valueAt(stepId, domain) {
    for (let at = stepOf(stepId); at !== undefined; at = at.parent === null ? undefined : steps.get(at.parent)) {
      if (domain in at.after) return at.after[domain];
    }
    throw new RangeError(`no value of ${domain}`);
  }

  function newBranch(base, branchName = null) {
    const id = idOf('branch', tracker.nextBranch++);
    const record = createBranch({
      id, name: branchName ?? defaultName('Branch', idNumber(id), [...branches.values()].map(each => each.name)),
      base, tip: base, createdAt: clock, by,
    });
    branches.set(id, record);
    fresh.add(id);
    return record;
  }

  const api = {
    get tracker() { return tracker; },
    get head() { return tracker.headId; },
    /** Who takes the next steps (`createBy` fields); `turn` names an agent's or a notebook's turn. */
    as(fields, turnLabel = 'Do something') {
      by = createBy(fields);
      if (by.turn !== null && !tracker.turns.some(turn => turn.id === by.turn)) {
        tracker.turns.push(createTurn({ id: by.turn, by, label: turnLabel, startedAt: clock, branch: tracker.activeBranch }));
      }
      return api;
    },
    /**
     * Append a step at the step shown: on the active branch when the head is
     * its tip and it is not locked, else on a new branch from the head.
     * @param {string} label
     * @param {{type?: string, touches?: string[], params?: object, kind?: string, squashed?: object}} [fields]
     * @returns {string} its id
     */
    step(label, { type = 'color.by', touches = ['active-field'], params = {}, kind = 'action', squashed = null } = {}) {
      const head = stepOf(tracker.headId);
      let branch = branches.get(tracker.activeBranch);
      if (pending !== null || branch.tip !== head.id || branch.locked) {
        branch = newBranch(head.id, pending);
        pending = null;
        tracker.activeBranch = branch.id;
      } else if (branch.archived) {
        branch.archived = false;
      }
      const id = idOf('step', tracker.nextStep++);
      const before = Object.fromEntries(touches.map(domain => [domain, valueAt(head.id, domain)]));
      const after = Object.fromEntries(touches.map(domain => [domain, hash(nextHash++)]));
      const step = createStep({
        id, parent: head.id, branch: branch.id, kind, label, by, at: tick(), touches, before, after,
        ...(kind === 'action' ? { type, params, v: 1, code: `${type}()` } : {}),
        ...(kind === 'squashed' ? { squashed } : {}),
      });
      head.children.push(id);
      steps.set(id, step);
      tracker.steps.push(step);
      branch.tip = id;
      tracker.headId = id;
      const turn = tracker.turns.find(each => each.id === by.turn);
      if (turn !== undefined) turn.endedAt = clock;
      return id;
    },
    /** `count` steps at once, labeled `${label} ${i}`; returns their ids. */
    steps(count, label, fields) {
      return Array.from({ length: count }, (_, index) => api.step(`${label} ${index + 1}`, fields));
    },
    undo(count = 1) {
      for (let n = 0; n < count; n++) tracker.headId = stepOf(tracker.headId).parent;
      return api;
    },
    /** Show a step: the active branch stays when it holds it on its path, else becomes the step's branch. */
    jump(id) {
      const target = stepOf(id);
      const tip = branches.get(tracker.activeBranch).tip;
      let onPath = false;
      for (let at = steps.get(tip); at !== undefined; at = at.parent === null ? undefined : steps.get(at.parent)) {
        if (at.id === id) { onPath = true; break; }
      }
      if (!onPath) tracker.activeBranch = target.branch;
      tracker.headId = id;
      return api;
    },
    /** "Branch here": the next step starts a branch named `name` (or the next default name). */
    branchHere(id, branchName = null) {
      api.jump(id);
      pending = branchName;
      return api;
    },
    branchOf(stepId) { return stepOf(stepId).branch; },
    branchNamed(branchName) { return [...branches.values()].find(each => each.name === branchName); },
    rename(branchId, branchName) { branches.get(branchId).name = branchName; return api; },
    archive(branchId) { branches.get(branchId).archived = true; return api; },
    lock(branchId) { branches.get(branchId).locked = true; return api; },
    main(branchId) { tracker.mainBranch = branchId; return api; },
    group(from, to, groupName) {
      const id = idOf('group', tracker.nextGroup++);
      tracker.groups.push(createGroup({ id, name: groupName, createdAt: clock, by }));
      const ids = [];
      for (let at = stepOf(to); ; at = stepOf(at.parent)) {
        ids.push(at.id);
        if (at.id === from) break;
      }
      for (const stepId of ids) stepOf(stepId).group = id;
      return id;
    },
    note(stepId, text) {
      const id = idOf('note', tracker.nextNote++);
      stepOf(stepId).notes.push(createNote({ id, text, by, at: clock }));
      return id;
    },
    bookmark(stepId, bookmarkName) { stepOf(stepId).bookmark = bookmarkName; return api; },
    flag(stepId, reason) { Object.assign(stepOf(stepId), { status: 'unapplicable', reason }); return api; },
    pause() { tracker.paused = { at: clock, by: [by], draft: null }; return api; },
    resume() { tracker.paused = null; return api; },
    /** The tracker, checked whole. */
    build() {
      // The tracker's own list is the truth for the branches it has (an edit
      // may have removed one); the branches made here since are added to it.
      for (const id of fresh) if (!tracker.branches.some(record => record.id === id)) tracker.branches.push(branches.get(id));
      fresh.clear();
      branches.clear();
      for (const record of tracker.branches) branches.set(record.id, record);
      tracker.branches.sort((a, b) => idNumber(a.id) - idNumber(b.id));
      return validateTracker(tracker);
    },
  };
  return api;
}

function idNumber(id) {
  return Number(id.slice(1));
}

export { FIRST_BRANCH_NAME };
