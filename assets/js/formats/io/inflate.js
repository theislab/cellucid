/**
 * DEFLATE decompression with the platform's native `DecompressionStream`.
 *
 * One entry point for every compressed byte the format readers meet: HDF5's
 * deflate filter and Zarr's zlib codec (`'deflate'`, zlib-wrapped), Zarr's
 * gzip codec (`'gzip'`), ZIP entries (`'deflate-raw'`). Native inflation
 * outpaces any JavaScript or WebAssembly inflater; it still runs on the thread
 * that drives the stream, so chunks large enough are inflated on a decode
 * worker (`decode-pool.js`), which calls this there.
 *
 * When the decompressed size is known (an HDF5 chunk, a ZIP entry), the output
 * is allocated once and filled in place, and decompression stops as soon as
 * it would exceed that size: a corrupt or hostile stream can never grow
 * memory past what the format declared. The input is fed to the decompressor
 * in slices (`createSlicedInputStream`), so that bound holds while it
 * decodes: WebKit's decompressor inflates everything written to it at once,
 * and a whole chunk written in one piece expanded a 60 MB bomb past a
 * 1024-byte declared size before the reader could stop it. The session
 * codec (`app/session/codecs/gzip.js`) paces its input the same way.
 *
 * The output stream's reader is read to its end (or cancelled) and then
 * dropped, never released (`releaseLock()`): WebKit runs the release's
 * JavaScript while holding a lock its garbage collector takes when it visits
 * the reader, so a collection that starts during the release never finishes,
 * and every later collection in the tab waits behind it — the page's too
 * (WebKit 314030@main, `ReadableStreamDefaultReader::releaseLock`). A
 * dataset whose structure reads a compressed chunk then hung for good on
 * opening (`tests/browser-stream-reader-release-contract.test.mjs`).
 *
 * @module formats/io/inflate
 */

import { formatCountOf } from '../../utils/format-units.js';

const FORMATS = new Set(['deflate', 'gzip', 'deflate-raw']);

/** A DEFLATE stream that could not be decompressed. */
export class InflateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InflateError';
  }
}

function requireDecompressionStream(format, label) {
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new InflateError(
      `${label}: this browser cannot decompress ${format} data; a current browser is required.`
    );
  }
}

/**
 * Input bytes handed to a native decompressor per pull.
 *
 * Every supported engine's `DecompressionStream` inflates each written chunk
 * to completion before it honours backpressure, so a whole payload written as
 * one chunk lets a DEFLATE bomb expand without bound before any reader limit
 * can cancel it. Feeding the input in slices of this size bounds the output
 * produced past a reader's limit to DEFLATE's maximum expansion of one slice
 * (1032 x 32 KiB, about 33 MiB), at a few percent of inflate throughput.
 */
export const NATIVE_INFLATE_INPUT_SLICE_BYTES = 32 * 1024;

/**
 * Stream byte parts to a native decompressor in bounded slices, one slice
 * per pull, so inflation advances only as fast as its reader consumes it.
 *
 * @param {readonly Uint8Array[]} parts
 * @returns {ReadableStream<Uint8Array>}
 */
export function createSlicedInputStream(parts) {
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      throw new TypeError('Native decompressor input must be Uint8Array parts.');
    }
  }
  let partIndex = 0;
  let partOffset = 0;
  return new ReadableStream({
    pull(controller) {
      while (
        partIndex < parts.length
        && partOffset >= parts[partIndex].byteLength
      ) {
        partIndex += 1;
        partOffset = 0;
      }
      if (partIndex === parts.length) {
        controller.close();
        return;
      }
      const part = parts[partIndex];
      const end = Math.min(
        part.byteLength,
        partOffset + NATIVE_INFLATE_INPUT_SLICE_BYTES,
      );
      controller.enqueue(part.subarray(partOffset, end));
      partOffset = end;
    },
  }, { highWaterMark: 0 });
}

/**
 * The decompressed stream of `input`, fed to the decompressor one slice per
 * pull: inflation advances only as fast as the output is read, so a reader
 * that stops at a declared size stops the decoding too.
 */
function decompressed(input, format) {
  return createSlicedInputStream([input]).pipeThrough(new globalThis.DecompressionStream(format));
}

/**
 * Decompress `input`.
 *
 * @param {Uint8Array} input
 * @param {{format?: 'deflate'|'gzip'|'deflate-raw', expectedSize?: number|null, maxSize?: number|null, label?: string}} [options]
 *   `expectedSize`: the exact decompressed size, when the format records it;
 *   `maxSize`: the most it may decompress to, when the format records only a
 *   bound (variable-length strings: a chunk's element count bounds nothing,
 *   but the caller can bound what it will accept)
 * @returns {Promise<Uint8Array>}
 */
export async function inflate(input, { format = 'deflate', expectedSize = null, maxSize = null, label = 'Compressed data' } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('inflate reads a Uint8Array.');
  if (!FORMATS.has(format)) throw new TypeError(`Unknown DEFLATE format '${format}'.`);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new TypeError('An expected decompressed size must be a whole number of bytes.');
  }
  if (maxSize !== null && (!Number.isSafeInteger(maxSize) || maxSize < 0)) {
    throw new TypeError('A maximum decompressed size must be a whole number of bytes.');
  }
  requireDecompressionStream(format, label);
  const stream = decompressed(input, format);
  if (expectedSize === null && maxSize === null) {
    try {
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (cause) {
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause });
    }
  }
  if (expectedSize === null) {
    // Bounded but unknown: gather pieces, refusing as soon as they pass the bound.
    const reader = stream.getReader();
    const pieces = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxSize) {
          throw new InflateError(`${label} decompresses to more than the ${formatCountOf(maxSize, 'byte')} it may hold.`);
        }
        pieces.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof InflateError) throw error;
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
    }
    const output = new Uint8Array(total);
    let at = 0;
    for (const piece of pieces) {
      output.set(piece, at);
      at += piece.length;
    }
    return output;
  }
  const output = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let filled = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > expectedSize - filled) {
        throw new InflateError(`${label} decompresses to more than the ${formatCountOf(expectedSize, 'byte')} it declares.`);
      }
      output.set(value, filled);
      filled += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof InflateError) throw error;
    throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
  }
  if (filled !== expectedSize) {
    throw new InflateError(`${label} decompresses to ${formatCountOf(filled, 'byte')}, not the ${expectedSize} it declares.`);
  }
  return output;
}
