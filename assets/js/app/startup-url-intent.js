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

function requireJupyterConfigEvidence(value) {
  if (value === null) return false;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'serverUrl') ||
    !Object.hasOwn(value, 'viewerId') ||
    !Object.hasOwn(value, 'viewerToken')
  ) {
    throw new TypeError(
      'Startup Jupyter evidence must be null or one exact configuration.'
    );
  }
  for (const key of ['serverUrl', 'viewerId', 'viewerToken']) {
    if (
      typeof value[key] !== 'string' ||
      value[key].length === 0 ||
      value[key] !== value[key].trim() ||
      /\s/.test(value[key])
    ) {
      throw new TypeError(
        `Startup Jupyter evidence ${key} must be exact non-whitespace text.`
      );
    }
  }
  return true;
}

/**
 * Resolve the exact startup data-source intent before any onboarding can paint.
 *
 * The Jupyter data source remains the sole owner of its authenticated URL
 * parser. Its validated configuration is passed here as evidence rather than
 * reinterpreting query keys heuristically.
 *
 * @param {URLSearchParams} searchParams
 * @param {Object|null} jupyterConfig
 * @returns {{
 *   remoteUrlParam: string|null,
 *   githubPathParam: string|null,
 *   sourceParam: string|null,
 *   requestedDataset: string|null,
 *   isAnndataMode: boolean,
 *   inJupyter: boolean,
 *   shouldShowWelcome: boolean
 * }}
 */
export function resolveStartupUrlIntent(searchParams, jupyterConfig) {
  const params = requireSearchParams(searchParams);
  const remoteUrlParam = readOptionalExactUrlParameter(params, 'remote');
  const githubPathParam = readOptionalExactUrlParameter(params, 'github');
  const sourceParam = readOptionalExactUrlParameter(params, 'source');
  const requestedDataset = readOptionalExactUrlParameter(params, 'dataset');
  const isAnndataMode = readExactTrueUrlFlag(params, 'anndata');
  const inJupyter = requireJupyterConfigEvidence(jupyterConfig);

  if (remoteUrlParam !== null && githubPathParam !== null) {
    throw new Error(
      'Startup cannot request both remote and GitHub dataset sources.'
    );
  }
  if (
    remoteUrlParam !== null &&
    sourceParam !== null &&
    sourceParam !== 'remote'
  ) {
    throw new Error(
      'The "remote" startup parameter requires source="remote".'
    );
  }
  if (
    githubPathParam !== null &&
    sourceParam !== null &&
    sourceParam !== 'github-repo'
  ) {
    throw new Error(
      'The "github" startup parameter requires source="github-repo".'
    );
  }
  if (
    isAnndataMode &&
    remoteUrlParam === null &&
    sourceParam !== null &&
    sourceParam !== 'remote'
  ) {
    throw new Error(
      'The "anndata" startup parameter requires a remote server source.'
    );
  }
  if (
    inJupyter &&
    (
      remoteUrlParam !== null ||
      githubPathParam !== null ||
      (sourceParam !== null && sourceParam !== 'jupyter')
    )
  ) {
    throw new Error(
      'Jupyter startup cannot be combined with another explicit source.'
    );
  }

  const shouldShowWelcome = !(
    inJupyter ||
    remoteUrlParam !== null ||
    githubPathParam !== null ||
    sourceParam === 'remote' ||
    isAnndataMode
  );

  return Object.freeze({
    remoteUrlParam,
    githubPathParam,
    sourceParam,
    requestedDataset,
    isAnndataMode,
    inJupyter,
    shouldShowWelcome
  });
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
function requireIntentDatasetIds(datasets, sourceLabel) {
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
  return { ids, seen };
}

export function selectIntentDatasetId(
  datasets,
  requestedDatasetId,
  sourceLabel
) {
  const { ids, seen } = requireIntentDatasetIds(datasets, sourceLabel);

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

/**
 * Resolve a connected same-origin server selection. A unique dataset can be
 * adopted automatically; a valid multi-dataset inventory remains connected
 * but requires explicit selector input.
 *
 * @param {unknown} datasets
 * @param {string|null} requestedDatasetId
 * @param {string} sourceLabel
 * @returns {string|null}
 */
export function selectConnectedDatasetId(
  datasets,
  requestedDatasetId,
  sourceLabel
) {
  const { ids, seen } = requireIntentDatasetIds(datasets, sourceLabel);
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
  return ids.length === 1 ? ids[0] : null;
}
