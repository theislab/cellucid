/**
 * The AnnData elements, written from values in hand: dataframes and their
 * column kinds, `uns` values, sparse matrices, scalars. The encodings are
 * anndata's (every element's `encoding-type` and `encoding-version`, as
 * anndata 0.12 writes them and `elements.js` / `dataframe.js` read them).
 *
 * The element layer of the app's Zarr writers: where an array goes is a
 * subclass's (`group`, `array`, `strings`). (The highlighted cells' `.h5ad`
 * export, `app/exports/cell-exports.js`, still builds its HDF5 tree with
 * `formats/hdf5/writer.js` directly; an HDF5 subclass here is the step that
 * makes this layer every writer's.)
 *
 * - `transcode/zarr-writer.js` `AnnDataStoreWriter`: a store kept in this
 *   browser, its arrays uncompressed regions of the transcode space;
 * - `write/ready-writer.js` `CellucidReadyWriter`: a Cellucid-ready AnnData
 *   streamed as a `.zarr.zip`, its arrays chunked and compressed as the
 *   specification lays them out.
 *
 * Each array is written with its **role** (`write/layout.js`), the way it is
 * read, which a writer that lays arrays out for reading chunks it by
 * (`cell`: one value per cell; `whole`: read whole; `gene-entries`: the
 * entries of a gene-major matrix; `cell-rows`: an embedding's rows;
 * `gene-strips`: a dense expression matrix), and `expression` for the values
 * of an expression matrix (never byte-shuffled). A writer that lays arrays
 * out by its own rule ignores both.
 *
 * @module data/anndata/write/element-writer
 */

import { requireDistinctElementKeys, requireElementKey } from './names.js';

const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/** anndata's encoding attributes of `type` at `version`. */
export { encoding as encodingAttributes };

/**
 * @typedef {Object} ArraySpec
 * @property {ArrayBufferView} [values] - The values, host order
 * @property {Object} [region] - A region of the transcode space (its `dtype` given)
 * @property {string} [dtype] - The Zarr dtype (default: of `values`)
 * @property {number[]} [shape] - Default: one dimension
 * @property {'C'|'F'} [order]
 * @property {Object} [attrs]
 * @property {string} [role] - How the array is read (`layout.js` `ROLES`)
 * @property {boolean} [expression] - The values of an expression matrix
 */

export class AnnDataElementWriter {
  /**
   * A group, with its attributes.
   *
   * @abstract
   * @param {string} path - `''` for the root
   * @param {Object} [attrs]
   */
  group(path, attrs) {
    throw new TypeError(`${this.constructor.name} does not write groups (${path}, ${Object.keys(attrs ?? {}).length} attributes).`);
  }

  /**
   * A numeric or boolean array.
   *
   * @abstract
   * @param {string} path
   * @param {ArraySpec} spec
   * @returns {Promise<void>}
   */
  async array(path, spec) {
    throw new TypeError(`${this.constructor.name} does not write arrays (${path}, as ${Object.keys(spec).join(', ')} ask).`);
  }

  /**
   * A string array (`vlen-utf8`), or with `{scalar: true}` the one string of
   * a 0-dimensional array.
   *
   * @abstract
   * @param {string} path
   * @param {Array<string|null>} values
   * @param {Object} [attrs]
   * @param {{role?: string, scalar?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async strings(path, values, attrs, options) {
    throw new TypeError(`${this.constructor.name} does not write strings (${path}, ${values.length}, ${attrs}, ${options}).`);
  }

  /** A `dict` group (`obsm`, `layers`, `uns`, ...). */
  dict(path) {
    this.group(path, encoding('dict', '0.1.0'));
  }

  /** A boolean array (`|b1`) from 0/1 bytes. */
  async booleans(path, bytes, attrs = encoding('array', '0.2.0'), role = 'whole') {
    await this.array(path, { values: bytes, dtype: '|b1', attrs, role });
  }

  /** A text array (`string-array`). */
  async stringArray(path, values, role = 'whole') {
    await this.strings(path, values, encoding('string-array', '0.2.0'), { role });
  }

  /** A scalar string (`encoding-type: string`). */
  async string(path, value) {
    await this.strings(path, [value], encoding('string', '0.2.0'), { scalar: true });
  }

  /**
   * A scalar number (`encoding-type: numeric-scalar`): a whole number `<i8`
   * (as NumPy and cellucid-python write one, specification §1), any other
   * `<f8`, a boolean `|b1`.
   */
  async number(path, value) {
    if (typeof value === 'boolean') {
      await this.array(path, { values: Uint8Array.of(value ? 1 : 0), dtype: '|b1', shape: [], attrs: encoding('numeric-scalar', '0.2.0') });
    } else if (Number.isSafeInteger(value)) {
      await this.array(path, { values: BigInt64Array.of(BigInt(value)), shape: [], attrs: encoding('numeric-scalar', '0.2.0') });
    } else {
      await this.array(path, { values: Float64Array.of(value), shape: [], attrs: encoding('numeric-scalar', '0.2.0') });
    }
  }

