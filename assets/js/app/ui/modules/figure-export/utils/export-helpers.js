/**
 * @fileoverview Figure export helpers (filenames).
 *
 * Keep these utilities independent of UI and renderer state so both SVG and
 * PNG renderers can reuse them without dragging UI logic into the render path.
 *
 * @module ui/modules/figure-export/utils/export-helpers
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeFilenamePart(value) {
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
 * The view segment is left out when it would only repeat the field segment.
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
  // A view nobody renamed is labelled with its colour field, so naming both
  // wrote the field twice ("..._cell_type_cell_type_...").
  const viewPart = viewLabel ? sanitizeFilenamePart(viewLabel) : null;
  const view = viewPart === field ? null : viewPart;
  const extra = variant ? sanitizeFilenamePart(variant) : null;

  const segments = [base, field, view, extra, ts].filter(Boolean);
  return `${segments.join('_')}.${sanitizeFilenamePart(ext).replace(/^\.+/, '')}`;
}
