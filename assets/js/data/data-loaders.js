// The data loaders: read the parts of one AnnData dataset -- the active one,
// or a candidate staged for selection -- under its base URL (`anndata://<id>/`)
// from the AnnData adapter that owns it
// (`anndata-provider.js`), and check them into the runtime shapes DataState
// uses: the dataset identity, the obs and var field descriptors, field
// values, cell positions, and the neighbour graph.
//
// Every part has a route under the base, named for the AnnData element it
// reads. The dataset's own parts are the base itself (its identity), `obs`
// (the obs field list), `var` (the gene list it opens with; gene `g` at
// `var/{g}`) and `obsp` (the neighbour graph it opens with); the parts a
// data mapping chooses have the routes of `data-mapping-candidates.js`
// (`obsm/...`, `vectors/...`, `obsp/{p}`, `var/{axis}/{names}`,
// `outliers/...`). The adapter answers each route
// (`BaseAnnDataAdapter.getObsFields`, `getGeneList`, ...); the loaders check
// what it answers.

import {
  CATEGORICAL_CODE_DTYPES,
  categoricalStorageForDtype,
} from './categorical-storage-contract.js';
import { StateValidator } from '../app/utils/state-validator.js';
import { requireCategoryCodesInInventory } from '../app/state/managers/category-codes.js';
import {
  validateConnectivityEdgeData,
  validateConnectivitySummary,
} from './connectivity-summary-contract.js';
import { parseMappingLatentPath } from './data-mapping-candidates.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';
import { requirePriority } from './fetch-scheduler.js';
import { onAbort } from '../formats/io/abort.js';
import {
  isAnnDataUrl,
  anndataLoadPoints,
  anndataGetObsFields,
  anndataGetGeneList,
  anndataLoadObsField,
  anndataLoadGeneValues,
  anndataLoadGeneSparse,
  anndataLoadGeneCellSubset,
  anndataDeliversGenes,
  anndataOpenGeneRoute,
  anndataReplaceGeneRoutePort,
  anndataCloseGeneRoute,
  anndataDeliverGeneColumns,
  anndataDeliverGeneCellSubset,
  anndataLinkMeasurement,
  anndataLoadMarkedGenes,
  anndataDescribeOutlierQuantiles,
  anndataLoadOutlierQuantiles,
  anndataLoadConnectivity,
  anndataGetConnectivitySummary,
  anndataGetDatasetIdentity,
  anndataGetMappingCandidates,
} from './anndata-provider.js';
import { isObjectRecord, requireExactObjectKeys, requireObjectKeys } from '../utils/exact-record.js';
import { formatCountOf } from '../utils/format-units.js';

/**
 * Require one anndata:// URL: every dataset is read by the AnnData reader.
 * @param {string} url
 * @param {string} label
 */
function requireAnnDataUrl(url, label) {
  if (!isAnnDataUrl(url)) {
    throw new TypeError(
      `${label} reads an AnnData dataset by its anndata:// URL; got ${String(url)}.`
    );
  }
}

/**
 * The exact owner of one metadata load: its candidate AnnData binding (a
 * dataset staged for selection; null reads the active one) and its signal.
 *
 * @param {unknown} options
 * @param {string} label
 * @returns {{candidateAnnDataBinding: Object|null, signal: AbortSignal|null}}
 */
function getLoadOwner(options, label) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (
      Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null
    )
  ) {
    throw new TypeError(`${label} options must be an object`);
  }
  const supported = new Set(['candidateAnnDataBinding', 'signal']);
  const unexpected = Reflect.ownKeys(options).filter(
    key => typeof key !== 'string' || !supported.has(key)
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `${label} options contain unexpected key(s): ` +
      unexpected.map(key => String(key)).join(', ')
    );
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} options.${String(key)} must be an enumerable own data field.`);
    }
  }
  const signal = getMetadataLoadSignal(
    Object.hasOwn(options, 'signal') ? { signal: options.signal } : {},
    label
  );
  const candidateAnnDataBinding = options.candidateAnnDataBinding ?? null;
  if (
    candidateAnnDataBinding !== null &&
    typeof candidateAnnDataBinding !== 'object'
  ) {
    throw new TypeError(
      `${label} candidateAnnDataBinding must be one binding or exact null.`
    );
  }
  return { candidateAnnDataBinding, signal };
}

function createAbortError() {
  const error = new Error('Loading was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Observe a promise while allowing its consumer to stop waiting on abort.
 *
 * Both settlement handlers remain attached so a late resolve/reject cannot
 * become stale application work or an unhandled rejection.
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {AbortSignal|null} signal
 * @returns {Promise<T>}
 */
function waitForAbort(promise, signal) {
  if (!signal) {
    return Promise.resolve(promise);
  }
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanup = () => {};
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };

    cleanup = onAbort(signal, abort);
    Promise.resolve(promise).then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/** The dataset base of a URL: `anndata://<id>/`. */
function baseOf(url) {
  const start = url.indexOf('://') + 3;
  return url.slice(0, url.indexOf('/', start) + 1);
}

// ============================================================================
// CELL POSITIONS
// ============================================================================

/**
 * Load one embedding's cell positions, by its route under the dataset base
 * (`obsm/{i}/{cols}`, `data-mapping-candidates.js`): display
 * coordinates, checked and normalized in the reader worker, with their
 * display transform and bounds (`EmbeddingPayload`). The caller owns the
 * returned positions.
 *
 * @param {string} url
 * @param {{candidateAnnDataBinding?: Object|null, dimension: 1|2|3, signal?: AbortSignal|null}} options
 * @returns {Promise<import('./embedding-payload.js').EmbeddingPayload>}
 */
