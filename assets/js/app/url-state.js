/**
 * URL State Management for Cellucid
 *
 * Keeps browser URL in sync with active data source.
 * Uses history.replaceState() for smooth updates without reload.
 *
 * URL Format:
 * - ?dataset=suo                    → Demo dataset
 * - ?remote=http://localhost:8765   → Remote server
 * - ?github=owner/repo/path         → GitHub repository
 * - ?annotations=owner/repo[@branch]→ Community annotation repo (votes/suggestions)
 * - (no params)                     → Local file or empty state
 */

/**
 * Update browser URL to reflect current data source.
 * Uses replaceState (no history entry, no reload).
 *
 * @param {'local-demo'|'remote'|'github-repo'|'local-user'|'jupyter'|null} sourceType
 * @param {Object} sourceInfo - Exact source-specific record:
 *   - local-demo: { datasetId }
 *   - remote: { serverUrl }
 *   - github-repo: { path }
 *   - local-user/jupyter/null: {}
 */
export function updateUrlForDataSource(sourceType, sourceInfo) {
  const sourceState = requireUrlSourceState(sourceType, sourceInfo);
  const browser = requireBrowserHistoryOwner();
  const url = new URL(browser.location.href);

  url.searchParams.delete('dataset');
  url.searchParams.delete('source');
  url.searchParams.delete('remote');
  url.searchParams.delete('github');

  if (sourceState.param !== null) {
    url.searchParams.set(sourceState.param, sourceState.value);
  }

  browser.history.replaceState(null, '', url.toString());
}

const URL_FREE_SOURCE_TYPES = new Set(['local-user', 'jupyter']);

function requirePlainDataRecord(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some(
      key => typeof key !== 'string' || !expectedKeys.includes(key)
    )
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${expectedKeys.join(', ')}.`
    );
  }

  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    }
  }

  return value;
}

function requireExactString(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be a non-empty, unpadded string.`);
  }
  return value;
}

function requireHttpServerUrl(value) {
  requireExactString(value, 'Remote URL state serverUrl');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(
      'Remote URL state serverUrl must be an absolute HTTP(S) URL.'
    );
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new TypeError(
      'Remote URL state serverUrl must be an absolute HTTP(S) URL.'
    );
  }
  return value;
}

function requireUrlSourceState(sourceType, sourceInfo) {
  if (sourceType === null) {
    requirePlainDataRecord(sourceInfo, [], 'Empty dataset URL state');
    return { param: null, value: null };
  }
  if (sourceType === 'local-demo') {
    const record = requirePlainDataRecord(
      sourceInfo,
      ['datasetId'],
      'Local demo URL state'
    );
    return {
      param: 'dataset',
      value: requireExactString(
        record.datasetId,
        'Local demo URL state datasetId'
      ),
    };
  }
  if (sourceType === 'remote') {
    const record = requirePlainDataRecord(
      sourceInfo,
      ['serverUrl'],
      'Remote URL state'
    );
    return {
      param: 'remote',
      value: requireHttpServerUrl(record.serverUrl),
    };
  }
  if (sourceType === 'github-repo') {
    const record = requirePlainDataRecord(
      sourceInfo,
      ['path'],
      'GitHub URL state'
    );
    return {
      param: 'github',
      value: requireExactString(record.path, 'GitHub URL state path'),
    };
  }
  if (URL_FREE_SOURCE_TYPES.has(sourceType)) {
    requirePlainDataRecord(
      sourceInfo,
      [],
      `${sourceType} URL state`
    );
    return { param: null, value: null };
  }
  throw new RangeError('Unknown URL data source type.');
}

function requireBrowserHistoryOwner() {
  if (
    typeof window !== 'object' ||
    window === null ||
    typeof window.location !== 'object' ||
    window.location === null ||
    typeof window.location.href !== 'string' ||
    window.location.href.length === 0 ||
    typeof window.history !== 'object' ||
    window.history === null ||
    typeof window.history.replaceState !== 'function'
  ) {
    throw new TypeError(
      'URL state requires a browser location and history owner.'
    );
  }
  return window;
}

/**
 * Parse current URL for data source info.
 *
 * @returns {{type: string, serverUrl?: string, path?: string, datasetId?: string}|null}
 *   Returns source info object or null if no data params in URL
 */
export function parseUrlDataSource() {
  const params = new URLSearchParams(window.location.search);

  if (params.has('remote')) {
    return { type: 'remote', serverUrl: params.get('remote') };
  }
  if (params.has('github')) {
    return { type: 'github-repo', path: params.get('github') };
  }
  if (params.has('dataset')) {
    return { type: 'local-demo', datasetId: params.get('dataset') };
  }

  return null;
}

/**
 * Clear all data-related URL params.
 * Convenience function for disconnect/clear operations.
 */
export function clearUrlDataSource() {
  updateUrlForDataSource(null, {});
}

/**
 * Set or clear the community annotation repo param.
 * Token is never stored in the URL.
 *
 * @param {string|null} ownerRepo - "owner/repo" or "owner/repo@branch" or null to clear
 */
export function setUrlAnnotationRepo(ownerRepo) {
  const url = new URL(window.location.href);
  const value = String(ownerRepo ?? '').trim();
  if (value) url.searchParams.set('annotations', value);
  else url.searchParams.delete('annotations');
  history.replaceState(null, '', url.toString());
}

export function getUrlAnnotationRepo() {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('annotations');
    return value ? String(value).trim() : null;
  } catch {
    return null;
  }
}
