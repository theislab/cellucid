/**
 * @fileoverview Session bundle reader with streaming chunk iteration.
 *
 * Reads the `.cellucid-session` container format (or another file kind of the
 * framing, such as a `.cellucid-library`, by its `signature`):
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
  SESSION_SIGNATURE,
  U32_BYTES,
  bytesToU32LE
} from './format.js';
import {
  assertNonEmptyString,
  assertSafeInteger,
} from '../schema-contract.js';
import { requireExactKeys, requireKeys, requirePlainRecord } from '../../../utils/exact-record.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { throwIfAborted, cancelled, requireSignalOrNull } from '../../../utils/abort.js';
import { markDamaged } from '../../../utils/errors.js';

/**
 * The byte stream ended before a read it was asked for. Kept distinct so the
 * header check can tell "too short to be a session file" from a real failure.
 */
/** A file that ends before what it declares: damaged (`utils/errors.js` `markDamaged`). */
class UnexpectedEndOfFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnexpectedEndOfFileError';
    markDamaged(this);
  }
}

/**
 * A file whose framing breaks the format: its words (offsets, lengths, ids)
 * go under Details; the person reads that the file is damaged.
 */
function damaged(message, options) {
  return markDamaged(new Error(message, options));
}

class StreamByteReader {
  /**
   * @param {ReadableStreamDefaultReader<Uint8Array>} reader
   * @param {{ totalBytes: number | null, signal: AbortSignal | null, onProgress: ((loadedBytes: number) => void) | null,
   *   file: string }} options - `file`: how a sentence names the file read
   */
  constructor(reader, options) {
    requireExactKeys(
      options,
      ['totalBytes', 'signal', 'onProgress', 'file'],
      'Bundle byte reader options'
    );
    this._reader = reader;
    this._file = options.file;
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
      throw damaged(`Invalid ${this._file}: trailing bytes after declared chunks.`);
    }
    if (!this._streamDone) {
      throw damaged(`Invalid ${this._file}: byte stream did not reach its exact end.`);
    }
    if (this._totalBytes !== null && this._position !== this._totalBytes) {
      throw damaged(`Invalid ${this._file}: consumed byte count does not match file size.`);
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
 * Read a session bundle (or another file kind of the framing, by its
 * `signature`: `SESSION_SIGNATURE` by default) and return its manifest plus a
 * streaming chunk iterator.
 *
 * @param {Blob|ReadableStream<Uint8Array>} source
 * @param {{ signal: AbortSignal | null, onProgress: ((loadedBytes: number) => void) | null,
 *   signature?: import('./format.js').BundleSignature }} options
 * `cancel(reason)` releases the source for a consumer that abandons the
 * bundle before its chunk stream ends; it is a no-op once the stream ended.
 *
 * @returns {Promise<{ manifest: any, totalBytes: number|null, chunkStream: AsyncGenerator<BundleChunkRead, void, void>, cancel: (reason: unknown) => Promise<void> }>}
 */
export async function readBundle(source, options) {
  requireKeys(
    options,
    ['signal', 'onProgress'],
    ['signature'],
    'Bundle reader options'
  );
  const { signal, signature = SESSION_SIGNATURE } = options;
  const { file, label } = signature;
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
  requireSignalOrNull(signal, 'readBundle: signal');
  const onProgress = options.onProgress;
  if (onProgress !== null && typeof onProgress !== 'function') {
    throw new TypeError('readBundle: onProgress must be a function or null.');
  }

  const reader = stream.getReader();
  const byteReader = new StreamByteReader(reader, {
    totalBytes,
    signal,
    onProgress,
    file,
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
    // 1) MAGIC. A file shorter than the signature is not a file of this kind
    // either, and says so in the same words as one with the wrong signature
    // rather than as an end-of-file error about byte counts.
    let magic;
    try {
      magic = await byteReader.readExactly(signature.bytes.byteLength);
    } catch (error) {
      // Not a damaged file of this kind: not one at all (the end-of-file error is not its cause).
      if (error instanceof UnexpectedEndOfFileError) throw new Error(signature.refusal(new Uint8Array(0)));
      throw error;
    }
    if (!signature.bytes.every((byte, i) => magic[i] === byte)) {
      // Another format version's signature, or another file kind's, says which; anything else is not this kind.
      const refused = new Error(signature.refusal(magic));
      const otherFormat = signature.otherFormat?.(magic) ?? null;
      if (otherFormat !== null) refused.otherSessionFormat = otherFormat;
      throw refused;
    }

    // 2) Manifest length
    const manifestByteLength = await byteReader.readU32LE();
    if (manifestByteLength <= 0) {
      throw damaged(`Invalid manifest length: ${formatCountOf(manifestByteLength, 'byte')}.`);
    }
    if (
      byteReader.totalBytes != null
      && manifestByteLength > byteReader.totalBytes - byteReader.position
    ) {
      throw damaged(
        `Invalid manifest length: ${formatCountOf(manifestByteLength, 'byte')} is more than the ${file} holds (${file} truncated?).`
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
          `${label} manifest of ${formatCountOf(manifestByteLength, 'byte')} is longer than this browser can hold as text.`,
          { cause: error },
        );
      }
      throw damaged(`Invalid ${file} (manifest JSON parse failed).`, {
        cause: error,
      });
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw damaged(`Invalid ${file} (manifest must be a JSON object).`);
    }
    if (!Array.isArray(manifest.chunks)) {
      throw damaged(`Invalid ${file} (manifest.chunks must be an array).`);
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
        // A chunk the manifest describes out of the format: the file is damaged.
        let metaId;
        let storedBytes;
        try {
          requirePlainRecord(meta, `${label} manifest chunk ${i}`);
          metaId = assertNonEmptyString(meta.id, `${label} manifest chunk ${i} id`);
          storedBytes = assertSafeInteger(
            meta.storedBytes,
            `${label} manifest chunk "${metaId}" storedBytes`,
            { maximum: MAX_FRAME_BYTES },
          );
        } catch (error) {
          throw markDamaged(error);
        }
        const chunkByteLength = await byteReader.readU32LE();

        if (storedBytes !== chunkByteLength) {
          throw damaged(`Chunk length mismatch for ${metaId}: header=${chunkByteLength}, manifest=${storedBytes}`);
        }

        // Bounds check against total file size (prevents "length says 2GB" on short files).
        if (byteReader.totalBytes != null) {
          const remaining = byteReader.totalBytes - byteReader.position;
          if (chunkByteLength > remaining) {
            throw damaged(
              `Invalid chunk length for ${metaId}: ${chunkByteLength} > remaining ${remaining} (${file} truncated?)`
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
      await cancel(cancelled('closed', `${label} bundle reading stopped.`));
    }
  }

  return { manifest, totalBytes, chunkStream: chunkStream(), cancel };
}
