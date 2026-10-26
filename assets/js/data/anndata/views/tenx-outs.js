/**
 * A Cell Ranger `outs/` folder: its count matrix (`filtered_feature_bc_matrix.h5`)
 * read in place through the 10x view (`tenx-h5.js`), with Cell Ranger's own
 * analysis beside it as embeddings and clusterings (design decision D4: the
 * matrix alone has no embedding).
 *
 * | Path (any depth below the folder) | Header | Becomes |
 * | --- | --- | --- |
 * | `analysis/umap/<dir>/projection.csv` | `Barcode,UMAP-1,UMAP-2` | `obsm['X_umap']` |
 * | `analysis/tsne/<dir>/projection.csv` | `Barcode,TSNE-1,TSNE-2` | `obsm['X_tsne']` |
 * | `analysis/pca/<dir>/projection.csv` | `Barcode,PC-1,…` | `obsm['X_pca']` |
 * | `analysis/dimensionality_reduction/<library>/umap_projection.csv` (ARC) | | `obsm['X_umap']` |
 * | `analysis/clustering/<dir>/clusters.csv` | `Barcode,Cluster` | `obs['<dir>']`, categorical |
 *
 * When a kind has projections of several libraries (Gene Expression and
 * Antibody Capture), the gene-expression one is `X_<kind>` and each other
 * is `X_<kind>_<dir>`. Rows are matched to the matrix by barcode, not by
 * order; a cell a projection lacks is NaN (refused as unplottable by the
 * usual rule) and a cell a clustering lacks has no category.
 *
 * The CSV files are a few megabytes at most (two to ten numbers per cell)
 * and are read whole, with the small reader here: Cell Ranger writes them
 * unquoted, comma-separated, one header line.
 *
 * @module data/anndata/views/tenx-outs
 */

import { isGroup, numericDtype, stringDtype } from '../../../formats/store.js';
import { LayoutRefusal } from './refusal.js';
import { TENX_H5_FORMAT, isTenxRoot, tenxView } from './tenx-h5.js';
import { encodingAttrs, joinPath, valueArray, viewGroup } from './view-nodes.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** The matrix files of an `outs/` folder, preferred first: the filtered matrix of each Cell Ranger era. */
export const OUTS_MATRIX_FILES = Object.freeze([
  'filtered_feature_bc_matrix.h5',
  'sample_filtered_feature_bc_matrix.h5',
  'filtered_gene_bc_matrices_h5.h5',
]);

const PROJECTION = /(?:^|\/)analysis\/(umap|tsne|pca)\/([^/]+)\/projection\.csv$/;
const ARC_PROJECTION = /(?:^|\/)analysis\/dimensionality_reduction\/([^/]+)\/(umap|tsne)_projection\.csv$/;
const CLUSTERS = /(?:^|\/)analysis\/clustering\/([^/]+)\/clusters\.csv$/;

/**
 * The matrix file of a picked `outs/` folder (the shallowest of the
 * preferred names) and the folder it is in.
 *
 * @param {Map<string, File>} files - Every file by its path below the folder
 * @returns {{path: string, file: File, base: string}|null}
 */
export function outsMatrixFile(files) {
  for (const wanted of OUTS_MATRIX_FILES) {
    const found = [...files.keys()]
      .filter(path => path === wanted || path.endsWith(`/${wanted}`))
      .sort((left, right) => left.split('/').length - right.split('/').length || (left < right ? -1 : 1));
    if (found.length > 0) {
      const path = found[0];
      return { path, file: files.get(path), base: path.slice(0, path.length - wanted.length) };
    }
  }
  return null;
}

/** The rows of one Cell Ranger CSV: its header and each line's fields. */
function parseCsv(text, label) {
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length === 0) throw new LayoutRefusal(`${label} is empty.`, { reason: 'outs-csv' });
  const header = lines[0].split(',');
  const rows = lines.slice(1).map(line => line.split(','));
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new LayoutRefusal(`${label} line ${index + 2} has ${formatCountOf(row.length, 'field')} where its header has ${header.length}.`, { reason: 'outs-csv' });
    }
  }
  return { header, rows };
}

/** The gene-expression library first, then by name. */
function libraryOrder(left, right) {
  const rank = dir => (/antibody|crispr|multiplexing|peaks|atac|custom/i.test(dir) ? 1 : 0);
  return rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0);
}

/**
 * The analysis of an `outs/` folder as obs columns and obsm arrays of the
 * matrix's cells, by barcode.
 *
 * @param {Map<string, Object>} files - A picked folder's `File`s, or a served folder's remote files
 * @param {string} base - The folder of the matrix file, `''` or ending in `/`
 * @param {string[]} barcodes - The matrix's barcodes, in its order
 * @param {(file: Object) => Promise<string>} readText - One file, whole, as text
 * @returns {Promise<{obs: Map<string, Function>, obsm: Map<string, Function>}>}
 */
