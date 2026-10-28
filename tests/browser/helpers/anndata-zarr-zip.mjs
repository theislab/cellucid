/**
 * Synthetic AnnData files built in memory, for specs whose dataset depends on
 * a parameter (a cell count, a category count, an id) or would be too large
 * to keep on disk: an AnnData Zarr store (format 2, consolidated, one
 * uncompressed chunk per array), zipped as a `.zarr.zip`, laid out exactly as
 * `anndata` writes one. Fixed datasets are files written by
 * `scripts/generate-browser-catalog-fixtures.py` instead.
 *
 * `fulfillFile` answers a page's request for such a file the way a web host
 * does: `HEAD` with its size, `Range` with 206 and the bytes asked for.
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

const ARRAY_ATTRS = Object.freeze({ 'encoding-type': 'array', 'encoding-version': '0.2.0' });
const DICT_ATTRS = Object.freeze({ 'encoding-type': 'dict', 'encoding-version': '0.1.0' });
const STRING_ARRAY_ATTRS = Object.freeze({ 'encoding-type': 'string-array', 'encoding-version': '0.2.0' });

const TYPED_DTYPES = new Map([
  [Int8Array, '|i1'],
  [Uint8Array, '|u1'],
  [Int16Array, '<i2'],
  [Uint16Array, '<u2'],
  [Int32Array, '<i4'],
  [Uint32Array, '<u4'],
  [Float32Array, '<f4'],
  [Float64Array, '<f8'],
  [BigInt64Array, '<i8'],
]);

function arrayMeta(shape, dtype, { fill = 0, filters = null } = {}) {
  return {
    // One chunk holds the whole array (a chunk is never empty).
    chunks: shape.map(length => Math.max(1, length)),
    compressor: null,
    dtype,
    fill_value: fill,
    filters,
    order: 'C',
    shape,
    zarr_format: 2,
  };
}

function vlenUtf8(strings) {
  const encoded = strings.map(text => Buffer.from(String(text), 'utf8'));
  const out = Buffer.alloc(4 + encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0));
  let offset = out.writeUInt32LE(encoded.length, 0);
  for (const bytes of encoded) {
    offset = out.writeUInt32LE(bytes.length, offset);
    offset += bytes.copy(out, offset);
  }
  return out;
}

class StoreWriter {
  constructor() {
    this.files = new Map();
    this.metadata = {};
  }

  json(key, value) {
    this.metadata[key] = value;
    this.files.set(key, Buffer.from(JSON.stringify(value)));
  }

  group(path, attrs) {
    this.json(`${path}.zgroup`, { zarr_format: 2 });
    this.json(`${path}.zattrs`, attrs);
  }

  typed(path, values, shape, attrs = ARRAY_ATTRS) {
    const dtype = TYPED_DTYPES.get(values.constructor);
    if (dtype === undefined) throw new TypeError(`${path}: unsupported array type`);
    this.json(`${path}/.zarray`, arrayMeta(shape, dtype, { fill: dtype.includes('f') ? 0.0 : 0 }));
    this.json(`${path}/.zattrs`, attrs);
    if (values.length > 0) {
      this.files.set(`${path}/${shape.map(() => 0).join('.') || '0'}`, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
    }
  }

  strings(path, values) {
    this.json(`${path}/.zarray`, arrayMeta([values.length], '|O', { filters: [{ id: 'vlen-utf8' }] }));
    this.json(`${path}/.zattrs`, STRING_ARRAY_ATTRS);
    if (values.length > 0) this.files.set(`${path}/0`, vlenUtf8(values));
  }

  /** One `uns` value, as anndata writes it. */
  value(path, value) {
    if (typeof value === 'string') {
      const width = Math.max(1, [...value].length);
      const bytes = Buffer.alloc(width * 4);
      [...value].forEach((char, index) => bytes.writeUInt32LE(char.codePointAt(0), index * 4));
      this.json(`${path}/.zarray`, { ...arrayMeta([], `<U${width}`, { fill: '' }), chunks: [] });
      this.json(`${path}/.zattrs`, { 'encoding-type': 'string', 'encoding-version': '0.2.0' });
      this.files.set(`${path}/0`, bytes);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      const integer = typeof value === 'number' && Number.isInteger(value);
      const bytes = Buffer.alloc(typeof value === 'boolean' ? 1 : 8);
      if (typeof value === 'boolean') bytes.writeUInt8(value ? 1 : 0);
      else if (integer) bytes.writeBigInt64LE(BigInt(value));
      else bytes.writeDoubleLE(value);
      const dtype = typeof value === 'boolean' ? '|b1' : integer ? '<i8' : '<f8';
      this.json(`${path}/.zarray`, { ...arrayMeta([], dtype, { fill: typeof value === 'boolean' ? false : 0 }), chunks: [] });
      this.json(`${path}/.zattrs`, { 'encoding-type': 'numeric-scalar', 'encoding-version': '0.2.0' });
      this.files.set(`${path}/0`, bytes);
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      this.strings(path, value);
    } else if (Array.isArray(value)) {
      const values = value.every(Number.isInteger)
        ? BigInt64Array.from(value, BigInt)
        : Float64Array.from(value);
      this.typed(path, values, [value.length]);
    } else if (ArrayBuffer.isView(value)) {
      this.typed(path, value, [value.length]);
    } else {
      this.group(`${path}/`, DICT_ATTRS);
      for (const [key, item] of Object.entries(value)) this.value(`${path}/${key}`, item);
    }
  }

  dataframe(path, index, columns) {
    this.group(`${path}/`, {
      _index: '_index',
      'column-order': Object.keys(columns),
      'encoding-type': 'dataframe',
      'encoding-version': '0.2.0',
    });
    this.strings(`${path}/_index`, index);
    for (const [name, column] of Object.entries(columns)) {
      if (Array.isArray(column)) {
        this.strings(`${path}/${name}`, column);
      } else if (ArrayBuffer.isView(column)) {
        this.typed(`${path}/${name}`, column, [column.length]);
      } else {
        this.group(`${path}/${name}/`, {
          'encoding-type': 'categorical',
          'encoding-version': '0.2.0',
          ordered: column.ordered === true,
        });
        this.strings(`${path}/${name}/categories`, column.categories);
        this.typed(`${path}/${name}/codes`, column.codes, [column.codes.length]);
      }
    }
  }
}

