/**
 * @fileoverview One tracker held live: the History v2 records (`model.js`)
 * by id, with the indexes that keep every read and move from growing with
 * the whole history. Pure data, no page.
 *
 * A live tracker has every field of the model's `Tracker`, except that its
 * `steps`, `branches`, `groups` and `turns` are Maps by id and its `chats` a
 * Map by conversation. Each step, branch, group and turn held is exactly the
 * model's record (plain JSON), so `trackerRecord` gives the model's tracker
 * and `liveTracker` takes one back.
 *
 * **Indexes** (kept beside the records, never in them): the depth of every
 * step, so a common ancestor, "is A before B on one path" and a jump's path
 * cost the steps between the two, never the depth; and nothing else to keep
 * current. The value of a domain at a step is the after-value of the nearest
 * step on the path from the root that touched it (`valuesAt`, the plain
 * reading every other reading is checked against); a move computes it from
 * where it is (`valuesFrom`: undo each step above the common ancestor by its
 * before-values, then apply each step below it by its after-values), which
 * is exact because a step's before-values are its parent's values for the
 * domains it touches.
 *
 * Walks are loops, never recursion, so a history of any depth reads.
 *
 * @module app/history/tree
 */

import { DOMAIN_IDS } from '../actions/domains.js';
import { createTracker, idNumber, validateTracker } from './model.js';

/** @type {WeakMap<object, {depth: Map<string, number>}>} */
const INDEXES = new WeakMap();

function indexOf(tracker) {
  let index = INDEXES.get(tracker);
  if (index === undefined) {
    index = { depth: new Map() };
    INDEXES.set(tracker, index);
    reindex(tracker);
  }
  return index;
}

/** Compute every step's depth again (after a structural edit that re-hung steps). */
export function reindex(tracker) {
  const index = INDEXES.get(tracker) ?? { depth: new Map() };
  INDEXES.set(tracker, index);
  index.depth.clear();
  const stack = [[tracker.rootId, 0]];
  while (stack.length > 0) {
    const [id, depth] = stack.pop();
    index.depth.set(id, depth);
    const step = tracker.steps.get(id);
    for (let i = step.children.length - 1; i >= 0; i--) stack.push([step.children[i], depth + 1]);
  }
}

/** Copy a record whose nested lists and maps a later edit may change (steps, branches, groups, turns, notes). */
export function copyRecord(record) {
  return structuredClone(record);
}

/**
 * A step record copied for keeping (a journal patch, a snapshot): its lists
 * and maps copied, its params and outcome shared (they are never changed
 * once recorded).
 */
export function copyStep(step) {
  return {
    ...step,
    children: [...step.children],
    by: { ...step.by },
    touches: [...step.touches],
    before: { ...step.before },
    after: { ...step.after },
    reads: structuredClone(step.reads),
    squashed: step.squashed === null ? null : structuredClone(step.squashed),
    notes: structuredClone(step.notes),
  };
}

/**
 * A live tracker from a model `Tracker` record (validated first). The records
 * are copied, so the record given stays the caller's.
 * @param {object} record
 */
export function liveTracker(record) {
  validateTracker(record);
  const tracker = {
    ...record,
    by: { ...record.by },
    start: structuredClone(record.start),
    removed: record.removed === null ? null : structuredClone(record.removed),
    paused: record.paused === null ? null : structuredClone(record.paused),
    dataset: structuredClone(record.dataset),
    branches: new Map(record.branches.map(branch => [branch.id, copyRecord(branch)])),
    groups: new Map(record.groups.map(group => [group.id, copyRecord(group)])),
    steps: new Map(record.steps.map(step => [step.id, copyStep(step)])),
    turns: new Map(record.turns.map(turn => [turn.id, copyRecord(turn)])),
    notes: structuredClone(record.notes),
    journal: record.journal.map(entry => structuredClone(entry)),
    chats: new Map(record.chats.map(([id, transcript]) => [id, structuredClone(transcript)])),
  };
  reindex(tracker);
  return tracker;
}

/** A new live tracker (`model.js` `createTracker`'s fields). */
export function newTracker(fields) {
  return liveTracker(createTracker(fields));
}

const byNumber = (a, b) => idNumber(a.id) - idNumber(b.id);

/** The turns in the order they started: by their first step (ids are creation order), whatever order they came back in. */
function turnsInOrder(tracker) {
  const first = new Map();
  for (const step of tracker.steps.values()) {
    const turn = step.by.turn;
    if (turn !== null && (!first.has(turn) || idNumber(step.id) < first.get(turn))) first.set(turn, idNumber(step.id));
  }
  return [...tracker.turns.values()].sort((a, b) => (first.get(a.id) ?? Infinity) - (first.get(b.id) ?? Infinity));
}

/**
 * The model's `Tracker` record of a live tracker: every list in id order
 * (turns in the order they started), every record copied.
 * @param {object} tracker
 */
