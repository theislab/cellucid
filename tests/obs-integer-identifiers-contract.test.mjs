/**
 * An obs column of 64-bit integers holding values past 2^53: such values
 * are identifiers, never measurements, and
 * no number holds them exactly, so the column is read exactly as text, in
 * every reader and format, and says why in one line. A column of 64-bit
 * integers that are all safe stays numbers, exactly (float64).
 *
 * Checked through the reader and the adapter (the field listed as numbers
 * becomes a text column on its first load, its rows grown as text), through
 * the reader worker on a `.zarr.zip` (the reason crosses), through a text
 * table (a whole number past 2^53 makes its column text) and through an R
 * `integer64` column (kept as 64-bit integers, not rounded doubles).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { UNSAFE_INTEGERS_AS_TEXT, holdsUnsafeIntegers } from '../assets/js/data/anndata/values.js';
import { joinTable, readTable } from '../assets/js/data/anndata/transcode/tables.js';
import { columnOf } from '../assets/js/data/anndata/transcode/r-values.js';
import { createZipWriter } from '../assets/js/formats/zip/writer.js';
import { describeCountedCells, legendNoteTitle } from '../assets/js/app/ui/modules/legend/categorical-legend.js';
import { array, minimalAnnData, nullable, openReader, openStore, zarrEntries } from './helpers/anndata-store.mjs';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';

const N = 6;
const IDS = [9028660573968198275n, 12852006281953886911n, 15640167999235896071n, 9028660573968198275n, 2n, 18446744073709551615n];
const NEGATIVE = [-2060051150784055100n, 5n, -9007199254740993n, 0n, 7n, -1n];

function tree() {
  return minimalAnnData({
    nObs: N,
    X: null,
    obs: {
      id_u64: array(IDS, { dtype: '<u8' }),
      id_i64: array(NEGATIVE, { dtype: '<i8' }),
      at_bound: array(Array(N).fill(9007199254740992n), { dtype: '<i8' }),
      safe_i64: array([9007199254740991n, -9007199254740991n, 0n, 1n, 2n, 3n], { dtype: '<i8' }),
      nullable_ids: nullable('nullable-integer', [4611686018427387904n, 0n, 4611686018427387905n, 1n, 0n, 2n], [0, 1, 0, 0, 1, 0]),
      nullable_counts: nullable('nullable-integer', [10n, 0n, 30n, 1n, 0n, 2n], [0, 1, 0, 0, 1, 0]),
    },
  });
}

async function adapterOf() {
  const { reader } = await openReader(tree());
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  return adapter;
}

/** The labels of a category payload, cell by cell (null where missing). */
function labelsOf(payload) {
  const codes = new (payload.dtype === 'uint8' ? Uint8Array : payload.dtype === 'uint16' ? Uint16Array : Uint32Array)(payload.data);
  return Array.from(codes, code => (code === payload.missingValue ? null : payload.categories[code]));
}

test('64-bit integers past 2^53 are found without a BigInt per value, a mask passing over what is missing', () => {
  assert.equal(holdsUnsafeIntegers(BigInt64Array.of(9007199254740991n, -9007199254740991n)), false);
  assert.equal(holdsUnsafeIntegers(BigInt64Array.of(0n, 9007199254740992n)), true);
  assert.equal(holdsUnsafeIntegers(BigInt64Array.of(-9007199254740992n)), true);
  assert.equal(holdsUnsafeIntegers(BigUint64Array.of(18446744073709551615n)), true);
  assert.equal(holdsUnsafeIntegers(BigInt64Array.of(1n, 9007199254740993n), Uint8Array.of(0, 1)), false, 'a masked value is not data');
  assert.equal(holdsUnsafeIntegers(Float64Array.of(2 ** 60)), false, 'only stored integers are identifiers');
});

