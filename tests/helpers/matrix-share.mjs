/**
 * A matrix read after its map (`assets/js/data/anndata/transcode/matrix-market.js`):
 * its share read in the reader, and the open cells read again on it, before
 * a test reads its genes (the page does so on `genes-arrived`,
 * `app/matrix-share-notices.js`).
 */

import { onMatrixShare } from '../../assets/js/data/anndata-reader-client.js';

/**
 * Resolve once the dataset open in `adapter` has its genes: at once when
 * its matrix is not read after its map or has arrived already.
 *
 * @param {Object} adapter - An AnnData adapter (its `_loader`, the reader client)
 * @returns {Promise<void>}
 */
export function matrixArrived(adapter) {
  const client = adapter?._loader ?? null;
  return new Promise((resolve, reject) => {
    const stop = onMatrixShare(message => {
      if (message.client !== client || message.event !== 'genes-arrived') return;
      stop();
      if (message.error !== undefined) reject(message.error);
      else resolve();
    });
    if (client?.geneSample?.fit?.limit !== 'stream') {
      stop();
      resolve();
    }
  });
}
