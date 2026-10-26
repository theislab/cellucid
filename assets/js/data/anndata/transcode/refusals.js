/**
 * The refusals of the transcoders: a file Cellucid recognises and does not
 * show, each saying what to do in Python and in R. They are layout
 * refusals (`views/refusal.js`), which `open.js` shows as they are.
 *
 * @module data/anndata/transcode/refusals
 */

import { LayoutRefusal, noEmbeddingRefusal as embeddingRefusal } from '../views/refusal.js';

/** A recognised object or file Cellucid does not open; the message says what to do. */
export class RObjectRefusal extends LayoutRefusal {
  /**
   * @param {string} message
   * @param {{slot?: string|null, reason?: string}} [options] - `slot`: where
   *   in the object (`assays$RNA`)
   */
  constructor(message, { slot = null, reason = 'unsupported' } = {}) {
    super(message, { reason });
    this.name = 'RObjectRefusal';
    this.slot = slot;
  }
}

/**
 * Data with no cell embedding (D4).
 *
 * @param {string} subject - What was opened ("This Seurat object", "This MatrixMarket folder")
 * @param {{outs?: boolean, fromLink?: boolean}} [options] - `outs`: a 10x
 *   matrix, whose Cell Ranger outs/ folder holds UMAP and t-SNE projections;
 *   `fromLink`: opened from a link (a GEO sample's files), which has no
 *   outs/ folder to point to: only computing an embedding is advised
 */
export function noEmbeddingRefusal(subject, { outs = false, fromLink = false } = {}) {
  return embeddingRefusal(subject, outs && !fromLink
    ? 'The Cell Ranger outs/ folder it came from holds UMAP and t-SNE projections: open that folder.'
    : '');
}