export async function loadPointsBinary(url, options) {
  const {
    candidateAnnDataBinding = null,
    dimension,
    signal = null,
  } = requireObjectKeys(
    options ?? {},
    [],
    ['candidateAnnDataBinding', 'dimension', 'signal'],
    'Cell position loader options'
  );
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new TypeError(
      'Cell position loader requires the payload dimension: exactly 1, 2, or 3.'
    );
  }
  requireAnnDataUrl(url, 'Cell position loader');
  throwIfAborted(signal);
  // The caller's layout descriptor states the dimension; a route
  // never does. The caller's signal cancels the read in the reader worker;
  // the wait ends at once either way.
  const payload = await waitForAbort(
    anndataLoadPoints(url, dimension, { signal }, candidateAnnDataBinding),
    signal
  );
  throwIfAborted(signal);
  return payload;
}

// ============================================================================
// FIELD DESCRIPTORS
// ============================================================================

function requirePositivePointCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: n_points must be a positive safe integer`);
  }
}

/** Require one route: a non-empty relative path under the dataset base. */
function requireRoute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('://')) {
    throw new Error(`Invalid ${label}: expected a route under the dataset base`);
  }
  return value;
}

function validateCategoricalCodesDtype(dtype, fieldKey) {
  if (!CATEGORICAL_CODE_DTYPES.includes(dtype)) {
    throw new Error(
      `Unsupported categorical codes dtype "${dtype}" for field "${fieldKey}"; ` +
      `expected one of ${CATEGORICAL_CODE_DTYPES.map(name => `"${name}"`).join(', ')}.`
    );
  }
  return dtype;
}

function validateCategoricalStorage({
  categories,
  dtype,
  missingValue,
  fieldKey,
}) {
  validateCategoricalCodesDtype(dtype, fieldKey);
  if (!Array.isArray(categories)) {
    throw new Error(
      `Invalid categorical field "${fieldKey}": categories must be an array`
    );
  }

  const seen = new Set();
  for (const category of categories) {
    const type = typeof category;
    if (
      category === null ||
      (type !== 'string' && type !== 'boolean' && type !== 'number') ||
      (type === 'number' && !Number.isFinite(category))
    ) {
      throw new Error(
        `Invalid categorical field "${fieldKey}": every category must be a finite JSON scalar`
      );
    }
    if (seen.has(category)) {
      throw new Error(
        `Invalid categorical field "${fieldKey}": categories must be unique`
      );
    }
    seen.add(category);
  }

  const storage = categoricalStorageForDtype(
    dtype,
    `Categorical field "${fieldKey}"`
  );
  if (missingValue !== storage.missingValue) {
    throw new Error(
      `Invalid categorical field "${fieldKey}": ${dtype} codes require ` +
      `the exact missing sentinel ${storage.missingValue}`
    );
  }
  if (categories.length > storage.maxCategories) {
    throw new Error(
      `Invalid categorical field "${fieldKey}": ${dtype} has capacity for ` +
      `at most ${formatCountOf(storage.maxCategories, 'category', 'categories')}`
    );
  }
}

/**
 * Whether a categorical field's categories are found when it is first
 * loaded: a string or boolean column, whose distinct values (and so its code
 * width) are known only once its values are read. Its categories, codes
 * dtype and missing code are then all null; the load returns them
 * (`loadObsFieldData`).
 *
 * @param {{categories: unknown, dtype: unknown, missingValue: unknown}} storage
 * @returns {boolean}
 */
function categoriesFoundOnLoad({ categories, dtype, missingValue }) {
  return categories === null && dtype === null && missingValue === null;
}

/**
 * Adopt computed outlier quantiles into DataState's exact domain: NaN (a
 * category too small to have one) becomes exactly -1, so the hot visibility
 * loop can tell it from the valid [0, 1] interval without non-finite values.
 *
 * @param {Float32Array} quantiles
 * @param {string} fieldKey
 * @returns {Float32Array}
 */
function adoptRuntimeOutlierQuantiles(quantiles, fieldKey) {
  if (!(quantiles instanceof Float32Array)) {
    throw new TypeError(
      `Outlier quantiles for "${fieldKey}" must decode to Float32Array.`
    );
  }
  for (let index = 0; index < quantiles.length; index++) {
    const quantile = quantiles[index];
    if (Number.isNaN(quantile)) {
      quantiles[index] = -1;
      continue;
    }
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
      throw new RangeError(
        `Outlier quantile ${index} for "${fieldKey}" must be -1 or a finite value from 0 through 1.`
      );
    }
  }
  return quantiles;
}

/**
 * Validate one field's sole identity: drawable text, unique on its axis
 * (StateValidator.validateFieldKey, the rule every field inventory reader in
 * DataState applies).
 */
function validateFieldName(name, { names, label }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Invalid ${label}: field name must be a non-empty string`);
  }
  try {
    StateValidator.validateFieldKey(name);
  } catch (error) {
    throw new Error(
      `Invalid ${label}: field name ${JSON.stringify(name)} ` +
      `cannot be displayed exactly: ${error.message}`,
      { cause: error }
    );
  }
  if (names.has(name)) {
    throw new Error(`Invalid ${label}: field name "${name}" is duplicated`);
  }
  names.add(name);
  return name;
}

