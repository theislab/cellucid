/**
 * Data Mapping - which stored arrays Cellucid plots and reads.
 *
 * A *data mapping* names, for one dataset, the embeddings it can be shown with
 * (any number, of any mix of 1D, 2D and 3D: the *enabled* representations),
 * the default representation of each dimension, the vector fields bound to
 * those embeddings, the neighbour graph, the gene-name set, the expression
 * matrix, how each expression matrix is transformed (log1p), the highly
 * variable genes and the latent space, each named by its key in one AnnData
 * object.
 * The same JSON shape is written into session fingerprints and sent over the
 * Jupyter wire.
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
 * read an AnnData object (`build_anndata_candidates`, `describe_obsm`,
 * `obsm_entries`, `resolve_gene_names`, `mapped_var_axis`, `mapped_var_count`,
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
const LOG1P_ENTRY_KEYS = Object.freeze(['base']);
const EMBEDDING_REF_KEYS = Object.freeze(['key', 'columns']);
const EMBEDDINGS_GROUP_KEYS = Object.freeze(['enabled', 'defaults']);
const VECTOR_BINDING_KEYS = Object.freeze(['key', 'embedding']);

/**
 * `sc.tl.umap()` writes `X_umap`; `X_umap_1d` .. `X_umap_3d` hold one UMAP
 * per dimension count. Both are the default rule.
 */
export const DIMENSIONAL_UMAP_KEYS = Object.freeze([
  'X_umap_1d',
  'X_umap_2d',
  'X_umap_3d',
]);
export const UNSUFFIXED_UMAP_KEY = 'X_umap';

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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
 * The vector-field key rule, scVelo's naming convention: an `obsm` key
 * `<field>_<basis>` is the vector field `<field>` on the embedding
 * `X_<basis>` (`velocity_umap` on `X_umap`, `velocity_umap_3d` on
 * `X_umap_3d`, `T_fwd_branches` on `X_branches`).
 *
 * - A key that starts with `X_` is never a vector field: AnnData names
 *   representations that way.
 * - Otherwise every split of the key at one `_` into a non-empty `<field>`
 *   and a non-empty `<basis>` is tried, and the split whose `X_<basis>` is an
 *   `obsm` key of the same object wins; when several do, the longest basis
 *   wins (`velocity_umap_3d` is `velocity` on `X_umap_3d` when both `X_umap_3d`
 *   and `X_3d` exist). Matching is exact and case-sensitive.
 * - A key with no such split is an ordinary `obsm` array.
 *
 * The rule reads names only. Whether the field is drawn is the binding rule
 * (`defaultVectorBindings`), which also compares column counts.
 *
 * @param {string} key
 * @param {ReadonlySet<string>} obsmKeys - Every `obsm` key of the object.
 * @returns {{field: string, basis: string, embeddingKey: string}|null}
 */
