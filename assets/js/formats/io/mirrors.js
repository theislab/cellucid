/**
 * The addresses one file (or one Zarr folder) is read from: its own URL
 * first, then its mirrors (other URLs of the same bytes, such as a public S3
 * object's other addresses, `s3.js`). Shared by `httpByteSource` and the
 * Zarr web host store, so both spread requests and judge mirrors alike.
 *
 * - A request goes to the address with the fewest requests asked of it and
 *   not yet answered (`take`), the file's own on a tie, so a burst is shared
 *   among the addresses as it is asked for.
 * - A mirror is dropped for good only on evidence that it is not serving
 *   the same file (`wrong`: another status than the file's own would give,
 *   another size, range or `ETag`), or when it could not be reached twice
 *   in a row (`failed`: a stall, no connection). An answer that says the
 *   host is busy (S3's `503 SlowDown`, which every address of a bucket
 *   gives alike) is no evidence against the mirror: it is kept. Whatever a
 *   mirror fails, the request is asked of the file's own URL at once, so a
 *   mirror adds connections and never a failure.
 *
 * @module formats/io/mirrors
 */

/**
 * @param {number} count - Addresses: the file's own, then its mirrors
 */
export function createMirrorSet(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('A mirror set has at least the file\'s own address.');
  const asked = new Array(count).fill(0);
  const strikes = new Array(count).fill(0);
  const dropped = new Set();
  return Object.freeze({
    count,
    /** The address the next request goes to; counted as asked until `release`. */
    take() {
      let chosen = 0;
      for (let i = 1; i < count; i++) {
        if (!dropped.has(i) && asked[i] < asked[chosen]) chosen = i;
      }
      asked[chosen]++;
      return chosen;
    },
    /** The file's own address, for a request a mirror failed: counted as asked until `release`. */
    takeOwn() {
      asked[0]++;
      return 0;
    },
    /** The request asked of `index` was answered, or given up. */
    release(index) {
      asked[index]--;
    },
    /** `index` answered the request as the file's own address would. */
    succeeded(index) {
      strikes[index] = 0;
    },
    /** `index` could not be reached (a stall, no connection): dropped at the second time in a row. */
    failed(index) {
      if (index === 0) return;
      if (++strikes[index] >= 2) dropped.add(index);
    },
    /** `index` answered with bytes of another file, or as the file's own address would not: dropped. */
    wrong(index) {
      if (index !== 0) dropped.add(index);
    },
    /** Whether `index` is still asked. */
    live(index) {
      return !dropped.has(index);
    },
  });
}
