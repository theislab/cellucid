/**
 * The entry lines of a MatrixMarket coordinate file (`i j [value]`,
 * 1-based), parsed from bytes into typed arrays, one block of whole lines
 * at a time. A block is parsed wherever the decode pool runs it
 * (`formats/io/decode-pool.js`: on a decode worker, or in the reader thread
 * when it is too small to be worth a message or no worker can run), so this
 * module depends on nothing a worker cannot load.
 *
 * A line the fast scanner does not take whole (an exponent, `nan`, more than
 * 15 digits, a stray character, a comment, an empty line) is read token by
 * token with the same rules: a fast line and a slow one give the same
 * numbers (a decimal of at most 15 significant digits and 22 decimals
 * divided by an exact power of ten is the correctly rounded double
 * `Number()` gives).
 *
 * @module formats/text/matrix-market-entries
 */

/** A MatrixMarket file that is damaged or not one Cellucid reads. */
export class MatrixMarketError extends Error {
  constructor(message, { unsupported = false } = {}) {
    super(message);
    this.name = 'MatrixMarketError';
    this.unsupported = unsupported;
  }
}

/** A decimal number in `bytes[start, end)`. */
export function parseNumber(bytes, start, end) {
  let i = start;
  let negative = false;
  if (bytes[i] === 0x2d) {
    negative = true;
    i++;
  } else if (bytes[i] === 0x2b) {
    i++;
  }
  let value = 0;
  let digits = 0;
  while (i < end && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
    value = value * 10 + (bytes[i] - 0x30);
    i++;
    digits++;
  }
  if (i === end && digits > 0 && digits < 16) return negative ? -value : value;
  let text = '';
  for (let k = start; k < end; k++) text += String.fromCharCode(bytes[k]);
  const parsed = Number(text);
  if (Number.isNaN(parsed) && !/^[+-]?nan$/i.test(text)) throw new MatrixMarketError(`'${text}' is not a number.`);
  return parsed;
}

/** Powers of ten a decimal fraction is divided by, exactly representable (10^0 … 10^22). */
const POWERS_OF_TEN = Float64Array.from({ length: 23 }, (_, k) => 10 ** k);

/** A space or a tab, the separators of an entry line. */
function isBlank(c) {
  return c === 0x20 || c === 0x09;
}

/** The typed array of a value type name. */
const VALUE_TYPES = { float32: Float32Array, float64: Float64Array };

/**
 * The tokens of one slow line `[start, end)` (no line end): null for a
 * comment or an empty line, else `{row, column, value}` 0-based, or
 * `{noValue: true}`. A token that is not a number throws.
 */
function slowLine(bytes, start, end, pattern) {
  if (start === end || bytes[start] === 0x25) return null;
  let i = start;
  while (i < end && isBlank(bytes[i])) i++;
  if (i === end) return null;
  let s = i;
  while (i < end && !isBlank(bytes[i])) i++;
  const row = parseNumber(bytes, s, i) - 1;
  while (i < end && isBlank(bytes[i])) i++;
  s = i;
  while (i < end && !isBlank(bytes[i])) i++;
  const column = parseNumber(bytes, s, i) - 1;
  let value = 1;
  if (!pattern) {
    while (i < end && isBlank(bytes[i])) i++;
    s = i;
    while (i < end && !isBlank(bytes[i])) i++;
    if (s === i) return { noValue: true };
    value = parseNumber(bytes, s, i);
  }
  return { row, column, value };
}

/** Where the parts of a block are put together, grown to the largest block seen and kept. */
let joined = new Uint8Array(0);

/**
 * Parse every entry line of a block: `parts`, pieces of decompressed bytes
 * that end to end are a run of whole lines (each ends in `\n`, the last
 * part's last byte too), into `out`.
 *
 * The parse stops at the first line that is not an entry of this matrix and
 * says why as `failure`, with the entries before it: the reader numbers the
 * entries across blocks, so the failure is data, not a message:
 * `{kind: 'outside', row, column}` (0-based), `{kind: 'not-whole', row,
 * column}`, `{kind: 'no-value'}`, or `{kind: 'message', message}` (a token
 * that is not a number).
 *
 * @param {{parts: Uint8Array[], pattern: boolean, rows: number, columns: number, values: 'float32'|'float64',
 *   out: {rows: Int32Array, columns: Int32Array, values: Float32Array|Float64Array}|null}} block
 *   `parts`: given up by the caller (the pieces the decompressor made, sent
 *   on as they are); `rows`, `columns`: the matrix's size line; `values`:
 *   the type the values are stored as (rounded once from the parsed
 *   double); `out`: arrays to parse into, given up by the caller (a block's
 *   results go back in the arrays of an earlier one, so a pass allocates
 *   nothing per block), or null; arrays too short for the block are replaced
 * @returns {{count: number, rows: Int32Array, columns: Int32Array, values: Float32Array|Float64Array,
 *   failure: Object|null}} the first `count` entries of the arrays
 */
