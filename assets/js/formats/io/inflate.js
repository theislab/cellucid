/**
 * DEFLATE decompression: with the platform's native `DecompressionStream`,
 * or with fflate 0.8.2's inflater (`assets/external/fflate-0.8.2/`), which
 * the decode pool chooses per page by measuring both (`decoder-choice.js`,
 * family `deflate`).
 *
 * One entry point for every compressed byte the format readers meet: HDF5's
 * deflate filter and Zarr's zlib codec (`'deflate'`, zlib-wrapped), Zarr's
 * gzip codec (`'gzip'`), ZIP entries (`'deflate-raw'`). Native inflation is
 * fast on one core, but each stream carries a fixed cost (its stream
 * objects, the pipe, a promise per read), and on small chunks in some
 * engines that cost contends across threads (in Firefox, eight workers inflate
 * small chunks slower in total than one). fflate inflates a
 * whole chunk in one synchronous call, so it is a candidate only where the
 * decoded size is known (the output is allocated at it, one byte more to
 * catch a stream that runs past it) and the whole compressed chunk is in
 * hand (it cannot seek; `deflate-seek.js` reads into a stream). Its result
 * is checked as the native stream checks it: the zlib Adler-32 or the gzip
 * CRC-32 and size trailer. Either runs on the thread that calls it, so
 * chunks large enough are inflated on a decode worker (`decode-pool.js`),
 * which calls this there.
 *
 * When the decompressed size is known (an HDF5 chunk, a ZIP entry), the output
 * is allocated once and filled in place, and decompression stops as soon as
 * it would exceed that size: a corrupt or hostile stream can never grow
 * memory past what the format declared. The input is fed to the decompressor
 * in slices (`createSlicedInputStream`), so that bound holds while it
 * decodes: WebKit's decompressor inflates everything written to it at once,
 * and a whole chunk written in one piece would expand a bomb far past its
 * declared size before the reader could stop it. The session
 * codec (`app/session/codecs/gzip.js`) paces its input the same way, both
 * ways: a session chunk is compressed from the same slices. The slices also
 * hand the thread back (`NATIVE_CODEC_SLICE_MS`), so a long payload is never
 * one task.
 *
 * The output stream's reader is read to its end (or canceled) and then
 * dropped, never released (`releaseLock()`): WebKit runs the release's
 * JavaScript while holding a lock its garbage collector takes when it visits
 * the reader, so a collection that starts during the release never finishes,
 * and every later collection in the tab waits behind it — the page's too
 * (WebKit 314030@main, `ReadableStreamDefaultReader::releaseLock`). A
 * dataset whose structure reads a compressed chunk would then hang for good on
 * opening (`tests/browser-stream-reader-release-contract.test.mjs`).
 *
 * @module formats/io/inflate
 */

import { formatCountOf } from '../../utils/format-units.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { gunzipSync, inflateSync, unzlibSync } from '../../../external/fflate-0.8.2/browser.js';
import { crc32 } from '../zip/crc32.js';
import { decoderFor } from './decoder-choice.js';

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
 * to completion before it honors backpressure, so a whole payload written as
 * one chunk lets a DEFLATE bomb expand without bound before any reader limit
 * can cancel it. Feeding the input in slices of this size bounds the output
 * produced past a reader's limit to DEFLATE's maximum expansion of one slice
 * (1032 x 32 KiB, about 33 MiB), at a few percent of inflate throughput.
 */
export const NATIVE_INFLATE_INPUT_SLICE_BYTES = 32 * 1024;

/**
 * Longest stretch, in milliseconds, a native compressor or decompressor fed
 * by {@link createSlicedInputStream} holds its thread before the stream hands
 * the event loop back: below one 60 Hz frame. Every engine runs the native
 * transform on the thread that feeds it, and a stream pumped by promises
 * never leaves the task it started in, so however finely the input is
 * sliced a whole payload is one task: gzip runs at tens of MB/s, so a session
 * of hundreds of MB would hold the main thread for seconds (measured:
 * 21_decisions_decoders_and_codecs.md).
 */
