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
  describeLog1pRefuted,
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
  sparse,
  stringFrame,
} from './helpers/anndata-store.mjs';
import { mappingProbes, withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';

test('log1p follows Scanpy: uns[\'log1p\'] makes X, raw and every layer log1p, unless one holds integers (counts)', () => {
  const X = { dtype: 'float32' };
  assert.deepEqual(
    defaultLog1p({ log1p: null, X, raw: { dtype: 'float32' }, layers: [{ key: 'counts', dtype: 'float32' }] }),
    { log1p: {}, guessed: false, refuted: [] },
  );
  assert.deepEqual(
    defaultLog1p({ log1p: { base: null }, X, raw: { dtype: 'float32' }, layers: [{ key: 'spliced', dtype: 'float32' }, { key: 'counts', dtype: 'float32' }] }),
    {
      log1p: {
        X: { base: null },
        'layer:counts': { base: null },
        'layer:spliced': { base: null },
        raw: { base: null },
      },
      guessed: true,
      refuted: [],
    },
  );
  // A matrix stored as integers holds counts, which log1p never writes: raw,
  // a layer, or X itself.
  assert.deepEqual(
    defaultLog1p({ log1p: { base: 2 }, X, raw: { dtype: 'int32' }, layers: [{ key: 'counts', dtype: 'int64' }, { key: 'norm', dtype: 'float64' }] }),
    { log1p: { X: { base: 2 }, 'layer:norm': { base: 2 } }, guessed: true, refuted: [] },
  );
  assert.deepEqual(
    defaultLog1p({ log1p: { base: 2 }, X: { dtype: 'uint16' }, raw: null, layers: [] }),
    { log1p: {}, guessed: false, refuted: [] },
  );
  // A record with no matrix to apply to guesses nothing.
  assert.deepEqual(
    defaultLog1p({ log1p: { base: null }, X: null, raw: null, layers: [] }),
    { log1p: {}, guessed: false, refuted: [] },
  );
});

test('a matrix whose stored values refute uns[\'log1p\'] is read as stored, and the catalog says which and why', () => {
  const refutation = { value: 1118.5707, dtype: 'float32', total: null };
  assert.deepEqual(
    defaultLog1p({ log1p: { base: null }, X: { dtype: 'float32', notLog1p: refutation }, raw: null, layers: [{ key: 'norm', dtype: 'float32', notLog1p: null }] }),
    { log1p: { 'layer:norm': { base: null } }, guessed: true, refuted: [{ matrix: 'X', ...refutation }] },
  );
  assert.deepEqual(
    defaultLog1p({ log1p: { base: null }, X: { dtype: 'float32', notLog1p: refutation }, raw: null, layers: [] }),
    { log1p: {}, guessed: false, refuted: [{ matrix: 'X', ...refutation }] },
  );
  // Without a record nothing is refuted: there is nothing to refute.
  assert.deepEqual(defaultLog1p({ log1p: null, X: { dtype: 'float32', notLog1p: null }, raw: null, layers: [] }).refuted, []);
  const said = describeLog1pRefuted([{ matrix: 'X', ...refutation }]);
  assert.equal(said.text, 'Values: as stored — X not log1p (holds 1,119).');
  assert.match(said.detail, /uns\['log1p'\].*1,119.*more than any number.*float32/);
  assert.deepEqual(describeLog1pRefuted([]), { text: '', detail: '' });
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
  // raw holds more genes than X (5 against 3): the file opens on raw, as
  // Scanpy reads genes, whose var lacks the column.
  assert.equal(candidates.defaults.expression, 'raw');
  assert.equal(candidates.expressionReason, 'raw-more-genes');
  assert.equal(candidates.defaults.highlyVariable, null);
  assert.deepEqual(candidates.guessed, ['log1p']);
  // A launch that opens on X takes var's column, guessed.
  const onX = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] }, { expression: 'X' });
  assert.equal(onX.defaults.highlyVariable, 'highly_variable');
  assert.equal(onX.expressionReason, null);
  assert.deepEqual(onX.guessed, ['log1p', 'highlyVariable']);
  // raw over the same genes as an unscaled X (a CELLxGENE file: counts in
  // raw): the file opens on X.
  probes.raw.nVars = 3;
  const sameGenes = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] });
  assert.equal(sameGenes.defaults.expression, 'X');
  assert.equal(sameGenes.defaults.highlyVariable, 'highly_variable');
  // ... and on raw when X holds scaled values (negative ones in its first chunk).
  probes.X = { ...probes.X, storage: 'dense', dtype: 'float32', scaled: true };
  const scaled = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] });
  assert.equal(scaled.defaults.expression, 'raw');
  assert.equal(scaled.expressionReason, 'x-scaled');
  probes.X = { ...probes.X, scaled: null };
  // Without uns['log1p'], every matrix is as stored, and nothing is guessed.
  probes.log1p = null;
  probes.varColumns = [];
  const plain = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] });
  assert.deepEqual(plain.defaults.log1p, {});
  assert.equal(plain.defaults.highlyVariable, null);
  assert.deepEqual(plain.guessed, []);
  probes.raw.nVars = 5;
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

