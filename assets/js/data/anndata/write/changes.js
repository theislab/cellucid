/**
 * The changes a copy of a dataset writes (`copy.js` `CopyChanges`), checked
 * in one pass against the dataset before a byte of the copy is written:
 * what cannot be written as asked is refused with one sentence, never
 * dropped or written another way.
 *
 * - **Names** that become paths (obs and var column names, `uns` keys at
 *   every depth, `uns['cellucid']` keys and every name below them, gene-set
 *   names among them) follow the portable element-name rule (`names.js`),
 *   and none is one of its group's others in another letter case or Unicode
 *   form (a column of the same exact name is replaced). A gene set is kept
 *   as cellucid-python and cellucid-r keep it, a mapping by its name
 *   (`uns['cellucid']['gene_sets'][name]`), so its name is a path too.
 * - **Columns**: a known kind, one value per cell (obs: by original
 *   position) or per feature of the var frame changed (a MuData's: that of
 *   `varModality`), its parts of the types `element-writer.js` writes,
 *   booleans and masks 0 or 1, categorical codes from -1 below the category
 *   count, categories distinct; never the frame's index. An obs change may
 *   rename a column (`from`, once each; never onto a name the frame keeps).
 *   None writes, renames or replaces `obs['cellucid_original_position']`
 *   (the rows' original positions of a file in priority order), nor takes
 *   its name.
 * - **`uns` values**: text, a number, a boolean, a typed array, a list of
 *   text, of numbers or of booleans, or a mapping of those; `null` removes
 *   a top-level key and is refused anywhere else.
 * - **`uns['cellucid']`**: only the keys the record holds, never `priority`
 *   (the source's rows keep the source's), and the record as it will be
 *   written (the source's, these keys changed, `schema`, `id` and `name`
 *   from the open dataset when neither names them) is one the app opens
 *   (`requireCellucidFileMetadata`).
 *
 * @module data/anndata/write/changes
 */

import { isGroup } from '../../../formats/store.js';
import { attributeValue } from '../elements.js';
import { frameRows } from '../views/modalities.js';
import { CELLUCID_UNS_KEYS, CELLUCID_UNS_SCHEMA, isPortableDatasetId, requireCellucidFileMetadata } from '../../anndata-cellucid-metadata.js';
import { folderKey, requireDistinctElementKeys, requireElementKey } from './names.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PRIORITY_ORIGINAL_COLUMN } from '../priority-layout.js';

/** Why a copy never writes, renames or replaces the priority position column. */
export const PRIORITY_COLUMN_REFUSAL = `obs['${PRIORITY_ORIGINAL_COLUMN}'] holds each row's original position in a file stored in priority order, so a copy keeps it as its source holds it and never writes, renames or replaces it.`;

/** The changes a copy makes. */
const CHANGE_KEYS = Object.freeze(['obs', 'var', 'varModality', 'uns', 'cellucid']);

const INTEGER_ARRAYS = [Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, BigInt64Array, BigUint64Array];
const NUMBER_ARRAYS = [...INTEGER_ARRAYS, Float32Array, Float64Array];
const CODE_ARRAYS = [Int8Array, Int16Array, Int32Array];

