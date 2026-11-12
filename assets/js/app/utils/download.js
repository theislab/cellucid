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
 * The name is the one the app asks for; the browser may save the file under
 * another. WebKitGTK and WPE parse an `<a download>` name as a
 * Content-Disposition filename with libsoup, and libsoup 3.6.6 (Ubuntu 26.04)
 * turns each whitespace character into `_` (GNOME/libsoup 9e1570c9; spaces
 * are kept again from 3.7.1, GNOME/libsoup#503): `My report.html` is saved
 * as `My_report.html` there, and unchanged in Safari, Chrome and Firefox. Specs hold
 * the app to the asked name (`tests/browser/helpers/downloads.mjs`).
 *
 * Every name passes `safeFileName` on its way out, so a dataset's name in a
 * file name (`Pancreas a/b history report.html`) never carries a character a
 * file system refuses; `fileTimestamp` is the one time stamp a file name
 * carries.
 *
 * @module utils/download
 */

import { abortReason, requireSignalOrNull } from '../../utils/abort.js';

/** Delay before a clicked download's Object URL is released, in ms. */
export const OBJECT_URL_RELEASE_DELAY_MS = 1500;

/**
 * Runs of what no file name may hold on Windows, macOS or Linux: the path
 * separators, the characters Windows reserves, and control characters.
 */
const NOT_IN_A_FILE_NAME = /[/\\<>:"|?*\u0000-\u001f\u007f]+/g;

/**
 * `name` as a file name every system takes: each run of characters a file
 * name cannot hold becomes one `_`, white space and dots at either end are
 * dropped (Windows drops a trailing dot or space itself), and a name left
 * empty is `whenEmpty`. Letters of every script, spaces inside and the
 * punctuation file systems allow are kept.
 *
 * @param {unknown} name
 * @param {string} [whenEmpty]
 * @returns {string}
 */
export function safeFileName(name, whenEmpty = 'Cellucid') {
  const safe = String(name ?? '').replace(NOT_IN_A_FILE_NAME, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  return safe === '' ? whenEmpty : safe;
}

/**
 * The moment a file is made, as its name carries it: local time,
 * `YYYYMMDD_HHMMSS` (sorts by time, and names the clock the person reads).
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function fileTimestamp(date = new Date()) {
  const two = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function throwIfDownloadAborted(signal) {
  if (signal === null || !signal.aborted) return;
  throw abortReason(signal);
}

/**
 * Download a Blob as a file named `filename` (as `safeFileName` writes it).
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
  requireSignalOrNull(signal, 'Download signal');
  throwIfDownloadAborted(signal);
  const url = URL.createObjectURL(blob);
  let anchor = null;
  let appended = false;
  let clicked = false;
  try {
    throwIfDownloadAborted(signal);
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeFileName(filename);
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
