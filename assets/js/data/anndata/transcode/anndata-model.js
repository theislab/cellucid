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
 * `{region, dtype}` (a kept payload, read in place).
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

const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/** Write one dataframe from a frame of R nodes (or ready columns). */
async function writeFrame(writer, path, names, columns, context, notes, what) {
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
    written.push({ name: entry.name, column });
  }
  await writer.dataframe(path, { index: names.map(name => name ?? ''), columns: written });
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

/** Write one modality's AnnData group content (X, layers, var) under `path`. */
async function writeModality(writer, path, modality, context, notes) {
  let wroteX = false;
  writer.dict(path === '' ? 'layers' : `${path}/layers`);
  for (const layer of modality.layers) {
    let matrix;
    try {
      matrix = await layer.build();
    } catch (error) {
      notes.push(`The ${modality.name} ${layer.name} matrix was not read: ${error.message}.`);
      continue;
    }
    if (!wroteX) {
      await writeMatrix(writer, path === '' ? 'X' : `${path}/X`, matrix);
      wroteX = true;
      continue;
    }
    await writeMatrix(writer, `${path === '' ? '' : `${path}/`}layers/${layer.name}`, matrix);
  }
  await writeFrame(writer, path === '' ? 'var' : `${path}/var`, modality.features, varColumns(modality), context, notes, `${modality.name} var`);
  return wroteX;
}

/** Write the shared `obsm`. */
async function writeObsm(writer, model, context) {
  writer.dict('obsm');
  for (const entry of model.obsm) {
    if (entry.node && !entry.values) {
      const part = writable(entry.node);
      if (part === null) continue;
      if (entry.node.kind === 'double' || part.region) {
        await writer.array(`obsm/${entry.name}`, { ...part, shape: [entry.rows, entry.columns], order: 'F' });
      } else {
        const values = Float64Array.from(await vectorValues(entry.node, context));
        await writer.array(`obsm/${entry.name}`, { values, shape: [entry.rows, entry.columns], order: 'F' });
      }
    } else {
      await writer.array(`obsm/${entry.name}`, { values: entry.values, shape: [entry.rows, entry.columns], order: 'F' });
    }
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
  const muData = model.modalities.length > 1 || model.modalities.some(modality => modality.cells !== null);
  writer.group('', muData
    ? { ...encoding('MuData', '0.1.0'), axis: 0, encoder: 'cellucid' }
    : encoding('anndata', '0.1.0'));
  await writeFrame(writer, 'obs', model.obs.names, model.obs.columns, context, notes, 'obs');
  await writeObsm(writer, model, context);
  writer.dict('obsp');
  for (const { name, matrix } of model.obsp) await writeMatrix(writer, `obsp/${name}`, matrix);
  writer.dict('uns');
  for (const [key, value] of Object.entries(model.uns ?? {})) await writer.unsValue(`uns/${key}`, value);
  if (!muData) {
    const modality = model.modalities[0];
    writer.dict('varm');
    writer.dict('varp');
    if (modality === undefined) {
      await writer.dataframe('var', { index: [], columns: [] });
    } else {
      await writeModality(writer, '', modality, context, notes);
    }
  } else {
    writer.group('mod', { 'mod-order': model.modalities.map(modality => modality.name) });
    writer.group('obsmap', {});
    const allFeatures = [];
    for (const modality of model.modalities) {
      const path = `mod/${modality.name}`;
      writer.group(path, encoding('anndata', '0.1.0'));
      const cells = modality.cells ?? model.obs.names;
      await writer.dataframe(`${path}/obs`, { index: cells, columns: [] });
      for (const dict of ['obsm', 'obsp', 'varm', 'varp', 'uns']) writer.dict(`${path}/${dict}`);
      await writeModality(writer, path, modality, context, notes);
      allFeatures.push(...modality.features);
      if (modality.cells !== null) {
        const position = new Map(modality.cells.map((name, index) => [name, index + 1]));
        const map = Uint32Array.from(model.obs.names, name => position.get(name) ?? 0);
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
