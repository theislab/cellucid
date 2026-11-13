/**
 * @fileoverview The history's own catalog actions (`definitions/history.js`)
 * for `history.js`: each resolves its parameters (trackers, branches, steps,
 * groups, notes by name or id), runs inside the history's exclusive
 * operation when it changes anything, and answers as its result schema says;
 * and the estimates of the long ones (a delete's re-apply, a replay).
 *
 * @module app/history/actions
 */

import { DOMAIN_IDS, domainName } from '../actions/domains.js';
import { formatCountOf } from '../../utils/format-units.js';
import { createBy, createNote, FRESH_START_BRANCH_NAME, HISTORY_SENTENCES, idNumber, idOf, nameKey, suffixedName } from './model.js';
import { branchOf, branchSteps, isOnPath, orderedDomains, pathBetween, pathTo, stepOf, valuesAt } from './tree.js';
import { applyBranchDelete, archiveBranch, bookmarked, branchNamed, checkedName, createGroupOver, extendGroup, groupNamed, lockBranch, planBranchDelete, removeGroup, renameBranch, renameGroup, setBookmark, setMainBranch, squashableRun, squashRun, stepNamed, authorsOf } from './branches.js';
import { purgeEntries } from './journal.js';
import { staleOnPath, staleReasons } from './provenance.js';
import { sameValue } from '../state/domains/same-value.js';
import { describeStep, historyPage, historySummary } from './describe.js';
import { readReplayPlan, replayPlanOf } from './replay.js';
import { ActionRefused } from '../actions/dispatcher.js';
import { quoteName } from '../actions/targets/names.js';
import { joinFailure, sayFailure } from '../../utils/errors.js';
import { awaitWithSignal } from '../../utils/abort.js';

const refuse = (message, code, type = null) => new ActionRefused(message, { code, type });

/** Why a branch got no verdict: the first step that could not run (`replaySteps` `failures`), in one sentence. */
function unverifiedSentence(branch, { step, error }) {
  return `${joinFailure(`${quoteName(branch.name)} was not verified, because step ${idNumber(step.id)} (${quoteName(step.label)}) could not run`, sayFailure(error))}`;
}

/**
 * @param {object} h - the history's own context (`history.js`): its operations, and getters
 *   and setters of what it holds now (`active`, `coalesceStep`, `headValues`, `pending`, `restoringDepth`, `shown`, `usedOrder`)
 */
