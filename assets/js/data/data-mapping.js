/**
 * Data Mapping - which stored arrays Cellucid plots and reads.
 *
 * A *data mapping* names, for one dataset, the embeddings it can be shown with
 * (any number, of any mix of 1D, 2D and 3D: the *enabled* representations),
 * the default representation of each dimension, the vector fields bound to
 * those embeddings, the neighbor graph, the gene-name set, the expression
 * matrix, how each expression matrix is transformed (log1p), the highly
 * variable genes and the latent space, each named by its key in one AnnData
 * object.
 * The same JSON shape is written into session fingerprints and sent over the
 * viewer channel.
 *
 * This module mirrors `cellucid-python/src/cellucid/data_mapping.py` (and the
 * R package's equivalent) rule for rule. The rules that must agree
 * byte-for-byte across JavaScript, Python and R -- making names unique,
 * ranking best-guess embeddings, validating embedding columns, canonical
 * embedding ids, the vector-field key rule, the default expression and vector
 * bindings, the "nothing to plot" message and DataMapping validation -- are
 * pinned by the shared
 * conformance fixture `tests/fixtures/data-mapping-conformance.json`, and each
 * `DataMappingError.code` is the stable reason that fixture names.
 *
 * Everything here is a pure rule over metadata. The Python functions that
 * read an AnnData object (`describe_obsm`, `obsm_entries`,
 * `resolve_gene_names`, `mapped_var_axis`, `mapped_var_count`,
 * `mapped_expression_matrix`, `require_mapping_matches_anndata`) are not
 * mirrored here: the browser reads AnnData through its own loaders.
 *
 * Strings are compared in Unicode code-point order everywhere (see
 * `compareCodePoints`), because Python and R sort that way while JavaScript's
 * default string order compares UTF-16 code units.
 *
 * Results are plain JSON-serializable objects. The two result records
 * (`makeUniqueNames`, `resolveEmbeddingSlots`/`bestGuessEmbeddingSlots`) are
 * frozen shallowly, like the frozen Python dataclasses they mirror.
 */

import { isPlainRecord, requireExactKeys } from '../utils/exact-record.js';
import { formatCountOf } from '../utils/format-units.js';


/** The three dimension slots, in the order every mapping and identity lists them. */
export const DIMENSION_SLOTS = Object.freeze(['1d', '2d', '3d']);

/**
 * The kind every data mapping declares: Cellucid reads AnnData, and a mapping
 * names `obsm`, `obsp`, layer and `var` keys of one AnnData object.
 */
export const ANNDATA_KIND = 'anndata';

const ANNDATA_MAPPING_KEYS = Object.freeze([
  'kind',
  'embeddings',
  'knn',
  'geneNames',
  'expression',
  'log1p',
  'highlyVariable',
  'latent',
  'vectorFields',
]);
/**
 * The one key a mapping holds only for a dataset with several modalities
 * (feature spaces over the same cells): which one gene names, expression,
 * its log1p and the highly variable genes are read from. A mapping of a
 * dataset with one feature space has no `modality` key at all.
 */
export const MODALITY_KEY = 'modality';
const LOG1P_ENTRY_KEYS = Object.freeze(['base']);
const EMBEDDING_REF_KEYS = Object.freeze(['key', 'columns']);
const EMBEDDINGS_GROUP_KEYS = Object.freeze(['enabled', 'defaults']);
const VECTOR_BINDING_KEYS = Object.freeze(['key', 'embedding']);

/**
 * `X_umap_1d` .. `X_umap_3d` hold one UMAP per dimension count; they are the
 * default rule first.
 */
export const DIMENSIONAL_UMAP_KEYS = Object.freeze([
  'X_umap_1d',
  'X_umap_2d',
  'X_umap_3d',
]);

/**
 * The conventional names of one UMAP, in the order the default rule takes
 * them: Scanpy's (`sc.tl.umap()` writes `X_umap`, as does a Seurat object's
 * `umap` reduction), a SingleCellExperiment's (scater's `runUMAP()` names
 * its reducedDim `UMAP`), then a Seurat object's weighted-nearest-neighbor
 * and Azimuth reference UMAPs (`wnn.umap`, `ref.umap`). An R object's
 * reductions and reducedDims are `obsm['X_<name>']` with the name's case
 * kept (`anndata/transcode/`, `cellucid_prepare()`).
 */
export const UMAP_KEYS = Object.freeze([
  'X_umap',
  'X_UMAP',
  'X_wnn.umap',
  'X_ref.umap',
]);

/**
 * The prefix AnnData names a representation with: `obsm['X_<basis>']` is the
 * embedding (or latent space) of basis `<basis>`, as `sc.tl.umap()` writes
 * `X_umap`. A key with this prefix is never a vector field.
 */
export const EMBEDDING_KEY_PREFIX = 'X_';

const GENE_NAMES_COLUMN_PREFIX = 'column:';
const LAYER_PREFIX = 'layer:';

/**
 * The `var` column `sc.pp.highly_variable_genes` writes, the one Scanpy reads
 * as its `mask_var` when it is not told another.
 */
export const HIGHLY_VARIABLE_COLUMN = 'highly_variable';

/**
 * Best-guess tiers, in the order a name is tested against them. A name is
 * lowercased, and the first tier whose substring it contains decides its
 * rank; a name that matches none ranks 7. Tier 8 (latent spaces) is tested
 * last so that, for example, `X_umap_on_pca` is still a UMAP. The name keeps
 * its leading `x_`: every other needle matches the same names either way, and
 * stripping it would leave the `x_emb` needle unable to match `X_emb`.
 */
const BEST_GUESS_TIERS = Object.freeze([
  Object.freeze([0, Object.freeze(['umap'])]),
  Object.freeze([1, Object.freeze(['tsne', 't-sne', 't_sne'])]),
  Object.freeze([2, Object.freeze(['draw_graph', 'force'])]),
  Object.freeze([3, Object.freeze(['phate'])]),
  Object.freeze([4, Object.freeze(['pacmap', 'trimap'])]),
  Object.freeze([5, Object.freeze(['spatial'])]),
  Object.freeze([6, Object.freeze(['diffmap'])]),
  Object.freeze([8, Object.freeze(['pca', 'scvi', 'latent', 'harmony', 'x_emb'])]),
]);
const BEST_GUESS_NO_MATCH_TIER = 7;

/**
 * A mapping, column list or name set that breaks one exact rule.
 *
 * `code` is the stable machine-readable reason the conformance fixture pins;
 * the message is for people.
 */
export class DataMappingError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'DataMappingError';
    this.code = code;
  }
}

// =============================================================================
// Shared helpers
// =============================================================================

function isHighSurrogate(unit) {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Compare two strings in Unicode code-point order, the order Python and R
 * sort strings in. JavaScript's `<` and default `Array#sort` compare UTF-16
 * code units instead, which puts astral characters (U+10000 and above)
 * before U+E000..U+FFFF.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive, for use as a sort comparator
 */
export function compareCodePoints(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('compareCodePoints compares two strings.');
  }
  if (a === b) return 0;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a.charCodeAt(index) === b.charCodeAt(index)) continue;
    // A difference in the second half of a surrogate pair is a difference in
    // the code point that pair spells, so compare from the pair's start.
    const start =
      index > 0 && isHighSurrogate(a.charCodeAt(index - 1)) ? index - 1 : index;
    return a.codePointAt(start) < b.codePointAt(start) ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

