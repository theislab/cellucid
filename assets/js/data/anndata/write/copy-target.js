/**
 * What a copy of the open dataset is planned against, read from the store
 * as stored (every cell, whichever are open): its obs columns in order, the
 * values of the columns the plan asks for (each by original position, as
 * every change of a copy names a cell), and its `uns['cellucid']`. The apply
 * plan of "Save AnnData with this state…" (`app/history/exports/anndata-copy.js`)
 * reads these as Python's and R's apply read an object: a renamed
 * category's column whole, a column an earlier apply wrote to compare.
 *
 * Columns come in the form `element-writer.js` `column()` writes them, so a
 * column a copy wrote reads back as the column it was given: a categorical
 * `{kind: 'categorical', codes, categories, ordered}` (categories as the file
 * stores them: text, or numbers), text `{kind: 'strings', values}`,
 * numbers `{kind: 'numbers', values}` (a typed array of the stored type),
 * `{kind: 'booleans', values: Uint8Array}`, a nullable integer or boolean
 * `{kind, values, mask}`. A column of another encoding is `{kind: 'other'}`.
 *
 * @module data/anndata/write/copy-target
 */

import { isArrayNode, isGroup } from '../../../formats/store.js';
import { attributeValue, encodingType, valueKind } from '../elements.js';
import { currentLayoutView, isOlderAnnDataLayout } from '../older-layouts.js';
import { frameRows } from '../views/modalities.js';
import { readPriorityLayout } from '../priority-layout.js';
import { readUnsCellucid, readUnsCellucidRecords } from '../reader.js';
import { zarrV2Dtype } from '../../../formats/zarr/format-v2.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { throwIfAborted } from '../../../utils/abort.js';

/** Values at file rows put at original positions: `out[order[row]] = values[row]`. */
function inOriginalOrder(values, order, label) {
  if (order === null) return values;
  const out = ArrayBuffer.isView(values) ? allocateTypedArray(values.constructor, values.length, label) : new Array(values.length);
  for (let row = 0; row < order.length; row++) out[order[row]] = values[row];
  return out;
}

const asFlags = values => (values instanceof Uint8Array ? values : Uint8Array.from(values, value => (value ? 1 : 0)));

/** One obs column node as a copy writes columns, its rows at original positions. */
async function readColumn(node, order, label, readOptions) {
  if (isGroup(node)) {
    const type = encodingType(node);
    if (type === 'categorical') {
      const [categories, codes] = await Promise.all([
        node.get('categories').read(undefined, readOptions),
        node.get('codes').read(undefined, readOptions),
      ]);
      return {
        kind: 'categorical',
        categories: Array.from(categories),
        codes: inOriginalOrder(codes, order, label),
        ordered: attributeValue(node, 'ordered') === true,
      };
    }
    if (type === 'nullable-integer' || type === 'nullable-boolean') {
      const [values, mask] = await Promise.all([
        node.get('values').read(undefined, readOptions),
        node.get('mask').read(undefined, readOptions),
      ]);
      return {
        kind: type,
        values: inOriginalOrder(type === 'nullable-boolean' ? asFlags(values) : values, order, label),
        mask: inOriginalOrder(asFlags(mask), order, label),
      };
    }
    return { kind: 'other' };
  }
  if (!isArrayNode(node) || node.shape.length !== 1) return { kind: 'other' };
  const dtype = zarrV2Dtype(node.dtype);
  const values = await node.read(undefined, readOptions);
  if (dtype === '|O') return { kind: 'strings', values: inOriginalOrder(Array.from(values, value => value ?? null), order, label) };
  if (dtype === '|b1') return { kind: 'booleans', values: inOriginalOrder(asFlags(values), order, label) };
  if (!ArrayBuffer.isView(values)) return { kind: 'other' };
  return { kind: 'numbers', values: inOriginalOrder(values, order, label) };
}

/**
 * A column's colors as Scanpy keeps them, `uns['<column>_colors']`, when
 * they are its form (one-dimensional text); null for none, or for another
 * form (which a copy does not carry: `app/history/exports/anndata-copy.js`).
 */
