/**
 * The State panel's branch graph as rows (`ui/modules/state/graph-layout.js`)
 * and the plans its confirmations are worded from (`history-source.js`), on
 * history records built with the contract's own constructors
 * (`helpers/history-v2-builder.mjs`): the path shown, undone
 * steps, fork stubs (the undone tail stays visible after branching), nested
 * stubs, turns, groups, folded runs of view and layout steps
 * (section open and close among them), the paused marker, search folding,
 * lanes, aria places, selection ranges, revealing a step, and why a revert,
 * a group or a squash is not offered.
 */
import { blocksRun } from './helpers/block-counts.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import { trackerBuilder } from './helpers/history-v2-builder.mjs';
import { createTrackerView, groupRange, revertProblem, squashProblem, redoTarget, canUndo } from '../assets/js/app/ui/modules/state/history-source.js';
import { layoutGraph, revealPlan, rowOfStep, selectedSteps } from '../assets/js/app/ui/modules/state/graph-layout.js';
import { dayOf, filterChoices, searchCriteria, stepMatcher } from '../assets/js/app/ui/modules/state/search.js';
import { searchSteps } from '../assets/js/app/history/search.js';
import { bannerOf } from '../assets/js/app/ui/modules/state/workflow-banner.js';
import { journalEntries } from '../assets/js/app/ui/modules/state/recently-deleted.js';

const EFFECTS = { 'camera.set': 'view', 'view.keep': 'view', 'layout.section.open': 'layout', 'color.by': 'state' };
const OPTIONS = { effectOf: type => EFFECTS[type] ?? 'state' };
const camera = { type: 'camera.set', touches: ['camera'] };
const section = { type: 'layout.section.open', touches: ['layout'] };

const rowsOf = (view, options = {}) => layoutGraph(view, { ...OPTIONS, ...options });
const brief = layout => layout.rows.map(row => {
  const what = row.kind === 'step' ? row.step.label : row.kind === 'fork' ? row.branch.name : row.kind === 'turn' ? row.turnId
    : row.kind === 'group' ? row.group.name : row.kind === 'run' ? row.stepIds.join(',') : row.kind;
  return `${'  '.repeat(row.level - 1)}${row.kind}:${what}${row.position ? `@${row.position}` : ''}${row.expanded === null ? '' : row.expanded ? '▾' : '▸'}`;
});

/** s0 Opened · s1 A · s2 B (fork) · s3 C · s4 D; then from s2: s5 E, s6 F (Branch 1, shown). */
function forked() {
  const b = trackerBuilder();
  b.step('A');
  const fork = b.step('B');
  b.step('C');
  b.step('D');
  b.jump(fork);
  b.step('E');
  b.step('F');
  return { b, view: createTrackerView(b.build()) };
}

test('the path shown, root first; branches leaving it are collapsed stubs after their fork step', () => {
  const { view } = forked();
  const layout = rowsOf(view);
  assert.deepEqual(brief(layout), [
    'step:Opened@past', 'step:A@past', 'step:B@past', 'fork:Main▸', 'step:E@past', 'step:F@head',
  ]);
  assert.equal(layout.steps, 4);
  assert.equal(layout.headRow, 5);
  const stub = layout.rows[3];
  assert.equal(stub.count, 2, 'Main continues for two steps past the fork');
  assert.equal(stub.continues, true);
  assert.equal(stub.column, 1);
  assert.deepEqual(stub.elbow, { from: 0, color: 0 });
});

test('the undone tail stays after branching, and an expanded stub shows its steps on its own lane', () => {
  const { b, view: forkedView } = forked();
  void forkedView;
  b.undo(1);
  const view = createTrackerView(b.build());
  const layout = rowsOf(view, { expandedForks: new Set(['b0']) });
  assert.deepEqual(brief(layout), [
    'step:Opened@past', 'step:A@past', 'step:B@past', 'fork:Main▾', '  step:C', '  step:D', 'step:E@head', 'step:F@undone',
  ]);
  const undone = layout.rows[7];
  assert.equal(undone.dim, true);
  assert.equal(layout.rows[4].column, 1, 'the stub\'s steps are in its column');
  assert.equal(layout.rows[4].level, 2);
  // The path's line passes through the stub's rows.
  assert.ok(layout.rows[4].segments.some(s => s.column === 0 && s.part === 'all'));
  assert.equal(redoTarget(view), 's6');
  assert.equal(canUndo(view), true);
});

