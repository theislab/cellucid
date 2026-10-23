/**
 * A test dataset held in memory, shown the way an AnnData file is.
 *
 * `createInMemoryDimensionManager` (the benchmark's synthetic scene) registers
 * its one layout without an `obsm` provenance, because no file backs it. A
 * session fingerprint names the live layout by that provenance -- the `obsm`
 * key and the columns it plots -- so session tests build the same in-memory
 * manager and name its layout `obsm[key]` columns `0 .. d-1`, with the data
 * mapping that shows it.
 */
import { createInMemoryDimensionManager } from '../../assets/js/data/dimension-manager.js';

/** The `obsm` key an in-memory test layout is named by. */
export const IN_MEMORY_OBSM_KEY = 'X_umap';

function columnsOf(dimension) {
  return Array.from({ length: dimension }, (_, column) => column);
}

/**
 * `createInMemoryDimensionManager(candidate)`, whose layout (keyed
 * `<d>d`) is named `obsm[key]` columns `0 .. d-1`.
 *
 * @param {{positions: Float32Array, dimension: number}} candidate
 * @param {string} [key]
 */
export function createInMemoryAnnDataDimensionManager(candidate, key = IN_MEMORY_OBSM_KEY) {
  const manager = createInMemoryDimensionManager(candidate);
  const layoutKey = `${candidate.dimension}d`;
  const layout = manager.getLayout(layoutKey);
  manager._layouts.set(layoutKey, Object.freeze({
    ...layout,
    provenance: Object.freeze({ key, columns: Object.freeze(columnsOf(candidate.dimension)) }),
  }));
  return manager;
}

/**
 * The data mapping of a dataset whose one embedding is that in-memory layout.
 *
 * @param {number} [dimension]
 * @param {string} [key]
 */
export function inMemoryAnnDataMapping(dimension = 3, key = IN_MEMORY_OBSM_KEY) {
  const ref = () => ({ key, columns: columnsOf(dimension) });
  const defaults = { '1d': null, '2d': null, '3d': null };
  defaults[`${dimension}d`] = ref();
  return {
    kind: 'anndata',
    embeddings: { enabled: [ref()], defaults },
    knn: null,
    geneNames: 'index',
    expression: null,
    latent: null,
    vectorFields: [],
  };
}

/**
 * `describeMappingVarCount` of a stand-in DataState whose genes are its own
 * var fields: the gene count a saved fingerprint is compared against. Install
 * it as a method (`this` is the state).
 *
 * @this {{varData: {fields: Array<{_isUserDefined?: boolean}>}}}
 * @returns {number}
 */
export function describeOwnVarCount() {
  return this.varData.fields.filter(field => field?._isUserDefined !== true).length;
}
