/**
 * A copy of an open dataset as a Cellucid-ready AnnData `.zarr.zip`, with
 * changes: what "Save AnnData with this state…" writes (the apply plan's
 * executor, `app/history/exports/anndata-copy.js`, hands it the columns and
 * records it writes).
 *
 * The source is the store root the reader presents (`AnnDataReader.storedRoot`):
 * every format the app reads is presented as AnnData there (`views/`,
 * `transcode/`, `older-layouts.js`), so one copy serves `.h5ad`, AnnData
 * Zarr (v2, v3, folder, `.zarr.zip`), Loom, 10x, MuData, R objects and
 * MatrixMarket folders alike. Every cell is copied, whichever cells are
 * open, in the order the file stores them.
 *
 * **What is copied, and how.** Every element of the source, its attributes
 * and its values as stored: numbers keep their dtype and every bit, in
 * little-endian order as anndata writes them (a
 * float16 array, which the store reads as float32, is written `<f2` again,
 * bit for bit); text is written `vlen-utf8`. Each array is chunked and compressed by its role
 * (`layout.js`), read from the source a slab at a time (`SLAB_BYTES` of
 * values, rounded to whole chunks). Every expression matrix (`X`, each of
 * `layers`, `raw/X`) is written gene-major: a `csc_matrix` copied array by
 * array, a `csr_matrix` transposed in passes within the budget
 * (`gene-major.js`), a dense matrix in strips a band of rows and a group of
 * genes at a time. A source the app reads in a layout of its own (a Loom
 * file's matrix, a 10x file's features) is written in the layout presented,
 * as anndata would write the same AnnData. An element of a type no AnnData
 * Zarr holds (a compound or opaque array) is left out, with a note.
 *
 * **The cells' order.** Rows stay in the order stored, so a priority-ordered
 * file (`priority-layout.js`) stays one: its record, its position column and
 * its prefix counts are copied, and a cell-major `X` transposed here gets its
 * prefix counts from its rows. Columns the changes add are given by original
 * position (what every boundary of the app names a cell by) and placed at
 * each cell's file row.
 *
 * **MuData.** A dataset of several modalities (a root that carries
 * `modalities`: MuData, a multi-assay R object) is written as a
 * Cellucid-ready MuData (specification §5): the global `obs`, `obsm`, `obsp`
 * and `uns` without the columns and arrays the view placed from the
 * modalities (`<modality>:<key>`); each modality's mask (`obsm/<name>`) and
 * cell map (`obsmap/<name>`), its features' map (`varmap/<name>`), the
 * global `var` (every modality's features in `mod-order`), and each
 * modality's AnnData under `mod/<name>`.
 *
 * **Memory.** Two slabs of the array being copied (`SLAB_BYTES` each: the
 * one being written and the next one's read), the chunk being filled for
 * each array being written, the chunks being encoded (`inFlight`), the
 * budget (a transposition's block of genes, or a dense matrix's band of
 * every gene), and the archive's central directory (about 70 bytes an
 * entry). The archive goes to `sink` as it is written: a file on disk (the
 * File System Access API) or a spool, never memory the size of the copy.
 * The reader worker counts all of it in the working set while it runs.
 *
 * @module data/anndata/write/copy
 */

import { isArrayNode, isGroup } from '../../../formats/store.js';
import { attributeValue, encodingType } from '../elements.js';
import { currentLayoutView, isOlderAnnDataLayout } from '../older-layouts.js';
import { frameRows, cellMapOf } from '../views/modalities.js';
import { PREFIX_COUNTS_KEY, readPriorityLayout } from '../priority-layout.js';
import { SLAB_BYTES } from '../values.js';
import { CellucidReadyWriter } from './ready-writer.js';
import { encodingAttributes as encoding } from './element-writer.js';
import { roleOf, chunkShapeOf } from './layout.js';
import { valueArrayOf, writeGeneMajorFromRows } from './gene-major.js';
import { float16Bits } from '../../../formats/zarr/writer.js';
import { itemSizeOf, recordDtype, zarrV2Dtype } from '../../../formats/zarr/format-v2.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { readUnsCellucid } from '../uns.js';
import { requireCopyChanges, requireNormalisedDistinct } from './changes.js';
import { folderKey, portableElementName } from './names.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** Elements of an AnnData group in the order they are written; any other follows, by name. */
const ELEMENT_ORDER = ['uns', 'var', 'obs', 'obsm', 'obsp', 'X', 'layers', 'raw', 'varm', 'varp'];
/** Bytes a string is taken to hold when the first slab of text is sized (`textBytesOf` measures the rest). */
const STRING_BYTES = 32;

/** The mean bytes of `values` as stored (UTF-8 and the 4-byte length of each), at least 1. */
function textBytesOf(values) {
  if (values.length === 0) return STRING_BYTES;
  let bytes = 0;
  for (const value of values) {
    const text = value ?? '';
    bytes += 4;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code < 0xdc00) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
  }
  return Math.max(1, bytes / values.length);
}

