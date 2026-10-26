// assets/js/formats/text/matrix-market-entries.js
var MatrixMarketError = class extends Error {
  constructor(message, { unsupported = false } = {}) {
    super(message);
    this.name = "MatrixMarketError";
    this.unsupported = unsupported;
  }
};
function parseNumber(bytes, start, end) {
  let i = start;
  let negative = false;
  if (bytes[i] === 45) {
    negative = true;
    i++;
  } else if (bytes[i] === 43) {
    i++;
  }
  let value = 0;
  let digits = 0;
  while (i < end && bytes[i] >= 48 && bytes[i] <= 57) {
    value = value * 10 + (bytes[i] - 48);
    i++;
    digits++;
  }
  if (i === end && digits > 0 && digits < 16) return negative ? -value : value;
  let text = "";
  for (let k = start; k < end; k++) text += String.fromCharCode(bytes[k]);
  const parsed = Number(text);
  if (Number.isNaN(parsed) && !/^[+-]?nan$/i.test(text)) throw new MatrixMarketError(`'${text}' is not a number.`);
  return parsed;
}
var POWERS_OF_TEN = Float64Array.from({ length: 23 }, (_, k) => 10 ** k);
function isBlank(c) {
  return c === 32 || c === 9;
}
var VALUE_TYPES = { float32: Float32Array, float64: Float64Array };
function slowLine(bytes, start, end, pattern) {
  if (start === end || bytes[start] === 37) return null;
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
var joined = new Uint8Array(0);
function scanEntryBlock({ parts, pattern, rows: nRows, columns: nColumns, values: valueType, out = null }) {
  const Values = VALUE_TYPES[valueType];
  if (Values === void 0) throw new TypeError(`MatrixMarket values cannot be stored as '${valueType}'.`);
  if (!Array.isArray(parts) || parts.some((part) => !(part instanceof Uint8Array))) {
    throw new TypeError("A MatrixMarket entry block is a list of byte pieces.");
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
  if (end > 0 && bytes[end - 1] !== 10) throw new TypeError("A MatrixMarket entry block must be whole lines of bytes.");
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
    while (c === 32 || c === 9) c = bytes[++i];
    let row = 0;
    let digits = 0;
    while (c >= 48 && c <= 57) {
      row = row * 10 + (c - 48);
      c = bytes[++i];
      digits++;
    }
    let fast = digits > 0 && digits < 16 && (c === 32 || c === 9);
    let column = 0;
    let value = 1;
    if (fast) {
      while (c === 32 || c === 9) c = bytes[++i];
      digits = 0;
      while (c >= 48 && c <= 57) {
        column = column * 10 + (c - 48);
        c = bytes[++i];
        digits++;
      }
      fast = digits > 0 && digits < 16;
    }
    if (fast && !pattern) {
      fast = c === 32 || c === 9;
      while (c === 32 || c === 9) c = bytes[++i];
      let negative = false;
      if (c === 45) {
        negative = true;
        c = bytes[++i];
      } else if (c === 43) {
        c = bytes[++i];
      }
      let mantissa = 0;
      digits = 0;
      while (c >= 48 && c <= 57) {
        mantissa = mantissa * 10 + (c - 48);
        c = bytes[++i];
        digits++;
      }
      let decimals = 0;
      if (c === 46) {
        c = bytes[++i];
        while (c >= 48 && c <= 57) {
          mantissa = mantissa * 10 + (c - 48);
          c = bytes[++i];
          decimals++;
        }
      }
      fast = fast && digits + decimals > 0 && digits + decimals < 16 && decimals < 23;
      value = decimals === 0 ? mantissa : mantissa / POWERS_OF_TEN[decimals];
      if (negative) value = -value;
    }
    if (fast) {
      while (c === 32 || c === 9) c = bytes[++i];
      if (c === 13) c = bytes[++i];
      fast = c === 10;
    }
    if (fast) {
      row--;
      column--;
      if (!(row >= 0 && row < nRows && column >= 0 && column < nColumns)) {
        failure = { kind: "outside", row, column };
        break;
      }
      outRows[count] = row;
      outColumns[count] = column;
      outValues[count] = value;
      count++;
      p = i + 1;
      continue;
    }
    const newline = bytes.indexOf(10, lineStart);
    let lineEnd = newline;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 13) lineEnd--;
    let entry;
    try {
      entry = slowLine(bytes, lineStart, lineEnd, pattern);
    } catch (error) {
      if (!(error instanceof MatrixMarketError)) throw error;
      failure = { kind: "message", message: error.message };
      break;
    }
    p = newline + 1;
    if (entry === null) continue;
    if (entry.noValue === true) {
      failure = { kind: "no-value" };
      break;
    }
    if (!(entry.row >= 0 && entry.row < nRows && entry.column >= 0 && entry.column < nColumns)) {
      failure = { kind: "outside", row: entry.row, column: entry.column };
      break;
    }
    if (!Number.isInteger(entry.row) || !Number.isInteger(entry.column)) {
      failure = { kind: "not-whole", row: entry.row, column: entry.column };
      break;
    }
    outRows[count] = entry.row;
    outColumns[count] = entry.column;
    outValues[count] = entry.value;
    count++;
  }
  return { count, rows: outRows, columns: outColumns, values: outValues, failure };
}
function entryCapacity(bytes) {
  return (bytes >>> 2) + 1;
}
export {
  MatrixMarketError,
  entryCapacity,
  parseNumber,
  scanEntryBlock
};
//# sourceMappingURL=matrix-market-entries.5f1457fa6557.js.map