/**
 * Validate what making a gene list's names unique changed (`geneNames`) and
 * resolve its complete name list: the list's `fields` names, its `source`
 * the var column they came from (null for the var index).
 *
 * @param {unknown} geneNames
 * @param {string[]} names - The `fields` names, in field order.
 * @returns {{source: string|null, names: string[], filledFromIndex: number,
 *   renamed: [string, string][]}}
 */
function resolveGeneNames(geneNames, names) {
  requireExactObjectKeys(geneNames, ['source', 'filledFromIndex', 'renamed'], 'gene list geneNames');
  if (geneNames.source !== null && (typeof geneNames.source !== 'string' || geneNames.source.length === 0)) {
    throw new Error('Invalid gene list: geneNames.source must be null or a non-empty string');
  }
  if (
    !Number.isSafeInteger(geneNames.filledFromIndex) ||
    geneNames.filledFromIndex < 0 ||
    geneNames.filledFromIndex > names.length ||
    (geneNames.source === null && geneNames.filledFromIndex !== 0)
  ) {
    throw new Error(
      'Invalid gene list: geneNames.filledFromIndex must count ' +
      'genes, and be 0 for names from the var index'
    );
  }
  if (
    !Array.isArray(geneNames.renamed) ||
    geneNames.renamed.some(pair =>
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some(name => typeof name !== 'string' || name.length === 0)
    )
  ) {
    throw new Error('Invalid gene list: geneNames.renamed must list [from, to] name pairs');
  }
  return Object.freeze({
    source: geneNames.source,
    names: Object.freeze([...names]),
    filledFromIndex: geneNames.filledFromIndex,
    renamed: Object.freeze(geneNames.renamed.map(pair => Object.freeze([...pair]))),
  });
}

/** Require each field's index to be its position in the obs field list: exactly 0..N-1, each used once. */
function requireDenseFieldIndices(indices, label) {
  const sorted = [...indices].sort((left, right) => left - right);
  for (let position = 0; position < sorted.length; position++) {
    if (sorted[position] !== position) {
      throw new Error(
        `Invalid ${label}: field indices must be exactly 0..${sorted.length - 1}, each used once`
      );
    }
  }
}

function requireFieldIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: fieldIndex must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Check one gene list the adapter answers (`BaseAnnDataAdapter.getGeneList`):
 * one descriptor per gene (`{key, kind: 'continuous', path}`, gene `g` at
 * `{list}/{g}`) and what making the names unique changed.
 *
 * @param {Object} list
 * @returns {{n_points: number, geneNames: Object, fields: Object[]}}
 */
export function checkGeneList(list) {
  requireExactObjectKeys(list, ['n_points', 'fields', 'geneNames'], 'gene list');
  requirePositivePointCount(list.n_points, 'gene list');
  if (!Array.isArray(list.fields)) {
    throw new Error('Invalid gene list: fields must be an array');
  }
  const fields = [];
  const names = new Set();
  let listRoute = null;
  list.fields.forEach((field, gene) => {
    requireExactObjectKeys(field, ['key', 'kind', 'path'], 'gene');
    const key = validateFieldName(field.key, { names, label: 'gene list' });
    const path = requireRoute(field.path, `gene "${key}"`);
    const suffix = `/${gene}`;
    const route = path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
    if (field.kind !== 'continuous' || route === null || (listRoute !== null && route !== listRoute)) {
      throw new Error(`Invalid gene "${key}": expected a continuous gene at {list}/${gene}`);
    }
    listRoute = route;
    fields.push({ key, kind: 'continuous', path });
  });
  return {
    n_points: list.n_points,
    geneNames: resolveGeneNames(list.geneNames, fields.map(field => field.key)),
    fields,
  };
}

/**
 * A categorical field's palette is null, or one RGB triplet of 0..1 channels
 * per category; a field whose categories are found on load has none.
 */
function requireCategoryPalette(palette, categories, key) {
  if (palette === null) return;
  if (
    !Array.isArray(categories) ||
    !Array.isArray(palette) ||
    palette.length !== categories.length ||
    palette.some(color => (
      !Array.isArray(color) ||
      color.length !== 3 ||
      color.some(channel => !(Number.isFinite(channel) && channel >= 0 && channel <= 1))
    ))
  ) {
    throw new Error(
      `Invalid obs field "${key}": palette must be null or one RGB colour (0 to 1) per category`
    );
  }
}

/**
 * Check the obs field list the adapter answers
 * (`BaseAnnDataAdapter.getObsFields`). A continuous field is `{key, kind:
 * 'continuous', fieldIndex, outlierQuantilesPath: null}`; a categorical
 * field is `{key, kind: 'category', fieldIndex, categories, codesDtype,
 * codesMissingValue, palette, outlierQuantilesPath}`, its categories (and code
 * width) null when they are found on first load, its palette the RGB colour
 * (0..1 channels) of each category the file stores one for (Scanpy's
 * `uns['<key>_colors']`) or null, and its outlier route null when the dataset
 * opens with no latent space. Centroids are computed in the browser, never
 * listed.
 *
 * @param {Object} list
 * @returns {Object}
 */
