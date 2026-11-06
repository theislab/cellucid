/**
 * The Zarr v2 format as the app's writers write it: the metadata documents'
 * JSON, the dtypes, the `.zarray` document and the bytes of a `vlen-utf8`
 * chunk. The mirror of `json.js`, `dtypes.js`, `metadata.js` and
 * `codecs/vlen.js`, which read them.
 *
 * Shared by every Zarr writer of the app: the transcoders' kept stores
 * (`data/anndata/transcode/zarr-writer.js`, uncompressed) and the streamed
 * stores of a copy (`writer.js`). What lives here decides the bytes of a
 * kept store, so it is in the transcoders' revision guards
 * (`tests/transcode-cache-contract.test.mjs`); what only a copy writes
 * (codecs, the streamed store, the archive) lives in `writer.js`, outside
 * them. Every value is little-endian (`<`), as every host a browser runs on.
 *
 * @module formats/zarr/format-v2
 */

/** Bytes of each value of a Zarr v2 dtype, by its kind and size (`<f4` → `f4`). */
const ITEM_SIZES = Object.freeze({ b1: 1, i1: 1, u1: 1, i2: 2, u2: 2, i4: 4, u4: 4, i8: 8, u8: 8, f2: 2, f4: 4, f8: 8 });

/** The `vlen-utf8` filter: an object array of text. */
export const VLEN_UTF8 = Object.freeze({ id: 'vlen-utf8' });

// ---------------------------------------------------------------------------
// JSON, as Python writes it.

/** One JSON value, with NaN and infinities bare and BigInts exact (`json.js` reads both). */
function jsonText(value, indent, depth) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  const pad = indent === 0 ? '' : '\n' + ' '.repeat(indent * (depth + 1));
  const close = indent === 0 ? '' : '\n' + ' '.repeat(indent * depth);
  const separator = ',';
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const items = Array.from(value, item => jsonText(item, indent, depth + 1));
    return items.length === 0 ? '[]' : `[${pad}${items.join(separator + pad)}${close}]`;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return '{}';
  const colon = indent === 0 ? ':' : ': ';
  return `{${pad}${entries.map(([key, item]) => JSON.stringify(key) + colon + jsonText(item, indent, depth + 1)).join(separator + pad)}${close}}`;
}

/**
 * A metadata document's bytes: `value` as JSON (indented by `indent`
 * spaces), NaN and infinities bare, BigInts exact, typed arrays as lists.
 *
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {Uint8Array}
 */
export function jsonBytes(value, indent = 2) {
  return new TextEncoder().encode(jsonText(value, indent, 0));
}

// ---------------------------------------------------------------------------
// Data types.

/**
 * The Zarr v2 dtype of values held as `values` (a typed array, host order),
 * or of a store dtype (`formats/store.js`): a float16 array is `<f2` (the
 * store reads its values as float32; `float16Bits` writes them back, every
 * bit kept); text is `|O` (`vlen-utf8`); an enum its base integer; a compound
 * of numbers its fields (`recordDtype`; one with text needs its widths).
 *
 * @param {ArrayBufferView|{kind: string, bytes: number|null, base?: Object}} of
 * @returns {string|Array|null} The dtype (a NumPy structured dtype's field
 *   list for a compound), or null for a type no Zarr v2 dtype here holds
 *   (opaque; a compound with text, whose widths `recordDtype` takes)
 */
