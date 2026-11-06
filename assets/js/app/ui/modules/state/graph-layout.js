/**
 * @fileoverview The branch graph as rows (History v2 §3.9): pure, so it is
 * proved in Node and the panel only draws it.
 *
 * **Rows**, in tree order (the order a screen reader walks them):
 * - the steps of the active branch's path, root first, in column 0; the
 *   steps after the one shown are undone (faded, redo brings them back);
 * - after each step, one **fork stub** per branch that leaves the line there
 *   (a branch that starts at that step, or the rest of an earlier branch the
 *   path leaves), in the next column, collapsed until expanded; an expanded
 *   stub is followed by that branch's own steps in its column, with their
 *   own stubs nested;
 * - **turns** (an agent's or a notebook's) as one header row with the turn's
 *   steps under it (expanded unless collapsed); **groups** (§3.15.2) as one
 *   node (collapsed unless expanded), which says when the step shown or a
 *   fork is inside it; **runs** of consecutive view or layout steps (camera
 *   moves, panels, open sections, colours: never one that changes what is
 *   coloured by or filtered) as one folded row, "Camera ×6 · Layout ×2"
 *   (§3.3.8): display only, undo still goes step by step;
 * - while recording is paused, a **paused** marker after the step shown.
 *
 * With a **filter** (search), containers are flattened, the steps that do not
 * match fold into runs, the step shown always stays, and a stub is expanded
 * exactly when its branch (or one starting from it) holds a match.
 *
 * **Lanes.** Column 0 is the path; a stub and its expanded branch take the
 * next column, so columns are the nesting depth and are reused as soon as a
 * branch's rows end (straight lanes, no crossing). Each row lists the line
 * segments that cross it (`segments`: column, colour slot, top or bottom
 * half or all of it), so any window of rows draws on its own. Colours are
 * the branches' own slots (`Branch.lane`); colour is never the only cue.
 *
 * The layout walks the path shown once, and each expanded branch's own
 * steps: O(steps on the path + steps of the branches expanded), each step a
 * few map reads. A collapsed stub costs its branch's step count; the rows it
 * makes are what the graph keeps (`graph.js` draws only those in view).
 *
 * @module ui/modules/state/graph-layout
 */

import { idNumber } from '../../../history/model.js';
import { METHOD_DOMAINS } from '../../../history/exports/step-text.js';

/**
 * Effects whose steps fold into runs: they present the analysis, they are
 * not it. A step of these effects that changes a part of the analysis (what
 * is coloured by, the filters: `METHOD_DOMAINS`) stays a row of its own.
 */
export const FOLDED_EFFECTS = Object.freeze(new Set(['view', 'layout']));

/**
 * @typedef {object} GraphOptions
 * @property {Set<string>} [expandedForks] - branch ids whose stub is expanded
 * @property {Set<string>} [collapsedTurns] - turn row keys collapsed (turns are expanded by default)
 * @property {Set<string>} [expandedGroups] - group ids expanded (groups are collapsed by default)
 * @property {Set<string>} [expandedRuns] - run row keys expanded
 * @property {((step: object) => boolean)|null} [filter] - search: whether a step matches
 * @property {Set<string>} [offDomains] - domains not recorded now (History settings): their steps dim
 * @property {(type: string) => (string|null)} [effectOf] - an action's effect (the catalogue)
 * @property {(step: object) => string} [categoryOf] - a folded step's category ("Camera")
 */

/**
 * @typedef {object} GraphRow
 * @property {string} key - stable: `s:<step>`, `f:<branch>`, `t:<turn>@<first step>`, `g:<group>@<first step>`,
 *   `r:<first step>`, `p:paused`
 * @property {'step'|'fork'|'turn'|'group'|'run'|'paused'} kind
 * @property {number} level - its tree level (aria-level, 1 for the path)
 * @property {number} indent - how many turns, groups or runs of its line it is inside
 * @property {number} column - its lane column
 * @property {number} color - its lane colour slot
 * @property {string} chain - the line it is on (`c0` the path, `c:<branch>` a stub's)
 * @property {string[]} stepIds - the steps it stands for, first to last
 * @property {'past'|'head'|'undone'|null} position
 * @property {boolean|null} expanded - null when it does not expand
 * @property {boolean} dim - undone, after the paused marker, or a detail not recorded now
 * @property {number} posInSet
 * @property {number} setSize
 * @property {string|null} parent - the key of the row it is under
 * @property {Array<{column: number, color: number, part: 'all'|'top'|'bottom', faded: boolean}>} segments
 * @property {{from: number, color: number}|null} elbow - a stub's connector from its fork's column
 */

