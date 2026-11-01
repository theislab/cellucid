/**
 * Embedding and vector-field payloads, made in the AnnData reader worker
 * beside the `obsm` arrays they come from, so the page receives coordinates
 * ready to draw and never walks them.
 *
 * An embedding's selected columns are checked (every value of a placed
 * cell representable as float32, and, normalized, a non-zero range) and
 * turned into display coordinates in two passes, the second writing
 * float32. A cell whose row holds NaN or an infinity in any selected column
 * has no position in this embedding (an embedding computed on some of the
 * cells, a MuData modality that did not measure the cell): its coordinates
 * are NaN on every axis -- the one mark of an unplaced cell, which every
 * later step keeps (growth, cuts, reorders) -- it is left out of the bounds
 * and the transform, and the payload counts such cells (`unplacedCount`)
 * and names the first (`firstUnplaced`). Only an embedding that places no
 * cell is refused for it.
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
 * transform in one pass, with its largest magnitude; a cell whose vector
 * row is not finite gets NaN components (no arrow) and is counted as an
 * embedding's unplaced cells are.
 *
 * The stored values an embedding is read in are summed for its cell-order
 * digest as they are read (`cell-order-digest.js`): a growth step adds the
 * rows it reads, an opening cut in place keeps the sums of the rows it
 * keeps (`adoptCellOrderSums`), and the digest a session records is then
 * answered without folding every cell (`cellOrderDigest`). A whole read's
 * sums are taken after its payload is handed over (`_deferSums`), not
 * before, a slice at a time: the page places the cells while the worker
 * sums them, answering its requests between slices (a hash of each of 10M
 * cells cost a first view 0.1-0.15 s), and whatever needs the sums first
 * takes them at once (`_flushSums`).
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

import { EmbeddingLoadError, MappingLoadError, everyRowMissing } from './data-mapping-candidates.js';
import { allocateTypedArray } from './sparse-column-index.js';
import { ArrayAssembly } from '../utils/large-arrays.js';
import { CELL_ORDER_BLOCK_ROWS, CellOrderSums } from './cell-order-digest.js';
import { GROWTH_READ_REASON } from './read-activity-log.js';
import { isCancellation, cancel } from '../utils/abort.js';

/**
 * Cells in one piece of an embedding or vector field: the point store's
 * segment (`rendering/high-perf/point-store-segments.js`), 192 MiB of 3-D
 * float32 coordinates, under every engine's `ArrayBuffer` cap.
 */
export const COORDINATE_PIECE_CELLS = 2 ** 24;

/**
 * Rows of a whole read summed for its cell-order digest in one task
 * (`EmbeddingPayloads._deferSums`), a scheduling choice: a few milliseconds
 * of hashing, so a request arriving meanwhile waits no longer than that.
 */
const CELL_ORDER_SLICE_ROWS = 64 * CELL_ORDER_BLOCK_ROWS;

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

/** The cells of a payload named by `firstUnplaced`: an example, not a list. */
export const UNPLACED_CELLS_NAMED = 3;

/** A finite value that is not representable as float32, as `valueLoadDefect` names it (`data-mapping-candidates.js`). */
function unrepresentable(cell) {
  return `not representable as float32 at cell ${cell}`;
}

/** Whether a finite stored value narrows to an infinity, or to zero from a non-zero value. */
function narrowsBadly(value) {
  const narrowed = Math.fround(value);
  return narrowed === Infinity || narrowed === -Infinity || (narrowed === 0 && value !== 0);
}

/** Whether the row of `width` values at `start` is finite on every axis: a placed cell. */
function placedRow(values, start, width) {
  for (let index = start; index < start + width; index++) {
    const value = values[index];
    if (!(value > -Infinity && value < Infinity)) return false;
  }
  return true;
}

/**
 * The rows of `values` (`width` 1 to 3 values each) finite on every axis
 * (placed: `placedRow`), counted, with `mins`/`maxs` widened by their
 * values: a loop a width, its bounds in locals (a call and an array a value
 * cost 10M-cell openings tens of milliseconds a pass).
 */
