/**
 * The AnnData data-mapping candidate catalog, built in the browser from the
 * metadata an `.h5ad` or Zarr file declares (design §1.2), and the load-time
 * check every embedding passes before it is plotted (§1.3).
 *
 * The catalog is answered at the `candidates` route under the dataset's base,
 * for a file opened here, from a link, or served by `cellucid serve` or a
 * notebook (which hand the browser the file itself).
 * Everything here is metadata: shapes, storage kinds and dtypes. No array value is read except by `embeddingLoadDefect`,
 * which judges values the caller already read.
 *
 * Routes address catalog entries by their position in these lists, never by
 * key, so a path never carries a dataset's vocabulary. Every route names the
 * AnnData element it reads, under the dataset's base (`h5ad://<id>/` or
 * `zarr://<id>/`):
 *
 * - `obsm/{i}/{cols}` -- `obsm` entry `i` read at columns `cols` (`0-1`);
 * - `vectors/{v}/{vcols}/{e}/{ecols}` -- `obsm` entry `v` at `vcols`, drawn
 *   on the embedding `obsm/{e}/{ecols}`;
 * - `obsp/{p}` -- the neighbour graph in `obsp` entry `p`;
 * - `var/{axis}/{names}` -- the genes of one expression matrix (`X`, `raw`
 *   or `layer-{k}`) named by one name source (`index` or `column-{k}`), and
 *   `var/{axis}/{names}/{g}` gene `g` of that list;
 * - `outliers/{l}/{f}` -- the outlier quantiles of categorical obs field `f`
 *   in the latent space `obsm` entry `l`.
 *
 * The dataset's own defaults have their own routes beside these (`obs`,
 * `var`, `var/{g}`, `obsp`; `data-loaders.js`).
 *
 * @module data/data-mapping-candidates
 */

import {
  ANNDATA_KIND,
  DIMENSION_SLOTS,
  bestGuessEmbeddingSlots,
  bestGuessTier,
  canonicalEmbeddingId,
  defaultColumns,
  defaultEnabledEmbeddings,
  defaultEmbeddingSlots,
  defaultExpression,
  defaultHighlyVariable,
  defaultLog1p,
  defaultVectorBindings,
  parseVectorFieldKey,
  slotDimension,
  validateEmbeddingColumns,
  vectorFieldKeys,
} from './data-mapping.js';

/**
 * The neighbour graph a file read in the browser opens with, when `obsp`
 * holds it: what `sc.pp.neighbors()` writes.
 */
export const DEFAULT_KNN_KEY = 'connectivities';

/**
 * Require one `obsp` key: a non-empty string naming a single HDF5/Zarr member.
 *
 * @param {unknown} key
 * @returns {string}
 */
export function requireObspKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('/')) {
    throw new TypeError('An obsp key must be a non-empty string without "/".');
  }
  return key;
}

const STORAGE_KINDS = Object.freeze(['dense', 'csr', 'csc', 'dataframe', 'other']);
const DECIMAL = '(?:0|[1-9][0-9]*)';
const EMBEDDING_ROUTE = new RegExp(
  `^obsm/(${DECIMAL})/(${DECIMAL}(?:-${DECIMAL}){0,2})$`
);

function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireStorage(value, label) {
  if (!STORAGE_KINDS.includes(value)) {
    throw new TypeError(`${label} storage must be one of ${STORAGE_KINDS.join(', ')}.`);
  }
  return value;
}

function requireShape(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some(size => !Number.isSafeInteger(size) || size < 0)) {
    throw new TypeError(`${label} shape must be null or non-negative integers.`);
  }
  return [...value];
}

/**
 * One probed AnnData element, as a loader describes it from metadata alone.
 *
 * @typedef {{
 *   key: string,
 *   storage: 'dense'|'csr'|'csc'|'dataframe'|'other',
 *   shape: number[]|null,
 *   dtype: string,
 *   numeric: boolean
 * }} ElementProbe
 */

/**
 * Everything a loader probes for the catalog.
 *
 * @typedef {{
 *   nObs: number,
 *   nVars: number,
 *   obsm: ElementProbe[],
 *   obsp: Array<ElementProbe & {nnz: number|null}>,
 *   varColumns: Array<{key: string, dtype: string}>,
 *   X: {storage: string, dtype: string}|null,
 *   layers: ElementProbe[],
 *   raw: {nVars: number, X: {storage: string, dtype: string}, varColumns: Array<{key: string, dtype: string}>}|null,
 *   log1p: {base: number|null}|null
 * }} AnnDataProbes
 *
 * `log1p` is `uns['log1p']` as `sc.pp.log1p` records it: null when the file
 * has none, else its `base` (null for e, as Scanpy writes None).
 */

