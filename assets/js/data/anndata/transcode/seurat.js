/**
 * A parsed Seurat object (SeuratObject 3.0 and later: `Assay`, `Assay5`,
 * `SCTAssay`, Signac's `ChromatinAssay`) as an AnnData model
 * (`anndata-model.js`). Every slot read is listed here; a slot is matched by
 * its name and an object by its class name, never by position or package
 * (Seurat 3 files say `Seurat`, later ones `SeuratObject`).
 *
 * | Seurat | AnnData |
 * | --- | --- |
 * | cells (the default assay's) | `obs` index |
 * | `meta.data` | `obs` columns |
 * | `active.ident` | `obs['active_ident']`, when not a column already |
 * | `reductions$<r>@cell.embeddings` | `obsm['X_<r>']` (column-major, read in place) |
 * | `graphs$<g>` | `obsp['<g>']` (`csc_matrix`, exact) |
 * | `images` (Visium, FOV) | `obsm['spatial']` (pixel coordinates) |
 * | each assay | a modality, `active.assay` first (several assays: MuData layout) |
 * | assay `data` (else `counts`) | `X`; the other of the two is a layer |
 * | `meta.features` / `Assay5@meta.data` | `var`; `var.features` → `var['highly_variable']` |
 * | `misc$cellucid` | `uns['cellucid']` |
 * | `project.name` | `uns['title']`, unless the default `SeuratProject` |
 * | `scale.data`, `commands`, `tools`, `neighbors`, loadings, models | not read |
 *
 * Seurat v5 `Assay5` layers: `layers` (named list), `cells`/`features`
 * (`LogMap`s: which cells and features each layer holds); split layers
 * (`counts.1`, `data.ctrl`, made by `split()` and `merge()`) are joined.
 * `scale.data` layers are given back while the file streams
 * (`isDroppedSeuratLayer`, the pass's `dropByName`). Layers kept outside the file (BPCells, `SaveSeuratRds(move = TRUE)`) are
 * refused with the R line that brings them in.
 *
 * @module data/anndata/transcode/seurat
 */

import {
  attribute,
  classesOf,
  dataFrameOf,
  dimOf,
  dimnamesOf,
  hasClass,
  item,
  namedItems,
  plainValue,
  scalarString,
  strings,
  vectorValues,
} from './r-values.js';
import { assembleColumns, cellsByFeatures, describeMatrix } from './r-matrices.js';
import { RObjectRefusal } from './refusals.js';
import { allocateTypedArray } from '../../sparse-column-index.js';

/** Slots passed over while the file streams: never read, never kept. */
export const SEURAT_DROPPED_SLOTS = Object.freeze([
  '@commands', '@neighbors', '@feature.loadings', '@feature.loadings.projected', '@jackstraw',
  '@scale.data', '@SCTModel.list', '@image', '@fragments', '@motifs', '@positionEnrichment', '@links',
]);

/** Seurat v5 layers passed over by name (`scale.data`, and its split pieces `scale.data.<group>`). */
export function isDroppedSeuratLayer(name) {
  return name === 'scale.data' || name.startsWith('scale.data.');
}

/** Whether a parsed object is a Seurat object of a version Cellucid reads. */
export function isSeurat(node) {
  return node?.kind === 'S4' && hasClass(node, 'Seurat');
}

/** Whether a parsed object is a Seurat v2 object (`seurat`, lower case). */
export function isSeuratV2(node) {
  return node?.kind === 'S4' && hasClass(node, 'seurat');
}

/** The SeuratObject version that wrote an object (`@version`), or null. */
export function seuratVersion(node) {
  const version = attribute(node, 'version');
  const numbers = version?.kind === 'list' ? version.items?.[0]?.values : version?.values;
  return numbers ? Array.from(numbers).join('.') : null;
}

