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
 *   column's name), a kind row (`kind`, then each column's kind), a
 *   categories row (`categories`, then each `categorical` column's
 *   categories in the field's order as a JSON array of strings, empty for
 *   the other kinds), then a row per cell, named by obs name. A reader
 *   never guesses a column's kind from its values (labels `0`, `1`, `10`
 *   stay labels; `True`/`False` labels stay labels), never orders a
 *   categorical's categories by the rows (a trajectory's order, a category
 *   no cell holds, come back as the field has them), and a cell the file
 *   does not list is unknown -- a subsample's unopened cells.
 *   (`tests/fixtures/obs-columns.csv` pins the format for the web app,
 *   Python and R.)
 * - **Highlighted cells as an `.h5ad` subset** (`formats/hdf5/writer.js`):
 *   the cells' obs names and every obs field (user-defined ones included),
 *   each highlight group as a boolean column, the genes, the rows of the
 *   expression matrix the data mapping reads (CSR, float32), and the
 *   embeddings the mapping shows; continuous fields and embeddings keep
 *   their float32 or float64, a categorical its order flag, its categories
 *   in their own type (numbers stay numbers, booleans booleans) and its
 *   colors as `uns['<key>_colors']`. Only the highlighted cells' rows of
 *   the obs names and the embeddings (read as the cells listed, in the
 *   stored order) are read, and a field read
 *   for the export is let go again under the residency budget once its
 *   column is written, so a few cells of a 10M-cell dataset cost their rows,
 *   not every field and name of every cell. A key HDF5 cannot name (a "/"
 *   in it, or ".") is written renamed, and the export says which
 *   (`renamed`). anndata, cellucid-python, R and Cellucid itself read it.
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
 * two differ (a var column names the genes in Data mapping). The matrix
 * rows are one read of every cell (`readMatrixRowsOf`), its parts arriving
 * while the next is read, each written to a file in this browser's private
 * storage as it comes (`createSpool`), so the export holds a part of the
 * rows at a time and the link stays busy until the last.
 *
 * @module app/exports/cell-exports
 */

import { downloadBlob, safeFileName } from '../utils/download.js';
import {
  booleanAttribute,
  group,
  numericDataset,
  stringDataset,
  writeHdf5,
} from '../../formats/hdf5/writer.js';
import { FieldKind } from '../utils/field-constants.js';
import { geneIdentities } from '../analysis/shared/gene-sets.js';
import { orderByKey } from '../../utils/radix-order.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { releaseInactiveFieldsOverBudget } from '../state/managers/field/residency.js';
import { throwIfAborted } from '../../utils/abort.js';
import { hexOfRgb01 } from '../../utils/hex-color.js';
import { portableElementName } from '../../data/anndata/write/names.js';
import { csvText } from '../analysis/compute/csv-export.js';
import { openFileWritable } from '../../utils/file-writable.js';

