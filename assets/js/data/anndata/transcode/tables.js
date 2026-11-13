/**
 * Delimited text tables of cells (CSV, TSV; gzip, bzip2 or xz compressed)
 * beside a matrix (a MatrixMarket folder's metadata, Cell Ranger's
 * `analysis/` projections and clusters): read in one pass into typed
 * columns, their cells matched to a matrix's barcodes by value as they are
 * read, and their embedding columns found by name.
 *
 * - **Columns**: a column whose every non-empty value is a number is
 *   numeric (empty, `NA` and `NaN` read as NaN; a whole number past 2^53,
 *   an identifier, is no number); any other is text,
 *   written as a categorical (empty and `NA` missing). A text table says
 *   nothing of its columns' types, so a column named for a clustering
 *   (`Cluster`, `seurat_clusters`, `leiden`, `louvain`, `kmeans_10`,
 *   `graphclust`: `isClusteringColumn`) is categorical even when its labels
 *   are numbers, as Cell Ranger's `clusters.csv` is; a store that types its
 *   columns (AnnData, an R data frame) keeps its own types.
 * - **The cell column**: one named `barcode(s)`, `cell(s)`, `cell_id`,
 *   `cell_name`, `obs_names` or `index` (any case), else the first.
 * - **Embeddings**: numeric columns named `<base>1`, `<base>2` (and
 *   `<base>3`), with `_`, `-`, `.` or a space before the number, become
 *   `obsm['X_<base>']` (`UMAP_1`/`UMAP_2`, `tSNE-1`/`tSNE-2`, Cell Ranger's
 *   `UMAP-1`/`UMAP-2`, `PC_1`…`PC_50`, Space Ranger pixel columns are
 *   handled by the caller).
 *
 * @module data/anndata/transcode/tables
 */

import { delimiterOf, forEachLine, lineText, ownText, splitFields, textPieces } from '../../../formats/text/lines.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { StringIndex } from '../../../utils/string-index.js';

const MISSING = new Set(['', 'NA', 'NaN', 'nan', 'N/A', 'null', 'NULL']);
const CELL_COLUMN = /^(barcodes?|cells?|cell[_ .-]?(id|name|barcode)s?|obs[_ ]?names|index)$/i;

/** A clustering's name: a word of it is cluster(s), clustering, leiden, louvain, kmeans or graphclust. */
const CLUSTERING_COLUMN = /(^|[^a-z])(clusters?|clustering|leiden|louvain|kmeans|graphclust)([^a-z]|$)/i;

/**
 * Whether a column of a format with no categorical type (a text table, a
 * Loom file) is a clustering, read as categories even when its labels are
 * numbers. Words are split at non-letters and where a lower-case letter
 * meets an upper-case one, so Loom's `ClusterID` is a clustering.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isClusteringColumn(name) {
  return CLUSTERING_COLUMN.test(name.trim().replace(/([a-z])([A-Z])/g, '$1 $2'));
}

/**
 * A text table's value as a number: NaN where missing, null where it is no
 * number. A whole number past 2^53 is no number either: no double holds it
 * exactly, and such numbers are identifiers, so its column is text, its
 * values kept as written (as an AnnData column of 64-bit integers is read,
 * `values.js` `readExactIntegers`).
 */
function numberOfText(trimmed) {
  if (trimmed === '') return NaN;
  const number = Number(trimmed);
  if (!Number.isNaN(number)) return /^[+-]?\d+$/.test(trimmed) && !Number.isSafeInteger(number) ? null : number;
  if (MISSING.has(trimmed)) return NaN;
  if (/^[+-]?inf(inity)?$/i.test(trimmed)) return trimmed.startsWith('-') ? -Infinity : Infinity;
  return null;
}

/**
 * Each non-empty line of a text file as its fields, in one pass over its
 * decompressed bytes (none kept): the delimiter is settled from the first
 * lines (`delimiterOf`), a leading byte-order mark taken off. `onRow`
 * returning `false` stops the reading.
 */
