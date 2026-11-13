/**
 * What an AnnData file's `uns` says to Cellucid, read as plain values:
 * `uns['cellucid']` (what opening checks, its stored outlier quantiles
 * described, never read; the records the Python and R packages keep there),
 * the launch defaults' expression matrix, `uns['title']`, an obs field's
 * stored colors and `uns['log1p']`. Reading only: what a value means is the
 * adapter's (`anndata-cellucid-metadata.js`), and a copy writes `uns`
 * (`write/`). Used by the reader (`reader.js`) and the copy.
 *
 * @module data/anndata/uns
 */

import { setOwnDataProperty } from '../../utils/exact-record.js';
import { isGroup } from '../../formats/store.js';
import { child, encodingType, valueKind } from './elements.js';
import { readStored } from './values.js';

/**
 * Children of `uns['cellucid']` the tree read leaves out: `history_applied`,
 * `gene_sets` and `pulled` are the records the Python and R packages keep on
 * the data (each saved history applied, with the whole file when asked; the
 * gene sets and the columns a pull wrote), which can be large and which the
 * viewer does not use; `outlierQuantiles` holds one array per categorical field
 * (several MB each), so opening describes it (`describeStoredOutlierQuantiles`)
 * and a field's array is read only when its outlier filter is used
 * (`readStoredOutlierQuantiles`).
 */
const CELLUCID_UNREAD_KEYS = Object.freeze(['history_applied', 'gene_sets', 'pulled', 'outlierQuantiles']);

/**
 * What `uns['cellucid']['outlierQuantiles']` holds, from its metadata and two
 * scalars: `{latentKey, minPoints, fields: {<obs key>: {shape, dtype}}}` as
 * plain JSON values (`anndata-cellucid-metadata.js` checks them). No field's
 * values are read.
 */
async function describeStoredOutlierQuantiles(node, readOptions) {
  const label = "uns['cellucid']['outlierQuantiles']";
  if (!isGroup(node)) throw unsCellucidError(`${label} must be a mapping`);
  const scalar = async key => (node.has(key) ? readUnsTree(node.get(key), `${label}['${key}']`, readOptions) : undefined);
  const [latentKey, minPoints] = await Promise.all([scalar('latentKey'), scalar('minPoints')]);
  const description = { latentKey, minPoints, fields: {} };
  for (const key of node.keys()) {
    if (key !== 'latentKey' && key !== 'minPoints' && key !== 'fields') description[key] = null;
  }
  if (node.has('fields')) {
    const fields = node.get('fields');
    if (!isGroup(fields)) throw unsCellucidError(`${label}['fields'] must be a mapping`);
    for (const key of fields.keys()) {
      const array = fields.get(key);
      description.fields[key] = array?.kind === 'array'
        ? { shape: [...array.shape], dtype: valueKind(array) === 'float' ? `float${8 * (array.dtype?.bytes ?? 0)}` : valueKind(array) }
        : { shape: null, dtype: 'group' };
    }
  } else {
    description.fields = undefined;
  }
  return description;
}

/**
 * `uns['cellucid']` as plain JSON values, its stored outlier quantiles
 * described (what opening checks; a copy checks the record it writes
 * against it, `write/changes.js`).
 */
export async function readUnsCellucid(node, readOptions) {
  const [cellucid, outliers] = await Promise.all([
    readUnsTree(node, "uns['cellucid']", readOptions, CELLUCID_UNREAD_KEYS),
    isGroup(node) && node.has('outlierQuantiles')
      ? describeStoredOutlierQuantiles(node.get('outlierQuantiles'), readOptions)
      : null,
  ]);
  if (outliers !== null) cellucid.outlierQuantiles = outliers;
  return cellucid;
}

/** The records the Python and R packages keep in `uns['cellucid']`, which opening leaves unread. */
const PACKAGE_RECORD_KEYS = Object.freeze(['history_applied', 'gene_sets', 'pulled']);

