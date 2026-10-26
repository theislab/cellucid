/**
 * MuData (`.h5mu`, MuData Zarr), presented as AnnData with modalities
 * (`modalities.js`): every array is read in place.
 *
 * A MuData store (https://github.com/scverse/mudata, `docs/io/spec.md`) is
 * a root with `encoding-type` `MuData` (mudata 0.4 writes it so, earlier
 * releases `mudata`), `axis` 0 (shared cells; 1 and -1 share features and
 * are refused), `/mod/<name>` AnnData groups listed in order by `/mod`'s
 * `mod-order`, global `obs`, `obsm`, `obsp`, `uns`, and `/obsmap/<name>`
 * placing each global cell in each modality (1-based, 0 = not measured).
 * An `.h5mu` starts with a 512-byte user block before the HDF5 signature,
 * which the HDF5 reader looks past.
 *
 * | MuData | presented as |
 * | --- | --- |
 * | `/mod/<name>` | modality `<name>` (anndata before 0.8 through `older-layouts.js`) |
 * | global `obs` | `obs` |
 * | each modality's `obs` columns not already global | `obs['<name>:<column>']`, missing where not measured |
 * | global `obsm`, minus the per-modality boolean masks | `obsm` |
 * | each modality's `obsm` | `obsm['<name>:<key>']`, NaN rows where not measured |
 * | global `obsp`; each modality's `obsp` | `obsp`; `obsp['<name>:<key>']` |
 * | the default modality's `X`, `var`, `layers`, `raw` | at the root too, when it measured every cell |
 *
 * mudata 0.4 stopped copying modality columns into the global `obs`, so a
 * current file's clusters are only in its modalities; the `<name>:<column>`
 * columns show them, under the names mudata itself gives pulled columns.
 *
 * @module data/anndata/views/mudata
 */

import { isArrayNode, isGroup } from '../../../formats/store.js';
import { defaultModality } from '../../data-mapping.js';
import { attributeValue, encodingType } from '../elements.js';
import { currentLayoutView, isOlderAnnDataLayout } from '../older-layouts.js';
import { LayoutRefusal } from './refusal.js';
import {
  cellMapOf,
  frameRows,
  modalityList,
  placedGraph,
  placedNumbers,
  placedObsColumn,
} from './modalities.js';
import { encodingAttrs, joinPath, viewGroup } from './view-nodes.js';

/** How the AnnData reader names a MuData store in messages. */
export const H5MU_FORMAT = Object.freeze({ storage: 'HDF5', file: 'MuData (.h5mu)' });
export const MUDATA_ZARR_FORMAT = Object.freeze({ storage: 'Zarr', file: 'MuData Zarr' });

/** Whether a store root is a MuData store. */
export function isMuDataRoot(root) {
  if (!isGroup(root) || !isGroup(root.get('mod'))) return false;
  return encodingType(root).toLowerCase() === 'mudata';
}

/**
 * The modality names in their stored order: `mod-order` when it lists every
 * modality, else (as the MuData specification says) the groups' own order.
 */
function modalityNames(mod) {
  const present = mod.keys().filter(name => isGroup(mod.get(name)));
  const stored = attributeValue(mod, 'mod-order');
  const listed = [...new Set((Array.isArray(stored) ? stored : (typeof stored === 'string' ? [stored] : [])).map(String))];
  return present.every(name => listed.includes(name)) ? listed.filter(name => present.includes(name)) : present;
}

/** A dataframe group with more columns: the real one's and `added`. */
function extendedFrame(frame, added) {
  const order = attributeValue(frame, 'column-order');
  const columns = Array.isArray(order) ? order.map(String) : [];
  const children = new Map(frame.keys().map(key => [key, () => frame.get(key)]));
  for (const [key, make] of added) children.set(key, make);
  return viewGroup({
    path: frame.path,
    real: frame,
    attrs: { ...frame.attrs, 'column-order': [...columns, ...added.keys()] },
    ownAttributes: ['column-order'],
    children,
  });
}

/** A mapping group with more children. */
function extendedMapping(path, real, added, drop = new Set()) {
  const children = new Map();
  if (isGroup(real)) {
    for (const key of real.keys()) if (!drop.has(key)) children.set(key, () => real.get(key));
  }
  for (const [key, make] of added) children.set(key, make);
  return viewGroup({ path, real: isGroup(real) ? real : null, attrs: encodingAttrs('dict'), children });
}

/**
 * The AnnData view of a MuData store.
 *
 * @param {Object} root
 * @param {{name: string}} context
 * @returns {Object}
 */
