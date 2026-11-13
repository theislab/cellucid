/**
 * @fileoverview Branches, groups and bookmarks of one tracker: naming them,
 * finding them by name or id, where a new step goes, and the structural
 * edits (delete a branch, take a step out, squash a run, group a run) as
 * pure changes of the live records (`tree.js`), each told to the edit that
 * journals it (`journal.js`). No page: values are never read here, only their hashes.
 *
 * @module app/history/branches
 */

import { ActionRefused } from '../actions/dispatcher.js';
import {
  createBranch, createGroup, defaultName, HISTORY_ID_PATTERNS, HISTORY_SENTENCES, idNumber, idOf,
  nameKey, nameProblem, normalizeName, sameBy, squashedLabel, suffixedName,
} from './model.js';
import {
  branchOf, branchSteps, branchesForkingAt, detachSteps, isOnPath, orderedDomains, pathBetween,
  stepOf, valuesAt,
} from './tree.js';

const refuse = (message, code) => new ActionRefused(message, { code });

// ---------------------------------------------------------------------------
// Names

/** A name made ready for `kind`, or a refusal (`name-invalid`) saying why it cannot be one. */
export function checkedName(kind, text) {
  const problem = nameProblem(kind, text);
  if (problem !== null) throw refuse(problem, 'name-invalid');
  return normalizeName(text);
}

/** Refuse a name another branch has (by key), naming it. */
function requireFreeBranchName(tracker, name, exceptId = null) {
  const key = nameKey(name);
  for (const branch of tracker.branches.values()) {
    if (branch.id !== exceptId && nameKey(branch.name) === key) {
      const where = branch.base === null ? null : `from step ${idNumber(branch.base)}`;
      throw refuse(HISTORY_SENTENCES.nameTaken({ kind: 'branch', name: branch.name, where }), 'name-taken');
    }
  }
}

function requireFreeGroupName(tracker, name, exceptId = null) {
  const key = nameKey(name);
  for (const group of tracker.groups.values()) {
    if (group.id !== exceptId && nameKey(group.name) === key) {
      throw refuse(HISTORY_SENTENCES.nameTaken({ kind: 'group', name: group.name }), 'name-taken');
    }
  }
}

/** The default name of the next branch: "Branch <nextBranch>", skipping names taken. */
function nextBranchName(tracker) {
  return defaultName('Branch', tracker.nextBranch, [...tracker.branches.values()].map(branch => branch.name));
}

/** A branch named or numbered `ref` (`b3` or its name, any case), or a refusal naming the branches. */
export function branchNamed(tracker, ref) {
  if (HISTORY_ID_PATTERNS.branch.test(ref) && tracker.branches.has(ref)) return tracker.branches.get(ref);
  const key = nameKey(ref);
  for (const branch of tracker.branches.values()) if (nameKey(branch.name) === key) return branch;
  throw refuse(HISTORY_SENTENCES.noBranch({ ref, names: [...tracker.branches.values()].map(branch => branch.name) }), 'no-target');
}

/** A group named or numbered `ref`, or a refusal naming the groups. */
export function groupNamed(tracker, ref) {
  if (HISTORY_ID_PATTERNS.group.test(ref) && tracker.groups.has(ref)) return tracker.groups.get(ref);
  const key = nameKey(ref);
  for (const group of tracker.groups.values()) if (nameKey(group.name) === key) return group;
  throw refuse(HISTORY_SENTENCES.noGroup({ ref, names: [...tracker.groups.values()].map(group => group.name) }), 'no-target');
}

/** A step of `tracker` by id, or a refusal naming it. */
export function stepNamed(tracker, stepId) {
  const step = tracker.steps.get(stepId);
  if (step === undefined) throw refuse(HISTORY_SENTENCES.noStep({ step: stepId, tracker: tracker.name }), 'no-such-step');
  return step;
}

