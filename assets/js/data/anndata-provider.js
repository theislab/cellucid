/**
 * Unified AnnData Provider for Cellucid
 *
 * This module provides a bridge between the standard Cellucid data loaders
 * and direct AnnData file loaders (h5ad and zarr). When the active data source
 * is an h5ad file or zarr directory, this provider intercepts data requests
 * and fulfills them directly from the file instead of fetching URLs.
 *
 * This provides a unified interface for h5ad.js and zarr.js
 * into a single, unified module.
 *
 * Supports:
 * - H5AD files (.h5ad)
 * - Zarr directories (.zarr/)
 *
 * This allows the rest of the application to work unchanged while supporting
 * AnnData files as a data source.
 */

import { getDataSourceManager } from './data-source-manager.js';

/**
 * Supported AnnData format types
 * @typedef {'h5ad' | 'zarr'} AnnDataFormat
 */

/**
 * Check if the current data source is an AnnData file (h5ad or zarr)
 * @returns {AnnDataFormat|null} The format type or null if not AnnData
 */
export function getActiveAnnDataFormat() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  const sourceType = source.getType?.();

  // Check for direct source types
  if (sourceType === 'h5ad') return 'h5ad';
  if (sourceType === 'zarr') return 'zarr';

  // Check for local-user wrapper modes
  if (sourceType === 'local-user') {
    if (source.isH5adMode?.()) return 'h5ad';
    if (source.isZarrMode?.()) return 'zarr';
  }

  return null;
}

/**
 * Check if the current data source is an h5ad file
 * @returns {boolean}
 */
export function isH5adActive() {
  return getActiveAnnDataFormat() === 'h5ad';
}

/**
 * Check if the current data source is a zarr directory
 * @returns {boolean}
 */
export function isZarrActive() {
  return getActiveAnnDataFormat() === 'zarr';
}

/**
 * Check if any AnnData format is active (h5ad or zarr)
 * @returns {boolean}
 */
export function isAnnDataActive() {
  return getActiveAnnDataFormat() !== null;
}

/**
 * Get the active AnnData source adapter (works for both h5ad and zarr)
 * @returns {Object|null} AnnData adapter
 */
export function getAnnDataAdapter() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  const sourceType = source.getType?.();

  // Direct source types
  if (sourceType === 'h5ad' || sourceType === 'zarr') {
    return source.getAdapter?.() || null;
  }

  // Local-user wrapper
  if (sourceType === 'local-user') {
    if (source.isH5adMode?.()) {
      return source.getH5adSource?.()?.getAdapter?.() || null;
    }
    if (source.isZarrMode?.()) {
      return source.getZarrSource?.()?.getAdapter?.() || null;
    }
  }

  return null;
}

/**
 * Get the active AnnData source (works for both h5ad and zarr)
 * @returns {Object|null}
 */
export function getAnnDataSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  const sourceType = source.getType?.();

  // Direct source types
  if (sourceType === 'h5ad' || sourceType === 'zarr') {
    return source;
  }

  // Local-user wrapper
  if (sourceType === 'local-user') {
    if (source.isH5adMode?.()) {
      return source.getH5adSource?.() || null;
    }
    if (source.isZarrMode?.()) {
      return source.getZarrSource?.() || null;
    }
  }

  return null;
}

// =========================================================================
// Unified data access functions (work for both h5ad and zarr)
// =========================================================================

/**
 * Load points (embedding) from AnnData source
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function anndataLoadPoints(dim) {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    throw new Error('No AnnData adapter available');
  }
  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from AnnData source
 * @returns {Object}
 */
export function anndataGetObsManifest() {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    throw new Error('No AnnData adapter available');
  }
  return adapter.getObsManifest();
}

/**
 * Load var manifest from AnnData source
 * @returns {Object}
 */
export function anndataGetVarManifest() {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    throw new Error('No AnnData adapter available');
  }
  return adapter.getVarManifest();
}

/**
 * Load obs field data from AnnData source
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function anndataLoadObsField(fieldKey) {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    throw new Error('No AnnData adapter available');
  }
  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from AnnData source
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function anndataLoadGeneExpression(geneName) {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    throw new Error('No AnnData adapter available');
  }
  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from AnnData source
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, nEdges: number}|null>}
 */
export async function anndataLoadConnectivity() {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    return null;
  }
  return adapter.getConnectivityEdges();
}

/**
 * Get connectivity manifest from AnnData source
 * @returns {Promise<Object|null>}
 */
export async function anndataGetConnectivityManifest() {
  const source = getAnnDataSource();
  if (!source) {
    return null;
  }
  return source.getConnectivityManifest?.() || null;
}

/**
 * Get dataset identity/metadata from AnnData source
 * @returns {Object}
 */
