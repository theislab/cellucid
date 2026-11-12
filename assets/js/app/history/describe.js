/**
 * @fileoverview The history as an agent, a notebook or the docs read it:
 * `history.summary` (the whole tracker at a glance, without its steps: a
 * size that grows with branches, groups and turns, never with steps),
 * `history.get` (one branch's path, a page at a time, so every answer stays
 * under the connector's result limit), and `history.step` (one step in
 * full). Pure: it reads the live trackers (`tree.js`), never changes them.
 *
 * @module app/history/describe
 */

import { idNumber } from './model.js';
import { depthOf, isOnPath, pathTo, stepOf } from './tree.js';
import { staleReasons } from './provenance.js';
import { parameterFacts } from './exports/step-text.js';

import { HISTORY_PAGE_STEPS as DEFAULT_PAGE_STEPS } from '../actions/definitions/history.js';

const idName = record => ({ id: record.id, name: record.name });

/** Who acted, as reads give it (snake_case keys as every result). */
export function byResult(by) {
  return { origin: by.origin, agent: by.agent, model: by.model, host: by.host, person: by.person, turn: by.turn };
}

/** A note, as reads give it. */
export function noteResult(note) {
  return { id: note.id, text: note.text, by: byResult(note.by), at: note.at, edited_at: note.editedAt, from_reply: note.fromReply };
}

/**
 * `history.summary`: trackers, branches (fork step, tip, own steps, flags),
 * groups, bookmarks, turns, the recording switch, the pending branch, stale
 * results and Recently deleted, without the steps; the notes on the tracker,
 * each branch, group and turn in full (a turn's first is its summary). Only
 * counts once: a colleague's agent opening a shared session read "notes: 1"
 * on each branch and no read gave their text, so it said the donor check the
 * notes reported "is not recorded" (live-7 L25-9).
 */
