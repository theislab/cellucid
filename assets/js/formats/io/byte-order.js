/**
 * The byte order of the host, and the one swap every reader uses to bring
 * stored values into it: HDF5 and Zarr arrays declare theirs per dtype, R's
 * XDR payloads are big-endian, and a typed array holds host-order values.
 * Every shipping browser runs little-endian; the readers still compare a
 * stored order with the host's, in this one place, rather than assume it.
 *
 * @module formats/io/byte-order
 */

/** Whether this host stores multi-byte values least significant byte first. */
export const HOST_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

/**
 * Whether values of `size` bytes stored in this order (`littleEndian`) must
 * be swapped to be read as typed arrays on this host.
 *
 * @param {boolean} littleEndian
 * @param {number} size
 * @returns {boolean}
 */
export function needsSwap(littleEndian, size) {
  return size > 1 && littleEndian !== HOST_LITTLE_ENDIAN;
}

/**
 * Reverse the byte order of every `size`-byte element of `bytes`, in place.
 *
 * @param {Uint8Array} bytes
 * @param {number} size - 1, 2, 4, 8 or 16 (a complex value's two parts swap each on its own when given 8)
 */
export function swapBytes(bytes, size) {
  if (size === 1) return;
  const aligned = bytes.byteOffset % size === 0 && bytes.length % size === 0;
  if (aligned && size === 2) {
    const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      words[i] = ((v & 0xff) << 8) | (v >>> 8);
    }
    return;
  }
  if (aligned && (size === 4 || size === 8)) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      words[i] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
    }
    if (size === 8) {
      for (let i = 0; i < words.length; i += 2) {
        const low = words[i];
        words[i] = words[i + 1];
        words[i + 1] = low;
      }
    }
    return;
  }
  for (let start = 0; start + size <= bytes.length; start += size) {
    for (let a = start, b = start + size - 1; a < b; a++, b--) {
      const t = bytes[a];
      bytes[a] = bytes[b];
      bytes[b] = t;
    }
  }
}
