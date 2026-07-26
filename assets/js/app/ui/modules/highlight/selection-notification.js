/**
 * Exact local-selection delivery to the connected Python/Jupyter owner.
 */

import { getNotificationCenter } from '../../../notification-center.js';

const DELIVERY_KEYS = new Set([
  'jupyterSource',
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
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError('Selection delivery options must be a plain object');
  }
  for (const key of Object.keys(options)) {
    if (!DELIVERY_KEYS.has(key)) {
      throw new TypeError(`Selection delivery contains unknown key "${key}"`);
    }
  }
  if (!Array.isArray(options.cellIndices)) {
    throw new TypeError('Selection delivery cellIndices must be an array');
  }
  const seen = new Set();
  for (let index = 0; index < options.cellIndices.length; index++) {
    if (
      !Object.hasOwn(options.cellIndices, index)
      || !Number.isSafeInteger(options.cellIndices[index])
      || options.cellIndices[index] < 0
      || seen.has(options.cellIndices[index])
    ) {
      throw new TypeError(
        'Selection delivery cellIndices must contain unique non-negative integers'
      );
    }
    seen.add(options.cellIndices[index]);
  }
  if (!SELECTION_SOURCES.has(options.source)) {
    throw new TypeError(`Unknown selection delivery source: ${options.source}`);
  }
  if (typeof options.onFailure !== 'function') {
    throw new TypeError('Selection delivery requires an onFailure callback');
  }
  if (
    options.jupyterSource !== null
    && (
      typeof options.jupyterSource !== 'object'
      || typeof options.jupyterSource.notifySelection !== 'function'
    )
  ) {
    throw new TypeError(
      'Jupyter selection source must expose notifySelection() or be null'
    );
  }
  return options;
}

export function showSelectionDeliveryFailure(error, source) {
  const exactError = error instanceof Error
    ? error
    : new TypeError('Jupyter selection delivery rejected with a non-Error value');
  console.error(`[Highlight] ${source} selection delivery failed`, exactError);
  getNotificationCenter().error(
    `Selection was saved locally, but Python notification failed: ${exactError.message}`,
    { category: 'connectivity', duration: 8_000 }
  );
}

export function deliverSelectionToJupyter(options) {
  const {
    jupyterSource,
    cellIndices,
    source,
    onFailure
  } = requireDelivery(options);
  if (jupyterSource === null) return Promise.resolve(false);

  const delivery = jupyterSource.notifySelection(cellIndices, source);
  if (!(delivery instanceof Promise)) {
    throw new TypeError('Jupyter notifySelection() must return a Promise');
  }
  return delivery.then(
    () => true,
    error => {
      onFailure(error);
      return false;
    }
  );
}
