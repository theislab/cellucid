/**
 * @fileoverview Exact launch-parameter ownership for application startup.
 *
 * Explicit source parameters are commands, not hints. This module refuses
 * duplicate, empty, ambiguous, or missing selections before any source can
 * be replaced by another one. A refusal is the link's, said to the person
 * (`refusedLaunchLink`): Cellucid starts without the link and its opening
 * card names what is wrong with it, Open without this link first (R9E-1:
 * such a link stopped Cellucid on "Something went wrong while starting").
 */

import { formatCountOf } from '../utils/format-units.js';
import { DataSourceErrorCode, explainedFailure } from '../data/data-source.js';
import { SUBSAMPLE_URL_PARAMETERS } from './subsample-url.js';
import { lowerFirst } from '../utils/text-case.js';

/**
 * Every parameter a launch link names its data with; Open without this link
 * drops them all when the link itself is refused.
 */
export const LAUNCH_LINK_PARAMETERS = Object.freeze([
  'remote', 'data', 'source', 'dataset', 'anndata', 'viewer', 'viewerId', 'viewerToken', ...SUBSAMPLE_URL_PARAMETERS,
]);

/** The `source` values a link may name. */
const LINK_SOURCES = Object.freeze(['local-demo', 'remote']);

/**
 * A launch link Cellucid cannot read, said for the person: settled (opening
 * it again meets the same refusal), so Open without this link leads.
 *
 * @param {string} sentence
 * @param {unknown} [cause] - What refused it (under Details)
 * @returns {Error}
 */
export function refusedLaunchLink(sentence, cause = undefined) {
  return explainedFailure(sentence, DataSourceErrorCode.VALIDATION_ERROR, 'link', {
    launchLink: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Whether `error` is a launch link's refusal (`refusedLaunchLink`). */
export function isRefusedLaunchLink(error) {
  return error?.details?.launchLink === true;
}

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
    throw refusedLaunchLink(
      `This link names "${exactName}" ${formatCountOf(values.length, 'time')}; a link names it once.`
    );
  }
  const value = values[0];
  if (typeof value !== 'string' || value.length === 0) {
    throw refusedLaunchLink(`This link's "${exactName}" has no value.`);
  }
  if (value !== value.trim()) {
    throw refusedLaunchLink(
      `This link's "${exactName}" has spaces around its value ("${value}"); remove them.`
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
    throw refusedLaunchLink(`This link's "${name}" is "${value}"; it can only be "true".`);
  }
  return true;
}

function requireViewerHostConfigEvidence(value) {
  if (value === null) return false;
  // A notebook widget's viewer (`EMBEDDED_VIEWER_HOST`): its credentials
  // arrive from the widget, not in the address.
  if (
    typeof value === 'object' &&
    Object.isFrozen(value) &&
    Object.keys(value).length === 1 &&
    value.embedded === true
  ) {
    return true;
  }
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
      'Startup viewer host evidence must be null or one exact configuration.'
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
        `Startup viewer host evidence ${key} must be exact non-whitespace text.`
      );
    }
  }
  return true;
}

/**
 * Resolve the exact startup data-source intent before any onboarding can paint.
 *
 * The viewer host data source remains the sole owner of its authenticated URL
 * parser. Its validated configuration is passed here as evidence rather than
 * reinterpreting query keys heuristically.
 *
 * @param {URLSearchParams} searchParams
 * @param {Object|null} viewerHostConfig
 * @returns {{
 *   remoteUrlParam: string|null,
 *   dataLinkParam: string|null,
 *   sourceParam: string|null,
 *   requestedDataset: string|null,
 *   isAnndataMode: boolean,
 *   inViewerHost: boolean,
 *   shouldShowWelcome: boolean
 * }}
 */
