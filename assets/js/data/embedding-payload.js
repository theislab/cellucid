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
 * @module data/embedding-payload
 */

import { EmbeddingLoadError, MappingLoadError } from './data-mapping-candidates.js';
import { allocateTypedArray } from './sparse-column-index.js';

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
 * Pass 1 over an embedding's values: the first defect, else each axis's
 * minimum and maximum, and the transform from stored to display coordinates.
 *
 * @param {Float32Array|Float64Array} values - Row-major, `width` values a cell
 * @param {number} width
 * @param {boolean} normalize
 * @returns {{defect: string|null, transform: EmbeddingTransform|null}}
 */
function embeddingTransformOf(values, width, normalize) {
  requireWidth(values, width);
  const nCells = values.length / width;
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  // A float32 value is representable as float32: only NaN and the
  // infinities can be refused.
  const stored32 = values instanceof Float32Array;
  for (let cell = 0, index = 0; cell < nCells; cell++) {
    for (let axis = 0; axis < width; axis++, index++) {
      const value = values[index];
      if (!(value > -Infinity && value < Infinity)) return { defect: valueDefect(value, cell), transform: null };
      if (!stored32) {
        const narrowed = Math.fround(value);
        if (narrowed === Infinity || narrowed === -Infinity || (narrowed === 0 && value !== 0)) {
          return { defect: valueDefect(value, cell), transform: null };
        }
      }
      if (value < mins[axis]) mins[axis] = value;
      if (value > maxs[axis]) maxs[axis] = value;
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
  const { defect, transform } = embeddingTransformOf(values, width, normalize);
  if (defect !== null) return { defect };
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
  return {
    defect: null,
    positions,
    transform: transform.display,
    bounds: nCells === 0 ? null : { min, max },
    vectorTransform: transform,
  };
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
 * @returns {{defect: string|null, overflow: number|null, vectors: Float32Array|null, maxMagnitude: number}}
 */
export function vectorPayloadOf(values, width, { vectorScale, roundFirst }) {
  requireWidth(values, width);
  const vectors = allocateTypedArray(Float32Array, values.length, 'Vector field');
  let overflow = null;
  let maxMagnitudeSquared = 0;
  for (let start = 0; start < values.length; start += width) {
    let magnitudeSquared = 0;
    for (let index = start; index < start + width; index++) {
      const raw = values[index];
      if (!(raw === raw && raw !== Infinity && raw !== -Infinity)) {
        return { defect: valueDefect(raw, start / width), overflow: null, vectors: null, maxMagnitude: 0 };
      }
      const rounded = Math.fround(raw);
      if (raw !== 0 && (rounded === 0 || !Number.isFinite(rounded))) {
        return { defect: valueDefect(raw, start / width), overflow: null, vectors: null, maxMagnitude: 0 };
      }
      const scaled = (roundFirst ? rounded : raw) * vectorScale;
      vectors[index] = scaled;
      const shown = vectors[index];
      if (overflow === null && (!Number.isFinite(scaled) || !Number.isFinite(shown))) overflow = index;
      magnitudeSquared += shown * shown;
    }
    if (overflow === null && !Number.isFinite(magnitudeSquared)) overflow = start;
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
   * @param {(key: string, columns: number[], options: {signal?: AbortSignal|null}) => Promise<Float32Array|Float64Array>} readObsmColumns
   *   The stored values of one `obsm` array's columns, row-major: float32
   *   for a float32 array, else float64.
   * @param {() => number} [generation] - Changes when what was read is
   *   stale (the reader's caches were cleared, another file adopted): every
   *   remembered transform is then forgotten.
   */
  constructor(readObsmColumns, generation = () => 0) {
    this._read = readObsmColumns;
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
    this._generation = 0;
  }

  /** Read and make one embedding's payload; a defect is its `EmbeddingLoadError`. @private */
  async _makePayload(key, columns, normalize, signal) {
    const payload = embeddingPayloadOf(await this._read(key, columns, { signal }), columns.length, normalize);
    if (payload.defect !== null) throw new EmbeddingLoadError(key, columns, payload.defect);
    return payload;
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
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<EmbeddingPayload>}
   */
  async embedding(key, columns, normalize, { signal = null } = {}) {
    this._sync();
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
    const work = this._makePayload(key, columns, normalize, signal);
    this._remember(refKey, work.then(payload => payload.vectorTransform), this._generation);
    const { positions, transform, bounds } = await work;
    return { positions, transform, bounds };
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
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  async vectors(key, columns, embedding, normalize, { signal = null } = {}) {
    this._sync();
    const end = new AbortController();
    const read = this._read(key, columns, { signal: signal === null ? end.signal : AbortSignal.any([signal, end.signal]) });
    read.catch(() => {});
    let transform;
    try {
      transform = await this._transformOf(embedding.key, embedding.columns, normalize, signal);
    } catch (error) {
      // Vectors without their embedding cannot be drawn: their read stops.
      end.abort();
      throw error;
    }
    const payload = vectorPayloadOf(await read, columns.length, transform);
    const label = `Vector field '${key}'`;
    if (payload.defect !== null) {
      throw new MappingLoadError(key, payload.defect, `${label} cannot be drawn: ${payload.defect}.`);
    }
    if (payload.overflow !== null) {
      throw new Error(
        `${label} component at flat index ${payload.overflow} is outside the finite Float32 range after normalization`
      );
    }
    return { vectors: payload.vectors, maxMagnitude: payload.maxMagnitude };
  }

  /** Forget every transform and shared read. */
  clear() {
    this._generation++;
    this._transforms.clear();
    this._handoffs.clear();
  }
}
