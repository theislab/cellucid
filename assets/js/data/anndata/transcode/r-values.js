/**
 * Reading R values out of a parsed R object (`formats/rds/parse.js` nodes):
 * classes, slots, names, data frames, factors, and the vectors behind them,
 * whether held, a compact sequence, or a region kept in the transcode space
 * or in the file itself.
 *
 * @module data/anndata/transcode/r-values
 */

import { NA_INTEGER, hostValues } from '../../../formats/rds/index.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** An S4 slot holding `NULL` is stored as this symbol. */
const NULL_SLOT = '\u0001NULL\u0001';

/** Whether a node is R's `NULL` (or an S4 slot holding it, or nothing). */
export function isNull(node) {
  return node === null || node === undefined || node.kind === 'null' ||
    (node.kind === 'symbol' && node.name === NULL_SLOT);
}

/** An attribute (an S4 slot), or null. */
export function attribute(node, name) {
  const value = node?.attributes?.[name];
  return isNull(value) ? null : value;
}

/** The class vector of a node (`[]` when it has none). */
export function classesOf(node) {
  const value = attribute(node, 'class');
  return value?.kind === 'string' ? value.values?.filter(item => item !== null) ?? [] : [];
}

/** The package an S4 class comes from (its class attribute's `package`), or null. */
export function packageOf(node) {
  const value = attribute(attribute(node, 'class'), 'package');
  return value?.kind === 'string' ? value.values?.[0] ?? null : null;
}

/** Whether a node's class vector holds one of `names`. */
export function hasClass(node, ...names) {
  const classes = classesOf(node);
  return names.some(name => classes.includes(name));
}

/** The text values of a character vector, or null. */
export function strings(node) {
  if (node?.kind !== 'string') return null;
  return node.values ?? null;
}

/** The one string a length-1 character vector holds, or null. */
export function scalarString(node) {
  const values = strings(node);
  return values !== null && values.length > 0 ? values[0] : null;
}

/** A list's elements by name (`names` attribute). */
export function namedItems(node) {
  if (node?.kind !== 'list' || node.items === null) return [];
  const names = strings(attribute(node, 'names')) ?? [];
  return node.items.map((value, index) => ({ name: names[index] ?? null, value }));
}

/** One element of a named list, or null. */
export function item(node, name) {
  return namedItems(node).find(entry => entry.name === name)?.value ?? null;
}

/** A matrix's or array's `dim`/`Dim`, or null. */
export function dimOf(node) {
  const value = attribute(node, 'dim') ?? attribute(node, 'Dim');
  if (value?.kind !== 'integer' || value.values === null) return null;
  return Array.from(value.values);
}

/** A matrix's row and column names (`dimnames`/`Dimnames`), each or null. */
export function dimnamesOf(node) {
  const value = attribute(node, 'dimnames') ?? attribute(node, 'Dimnames');
  if (value?.kind !== 'list' || value.items === null) return [null, null];
  return [strings(value.items[0]), strings(value.items[1])];
}

/**
 * The elements of an atomic vector as a host-order typed array, whatever
 * holds them (memory, a compact sequence, a region).
 *
 * @param {Object} node
 * @param {{readRegion: (region: Object) => Promise<Uint8Array>}} context
 * @returns {Promise<Int32Array|Float64Array|Uint8Array|null>}
 */
export async function vectorValues(node, { readRegion }) {
  if (node === null || node === undefined) return null;
  if (node.values !== null && node.values !== undefined && ArrayBuffer.isView(node.values)) return node.values;
  if (node.sequence) {
    const { start, step } = node.sequence;
    const values = node.kind === 'integer' ? new Int32Array(node.length) : new Float64Array(node.length);
    for (let i = 0; i < node.length; i++) values[i] = start + i * step;
    return values;
  }
  if (node.region) {
    // A region read back is a fresh array: swapped in place.
    return hostValues(node.kind, await readRegion(node.region), node.length, true);
  }
  return null;
}

/** Bytes of one element of an atomic vector. */
function elementWidth(kind) {
  return kind === 'double' ? 8 : kind === 'raw' ? 1 : kind === 'complex' ? 16 : 4;
}

/**
 * Elements `[start, start + count)` of an atomic vector as a host-order
 * typed array, reading only those of a region (a large vector is read in
 * slices this way, never whole).
 *
 * @param {Object} node
 * @param {number} start
 * @param {number} count
 * @param {{readRegion: (region: Object) => Promise<Uint8Array>}} context
 * @returns {Promise<Int32Array|Float64Array|Uint8Array>}
 */
export async function vectorSlice(node, start, count, { readRegion }) {
  if (node.values !== null && node.values !== undefined && ArrayBuffer.isView(node.values)) {
    return node.values.subarray(start, start + count);
  }
  if (node.sequence) {
    const { step } = node.sequence;
    const values = node.kind === 'integer' ? new Int32Array(count) : new Float64Array(count);
    for (let i = 0; i < count; i++) values[i] = node.sequence.start + (start + i) * step;
    return values;
  }
  if (node.region) {
    const width = elementWidth(node.kind);
    const region = { ...node.region, offset: node.region.offset + start * width, byteLength: count * width };
    return hostValues(node.kind, await readRegion(region), count, true);
  }
  throw new Error('The vector was not kept.');
}