export function anndataGetDatasetIdentity() {
  const adapter = getAnnDataAdapter();
  if (!adapter) {
    throw new Error('No AnnData adapter available');
  }
  return adapter.getMetadata();
}

// =========================================================================
// URL helpers (for protocol handling)
// =========================================================================

/**
 * Check if a URL is an h5ad:// URL
 * @param {string} url
 * @returns {boolean}
 */
export function isH5adUrl(url) {
  return url?.startsWith('h5ad://');
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
 * Check if a URL is an AnnData URL (h5ad:// or zarr://)
 * @param {string} url
 * @returns {boolean}
 */
export function isAnnDataUrl(url) {
  return isH5adUrl(url) || isZarrUrl(url);
}

/**
 * Parse an AnnData URL (h5ad:// or zarr://)
 * @param {string} url
 * @returns {{protocol: string, datasetId: string, path: string}|null}
 */
export function parseAnnDataUrl(url) {
  if (!url) return null;

  let protocol;
  if (url.startsWith('h5ad://')) {
    protocol = 'h5ad';
  } else if (url.startsWith('zarr://')) {
    protocol = 'zarr';
  } else {
    return null;
  }

  const withoutProtocol = url.substring(protocol.length + 3); // +3 for "://"
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { protocol, datasetId: withoutProtocol, path: '' };
  }

  return {
    protocol,
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}

// =========================================================================
// Legacy compatibility exports (h5ad-specific aliases)
// =========================================================================

// These are provided for backward compatibility with existing code that
// imports from h5ad.js or zarr.js

/** @deprecated Use getAnnDataAdapter() instead */
export const getH5adAdapter = getAnnDataAdapter;

/** @deprecated Use getAnnDataSource() instead */
export const getH5adSource = getAnnDataSource;

/** @deprecated Use anndataLoadPoints() instead */
export const h5adLoadPoints = anndataLoadPoints;

/** @deprecated Use anndataGetObsManifest() instead */
export const h5adGetObsManifest = anndataGetObsManifest;

/** @deprecated Use anndataGetVarManifest() instead */
export const h5adGetVarManifest = anndataGetVarManifest;

/** @deprecated Use anndataLoadObsField() instead */
export const h5adLoadObsField = anndataLoadObsField;

/** @deprecated Use anndataLoadGeneExpression() instead */
export const h5adLoadGeneExpression = anndataLoadGeneExpression;

/** @deprecated Use anndataLoadConnectivity() instead */
export const h5adLoadConnectivity = anndataLoadConnectivity;

/** @deprecated Use anndataGetConnectivityManifest() instead */
export const h5adGetConnectivityManifest = anndataGetConnectivityManifest;

/** @deprecated Use anndataGetDatasetIdentity() instead */
export const h5adGetDatasetIdentity = anndataGetDatasetIdentity;

/** @deprecated Use parseAnnDataUrl() instead */
export function parseH5adUrl(url) {
  const parsed = parseAnnDataUrl(url);
  if (parsed?.protocol === 'h5ad') {
    return { datasetId: parsed.datasetId, path: parsed.path };
  }
  return null;
}

// =========================================================================
// Legacy compatibility exports (zarr-specific aliases)
// =========================================================================

/** @deprecated Use getAnnDataAdapter() instead */
export const getZarrAdapter = getAnnDataAdapter;

/** @deprecated Use getAnnDataSource() instead */
export const getZarrSource = getAnnDataSource;

/** @deprecated Use anndataLoadPoints() instead */
export const zarrLoadPoints = anndataLoadPoints;

/** @deprecated Use anndataGetObsManifest() instead */
export const zarrGetObsManifest = anndataGetObsManifest;

/** @deprecated Use anndataGetVarManifest() instead */
export const zarrGetVarManifest = anndataGetVarManifest;

/** @deprecated Use anndataLoadObsField() instead */
export const zarrLoadObsField = anndataLoadObsField;

/** @deprecated Use anndataLoadGeneExpression() instead */
export const zarrLoadGeneExpression = anndataLoadGeneExpression;

/** @deprecated Use anndataLoadConnectivity() instead */
export const zarrLoadConnectivity = anndataLoadConnectivity;

/** @deprecated Use anndataGetConnectivityManifest() instead */
export const zarrGetConnectivityManifest = anndataGetConnectivityManifest;

/** @deprecated Use anndataGetDatasetIdentity() instead */
export const zarrGetDatasetIdentity = anndataGetDatasetIdentity;

/** @deprecated Use parseAnnDataUrl() instead */
export function parseZarrUrl(url) {
  const parsed = parseAnnDataUrl(url);
  if (parsed?.protocol === 'zarr') {
    return { datasetId: parsed.datasetId, path: parsed.path };
  }
  return null;
}
