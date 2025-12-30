/**
 * @fileoverview Session bundle reader with streaming chunk iteration.
 *
 * Reads the `.cellucid-session` container format:
 *  - MAGIC bytes
 *  - manifest length (u32 LE) + manifest bytes
 *  - repeated chunks: [chunk length (u32 LE), chunk bytes]
 *
 * The reader exposes an async generator that yields chunk bytes in manifest
 * order without loading the entire file into memory.
 *
 * @module session/bundle/reader
 */

import {
  SESSION_BUNDLE_MAGIC_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_STORED_CHUNK_BYTES,
  U32_BYTES,
  bytesToU32LE
} from './format.js';

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

class StreamByteReader {
  /**
   * @param {ReadableStreamDefaultReader<Uint8Array>} reader
   * @param {{ totalBytes?: number | null, signal?: AbortSignal | null, onProgress?: (loadedBytes: number) => void }} [options]
   */
  constructor(reader, options = {}) {
    this._reader = reader;
    this._signal = options.signal ?? null;
    this._onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this._totalBytes = typeof options.totalBytes === 'number' ? options.totalBytes : null;

    /** @type {Uint8Array[]} */
    this._queue = [];
    this._queueOffset = 0;
    this._loadedBytes = 0;   // bytes read from the underlying stream
    this._position = 0;      // bytes consumed by callers
    this._streamDone = false;
  }

  get loadedBytes() { return this._loadedBytes; }
  get position() { return this._position; }
  get totalBytes() { return this._totalBytes; }

  /**
   * Ensure at least one chunk is available in the queue.
   */
  async _fill() {
    if (this._queue.length > 0 || this._streamDone) return;
    throwIfAborted(this._signal);
    const { value, done } = await this._reader.read();
    if (done) {
      this._streamDone = true;
      return;
    }
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (!chunk.byteLength) return;
    this._queue.push(chunk);
    this._loadedBytes += chunk.byteLength;
    this._onProgress?.(this._loadedBytes);
  }

  /**
   * Read exactly `n` bytes or throw on EOF.
   * @param {number} n
   * @returns {Promise<Uint8Array>}
   */
  async readExactly(n) {
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`readExactly: invalid byte count ${n}`);
    }
    throwIfAborted(this._signal);

    // Bounds check against known total file size (Blob/File).
    if (this._totalBytes != null) {
      const remaining = this._totalBytes - this._position;
      if (n > remaining) {
        throw new Error(`Unexpected end of file (need ${n} bytes, only ${remaining} remaining).`);
      }
    }

    if (n === 0) return new Uint8Array(0);

    const out = new Uint8Array(n);
    let outOffset = 0;

    while (outOffset < n) {
      await this._fill();
      if (this._queue.length === 0) {
        throw new Error('Unexpected end of file.');
      }

      const head = this._queue[0];
      const available = head.byteLength - this._queueOffset;
      const need = n - outOffset;
      const take = Math.min(available, need);

      out.set(head.subarray(this._queueOffset, this._queueOffset + take), outOffset);
      outOffset += take;
      this._queueOffset += take;
      this._position += take;

      if (this._queueOffset >= head.byteLength) {
        this._queue.shift();
        this._queueOffset = 0;
      }
    }

    return out;
  }

  /**
   * Read a u32 little-endian value.
   * @returns {Promise<number>}
   */
  async readU32LE() {
    const bytes = await this.readExactly(U32_BYTES);
    return bytesToU32LE(bytes);
  }
}

/**
 * @typedef {object} BundleChunkRead
 * @property {number} index
 * @property {any} meta - Manifest entry for the chunk.
 * @property {Uint8Array} bytes - Stored bytes (after codec).
 */

/**
 * Read a session bundle and return its manifest plus a streaming chunk iterator.
 *
 * @param {Blob|ReadableStream<Uint8Array>} source
 * @param {{ signal?: AbortSignal | null, onProgress?: (loadedBytes: number) => void }} [options]
 * @returns {Promise<{ manifest: any, totalBytes: number|null, chunkStream: AsyncGenerator<BundleChunkRead, void, void> }>}
 */
export async function readBundle(source, options = {}) {
  const signal = options.signal ?? null;
  throwIfAborted(signal);

  const totalBytes = typeof source?.size === 'number' ? source.size : null;
  const stream =
    typeof source?.stream === 'function'
      ? source.stream()
      : source;

  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error('readBundle: expected a Blob/File or ReadableStream<Uint8Array>.');
  }

  const reader = stream.getReader();
  const byteReader = new StreamByteReader(reader, {
    totalBytes,
    signal,
    onProgress: options.onProgress
  });

  // 1) MAGIC
  const magic = await byteReader.readExactly(SESSION_BUNDLE_MAGIC_BYTES.byteLength);
  for (let i = 0; i < SESSION_BUNDLE_MAGIC_BYTES.byteLength; i++) {
    if (magic[i] !== SESSION_BUNDLE_MAGIC_BYTES[i]) {
      throw new Error('Invalid session file (bad MAGIC header).');
    }
  }

  // 2) Manifest length
  const manifestByteLength = await byteReader.readU32LE();
  if (manifestByteLength <= 0 || manifestByteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`Invalid manifest length: ${manifestByteLength} bytes.`);
  }

  // 3) Manifest bytes
  const manifestBytes = await byteReader.readExactly(manifestByteLength);
  let manifest = null;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (err) {
    console.warn('[SessionBundle] Failed to parse manifest JSON:', err);
    throw new Error('Invalid session file (manifest JSON parse failed).');
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Invalid session file (manifest must be a JSON object).');
  }
  if (!Array.isArray(manifest.chunks)) {
    throw new Error('Invalid session file (manifest.chunks must be an array).');
  }

  async function* chunkStream() {
    for (let i = 0; i < manifest.chunks.length; i++) {
      throwIfAborted(signal);
      const meta = manifest.chunks[i];
      const chunkByteLength = await byteReader.readU32LE();

      // Absolute size guard to avoid pathological allocations on corrupt input.
      if (chunkByteLength > MAX_STORED_CHUNK_BYTES) {
        throw new Error(
          `Invalid chunk length for ${meta?.id || `#${i}`}: ${chunkByteLength} exceeds limit (${MAX_STORED_CHUNK_BYTES} bytes).`
        );
      }

      // Validate storedBytes when present (redundant but useful for sanity).
      const storedBytes = meta?.storedBytes;
      if (typeof storedBytes === 'number' && storedBytes !== chunkByteLength) {
        throw new Error(`Chunk length mismatch for ${meta?.id || `#${i}`}: header=${chunkByteLength}, manifest=${storedBytes}`);
      }

      // Bounds check against total file size (prevents "length says 2GB" on short files).
      if (byteReader.totalBytes != null) {
        const remaining = byteReader.totalBytes - byteReader.position;
        if (chunkByteLength > remaining) {
          throw new Error(
            `Invalid chunk length for ${meta?.id || `#${i}`}: ${chunkByteLength} > remaining ${remaining} (session file truncated?)`
          );
        }
      }

      const bytes = await byteReader.readExactly(chunkByteLength);
      yield { index: i, meta, bytes };
    }
  }

  return { manifest, totalBytes, chunkStream: chunkStream() };
}