/** The Zarr dtype of a kept region's elements (R writes big-endian). */
export function regionDtype(node) {
  if (node.kind === 'double') return '>f8';
  if (node.kind === 'integer' || node.kind === 'logical') return '>i4';
  if (node.kind === 'raw') return '|u1';
  throw new TypeError(`A ${node.kind} vector has no numeric element type.`);
}

/**
 * An array as the store writer takes it: `{values}` or `{region, dtype}`.
 *
 * @param {Object} node
 */
export function writable(node) {
  if (node.region) return { region: node.region, dtype: regionDtype(node), length: node.length };
  if (node.values !== null && node.values !== undefined) return { values: node.values, length: node.length };
  if (node.sequence) {
    const { start, step } = node.sequence;
    const values = node.kind === 'integer' ? new Int32Array(node.length) : new Float64Array(node.length);
    for (let i = 0; i < node.length; i++) values[i] = start + i * step;
    return { values, length: node.length };
  }
  return null;
}

/**
 * A data frame's row names: its `row.names` attribute, which R stores
 * compactly as `c(NA, -n)` for the automatic names `1..n`.
 *
 * @param {Object} frame
 * @returns {Promise<string[]|null>}
 */
export async function rowNamesOf(frame, context) {
  const value = attribute(frame, 'row.names');
  if (value === null) return null;
  if (value.kind === 'string') return value.values;
  const numbers = await vectorValues(value, context);
  if (numbers === null) return null;
  if (numbers.length === 2 && numbers[0] === NA_INTEGER) {
    const count = Math.abs(numbers[1]);
    return Array.from({ length: count }, (_, i) => String(i + 1));
  }
  return Array.from(numbers, number => String(number));
}

/**
 * A data frame's row count, from its first column or its row names.
 *
 * @param {Object} frame
 */
export async function rowCountOf(frame, context) {
  const value = attribute(frame, 'row.names');
  if (value?.kind === 'string') return value.length;
  if (value !== null) {
    const numbers = await vectorValues(value, context);
    if (numbers !== null && numbers.length === 2 && numbers[0] === NA_INTEGER) return Math.abs(numbers[1]);
    if (numbers !== null) return numbers.length;
  }
  const first = namedItems(frame)[0]?.value;
  return first?.length ?? 0;
}

/** The smallest signed code type that holds `count` categories (and -1). */
function codesOf(count, length) {
  if (count < 128) return new Int8Array(length);
  if (count < 32768) return new Int16Array(length);
  return new Int32Array(length);
}

/**
 * One R vector as a dataframe column (`zarr-writer.js` `column()`), or null
 * with why when it cannot be one (`{skip: reason}`).
 *
 * - factor → categorical (level order and `ordered` kept, NA → -1);
 * - character → categorical of its distinct values, sorted (NA kept);
 * - logical → booleans, nullable when it has NA;
 * - integer → int32, nullable when it has NA;
 * - double (dates and times included) → float64; `integer64` → float64;
 * - an `Rle` (S4Vectors run-length column) → its expansion, as above.
 *
 * @param {Object} node
 * @param {number} rows
 * @param {Object} context - `{readRegion}`
 * @returns {Promise<Object>}
 */
export async function columnOf(node, rows, context) {
  if (node?.kind === 'S4' && hasClass(node, 'Rle')) {
    const values = attribute(node, 'values');
    const lengths = await vectorValues(attribute(node, 'lengths'), context);
    if (values === null || lengths === null) return { skip: 'an empty run-length column' };
    return columnOf(expandRuns(values, lengths, await vectorValues(values, context)), rows, context);
  }
  if (node === null || node === undefined || node.kind === 'skipped') return { skip: 'not kept' };
  if (node.length !== rows) return { skip: `${formatCountOf(node.length, 'value')} for ${formatCountOf(rows, 'row')}` };
  if (hasClass(node, 'factor')) {
    const levels = strings(attribute(node, 'levels')) ?? [];
    const values = await vectorValues(node, context);
    const codes = codesOf(levels.length, rows);
    for (let i = 0; i < rows; i++) codes[i] = values[i] === NA_INTEGER ? -1 : values[i] - 1;
    return { kind: 'categorical', codes, categories: levels.map(level => level ?? 'NA'), ordered: hasClass(node, 'ordered') };
  }
  switch (node.kind) {
    case 'string': {
      const values = node.values ?? [];
      const distinct = [...new Set(values.filter(value => value !== null))].sort();
      const position = new Map(distinct.map((value, index) => [value, index]));
      const codes = codesOf(distinct.length, rows);
      for (let i = 0; i < rows; i++) codes[i] = values[i] === null ? -1 : position.get(values[i]);
      return { kind: 'categorical', codes, categories: distinct, ordered: false };
    }
    case 'logical': {
      const values = await vectorValues(node, context);
      const bytes = new Uint8Array(rows);
      const mask = new Uint8Array(rows);
      let missing = false;
      for (let i = 0; i < rows; i++) {
        if (values[i] === NA_INTEGER) {
          mask[i] = 1;
          missing = true;
        } else {
          bytes[i] = values[i] ? 1 : 0;
        }
      }
      return missing ? { kind: 'nullable-boolean', values: bytes, mask } : { kind: 'booleans', values: bytes };
    }
    case 'integer': {
      const values = await vectorValues(node, context);
      let missing = false;
      for (let i = 0; i < rows && !missing; i++) missing = values[i] === NA_INTEGER;
      if (!missing) return { kind: 'numbers', values };
      const copy = new Int32Array(values);
      const mask = new Uint8Array(rows);
      for (let i = 0; i < rows; i++) {
        if (copy[i] === NA_INTEGER) {
          mask[i] = 1;
          copy[i] = 0;
        }
      }
      return { kind: 'nullable-integer', values: copy, mask };
    }
    case 'double': {
      if (hasClass(node, 'integer64')) {
        const values = await vectorValues(node, context);
        const words = new BigInt64Array(values.buffer, values.byteOffset, rows);
        const out = new Float64Array(rows);
        for (let i = 0; i < rows; i++) out[i] = words[i] === -(2n ** 63n) ? NaN : Number(words[i]);
        return { kind: 'numbers', values: out, note: 'integer64 read as float64' };
      }
      if (node.region) return { kind: 'numbers', region: node.region, dtype: '>f8' };
      return { kind: 'numbers', values: await vectorValues(node, context) };
    }
    default:
      return { skip: `a ${node.kind} column` };
  }
}