/**
 * @typedef {Object} ColumnChange
 * @property {string} name - The column's name: an existing column of that name is replaced
 * @property {Object|null} column - A column of a kind `element-writer.js` `column()` writes,
 *   one value per cell (obs: by original position; var: by var row); null with `from`:
 *   the renamed column's values as stored
 * @property {string} [from] - obs only: the column it renames, written under `name` in that
 *   column's place (a renamed column frees its name for a new one)
 */

/**
 * @typedef {Object} CopyChanges
 * @property {ColumnChange[]} [obs] - obs columns to write (the global obs of a MuData)
 * @property {ColumnChange[]} [var] - var columns to write (of `varModality` in a MuData)
 * @property {string|null} [varModality] - The modality whose var `var` changes (default: the default modality)
 * @property {Record<string, unknown>} [uns] - Root `uns` keys to write (`unsValue`); null removes one
 * @property {Record<string, unknown>} [cellucid] - `uns['cellucid']` keys to write; null removes one
 */

/**
 * @typedef {Object} CopyResult
 * @property {number} bytes - Bytes of the archive
 * @property {number} entries - Its entries
 * @property {boolean} zip64 - Whether it needed ZIP64 records
 * @property {number} chunks - Chunks written
 * @property {'anndata'|'mudata'} layout
 * @property {number} nObs
 * @property {boolean} priorityOrder - Whether the copy keeps a verified priority order
 * @property {string[]} notes - What was not copied as it was, and why
 */

/**
 * Write a copy of the AnnData presented at `root` to `sink`.
 *
 * @param {Object} source - The source's store root, as the reader presents it (a
 *   file of an earlier anndata is presented in the current layout here too)
 * @param {import('../../../formats/zip/writer.js').ZipSink} sink
 * @param {{changes?: CopyChanges, dataset?: {id?: string|null, name?: string|null}|null,
 *   readOptions?: Object, budgetBytes?: number, slabBytes?: number,
 *   encode?: Function, inFlight?: number, onProgress?: ((progress: {done: number, total: number}) => void)|null}} [options]
 *   `changes` are checked whole first (`changes.js`: refused with one
 *   sentence, before a byte is written); `dataset`: the open dataset's id
 *   and name, written into `uns['cellucid']` where the source names none, so
 *   a copy opened again is the same dataset. `budgetBytes`: what a transposition's block, or one band of rows of a dense
 *   matrix across all its genes, may hold (`gene-major.js`, `layout.js`); `slabBytes`: the values one
 *   read of the source takes (`SLAB_BYTES`); `encode` and `inFlight`: how
 *   chunks are encoded and how many at once (`pool-encoder.js`; the bytes
 *   are the same either way); `readOptions`: `{signal, activity}` of every
 *   source read, the activity told the copy's progress (values copied of
 *   all), as `onProgress` is.
 * @returns {Promise<CopyResult>}
 */
export async function writeAnnDataCopy(source, sink, { changes = {}, dataset = null, readOptions = {}, budgetBytes = SLAB_BYTES, slabBytes = SLAB_BYTES, encode = undefined, inFlight = 1, onProgress = null } = {}) {
  if (!isGroup(source)) throw new TypeError('A copy is written from a store root group.');
  const signal = readOptions.signal ?? null;
  throwIfAborted(signal);
  // A file written before anndata 0.8 is copied in the current layout, as the reader presents it.
  const root = isOlderAnnDataLayout(source) ? await currentLayoutView(source, readOptions) : source;
  await root.load(undefined, readOptions);
  const nObs = frameRows(root.get('obs'));
  if (nObs === null) throw new Error('The dataset has no obs to copy.');
  const modalities = Array.isArray(root.modalities) && isGroup(root.get('mod')) ? root.modalities : null;
  // One pass over everything the copy is asked to write, before a byte of it is written.
  requireNormalisedDistinct(root);
  const unsCellucid = isGroup(root.get('uns')) ? root.get('uns').get('cellucid') : null;
  const sourceCellucid = isGroup(unsCellucid) ? await readUnsCellucid(unsCellucid, readOptions) : null;
  const checked = requireCopyChanges(changes, { root, nObs, modalities, sourceCellucid, dataset });

  const { layout } = await readPriorityLayout(root, nObs, readOptions);
  const order = layout === null || (changes?.obs ?? []).length === 0 ? null : await layout.order();
  const writer = new CellucidReadyWriter(sink, { encode, inFlight });
  const context = {
    writer,
    readOptions,
    signal,
    budgetBytes,
    slabBytes,
    notes: [...checked.notes],
    done: 0,
    total: 0,
    onProgress,
    levels: layout?.levels ?? null,
  };
  context.total = valuesBelow(root, modalities === null ? null : root);
  // Progress goes to the read activity (the one channel the page shows reads by) and to `onProgress`.
  const activity = readOptions.activity ?? null;
  const progress = count => {
    context.done = Math.min(context.total, context.done + count);
    activity?.progress(context.done, context.total);
    onProgress?.({ done: context.done, total: context.total });
  };
  context.progress = progress;

  const obsChanges = placedColumns(checked.obs, order, nObs);
  if (modalities === null) {
    await copyAnnData(root, '', context, {
      nRows: nObs,
      obsChanges,
      varChanges: checked.var,
      uns: { values: checked.uns, cellucid: checked.cellucid },
      prefixCounts: context.levels,
    });
  } else {
    await copyMuData(root, modalities, nObs, context, { obsChanges, changes: checked });
  }
  const archive = await writer.finish();
  context.done = context.total;
  activity?.progress(context.total, context.total);
  onProgress?.({ done: context.total, total: context.total });
  return {
    ...archive,
    layout: modalities === null ? 'anndata' : 'mudata',
    nObs,
    priorityOrder: layout !== null,
    notes: context.notes,
  };
}

