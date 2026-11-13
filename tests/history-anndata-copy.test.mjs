/**
 * The apply plan of "Save AnnData with this state…"
 * (`app/history/exports/anndata-copy.js`) against the shared expected plan
 * cellucid-python and cellucid-r compare with too
 * (`history-golden.expected.json` `apply.sequence`): the golden history's
 * head, the head again, its bookmark and another branch's tip, applied one
 * after another to the same dataset, row for row; the provenance the first
 * records; and the changes a copy writes for them (the columns' values, the
 * renames in place, `uns['cellucid']`), applied here as the copy places
 * them (`data/anndata/write/copy.js`: a change of a column's name in its
 * place, one of the same name replaced in place, a new one after the rest),
 * so each plan is made against what the one before it wrote. Then the
 * cases the golden does not hold: a subsample's unknown cells, a name a
 * file cannot hold, a dataset's own column never replaced, a gene set's var
 * column replaced in place, kept when it is the dataset's own, absent
 * when the mapping reads no var, and the step's expression values recorded
 * in the provenance (never applied).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HISTORY_GOLDEN_EXPECTED_PATH, goldenSession } from '../scripts/generate-history-golden.mjs';
import { valuesAt } from '../assets/js/app/history/tree.js';
import {
  COLORS_NOTE, GENE_SET_PREFIX, HISTORY_APPLIED_KEY, PRESENTATION_NOTE, chooseStep, geneSetColumns, highlightColumn, historyApplied, planAnnDataCopy, unwritableName,
} from '../assets/js/app/history/exports/anndata-copy.js';
import { requireElementKey } from '../assets/js/data/anndata/write/names.js';

const expected = JSON.parse(readFileSync(HISTORY_GOLDEN_EXPECTED_PATH, 'utf8'));

/** The golden dataset as a copy target, its obs columns as a copy holds them. */
function goldenTarget({ known = null } = {}) {
  const { dataset } = expected;
  const columns = new Map(Object.entries(dataset.obs).map(([name, { categories, codes }]) => [
    name, { kind: 'categorical', categories: [...categories], codes: Int8Array.from(codes), ordered: false },
  ]));
  return {
    nObs: dataset.n_obs,
    order: [...columns.keys()],
    columns,
    cellucid: null,
    // Root uns keys other than cellucid (a column's colors, `<column>_colors`), as stored.
    uns: new Map(),
    var: new Map(),
    known,
    genes: { names: [...dataset.var_names], modality: null, columns: [] },
  };
}

/** The `CopyTarget` the planner reads, over the dataset `state`. */
function copyTarget(state) {
  return {
    nObs: state.nObs,
    obsColumns: [...state.order],
    modalityColumns: new Set(),
    column: async name => state.columns.get(name) ?? null,
    unsKeys: [...state.uns.keys()],
    // As `copy-target.js` reads them: text colors, null for none or another form.
    colors: async name => {
      const held = state.uns.get(`${name}_colors`);
      return Array.isArray(held) && held.every(color => typeof color === 'string') ? [...held] : null;
    },
    cellucid: state.cellucid,
    known: state.known,
    copiedValues: async () => { throw new Error('The golden holds no continuous copy.'); },
    genes: { ...state.genes, columns: [...state.var.keys()] },
  };
}

/** Apply a copy's changes to `state` as the copy places them (`copy.js` `copyFrame`). */
function applyChanges(state, changes) {
  const renamedFrom = new Map(changes.obs.filter(change => change.from !== undefined).map(change => [change.from, change]));
  const byName = new Map(changes.obs.filter(change => change.from === undefined).map(change => [change.name, change]));
  const order = [];
  const columns = new Map();
  for (const name of state.order) {
    const renamed = renamedFrom.get(name);
    if (renamed !== undefined) {
      order.push(renamed.name);
      columns.set(renamed.name, renamed.column ?? state.columns.get(name));
    } else {
      order.push(name);
      columns.set(name, byName.get(name)?.column ?? state.columns.get(name));
      byName.delete(name);
    }
  }
  for (const [name, change] of byName) {
    order.push(name);
    columns.set(name, change.column);
  }
  state.order = order;
  state.columns = columns;
  for (const change of changes.var) state.var.set(change.name, change.column);
  for (const [key, value] of Object.entries(changes.uns ?? {})) {
    if (value === null) state.uns.delete(key);
    else state.uns.set(key, value);
  }
  if (changes.cellucid !== undefined) state.cellucid = { ...(state.cellucid ?? {}), ...changes.cellucid };
}

