/**
 * @fileoverview The one way every user-facing size, duration and count is
 * written: notifications, the dataset card, read progress, opening progress,
 * jobs and conversion notes all format through these functions.
 *
 * No unit rounds up into the next one's ceiling: 1023.6 KB is "1.0 MB", not
 * "1024 KB"; 999.6 ms is "1.0 s", not "1000 ms"; 59.96 s is "1 min 0 s",
 * not "60.0 s". Dependency-free and cheap enough for progress updates.
 *
 * @module utils/format-units
 */

const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB', 'PB']);

/**
 * Built once: `Number#toLocaleString` constructs a formatter per call, which
 * made a 5,000-category legend spend a quarter of a second formatting its
 * counts on every filter change. Grouping is independent of the browser
 * locale: the copy is English, and "1.234 cells" beside "1,234 cells" read as
 * two different numbers.
 */
const GROUPED_INTEGER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0
});

/**
 * An exact count with grouped thousands: `1234567` → `"1,234,567"`.
 *
 * @param {number|bigint} value
 * @returns {string}
 */
export function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}

/** A finite number, or a BigInt (a 64-bit size read from a file). */
function requireCount(value) {
  if (typeof value === 'bigint') return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Count must be a finite number');
  }
}

/**
 * An exact count with its noun, singular for one: `formatCountOf(1, 'cell')`
 * → `"1 cell"`, `formatCountOf(1200, 'cell')` → `"1,200 cells"`. Every count
 * followed by a noun is written with it, never as `${n} cells`
 * (`tests/count-noun-agreement-contract.test.mjs`).
 *
 * @param {number} value
 * @param {string} singular
 * @param {string} [plural] - When adding "s" is wrong ("category" →
 *   "categories", "matrix" → "matrices")
 * @returns {string}
 */
export function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}

/**
 * The noun a count takes, singular for one: for a count written some other
 * way, as `${formatCompactCount(n)} ${countNoun(n, 'cell')}` ("1 cell",
 * "1.5K cells").
 *
 * @param {number} value
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== 'string' || singular.length === 0) {
    throw new TypeError('A counted noun must be non-empty text');
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

/**
 * A count of cells: `"1 cell"`, `"12,000 cells"`.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatCells(value) {
  return formatCountOf(value, 'cell');
}

/**
 * A count of the open cells, said against every cell of the dataset when
 * only some are open (a subsample): `"1,200 cells"`, or `"300 of 1,200
 * cells"`. The one way a shown count of the open cells is written, so a
 * subsample's counts are never read as the whole dataset's: the filter
 * line, the legend, the status line, the category builder, the dataset
 * picker. The noun agrees with the count it follows last.
 *
 * @param {number} open - The open cells
 * @param {number|null|undefined} total - Every cell of the dataset (`cellIdentity.nOriginal`); none, or
 *   `open`, when every cell is open
 * @param {(value: number) => string} [format] - How each number is written (`formatCount`, or a
 *   compact form)
 * @returns {string}
 */
export function formatOpenCells(open, total, format = formatCount) {
  requireCount(open);
  if (total === null || total === undefined || Number(total) === Number(open)) {
    return `${format(open)} ${countNoun(open, 'cell')}`;
  }
  requireCount(total);
  if (Number(total) < Number(open)) throw new RangeError('The open cells are some of the dataset\'s cells, never more');
  return `${format(open)} of ${format(total)} ${countNoun(total, 'cell')}`;
}

/** A value below 10 of its unit keeps one decimal; larger ones none. */
function roundForUnit(value, unit) {
  if (unit > 0 && value < 9.95) return Math.round(value * 10) / 10;
  return Math.round(value);
}

