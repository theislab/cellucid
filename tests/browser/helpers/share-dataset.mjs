/**
 * A small dataset stored cell by cell, for specs about the cells a share
 * opens: a synthetic `.zarr.zip` of 2,400 cells and 40 genes (a CSR `X` of
 * up to eight genes a cell), a categorical field, a text column and a 2D
 * embedding. Small enough that every plan reads all of it at rest; a first
 * gene of 1,500 of its cells is priced at 36 round trips, so a link of 280 ms
 * a round trip or more reads genes for a sample of them
 * (`held-machine.spec.mjs`).
 *
 * @module tests/browser/helpers/share-dataset
 */

import { anndataZarrZip } from './anndata-zarr-zip.mjs';

export const SHARE_CELLS = 2400;
export const SHARE_GENES = 40;

/** The file's bytes (made anew each call: a route may hold its own). */
export function shareDataset() {
  const perCell = 8;
  const data = new Float32Array(SHARE_CELLS * perCell);
  const indices = new Int32Array(SHARE_CELLS * perCell);
  const indptr = new Int32Array(SHARE_CELLS + 1);
  for (let cell = 0; cell < SHARE_CELLS; cell++) {
    const genes = Array.from({ length: perCell }, (_, j) => (cell * 7 + j * 3) % SHARE_GENES).filter((gene, j, all) => all.indexOf(gene) === j).sort((a, b) => a - b);
    genes.forEach((gene, j) => {
      indices[indptr[cell] + j] = gene;
      data[indptr[cell] + j] = 1 + ((cell + gene) % 9);
    });
    indptr[cell + 1] = indptr[cell] + genes.length;
  }
  const end = indptr[SHARE_CELLS];
  return anndataZarrZip({
    cells: SHARE_CELLS,
    genes: Array.from({ length: SHARE_GENES }, (_, g) => `g${g}`),
    X: { data: data.slice(0, end), indices: indices.slice(0, end), indptr },
    obs: {
      cluster: { categories: ['alpha', 'beta', 'gamma', 'delta'], codes: Int8Array.from({ length: SHARE_CELLS }, (_, i) => (i * 13) % 4) },
      note: Array.from({ length: SHARE_CELLS }, (_, i) => ['low', 'mid', 'high'][(i * 7) % 3]),
    },
    obsm: { X_umap: { data: Float32Array.from({ length: SHARE_CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 10 + (i % 2) * 3), columns: 2 } },
  });
}
