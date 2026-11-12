/**
 * The transcoder of MatrixMarket folders: a count matrix (`matrix.mtx` or
 * `.mtx.gz`) with its feature and barcode lists, as Cell Ranger, STARsolo,
 * kb-python, alevin-fry, Parse and sci-RNA-seq3 write them, read into a
 * store of the cells × features matrix, with the cell tables found beside
 * it as `obs` and `obsm`.
 *
 * | Producer | matrix | features | cells | orientation |
 * | --- | --- | --- | --- | --- |
 * | Cell Ranger 3+ | `matrix.mtx.gz` | `features.tsv.gz` (id, name, type) | `barcodes.tsv.gz` | features × cells |
 * | Cell Ranger 2, STARsolo | `matrix.mtx` | `genes.tsv` / `features.tsv` | `barcodes.tsv` | features × cells |
 * | kb-python | `cells_x_genes.mtx` | `cells_x_genes.genes.txt` | `cells_x_genes.barcodes.txt` | cells × features |
 * | alevin-fry | `quants_mat.mtx` | `quants_mat_cols.txt` | `quants_mat_rows.txt` | cells × features |
 * | GEO uploads | `<prefix>matrix.mtx.gz` | `<prefix>features`/`genes` | `<prefix>barcodes` | as the producer |
 * | sci-RNA-seq3 (GEO GSE119945) | `<prefix>gene_count.mtx.gz` (or `.txt.gz`) | `<prefix>gene_annotate.csv.gz` (gene_id, gene_type, gene_short_name) | `<prefix>cell_annotate.csv.gz` (a table) | features × cells |
 *
 * A list with a header line (`gene_id,…`, `sample,…`) has one row more than
 * the matrix's size line says it names: its first row is then the header,
 * whatever it says; the column of feature names and of feature types are
 * found by the header's names (`featuresOf`).
 *
 * The orientation is decided by the matrix's size against the two lists'
 * lengths; when both fit (as many cells as features), by the file name
 * (`cells_x_*`), else the person is asked.
 *
 * A matrix has no cell embedding. The folder's own cell tables give one:
 * Cell Ranger's `analysis/{umap,tsne,pca}/*\/projection.csv` and
 * `analysis/clustering/*\/clusters.csv`, any `*.csv`/`*.tsv` table of the
 * cells (`UMAP_1`/`UMAP_2`-style columns become `obsm`), and a cell list
 * that is itself a table (a sci-RNA-seq3 `cell_annotate.csv`, Parse's
 * `cell_metadata.csv`). Without one the folder is refused with how to
 * compute one (D4), from the tables' first lines, before anything else is
 * read.
 *
 * ## Map first, then the matrix share
 *
 * The lists and tables are small; the matrix is nearly all of the bytes
 * (GEO GSE119945: 106 MB of cell table, a 3.95 GB matrix) and one gzip
 * stream, read only from its start. So a folder is read in two parts, each
 * kept on its own (`space.js`, the version rule):
 *
 * 1. **The map** (`transcodeOnce`, under the folder's identity): obs (the
 *    cells, every table column), obsm (the embeddings), var, in priority
 *    order as every transcoded store is (`anndata-model.js`), and an X with
 *    no entry yet (`emptySparse`). The page draws it at once; its gene
 *    sample is no cell (`subsample-plan.js`, `held`). A matrix no larger
 *    than what the map reads is read with it, into the same store (it costs
 *    no more than the map), so a small folder opens whole, with its genes;
 *    so is one of several modalities (a modality's genes are read for every
 *    open cell, with no gene sample to stop at the rows held).
 * 2. **The matrix share** (`matrixStream.ensure`, under `{matrixShare}`):
 *    the matrix streams in the reader worker, its entries parsed on decode
 *    workers as they arrive, and only the rows of the first `G` cells in
 *    priority order -- the cells genes are read for -- are kept
 *    (`EntryCollector`), so its memory and storage follow the share, never
 *    the file. Its X is a `csr_matrix` in priority order whose rows from
 *    `G` on hold nothing (the reader never reads past its `held` rows), or,
 *    for every cell, the gene-major X with prefix counts every transcoded
 *    store has. The store opened is then the map with this X
 *    (`composite`); the reader worker swaps its reader onto it and the
 *    page reads its genes (`anndata-reader-worker.js`). A gene read before
 *    any open cell's rows are held waits for that swap (`awaitHeldGenes`)
 *    rather than answer every cell "not read".
 *
 * `G` is the cells whose gene index fits this device (`shareFit`, the
 * `columnIndex` share of memory: what a gene sample of a matrix stored by
 * cell is sized by), every cell when they all fit, of the cells a
 * progressive opening grows to (one pass serves its every step); a
 * person's Genes read for asks for more, and a pass keeps those, the share
 * it makes replacing the one kept (`createMatrixStream`). What a pass costs
 * is the stream, whatever `G` is: a uniform sample's cells lie throughout the file,
 * so the pass reads to the last cell of the share (entries sorted by cell:
 * Cell Ranger, STARsolo, GEO's) and stops there, or to the end (sorted by
 * gene: kb-python, alevin-fry; or unsorted). Random access into one gzip
 * member without an index is not possible on these files
 * (`formats/io/deflate-seek.js` measures why).
 *
 * The entries are written as they stream (`entries.js`): sorted by cell
 * they are the `csr_matrix` as they arrive; in any other order they are
 * sorted by cell in bounded blocks after the pass. Counts are kept as
 * float32, as scanpy reads them.
 *
 * @module data/anndata/transcode/matrix-market
 */

import { forEachLine, lineText, splitFields, textPieces } from '../../../formats/text/lines.js';
import { parseBanner, readMatrixMarket } from '../../../formats/text/matrix-market.js';
import { MatrixMarketError } from '../../../formats/text/matrix-market-entries.js';
import { writeModel } from './anndata-model.js';
import { RObjectRefusal, noEmbeddingRefusal } from './refusals.js';
import { transcodeOnce } from './session.js';
import { THIS_TAB, findKeptStores, keptAbout, makeRoomForRetry, openTranscodeSpace } from './space.js';
import { entriesFromJson, entriesToJson, keptStore } from './kept-store.js';
import { cellPriority, matrixInOrder } from './priority.js';
import { AnnDataStoreWriter } from './zarr-writer.js';
import { embeddingColumns, joinTable, mayHoldEmbedding, readTable } from './tables.js';
import { EntryCollector } from './entries.js';
import { PREFIX_COUNTS_KEY } from '../priority-layout.js';
import { columnIndexResidentBytes } from '../matrix-access.js';
import { residencyBudgetBytes } from '../../memory-budget.js';
import { defaultModality } from '../../data-mapping.js';
import { matrixMarketFileSets } from '../../matrix-market-files.js';
import { isFolderMarkerName } from '../../input-formats.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { StringIndex } from '../../../utils/string-index.js';
import { abortReason, cancel, isCancellation, onAbort, throwIfAborted } from '../../../utils/abort.js';

