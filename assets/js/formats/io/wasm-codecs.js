/**
 * The WebAssembly decoders: Zstandard, LZ4 and Blosc as their own libraries
 * decode them (zstd 1.5.6, lz4 1.10.0, c-blosc 1.21.6 with its blosclz and
 * bitshuffle), in one module, `assets/wasm/codecs.wasm`, built from the
 * pinned release tarballs by `scripts/build-wasm-codecs.mjs` (its licenses
 * in `assets/wasm/LICENSES/`).
 *
 * - **Loading**: on first need in each thread (a decode worker, the reader
 *   thread), compiled from its address in `assets/workers/scripts.js`, which
 *   names its bytes (`?v=`), so the service worker keeps it as it keeps every
 *   script. A `file:` address (Node, the tests) is read from disk. Compiling
 *   WebAssembly needs `'wasm-unsafe-eval'` in the page's script policy
 *   (index.html); nothing else is evaluated.
 * - **Bounded output**: each call is given the size its format declares and
 *   the decoder writes no byte past it; a chunk that decodes to more or less
 *   is refused (`WasmCodecError`, with the library's reason as `code`).
 * - **Memory**: one instance per thread, its memory grown to the largest
 *   chunk decoded so far (input, output and the decoder's own tables). An
 *   instance that grew past the memory a decode worker is budgeted
 *   (`DECODE_WORKER_BYTES`) is let go after its call (WebAssembly memory
 *   never shrinks) and the next call makes a new one from the compiled
 *   module.
 *
 * The decoded bytes are copied out into a new buffer of their own, which the
 * caller may transfer.
 *
 * Decoders besides Zarr's and hdf5plugin's Blosc, Zstandard and LZ4:
 * `bitshuffleChunk` (the HDF5 bitshuffle filter, 32008), `zstdStream` (a
 * Zstandard stream read piece by piece: R's zstd-compressed files),
 * `bloscZlib` (a Blosc frame of zlib streams, inflated by the page's DEFLATE
 * decoder), and `bitshuffleUntranspose` (bitshuffle's transpose alone).
 *
 * @module formats/io/wasm-codecs
 */

import { codecsWasm } from '../../../workers/scripts.js';
import { DECODE_WORKER_BYTES } from './decode-pool.js';
import { formatCountOf } from '../../utils/format-units.js';
import { byteUnshuffleInto } from './shuffle.js';

/** What a decoder of the module answered instead of a size. */
export class WasmCodecError extends Error {
  /**
   * @param {string} message
   * @param {string} code - The library's reason, in words
   */
  constructor(message, code) {
    super(message);
    this.name = 'WasmCodecError';
    this.code = code;
  }
}

/** The module's own codes (codecs.c). */
const CODES = new Map([[-1, 'out of memory'], [-2, 'corrupt data'], [-3, 'the wrong decoded size']]);

/** zstd's error codes (zstd_errors.h, `ZSTD_ErrorCode`), negated by codecs.c. */
const ZSTD_CODES = new Map([
  [1, 'a generic error'], [10, 'an unknown frame prefix'], [12, 'an unsupported version'],
  [14, 'an unsupported frame parameter'], [16, 'a window too large'], [20, 'corruption detected'],
  [22, 'a wrong checksum'], [24, 'a literals header that is wrong'], [30, 'a dictionary that is corrupt'],
  [32, 'a wrong dictionary'], [34, 'a dictionary creation failure'], [40, 'an unsupported parameter'],
  [42, 'a parameter out of bound'], [44, 'a table log too large'], [46, 'a max symbol value too large'],
  [48, 'a max symbol value too small'], [50, 'a stability condition not respected'], [60, 'a stage error'],
  [62, 'an init missing'], [64, 'a memory allocation failure'], [66, 'a workspace too small'],
  [70, 'a destination too small'], [72, 'a source too small'], [74, 'a destination buffer that is null'],
  [80, 'no forward progress on the destination'], [82, 'no forward progress on the input'],
]);

