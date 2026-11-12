/**
 * @fileoverview Deleting steps and restoring from Recently deleted (History
 * v2 §3.3.4, §3.3.9), for `history.js`. A delete takes steps out and applies
 * again only the steps below them whose touched domains changed or whose
 * inputs (result inputs and name context) changed but for generated ids
 * (`canonical`), each on its new parent's values, with Cancel. A restore puts
 * an entry back exactly (tried on the records and checked whole first) or
 * as new objects (removed steps applied again by name as branches, each line
 * on its restored parent, journaled itself); undoing a rename whose old name
 * was taken since is refused with the name to use instead (§5 #51).
 *
 * @module app/history/delete-restore
 */

import { DOMAIN_IDS } from '../actions/domains.js';
import { throwIfAborted } from '../../utils/abort.js';
import { HISTORY_SENTENCES, idNumber, nameKey, suffixedName, validateTracker } from './model.js';
import { branchOf, branchSteps, descendantsOf, stepOf, trackerRecord, valuesAt } from './tree.js';
import { bookmarked, stepNamed, takeOut } from './branches.js';
import { beginEdit, commitEdit, entryOf, exactRestorable, membershipStepIds, restoreExactly, restoreNameClash, rollbackEdit } from './journal.js';
import { ActionRefused } from '../actions/dispatcher.js';
import { quoteName } from '../actions/targets/names.js';

const refuse = (message, code, type = null) => new ActionRefused(message, { code, type });

/** The journal ops that rename: undoing one whose old name was taken since is refused with the name to take instead. */
const RENAME_OPS = Object.freeze(['branch.rename', 'group.rename', 'tracker.rename', 'bookmark.set']);

/**
 * @param {object} h - the history's own context (`history.js`): its operations, and getters
 *   and setters of what it holds now (`active`, `coalesceStep`, `destroyed`, `exclusiveHeavy`, `headValues`, `pending`, `shown`)
 */
