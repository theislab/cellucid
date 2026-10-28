/**
 * The bytes of an R file as one stream: read in order, the compression its
 * first bytes name taken off, the `save()` magic recognised.
 *
 * - gzip (`1f 8b`, `saveRDS` and `save` by default): the platform's
 *   `DecompressionStream`, fed in slices so a highly compressible stretch
 *   (a run of zeros) never expands past a bounded amount before its output
 *   is read;
 * - bzip2 (`BZh`) and xz (`fd 37 7a 58 5a 00`): this package's own decoders
 *   (`bzip2.js`, `xz.js`; no WebAssembly, so no change to the page's script
 *   policy);
 * - zstd (`28 b5 2f fd`, R >= 4.5 `compress = "zstd"`): refused with what to
 *   do;
 * - none (`X\n`, `RDX2\n`, `RDX3\n`): the bytes as they are; such a file
 *   also allows random access (`isUncompressed`).
 *
 * A compressed stream whose content is itself compressed (GEO's `.rds.gz`
 * of a gzip `.rds`) is unwrapped again, as many times as it is wrapped.
 *
 * @module formats/rds/stream
 */

import { RdsFormatError, RdsUnsupportedError } from './errors.js';
import { bunzip2 } from './bzip2.js';
import { unxz } from './xz.js';
import { gunzipWorkerScript } from '../../../workers/scripts.js';
import { startWorker } from '../../workers/worker-script.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';

/** Input bytes handed to the native decompressor per write (see `formats/io/inflate.js`). */
const INFLATE_SLICE_BYTES = 64 * 1024;

/** Bytes of a file read per request while it streams, and how many requests run ahead. */
export const STREAM_PIECE_BYTES = 4 * 1024 * 1024;
const STREAM_AHEAD = 3;

/**
 * The compression one file's first bytes name.
 *
 * @param {Uint8Array} head
 * @returns {'gzip'|'bzip2'|'xz'|'zstd'|'none'}
 */
export function compressionOf(head) {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 3 && head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) return 'bzip2';
  if (head.length >= 6 && head[0] === 0xfd && head[1] === 0x37 && head[2] === 0x7a &&
      head[3] === 0x58 && head[4] === 0x5a && head[5] === 0x00) return 'xz';
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return 'none';
}

/**
 * What uncompressed R bytes start with: an `.rds` stream (`X\n`, `A\n`,
 * `B\n`) or a `save()` file (`RDX2\n`, `RDX3\n`, and their ASCII and
 * native forms), else null.
 *
 * @param {Uint8Array} head
 * @returns {{container: 'rds'|'rda', streamOffset: number, saveVersion: number|null}|null}
 */
export function rContainerOf(head) {
  const text = String.fromCharCode(...head.subarray(0, 5));
  const save = /^RD([XAB])([23])\n$/.exec(text);
  if (save !== null) return { container: 'rda', streamOffset: 5, saveVersion: Number(save[2]) };
  if (/^[XAB]\n/.test(text)) return { container: 'rds', streamOffset: 0, saveVersion: null };
  return null;
}

/**
 * Whether a file's first bytes are an uncompressed R file (random access
 * possible).
 *
 * @param {Uint8Array} head
 */
export function isUncompressed(head) {
  return compressionOf(head) === 'none' && rContainerOf(head) !== null;
}

/**
 * Read a file in order, a few pieces ahead.
 *
 * @param {{size: number, read: (offset: number, length: number, options?: Object) => Promise<Uint8Array>}} file
 * @param {{signal?: AbortSignal|null, activity?: Object|null, onBytes?: ((read: number) => void)|null, pieceBytes?: number}} [options]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* readInOrder(file, { signal = null, activity = null, onBytes = null, pieceBytes = STREAM_PIECE_BYTES } = {}) {
  const pending = [];
  let next = 0;
  let delivered = 0;
  const request = () => {
    const offset = next;
    const length = Math.min(pieceBytes, file.size - offset);
    next += length;
    const promise = file.read(offset, length, { signal, activity });
    // A request's failure is seen when it is awaited, in order.
    promise.catch(() => {});
    pending.push(promise);
  };
  try {
    while (next < file.size && pending.length < STREAM_AHEAD) request();
    while (pending.length > 0) {
      const bytes = await pending.shift();
      if (next < file.size) request();
      delivered += bytes.length;
      onBytes?.(delivered);
      // A read is a view into a buffer the reader may reuse: copied once here.
      yield bytes.slice();
    }
  } finally {
    pending.length = 0;
  }
}

/**
 * Compressed bytes from which a gzip stream is decompressed on a worker of
 * its own (a scheduling choice, measured): below it, starting the worker
 * costs about what decompressing them in this thread does.
 */