test('nested stubs: a branch of a branch shows inside its expanded parent stub; aria places count siblings', () => {
  const b = trackerBuilder();
  const a = b.step('A');
  b.step('B');
  b.jump(a);
  const x = b.step('X');
  b.step('Y');
  b.jump(x);
  b.step('Z');
  b.jump('s2');
  const view = createTrackerView(b.build());
  const collapsed = rowsOf(view);
  assert.deepEqual(brief(collapsed), ['step:Opened@past', 'step:A@past', 'fork:Branch 1▸', 'step:B@head']);
  const open = rowsOf(view, { expandedForks: new Set(['b1', 'b2']) });
  assert.deepEqual(brief(open), [
    'step:Opened@past', 'step:A@past', 'fork:Branch 1▾', '  step:X', '  fork:Branch 2▾', '    step:Z', '  step:Y', 'step:B@head',
  ]);
  assert.equal(open.columns, 3);
  const top = open.rows.filter(row => row.level === 1);
  assert.deepEqual(top.map(row => `${row.posInSet}/${row.setSize}`), ['1/4', '2/4', '3/4', '4/4']);
});

test('an archived branch is not drawn; a turn is one header with its steps under it', () => {
  const b = trackerBuilder();
  const a = b.step('A');
  b.step('B');
  b.jump(a);
  b.step('Gone');
  b.archive('b1');
  b.jump('s2');
  b.as({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 't1' }, 'Markers');
  b.step('Ran DE', { type: 'analysis.run', touches: ['analysis'] });
  b.step('Colored by CD3E');
  const view = createTrackerView(b.build());
  const layout = rowsOf(view);
  assert.deepEqual(brief(layout), ['step:Opened@past', 'step:A@past', 'step:B@past', 'turn:t1@head▾', '  step:Ran DE@past', '  step:Colored by CD3E@head']);
  const turn = layout.rows[3];
  assert.equal(turn.count, 2);
  assert.equal(turn.turn.label, 'Markers');
  assert.deepEqual(turn.headAt, { index: 2, count: 2 });
  const shut = rowsOf(view, { collapsedTurns: new Set([turn.key]) });
  assert.deepEqual(brief(shut), ['step:Opened@past', 'step:A@past', 'step:B@past', 'turn:t1@head▸']);
});

test('runs: consecutive view and layout steps (camera moves, open sections) fold into one row; undo is unchanged', () => {
  const b = trackerBuilder();
  b.step('Colored');
  b.step('Opened Filters', section);
  b.steps(3, 'Moved the camera', camera);
  b.step('Opened Analysis', section);
  b.step('Hid alpha', { touches: ['filters'] });
  b.step('Moved once', camera);
  b.undo(4);
  const view = createTrackerView(b.build());
  const layout = rowsOf(view);
  assert.deepEqual(brief(layout), ['step:Opened@past', 'step:Colored@past', 'run:s2,s3,s4,s5,s6@head▸', 'step:Hid alpha@undone', 'step:Moved once@undone']);
  const run = layout.rows[2];
  // What its steps did, by their labels (R9F: "Colors ×2" said nothing of which switches).
  assert.deepEqual(run.changes, ['Opened Filters', 'Moved the camera 1', 'Moved the camera 2', 'Moved the camera 3', 'Opened Analysis'].map(label => ({ label, count: 1 })));
  assert.deepEqual(run.headAt, { index: 3, count: 5 }, 'the step shown is the 3rd of the run');
  const open = rowsOf(view, { expandedRuns: new Set([run.key]) });
  assert.equal(open.rows.filter(row => row.parent === run.key).length, 5);
  // A detail not recorded now (History settings): its run says so, dimmed.
  const off = rowsOf(view, { offDomains: new Set(['camera', 'layout']) });
  assert.equal(off.rows[2].off, true);
  assert.equal(off.rows[2].dim, true);
});

test('a step with a note, a bookmark or a fork never folds; a run never spans a turn', () => {
  const b = trackerBuilder();
  b.steps(2, 'Moved', camera);
  const noted = b.step('Moved noted', camera);
  b.note(noted, 'here');
  b.steps(2, 'Moved more', camera);
  const view = createTrackerView(b.build());
  assert.deepEqual(brief(rowsOf(view)), ['step:Opened@past', 'run:s1,s2@past▸', 'step:Moved noted@past', 'run:s4,s5@head▸']);
});

