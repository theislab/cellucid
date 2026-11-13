/**
 * A history in words (`assets/js/app/history/exports/`): the pseudocode, the
 * methods paragraph and the printable report of history records made with
 * the model's own constructors (`app/history/model.js`) and validated whole:
 * a person's, an agent's and a notebook's steps, two groups, a bookmark,
 * notes on steps, a group, a branch and the tracker (its abstract), a camera
 * step, a change made outside an action, a step that no longer applies, a
 * squashed step of each cause (recording paused, steps merged, history
 * cleared, a state shared), the note and bookmark a merge kept (carried), and a second branch exported without being shown.
 * The golden history (`history-golden-fixture.test.mjs`) holds the same
 * exports byte for byte for Python and R.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { DOMAIN_IDS, domainName } from '../assets/js/app/actions/domains.js';
import {
  createBranch, createBy, createGroup, createNote, createStep, createTracker, createTurn, squashedLabel, validateTracker,
} from '../assets/js/app/history/model.js';
import { historyPseudocode } from '../assets/js/app/history/exports/pseudocode.js';
import { methodsParagraph, methodsParts, numberRanges } from '../assets/js/app/history/exports/methods.js';
import {
  reportDocument, reportPictureDefaults, reportEntries,
} from '../assets/js/app/history/exports/report.js';
import {
  branchPath, groupRuns, originOf, originPhrase, parameterFacts, parameterValue, runHeadings, squashPhrase,
} from '../assets/js/app/history/exports/step-text.js';
import { lowerFirst } from '../assets/js/utils/text-case.js';

const OBJECT = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, required, properties,
});
const FIELD = OBJECT({ source: { type: 'string', enum: ['obs', 'var'] }, key: { type: 'string', minLength: 1 } });

const definitions = [
  defineAction({
    type: 'color.by', title: 'Color by a field', summary: 'Color the cells by a field or a gene.', group: 'Coloring',
    params: OBJECT({ field: FIELD }), touches: ['active-field'], reads: [], effect: 'view',
    describe: p => `Colored by ${p.field.key}`, code: p => `color_by(${JSON.stringify(p.field.key)})`,
  }),
  defineAction({
    type: 'category.rename', title: 'Rename a category', summary: 'Give a category a new label.', group: 'Fields',
    params: OBJECT({ field: FIELD, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }),
    touches: ['field-overlays'], reads: [], effect: 'state',
    describe: p => `Renamed ${p.from} to ${p.to} in ${p.field.key}`,
    code: p => `rename_category(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.from)}, ${JSON.stringify(p.to)})`,
  }),
  defineAction({
    type: 'filter.hide', title: 'Hide categories', summary: 'Hide categories of a field.', group: 'Filters',
    params: OBJECT({ field: FIELD, categories: { type: 'array', items: { type: 'string' }, minItems: 1 } }),
    touches: ['filters'], reads: [], effect: 'state',
    describe: p => `Hid ${p.categories.join(' and ')} in ${p.field.key}`,
    code: p => `hide_categories(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.categories)})`,
  }),
  defineAction({
    type: 'highlight.cells', title: 'Highlight cells', summary: 'Highlight cells as a group.', group: 'Highlights',
    params: OBJECT({ name: { type: 'string', minLength: 1 }, cells: { type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true, minItems: 1 } }),
    touches: ['highlights'], reads: [], effect: 'state',
    describe: p => `Highlighted ${p.cells.length} cells as ${p.name}`, code: p => `highlight(${JSON.stringify(p.name)}, cells=[…${p.cells.length}])`,
  }),
  defineAction({
    type: 'camera.set', title: 'Move the camera', summary: 'Place the camera.', group: 'Camera',
    params: OBJECT({ at: { type: 'number' } }), touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'camera',
    describe: () => 'Moved the camera', code: p => `camera(${p.at})`,
  }),
];
const catalog = createActionCatalog(definitions);

const T = 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10';
const START = Date.UTC(2026, 10, 3, 9, 0, 0);
const user = createBy({ origin: 'user' });
const claude = createBy({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 'turn-1' });
const python = createBy({ origin: 'host', host: 'python', turn: 'py-1' });
const outside = createBy({ origin: 'outside' });
const DATASET = { name: 'Suo fetal immune', cells: 841_922, genes: 33_538 };

let hashes = 0;
const hash = () => (++hashes).toString(16).padStart(64, '0');
const values = touches => [Object.fromEntries(touches.map(d => [d, hash()])), Object.fromEntries(touches.map(d => [d, hash()]))];

/**
 * The fixture tracker. Main: s1 color (person); QC group: s2 rename (person),
 * s3 hide (Claude; bookmarked, with a note); s4 camera; s5 a change made
 * outside an action (filters); s6 recording paused (colors, filters; by the
 * person and Python); s7 a notebook highlight that no longer applies; Figure
 * 2 group: s8 three steps merged (highlights), s9 color (bookmarked). Branch
 * "Fresh start" from s0: s10 the history cleared (fields and labels, filters).
 */
