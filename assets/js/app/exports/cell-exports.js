/**
 * @fileoverview What a person made in the viewer, exported for an analysis
 * outside it, with no notebook: Python's `cellucid.pull(adata, path)` and R's
 * `cellucid_pull(object, path)` read every one of these files back in one
 * call.
 *
 * - **A page's highlight groups as an obs-column CSV**: one column per
 *   highlight group of the page, `cellucid_highlight__<group id>`, of kind
 *   `highlight`, each `true` or `false`; a row per open cell.
 * - **A field as an obs-column CSV**: the field's values under its name, of
 *   kind `categorical` (its labels) or `continuous` (its numbers), empty
 *   where a cell has none; a row per open cell.
 *
 *   An obs-column CSV declares itself: a header row (`obs_name`, then each
 *   column's name), a kind row (`kind`, then each column's kind), then a
 *   row per cell, named by obs name. A reader never guesses a column's kind
 *   from its values (labels `0`, `1`, `10` stay labels; `True`/`False`
 *   labels stay labels), and a cell the file does not list is unknown --
 *   a subsample's unopened cells. (`tests/fixtures/obs-columns.csv` pins the
 *   format for the web app, Python and R.)
 * - **Highlighted cells as an `.h5ad` subset** (`formats/hdf5/writer.js`):
 *   the cells' obs names and every obs field (user-defined ones included),
 *   each highlight group as a boolean column, the genes, the rows of the
 *   expression matrix the data mapping reads (CSR, float32), and the
 *   embeddings the mapping shows; continuous fields and embeddings keep
 *   their float32 or float64. A key HDF5 cannot name (a "/" in it, or ".")
 *   is written renamed, and the export says which (`renamed`). anndata,
 *   cellucid-python, R and Cellucid itself read it.
 *
 * Cells are named by obs name, read from the file when an export asks (the
 * viewer never holds them otherwise), and every export lists them ascending
 * by original position (`data/cell-identity.js`): the order of the dataset's
 * own obs, whatever order the file stores them in (a priority-ordered file)
 * or the app opened them in (a subsample) -- the order Python's
 * `viewer.subset()` and R's `cellucid_subset()` give. An export of a
 * subsample names the cells it holds. The genes of an `.h5ad` are its var
 * index, the identifiers every boundary names a gene by (`geneIdentities`),
 * with the name the viewer shows beside each in `var['symbol']` when the
 * two differ. The matrix rows of a large subset are written to a file in
 * this browser's private storage as they are read (`createSpool`), so the
 * export holds one batch of rows at a time.
 *
 * @module app/exports/cell-exports
 */

import { downloadBlob } from '../utils/download.js';
import {
  booleanAttribute,
  group,
  numericDataset,
  stringDataset,
  writeHdf5,
} from '../../formats/hdf5/writer.js';
import { FieldKind } from '../utils/field-constants.js';
import { geneIdentities } from '../analysis/shared/gene-sets.js';
import { allocateLargeArray } from '../../utils/large-arrays.js';

/** The first column of an obs-column CSV. */
export const OBS_NAME_COLUMN = 'obs_name';
/** The first cell of an obs-column CSV's kind row. */
export const KIND_ROW = 'kind';
/** What a column of an obs-column CSV holds. */
export const CSV_KINDS = Object.freeze(['highlight', 'categorical', 'continuous']);
/** A highlight group's column, as `pull` in Python and R names it. */
export const HIGHLIGHT_COLUMN_PREFIX = 'cellucid_highlight__';
/** Cells whose matrix rows are read at once for an `.h5ad`. */
const ROW_BATCH = 4096;
/** The private-storage files of exports: this page's, and earlier pages' (removed). */
const SPOOL_PREFIX = 'cellucid-export-';
const SPOOL_SESSION = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const ENCODING = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/** One CSV cell, quoted when it holds a comma, a quote or a line break. */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The open cells of a highlight page: every enabled group's cells, once,
 * ascending; and the page's groups, each with its cells.
 */