function requireElementProbe(probe, label) {
  if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (typeof probe.key !== 'string' || probe.key.length === 0) {
    throw new TypeError(`${label} key must be a non-empty string.`);
  }
  if (typeof probe.dtype !== 'string' || probe.dtype.length === 0) {
    throw new TypeError(`${label} dtype must be a non-empty string.`);
  }
  if (typeof probe.numeric !== 'boolean') {
    throw new TypeError(`${label} numeric must be a boolean.`);
  }
  return {
    key: probe.key,
    storage: requireStorage(probe.storage, label),
    shape: requireShape(probe.shape, label),
    dtype: probe.dtype,
    numeric: probe.numeric,
  };
}

/**
 * Describe every `obsm` entry with the listing-time verdict of §1.3, in the
 * file's key order.
 *
 * @param {ReadonlyArray<ElementProbe>} probes
 * @param {number} nObs
 * @returns {Array<{key: string, storage: string, shape: number[]|null, dtype: string, usable: boolean, reason: string|null}>}
 */
export function describeObsmProbes(probes, nObs) {
  requireCount(nObs, 'nObs');
  return requireArray(probes, 'obsm probes').map((raw, index) => {
    const probe = requireElementProbe(raw, `obsm probe ${index}`);
    const { storage, shape } = probe;
    let reason = null;
    if (storage === 'dataframe') {
      reason = 'obsm table, not an array';
    } else if (storage === 'csr' || storage === 'csc') {
      reason = 'sparse obsm arrays cannot be plotted';
    } else if (storage !== 'dense') {
      reason = 'not an array';
    } else if (shape === null || (shape.length !== 1 && shape.length !== 2)) {
      reason = 'not a one- or two-dimensional array';
    } else if (shape[0] !== nObs) {
      reason = `has ${formatCount(shape[0])} rows, the dataset has ${formatCount(nObs)} cells`;
    } else if (!probe.numeric) {
      reason = 'not a numeric array';
    } else if (shape.length === 2 && shape[1] < 1) {
      reason = 'has no columns';
    }
    return {
      key: probe.key,
      storage,
      shape,
      dtype: probe.dtype,
      usable: reason === null,
      reason,
    };
  });
}

/**
 * The column count of one described `obsm` entry: 1 for a plain vector, the
 * second extent of a matrix, and null for anything that is not a dense array.
 *
 * @param {{storage: string, shape: number[]|null}} item
 * @returns {number|null}
 */
export function obsmWidth(item) {
  if (item.storage !== 'dense' || item.shape === null) return null;
  if (item.shape.length === 1) return 1;
  if (item.shape.length === 2) return item.shape[1];
  return null;
}

/**
 * The entries the embedding rules of `data-mapping.js` read.
 *
 * @param {ReadonlyArray<{key: string, storage: string, shape: number[]|null, usable: boolean, reason: string|null}>} described
 * @returns {Array<{key: string, width: number|null, usable: boolean, reason: string|null}>}
 */
export function obsmEntries(described) {
  return described.map(item => ({
    key: item.key,
    width: obsmWidth(item),
    usable: item.usable,
    reason: item.reason,
  }));
}

function describeObsp(probes, nObs) {
  return requireArray(probes, 'obsp probes').map((raw, index) => {
    const probe = requireElementProbe(raw, `obsp probe ${index}`);
    const { storage, shape } = probe;
    let reason = null;
    if (storage !== 'dense' && storage !== 'csr' && storage !== 'csc') {
      reason = 'not a matrix';
    } else if (shape === null || shape.length !== 2 || shape[0] !== shape[1]) {
      reason = 'not square';
    } else if (shape[0] !== nObs) {
      reason = `has ${formatCount(shape[0])} rows, the dataset has ${formatCount(nObs)} cells`;
    } else if (!probe.numeric) {
      reason = 'not a numeric matrix';
    }
    const nnz = raw.nnz;
    if (nnz !== null && !(Number.isSafeInteger(nnz) && nnz >= 0)) {
      throw new TypeError(`obsp probe ${index} nnz must be null or a non-negative integer.`);
    }
    return {
      key: probe.key,
      storage,
      shape,
      dtype: probe.dtype,
      nnz: storage === 'csr' || storage === 'csc' ? nnz : null,
      usable: reason === null,
      reason,
    };
  });
}

function describeVarColumns(columns) {
  return requireArray(columns, 'var column probes').map((column, index) => {
    if (
      column === null ||
      typeof column !== 'object' ||
      typeof column.key !== 'string' ||
      column.key.length === 0 ||
      typeof column.dtype !== 'string' ||
      column.dtype.length === 0
    ) {
      throw new TypeError(`var column probe ${index} must name its key and dtype.`);
    }
    let reason = null;
    if (/^float(16|32|64)$/.test(column.dtype)) {
      reason = 'floating-point values cannot name genes';
    } else if (column.dtype === 'bool') {
      reason = 'true/false values cannot name genes';
    }
    return { key: column.key, dtype: column.dtype, usable: reason === null, reason };
  });
}

function describeMatrix(matrix, label) {
  if (matrix === null) return null;
  if (typeof matrix?.dtype !== 'string') {
    throw new TypeError(`${label} must name its dtype.`);
  }
  return { storage: requireStorage(matrix.storage, label), dtype: matrix.dtype };
}