export const GUNZIP_WORKER_MIN_BYTES = 1 << 20;

/**
 * Decompressed messages (about a megabyte each) a gzip worker may send
 * before the first is taken, and compressed pieces (`STREAM_PIECE_BYTES`)
 * sent before one is written (scheduling choices): enough that the worker
 * keeps decompressing through some 30 ms of this thread being busy
 * elsewhere (Chromium inflates about 580 MB a second).
 */
const GUNZIP_OUTPUT_AHEAD = 16;
const GUNZIP_INPUT_AHEAD = 2;

/** Set once a gzip worker could not start here: every gzip stream is then decompressed in this thread. */
let gunzipWorkersUnavailable = false;

/** A started gzip worker (its module loaded, its decompressor made), or null when none can run here. */
async function startGunzipWorker() {
  if (gunzipWorkersUnavailable || typeof globalThis.Worker !== 'function') return null;
  let worker;
  try {
    worker = startWorker(gunzipWorkerScript(), { type: 'module', name: 'cellucid-gunzip' });
  } catch {
    gunzipWorkersUnavailable = true;
    return null;
  }
  const started = await new Promise(resolve => {
    worker.onmessage = ({ data }) => resolve(data?.ready === true);
    worker.onerror = event => {
      event.preventDefault?.();
      resolve(false);
    };
  });
  if (started) return worker;
  worker.terminate();
  gunzipWorkersUnavailable = true;
  return null;
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

/**
 * The output of a gzip stream decompressed on `worker` (`gunzip-worker.js`):
 * the compressed pieces are given to it as they are read, a few ahead, and
 * its decompressed pieces come back a megabyte a message, a few ahead, so
 * the decompression runs while this thread uses what came before.
 */
async function* gunzipOnWorker(worker, pieces, signal) {
  const outputs = [];
  let finished = false;
  let failure = null;
  let feedError = null;
  let stopped = false;
  let sent = 0;
  let consumed = 0;
  let waiters = [];
  const changed = () => new Promise(resolve => waiters.push(resolve));
  const notify = () => {
    const woken = waiters;
    waiters = [];
    for (const resolve of woken) resolve();
  };
  worker.onmessage = ({ data }) => {
    if (data.output !== undefined) outputs.push(data.output);
    else if (data.consumed !== undefined) consumed += data.consumed;
    else if (data.done === true) finished = true;
    else if (data.error !== undefined) failure ??= data.error;
    notify();
  };
  worker.onerror = event => {
    event.preventDefault?.();
    failure ??= event.message || 'its worker stopped';
    notify();
  };
  const onAbort = () => notify();
  signal?.addEventListener('abort', onAbort);
  worker.postMessage({ credit: GUNZIP_OUTPUT_AHEAD });
  const feeding = (async () => {
    try {
      for await (const piece of pieces) {
        if (signal?.aborted) throw abortReason(signal);
        while (sent - consumed >= GUNZIP_INPUT_AHEAD && failure === null && !stopped && !signal?.aborted) await changed();
        if (signal?.aborted) throw abortReason(signal);
        if (failure !== null || stopped) return;
        // A view of a larger buffer is copied, so the piece goes by transfer alone.
        const own = piece.byteOffset === 0 && piece.byteLength === piece.buffer.byteLength ? piece : piece.slice();
        worker.postMessage({ input: own }, [own.buffer]);
        sent++;
      }
      worker.postMessage({ end: true });
    } catch (error) {
      feedError = error;
      notify();
    }
  })();
  try {
    for (;;) {
      while (outputs.length === 0 && !finished && failure === null && feedError === null && !signal?.aborted) await changed();
      if (feedError !== null) throw feedError;
      if (signal?.aborted) throw abortReason(signal);
      if (failure !== null) {
        throw new RdsFormatError(`The gzip stream could not be decompressed (${failure}); the file is damaged or truncated.`);
      }
      if (outputs.length === 0) break;
      const batch = outputs.shift();
      worker.postMessage({ credit: 1 });
      for (const piece of batch) yield piece;
    }
    await feeding;
    if (feedError !== null) throw feedError;
  } finally {
    // A reader that stops early: the feeding stops reading the file too.
    stopped = true;
    notify();
    signal?.removeEventListener('abort', onAbort);
    worker.terminate();
  }
}

/**
 * The output of the native gzip decompressor over pieces: on a worker of its
 * own when the stream is large enough to be worth one (`bytes`, the
 * compressed size, when known) and a worker can run here, else in this
 * thread, written in slices.
 */
async function* gunzip(pieces, signal, bytes) {
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new RdsUnsupportedError('gzip', 'This browser cannot decompress gzip data; a current browser is required.');
  }
  if (bytes >= GUNZIP_WORKER_MIN_BYTES) {
    const worker = await startGunzipWorker();
    if (worker !== null) {
      yield* gunzipOnWorker(worker, pieces, signal);
      return;
    }
  }
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let feedError = null;
  const feeding = (async () => {
    try {
      for await (const piece of pieces) {
        for (let offset = 0; offset < piece.length; offset += INFLATE_SLICE_BYTES) {
          if (signal?.aborted) throw abortReason(signal);
          await writer.ready;
          await writer.write(piece.subarray(offset, offset + INFLATE_SLICE_BYTES));
        }
      }
      await writer.close();
    } catch (error) {
      feedError = error;
      await writer.abort(error).catch(() => {});
    }
  })();
  // One read is always asked for ahead of the piece being used: a
  // decompressor that runs off this thread (Node's zlib) inflates the next
  // piece while this one is parsed, instead of waiting to be asked.
  let next = reader.read();
  next.catch(() => {});
  let ended = false;
  try {
    for (;;) {
      let result;
      try {
        result = await next;
      } catch (error) {
        ended = true;
        if (feedError !== null) throw feedError;
        throw new RdsFormatError(`The gzip stream could not be decompressed (${error?.message ?? error}); the file is damaged or truncated.`, { cause: error });
      }
      if (result.done) {
        ended = true;
        break;
      }
      next = reader.read();
      next.catch(() => {});
      yield result.value;
    }
    await feeding;
    if (feedError !== null) throw feedError;
  } finally {
    // A reader that stops early leaves the read asked for ahead: the stream
    // is cancelled, which settles it. The reader is dropped, never released
    // (`formats/io/inflate.js` says why).
    if (!ended) await reader.cancel().catch(() => {});
  }
}

