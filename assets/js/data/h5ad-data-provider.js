/**
 * H5AD Data Provider for Cellucid
 *
 * This module provides a bridge between the standard Cellucid data loaders
 * and the H5AD file loader. When the active data source is an h5ad file,
 * this provider intercepts data requests and fulfills them directly from
 * the h5ad file instead of fetching URLs.
 *
 * This allows the rest of the application to work unchanged while supporting
 * h5ad files as a data source.
 */

import { getDataSourceManager } from './data-source-manager.js';

/**
 * Check if the current data source is an h5ad file
 * @returns {boolean}
 */
export function isH5adActive() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return false;

  // Check if source is local-user in h5ad mode
  if (source.getType?.() === 'local-user') {
    return source.isH5adMode?.() === true;
  }

  // Check if source is h5ad type directly
  return source.getType?.() === 'h5ad';
}

/**
 * Get the active h5ad source adapter
 * @returns {Object|null} H5AD source or adapter
 */
export function getH5adAdapter() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in h5ad mode
  if (source.getType?.() === 'local-user' && source.isH5adMode?.()) {
    return source.getH5adSource?.()?.getAdapter?.() || null;
  }

  // If h5ad source directly
  if (source.getType?.() === 'h5ad') {
    return source.getAdapter?.() || null;
  }

  return null;
}

/**
 * Get the active h5ad source
 * @returns {Object|null}
 */
export function getH5adSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in h5ad mode
  if (source.getType?.() === 'local-user' && source.isH5adMode?.()) {
    return source.getH5adSource?.() || null;
  }

  // If h5ad source directly
  if (source.getType?.() === 'h5ad') {
    return source;
  }

  return null;
}

/**
 * Load points (embedding) from h5ad source
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function h5adLoadPoints(dim) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from h5ad source
 * @returns {Object}
 */
export function h5adGetObsManifest() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getObsManifest();
}

/**
 * Load var manifest from h5ad source
 * @returns {Object}
 */
export function h5adGetVarManifest() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getVarManifest();
}

/**
 * Load obs field data from h5ad source
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function h5adLoadObsField(fieldKey) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from h5ad source
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function h5adLoadGeneExpression(geneName) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from h5ad source
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, nEdges: number}|null>}
 */
export async function h5adLoadConnectivity() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    return null;
  }

  return adapter.getConnectivityEdges();
}

/**
 * Get connectivity manifest from h5ad source
 * @returns {Promise<Object|null>}
 */
export async function h5adGetConnectivityManifest() {
  const source = getH5adSource();
  if (!source) {
    return null;
  }

  return source.getConnectivityManifest?.() || null;
}

/**
 * Get dataset identity from h5ad source
 * @returns {Object}
 */
export function h5adGetDatasetIdentity() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getMetadata();
}

/**
 * Check if a URL is an h5ad:// URL
 * @param {string} url
 * @returns {boolean}
 */
export function isH5adUrl(url) {
  return url?.startsWith('h5ad://');
}

/**
 * Parse an h5ad:// URL
 * @param {string} url
 * @returns {{datasetId: string, path: string}|null}
 */
export function parseH5adUrl(url) {
  if (!isH5adUrl(url)) return null;

  // Format: h5ad://datasetId/path
  const withoutProtocol = url.substring('h5ad://'.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { datasetId: withoutProtocol, path: '' };
  }

  return {
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}
