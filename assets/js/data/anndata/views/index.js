/**
 * The layout views, by input format id (`data/input-formats.js`): how a
 * format whose container allows random access (HDF5, Zarr) is presented as
 * an AnnData store root, every array read in place. `open.js` opens the
 * container, then asks each view of the formats that container and layout
 * can hold whether it recognises the root; the first that does presents it.
 * A root no view recognises is the container's AnnData format (`h5ad`,
 * `zarr`), read as it is stored.
 *
 * Each view is
 *
 *     {
 *       recognize(root): boolean,          // from the root's keys and attributes only
 *       view(root, context): Object|Promise<Object>,   // the AnnData store root (view-nodes.js)
 *       readerFormat: {storage, file},     // how the AnnData reader names it in messages
 *       matrixFile?(files): {path, file, base}|null,   // a folder format: the file it opens
 *     }
 *
 * `context` is `{name, layout, signal}`, and for a folder format also
 * `{files, base}` (the folder's files, and the folder of the file it
 * opened). `recognize` reads no value; `view` reads none of the arrays it
 * presents, only the few small ones some layouts are told by (which feature
 * of a 10x matrix is of which type; an `outs/` folder's analysis CSVs). The
 * view's root closes the real one: `viewGroup({path: '/', …, close: () =>
 * root.close?.()})` (`view-nodes.js`). A multimodal store's root carries
 * `modalities` and `defaultModality` (`modalities.js`).
 *
 * @module data/anndata/views
 */

import { LOOM_VIEW } from './loom.js';
import { H5MU_VIEW, MUDATA_ZARR_VIEW } from './mudata.js';
import { TENX_H5_VIEW } from './tenx-h5.js';
import { TENX_OUTS_VIEW } from './tenx-outs.js';
import { H5SEURAT_VIEW } from './h5seurat.js';

/** @type {Readonly<Record<string, Readonly<{recognize: Function, view: Function, readerFormat: Object, matrixFile?: Function}>>>} */
export const LAYOUT_VIEWS = Object.freeze({
  loom: LOOM_VIEW,
  'tenx-h5': TENX_H5_VIEW,
  'tenx-outs': TENX_OUTS_VIEW,
  h5mu: H5MU_VIEW,
  'mudata-zarr': MUDATA_ZARR_VIEW,
  h5seurat: H5SEURAT_VIEW,
});
