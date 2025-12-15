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
 * - (no params)                     → Local file or empty state
 */

/**
 * Update browser URL to reflect current data source.
 * Uses replaceState (no history entry, no reload).
 *
 * @param {string|null} sourceType - 'local-demo', 'remote', 'github-repo', 'local-user', or null
 * @param {Object} sourceInfo - Source-specific info:
 *   - local-demo: { datasetId }
 *   - remote: { serverUrl }
 *   - github-repo: { path }
 *   - local-user/null: {} (clears URL)
 */
export function updateUrlForDataSource(sourceType, sourceInfo = {}) {
  const url = new URL(window.location.href);

  // Clear all data-related params first
  url.searchParams.delete('dataset');
  url.searchParams.delete('source');
  url.searchParams.delete('remote');
  url.searchParams.delete('github');

  // Set new params based on source type
  if (sourceType === 'local-demo' && sourceInfo.datasetId) {
    url.searchParams.set('dataset', sourceInfo.datasetId);
  } else if (sourceType === 'remote' && sourceInfo.serverUrl) {
    url.searchParams.set('remote', sourceInfo.serverUrl);
  } else if (sourceType === 'github-repo' && sourceInfo.path) {
    url.searchParams.set('github', sourceInfo.path);
  }
  // For local-user, h5ad, zarr, or null: leave URL clean (no params)

  history.replaceState(null, '', url.toString());
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
