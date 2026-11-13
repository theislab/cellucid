/**
 * The field, color, filter and data actions (`assets/js/app/actions/
 * definitions/{fields,coloring,filters,mapping}.js`): their definitions,
 * the parameters they name things by, the pure helpers that convert a data
 * mapping, the category that keeps only some of its cells
 * (`state/managers/category-cell-sample.js`), and the
 * handlers the state alone implements (`state/actions/field-actions.js`)
 * resolving names and refusing with a sentence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getActionCatalog, getActions } from '../assets/js/app/actions/index.js';
import { catalogDocument } from '../assets/js/app/actions/catalog.js';
import { ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { StateValidator } from '../assets/js/app/utils/state-validator.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';
import { exampleOf, schemaProblem } from '../assets/js/app/actions/schema.js';
import { mappingActions, mappingChangesOf, mappingParamsOf } from '../assets/js/app/actions/definitions/mapping.js';
import { COLORMAP_IDS, coloringActions } from '../assets/js/app/actions/definitions/coloring.js';
import { fieldActions } from '../assets/js/app/actions/definitions/fields.js';
import { filterActions } from '../assets/js/app/actions/definitions/filters.js';
import {
  categoryCellLimitAt,
  cellSampleFilterOf,
  withCategoryCellLimit,
} from '../assets/js/app/state/managers/category-cell-sample.js';
import { DataStateFilterMethods, collectViewFilters } from '../assets/js/app/state/managers/filter-manager.js';
import { FieldSummaryMethods } from '../assets/js/app/state/managers/field/summary.js';
import { installFieldActions } from '../assets/js/app/state/actions/field-actions.js';
import { applyCategoryIndexMapping, buildGroupCategoriesTransform, carryCategoryStateThroughGroup } from '../assets/js/app/utils/categorical-ops.js';
import { openCellsValueOf, requestOfOpenCellsValue } from '../assets/js/app/state/domains/cells.js';
import { rankOf } from '../assets/js/data/subsample.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { orderedCellIdentity } from './helpers/ordered-cell-identity.mjs';
import { visibleOf } from './helpers/category-state.mjs';

/** Every action of this area, by type. */
const AREA_TYPES = Object.freeze([
  'category.delete', 'category.merge', 'category.rename',
  'cells.open', 'cells.read-genes',
  'color.by', 'color.category', 'color.continuous.colormap', 'color.continuous.log', 'color.continuous.range',
  'color.continuous.rescale', 'color.continuous.zero-gray', 'expression.transform.set',
  'field.consensus', 'field.create-from-pages', 'field.delete', 'field.duplicate', 'field.group', 'field.purge', 'field.push', 'field.rename',
  'field.restore', 'field.revert-name',
  'filter.category.all', 'filter.category.cell-count', 'filter.category.missing', 'filter.category.visibility',
  'filter.continuous.range', 'filter.continuous.reset', 'filter.enable', 'filter.outlier', 'filter.remove',
  'gene-set.save', 'mapping.set',
]);

/** Every parameter path of a schema, with its schema. */
function parameterPaths(schema, path = 'params') {
  const out = [];
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    out.push([`${path}.${name}`, sub]);
    out.push(...parameterPaths(sub, `${path}.${name}`));
  }
  if (schema.items !== undefined) out.push(...parameterPaths(schema.items, `${path}[]`));
  return out;
}

test('every action of the area is defined once, changes state, and names the domains it touches', () => {
  const catalog = getActionCatalog();
  for (const type of AREA_TYPES) {
    const definition = catalog.get(type);
    assert.notEqual(definition.effect, 'read', `${type} changes state`);
    assert.ok(definition.touches.length > 0, `${type} touches a domain`);
    for (const domain of definition.touches) assert.ok(DOMAIN_IDS.includes(domain), `${type}: ${domain}`);
    assert.equal(definition.confirm, null, `${type} is undone by the history: an agent need not ask first`);
  }
  const listed = [...fieldActions, ...coloringActions, ...filterActions, ...mappingActions].map(definition => definition.type);
  assert.deepEqual(listed.sort(), [...AREA_TYPES].sort(), 'no action of the area is missing from this list');
  // The catalog document is byte-stable.
  assert.equal(JSON.stringify(catalogDocument(catalog)), JSON.stringify(catalogDocument(getActionCatalog())));
});

