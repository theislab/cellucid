/**
 * Data kinds through the reader: a continuous column with no value among the
 * open cells loads (every cell missing), and a MuData modality's column
 * pulled to the cells (`<modality>:<column>`) keeps the colors Scanpy run on
 * the modality stored in that modality's `uns`.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { muDataView } from '../assets/js/data/anndata/views/mudata.js';
import { annData, array, categorical, dense, group, mapping, minimalAnnData, nullable, openReader, openStore, stringFrame, strings } from './helpers/anndata-store.mjs';

test('a continuous column with no finite value loads, every cell missing', async () => {
  const { reader } = await openReader(minimalAnnData({ nObs: 3, obs: { score: array(new Float32Array([NaN, NaN, NaN])) } }));
  const adapter = new BaseAnnDataAdapter(reader);
  adapter._obsFieldsMetadata = [{ key: 'score', kind: 'continuous' }];
  const field = await adapter.getObsFieldData('score');
  assert.equal(field.kind, 'continuous');
  assert.equal(field.min, null);
  assert.equal(field.max, null);
  assert.ok(Array.from(new Float32Array(field.data)).every(Number.isNaN));
});

test('a MuData modality column takes its colors from the modality\'s own uns', async () => {
  const cells = ['c0', 'c1', 'c2'];
  const rna = annData({
    obs: stringFrame(cells, { leiden: categorical(new Int8Array([0, 1, 0]), ['0', '1']) }),
    var: stringFrame(['g0', 'g1']),
    X: dense(new Float32Array(6), [3, 2]),
    uns: mapping({ leiden_colors: strings(['#ff0000', '#00ff00']) }),
  });
  const tree = group({
    obs: stringFrame(cells),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: 6 }, (_, i) => i), [3, 2]) }),
    mod: group({ rna }, { 'mod-order': ['rna'] }),
  }, { 'encoding-type': 'MuData', 'encoding-version': '0.1.0', axis: 0 });
  const { root } = await openStore(tree);
  const reader = new AnnDataReader();
  await reader.open(await muDataView(root, { name: 'm.zarr' }), { format: ZARR_FORMAT, name: 'm.zarr' });
  assert.ok(reader.obsKeys.includes('rna:leiden'));
  const info = await reader.getObsFieldInfo('rna:leiden');
  assert.deepEqual(info.colors, ['#ff0000', '#00ff00']);
});

test('a MuData modality\'s wide integer column stays exact on the cells, missing where not measured', async () => {
  const cells = ['c0', 'c1', 'c2'];
  const rna = annData({
    obs: stringFrame(['c0', 'c2'], { total: array(new Int32Array([16_777_217, 3]), { dtype: '<i4' }) }),
    var: stringFrame(['g0']),
    X: dense(new Float32Array(2), [2, 1]),
  });
  const tree = group({
    obs: stringFrame(cells),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: 6 }, (_, i) => i), [3, 2]) }),
    obsmap: group({ rna: array(new Int32Array([1, 0, 2]), { dtype: '<i4' }) }),
    mod: group({ rna }, { 'mod-order': ['rna'] }),
  }, { 'encoding-type': 'MuData', 'encoding-version': '0.1.0', axis: 0 });
  const { root } = await openStore(tree);
  const reader = new AnnDataReader();
  await reader.open(await muDataView(root, { name: 'm.zarr' }), { format: ZARR_FORMAT, name: 'm.zarr' });
  const field = await reader.getObsField('rna:total');
  assert.ok(field.values instanceof Float64Array);
  assert.equal(field.values[0], 16_777_217);
  assert.ok(Number.isNaN(field.values[1]));
  assert.equal(field.values[2], 3);
});

test('a MuData modality\'s columns of every kind read as the dataset\'s own: unmeasured cells missing, nullable values kept', async () => {
  // Cells c0..c3; the modality measured c0, c2 and c3 (rows 0, 1, 2).
  const cells = ['c0', 'c1', 'c2', 'c3'];
  const rna = annData({
    obs: stringFrame(['c0', 'c2', 'c3'], {
      n_int: nullable('nullable-integer', new BigInt64Array([5n, 0n, 7n]), [0, 1, 0]),
      n_bool: nullable('nullable-boolean', [true, false, false], [0, 0, 1]),
      n_text: nullable('nullable-string-array', ['a', '', 'b'], [0, 1, 0]),
      flag: array(Uint8Array.from([1, 0, 1]), { dtype: '|b1' }),
      batch: array(new Int16Array([2, 4, 2]), { dtype: '<i2' }),
      label: strings(['x', 'y', 'x']),
      score: array(new Float32Array([0.5, 1.5, 2.5])),
    }),
    var: stringFrame(['g0']),
    X: dense(new Float32Array(3), [3, 1]),
  });
  const tree = group({
    obs: stringFrame(cells),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: 8 }, (_, i) => i), [4, 2]) }),
    obsmap: group({ rna: array(new Int32Array([1, 0, 2, 3]), { dtype: '<i4' }) }),
    mod: group({ rna }, { 'mod-order': ['rna'] }),
  }, { 'encoding-type': 'MuData', 'encoding-version': '0.1.0', axis: 0 });
  const { root } = await openStore(tree);
  const reader = new AnnDataReader();
  await reader.open(await muDataView(root, { name: 'm.zarr' }), { format: ZARR_FORMAT, name: 'm.zarr' });
  const kinds = {};
  for (const column of ['n_int', 'n_bool', 'n_text', 'flag', 'batch', 'label', 'score']) {
    kinds[column] = (await reader.getObsFieldKind(`rna:${column}`)).dtype;
  }
  assert.deepEqual(kinds, { n_int: 'int', n_bool: 'bool', n_text: 'string', flag: 'bool', batch: 'int', label: 'string', score: 'float' });
  const valuesOf = async (column, rows = null) => {
    const field = await reader.getObsField(`rna:${column}`, rows === null ? {} : { rows });
    return field.dtype === 'categorical'
      ? Array.from(field.codes, code => (code < field.categories.length ? field.categories[code] : null))
      : Array.from(field.values);
  };
  assert.deepEqual(await valuesOf('n_int'), [5, NaN, NaN, 7]);
  assert.deepEqual(await valuesOf('n_bool'), [true, null, false, null]);
  assert.deepEqual(await valuesOf('n_text'), ['a', null, null, 'b']);
  assert.deepEqual(await valuesOf('flag'), [true, null, false, true]);
  assert.deepEqual(await valuesOf('batch'), [2, NaN, 4, 2]);
  assert.deepEqual(await valuesOf('label'), ['x', null, 'y', 'x']);
  assert.deepEqual(await valuesOf('score'), [0.5, NaN, 1.5, 2.5]);
  // Rows of some cells (an opening grown in place) read the same values.
  assert.deepEqual(await valuesOf('n_int', [1, 4]), [NaN, NaN, 7]);
  assert.deepEqual(await valuesOf('flag', [1, 3]), [null, false]);
});

test('a file with raw and sparse matrices reopens in place as a subsample: each matrix\'s counts probe reads the store, never the subsample\'s view', async () => {
  const { readFile } = await import('node:fs/promises');
  const { AnnDataFileSource } = await import('../assets/js/data/anndata-file-source.js');
  for (const name of ['data-mapping-full.h5ad', 'data-mapping-full.zarr.zip']) {
    const file = new File([await readFile(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
    const source = new AnnDataFileSource();
    try {
      await source.loadFile(file);
      // The view reads a CSR matrix's values only by its kept rows, after
      // their pointers: a probe through it would fail the reopening.
      await source.reopenCells({ cellSubset: { mode: 'subsample', method: 'uniform', k: 120, seed: 7 } });
      assert.equal(source.getCellSubset().kept.length, 120, name);
      const probes = await source._loader._call('probeMapping');
      assert.equal(probes.raw.X.counts, true, `${name}: raw.X holds counts`);
      assert.equal(probes.layers.find(layer => layer.key === 'counts').counts, true, `${name}: layers['counts'] holds counts`);
    } finally {
      source.clear();
    }
  }
});
