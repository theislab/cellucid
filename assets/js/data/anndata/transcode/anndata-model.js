/**
 * The AnnData model a transcoder extracts from a file (an R object, a
 * MatrixMarket folder, a text table), and how it is written as a store.
 *
 * ```
 * {
 *   obs: {names: string[], columns: [{name, node} | {name, column}]},
 *   obsm: [{name, rows, columns, node?: R matrix (column-major), values?: Float64Array (column-major)}],
 *   obsp: [{name, matrix}],                       // a cells × cells AnnData matrix
 *   modalities: [{name, features: string[], var: frame|null, variable: Set<string>,
 *                 cells: string[]|null,           // null: obs's cells, in obs's order
 *                 layers: [{name, build: () => Promise<matrix>}]}],   // the first is X
 *   uns: {title?, cellucid?},
 *   notes: string[],                              // what was not read, and why
 * }
 * ```
 *
 * An AnnData matrix (cells × features) is `{format: 'csr'|'csc'|'dense',
 * shape, data, indices?, indptr?}`, each part `{values}` (host order) or
 * `{region, dtype}` (a kept payload, read in place). A sparse X is written
 * by feature (`csc_matrix`, `matrixInOrder`).
 *
 * **Priority order.** The store keeps its cells in priority order
 * (`priority.js`): row `r` of every per-cell array -- obs, obsm, obsp (both
 * axes), X and every layer, each modality's rows -- is the cell of the
 * `r`-th lowest rank under the store's seed, with its position in the
 * object in `obs['cellucid_original_position']`,
 * `uns['cellucid']['priority']`, and `varm['cellucid_prefix_counts']` beside
 * a sparse X, as `prepare()` writes them. The reader then opens a subsample
 * as the first rows of every array (`../priority-layout.js`). An
 * uncompressed R file's arrays are read in place, never copied, so its store
 * keeps the object's order (`context.ordered` false).
 *
 * One modality measured on every cell, in the cells' order, is written as
 * AnnData. Several (Seurat assays, SingleCellExperiment `altExps`), or one
 * over other cells, are written in MuData's layout (`views/mudata.js`
 * presents it): `/mod/<name>` AnnData groups listed by `/mod`'s
 * `mod-order` (the default modality first), shared `obs`, `obsm`, `obsp`,
 * `uns` at the root, `/obsmap/<name>` (1-based row of each cell in the
 * modality, 0 where it was not measured) for a modality that is not on
 * every cell in order.
 *
 * @module data/anndata/transcode/anndata-model
 */

import { AnnDataStoreWriter } from './zarr-writer.js';
import { columnOf, vectorValues, writable } from './r-values.js';
import { PREFIX_COUNTS_KEY, PRIORITY_ORIGINAL_COLUMN } from '../priority-layout.js';
import {
  cellPriority,
  columnInOrder,
  graphInOrder,
  matrixInOrder,
  modalityPriority,
  priorityRecord,
  rowsInOrder,
} from './priority.js';
import { allocateTypedArray, copyTypedArray } from '../../sparse-column-index.js';

const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/**
 * Write one dataframe from a frame of R nodes (or ready columns); `order`
 * (optional) puts its rows in that order (`order[r]` the row placed at `r`).
 */
async function writeFrame(writer, path, names, columns, context, notes, what, order = null) {
  const written = [];
  for (const entry of columns) {
    let column = entry.column ?? null;
    if (column === null) {
      column = await columnOf(entry.node, names.length, context);
      if (column.skip !== undefined) {
        notes.push(`${what} column '${entry.name}' was not read: ${column.skip}.`);
        continue;
      }
      if (column.note) notes.push(`${what} column '${entry.name}': ${column.note}.`);
    }
    written.push({ name: entry.name, column: order === null ? column : await columnInOrder(column, order, context.readRegion) });
  }
  const index = names.map(name => name ?? '');
  await writer.dataframe(path, { index: order === null ? index : Array.from(order, r => index[r]), columns: written });
}

