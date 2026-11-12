/**
 * A share of a file whose `obsm` holds a sparse array (R9M-8): describing the
 * data mapping loads `obsm` deep enough to list each entry, and the share's
 * CSR view of a sparse array made its `indptr`, `indices` and `data` on that
 * load, before its kept rows' pointers were read -- every subsample of such a
 * file failed ("could not be read again with these cells"). The view now
 * loads the stored matrix and makes its children only when they are read;
 * the array is described (a sparse array cannot be drawn) without a pointer
 * read, and its kept rows read exactly once their pointers are.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { countingStore, dense, mapping, minimalAnnData, sparse } from './helpers/anndata-store.mjs';

const N = 200;

/** Row r of the sparse array holds (r, 0) on every even row, nothing on the odd ones. */
function sparseObsm() {
  const indptr = new Int32Array(N + 1);
  const indices = [];
  const data = [];
  for (let r = 0; r < N; r++) {
    if (r % 2 === 0) {
      indices.push(0);
      data.push(r);
    }
    indptr[r + 1] = indices.length;
  }
  return sparse({ indptr, indices: Int32Array.from(indices), data: Float32Array.from(data), shape: [N, 2] });
}

async function openShare(cellSubset) {
  const umap = dense(Float32Array.from({ length: N * 2 }, (_, i) => Math.sin(i) * 10), [N, 2]);
  const tree = minimalAnnData({ nObs: N, obsm: mapping({ X_umap: umap, X_sparse: sparseObsm() }) });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'sparse-obsm.zarr', decodedChunkBytes: 0, cellSubset });
  return { reader, fetched };
}

for (const method of ['uniform', 'blocks']) {
  test(`a ${method} share of a file with a sparse obsm array is described without reading its pointers`, async () => {
    const { reader, fetched } = await openShare({ mode: 'subsample', method, k: 100, strict: true });
    assert.equal(reader.nObs, 100);
    const mark = fetched.length;
    const probes = await reader.probeMapping();
    const entry = probes.obsm.find(item => item.key === 'X_sparse');
    assert.deepEqual(
      { storage: entry.storage, shape: entry.shape, dtype: entry.dtype, nnz: entry.nnz },
      { storage: 'csr', shape: [100, 2], dtype: 'float32', nnz: null }
    );
    assert.equal(
      fetched.slice(mark).some(key => key.includes('obsm/X_sparse/indptr')),
      false,
      'describing it reads none of its row pointers'
    );
    // Its kept rows read exactly once their pointers are read.
    const order = Array.from(reader.cellSubset.openOrder);
    const view = reader._root.get('obsm/X_sparse');
    await reader._root.readRowPointers('obsm/X_sparse');
    const indptr = await view.get('indptr').read();
    const values = await view.get('data').read();
    const expected = order.filter(row => row % 2 === 0);
    assert.deepEqual(Array.from(values), expected);
    assert.equal(Number(indptr[indptr.length - 1]), expected.length);
  });
}