test('every example parameter set is valid and is described in one line, past tense, with one line of pseudocode', () => {
  const catalog = getActionCatalog();
  for (const type of AREA_TYPES) {
    const definition = catalog.get(type);
    const example = exampleOf(definition.params);
    assert.equal(schemaProblem(definition.params, example), null, `${type} example ${JSON.stringify(example)}`);
    for (const [label, text] of [['describe', definition.describe(example, null)], ['code', definition.code(example)]]) {
      assert.equal(typeof text, 'string', `${type} ${label}`);
      assert.ok(text.length > 0 && !text.includes('\n') && text.trim() === text, `${type} ${label}: ${JSON.stringify(text)}`);
    }
  }
  assert.equal(catalog.get('color.by').describe({ field: { source: 'var', key: 'CD3E' } }, null), 'Colored by gene CD3E');
  assert.equal(catalog.get('color.by').code({ field: { source: 'obs', key: 'cell_type' } }), 'color_by("cell_type")');
  assert.equal(catalog.get('color.by').describe({ field: null }, null), 'Cleared the coloring');
  assert.equal(
    catalog.get('filter.category.visibility').describe({ field: { source: 'obs', key: 'leiden' }, categories: ['1', '2', '5'], visible: false }, null),
    'Hid 1, 2 and 5 of leiden',
  );
  assert.equal(
    catalog.get('filter.category.cell-count').describe({ field: { source: 'obs', key: 'cell_type' }, category: 'T cells', count: 1, seed: 0 }, null),
    'Kept 1 cell of T cells in cell_type',
  );
  assert.equal(catalog.get('mapping.set').describe({ expression: 'raw', gene_names: 'column:symbol' }, null),
    'Changed the data mapping: gene names, expression');
});

test('a step names fields, categories, genes and pages, never a position', () => {
  for (const type of AREA_TYPES) {
    for (const [path] of parameterPaths(getActionCatalog().get(type).params)) {
      assert.doesNotMatch(path, /index|position|Idx|_id\b|Id\b/i, `${type}: ${path}`);
    }
  }
  // A field is {source, key}; a category its label; color maps by id.
  const params = getActionCatalog().get('color.category').params;
  assert.deepEqual(params.properties.field.required, ['source', 'key']);
  assert.equal(params.properties.category.type, 'string');
  assert.deepEqual(getActionCatalog().get('color.continuous.colormap').params.properties.colormap.enum, [...COLORMAP_IDS]);
});

test('choosing a field supersedes one still being read; drags are one step', () => {
  const catalog = getActionCatalog();
  assert.equal(catalog.get('color.by').supersede, true);
  const field = { source: 'obs', key: 'score' };
  assert.equal(catalog.get('filter.continuous.range').coalesce({ field, min: 0, max: 1 }),
    catalog.get('filter.continuous.range').coalesce({ field, min: 0.5, max: 0.9 }));
  assert.notEqual(catalog.get('color.category').coalesce({ field, category: 'a', color: '#000000' }),
    catalog.get('color.category').coalesce({ field, category: 'b', color: '#000000' }));
  assert.equal(catalog.get('filter.outlier').coalesce({ field, threshold: 0.5 }), catalog.get('filter.outlier').coalesce({ field, threshold: 0.2 }));
  // Per-cell arrays are accepted as the binary frames carry them.
  const push = catalog.get('field.push').params;
  assert.equal(schemaProblem(push, { key: 'k', kind: 'continuous', categories: null, n_obs: 3, cells: Uint32Array.of(0, 2), values: Float32Array.of(1, 2) }), null);
  assert.equal(schemaProblem(push, { key: 'k', kind: 'categorical', categories: ['a'], n_obs: 3, cells: null, values: [0, 0, 255] }), null);
  assert.match(schemaProblem(push, { key: 'k', kind: 'continuous', categories: null, n_obs: 3, cells: null, values: 'x' }), /values must be array/);
});

test('a mapping step names only the groups it changes; log1p is a list there', () => {
  const current = {
    kind: 'anndata',
    embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
    knn: null, geneNames: 'index', expression: 'X', log1p: {}, highlyVariable: null, latent: null, vectorFields: [],
  };
  const next = { ...current, expression: 'raw', log1p: { raw: { base: null }, 'layer:counts': { base: 2 } } };
  const params = mappingParamsOf(current, next);
  assert.deepEqual(params, { expression: 'raw', log1p: [{ matrix: 'raw', base: null }, { matrix: 'layer:counts', base: 2 }] });
  assert.equal(schemaProblem(getActionCatalog().get('mapping.set').params, params), null);
  assert.deepEqual(mappingChangesOf(params), { expression: 'raw', log1p: { raw: { base: null }, 'layer:counts': { base: 2 } } });
  assert.deepEqual(mappingParamsOf(current, current), {});
  assert.deepEqual(mappingChangesOf({ gene_names: 'column:symbol', highly_variable: null }), { geneNames: 'column:symbol', highlyVariable: null });
});