export function pageCells(state, pageId) {
  const page = state.getHighlightPages().find(candidate => candidate.id === pageId);
  if (page === undefined) throw new Error('That highlight page is gone.');
  const groups = page.highlightedGroups.filter(entry => entry.enabled === true);
  const member = new Uint8Array(state.pointCount);
  for (const entry of groups) for (const cell of entry.cellIndices) member[cell] = 1;
  let count = 0;
  for (let cell = 0; cell < member.length; cell++) count += member[cell];
  const cells = new Uint32Array(count);
  let at = 0;
  for (let cell = 0; cell < member.length; cell++) if (member[cell] === 1) cells[at++] = cell;
  return { page, groups, cells };
}

/**
 * Open cells (open positions) in ascending original position, as every
 * export lists them: `cells` (any order), or every open cell when null.
 *
 * @param {Object} state - Holds the open dataset's `cellIdentity`
 * @param {Uint32Array|null} cells
 * @returns {Uint32Array}
 */
export function inOriginalOrder(state, cells = null) {
  const identity = state.cellIdentity;
  if (cells === null) {
    const order = identity.ascendingOrder;
    return order !== null ? order.toOpen : Uint32Array.from({ length: identity.n }, (_, i) => i);
  }
  if (identity.openOrder === null) return cells;
  return Uint32Array.from(cells).sort((a, b) => identity.originalAt(a) - identity.originalAt(b));
}

/** Each group's membership of `cells`, as 0/1 bytes in `cells` order. */
function groupMembership(groups, cells, pointCount) {
  const positionOf = new Int32Array(pointCount).fill(-1);
  cells.forEach((cell, index) => { positionOf[cell] = index; });
  return groups.map(entry => {
    const flags = new Uint8Array(cells.length);
    for (const cell of entry.cellIndices) flags[positionOf[cell]] = 1;
    return { entry, flags };
  });
}

/**
 * An obs-column CSV as a Blob: its header and kind rows, then `rowCount`
 * rows, built in pieces so millions of rows are never one string.
 *
 * @param {Array<[string, string]>} columns - Each column's name and kind
 */
function csvBlob(columns, rowCount, rowAt) {
  for (const [, kind] of columns) {
    if (!CSV_KINDS.includes(kind)) throw new TypeError(`An obs-column CSV column is of kind ${CSV_KINDS.join(', ')}`);
  }
  const header = [OBS_NAME_COLUMN, ...columns.map(([name]) => name)];
  const kinds = [KIND_ROW, ...columns.map(([, kind]) => kind)];
  const parts = [`${header.map(csvCell).join(',')}\n${kinds.join(',')}\n`];
  let piece = '';
  for (let row = 0; row < rowCount; row++) {
    piece += `${rowAt(row)}\n`;
    if (piece.length > 1 << 20) {
      parts.push(piece);
      piece = '';
    }
  }
  parts.push(piece);
  return new Blob(parts, { type: 'text/csv' });
}

/**
 * A page's highlight groups as an obs-column CSV: a row per open cell, a
 * `highlight` column per enabled group.
 *
 * @param {{state: Object, adapter: Object, pageId: string}} options
 * @returns {Promise<{blob: Blob, filename: string, cells: number}>}
 */
export async function highlightsCsv({ state, adapter, pageId }) {
  const { page, groups, cells } = pageCells(state, pageId);
  if (cells.length === 0) throw new Error('No cells are highlighted on this page.');
  const names = await adapter.getObsNames();
  const every = inOriginalOrder(state);
  const memberships = groupMembership(groups, every, state.pointCount);
  const columns = groups.map(entry => [`${HIGHLIGHT_COLUMN_PREFIX}${entry.id}`, 'highlight']);
  const blob = csvBlob(columns, every.length, row => [
    csvCell(names[every[row]]),
    ...memberships.map(({ flags }) => (flags[row] === 1 ? 'true' : 'false')),
  ].join(','));
  return { blob, filename: `${fileStem(page.name)}_cells.csv`, cells: cells.length };
}

