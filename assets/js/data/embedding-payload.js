/**
 * Embedding and vector-field payloads, made in the AnnData reader worker
 * beside the `obsm` arrays they come from, so the page receives coordinates
 * ready to draw and never walks them.
 *
 * An embedding's selected columns are checked (every value finite and
 * representable as float32, and, normalized, a non-zero range) and turned
 * into display coordinates in two passes, the second writing float32:
 *
 * - normalized (the default): Cellucid's one rule -- centred per axis, one
 *   `2 / max(axis ranges)` scale for every axis, computed at the stored
 *   precision and rounded to float32 once. The display transform of the
 *   result is the identity.
 * - `normalizeEmbeddings: false` (a launch asking for a file's own
 *   coordinates): the stored values rounded to float32, then fitted to the
 *   view as the renderer fits any coordinates (`normalizePositions`,
 *   `rendering/gl-utils.js`), whose transform is reported so figure axes,
 *   centroids and vectors map the coordinates the file holds.
 *
 * Every payload carries its per-axis bounds, so the page does not scan for
 * them. A vector field bound to an embedding is scaled by that embedding's
 * transform in one pass, with its largest magnitude.
 *
 * Both are made in pieces of at most `COORDINATE_PIECE_CELLS` cells: the
 * stored values are read by row range, piece by piece, and each piece of
 * coordinates or vectors is handed to a sink as soon as it is made (the
 * reader worker posts it to the page, `utils/large-arrays.js`
 * `PieceSender`), so no array of the whole embedding is ever made in the
 * worker, and the page assembles one that may exceed an `ArrayBuffer`
 * (3-D positions above 178.8M cells on Chromium). Without a sink the pieces
 * are assembled here (`ArrayAssembly`); one piece is the array itself.
 *
 * @module data/embedding-payload
 */

import { EmbeddingLoadError, MappingLoadError } from './data-mapping-candidates.js';
import { allocateTypedArray } from './sparse-column-index.js';
import { ArrayAssembly } from '../utils/large-arrays.js';

/**
 * Cells in one piece of an embedding or vector field: the point store's
 * segment (`rendering/high-perf/point-store-segments.js`), 192 MiB of 3-D
 * float32 coordinates, under every engine's `ArrayBuffer` cap.
 */
export const COORDINATE_PIECE_CELLS = 2 ** 24;

/**
 * Where the pieces of one array go: `put(offset, values)` takes each piece
 * (offset in elements; the sink owns `values` from then on), `result` is
 * what the payload carries once every piece was put.
 *
 * @typedef {{put: (offset: number, values: Float32Array) => void, result: *}} PieceSink
 * @typedef {(ArrayType: Float32ArrayConstructor, length: number) => PieceSink} PieceSinks
 */

/** @type {PieceSinks} The pieces assembled here into one array. */
export function assembledPieces(ArrayType, length) {
  const assembly = new ArrayAssembly(ArrayType, length);
  return {
    put: (offset, values) => assembly.put(offset, values),
    get result() { return assembly.result; },
  };
}

/**
 * The first value Cellucid cannot read, as `valueLoadDefect` names it
 * (`data-mapping-candidates.js`), or null.
 */
function valueDefect(value, cell) {
  if (Number.isNaN(value)) return `NaN at cell ${cell}`;
  if (value === Infinity) return `Infinity at cell ${cell}`;
  if (value === -Infinity) return `-Infinity at cell ${cell}`;
  const narrowed = Math.fround(value);
  if (!Number.isFinite(narrowed) || (value !== 0 && narrowed === 0)) {
    return `not representable as float32 at cell ${cell}`;
  }
  return null;
}

function requireWidth(values, width) {
  if (!Number.isSafeInteger(width) || width < 1 || width > 3) {
    throw new TypeError('An embedding has 1, 2 or 3 columns.');
  }
  if (values.length % width !== 0) {
    throw new RangeError('Array values do not fill whole cells.');
  }
}

/**
 * Pass 1 over an embedding's values, piece by piece: the first defect, else
 * each axis's minimum and maximum, and the transform from stored to display
 * coordinates.
 *
 * @param {ReadonlyArray<{first: number, values: Float32Array|Float64Array}>} pieces -
 *   Row-major, `width` values a cell; `first` numbers a piece's first cell
 * @param {number} width
 * @param {boolean} normalize
 * @returns {{defect: string|null, transform: EmbeddingTransform|null}}
 */
