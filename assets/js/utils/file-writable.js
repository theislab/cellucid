/**
 * A file's writable stream (`FileSystemFileHandle.createWritable()`: how a
 * page writes a file of the origin-private file system, or one the person
 * named in a save dialog) that writes exactly the bytes it is given, in
 * every engine.
 *
 * WebKit writes the **whole buffer** under a typed-array view handed to
 * `FileSystemWritableFileStream.write()`, not the view (a 1 MB `subarray` of
 * an 8 MB buffer, and a `DataView` of it, each write an 8 MB file; Chromium
 * and Firefox write 1 MB). An array that
 * spans its whole buffer, a Blob, an `ArrayBuffer` and text are written as
 * they are everywhere. So a view of part of a buffer is handed over as a
 * Blob of its bytes (`exactChunk`), and anything else as it is.
 *
 * Every writable stream of the app is opened here: no other module calls
 * `createWritable` (`tests/file-writable-contract.test.mjs`), so no writer
 * can hand an engine a view it writes wrongly. A worker's synchronous
 * access handle writes the view it is given in every engine
 * (`formats/io/sync-access.js`).
 *
 * @module utils/file-writable
 */

/**
 * What to hand a writable stream so that it writes exactly `data`: a view
 * of part of its buffer as a Blob of the view's bytes; anything else
 * (an array that is its whole buffer, a Blob, an `ArrayBuffer`, text)
 * itself.
 *
 * @template T
 * @param {T} data
 * @returns {T|Blob}
 */
export function exactChunk(data) {
  if (!ArrayBuffer.isView(data)) return data;
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
  return new Blob([data]);
}

/**
 * Open a file's writable stream: `write(data)` appends exactly `data`
 * (bytes, a Blob, an `ArrayBuffer` or text), `close()` makes the file what
 * was written, `abort(reason)` leaves it as it was before.
 *
 * @param {{createWritable: () => Promise<{write: Function, close: Function, abort: Function}>}} handle
 * @returns {Promise<{write: (data: ArrayBufferView|ArrayBuffer|Blob|string) => Promise<void>,
 *   close: () => Promise<void>, abort: (reason?: unknown) => Promise<void>}>}
 */
export async function openFileWritable(handle) {
  const stream = await handle.createWritable();
  return {
    write: async data => { await stream.write(exactChunk(data)); },
    close: async () => { await stream.close(); },
    abort: async reason => { await stream.abort(reason); },
  };
}