/** The var frame of one modality: its features, its columns, `highly_variable`. */
function varColumns(modality) {
  const columns = [];
  const frame = modality.var;
  if (frame !== null && frame !== undefined && frame.rows === modality.features.length) {
    for (const column of frame.columns) if (column.name !== '') columns.push(column);
  }
  if (modality.variable?.size > 0 && !columns.some(column => column.name === 'highly_variable')) {
    columns.push({ name: 'highly_variable', column: { kind: 'booleans', values: Uint8Array.from(modality.features, name => (modality.variable.has(name) ? 1 : 0)) } });
  }
  return columns;
}

/** Write an AnnData matrix group or array at `path`. */
async function writeMatrix(writer, path, matrix) {
  if (matrix.format === 'dense') {
    await writer.array(path, { ...matrix.data, shape: matrix.shape });
    return;
  }
  await writer.sparse(path, matrix);
}

/**
 * Write one modality's AnnData group content (X, layers, var) under `path`,
 * its rows in priority order (`rows`: `{order, position, levels}`).
 *
 * X is kept by feature (`csc_matrix`), so a gene is one contiguous range, as
 * in a Cellucid-ready AnnData, each gene's rows ascending, with its prefix
 * counts (`priority.js` `matrixInOrder`, in bounded memory). Measured on a
 * 50,000-cell Seurat object (75 M entries a layer, Node, Apple M1 Pro):
 * laying X out by feature takes 4 s more per matrix (6.7 s with none, 10.9 s
 * with X, 14.8 s with X and counts), and every later visit reads a gene in
 * 7 ms instead of building a column index first (1.2 s and 0.9 s for the
 * first two genes, 800 MB of memory, on every visit). The other layers, read
 * only when the data mapping picks one, keep the object's layout, their
 * rows in priority order, and are indexed then.
 */
async function writeModality(writer, path, modality, context, notes, rows) {
  const at = name => (path === '' ? name : `${path}/${name}`);
  const matrixContext = { space: writer.space, readRegion: context.readRegion, signal: context.signal ?? null };
  let wroteX = false;
  writer.dict(at('layers'));
  for (const layer of modality.layers) {
    let matrix;
    try {
      matrix = await layer.build();
    } catch (error) {
      notes.push(`The ${modality.name} ${layer.name} matrix was not read: ${error.message}.`);
      continue;
    }
    if (!wroteX) {
      matrix = await matrixInOrder(matrix, rows, matrixContext, { expression: true, levels: rows?.levels ?? null });
      await writeMatrix(writer, at('X'), matrix);
      if (matrix.prefixCounts !== undefined) {
        // One column per level, each read whole when a subsample opens.
        await writer.array(at(`varm/${PREFIX_COUNTS_KEY}`), {
          values: matrix.prefixCounts,
          shape: [matrix.shape[1], rows.levels.length],
          order: 'F',
        });
      }
      wroteX = true;
      continue;
    }
    matrix = await matrixInOrder(matrix, rows, matrixContext, { expression: false });
    await writeMatrix(writer, at(`layers/${layer.name}`), matrix);
  }
  await writeFrame(writer, at('var'), modality.features, varColumns(modality), context, notes, `${modality.name} var`);
  return wroteX;
}

/** Write the shared `obsm`, every array's rows in priority order (as it is when `priority` is null). */
async function writeObsm(writer, model, context, priority) {
  writer.dict('obsm');
  for (const entry of model.obsm) {
    let part = entry.values ? { values: entry.values } : null;
    if (part === null && entry.node) {
      part = writable(entry.node);
      if (part === null) continue;
      if (!(entry.node.kind === 'double' || part.region)) part = { values: copyTypedArray(Float64Array, await vectorValues(entry.node, context), `obsm['${entry.name}']`) };
    }
    if (part === null) continue;
    const placed = priority === null
      ? part
      : await rowsInOrder(part, { rows: entry.rows, width: entry.columns, layout: 'F' }, priority.order, context.readRegion);
    await writer.array(`obsm/${entry.name}`, { ...placed, shape: [entry.rows, entry.columns], order: 'F' });
  }
}

/**
 * Write a model as an AnnData (or MuData-layout) Zarr store.
 *
 * @param {Object} model
 * @param {import('./space.js').TranscodeSpace} space
 * @param {{readRegion: Function}} context
 * @returns {Promise<{entries: Map<string, Object>, used: Set<string>, nObs: number, nVars: number, modalities: string[], layout: 'anndata'|'mudata'}>}
 */