const isOneOf = (value, types) => types.some(Type => value instanceof Type);
const isPlainRecord = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/** Every value 0 or 1. */
function requireFlags(values, label, length) {
  if (!(values instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array of 0 and 1.`);
  if (values.length !== length) throw new RangeError(`${label} has ${formatCountOf(values.length, 'value')} for ${formatCountOf(length, 'row')}.`);
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 1) throw new RangeError(`${label} holds ${values[i]} at row ${i}; it holds 0 or 1.`);
  }
}

/**
 * One column of a kind `element-writer.js` `column()` writes, `length` rows.
 *
 * @param {string} label - "The obs column 'x'"
 * @param {Object} column
 * @param {number} length
 */
export function requireColumn(label, column, length) {
  const sized = (values, what) => {
    if (values.length !== length) throw new RangeError(`${label}${what} has ${formatCountOf(values.length, 'value')} for ${formatCountOf(length, 'row')}.`);
  };
  switch (column.kind) {
    case 'numbers':
      if (!isOneOf(column.values, NUMBER_ARRAYS)) throw new TypeError(`${label} holds numbers as a numeric typed array.`);
      sized(column.values, '');
      return;
    case 'booleans':
      requireFlags(column.values, label, length);
      return;
    case 'nullable-integer':
      if (!isOneOf(column.values, INTEGER_ARRAYS)) throw new TypeError(`${label} holds its integers as an integer typed array.`);
      sized(column.values, '');
      requireFlags(column.mask, `${label}'s mask`, length);
      return;
    case 'nullable-boolean':
      requireFlags(column.values, label, length);
      requireFlags(column.mask, `${label}'s mask`, length);
      return;
    case 'categorical': {
      if (!isOneOf(column.codes, CODE_ARRAYS)) throw new TypeError(`${label} holds its codes as an Int8Array, Int16Array or Int32Array.`);
      sized(column.codes, '');
      const categories = column.categories;
      if (!Array.isArray(categories) || categories.some(category => typeof category !== 'string')) {
        throw new TypeError(`${label} names its categories as a list of text.`);
      }
      if (new Set(categories).size !== categories.length) {
        const seen = new Set();
        const twice = categories.find(category => (seen.has(category) ? true : (seen.add(category), false)));
        throw new TypeError(`${label} names the category '${twice}' twice.`);
      }
      if (column.ordered !== undefined && typeof column.ordered !== 'boolean') throw new TypeError(`${label} says whether it is ordered with true or false.`);
      for (let i = 0; i < column.codes.length; i++) {
        const code = column.codes[i];
        if (code < -1 || code >= categories.length) {
          throw new RangeError(`${label} has the code ${code} at row ${i}, outside its ${formatCountOf(categories.length, 'category', 'categories')} (-1 is missing).`);
        }
      }
      return;
    }
    case 'strings':
      if (!Array.isArray(column.values) || column.values.some(value => value !== null && typeof value !== 'string')) {
        throw new TypeError(`${label} holds a list of text (null where missing).`);
      }
      sized(column.values, '');
      return;
    default:
      throw new TypeError(`${label} is of the kind '${column.kind}', which is none a copy writes (numbers, booleans, nullable-integer, nullable-boolean, categorical, strings).`);
  }
}

/**
 * A value `element-writer.js` `unsValue` writes as it is, or a `TypeError`
 * naming its path: nothing is left out or written as something else.
 *
 * @param {unknown} value
 * @param {string} label - `uns['a']['b']`
 */
export function requireUnsValue(value, label) {
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') return;
  if (value === null || value === undefined) {
    throw new TypeError(`${label} is ${value}; only a key of uns or uns['cellucid'] itself is removed with null.`);
  }
  if (typeof value === 'bigint') throw new TypeError(`${label} is a BigInt, which uns holds only in a typed array (a BigInt64Array).`);
  if (ArrayBuffer.isView(value)) {
    if (!isOneOf(value, NUMBER_ARRAYS)) throw new TypeError(`${label} is a ${value.constructor.name}, not an array of numbers.`);
    return;
  }
  if (Array.isArray(value)) {
    const kinds = new Set(value.map(item => (item === null ? 'null' : Array.isArray(item) ? 'list' : typeof item)));
    if (kinds.size > 1 || (kinds.size === 1 && !['string', 'number', 'boolean'].includes([...kinds][0]))) {
      throw new TypeError(`${label} is a list of ${[...kinds].join(' and ')}; uns holds a list of text, of numbers or of booleans.`);
    }
    return;
  }
  if (!isPlainRecord(value)) throw new TypeError(`${label} is a ${value?.constructor?.name ?? typeof value}, which uns cannot hold.`);
  const keys = Object.keys(value);
  for (const key of keys) {
    requireElementKey(key, `The key of ${label}`);
    requireUnsValue(value[key], `${label}['${key}']`);
  }
  requireDistinctElementKeys(keys, `The key of ${label}`);
}

/**
 * Every group of the source holds names distinct once Unicode-normalised
 * (NFC): two that are one become one entry to a ZIP reader that normalises
 * (`formats/zip/names.js`) and one folder to a file system that does, so
 * the copy is refused before it starts, naming them.
 *
 * @param {Object} group
 */
export function requireNormalisedDistinct(group) {
  const seen = new Map();
  for (const key of group.keys()) {
    const normal = key.normalize('NFC');
    if (seen.has(normal)) {
      throw new TypeError(`${group.path} holds '${seen.get(normal)}' and '${key}', one name in two Unicode forms; a copy cannot keep both apart. Rename one of them.`);
    }
    seen.set(normal, key);
  }
  for (const key of group.keys()) {
    const node = group.get(key);
    if (isGroup(node)) requireNormalisedDistinct(node);
  }
}

/** The names a frame holds beside its index: its columns and other children. */
function frameNames(frame) {
  if (!isGroup(frame)) return { index: '_index', names: [] };
  const declared = attributeValue(frame, '_index');
  const index = typeof declared === 'string' ? declared : '_index';
  return { index, names: frame.keys().filter(name => name !== index) };
}

/**
 * Columns changed in one frame: portable names, none its index, none
 * another of its columns in another case or Unicode form, each of `rows`.
 * In obs (`renames`), a change may name the column it renames (`from`: an
 * existing column, written under `name` in its place, its values as stored
 * when `column` is null); a column renamed away frees its name.
 */
function requireColumns(columns, frame, rows, side, { renames = false } = {}) {
  if (!Array.isArray(columns)) throw new TypeError(`The ${side} changes are a list of columns.`);
  const { index, names } = frameNames(frame);
  const froms = new Set();
  for (const change of columns) {
    if (!isPlainRecord(change)) throw new TypeError(`A ${side} change is {name, column}.`);
    if (change.from === undefined) continue;
    if (!renames) throw new TypeError(`A ${side} change cannot rename a column (from).`);
    if (typeof change.from !== 'string' || !names.includes(change.from) || change.from === index) {
      throw new TypeError(`The ${side} change '${change.name}' renames '${change.from}', which is no column of ${side}.`);
    }
    if (froms.has(change.from)) throw new TypeError(`The ${side} column '${change.from}' is renamed twice.`);
    froms.add(change.from);
  }
  const existing = new Map(names.filter(name => !froms.has(name)).map(name => [folderKey(name), name]));
  for (const change of columns) {
    const { name, column, from } = change;
    requireElementKey(name, `The ${side} column`);
    if (name === '_index' || name === index) throw new TypeError(`'${name}' is the index of ${side}, not a column a copy writes.`);
    const other = existing.get(folderKey(name));
    if (other !== undefined && other !== name) {
      throw new TypeError(`The ${side} column '${name}' and the column '${other}' differ only in letter case or Unicode form; a copy cannot hold both, so name it '${other}' to replace it, or another name.`);
    }
    if (from !== undefined && from !== name && other === name) {
      throw new TypeError(`The ${side} column '${from}' cannot be renamed '${name}': ${side} has a column of that name.`);
    }
    if (from !== undefined && column === null) continue;
    if (!isPlainRecord(column) || typeof column.kind !== 'string') throw new TypeError(`The ${side} column '${name}' has no kind.`);
    requireColumn(`The ${side} column '${name}'`, column, rows);
  }
  requireDistinctElementKeys(columns.map(change => change.name), `The ${side} column`);
}

/**
 * Check `changes` against the dataset at `root` and return them as the
 * copy writes them: `cellucid` with the open dataset's `schema`, `id` and
 * `name` where the record names none.
 *
 * @param {Object} changes
 * @param {{root: Object, nObs: number, modalities: ReadonlyArray<{name: string}>|null,
 *   sourceCellucid: Object|null, dataset?: {id?: string|null, name?: string|null}|null}} context
 *   `sourceCellucid`: the source's `uns['cellucid']` as plain values (null
 *   without one); `dataset`: the open dataset's id and name.
 * @returns {{obs: Array, var: Array, varModality: string|null, uns: Object, cellucid: Object|null, notes: string[]}}
 */
export function requireCopyChanges(changes, { root, nObs, modalities, sourceCellucid, dataset = null }) {
  if (!isPlainRecord(changes)) throw new TypeError('The changes of a copy are a record.');
  for (const key of Object.keys(changes)) {
    if (!CHANGE_KEYS.includes(key)) throw new TypeError(`'${key}' is not a change a copy makes (${CHANGE_KEYS.join(', ')}).`);
  }
  const notes = [];

  // obs: the cells' frame (a MuData's global obs). The priority position
  // column names the source's rows (`priority-layout.js`): never changed.
  if (Array.isArray(changes.obs) && changes.obs.some(change => change?.name === PRIORITY_ORIGINAL_COLUMN || change?.from === PRIORITY_ORIGINAL_COLUMN)) {
    throw new TypeError(PRIORITY_COLUMN_REFUSAL);
  }
  requireColumns(changes.obs ?? [], root.get('obs'), nObs, 'obs', { renames: true });

  // var: the dataset's, or one modality's.
  let varModality = changes.varModality ?? null;
  if (modalities === null && varModality !== null) {
    throw new TypeError(`varModality names '${varModality}', and this dataset has no modalities: its var is changed without it.`);
  }
  if (modalities !== null) {
    const names = modalities.map(modality => modality.name);
    varModality ??= root.defaultModality ?? names[0];
    if (!names.includes(varModality)) throw new TypeError(`'${varModality}' is not a modality of the dataset (${names.join(', ')}).`);
  }
  const varFrame = modalities === null ? root.get('var') : root.get(`mod/${varModality}/var`);
  const features = frameRows(varFrame);
  if ((changes.var ?? []).length > 0 && features === null) throw new TypeError('The dataset has no var frame to add columns to.');
  requireColumns(changes.var ?? [], varFrame, features ?? 0, modalities === null ? 'var' : `var of '${varModality}'`);

  // uns: keys at every depth, values as they are written.
  const uns = changes.uns ?? {};
  if (!isPlainRecord(uns)) throw new TypeError('The uns changes are a record of keys.');
  const unsNode = root.get('uns');
  const unsExisting = new Map((isGroup(unsNode) ? unsNode.keys() : []).map(key => [folderKey(key), key]));
  for (const [key, value] of Object.entries(uns)) {
    if (key === 'cellucid') throw new TypeError("uns['cellucid'] is changed key by key (changes.cellucid).");
    requireElementKey(key, 'The uns key');
    const other = unsExisting.get(folderKey(key));
    if (other !== undefined && other !== key) throw new TypeError(`The uns key '${key}' and the key '${other}' differ only in letter case or Unicode form; a copy cannot hold both.`);
    if (value !== null) requireUnsValue(value, `uns['${key}']`);
  }
  requireDistinctElementKeys(Object.keys(uns), 'The uns key');

  // uns['cellucid']: its keys, and the record as written.
  const given = changes.cellucid ?? null;
  if (given !== null && !isPlainRecord(given)) throw new TypeError("The uns['cellucid'] changes are a record of keys.");
  for (const [key, value] of Object.entries(given ?? {})) {
    if (!CELLUCID_UNS_KEYS.includes(key)) {
      throw new TypeError(`uns['cellucid']['${key}'] is not a key a Cellucid-ready AnnData holds (${CELLUCID_UNS_KEYS.join(', ')}).`);
    }
    if (key === 'priority') throw new TypeError("uns['cellucid']['priority'] describes the file's rows: a copy keeps its source's.");
    if (value !== null) requireUnsValue(value, `uns['cellucid']['${key}']`);
  }
  const cellucid = { ...(given ?? {}) };
  const source = sourceCellucid ?? {};
  const named = key => (Object.hasOwn(cellucid, key) ? cellucid[key] !== null : Object.hasOwn(source, key));
  // A copy names the dataset it copies: a reopened copy is the same dataset, its histories its own.
  if (dataset !== null && !named('schema')) cellucid.schema = CELLUCID_UNS_SCHEMA;
  if (!named('id') && typeof dataset?.id === 'string') {
    if (isPortableDatasetId(dataset.id)) cellucid.id = dataset.id;
    else notes.push(`uns['cellucid']['id'] was not written: the open dataset's id '${dataset.id}' is not one a file can name.`);
  }
  if (!named('name') && typeof dataset?.name === 'string' && dataset.name.trim() === dataset.name && dataset.name !== '') cellucid.name = dataset.name;
  const merged = { ...source };
  for (const [key, value] of Object.entries(cellucid)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  requireCellucidFileMetadata(merged, 'anndata');
  return {
    obs: changes.obs ?? [],
    var: changes.var ?? [],
    varModality,
    uns,
    cellucid: Object.keys(cellucid).length === 0 ? null : cellucid,
    notes,
  };
}

