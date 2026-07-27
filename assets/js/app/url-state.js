/**
 * URL State Management for Cellucid
 *
 * Keeps browser URL in sync with active data source.
 * Uses history.replaceState() for smooth updates without reload.
 *
 * URL Format:
 * - ?dataset=suo                    → Demo dataset
 * - ?remote=http://localhost:8765&dataset=served
 *                                   → Remote server dataset
 * - ?github=owner/repo/path&dataset=atlas
 *                                   → GitHub repository dataset
 * - ?annotations=owner/repo[@branch]→ Community annotation repo (votes/suggestions)
 * - (no params)                     → Local file or empty state
 */

import { validateDatasetId } from '../data/data-source.js';
import { validateRemoteServerUrl } from '../data/remote-source.js';

let latestPublicationGeneration = 0;

/**
 * Update browser URL to reflect current data source.
 * Uses replaceState (no history entry, no reload).
 *
 * @param {'local-demo'|'remote'|'github-repo'|'local-user'|'jupyter'|null} sourceType
 * @param {Object} sourceInfo - Exact source-specific record:
 *   - local-demo: { datasetId }
 *   - remote: { serverUrl, datasetId }
 *   - github-repo: { path, datasetId }
 *   - local-user/jupyter/null: {}
 */
export function updateUrlForDataSource(sourceType, sourceInfo) {
  return prepareUrlForDataSource(sourceType, sourceInfo).commit();
}

/**
 * Prepare URL publication from the exact source instance whose dataset is
 * being staged. A not-yet-registered Remote/GitHub connection candidate can
 * therefore publish one atomic source+dataset URL only if its runtime also
 * succeeds.
 *
 * @param {{
 *   datasetId: string,
 *   source: Object,
 *   sourceType: 'local-demo'|'remote'|'github-repo'|'local-user'|'jupyter'
 * }} selection
 * @returns {Readonly<{commit: () => string, rollback: () => string}>}
 */
export function prepareUrlForDatasetSelection(selection) {
  const record = requirePlainDataRecord(
    selection,
    ['datasetId', 'source', 'sourceType'],
    'Dataset selection URL state'
  );
  validateDatasetId(
    record.datasetId,
    'Dataset selection URL state datasetId'
  );
  if (
    record.source === null ||
    typeof record.source !== 'object' ||
    typeof record.source.getType !== 'function' ||
    record.source.getType() !== record.sourceType
  ) {
    throw new TypeError(
      'Dataset selection URL source must own the exact sourceType.'
    );
  }
  if (record.sourceType === 'local-demo') {
    return prepareUrlForDataSource('local-demo', {
      datasetId: record.datasetId
    });
  }
  if (record.sourceType === 'remote') {
    if (typeof record.source.getConnectionInfo !== 'function') {
      throw new TypeError(
        'Remote dataset URL source must implement getConnectionInfo().'
      );
    }
    const connection = record.source.getConnectionInfo();
    if (connection === null || typeof connection !== 'object') {
      throw new TypeError(
        'Remote dataset URL source must publish connection information.'
      );
    }
    return prepareUrlForDataSource('remote', {
      datasetId: record.datasetId,
      serverUrl: connection.url
    });
  }
  if (record.sourceType === 'github-repo') {
    if (typeof record.source.getConnectionInfo !== 'function') {
      throw new TypeError(
        'GitHub dataset URL source must implement getConnectionInfo().'
      );
    }
    const connection = record.source.getConnectionInfo();
    if (connection === null || typeof connection !== 'object') {
      throw new TypeError(
        'GitHub dataset URL source must publish connection information.'
      );
    }
    return prepareUrlForDataSource('github-repo', {
      datasetId: record.datasetId,
      path: connection.inputPath
    });
  }
  if (
    record.sourceType === 'local-user' ||
    record.sourceType === 'jupyter'
  ) {
    return prepareUrlForDataSource(record.sourceType, {});
  }
  throw new RangeError(
    'Dataset selection URL source has an unknown sourceType.'
  );
}

