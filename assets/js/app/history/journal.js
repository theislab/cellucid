/**
 * @fileoverview The journal: every structural edit of a tracker kept as the
 * exact records it replaced and made, so it can be undone (Recently
 * deleted / changed; History v2 §3.3.9, contract decisions 3 and 4). Pure
 * data, no page.
 *
 * An edit is opened (`beginEdit`), told each record before it changes one
 * (`edit.step(id)`, `edit.branch(id)`, `edit.group(id)`, `edit.turn(id)`,
 * `edit.field(name)`; a record about to be made is told too, and is kept as
 * "did not exist"), and committed (`commitEdit`): the entry's `before`
 * holds the records as they were, its `after` the records as they are, each
 * by id (in `before` only, the edit removed it; in `after` only, it made it).
 * A record told but left as it was is in neither.
 *
 * A restore (`restoreExactly`) puts `before` back exactly when every record
 * in `after` is still as the edit left it (a step's `children` and the
 * tracker's head and active branch aside: a step added below one since, or a
 * move, is kept); it is itself an entry (op `journal.undo`, with the patches
 * the other way round) and takes the restored entry out of the journal. It
 * is tried on the records, checked whole (the model's validators: parents,
 * branch lines, group runs, names) and rolled back when the result would
 * not be a valid history, so a restore never leaves half an edit. When later
 * edits changed what the entry made, an exact restore would lose them:
 * `exactRestorable` says so, and the history restores as new objects instead
 * (`history.js`).
 *
 * Emptying (`purgeEntries`) drops an entry's patches, so the values only
 * they name can be freed; the entry keeps its id, op, time, author and label.
 *
 * @module app/history/journal
 */

import { createJournalEntry, emptyPatch, idNumber, idOf, nameKey, TRACKER_PATCH_FIELDS } from './model.js';
import { copyRecord, copyStep, reindex, valuesAt } from './tree.js';
import { activeBranchAt } from './branches.js';

const KINDS = Object.freeze({ step: 'steps', branch: 'branches', group: 'groups', turn: 'turns' });

/** The run of steps a group holds now, `{group, from, to}`, or null for a group with no step. */
export function membershipOf(tracker, groupId) {
  let from = null;
  let to = null;
  for (const step of tracker.steps.values()) {
    if (step.group !== groupId) continue;
    if (from === null || idNumber(step.id) < idNumber(from)) from = step.id;
    if (to === null || idNumber(step.id) > idNumber(to)) to = step.id;
  }
  return from === null ? null : { group: groupId, from, to };
}

/** The steps of a membership's run, from its last up to its first (one line of one branch). */
function runSteps(tracker, { from, to }) {
  const out = [];
  for (let id = to; ; id = tracker.steps.get(id).parent) {
    const step = tracker.steps.get(id);
    if (step === undefined) throw new RangeError(`A group's step "${id}" is not in the history`);
    out.push(step);
    if (id === from) return out;
    if (step.parent === null) throw new RangeError(`A group's steps from "${from}" to "${to}" are not one line`);
  }
}