/** An `Rle`'s runs as one vector node of its values' kind. */
function expandRuns(valuesNode, lengths, values) {
  let total = 0;
  for (let i = 0; i < lengths.length; i++) total += lengths[i];
  if (valuesNode.kind === 'string' || values === null) {
    const source = valuesNode.values ?? [];
    const out = new Array(total);
    for (let i = 0, o = 0; i < lengths.length; i++) for (let k = 0; k < lengths[i]; k++) out[o++] = source[i];
    return { ...valuesNode, length: total, values: out };
  }
  const out = new values.constructor(total);
  for (let i = 0, o = 0; i < lengths.length; i++) {
    out.fill(values[i], o, o + lengths[i]);
    o += lengths[i];
  }
  return { ...valuesNode, length: total, values: out, region: null, sequence: null };
}

/**
 * A data frame (base `data.frame`, or S4Vectors `DFrame`/`DataFrame`) as
 * `{rows, rowNames, columns: [{name, node}]}`.
 *
 * @param {Object} node
 * @param {Object} context
 * @returns {Promise<{rows: number, rowNames: string[]|null, columns: Array<{name: string, node: Object}>}|null>}
 */
export async function dataFrameOf(node, context) {
  if (node === null || node === undefined) return null;
  if (node.kind === 'list' && hasClass(node, 'data.frame')) {
    return {
      rows: await rowCountOf(node, context),
      rowNames: await rowNamesOf(node, context),
      columns: namedItems(node).map(({ name, value }) => ({ name: name ?? '', node: value })),
    };
  }
  if (node.kind === 'S4' && attribute(node, 'listData') !== null || (node.kind === 'S4' && hasClass(node, 'DFrame', 'DataFrame'))) {
    const nrows = await vectorValues(attribute(node, 'nrows'), context);
    return {
      rows: nrows?.[0] ?? 0,
      rowNames: strings(attribute(node, 'rownames')),
      columns: namedItems(attribute(node, 'listData')).map(({ name, value }) => ({ name: name ?? '', node: value })),
    };
  }
  return null;
}

/**
 * An R list (or atomic scalar) as a JSON-like value: what `uns` holds of it.
 * Unsupported parts are left out.
 */
export async function plainValue(node, context, depth = 0) {
  if (isNull(node) || depth > 32) return null;
  if (node.kind === 'list') {
    const entries = namedItems(node);
    if (entries.length > 0 && entries.every(entry => entry.name !== null && entry.name !== '')) {
      const out = {};
      for (const { name, value } of entries) {
        const plain = await plainValue(value, context, depth + 1);
        if (plain !== null) out[name] = plain;
      }
      return out;
    }
    const out = [];
    for (const { value } of entries) out.push(await plainValue(value, context, depth + 1));
    return out;
  }
  if (node.kind === 'string') {
    const values = node.values ?? [];
    return values.length === 1 ? values[0] : values;
  }
  if (node.kind === 'logical') {
    const values = await vectorValues(node, context);
    if (values === null) return null;
    const out = Array.from(values, value => (value === NA_INTEGER ? null : value !== 0));
    return out.length === 1 ? out[0] : out;
  }
  if (node.kind === 'integer' || node.kind === 'double') {
    const values = await vectorValues(node, context);
    if (values === null) return null;
    const out = Array.from(values, value => (node.kind === 'integer' && value === NA_INTEGER ? null : value));
    return out.length === 1 ? out[0] : out;
  }
  return null;
}