async function readTextColors(unsNode, name, readOptions) {
  const node = isGroup(unsNode) && unsNode.has(`${name}_colors`) ? unsNode.get(`${name}_colors`) : null;
  if (!isArrayNode(node) || node.shape?.length !== 1 || valueKind(node) !== 'string') return null;
  return Array.from(await node.read(undefined, readOptions), String);
}

/**
 * The obs columns of the store at `source` (a MuData's global obs: the
 * columns placed from its modalities, `<modality>:<key>`, apart), the
 * values of the columns `names` lists that it has, its root `uns` keys, the
 * colors of the columns `colors` lists (`uns['<column>_colors']` as text, or
 * null), and its `uns['cellucid']`.
 *
 * Also the columns of the var frame a copy's var changes go to (`varModality`'s
 * in a MuData, as `copy.js` `CopyChanges` names it; the root's otherwise).
 *
 * @param {Object} source - The store root as stored (`AnnDataReader.storedRoot`)
 * @param {string[]} names - The obs columns whose values the plan reads
 * @param {{signal?: AbortSignal|null, activity?: Object|null}} [readOptions]
 * @param {{varModality?: string|null, colors?: string[]}} [options]
 * @returns {Promise<{nObs: number, obsColumns: string[], modalityColumns: string[], varColumns: string[],
 *   columns: Record<string, Object>, unsKeys: string[], colors: Record<string, string[]|null>, cellucid: Object|null}>}
 */
export async function readCopyTarget(source, names, readOptions = {}, { varModality = null, colors: colorsOf = [] } = {}) {
  if (!isGroup(source)) throw new TypeError('A copy is planned against a store root group.');
  const root = isOlderAnnDataLayout(source) ? await currentLayoutView(source, readOptions) : source;
  await root.load(undefined, readOptions);
  const obs = root.get('obs');
  const nObs = frameRows(obs);
  if (nObs === null) throw new Error('The dataset has no obs to copy.');
  const modalities = Array.isArray(root.modalities) && isGroup(root.get('mod')) ? root.modalities.map(modality => modality.name) : [];
  const placed = name => modalities.some(modality => name.startsWith(`${modality}:`));
  const declared = attributeValue(obs, 'column-order');
  const stored = (Array.isArray(declared) ? declared.map(String) : []).filter(name => obs.has(name));
  const obsColumns = stored.filter(name => !placed(name));
  const unsNode = root.get('uns');
  const cellucidNode = isGroup(unsNode) ? unsNode.get('cellucid') : null;
  // The record as opening reads it, with the packages' records opening leaves unread (earlier applies, gene sets).
  const cellucid = isGroup(cellucidNode)
    ? { ...await readUnsCellucid(cellucidNode, readOptions), ...await readUnsCellucidRecords(cellucidNode, readOptions) }
    : null;
  const wanted = [...new Set(names)].filter(name => obsColumns.includes(name));
  const columns = {};
  if (wanted.length > 0) {
    const { layout } = await readPriorityLayout(root, nObs, readOptions);
    const order = layout === null ? null : await layout.order();
    for (const name of wanted) {
      throwIfAborted(readOptions.signal ?? null);
      columns[name] = await readColumn(obs.get(name), order, `obs column '${name}'`, readOptions);
    }
  }
  const modality = modalities.length === 0 ? null : varModality ?? root.defaultModality ?? modalities[0];
  const varFrame = modality === null ? root.get('var') : root.get(`mod/${modality}/var`);
  const varOrder = isGroup(varFrame) ? attributeValue(varFrame, 'column-order') : null;
  const varColumns = Array.isArray(varOrder) ? varOrder.map(String) : [];
  const unsKeys = isGroup(unsNode) ? unsNode.keys().map(String) : [];
  const colors = {};
  for (const name of new Set(colorsOf)) {
    throwIfAborted(readOptions.signal ?? null);
    colors[name] = await readTextColors(unsNode, name, readOptions);
  }
  return { nObs, obsColumns, modalityColumns: stored.filter(placed), varColumns, columns, unsKeys, colors, cellucid };
}