const NONE = new Set();

/**
 * The rows of the graph of `view` (`history-source.js` `trackerView`).
 *
 * **Appends.** Given the layout before (`previous`, laid out with the same
 * options), a history that only took new steps at the tip it showed keeps
 * every row above the last row of the path: only that row (the turn, run or
 * step the new steps may join) and what follows are laid out again, and the
 * lanes and places of the rows kept are patched, not drawn again. So a new
 * step costs the rows it touches, not the history's length. Anything else
 * (a move, an edit, a search, a pause, a new branch) lays everything out.
 *
 * @param {import('./history-source.js').TrackerView} view
 * @param {GraphOptions} [options]
 * @param {{view: import('./history-source.js').TrackerView, layout: object}|null} [previous] - the layout before, with the same options
 * @returns {{rows: GraphRow[], headRow: number, columns: number, steps: number, undone: number, matches: number|null, kept: number}}
 *   `steps`: the steps on the path (not the root); `undone`: those after the step shown; `matches`: steps
 *   matching the filter, or null; `kept`: the rows kept from `previous` (0 when all were laid out)
 */
export function layoutGraph(view, {
  expandedForks = NONE, collapsedTurns = NONE, expandedGroups = NONE, expandedRuns = NONE,
  filter = null, offDomains = NONE, effectOf = () => null, categoryOf = () => 'Step',
} = {}, previous = null) {
  const path = view.path();
  const headIndex = view.pathIndex().get(view.headId) ?? -1;
  const stale = view.stale();
  const filtering = typeof filter === 'function';
  const append = filtering ? null : appendOf(previous, view, path, stale);
  const rows = append === null ? [] : append.rows;
  let matches = 0;
  let columns = append === null ? 1 : append.columns;

  /** A branch's own steps from `startId` to its tip. */
  function chainFrom(branchId, startId) {
    const own = view.ownSteps(branchId);
    const at = own.findIndex(each => each.id === startId);
    return at === -1 ? [] : own.slice(at);
  }

  /**
   * The branches that leave `chain` at its step `index`: each child but the
   * chain's next step, as `{branch, start}`, oldest branch first; archived
   * branches are not drawn.
   */
  function stubsAt(chain, index) {
    const step = chain[index];
    const next = chain[index + 1]?.id ?? null;
    const out = [];
    for (const childId of step.children) {
      if (childId === next) continue;
      const child = view.step(childId);
      const branch = child === undefined ? undefined : view.branch(child.branch);
      if (branch === undefined || branch.archived) continue;
      out.push({ branch, start: childId });
    }
    return out.length < 2 ? out : out.sort((a, b) => idNumber(a.branch.id) - idNumber(b.branch.id));
  }

  /** Whether a branch's chain from `start`, or a branch leaving it, holds a match (memoised). */
  const holdsMatch = new Map();
  function chainMatches(branchId, startId) {
    const key = `${branchId}@${startId}`;
    if (holdsMatch.has(key)) return holdsMatch.get(key);
    holdsMatch.set(key, false);
    const chain = chainFrom(branchId, startId);
    let found = false;
    for (let index = 0; index < chain.length && !found; index++) {
      found = filter(chain[index]) || stubsAt(chain, index).some(stub => chainMatches(stub.branch.id, stub.start));
    }
    holdsMatch.set(key, found);
    return found;
  }

  const foldable = (chain, index) => {
    const step = chain[index];
    if (filtering) {
      return !filter(step) && step.id !== view.headId && step.parent !== null
        && stubsAt(chain, index).every(stub => !chainMatches(stub.branch.id, stub.start));
    }
    return step.kind === 'action' && FOLDED_EFFECTS.has(effectOf(step.type))
      && !step.touches.some(domain => METHOD_DOMAINS.has(domain)) && step.status !== 'unapplicable' && (step.notes?.length ?? 0) === 0 && (step.bookmark ?? null) === null
      && !stale.has(step.id) && stubsAt(chain, index).length === 0;
  };
  const isOff = step => step.kind === 'action' && step.touches.length > 0 && step.touches.every(domain => offDomains.has(domain));

  /** Where a path step is: past, head or undone; null off the path. */
  function positionOf(step, onPath) {
    if (!onPath) return null;
    const index = view.pathIndex().get(step.id);
    if (index === headIndex) return 'head';
    return index < headIndex ? 'past' : 'undone';
  }

  function push(row) {
    rows.push(row);
    if (row.column + 1 > columns) columns = row.column + 1;
    return row;
  }

  /**
   * One chain (a column's line of steps): the path, or an expanded stub's
   * branch. Steps of one group are one node; between groups, turns, runs
   * and steps.
   * @param {object[]} chain
   * @param {{column: number, level: number, indent: number, chainId: string, onPath: boolean, parent: string|null}} where
   */
  function emitChain(chain, where) {
    let index = 0;
    while (index < chain.length) {
      const groupId = filtering ? null : chain[index].group ?? null;
      let end = index;
      while (end + 1 < chain.length && (filtering ? null : chain[end + 1].group ?? null) === groupId) end++;
      if (groupId === null) emitSegment(chain, index, end, where);
      else emitGroup(chain, index, end, groupId, where);
      index = end + 1;
    }
  }

  /** `chain[from..to]`, inside one group or none: each turn as one header, then runs and steps. */
  function emitSegment(chain, from, to, where) {
    let index = from;
    while (index <= to) {
      const turnId = filtering || chain[index].parent === null ? null : chain[index].by?.turn ?? null;
      let end = index;
      while (end + 1 <= to && (filtering ? null : chain[end + 1].by?.turn ?? null) === turnId) end++;
      if (turnId === null) emitRunsAndSteps(chain, index, end, where);
      else emitTurn(chain, index, end, turnId, where);
      index = end + 1;
    }
  }

  /** `chain[from..to]` (one container): runs of two or more folded steps, and steps. */
  function emitRunsAndSteps(chain, from, to, where) {
    let index = from;
    while (index <= to) {
      if (foldable(chain, index)) {
        let end = index;
        while (end + 1 <= to && foldable(chain, end + 1)) end++;
        if (end > index || filtering) {
          emitRun(chain, index, end, where);
          index = end + 1;
          continue;
        }
      }
      if (filtering && filter(chain[index])) matches++;
      emitStep(chain, index, where);
      index++;
    }
  }

  function emitStep(chain, index, where) {
    const step = chain[index];
    const position = positionOf(step, where.onPath);
    const off = isOff(step);
    const stubs = stubsAt(chain, index);
    push({
      key: `s:${step.id}`,
      kind: 'step',
      level: where.level,
      indent: where.indent,
      column: where.column,
      color: view.branch(step.branch)?.lane ?? 0,
      chain: where.chainId,
      stepIds: [step.id],
      position,
      expanded: null,
      dim: position === 'undone' || off,
      off,
      posInSet: 0,
      setSize: 0,
      parent: where.parent,
      segments: [],
      elbow: null,
      step,
      stale: stale.get(step.id) ?? null,
      flagged: step.status === 'unapplicable',
      forks: stubs.length,
    });
    for (const stub of stubs) emitStub(stub, step, where);
  }

  function emitStub({ branch, start }, base, where) {
    if (filtering && !chainMatches(branch.id, start)) return;
    const chain = chainFrom(branch.id, start);
    const expanded = filtering || expandedForks.has(branch.id);
    const column = where.column + 1;
    const tip = chain[chain.length - 1] ?? null;
    const key = `f:${branch.id}`;
    push({
      key,
      kind: 'fork',
      level: where.level,
      indent: where.indent,
      column,
      color: branch.lane,
      chain: `c:${branch.id}`,
      stepIds: chain.map(each => each.id),
      position: null,
      expanded,
      dim: false,
      posInSet: 0,
      setSize: 0,
      parent: where.parent,
      segments: [],
      elbow: { from: where.column, color: branch.lane },
      branch,
      base: base.id,
      start,
      count: chain.length,
      last: tip === null ? null : tip.until ?? tip.at,
      continues: base.branch === branch.id,
      forksInside: chain.reduce((sum, each) => sum + view.branchesFrom(each.id).filter(other => !other.archived).length, 0),
    });
    if (expanded && chain.length > 0) {
      emitChain(chain, { column, level: where.level + 1, indent: 0, chainId: `c:${branch.id}`, onPath: false, parent: key });
    }
  }

  function containerRow(kind, key, chain, from, to, where, extra) {
    const stepIds = [];
    for (let index = from; index <= to; index++) stepIds.push(chain[index].id);
    const holdsHead = where.onPath && headIndex !== -1 && view.pathIndex().get(chain[from].id) <= headIndex
      && view.pathIndex().get(chain[to].id) >= headIndex;
    const position = !where.onPath ? null : holdsHead ? 'head'
      : view.pathIndex().get(chain[from].id) > headIndex ? 'undone' : 'past';
    let forksInside = 0;
    for (let index = from; index <= to; index++) forksInside += stubsAt(chain, index).length;
    return push({
      key,
      kind,
      level: where.level,
      indent: where.indent,
      column: where.column,
      color: view.branch(chain[from].branch)?.lane ?? 0,
      chain: where.chainId,
      stepIds,
      position,
      expanded: false,
      dim: position === 'undone',
      posInSet: 0,
      setSize: 0,
      parent: where.parent,
      segments: [],
      elbow: null,
      headAt: holdsHead ? { index: view.pathIndex().get(view.headId) - view.pathIndex().get(chain[from].id) + 1, count: stepIds.length } : null,
      count: stepIds.length,
      first: chain[from].at,
      last: chain[to].until ?? chain[to].at,
      forksInside,
      ...extra,
    });
  }

  function emitGroup(chain, from, to, groupId, where) {
    const key = `g:${groupId}@${chain[from].id}`;
    const row = containerRow('group', key, chain, from, to, where, {
      group: view.group(groupId) ?? { id: groupId, name: groupId, notes: [] },
    });
    if (!expandedGroups.has(groupId)) return;
    row.expanded = true;
    emitSegment(chain, from, to, { ...where, level: where.level + 1, indent: where.indent + 1, parent: key });
  }

  function emitTurn(chain, from, to, turnId, where) {
    const key = `t:${turnId}@${chain[from].id}`;
    const record = view.turn(turnId) ?? null;
    const row = containerRow('turn', key, chain, from, to, where, {
      turn: record,
      turnId,
      by: record?.by ?? chain[from].by,
    });
    if (collapsedTurns.has(key)) return;
    row.expanded = true;
    emitRunsAndSteps(chain, from, to, { ...where, level: where.level + 1, indent: where.indent + 1, parent: key });
  }

  function emitRun(chain, from, to, where) {
    const key = `r:${chain[from].id}`;
    const byCategory = new Map();
    let off = !filtering;
    for (let index = from; index <= to; index++) {
      if (!filtering) {
        const name = categoryOf(chain[index]);
        byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
      }
      off &&= isOff(chain[index]);
    }
    const row = containerRow('run', key, chain, from, to, where, {
      categories: [...byCategory].map(([name, count]) => ({ name, count })),
      filtered: filtering,
      off,
    });
    if (off) row.dim = true;
    if (!expandedRuns.has(key)) return;
    row.expanded = true;
    const inner = { ...where, level: where.level + 1, indent: where.indent + 1, parent: key };
    for (let index = from; index <= to; index++) {
      if (filtering && filter(chain[index])) matches++;
      emitStep(chain, index, inner);
    }
  }

  if (append !== null) {
    // The rows kept stay as they were; the path is laid out again from the row cut.
    const kept = rows.length;
    emitChain(path.slice(append.from), { column: 0, level: 1, indent: 0, chainId: 'c0', onPath: true, parent: null });
    placeSiblings(rows, kept);
    drawLanes(rows, kept, append.lastOfChain);
    let headRow = kept;
    while (headRow < rows.length && rows[headRow].position !== 'head') headRow++;
    return {
      rows, headRow: headRow < rows.length ? headRow : -1, columns,
      steps: Math.max(0, path.length - 1), undone: headIndex === -1 ? 0 : path.length - 1 - headIndex, matches: null, kept,
    };
  }

  emitChain(path, { column: 0, level: 1, indent: 0, chainId: 'c0', onPath: true, parent: null });

  // The paused marker follows the row showing the step shown (and that row's
  // stubs); every row below it is dimmed.
  let headRow = rows.findIndex(row => row.position === 'head');
  if (!view.recording && headRow !== -1) {
    let at = headRow + 1;
    while (at < rows.length && rows[at].column > rows[headRow].column) at++;
    rows.splice(at, 0, {
      key: 'p:paused', kind: 'paused', level: rows[headRow].level, indent: rows[headRow].indent, column: rows[headRow].column, color: rows[headRow].color,
      chain: 'p', stepIds: [], position: null, expanded: null, dim: false, posInSet: 0, setSize: 0,
      parent: rows[headRow].parent, segments: [], elbow: null, since: view.pausedAt,
    });
    for (let below = at + 1; below < rows.length; below++) rows[below].dim = true;
  }
  headRow = rows.findIndex(row => row.position === 'head');

  placeSiblings(rows);
  drawLanes(rows);
  return {
    rows, headRow, columns, steps: Math.max(0, path.length - 1), undone: headIndex === -1 ? 0 : path.length - 1 - headIndex,
    matches: filtering ? matches : null, kept: 0,
  };
}