export function trackerRecord(tracker) {
  return {
    id: tracker.id,
    name: tracker.name,
    dataset: structuredClone(tracker.dataset),
    createdAt: tracker.createdAt,
    by: { ...tracker.by },
    start: structuredClone(tracker.start),
    removed: tracker.removed === null ? null : structuredClone(tracker.removed),
    rootId: tracker.rootId,
    headId: tracker.headId,
    activeBranch: tracker.activeBranch,
    mainBranch: tracker.mainBranch,
    paused: tracker.paused === null ? null : structuredClone(tracker.paused),
    branches: [...tracker.branches.values()].sort(byNumber).map(copyRecord),
    groups: [...tracker.groups.values()].sort(byNumber).map(copyRecord),
    steps: [...tracker.steps.values()].sort(byNumber).map(copyStep),
    turns: turnsInOrder(tracker).map(copyRecord),
    notes: structuredClone(tracker.notes),
    journal: tracker.journal.map(entry => structuredClone(entry)),
    chats: [...tracker.chats].map(([id, transcript]) => [id, structuredClone(transcript)]),
    nextStep: tracker.nextStep,
    nextBranch: tracker.nextBranch,
    nextGroup: tracker.nextGroup,
    nextNote: tracker.nextNote,
    nextJournal: tracker.nextJournal,
  };
}

// ---------------------------------------------------------------------------
// Reading

/** @returns {object} the step, or a RangeError naming it */
export function stepOf(tracker, stepId) {
  const step = tracker.steps.get(stepId);
  if (step === undefined) throw new RangeError(`There is no step "${stepId}" in this history`);
  return step;
}

/** @returns {object} the branch, or a RangeError naming it */
export function branchOf(tracker, branchId) {
  const branch = tracker.branches.get(branchId);
  if (branch === undefined) throw new RangeError(`There is no branch "${branchId}" in this history`);
  return branch;
}

/** The number of steps from the root to `stepId` (the root's is 0). */
export function depthOf(tracker, stepId) {
  const index = indexOf(tracker);
  let depth = index.depth.get(stepId);
  if (depth === undefined) {
    // A step added without the index told (a record put back): counted up to the nearest step it knows, in a loop.
    const chain = [];
    let id = stepId;
    for (; id !== null && !index.depth.has(id); id = stepOf(tracker, id).parent) chain.push(id);
    depth = id === null ? -1 : index.depth.get(id);
    for (let i = chain.length - 1; i >= 0; i--) index.depth.set(chain[i], ++depth);
  }
  return depth;
}

/** The ancestor of `stepId` at `depth` (itself at its own depth). */
export function ancestorAt(tracker, stepId, depth) {
  let id = stepId;
  for (let d = depthOf(tracker, stepId); d > depth; d--) id = stepOf(tracker, id).parent;
  return id;
}

/** Whether `a` is `b` or one of its ancestors (on the path from the root to `b`). */
export function isOnPath(tracker, a, b) {
  const da = depthOf(tracker, a);
  return da <= depthOf(tracker, b) && ancestorAt(tracker, b, da) === a;
}

/** The last common step of two steps, by depth (the steps between them, never the whole path). */
export function commonAncestor(tracker, a, b) {
  let x = a;
  let y = b;
  let dx = depthOf(tracker, x);
  let dy = depthOf(tracker, y);
  while (dx > dy) { x = stepOf(tracker, x).parent; dx--; }
  while (dy > dx) { y = stepOf(tracker, y).parent; dy--; }
  while (x !== y) { x = stepOf(tracker, x).parent; y = stepOf(tracker, y).parent; }
  return x;
}

/** Steps from the root to `stepId`, root first. */
export function pathTo(tracker, stepId) {
  const path = new Array(depthOf(tracker, stepId) + 1);
  let i = path.length - 1;
  for (let step = stepOf(tracker, stepId); ; step = stepOf(tracker, step.parent)) {
    path[i--] = step;
    if (step.parent === null) break;
  }
  return path;
}

/** Steps strictly after `ancestorId` down to `stepId`, first first (`ancestorId` must be on its path). */
export function pathBetween(tracker, ancestorId, stepId) {
  const out = new Array(depthOf(tracker, stepId) - depthOf(tracker, ancestorId));
  let i = out.length - 1;
  for (let id = stepId; id !== ancestorId; id = stepOf(tracker, id).parent) out[i--] = stepOf(tracker, id);
  return out;
}

/** The value hash of every domain at `stepId`, read from the root (the plain reading). */
export function valuesAt(tracker, stepId) {
  const values = {};
  for (const step of pathTo(tracker, stepId)) Object.assign(values, step.after);
  return values;
}

/**
 * The value hash of every domain at `toId`, from `fromValues` at `fromId`:
 * the steps above their common ancestor undone by their before-values, those
 * below it applied by their after-values. Costs the steps between the two.
 */
export function valuesFrom(tracker, fromId, fromValues, toId) {
  if (fromId === toId) return { ...fromValues };
  const common = commonAncestor(tracker, fromId, toId);
  const values = { ...fromValues };
  for (let id = fromId; id !== common; id = stepOf(tracker, id).parent) Object.assign(values, stepOf(tracker, id).before);
  for (const step of pathBetween(tracker, common, toId)) Object.assign(values, step.after);
  return values;
}

