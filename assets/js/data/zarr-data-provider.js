/**
 * Zarr Data Provider for Cellucid
 *
 * This module provides a bridge between the standard Cellucid data loaders
 * and the Zarr directory loader. When the active data source is a zarr directory,
 * this provider intercepts data requests and fulfills them directly from
 * the zarr files instead of fetching URLs.
 *
 * This allows the rest of the application to work unchanged while supporting
 * zarr directories as a data source.
 */

import { getDataSourceManager } from './data-source-manager.js';

/**
 * Check if the current data source is a zarr directory
 * @returns {boolean}
 */
export function isZarrActive() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return false;

  // Check if source is local-user in zarr mode
  if (source.getType?.() === 'local-user') {
    return source.isZarrMode?.() === true;
  }

  // Check if source is zarr type directly
  return source.getType?.() === 'zarr';
}

/**
 * Get the active zarr source adapter
 * @returns {Object|null} Zarr source or adapter
 */
export function getZarrAdapter() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in zarr mode
  if (source.getType?.() === 'local-user' && source.isZarrMode?.()) {
    return source.getZarrSource?.()?.getAdapter?.() || null;
  }

  // If zarr source directly
  if (source.getType?.() === 'zarr') {
    return source.getAdapter?.() || null;
  }

  return null;
}

/**
 * Get the active zarr source
 * @returns {Object|null}
 */
export function getZarrSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in zarr mode
  if (source.getType?.() === 'local-user' && source.isZarrMode?.()) {
    return source.getZarrSource?.() || null;
  }

  // If zarr source directly
  if (source.getType?.() === 'zarr') {
    return source;
  }

  return null;
}

/**
 * Load points (embedding) from zarr source
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function zarrLoadPoints(dim) {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from zarr source
 * @returns {Object}
 */
export function zarrGetObsManifest() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getObsManifest();
}

/**
 * Load var manifest from zarr source
 * @returns {Object}
 */
export function zarrGetVarManifest() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getVarManifest();
}

/**
 * Load obs field data from zarr source
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function zarrLoadObsField(fieldKey) {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from zarr source
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function zarrLoadGeneExpression(geneName) {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from zarr source
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, nEdges: number}|null>}
 */
export async function zarrLoadConnectivity() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    return null;
  }

  return adapter.getConnectivityEdges();
}

/**
 * Get connectivity manifest from zarr source
 * @returns {Promise<Object|null>}
 */
export async function zarrGetConnectivityManifest() {
  const source = getZarrSource();
  if (!source) {
    return null;
  }

  return source.getConnectivityManifest?.() || null;
}

/**
 * Get dataset identity from zarr source
 * @returns {Object}
 */
export function zarrGetDatasetIdentity() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getMetadata();
}

/**
 * Check if a URL is a zarr:// URL
 * @param {string} url
 * @returns {boolean}
 */
export function isZarrUrl(url) {
  return url?.startsWith('zarr://');
}

/**
 * Parse a zarr:// URL
 * @param {string} url
 * @returns {{datasetId: string, path: string}|null}
 */
export function parseZarrUrl(url) {
  if (!isZarrUrl(url)) return null;

  // Format: zarr://datasetId/path
  const withoutProtocol = url.substring('zarr://'.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { datasetId: withoutProtocol, path: '' };
  }

  return {
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}