export function zarrV2Dtype(of) {
  if (ArrayBuffer.isView(of)) {
    if (of instanceof Float64Array) return `<f8`;
    if (of instanceof Float32Array) return `<f4`;
    if (of instanceof Int32Array) return `<i4`;
    if (of instanceof Uint32Array) return `<u4`;
    if (of instanceof Int16Array) return `<i2`;
    if (of instanceof Uint16Array) return `<u2`;
    if (of instanceof Int8Array) return '|i1';
    if (of instanceof Uint8Array) return '|u1';
    if (of instanceof BigInt64Array) return `<i8`;
    if (of instanceof BigUint64Array) return `<u8`;
    throw new TypeError('An array to write must be a numeric typed array.');
  }
  const dtype = of?.kind === 'enum' ? of.base : of;
  switch (dtype?.kind) {
    case 'bool':
      return '|b1';
    case 'string':
      return '|O';
    case 'int':
    case 'uint': {
      const letter = dtype.kind === 'int' ? 'i' : 'u';
      return dtype.bytes === 1 ? `|${letter}1` : `<${letter}${dtype.bytes}`;
    }
    case 'float':
      return `<f${dtype.bytes}`;
    case 'compound':
      // Its text fields' widths come from their values (`recordDtype`).
      return dtype.fields.some(field => field.dtype.kind === 'string') ? null : recordDtype(dtype, new Map());
    default:
      return null;
  }
}

/**
 * The structured dtype of a compound (a NumPy record array, as scanpy's
 * `rank_genes_groups` stores its names): each field its own dtype, packed in
 * order, an array member with its shape; a text field fixed-width Unicode
 * (`<U<n>`, UTF-32) of `widths.get(name)` characters, as anndata writes a
 * record array to Zarr. Null for a field of no type a record holds.
 *
 * @param {{fields: ReadonlyArray<{name: string, dtype: Object, shape?: ReadonlyArray<number>}>}} dtype
 * @param {Map<string, number>} widths
 * @returns {Array|null}
 */
export function recordDtype(dtype, widths) {
  const fields = [];
  for (const field of dtype.fields) {
    const type = field.dtype.kind === 'string'
      ? (widths.has(field.name) ? `<U${Math.max(1, widths.get(field.name))}` : null)
      : zarrV2Dtype(field.dtype);
    if (type === null || type === '|O' || Array.isArray(type)) return null;
    fields.push(field.shape?.length > 0 ? [field.name, type, [...field.shape]] : [field.name, type]);
  }
  return fields;
}

/**
 * Bytes of one value of a Zarr v2 dtype (`<f4` → 4); null for `|O`.
 *
 * @param {string} dtype
 * @returns {number|null}
 */
export function itemSizeOf(dtype) {
  if (dtype === '|O') return null;
  if (Array.isArray(dtype)) {
    return dtype.reduce((sum, [, type, shape = []]) => sum + itemSizeOf(type) * shape.reduce((product, extent) => product * extent, 1), 0);
  }
  // Fixed-width Unicode: four bytes a character.
  if (/^[<>]U\d+$/.test(dtype)) return 4 * Number(dtype.slice(2));
  const size = ITEM_SIZES[dtype.slice(1)];
  if (size === undefined) throw new TypeError(`The Zarr dtype '${dtype}' is not one this writer writes.`);
  return size;
}

/** The fill value a Cellucid store declares for a dtype: 0, `false` or `''`. */
export function defaultFillOf(dtype) {
  if (dtype === '|O') return '';
  // A record's default (its fields' zeros), as zarr-python reads a null fill.
  if (Array.isArray(dtype) || /^[<>]U/.test(dtype)) return null;
  if (dtype.endsWith('b1')) return false;
  return 0;
}

/** The bytes of one vlen-utf8 chunk: a count, then each string's length and UTF-8 bytes. */
export function vlenUtf8Chunk(values) {
  const encoder = new TextEncoder();
  const encoded = values.map(value => encoder.encode(value ?? ''));
  const total = 4 + encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, values.length, true);
  let offset = 4;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, true);
    out.set(bytes, offset + 4);
    offset += 4 + bytes.length;
  }
  return out;
}

/**
 * The `.zarray` document of an array.
 *
 * @param {{shape: number[], chunks: number[], dtype: string, fill?: unknown, order?: 'C'|'F',
 *          filters?: Array<Object>|null, compressor?: Object|null}} array
 * @returns {Object}
 */
export function v2ArrayDocument({ shape, chunks, dtype, fill = defaultFillOf(dtype), order = 'C', filters = null, compressor = null }) {
  return {
    chunks,
    compressor,
    dimension_separator: '.',
    dtype,
    fill_value: fill,
    filters,
    order,
    shape,
    zarr_format: 2,
  };
}