export function createHistoryActions(h) {
  const {
    appendRecord, beginTracker, byOf, carryTurn, catalog, dataset, domains, exclusive, journaled, jumpNow, liveTrackers, notify, now, off, openSaved, pool, prune, putBack, replayAsBranch, replaySteps, requireStarted, restoreEntry, restoreTo, sameCanonical, settleBeforeMove, show, startTracker, trackerNamed, trackerOf, trackers, use, useTrackerNow, withoutOff,
  } = h;

  /** Whether a kept view's branch has moved on since it was kept (or is gone). */
  function branchMoved(read) {
    const tracker = trackers.get(read.tracker);
    const branch = tracker?.branches.get(read.branch);
    return branch === undefined || branch.tip !== read.tip;
  }

  /** `${input}\0${recorded}\0${now}\0${views}` → whether the read part is the same (values never change under a hash). */
  const sameReads = new Map();

  /**
   * Whether an input a step read is still what it read although its hash
   * differs (`staleOnPath`'s `sameRead`): a per-view input whose owner gives
   * the part the view the step acted in reads (`readPart(value, views)`, the
   * `views` value it ran with), compared by content. Any other input
   * differs.
   */
  function sameRead(input, recorded, current, views) {
    if (recorded === current) return true;
    if (current === undefined || views === undefined || !domains.has(input)) return false;
    const owner = domains.owner(input);
    if (typeof owner.readPart !== 'function' || !pool.has(recorded) || !pool.has(current) || !pool.has(views)) return false;
    const key = `${input}\u0000${recorded}\u0000${current}\u0000${views}`;
    let same = sameReads.get(key);
    if (same === undefined) {
      const at = pool.get(views);
      same = sameValue(owner.readPart(pool.get(recorded), at), owner.readPart(pool.get(current), at));
      sameReads.set(key, same);
    }
    return same;
  }

  /** What staleness asks (`provenance.js` `staleOnPath`): a branch moved on, an action's captured inputs, a per-view input's part. */
  const staleness = {
    branchMoved,
    capturedOf: type => (catalog.has(type) ? catalog.get(type).captures : []),
    sameRead,
  };

  /** The dry run of a branch delete in the result's words. */
  function describeBranchDelete(tracker, plan) {
    const removedIds = new Set(plan.removed.map(step => step.id));
    const deletedBranches = new Set(plan.branches.map(branch => branch.id));
    let keptViews = 0;
    for (const each of trackers.values()) {
      for (const step of each.steps.values()) {
        const read = step.reads.history;
        if (read !== undefined && read.tracker === tracker.id && deletedBranches.has(read.branch) && !removedIds.has(step.id)) keptViews++;
      }
    }
    const replays = [...trackers.values()].filter(each => each.start.kind === 'replay' && each.start.from?.tracker.id === tracker.id
      && each.start.from.branch !== null && deletedBranches.has(each.start.from.branch.id)).length;
    return {
      branches: plan.branches.map(branch => ({ id: branch.id, name: branch.name })),
      steps: plan.removed.length,
      first: plan.removed[0]?.id ?? null,
      last: plan.removed.at(-1)?.id ?? null,
      results: plan.removed.filter(step => step.touches.includes('analysis') && step.kind === 'action').length,
      kept_views: keptViews,
      replays,
      absorbed_by: plan.absorber === null ? null : { id: plan.absorber.id, name: plan.absorber.name },
      head: plan.head,
    };
  }

  // -------------------------------------------------------------------------
  // The history's own actions

  function journalResult(entry) {
    return entry?.id ?? null;
  }

  const handlers = {
    'history.get': params => {
      const tracker = trackerOf(params, 'history.get');
      const branch = params.branch === undefined ? null : branchNamed(tracker, params.branch);
      try {
        return historyPage(tracker, { ...params, branch }, { trackers: liveTrackers(), active: h.active, catalog });
      } catch (error) {
        if (error instanceof RangeError) throw refuse(error.marked ?? error.message, 'no-target', 'history.get');
        throw error;
      }
    },
    'history.summary': params => {
      const tracker = trackerOf(params, 'history.summary');
      return historySummary(tracker, {
        trackers: liveTrackers(), active: h.active, pending: h.pending, stale: staleOnPath(tracker, tracker.headId, staleness).length,
      });
    },
    'history.step': async params => {
      const tracker = trackerOf(params, 'history.step');
      const step = stepNamed(tracker, params.step);
      const stale = staleOnPath(tracker, tracker.headId, staleness).find(entry => entry.step.id === step.id) ?? null;
      return describeStep(tracker, step, { catalog, stale, onPath: isOnPath(tracker, step.id, tracker.headId) });
    },
    'history.diff': async params => {
      requireStarted('history.diff');
      const ta = params.a.tracker === undefined ? h.active : trackerNamed(params.a.tracker);
      const tb = params.b.tracker === undefined ? h.active : trackerNamed(params.b.tracker);
      const result = await h.api.diff({ tracker: ta.id, step: params.a.step }, { tracker: tb.id, step: params.b.step });
      return {
        a: { tracker: { id: ta.id, name: ta.name }, step: params.a.step },
        b: { tracker: { id: tb.id, name: tb.name }, step: params.b.step },
        common: result.common,
        domains: result.domains.map(entry => ({ domain: entry.domain, name: domainName(entry.domain), lines: entry.lines })),
      };
    },
    'history.stale': params => {
      const tracker = trackerOf(params, 'history.stale');
      return {
        tracker: { id: tracker.id, name: tracker.name },
        stale: staleOnPath(tracker, tracker.headId, staleness).map(entry => ({
          step: entry.step.id, label: entry.step.label,
          cause: entry.cause === null ? null : { step: entry.cause.id, label: entry.cause.label },
          reasons: staleReasons(entry),
        })),
      };
    },
    'history.search': params => {
      const tracker = trackerOf(params, 'history.search');
      const { tracker: _ref, ...criteria } = params;
      return { tracker: { id: tracker.id, name: tracker.name }, steps: h.api.search(criteria, tracker.id), total: tracker.steps.size };
    },
    'history.undo': async (params, { meta, signal }) => {
      requireStarted('history.undo');
      const moved = await h.api.undo(meta, { signal });
      return { moved, head: h.active.headId };
    },
    'history.redo': async (params, { meta, signal }) => {
      requireStarted('history.redo');
      const moved = await h.api.redo(meta, { signal });
      return { moved, head: h.active.headId };
    },
    'history.jump': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.jump');
      const given = ['step', 'bookmark', 'at'].filter(key => params[key] !== undefined);
      if (given.length !== 1) throw refuse('Name one of step, bookmark or at.', 'refused', 'history.jump');
      let target;
      if (params.step !== undefined) target = stepNamed(tracker, params.step).id;
      else if (params.bookmark !== undefined) {
        const step = bookmarked(tracker, params.bookmark);
        if (step === null) {
          const names = [...tracker.steps.values()].filter(each => each.bookmark !== null).map(each => each.bookmark);
          throw refuse(`There is no bookmark ${quoteName(params.bookmark)}${names.length ? `; the bookmarks are ${names.map(name => `${quoteName(name)}`).join(', ')}` : '; the tracker has no bookmark'}.`, 'no-target', 'history.jump');
        }
        target = step.id;
      } else {
        const tip = branchOf(tracker, tracker.activeBranch).tip;
        const path = pathTo(tracker, tip);
        let found = null;
        for (const step of path) if (step.at !== null && step.at <= params.at) found = step;
        target = (found ?? path[0]).id;
      }
      await jumpNow(target, meta, { signal });
      return { head: h.active.headId };
    }, { signal }),
    'history.branch.switch': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.switch');
      const branch = branchNamed(tracker, params.branch);
      if (tracker !== h.active) await useTrackerNow(tracker.id, meta, { signal });
      settleBeforeMove(tracker, byOf(meta));
      await show(tracker, branch.tip, { signal });
      tracker.activeBranch = branch.id;
      // The agent's own switch carries its turn on with it.
      carryTurn(tracker, meta);
      return { branch: { id: branch.id, name: branch.name }, head: tracker.headId };
    }, { signal }),
    'history.branch.create': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.branch.create');
      stepNamed(tracker, params.step);
      const name = params.name === undefined ? null : checkedName('branch', params.name);
      if (name !== null) {
        const clash = [...tracker.branches.values()].find(branch => nameKey(branch.name) === nameKey(name));
        if (clash) throw refuse(HISTORY_SENTENCES.nameTaken({ kind: 'branch', name: clash.name, where: clash.base === null ? null : `from step ${idNumber(clash.base)}` }), 'name-taken', 'history.branch.create');
      }
      await jumpNow(params.step, meta, { signal });
      // An agent's unnamed branch is named after it and its next change ("Claude: Colored by leiden"),
      // as any branch its change starts; the person's takes the next "Branch n".
      const agentNamed = name === null && meta.origin === 'agent';
      h.pending = agentNamed ? { name: null, from: params.step, agent: meta.agent } : { name: name ?? defaultBranchName(tracker), from: params.step };
      const shownName = h.pending.name ?? `${meta.agent}: …`;
      notify('pending', { tracker: tracker.id, pending: { ...h.pending }, sentence: HISTORY_SENTENCES.pending({ name: shownName, step: h.pending.from }) });
      return { pending: shownName, from: params.step, head: tracker.headId };
    }, { signal }),
    'history.branch.cancel': () => {
      const tracker = requireStarted('history.branch.cancel');
      const forgotten = h.pending === null ? null : (h.pending.name ?? `${h.pending.agent}: …`);
      h.pending = null;
      if (forgotten !== null) notify('pending', { tracker: tracker.id, pending: null });
      return { cancelled: forgotten };
    },
    'history.branch.rename': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.rename');
      const branch = branchNamed(tracker, params.branch);
      const was = branch.name;
      const { entry } = await journaled(tracker, { op: 'branch.rename', label: `Renamed branch "${was}" to "${params.name}"`, meta }, edit => renameBranch(tracker, edit, branch, params.name));
      return { branch: { id: branch.id, name: branch.name }, journal: journalResult(entry) };
    }, { signal }),
    'history.branch.archive': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.archive');
      const branch = branchNamed(tracker, params.branch);
      const { entry } = await journaled(tracker, { op: 'branch.archive', label: `${params.archived ? 'Archived' : 'Unarchived'} branch "${branch.name}"`, meta }, edit => archiveBranch(tracker, edit, branch, params.archived));
      return { branch: { id: branch.id, name: branch.name }, archived: branch.archived, journal: journalResult(entry) };
    }, { signal }),
    'history.branch.set-main': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.set-main');
      const branch = branchNamed(tracker, params.branch);
      const { entry } = await journaled(tracker, { op: 'branch.set-main', label: `Made branch "${branch.name}" main`, meta }, edit => setMainBranch(tracker, edit, branch));
      return { branch: { id: branch.id, name: branch.name }, journal: journalResult(entry) };
    }, { signal }),
    'history.branch.lock': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.lock');
      const branch = branchNamed(tracker, params.branch);
      const { entry } = await journaled(tracker, { op: 'branch.lock', label: `${params.locked ? 'Locked' : 'Unlocked'} branch "${branch.name}"`, meta }, edit => lockBranch(tracker, edit, branch, params.locked));
      return { branch: { id: branch.id, name: branch.name }, locked: branch.locked, journal: journalResult(entry) };
    }, { signal }),
    'history.branch.delete': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.delete');
      const branch = branchNamed(tracker, params.branch);
      // Refused before anything changes; paused changes kept as a step first are planned with.
      const withSubBranches = params.with_sub_branches === true;
      let plan = planBranchDelete(tracker, branch, { withSubBranches });
      if (tracker === h.active && settleBeforeMove(tracker, byOf(meta)) !== null) plan = planBranchDelete(tracker, branch, { withSubBranches });
      const facts = describeBranchDelete(tracker, plan);
      const names = plan.branches.length > 1 ? `"${branch.name}" and ${plan.branches.length - 1} branch${plan.branches.length === 2 ? '' : 'es'} from it` : `"${branch.name}"`;
      const { entry } = await journaled(tracker, {
        op: 'branch.delete', label: `Deleted branch ${names} (${formatCountOf(plan.removed.length, 'step')})`, meta,
      }, edit => applyBranchDelete(tracker, edit, plan));
      if (tracker === h.active) notify('moved', { tracker: tracker.id, head: tracker.headId, branch: tracker.activeBranch });
      const { first: _first, last: _last, ...result } = facts;
      return { ...result, head: tracker.headId, journal: journalResult(entry) };
    }, { signal }),
    'history.branch.without': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.branch.without');
      const step = stepNamed(tracker, params.step);
      if (step.parent === null) throw refuse('The first step of a history cannot be left out.', 'refused', 'history.branch.without');
      const end = isOnPath(tracker, step.id, tracker.headId) ? tracker.headId : branchOf(tracker, tracker.activeBranch).tip;
      if (!isOnPath(tracker, step.id, end)) throw refuse(`Step ${idNumber(step.id)} is not on the branch shown; show a step after it first.`, 'refused', 'history.branch.without');
      const later = pathBetween(tracker, step.id, end);
      const taken = [...tracker.branches.values()].map(branch => branch.name);
      const name = params.name === undefined ? suffixedName(`Without "${step.label}"`, 'more', taken) : checkedName('branch', params.name);
      return replayAsBranch(tracker, step.parent, later, name, { signal, meta });
    }, { signal }),
    'history.branch.apply': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.branch.apply');
      if (tracker !== h.active) throw refuse('A branch is applied here from the tracker in use; use its tracker first.', 'refused', 'history.branch.apply');
      const branch = branchNamed(tracker, params.branch);
      const own = branchSteps(tracker, branch.id).filter(step => step.parent !== null);
      const taken = [...tracker.branches.values()].map(each => each.name);
      const name = params.name === undefined ? suffixedName(`${branch.name} applied`, 'more', taken) : checkedName('branch', params.name);
      return replayAsBranch(tracker, tracker.headId, own, name, { signal, meta });
    }, { signal }),
    'history.verify': (params, { meta, signal }) => exclusive(async () => {
      const source = trackerOf(params, 'history.verify');
      const branch = branchNamed(source, params.branch);
      const path = pathTo(source, branch.tip);
      const before = h.active;
      settleBeforeMove(h.active, byOf(meta));
      // A domain switched off is never moved by the history: what it shows now comes back at the end.
      const offShown = Object.fromEntries(off().filter(id => h.shown[id] !== undefined).map(id => [id, h.shown[id]]));
      const rootValues = { ...path[0].after };
      // Nothing has moved when this fails: what was shown is put back, on the same tracker. A state
      // that cannot be shown (a read failing) gives no verdict, said as a step that could not run is
      // (never the read's own error, with its address).
      try {
        await restoreTo(withoutOff(rootValues), { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw Object.assign(
          refuse(`${joinFailure(`${quoteName(branch.name)} was not verified, because the state it starts from could not be shown`, sayFailure(error))}`, 'unavailable', 'history.verify'),
          { reason: error },
        );
      }
      const scratch = beginTracker({
        name: suffixedName(`Verify ${branch.name}`, 'more', liveTrackers().map(each => each.name)),
        start: { kind: 'replay', from: { dataset: { id: dataset.id ?? null, name: dataset.name ?? null }, tracker: { id: source.id, name: source.name }, branch: { id: branch.id, name: branch.name }, step: branch.tip, file: null, saved: null }, report: [], mapping: null },
        rootValues, by: createBy({ origin: 'replay' }),
      });
      scratch.paused = null;
      const domainsDiffering = [];
      let failure = null;
      try {
        const failures = [];
        const report = await replaySteps(scratch, path.slice(1), { source: { tracker: source.id, dataset: { id: dataset.id ?? null, name: dataset.name ?? null }, own: true }, signal, failures });
        scratch.start.report = report;
        // A step that could not run (its field unreadable now) says nothing about the branch: no verdict is given.
        if (failures.length > 0) {
          // The step's own failure goes with it (`reason`, not `cause`: the sentence says it once): a
          // problem inside Cellucid keeps its words under Details.
          throw Object.assign(refuse(unverifiedSentence(branch, failures[0]), 'unavailable', 'history.verify'), { reason: failures[0].error });
        }
        const expected = valuesAt(source, branch.tip);
        const got = valuesAt(scratch, scratch.headId);
        const offIds = new Set(Object.keys(offShown));
        for (const id of DOMAIN_IDS) {
          // A domain switched off is not replayed, so it is not compared; values are compared but for
          // generated ids and times (`canonicalOf`).
          if (offIds.has(id) || await sameCanonical(id, expected[id], got[id], expected['field-overlays'], got['field-overlays'])) continue;
          let first = null;
          for (const entry of report) {
            if (entry.step === null) continue;
            const made = stepOf(scratch, entry.step);
            const src = stepOf(source, entry.source);
            const madeAt = valuesAt(scratch, made.id);
            const srcAt = valuesAt(source, src.id);
            if (!await sameCanonical(id, madeAt[id], srcAt[id], madeAt['field-overlays'], srcAt['field-overlays'])) { first = entry.source; break; }
          }
          const owner = domains.owner(id);
          const lines = typeof owner.describe === 'function' ? await owner.describe(pool.get(expected[id]), pool.get(got[id]), {}) : ['differs'];
          domainsDiffering.push({ domain: id, first_step: first, lines });
        }
      } catch (error) {
        failure = error;
      }
      if (failure === null && params.keep === true) {
        await restoreTo(offShown);
        return { reproduced: domainsDiffering.length === 0, steps: path.length - 1, domains: domainsDiffering, scratch: { id: scratch.id, name: scratch.name } };
      }
      // Back to what the person was looking at, then the scratch tracker goes: on a failure to go
      // back, what is shown and the tracker in use still agree, and they are told.
      const head = valuesAt(before, before.headId);
      try {
        await restoreTo({ ...head, ...(before.paused?.draft ?? {}), ...offShown });
      } catch (error) {
        throw refuse(`${joinFailure(`What ${quoteName(before.name)} shows could not be put back, so ${quoteName(scratch.name)} stays in use until ${quoteName(before.name)} is used again`, sayFailure(error))}`, 'unavailable', 'history.verify');
      }
      trackers.delete(scratch.id);
      h.usedOrder = h.usedOrder.filter(id => id !== scratch.id);
      use(before);
      h.headValues = head;
      prune();
      notify('tracker', { tracker: before.id });
      if (failure !== null) throw failure;
      return { reproduced: domainsDiffering.length === 0, steps: path.length - 1, domains: domainsDiffering, scratch: null };
    }, { signal }),
    'history.step.delete': async (params, { meta, signal }) => {
      requireStarted('history.step.delete');
      const result = await h.api.deleteStep(params.step, { signal, meta });
      return result;
    },
    'history.step.revert': async (params, { meta }) => {
      // A state action: the values put back are the reverted step's before-values, exactly.
      const tracker = requireStarted('history.step.revert');
      const step = stepNamed(tracker, params.step);
      if (step.parent === null) throw refuse('The first step of a history cannot be reverted.', 'refused', 'history.step.revert');
      if (!isOnPath(tracker, step.id, tracker.headId)) throw refuse(`Step ${idNumber(step.id)} is not on the path to the step shown; show a step after it first.`, 'not-revertible', 'history.step.revert');
      const later = pathBetween(tracker, step.id, tracker.headId);
      const clash = orderedDomains(step.touches.filter(domain => later.some(each => each.touches.includes(domain))));
      if (clash.length > 0) throw refuse(HISTORY_SENTENCES.notRevertible({ domains: clash.map(domainName) }), 'not-revertible', 'history.step.revert');
      h.restoringDepth++;
      try {
        await putBack(step.before, null);
      } finally {
        h.restoringDepth--;
      }
      return { reverted: step.id };
    },
    'history.squash': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.squash');
      const by = byOf(meta);
      const run = squashableRun(tracker, params.from, params.to, by);
      if (run.length === 1 && run[0].kind === 'squashed' && run[0].squashed.cause === 'steps') {
        throw refuse(`Step ${idNumber(run[0].id)} is one squashed step already; squash it with the steps beside it.`, 'not-consecutive', 'history.squash');
      }
      let made;
      const { entry } = await journaled(tracker, { op: 'squash', label: `Merged ${formatCountOf(run.length, 'step')} into one`, meta }, edit => {
        made = squashRun(tracker, edit, run, { cause: 'steps', by, domainName });
        edit.relabel(`${made.step.label}`);
      });
      if (tracker === h.active) h.headValues = valuesAt(tracker, tracker.headId);
      return { step: made.step.id, squashed: run.length, groups_removed: made.groupsRemoved, head: tracker.headId, journal: journalResult(entry) };
    }, { signal }),
    'history.clear': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.clear');
      const by = byOf(meta);
      settleBeforeMove(tracker, by);
      const taken = [...tracker.branches.values()].map(branch => branch.name);
      const name = suffixedName(FRESH_START_BRANCH_NAME, 'more', taken);
      if (!params.keep_state) {
        // Starting over: the opening is shown and "Fresh start" begins with the next change; every
        // branch stays, and the move is kept in Recently changed (undo shows where it was).
        const { entry } = await journaled(tracker, { op: 'clear', label: `Cleared the history, starting over ("${name}")`, meta }, edit => {
          edit.field('headId');
          edit.field('activeBranch');
          tracker.headId = tracker.rootId;
          tracker.activeBranch = stepOf(tracker, tracker.rootId).branch;
        });
        h.pending = { name, from: tracker.rootId };
        carryTurn(tracker, meta);
        notify('moved', { tracker: tracker.id, head: tracker.headId, branch: tracker.activeBranch });
        notify('pending', { tracker: tracker.id, pending: { ...h.pending } });
        return { branch: null, head: tracker.headId, journal: journalResult(entry) };
      }
      const rootValues = stepOf(tracker, tracker.rootId).after;
      const path = pathTo(tracker, tracker.headId).slice(1);
      let made = null;
      const { entry } = await journaled(tracker, { op: 'clear', label: `Cleared the history, keeping the state ("${name}")`, meta }, edit => {
        const id = idOf('step', tracker.nextStep);
        const branchId = idOf('branch', tracker.nextBranch);
        edit.step(id);
        edit.step(tracker.rootId);
        edit.branch(branchId);
        edit.field('headId');
        edit.field('activeBranch');
        const touches = orderedDomains(Object.keys(h.headValues).filter(domain => h.headValues[domain] !== rootValues[domain]));
        tracker.headId = tracker.rootId;
        h.pending = { name, from: tracker.rootId };
        made = appendRecord(tracker, {
          kind: 'squashed', by, at: now(), touches,
          before: Object.fromEntries(touches.map(domain => [domain, rootValues[domain]])),
          after: Object.fromEntries(touches.map(domain => [domain, h.headValues[domain]])),
          squashed: { cause: 'clear', count: Math.max(1, path.length), by: path.length ? authorsOf(path) : [by], carried: { notes: [], bookmarks: [] } },
        }, {});
      });
      return { branch: { id: made.branch, name: branchOf(tracker, made.branch).name }, head: tracker.headId, journal: journalResult(entry) };
    }, { signal }),
    'history.recording.pause': async (params, { meta }) => {
      requireStarted('history.recording.pause');
      const { since, head } = await h.api.setRecording(false, { tracker: params.tracker ?? null, meta });
      return { since, head };
    },
    'history.recording.resume': async (params, { meta }) => {
      requireStarted('history.recording.resume');
      const { squashed, head } = await h.api.setRecording(true, { tracker: params.tracker ?? null, meta });
      return { squashed, head };
    },
    'history.group.create': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.group.create');
      let made;
      const { entry } = await journaled(tracker, { op: 'group.create', label: `Grouped steps ${idNumber(params.from)} to ${idNumber(params.to)} as "${params.name}"`, meta }, edit => {
        made = createGroupOver(tracker, edit, { from: params.from, to: params.to, name: params.name, by: byOf(meta), at: now() });
      });
      return { group: { id: made.group.id, name: made.group.name }, steps: made.steps, journal: journalResult(entry) };
    }, { signal }),
    'history.group.rename': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.group.rename');
      const group = groupNamed(tracker, params.group);
      const was = group.name;
      const { entry } = await journaled(tracker, { op: 'group.rename', label: `Renamed the group "${was}" to "${params.name}"`, meta }, edit => renameGroup(tracker, edit, group, params.name));
      return { group: { id: group.id, name: group.name }, journal: journalResult(entry) };
    }, { signal }),
    'history.group.extend': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.group.extend');
      const group = groupNamed(tracker, params.group);
      let steps;
      const { entry } = await journaled(tracker, { op: 'group.extend', label: `Extended the group "${group.name}" to step ${idNumber(params.to)}`, meta }, edit => {
        steps = extendGroup(tracker, edit, group, params.to);
      });
      return { group: { id: group.id, name: group.name }, steps, journal: journalResult(entry) };
    }, { signal }),
    'history.group.remove': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.group.remove');
      const group = groupNamed(tracker, params.group);
      const { entry } = await journaled(tracker, { op: 'group.remove', label: `Ungrouped "${group.name}"`, meta }, edit => removeGroup(tracker, edit, group));
      return { group: { id: group.id, name: group.name }, journal: journalResult(entry) };
    }, { signal }),
    'history.note.add': (params, { meta, signal }) => exclusive(async () => {
      const target = params.target;
      const tracker = trackerOf(target, 'history.note.add');
      const by = byOf(meta);
      if (params.from_reply && by.origin !== 'agent') throw refuse('Only a note written for an agent is taken from its reply.', 'refused', 'history.note.add');
      const id = idOf('note', tracker.nextNote);
      let where;
      const { entry } = await journaled(tracker, { op: 'note.add', label: 'Added a note', meta }, edit => {
        const note = createNote({ id, text: params.text, by, at: now(), fromReply: params.from_reply === true });
        edit.field('notes');
        if (target.step !== undefined) {
          const step = stepNamed(tracker, target.step);
          edit.step(step.id);
          step.notes.push(note);
          where = `step ${idNumber(step.id)}`;
        } else if (target.branch !== undefined) {
          const branch = branchNamed(tracker, target.branch);
          edit.branch(branch.id);
          branch.notes.push(note);
          where = `branch "${branch.name}"`;
        } else if (target.group !== undefined) {
          const group = groupNamed(tracker, target.group);
          edit.group(group.id);
          group.notes.push(note);
          where = `group "${group.name}"`;
        } else if (target.turn !== undefined) {
          const turn = tracker.turns.get(target.turn);
          if (turn === undefined) throw refuse(HISTORY_SENTENCES.noTurn({ turn: target.turn, tracker: tracker.name, then: 'no record to hold a note' }), 'no-target', 'history.note.add');
          edit.turn(turn.id);
          turn.notes.push(note);
          where = `the turn "${turn.label}"`;
        } else {
          tracker.notes.push(note);
          where = `tracker "${tracker.name}"`;
        }
        tracker.nextNote++;
        edit.relabel(`Added a note on ${where}`);
      });
      return { note: id, journal: journalResult(entry) };
    }, { signal }),
    'history.note.edit': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.note.edit');
      const { note, holder } = noteOf(tracker, params.note);
      requireNoteAuthor(note, meta);
      const { entry } = await journaled(tracker, { op: 'note.edit', label: `Edited note ${params.note}`, meta }, edit => {
        holder.tell(edit);
        const held = holder.notes().find(each => each.id === params.note);
        held.text = params.text;
        held.editedAt = now();
      });
      return { note: params.note, journal: journalResult(entry) };
    }, { signal }),
    'history.note.remove': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.note.remove');
      const { note, holder } = noteOf(tracker, params.note);
      requireNoteAuthor(note, meta);
      const { entry } = await journaled(tracker, { op: 'note.remove', label: `Removed note ${params.note}`, meta }, edit => {
        holder.tell(edit);
        holder.set(holder.notes().filter(each => each.id !== params.note));
      });
      return { note: params.note, journal: journalResult(entry) };
    }, { signal }),
    'history.bookmark.set': (params, { meta, signal }) => exclusive(async () => {
      const tracker = requireStarted('history.bookmark.set');
      const step = stepNamed(tracker, params.step);
      let name;
      const label = params.name === null ? `Removed the bookmark of step ${idNumber(step.id)}` : `Bookmarked step ${idNumber(step.id)} "${params.name}"`;
      const { entry } = await journaled(tracker, { op: 'bookmark.set', label, meta }, edit => { name = setBookmark(tracker, edit, step, params.name); });
      if (step.id === tracker.headId) h.coalesceStep = null;
      return { step: step.id, bookmark: name, journal: journalResult(entry) };
    }, { signal }),
    'history.tracker.start': async (params, { meta, signal }) => {
      requireStarted('history.tracker.start');
      const tracker = await exclusive(() => startTracker({ start: params.start ?? 'opened', name: params.name ?? null, meta }), { signal });
      return { tracker: { id: tracker.id, name: tracker.name }, head: tracker.headId };
    },
    'history.tracker.use': async (params, { meta, signal }) => {
      requireStarted('history.tracker.use');
      await h.api.useTracker(params.tracker, meta, { signal });
      return { tracker: { id: h.active.id, name: h.active.name }, head: h.active.headId };
    },
    'history.tracker.rename': (params, { meta, signal }) => exclusive(async () => {
      requireStarted('history.tracker.rename');
      const tracker = trackerNamed(params.tracker);
      const name = checkedName('tracker', params.name);
      const clash = liveTrackers().find(other => other !== tracker && nameKey(other.name) === nameKey(name));
      if (clash) throw refuse(HISTORY_SENTENCES.nameTaken({ kind: 'tracker', name: clash.name }), 'name-taken', 'history.tracker.rename');
      const was = tracker.name;
      const { entry } = await journaled(tracker, { op: 'tracker.rename', label: `Renamed the tracker "${was}" to "${name}"`, meta }, edit => {
        edit.field('name');
        tracker.name = name;
      });
      notify('tracker', { tracker: tracker.id });
      return { tracker: { id: tracker.id, name: tracker.name }, journal: journalResult(entry) };
    }, { signal }),
    'history.tracker.remove': (params, { meta, signal }) => exclusive(async () => {
      requireStarted('history.tracker.remove');
      const tracker = trackerNamed(params.tracker);
      const entry = await h.removeTracker(tracker, byOf(meta), 'history.tracker.remove');
      return { tracker: { id: tracker.id, name: tracker.name }, shown: { id: h.active.id, name: h.active.name }, journal: entry.id };
    }, { signal }),
    'history.turn.undo': async (params, { meta, signal }) => {
      requireStarted('history.turn.undo');
      const { head, removed, other_branches: otherBranches, journal } = await h.api.undoTurn(params.turn, { onlyOwn: params.only_own === true, meta, signal });
      return { head, removed, other_branches: otherBranches, journal };
    },
    'history.journal.undo': (params, { meta, signal }) => exclusive(async () => {
      const tracker = trackerOf(params, 'history.journal.undo', { removed: true });
      return restoreEntry(tracker, params.entry, { meta, signal });
    }, { signal }),
    'history.journal.empty': (params, { signal }) => exclusive(async () => {
      requireStarted('history.journal.empty');
      const bytesBefore = pool.byteLength();
      const scope = params.tracker !== undefined || params.entry !== undefined
        ? [trackerOf(params, 'history.journal.empty', { removed: true })] : [...trackers.values()];
      let purged = 0;
      for (const tracker of scope) {
        purged += purgeEntries(tracker, params.entry ?? null).length;
        // A tracker whose removal is emptied is gone for good.
        if (tracker.removed !== null && !tracker.journal.some(entry => entry.op === 'tracker.remove' && !entry.purged)) {
          trackers.delete(tracker.id);
        }
        notify('edited', { tracker: tracker.id, op: 'journal.empty', journal: null, label: 'Emptied Recently deleted', steps: [], removed: [] });
      }
      prune();
      return { purged, bytes: Math.max(0, bytesBefore - pool.byteLength()) };
    }, { signal }),
    'history.replay': async (params, { meta, signal }) => {
      requireStarted('history.replay');
      if (openSaved === null) throw refuse('Saved states cannot be read on this page.', 'unavailable', 'history.replay');
      // Read as Replay… reads it (every record checked); a Stop ends the read at once, wherever it is.
      const source = await awaitWithSignal(openSaved(params.saved), signal);
      const plan = await readReplayPlan(source, { signal, tracker: params.tracker ?? null, branch: params.branch ?? null, saved: params.saved });
      const mapping = params.mapping ?? null;
      const result = await h.api.replay({ ...plan, name: params.name ?? plan.name, mapping }, { signal, meta });
      const tracker = trackers.get(result.tracker);
      return { tracker: { id: tracker.id, name: tracker.name }, report: result.report };
    },
  };

  /** The default name of the next new branch of `tracker`. */
  function defaultBranchName(tracker) {
    const taken = [...tracker.branches.values()].map(branch => branch.name);
    let n = tracker.nextBranch;
    while (taken.some(name => nameKey(name) === nameKey(`Branch ${n}`))) n++;
    return `Branch ${n}`;
  }

  /** A note by id and what holds it (a step, a branch, a group, a turn or the tracker). */
  function noteOf(tracker, noteId) {
    const holders = [
      { notes: () => tracker.notes, set: list => { tracker.notes = list; }, tell: edit => edit.field('notes') },
      ...[...tracker.branches.values()].map(branch => ({ notes: () => branch.notes, set: list => { branch.notes = list; }, tell: edit => edit.branch(branch.id) })),
      ...[...tracker.groups.values()].map(group => ({ notes: () => group.notes, set: list => { group.notes = list; }, tell: edit => edit.group(group.id) })),
      ...[...tracker.turns.values()].map(turn => ({ notes: () => turn.notes, set: list => { turn.notes = list; }, tell: edit => edit.turn(turn.id) })),
    ];
    for (const holder of holders) {
      const note = holder.notes().find(each => each.id === noteId);
      if (note) return { note, holder };
    }
    for (const step of tracker.steps.values()) {
      const note = step.notes.find(each => each.id === noteId);
      if (note) return { note, holder: { notes: () => step.notes, set: list => { step.notes = list; }, tell: edit => edit.step(step.id) } };
    }
    throw refuse(`There is no note ${quoteName(noteId)} in the tracker ${quoteName(tracker.name)}.`, 'no-target');
  }

  /** An agent edits and removes only its own notes; the person (and their notebook) any. */
  function requireNoteAuthor(note, meta) {
    if ((meta?.origin ?? 'user') !== 'agent') return;
    if (note.by.origin !== 'agent' || note.by.agent !== meta.agent) throw refuse(HISTORY_SENTENCES.notAuthor(), 'not-author');
  }

  // What a delete or a squash would refuse is refused here, before the person is asked about it
  // (`provideEstimate`): an agent never gets a card approved for a change that is then refused.
  const estimators = [
    ['history.squash', (params, { meta }) => {
      if (h.active === null) return null;
      const run = squashableRun(h.active, params.from, params.to, byOf(meta));
      return { ms: null, bytes: null, what: `merges ${formatCountOf(run.length, 'step')} into one` };
    }],
    ['history.branch.delete', params => {
      if (h.active === null) return null;
      const tracker = params.tracker === undefined ? h.active : trackerOf(params, 'history.branch.delete');
      const plan = planBranchDelete(tracker, branchNamed(tracker, params.branch), { withSubBranches: params.with_sub_branches === true });
      return { ms: null, bytes: null, what: `removes ${formatCountOf(plan.removed.length, 'step')}` };
    }],
    ['history.step.delete', params => {
      if (h.active === null || !h.active.steps.has(params.step)) return null;
      const plan = h.api.deletePlan(params.step);
      return { ms: plan.ms, bytes: null, what: `applies ${formatCountOf(plan.reapply.length, 'later step')} again` };
    }],
    ['history.branch.without', params => {
      if (h.active === null || !h.active.steps.has(params.step)) return null;
      const later = isOnPath(h.active, params.step, h.active.headId) ? pathBetween(h.active, params.step, h.active.headId) : [];
      return { ms: later.reduce((sum, step) => sum + (step.ms ?? 0), 0), bytes: null, what: `applies ${formatCountOf(later.length, 'step')} again` };
    }],
    ['history.branch.apply', params => {
      if (h.active === null) return null;
      try {
        const own = branchSteps(h.active, branchNamed(h.active, params.branch).id);
        return { ms: own.reduce((sum, step) => sum + (step.ms ?? 0), 0), bytes: null, what: `applies ${formatCountOf(own.length, 'step')} again` };
      } catch { return null; }
    }],
    ['history.verify', params => {
      if (h.active === null) return null;
      try {
        const path = pathTo(h.active, branchNamed(h.active, params.branch).tip);
        return { ms: path.reduce((sum, step) => sum + (step.ms ?? 0), 0), bytes: null, what: `replays ${formatCountOf(path.length - 1, 'step')}` };
      } catch { return null; }
    }],
    // Priced by the time its steps took when recorded, as an apply and a verify are: a replay
    // of a step that summed the cells' totals is heavy before it starts. Only the saved state's steps
    // are read (its first chunks); a saved state or branch the replay would refuse is its to say.
    ['history.replay', async (params, { signal }) => {
      if (h.active === null || openSaved === null) return null;
      let source = null;
      try {
        source = await awaitWithSignal(openSaved(params.saved), signal);
        const eager = await awaitWithSignal(source.readEager(), signal);
        const { steps } = replayPlanOf(eager.history, { tracker: params.tracker ?? null, branch: params.branch ?? null, saved: params.saved });
        return { ms: steps.reduce((sum, step) => sum + (step.ms ?? 0), 0), bytes: null, what: `replays ${formatCountOf(steps.length, 'step')}` };
      } catch (error) {
        if (signal?.aborted) throw error;
        return null;
      } finally {
        await Promise.resolve(source?.cancel?.('Only the steps were needed for the estimate.')).catch(() => {});
      }
    }],
  ];

  return { handlers, estimators, staleness, describeBranchDelete };
}
