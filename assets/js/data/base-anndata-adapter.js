/**
 * Base AnnData Adapter for Cellucid
 *
 * The base class of the AnnData file source's adapter (`AnnDataFileAdapter`,
 * `anndata-file-source.js`), whatever format the dataset arrived in.
 * Contains common logic for:
 * - Resolving which `obsm` embedding each dimension shows, and the
 *   data-mapping candidate catalog (`data-mapping-candidates.js`)
 * - Embedding and vector-field payloads (checked and normalized in the
 *   reader worker), cached by embedding id and route
 * - The obs field list and the gene lists the data loaders check
 * - Obs field data processing
 * - Connectivity edge extraction
 *
 * The loader (an `AnnDataReaderClient`, which runs the AnnData reader of
 * `anndata/reader.js` in its worker) provides `getDatasetMetadata()`, whose
 * `probes` describe the file from metadata alone, `readEmbedding(key,
 * columns, normalize)` and `readVectorField(key, columns, embedding,
 * normalize)`, which answer display coordinates and vectors made from the
 * selected columns of dense `obsm` arrays (`embedding-payload.js`).
 * Subclasses may override `_computeObsFieldsMetadata()`.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
  validateDatasetIdentity,
} from './data-source.js';
import {
  DIMENSION_SLOTS,
  canonicalEmbeddingId,
  compareCodePoints,
  defaultColumns,
  defaultEmbeddingSlots,
  describeObsmEntry,
  dimensionSlot,
  isBooleanVarDtype,
  makeUniqueNames,
  nothingPlottableMessage,
  obsmEntryDefect,
  slotDimension,
  validateEmbeddingColumns,
  vectorFieldKeys,
} from './data-mapping.js';
import {
  EmbeddingLoadError,
  MappingLoadError,
  assembleAnnDataCandidates,
  axisGeneCount,
  axisScope,
  axisVarColumns,
  expressionAxisRoute,
  geneNamesRoute,
  geneNamesVarAxis,
  modalityNames,
  modalityScope,
  parseAxisRoute,
  parseMappingGenesPath,
  describeAnnDataProbes,
  obsmEntries,
  obsmWidth,
  mappingEmbeddingPath,
  mappingLatentOutlierPath,
  parseMappingEmbeddingPath,
  parseMappingLatentPath,
  parseMappingVectorPath,
  resolveVectorBinding,
  LATENT_OUTLIER_MIN_POINTS,
  latentCandidateReason,
  resolveCandidateRef,
  DEFAULT_KNN_KEY,
  obsmIndexOf,
  requireObspKey,
  openingSlot,
  resolveEmbeddingSlotsAsync,
} from './data-mapping-candidates.js';
import { validateConnectivitySummary } from './connectivity-summary-contract.js';
import { requireCellucidFileMetadata } from './anndata-cellucid-metadata.js';
import { inferGeneNameColumn } from './gene-names.js';
import { OutlierQuantileSource } from './outlier-quantile-source.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
  waitForMetadata,
} from './metadata-load-contract.js';
import {
  categoricalStorageForCount,
  categoricalStorageForDtype,
  isCategoricalCodes,
  requireCategoricalCategoryCount,
} from './categorical-storage-contract.js';

import { residencyBudgetBytes } from './memory-budget.js';
import { scanpyCategoryPalette } from './palettes.js';
import { onAbort } from '../formats/io/abort.js';
import { getReadActivityLog } from './read-activity-log.js';
import { formatCountOf, countNoun } from '../utils/format-units.js';
import { copyLargeArray } from '../utils/large-arrays.js';
import { allocateTypedArray, copyTypedArray } from './sparse-column-index.js';

/** Each shared gene read's key, for a job that joins it to adopt it (`getGeneValues`). */
let nextGeneReadKey = 1;

const CONNECTIVITY_EDGE_LABEL = 'Direct AnnData connectivity edge loading';
/** Bytes a JavaScript array slot takes, for an obs field held as an Array. */
const JS_ARRAY_ELEMENT_BYTES = 8n;

/**
 * The refusal of one neighbour graph that fails its load-time check, in the
 * words `cellucid serve` uses for the same graph.
 *
 * @param {string} key
 * @param {unknown} error
 * @returns {MappingLoadError}
 */
function connectivityRefusal(key, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/symmetric/i.test(message)) {
    const reason = 'not symmetric — choose a connectivities matrix';
    return new MappingLoadError(key, reason, `obsp['${key}'] is ${reason}.`);
  }
  const reason = message.replace(/\.\s*$/, '');
  return new MappingLoadError(key, reason, `obsp['${key}']: ${reason}.`);
}

function validateCellucidCategoryCount(nCategories, fieldKey) {
  return requireCategoricalCategoryCount(
    nCategories,
    `Categorical observation field "${fieldKey}"`
  );
}

function validateCellucidCategories(categories, fieldKey) {
  if (!Array.isArray(categories)) {
    throw new Error(
      `Categorical observation field "${fieldKey}" is missing its category labels`
    );
  }
  const nCategories = categories.length;
  validateCellucidCategoryCount(nCategories, fieldKey);

  const seen = new Set();
  for (const category of categories) {
    const type = typeof category;
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'boolean'
    ) {
      throw new Error(
        `Categorical observation field "${fieldKey}" has an unsupported category label type`
      );
    }
    if (type === 'number' && !Number.isFinite(category)) {
      throw new Error(
        `Categorical observation field "${fieldKey}" has a non-finite numeric category label`
      );
    }
    if (seen.has(category)) {
      throw new Error(
        `Categorical observation field "${fieldKey}" has a duplicate category label`
      );
    }
    seen.add(category);
  }
  return nCategories;
}

function comparePrimitiveCategories(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== rightType) {
    const leftOrder =
      leftType === 'boolean' ? 0 : (leftType === 'number' ? 1 : 2);
    const rightOrder =
      rightType === 'boolean' ? 0 : (rightType === 'number' ? 1 : 2);
    return leftOrder - rightOrder;
  }
  if (leftType === 'boolean') {
    return Number(left) - Number(right);
  }
  if (leftType === 'number') {
    return left - right;
  }
  return left < right ? -1 : (left > right ? 1 : 0);
}

function getCellucidCategoryStorage(categories, fieldKey) {
  return categoricalStorageForCount(
    validateCellucidCategories(categories, fieldKey),
    `Categorical observation field "${fieldKey}"`
  );
}

/**
 * One cancellation owner shared by the callers of a coalesced computation.
 *
 * Coalesced callers run a single computation, so no individual caller may
 * cancel it. The shared work observes a child signal that is aborted only once
 * every caller that joined it has cancelled: one caller walking away can never
 * strand another, and a request nobody is waiting for can never keep running.
 */
class CoalescedCancellationOwner {
  constructor() {
    this._controller = new AbortController();
    this._abandoned = 0;
    this._joined = 0;
    this._uncancellable = 0;
  }

  /** @returns {boolean} */
  get cancelled() {
    return this._controller.signal.aborted;
  }

  /** @returns {AbortSignal} */
  get signal() {
    return this._controller.signal;
  }

  /**
   * Attach one caller to the shared work.
   *
   * @param {AbortSignal|null} callerSignal - Exact owner signal or no owner
   * @returns {() => void} Detach the caller once its result has settled
   */
  join(callerSignal) {
    this._joined++;
    if (callerSignal === null) {
      // A caller without an owner signal can never abandon the work, so the
      // shared computation stays uncancellable while it is attached.
      this._uncancellable++;
      return () => {};
    }

    let counted = false;
    const abandon = () => {
      if (counted) return;
      counted = true;
      this._abandoned++;
      if (
        this._uncancellable === 0 &&
        this._abandoned >= this._joined
      ) {
        this._controller.abort();
      }
    };
    const stopWaiting = onAbort(callerSignal, abandon);
    if (callerSignal.aborted) abandon();
    return stopWaiting;
  }
}

/** The launch defaults an AnnData dataset may be opened with. */
const LAUNCH_DEFAULT_KEYS = Object.freeze([
  'embedding1d',
  'embedding2d',
  'embedding3d',
  'knn',
  'modality',
  'expression',
  'geneIdColumn',
  'latentKey',
  'vectorFieldDefault',
  'obsKeys',
  'normalizeEmbeddings',
  'centroidMinPoints',
]);

function describeLaunchValue(value) {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value) ?? String(value);
}

function formatKeyList(keys) {
  return `[${keys.map(key => `'${key}'`).join(', ')}]`;
}

function requireLaunchKeyOrNull(value, name, what) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`defaults.${name} must be null or one non-empty ${what}; got ${describeLaunchValue(value)}.`);
  }
  return value;
}

/**
 * Check the launch defaults one AnnData dataset is opened with -- the
 * choices `cellucid serve`, `serve_anndata` and `show_anndata` take on the
 * command line or in Python -- before anything is read. Every key is
 * optional, and a key that is absent keeps the automatic choice:
 *
 * - `embedding1d`, `embedding2d`, `embedding3d`: the `obsm` key shown in that
 *   dimension slot (its first columns), or `{key, columns}` naming the
 *   0-based columns (null columns: the first ones); null keeps the automatic
 *   choice (`embedding_keys`).
 * - `knn`: the `obsp` matrix shown as the neighbour graph; null shows none
 *   (`knn_key`).
 * - `modality`: for a dataset of several modalities, the one gene names and
 *   expression are read from; null keeps the automatic choice.
 * - `expression`: the matrix genes are read from, `'X'`, `'raw/X'` or
 *   `'layers/<name>'` (of the modality, for a multimodal dataset); null
 *   keeps the automatic choice (`expression_source`).
 * - `geneIdColumn`: the column of the expression matrix's var axis whose
 *   values name the genes; null names them by the index (`gene_id_column`).
 * - `latentKey`: the `obsm` array outlier quantiles are computed in; null
 *   computes none (`latent_key`).
 * - `vectorFieldDefault`: the vector field id selected when several are
 *   bound (`vector_field_default`).
 * - `obsKeys`: the obs columns shown, in this order; null shows every one
 *   (`obs_keys`).
 * - `normalizeEmbeddings`: false shows embeddings at their own coordinates
 *   (`normalize_embeddings`, default true).
 * - `centroidMinPoints`: the fewest cells a category needs to get latent
 *   outlier quantiles (`centroid_min_points`, default
 *   `LATENT_OUTLIER_MIN_POINTS`).
 *
 * @param {unknown} value
 * @returns {Readonly<Object>} The defaults given, checked
 */
export function requireAnnDataLaunchDefaults(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('AnnData launch defaults must be an object.');
  }
  const unknown = Object.keys(value).filter(key => !LAUNCH_DEFAULT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new RangeError(
      `Unknown AnnData launch ${countNoun(unknown.length, 'default')} ${formatKeyList(unknown)}; ` +
      `the defaults are ${formatKeyList(LAUNCH_DEFAULT_KEYS)}.`
    );
  }
  const checked = {};
  for (const slot of DIMENSION_SLOTS) {
    const name = `embedding${slot}`;
    if (!Object.hasOwn(value, name)) continue;
    const spec = value[name];
    if (spec === null) continue;
    if (typeof spec === 'string' && spec.length > 0) {
      checked[name] = Object.freeze({ key: spec, columns: null });
    } else if (
      spec !== null && typeof spec === 'object' && !Array.isArray(spec) &&
      Object.keys(spec).sort().join(',') === 'columns,key' &&
      typeof spec.key === 'string' && spec.key.length > 0 &&
      (spec.columns === null || Array.isArray(spec.columns))
    ) {
      checked[name] = Object.freeze({
        key: spec.key,
        columns: spec.columns === null ? null : Object.freeze([...spec.columns]),
      });
    } else {
      throw new TypeError(
        `defaults.${name} must be null, an obsm key, or {key, columns}; got ${describeLaunchValue(spec)}.`
      );
    }
  }
  if (Object.hasOwn(value, 'knn')) checked.knn = requireLaunchKeyOrNull(value.knn, 'knn', 'obsp key');
  if (Object.hasOwn(value, 'modality') && value.modality !== null) {
    checked.modality = requireLaunchKeyOrNull(value.modality, 'modality', 'modality name');
  }
  if (Object.hasOwn(value, 'expression') && value.expression !== null) {
    const expression = value.expression;
    if (
      typeof expression !== 'string' ||
      !(expression === 'X' || expression === 'raw/X' ||
        (expression.startsWith('layers/') && expression.length > 'layers/'.length && !expression.slice('layers/'.length).includes('/')))
    ) {
      throw new RangeError(
        `defaults.expression must be 'X', 'raw/X', 'layers/<name>' or null; got ${describeLaunchValue(expression)}.`
      );
    }
    checked.expression = expression;
  }
  if (Object.hasOwn(value, 'geneIdColumn')) {
    checked.geneIdColumn = requireLaunchKeyOrNull(value.geneIdColumn, 'geneIdColumn', 'var column name');
  }
  if (Object.hasOwn(value, 'latentKey')) {
    checked.latentKey = requireLaunchKeyOrNull(value.latentKey, 'latentKey', 'obsm key');
  }
  if (Object.hasOwn(value, 'vectorFieldDefault')) {
    checked.vectorFieldDefault = requireLaunchKeyOrNull(value.vectorFieldDefault, 'vectorFieldDefault', 'vector field id');
  }
  if (Object.hasOwn(value, 'obsKeys') && value.obsKeys !== null) {
    const keys = value.obsKeys;
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || key.length === 0)) {
      throw new TypeError('defaults.obsKeys must be null or a list of obs column names.');
    }
    if (keys.length === 0) throw new RangeError('defaults.obsKeys must name at least one obs column.');
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
    if (repeated.length > 0) throw new RangeError(`defaults.obsKeys repeats ${formatKeyList([...new Set(repeated)])}.`);
    checked.obsKeys = Object.freeze([...keys]);
  }
  if (Object.hasOwn(value, 'normalizeEmbeddings')) {
    if (typeof value.normalizeEmbeddings !== 'boolean') {
      throw new TypeError('defaults.normalizeEmbeddings must be true or false.');
    }
    checked.normalizeEmbeddings = value.normalizeEmbeddings;
  }
  if (Object.hasOwn(value, 'centroidMinPoints')) {
    const minPoints = value.centroidMinPoints;
    if (!Number.isSafeInteger(minPoints) || minPoints < 1) {
      throw new RangeError('defaults.centroidMinPoints must be a positive integer.');
    }
    checked.centroidMinPoints = minPoints;
  }
  return Object.freeze(checked);
}

/**
 * The gene-name guesses of one opened store, by var axis (`X`, `raw`,
 * `mod/<name>`, `mod/<name>/raw`; `inferGeneNameColumn`): the var column
 * that names an axis's genes by symbol, or null for its index. An axis is
 * guessed once, when its genes are first listed -- the shown axis's right
 * after the first view, any other when it is first chosen -- never by the
 * first view. A reading of the same store with other cells
 * (`AnnDataFileSource.reopenCells`) keeps them: a var axis does not depend
 * on which cells are open.
 */
export class GeneNameGuesses {
  constructor() {
    /** @type {Map<string, string|null>} */
    this._settled = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    this._inFlight = new Map();
  }

  /** How many axes are guessed. */
  get size() {
    return this._settled.size;
  }