test('groups: one node, collapsed by default, saying where the step shown is and the branches inside', () => {
  const b = trackerBuilder();
  b.step('Load');
  const first = b.step('QC 1');
  const mid = b.step('QC 2');
  const last = b.step('QC 3');
  b.step('Cluster');
  b.group(first, last, 'QC');
  b.jump(mid);
  b.step('Other');
  b.jump('s5');
  const view = createTrackerView(b.build());
  const layout = rowsOf(view);
  assert.deepEqual(brief(layout), ['step:Opened@past', 'step:Load@past', 'group:QC@past▸', 'step:Cluster@head']);
  assert.equal(layout.rows[2].count, 3);
  assert.equal(layout.rows[2].forksInside, 1);
  const open = rowsOf(view, { expandedGroups: new Set(['g0']) });
  assert.deepEqual(brief(open), ['step:Opened@past', 'step:Load@past', 'group:QC@past▾', '  step:QC 1@past', '  step:QC 2@past', '  fork:Branch 1▸', '  step:QC 3@past', 'step:Cluster@head']);
});

test('paused: a marker after the step shown, and everything below dimmed', () => {
  const b = trackerBuilder();
  b.step('A');
  b.step('B');
  b.undo(1);
  b.pause();
  const view = createTrackerView(b.build());
  const layout = rowsOf(view);
  assert.deepEqual(brief(layout), ['step:Opened@past', 'step:A@head', 'paused:paused', 'step:B@undone']);
  assert.equal(layout.rows[3].dim, true);
});

test('search: matches stay, the rest fold, the step shown stays, stubs open only when they hold a match', () => {
  const { b } = forked();
  b.undo(1);
  const view = createTrackerView(b.build());
  const filter = stepMatcher({ text: 'd' }, { effectOf: OPTIONS.effectOf, stale: new Map() });
  const layout = rowsOf(view, { filter });
  // B stays: the branch leaving it holds the match.
  assert.deepEqual(brief(layout), ['step:Opened@past', 'run:s1@past▸', 'step:B@past', 'fork:Main▾', '  run:s3▸', '  step:D', 'step:E@head', 'run:s6@undone▸']);
  assert.equal(layout.matches, 1);
  const none = rowsOf(view, { filter: stepMatcher({ text: 'nothing like it' }, { effectOf: OPTIONS.effectOf, stale: new Map() }) });
  assert.equal(none.matches, 0);
  assert.ok(none.rows.every(row => row.kind !== 'fork'), 'a stub with no match is not drawn');
});

test('search filters: who acted, the kind, notes, bookmarks, flags', () => {
  const b = trackerBuilder();
  const mine = b.step('Mine');
  b.as({ origin: 'agent', agent: 'Claude', turn: 't' });
  const theirs = b.step('Theirs');
  b.as({ origin: 'host', host: 'python', turn: 'p' });
  const py = b.step('Python', camera);
  b.note(mine, 'look *here*');
  b.bookmark(theirs, 'Before');
  const view = createTrackerView(b.build());
  const match = q => view.steps().filter(stepMatcher(q, { effectOf: OPTIONS.effectOf, stale: new Map([[theirs, {}]]) })).map(s => s.id);
  assert.deepEqual(match({ by: 'agent' }), [theirs]);
  assert.deepEqual(match({ by: 'python' }), [py]);
  assert.deepEqual(match({ by: 'person' }), [mine]);
  assert.deepEqual(match({ kind: 'view' }), [py]);
  assert.deepEqual(match({ hasNote: true }), [mine]);
  assert.deepEqual(match({ bookmarked: true }), [theirs]);
  assert.deepEqual(match({ flagged: true }), [theirs]);
  assert.deepEqual(match({ text: 'HERE' }), [mine], 'notes are searched, any case');
  assert.equal(stepMatcher({ text: '  ' }, { effectOf: OPTIONS.effectOf, stale: new Map() }), null);
  // The part of the state a step changed, and the day it was taken.
  assert.deepEqual(match({ domain: 'camera' }), [py]);
  assert.deepEqual(match({ domain: 'active-field' }), [mine, theirs]);
  const day = dayOf(view.step(mine).at);
  assert.deepEqual(match({ day }), [mine, theirs, py]);
  assert.deepEqual(match({ day: dayOf(day - 1) }), []);
  assert.deepEqual(searchCriteria({ text: '', day, domain: 'camera', hasNote: false }), { domain: 'camera', from: day, to: dayOf(day + 36 * 3_600_000) - 1 });
  // What the two filters offer: the parts some step changed, the days some step was taken (the opening left out).
  const choices = filterChoices(view.steps(), id => ({ camera: 'Camera', 'active-field': 'Coloring' })[id] ?? id, view.step(py).at);
  assert.deepEqual(choices.domains, [{ id: 'camera', label: 'Camera', count: 1 }, { id: 'active-field', label: 'Coloring', count: 2 }]);
  assert.deepEqual(choices.days, [{ day, label: 'Today', count: 3 }]);
});

