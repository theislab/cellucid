/**
 * Unified AnnData Provider for Cellucid
 *
 * Every dataset Cellucid shows is read in the browser by the AnnData reader,
 * through one data source, whatever format the file arrived in
 * (`anndata-file-source.js`). The data loaders (`data-loaders.js`) address a
 * dataset's parts by anndata:// URLs under its base
 * (`anndata://<dataset id>/...`); this module resolves such a URL to the
 * adapter of the dataset that owns it -- the active dataset, or a candidate
 * staged for selection -- and reads the part from it.
 */

import { getDataSourceManager } from './data-source-manager.js';
import { ANNDATA_SOURCE_TYPE } from './anndata-file-source.js';
import { parseMappingGraphPath } from './data-mapping-candidates.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
  waitForMetadata,
} from './metadata-load-contract.js';

const candidateAnnDataBindings = new WeakMap();

/** The scheme of every direct AnnData URL: `anndata://<dataset id>/<path>`. */
const SCHEME = `${ANNDATA_SOURCE_TYPE}://`;

/**
 * Whether the active dataset is read by a direct AnnData source.
 * @returns {boolean}
 */
function isAnnDataActive() {
  const manager = getDataSourceManager();
  if (!manager.activeSource) return false;
  return getAnnDataSource()?.getType?.() === ANNDATA_SOURCE_TYPE;
}

/**
 * Get the active AnnData source
 * @returns {Object|null}
 */
function getAnnDataSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  const sourceType = source.getType?.();

  // The direct source
  if (sourceType === ANNDATA_SOURCE_TYPE) {
    return source;
  }

  // A wrapper source (local files, a link, a catalog) that reads the active
  // dataset from an AnnData file
  if (typeof source.getAnnDataSource === 'function') {
    return source.getAnnDataSource(manager.activeDatasetId) ?? null;
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
      'Candidate AnnData binding requires an exact anndata:// dataset URL.'
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
  } else if (typeof candidateSource.getAnnDataSource === 'function') {
    directSource = candidateSource.getAnnDataSource(parsed.datasetId);
    if (directSource === null || typeof directSource !== 'object') {
      throw new TypeError(
        `Candidate ${candidateType} source reads no direct AnnData file.`
      );
    }
    requireMethod(directSource, 'getType', 'Candidate direct AnnData source');
    const owned = directSource.getType();
    if (owned !== parsed.protocol) {
      throw new Error(
        `Candidate AnnData URL uses ${parsed.protocol}://, but the candidate ` +
        `${candidateType} source owns ${String(owned)}://.`
      );
    }
  } else {
    throw new TypeError(
      `Candidate AnnData source must be an "${ANNDATA_SOURCE_TYPE}" source, or ` +
      `expose getAnnDataSource(); received "${String(candidateType)}".`
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
  // The owner was parsed from the binding's dataset base; the path a caller
  // names belongs to the request, exactly as for an active binding.
  return { adapter: owner.adapter, source: owner.source, parsed };
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
      `Direct AnnData access requires an explicit anndata:// URL: ${String(url)}`
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
  if (!isAnnDataActive()) {
    throw new Error(
      `Direct AnnData URL uses ${parsed.protocol}://, but the active ` +
      'dataset is not read by a direct AnnData source'
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
// Unified data access functions
// =========================================================================

/**
 * Load one embedding from an AnnData source, by its route below the
 * dataset: `obsm/{obsm}/{cols}`, an `obsm` array read at some columns.
 * The positions are that array's display coordinates, with their display
 * transform and bounds, and the caller owns them (`getEmbeddingPayload`).
 *
 * @param {string} url - Explicit direct AnnData URL
 * @param {number} dim - The dimension the caller's layout declares (1, 2, or 3)
 * @param {{signal?: AbortSignal|null}} [options] - Cancels the read
 * @returns {Promise<import('./embedding-payload.js').EmbeddingPayload>}
 */
export async function anndataLoadPoints(
  url,
  dim,
  options = {},
  candidateBinding = null
) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.getEmbeddingPayload(parsed.path, dim, { signal: options.signal ?? null });
}

/**
 * Load one vector field from an AnnData source, by its URL: the route
 * `vectors/{vector}/{vcols}/{embedding}/{ecols}`.
 *
 * @param {string} url - Explicit direct AnnData URL of the vector field
 * @param {number} dim - The bound embedding's dimension (1, 2, or 3)
 * @param {{signal?: AbortSignal|null}} [options] - Cancels the reads
 * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>} Display
 *   vectors (shared, read-only) and the largest one's magnitude
 */
export async function anndataLoadVectors(
  url,
  dim,
  options = {},
  candidateBinding = null
) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.getVectorPayload(parsed.path, dim, { signal: options.signal ?? null });
}

/**
 * The data-mapping candidate catalog of an AnnData source.
 *
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Object}
 */
export function anndataGetMappingCandidates(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData data-mapping catalog'
  );
  throwIfMetadataAborted(signal, 'Direct AnnData data-mapping catalog loading');
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  return adapter.getMappingCandidates();
}

/**
 * The obs field list of an AnnData source (its `obs` route).
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Object}
 */
export function anndataGetObsFields(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData obs field list'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData obs field list loading'
  );
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  const fields = adapter.getObsFields();
  throwIfMetadataAborted(
    signal,
    'Direct AnnData obs field list loading'
  );
  return fields;
}