function placedBounds(values, width, mins, maxs) {
  let placed = 0;
  const n = values.length;
  if (width === 2) {
    let lo0 = mins[0], hi0 = maxs[0], lo1 = mins[1], hi1 = maxs[1];
    for (let i = 0; i < n; i += 2) {
      const a = values[i];
      const b = values[i + 1];
      // `x - x` is 0 for a finite value, NaN for an infinity or NaN.
      if (a - a !== 0 || b - b !== 0) continue;
      placed++;
      if (a < lo0) lo0 = a;
      if (a > hi0) hi0 = a;
      if (b < lo1) lo1 = b;
      if (b > hi1) hi1 = b;
    }
    mins[0] = lo0; maxs[0] = hi0; mins[1] = lo1; maxs[1] = hi1;
    return placed;
  }
  if (width === 3) {
    let lo0 = mins[0], hi0 = maxs[0], lo1 = mins[1], hi1 = maxs[1], lo2 = mins[2], hi2 = maxs[2];
    for (let i = 0; i < n; i += 3) {
      const a = values[i];
      const b = values[i + 1];
      const c = values[i + 2];
      if (a - a !== 0 || b - b !== 0 || c - c !== 0) continue;
      placed++;
      if (a < lo0) lo0 = a;
      if (a > hi0) hi0 = a;
      if (b < lo1) lo1 = b;
      if (b > hi1) hi1 = b;
      if (c < lo2) lo2 = c;
      if (c > hi2) hi2 = c;
    }
    mins[0] = lo0; maxs[0] = hi0; mins[1] = lo1; maxs[1] = hi1; mins[2] = lo2; maxs[2] = hi2;
    return placed;
  }
  let lo = mins[0], hi = maxs[0];
  for (let i = 0; i < n; i++) {
    const a = values[i];
    if (a - a !== 0) continue;
    placed++;
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  mins[0] = lo; maxs[0] = hi;
  return placed;
}

/** Counts the unplaced cells of a payload and keeps the first few it names. */
class UnplacedCells {
  constructor() {
    this.count = 0;
    /** @type {number[]} */
    this.first = [];
  }

  add(cell) {
    this.count++;
    if (this.first.length < UNPLACED_CELLS_NAMED) this.first.push(cell);
  }
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
 * each axis's minimum and maximum over the placed cells (rows finite on
 * every axis), and the transform from stored to display coordinates.
 *
 * @param {ReadonlyArray<{first: number, values: Float32Array|Float64Array}>} pieces -
 *   Row-major, `width` values a cell; `first` numbers a piece's first cell
 * @param {number} width
 * @param {boolean} normalize
 * @returns {{defect: string|null, transform: EmbeddingTransform|null, stored: StoredBounds|null}}
 *   `stored`: the stored bounds when every cell is placed (null otherwise),
 *   from which the display bounds follow without a pass over the
 *   coordinates (`coordinatesOfPieces`)
 */
function embeddingTransformOf(pieces, width, normalize) {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  let nCells = 0;
  let placed = 0;
  for (const { first, values } of pieces) {
    requireWidth(values, width);
    const cells = values.length / width;
    nCells += cells;
    // A float32 value is representable as float32: only a wider one can
    // narrow badly, and float32 rows are bounded in a loop of their own.
    const stored32 = values instanceof Float32Array;
    if (stored32) {
      placed += placedBounds(values, width, mins, maxs);
      continue;
    }
    for (let cell = 0, index = 0; cell < cells; cell++, index += width) {
      if (!placedRow(values, index, width)) continue;
      placed++;
      for (let axis = 0; axis < width; axis++) {
        const value = values[index + axis];
        if (!stored32 && narrowsBadly(value)) return { defect: unrepresentable(first + cell), transform: null, stored: null };
        if (value < mins[axis]) mins[axis] = value;
        if (value > maxs[axis]) maxs[axis] = value;
      }
    }
  }
  if (nCells > 0 && placed === 0) return { defect: everyRowMissing('coordinates are'), transform: null, stored: null };
  if (nCells === 0) {
    return {
      defect: null,
      transform: { centers: [0, 0, 0].slice(0, width), scale: 1, display: { center: [0, 0, 0], scale: 1 }, vectorScale: 1, roundFirst: !normalize },
      stored: null,
    };
  }
  const stored = placed === nCells ? { mins, maxs } : null;
  if (normalize) {
    let maxRange = 0;
    for (let axis = 0; axis < width; axis++) maxRange = Math.max(maxRange, maxs[axis] - mins[axis]);
    if (!(maxRange > 0)) return { defect: 'no coordinate variation', transform: null, stored: null };
    return {
      defect: null,
      stored,
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
    stored,
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
 * @typedef {{mins: number[], maxs: number[]}} StoredBounds - Per-axis bounds
 *   of an embedding's stored values, every cell placed
 */

/**
 * @typedef {Object} EmbeddingPayload
 * @property {Float32Array} positions - Display coordinates, `width` a cell;
 *   NaN on every axis for a cell this embedding does not place
 * @property {{center: number[], scale: number}} transform - Its display transform
 * @property {{min: number[], max: number[]}|null} bounds - Per-axis bounds of
 *   the placed cells' `positions` (three components, zero for absent axes),
 *   null when no cell of the payload is placed
 * @property {number} unplacedCount - The cells it does not place
 * @property {string[]} unplacedNames - The obs names of the first of them
 *   (at most `UNPLACED_CELLS_NAMED`), in open-cell order
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
  const { defect, transform, stored } = embeddingTransformOf(pieces, width, normalize);
  if (defect !== null) return { defect };
  const { positions, bounds, unplaced } = coordinatesOfPieces(pieces, width, transform, normalize, assembledPieces, stored);
  return { defect: null, positions, bounds, ...unplacedFields(unplaced), transform: transform.display, vectorTransform: transform };
}

/** The payload fields of counted unplaced cells. */
function unplacedFields(unplaced) {
  return { unplacedCount: unplaced.count, firstUnplaced: unplaced.first };
}

/**
 * The first value of some cells of an embedding that `embeddingPayloadOf`
 * would refuse (a placed cell's value that is not representable as
 * float32), named as it names it (`firstCell` numbers the first cell), or
 * null.
 *
 * @param {Float32Array|Float64Array} values
 * @param {number} width
 * @param {number} firstCell
 * @returns {string|null}
 */
function rowsDefect(values, width, firstCell) {
  requireWidth(values, width);
  if (values instanceof Float32Array) return null;
  for (let start = 0; start < values.length; start += width) {
    if (!placedRow(values, start, width)) continue;
    for (let index = start; index < start + width; index++) {
      if (narrowsBadly(values[index])) return unrepresentable(firstCell + start / width);
    }
  }
  return null;
}

/**
 * Display coordinates of checked pieces under `transform`, each piece made,
 * handed to its sink and its stored values let go in turn, with the
 * per-axis bounds of the placed cells of all of them (null when none is
 * placed) and the cells none of them places. With the stored bounds of
 * pieces whose every cell is placed (`stored`, `embeddingTransformOf`), no
 * cell is looked for and the bounds are the transform of the stored ones:
 * a coordinate is the stored value (rounded to float32 first for a file's
 * own coordinates) moved and scaled by a positive factor, then rounded to
 * float32 -- each step keeps the order of values, so the least and the
 * greatest coordinates are those of the least and the greatest stored
 * values, exactly (one pass over a 10M-cell embedding fewer).
 *
 * @param {Array<{first: number, values: Float32Array|Float64Array}|null>} pieces - Emptied as they are written
 * @param {number} width
 * @param {EmbeddingTransform} transform
 * @param {boolean} normalize
 * @param {PieceSinks} sinks
 * @param {StoredBounds|null} [stored]
 * @returns {{positions: *, bounds: {min: number[], max: number[]}|null, unplaced: UnplacedCells}}
 */
function coordinatesOfPieces(pieces, width, transform, normalize, sinks, stored = null) {
  const total = pieces.reduce((sum, piece) => sum + piece.values.length, 0);
  const sink = sinks(Float32Array, total);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const unplaced = new UnplacedCells();
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    const positions = displayCoordinatesOf(pieces[i].values, width, transform, normalize, pieces[i].first, stored === null ? unplaced : null, min, max);
    pieces[i] = null;
    sink.put(offset, positions);
    offset += positions.length;
  }
  if (stored !== null) {
    for (let axis = 0; axis < width; axis++) {
      min[axis] = displayCoordinateOf(stored.mins[axis], transform, normalize, axis);
      max[axis] = displayCoordinateOf(stored.maxs[axis], transform, normalize, axis);
    }
  }
  if (unplaced.count === total / width) return { positions: sink.result, bounds: null, unplaced };
  for (let axis = width; axis < 3; axis++) {
    min[axis] = 0;
    max[axis] = 0;
  }
  return { positions: sink.result, bounds: { min, max }, unplaced };
}

/** The display coordinate of one stored value on `axis`, as `displayCoordinatesOf` makes it. */
function displayCoordinateOf(value, { centers, scale }, normalize, axis) {
  return Math.fround(((normalize ? value : Math.fround(value)) - centers[axis]) * scale);
}

/**
 * The display coordinates of checked values under `transform` (NaN on every
 * axis for a cell not placed, counted in `unplaced`), widening `min`/`max`
 * by the placed ones; `unplaced` null: every cell is placed (the bounds are
 * the caller's, `coordinatesOfPieces`).
 */
function displayCoordinatesOf(values, width, transform, normalize, firstCell, unplaced, min, max) {
  const positions = allocateTypedArray(Float32Array, values.length, 'Embedding coordinates');
  const { centers, scale } = transform;
  // Each axis in a loop of its own; a value that is not finite gives a
  // position that is not finite (a finite one stays finite: the transform
  // maps the placed bounds into [-1, 1]), so the rows not placed are found
  // on the positions, made NaN on every axis, and the bounds taken over
  // the rest (`placedBounds`).
  for (let axis = 0; axis < width; axis++) {
    const center = centers[axis];
    if (normalize) for (let index = axis; index < values.length; index += width) positions[index] = (values[index] - center) * scale;
    else for (let index = axis; index < values.length; index += width) positions[index] = (Math.fround(values[index]) - center) * scale;
  }
  if (unplaced !== null && placedBounds(positions, width, min, max) * width < positions.length) {
    for (let start = 0; start < positions.length; start += width) {
      if (placedRow(positions, start, width)) continue;
      for (let index = start; index < start + width; index++) positions[index] = NaN;
      unplaced.add(firstCell + start / width);
    }
  }
  return positions;
}

/**
 * A vector field's display vectors: each stored component scaled by its
 * embedding's transform (`vectorScale`, after rounding to float32 when the
 * embedding's coordinates were), rounded to float32 once, with the largest
 * vector's magnitude. A cell whose row is not finite has no vector: NaN
 * components, counted in `unplaced` (made here when not given). A value
 * Cellucid cannot read is named as `valueLoadDefect` names it, before any
 * overflow.
 *
 * @param {Float32Array|Float64Array} values - Row-major, `width` components a cell
 * @param {number} width
 * @param {EmbeddingTransform} transform
 * @param {number} [firstCell=0] - The cell of `values[0]`: a defect names
 *   its cell and an overflow its flat index from there
 * @param {UnplacedCells} [unplaced]
 * @returns {{defect: string|null, overflow: number|null, vectors: Float32Array|null, maxMagnitude: number, unplacedCount: number, firstUnplaced: number[]}}
 */
export function vectorPayloadOf(values, width, { vectorScale, roundFirst }, firstCell = 0, unplaced = new UnplacedCells()) {
  requireWidth(values, width);
  const vectors = allocateTypedArray(Float32Array, values.length, 'Vector field');
  const refused = defect => ({ defect, overflow: null, vectors: null, maxMagnitude: 0, ...unplacedFields(unplaced) });
  let overflow = null;
  let maxMagnitudeSquared = 0;
  for (let start = 0; start < values.length; start += width) {
    if (!placedRow(values, start, width)) {
      for (let index = start; index < start + width; index++) vectors[index] = NaN;
      unplaced.add(firstCell + start / width);
      continue;
    }
    let magnitudeSquared = 0;
    for (let index = start; index < start + width; index++) {
      const raw = values[index];
      const rounded = Math.fround(raw);
      if (raw !== 0 && (rounded === 0 || !Number.isFinite(rounded))) return refused(unrepresentable(firstCell + start / width));
      const scaled = (roundFirst ? rounded : raw) * vectorScale;
      vectors[index] = scaled;
      const shown = vectors[index];
      if (overflow === null && (!Number.isFinite(scaled) || !Number.isFinite(shown))) overflow = firstCell * width + index;
      magnitudeSquared += shown * shown;
    }
    if (overflow === null && !Number.isFinite(magnitudeSquared)) overflow = firstCell * width + start;
    if (magnitudeSquared > maxMagnitudeSquared) maxMagnitudeSquared = magnitudeSquared;
  }
  if (overflow !== null) return { defect: null, overflow, vectors: null, maxMagnitude: 0, ...unplacedFields(unplaced) };
  return { defect: null, overflow: null, vectors, maxMagnitude: Math.sqrt(maxMagnitudeSquared), ...unplacedFields(unplaced) };
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
   * @param {() => Uint32Array|null} [options.originals] - The original
   *   position of each open cell, in open order; null when open cell `i` is
   *   original position `i` (`cell-identity.js`): what the cell-order digest
   *   names cells by.
   * @param {(cells: number[]) => Promise<string[]>} options.cellNames - The
   *   obs names of some open cells (ascending): what names the first cells
   *   a payload leaves unplaced.
   * @param {number} [options.pieceCells=COORDINATE_PIECE_CELLS] - Cells a
   *   piece holds (tests use fewer, to make pieces at sizes that fit).
   */
  constructor(readObsmColumns, { cellCount, cellNames, generation = () => 0, originals = () => null, pieceCells = COORDINATE_PIECE_CELLS }) {
    if (typeof cellCount !== 'function') throw new TypeError('Embedding payloads need the count of open cells.');
    if (typeof cellNames !== 'function') throw new TypeError('Embedding payloads need the names of open cells.');
    if (typeof originals !== 'function') throw new TypeError('Embedding payloads need the original positions of the open cells.');
    if (!Number.isSafeInteger(pieceCells) || pieceCells < 1) throw new RangeError(`A piece holds 1 or more cells, not ${pieceCells}.`);
    this._read = readObsmColumns;
    this._cellCount = cellCount;
    this._cellNames = cellNames;
    this._originals = originals;
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
    /**
     * The cell-order sums of each embedding read (`cell-order-digest.js`),
     * by `[key, columns]`: over the stored values, so one per embedding
     * whether or not it is normalized.
     * @type {Map<string, CellOrderSums>}
     */
    this._sums = new Map();
    /**
     * Slices of whole reads whose sums are taken once their payload is
     * handed over (`_deferSums`): their stored values, held until then.
     * @type {Array<{key: string, columns: number[], piece: {first: number, values: Float32Array|Float64Array}, generation: number}>}
     */
    this._deferred = [];
    this._deferredTimer = null;
    this._generation = 0;
  }

  /**
   * Sum a whole read's pieces after its payload is handed over, a slice of
   * `CELL_ORDER_SLICE_ROWS` rows a task (`_sumSlice`): the page's next
   * requests are answered between slices, not behind every cell's sums (a
   * 10M-cell opening's next request waited 154 ms behind them). @private
   */
  _deferSums(key, columns, pieces, generation) {
    const width = columns.length;
    for (const { first, values } of pieces) {
      const cells = values.length / width;
      for (let row = 0; row < cells; row += CELL_ORDER_SLICE_ROWS) {
        const end = Math.min(cells, row + CELL_ORDER_SLICE_ROWS);
        this._deferred.push({ key, columns, piece: { first: first + row, values: values.subarray(row * width, end * width) }, generation });
      }
    }
    this._deferredTimer ??= setTimeout(() => this._sumSlice(), 0);
  }

  /** Sum the next deferred slice, and leave the rest to later tasks. @private */
  _sumSlice() {
    this._deferredTimer = null;
    const next = this._deferred.shift();
    if (next !== undefined) this._sumPieces(next.key, next.columns, [next.piece], next.generation);
    if (this._deferred.length > 0) this._deferredTimer = setTimeout(() => this._sumSlice(), 0);
  }

  /** Take every deferred slice's sums now (before anything that reads or extends them). @private */
  _flushSums() {
    if (this._deferredTimer !== null) clearTimeout(this._deferredTimer);
    this._deferredTimer = null;
    const deferred = this._deferred;
    this._deferred = [];
    for (const { key, columns, piece, generation } of deferred) this._sumPieces(key, columns, [piece], generation);
  }

  /**
   * Sum pieces read for one embedding into its cell-order sums: rows from
   * `[0, ...)` start them again, rows that continue them are added; rows
   * after a gap leave them as they are (the digest reads the gap). @private
   */
  _sumPieces(key, columns, pieces, generation) {
    if (generation !== this._generation || pieces.length === 0) return;
    const sumKey = JSON.stringify([key, columns]);
    const first = pieces[0].first;
    const known = this._sums.get(sumKey);
    let sums;
    if (first === 0) sums = new CellOrderSums();
    else if (known !== undefined && known.extendable && known.covered === first) sums = known.clone();
    else return;
    const originals = this._originals();
    for (const piece of pieces) sums.add(piece.values, columns.length, piece.first, originals);
    if ((this._sums.get(sumKey)?.covered ?? 0) <= sums.covered) this._sums.set(sumKey, sums);
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
    const generation = this._generation;
    const pieces = await this._readPieces(key, columns, null, signal, 'embedding');
    const { defect, transform, stored } = embeddingTransformOf(pieces, columns.length, normalize);
    if (defect !== null) throw new EmbeddingLoadError(key, columns, defect);
    // Its cell-order sums once the payload is handed over (`_deferSums`):
    // the stored pieces are held until then.
    this._deferSums(key, columns, pieces.slice(), generation);
    const { positions, bounds, unplaced } = coordinatesOfPieces(pieces, columns.length, transform, normalize, sinks, stored);
    return { positions, bounds, ...unplacedFields(unplaced), transform: transform.display, vectorTransform: transform };
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
  async embedding(key, columns, normalize, options = {}) {
    return this._named(await this._embedding(key, columns, normalize, options), options.signal ?? null);
  }

  /**
   * A payload's first unplaced cells (`firstUnplaced`, open cells) named by
   * their obs names (`unplacedNames`), so the page says which cells a
   * layout or a vector field leaves out without reading the index. @private
   */
  async _named({ firstUnplaced, ...payload }, signal) {
    const unplacedNames = firstUnplaced.length === 0 ? [] : await this._cellNames(firstUnplaced);
    signal?.throwIfAborted();
    return { ...payload, unplacedNames };
  }

  /** `embedding`, its unplaced cells by open cell. @private */
  async _embedding(key, columns, normalize, { signal = null, rows = null, pieces = assembledPieces } = {}) {
    this._sync();
    if (rows !== null) return this._rows(key, columns, normalize, rows, signal, pieces);
    const refKey = JSON.stringify([key, columns, normalize]);
    const handoff = this._handoffs.get(refKey);
    if (handoff !== undefined) {
      this._handoffs.delete(refKey);
      try {
        const { positions, transform, bounds, unplacedCount, firstUnplaced } = await handoff;
        return { positions, transform, bounds, unplacedCount, firstUnplaced };
      } catch (error) {
        // The vector field's read was cancelled: this one reads for itself.
        if (!isCancellation(error) || signal?.aborted) throw error;
      }
    }
    // The transform of the opening this one grew or was cut from
    // (`adoptTransforms`) is the one the cells are shown in.
    if (this._adopted.has(refKey)) return this._rows(key, columns, normalize, null, signal, pieces);
    const work = this._makePayload(key, columns, normalize, signal, pieces);
    this._remember(refKey, work.then(payload => payload.vectorTransform), this._generation);
    const { positions, transform, bounds, unplacedCount, firstUnplaced } = await work;
    return { positions, transform, bounds, unplacedCount, firstUnplaced };
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
    const generation = this._generation;
    const pieces = await this._readPieces(key, columns, rows, signal, rows === null ? 'embedding' : `embedding, ${GROWTH_READ_REASON}`);
    this._flushSums();
    this._sumPieces(key, columns, pieces, generation);
    for (const { first, values } of pieces) {
      const defect = rowsDefect(values, columns.length, first);
      if (defect !== null) throw new EmbeddingLoadError(key, columns, defect);
    }
    const { positions, bounds, unplaced } = coordinatesOfPieces(pieces, columns.length, transform, normalize, sinks);
    return { positions, transform: transform.display, bounds, ...unplacedFields(unplaced) };
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
   * Take the cell-order sums `previous` (the payloads of an earlier opening
   * of the same store) holds, for the rows this opening shares with it:
   * open rows `[0, shared)` are the same file rows, so the same cells, in
   * both (`AnnDataReader._sharedRows`). An opening of the same cells in
   * another order (`sameCells`) keeps the total of an embedding summed over
   * every earlier cell. What is not kept is read again when a digest is
   * asked for.
   *
   * @param {EmbeddingPayloads} previous
   * @param {{shared: number, sameCells: boolean}} cells
   */
  adoptCellOrderSums(previous, { shared, sameCells }) {
    this._sync();
    previous._sync();
    previous._flushSums();
    const before = previous._cellCount();
    for (const [sumKey, sums] of previous._sums) {
      const kept = sameCells && shared < before && sums.covered === before
        ? CellOrderSums.reordered(sums)
        : sums.prefix(shared);
      if (kept.covered > 0) this._sums.set(sumKey, kept);
    }
  }

  /**
   * The cell-order digest of one embedding over the open cells
   * (`cell-order-digest.js`): from the sums its reads left, the rows they
   * do not cover read now (none for an embedding read whole or grown in
   * place; fewer than `CELL_ORDER_BLOCK_ROWS` for an opening cut in place;
   * every open cell for one not read in this opening).
   *
   * @param {string} key
   * @param {number[]} columns
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<string>} 16 lowercase hexadecimal characters
   */
  async cellOrderDigest(key, columns, { signal = null } = {}) {
    this._sync();
    const generation = this._generation;
    const sumKey = JSON.stringify([key, columns]);
    const cells = this._cellCount();
    this._flushSums();
    const known = this._sums.get(sumKey);
    if (known !== undefined && known.covered === cells) return known.digest();
    const sums = known !== undefined && known.extendable ? known.clone() : new CellOrderSums();
    const pieces = await this._readPieces(key, columns, [sums.covered, cells], signal, 'cell-order digest');
    const originals = this._originals();
    for (const piece of pieces) sums.add(piece.values, columns.length, piece.first, originals);
    if (generation === this._generation && (this._sums.get(sumKey)?.covered ?? 0) <= sums.covered) this._sums.set(sumKey, sums);
    return sums.digest();
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
        if (!isCancellation(error) || signal?.aborted) throw error;
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
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number, unplacedCount: number, unplacedNames: string[]}>}
   *   `unplacedCount`: the cells without a vector (NaN components, no
   *   arrow), the first named; a whole field with none is refused
   */
  async vectors(key, columns, embedding, normalize, options = {}) {
    return this._named(await this._vectors(key, columns, embedding, normalize, options), options.signal ?? null);
  }

  /** `vectors`, its cells without a vector by open cell. @private */
  async _vectors(key, columns, embedding, normalize, { signal = null, rows = null, pieces: sinks = assembledPieces } = {}) {
    this._sync();
    const end = new AbortController();
    const readSignal = signal === null ? end.signal : AbortSignal.any([signal, end.signal]);
    const read = this._readPieces(key, columns, rows, readSignal, rows === null ? 'vector field' : `vector field, ${GROWTH_READ_REASON}`);
    read.catch(() => {});
    let transform;
    try {
      transform = await this._transformOf(embedding.key, embedding.columns, normalize, signal);
    } catch (error) {
      // Vectors without their embedding cannot be drawn: their read stops.
      cancel(end, 'superseded', 'The embedding of these vectors could not be read.');
      throw error;
    }
    const pieces = await read;
    const width = columns.length;
    const label = `Vector field '${key}'`;
    const total = pieces.reduce((sum, piece) => sum + piece.values.length, 0);
    const sink = sinks(Float32Array, total);
    const unplaced = new UnplacedCells();
    let maxMagnitude = 0;
    let offset = 0;
    for (let i = 0; i < pieces.length; i++) {
      // Cells numbered from the first open cell, as a whole read numbers them.
      const payload = vectorPayloadOf(pieces[i].values, width, transform, pieces[i].first, unplaced);
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
    if (rows === null && total > 0 && unplaced.count === total / width) {
      const reason = everyRowMissing('vector is');
      throw new MappingLoadError(key, reason, `${label} cannot be drawn: ${reason}.`);
    }
    return { vectors: sink.result, maxMagnitude, ...unplacedFields(unplaced) };
  }

  /** Forget every transform, cell-order sum and shared read. */
  clear() {
    this._generation++;
    this._transforms.clear();
    this._handoffs.clear();
    this._adopted.clear();
    this._sums.clear();
    if (this._deferredTimer !== null) clearTimeout(this._deferredTimer);
    this._deferredTimer = null;
    this._deferred = [];
  }
}