export function checkObsFields(list) {
  requireExactObjectKeys(list, [
    'n_points',
    'outlier_min_points',
    'stored_outlier_latent_key',
    'latent_key',
    'fields',
  ], 'obs field list');
  requirePositivePointCount(list.n_points, 'obs field list');
  if (!Number.isSafeInteger(list.outlier_min_points) || list.outlier_min_points < 1) {
    throw new Error('Invalid obs field list: outlier_min_points must be a positive integer');
  }
  for (const key of ['stored_outlier_latent_key', 'latent_key']) {
    if (list[key] !== null && (typeof list[key] !== 'string' || list[key].length === 0)) {
      throw new Error(`Invalid obs field list: ${key} must be null or a non-empty string`);
    }
  }
  if (!Array.isArray(list.fields)) {
    throw new Error('Invalid obs field list: fields must be an array');
  }

  const fields = [];
  const names = new Set();
  const fieldIndices = [];
  for (const field of list.fields) {
    if (isObjectRecord(field) && field.kind === 'continuous') {
      requireExactObjectKeys(field, ['key', 'kind', 'fieldIndex', 'outlierQuantilesPath'], 'continuous obs field');
      const key = validateFieldName(field.key, { names, label: 'obs field list' });
      const fieldIndex = requireFieldIndex(field.fieldIndex, `obs field "${key}"`);
      if (field.outlierQuantilesPath !== null) {
        throw new Error(`Invalid obs field "${key}": a continuous field has no outlier quantiles`);
      }
      fieldIndices.push(fieldIndex);
      fields.push({ key, kind: 'continuous', fieldIndex, outlierQuantilesPath: null });
      continue;
    }
    requireExactObjectKeys(field, [
      'key',
      'kind',
      'fieldIndex',
      'categories',
      'codesDtype',
      'codesMissingValue',
      'palette',
      'outlierQuantilesPath',
    ], 'categorical obs field');
    if (field.kind !== 'category') {
      throw new Error('Invalid obs field list: kind must be "continuous" or "category"');
    }
    const key = validateFieldName(field.key, { names, label: 'obs field list' });
    const fieldIndex = requireFieldIndex(field.fieldIndex, `obs field "${key}"`);
    const { categories, codesDtype, codesMissingValue, palette, outlierQuantilesPath } = field;
    const storage = { categories, dtype: codesDtype, missingValue: codesMissingValue, fieldKey: key };
    if (!categoriesFoundOnLoad(storage)) validateCategoricalStorage(storage);
    requireCategoryPalette(palette, categories, key);
    // Outlier quantiles (float32) are computed in the dataset's latent
    // space, when it has one: their route names it and this field.
    if (
      outlierQuantilesPath !== null &&
      parseMappingLatentPath(outlierQuantilesPath)?.fieldIndex !== fieldIndex
    ) {
      throw new Error(`Invalid obs field "${key}": outlierQuantilesPath must be null or this field's outlier route`);
    }
    fieldIndices.push(fieldIndex);
    fields.push({
      key,
      kind: 'category',
      fieldIndex,
      categories,
      codesDtype,
      codesMissingValue,
      palette,
      outlierQuantilesPath,
    });
  }

  requireDenseFieldIndices(fieldIndices, 'obs field list');
  return {
    n_points: list.n_points,
    outlier_min_points: list.outlier_min_points,
    stored_outlier_latent_key: list.stored_outlier_latent_key,
    latent_key: list.latent_key,
    fields,
  };
}

function requireCategoricalDescriptor(field, label) {
  if (
    !isObjectRecord(field) ||
    field.kind !== 'category' ||
    typeof field.key !== 'string'
  ) {
    throw new Error(`Invalid ${label}: expected a categorical field descriptor`);
  }
}

function requireContinuousDescriptor(field, label) {
  if (
    !isObjectRecord(field) ||
    field.kind !== 'continuous' ||
    typeof field.key !== 'string'
  ) {
    throw new Error(`Invalid ${label}: expected a continuous field descriptor`);
  }
}

function requireGeneDescriptor(field, label) {
  requireContinuousDescriptor(field, label);
  if (typeof field.path !== 'string') {
    throw new Error(`Invalid ${label}: expected a gene descriptor with its route`);
  }
}

// ============================================================================
// METADATA
// ============================================================================

/**
 * Load the obs field descriptors of one dataset.
 *
 * @param {string} url - `<base>obs`
 * @param {{candidateAnnDataBinding?: Object|null, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function loadObsFields(url, options = {}) {
  const { candidateAnnDataBinding, signal } = getLoadOwner(options, 'Obs field list loader');
  requireAnnDataUrl(url, 'Obs field list loader');
  throwIfMetadataAborted(signal, 'Obs field list loading');
  const list = anndataGetObsFields(url, { signal }, candidateAnnDataBinding);
  throwIfMetadataAborted(signal, 'Obs field list loading');
  return checkObsFields(list);
}

/**
 * Load one gene (var field) descriptor list: the file's own gene list
 * (`<base>var`) or a mapped one (`<base>var/{axis}/{names}`).
 *
 * @param {string} url
 * @param {{candidateAnnDataBinding?: Object|null, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function loadGeneList(url, options = {}) {
  const { candidateAnnDataBinding, signal } = getLoadOwner(options, 'Gene list loader');
  requireAnnDataUrl(url, 'Gene list loader');
  throwIfMetadataAborted(signal, 'Gene list loading');
  const list = await anndataGetGeneList(url, { signal }, candidateAnnDataBinding);
  throwIfMetadataAborted(signal, 'Gene list loading');
  return checkGeneList(list);
}

/**
 * Load the neighbour-graph summary of one dataset (its own graph,
 * `<base>obsp`, or a mapped `obsp` entry's, `<base>obsp/{p}`), or exact
 * null when it has none.
 *
 * @param {string} url
 * @param {{candidateAnnDataBinding?: Object|null, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object|null>}
 */
