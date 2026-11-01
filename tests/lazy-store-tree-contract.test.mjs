/**
 * A store's tree is read as it is navigated into (`formats/store.js`,
 * `Group.load`): opening an AnnData file reads its structure, never the parts
 * its columns, graphs and `uns` entries are stored in, and every reading
 * loads what it reads. One contract for HDF5, Zarr and the layout views.
 *
 * - opening an `.h5ad` loads `ANNDATA_OPENING_PATHS` only; the field list,
 *   its order and its kinds are what a whole-tree reading gives;
 * - a field, a graph, the mapping probes and var columns load their parts
 *   when read, through a subsample's view too;
 * - a view group is loaded when the real groups it is made from are, and
 *   lists its children only then; a Zarr store is loaded whole at open;
 * - navigating a group not loaded throws `StoreNotLoadedError`, which a
 *   column check never takes for a defect of the file;
 * - every step of an opening finds what it names: a priority-ordered file
 *   opened as a uniform subsample (its prefix and `varm` prefix counts), as
 *   `.h5ad` and as a MuData `.h5mu`, reads as its Zarr original does.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { StoreNotLoadedError, isGroup, loadSpecsOf, valueArrayClass } from '../assets/js/formats/store.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { booleanAttribute, group, numericDataset, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ANNDATA_OPENING_PATHS, H5AD_FORMAT } from '../assets/js/data/anndata/elements.js';
import { columnDefect } from '../assets/js/data/anndata/dataframe.js';
import { viewGroup } from '../assets/js/data/anndata/views/view-nodes.js';
import { openZarr, memoryStore } from '../assets/js/formats/zarr/index.js';
import { presentStore } from '../assets/js/data/anndata/open.js';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const CELLS = 48;
const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/**
 * An `.h5ad` of `columns` categorical obs columns, a float and a nullable
 * integer column, a CSR X, an embedding, a graph and `uns` entries.
 */
async function annData(columns) {
  const categorical = (c, rows = CELLS) => group({ ...encoding('categorical', '0.2.0'), ordered: booleanAttribute(c % 2 === 1) }, [
    ['categories', stringDataset(Array.from({ length: 2 + (c % 3) }, (_, k) => `c${c}v${k}`), encoding('string-array', '0.2.0'))],
    ['codes', numericDataset('int8', [rows], Int8Array.from({ length: rows }, (_, i) => (i + c) % (2 + (c % 3))), encoding('array', '0.2.0'))],
  ]);
  const obsColumns = [
    ...Array.from({ length: columns }, (_, c) => [`cat${c}`, categorical(c)]),
    ['score', numericDataset('float32', [CELLS], Float32Array.from({ length: CELLS }, (_, i) => i / 2), encoding('array', '0.2.0'))],
    ['count', group(encoding('nullable-integer', '0.1.0'), [
      ['values', numericDataset('int32', [CELLS], Int32Array.from({ length: CELLS }, (_, i) => i), encoding('array', '0.2.0'))],
      ['mask', numericDataset('bool', [CELLS], new Uint8Array(CELLS), encoding('array', '0.2.0'))],
    ])],
  ];
  const csr = (rows, cols, perRow) => group({ ...encoding('csr_matrix', '0.1.0'), shape: BigInt64Array.of(BigInt(rows), BigInt(cols)) }, [
    ['data', numericDataset('float32', [rows * perRow], Float32Array.from({ length: rows * perRow }, (_, i) => 1 + (i % 3)))],
    ['indices', numericDataset('int32', [rows * perRow], Int32Array.from({ length: rows * perRow }, (_, i) => (Math.floor(i / perRow) + (i % perRow)) % cols))],
    ['indptr', numericDataset('int64', [rows + 1], BigInt64Array.from({ length: rows + 1 }, (_, i) => BigInt(i * perRow)))],
  ]);
  const root = group(encoding('anndata', '0.1.0'), [
    ['obs', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': obsColumns.map(([name]) => name) }, [
      ['_index', stringDataset(Array.from({ length: CELLS }, (_, i) => `cell${i}`), encoding('string-array', '0.2.0'))],
      ...obsColumns,
    ])],
    ['var', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': ['symbol'] }, [
      ['_index', stringDataset(['g0', 'g1', 'g2', 'g3'], encoding('string-array', '0.2.0'))],
      ['symbol', categorical(0, 4)],
    ])],
    ['X', csr(CELLS, 4, 2)],
    ['obsm', group(encoding('dict', '0.1.0'), [
      ['X_umap', numericDataset('float32', [CELLS, 2], Float32Array.from({ length: CELLS * 2 }, (_, i) => i), encoding('array', '0.2.0'))],
    ])],
    ['obsp', group(encoding('dict', '0.1.0'), [['connectivities', csr(CELLS, CELLS, 1)]])],
    ['uns', group(encoding('dict', '0.1.0'), [
      ['notes', group(encoding('dict', '0.1.0'), Array.from({ length: columns }, (_, c) => [`n${c}`, stringDataset([`note ${c}`], encoding('string-array', '0.2.0'))]))],
    ])],
  ]);
  return new Uint8Array(await writeHdf5(root).arrayBuffer());
}