function embeddingTransformOf(pieces, width, normalize) {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  let nCells = 0;
  for (const { first, values } of pieces) {
    requireWidth(values, width);
    const cells = values.length / width;
    nCells += cells;
    // A float32 value is representable as float32: only NaN and the
    // infinities can be refused.
    const stored32 = values instanceof Float32Array;
    for (let cell = 0, index = 0; cell < cells; cell++) {
      for (let axis = 0; axis < width; axis++, index++) {
        const value = values[index];
        if (!(value > -Infinity && value < Infinity)) return { defect: valueDefect(value, first + cell), transform: null };
        if (!stored32) {
          const narrowed = Math.fround(value);
          if (narrowed === Infinity || narrowed === -Infinity || (narrowed === 0 && value !== 0)) {
            return { defect: valueDefect(value, first + cell), transform: null };
          }
        }
        if (value < mins[axis]) mins[axis] = value;
        if (value > maxs[axis]) maxs[axis] = value;
      }
    }
  }
  if (nCells === 0) {
    return {
      defect: null,
      transform: { centers: [0, 0, 0].slice(0, width), scale: 1, display: { center: [0, 0, 0], scale: 1 }, vectorScale: 1, roundFirst: !normalize },
    };
  }
  if (normalize) {
    let maxRange = 0;
    for (let axis = 0; axis < width; axis++) maxRange = Math.max(maxRange, maxs[axis] - mins[axis]);
    if (!(maxRange > 0)) return { defect: 'no coordinate variation', transform: null };
    return {
      defect: null,
      transform: {
        centers: mins.slice(0, width).map((min, axis) => (min + maxs[axis]) / 2),
        scale: 2 / maxRange,
        display: { center: [0, 0, 0], scale: 1 },
        vectorScale: 2 / maxRange,
        roundFirst: false,
      },
    };
  }
  // The stored values rounded to float32 (rounding is monotonic, so their
  // bounds are the rounded bounds), fitted as `normalizePositions` fits them.
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let axis = 0; axis < width; axis++) {
    lo[axis] = Math.fround(mins[axis]);
    hi[axis] = Math.fround(maxs[axis]);
  }
  const center = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2])];
  let maxRange = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (maxRange === 0) maxRange = 1.0;
  const scale = 2.0 / maxRange;
  return {
    defect: null,
    transform: {
      centers: center.slice(0, width),
      scale,
      display: { center, scale },
      vectorScale: scale,
      roundFirst: true,
    },
  };
}

/**
 * @typedef {Object} EmbeddingTransform
 * @property {number[]} [centers] - Subtracted from the stored values, per axis
 * @property {number} [scale] - Then multiplied by
 * @property {{center: number[], scale: number}} display - The transform from
 *   the coordinates the file holds to the ones shown (`getNormTransform`):
 *   the identity for normalized coordinates, the fit for a file's own
 * @property {number} vectorScale - What a bound vector field is multiplied by
 * @property {boolean} roundFirst - Whether a bound vector is rounded to
 *   float32 before it is scaled (as the coordinates are)
 */

/**
 * @typedef {Object} EmbeddingPayload
 * @property {Float32Array} positions - Display coordinates, `width` a cell
 * @property {{center: number[], scale: number}} transform - Its display transform
 * @property {{min: number[], max: number[]}|null} bounds - Per-axis bounds of
 *   `positions` (three components, zero for absent axes), null for no cells
 */

/**
 * An embedding's display coordinates (`EmbeddingPayload`), or the defect
 * that refuses it.
 *
 * @param {Float32Array|Float64Array} values - The selected columns, row-major
 * @param {number} width
 * @param {boolean} normalize
 * @returns {{defect: string}|(EmbeddingPayload & {defect: null, vectorTransform: EmbeddingTransform})}
 */
export function embeddingPayloadOf(values, width, normalize) {
  const pieces = [{ first: 0, values }];
  const { defect, transform } = embeddingTransformOf(pieces, width, normalize);
  if (defect !== null) return { defect };
  return { defect: null, ...coordinatesOfPieces(pieces, width, transform, normalize, assembledPieces), transform: transform.display, vectorTransform: transform };
}

