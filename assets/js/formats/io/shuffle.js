/**
 * Undoing a byte shuffle, the filter HDF5 (`shuffle`), numcodecs (`Shuffle`)
 * and Blosc (`SHUFFLE`) share: `count` elements of `typesize` bytes were
 * stored as `typesize` lanes, lane `b` holding byte `b` of every element in
 * order; bytes past the last whole element were left where they were.
 *
 * Elements of 2, 4 and 8 bytes are rebuilt four at a time: one 32-bit read
 * from each lane gives four elements' bytes, rearranged into the elements
 * with shifts and masks (a 4x4 byte transpose per four bytes of element).
 *
 * @module formats/io/shuffle
 */

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Four elements' byte `b` (lanes `w0`..`w3`, one per element byte) as the elements' words. */
function transposeInto(words, w, step, w0, w1, w2, w3) {
  words[w] = (w0 & 0xff) | ((w1 & 0xff) << 8) | ((w2 & 0xff) << 16) | (w3 << 24);
  words[w + step] = ((w0 >>> 8) & 0xff) | (w1 & 0xff00) | ((w2 & 0xff00) << 8) | ((w3 & 0xff00) << 16);
  words[w + 2 * step] = ((w0 >>> 16) & 0xff) | ((w1 >>> 8) & 0xff00) | (w2 & 0xff0000) | ((w3 & 0xff0000) << 8);
  words[w + 3 * step] = (w0 >>> 24) | ((w1 >>> 16) & 0xff00) | ((w2 >>> 8) & 0xff0000) | (w3 & 0xff000000);
}

/**
 * Undo the shuffle of `src[0, size)` into `dest[at, at + size)`.
 *
 * @param {Uint8Array} src
 * @param {Uint8Array} dest - Not overlapping `src`
 * @param {number} at
 * @param {number} size
 * @param {number} typesize
 */
export function byteUnshuffleInto(src, dest, at, size, typesize) {
  const count = Math.floor(size / typesize);
  let e = 0;
  if (LITTLE_ENDIAN && (typesize === 2 || typesize === 4 || typesize === 8) && (dest.byteOffset + at) % 4 === 0 && count >= 4) {
    const lanes = new DataView(src.buffer, src.byteOffset, size);
    const words = new Int32Array(dest.buffer, dest.byteOffset + at, (count * typesize) >>> 2);
    const quads = count - (count % 4);
    if (typesize === 4) {
      for (let w = 0; e < quads; e += 4, w += 4) {
        transposeInto(words, w, 1,
          lanes.getInt32(e, true), lanes.getInt32(count + e, true),
          lanes.getInt32(2 * count + e, true), lanes.getInt32(3 * count + e, true));
      }
    } else if (typesize === 8) {
      for (let w = 0; e < quads; e += 4, w += 8) {
        transposeInto(words, w, 2,
          lanes.getInt32(e, true), lanes.getInt32(count + e, true),
          lanes.getInt32(2 * count + e, true), lanes.getInt32(3 * count + e, true));
        transposeInto(words, w + 1, 2,
          lanes.getInt32(4 * count + e, true), lanes.getInt32(5 * count + e, true),
          lanes.getInt32(6 * count + e, true), lanes.getInt32(7 * count + e, true));
      }
    } else {
      for (let w = 0; e < quads; e += 4, w += 2) {
        const low = lanes.getInt32(e, true);
        const high = lanes.getInt32(count + e, true);
        words[w] = (low & 0xff) | ((high & 0xff) << 8) | ((low & 0xff00) << 8) | ((high & 0xff00) << 16);
        words[w + 1] = ((low >>> 16) & 0xff) | ((high >>> 8) & 0xff00) | ((low >>> 8) & 0xff0000) | (high & 0xff000000);
      }
    }
  }
  // The elements left (all of them for other sizes), byte by byte.
  for (let byte = 0; byte < typesize; byte++) {
    const lane = byte * count;
    for (let i = e, o = at + e * typesize + byte; i < count; i++, o += typesize) dest[o] = src[lane + i];
  }
  const done = count * typesize;
  if (done < size) dest.set(src.subarray(done, size), at + done);
}

/**
 * Undo the shuffle of all of `input` into a new array.
 *
 * @param {Uint8Array} input
 * @param {number} typesize
 * @returns {Uint8Array}
 */
export function byteUnshuffle(input, typesize) {
  const output = new Uint8Array(input.length);
  if (typesize <= 1) output.set(input);
  else byteUnshuffleInto(input, output, 0, input.length, typesize);
  return output;
}