/**
 * Whether `view` is `previous.view` with new steps taken at the tip it
 * showed, and nothing else changed that rows above the path's last row
 * show: then the rows to keep (above that row, their lanes cut where it
 * starts), where the path is laid out again from, and each line's last row
 * kept. Null for anything else.
 */
function appendOf(previous, view, path, stale) {
  if (previous === null || previous.layout.matches !== null || previous.layout.kept === undefined) return null;
  const before = previous.view;
  if (before.id !== view.id || !before.recording || !view.recording) return null;
  const old = before.path();
  if (old.length === 0 || path.length <= old.length || before.headId !== old[old.length - 1].id || view.headId !== path[path.length - 1].id) return null;
  if (path[old.length - 1].id !== old[old.length - 1].id) return null;
  // No edit (each is journaled), no branch made, moved or archived, no result gone stale.
  if (view.journal().length !== before.journal().length) return null;
  const branches = view.branches();
  const was = before.branches();
  if (branches.length !== was.length) return null;
  for (let index = 0; index < branches.length; index++) {
    const now = branches[index];
    const then = before.branch(now.id);
    if (then === undefined || then.archived !== now.archived || then.lane !== now.lane || then.base !== now.base || then.name !== now.name
      || (now.id !== view.activeBranch && then.tip !== now.tip)) return null;
  }
  if (view.groups().length !== before.groups().length || view.mainBranch !== before.mainBranch) return null;
  const staleBefore = before.stale();
  if (stale.size !== staleBefore.size) return null;
  for (const [id, entry] of stale) if (staleBefore.get(id)?.cause?.id !== entry.cause?.id) return null;
  // The cut: the path's last row (with what it holds and the stubs after it).
  const rows = previous.layout.rows;
  let cut = rows.length - 1;
  while (cut >= 0 && !(rows[cut].parent === null && rows[cut].column === 0)) cut--;
  if (cut <= 0) return null;
  const from = view.pathIndex().get(rows[cut].stepIds[0]);
  if (from === undefined) return null;
  const kept = rows.slice(0, cut);
  // Each line's last row kept, and the lane into the cut row taken off the
  // rows it ran down (it is drawn again to the row that takes its place).
  const lastOfChain = new Map();
  let columns = 1;
  for (let index = 0; index < kept.length; index++) {
    lastOfChain.set(kept[index].chain, index);
    if (kept[index].column + 1 > columns) columns = kept[index].column + 1;
  }
  const into = lastOfChain.get('c0');
  if (into !== undefined) {
    for (let index = into; index < kept.length; index++) {
      const segments = kept[index].segments;
      const at = segments.findIndex(segment => segment.column === 0 && (index === into ? segment.part === 'bottom' : segment.part === 'all'));
      if (at !== -1) segments.splice(at, 1);
    }
  }
  return { rows: kept, from, columns, lastOfChain };
}

