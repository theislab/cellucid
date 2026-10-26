/**
 * A parsed SingleCellExperiment (1.8 and later, when `reducedDims` moved
 * into `int_colData`), SummarizedExperiment or RangedSummarizedExperiment
 * as an AnnData model (`anndata-model.js`). Slots are matched by name; the
 * old `DataFrame` and the new `DFrame` class names are both read (one file
 * can hold both).
 *
 * | SingleCellExperiment | AnnData |
 * | --- | --- |
 * | `colnames` / `colData` | `obs` index / `obs` columns (`Rle` columns expanded) |
 * | `int_colData$reducedDims` | `obsm['X_<name>']`, the name's case kept |
 * | `int_colData$sizeFactor` (or `colData$sizeFactor`) | `obs['size_factor']` |
 * | `assays`: `logcounts`, else `counts`, else the first | `X`; the others `layers` |
 * | row names, `rowData` (`rowRanges` mcols for ranged objects) | `var` |
 * | `int_colData$altExps` | modalities (the main experiment first) |
 * | `int_colData$colPairs` | `obsp` |
 * | `metadata$cellucid` | `uns['cellucid']` |
 *
 * Assays backed by files outside the `.rds` (HDF5Array, DelayedArray) are
 * refused with the R line that brings them in.
 *
 * @module data/anndata/transcode/sce
 */

import {
  attribute,
  classesOf,
  dataFrameOf,
  hasClass,
  isNull,
  item,
  namedItems,
  plainValue,
  scalarString,
  strings,
  vectorValues,
} from './r-values.js';
import { cellsByFeatures, describeMatrix } from './r-matrices.js';
import { RObjectRefusal } from './refusals.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** Whether a parsed object is a SummarizedExperiment (or a class extending it). */
export function isSummarizedExperiment(node) {
  return node?.kind === 'S4' && attribute(node, 'assays') !== null && attribute(node, 'colData') !== null;
}

/** Whether it is a SingleCellExperiment (or extends one: `int_colData`). */
export function isSingleCellExperiment(node) {
  return isSummarizedExperiment(node) && (hasClass(node, 'SingleCellExperiment') || attribute(node, 'int_colData') !== null);
}

/** The SingleCellExperiment version that wrote an object, or null. */
export function sceVersion(node) {
  const version = item(attribute(node, 'int_metadata'), 'version');
  const numbers = version?.kind === 'list' ? version.items?.[0]?.values : null;
  return numbers ? Array.from(numbers).join('.') : null;
}

/** The assays of an experiment, by name, in order. */
function assaysOf(node) {
  const assays = attribute(node, 'assays');
  const data = attribute(assays, 'data');
  const list = attribute(data, 'listData') ?? (data?.kind === 'list' ? data : null);
  return namedItems(list).filter(entry => entry.name !== null);
}

/** Feature names of an experiment: `NAMES`, `rowRanges` names, else the first assay's row names. */
function featureNamesOf(node, assays) {
  const own = strings(attribute(node, 'NAMES'));
  if (own !== null) return own;
  const ranges = attribute(node, 'rowRanges');
  const names = strings(attribute(attribute(ranges, 'partitioning'), 'NAMES')) ?? strings(attribute(ranges, 'NAMES')) ??
    strings(attribute(attribute(ranges, 'ranges'), 'NAMES'));
  if (names !== null) return names;
  for (const { value } of assays) {
    const rownames = describeMatrix(value).rownames;
    if (rownames) return rownames;
  }
  return null;
}

/** One experiment's features, var and layers (assays), X first. */
async function experiment(name, node, context, notes, nCells) {
  const assays = assaysOf(node);
  const order = ['logcounts', 'counts'];
  assays.sort((a, b) => {
    const ra = order.includes(a.name) ? order.indexOf(a.name) : 2;
    const rb = order.includes(b.name) ? order.indexOf(b.name) : 2;
    return ra - rb;
  });
  const features = featureNamesOf(node, assays);
  const layers = [];
  const outside = [];
  for (const { name: assayName, value } of assays) {
    const matrix = describeMatrix(value);
    if (matrix.kind === 'external') {
      outside.push({ assayName, matrix });
      notes.push(`assays$${assayName} is kept outside the file (${matrix.where}) and was not read.`);
      continue;
    }
    if (matrix.kind === 'unknown') {
      notes.push(`assays$${assayName} is a ${matrix.className}, which Cellucid does not read.`);
      continue;
    }
    if (matrix.ncol !== nCells) {
      notes.push(`assays$${assayName} has ${formatCountOf(matrix.ncol, 'column')} for ${formatCountOf(nCells, 'cell')} and was not read.`);
      continue;
    }
    layers.push({ name: assayName, nrow: matrix.nrow, build: () => cellsByFeatures(matrix, context) });
  }
  if (layers.length === 0 && outside.length > 0) {
    const { assayName, matrix } = outside[0];
    throw new RObjectRefusal(
      `This ${classesOf(node)[0] ?? 'experiment'} keeps its ${assayName} assay outside the file (${matrix.where}). ` +
      `In R: assay(sce, "${assayName}") <- as(assay(sce, "${assayName}"), "dgCMatrix"), then saveRDS(sce, file); ` +
      'or open it with cellucid::cellucid_view(sce).',
      { slot: `${name}@assays`, reason: 'external-matrix' }
    );
  }
  const nFeatures = layers[0]?.nrow ?? features?.length ?? 0;
  const ranges = attribute(node, 'rowRanges');
  const frame = await dataFrameOf(attribute(ranges, 'elementMetadata'), context) ?? await dataFrameOf(attribute(node, 'elementMetadata'), context);
  return {
    features: features ?? Array.from({ length: nFeatures }, (_, i) => String(i + 1)),
    layers: layers.filter(layer => layer.nrow === nFeatures),
    var: frame,
  };
}

