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
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
  waitForMetadata,
} from './metadata-load-contract.js';

const candidateAnnDataBindings = new WeakMap();

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

function requireMethod(owner, method, label) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[method] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${method}().`);
  }
}

function requireCandidateAnnDataSource(url, candidateSource) {
  const parsed = parseAnnDataUrl(url);
  if (
    parsed === null ||
    typeof parsed.datasetId !== 'string' ||
    parsed.datasetId.length === 0
  ) {
    throw new TypeError(
      'Candidate AnnData binding requires an exact h5ad:// or zarr:// dataset URL.'
    );
  }
  requireMethod(
    candidateSource,
    'getType',
    'Candidate AnnData source'
  );
  const candidateType = candidateSource.getType();
  let directSource;

  if (candidateType === parsed.protocol) {
    directSource = candidateSource;
  } else if (candidateType === 'local-user') {
    for (const method of [
      'getH5adSource',
      'getZarrSource',
      'isH5adMode',
      'isZarrMode',
    ]) {
      requireMethod(
        candidateSource,
        method,
        'Candidate local-user AnnData source'
      );
    }
    const h5adMode = candidateSource.isH5adMode();
    const zarrMode = candidateSource.isZarrMode();
    if (
      typeof h5adMode !== 'boolean' ||
      typeof zarrMode !== 'boolean' ||
      h5adMode === zarrMode
    ) {
      throw new TypeError(
        'Candidate local-user source must own exactly one direct AnnData mode.'
      );
    }
    const expectedMode = parsed.protocol === 'h5ad'
      ? h5adMode
      : zarrMode;
    if (!expectedMode) {
      throw new Error(
        `Candidate AnnData URL uses ${parsed.protocol}://, but the candidate ` +
        `local-user source owns ${h5adMode ? 'h5ad://' : 'zarr://'}.`
      );
    }
    directSource = parsed.protocol === 'h5ad'
      ? candidateSource.getH5adSource()
      : candidateSource.getZarrSource();
  } else {
    throw new TypeError(
      `Candidate AnnData source type must be "local-user", "h5ad", or ` +
      `"zarr"; received "${String(candidateType)}".`
    );
  }

  if (candidateSource.datasetId !== parsed.datasetId) {
    throw new Error(
      `Candidate AnnData URL belongs to dataset "${parsed.datasetId}", but ` +
      `the candidate source owns "${String(candidateSource.datasetId)}".`
    );
  }
  requireMethod(directSource, 'getAdapter', 'Candidate direct AnnData source');
  requireMethod(directSource, 'getType', 'Candidate direct AnnData source');
  if (directSource.getType() !== parsed.protocol) {
    throw new Error(
      `Candidate direct AnnData source does not own ${parsed.protocol}://.`
    );
  }
  if (directSource.datasetId !== parsed.datasetId) {
    throw new Error(
      `Candidate direct AnnData source does not own dataset ` +
      `"${parsed.datasetId}".`
    );
  }
  const adapter = directSource.getAdapter();
  if (adapter === null || typeof adapter !== 'object') {
    throw new Error(
      `Candidate direct AnnData adapter is unavailable for dataset ` +
      `"${parsed.datasetId}".`
    );
  }
  return Object.freeze({
    adapter,
    parsed,
    source: directSource,
  });
}

/**
 * Bind staged direct-AnnData reads to one exact candidate without publishing
 * it through DataSourceManager. The returned object is opaque: only this
 * module can recover its candidate adapter.
 *
 * @param {string} url
 * @param {Object} candidateSource
 * @returns {Readonly<{datasetId: string, protocol: string}>}
 */
export function createCandidateAnnDataBinding(url, candidateSource) {
  const owner = requireCandidateAnnDataSource(url, candidateSource);
  const binding = Object.freeze({
    datasetId: owner.parsed.datasetId,
    protocol: owner.parsed.protocol,
  });
  candidateAnnDataBindings.set(binding, owner);
  return binding;
}

function getAnnDataBinding(url, candidateBinding) {
  if (candidateBinding === null) {
    return getActiveAnnDataBinding(url);
  }
  if (
    typeof candidateBinding !== 'object' ||
    !candidateAnnDataBindings.has(candidateBinding)
  ) {
    throw new TypeError(
      'Direct AnnData candidate binding must be created by ' +
      'createCandidateAnnDataBinding().'
    );
  }
  const owner = candidateAnnDataBindings.get(candidateBinding);
  const parsed = parseAnnDataUrl(url);
  if (
    parsed === null ||
    parsed.protocol !== owner.parsed.protocol ||
    parsed.datasetId !== owner.parsed.datasetId
  ) {
    throw new Error(
      'Direct AnnData candidate binding does not own the requested protocol ' +
      'and dataset id.'
    );
  }
  return owner;
}

