/**
 * The reader's `obsm`: the refusal of a store with nothing to draw, an
 * `obsm` array checked, its rows in slabs and their cost, its selected
 * columns (of the open cells, a range, or listed cells), and the embedding,
 * cell-order digest and vector-field payloads made of them
 * (`embedding-payload.js`, which the reader holds as `_payloads`).
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes no field.
 *
 * @module data/anndata/reader/obsm
 */

import { requireObsmColumnSelection } from '../../data-mapping-candidates.js';
import { isAnnDataNumericValueKind } from '../../anndata-value-kinds.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { isGroup } from '../../../formats/store.js';
import {
  AnnDataFormatError,
  attributeValue,
  child,
  requireMapping,
  shapeOf,
  validateArrayEncoding,
  valueKind,
} from '../elements.js';
import { asNumbers, readRowSlabs, readRowsInStoreOrder, scatterRows } from '../values.js';
import { noEmbeddingRefusal } from '../views/refusal.js';
import { gatheredArray, runsOfPositions } from '../views/cell-subset.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import { requirePositions } from '../positions.js';
import { probeElement } from '../probe.js';

export class AnnDataReaderObsmMethods {
  /**
   * Refuse a store whose `obsm` holds no array of cell coordinates -- no
   * dense numeric array of one or two dimensions with a column -- with the
   * no-embedding refusal every format gives, from the metadata opening
   * loaded: no cell is resolved and no value read for it.
   * (An array listed here whose rows or values cannot be drawn is refused
   * once read, by the data mapping, with its reason.)
   * @this {import('../reader.js').AnnDataReader}
   */
  async _requireEmbedding(readOptions) {
    const probesOf = () => {
      const obsm = child(this._root, 'obsm');
      return isGroup(obsm) ? obsm.keys().map(key => probeElement(key, obsm.get(key))) : [];
    };
    const coordinates = probe => probe.storage === 'dense' && probe.numeric
      && (probe.shape?.length === 1 || (probe.shape?.length === 2 && probe.shape[1] >= 1));
    if (probesOf().some(coordinates)) return;
    // Refused: its groups (a sparse matrix, a table) are loaded to be named.
    await this._ready([{ path: 'obsm', depth: 2 }], readOptions);
    const what = probe => {
      if (probe.storage === 'csr' || probe.storage === 'csc') return 'sparse';
      if (probe.storage === 'dataframe') return 'a table';
      if (probe.storage !== 'dense') return 'not an array';
      if (!probe.numeric) return 'not numeric';
      return probe.shape?.length === 2 ? 'no columns' : 'not one- or two-dimensional';
    };
    const held = probesOf().map(probe => `${probe.key} (${what(probe)})`);
    throw noEmbeddingRefusal(this._name, held.length === 0 ? '' : `Its obsm holds ${held.join(', ')}: no array of cell coordinates.`);
  }