/** A SelfHits graph as a cells × cells `csr_matrix`. */
async function selfHitsGraph(hits, nCells, context) {
  const from = await vectorValues(attribute(hits, 'from'), context);
  const to = await vectorValues(attribute(hits, 'to'), context);
  if (from === null || to === null) return null;
  const metadata = await dataFrameOf(attribute(hits, 'elementMetadata'), context);
  const weights = metadata?.columns.find(column => column.name === 'value')?.node ?? null;
  const values = weights === null ? null : await vectorValues(weights, context);
  const indptr = new Int32Array(nCells + 1);
  for (let k = 0; k < from.length; k++) indptr[from[k]]++;
  for (let c = 0; c < nCells; c++) indptr[c + 1] += indptr[c];
  const next = indptr.slice(0, nCells);
  const indices = new Int32Array(from.length);
  const data = new Float64Array(from.length);
  // SelfHits are sorted by `from`, then `to`: one pass places them.
  for (let k = 0; k < from.length; k++) {
    const at = next[from[k] - 1]++;
    indices[at] = to[k] - 1;
    data[at] = values === null ? 1 : values[k];
  }
  return { format: 'csr', shape: [nCells, nCells], indptr: { values: indptr }, indices: { values: indices }, data: { values: data } };
}

/**
 * The AnnData model of one parsed SingleCellExperiment or
 * SummarizedExperiment.
 *
 * @param {Object} root
 * @param {{space: Object, readRegion: Function}} context
 * @returns {Promise<Object>}
 */
export async function sceModel(root, context) {
  const notes = [];
  const kind = isSingleCellExperiment(root) ? 'SingleCellExperiment' : (classesOf(root)[0] ?? 'SummarizedExperiment');
  if (kind === 'SingleCellExperiment' && attribute(root, 'reducedDims') !== null && attribute(root, 'int_colData') === null) {
    throw new RObjectRefusal(
      'This SingleCellExperiment was saved by a version before 1.8 (2019). In R: sce <- updateObject(sce), then saveRDS(sce, file).',
      { reason: 'old-version' }
    );
  }
  const colData = await dataFrameOf(attribute(root, 'colData'), context);
  const nCells = colData?.rows ?? 0;
  const obsNames = colData?.rowNames ?? Array.from({ length: nCells }, (_, i) => String(i + 1));
  const obsColumns = (colData?.columns ?? []).filter(column => column.name !== '');
  const internal = await dataFrameOf(attribute(root, 'int_colData'), context);
  const internalItem = name => internal?.columns.find(column => column.name === name)?.node ?? null;
  const sizeFactor = internalItem('sizeFactor');
  if (sizeFactor !== null && !obsColumns.some(column => column.name === 'size_factor' || column.name === 'sizeFactor')) {
    obsColumns.push({ name: 'size_factor', node: sizeFactor });
  }

  const main = await experiment('', root, context, notes, nCells);
  if (main.layers.length === 0 && nCells > 0) notes.push('The main experiment has no assay Cellucid reads.');
  const mainName = scalarString(item(attribute(root, 'int_metadata'), 'mainExpName')) ?? 'main';

  const obsm = [];
  const reduced = await dataFrameOf(internalItem('reducedDims'), context);
  for (const { name, node } of reduced?.columns ?? []) {
    const matrix = describeMatrix(node);
    if (matrix.kind !== 'dense' || matrix.nrow !== nCells || matrix.ncol === 0) {
      notes.push(`reducedDims$${name} is not a ${nCells}-row numeric matrix and was not read.`);
      continue;
    }
    obsm.push({ name: `X_${name}`, rows: nCells, columns: matrix.ncol, node: matrix.values });
  }

  const obsp = [];
  const pairs = await dataFrameOf(internalItem('colPairs'), context);
  for (const { name, node } of pairs?.columns ?? []) {
    // SingleCellExperiment keeps each pairing as a DualSubset around its SelfHits.
    const hits = hasClass(node, 'DualSubset') ? attribute(node, 'hits') : node;
    if (!hasClass(hits, 'SelfHits')) continue;
    const graph = await selfHitsGraph(hits, nCells, context);
    if (graph !== null) obsp.push({ name, matrix: graph });
  }

  const modalities = [];
  if (main.layers.length > 0) {
    modalities.push({ name: mainName, features: main.features, var: main.var, variable: new Set(), cells: null, layers: main.layers });
  }
  const alternatives = await dataFrameOf(internalItem('altExps'), context);
  for (const { name, node } of alternatives?.columns ?? []) {
    const se = attribute(node, 'se') ?? node;
    if (!isSummarizedExperiment(se)) continue;
    const alternative = await experiment(`altExps$${name}`, se, context, notes, nCells);
    if (alternative.layers.length === 0) continue;
    modalities.push({ name, features: alternative.features, var: alternative.var, variable: new Set(), cells: null, layers: alternative.layers });
  }
  if (modalities.length === 0) throw new RObjectRefusal(`This ${kind} has no assay Cellucid reads in the file.`, { slot: 'assays' });

  const uns = {};
  const cellucid = item(attribute(root, 'metadata'), 'cellucid');
  if (!isNull(cellucid) && cellucid !== null) uns.cellucid = await plainValue(cellucid, context);

  return {
    kind,
    version: sceVersion(root),
    obs: { names: obsNames, columns: obsColumns },
    obsm,
    obsp,
    modalities,
    uns,
    notes,
  };
}