/** Values every array below `node` holds (what a copy reads once), for its progress. */
function valuesBelow(node, mudataRoot = null) {
  if (isArrayNode(node)) return node.shape.reduce((product, extent) => product * extent, 1);
  if (!isGroup(node)) return 0;
  let total = 0;
  for (const key of node.keys()) {
    // A MuData root's default modality is presented at the root too: counted once, under `mod`.
    if (mudataRoot !== null && ['X', 'layers', 'raw', 'varm', 'var'].includes(key)) continue;
    total += valuesBelow(node.get(key));
  }
  return total;
}

/**
 * Columns by original position, placed at file rows: `values[order[row]]`
 * at `row` (`order` the file's original positions; null: the same rows).
 */
function placedColumns(columns, order, rows) {
  return columns.map(change => {
    const { name, column } = change;
    if (column === null) return change;
    // Lengths and kinds are checked already (`changes.js`).
    const permute = values => {
      if (values === undefined || values === null || order === null) return values;
      const out = ArrayBuffer.isView(values) ? allocateTypedArray(values.constructor, rows, `obs column '${name}'`) : new Array(rows);
      for (let row = 0; row < rows; row++) out[row] = values[order[row]];
      return out;
    };
    const placed = { ...column };
    for (const key of ['values', 'codes', 'mask']) if (Object.hasOwn(column, key)) placed[key] = permute(column[key]);
    return { ...change, column: placed };
  });
}

/** Whether `relative` (below an AnnData of `nRows` cells) names an expression matrix. */
function expressionMatrixOf(group, nRows) {
  return relative => {
    if (relative !== 'X' && relative !== 'raw/X' && !/^layers\/[^/]+$/.test(relative)) return false;
    const node = group.get(relative);
    if (isArrayNode(node)) return node.shape.length === 2 && node.shape[0] === nRows;
    const shape = attributeValue(node, 'shape');
    return isGroup(node) && Array.isArray(shape) && Number(shape[0]) === nRows;
  };
}

/**
 * The attributes to write: what the source holds (JSON values; a BigInt
 * stays exact), less an HDF5 attribute of raw bytes (an object reference,
 * as anndata 0.7 pointed a categorical at its categories): an address in
 * the source file, which means nothing in another. Each one left out is
 * noted (`context.notes`).
 */
function attributesOf(node, context = null) {
  const attrs = { ...(node?.attrs ?? {}) };
  for (const key of Object.keys(attrs)) {
    if (node.attributeType?.(key)?.dtype?.kind !== 'opaque') continue;
    delete attrs[key];
    context?.notes.push(`${node.path} attribute '${key}' was left out: it holds ${node.attributeType(key).dtype.reason ?? 'raw bytes'} of the source file.`);
  }
  return attrs;
}

/** Keys of `group` in the order an AnnData's elements are written. */
function orderedKeys(group) {
  const keys = group.keys();
  return [...ELEMENT_ORDER.filter(key => keys.includes(key)), ...keys.filter(key => !ELEMENT_ORDER.includes(key))];
}

/**
 * One AnnData group (the root, or a MuData modality) at `prefix`.
 *
 * @param {Object} group
 * @param {string} prefix - `''` for the root, `mod/<name>`
 * @param {Object} context
 * @param {{nRows: number, obsChanges?: ColumnChange[], varChanges?: ColumnChange[],
 *   uns?: {values: Record<string, unknown>, cellucid: Record<string, unknown>|null}|null,
 *   prefixCounts?: number[]|null, skip?: Set<string>}} options
 */