export const NATIVE_CODEC_SLICE_MS = 12;

/**
 * Stream byte parts to a native compressor or decompressor in bounded slices,
 * one slice per pull, so it advances only as fast as its reader consumes it,
 * and yield one macrotask before a pull once the work since the last yield
 * has used {@link NATIVE_CODEC_SLICE_MS}.
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
  let sliceStart = performance.now();
  return new ReadableStream({
    async pull(controller) {
      if (performance.now() - sliceStart >= NATIVE_CODEC_SLICE_MS) {
        await yieldToMacrotask();
        sliceStart = performance.now();
      }
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
 * @param {{format?: 'deflate'|'gzip'|'deflate-raw', expectedSize?: number|null, maxSize?: number|null, label?: string, choices?: Object<string, string>|null, decoder?: string|null, into?: Uint8Array|null}} [options]
 *   `expectedSize`: the exact decompressed size, when the format records it;
 *   `maxSize`: the most it may decompress to, when the format records only a
 *   bound (variable-length strings: a chunk's element count bounds nothing,
 *   but the caller can bound what it will accept); `choices`: the decoders a
 *   decode task names (`decoder-choice.js`), else this thread's; `decoder`:
 *   the decoder itself, chosen by the caller for a larger unit (a Blosc
 *   frame's streams, by the frame's size); `into`: where the `expectedSize`
 *   bytes go (a part of a larger output), returned filled
 * @returns {Promise<Uint8Array>}
 */
export async function inflate(input, { format = 'deflate', expectedSize = null, maxSize = null, label = 'Compressed data', choices = null, decoder = null, into = null } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('inflate reads a Uint8Array.');
  if (!FORMATS.has(format)) throw new TypeError(`Unknown DEFLATE format '${format}'.`);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new TypeError('An expected decompressed size must be a whole number of bytes.');
  }
  if (maxSize !== null && (!Number.isSafeInteger(maxSize) || maxSize < 0)) {
    throw new TypeError('A maximum decompressed size must be a whole number of bytes.');
  }
  if (into !== null && (expectedSize === null || into.length !== expectedSize)) {
    throw new TypeError('inflate fills `into` only with exactly the expected size.');
  }
  if (expectedSize !== null && (decoder ?? decoderFor('deflate', expectedSize, choices)) === 'fflate') {
    const whole = inflateWhole(input, format, expectedSize, label);
    if (into === null) return whole;
    into.set(whole);
    return into;
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
  const output = into ?? new Uint8Array(expectedSize);
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

/** zlib's Adler-32 of `bytes` (RFC 1950), in sums of at most 5552 bytes so neither overflows. */
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate a whole chunk of known decoded size with fflate, checked as the
 * native stream checks it: the decoded size exactly (the output holds one
 * byte more, so a stream running past its size shows), the zlib Adler-32,
 * the gzip CRC-32 and length.
 */
function inflateWhole(input, format, expectedSize, label) {
  const out = new Uint8Array(expectedSize + 1);
  let output;
  try {
    output = format === 'deflate' ? unzlibSync(input, { out })
      : format === 'gzip' ? gunzipSync(input, { out })
        : inflateSync(input, { out });
  } catch (cause) {
    throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause });
  }
  if (output.length > expectedSize) {
    throw new InflateError(`${label} decompresses to more than the ${formatCountOf(expectedSize, 'byte')} it declares.`);
  }
  if (output.length !== expectedSize) {
    throw new InflateError(`${label} decompresses to ${formatCountOf(output.length, 'byte')}, not the ${expectedSize} it declares.`);
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const intact = format === 'deflate' ? input.length >= 6 && view.getUint32(input.length - 4) === adler32(output)
    : format === 'gzip' ? input.length >= 18 && view.getUint32(input.length - 8, true) === crc32(output)
      && view.getUint32(input.length - 4, true) === (expectedSize >>> 0)
      : true;
  if (!intact) throw new InflateError(`${label} could not be decompressed; the data is corrupt (its checksum does not match).`);
  return output;
}