function describeLayers(probes, nObs, nVars) {
  return requireArray(probes, 'layer probes').map((raw, index) => {
    const probe = requireElementProbe(raw, `layer probe ${index}`);
    const { storage, shape } = probe;
    let reason = null;
    if (storage !== 'dense' && storage !== 'csr' && storage !== 'csc') {
      reason = 'not a matrix';
    } else if (shape === null || shape.length !== 2 || shape[0] !== nObs || shape[1] !== nVars) {
      reason = `has shape ${(shape ?? []).join(' x ')}, expected ${nObs} x ${nVars}`;
    } else if (!probe.numeric) {
      reason = 'not a numeric matrix';
    }
    return { key: probe.key, storage, dtype: probe.dtype, usable: reason === null, reason };
  });
}

function describeLog1pProbe(probe) {
  if (probe === null) return null;
  if (
    probe === undefined ||
    typeof probe !== 'object' ||
    Array.isArray(probe) ||
    Object.keys(probe).join(',') !== 'base' ||
    !(probe.base === null || (typeof probe.base === 'number' && Number.isFinite(probe.base) && probe.base > 0 && probe.base !== 1))
  ) {
    throw new TypeError("Probed uns['log1p'] must be null or {base}, base null or a positive number other than 1.");
  }
  return { base: probe.base };
}

/**
 * Describe what a loader probed, with the listing-time verdict of every entry.
 *
 * @param {AnnDataProbes} probes
 * @returns {{
 *   nObs: number,
 *   obsm: ReturnType<typeof describeObsmProbes>,
 *   obsp: Array<Object>,
 *   var: {n_vars: number, columns: Array<Object>},
 *   X: {storage: string, dtype: string}|null,
 *   layers: Array<Object>,
 *   raw: Object|null
 * }}
 */
export function describeAnnDataProbes(probes) {
  if (probes === null || typeof probes !== 'object' || Array.isArray(probes)) {
    throw new TypeError('AnnData mapping probes must be an object.');
  }
  const nObs = requireCount(probes.nObs, 'Probed n_obs');
  const nVars = requireCount(probes.nVars, 'Probed n_vars');
  const raw = probes.raw;
  return {
    nObs,
    obsm: describeObsmProbes(probes.obsm, nObs),
    obsp: describeObsp(probes.obsp, nObs),
    var: { n_vars: nVars, columns: describeVarColumns(probes.varColumns) },
    X: describeMatrix(probes.X, 'Probed X'),
    layers: describeLayers(probes.layers, nObs, nVars),
    raw: raw === null
      ? null
      : {
          n_vars: requireCount(raw.nVars, 'Probed raw n_vars'),
          X: describeMatrix(raw.X, 'Probed raw.X'),
          var: { columns: describeVarColumns(raw.varColumns) },
        },
    log1p: describeLog1pProbe(probes.log1p),
  };
}

/**
 * Assemble the candidate catalog of one file the browser opened.
 *
 * `slots` is the embedding resolution the adapter settled on (the default
 * rule, or the best guess after its load checks); they become the defaults,
 * and every narrow array is enabled beside them (`defaultEnabledEmbeddings`).
 * `guessed` names the groups that were guessed. The other defaults are the ones this viewer reads
 * from such a file: `obsp['connectivities']` when it is listed, the var index,
 * `X` (else `raw` or a layer, guessed; or no expression matrix), each
 * matrix's `log1p` by Scanpy's `uns['log1p']` (`defaultLog1p`, guessed), the
 * `highly_variable` column of the expression matrix's genes when it is boolean
 * there (`defaultHighlyVariable`, guessed), no latent space, and the vector
 * fields the default rule binds.
 *
 * `rejected` lists the `[key, reason]` of every array the best guess loaded
 * and refused: the browser has read those values, so its catalog lists them
 * as unusable with the load-time reason instead of the listing-time verdict.
 *
 * `chosen` replaces the automatic `knn`, `geneNames`, `expression` and
 * `latent` defaults with the ones a launch named (each only when given, and
 * already checked against the file by the caller); a chosen expression
 * matrix is not guessed.
 *
 * @param {ReturnType<typeof describeAnnDataProbes>} described
 * @param {{slots: Object, guessed: ReadonlyArray<string>, rejected?: ReadonlyArray<[string, string]>}} resolution
 * @param {{knn?: string|null, geneNames?: string, expression?: string|null, latent?: string|null}} [chosen]
 * @returns {Object} A deep-frozen candidate catalog.
 */
