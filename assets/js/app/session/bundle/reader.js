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
  MAX_FRAME_BYTES,
  NOT_A_SESSION_FILE_MESSAGE,
  SESSION_BUNDLE_MAGIC_BYTES,
  U32_BYTES,
  bytesToU32LE
} from './format.js';
import {
  assertNonEmptyString,
  assertSafeInteger,
} from '../schema-contract.js';
import { requireExactKeys, requirePlainRecord } from '../../../utils/exact-record.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * The byte stream ended before a read it was asked for. Kept distinct so the
 * header check can tell "too short to be a session file" from a real failure.
 */
class UnexpectedEndOfFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnexpectedEndOfFileError';
  }
}

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

class StreamByteReader {
  /**
   * @param {ReadableStreamDefaultReader<Uint8Array>} reader
   * @param {{ totalBytes: number | null, signal: AbortSignal | null, onProgress: ((loadedBytes: number) => void) | null }} options
   */
  constructor(reader, options) {
    requireExactKeys(
      options,
      ['totalBytes', 'signal', 'onProgress'],
      'Session byte reader options'
    );
    this._reader = reader;
    this._signal = options.signal;
    this._onProgress = options.onProgress;
    this._totalBytes = options.totalBytes;

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
    while (this._queue.length === 0 && !this._streamDone) {
      throwIfAborted(this._signal);
      const { value, done } = await this._reader.read();
      if (done) {
        this._streamDone = true;
        return;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Session byte stream must yield Uint8Array chunks.');
      }
      if (value.byteLength === 0) continue;
      this._queue.push(value);
      this._loadedBytes += value.byteLength;
      if (this._onProgress !== null) {
        this._onProgress(this._loadedBytes);
      }
    }
  }

