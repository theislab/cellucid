/**
 * The checksums HDF5 writes.
 *
 * - Jenkins' lookup3 (`H5_checksum_lookup3`): every structure of the newer
 *   format (version 2 object headers, version 2 B-trees, fractal heaps, chunk
 *   indexes, version 2+ superblocks) ends with it. Checking it turns a torn or
 *   corrupt metadata block into a clear error instead of nonsense values.
 * - Fletcher-32 (`H5_checksum_fletcher32`): the optional per-chunk data
 *   checksum filter.
 *
 * @module formats/hdf5/checksum
 */

/** Jenkins' lookup3 hash of `bytes` (HDF5's metadata checksum). */
export function lookup3(bytes, initval = 0) {
  let length = bytes.length;
  let a = (0xdeadbeef + length + initval) | 0;
  let b = a;
  let c = a;
  let k = 0;
  while (length > 12) {
    a = (a + (bytes[k] | (bytes[k + 1] << 8) | (bytes[k + 2] << 16) | (bytes[k + 3] << 24))) | 0;
    b = (b + (bytes[k + 4] | (bytes[k + 5] << 8) | (bytes[k + 6] << 16) | (bytes[k + 7] << 24))) | 0;
    c = (c + (bytes[k + 8] | (bytes[k + 9] << 8) | (bytes[k + 10] << 16) | (bytes[k + 11] << 24))) | 0;
    // mix(a, b, c)
    a = (a - c) | 0; a ^= (c << 4) | (c >>> 28); c = (c + b) | 0;
    b = (b - a) | 0; b ^= (a << 6) | (a >>> 26); a = (a + c) | 0;
    c = (c - b) | 0; c ^= (b << 8) | (b >>> 24); b = (b + a) | 0;
    a = (a - c) | 0; a ^= (c << 16) | (c >>> 16); c = (c + b) | 0;
    b = (b - a) | 0; b ^= (a << 19) | (a >>> 13); a = (a + c) | 0;
    c = (c - b) | 0; c ^= (b << 4) | (b >>> 28); b = (b + a) | 0;
    length -= 12;
    k += 12;
  }
  switch (length) {
    case 12: c = (c + (bytes[k + 11] << 24)) | 0; // falls through
    case 11: c = (c + (bytes[k + 10] << 16)) | 0; // falls through
    case 10: c = (c + (bytes[k + 9] << 8)) | 0; // falls through
    case 9: c = (c + bytes[k + 8]) | 0; // falls through
    case 8: b = (b + (bytes[k + 7] << 24)) | 0; // falls through
    case 7: b = (b + (bytes[k + 6] << 16)) | 0; // falls through
    case 6: b = (b + (bytes[k + 5] << 8)) | 0; // falls through
    case 5: b = (b + bytes[k + 4]) | 0; // falls through
    case 4: a = (a + (bytes[k + 3] << 24)) | 0; // falls through
    case 3: a = (a + (bytes[k + 2] << 16)) | 0; // falls through
    case 2: a = (a + (bytes[k + 1] << 8)) | 0; // falls through
    case 1: a = (a + bytes[k]) | 0; break;
    case 0: return c >>> 0;
  }
  // final(a, b, c)
  c ^= b; c = (c - ((b << 14) | (b >>> 18))) | 0;
  a ^= c; a = (a - ((c << 11) | (c >>> 21))) | 0;
  b ^= a; b = (b - ((a << 25) | (a >>> 7))) | 0;
  c ^= b; c = (c - ((b << 16) | (b >>> 16))) | 0;
  a ^= c; a = (a - ((c << 4) | (c >>> 28))) | 0;
  b ^= a; b = (b - ((a << 14) | (a >>> 18))) | 0;
  c ^= b; c = (c - ((b << 24) | (b >>> 8))) | 0;
  return c >>> 0;
}

/**
 * Whether the last four bytes of `bytes` are the lookup3 checksum of the
 * bytes before them.
 */
export function hasValidChecksum(bytes) {
  if (bytes.length < 4) return false;
  const end = bytes.length - 4;
  const stored = (bytes[end] | (bytes[end + 1] << 8) | (bytes[end + 2] << 16) | (bytes[end + 3] << 24)) >>> 0;
  return lookup3(bytes.subarray(0, end)) === stored;
}

/** Fold a 32-bit sum to 16 bits plus carry, as the C code does. */
function fold(sum) {
  return (sum & 0xffff) + (sum >>> 16);
}

/** HDF5's Fletcher-32 of `bytes` (16-bit big-endian words, odd byte padded). */
export function fletcher32(bytes) {
  const words = bytes.length >>> 1;
  let sum1 = 0;
  let sum2 = 0;
  let index = 0;
  let remaining = words;
  while (remaining > 0) {
    // The sums are 32-bit unsigned in the C code: wrap exactly as it does.
    let block = remaining > 360 ? 360 : remaining;
    remaining -= block;
    while (block-- > 0) {
      sum1 = (sum1 + ((bytes[index] << 8) | bytes[index + 1])) >>> 0;
      index += 2;
      sum2 = (sum2 + sum1) >>> 0;
    }
    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }
  if (bytes.length & 1) {
    sum1 = (sum1 + (bytes[index] << 8)) >>> 0;
    sum2 = (sum2 + sum1) >>> 0;
    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }
  sum1 = fold(sum1);
  sum2 = fold(sum2);
  return ((sum2 << 16) | sum1) >>> 0;
}
