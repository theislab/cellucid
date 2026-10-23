/**
 * The back-reference copy every LZ77 decoder here shares (Zstandard, LZ4,
 * blosclz, LZF): `length` bytes from `offset` bytes back, where the source
 * may overlap what is being written (a short offset repeats a pattern).
 *
 * The copy writes exactly `[at, at + length)`. Callers check both bounds
 * first; this does not.
 *
 * - A long copy is done with `copyWithin` in doubling steps: the bytes
 *   written so far repeat the pattern, so each step copies all of them
 *   (never overlapping its own source) until the match is complete.
 * - A short copy whose source is at least four bytes back moves four bytes at
 *   a time through a `DataView` (unaligned access is fine there); a source
 *   one to three bytes back is first widened by writing one period byte by
 *   byte, so that the rest can move four bytes at a time too.
 *
 * @module formats/io/lz-match
 */

/** Shortest match copied with `copyWithin` steps rather than four bytes at a time. */
export const BLOCK_COPY_BYTES = 256;

/**
 * Copy a match.
 *
 * @param {Uint8Array} out
 * @param {DataView} view - Over exactly `out`
 * @param {number} at - Where the match is written
 * @param {number} offset - How far back its source starts (at least 1)
 * @param {number} length
 */
export function copyMatch(out, view, at, offset, length) {
  const stop = at + length;
  let from = at - offset;
  let o = at;
  if (length >= BLOCK_COPY_BYTES) {
    const base = from;
    while (o < stop) {
      const step = Math.min(o - base, stop - o);
      out.copyWithin(o, base, base + step);
      o += step;
    }
    return;
  }
  if (offset < 4) {
    if (length < 16) {
      while (o < stop) out[o++] = out[from++];
      return;
    }
    // Write one period of four or more bytes (1 -> 4, 2 -> 4, 3 -> 6) byte
    // by byte; the rest repeats it from that far back.
    const period = offset === 3 ? 6 : 4;
    const head = at + period - offset;
    while (o < head) out[o++] = out[from++];
    from = o - period;
  }
  const last = stop - 4;
  while (o <= last) {
    view.setInt32(o, view.getInt32(from, true), true);
    o += 4;
    from += 4;
  }
  while (o < stop) out[o++] = out[from++];
}