export async function loadConnectivitySummary(url, options = {}) {
  const { candidateAnnDataBinding, signal } = getLoadOwner(options, 'Connectivity summary loader');
  requireAnnDataUrl(url, 'Connectivity summary loader');
  throwIfMetadataAborted(signal, 'Connectivity summary loading');
  const summary = await anndataGetConnectivitySummary(url, { signal }, candidateAnnDataBinding);
  throwIfMetadataAborted(signal, 'Connectivity summary loading');
  return validateConnectivitySummary(summary);
}

/**
 * Load the dataset identity: what the adapter states about the file.
 *
 * @param {string} baseUrl - The dataset base, `anndata://<id>/`
 * @param {{candidateAnnDataBinding?: Object|null, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function loadDatasetIdentity(baseUrl, options = {}) {
  const { candidateAnnDataBinding, signal } = getLoadOwner(options, 'Dataset identity loader');
  requireAnnDataUrl(baseUrl, 'Dataset identity loader');
  throwIfMetadataAborted(signal, 'Dataset identity loading');
  const identity = anndataGetDatasetIdentity(baseUrl, { signal }, candidateAnnDataBinding);
  throwIfMetadataAborted(signal, 'Dataset identity loading');
  return identity;
}

/**
 * Load the data-mapping candidate catalog of one dataset
 * (`<base>candidates`): what its file holds that can
 * be shown, and the choices it opens with.
 *
 * @param {string} url
 * @param {{candidateAnnDataBinding?: Object|null, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function loadMappingCandidates(url, options = {}) {
  const { candidateAnnDataBinding, signal } = getLoadOwner(options, 'Data-mapping catalog loader');
  requireAnnDataUrl(url, 'Data-mapping catalog loader');
  throwIfMetadataAborted(signal, 'Data-mapping catalog loading');
  return anndataGetMappingCandidates(url, { signal }, candidateAnnDataBinding);
}

/**
 * The embeddings metadata of one dataset identity.
 * @param {Object} identity
 * @returns {Object}
 */
export function getEmbeddingsMetadata(identity) {
  if (!identity?.embeddings) {
    throw new Error('The dataset identity has no embeddings metadata');
  }
  return identity.embeddings;
}

/**
 * Load the metadata of one dataset generation at once -- its identity, obs
 * and var field descriptors and graph summary -- and check that they describe
 * the same cells: the generation DataState adopts.
 *
 * @param {string} baseUrl - `anndata://<id>/`
 * @param {{candidateAnnDataBinding?: Object|null, expectedIdentityId: string, signal: AbortSignal}} options
 * @returns {Promise<{identity: Object, obsFields: Object, geneList: Object|null, connectivitySummary: Object|null}>}
 */
export async function loadDatasetGeneration(baseUrl, { candidateAnnDataBinding = null, expectedIdentityId, signal }) {
  requireAnnDataUrl(baseUrl, 'Dataset generation loader');
  const owner = { candidateAnnDataBinding, signal };
  const identity = await loadDatasetIdentity(baseUrl, owner);
  if (identity.id !== expectedIdentityId) {
    throw new Error(
      `The dataset opened as "${identity.id}", but "${expectedIdentityId}" was selected.`
    );
  }
  const [obsFields, geneList, connectivitySummary] = await Promise.all([
    loadObsFields(`${baseUrl}obs`, owner),
    identity.stats.n_genes > 0 ? loadGeneList(`${baseUrl}var`, owner) : null,
    identity.stats.has_connectivity
      ? loadConnectivitySummary(`${baseUrl}obsp`, owner)
      : null,
  ]);
  throwIfMetadataAborted(signal, 'Dataset generation loading');
  const nCells = identity.stats.n_cells;
  if (
    obsFields.n_points !== nCells ||
    (geneList !== null && (geneList.n_points !== nCells || geneList.fields.length !== identity.stats.n_genes)) ||
    (connectivitySummary !== null && connectivitySummary.n_cells !== nCells) ||
    (identity.stats.has_connectivity && connectivitySummary === null)
  ) {
    throw new Error(
      `The dataset's identity, fields and graph do not describe the same ${formatCountOf(nCells, 'cell')}.`
    );
  }
  return { identity, obsFields, geneList, connectivitySummary };
}

// ============================================================================
// FIELD VALUES
// ============================================================================

/**
 * Load the outlier quantiles of one categorical obs field, computed in the
 * reader worker in the latent space its descriptor's path names.
 *
 * @param {string} obsUrl - The obs field list the descriptor belongs to (`<base>obs`).
 * @param {Object} field - A categorical descriptor with an outlier path.
 * @param {{signal?: AbortSignal|null, pointCount: number, codes?: Uint8Array|Uint16Array|Uint32Array|null}} options
 *   `codes`: the field's codes when the caller holds them, so they are not
 *   read again.
 * @returns {Promise<Float32Array>} One quantile per cell.
 */
export async function loadOutlierQuantiles(obsUrl, field, { signal = null, pointCount, codes = null }) {
  requireCategoricalDescriptor(field, `obs field "${field?.key}"`);
  requireAnnDataUrl(obsUrl, 'Outlier quantile loader');
  if (field.outlierQuantilesPath === null) {
    throw new Error(`Obs field "${field.key}" has no outlier quantiles.`);
  }
  const quantiles = await anndataLoadOutlierQuantiles(
    `${baseOf(obsUrl)}${field.outlierQuantilesPath}`,
    { signal, codes }
  );
  if (!(quantiles instanceof Float32Array) || quantiles.length !== pointCount) {
    throw new Error(
      `Outlier quantiles of "${field.key}" must be one float32 per cell (${pointCount}).`
    );
  }
  return adoptRuntimeOutlierQuantiles(quantiles, field.key);
}