test('search: the panel and history.search apply one rule (stepMatches)', () => {
  const b = trackerBuilder();
  const a = b.step('Hid alpha', { type: 'filter.category.visibility', touches: ['filters'] });
  b.step('Moved', camera);
  const tracker = b.build();
  const view = createTrackerView(tracker);
  const effects = new Map(Object.entries(EFFECTS).map(([type, effect]) => [type, { effect }]));
  const catalog = { has: type => effects.has(type), get: type => effects.get(type) };
  for (const query of [{ text: 'alpha' }, { domain: 'filters' }, { kind: 'view' }, { day: dayOf(view.step(a).at) }]) {
    const panel = view.steps().filter(stepMatcher(query, { effectOf: OPTIONS.effectOf, stale: new Map() })).map(step => step.id);
    assert.deepEqual(panel, searchSteps(tracker, searchCriteria(query), { catalog }).filter(id => view.step(id).parent !== null), JSON.stringify(query));
  }
});

test('selection: the steps between two rows of one line, a folded row standing for all of its steps', () => {
  const b = trackerBuilder();
  b.step('A');
  b.steps(3, 'Moved', camera);
  b.step('B');
  const view = createTrackerView(b.build());
  const layout = rowsOf(view);
  assert.deepEqual(brief(layout), ['step:Opened@past', 'step:A@past', 'run:s2,s3,s4@past▸', 'step:B@head']);
  assert.deepEqual(selectedSteps(layout.rows, 1, 3), { steps: ['s1', 's2', 's3', 's4', 's5'], problem: null });
  assert.deepEqual(selectedSteps(layout.rows, 3, 1).steps, ['s1', 's2', 's3', 's4', 's5'], 'either direction');
  const { view: other } = forked();
  const open = rowsOf(other, { expandedForks: new Set(['b0']) });
  assert.match(selectedSteps(open.rows, 1, 4).problem, /two lines/);
  assert.equal(rowOfStep(layout.rows, 's3'), 2, 'a folded step is found in its run');
});

test('reveal: the stubs and groups to open for a step of a branch of a branch', () => {
  const b = trackerBuilder();
  const a = b.step('A');
  b.step('B');
  b.jump(a);
  const x = b.step('X');
  b.step('Y');
  b.jump(x);
  const z = b.step('Z');
  b.jump('s2');
  const view = createTrackerView(b.build());
  assert.deepEqual(revealPlan(view, z), { forks: ['b2', 'b1'], groups: [] });
  assert.deepEqual(revealPlan(view, 's2'), { forks: [], groups: [] });
});

test('revert, group and squash say why not before anything is dispatched', () => {
  const b = trackerBuilder();
  const a = b.step('Hid alpha', { touches: ['filters'] });
  b.step('Colored');
  const c = b.step('Hid beta', { touches: ['filters'] });
  b.as({ origin: 'agent', agent: 'Claude', turn: 't1' }, 'Two steps');
  const t1 = b.step('Agent 1');
  b.step('Agent 2');
  b.as({ origin: 'user' });
  b.step('After');
  b.jump(c);
  b.step('Forked');
  b.jump('s7');
  const view = createTrackerView(b.build());
  const name = domain => domain === 'filters' ? 'Filters' : domain;
  assert.match(revertProblem(view, a, name), /Later steps also change Filters/);
  assert.equal(revertProblem(view, c, name), null);
  const widened = groupRange(view, 's2', t1);
  assert.equal(widened.to, 's5', 'a group holds whole turns');
  assert.match(widened.widened, /split the turn "Two steps"/);
  assert.match(squashProblem(view, 's2', 's5'), /starts inside/);
  assert.equal(squashProblem(view, 's1', 's3'), null, 'a fork at the last step is allowed');
  assert.match(squashProblem(view, 's2', 's2'), /two or more/);
});

