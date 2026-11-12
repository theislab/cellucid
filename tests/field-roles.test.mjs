/**
 * What a categorical field reads as, from its name (`app/utils/field-roles.js`),
 * and the coloring a dataset opens with when nothing chose one
 * (`app/first-coloring.js`; bug hunt F21, owner 2026-11-10).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { colorByFirstField } from '../assets/js/app/first-coloring.js';
import { defaultCellTypeField, defaultSampleField } from '../assets/js/app/analysis/options/composition-options.js';
import {
  firstColoringCandidates,
  identityField,
  isNeverFirstColoring,
  modestCategoryCount,
  normalizedFieldName,
  sampleField,
} from '../assets/js/app/utils/field-roles.js';
import { getCategoryColorSeedCount } from '../assets/js/data/palettes.js';

const unread = keys => keys.map(key => ({ key, categoryCount: null }));
const order = keys => firstColoringCandidates(unread(keys)).map(field => field.key);

test('one spelling for every naming convention', () => {
  for (const key of ['cell_type', 'Cell Type', 'cell.type', 'CellType', 'cell-type', '__cell_type__']) {
    assert.equal(normalizedFieldName(key), 'cell_type', key);
  }
  assert.equal(normalizedFieldName('RNA_snn_res.0.8'), 'rna_snn_res_0_8');
});

test('cell types first, then annotations, lineages, clusters, tissue, condition, cell cycle', () => {
  assert.deepEqual(
    order(['phase', 'condition', 'tissue', 'leiden', 'compartment', 'free_annotation', 'author_cell_type', 'cell_type']),
    ['cell_type', 'author_cell_type', 'free_annotation', 'compartment', 'leiden', 'tissue', 'condition', 'phase'],
  );
});

test('the wide conventions are recognised: CELLxGENE, Seurat and Azimuth, HLCA, Tabula Sapiens, CellTypist, SingleR, scanpy', () => {
  assert.deepEqual(order(['donor_id', 'assay', 'cell_type_ontology_term_id', 'is_primary_data', 'cell_type'])[0], 'cell_type');
  assert.deepEqual(
    order(['orig.ident', 'seurat_clusters', 'predicted.celltype.l1', 'predicted.celltype.l3', 'predicted.celltype.l2']),
    ['predicted.celltype.l2', 'predicted.celltype.l1', 'predicted.celltype.l3', 'seurat_clusters'],
    'the second level of a hierarchy reads best, then the first, then deeper',
  );
  assert.deepEqual(order(['ann_level_3', 'ann_level_1', 'ann_level_2']), ['ann_level_2', 'ann_level_1', 'ann_level_3']);
  assert.equal(order(['method', 'cell_ontology_class', 'free_annotation'])[0], 'cell_ontology_class');
  assert.equal(order(['majority_voting', 'leiden'])[0], 'majority_voting');
  assert.equal(order(['pruned.labels', 'louvain'])[0], 'pruned.labels');
  assert.equal(order(['RNA_snn_res.0.8', 'Phase'])[0], 'RNA_snn_res.0.8');
  assert.equal(order(['louvain', 'n_counts_bin'])[0], 'louvain');
  assert.equal(order(['CellType', 'leiden'])[0], 'CellType');
});

test('never first: samples and their kin, ids and barcodes, quality flags', () => {
  for (const key of [
    'sample', 'sample_id', 'donor', 'donor_id', 'patient', 'individual', 'subject', 'orig.ident', 'library',
    'batch', 'plate', 'well', 'lane', 'replicate', 'dataset', 'assay', 'suspension_type',
    'barcode', 'cell_id', 'obs_names', 'cell_type_ontology_term_id',
    'predicted_doublet', 'doublet', 'is_primary_data', 'pass_qc', 'outlier', 'keep_cell',
  ]) {
    assert.equal(isNeverFirstColoring(key), true, key);
  }
  for (const key of ['cell_type', 'leiden', 'tissue', 'organism', 'sex', 'disease']) {
    assert.equal(isNeverFirstColoring(key), false, key);
  }
  assert.deepEqual(order(['batch', 'sample', 'donor', 'barcode']), []);
});

test('a field only its order recommends opens with 2 to the palette\'s designed colors', () => {
  assert.equal(modestCategoryCount(), getCategoryColorSeedCount());
  const fields = [
    { key: 'sex', categoryCount: 1 },
    { key: 'clone', categoryCount: modestCategoryCount() + 1 },
    { key: 'sex2', categoryCount: 2 },
    { key: 'other', categoryCount: null },
  ];
  assert.deepEqual(firstColoringCandidates(fields).map(field => [field.key, field.ranked]), [['sex2', false], ['other', false]]);
  // A ranked name opens at any size above one category.
  assert.deepEqual(
    firstColoringCandidates([{ key: 'cell_type', categoryCount: 400 }, { key: 'cluster', categoryCount: 1 }]).map(f => f.key),
    ['cell_type'],
  );
});

test('the analyses default to the same ranks', () => {
  const categoricalFields = unread(['batch', 'donor', 'sample', 'tissue', 'leiden', 'cell_type']);
  assert.equal(defaultCellTypeField({ categoricalFields, colorField: null }), 'cell_type');
  assert.equal(defaultCellTypeField({ categoricalFields, colorField: 'tissue' }), 'tissue', 'the coloring field');
  assert.equal(defaultCellTypeField({ categoricalFields, colorField: 'donor' }), 'cell_type', 'never a sample');
  assert.equal(defaultSampleField({ categoricalFields, colorField: null }), 'donor', 'the person before the sample and the batch');
  assert.equal(identityField(unread(['batch', 'tissue'])), 'tissue');
  assert.equal(identityField(unread(['batch'])), 'batch', 'the first, when that is all there is');
  assert.equal(sampleField(unread(['batch', 'library_id', 'sample']), 'sample'), 'library_id');
});

function fakeState(fields) {
  const loaded = [];
  return {
    loaded,
    activeFieldSource: null,
    obsData: { fields },
    async ensureFieldLoaded(index) {
      loaded.push(fields[index].key);
      return { ...fields[index], categories: fields[index].read };
    },
  };
}

test('a dataset with no coloring opens colored by its best field, read only when its order alone recommends it', async () => {
  const signal = new AbortController().signal;
  const shown = [];
  const activateField = async index => { shown.push(index); };
  const named = fakeState([
    { key: 'score', kind: 'continuous' },
    { key: 'batch', kind: 'category', categoryCount: null },
    { key: 'cell_type', kind: 'category', categoryCount: null },
  ]);
  assert.equal(await colorByFirstField({ state: named, activateField, signal }), 'cell_type');
  assert.deepEqual(shown, [2]);
  assert.deepEqual(named.loaded, [], 'a ranked name is not read to be counted');

  shown.length = 0;
  const unnamed = fakeState([
    { key: 'barcodes_group', kind: 'category', categoryCount: null, read: Array.from({ length: 5000 }, (_, i) => String(i)) },
    { key: 'deleted', kind: 'category', categoryCount: 3, _isDeleted: true },
    { key: 'sex', kind: 'category', categoryCount: null, read: ['f', 'm'] },
  ]);
  assert.equal(await colorByFirstField({ state: unnamed, activateField, signal }), 'sex');
  assert.deepEqual(unnamed.loaded, ['barcodes_group', 'sex'], 'too many categories: the next');
  assert.deepEqual(shown, [2]);

  shown.length = 0;
  const chosen = { ...fakeState([{ key: 'cell_type', kind: 'category', categoryCount: null }]), activeFieldSource: 'obs' };
  assert.equal(await colorByFirstField({ state: chosen, activateField, signal }), null, 'a coloring already shown stays');
  assert.equal(await colorByFirstField({ state: fakeState([{ key: 'donor', kind: 'category', categoryCount: 4 }]), activateField, signal }), null);
  assert.deepEqual(shown, []);
});
