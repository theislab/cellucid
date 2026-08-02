/**
 * LocalUserDirDataSource - Data source for user-selected local directories
 *
 * Uses standard file input with webkitdirectory attribute for cross-browser support.
 * All processing happens client-side - no data is uploaded to external servers.
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  MAX_METADATA_JSON_BYTES,
  MAX_PREPARED_BROWSER_BYTES,
  isLocalUserUrl,
  validateDatasetIdentity,
  validateVectorFieldsMetadata
} from './data-source.js';
import { expandObsManifest, expandVarManifest } from './data-loaders.js';
import {
  MAX_CATEGORICAL_CATEGORIES,
  categoricalStorageForDtype,
} from './categorical-storage-contract.js';
import {
  CONNECTIVITY_MANIFEST_CONTEXT,
  getConnectivityIndexStorage,
  validateConnectivityManifest,
} from './connectivity-manifest-contract.js';
import {
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import {
  throwIfMetadataAborted,
  validateAbortSignalOrNull,
  waitForMetadata,
} from './metadata-load-contract.js';
import { parseEmbeddingMetadata } from './dimension-manager.js';
import { isH5adFile, H5adDataSource, createH5adDataSource } from './h5ad.js';
import { ZarrDataSource, createZarrDataSource } from './zarr.js';
import { getNotificationCenter } from '../app/notification-center.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

function isZarrZipArchive(file) {
  return Boolean(
    file &&
    typeof file.name === 'string' &&
    /\.zip$/i.test(file.name)
  );
}

function createLocalApplicationDatasetId(kind, sourceDatasetId) {
  if (
    typeof sourceDatasetId !== 'string' ||
    sourceDatasetId.length === 0
  ) {
    throw preparedDataError(
      `The ${kind} reader did not provide a dataset identity.`,
      'local-user'
    );
  }
  return `local-user:${kind}:${encodeURIComponent(sourceDatasetId)}`;
}

const PREPARED_LOCAL_URL_PREFIX = 'local-user://dataset/';

function parsePreparedLocalUrl(url) {
  if (
    typeof url !== 'string' ||
    !url.startsWith(PREPARED_LOCAL_URL_PREFIX)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'local-user:' ||
    parsed.hostname !== 'dataset' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.href !== url
  ) {
    return null;
  }

  const encodedParts = parsed.pathname.split('/').slice(1);
  if (
    encodedParts.length < 2 ||
    encodedParts.some(part => part.length === 0)
  ) {
    return null;
  }

  let datasetId;
  let fileParts;
  try {
    datasetId = decodeURIComponent(encodedParts[0]);
    fileParts = encodedParts.slice(1).map(part => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (
    datasetId.length === 0 ||
    encodeURIComponent(datasetId) !== encodedParts[0] ||
    fileParts.some(part => (
      part.length === 0 ||
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(part)
    ))
  ) {
    return null;
  }

  const filename = fileParts.join('/');
  let canonicalUrl;
  try {
    canonicalUrl = new URL(
      filename,
      `${PREPARED_LOCAL_URL_PREFIX}${encodeURIComponent(datasetId)}/`
    ).href;
  } catch {
    return null;
  }
  return canonicalUrl === url
    ? { datasetId, filename }
    : null;
}

const MAX_EAGER_GENE_VALIDATION_BYTES = 64 * 1024 * 1024;
const MAX_EAGER_GENE_VALIDATION_FILES = 256;
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;
const PREPARED_DTYPE_INFO = Object.freeze({
  float64: {
    bytes: 8,
    read: (view, offset) => view.getFloat64(offset, true),
  },
  float32: {
    bytes: 4,
    read: (view, offset) => view.getFloat32(offset, true),
  },
  uint8: {
    bytes: 1,
    read: (view, offset) => view.getUint8(offset),
  },
  uint16: {
    bytes: 2,
    read: (view, offset) => view.getUint16(offset, true),
  },
  uint32: {
    bytes: 4,
    read: (view, offset) => view.getUint32(offset, true),
  },
});

function preparedDataError(message, source, details = {}) {
  return new DataSourceError(
    message,
    DataSourceErrorCode.INVALID_FORMAT,
    source,
    details
  );
}

/**
 * A prepared directory refused for its size, not for its shape.
 *
 * The file is a valid export; it is only bigger than a browser ceiling. Sharing
 * `INVALID_FORMAT` with the malformed-export failures is what routed it to the
 * "re-export it with cellucid prepare" advice, which regenerates the identical
 * file and meets the identical ceiling (CEL-0219).
 */
function preparedTooLargeError(message, source, details = {}) {
  return new DataSourceError(
    message,
    DataSourceErrorCode.TOO_LARGE,
    source,
    details
  );
}

function requirePreparedGzipDecompressionStream(filename, source) {
  const GzipDecompressionStream = globalThis.DecompressionStream;
  if (typeof GzipDecompressionStream !== 'function') {
    throw preparedDataError(
      `${filename}: gzip validation requires browser DecompressionStream support`,
      source,
      { filename }
    );
  }
  return GzipDecompressionStream;
}

function validatePreparedPath(path, label, source) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw preparedDataError(
      `${label} must be a safe relative file path`,
      source,
      { path }
    );
  }
  return path;
}

function preparedDtypeBytes(dtype, label, source) {
  const info = PREPARED_DTYPE_INFO[dtype];
  if (!info) {
    throw preparedDataError(
      `${label} uses unsupported dtype "${String(dtype)}"`,
      source,
      { dtype }
    );
  }
  return info.bytes;
}

function checkedPreparedBytes(count, width, label, source) {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    count > Math.floor(Number.MAX_SAFE_INTEGER / width)
  ) {
    throw preparedDataError(
      `${label} has an invalid or unsafe element count`,
      source,
      { count, width }
    );
  }
  const bytes = count * width;
  if (bytes > MAX_PREPARED_BROWSER_BYTES) {
    throw preparedTooLargeError(
      `${label} requires more than the 512 MiB browser working-set limit; use the Cellucid server instead`,
      source,
      { bytes, limit: MAX_PREPARED_BROWSER_BYTES }
    );
  }
  return bytes;
}

function checkedPreparedWorkingSet(parts, label, source) {
  let total = 0n;
  for (const part of parts) {
    if (!Number.isSafeInteger(part) || part < 0) {
      throw preparedDataError(
        `${label} has an invalid working-set plan`,
        source,
        { parts }
      );
    }
    total += BigInt(part);
  }
  if (total > BigInt(MAX_PREPARED_BROWSER_BYTES)) {
    throw preparedTooLargeError(
      `${label} working set exceeds the 512 MiB browser limit; use the Cellucid server instead`,
      source,
      {
        bytes: total.toString(),
        limit: MAX_PREPARED_BROWSER_BYTES,
      }
    );
  }
  return Number(total);
}

function createPreparedAbortError() {
  return createDatasetReloadSupersededError(
    'Prepared dataset validation was superseded by a newer selection.'
  );
}

function throwIfPreparedAborted(signal) {
  if (signal?.aborted) throw createPreparedAbortError();
}