function compareIntegerLists(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

function ownValue(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** A short rendering of an arbitrary value for a message. */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall through to String() for values JSON cannot render.
  }
  return String(value);
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** An exact JSON integer: a number primitive that is a safe integer. */
function isInteger(value) {
  return Number.isSafeInteger(value);
}

/**
 * Format an integer with comma thousands separators, as Python's
 * `f"{n:,}"` does.
 *
 * @param {number} value
 * @returns {string}
 */
function formatCount(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Expected an integer count, got ${describeValue(value)}.`);
  }
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return value < 0 ? `-${digits}` : digits;
}

function plural(count, singular, pluralText) {
  return count === 1 ? singular : pluralText;
}

/**
 * The namespace of one `obsm` key: a MuData modality's arrays are presented
 * as `obsm['<modality>:<key>']` (`anndata/views/mudata.js`, and the same in
 * `prepare()` and `cellucid_prepare()`), each modality's names its own; a
 * key without `:` is the dataset's own (`prefix` ''). The key rules
 * (`parseVectorFieldKey`, the default and best-guess embeddings) apply
 * within one namespace.
 *
 * @param {string} key
 * @returns {{prefix: string, local: string}} `prefix` is `'<modality>:'` or ''
 */
export function obsmNamespace(key) {
  const colon = key.indexOf(':');
  return colon > 0 && colon < key.length - 1
    ? { prefix: key.slice(0, colon + 1), local: key.slice(colon + 1) }
    : { prefix: '', local: key };
}

/**
 * The vector-field key rule, scVelo's naming convention: an `obsm` key
 * `<field>_<basis>` is the vector field `<field>` on the embedding
 * `X_<basis>` (`velocity_umap` on `X_umap`, `velocity_umap_3d` on
 * `X_umap_3d`, `T_fwd_branches` on `X_branches`), within one namespace
 * (`obsmNamespace`): a modality's `rna:velocity_umap` is the field
 * `rna:velocity` on `rna:X_umap`, never on the dataset's `X_umap`.
 *
 * - A key whose own name (after its namespace) starts with `X_` is never a
 *   vector field: AnnData names representations that way (`rna:X_umap` is a
 *   modality's UMAP).
 * - Otherwise every split of the name at one `_` into a non-empty `<field>`
 *   and a non-empty `<basis>` is tried, and the split whose `X_<basis>`, in
 *   the same namespace, is an `obsm` key of the same object wins; when
 *   several do, the longest basis wins (`velocity_umap_3d` is `velocity` on
 *   `X_umap_3d` when both `X_umap_3d` and `X_3d` exist). Matching is exact
 *   and case-sensitive.
 * - A key with no such split is an ordinary `obsm` array.
 *
 * The rule reads names only. Whether the field is drawn is the binding rule
 * (`defaultVectorBindings`), which also compares column counts.
 *
 * @param {string} key
 * @param {ReadonlySet<string>} obsmKeys - Every `obsm` key of the object.
 * @returns {{field: string, basis: string, embeddingKey: string}|null}
 *   `field` keeps the namespace (`rna:velocity`); `basis` is the name's own
 */
export function parseVectorFieldKey(key, obsmKeys) {
  if (typeof key !== 'string') return null;
  const { prefix, local } = obsmNamespace(key);
  if (local.startsWith(EMBEDDING_KEY_PREFIX)) return null;
  for (let split = local.indexOf('_'); split !== -1; split = local.indexOf('_', split + 1)) {
    // The first qualifying split from the left has the longest basis.
    if (split === 0 || split === local.length - 1) continue;
    const basis = local.slice(split + 1);
    const embeddingKey = `${prefix}${EMBEDDING_KEY_PREFIX}${basis}`;
    if (obsmKeys.has(embeddingKey)) {
      return { field: `${prefix}${local.slice(0, split)}`, basis, embeddingKey };
    }
  }
  return null;
}

/**
 * The vector fields among one object's `obsm` keys, by key, in input order
 * (see `parseVectorFieldKey`).
 *
 * @param {Iterable<string>} keys - Every `obsm` key of the object.
 * @returns {Map<string, {field: string, basis: string, embeddingKey: string}>}
 */
export function vectorFieldKeys(keys) {
  const list = Array.from(keys);
  const obsmKeys = new Set(list);
  const fields = new Map();
  for (const key of list) {
    const parsed = parseVectorFieldKey(key, obsmKeys);
    if (parsed !== null) fields.set(key, parsed);
  }
  return fields;
}

// =============================================================================
// Making names unique
// =============================================================================

function isMissingName(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  return typeof value === 'number' && Number.isNaN(value);
}

/**
 * Make one name list unique with anndata's `make_index_unique` rule.
 *
 * 1. An empty name (`null`, `undefined`, `""` or NaN) is replaced by the
 *    index value at the same position first. `index` is then required, and
 *    the value it supplies must itself be a non-empty string.
 * 2. The list is walked in order. The first occurrence of a name keeps it.
 * 3. Each later occurrence of `name` becomes `name{join}k`. `k` is a counter
 *    per original name that only counts up, and a candidate is skipped while
 *    it already exists in the filled list or has already been produced.
 *
 * A list that is already unique comes back unchanged.
 *
 * `renamed` lists `[from, to]` for every renamed position, in input order;
 * `filledFromIndex` counts the empty values replaced by their index name.
 * `filled` holds each position's name after that replacement and before
 * uniqueness, and `fromIndex` says which positions were replaced.
 *
 * @param {ReadonlyArray<unknown>} names
 * @param {{index?: ReadonlyArray<unknown>|null, join?: string}} [options]
 * @returns {Readonly<{
 *   names: string[],
 *   renamed: Array<[string, string]>,
 *   filledFromIndex: number,
 *   filled: string[],
 *   fromIndex: boolean[]
 * }>}
 */
export function makeUniqueNames(names, { index = null, join = '-' } = {}) {
  if (!Array.isArray(names)) {
    throw new TypeError('names must be an array.');
  }
  if (typeof join !== 'string' || join.length === 0) {
    throw new TypeError('join must be a non-empty string.');
  }
  if (index !== null && index !== undefined) {
    if (!Array.isArray(index)) {
      throw new TypeError('index must be an array or null.');
    }
    if (index.length !== names.length) {
      throw new RangeError(
        `index holds ${index.length} names but the name list holds ${names.length}.`
      );
    }
  } else {
    index = null;
  }

  const filled = [];
  const fromIndex = [];
  let filledFromIndex = 0;
  for (let position = 0; position < names.length; position += 1) {
    const value = names[position];
    const missing = isMissingName(value);
    fromIndex.push(missing);
    if (missing) {
      if (index === null) {
        throw new DataMappingError(
          'missing_name',
          `Name at position ${position} is empty and no index was supplied ` +
            'to take its name from.'
        );
      }
      const indexName = index[position];
      if (typeof indexName !== 'string' || indexName.length === 0) {
        throw new DataMappingError(
          'missing_index_name',
          `Name at position ${position} is empty, and its index name is not ` +
            `a non-empty string: ${describeValue(indexName)}.`
        );
      }
      filled.push(indexName);
      filledFromIndex += 1;
      continue;
    }
    if (typeof value !== 'string') {
      throw new DataMappingError(
        'name_not_string',
        `Name at position ${position} must be a string, got ${typeName(value)}.`
      );
    }
    filled.push(value);
  }

  const taken = new Set(filled);
  const seen = new Set();
  const counters = new Map();
  const result = [];
  const renamed = [];
  for (const value of filled) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
      continue;
    }
    let candidate;
    do {
      const counter = (counters.get(value) ?? 0) + 1;
      counters.set(value, counter);
      candidate = `${value}${join}${counter}`;
    } while (taken.has(candidate));
    taken.add(candidate);
    result.push(candidate);
    renamed.push([value, candidate]);
  }
  return Object.freeze({
    names: result,
    renamed,
    filledFromIndex,
    filled,
    fromIndex,
  });
}

/**
 * Return the one-line note that reports what making names unique changed, or
 * null when nothing changed.
 *
 * `source` is the `var` column the names came from, or null for the var
 * index (which cannot take names from itself). The text is pinned by the
 * conformance fixture, so it quotes names with plain single quotes and never
 * escapes them.
 *
 * @param {{
 *   filledFromIndex: number,
 *   renamed: ReadonlyArray<ReadonlyArray<string>>,
 *   source: string|null
 * }} options
 * @returns {string|null}
 */
export function uniqueNamesNote({ filledFromIndex, renamed, source }) {
  const parts = [];
  if (filledFromIndex) {
    if (source === null || source === undefined) {
      throw new RangeError('The var index cannot fill names from itself.');
    }
    parts.push(
      `${formatCount(filledFromIndex)} ` +
        plural(
          filledFromIndex,
          `gene has no '${source}' value and uses its var index name.`,
          `genes have no '${source}' value and use their var index name.`
        )
    );
  }
  if (renamed.length > 0) {
    const [firstFrom, firstTo] = renamed[0];
    parts.push(
      `${formatCount(renamed.length)} ` +
        plural(
          renamed.length,
          'duplicate name was made unique',
          'duplicate names were made unique'
        ) +
        `, e.g. '${firstFrom}' → '${firstTo}'.`
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// =============================================================================
// Embedding references, columns and canonical ids
// =============================================================================

/**
 * Return the dimension a `"1d"`/`"2d"`/`"3d"` slot names.
 *
 * @param {string} slot
 * @returns {1|2|3}
 */
export function slotDimension(slot) {
  if (!DIMENSION_SLOTS.includes(slot)) {
    throw new RangeError(
      `Embedding slot must be one of ${DIMENSION_SLOTS.join(', ')}, got ${describeValue(slot)}.`
    );
  }
  return Number(slot[0]);
}

function isDimension(value) {
  return value === 1 || value === 2 || value === 3;
}

/**
 * Return the slot name of one dimension.
 *
 * @param {number} dimension
 * @returns {'1d'|'2d'|'3d'}
 */
export function dimensionSlot(dimension) {
  if (!isDimension(dimension)) {
    throw new RangeError(
      `Dimension must be exactly 1, 2, or 3, got ${describeValue(dimension)}.`
    );
  }
  return `${dimension}d`;
}

/**
 * The columns a dimension reads when none are named: `0 .. d-1`.
 *
 * @param {number} dimension
 * @returns {number[]}
 */
export function defaultColumns(dimension) {
  return Array.from({ length: Math.max(0, dimension) }, (_, column) => column);
}

/**
 * Validate the columns one embedding reads for one dimension.
 *
 * The checks run in a fixed order and the first failure is reported, so
 * every implementation reports the same reason for the same input:
 * `too_narrow` (the array has fewer than `dimension` columns),
 * `columns_not_list`, `column_count` (not exactly `dimension` entries),
 * `column_not_integer` (booleans and non-integral values are not integers),
 * `column_out_of_range` (negative or not below `width`), `column_duplicate`.
 *
 * @param {unknown} columns
 * @param {{dimension: number, width: number}} options
 * @returns {number[]} a fresh copy of the validated columns
 */
export function validateEmbeddingColumns(columns, { dimension, width }) {
  if (!isDimension(dimension)) {
    throw new RangeError(
      `dimension must be exactly 1, 2, or 3, got ${describeValue(dimension)}.`
    );
  }
  if (!isInteger(width) || width < 0) {
    throw new RangeError(
      `width must be a non-negative integer, got ${describeValue(width)}.`
    );
  }
  if (width < dimension) {
    throw new DataMappingError(
      'too_narrow',
      `A ${dimension}D embedding needs at least ${formatCountOf(dimension, 'column')}; ` +
        `this array has ${width}.`
    );
  }
  if (!Array.isArray(columns)) {
    throw new DataMappingError('columns_not_list', 'Embedding columns must be a list.');
  }
  if (columns.length !== dimension) {
    throw new DataMappingError(
      'column_count',
      `A ${dimension}D embedding reads exactly ${formatCountOf(dimension, 'column')}; got ${columns.length}.`
    );
  }
  const resolved = [];
  for (const column of columns) {
    if (!isInteger(column)) {
      throw new DataMappingError(
        'column_not_integer',
        `Embedding column ${describeValue(column)} must be an integer.`
      );
    }
    if (column < 0 || column >= width) {
      throw new DataMappingError(
        'column_out_of_range',
        `Embedding column ${column} does not exist; the array has columns ` +
          `0 to ${width - 1}.`
      );
    }
    resolved.push(column);
  }
  if (new Set(resolved).size !== resolved.length) {
    throw new DataMappingError('column_duplicate', 'Each axis needs a different column.');
  }
  return resolved;
}

/**
 * Return the id one embedding reference is known by.
 *
 * An `obsm` array is known by its key when it is read whole -- its width
 * equals the number of columns and they are `0 .. d-1` in order -- and
 * otherwise by `key[c0,c1]`. Because `(key, columns)` is unique, so is the id.
 *
 * @param {string} key
 * @param {ReadonlyArray<number>} columns
 * @param {{width?: number|null}} [options]
 * @returns {string}
 */
export function canonicalEmbeddingId(key, columns, { width = null } = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Embedding key must be a non-empty string.');
  }
  if (columns === null || columns === undefined) {
    throw new TypeError('Embedding columns must be a list.');
  }
  const resolved = Array.from(columns);
  if (
    width !== null &&
    width !== undefined &&
    width === resolved.length &&
    resolved.every((column, position) => column === position)
  ) {
    return key;
  }
  return `${key}[${resolved.map(column => String(column)).join(',')}]`;
}

// =============================================================================
// Validation of the DataMapping JSON
// =============================================================================

// A record check reports with the mapping's own error codes.
function mappingRecordFailure(message, { reason }) {
  return new DataMappingError(reason === 'type' ? 'not_object' : 'keys', message);
}

function requireMappingKeys(value, expected, label) {
  return requireExactKeys(value, expected, label, mappingRecordFailure);
}

function requireMappingString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DataMappingError('not_string', `${label} must be a non-empty string.`);
  }
  return value;
}

function optionalMappingString(value, label) {
  if (value === null) return null;
  return requireMappingString(value, label);
}

/**
 * Validate one `{key, columns}` reference and return a canonical copy.
 *
 * A reference names an `obsm` key and lists its 0-based columns.
 *
 * @param {unknown} value
 * @param {{dimension?: number|null, label: string}} options
 * @returns {{key: string, columns: number[]}}
 */
export function validateEmbeddingRef(value, { dimension = null, label }) {
  const ref = requireMappingKeys(value, EMBEDDING_REF_KEYS, label);
  const key = requireMappingString(ref.key, `${label}.key`);
  const columns = ref.columns;
  if (!Array.isArray(columns)) {
    throw new DataMappingError('columns_not_list', `${label}.columns must be a list.`);
  }
  if (dimension !== null && dimension !== undefined && columns.length !== dimension) {
    throw new DataMappingError(
      'column_count',
      `${label}.columns must list exactly ${formatCountOf(dimension, 'column')}.`
    );
  }
  if (columns.length < 1 || columns.length > 3) {
    throw new DataMappingError('column_count', `${label}.columns must list 1 to 3 columns.`);
  }
  for (const column of columns) {
    if (!isInteger(column) || column < 0) {
      throw new DataMappingError(
        'column_not_integer',
        `${label}.columns must hold non-negative integers.`
      );
    }
  }
  if (new Set(columns).size !== columns.length) {
    throw new DataMappingError(
      'column_duplicate',
      `${label}: each axis needs a different column.`
    );
  }
  return { key, columns: [...columns] };
}

function validateGeneNames(value, label) {
  if (value === 'index') return 'index';
  if (
    typeof value === 'string' &&
    value.startsWith(GENE_NAMES_COLUMN_PREFIX) &&
    value.length > GENE_NAMES_COLUMN_PREFIX.length
  ) {
    return value;
  }
  throw new DataMappingError(
    'gene_names',
    `${label} must be "index" or "column:<var column>".`
  );
}

function isExpressionMatrix(value) {
  return typeof value === 'string' && (
    value === 'X' ||
    value === 'raw' ||
    (value.startsWith(LAYER_PREFIX) && value.length > LAYER_PREFIX.length)
  );
}

function validateExpression(value, label) {
  if (value === null) return null;
  if (isExpressionMatrix(value)) {
    return value;
  }
  throw new DataMappingError(
    'expression',
    `${label} must be "X", "raw", "layer:<name>" or null.`
  );
}

/**
 * Validate the `log1p` group: for each expression matrix whose values are
 * `log1p` of counts (`X`, `raw`, `layer:<name>`), its `{base}` -- null for
 * the natural logarithm (`sc.pp.log1p`'s default), else the base, a positive
 * number other than 1. A matrix not listed holds its values as stored. The
 * result lists the matrices in code-point order.
 */
function validateLog1p(value, label) {
  if (!isPlainRecord(value)) {
    throw new DataMappingError('log1p', `${label} must be an object of expression matrices.`);
  }
  const result = {};
  for (const matrix of Object.keys(value).sort(compareCodePoints)) {
    if (!isExpressionMatrix(matrix)) {
      throw new DataMappingError(
        'log1p',
        `${label} keys must be expression matrices: "X", "raw" or "layer:<name>".`
      );
    }
    const entry = requireMappingKeys(value[matrix], LOG1P_ENTRY_KEYS, `${label}.${matrix}`);
    const base = entry.base;
    if (base !== null && !(typeof base === 'number' && Number.isFinite(base) && base > 0 && base !== 1)) {
      throw new DataMappingError(
        'log1p_base',
        `${label}.${matrix}.base must be null (base e) or a positive number other than 1.`
      );
    }
    result[matrix] = { base };
  }
  return result;
}

/**
 * Compare two vector bindings in canonical order: by the bound embedding's
 * `key`, then its `columns` (lexicographically), then the vector's `obsm` key.
 */
function compareBindings(a, b) {
  return (
    compareEmbeddingRefs(a.embedding, b.embedding) ||
    compareCodePoints(a.key, b.key)
  );
}

/**
 * The canonical order of embedding references: by `key` in code-point order,
 * then `columns` compared element by element, a shorter prefix first. Zero
 * means the same reference. The mapper also lists an unusable `obsm` array,
 * which has no columns to read (`columns: null`); such a reference sorts
 * before every selection of the same key.
 *
 * @param {{key: string, columns: number[]|null}} left
 * @param {{key: string, columns: number[]|null}} right
 * @returns {number}
 */
export function compareEmbeddingRefs(left, right) {
  return (
    compareCodePoints(left.key, right.key) ||
    (left.columns === null ? 0 : 1) - (right.columns === null ? 0 : 1) ||
    compareIntegerLists(left.columns ?? [], right.columns ?? [])
  );
}

/**
 * Validate the `embeddings` group: `{enabled: [...], defaults: {...}}`.
 *
 * `enabled` lists every representation the dataset can be shown with: at
 * least one, in canonical order (`compareEmbeddingRefs`), without repeats.
 * `defaults` names at most one enabled representation per dimension slot, and
 * at least one in all.
 */
function validateEmbeddingsGroup(value, label) {
  const group = requireMappingKeys(value, EMBEDDINGS_GROUP_KEYS, label);
  if (!Array.isArray(group.enabled)) {
    throw new DataMappingError('not_list', `${label}.enabled must be a list.`);
  }
  if (group.enabled.length === 0) {
    throw new DataMappingError(
      'no_embedding',
      `${label}.enabled must list at least one embedding.`
    );
  }
  const enabled = group.enabled.map((ref, position) => validateEmbeddingRef(ref, {
    dimension: null,
    label: `${label}.enabled[${position}]`,
  }));
  let duplicate = false;
  for (let position = 1; position < enabled.length; position += 1) {
    const order = compareEmbeddingRefs(enabled[position - 1], enabled[position]);
    if (order > 0) {
      throw new DataMappingError(
        'embedding_order',
        `${label}.enabled must be sorted by embedding key, then columns.`
      );
    }
    if (order === 0) duplicate = true;
  }
  if (duplicate) {
    throw new DataMappingError('embedding_duplicate', `${label}.enabled repeats an embedding.`);
  }
  const slots = requireMappingKeys(group.defaults, DIMENSION_SLOTS, `${label}.defaults`);
  const defaults = {};
  for (const slot of DIMENSION_SLOTS) {
    const ref = slots[slot];
    if (ref === null) {
      defaults[slot] = null;
      continue;
    }
    const valid = validateEmbeddingRef(ref, {
      dimension: slotDimension(slot),
      label: `${label}.defaults.${slot}`,
    });
    if (!enabled.some(candidate => compareEmbeddingRefs(candidate, valid) === 0)) {
      throw new DataMappingError(
        'default_not_enabled',
        `${label}.defaults.${slot} must be one of the enabled embeddings.`
      );
    }
    defaults[slot] = valid;
  }
  if (DIMENSION_SLOTS.every(slot => defaults[slot] === null)) {
    throw new DataMappingError(
      'no_embedding',
      `${label}.defaults must name at least one default.`
    );
  }
  return { enabled, defaults };
}

/**
 * Sort vector bindings into canonical order (see `compareBindings`), in
 * place.
 *
 * @template T
 * @param {T[]} bindings
 * @returns {T[]} The same array.
 */
export function sortVectorBindings(bindings) {
  return bindings.sort(compareBindings);
}

function validateModality(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DataMappingError(
      'modality',
      `${label} must name one of the dataset's modalities; a dataset with one feature space has no modality key.`
    );
  }
  return value;
}

