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
 * memory past what the format declared.
 *
 * @module formats/io/inflate
 */

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
 * The decompressed stream of `input`, written straight into the decompressor:
 * no copy of the input (a `Blob` would make one) and no extra stream stage.
 * The write is not awaited, so a large output cannot stall it; any error
 * surfaces when the output is read.
 */
function decompressed(input, format) {
  const decompressor = new globalThis.DecompressionStream(format);
  const writer = decompressor.writable.getWriter();
  writer.write(input).catch(() => {});
  writer.close().catch(() => {});
  return decompressor.readable;
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
          throw new InflateError(`${label} decompresses to more than the ${maxSize} bytes it may hold.`);
        }
        pieces.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof InflateError) throw error;
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
    } finally {
      reader.releaseLock();
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
        throw new InflateError(`${label} decompresses to more than the ${expectedSize} bytes it declares.`);
      }
      output.set(value, filled);
      filled += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof InflateError) throw error;
    throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
  } finally {
    reader.releaseLock();
  }
  if (filled !== expectedSize) {
    throw new InflateError(`${label} decompresses to ${filled} bytes, not the ${expectedSize} it declares.`);
  }
  return output;
}