async function copyAnnData(group, prefix, context, { nRows, obsChanges = [], varChanges = [], uns = null, prefixCounts = null, skip = new Set() }) {
  const { writer } = context;
  const at = key => (prefix === '' ? key : `${prefix}/${key}`);
  writer.group(prefix, { ...attributesOf(group, context), ...encoding('anndata', '0.1.0') });
  const isExpression = expressionMatrixOf(group, nRows);
  const anndata = { group, prefix, nRows, isExpression, prefixCounts, countsWritten: false };
  // X before varm: prefix counts are written with an X transposed here, the source's copied otherwise.
  const keys = orderedKeys(group).filter(key => !skip.has(key));
  for (const key of keys) {
    throwIfAborted(context.signal);
    const node = group.get(key);
    if (key === 'obs' || key === 'var') {
      await copyFrame(node, at(key), context, {
        role: key === 'obs' ? 'cell' : 'whole',
        changes: key === 'obs' ? obsChanges : varChanges,
        relative: key,
        anndata,
      });
    } else if (key === 'uns' && uns !== null) {
      await copyUns(node, at(key), context, uns);
    } else {
      await copyNode(node, at(key), key, context, anndata);
    }
  }
  if (!keys.includes('uns') && uns !== null && (Object.keys(uns.values).length > 0 || uns.cellucid !== null)) {
    await copyUns(null, at('uns'), context, uns);
  }
  for (const key of ['obsm', 'obsp', 'varm', 'varp', 'layers']) {
    if (!writer.has(at(key)) && !skip.has(key)) writer.dict(at(key));
  }
}

/**
 * Copy one element: a group with its children, an array with its values,
 * a cell-major expression matrix transposed.
 */
async function copyNode(node, path, relative, context, anndata) {
  const { writer } = context;
  if (isArrayNode(node)) return copyArray(node, path, relative, context, anndata);
  if (!isGroup(node)) return false;
  // A column window of a larger matrix (one feature type of a 10x file) is
  // read through its real matrix, and written gene-major as every cells ×
  // features matrix is.
  const window = node.columnWindow ?? null;
  if (window !== null || (anndata.isExpression(relative) && encodingType(node) === 'csr_matrix')) {
    const shape = attributeValue(node, 'shape').map(Number);
    const { prefixCounts } = await writeGeneMajorFromRows(writer, path, window?.matrix ?? node, {
      window: window === null ? null : { start: window.start },
      shape,
      budgetBytes: context.budgetBytes,
      slabBytes: context.slabBytes,
      readOptions: context.readOptions,
      levels: relative === 'X' ? anndata.prefixCounts : null,
      onValues: count => context.progress(count / 3),
    });
    if (prefixCounts !== null) {
      const varm = anndata.prefix === '' ? 'varm' : `${anndata.prefix}/varm`;
      if (!writer.has(varm)) writer.dict(varm);
      await writer.array(`${varm}/${PREFIX_COUNTS_KEY}`, {
        values: prefixCounts,
        shape: [shape[1], anndata.prefixCounts.length],
        role: 'columns',
      });
      anndata.countsWritten = true;
    }
    return true;
  }
  if (relative === 'varm' && writer.has(path)) {
    // `varm` was opened by the prefix counts of a transposed X.
  } else {
    writer.group(path, attributesOf(node, context));
  }
  // Each element under a name a store can hold (`portableElementName`), a
  // renamed one said.
  const taken = new Set();
  for (const key of node.keys()) {
    throwIfAborted(context.signal);
    const as = portableElementName(key, taken);
    const childPath = `${path}/${as}`;
    if (writer.has(childPath)) continue;
    if (as !== key) context.notes.push(`${path}/${key} is named '${as}' in the copy: a store cannot name an element as it is.`);
    await copyNode(node.get(key), childPath, `${relative}/${key}`, context, anndata);
  }
  return true;
}

/**
 * A dataframe: its index first, then its columns in their order, each
 * change written in place of the column it names (or renames, `from`) or
 * after the others.
 *
 * @param {*} frame
 * @param {string} path
 * @param {*} context
 * @param {{role: string, changes: *, relative: string, anndata: *, skipColumn?: (name: string) => boolean}} options -
 *   `skipColumn`: whether a column of that name is left out of the copy
 */
