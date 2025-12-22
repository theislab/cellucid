/**
 * @fileoverview IO helpers for state snapshots (download / load from file / load from URL).
 *
 * @module state-serializer/io
 */

import {
  beginDataLoad,
  completeDataLoadSuccess,
  completeDataLoadFailure,
  DATA_LOAD_METHODS
} from '../../analytics/tracker.js';

export function createSerializerIO({
  serialize,
  deserialize,
  validateSnapshotShape,
  buildAnalyticsContext
}) {
  function downloadState(filename = 'cellucid-state.json') {
    const snapshot = serialize();
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function loadStateFromFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';

      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) {
          resolve();
          return;
        }

        const loadToken = beginDataLoad(DATA_LOAD_METHODS.STATE_RESTORE_FILE, buildAnalyticsContext());
        try {
          const text = await file.text();
          const snapshot = JSON.parse(text);
          validateSnapshotShape(snapshot, file.name || 'uploaded file');
          await deserialize(snapshot);
          completeDataLoadSuccess(loadToken, buildAnalyticsContext());
          resolve();
        } catch (err) {
          console.error('Failed to load state:', err);
          completeDataLoadFailure(loadToken, { ...buildAnalyticsContext(), error: err });
          reject(err);
        }
      };

      // Handle cancel: resolve without error when user cancels file picker
      input.oncancel = () => {
        resolve();
      };

      input.click();
    });
  }

  /**
   * Load state from a URL (for automatic session restore).
   * @param {string} url
   * @param {string} [method]
   */
  async function loadStateFromUrl(url, method = DATA_LOAD_METHODS.STATE_RESTORE_URL) {
    if (!url) throw new Error('State URL is required');
    const loadToken = beginDataLoad(method, buildAnalyticsContext());
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const err = new Error(`Failed to fetch state from ${url} (${response.status} ${response.statusText})`);
        err.status = response.status;
        throw err;
      }
      const snapshot = await response.json();
      validateSnapshotShape(snapshot, url);
      await deserialize(snapshot);
      completeDataLoadSuccess(loadToken, buildAnalyticsContext());
    } catch (err) {
      completeDataLoadFailure(loadToken, { ...buildAnalyticsContext(), error: err });
      throw err;
    }
  }

  return { downloadState, loadStateFromFile, loadStateFromUrl };
}