async function golden() {
  const session = await goldenSession();
  const valueOf = (choice, domain) => session.values.get(valuesAt(choice.live, choice.step)[domain]);
  return { session, valueOf };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('the golden apply sequence: every plan row for row, one after another on the same dataset', async () => {
  const { session, valueOf } = await golden();
  const state = goldenTarget();
  const provenances = [];
  for (const entry of expected.apply.sequence) {
    const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker, tracker: entry.tracker, branch: entry.branch, step: entry.step });
    assert.deepEqual({ tracker: choice.tracker.id, branch: choice.branch, step: choice.step }, entry.expect, `${entry.name}: the step chosen`);
    const made = await planAnnDataCopy({
      choice, valueOf: domain => valueOf(choice, domain), target: copyTarget(state),
      sessionSha256: expected.sha256, version: '0.9.7', appliedAt: '2026-11-05T10:00:00.000Z',
    });
    assert.deepEqual(plain(made.plan.rows), entry.rows, `${entry.name}: the rows`);
    assert.deepEqual(made.plan.requires, entry.requires, `${entry.name}: what the step requires`);
    assert.equal(made.provenance !== null, entry.applied, `${entry.name}: applied`);
    assert.deepEqual(made.changes.var.map(change => ({ name: change.name, values: [...change.column.values].map(Boolean) })), entry.var_columns, `${entry.name}: the var columns`);
    if (made.provenance !== null) provenances.push(made.provenance);
    applyChanges(state, made.changes);
  }
  // The first apply records what the expected provenance holds, and the web's own stamp.
  const [first] = provenances;
  for (const [key, value] of Object.entries(expected.apply.provenance)) assert.deepEqual(first[key], value, `provenance.${key}`);
  assert.equal(first.package, 'web');
  assert.equal(first.cellucid_version, '0.9.7');
  assert.equal(first.applied_at, '2026-11-05T10:00:00.000Z');
  // history_applied holds both applies that wrote, oldest first, as the packages read it.
  assert.deepEqual(historyApplied(state.cellucid), provenances);
  assert.equal(state.cellucid[HISTORY_APPLIED_KEY], JSON.stringify(provenances));
});

test('the head written: labels, user fields, highlights and gene sets as the expected values say', async () => {
  const { session, valueOf } = await golden();
  const state = goldenTarget();
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker });
  const made = await planAnnDataCopy({ choice, valueOf: domain => valueOf(choice, domain), target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7' });
  applyChanges(state, made.changes);
  const { values, dataset } = expected;
  assert.deepEqual(state.order, ['cell_type', 'leiden', 'score', 'cell_type (merged)', 'cellucid_highlight__QC__Doublets']);
  // NK cell renamed NK in place: codes kept, the category's label changed.
  const cellType = state.columns.get('cell_type');
  assert.deepEqual(cellType.categories, ['B cell', 'T cell', 'NK']);
  assert.deepEqual([...cellType.codes], dataset.obs.cell_type.codes);
  // The score: float32, NaN where it holds no value.
  const score = state.columns.get('score');
  assert.equal(score.kind, 'numbers');
  assert.ok(score.values instanceof Float32Array);
  const scoreAt = new Map(values.score.cells.map((cell, i) => [cell, values.score.values[i]]));
  for (let cell = 0; cell < dataset.n_obs; cell++) {
    const want = scoreAt.get(cell) ?? null;
    if (want === null) assert.ok(Number.isNaN(score.values[cell]), `score at ${cell}`);
    else assert.equal(score.values[cell], Math.fround(want), `score at ${cell}`);
  }
  const merged = state.columns.get('cell_type (merged)');
  assert.deepEqual(merged.categories, values.merged.categories);
  assert.deepEqual([...merged.codes], values.merged.codes);
  const doublets = state.columns.get('cellucid_highlight__QC__Doublets');
  assert.equal(doublets.kind, 'booleans');
  assert.deepEqual([...doublets.values.keys()].filter(cell => doublets.values[cell] === 1), values.doublets);
  // The gene set by name in uns['cellucid'], and as a var column.
  assert.deepEqual(state.cellucid.gene_sets, {
    'T cell markers': { genes: ['CD3E', 'NKG7'], description: 'From Claude', origin: 'session', pulled_from: 'viewer', id: 'T cell markers' },
  });
  assert.deepEqual([...state.var.get(`${GENE_SET_PREFIX}T_cell_markers`).values], dataset.var_names.map(gene => (['CD3E', 'NKG7'].includes(gene) ? 1 : 0)));
  assert.deepEqual(made.leftOut, []);
});

