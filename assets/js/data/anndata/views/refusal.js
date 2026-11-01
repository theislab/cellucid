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
 * and in R (Cellucid computes none; `prepare()` and `cellucid_prepare()`
 * write one that exists, and refuse data without one), or pass coordinates
 * already at hand.
 *
 * @param {string} what - The file as the message names it ("This 10x Cell
 *   Ranger matrix", "This Loom file")
 * @param {string} [where] - Where an embedding of this kind of file is kept
 *   when it has one, as a sentence
 * @returns {LayoutRefusal}
 */
export function noEmbeddingRefusal(what, where = '') {
  return new LayoutRefusal(
    `${what} has no cell embedding, and Cellucid draws cells at embedding coordinates (it does not compute them). ` +
    (where === '' ? '' : `${where} `) +
    `${where === '' ? 'Compute' : 'Or compute'} one and open the result: ` +
    'in Python, sc.pp.normalize_total(adata); sc.pp.log1p(adata); ' +
    'sc.pp.pca(adata); sc.pp.neighbors(adata); sc.tl.umap(adata), then adata.write_h5ad(path) ' +
    'or cellucid.prepare(path, format="h5ad", data=adata); ' +
    'in R, Seurat::NormalizeData(), FindVariableFeatures(), ScaleData(), RunPCA() and RunUMAP() ' +
    '(or scater::runUMAP()), then cellucid::cellucid_prepare(path, data = obj). ' +
    'Coordinates you already have (a UMAP table) go in as they are: ' +
    "prepare(…, embeddings={'X_umap': coordinates}) or cellucid_prepare(…, embeddings = list(X_umap = coordinates)).",
    { reason: 'no-embedding' }
  );
}

/**
 * Where an embedding of a 10x Cell Ranger matrix is, for the refusal of one
 * without, by what was opened: Cell Ranger's `outs/` folder holds UMAP and
 * t-SNE projections beside the matrix. A file on this computer is beside its
 * folder; a link opens one file, never a folder, so its folder is opened
 * from this computer once downloaded (no provider shares a folder, and an
 * archive of one is not a format Cellucid reads); an `outs/` folder opened
 * without projections was run without its secondary analysis. The file
 * view's refusal (`views/tenx-h5.js`) and a host's that will not let this
 * site read the file (`data/sources/remote-file.js`) say the same.
 *
 * @param {'file'|'folder'} opened
 * @param {boolean} fromLink
 * @returns {string}
 */
export function tenxEmbeddingHint(opened, fromLink) {
  if (opened === 'folder') {
    return 'Its analysis/ folder holds no UMAP or t-SNE projection (Cell Ranger was run with --nosecondary).';
  }
  return fromLink
    ? 'Cell Ranger writes UMAP and t-SNE projections beside it, in the outs/ folder, which a link to one file cannot ' +
      'bring along: download the whole outs/ folder and open it from this computer (Open… › Folder…).'
    : 'Cell Ranger writes UMAP and t-SNE projections beside it: open the whole outs/ folder (Open… › Folder…), ' +
      'which holds this file and analysis/.';
}