  /**
   * The settled guesses, by var axis.
   * @returns {Record<string, string|null>}
   */
  settled() {
    return Object.fromEntries(this._settled);
  }

  /**
   * The guess of one axis: settled, joined while under way, else started by
   * `run`. A guess that fails (its index cannot be read) is not kept: the
   * next ask tries again.
   *
   * @param {string} axis
   * @param {() => Promise<string|null>} run
   * @returns {Promise<string|null>}
   */
  guess(axis, run) {
    if (this._settled.has(axis)) return Promise.resolve(this._settled.get(axis));
    let pending = this._inFlight.get(axis);
    if (pending === undefined) {
      pending = Promise.resolve().then(run).then(
        column => {
          this._settled.set(axis, column);
          this._inFlight.delete(axis);
          return column;
        },
        error => {
          this._inFlight.delete(axis);
          throw error;
        }
      );
      this._inFlight.set(axis, pending);
    }
    return pending;
  }
}

/**
 * Base adapter class for AnnData file formats
 * @abstract
 */
export class BaseAnnDataAdapter {
  /**
   * @param {Object} loader - The AnnData reader's API: an `AnnDataReaderClient`
   *   in the app, the reader of `anndata/reader.js` itself in tests
   * @param {Object} [options]
   * @param {number} [options.cacheBudgetBytes] - Residency budget of the coordinate and obs caches
   * @param {Object} [options.defaults] - Launch defaults (`requireAnnDataLaunchDefaults`)
   * @param {GeneNameGuesses} [options.geneNameGuesses] - The guesses of an
   *   earlier reading of the same store, kept (`AnnDataFileSource.reopenCells`)
   */
  constructor(loader, options = {}) {
    /** @protected */
    this._loader = loader;

    /**
     * The gene-name guess of each var axis, made when its genes are first
     * listed (`guessGeneNames`).
     * @type {GeneNameGuesses}
     */
    this._geneNameGuesses = options.geneNameGuesses ?? new GeneNameGuesses();
    if (!(this._geneNameGuesses instanceof GeneNameGuesses)) {
      throw new TypeError('AnnData adapter gene-name guesses must be a GeneNameGuesses.');
    }

    /**
     * What `initialize()` described and resolved, kept to assemble the
     * catalog again as gene-name guesses settle.
     * @type {{described: Object, resolution: Object}|null}
     */
    this._catalogInputs = null;

    /** @type {number} How many guesses the catalog was assembled with */
    this._candidatesGuessCount = 0;

    /**
     * The launch defaults the caller named (a server's): they override the
     * file's own (`uns['cellucid']['defaults']`).
     * @type {Readonly<Object>}
     */
    this._explicitDefaults = requireAnnDataLaunchDefaults(options.defaults ?? {});

    /**
     * The launch defaults this dataset opens with, once `initialize()` has
     * read the file's own: the file's, then the caller's over them. An absent
     * key keeps the automatic choice.
     * @type {Readonly<Object>}
     */
    this._defaults = this._explicitDefaults;

    /**
     * What the file says about itself (`uns['cellucid']`), checked; set by
     * `initialize()`.
     * @type {Readonly<import('./anndata-cellucid-metadata.js').CellucidFileMetadata>|null}
     */
    this._fileMetadata = null;

    /** @type {Object|null} */
    this._metadata = null;

    /**
     * The embedding each dimension slot shows, as `{key, columns}` per slot
     * (null when unused): the default rule, else the best guess.
     * @type {Readonly<Object>|null}
     */
    this._slots = null;

    /** @type {Object|null} The frozen data-mapping candidate catalog */
    this._candidates = null;

    /**
     * The described `obsm` entries, set before the catalog is assembled so the
     * best guess can load its candidates.
     * @type {ReadonlyArray<Object>|null}
     */
    this._describedObsm = null;

    /**
     * Vector fields: field id -> (bound embedding id -> obsm vector key).
     * @type {Map<string, Map<string, string>>}
     */
    this._vectorBindings = new Map();

    /** @type {boolean} */
    this._directIdentityFinalized = false;

    /** @type {Map<string, Float32Array>} Normalized embeddings per embedding id */
    this._embeddingCache = new Map();

    /** @type {Map<string, Float32Array>} Scaled vector payloads by mapping route */
    this._vectorFieldCache = new Map();

    /**
     * One LRU/byte owner shared by normalized embeddings and vector fields.
     * Buffer reference counts make aliased typed-array views exact.
     */
    this._coordinateCacheLru = new Map();
    this._coordinateBufferRefs = new Map();
    this._coordinateCacheBytes = 0n;
    this._coordinateCachePins = new Map();

    /** @type {Array|null} Obs field metadata (kind, categories, etc.) */
    this._obsFieldsMetadata = null;

    /** @type {Map<string, Object>} Lazy-loaded obs field data */
    this._obsFieldDataCache = new Map();

    /** @type {bigint} Retained bytes owned by the lazy obs field cache */
    this._obsFieldDataCacheBytes = 0n;

    /**
     * The extracted neighbour graph asked for last, by obsp key (null for an
     * absent key).
     * @type {Map<string, Object|null>}
     */
    this._connectivityCache = new Map();

    /** @type {Readonly<Object>|undefined|null} The finalized summary of the graph the file opens with */
    this._connectivitySummary = undefined;

    /**
     * The display transform and bounds of every embedding read, by
     * embedding id (`EmbeddingPayload`, `embedding-payload.js`).
     * @type {Map<string, {transform: Object, bounds: Object|null}>}
     */
    this._embeddingInfo = new Map();

    /** @type {Map<string, number>} The largest vector of each cached vector field, by route */
    this._vectorMagnitudes = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._embeddingInFlight = new Map();

    /** @type {Map<string, Promise<Object>>} */
    this._obsFieldDataInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._vectorFieldInFlight = new Map();

    /** @type {Map<string, Promise<Object|null>>} */
    this._connectivityInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} */
    this._geneExpressionInFlight = new Map();

    /** @type {Map<string, Promise<Float32Array>>} Outlier quantiles by route. */
    this._latentOutlierInFlight = new Map();

    /**
     * Where outlier quantiles come from (stored in the file or computed);
     * set by `initialize()`.
     * @type {OutlierQuantileSource|null}
     */
    this._outliers = null;

    /**
     * Unique gene names by var axis and name source, read once.
     * @type {Map<string, Readonly<Object>>}
     */
    this._geneNamesByRoute = new Map();

    /** @type {number} Invalidates results from asynchronous work after cache lifecycle changes */
    this._lifecycleGeneration = 0;

    /** @type {boolean} Closed adapters cannot start or publish new work */
    this._closed = false;