function fixtureTracker() {
  hashes = 0;
  let minute = 0;
  const tick = () => START + 60_000 * minute++;
  const roots = Object.fromEntries(DOMAIN_IDS.map(d => [d, hash()]));
  const tracker = createTracker({ id: T, name: 'Annotation', dataset: { id: 'suo', name: DATASET.name, cellOrder: null }, createdAt: tick(), by: user, rootValues: roots });
  const add = (fields) => {
    const definition = (fields.kind ?? 'action') === 'action' ? catalog.get(fields.type) : null;
    const [before, after] = values(fields.touches);
    const step = createStep({
      kind: 'action', v: definition ? definition.version : null, code: definition ? definition.code(fields.params) : null,
      label: definition ? definition.describe(fields.params) : fields.label, at: tick(), before, after, ...fields,
    });
    tracker.steps.find(s => s.id === fields.parent).children.push(step.id);
    tracker.steps.push(step);
    return step;
  };
  const field = key => ({ source: 'obs', key });
  add({ id: 's1', parent: 's0', branch: 'b0', type: 'color.by', params: { field: field('cell_type') }, by: user, touches: ['active-field'] });
  add({ id: 's2', parent: 's1', branch: 'b0', type: 'category.rename', params: { field: field('cell_type'), from: 'T', to: 'T cells' }, by: user, touches: ['field-overlays'], group: 'g0' });
  add({ id: 's3', parent: 's2', branch: 'b0', type: 'filter.hide', params: { field: field('cell_type'), categories: ['NK', 'B'] }, by: claude, touches: ['filters'], group: 'g0' });
  add({ id: 's4', parent: 's3', branch: 'b0', type: 'camera.set', params: { at: 3 }, by: user, touches: ['camera'] });
  add({ id: 's5', parent: 's4', branch: 'b0', kind: 'outside', type: 'history.outside-change', params: { domains: ['filters'] }, label: 'Changed outside the history', by: outside, touches: ['filters'] });
  const paused = { cause: 'paused', count: null, by: [user, createBy({ origin: 'host', host: 'python' })], carried: { notes: [], bookmarks: [] } };
  add({ id: 's6', parent: 's5', branch: 'b0', kind: 'squashed', label: squashedLabel({ ...paused, domains: ['Filters', 'Colors'] }), squashed: paused, by: user, touches: ['filters', 'colors'] });
  const flagged = add({ id: 's7', parent: 's6', branch: 'b0', type: 'highlight.cells', params: { name: 'Doublets', cells: [4, 8, 15] }, by: python, touches: ['highlights'] });
  flagged.status = 'unapplicable';
  flagged.reason = 'There is no category "T" in cell_type.';
  const merged = { cause: 'steps', count: 3, by: [user], carried: { notes: [], bookmarks: ['Raw highlights'] } };
  add({ id: 's8', parent: 's7', branch: 'b0', kind: 'squashed', label: squashedLabel({ ...merged, domains: ['Highlights'] }), squashed: merged, by: user, touches: ['highlights'], group: 'g1' });
  add({ id: 's9', parent: 's8', branch: 'b0', type: 'color.by', params: { field: field('leiden') }, by: user, touches: ['active-field'], group: 'g1' });
  const cleared = { cause: 'clear', count: 3, by: [user, claude], carried: { notes: [], bookmarks: [] } };
  add({ id: 's10', parent: 's0', branch: 'b1', kind: 'squashed', label: squashedLabel({ ...cleared, domains: ['Fields and labels', 'Filters'] }), squashed: cleared, by: user, touches: ['field-overlays', 'filters'] });
  tracker.nextStep = 11;

  tracker.branches = [
    { ...tracker.branches[0], tip: 's9' },
    createBranch({ id: 'b1', name: 'Fresh start', base: 's0', tip: 's10', createdAt: START, by: user }),
  ];
  tracker.nextBranch = 2;
  tracker.groups = [
    createGroup({ id: 'g0', name: 'QC', createdAt: START, by: user }),
    createGroup({ id: 'g1', name: 'Figure 2', createdAt: START, by: user }),
  ];
  tracker.nextGroup = 2;
  tracker.turns = [
    createTurn({ id: 'turn-1', by: claude, label: 'Hide NK and B', startedAt: START, branch: 'b0' }),
    createTurn({ id: 'py-1', by: python, label: 'Doublets', startedAt: START, branch: 'b0' }),
  ];
  let notes = 0;
  const note = (text, by) => createNote({ id: `n${notes++}`, text, by, at: START + 3_600_000 });
  tracker.notes = [note('Annotation of the fetal immune atlas: *T cells* first.', user), note('Second tracker note.', user)];
  tracker.steps.find(s => s.id === 's3').notes.push(note('NK and B are <not> of interest here.', claude));
  tracker.steps.find(s => s.id === 's3').bookmark = 'Filtered';
  tracker.steps.find(s => s.id === 's9').bookmark = 'Figure 2 done';
  tracker.groups[0].notes.push(note('Quality control first.', user));
  // The note of a step merged into s8, which s8 keeps (carried).
  const kept = note('Three lassos, one highlight.', user);
  const s8 = tracker.steps.find(s => s.id === 's8');
  s8.notes.push(kept);
  s8.squashed.carried.notes.push(kept.id);
  tracker.branches[0].notes.push(note('The main line.', user));
  tracker.nextNote = notes;
  tracker.headId = 's9';
  return validateTracker(tracker);
}

