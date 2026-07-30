/**
 * @fileoverview Figure export helpers (download + filenames).
 *
 * Keep these utilities independent of UI and renderer state so both SVG and
 * PNG renderers can reuse them without dragging UI logic into the render path.
 *
 * @module ui/modules/figure-export/utils/export-helpers
 */

import {
  isFigureExportSignalAborted,
  throwIfFigureExportAborted,
} from '../figure-export-contract.js';

/**
 * Download a Blob by creating an Object URL and clicking an anchor.
 * Mirrors the pattern used by the state serializer.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal]
 */
export function downloadBlob(blob, filename, { signal = null } = {}) {
  throwIfFigureExportAborted(signal);
  const url = URL.createObjectURL(blob);
  let anchor = null;
  let appended = false;
  try {
    throwIfFigureExportAborted(signal);
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    appended = true;
    throwIfFigureExportAborted(signal);
    anchor.click();
  } finally {
    try {
      // Element.remove() is idempotent if a reentrant teardown already
      // detached the committed download owner.
      if (appended) anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Encode a canvas while letting teardown settle the export immediately. The
 * browser's native encoder is not cancellable, so a callback that arrives after
 * abort is ignored.
 *
 * @param {{ toBlob: Function }} canvas
 * @param {string} type
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal]
 * @param {string} [options.failureMessage]
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(
  canvas,
  type,
  {
    signal = null,
    failureMessage = 'Canvas encoding failed.',
  } = {}
) {
  throwIfFigureExportAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      try {
        throwIfFigureExportAborted(signal);
      } catch (error) {
        settle(reject, error);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (isFigureExportSignalAborted(signal)) {
      onAbort();
      return;
    }
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        if (isFigureExportSignalAborted(signal)) {
          onAbort();
          return;
        }
        if (!(blob instanceof Blob)) {
          settle(reject, new Error(failureMessage));
          return;
        }
        settle(resolve, blob);
      }, type);
    } catch (error) {
      settle(reject, error);
    }
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeFilenamePart(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'untitled';
  return raw
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
export function formatTimestampForFilename(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

/**
 * Build a conservative, cross-platform filename.
 *
 * @param {object} parts
 * @param {string|null} [parts.datasetName]
 * @param {string|null} [parts.fieldKey]
 * @param {string|null} [parts.viewLabel]
 * @param {string|null} [parts.variant] - Extra disambiguator (e.g., "dpi300")
 * @param {string} parts.ext - File extension without dot (e.g., "svg")
 * @param {string} [parts.timestamp] - Preformatted timestamp
 * @returns {string}
 */
export function buildExportFilename({ datasetName, fieldKey, viewLabel, variant, ext, timestamp }) {
  const ts = timestamp || formatTimestampForFilename();
  const base = sanitizeFilenamePart(datasetName || 'cellucid');
  const field = fieldKey ? sanitizeFilenamePart(fieldKey) : null;
  const view = viewLabel ? sanitizeFilenamePart(viewLabel) : null;
  const extra = variant ? sanitizeFilenamePart(variant) : null;

  const segments = [base, field, view, extra, ts].filter(Boolean);
  return `${segments.join('_')}.${sanitizeFilenamePart(ext).replace(/^\.+/, '')}`;
}

/**
 * Convert a Blob to a data: URL (for embedding rasters into SVG).
 * @param {Blob} blob
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<string>}
 */
export function blobToDataUrl(blob, { signal = null } = {}) {
  throwIfFigureExportAborted(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const rejectForAbort = () => {
      try {
        throwIfFigureExportAborted(signal);
      } catch (error) {
        settle(reject, error);
      }
    };
    const onAbort = () => {
      try {
        reader.abort();
      } finally {
        rejectForAbort();
      }
    };
    reader.onload = () => {
      if (isFigureExportSignalAborted(signal)) {
        rejectForAbort();
        return;
      }
      settle(resolve, String(reader.result || ''));
    };
    reader.onerror = () => {
      settle(
        reject,
        reader.error || new Error('Failed to read blob')
      );
    };
    reader.onabort = rejectForAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (isFigureExportSignalAborted(signal)) {
      onAbort();
      return;
    }
    try {
      reader.readAsDataURL(blob);
    } catch (error) {
      settle(reject, error);
    }
  });
}
