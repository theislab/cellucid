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
 * column replaced in place, kept when it is the dataset's own, and absent
 * when the mapping reads no var.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HISTORY_GOLDEN_EXPECTED_PATH, goldenSession } from '../scripts/generate-history-golden.mjs';
import { valuesAt } from '../assets/js/app/history/tree.js';
import {
  GENE_SET_PREFIX, HISTORY_APPLIED_KEY, chooseStep, geneSetColumns, highlightColumn, historyApplied, planAnnDataCopy, unwritableName,
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