/** A "Current state only" share: the dataset as opened and one squashed step. */
function sharedTracker() {
  hashes = 100;
  const roots = Object.fromEntries(DOMAIN_IDS.map(d => [d, hash()]));
  const tracker = createTracker({ id: T, name: 'Shared', dataset: { id: 'suo', name: DATASET.name, cellOrder: null }, createdAt: null, by: user, rootValues: roots });
  const [before, after] = values(['field-overlays', 'highlights']);
  const squashed = { cause: 'share', count: null, by: [], carried: { notes: [], bookmarks: [] } };
  const step = createStep({
    id: 's1', parent: 's0', branch: 'b0', kind: 'squashed', label: squashedLabel({ ...squashed, domains: [] }), by: user,
    at: null, touches: ['field-overlays', 'highlights'], before, after, squashed,
  });
  tracker.steps[0].children.push('s1');
  tracker.steps.push(step);
  tracker.branches = [{ ...tracker.branches[0], tip: 's1' }];
  tracker.headId = 's1';
  tracker.nextStep = 2;
  return validateTracker(tracker);
}

test('step text: who acted, parameter facts, domain names, squash phrases', () => {
  assert.deepEqual(originOf(user), { key: 'person', name: 'Person' });
  assert.deepEqual(originOf(claude), { key: 'claude', name: 'Claude' });
  assert.deepEqual(originOf(createBy({ origin: 'agent', agent: 'ChatGPT', turn: 't' })), { key: 'chatgpt', name: 'ChatGPT' });
  assert.deepEqual(originOf(createBy({ origin: 'agent', agent: 'Gemini', turn: 't' })), { key: 'agent', name: 'Gemini' });
  assert.deepEqual(originOf(createBy({ origin: 'host', host: 'r' })), { key: 'r', name: 'R' });
  assert.deepEqual(originOf(python), { key: 'python', name: 'Python' });
  assert.deepEqual(originOf(createBy({ origin: 'session' })), { key: 'session', name: 'Session' });
  assert.deepEqual(originOf(createBy({ origin: 'replay' })), { key: 'replay', name: 'Replay' });
  assert.deepEqual(originOf(createBy({ origin: 'startup' })), { key: 'start', name: 'Start' });
  assert.deepEqual(originOf(outside), { key: 'outside', name: 'Not recorded' });
  assert.equal(originPhrase(claude), 'an AI assistant (Claude, claude-sonnet-4-6) at the user\'s request');
  assert.equal(originPhrase(createBy({ origin: 'agent', agent: 'Claude', turn: 't' })), 'an AI assistant (Claude) at the user\'s request');
  assert.equal(originPhrase(python), 'a Python notebook through the Cellucid viewer API');
  assert.equal(originPhrase(outside), null);
  for (const id of DOMAIN_IDS) assert.ok(domainName(id).length > 0, id);
  assert.equal(new Set(DOMAIN_IDS.map(domainName)).size, DOMAIN_IDS.length, 'each domain has its own name');
  assert.throws(() => domainName('chat'), /There is no state domain "chat"/);

  assert.equal(squashPhrase({ cause: 'paused', count: null }), 'Changes made with recording paused');
  assert.equal(squashPhrase({ cause: 'steps', count: 3 }), '3 steps merged into one');
  assert.equal(squashPhrase({ cause: 'clear', count: 9 }), 'A fresh start from the state reached before the history was cleared');
  assert.equal(squashPhrase({ cause: 'share', count: null }), 'A shared state, received without its history');
  assert.throws(() => squashPhrase({ cause: 'later', count: null }), /paused, steps, clear or share/);

  const schema = definitions[3].params;
  assert.deepEqual(parameterFacts({ cells: new Uint32Array(1234), name: 'Doublets' }, schema), [
    { label: 'Name', value: 'Doublets' },
    { label: 'Cells', value: '1,234 cells' },
  ]);
  assert.deepEqual(parameterFacts({ field: { source: 'var', key: 'CD3E' }, all_branches: true }), [
    { label: 'All branches', value: 'Yes' },
    { label: 'Field', value: 'CD3E (gene)' },
  ]);
  assert.deepEqual(parameterValue(['a', 'b', 'c', 'd', 'e', 'f', 'g']), {
    value: 'a, b, c, d, e and 2 more', title: 'a, b, c, d, e, f, g',
  });
  assert.equal(parameterValue(0.123456789).value, '0.123457');
  assert.equal(parameterValue(1500).value, '1,500');
  assert.equal(lowerFirst('Colored by cell_type'), 'colored by cell_type');
  assert.equal(lowerFirst('PCA computed on 2,000 genes'), 'PCA computed on 2,000 genes');
  assert.equal(numberRanges([5, 1, 2, 3, 8, 9]), '1–3, 5 and 8–9');
  assert.equal(numberRanges([4]), '4');
});