export async function writeModel(model, space, context) {
  const writer = new AnnDataStoreWriter(space);
  const notes = model.notes;
  const nObs = model.obs.names.length;
  // The cells in priority order, unless the source's arrays are read in place
  // (`context.ordered` false: an uncompressed R file, `priority.js`).
  const priority = context.ordered === false ? null : cellPriority(nObs);
  const muData = model.modalities.length > 1 || model.modalities.some(modality => modality.cells !== null);
  writer.group('', muData
    ? { ...encoding('MuData', '0.1.0'), axis: 0, encoder: 'cellucid' }
    : encoding('anndata', '0.1.0'));
  // Each row's original position, last: its own row number, put in priority
  // order with every other column.
  const obsColumns = model.obs.columns.filter(entry => priority === null || entry.name !== PRIORITY_ORIGINAL_COLUMN);
  if (priority !== null) {
    const positions = allocateTypedArray(Uint32Array, nObs, 'Original cell positions');
    for (let p = 0; p < nObs; p++) positions[p] = p;
    obsColumns.push({ name: PRIORITY_ORIGINAL_COLUMN, column: { kind: 'numbers', values: positions } });
  }
  await writeFrame(writer, 'obs', model.obs.names, obsColumns, context, notes, 'obs', priority?.order ?? null);
  await writeObsm(writer, model, context, priority);
  writer.dict('obsp');
  const graphContext = { space, readRegion: context.readRegion, signal: context.signal ?? null };
  for (const { name, matrix } of model.obsp) await writeMatrix(writer, `obsp/${name}`, await graphInOrder(matrix, priority, graphContext));
  writer.dict('uns');
  const uns = { ...(model.uns ?? {}) };
  if (priority !== null) uns.cellucid = { ...(uns.cellucid ?? {}), priority: priorityRecord(priority) };
  for (const [key, value] of Object.entries(uns)) await writer.unsValue(`uns/${key}`, value);
  if (!muData) {
    const modality = model.modalities[0];
    writer.dict('varm');
    writer.dict('varp');
    if (modality === undefined) {
      await writer.dataframe('var', { index: [], columns: [] });
    } else {
      await writeModality(writer, '', modality, context, notes, priority);
    }
  } else {
    writer.group('mod', { 'mod-order': model.modalities.map(modality => modality.name) });
    writer.group('obsmap', {});
    const allFeatures = [];
    const rowOfName = new Map(model.obs.names.map((name, index) => [name, priority === null ? index : priority.position[index]]));
    for (const modality of model.modalities) {
      const path = `mod/${modality.name}`;
      writer.group(path, encoding('anndata', '0.1.0'));
      const cells = modality.cells ?? model.obs.names;
      // The modality's rows by their cells' global rows: a global prefix of
      // the cells is a prefix of the modality (a cell absent from obs last).
      const rows = modality.cells === null || priority === null
        ? priority
        : modalityPriority(Float64Array.from(cells, name => rowOfName.get(name) ?? Infinity), priority.levels);
      await writer.dataframe(`${path}/obs`, { index: rows === null ? cells : Array.from(rows.order, r => cells[r]), columns: [] });
      for (const dict of ['obsm', 'obsp', 'varm', 'varp', 'uns']) writer.dict(`${path}/${dict}`);
      await writeModality(writer, path, modality, context, notes, rows);
      allFeatures.push(...modality.features);
      if (modality.cells !== null) {
        // 1-based row of each cell (global row order) in the modality's new rows, 0 where not measured.
        const placed = new Map(modality.cells.map((name, index) => [name, (rows === null ? index : rows.position[index]) + 1]));
        const map = allocateTypedArray(Uint32Array, model.obs.names.length, `obsmap['${modality.name}']`);
        const order = priority?.order ?? null;
        for (let i = 0; i < map.length; i++) map[i] = placed.get(model.obs.names[order === null ? i : order[i]]) ?? 0;
        await writer.array(`obsmap/${modality.name}`, { values: map });
      }
    }
    await writer.dataframe('var', { index: allFeatures, columns: [] });
  }
  const finished = writer.finish();
  return {
    ...finished,
    nObs,
    nVars: model.modalities[0]?.features.length ?? 0,
    modalities: model.modalities.map(modality => modality.name),
    layout: muData ? 'mudata' : 'anndata',
  };
}
