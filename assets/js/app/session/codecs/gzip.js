/**
 * @fileoverview gzip compress/decompress helpers for session chunks.
 *
 * Current runtime contract requires native stream-based gzip support.
 * - `DecompressionStream('gzip')` for decompression
 * - `CompressionStream('gzip')` for compression
 *
 * All functions support an AbortSignal and enforce output size guards to
 * mitigate zip-bomb style attacks on untrusted session files.
 *
 * @module session/codecs/gzip
 */

import {
  assertExactKeys,
  assertSafeInteger
} from '../schema-contract.js';

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    // DOMException is the browser-standard for abort flows.
    throw new DOMException('Aborted', 'AbortError');
  }
}

function assertSignal(signal, context) {
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError(`${context} must be an AbortSignal or null.`);
  }
  return signal;
}

const GZIP_FIXED_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const UINT32_MODULUS = 0x100000000;

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

function readUint32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

/**
 * Check the constant-size parts of a gzip envelope against the exact output
 * contract before the native decompressor is constructed.
 *
 * Everything that requires decoding the DEFLATE stream (block structure, the
 * header and member CRCs, the trailer ISIZE against the real output, and the
 * rejection of trailing bytes or further members) is the native decoder's
 * job: every supported engine rejects each of those, which
 * `tests/browser/gzip-native-envelope.spec.mjs` pins per engine.
 *
 * @param {Uint8Array} compressed
 * @param {number} exactOutputBytes
 */
function requireSingleMemberEnvelope(compressed, exactOutputBytes) {
  if (compressed.byteLength < GZIP_FIXED_HEADER_BYTES + GZIP_TRAILER_BYTES) {
    throw new Error('Gzip member is truncated before its header and trailer.');
  }
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new Error('Gzip member has an invalid magic number.');
  }
  if (compressed[2] !== 8) {
    throw new Error(
      `Gzip member uses unsupported compression method ${compressed[2]}.`,
    );
  }
  if ((compressed[3] & 0xe0) !== 0) {
    throw new Error('Gzip member sets reserved header flag bits.');
  }
  const declaredSize = readUint32LE(
    compressed,
    compressed.byteLength - 4,
  );
  const expectedSize = exactOutputBytes % UINT32_MODULUS;
  if (declaredSize !== expectedSize) {
    throw new Error(
      `Gzip ISIZE ${declaredSize} does not match `
      + `the exact ${exactOutputBytes}-byte contract modulo 2^32.`,
    );
  }
}

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
 * Convert a Uint8Array into a ReadableStream<Uint8Array>.
 * @param {Uint8Array} bytes
 * @returns {ReadableStream<Uint8Array>}
 */
