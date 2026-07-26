const UINT32_CELL_CAPACITY = 0x1_0000_0000;
const UINT16_CELL_CAPACITY = 0x1_0000;
const MAX_CONNECTIVITY_WORKING_BYTES = 512 * 1024 * 1024;
const UINT16_STORAGE = Object.freeze({
  dtype: 'uint16',
  bytes: Uint16Array.BYTES_PER_ELEMENT,
});
const UINT32_STORAGE = Object.freeze({
  dtype: 'uint32',
  bytes: Uint32Array.BYTES_PER_ELEMENT,
});

export const CONNECTIVITY_MANIFEST_CONTEXT = Object.freeze({
  FILE: 'file',
  DIRECT: 'direct',
});

const COMMON_KEYS = Object.freeze([
  'format',
  'n_cells',
  'n_edges',
  'max_neighbors',
  'index_bytes',
  'index_dtype',
]);

const FILE_KEYS = Object.freeze([
  ...COMMON_KEYS,
  'sourcesPath',
  'destinationsPath',
  'weightsPath',
  'weight_bytes',
  'weight_dtype',
  'compression',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`Invalid ${label}: expected an object`);
  }

  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter(key => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter(key => !expected.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`missing ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
      details.push(`unexpected ${unexpected.join(', ')}`);
    }
    throw new Error(
      `Invalid ${label}: exact properties required (${details.join('; ')})`
    );
  }
}

function validateGraphSummary(manifest, label) {
  if (manifest.format !== 'edge_pairs') {
    throw new Error(
      `Invalid ${label}: format must be exactly "edge_pairs"`
    );
  }
  if (
    !Number.isSafeInteger(manifest.n_cells) ||
    manifest.n_cells <= 0 ||
    manifest.n_cells > UINT32_CELL_CAPACITY
  ) {
    throw new Error(
      `Invalid ${label}: n_cells must be a positive safe integer within the uint32 cell axis`
    );
  }
  if (!Number.isSafeInteger(manifest.n_edges) || manifest.n_edges < 0) {
    throw new Error(
      `Invalid ${label}: n_edges must be a non-negative safe integer`
    );
  }

  const maximumEdges =
    BigInt(manifest.n_cells) * BigInt(manifest.n_cells - 1) / 2n;
  if (BigInt(manifest.n_edges) > maximumEdges) {
    throw new Error(
      `Invalid ${label}: n_edges exceeds the unique undirected cell-pair bound`
    );
  }

  const maximumNeighbors = Math.min(
    manifest.n_cells - 1,
    manifest.n_edges
  );
  if (
    !Number.isSafeInteger(manifest.max_neighbors) ||
    manifest.max_neighbors < 0 ||
    manifest.max_neighbors > maximumNeighbors ||
    (
      (manifest.n_edges === 0) !==
      (manifest.max_neighbors === 0)
    )
  ) {
    throw new Error(
      `Invalid ${label}: max_neighbors is inconsistent with the cell and edge bounds`
    );
  }
}

/**
 * Return the exact smallest prepared-file cell-index storage.
 * A uint16 value can address 65,536 cells because the cell ids are
 * zero-based and therefore range from 0 through 65,535.
 *
 * @param {number} nCells
 * @returns {{dtype: 'uint16'|'uint32', bytes: 2|4}}
 */
export function getConnectivityIndexStorage(nCells) {
  if (
    !Number.isSafeInteger(nCells) ||
    nCells <= 0 ||
    nCells > UINT32_CELL_CAPACITY
  ) {
    throw new Error(
      'Connectivity n_cells must fit the positive uint32 cell axis'
    );
  }
  return nCells <= UINT16_CELL_CAPACITY
    ? UINT16_STORAGE
    : UINT32_STORAGE;
}

function validateFilePath(path, fieldName, label) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('%') ||
    path.includes('?') ||
    path.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
    path.split('/').some(
      component =>
        component === '' ||
        component === '.' ||
        component === '..'
    )
  ) {
    throw new Error(
      `Invalid ${label}: ${fieldName} must be a safe relative POSIX path`
    );
  }
  return path;
}

function validateFileTransport(manifest, label) {
  const {
    dtype: expectedDtype,
    bytes: expectedWidth,
  } = getConnectivityIndexStorage(manifest.n_cells);
  if (
    manifest.index_dtype !== expectedDtype ||
    manifest.index_bytes !== expectedWidth
  ) {
    throw new Error(
      `Invalid ${label}: index_dtype and index_bytes must use the ` +
      `smallest exact unsigned cell-index width (${expectedDtype}/${expectedWidth})`
    );
  }
  if (
    manifest.weight_dtype !== 'float64' ||
    manifest.weight_bytes !== Float64Array.BYTES_PER_ELEMENT
  ) {
    throw new Error(
      `Invalid ${label}: weight_dtype and weight_bytes must use exact ` +
      'float64/8-byte edge weights'
    );
  }

  if (
    manifest.compression !== null &&
    (
      !Number.isSafeInteger(manifest.compression) ||
      manifest.compression < 1 ||
      manifest.compression > 9
    )
  ) {
    throw new Error(
      `Invalid ${label}: compression must be null or an integer from 1 through 9`
    );
  }

  const sourcesPath = validateFilePath(
    manifest.sourcesPath,
    'sourcesPath',
    label
  );
  const destinationsPath = validateFilePath(
    manifest.destinationsPath,
    'destinationsPath',
    label
  );
  const weightsPath = validateFilePath(
    manifest.weightsPath,
    'weightsPath',
    label
  );
  if (
    new Set([sourcesPath, destinationsPath, weightsPath]).size !== 3
  ) {
    throw new Error(
      `Invalid ${label}: source, destination, and weight paths must differ`
    );
  }

  const expectsGzip = manifest.compression !== null;
  for (const [fieldName, path] of [
    ['sourcesPath', sourcesPath],
    ['destinationsPath', destinationsPath],
    ['weightsPath', weightsPath],
  ]) {
    if (path.endsWith('.gz') !== expectsGzip) {
      throw new Error(
        `Invalid ${label}: ${fieldName} must ` +
        `${expectsGzip ? '' : 'not '}end in .gz to match compression`
      );
    }
  }
}

function validateDirectTransport(manifest, label) {
  if (
    manifest.index_dtype !== 'uint32' ||
    manifest.index_bytes !== Uint32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error(
      `Invalid ${label}: direct edges require exact uint32/4-byte indices`
    );
  }
}

function validateConnectivityWorkingSet(manifest, context, label) {
  const edgeBytes =
    BigInt(manifest.n_edges) * BigInt(Uint32Array.BYTES_PER_ELEMENT);
  const canonicalWeightBytes =
    BigInt(manifest.n_edges) * BigInt(Float64Array.BYTES_PER_ELEMENT);
  const gpuWeightStagingBytes =
    BigInt(manifest.n_edges) * BigInt(Float32Array.BYTES_PER_ELEMENT);
  const degreeBytes =
    BigInt(manifest.n_cells) * BigInt(Uint32Array.BYTES_PER_ELEMENT);
  // Canonical arrays remain transport/adapter-owned. Rendering receives one
  // synchronized topology/weight copy so visualization-only shuffling cannot
  // mutate them, then stages one topology pack and normalized Float32 weights
  // for the GPU.
  const canonicalEdgeBytes = edgeBytes * 2n;
  const renderOwnedEdgeBytes = edgeBytes * 2n;
  const renderOwnedWeightBytes = canonicalWeightBytes;
  const gpuTopologyStagingBytes = edgeBytes * 2n;
  const rawFileBytes =
    context === CONNECTIVITY_MANIFEST_CONTEXT.FILE &&
    manifest.index_bytes !== Uint32Array.BYTES_PER_ELEMENT
      ? BigInt(manifest.n_edges) * BigInt(manifest.index_bytes) * 2n
      : 0n;
  const workingBytes =
    canonicalEdgeBytes +
    canonicalWeightBytes +
    renderOwnedEdgeBytes +
    renderOwnedWeightBytes +
    gpuTopologyStagingBytes +
    gpuWeightStagingBytes +
    rawFileBytes +
    degreeBytes;
  if (workingBytes > BigInt(MAX_CONNECTIVITY_WORKING_BYTES)) {
    throw new Error(
      `Invalid ${label}: edge validation requires more than the ` +
      `${MAX_CONNECTIVITY_WORKING_BYTES}-byte browser working-set limit`
    );
  }
}

/**
 * Validate one connectivity manifest against the transport selected by its
 * explicit URL context. Only a direct source may represent absence as null.
 *
 * @param {unknown} manifest
 * @param {'file'|'direct'} context
 * @returns {Object|null}
 */
export function validateConnectivityManifest(manifest, context) {
  if (
    context !== CONNECTIVITY_MANIFEST_CONTEXT.FILE &&
    context !== CONNECTIVITY_MANIFEST_CONTEXT.DIRECT
  ) {
    throw new TypeError(
      `Connectivity manifest context must be exactly "file" or "direct"; received ${String(context)}`
    );
  }

  const label = `${context} connectivity manifest`;
  if (
    context === CONNECTIVITY_MANIFEST_CONTEXT.DIRECT &&
    manifest === null
  ) {
    return null;
  }

  const expectedKeys =
    context === CONNECTIVITY_MANIFEST_CONTEXT.DIRECT
      ? COMMON_KEYS
      : FILE_KEYS;
  requireExactKeys(manifest, expectedKeys, label);
  validateGraphSummary(manifest, label);

  if (context === CONNECTIVITY_MANIFEST_CONTEXT.DIRECT) {
    validateDirectTransport(manifest, label);
  } else {
    validateFileTransport(manifest, label);
  }
  validateConnectivityWorkingSet(manifest, context, label);
  return manifest;
}

/**
 * Validate normalized connectivity data before it reaches rendering or KNN
 * consumers. This owns the exact cell alignment, ordering, uniqueness, and
 * max-degree agreement shared by direct and prepared transports.
 *
 * @param {unknown} edgeData
 * @param {Object} manifest
 * @returns {Object}
 */
export function validateConnectivityEdgeData(edgeData, manifest) {
  if (!isPlainObject(edgeData)) {
    throw new TypeError(
      'Invalid connectivity edge payload: expected an object'
    );
  }
  requireExactKeys(
    edgeData,
    [
      'sources',
      'destinations',
      'weights',
      'nCells',
      'nEdges',
      'maxNeighbors',
    ],
    'connectivity edge payload'
  );
  if (
    !(edgeData.sources instanceof Uint32Array) ||
    !(edgeData.destinations instanceof Uint32Array) ||
    !(edgeData.weights instanceof Float64Array)
  ) {
    throw new TypeError(
      'Invalid connectivity edge payload: endpoints must be Uint32Array values and weights must be a Float64Array'
    );
  }
  if (
    edgeData.nCells !== manifest.n_cells ||
    edgeData.nEdges !== manifest.n_edges ||
    edgeData.maxNeighbors !== manifest.max_neighbors
  ) {
    throw new Error(
      'Invalid connectivity edge payload: summaries must exactly match the manifest'
    );
  }
  if (
    edgeData.sources.length !== manifest.n_edges ||
    edgeData.destinations.length !== manifest.n_edges ||
    edgeData.weights.length !== manifest.n_edges
  ) {
    throw new Error(
      'Invalid connectivity edge payload: array lengths must exactly equal n_edges'
    );
  }

  const degrees = new Uint32Array(manifest.n_cells);
  let actualMaxNeighbors = 0;
  let previousSource = -1;
  let previousDestination = -1;
  for (let index = 0; index < manifest.n_edges; index++) {
    const source = edgeData.sources[index];
    const destination = edgeData.destinations[index];
    const weight = edgeData.weights[index];
    if (
      source >= manifest.n_cells ||
      destination >= manifest.n_cells
    ) {
      throw new Error(
        `Invalid connectivity edge payload: edge ${index} is outside the cell bounds`
      );
    }
    if (source >= destination) {
      throw new Error(
        `Invalid connectivity edge payload: edge ${index} must satisfy source < destination`
      );
    }
    if (!Number.isFinite(weight) || !(weight > 0)) {
      throw new Error(
        `Invalid connectivity edge payload: weight ${index} must be finite and strictly positive`
      );
    }
    if (
      index > 0 &&
      (
        source < previousSource ||
        (
          source === previousSource &&
          destination <= previousDestination
        )
      )
    ) {
      throw new Error(
        'Invalid connectivity edge payload: edges must be unique and ' +
        'strictly ordered by source, then destination'
      );
    }
    previousSource = source;
    previousDestination = destination;
    const sourceDegree = ++degrees[source];
    const destinationDegree = ++degrees[destination];
    actualMaxNeighbors = Math.max(
      actualMaxNeighbors,
      sourceDegree,
      destinationDegree
    );
  }
  if (actualMaxNeighbors !== manifest.max_neighbors) {
    throw new Error(
      `Invalid connectivity edge payload: max degree ${actualMaxNeighbors} ` +
      `does not match max_neighbors ${manifest.max_neighbors}`
    );
  }
  return edgeData;
}