/** Set the groups' runs as `memberships` say, after clearing the runs `clearing` names. */
export function applyMemberships(tracker, clearing, memberships) {
  for (const membership of clearing) {
    for (const step of runSteps(tracker, membership)) if (step.group === membership.group) step.group = null;
  }
  for (const membership of memberships) for (const step of runSteps(tracker, membership)) step.group = membership.group;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function copyOf(kind, record) {
  return kind === 'steps' ? copyStep(record) : copyRecord(record);
}

/**
 * Open an edit of `tracker`.
 * @param {object} tracker - live (`tree.js`)
 * @param {{op: string, by: object, at: number|null, label: string}} facts
 */
export function beginEdit(tracker, { op, by, at, label }) {
  const kept = { steps: new Map(), branches: new Map(), groups: new Map(), turns: new Map() };
  const fields = new Map();
  const memberships = new Map();
  const tell = kind => id => {
    if (!kept[kind].has(id)) {
      const record = tracker[kind].get(id);
      kept[kind].set(id, record === undefined ? null : copyOf(kind, record));
    }
  };
  return {
    tracker, op, by, at, label,
    step: tell('steps'),
    branch: tell('branches'),
    group: tell('groups'),
    turn: tell('turns'),
    /** Which steps a group holds, about to change (a group edit records this, never the member steps). */
    membership(groupId) {
      if (!memberships.has(groupId)) memberships.set(groupId, membershipOf(tracker, groupId));
    },
    /** A record made by work the edit does not run itself (a replay's steps and branch): kept as "did not exist". */
    made(kind, id) {
      if (!kept[KINDS[kind]].has(id) && !tracker[KINDS[kind]].has(id)) throw new RangeError(`An edit is told of a ${kind} "${id}" it made, which is not there`);
      if (!kept[KINDS[kind]].has(id)) kept[KINDS[kind]].set(id, null);
    },
    /** A tracker field (`TRACKER_PATCH_FIELDS`) about to change. */
    field(name) {
      if (!TRACKER_PATCH_FIELDS.includes(name)) throw new RangeError(`A journal entry does not keep the tracker's "${name}"`);
      if (!fields.has(name)) fields.set(name, structuredClone(tracker[name]));
    },
    kept,
    fields,
    memberships,
    /** Change the label once the edit knows what it did ("Deleted branch "X" (4 steps)"). */
    relabel(text) { this.label = text; },
  };
}

/** Whether the edit changed anything at all. */
export function editChanged(edit) {
  const { tracker } = edit;
  for (const [kind, kept] of Object.entries(edit.kept)) {
    for (const [id, before] of kept) {
      const now = tracker[kind].get(id);
      if ((before === null) !== (now === undefined) || (before !== null && !same(before, now))) return true;
    }
  }
  for (const [name, before] of edit.fields) if (!same(before, edit.tracker[name])) return true;
  for (const [group, before] of edit.memberships) if (!same(before, membershipOf(tracker, group))) return true;
  return false;
}

/** The two patches of an edit, from what it kept and what holds now. */
function patchesOf(edit) {
  const { tracker } = edit;
  const before = emptyPatch();
  const after = emptyPatch();
  for (const [group, was] of edit.memberships) {
    const now = membershipOf(tracker, group);
    if (same(was, now)) continue;
    if (was !== null) before.memberships.push(was);
    if (now !== null) after.memberships.push(now);
  }
  for (const [kind, kept] of Object.entries(edit.kept)) {
    for (const [id, was] of kept) {
      const now = tracker[kind].get(id);
      if (was !== null && now !== undefined && same(was, now)) continue;
      if (was !== null) before[kind].push(was);
      if (now !== undefined) after[kind].push(copyOf(kind, now));
    }
  }
  for (const [name, was] of edit.fields) {
    before.tracker[name] = was;
    after.tracker[name] = structuredClone(tracker[name]);
  }
  return { before, after };
}

/**
 * Keep the edit as one journal entry of its tracker. An edit that changed
 * nothing is kept only when `always` (an action asked for it, and answers with
 * its entry). Returns the entry, or null.
 */
export function commitEdit(edit, { always = false } = {}) {
  if (!always && !editChanged(edit)) return null;
  const { tracker } = edit;
  const { before, after } = patchesOf(edit);
  const entry = createJournalEntry({
    id: idOf('journal', tracker.nextJournal), op: edit.op, at: edit.at, by: edit.by, label: edit.label, before, after,
  });
  tracker.nextJournal++;
  tracker.journal.push(entry);
  return entry;
}

/** A journal entry by id, or null. */
export function entryOf(tracker, entryId) {
  return tracker.journal.find(entry => entry.id === entryId) ?? null;
}

/** A step record without its children (a step added below one since does not change what an edit made). */
function stepFacts(step) {
  const { children: _children, ...facts } = step;
  return facts;
}

/** The tracker fields a move changes; an exact restore keeps the move (a head that moved since stays). */
const MOVE_FIELDS = Object.freeze(['headId', 'activeBranch']);

/**
 * Whether `entry` can be put back exactly: every record it made or changed
 * is still as it left it (a step's children and the head aside), and none it
 * removed has come back.
 */
export function exactRestorable(tracker, entry) {
  if (entry.purged) return false;
  for (const kind of Object.values(KINDS)) {
    const madeOrChanged = new Set(entry.after[kind].map(record => record.id));
    for (const record of entry.after[kind]) {
      const now = tracker[kind].get(record.id);
      if (now === undefined) return false;
      if (kind === 'steps' ? !same(stepFacts(record), stepFacts(now)) : !same(record, now)) return false;
    }
    for (const record of entry.before[kind]) {
      if (!madeOrChanged.has(record.id) && tracker[kind].has(record.id)) return false;
    }
  }
  for (const [name, value] of Object.entries(entry.after.tracker)) {
    if (!MOVE_FIELDS.includes(name) && !same(value, tracker[name])) return false;
  }
  for (const membership of entry.after.memberships) if (!same(membership, membershipOf(tracker, membership.group))) return false;
  for (const membership of entry.before.memberships) {
    if (!entry.after.memberships.some(other => other.group === membership.group) && membershipOf(tracker, membership.group) !== null) return false;
    // The steps it groups again are in no other group now.
    for (const step of runOrNull(tracker, membership) ?? []) {
      if (step.group !== null && step.group !== membership.group) return false;
    }
  }
  return true;
}

/** A membership's steps, or null when they are not one line of the tracker now. */
function runOrNull(tracker, membership) {
  try {
    return runSteps(tracker, membership);
  } catch {
    return null;
  }
}

/**
 * The first name `entry`'s restore would give that another record holds now
 * (a branch, a group or a bookmark renamed or made since), `{kind, name}`,
 * or null. The tracker's own name is the history's to check (it is unique
 * among trackers).
 */
export function restoreNameClash(tracker, entry) {
  if (entry.purged) return null;
  const replaced = kind => new Set([...entry.after[kind], ...entry.before[kind]].map(record => record.id));
  for (const [kind, label] of [['branches', 'branch'], ['groups', 'group']]) {
    const gone = replaced(kind);
    for (const record of entry.before[kind]) {
      const key = nameKey(record.name);
      for (const other of tracker[kind].values()) {
        if (!gone.has(other.id) && nameKey(other.name) === key) return { kind: label, name: record.name };
      }
    }
  }
  const gone = replaced('steps');
  for (const record of entry.before.steps) {
    if (record.bookmark === null) continue;
    const key = nameKey(record.bookmark);
    for (const other of tracker.steps.values()) {
      if (gone.has(other.id)) continue;
      if ((other.bookmark !== null && nameKey(other.bookmark) === key) || other.squashed?.carried.bookmarks.some(each => nameKey(each) === key)) {
        return { kind: 'bookmark', name: record.bookmark };
      }
    }
  }
  return null;
}

/**
 * Put back what an edit kept (a failed, cancelled or invalid edit changes
 * nothing): its records, its tracker fields and its groups' runs.
 */
export function rollbackEdit(edit) {
  const { tracker } = edit;
  for (const [kind, kept] of Object.entries(edit.kept)) {
    for (const [id, was] of kept) {
      if (was === null) tracker[kind].delete(id);
      else tracker[kind].set(id, copyOf(kind, was));
    }
  }
  for (const [name, was] of edit.fields) tracker[name] = structuredClone(was);
  const now = [...edit.memberships.keys()].map(group => membershipOf(tracker, group)).filter(run => run !== null);
  applyMemberships(tracker, now, [...edit.memberships.values()].filter(run => run !== null));
  reindex(tracker);
}

/**
 * Put `entry`'s `before` back exactly (`exactRestorable` must hold), as a new
 * entry (op `journal.undo`) that takes the restored one out of the journal.
 * The records are changed, `validate(tracker)` checks the result whole, and
 * a result it refuses (or a step of the change that throws) is rolled back:
 * then nothing changed and null is returned. A step's children keep the
 * steps added below it since; the head stays where a move took it since, or
 * goes back where the edit found it.
 *
 * @param {object} tracker
 * @param {object} entry
 * @param {{by: object, at: number|null, validate: (tracker: object) => void}} facts
 * @returns {object|null} the new entry, or null when the restore would not be valid
 */
export function restoreExactly(tracker, entry, { by, at, validate }) {
  const edit = beginEdit(tracker, { op: 'journal.undo', by, at, label: `Restored: ${entry.label}` });
  for (const [kind, tell] of [['steps', edit.step], ['branches', edit.branch], ['groups', edit.group], ['turns', edit.turn]]) {
    for (const record of entry.after[kind]) tell(record.id);
    for (const record of entry.before[kind]) tell(record.id);
  }
  for (const name of new Set([...Object.keys(entry.before.tracker), ...MOVE_FIELDS])) edit.field(name);
  for (const membership of [...entry.after.memberships, ...entry.before.memberships]) {
    edit.membership(membership.group);
    // A group holding one of those steps now is told too: its run is kept, so a rollback gives it back.
    for (const step of runOrNull(tracker, membership) ?? []) if (step.group !== null) edit.membership(step.group);
  }
  // Every step whose children a restore may change, and its children now.
  const affected = new Set();
  for (const record of [...entry.before.steps, ...entry.after.steps]) {
    affected.add(record.id);
    if (record.parent !== null) affected.add(record.parent);
  }
  const childrenNow = new Map();
  for (const id of affected) if (tracker.steps.has(id)) childrenNow.set(id, [...tracker.steps.get(id).children]);
  const afterById = new Map(entry.after.steps.map(record => [record.id, record]));
  const activeNow = tracker.activeBranch;
  try {
    for (const kind of Object.values(KINDS)) {
      for (const record of entry.after[kind]) tracker[kind].delete(record.id);
      for (const record of entry.before[kind]) tracker[kind].set(record.id, copyOf(kind, record));
    }
    for (const id of affected) {
      const step = tracker.steps.get(id);
      if (step === undefined) continue;
      const candidates = new Set([...(childrenNow.get(id) ?? []), ...step.children]);
      for (const record of entry.before.steps) if (record.parent === id) candidates.add(record.id);
      step.children = [...candidates].filter(child => tracker.steps.get(child)?.parent === id).sort((a, b) => idNumber(a) - idNumber(b));
    }
    applyMemberships(tracker, entry.after.memberships, entry.before.memberships);
    for (const [name, value] of Object.entries(entry.before.tracker)) {
      if (!MOVE_FIELDS.includes(name)) tracker[name] = structuredClone(value);
    }
    reindex(tracker);
    // The head goes back where the edit found it unless a move took it elsewhere since (then it stays).
    const before = entry.before.tracker;
    if (Object.hasOwn(before, 'headId') && (tracker.headId === entry.after.tracker.headId || !tracker.steps.has(tracker.headId))) {
      tracker.headId = before.headId;
    }
    for (let id = tracker.headId; !tracker.steps.has(id);) {
      // A head on a step the restore takes out goes to its nearest step left.
      const parent = afterById.get(id)?.parent ?? null;
      if (parent === null) throw new RangeError('A restore would take out the step shown and every step above it');
      id = parent;
      tracker.headId = id;
    }
    // The active branch the edit found while the one it left is still active (no move since), else the one kept.
    const untouched = before.activeBranch !== undefined && entry.after.tracker.activeBranch === activeNow;
    const wanted = untouched ? before.activeBranch : tracker.activeBranch;
    tracker.activeBranch = activeBranchAt(tracker, tracker.headId, wanted);
    requireBeforeValues(tracker, entry);
    validate(tracker);
  } catch (error) {
    rollbackEdit(edit);
    if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
    return null;
  }
  tracker.journal = tracker.journal.filter(other => other.id !== entry.id);
  return commitEdit(edit);
}

/**
 * Every step a restore put back, and every step below one, has its parent's
 * values as its before-values (the values above a step may have changed
 * since the entry, when a later edit applied steps there again, and the
 * values below a step put back follow from it): else the restore is not
 * exact. One walk of each subtree, its values carried down.
 */
function requireBeforeValues(tracker, entry) {
  const seen = new Set();
  for (const record of [...entry.before.steps].sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
    const top = tracker.steps.get(record.id);
    if (top === undefined || top.parent === null || seen.has(top.id)) continue;
    const stack = [[top.id, valuesAt(tracker, top.parent)]];
    while (stack.length > 0) {
      const [id, parentValues] = stack.pop();
      seen.add(id);
      const step = tracker.steps.get(id);
      for (const [domain, hash] of Object.entries(step.before)) {
        if (parentValues[domain] !== hash) throw new RangeError(`Step "${id}" would no longer follow from its parent's ${domain}`);
      }
      const values = { ...parentValues, ...step.after };
      for (const child of step.children) stack.push([child, values]);
    }
  }
}

/**
 * Empty Recently deleted of one entry, or of every entry: their patches go,
 * so the values only they name can be pruned. Returns the entries purged.
 */
export function purgeEntries(tracker, entryId = null) {
  const purged = [];
  tracker.journal = tracker.journal.map(entry => {
    if (entry.purged || (entryId !== null && entry.id !== entryId)) return entry;
    purged.push(entry.id);
    return { ...entry, before: null, after: null, purged: true };
  });
  return purged;
}