export function createDeleteRestore(h) {
  const {
    byOf, catalog, dispatcher, domains, journaled, liveTrackers, notify, notifyEdit, now, off, pausedDraftAt, replayAsBranch, replayableParams, requireExclusive, restoreTo, sameCanonical, settleBeforeMove, show, withoutOff,
  } = h;

  // -------------------------------------------------------------------------
  // Deleting a step, with only its dependants applied again (§3.3.4)

  /** The domains a recorded step's action may write (its catalog's, else what it recorded). */
  function touchesOf(step) {
    if (step.type === null || !catalog.has(step.type)) return new Set(step.touches);
    return new Set([...catalog.get(step.type).touches, ...step.touches]);
  }

  /**
   * The domains a recorded step's action reads: its result inputs and the
   * state its parameters' names resolve in (`reads` and `context`, the
   * catalog's, else what it recorded).
   */
  function inputsOf(step) {
    const recorded = Object.keys(step.reads).filter(key => key !== 'history');
    if (step.type === null || !catalog.has(step.type)) return new Set(recorded);
    const definition = catalog.get(step.type);
    return new Set([...(definition.reads ?? []), ...(definition.context ?? []), ...recorded].filter(input => input !== 'history'));
  }

  /** The domains a recorded step's action may write or read. */
  function domainsOf(step) {
    return new Set([...touchesOf(step), ...inputsOf(step)]);
  }

  /** The steps below a deleted step that a re-apply would run, by a static reading (the estimate and the dialog). */
  function dependantsOf(tracker, step) {
    const dirty = new Set(step.touches);
    return descendantsOf(tracker, step.id).filter(each => each.kind === 'action' && [...domainsOf(each)].some(id => dirty.has(id)));
  }

  async function deleteStepNow(tracker, stepId, { signal = null, meta = {}, op = 'step.delete', label = null } = {}) {
    const step = stepNamed(tracker, stepId);
    if (step.parent === null) throw refuse('The first step of a history cannot be deleted.', 'refused');
    const branch = branchOf(tracker, step.branch);
    if (branch.locked) throw refuse(HISTORY_SENTENCES.locked({ name: branch.name }), 'locked');
    if (branch.id === tracker.mainBranch && branchSteps(tracker, branch.id).length === 1 && branch.base !== null) {
      throw refuse(HISTORY_SENTENCES.mainBranch(), 'main-branch');
    }
    return removeSteps(tracker, [step], { signal, meta, op, label: label ?? `Deleted step ${idNumber(step.id)} "${step.label}"` });
  }

  /**
   * Take `removedSteps` out and apply again only the steps below them that
   * changed or read what they changed, each on its new parent's values;
   * one that no longer applies is kept, flagged. Journaled; Cancel (`signal`)
   * puts everything back exactly.
   */
  async function removeSteps(tracker, removedSteps, { signal, meta, op, label }) {
    requireExclusive('Taking steps out');
    const by = byOf(meta);
    if (tracker === h.active) settleBeforeMove(tracker, by);
    const edit = beginEdit(tracker, { op, by, at: now(), label });
    const shownAtStart = { ...h.shown };
    const headBefore = tracker.headId;
    // Old values at each step below, before anything changes: what "dirty" compares with. A top is a
    // step whose parent is taken out; its old parent's values are kept for it, so a top the walk from
    // another top reaches (A, P1, B, P2 with A and B taken out: P2 hangs below P1) is compared with its own
    // old parent, B, and is applied once. Ids are creation order, so a top below another comes later.
    const ids = new Set(removedSteps.map(step => step.id));
    const oldParentOf = new Map();
    for (const step of removedSteps) {
      for (const child of step.children) if (!ids.has(child)) oldParentOf.set(child, valuesAt(tracker, step.id));
    }
    const tops = [...oldParentOf.keys()].sort((a, b) => idNumber(a) - idNumber(b));
    const reached = new Set();
    const reapplied = [];
    const flagged = [];
    try {
      takeOut(tracker, edit, [...ids]);
      const stack = [];
      const pushTops = () => {
        // The next top no walk reached yet, on the values of its parent as they are now.
        while (tops.length > 0) {
          const id = tops.shift();
          if (reached.has(id) || !tracker.steps.has(id)) continue;
          stack.push({ id, oldParent: oldParentOf.get(id), newParent: valuesAt(tracker, stepOf(tracker, id).parent) });
          return;
        }
      };
      pushTops();
      while (stack.length > 0) {
        throwIfAborted(signal);
        const { id, oldParent, newParent } = stack.pop();
        const each = stepOf(tracker, id);
        const oldAt = { ...oldParent, ...each.after };
        const dirty = new Set(DOMAIN_IDS.filter(domain => oldParent[domain] !== newParent[domain]));
        // An input is changed when its canonical form is: a value that differs only by generated ids
        // (a highlight made again under a new id) changes nothing a step reads.
        const changedInputs = new Set();
        for (const domain of dirty) if (!await sameCanonical(domain, oldParent[domain], newParent[domain], oldParent['field-overlays'], newParent['field-overlays'])) changedInputs.add(domain);
        if (dirty.size > 0) {
          if (each.kind === 'outside') {
            const lost = each.touches.filter(domain => dirty.has(domain));
            if (lost.length > 0) {
              edit.step(id);
              each.touches = each.touches.filter(domain => !dirty.has(domain));
              for (const domain of lost) { delete each.before[domain]; delete each.after[domain]; }
              if (each.touches.length === 0) each.reason = 'No longer changes anything';
            }
          } else if (each.kind === 'squashed') {
            const kept = each.touches.filter(domain => newParent[domain] !== each.after[domain]);
            edit.step(id);
            each.before = Object.fromEntries(kept.map(domain => [domain, newParent[domain]]));
            each.after = Object.fromEntries(kept.map(domain => [domain, each.after[domain]]));
            each.touches = kept;
          } else if (each.kind === 'action' && each.status === 'applied'
            && ([...touchesOf(each)].some(domain => dirty.has(domain)) || [...inputsOf(each)].some(domain => changedInputs.has(domain)))) {
            edit.step(id);
            const prepared = replayableParams(each, null);
            let failure = prepared.reason ?? null;
            if (failure === null) {
              await restoreTo(newParent, { signal });
              try {
                // Heavy work it finds is the delete's (its agent asked: `exclusiveHeavy`).
                await dispatcher.dispatch(each.type, prepared.params, { origin: 'replay', internal: true, rewrite: id, signal, heavy: h.exclusiveHeavy });
                reapplied.push(id);
              } catch (error) {
                if (signal?.aborted) throw error;
                failure = error?.message ?? String(error);
              }
            }
            if (failure !== null) {
              each.status = 'unapplicable';
              each.reason = failure;
              each.touches = [];
              each.before = {};
              each.after = {};
              flagged.push({ step: id, reason: failure });
            }
          }
        }
        const newAt = { ...newParent, ...each.after };
        for (let i = each.children.length - 1; i >= 0; i--) {
          const child = each.children[i];
          if (oldParentOf.has(child)) reached.add(child);
          stack.push({ id: child, oldParent: oldParentOf.get(child) ?? oldAt, newParent: newAt });
        }
        if (stack.length === 0) pushTops();
      }
      throwIfAborted(signal);
      const target = valuesAt(tracker, tracker.headId);
      if (tracker === h.active) {
        h.headValues = target;
        await restoreTo({ ...target, ...Object.fromEntries(off().map(id => [id, shownAtStart[id]]).filter(([, hash]) => hash !== undefined)) }, { signal });
      }
    } catch (error) {
      rollbackEdit(edit);
      tracker.headId = headBefore;
      if (tracker === h.active) {
        h.headValues = valuesAt(tracker, tracker.headId);
        try { await restoreTo(shownAtStart); } catch (rollbackError) { error.rollbackError ??= rollbackError; }
      }
      throw error;
    }
    const entry = commitEdit(edit);
    h.coalesceStep = null;
    if (entry !== null) notifyEdit(tracker, entry, edit);
    return { reapplied, flagged, head: tracker.headId, journal: entry?.id ?? null };
  }

  // -------------------------------------------------------------------------
  // Restoring from Recently deleted

  /**
   * Undo a journal entry: exactly when nothing changed what it made since,
   * else as new objects. Steps it removed come back applied again by name on
   * their nearest surviving step, as a branch named after theirs ("X
   * (restored)" when the name is taken), each flagged where it does not
   * apply; names and flags it changed are set back where their records
   * still exist (a name taken since gets "(restored)").
   */
  async function restoreEntry(tracker, entryId, { meta = {}, signal = null } = {}) {
    const entry = entryOf(tracker, entryId);
    if (entry === null) {
      throw refuse(`There is no entry ${quoteName(entryId)} in Recently deleted of the tracker ${quoteName(tracker.name)}.`, 'no-target');
    }
    if (entry.purged) throw refuse(`${quoteName(entry.label)} was emptied from Recently deleted; it can no longer be restored.`, 'no-target');
    const by = byOf(meta);
    if (entry.op === 'load') {
      // Undoing a load: the tracker it loaded goes to Recently deleted (restorable from there).
      const removal = await h.removeTracker(tracker, by, 'history.journal.undo');
      return { entry: entryId, restored: 'exact', journal: removal.id, branch: null, report: [] };
    }
    const clash = restoreClash(tracker, entry);
    if (clash !== null && RENAME_OPS.includes(entry.op)) {
      // Undoing a rename whose old name was taken since (§5 #51): refused, with the name it can take instead.
      const taken = clash.kind === 'tracker' ? liveTrackers().map(other => other.name)
        : clash.kind === 'bookmark' ? [...tracker.steps.values()].flatMap(step => (step.bookmark === null ? [] : [step.bookmark]))
          : [...tracker[clash.kind === 'branch' ? 'branches' : 'groups'].values()].map(record => record.name);
      const instead = suffixedName(clash.name, 'restored', taken);
      const refusal = refuse(`${HISTORY_SENTENCES.nameTaken({ kind: clash.kind, name: clash.name })} Rename to ${quoteName(instead)} instead.`, 'name-taken');
      refusal.suggestion = { name: instead };
      throw refusal;
    }
    if (clash === null && exactRestorable(tracker, entry)) {
      const headBefore = tracker.headId;
      const moves = Object.hasOwn(entry.before.tracker, 'headId') && entry.before.tracker.headId !== tracker.headId;
      if (tracker === h.active && moves) settleBeforeMove(tracker, by);
      const made = restoreExactly(tracker, entry, { by, at: now(), validate: validRestore });
      if (made !== null) {
        if (entry.op === 'tracker.remove') {
          const taken = liveTrackers().filter(other => other !== tracker).map(other => other.name);
          tracker.name = suffixedName(tracker.name, 'restored', taken);
        }
        if (tracker === h.active) {
          h.headValues = valuesAt(tracker, tracker.headId);
          if (tracker.headId !== headBefore || DOMAIN_IDS.some(id => h.headValues[id] !== h.shown[id] && !off().includes(id))) {
            await restoreTo(withoutOff({ ...h.headValues, ...(pausedDraftAt(tracker, h.headValues) ?? {}) }));
          }
          h.pending = null;
          h.coalesceStep = null;
        }
        const steps = new Set([
          ...made.after.steps.map(step => step.id),
          ...made.before.steps.filter(step => tracker.steps.has(step.id)).map(step => step.id),
          // A restored group edit changes its steps' group without keeping them.
          ...membershipStepIds(tracker, made),
        ]);
        notify('edited', { tracker: tracker.id, op: made.op, journal: made.id, label: made.label, steps: [...steps], removed: made.before.steps.filter(step => !tracker.steps.has(step.id)).map(step => step.id), journalRemoved: [entry.id] });
        if (entry.op === 'tracker.remove') notify('tracker', { tracker: tracker.id });
        return { entry: entryId, restored: 'exact', journal: made.id, branch: null, report: [] };
      }
    }
    return restoreAsNew(tracker, entry, { meta, signal });
  }

  /** A name the restore would give that another record (or tracker) holds now, `{kind, name}`, or null. */
  function restoreClash(tracker, entry) {
    const clash = restoreNameClash(tracker, entry);
    if (clash !== null) return clash;
    const name = entry.before.tracker.name;
    if (name !== undefined && liveTrackers().some(other => other !== tracker && nameKey(other.name) === nameKey(name))) {
      return { kind: 'tracker', name };
    }
    return null;
  }

  /** The check an exact restore's result passes before it is kept: the model's tracker, whole. */
  function validRestore(tracker) {
    validateTracker(trackerRecord(tracker));
  }

  /**
   * Restore an entry as new objects (later edits changed what it made, or the
   * exact result would not be valid). Only names, flags, notes, bookmarks
   * and groups: set back where their records still exist. Steps it removed
   * (or replaced: a squash's run, from its before-patch, in full) are applied
   * again by name, each line of them as a branch named after theirs on its
   * nearest surviving step, or on the step this restore made of its parent
   * (a sub-branch lands on its restored parent). The restore is journaled
   * with the records it made, so it can be undone in turn. Returns
   * `{entry, restored: 'as-new', journal, branch, report}`.
   */
  async function restoreAsNew(tracker, entry, { meta, signal }) {
    const afterById = new Map(entry.after.steps.map(step => [step.id, step]));
    const replaced = step => {
      const now = afterById.get(step.id);
      return now !== undefined && now.kind === 'squashed' && JSON.stringify(now.squashed) !== JSON.stringify(step.squashed);
    };
    const again = entry.before.steps.filter(step => step.parent !== null && ((!tracker.steps.has(step.id) && !afterById.has(step.id)) || replaced(step)));
    if (again.length === 0) {
      const { entry: made } = await journaled(tracker, { op: 'journal.undo', label: `Restored as new: ${entry.label}`, meta }, edit => {
        const names = kind => [...tracker[kind].values()].map(record => record.name);
        const afterOf = (kind, id) => entry.after[kind].find(record => record.id === id) ?? null;
        // Notes are set back as the edit changed them (those it added go, those it removed come back
        // unless they are held elsewhere now, a squash having carried them); notes added since stay.
        const holders = new Map();
        const hold = (key, notes) => { for (const note of notes) holders.set(note.id, key); };
        hold('tracker', tracker.notes);
        for (const kind of ['steps', 'branches', 'groups', 'turns']) for (const record of tracker[kind].values()) hold(`${kind}:${record.id}`, record.notes);
        const notesBack = (key, now, was, made) => {
          const added = new Set((made ?? []).map(note => note.id).filter(id => !was.some(note => note.id === id)));
          const out = now.filter(note => !added.has(note.id));
          for (const note of was) {
            const at = holders.get(note.id);
            if (!out.some(other => other.id === note.id) && (at === undefined || at === key)) out.push(structuredClone(note));
          }
          return out.sort((a, b) => idNumber(a.id) - idNumber(b.id));
        };
        for (const was of entry.before.branches) {
          const now = tracker.branches.get(was.id);
          if (now === undefined) continue;
          edit.branch(was.id);
          Object.assign(now, {
            name: nameKey(now.name) === nameKey(was.name) ? was.name : suffixedName(was.name, 'restored', names('branches').filter(name => name !== now.name)),
            locked: was.locked, archived: was.id === tracker.mainBranch ? false : was.archived,
            notes: notesBack(`branches:${was.id}`, now.notes, was.notes, afterOf('branches', was.id)?.notes),
          });
        }
        for (const was of entry.before.groups) {
          const now = tracker.groups.get(was.id);
          if (now === undefined) continue;
          edit.group(was.id);
          now.name = nameKey(now.name) === nameKey(was.name) ? was.name : suffixedName(was.name, 'restored', names('groups').filter(name => name !== now.name));
          now.notes = notesBack(`groups:${was.id}`, now.notes, was.notes, afterOf('groups', was.id)?.notes);
        }
        for (const was of entry.before.steps) {
          const now = tracker.steps.get(was.id);
          if (now === undefined) continue;
          edit.step(was.id);
          now.notes = notesBack(`steps:${was.id}`, now.notes, was.notes, afterOf('steps', was.id)?.notes);
          if (was.bookmark === null || bookmarked(tracker, was.bookmark) === null) now.bookmark = was.bookmark;
        }
        for (const was of entry.before.turns) {
          const now = tracker.turns.get(was.id);
          if (now === undefined) continue;
          edit.turn(was.id);
          now.notes = notesBack(`turns:${was.id}`, now.notes, was.notes, afterOf('turns', was.id)?.notes);
        }
        for (const [name, value] of Object.entries(entry.before.tracker)) {
          if (name === 'headId' || name === 'activeBranch') continue;
          if (name === 'mainBranch' && !tracker.branches.has(value)) continue;
          if (name === 'name' && liveTrackers().some(other => other !== tracker && nameKey(other.name) === nameKey(value))) continue;
          edit.field(name);
          tracker[name] = name === 'notes' ? notesBack('tracker', tracker.notes, value, entry.after.tracker.notes) : structuredClone(value);
        }
        if (tracker.branches.get(tracker.activeBranch)?.archived && stepOf(tracker, tracker.headId).branch !== tracker.activeBranch) {
          edit.field('activeBranch');
          tracker.activeBranch = stepOf(tracker, tracker.headId).branch;
        }
        // Whatever it set back, the result is a valid tracker, or nothing changes.
        validRestore(tracker);
      });
      return { entry: entry.id, restored: 'as-new', journal: made?.id ?? null, branch: null, report: [] };
    }
    // Lines of steps (one branch, each the parent of the next), in id order: parents come first.
    const before = new Map(entry.before.steps.map(step => [step.id, step]));
    const againIds = new Set(again.map(step => step.id));
    const lines = [];
    const lineEndingAt = new Map();
    for (const step of [...again].sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
      const line = lineEndingAt.get(step.parent);
      if (line !== undefined && line.branch === step.branch) {
        lineEndingAt.delete(step.parent);
        line.steps.push(step);
        lineEndingAt.set(step.id, line);
      } else {
        const made = { parent: step.parent, branch: step.branch, steps: [step] };
        lines.push(made);
        lineEndingAt.set(step.id, made);
      }
    }
    const made = new Map();
    // The step a line hangs on: the step this restore made of its parent, else its nearest surviving one.
    const anchorOf = parentId => {
      for (let id = parentId; id !== null && id !== undefined; id = before.get(id)?.parent ?? null) {
        if (made.has(id)) return made.get(id);
        if (!againIds.has(id) && tracker.steps.has(id)) return id;
      }
      return tracker.rootId;
    };
    const by = byOf(meta);
    if (tracker === h.active) settleBeforeMove(tracker, by);
    const headBefore = tracker.headId;
    const firstStep = tracker.nextStep;
    const firstBranch = tracker.nextBranch;
    const edit = beginEdit(tracker, { op: 'journal.undo', by, at: now(), label: `Restored as new: ${entry.label}` });
    edit.field('headId');
    edit.field('activeBranch');
    const report = [];
    const branches = [];
    let failure = null;
    try {
      for (const line of lines) {
        const anchor = anchorOf(line.parent);
        if (idNumber(anchor) < firstStep) edit.step(anchor);
        const name = entry.before.branches.find(branch => branch.id === line.branch)?.name ?? branchOf(tracker, tracker.activeBranch).name;
        const taken = [...tracker.branches.values()].map(branch => branch.name);
        const result = await replayAsBranch(tracker, anchor, line.steps, suffixedName(name, 'restored', taken), { signal, meta, made });
        report.push(...result.report);
        if (result.branch !== null) branches.push(result.branch);
      }
      if (tracker.steps.has(headBefore) && tracker.headId !== headBefore) await show(tracker, headBefore);
    } catch (error) {
      // A stopped or failed restore keeps what it applied, journaled as made so far.
      failure = error;
    }
    for (const id of tracker.steps.keys()) if (idNumber(id) >= firstStep) edit.made('step', id);
    for (const id of tracker.branches.keys()) if (idNumber(id) >= firstBranch) edit.made('branch', id);
    const first = branches[0] ?? null;
    edit.relabel(`Restored as new: ${entry.label}${first === null ? '' : ` (branch "${first.name}")`}`);
    // The entry is kept (what it removed stays in Recently deleted); the restore says what it made.
    const note = commitEdit(edit, { always: true });
    notifyEdit(tracker, note, edit);
    if (failure !== null && !signal?.aborted && !h.destroyed) throw failure;
    return { entry: entry.id, restored: 'as-new', journal: note.id, branch: first, report };
  }

  return { touchesOf, inputsOf, domainsOf, dependantsOf, deleteStepNow, removeSteps, restoreEntry, validRestore };
}