const MATRIX = /(^|[._-])(matrix|cells_x_genes|quants_mat|count_matrix|DGE|gene_count)\.(mtx|txt)(\.gz|\.bz2|\.xz)?$/i;
const COMPRESSION = '(\\.gz|\\.bz2|\\.xz)?';

/** The folder and file name of one path. */
function split(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { folder: '', name: path } : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/**
 * Whether a path is a matrix: the registry's one rule (any `.mtx`, or a
 * sci-RNA-seq3 `gene_count` matrix under a `.txt` name), the rule that makes
 * a folder on this computer or a listing on a host a MatrixMarket folder.
 */
function isMatrixPath(path) {
  return isFolderMarkerName('mtx', path);
}

/**
 * The matrices of a folder, each with its feature and cell lists, the most
 * likely first (filtered over raw; Gene over GeneFull and Velocyto).
 *
 * A `<prefix>matrix.mtx` takes the lists its name pairs it with
 * (`data/matrix-market-files.js`: its own prefix, or a shorter one); one
 * that has none, or two, carries the reason as `problem`.
 *
 * @param {Map<string, File>} files
 * @returns {Array<{matrix: string, features: string|null, cells: string|null, cellsByFeatures: boolean|null, problem: string|null}>}
 */
export function matrixMarketSets(files) {
  const paths = [...files.keys()];
  const has = new Set(paths);
  const find = (folder, stems) => {
    for (const stem of stems) {
      for (const suffix of ['', '.gz', '.bz2', '.xz']) {
        if (has.has(`${folder}${stem}${suffix}`)) return `${folder}${stem}${suffix}`;
      }
    }
    return null;
  };
  const named = matrixMarketFileSets(paths);
  const setOf = new Map(named.sets.map(set => [set.matrix, set]));
  const problemOf = new Map(named.problems.map(item => [item.matrix, item.message]));
  const sets = [];
  for (const path of paths) {
    if (!isMatrixPath(path)) continue;
    const { folder, name } = split(path);
    const stem = name.replace(new RegExp(`\\.mtx${COMPRESSION}$`, 'i'), '');
    let features = null;
    let cells = null;
    let cellsByFeatures = null;
    let problem = null;
    if (/cells_x_genes$/i.test(stem)) {
      features = find(folder, [`${stem}.genes.txt`, `${stem}.genes.names.txt`]);
      cells = find(folder, [`${stem}.barcodes.txt`]);
      cellsByFeatures = true;
    } else if (/quants_mat$/i.test(stem)) {
      features = find(folder, [`${stem}_cols.txt`]);
      cells = find(folder, [`${stem}_rows.txt`]);
      cellsByFeatures = true;
    } else {
      // `<prefix>matrix`: the lists its name pairs it with (GEO's GSM…_).
      features = setOf.get(path)?.features ?? null;
      cells = setOf.get(path)?.cells ?? null;
      problem = problemOf.get(path) ?? null;
    }
    sets.push({ matrix: path, features, cells, cellsByFeatures, problem });
  }
  const score = set => {
    let value = 0;
    if (MATRIX.test(set.matrix)) value -= 8;
    if (set.features !== null && set.cells !== null) value -= 16;
    if (/filtered/i.test(set.matrix)) value -= 4;
    if (/\/Gene\//.test(`/${set.matrix}`)) value -= 2;
    if (/raw/i.test(set.matrix)) value += 1;
    return value;
  };
  return sets.sort((a, b) => score(a) - score(b) || a.matrix.localeCompare(b.matrix));
}

/** The lines of a small text file, split into fields. */
async function readList(reader, { signal, activity }) {
  const rows = [];
  const pieces = await textPieces(reader, { signal, activity });
  let delimiter;
  await forEachLine(pieces, (bytes, start, end) => {
    if (end === start) return;
    const text = lineText(bytes, start, end);
    delimiter ??= text.includes('\t') ? '\t' : text.includes(',') ? ',' : null;
    rows.push(delimiter === null ? [text.trim()] : splitFields(text, delimiter));
  });
  return rows;
}

/** The first lines of a text file (read from its head only), split into fields. */
async function headRows(reader, { signal, activity }) {
  const lines = [];
  await forEachLine(await textPieces(reader, { signal, activity, head: true }), (bytes, start, end) => {
    if (end > start) lines.push(lineText(bytes, start, end));
    return lines.length < 20;
  });
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  const delimiter = lines[0]?.includes('\t') ? '\t' : lines[0]?.includes(',') ? ',' : null;
  return lines.map(line => (delimiter === null ? [line.trim()] : splitFields(line, delimiter)));
}

const BARCODE = /^[ACGTN]{8,}([-_.]\d+)?$/i;
/** A cell list's name that may be a table of the cells: a `.csv`, or an annotation or metadata table. */
const MAYBE_CELL_TABLE = /(\.csv(\.gz|\.bz2|\.xz)?$|annotat|metadata)/i;
const FEATURE_HEADER = /^(genes?|gene[_ .-]?(ids?|names?|symbols?)|features?|feature[_ .-]?(ids?|names?)|ids?)$/i;
const CELL_HEADER = /^(barcodes?|cells?|cell[_ .-]?(ids?|names?|barcodes?)|bc_wells)$/i;

/**
 * Whether a list's first row is its header: it has one row more than the
 * matrix's size line says it names (`dimensions`, the size line's two), or,
 * when its count tells nothing, its first field names a column (`named`).
 */
function hasHeader(rows, dimensions, named) {
  if (rows.length < 2) return false;
  if (dimensions.includes(rows.length - 1) && !dimensions.includes(rows.length)) return true;
  if (dimensions.includes(rows.length)) return false;
  return named.test((rows[0][0] ?? '').trim());
}

/**
 * A feature list: `{ids, names, types}`. With a header, the columns are
 * found by name: the ids (`gene_id`, `id`, else the first), the names
 * (`gene_short_name`, `gene_name`, `symbol`, `name`, else the second) and the
 * feature types (`feature_type`; a biotype such as `gene_type` is a column
 * of genes, not a modality). Without one, Cell Ranger's columns: id, name,
 * type.
 */
function featuresOf(rows, dimensions) {
  if (!hasHeader(rows, dimensions, FEATURE_HEADER)) {
    return {
      ids: rows.map(row => row[0] ?? ''),
      names: rows.map(row => row[1] ?? row[0] ?? ''),
      types: rows.some(row => row.length > 2) ? rows.map(row => row[2] ?? '') : null,
    };
  }
  const header = rows[0].map(name => name.trim());
  const body = rows.slice(1);
  const column = (pattern, otherwise) => {
    const at = header.findIndex(name => pattern.test(name));
    return at >= 0 ? at : otherwise;
  };
  const id = column(/^(gene[_ .-]?ids?|feature[_ .-]?ids?|ids?|ensembl([_ .-]?ids?)?)$/i, 0);
  const name = column(/^(gene[_ .-]?short[_ .-]?names?|gene[_ .-]?names?|gene[_ .-]?symbols?|symbols?|feature[_ .-]?names?|names?)$/i,
    header.length > 1 && id === 0 ? 1 : id);
  const type = column(/^feature[_ .-]?types?$/i, -1);
  return {
    ids: body.map(row => row[id] ?? ''),
    names: body.map(row => row[name] ?? row[id] ?? ''),
    types: type < 0 ? null : body.map(row => row[type] ?? ''),
  };
}

/** A cell list's names: its first column, a header row dropped (`hasHeader`). */
function cellsOf(rows, dimensions) {
  return (hasHeader(rows, dimensions, CELL_HEADER) ? rows.slice(1) : rows).map(row => row[0] ?? '');
}

/**
 * Whether a cell list is a table of the cells (a header, then each cell's
 * name and more columns: a sci-RNA-seq3 `cell_annotate.csv`, Parse's
 * `cell_metadata.csv`), read as one (`readTable`), its columns `obs`, its
 * embedding columns `obsm`; from its first two lines.
 */
function isCellTable(head) {
  if (head.length < 2 || head[0].length < 2) return false;
  // A header: a field after the first that is no number, where the next
  // row's is one or another word (`sample,id,sex,day,…`).
  return head[0].slice(1).some(field => !Number.isFinite(Number(field.trim())) || field.trim() === '');
}

/**
 * A cell list that is a table (`isCellTable`), read as one: its rows the
 * cells. Its first line is its header unless the rows then fall one short
 * of the matrix's cells, which the line is one of.
 */
async function readCellList(reader, dimensions, { signal, activity }) {
  // Its rows are one of the matrix's sides (the cells), so its columns are
  // sized for them at once.
  const rowsHint = Math.max(...dimensions) + 1;
  let table = await readTable(reader, { cells: null, signal, activity, rowsHint });
  if (!dimensions.includes(table.rows) && dimensions.includes(table.rows + 1)) {
    // Its first line was a cell, not a header: read again, the first read
    // let go first (one table held at a time).
    table = null;
    return readTable(reader, { cells: null, signal, activity, header: false, rowsHint });
  }
  return table;
}

/**
 * The folder's cell tables, apart from every matrix's lists; in a folder of
 * several samples (`GSM1_…`, `GSM2_…`), not the other samples' tables.
 */
function tablePaths(files, set) {
  const paths = [...files.keys()];
  const named = matrixMarketFileSets(paths);
  const lists = new Set([set.matrix, set.features, set.cells, ...named.sets.flatMap(item => [item.features, item.cells])]);
  const folderOf = path => path.slice(0, path.lastIndexOf('/') + 1);
  const own = named.sets.find(item => item.matrix === set.matrix)?.prefix.toLowerCase() ?? '';
  const others = named.sets.concat(named.problems)
    .filter(item => folderOf(item.matrix) === folderOf(set.matrix) && item.prefix !== '' && item.matrix !== set.matrix)
    .map(item => item.prefix.toLowerCase())
    .filter(prefix => !own.startsWith(prefix));
  return paths.filter(path => {
    if (lists.has(path) || !/\.(csv|tsv)(\.gz|\.bz2|\.xz)?$/i.test(path) || /(^|\/)(features|genes|barcodes)\.tsv/i.test(path)) return false;
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return !(folderOf(path) === folderOf(set.matrix) && others.some(prefix => name.startsWith(prefix)));
  });
}

/** A name for a table's columns: Cell Ranger's analysis folders by what they are. */
function tablePrefix(path) {
  const clusters = /analysis\/clustering\/([^/]+)\/clusters\.csv/i.exec(path);
  if (clusters) return { prefix: '', rename: { Cluster: clusters[1] } };
  return { prefix: '', rename: {} };
}

/** Cell Ranger projection columns (`UMAP-1`, `TSNE-1`, `PC-1`) name their embedding. */
function projectionName(path) {
  const match = /analysis\/(umap|tsne|pca)\/[^/]+\/projection\.csv/i.exec(path);
  return match ? `X_${match[1].toLowerCase()}` : null;
}

/**
 * The features of each type (`features.tsv` column 3: Gene Expression,
 * Peaks, Antibody Capture, …), in order of first appearance: one group per
 * type, each feature's group and its position in it. One type (or none
 * named) is one group.
 *
 * @param {string[]|null} types
 * @param {number} nFeatures
 */
function featureGroups(types, nFeatures) {
  const named = types === null ? [] : [...new Set(types)];
  if (named.length <= 1) return { groups: [{ type: named[0] ?? null, members: null, count: nFeatures }], groupOf: null, local: null };
  const index = new Map(named.map((type, g) => [type, g]));
  const groupOf = allocateTypedArray(Int32Array, nFeatures, 'Feature groups');
  const local = allocateTypedArray(Int32Array, nFeatures, 'Feature groups');
  const counts = new Array(named.length).fill(0);
  const members = named.map(() => []);
  for (let feature = 0; feature < nFeatures; feature++) {
    const g = index.get(types[feature]);
    groupOf[feature] = g;
    local[feature] = counts[g]++;
    members[g].push(feature);
  }
  return { groups: named.map((type, g) => ({ type, members: members[g], count: counts[g] })), groupOf, local };
}

/** Each feature's group as runs `[group, length]` (kept with the map: the pass deals entries by them). */
function groupRuns(groupOf, nFeatures) {
  if (groupOf === null) return null;
  const runs = [];
  for (let feature = 0; feature < nFeatures; feature++) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === groupOf[feature]) last[1]++;
    else runs.push([groupOf[feature], 1]);
  }
  return runs;
}