/**
 * The packages' records of `uns['cellucid']` as plain JSON values (those it
 * holds of `history_applied`, `gene_sets`, `pulled`): what an apply plan
 * reads of a dataset (`write/copy-target.js`: the applies before it, the
 * gene sets kept), never opening.
 */
export async function readUnsCellucidRecords(node, readOptions) {
  const records = {};
  if (!isGroup(node)) return records;
  for (const key of PACKAGE_RECORD_KEYS) {
    if (node.has(key)) records[key] = await readUnsTree(node.get(key), `uns['cellucid']['${key}']`, readOptions);
  }
  return records;
}

/**
 * The expression matrix a file names for genes in its launch defaults
 * (`uns['cellucid']['defaults']['expression']`: `X`, `raw/X` or
 * `layers/<name>`), or null when it names none. One small read; the
 * adapter checks the value against the file when it applies the defaults.
 */
export async function launchExpressionOf(root, readOptions) {
  const node = child(child(child(child(root, 'uns'), 'cellucid'), 'defaults'), 'expression');
  if (node === null) return null;
  const value = await readUnsTree(node, "uns['cellucid']['defaults']['expression']", readOptions);
  return typeof value === 'string' ? value : null;
}

/**
 * A refusal of what `uns['cellucid']` holds, written for the person who opened
 * the file and shown as it is (`explained`, which survives the worker's error
 * serialization).
 */
function unsCellucidError(message) {
  const error = new TypeError(
    `${message}. uns['cellucid'] is what a file says about itself for Cellucid; ` +
    'write it again with cellucid.prepare() in Python or cellucid_prepare() in R, or remove it.'
  );
  error.code = 'INVALID_FORMAT';
  error.details = { explained: true };
  return error;
}

/** One stored scalar as JSON would hold it. */
function unsScalar(value, kind, label) {
  if (kind === 'bool') return Boolean(value);
  if (kind === 'string') return value;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw unsCellucidError(`${label} is an integer beyond 2^53`);
    return number;
  }
  if (typeof value === 'number') return value;
  throw unsCellucidError(`${label} must hold text, numbers or booleans`);
}

/**
 * Read one `uns` subtree as plain JSON values: a mapping (an AnnData `dict`
 * group, or a plain group as files before anndata 0.8 write it) becomes an
 * object, a scalar array its value, a one-dimensional array a list. Anything
 * else (a dataframe, a matrix, an array of more dimensions) is refused, since
 * no Cellucid metadata is stored that way.
 *
 * @param {Object} node
 * @param {string} label - Where the node is, for messages
 * @param {Object} readOptions
 * @param {ReadonlyArray<string>} [unread] - Children of this node left unread
 * @returns {Promise<unknown>}
 */
async function readUnsTree(node, label, readOptions, unread = []) {
  if (isGroup(node)) {
    const declared = encodingType(node);
    if (declared !== '' && declared !== 'dict') {
      throw unsCellucidError(`${label} is stored as '${declared}'; it must be a mapping (a dict), a list or a single value`);
    }
    const keys = node.keys().filter(key => !unread.includes(key));
    const values = await Promise.all(keys.map(key => readUnsTree(node.get(key), `${label}['${key}']`, readOptions)));
    /** @type {Record<string, unknown>} */
    const object = {};
    // A member named `__proto__` is a key like any other, never the object's prototype.
    keys.forEach((key, index) => { setOwnDataProperty(object, key, values[index]); });
    return object;
  }
  if (node?.kind !== 'array') throw unsCellucidError(`${label} must be a mapping, a list or a single value`);
  const kind = valueKind(node);
  if (kind === 'unknown') {
    throw unsCellucidError(`${label} must hold text, numbers or booleans`);
  }
  if (node.shape.length > 1) {
    throw unsCellucidError(`${label} is a ${node.shape.length}-dimensional array; it must be a list or a single value`);
  }
  const value = await node.read(undefined, readOptions);
  if (node.shape.length === 0) return unsScalar(value, kind, label);
  return Array.from(value, element => unsScalar(element, kind, label));
}

/**
 * `uns['title']` as a file names itself (every CELLxGENE file does), else
 * null: a string, or a one-element string array as R writers and anndata 0.6
 * leave it. A title that cannot be read is no title.
 */