/** A ZIP of `files` with every entry stored (not compressed). */
function storedZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0x00210000, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * @typedef {{categories: string[], codes: Int8Array|Int16Array|Int32Array|Uint32Array, ordered?: boolean}} Categorical
 *
 * @param {Object} dataset
 * @param {number} dataset.cells
 * @param {string[]} [dataset.genes] - Variable names; no genes writes no X
 * @param {Float32Array|{data: Float32Array, indices: Int32Array, indptr: Int32Array}} [dataset.X] - Dense
 *   cells x genes, row-major (zeros when omitted), or a CSR matrix's arrays (written as `csr_matrix`)
 * @param {Object<string, Categorical|Float32Array|string[]>} [dataset.obs]
 * @param {Object<string, {data: Float32Array, columns: number}>} [dataset.obsm]
 * @param {Object} [dataset.uns] - Plain values: text, numbers, lists, mappings
 * @param {Object<string, Float32Array>} [dataset.layers] - Dense cells x genes, row-major
 * @param {{genes: string[], X: Float32Array}|null} [dataset.raw] - `raw`: its own genes (`raw.var`) and dense X
 * @returns {Buffer} The `.zarr.zip` bytes
 */
export function anndataZarrZip({ cells, genes = [], X = null, obs = {}, obsm = {}, uns = {}, layers = {}, raw = null }) {
  const store = new StoreWriter();
  store.group('', { 'encoding-type': 'anndata', 'encoding-version': '0.1.0' });
  store.dataframe('obs', Array.from({ length: cells }, (_, index) => `cell-${index}`), obs);
  store.dataframe('var', genes, {});
  if (genes.length > 0 && X !== null && !ArrayBuffer.isView(X)) {
    store.group('X/', { 'encoding-type': 'csr_matrix', 'encoding-version': '0.1.0', shape: [cells, genes.length] });
    store.typed('X/data', X.data, [X.data.length]);
    store.typed('X/indices', X.indices, [X.indices.length]);
    store.typed('X/indptr', X.indptr, [X.indptr.length]);
  } else if (genes.length > 0) {
    store.typed('X', X ?? new Float32Array(cells * genes.length), [cells, genes.length]);
  }
  store.group('obsm/', DICT_ATTRS);
  for (const [key, { data, columns }] of Object.entries(obsm)) {
    store.typed(`obsm/${key}`, data, [cells, columns]);
  }
  store.group('layers/', DICT_ATTRS);
  for (const [key, data] of Object.entries(layers)) store.typed(`layers/${key}`, data, [cells, genes.length]);
  if (raw !== null) {
    store.group('raw/', { 'encoding-type': 'raw', 'encoding-version': '0.1.0' });
    store.dataframe('raw/var', raw.genes, {});
    store.typed('raw/X', raw.X, [cells, raw.genes.length]);
  }
  for (const empty of ['obsp', 'varm', 'varp']) store.group(`${empty}/`, DICT_ATTRS);
  store.group('uns/', DICT_ATTRS);
  for (const [key, value] of Object.entries(uns)) store.value(`uns/${key}`, value);
  const sorted = new Map([...store.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  sorted.set('.zmetadata', Buffer.from(JSON.stringify({ metadata: store.metadata, zarr_consolidated_format: 1 })));
  return storedZip(sorted);
}

/**
 * Fulfil one request for a file as a web host serving it does: `HEAD` with
 * its size, a `Range` with 206 and that range, anything else with the whole
 * file.
 */
export function fulfillFile(route, bytes) {
  const request = route.request();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
  };
  if (request.method() === 'HEAD') {
    return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) }, body: '' });
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
  if (range === null) return route.fulfill({ status: 200, headers, body: bytes });
  const start = Number(range[1]);
  const end = Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1);
  return route.fulfill({
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
    body: bytes.subarray(start, end + 1),
  });
}