/**
 * Validate one DataMapping and return a canonical deep copy.
 *
 * The mapping is a closed shape: `kind` is `"anndata"`, and an unknown or
 * missing key is a mapping this version does not understand. At least one
 * embedding must be enabled and at least one default named, since a mapping
 * that plots nothing describes no session; every vector binding is bound to
 * an enabled embedding.
 *
 * `vectorFields` must already be in canonical order -- by the bound
 * embedding's `key`, then its `columns`, then the vector's `obsm` key -- and
 * must not repeat a binding.
 *
 * `log1p` names, per expression matrix that holds `log1p` values, its base
 * (`validateLog1p`); `highlyVariable` the boolean `var` column of the mapped
 * expression matrix's genes that marks the highly variable ones, or null.
 *
 * `modality` is present only for a dataset with several modalities (a
 * non-empty string naming one); `geneNames`, `expression`, `log1p` and
 * `highlyVariable` are then that modality's.
 *
 * The result is a fresh, plain, JSON-serializable object whose keys are in
 * canonical order: `kind`, `embeddings`, `knn`, `modality` (when present),
 * `geneNames`, `expression`, `log1p`, `highlyVariable`, `latent`,
 * `vectorFields`.
 *
 * @param {unknown} value
 * @param {{label?: string}} [options]
 * @returns {object}
 */