/** Peek at the first bytes of an async piece sequence without losing them. */
async function peek(pieces, count) {
  const iterator = pieces[Symbol.asyncIterator]();
  const held = [];
  let have = 0;
  while (have < count) {
    const { value, done } = await iterator.next();
    if (done) break;
    if (value.length === 0) continue;
    held.push(value);
    have += value.length;
  }
  const head = allocateTypedArray(Uint8Array, Math.min(have, count), 'The start of an R file');
  let offset = 0;
  for (const piece of held) {
    if (offset >= head.length) break;
    const take = Math.min(piece.length, head.length - offset);
    head.set(piece.subarray(0, take), offset);
    offset += take;
  }
  async function* rest() {
    for (const piece of held) yield piece;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) return;
      yield value;
    }
  }
  return { head, pieces: rest() };
}

/**
 * The decompressed bytes of an R file, unwrapped as many times as it is
 * compressed, and the compressions taken off (outermost first).
 *
 * @param {AsyncIterable<Uint8Array>} pieces
 * @param {{signal?: AbortSignal|null, bytes?: number|null}} [options] - `bytes`: the compressed size, when known
 * @returns {Promise<{pieces: AsyncIterable<Uint8Array>, compressions: string[], head: Uint8Array}>}
 */
export async function decompressed(pieces, { signal = null, bytes = null } = {}) {
  const compressions = [];
  let current = pieces;
  for (;;) {
    const peeked = await peek(current, 8);
    const compression = compressionOf(peeked.head);
    if (compression === 'none') return { pieces: peeked.pieces, compressions, head: peeked.head };
    if (compression === 'zstd') {
      throw new RdsUnsupportedError(
        'zstd compression',
        'This R file is compressed with zstd (saveRDS(compress = "zstd"), R 4.5 and later), which browsers do not decompress. ' +
        'Save it again with saveRDS(object, file) (gzip), or compress = "xz" or "bzip2".'
      );
    }
    compressions.push(compression);
    if (compression === 'gzip') current = gunzip(peeked.pieces, signal, bytes);
    else if (compression === 'bzip2') current = bunzip2(peeked.pieces, { signal });
    else current = unxz(peeked.pieces, { signal });
  }
}
