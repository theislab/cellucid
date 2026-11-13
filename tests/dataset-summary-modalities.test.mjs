/**
 * An agent opening a CITE-seq `.h5mu` must not say "I have no tool that lists
 * the modalities or their features": `dataset.summary` names the modality
 * shown and every modality as Data mapping › Modality lists them (not the
 * genes of the modality shown only); one modality, nulls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatasetReads } from '../assets/js/app/reads/dataset.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { schemaProblem } from '../assets/js/app/actions/schema.js';

function stateWith(choices) {
  return {
    pointCount: 44,
    cellIdentity: { n: 44, nOriginal: 44, isSubset: false, digest: 'abc' },
    obsData: { fields: [] },
    getVarAxisGeneCount: () => 28,
    getRepresentationChoices: () => [],
    getAvailableVectorFields: () => [],
    getMappingGroupChoices: group => (group === 'modality' ? choices : null),
    getDataMapping: () => ({ modality: 'rna' }),
  };
}

test('a dataset of several modalities names them, and which one the genes come from', () => {
  const reads = createDatasetReads({
    state: stateWith([
      { value: 'prot', label: 'prot · 5 features · 36 of 44 cells', usable: true, reason: null },
      { value: 'rna', label: 'rna · 28 features', usable: true, reason: null },
    ]),
    viewer: {}, dataSourceManager: null,
  });
  const out = reads.summary();
  assert.equal(out.genes.modality, 'rna');
  assert.deepEqual(out.genes.modalities, [
    { name: 'prot', about: 'prot · 5 features · 36 of 44 cells', usable: true, reason: null },
    { name: 'rna', about: 'rna · 28 features', usable: true, reason: null },
  ]);
  assert.equal(schemaProblem(getActionCatalog().get('dataset.summary').result, out), null);
});

test('one modality (or none to choose) is nulls', () => {
  for (const choices of [null, [{ value: 'rna', label: 'rna', usable: true, reason: null }]]) {
    const out = createDatasetReads({ state: stateWith(choices), viewer: {}, dataSourceManager: null }).summary();
    assert.equal(out.genes.modality, null);
    assert.equal(out.genes.modalities, null);
  }
});

// An agent asked to show a 1D embedding must not have to guess obsm keys for mapping_set ("X_umap",
// "UMAP") from a summary that names the embeddings shown by their label only ("UMAP", 2): mapping_set
// and view_embedding_set both name {key, columns}, so a read names a stored array and its columns.
// Every embedding the data mapping offers is listed, on or off, with what those actions take.
test('the summary lists every embedding the data mapping offers, on or off, by the key and columns the actions take', () => {
  const state = {
    ...stateWith(null),
    getRepresentationChoices: () => [
      { ref: { key: 'X_umap_2d', columns: [0, 1] }, enabled: true, isDefault: true, name: 'UMAP', dimension: 2, width: 2, usable: true, reason: null },
      { ref: { key: 'latent_space', columns: [0, 1] }, enabled: false, isDefault: false, name: 'latent_space · 0, 1', dimension: 2, width: 50, usable: true, reason: null },
      { ref: { key: 'X_broken', columns: null }, enabled: false, isDefault: false, name: 'X_broken', dimension: null, width: null, usable: false, reason: 'NaN at cell 17' },
    ],
  };
  const out = createDatasetReads({ state, viewer: {}, dataSourceManager: null }).summary();
  assert.deepEqual(out.embeddings, [
    { name: 'UMAP', dimension: 2, key: 'X_umap_2d', columns: [0, 1], width: 2, enabled: true, usable: true, reason: null },
    { name: 'latent_space · 0, 1', dimension: 2, key: 'latent_space', columns: [0, 1], width: 50, enabled: false, usable: true, reason: null },
    { name: 'X_broken', dimension: null, key: 'X_broken', columns: null, width: null, enabled: false, usable: false, reason: 'NaN at cell 17' },
  ]);
  assert.equal(schemaProblem(getActionCatalog().get('dataset.summary').result, out), null);
});