/**
 * A byte count in binary units: "512 B", "4.2 KB", "1.0 MB", "12 MB".
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    bytes < 0 ||
    bytes > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      'bytes must be a finite non-negative number no greater than Number.MAX_SAFE_INTEGER.'
    );
  }
  let value = bytes;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && roundForUnit(value, unit) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const text = unit > 0 && value < 9.95 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${BYTE_UNITS[unit]}`;
}

/**
 * A duration as people say it: "850 ms", "4.2 s", "3 min 5 s", "2 h 4 min".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (
    typeof ms !== 'number' ||
    !Number.isFinite(ms) ||
    ms < 0 ||
    ms > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      'duration must be a finite non-negative number of milliseconds no greater than Number.MAX_SAFE_INTEGER.'
    );
  }
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min ${totalSeconds % 60} s`;
}

/**
 * The time left, rounded up as an estimate: "<1 s", "~12 s", "~3 min 10 s".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatRemaining(ms) {
  if (ms < 1000) return '<1 s';
  if (ms < 60_000) return `~${Math.ceil(ms / 1000)} s`;
  return `~${formatDuration(ms)}`;
}

/**
 * A measured value as every place that shows one writes it — the legends'
 * colour bars, the filter list, figure provenance, exported figures' axes
 * and legends, cell info, analysis summaries: `figures` significant figures
 * (three by default), in fixed notation from 0.01 up to 10,000 (or up to the
 * power of ten the figures reach, when there are more than four), in
 * scientific notation outside (`0.00123` → `"1.23e-3"`, `1234567.891` →
 * `"1.23e6"`, `12.345` → `"12.3"`, `0.0149` → `"0.0149"`); trailing zeros
 * dropped; `"—"` for no value.
 *
 * The value is rounded first and the notation chosen for the rounded value,
 * so a value that rounds into the next decade is written in that decade's
 * form (`9999.6` → `"1e4"`, `0.009996` → `"0.01"`, `99960` → `"1e5"`), never
 * as `"10.0e3"`.
 *
 * @param {number|null|undefined} value
 * @param {number} [figures=3] - Significant figures, 1 to 17
 * @returns {string}
 */
export function formatSignificant(value, figures = 3) {
  if (!Number.isSafeInteger(figures) || figures < 1 || figures > 17) {
    throw new RangeError('Significant figures must be a whole number from 1 to 17');
  }
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  // Correctly rounded and renormalised: 9999.6 is "1.00e+4".
  const [digits, exponent] = abs.toExponential(figures - 1).split('e');
  const power = Number(exponent);
  if (power >= -2 && power < Math.max(4, figures)) return sign + String(Number(abs.toPrecision(figures)));
  const mantissa = digits.includes('.') ? digits.replace(/0+$/, '').replace(/\.$/, '') : digits;
  return `${sign}${mantissa}e${power}`;
}

/**
 * Significant figures of a range bound where it names cells — the filter
 * list, figure provenance, a range highlight's label: enough that a bound
 * typed or set by a slider (`legend-renderer.js`) is written exactly.
 */
export const BOUND_FIGURES = 6;

/**
 * A range bound as the filter list, provenance and range labels write it
 * (`formatSignificant` to `BOUND_FIGURES`).
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatBound(value) {
  return formatSignificant(value, BOUND_FIGURES);
}

/**
 * Significant figures that tell evenly spaced ticks apart: at least three,
 * and enough that ticks `step` apart up to `largest` differ in writing.
 *
 * @param {number} largest - The largest tick's magnitude
 * @param {number} step - The spacing of the ticks
 * @returns {number}
 */
export function tickFigures(largest, step) {
  if (!(Math.abs(step) > 0) || !Number.isFinite(step) || !Number.isFinite(largest) || largest === 0) return 3;
  const needed = Math.floor(Math.log10(Math.abs(largest))) - Math.floor(Math.log10(Math.abs(step))) + 1;
  return Math.min(17, Math.max(3, needed));
}

/**
 * A large count in compact form: "950", "12.3K", "4.0M", "1.2B".
 *
 * @param {number} n
 * @returns {string}
 */
export function formatCompactNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError('number must be finite.');
  }
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/**
 * A decimal number as a person types it, in any locale: a decimal point or a
 * decimal comma ("12.5", "12,5", "12," while typing), an optional sign and an
 * optional exponent and trailing `%` (the box itself may show a tiny share
 * as `2e-7`). No thousands separators: a number with both a point
 * and a comma, or more than one of either, is not read (NaN), so "9,969" is
 * 9.969 and never nine thousand. NaN for anything else (empty included).
 *
 * @param {string} text
 * @returns {number}
 */
export function parseDecimalText(text) {
  const value = String(text).trim().replace(/\s*%$/, '');
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/.test(value)) return NaN;
  return Number(value.replace(',', '.'));
}
