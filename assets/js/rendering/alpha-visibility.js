/**
 * Exact point-alpha visibility contract shared by CPU and GPU consumers.
 *
 * Point transparency is one byte a cell, a `Uint8Array` holding exactly 0
 * (hidden) or 1 (shown). Every producer is a binary predicate — category,
 * continuous-range, outlier and per-cell filters either keep a cell or drop
 * it — so no fractional value exists to represent, and a byte represents both
 * values exactly at a quarter of the Float32 cost.
 *
 * The renderer publishes it to WebGL as normalized R8 (`alpha * 255`, so 0 or
 * 255). The shaders discard encoded values below the float literal 0.01, so
 * byte 3 is the first visible value; POINT_VISIBILITY_THRESHOLD is that
 * boundary on the caller's scale, which 1 passes and 0 does not.
 */

export const MIN_VISIBLE_ALPHA_BYTE = 3;

export const POINT_VISIBILITY_THRESHOLD = Math.fround(
  (MIN_VISIBLE_ALPHA_BYTE - 0.5) / 255
);

/**
 * Require one exact point-transparency array: a `Uint8Array` of `pointCount`
 * entries, each exactly 0 or 1.
 *
 * @param {unknown} values
 * @param {number} pointCount
 * @param {string} label - What to name in the failure.
 * @returns {Uint8Array}
 */
export function requirePointTransparency(values, pointCount, label) {
  if (!(values instanceof Uint8Array) || values.length !== pointCount) {
    throw new TypeError(
      `${label} must be a Uint8Array with exactly ${pointCount} entries.`
    );
  }
  for (let index = 0; index < values.length; index++) {
    if (values[index] > 1) {
      throw new RangeError(
        `${label} entry ${index} must be exactly 0 or 1.`
      );
    }
  }
  return values;
}
