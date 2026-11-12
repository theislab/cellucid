/**
 * Gene names and highly variable genes are columns of the var axis of their
 * mapping's expression matrix (`var` for X and every layer, `raw.var` for
 * raw), and every expression group is its modality's. A value is usable or
 * not in that context, never in the context of the mapping shown:
 *
 * - `describeMappingChoiceRefusal(group, value, mapping)` and the refusal of
 *   a whole mapping (`describeDataMappingRefusal`) read each value on its own
 *   mapping's axis, so a mapping keeping `highly_variable` while moving to
 *   raw is refused, not applied with a column raw.var does not have (R9M-2);
 * - a session saved on X with `highly_variable` restores onto the same file
 *   opened on raw (R9M-1), and one naming a column only the other axis has
 *   is refused with the column named;
 * - `followMappingChanges` is the one rule the panel's menus and
 *   `mapping.set` apply to the groups a change of matrix or modality does
 *   not name: a column the new axis has is kept, else the new axis's
 *   default (R9M-2, R9M-3).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';
import { describeDataMappingMismatch } from '../assets/js/app/session/session-context.js';
import { installDataMappingMethods } from './helpers/data-mapping-state.mjs';
import { mappingProbes } from './helpers/anndata-mapping-mocks.mjs';

const UMAP = Object.freeze({ key: 'X_umap', columns: [0, 1] });

/**
 * A scanpy file: X over the highly variable genes with `var['highly_variable']`
 * and `var['gene_symbols']`, raw over more genes with only `gene_symbols`
 * and `gene_ids` in `raw.var`, and a counts layer. It opens on raw.
 */
function scanpyState() {
  const probes = mappingProbes({ nObs: 4, nVars: 3, obsm: { X_umap: 2 }, hasX: true });
  probes.varColumns = [
    { key: 'gene_symbols', dtype: 'object' },
    { key: 'highly_variable', dtype: 'bool' },
    { key: 'only_in_var', dtype: 'object' },
  ];
  probes.layers = [{ key: 'counts', storage: 'csr', shape: [4, 3], dtype: 'int32', numeric: true }];
  probes.raw = {
    nVars: 5,
    X: { storage: 'dense', dtype: 'float32' },
    varColumns: [{ key: 'gene_symbols', dtype: 'object' }, { key: 'gene_ids', dtype: 'object' }],
  };
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), {
    slots: { '1d': null, '2d': UMAP, '3d': null },
    guessed: [],
  });
  const manager = new DimensionManager();
  manager.registerLayouts([{
    layoutKey: 'X_umap', dimension: 2, label: 'X_umap', path: 'obsm/0/0-1',
    provenance: UMAP, origin: 'identity',
  }]);
  manager.setLayoutProvider(createMappingLayoutProvider(candidates));
  const state = { dimensionManager: manager, viewContexts: new Map() };
  installDataMappingMethods(state, { mapping: null });
  state.publishDatasetMapping({
    mapping: {
      kind: 'anndata',
      embeddings: { enabled: [UMAP], defaults: { '1d': null, '2d': UMAP, '3d': null } },
      knn: null,
      geneNames: 'index',
      expression: 'raw',
      log1p: {},
      highlyVariable: null,
      latent: null,
      vectorFields: [],
    },
    candidates,
    origin: 'default',
  });
  return state;
}

test('the file opens on raw (more genes than X), whose raw.var has no highly variable column', () => {
  const state = scanpyState();
  assert.equal(state.getDataMapping().expression, 'raw');
  assert.deepEqual(state.getHighlyVariableChoices('raw').map(choice => choice.value), [null]);
  assert.deepEqual(state.getHighlyVariableChoices('X').map(choice => choice.value), [null, 'highly_variable']);
});

test('a value is checked on the axis of the mapping it belongs to, not on the mapping shown', () => {
  const state = scanpyState();
  const shown = state.getDataMapping();
  // Shown on raw with no highly variable genes: on X the column exists.
  const onX = { ...shown, expression: 'X', highlyVariable: 'highly_variable' };
  assert.equal(state.describeMappingChoiceRefusal('highlyVariable', 'highly_variable', onX), null);
  assert.equal(state.describeDataMappingRefusal(onX), null);
  // The same column on raw: raw.var does not have it.
  assert.equal(
    state.describeMappingChoiceRefusal('highlyVariable', 'highly_variable', shown),
    'this dataset does not have'
  );
  // A gene-name column only var has, kept while moving to raw, is refused.
  const namesOnlyInVar = { ...shown, expression: 'X', geneNames: 'column:only_in_var' };
  assert.equal(state.describeMappingChoiceRefusal('geneNames', 'column:only_in_var', namesOnlyInVar), null);
  assert.equal(
    state.describeMappingChoiceRefusal('geneNames', 'column:only_in_var', shown),
    'this dataset does not have'
  );
});

