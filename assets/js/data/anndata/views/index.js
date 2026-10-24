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
 *       view(root, context): Object,       // the AnnData store root (view-nodes.js)
 *       readerFormat: {storage, file},     // how the AnnData reader names it in messages
 *     }
 *
 * `context` is `{name, layout}`. Neither function reads an array's values.
 * The view's root closes the real one: `viewGroup({path: '/', …, close: () =>
 * root.close?.()})` (`view-nodes.js`).
 *
 * @module data/anndata/views
 */

/** @type {Readonly<Record<string, Readonly<{recognize: Function, view: Function, readerFormat: Object}>>>} */
export const LAYOUT_VIEWS = Object.freeze({});
