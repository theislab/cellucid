/**
 * The stored values of `obsm[key]` at `columns`, read straight from an
 * AnnData file with the reader (float32 for a float32 array, else float64):
 * what an embedding payload is made from.
 */
import { AnnDataReader } from '../../assets/js/data/anndata/reader.js';
import { openDatasetStore } from '../../assets/js/data/anndata/open.js';

/**
 * @param {File} file - An `.h5ad`, or a zipped Zarr store (`.zarr.zip`)
 * @param {string} key
 * @param {number[]} columns
 * @returns {Promise<Float32Array|Float64Array>}
 */
export async function storedObsm(file, key, columns) {
  const opened = await openDatasetStore(
    { source: { file } },
    { decodedChunkCacheBytes: 0 }
  );
  const reader = new AnnDataReader();
  try {
    await reader.open(opened.root, { format: opened.readerFormat, name: file.name, link: opened.link });
    return await reader.readObsmColumns(key, columns);
  } finally {
    reader.close();
  }
}
