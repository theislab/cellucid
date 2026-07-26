/**
 * @fileoverview gzip compress/decompress helpers for session chunks.
 *
 * Dev-phase policy: require native stream-based gzip support.
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
  const chunks = [];
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
        // Cancel the underlying stream ASAP to avoid continued decompression work.
        await reader.cancel('maxBytes exceeded');
        throw new Error(`Decompressed data exceeds limit (${total} > ${maxBytes} bytes).`);
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  // Fast path: single chunk.
  if (chunks.length === 1) return chunks[0];

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * gzip-decompress bytes with bounds checks.
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

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Gzip decompression requires DecompressionStream (dev-phase requirement).');
  }

  const ds = new DecompressionStream('gzip');
  const decompressedStream = bytesToStream(compressed).pipeThrough(ds);
  return streamToUint8Array(decompressedStream, { maxBytes: maxOutputBytes, signal });
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
    throw new Error('Gzip compression requires CompressionStream (dev-phase requirement).');
  }

  const cs = new CompressionStream('gzip');
  const compressedStream = bytesToStream(uncompressed).pipeThrough(cs);
  return streamToUint8Array(compressedStream, { maxBytes: null, signal });
}