/** `aria-posinset` / `aria-setsize`: each row's place among the rows under the same parent. */
function placeSiblings(rows, from = 0) {
  // A row's level follows from its parent, so the parent alone names its siblings.
  // From a cut: the rows before it keep their places; those under the path (no
  // parent) take its new size, as rows after the cut are only under it or the path.
  const counts = new Map();
  if (from > 0) {
    let top = 0;
    for (let index = 0; index < from; index++) if (rows[index].parent === null) top = rows[index].posInSet;
    counts.set(null, top);
  }
  for (let index = from; index < rows.length; index++) {
    const row = rows[index];
    const n = (counts.get(row.parent) ?? 0) + 1;
    counts.set(row.parent, n);
    row.posInSet = n;
  }
  const size = counts.get(null);
  if (from > 0) for (let index = 0; index < from; index++) if (rows[index].parent === null) rows[index].setSize = size;
  for (let index = from; index < rows.length; index++) rows[index].setSize = counts.get(rows[index].parent);
}

/**
 * The line segments each row draws: the edge from each row to the previous
 * row of its chain (bottom of that row, every row between, top of this one),
 * coloured by the branch of the row it leads to, and each stub's elbow from
 * its fork's column.
 */
function drawLanes(rows, from = 0, lastOfChain = new Map()) {
  for (let index = from; index < rows.length; index++) {
    const row = rows[index];
    const previous = lastOfChain.get(row.chain);
    const faded = row.dim;
    if (previous !== undefined) {
      rows[previous].segments.push({ column: row.column, color: row.color, part: 'bottom', faded });
      for (let between = previous + 1; between < index; between++) {
        rows[between].segments.push({ column: row.column, color: row.color, part: 'all', faded });
      }
      row.segments.push({ column: row.column, color: row.color, part: 'top', faded });
    }
    lastOfChain.set(row.chain, index);
  }
}

