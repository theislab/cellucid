/**
 * Exact local-selection delivery to the connected Python, Jupyter or R host.
 */

import { getNotificationCenter } from '../../../notification-center.js';
import { requireKeys } from '../../../../utils/exact-record.js';

const DELIVERY_KEYS = new Set([
  'viewerHostSource',
  'cellIndices',
  'source',
  'onFailure'
]);
const SELECTION_SOURCES = new Set([
  'annotation',
  'lasso',
  'knn',
  'proximity'
]);

function requireDelivery(options) {
  requireKeys(options, [], DELIVERY_KEYS, 'Selection delivery options');
  // A cell list (ascending Uint32Array) by the selection tools' contract;
  // the viewer channel checks the order while it encodes the cells.
  if (!(options.cellIndices instanceof Uint32Array)) {
    throw new TypeError('Selection delivery cellIndices must be a cell list (Uint32Array)');
  }
  if (!SELECTION_SOURCES.has(options.source)) {
    throw new TypeError(`Unknown selection delivery source: ${options.source}`);
  }
  if (typeof options.onFailure !== 'function') {
    throw new TypeError('Selection delivery requires an onFailure callback');
  }
  if (
    options.viewerHostSource !== null
    && (
      typeof options.viewerHostSource !== 'object'
      || typeof options.viewerHostSource.notifySelection !== 'function'
    )
  ) {
    throw new TypeError(
      'Viewer host selection source must expose notifySelection() or be null'
    );
  }
  return options;
}

export function showSelectionDeliveryFailure(error, source) {
  const exactError = error instanceof Error
    ? error
    : new TypeError('Viewer host selection delivery rejected with a non-Error value');
  console.error(`[Highlight] ${source} selection delivery failed`, exactError);
  getNotificationCenter().error(
    `Selection was saved locally, but Python notification failed: ${exactError.message}`,
    { category: 'connectivity', duration: 8_000 }
  );
}

export function deliverSelectionToViewerHost(options) {
  const {
    viewerHostSource,
    cellIndices,
    source,
    onFailure
  } = requireDelivery(options);
  if (viewerHostSource === null) return Promise.resolve(false);

  const delivery = viewerHostSource.notifySelection(cellIndices, source);
  if (!(delivery instanceof Promise)) {
    throw new TypeError('Viewer host notifySelection() must return a Promise');
  }
  return delivery.then(
    () => true,
    error => {
      onFailure(error);
      return false;
    }
  );
}