async function copyFrame(frame, path, context, { role, changes, relative, anndata, skipColumn = () => false }) {
  const { writer } = context;
  if (!isGroup(frame)) {
    if (frame !== null && frame !== undefined) await copyNode(frame, path, relative, context, anndata);
    return;
  }
  const attrs = attributesOf(frame, context);
  const indexKey = typeof attrs._index === 'string' ? attrs._index : '_index';
  const stored = Array.isArray(attrs['column-order']) ? attrs['column-order'].map(String) : [];
  const changed = new Map(changes.map(change => [change.name, change]));
  // A renamed column's place takes its new name; its old name is free for a new column.
  const renamedFrom = new Map(changes.filter(change => change.from !== undefined && change.from !== change.name).map(change => [change.from, change.name]));
  const order = [];
  for (const name of stored) {
    const shown = renamedFrom.get(name) ?? name;
    if (!order.includes(shown) && !skipColumn(name) && (frame.has(name) || changed.has(shown))) order.push(shown);
  }
  for (const { name } of changes) if (!order.includes(name)) order.push(name);
  if (changed.has(indexKey)) throw new TypeError(`'${indexKey}' is the index of ${path}, not a column a change writes.`);
  // Every column under a name a store can hold (`portableElementName`): the
  // names the changes chose first (checked already), then the source's, a
  // name it cannot hold (with `/`, too long for a file name, …) written
  // under its portable form, and said.
  const taken = new Set([folderKey(indexKey)]);
  const storedAs = new Map([[indexKey, indexKey]]);
  for (const name of [...order.filter(name => changed.has(name)), ...order]) {
    if (storedAs.has(name)) continue;
    storedAs.set(name, portableElementName(name, taken));
    if (storedAs.get(name) !== name) context.notes.push(`${path} column '${name}' is named '${storedAs.get(name)}' in the copy: a store cannot name a column as it is.`);
  }
  const written = [];
  if (frame.has(indexKey)) await copyNode(frame.get(indexKey), `${path}/${indexKey}`, `${relative}/${indexKey}`, context, anndata);
  for (const name of order) {
    throwIfAborted(context.signal);
    const change = changed.get(name);
    const as = storedAs.get(name);
    if (name === indexKey) {
      // A column that is the index too (anndata stores the one array once, named by both).
      written.push(name);
    } else if (change !== undefined && change.column !== null) {
      await writer.column(`${path}/${as}`, change.column, role);
      written.push(as);
    } else if (change !== undefined) {
      // Renamed, its values as stored.
      if (await copyNode(frame.get(change.from), `${path}/${as}`, `${relative}/${change.from}`, context, anndata)) written.push(as);
    } else if (await copyNode(frame.get(name), `${path}/${as}`, `${relative}/${name}`, context, anndata)) {
      written.push(as);
    }
  }
  // Children the column order does not list (a categorical's old `__categories`): copied as they are. A
  // group an HDF5 file made of a column named with `/` (`a/b` is `b` in a group `a`) was copied as that column.
  const holdsColumn = key => order.some(name => name.startsWith(`${key}/`));
  for (const key of frame.keys()) {
    if (key === indexKey || order.includes(key) || renamedFrom.has(key) || skipColumn(key) || holdsColumn(key)) continue;
    const as = portableElementName(key, taken);
    if (writer.has(`${path}/${as}`)) continue;
    await copyNode(frame.get(key), `${path}/${as}`, `${relative}/${key}`, context, anndata);
  }
  // Declared last, so the column order names exactly the columns written.
  writer.group(path, { ...attrs, _index: indexKey, 'column-order': written });
}

/** `uns`, with its keys and those of `uns['cellucid']` changed. */
async function copyUns(node, path, context, { values, cellucid }) {
  const { writer } = context;
  const anndata = { isExpression: () => false, prefix: '' };
  writer.group(path, node === null ? encoding('dict', '0.1.0') : attributesOf(node, context));
  const keys = node === null ? [] : node.keys();
  for (const key of keys) {
    throwIfAborted(context.signal);
    if (Object.hasOwn(values, key)) continue;
    if (key === 'cellucid' && cellucid !== null) continue;
    await copyNode(node.get(key), `${path}/${key}`, `uns/${key}`, context, anndata);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) await writer.unsValue(`${path}/${key}`, value);
  }
  if (cellucid === null) return;
  const source = node !== null && isGroup(node.get('cellucid')) ? node.get('cellucid') : null;
  writer.group(`${path}/cellucid`, source === null ? encoding('dict', '0.1.0') : attributesOf(source, context));
  for (const key of source === null ? [] : source.keys()) {
    if (Object.hasOwn(cellucid, key)) continue;
    await copyNode(source.get(key), `${path}/cellucid/${key}`, `uns/cellucid/${key}`, context, anndata);
  }
  for (const [key, value] of Object.entries(cellucid)) {
    if (value !== null && value !== undefined) await writer.unsValue(`${path}/cellucid/${key}`, value);
  }
}

/** The values of a source read as the dtype written (`valueArrayOf`), converted only when the store hands another type. */
function asWritten(values, dtype, label) {
  if (dtype === '|O') return values;
  if (!ArrayBuffer.isView(values) && !Array.isArray(values)) values = [values];
  if (dtype.endsWith('f2')) return float16Bits(values);
  const Type = valueArrayOf(dtype);
  if (values instanceof Type) return values;
  const out = allocateTypedArray(Type, values.length, label);
  const big = Type === BigInt64Array || Type === BigUint64Array;
  for (let i = 0; i < values.length; i++) out[i] = big ? BigInt(values[i]) : Number(values[i]);
  return out;
}

