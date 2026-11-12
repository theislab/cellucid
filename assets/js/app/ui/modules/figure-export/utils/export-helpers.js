/**
 * @fileoverview Figure export helpers (filenames).
 *
 * Keep these utilities independent of UI and renderer state so both SVG and
 * PNG renderers can reuse them without dragging UI logic into the render path.
 *
 * @module ui/modules/figure-export/utils/export-helpers
 */

import { fileTimestamp } from '../../../../utils/download.js';

/**
 * One segment of a figure's file name: words joined by `_`, letters and
 * digits of every script kept (an accented or CJK dataset name stays),
 * other punctuation dropped.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeFilenamePart(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'untitled';
  return raw
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}\p{M}._-]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
}

/**
 * Build a conservative, cross-platform filename.
 *
 * The field is written once: the view segment is left out when it only repeats
 * the field, and the field segment when the view's label begins with it.
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
  const ts = timestamp || fileTimestamp();
  const base = sanitizeFilenamePart(datasetName || 'cellucid');
  const field = fieldKey ? sanitizeFilenamePart(fieldKey) : null;
  // A view nobody renamed is labeled with its color field, or with a filter of it
  // ("cell_type: hiding B1 cells"): the field is written once, as the view's label begins
  // ("..._cell_type_cell_type_..." otherwise).
  const viewPart = viewLabel ? sanitizeFilenamePart(viewLabel) : null;
  const view = viewPart === field ? null : viewPart;
  const fieldShown = field !== null && view !== null && view.startsWith(`${field}_`) ? null : field;
  const extra = variant ? sanitizeFilenamePart(variant) : null;

  const segments = [base, fieldShown, view, extra, ts].filter(Boolean);
  return `${segments.join('_')}.${sanitizeFilenamePart(ext).replace(/^\.+/, '')}`;
}