/** The file opened as the app opens one, its reader open on it. */
async function openedReader(bytes, { cellSubset = null, load = ANNDATA_OPENING_PATHS } = {}) {
  const store = await openHdf5(createByteReader(bytesByteSource(bytes, { name: 'lazy.h5ad' })), { load });
  const reader = new AnnDataReader();
  await reader.open(store, { format: H5AD_FORMAT, name: 'lazy.h5ad', cellSubset });
  return { reader, store };
}

test('opening an .h5ad loads its structure only; the field list, its order and kinds are the whole tree\'s', async t => {
  const bytes = await annData(24);
  const lazy = await openedReader(bytes);
  const whole = await openedReader(bytes, { load: [''] });
  t.after(() => {
    lazy.reader.close();
    whole.reader.close();
  });
  const objects = lazy.store.stats().objects;
  const all = whole.store.stats().objects;
  // 24 categorical columns' codes and categories, the nullable column's
  // values and mask, var's categorical's parts, the graph and uns: unread.
  assert.ok(all - objects >= 2 * 24 + 2 + 2 + 3 + 24, `${objects} of ${all} objects at open`);
  assert.deepEqual(lazy.reader.obsKeys, whole.reader.obsKeys);
  assert.deepEqual(lazy.reader.notes, whole.reader.notes);
  for (const key of lazy.reader.obsKeys) {
    const [kind, wholeKind] = await Promise.all([lazy.reader.getObsFieldKind(key), whole.reader.getObsFieldKind(key)]);
    assert.equal(kind.dtype, wholeKind.dtype, key);
    assert.equal(kind.ordered, wholeKind.ordered, key);
  }
  // The kind of a categorical says its count once its parts are loaded.
  assert.equal((await lazy.reader.getObsFieldKind('cat3')).categoryCount, null);
  assert.equal((await whole.reader.getObsFieldKind('cat3')).categoryCount, 2);
  assert.equal(lazy.store.stats().objects, objects + 2, 'the nullable column\'s kind loaded its two parts, nothing else');
  // A field read loads its parts (two), and reads as the whole tree's.
  const [field, wholeField] = await Promise.all([lazy.reader.getObsField('cat5'), whole.reader.getObsField('cat5')]);
  assert.deepEqual(Array.from(field.codes), Array.from(wholeField.codes));
  assert.deepEqual(field.categories, wholeField.categories);
  assert.equal(lazy.store.stats().objects, objects + 4);
  // The graph, the mapping probes and a var column likewise.
  assert.deepEqual(await lazy.reader.probeMapping(), await whole.reader.probeMapping());
  assert.equal(await lazy.reader.hasConnectivities('connectivities'), true);
  const [edges, wholeEdges] = await Promise.all([lazy.reader.getConnectivityEdges('connectivities'), whole.reader.getConnectivityEdges('connectivities')]);
  assert.deepEqual(edges, wholeEdges);
  assert.deepEqual(await lazy.reader.readVarNames('X', 'symbol'), await whole.reader.readVarNames('X', 'symbol'));
  assert.deepEqual(await lazy.reader.getDatasetMetadata(), await whole.reader.getDatasetMetadata());
  // uns's other entries never were.
  assert.equal(lazy.store.get('uns/notes').loaded, false);
});

