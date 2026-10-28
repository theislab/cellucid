/**
 * Delimited text tables of cells (CSV, TSV; gzip, bzip2 or xz compressed)
 * beside a matrix (a MatrixMarket folder's metadata, Cell Ranger's
 * `analysis/` projections and clusters): read whole into columns, their cells matched to a matrix's barcodes by
 * value, and their embedding columns found by name.
 *
 * - **Columns**: a column whose every non-empty value is a number is
 *   numeric (empty, `NA` and `NaN` read as NaN); any other is text,
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

import { delimiterOf, forEachLine, lineText, splitFields, textPieces } from '../../../formats/text/lines.js';
import { allocateTypedArray } from '../../sparse-column-index.js';

const MISSING = new Set(['', 'NA', 'NaN', 'nan', 'N/A', 'null', 'NULL']);
const CELL_COLUMN = /^(barcodes?|cells?|cell[_ .-]?(id|name|barcode)s?|obs[_ ]?names|index)$/i;

/** A clustering's name: a word of it is cluster(s), clustering, leiden, louvain, kmeans or graphclust. */
const CLUSTERING_COLUMN = /(^|[^a-z])(clusters?|clustering|leiden|louvain|kmeans|graphclust)([^a-z]|$)/i;

/**
 * Whether a text table's column is a clustering, read as categories even
 * when its labels are numbers.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isClusteringColumn(name) {
  return CLUSTERING_COLUMN.test(name.trim());
}

/**
 * Read a table whole.
 *
 * @param {{size: number, read: Function}} reader
 * @param {{signal?: AbortSignal|null, activity?: Object|null, header?: boolean|null}} [options]
 *   `header`: whether the first line names the columns; null decides it
 *   (a first line any of whose fields after the first is not a number)
 * @returns {Promise<{names: string[], columns: string[][], rows: number}>}
 */
export async function readTable(reader, { signal = null, activity = null, header = null } = {}) {
  const pieces = await textPieces(reader, { signal, activity });
  const lines = [];
  await forEachLine(pieces, (bytes, start, end) => {
    if (end > start) lines.push(lineText(bytes, start, end));
  });
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  const delimiter = delimiterOf(lines.slice(0, 20));
  const rows = lines.map(line => splitFields(line, delimiter));
  const first = rows[0] ?? [];
  const named = header ?? first.slice(1).some(field => !isNumberText(field));
  // A loop, not Math.max(...): a spread of one argument per row exceeds the
  // engine's argument limit past about 120,000 rows (a 500,000-cell
  // projection.csv), and the table would not be read at all.
  let width = 0;
  for (const row of rows) if (row.length > width) width = row.length;
  let names = named ? [...first] : Array.from({ length: width }, (_, i) => `column_${i + 1}`);
  const body = named ? rows.slice(1) : rows;
  // A header one shorter than the rows names every column but the first (R's write.csv of row names).
  if (named && names.length === width - 1) names = ['', ...names];
  while (names.length < width) names.push(`column_${names.length + 1}`);
  const columns = names.map((_, c) => body.map(row => row[c] ?? ''));
  return { names, columns, rows: body.length };
}

function isNumberText(text) {
  const trimmed = text.trim();
  return MISSING.has(trimmed) || (trimmed !== '' && Number.isFinite(Number(trimmed))) || /^[+-]?inf(inity)?$/i.test(trimmed);
}

/** A text column's values as numbers, or null when it is not numeric. */
export function numericColumn(values) {
  const out = allocateTypedArray(Float64Array, values.length, 'A numeric text column');
  let seen = false;
  for (let i = 0; i < values.length; i++) {
    const text = values[i].trim();
    if (MISSING.has(text)) {
      out[i] = NaN;
      continue;
    }
    const number = /^[+-]?inf(inity)?$/i.test(text) ? (text.startsWith('-') ? -Infinity : Infinity) : Number(text);
    if (text === '' || Number.isNaN(number)) return null;
    out[i] = number;
    seen = true;
  }
  return seen ? out : null;
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
 * The obs columns and embeddings a table adds to cells named `cells`,
 * matched by value; cells the table does not list are missing (NaN, NA).
 *
 * @param {{names: string[], columns: string[][], rows: number}} table
 * @param {string[]} cells
 * @param {{prefix?: string}} [options] - A prefix for the column names
 * @returns {{matched: number, columns: Array<{name: string, column: Object}>, obsm: Array<{name: string, rows: number, columns: number, values: Float64Array}>}}
 */
export function joinTable(table, cells, { prefix = '' } = {}) {
  const key = cellColumnOf(table.names);
  const position = new Map(cells.map((cell, index) => [cell, index]));
  const rowOf = table.columns[key].map(value => position.get(value.trim()) ?? -1);
  const matched = rowOf.filter(row => row >= 0).length;
  const numeric = table.columns.map(values => numericColumn(values));
  const embeddings = embeddingColumns(table.names, index => index !== key && numeric[index] !== null);
  const inEmbedding = new Set(embeddings.flatMap(group => group.columns));
  const columns = [];
  table.names.forEach((name, index) => {
    if (index === key || inEmbedding.has(index) || name.trim() === '') return;
    const label = `${prefix}${name.trim()}`;
    if (numeric[index] !== null && !isClusteringColumn(name)) {
      const values = allocateTypedArray(Float64Array, cells.length, label).fill(NaN);
      rowOf.forEach((row, r) => { if (row >= 0) values[row] = numeric[index][r]; });
      columns.push({ name: label, column: { kind: 'numbers', values } });
      return;
    }
    const placed = new Array(cells.length).fill(null);
    rowOf.forEach((row, r) => {
      const text = table.columns[index][r].trim();
      if (row >= 0 && !MISSING.has(text)) placed[row] = text;
    });
    const categories = [...new Set(placed.filter(value => value !== null))]
      .sort((a, b) => (numeric[index] !== null ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
    const code = new Map(categories.map((value, i) => [value, i]));
    const codes = allocateTypedArray(categories.length < 128 ? Int8Array : categories.length < 32768 ? Int16Array : Int32Array, cells.length, label);
    placed.forEach((value, i) => { codes[i] = value === null ? -1 : code.get(value); });
    columns.push({ name: label, column: { kind: 'categorical', codes, categories, ordered: false } });
  });
  const obsm = embeddings.map(({ name, columns: members }) => {
    const values = allocateTypedArray(Float64Array, cells.length * members.length, `obsm['${name}']`).fill(NaN);
    members.forEach((column, c) => {
      rowOf.forEach((row, r) => { if (row >= 0) values[c * cells.length + row] = numeric[column][r]; });
    });
    return { name, rows: cells.length, columns: members.length, values };
  });
  return { matched, columns, obsm };
}