/** Twelve cells of category 0 among twenty, open in the order an identity gives. */
function sampledField() {
  const codes = Uint8Array.from({ length: 20 }, (_, i) => (i % 5 === 4 ? 1 : i < 15 ? 0 : 2));
  return { kind: 'category', key: 'cell_type', categories: ['T cells', 'B cells', 'NK'], codes };
}

function keptOriginals(filter, identity, category, codes) {
  const out = [];
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === category && (filter.bits[i >>> 3] & (1 << (i & 7))) !== 0) out.push(identity.originalAt(i));
  }
  return out.sort((a, b) => a - b);
}

test('a category keeping N cells keeps exactly the N of its open cells with the lowest rank, whatever order they are open in', () => {
  const field = sampledField();
  const inOrder = createCellIdentity({ nObs: 20 });
  const members = [...field.codes.keys()].filter(i => field.codes[i] === 0);
  assert.equal(members.length, 12);
  withCategoryCellLimit(field, 0, { count: 5, seed: 7 });
  const filter = cellSampleFilterOf(field, inOrder);
  const expected = [...members].sort((a, b) => rankOf(7, a) - rankOf(7, b)).slice(0, 5).sort((a, b) => a - b);
  assert.deepEqual(keptOriginals(filter, inOrder, 0, field.codes), expected);
  assert.deepEqual([...filter.limited], [1, 0, 0], 'only the limited category is limited');
  assert.equal(cellSampleFilterOf(field, inOrder), filter, 'made once per limits, codes and open cells');

  // Open in another order (a priority-ordered file): the same cells by original position.
  const shuffled = orderedCellIdentity({ nObs: 20 });
  const reordered = { ...sampledField(), codes: Uint8Array.from({ length: 20 }, (_, i) => field.codes[shuffled.originalAt(i)]) };
  withCategoryCellLimit(reordered, 0, { count: 5, seed: 7 });
  assert.deepEqual(keptOriginals(cellSampleFilterOf(reordered, shuffled), shuffled, 0, reordered.codes), expected);

  // A larger count keeps every cell a smaller one kept; another seed, other cells.
  withCategoryCellLimit(field, 0, { count: 8, seed: 7 });
  const larger = keptOriginals(cellSampleFilterOf(field, inOrder), inOrder, 0, field.codes);
  assert.equal(larger.length, 8);
  assert.ok(expected.every(cell => larger.includes(cell)), 'nested');
  withCategoryCellLimit(field, 0, { count: 5, seed: 8 });
  assert.notDeepEqual(keptOriginals(cellSampleFilterOf(field, inOrder), inOrder, 0, field.codes), expected);

  // At or above the category's cells: nothing is limited; 0 keeps none.
  withCategoryCellLimit(field, 0, { count: 12, seed: 7 });
  assert.equal(cellSampleFilterOf(field, inOrder), null);
  withCategoryCellLimit(field, 0, { count: 0, seed: 7 });
  assert.deepEqual(keptOriginals(cellSampleFilterOf(field, inOrder), inOrder, 0, field.codes), []);
  withCategoryCellLimit(field, 0, null);
  assert.equal(field._categoryCellLimits, undefined, 'no list is left when no limit is');
  assert.throws(() => withCategoryCellLimit(field, 3, { count: 1, seed: 0 }), /names a category/);
  assert.throws(() => withCategoryCellLimit(field, 0, { count: -1, seed: 0 }), /whole number/);
});

