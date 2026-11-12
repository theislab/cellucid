/**
 * The layout views, by input format id (`data/input-formats.js`): how a
 * format whose container allows random access (HDF5, Zarr) is presented as
 * an AnnData store root, every array read in place. `open.js` opens the
 * container, then asks each view of the formats that container and layout
 * can hold whether it recognizes the root; the first that does presents it.
 * A root no view recognizes is the container's AnnData format (`h5ad`,
 * `zarr`), read as it is stored, when it bears an AnnData store's marks
 * (`open.js` `hasAnnDataMarks`); one with none is refused as none of the
 * formats. A view recognizes its format by what only it writes (Loom's
 * attribute groups, a 10x matrix's barcodes and features), not by every
 * part it reads: a file of the format missing one is refused by its view,
 * as that format (`AnnDataFormatError`), never read as AnnData and refused
 * for a part AnnData would have.
 *
 * Each view is
 *
 *     {
 *       recognize(root, options): Promise<boolean>,   // from the root's keys and attributes, loading what it looks at
 *       openingPaths: Array,               // what `view` reads of the root (`Group.load` paths)
 *       view(root, context): Promise<Object>,   // the AnnData store root (view-nodes.js)
 *       readerFormat: {storage, file},     // how the AnnData reader names it in messages
 *       matrixFile?(files): {path, file, base}|null,   // a folder format: the file it opens
 *     }
 *
 * `options` and `context` carry the opening's `signal` and `activity`;
 * `context` is also `{name, layout}`, and for a folder format
 * `{files, base}` (the folder's files, and the folder of the file it
 * opened). The root is opened with its own children known (`openHdf5`,
 * `formats/store.js`); `recognize` loads anything deeper it looks at, and
 * `view` loads `openingPaths` before it builds the view (`open.js` also
 * names them to `openHdf5`, so they load with the root). `recognize` reads
 * no value; `view` reads none of the arrays it presents, only the few
 * small ones some layouts are told by (which feature of a 10x matrix is of
 * which type; an `outs/` folder's analysis CSVs). A view node made from a
 * real group lists that group among its `sources` and lists its children
 * only once it is loaded, so loading the view loads the real groups
 * (`viewGroup`). The view's root closes the real one, with the reason its
 * reads still under way stop with: `viewGroup({path: '/', …, close: reason
 * => root.close?.(reason)})` (`view-nodes.js`). A multimodal
 * store's root carries `modalities` and `defaultModality` (`modalities.js`).
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