/**
 * One gene list of an AnnData source: the file's own (`var`) or a mapped one
 * (`var/{axis}/{names}`).
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function anndataGetGeneList(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData gene list'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData gene list loading'
  );
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  const geneList = await waitForMetadata(
    adapter.getGeneList(parsed.path),
    signal,
    'Direct AnnData gene list loading'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData gene list loading'
  );
  return geneList;
}

/**
 * The genes of one gene list that one boolean var column of their axis marks
 * (`BaseAnnDataAdapter.getMarkedGenes`), by their names in that list.
 *
 * @param {string} url - The gene list's URL (`<base>var` or a mapped route)
 * @param {string} column
 * @returns {Promise<string[]|null>}
 */
export async function anndataLoadMarkedGenes(url, column, candidateBinding = null) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.getMarkedGenes(parsed.path, column);
}

/**
 * Load obs field data from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {string} fieldKey - Field name
 * @param {{signal?: AbortSignal|null}} [options] - Cancels the read
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function anndataLoadObsField(
  url,
  fieldKey,
  options = {},
  candidateBinding = null
) {
  const { adapter } = getAnnDataBinding(url, candidateBinding);
  return adapter.getObsFieldData(fieldKey, { signal: options.signal ?? null });
}

/**
 * Load one gene's values from an AnnData source, by its URL: `var/{g}` for
 * the file's own gene list, or `var/{axis}/{names}/{g}` for a mapped one.
 * @param {string} url - Explicit direct AnnData URL of the gene
 * @param {{signal?: AbortSignal|null}} [options] - Cancels the read
 * @returns {Promise<Float32Array>}
 */
export async function anndataLoadGeneValues(
  url,
  options = {},
  candidateBinding = null
) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.getGeneValues(parsed.path, {
    signal: options.signal ?? null,
    owner: options.owner ?? null,
    key: options.key ?? null,
  });
}

/**
 * The link the AnnData file behind `url` is read over, as its reader last
 * measured it (`AnnDataReaderClient.linkMeasurement()`:
 * `{latencyMs, bytesPerMs, backgroundConcurrency, protocol}`), or null when
 * no dataset is open there or nothing has been measured yet.
 *
 * @param {string} url
 * @returns {Readonly<Object>|null}
 */
export function anndataLinkMeasurement(url) {
  let binding;
  try {
    binding = getAnnDataBinding(url, null);
  } catch {
    return null;
  }
  return binding.adapter.linkMeasurement?.() ?? null;
}

/**
 * One gene's non-zero entries from an AnnData source, by its URL
 * (`getGeneSparseValues`): `{length, indices, values}`, owned by the caller.
 * @param {string} url - Explicit direct AnnData URL of the gene
 * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] - `signal`
 *   cancels the read; `owner` is the job it is for
 * @returns {Promise<{length: number, indices: Uint32Array, values: Float32Array}>}
 */
export async function anndataLoadGeneSparse(
  url,
  options = {},
  candidateBinding = null
) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.getGeneSparseValues(parsed.path, {
    signal: options.signal ?? null,
    owner: options.owner ?? null,
  });
}

/**
 * Some genes' values in some cells of an AnnData source, read by cell or by
 * gene, whichever costs less (`getGeneCellSubset`).
 * @param {ReadonlyArray<string>} urls - Gene URLs of one matrix
 * @param {ArrayLike<number>} cells - Distinct cell positions
 * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] - `signal`
 *   cancels the read; `owner` is the job it is for
 * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
 */
export async function anndataLoadGeneCellSubset(
  urls,
  cells,
  options = {},
  candidateBinding = null
) {
  const bindings = urls.map(url => getAnnDataBinding(url, candidateBinding));
  const { adapter } = bindings[0];
  if (bindings.some(binding => binding.adapter !== adapter)) {
    throw new RangeError('A cell subset reads the genes of one dataset.');
  }
  return adapter.getGeneCellSubset(
    bindings.map(binding => binding.parsed.path),
    cells,
    { signal: options.signal ?? null, owner: options.owner ?? null }
  );
}