export function validateDataMapping(value, { label = 'dataMapping' } = {}) {
  if (!isPlainRecord(value)) {
    throw new DataMappingError('not_object', `${label} must be an object.`);
  }
  if (ownValue(value, 'kind') !== ANNDATA_KIND) {
    throw new DataMappingError('kind', `${label}.kind must be "${ANNDATA_KIND}".`);
  }
  const hasModality = Object.hasOwn(value, MODALITY_KEY);
  const mapping = requireMappingKeys(
    value,
    hasModality ? [...ANNDATA_MAPPING_KEYS, MODALITY_KEY] : ANNDATA_MAPPING_KEYS,
    label
  );

  const embeddings = validateEmbeddingsGroup(mapping.embeddings, `${label}.embeddings`);

  const rawBindings = mapping.vectorFields;
  if (!Array.isArray(rawBindings)) {
    throw new DataMappingError('not_list', `${label}.vectorFields must be a list.`);
  }
  const bindings = rawBindings.map((raw, position) => {
    const bindingLabel = `${label}.vectorFields[${position}]`;
    const binding = requireMappingKeys(raw, VECTOR_BINDING_KEYS, bindingLabel);
    return {
      key: requireMappingString(binding.key, `${bindingLabel}.key`),
      embedding: validateEmbeddingRef(binding.embedding, {
        dimension: null,
        label: `${bindingLabel}.embedding`,
      }),
    };
  });
  let duplicate = false;
  for (let position = 1; position < bindings.length; position += 1) {
    const order = compareBindings(bindings[position - 1], bindings[position]);
    if (order > 0) {
      throw new DataMappingError(
        'vector_order',
        `${label}.vectorFields must be sorted by embedding key, embedding columns, ` +
          'then key.'
      );
    }
    if (order === 0) duplicate = true;
  }
  if (duplicate) {
    throw new DataMappingError('vector_duplicate', `${label}.vectorFields repeats a binding.`);
  }
  bindings.forEach((binding, position) => {
    if (!embeddings.enabled.some(ref => compareEmbeddingRefs(ref, binding.embedding) === 0)) {
      throw new DataMappingError(
        'vector_not_enabled',
        `${label}.vectorFields[${position}] is bound to an embedding that is not enabled.`
      );
    }
  });

  return {
    kind: ANNDATA_KIND,
    embeddings,
    knn: optionalMappingString(mapping.knn, `${label}.knn`),
    ...(hasModality ? { modality: validateModality(mapping.modality, `${label}.modality`) } : {}),
    geneNames: validateGeneNames(mapping.geneNames, `${label}.geneNames`),
    expression: validateExpression(mapping.expression, `${label}.expression`),
    log1p: validateLog1p(mapping.log1p, `${label}.log1p`),
    highlyVariable: optionalMappingString(mapping.highlyVariable, `${label}.highlyVariable`),
    latent: optionalMappingString(mapping.latent, `${label}.latent`),
    vectorFields: bindings,
  };
}

