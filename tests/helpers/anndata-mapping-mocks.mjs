/**
 * Mock pieces of the AnnData loader contract the adapter reads
 * (`base-anndata-adapter.js`): the metadata `probes` a loader's
 * `probeMapping()` returns, and a `readObsmColumns(key, columns)` over
 * in-memory `obsm` arrays.
 */

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