/** Cells and features of one assay, and its matrices, by layer name. */
async function readAssay(name, assay, context, notes) {
  const where = `assays$${name}`;
  if (hasClass(assay, 'Assay5') || attribute(assay, 'layers') !== null) {
    return readAssay5(name, assay, context, notes);
  }
  const counts = describeMatrix(attribute(assay, 'counts'));
  const data = describeMatrix(attribute(assay, 'data'));
  const present = matrix => matrix.kind !== 'unknown' && matrix.nrow > 0 && matrix.ncol > 0;
  const primary = present(data) ? data : counts;
  if (!present(primary)) return null;
  const features = primary.rownames ?? strings(item(attribute(assay, 'meta.features'), 'names'));
  const cells = primary.colnames;
  if (features === null || cells === null) throw new RObjectRefusal(`The assay ${name} has no feature or cell names.`, { slot: where });
  const layers = [];
  for (const [layer, matrix] of [['data', data], ['counts', counts]]) {
    if (!present(matrix)) continue;
    if (matrix.kind === 'external') {
      notes.push(`${where}@${layer} is kept outside the file (${matrix.where}) and was not read.`);
      continue;
    }
    if (matrix.nrow !== features.length || matrix.ncol !== cells.length) {
      notes.push(`${where}@${layer} is ${matrix.nrow} × ${matrix.ncol}, not the assay's ${features.length} × ${cells.length}, and was not read.`);
      continue;
    }
    layers.push({ name: layer, build: () => cellsByFeatures(matrix, context) });
  }
  if (layers.length === 0) {
    refuseExternal(name, [data, counts], context.root);
  }
  const frame = await dataFrameOf(attribute(assay, 'meta.features'), context);
  const variable = new Set(strings(attribute(assay, 'var.features')) ?? []);
  return { name, cells, features, layers, var: frame, variable };
}

/** The names of a LogMap's rows, and which rows each of its columns holds. */
async function logMap(node, context) {
  if (node === null) return null;
  const [rows, columns] = dimnamesOf(node);
  const dim = dimOf(node);
  const values = await vectorValues(node, context);
  if (rows === null || dim === null || values === null) return null;
  const byColumn = new Map();
  (columns ?? []).forEach((column, index) => {
    const held = [];
    for (let r = 0; r < dim[0]; r++) if (values[index * dim[0] + r] === 1) held.push(r);
    byColumn.set(column, Int32Array.from(held));
  });
  return { rows, byColumn };
}

async function readAssay5(name, assay, context, notes) {
  const where = `assays$${name}`;
  const cells = await logMap(attribute(assay, 'cells'), context);
  const features = await logMap(attribute(assay, 'features'), context);
  if (cells === null || features === null) throw new RObjectRefusal(`The Seurat v5 assay ${name} has no cell or feature map.`, { slot: where });
  const layers = namedItems(attribute(assay, 'layers'));
  if (layers.length === 0) refuseMoved(name, context.root);
  // Layers by kind: `counts`, `data`, and their split pieces `counts.<group>`.
  const groups = new Map();
  for (const { name: layer, value } of layers) {
    // A layer the pass dropped (`scale.data`) is named by `passedOverNotes`.
    if (layer === null || value?.kind === 'skipped') continue;
    const dot = layer.indexOf('.');
    const kind = dot < 0 ? layer : layer.slice(0, dot);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push({ layer, value });
  }
  const built = [];
  const external = [];
  for (const [kind, pieces] of groups) {
    const matrices = pieces.map(({ layer, value }) => ({ layer, matrix: describeMatrix(value) }));
    const outside = matrices.find(({ matrix }) => matrix.kind === 'external');
    if (outside !== undefined) {
      external.push(outside);
      notes.push(`${where} layer ${outside.layer} is kept outside the file (${outside.matrix.where}) and was not read.`);
      continue;
    }
    if (matrices.some(({ matrix }) => matrix.kind === 'unknown')) {
      notes.push(`${where} layer ${kind} is a ${matrices.find(({ matrix }) => matrix.kind === 'unknown').matrix.className}, which Cellucid does not read.`);
      continue;
    }
    built.push({ kind, matrices });
  }
  if (built.length === 0) {
    if (external.length > 0) refuseExternal(name, external.map(({ matrix }) => matrix), context.root);
    refuseMoved(name, context.root);
  }
  const allCells = cells.rows;
  const allFeatures = features.rows;
  const layersOut = [];
  for (const { kind, matrices } of built) {
    const whole = matrices.length === 1 &&
      (cells.byColumn.get(matrices[0].layer)?.length ?? -1) === allCells.length &&
      (features.byColumn.get(matrices[0].layer)?.length ?? -1) === allFeatures.length;
    if (whole && (matrices[0].matrix.kind !== 'csc' || matrices[0].matrix.nrow === allFeatures.length)) {
      const { matrix } = matrices[0];
      layersOut.push({ name: kind, build: () => cellsByFeatures(matrix, context) });
      continue;
    }
    if (matrices.some(({ matrix }) => matrix.kind !== 'csc')) {
      notes.push(`${where} layer ${kind} is split into dense pieces, which Cellucid does not join; it was not read.`);
      continue;
    }
    layersOut.push({
      name: kind,
      build: () => assembleColumns(matrices.map(({ layer, matrix }) => ({
        matrix,
        cells: cells.byColumn.get(layer) ?? new Int32Array(0),
        features: (features.byColumn.get(layer)?.length ?? -1) === allFeatures.length ? null : features.byColumn.get(layer),
      })), allCells.length, allFeatures.length, context),
    });
  }
  // X: the log-normalised data, else counts; then the rest.
  layersOut.sort((a, b) => rank(a.name) - rank(b.name));
  const frame = await dataFrameOf(attribute(assay, 'meta.data'), context);
  const variable = new Set();
  const flag = frame?.columns.find(column => column.name === 'var.features')?.node;
  if (flag?.kind === 'string') flag.values.forEach((value, index) => value !== null && variable.add(allFeatures[index]));
  return { name, cells: allCells, features: allFeatures, layers: layersOut, var: frame, variable };
}