// =============================================================================
// Default resolution and the deterministic best guess
// =============================================================================

/**
 * What the embedding rules need to know about one `obsm` entry.
 *
 * `width` is the column count of a dense array (1 for a plain vector) and
 * null for anything that is not a dense array. `usable` is the listing-time
 * verdict -- dense, numeric, one row per cell, at least one column -- and
 * `reason` says why not.
 *
 * @typedef {{key: string, width: number|null, usable: boolean, reason?: string|null}} ObsmEntry
 */

/** @typedef {{key: string, columns: number[]}} SlotRef */
/** @typedef {{'1d': SlotRef|null, '2d': SlotRef|null, '3d': SlotRef|null}} EmbeddingSlots */

function emptySlots() {
  return { '1d': null, '2d': null, '3d': null };
}

/**
 * Apply the default embedding rule and return the filled slots.
 *
 * If any of `X_umap_1d`, `X_umap_2d` or `X_umap_3d` is present, those keys
 * alone fill their slots, reading columns `0 .. d-1`. Otherwise the first of
 * `UMAP_KEYS` (`X_umap`, `X_UMAP`, `X_wnn.umap`, `X_ref.umap`) whose width is
 * 1, 2 or 3 fills the slot of that width. A dataset of several modalities
 * whose own names fill no slot is given the same names in the namespace of
 * the modality it opens with (`modality`: `rna:X_umap`, `obsmNamespace`).
 * Slots without a default stay null. Presence is all this rule asks: a
 * present key that later fails its load-time check is reported, not skipped.
 *
 * @param {Iterable<ObsmEntry>} entries
 * @param {{modality?: string|null}} [options] - The modality the dataset opens with
 * @returns {EmbeddingSlots}
 */
export function defaultEmbeddingSlots(entries, { modality = null } = {}) {
  const byKey = new Map();
  for (const entry of entries) byKey.set(entry.key, entry);
  for (const prefix of modality === null ? [''] : ['', `${modality}:`]) {
    const slots = emptySlots();
    const dimensional = DIMENSIONAL_UMAP_KEYS.filter(key => byKey.has(`${prefix}${key}`));
    if (dimensional.length > 0) {
      for (const key of dimensional) {
        const dimension = Number(key['X_umap_'.length]);
        slots[dimensionSlot(dimension)] = { key: `${prefix}${key}`, columns: defaultColumns(dimension) };
      }
      return slots;
    }
    const single = UMAP_KEYS.map(key => byKey.get(`${prefix}${key}`)).find(entry => entry !== undefined && isDimension(entry.width));
    if (single !== undefined) {
      slots[dimensionSlot(single.width)] = {
        key: single.key,
        columns: defaultColumns(single.width),
      };
      return slots;
    }
  }
  return emptySlots();
}

/**
 * Rank one `obsm` key for the best guess; a lower tier is a better guess.
 *
 * @param {string} key
 * @returns {number}
 */
export function bestGuessTier(key) {
  // A modality's key ranks by its own name (`rna:X_umap` is a UMAP).
  const name = obsmNamespace(key).local.toLowerCase();
  for (const [tier, needles] of BEST_GUESS_TIERS) {
    if (needles.some(needle => name.includes(needle))) return tier;
  }
  return BEST_GUESS_NO_MATCH_TIER;
}

/**
 * Order keys by tier, then namespace (`obsmNamespace`: the dataset's own
 * keys, then the modality it opens with, then the other modalities), then
 * key in code-point order: a MuData store without a UMAP of its own shows
 * its gene-expression modality's, not whichever modality sorts first.
 *
 * @param {Iterable<string>} keys
 * @param {{modality?: string|null}} [options] - The modality the dataset opens with
 * @returns {string[]}
 */
export function bestGuessOrder(keys, { modality = null } = {}) {
  const namespaceRank = key => {
    const { prefix } = obsmNamespace(key);
    if (prefix === '') return 0;
    return modality !== null && prefix === `${modality}:` ? 1 : 2;
  };
  return Array.from(keys, key => ({ key, tier: bestGuessTier(key), namespace: namespaceRank(key) }))
    .sort((a, b) => a.tier - b.tier || a.namespace - b.namespace || compareCodePoints(a.key, b.key))
    .map(({ key }) => key);
}

/**
 * @callback LoadCheck
 * @param {string} key
 * @param {number[]} columns
 * @returns {string|null|undefined} null when the array loads, else the reason
 */

/**
 * @typedef {Readonly<{
 *   slots: EmbeddingSlots,
 *   guessed: string[],
 *   rejected: Array<[string, string]>
 * }>} EmbeddingGuess
 */

/**
 * Fill the embedding slots the default rule (or a launch) left empty.
 *
 * Candidates are the usable entries, minus vector-field keys
 * (`parseVectorFieldKey`), the latent key and the keys already in a slot.
 * For each of 3D, 2D and 1D whose slot `filled` leaves null, the slot takes
 * the best-ranked *narrow* candidate (width 1-3) whose width is exactly that
 * dimension: every width is treated alike, so `X_umap` beside a 3-column
 * `X_phate` names both. When no slot is filled at all, only the 2D slot is
 * filled, from the best-ranked *wide* candidate (width > 3) read at columns
 * `[0, 1]`. `guessed` names the slots this guess filled.
 *
 * `loadCheck(key, columns)` returns null when the array loads, or the reason
 * it does not. A candidate that fails is recorded in `rejected` and the next
 * one is tried; a key is load-checked at most once, so the guess is
 * deterministic and bounded by the candidate count.
 *
 * @param {Iterable<ObsmEntry>} entries
 * @param {{latentKey: string|null, loadCheck?: LoadCheck|null, modality?: string|null, filled?: EmbeddingSlots|null}} options
 *   `modality`: the modality a dataset of several opens with (`bestGuessOrder`);
 *   `filled`: the slots already chosen (the default rule's, a launch's), kept
 * @returns {EmbeddingGuess}
 */
