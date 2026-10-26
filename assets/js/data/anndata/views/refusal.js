/**
 * What a layout view says when the file it recognises is one Cellucid does
 * not show: a 10x molecule table, a MuData with shared features, a count
 * matrix with no cell embedding. `open.js` (`explainFormatError`) shows the
 * message as it is, with what to do; it names both languages' commands where
 * there is something to run.
 *
 * @module data/anndata/views/refusal
 */

/**
 * A refusal of a recognised file, its message written for the person who
 * opened it.
 */
export class LayoutRefusal extends Error {
  /**
   * @param {string} message
   * @param {{reason: string}} details - `reason`: a stable word for tests
   *   and logs (`no-embedding`, `molecule-table`, `shared-features`, …)
   */
  constructor(message, { reason }) {
    super(message);
    this.name = 'LayoutRefusal';
    this.reason = reason;
  }
}

/**
 * The refusal of data that has no cell embedding (design decision D4): what
 * the file is, where its embedding may be, and how to compute one in Python
 * and in R.
 *
 * @param {string} what - The file as the message names it ("This 10x Cell
 *   Ranger matrix", "This Loom file")
 * @param {string} [where] - Where an embedding of this kind of file is kept
 *   when it has one, as a sentence
 * @returns {LayoutRefusal}
 */
export function noEmbeddingRefusal(what, where = '') {
  return new LayoutRefusal(
    `${what} has no cell embedding, and Cellucid draws cells at embedding coordinates. ` +
    (where === '' ? '' : `${where} `) +
    `${where === '' ? 'Compute' : 'Or compute'} one and open the result: ` +
    'in Python, sc.pp.normalize_total(adata); sc.pp.log1p(adata); ' +
    'sc.pp.pca(adata); sc.pp.neighbors(adata); sc.tl.umap(adata), then adata.write_h5ad(path); ' +
    'in R, Seurat::NormalizeData(), FindVariableFeatures(), ScaleData(), RunPCA() and RunUMAP(), ' +
    'then cellucid::cellucid_prepare(path, data = obj).',
    { reason: 'no-embedding' }
  );
}
