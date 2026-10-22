/**
 * @fileoverview The one way the web app hands a file to the browser.
 *
 * Figure export, session bundles, analysis CSV tables and community
 * annotation snapshots all download through `downloadBlob()`, so they agree on
 * one lifecycle: the anchor is appended, clicked and removed synchronously,
 * and the Object URL is released on a later task. Firefox and WebKit read the
 * URL after `click()` returns, so releasing it in the same task can cancel the
 * download those engines were about to start.
 *
 * @module utils/download
 */

/** Delay before a clicked download's Object URL is released, in ms. */
export const OBJECT_URL_RELEASE_DELAY_MS = 1500;

function throwIfDownloadAborted(signal) {
  if (signal === null || !signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('Download was aborted.', 'AbortError');
}

/**
 * Download a Blob as a file named `filename`.
 *
 * An abort before the click releases every staged owner immediately and
 * throws the signal's reason; once the click has happened the file is
 * committed and a later abort cannot roll it back.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal]
 */
export function downloadBlob(blob, filename, { signal = null } = {}) {
  if (!(blob instanceof Blob)) {
    throw new TypeError('Download requires a Blob');
  }
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new TypeError('Download requires a non-empty filename');
  }
  if (signal !== null && !(signal instanceof AbortSignal)) {
    throw new TypeError('Download signal must be an AbortSignal or null');
  }
  throwIfDownloadAborted(signal);
  const url = URL.createObjectURL(blob);
  let anchor = null;
  let appended = false;
  let clicked = false;
  try {
    throwIfDownloadAborted(signal);
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    appended = true;
    throwIfDownloadAborted(signal);
    anchor.click();
    clicked = true;
  } finally {
    try {
      if (appended) anchor.remove();
    } finally {
      if (clicked) {
        setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_RELEASE_DELAY_MS);
      } else {
        URL.revokeObjectURL(url);
      }
    }
  }
}