function linkPreparedAbortSignals(first, second) {
  const signals = [...new Set([first, second].filter(Boolean))];
  if (signals.length === 0) {
    return { signal: null, release() {} };
  }
  if (signals.length === 1) {
    return { signal: signals[0], release() {} };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    signal.addEventListener('abort', abort, { once: true });
  }
  if (signals.some(signal => signal.aborted)) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    release() {
      for (const signal of signals) {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function requirePreparedExactKeys(
  object,
  required,
  optional,
  label,
  source
) {
  if (!isPlainObject(object)) {
    throw preparedDataError(`${label} must be an object.`, source);
  }
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(object);
  const missing = required.filter(key => !Object.hasOwn(object, key));
  const extra = actual.filter(key => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw preparedDataError(
      `${label} must contain exactly the current contract fields.`,
      source,
      { missing, extra, required: [...requiredSet], optional }
    );
  }
}

function requirePreparedCompressionLevel(value, label, source) {
  if (
    value !== null &&
    (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 9
    )
  ) {
    throw preparedDataError(
      `${label} must be null or an integer from 1 through 9.`,
      source,
      { value }
    );
  }
  return value;
}

function requirePreparedQuantization(value, label, source) {
  if (value !== null && value !== 8 && value !== 16) {
    throw preparedDataError(
      `${label} must be null, 8, or 16.`,
      source,
      { value }
    );
  }
  return value;
}

function validatePreparedPathCompression(
  path,
  compression,
  label,
  source
) {
  const compressed = path.endsWith('.gz');
  if (compressed !== (compression !== null)) {
    throw preparedDataError(
      `${label} must ${compression === null ? 'not ' : ''}end in .gz ` +
      `to match export compression.`,
      source,
      { path, compression }
    );
  }
}

/**
 * Validate the optional `export_settings` block of a prepared identity.
 *
 * `created_at` and `export_settings` are optional top-level keys of the export
 * format, and the hosted-catalog reader treats them that way. A prepared export
 * declares its compression in the manifests, which are required and which
 * `expandObsManifest()` has already checked against every path pattern they
 * carry, so the local reader resolves compression from `obs_manifest.json` and
 * uses `export_settings` — when the producer wrote it — only to cross-check.
 * `created_at` is validated for shape by `validateDatasetIdentity()` and read
 * by nothing here.
 *
 * @param {Object} identity
 * @param {string} source
 * @returns {Object|null} the declared settings, or null when absent
 */
function validatePreparedIdentityExportContract(identity, source) {
  if (!Object.hasOwn(identity, 'export_settings')) {
    return null;
  }
  const settings = identity.export_settings;
  requirePreparedExactKeys(
    settings,
    [
      'compression',
      'var_quantization',
      'obs_continuous_quantization',
      'obs_categorical_dtype',
    ],
    [],
    'dataset_identity.json export_settings',
    source
  );
  requirePreparedCompressionLevel(
    settings.compression,
    'dataset_identity.json export_settings.compression',
    source
  );
  requirePreparedQuantization(
    settings.var_quantization,
    'dataset_identity.json export_settings.var_quantization',
    source
  );
  requirePreparedQuantization(
    settings.obs_continuous_quantization,
    'dataset_identity.json export_settings.obs_continuous_quantization',
    source
  );
  if (
    settings.obs_categorical_dtype !== 'uint8' &&
    settings.obs_categorical_dtype !== 'uint16'
  ) {
    throw preparedDataError(
      'dataset_identity.json export_settings.obs_categorical_dtype ' +
      'must be exactly "uint8" or "uint16".',
      source,
      { value: settings.obs_categorical_dtype }
    );
  }
  return settings;
}

function getPreparedEmbeddingPlans(identity, compression, source) {
  const nCells = identity.stats.n_cells;
  let parsed;
  try {
    parsed = parseEmbeddingMetadata(identity.embeddings);
  } catch (cause) {
    throw preparedDataError(
      `Invalid dataset_identity.json embeddings: ${cause?.message || cause}`,
      source,
      { cause }
    );
  }
  if (parsed.pathMapKind !== 'files') {
    throw preparedDataError(
      'Prepared dataset embeddings must use the exact files path map.',
      source
    );
  }

  return {
    defaultDimension: parsed.defaultDimension,
    nCells,
    plans: parsed.availableDimensions.map(dimension => {
      const key = `${dimension}d`;
      const filename = validatePreparedPath(
        parsed.dimensionFiles[key],
        `Embedding file for ${dimension}D`,
        source
      );
      validatePreparedPathCompression(
        filename,
        compression,
        `Embedding file for ${dimension}D`,
        source
      );
      return {
        dimension,
        filename,
        expectedBytes: checkedPreparedBytes(
          nCells,
          dimension * FLOAT32_BYTES,
          filename,
          source
        ),
        paddedBytes: checkedPreparedBytes(
          nCells,
          3 * FLOAT32_BYTES,
          `${filename} padded rendering coordinates`,
          source
        ),
      };
    }),
  };
}

function validatePreparedPayloadPathUniqueness(
  {
    embeddingPlan,
    obsManifest,
    varManifest,
    connectivityManifest,
    vectorFields,
  },
  source
) {
  const ownersByPath = new Map();
  const claim = (path, label) => {
    const filename = validatePreparedPath(path, label, source);
    const existingOwner = ownersByPath.get(filename);
    if (existingOwner) {
      throw preparedDataError(
        `Advertised payload path "${filename}" is used more than once: ${existingOwner} and ${label}`,
        source,
        { filename, existingOwner, conflictingOwner: label }
      );
    }
    ownersByPath.set(filename, label);
  };

  for (const metadataPath of [
    'dataset_identity.json',
    'obs_manifest.json',
    'var_manifest.json',
    'connectivity_manifest.json',
  ]) {
    claim(metadataPath, `structural metadata "${metadataPath}"`);
  }

  for (const plan of embeddingPlan.plans) {
    claim(plan.filename, `${plan.dimension}D embedding`);
  }
  for (const field of obsManifest.fields) {
    if (field.kind === 'continuous') {
      claim(
        field.valuesPath,
        `observation values for "${field.key}"`
      );
    } else {
      claim(
        field.codesPath,
        `observation codes for "${field.key}"`
      );
    }
    if (field.outlierQuantilesPath) {
      claim(
        field.outlierQuantilesPath,
        `observation outliers for "${field.key}"`
      );
    }
  }
  for (const field of varManifest?.fields || []) {
    claim(field.valuesPath, `gene values for "${field.key}"`);
  }
  if (connectivityManifest) {
    claim(
      connectivityManifest.sourcesPath,
      'connectivity sources'
    );
    claim(
      connectivityManifest.destinationsPath,
      'connectivity destinations'
    );
    claim(
      connectivityManifest.weightsPath,
      'connectivity weights'
    );
  }
  for (const [fieldId, field] of Object.entries(
    vectorFields?.fields || {}
  )) {
    for (const dimension of field.available_dimensions) {
      claim(
        field.files[`${dimension}d`],
        `vector field "${fieldId}" ${dimension}D`
      );
    }
  }
}

/**
 * @param {Object} rawManifest
 * @param {Object} identity
 * @param {Object|null} settings - Declared export_settings, or null when the
 *   optional block is absent. `obs_manifest.json` is required, so its own
 *   `compression` is the export's compression either way.
 * @param {string} source
 */
function validatePreparedObsManifest(rawManifest, identity, settings, source) {
  let manifest;
  try {
    manifest = expandObsManifest(rawManifest);
  } catch (cause) {
    throw preparedDataError(
      `Invalid obs_manifest.json: ${cause?.message || cause}`,
      source,
      { cause }
    );
  }

  if (!manifest || typeof manifest !== 'object') {
    throw preparedDataError(
      'Invalid obs_manifest.json: expected a JSON object',
      source
    );
  }
  if (
    !Number.isSafeInteger(manifest.n_points) ||
    manifest.n_points < 0
  ) {
    throw preparedDataError(
      'Invalid obs_manifest.json: n_points must be a non-negative safe integer',
      source
    );
  }
  if (manifest.n_points !== identity.stats.n_cells) {
    throw preparedDataError(
      `Invalid obs_manifest.json: n_points (${manifest.n_points}) does not match dataset_identity.json stats.n_cells (${identity.stats.n_cells})`,
      source
    );
  }
  if (!Array.isArray(manifest.fields)) {
    throw preparedDataError(
      'Invalid obs_manifest.json: fields must be an array',
      source
    );
  }
  const compression = manifest.compression;
  if (settings !== null && settings.compression !== compression) {
    throw preparedDataError(
      'obs_manifest.json compression must exactly match ' +
      'dataset_identity.json export_settings.compression.',
      source,
      {
        manifestCompression: compression,
        exportCompression: settings.compression,
      }
    );
  }

  const seenKeys = new Set();
  for (const field of manifest.fields) {
    if (
      !field ||
      typeof field.key !== 'string' ||
      field.key.length === 0 ||
      seenKeys.has(field.key)
    ) {
      throw preparedDataError(
        'Invalid obs_manifest.json: field keys must be non-empty and unique',
        source
      );
    }
    seenKeys.add(field.key);
    if (field.kind !== 'continuous' && field.kind !== 'category') {
      throw preparedDataError(
        `Invalid obs_manifest.json: field "${field.key}" has unsupported kind "${String(field.kind)}"`,
        source
      );
    }
    if (field.kind === 'continuous') {
      if (settings !== null) {
        const expectedBits = settings.obs_continuous_quantization;
        if (
          field.quantized !== (expectedBits !== null) ||
          (
            field.quantized &&
            field.quantizationBits !== expectedBits
          )
        ) {
          throw preparedDataError(
            `Observation field "${field.key}" quantization must exactly ` +
            'match dataset_identity.json export_settings.',
            source
          );
        }
      }
      validatePreparedPathCompression(
        field.valuesPath,
        compression,
        `Observation values for "${field.key}"`,
        source
      );
    } else {
      if (
        settings !== null &&
        field.codesDtype !== settings.obs_categorical_dtype
      ) {
        throw preparedDataError(
          `Observation field "${field.key}" categorical dtype must ` +
          'exactly match dataset_identity.json export_settings.',
          source
        );
      }
      validatePreparedPathCompression(
        field.codesPath,
        compression,
        `Observation codes for "${field.key}"`,
        source
      );
      if (field.outlierQuantilesPath !== null) {
        if (settings !== null) {
          const expectedBits = settings.obs_continuous_quantization;
          const actualBits = field.outlierDtype === 'uint8'
            ? 8
            : field.outlierDtype === 'uint16'
              ? 16
              : null;
          if (
            field.outlierQuantized !== (expectedBits !== null) ||
            (
              field.outlierQuantized &&
              actualBits !== expectedBits
            )
          ) {
            throw preparedDataError(
              `Observation field "${field.key}" outlier quantization must ` +
              'exactly match dataset_identity.json export_settings.',
              source
            );
          }
        }
        validatePreparedPathCompression(
          field.outlierQuantilesPath,
          compression,
          `Observation outliers for "${field.key}"`,
          source
        );
      }
    }
  }
  return manifest;
}

/**
 * Record the user-selected Zarr container at the UI-facing metadata seam.
 * The underlying reader sees only an indexed Zarr store, so it cannot
 * distinguish a browser directory selection from a portable ZIP archive.
 *
 * @param {DatasetMetadata} metadata
 * @param {{archiveFile?: File|Blob|null}} [options]
 * @returns {DatasetMetadata}
 */
/**
 * Data source for user-selected local directories
 */
export class LocalUserDirDataSource {
  constructor() {
    /** @type {Map<string, File>} Files loaded via file input */
    this._files = new Map();

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.directoryPath = null;

    /** @type {DatasetMetadata|null} */
    this._metadata = null;

    /**
     * Exact dataset_identity.json id owned by the adopted source. This may
     * differ from the application-facing dataset id for prepared directories.
     * @type {string|null}
     */
    this._identityId = null;

    /** @type {Map<string, string>} */
    this._objectUrls = new Map();

    /**
     * Large gene collections are validated when a payload is first requested,
     * rather than streaming thousands of files during folder adoption.
     * @type {Map<string, {dtype: string, expectedBytes: number}>}
     */
    this._preparedLazyValidationPlans = new Map();

    /** @type {Map<string, Promise<void>>} */
    this._preparedLazyValidationPromises = new Map();

    /** @type {H5adDataSource|null} H5AD source for h5ad files */
    this._h5adSource = null;

    /** @type {ZarrDataSource|null} Zarr source for zarr directories */
    this._zarrSource = null;

    /** @type {'directory'|'h5ad'|'zarr'|null} */
    this._sourceMode = null;

    /**
     * Monotonic identity for user selections. Async work may publish state only
     * while the epoch it captured is still current.
     * @type {number}
     */
    this._selectionEpoch = 0;

    /** @type {AbortController|null} */
    this._selectionController = null;

    /**
     * Monotonic identity of committed working source state. Unlike the
     * selection epoch, rejected candidates do not advance this identity.
     * @type {number}
     */
    this._adoptionEpoch = 0;

    this.type = 'local-user';
  }

  /**
   * Start a new user selection.
   * @returns {number} Epoch owned by the new selection
   * @private
   */
  _beginSelection() {
    this._selectionController?.abort();
    this._selectionController = new AbortController();
    this._selectionEpoch += 1;
    return this._selectionEpoch;
  }

  /**
   * Create an actionable cancellation error for work superseded by a newer
   * user selection.
   * @returns {Error}
   * @private
   */
  _createSupersededSelectionError() {
    return createDatasetReloadSupersededError(
      'This local data selection was superseded by a newer selection.'
    );
  }

  /**
   * Prevent stale async work from publishing or returning as a successful load.
   * @param {number} selectionEpoch
   * @private
   */
  _assertSelectionCurrent(selectionEpoch, signal = null) {
    if (
      signal?.aborted ||
      selectionEpoch !== this._selectionEpoch
    ) {
      throw this._createSupersededSelectionError();
    }
  }

  /**
   * Get the type identifier for this data source
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Create an isolated local-file selection candidate. File parsing and
   * prepared-data validation must never mutate the registered generation.
   *
   * @returns {LocalUserDirDataSource}
   */
  createSelectionCandidate() {
    return new LocalUserDirDataSource();
  }

  /**
   * Return the monotonic identity of the current local selection.
   * Consumers use this to reject async work that spans a replacement.
   *
   * @returns {number}
   */
  getSelectionIdentity() {
    return this._selectionEpoch;
  }

  /**
   * Return the identity of the currently adopted working source.
   *
   * @returns {number}
   */
  getAdoptionIdentity() {
    return this._adoptionEpoch;
  }

  /**
   * Check if this data source is available (has files loaded)
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    // In h5ad mode, check if h5ad source is available
    if (this._sourceMode === 'h5ad' && this._h5adSource) {
      return this._h5adSource.isAvailable();
    }
    // In zarr mode, check if zarr source is available
    if (this._sourceMode === 'zarr' && this._zarrSource) {
      return this._zarrSource.isAvailable();
    }
    // In directory mode, check if files are loaded
    return this._files.size > 0;
  }

  /**
   * Get the directory path (for display)
   * @returns {string|null}
   */
  getPath() {
    return this.directoryPath;
  }

  /**
   * Load an h5ad file directly
   * @param {File} file - h5ad file
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromH5adFile(file) {
    const selectionEpoch = this._beginSelection();
    if (!isH5adFile(file)) {
      throw new DataSourceError(
        'Not an h5ad file. Expected .h5ad extension.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const candidateSource = createH5adDataSource();
    let adopted = false;

    try {
      const sourceDatasetId =
        `h5ad_${file.name.replace(/\.h5ad$/i, '')}`;
      const candidateDatasetId = createLocalApplicationDatasetId(
        'h5ad',
        sourceDatasetId
      );
      await candidateSource.loadFromFile(
        file,
        {
          showProgress: false,
          datasetId: candidateDatasetId,
          description: 'Loaded directly from H5AD file',
          source: {
            name: 'H5AD file',
            filename: file.name,
          },
        }
      );
      this._assertSelectionCurrent(selectionEpoch);

      const candidateMetadata =
        await candidateSource.getMetadata(candidateDatasetId);
      this._assertSelectionCurrent(selectionEpoch);

      // Commit only after the candidate is completely usable.
      this._cleanup();
      this._h5adSource = candidateSource;
      this._sourceMode = 'h5ad';
      this.datasetId = candidateDatasetId;
      this.directoryPath = file.name;
      this._metadata = candidateMetadata;
      this._identityId = candidateMetadata.id;
      this._adoptionEpoch += 1;
      adopted = true;

      console.log(`[LocalUserDirDataSource] Loaded h5ad file: ${file.name}`);

      return this._metadata;
    } catch (error) {
      if (selectionEpoch !== this._selectionEpoch) {
        throw this._createSupersededSelectionError();
      }
      throw error;
    } finally {
      if (!adopted) {
        candidateSource.clear();
      }
    }
  }

  /**
   * Load a portable ZIP archive containing a Zarr v2 store.
   * @param {File|Blob} file
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromZarrArchive(file) {
    const selectionEpoch = this._beginSelection();
    if (!isZarrZipArchive(file)) {
      throw new DataSourceError(
        'Not a Zarr ZIP archive. Expected a .zip file.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const candidateSource = createZarrDataSource();
    let adopted = false;

    try {
      const sourceDatasetId =
        `zarr_${file.name
          .replace(/\.zip$/i, '')
          .replace(/\.zarr$/i, '')}`;
      const candidateDatasetId = createLocalApplicationDatasetId(
        'zarr-archive',
        sourceDatasetId
      );
      await candidateSource.loadFromArchiveFile(
        file,
        {
          showProgress: false,
          datasetId: candidateDatasetId,
          description: 'Loaded directly from Zarr ZIP archive',
          source: {
            name: 'Zarr ZIP archive',
            filename: file.name,
          },
        }
      );
      this._assertSelectionCurrent(selectionEpoch);

      const candidateDirectoryPath = candidateSource.dirname;
      const candidateMetadata =
        await candidateSource.getMetadata(candidateDatasetId);
      this._assertSelectionCurrent(selectionEpoch);

      this._cleanup();
      this._zarrSource = candidateSource;
      this._sourceMode = 'zarr';
      this.datasetId = candidateDatasetId;
      this.directoryPath = candidateDirectoryPath;
      this._metadata = candidateMetadata;
      this._identityId = candidateMetadata.id;
      this._adoptionEpoch += 1;
      adopted = true;

      console.log(
        `[LocalUserDirDataSource] Loaded Zarr ZIP archive: ` +
        `${this.directoryPath}`
      );
      return this._metadata;
    } catch (error) {
      if (selectionEpoch !== this._selectionEpoch) {
        throw this._createSupersededSelectionError();
      }
      throw error;
    } finally {
      if (!adopted) {
        candidateSource.clear();
      }
    }
  }

  /**
   * Load one prepared Cellucid export directory.
   * @param {FileList} fileList - Files from directory input
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromPreparedDirectory(fileList) {
    const selectionEpoch = this._beginSelection();
    if (!fileList || fileList.length === 0) {
      throw new DataSourceError(
        'No prepared dataset directory selected.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    const signal = this._selectionController.signal;
    const candidateSource = new LocalUserDirDataSource();
    let adopted = false;

    const firstFile = fileList[0];
    const firstPath = firstFile?.webkitRelativePath;
    if (
      typeof firstPath !== 'string' ||
      firstPath.length === 0 ||
      !firstPath.includes('/')
    ) {
      throw preparedDataError(
        'Prepared data must be selected with the prepared-directory control.',
        this.type
      );
    }
    const rootDirectory = firstPath.split('/')[0];
    if (!rootDirectory) {
      throw preparedDataError(
        'Prepared directory entries must include one common root directory.',
        this.type
      );
    }
    candidateSource.directoryPath = rootDirectory;
    candidateSource._sourceMode = 'directory';

    console.log(
      `[LocalUserDirDataSource] Loading ${fileList.length} files from: ` +
      candidateSource.directoryPath
    );

    for (const file of fileList) {
      const entryPath = file?.webkitRelativePath;
      if (
        typeof entryPath !== 'string' ||
        entryPath.length === 0
      ) {
        throw preparedDataError(
          'Every prepared directory entry must include its relative path.',
          this.type
        );
      }
      const pathParts = entryPath.split('/');
      if (pathParts[0] !== rootDirectory) {
        throw preparedDataError(
          'A prepared selection must contain exactly one root directory.',
          this.type,
          { entryPath, rootDirectory }
        );
      }
      const filename = validatePreparedPath(
        pathParts.slice(1).join('/'),
        'Prepared directory entry',
        this.type
      );
      if (candidateSource._files.has(filename)) {
        throw preparedDataError(
          `Prepared directory contains duplicate path "${filename}".`,
          this.type,
          { filename }
        );
      }
      candidateSource._files.set(filename, file);
    }

    console.log(
      `[LocalUserDirDataSource] Indexed ${candidateSource._files.size} files`
    );

    try {
      // Validate against isolated candidate state. The working source remains
      // untouched if validation fails or this selection becomes stale.
      await candidateSource._validateAndLoadMetadata({ signal });
      this._assertSelectionCurrent(selectionEpoch, signal);

      this._cleanup();
      this._files = candidateSource._files;
      candidateSource._files = new Map();
      this._preparedLazyValidationPlans =
        candidateSource._preparedLazyValidationPlans;
      candidateSource._preparedLazyValidationPlans = new Map();
      this._sourceMode = 'directory';
      this.datasetId = candidateSource.datasetId;
      this.directoryPath = candidateSource.directoryPath;
      this._metadata = candidateSource._metadata;
      this._identityId = candidateSource._identityId;
      this._adoptionEpoch += 1;
      adopted = true;

      return this._metadata;
    } catch (error) {
      if (selectionEpoch !== this._selectionEpoch) {
        throw this._createSupersededSelectionError();
      }
      throw error;
    } finally {
      if (!adopted) {
        candidateSource._cleanup();
      }
    }
  }

  /**
   * Validate directory structure and load metadata
   * @private
   */
  async _validateAndLoadMetadata({ signal = null } = {}) {
    throwIfPreparedAborted(signal);
    const requiredFiles = [...DATA_CONFIG.REQUIRED_FILES];
    const missing = [];

    for (const filename of requiredFiles) {
      if (!this._fileExists(filename)) missing.push(filename);
    }
    if (missing.length > 0) {
      throw new DataSourceError(
        `Invalid dataset: missing required files: ${missing.join(', ')}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { missing }
      );
    }

    await this._loadMetadata({ signal });
  }

  /**
   * Check if a file exists
   * @param {string} filename - Filename to check
   * @returns {boolean}
   * @private
   */
  _fileExists(filename) {
    return this._files.has(filename);
  }

  /**
   * Get a File object by filename
   * @param {string} filename - Filename to get
   * @returns {File}
   * @private
   */
  _getFile(filename) {
    const file = this._files.get(filename);
    if (!file) {
      throw new DataSourceError(
        `File not found: ${filename}`,
        DataSourceErrorCode.FILE_NOT_FOUND,
        this.type,
        { filename }
      );
    }
    return file;
  }

  /**
   * Read a file as text
   * @param {string} filename - Filename to read
   * @returns {Promise<string>}
   * @private
   */
  async _readFileAsText(filename, signal = null) {
    throwIfPreparedAborted(signal);
    const file = this._getFile(filename);
    // A size that is not a size is a broken File, not an oversized one: the two
    // need different advice and so carry different codes.
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw preparedDataError(
        `${filename} does not report a readable byte length`,
        this.type,
        { filename, size: file.size }
      );
    }
    if (file.size > MAX_METADATA_JSON_BYTES) {
      throw preparedTooLargeError(
        `${filename} exceeds the ${MAX_METADATA_JSON_BYTES}-byte metadata limit`,
        this.type,
        { filename, size: file.size }
      );
    }
    const text = await file.text();
    throwIfPreparedAborted(signal);
    if (text.length > MAX_METADATA_JSON_BYTES) {
      throw preparedTooLargeError(
        `${filename} exceeds the ${MAX_METADATA_JSON_BYTES}-character metadata limit`,
        this.type,
        { filename, length: text.length }
      );
    }
    return text;
  }

  /**
   * Read a file as JSON
   * @param {string} filename - Filename to read
   * @returns {Promise<any>}
   * @private
   */
  async _readFileAsJson(filename, signal = null) {
    const text = await this._readFileAsText(filename, signal);
    return JSON.parse(text);
  }

  async _readRequiredJson(filename, signal = null) {
    try {
      return await this._readFileAsJson(filename, signal);
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      // A file refused for its size never reached JSON.parse, so calling it
      // "Invalid <filename>" accuses a document nothing has read yet.
      if (cause?.code === DataSourceErrorCode.TOO_LARGE) throw cause;
      throw preparedDataError(
        `Invalid ${filename}: ${cause?.message || cause}`,
        this.type,
        { filename, cause }
      );
    }
  }

  _validatePreparedFileEnvelope(filename, expectedBytes) {
    let file;
    try {
      file = this._getFile(filename);
    } catch (cause) {
      throw preparedDataError(
        `${filename}: missing advertised payload`,
        this.type,
        { filename, cause }
      );
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw preparedDataError(
        `${filename}: does not report a readable byte length`,
        this.type,
        { filename, actualBytes: file.size }
      );
    }
    if (file.size > MAX_PREPARED_BROWSER_BYTES) {
      throw preparedTooLargeError(
        `${filename}: compressed or binary file size exceeds the 512 MiB browser limit`,
        this.type,
        { filename, actualBytes: file.size }
      );
    }
    if (filename.endsWith('.gz')) {
      if (file.size < 18) {
        throw preparedDataError(
          `${filename}: invalid or truncated gzip payload`,
          this.type
        );
      }
    } else if (file.size !== expectedBytes) {
      throw preparedDataError(
        `${filename}: expected ${expectedBytes} bytes, found ${file.size}`,
        this.type,
        { filename, expectedBytes, actualBytes: file.size }
      );
    }
    return file;
  }

  async _validatePreparedFileLength(
    filename,
    expectedBytes,
    {
      dtype = null,
      signal = null,
      validateValue = null,
    } = {}
  ) {
    throwIfPreparedAborted(signal);
    const file = this._validatePreparedFileEnvelope(
      filename,
      expectedBytes
    );
    const GzipDecompressionStream = filename.endsWith('.gz')
      ? requirePreparedGzipDecompressionStream(filename, this.type)
      : null;
    if (filename.endsWith('.gz')) {
      const header = new Uint8Array(
        await file.slice(0, 10).arrayBuffer()
      );
      throwIfPreparedAborted(signal);
      if (
        header[0] !== 0x1f ||
        header[1] !== 0x8b ||
        header[2] !== 8 ||
        (header[3] & 0xe0) !== 0
      ) {
        throw preparedDataError(
          `${filename}: invalid gzip header`,
          this.type,
          { filename }
        );
      }
      const trailer = await file.slice(file.size - 4, file.size).arrayBuffer();
      throwIfPreparedAborted(signal);
      const declaredBytes = new DataView(trailer).getUint32(0, true);
      if (declaredBytes !== expectedBytes) {
        throw preparedDataError(
          `${filename}: expected ${expectedBytes} bytes after decompression, but gzip declares ${declaredBytes} bytes`,
          this.type,
          { filename, expectedBytes, declaredBytes }
        );
      }
    }

    if (!dtype) return;
    await this._validatePreparedBinaryStream(
      file,
      filename,
      expectedBytes,
      {
        dtype,
        signal,
        validateValue,
        GzipDecompressionStream,
      }
    );
  }

  async _validatePreparedFileOnDemand(filename, ownerSignal) {
    validateAbortSignalOrNull(
      ownerSignal,
      'Prepared file URL resolution signal'
    );
    throwIfMetadataAborted(
      ownerSignal,
      'Prepared file URL resolution'
    );
    const plan = this._preparedLazyValidationPlans.get(filename);
    if (!plan) return;

    const pending = this._preparedLazyValidationPromises.get(filename);
    if (pending) {
      await waitForMetadata(
        pending,
        ownerSignal,
        'Prepared file URL resolution'
      );
      return;
    }

    const adoptionEpoch = this._adoptionEpoch;
    const linked = linkPreparedAbortSignals(
      this._selectionController?.signal ?? null,
      ownerSignal
    );
    const validation = (async () => {
      try {
        await this._validatePreparedFileLength(
          filename,
          plan.expectedBytes,
          { dtype: plan.dtype, signal: linked.signal }
        );
        if (adoptionEpoch !== this._adoptionEpoch) {
          throw this._createSupersededSelectionError();
        }
        if (this._preparedLazyValidationPlans.get(filename) === plan) {
          this._preparedLazyValidationPlans.delete(filename);
        }
      } finally {
        linked.release();
      }
    })();
    this._preparedLazyValidationPromises.set(filename, validation);
    const clearSettledValidation = () => {
      if (this._preparedLazyValidationPromises.get(filename) === validation) {
        this._preparedLazyValidationPromises.delete(filename);
      }
    };
    validation.then(
      clearSettledValidation,
      clearSettledValidation
    );
    await waitForMetadata(
      validation,
      ownerSignal,
      'Prepared file URL resolution'
    );
  }

  async _validatePreparedBinaryStream(
    file,
    filename,
    expectedBytes,
    {
      dtype,
      signal = null,
      validateValue = null,
      GzipDecompressionStream = null,
    }
  ) {
    const dtypeInfo = PREPARED_DTYPE_INFO[dtype];
    if (!dtypeInfo) {
      throw preparedDataError(
        `${filename}: unsupported validation dtype "${String(dtype)}"`,
        this.type
      );
    }
    let stream;
    let reader = null;
    try {
      throwIfPreparedAborted(signal);
      if (filename.endsWith('.gz')) {
        if (typeof GzipDecompressionStream !== 'function') {
          throw new Error(
            'gzip validation requires a selected DecompressionStream backend'
          );
        }
        stream = file.stream().pipeThrough(
          new GzipDecompressionStream('gzip')
        );
      } else {
        stream = file.stream();
      }

      reader = stream.getReader();
      let totalBytes = 0;
      let carry = new Uint8Array(0);
      let valueIndex = 0;
      while (true) {
        const readPromise = Promise.resolve(reader.read());
        let abortListener = null;
        const abortPromise = signal
          ? new Promise((_, reject) => {
              abortListener = () => {
                const error = createPreparedAbortError();
                Promise.resolve(reader.cancel(error)).catch(() => {});
                reject(error);
              };
              signal.addEventListener('abort', abortListener, { once: true });
              if (signal.aborted) abortListener();
            })
          : null;
        let result;
        try {
          result = abortPromise
            ? await Promise.race([readPromise, abortPromise])
            : await readPromise;
        } finally {
          if (abortListener) {
            signal.removeEventListener('abort', abortListener);
          }
        }
        throwIfPreparedAborted(signal);
        const { done, value } = result;
        if (done) break;
        const chunk = value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > expectedBytes) {
          throw preparedDataError(
            `${filename}: expected ${expectedBytes} bytes, decompressed beyond that size`,
            this.type,
            { filename, expectedBytes, actualBytes: totalBytes }
          );
        }

        let bytes = chunk;
        if (carry.byteLength > 0) {
          bytes = new Uint8Array(carry.byteLength + chunk.byteLength);
          bytes.set(carry);
          bytes.set(chunk, carry.byteLength);
        }

        const completeBytes =
          bytes.byteLength - (bytes.byteLength % dtypeInfo.bytes);
        const values = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          completeBytes
        );
        for (
          let offset = 0;
          offset < completeBytes;
          offset += dtypeInfo.bytes
        ) {
          const parsed = dtypeInfo.read(values, offset);
          if (validateValue) {
            validateValue(parsed, valueIndex);
          }
          valueIndex++;
        }
        carry = bytes.slice(completeBytes);
      }

      if (totalBytes !== expectedBytes || carry.byteLength !== 0) {
        throw preparedDataError(
          `${filename}: expected ${expectedBytes} bytes, decompressed to ${totalBytes}`,
          this.type,
          { filename, expectedBytes, actualBytes: totalBytes }
        );
      }
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      if (cause instanceof DataSourceError) throw cause;
      throw preparedDataError(
        `${filename}: invalid gzip, compressed, or binary payload (${cause?.message || cause})`,
        this.type,
        { filename, cause }
      );
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        // The stream may already be cancelled and unlocked.
      }
    }
  }

  async _validatePreparedObsPayloads(obsManifest, signal = null) {
    for (const field of obsManifest.fields) {
      throwIfPreparedAborted(signal);
      if (field.kind === 'continuous') {
        const filename = validatePreparedPath(
          field.valuesPath,
          `Observation values for "${field.key}"`,
          this.type
        );
        const dtypeBytes = preparedDtypeBytes(
          field.valuesDtype,
          `Observation values for "${field.key}"`,
          this.type
        );
        const expectedBytes = checkedPreparedBytes(
          obsManifest.n_points,
          dtypeBytes,
          filename,
          this.type
        );
        await this._validatePreparedFileLength(
          filename,
          expectedBytes,
          {
            dtype: field.valuesDtype,
            signal,
          }
        );
      } else {
        if (!Array.isArray(field.categories)) {
          throw preparedDataError(
            `Invalid obs_manifest.json: categorical field "${field.key}" is missing categories`,
            this.type
          );
        }
        if (field.categories.length > MAX_CATEGORICAL_CATEGORIES) {
          throw preparedDataError(
            `Invalid obs_manifest.json: categorical field "${field.key}" ` +
            `exceeds ${MAX_CATEGORICAL_CATEGORIES.toLocaleString('en-US')} categories`,
            this.type
          );
        }
        const seenCategories = new Set();
        for (const category of field.categories) {
          if (
            category === null ||
            category === undefined ||
            (typeof category !== 'string' &&
              typeof category !== 'boolean' &&
              typeof category !== 'number') ||
            (typeof category === 'number' && !Number.isFinite(category)) ||
            seenCategories.has(category)
          ) {
            throw preparedDataError(
              `Invalid obs_manifest.json: categorical field "${field.key}" has missing, duplicate, or unsupported categories`,
              this.type
            );
          }
          seenCategories.add(category);
        }
        const filename = validatePreparedPath(
          field.codesPath,
          `Observation codes for "${field.key}"`,
          this.type
        );
        const codesDtype = field.codesDtype;
        if (codesDtype !== 'uint8' && codesDtype !== 'uint16') {
          throw preparedDataError(
            `Observation codes for "${field.key}" must use uint8 or uint16`,
            this.type
          );
        }
        const codesStorage = categoricalStorageForDtype(
          codesDtype,
          `Observation codes for "${field.key}"`
        );
        const dtypeBytes = preparedDtypeBytes(
          codesDtype,
          `Observation codes for "${field.key}"`,
          this.type
        );
        const expectedBytes = checkedPreparedBytes(
          obsManifest.n_points,
          dtypeBytes,
          filename,
          this.type
        );
        // The missing sentinel is the terminal code of its width, exactly, and
        // `categorical-storage-contract.js` is where that pairing is derived
        // for every reader. Accepting a wider range here only let a manifest
        // this reader cannot actually interpret pass its first gate and fail
        // later, from a layer that no longer knows which file was wrong.
        const requiredMissing = codesStorage.missingValue;
        const missingValue = field.codesMissingValue;
        if (
          missingValue !== requiredMissing ||
          field.categories.length > codesStorage.maxCategories
        ) {
          throw preparedDataError(
            `Invalid obs_manifest.json: categorical field "${field.key}" must ` +
            `declare the exact ${codesDtype} missing sentinel ${requiredMissing} ` +
            `and at most ${requiredMissing} categories`,
            this.type
          );
        }
        await this._validatePreparedFileLength(
          filename,
          expectedBytes,
          {
            dtype: codesDtype,
            signal,
            validateValue: (value, index) => {
              if (
                value !== missingValue &&
                value >= field.categories.length
              ) {
                throw preparedDataError(
                  `${filename}: categorical code ${value} at cell ${index} exceeds ${field.categories.length} categories`,
                  this.type,
                  { filename, index, value }
                );
              }
            },
          }
        );
      }

      if (field.outlierQuantilesPath) {
        const filename = validatePreparedPath(
          field.outlierQuantilesPath,
          `Observation outliers for "${field.key}"`,
          this.type
        );
        const dtypeBytes = preparedDtypeBytes(
          field.outlierDtype,
          `Observation outliers for "${field.key}"`,
          this.type
        );
        const expectedBytes = checkedPreparedBytes(
          obsManifest.n_points,
          dtypeBytes,
          filename,
          this.type
        );
        await this._validatePreparedFileLength(
          filename,
          expectedBytes,
          {
            dtype: field.outlierDtype,
            signal,
          }
        );
      }
    }
  }

  async _validatePreparedVarPayloads(
    identity,
    settings,
    compression,
    signal = null
  ) {
    this._preparedLazyValidationPlans.clear();
    const stats = identity.stats;
    const hasManifest = this._fileExists('var_manifest.json');
    const advertisedGenes = stats.n_genes;
    if (!hasManifest) {
      if (advertisedGenes > 0) {
        throw preparedDataError(
          'dataset_identity.json advertises genes but var_manifest.json is missing',
          this.type
        );
      }
      return null;
    }

    const rawManifest = await this._readRequiredJson(
      'var_manifest.json',
      signal
    );
    let manifest;
    try {
      manifest = expandVarManifest(rawManifest);
    } catch (cause) {
      throw preparedDataError(
        `Invalid var_manifest.json: ${cause?.message || cause}`,
        this.type,
        { cause }
      );
    }
    if (
      !isPlainObject(manifest) ||
      !Number.isSafeInteger(manifest.n_points) ||
      manifest.n_points !== identity.stats.n_cells ||
      !Array.isArray(manifest.fields)
    ) {
      throw preparedDataError(
        'Invalid var_manifest.json: n_points must match the dataset and fields must be an array',
        this.type
      );
    }
    if (manifest.compression !== compression) {
      throw preparedDataError(
        'var_manifest.json compression must exactly match the export ' +
        'compression declared by obs_manifest.json.',
        this.type,
        {
          manifestCompression: manifest.compression,
          exportCompression: compression,
        }
      );
    }
    if (
      settings !== null &&
      manifest.quantization !== settings.var_quantization
    ) {
      throw preparedDataError(
        'var_manifest.json compression and quantization must exactly ' +
        'match dataset_identity.json export_settings.',
        this.type
      );
    }

    const seenKeys = new Set();
    const seenPaths = new Set();
    const plans = [];
    let totalExpectedBytes = 0n;
    for (const field of manifest.fields) {
      throwIfPreparedAborted(signal);
      if (
        !isPlainObject(field) ||
        typeof field.key !== 'string' ||
        field.key.length === 0 ||
        seenKeys.has(field.key) ||
        field.kind !== 'continuous'
      ) {
        throw preparedDataError(
          'Invalid var_manifest.json: gene fields require unique non-empty keys and continuous kind',
          this.type
        );
      }
      seenKeys.add(field.key);
      const filename = validatePreparedPath(
        field.valuesPath,
        `Gene values for "${field.key}"`,
        this.type
      );
      validatePreparedPathCompression(
        filename,
        compression,
        `Gene values for "${field.key}"`,
        this.type
      );
      if (seenPaths.has(filename)) {
        throw preparedDataError(
          `Invalid var_manifest.json: multiple genes map to "${filename}"`,
          this.type
        );
      }
      seenPaths.add(filename);
      const dtype = field.valuesDtype;
      const dtypeBytes = preparedDtypeBytes(
        dtype,
        `Gene values for "${field.key}"`,
        this.type
      );
      if (
        field.quantized &&
        (
          (dtype !== 'uint8' && dtype !== 'uint16') ||
          !Number.isFinite(field.minValue) ||
          !Number.isFinite(field.maxValue) ||
          field.minValue > field.maxValue
        )
      ) {
        throw preparedDataError(
          `Invalid var_manifest.json: gene "${field.key}" has an invalid quantization contract`,
          this.type
        );
      }
      const expectedBytes = checkedPreparedBytes(
        manifest.n_points,
        dtypeBytes,
        filename,
        this.type
      );
      totalExpectedBytes += BigInt(expectedBytes);
      plans.push({ dtype, expectedBytes, filename });
    }

    if (advertisedGenes !== plans.length) {
      throw preparedDataError(
        `dataset_identity.json stats.n_genes (${advertisedGenes}) does not match var_manifest.json (${plans.length})`,
        this.type,
        { advertisedGenes, actualGenes: plans.length }
      );
    }
    const eagerIntegrityScan =
      plans.length <= MAX_EAGER_GENE_VALIDATION_FILES &&
      totalExpectedBytes <= BigInt(MAX_EAGER_GENE_VALIDATION_BYTES);
    if (eagerIntegrityScan) {
      for (const plan of plans) {
        await this._validatePreparedFileLength(
          plan.filename,
          plan.expectedBytes,
          { dtype: plan.dtype, signal }
        );
      }
    } else {
      for (const plan of plans) {
        throwIfPreparedAborted(signal);
        this._validatePreparedFileEnvelope(
          plan.filename,
          plan.expectedBytes
        );
        this._preparedLazyValidationPlans.set(plan.filename, {
          dtype: plan.dtype,
          expectedBytes: plan.expectedBytes,
        });
      }
    }
    return manifest;
  }

  async _validatePreparedConnectivity(
    identity,
    compression,
    signal = null
  ) {
    const stats = identity.stats;
    const hasManifest = this._fileExists('connectivity_manifest.json');
    const advertised = stats.has_connectivity;
    if (
      !Object.hasOwn(stats, 'has_connectivity') ||
      typeof advertised !== 'boolean'
    ) {
      throw preparedDataError(
        'dataset_identity.json stats.has_connectivity is required and must be boolean',
        this.type
      );
    }
    if (!Object.hasOwn(stats, 'n_edges')) {
      throw preparedDataError(
        'dataset_identity.json stats.n_edges is required',
        this.type
      );
    }
    if (advertised === false) {
      if (stats.n_edges !== null) {
        throw preparedDataError(
          'dataset_identity.json stats.n_edges must be null when has_connectivity is false',
          this.type
        );
      }
      if (hasManifest) {
        throw preparedDataError(
          'dataset_identity.json connectivity summary contradicts connectivity_manifest.json',
          this.type
        );
      }
      return null;
    }
    if (!Number.isSafeInteger(stats.n_edges) || stats.n_edges < 0) {
      throw preparedDataError(
        'dataset_identity.json stats.n_edges must be a non-negative safe integer when has_connectivity is true',
        this.type
      );
    }
    if (!hasManifest) {
      throw preparedDataError(
        'dataset_identity.json advertises connectivity but connectivity_manifest.json is missing',
        this.type
      );
    }

    const rawManifest = await this._readRequiredJson(
      'connectivity_manifest.json',
      signal
    );
    let manifest;
    try {
      manifest = validateConnectivityManifest(
        rawManifest,
        CONNECTIVITY_MANIFEST_CONTEXT.FILE
      );
    } catch (cause) {
      throw preparedDataError(
        `Invalid connectivity_manifest.json: ${cause?.message || cause}`,
        this.type,
        { cause }
      );
    }
    requirePreparedExactKeys(
      manifest,
      [
        'format',
        'n_cells',
        'n_edges',
        'max_neighbors',
        'index_bytes',
        'index_dtype',
        'sourcesPath',
        'destinationsPath',
        'weightsPath',
        'weight_bytes',
        'weight_dtype',
        'compression',
      ],
      [],
      'connectivity_manifest.json',
      this.type
    );
    if (
      manifest.format !== 'edge_pairs' ||
      !Number.isSafeInteger(manifest.n_cells) ||
      manifest.n_cells !== identity.stats.n_cells ||
      !Number.isSafeInteger(manifest.n_edges) ||
      manifest.n_edges < 0
    ) {
      throw preparedDataError(
        'Invalid connectivity_manifest.json: expected cell-aligned edge_pairs metadata',
        this.type
      );
    }
    if (manifest.n_cells > 0x1_0000_0000) {
      throw preparedDataError(
        'connectivity_manifest.json exceeds the browser uint32 cell-index limit',
        this.type
      );
    }
    const {
      dtype: expectedDtype,
      bytes: expectedWidth,
    } = getConnectivityIndexStorage(manifest.n_cells);
    if (
      manifest.index_dtype !== expectedDtype ||
      manifest.index_bytes !== expectedWidth
    ) {
      throw preparedDataError(
        'Invalid connectivity_manifest.json: index_dtype and index_bytes ' +
        'must use the smallest exact unsigned cell-index representation.',
        this.type,
        {
          expectedDtype,
          expectedWidth,
          actualDtype: manifest.index_dtype,
          actualWidth: manifest.index_bytes,
        }
      );
    }
    if (
      manifest.weight_dtype !== 'float64' ||
      manifest.weight_bytes !== Float64Array.BYTES_PER_ELEMENT
    ) {
      throw preparedDataError(
        'Invalid connectivity_manifest.json: weight_dtype and weight_bytes ' +
        'must use exact float64/8-byte edge weights.',
        this.type
      );
    }
    requirePreparedCompressionLevel(
      manifest.compression,
      'connectivity_manifest.json compression',
      this.type
    );
    if (manifest.compression !== compression) {
      throw preparedDataError(
        'connectivity_manifest.json compression must exactly match the ' +
        'export compression declared by obs_manifest.json.',
        this.type,
        {
          manifestCompression: manifest.compression,
          exportCompression: compression,
        }
      );
    }
    if (
      (
        !Number.isSafeInteger(manifest.max_neighbors) ||
        manifest.max_neighbors < 0 ||
        manifest.max_neighbors >
          Math.max(0, manifest.n_cells - 1)
      )
    ) {
      throw preparedDataError(
        'Invalid connectivity_manifest.json: max_neighbors is outside the cell axis',
        this.type
      );
    }
    const sourcesPath = validatePreparedPath(
      manifest.sourcesPath,
      'Connectivity sources',
      this.type
    );
    const destinationsPath = validatePreparedPath(
      manifest.destinationsPath,
      'Connectivity destinations',
      this.type
    );
    const weightsPath = validatePreparedPath(
      manifest.weightsPath,
      'Connectivity weights',
      this.type
    );
    validatePreparedPathCompression(
      sourcesPath,
      manifest.compression,
      'Connectivity sources',
      this.type
    );
    validatePreparedPathCompression(
      destinationsPath,
      manifest.compression,
      'Connectivity destinations',
      this.type
    );
    validatePreparedPathCompression(
      weightsPath,
      manifest.compression,
      'Connectivity weights',
      this.type
    );
    if (
      new Set([sourcesPath, destinationsPath, weightsPath]).size !== 3
    ) {
      throw preparedDataError(
        'Invalid connectivity_manifest.json: source, destination, and weight paths must differ',
        this.type
      );
    }
    const expectedBytes = checkedPreparedBytes(
      manifest.n_edges,
      expectedWidth,
      'Connectivity edge arrays',
      this.type
    );
    const expectedWeightBytes = checkedPreparedBytes(
      manifest.n_edges,
      Float64Array.BYTES_PER_ELEMENT,
      'Connectivity weight array',
      this.type
    );
    const normalizedIndexBytes = checkedPreparedBytes(
      manifest.n_edges,
      Uint32Array.BYTES_PER_ELEMENT,
      'Connectivity normalized edge arrays',
      this.type
    );
    const degreeBytes = checkedPreparedBytes(
      manifest.n_cells,
      Uint32Array.BYTES_PER_ELEMENT,
      'Connectivity degree summary',
      this.type
    );
    checkedPreparedWorkingSet(
      [
        expectedBytes,
        expectedBytes,
        normalizedIndexBytes,
        normalizedIndexBytes,
        normalizedIndexBytes,
        normalizedIndexBytes,
        expectedWeightBytes,
        degreeBytes,
      ],
      'Connectivity edge arrays',
      this.type
    );
    if (stats.n_edges !== manifest.n_edges) {
      throw preparedDataError(
        `dataset_identity.json stats.n_edges (${stats.n_edges}) does not match connectivity_manifest.json (${manifest.n_edges})`,
        this.type,
        {
          advertisedEdges: stats.n_edges,
          actualEdges: manifest.n_edges,
        }
      );
    }

    const sources = new Uint32Array(manifest.n_edges);
    const destinations = new Uint32Array(manifest.n_edges);
    const captureIndex = (target, streamLabel) => (value, index) => {
      const inBounds = typeof value === 'bigint'
        ? value < BigInt(manifest.n_cells)
        : value < manifest.n_cells;
      if (!inBounds) {
        throw preparedDataError(
          `Connectivity index ${String(value)} at edge ${index} exceeds the cell axis`,
          this.type
        );
      }
      const numericValue = Number(value);
      if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
        throw preparedDataError(
          `${streamLabel} index ${String(value)} at edge ${index} is invalid`,
          this.type
        );
      }
      target[index] = numericValue;
    };
    await this._validatePreparedFileLength(
      sourcesPath,
      expectedBytes,
      {
        dtype: expectedDtype,
        signal,
        validateValue: captureIndex(sources, 'Connectivity source'),
      }
    );
    await this._validatePreparedFileLength(
      destinationsPath,
      expectedBytes,
      {
        dtype: expectedDtype,
        signal,
        validateValue: captureIndex(
          destinations,
          'Connectivity destination'
        ),
      }
    );
    await this._validatePreparedFileLength(
      weightsPath,
      expectedWeightBytes,
      {
        dtype: 'float64',
        signal,
        validateValue: (value, index) => {
          if (!Number.isFinite(value) || !(value > 0)) {
            throw preparedDataError(
              `Connectivity weight ${String(value)} at edge ${index} must be finite and strictly positive`,
              this.type,
              { index, value }
            );
          }
        },
      }
    );

    const degrees = new Uint32Array(manifest.n_cells);
    let actualMaxNeighbors = 0;
    let previousSource = -1;
    let previousDestination = -1;
    for (let index = 0; index < manifest.n_edges; index++) {
      const source = sources[index];
      const destination = destinations[index];
      if (source >= destination) {
        throw preparedDataError(
          `Connectivity edge ${index} must satisfy source < destination.`,
          this.type,
          { index, source, destination }
        );
      }
      if (
        index > 0 &&
        (
          source < previousSource ||
          (
            source === previousSource &&
            destination <= previousDestination
          )
        )
      ) {
        throw preparedDataError(
          'Connectivity edges must be unique and strictly ordered by ' +
          'source, then destination.',
          this.type,
          { index, source, destination }
        );
      }
      previousSource = source;
      previousDestination = destination;
      const sourceDegree = ++degrees[source];
      const destinationDegree = ++degrees[destination];
      actualMaxNeighbors = Math.max(
        actualMaxNeighbors,
        sourceDegree,
        destinationDegree
      );
    }
    if (manifest.max_neighbors !== actualMaxNeighbors) {
      throw preparedDataError(
        `connectivity_manifest.json max_neighbors (${manifest.max_neighbors}) ` +
        `does not match the edge payload (${actualMaxNeighbors}).`,
        this.type,
        {
          advertisedMaxNeighbors: manifest.max_neighbors,
          actualMaxNeighbors,
        }
      );
    }
    return manifest;
  }

  async _validatePreparedVectorFields(
    identity,
    compression,
    signal = null
  ) {
    const metadata = identity.vector_fields;
    if (metadata == null) return null;
    // The shape — exact key sets, dimension ordering, the embeddings subset
    // rule, one file per advertised dimension, and default_dimension being the
    // largest advertised one — is owned by validateVectorFieldsMetadata() in
    // data-source.js, so a local folder and a hosted catalog answer with the
    // same rule. Only the export-file rules below are specific to reading a
    // prepared export off disk.
    validateVectorFieldsMetadata(metadata, {
      availableDimensions: identity.embeddings.available_dimensions,
      sourceType: this.type,
    });
    if (metadata.default_field === null) {
      throw preparedDataError(
        'dataset_identity.json vector_fields must declare fields and one exact default_field',
        this.type
      );
    }

    // A vector payload filename is the field's integer index, so the index is
    // taken from the declaration order the producer wrote the fields in.
    const vectorFieldEntries = Object.entries(metadata.fields);
    for (
      let payloadIndex = 0;
      payloadIndex < vectorFieldEntries.length;
      payloadIndex++
    ) {
      const [fieldId, field] = vectorFieldEntries[payloadIndex];
      throwIfPreparedAborted(signal);
      // Both writers derive these two: label is the field id character for
      // character and basis is always "umap". A vector field id is not a path
      // component, so it carries no filename rule beyond naming one field.
      if (field.label !== fieldId || field.basis !== 'umap') {
        throw preparedDataError(
          `Invalid vector field "${fieldId}" id, label, or basis ` +
          'in dataset_identity.json.',
          this.type
        );
      }
      const dimensions = field.available_dimensions;
      for (const dimension of dimensions) {
        const filename = validatePreparedPath(
          field.files[`${dimension}d`],
          `Vector field "${fieldId}" ${dimension}D`,
          this.type
        );
        const expectedFilename =
          `vectors/${payloadIndex}_${dimension}d.bin` +
          (compression === null ? '' : '.gz');
        if (filename !== expectedFilename) {
          throw preparedDataError(
            `Vector field "${fieldId}" ${dimension}D must use exact ` +
            `producer path "${expectedFilename}".`,
            this.type,
            { filename, expectedFilename }
          );
        }
        validatePreparedPathCompression(
          filename,
          compression,
          `Vector field "${fieldId}" ${dimension}D`,
          this.type
        );
        const expectedBytes = checkedPreparedBytes(
          identity.stats.n_cells,
          dimension * FLOAT32_BYTES,
          filename,
          this.type
        );
        const paddedPositionBytes = checkedPreparedBytes(
          identity.stats.n_cells,
          3 * FLOAT32_BYTES,
          `${fieldId} position cache`,
          this.type
        );
        checkedPreparedWorkingSet(
          [expectedBytes, paddedPositionBytes],
          `Vector field "${fieldId}" ${dimension}D`,
          this.type
        );
        await this._validatePreparedFileLength(
          filename,
          expectedBytes,
          {
            dtype: 'float32',
            signal,
            validateValue: (value, index) => {
              if (!Number.isFinite(value)) {
                throw preparedDataError(
                  `${filename}: vector component ${index} is not finite`,
                  this.type
                );
              }
            },
          }
        );
      }
    }
    return metadata;
  }

  _validatePreparedIdentitySummaries(
    identity,
    obsManifest,
    varManifest,
    connectivityManifest
  ) {
    const derivedObs = obsManifest.fields.map(field => ({
      key: field.key,
      kind: field.kind,
      ...(field.kind === 'category'
        ? { n_categories: field.categories.length }
        : {}),
    }));
    if (
      identity.obs_fields.length !== derivedObs.length ||
      identity.obs_fields.some((summary, index) => {
        const actual = derivedObs[index];
        return (
          summary.key !== actual.key ||
          summary.kind !== actual.kind ||
          (
            summary.kind === 'category' &&
            summary.n_categories !== actual.n_categories
          )
        );
      })
    ) {
      throw preparedDataError(
        'dataset_identity.json obs_fields must exactly match obs_manifest.json in order and content.',
        this.type
      );
    }

    const actualGeneCount = varManifest?.fields.length ?? 0;
    if (identity.stats.n_genes !== actualGeneCount) {
      throw preparedDataError(
        'dataset_identity.json stats.n_genes must exactly match var_manifest.json.',
        this.type
      );
    }
    const actualConnectivity = connectivityManifest !== null;
    if (
      identity.stats.has_connectivity !== actualConnectivity ||
      (
        actualConnectivity &&
        identity.stats.n_edges !== connectivityManifest.n_edges
      )
    ) {
      throw preparedDataError(
        'dataset_identity.json connectivity stats must exactly match connectivity_manifest.json.',
        this.type
      );
    }

    return {
      obsFields: identity.obs_fields,
      stats: identity.stats,
    };
  }

  /**
   * Load dataset metadata
   * @private
   */
  async _loadMetadata({ signal = null } = {}) {
    const identity = await this._readRequiredJson(
      DATA_CONFIG.DATASET_IDENTITY_FILE,
      signal
    );
    if (
      !isPlainObject(identity) ||
      !Object.hasOwn(identity, 'id') ||
      typeof identity.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.id) ||
      identity.id.endsWith('.')
    ) {
      throw preparedDataError(
        'Invalid dataset_identity.json: id is required and must be a portable identifier using letters, numbers, dot, underscore, or hyphen.',
        this.type
      );
    }
    validateDatasetIdentity(identity, identity.id, this.type);
    const exportSettings =
      validatePreparedIdentityExportContract(identity, this.type);
    const applicationDatasetId = `local-user:${identity.id}`;

    const rawObsManifest = await this._readRequiredJson(
      'obs_manifest.json',
      signal
    );
    const obsManifest = validatePreparedObsManifest(
      rawObsManifest,
      identity,
      exportSettings,
      this.type
    );
    // obs_manifest.json is required and self-consistent: expandObsManifest()
    // has already matched its declared compression against the .gz suffix of
    // every path pattern it carries. It is therefore the export's compression,
    // and the optional export_settings block only has to agree with it.
    const exportCompression = obsManifest.compression;
    const embeddingPlan = getPreparedEmbeddingPlans(
      identity,
      exportCompression,
      this.type
    );
    for (const plan of embeddingPlan.plans) {
      checkedPreparedWorkingSet(
        plan.dimension === 3
          ? [plan.expectedBytes]
          : [plan.expectedBytes, plan.paddedBytes],
        `${plan.filename} embedding`,
        this.type
      );
    }

    const missingEmbeddingFiles = embeddingPlan.plans
      .map(plan => plan.filename)
      .filter(filename => !this._fileExists(filename));
    if (missingEmbeddingFiles.length > 0) {
      throw preparedDataError(
        `Invalid dataset: missing required embedding files: ${missingEmbeddingFiles.join(', ')}`,
        this.type,
        { missing: missingEmbeddingFiles }
      );
    }

    const varManifest = await this._validatePreparedVarPayloads(
      identity,
      exportSettings,
      exportCompression,
      signal
    );
    const connectivityManifest =
      await this._validatePreparedConnectivity(
        identity,
        exportCompression,
        signal
      );
    const vectorFields = await this._validatePreparedVectorFields(
      identity,
      exportCompression,
      signal
    );
    validatePreparedPayloadPathUniqueness(
      {
        embeddingPlan,
        obsManifest,
        varManifest,
        connectivityManifest,
        vectorFields,
      },
      this.type
    );
    const summaries = this._validatePreparedIdentitySummaries(
      identity,
      obsManifest,
      varManifest,
      connectivityManifest
    );

    await this._validatePreparedObsPayloads(obsManifest, signal);
    for (const plan of embeddingPlan.plans) {
      await this._validatePreparedFileLength(
        plan.filename,
        plan.expectedBytes,
        {
          dtype: 'float32',
          signal,
          validateValue: (value, index) => {
            if (!Number.isFinite(value)) {
              throw preparedDataError(
                `${plan.filename}: position ${index} is not a finite Float32 value`,
                this.type
              );
            }
          },
        }
      );
    }
    throwIfPreparedAborted(signal);

    const candidateMetadata = {
      ...identity,
      id: applicationDatasetId,
      stats: summaries.stats,
      embeddings: identity.embeddings,
      obs_fields: summaries.obsFields,
      ...(vectorFields ? { vector_fields: vectorFields } : {}),
    };
    validateDatasetIdentity(
      candidateMetadata,
      applicationDatasetId,
      this.type
    );
    this.datasetId = applicationDatasetId;
    this._identityId = identity.id;
    this._metadata = candidateMetadata;
    console.log('[LocalUserDirDataSource] Validated prepared dataset before adoption');
  }

  /**
   * List all available datasets from this source
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (!this._metadata) {
      return [];
    }
    return [this._metadata];
  }

  /**
   * Get metadata for a specific dataset
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    if (!this._metadata) {
      throw new DataSourceError(
        'No directory selected',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    if (typeof datasetId !== 'string' || datasetId.length === 0) {
      throw new DataSourceError(
        'An exact current dataset id is required.',
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { requestedId: datasetId, currentId: this.datasetId }
      );
    }
    if (datasetId !== this.datasetId) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found. Current dataset is '${this.datasetId}'.`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { requestedId: datasetId, currentId: this.datasetId }
      );
    }
    return this._metadata;
  }

  /**
   * Return the exact dataset_identity.json id for the current adopted dataset.
   * @param {string} datasetId - Exact application-facing dataset id
   * @returns {string}
   */
  getIdentityId(datasetId) {
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId ||
      typeof this._identityId !== 'string' ||
      this._identityId.length === 0
    ) {
      throw new DataSourceError(
        'An exact adopted dataset identity id is required.',
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
          identityId: this._identityId,
        }
      );
    }
    return this._identityId;
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    // Local user source only supports one dataset at a time
    return this.datasetId !== null && this.datasetId === datasetId;
  }

  /**
   * Get an object URL for a file (for use with fetch)
   * @param {string} filename - Filename
   * @param {AbortSignal|null} signal - Exact request owner
   * @returns {Promise<string>}
   */
  async getFileUrl(filename, signal) {
    validateAbortSignalOrNull(signal, 'Prepared file URL resolution signal');
    throwIfMetadataAborted(signal, 'Prepared file URL resolution');
    const adoptionEpoch = this._adoptionEpoch;
    await this._validatePreparedFileOnDemand(filename, signal);
    throwIfMetadataAborted(signal, 'Prepared file URL resolution');
    if (adoptionEpoch !== this._adoptionEpoch) {
      throw this._createSupersededSelectionError();
    }
    if (this._objectUrls.has(filename)) {
      return this._objectUrls.get(filename);
    }

    const file = this._getFile(filename);
    const url = URL.createObjectURL(file);

    this._objectUrls.set(filename, url);
    return url;
  }

  /**
   * Get the base URL for loading a dataset's files
   * For local user directories, this returns a special protocol identifier
   * that the data loaders need to handle specially.
   * @param {string} datasetId - Exact adopted dataset identifier
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId
    ) {
      throw new DataSourceError(
        `Dataset '${String(datasetId)}' not found. Current dataset is ` +
        `'${this.datasetId}'.`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { requestedId: datasetId, currentId: this.datasetId }
      );
    }
    // In h5ad mode, use h5ad:// protocol
    if (this._sourceMode === 'h5ad' && this._h5adSource) {
      return this._h5adSource.getBaseUrl(this.datasetId);
    }
    // In zarr mode, use zarr:// protocol
    if (this._sourceMode === 'zarr' && this._zarrSource) {
      return this._zarrSource.getBaseUrl(this.datasetId);
    }
    // Keep the application dataset identity in an encoded path segment. It
    // cannot be a URL host because exact local identities contain colons.
    return (
      `local-user://dataset/${encodeURIComponent(this.datasetId)}/`
    );
  }

  /**
   * Resolve a local-user:// URL to a fetchable blob URL
   * @param {string} url - local-user:// URL
   * @param {AbortSignal|null} signal - Exact request owner
   * @returns {Promise<string>} Blob URL for fetching
   */
  async resolveUrl(url, signal) {
    validateAbortSignalOrNull(signal, 'Local-user URL resolution signal');
    throwIfMetadataAborted(signal, 'Local-user URL resolution');
    if (!isLocalUserUrl(url)) {
      throw new DataSourceError(
        `Not a local-user URL: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const parsed = parsePreparedLocalUrl(url);
    if (!parsed) {
      throw new DataSourceError(
        `Invalid local-user URL format: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    if (parsed.datasetId !== this.datasetId) {
      throw new DataSourceError(
        `Local dataset URL belongs to "${parsed.datasetId}", but the ` +
        `currently adopted dataset is "${this.datasetId}".`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedDatasetId: parsed.datasetId,
          currentDatasetId: this.datasetId,
        }
      );
    }

    const resolvedUrl = await this.getFileUrl(parsed.filename, signal);
    throwIfMetadataAborted(signal, 'Local-user URL resolution');
    return resolvedUrl;
  }

  /**
   * Cleanup resources
   * @private
   */
  _cleanup() {
    // Revoke object URLs
    for (const url of this._objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._objectUrls.clear();
    this._preparedLazyValidationPlans.clear();
    this._preparedLazyValidationPromises.clear();

    // Clean up h5ad source if present
    if (this._h5adSource) {
      this._h5adSource.clear();
      this._h5adSource = null;
    }

    // Clean up zarr source if present
    if (this._zarrSource) {
      this._zarrSource.clear();
      this._zarrSource = null;
    }

    this._files.clear();
    this.datasetId = null;
    this.directoryPath = null;
    this._metadata = null;
    this._identityId = null;
    this._sourceMode = null;
  }

  /**
   * Check if data is loaded from h5ad file
   * @returns {boolean}
   */
  isH5adMode() {
    return this._sourceMode === 'h5ad';
  }

  /**
   * Get the h5ad data source (if in h5ad mode)
   * @returns {H5adDataSource|null}
   */
  getH5adSource() {
    return this._h5adSource;
  }

  /**
   * Check if data is loaded from zarr directory
   * @returns {boolean}
   */
  isZarrMode() {
    return this._sourceMode === 'zarr';
  }

  /**
   * Get the zarr data source (if in zarr mode)
   * @returns {ZarrDataSource|null}
   */
  getZarrSource() {
    return this._zarrSource;
  }

  /**
   * Clear the current directory selection
   */
  clear() {
    // Explicit clearing also supersedes any candidate still loading.
    this._beginSelection();
    this._cleanup();
    this._adoptionEpoch += 1;
  }

  /**
   * Retire a displaced registered local source through the same lifecycle
   * method used by connected transports.
   */
  disconnect() {
    this.clear();
  }

  /**
   * Called when this source is deactivated (switching to another source).
   * Revokes Object URLs and clears h5ad/zarr caches to prevent memory leaks.
   */
  onDeactivate() {
    // Only revoke Object URLs, keep the files in case user switches back
    for (const url of this._objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._objectUrls.clear();

    // MEMORY OPTIMIZATION: Clear h5ad caches when deactivating to free memory
    // The h5ad file itself is retained, but computed caches (gene expressions, etc.) are freed
    if (this._h5adSource) {
      this._h5adSource.clearCaches?.();
    }

    // MEMORY OPTIMIZATION: Clear zarr caches when deactivating to free memory
    if (this._zarrSource) {
      this._zarrSource.clearCaches?.();
    }

    console.log('[LocalUserDirDataSource] Deactivated - revoked Object URLs and cleared caches');
  }

  /**
   * Refresh (re-validate and reload metadata)
   */
  async refresh() {
    // In h5ad mode, metadata is immutable (from h5ad file)
    // No refresh needed - reload would require re-reading the file
    if (this._sourceMode === 'h5ad') {
      console.log('[LocalUserDirDataSource] Refresh not applicable for h5ad mode');
      return;
    }
    // In zarr mode, metadata is immutable (from zarr directory)
    // No refresh needed - reload would require re-reading the files
    if (this._sourceMode === 'zarr') {
      console.log('[LocalUserDirDataSource] Refresh not applicable for zarr mode');
      return;
    }
    // In directory mode, re-validate and reload metadata
    if (this._files.size > 0) {
      await this._validateAndLoadMetadata();
    }
  }

  /**
   * Whether this source requires manual reconnection.
   * Local user directories cannot be auto-restored due to browser security restrictions.
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }
}

/**
 * Create a LocalUserDirDataSource instance
 * @returns {LocalUserDirDataSource}
 */
export function createLocalUserDirDataSource() {
  return new LocalUserDirDataSource();
}