test('the path an export covers: any branch by id or name, up to any of its steps; runs of grouped steps', () => {
  const tracker = fixtureTracker();
  assert.deepEqual(branchPath(tracker).steps.map(s => s.id), ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  assert.equal(branchPath(tracker).to, null);
  const fresh = branchPath(tracker, { branch: 'fresh START' });
  assert.equal(fresh.branch.id, 'b1');
  assert.deepEqual(fresh.steps.map(s => s.id), ['s0', 's10']);
  assert.deepEqual(branchPath(tracker, { branch: 'b0', to: 's4' }).steps.map(s => s.id), ['s0', 's1', 's2', 's3', 's4']);
  assert.equal(branchPath(tracker, { branch: 'b0', to: 's9' }).to, null, 'the tip is the whole branch');
  assert.throws(() => branchPath(tracker, { branch: 'Nope' }), /There is no branch "Nope"; the branches are "Main", "Fresh start"\./);
  assert.throws(() => branchPath(tracker, { branch: 'b1', to: 's4' }), /Step 4 is not on the path of the branch "Fresh start"\./);

  const runs = groupRuns(branchPath(tracker).steps.slice(1), tracker);
  assert.deepEqual(runs.map(run => [run.group?.name ?? null, run.steps.map(s => s.id)]), [
    [null, ['s1']], ['QC', ['s2', 's3']], [null, ['s4', 's5', 's6', 's7']], ['Figure 2', ['s8', 's9']],
  ]);
  assert.deepEqual(runHeadings(runs), ['Before QC', 'QC', 'After QC', 'Figure 2']);
  assert.deepEqual(runHeadings([{ group: null }]), [null], 'no group, no heading');
});

test('pseudocode: stored lines, group markers, bookmarks, each squash cause, outside and flagged steps as comments', () => {
  const tracker = fixtureTracker();
  assert.equal(historyPseudocode({ tracker, dataset: DATASET, version: '0.9.7' }), [
    '# Cellucid 0.9.7 · Suo fetal immune',
    '# Tracker "Annotation", branch "Main": 9 steps',
    'color_by("cell_type")',
    '# --- QC ---',
    'rename_category("cell_type", "T", "T cells")',
    'hide_categories("cell_type", ["NK","B"])  # Claude',
    '# Bookmark: Filtered',
    '# --- end of QC ---',
    'camera(3)',
    '# Changed outside the history: Filters',
    '# Changes made with recording paused: Filters, Colors (values only)',
    '# No longer applies (There is no category "T" in cell_type.): highlight("Doublets", cells=[…3])',
    '# --- Figure 2 ---',
    '# 3 steps merged into one: Highlights (values only)',
    '# Bookmark: Raw highlights (on a step merged into this one)',
    'color_by("leiden")',
    '# Bookmark: Figure 2 done',
    '# --- end of Figure 2 ---',
    '',
  ].join('\n'));
  // Another branch, without showing it; and a branch up to a step.
  assert.equal(historyPseudocode({ tracker, branch: 'Fresh start', dataset: DATASET, version: '0.9.7' }), [
    '# Cellucid 0.9.7 · Suo fetal immune',
    '# Tracker "Annotation", branch "Fresh start": 1 step',
    '# A fresh start from the state reached before the history was cleared: Fields and labels, Filters (values only)',
    '',
  ].join('\n'));
  assert.equal(historyPseudocode({ tracker, to: 's2' }), [
    '# Cellucid',
    '# Tracker "Annotation", branch "Main" up to step 2: 2 steps',
    'color_by("cell_type")',
    '# --- QC ---',
    'rename_category("cell_type", "T", "T cells")',
    '# --- end of QC ---',
    '',
  ].join('\n'));
  assert.equal(historyPseudocode({ tracker: sharedTracker() }), [
    '# Cellucid',
    '# Tracker "Shared", branch "Main": 1 step',
    '# A shared state, received without its history: Fields and labels, Highlights (values only)',
    '',
  ].join('\n'));
  assert.throws(() => historyPseudocode({ tracker: null }), /needs the tracker/);
});

test('methods: the abstract opens it, groups are sections, squashed steps said plainly, counts close it', () => {
  const tracker = fixtureTracker();
  const text = methodsParagraph({
    tracker, version: '0.9.7', cellucidCitation: 'Inecik K. et al. (2026). Cellucid.',
    dataset: { ...DATASET, citation: 'Suo et al. 2022, Science', openCells: { open: 84_192, of: 841_922, method: 'blocks', seed: 0 } },
  });
  assert.equal(text, [
    'Annotation of the fetal immune atlas: *T cells* first.',
    'Single-cell data were explored interactively in Cellucid (version 0.9.7) [Inecik K. et al. (2026). Cellucid].'
      + ' The dataset “Suo fetal immune” (841,922 cells and 33,538 genes; Suo et al. 2022, Science) was opened on 84,192 of'
      + ' its 841,922 cells (10%), chosen in blocks of neighboring cells with seed 0. The 7 steps applied are listed below, in order.'
      + ' For steps 5–6, only the states they reached were kept, not the operations that led to them.'
      + ' 1 further step only changed the camera, the panel layout, colors or display settings and is not listed.'
      + ' 1 recorded step no longer applied after an earlier step was removed and is not included.'
      + ' The complete history, with every parameter, can be reopened from the accompanying Cellucid session file.',
    'Before QC\nThe following 1 step was applied: (1) colored by cell_type.',
    'QC\nThe following 2 steps were applied, in this order: (2) renamed T to T cells in cell_type; (3) hid NK and B in cell_type.'
      + ' Step 3 was taken by an AI assistant (Claude, claude-sonnet-4-6) at the user\'s request.',
    'After QC\nThe following 2 steps were applied, in this order: (4) filters changed outside the recorded steps;'
      + ' (5) changes made with recording paused (filters, colors). Step 5 was taken by a Python notebook through the Cellucid viewer API.',
    'Figure 2\nThe following 2 steps were applied, in this order: (6) 3 steps merged into one (highlights); (7) colored by leiden.',
  ].join('\n\n'));
  const parts = methodsParts({ tracker, dataset: DATASET });
  assert.equal(parts.abstract, 'Annotation of the fetal immune atlas: *T cells* first.');
  assert.deepEqual(parts.paragraphs.map(p => p.heading), [null, 'Before QC', 'QC', 'After QC', 'Figure 2']);
});

test('methods: another branch, a clear, a share, a path with no group, and none at all', () => {
  const tracker = fixtureTracker();
  assert.equal(methodsParagraph({ tracker, branch: 'b1', dataset: { name: 'Pancreas', cells: 3696 } }), [
    'Annotation of the fetal immune atlas: *T cells* first.',
    'Single-cell data were explored interactively in Cellucid. The dataset “Pancreas” (3,696 cells) was opened in full.'
      + ' The following 1 step was applied: (1) a fresh start from the state reached before the history was cleared'
      + ' (fields and labels, filters). Step 1 was taken by an AI assistant (Claude, claude-sonnet-4-6) at the user\'s request.'
      + ' For step 1, only the state it reached was kept, not the operations that led to it.'
      + ' The complete history, with every parameter, can be reopened from the accompanying Cellucid session file.',
  ].join('\n\n'));
  assert.equal(methodsParagraph({ tracker: sharedTracker(), dataset: { name: 'Pancreas' } }),
    'Single-cell data were explored interactively in Cellucid. The dataset “Pancreas” was opened in full.'
    + ' The following 1 step was applied: (1) a shared state, received without its history (fields and labels, highlights).'
    + ' For step 1, only the state it reached was kept, not the operations that led to it.'
    + ' The complete history, with every parameter, can be reopened from the accompanying Cellucid session file.');
  const bare = { ...fixtureTracker(), notes: [] };
  assert.match(methodsParagraph({ tracker: bare, to: 's1' }),
    /^Single-cell data were explored interactively in Cellucid\. The dataset was opened in full\. The following 1 step was applied: \(1\) colored by cell_type\. The complete/);
  assert.match(methodsParagraph({ tracker: bare, to: 's0' }),
    /The dataset was opened in full\. No recorded step changed the data, its annotation or what was computed\. The complete/);
  assert.throws(() => methodsParagraph({ tracker: null }), /needs the tracker/);
});

test('report: abstract, notes, groups as headings, bookmarks, flags, picked pictures only, every text escaped', () => {
  const tracker = fixtureTracker();
  assert.deepEqual(reportPictureDefaults(tracker), ['s3', 's8', 's9'], 'the bookmarks (carried ones too) and the last step of each group');
  assert.deepEqual(reportPictureDefaults(tracker, { to: 's6' }), ['s3']);

  const sections = reportEntries({ tracker, catalog });
  assert.deepEqual(sections.map(s => [s.heading, s.entries.map(e => e.number)]), [
    ['Before QC', [1]], ['QC', [2, 3]], ['After QC', [4, 5, 6, 7]], ['Figure 2', [8, 9]],
  ]);
  const [s3] = sections[1].entries.slice(1);
  assert.deepEqual(s3, {
    id: 's3', number: 3, label: 'Hid NK and B in cell_type', kind: 'action', by: ['Claude'], at: s3.at,
    bookmarks: [{ name: 'Filtered', carried: false }],
    facts: [{ label: 'Action', value: 'Hide categories' }, { label: 'Field', value: 'cell_type' }, { label: 'Categories', value: 'NK, B' }],
    changed: ['Filters'], flag: null,
    notes: [{ text: 'NK and B are <not> of interest here.', by: 'Claude', at: START + 3_600_000, carried: false }],
  });
  const [, s5, s6, s7] = sections[2].entries;
  assert.equal(s5.flag, 'Changed outside the recorded steps. Only the state it reached is kept.');
  assert.deepEqual(s5.facts, [], 'an outside change has no action and no parameters');
  assert.deepEqual(s6.by, ['Person', 'Python'], 'everyone who acted while paused');
  assert.equal(s6.flag, 'Changes made with recording paused. Only the state it reached is kept, not the operations.');
  assert.deepEqual(s6.changed, ['Filters', 'Colors']);
  assert.equal(s7.flag, 'No longer applies: There is no category "T" in cell_type.');
  const s8 = sections[3].entries[0];
  assert.equal(s8.flag, '3 steps merged into one. Only the state it reached is kept, not the operations.');
  assert.deepEqual(s8.bookmarks, [{ name: 'Raw highlights', carried: true }]);
  assert.deepEqual(s8.notes.map(n => [n.text, n.carried]), [['Three lassos, one highlight.', true]]);

  const html = reportDocument({
    tracker, catalog, generatedAt: Date.UTC(2026, 10, 3, 12), version: '0.9.7', locale: 'en-GB',
    dataset: { name: 'Suo <fetal> immune', id: 'suo', cells: 841_922, genes: 33_538 },
    pictures: new Map([['s9', { src: 'data:image/png;base64,AAAA', alt: 'Views after step 9' }]]),
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>History report · Suo &lt;fetal&gt; immune<\/title>/);
  assert.match(html, /<section><h2>Abstract<\/h2><p>Annotation of the fetal immune atlas: \*T cells\* first\.<\/p><\/section>/);
  assert.match(html, /<h2>Notes<\/h2><ul class="notes"><li>Second tracker note\. <span class="meta">· Person, [^<]+<\/span><\/li><li>The main line\./);
  assert.equal(html.match(/<li>\n<div class="step-head">/g).length, 9);
  assert.match(html, /<h3>QC <span class="meta">· 2 steps<\/span><\/h3><ul class="notes"><li>Quality control first\./);
  assert.match(html, /<h3>After QC <span class="meta">· 4 steps<\/span><\/h3>\n<ol/);
  assert.match(html, /<h3>Figure 2<\/h3><p>The following 2 steps were applied/, 'the methods use the same headings');
  assert.doesNotMatch(html, /<p>Annotation of the fetal immune atlas[^<]*<\/p>[\s\S]*<h2>Methods<\/h2><p>Annotation/, 'the abstract is not repeated in the methods');
  assert.match(html, /<span class="step-bookmark">★ Filtered<\/span>/);
  assert.match(html, /<span class="step-bookmark" title="On a step merged into this one">★ Raw highlights \(merged\)<\/span>/);
  assert.match(html, /Three lassos, one highlight\. <span class="meta">· Person, on a merged step, /);
  assert.match(html, /NK and B are &lt;not&gt; of interest here\./);
  assert.match(html, /No longer applies: There is no category &quot;T&quot; in cell_type\./);
  assert.match(html, /Changes made with recording paused\. Only the state it reached is kept, not the operations\./);
  assert.match(html, /<span class="step-by">Person, Python<\/span>/);
  assert.match(html, /<dt>Cells<\/dt><dd>841,922<\/dd>/);
  assert.match(html, /<dt>Branch<\/dt><dd>Main<\/dd>/);
  assert.match(html, /<img src="data:image\/png;base64,AAAA" alt="Views after step 9"><figcaption>After step 9<\/figcaption>/);
  assert.equal(html.match(/<img /g).length, 1, 'only the pictures passed in');
  assert.match(html, /<pre># Cellucid 0\.9\.7 · Suo &lt;fetal&gt; immune\n/);
  assert.doesNotMatch(html, /<script/i, 'the report runs no code');

  const fresh = reportDocument({ tracker, branch: 'Fresh start', catalog, generatedAt: 0, picturesNote: 'No pictures.' });
  assert.match(fresh, /<dt>Branch<\/dt><dd>Fresh start<\/dd>/);
  assert.match(fresh, /<p class="note">No pictures\.<\/p>/);
  assert.doesNotMatch(fresh, /<h3>/, 'a path with no group has no headings');
  assert.match(fresh, /<span class="step-by">Person, Claude<\/span>/);
  const upTo = reportDocument({ tracker: { ...tracker, notes: [] }, to: 's0', catalog, generatedAt: 0 });
  assert.match(upTo, /No steps were taken\./);
  assert.match(upTo, /<dt>Branch<\/dt><dd>Main, up to step 0<\/dd>/);
  assert.doesNotMatch(upTo, /<h2>Abstract<\/h2>/);
  assert.throws(() => reportEntries({ tracker, catalog: null }), /action catalog/);
});
