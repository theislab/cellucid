/**
 * A Seurat reduction larger than one `ArrayBuffer` is converted.
 *
 * The converter keeps a reduction as float64, as R stores it
 * (`transcode/seurat.js`, `transcode/priority.js`): 50 principal components
 * are 400 bytes a cell, so a Seurat object of more than 5,363,466 cells
 * holds a reduction past Chromium's one-`ArrayBuffer` cap (2,145,386,496
 * bytes). Every array the converter makes of it (placed by cell name, put in
 * priority order) is made by `allocateTypedArray`, which takes a WebAssembly
 * memory (up to 2^32 bytes) where the engine refuses. Here the engine's cap
 * is stood in for by a `Float64Array` that refuses more than a reduction's
 * elements, and a real Seurat file converts through the memory route to the
 * same values, bit for bit, as without the cap.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { allocateTypedArray } from '../assets/js/data/sparse-column-index.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { MEMORY_MAX_BYTES, allocateLargeArray, isMemoryBacked } from '../assets/js/utils/large-arrays.js';

/** Chromium's one-ArrayBuffer cap (measured 2026-10-28; `utils/large-arrays.js`). */
const CHROMIUM_ARRAY_BUFFER_BYTES = 2_145_386_496;
const CACHE_BYTES = 64 * 1024 * 1024;

const archive = await openZipArchive(createByteReader(bytesByteSource(
  new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))),
  { name: 'corpus.zip' }
)));
const corpusFile = async name => new File([(await archive.entry(`rds/${name}`).read()).slice()], name);

/**
 * A Float64Array whose engine refuses more than `cap` elements in one
 * buffer, as Chromium refuses past its cap; `refused` records each length
 * refused.
 */
function cappedFloat64(cap, refused) {
  return class CappedFloat64Array extends Float64Array {
    constructor(...args) {
      if (args.length === 1 && typeof args[0] === 'number' && args[0] > cap) {
        refused.push(args[0]);
        throw new RangeError('Array buffer allocation failed');
      }
      super(...args);
    }
  };
}

/** Every obsm array of a converted Seurat file, by key, as plain numbers. */
async function convertedObsm(file) {
  const opened = await openDatasetStore({ source: { file } }, { decodedChunkCacheBytes: CACHE_BYTES });
  try {
    const obsm = opened.root.get('obsm');
    const out = {};
    for (const key of obsm.keys()) {
      const node = obsm.get(key);
      out[key] = { shape: [...node.shape], values: Array.from(await node.read()) };
    }
    return out;
  } finally {
    opened.root.close?.();
  }
}

test('a float64 reduction of 50 components passes Chromium\'s cap above 5,363,466 cells and fits a WebAssembly memory', () => {
  const bytesPerCell = 50 * Float64Array.BYTES_PER_ELEMENT;
  assert.equal(Math.floor(CHROMIUM_ARRAY_BUFFER_BYTES / bytesPerCell), 5_363_466);
  // Six million cells: past the cap, within one memory (2^32 bytes holds 10,737,418 such cells).
  assert.ok(6_000_000 * bytesPerCell > CHROMIUM_ARRAY_BUFFER_BYTES);
  assert.ok(6_000_000 * bytesPerCell <= MEMORY_MAX_BYTES);
  assert.equal(Math.floor(MEMORY_MAX_BYTES / bytesPerCell), 10_737_418);
});

test('a reduction the engine refuses as one ArrayBuffer is made in a WebAssembly memory, NaN-filled as placed', () => {
  const refused = [];
  const Capped = cappedFloat64(99, refused);
  const nObs = 40;
  const columns = 5;
  const direct = allocateLargeArray(Capped, nObs * columns);
  assert.ok(isMemoryBacked(direct));
  assert.equal(direct.length, nObs * columns);
  // The converter's allocation: through allocateTypedArray, then filled.
  const placed = allocateTypedArray(Capped, nObs * columns, 'A reduction placed by cell name').fill(Number.NaN);
  assert.ok(isMemoryBacked(placed));
  assert.equal(placed.length, nObs * columns);
  assert.ok(placed.every(Number.isNaN));
  assert.deepEqual(refused, [nObs * columns, nObs * columns]);
});

test('a Seurat file converts its reductions through the memory route to the same values', async () => {
  const name = 'seurat5_gzip.rds';
  const expected = await convertedObsm(await corpusFile(name));
  const pca = expected.X_pca;
  assert.ok(pca !== undefined, 'the file has a PCA reduction');
  const reductionLength = pca.shape[0] * pca.shape[1];
  const refused = [];
  const native = globalThis.Float64Array;
  // Every float64 array of a reduction's size or more is refused one ArrayBuffer.
  globalThis.Float64Array = cappedFloat64(reductionLength - 1, refused);
  let capped;
  try {
    capped = await convertedObsm(await corpusFile(name));
  } finally {
    globalThis.Float64Array = native;
  }
  assert.ok(refused.includes(reductionLength), `the ${reductionLength}-value reduction was refused one ArrayBuffer`);
  assert.deepEqual(Object.keys(capped).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) {
    assert.deepEqual(capped[key].shape, expected[key].shape, `obsm['${key}'] shape`);
    assert.deepEqual(capped[key].values, expected[key].values, `obsm['${key}'] values, bit for bit`);
  }
});