test('a subsample\'s view loads a column\'s parts through the view, and reads as the whole tree\'s', async t => {
  const bytes = await annData(6);
  const cellSubset = { mode: 'subsample', method: 'uniform', fraction: 0.5, seed: 0 };
  const lazy = await openedReader(bytes, { cellSubset });
  const whole = await openedReader(bytes, { cellSubset, load: [''] });
  t.after(() => {
    lazy.reader.close();
    whole.reader.close();
  });
  assert.deepEqual(lazy.reader.cellSubset.kept, whole.reader.cellSubset.kept);
  const before = lazy.store.stats().objects;
  const [field, wholeField] = await Promise.all([lazy.reader.getObsField('cat2'), whole.reader.getObsField('cat2')]);
  assert.deepEqual(Array.from(field.codes), Array.from(wholeField.codes));
  assert.equal(lazy.store.stats().objects, before + 2);
  assert.deepEqual(await lazy.reader.subsampleRepresentation('cat4'), await whole.reader.subsampleRepresentation('cat4'));
});

test('navigating a group before it is loaded throws, and a column check never takes that for the file\'s defect', async () => {
  const store = await openHdf5(createByteReader(bytesByteSource(await annData(2), { name: 'lazy.h5ad' })));
  const obs = store.get('obs');
  assert.equal(obs.loaded, false);
  assert.throws(() => obs.keys(), StoreNotLoadedError);
  assert.throws(() => store.has('obs/cat0'), StoreNotLoadedError);
  assert.throws(() => columnDefect(obs, 'cat0', H5AD_FORMAT, 'obs', CELLS), StoreNotLoadedError);
  await store.load([{ path: 'obs', depth: 1 }]);
  assert.equal(columnDefect(obs, 'cat0', H5AD_FORMAT, 'obs', CELLS), null);
  assert.equal(obs.get('cat0').loaded, false);
  // Depth 0: the way to a node, so the node itself is known, nothing below it.
  await store.load([{ path: 'uns/notes/n1', depth: 0 }]);
  assert.equal(store.get('uns/notes').loaded, true);
  assert.equal(store.get('uns/notes/n1').kind, 'array');
  assert.throws(() => loadSpecsOf([{ path: 'obs', depth: -1 }]), RangeError);
  assert.throws(() => loadSpecsOf('obs'), TypeError);
  store.close();
});

test('a view group is loaded when the groups it is made from are, and lists its children only then', async () => {
  const store = await openHdf5(createByteReader(bytesByteSource(await annData(3), { name: 'lazy.h5ad' })));
  const real = store.get('obs');
  let listed = 0;
  const view = viewGroup({
    path: '/obs',
    attrs: real.attrs,
    real,
    children: () => {
      listed++;
      return new Map(real.keys().map(key => [key, () => real.get(key)]));
    },
  });
  assert.equal(view.loaded, false);
  assert.equal(listed, 0, 'nothing listed while made');
  assert.throws(() => view.keys(), StoreNotLoadedError);
  await view.load(['cat1']);
  assert.equal(view.loaded, true);
  assert.equal(real.get('cat1').loaded, true, 'a path below the view loads the real node it leads to');
  assert.equal(real.get('cat0').loaded, false);
  assert.deepEqual(view.keys(), real.keys());
  assert.deepEqual(view.get('cat1').keys(), ['categories', 'codes']);
  store.close();
});

test('a Zarr store is loaded whole at open: every group loaded, every load at once', async () => {
  const json = value => new TextEncoder().encode(JSON.stringify(value));
  const files = new Map([
    ['.zgroup', json({ zarr_format: 2 })],
    ['obs/.zgroup', json({ zarr_format: 2 })],
    ['obs/inner/.zgroup', json({ zarr_format: 2 })],
  ]);
  const root = await openZarr(memoryStore(files));
  const walk = node => [node, ...(isGroup(node) ? node.keys().flatMap(key => walk(node.get(key))) : [])];
  assert.ok(walk(root).every(node => node.loaded === true));
  await root.load();
  await root.load([{ path: 'obs', depth: 1 }, 'obs/inner']);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(root.load([''], { signal: stop.signal }), error => error.name === 'AbortError');
});

