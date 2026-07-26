/**
 * @fileoverview Exact launch-parameter ownership for application startup.
 *
 * Explicit source parameters are commands, not hints. This module rejects
 * duplicate, empty, ambiguous, or missing selections before any source can
 * be replaced by another one.
 */

function requireSearchParams(searchParams) {
  if (!(searchParams instanceof URLSearchParams)) {
    throw new TypeError(
      'Startup URL intent requires an exact URLSearchParams owner.'
    );
  }
  return searchParams;
}

function requireParameterName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name !== name.trim()
  ) {
    throw new TypeError(
      'Startup URL parameter name must be a non-empty trimmed string.'
    );
  }
  return name;
}

/**
 * Read zero or one exact, non-empty URL parameter.
 *
 * @param {URLSearchParams} searchParams
 * @param {string} name
 * @returns {string|null}
 */
export function readOptionalExactUrlParameter(searchParams, name) {
  const params = requireSearchParams(searchParams);
  const exactName = requireParameterName(name);
  const values = params.getAll(exactName);
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new Error(
      `Startup URL parameter "${exactName}" must occur at most once.`
    );
  }
  const value = values[0];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(
      `Startup URL parameter "${exactName}" must be one non-empty exact value.`
    );
  }
  return value;
}

/**
 * Read an optional marker whose sole current value is "true".
 *
 * @param {URLSearchParams} searchParams
 * @param {string} name
 * @returns {boolean}
 */
export function readExactTrueUrlFlag(searchParams, name) {
  const value = readOptionalExactUrlParameter(searchParams, name);
  if (value === null) return false;
  if (value !== 'true') {
    throw new Error(
      `Startup URL parameter "${name}" must be exactly "true" when present.`
    );
  }
  return true;
}

/**
 * Classify the exact same-origin health advertisement.
 *
 * The static web distribution intentionally publishes one current marker at
 * `/_cellucid/health` so startup can distinguish it from the Python server
 * without relying on an HTTP failure. Server payloads are validated in full by
 * RemoteDataSource before they are adopted.
 *
 * @param {unknown} payload
 * @returns {'static'|'server'}
 */
export function classifySameOriginHealthAdvertisement(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    throw new TypeError(
      'Same-origin Cellucid health advertisement must be a JSON object.'
    );
  }

  if (payload.status === 'static' || payload.type === 'web') {
    const expectedKeys = ['message', 'status', 'type'];
    const actualKeys = Object.keys(payload).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      payload.status !== 'static' ||
      payload.type !== 'web' ||
      payload.message !==
        'Cellucid web viewer (no same-origin Python server)'
    ) {
      throw new TypeError(
        'Static Cellucid health advertisement does not match the current contract.'
      );
    }
    return 'static';
  }

  if (
    payload.status === 'ok' &&
    (payload.type === 'exported' || payload.type === 'anndata')
  ) {
    return 'server';
  }

  throw new TypeError(
    'Same-origin Cellucid health advertisement has no current server or static identity.'
  );
}

/**
 * Select the sole dataset owned by an explicit source intent.
 *
 * @param {unknown} datasets
 * @param {string|null} requestedDatasetId
 * @param {string} sourceLabel
 * @returns {string}
 */
export function selectIntentDatasetId(
  datasets,
  requestedDatasetId,
  sourceLabel
) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error(
      `${sourceLabel} declared no datasets for the explicit startup request.`
    );
  }
  const ids = [];
  const seen = new Set();
  for (let index = 0; index < datasets.length; index += 1) {
    const dataset = datasets[index];
    if (
      dataset === null ||
      typeof dataset !== 'object' ||
      Array.isArray(dataset) ||
      typeof dataset.id !== 'string' ||
      dataset.id.length === 0 ||
      dataset.id !== dataset.id.trim() ||
      seen.has(dataset.id)
    ) {
      throw new TypeError(
        `${sourceLabel} dataset ${index} must have one unique non-empty exact id.`
      );
    }
    seen.add(dataset.id);
    ids.push(dataset.id);
  }

  if (requestedDatasetId !== null) {
    if (
      typeof requestedDatasetId !== 'string' ||
      requestedDatasetId.length === 0 ||
      requestedDatasetId !== requestedDatasetId.trim()
    ) {
      throw new TypeError(
        'Requested startup dataset id must be one non-empty exact string.'
      );
    }
    if (!seen.has(requestedDatasetId)) {
      throw new Error(
        `${sourceLabel} does not declare requested dataset ` +
        `"${requestedDatasetId}".`
      );
    }
    return requestedDatasetId;
  }

  if (ids.length !== 1) {
    throw new Error(
      `${sourceLabel} declares ${ids.length} datasets; an exact "dataset" ` +
      'startup parameter is required.'
    );
  }
  return ids[0];
}