/** A state with the filter methods over one categorical and one continuous field (as the filter tests build it). */
function filterState() {
  const cluster = { ...sampledField(), _categoryVisible: visibleOf([true, true, true]), _categoryFilterEnabled: true };
  const score = { kind: 'continuous', key: 'score', values: Float32Array.from({ length: 20 }, (_, i) => i) };
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount: 20,
    cellIdentity: createCellIdentity({ nObs: 20 }),
    obsData: { fields: [cluster, score] },
    varData: { fields: [] },
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    activeVarFieldIndex: -1,
    categoryTransparency: new Uint8Array(20).fill(1),
    cellVisibilityMask: new Uint8Array(20).fill(1),
    colorsArray: new Uint8Array(80).fill(255),
    events: [],
    ensureCategoryMetadata() {},
    ensureContinuousMetadata(field) {
      return { stats: field._continuousStats, filter: field._continuousFilter };
    },
    getActiveField() { return this.obsData.fields[this.activeFieldIndex]; },
    getFields() { return this.obsData.fields; },
    getVarFields() { return this.varData.fields; },
    async ensureFieldLoaded() {},
    _reapplyCategoryColorsNoRecompute() {},
    _updateActiveCategoryCounts: () => false,
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _syncActiveContext() {},
    updateFilteredCount() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
    emit(name, detail) { this.events.push([name, detail]); },
  });
  for (const key of Object.getOwnPropertyNames(FieldSummaryMethods.prototype)) {
    if (key !== 'constructor' && key !== 'updateFilteredCount') state[key] = FieldSummaryMethods.prototype[key];
  }
  return { state, cluster };
}

test('the visibility pass shows N cells of a limited category and every cell of the others; Active filters says so', () => {
  const { state, cluster } = filterState();
  state.setCategoryCellLimit(cluster, 0, { count: 3, seed: 0 });
  const shown = [...state.categoryTransparency.keys()].filter(i => state.categoryTransparency[i] === 1);
  const shownOf = code => shown.filter(i => cluster.codes[i] === code).length;
  assert.equal(shownOf(0), 3);
  assert.equal(shownOf(1), 4);
  assert.equal(shownOf(2), 4);
  assert.equal(state.filteredCount.shown, 11);
  assert.deepEqual(collectViewFilters(state).map(filter => filter.text), ['cell_type: keeping 3 of T cells']);
  // With a category hidden too, both apply; turned off, neither does.
  state.setVisibilityForCategory(cluster, 1, false);
  assert.equal(state.filteredCount.shown, 7);
  assert.deepEqual(collectViewFilters(state).map(filter => filter.text), ['cell_type: hiding B cells; keeping 3 of T cells']);
  state.toggleFilterEnabled('obs-category-0', false);
  assert.equal(state.filteredCount.shown, 20);
  state.toggleFilterEnabled('obs-category-0', true);
  assert.equal(state.filteredCount.shown, 7);
  // The counts read the same cells: 3 of the 12 T cells shown.
  const counts = state.computeCategoryCountsForField(cluster);
  assert.equal(counts.visible[0], 3);
  assert.equal(counts.available[0], 12);
  // Removing the field's category filter shows every cell and drops the limit.
  state.removeFilter('obs-category-0');
  assert.equal(state.filteredCount.shown, 20);
  assert.equal(categoryCellLimitAt(cluster, 0), null);
  // Show all and hide all drop every limit too.
  state.setCategoryCellLimit(cluster, 2, { count: 1, seed: 0 });
  assert.equal(state.filteredCount.shown, 17);
  cluster._categoryCounts = { available: [12, 4, 4] };
  state.showAllCategories(cluster, { onlyAvailable: true });
  assert.equal(state.filteredCount.shown, 20);
  assert.equal(cluster._categoryCellLimits, undefined);
});

test('the field actions resolve names, refuse with a sentence, and change only what they name', async t => {
  const { state, cluster } = filterState();
  const remove = installFieldActions({ state });
  t.after(remove);
  const actions = getActions();
  const field = { source: 'obs', key: 'cell_type' };

  await actions.dispatch('filter.category.visibility', { field, categories: ['B cells', 'NK'], visible: false });
  assert.deepEqual([...cluster._categoryVisible], [1, 0, 0]);
  await assert.rejects(
    actions.dispatch('filter.category.visibility', { field, categories: ['Monocytes'], visible: false }),
    error => error instanceof ActionRefused
      && error.message === 'There is no category "Monocytes" in "cell_type"; the categories are "T cells", "B cells" and "NK".',
  );
  await assert.rejects(
    actions.dispatch('filter.category.visibility', { field: { source: 'obs', key: 'leiden' }, categories: ['1'], visible: false }),
    /There is no field "leiden"; the fields are "cell_type" and "score"\./,
  );
  await assert.rejects(
    actions.dispatch('filter.category.visibility', { field: { source: 'obs', key: 'score' }, categories: ['1'], visible: false }),
    /"score" is a continuous field, not a categorical one\./,
  );
  const { outcome } = await actions.dispatch('filter.category.cell-count', { field, category: 'T cells', count: 4, seed: 9 });
  assert.deepEqual(outcome, { count: 4 });
  assert.deepEqual(categoryCellLimitAt(cluster, 0), { category: 0, count: 4, seed: 9 });
  // The seed is the default's when not given, and the same limit again changes nothing.
  assert.deepEqual((await actions.dispatch('filter.category.cell-count', { field, category: 'T cells', count: 4, seed: 9 })).outcome, null);
  await actions.dispatch('filter.category.cell-count', { field, category: 'T cells', count: 2 });
  assert.deepEqual(categoryCellLimitAt(cluster, 0), { category: 0, count: 2, seed: 0 });
  await actions.dispatch('filter.category.cell-count', { field, category: 'T cells', count: null });
  assert.equal(categoryCellLimitAt(cluster, 0), null);
  await actions.dispatch('filter.category.missing', { field, visible: false });
  assert.equal(cluster._missingVisible, false);

  // A filter turned off or removed by the field's name and the filter's kind.
  await actions.dispatch('filter.enable', { field, kind: 'category', enabled: false });
  assert.equal(cluster._categoryFilterEnabled, false);
  await assert.rejects(actions.dispatch('filter.remove', { field, kind: 'outlier' }), /"cell_type" has no outlier filter; it has "category"\./);
  await actions.dispatch('filter.remove', { field, kind: 'category' });
  assert.deepEqual([...cluster._categoryVisible], [1, 1, 1]);
  assert.equal(cluster._missingVisible, true);
});