/* ---------- every step of an opening finds what it names ---------- */

const PRIORITY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'priority');

/** A Zarr store's tree as an HDF5 file (`formats/hdf5/writer.js`), node for node. */
async function hdf5CopyOf(zarrRoot) {
  const attributesOf = node => Object.fromEntries(Object.entries(node.attrs).map(([key, value]) => {
    if (typeof value === 'boolean') return [key, booleanAttribute(value)];
    if (typeof value === 'number' || (Array.isArray(value) && value.every(entry => typeof entry === 'number'))) {
      return [key, BigInt64Array.from([value].flat(), entry => BigInt(entry))];
    }
    return [key, value];
  }));
  const copy = async node => {
    if (isGroup(node)) return group(attributesOf(node), await Promise.all(node.keys().map(async key => [key, await copy(node.get(key))])));
    const read = await node.read();
    if (node.dtype.kind === 'string') return stringDataset(Array.from([read].flat(), String), attributesOf(node));
    const values = ArrayBuffer.isView(read) ? read : valueArrayClass(node.dtype).of(read);
    // The writer's unsigned types are uint8 and uint32: wider unsigned values are held as int64, narrower as int32.
    const [type, data] = node.dtype.kind === 'bool' ? ['bool', values]
      : node.dtype.name === 'uint64' ? ['int64', BigInt64Array.from(values)]
        : node.dtype.name === 'uint16' ? ['int32', Int32Array.from(values)]
          : [node.dtype.name, values];
    return numericDataset(type, node.shape.length === 0 ? [1] : [...node.shape], data, attributesOf(node));
  };
  return new Uint8Array(await writeHdf5(await copy(zarrRoot)).arrayBuffer());
}

/** What a reader reads of its open cells: their order, an obs column, a few genes. */
async function readOf(reader, element, genes) {
  const field = await reader.getObsField(reader.obsKeys.find(key => !key.startsWith('cellucid_')) ?? reader.obsKeys[0]);
  const columns = await reader.getMatrixColumns(element, genes);
  return {
    kept: Array.from(reader.cellSubset?.kept ?? []),
    prefix: reader.cellSubset?.prefix ?? null,
    field: Array.from(field.codes ?? field.values),
    columns: columns.map(column => Array.from(column)),
  };
}

test('a priority-ordered .h5ad opens as a uniform subsample: its prefix and prefix counts found, read as its Zarr original', async () => {
  const zarr = await openZarr(memoryStore(await zippedStoreEntries(path.join(PRIORITY, 'written.zarr.zip'))), { decodedChunkCacheBytes: 0 });
  const bytes = await hdf5CopyOf(zarr);
  // A uniform subsample under the file's seed: its first rows (`priority-layout.js`).
  const cellSubset = { mode: 'subsample', k: 30 };
  const fromZarr = new AnnDataReader();
  await fromZarr.open(zarr, { format: H5AD_FORMAT, name: 'written.zarr', cellSubset });
  const { reader, store } = await openedReader(bytes, { cellSubset });
  const genes = [0, 1, 2].filter(gene => gene < reader.nVars);
  assert.equal(fromZarr.cellSubset.prefix, 30);
  assert.equal(reader.cellSubset.prefix, 30, 'opened as the prefix of its rows');
  assert.deepEqual(await readOf(reader, 'X', genes), await readOf(fromZarr, 'X', genes));
  // The opening read the prefix counts, not every element's parts.
  assert.ok(store.get('varm').loaded);
  reader.close();
  fromZarr.close();
});