test('the banner says where a tracker comes from; Recently deleted lists unpurged edits newest first', () => {
  const b = trackerBuilder();
  b.step('A');
  const tracker = b.build();
  assert.equal(bannerOf(tracker, 1), null);
  const replayed = { ...tracker, start: { kind: 'replay', from: { dataset: { id: 'x', name: 'Sample A' } }, report: [{ outcome: 'applied' }, { outcome: 'unmatched' }], mapping: null } };
  assert.deepEqual(bannerOf(replayed, 1), { kind: 'replay', text: 'Replayed from Sample A: 1 of 2 steps did not match', tone: 'warning', unmatched: 1 });
  const entries = journalEntries([{ id: 't', journal: [
    { id: 'j0', at: 1, purged: false, label: 'old' }, { id: 'j1', at: 2, purged: true, label: 'gone' }, { id: 'j2', at: 3, purged: false, label: 'new' },
  ] }]);
  assert.deepEqual(entries.map(each => each.entry.label), ['new', 'old']);
});

test('the layout of 10k steps and 100 branches grows with the steps, not their square, and draws only what it must', async () => {
  const history = steps => {
    const b = trackerBuilder();
    const forks = [];
    for (let i = 0; i < 100; i++) {
      const id = b.step(`Step ${i}`);
      forks.push(id);
    }
    for (const id of forks) {
      b.jump(id);
      b.steps(10, `Branch step from ${id}`);
    }
    b.jump(forks[forks.length - 1]);
    while (b.tracker.steps.length < steps) b.step(`Main tail ${b.tracker.steps.length}`, b.tracker.steps.length % 3 === 0 ? camera : {});
    return createTrackerView(b.build());
  };
  const view = history(10_000);
  assert.equal(view.branches().length, 101);
  let layout;
  const large = await blocksRun('/graph-layout.js', () => { layout = rowsOf(view); });
  assert.ok(layout.rows.length < 10_000, 'camera runs fold');
  assert.equal(layout.rows.filter(row => row.kind === 'fork').length, 100);
  // Blocks run (`helpers/block-counts.mjs`), not milliseconds: a quarter of the steps runs about a quarter of them.
  const small = await blocksRun('/graph-layout.js', () => rowsOf(history(2_500)));
  assert.ok(large / small < 6, `four times the steps ran ${(large / small).toFixed(1)} times the blocks (${small}, then ${large})`);
});

test('appends: a layout from the one before (new steps at the tip shown) equals a layout of the whole, and keeps the rows above', () => {
  const b = trackerBuilder();
  b.step('A');
  const fork = b.step('B');
  b.step('C');
  b.jump(fork);
  b.step('On a branch');
  b.jump('s3');
  b.steps(2, 'Moved', camera);
  // Each append joins or ends a different last row: a run, a step, an agent's turn, a group, a folded step alone.
  const appends = [
    () => b.step('Moved again', camera),
    () => b.step('Colored'),
    () => { b.as({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 'turn-1' }, 'Markers'); return b.step('Ran DE', { type: 'analysis.run', touches: ['analysis'] }); },
    () => b.step('Colored by CD3E'),
    () => { b.as({ origin: 'user' }); return b.step('Moved', camera); },
    () => b.step('Kept a view', { type: 'view.keep', touches: ['views'] }),
    () => { b.step('Hid', { touches: ['filters'] }); return b.step('Hid more', { touches: ['filters'] }); },
  ];
  const options = { ...OPTIONS, collapsedTurns: new Set(), expandedForks: new Set(['b1']) };
  let view = createTrackerView(b.build());
  let previous = { view, layout: layoutGraph(view, options) };
  const strip = layout => ({ ...layout, kept: undefined });
  for (const take of appends) {
    take();
    view = createTrackerView(b.build());
    const appended = layoutGraph(view, options, previous);
    const whole = layoutGraph(view, options);
    assert.ok(appended.kept > 0, 'the rows above the last row of the path are kept');
    assert.deepEqual(strip(appended), strip(whole));
    previous = { view, layout: appended };
  }
  // A move, or a search, lays out everything.
  b.undo(1);
  view = createTrackerView(b.build());
  assert.equal(layoutGraph(view, options, previous).kept, 0);
  assert.equal(layoutGraph(view, { ...options, filter: () => true }, { view, layout: layoutGraph(view, options) }).kept, 0);
});