test('a subsample: the cells not open are unknown, missing in a field and <NA> in a highlight', async () => {
  const { session, valueOf } = await golden();
  const known = Uint32Array.from({ length: 300 }, (_, i) => 2 * i);
  const state = goldenTarget({ known });
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker });
  const made = await planAnnDataCopy({ choice, valueOf: domain => valueOf(choice, domain), target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7' });
  const column = name => made.changes.obs.find(change => change.name === name).column;
  const doublets = column('cellucid_highlight__QC__Doublets');
  assert.equal(doublets.kind, 'nullable-boolean');
  for (let cell = 0; cell < 600; cell++) assert.equal(doublets.mask[cell], cell % 2 === 0 ? 0 : 1, `mask at ${cell}`);
  const row = made.plan.rows.find(entry => entry.name === 'cellucid_highlight__QC__Doublets');
  assert.equal(row.cells, expected.values.doublets.filter(cell => cell % 2 === 0).length);
  const merged = column('cell_type (merged)');
  for (let cell = 1; cell < 600; cell += 2) assert.equal(merged.codes[cell], -1, `merged at ${cell}`);
  assert.equal(made.plan.rows.find(entry => entry.name === 'cell_type (merged)').cells, 300);
  const score = column('score');
  for (let cell = 1; cell < 600; cell += 2) assert.ok(Number.isNaN(score.values[cell]), `score at ${cell}`);
});

test('a column the dataset holds of its own is never replaced, and an unwritable name is refused in one sentence', async () => {
  const { session, valueOf } = await golden();
  const state = goldenTarget();
  state.order.push('score');
  state.columns.set('score', { kind: 'numbers', values: new Float32Array(600) });
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker });
  const made = await planAnnDataCopy({ choice, valueOf: domain => valueOf(choice, domain), target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7' });
  const score = made.plan.rows.find(entry => entry.name === 'score');
  assert.equal(score.status, 'not-applied');
  assert.equal(score.note, 'The object already has an obs column "score" that Cellucid did not write; it is never replaced.');
  assert.ok(!made.changes.obs.some(change => change.name === 'score'));
  assert.equal(unwritableName(made.plan, requireElementKey), null);
  const slash = { rows: [{ kind: 'gene-set', name: 'CD4+/CD8+ T', status: 'write' }] };
  assert.match(unwritableName(slash, requireElementKey), /^The gene set "CD4\+\/CD8\+ T" cannot be saved in a file under that name/);
});

test('the provenance records the step\'s expression values, never applied; null for a session without them; another shape refused', async () => {
  const { session, valueOf } = await golden();
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker });
  const plan = (expression, state = goldenTarget()) => planAnnDataCopy({
    choice, valueOf: domain => (domain === 'expression' ? expression : valueOf(choice, domain)),
    target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7',
  });
  // The golden head holds the opening's values (as stored), as the expected provenance says.
  assert.deepEqual(valueOf(choice, 'expression'), { normalize: false, log1p: false });
  assert.deepEqual(expected.apply.provenance.expression, { normalize: false, log1p: false });
  const state = goldenTarget();
  const shown = await plan({ normalize: true, log1p: true }, state);
  assert.deepEqual(shown.provenance.expression, { normalize: true, log1p: true });
  // Recorded, never applied: no change touches the expression matrix (obs and
  // var columns, and the colors of the categorical field written, only).
  assert.deepEqual(Object.keys(shown.changes).sort(), ['cellucid', 'obs', 'uns', 'var']);
  assert.deepEqual(shown.changes.uns, { 'cell_type (merged)_colors': ['#ff9900', '#0077c8'] });
  applyChanges(state, shown.changes);
  assert.deepEqual(historyApplied(state.cellucid).map(record => record.expression), [{ normalize: true, log1p: true }]);
  assert.deepEqual((await plan({ normalize: true, log1p: false })).provenance.expression, { normalize: true, log1p: false });
  assert.equal((await plan(undefined)).provenance.expression, null);
  await assert.rejects(plan({ normalize: true }), /The expression values at step s13 is exactly \{normalize: boolean, log1p: boolean\}/);
  await assert.rejects(plan({ normalize: true, log1p: 1 }), /The expression values at step s13 is exactly/);
});

