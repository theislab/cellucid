/**
 * Mock pieces of the AnnData loader contract the adapter reads
 * (`base-anndata-adapter.js`): the metadata `probes` a loader's
 * `probeMapping()` returns, and a `readObsmColumns(key, columns)` over
 * in-memory `obsm` arrays.
 */

import { EmbeddingPayloads } from '../../assets/js/data/embedding-payload.js';

/**
 * One dense numeric `obsm` probe.
 *
 * @param {string} key
 * @param {number} nObs
 * @param {number} width
 * @returns {Object}
 */
export function denseObsmProbe(key, nObs, width) {
  return { key, storage: 'dense', shape: [nObs, width], dtype: 'float32', numeric: true, nnz: null };
}

/**
 * The probes of a file whose `obsm` holds dense arrays of the given widths.
 *
 * @param {{
 *   nObs: number,
 *   nVars?: number,
 *   obsm?: Record<string, number|Object>,
 *   connectivities?: boolean,
 *   hasX?: boolean
 * }} options - `obsm` maps a key to a width or to a complete probe.
 * @returns {Object}
 */
export function mappingProbes({ nObs, nVars = 0, obsm = {}, connectivities = false, hasX = false }) {
  return {
    nObs,
    nVars,
    obsm: Object.entries(obsm).map(([key, value]) => (
      typeof value === 'number' ? denseObsmProbe(key, nObs, value) : { key, ...value }
    )),
    obsp: connectivities
      ? [{
          key: 'connectivities',
          storage: 'csr',
          shape: [nObs, nObs],
          dtype: 'float32',
          numeric: true,
          nnz: null,
        }]
      : [],
    varColumns: [],
    X: hasX ? { storage: 'dense', dtype: 'float32' } : null,
    layers: [],
    raw: null,
    // No `uns['log1p']`: every matrix is as stored.
    log1p: null,
  };
}

/**
 * The loader metadata descriptor: stats, probes and the obs field listing.
 *
 * @param {{stats?: Object, obsFields?: string[]} & Parameters<typeof mappingProbes>[0]} options
 * @returns {Object}
 */
export function loaderMetadata({ stats = {}, obsFields = [], ...probeOptions }) {
  return {
    stats: {
      n_cells: probeOptions.nObs,
      n_genes: 0,
      n_obs_fields: obsFields.length,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: probeOptions.connectivities === true,
      ...stats,
    },
    probes: mappingProbes(probeOptions),
    obs_fields: obsFields.map(key => ({ key, kind: 'unknown' })),
  };
}

/**
 * Select columns of one row-major array into a fresh Float64Array, as a
 * loader's `readObsmColumns` returns them.
 *
 * @param {ArrayLike<number>} data
 * @param {number} width
 * @param {ReadonlyArray<number>} columns
 * @returns {Float64Array}
 */
export function selectColumns(data, width, columns) {
  const rows = data.length / width;
  const result = new Float64Array(rows * columns.length);
  for (let row = 0; row < rows; row++) {
    columns.forEach((column, index) => {
      result[row * columns.length + index] = data[row * width + column];
    });
  }
  return result;
}

/**
 * A `readObsmColumns` over `{key: {data, width}}` arrays.
 *
 * @param {Record<string, {data: ArrayLike<number>, width: number}>} arrays
 * @returns {(key: string, columns: number[]) => Promise<Float64Array>}
 */
export function obsmColumnReader(arrays) {
  return async (key, columns) => {
    const array = arrays[key];
    if (array === undefined) throw new Error(`obsm['${key}'] does not exist in this file`);
    return selectColumns(array.data, array.width, columns);
  };
}

/**
 * A test loader that reads `obsm` columns (`readObsmColumns`), given the
 * embedding and vector payload methods the adapter calls -- the reader's
 * own (`EmbeddingPayloads`, as the AnnData reader makes them), over the
 * loader's `readObsmColumns` as it is when each read runs.
 *
 * @template T
 * @param {T & {readObsmColumns: Function}} loader
 * @returns {T}
 */
export function withObsmPayloads(loader) {
  const payloads = new EmbeddingPayloads((key, columns, options) => loader.readObsmColumns(key, columns, options));
  loader.readEmbedding = (key, columns, normalize, options = {}) =>
    payloads.embedding(key, [...columns], normalize, options);
  loader.readVectorField = (key, columns, embedding, normalize, options = {}) =>
    payloads.vectors(key, [...columns], { key: embedding.key, columns: [...embedding.columns] }, normalize, options);
  // A fake that answers getObsFieldInfo answers its metadata-only form too,
  // as the reader does (`getObsFieldKind`: a categorical without its
  // categories, which opening never reads).
  if (typeof loader.getObsFieldInfo === 'function' && typeof loader.getObsFieldKind !== 'function') {
    loader.getObsFieldKind = async function getObsFieldKind(key) {
      const info = await this.getObsFieldInfo(key);
      if (info?.dtype !== 'categorical') return info;
      return { dtype: 'categorical', categoryCount: info.categories?.length ?? 0, ordered: info.ordered };
    };
  }
  const clearCache = loader.clearCache;
  loader.clearCache = function clearCacheAndPayloads(...args) {
    payloads.clear();
    return clearCache?.apply(this, args);
  };
  return loader;
}