/**
 * The first value of some cells of an embedding that `embeddingPayloadOf`
 * would refuse, named as it names it (`firstCell` numbers the first cell),
 * or null.
 *
 * @param {Float32Array|Float64Array} values
 * @param {number} width
 * @param {number} firstCell
 * @returns {string|null}
 */
function rowsDefect(values, width, firstCell) {
  requireWidth(values, width);
  const stored32 = values instanceof Float32Array;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const cell = firstCell + Math.floor(index / width);
    if (!(value > -Infinity && value < Infinity)) return valueDefect(value, cell);
    if (!stored32) {
      const narrowed = Math.fround(value);
      if (narrowed === Infinity || narrowed === -Infinity || (narrowed === 0 && value !== 0)) return valueDefect(value, cell);
    }
  }
  return null;
}

/**
 * Display coordinates of checked pieces under `transform`, each piece made,
 * handed to its sink and its stored values let go in turn, with the
 * per-axis bounds of all of them (null for no cells).
 *
 * @param {Array<{first: number, values: Float32Array|Float64Array}|null>} pieces - Emptied as they are written
 * @param {number} width
 * @param {EmbeddingTransform} transform
 * @param {boolean} normalize
 * @param {PieceSinks} sinks
 * @returns {{positions: *, bounds: {min: number[], max: number[]}|null}}
 */
function coordinatesOfPieces(pieces, width, transform, normalize, sinks) {
  const total = pieces.reduce((sum, piece) => sum + piece.values.length, 0);
  const sink = sinks(Float32Array, total);
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    const { positions, bounds } = displayCoordinatesOf(pieces[i].values, width, transform, normalize);
    pieces[i] = null;
    if (bounds !== null) {
      for (let axis = 0; axis < width; axis++) {
        min[axis] = offset === 0 ? bounds.min[axis] : Math.min(min[axis], bounds.min[axis]);
        max[axis] = offset === 0 ? bounds.max[axis] : Math.max(max[axis], bounds.max[axis]);
      }
    }
    sink.put(offset, positions);
    offset += positions.length;
  }
  return { positions: sink.result, bounds: total === 0 ? null : { min, max } };
}

/** The display coordinates of checked values under `transform`, with their per-axis bounds. */
function displayCoordinatesOf(values, width, transform, normalize) {
  const positions = allocateTypedArray(Float32Array, values.length, 'Embedding coordinates');
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  const nCells = values.length / width;
  for (let axis = 0; axis < width; axis++) {
    let lo = Infinity;
    let hi = -Infinity;
    if (normalize) {
      const center = transform.centers[axis];
      const scale = transform.scale;
      for (let index = axis; index < values.length; index += width) {
        positions[index] = (values[index] - center) * scale;
        const shown = positions[index];
        if (shown < lo) lo = shown;
        if (shown > hi) hi = shown;
      }
    } else {
      const center = transform.centers[axis];
      const scale = transform.scale;
      for (let index = axis; index < values.length; index += width) {
        positions[index] = (Math.fround(values[index]) - center) * scale;
        const shown = positions[index];
        if (shown < lo) lo = shown;
        if (shown > hi) hi = shown;
      }
    }
    min[axis] = lo;
    max[axis] = hi;
  }
  return { positions, bounds: nCells === 0 ? null : { min, max } };
}

/**
 * A vector field's display vectors: each stored component scaled by its
 * embedding's transform (`vectorScale`, after rounding to float32 when the
 * embedding's coordinates were), rounded to float32 once, with the largest
 * vector's magnitude. A value Cellucid cannot read is named as
 * `valueLoadDefect` names it, before any overflow.
 *
 * @param {Float32Array|Float64Array} values - Row-major, `width` components a cell
 * @param {number} width
 * @param {EmbeddingTransform} transform
 * @param {number} [firstCell=0] - The cell of `values[0]`: a defect names
 *   its cell and an overflow its flat index from there
 * @returns {{defect: string|null, overflow: number|null, vectors: Float32Array|null, maxMagnitude: number}}
 */