test('the consensus column is a step that names the outcome of each category: its codes derived from its column, by name', async t => {
  // A locally renamed column and category: the step names them as shown, the column keeps the dataset's names.
  const source = {
    kind: 'category', key: 'Cell type', _originalKey: 'cell_type',
    categories: ['T', 'B', 'NK'], _originalCategories: ['T', 'B', 'nk'],
    codes: Uint8Array.from([0, 1, 255, 2]), loaded: true,
  };
  const upserts = [];
  const state = {
    pointCount: 4,
    cellIdentity: createCellIdentity({ nObs: 4 }),
    getFields: () => [source],
    getVarFields: () => [],
    ensureFieldLoaded: async () => {},
    upsertUserDefinedCategoricalField(options) {
      upserts.push(options);
      return { fieldIndex: 1, key: options.key, updatedInPlace: upserts.length > 1 };
    },
  };
  const remove = installFieldActions({ state });
  t.after(remove);
  const actions = getActions();
  const params = {
    key: 'community_cell_type',
    field: { source: 'obs', key: 'Cell type' },
    mapping: [
      { category: 'T', status: 'consensus', label: 'T cell', voters: 3 },
      { category: 'B', status: 'disputed', label: null, voters: 2 },
    ],
    settings: { minAnnotators: 2, threshold: 0.5 },
    provenance: { repository: 'lab/annotations', branch: 'main', commit: null, pulledAt: '2026-11-05T10:00:00.000Z' },
  };
  const first = await actions.dispatch('field.consensus', params);
  assert.deepEqual(first.outcome, { name: 'community_cell_type', of: 'Cell type', replaced: false });
  // NK is left out of the mapping: pending, as is the cell with no category.
  assert.deepEqual(upserts[0].categories, ['T cell', 'Disputed', 'Pending']);
  assert.deepEqual([...upserts[0].codes], [0, 1, 2, 2]);
  assert.deepEqual(upserts[0].meta, {
    _sourceField: { kind: 'community-annotation', sourceKey: 'cell_type', sourceIndex: 0 },
    _operation: {
      type: 'community-consensus',
      fieldKey: 'cell_type',
      outcomes: [
        { category: 'T', status: 'consensus', label: 'T cell' },
        { category: 'B', status: 'disputed', label: null },
        { category: 'nk', status: 'pending', label: null },
      ],
      settings: { minAnnotators: 2, threshold: 0.5 },
      provenance: params.provenance,
    },
  });
  assert.equal((await actions.dispatch('field.consensus', params)).outcome.replaced, true);
  // Named, never placed: a category the column does not have is refused with the names it has.
  const missing = await actions.dispatch('field.consensus', { ...params, mapping: [{ category: 'Mono', status: 'pending', label: null, voters: 0 }] })
    .then(() => null, error => error);
  assert.ok(missing instanceof ActionRefused);
  assert.match(missing.message, /Mono/);
  await assert.rejects(
    actions.dispatch('field.consensus', { ...params, field: { source: 'obs', key: 'leiden' } }),
    /There is no field "leiden"; the fields are "Cell type"\./,
  );
  await assert.rejects(
    actions.dispatch('field.consensus', { ...params, mapping: [{ category: 'T', status: 'pending', label: 'T cell', voters: 1 }] }),
    /names a label only when its status is consensus/,
  );
  await assert.rejects(
    actions.dispatch('field.consensus', { ...params, mapping: [params.mapping[0], params.mapping[0]] }),
    /"T" is given two outcomes/,
  );
  assert.equal(upserts.length, 2, 'a refused build changes nothing');
  const definition = getActionCatalog().get('field.consensus');
  assert.equal(definition.version, 2);
  assert.equal(definition.describe(params, null), 'Built the consensus column community_cell_type of Cell type');
  assert.equal(definition.code(params), 'consensus_column("community_cell_type", of="Cell type", mapping={"T": "T cell", "B": "disputed"})');
});