/**
 * Where entry `name` of a ZIP archive is: its local header (`header`) and
 * its (stored) bytes (`offset`, `length`).
 *
 * @param {Buffer} bytes - The archive
 * @param {string} name - The entry's path inside it
 * @returns {{header: number, offset: number, length: number}}
 */
export function zipEntryData(bytes, name) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index++) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const entryName = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (entryName === name) {
      const local = bytes.readUInt32LE(cursor + 42);
      const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      return { header: local, offset, length: bytes.readUInt32LE(cursor + 20) };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`The archive has no entry ${name}`);
}

/**
 * Serve a one-dataset catalog under `root` (a folder URL): its
 * `datasets.json` and the dataset's `.zarr.zip` built from `dataset`
 * (`anndataZarrZip`, with `uns['cellucid']` stating `id` and `name`), and
 * with `session`, the published default session (`.cellucid-session` bytes)
 * the catalog names for it. Any other request under `root` is answered 404,
 * naming itself.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} root
 * @param {{id: string, name: string, description?: string, session?: Buffer|null} & Object} dataset
 * @returns {Promise<Buffer>} The file's bytes
 */
export async function serveSyntheticCatalog(page, root, { id, name, description, session = null, uns = {}, ...dataset }) {
  const file = `${id}.zarr.zip`;
  const bytes = anndataZarrZip({
    ...dataset,
    uns: {
      ...uns,
      cellucid: {
        schema: 1,
        id,
        name,
        ...(description === undefined ? {} : { description }),
        ...(uns.cellucid ?? {}),
      },
    },
  });
  const sessionFile = `${id}.cellucid-session`;
  const entry = { id, path: file };
  if (session !== null) {
    entry.session = {
      path: sessionFile,
      bytes: session.byteLength,
      sha256: createHash('sha256').update(session).digest('hex'),
    };
  }
  const catalog = JSON.stringify({ schema: 2, default: id, datasets: [entry] });
  const prefix = new URL(root).pathname;
  await page.route(`${root}**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
    } else if (relative === file) {
      await fulfillFile(route, bytes);
    } else if (session !== null && relative === sessionFile) {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: session });
    } else {
      await route.fulfill({
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `Unexpected fixture request: ${pathname}\n`,
      });
    }
  });
  return bytes;
}