function bytesToStream(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Gzip input must be a Uint8Array.');
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/**
 * Read an entire ReadableStream into a single Uint8Array with an optional
 * maximum byte limit.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ maxBytes: number | null, signal: AbortSignal | null }} options
 * @returns {Promise<Uint8Array>}
 */
async function streamToUint8Array(stream, options) {
  assertExactKeys(
    options,
    ['maxBytes', 'signal'],
    'Gzip stream reader options'
  );
  if (
    stream === null
    || typeof stream !== 'object'
    || typeof stream.getReader !== 'function'
  ) {
    throw new TypeError('Gzip output must be a readable byte stream.');
  }
  const maxBytes = options.maxBytes === null
    ? null
    : assertSafeInteger(options.maxBytes, 'Gzip maximum output bytes');
  const signal = assertSignal(options.signal, 'Gzip stream signal');

  /** @type {Uint8Array[]} */
  const unboundedChunks = [];
  let firstBoundedChunk = null;
  let boundedOutput = null;
  let boundedOffset = 0;
  let total = 0;

  const reader = stream.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Gzip byte stream must yield Uint8Array chunks.');
      }
      const chunk = value;
      if (!chunk.byteLength) continue;

      total += chunk.byteLength;
      if (maxBytes != null && total > maxBytes) {
        throw new Error(`Decompressed data exceeds limit (${total} > ${maxBytes} bytes).`);
      }

      if (maxBytes === null) {
        unboundedChunks.push(chunk);
      } else if (firstBoundedChunk === null && boundedOutput === null) {
        firstBoundedChunk = chunk;
      } else {
        if (boundedOutput === null) {
          try {
            boundedOutput = new Uint8Array(maxBytes);
          } catch (allocationError) {
            if (!(allocationError instanceof RangeError)) throw allocationError;
            // Out of memory, not a malformed stream: keep it a RangeError.
            throw new RangeError(
              `Decompressed data needs ${maxBytes} bytes; the browser could not allocate them.`,
              { cause: allocationError },
            );
          }
          boundedOutput.set(firstBoundedChunk, 0);
          boundedOffset = firstBoundedChunk.byteLength;
          firstBoundedChunk = null;
        }
        boundedOutput.set(chunk, boundedOffset);
        boundedOffset += chunk.byteLength;
      }
    }
  } catch (error) {
    // Any failure (overflow, abort, malformed output) stops the producer, so
    // no further input is inflated for a result nobody will read.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (maxBytes !== null) {
    if (boundedOutput !== null) {
      if (boundedOffset !== maxBytes) {
        throw new Error(
          `Decompressed data produced ${boundedOffset} bytes; expected exactly ${maxBytes}.`
        );
      }
      return boundedOutput;
    }
    if (firstBoundedChunk !== null) {
      if (firstBoundedChunk.byteLength !== maxBytes) {
        throw new Error(
          `Decompressed data produced ${firstBoundedChunk.byteLength} bytes; `
          + `expected exactly ${maxBytes}.`
        );
      }
      return firstBoundedChunk;
    }
    if (maxBytes !== 0) {
      throw new Error(
        `Decompressed data produced 0 bytes; expected exactly ${maxBytes}.`
      );
    }
    return new Uint8Array(0);
  }

  // Fast path: single compression chunk.
  if (unboundedChunks.length === 1) return unboundedChunks[0];

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of unboundedChunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * gzip-decompress bytes with an exact expected output bound.
 *
 * `maxOutputBytes` is both the hard allocation ceiling and the exact
 * manifest-owned output length. Under- and over-declared chunks are terminal:
 * a trailer ISIZE that disagrees is rejected before inflation, and a stream
 * that inflates past the limit is cancelled within one input slice.
 *
 * @param {Uint8Array} compressed
 * @param {{ maxOutputBytes: number, signal: AbortSignal | null }} options
 * @returns {Promise<Uint8Array>}
 */
export async function gzipDecompress(compressed, options) {
  if (!(compressed instanceof Uint8Array)) {
    throw new TypeError('Gzip compressed input must be a Uint8Array.');
  }
  assertExactKeys(
    options,
    ['maxOutputBytes', 'signal'],
    'Gzip decompression options'
  );
  const signal = assertSignal(options.signal, 'Gzip decompression signal');
  throwIfAborted(signal);

  const maxOutputBytes = assertSafeInteger(
    options.maxOutputBytes,
    'Gzip maximum output bytes'
  );

  requireSingleMemberEnvelope(compressed, maxOutputBytes);

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Gzip decompression requires DecompressionStream.');
  }

  const decompressedStream = createSlicedInputStream([compressed])
    .pipeThrough(new DecompressionStream('gzip'));
  try {
    return await streamToUint8Array(decompressedStream, {
      maxBytes: maxOutputBytes,
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof Error && /^Decompressed data /.test(error.message)) {
      throw error;
    }
    throw new Error(
      'Gzip input is not exactly one well-formed member: '
      + `${error instanceof Error && error.message ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * gzip-compress bytes.
 *
 * @param {Uint8Array} uncompressed
 * @param {{ signal: AbortSignal | null }} options
 * @returns {Promise<Uint8Array>}
 */
export async function gzipCompress(uncompressed, options) {
  if (!(uncompressed instanceof Uint8Array)) {
    throw new TypeError('Gzip uncompressed input must be a Uint8Array.');
  }
  assertExactKeys(options, ['signal'], 'Gzip compression options');
  const signal = assertSignal(options.signal, 'Gzip compression signal');
  throwIfAborted(signal);

  if (typeof CompressionStream === 'undefined') {
    throw new Error('Gzip compression requires CompressionStream.');
  }

  const cs = new CompressionStream('gzip');
  const compressedStream = bytesToStream(uncompressed).pipeThrough(cs);
  return streamToUint8Array(compressedStream, { maxBytes: null, signal });
}