export function parseVectorFieldKey(key, obsmKeys) {
  if (typeof key !== 'string' || key.startsWith(EMBEDDING_KEY_PREFIX)) return null;
  for (let split = key.indexOf('_'); split !== -1; split = key.indexOf('_', split + 1)) {
    // The first qualifying split from the left has the longest basis.
    if (split === 0 || split === key.length - 1) continue;
    const basis = key.slice(split + 1);
    const embeddingKey = `${EMBEDDING_KEY_PREFIX}${basis}`;
    if (obsmKeys.has(embeddingKey)) {
      return { field: key.slice(0, split), basis, embeddingKey };
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
      `A ${dimension}D embedding needs at least ${dimension} columns; ` +
        `this array has ${width}.`
    );
  }
  if (!Array.isArray(columns)) {
    throw new DataMappingError('columns_not_list', 'Embedding columns must be a list.');
  }
  if (columns.length !== dimension) {
    throw new DataMappingError(
      'column_count',
      `A ${dimension}D embedding reads exactly ${dimension} columns; got ${columns.length}.`
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

function requireExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    throw new DataMappingError('not_object', `${label} must be an object.`);
  }
  const present = Object.keys(value);
  const missing = expected
    .filter(key => !Object.hasOwn(value, key))
    .sort(compareCodePoints);
  const unknown = present
    .filter(key => !expected.includes(key))
    .sort(compareCodePoints);
  if (missing.length > 0 || unknown.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`);
    if (unknown.length > 0) details.push(`unknown ${unknown.join(', ')}`);
    throw new DataMappingError('keys', `${label} fields: ${details.join('; ')}.`);
  }
  return value;
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
  const ref = requireExactKeys(value, EMBEDDING_REF_KEYS, label);
  const key = requireMappingString(ref.key, `${label}.key`);
  const columns = ref.columns;
  if (!Array.isArray(columns)) {
    throw new DataMappingError('columns_not_list', `${label}.columns must be a list.`);
  }
  if (dimension !== null && dimension !== undefined && columns.length !== dimension) {
    throw new DataMappingError(
      'column_count',
      `${label}.columns must list exactly ${dimension} columns.`
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
  if (!isPlainObject(value)) {
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
    const entry = requireExactKeys(value[matrix], LOG1P_ENTRY_KEYS, `${label}.${matrix}`);
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
  const group = requireExactKeys(value, EMBEDDINGS_GROUP_KEYS, label);
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
  const slots = requireExactKeys(group.defaults, DIMENSION_SLOTS, `${label}.defaults`);
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
 * The result is a fresh, plain, JSON-serializable object whose keys are in
 * canonical order: `kind`, `embeddings`, `knn`, `geneNames`, `expression`,
 * `log1p`, `highlyVariable`, `latent`, `vectorFields`.
 *
 * @param {unknown} value
 * @param {{label?: string}} [options]
 * @returns {object}
 */
export function validateDataMapping(value, { label = 'dataMapping' } = {}) {
  if (!isPlainObject(value)) {
    throw new DataMappingError('not_object', `${label} must be an object.`);
  }
  if (ownValue(value, 'kind') !== ANNDATA_KIND) {
    throw new DataMappingError('kind', `${label}.kind must be "${ANNDATA_KIND}".`);
  }
  const mapping = requireExactKeys(value, ANNDATA_MAPPING_KEYS, label);

  const embeddings = validateEmbeddingsGroup(mapping.embeddings, `${label}.embeddings`);

  const rawBindings = mapping.vectorFields;
  if (!Array.isArray(rawBindings)) {
    throw new DataMappingError('not_list', `${label}.vectorFields must be a list.`);
  }
  const bindings = rawBindings.map((raw, position) => {
    const bindingLabel = `${label}.vectorFields[${position}]`;
    const binding = requireExactKeys(raw, VECTOR_BINDING_KEYS, bindingLabel);
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
 * Apply today's default embedding rule and return the filled slots.
 *
 * If any of `X_umap_1d`, `X_umap_2d` or `X_umap_3d` is present, those keys
 * alone fill their slots, reading columns `0 .. d-1`. Otherwise a bare
 * `X_umap` whose width is 1, 2 or 3 fills the slot of that width. Slots
 * without a default stay null. Presence is all this rule asks: a present key
 * that later fails its load-time check is reported, not skipped.
 *
 * @param {Iterable<ObsmEntry>} entries
 * @returns {EmbeddingSlots}
 */
export function defaultEmbeddingSlots(entries) {
  const byKey = new Map();
  for (const entry of entries) byKey.set(entry.key, entry);
  const slots = emptySlots();
  const dimensional = DIMENSIONAL_UMAP_KEYS.filter(key => byKey.has(key));
  if (dimensional.length > 0) {
    for (const key of dimensional) {
      const dimension = Number(key['X_umap_'.length]);
      slots[dimensionSlot(dimension)] = { key, columns: defaultColumns(dimension) };
    }
    return slots;
  }
  const bare = byKey.get(UNSUFFIXED_UMAP_KEY);
  if (bare !== undefined && isDimension(bare.width)) {
    slots[dimensionSlot(bare.width)] = {
      key: UNSUFFIXED_UMAP_KEY,
      columns: defaultColumns(bare.width),
    };
  }
  return slots;
}

/**
 * Rank one `obsm` key for the best guess; a lower tier is a better guess.
 *
 * @param {string} key
 * @returns {number}
 */
export function bestGuessTier(key) {
  const name = key.toLowerCase();
  for (const [tier, needles] of BEST_GUESS_TIERS) {
    if (needles.some(needle => name.includes(needle))) return tier;
  }
  return BEST_GUESS_NO_MATCH_TIER;
}

/**
 * Order keys by (tier, key in code-point order).
 *
 * @param {Iterable<string>} keys
 * @returns {string[]}
 */
export function bestGuessOrder(keys) {
  return Array.from(keys, key => ({ key, tier: bestGuessTier(key) }))
    .sort((a, b) => a.tier - b.tier || compareCodePoints(a.key, b.key))
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
 * Fill embedding slots when the default rule filled none.
 *
 * Candidates are the usable entries, minus vector-field keys
 * (`parseVectorFieldKey`) and the latent key. For each of 3D, 2D and 1D the
 * slot takes the best-ranked *narrow* candidate (width 1-3) whose width is
 * exactly that dimension. When no narrow candidate fills any slot, only the
 * 2D slot is filled, from the best-ranked *wide* candidate (width > 3) read
 * at columns `[0, 1]`.
 *
 * `loadCheck(key, columns)` returns null when the array loads, or the reason
 * it does not. A candidate that fails is recorded in `rejected` and the next
 * one is tried; a key is load-checked at most once, so the guess is
 * deterministic and bounded by the candidate count.
 *
 * @param {Iterable<ObsmEntry>} entries
 * @param {{latentKey: string|null, loadCheck?: LoadCheck|null}} options
 * @returns {EmbeddingGuess}
 */
export function bestGuessEmbeddingSlots(entries, { latentKey = null, loadCheck = null } = {}) {
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
    for (const key of bestGuessOrder(keysWhere(width => width === dimension))) {
      const columns = defaultColumns(dimension);
      if (tryCandidate(key, columns)) {
        slots[dimensionSlot(dimension)] = { key, columns };
        break;
      }
    }
  }

  if (DIMENSION_SLOTS.every(slot => slots[slot] === null)) {
    for (const key of bestGuessOrder(keysWhere(width => width > 3))) {
      const columns = [0, 1];
      if (tryCandidate(key, columns)) {
        slots['2d'] = { key, columns };
        break;
      }
    }
  }

  const guessed = DIMENSION_SLOTS
    .filter(slot => slots[slot] !== null)
    .map(slot => `embeddings.${slot}`);
  return Object.freeze({ slots, guessed, rejected });
}

/**
 * Resolve the initial embedding slots: the default rule, else the best guess.
 *
 * When the default rule fills any slot, its slots are the answer and nothing
 * is guessed, so an object carrying `X_umap` or `X_umap_<d>d` resolves
 * exactly as it did before the best guess existed. Only when it fills none
 * does `bestGuessEmbeddingSlots` run.
 *
 * @param {Iterable<ObsmEntry>} entries
 * @param {{latentKey: string|null, loadCheck?: LoadCheck|null}} options
 * @returns {EmbeddingGuess}
 */
export function resolveEmbeddingSlots(entries, { latentKey = null, loadCheck = null } = {}) {
  const list = Array.from(entries);
  const slots = defaultEmbeddingSlots(list);
  if (DIMENSION_SLOTS.some(slot => slots[slot] !== null)) {
    return Object.freeze({ slots, guessed: [], rejected: [] });
  }
  return bestGuessEmbeddingSlots(list, { latentKey, loadCheck });
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

/**
 * Return the default expression source and whether it was guessed.
 *
 * `X` when it exists. Otherwise `raw`; otherwise the only layer; otherwise
 * the first layer whose name contains `norm` or `log`, then the remaining
 * layers in code-point order, with `counts` and `raw_counts` last. Null when
 * there is nothing to read.
 *
 * @param {{hasX: boolean, hasRaw: boolean, layers: ReadonlyArray<string>}} options
 * @returns {{expression: string|null, guessed: boolean}}
 */
export function defaultExpression({ hasX, hasRaw, layers }) {
  if (hasX) return { expression: 'X', guessed: false };
  if (hasRaw) return { expression: 'raw', guessed: true };
  if (layers.length === 0) return { expression: null, guessed: false };
  if (layers.length === 1) return { expression: `${LAYER_PREFIX}${layers[0]}`, guessed: true };

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
  return { expression: `${LAYER_PREFIX}${best}`, guessed: true };
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
 * given. So when the file has `uns['log1p']`, `X` and every layer are `log1p`
 * with its base. `raw` is what `adata.raw = adata` saved, conventionally the
 * log-normalised matrix: it is `log1p` too, unless it is stored as integers
 * (counts). Without `uns['log1p']` every matrix is as stored, as the file
 * states by not recording a transform. The choice is recorded as guessed when
 * the record was read as applying to matrices: it names none of them.
 *
 * @param {{
 *   log1p: {base: number|null}|null,
 *   hasX: boolean,
 *   raw: {dtype: string}|null,
 *   layers: ReadonlyArray<string>
 * }} options - `log1p` is `uns['log1p']` as probed; `layers` the usable
 *   layers' names; `raw` raw.X's dtype, or null without raw.
 * @returns {{log1p: Record<string, {base: number|null}>, guessed: boolean}}
 */
export function defaultLog1p({ log1p, hasX, raw, layers }) {
  const matrices = [
    ...(hasX ? ['X'] : []),
    ...layers.map(name => `${LAYER_PREFIX}${name}`),
    ...(raw !== null && !isIntegerDtype(raw.dtype) ? ['raw'] : []),
  ];
  if (log1p === null) return { log1p: {}, guessed: false };
  const result = {};
  for (const matrix of matrices.sort(compareCodePoints)) result[matrix] = { base: log1p.base };
  return { log1p: result, guessed: matrices.length > 0 };
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