test('a column\'s colors go with it as the packages write them: a field\'s palette, none for another column, carried by a rename and a merge', async () => {
  // The rule of cellucid-python's write_columns and cellucid-r's .colors_state, case for case.
  const { session, valueOf } = await golden();
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker });
  const n = expected.dataset.n_obs;
  const field = (id, key, categories, palette) => ({
    id, source: 'obs', kind: 'category', key, deleted: false, purged: false, createdAt: 0, sourceField: null,
    operation: { type: 'annotation' }, categories, codes: { cells: null, values: Uint8Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0 : 255)) },
    sourcePages: [], overlapStrategy: 'first', overlapLabel: null, intersectionLabels: null, uncoveredLabel: null, palette,
  });
  const plan = (state, overlays, highlights = { active: null, pages: [] }, options = {}) => planAnnDataCopy({
    choice, valueOf: domain => (domain === 'field-overlays' ? overlays : domain === 'highlights' ? highlights : valueOf(choice, domain)),
    target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7', ...options,
  });
  const overlays = ({ renamedFields = [], renamedCategories = [], userFields = [] }) => ({ renamedFields, renamedCategories, deletedFields: [], userFields });
  const state = goldenTarget();
  state.order.push('label');
  state.columns.set('label', { kind: 'strings', values: Array.from({ length: n }, (_, i) => `x${i % 2}`) });
  state.uns.set('plain_colors', ['#000000', '#111111']);
  state.uns.set('cellucid_highlight__QC__Gate_colors', ['#000000']);
  state.uns.set('cell_type_colors', ['#aa0000', '#00aa00', '#0000aa']);
  state.uns.set('leiden_colors', ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666']);
  state.uns.set('cluster_colors', ['#999999']);
  state.uns.set('label_colors', ['#444444', '#555555']);
  const made = await plan(state, overlays({
    renamedFields: [{ source: 'obs', key: 'leiden', name: 'cluster' }],
    // B cell merges into T cell, in B cell's place: the category keeps B cell's color.
    renamedCategories: [{ source: 'obs', field: 'cell_type', category: 'B cell', name: 'T cell' }, { source: 'obs', field: 'label', category: 'x1', name: 'y' }],
    userFields: [field('user_cat_1', 'annotation', ['a', 'unused'], ['#dc2626', '#2563eb']), field('user_cat_2', 'plain', ['x'], null)],
  }), { active: 'page_1', pages: [{ id: 'page_1', name: 'QC', color: '#e41a1c', groups: [{ id: 'highlight_1', type: 'lasso', label: 'Gate', enabled: true, cells: Uint32Array.of(0, 1) }] }] });
  assert.deepEqual(made.changes.uns, {
    'cell_type_colors': ['#aa0000', '#0000aa'],
    // A text column relabeled: Scanpy colors it by its sorted labels, which the rename reorders.
    'label_colors': null,
    'leiden_colors': null,
    'cluster_colors': ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'],
    // Every category, used or not; a field without a palette: Cellucid's own
    // colors; a column of no categories (a highlight) takes none.
    'annotation_colors': ['#dc2626', '#2563eb'],
    'plain_colors': ['#ff9900'],
    'cellucid_highlight__QC__Gate_colors': null,
  });
  applyChanges(state, made.changes);
  assert.deepEqual(state.columns.get('cell_type').categories, ['T cell', 'NK cell']);
  // Applied again: unchanged, colors as they are.
  state.uns.set('annotation_colors', ['#dc2626', '#000000']);
  const again = await plan(state, overlays({ userFields: [field('user_cat_1', 'annotation', ['a', 'unused'], ['#dc2626', '#2563eb'])] }));
  assert.equal(again.provenance, null);
  assert.equal(again.changes.uns, undefined);
  // Replaced (overwrite): the new palette replaces the colors.
  const other = field('user_cat_1', 'annotation', ['a', 'unused'], ['#111111', '#222222']);
  other.codes = { cells: null, values: new Uint8Array(n) };
  const replaced = await plan(state, overlays({ userFields: [other] }), undefined, { overwrite: true });
  assert.equal(replaced.plan.rows.find(row => row.name === 'annotation').status, 'replace');
  assert.deepEqual(replaced.changes.uns, { annotation_colors: ['#111111', '#222222'] });

  // A merge drops colors that did not cover the categories; a rename alone leaves them.
  const short = goldenTarget();
  short.uns.set('cell_type_colors', ['#aa0000', '#00aa00']);
  short.uns.set('leiden_colors', ['#111111']);
  const merged = await plan(short, overlays({ renamedCategories: [
    { source: 'obs', field: 'cell_type', category: 'NK cell', name: 'T cell' }, { source: 'obs', field: 'leiden', category: '0', name: 'zero' },
  ] }));
  assert.deepEqual(merged.changes.uns, { cell_type_colors: null });
});

