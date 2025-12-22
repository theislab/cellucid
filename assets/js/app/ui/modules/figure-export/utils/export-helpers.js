/**
 * @fileoverview Figure export helpers (download + filenames).
 *
 * Keep these utilities dependency-free so they can be reused by both SVG and
 * PNG renderers without dragging UI logic into the render path.
 *
 * @module ui/modules/figure-export/utils/export-helpers
 */

/**
 * Download a Blob by creating an Object URL and clicking an anchor.
 * Mirrors the pattern used by the state serializer.
 *
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
 * @returns {Promise<string>}
 */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}