export async function readUnsTitle(root, readOptions) {
  const title = child(child(root, 'uns'), 'title');
  if (title?.kind !== 'array' || valueKind(title) !== 'string') return null;
  if (!title.shape.every(extent => extent === 1)) return null;
  let value;
  try {
    value = await title.read(undefined, readOptions);
    if (typeof value !== 'string') value = value?.[0];
  } catch (error) {
    // A title only names the dataset: one that cannot be read is no title,
    // and never stops the file from opening.
    console.warn(`[AnnDataReader] uns['title'] could not be read; the file name is used instead (${error?.message ?? error})`);
    return null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The colors Scanpy keeps for one categorical obs field,
 * `uns['<key>_colors']` (one color per category, in category order, as
 * `sc.pl.*` writes them; a MuData modality's column `<modality>:<column>`
 * its modality's `uns['<column>_colors']`), as the stored text; null when the
 * file has none.
 * Which entries are colors, and whether there are enough of them, is the
 * page's to judge (`scanpyCategoryPalette`). A palette that cannot be read
 * is no palette: the field is still shown, in Cellucid's colors.
 *
 * `at` reads the colors of some categories only: those at the stored
 * positions `at.positions` (ascending) of a dictionary of `at.count`, read
 * through `at.gather` (`views/cell-subset.js` `gatheredArray`); a palette
 * shorter than the dictionary is none.
 *
 * @param {Object} root
 * @param {string} key
 * @param {{signal?: AbortSignal|null}} readOptions
 * @param {{count: number, positions: Uint32Array, gather: Function}|null} [at]
 * @returns {Promise<string[]|null>}
 */
export async function readObsFieldColors(root, key, readOptions, at = null) {
  // A modality's column pulled to the cells (`<modality>:<column>`,
  // `views/mudata.js`) keeps its colors in that modality's own `uns`, where
  // Scanpy run on the modality writes them.
  const colon = key.indexOf(':');
  const modality = colon > 0 ? child(child(root, 'mod'), key.slice(0, colon)) : null;
  const node = modality !== null
    ? child(child(modality, 'uns'), `${key.slice(colon + 1)}_colors`) ?? child(child(root, 'uns'), `${key}_colors`)
    : child(child(root, 'uns'), `${key}_colors`);
  if (node?.kind !== 'array' || valueKind(node) !== 'string' || node.shape.length !== 1) return null;
  if (at !== null && node.shape[0] < at.count) return null;
  try {
    const values = at === null
      ? await node.read(undefined, readOptions)
      : await readStored(at.gather(node, at.positions), 0, at.positions.length, `uns['${key}_colors']`, readOptions);
    return Array.from(values, value => String(value));
  } catch (error) {
    if (readOptions.signal?.aborted) throw error;
    console.warn(`[AnnDataReader] uns['${key}_colors'] could not be read; '${key}' is shown in Cellucid's colors (${error?.message ?? error})`);
    return null;
  }
}

/**
 * `uns['log1p']` as `sc.pp.log1p` records it: null when the file has none,
 * else `{base}`, null for the natural logarithm. Scanpy writes `base` as None
 * for e, which anndata stores as nothing; a base that is not a positive
 * number other than 1 is not a base a logarithm has, and reads as e too.
 *
 * @returns {Promise<{base: number|null}|null>}
 */
export async function readLog1pRecord(root, readOptions) {
  const record = child(child(root, 'uns'), 'log1p');
  if (record === null || record === undefined) return null;
  const node = isGroup(record) ? child(record, 'base') : null;
  if (node?.kind !== 'array' || !['float', 'int', 'uint'].includes(valueKind(node))) return { base: null };
  if (!node.shape.every(extent => extent === 1)) return { base: null };
  let value = await node.read(undefined, readOptions);
  if (typeof value !== 'number' && typeof value !== 'bigint') value = value?.[0];
  const base = Number(value);
  return { base: Number.isFinite(base) && base > 0 && base !== 1 ? base : null };
}