function rank(layer) {
  return layer === 'data' ? 0 : layer === 'counts' ? 1 : 2;
}

/** Refuse an assay none of whose matrices are in the file. */
function refuseExternal(name, matrices, root) {
  const outside = matrices.find(matrix => matrix.kind === 'external');
  if (outside === undefined) return;
  throw new RObjectRefusal(
    `This Seurat object keeps the ${name} assay's counts outside the file (${outside.where}). ` +
    `In R: seu[["${name}"]]$counts <- as(seu[["${name}"]]$counts, "dgCMatrix") (and the same for data), then save it again with saveRDS(); ` +
    'or open it with cellucid::cellucid_view(seu).',
    { slot: `assays$${name}`, reason: 'external-matrix' }
  );
  void root;
}

/** Refuse an assay whose layers `SaveSeuratRds(move = TRUE)` moved out. */
function refuseMoved(name, root) {
  const saved = item(attribute(root, 'tools'), 'SaveSeuratRds');
  const paths = saved === null ? [] : (strings(item(saved, 'path')) ?? []);
  throw new RObjectRefusal(
    `This Seurat object's ${name} assay has no layers in the file` +
    (paths.length > 0 ? ` (SaveSeuratRds() moved them to ${paths.join(', ')})` : '') +
    '. In R: seu <- LoadSeuratRds(file) (or readRDS), then seu[["RNA"]] <- as(seu[["RNA"]], "Assay5") with its layers ' +
    'as dgCMatrix, and saveRDS(seu, file); or open it with cellucid::cellucid_view(seu).',
    { slot: `assays$${name}`, reason: 'external-matrix' }
  );
}

/** Embedding rows placed in the obs order (by cell name), NaN where absent. */
async function placedRows(matrix, cellIndex, nObs, context) {
  const values = await vectorValues(matrix.values, context);
  const [rows, columns] = [matrix.nrow, matrix.ncol];
  const out = allocateTypedArray(Float64Array, nObs * columns, 'A reduction placed by cell name').fill(NaN);
  const names = matrix.rownames;
  for (let r = 0; r < rows; r++) {
    const at = cellIndex.get(names[r]);
    if (at === undefined) continue;
    for (let c = 0; c < columns; c++) out[c * nObs + at] = values[c * rows + r];
  }
  return out;
}