test('grouping categories is one step making a new field of groups; a category no group lists keeps its name or joins rest', async t => {
  const source = {
    kind: 'category', key: 'clusters', categories: ['Ductal', 'Ngn3 low EP', 'Alpha', 'Beta', 'Delta'],
    codes: Uint8Array.from([0, 1, 2, 3, 4, 255, 2]), loaded: true,
  };
  const grouped = [];
  const fields = [source, { kind: 'category', key: 'clusters (grouped)', categories: ['x'], codes: new Uint8Array(7), loaded: true }];
  const state = {
    pointCount: 7,
    getFields: () => fields,
    getVarFields: () => [],
    ensureFieldLoaded: async () => {},
    groupCategoriesToNewField(fieldIndex, options) {
      grouped.push({ fieldIndex, options });
      return { newFieldIndex: 2, newKey: options.newKey, categories: options.groups.length + 1 };
    },
  };
  const remove = installFieldActions({ state });
  t.after(remove);
  const actions = getActions();
  const field = { source: 'obs', key: 'clusters' };
  const lineage = [{ label: 'Progenitor', categories: ['Ductal', 'Ngn3 low EP'] }, { label: 'Endocrine', categories: ['Alpha', 'Beta'] }];
  const { outcome } = await actions.dispatch('field.group', { field, groups: lineage });
  // The default name is free beside the fields there are; Delta, listed by no group, keeps its name.
  assert.deepEqual(outcome, { name: 'clusters (grouped) 2', categories: 3, kept: 1 });
  assert.deepEqual(grouped[0], {
    fieldIndex: 0,
    options: { groups: [{ label: 'Progenitor', members: [0, 1] }, { label: 'Endocrine', members: [2, 3] }], restLabel: null, newKey: 'clusters (grouped) 2' },
  });
  await actions.dispatch('field.group', { field, groups: lineage, rest: 'Other', name: 'lineage' });
  assert.deepEqual(grouped[1].options.restLabel, 'Other');
  assert.equal(grouped[1].options.newKey, 'lineage');
  const refused = async (params, pattern) => {
    await assert.rejects(actions.dispatch('field.group', { field, ...params }), error => error instanceof ActionRefused && pattern.test(error.message));
  };
  await refused({ groups: [{ label: 'A', categories: ['Ductal'] }, { label: 'B', categories: ['Ductal'] }] }, /^"Ductal" is listed in "A" and "B"; a category joins one group\.$/);
  await refused({ groups: [{ label: 'A', categories: ['Ductal'] }, { label: 'A', categories: ['Beta'] }] }, /^Two groups are called "A"; give each its own label\.$/);
  await refused({ groups: [{ label: 'Delta', categories: ['Alpha'] }] }, /^"Delta" is kept as it is \(no group lists it\), and a group is called "Delta": list it in that group, or call the group otherwise\.$/);
  await refused({ groups: [{ label: ' A', categories: ['Alpha'] }] }, /starts or ends with a space/);
  await refused({ groups: [{ label: 'A', categories: ['Acinar'] }] }, /There is no category "Acinar" in "clusters"/);
  await refused({ groups: lineage, name: 'clusters' }, /clusters/);
  assert.equal(grouped.length, 2, 'a refused grouping changes nothing');
  // Joining a group's own label is a grouping too: every other category into Endocrine.
  await actions.dispatch('field.group', { field, groups: lineage, rest: 'Endocrine', name: 'two' });
  assert.equal(grouped[2].options.restLabel, 'Endocrine');
  const definition = getActionCatalog().get('field.group');
  assert.equal(definition.describe({ field, groups: lineage, rest: null }, { name: 'lineage' }), 'Grouped clusters into Progenitor and Endocrine as lineage');
  assert.equal(definition.describe({ field, groups: lineage, rest: 'Other' }, null), 'Grouped clusters into Progenitor, Endocrine and Other as clusters (grouped)');
  // The rest joins a group it names: listed once.
  assert.equal(definition.describe({ field, groups: lineage, rest: 'Endocrine' }, null), 'Grouped clusters into Progenitor and Endocrine as clusters (grouped)');
  // Past three, the groups are counted as groups ("into 4 groups and non-epithelial", not "into 4 categories ...").
  const four = ['airway', 'distal tip', 'stalk', 'alveolar'].map(label => ({ label, categories: [label] }));
  assert.equal(definition.describe({ field, groups: four, rest: 'non-epithelial', name: 'compartment' }, { name: 'compartment' }), 'Grouped clusters into 4 groups and non-epithelial as compartment');
  assert.equal(definition.code({ field, groups: lineage, rest: null, name: 'lineage' }),
    'group_categories("clusters", {"Progenitor": ["Ductal", "Ngn3 low EP"], "Endocrine": ["Alpha", "Beta"]}, name="lineage")');
});