/**
 * The steps a selection from row `a` to row `b` stands for, first to last:
 * the steps of the rows of `a`'s chain between them (a folded row stands for
 * all of its steps), or why it is not one run of a chain.
 *
 * @param {GraphRow[]} rows
 * @param {number} a
 * @param {number} b
 * @returns {{steps: string[], problem: string|null}}
 */
export function selectedSteps(rows, a, b) {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const chain = rows[a]?.chain;
  if (chain === undefined || rows[b]?.chain !== chain) {
    return { steps: [], problem: 'Choose steps of one branch: the rows chosen are on two lines.' };
  }
  const steps = [];
  const seen = new Set();
  for (let index = from; index <= to; index++) {
    const row = rows[index];
    if (row.chain !== chain || row.kind === 'fork' || row.kind === 'paused') continue;
    for (const id of row.stepIds) {
      if (!seen.has(id)) {
        seen.add(id);
        steps.push(id);
      }
    }
  }
  steps.sort((x, y) => idNumber(x) - idNumber(y));
  return { steps, problem: steps.length === 0 ? 'Choose one or more steps.' : null };
}

/** The index of the row that shows `stepId` (its own row, or the folded row standing for it), or -1. */
export function rowOfStep(rows, stepId) {
  const own = rows.findIndex(row => row.kind === 'step' && row.stepIds[0] === stepId);
  if (own !== -1) return own;
  return rows.findIndex(row => row.kind !== 'fork' && row.stepIds.includes(stepId));
}

