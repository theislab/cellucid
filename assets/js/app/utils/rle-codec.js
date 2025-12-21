/**
 * Run-length encoding helpers used for state persistence.
 *
 * Purpose:
 * - User-defined categoricals can have a codes array of length = n_cells.
 * - Serializing that raw array to JSON is too large.
 * - RLE compresses well because most selections are sparse/clustered.
 */

/**
 * Encode an array-like into run-length encoding.
 * @param {Uint8Array|Uint16Array|Array<number>} arr
 * @returns {Array<[number, number]>} Array of [value, count]
 */
export function rleEncode(arr) {
  if (!arr || arr.length === 0) return [];

  const result = [];
  let current = arr[0];
  let count = 1;

  for (let i = 1; i < arr.length; i++) {
    const value = arr[i];
    if (value === current && count < 65535) {
      count++;
    } else {
      result.push([current, count]);
      current = value;
      count = 1;
    }
  }
  result.push([current, count]);

  return result;
}

/**
 * Decode RLE back into a typed array.
 * @param {Array<[number, number]>} rle
 * @param {number} length
 * @param {Function} [ArrayType=Uint8Array]
 * @returns {Uint8Array|Uint16Array}
 */
export function rleDecode(rle, length, ArrayType = Uint8Array) {
  const out = new ArrayType(length);
  let idx = 0;

  for (const entry of (rle || [])) {
    const value = entry?.[0] ?? 0;
    const count = entry?.[1] ?? 0;
    for (let i = 0; i < count && idx < length; i++) {
      out[idx++] = value;
    }
    if (idx >= length) break;
  }

  return out;
}

/**
 * Roughly estimate JSON size ratio (encoded/original). Lower is better.
 * @param {ArrayLike<number>} arr
 * @returns {number}
 */
export function estimateCompressionRatio(arr) {
  if (!arr || arr.length === 0) return 1;
  const encoded = rleEncode(arr);
  const encodedSize = encoded.length * 8; // approx: 2 numbers per entry
  const originalSize = arr.length * 2.5; // approx: 1 number per cell in JSON
  return encodedSize / originalSize;
}

