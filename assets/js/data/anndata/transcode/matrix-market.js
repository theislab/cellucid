/**
 * The transcoder of MatrixMarket folders: a count matrix (`matrix.mtx` or
 * `.mtx.gz`) with its feature and barcode lists, as Cell Ranger, STARsolo,
 * kb-python, alevin-fry and Parse write them, read once into a cells ×
 * features `csr_matrix`, with the cell tables found beside it as `obs` and
 * `obsm`.
 *
 * | Producer | matrix | features | cells | orientation |
 * | --- | --- | --- | --- | --- |
 * | Cell Ranger 3+ | `matrix.mtx.gz` | `features.tsv.gz` (id, name, type) | `barcodes.tsv.gz` | features × cells |
 * | Cell Ranger 2, STARsolo | `matrix.mtx` | `genes.tsv` / `features.tsv` | `barcodes.tsv` | features × cells |
 * | kb-python | `cells_x_genes.mtx` | `cells_x_genes.genes.txt` | `cells_x_genes.barcodes.txt` | cells × features |
 * | alevin-fry | `quants_mat.mtx` | `quants_mat_cols.txt` | `quants_mat_rows.txt` | cells × features |
 * | GEO uploads | `<prefix>matrix.mtx.gz` | `<prefix>features`/`genes` | `<prefix>barcodes` | as the producer |
 *
 * The orientation is decided by the matrix's size against the two lists'
 * lengths; when both fit (as many cells as features), by the file name
 * (`cells_x_*`), else the person is asked.
 *
 * The entries are written as they stream (`entries.js`): Cell Ranger and
 * STARsolo sort them by cell, so the file is the `csr_matrix` as it
 * arrives; kb-python and alevin-fry sort them by feature, so it is the
 * `csc_matrix` as it arrives; a file in any other order is sorted by cell
 * in bounded blocks after the pass. Counts are kept as float32, as scanpy
 * reads them.
 *
 * Features of several types (`features.tsv` column 3: Gene Expression with
 * Peaks in a multiome matrix, Antibody Capture in CITE-seq) are one
 * modality per type, named by the type, as in a 10x `.h5`
 * (`views/tenx-h5.js`); the entries are dealt to their type's matrix as
 * they stream.
 *
 * A matrix has no cell embedding. The folder's own cell tables give one:
 * Cell Ranger's `analysis/{umap,tsne,pca}/*\/projection.csv` and
 * `analysis/clustering/*\/clusters.csv`, and any `*.csv`/`*.tsv` table of
 * the cells (`UMAP_1`/`UMAP_2`-style columns become `obsm`). Without one the
 * folder is refused with how to compute one (D4).
 *
 * @module data/anndata/transcode/matrix-market
 */

import { forEachLine, lineText, splitFields, textPieces } from '../../../formats/text/lines.js';
import { parseBanner, readMatrixMarket } from '../../../formats/text/matrix-market.js';
import { MatrixMarketError } from '../../../formats/text/matrix-market-entries.js';
import { writeModel } from './anndata-model.js';
import { RObjectRefusal, noEmbeddingRefusal } from './refusals.js';
import { transcodeOnce } from './session.js';
import { joinTable, readTable } from './tables.js';
import { EntryCollector } from './entries.js';
import { defaultModality } from '../../data-mapping.js';
import { matrixMarketFileSets } from '../../matrix-market-files.js';
import { formatCountOf } from '../../../utils/format-units.js';

const MATRIX = /(^|[._-])(matrix|cells_x_genes|quants_mat|count_matrix|DGE)\.mtx(\.gz|\.bz2|\.xz)?$/i;
const ANY_MATRIX = /\.mtx(\.gz|\.bz2|\.xz)?$/i;
const COMPRESSION = '(\\.gz|\\.bz2|\\.xz)?';