export function vectorPayloadOf(values, width, { vectorScale, roundFirst }, firstCell = 0) {
  requireWidth(values, width);
  const vectors = allocateTypedArray(Float32Array, values.length, 'Vector field');
  let overflow = null;
  let maxMagnitudeSquared = 0;
  for (let start = 0; start < values.length; start += width) {
    let magnitudeSquared = 0;
    for (let index = start; index < start + width; index++) {
      const raw = values[index];
      if (!(raw === raw && raw !== Infinity && raw !== -Infinity)) {
        return { defect: valueDefect(raw, firstCell + start / width), overflow: null, vectors: null, maxMagnitude: 0 };
      }
      const rounded = Math.fround(raw);
      if (raw !== 0 && (rounded === 0 || !Number.isFinite(rounded))) {
        return { defect: valueDefect(raw, firstCell + start / width), overflow: null, vectors: null, maxMagnitude: 0 };
      }
      const scaled = (roundFirst ? rounded : raw) * vectorScale;
      vectors[index] = scaled;
      const shown = vectors[index];
      if (overflow === null && (!Number.isFinite(scaled) || !Number.isFinite(shown))) overflow = firstCell * width + index;
      magnitudeSquared += shown * shown;
    }
    if (overflow === null && !Number.isFinite(magnitudeSquared)) overflow = firstCell * width + start;
    if (magnitudeSquared > maxMagnitudeSquared) maxMagnitudeSquared = magnitudeSquared;
  }
  if (overflow !== null) return { defect: null, overflow, vectors: null, maxMagnitude: 0 };
  return { defect: null, overflow: null, vectors, maxMagnitude: Math.sqrt(maxMagnitudeSquared) };
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

/**
 * The embedding and vector payloads of one open dataset. An embedding's
 * transform is remembered once known, so a vector field bound to it is
 * scaled without reading the embedding again; a vector field asked for while
 * its embedding is read waits for that read's transform, both reads in
 * flight together.
 */
export class EmbeddingPayloads {
  /**
   * @param {(key: string, columns: number[], options: {signal?: AbortSignal|null, rows?: [number, number]}) => Promise<Float32Array|Float64Array>} readObsmColumns
   *   The stored values of one `obsm` array's columns, row-major: float32
   *   for a float32 array, else float64; `rows` reads only open cells
   *   `[start, end)`.
   * @param {Object} options
   * @param {() => number} options.cellCount - The open cells (rows of every `obsm` array).
   * @param {() => number} [options.generation] - Changes when what was read is
   *   stale (the reader's caches were cleared, another file adopted): every
   *   remembered transform is then forgotten.
   * @param {number} [options.pieceCells=COORDINATE_PIECE_CELLS] - Cells a
   *   piece holds (tests use fewer, to make pieces at sizes that fit).
   */
  constructor(readObsmColumns, { cellCount, generation = () => 0, pieceCells = COORDINATE_PIECE_CELLS }) {
    if (typeof cellCount !== 'function') throw new TypeError('Embedding payloads need the count of open cells.');
    if (!Number.isSafeInteger(pieceCells) || pieceCells < 1) throw new RangeError(`A piece holds 1 or more cells, not ${pieceCells}.`);
    this._read = readObsmColumns;
    this._cellCount = cellCount;
    this._pieceCells = pieceCells;
    this._currentGeneration = generation;
    this._readerGeneration = generation();
    /** @type {Map<string, Promise<EmbeddingTransform>>} */
    this._transforms = new Map();
    /**
     * Embedding payloads a vector field read before anyone asked for them
     * (its embedding was not read yet), waiting for the embedding request
     * that follows, which takes them instead of reading again.
     * @type {Map<string, Promise<Object>>}
     */
    this._handoffs = new Map();
    /**
     * The embeddings whose transform was taken from an earlier opening
     * (`adoptTransforms`): read whole, they are shown in it too.
     * @type {Set<string>}
     */
    this._adopted = new Set();
    this._generation = 0;
  }

  /**
   * The stored values of open cells `[start, end)` (`rows` null: every open
   * cell) of one `obsm` array's columns, in pieces of at most
   * `COORDINATE_PIECE_CELLS` cells (`pieceCells`) read by row range: no
   * array of more is ever made. @private
   *
   * @returns {Promise<Array<{first: number, values: Float32Array|Float64Array}>>}
   */
  async _readPieces(key, columns, rows, signal, reason) {
    const [start, end] = rows ?? [0, this._cellCount()];
    if (end - start <= this._pieceCells) {
      return [{ first: start, values: await this._read(key, columns, rows === null ? { signal, reason } : { signal, rows, reason }) }];
    }
    const ranges = [];
    for (let first = start; first < end; first += this._pieceCells) {
      ranges.push([first, Math.min(end, first + this._pieceCells)]);
    }
    return Promise.all(ranges.map(async range => ({ first: range[0], values: await this._read(key, columns, { signal, rows: range, reason }) })));
  }

  /**
   * Read and make one embedding's payload, its coordinates handed to
   * `sinks` piece by piece; a defect is its `EmbeddingLoadError`. @private
   */
  async _makePayload(key, columns, normalize, signal, sinks = assembledPieces) {
    const pieces = await this._readPieces(key, columns, null, signal, 'embedding');
    const { defect, transform } = embeddingTransformOf(pieces, columns.length, normalize);
    if (defect !== null) throw new EmbeddingLoadError(key, columns, defect);
    const { positions, bounds } = coordinatesOfPieces(pieces, columns.length, transform, normalize, sinks);
    return { positions, bounds, transform: transform.display, vectorTransform: transform };
  }

  /** Forget everything remembered once the reader's generation moved. @private */
  _sync() {
    const current = this._currentGeneration();
    if (current !== this._readerGeneration) {
      this._readerGeneration = current;
      this.clear();
    }
  }

  _remember(refKey, transform, generation) {
    if (generation !== this._generation) return;
    this._transforms.set(refKey, transform);
    transform.catch(() => {
      if (this._transforms.get(refKey) === transform) this._transforms.delete(refKey);
    });
  }

  /**
   * One embedding's payload. A defect is an `EmbeddingLoadError` naming the
   * key, its columns and the first offending cell.
   *
   * @param {string} key
   * @param {number[]} columns
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, pieces?: PieceSinks}} [options] -
   *   `rows`: only rows `[start, end)` of the open cells, under the
   *   embedding's transform (`_rows`); `pieces`: where the coordinates go
   *   as they are made (the payload's `positions` is its sink's `result`),
   *   by default assembled into one array here
   * @returns {Promise<EmbeddingPayload>}
   */
  async embedding(key, columns, normalize, { signal = null, rows = null, pieces = assembledPieces } = {}) {
    this._sync();
    if (rows !== null) return this._rows(key, columns, normalize, rows, signal, pieces);
    const refKey = JSON.stringify([key, columns, normalize]);
    const handoff = this._handoffs.get(refKey);
    if (handoff !== undefined) {
      this._handoffs.delete(refKey);
      try {
        const { positions, transform, bounds } = await handoff;
        return { positions, transform, bounds };
      } catch (error) {
        // The vector field's read was cancelled: this one reads for itself.
        if (!isAbort(error) || signal?.aborted) throw error;
      }
    }
    // The transform of the opening this one grew or was cut from
    // (`adoptTransforms`) is the one the cells are shown in.
    if (this._adopted.has(refKey)) return this._rows(key, columns, normalize, null, signal, pieces);
    const work = this._makePayload(key, columns, normalize, signal, pieces);
    this._remember(refKey, work.then(payload => payload.vectorTransform), this._generation);
    const { positions, transform, bounds } = await work;
    return { positions, transform, bounds };
  }

  /**
   * Rows `[start, end)` of the open cells of one embedding (`rows` null:
   * every cell), under the embedding's transform (remembered, or made by
   * reading it whole): coordinates of cells an opening grown in place
   * appends, in the frame of the cells already shown. @private
   */
  async _rows(key, columns, normalize, rows, signal, sinks) {
    const transform = await this._transformOf(key, columns, normalize, signal);
    // A whole read made for the transform waits for nobody else now.
    this._handoffs.delete(JSON.stringify([key, columns, normalize]));
    const pieces = await this._readPieces(key, columns, rows, signal, rows === null ? 'embedding' : 'embedding, cells added');
    for (const { first, values } of pieces) {
      const defect = rowsDefect(values, columns.length, first);
      if (defect !== null) throw new EmbeddingLoadError(key, columns, defect);
    }
    const { positions, bounds } = coordinatesOfPieces(pieces, columns.length, transform, normalize, sinks);
    return { positions, transform: transform.display, bounds };
  }

  /**
   * Take the transforms `previous` (the payloads of an earlier opening of
   * the same store) made: an opening whose first cells are all of the
   * earlier one's, or whose cells are all among its first (an opening grown
   * or cut in place, `AnnDataReader.open`, `carry`), shows every embedding
   * in the frame the cells were first shown in, so no cell moves.
   *
   * @param {EmbeddingPayloads} previous
   */
  adoptTransforms(previous) {
    this._sync();
    for (const [refKey, transform] of previous._transforms) {
      this._remember(refKey, transform, this._generation);
      this._adopted.add(refKey);
    }
  }

  /**
   * The transform of one embedding: remembered, being read, else read for
   * it -- the whole payload, handed to the embedding request that follows
   * (a layout and its vector field are asked for together). @private
   */
  async _transformOf(key, columns, normalize, signal) {
    const refKey = JSON.stringify([key, columns, normalize]);
    const known = this._transforms.get(refKey);
    if (known !== undefined) {
      try {
        return await known;
      } catch (error) {
        // Another caller's read was cancelled: this one reads for itself.
        if (!isAbort(error) || signal?.aborted) throw error;
      }
    }
    const generation = this._generation;
    const work = this._makePayload(key, columns, normalize, signal);
    work.catch(() => {});
    this._handoffs.set(refKey, work);
    const transform = work.then(payload => payload.vectorTransform);
    this._remember(refKey, transform, generation);
    return transform;
  }

  /**
   * One vector field's display vectors, scaled by the embedding it is bound
   * to: `{vectors, maxMagnitude}`. A value it cannot draw is a
   * `MappingLoadError` naming the vector key; the embedding's own defect is
   * its `EmbeddingLoadError`.
   *
   * @param {string} key
   * @param {number[]} columns
   * @param {{key: string, columns: number[]}} embedding
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, pieces?: PieceSinks}} [options] -
   *   `rows`: only rows `[start, end)` of the open cells (an opening grown in
   *   place), scaled as the whole field is; `pieces`: where the vectors go
   *   as they are made (`embedding`)
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  async vectors(key, columns, embedding, normalize, { signal = null, rows = null, pieces: sinks = assembledPieces } = {}) {
    this._sync();
    const end = new AbortController();
    const readSignal = signal === null ? end.signal : AbortSignal.any([signal, end.signal]);
    const read = this._readPieces(key, columns, rows, readSignal, rows === null ? 'vector field' : 'vector field, cells added');
    read.catch(() => {});
    let transform;
    try {
      transform = await this._transformOf(embedding.key, embedding.columns, normalize, signal);
    } catch (error) {
      // Vectors without their embedding cannot be drawn: their read stops.
      end.abort();
      throw error;
    }
    const pieces = await read;
    const width = columns.length;
    const label = `Vector field '${key}'`;
    const sink = sinks(Float32Array, pieces.reduce((sum, piece) => sum + piece.values.length, 0));
    let maxMagnitude = 0;
    let offset = 0;
    for (let i = 0; i < pieces.length; i++) {
      // Cells numbered from the first open cell, as a whole read numbers them.
      const payload = vectorPayloadOf(pieces[i].values, width, transform, pieces[i].first);
      pieces[i] = null;
      if (payload.defect !== null) {
        throw new MappingLoadError(key, payload.defect, `${label} cannot be drawn: ${payload.defect}.`);
      }
      if (payload.overflow !== null) {
        throw new Error(
          `${label} component at flat index ${payload.overflow} is outside the finite Float32 range after normalization`
        );
      }
      maxMagnitude = Math.max(maxMagnitude, payload.maxMagnitude);
      sink.put(offset, payload.vectors);
      offset += payload.vectors.length;
    }
    return { vectors: sink.result, maxMagnitude };
  }

  /** Forget every transform and shared read. */
  clear() {
    this._generation++;
    this._transforms.clear();
    this._handoffs.clear();
    this._adopted.clear();
  }
}