/**
 * Validate one complete URL-state publication before dataset I/O begins.
 * The returned owner commits all data-source parameters in one replaceState
 * call and can restore the exact prior URL if final dataset publication stops.
 *
 * @param {'local-demo'|'remote'|'github-repo'|'local-user'|'jupyter'|null} sourceType
 * @param {Object} sourceInfo
 * @returns {Readonly<{
 *   commit: () => string,
 *   rollback: () => string
 * }>}
 */
export function prepareUrlForDataSource(sourceType, sourceInfo) {
  const sourceState = requireUrlSourceState(sourceType, sourceInfo);
  const browser = requireBrowserHistoryOwner();
  let publicationState = 'prepared';
  let publicationGeneration = null;
  let priorHref = null;
  let publishedHref = null;

  return Object.freeze({
    commit() {
      if (publicationState !== 'prepared') {
        throw new Error('URL data-source publication was already committed.');
      }
      if (globalThis.window !== browser) {
        throw new Error(
          'URL data-source publication browser owner changed before commit.'
        );
      }
      const nextUrl = new URL(browser.location.href);
      for (const name of ['dataset', 'source', 'remote', 'github']) {
        nextUrl.searchParams.delete(name);
      }
      for (const [name, value] of sourceState.entries) {
        nextUrl.searchParams.set(name, value);
      }

      const ownedPriorHref = browser.location.href;
      const nextHref = nextUrl.toString();
      browser.history.replaceState(null, '', nextHref);
      priorHref = ownedPriorHref;
      publishedHref = nextHref;
      publicationGeneration = ++latestPublicationGeneration;
      publicationState = 'committed';
      return nextHref;
    },
    rollback() {
      if (publicationState === 'prepared') {
        throw new Error(
          'URL data-source publication cannot be restored before commit.'
        );
      }
      if (publicationState === 'restored') {
        throw new Error(
          'URL data-source publication was already restored.'
        );
      }
      if (globalThis.window !== browser) {
        throw new Error(
          'URL data-source publication browser owner changed before restore.'
        );
      }
      if (publicationGeneration !== latestPublicationGeneration) {
        throw new Error(
          'URL data-source publication was superseded by a newer generation.'
        );
      }
      if (browser.location.href !== publishedHref) {
        throw new Error(
          'URL changed after data-source publication and cannot be restored atomically.'
        );
      }
      browser.history.replaceState(null, '', priorHref);
      latestPublicationGeneration++;
      publicationState = 'restored';
      return priorHref;
    }
  });
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

function requireUrlSourceState(sourceType, sourceInfo) {
  if (sourceType === null) {
    requirePlainDataRecord(sourceInfo, [], 'Empty dataset URL state');
    return { entries: [] };
  }
  if (sourceType === 'local-demo') {
    const record = requirePlainDataRecord(
      sourceInfo,
      ['datasetId'],
      'Local demo URL state'
    );
    return {
      entries: [[
        'dataset',
        validateDatasetId(
          record.datasetId,
          'Local demo URL state datasetId'
        )
      ]]
    };
  }
  if (sourceType === 'remote') {
    const record = requirePlainDataRecord(
      sourceInfo,
      ['datasetId', 'serverUrl'],
      'Remote URL state'
    );
    return {
      entries: [
        ['remote', validateRemoteServerUrl(record.serverUrl)],
        [
          'dataset',
          validateDatasetId(
            record.datasetId,
            'Remote URL state datasetId'
          )
        ]
      ]
    };
  }
  if (sourceType === 'github-repo') {
    const record = requirePlainDataRecord(
      sourceInfo,
      ['datasetId', 'path'],
      'GitHub URL state'
    );
    return {
      entries: [
        [
          'github',
          requireExactString(record.path, 'GitHub URL state path')
        ],
        [
          'dataset',
          validateDatasetId(
            record.datasetId,
            'GitHub URL state datasetId'
          )
        ]
      ]
    };
  }
  if (URL_FREE_SOURCE_TYPES.has(sourceType)) {
    requirePlainDataRecord(
      sourceInfo,
      [],
      `${sourceType} URL state`
    );
    return { entries: [] };
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