/** The folder and file name of one path. */
function split(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { folder: '', name: path } : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
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
    if (!ANY_MATRIX.test(path)) continue;
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

const BARCODE = /^[ACGTN]{8,}([-_.]\d+)?$/i;

/** A feature list: `{ids, names, types}`; a header line (Parse's all_genes.csv) is dropped. */
function featuresOf(rows) {
  let body = rows;
  if (rows.length > 0 && /^(gene_id|gene|feature|id)/i.test(rows[0][0] ?? '') && rows.length > 1) body = rows.slice(1);
  return {
    ids: body.map(row => row[0] ?? ''),
    names: body.map(row => row[1] ?? row[0] ?? ''),
    types: body.some(row => row.length > 2) ? body.map(row => row[2] ?? '') : null,
  };
}

function cellsOf(rows) {
  let body = rows;
  if (rows.length > 1 && /^(barcode|cell|bc_wells)/i.test(rows[0][0] ?? '')) body = rows.slice(1);
  return body.map(row => row[0] ?? '');
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
  const groupOf = new Int32Array(nFeatures);
  const local = new Int32Array(nFeatures);
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

/**
 * The folder's cell tables joined to the cells, into `model`: their columns
 * as `obs`, their coordinates as `obsm`. A table that cannot be read is a
 * note.
 */
async function readCellTables(tables, cells, model, readerOf, { signal, activity }) {
  for (const path of tables) {
    let table;
    try {
      table = await readTable(readerOf(path), { signal, activity });
    } catch (error) {
      if (signal?.aborted) throw error;
      model.notes.push(`${path} was not read: ${error.message}`);
      continue;
    }
    const { rename } = tablePrefix(path);
    const joined = joinTable(table, cells);
    if (joined.matched === 0) continue;
    for (const column of joined.columns) {
      const name = rename[column.name] ?? column.name;
      if (!model.obs.columns.some(existing => existing.name === name)) model.obs.columns.push({ name, column: column.column });
    }
    const projection = projectionName(path);
    for (const embedding of joined.obsm) {
      const name = projection ?? embedding.name;
      if (!model.obsm.some(existing => existing.name === name)) model.obsm.push({ ...embedding, name });
    }
  }
}

/**
 * Stream one MatrixMarket file into cells × features compressed matrices in
 * the space: one per feature group (`featureGroups`), each entry dealt to
 * its feature's group as it streams.
 */
async function streamMatrix(reader, { cellsByFeatures, nCells, nFeatures, entries, grouping }, space, { signal, activity }) {
  const { groups, groupOf, local } = grouping;
  const collectors = [];
  for (const group of groups) {
    collectors.push(await EntryCollector.open(space, {
      nCells, nFeatures: group.count, entries: groupOf === null ? entries : null, Values: Float32Array, signal,
    }));
  }
  const pieces = await textPieces(reader, { signal, activity });
  await readMatrixMarket(pieces, {
    signal,
    valueType: 'float32',
    onSize(found) {
      const rows = cellsByFeatures ? nCells : nFeatures;
      const columns = cellsByFeatures ? nFeatures : nCells;
      if (found.rows !== rows || found.columns !== columns || found.entries !== entries) {
        throw new RObjectRefusal(
          `The matrix is ${found.rows} × ${found.columns}, but its lists name ${formatCountOf(nFeatures, 'feature')} and ${formatCountOf(nCells, 'cell')}.`,
          { reason: 'mismatched-lists' }
        );
      }
    },
    onEntries(rows, columns, values, count) {
      const cells = cellsByFeatures ? rows : columns;
      const features = cellsByFeatures ? columns : rows;
      if (groupOf === null) {
        collectors[0].addBatch(cells, features, values, count);
        return;
      }
      for (let k = 0; k < count; k++) {
        const feature = features[k];
        collectors[groupOf[feature]].add(cells[k], local[feature], values[k]);
      }
    },
  });
  const matrices = [];
  for (const collector of collectors) matrices.push(await collector.finish());
  return matrices;
}

/**
 * Transcode one MatrixMarket folder.
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
  const own = context.createActivity?.({ kind: 'transcode', label: set.matrix }) ?? null;
  const activity = own ?? context.activity ?? null;
  const readers = new Map();
  const readerOf = path => {
    if (!readers.has(path)) readers.set(path, byteReaderOf(source.files.get(path)));
    return readers.get(path);
  };
  const tables = tablePaths(source.files, set);
  const usedPaths = [set.matrix, set.features, set.cells, ...tables];
  activity?.expect?.(usedPaths.reduce((sum, path) => sum + source.files.get(path).size, 0));
  const identity = { kind: 'matrix-market', files: usedPaths.map(path => ({ path, ...readerOf(path).identity })) };
  try {
    const result = await transcodeOnce({
      identity,
      fileName: folderName,
      link: readerOf(set.matrix).link,
      context,
      build: async space => {
        // The size line and the two lists are read together; the matrix
        // then streams while the cell tables are read, and the tables decide
        // first whether the folder has an embedding at all.
        const [size, featureRows, cellRows] = await Promise.all([
          sizeOf(readerOf(set.matrix), context),
          readList(readerOf(set.features), { signal, activity }),
          readList(readerOf(set.cells), { signal, activity }),
        ]);
        const features = featuresOf(featureRows);
        const cells = cellsOf(cellRows);
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
        // (`views/tenx-h5.js`): named by the type, the default chosen as
        // for every multimodal store (`defaultModality`).
        const grouping = featureGroups(features.types, features.ids.length);
        const streaming = new AbortController();
        const stopStreaming = () => streaming.abort(signal.reason);
        signal?.addEventListener('abort', stopStreaming);
        const matrixRead = streamMatrix(readerOf(set.matrix), {
          cellsByFeatures: orientation, nCells: cells.length, nFeatures: features.ids.length, entries: size.entries, grouping,
        }, space, { signal: streaming.signal, activity });
        matrixRead.catch(() => {});
        let matrices;
        try {
          await readCellTables(tables, cells, model, readerOf, { signal, activity });
          if (model.obsm.length === 0) {
            throw noEmbeddingRefusal(`This MatrixMarket matrix (${set.matrix})`, {
              outs: /feature_bc_matrix|gene_bc_matrices/.test(set.matrix),
              fromLink: context.fromLink === true,
            });
          }
          matrices = await matrixRead;
        } catch (error) {
          // The matrix read stops (and is waited for: nothing of it is left running).
          streaming.abort(error);
          await matrixRead.catch(() => {});
          throw error;
        } finally {
          signal?.removeEventListener('abort', stopStreaming);
        }
        const single = grouping.groups.length === 1;
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
            layers: [{ name: 'counts', build: async () => matrices[g] }],
          };
        });
        const first = defaultModality(modalities.map(modality => modality.name));
        model.modalities.push(...modalities.sort((a, b) => (a.name === first ? -1 : b.name === first ? 1 : 0)));
        const written = await writeModel(model, space, { readRegion: region => space.read(region) });
        return [{
          name: '',
          label: `${folderName} (MatrixMarket, ${formatCountOf(written.nObs, 'cell')})`,
          kind: 'MatrixMarket',
          version: null,
          notes: model.notes,
          written,
        }];
      },
    });
    own?.finish();
    return result;
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
  const codes = categories.length < 128 ? new Int8Array(values.length) : categories.length < 32768 ? new Int16Array(values.length) : new Int32Array(values.length);
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