test('the grouping of categories: codes by group, the others kept or joined, each new category colored as its first and shown while any was', () => {
  const categories = ['Ductal', 'Ngn3 low EP', 'Alpha', 'Beta', 'Delta'];
  const groups = [{ label: 'Endocrine', members: [3, 2] }, { label: 'Progenitor', members: [0, 1] }];
  const kept = buildGroupCategoriesTransform(categories, groups, null);
  assert.deepEqual(kept.categories, ['Endocrine', 'Progenitor', 'Delta']);
  assert.deepEqual([...kept.mapping], [1, 1, 0, 0, 2]);
  assert.deepEqual([...kept.firstOf], [3, 0, 4]);
  const codes = applyCategoryIndexMapping(Uint8Array.from([0, 1, 2, 3, 4, 255]), kept.mapping, kept.categories.length);
  assert.deepEqual([...codes], [1, 1, 0, 0, 2, 255]);
  const rest = buildGroupCategoriesTransform(categories, [{ label: 'Endocrine', members: [2, 3] }], 'Other');
  assert.deepEqual(rest.categories, ['Endocrine', 'Other']);
  assert.deepEqual([...rest.mapping], [1, 1, 0, 0, 1]);
  const intoGroup = buildGroupCategoriesTransform(categories, [{ label: 'Endocrine', members: [2, 3] }], 'Endocrine');
  assert.deepEqual(intoGroup.categories, ['Endocrine']);
  assert.deepEqual(intoGroup.membersOf, [[2, 3, 0, 1, 4]]);
  assert.throws(() => buildGroupCategoriesTransform(categories, [{ label: 'A', members: [0] }, { label: 'B', members: [0] }], null), /in two groups/);
  assert.throws(() => buildGroupCategoriesTransform(categories, [{ label: 'Delta', members: [0] }], null), /kept under a label a group takes/);
  // Colors (each told apart from the others): Endocrine as Beta (its first), Progenitor
  // as Ductal, Delta its own; shown while any of its categories was.
  const colors = Uint8Array.of(230, 25, 75, 60, 180, 75, 255, 225, 25, 0, 130, 200, 245, 130, 48);
  const visible = Uint8Array.from([0, 1, 0, 0, 1]);
  const carried = carryCategoryStateThroughGroup(kept, { colors, visible });
  assert.deepEqual([...carried.colors], [0, 130, 200, 230, 25, 75, 245, 130, 48]);
  assert.deepEqual([...carried.visible], [0, 1, 1]);
});

test('the open cells as the cells domain names them: the subsample asked for, never a step of its growth', () => {
  assert.equal(openCellsValueOf({ nObs: 100, kept: null, spec: null }), null);
  const spec = Object.freeze({ method: 'uniform', nObs: 100, k: 20, seed: 3 });
  assert.deepEqual(openCellsValueOf({ nObs: 100, kept: Uint32Array.of(1, 2), spec }), { method: 'uniform', k: 20, seed: 3 });
  // Growing toward 40 cells: the share it grows to; toward every cell: every cell.
  assert.deepEqual(openCellsValueOf({ nObs: 100, kept: Uint32Array.of(1), spec, chunks: { target: 40 } }).k, 40);
  assert.equal(openCellsValueOf({ nObs: 100, kept: Uint32Array.of(1), spec, chunks: { target: 100 } }), null);
  assert.deepEqual(requestOfOpenCellsValue({ method: 'blocks', k: 20, seed: 0, blockSize: 64 }),
    { mode: 'subsample', method: 'blocks', k: 20, seed: 0, blockSize: 64, strict: true });
});