/** The values of field `index` of records `[first, last)` (all of a scalar: `first` null), by field or from whole records. */
async function fieldValues(node, index, first, last, readOptions) {
  const selection = first === null ? undefined : [[first, last]];
  const field = node.dtype.fields[index];
  if (typeof node.readField === 'function') {
    const values = await node.readField(field.name, selection, readOptions);
    return ArrayBuffer.isView(values) || Array.isArray(values) ? values : [values];
  }
  // A record array a layout view presents (anndata 0.6's `uns`): read whole records.
  const records = await node.read(selection, readOptions);
  const rows = first === null ? [records] : records;
  return rows.flatMap(record => (Array.isArray(record[index]) || ArrayBuffer.isView(record[index]) ? Array.from(record[index]) : [record[index]]));
}

/**
 * The dtype a compound array is written in (`recordDtype`): its text fields
 * as fixed-width Unicode of their longest value, as anndata writes a record
 * array to Zarr (`_to_fixed_length_strings`); null (with a note) when a
 * field is of no type a record holds.
 */
async function recordDtypeOf(node, readOptions, context) {
  const count = node.shape.length === 0 ? null : node.shape[0];
  const widths = new Map();
  for (let index = 0; index < node.dtype.fields.length; index++) {
    const field = node.dtype.fields[index];
    if (field.dtype.kind !== 'string') continue;
    let width = 1;
    // Slabs of the bytes the field's text measured so far.
    let step = Math.max(1, Math.floor(context.slabBytes / STRING_BYTES));
    for (let first = 0; count === null ? first === 0 : first < count;) {
      const last = count === null ? null : Math.min(count, first + step);
      const values = await fieldValues(node, index, count === null ? null : first, last, readOptions);
      for (const value of values) width = Math.max(width, codePoints(String(value ?? '')));
      if (count === null) break;
      first = last;
      step = Math.max(1, Math.floor(context.slabBytes / textBytesOf(Array.from(values, String))));
    }
    widths.set(field.name, width);
  }
  return recordDtype(node.dtype, widths);
}