test('an obs column of identifiers past 2^53 is listed as numbers and reads exactly as text, saying why', async () => {
  const adapter = await adapterOf();
  const listed = Object.fromEntries(adapter.getObsFields().fields.map(field => [field.key, field.kind]));
  // Nothing is read to list a field: an integer column is listed as numbers.
  assert.equal(listed.id_u64, 'continuous');

  for (const [key, expected] of [
    ['id_u64', IDS.map(String)],
    ['id_i64', NEGATIVE.map(String)],
    ['at_bound', Array(N).fill('9007199254740992')],
    ['nullable_ids', ['4611686018427387904', null, '4611686018427387905', '1', null, '2']],
  ]) {
    const payload = await adapter.getObsFieldData(key);
    assert.equal(payload.kind, 'category', key);
    assert.equal(payload.asText, UNSAFE_INTEGERS_AS_TEXT, key);
    assert.deepEqual(labelsOf(payload), expected, `${key}: every value exactly, as its decimal text`);
    // The field is listed as the text column it is now.
    assert.deepEqual(
      { kind: payload.descriptor.kind, discovered: payload.descriptor.discovered, categories: payload.descriptor.categories },
      { kind: 'category', discovered: true, categories: null },
      key,
    );
    assert.equal(adapter.getObsFields().fields.find(field => field.key === key).kind, 'category', key);
    // Read again (its cache let go), it is text under the same categories.
    const again = await adapter.getObsFieldData(key);
    assert.deepEqual(labelsOf(again), expected, `${key} again`);
  }
  const stats = adapter.getMetadata().stats;
  assert.equal(stats.n_categorical_fields + stats.n_continuous_fields, stats.n_obs_fields);
});

test('a column of 64-bit integers that are all safe stays numbers, exactly', async () => {
  const adapter = await adapterOf();
  const safe = await adapter.getObsFieldData('safe_i64');
  assert.equal(safe.kind, 'continuous');
  assert.equal(safe.dtype, 'float64');
  assert.deepEqual(Array.from(new Float64Array(safe.data)), [9007199254740991, -9007199254740991, 0, 1, 2, 3]);
  assert.equal(safe.asText, undefined);
  const counts = await adapter.getObsFieldData('nullable_counts');
  assert.equal(counts.kind, 'continuous');
  assert.deepEqual(Array.from(new Float64Array(counts.data)), [10, NaN, 30, 1, NaN, 2]);
});

test('rows added to a column read as text are text, whatever they hold; rows of a numbers column stay numbers', async () => {
  const adapter = await adapterOf();
  const first = await adapter.getObsFieldData('id_i64');
  const rows = await adapter.getObsFieldRows('id_i64', [1, 2], { categories: first.categories });
  assert.equal(rows.kind, 'category');
  // Row 1 holds 5, a safe integer: still the text '5' of an identifier column.
  const categories = rows.categories ?? first.categories;
  assert.deepEqual(Array.from(rows.codes, code => categories[code]), ['5']);
  await adapter.getObsFieldData('safe_i64');
  const numbers = await adapter.getObsFieldRows('safe_i64', [0, 2]);
  assert.equal(numbers.kind, 'continuous');
  assert.deepEqual(Array.from(numbers.values), [9007199254740991, -9007199254740991]);
});

test('the legend says a column is text in one short line, the reason in full on demand', () => {
  const state = { pointCount: 10, cellIdentity: null };
  assert.equal(describeCountedCells(state, { asText: UNSAFE_INTEGERS_AS_TEXT, categories: ['1'] }), 'IDs past 2^53, read as text.');
  assert.equal(legendNoteTitle({ asText: UNSAFE_INTEGERS_AS_TEXT }), UNSAFE_INTEGERS_AS_TEXT);
  assert.equal(describeCountedCells(state, { categories: ['a'] }), '');
  assert.equal(legendNoteTitle({ categories: ['a'] }), '');
});

test('through the reader worker, a .zarr.zip column of identifiers arrives as text with its reason', async t => {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => name;
  t.after(() => { for (const [name, method] of originals) notifications[name] = method; });
  const parts = [];
  const zip = createZipWriter({ write: part => { parts.push(part); } });
  for (const [path, bytes] of zarrEntries(tree())) await zip.add(path, bytes);
  await zip.finish();
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(new File(parts, 'ids.zarr.zip'));
  const payload = await source.getObsFieldData('id_u64');
  assert.equal(payload.kind, 'category');
  assert.equal(payload.asText, UNSAFE_INTEGERS_AS_TEXT);
  assert.deepEqual(labelsOf(payload), IDS.map(String));
});