/**
 * The stubs and groups to open so `stepId` gets a row of its own: the
 * branches on its way from the path (each stub sits at its branch's fork
 * step, or, for a branch the path leaves, at its last step on the path),
 * and the groups holding it or any stub on that way. A turn, a run, or a
 * filter folding it are the graph's to open once these are.
 *
 * @param {import('./history-source.js').TrackerView} view
 * @param {string} stepId
 * @returns {{forks: string[], groups: string[]}} branch ids and group ids
 */
export function revealPlan(view, stepId) {
  const forks = [];
  const groups = [];
  const onPath = view.pathIndex();
  const addGroup = step => {
    if (step?.group !== null && step?.group !== undefined && !groups.includes(step.group)) groups.push(step.group);
  };
  let at = view.step(stepId);
  while (at !== undefined) {
    addGroup(at);
    if (onPath.has(at.id)) break;
    if (!forks.includes(at.branch)) forks.push(at.branch);
    const own = view.ownSteps(at.branch);
    let lastOnPath;
    for (let index = own.length - 1; index >= 0 && lastOnPath === undefined; index--) if (onPath.has(own[index].id)) lastOnPath = own[index];
    if (lastOnPath !== undefined) {
      addGroup(lastOnPath);
      break;
    }
    const branch = view.branch(at.branch);
    at = branch === undefined || branch.base === null ? undefined : view.step(branch.base);
  }
  return { forks, groups };
}