export function assembleAnnDataCandidates(described, { slots, guessed, rejected = [] }, chosen = {}) {
  const defaults = {};
  for (const slot of DIMENSION_SLOTS) {
    const ref = slots[slot] ?? null;
    defaults[slot] = ref === null ? null : { key: ref.key, columns: [...ref.columns] };
  }
  const connectivities = described.obsp.find(item => item.key === DEFAULT_KNN_KEY);
  const loadFailures = new Map(rejected);
  // X when the file has it; otherwise raw, the only layer, or the best-named
  // layer (`defaultExpression`), recorded as guessed.
  const expression = Object.hasOwn(chosen, 'expression')
    ? { expression: chosen.expression, guessed: false }
    : defaultExpression({
      hasX: described.X !== null,
      hasRaw: described.raw !== null && described.raw.X !== null,
      layers: described.layers.filter(layer => layer.usable).map(layer => layer.key),
    });
  const latent = Object.hasOwn(chosen, 'latent') ? chosen.latent : null;
  const log1p = defaultLog1p({
    log1p: described.log1p,
    hasX: described.X !== null,
    raw: described.raw === null || described.raw.X === null ? null : { dtype: described.raw.X.dtype },
    layers: described.layers.filter(layer => layer.usable).map(layer => layer.key),
  });
  const highlyVariable = expression.expression === null
    ? { highlyVariable: null, guessed: false }
    : defaultHighlyVariable(
      expression.expression === 'raw' ? described.raw.var.columns : described.var.columns
    );
  const entries = obsmEntries(described.obsm);
  const enabled = defaultEnabledEmbeddings(entries, defaults, {
    latentKey: latent,
    rejected: rejected.map(([key]) => key),
  });
  const candidates = {
    kind: ANNDATA_KIND,
    n_obs: described.nObs,
    obsm: described.obsm.map(item => (
      loadFailures.has(item.key)
        ? { ...item, usable: false, reason: loadFailures.get(item.key) }
        : item
    )),
    obsp: described.obsp,
    var: described.var,
    X: described.X,
    layers: described.layers,
    raw: described.raw,
    log1p: described.log1p,
    defaults: {
      kind: ANNDATA_KIND,
      embeddings: {
        enabled,
        defaults,
      },
      knn: Object.hasOwn(chosen, 'knn')
        ? chosen.knn
        : (connectivities === undefined ? null : DEFAULT_KNN_KEY),
      geneNames: Object.hasOwn(chosen, 'geneNames') ? chosen.geneNames : 'index',
      expression: expression.expression,
      log1p: log1p.log1p,
      highlyVariable: highlyVariable.highlyVariable,
      latent,
      vectorFields: defaultVectorBindings(entries, enabled),
    },
    guessed: [
      ...guessed,
      ...(expression.guessed ? ['expression'] : []),
      ...(log1p.guessed ? ['log1p'] : []),
      ...(highlyVariable.guessed ? ['highlyVariable'] : []),
    ],
  };
  return deepFreeze(candidates);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The position of one `obsm` key in a catalog, or -1.
 *
 * @param {{obsm: ReadonlyArray<{key: string}>}} candidates
 * @param {string} key
 * @returns {number}
 */
export function obsmIndexOf(candidates, key) {
  return candidates.obsm.findIndex(item => item.key === key);
}

/**
 * The route of one mapped embedding: `obsm` entry `obsmIndex` read at
 * `columns`, normalized float32, one row per cell.
 *
 * @param {number} obsmIndex
 * @param {ReadonlyArray<number>} columns
 * @returns {string}
 */
export function mappingEmbeddingPath(obsmIndex, columns) {
  if (!Number.isSafeInteger(obsmIndex) || obsmIndex < 0) {
    throw new TypeError('An obsm index must be a non-negative integer.');
  }
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 3) {
    throw new TypeError('A mapped embedding reads 1 to 3 columns.');
  }
  return `obsm/${obsmIndex}/${columns.join('-')}`;
}

/**
 * Parse one mapped-embedding route, or return null for any other path.
 *
 * @param {string} path
 * @returns {{obsmIndex: number, columns: number[]}|null}
 */
export function parseMappingEmbeddingPath(path) {
  if (typeof path !== 'string') return null;
  const match = EMBEDDING_ROUTE.exec(path);
  if (match === null) return null;
  return {
    obsmIndex: Number(match[1]),
    columns: match[2].split('-').map(Number),
  };
}

const GRAPH_ROUTE = new RegExp(`^obsp/(${DECIMAL})$`);

/**
 * The route of one mapped neighbour graph: `obsp` entry `obspIndex`, whose
 * summary and edges are both read at it.
 *
 * @param {number} obspIndex
 * @returns {string}
 */
export function mappingGraphPath(obspIndex) {
  if (!Number.isSafeInteger(obspIndex) || obspIndex < 0) {
    throw new TypeError('An obsp index must be a non-negative integer.');
  }
  return `obsp/${obspIndex}`;
}

/**
 * The `obsp` entry a mapped neighbour-graph route names, or null for any
 * other path (the dataset's own graph, `obsp`).
 *
 * @param {string} path
 * @returns {number|null}
 */
export function parseMappingGraphPath(path) {
  if (typeof path !== 'string') return null;
  const match = GRAPH_ROUTE.exec(path);
  return match === null ? null : Number(match[1]);
}

const GENES_ROUTE = new RegExp(
  `^var/(X|raw|layer-${DECIMAL})/(index|column-${DECIMAL})(?:/(${DECIMAL}))?$`
);