  /**
   * One dense numeric `obsm` array, checked: one row per cell, one or two dimensions.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _obsmArray(key) {
    const label = `obsm['${key}']`;
    const obsm = requireMapping(child(this._root, 'obsm'), this._format, `${this._format.file} obsm mapping`);
    if (!obsm.has(key)) throw new Error(`${label} does not exist in this file`);
    const array = obsm.get(key);
    if (isGroup(array)) {
      // A sparse matrix, a dataframe, an awkward array: named, never misread.
      const encoding = attributeValue(array, 'encoding-type');
      throw new AnnDataFormatError(
        `${label} is ${typeof encoding === 'string' && encoding.length > 0 ? `an '${encoding}' element` : 'a group'}, ` +
        'not a dense array; Cellucid reads embeddings stored as dense numeric arrays'
      );
    }
    if (valueKind(array) === 'string') {
      throw new AnnDataFormatError(`${label} holds text, not numbers; Cellucid reads embeddings stored as dense numeric arrays`);
    }
    validateArrayEncoding(array, this._format, label, 'array');
    const shape = shapeOf(array, label);
    if (shape.length !== 1 && shape.length !== 2) throw new AnnDataFormatError(`${label} must be a one- or two-dimensional array`);
    if (shape[0] !== this._nObs) throw new AnnDataFormatError(`${label} has ${formatCountOf(shape[0], 'row')} but the dataset has ${formatCountOf(this._nObs, 'cell')}`);
    if (!isAnnDataNumericValueKind(valueKind(array))) throw new AnnDataFormatError(`${label} must use a numeric dtype`);
    return { array, shape, width: shape.length === 1 ? 1 : shape[1], label };
  }

  /**
   * Every row of `obsm[key]`, every column, in row order, one slab at a
   * time, so the array is never held whole: `visit(block, rowStart, rowEnd)`
   * receives row-major values (numbers, or BigInts for 64-bit integers) and
   * runs synchronously. `signal` cancels the pass; `kind` and `label` name
   * the activity it runs under (an embedding read, by default).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {(block: ArrayLike<number|bigint>, rowStart: number, rowEnd: number) => void} visit
   * @param {{signal?: AbortSignal|null, kind?: string, label?: string|null}} [options]
   * @returns {Promise<number>} The array's width
   */
  async forEachObsmRowSlab(key, visit, { signal = null, kind = 'embedding', label: activityLabel = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    return this._track(kind, activityLabel ?? label, async readOptions => {
      for await (const slab of readRowSlabs(array, 0, shape[0], readOptions)) {
        this._assertGeneration(generation, `reading ${label}`);
        visit(slab.values, slab.rowStart, slab.rowEnd);
      }
      return width;
    }, signal);
  }

  /**
   * What reading all of `obsm[key]` costs: its stored (compressed) bytes, or
   * null when the store cannot say without reading (a Zarr folder over HTTP
   * lists no sizes), and its bytes as values.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{storedBytes: number|null, valueBytes: number}>}
   */
  async obsmReadCost(key, { signal = null } = {}) {
    this._ensureOpen();
    const { array, shape } = this._obsmArray(key);
    const valueBytes = shape.reduce((product, extent) => product * extent, 1) * (array.dtype?.bytes ?? 8);
    let storedBytes = null;
    if (typeof array.storedBytes === 'function') {
      storedBytes = await array.storedBytes(shape.map(extent => [0, extent]), { signal });
    }
    return { storedBytes: Number.isFinite(storedBytes) ? storedBytes : null, valueBytes };
  }

  /**
   * The selected columns of one dense `obsm` array, unnormalized, one row per
   * cell, `result[row * columns.length + i]`: float32 values for a float32
   * array (exactly as stored, half the bytes), float64 for any other numeric
   * type (64-bit integers converted as `Number` does). Only the
   * selected columns' chunks are read: a selection spanning at most twice
   * its own width is read as one column range, otherwise column by column,
   * every range at once. `signal` cancels the read; `reason` says what the
   * read is for (its activity's label). `cells`: listed open cells alone,
   * in their order (an export's), their rows read in the stored order
   * (`gatheredArray`): never every open row between them (on a uniform
   * share they are every open row, every chunk: 25_decisions_exports.md).
   * @this {import('../reader.js').AnnDataReader}
   */
  async readObsmColumns(key, columns, { signal = null, rows = null, cells = null, reason = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    const selected = requireObsmColumnSelection(columns, width, label);
    if (cells !== null) {
      if (rows !== null) throw new TypeError(`${label} is read for listed cells or a range of rows, not both`);
      const listed = requirePositions(cells, shape[0], `${label} row`);
      const gathered = gatheredArray(array, runsOfPositions(listed), { mergeGapBytes: () => this._mergeGapBytes(), chunks: this._decodedChunks });
      const what = `${label} columns ${selected.join(', ')}, ${formatCountOf(listed.length, 'listed cell')}${reason === null ? '' : ` (${reason})`}`;
      return this._track('embedding', what, readOptions =>
        this._readObsmColumns(gathered, gathered.shape, selected, label, generation, readOptions), signal);
    }
    const asked = this._rowRange(rows, label);
    const range = asked ?? { start: 0, end: shape[0] };
    // The activity names the open cells read and what for, so a trace tells
    // a growth step's added rows from a whole read.
    const what = `${label} columns ${selected.join(', ')}`
      + (asked === null ? `, every open cell` : `, open cells ${formatCount(asked.start)}–${formatCount(asked.end)}`)
      + (reason === null ? '' : ` (${reason})`);
    return this._track('embedding', what, readOptions =>
      this._readObsmColumns(array, shape, selected, label, generation, readOptions, range), signal);
  }

  /** @this {import('../reader.js').AnnDataReader} @private */
  async _readObsmColumns(array, shape, selected, label, generation, readOptions, { start: firstRow, end: endRow } = { start: 0, end: shape[0] }) {
    const nRows = endRow - firstRow;
    const nColumns = selected.length;
    const stored32 = valueKind(array) === 'float' && array.dtype?.bytes === 4;
    /** @type {import('../../../utils/large-arrays.js').TypedArrayConstructor<Float32Array|Float64Array>} */
    const ValuesType = stored32 ? Float32Array : Float64Array;
    const result = allocateTypedArray(ValuesType, nRows * nColumns, label);
    // Rows in the order the store reads them fastest (a view's in the
    // stored order, `readRowsInStoreOrder`), each put in its place.
    if (shape.length === 1) {
      for await (const { values, runs } of readRowsInStoreOrder(array, firstRow, endRow, readOptions)) {
        // 64-bit integers (Visium or Xenium pixel coordinates) through their words.
        scatterRows(asNumbers(values, label), 1, runs, result, firstRow);
      }
    } else {
      const first = Math.min(...selected);
      const last = Math.max(...selected) + 1;
      const ranges = last - first <= 2 * nColumns
        ? [[first, last, selected.map((column, index) => [column, index])]]
        : selected.map((column, index) => [column, column + 1, [[column, index]]]);
      await Promise.all(ranges.map(async ([from, to, picks]) => {
        const blockWidth = to - from;
        // Every column of the range asked for, in order: a slab is already
        // laid out as the output is.
        const whole = blockWidth === nColumns && picks.every(([column, output], i) => column === from + i && output === i);
        for await (const { values, runs } of readRowsInStoreOrder(array, firstRow, endRow, { ...readOptions, columns: [from, to] })) {
          const block = asNumbers(values, label);
          if (whole) {
            scatterRows(block, nColumns, runs, result, firstRow);
            continue;
          }
          if (runs.rows !== undefined) {
            // A row a value row (`readRowsInStoreOrder`).
            for (let row = 0; row < runs.rows.length; row++) {
              const at = (runs.rows[row] - firstRow) * nColumns;
              for (const [column, outputColumn] of picks) result[at + outputColumn] = block[row * blockWidth + column - from];
            }
            continue;
          }
          for (let r = 0; r < runs.count; r++) {
            const at = runs.starts[r] - firstRow - runs.offsets[r];
            for (const [column, outputColumn] of picks) {
              const offset = column - from;
              for (let row = runs.offsets[r]; row < runs.offsets[r + 1]; row++) {
                result[(at + row) * nColumns + outputColumn] = block[row * blockWidth + offset];
              }
            }
          }
        }
      }));
    }
    this._assertGeneration(generation, `reading ${label}`);
    return result;
  }

  /**
   * One embedding's display coordinates, checked and normalized here
   * (`EmbeddingPayloads.embedding`), with their display transform and
   * bounds. `signal` cancels the read.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, pieces?: import('../../embedding-payload.js').PieceSinks}} [options] -
   *   `rows`: only rows `[start, end)` of the open cells, in the embedding's
   *   frame (`EmbeddingPayloads.embedding`); `pieces`: where the
   *   coordinates go as they are made (`EmbeddingPayloads.embedding`)
   * @returns {Promise<import('../../embedding-payload.js').EmbeddingPayload>}
   */
  readEmbedding(key, columns, normalize, { signal = null, rows = null, pieces = undefined } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obsm['${key}']`);
    return this._payloads.embedding(key, [...columns], normalize, { signal, rows: range === null ? null : [range.start, range.end], pieces });
  }

  /**
   * The cell-order digest of one embedding over the open cells
   * (`cell-order-digest.js`, `EmbeddingPayloads.cellOrderDigest`): its
   * stored values, each cell named by its original position, summed as
   * they were read. `signal` cancels what is read for it.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<string>}
   */
  readCellOrderDigest(key, columns, { signal = null } = {}) {
    this._ensureOpen();
    const { width, label } = this._obsmArray(key);
    return this._payloads.cellOrderDigest(key, [...requireObsmColumnSelection(columns, width, label)], { signal });
  }

  /**
   * One vector field's display vectors, scaled here by the transform of the
   * embedding it is bound to (`EmbeddingPayloads.vectors`), with the largest
   * magnitude. `signal` cancels the reads.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{key: string, columns: ReadonlyArray<number>}} embedding
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, pieces?: import('../../embedding-payload.js').PieceSinks}} [options] -
   *   `pieces`: where the vectors go as they are made (`EmbeddingPayloads.vectors`)
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number, unplacedCount: number, unplacedNames: string[]}>}
   *   `unplacedCount`: cells without a vector, the first named
   */
  readVectorField(key, columns, embedding, normalize, { signal = null, rows = null, pieces = undefined } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obsm['${key}']`);
    return this._payloads.vectors(
      key,
      [...columns],
      { key: embedding.key, columns: [...embedding.columns] },
      normalize,
      { signal, rows: range === null ? null : [range.start, range.end], pieces }
    );
  }
}