export function muDataView(root, { name }) {
  const axis = Number(attributeValue(root, 'axis') ?? 0);
  if (axis !== 0) {
    throw new LayoutRefusal(
      `${name} is a MuData store whose modalities share features, not cells (axis ${axis}); ` +
      'Cellucid shows cells. Open one modality as AnnData instead (mdata.mod[name].write_h5ad(path)).',
      { reason: 'shared-features' }
    );
  }
  const mod = root.get('mod');
  const names = modalityNames(mod);
  if (names.length === 0) {
    throw new LayoutRefusal(`${name} is a MuData store with no modalities.`, { reason: 'no-modalities' });
  }
  const groups = new Map(names.map(item => {
    const group = mod.get(item);
    return [item, isOlderAnnDataLayout(group) ? currentLayoutView(group) : group];
  }));
  const obsmaps = root.get('obsmap');
  const modalities = modalityList(names.map(item => ({
    name: item,
    obsmap: isGroup(obsmaps) && isArrayNode(obsmaps.get(item)) ? obsmaps.get(item) : null,
    nCells: frameRows(groups.get(item).get('obs')) ?? 0,
  })));
  const globalObs = root.get('obs');
  const nObs = frameRows(globalObs);
  if (nObs === null) throw new LayoutRefusal(`${name} is a MuData store without a global obs.`, { reason: 'no-obs' });
  const maps = new Map(modalities.map(modality => [modality.name, cellMapOf(modality, nObs)]));
  // A modality's rows are placed only when the store says where they go.
  const placeable = modality => modality.obsmap !== null || modality.nCells === nObs;

  const globalColumns = new Set(Array.isArray(attributeValue(globalObs, 'column-order')) ? attributeValue(globalObs, 'column-order') : []);
  const obsAdded = new Map();
  const obsmAdded = new Map();
  const obspAdded = new Map();
  for (const modality of modalities) {
    if (!placeable(modality)) continue;
    const group = groups.get(modality.name);
    const map = maps.get(modality.name);
    const frame = group.get('obs');
    const order = attributeValue(frame, 'column-order');
    for (const column of Array.isArray(order) ? order : []) {
      const key = `${modality.name}:${column}`;
      if (globalColumns.has(key) || obsAdded.has(key)) continue;
      const node = frame.get(column);
      const path = joinPath('/obs', key);
      if (placedObsColumn(node, map, nObs, path) !== null) obsAdded.set(key, () => placedObsColumn(node, map, nObs, path));
    }
    const obsm = group.get('obsm');
    for (const key of isGroup(obsm) ? obsm.keys() : []) {
      const array = obsm.get(key);
      if (!isArrayNode(array) || array.shape.length < 1 || array.shape.length > 2 || array.shape[0] !== modality.nCells) continue;
      if (!['int', 'uint', 'float'].includes(array.dtype.kind)) continue;
      const placed = `${modality.name}:${key}`;
      obsmAdded.set(placed, () => placedNumbers(array, map, nObs, joinPath('/obsm', placed)));
    }
    const obsp = group.get('obsp');
    for (const key of isGroup(obsp) ? obsp.keys() : []) {
      const graph = obsp.get(key);
      const encoding = encodingType(graph);
      if (!isGroup(graph) || (encoding !== 'csr_matrix' && encoding !== 'csc_matrix')) continue;
      const placed = `${modality.name}:${key}`;
      obspAdded.set(placed, () => placedGraph(graph, map, nObs, joinPath('/obsp', placed)));
    }
  }
  // mudata keeps one boolean mask per modality in obsm: which cells it
  // measured. They are no embeddings; `<name>:measured` shows them.
  const globalObsm = root.get('obsm');
  const masks = new Set();
  for (const modality of modalities) {
    const mask = isGroup(globalObsm) ? globalObsm.get(modality.name) : null;
    if (!isArrayNode(mask) || mask.dtype.kind !== 'bool') continue;
    masks.add(modality.name);
    const key = `${modality.name}:measured`;
    if (globalColumns.has(key) || obsAdded.has(key)) continue;
    obsAdded.set(key, () => viewArrayColumn(mask, joinPath('/obs', key)));
  }

  const chosen = defaultModality(names);
  const defaultGroup = groups.get(chosen);
  const defaultMeasuresAll = modalities.find(item => item.name === chosen).nCells === nObs;
  const children = new Map([
    ['obs', () => extendedFrame(globalObs, obsAdded)],
    ['obsm', () => extendedMapping('/obsm', globalObsm, obsmAdded, masks)],
    ['obsp', () => extendedMapping('/obsp', root.get('obsp'), obspAdded)],
    ['uns', () => (isGroup(root.get('uns')) ? root.get('uns') : viewGroup({ path: '/uns', attrs: encodingAttrs('dict'), children: new Map() }))],
    ['var', () => defaultGroup.get('var')],
    ['mod', () => viewGroup({
      path: '/mod',
      real: mod,
      attrs: mod.attrs,
      children: new Map(names.map(item => [item, () => groups.get(item)])),
    })],
  ]);
  if (isGroup(obsmaps)) children.set('obsmap', () => obsmaps);
  if (defaultMeasuresAll) {
    for (const key of ['X', 'layers', 'raw', 'varm']) {
      if (defaultGroup.has(key)) children.set(key, () => defaultGroup.get(key));
    }
  }
  return viewGroup({
    path: '/',
    real: root,
    attrs: encodingAttrs('anndata'),
    ownAttributes: ['encoding-type', 'encoding-version'],
    children,
    close: () => root.close?.(),
    extra: { modalities, defaultModality: chosen },
  });
}

/** A one-column `n × 1` boolean mask as an obs column. */
function viewArrayColumn(mask, path) {
  const rows = mask.shape[0];
  const twoDimensional = mask.shape.length === 2;
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze(encodingAttrs('array')),
    attributeType: () => null,
    shape: [rows],
    dtype: mask.dtype,
    chunks: mask.chunks === null ? null : [mask.chunks[0]],
    fillValue: mask.fillValue,
    storedBytes: (selection, options) => mask.storedBytes(twoDimensional ? [selection?.[0] ?? [0, rows], [0, 1]] : selection, options),
    read: (selection, options) => mask.read(twoDimensional ? [selection?.[0] ?? [0, rows], [0, 1]] : selection, options),
  });
}

/** The `.h5mu` entry of `LAYOUT_VIEWS`. */
export const H5MU_VIEW = Object.freeze({ recognize: isMuDataRoot, view: muDataView, readerFormat: H5MU_FORMAT });

/** The MuData Zarr entry of `LAYOUT_VIEWS`. */
export const MUDATA_ZARR_VIEW = Object.freeze({ recognize: isMuDataRoot, view: muDataView, readerFormat: MUDATA_ZARR_FORMAT });