  /**
   * Read exactly `n` bytes or throw on EOF.
   * @param {number} n
   * @returns {Promise<Uint8Array>}
   */
  async readExactly(n) {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`readExactly: invalid byte count ${n}`);
    }
    throwIfAborted(this._signal);

    // Bounds check against known total file size (Blob/File).
    if (this._totalBytes != null) {
      const remaining = this._totalBytes - this._position;
      if (n > remaining) {
        throw new UnexpectedEndOfFileError(
          `Unexpected end of file (need ${formatCountOf(n, 'byte')}, only ${remaining} remaining).`
        );
      }
    }

    if (n === 0) return new Uint8Array(0);

    const out = new Uint8Array(n);
    let outOffset = 0;

    while (outOffset < n) {
      await this._fill();
      if (this._queue.length === 0) {
        throw new UnexpectedEndOfFileError('Unexpected end of file.');
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

  async assertEnd() {
    await this._fill();
    if (this._queue.length !== 0) {
      throw new Error('Invalid session file: trailing bytes after declared chunks.');
    }
    if (!this._streamDone) {
      throw new Error('Invalid session file: byte stream did not reach its exact end.');
    }
    if (this._totalBytes !== null && this._position !== this._totalBytes) {
      throw new Error('Invalid session file: consumed byte count does not match file size.');
    }
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
 * @param {{ signal: AbortSignal | null, onProgress: ((loadedBytes: number) => void) | null }} options
 * `cancel(reason)` releases the source for a consumer that abandons the
 * bundle before its chunk stream ends; it is a no-op once the stream ended.
 *
 * @returns {Promise<{ manifest: any, totalBytes: number|null, chunkStream: AsyncGenerator<BundleChunkRead, void, void>, cancel: (reason: unknown) => Promise<void> }>}
 */
export async function readBundle(source, options) {
  requireExactKeys(
    options,
    ['signal', 'onProgress'],
    'Session bundle reader options'
  );
  const signal = options.signal;
  throwIfAborted(signal);

  let totalBytes = null;
  let stream = null;
  if (source !== null && typeof source === 'object' && typeof source.stream === 'function') {
    stream = source.stream();
    if (typeof source.size === 'number') {
      totalBytes = assertSafeInteger(
        source.size,
        'Session bundle source size',
        { maximum: Number.MAX_SAFE_INTEGER },
      );
    }
  } else if (source !== null && typeof source === 'object' && typeof source.getReader === 'function') {
    stream = source;
  }

  if (
    stream === null
    || typeof stream !== 'object'
    || typeof stream.getReader !== 'function'
  ) {
    throw new TypeError('readBundle: expected a Blob/File or ReadableStream<Uint8Array>.');
  }
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError('readBundle: signal must be an AbortSignal or null.');
  }
  const onProgress = options.onProgress;
  if (onProgress !== null && typeof onProgress !== 'function') {
    throw new TypeError('readBundle: onProgress must be a function or null.');
  }

  const reader = stream.getReader();
  const byteReader = new StreamByteReader(reader, {
    totalBytes,
    signal,
    onProgress
  });

  // The reader is owned here until the chunk stream reaches its exact end.
  // Every other way out (a malformed header, a failed chunk, a consumer that
  // stops iterating or abandons the bundle) cancels it, so a failed restore
  // never leaves the source stream locked and reading.
  let readerSettled = false;
  const cancel = async reason => {
    if (readerSettled) return;
    readerSettled = true;
    await reader.cancel(reason).catch(() => {});
  };

  let manifest;
  try {
    // 1) MAGIC. A file shorter than the signature is not a session file
    // either, and says so in the same words as one with the wrong signature
    // rather than as an end-of-file error about byte counts.
    let magic;
    try {
      magic = await byteReader.readExactly(SESSION_BUNDLE_MAGIC_BYTES.byteLength);
    } catch (error) {
      if (error instanceof UnexpectedEndOfFileError) {
        throw new Error(NOT_A_SESSION_FILE_MESSAGE, { cause: error });
      }
      throw error;
    }
    if (!SESSION_BUNDLE_MAGIC_BYTES.every((byte, i) => magic[i] === byte)) {
      throw new Error(NOT_A_SESSION_FILE_MESSAGE);
    }

    // 2) Manifest length
    const manifestByteLength = await byteReader.readU32LE();
    if (manifestByteLength <= 0) {
      throw new Error(`Invalid manifest length: ${formatCountOf(manifestByteLength, 'byte')}.`);
    }
    if (
      byteReader.totalBytes != null
      && manifestByteLength > byteReader.totalBytes - byteReader.position
    ) {
      throw new Error(
        `Invalid manifest length: ${formatCountOf(manifestByteLength, 'byte')} is more than the session file holds (session file truncated?).`
      );
    }

    // 3) Manifest bytes
    const manifestBytes = await byteReader.readExactly(manifestByteLength);
    try {
      manifest = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
      );
    } catch (error) {
      if (error instanceof RangeError) {
        // The browser's longest string is the only limit left on a manifest.
        throw new Error(
          `Session manifest of ${formatCountOf(manifestByteLength, 'byte')} is longer than this browser can hold as text.`,
          { cause: error },
        );
      }
      throw new Error('Invalid session file (manifest JSON parse failed).', {
        cause: error,
      });
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('Invalid session file (manifest must be a JSON object).');
    }
    if (!Array.isArray(manifest.chunks)) {
      throw new Error('Invalid session file (manifest.chunks must be an array).');
    }
  } catch (error) {
    await cancel(error);
    throw error;
  }

  async function* chunkStream() {
    try {
      for (let i = 0; i < manifest.chunks.length; i++) {
        throwIfAborted(signal);
        const meta = manifest.chunks[i];
        requirePlainRecord(meta, `Session manifest chunk ${i}`);
        const metaId = assertNonEmptyString(
          meta.id,
          `Session manifest chunk ${i} id`,
        );
        const chunkByteLength = await byteReader.readU32LE();

        const storedBytes = assertSafeInteger(
          meta.storedBytes,
          `Session manifest chunk "${metaId}" storedBytes`,
          { maximum: MAX_FRAME_BYTES },
        );
        if (storedBytes !== chunkByteLength) {
          throw new Error(`Chunk length mismatch for ${metaId}: header=${chunkByteLength}, manifest=${storedBytes}`);
        }

        // Bounds check against total file size (prevents "length says 2GB" on short files).
        if (byteReader.totalBytes != null) {
          const remaining = byteReader.totalBytes - byteReader.position;
          if (chunkByteLength > remaining) {
            throw new Error(
              `Invalid chunk length for ${metaId}: ${chunkByteLength} > remaining ${remaining} (session file truncated?)`
            );
          }
        }

        const bytes = await byteReader.readExactly(chunkByteLength);
        yield { index: i, meta, bytes };
      }
      await byteReader.assertEnd();
      readerSettled = true;
    } catch (error) {
      await cancel(error);
      throw error;
    } finally {
      // A consumer that stopped iterating early still owns an unsettled
      // reader here; after the exact end or a failure this is a no-op.
      await cancel(new DOMException('Session bundle reading stopped.', 'AbortError'));
    }
  }

  return { manifest, totalBytes, chunkStream: chunkStream(), cancel };
}