/**
 * The route segment of one expression source on a catalog: `X`, `raw`, or
 * `layer-{k}` (`k` into `layers`). Null when the catalog has no such matrix.
 *
 * @param {Object} candidates
 * @param {string} expression - `X`, `raw` or `layer:<name>`.
 * @returns {string|null}
 */
export function expressionAxisRoute(candidates, expression) {
  if (expression === 'X') return candidates.X === null ? null : 'X';
  if (expression === 'raw') return candidates.raw === null ? null : 'raw';
  if (typeof expression === 'string' && expression.startsWith('layer:')) {
    const index = candidates.layers.findIndex(layer => layer.key === expression.slice('layer:'.length));
    return index < 0 ? null : `layer-${index}`;
  }
  return null;
}

/**
 * The var columns gene names may come from on one axis route: `raw` has its
 * own `raw.var`; `X` and every layer share `var`.
 *
 * @param {Object} candidates
 * @param {string} axisRoute
 * @returns {ReadonlyArray<{key: string, dtype: string, usable: boolean, reason: string|null}>}
 */
export function axisVarColumns(candidates, axisRoute) {
  return axisRoute === 'raw' ? candidates.raw.var.columns : candidates.var.columns;
}

/**
 * The route segment of one gene-name source on an axis route: `index`, or
 * `column-{k}` (`k` into that axis's var columns). Null when the axis has no
 * such column.
 *
 * @param {Object} candidates
 * @param {string} axisRoute
 * @param {string} geneNames - `index` or `column:<name>`.
 * @returns {string|null}
 */
export function geneNamesRoute(candidates, axisRoute, geneNames) {
  if (geneNames === 'index') return 'index';
  if (typeof geneNames === 'string' && geneNames.startsWith('column:')) {
    const index = axisVarColumns(candidates, axisRoute)
      .findIndex(column => column.key === geneNames.slice('column:'.length));
    return index < 0 ? null : `column-${index}`;
  }
  return null;
}

/**
 * The route of one mapped gene list: the genes of one expression matrix
 * named by one name source. Gene `g` of the list is at `{route}/{g}`.
 *
 * @param {string} axisRoute
 * @param {string} namesRoute
 * @returns {string}
 */
export function mappingGeneListPath(axisRoute, namesRoute) {
  return `var/${axisRoute}/${namesRoute}`;
}

/**
 * Parse one mapped gene route, or return null for any other path.
 *
 * @param {string} path
 * @returns {{axisRoute: string, namesRoute: string, gene: number|null}|null}
 *   `gene` is null for the gene list itself.
 */
export function parseMappingGenesPath(path) {
  if (typeof path !== 'string') return null;
  const match = GENES_ROUTE.exec(path);
  if (match === null) return null;
  return {
    axisRoute: match[1],
    namesRoute: match[2],
    gene: match[3] === undefined ? null : Number(match[3]),
  };
}

/**
 * The position of one `obsp` key in a catalog, or -1.
 *
 * @param {{obsp: ReadonlyArray<{key: string}>}} candidates
 * @param {string} key
 * @returns {number}
 */
export function obspIndexOf(candidates, key) {
  return candidates.obsp.findIndex(item => item.key === key);
}

/**
 * Resolve one `{key, columns}` reference against a catalog for one
 * dimension, or explain why it cannot be plotted there.
 *
 * @param {Object} candidates - An AnnData candidate catalog.
 * @param {{key: string, columns: ReadonlyArray<number>}} ref
 * @param {number} dimension
 * @returns {{ok: true, obsmIndex: number, width: number, columns: number[]}|{ok: false, reason: string}}
 */
export function resolveCandidateRef(candidates, ref, dimension) {
  const obsmIndex = obsmIndexOf(candidates, ref.key);
  if (obsmIndex < 0) {
    return { ok: false, reason: `obsm['${ref.key}'] does not exist in this dataset` };
  }
  const item = candidates.obsm[obsmIndex];
  if (!item.usable) {
    return { ok: false, reason: `obsm['${ref.key}'] ${item.reason}` };
  }
  const width = obsmWidth(item);
  try {
    const columns = validateEmbeddingColumns([...ref.columns], { dimension, width });
    return { ok: true, obsmIndex, width, columns };
  } catch (error) {
    return { ok: false, reason: `obsm['${ref.key}']: ${error.message}` };
  }
}

const COLUMN_LIST = `${DECIMAL}(?:-${DECIMAL}){0,2}`;
const VECTOR_ROUTE = new RegExp(
  `^vectors/(${DECIMAL})/(${COLUMN_LIST})/(${DECIMAL})/(${COLUMN_LIST})$`
);
const LATENT_ROUTE = new RegExp(`^outliers/(${DECIMAL})/(${DECIMAL})$`);

/**
 * The fewest cells a category needs for its cells to get outlier quantiles;
 * smaller categories get none (NaN). `prepare()` defaults to the same count.
 */
export const LATENT_OUTLIER_MIN_POINTS = 10;