export function bestGuessEmbeddingSlots(entries, { latentKey = null, loadCheck = null, modality = null, filled = null } = {}) {
  const list = Array.from(entries);
  const vectorKeys = vectorFieldKeys(list.map(entry => entry.key));
  const widthByKey = new Map();
  for (const entry of list) {
    if (
      entry.usable &&
      entry.width !== null &&
      entry.width !== undefined &&
      entry.width >= 1 &&
      !vectorKeys.has(entry.key) &&
      entry.key !== latentKey
    ) {
      widthByKey.set(entry.key, entry.width);
    }
  }
  const rejected = [];
  const failed = new Set();
  const slots = emptySlots();
  for (const slot of DIMENSION_SLOTS) {
    const ref = filled?.[slot] ?? null;
    if (ref === null) continue;
    slots[slot] = { key: ref.key, columns: [...ref.columns] };
    widthByKey.delete(ref.key);
  }
  const given = new Set(DIMENSION_SLOTS.filter(slot => slots[slot] !== null));

  const tryCandidate = (key, columns) => {
    if (failed.has(key)) return false;
    const reason = loadCheck ? loadCheck(key, [...columns]) : null;
    if (reason === null || reason === undefined) return true;
    failed.add(key);
    rejected.push([key, reason]);
    return false;
  };
  const keysWhere = predicate =>
    [...widthByKey].filter(([, width]) => predicate(width)).map(([key]) => key);

  for (const dimension of [3, 2, 1]) {
    if (slots[dimensionSlot(dimension)] !== null) continue;
    for (const key of bestGuessOrder(keysWhere(width => width === dimension), { modality })) {
      const columns = defaultColumns(dimension);
      if (tryCandidate(key, columns)) {
        slots[dimensionSlot(dimension)] = { key, columns };
        break;
      }
    }
  }

  if (DIMENSION_SLOTS.every(slot => slots[slot] === null)) {
    for (const key of bestGuessOrder(keysWhere(width => width > 3), { modality })) {
      const columns = [0, 1];
      if (tryCandidate(key, columns)) {
        slots['2d'] = { key, columns };
        break;
      }
    }
  }

  const guessed = DIMENSION_SLOTS
    .filter(slot => slots[slot] !== null && !given.has(slot))
    .map(slot => `embeddings.${slot}`);
  return Object.freeze({ slots, guessed, rejected });
}

/**
 * Whether a file opens on a best guess: some slot is filled and every filled
 * slot was guessed (`resolveEmbeddingSlots`), so the file names no default
 * of its own. A file whose UMAP fills one slot and whose other widths are
 * guessed opens on its own default, the guessed slots marked as such.
 *
 * @param {Partial<EmbeddingSlots>} slots
 * @param {ReadonlyArray<string>} guessed - Groups such as `embeddings.2d`
 * @returns {boolean}
 */
export function opensOnBestGuess(slots, guessed) {
  const filled = DIMENSION_SLOTS.filter(slot => (slots[slot] ?? null) !== null);
  return filled.length > 0 && filled.every(slot => guessed.includes(`embeddings.${slot}`));
}

/**
 * Resolve the initial embedding slots: the default rule's, then the best
 * guess for every slot it left empty.
 *
 * Every width is treated alike (one ranked order, `bestGuessOrder`): the
 * default rule names the UMAP its conventional keys hold, and each other
 * width takes its best-ranked array, marked guessed. `X_umap` beside
 * `X_umap_3d` names both 2D and 3D; a file with no UMAP is guessed whole.
 *
 * @param {Iterable<ObsmEntry>} entries
 * @param {{latentKey: string|null, loadCheck?: LoadCheck|null, modality?: string|null}} options
 * @returns {EmbeddingGuess}
 */
export function resolveEmbeddingSlots(entries, { latentKey = null, loadCheck = null, modality = null } = {}) {
  const list = Array.from(entries);
  const slots = defaultEmbeddingSlots(list, { modality });
  return bestGuessEmbeddingSlots(list, { latentKey, loadCheck, modality, filled: slots });
}

/**
 * The representations an AnnData object is shown with when it opens.
 *
 * Every filled slot, plus every other usable `obsm` array that is 1 to 3
 * columns wide, read at all of its columns -- minus vector-field keys
 * (`parseVectorFieldKey`), the latent key and the `rejected` keys (arrays the
 * best guess found unloadable). A wider array is enabled only when it fills a
 * slot; the user can enable other column selections. Enabling reads nothing:
 * an array is read only when a view shows it. The result is in canonical
 * order (`compareEmbeddingRefs`).
 *
 * @param {Iterable<ObsmEntry>} entries
 * @param {Partial<EmbeddingSlots>} slots
 * @param {{latentKey: string|null, rejected?: Iterable<string>}} options
 * @returns {Array<{key: string, columns: number[]}>}
 */
export function defaultEnabledEmbeddings(entries, slots, { latentKey = null, rejected = [] } = {}) {
  const list = Array.from(entries);
  const vectorKeys = vectorFieldKeys(list.map(entry => entry.key));
  const skipped = new Set(rejected);
  const refs = [];
  const add = ref => {
    if (!refs.some(existing => compareEmbeddingRefs(existing, ref) === 0)) refs.push(ref);
  };
  for (const slot of DIMENSION_SLOTS) {
    const ref = Object.hasOwn(slots, slot) ? slots[slot] : null;
    if (ref !== null && ref !== undefined) add({ key: ref.key, columns: [...ref.columns] });
  }
  for (const entry of list) {
    if (
      entry.usable &&
      isDimension(entry.width) &&
      !vectorKeys.has(entry.key) &&
      entry.key !== latentKey &&
      !skipped.has(entry.key)
    ) {
      add({ key: entry.key, columns: defaultColumns(entry.width) });
    }
  }
  return refs.sort(compareEmbeddingRefs);
}

/**
 * Bind every vector field to the representations of its embedding.
 *
 * A vector-field key `<field>_<basis>` (`parseVectorFieldKey`) is bound to
 * every enabled representation of `X_<basis>` when both arrays are usable and
 * have the same number of columns; the vector is then read at the
 * representation's columns (`velocity_pca` over `X_pca[0,1]`). A vector
 * named for an embedding of another width, or an unusable one, stays unbound
 * and can be bound by hand. Every field of one basis is bound (`velocity_umap`
 * and `T_fwd_umap` both on `X_umap`). The result is in canonical binding
 * order.
 *
 * @param {Iterable<ObsmEntry>} entries - Every `obsm` entry of the object.
 * @param {Iterable<SlotRef>} enabled - The enabled representations.
 * @returns {Array<{key: string, embedding: {key: string, columns: number[]}}>}
 */
export function defaultVectorBindings(entries, enabled) {
  const list = Array.from(entries);
  const refs = Array.from(enabled);
  const byKey = new Map(list.map(entry => [entry.key, entry]));
  const usableWidth = key => {
    const entry = byKey.get(key);
    return entry !== undefined && entry.usable && entry.width !== null && entry.width !== undefined
      ? entry.width
      : null;
  };
  const bindings = [];
  for (const [key, { embeddingKey }] of vectorFieldKeys(list.map(entry => entry.key))) {
    const width = usableWidth(key);
    if (width === null || width !== usableWidth(embeddingKey)) continue;
    for (const ref of refs) {
      if (ref.key !== embeddingKey) continue;
      bindings.push({ key, embedding: { key: ref.key, columns: [...ref.columns] } });
    }
  }
  return sortVectorBindings(bindings);
}

/** The neighbor graph AnnData's `sc.pp.neighbors` writes, the default first. */
export const DEFAULT_GRAPH_KEY = 'connectivities';

/** The suffix Seurat's `FindNeighbors` gives its shared-nearest-neighbor graph (`<assay>_snn`). */
const SNN_GRAPH_SUFFIX = '_snn';

/** Whether a graph key names a shared-nearest-neighbor graph: `snn`, or `<assay>_snn`, in any case. */
function isSharedNeighbourGraph(key) {
  const lowered = key.toLowerCase();
  return lowered === 'snn' || (lowered.endsWith(SNN_GRAPH_SUFFIX) && key.length > SNN_GRAPH_SUFFIX.length);
}

/**
 * The neighbor graph a dataset opens with, of its `obsp` keys: Scanpy's
 * `connectivities`; else the connectivities of the MuData modality it opens
 * with (`<modality>:connectivities`, `obsmNamespace`: the graph scanpy and
 * `prepare()` write into that modality); else Seurat's shared-nearest-neighbor graph of the
 * modality (assay) it opens with (`<modality>_snn`), else the first other
 * shared-nearest-neighbor graph (`<assay>_snn`, or `SNN`, in any case) in
 * code-point order; else none. Seurat's other graph (`<assay>_nn`,
 * directed) and Scanpy's `distances` are no undirected neighbor graph and
 * are never the default. `prepare()` and `cellucid_prepare()` choose the
 * graph they write by the same rule.
 *
 * @param {Iterable<string>} keys - The `obsp` keys
 * @param {{modality?: string|null}} [options] - The modality (or Seurat's active assay) the dataset opens with
 * @returns {string|null}
 */