async function readAnalysis(files, base, barcodes, readText) {
  const cellOf = new Map(barcodes.map((barcode, cell) => [barcode, cell]));
  const nCells = barcodes.length;
  const projections = new Map();
  const clusterings = [];
  for (const [path, file] of files) {
    if (!path.startsWith(base)) continue;
    const inside = path.slice(base.length);
    const projection = PROJECTION.exec(inside);
    const arc = ARC_PROJECTION.exec(inside);
    const clusters = CLUSTERS.exec(inside);
    if (projection !== null || arc !== null) {
      const [kind, dir] = projection !== null ? [projection[1], projection[2]] : [arc[2], arc[1]];
      if (!projections.has(kind)) projections.set(kind, []);
      projections.get(kind).push({ dir, path, file });
    } else if (clusters !== null) {
      clusterings.push({ dir: clusters[1], path, file });
    }
  }
  const obsm = new Map();
  for (const [kind, found] of projections) {
    found.sort((left, right) => libraryOrder(left.dir, right.dir));
    for (const [position, { dir, path, file }] of found.entries()) {
      const { header, rows } = parseCsv(await readText(file), path);
      const width = header.length - 1;
      if (width < 1) continue;
      const values = new Float64Array(nCells * width).fill(Number.NaN);
      for (const row of rows) {
        const cell = cellOf.get(row[0]);
        if (cell === undefined) continue;
        for (let column = 0; column < width; column++) values[cell * width + column] = Number(row[column + 1]);
      }
      const key = position === 0 ? `X_${kind}` : `X_${kind}_${dir.replace(/_?\d+_components$/, '') || dir}`;
      if (obsm.has(key)) continue;
      obsm.set(key, () => valueArray({
        path: joinPath('/obsm', key),
        dtype: numericDtype('float', 8),
        shape: [nCells, width],
        values,
        attrs: encodingAttrs('array'),
      }));
    }
  }
  const obs = new Map();
  clusterings.sort((left, right) => libraryOrder(left.dir, right.dir) || 0);
  for (const { dir, path, file } of clusterings) {
    const { rows } = parseCsv(await readText(file), path);
    const labels = [...new Set(rows.map(row => row[1]))];
    labels.sort((left, right) => (Number(left) - Number(right)) || (left < right ? -1 : left > right ? 1 : 0));
    const codeOf = new Map(labels.map((label, code) => [label, code]));
    const codes = new Int32Array(nCells).fill(-1);
    for (const row of rows) {
      const cell = cellOf.get(row[0]);
      if (cell !== undefined) codes[cell] = codeOf.get(row[1]);
    }
    const columnPath = joinPath('/obs', dir);
    obs.set(dir, () => viewGroup({
      path: columnPath,
      attrs: { ...encodingAttrs('categorical'), ordered: false },
      children: new Map([
        ['codes', () => valueArray({ path: joinPath(columnPath, 'codes'), dtype: numericDtype('int', 4), shape: [nCells], values: codes, attrs: encodingAttrs('array') })],
        ['categories', () => valueArray({
          path: joinPath(columnPath, 'categories'),
          dtype: stringDtype({ variable: true, encoding: 'utf-8' }),
          shape: [labels.length],
          values: labels,
          attrs: encodingAttrs('string-array'),
        })],
      ]),
    }));
  }
  return { obs, obsm };
}

/** The barcodes array of a 10x matrix (Cell Ranger 3, else the first genome's). */
function barcodesOf(root) {
  const matrix = root.get('matrix');
  if (isGroup(matrix)) return matrix.get('barcodes');
  const genome = root.keys().find(key => isGroup(root.get(key)) && root.get(key).has('barcodes'));
  return root.get(genome).get('barcodes');
}

/**
 * The AnnData view of an `outs/` folder's matrix with its analysis.
 *
 * @param {Object} root - The matrix file's root group
 * @param {{name: string, files: Map<string, Object>, base: string, signal?: AbortSignal|null,
 *   readText?: (file: Object) => Promise<string>, fromLink?: boolean}} context - `readText` reads a remote
 *   file of a served folder; a picked folder's `File`s read themselves
 * @returns {Promise<Object>}
 */
export async function tenxOutsView(root, { name, files, base, signal = null, readText = file => file.text(), fromLink = false }) {
  const barcodes = Array.from(await barcodesOf(root).read(undefined, { signal }), String);
  const analysis = await readAnalysis(files, base, barcodes, readText);
  return tenxView(root, { name, analysis, signal, fromLink });
}

/** The `outs/` folder entry of `LAYOUT_VIEWS`: a folder whose matrix is one HDF5 file. */
export const TENX_OUTS_VIEW = Object.freeze({
  recognize: isTenxRoot,
  view: tenxOutsView,
  readerFormat: TENX_H5_FORMAT,
  matrixFile: outsMatrixFile,
});