/**
 * What loading one categorical field's outlier quantiles costs, before
 * anything is read (`OutlierQuantileSource.describe`): `{source: 'stored'}`
 * read from the file, `{source: 'held'}` computed from a latent space the
 * reader keeps, or `{source: 'read'}` computed by reading the whole latent
 * space (its stored and value bytes).
 *
 * @param {string} obsUrl
 * @param {Object} field - A categorical descriptor with an outlier path.
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>}
 */
export async function describeOutlierQuantiles(obsUrl, field, { signal = null } = {}) {
  requireCategoricalDescriptor(field, `obs field "${field?.key}"`);
  requireAnnDataUrl(obsUrl, 'Outlier quantile loader');
  if (field.outlierQuantilesPath === null) {
    throw new Error(`Obs field "${field.key}" has no outlier quantiles.`);
  }
  return anndataDescribeOutlierQuantiles(`${baseOf(obsUrl)}${field.outlierQuantilesPath}`, { signal });
}

/**
 * Load one obs field's values: a continuous field's float32 values, or a
 * categorical field's codes (in their declared width; every runtime reader
 * resolves the missing code from the array's own storage,
 * categorical-storage-contract). A categorical field's outlier quantiles are
 * not read here: they are computed in the latent space, and only the outlier
 * filter needs them, so they load on its first use (the loader's
 * `loadOutlierQuantiles`, `createObsFieldLoader`).
 *
 * @param {string} obsUrl
 * @param {Object} field - A descriptor from `loadObsFields`
 * @param {FieldLoaderOptions} [options]
 * @returns {Promise<Object>}
 */
export async function loadObsFieldData(obsUrl, field, options = {}) {
  if (!field) throw new Error('No field metadata provided for obs field fetch.');
  const { signal = null } = options;
  requireAnnDataUrl(obsUrl, 'Obs field loader');
  throwIfAborted(signal);
  const isCategorical = field.kind === 'category';
  if (isCategorical) {
    requireCategoricalDescriptor(field, `obs field "${field.key}"`);
  } else {
    requireContinuousDescriptor(field, `obs field "${field.key}"`);
  }

  const data = await anndataLoadObsField(obsUrl, field.key, { signal });
  throwIfAborted(signal);
  const outputs = { loaded: true };

  if (!isCategorical && data.kind === 'continuous') {
    if (!(data.data instanceof ArrayBuffer)) {
      throw new Error(`Invalid continuous payload for field "${field.key}"`);
    }
    outputs.values = new Float32Array(data.data);
  } else if (isCategorical && data.kind === 'category') {
    const codesDtype = validateCategoricalCodesDtype(data.dtype, field.key);
    validateCategoricalStorage({
      categories: data.categories,
      dtype: codesDtype,
      missingValue: data.missingValue,
      fieldKey: field.key,
    });
    const foundOnLoad = categoriesFoundOnLoad({
      categories: field.categories,
      dtype: field.codesDtype,
      missingValue: field.codesMissingValue,
    });
    if (foundOnLoad) {
      // The categories this column has, found by reading it, and the colours
      // its file stores for them: the field adopts both (field/loading.js).
      const palette = data.palette ?? null;
      requireCategoryPalette(palette, data.categories, field.key);
      outputs.categories = data.categories;
      outputs.palette = palette;
    } else if (
      codesDtype !== field.codesDtype ||
      data.missingValue !== field.codesMissingValue ||
      data.categories.length !== field.categories.length ||
      data.categories.some((category, index) => category !== field.categories[index])
    ) {
      throw new Error(
        `Invalid categorical payload for field "${field.key}": ` +
        'its categories and codes must exactly match the adopted field'
      );
    }
    if (!(data.data instanceof ArrayBuffer)) {
      throw new Error(`Invalid categorical payload for field "${field.key}"`);
    }
    const { TypedArrayClass } = categoricalStorageForDtype(
      codesDtype,
      `Categorical field "${field.key}"`
    );
    const codes = new TypedArrayClass(data.data);
    // The proof is kept per array (`category-codes.js`), so colouring and
    // filtering by this field do not scan its codes again.
    requireCategoryCodesInInventory(
      codes,
      data.categories.length,
      index =>
        `Invalid categorical payload for field "${field.key}": code ${codes[index]} ` +
        `at index ${index} exceeds ${data.categories.length} declared categories`
    );
    outputs.codes = codes;
  } else {
    throw new Error(
      `Invalid field "${field.key}": its values must be of the adopted field's kind`
    );
  }

  return outputs;
}

/**
 * Load one gene's values. The genes a run asks for together are read as one
 * batch of coalesced requests by the reader; the signal cancels the read in
 * the reader worker.
 *
 * @param {string} geneListUrl - The gene list the descriptor belongs to
 * @param {Object} field - A descriptor from `loadGeneList`
 * @param {FieldLoaderOptions} [options]
 * @returns {Promise<{loaded: true, values: Float32Array}>}
 */
export async function loadVarFieldData(geneListUrl, field, options = {}) {
  if (!field) throw new Error('No field metadata provided for var field fetch.');
  const { signal = null, priority = 'normal', owner = null, key = null } = options;
  requirePriority(priority);
  requireAnnDataUrl(geneListUrl, 'Var field loader');
  requireGeneDescriptor(field, `var field "${field.key}"`);
  throwIfAborted(signal);
  const values = await anndataLoadGeneValues(
    `${baseOf(geneListUrl)}${field.path}`,
    { signal, owner, key }
  );
  throwIfAborted(signal);
  return { loaded: true, values };
}