  /**
   * A JSON-like value under `uns`: a record becomes a dict, a string or
   * number a scalar, a list of strings a string array, a list of numbers an
   * array. `null` is no value (left out: a transcoder's optional key);
   * anything else uns cannot hold (a mixed or nested list, a class
   * instance, a BigInt) is refused, never left out unsaid.
   */
  async unsValue(path, value) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') return this.string(path, value);
    if (typeof value === 'number' || typeof value === 'boolean') return this.number(path, value);
    if (Array.isArray(value)) {
      if (value.every(item => typeof item === 'string' || item === null)) return this.stringArray(path, value);
      if (value.every(item => typeof item === 'number')) return this.array(path, { values: Float64Array.from(value) });
      if (value.every(item => typeof item === 'boolean')) return this.booleans(path, Uint8Array.from(value, Number));
      // Never left out unsaid: a writer checks what it hands here (`write/changes.js` `requireUnsValue`).
      throw new TypeError(`${path} is a list uns cannot hold: text, numbers or booleans, one kind of them.`);
    }
    if (ArrayBuffer.isView(value)) return this.array(path, { values: value });
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${path} is a ${typeof value === 'object' ? value.constructor?.name : typeof value}, which uns cannot hold.`);
    }
    this.dict(path);
    for (const [key, item] of Object.entries(value)) await this.unsValue(`${path}/${key}`, item);
    return undefined;
  }

  /**
   * A dataframe: an index and columns (the kinds `column()` writes), each
   * named as a store element must be (`names.js`): a caller writing names it
   * did not choose gives each its `portableElementName` first, and says so.
   *
   * @param {string} path
   * @param {{index: Array<string>, columns: Array<{name: string, column: Object}>}} frame
   * @param {{role?: string}} [options] - `cell` for obs (one value per cell), `whole` for var
   */
  async dataframe(path, { index, columns }, { role = 'whole' } = {}) {
    const names = columns.map(({ name }) => requireElementKey(name, `The ${path} column`));
    requireDistinctElementKeys(['_index', ...names], `The ${path} column`);
    this.group(path, { '_index': '_index', 'column-order': names, ...encoding('dataframe', '0.2.0') });
    await this.stringArray(`${path}/_index`, index, role);
    for (const { name, column } of columns) await this.column(`${path}/${name}`, column, role);
  }

  /**
   * One dataframe column:
   *
   * - `{kind: 'numbers', values|region, dtype}` → array;
   * - `{kind: 'booleans', values: Uint8Array}` → bool array;
   * - `{kind: 'nullable-integer'|'nullable-boolean', values, mask: Uint8Array}`;
   * - `{kind: 'categorical', codes: Int8Array|Int16Array|Int32Array, categories, ordered}`;
   * - `{kind: 'strings', values}` → string array.
   *
   * @param {string} path
   * @param {Object} column
   * @param {string} [role] - `cell` for an obs column, `whole` for a var column
   */
  async column(path, column, role = 'whole') {
    switch (column.kind) {
      case 'numbers':
        return this.array(path, { ...column, role });
      case 'booleans':
        return this.booleans(path, column.values, undefined, role);
      case 'nullable-integer':
      case 'nullable-boolean':
        this.group(path, encoding(column.kind, '0.1.0'));
        if (column.kind === 'nullable-integer') await this.array(`${path}/values`, { values: column.values, role });
        else await this.booleans(`${path}/values`, column.values, undefined, role);
        return this.booleans(`${path}/mask`, column.mask, undefined, role);
      case 'categorical':
        this.group(path, { ordered: column.ordered === true, ...encoding('categorical', '0.2.0') });
        await this.array(`${path}/codes`, { values: column.codes, role });
        return this.stringArray(`${path}/categories`, column.categories, 'whole');
      case 'strings':
        return this.stringArray(path, column.values, role);
      default:
        throw new TypeError(`Unknown column kind '${column.kind}'.`);
    }
  }

  /**
   * A compressed sparse matrix group: `csr_matrix` or `csc_matrix`.
   *
   * @param {string} path
   * @param {{format: 'csr'|'csc', shape: [number, number], data: Object, indices: Object, indptr: Object}} matrix
   *   Each part `{values}` or `{region, dtype}`
   * @param {{expression?: boolean}} [options] - A gene-major expression matrix:
   *   its entries chunked for a gene's range (`gene-entries`), its values unshuffled
   */
  async sparse(path, { format, shape, data, indices, indptr }, { expression = false } = {}) {
    this.group(path, { shape, ...encoding(`${format}_matrix`, '0.1.0') });
    const role = expression ? 'gene-entries' : 'whole';
    await this.array(`${path}/data`, { ...data, attrs: {}, role, expression });
    await this.array(`${path}/indices`, { ...indices, attrs: {}, role });
    await this.array(`${path}/indptr`, { ...indptr, attrs: {}, role: 'whole' });
  }
}