function codeOf(result, codes = CODES) {
  return codes.get(-result) ?? codes.get(result) ?? `code ${result}`;
}

/** @type {Promise<WebAssembly.Module>|null} */
let compiled = null;
/** @type {Codecs|null} */
let current = null;

/** Why this browser cannot decode Zstandard, LZ4 or Blosc here, in words a person can act on. */
function unavailable(cause) {
  return new Error(
    'This data is compressed with Zstandard, LZ4 or Blosc, which Cellucid decodes with WebAssembly, '
      + 'and this browser does not run WebAssembly here (Lockdown Mode, an enhanced security mode or a policy turns it off). '
      + 'Allow WebAssembly for this site, or open the data in another browser.',
    { cause }
  );
}

async function compile() {
  if (typeof globalThis.WebAssembly?.compile !== 'function') throw unavailable(null);
  try {
    return await load();
  } catch (error) {
    // A module that fetched but would not compile: WebAssembly is refused here.
    if (error?.name === 'CompileError' || error?.name === 'EvalError' || error?.name === 'SecurityError') throw unavailable(error);
    throw error;
  }
}

async function load() {
  const url = codecsWasm();
  if (url.protocol === 'file:') {
    // Node (tests, measuring scripts): the module beside the sources.
    const { readFileSync } = globalThis.process.getBuiltinModule('node:fs');
    const { fileURLToPath } = globalThis.process.getBuiltinModule('node:url');
    return WebAssembly.compile(readFileSync(fileURLToPath(url)));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The decoders (${url.pathname}) could not be loaded: the server answered ${response.status}.`);
  return WebAssembly.compileStreaming(response);
}

/**
 * The decoders, compiled once per thread.
 *
 * @returns {Promise<Codecs>}
 */
export async function wasmCodecs() {
  if (current !== null) return current;
  compiled ??= compile().catch(error => {
    // A failed load (offline, a refused policy) is tried again on next need.
    compiled = null;
    throw error;
  });
  const module = await compiled;
  current ??= new Codecs(module);
  return current;
}

/**
 * A Zstandard stream decoded piece by piece, in an instance of the module of
 * its own (its window lives as long as the stream): `push(bytes)` yields
 * the decoded pieces those bytes complete (at most `ZSTD_DStreamOutSize`,
 * 128 KiB, each), `end()` refuses a stream that stops inside a frame. For a stream too long to hold whole (R's
 * `saveRDS(compress = "zstd")`).
 *
 * @returns {Promise<{push: (bytes: Uint8Array) => Iterable<Uint8Array>, end: () => void}>}
 */
export async function zstdStream() {
  const { module } = await wasmCodecs();
  const { exports } = new WebAssembly.Instance(module, {});
  const begun = exports.codecs_zstd_stream_begin();
  if (begun < 0) throw new WasmCodecError('A Zstandard stream could not be started.', codeOf(begun));
  const input = exports.codecs_zstd_stream_input();
  const inputSize = exports.codecs_zstd_stream_input_size();
  const output = exports.codecs_zstd_stream_output();
  const outputSize = exports.codecs_zstd_stream_output_size();
  let pushed = false;
  return {
    *push(bytes) {
      for (let at = 0; at < bytes.length; at += inputSize) {
        const length = Math.min(inputSize, bytes.length - at);
        new Uint8Array(exports.memory.buffer).set(bytes.subarray(at, at + length), input);
        pushed = true;
        let from = 0;
        for (;;) {
          const produced = exports.codecs_zstd_stream_step(from, length);
          if (produced < 0) throw new WasmCodecError(`A Zstandard stream could not be decoded: ${codeOf(produced, ZSTD_CODES)}.`, codeOf(produced, ZSTD_CODES));
          if (produced > 0) yield new Uint8Array(exports.memory.buffer).slice(output, output + produced);
          from = exports.codecs_zstd_stream_consumed();
          // Input left, or an output buffer filled (more may be waiting): step again.
          if (from >= length && produced < outputSize) break;
        }
      }
    },
    end() {
      if (pushed && exports.codecs_zstd_stream_ended() !== 1) {
        throw new WasmCodecError('A Zstandard stream ends inside a frame: it is truncated.', 'a source too small');
      }
    },
  };
}

class Codecs {
  /** @param {WebAssembly.Module} module */
  constructor(module) {
    this.module = module;
    this.exports = new WebAssembly.Instance(module, {}).exports;
  }

  /** The bytes of the module's memory (a fresh view: memory growth detaches the old one). */
  get memory() {
    return new Uint8Array(this.exports.memory.buffer);
  }

  /**
   * Run one call over `input` copied into the module and an output region of
   * `outputSize` bytes: `decode(inputAddress, outputAddress)` returns the
   * bytes written, or a negative code. Returns the output, copied out.
   */
  call(input, outputSize, decode) {
    const at = this.exports.codecs_buffers(input.length, outputSize);
    if (at === 0) throw new WasmCodecError(`${formatCountOf(input.length + outputSize, 'byte')} do not fit in this thread's memory.`, 'out of memory');
    const out = this.exports.codecs_output();
    this.memory.set(input, at);
    const written = decode(at, out);
    const output = written > 0 ? this.memory.slice(out, out + written) : new Uint8Array(0);
    if (this.exports.memory.buffer.byteLength > DECODE_WORKER_BYTES && current === this) current = null;
    return { written, output };
  }

  /**
   * Every Zstandard frame of `input` (skippable frames skipped): into
   * exactly `expectedSize` bytes when it is known; else into the size the
   * frames state (no more than `bound`); else, when a frame states none,
   * into no more than `bound` bytes.
   *
   * @param {Uint8Array} input
   * @param {number|null} expectedSize
   * @param {number|null} [bound]
   * @returns {Uint8Array}
   */
  zstd(input, expectedSize, bound = null) {
    if (expectedSize !== null) return this.zstdInto(input, expectedSize);
    const stated = this.statedZstdSize(input);
    if (stated === -2) throw new WasmCodecError('It is not Zstandard frames.', ZSTD_CODES.get(10));
    if (stated >= 0) {
      if (bound !== null && stated > bound) throw new WasmCodecError(`Its frames state ${formatCountOf(stated, 'byte')}, more than the ${bound} it may hold.`, ZSTD_CODES.get(70));
      return this.zstdInto(input, stated);
    }
    return this.zstdGrowing(input, bound);
  }

  /** Frames that must decode to exactly `size` bytes. */
  zstdInto(input, size) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_zstd(at, input.length, out, size));
    if (written < 0) throw new WasmCodecError(`It could not be decoded: ${codeOf(written, ZSTD_CODES)}.`, codeOf(written, ZSTD_CODES));
    if (written !== size) throw new WasmCodecError(`It decodes to ${formatCountOf(written, 'byte')}, not the ${size} expected.`, 'the wrong decoded size');
    return output;
  }

  /** The decoded size `input`'s frames state (-1 when one does not, -2 when it is not frames). */
  statedZstdSize(input) {
    const at = this.exports.codecs_buffers(input.length, 0);
    if (at === 0) throw new WasmCodecError(`${formatCountOf(input.length, 'byte')} do not fit in this thread's memory.`, 'out of memory');
    this.memory.set(input, at);
    return this.exports.codecs_zstd_content_size(at, input.length);
  }

  /**
   * Frames that state no size: decoded into a buffer doubled until they fit,
   * from four times their size, up to `bound` (a block decodes to at most
   * 128 KiB, so without a bound this still ends).
   */
  zstdGrowing(input, bound) {
    let capacity = Math.max(4 * input.length, 64 * 1024);
    if (bound !== null) capacity = Math.min(capacity, bound);
    for (;;) {
      const size = capacity;
      const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_zstd(at, input.length, out, size));
      if (written >= 0) return output;
      if (-written !== 70) throw new WasmCodecError(`It could not be decoded: ${codeOf(written, ZSTD_CODES)}.`, codeOf(written, ZSTD_CODES));
      if (bound !== null && capacity >= bound) throw new WasmCodecError(`It decodes to more than the ${formatCountOf(bound, 'byte')} it may hold.`, ZSTD_CODES.get(70));
      capacity = bound === null ? capacity * 2 : Math.min(capacity * 2, bound);
    }
  }

  /**
   * One LZ4 block, which must decode to exactly `size` bytes.
   *
   * @param {Uint8Array} input
   * @param {number} size
   * @returns {Uint8Array}
   */
  lz4Block(input, size) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_lz4_block(at, input.length, out, size));
    if (written < 0 && size > 0) throw new WasmCodecError(`An LZ4 block could not be decoded: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }

  /**
   * Blocks of one buffer into one output of `total` bytes: each segment
   * `{at, stored, start, size}` is `input[at, at + stored)`, an LZ4 block
   * that must fill `output[start, start + size)`, or those bytes as they are
   * when `stored === size`. Segments are checked against both buffers.
   *
   * @param {Uint8Array} input
   * @param {Array<{at: number, stored: number, start: number, size: number}>} segments
   * @param {number} total
   * @returns {Uint8Array}
   */
  lz4Blocks(input, segments, total) {
    let failed = null;
    const { output } = this.call(input, total, (inputAt, outputAt) => {
      const memory = this.memory;
      for (const { at, stored, start, size } of segments) {
        if (at < 0 || stored < 0 || at + stored > input.length || start < 0 || size < 0 || start + size > total) {
          failed = 'a block lies outside its buffers';
          return -2;
        }
        if (stored === size) {
          memory.copyWithin(outputAt + start, inputAt + at, inputAt + at + stored);
          continue;
        }
        const written = this.exports.codecs_lz4_block(inputAt + at, stored, outputAt + start, size);
        if (written < 0) {
          failed = codeOf(written);
          return written;
        }
      }
      return total;
    });
    if (failed !== null) throw new WasmCodecError(`An LZ4 block could not be decoded: ${failed}.`, failed);
    return total === 0 ? new Uint8Array(0) : output;
  }

  /**
   * One Blosc 1 frame, which must decode to exactly `size` bytes (what its
   * header declares).
   *
   * @param {Uint8Array} input
   * @param {number} size
   * @returns {Uint8Array}
   */
  blosc(input, size) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_blosc(at, input.length, out, size));
    if (written < 0 || (written === 0 && size > 0)) throw new WasmCodecError(`It could not be decoded: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }

  /**
   * One Blosc 1 frame whose streams are zlib-compressed. c-blosc reads the
   * frame (its header, block table and stream lengths checked as for any
   * frame), places its stored streams and names each zlib stream with where
   * its bytes go; `inflateStream(bytes, into)` inflates each into its place
   * (with the page's DEFLATE decoder, all at once); then the blocks are
   * un-shuffled as c-blosc does (a byte shuffle here, `byteUnshuffleInto`;
   * a bit shuffle or a delta by c-blosc's code, `codecs_blosc_unshuffle`).
   *
   * @param {Uint8Array} input
   * @param {number} size - What its header declares
   * @param {(bytes: Uint8Array, into: Uint8Array) => Promise<Uint8Array>} inflateStream
   * @returns {Promise<Uint8Array>}
   */
  async bloscZlib(input, size, inflateStream) {
    const fail = result => new WasmCodecError(`It could not be decoded: ${codeOf(result)}.`, codeOf(result));
    const at = this.exports.codecs_buffers(input.length, size);
    if (at === 0) throw new WasmCodecError(`${formatCountOf(input.length + size, 'byte')} do not fit in this thread's memory.`, 'out of memory');
    this.memory.set(input, at);
    const out = this.exports.codecs_output();
    const count = this.exports.codecs_blosc_zlib_record(at, input.length, out, size);
    if (count < 0) throw fail(count);
    const table = new Uint32Array(this.exports.memory.buffer, this.exports.codecs_blosc_zlib_streams(), 4 * count).slice();
    let inflated = 0;
    for (let i = 0; i < count; i++) inflated += table[4 * i + 3];
    // Bytes no stream inflates are stored streams, which c-blosc placed: taken from it, else none to take.
    const blocks = inflated < size ? this.memory.slice(out, out + size) : new Uint8Array(size);
    const streams = [];
    for (let i = 0; i < count; i++) {
      const [offset, length, place, bytes] = table.subarray(4 * i, 4 * i + 4);
      if (offset + length > input.length || place + bytes > size) throw fail(-2);
      streams.push(inflateStream(input.subarray(offset, offset + length), blocks.subarray(place, place + bytes)));
    }
    await Promise.all(streams);
    const flags = input[2];
    const typesize = input[3];
    const blocksize = new DataView(input.buffer, input.byteOffset, 16).getUint32(8, true);
    const shuffled = (flags & 0x01) !== 0 && typesize > 1;
    if ((flags & 0x08) === 0 && (shuffled || (flags & 0x04) === 0)) {
      if (!shuffled) return blocks;
      const output = new Uint8Array(size);
      for (let start = 0; start < size; start += blocksize) {
        const block = Math.min(blocksize, size - start);
        byteUnshuffleInto(blocks.subarray(start, start + block), output, start, block, typesize);
      }
      return output;
    }
    // A bit shuffle or a delta: c-blosc's code, in one call (this instance is used by nothing else meanwhile).
    const again = this.exports.codecs_buffers(16 + size, size);
    if (again === 0) throw new WasmCodecError(`${formatCountOf(16 + 2 * size, 'byte')} do not fit in this thread's memory.`, 'out of memory');
    const memory = this.memory;
    memory.set(input.subarray(0, 16), again);
    memory.set(blocks, again + 16);
    const target = this.exports.codecs_output();
    const written = this.exports.codecs_blosc_unshuffle(again, again + 16, target, size);
    if (written < 0) throw fail(written);
    const output = this.memory.slice(target, target + size);
    if (this.exports.memory.buffer.byteLength > DECODE_WORKER_BYTES && current === this) current = null;
    return output;
  }

  /**
   * One chunk through the HDF5 bitshuffle filter (32008), undone: `size`
   * bytes of elements of `elemSize` bytes, from bit-transposed blocks of
   * `blockElems` elements (0: bitshuffle's default) stored as they are
   * (`compression` 0) or each compressed with LZ4 (2) or zstd (3), the
   * filter's parameters (`codecs.c` `codecs_bitshuffle_chunk`).
   *
   * @param {Uint8Array} input
   * @param {number} size
   * @param {number} elemSize
   * @param {number} blockElems
   * @param {number} compression
   * @returns {Uint8Array}
   */
  bitshuffleChunk(input, size, elemSize, blockElems, compression) {
    const { written, output } = this.call(input, size, (at, out) => (
      this.exports.codecs_bitshuffle_chunk(at, input.length, out, size, elemSize, blockElems, compression)
    ));
    if (written < 0) throw new WasmCodecError(`It could not be decoded: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }

  /**
   * Bitshuffle's inverse bit transpose of `count` elements of `typesize`
   * bytes (`count` a multiple of 8): `input.length` must be
   * `count * typesize`.
   *
   * @param {Uint8Array} input
   * @param {number} count
   * @param {number} typesize
   * @returns {Uint8Array}
   */
  bitshuffleUntranspose(input, count, typesize) {
    const size = count * typesize;
    if (input.length !== size) throw new WasmCodecError(`${formatCountOf(input.length, 'byte')} are not ${formatCountOf(count, 'element')} of ${formatCountOf(typesize, 'byte')}.`, 'the wrong decoded size');
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_bitshuffle_untranspose(at, out, count, typesize));
    if (written < 0) throw new WasmCodecError(`It could not be un-transposed: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }
}