test('a text table column holding a whole number past 2^53 is text, kept as written', async () => {
  const bytes = new TextEncoder().encode('barcode,donor_id,n_counts\nA,9007199254740993,100\nB,12,250\nC,18446744073709551615,75\n');
  const table = await readTable({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, { cells: ['A', 'B', 'C'] });
  const { columns } = joinTable(table, 3);
  const byName = Object.fromEntries(columns.map(entry => [entry.name, entry.column]));
  assert.equal(byName.donor_id.kind, 'categorical');
  assert.deepEqual(Array.from(byName.donor_id.codes, code => byName.donor_id.categories[code]), ['9007199254740993', '12', '18446744073709551615']);
  assert.equal(byName.n_counts.kind, 'numbers');
});

test('an R integer64 column is kept as its 64-bit integers, NA missing, never rounded to doubles', async () => {
  const NA = -(2n ** 63n);
  const words = BigInt64Array.of(9007199254740993n, NA, 3n);
  const node = { kind: 'double', length: 3, values: new Float64Array(words.buffer), attributes: { class: { kind: 'string', values: ['integer64'] } } };
  const column = await columnOf(node, 3, { readRegion: null });
  assert.equal(column.kind, 'nullable-integer');
  assert.deepEqual(Array.from(column.values), [9007199254740993n, 0n, 3n]);
  assert.deepEqual(Array.from(column.mask), [0, 1, 0]);
});

/** A subsample of 40 cells whose open cells hold only small values: `big` at row `row`, 3 elsewhere. */
function subsampleTree(row, big) {
  const plain = Array.from({ length: 40 }, (_, i) => (i === row ? big : 3n));
  const nullableValues = Array.from({ length: 40 }, (_, i) => (i === row ? big : 4n));
  return minimalAnnData({
    nObs: 40,
    X: null,
    obs: {
      ids: array(plain, { dtype: '<i8' }),
      nullable_ids: nullable('nullable-integer', nullableValues, Array.from({ length: 40 }, (_, i) => (i === 0 && row !== 0 ? 1 : 0))),
    },
  });
}

async function subsampleAdapter(tree) {
  const { root } = await openStore(tree, { name: 'ids.zarr' });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'ids.zarr', cellSubset: { mode: 'subsample', method: 'uniform', k: 10, seed: 7 } });
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  return { reader, adapter };
}

test('the column is text or numbers by every cell it stores, never by the cells a subsample opens', async () => {
  // Which rows the subsample opens does not depend on the values: find one it leaves closed.
  const probe = await subsampleAdapter(subsampleTree(-1, 0n));
  const open = new Set(probe.reader._cellSubset.fileRows);
  probe.reader.close();
  const closed = Array.from({ length: 40 }, (_, i) => i).find(i => !open.has(i));
  assert.ok(closed !== undefined && open.size === 10);

  const { reader, adapter } = await subsampleAdapter(subsampleTree(closed, 9007199254740993n));
  for (const key of ['ids', 'nullable_ids']) {
    const payload = await adapter.getObsFieldData(key);
    // Every open cell holds a small value; one closed cell holds an identifier past 2^53.
    assert.equal(payload.kind, 'category', key);
    assert.equal(payload.asText, UNSAFE_INTEGERS_AS_TEXT, key);
    assert.ok(labelsOf(payload).every(label => label === null || label === '3' || label === '4'), key);
  }
  reader.close();

  // A column whose every stored value is safe stays numbers on the same subsample.
  const safe = await subsampleAdapter(subsampleTree(closed, 9007199254740991n));
  assert.equal((await safe.adapter.getObsFieldData('ids')).kind, 'continuous');
  safe.reader.close();
});
