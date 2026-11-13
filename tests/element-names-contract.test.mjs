/**
 * Element names the app's writers make paths of: the portable rule (`data/anndata/write/names.js`, as cellucid-python and
 * cellucid-r apply it) takes at most 255 bytes in UTF-8, the longest file
 * name every platform takes; and a writer copying names it did not choose
 * writes each under its portable form and says so, never dropping a column
 * (a converted MatrixMarket folder's `CD4/CD8` and repeated metadata columns
 * must not be left out without a word) or writing a nested group in its place
 * (a copy of an `.h5ad` whose obs column is `a/b`, which anndata could not
 * read).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_ELEMENT_NAME_BYTES, folderKey, portableElementName, requireElementKey } from '../assets/js/data/anndata/write/names.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { writeAnnDataCopy } from '../assets/js/data/anndata/write/copy.js';
import { attributeValue } from '../assets/js/data/anndata/elements.js';
import { group, numericDataset, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';

const CACHE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

test('a name longer than 255 bytes in UTF-8 is refused with the rule\'s sentence', () => {
  assert.equal(MAX_ELEMENT_NAME_BYTES, 255);
  assert.equal(requireElementKey('L'.repeat(255), 'The obs column'), 'L'.repeat(255));
  assert.throws(() => requireElementKey('L'.repeat(256), 'The obs column'), /is 256 bytes long in UTF-8, longer than the 255 a file name may be/);
  // 86 CJK characters are 258 bytes: within 255 characters, past 255 bytes.
  assert.throws(() => requireElementKey('细'.repeat(86), 'The obs column'), /is 258 bytes long in UTF-8/);
});

test('a name a writer did not choose is written under its portable form, distinct from the others', () => {
  const taken = new Set([folderKey('_index')]);
  const cases = [
    ['CD4/CD8', 'CD4_CD8'], ['CD4_CD8', 'CD4_CD8_2'], ['cd4_cd8', 'cd4_cd8_3'], ['', '_'], ['..', '__'],
    ['.zattrs', '_.zattrs'], ['CON', '_CON'], ['v1.', 'v1_'], ['a:b?', 'a_b_'], ['ok', 'ok'], ['_index', '_index_2'],
  ];
  for (const [name, expected] of cases) {
    const portable = portableElementName(name, taken);
    assert.equal(portable, expected, JSON.stringify(name));
    assert.equal(requireElementKey(portable, 'x'), portable);
  }
  const long = portableElementName('细胞'.repeat(60), taken);
  assert.ok(encoder.encode(long).length <= 255 && long.startsWith('细胞'), 'cut at a character boundary');
  // Composed and decomposed é are one folder name.
  const composed = new Set();
  assert.equal(portableElementName('café', composed), 'café');
  assert.equal(portableElementName('café', composed), 'café_2');
});

test('a converted MatrixMarket folder keeps every metadata column, a name a store cannot hold under its portable form', async () => {
  const lines = rows => encoder.encode(`${rows.join('\n')}\n`);
  const matrix = encoder.encode('%%MatrixMarket matrix coordinate integer general\n2 3 3\n1 1 4\n2 2 5\n1 3 6\n');
  const files = new Map([
    ['x/matrix.mtx', new File([matrix], 'matrix.mtx')],
    ['x/features.tsv', new File([lines(['G1\tG1\tGene Expression', 'G2\tG2\tGene Expression'])], 'features.tsv')],
    ['x/barcodes.tsv', new File([lines(['A', 'B', 'C'])], 'barcodes.tsv')],
    ['x/metadata.csv', new File([lines([
      'barcode,CD4/CD8,dup,UMAP_1,UMAP_2,dup', 'A,p,1,0,1,7', 'B,q,2,1,0,8', 'C,p,3,2,2,9',
    ])], 'metadata.csv')],
  ]);
  const opened = await openDatasetStore({ source: { files, rootName: 'x' } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { memory: true } });
  const obs = opened.root.get('obs');
  await obs.load();
  const order = attributeValue(obs, 'column-order');
  for (const name of ['CD4_CD8', 'dup', 'dup_2']) assert.ok(order.includes(name), `${name} in ${JSON.stringify(order)}`);
  const positions = await opened.root.get('obs/cellucid_original_position').read();
  const second = await opened.root.get('obs/dup_2').read();
  assert.deepEqual(Array.from(positions, (cell, row) => [cell, second[row]]).sort((a, b) => a[0] - b[0]).map(([, value]) => value), [7, 8, 9]);
});

test('a copy of an .h5ad whose obs column is named a/b writes it as a_b, says so, and anndata can read it', async () => {
  const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });
  // HDF5 stores the column a/b as b in a group a, as anndata writes it.
  const h5ad = writeHdf5(group(encoding('anndata', '0.1.0'), [
    ['obs', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': ['a/b', 'score'] }, [
      ['_index', stringDataset(['c1', 'c2', 'c3'], encoding('string-array', '0.2.0'))],
      ['a', group({}, [['b', numericDataset('float32', [3], Float32Array.of(1, 2, 3), encoding('array', '0.2.0'))]])],
      ['score', numericDataset('float32', [3], Float32Array.of(4, 5, 6), encoding('array', '0.2.0'))],
    ])],
    ['var', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': [] }, [
      ['_index', stringDataset(['g1'], encoding('string-array', '0.2.0'))],
    ])],
    ['X', numericDataset('float32', [3, 1], Float32Array.of(1, 0, 2), encoding('array', '0.2.0'))],
    ['obsm', group(encoding('dict', '0.1.0'), [
      ['X_umap', numericDataset('float32', [3, 2], Float32Array.of(0, 1, 1, 0, 2, 2), encoding('array', '0.2.0'))],
    ])],
  ]));
  const opened = await openDatasetStore({ source: { file: new File([h5ad], 'slash.h5ad') } }, { decodedChunkCacheBytes: CACHE_BYTES });
  const parts = [];
  const result = await writeAnnDataCopy(opened.root, { write: async part => { parts.push(new Uint8Array(await new Blob([part]).arrayBuffer())); } });
  assert.ok(result.notes.some(note => note.includes("obs column 'a/b' is named 'a_b' in the copy")), JSON.stringify(result.notes));
  const copy = await openDatasetStore({ source: { file: new File(parts, 'copy.zarr.zip') } }, { decodedChunkCacheBytes: CACHE_BYTES });
  const obs = copy.root.get('obs');
  await obs.load();
  assert.deepEqual(attributeValue(obs, 'column-order'), ['a_b', 'score']);
  assert.deepEqual([...obs.keys()].sort(), ['_index', 'a_b', 'score'], 'no group a is left in its place');
  const positions = copy.root.get('obs/cellucid_original_position');
  const values = await copy.root.get('obs/a_b').read();
  assert.deepEqual([...values].sort(), [1, 2, 3]);
  assert.equal(positions, null, 'a copy of a file without a priority order has none');
});