async function forEachRow(reader, { signal, activity }, onRow) {
  const head = [];
  let delimiter;
  let stopped = false;
  const row = text => {
    if (stopped) return false;
    if (onRow(splitFields(text, delimiter)) === false) stopped = true;
    return !stopped;
  };
  await forEachLine(await textPieces(reader, { signal, activity }), (bytes, start, end) => {
    if (end <= start) return true;
    let text = lineText(bytes, start, end);
    if (delimiter !== undefined) return row(text);
    if (head.length === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    head.push(text);
    if (head.length < 20) return true;
    delimiter = delimiterOf(head);
    return head.every(row);
  });
  if (delimiter === undefined) {
    delimiter = delimiterOf(head);
    head.every(row);
  }
}

/** Rows a table's columns are first sized for when it says nothing of its length. */
const FIRST_ROWS = 1024;

/**
 * Read a text table of cells, matched to `cells` (the matrix's cell names)
 * as it is read: each numeric column a `Float64Array`, each other column
 * (and each clustering, `asText`) its labels coded, each row's cell found
 * by the cell column's value (the last cell of that name, -1 for none).
 *
 * One pass over the decompressed bytes, none of them kept: each column is
 * held as numbers while every value it holds is a number (or missing), and
 * becomes labels at its first value that is not. The labels of the numbers
 * it held until then are their text, read again from the file in a second
 * pass over its start only when such a column held a number before that
 * row (a column of numbers that turns out to be labels, rare); otherwise
 * nothing is read twice. No line, row or value is held as a string past its
 * row, and no `Map` holds the cells, so a table of tens of millions of
 * cells costs a few bytes a row and a value (the table's bytes are not
 * kept for a second pass: measured, 23_decisions_partial_reading.md).
 *
 * @param {{size: number, read: Function}} reader
 * @param {{cells: ArrayLike<string>|StringIndex, signal?: AbortSignal|null, activity?: Object|null, header?: boolean|null,
 *   asText?: (name: string, index: number) => boolean, rowsHint?: number}} options
 *   `header`: whether the first line names the columns; null decides it
 *   (a first line any of whose fields after the first is not a number);
 *   `cells`: the names, or their index (`StringIndex.of`) when several
 *   tables are matched to the same cells; null when the table is the list
 *   of the cells itself (a sci-RNA-seq3 `cell_annotate.csv`, Parse's
 *   `cell_metadata.csv`): its rows are the cells, in its order, named by
 *   its cell column (`cellNames`); `rowsHint`: the rows the table is
 *   expected to have (the cells), its columns' first size
 * @returns {Promise<{names: string[], rows: number, key: number, rowOf: Int32Array,
 *   numbers: Array<Float64Array|null>, text: Array<{codes: Int32Array, labels: string[]}|null>,
 *   ragged: {line: number, fields: number}|null, cellNames: string[]|null}>} `ragged`: the first row
 *   (its line) whose fields are not as many as the header's
 */
export async function readTable(reader, { cells, signal = null, activity = null, header = null, asText = isClusteringColumn, rowsHint = 0 }) {
  const cellNames = cells === null ? [] : null;
  const cellIndex = cells === null ? null : cells instanceof StringIndex ? cells : StringIndex.of(cells);
  // Names held once each (no cell named twice): a row naming the cell at its
  // own position needs no lookup.
  const ownOrder = cellIndex?.unique === true ? cellIndex.keys : null;
  let capacity = 0;
  let rowOf = allocateTypedArray(Int32Array, 0, 'Table cells');
  let first = null;
  let named = false;
  let names = [];
  let key = 0;
  let rows = 0;
  // The first row whose fields are not as many as the header's (its line
  // among the non-empty ones), for a caller that refuses a ragged table.
  let ragged = null;
  // One per column: `state` 0 while every value is missing, 1 once one is a
  // number, 2 once one is not; `numbers` while not 2; `dictionary` once 2,
  // or from the start for a clustering; `textFrom`: a column of numbers
  // that became labels at that row, its earlier rows' labels still to read.
  const columns = [];
  const grow = needed => {
    if (needed <= capacity) return;
    const next = Math.max(needed, capacity < rowsHint ? rowsHint : capacity * 2, FIRST_ROWS);
    const regrown = (array, Type, label) => {
      const out = allocateTypedArray(Type, next, label);
      out.set(array.subarray(0, rows));
      return out;
    };
    rowOf = regrown(rowOf, Int32Array, 'Table cells');
    for (const column of columns) {
      if (column === null) continue;
      if (column.numbers !== null) column.numbers = regrown(column.numbers, Float64Array, `Table column ${column.name}`);
      if (column.dictionary !== null) column.dictionary.codes = regrown(column.dictionary.codes, Int32Array, `Table column ${column.name}`);
    }
    capacity = next;
  };
  const dictionaryOf = name => ({ index: new StringIndex(), codes: allocateTypedArray(Int32Array, capacity, `Table column ${name}`) });
  /** Column `c`, made when a row first reaches it: its earlier rows missing. */
  const columnAt = c => {
    while (columns.length <= c) {
      const index = columns.length;
      if (index >= names.length) names.push(`column_${index + 1}`);
      const name = names[index];
      // The cell column, and a column without a name, hold no values.
      if (index === key || name.trim() === '') {
        columns.push(null);
        continue;
      }
      const text = asText(name, index) === true;
      const column = { name, state: 0, numbers: allocateTypedArray(Float64Array, capacity, `Table column ${name}`).fill(NaN), dictionary: null, text, textFrom: -1, sawNumber: false };
      if (text) {
        column.dictionary = dictionaryOf(name);
        column.dictionary.codes.fill(-1, 0, rows);
      }
      columns.push(column);
    }
    return columns[c];
  };
  /** A value's label code (-1 missing); a label first seen is kept as a string of its own (`ownText`). */
  const code = (column, trimmed) => {
    if (MISSING.has(trimmed)) return -1;
    const { index } = column.dictionary;
    const known = index.size;
    const entry = index.intern(trimmed);
    if (index.size !== known) index.keys[entry] = ownText(trimmed);
    return entry;
  };
  const addRow = fields => {
    if (rows === 0 && named && fields.length === first.length + 1) {
      // A header one shorter than the rows names every column but the
      // first (R's write.csv of row names).
      names = ['', ...first];
      key = cellColumnOf(names);
    }
    grow(rows + 1);
    if (named && ragged === null && fields.length !== first.length) ragged = { line: rows + 2, fields: fields.length };
    const name = (fields[key] ?? '').trim();
    if (cellNames !== null) {
      cellNames.push(ownText(name));
      rowOf[rows] = rows;
    } else if (ownOrder !== null && ownOrder[rows] === name) rowOf[rows] = rows;
    else rowOf[rows] = cellIndex.get(name) ?? -1;
    const width = Math.max(fields.length, columns.length);
    for (let c = 0; c < width; c++) {
      const column = columnAt(c);
      if (column === null) continue;
      const trimmed = (fields[c] ?? '').trim();
      if (column.state === 2) {
        column.dictionary.codes[rows] = code(column, trimmed);
        continue;
      }
      const number = numberOfText(trimmed);
      if (number === null) {
        // Labels from here on; the numbers before are their text.
        if (column.dictionary === null) {
          column.dictionary = dictionaryOf(column.name);
          column.dictionary.codes.fill(-1, 0, rows);
          if (column.sawNumber) column.textFrom = rows;
        }
        column.state = 2;
        column.numbers = null;
        column.dictionary.codes[rows] = code(column, trimmed);
        continue;
      }
      column.numbers[rows] = number;
      // NaN is a missing value (`numberOfText`).
      if (number === number) {
        column.state = 1;
        column.sawNumber = true;
      }
      if (column.dictionary !== null) column.dictionary.codes[rows] = code(column, trimmed);
    }
    rows++;
    return true;
  };
  await forEachRow(reader, { signal, activity }, fields => {
    if (first !== null) return addRow(fields);
    first = fields;
    named = header ?? fields.slice(1).some(field => !isNumberText(field));
    if (!named) return addRow(fields);
    names = [...first];
    key = cellColumnOf(names);
    return true;
  });
  // The labels of numbers a column held before it became labels.
  const late = [];
  columns.forEach((column, c) => {
    if (column !== null && column.textFrom > 0) late.push({ column, c });
  });
  if (late.length > 0) {
    const until = Math.max(...late.map(({ column }) => column.textFrom));
    let row = named ? -1 : 0;
    await forEachRow(reader, { signal, activity }, fields => {
      if (row >= 0) {
        for (const { column, c } of late) {
          if (row < column.textFrom) column.dictionary.codes[row] = code(column, (fields[c] ?? '').trim());
        }
      }
      row++;
      return row < until;
    });
  }
  const sized = (array, Type, label) => {
    if (array.length === rows) return array;
    const out = allocateTypedArray(Type, rows, label);
    out.set(array.subarray(0, rows));
    return out;
  };
  rowOf = sized(rowOf, Int32Array, 'Table cells');
  while (names.length < columns.length) names.push(`column_${names.length + 1}`);
  const numbers = names.map((_, c) => {
    const column = columns[c] ?? null;
    return column !== null && column.state === 1 ? sized(column.numbers, Float64Array, `Table column ${column.name}`) : null;
  });
  // An embedding's columns are numbers, never labels.
  const embedded = new Set(embeddingColumns(names, c => numbers[c] !== null).flatMap(group => group.columns));
  const text = names.map((_, c) => {
    const column = columns[c] ?? null;
    if (column === null || embedded.has(c) || (column.state === 1 && !column.text)) return null;
    // A column with no value at all has no labels.
    if (column.dictionary === null) return { codes: allocateTypedArray(Int32Array, rows, `Table column ${column.name}`).fill(-1), labels: [] };
    return { codes: sized(column.dictionary.codes, Int32Array, `Table column ${column.name}`), labels: column.dictionary.index.keys };
  });
  return { names, rows, key, rowOf, numbers, text, ragged, cellNames };
}

/**
 * Whether a table may hold an embedding, from its first lines alone (a few
 * small reads of a file of any size, `readInOrder`): its header names (or,
 * without a header, `column_1`, `column_2`, … as `readTable` names them)
 * hold a group `embeddingColumns` takes, whatever the values turn out to
 * be. False: reading it whole cannot give one.
 *
 * @param {{size: number, read: Function}} reader
 * @param {{signal?: AbortSignal|null, activity?: Object|null, header?: boolean|null}} [options]
 * @returns {Promise<boolean>}
 */
export async function mayHoldEmbedding(reader, { signal = null, activity = null, header = null } = {}) {
  const head = [];
  await forEachLine(await textPieces(reader, { signal, activity, head: true }), (bytes, start, end) => {
    if (end > start) head.push(lineText(bytes, start, end));
    return head.length < 20;
  });
  if (head.length === 0) return false;
  if (head[0].charCodeAt(0) === 0xfeff) head[0] = head[0].slice(1);
  const delimiter = delimiterOf(head);
  const rows = head.map(line => splitFields(line, delimiter));
  const width = Math.max(...rows.map(fields => fields.length));
  const named = header ?? rows[0].slice(1).some(field => !isNumberText(field));
  const names = named ? [...rows[0]] : Array.from({ length: width }, (_, i) => `column_${i + 1}`);
  return embeddingColumns(names, () => true).length > 0;
}

function isNumberText(text) {
  const trimmed = text.trim();
  return MISSING.has(trimmed) || (trimmed !== '' && Number.isFinite(Number(trimmed))) || /^[+-]?inf(inity)?$/i.test(trimmed);
}

/** Which column holds the cell names. */
export function cellColumnOf(names) {
  const named = names.findIndex(name => CELL_COLUMN.test(name.trim()));
  return named >= 0 ? named : 0;
}

/**
 * Embedding column groups by base name: `[{name: 'X_umap', columns: [i, j]}]`.
 *
 * @param {string[]} names
 * @param {(index: number) => boolean} isNumeric
 */
export function embeddingColumns(names, isNumeric) {
  const groups = new Map();
  names.forEach((name, index) => {
    const match = /^(.*?[A-Za-z])[_\-. ]?(\d+)$/.exec(name.trim());
    if (match === null || !isNumeric(index)) return;
    const base = match[1].replace(/^X_/i, '');
    const key = base.toLowerCase();
    if (!groups.has(key)) groups.set(key, { base, members: new Map() });
    groups.get(key).members.set(Number(match[2]), index);
  });
  const found = [];
  for (const [key, { members }] of groups) {
    const columns = [];
    for (let k = 1; members.has(k); k++) columns.push(members.get(k));
    if (columns.length < 2) continue;
    found.push({ name: `X_${key.replace(/[^a-z0-9]+/g, '_')}`, columns });
  }
  return found;
}

/**
 * The obs columns and embeddings a table read for `nCells` cells
 * (`readTable`) adds to them; cells the table does not list are missing
 * (NaN, NA). A row naming a cell another row named already wins, and a
 * text column's categories are the labels the cells keep, in label order
 * (numeric order for a clustering of numbers).
 *
 * @param {Awaited<ReturnType<typeof readTable>>} table
 * @param {number} nCells
 * @param {{prefix?: string}} [options] - A prefix for the column names
 * @returns {{matched: number, columns: Array<{name: string, column: Object}>, obsm: Array<{name: string, rows: number, columns: number, values: Float64Array}>}}
 */
export function joinTable(table, nCells, { prefix = '' } = {}) {
  const { names, rows, key, rowOf, numbers, text } = table;
  let matched = 0;
  let inOrder = rows === nCells;
  for (let r = 0; r < rows; r++) {
    if (rowOf[r] >= 0) matched++;
    if (rowOf[r] !== r) inOrder = false;
  }
  const embeddings = embeddingColumns(names, index => index !== key && numbers[index] !== null);
  const inEmbedding = new Set(embeddings.flatMap(group => group.columns));
  const columns = [];
  names.forEach((name, index) => {
    if (index === key || inEmbedding.has(index) || name.trim() === '') return;
    const label = `${prefix}${name.trim()}`;
    if (numbers[index] !== null && text[index] === null) {
      // A table whose rows are the cells in order (a cell list that is a
      // table) gives its own column: no copy.
      let values = numbers[index];
      if (!inOrder) {
        values = allocateTypedArray(Float64Array, nCells, label).fill(NaN);
        for (let r = 0; r < rows; r++) if (rowOf[r] >= 0) values[rowOf[r]] = numbers[index][r];
      }
      columns.push({ name: label, column: { kind: 'numbers', values } });
      return;
    }
    const { codes: rowCodes, labels } = text[index];
    let placed = rowCodes;
    if (!inOrder) {
      placed = allocateTypedArray(Int32Array, nCells, label).fill(-1);
      for (let r = 0; r < rows; r++) {
        if (rowOf[r] >= 0 && rowCodes[r] >= 0) placed[rowOf[r]] = rowCodes[r];
      }
    }
    const used = allocateTypedArray(Uint8Array, labels.length, label);
    for (let cell = 0; cell < nCells; cell++) if (placed[cell] >= 0) used[placed[cell]] = 1;
    const order = [];
    for (let code = 0; code < labels.length; code++) if (used[code] === 1) order.push(code);
    const numeric = numbers[index] !== null;
    order.sort((a, b) => (numeric ? Number(labels[a]) - Number(labels[b]) : labels[a] < labels[b] ? -1 : labels[a] > labels[b] ? 1 : 0));
    const remap = allocateTypedArray(Int32Array, labels.length, label).fill(-1);
    order.forEach((code, position) => { remap[code] = position; });
    const categories = order.map(code => labels[code]);
    const codes = allocateTypedArray(categories.length < 128 ? Int8Array : categories.length < 32768 ? Int16Array : Int32Array, nCells, label);
    for (let cell = 0; cell < nCells; cell++) codes[cell] = placed[cell] >= 0 ? remap[placed[cell]] : -1;
    columns.push({ name: label, column: { kind: 'categorical', codes, categories, ordered: false } });
  });
  const obsm = embeddings.map(({ name, columns: members }) => {
    const values = allocateTypedArray(Float64Array, nCells * members.length, `obsm['${name}']`).fill(NaN);
    members.forEach((column, c) => {
      for (let r = 0; r < rows; r++) if (rowOf[r] >= 0) values[c * nCells + rowOf[r]] = numbers[column][r];
    });
    return { name, rows: nCells, columns: members.length, values };
  });
  return { matched, columns, obsm };
}