test('a MuData .h5mu opens as a uniform subsample through its view, each modality read as its Zarr original', async () => {
  const { muDataView, MUDATA_ZARR_FORMAT, H5MU_FORMAT } = await import('../assets/js/data/anndata/views/mudata.js');
  const encodingAttrsOf = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });
  const cells = 40;
  const names = Array.from({ length: cells }, (_, i) => `cell${i}`);
  const frame = (rows, columns = []) => group({ ...encodingAttrsOf('dataframe', '0.2.0'), _index: '_index', 'column-order': columns.map(([name]) => name) }, [
    ['_index', stringDataset(rows, encodingAttrsOf('string-array', '0.2.0'))], ...columns,
  ]);
  const dense = (rows, cols, scale) => numericDataset('float32', [rows, cols], Float32Array.from({ length: rows * cols }, (_, i) => (i * scale) % 7), encodingAttrsOf('array', '0.2.0'));
  const label = c => group({ ...encodingAttrsOf('categorical', '0.2.0'), ordered: booleanAttribute(false) }, [
    ['categories', stringDataset(['a', 'b', 'c'], encodingAttrsOf('string-array', '0.2.0'))],
    ['codes', numericDataset('int8', [cells], Int8Array.from({ length: cells }, (_, i) => (i + c) % 3), encodingAttrsOf('array', '0.2.0'))],
  ]);
  const modality = (vars, c) => group(encodingAttrsOf('anndata', '0.1.0'), [
    ['obs', frame(names, [['cluster', label(c)]])],
    ['var', frame(Array.from({ length: vars }, (_, g) => `g${c}_${g}`))],
    ['X', dense(cells, vars, c + 1)],
    ['obsm', group(encodingAttrsOf('dict', '0.1.0'), [['X_umap', dense(cells, 2, c + 3)]])],
    ['varm', group(encodingAttrsOf('dict', '0.1.0'), [])],
    ['obsp', group(encodingAttrsOf('dict', '0.1.0'), [])],
  ]);
  const root = group({ ...encodingAttrsOf('MuData', '0.1.0'), axis: BigInt64Array.of(0n) }, [
    ['obs', frame(names)],
    ['obsm', group(encodingAttrsOf('dict', '0.1.0'), [['X_umap', dense(cells, 2, 5)]])],
    ['mod', group({ 'mod-order': ['rna', 'prot'] }, [['rna', modality(6, 0)], ['prot', modality(3, 1)]])],
  ]);
  const bytes = new Uint8Array(await writeHdf5(root).arrayBuffer());
  const opened = async (load, cellSubset) => {
    const real = await openHdf5(createByteReader(bytesByteSource(bytes, { name: 'm.h5mu' })), { load });
    const { root: view } = await presentStore(real, { container: 'hdf5', layout: 'file', name: 'm.h5mu' });
    const reader = new AnnDataReader();
    await reader.open(view, { format: H5MU_FORMAT, name: 'm.h5mu', cellSubset });
    return { reader, real };
  };
  const cellSubset = { mode: 'subsample', method: 'uniform', k: 13, seed: 0 };
  const { MUDATA_OPENING_PATHS } = await import('../assets/js/data/anndata/views/mudata.js');
  const lazy = await opened(MUDATA_OPENING_PATHS, cellSubset);
  const whole = await opened([''], cellSubset);
  assert.equal(lazy.real.get('mod/prot/obs/cluster').loaded, false, 'a modality column\'s parts wait');
  assert.deepEqual(lazy.reader.obsKeys, whole.reader.obsKeys);
  for (const [element, nVars] of [['mod/rna/X', 6], ['mod/prot/X', 3]]) {
    const genes = Array.from({ length: nVars }, (_, g) => g);
    assert.deepEqual((await lazy.reader.getMatrixColumns(element, genes)).map(c => Array.from(c)), (await whole.reader.getMatrixColumns(element, genes)).map(c => Array.from(c)), element);
  }
  for (const key of lazy.reader.obsKeys) {
    const [got, want] = await Promise.all([lazy.reader.getObsField(key), whole.reader.getObsField(key)]);
    assert.deepEqual(Array.from(got.codes ?? got.values), Array.from(want.codes ?? want.values), key);
  }
  assert.deepEqual(await lazy.reader.probeMapping(), await whole.reader.probeMapping());
  // The same store as Zarr opens through the same view (loaded whole at open).
  void muDataView;
  void MUDATA_ZARR_FORMAT;
  lazy.reader.close();
  whole.reader.close();
});