test('a field\'s colors are the ones the view in focus shows, as the packages write them', async () => {
  // The colors a person or an agent gave a field's categories reach
  // uns['<key>_colors']: in the view in focus at the step, each category
  // recolored there, the rest in the colors it opens with -- its palette,
  // else Cellucid's own colors by position. Another view's colors stay how
  // the data was shown; a dataset column recolored in the view in focus
  // takes its colors too.
  const { session, valueOf } = await golden();
  // A step whose colors differ from the tracker's opening (a color map), so the plan has a colors row.
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker, step: 's14' });
  const n = expected.dataset.n_obs;
  const field = (id, key, categories, palette) => ({
    id, source: 'obs', kind: 'category', key, deleted: false, purged: false, createdAt: 0, sourceField: null,
    operation: { type: 'group' }, categories, codes: { cells: null, values: Uint8Array.from({ length: n }, (_, i) => i % categories.length) },
    sourcePages: [], overlapStrategy: 'first', overlapLabel: null, intersectionLabels: null, uncoveredLabel: null, palette,
  });
  const recolor = (id, ...pairs) => ({ field: { source: 'obs', user: id }, colors: pairs.map(([category, color]) => ({ category, color })) });
  const overlays = { renamedFields: [], renamedCategories: [], deletedFields: [], userFields: [
    field('user_cat_1', 'stage', ['early', 'mid', 'late'], null), field('user_cat_2', 'fate', ['a', 'b'], ['#dc2626', '#16a34a']),
  ] };
  const live = [recolor('user_cat_1', ['early', '#111111'])];
  const kept = [
    { field: { source: 'obs', key: 'cell_type' }, colors: [{ category: 'B cell', color: '#000000' }] },
    recolor('user_cat_1', ['late', '#008080'], ['early', '#808080'], ['absent', '#ffffff']),
    recolor('user_cat_2', ['b', '#ffd700']),
  ];
  const plan = (focus, colors = { views: [live, kept] }, state = goldenTarget()) => planAnnDataCopy({
    choice,
    valueOf: domain => (domain === 'field-overlays' ? overlays : domain === 'colors' ? colors
      : domain === 'views' ? { ...valueOf(choice, 'views'), focus } : valueOf(choice, domain)),
    target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7',
  });
  const kept1 = await plan(1);
  assert.deepEqual(kept1.changes.uns, {
    // The dataset column recolored in the view in focus.
    cell_type_colors: ['#000000', '#0077c8', '#ad50e0'],
    stage_colors: ['#808080', '#0077c8', '#008080'], fate_colors: ['#dc2626', '#ffd700'],
  });
  const [columnRow, row] = kept1.plan.rows.filter(entry => entry.domain === 'colors');
  assert.deepEqual([columnRow.kind, columnRow.name, columnRow.status], ['column-colors', 'cell_type', 'write']);
  assert.deepEqual([row.status, row.note], ['not-applied', COLORS_NOTE]);
  // Recolored in another view only: not written.
  assert.deepEqual((await plan(0)).changes.uns, { stage_colors: ['#111111', '#0077c8', '#ad50e0'], fate_colors: ['#dc2626', '#16a34a'] });
  // Applied again: the dataset column holds those colors (unchanged), the presentation row still says they went.
  const state = goldenTarget();
  applyChanges(state, kept1.changes);
  const again = await plan(1, undefined, state);
  assert.deepEqual(again.plan.rows.filter(entry => entry.domain === 'colors').map(entry => [entry.kind, entry.status, entry.note]), [
    ['column-colors', 'unchanged', null], ['presentation', 'not-applied', COLORS_NOTE]]);
  // Nothing recolored: the colors the fields open with.
  const none = await plan(0, { views: [[]] });
  assert.deepEqual(none.changes.uns, { stage_colors: ['#ff9900', '#0077c8', '#ad50e0'], fate_colors: ['#dc2626', '#16a34a'] });
  assert.equal(none.plan.rows.find(entry => entry.domain === 'colors').note, PRESENTATION_NOTE);
  await assert.rejects(plan(1, { views: [[]] }), /colors value holds 1 view, and the view in focus is view 1/);
  await assert.rejects(plan(0, { views: [[recolor('user_cat_1', ['early', '#FFFFFF'])]] }), /not one #rrggbb color/);
});