/** The first column of an obs-column CSV. */
export const OBS_NAME_COLUMN = 'obs_name';
/** The first cell of an obs-column CSV's kind row. */
export const KIND_ROW = 'kind';
/** The first cell of an obs-column CSV's categories row. */
export const CATEGORIES_ROW = 'categories';
/** What a column of an obs-column CSV holds. */
export const CSV_KINDS = Object.freeze(['highlight', 'categorical', 'continuous']);
/** A highlight group's column, as `pull` in Python and R names it. */
export const HIGHLIGHT_COLUMN_PREFIX = 'cellucid_highlight__';
/** The private-storage files of exports: this page's, and earlier pages' (removed). */
const SPOOL_PREFIX = 'cellucid-export-';
const SPOOL_SESSION = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const ENCODING = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/** One CSV cell, quoted when it holds a comma, a quote or a line break. */
export function csvCell(value) {
  return csvText(value === null || value === undefined ? '' : String(value));
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
 * export lists them: `cells` (ascending open positions), or every open cell
 * when null. Ordered by a radix sort of the original positions, so millions
 * of cells cost two linear passes, never a comparator call per comparison
 * or an object per cell.
 *
 * @param {Object} state - Holds the open dataset's `cellIdentity`
 * @param {Uint32Array|null} cells
 * @returns {Uint32Array}
 */
export function inOriginalOrder(state, cells = null) {
  const identity = state.cellIdentity;
  if (cells === null) {
    const order = identity.ascendingOrder;
    if (order !== null) return order.toOpen;
    const every = new Uint32Array(identity.n);
    for (let i = 0; i < every.length; i++) every[i] = i;
    return every;
  }
  if (identity.openOrder === null) return cells;
  const originals = new Uint32Array(cells.length);
  for (let i = 0; i < originals.length; i++) originals[i] = identity.originalAt(cells[i]);
  const rank = orderByKey(originals);
  const ordered = new Uint32Array(rank.length);
  for (let row = 0; row < rank.length; row++) ordered[row] = cells[rank[row]];
  return ordered;
}

/** Each group's membership of `cells`, as 0/1 bytes in `cells` order. */
function groupMembership(groups, cells, pointCount) {
  const positionOf = new Int32Array(pointCount).fill(-1);
  for (let index = 0; index < cells.length; index++) positionOf[cells[index]] = index;
  return groups.map(entry => {
    const flags = new Uint8Array(cells.length);
    for (const cell of entry.cellIndices) flags[positionOf[cell]] = 1;
    return { entry, flags };
  });
}

/** Rows of an obs-column CSV made at once: a few MB of text, then a yield. */
const CSV_BATCH = 1 << 16;
/** Batches whose names are read while one is made: the page holds their names too. */
const CSV_READ_AHEAD = 2;

/**
 * The obs names of `cells` (open positions, in the export's order) a batch
 * at a time: `namesAt(start, end)` names `cells[start, end)`. Consecutive
 * open positions (a file in its own order, a subsample of one) are read as
 * their range; ascending ones (a uniform share of a file in its own order)
 * as the cells listed, their rows read in the stored order
 * (`getObsNames({cells})`), the page holding a batch's names. More than a
 * batch listed out of the stored order (a file in priority order, or opened
 * in a subsample's order, listed by original position) is named from one
 * range read of the open cells' names, each name chunk read once.
 *
 * @param {Object} adapter
 * @param {Uint32Array} cells
 * @returns {(start: number, end: number) => Promise<string[]>}
 */
function obsNamesOf(adapter, cells) {
  let consecutive = true;
  let ascending = true;
  let last = 0;
  for (let i = 0; i < cells.length; i++) {
    if (i > 0) {
      consecutive &&= cells[i] === cells[i - 1] + 1;
      ascending &&= cells[i] > cells[i - 1];
    }
    if (cells[i] > last) last = cells[i];
  }
  if (consecutive) {
    return async (start, end) => (end > start ? adapter.getObsNames({ rows: [cells[start], cells[end - 1] + 1] }) : []);
  }
  if (!ascending && cells.length > CSV_BATCH) {
    // Listed out of the stored order (every cell of a file in priority
    // order, or opened in a subsample's order, listed by original
    // position): each batch's cells lie throughout the file, so batch by
    // batch every name chunk would be read again (measured:
    // 25_decisions_exports.md). The names of the open cells up
    // to the last listed are read once, as one range in the stored order,
    // and the batches named from them.
    let read = null;
    return async (start, end) => {
      read ??= adapter.getObsNames({ rows: [0, last + 1] });
      const names = await read;
      return Array.from(cells.subarray(start, end), cell => names[cell]);
    };
  }
  return async (start, end) => (end > start ? adapter.getObsNames({ cells: cells.subarray(start, end) }) : []);
}

/**
 * An obs-column CSV as a Blob: its header, kind and categories rows, then a row per
 * cell of `cells` (open positions, in order), named by obs name, built a
 * batch at a time with a yield between batches (no long task, no string of
 * millions of rows), reporting progress and stopping at `signal`. Each
 * batch is written out as it is made (`createSpool`: this browser's private
 * storage, else memory as Blobs), so the page holds one batch of text, never
 * the file. After the first batch, `onProgress` also says about how large
 * the file will be (its bytes a row so far, times its rows), before the rest
 * is written.
 *
 * @param {Array<[string, string, ReadonlyArray<string|number|boolean>?]>} columns -
 *   Each column's name, kind and, for a `categorical` column (only), its
 *   categories in the field's order (written as text, as its cells are)
 * @param {Object} adapter
 * @param {Uint32Array} cells
 * @param {(row: number, cell: number) => string} valuesAt - Row `row`'s
 *   values after its name, comma-separated
 * @param {{onProgress?: (done: number, total: number, expectedBytes: number) => void, signal?: AbortSignal|null}} [options]
 */
async function csvBlob(columns, adapter, cells, valuesAt, { onProgress = () => {}, signal = null } = {}) {
  for (const [, kind, categories] of columns) {
    if (!CSV_KINDS.includes(kind)) throw new TypeError(`An obs-column CSV column is of kind ${CSV_KINDS.join(', ')}`);
    if ((kind === 'categorical') !== Array.isArray(categories)) {
      throw new TypeError('An obs-column CSV lists the categories of each categorical column, and of no other');
    }
  }
  const header = [OBS_NAME_COLUMN, ...columns.map(([column]) => column)];
  const kinds = [KIND_ROW, ...columns.map(([, kind]) => kind)];
  const categoryLists = [
    CATEGORIES_ROW,
    ...columns.map(([, , categories]) => (categories === undefined ? '' : JSON.stringify(categories.map(String)))),
  ];
  const encoder = new TextEncoder();
  const spool = await createSpool('csv');
  const head = encoder.encode(`${[header.map(csvCell), kinds, categoryLists.map(csvCell)].map(row => row.join(',')).join('\n')}\n`);
  await spool.write(head);
  let written = head.byteLength;
  const namesAt = obsNamesOf(adapter, cells);
  // The next batches' names are asked for while this one is made and
  // written (`CSV_READ_AHEAD`): each read waits on the link for its
  // references and then its strings, and asked one after another the link
  // idles between them (measured: 25_decisions_exports.md).
  const asked = [];
  const ask = start => {
    if (start >= cells.length) return;
    const read = namesAt(start, Math.min(cells.length, start + CSV_BATCH));
    read.catch(() => {});
    asked.push(read);
  };
  for (let k = 0; k <= CSV_READ_AHEAD; k++) ask(k * CSV_BATCH);
  for (let start = 0; start < cells.length; start += CSV_BATCH) {
    throwIfAborted(signal);
    const end = Math.min(cells.length, start + CSV_BATCH);
    const names = await asked.shift();
    ask(start + (CSV_READ_AHEAD + 1) * CSV_BATCH);
    const lines = new Array(end - start);
    for (let row = start; row < end; row++) lines[row - start] = `${csvCell(names[row - start])},${valuesAt(row, cells[row])}`;
    const bytes = encoder.encode(`${lines.join('\n')}\n`);
    await spool.write(bytes);
    written += bytes.byteLength;
    onProgress(end, cells.length, Math.round(head.byteLength + ((written - head.byteLength) / end) * cells.length));
    await yieldToMacrotask();
  }
  const blob = await spool.finish();
  return blob.type === 'text/csv' ? blob : new Blob([blob], { type: 'text/csv' });
}

/**
 * A page's highlight groups as an obs-column CSV: a row per open cell, a
 * `highlight` column per enabled group.
 *
 * @param {{state: Object, adapter: Object, pageId: string,
 *   onProgress?: (done: number, total: number, expectedBytes: number) => void, signal?: AbortSignal|null}} options
 * @returns {Promise<{blob: Blob, filename: string, cells: number}>}
 */
export async function highlightsCsv({ state, adapter, pageId, onProgress, signal = null }) {
  const { page, groups, cells } = pageCells(state, pageId);
  if (cells.length === 0) throw new Error('No cells are highlighted on this page.');
  const every = inOriginalOrder(state);
  const memberships = groupMembership(groups, every, state.pointCount);
  const columns = groups.map(entry => [`${HIGHLIGHT_COLUMN_PREFIX}${entry.id}`, 'highlight']);
  const filename = `${fileStem(page.name)}_cells.csv`;
  const blob = await csvBlob(columns, adapter, every,
    row => memberships.map(({ flags }) => (flags[row] === 1 ? 'true' : 'false')).join(','), { onProgress, signal });
  return { blob, filename, cells: cells.length };
}

/**
 * One obs field as an obs-column CSV: every open cell, its value.
 *
 * @param {{state: Object, adapter: Object, fieldIndex: number,
 *   onProgress?: (done: number, total: number, expectedBytes: number) => void, signal?: AbortSignal|null}} options
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function fieldCsv({ state, adapter, fieldIndex, onProgress, signal = null }) {
  // Read under the export: its card says it and its Cancel stops the read.
  const field = await state.ensureFieldLoaded(fieldIndex, { signal, silent: true });
  const valueAt = columnReader(field);
  const column = field.kind === FieldKind.CATEGORY ? [field.key, 'categorical', field.categories] : [field.key, 'continuous'];
  const every = inOriginalOrder(state);
  const filename = `${fileStem(field.key)}.csv`;
  const blob = await csvBlob([column], adapter, every, (row, cell) => csvCell(valueAt(cell)), { onProgress, signal });
  return { blob, filename };
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
  const text = field.values instanceof Float32Array ? float32Text : String;
  return row => {
    const value = field.values[row];
    return Number.isFinite(value) ? text(value) : '';
  };
}

/**
 * A float32 value as the shortest decimal that reads back as the same
 * float32: `0.1`, not its double expansion `0.10000000149011612`.
 *
 * @param {number} value - A float32 value (finite)
 * @returns {string}
 */
export function float32Text(value) {
  for (let digits = 1; digits < 9; digits++) {
    const text = value.toPrecision(digits);
    if (Math.fround(Number(text)) === value) return String(Number(text));
  }
  return String(Number(value.toPrecision(9)));
}

/**
 * A categorical's categories as anndata stores them: in their own type
 * (integers int64, other numbers float64, booleans bool), else text.
 *
 * @param {ReadonlyArray<string|number|boolean>} categories
 */
function categoriesDataset(categories) {
  const array = ENCODING('array', '0.2.0');
  const n = categories.length;
  if (n > 0 && categories.every(value => typeof value === 'boolean')) {
    return numericDataset('bool', [n], Uint8Array.from(categories, value => (value ? 1 : 0)), array);
  }
  if (n > 0 && categories.every(value => typeof value === 'number' && Number.isSafeInteger(value))) {
    return numericDataset('int64', [n], BigInt64Array.from(categories, value => BigInt(value)), array);
  }
  if (n > 0 && categories.every(value => typeof value === 'number' && Number.isFinite(value))) {
    return numericDataset('float64', [n], Float64Array.from(categories), array);
  }
  return stringDataset(categories.map(String), ENCODING('string-array', '0.2.0'));
}

/** A page's or field's name as the start of a file name: safe, its white space as `_`. */
function fileStem(name) {
  return safeFileName(String(name).replace(/\s+/g, '_').replace(/^_+|_+$/g, ''), 'cellucid');
}

/**
 * The name a column (or embedding) takes in the `.h5ad`, and why it differs
 * from its key: the portable element name every writer of the app gives a
 * name it did not choose (`data/anndata/write/names.js`
 * `portableElementName`: "/" and the other characters no file name holds as
 * "_", "." as "_", a name too long for a file name cut, and one taken
 * already, in any letter case, "_2", "_3"...), so the file converts to Zarr
 * wherever it is copied. `taken` holds the `folderKey`s of the names written;
 * `renamed` collects each change, which the export reports.
 */
export function columnName(key, taken, renamed = null) {
  const name = portableElementName(String(key), taken);
  if (name !== String(key)) renamed?.push({ key: String(key), name });
  return name;
}

/**
 * Bytes a spool gathers before it writes them as one file: a slab, a
 * scheduling choice (a file a write, a CSV's 1 MB batches, would cost a
 * file's creation each, seconds on a large export; measured:
 * 25_decisions_exports.md).
 */
const SPOOL_SEGMENT_BYTES = 32 * 1024 * 1024;

/**
 * The spools of this page that are finished: `{createdAt, names}` each, the
 * names of the private-storage files they wrote. A spool whose storage fills
 * removes the files of those finished before it was made (`freeEarlier`):
 * an earlier export's, whose download read them long since, never a spool
 * of the export under way (an `.h5ad` writes two at once).
 */
const finishedSpools = [];
let spoolsMade = 0;

/** Whether a write failed because the browser's storage for this site is full. */
function storageFull(error) {
  return error?.name === 'QuotaExceededError' || /quota|no space/i.test(error?.message ?? '');
}

/**
 * A place to write a large dataset's bytes as they come: a file in this
 * browser's origin-private storage for each segment of about
 * `SPOOL_SEGMENT_BYTES` written, when the browser offers one to a page,
 * else memory. `finish()` returns the bytes as one Blob of those files
 * (read from disk as the download streams it); `discard()` removes them
 * (a copy of the dataset that failed or was canceled). The files of an earlier
 * page's exports are removed when the next one starts: a download reads its
 * file after the export returns. When the site's storage is full (a private
 * window's is a few hundred MB; gene indexes kept for a revisit share it),
 * the files of this page's earlier exports are removed and the segment
 * written again, and a segment that still fails is kept in memory, as is every one
 * after it: a full storage never fails an export (without this, a large
 * `.h5ad` export fails with `QuotaExceededError` once an earlier export of
 * the page has filled the storage). Nothing written is lost: a segment's bytes are in hand until
 * its file is written whole.
 *
 * @param {string} name
 * @param {{segmentBytes?: number}} [options] - Bytes gathered before a file is written
 */
export async function createSpool(name, { segmentBytes = SPOOL_SEGMENT_BYTES } = {}) {
  let directory = null;
  try {
    directory = typeof navigator !== 'undefined' && navigator.storage?.getDirectory
      ? await navigator.storage.getDirectory()
      : null;
  } catch {
    directory = null;
  }
  if (directory !== null) {
    // An earlier page's files, read by its download long since.
    try {
      for await (const [entry] of directory.entries()) {
        if (entry.startsWith(SPOOL_PREFIX) && !entry.includes(`-${SPOOL_SESSION}-`)) {
          await directory.removeEntry(entry).catch(() => {});
        }
      }
    } catch {
      // Listing is optional: what is left is removed by a later export.
    }
  }
  const createdAt = ++spoolsMade;
  const stem = `${SPOOL_PREFIX}${SPOOL_SESSION}-${name}-${Math.random().toString(36).slice(2)}`;
  /** The spool's segments in order: a file of the private storage, or a Blob in memory. */
  const parts = [];
  const names = [];
  /** Writes since the last segment, as Blobs (each write's bytes copied), and their bytes. */
  let pending = [];
  let pendingBytes = 0;
  let inMemory = directory === null;
  /** Write `segment` (a Blob) as a file of its own; the file, or a thrown error (the file then removed). */
  const writeFile = async segment => {
    const fileName = `${stem}-${parts.length}`;
    try {
      const handle = await directory.getFileHandle(fileName, { create: true });
      if (typeof handle.createWritable !== 'function') throw new TypeError('This page cannot write its private storage.');
      const writable = await openFileWritable(handle);
      try {
        await writable.write(segment);
        await writable.close();
      } catch (error) {
        await writable.abort(error).catch(() => {});
        throw error;
      }
      const file = await handle.getFile();
      if (file.size !== segment.size) throw new Error('The export could not be written to this browser\'s storage.');
      names.push(fileName);
      return file;
    } catch (error) {
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  };
  /** Remove the files of this page's spools finished before this one was made. */
  const freeEarlier = async () => {
    for (let i = finishedSpools.length - 1; i >= 0; i--) {
      if (finishedSpools[i].createdAt >= createdAt) continue;
      const [earlier] = finishedSpools.splice(i, 1);
      for (const fileName of earlier.names) await directory.removeEntry(fileName).catch(() => {});
    }
  };
  /** The writes since the last segment as one segment: a file, or memory when the storage has no room. */
  const flush = async () => {
    if (pending.length === 0) return;
    const segment = new Blob(pending);
    pending = [];
    pendingBytes = 0;
    if (!inMemory) {
      try {
        parts.push(await writeFile(segment));
        return;
      } catch (error) {
        if (storageFull(error)) {
          await freeEarlier();
          try {
            parts.push(await writeFile(segment));
            return;
          } catch {
            // Still full: memory from here on.
          }
        }
        // No room, or no writable private storage (a private window): memory.
        inMemory = true;
      }
    }
    parts.push(segment);
  };
  return {
    /** One more part: bytes (copied into a Blob) or a Blob (a copy of a dataset's batch, `writeAnnDataCopy`). */
    async write(part) {
      const blob = part instanceof Blob ? part : new Blob([part]);
      pending.push(blob);
      pendingBytes += blob.size;
      if (pendingBytes >= segmentBytes) await flush();
    },
    async finish() {
      await flush();
      if (names.length > 0) finishedSpools.push({ createdAt, names });
      return new Blob(parts);
    },
    /**
     * Drop what was written (a copy that failed or was canceled): its
     * files are removed from the private storage, nothing is downloaded.
     */
    async discard() {
      pending = [];
      pendingBytes = 0;
      parts.length = 0;
      const written = names.splice(0);
      for (const fileName of written) await directory?.removeEntry(fileName).catch(() => {});
    },
  };
}

function littleEndian(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * What an `.h5ad` export of a page's highlighted cells will read, priced
 * before it starts by the reader's model of the file (the one the gene
 * sample and Genes read for are priced by,
 * `AnnDataReader.matrixRowsCost`): the expression rows of the cells, which
 * are nearly all of it. Null when the file has no expression matrix, or its
 * rows are not priced (a matrix read by gene).
 *
 * @param {{state: Object, adapter: Object, pageId: string}} options
 * @returns {Promise<{cells: number, bytes: number, keptBytes: number, requests: number, ms: number|null}|null>}
 */
export async function highlightsH5adCost({ state, adapter, pageId }) {
  const { cells } = pageCells(state, pageId);
  if (cells.length === 0) return null;
  await state.whenGenesListed();
  const genes = state.varData?.fields ?? [];
  if (genes.length === 0) return null;
  return adapter.getMatrixRowsCostOf(genes[0].path, cells);
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
  // The highlighted cells' names, their rows alone, in the stored order.
  const names = await adapter.getObsNames({ cells });
  throwIfAborted(signal);

  // obs: every field the viewer shows, then each group of the page.
  const taken = new Set(['_index']);
  /** @type {Array<{key: string, name: string}>} Keys written under another name. */
  const renamed = [];
  const columns = [];
  /** `uns['<column>_colors']` of each categorical: its colors as shown. */
  const colors = [];
  const fields = state.getFields() ?? [];
  for (let index = 0; index < fields.length; index++) {
    if (fields[index]?._isDeleted === true) continue;
    throwIfAborted(signal);
    // Read under the export: its card says it and its Cancel stops the
    // read, never a card of each field's own (whose Cancel failed the export).
    const field = await state.ensureFieldLoaded(index, { signal, silent: true });
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
      columns.push([name, group({ ...ENCODING('categorical', '0.2.0'), ordered: booleanAttribute(field.ordered === true) }, [
        ['codes', numericDataset(type, [n], codes, ENCODING('array', '0.2.0'))],
        ['categories', categoriesDataset(field.categories)],
      ])]);
      if (count > 0) {
        colors.push([`${name}_colors`, stringDataset(
          field.categories.map((_, code) => hexOfRgb01(state.getColorForCategory(field, code))),
          ENCODING('string-array', '0.2.0')
        )]);
      }
    } else if (ArrayBuffer.isView(field.values)) {
      // As the viewer holds it: float64 stays float64.
      const [type, ArrayType] = field.values instanceof Float64Array ? ['float64', Float64Array] : ['float32', Float32Array];
      const values = new ArrayType(n);
      for (let row = 0; row < n; row++) values[row] = field.values[cells[row]];
      columns.push([name, numericDataset(type, [n], values, ENCODING('array', '0.2.0'))]);
    }
    // Its column is written: a field the export read is let go again under
    // the residency budget, so the export never holds every field at once.
    releaseInactiveFieldsOverBudget(state);
  }
  for (const { entry, flags } of groupMembership(groups, cells, state.pointCount)) {
    const name = columnName(`${HIGHLIGHT_COLUMN_PREFIX}${entry.id}`, taken, renamed);
    columns.push([name, numericDataset('bool', [n], flags, ENCODING('array', '0.2.0'))]);
  }
  const obs = group(
    { ...ENCODING('dataframe', '0.2.0'), _index: '_index', 'column-order': columns.map(([name]) => name) },
    [['_index', stringDataset(names, ENCODING('string-array', '0.2.0'))], ...columns]
  );

  // var and X: the genes and rows of the matrix the data mapping reads,
  // once a dataset just shown has listed them (after its first view).
  await state.whenGenesListed();
  throwIfAborted(signal);
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
    // One read of every cell's row (`readMatrixRowsOf`): its parts arrive in
    // the cells' order, the next read while one is written, each written
    // out as it comes, so the export holds a part at a time. Genes come
    // ascending in each row, as a CSR matrix keeps them.
    // A part that cannot be written (the storage is full) stops the read.
    let writing = Promise.resolve();
    const unwritable = new AbortController();
    await adapter.readMatrixRowsOf(genes[0].path, cells, {
      signal: signal === null ? unwritable.signal : AbortSignal.any([signal, unwritable.signal]),
      onPart: ({ first, count, pointers, genes: partGenes, values }) => {
        for (let i = 0; i < count; i++) indptr[first + i + 1] = BigInt(stored + pointers[i + 1]);
        stored += pointers[count];
        writing = writing.then(async () => {
          await data.write(littleEndian(values));
          await indices.write(littleEndian(partGenes));
          onProgress(first + count, n);
        });
        writing.catch(error => unwritable.abort(error));
      },
    });
    await writing;
    throwIfAborted(signal);
    children.push(['X', group({ ...ENCODING('csr_matrix', '0.1.0'), shape: BigInt64Array.of(BigInt(n), BigInt(genes.length)) }, [
      ['data', numericDataset('float32', [stored], await data.finish())],
      ['indices', numericDataset('int32', [stored], await indices.finish())],
      ['indptr', numericDataset('int64', [n + 1], indptr)],
    ])]);
  }
  // The var index is the genes' identifiers; the names shown beside them
  // when they differ (a var column names the genes in Data mapping).
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
    throwIfAborted(signal);
    const width = picked.length;
    // The exported cells' rows alone, in the export's order, as stored (the
    // reader hands float32 columns as float32, any other type as float64):
    // never every open row between them.
    const out = await adapter.getObsmColumns(key, picked, { signal, cells });
    const type = out instanceof Float32Array ? 'float32' : 'float64';
    obsm.push([columnName(key, obsmTaken, renamed), numericDataset(type, [n, width], out, ENCODING('array', '0.2.0'))]);
  }

  const root = group(ENCODING('anndata', '0.1.0'), [
    ['obs', obs],
    ['var', variables],
    ...children,
    ['obsm', group(ENCODING('dict', '0.1.0'), obsm)],
    ['uns', group(ENCODING('dict', '0.1.0'), colors)],
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
