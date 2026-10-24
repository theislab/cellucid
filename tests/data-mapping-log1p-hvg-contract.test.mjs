/**
 * The data mapping's expression transform (`log1p`, per expression matrix)
 * and highly variable genes (`highlyVariable`, a boolean var column):
 * their Scanpy-convention defaults, the reader's `uns['log1p']` probe and
 * boolean var columns, the adapter's marked-gene read, and the gene loader
 * API analyses read them through (`log1p({matrix})`, `highlyVariableGenes()`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HIGHLY_VARIABLE_COLUMN,
  defaultHighlyVariable,
  defaultLog1p,
  highlyVariableCandidates,
} from '../assets/js/data/data-mapping.js';
import {
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  LOG1P_AS_STORED,
  describeMappingGroupValue,
  log1pChoiceOf,
  log1pMenu,
  withLog1pChoice,
} from '../assets/js/data/dataset-mapping.js';
import { createVarFieldLoader, varLoaderMappingOf } from '../assets/js/data/data-loaders.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  array,
  dense,
  mapping,
  minimalAnnData,
  nullable,
  openReader,
  stringFrame,
} from './helpers/anndata-store.mjs';
import { mappingProbes, withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';

test('log1p follows Scanpy: uns[\'log1p\'] makes X and every layer log1p, raw too unless it holds integers', () => {
  assert.deepEqual(
    defaultLog1p({ log1p: null, hasX: true, raw: { dtype: 'float32' }, layers: ['counts'] }),
    { log1p: {}, guessed: false },
  );
  assert.deepEqual(
    defaultLog1p({ log1p: { base: null }, hasX: true, raw: { dtype: 'float32' }, layers: ['spliced', 'counts'] }),
    {
      log1p: {
        X: { base: null },
        'layer:counts': { base: null },
        'layer:spliced': { base: null },
        raw: { base: null },
      },
      guessed: true,
    },
  );
  // A raw stored as integers holds counts, which log1p never writes.
  assert.deepEqual(
    defaultLog1p({ log1p: { base: 2 }, hasX: true, raw: { dtype: 'int32' }, layers: [] }),
    { log1p: { X: { base: 2 } }, guessed: true },
  );
  // A record with no matrix to apply to guesses nothing.
  assert.deepEqual(
    defaultLog1p({ log1p: { base: null }, hasX: false, raw: null, layers: [] }),
    { log1p: {}, guessed: false },
  );
});

test('highly variable genes follow Scanpy: var[\'highly_variable\'] when it is boolean', () => {
  const columns = [
    { key: 'is_mt', dtype: 'bool' },
    { key: 'highly_variable_rank', dtype: 'float32' },
    { key: 'hvg', dtype: 'boolean' },
    { key: 'highly_variable', dtype: 'bool' },
    { key: 'highly_variable_nbatches', dtype: 'int64' },
    { key: 'gene_symbols', dtype: 'object' },
    { key: 'batch_hvg', dtype: 'bool' },
  ];
  assert.deepEqual(highlyVariableCandidates(columns), ['highly_variable', 'batch_hvg', 'hvg', 'is_mt']);
  assert.deepEqual(defaultHighlyVariable(columns), { highlyVariable: HIGHLY_VARIABLE_COLUMN, guessed: true });
  assert.deepEqual(
    defaultHighlyVariable([{ key: 'highly_variable', dtype: 'float32' }, { key: 'hvg', dtype: 'bool' }]),
    { highlyVariable: null, guessed: false },
  );
});

test('the catalog opens with Scanpy\'s log1p and highly variable genes, marked guessed', () => {
  const probes = mappingProbes({ nObs: 4, nVars: 3, obsm: { X_umap: 2 }, hasX: true });
  probes.varColumns = [{ key: 'highly_variable', dtype: 'bool' }];
  probes.layers = [{ key: 'counts', storage: 'csr', shape: [4, 3], dtype: 'float32', numeric: true }];
  probes.raw = { nVars: 5, X: { storage: 'dense', dtype: 'float32' }, varColumns: [] };
  probes.log1p = { base: null };
  const slots = { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null };
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] });
  assert.deepEqual(candidates.log1p, { base: null });
  assert.deepEqual(candidates.defaults.log1p, {
    X: { base: null },
    'layer:counts': { base: null },
    raw: { base: null },
  });
  assert.equal(candidates.defaults.highlyVariable, 'highly_variable');
  assert.deepEqual(candidates.guessed, ['log1p', 'highlyVariable']);
  // A launch that opens on raw takes raw.var's column, which it lacks.
  const onRaw = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] }, { expression: 'raw' });
  assert.equal(onRaw.defaults.highlyVariable, null);
  // Without uns['log1p'], every matrix is as stored, and nothing is guessed.
  probes.log1p = null;
  probes.varColumns = [];
  const plain = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] });
  assert.deepEqual(plain.defaults.log1p, {});
  assert.equal(plain.defaults.highlyVariable, null);
  assert.deepEqual(plain.guessed, []);
  for (const bad of [undefined, { base: 1 }, { base: 'e' }, { base: null, extra: 1 }]) {
    probes.log1p = bad;
    assert.throws(() => describeAnnDataProbes(probes), /uns\['log1p'\]/);
  }
});

function scanpyLikeTree({ log1p, highlyVariable }) {
  const nObs = 3;
  const genes = ['CD3E', 'LYZ', 'MS4A1', 'NKG7'];
  const tree = minimalAnnData({ nObs, genes });
  tree.children.var = stringFrame(genes, highlyVariable === undefined ? {} : { highly_variable: highlyVariable });
  if (log1p !== undefined) tree.children.uns = mapping({ log1p });
  return tree;
}

test('the reader probes uns[\'log1p\'] and reads a boolean var column only when asked', async () => {
  const flags = array(new Uint8Array([1, 0, 0, 1]), { dtype: '|b1' });
  const recorded = await openReader(scanpyLikeTree({
    log1p: mapping({ base: dense(new Float64Array([2]), []) }),
    highlyVariable: flags,
  }));
  assert.deepEqual((await recorded.reader.probeMapping()).log1p, { base: 2 });
  assert.deepEqual(Array.from(await recorded.reader.readVarFlags('X', 'highly_variable')), [1, 0, 0, 1]);
  await assert.rejects(recorded.reader.readVarFlags('X', 'absent'), /does not exist/);

  // Scanpy's `base=None` is stored as nothing: the natural logarithm.
  const natural = await openReader(scanpyLikeTree({
    log1p: mapping({}),
    highlyVariable: nullable('nullable-boolean', [true, true, false, false], [false, true, false, false]),
  }));
  assert.deepEqual((await natural.reader.probeMapping()).log1p, { base: null });
  // A missing value is not marked.
  assert.deepEqual(Array.from(await natural.reader.readVarFlags('X', 'highly_variable')), [1, 0, 0, 0]);

  const plain = await openReader(scanpyLikeTree({ highlyVariable: dense(new Float32Array([1, 0, 0, 1]), [4]) }));
  assert.equal((await plain.reader.probeMapping()).log1p, null);
  await assert.rejects(plain.reader.readVarFlags('X', 'highly_variable'), /not a true\/false column/);
});

test('the gene loader answers log1p from the mapping and reads the highly variable genes once', async () => {
  const { reader } = await openReader(scanpyLikeTree({
    log1p: mapping({}),
    highlyVariable: array(new Uint8Array([0, 1, 1, 0]), { dtype: '|b1' }),
  }));
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(reader));
  await adapter.initialize();
  const candidates = adapter.getMappingCandidates();
  assert.deepEqual(candidates.defaults.log1p, { X: { base: null } });
  assert.equal(candidates.defaults.highlyVariable, 'highly_variable');
  assert.deepEqual(await adapter.getMarkedGenes('var', 'highly_variable'), ['LYZ', 'MS4A1']);
  await assert.rejects(adapter.getMarkedGenes('var', 'gene_ids'), /true\/false/);

  const loaderMapping = varLoaderMappingOf(candidates.defaults);
  assert.deepEqual(loaderMapping, { expression: 'X', log1p: { X: { base: null } }, highlyVariable: 'highly_variable' });
  const loader = createVarFieldLoader('anndata://unused/var', { pointCount: 3, mapping: loaderMapping });
  assert.deepEqual(loader.log1p(), { base: null });
  assert.deepEqual(loader.log1p({ matrix: 'X' }), { base: null });
  assert.equal(loader.log1p({ matrix: 'raw' }), null);
  const none = createVarFieldLoader('anndata://unused/var', {
    pointCount: 3,
    mapping: { expression: 'X', log1p: {}, highlyVariable: null },
  });
  assert.equal(none.log1p(), null);
  assert.equal(await none.highlyVariableGenes(), null);
  assert.equal(varLoaderMappingOf({ expression: null, log1p: {}, highlyVariable: null }), null);
  assert.throws(
    () => createVarFieldLoader('anndata://unused/var', { mapping: { expression: 'X', log1p: {} } }),
    /exactly \{expression, log1p, highlyVariable\}/,
  );
});

test('the transform menu sets one matrix\'s log1p and keeps the others', () => {
  const log1p = { X: { base: null }, 'layer:counts': { base: null } };
  assert.equal(log1pChoiceOf(log1p, 'X'), 'e');
  assert.equal(log1pChoiceOf(log1p, 'raw'), LOG1P_AS_STORED);
  assert.deepEqual(withLog1pChoice(log1p, 'layer:counts', LOG1P_AS_STORED), { X: { base: null } });
  assert.deepEqual(withLog1pChoice(log1p, 'raw', '2'), {
    X: { base: null },
    'layer:counts': { base: null },
    raw: { base: 2 },
  });
  assert.throws(() => withLog1pChoice(log1p, 'X', '1'), RangeError);
  assert.deepEqual(log1pMenu([null, 3, 2]).map(choice => choice.value), [LOG1P_AS_STORED, 'e', '2', '3', '10']);
  assert.equal(describeMappingGroupValue('log1p', {}), 'values as stored');
  assert.equal(
    describeMappingGroupValue('log1p', { X: { base: null }, 'layer:x': { base: 2 } }),
    "log1p of X (base e), layers['x'] (base 2)",
  );
  assert.equal(describeMappingGroupValue('highlyVariable', 'hvg'), "var column 'hvg'");
});