/**
 * cellucid-python's `_small()` as a copy target: `cell_type` (B, T, NK),
 * `leiden` ("0", "1", "2"), `label` (text) and `count` (numbers), six cells.
 */
function smallTarget() {
  const columns = new Map([
    ['cell_type', { kind: 'categorical', categories: ['B', 'T', 'NK'], codes: Int8Array.of(0, 1, 1, 2, 0, 1), ordered: false }],
    ['leiden', { kind: 'categorical', categories: ['0', '1', '2'], codes: Int8Array.of(0, 1, 2, 0, 1, 2), ordered: false }],
    ['label', { kind: 'strings', values: ['x0', 'x1', 'x0', 'x1', 'x0', 'x1'] }],
    ['count', { kind: 'numbers', values: Float64Array.of(0, 1, 2, 3, 4, 5) }],
  ]);
  return {
    nObs: 6, order: [...columns.keys()], columns, cellucid: null, uns: new Map(), var: new Map(), known: null,
    genes: { names: ['G1', 'G2'], modality: null, columns: [] },
  };
}

/** Plan a step of the golden that holds a colors value against `state`, with the domains given (the data domains empty otherwise). */
async function smallPlan(state, given, targetOverrides = {}) {
  const { session, valueOf } = await golden();
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker, step: 's14' });
  const empty = {
    'field-overlays': { renamedFields: [], renamedCategories: [], deletedFields: [], userFields: [] },
    highlights: { active: null, pages: [] },
    'gene-sets': { sets: [] },
  };
  return planAnnDataCopy({
    choice,
    valueOf: domain => (Object.hasOwn(given, domain) ? given[domain] : Object.hasOwn(empty, domain) ? empty[domain] : valueOf(choice, domain)),
    target: { ...copyTarget(state), ...targetOverrides }, sessionSha256: expected.sha256, version: '0.9.7',
  });
}

const datasetRecolor = (key, ...pairs) => ({ field: { source: 'obs', key }, colors: pairs.map(([category, color]) => ({ category, color })) });