export function defaultGraph(keys, { modality = null } = {}) {
  const list = [...keys];
  if (list.includes(DEFAULT_GRAPH_KEY)) return DEFAULT_GRAPH_KEY;
  if (modality !== null && list.includes(`${modality}:${DEFAULT_GRAPH_KEY}`)) return `${modality}:${DEFAULT_GRAPH_KEY}`;
  if (modality !== null && list.includes(`${modality}${SNN_GRAPH_SUFFIX}`)) return `${modality}${SNN_GRAPH_SUFFIX}`;
  const shared = list.filter(isSharedNeighbourGraph).sort(compareCodePoints);
  return shared[0] ?? null;
}

/**
 * The names a gene-expression modality goes by, lower-cased: MuData's `rna`,
 * 10x's `Gene Expression`, Seurat's `RNA` and `SCT`.
 */
const GENE_EXPRESSION_MODALITIES = Object.freeze(['rna', 'gex', 'gene expression', 'gene_expression', 'sct']);

/**
 * The modality a dataset opens with, of its modalities in their stored
 * order (MuData's `mod-order`): the first whose name is a gene-expression
 * name (`rna`, `gex`, `gene expression`, `gene_expression`, `sct`, in any
 * case), else the first. Null when there are none.
 *
 * @param {ReadonlyArray<string>} names
 * @returns {string|null}
 */
export function defaultModality(names) {
  return names.find(name => GENE_EXPRESSION_MODALITIES.includes(name.toLowerCase())) ?? names[0] ?? null;
}

/**
 * Check one canonical mapping's `modality` against the modalities of the
 * dataset it is applied to: a dataset with modalities needs one named, a
 * dataset with one feature space none, and the name must be one of them.
 * The reason codes are `modality_missing`, `modality_unexpected` and
 * `modality_unknown`.
 *
 * @param {{modality?: string}} mapping
 * @param {ReadonlyArray<string>|null} modalities - The dataset's modality
 *   names, null for a dataset with one feature space
 */
export function requireMappingModality(mapping, modalities) {
  const named = Object.hasOwn(mapping, MODALITY_KEY);
  if (modalities === null) {
    if (named) {
      throw new DataMappingError(
        'modality_unexpected',
        `This mapping reads the modality '${mapping.modality}', and this dataset has one feature space.`
      );
    }
    return;
  }
  if (!named) {
    throw new DataMappingError(
      'modality_missing',
      `This dataset has several modalities (${modalities.join(', ')}); its mapping must name the one it reads.`
    );
  }
  if (!modalities.includes(mapping.modality)) {
    throw new DataMappingError(
      'modality_unknown',
      `This mapping reads the modality '${mapping.modality}', which this dataset does not have (${modalities.join(', ')}).`
    );
  }
}

/**
 * The inputs of the default expression rule (`defaultExpression`) a store
 * gives: whether it has `X` and `raw.X`, whether `raw.X` holds more genes
 * than `X` (`rawHasMoreGenes`), and whether `X` holds scaled values
 * (`xScaled`). The one place that rule is read from a store: the web
 * reader and the datasets publisher both call it, so a published default
 * opens on the matrix the viewer opens.
 *
 * `xScaled` is read only when there is a `raw` to choose (else false): `X`
 * is a dense float matrix and its first chunk (stored in one piece: its
 * first row) holds a negative value -- `sc.pp.scale` centers every gene, so
 * about half of any cell's values are negative, while counts and
 * normalized values never are, and a sparse matrix is not scaled. One small
 * read, through `read`.
 *
 * @param {Object} options
 * @param {{dense: boolean, floating: boolean, shape: ReadonlyArray<number>, chunks: ReadonlyArray<number>|null}|null} options.X
 *   `X` as stored (`chunks` null: stored in one piece), null without one
 * @param {{shape: ReadonlyArray<number>}|null} options.rawX - `raw.X`, null without one
 * @param {(region: [[number, number], [number, number]]) => Promise<ArrayLike<number>>} options.read -
 *   The values of `X` in `[[rowStart, rowEnd], [columnStart, columnEnd]]`
 * @returns {Promise<{hasX: boolean, hasRaw: boolean, rawHasMoreGenes: boolean, xScaled: boolean}>}
 */
export async function expressionRuleInputs({ X, rawX, read }) {
  const hasX = X !== null;
  const hasRaw = rawX !== null;
  if (!hasX || !hasRaw) return { hasX, hasRaw, rawHasMoreGenes: false, xScaled: false };
  const rawHasMoreGenes = rawX.shape.length === 2 && X.shape.length === 2 && rawX.shape[1] > X.shape[1];
  let xScaled = false;
  if (X.dense && X.floating && X.shape.length === 2 && X.shape[0] > 0 && X.shape[1] > 0) {
    const [nRows, nColumns] = X.shape;
    const [rows, columns] = X.chunks ?? [1, nColumns];
    const values = await read([[0, Math.min(nRows, rows)], [0, Math.min(nColumns, columns)]]);
    for (let i = 0; i < values.length && !xScaled; i++) xScaled = values[i] < 0;
  }
  return { hasX, hasRaw, rawHasMoreGenes, xScaled };
}

/**
 * Return the default expression source, whether it was guessed, and why
 * `raw` was chosen over `X` (`reason`: `raw-more-genes`, raw holds more genes
 * than X, which kept the highly variable genes; `x-scaled`, X holds scaled
 * values, negative ones from `sc.pp.scale`; null otherwise).
 *
 * Scanpy reads genes from `raw` when it is present (`use_raw=None`), for
 * the files that convention is for: `adata.raw = adata` saved the
 * log-normalized matrix of every gene before `X` was cut to the highly
 * variable genes or scaled. So `raw` is the default when it is present and
 * either holds more genes than `X` (`rawHasMoreGenes`) or `X` holds scaled
 * values (`xScaled`: a dense float `X` with negative values in its first
 * chunk); otherwise `X`. A CELLxGENE file keeps raw counts in `raw` over
 * the same genes as its normalized `X`, and opens on `X`. `X` is one choice
 * away in Data mapping either way. Without `X`: `raw` (guessed); otherwise
 * the only layer; otherwise the first layer whose name contains `norm` or
 * `log`, then the remaining layers in code-point order, with `counts` and
 * `raw_counts` last (guessed). Null when there is nothing to read.
 *
 * @param {{hasX: boolean, hasRaw: boolean, layers: ReadonlyArray<string>, rawHasMoreGenes?: boolean, xScaled?: boolean}} options
 * @returns {{expression: string|null, guessed: boolean, reason: string|null}}
 */
export function defaultExpression({ hasX, hasRaw, layers, rawHasMoreGenes = false, xScaled = false }) {
  if (hasRaw && hasX && (rawHasMoreGenes || xScaled)) {
    return { expression: 'raw', guessed: false, reason: rawHasMoreGenes ? 'raw-more-genes' : 'x-scaled' };
  }
  if (hasX) return { expression: 'X', guessed: false, reason: null };
  if (hasRaw) return { expression: 'raw', guessed: true, reason: null };
  if (layers.length === 0) return { expression: null, guessed: false, reason: null };
  if (layers.length === 1) return { expression: `${LAYER_PREFIX}${layers[0]}`, guessed: true, reason: null };

  const rank = name => {
    const lowered = name.toLowerCase();
    if (lowered.includes('norm') || lowered.includes('log')) return 0;
    if (name === 'counts' || name === 'raw_counts') return 2;
    return 1;
  };
  let best = layers[0];
  let bestRank = rank(best);
  for (const name of layers.slice(1)) {
    const nameRank = rank(name);
    if (nameRank < bestRank || (nameRank === bestRank && compareCodePoints(name, best) < 0)) {
      best = name;
      bestRank = nameRank;
    }
  }
  return { expression: `${LAYER_PREFIX}${best}`, guessed: true, reason: null };
}

/**
 * Whether one stored dtype holds integers: values a `log1p` never writes.
 *
 * @param {string|null|undefined} dtype
 * @returns {boolean}
 */