export function resolveStartupUrlIntent(searchParams, viewerHostConfig) {
  const params = requireSearchParams(searchParams);
  const remoteUrlParam = readOptionalExactUrlParameter(params, 'remote');
  const dataLinkParam = readOptionalExactUrlParameter(params, 'data');
  const sourceParam = readOptionalExactUrlParameter(params, 'source');
  const requestedDataset = readOptionalExactUrlParameter(params, 'dataset');
  const isAnndataMode = readExactTrueUrlFlag(params, 'anndata');
  const inViewerHost = requireViewerHostConfigEvidence(viewerHostConfig);

  if (remoteUrlParam !== null && dataLinkParam !== null) {
    throw refusedLaunchLink(
      'This link names both a Cellucid server ("remote") and data ("data"); a link opens one of them.'
    );
  }
  if (
    inViewerHost &&
    (
      remoteUrlParam !== null ||
      dataLinkParam !== null ||
      (sourceParam !== null && sourceParam !== 'jupyter')
    )
  ) {
    throw refusedLaunchLink(
      'This link is the address of a viewer that Python or R opened, and it names other data too ' +
      '("remote", "data" or "source"); open the address the program printed.'
    );
  }
  if (
    remoteUrlParam !== null &&
    sourceParam !== null &&
    sourceParam !== 'remote'
  ) {
    throw refusedLaunchLink(
      `This link names a Cellucid server ("remote") but its "source" is "${sourceParam}"; remove "source".`
    );
  }
  if (
    dataLinkParam !== null &&
    sourceParam !== null
  ) {
    throw refusedLaunchLink(
      'This link\'s "data" names where its data is; remove "source".'
    );
  }
  // The pair's own refusal first (data names its own source), then an
  // unknown source alone.
  if (
    isAnndataMode &&
    remoteUrlParam === null &&
    sourceParam !== null &&
    sourceParam !== 'remote'
  ) {
    throw refusedLaunchLink(
      `This link's "anndata=true" names a Cellucid server, but its "source" is "${sourceParam}"; remove "source".`
    );
  }
  if (!inViewerHost && sourceParam !== null && !LINK_SOURCES.includes(sourceParam)) {
    throw refusedLaunchLink(
      `This link's "source" is "${sourceParam}"; a link's source is "local-demo" (a sample dataset) ` +
      'or "remote" (a Cellucid server).'
    );
  }

  const shouldShowWelcome = !(
    inViewerHost ||
    remoteUrlParam !== null ||
    dataLinkParam !== null ||
    sourceParam === 'remote' ||
    isAnndataMode
  );

  return Object.freeze({
    remoteUrlParam,
    dataLinkParam,
    sourceParam,
    requestedDataset,
    isAnndataMode,
    inViewerHost,
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

  if (payload.status === 'ok' && payload.type === 'anndata') {
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
/** `"a", "b" and "c"`, the first few of `ids` and how many more. */
function idList(ids) {
  const shown = ids.slice(0, 6).map(id => `"${id}"`);
  const more = ids.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${formatCountOf(more, 'more')}`;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** `sourceLabel` inside a sentence ("The server this link names" → "the server …"). */
function placeOf(sourceLabel) {
  return lowerFirst(sourceLabel);
}

/** The link names a dataset its source does not hold: the link's refusal. */
function missingDatasetRefusal(requestedDatasetId, ids, sourceLabel) {
  return refusedLaunchLink(
    `This link names the dataset "${requestedDatasetId}", which ${placeOf(sourceLabel)} does not hold; ` +
    `it holds ${idList(ids)}.`
  );
}

function requireIntentDatasetIds(datasets, sourceLabel) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw refusedLaunchLink(`${sourceLabel} holds no dataset.`);
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
      throw missingDatasetRefusal(requestedDatasetId, ids, sourceLabel);
    }
    return requestedDatasetId;
  }

  if (ids.length !== 1) {
    throw refusedLaunchLink(
      `${sourceLabel} holds ${formatCountOf(ids.length, 'dataset')} (${idList(ids)}), and this link ` +
      'does not say which to open: add "dataset=" with one of them.'
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
      throw missingDatasetRefusal(requestedDatasetId, ids, sourceLabel);
    }
    return requestedDatasetId;
  }
  return ids.length === 1 ? ids[0] : null;
}
