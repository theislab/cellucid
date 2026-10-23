/**
 * Cell position layout.
 *
 * A dataset's cell positions are one Float32Array holding exactly as many
 * components per cell as the embedding has: `x` for a 1-D embedding, `x y`
 * for 2-D and `x y z` for 3-D. The component count is the dimension level of
 * the view that shows the embedding, so every owner that knows which
 * embedding it holds also knows how to read the array; nothing pads a 1-D or
 * 2-D embedding out to three components, on the CPU or on the GPU.
 *
 * The axes an embedding does not have are exactly zero. The GPU gets that for
 * free: the position attribute is fed with `dimension` components into a
 * `vec3` shader input, and WebGL supplies 0 for the missing y and z. CPU
 * owners that need a 3-D point read it through `readPositionXYZ`, which
 * writes the same zeros without allocating.
 */

const POSITION_BYTES_PER_COMPONENT = Float32Array.BYTES_PER_ELEMENT;

/**
 * @param {unknown} dimension
 * @param {string} [label]
 * @returns {1|2|3}
 */
export function requirePositionDimension(dimension, label = 'Position dimension') {
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError(`${label} must be exactly 1, 2, or 3.`);
  }
  return dimension;
}

/**
 * Validate one position array against its dimension and return its point count.
 *
 * @param {unknown} positions
 * @param {number} dimension - Components per cell (1, 2 or 3).
 * @param {string} [label]
 * @param {{ allowEmpty?: boolean, pointCount?: number|null }} [options]
 * @returns {number} Point count.
 */
export function requirePositionArray(
  positions,
  dimension,
  label = 'Positions',
  { allowEmpty = false, pointCount = null } = {}
) {
  const exactDimension = requirePositionDimension(dimension, `${label} dimension`);
  if (
    !(positions instanceof Float32Array) ||
    positions.length % exactDimension !== 0 ||
    (!allowEmpty && positions.length === 0)
  ) {
    throw new TypeError(
      `${label} must be a ${allowEmpty ? '' : 'non-empty '}Float32Array with ` +
      `exactly ${exactDimension} value${exactDimension === 1 ? '' : 's'} per point.`
    );
  }
  const count = positions.length / exactDimension;
  if (pointCount !== null && count !== pointCount) {
    throw new RangeError(
      `${label} must contain exactly ${pointCount * exactDimension} values ` +
      `(${pointCount} points of ${exactDimension}); received ${positions.length}.`
    );
  }
  return count;
}

/**
 * Write one cell's 3-D position into `out`, with zero for the axes the
 * embedding does not have.
 *
 * @param {Float32Array} positions
 * @param {number} dimension
 * @param {number} index - Cell index.
 * @param {Float32Array|number[]} out - Receives x, y, z at 0..2.
 * @returns {Float32Array|number[]} `out`.
 */
export function readPositionXYZ(positions, dimension, index, out) {
  const base = index * dimension;
  out[0] = positions[base];
  out[1] = dimension > 1 ? positions[base + 1] : 0;
  out[2] = dimension > 2 ? positions[base + 2] : 0;
  return out;
}

/**
 * Per-axis bounds of one published positions array, scanned once.
 *
 * A published positions array is never written (a changed embedding is a new
 * array), so its bounds are a pure function of the array and its dimension.
 * The viewer, the projectile system, the renderer and every snapshot of the
 * same geometry used to scan the same array separately: three to four full
 * passes on each dataset publication, 100 ms at 10,000,000 2-D cells.
 */
const POSITION_BOUNDS = new WeakMap();

/**
 * Float32 arrays already proven finite (`assertFiniteFloat32Array` of the
 * viewer contracts): scanned once, or proven where they were made.
 */
const PROVEN_FINITE_FLOAT32_ARRAYS = new WeakSet();

/** Whether a Float32 array was already proven finite. */
export function isProvenFiniteFloat32Array(array) {
  return PROVEN_FINITE_FLOAT32_ARRAYS.has(array);
}

/** Record a Float32 array as proven finite (it is never written after publication). */
export function markProvenFiniteFloat32Array(array) {
  PROVEN_FINITE_FLOAT32_ARRAYS.add(array);
}

/**
 * Publish the bounds of a positions array whose maker already scanned it
 * (the reader worker checks, normalizes and bounds an embedding in one pass,
 * `data/embedding-payload.js`), so no one scans it again: the bounds are
 * what `readPositionBounds` would compute, and every value was checked
 * finite where the array was made.
 *
 * @param {Float32Array} positions
 * @param {number} dimension
 * @param {{min: ArrayLike<number>, max: ArrayLike<number>}} bounds - Three components each
 */
export function publishPositionBounds(positions, dimension, bounds) {
  requirePositionArray(positions, dimension, 'Bounds positions');
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = bounds.min[axis];
    max[axis] = bounds.max[axis];
    if (!Number.isFinite(min[axis]) || !Number.isFinite(max[axis]) || min[axis] > max[axis] ||
        (axis >= dimension && (min[axis] !== 0 || max[axis] !== 0))) {
      throw new RangeError('Published position bounds must be finite, ordered, and zero on absent axes.');
    }
  }
  POSITION_BOUNDS.set(positions, {
    dimension,
    bounds: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
  });
  PROVEN_FINITE_FLOAT32_ARRAYS.add(positions);
}

/**
 * Exact per-axis minimum and maximum of a positions array, with zero for the
 * axes the embedding does not have. The first point seeds every axis.
 *
 * @param {Float32Array} positions - Non-empty, `dimension` components a point.
 * @param {number} dimension
 * @returns {Readonly<{min: readonly number[], max: readonly number[]}>}
 *   Three components each.
 */
export function readPositionBounds(positions, dimension) {
  requirePositionArray(positions, dimension, 'Bounds positions');
  const cached = POSITION_BOUNDS.get(positions);
  if (cached !== undefined && cached.dimension === dimension) {
    return cached.bounds;
  }
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let axis = 0; axis < dimension; axis++) {
    let lo = positions[axis];
    let hi = lo;
    for (let i = axis + dimension; i < positions.length; i += dimension) {
      const v = positions[i];
      if (v < lo) lo = v; else if (v > hi) hi = v;
    }
    min[axis] = lo;
    max[axis] = hi;
  }
  const bounds = Object.freeze({
    min: Object.freeze(min),
    max: Object.freeze(max),
  });
  POSITION_BOUNDS.set(positions, { dimension, bounds });
  return bounds;
}

/**
 * Bytes one position store of `pointCount` cells occupies.
 *
 * @param {number} pointCount
 * @param {number} dimension
 * @returns {number}
 */
export function positionByteLength(pointCount, dimension) {
  return pointCount * dimension * POSITION_BYTES_PER_COMPONENT;
}

/**
 * Point the bound vertex array's `location` attribute at a tightly packed
 * position stream of `dimension` Float32 components per point. Declared in the
 * shader as a `vec3`, the attribute receives 0 for the components the stream
 * does not supply.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLBuffer} buffer
 * @param {number} dimension
 * @param {number} [location=0]
 */
export function bindPositionAttribute(gl, buffer, dimension, location = 0) {
  requirePositionDimension(dimension, 'Position attribute dimension');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(
    location,
    dimension,
    gl.FLOAT,
    false,
    dimension * POSITION_BYTES_PER_COMPONENT,
    0
  );
}