/**
 * @typedef {{
 *   pointCount?: number|null,
 *   outlierMinPoints?: number,
 *   storedOutlierLatentKey?: string|null,
 *   signal?: AbortSignal|null,
 *   priority?: 'high'|'normal'|'bulk',
 *   owner?: string|null,
 *   key?: string|null
 * }} FieldLoaderOptions
 */

function mergeFieldLoaderOptions(baseOptions, runtimeOptions) {
  const runtimeSignal = runtimeOptions?.signal ?? null;
  if (runtimeSignal !== null && !(runtimeSignal instanceof AbortSignal)) {
    throw new TypeError('Field loader runtime signal must be an AbortSignal or null.');
  }
  const configuredSignal = baseOptions.signal ?? null;
  if (configuredSignal !== null && !(configuredSignal instanceof AbortSignal)) {
    throw new TypeError('Field loader configured signal must be an AbortSignal or null.');
  }
  const signals = [configuredSignal, runtimeSignal].filter(
    (signal, index, owners) => signal !== null && owners.indexOf(signal) === index
  );
  const signal = signals.length === 0
    ? null
    : (signals.length === 1 ? signals[0] : AbortSignal.any(signals));
  return {
    ...baseOptions,
    signal,
    priority: requirePriority(runtimeOptions?.priority ?? 'normal'),
    // The job a load is for (an analysis's), whose own notification shows it.
    owner: runtimeOptions?.owner ?? null,
    // The shared load it is, which a job joining later adopts.
    key: runtimeOptions?.key ?? null,
  };
}

/**
 * A field loader with shared options.
 * @param {string} obsUrl - `<base>obs`
 * @param {FieldLoaderOptions} [options]
 * @returns {(field: any, runtimeOptions?: Object) => Promise<any>}
 */
export function createObsFieldLoader(obsUrl, options = {}) {
  const loader = (field, runtimeOptions = {}) => loadObsFieldData(
    obsUrl,
    field,
    mergeFieldLoaderOptions(options, runtimeOptions)
  );
  /**
   * One categorical field's outlier quantiles (`loadOutlierQuantiles`).
   * `codes`: the field's codes when the caller holds them.
   */
  loader.loadOutlierQuantiles = (field, { signal = null, codes = null } = {}) => (
    loadOutlierQuantiles(obsUrl, field, {
      signal,
      pointCount: options.pointCount,
      codes,
    })
  );
  /** What loading them costs (`describeOutlierQuantiles`). */
  loader.describeOutlierQuantiles = (field, { signal = null } = {}) => (
    describeOutlierQuantiles(obsUrl, field, { signal })
  );
  /** The fewest cells a category needs to get outlier quantiles. */
  loader.outlierMinPoints = options.outlierMinPoints;
  /** The latent space the file stores outlier quantiles for, or null. */
  loader.storedOutlierLatentKey = options.storedOutlierLatentKey ?? null;
  return loader;
}

/**
 * The part of a data mapping a gene loader answers for: the expression
 * matrix its genes come from, each matrix's `log1p` and the highly variable
 * genes' column. Null for a loader of genes no mapping names.
 *
 * @typedef {{expression: string, log1p: Record<string, {base: number|null}>, highlyVariable: string|null}} VarLoaderMapping
 */

/**
 * What a gene loader answers for from one data mapping, or null when the
 * mapping names no expression matrix.
 *
 * @param {{expression: string|null, log1p: Object, highlyVariable: string|null}} mapping
 * @returns {VarLoaderMapping|null}
 */
export function varLoaderMappingOf(mapping) {
  if (mapping.expression === null) return null;
  return {
    expression: mapping.expression,
    log1p: mapping.log1p,
    highlyVariable: mapping.highlyVariable,
  };
}

function requireVarLoaderMapping(mapping) {
  if (mapping === null) return null;
  if (
    mapping === undefined ||
    typeof mapping !== 'object' ||
    Object.keys(mapping).sort().join(',') !== 'expression,highlyVariable,log1p' ||
    typeof mapping.expression !== 'string' ||
    mapping.log1p === null ||
    typeof mapping.log1p !== 'object' ||
    (mapping.highlyVariable !== null && typeof mapping.highlyVariable !== 'string')
  ) {
    throw new TypeError('A gene loader mapping is exactly {expression, log1p, highlyVariable}, or null.');
  }
  return Object.freeze({
    expression: mapping.expression,
    log1p: Object.freeze(Object.fromEntries(Object.entries(mapping.log1p).map(
      ([matrix, entry]) => [matrix, Object.freeze({ base: entry.base })]
    ))),
    highlyVariable: mapping.highlyVariable,
  });
}