// A rename to "Alpha\nnewline" (an agent's call; the legend's box trims and is one line) would be drawn
// by the legend on two lines and could not be keyed by the community annotation. One rule for a
// category label given now, in every action that takes one: rename, merge, group, Create categorical.
test('a category label given now is one line with no space at its ends, in every action that takes one', async t => {
  const source = {
    kind: 'category', key: 'clusters', categories: ['Ductal', 'Alpha', 'Beta'],
    codes: Uint8Array.from([0, 1, 2, 1]), loaded: true,
  };
  const fields = [source];
  const changed = [];
  const state = {
    pointCount: 4,
    getFields: () => fields,
    getVarFields: () => [],
    ensureFieldLoaded: async () => {},
    renameCategory: (...args) => changed.push(['rename', ...args]),
    mergeCategoriesToNewField: (...args) => { changed.push(['merge', ...args]); return { newKey: 'clusters', mergedCategoryLabel: 'x', updatedInPlace: false }; },
    groupCategoriesToNewField: (...args) => { changed.push(['group', ...args]); return { newFieldIndex: 1, newKey: 'g', categories: 2 }; },
  };
  const remove = installFieldActions({ state });
  t.after(remove);
  const actions = getActions();
  const field = { source: 'obs', key: 'clusters' };
  const refusedAs = async (type, params, pattern) => {
    await assert.rejects(actions.dispatch(type, { field, ...params }), error => {
      assert.ok(error instanceof ActionRefused, String(error));
      assert.equal(error.code, 'bad-name');
      assert.match(error.message, pattern);
      return true;
    });
  };
  await refusedAs('category.rename', { category: 'Alpha', name: 'Alpha\nnewline' }, /^"Alpha\nnewline" cannot be a category label: it holds the control character U\+000A/);
  await refusedAs('category.rename', { category: 'Alpha', name: '  padded  ' }, /it starts or ends with a space; give it without\.$/);
  await refusedAs('category.rename', { category: 'Alpha', name: 'Al​pha' }, /zero-width character U\+200B/);
  await refusedAs('category.merge', { category: 'Alpha', into: 'Beta', label: 'Alpha\tBeta' }, /control character U\+0009/);
  await refusedAs('field.group', { groups: [{ label: 'Endo\ncrine', categories: ['Alpha'] }] }, /control character U\+000A/);
  await refusedAs('field.group', { groups: [{ label: 'Endocrine', categories: ['Alpha'] }], rest: ' Other' }, /starts or ends with a space/);
  assert.deepEqual(changed, [], 'a refused label changes nothing');
  // Text of any script, punctuation and emoji is a label.
  await actions.dispatch('category.rename', { field, category: 'Alpha', name: 'α-Zelle, "core" 🧬' });
  assert.deepEqual([changed[0][0], changed[0].at(-1)], ['rename', 'α-Zelle, "core" 🧬']);
  assert.throws(() => StateValidator.validateNewCategoryLabel(''), /non-empty/);
  assert.equal(StateValidator.validateCategoryLabel('read\nas it is'), true, 'a label a dataset brings is read as it is');
});

test('a color map step names the palette as the legend does', () => {
  const definition = getActionCatalog().get('color.continuous.colormap');
  const field = { source: 'var', key: 'Ins1' };
  assert.equal(definition.describe({ field, colormap: 'plasma' }), 'Drew gene Ins1 in Plasma');
  assert.equal(definition.describe({ field, colormap: 'rdbu' }).endsWith(' in RdBu'), true);
});

test('a range step writes its bounds as the Filters list does, not as float32 widened to double', () => {
  const catalog = getActionCatalog();
  const field = { source: 'obs', key: 'G2M_score' };
  const min = Math.fround(-0.4487030208);
  assert.equal(catalog.get('filter.continuous.range').describe({ field, min, max: -0.072 }), 'Showed G2M_score from -0.448703 to -0.072');
  assert.equal(catalog.get('color.continuous.range').describe({ field, min, max: 1500 }), 'Spanned the colors of G2M_score over -0.448703 – 1500');
  // The pseudocode keeps the exact bound.
  assert.match(catalog.get('filter.continuous.range').code({ field, min, max: -0.072 }), /-0\.44870302081108093/);
});
