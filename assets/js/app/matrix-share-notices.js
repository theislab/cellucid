/**
 * @fileoverview A matrix read after its map
 * (`data/anndata/transcode/matrix-market.js`): the page says the pass over
 * it while it runs (one notification: for how many cells, how many bytes,
 * how far), and once the open cells were read again on the store it made,
 * reads every loaded gene on the cells it holds
 * (`DataState.readGenesForMoreCells`). A gene picked before any cell's
 * matrix rows are held waits for the share in the reader worker
 * (`anndata-reader-worker.js` `awaitHeldGenes`) and is drawn with its
 * values; meanwhile the page states the opening's gene sample, no cell read
 * (`DataState.getGeneSample`), never every cell.
 *
 * @module matrix-share-notices
 */

import { onMatrixShare } from '../data/anndata-reader-client.js';
import { getNotificationCenter } from './notification-center.js';
import { formatBytes, formatCount, formatCountOf } from '../utils/format-units.js';
import { isCancellation } from '../utils/abort.js';

/**
 * Say every reader's matrix passes and read their genes into `state`.
 *
 * @param {Object} state - DataState
 * @returns {() => void} Stops
 */
export function installMatrixShareNotices(state) {
  const notifications = getNotificationCenter();
  let id = null;
  return onMatrixShare(message => {
    if (message.event === 'genes-arriving') {
      const text = `Reading the matrix (${formatBytes(message.bytes)}) for the genes of ${formatCountOf(message.cells, 'cell')} of ${formatCount(message.of)}`;
      id = notifications.loading(text, id === null ? { category: 'data' } : { id, category: 'data' });
      return;
    }
    if (message.error !== undefined) {
      const text = `The matrix could not be read: ${message.error.message}`;
      if (id === null) notifications.error(text, { category: 'data' });
      else notifications.fail(id, text);
      id = null;
      return;
    }
    const sample = message.sample ?? null;
    if (id !== null) {
      notifications.complete(id, sample === null ? 'Genes are read for every open cell' : `Genes are read for ${formatCountOf(sample.cells, 'cell')}`);
      id = null;
    }
    // A growth asked for by the person (Genes read for) reads them itself.
    if (state.getGeneSampleGrowth?.() != null) return;
    state.readGenesForMoreCells(sample?.cells ?? state.pointCount).catch(error => {
      if (!isCancellation(error)) console.error('[Cellucid] The genes of the matrix read could not be shown:', error);
    });
  });
}