/** The grouping of `featureGroups` again, from its runs and the groups' sizes. */
function groupingOfRuns(runs, counts) {
  if (runs === null) return { groupOf: null, local: null };
  const nFeatures = counts.reduce((sum, count) => sum + count, 0);
  const groupOf = allocateTypedArray(Int32Array, nFeatures, 'Feature groups');
  const local = allocateTypedArray(Int32Array, nFeatures, 'Feature groups');
  const next = new Array(counts.length).fill(0);
  let feature = 0;
  for (const [group, length] of runs) {
    for (let i = 0; i < length; i++, feature++) {
      groupOf[feature] = group;
      local[feature] = next[group]++;
    }
  }
  return { groupOf, local };
}

/**
 * The folder's cell tables joined to the cells, into `model`: their columns
 * as `obs`, their coordinates as `obsm`. A table that cannot be read is a
 * note. `read`: tables read already (the cell list, when it is a table).
 */
async function readCellTables(tables, cells, model, readerOf, { signal, activity, read = new Map() }) {
  const cellIndex = tables.length > 0 ? StringIndex.of(cells) : null;
  for (const path of tables) {
    let table = read.get(path) ?? null;
    // The table is let go once joined: its columns live on in the model.
    read.delete(path);
    if (table === null) {
      try {
        table = await readTable(readerOf(path), { cells: cellIndex, signal, activity, rowsHint: cells.length });
      } catch (error) {
        if (signal?.aborted) throw error;
        model.notes.push(`${path} was not read: ${error.message}`);
        continue;
      }
    }
    const { rename } = tablePrefix(path);
    const joined = joinTable(table, cells.length);
    if (joined.matched === 0) continue;
    // A name an earlier table gave a column keeps that table's; one this
    // table repeats is kept, under its portable name (`anndata-model.js`).
    const earlier = new Set(model.obs.columns.map(existing => existing.name));
    for (const column of joined.columns) {
      const name = rename[column.name] ?? column.name;
      if (earlier.has(name)) model.notes.push(`${path} column '${name}' was not read: an earlier table has a column of that name.`);
      else model.obs.columns.push({ name, column: column.column });
    }
    const projection = projectionName(path);
    for (const embedding of joined.obsm) {
      const name = projection ?? embedding.name;
      if (!model.obsm.some(existing => existing.name === name)) model.obsm.push({ ...embedding, name });
    }
  }
}

