/**
 * CSV text of per-cell analysis data, written in chunks.
 *
 * A page-data export is one row per cell: half a million cells is a 15 MB
 * text. Joining one string per row on the main thread held it for about 70 ms
 * and built the whole text twice (rows, then the join). This writer runs in an
 * analysis worker (compute/operation-handlers.js): rows are encoded as UTF-8 a
 * batch at a time into `Blob` parts, and the `Blob` is handed back, so the main
 * thread never sees the text.
 *
 * The bytes are exactly those of joining the rows with "\n": a header, then
 * one row per value, no trailing line break; numbers are written with
 * `String(number)`, a non-finite number or a missing value as an empty cell,
 * and text is quoted when it holds a quote, comma or line break.
 *
 * @module compute/csv-export
 */

/**
 * Convert a value to a safe CSV cell.
 * - Numbers: finite numbers only; non-finite -> empty
 * - Strings/others: quoted if needed; quotes are escaped by doubling
 *
 * @param {*} value
 * @returns {string}
 */
export function toCSVCell(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Characters gathered before a batch is encoded into a Blob part. */
const BATCH_CHARACTERS = 1 << 20;

/**
 * Collects CSV lines, joined by line breaks, as UTF-8 Blob parts.
 */
class CsvBlobWriter {
  constructor() {
    this._encoder = new TextEncoder();
    this._parts = [];
    this._pending = [];
    this._pendingCharacters = 0;
  }

  line(text) {
    this._pending.push(text);
    this._pendingCharacters += text.length + 1;
    if (this._pendingCharacters >= BATCH_CHARACTERS) this._flush();
  }

  _flush() {
    if (this._pending.length === 0) return;
    // Every batch after the first starts with the line break that separates
    // it from the previous one.
    const text = (this._parts.length === 0 ? '' : '\n') + this._pending.join('\n');
    this._parts.push(this._encoder.encode(text));
    this._pending = [];
    this._pendingCharacters = 0;
  }

  blob() {
    this._flush();
    return new Blob(this._parts, { type: 'text/csv' });
  }
}

/**
 * The value of row `i` of a page: its number, its label, or null.
 * @param {{values: ArrayLike<unknown>, categories?: string[]|null, missingCode?: number|null}} page
 */
function pageValueReader(page) {
  const { values, categories = null, missingCode = null } = page;
  if (categories === null) return i => values[i];
  return i => {
    const code = values[i];
    return code === missingCode ? null : categories[code];
  };
}

function requirePages(pages) {
  if (!Array.isArray(pages)) {
    throw new TypeError('CSV export pages must be an array');
  }
  for (const page of pages) {
    if (
      page === null || typeof page !== 'object' ||
      typeof page.pageName !== 'string' ||
      !page.values || !Number.isSafeInteger(page.values.length)
    ) {
      throw new TypeError('Each CSV export page needs a name and values');
    }
    if (page.categories !== undefined && page.categories !== null && !Array.isArray(page.categories)) {
      throw new TypeError('CSV export page categories must be an array of labels');
    }
  }
}

/**
 * The header line of a per-cell CSV layout.
 *
 * @param {'page-data'|'signature-scores'} layout
 * @param {string} [variableName] - The value column of 'page-data'
 * @returns {string}
 */
export function perCellCSVHeader(layout, variableName) {
  if (layout === 'page-data') {
    if (typeof variableName !== 'string') {
      throw new TypeError('A page-data CSV needs its variable name');
    }
    return `page,cell_index,${toCSVCell(variableName)}`;
  }
  if (layout === 'signature-scores') return 'page,score';
  throw new RangeError(`Unknown CSV export layout: ${String(layout)}`);
}

/**
 * The data lines of a per-cell CSV, joined by line breaks, without the header
 * and without a trailing break (an empty Blob when there is no line):
 * - 'page-data': `page,cell_index,value`, one line per value; a page without
 *   cell indices numbers its rows from `firstRow` (0 by default);
 * - 'signature-scores': `page,score`, one line per finite score.
 * A file split into row ranges is these Blobs joined by line breaks.
 *
 * @param {'page-data'|'signature-scores'} layout
 * @param {Array<{pageName: string, cellIndices?: ArrayLike<number>|null, values: ArrayLike<unknown>, categories?: string[]|null, missingCode?: number|null, firstRow?: number}>} pages
 * @returns {Blob}
 */
export function perCellCSVRows(layout, pages) {
  requirePages(pages);
  const writer = new CsvBlobWriter();
  if (layout === 'page-data') {
    for (const page of pages) {
      const pageName = toCSVCell(page.pageName);
      const valueAt = pageValueReader(page);
      const cells = page.cellIndices ?? null;
      const firstRow = page.firstRow ?? 0;
      for (let i = 0; i < page.values.length; i++) {
        const cell = cells?.[i] ?? firstRow + i;
        writer.line(`${pageName},${toCSVCell(cell)},${toCSVCell(valueAt(i))}`);
      }
    }
  } else if (layout === 'signature-scores') {
    for (const page of pages) {
      const pageName = toCSVCell(page.pageName);
      const { values } = page;
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (Number.isFinite(value)) writer.line(`${pageName},${String(value)}`);
      }
    }
  } else {
    throw new RangeError(`Unknown CSV export layout: ${String(layout)}`);
  }
  return writer.blob();
}

/**
 * A whole per-cell CSV file from its header and the row Blobs of consecutive
 * row ranges.
 *
 * @param {string} header
 * @param {Blob[]} rowParts
 * @returns {Blob}
 */
export function joinPerCellCSV(header, rowParts) {
  const parts = [header];
  for (const part of rowParts) {
    if (part.size === 0) continue;
    parts.push('\n', part);
  }
  return new Blob(parts, { type: 'text/csv' });
}

/**
 * Split pages into at most `parts` consecutive row ranges of about equal size,
 * each a list of page slices (`values`, `cellIndices` copied for the range,
 * `firstRow` the slice's first row in its page).
 *
 * @param {Array<{pageName: string, values: ArrayLike<unknown>, cellIndices?: ArrayLike<number>|null, categories?: string[]|null, missingCode?: number|null}>} pages
 * @param {number} parts
 * @returns {Array<Object[]>}
 */
export function splitPerCellRows(pages, parts) {
  requirePages(pages);
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new RangeError('CSV row range count must be a positive integer');
  }
  const total = pages.reduce((sum, page) => sum + page.values.length, 0);
  const size = Math.max(1, Math.ceil(total / parts));
  const ranges = [];
  let current = [];
  let filled = 0;
  for (const page of pages) {
    let from = 0;
    while (from < page.values.length) {
      const to = Math.min(page.values.length, from + (size - filled));
      current.push({
        pageName: page.pageName,
        values: page.values.slice(from, to),
        cellIndices: page.cellIndices ? page.cellIndices.slice(from, to) : null,
        categories: page.categories ?? null,
        missingCode: page.missingCode ?? null,
        firstRow: from
      });
      filled += to - from;
      from = to;
      if (filled === size) {
        ranges.push(current);
        current = [];
        filled = 0;
      }
    }
  }
  if (current.length > 0) ranges.push(current);
  return ranges;
}