export function scanEntryBlock({ parts, pattern, rows: nRows, columns: nColumns, values: valueType, out = null }) {
  const Values = VALUE_TYPES[valueType];
  if (Values === undefined) throw new TypeError(`MatrixMarket values cannot be stored as '${valueType}'.`);
  if (!Array.isArray(parts) || parts.some(part => !(part instanceof Uint8Array))) {
    throw new TypeError('A MatrixMarket entry block is a list of byte pieces.');
  }
  let end = 0;
  for (const part of parts) end += part.length;
  if (joined.length < end) joined = new Uint8Array(end);
  const bytes = joined;
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  if (end > 0 && bytes[end - 1] !== 0x0a) throw new TypeError('A MatrixMarket entry block must be whole lines of bytes.');
  const capacity = entryCapacity(end);
  const outRows = out?.rows instanceof Int32Array && out.rows.length >= capacity ? out.rows : new Int32Array(capacity);
  const outColumns = out?.columns instanceof Int32Array && out.columns.length >= capacity ? out.columns : new Int32Array(capacity);
  const outValues = out?.values instanceof Values && out.values.length >= capacity ? out.values : new Values(capacity);
  let count = 0;
  let failure = null;
  let p = 0;
  while (p < end) {
    const lineStart = p;
    let i = p;
    let c = bytes[i];
    while (c === 0x20 || c === 0x09) c = bytes[++i];
    // Row and column: whole numbers.
    let row = 0;
    let digits = 0;
    while (c >= 0x30 && c <= 0x39) {
      row = row * 10 + (c - 0x30);
      c = bytes[++i];
      digits++;
    }
    let fast = digits > 0 && digits < 16 && (c === 0x20 || c === 0x09);
    let column = 0;
    let value = 1;
    if (fast) {
      while (c === 0x20 || c === 0x09) c = bytes[++i];
      digits = 0;
      while (c >= 0x30 && c <= 0x39) {
        column = column * 10 + (c - 0x30);
        c = bytes[++i];
        digits++;
      }
      fast = digits > 0 && digits < 16;
    }
    if (fast && !pattern) {
      fast = c === 0x20 || c === 0x09;
      while (c === 0x20 || c === 0x09) c = bytes[++i];
      let negative = false;
      if (c === 0x2d) {
        negative = true;
        c = bytes[++i];
      } else if (c === 0x2b) {
        c = bytes[++i];
      }
      let mantissa = 0;
      digits = 0;
      while (c >= 0x30 && c <= 0x39) {
        mantissa = mantissa * 10 + (c - 0x30);
        c = bytes[++i];
        digits++;
      }
      let decimals = 0;
      if (c === 0x2e) {
        c = bytes[++i];
        while (c >= 0x30 && c <= 0x39) {
          mantissa = mantissa * 10 + (c - 0x30);
          c = bytes[++i];
          decimals++;
        }
      }
      fast = fast && digits + decimals > 0 && digits + decimals < 16 && decimals < 23;
      value = decimals === 0 ? mantissa : mantissa / POWERS_OF_TEN[decimals];
      if (negative) value = -value;
    }
    if (fast) {
      while (c === 0x20 || c === 0x09) c = bytes[++i];
      if (c === 0x0d) c = bytes[++i];
      fast = c === 0x0a;
    }
    if (fast) {
      row--;
      column--;
      if (!(row >= 0 && row < nRows && column >= 0 && column < nColumns)) {
        failure = { kind: 'outside', row, column };
        break;
      }
      outRows[count] = row;
      outColumns[count] = column;
      outValues[count] = value;
      count++;
      p = i + 1;
      continue;
    }
    // Anything else: its own line end, then token by token.
    const newline = bytes.indexOf(0x0a, lineStart);
    let lineEnd = newline;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
    let entry;
    try {
      entry = slowLine(bytes, lineStart, lineEnd, pattern);
    } catch (error) {
      if (!(error instanceof MatrixMarketError)) throw error;
      failure = { kind: 'message', message: error.message };
      break;
    }
    p = newline + 1;
    if (entry === null) continue;
    if (entry.noValue === true) {
      failure = { kind: 'no-value' };
      break;
    }
    if (!(entry.row >= 0 && entry.row < nRows && entry.column >= 0 && entry.column < nColumns)) {
      failure = { kind: 'outside', row: entry.row, column: entry.column };
      break;
    }
    if (!Number.isInteger(entry.row) || !Number.isInteger(entry.column)) {
      failure = { kind: 'not-whole', row: entry.row, column: entry.column };
      break;
    }
    outRows[count] = entry.row;
    outColumns[count] = entry.column;
    outValues[count] = entry.value;
    count++;
  }
  return { count, rows: outRows, columns: outColumns, values: outValues, failure };
}

/**
 * The most entries `bytes` of entry lines can hold: each holds at least a
 * digit, a blank, a digit and its line end.
 *
 * @param {number} bytes
 */
export function entryCapacity(bytes) {
  return (bytes >>> 2) + 1;
}