/**
 * The cells whose gene index fits this device: the `columnIndex` share of
 * memory (`memory-budget.js`), as a gene sample of a matrix stored by cell
 * is sized (`subsample-plan.js` `geneIndexFit`), at the matrix's entries a
 * cell; every cell when they all fit.
 *
 * @param {{nCells: number, nFeatures: number, entries: number}} facts
 * @param {number} [budgetBytes]
 * @returns {number}
 */
export function shareFit({ nCells, nFeatures, entries }, budgetBytes = residencyBudgetBytes('columnIndex')) {
  const perCell = nCells === 0 ? 0 : entries / nCells;
  const bytesOf = cells => columnIndexResidentBytes({ layout: 'sparse', nnz: Math.round(cells * perCell), nObs: cells, nVars: nFeatures });
  if (bytesOf(nCells) <= budgetBytes) return nCells;
  let low = 1;
  let high = nCells;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytesOf(middle) <= budgetBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The store of a map and a matrix share: the map's every entry but its
 * matrices (and their prefix counts), the share's in their place, one
 * consolidated metadata of both. Blobs keep their names under `m/` and `s/`.
 *
 * @param {{entries: Map<string, Object>, blobs: Map<string, Object>}} map
 * @param {{entries: Map<string, Object>, blobs: Map<string, Object>}} share
 * @param {string[]} roots - The paths the share replaces (`X`, `mod/<name>/X`, their prefix counts)
 * @param {string} name
 */
export function composite(map, share, roots, name) {
  const replaced = key => roots.some(root => key === root || key.startsWith(`${root}/`));
  const tagged = (entry, tag) => (entry.blob === undefined ? entry : { ...entry, blob: `${tag}${entry.blob}` });
  const entries = new Map();
  for (const [key, entry] of map.entries) if (key !== '.zmetadata' && !replaced(key)) entries.set(key, tagged(entry, 'm/'));
  for (const [key, entry] of share.entries) if (key !== '.zmetadata') entries.set(key, tagged(entry, 's/'));
  const metadataOf = store => JSON.parse(new TextDecoder().decode(store.entries.get('.zmetadata').bytes)).metadata;
  const metadata = {};
  for (const [key, value] of Object.entries(metadataOf(map))) if (!replaced(key)) metadata[key] = value;
  Object.assign(metadata, metadataOf(share));
  const sorted = {};
  for (const key of Object.keys(metadata).sort()) sorted[key] = metadata[key];
  entries.set('.zmetadata', { bytes: new TextEncoder().encode(JSON.stringify({ metadata: sorted, zarr_consolidated_format: 1 })) });
  const blobs = new Map();
  for (const [blob, reader] of map.blobs) blobs.set(`m/${blob}`, reader);
  for (const [blob, reader] of share.blobs) blobs.set(`s/${blob}`, reader);
  return keptStore(entries, blobs, name);
}

/** The paths a share writes: each modality's X and its prefix counts. */
function shareRoots(facts) {
  return facts.modalities.flatMap(({ path }) => {
    const group = path.slice(0, -'X'.length);
    return [path, `${group}varm/${PREFIX_COUNTS_KEY}`];
  });
}

/**
 * Transcode one MatrixMarket folder: its map first (or as kept), and the
 * matrix share kept before, if any; `matrixStream` reads more of the
 * matrix (`createMatrixStream`).
 *
 * @param {{files: Map<string, File>, rootName: string}} source
 * @param {Object} context - The transcoder context
 */
export async function transcodeMatrixMarketFolder(source, context) {
  const { signal = null, byteReaderOf } = context;
  if (!(source.files instanceof Map)) {
    throw new RObjectRefusal('A MatrixMarket matrix opens as its folder (Open… › Folder…): the matrix needs its feature and barcode files beside it.', { reason: 'not-a-folder' });
  }
  const folderName = source.rootName ?? 'the folder';
  const sets = matrixMarketSets(source.files);
  const complete = sets.filter(item => item.features !== null && item.cells !== null);
  if (complete.length === 0) {
    throw new RObjectRefusal(
      sets.length === 0
        ? `${folderName} holds no MatrixMarket matrix (.mtx or .mtx.gz).`
        : sets[0].problem ??
          `${folderName} holds ${sets[0].matrix}, but not the features (features.tsv or genes.tsv) and barcodes (barcodes.tsv) files beside it that name its rows and columns.`,
      { reason: 'incomplete-folder' }
    );
  }
  const set = await chooseSet(complete, folderName, context);
  // The map: the lists, the tables and the matrix's first lines.
  const own = context.createActivity?.({ kind: 'transcode', label: `the cells and genes of ${folderName}` }) ?? null;
  const activity = own ?? context.activity ?? null;
  const readers = new Map();
  const readerOf = path => {
    if (!readers.has(path)) readers.set(path, byteReaderOf(source.files.get(path)));
    return readers.get(path);
  };
  const usedPaths = usedPathsOf(source.files, set);
  // The map reads the lists and the tables (and the matrix's first lines).
  const mapBytes = usedPaths.slice(1).reduce((sum, path) => sum + source.files.get(path).size, 0);
  activity?.expect?.(mapBytes);
  const identity = matrixMarketIdentity(usedPaths, path => readerOf(path).identity);
  const about = keptAbout({ name: folderName, url: source.files.get(set.matrix)?.url ?? null });
  const tables = usedPaths.slice(3);
  try {
    const map = await transcodeOnce({
      identity,
      fileName: folderName,
      about,
      bytes: mapBytes,
      link: readerOf(set.matrix).link,
      context,
      build: space => buildMap(space, { set, tables, readerOf, folderName, matrixBytes: source.files.get(set.matrix).size, mapBytes, context, signal, activity }),
    });
    own?.finish();
    const facts = map.object.stream;
    // A kept store whose matrix is whole.
    if (facts == null) return map;
    // Read after the map, in the reader worker (`anndata-reader-worker.js`).
    const matrixStream = await createMatrixStream(map, facts, { identity, about, folderName, readerOf, context });
    return { ...map, store: matrixStream.store(), matrixStream };
  } catch (thrown) {
    // A MatrixMarket file Cellucid does not read is said in its own words.
    const error = thrown instanceof MatrixMarketError
      ? new RObjectRefusal(`${set.matrix}: ${thrown.message}`, { reason: thrown.unsupported ? 'unsupported' : 'damaged' })
      : thrown;
    own?.finish(error);
    throw error;
  }
}

/**
 * Write the map: the lists, the cell tables, an X with no entry yet. Refused
 * from the tables' first lines when none can give an embedding (GEO
 * GSE158055: 5.8 MB of barcodes, a 9 MB table of cell types only, an 8.2 GB
 * matrix), before the lists, the tables or the matrix are read.
 */
async function buildMap(space, { set, tables, readerOf, folderName, matrixBytes, mapBytes, context, signal, activity }) {
  const refusal = () => noEmbeddingRefusal(`This MatrixMarket matrix (${set.matrix})`, {
    outs: /feature_bc_matrix|gene_bc_matrices/.test(set.matrix),
    fromLink: context.fromLink === true,
  });
  const [size, embeddable, cellHead] = await Promise.all([
    sizeOf(readerOf(set.matrix), context),
    Promise.all(tables.map(path => mayHoldEmbedding(readerOf(path), { signal, activity }).catch(error => {
      if (signal?.aborted) throw error;
      // A table that cannot be read so is read whole, as before.
      return true;
    }))),
    // A cell list named as a table (`.csv`, an annotation or metadata
    // table) may be one: its first lines say. A barcode list is not read
    // before the refusal.
    MAYBE_CELL_TABLE.test(split(set.cells).name) ? headRows(readerOf(set.cells), { signal, activity }) : [],
  ]);
  // A cell list that is a table of the cells is one of the tables too.
  const cellTable = isCellTable(cellHead);
  if (!embeddable.includes(true) && !(cellTable && embeddingColumns(cellHead[0], () => true).length > 0)) throw refusal();
  const dimensions = [size.rows, size.columns];
  const read = new Map();
  const [featureRows, cells] = await Promise.all([
    readList(readerOf(set.features), { signal, activity }),
    cellTable ? readCellList(readerOf(set.cells), dimensions, { signal, activity }).then(table => {
      read.set(set.cells, table);
      return table.cellNames;
    }) : readList(readerOf(set.cells), { signal, activity }).then(rows => cellsOf(rows, dimensions)),
  ]);
  const features = featuresOf(featureRows, dimensions);
  const orientation = await orientationOf(set, features.ids.length, cells, size, context);
  const model = {
    kind: 'MatrixMarket',
    version: null,
    obs: { names: cells, columns: [] },
    obsm: [],
    obsp: [],
    uns: {},
    notes: [],
    modalities: [],
  };
  // One modality per feature type, as a 10x matrix of several types
  // (`views/tenx-h5.js`): named by the type, the default chosen as for
  // every multimodal store (`defaultModality`).
  const grouping = featureGroups(features.types, features.ids.length);
  const single = grouping.groups.length === 1;
  const facts = {
    matrix: set.matrix,
    matrixBytes,
    cellsByFeatures: orientation,
    nCells: cells.length,
    nFeatures: features.ids.length,
    entries: size.entries,
    modalities: [],
    counts: grouping.groups.map(group => group.count),
    runs: groupRuns(grouping.groupOf, features.ids.length),
  };
  // A matrix no larger than what the map reads costs no more to read than
  // the map does: it is read now, as the tables are, and the store opens
  // whole. So is a matrix of several modalities: a modality's genes are
  // read for every open cell, with no gene sample to stop at the rows held.
  // Any other is read after the map is drawn (`createMatrixStream`).
  const inline = matrixBytes <= mapBytes || !single;
  throwIfAborted(signal);
  const streaming = new AbortController();
  const stopStreaming = onAbort(signal, () => streaming.abort(signal.reason));
  const matrixRead = inline
    ? collectMatrix(space, cells.length, { facts, reader: readerOf(set.matrix), signal: streaming.signal, activity })
    : Promise.resolve(null);
  matrixRead.catch(() => {});
  let matrices;
  try {
    await readCellTables(cellTable ? [set.cells, ...tables] : tables, cells, model, readerOf, { signal, activity, read });
    if (model.obsm.length === 0) throw refusal();
    matrices = await matrixRead;
  } catch (error) {
    // The matrix read stops (and is waited for: nothing of it is left running).
    streaming.abort(error);
    await matrixRead.catch(() => {});
    throw error;
  } finally {
    stopStreaming();
  }
  const modalities = grouping.groups.map((group, g) => {
    const pick = values => (group.members === null ? values : group.members.map(feature => values[feature]));
    const names = pick(features.names);
    const varColumns = [{ name: 'gene_ids', column: textColumn(pick(features.ids)) }];
    if (features.types !== null) varColumns.push({ name: 'feature_types', column: textColumn(pick(features.types)) });
    return {
      name: single ? 'RNA' : group.type,
      features: names,
      var: { rows: names.length, columns: varColumns },
      variable: new Set(),
      cells: null,
      group: g,
      // Read now (`inline`), or its entries arrive with the matrix share.
      layers: [{ name: 'counts', build: async () => (inline ? matrices[g] : { format: 'csr', shape: [cells.length, group.count], empty: true }) }],
    };
  });
  const first = defaultModality(modalities.map(modality => modality.name));
  model.modalities.push(...modalities.sort((a, b) => (a.name === first ? -1 : b.name === first ? 1 : 0)));
  facts.modalities = model.modalities.map(modality => ({ path: single ? 'X' : `mod/${modality.name}/X`, group: modality.group }));
  const written = await writeModel(model, space, { readRegion: region => space.read(region), signal });
  return [{
    name: '',
    label: `${folderName} (MatrixMarket, ${formatCountOf(written.nObs, 'cell')})`,
    kind: 'MatrixMarket',
    version: null,
    notes: model.notes,
    written,
    // The matrix read after the map: what its passes need.
    ...(inline ? {} : { stream: facts }),
  }];
}

/**
 * The matrix of a map, read in shares (`matrix-market.js` overview).
 *
 * @typedef {Object} MatrixStream
 * @property {number} nObs - The cells (the store's rows)
 * @property {number} held - Rows `[0, held)` of the store hold their matrix rows
 * @property {number} reading - The rows the pass under way keeps (0: none runs)
 * @property {number} fitCells - The share sized to this device (`shareFit`)
 * @property {number} bytes - The matrix file's size, as stored
 * @property {() => Object} store - The store now: the map, with the share kept
 * @property {(target: number, options?: {signal?: AbortSignal|null, onProgress?: Function|null}) => Promise<{store: Object, held: number}>} ensure -
 *   A share of at least `target` rows: kept already, or one pass over the
 *   matrix, shared with every caller (`createMatrixStream`)
 * @property {() => void} letGo - Let go of the shares a larger one replaced,
 *   once no reader reads their store: removed when nobody else holds them
 */

/**
 * The passes over the matrix are what a matrix read after its map costs: a
 * pass reads the stream to the last cell of its share -- nearly all of it,
 * whatever the share's size, for cells spread over the file in priority
 * order -- and keeps the share's rows only. So whoever asks for rows does so
 * through one pass:
 *
 * - a share the store holds is answered at once;
 * - a pass under way for as many rows or more serves every caller waiting,
 *   and stops only once none waits any more (one caller stopping, a gene
 *   read canceled, leaves it to the others);
 * - more rows asked for while a smaller pass runs stop it: the larger pass
 *   serves its callers too (its rows begin with theirs), after one reading
 *   from now instead of the rest of one and a whole other;
 * - a pass reads the most rows any caller waiting asks for;
 * - a completed share replaces the one before it, whose directory is let go
 *   once no reader reads it (`letGo`): one share kept for a folder's
 *   version, the largest (`keptShare` keeps it so across visits too).
 *
 * A progressive opening asks once, for the cells it grows to, not for each
 * step's (`AnnDataReader.shareRows`).
 *
 * @returns {Promise<MatrixStream>}
 */
async function createMatrixStream(map, facts, { identity, about, folderName, readerOf, context }) {
  const environment = context.environment ?? globalThis;
  const memory = context.memory === true;
  const tab = context.tab ?? THIS_TAB;
  const onStore = context.onStore ?? null;
  const shareIdentity = { matrixShare: identity };
  const roots = shareRoots(facts);
  /** The share the store holds: `{entries, blobs, held, directory, release}`, or null. */
  let share = memory ? null : await keptShare(shareIdentity, environment, tab, onStore);
  let store = share === null ? map.store : composite(map, share, roots, folderName);
  /** Shares a larger one replaced, let go once no reader reads them (`letGo`). */
  const replaced = [];
  /** The pass under way: `{rows, stop, waiters, replaced, done}`, or null. */
  let running = null;
  /** The rows each call of `ensure` waiting asks for: a pass reads the most of them. */
  const asked = new Map();
  let nextCall = 0;
  const start = (rows, onProgress) => {
    const pass = { rows, stop: new AbortController(), waiters: 0, replaced: false, done: null };
    pass.done = readShare(rows, { facts, shareIdentity, about, readerOf, context, environment, memory, tab, signal: pass.stop.signal, onProgress })
      .then(made => {
        if (share !== null) replaced.push(share);
        share = made;
        store = composite(map, made, roots, folderName);
      })
      .finally(() => {
        if (running === pass) running = null;
      });
    pass.done.catch(() => {});
    running = pass;
    return pass;
  };
  /** Wait for `pass` while `signal` lets this caller wait; the pass stops once no caller waits for it. */
  const waitFor = (pass, signal) => new Promise((resolve, reject) => {
    let waiting = true;
    let stopListening = () => {};
    const leave = () => {
      if (!waiting) return false;
      waiting = false;
      stopListening();
      pass.waiters--;
      return true;
    };
    pass.waiters++;
    stopListening = onAbort(signal, () => {
      if (!leave()) return;
      if (pass.waiters === 0) cancel(pass.stop, 'superseded', 'No one waits for this share of the matrix any more.');
      reject(abortReason(signal));
    });
    pass.done.then(() => leave() && resolve(), error => leave() && reject(error));
  });
  const stream = {
    nObs: facts.nCells,
    get held() {
      return share?.held ?? 0;
    },
    get reading() {
      return running?.rows ?? 0;
    },
    fitCells: shareFit(facts),
    bytes: facts.matrixBytes,
    store: () => store,
    async ensure(target, { signal = null, onProgress = null } = {}) {
      const rows = Math.min(facts.nCells, Math.max(1, Math.ceil(target)));
      const call = nextCall++;
      asked.set(call, rows);
      try {
        while ((share?.held ?? 0) < rows) {
          if (signal?.aborted) throw abortReason(signal);
          if (running !== null && running.rows < rows) {
            // More rows than the pass under way reads: it stops, and the
            // larger pass serves its callers too.
            const smaller = running;
            smaller.replaced = true;
            cancel(smaller.stop, 'superseded', 'A larger share of the matrix is read instead.');
            await smaller.done.catch(() => {});
            continue;
          }
          const pass = running ?? start(Math.max(...asked.values()), onProgress);
          try {
            await waitFor(pass, signal);
          } catch (error) {
            // Replaced by a larger pass, which serves this call too.
            if (pass.replaced && !signal?.aborted) continue;
            throw error;
          }
        }
      } finally {
        asked.delete(call);
      }
      return { store, held: share.held };
    },
    letGo() {
      for (const old of replaced.splice(0)) {
        old.release?.();
        if (old.directory != null) onStore?.({ directory: old.directory, state: 'replaced' });
      }
    },
  };
  return stream;
}

/** The largest matrix share kept for the folder's version, held; the others removed once nobody uses them. */
async function keptShare(shareIdentity, environment, tab, onStore) {
  const found = await findKeptStores(shareIdentity, environment, { tab });
  if (found.length === 0) return null;
  const heldOf = item => Number(item.manifest.objects?.[0]?.stream?.held ?? 0);
  found.sort((a, b) => heldOf(b) - heldOf(a));
  for (const other of found.slice(1)) void other.discard();
  const [best] = found;
  onStore?.({ directory: best.directory, state: 'complete' });
  return { entries: entriesFromJson(best.manifest.objects[0].entries), blobs: best.blobs, held: heldOf(best), directory: best.directory, release: best.release };
}

/** One pass over the matrix, keeping rows `[0, rows)` (priority order), as a share of its own; once more after room is made when the quota refuses it. */
async function readShare(rows, options) {
  try {
    return await readShareOnce(rows, options);
  } catch (error) {
    if (error?.details?.reason !== 'storage-full' || options.memory) throw error;
    const deficit = Number.isFinite(error.details.written) ? error.details.written : Infinity;
    if (await makeRoomForRetry(options.environment, deficit) === 0) throw error;
    return readShareOnce(rows, options);
  }
}

async function readShareOnce(rows, { facts, shareIdentity, about, readerOf, context, environment, memory, tab, signal, onProgress }) {
  const onStore = context.onStore ?? null;
  const space = await openTranscodeSpace(shareIdentity, {
    memory,
    environment,
    tab,
    onDirectory: directory => onStore?.({ directory, state: 'writing' }),
  });
  try {
    const activity = context.createActivity?.({ kind: 'transcode', label: `${facts.matrix}: genes of ${formatCountOf(rows, 'cell')}` }) ?? null;
    let written;
    try {
      written = await streamShare(space, rows, { facts, reader: readerOf(facts.matrix), signal, activity, onProgress });
      activity?.finish();
    } catch (error) {
      activity?.finish(error);
      throw error;
    }
    const manifest = {
      whole: true,
      about,
      objects: [{
        name: '',
        label: `${facts.matrix} (genes of ${formatCountOf(rows, 'cell')})`,
        kind: 'MatrixMarket',
        version: null,
        notes: [],
        entries: entriesToJson(written.entries),
        stream: { held: rows },
      }],
    };
    const blobs = await space.finish(manifest, written.used);
    if (space.directory !== null) onStore?.({ directory: space.directory, state: 'complete' });
    return { entries: written.entries, blobs, held: rows, directory: space.directory, release: () => space.release() };
  } catch (error) {
    await space.discard();
    throw error;
  }
}

/**
 * Stream the matrix once, keeping the entries of the cells in store rows
 * `[0, rows)` (`cellPriority`: the cells of the lowest ranks): one matrix
 * per feature group, in file order of the cells when every one is kept,
 * else by store row (rows `[0, rows)`); the stream is left at the share's
 * last cell when its entries come sorted by cell.
 *
 * @returns {Promise<Object[]>} Each group's matrix (`EntryCollector.finish`)
 */
async function collectMatrix(space, rows, { facts, reader, signal, activity, onProgress = null, priority = cellPriority(facts.nCells) }) {
  // A pass stopped before it began opens and reads nothing.
  throwIfAborted(signal);
  const { nCells, cellsByFeatures, entries: declared } = facts;
  const { position } = priority;
  const every = rows >= nCells;
  // The last cell (file order) of the share: past it, a stream sorted by
  // cell holds no more of it.
  let lastKept = nCells - 1;
  if (!every) {
    lastKept = -1;
    for (let cell = nCells - 1; cell >= 0; cell--) {
      if (position[cell] < rows) {
        lastKept = cell;
        break;
      }
    }
  }
  const { groupOf, local } = groupingOfRuns(facts.runs, facts.counts);
  const collectors = [];
  for (const count of facts.counts) {
    collectors.push(await EntryCollector.open(space, {
      nCells: every ? nCells : rows,
      nFeatures: count,
      entries: every && groupOf === null ? declared : null,
      Values: Float32Array,
      signal,
    }));
  }
  const reading = new AbortController();
  const stopReading = onAbort(signal, () => reading.abort(signal.reason));
  // Sorted by cell, then feature: cells never go back, and within a cell
  // features go up. A stream sorted by gene looks so too while its first
  // gene lasts (cells rising, one entry each), so the stream is taken as
  // sorted by cell only once a new cell has been seen to start its
  // features again from a lower one (`byCellSeen`).
  let sortedByCell = true;
  let byCellSeen = false;
  let lastCell = -1;
  let lastFeature = -1;
  let ended = false;
  let kept = 0;
  let scratch = null;
  activity?.expect?.(facts.matrixBytes);
  try {
    const pieces = await textPieces(reader, { signal: reading.signal, activity });
    await readMatrixMarket(pieces, {
      signal: reading.signal,
      valueType: 'float32',
      onSize(found) {
        const expected = cellsByFeatures ? [nCells, facts.nFeatures] : [facts.nFeatures, nCells];
        if (found.rows !== expected[0] || found.columns !== expected[1] || found.entries !== declared) {
          throw new RObjectRefusal(`${facts.matrix} changed since its map was read: it is ${found.rows} × ${found.columns} now.`, { reason: 'mismatched-lists' });
        }
      },
      onEntries(rowsOf, columnsOf, values, count) {
        const cells = cellsByFeatures ? rowsOf : columnsOf;
        const features = cellsByFeatures ? columnsOf : rowsOf;
        if (scratch === null || scratch.cells.length < count) {
          scratch = {
            cells: allocateTypedArray(Int32Array, count, 'Matrix entries'),
            features: allocateTypedArray(Int32Array, count, 'Matrix entries'),
            values: allocateTypedArray(Float32Array, count, 'Matrix entries'),
          };
        }
        if (groupOf === null) {
          let at = 0;
          for (let k = 0; k < count; k++) {
            const cell = cells[k];
            const feature = features[k];
            if (cell < lastCell || (cell === lastCell && feature <= lastFeature)) sortedByCell = false;
            else if (cell > lastCell && feature < lastFeature) byCellSeen = true;
            lastCell = cell;
            lastFeature = feature;
            const row = every ? cell : position[cell];
            if (row >= rows) continue;
            scratch.cells[at] = row;
            scratch.features[at] = feature;
            scratch.values[at++] = values[k];
          }
          if (at > 0) collectors[0].addBatch(scratch.cells, scratch.features, scratch.values, at);
          kept += at;
        } else {
          for (let k = 0; k < count; k++) {
            const cell = cells[k];
            const feature = features[k];
            if (cell < lastCell || (cell === lastCell && feature <= lastFeature)) sortedByCell = false;
            else if (cell > lastCell && feature < lastFeature) byCellSeen = true;
            lastCell = cell;
            lastFeature = feature;
            collectors[groupOf[feature]].add(every ? cell : position[cell], local[feature], values[k]);
          }
          kept += count;
        }
        onProgress?.({ cells: lastCell + 1, kept });
        if (!every && sortedByCell && byCellSeen && lastCell > lastKept) {
          // Sorted by cell, and past the share's last cell: the rest is not read.
          ended = true;
          cancel(reading, 'closed', 'The rest of the matrix holds no cell of the share.');
        }
      },
    });
  } catch (error) {
    if (!(ended && isCancellation(error) && !signal?.aborted)) throw error;
  } finally {
    stopReading();
  }
  const matrices = [];
  for (const collector of collectors) matrices.push(await collector.finish({ byCell: !every }));
  return matrices;
}

/**
 * One pass over the matrix keeping store rows `[0, rows)` (`collectMatrix`),
 * written as each modality's X: by cell, its rows from `rows` on holding
 * nothing, or for every row by feature with its prefix counts.
 */
async function streamShare(space, rows, { facts, reader, signal, activity, onProgress }) {
  const { nCells } = facts;
  const priority = cellPriority(nCells);
  const every = rows >= nCells;
  const matrices = await collectMatrix(space, rows, { facts, reader, signal, activity, onProgress, priority });
  const writer = new AnnDataStoreWriter(space);
  const context = { space, readRegion: region => space.read(region), signal };
  for (const { path, group } of facts.modalities) {
    const matrix = matrices[group];
    if (every) {
      // Every cell: by feature in priority order, with its prefix counts,
      // as every transcoded store's X (`anndata-model.js`).
      const ordered = await matrixInOrder(matrix, priority, context, { expression: true, levels: priority.levels });
      await writer.sparse(path, ordered);
      if (ordered.prefixCounts !== undefined) {
        await writer.array(`${path.slice(0, -'X'.length)}varm/${PREFIX_COUNTS_KEY}`, {
          values: ordered.prefixCounts,
          shape: [ordered.shape[1], priority.levels.length],
          order: 'F',
        });
      }
      continue;
    }
    // The share's rows, by cell, then rows holding nothing up to every cell.
    const shareRows = matrix.indptr.values;
    const indptr = allocateTypedArray(shareRows.constructor, nCells + 1, 'Matrix pointers');
    indptr.set(shareRows);
    indptr.fill(shareRows[rows], rows + 1);
    await writer.sparse(path, { ...matrix, shape: [nCells, matrix.shape[1]], indptr: { values: indptr } });
  }
  return writer.finish();
}

/** The files one set's store is read from: its matrix, its two lists, and the folder's cell tables. */
function usedPathsOf(files, set) {
  return [set.matrix, set.features, set.cells, ...tablePaths(files, set)];
}

/** What a MatrixMarket folder's store is filed under: every file it is read from, by its path and identity. */
function matrixMarketIdentity(paths, identityOf) {
  return { kind: 'matrix-market', files: paths.map(path => ({ path, ...identityOf(path) })) };
}

/**
 * What the store of a set of remote MatrixMarket files would be filed
 * under, as a page asks before it downloads any of them (a member its host
 * serves only whole): null when opening it may ask which sample to open.
 *
 * @param {Map<string, {identity?: Object}>} files
 * @returns {Object|null}
 */
export function matrixMarketSetIdentity(files) {
  const complete = matrixMarketSets(files).filter(item => item.features !== null && item.cells !== null);
  if (complete.length === 0) return null;
  const [first] = complete;
  if (complete.some(item => item.matrix !== first.matrix && sameStanding(item, first))) return null;
  return matrixMarketIdentity(usedPathsOf(files, first), path => files.get(path).identity ?? null);
}

/**
 * The matrix set to open: the most likely one, or, when several samples are
 * equally likely (a GEO series' `GSM…_matrix.mtx.gz` files in one folder),
 * the one the person picks.
 */
async function chooseSet(complete, folderName, context) {
  const [first] = complete;
  const samples = complete.filter(item => item.matrix !== first.matrix && sameStanding(item, first));
  if (samples.length === 0 || typeof context.choose !== 'function') return first;
  const options = [first, ...samples];
  const index = await context.choose({
    question: `${folderName} holds ${options.length} MatrixMarket samples. Which one should open?`,
    options: options.map(item => item.matrix),
  });
  return options[index] ?? first;
}

/** Whether two sets are alike but for their sample prefix (same folder, same kind of names). */
function sameStanding(a, b) {
  const folderOf = path => path.slice(0, path.lastIndexOf('/') + 1);
  return folderOf(a.matrix) === folderOf(b.matrix) && MATRIX.test(a.matrix) === MATRIX.test(b.matrix) &&
    /filtered/i.test(a.matrix) === /filtered/i.test(b.matrix) && /raw/i.test(a.matrix) === /raw/i.test(b.matrix);
}

/** A text list as a categorical column. */
function textColumn(values) {
  const categories = [...new Set(values)].sort();
  const code = new Map(categories.map((value, index) => [value, index]));
  const codes = allocateTypedArray(categories.length < 128 ? Int8Array : categories.length < 32768 ? Int16Array : Int32Array, values.length, 'Category codes');
  values.forEach((value, index) => { codes[index] = code.get(value); });
  return { kind: 'categorical', codes, categories, ordered: false };
}

/**
 * Whether the matrix is cells × features (true) or features × cells: from
 * its size line against the lists, the producer's name, the barcodes'
 * look, or the person.
 */
async function orientationOf(set, nFeatures, cells, { rows, columns }, context) {
  const featuresByCells = rows === nFeatures && columns === cells.length;
  const cellsByFeatures = rows === cells.length && columns === nFeatures;
  if (featuresByCells && !cellsByFeatures) return false;
  if (cellsByFeatures && !featuresByCells) return true;
  if (!featuresByCells && !cellsByFeatures) {
    throw new RObjectRefusal(
      `${set.matrix} is ${rows} × ${columns}, but ${set.features} names ${formatCountOf(nFeatures, 'feature')} and ${set.cells} names ${formatCountOf(cells.length, 'cell')}.`,
      { reason: 'mismatched-lists' }
    );
  }
  if (set.cellsByFeatures !== null) return set.cellsByFeatures;
  if (cells.length > 0 && cells.every(cell => BARCODE.test(cell))) return false;
  if (typeof context.choose === 'function') {
    const index = await context.choose({
      question: `${set.matrix} has as many rows as columns. Which are the cells?`,
      options: ['Columns are cells (Cell Ranger, STARsolo)', 'Rows are cells (kb-python, alevin-fry)'],
    });
    return index === 1;
  }
  return false;
}

/** The banner and size line of a MatrixMarket file (read from its head only). */
async function sizeOf(reader, { signal = null } = {}) {
  const pieces = await textPieces(reader, { signal, head: true });
  let found = null;
  let banner = null;
  await forEachLine(pieces, (bytes, start, end) => {
    if (banner === null) {
      banner = parseBanner(lineText(bytes, start, end));
      return true;
    }
    if (end === start || bytes[start] === 0x25) return true;
    const parts = lineText(bytes, start, end).trim().split(/\s+/).map(Number);
    found = { rows: parts[0], columns: parts[1], entries: parts[2], field: banner.field };
    return false;
  });
  if (found === null) throw new MatrixMarketError('The MatrixMarket file has no size line.');
  return found;
}