export function historySummary(tracker, { trackers, active, pending, stale }) {
  const own = new Map([...tracker.branches.keys()].map(id => [id, 0]));
  const groups = new Map([...tracker.groups.keys()].map(id => [id, { first: null, last: null, steps: 0, branch: null }]));
  const turnSteps = new Map();
  const bookmarks = [];
  for (const step of tracker.steps.values()) {
    own.set(step.branch, (own.get(step.branch) ?? 0) + 1);
    if (step.group !== null) {
      const facts = groups.get(step.group);
      facts.steps++;
      facts.branch = step.branch;
      if (facts.first === null || idNumber(step.id) < idNumber(facts.first)) facts.first = step.id;
      if (facts.last === null || idNumber(step.id) > idNumber(facts.last)) facts.last = step.id;
    }
    if (step.by.turn !== null) turnSteps.set(step.by.turn, (turnSteps.get(step.by.turn) ?? 0) + 1);
    if (step.bookmark !== null) bookmarks.push({ name: step.bookmark, step: step.id });
    // A squash carries the bookmarks of the steps it replaced: each shows the squashed step.
    for (const name of step.squashed?.carried.bookmarks ?? []) bookmarks.push({ name, step: step.id });
  }
  return {
    tracker: idName(tracker),
    notes: tracker.notes.map(noteResult),
    trackers: trackers.map(each => ({
      id: each.id, name: each.name, active: each === active, steps: each.steps.size, start: each.start.kind,
    })),
    head: tracker.headId,
    active_branch: tracker.activeBranch,
    main_branch: tracker.mainBranch,
    recording: { on: tracker.paused === null, since: tracker.paused?.at ?? null },
    pending: pending === null || tracker !== active ? null : { name: pending.name, from: pending.from },
    steps: tracker.steps.size,
    branches: [...tracker.branches.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(branch => ({
      id: branch.id, name: branch.name, base: branch.base, tip: branch.tip, steps: own.get(branch.id) ?? 0,
      main: branch.id === tracker.mainBranch, locked: branch.locked, archived: branch.archived,
      active: branch.id === tracker.activeBranch, notes: branch.notes.map(noteResult),
    })),
    groups: [...tracker.groups.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(group => {
      const facts = groups.get(group.id);
      return { id: group.id, name: group.name, branch: facts.branch, first: facts.first, last: facts.last, steps: facts.steps, notes: group.notes.map(noteResult) };
    }),
    bookmarks: bookmarks.sort((a, b) => idNumber(a.step) - idNumber(b.step)),
    turns: [...tracker.turns.values()].map(turn => ({
      id: turn.id, label: turn.label, by: byResult(turn.by), steps: turnSteps.get(turn.id) ?? 0, branch: turn.branch,
      notes: turn.notes.map(noteResult),
    })),
    stale,
    recently_deleted: tracker.journal.filter(entry => !entry.purged).length,
  };
}

/** One step as `history.get` lists it (the catalog's step row). */
function stepRow(step, shown) {
  return {
    id: step.id,
    parent: step.parent,
    kind: step.kind,
    squash: step.squashed?.cause ?? null,
    label: step.label,
    type: step.type,
    v: step.v,
    code: step.code,
    origin: step.by.origin,
    agent: step.by.agent,
    host: step.by.host,
    turn: step.by.turn,
    at: step.at,
    status: step.status,
    note: step.reason,
    touches: [...step.touches],
    group: step.group,
    shown,
  };
}

/** Every step of a tracker, root first, parents before children (oldest child first), without recursion. */
function stepsInOrder(tracker) {
  const out = [];
  const pending = [tracker.rootId];
  while (pending.length > 0) {
    const step = stepOf(tracker, pending.pop());
    out.push(step);
    for (let index = step.children.length - 1; index >= 0; index--) pending.push(step.children[index]);
  }
  return out;
}

/**
 * `history.get`: one page of steps of `tracker`: the path to the step shown,
 * to a branch's tip (`branch`) or every branch (`all_branches`); only those
 * recorded at or after `since`; from `cursor`, `limit` of them; each with
 * the `fields` asked for (params in words, notes, bookmark).
 */
export function historyPage(tracker, {
  branch = null, all_branches: allBranches = false, since = undefined, limit = DEFAULT_PAGE_STEPS, cursor = undefined, fields = [],
}, { trackers, active, catalog = null }) {
  if (branch !== null && allBranches) throw new RangeError('Name a branch or ask for every branch, not both.');
  const along = branch === null ? null : branch.tip;
  let listed = allBranches ? stepsInOrder(tracker) : pathTo(tracker, along ?? tracker.headId);
  if (since !== undefined) listed = listed.filter(step => step.at !== null && step.at >= since);
  let start = 0;
  if (cursor !== undefined) {
    const at = listed.findIndex(step => step.id === cursor);
    if (at < 0) throw new RangeError(`There is no step "${cursor}" ${allBranches ? 'in the tracker' : `on the path to ${along === null ? 'the step shown' : `the tip of "${branch.name}"`}`}${since === undefined ? '' : ' since then'}; start again without a cursor.`);
    start = at + 1;
  }
  const page = listed.slice(start, start + limit);
  const headDepth = depthOf(tracker, tracker.headId);
  const last = start + page.length;
  const wanted = new Set(fields);
  return {
    tracker: idName(tracker),
    trackers: trackers.map(each => ({ id: each.id, name: each.name, active: each === active })),
    head: tracker.headId,
    branches: [...tracker.branches.values()].map(each => ({ name: each.name, tip: each.tip, active: each.id === tracker.activeBranch })),
    steps: page.map(step => {
      const depth = depthOf(tracker, step.id);
      const shown = (along === null && !allBranches) || (depth <= headDepth && isOnPath(tracker, step.id, tracker.headId));
      const row = stepRow(step, shown);
      if (wanted.has('params')) {
        const schema = step.type !== null && catalog?.has?.(step.type) ? catalog.get(step.type).params : null;
        row.params = step.params === null ? [] : parameterFacts(step.params, schema).map(fact => ({ label: fact.label, value: String(fact.value) }));
      }
      if (wanted.has('notes')) row.notes = step.notes.map(noteResult);
      if (wanted.has('bookmark')) row.bookmark = step.bookmark;
      return row;
    }),
    total: listed.length,
    next: last < listed.length ? page[page.length - 1].id : null,
  };
}

/** `history.step`: one step in full, with why it is stale. */
export function describeStep(tracker, step, { catalog, stale, onPath }) {
  const schema = step.type !== null && catalog?.has?.(step.type) ? catalog.get(step.type).params : null;
  const branch = tracker.branches.get(step.branch);
  const group = step.group === null ? null : tracker.groups.get(step.group);
  return {
    tracker: idName(tracker),
    id: step.id,
    parent: step.parent,
    children: [...step.children],
    branch: branch === undefined ? { id: step.branch, name: step.branch } : idName(branch),
    kind: step.kind,
    type: step.type,
    v: step.v,
    label: step.label,
    code: step.code,
    params: step.params === null ? [] : parameterFacts(step.params, schema).map(fact => ({ label: fact.label, value: String(fact.value) })),
    by: byResult(step.by),
    at: step.at,
    until: step.until,
    merged: step.merged,
    ms: step.ms,
    touches: [...step.touches],
    reads: Object.keys(step.reads),
    status: step.status,
    reason: step.reason,
    squashed: step.squashed === null ? null : {
      cause: step.squashed.cause, count: step.squashed.count, by: step.squashed.by.map(byResult),
      carried: { notes: [...step.squashed.carried.notes], bookmarks: [...step.squashed.carried.bookmarks] },
    },
    notes: step.notes.map(noteResult),
    bookmark: step.bookmark,
    group: group === undefined || group === null ? null : idName(group),
    replay_of: step.replayOf === null ? null : { tracker: step.replayOf.tracker, step: step.replayOf.step },
    stale: stale === null ? null : {
      cause: stale.cause === null ? null : { step: stale.cause.id, label: stale.cause.label },
      reasons: staleReasons(stale),
    },
    shown: onPath,
  };
}