/**
 * The id a vector field is listed under. A key bound to the embedding it is
 * named for (`parseVectorFieldKey`) is its field, so the keys of one field on
 * every basis are one field: `velocity_umap` on `X_umap` and
 * `velocity_umap_3d` on `X_umap_3d` are both `velocity`, as `prepare()`
 * names it. A key bound to any other embedding is its own field.
 *
 * @param {Object} candidates - An AnnData candidate catalog.
 * @param {{key: string, embedding: {key: string}}} binding
 * @returns {string}
 */
export function vectorFieldIdOf(candidates, binding) {
  const parsed = parseVectorFieldKey(
    binding.key,
    new Set(candidates.obsm.map(item => item.key))
  );
  return parsed !== null && parsed.embeddingKey === binding.embedding.key
    ? parsed.field
    : binding.key;
}

/**
 * Resolve one AnnData vector binding `{key, embedding}` against a catalog:
 * the vector array is read at the embedding's own columns when both arrays
 * are equally wide (`velocity_pca` over `X_pca[2,3]`), or whole when it is
 * exactly as wide as the embedding's dimension (a 2-column `drift` over
 * `X_pca[0,1]`).
 *
 * @param {Object} candidates - An AnnData candidate catalog.
 * @param {{key: string, embedding: {key: string, columns: ReadonlyArray<number>}}} binding
 * @returns {{ok: true, fieldId: string, layoutKey: string, dimension: number, path: string}|{ok: false, reason: string}}
 */
export function resolveVectorBinding(candidates, binding) {
  const dimension = binding.embedding.columns.length;
  const embedding = resolveCandidateRef(candidates, binding.embedding, dimension);
  if (!embedding.ok) return { ok: false, reason: embedding.reason };
  const vectorIndex = obsmIndexOf(candidates, binding.key);
  if (vectorIndex < 0) {
    return { ok: false, reason: `obsm['${binding.key}'] does not exist in this dataset` };
  }
  const item = candidates.obsm[vectorIndex];
  if (!item.usable) return { ok: false, reason: `obsm['${binding.key}'] ${item.reason}` };
  if (vectorIndex === embedding.obsmIndex) {
    return { ok: false, reason: `obsm['${binding.key}'] is the embedding itself` };
  }
  const width = obsmWidth(item);
  let vectorColumns;
  if (width === embedding.width) {
    vectorColumns = [...embedding.columns];
  } else if (width === dimension) {
    vectorColumns = defaultColumns(dimension);
  } else {
    return {
      ok: false,
      reason: `obsm['${binding.key}'] has ${width} columns; it needs ${dimension}, or ${embedding.width} like obsm['${binding.embedding.key}']`,
    };
  }
  return {
    ok: true,
    fieldId: vectorFieldIdOf(candidates, binding),
    layoutKey: canonicalEmbeddingId(binding.embedding.key, embedding.columns, { width: embedding.width }),
    dimension,
    path: `vectors/${vectorIndex}/${vectorColumns.join('-')}/`
      + `${embedding.obsmIndex}/${embedding.columns.join('-')}`,
  };
}

/**
 * Parse one mapped vector route, or return null for any other path.
 *
 * @param {string} path
 * @returns {{vectorIndex: number, vectorColumns: number[], embeddingIndex: number, embeddingColumns: number[]}|null}
 */
export function parseMappingVectorPath(path) {
  if (typeof path !== 'string') return null;
  const match = VECTOR_ROUTE.exec(path);
  if (match === null) return null;
  return {
    vectorIndex: Number(match[1]),
    vectorColumns: match[2].split('-').map(Number),
    embeddingIndex: Number(match[3]),
    embeddingColumns: match[4].split('-').map(Number),
  };
}

/**
 * Why one `obsm` entry cannot be a latent space, or null when it can: it
 * must be usable and dense. Its size is not limited: the reader streams it
 * from the file.
 *
 * @param {{key: string, usable: boolean, reason: string|null, storage: string, shape: number[]|null}} item
 * @returns {string|null}
 */
export function latentCandidateReason(item) {
  if (!item.usable) return item.reason;
  if (obsmWidth(item) === null) return 'not a dense array';
  return null;
}

/**
 * The route of the outlier quantiles of one categorical obs field (its
 * position in the obs field list) in one latent space (its catalog
 * position).
 *
 * @param {number} obsmIndex
 * @param {number} fieldIndex
 * @returns {string}
 */