function sameNames(a, b) {
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The AnnData model of one parsed Seurat object.
 *
 * @param {Object} root
 * @param {{space: Object, readRegion: Function}} context
 * @returns {Promise<Object>} The model (`anndata-model.js`)
 */
export async function seuratModel(root, context) {
  const notes = [];
  const scoped = { ...context, root };
  const activeAssay = scalarString(attribute(root, 'active.assay'));
  const assayEntries = namedItems(attribute(root, 'assays')).filter(entry => entry.name !== null);
  if (assayEntries.length === 0) throw new RObjectRefusal('This Seurat object has no assays.', { slot: 'assays' });
  assayEntries.sort((a, b) => (a.name === activeAssay ? -1 : b.name === activeAssay ? 1 : 0));
  const assays = [];
  for (const { name, value } of assayEntries) {
    if (value?.kind !== 'S4') continue;
    const read = await readAssay(name, value, scoped, notes);
    if (read !== null) assays.push(read);
  }
  if (assays.length === 0) throw new RObjectRefusal('This Seurat object has no assay with counts or data in the file.', { slot: 'assays' });

  const meta = await dataFrameOf(attribute(root, 'meta.data'), scoped);
  const obsNames = meta?.rowNames && meta.rowNames.length === assays[0].cells.length && !/^\d+$/.test(meta.rowNames[0] ?? '')
    ? meta.rowNames
    : assays[0].cells;
  const nObs = obsNames.length;
  const cellIndex = new Map(obsNames.map((name, index) => [name, index]));

  const obsColumns = (meta?.columns ?? []).filter(column => column.name !== '');
  const ident = attribute(root, 'active.ident');
  if (ident !== null && ident.length === nObs && !obsColumns.some(column => column.name === 'active_ident')) {
    obsColumns.push({ name: 'active_ident', node: ident });
  }

  const obsm = [];
  for (const { name, value } of namedItems(attribute(root, 'reductions'))) {
    if (name === null || value?.kind !== 'S4') continue;
    const embedding = describeMatrix(attribute(value, 'cell.embeddings'));
    if (embedding.kind !== 'dense' || embedding.ncol === 0) {
      notes.push(`reductions$${name} has no cell embeddings in the file.`);
      continue;
    }
    if (embedding.nrow === nObs && (embedding.rownames === null || sameNames(embedding.rownames, obsNames))) {
      obsm.push({ name: `X_${name}`, rows: nObs, columns: embedding.ncol, node: embedding.values });
    } else if (embedding.rownames !== null) {
      obsm.push({ name: `X_${name}`, rows: nObs, columns: embedding.ncol, values: await placedRows(embedding, cellIndex, nObs, scoped) });
    }
  }
  const spatial = await spatialOf(root, cellIndex, nObs, scoped, notes);
  if (spatial !== null && !obsm.some(entry => entry.name === 'spatial')) obsm.push(spatial);

  const obsp = [];
  for (const { name, value } of namedItems(attribute(root, 'graphs'))) {
    if (name === null) continue;
    const graph = describeMatrix(value);
    if (graph.kind !== 'csc' || graph.nrow !== nObs || graph.ncol !== nObs) {
      notes.push(`graphs$${name} is not a ${nObs} × ${nObs} sparse matrix and was not read.`);
      continue;
    }
    if (graph.colnames !== null && !sameNames(graph.colnames, obsNames)) {
      notes.push(`graphs$${name} lists the cells in another order and was not read.`);
      continue;
    }
    const matrix = await cellsByFeatures(graph, scoped);
    // A dgCMatrix is column-compressed: over cells × cells it is `csc_matrix`.
    obsp.push({ name, matrix: { ...matrix, format: 'csc', shape: [nObs, nObs] } });
  }

  const modalities = assays.map(assay => ({
    name: assay.name,
    features: assay.features,
    var: assay.var,
    variable: assay.variable,
    cells: sameNames(assay.cells, obsNames) ? null : assay.cells,
    layers: assay.layers,
  }));

  const uns = {};
  const project = scalarString(attribute(root, 'project.name'));
  if (project !== null && project !== 'SeuratProject') uns.title = project;
  const cellucid = item(attribute(root, 'misc'), 'cellucid');
  if (cellucid !== null) uns.cellucid = await plainValue(cellucid, scoped);

  return {
    kind: 'Seurat',
    version: seuratVersion(root),
    obs: { names: obsNames, columns: obsColumns },
    obsm,
    obsp,
    modalities,
    uns,
    notes,
  };
}

/**
 * Spot and cell positions of the images (Visium v1 `coordinates`, Visium v2
 * and FOV centroids), placed by cell name: `obsm['spatial']`, or null.
 */
async function spatialOf(root, cellIndex, nObs, context, notes) {
  const images = namedItems(attribute(root, 'images'));
  if (images.length === 0) return null;
  const out = allocateTypedArray(Float64Array, nObs * 2, 'Image spot positions').fill(NaN);
  let found = false;
  for (const { name, value } of images) {
    const coordinates = await dataFrameOf(attribute(value, 'coordinates'), context);
    if (coordinates !== null && coordinates.rowNames !== null) {
      const x = coordinates.columns.find(column => column.name === 'imagecol')?.node;
      const y = coordinates.columns.find(column => column.name === 'imagerow')?.node;
      if (x && y) {
        const xs = await vectorValues(x, context);
        const ys = await vectorValues(y, context);
        coordinates.rowNames.forEach((cell, index) => {
          const at = cellIndex.get(cell);
          if (at === undefined) return;
          out[at] = xs[index];
          out[nObs + at] = ys[index];
          found = true;
        });
        continue;
      }
    }
    const centroids = item(attribute(value, 'boundaries'), 'centroids');
    const coords = attribute(centroids, 'coords');
    const cells = strings(attribute(centroids, 'cells'));
    if (coords !== null && cells !== null) {
      const values = await vectorValues(coords, context);
      const rows = dimOf(coords)?.[0] ?? 0;
      cells.forEach((cell, index) => {
        const at = cellIndex.get(cell);
        if (at === undefined || index >= rows) return;
        out[at] = values[index];
        out[nObs + at] = values[rows + index];
        found = true;
      });
      continue;
    }
    notes.push(`images$${name} (${classesOf(value)[0] ?? 'image'}) holds no positions Cellucid reads.`);
  }
  return found ? { name: 'spatial', rows: nObs, columns: 2, values: out } : null;
}