/**
 * Resolve one explicit direct-AnnData URL against the exact active dataset.
 * Direct readers are mutable single-dataset sources, so protocol and dataset
 * identity must both match before any adapter data is exposed.
 *
 * @param {string} url
 * @returns {{adapter: Object, source: Object, parsed: {protocol: string, datasetId: string, path: string}}}
 */
export function getActiveAnnDataBinding(url) {
  const parsed = parseAnnDataUrl(url);
  if (!parsed) {
    throw new Error(
      `Direct AnnData access requires an explicit h5ad:// or zarr:// URL: ${String(url)}`
    );
  }
  if (
    typeof parsed.datasetId !== 'string' ||
    parsed.datasetId.length === 0
  ) {
    throw new Error(
      `Direct AnnData URL is missing its exact dataset id: ${String(url)}`
    );
  }

  const manager = getDataSourceManager();
  const activeFormat = getActiveAnnDataFormat();
  if (activeFormat !== parsed.protocol) {
    throw new Error(
      `Direct AnnData URL uses ${parsed.protocol}://, but the active ` +
      `dataset protocol is ${activeFormat ? `${activeFormat}://` : 'not AnnData'}`
    );
  }
  if (manager.activeDatasetId !== parsed.datasetId) {
    throw new Error(
      `Direct AnnData URL belongs to dataset "${parsed.datasetId}", but ` +
      `the active dataset is "${String(manager.activeDatasetId)}"`
    );
  }

  const source = getAnnDataSource();
  if (!source || source.datasetId !== parsed.datasetId) {
    throw new Error(
      `Direct AnnData source does not own dataset "${parsed.datasetId}"`
    );
  }
  const adapter = source.getAdapter?.();
  if (!adapter) {
    throw new Error(
      `Direct AnnData adapter is unavailable for dataset "${parsed.datasetId}"`
    );
  }
  return { adapter, source, parsed };
}

// =========================================================================
// Unified data access functions (work for both h5ad and zarr)
// =========================================================================

/**
 * Load points (embedding) from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function anndataLoadPoints(
  url,
  dim,
  candidateBinding = null
) {
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Object}
 */
export function anndataGetObsManifest(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData observation manifest'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData observation manifest loading'
  );
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  const manifest = adapter.getObsManifest();
  throwIfMetadataAborted(
    signal,
    'Direct AnnData observation manifest loading'
  );
  return manifest;
}

/**
 * Load var manifest from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Object}
 */
export function anndataGetVarManifest(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData variable manifest'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData variable manifest loading'
  );
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  const manifest = adapter.getVarManifest();
  throwIfMetadataAborted(
    signal,
    'Direct AnnData variable manifest loading'
  );
  return manifest;
}

/**
 * Load obs field data from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function anndataLoadObsField(
  url,
  fieldKey,
  candidateBinding = null
) {
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function anndataLoadGeneExpression(
  url,
  geneName,
  candidateBinding = null
) {
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal: AbortSignal}} options
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nEdges: number}|null>}
 */
export async function anndataLoadConnectivity(
  url,
  options,
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData connectivity payload'
  );
  if (signal === null) {
    throw new TypeError(
      'Direct AnnData connectivity payload options.signal is required'
    );
  }
  throwIfMetadataAborted(
    signal,
    'Direct AnnData connectivity payload loading'
  );
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  if (typeof adapter.getConnectivityEdges !== 'function') {
    throw new TypeError(
      'Direct AnnData adapters are required to implement getConnectivityEdges()'
    );
  }
  const edges = await waitForMetadata(
    adapter.getConnectivityEdges({ signal }),
    signal,
    'Direct AnnData connectivity payload loading'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData connectivity payload loading'
  );
  return edges;
}

/**
 * Get connectivity manifest from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object|null>}
 */
export async function anndataGetConnectivityManifest(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData connectivity manifest'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData connectivity manifest loading'
  );
  const { source } = getAnnDataBinding(url, candidateBinding);
  if (typeof source.getConnectivityManifest !== 'function') {
    throw new TypeError(
      'Direct AnnData sources are required to implement getConnectivityManifest()'
    );
  }
  const manifest = await waitForMetadata(
    source.getConnectivityManifest({ signal }),
    signal,
    'Direct AnnData connectivity manifest loading'
  );
  if (manifest === null) {
    return null;
  }
  if (!manifest) {
    throw new Error(
      'Invalid direct connectivity manifest: only exact null represents absence'
    );
  }
  return manifest;
}

/**
 * Get dataset identity/metadata from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Object}
 */
export function anndataGetDatasetIdentity(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData dataset identity'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData dataset identity loading'
  );
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  const identity = adapter.getMetadata();
  throwIfMetadataAborted(
    signal,
    'Direct AnnData dataset identity loading'
  );
  return identity;
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
  if (typeof url !== 'string' || url.length === 0) return null;

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