function isIntegerDtype(dtype) {
  return typeof dtype === 'string' && /^u?int(8|16|32|64)$/.test(dtype);
}

/**
 * Return the default `log1p` group and whether it was guessed, by Scanpy's
 * convention.
 *
 * `sc.pp.log1p` records itself in `uns['log1p']` (with `base`, None for e),
 * and Scanpy reads that record as saying the data it works on is `log1p`:
 * `rank_genes_groups` undoes it with that base for `X` or any layer it is
 * given. So when the file has `uns['log1p']`, `X`, `raw` and every layer are
 * `log1p` with its base, unless one is stored as integers: counts, which a
 * `log1p` never writes (`raw` of raw counts, `layers['counts']`). Without
 * `uns['log1p']` every matrix is as stored, as the file states by not
 * recording a transform. The choice is recorded as guessed when the record
 * was read as applying to matrices: it names none of them.
 *
 * A record is not taken over values that refute it (`notLog1p`, read from a
 * matrix's first stored values: undone, the log1p would give a cell a total
 * past the largest number the matrix's own type holds, so the values were
 * never log1p): that matrix is as stored, and `refuted` says which and why.
 * EBI SCEA's E-ANND-5 stores per-million values under an empty
 * `uns['log1p']`; read as log1p its fold changes were meaningless.
 *
 * @param {{
 *   log1p: {base: number|null}|null,
 *   X: {dtype: string, notLog1p?: Object|null}|null,
 *   raw: {dtype: string, notLog1p?: Object|null}|null,
 *   layers: ReadonlyArray<{key: string, dtype: string, notLog1p?: Object|null}>
 * }} options - `log1p` is `uns['log1p']` as probed; `X` and `raw` X's and
 *   raw.X's probe (its dtype, and what refutes the record in its values:
 *   null, or absent before they are read), or null without them; `layers`
 *   the usable layers' probes.
 * @returns {{log1p: Record<string, {base: number|null}>, guessed: boolean,
 *   refuted: Array<{matrix: string, value: number, dtype: string, total: number|null}>}}
 */
export function defaultLog1p({ log1p, X, raw, layers }) {
  const notCounts = matrix => matrix !== null && !isIntegerDtype(matrix.dtype);
  const named = [
    ...(notCounts(X) ? [['X', X]] : []),
    ...layers.filter(notCounts).map(layer => [`${LAYER_PREFIX}${layer.key}`, layer]),
    ...(notCounts(raw) ? [['raw', raw]] : []),
  ].sort(([a], [b]) => compareCodePoints(a, b));
  if (log1p === null) return { log1p: {}, guessed: false, refuted: [] };
  const result = {};
  const refuted = [];
  for (const [matrix, probe] of named) {
    const refutation = probe.notLog1p ?? null;
    if (refutation === null) result[matrix] = { base: log1p.base };
    else refuted.push({ matrix, value: refutation.value, dtype: refutation.dtype, total: refutation.total });
  }
  return { log1p: result, guessed: Object.keys(result).length > 0, refuted };
}

/**
 * Whether one `var` column dtype is boolean (numpy `bool`, or anndata's
 * nullable `boolean`).
 *
 * @param {string} dtype
 * @returns {boolean}
 */
export function isBooleanVarDtype(dtype) {
  return dtype === 'bool' || dtype === 'boolean';
}

/**
 * Order the boolean `var` columns that can mark highly variable genes:
 * `highly_variable` (what `sc.pp.highly_variable_genes` writes) first, then
 * names that say so (`highly_variable_*`, `hvg`, `*_hvg`), then every other
 * boolean column, each in code-point order.
 *
 * @param {ReadonlyArray<{key: string, dtype: string}>} columns
 * @returns {string[]}
 */
export function highlyVariableCandidates(columns) {
  const rank = key => {
    if (key === HIGHLY_VARIABLE_COLUMN) return 0;
    return /highly_variable|(^|_)hvgs?($|_)/i.test(key) ? 1 : 2;
  };
  return columns
    .filter(column => isBooleanVarDtype(column.dtype))
    .map(column => column.key)
    .sort((left, right) => rank(left) - rank(right) || compareCodePoints(left, right));
}

/**
 * Return the default highly-variable-genes column and whether it was guessed:
 * Scanpy's `highly_variable` on the mapped expression matrix's genes when it
 * is a boolean column there, else null.
 *
 * @param {ReadonlyArray<{key: string, dtype: string}>} columns - The var
 *   columns of the mapped expression matrix's axis (`raw.var` for `raw`).
 * @returns {{highlyVariable: string|null, guessed: boolean}}
 */
export function defaultHighlyVariable(columns) {
  const found = columns.some(
    column => column.key === HIGHLY_VARIABLE_COLUMN && isBooleanVarDtype(column.dtype)
  );
  return found
    ? { highlyVariable: HIGHLY_VARIABLE_COLUMN, guessed: true }
    : { highlyVariable: null, guessed: false };
}

// =============================================================================
// The "nothing to plot" message
// =============================================================================

/**
 * Describe one `obsm` entry the way the "nothing to plot" message lists it.
 *
 * @param {{
 *   key: string,
 *   storage: string,
 *   shape: ReadonlyArray<number>|null,
 *   defect: string|null
 * }} options
 * @returns {string}
 */
export function describeObsmEntry({ key, storage, shape, defect }) {
  let text;
  if (storage === 'dataframe') {
    text = 'table';
  } else {
    const extent =
      shape && shape.length > 0
        ? shape.map(size => formatCount(Math.trunc(size))).join(' × ')
        : '?';
    text = storage === 'csr' || storage === 'csc' ? `sparse ${extent}` : extent;
  }
  if (defect) text = `${text}, ${defect}`;
  return `${key} (${text})`;
}

/**
 * Say why one described `obsm` entry was not plotted, for the message.
 *
 * A table or a sparse array already reads as what it is, so only a dense
 * array carries a reason: its listing-time defect, the load-time defect that
 * rejected it, or the role that kept it out of the candidates.
 *
 * @param {{key: string, storage: string, usable: boolean, reason: string|null}} item
 * @param {{
 *   latentKey: string|null,
 *   rejected: Readonly<Record<string, string>>|ReadonlyMap<string, string>,
 *   vectorKeys: {has: (key: string) => boolean}
 * }} options - `vectorKeys` holds the object's vector-field keys
 *   (`vectorFieldKeys`).
 * @returns {string|null}
 */
export function obsmEntryDefect(item, { latentKey = null, rejected, vectorKeys }) {
  const key = item.key;
  if (rejected instanceof Map) {
    if (rejected.has(key)) return rejected.get(key);
  } else if (Object.hasOwn(rejected, key)) {
    return rejected[key];
  }
  if (item.storage !== 'dense') return null;
  if (!item.usable) return String(item.reason);
  if (vectorKeys.has(key)) return 'a vector field';
  if (key === latentKey) return 'the latent space';
  return null;
}

/**
 * Return the message shown when no `obsm` array can be plotted.
 *
 * @param {{nObs: number, descriptions: ReadonlyArray<string>}} options
 * @returns {string}
 */
export function nothingPlottableMessage({ nObs, descriptions }) {
  const holds = descriptions.length > 0 ? descriptions.join(', ') : 'nothing';
  return (
    'Cellucid found nothing to plot. It needs an obsm array with one row per ' +
    `cell (${formatCount(nObs)}) and at least one numeric column. obsm holds: ${holds}.` +
    ' Add a 2-D embedding to obsm (for example with sc.tl.umap in Scanpy), then open the data again.'
  );
}

/**
 * The name of an expression matrix, as Data mapping's Expression menu writes
 * it and every message, analysis, CSV and provenance names it: `X`, `raw.X`,
 * `layers['counts']`.
 *
 * @param {string|null|undefined} expression - `X`, `raw` or `layer:<name>` (null: X)
 * @returns {string}
 */
export function expressionMatrixName(expression) {
  if (expression === 'raw') return 'raw.X';
  if (typeof expression === 'string' && expression.startsWith('layer:')) return `layers['${expression.slice('layer:'.length)}']`;
  return String(expression ?? 'X');
}