export function mappingLatentOutlierPath(obsmIndex, fieldIndex) {
  if (!Number.isSafeInteger(obsmIndex) || obsmIndex < 0) {
    throw new TypeError('An obsm index must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(fieldIndex) || fieldIndex < 0) {
    throw new TypeError('An obs field index must be a non-negative integer.');
  }
  return `outliers/${obsmIndex}/${fieldIndex}`;
}

/**
 * Parse one mapped outlier route, or return null for any other path.
 *
 * @param {string} path
 * @returns {{obsmIndex: number, fieldIndex: number}|null}
 */
export function parseMappingLatentPath(path) {
  if (typeof path !== 'string') return null;
  const match = LATENT_ROUTE.exec(path);
  return match === null ? null : { obsmIndex: Number(match[1]), fieldIndex: Number(match[2]) };
}

/**
 * The layout descriptor of one `obsm` array read at `columns` for one
 * dimension: keyed and labelled by its canonical embedding id, loaded from its
 * mapping route.
 *
 * @param {Object} candidates
 * @param {{key: string, columns: ReadonlyArray<number>}} ref
 * @param {number} dimension
 * @returns {{layoutKey: string, dimension: number, label: string, path: string, provenance: {key: string, columns: number[]}, origin: 'mapping'}}
 */
export function mappingLayoutDescriptor(candidates, ref, dimension) {
  const resolved = resolveCandidateRef(candidates, ref, dimension);
  if (!resolved.ok) {
    throw new RangeError(`Cannot plot this embedding in ${dimension}D: ${resolved.reason}.`);
  }
  const layoutKey = canonicalEmbeddingId(ref.key, resolved.columns, { width: resolved.width });
  return {
    layoutKey,
    dimension,
    label: layoutKey,
    path: mappingEmbeddingPath(resolved.obsmIndex, resolved.columns),
    provenance: { key: ref.key, columns: resolved.columns },
    origin: 'mapping',
  };
}

/**
 * A load-time refusal of one mapping choice: an array the catalog lists as
 * usable whose values cannot be shown or read as chosen (a NaN in an
 * embedding, a neighbour graph that is not symmetric, a latent space over the
 * memory budget). `key` names the AnnData key -- an `obsm` or `obsp` key,
 * `X`, `raw`, a layer or a `var` column -- so that one option is marked
 * unusable for the session while every other stays available.
 *
 * The browser adapters throw it.
 */
export class MappingLoadError extends Error {
  /**
   * @param {string} key
   * @param {string} reason - The clause after the key, without a final stop.
   * @param {string} [message]
   */
  constructor(key, reason, message = `'${key}' cannot be used: ${reason}.`) {
    super(message);
    this.name = 'MappingLoadError';
    this.key = key;
    this.reason = reason;
  }
}

/**
 * A load-time refusal of one embedding: its selected columns hold a value
 * Cellucid cannot plot.
 */
export class EmbeddingLoadError extends MappingLoadError {
  /**
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {string} reason
   */
  constructor(key, columns, reason) {
    super(key, reason, `Embedding '${key}' cannot be plotted: ${reason}.`);
    this.name = 'EmbeddingLoadError';
    this.columns = [...columns];
  }
}

/**
 * Return why the selected columns of one embedding cannot be plotted, or null.
 *
 * The rule is `prepare()`'s: every value is finite and representable as
 * float32 (a non-zero value that narrows to zero is not), and the columns span
 * a non-zero range. The first offending cell is named.
 *
 * @param {ArrayLike<number|bigint>} values - Row-major, `width` values a cell.
 * @param {number} width
 * @returns {string|null}
 */
export function embeddingLoadDefect(values, width) {
  const defect = valueLoadDefect(values, width);
  if (defect !== null || values.length === 0) return defect;
  const minima = new Array(width).fill(Infinity);
  const maxima = new Array(width).fill(-Infinity);
  for (let index = 0; index < values.length; index++) {
    const raw = values[index];
    const value = typeof raw === 'bigint' ? Number(raw) : raw;
    const column = index % width;
    if (value < minima[column]) minima[column] = value;
    if (value > maxima[column]) maxima[column] = value;
  }
  let span = 0;
  for (let column = 0; column < width; column++) {
    span = Math.max(span, maxima[column] - minima[column]);
  }
  return span > 0 ? null : 'no coordinate variation';
}

/**
 * The first value of a row-major numeric array Cellucid cannot read, as the
 * clause a refusal names (`NaN at cell 17`, `not representable as float32 at
 * cell 4`), or null when every value is finite and representable as float32.
 * The words `prepare()` uses for the same array.
 *
 * @param {ArrayLike<number|bigint>} values - Row-major, `width` values a cell.
 * @param {number} width
 * @returns {string|null}
 */
export function valueLoadDefect(values, width, firstCell = 0) {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new TypeError('An array width must be a positive integer.');
  }
  const length = values.length;
  if (length % width !== 0) {
    throw new RangeError('Array values do not fill whole cells.');
  }
  for (let index = 0; index < length; index++) {
    const raw = values[index];
    const value = typeof raw === 'bigint' ? Number(raw) : raw;
    const cell = firstCell + Math.floor(index / width);
    if (Number.isNaN(value)) return `NaN at cell ${cell}`;
    if (value === Infinity) return `Infinity at cell ${cell}`;
    if (value === -Infinity) return `-Infinity at cell ${cell}`;
    const narrowed = Math.fround(value);
    if (!Number.isFinite(narrowed) || (value !== 0 && narrowed === 0)) {
      return `not representable as float32 at cell ${cell}`;
    }
  }
  return null;
}