/** A branch's own steps, from its first to its tip. */
export function branchSteps(tracker, branchId) {
  const branch = branchOf(tracker, branchId);
  const out = [];
  for (let step = stepOf(tracker, branch.tip); step.branch === branchId; step = stepOf(tracker, step.parent)) {
    out.push(step);
    if (step.parent === null) break;
  }
  return out.reverse();
}

/** The step redo shows: the head's child on the path to the active branch's tip, or null. */
export function redoTarget(tracker) {
  const tip = branchOf(tracker, tracker.activeBranch).tip;
  if (tip === tracker.headId) return null;
  return ancestorAt(tracker, tip, depthOf(tracker, tracker.headId) + 1);
}

/** Every step below `stepId`, parents before children, oldest child first. */
export function descendantsOf(tracker, stepId) {
  const out = [];
  const stack = [...stepOf(tracker, stepId).children].reverse();
  while (stack.length > 0) {
    const id = stack.pop();
    const step = stepOf(tracker, id);
    out.push(step);
    for (let i = step.children.length - 1; i >= 0; i--) stack.push(step.children[i]);
  }
  return out;
}

/** The branches whose fork step is `stepId`. */
export function branchesForkingAt(tracker, stepId) {
  const out = [];
  for (const branch of tracker.branches.values()) if (branch.base === stepId) out.push(branch);
  return out;
}

/** The value hashes one step record names (before, after, and the inputs it read). */
export function stepHashes(step, into = new Set()) {
  for (const hash of Object.values(step.before)) into.add(hash);
  for (const hash of Object.values(step.after)) into.add(hash);
  for (const [key, hash] of Object.entries(step.reads)) if (key !== 'history') into.add(hash);
  return into;
}

/**
 * Every value hash a tracker refers to: its steps', its journal's (Recently
 * deleted keeps them) and its paused draft's. `tracker` is live or a record.
 */
export function referencedHashes(tracker, into = new Set()) {
  const addStep = step => stepHashes(step, into);
  for (const hash of Object.values(tracker.paused?.draft ?? {})) into.add(hash);
  for (const step of tracker.steps.values()) addStep(step);
  for (const entry of tracker.journal) {
    if (entry.purged) continue;
    for (const step of entry.before.steps) addStep(step);
    for (const step of entry.after.steps) addStep(step);
  }
  return into;
}

// ---------------------------------------------------------------------------
// Changing (the history's operations call these; each keeps the indexes)

/** Add a recorded step below its parent (its record made by `model.js` `createStep`). */
export function insertStep(tracker, step) {
  const parent = stepOf(tracker, step.parent);
  if (tracker.steps.has(step.id)) throw new RangeError(`The history already holds a step "${step.id}"`);
  // Children stay oldest first (ids are creation order).
  const at = parent.children.findIndex(child => idNumber(child) > idNumber(step.id));
  if (at === -1) parent.children.push(step.id); else parent.children.splice(at, 0, step.id);
  tracker.steps.set(step.id, step);
  indexOf(tracker).depth.set(step.id, depthOf(tracker, parent.id) + 1);
  return step;
}

/**
 * Take `stepIds` out, each hanging its children on its parent, in id order
 * (bottom-up, so a step's parent is still there when it goes). Branch,
 * group and head bookkeeping is the caller's (`branches.js`). The depths are
 * computed again once, for the subtrees that moved up (each walked once
 * however many steps above it went). Returns the removed steps.
 */
export function detachSteps(tracker, stepIds) {
  const index = indexOf(tracker);
  const ordered = [...stepIds].sort((a, b) => idNumber(b) - idNumber(a));
  const gone = new Set(ordered);
  const removed = [];
  const moved = new Set();
  for (const stepId of ordered) {
    const step = stepOf(tracker, stepId);
    if (step.parent === null) throw new RangeError('The first step of a history cannot be deleted');
    const parent = stepOf(tracker, step.parent);
    const children = parent.children.filter(child => child !== stepId);
    for (const childId of step.children) {
      stepOf(tracker, childId).parent = parent.id;
      children.push(childId);
      moved.add(childId);
    }
    parent.children = children.sort((a, b) => idNumber(a) - idNumber(b));
    tracker.steps.delete(stepId);
    index.depth.delete(stepId);
    moved.delete(stepId);
    removed.push(step);
  }
  // Only the re-hung subtrees move up: each from its new parent's depth, its steps below walked once
  // (ids are creation order, so a subtree above another is computed first).
  for (const top of [...moved].sort((a, b) => idNumber(a) - idNumber(b))) {
    if (gone.has(top)) continue;
    const stack = [[top, index.depth.get(stepOf(tracker, top).parent) + 1]];
    while (stack.length > 0) {
      const [id, depth] = stack.pop();
      if (index.depth.get(id) === depth) continue;
      index.depth.set(id, depth);
      for (const child of stepOf(tracker, id).children) stack.push([child, depth + 1]);
    }
  }
  return removed;
}

/** The domains in domain order, of those given. */
export function orderedDomains(ids) {
  return DOMAIN_IDS.filter(id => ids.includes(id));
}

