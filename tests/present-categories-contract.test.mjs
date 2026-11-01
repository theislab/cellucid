/**
 * A categorical obs field whose dictionary has more categories than there
 * are open cells (barcodes kept as a categorical: CELLxGENE's soundlife atlas
 * has 1.2M of them, 35 MB) is coded by the categories its open cells hold
 * (`AnnDataReader._readPresentCategorical`):
 *
 * - its codes are read first, then only the labels (and `uns` colours) of
 *   the stored categories they name: a share of the cells reads a share of
 *   the dictionary, never all of it;
 * - its categories are those, in stored order, each cell's label exactly the
 *   one its stored code names; colours are each category's with every
 *   category open (the file's at its stored position, else Cellucid's at
 *   that position);
 * - an opening grown in place keeps every category found and adds the ones
 *   the added cells hold, in stored order (the page recodes by label), and
 *   reads only their labels;
 * - a dictionary no larger than the open cells is read whole, as stored.
 */

import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, categorical, countingStore, dataFrame, mapping, strings } from './helpers/anndata-store.mjs';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { H5AD_FORMAT, ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { getCategoryColor, presentCategoryPalette } from '../assets/js/data/palettes.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { booleanAttribute, group, numericDataset, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { setNextCellSubsetRequest } from '../assets/js/data/cell-subset-policy.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { LinkMeter } from '../assets/js/formats/io/link.js';

const CELLS = 4000;
const PER_CHUNK = 100;
/** Cell `i` holds category `(i * 7) % CELLS` (a permutation: every category is one cell's). */
const storedCode = i => (i * 7) % CELLS;
const label = c => `BC${String(c).padStart(5, '0')}-${c % 3}`;
const color = c => `#${(c * 2654435761 >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;

function tree({ colors = true } = {}) {
  const children = {
    obs: dataFrame({
      _index: strings(Array.from({ length: CELLS }, (_, i) => `cell${i}`), { chunks: [500] }),
      barcode: categorical(
        Int32Array.from({ length: CELLS }, (_, i) => (i % 97 === 5 ? -1 : storedCode(i))),
        strings(Array.from({ length: CELLS }, (_, c) => label(c)), { chunks: [PER_CHUNK] }),
        { codesDtype: '<i4' },
      ),
      small: categorical(Int8Array.from({ length: CELLS }, (_, i) => i % 3), ['x', 'y', 'z']),
    }),
    var: dataFrame({ _index: strings(['g0']) }),
  };
  if (colors) children.uns = mapping({ barcode_colors: strings(Array.from({ length: CELLS }, (_, c) => color(c)), { chunks: [PER_CHUNK] }) });
  return annData(children);
}

/**
 * A link whose requests carry 4 KiB: a dictionary of 4,000 categories is
 * more than one request reads (at 1.2M categories, CELLxGENE's 8 MiB
 * requests are the same case).
 */
const SMALL_REQUESTS = Object.freeze({ mergeGapBytes: 0, maxRequestBytes: 4096 });

async function open(cellSubset, { carry = null, colors = true } = {}) {
  const counting = countingStore(tree({ colors }));
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes: 0, cellSubset, carry, link: SMALL_REQUESTS });
  return { reader, fetched: counting.fetched, root };
}

/** The file row of each open cell. */
const fileRows = reader => Array.from(reader.cellSubset?.fileRows ?? reader.cellSubset?.openOrder ?? reader.cellSubset?.kept ?? Array.from({ length: reader.nObs }, (_, i) => i));

/** Each open cell's label, as the whole dictionary names it. */
const expectedLabels = rows => rows.map(row => (row % 97 === 5 ? null : label(storedCode(row))));

/** Chunk keys of `path` among `fetched` (Zarr v2: `<path>/<chunk>`). */
const chunksOf = (fetched, path) => new Set(fetched.filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/') && !key.endsWith('.zarray')));

test('a share reads its codes, then the labels and colours of the categories they name alone', async () => {
  const { reader, fetched } = await open({ mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 3 });
  const n = reader.nObs;
  assert.ok(n < CELLS && n > 10, `opened ${n} cells`);
  const info = await reader.getObsFieldInfo('barcode');
  assert.deepEqual([info.present, info.categoryCount, info.categories], [true, CELLS, null], 'no label is read before the codes');
  assert.equal(chunksOf(fetched, 'obs/barcode/categories').size, 0);

  const field = await reader.getObsField('barcode');
  const rows = fileRows(reader);
  const present = [...new Set(rows.filter(row => row % 97 !== 5).map(storedCode))].sort((a, b) => a - b);
  assert.deepEqual(Array.from(field.present.stored), present, 'the stored categories the open cells name, ascending');
  assert.deepEqual([...field.categories], present.map(label), 'their labels, in stored order');
  assert.deepEqual(field.present.colors, present.map(color));
  assert.equal(field.present.count, CELLS);
  assert.deepEqual(Array.from(field.codes, code => (code < 0 ? null : field.categories[code])), expectedLabels(rows), 'each cell its own label');

  // Only the dictionary's chunks holding a present category were read.
  const needed = new Set(present.map(c => String(Math.floor(c / PER_CHUNK))));
  const read = chunksOf(fetched, 'obs/barcode/categories');
  assert.ok(read.size <= needed.size && read.size < CELLS / PER_CHUNK, `read ${read.size} of ${CELLS / PER_CHUNK} chunks for ${needed.size}`);
  for (const key of read) assert.ok(needed.has(key.split('/').pop()), `chunk ${key} holds no present category`);
  assert.ok(chunksOf(fetched, 'uns/barcode_colors').size <= needed.size);

  // A dictionary no larger than the open cells is read as stored.
  const small = await reader.getObsField('small');
  assert.equal(small.present, undefined);
  assert.deepEqual([...small.categories], ['x', 'y', 'z']);
});

test('present categories in every chunk of the dictionary: it is read as the whole array is, each chunk once, the present ones picked', async () => {
  const { reader, fetched } = await open({ mode: 'subsample', method: 'uniform', fraction: 0.5, seed: 3 });
  const field = await reader.getObsField('barcode');
  const rows = fileRows(reader);
  assert.deepEqual(Array.from(field.codes, code => (code < 0 ? null : field.categories[code])), expectedLabels(rows));
  assert.ok(field.categories.length < CELLS, 'only the present categories listed');
  const keys = fetched.filter(key => key.startsWith('obs/barcode/categories/') && !key.endsWith('.zarray'));
  assert.equal(new Set(keys).size, keys.length, 'each chunk once');
  assert.equal(keys.length, CELLS / PER_CHUNK);
});

test('a dictionary one request of the link reads is read whole: every category listed, the unused ones too', async () => {
  const counting = countingStore(tree());
  const root = await openZarr(counting.store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'case.zarr', decodedChunkBytes: 0, link: { mergeGapBytes: 0, maxRequestBytes: 8 << 20 }, cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 3 } });
  const field = await reader.getObsField('barcode');
  assert.equal(field.present, undefined);
  assert.equal(field.categories.length, CELLS);
});

test('colours: the file\'s at each stored position, else Cellucid\'s at that position', () => {
  const stored = Uint32Array.of(3, 70, 2999);
  assert.deepEqual(presentCategoryPalette(null, stored), Array.from(stored, c => [...getCategoryColor(c)].slice(0, 3)));
  const file = presentCategoryPalette(['#ff0000', '#00ff00', '#0000ff'], stored);
  assert.deepEqual(file, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  // One colour that is not hex: Cellucid's, for every category (never mixed).
  assert.deepEqual(presentCategoryPalette(['#ff0000', 'red', '#0000ff'], stored), presentCategoryPalette(null, stored));
});

test('a palette shorter than the dictionary is none; rows of the open cells are coded the same way', async () => {
  const { reader } = await open({ mode: 'subsample', method: 'uniform', fraction: 0.02, seed: 5 }, { colors: false });
  const whole = await reader.getObsField('barcode');
  assert.equal(whole.present.colors, null);
  const n = reader.nObs;
  const part = await reader.getObsField('barcode', { rows: [3, Math.min(n, 40)] });
  assert.deepEqual(Array.from(part.codes), Array.from(whole.codes.subarray(3, Math.min(n, 40))));
  assert.equal(part.categories, whole.categories, 'no category added: the same list');
});

test('an opening grown in place keeps every category and adds the added cells\' in stored order, reading only theirs', async () => {
  const first = await open({ mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 11 });
  const before = await first.reader.getObsField('barcode');
  const shown = [...before.categories];
  const grown = await open({ mode: 'subsample', method: 'uniform', fraction: 0.03, seed: 11 }, { carry: first.reader });
  const { reader, fetched } = grown;
  assert.ok(reader.nObs > first.reader.nObs);
  const from = first.reader.nObs;
  // The page reads the added rows (`getObsFieldRows`), coded with every category found.
  const added = await reader.getObsField('barcode', { rows: [from, reader.nObs], categories: shown });
  const rows = fileRows(reader);
  assert.deepEqual(Array.from(added.codes, code => (code < 0 ? null : added.categories[code])), expectedLabels(rows.slice(from)));
  for (const known of shown) assert.ok(added.categories.includes(known), `kept ${known}`);
  const stored = Array.from(added.present.stored);
  assert.deepEqual(stored, [...stored].sort((a, b) => a - b), 'stored order');
  assert.deepEqual([...added.categories], stored.map(label));
  // Only categories the first opening had not found were read: their chunks.
  const newOnes = stored.filter(c => !before.present.stored.includes(c));
  const needed = new Set(newOnes.map(c => String(Math.floor(c / PER_CHUNK))));
  for (const key of chunksOf(fetched, 'obs/barcode/categories')) assert.ok(needed.has(key.split('/').pop()), `chunk ${key} re-read`);

  // A whole read of the grown opening is the same coding.
  const whole = await reader.getObsField('barcode');
  assert.deepEqual([...whole.categories], [...added.categories]);
  assert.deepEqual(Array.from(whole.codes, code => (code < 0 ? null : whole.categories[code])), expectedLabels(rows));
  // A clear of the cache keeps the coding (the page holds codes under it).
  reader.clearCache();
  const again = await reader.getObsField('barcode');
  assert.deepEqual([...again.categories], [...whole.categories]);
});

test('another reading of other cells is coded anew; a field read whole first stays read whole', async () => {
  const first = await open({ mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 1 });
  await first.reader.getObsField('barcode');
  const other = await open({ mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 2 }, { carry: first.reader });
  const field = await other.reader.getObsField('barcode');
  const rows = fileRows(other.reader);
  assert.deepEqual([...field.categories], [...new Set(rows.filter(row => row % 97 !== 5).map(storedCode))].sort((a, b) => a - b).map(label));

  const all = await open({ mode: 'all' });
  const full = await all.reader.getObsField('barcode');
  assert.equal(full.present, undefined, 'every cell open: the dictionary is no larger than the cells');
  assert.equal(full.categories.length, CELLS);
});

const enc = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/** An `.h5ad` of `n` cells whose `barcode` categorical names category `(i * 11) % n` in cell `i`, with an embedding and colours. */
async function barcodeH5ad(n) {
  const codes = Int32Array.from({ length: n }, (_, i) => (i * 11) % n);
  const root = group(enc('anndata', '0.1.0'), [
    ['obs', group({ ...enc('dataframe', '0.2.0'), _index: '_index', 'column-order': ['barcode'] }, [
      ['_index', stringDataset(Array.from({ length: n }, (_, i) => `cell${i}`), enc('string-array', '0.2.0'))],
      ['barcode', group({ ...enc('categorical', '0.2.0'), ordered: booleanAttribute(false) }, [
        ['categories', stringDataset(Array.from({ length: n }, (_, c) => label(c)), enc('string-array', '0.2.0'))],
        ['codes', numericDataset('int32', [n], codes, enc('array', '0.2.0'))],
      ])],
    ])],
    ['var', group({ ...enc('dataframe', '0.2.0'), _index: '_index', 'column-order': [] }, [
      ['_index', stringDataset(['g0'], enc('string-array', '0.2.0'))],
    ])],
    ['obsm', group(enc('dict', '0.1.0'), [
      ['X_umap', numericDataset('float32', [n, 2], Float32Array.from({ length: n * 2 }, (_, i) => (i * 13) % 101), enc('array', '0.2.0'))],
    ])],
    ['uns', group(enc('dict', '0.1.0'), [['barcode_colors', stringDataset(Array.from({ length: n }, (_, c) => color(c)), enc('string-array', '0.2.0'))]])],
  ]);
  return { codes, bytes: new Uint8Array(await writeHdf5(root).arrayBuffer()) };
}

test('an .h5ad share reads the categories its cells name, exactly', async () => {
  const n = 3000;
  const { codes, bytes } = await barcodeH5ad(n);
  const requests = [];
  const base = bytesByteSource(bytes, { name: 'case.h5ad' });
  const source = { ...base, read(offset, length, options) { requests.push(length); return base.read(offset, length, options); } };
  const store = await openHdf5(createByteReader(source));
  const reader = new AnnDataReader();
  await reader.open(store, { format: H5AD_FORMAT, name: 'case.h5ad', link: SMALL_REQUESTS, cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 9 } });
  const before = requests.reduce((sum, length) => sum + length, 0);
  const field = await reader.getObsField('barcode');
  const fetchedBytes = requests.reduce((sum, length) => sum + length, 0) - before;
  const rows = fileRows(reader);
  assert.deepEqual(Array.from(field.codes, code => field.categories[code]), rows.map(row => label(codes[row])));
  assert.equal(field.present.count, n);
  assert.equal(field.categories.length, new Set(rows.map(row => codes[row])).size);
  // Far less than the dictionary's references and heap (~16 + ~32 bytes a category).
  assert.ok(fetchedBytes < n * 16, `read ${fetchedBytes} bytes for ${field.categories.length} of ${n} categories`);
});

function quiet(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss', 'progress', 'updateProgress', 'success'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => `${name}-id`;
  const { log, warn, info } = console;
  console.log = console.warn = console.info = () => {};
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
    Object.assign(console, { log, warn, info });
  });
}

test('through the reader worker and the adapter: the page gets the present categories, their stored count and colours, and grows them in place', async t => {
  quiet(t);
  // The reader worker's link to a local file carries 32 MiB a request: as
  // small as a dictionary of 3,000 categories needs, for this test.
  const descriptor = Object.getOwnPropertyDescriptor(LinkMeter.prototype, 'policyRequestBytes');
  Object.defineProperty(LinkMeter.prototype, 'policyRequestBytes', { configurable: true, get: () => 4096 });
  t.after(() => Object.defineProperty(LinkMeter.prototype, 'policyRequestBytes', descriptor));
  const n = 3000;
  const { codes, bytes } = await barcodeH5ad(n);
  setNextCellSubsetRequest({ mode: 'subsample', method: 'uniform', fraction: 0.01, seed: 2, strict: true });
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(new File([bytes], 'barcodes.h5ad'));
  let adapter = source.getAdapter();
  const listed = adapter.getObsFields().fields.find(field => field.key === 'barcode');
  assert.equal(listed.categories, null, 'nothing read at open');
  const first = await adapter.getObsFieldData('barcode');
  const open = Array.from(source.getCellSubset().openOrder);
  const present = [...new Set(open.map(row => codes[row]))].sort((a, b) => a - b);
  assert.deepEqual([...first.categories], present.map(label));
  assert.equal(first.storedCategoryCount, n);
  assert.deepEqual(first.palette, presentCategoryPalette(present.map(color), Uint32Array.from(present)));
  const firstCodes = new Uint8Array(first.data);
  assert.deepEqual(Array.from(firstCodes, code => first.categories[code]), open.map(row => label(codes[row])));

  // Grown in place: the added rows are coded with every category shown kept, in stored order.
  const { resized } = await source.reopenCells({ cellSubset: { mode: 'subsample', method: 'uniform', fraction: 0.03, seed: 2 } });
  assert.ok(resized !== null && resized.from === open.length, 'grown in place');
  adapter = source.getAdapter();
  const added = await adapter.getObsFieldRows('barcode', [resized.from, resized.to], { categories: first.categories });
  const grownOpen = Array.from(source.getCellSubset().openOrder);
  const grownPresent = [...new Set(grownOpen.map(row => codes[row]))].sort((a, b) => a - b);
  assert.deepEqual([...added.categories], grownPresent.map(label));
  assert.deepEqual(added.palette, presentCategoryPalette(grownPresent.map(color), Uint32Array.from(grownPresent)));
  assert.deepEqual(Array.from(added.codes, code => added.categories[code]), grownOpen.slice(resized.from).map(row => label(codes[row])));
  // The colour each category had is the colour it keeps.
  for (const [i, category] of first.categories.entries()) {
    assert.deepEqual(added.palette[added.categories.indexOf(category)], first.palette[i], category);
  }
});

test('the legend says how many of the stored categories are among the open cells', async () => {
  const { describeCountedCells } = await import('../assets/js/app/ui/modules/legend/categorical-legend.js');
  const state = { pointCount: 240, cellIdentity: { nOriginal: 1200 } };
  assert.equal(describeCountedCells(state, { categories: ['a', 'b'], storedCategoryCount: 1200 }),
    'Counted on the 240 of 1,200 cells open. 2 of its 1,200 categories are among them.');
  assert.equal(describeCountedCells({ pointCount: 1200, cellIdentity: { nOriginal: 1200 } }, { categories: ['a'], storedCategoryCount: 5000 }),
    '1 of its 5,000 categories are among the cells.');
  assert.equal(describeCountedCells(state, { categories: ['a', 'b'] }), 'Counted on the 240 of 1,200 cells open.');
});