/**
 * Resolve the embedding slots of one file, running the load-time check on
 * every candidate the best guess tries.
 *
 * The default rule's keys are never load-checked here and never skipped: a
 * present `X_umap` that holds a NaN is an error when it is loaded (the adapter
 * loads the default dimension's embedding before the file is adopted, and the
 * others when they are first shown), not a reason to guess. Only when the
 * default rule fills no slot is the best guess made, and a guessed candidate
 * that fails its check is skipped for the next one. This is the same sequence as the synchronous
 * `resolveEmbeddingSlots` with a `loadCheck`, run with an asynchronous check:
 * each failed key is recorded and the guess is recomputed, so the result is
 * the same and the work is bounded by the candidate count.
 *
 * @param {Array<{key: string, width: number|null, usable: boolean, reason: string|null}>} entries
 * @param {(key: string, columns: number[]) => Promise<string|null>} loadCheck
 *   Resolves to null when the columns load, else to the reason they do not.
 * @returns {Promise<{slots: Object, guessed: string[], rejected: Array<[string, string]>}>}
 */
export async function resolveEmbeddingSlotsAsync(entries, loadCheck) {
  const slots = defaultEmbeddingSlots(entries);
  if (DIMENSION_SLOTS.some(slot => slots[slot] !== null)) {
    for (const slot of DIMENSION_SLOTS) {
      const ref = slots[slot];
      if (ref === null) continue;
      const entry = entries.find(item => item.key === ref.key);
      if (!entry.usable || entry.width === null) {
        throw new Error(`Embedding '${ref.key}' ${entry.reason}.`);
      }
      if (entry.width !== slotDimension(slot)) {
        throw new Error(
          `Embedding '${ref.key}' must have exactly ${slotDimension(slot)} columns; got ${entry.width}.`
        );
      }
    }
    return { slots, guessed: [], rejected: [] };
  }
  const failures = new Map();
  const checked = new Map();
  // Each round either settles every guessed slot or records one more failed
  // key, so the loop ends within one round per candidate.
  for (;;) {
    const guess = bestGuessEmbeddingSlots(entries, {
      loadCheck: key => (failures.has(key) ? failures.get(key) : null),
    });
    let failed = false;
    // The guessed slots load together, not one after another.
    await Promise.all(DIMENSION_SLOTS.map(async slot => {
      const ref = guess.slots[slot];
      if (ref === null) return;
      const checkKey = JSON.stringify([ref.key, ref.columns]);
      if (!checked.has(checkKey)) checked.set(checkKey, loadCheck(ref.key, [...ref.columns]));
      await checked.get(checkKey);
    }));
    for (const slot of DIMENSION_SLOTS) {
      const ref = guess.slots[slot];
      if (ref === null) continue;
      const defect = await checked.get(JSON.stringify([ref.key, ref.columns]));
      if (defect !== null) {
        failures.set(ref.key, defect);
        failed = true;
        break;
      }
    }
    if (!failed) {
      return {
        slots: guess.slots,
        guessed: [...guess.guessed],
        rejected: [...guess.rejected],
      };
    }
  }
}


/**
 * The dimension slot a file opens on: of the filled slots, the one whose
 * array's name ranks best (`bestGuessTier`), the higher dimension among
 * equals.
 *
 * Filling a slot only makes a dimension available; which one a view starts
 * in is this rule. "The highest filled slot" opened a segmentation export on
 * a 3-column t-SNE or spatial array (the best guess fills 3D with the best
 * 3-column array, whatever it is) instead of the UMAP it carries in 2D. A
 * file whose slots are all one UMAP (`X_umap_1d` .. `X_umap_3d`, or launch
 * defaults naming UMAPs) still opens in its highest dimension.
 *
 * @param {Partial<Record<'1d'|'2d'|'3d', {key: string}|null>>} slots
 * @returns {'1d'|'2d'|'3d'}
 */
export function openingSlot(slots) {
  let opening = null;
  let openingTier = Infinity;
  // Ascending, so a later (higher) slot of an equal tier replaces an earlier one.
  for (const slot of DIMENSION_SLOTS) {
    const ref = slots[slot] ?? null;
    if (ref === null) continue;
    const tier = bestGuessTier(ref.key);
    if (tier <= openingTier) {
      opening = slot;
      openingTier = tier;
    }
  }
  if (opening === null) {
    throw new RangeError('A file opens on a filled embedding slot; none is filled.');
  }
  return opening;
}

/**
 * Validate the columns one `obsm` read selects: distinct integers, each
 * a column of an array `width` columns wide.
 *
 * @param {unknown} columns
 * @param {number} width
 * @param {string} label
 * @returns {number[]}
 */
export function requireObsmColumnSelection(columns, width, label) {
  if (
    !Array.isArray(columns) ||
    columns.length < 1 ||
    columns.some(column => !Number.isSafeInteger(column) || column < 0 || column >= width) ||
    new Set(columns).size !== columns.length
  ) {
    throw new RangeError(
      `${label} reads distinct columns between 0 and ${width - 1}.`
    );
  }
  return [...columns];
}