test('a recolored dataset column is written with the colors it is shown in, as the packages write it', async () => {
  // cellucid-python's test of the same name, input for input: the
  // categories recolored, the rest in the colors the column opens with --
  // Scanpy's colors for it, as drawn (#rgb widened, alpha dropped), else
  // Cellucid's own by position. Applied again: unchanged.
  const colors = { views: [[
    datasetRecolor('cell_type', ['T', '#123456']),
    datasetRecolor('leiden', ['1', '#00ff00']),
    datasetRecolor('label', ['x0', '#ffffff']),
    datasetRecolor('count', ['absent', '#ffffff']),
  ]] };
  const state = smallTarget();
  state.uns.set('cell_type_colors', ['#AA0000', '#0a0', '#0000aaff']);
  state.uns.set('leiden_colors', ['#111111']); // fewer than its 3 categories: the viewer opens it in Cellucid's colors
  const made = await smallPlan(state, { colors });
  assert.deepEqual(made.plan.rows.filter(row => row.domain === 'colors').map(row => [row.kind, row.name, row.status, row.note]), [
    ['column-colors', 'cell_type', 'write', null],
    ['column-colors', 'leiden', 'write', null],
    ['column-colors', 'label', 'not-applied', 'The obs column "label" is not categorical; Scanpy keeps colors for a categorical column only.'],
    ['column-colors', 'count', 'not-applied', 'The obs column "count" is not categorical; Scanpy keeps colors for a categorical column only.'],
    ['presentation', 'Colors', 'not-applied', COLORS_NOTE],
  ]);
  assert.deepEqual(made.changes.uns, {
    cell_type_colors: ['#aa0000', '#123456', '#0000aa'],
    leiden_colors: ['#ff9900', '#00ff00', '#ad50e0'],
  });
  assert.notEqual(made.provenance, null);
  assert.deepEqual(made.provenance.skipped.filter(entry => entry.kind === 'column-colors').map(entry => entry.name), ['label', 'count']);
  applyChanges(state, made.changes);
  const again = await smallPlan(state, { colors });
  assert.equal(again.provenance, null);
  assert.equal(again.changes.uns, undefined);
  assert.deepEqual(again.plan.rows.filter(row => row.kind === 'column-colors').map(row => row.status), ['unchanged', 'unchanged', 'not-applied', 'not-applied']);
  // A column the dataset lacks, or a MuData modality's, says why.
  const lacking = await smallPlan(smallTarget(), { colors: { views: [[datasetRecolor('ghost', ['a', '#ffffff'])]] } });
  assert.deepEqual(lacking.plan.rows.find(row => row.kind === 'column-colors').note, 'The object has no obs column "ghost".');
  const modality = await smallPlan(smallTarget(), { colors: { views: [[datasetRecolor('rna:leiden', ['0', '#ffffff'])]] } },
    { modalityColumns: new Set(['rna:leiden']) });
  assert.equal(modality.plan.rows.find(row => row.kind === 'column-colors').note, '"rna:leiden" is a column of a MuData modality; colors apply to the global obs.');
});

test('a recolored dataset column renamed in the session takes its colors by its new labels, as the packages write it', async () => {
  // The colors value names a dataset column by the key the dataset gives it
  // and its categories by the labels shown at the step: the column renamed
  // and a category relabeled by the same apply are written under the new
  // names, the colors in the column's order; a label the column lacks is
  // said, the others written.
  const state = smallTarget();
  state.uns.set('cell_type_colors', ['#aa0000', '#00aa00', '#0000aa']);
  const made = await smallPlan(state, {
    'field-overlays': {
      renamedFields: [{ source: 'obs', key: 'cell_type', name: 'kind' }],
      renamedCategories: [{ source: 'obs', field: 'cell_type', category: 'B', name: 'Bcell' }],
      deletedFields: [], userFields: [],
    },
    colors: { views: [[datasetRecolor('cell_type', ['Bcell', '#101010'], ['ghost', '#202020'])]] },
  });
  applyChanges(state, made.changes);
  assert.deepEqual(state.columns.get('kind').categories, ['Bcell', 'T', 'NK']);
  assert.deepEqual(state.uns.get('kind_colors'), ['#101010', '#00aa00', '#0000aa']);
  assert.equal(state.uns.has('cell_type_colors'), false);
  const [row] = made.plan.rows.filter(entry => entry.kind === 'column-colors');
  assert.deepEqual([row.name, row.status, row.note], ['kind', 'write', 'Not written: the color of "ghost", which the obs column "kind" does not have.']);
  // Only labels the column lacks: nothing to write.
  const only = await smallPlan(smallTarget(), { colors: { views: [[datasetRecolor('leiden', ['9', '#202020'], ['8', '#303030'])]] } });
  const [lone] = only.plan.rows.filter(entry => entry.kind === 'column-colors');
  assert.deepEqual([lone.status, lone.note], ['not-applied', 'Not written: the colors of "9", "8", which the obs column "leiden" does not have.']);
  // A merge by the same apply: the category takes its first source's opening color.
  const merged = smallTarget();
  merged.uns.set('cell_type_colors', ['#aa0000', '#00aa00', '#0000aa']);
  const merging = await smallPlan(merged, {
    'field-overlays': { renamedFields: [], renamedCategories: [{ source: 'obs', field: 'cell_type', category: 'B', name: 'NK' }], deletedFields: [], userFields: [] },
    colors: { views: [[datasetRecolor('cell_type', ['T', '#123456'])]] },
  });
  assert.deepEqual(merging.changes.uns, { cell_type_colors: ['#aa0000', '#123456'] });
});