/**
 * EBI SCEA E-ANND-5's shape: per-million values in a float32 CSR X (non-zero
 * entries from 252 to 1,118, one cell's ~4,000 counts scaled to a million)
 * under an empty `uns['log1p']`. Undoing a log1p of 252 gives 1e109 for one
 * entry, past float32's 3.4e38: the values were never log1p.
 */
function perMillionTree({ dtype = '<f4', values = null, log1p = mapping({}) } = {}) {
  const nObs = 4;
  const genes = ['G0', 'G1', 'G2', 'G3', 'G4'];
  const data = values ?? Float32Array.from([252.25423, 346.0872, 1118.5707, 311.0533, 252.25423, 442.21756, 371.12643, 420.12543]);
  const X = sparse({
    format: 'csr',
    data: dtype === '<f8' ? Float64Array.from(data) : Float32Array.from(data),
    dataDtype: dtype,
    indices: Int32Array.from([0, 2, 4, 1, 3, 0, 2, 4]),
    indptr: Int32Array.from([0, 3, 5, 6, 8]),
    shape: [nObs, genes.length],
  });
  return minimalAnnData({ nObs, genes, X, extra: log1p === null ? {} : { uns: mapping({ log1p }) } });
}

test('values a log1p cannot have written refute uns[\'log1p\']: the E-ANND-5 shape is read as stored, said, and a real log1p is kept', async () => {
  const refuted = await openReader(perMillionTree());
  const probes = await refuted.reader.probeMapping();
  assert.equal(probes.log1p.base, null);
  assert.equal(probes.X.notLog1p.dtype, 'float32');
  assert.equal(probes.X.notLog1p.value, Math.fround(1118.5707));
  assert.equal(probes.X.notLog1p.total, null, 'expm1(1,118) is past float64 too');
  // The opening's probe reads no value: nothing refuted yet.
  assert.equal((await refuted.reader.probeMapping({ counts: false })).X.notLog1p, null);
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(refuted.reader));
  await adapter.initialize();
  assert.deepEqual(adapter.getMappingCandidates().defaults.log1p, { X: { base: null } }, 'before the values are read');
  const completed = await adapter.completeMappingCandidates();
  assert.deepEqual(completed.defaults.log1p, {});
  assert.deepEqual(completed.log1pRefuted.map(entry => entry.matrix), ['X']);
  assert.ok(!completed.guessed.includes('log1p'));

  // log1p of counts normalized to 10,000 (scanpy's defaults: values up to ~9.2): kept.
  const logged = await openReader(perMillionTree({ values: Float32Array.from([0.69, 1.61, 9.21, 2.3, 0.69, 3.4, 4.1, 2.2]) }));
  assert.equal((await logged.reader.probeMapping()).X.notLog1p, null);
  // The bound is the matrix's own type: 100 can be log1p of a float64 (expm1(100) = 2.7e43) but not of a float32.
  const wide = Float32Array.from([100, 100, 100, 1, 1, 1, 1, 1]);
  assert.equal((await (await openReader(perMillionTree({ dtype: '<f8', values: wide }))).reader.probeMapping()).X.notLog1p, null);
  const narrow = (await (await openReader(perMillionTree({ values: wide }))).reader.probeMapping()).X.notLog1p;
  assert.deepEqual({ value: narrow.value, dtype: narrow.dtype }, { value: 100, dtype: 'float32' });
  assert.ok(narrow.total > 3.4028234663852886e38);
  // No record, nothing to refute; a base-2 record bounds in its own base (2^100 fits float32).
  assert.equal((await (await openReader(perMillionTree({ log1p: null }))).reader.probeMapping()).X.notLog1p, null);
  const base2 = mapping({ base: dense(new Float64Array([2]), []) });
  assert.equal((await (await openReader(perMillionTree({ values: wide, log1p: base2 }))).reader.probeMapping()).X.notLog1p, null);
});

