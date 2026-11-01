/**
 * Codecs one container's reader decodes are decoded wherever the same bytes
 * arrive: hdf5plugin's Blosc, Zstandard and LZ4 HDF5 filters read with the
 * Blosc, zstd and LZ4 decoders the Zarr reader has, and Zarr arrays
 * compressed with numcodecs' bz2 and lzma (xz) read with the decompressors
 * the R reader has, and hdf5plugin's bitshuffle filter (every way it
 * stores a chunk; an AnnData written with it) read with the WebAssembly
 * module's bitshuffle, LZ4 and zstd (`scripts/generate-codec-fixtures.py`).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { configureDecodePool } from '../assets/js/formats/io/decode-pool.js';
import { createNodeDecodeWorker } from './helpers/node-decode-worker.mjs';

const FIXTURES = new URL('./fixtures/codecs/', import.meta.url);
const EXPECTED = Float32Array.from({ length: 60 }, (_, i) => i * 0.5 + 1);

test('hdf5plugin\'s Blosc, Zstandard and LZ4 filters are undone', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('hdf5plugin-filters.h5', FIXTURES)));
  const root = await openHdf5(createByteReader(bytesByteSource(bytes, { name: 'hdf5plugin-filters.h5' })));
  for (const name of ['blosc', 'zstd', 'lz4']) {
    const values = await root.get(name).read();
    assert.deepEqual(Array.from(values), Array.from(EXPECTED), name);
    // A part of the array reads the chunks it lies in.
    assert.deepEqual(Array.from(await root.get(name).read([[5, 9], [1, 3]])), [26, 27, 31, 32, 36, 37, 41, 42].map(v => v * 0.5 + 1), `${name} part`);
  }
});

test('Zarr arrays compressed with numcodecs\' bz2, lzma and Blosc-zlib (every shuffle) are decoded', async () => {
  for (const name of ['bz2', 'lzma', 'blosc_zlib_noshuffle', 'blosc_zlib_bitshuffle', 'blosc_zlib_blocks']) {
    const entries = new Map([['.zgroup', new TextEncoder().encode('{"zarr_format":2}')]]);
    const folder = new URL(`${name}/`, FIXTURES);
    for (const file of readdirSync(folder, { all: true })) entries.set(`a/${file}`, new Uint8Array(readFileSync(new URL(file, folder))));
    const root = await openZarr(memoryStore(entries));
    assert.deepEqual(Array.from(await root.get('a').read()), Array.from(EXPECTED), name);
  }
});

const BITSHUFFLE = JSON.parse(readFileSync(new URL('bitshuffle.json', FIXTURES), 'utf8'));
const openFixture = name => openHdf5(createByteReader(bytesByteSource(new Uint8Array(readFileSync(new URL(name, FIXTURES))), { name })));
const sumOf = values => Array.from(values, Number).reduce((sum, value) => sum + value, 0);

async function readBitshuffled() {
  const root = await openFixture('hdf5plugin-bitshuffle.h5');
  for (const [name, { sum, first, last }] of Object.entries(BITSHUFFLE).filter(([key]) => key !== 'h5ad')) {
    const values = await root.get(name).read();
    assert.deepEqual(Array.from(values.subarray(0, 5), Number), first, `${name} first`);
    assert.deepEqual(Array.from(values.subarray(values.length - 5), Number), last, `${name} last`);
    assert.ok(Math.abs(sumOf(values) - sum) <= Math.abs(sum) * 1e-12, `${name} sum`);
  }
}

test('hdf5plugin\'s bitshuffle filter is undone: LZ4, zstd and stored blocks, every element size, short last blocks and elements left over', async () => {
  configureDecodePool({ createWorker: null });
  await readBitshuffled();
  // The same on decode workers, where the reader sends chunks large enough.
  configureDecodePool({ createWorker: () => createNodeDecodeWorker(), size: 2, minBytes: 1024 });
  try {
    await readBitshuffled();
  } finally {
    configureDecodePool();
  }
});

test('an AnnData written with hdf5plugin\'s bitshuffle reads in full: matrix, categorical, strings, embedding', async () => {
  const root = await openFixture('bitshuffle.h5ad');
  await root.load(['X', 'obsm', 'obs']);
  const expected = BITSHUFFLE.h5ad;
  const [data, indices, indptr] = await Promise.all(['X/data', 'X/indices', 'X/indptr'].map(path => root.get(path).read()));
  assert.equal(data.length, expected.nnz);
  assert.equal(Number(indptr.at(-1)), expected.nnz);
  const sums = new Float64Array(expected.column_sums.length);
  for (let i = 0; i < data.length; i++) sums[Number(indices[i])] += data[i];
  sums.forEach((sum, column) => assert.ok(Math.abs(sum - expected.column_sums[column]) < 1e-4, `column ${column}`));
  assert.ok(Math.abs(sumOf(await root.get('obsm/X_umap').read()) - expected.umap_sum) < 1e-3);
  const codes = await root.get('obs/group/codes').read();
  const categories = await root.get('obs/group/categories').read();
  const counts = {};
  for (const code of codes) counts[categories[code]] = (counts[categories[code]] ?? 0) + 1;
  assert.deepEqual(counts, expected.group_counts);
  const names = await root.get('obs/_index').read();
  assert.deepEqual([names[0], names[499]], ['cell0', 'cell499']);
});

test('a Blosc-zlib frame decodes to the same bytes with either DEFLATE decoder the probe may choose', async () => {
  const { bloscDecode } = await import('../assets/js/formats/zarr/codecs/blosc.js');
  for (const name of ['blosc_zlib_noshuffle', 'blosc_zlib_bitshuffle', 'blosc_zlib_blocks']) {
    const folder = new URL(`${name}/`, FIXTURES);
    for (const file of readdirSync(folder).filter(entry => !entry.startsWith('.'))) {
      const frame = new Uint8Array(readFileSync(new URL(file, folder)));
      const size = 4 * 4 * 5;
      const key = `deflate:${Math.floor(Math.log2(size))}`;
      const native = await bloscDecode(frame, size, { [key]: 'native' });
      const fflate = await bloscDecode(frame, size, { [key]: 'fflate' });
      assert.deepEqual(fflate, native, `${name}/${file}`);
      const chunk = Number(file.split('.')[0]);
      assert.deepEqual(Array.from(new Float32Array(native.buffer, native.byteOffset, 20)), Array.from(EXPECTED.subarray(chunk * 20, chunk * 20 + 20)), `${name}/${file}`);
    }
  }
});