test('highlight columns follow the packages\' naming rule', () => {
  assert.equal(highlightColumn('QC', 'page_1', 'Doublets', 'highlight_1'), 'cellucid_highlight__QC__Doublets');
  assert.equal(highlightColumn('Types', 'page_2', 'cell_type: T cell', 'g'), 'cellucid_highlight__Types__cell_type_T_cell');
  assert.equal(highlightColumn('—', 'page_3', '***', 'g9'), 'cellucid_highlight__page_3__g9');
});

test('a gene set\'s var column: replaced in place with overwrite, never over the dataset\'s own, none without a var to mark', async () => {
  const { session, valueOf } = await golden();
  const column = `${GENE_SET_PREFIX}T_cell_markers`;
  const choice = chooseStep(session.trackers, { activeTracker: session.activeTracker });
  const plan = (state, options = {}) => planAnnDataCopy({
    choice, valueOf: domain => valueOf(choice, domain), target: copyTarget(state), sessionSha256: expected.sha256, version: '0.9.7', ...options,
  });
  // An earlier apply wrote the set with other genes, and its column after another var column.
  const state = goldenTarget();
  state.var.set('highly_variable', { kind: 'booleans', values: Uint8Array.of(1, 1, 1, 1) });
  applyChanges(state, (await plan(state)).changes);
  state.cellucid = { ...state.cellucid, gene_sets: { 'T cell markers': { ...state.cellucid.gene_sets['T cell markers'], genes: ['LYZ'] } } };
  state.var.set(column, { kind: 'booleans', values: Uint8Array.of(0, 0, 0, 1) });
  const kept = await plan(state);
  assert.equal(kept.plan.rows.find(row => row.kind === 'gene-set').status, 'not-applied');
  assert.deepEqual(kept.changes.var, []);
  const replaced = await plan(state, { overwrite: true });
  assert.equal(replaced.plan.rows.find(row => row.kind === 'gene-set').status, 'replace');
  assert.deepEqual(replaced.changes.var.map(change => [change.name, [...change.column.values]]), [[column, [1, 0, 1, 0]]]);
  applyChanges(state, replaced.changes);
  assert.deepEqual([...state.var.keys()], ['highly_variable', column], 'replaced in its place');

  // A var column of that name the dataset holds beside no set an apply wrote: its own, kept.
  const own = goldenTarget();
  own.var.set(column, { kind: 'booleans', values: Uint8Array.of(0, 0, 0, 0) });
  const made = await plan(own);
  assert.equal(made.plan.rows.find(row => row.kind === 'gene-set').status, 'write');
  assert.deepEqual(made.changes.var, []);
  assert.deepEqual(made.leftOut, [`The gene set "T cell markers" has no var column: the var column "${column}" is the dataset's own.`]);

  // A mapping that reads the raw matrix's genes: the set in uns only, said so.
  const raw = goldenTarget();
  raw.genes = null;
  const rawCopy = await planAnnDataCopy({ choice, valueOf: domain => valueOf(choice, domain), target: { ...copyTarget(raw), genes: null }, sessionSha256: expected.sha256, version: '0.9.7' });
  assert.deepEqual(rawCopy.changes.var, []);
  assert.ok(rawCopy.changes.cellucid.gene_sets['T cell markers']);
  assert.match(rawCopy.leftOut.join('\n'), /kept in uns\['cellucid'\]\['gene_sets'\] only/);
});

test('gene-set var columns are named over every set of the step, so a set\'s column does not depend on which are written', () => {
  const columns = geneSetColumns([{ name: 'T cells' }, { name: 'T-cells' }, { name: '***' }, { name: 'T cells!' }]);
  assert.deepEqual([...columns.values()], [
    'cellucid_gene_set__T_cells', 'cellucid_gene_set__T_cells_2', 'cellucid_gene_set__gene_set', 'cellucid_gene_set__T_cells_3',
  ]);
});
