/**
 * Exact point-alpha visibility contract shared by CPU and GPU consumers.
 *
 * Point transparency is published to WebGL as normalized R8. The shaders
 * discard encoded values below the float literal 0.01, so byte 3 is the first
 * visible value. Caller transparency is Float32Array-backed; its exact
 * pre-encoding boundary is therefore the first Float32 value whose
 * Math.round(alpha * 255) result is at least 3.
 */

export const MIN_VISIBLE_ALPHA_BYTE = 3;

export const POINT_VISIBILITY_THRESHOLD = Math.fround(
  (MIN_VISIBLE_ALPHA_BYTE - 0.5) / 255
);