/** The step bookmarked `name` (any case): its own bookmark, or one a squash carried onto it; or null. */
export function bookmarked(tracker, name) {
  const key = nameKey(name);
  for (const step of tracker.steps.values()) {
    if (step.bookmark !== null && nameKey(step.bookmark) === key) return step;
    if (step.squashed?.carried.bookmarks.some(each => nameKey(each) === key)) return step;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where a new step goes

/**
 * The branch a step appended at the head goes on: the active branch when the
 * head is its tip and it is not locked and no "Branch here" is pending, else
 * a new branch from the head (named the pending name, an agent's "Claude:
 * <label>", or the next "Branch n"). Returns `{branch, made, sentence}`;
 * `made` is the new branch's record (not yet in the tracker), `sentence` what
 * the status line says once (a locked branch's change started another).
 *
 * @param {object} tracker
 * @param {{pending: {name: string|null, from: string}|null, by: object, label: string, at: number|null, stepId: string}} facts
 */
export function branchForNewStep(tracker, { pending, by, label, at, stepId }) {
  const active = branchOf(tracker, tracker.activeBranch);
  if (pending === null && active.tip === tracker.headId && !active.locked) return { branch: active.id, made: null, sentence: null };
  const id = idOf('branch', tracker.nextBranch);
  let name = pending?.name ?? null;
  if (name === null && by.origin === 'agent') {
    name = suffixedName(`${by.agent}: ${label}`, 'more', [...tracker.branches.values()].map(branch => branch.name));
    if (nameProblem('branch', name) !== null) name = null;
  }
  if (name === null) name = nextBranchName(tracker);
  const made = createBranch({ id, name, base: tracker.headId, tip: stepId, createdAt: at, by });
  const sentence = pending === null && active.locked && active.tip === tracker.headId
    ? HISTORY_SENTENCES.lockedStarted({ name: active.name, started: name })
    : null;
  return { branch: id, made, sentence };
}

/** Put a step made by `branchForNewStep` on its branch (the tracker's counters, tip, active branch). */
export function placeStep(tracker, { branch, made }, step) {
  if (made !== null) {
    tracker.branches.set(made.id, made);
    tracker.nextBranch = idNumber(made.id) + 1;
  }
  const record = branchOf(tracker, branch);
  record.tip = step.id;
  // A change at an archived branch's tip continues it and shows it again.
  if (record.archived) record.archived = false;
  tracker.activeBranch = branch;
  tracker.headId = step.id;
}

// ---------------------------------------------------------------------------
// Moves

/**
 * The active branch after the head moves to `stepId`: `branchId` (the
 * active one by default) when the step is on its path (an archived one only
 * while the head is on its own steps), else the step's branch.
 */
export function activeBranchAt(tracker, stepId, branchId = tracker.activeBranch) {
  const active = tracker.branches.get(branchId);
  const own = stepOf(tracker, stepId).branch;
  if (active !== undefined && isOnPath(tracker, stepId, active.tip) && (!active.archived || own === active.id)) return active.id;
  return own;
}

/** After steps were taken out: the active branch as `activeBranchAt` says for the head, told to `edit` when it changes. */
function settleActiveBranch(tracker, edit) {
  const kept = activeBranchAt(tracker, tracker.headId);
  if (kept !== tracker.activeBranch) {
    edit.field('activeBranch');
    tracker.activeBranch = kept;
  }
}

// ---------------------------------------------------------------------------
// Renames and flags

export function renameBranch(tracker, edit, branch, text) {
  if (branch.locked) throw refuse(HISTORY_SENTENCES.locked({ name: branch.name }), 'locked');
  const name = checkedName('branch', text);
  requireFreeBranchName(tracker, name, branch.id);
  edit.branch(branch.id);
  branch.name = name;
}

export function archiveBranch(tracker, edit, branch, archived) {
  if (archived && branch.id === tracker.mainBranch) throw refuse(HISTORY_SENTENCES.mainBranch(), 'main-branch');
  edit.branch(branch.id);
  branch.archived = archived;
  if (archived && tracker.activeBranch === branch.id && stepOf(tracker, tracker.headId).branch !== branch.id) {
    // The model keeps an archived active branch only while the head is on it.
    edit.field('activeBranch');
    tracker.activeBranch = stepOf(tracker, tracker.headId).branch;
  }
}

export function setMainBranch(tracker, edit, branch) {
  if (branch.archived) {
    edit.branch(branch.id);
    branch.archived = false;
  }
  edit.field('mainBranch');
  tracker.mainBranch = branch.id;
}

export function lockBranch(tracker, edit, branch, locked) {
  edit.branch(branch.id);
  branch.locked = locked;
}

// ---------------------------------------------------------------------------
// Bookmarks

export function setBookmark(tracker, edit, step, text) {
  if (text === null) {
    edit.step(step.id);
    step.bookmark = null;
    return null;
  }
  const name = checkedName('bookmark', text);
  const other = bookmarked(tracker, name);
  if (other !== null && (other.id !== step.id || nameKey(other.bookmark ?? '') !== nameKey(name))) {
    throw refuse(HISTORY_SENTENCES.bookmarkTaken({ name, step: other.id }), 'name-taken');
  }
  edit.step(step.id);
  step.bookmark = name;
  return name;
}

// ---------------------------------------------------------------------------
// Groups

/** The steps from `fromId` to `toId` when they are consecutive steps of one branch's own steps, else a refusal. */
function runOf(tracker, fromId, toId) {
  const from = stepNamed(tracker, fromId);
  const to = stepNamed(tracker, toId);
  const fail = () => refuse(HISTORY_SENTENCES.notConsecutive({ from: fromId, to: toId }), 'not-consecutive');
  if (from.parent === null || from.branch !== to.branch || !isOnPath(tracker, from.id, to.id)) throw fail();
  const run = [from, ...pathBetween(tracker, from.id, to.id)];
  if (run.some(step => step.branch !== from.branch)) throw fail();
  return run;
}

/** Refuse a run that holds part of a turn, naming the run widened to whole turns. */
function requireWholeTurns(tracker, run) {
  const inside = new Set(run.map(step => step.id));
  const turns = new Set(run.map(step => step.by.turn).filter(turn => turn !== null));
  if (turns.size === 0) return;
  const branch = run[0].branch;
  const own = branchSteps(tracker, branch);
  let first = idNumber(run[0].id);
  let last = idNumber(run[run.length - 1].id);
  let split = null;
  for (const step of own) {
    if (step.by.turn !== null && turns.has(step.by.turn) && !inside.has(step.id)) {
      split ??= tracker.turns.get(step.by.turn)?.label ?? step.by.turn;
      first = Math.min(first, idNumber(step.id));
      last = Math.max(last, idNumber(step.id));
    }
  }
  if (split !== null) throw refuse(HISTORY_SENTENCES.splitsTurn({ label: split, from: `s${first}`, to: `s${last}` }), 'splits-turn');
}

export function createGroupOver(tracker, edit, { from, to, name: text, by, at }) {
  const run = runOf(tracker, from, to);
  const name = checkedName('group', text);
  requireFreeGroupName(tracker, name);
  const grouped = run.find(step => step.group !== null);
  if (grouped !== undefined) throw refuse(HISTORY_SENTENCES.inGroup({ step: grouped.id, name: tracker.groups.get(grouped.group).name }), 'in-group');
  requireWholeTurns(tracker, run);
  const id = idOf('group', tracker.nextGroup);
  edit.group(id);
  edit.membership(id);
  tracker.groups.set(id, createGroup({ id, name, createdAt: at, by }));
  tracker.nextGroup++;
  for (const step of run) step.group = id;
  return { group: tracker.groups.get(id), steps: run.length };
}

/** A group's steps, first first (consecutive steps of one branch). */
function groupSteps(tracker, groupId) {
  const members = [...tracker.steps.values()].filter(step => step.group === groupId);
  return members.sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export function renameGroup(tracker, edit, group, text) {
  const name = checkedName('group', text);
  requireFreeGroupName(tracker, name, group.id);
  edit.group(group.id);
  group.name = name;
}

export function extendGroup(tracker, edit, group, toId) {
  const members = groupSteps(tracker, group.id);
  const last = members[members.length - 1];
  const to = stepNamed(tracker, toId);
  // A step it holds already (its last one, one before, or a later step of a turn of it, which joined it).
  if (to.group === group.id) throw refuse(HISTORY_SENTENCES.alreadyInGroup({ step: to.id, name: group.name }), 'already-in-group');
  if (to.branch !== last.branch || !isOnPath(tracker, last.id, to.id)) {
    throw refuse(HISTORY_SENTENCES.notConsecutive({ from: members[0].id, to: toId }), 'not-consecutive');
  }
  const added = runOf(tracker, members[0].id, toId).slice(members.length);
  const grouped = added.find(step => step.group !== null);
  if (grouped !== undefined) throw refuse(HISTORY_SENTENCES.inGroup({ step: grouped.id, name: tracker.groups.get(grouped.group).name }), 'in-group');
  requireWholeTurns(tracker, [...members, ...added]);
  edit.membership(group.id);
  for (const step of added) step.group = group.id;
  return members.length + added.length;
}

export function removeGroup(tracker, edit, group) {
  edit.membership(group.id);
  for (const step of groupSteps(tracker, group.id)) step.group = null;
  edit.group(group.id);
  tracker.groups.delete(group.id);
}

/** Remove the groups left with no step (after steps were taken out), telling the edit. */
function dropEmptyGroups(tracker, edit) {
  const used = new Set();
  for (const step of tracker.steps.values()) if (step.group !== null) used.add(step.group);
  const removed = [];
  for (const group of [...tracker.groups.values()]) {
    if (used.has(group.id)) continue;
    edit.group(group.id);
    tracker.groups.delete(group.id);
    removed.push({ id: group.id, name: group.name });
  }
  return removed;
}

/** Remove the turns left with no step (and nothing done outside the state), and point each other turn at the branch of its last step if its own went. */
function settleTurns(tracker, edit) {
  const last = new Map();
  for (const step of tracker.steps.values()) {
    if (step.by.turn === null) continue;
    const seen = last.get(step.by.turn);
    if (seen === undefined || idNumber(step.id) > idNumber(seen.id)) last.set(step.by.turn, step);
  }
  for (const turn of [...tracker.turns.values()]) {
    const step = last.get(turn.id);
    if (step === undefined && turn.outside.length === 0) {
      edit.turn(turn.id);
      tracker.turns.delete(turn.id);
    } else if (!tracker.branches.has(turn.branch)) {
      // What it did outside the state stays on record: on its last step's branch, else the one shown.
      edit.turn(turn.id);
      turn.branch = step?.branch ?? tracker.activeBranch;
    }
  }
}

// ---------------------------------------------------------------------------
// Taking steps out (delete a step, delete a branch, squash)

/**
 * Take `stepIds` out of the tracker (each re-hanging its children on its
 * parent), keeping every branch a line from its fork step to its tip:
 * a tip moves to its parent on the branch; a branch with no step left is
 * removed; a fork step moves to the parent. The head, when taken out, moves
 * to the nearest step left on its path, and the active branch to a branch
 * still holding it. Groups and turns left empty go. Every record changed is
 * told to `edit`. Returns the branches removed.
 *
 * @param {object} tracker
 * @param {object} edit
 * @param {string[]} stepIds - in any order; the root is never among them
 */
export function takeOut(tracker, edit, stepIds) {
  const gone = new Set(stepIds);
  // Bottom-up, so each step's parent is still there when it is taken out.
  const ordered = [...gone].sort((a, b) => idNumber(b) - idNumber(a));
  let head = tracker.headId;
  while (gone.has(head)) head = stepOf(tracker, head).parent;
  for (const id of ordered) {
    const step = stepOf(tracker, id);
    edit.step(id);
    edit.step(step.parent);
    for (const child of step.children) edit.step(child);
    for (const branch of tracker.branches.values()) {
      if (branch.tip === id || branch.base === id) edit.branch(branch.id);
    }
    for (const branch of tracker.branches.values()) if (branch.base === id) branch.base = step.parent;
    const own = tracker.branches.get(step.branch);
    if (own !== undefined && own.tip === id) {
      // The tip moves to the nearest step of its own left above it (or the branch empties).
      let parent = stepOf(tracker, step.parent);
      while (gone.has(parent.id) && parent.branch === own.id) parent = stepOf(tracker, parent.parent);
      own.tip = parent.branch === own.id ? parent.id : null;
    }
  }
  // Every step taken out at once: the depths below are computed again once.
  detachSteps(tracker, ordered);
  const removed = [];
  for (const branch of [...tracker.branches.values()]) {
    if (branch.tip !== null) continue;
    edit.branch(branch.id);
    tracker.branches.delete(branch.id);
    removed.push({ id: branch.id, name: branch.name });
  }
  // A branch whose fork step became one of its own steps' (its base re-hung onto its own line) cannot be: it
  // never happens, since a base moves to its parent, which is never on the branch it starts.
  if (head !== tracker.headId) {
    edit.field('headId');
    tracker.headId = head;
  }
  settleActiveBranch(tracker, edit);
  dropEmptyGroups(tracker, edit);
  settleTurns(tracker, edit);
  return removed;
}

/**
 * What deleting branch X would do, from the same rule the delete follows,
 * with nothing changed: the steps it removes, the branch that
 * keeps its shared steps, the branches deleted with it, and where the head
 * would be. Main and locked branches are refused.
 *
 * @param {object} tracker
 * @param {object} branch
 * @param {{withSubBranches?: boolean}} [options]
 */
export function planBranchDelete(tracker, branch, { withSubBranches = false } = {}) {
  if (branch.id === tracker.mainBranch) throw refuse(HISTORY_SENTENCES.mainBranch(), 'main-branch');
  const branches = [branch];
  if (withSubBranches) {
    // Every branch whose fork step is in the subtree of X's steps.
    for (let i = 0; i < branches.length; i++) {
      for (const step of branchSteps(tracker, branches[i].id)) {
        for (const child of branchesForkingAt(tracker, step.id)) if (!branches.includes(child)) branches.push(child);
      }
    }
  }
  for (const each of branches) {
    if (each.id === tracker.mainBranch) throw refuse(HISTORY_SENTENCES.mainBranch(), 'main-branch');
    if (each.locked) throw refuse(HISTORY_SENTENCES.locked({ name: each.name }), 'locked');
  }
  const deleted = new Set(branches.map(each => each.id));
  const own = branchSteps(tracker, branch.id);
  let removed;
  let absorber = null;
  let kept = [];
  if (withSubBranches) {
    removed = branches.flatMap(each => branchSteps(tracker, each.id));
  } else {
    // The last of X's steps another branch forks from: it and those before stay, with that branch.
    let lastBase = -1;
    own.forEach((step, index) => {
      const forks = branchesForkingAt(tracker, step.id).filter(child => !deleted.has(child.id));
      if (forks.length > 0) lastBase = index;
    });
    if (lastBase >= 0) {
      kept = own.slice(0, lastBase + 1);
      absorber = branchesForkingAt(tracker, own[lastBase].id).sort((a, b) => idNumber(a.id) - idNumber(b.id))[0];
    }
    removed = own.slice(lastBase + 1);
  }
  if (branch.base === null && kept.length === 0) {
    // The branch holding the root keeps the root: it is never removed.
    throw refuse(HISTORY_SENTENCES.mainBranch(), 'main-branch');
  }
  const gone = new Set(removed.map(step => step.id));
  let head = tracker.headId;
  while (gone.has(head)) head = stepOf(tracker, head).parent;
  return { branches, removed, kept, absorber, head };
}

/** Delete a branch as planned (`planBranchDelete`): the kept steps join the absorbing branch, the rest go. */
export function applyBranchDelete(tracker, edit, plan) {
  const { branch } = { branch: plan.branches[0] };
  if (plan.absorber !== null) {
    edit.branch(plan.absorber.id);
    edit.branch(branch.id);
    for (const step of plan.kept) {
      edit.step(step.id);
      step.branch = plan.absorber.id;
    }
    plan.absorber.base = branch.base;
    // The branch's own steps now end where the absorber's begin; X keeps only the removed ones.
    branch.tip = plan.removed.length > 0 ? branch.tip : null;
  }
  const removed = takeOut(tracker, edit, plan.removed.map(step => step.id));
  for (const each of plan.branches) {
    if (!tracker.branches.has(each.id)) continue;
    edit.branch(each.id);
    tracker.branches.delete(each.id);
    removed.push({ id: each.id, name: each.name });
  }
  settleActiveBranch(tracker, edit);
  settleTurns(tracker, edit);
  return removed;
}

/**
 * Check a run to squash: consecutive steps of one branch, with no
 * branch starting inside it but at its last step, inside one group or
 * covering whole groups; an agent squashes only its own turn's steps.
 * Returns the run.
 */
export function squashableRun(tracker, fromId, toId, by) {
  const run = runOf(tracker, fromId, toId);
  const forks = [];
  let upTo = null;
  for (const step of run.slice(0, -1)) {
    const starting = branchesForkingAt(tracker, step.id);
    if (starting.length > 0) {
      upTo ??= step.id;
      forks.push(...starting.map(branch => branch.name));
    }
  }
  if (forks.length > 0) throw refuse(HISTORY_SENTENCES.forksInside({ names: forks, upTo }), 'forks-inside');
  const branch = branchOf(tracker, run[0].branch);
  if (branch.locked) throw refuse(HISTORY_SENTENCES.locked({ name: branch.name }), 'locked');
  const groups = [...new Set(run.map(step => step.group))];
  const inOne = groups.length === 1 && groups[0] !== null;
  if (!inOne) {
    for (const group of groups) {
      if (group === null) continue;
      const members = groupSteps(tracker, group);
      if (!members.every(step => run.includes(step))) {
        throw refuse(HISTORY_SENTENCES.inGroup({ step: run.find(step => step.group === group).id, name: tracker.groups.get(group).name }), 'in-group');
      }
    }
  }
  if (by.origin === 'agent' && run.some(step => step.by.origin !== 'agent' || step.by.agent !== by.agent || step.by.turn === null)) {
    throw refuse(HISTORY_SENTENCES.notOwnSteps(), 'not-author');
  }
  return run;
}

/** Each author once, in the order they first acted. */
export function authorsOf(steps) {
  const out = [];
  for (const step of steps) {
    const authors = step.kind === 'squashed' ? step.squashed.by : [step.by];
    for (const by of authors) if (!out.some(other => sameBy(other, by))) out.push({ ...by });
  }
  return out;
}

/** How many recorded steps a run stands for: a squashed step counts the steps it replaced. */
function countOf(run) {
  return run.reduce((sum, step) => sum + (step.kind === 'squashed' ? (step.squashed.count ?? 1) : 1), 0);
}

/**
 * Replace a run (`squashableRun`) with one squashed step that keeps the
 * run's LAST id (the one exception to "ids are never reused": the steps
 * after it and the branches that start at it keep their parent): from the
 * first one's state to the last one's, the notes of every step moved onto it
 * (each marked with its step), the last bookmark. The head inside the run
 * moves to it. A run inside one group stays in it; groups it covers whole
 * go. Returns `{step, groupsRemoved}`.
 *
 * @param {object} tracker
 * @param {object} edit
 * @param {object[]} run
 * @param {{cause?: string, by: object, domainName: (domain: string) => string}} options -
 *   `domainName`: the name a label uses ("Colors")
 */
export function squashRun(tracker, edit, run, { cause = 'steps', by, domainName }) {
  const first = run[0];
  const last = run[run.length - 1];
  const before = valuesAt(tracker, first.parent);
  const after = valuesAt(tracker, last.id);
  const touches = orderedDomains(Object.keys(after).filter(domain => after[domain] !== before[domain]));
  const authors = authorsOf(run);
  const oneTurn = authors.length === 1 && authors[0].turn !== null;
  const groups = [...new Set(run.map(step => step.group))];
  const keepGroup = groups.length === 1 && groups[0] !== null && !groupSteps(tracker, groups[0]).every(step => run.includes(step))
    ? groups[0] : null;
  const whole = groups.filter(group => group !== null && group !== keepGroup);
  for (const step of run) edit.step(step.id);
  edit.step(first.parent);
  // The replaced steps' notes become its own (they keep their ids) and their bookmarks are carried:
  // jumping to one shows it.
  const notes = run.flatMap(step => step.notes);
  const carried = cause === 'steps' ? {
    // A squashed step's carried notes are among its own notes already.
    notes: [...new Set(run.flatMap(step => step.notes.map(note => note.id)))],
    bookmarks: run.flatMap(step => [...(step.bookmark === null ? [] : [step.bookmark]), ...(step.kind === 'squashed' ? step.squashed.carried.bookmarks : [])]),
  } : { notes: [], bookmarks: [] };
  const merged = run.reduce((sum, step) => sum + step.merged, 0);
  const ms = run.every(step => step.ms === null) ? null : run.reduce((sum, step) => sum + (step.ms ?? 0), 0);
  const squashed = { cause, count: cause === 'paused' || cause === 'share' ? null : countOf(run), by: authors, carried };
  const parent = first.parent;
  // Take out every step of the run but the last, bottom-up; the last hangs on the run's parent then.
  detachSteps(tracker, run.slice(0, -1).map(step => step.id));
  Object.assign(last, {
    kind: 'squashed', type: null, params: null, v: null, code: null,
    label: squashedLabel({ cause, count: squashed.count, domains: touches.map(domainName) }),
    by: oneTurn ? { ...authors[0] } : { ...by }, at: first.at, until: last.until, merged, ms, touches,
    before: Object.fromEntries(touches.map(domain => [domain, before[domain]])),
    after: Object.fromEntries(touches.map(domain => [domain, after[domain]])),
    reads: {}, status: 'applied', reason: null, outcome: null, coalesceKey: null, replayOf: null, squashed,
    notes, bookmark: null, group: keepGroup,
  });
  if (last.parent !== parent) throw new Error('A squashed run must hang from its first step\'s parent');
  if (run.some(step => step.id === tracker.headId)) {
    edit.field('headId');
    tracker.headId = last.id;
  }
  const groupsRemoved = [];
  for (const group of whole) {
    edit.group(group);
    groupsRemoved.push({ id: group, name: tracker.groups.get(group).name });
    tracker.groups.delete(group);
  }
  dropEmptyGroups(tracker, edit);
  settleTurns(tracker, edit);
  return { step: last, groupsRemoved };
}