/**
 * One obs field as an obs-column CSV: every open cell, its value.
 *
 * @param {{state: Object, adapter: Object, fieldIndex: number}} options
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function fieldCsv({ state, adapter, fieldIndex }) {
  const field = await state.ensureFieldLoaded(fieldIndex);
  const names = await adapter.getObsNames();
  const valueAt = columnReader(field);
  const kind = field.kind === FieldKind.CATEGORY ? 'categorical' : 'continuous';
  const every = inOriginalOrder(state);
  const blob = csvBlob([[field.key, kind]], every.length, row => `${csvCell(names[every[row]])},${csvCell(valueAt(every[row]))}`);
  return { blob, filename: `${fileStem(field.key)}.csv` };
}

/** A field's value at a cell, as CSV text holds it (empty for none). */
function columnReader(field) {
  if (field.kind === FieldKind.CATEGORY) {
    const missing = 2 ** (8 * field.codes.BYTES_PER_ELEMENT) - 1;
    return row => {
      const code = field.codes[row];
      return code === missing || code >= field.categories.length ? '' : field.categories[code];
    };
  }
  return row => {
    const value = field.values[row];
    return Number.isFinite(value) ? value : '';
  };
}

function fileStem(name) {
  const stem = String(name).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
  return stem.length > 0 ? stem : 'cellucid';
}

/**
 * The name a column (or embedding) takes in the `.h5ad`, and why it differs
 * from its key: an HDF5 link name holds no "/" and is never "." (AnnData
 * refuses both as keys), so each "/" is written "_", "." is written "_", and
 * a name taken already gets "_2", "_3"... `renamed` collects each change, which
 * the export reports.
 */