/**
 * A gene loader with shared options. It also has
 * `readSparseColumn(field, {signal})`: one gene's non-zero entries
 * (`{length, indices, values}`), owned by the caller;
 * `readCellSubset(fields, cells, {signal})`: some genes in some cells, read
 * by cell or by gene, whichever costs less; the same two delivered to
 * analysis workers over a gene route instead of returned
 * (`deliverSparseColumns(fields, delivery, {signal, owner})`,
 * `deliverCellSubset(fields, cells, delivery, {signal, owner})`, with
 * `openGeneRoute`, `replaceGeneRoutePort`, `closeGeneRoute` and
 * `deliversGenes()`: `data/gene-delivery.js`); and, as the data mapping says
 * (`options.mapping`):
 *
 * - `log1p({matrix})`: `{base}` (null for e) when the data mapping says the
 *   expression matrix `matrix` (`X`, `raw`, `layer:<name>`; this loader's own
 *   when omitted) holds `log1p` values, else null;
 * - `highlyVariableGenes()`: the names, in this gene list, of the genes the
 *   mapped highly-variable column marks, or null when the mapping names
 *   none. The column is read on the first call and kept with the loader: a
 *   changed mapping makes a new loader.
 *
 * @param {string} geneListUrl - `<base>var` or `<base>var/{axis}/{names}`
 * @param {FieldLoaderOptions & {mapping?: VarLoaderMapping|null}} [options]
 * @returns {(field: any, runtimeOptions?: Object) => Promise<any>}
 */
export function createVarFieldLoader(geneListUrl, options = {}) {
  requireAnnDataUrl(geneListUrl, 'Var field loader');
  const { mapping: rawMapping = null, ...loadOptions } = options;
  const mapping = requireVarLoaderMapping(rawMapping);
  const loader = (field, runtimeOptions = {}) => loadVarFieldData(
    geneListUrl,
    field,
    mergeFieldLoaderOptions(loadOptions, runtimeOptions)
  );
  loader.log1p = ({ matrix = mapping?.expression ?? null } = {}) => {
    if (mapping === null || matrix === null) return null;
    const entry = mapping.log1p[matrix];
    return entry === undefined ? null : { base: entry.base };
  };
  let highlyVariable = null;
  loader.highlyVariableGenes = () => {
    if (mapping === null || mapping.highlyVariable === null) return Promise.resolve(null);
    highlyVariable ??= anndataLoadMarkedGenes(geneListUrl, mapping.highlyVariable).then(
      names => (names === null ? null : Object.freeze(names))
    ).catch(error => {
      highlyVariable = null;
      throw error;
    });
    return highlyVariable;
  };
  const base = baseOf(geneListUrl);
  // An analysis's reads: `owner` is the job they are for.
  loader.readSparseColumn = (field, { signal = null, owner = null } = {}) => {
    requireGeneDescriptor(field, `var field "${field.key}"`);
    return anndataLoadGeneSparse(`${base}${field.path}`, { signal, owner });
  };
  loader.readCellSubset = (fields, cells, { signal = null, owner = null } = {}) => {
    for (const field of fields) requireGeneDescriptor(field, `var field "${field.key}"`);
    return anndataLoadGeneCellSubset(fields.map(field => `${base}${field.path}`), cells, { signal, owner });
  };
  // Gene routes (`gene-delivery.js`): the genes an analysis computes in its
  // workers go from the reader worker to them, never through the page.
  loader.deliversGenes = () => anndataDeliversGenes(geneListUrl);
  loader.openGeneRoute = (id, ports) => anndataOpenGeneRoute(geneListUrl, id, ports);
  loader.replaceGeneRoutePort = (id, worker, port, generation) =>
    anndataReplaceGeneRoutePort(geneListUrl, id, worker, port, generation);
  loader.closeGeneRoute = id => anndataCloseGeneRoute(geneListUrl, id);
  loader.deliverSparseColumns = (fields, delivery, { signal = null, owner = null } = {}) => {
    for (const field of fields) requireGeneDescriptor(field, `var field "${field.key}"`);
    return anndataDeliverGeneColumns(fields.map(field => `${base}${field.path}`), delivery, { signal, owner });
  };
  loader.deliverCellSubset = (fields, cells, delivery, { signal = null, owner = null } = {}) => {
    for (const field of fields) requireGeneDescriptor(field, `var field "${field.key}"`);
    return anndataDeliverGeneCellSubset(fields.map(field => `${base}${field.path}`), cells, delivery, { signal, owner });
  };
  // The link the genes are read over, as last measured, or null (work that
  // tunes itself to the link reads it here).
  loader.linkMeasurement = () => anndataLinkMeasurement(geneListUrl);
  return loader;
}

// ============================================================================
// NEIGHBOUR GRAPH
// ============================================================================

/**
 * Load the edges of one neighbour graph (`ConnectivityEdges`,
 * `data/connectivity-edges.js`): unique undirected pairs (`source < destination`),
 * their render strengths and the k-NN adjacency, built and checked from the
 * file's `obsp` matrix in the reader worker. The page checks only the
 * payload's shape against the summary.
 *
 * @param {string} graphUrl - The graph's URL (`<base>obsp` or `<base>obsp/{p}`)
 * @param {Object} summary - Its summary (`loadConnectivitySummary`)
 * @param {{signal: AbortSignal}} options
 * @returns {Promise<import('./connectivity-edges.js').ConnectivityEdges>}
 */
export async function loadEdges(graphUrl, summary, options) {
  const signal = getMetadataLoadSignal(options, 'Connectivity edge loader');
  if (signal === null) {
    throw new TypeError('Connectivity edge loader options.signal is required');
  }
  requireAnnDataUrl(graphUrl, 'Connectivity edge loader');
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  const validated = validateConnectivitySummary(summary);
  if (validated === null) {
    throw new Error('This dataset has no neighbour graph to load.');
  }
  const edgeData = await anndataLoadConnectivity(graphUrl, { signal });
  if (edgeData === null) {
    throw new Error('The neighbour graph is absent despite its summary.');
  }
  validateConnectivityEdgeData(edgeData, validated);
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  return edgeData;
}
