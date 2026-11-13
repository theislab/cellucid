/**
 * Writes and reads through a file's synchronous access handle (the
 * origin-private file system, in a worker), each checked against what the
 * file holds.
 *
 * A handle's `write` returns the bytes it wrote and `read` the bytes it read,
 * and a caller that trusts them both is wrong in one browser: Chromium's
 * off-the-record storage (a private window; a test browser's new context)
 * keeps a site's files in memory and, once its share is spent, reports a
 * write whole while keeping only part of it (`navigator.storage.estimate()`
 * still saying there is room), and a later read gives the short file back.
 * So
 * a write is checked against the file's size (once, where a run of
 * appended writes ends), refused as the quota refusal it is
 * (`QuotaExceededError`, as the browser would have thrown it); and a read
 * that returns fewer bytes than were asked for is refused, never left as
 * zeros in its buffer (`KeptBytesMissing`).
 *
 * @module formats/io/sync-access
 */

import { formatCount, formatCountOf } from '../../utils/format-units.js';

/** A read of a kept file that returned fewer bytes than its record names. */
export class KeptBytesMissing extends Error {
  /**
   * @param {number} read
   * @param {number} wanted
   * @param {number} at
   */
  constructor(read, wanted, at) {
    super(`This browser's storage returned ${formatCount(read)} of the ${formatCountOf(wanted, 'byte')} kept at ${at}: what it kept is shorter than what was written.`);
    this.name = 'KeptBytesMissing';
    this.read = read;
    this.wanted = wanted;
  }
}

function shortWrite(kept, wanted, at) {
  return new DOMException(
    `This browser's storage kept ${formatCount(Math.max(0, kept))} of ${formatCountOf(wanted, 'byte')} written at ${at}.`,
    'QuotaExceededError'
  );
}

/**
 * Write all of `bytes` at `at`, as many writes as it takes. A write that
 * makes no progress is the storage refusing it. Whether the file holds what
 * was written is checked by `requireHeld` where a run of writes ends.
 *
 * @param {{write: (view: ArrayBufferView, options: {at: number}) => number}} handle
 * @param {Uint8Array|ArrayBufferView} bytes
 * @param {number} at
 */
export function writeAt(handle, bytes, at) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let done = 0;
  while (done < view.length) {
    const wrote = handle.write(view.subarray(done), { at: at + done });
    if (!(wrote > 0)) throw shortWrite(done, view.length, at);
    done += wrote;
  }
}

/**
 * The file holds at least `end` bytes, as the writes before said it would.
 *
 * @param {{getSize: () => number}} handle
 * @param {number} end
 * @param {number} [from] - Where the writes checked began (for the message)
 */
export function requireHeld(handle, end, from = 0) {
  const size = handle.getSize();
  if (size < end) throw shortWrite(size - from, end - from, from);
}

/**
 * `writeAt`, then `requireHeld` for it: one write checked on its own.
 *
 * @param {{write: Function, getSize: () => number}} handle
 * @param {Uint8Array|ArrayBufferView} bytes
 * @param {number} at
 */
export function writeWhole(handle, bytes, at) {
  writeAt(handle, bytes, at);
  requireHeld(handle, at + bytes.byteLength, at);
}

/**
 * Fill all of `out` from `at`, or refuse (`KeptBytesMissing`).
 *
 * @param {{read: (view: ArrayBufferView, options: {at: number}) => number}} handle
 * @param {ArrayBufferView} out
 * @param {number} at
 * @returns {ArrayBufferView} `out`
 */
export function readWhole(handle, out, at) {
  const read = handle.read(out, { at });
  if (read !== out.byteLength) throw new KeptBytesMissing(read, out.byteLength, at);
  return out;
}