test('a mapping on the default log1p reads a refuted matrix as stored once the values are read; a choice, a session and an unread catalog never change it', async () => {
  const { DataStateMappingMethods } = await import('../assets/js/app/state/managers/mapping-manager.js');
  const opening = { kind: 'anndata', defaults: { log1p: { X: { base: null }, 'layer:norm': { base: null } } }, guessed: ['log1p'], log1pRefuted: [] };
  const completed = { ...opening, defaults: { log1p: { 'layer:norm': { base: null } } }, guessed: ['log1p'], log1pRefuted: [{ matrix: 'X', value: 1118.5, dtype: 'float32', total: null }] };
  const stateOf = (log1p, origin) => {
    const applied = [];
    const state = Object.assign(Object.create(DataStateMappingMethods.prototype), {
      dataMapping: { kind: 'anndata', log1p },
      _mappingCandidates: opening,
      _mappingOrigin: origin,
      emit() {},
      applyDataMapping: async (next, options) => { applied.push({ log1p: next.log1p, origin: options.origin }); return true; },
    });
    return { state, applied };
  };
  const onDefault = stateOf(opening.defaults.log1p, 'default');
  onDefault.state.adoptMappingCandidates(completed);
  assert.deepEqual(onDefault.applied, [{ log1p: { 'layer:norm': { base: null } }, origin: 'default' }]);
  // Once read as stored, the line says why.
  onDefault.state.dataMapping = { kind: 'anndata', log1p: { 'layer:norm': { base: null } } };
  assert.deepEqual(onDefault.state.getLog1pRefuted().map(entry => entry.matrix), ['X']);
  // A catalog that has not read the values (a resize's) never sets it back.
  onDefault.state.adoptMappingCandidates(opening);
  assert.equal(onDefault.applied.length, 1);
  for (const [log1p, origin] of [[opening.defaults.log1p, 'session'], [opening.defaults.log1p, 'user'], [{ X: { base: 2 } }, 'default']]) {
    const kept = stateOf(log1p, origin);
    kept.state.adoptMappingCandidates(completed);
    assert.deepEqual(kept.applied, [], `${origin} ${JSON.stringify(log1p)}`);
  }
});

test('moving to another modality takes its log1p as an opening with it would, its refuted matrices as stored', async () => {
  const { DataStateMappingGroupMethods } = await import('../assets/js/app/state/managers/mapping-groups.js');
  const probes = mappingProbes({ nObs: 4, nVars: 3, obsm: { X_umap: 2 }, hasX: true });
  const modality = (name, notLog1p) => ({
    name,
    nCells: 4,
    nVars: 3,
    varColumns: [],
    X: { storage: 'csr', dtype: 'float32', notLog1p },
    layers: [{ key: 'norm', storage: 'csr', shape: [4, 3], dtype: 'float32', numeric: true }],
    raw: null,
    log1p: { base: null },
  });
  probes.modalities = [modality('rna', null), modality('atac', { value: 900, dtype: 'float32', total: null })];
  probes.defaultModality = 'rna';
  const slots = { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null };
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes(probes), { slots, guessed: [] });
  const state = Object.assign(Object.create(DataStateMappingGroupMethods.prototype), { getMappingCandidates: () => candidates });
  // A call without arguments still finds `X` and the layers' dtypes: it must not throw.
  assert.deepEqual(state.defaultModalityGroups('rna').log1p, { X: { base: null }, 'layer:norm': { base: null } });
  assert.deepEqual(state.defaultModalityGroups('atac').log1p, { 'layer:norm': { base: null } });
});