export function columnName(key, taken, renamed = null) {
  let name = String(key).replace(/\//g, '_');
  if (name.length === 0 || name === '.') name = '_';
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}_${n}`;
  taken.add(candidate);
  if (candidate !== String(key)) renamed?.push({ key: String(key), name: candidate });
  return candidate;
}

/**
 * A place to write a large dataset's bytes as they come: a file in this
 * browser's origin-private storage when the browser offers one to a page,
 * else memory. `finish()` returns the bytes as a Blob (the file itself, read
 * from disk as the download streams it). The files of an earlier page's
 * exports are removed when the next one starts: a download reads its file
 * after the export returns.
 */
export async function createSpool(name) {
  let directory = null;
  try {
    directory = typeof navigator !== 'undefined' && navigator.storage?.getDirectory
      ? await navigator.storage.getDirectory()
      : null;
  } catch {
    directory = null;
  }
  if (directory !== null) {
    // An earlier export's files, read by its download long since.
    try {
      for await (const [entry] of directory.entries()) {
        if (entry.startsWith(SPOOL_PREFIX) && !entry.includes(`-${SPOOL_SESSION}-`)) {
          await directory.removeEntry(entry).catch(() => {});
        }
      }
    } catch {
      // Listing is optional: what is left is removed by a later export.
    }
    try {
      const fileName = `${SPOOL_PREFIX}${SPOOL_SESSION}-${name}-${Math.random().toString(36).slice(2)}`;
      const handle = await directory.getFileHandle(fileName, { create: true });
      if (typeof handle.createWritable === 'function') {
        const writable = await handle.createWritable();
        let size = 0;
        return {
          async write(bytes) {
            size += bytes.byteLength;
            await writable.write(bytes);
          },
          async finish() {
            await writable.close();
            const file = await handle.getFile();
            if (file.size !== size) throw new Error('The export could not be written to this browser\'s storage.');
            return file;
          },
        };
      }
      await directory.removeEntry(fileName).catch(() => {});
    } catch {
      // This page has no writable private storage (a private window): memory.
    }
  }
  const parts = [];
  return {
    async write(bytes) {
      parts.push(new Blob([bytes]));
    },
    async finish() {
      return new Blob(parts);
    },
  };
}

function littleEndian(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * The highlighted cells of a page as an `.h5ad` subset.
 *
 * @param {{state: Object, adapter: Object, pageId: string,
 *   onProgress?: (done: number, total: number) => void, signal?: AbortSignal|null}} options
 * @returns {Promise<{blob: Blob, filename: string, cells: number,
 *   renamed: Array<{key: string, name: string}>}>}
 */
export async function highlightsH5ad({ state, adapter, pageId, onProgress = () => {}, signal = null }) {
  const { page, groups, cells: highlighted } = pageCells(state, pageId);
  if (highlighted.length === 0) throw new Error('No cells are highlighted on this page.');
  const cells = inOriginalOrder(state, highlighted);
  const n = cells.length;
  const names = await adapter.getObsNames();
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The export was cancelled.', 'AbortError');
  };

  // obs: every field the viewer shows, then each group of the page.
  const taken = new Set(['_index']);
  /** @type {Array<{key: string, name: string}>} Keys written under another name. */
  const renamed = [];
  const columns = [];
  const fields = state.getFields() ?? [];
  for (let index = 0; index < fields.length; index++) {
    if (fields[index]?._isDeleted === true) continue;
    throwIfAborted();
    const field = await state.ensureFieldLoaded(index);
    const name = columnName(field.key, taken, renamed);
    if (field.kind === FieldKind.CATEGORY) {
      const missing = 2 ** (8 * field.codes.BYTES_PER_ELEMENT) - 1;
      const count = field.categories.length;
      const [type, ArrayType] = count < 128 ? ['int8', Int8Array] : count < 32768 ? ['int16', Int16Array] : ['int32', Int32Array];
      const codes = new ArrayType(n);
      for (let row = 0; row < n; row++) {
        const code = field.codes[cells[row]];
        codes[row] = code === missing ? -1 : code;
      }
      columns.push([name, group({ ...ENCODING('categorical', '0.2.0'), ordered: booleanAttribute(false) }, [
        ['codes', numericDataset(type, [n], codes, ENCODING('array', '0.2.0'))],
        ['categories', stringDataset(field.categories.map(String), ENCODING('string-array', '0.2.0'))],
      ])]);
    } else if (ArrayBuffer.isView(field.values)) {
      // As the viewer holds it: float64 stays float64.
      const [type, ArrayType] = field.values instanceof Float64Array ? ['float64', Float64Array] : ['float32', Float32Array];
      const values = new ArrayType(n);
      for (let row = 0; row < n; row++) values[row] = field.values[cells[row]];
      columns.push([name, numericDataset(type, [n], values, ENCODING('array', '0.2.0'))]);
    }
  }
  for (const { entry, flags } of groupMembership(groups, cells, state.pointCount)) {
    const name = columnName(`${HIGHLIGHT_COLUMN_PREFIX}${entry.id}`, taken, renamed);
    columns.push([name, numericDataset('bool', [n], flags, ENCODING('array', '0.2.0'))]);
  }
  const obs = group(
    { ...ENCODING('dataframe', '0.2.0'), _index: '_index', 'column-order': columns.map(([name]) => name) },
    [['_index', stringDataset(Array.from(cells, cell => names[cell]), ENCODING('string-array', '0.2.0'))], ...columns]
  );

  // var and X: the genes and rows of the matrix the data mapping reads,
  // once a dataset just shown has listed them (after its first view).
  await state.whenGenesListed();
  throwIfAborted();
  const genes = state.varData?.fields ?? [];
  const identities = geneIdentities(state.varData);
  const geneNames = genes.map(field => String(field.key));
  const geneIds = geneNames.map(name => String(identities.idOf(name)));
  const children = [];
  if (genes.length > 0) {
    const data = await createSpool('data');
    const indices = await createSpool('indices');
    const indptr = new BigInt64Array(n + 1);
    let stored = 0;
    for (let start = 0; start < n; start += ROW_BATCH) {
      throwIfAborted();
      const batch = cells.subarray(start, Math.min(n, start + ROW_BATCH));
      const rows = await adapter.getMatrixRowsOf(genes[0].path, batch, { signal });
      let batchStored = 0;
      for (const row of rows) batchStored += row.genes.length;
      const batchValues = new Float32Array(batchStored);
      const batchIndices = new Int32Array(batchStored);
      let at = 0;
      rows.forEach((row, offset) => {
        // Genes ascending in each row, as a CSR matrix keeps them.
        let ascending = true;
        for (let k = 1; k < row.genes.length; k++) if (row.genes[k] <= row.genes[k - 1]) { ascending = false; break; }
        const order = ascending ? null : Array.from(row.genes.keys()).sort((a, b) => row.genes[a] - row.genes[b]);
        for (let k = 0; k < row.genes.length; k++) {
          const pick = order === null ? k : order[k];
          batchIndices[at] = row.genes[pick];
          batchValues[at] = row.values[pick];
          at++;
        }
        stored += row.genes.length;
        indptr[start + offset + 1] = BigInt(stored);
      });
      await data.write(littleEndian(batchValues));
      await indices.write(littleEndian(batchIndices));
      onProgress(Math.min(n, start + ROW_BATCH), n);
    }
    children.push(['X', group({ ...ENCODING('csr_matrix', '0.1.0'), shape: BigInt64Array.of(BigInt(n), BigInt(genes.length)) }, [
      ['data', numericDataset('float32', [stored], await data.finish())],
      ['indices', numericDataset('int32', [stored], await indices.finish())],
      ['indptr', numericDataset('int64', [n + 1], indptr)],
    ])]);
  }
  // The var index is the genes' identifiers; the names shown beside them
  // when they differ (a CELLxGENE file: Ensembl ids, symbols shown).
  const symbols = geneIds.some((id, g) => id !== geneNames[g]);
  const variables = group(
    { ...ENCODING('dataframe', '0.2.0'), _index: '_index', 'column-order': symbols ? ['symbol'] : [] },
    [
      ['_index', stringDataset(geneIds, ENCODING('string-array', '0.2.0'))],
      ...(symbols ? [['symbol', stringDataset(geneNames, ENCODING('string-array', '0.2.0'))]] : []),
    ]
  );

  // obsm: the embeddings the mapping shows, their columns as stored.
  const embeddings = new Map();
  for (const { key, columns: picked } of state.getDataMapping()?.embeddings?.enabled ?? []) {
    const union = new Set([...(embeddings.get(key) ?? []), ...picked]);
    embeddings.set(key, [...union].sort((a, b) => a - b));
  }
  const obsm = [];
  const obsmTaken = new Set();
  for (const [key, picked] of embeddings) {
    throwIfAborted();
    const values = await adapter.getObsmColumns(key, picked, { signal });
    const width = picked.length;
    // As stored: the reader hands float32 columns as float32, any other type as float64.
    const [type, ArrayType] = values instanceof Float64Array ? ['float64', Float64Array] : ['float32', Float32Array];
    const out = allocateLargeArray(ArrayType, n * width);
    for (let row = 0; row < n; row++) {
      for (let column = 0; column < width; column++) out[row * width + column] = values[cells[row] * width + column];
    }
    obsm.push([columnName(key, obsmTaken, renamed), numericDataset(type, [n, width], out, ENCODING('array', '0.2.0'))]);
  }

  const root = group(ENCODING('anndata', '0.1.0'), [
    ['obs', obs],
    ['var', variables],
    ...children,
    ['obsm', group(ENCODING('dict', '0.1.0'), obsm)],
    ['uns', group(ENCODING('dict', '0.1.0'), [])],
  ]);
  return { blob: writeHdf5(root), filename: `${fileStem(page.name)}_cells.h5ad`, cells: n, renamed };
}

/**
 * Hand an export to the browser (the app's one download path). Its private
 * storage stays until the page's next export, or the next page's: the
 * browser reads the file while it downloads.
 */
export function saveExport({ blob, filename }) {
  downloadBlob(blob, filename);
}