/**
 * What getting the outlier quantiles of one categorical obs field in one
 * latent space costs, by its URL, before anything is read.
 * @param {string} url
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function anndataDescribeOutlierQuantiles(url, options = {}, candidateBinding = null) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.describeLatentOutlierQuantiles(parsed.path, { signal: options.signal ?? null });
}

/**
 * The outlier quantiles of one categorical obs field in one latent space of
 * an AnnData source (stored in the file, else computed), by its URL
 * (`outliers/{obsm}/{field}`).
 * @param {string} url - Explicit direct AnnData URL of the outlier quantiles
 * @param {{signal?: AbortSignal|null, codes?: Uint8Array|Uint16Array|Uint32Array|null}} [options]
 *   `signal` cancels the computation; `codes` are the field's codes when the
 *   caller holds them
 * @returns {Promise<Float32Array>}
 */
export async function anndataLoadOutlierQuantiles(
  url,
  options = {},
  candidateBinding = null
) {
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  return adapter.getLatentOutlierQuantiles(parsed.path, {
    signal: options.signal ?? null,
    codes: options.codes ?? null,
  });
}

function requireMappedObspKey(adapter, obspIndex) {
  const item = adapter.getMappingCandidates().obsp[obspIndex];
  if (item === undefined) {
    throw new RangeError(`This file has no obsp entry ${obspIndex}.`);
  }
  return item.key;
}

/**
 * Load connectivity edges from AnnData source
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal: AbortSignal}} options
 * @returns {Promise<import('./connectivity-edges.js').ConnectivityEdges|null>}
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
  const { adapter, parsed } = getAnnDataBinding(url, candidateBinding);
  if (typeof adapter.getConnectivityEdges !== 'function') {
    throw new TypeError(
      'Direct AnnData adapters are required to implement getConnectivityEdges()'
    );
  }
  // A mapped graph's route names the obsp entry; the dataset's own route
  // (`obsp`) names the graph the file opens with.
  const obspIndex = parseMappingGraphPath(parsed.path);
  const edgeOptions = obspIndex === null
    ? { signal }
    : { signal, key: requireMappedObspKey(adapter, obspIndex) };
  const edges = await waitForMetadata(
    adapter.getConnectivityEdges(edgeOptions),
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
 * The summary of one neighbour graph of an AnnData source: the file's own
 * (`obsp`) or a mapped one (`obsp/{p}`).
 * @param {string} url - Explicit direct AnnData URL
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object|null>}
 */
export async function anndataGetConnectivitySummary(
  url,
  options = {},
  candidateBinding = null
) {
  const signal = getMetadataLoadSignal(
    options,
    'Direct AnnData connectivity summary'
  );
  throwIfMetadataAborted(
    signal,
    'Direct AnnData connectivity summary loading'
  );
  const { adapter, source, parsed } = getAnnDataBinding(url, candidateBinding);
  const obspIndex = parseMappingGraphPath(parsed.path);
  if (obspIndex !== null) {
    return waitForMetadata(
      adapter.getMappedConnectivitySummary(obspIndex, { signal }),
      signal,
      'Direct AnnData connectivity summary loading'
    );
  }
  if (typeof source.getConnectivitySummary !== 'function') {
    throw new TypeError(
      'Direct AnnData sources are required to implement getConnectivitySummary()'
    );
  }
  const summary = await waitForMetadata(
    source.getConnectivitySummary({ signal }),
    signal,
    'Direct AnnData connectivity summary loading'
  );
  if (summary === null) {
    return null;
  }
  if (!summary) {
    throw new Error(
      'Invalid direct connectivity summary: only exact null represents absence'
    );
  }
  return summary;
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
 * Check if a URL is a direct AnnData URL (`anndata://`)
 * @param {string} url
 * @returns {boolean}
 */
export function isAnnDataUrl(url) {
  return typeof url === 'string' && url.startsWith(SCHEME);
}

/**
 * Parse a direct AnnData URL (`anndata://<dataset id>/<path>`)
 * @param {string} url
 * @returns {{protocol: string, datasetId: string, path: string}|null}
 */
function parseAnnDataUrl(url) {
  if (!isAnnDataUrl(url) || url.length === 0) return null;
  const withoutProtocol = url.substring(SCHEME.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { protocol: ANNDATA_SOURCE_TYPE, datasetId: withoutProtocol, path: '' };
  }

  return {
    protocol: ANNDATA_SOURCE_TYPE,
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}