/** Code points of a string (what one `<U` character holds). */
function codePoints(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Records `[first, last)` of a compound array (all of a 0-dimensional one:
 * `first` null) as their raw bytes in the written dtype (`recordDtype`'s
 * field list): each field read on its own, numbers as stored, text as
 * UTF-32 code points padded with zeros to the field's width.
 */
async function packRecords(node, dtype, first, last, readOptions, label) {
  const size = itemSizeOf(dtype);
  const count = first === null ? 1 : last - first;
  const out = allocateTypedArray(Uint8Array, count * size, `${label} records`);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (let index = 0; index < dtype.length; index++) {
    const [, type, shape = []] = dtype[index];
    const per = shape.reduce((product, extent) => product * extent, 1);
    const width = itemSizeOf(type);
    const values = await fieldValues(node, index, first, last, readOptions);
    if (/^[<>]U\d+$/.test(type)) {
      for (let item = 0; item < count * per; item++) {
        let at = Math.floor(item / per) * size + offset + (item % per) * width;
        for (const character of String(values[item] ?? '')) {
          view.setUint32(at, character.codePointAt(0), true);
          at += 4;
        }
      }
    } else {
      const typed = asWritten(values, type, label);
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      for (let row = 0; row < count; row++) {
        out.set(bytes.subarray(row * per * width, (row + 1) * per * width), row * size + offset);
      }
    }
    offset += width * per;
  }
  return out;
}

/**
 * The reads an array is copied in: its one value (a scalar); slabs of whole
 * chunks of rows (an array chunked by rows); or, for one chunked by columns
 * too (a dense expression matrix, prefix counts), each band of rows a
 * group of chunk columns at a time, within the budget. Rows from `from`
 * (a slab of text is sized again once its first slab's bytes are known).
 */
function copySteps(shape, chunks, itemBytes, context, from = 0) {
  if (shape.length === 0) return [{ scalar: true, values: 1 }];
  if (shape.some(extent => extent === 0)) return [];
  const rowValues = shape.slice(1).reduce((product, extent) => product * extent, 1);
  const steps = [];
  if (chunks.slice(1).every((extent, axis) => extent === shape[axis + 1])) {
    const tail = shape.slice(1).map(extent => [0, extent]);
    const perSlab = chunks[0] * Math.max(1, Math.floor(context.slabBytes / (chunks[0] * rowValues * itemBytes)));
    for (let first = from; first < shape[0]; first += perSlab) {
      const last = Math.min(shape[0], first + perSlab);
      steps.push({ selection: [[first, last], ...tail], first, last, values: (last - first) * rowValues });
    }
    return steps;
  }
  const [rows, columns] = shape;
  const [bandRows, chunkColumns] = chunks;
  // A band of every column at once when the budget holds it (a dense
  // matrix's bands are sized so, `chunkShapeOf` in `layout.js`): each band of the source is read once.
  const groupColumns = bandRows * columns * itemBytes <= context.budgetBytes
    ? columns
    : chunkColumns * Math.max(1, Math.floor(context.budgetBytes / (bandRows * chunkColumns * itemBytes)));
  for (let band = 0; band * bandRows < rows; band++) {
    const r0 = band * bandRows;
    const r1 = Math.min(rows, r0 + bandRows);
    for (let c0 = 0; c0 < columns; c0 += groupColumns) {
      const c1 = Math.min(columns, c0 + groupColumns);
      steps.push({ selection: [[r0, r1], [c0, c1]], first: r0, last: r1, band, column: c0, width: c1 - c0, values: (r1 - r0) * (c1 - c0) });
    }
  }
  return steps;
}

/** Whether a failed read of `relative` leaves the element out (with a note) rather than failing the copy. */
function leftOutWhenUnreadable(relative) {
  return relative.startsWith('uns/') && !relative.startsWith('uns/cellucid');
}

/**
 * Copy one array, a step at a time (`copySteps`), the next step's read
 * under way while one is written. Nothing is declared before its first
 * read is in: an element of `uns` the reader cannot read (a codec the
 * browser lacks) is left out with a note; anything else unreadable fails
 * the copy with the reader's own words.
 */
async function copyArray(node, path, relative, context, anndata) {
  const { writer, readOptions } = context;
  if (relative.endsWith(`varm/${PREFIX_COUNTS_KEY}`) && anndata.countsWritten) return true;
  let dtype;
  let steps;
  let next;
  let chunks;
  let maxRows = Infinity;
  const shape = node.shape.map(Number);
  const { role, expression } = roleOf(relative, shape.length, anndata.isExpression);
  const readStep = step => {
    if (step.scalar) {
      if (Array.isArray(dtype)) return packRecords(node, dtype, null, null, readOptions, path);
      return node.read(undefined, readOptions).then(value => {
        if (dtype === '|O') return [String(value)];
        const one = asWritten([typeof value === 'boolean' ? Number(value) : value], dtype, path);
        return new Uint8Array(one.buffer, one.byteOffset, one.byteLength);
      });
    }
    if (Array.isArray(dtype)) return packRecords(node, dtype, step.first, step.last, readOptions, path);
    return node.read(step.selection, readOptions).then(values => asWritten(values, dtype, path));
  };
  try {
    dtype = node.dtype?.kind === 'compound' ? await recordDtypeOf(node, readOptions, context) : zarrV2Dtype(node.dtype);
    if (dtype === null) {
      context.notes.push(`${path} was left out: its ${node.dtype?.name ?? 'unknown'} values are of a type an AnnData Zarr store does not hold.`);
      return false;
    }
    const itemBytes = dtype === '|O' ? STRING_BYTES : itemSizeOf(dtype);
    // A dense matrix's band of every gene fits the budget, so each band of the source is read once.
    maxRows = role === 'gene-strips' && shape.length === 2 ? Math.max(1, Math.floor(context.budgetBytes / (Math.max(1, shape[1]) * itemBytes))) : Infinity;
    chunks = chunkShapeOf(role, shape, { maxRows });
    steps = copySteps(shape, chunks, itemBytes, context);
    next = steps.length === 0 ? null : await readStep(steps[0]);
    // Text: the rest in slabs of what its first slab's strings measured.
    if (dtype === '|O' && steps.length > 1 && !steps[0].scalar) {
      steps = [steps[0], ...copySteps(shape, chunks, textBytesOf(next), context, steps[0].last)];
    }
  } catch (error) {
    if (context.signal?.aborted || !leftOutWhenUnreadable(relative)) throw error;
    context.notes.push(`${path} was left out: ${error?.message ?? error}`);
    return false;
  }
  const out = writer.stream(path, { shape, dtype, role, expression, attrs: attributesOf(node, context), maxRows });
  for (let index = 0; index < steps.length; index++) {
    throwIfAborted(context.signal);
    const step = steps[index];
    const values = index === 0 ? next : await next;
    next = index + 1 < steps.length ? readStep(steps[index + 1]) : null;
    // A read under way when a write fails is let go, its failure with it.
    next?.catch(() => {});
    if (step.scalar) await out.writeChunk([], values);
    else if (step.band === undefined) await out.appendRows(values);
    else await out.writeColumnBlock(step.band, step.column, values, step.width);
    context.progress(step.values);
  }
  if (steps.length > 0 && !steps[0].scalar && steps[0].band === undefined) await out.end();
  return true;
}

/**
 * A Cellucid-ready MuData from a root presenting several modalities
 * (specification §5).
 */
async function copyMuData(root, modalities, nObs, context, { obsChanges, changes }) {
  const { writer, readOptions } = context;
  const names = modalities.map(modality => modality.name);
  const placed = key => names.some(name => key.startsWith(`${name}:`));
  const rootContext = { group: root, prefix: '', nRows: nObs, isExpression: () => false, prefixCounts: null };
  writer.group('', { ...encoding('MuData', '0.1.0'), axis: 0 });

  await copyUns(root.get('uns'), 'uns', context, { values: changes.uns, cellucid: changes.cellucid });
  await copyFrame(root.get('obs'), 'obs', context, { role: 'cell', changes: obsChanges, relative: 'obs', anndata: rootContext, skipColumn: placed });
  // What the view placed from the modalities (`<modality>:<key>`) is each modality's own, kept under `mod/`.
  const left = ['obs', 'obsm', 'obsp'].flatMap(element => {
    const group = root.get(element);
    const keys = isGroup(group) ? (element === 'obs' ? attributeValue(group, 'column-order') ?? [] : group.keys()) : [];
    return keys.filter(placed).map(key => `${element}['${key}']`);
  });
  if (left.length > 0) {
    context.notes.push(`${left.length === 1 ? left[0] : `${formatCountOf(left.length, 'element')} (${left.slice(0, 3).join(', ')}${left.length > 3 ? ', …' : ''})`} ` +
      `${left.length === 1 ? 'is' : 'are'} not written at the root: named <modality>:<key>, ${left.length === 1 ? 'it is' : 'they are'} ` +
      "the modality's own, kept in mod/<modality> as a Cellucid-ready MuData holds them.");
  }

  // Cell maps and masks, from what the view reads of `obsmap` (the cells' own rows without one).
  const maps = new Map();
  for (const modality of modalities) maps.set(modality.name, await cellMapOf(modality, nObs)(readOptions));
  writer.dict('obsm');
  const obsm = root.get('obsm');
  for (const key of isGroup(obsm) ? obsm.keys() : []) {
    if (placed(key) || names.includes(key)) continue;
    await copyNode(obsm.get(key), `obsm/${key}`, `obsm/${key}`, context, rootContext);
  }
  writer.dict('obsmap');
  for (const modality of modalities) {
    const { rows } = maps.get(modality.name);
    const mask = allocateTypedArray(Uint8Array, nObs, `obsm['${modality.name}']`);
    const map = allocateTypedArray(Uint32Array, nObs, `obsmap['${modality.name}']`);
    for (let cell = 0; cell < nObs; cell++) {
      const row = rows === null ? cell : rows[cell];
      mask[cell] = row >= 0 ? 1 : 0;
      map[cell] = row + 1;
    }
    await writer.array(`obsm/${modality.name}`, { values: mask, dtype: '|b1', shape: [nObs, 1], role: 'cell-rows' });
    await writer.array(`obsmap/${modality.name}`, { values: map, role: 'cell' });
  }
  writer.dict('obsp');
  const obsp = root.get('obsp');
  for (const key of isGroup(obsp) ? obsp.keys() : []) {
    if (placed(key)) continue;
    await copyNode(obsp.get(key), `obsp/${key}`, `obsp/${key}`, context, rootContext);
  }

  // The global var: every modality's features in order, and where each sits.
  const mod = root.get('mod');
  const groups = names.map(name => mod.get(name));
  const featureCounts = groups.map(group => frameRows(group.get('var')) ?? 0);
  const features = featureCounts.reduce((sum, count) => sum + count, 0);
  writer.group('var', { _index: '_index', 'column-order': [], ...encoding('dataframe', '0.2.0') });
  const index = writer.stream('var/_index', { shape: [features], dtype: '|O', role: 'whole', attrs: encoding('string-array', '0.2.0') });
  for (const group of groups) {
    const frame = group.get('var');
    const key = attributeValue(frame, '_index') ?? '_index';
    // The index's text: a string array, or a `nullable-string-array`'s values (an index holds no missing name).
    const stored = frame.get(key);
    const node = isGroup(stored) ? stored.get('values') : stored;
    const count = node.shape[0];
    // Slabs of the bytes the names measured so far.
    let perSlab = Math.max(1, Math.floor(context.slabBytes / STRING_BYTES));
    for (let first = 0; first < count;) {
      throwIfAborted(context.signal);
      const names = Array.from(await node.read([[first, Math.min(count, first + perSlab)]], readOptions), String);
      await index.appendRows(names);
      first += names.length;
      perSlab = Math.max(1, Math.floor(context.slabBytes / textBytesOf(names)));
    }
  }
  await index.end();
  writer.dict('varmap');
  let offset = 0;
  for (let m = 0; m < names.length; m++) {
    const map = allocateTypedArray(Uint32Array, features, `varmap['${names[m]}']`);
    for (let feature = 0; feature < featureCounts[m]; feature++) map[offset + feature] = feature + 1;
    offset += featureCounts[m];
    await writer.array(`varmap/${names[m]}`, { values: map, role: 'whole' });
  }
  writer.dict('varm');
  writer.dict('varp');

  writer.group('mod', { ...attributesOf(mod, context), 'mod-order': names });
  const { varModality } = changes;
  for (let m = 0; m < names.length; m++) {
    await copyAnnData(groups[m], `mod/${names[m]}`, context, {
      nRows: modalities[m].nCells,
      varChanges: names[m] === varModality ? changes.var : [],
    });
  }
}