    // A residency budget: it decides what the caches keep, never what loads.
    const cacheBudgetBytes =
      options.cacheBudgetBytes ?? residencyBudgetBytes('adapterCache');
    if (
      !Number.isSafeInteger(cacheBudgetBytes) ||
      cacheBudgetBytes < 0
    ) {
      throw new TypeError(
        'AnnData adapter cache budget must be a non-negative safe integer.'
      );
    }
    this._cacheBudgetBytes = BigInt(cacheBudgetBytes);
  }

  /**
   * Capture the active adapter generation before starting asynchronous work.
   * @returns {number}
   * @private
   */
  _captureLifecycleGeneration() {
    if (this._closed) {
      throw new Error(
        'AnnData adapter is closed; reopen the dataset before requesting data'
      );
    }
    return this._lifecycleGeneration;
  }

  /**
   * Reject work that completed after its adapter was cleared or closed.
   * @param {number} generation
   * @private
   */
  _assertLifecycleGeneration(generation) {
    if (this._closed || generation !== this._lifecycleGeneration) {
      throw new Error(
        'AnnData adapter dataset changed, was cleared, or was closed while loading; start a new request against the active dataset'
      );
    }
  }

  /**
   * Share one cold computation per public key while preserving lifecycle
   * invalidation and independent later-caller ownership.
   *
   * Settlement cleanup is identity-checked because clearCaches() detaches the
   * stale registry immediately. A later caller may install a new promise for
   * the same key before the earlier promise settles.
   *
   * The operation receives the shared cancellation signal of its callers so a
   * cancelled request stops its work instead of only stopping its wait. A
   * cancelled entry is never joined by a later caller: that caller starts a
   * fresh computation, so cancelling one request can never poison the next.
   *
   * @param {Map<any, {cancellation: CoalescedCancellationOwner, promise: Promise<any>}>} registry
   * @param {any} key
   * @param {number} generation
   * @param {(workSignal: AbortSignal) => Promise<any>|any} operation
   * @param {AbortSignal|null} [callerSignal] - Exact owner signal or no owner
   * @returns {Promise<any>}
   * @private
   */
  _coalesceInFlight(
    registry,
    key,
    generation,
    operation,
    callerSignal = null
  ) {
    const existing = registry.get(key);
    let entry = existing;
    if (!entry || entry.cancellation.cancelled) {
      const cancellation = new CoalescedCancellationOwner();
      const pending = Promise.resolve().then(() => {
        this._assertLifecycleGeneration(generation);
        return operation(cancellation.signal);
      });
      entry = { cancellation, promise: pending };
      registry.set(key, entry);

      const removeSettled = () => {
        if (registry.get(key) === entry) {
          registry.delete(key);
        }
      };
      pending.then(removeSettled, removeSettled);
    }

    const release = entry.cancellation.join(callerSignal);
    const settled = entry.promise.then(
      result => {
        release();
        return result;
      },
      error => {
        release();
        throw error;
      }
    );
    if (callerSignal === null) return settled;
    // The caller's own wait ends as soon as its signal aborts; the shared
    // work ends once no caller waits for it.
    return new Promise((resolve, reject) => {
      const abort = () => {
        settled.catch(() => {});
        reject(callerSignal.reason ?? new DOMException('The read was cancelled.', 'AbortError'));
      };
      if (callerSignal.aborted) {
        abort();
        return;
      }
      const stopWaiting = onAbort(callerSignal, abort);
      settled.then(
        result => {
          stopWaiting();
          resolve(result);
        },
        error => {
          stopWaiting();
          reject(error);
        }
      );
    });
  }

  /**
   * @param {string} embeddingId
   * @returns {string}
   * @private
   */
  _embeddingCoordinateCacheKey(embeddingId) {
    return JSON.stringify(['embedding', embeddingId]);
  }

  /**
   * @param {string} vectorPath - A mapping vector route.
   * @returns {string}
   * @private
   */
  _vectorCoordinateCacheKey(vectorPath) {
    return JSON.stringify(['vector', vectorPath]);
  }

  /**
   * Keep an exact cache entry from being evicted while a public request is
   * constructing or returning it. The captured state identity makes releases
   * from an invalidated generation harmless after clearCaches().
   *
   * @param {string} cacheKey
   * @returns {() => void}
   * @private
   */
  _pinCoordinateCacheKey(cacheKey) {
    let pinState = this._coordinateCachePins.get(cacheKey);
    if (!pinState) {
      pinState = new Set();
      this._coordinateCachePins.set(cacheKey, pinState);
    }
    const token = {};
    pinState.add(token);

    return () => {
      if (this._coordinateCachePins.get(cacheKey) !== pinState) {
        return;
      }
      pinState.delete(token);
      if (pinState.size === 0) {
        this._coordinateCachePins.delete(cacheKey);
      }
    };
  }

  /**
   * @param {string} cacheKey
   * @returns {boolean}
   * @private
   */
  _isCoordinateCacheKeyPinned(cacheKey) {
    return (this._coordinateCachePins.get(cacheKey)?.size || 0) > 0;
  }

  /**
   * @param {Float32Array|ArrayBufferView} value
   * @returns {{ identity: Object, bytes: bigint }}
   * @private
   */
  _describeCoordinateBuffer(value) {
    if (!value || typeof value !== 'object') {
      throw new Error('Coordinate cache result is not a typed buffer.');
    }
    const backingBuffer = value.buffer;
    const identity = (
      backingBuffer &&
      typeof backingBuffer === 'object'
    ) ? backingBuffer : value;
    const byteLength = Number(
      identity === backingBuffer
        ? backingBuffer.byteLength
        : value.byteLength
    );
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(
        'Coordinate cache result has an invalid retained byte length.'
      );
    }
    return { identity, bytes: BigInt(byteLength) };
  }

  /**
   * @param {string} cacheKey
   * @param {Float32Array} [expected]
   * @returns {boolean}
   * @private
   */
  _deleteCoordinateCacheEntry(cacheKey, expected = undefined) {
    const entry = this._coordinateCacheLru.get(cacheKey);
    if (!entry || (expected !== undefined && entry.value !== expected)) {
      return false;
    }
    this._coordinateCacheLru.delete(cacheKey);

    if (entry.kind === 'embedding') {
      if (this._embeddingCache.get(entry.embeddingId) === entry.value) {
        this._embeddingCache.delete(entry.embeddingId);
      }
    } else if (this._vectorFieldCache.get(entry.vectorPath) === entry.value) {
      this._vectorFieldCache.delete(entry.vectorPath);
    }

    const bufferRef =
      this._coordinateBufferRefs.get(entry.bufferIdentity);
    if (bufferRef) {
      bufferRef.references--;
      if (bufferRef.references <= 0) {
        this._coordinateBufferRefs.delete(entry.bufferIdentity);
        this._coordinateCacheBytes -= bufferRef.bytes;
        if (this._coordinateCacheBytes < 0n) {
          this._coordinateCacheBytes = 0n;
        }
      }
    }
    return true;
  }

  /**
   * Refresh one exact entry in the cross-kind LRU.
   *
   * @param {string} cacheKey
   * @param {Float32Array} value
   * @private
   */
  _touchCoordinateCacheEntry(cacheKey, value) {
    const entry = this._coordinateCacheLru.get(cacheKey);
    if (!entry || entry.value !== value) return;
    this._coordinateCacheLru.delete(cacheKey);
    this._coordinateCacheLru.set(cacheKey, entry);
  }

  /**
   * Evict unpinned LRU entries until the requested distinct bytes fit.
   *
   * @param {bigint} additionalBytes
   * @private
   */
  _makeCoordinateCacheRoom(additionalBytes) {
    // The budget decides what is evicted, never what loads: coordinates in
    // use stay pinned, and an entry larger than the budget is still admitted.
    while (
      this._coordinateCacheBytes + additionalBytes >
      this._cacheBudgetBytes
    ) {
      let victimKey = null;
      for (const cacheKey of this._coordinateCacheLru.keys()) {
        if (!this._isCoordinateCacheKeyPinned(cacheKey)) {
          victimKey = cacheKey;
          break;
        }
      }
      if (victimKey == null) return;
      this._deleteCoordinateCacheEntry(victimKey);
    }
  }

  /**
   * Publish one result into its public cache and the shared byte/LRU owner.
   *
   * @param {Object} options
   * @param {string} options.cacheKey
   * @param {'embedding'|'vector'} options.kind
   * @param {string} options.embeddingId
   * @param {string} [options.vectorPath]
   * @param {Float32Array} options.value
   * @param {string} options.label
   * @private
   */
  _retainCoordinateCacheEntry({
    cacheKey,
    kind,
    embeddingId,
    vectorPath = null,
    value,
    label
  }) {
    const descriptor = this._describeCoordinateBuffer(value);
    const existingRef =
      this._coordinateBufferRefs.get(descriptor.identity);
    const additionalBytes = existingRef ? 0n : descriptor.bytes;
    this._makeCoordinateCacheRoom(additionalBytes);

    this._deleteCoordinateCacheEntry(cacheKey);
    if (kind === 'embedding') {
      this._embeddingCache.set(embeddingId, value);
    } else {
      this._vectorFieldCache.set(vectorPath, value);
    }

    const bufferRef =
      this._coordinateBufferRefs.get(descriptor.identity);
    if (bufferRef) {
      bufferRef.references++;
    } else {
      this._coordinateBufferRefs.set(descriptor.identity, {
        bytes: descriptor.bytes,
        references: 1
      });
      this._coordinateCacheBytes += descriptor.bytes;
    }
    this._coordinateCacheLru.set(cacheKey, {
      bufferIdentity: descriptor.identity,
      cacheKey,
      embeddingId,
      vectorPath,
      kind,
      value
    });
  }

  /**
   * Reset all coordinate-cache ownership after lifecycle invalidation.
   *
   * @private
   */
  _resetCoordinateCacheOwner() {
    this._coordinateCacheLru.clear();
    this._coordinateBufferRefs.clear();
    this._coordinateCachePins.clear();
    this._coordinateCacheBytes = 0n;
  }

  /**
   * Initialize the adapter and compute metadata.
   *
   * The loader describes the file from metadata alone. The adapter then
   * resolves which embedding each dimension shows -- the default rule, else
   * the best guess, whose candidates must pass the load-time check -- and
   * assembles the data-mapping candidate catalog the panel lists.
   *
   * @returns {Promise<void>}
   */
  /**
   * The title the file gives itself (`uns['title']`), or null.
   * @returns {string|null}
   */
  /**
   * The link this file is read over, as its reader last measured it
   * (`AnnDataReaderClient.linkMeasurement()`), or null.
   * @returns {Readonly<Object>|null}
   */
  linkMeasurement() {
    return this._loader?.linkMeasurement?.() ?? null;
  }

  getFileTitle() {
    const title = this._metadata?.title;
    return typeof title === 'string' && title.length > 0 ? title : null;
  }

  /**
   * What the file says about itself for Cellucid (`uns['cellucid']`): its
   * stable id, name, description, citation and source, each null when the
   * file does not state it. Available once `initialize()` has resolved.
   *
   * @returns {Readonly<import('./anndata-cellucid-metadata.js').CellucidFileMetadata>}
   */
  getFileMetadata() {
    if (this._fileMetadata === null) {
      throw new Error('AnnData file metadata is read by initialize()');
    }
    return this._fileMetadata;
  }

  /**
   * Read what the dataset is: its metadata, embeddings, fields and mapping
   * candidates, and the embedding the first view draws. `firstView: false`
   * leaves that embedding unread: an opening grown or cut in place
   * (`AnnDataFileSource.reopenCells`) keeps the coordinates on screen and
   * reads only the cells it adds.
   *
   * @param {{firstView?: boolean}} [options]
   */
  async initialize({ firstView: readFirstView = true } = {}) {
    const generation = this._captureLifecycleGeneration();
    try {
      const metadata = await this._loader.getDatasetMetadata();
      this._assertLifecycleGeneration(generation);
      const sourceType = this.constructor.sourceType ?? 'anndata';
      const fileMetadata = requireCellucidFileMetadata(metadata?.cellucid ?? null, sourceType);
      let fileDefaults;
      try {
        fileDefaults = requireAnnDataLaunchDefaults(fileMetadata.defaults);
      } catch (error) {
        throw explainedFailure(
          `uns['cellucid']['defaults'] cannot be used: ${error?.message ?? error} ` +
          'Write the file again with cellucid.prepare() in Python or cellucid_prepare() in R.',
          DataSourceErrorCode.INVALID_FORMAT,
          sourceType,
          { cause: error }
        );
      }
      this._fileMetadata = fileMetadata;
      this._defaults = Object.freeze({ ...fileDefaults, ...this._explicitDefaults });
      this._outliers?.close();
      this._outliers = new OutlierQuantileSource({
        loader: this._loader,
        stored: fileMetadata.outlierQuantiles,
        minPoints: this._defaults.centroidMinPoints ?? LATENT_OUTLIER_MIN_POINTS,
      });
      if (!Number.isSafeInteger(this._loader.nObs) || this._loader.nObs < 0) {
        throw new Error('AnnData loader cell count must be a non-negative safe integer');
      }
      // A file with no cells is the person's data, not a failed read: say so,
      // rather than leaving it to a generic cause ("check your connection").
      if (this._loader.nObs === 0) {
        throw explainedFailure(
          'This AnnData has no cells (n_obs is 0), so there is nothing to plot. ' +
          'Open a file that holds at least one cell.',
          DataSourceErrorCode.VALIDATION_ERROR,
          sourceType
        );
      }
      const described = describeAnnDataProbes(metadata?.probes);
      if (described.nObs !== this._loader.nObs) {
        throw new Error(
          'AnnData mapping probes must describe the loader cell axis exactly'
        );
      }
      this._metadata = metadata;
      this._describedObsm = described.obsm;
      // Gene names are not read here: the first view never waits for them.
      // The catalog states the guesses already made; the shown axis is
      // guessed when its genes are first listed (`guessGeneNames`).
      const resolution = await this._resolveEmbeddingSlots(described, generation);
      this._slots = Object.freeze({ ...resolution.slots });

      // The embedding the first view draws is read from here on, beside the
      // field lists: it is what the view waits for, and the largest read of
      // opening. Candidate sources are adopted only after initialize()
      // resolves, so its payload is validated before then: corrupt bytes
      // cannot replace and close a still-working dataset.
      const firstView = readFirstView ? this.getEmbeddingForRef(this._slots[openingSlot(this._slots)]) : Promise.resolve(null);
      firstView.catch(() => {});

      await this._computeObsFieldsMetadata(generation);
      this._assertLifecycleGeneration(generation);
      this._catalogInputs = { described, resolution };
      this._assembleGuessedCandidates();
      await this._computeVectorFieldsMetadata(generation);
      this._assertLifecycleGeneration(generation);
      await firstView;
      this._assertLifecycleGeneration(generation);
    } catch (error) {
      if (
        !this._closed &&
        generation === this._lifecycleGeneration
      ) {
        this._metadata = null;
        this._fileMetadata = null;
        this._defaults = this._explicitDefaults;
        this._slots = null;
        this._candidates = null;
        this._catalogInputs = null;
        this._describedObsm = null;
        this._vectorBindings.clear();
        this._obsFieldsMetadata = null;
        this.clearCaches();
      }
      throw error;
    }
  }

  /**
   * The candidate catalog, its defaults seeded by the launch defaults: the
   * neighbour graph, expression matrix, gene names and latent space a launch
   * named, each checked against the file, become the catalog's initial
   * choices, which the data-mapping panel can still change.
   *
   * @param {ReturnType<typeof describeAnnDataProbes>} described
   * @param {{slots: Object, guessed: string[], rejected: Array<[string, string]>}} resolution
   * @param {Record<string, string|null>} [geneNameColumns] - The settled gene-name guesses by var axis (`GeneNameGuesses`)
   * @returns {Object}
   * @private
   */
  _assembleCandidates(described, resolution, geneNameColumns = {}) {
    const launch = this._defaults;
    const chosen = {};
    if (Object.hasOwn(launch, 'knn')) {
      const key = launch.knn;
      if (key !== null) {
        const item = described.obsp.find(entry => entry.key === key);
        if (item === undefined) {
          throw new RangeError(
            `defaults.knn names obsp['${key}'], which this file does not have. ` +
            `obsp holds: ${formatKeyList(described.obsp.map(entry => entry.key))}.`
          );
        }
        if (!item.usable) throw new RangeError(`defaults.knn: obsp['${key}'] ${item.reason}.`);
      }
      chosen.knn = key;
    }
    if (Object.hasOwn(launch, 'modality')) {
      const names = modalityNames(described);
      if (names === null) {
        throw new RangeError(`defaults.modality names '${launch.modality}', and this file has one feature space.`);
      }
      if (!names.includes(launch.modality)) {
        throw new RangeError(
          `defaults.modality names '${launch.modality}', which this file does not have. ` +
          `Its modalities are ${formatKeyList(names)}.`
        );
      }
      chosen.modality = launch.modality;
    }
    // A multimodal file's expression defaults are its modality's.
    const scope = modalityScope(
      described,
      described.modalities === null ? null : (chosen.modality ?? described.defaultModality)
    ).scope;
    if (Object.hasOwn(launch, 'expression')) {
      const element = launch.expression;
      if (element === 'X') {
        if (scope.X === null) throw new RangeError("defaults.expression names X, which this file does not have.");
        chosen.expression = 'X';
      } else if (element === 'raw/X') {
        if (scope.raw === null || scope.raw.X === null) {
          throw new RangeError("defaults.expression names raw.X, which this file does not have.");
        }
        chosen.expression = 'raw';
      } else {
        const name = element.slice('layers/'.length);
        const layer = scope.layers.find(entry => entry.key === name);
        if (layer === undefined) {
          throw new RangeError(
            `defaults.expression names layers['${name}'], which this file does not have. ` +
            `layers holds: ${formatKeyList(scope.layers.map(entry => entry.key))}.`
          );
        }
        if (!layer.usable) throw new RangeError(`defaults.expression: layers['${name}'] ${layer.reason}.`);
        chosen.expression = `layer:${name}`;
      }
    }
    if (Object.hasOwn(launch, 'latentKey')) {
      const key = launch.latentKey;
      if (key !== null) {
        const item = described.obsm.find(entry => entry.key === key);
        if (item === undefined) {
          throw new RangeError(`defaults.latentKey '${key}' was not found in obsm.`);
        }
        const reason = latentCandidateReason(item);
        if (reason !== null) throw new RangeError(`defaults.latentKey: obsm['${key}'] ${reason}.`);
      }
      chosen.latent = key;
    }
    let candidates = assembleAnnDataCandidates(described, resolution, chosen, geneNameColumns);
    if (Object.hasOwn(launch, 'geneIdColumn') && launch.geneIdColumn !== null) {
      const column = launch.geneIdColumn;
      const axisRoute = expressionAxisRoute(candidates, candidates.defaults.expression, candidates.defaults.modality ?? null);
      if (axisRoute === null) {
        throw new RangeError(`defaults.geneIdColumn '${column}' names genes, and this file has no expression matrix.`);
      }
      const columns = axisVarColumns(candidates, axisRoute);
      const entry = columns.find(item => item.key === column);
      const axis = parseAxisRoute(axisRoute).matrix === 'raw' ? 'raw.var' : 'var';
      if (entry === undefined) {
        throw new RangeError(
          `defaults.geneIdColumn '${column}' not found in ${axis}. ` +
          `Available columns: ${formatKeyList(columns.map(item => item.key))}.`
        );
      }
      if (!entry.usable) throw new RangeError(`defaults.geneIdColumn '${column}': ${entry.reason}.`);
      // The launch names the genes of the axis it opens on; every other
      // axis (raw, another modality) keeps its own default.
      const launchAxis = geneNamesVarAxis(candidates.defaults.modality ?? null, candidates.defaults.expression);
      candidates = assembleAnnDataCandidates(
        described,
        resolution,
        { ...chosen, geneNames: `column:${column}` },
        { ...geneNameColumns, [launchAxis]: column }
      );
    }
    return candidates;
  }

  /**
   * Assemble the catalog from what `initialize()` described, with every
   * gene-name guess settled so far.
   * @private
   */
  _assembleGuessedCandidates() {
    const { described, resolution } = this._catalogInputs;
    this._candidatesGuessCount = this._geneNameGuesses.size;
    this._candidates = this._assembleCandidates(described, resolution, this._geneNameGuesses.settled());
  }

  /**
   * The var axes of this file that an expression matrix is on (`X` and each
   * layer share `var`; `raw` has its own; each modality its own), with the
   * var columns that may name their genes.
   *
   * @returns {Map<string, ReadonlyArray<Object>>}
   * @private
   */
  _geneNameAxes() {
    const described = this._catalogInputs?.described ?? null;
    if (described === null) throw new Error('AnnData data-mapping candidates are not initialized');
    const scopes = described.modalities === null || described.modalities === undefined
      ? [{ modality: null, scope: described }]
      : described.modalities.map(scope => ({ modality: scope.name, scope }));
    const axes = new Map();
    for (const { modality, scope } of scopes) {
      if (scope.X !== null || scope.layers.some(layer => layer.usable)) {
        axes.set(geneNamesVarAxis(modality, 'X'), scope.var.columns);
      }
      if (scope.raw !== null && scope.raw.X !== null) {
        axes.set(geneNamesVarAxis(modality, 'raw'), scope.raw.var.columns);
      }
    }
    return axes;
  }

  /**
   * Guess the gene names of one var axis (`X`, `raw`, `mod/<name>`,
   * `mod/<name>/raw`; `geneNamesVarAxis`), once, and answer the catalog with
   * that guess in it: the var column of symbols when the axis's index holds
   * identifiers (`inferGeneNameColumn`), else its index. Only an index of
   * identifiers reads more: its text columns, lazily, the conventionally
   * named first, stopping at the first that holds symbols; a column that
   * cannot be read is passed over (choosing it in the data-mapping panel
   * says why). An index that cannot be read fails the guess, and the next
   * ask tries again.
   *
   * Nothing at opening asks: the shown axis is guessed when its genes are
   * first listed (`getGeneList`), after the first view, and any other axis
   * when the data-mapping panel first shows it.
   *
   * @param {string} axis
   * @returns {Promise<Object>} The candidate catalog
   */
  async guessGeneNames(axis) {
    const generation = this._captureLifecycleGeneration();
    const columns = this._geneNameAxes().get(axis);
    if (columns === undefined) {
      throw new RangeError(`This file has no expression matrix on the var axis '${axis}'.`);
    }
    await this._geneNameGuesses.guess(axis, async () => {
      const { index } = await this._loader.readVarNames(axis, null);
      // Integers (lengths, Entrez ids) are never symbols.
      const textual = columns
        .filter(column => column.usable && !/^(u?int|Int)\d*$/.test(column.dtype))
        .map(column => column.key);
      return inferGeneNameColumn(index, textual, key => this._loader.readVarNames(axis, key).then(
        read => read.values,
        () => null
      ));
    });
    this._assertLifecycleGeneration(generation);
    return this.getMappingCandidates();
  }

  /**
   * Settle the gene names the file's own gene routes (`var`, `var/{g}`)
   * read: the default expression matrix's axis is guessed first when it is
   * not yet, so those routes never name the genes by the index in place of
   * a pending guess.
   * @private
   */
  async _settleOwnGeneNames(path, generation) {
    if (parseMappingGenesPath(path) !== null) return;
    const defaults = this.getMappingCandidates().defaults;
    if (defaults.geneNames !== null || defaults.expression === null) return;
    await this.guessGeneNames(geneNamesVarAxis(defaults.modality ?? null, defaults.expression));
    this._assertLifecycleGeneration(generation);
  }

  /**
   * The dimension slots a launch named (`embedding1d` ...), checked against
   * the file's metadata: each must exist and be a usable dense array wide
   * enough. Nothing is read here: the slot the first view shows is read (and
   * its values checked) by `initialize()`, each other one when it is first
   * shown, so opening a file never waits for embeddings its first view does
   * not draw.
   *
   * @returns {Object|null} The named slots, or null when none is
   * @private
   */
  _requestedEmbeddingSlots(entries) {
    const named = DIMENSION_SLOTS.filter(slot => Object.hasOwn(this._defaults, `embedding${slot}`));
    if (named.length === 0) return null;
    const requested = {};
    for (const slot of named) {
      const name = `embedding${slot}`;
      const { key, columns } = this._defaults[name];
      const entry = entries.find(item => item.key === key);
      if (entry === undefined) {
        throw new RangeError(
          `defaults.${name} names obsm['${key}'], which this file does not have. ` +
          `obsm holds: ${formatKeyList(entries.map(item => item.key))}.`
        );
      }
      if (!entry.usable || entry.width === null) {
        throw new RangeError(`defaults.${name}: obsm['${key}'] ${entry.reason ?? 'is not a dense array'}.`);
      }
      const dimension = slotDimension(slot);
      let resolved;
      try {
        resolved = validateEmbeddingColumns(columns ?? defaultColumns(dimension), { dimension, width: entry.width });
      } catch (error) {
        throw new RangeError(`defaults.${name} obsm['${key}']: ${error.message}`, { cause: error });
      }
      requested[slot] = { key, columns: resolved };
    }
    return requested;
  }

  /**
   * The named slots, and the default rule's choice for every other slot,
   * held to the rule's own checks.
   * @private
   */
  _withDefaultRuleSlots(entries, requested) {
    const slots = defaultEmbeddingSlots(entries);
    for (const slot of DIMENSION_SLOTS) {
      if (Object.hasOwn(requested, slot)) {
        slots[slot] = requested[slot];
        continue;
      }
      const ref = slots[slot];
      if (ref === null) continue;
      const entry = entries.find(item => item.key === ref.key);
      if (!entry.usable || entry.width === null) throw new Error(`Embedding '${ref.key}' ${entry.reason}.`);
      if (entry.width !== slotDimension(slot)) {
        throw new Error(`Embedding '${ref.key}' must have exactly ${formatCountOf(slotDimension(slot), 'column')}; got ${entry.width}.`);
      }
    }
    return slots;
  }

  /**
   * Resolve the embedding of every dimension slot, or refuse the file when
   * nothing in `obsm` can be plotted.
   *
   * @param {ReturnType<typeof describeAnnDataProbes>} described
   * @param {number} generation
   * @returns {Promise<{slots: Object, guessed: string[], rejected: Array<[string, string]>}>}
   * @private
   */
  async _resolveEmbeddingSlots(described, generation) {
    const loadCheck = async (key, columns) => {
      try {
        await this.getEmbeddingForRef({ key, columns });
        return null;
      } catch (error) {
        if (error instanceof EmbeddingLoadError) return error.reason;
        throw error;
      }
    };
    const entries = obsmEntries(described.obsm);
    // Slots a launch named are shown as named; the others follow the default
    // rule, and only when neither fills a slot is the best guess made.
    const requested = this._requestedEmbeddingSlots(entries);
    const resolution = requested === null
      ? await resolveEmbeddingSlotsAsync(entries, loadCheck)
      : { slots: this._withDefaultRuleSlots(entries, requested), guessed: [], rejected: [] };
    this._assertLifecycleGeneration(generation);
    if (DIMENSION_SLOTS.every(slot => resolution.slots[slot] === null)) {
      const rejected = new Map(resolution.rejected);
      const vectorKeys = vectorFieldKeys(described.obsm.map(item => item.key));
      const descriptions = described.obsm.map(item => describeObsmEntry({
        key: item.key,
        storage: item.storage,
        shape: item.shape,
        defect: obsmEntryDefect(item, { latentKey: null, rejected, vectorKeys }),
      }));
      throw explainedFailure(
        nothingPlottableMessage({ nObs: described.nObs, descriptions }),
        DataSourceErrorCode.NO_PLOTTABLE_EMBEDDING,
        this.constructor.sourceType ?? undefined
      );
    }
    return resolution;
  }

  /**
   * Record the vector fields the data-mapping default binds, without loading
   * the vector arrays.
   *
   * The rule is the data-mapping default (`defaultVectorBindings` in
   * `data-mapping.js`): a key `<field>_<basis>` is the vector field
   * `<field>`, bound to every enabled representation of `X_<basis>` that is
   * as wide as it (`velocity_umap` on `X_umap`, `velocity_branches` on
   * `X_branches`).
   *
   * @param {number} [generation]
   * @protected
   */
  async _computeVectorFieldsMetadata(
    generation = this._captureLifecycleGeneration()
  ) {
    this._vectorBindings.clear();
    const bindings = this._candidates.defaults.vectorFields;
    const byField = new Map();
    for (const binding of bindings) {
      const resolved = resolveVectorBinding(this._candidates, binding);
      if (!resolved.ok) {
        throw new Error(`Vector field obsm['${binding.key}'] cannot be drawn: ${resolved.reason}`);
      }
      const fieldId = resolved.fieldId;
      const embeddingId = this._embeddingIdOf(binding.embedding);
      let keys = byField.get(fieldId);
      if (keys === undefined) {
        keys = new Map();
        byField.set(fieldId, keys);
      }
      keys.set(embeddingId, binding.key);
    }
    this._assertLifecycleGeneration(generation);
    for (const fieldId of [...byField.keys()].sort(compareCodePoints)) {
      this._vectorBindings.set(fieldId, byField.get(fieldId));
    }
    if (Object.hasOwn(this._defaults, 'vectorFieldDefault') && this._defaults.vectorFieldDefault !== null) {
      const fieldId = this._defaults.vectorFieldDefault;
      if (this._vectorBindings.size === 0) {
        throw new RangeError('defaults.vectorFieldDefault was provided but no vector fields exist.');
      }
      if (!this._vectorBindings.has(fieldId)) {
        throw new RangeError(
          `defaults.vectorFieldDefault '${fieldId}' does not match an available field: ` +
          `${formatKeyList([...this._vectorBindings.keys()])}.`
        );
      }
    }
  }

  /**
   * The embedding id of one `{key, columns}` reference: the key when the
   * array is read whole, else `key[c0,c1]`.
   *
   * @param {{key: string, columns: ReadonlyArray<number>}} ref
   * @returns {string}
   * @private
   */
  _embeddingIdOf(ref) {
    const item = this._describedObsm?.find(entry => entry.key === ref.key);
    if (item === undefined) {
      throw new RangeError(`obsm['${ref.key}'] does not exist in this file`);
    }
    return canonicalEmbeddingId(ref.key, ref.columns, { width: obsmWidth(item) });
  }

  /**
   * The data-mapping candidate catalog of this file, which the loaders read
   * at its `candidates` route.
   *
   * @returns {Object}
   */
  getMappingCandidates() {
    if (this._candidates === null) {
      throw new Error('AnnData data-mapping candidates are not initialized');
    }
    // A guess settled since (by this adapter, or by the earlier reading of
    // the same store it shares them with): the catalog states it.
    if (this._candidatesGuessCount !== this._geneNameGuesses.size) this._assembleGuessedCandidates();
    return this._candidates;
  }

  /**
   * The gene-name guesses of this store, for a reading of it with other
   * cells to keep (`AnnDataFileSource.reopenCells`).
   * @returns {GeneNameGuesses}
   */
  geneNameGuesses() {
    return this._geneNameGuesses;
  }

  /**
   * Compute obs field metadata (to be overridden by subclasses if needed)
   * @protected
   * @returns {Promise<void>}
   */
  async _computeObsFieldsMetadata(
    generation = this._captureLifecycleGeneration()
  ) {
    this._obsFieldsMetadata = null;

    // Opening reads no obs value and no category dictionary: every field is
    // described from its metadata alone, so the first view waits for none of
    // them. A categorical's stored categories (and Scanpy's palette for them)
    // are read when the field is first loaded (`_getOrLoadFieldData`): a
    // dictionary of one category per cell (a barcode stored as a
    // categorical) is megabytes nobody needs until it is shown. A string or
    // boolean column is categorical too; its categories are its distinct
    // values, found when it is first loaded, so one that cannot be a
    // categorical is refused then, never at open.
    const describe = async key => {
      const fieldInfo = await this._loader.getObsFieldKind(key);
      this._assertLifecycleGeneration(generation);
      if (fieldInfo.dtype === 'categorical') {
        return {
          key,
          kind: 'category',
          categories: null,
          // How many there are is metadata, known without reading them.
          categoryCount: fieldInfo.categoryCount,
          ordered: fieldInfo.ordered,
          // Scanpy's `uns['<key>_colors']`, read with the categories.
          palette: null,
          _dictionaryOnLoad: true,
        };
      }
      if (fieldInfo.dtype === 'float' || fieldInfo.dtype === 'int' || fieldInfo.dtype === 'uint') {
        return { key, kind: 'continuous', min: null, max: null };
      }
      if (fieldInfo.dtype === 'string' || fieldInfo.dtype === 'bool') {
        // A text column's categories are found by reading it, in an order a
        // Scanpy palette was not written in: it opens in Cellucid's colours.
        return { key, kind: 'category', categories: null, palette: null, _needsCodeComputation: true };
      }
      throw new Error(`Observation field '${key}' has unsupported dtype '${fieldInfo.dtype}'`);
    };
    const obsFieldsMetadata = await Promise.all(this._shownObsKeys().map(describe));

    this._assertLifecycleGeneration(generation);
    this._obsFieldsMetadata = obsFieldsMetadata;

    // Update metadata with field info
    this._metadata.obs_fields = obsFieldsMetadata.map(f => ({
      key: f.key,
      kind: f.kind,
      // A stored dictionary's count is metadata; null for a text column,
      // whose categories are found when it is loaded.
      n_categories: f.kind === 'category' ? (f.categories?.length ?? f.categoryCount ?? null) : undefined,
      ...(typeof f.ordered === 'boolean'
        ? { ordered: f.ordered }
        : {}),
    }));

    const nCategorical = obsFieldsMetadata.filter(f => f.kind === 'category').length;
    const nContinuous = obsFieldsMetadata.filter(f => f.kind === 'continuous').length;
    this._metadata.stats.n_categorical_fields = nCategorical;
    this._metadata.stats.n_continuous_fields = nContinuous;
    this._metadata.stats.n_obs_fields = obsFieldsMetadata.length;
  }

  /**
   * The obs columns shown, in order: the ones a launch named
   * (`defaults.obsKeys`), else every column.
   *
   * @returns {string[]}
   * @private
   */
  _shownObsKeys() {
    const available = this._loader.obsKeys;
    if (!Object.hasOwn(this._defaults, 'obsKeys')) return available;
    const missing = this._defaults.obsKeys.filter(key => !available.includes(key));
    if (missing.length > 0) {
      throw new RangeError(
        `defaults.obsKeys contain columns not in obs: ${formatKeyList(missing)}. ` +
        `Available columns: ${formatKeyList(available)}.`
      );
    }
    return [...this._defaults.obsKeys];
  }

  /**
   * Discover primitive categories without whole-column filter/spread/map
   * copies. The scan stops at the first unsupported unique count and accounts
   * for the raw values plus Set/array/sort workspace as it grows.
   *
   * @param {ArrayLike<unknown>} values
   * @param {string} key
   * @returns {(string|number|boolean)[]}
   * @private
   */
  _discoverPrimitiveCategories(values, key) {
    const length = Number(values?.length);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(
        `Observation field '${key}' has an invalid values length`
      );
    }

    const categories = [];
    const seen = new Set();

    for (let index = 0; index < length; index++) {
      const value = values[index];
      if (value == null) continue;

      const type = typeof value;
      if (
        type !== 'string' &&
        type !== 'number' &&
        type !== 'boolean'
      ) {
        throw new Error(
          `Observation field '${key}' has an unsupported category label type`
        );
      }
      if (type === 'number' && !Number.isFinite(value)) {
        throw new Error(
          `Observation field '${key}' has a non-finite numeric category label`
        );
      }

      if (seen.has(value)) continue;
      validateCellucidCategoryCount(categories.length + 1, key);
      seen.add(value);
      categories.push(value);
    }

    if (categories.every(category => typeof category === 'string')) {
      categories.sort();
    } else {
      categories.sort(comparePrimitiveCategories);
    }
    validateCellucidCategories(categories, key);
    return categories;
  }

  /**
   * Release a loader-owned observation payload only if it is still the exact
   * value returned to this operation.
   *
   * @param {string} key
   * @param {Object|null} field
   * @private
   */
  _releaseLoaderObsField(key, field) {
    if (!field) return;
    this._loader.releaseObsField?.(key, field);
  }

  /**
   * Estimate bytes uniquely retained by one lazy observation result (its
   * per-cell array; category dictionaries are shared with the metadata).
   *
   * @param {Object} result
   * @returns {bigint}
   * @private
   */
  _estimateObsFieldDataBytes(result) {
    const values = result?.kind === 'category'
      ? result.codes
      : result?.values;
    if (!values) return 0n;
    if (Number.isSafeInteger(values.byteLength)) {
      return BigInt(values.byteLength);
    }
    const length = Number(values.length);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Observation field has an invalid retained length');
    }
    return BigInt(length) * JS_ARRAY_ELEMENT_BYTES;
  }

  /**
   * Remove one exact cache entry and its accounting. Identity checking keeps
   * an older operation from evicting a newer independent result.
   *
   * @param {string} key
   * @param {Object} [expected]
   * @private
   */
  _deleteObsFieldDataCache(key, expected = undefined) {
    const cached = this._obsFieldDataCache.get(key);
    if (expected !== undefined && cached !== expected) return false;
    if (cached === undefined && !this._obsFieldDataCache.has(key)) {
      return false;
    }
    this._obsFieldDataCache.delete(key);
    this._obsFieldDataCacheBytes -=
      this._estimateObsFieldDataBytes(cached);
    if (this._obsFieldDataCacheBytes < 0n) {
      this._obsFieldDataCacheBytes = 0n;
    }
    return true;
  }

  /**
   * Retain one lazy result, evicting least-recently-used entries (Map
   * iteration order) while the cache is over its residency budget.
   *
   * @param {string} key
   * @param {Object} result
   * @private
   */
  _cacheObsFieldData(key, result) {
    const resultBytes = this._estimateObsFieldDataBytes(result);

    this._deleteObsFieldDataCache(key);
    while (
      this._obsFieldDataCache.size > 0 &&
      this._obsFieldDataCacheBytes + resultBytes > this._cacheBudgetBytes
    ) {
      const oldestKey = this._obsFieldDataCache.keys().next().value;
      this._deleteObsFieldDataCache(oldestKey);
    }

    this._obsFieldDataCache.set(key, result);
    this._obsFieldDataCacheBytes += resultBytes;
  }

  /**
   * Get or compute full field data (lazy loading)
   * @param {string} key - Field name
   * @param {AbortSignal|null} [signal] - Cancels the read
   * @returns {Promise<Object>}
   * @protected
   */
  async _getOrLoadFieldData(key, signal = null) {
    const generation = this._captureLifecycleGeneration();
    if (this._obsFieldDataCache.has(key)) {
      const cached = this._obsFieldDataCache.get(key);
      // Refresh least-recently-used order without changing byte ownership.
      this._obsFieldDataCache.delete(key);
      this._obsFieldDataCache.set(key, cached);
      return cached;
    }

    const meta = this._obsFieldsMetadata.find(f => f.key === key);
    if (!meta) {
      throw new Error(`Obs field '${key}' not found`);
    }

    // A stored category dictionary is read with the field's first load, with
    // the palette Scanpy wrote for it (`uns['<key>_colors']`), and kept for
    // the life of the dataset.
    if (meta._dictionaryOnLoad === true) {
      const fieldInfo = await this._loader.getObsFieldInfo(key);
      this._assertLifecycleGeneration(generation);
      if (meta._dictionaryOnLoad === true) {
        validateCellucidCategories(fieldInfo.categories, key);
        meta.categories = fieldInfo.categories;
        meta.palette = scanpyCategoryPalette(fieldInfo.colors, fieldInfo.categories.length);
        meta._dictionaryOnLoad = false;
      }
    }

    if (
      meta.kind === 'category' &&
      !meta._needsCodeComputation &&
      Array.isArray(meta.categories)
    ) {
      this._loader.seedObsFieldCategories?.(
        key,
        meta.categories,
        meta.ordered
      );
    }
    const field = await this._loader.getObsField(key, { signal });
    try {
      this._assertLifecycleGeneration(generation);
      let result;

      if (meta.kind === 'continuous') {
        const values = field.values;
        let min = Infinity, max = -Infinity;

        const len = values.length;
        for (let i = 0; i < len; i++) {
          const v = values[i];
          if (Number.isFinite(v)) {
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }

        if (min === Infinity || max === -Infinity) {
          throw new Error(
            `Continuous observation field '${key}' contains no finite values`
          );
        }
        meta.min = min;
        meta.max = max;

        result = {
          kind: 'continuous',
          values: values instanceof Float32Array ? values : copyTypedArray(Float32Array, values, `Observation field '${key}'`),
          min: meta.min,
          max: meta.max,
        };
      } else {
        // Categorical
        let codes, categories;
        if (
          !meta._needsCodeComputation &&
          (field.dtype !== 'categorical' || !field.codes)
        ) {
          throw new Error(
            `Categorical observation field '${key}' no longer matches its ` +
            'adopted categorical storage'
          );
        }
        if (
          meta._needsCodeComputation &&
          (
            (field.dtype !== 'string' && field.dtype !== 'bool') ||
            !field.values
          )
        ) {
          throw new Error(
            `Categorical observation field '${key}' no longer matches its ` +
            'adopted primitive storage'
          );
        }
        if (!meta._needsCodeComputation) {
          validateCellucidCategories(field.categories, key);
          if (
            field.categories.length !== meta.categories.length ||
            field.categories.some(
              (category, index) => category !== meta.categories[index]
            )
          ) {
            throw new Error(
              `Categorical observation field '${key}' changed its category ` +
              'dictionary after metadata adoption'
            );
          }
          // Narrowed by the reader worker (`narrowCategoricalCodes`).
          codes = field.codes;
          categories = meta.categories;
          const { TypedArrayClass } = getCellucidCategoryStorage(categories, key);
          if (!(codes instanceof TypedArrayClass) || codes.length !== this._loader.nObs) {
            throw new Error(
              `Categorical observation field '${key}' must arrive as narrowed codes, one per cell`
            );
          }
        } else {
          // A string or boolean column: its categories are its distinct
          // values, found the first time it is read and kept for the life
          // of the dataset, so every later load codes it the same way.
          if (meta.categories === null) {
            const discovered = this._discoverPrimitiveCategories(field.values, key);
            this._assertLifecycleGeneration(generation);
            // The dataset identity keeps its null count: it describes what
            // opening the file knows, and stays the same whichever fields
            // were loaded.
            meta.categories = discovered;
          }
          categories = meta.categories;
          const valueCount = Number(field.values?.length);
          if (!Number.isSafeInteger(valueCount) || valueCount < 0) {
            throw new Error(
              `Observation field '${key}' has an invalid values length`
            );
          }
          const categoryMap = new Map();
          for (let index = 0; index < categories.length; index++) {
            categoryMap.set(categories[index], index);
          }
          const { TypedArrayClass, missingValue } = getCellucidCategoryStorage(categories, key);
          codes = allocateTypedArray(TypedArrayClass, valueCount, `Observation field '${key}' codes`);
          for (let i = 0; i < valueCount; i++) {
            const v = field.values[i];
            if (v == null) {
              codes[i] = missingValue;
              continue;
            }
            const code = categoryMap.get(v);
            if (code === undefined) {
              throw new Error(
                `Observation field '${key}' contains undeclared category ` +
                `at index ${i}`
              );
            }
            codes[i] = code;
          }
        }

        result = {
          kind: 'category',
          categories,
          codes,
          ...(typeof field.ordered === 'boolean'
            ? { ordered: field.ordered }
            : {}),
        };
      }

      this._cacheObsFieldData(key, result);
      return result;
    } finally {
      this._releaseLoaderObsField(key, field);
    }
  }

  /**
   * Get dataset metadata
   * @returns {Object}
   */
  getMetadata() {
    return this._metadata;
  }

  /**
   * Return the immutable connectivity summary owned by finalized identity
   * validation. This method never reads or populates the edge cache.
   *
   * @returns {Readonly<Object>|null}
   */
  getConnectivitySummary() {
    if (
      !this._directIdentityFinalized ||
      this._connectivitySummary === undefined
    ) {
      throw new Error(
        'Direct AnnData connectivity metadata is not finalized'
      );
    }
    return this._connectivitySummary;
  }

  /**
   * Build and validate the one public direct-AnnData dataset identity.
   * Loader-only obsm resolution remains private to this adapter.
   *
   * What the file says about itself (`uns['cellucid']`, `getFileMetadata()`)
   * is the identity, over what the caller offers: its description, citation
   * and source name and address replace the caller's. Its name replaces the
   * caller's when `preferFileName` is set (a file opened by its user, from
   * disk or a link), else the caller's name stands (a server that names the
   * dataset); with no `uns['cellucid']['name']`, `uns['title']` is the
   * file's name, as CELLxGENE writes it.
   *
   * @param {Object} descriptor
   * @param {string} descriptor.id - The dataset id the source serves it under
   * @param {string} descriptor.name - The caller's name for it
   * @param {boolean} descriptor.preferFileName - The file's own name wins
   * @param {string} descriptor.description - The caller's description
   * @param {{name: string, url?: string, filename?: string, citation?: string}} descriptor.source
   *   Where the caller read it from; `citation` is the citation a provider
   *   gives (a repository record's)
   * @returns {Promise<Object>}
   */
  async finalizeDirectIdentity({
    id,
    name,
    preferFileName,
    description,
    source,
  }) {
    const generation = this._captureLifecycleGeneration();
    if (this._directIdentityFinalized) {
      throw new Error(
        'Direct AnnData identity is already finalized for this adapter'
      );
    }
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof preferFileName !== 'boolean' ||
      typeof description !== 'string' ||
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source)
    ) {
      throw new TypeError(
        'Direct AnnData identity descriptor is incomplete'
      );
    }
    const file = this.getFileMetadata();
    const shownName = (preferFileName ? file.name ?? this.getFileTitle() : null) ?? name;
    const { citation: providerCitation, ...readFrom } = source;
    const identitySource = {
      ...readFrom,
      ...(file.source === null
        ? {}
        : { name: file.source.name, ...(file.source.url === null ? {} : { url: file.source.url }) }),
    };
    const citation = file.citation !== null
      ? { text: file.citation.text, ...(file.citation.url === null ? {} : { url: file.citation.url }) }
      : typeof providerCitation === 'string' && providerCitation.length > 0
        ? { text: providerCitation }
        : null;

    if (this._slots === null) {
      throw new Error('Direct AnnData embeddings are not resolved');
    }
    const resolved = [];
    for (const slot of DIMENSION_SLOTS) {
      const ref = this._slots[slot];
      if (ref === null) continue;
      resolved.push({
        id: this._embeddingIdOf(ref),
        dimension: ref.columns.length,
        key: ref.key,
        columns: [...ref.columns],
      });
    }
    if (resolved.length === 0) {
      throw new Error(
        'Direct AnnData identity requires at least one embedding'
      );
    }
    resolved.sort((left, right) =>
      left.dimension - right.dimension || compareCodePoints(left.id, right.id)
    );
    const items = {};
    const defaults = {};
    for (const embedding of resolved) {
      items[embedding.id] = {
        label: embedding.id,
        dimension: embedding.dimension,
        path: mappingEmbeddingPath(obsmIndexOf(this._candidates, embedding.key), embedding.columns),
        source: { key: embedding.key, columns: [...embedding.columns] },
      };
      defaults[dimensionSlot(embedding.dimension)] = embedding.id;
    }

    // Whether the default graph exists is known from the file's metadata;
    // its edges are read (and counted) only when something shows or uses
    // them. Counting them here would read the whole graph -- often the
    // largest array in the file -- on every open.
    const graphKey = this._defaultGraphKey();
    const hasConnectivity = graphKey !== null && await this._loader.hasConnectivities(graphKey);
    this._assertLifecycleGeneration(generation);
    const connectivitySummary = hasConnectivity
      ? { n_cells: this._loader.nObs, n_edges: null, max_neighbors: null }
      : null;
    validateConnectivitySummary(connectivitySummary);
    // The gene count of the gene list the file opens with (raw.X has its
    // own), from metadata: no gene name is read before the first view.
    const mappingDefaults = this._candidates.defaults;
    const geneAxisRoute = mappingDefaults.expression === null
      ? null
      : expressionAxisRoute(this._candidates, mappingDefaults.expression, mappingDefaults.modality ?? null);
    const geneCount = geneAxisRoute === null ? 0 : axisGeneCount(this._candidates, geneAxisRoute);
    const obsFields = this.getObsFields().fields.map(field => (
      field.kind === 'continuous'
        ? { key: field.key, kind: 'continuous' }
        : {
            key: field.key,
            kind: 'category',
            // A stored dictionary's count is metadata; null for a string or
            // boolean column, whose categories are found when it is loaded.
            n_categories: field.categories === null
              ? (this._obsFieldsMetadata[field.fieldIndex]?.categoryCount ?? null)
              : field.categories.length,
          }
    ));

    const identity = {
      id,
      name: shownName,
      description: file.description ?? description,
      stats: {
        n_cells: this._loader.nObs,
        n_genes: geneCount,
        n_obs_fields: obsFields.length,
        n_categorical_fields: obsFields.filter(
          field => field.kind === 'category'
        ).length,
        n_continuous_fields: obsFields.filter(
          field => field.kind === 'continuous'
        ).length,
        has_connectivity: hasConnectivity,
        n_edges: null,
      },
      embeddings: {
        default_dimension: slotDimension(openingSlot(this._slots)),
        defaults,
        items,
      },
      obs_fields: obsFields,
      source: identitySource,
      ...(citation === null ? {} : { citation }),
      ...(this._defaults.vectorFieldDefault == null
        ? {}
        : { vector_field_default: this._defaults.vectorFieldDefault }),
    };
    validateDatasetIdentity(identity, id, 'direct-anndata');
    this._assertLifecycleGeneration(generation);
    this._connectivitySummary = connectivitySummary === null
      ? null
      : Object.freeze(connectivitySummary);
    this._metadata = identity;
    this._directIdentityFinalized = true;
    return identity;
  }

  /**
   * The display coordinates of one embedding, by its route under the
   * dataset base: `obsm/{i}/{cols}` names `obsm` entry `i` of the candidate
   * catalog read at `cols`.
   *
   * The reader worker checked and normalized them (`embedding-payload.js`);
   * `transform` is their display transform (the identity for normalized
   * coordinates) and `bounds` their per-axis bounds, so the page neither
   * normalizes nor scans them again.
   *
   * The caller owns the returned positions, exactly as it owns a fetched
   * payload: the adapter hands over its cached array and drops its own
   * reference, so an eviction by the caller frees the memory instead of
   * leaving it held here.
   *
   * @param {string} path
   * @param {number} dimension - The dimension the caller's layout declares.
   * @param {{signal?: AbortSignal|null}} [options] - Ends this caller's
   *   wait; the read stops once no caller still waits for it.
   * @returns {Promise<import('./embedding-payload.js').EmbeddingPayload>}
   */
  async getEmbeddingPayload(path, dimension, { signal = null } = {}) {
    const route = parseMappingEmbeddingPath(path);
    const item = route === null ? undefined : this._candidates?.obsm[route.obsmIndex];
    if (item === undefined) {
      throw new RangeError(`This dataset has no embedding '${path}'.`);
    }
    const ref = { key: item.key, columns: route.columns };
    if (ref.columns.length !== dimension) {
      throw new RangeError(
        `Embedding payload '${path}' holds ${ref.columns.length}D coordinates, not ${dimension}D.`
      );
    }
    const embedding = await this.getEmbeddingForRef(ref, { signal });
    const { embeddingId } = this._resolveEmbeddingRef(ref);
    const { transform, bounds } = this._embeddingInfo.get(embeddingId);
    if (this._deleteCoordinateCacheEntry(this._embeddingCoordinateCacheKey(embeddingId), embedding)) {
      return { positions: embedding, transform, bounds };
    }
    // Another caller of the same computation was handed the cached array
    // first. Every caller sharing one computation resumes in the same turn,
    // before any of them can write to it, so this copy is still the payload.
    return { positions: copyLargeArray(embedding), transform, bounds };
  }

  /**
   * The checked columns and canonical embedding id of one `obsm` reference.
   *
   * @param {{key: string, columns: ReadonlyArray<number>}} ref
   * @returns {{columns: ReadonlyArray<number>, dimension: number, embeddingId: string}}
   * @private
   */
  _resolveEmbeddingRef(ref) {
    if (this._describedObsm === null) {
      throw new Error('AnnData obsm entries are not described yet');
    }
    const dimension = ref.columns.length;
    const resolved = resolveCandidateRef({ obsm: this._describedObsm }, ref, dimension);
    if (!resolved.ok) {
      throw new RangeError(`Cannot plot this embedding: ${resolved.reason}.`);
    }
    const columns = resolved.columns;
    return {
      columns,
      dimension,
      embeddingId: canonicalEmbeddingId(ref.key, columns, { width: resolved.width })
    };
  }

  /**
   * The display coordinates of the selected columns of one `obsm` array,
   * read, checked and normalized by the reader worker
   * (`EmbeddingPayloads.embedding`). Values that are not finite,
   * representable as float32 or (normalized) spanning a non-zero range are
   * an `EmbeddingLoadError` naming the first offending cell. The result is
   * cached by its embedding id, with its display transform and bounds.
   *
   * @param {{key: string, columns: ReadonlyArray<number>}} ref
   * @param {{signal?: AbortSignal|null}} [options] - Ends this caller's
   *   wait; the read stops once no caller still waits for it.
   * @returns {Promise<Float32Array>}
   */
  async getEmbeddingForRef(ref, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const { columns, dimension, embeddingId } = this._resolveEmbeddingRef(ref);
    const coordinateCacheKey = this._embeddingCoordinateCacheKey(embeddingId);
    const releasePin = this._pinCoordinateCacheKey(coordinateCacheKey);

    try {
      if (this._embeddingCache.has(embeddingId)) {
        const cached = this._embeddingCache.get(embeddingId);
        this._touchCoordinateCacheEntry(coordinateCacheKey, cached);
        await Promise.resolve();
        this._assertLifecycleGeneration(generation);
        return cached;
      }

      return await this._coalesceInFlight(
        this._embeddingInFlight,
        embeddingId,
        generation,
        async workSignal => {
          if (this._embeddingCache.has(embeddingId)) {
            const cached = this._embeddingCache.get(embeddingId);
            this._touchCoordinateCacheEntry(coordinateCacheKey, cached);
            this._assertLifecycleGeneration(generation);
            return cached;
          }
          const payload = await this._loader.readEmbedding(
            ref.key,
            columns,
            this._defaults.normalizeEmbeddings !== false,
            { signal: workSignal }
          );
          this._assertLifecycleGeneration(generation);
          const label = `Embedding '${embeddingId}'`;
          const { positions } = payload;
          if (!(positions instanceof Float32Array) || positions.length !== this._loader.nObs * dimension) {
            throw new Error(`${label} read did not return one row per cell`);
          }
          this._embeddingInfo.set(embeddingId, {
            transform: Object.freeze({ center: Object.freeze([...payload.transform.center]), scale: payload.transform.scale }),
            bounds: payload.bounds === null
              ? null
              : Object.freeze({ min: Object.freeze([...payload.bounds.min]), max: Object.freeze([...payload.bounds.max]) }),
          });
          this._retainCoordinateCacheEntry({
            cacheKey: coordinateCacheKey,
            embeddingId,
            kind: 'embedding',
            label,
            value: positions
          });
          return positions;
        },
        signal
      );
    } finally {
      releasePin();
    }
  }

  /**
   * The per-cell displacement vectors of one vector field bound to one
   * embedding, by its route `vectors/{vector}/{vcols}/{embedding}/{ecols}`
   * (`resolveVectorBinding`): the vector array read at `vcols`, checked and
   * scaled by the bound embedding's transform in the reader worker
   * (`EmbeddingPayloads.vectors`), so the vectors live in the space its
   * positions are shown in -- with the largest vector's magnitude. Both
   * arrays are read at once when the embedding is not read yet.
   *
   * The vectors are shared, read-only: the cache and every caller hold the
   * same array.
   *
   * @param {string} path
   * @param {number} dimension - The bound embedding's dimension, as the caller's layout declares it.
   * @param {{signal?: AbortSignal|null}} [options] - Ends this caller's
   *   wait; the reads stop once no caller still waits for them.
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>} `dimension` components per cell.
   */
  async getVectorPayload(path, dimension, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const route = parseMappingVectorPath(path);
    const vectorItem = route === null ? undefined : this._candidates?.obsm[route.vectorIndex];
    const embeddingItem = route === null ? undefined : this._candidates?.obsm[route.embeddingIndex];
    if (vectorItem === undefined || embeddingItem === undefined) {
      throw new RangeError(`This dataset has no vector route '${path}'.`);
    }
    const embeddingRef = { key: embeddingItem.key, columns: route.embeddingColumns };
    const resolved = resolveVectorBinding(this._candidates, { key: vectorItem.key, embedding: embeddingRef });
    if (!resolved.ok) {
      throw new RangeError(`Cannot draw this vector field: ${resolved.reason}.`);
    }
    if (resolved.path !== path) {
      throw new RangeError(
        `obsm['${vectorItem.key}'] cannot be bound to obsm['${embeddingItem.key}'] at these columns.`
      );
    }
    if (resolved.dimension !== dimension) {
      throw new RangeError(
        `Vector payload '${path}' holds ${resolved.dimension}D vectors, not ${dimension}D.`
      );
    }
    const embeddingColumns = this._resolveEmbeddingRef(embeddingRef).columns;
    const embeddingId = resolved.layoutKey;
    const coordinateCacheKey = this._vectorCoordinateCacheKey(path);
    const releasePin = this._pinCoordinateCacheKey(coordinateCacheKey);
    const cachedPayload = () => {
      const vectors = this._vectorFieldCache.get(path);
      this._touchCoordinateCacheEntry(coordinateCacheKey, vectors);
      return { vectors, maxMagnitude: this._vectorMagnitudes.get(path) };
    };

    try {
      if (this._vectorFieldCache.has(path)) {
        const cached = cachedPayload();
        await Promise.resolve();
        this._assertLifecycleGeneration(generation);
        return cached;
      }

      return await this._coalesceInFlight(
        this._vectorFieldInFlight,
        path,
        generation,
        async workSignal => {
          if (this._vectorFieldCache.has(path)) {
            this._assertLifecycleGeneration(generation);
            return cachedPayload();
          }
          const payload = await this._loader.readVectorField(
            vectorItem.key,
            route.vectorColumns,
            { key: embeddingItem.key, columns: embeddingColumns },
            this._defaults.normalizeEmbeddings !== false,
            { signal: workSignal }
          );
          this._assertLifecycleGeneration(generation);
          const { vectors, maxMagnitude } = payload;
          if (!(vectors instanceof Float32Array) || vectors.length !== this._loader.nObs * dimension) {
            throw new Error(`Vector field '${vectorItem.key}' read did not return one vector per cell`);
          }
          this._retainCoordinateCacheEntry({
            cacheKey: coordinateCacheKey,
            embeddingId,
            vectorPath: path,
            kind: 'vector',
            label: `Vector field '${vectorItem.key}'`,
            value: vectors
          });
          this._vectorMagnitudes.set(path, maxMagnitude);
          return { vectors, maxMagnitude };
        },
        signal
      );
    } finally {
      releasePin();
    }
  }

  /**
   * The obs field list the data loaders check (`checkObsFields`): one
   * descriptor per obs field, continuous fields first, each with its
   * position in the file's obs field list (`fieldIndex`). A categorical
   * field states its categories, code dtype and missing code (all null for
   * a string or boolean column, whose categories are found when it is first
   * loaded, `getObsFieldData`) and the route of its outlier quantiles in the
   * latent space the dataset opens with (null without one).
   *
   * @returns {Object}
   */
  getObsFields() {
    if (
      !Number.isSafeInteger(this._loader.nObs) ||
      this._loader.nObs <= 0
    ) {
      throw new Error(
        'AnnData datasets must contain at least one observation'
      );
    }
    // The latent space the dataset opens with (a launch's `latentKey`): every
    // categorical field's outlier quantiles are computed in it, on its
    // route, exactly as a latent space chosen later is applied.
    const latentKey = this._candidates?.defaults.latent ?? null;
    const latentIndex = latentKey === null ? -1 : obsmIndexOf(this._candidates, latentKey);
    const continuous = [];
    const categorical = [];
    this._obsFieldsMetadata.forEach((field, fieldIndex) => {
      if (field.kind === 'continuous') {
        continuous.push({ key: field.key, kind: 'continuous', fieldIndex, outlierQuantilesPath: null });
        return;
      }
      const storage = field.categories === null
        ? { dtype: null, missingValue: null }
        : getCellucidCategoryStorage(field.categories, field.key);
      categorical.push({
        key: field.key,
        kind: 'category',
        fieldIndex,
        categories: field.categories,
        codesDtype: storage.dtype,
        codesMissingValue: storage.missingValue,
        palette: field.palette,
        outlierQuantilesPath: latentIndex < 0 ? null : mappingLatentOutlierPath(latentIndex, fieldIndex),
      });
    });
    return {
      n_points: this._loader.nObs,
      outlier_min_points: this._outliers?.minPoints ?? LATENT_OUTLIER_MIN_POINTS,
      stored_outlier_latent_key: this._outliers?.storedLatentKey ?? null,
      latent_key: latentIndex < 0 ? null : latentKey,
      fields: [...continuous, ...categorical],
    };
  }

  /**
   * One gene list the data loaders check (`checkGeneList`): the genes of one
   * expression matrix named by one name source. `var` is the gene list this
   * file opens with (the default expression matrix and gene names), and
   * `var/{axis}/{names}` any other; gene `g` of a list is at `{list}/{g}`.
   * The names are made unique with `makeUniqueNames`, exactly as `cellucid
   * serve` does; `geneNames` records what that changed.
   *
   * @param {string} [path='var']
   * @returns {Promise<Object>}
   */
  async getGeneList(path = 'var') {
    const generation = this._captureLifecycleGeneration();
    if (
      !Number.isSafeInteger(this._loader.nObs) ||
      this._loader.nObs <= 0
    ) {
      throw new Error(
        'AnnData datasets must contain at least one observation'
      );
    }
    await this._settleOwnGeneNames(path, generation);
    const route = this._resolveGeneRoute(path, 'list');
    const names = route === null ? null : await this._geneNames(route);
    this._assertLifecycleGeneration(generation);
    // The genes listed here come from this matrix: let a reader that must
    // index it by gene start now, in the background, so the first gene shown
    // does not wait for the whole index.
    if (route !== null) this._loader.prepareMatrix?.(route.element);
    return {
      n_points: this._loader.nObs,
      fields: names === null
        ? []
        : names.names.map((name, gene) => ({ key: name, kind: 'continuous', path: `${path}/${gene}` })),
      geneNames: names === null
        ? { source: null, filledFromIndex: 0, renamed: [], ids: null }
        : {
            source: names.source,
            filledFromIndex: names.filledFromIndex,
            renamed: names.renamed.map(pair => [...pair]),
            ids: names.ids === null ? null : [...names.ids],
          },
    };
  }

  /**
   * The obs names of the open cells, in order: read when an export asks.
   * @returns {Promise<string[]>}
   */
  async getObsNames() {
    const generation = this._captureLifecycleGeneration();
    const names = await this._loader.readObsNames();
    this._assertLifecycleGeneration(generation);
    return names;
  }

  /**
   * The rows of some open cells of the expression matrix one gene payload
   * path reads (`getGeneValues`): each cell's non-zero genes, by position in
   * that matrix's gene list, and their values.
   *
   * @param {string} path - A gene payload path of the matrix
   * @param {ArrayLike<number>} cells - Open cell positions
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Array<{genes: Int32Array, values: Float32Array}>>}
   */
  async getMatrixRowsOf(path, cells, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const route = await this._geneRoute(path, generation);
    const rows = await this._loader.getMatrixRows(route.element, cells, { signal });
    this._assertLifecycleGeneration(generation);
    return rows;
  }

  /**
   * Columns of one `obsm` array of the open cells, row-major, as stored.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array|Float64Array>}
   */
  async getObsmColumns(key, columns, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const values = await this._loader.readObsmColumns(key, columns, { signal });
    this._assertLifecycleGeneration(generation);
    return values;
  }

  /**
   * The genes of one gene list (`var` or a mapped `var/{axis}/{names}`) that
   * one boolean column of their axis marks, by their names in that list:
   * the highly variable genes when the column is `highly_variable`. The
   * column is read now, when it is asked for; null for a file without an
   * expression matrix.
   *
   * @param {string} path
   * @param {string} column
   * @returns {Promise<string[]|null>}
   */
  async getMarkedGenes(path, column) {
    const generation = this._captureLifecycleGeneration();
    await this._settleOwnGeneNames(path, generation);
    const route = this._resolveGeneRoute(path, 'list');
    if (route === null) return null;
    const entry = axisVarColumns(this.getMappingCandidates(), route.axisRoute)
      .find(item => item.key === column);
    if (entry === undefined || !isBooleanVarDtype(entry.dtype)) {
      throw new MappingLoadError(column, 'not a true/false column of these genes');
    }
    const [names, flags] = await Promise.all([
      this._geneNames(route),
      this._loader.readVarFlags(route.varAxis, column),
    ]);
    this._assertLifecycleGeneration(generation);
    if (flags.length !== names.names.length) {
      throw new MappingLoadError(column, `has ${formatCountOf(flags.length, 'row')} for ${formatCountOf(names.names.length, 'gene')}`);
    }
    return names.names.filter((_, gene) => flags[gene] === 1);
  }

  /**
   * Resolve one gene route -- the file's own (`var`, `var/{g}`) or a mapped
   * one (`var/{axis}/{names}`, `var/{axis}/{names}/{g}`) -- to the matrix and
   * name source it reads. Null for the file's own gene list when it has no
   * expression matrix.
   *
   * @param {string} path
   * @param {'list'|'gene'} kind
   * @returns {{axisRoute: string, namesRoute: string, element: string, varAxis: string, column: string|null, gene: number|null}|null}
   * @private
   */
  _resolveGeneRoute(path, kind) {
    const candidates = this.getMappingCandidates();
    let axisRoute;
    let namesRoute;
    let gene = null;
    const mapped = parseMappingGenesPath(path);
    if (mapped !== null) {
      ({ axisRoute, namesRoute, gene } = mapped);
    } else {
      const own = kind === 'list'
        ? (path === 'var' ? {} : null)
        : /^var\/(0|[1-9][0-9]*)$/.exec(path);
      if (own === null) {
        throw new RangeError(`This file has no gene route '${path}'.`);
      }
      const defaults = candidates.defaults;
      if (defaults.expression === null) {
        if (kind === 'gene') {
          throw new Error('This AnnData file has no expression matrix; gene expression is unavailable.');
        }
        return null;
      }
      if (defaults.geneNames === null) {
        // `_settleOwnGeneNames` guesses them first: never the index instead.
        throw new Error('The gene names of this expression matrix are not guessed yet.');
      }
      axisRoute = expressionAxisRoute(candidates, defaults.expression, defaults.modality ?? null);
      namesRoute = geneNamesRoute(candidates, axisRoute, defaults.geneNames);
      gene = kind === 'gene' ? Number(own[1]) : null;
    }
    if ((kind === 'gene') !== (gene !== null)) {
      throw new RangeError(`This file has no gene route '${path}'.`);
    }
    // A modality's matrices and var axes are under its own group.
    const { scope, modality, matrix } = axisScope(candidates, axisRoute);
    const base = modality === null ? '' : `mod/${modality}/`;
    let element;
    let varAxis = modality === null ? 'X' : `mod/${modality}`;
    if (matrix === 'X') {
      if (scope.X === null) throw new RangeError('This file has no X.');
      element = `${base}X`;
    } else if (matrix === 'raw') {
      if (scope.raw === null) throw new RangeError('This file has no raw.');
      element = `${base}raw/X`;
      varAxis = modality === null ? 'raw' : `mod/${modality}/raw`;
    } else {
      const layer = scope.layers[Number(matrix.slice('layer-'.length))];
      if (layer === undefined) throw new RangeError(`This file has no layer ${axisRoute}.`);
      if (!layer.usable) {
        throw new MappingLoadError(layer.key, layer.reason, `layers['${layer.key}'] ${layer.reason}.`);
      }
      element = `${base}layers/${layer.key}`;
    }
    let column = null;
    if (namesRoute !== 'index') {
      const entry = axisVarColumns(candidates, axisRoute)[Number(namesRoute.slice('column-'.length))];
      if (entry === undefined) throw new RangeError(`This file has no var column ${namesRoute}.`);
      if (!entry.usable) {
        throw new MappingLoadError(entry.key, entry.reason, `var column '${entry.key}': ${entry.reason}.`);
      }
      column = entry.key;
    }
    return { axisRoute, namesRoute, element, varAxis, column, gene };
  }

  /**
   * The unique gene names of one axis and name source, read once and kept:
   * the var index, or one var column whose empty values take the index name.
   * Names from a column keep the var index beside them (`ids`), so a gene
   * named by its symbol is still found by its identifier.
   *
   * @param {{varAxis: 'X'|'raw', column: string|null}} route
   * @returns {Promise<{names: string[], renamed: Array<[string, string]>, filledFromIndex: number, source: string|null, ids: string[]|null}>}
   * @private
   */
  async _geneNames(route) {
    const cacheKey = JSON.stringify([route.varAxis, route.column]);
    const cached = this._geneNamesByRoute.get(cacheKey);
    if (cached !== undefined) return cached;
    const generation = this._captureLifecycleGeneration();
    const { index, values } = await this._loader.readVarNames(route.varAxis, route.column);
    this._assertLifecycleGeneration(generation);
    let unique;
    try {
      unique = makeUniqueNames(values, { index: route.column === null ? null : index });
    } catch (error) {
      const key = route.column ?? 'index';
      throw new MappingLoadError(key, error.message.replace(/\.\s*$/, ''), error.message);
    }
    const result = Object.freeze({
      names: unique.names,
      renamed: unique.renamed,
      filledFromIndex: unique.filledFromIndex,
      source: route.column,
      ids: route.column === null ? null : Object.freeze([...index]),
    });
    this._geneNamesByRoute.set(cacheKey, result);
    return result;
  }

  /**
   * Get obs field data as binary (lazy loaded)
   * @param {string} key - Field name
   * @param {{signal?: AbortSignal|null}} [options] - Ends this caller's
   *   wait; the read stops once no caller still waits for it.
   * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[], min?: number, max?: number}>}
   */
  async getObsFieldData(key, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    return this._coalesceInFlight(
      this._obsFieldDataInFlight,
      key,
      generation,
      async workSignal => {
        // Lazy load the field data.
        const fieldData = await this._getOrLoadFieldData(key, workSignal);
        this._assertLifecycleGeneration(generation);

        if (fieldData.kind === 'continuous') {
          return {
            data: fieldData.values.buffer,
            kind: 'continuous',
            min: fieldData.min,
            max: fieldData.max,
          };
        }

        // Categorical: the codes are already in their narrowed storage
        // (`_getOrLoadFieldData`); the caller owns them from here.
        const { missingValue, dtype: dtypeStr } = getCellucidCategoryStorage(fieldData.categories, key);
        const codes = fieldData.codes;
        this._deleteObsFieldDataCache(key, fieldData);
        return {
          data: codes.buffer,
          kind: 'category',
          categories: fieldData.categories,
          // The file's colours for them, for a field whose categories its
          // first load found (null for a text column's).
          palette: this._obsFieldsMetadata?.find(field => field.key === key)?.palette ?? null,
          dtype: dtypeStr,
          missingValue,
          ...(typeof fieldData.ordered === 'boolean'
            ? { ordered: fieldData.ordered }
            : {}),
        };
      },
      signal
    );
  }

  /**
   * One gene's value in every cell, by its route: `var/{g}` for the file's
   * own gene list, or `var/{axis}/{names}/{g}`. The values
   * depend only on the matrix and the gene's position on it, never on the
   * name source. Genes asked for together (a long run's next genes) reach
   * the reader as one batch (`AnnDataReaderClient.getMatrixColumn`).
   *
   * @param {string} path
   * @param {{signal?: AbortSignal|null, onPartial?: ((values: Float32Array, cells: number) => void)|null}} [options] -
   *   `signal` ends this caller's wait; the read stops once no caller still
   *   waits for it. `onPartial(values, cells)`: while the gene index of a
   *   matrix indexed in segments is built, the gene on the first `cells`
   *   open cells (a sample of them) and NaN on the rest, each time it has
   *   more (`AnnDataReader.getMatrixColumn`); each caller its own array.
   * @returns {Promise<Float32Array>}
   */
  async getGeneValues(path, { signal = null, owner = null, key = null, onPartial = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const route = await this._geneRoute(path, generation);
    const inFlightKey = JSON.stringify([route.element, route.gene]);
    // Shared by every caller of the gene: the first one's job owns the read,
    // and a job joining it later adopts it (one notification, the job's).
    const joined = this._geneExpressionInFlight.get(inFlightKey);
    const sharing = joined !== undefined && !joined.cancellation.cancelled;
    if (sharing && owner !== null) getReadActivityLog().adopt(joined.readKey, owner);
    const readKey = sharing ? joined.readKey : key ?? `gene-read-${nextGeneReadKey++}`;
    const result = this._coalesceInFlight(
      this._geneExpressionInFlight,
      inFlightKey,
      generation,
      async workSignal => {
        const column = await this._loader.getMatrixColumn(route.element, route.gene, {
          signal: workSignal,
          owner,
          key: readKey,
          // The gene on more cells as they are read, to every caller that
          // asked for it, whenever it joined.
          onPartial: (values, cells) => {
            const listeners = [...(this._geneExpressionInFlight.get(inFlightKey)?.partials ?? [])];
            listeners.forEach((listener, i) => listener(i === 0 ? values : copyLargeArray(values), cells));
          },
        });
        this._assertLifecycleGeneration(generation);
        return column;
      },
      signal
    );
    const entry = this._geneExpressionInFlight.get(inFlightKey);
    if (entry !== undefined) {
      entry.readKey ??= readKey;
      if (onPartial !== null) (entry.partials ??= new Set()).add(onPartial);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Rows of the open cells
  //
  // What an opening grown in place appends (`AnnDataFileSource.reopenCells`,
  // `app/open-cells-resize.js`), and what an analysis's first pass reads on
  // the first cells of priority order: rows `[start, end)` of the open cells
  // of a field, an embedding, a vector field or a gene, read by the reader
  // worker with `rows` (only what those cells need where the layout allows),
  // never cached here. Each is, bit for bit, the whole read's rows.
  // -------------------------------------------------------------------------

  /** `rows` checked against the open cells. @private */
  _requireRows(rows, label) {
    const n = this._loader.nObs;
    if (!Array.isArray(rows) || rows.length !== 2 || !Number.isSafeInteger(rows[0]) || !Number.isSafeInteger(rows[1]) ||
        rows[0] < 0 || rows[1] < rows[0] || rows[1] > n) {
      throw new RangeError(`${label}: rows are [start, end) within the ${formatCountOf(n, 'open cell')}; got ${JSON.stringify(rows)}.`);
    }
    return [rows[0], rows[1]];
  }

  /**
   * Rows `[start, end)` of one obs field: a continuous field's float32
   * values, or a categorical field's codes under `categories`, the
   * categories the field was loaded with (the shown field's), in their
   * storage (`getCellucidCategoryStorage`). A text or boolean column whose
   * rows hold a value outside `categories` answers `{changed: true}`: its
   * categories are found from every cell, so it is read whole again.
   *
   * @param {string} key
   * @param {[number, number]} rows
   * @param {{categories?: ReadonlyArray<string|number|boolean>|null, signal?: AbortSignal|null}} [options]
   * @returns {Promise<{kind: 'continuous', values: Float32Array}|{kind: 'category', codes: ArrayBufferView}|{changed: true}>}
   */
  async getObsFieldRows(key, rows, { categories = null, signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const [start, end] = this._requireRows(rows, `Obs field '${key}'`);
    const meta = this._obsFieldsMetadata?.find(field => field.key === key);
    if (!meta) throw new Error(`Obs field '${key}' not found`);
    const field = await this._loader.getObsField(key, { signal, rows: [start, end] });
    this._assertLifecycleGeneration(generation);
    const count = end - start;
    if (meta.kind === 'continuous') {
      const values = field.values instanceof Float32Array ? field.values : copyTypedArray(Float32Array, field.values, `Observation field '${key}'`);
      if (values.length !== count) throw new Error(`Continuous observation field '${key}' rows did not read one value per cell`);
      return { kind: 'continuous', values };
    }
    if (!Array.isArray(categories)) {
      throw new TypeError(`Rows of categorical field '${key}' are coded under the categories it was loaded with.`);
    }
    const { TypedArrayClass, missingValue } = getCellucidCategoryStorage(categories, key);
    if (!meta._needsCodeComputation) {
      if (field.dtype !== 'categorical' || field.categories.length !== categories.length ||
          field.categories.some((category, index) => category !== categories[index])) {
        throw new Error(`Categorical observation field '${key}' changed its category dictionary after it was loaded`);
      }
      if (!(field.codes instanceof TypedArrayClass) || field.codes.length !== count) {
        throw new Error(`Categorical observation field '${key}' rows must arrive as narrowed codes, one per cell`);
      }
      return { kind: 'category', codes: field.codes };
    }
    // A text or boolean column, coded as its first load coded it.
    const codeOf = new Map(categories.map((category, index) => [category, index]));
    const codes = allocateTypedArray(TypedArrayClass, count, `Observation field '${key}' codes`);
    for (let i = 0; i < count; i++) {
      const value = field.values[i];
      if (value == null) {
        codes[i] = missingValue;
        continue;
      }
      const code = codeOf.get(value);
      if (code === undefined) return { changed: true };
      codes[i] = code;
    }
    return { kind: 'category', codes };
  }

  /**
   * Rows `[start, end)` of one embedding's display coordinates, by its route
   * (`getEmbeddingPayload`), in the frame the dataset's cells are shown in
   * (`EmbeddingPayloads.embedding`), with their bounds.
   *
   * @param {string} path
   * @param {number} dimension
   * @param {[number, number]} rows
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<import('./embedding-payload.js').EmbeddingPayload>}
   */
  async getEmbeddingRows(path, dimension, rows, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const [start, end] = this._requireRows(rows, `Embedding '${path}'`);
    const route = parseMappingEmbeddingPath(path);
    const item = route === null ? undefined : this._candidates?.obsm[route.obsmIndex];
    if (item === undefined) throw new RangeError(`This dataset has no embedding '${path}'.`);
    if (route.columns.length !== dimension) {
      throw new RangeError(`Embedding payload '${path}' holds ${route.columns.length}D coordinates, not ${dimension}D.`);
    }
    const { columns } = this._resolveEmbeddingRef({ key: item.key, columns: route.columns });
    const payload = await this._loader.readEmbedding(item.key, columns, this._defaults.normalizeEmbeddings !== false, { signal, rows: [start, end] });
    this._assertLifecycleGeneration(generation);
    if (!(payload.positions instanceof Float32Array) || payload.positions.length !== (end - start) * dimension) {
      throw new Error(`Embedding '${path}' rows did not read one row per cell`);
    }
    return payload;
  }

  /**
   * Rows `[start, end)` of one vector field, by its route
   * (`getVectorPayload`), scaled as the whole field is, with their largest
   * magnitude.
   *
   * @param {string} path
   * @param {number} dimension
   * @param {[number, number]} rows
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  async getVectorRows(path, dimension, rows, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const [start, end] = this._requireRows(rows, `Vector field '${path}'`);
    const route = parseMappingVectorPath(path);
    const vectorItem = route === null ? undefined : this._candidates?.obsm[route.vectorIndex];
    const embeddingItem = route === null ? undefined : this._candidates?.obsm[route.embeddingIndex];
    if (vectorItem === undefined || embeddingItem === undefined) throw new RangeError(`This dataset has no vector route '${path}'.`);
    const embeddingRef = { key: embeddingItem.key, columns: route.embeddingColumns };
    const resolved = resolveVectorBinding(this._candidates, { key: vectorItem.key, embedding: embeddingRef });
    if (!resolved.ok || resolved.path !== path || resolved.dimension !== dimension) {
      throw new RangeError(`Cannot draw vector field '${path}' at ${dimension}D.`);
    }
    const payload = await this._loader.readVectorField(
      vectorItem.key,
      route.vectorColumns,
      { key: embeddingItem.key, columns: this._resolveEmbeddingRef(embeddingRef).columns },
      this._defaults.normalizeEmbeddings !== false,
      { signal, rows: [start, end] }
    );
    this._assertLifecycleGeneration(generation);
    if (!(payload.vectors instanceof Float32Array) || payload.vectors.length !== (end - start) * dimension) {
      throw new Error(`Vector field '${vectorItem.key}' rows did not read one vector per cell`);
    }
    return payload;
  }

  /**
   * Rows `[start, end)` of one gene, by its route (`getGeneValues`): the
   * gene on those cells only, reading what they need
   * (`AnnDataReader.getMatrixColumn`, `rows`).
   *
   * @param {string} path
   * @param {[number, number]} rows
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<Float32Array>}
   */
  async getGeneValueRows(path, rows, { signal = null, owner = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const [start, end] = this._requireRows(rows, `Gene '${path}'`);
    const route = await this._geneRoute(path, generation);
    const column = await this._loader.getMatrixColumn(route.element, route.gene, { signal, owner, rows: [start, end] });
    this._assertLifecycleGeneration(generation);
    if (!(column instanceof Float32Array) || column.length !== end - start) {
      throw new Error(`Gene '${path}' rows did not read one value per cell`);
    }
    return column;
  }

  /**
   * What reading the gene at `path` costs now, before it is read
   * (`AnnDataReader.geneReadPlan`): for a matrix stored cell by cell whose
   * gene index is not built yet, the whole-matrix read the first gene needs.
   *
   * @param {string} path - A gene route, as `getGeneValues`
   * @returns {Promise<Object|null>} Null when the loader cannot tell
   */
  async getGeneReadPlan(path) {
    const generation = this._captureLifecycleGeneration();
    if (typeof this._loader.geneReadPlan !== 'function') return null;
    const route = await this._geneRoute(path, generation);
    const plan = await this._loader.geneReadPlan(route.element);
    this._assertLifecycleGeneration(generation);
    return plan;
  }

  /**
   * One gene's non-zero entries, by its payload path (as `getGeneValues`):
   * `{length, indices: Uint32Array, values: Float32Array}`, the dense
   * column's values bit for bit, about 45 times fewer bytes for a median
   * gene. What an analysis computes from; nothing is installed in field
   * state.
   *
   * @param {string} path
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   `owner`: the job the read is for
   * @returns {Promise<{length: number, indices: Uint32Array, values: Float32Array}>}
   */
  async getGeneSparseValues(path, { signal = null, owner = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const route = await this._geneRoute(path, generation);
    // Not shared between callers: each owns (and may transfer) its arrays.
    // Callers of one task still reach the reader as one request, which reads
    // a gene once (`AnnDataReaderClient.getMatrixColumnSparse`).
    const result = await this._loader.getMatrixColumnSparse(route.element, route.gene, { signal, owner });
    this._assertLifecycleGeneration(generation);
    return result;
  }

  /** The route of one gene payload path, checked against its gene list. @private */
  async _geneRoute(path, generation) {
    await this._settleOwnGeneNames(path, generation);
    const route = this._resolveGeneRoute(path, 'gene');
    const names = await this._geneNames(route);
    this._assertLifecycleGeneration(generation);
    if (route.gene >= names.names.length) {
      throw new RangeError(`This file has no gene ${route.gene} in ${route.element}.`);
    }
    return route;
  }

  /**
   * Some genes' values in some cells (`AnnDataReader.getMatrixCellSubset`):
   * read by cell -- the cells' rows -- or by gene, whichever decodes less, so
   * an analysis of a few thousand cells reads those cells' entries instead of
   * every gene whole, and one of many cells reads the genes' entries.
   *
   * @param {ReadonlyArray<string>} paths - Gene payload paths of one matrix
   *   (`getGeneValues`), each gene once
   * @param {ArrayLike<number>} cells - Distinct cell positions
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   `owner`: the job the read is for
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
   *   Gene `g` (of `paths`) has entries `pointers[g]` to `pointers[g + 1]`,
   *   each at position `cellIndex[k]` of `cells`, ascending
   */
  async getGeneCellSubset(paths, cells, { signal = null, owner = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const { element, genes } = await this._geneRoutesOf(paths, generation, 'A cell subset');
    const subset = await this._loader.getMatrixCellSubset(element, cells, genes, { signal, owner });
    this._assertLifecycleGeneration(generation);
    return subset;
  }

  /**
   * The matrix and positions of genes of one matrix, by their payload paths
   * (`getGeneValues`), each checked against its gene list. @private
   */
  async _geneRoutesOf(paths, generation, what) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new TypeError(`${what} reads at least one gene.`);
    }
    await this._settleOwnGeneNames(paths[0], generation);
    const routes = paths.map(path => this._resolveGeneRoute(path, 'gene'));
    const element = routes[0].element;
    if (routes.some(route => route.element !== element)) {
      throw new RangeError(`${what} reads the genes of one expression matrix.`);
    }
    const names = await this._geneNames(routes[0]);
    this._assertLifecycleGeneration(generation);
    for (const route of routes) {
      if (route.gene >= names.names.length) {
        throw new RangeError(`This file has no gene ${route.gene} in ${element}.`);
      }
    }
    return { element, genes: routes.map(route => route.gene) };
  }

  /**
   * Whether this dataset's genes can be delivered to analysis workers over
   * a gene route (`gene-delivery.js`): its reader runs in a worker.
   *
   * @returns {boolean}
   */
  deliversGenes() {
    return typeof this._loader?.deliverMatrixColumnsSparse === 'function';
  }

  /**
   * Open gene route `id` in the reader: `ports`, one per analysis worker,
   * are the reader's ends of the route's channels.
   *
   * @param {string} id
   * @param {MessagePort[]} ports
   */
  openGeneRoute(id, ports) {
    return this._loader.openGeneRoute(id, ports);
  }

  /** The new port of route `id`'s worker `worker`, replaced by the pool. */
  replaceGeneRoutePort(id, worker, port, generation) {
    return this._loader.replaceGeneRoutePort(id, worker, port, generation);
  }

  /** Let route `id` go. */
  closeGeneRoute(id) {
    return this._loader.closeGeneRoute(id);
  }

  /**
   * Genes' non-zero entries, by their payload paths (one matrix), delivered
   * to the analysis workers `delivery` names (`gene-delivery.js`); what
   * arrives here is only each gene's bytes.
   *
   * @param {ReadonlyArray<string>} paths
   * @param {Object} delivery
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<{bytes: number[]}>}
   */
  async deliverGeneColumns(paths, delivery, { signal = null, owner = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const { element, genes } = await this._geneRoutesOf(paths, generation, 'A gene delivery');
    const delivered = await this._loader.deliverMatrixColumnsSparse(element, genes, delivery, { signal, owner });
    this._assertLifecycleGeneration(generation);
    return delivered;
  }

  /**
   * Some genes in some cells (`getGeneCellSubset`), each run of genes
   * delivered to the analysis worker `delivery` names.
   *
   * @param {ReadonlyArray<string>} paths
   * @param {ArrayLike<number>} cells
   * @param {Object} delivery
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<{bytes: number}>}
   */
  async deliverGeneCellSubset(paths, cells, delivery, { signal = null, owner = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const { element, genes } = await this._geneRoutesOf(paths, generation, 'A cell subset');
    const delivered = await this._loader.deliverMatrixCellSubset(element, cells, genes, delivery, { signal, owner });
    this._assertLifecycleGeneration(generation);
    return delivered;
  }

  /**
   * The latent space and categorical field an outlier route names
   * (`outliers/{obsm}/{field}`: `obsm` is the latent space's catalog
   * position, `field` the field's position in the obs field list),
   * checked. @private
   */
  _outlierRoute(path) {
    const route = parseMappingLatentPath(path);
    const item = route === null ? undefined : this._candidates?.obsm[route.obsmIndex];
    if (item === undefined) {
      throw new RangeError(`This dataset has no outlier route '${path}'.`);
    }
    const reason = latentCandidateReason(item);
    if (reason !== null) {
      throw new MappingLoadError(item.key, reason, `obsm['${item.key}'] ${reason}.`);
    }
    const field = this._obsFieldsMetadata?.[route.fieldIndex];
    if (field === undefined || field.kind !== 'category') {
      throw new RangeError(`This dataset has no categorical obs field ${route.fieldIndex}.`);
    }
    if (this._outliers === null) throw new Error('Outlier quantiles are available once the dataset is open.');
    return { item, field, width: obsmWidth(item) };
  }

  /**
   * The latent space whose outlier quantiles the file stores (written by
   * `prepare()` / `cellucid_prepare()`) for the rule this dataset applies,
   * or null.
   *
   * @returns {string|null}
   */
  getStoredOutlierLatentKey() {
    return this._outliers?.storedLatentKey ?? null;
  }

  /**
   * What getting one field's outlier quantiles costs, before anything is
   * read (`OutlierQuantileSource.describe`): read from the file, computed
   * from a latent space the reader keeps, or computed by reading the whole
   * latent space (and how many bytes that is).
   *
   * @param {string} path - The field's outlier route
   * @param {{signal?: AbortSignal|null}} [options]
   */
  async describeLatentOutlierQuantiles(path, { signal = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const { item, field, width } = this._outlierRoute(path);
    const plan = await this._outliers.describe({ latentKey: item.key, width, fieldKey: field.key, signal });
    this._assertLifecycleGeneration(generation);
    return plan;
  }

  /**
   * The outlier quantiles of one categorical obs field in one latent space,
   * by its route: the ones the file stores, else computed in the reader
   * worker (`OutlierQuantileSource`; `data/latent-outliers.js` is the rule),
   * from the field's codes: the ones the caller already holds (`codes`, a
   * field just loaded), else the field's, read again.
   *
   * @param {string} path
   * @param {{signal?: AbortSignal|null, codes?: Uint8Array|Uint16Array|Uint32Array|null}} [options]
   *   `signal` ends this caller's wait; the computation stops once no caller
   *   still waits for it.
   * @returns {Promise<Float32Array>} NaN where a cell has none.
   */
  async getLatentOutlierQuantiles(path, { signal = null, codes = null } = {}) {
    const generation = this._captureLifecycleGeneration();
    const { item, field, width } = this._outlierRoute(path);
    return this._coalesceInFlight(
      this._latentOutlierInFlight,
      path,
      generation,
      async workSignal => {
        let fieldCodes = codes;
        let nCategories = field.categories?.length ?? null;
        if (fieldCodes === null || nCategories === null) {
          const fieldData = await this.getObsFieldData(field.key, { signal: workSignal });
          this._assertLifecycleGeneration(generation);
          const { TypedArrayClass } = categoricalStorageForDtype(
            fieldData.dtype,
            `Categorical field '${field.key}'`
          );
          fieldCodes = new TypedArrayClass(fieldData.data);
          nCategories = fieldData.categories.length;
        }
        if (!isCategoricalCodes(fieldCodes) || fieldCodes.length !== this._loader.nObs) {
          throw new TypeError(`The codes of '${field.key}' must be one narrowed code per cell.`);
        }
        const quantiles = await this._outliers.quantiles({
          latentKey: item.key,
          width,
          fieldKey: field.key,
          codes: fieldCodes,
          nCategories,
          signal: workSignal,
        });
        this._assertLifecycleGeneration(generation);
        return quantiles;
      },
      signal
    );
  }

  /**
   * Get the edges of one neighbour graph, `obsp[key]`.
   *
   * Edge extraction is the most expensive read this adapter performs, so it
   * observes its caller's cancellation at every asynchronous boundary: a
   * cancelled request is released immediately and its extraction never starts,
   * leaving no partial payload and no retained working set behind.
   *
   * The graph is checked as it is extracted (finite, non-negative, zero
   * diagonal, exactly symmetric) and never repaired. Only the graph asked
   * for last is kept: it is the one the viewer shows, which holds the same
   * payload by reference, so keeping it costs nothing and a graph no longer
   * shown is not held.
   * A graph other than the default that fails its check is a
   * `MappingLoadError` naming the key, so that one choice is refused and the
   * rest stay available.
   *
   * @param {{signal?: AbortSignal|null, key?: string}} [options] - `key`
   *   defaults to the graph the file opens with (`_defaultGraphKey`); when it
   *   opens with none, the answer is null.
   * @returns {Promise<Readonly<import('./connectivity-edges.js').ConnectivityEdges>|null>}
   *   Null when `obsp` has no such key.
   */
  async getConnectivityEdges(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Connectivity edge options must be an object.');
    }
    const { key = this._defaultGraphKey(), ...rest } = options;
    const signal = getMetadataLoadSignal(
      rest,
      'Direct AnnData connectivity edges'
    );
    throwIfMetadataAborted(signal, CONNECTIVITY_EDGE_LABEL);
    if (key === null) return null;
    requireObspKey(key);
    const generation = this._captureLifecycleGeneration();
    // Check if already computed.
    if (this._connectivityCache.has(key)) {
      const cached = this._connectivityCache.get(key);
      await Promise.resolve();
      this._assertLifecycleGeneration(generation);
      throwIfMetadataAborted(signal, CONNECTIVITY_EDGE_LABEL);
      return cached;
    }

    const isDefault = key === this._defaultGraphKey();
    return waitForMetadata(
      this._coalesceInFlight(
        this._connectivityInFlight,
        key,
        generation,
        async workSignal => {
          if (this._connectivityCache.has(key)) {
            this._assertLifecycleGeneration(generation);
            return this._connectivityCache.get(key);
          }
          throwIfMetadataAborted(workSignal, CONNECTIVITY_EDGE_LABEL);

          console.log(
            `[BaseAnnDataAdapter] Loading connectivity edges of obsp['${key}']...`
          );

          // The reader extracts the edges where it holds the matrix (the
          // AnnData reader worker), so checking and walking a graph of tens of
          // millions of stored values never holds the page.
          let edges;
          try {
            edges = await this._loader.getConnectivityEdges(key, { signal: workSignal });
          } catch (error) {
            this._assertLifecycleGeneration(generation);
            if (isDefault) throw error;
            throw connectivityRefusal(key, error);
          }
          this._assertLifecycleGeneration(generation);
          throwIfMetadataAborted(workSignal, CONNECTIVITY_EDGE_LABEL);

          if (edges === null) {
            console.log(
              `[BaseAnnDataAdapter] obsp['${key}'] is absent`
            );
            this._retainConnectivity(key, null);
            return null;
          }
          if (!edges || typeof edges !== 'object' || Array.isArray(edges)) {
            throw new TypeError(
              'Connectivity loader must return an exact null absence or one edge list'
            );
          }
          console.log(
            `[BaseAnnDataAdapter] Extracted ${edges.nEdges} unique edges`
          );

          // One payload, shared by reference with the viewer that shows it
          // and the k-NN tool: keeping it here holds no second copy.
          const result = Object.freeze(edges);
          this._retainConnectivity(key, result);
          return result;
        },
        signal
      ),
      signal,
      CONNECTIVITY_EDGE_LABEL
    );
  }

  /**
   * The neighbour graph the file opens with: the one a launch named
   * (`defaults.knn`, null for none), else `obsp['connectivities']`.
   *
   * @returns {string|null}
   * @private
   */
  _defaultGraphKey() {
    return Object.hasOwn(this._defaults, 'knn') ? this._defaults.knn : DEFAULT_KNN_KEY;
  }

  /**
   * Keep one extracted graph, the one asked for last.
   *
   * @param {string} key
   * @param {Object|null} edges
   * @private
   */
  _retainConnectivity(key, edges) {
    this._connectivityCache.clear();
    this._connectivityCache.set(key, edges);
  }

  /**
   * The summary of one neighbour graph the candidate catalog lists, by its
   * position in `candidates.obsp` (its route `obsp/{p}`). The graph is
   * read and checked to count its edges; a graph that is unusable, absent or
   * fails its check is a `MappingLoadError` naming the key.
   *
   * @param {number} obspIndex
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Readonly<Object>>}
   */
  async getMappedConnectivitySummary(obspIndex, options = {}) {
    const item = this.getMappingCandidates().obsp[obspIndex];
    if (item === undefined) {
      throw new RangeError(`This file has no obsp entry ${obspIndex}.`);
    }
    if (!item.usable) {
      throw new MappingLoadError(
        item.key,
        item.reason,
        `obsp['${item.key}'] ${item.reason}.`
      );
    }
    const edges = await this.getConnectivityEdges({
      signal: options.signal ?? null,
      key: item.key,
    });
    if (edges === null) {
      throw new MappingLoadError(
        item.key,
        'not present in this file',
        `obsp['${item.key}'] is not present in this file.`
      );
    }
    return Object.freeze(validateConnectivitySummary({
      n_cells: edges.nCells,
      n_edges: edges.nEdges,
      max_neighbors: edges.maxNeighbors,
    }));
  }

  /**
   * Invalidate in-flight reads and release all computed adapter caches while
   * retaining the open loader and dataset metadata.
   */
  clearCaches() {
    this._lifecycleGeneration++;
    this._embeddingInFlight.clear();
    this._obsFieldDataInFlight.clear();
    this._vectorFieldInFlight.clear();
    this._connectivityInFlight.clear();
    this._geneExpressionInFlight.clear();
    this._geneNamesByRoute.clear();
    this._latentOutlierInFlight.clear();
    this._embeddingCache.clear();
    this._vectorFieldCache.clear();
    this._resetCoordinateCacheOwner();
    this._obsFieldDataCache.clear();
    this._obsFieldDataCacheBytes = 0n;
    this._connectivityCache.clear();
    this._embeddingInfo.clear();
    this._vectorMagnitudes.clear();
  }

  /**
   * Let go of what this adapter holds, leaving its reader open: the reader
   * read again with other cells (`AnnDataFileSource.reopenCells`) gets a new
   * adapter.
   */
  release() {
    if (this._closed) return;
    this.clearCaches();
    this._outliers?.close();
    this._closed = true;
    this._obsFieldsMetadata = null;
  }

  /**
   * Close and release resources, the reader with them.
   */
  close() {
    if (this._closed) return;
    this.release();
    this._loader.close();
  }
}
