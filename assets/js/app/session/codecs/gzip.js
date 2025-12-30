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

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    // DOMException is the browser-standard for abort flows.
    throw new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Convert a Uint8Array into a ReadableStream<Uint8Array>.
 * @param {Uint8Array} bytes
 * @returns {ReadableStream<Uint8Array>}
 */
function bytesToStream(bytes) {
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
 * @param {{ maxBytes?: number | null, signal?: AbortSignal | null }} [options]
 * @returns {Promise<Uint8Array>}
 */
async function streamToUint8Array(stream, options = {}) {
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : null;
  const signal = options.signal ?? null;

  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;

  const reader = stream.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (!chunk.byteLength) continue;

      total += chunk.byteLength;
      if (maxBytes != null && total > maxBytes) {
        // Cancel the underlying stream ASAP to avoid continued decompression work.
        try { await reader.cancel('maxBytes exceeded'); } catch { /* ignore */ }
        throw new Error(`Decompressed data exceeds limit (${total} > ${maxBytes} bytes).`);
      }

      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
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
 * @param {{ maxOutputBytes?: number | null, signal?: AbortSignal | null }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function gzipDecompress(compressed, options = {}) {
  const signal = options.signal ?? null;
  throwIfAborted(signal);

  const maxOutputBytes = typeof options.maxOutputBytes === 'number' ? options.maxOutputBytes : null;

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
 * @param {{ signal?: AbortSignal | null }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function gzipCompress(uncompressed, options = {}) {
  const signal = options.signal ?? null;
  throwIfAborted(signal);

  if (typeof CompressionStream === 'undefined') {
    throw new Error('Gzip compression requires CompressionStream (dev-phase requirement).');
  }

  const cs = new CompressionStream('gzip');
  const compressedStream = bytesToStream(uncompressed).pipeThrough(cs);
  return streamToUint8Array(compressedStream, { maxBytes: null, signal });
}