test('a mapping that keeps the shown value while its matrix moves to another axis is refused, not applied', async () => {
  const state = scanpyState();
  const onX = { ...state.getDataMapping(), expression: 'X', highlyVariable: 'highly_variable' };
  // Shown on X with highly_variable (what the panel or an agent applied).
  state.dataMapping = onX;
  assert.equal(
    state.describeDataMappingRefusal({ ...onX, expression: 'raw' }),
    "This mapping uses var column 'highly_variable' as its highly variable genes, which this dataset does not have."
  );
  await assert.rejects(
    state.applyDataMapping({ ...onX, expression: 'raw' }, { origin: 'user' }),
    /highly variable genes, which this dataset does not have/
  );
  assert.equal(state.getDataMapping(), onX);
});

test('the groups a change of matrix does not name follow it: kept where the new axis has them, else its default', () => {
  const state = scanpyState();
  const shown = state.getDataMapping();
  // raw (none) to X: X's var has highly_variable, as opening on X would take it (R9M-3).
  assert.deepEqual(
    pick(state.followMappingChanges(shown, { expression: 'X' })),
    { expression: 'X', geneNames: 'index', highlyVariable: 'highly_variable' }
  );
  // raw named by gene_symbols to X: var has gene_symbols too, kept.
  const symbols = { ...shown, geneNames: 'column:gene_symbols' };
  assert.equal(state.followMappingChanges(symbols, { expression: 'X' }).geneNames, 'column:gene_symbols');
  // raw named by gene_ids to X: var has no gene_ids, so its index.
  const ids = { ...shown, geneNames: 'column:gene_ids' };
  assert.equal(state.followMappingChanges(ids, { expression: 'X' }).geneNames, 'index');
  // X with highly_variable to raw: raw.var has none (R9M-2).
  const onX = { ...shown, expression: 'X', highlyVariable: 'highly_variable', geneNames: 'column:only_in_var' };
  assert.deepEqual(
    pick(state.followMappingChanges(onX, { expression: 'raw' })),
    { expression: 'raw', geneNames: 'index', highlyVariable: null }
  );
  // X to its counts layer: the same var axis keeps both, and none stays none.
  assert.deepEqual(
    pick(state.followMappingChanges(onX, { expression: 'layer:counts' })),
    { expression: 'layer:counts', geneNames: 'column:only_in_var', highlyVariable: 'highly_variable' }
  );
  assert.equal(
    state.followMappingChanges({ ...onX, highlyVariable: null }, { expression: 'layer:counts' }).highlyVariable,
    null
  );
  // A group named is never moved, and None shows no genes.
  assert.equal(
    state.followMappingChanges(shown, { expression: 'X', highlyVariable: null }).highlyVariable,
    null
  );
  assert.deepEqual(
    pick(state.followMappingChanges(onX, { expression: null })),
    { expression: null, geneNames: 'index', highlyVariable: null }
  );
  // A matrix the dataset does not have is left as named, for its refusal.
  assert.deepEqual(
    pick(state.followMappingChanges(onX, { expression: 'layer:absent' })),
    { expression: 'layer:absent', geneNames: 'column:only_in_var', highlyVariable: 'highly_variable' }
  );
});

test('a session saved on X with highly variable genes restores onto the file opened on raw; one naming a column raw lacks is refused', () => {
  const state = scanpyState();
  const shown = state.getDataMapping();
  const readers = {
    describeEmbeddingRefusal: () => null,
    describeChoiceRefusal: (group, value, saved) => state.describeMappingChoiceRefusal(group, value, saved),
  };
  const bound = saved => ({
    ...readers,
    describeChoiceRefusal: (group, value) => readers.describeChoiceRefusal(group, value, saved),
  });
  const savedOnX = { ...shown, expression: 'X', highlyVariable: 'highly_variable', geneNames: 'column:only_in_var' };
  assert.equal(describeDataMappingMismatch(savedOnX, shown, bound(savedOnX)), null);
  // Saved on raw with gene_symbols, shown now on X with gene_symbols: the
  // same value, on another axis, checked again (raw.var has it: restored).
  const shownOnX = { ...shown, expression: 'X', geneNames: 'column:gene_symbols' };
  const savedOnRaw = { ...shown, geneNames: 'column:gene_symbols' };
  assert.equal(describeDataMappingMismatch(savedOnRaw, shownOnX, bound(savedOnRaw)), null);
  // Saved on raw with a column named like one of var's only: refused, named.
  const shownOnlyInVar = { ...shown, expression: 'X', geneNames: 'column:only_in_var' };
  const savedRawOnlyInVar = { ...shown, geneNames: 'column:only_in_var' };
  assert.match(
    describeDataMappingMismatch(savedRawOnlyInVar, shownOnlyInVar, bound(savedRawOnlyInVar)),
    /^This session uses var column 'only_in_var' as its gene names, which this dataset does not have\./
  );
});

function pick(mapping) {
  return { expression: mapping.expression, geneNames: mapping.geneNames, highlyVariable: mapping.highlyVariable };
}
