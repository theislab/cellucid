/**
 * Chunks: decoding one, and copying the part of it a read selected.
 *
 * A decoded chunk (`Decoded`) holds its elements in the order they were
 * stored, in a form ready to copy:
 *
 * - numbers and booleans: a typed array of the value type, in host byte order
 *   (float16 widened to float32);
 * - fixed-width strings, opaque and compound elements: the raw element bytes
 *   (decoded later, for the selected elements only);
 * - variable-length strings: an Array of strings.
 *
 * Copying walks the selected region of the chunk and the matching region of
 * the output with each one's strides, so a chunk stored in another axis order
 * (Fortran order, a transpose codec) is copied without first being
 * rearranged. Axes both sides lay out as one are walked as one (`mergeAxes`),
 * so whole rows of a chunk (an embedding chunked by rows) are one block move,
 * not one per row.
 *
 * @module formats/zarr/chunks
 */

import { ZarrFormatError } from './errors.js';
import { float16Values } from './dtypes.js';
import { codecsOf, decodesOffThread, expectedSizes, reviveZarrError } from './codecs/pipeline.js';
import { decodeChunkBytes } from '../io/decode-pool.js';
import { vlenDecode } from './codecs/vlen.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * @typedef {Object} Decoded
 * @property {ArrayLike<unknown>} data - Elements in storage order
 * @property {boolean} owned - Whether `data` has its own buffer (not a view of fetched bytes)
 * @property {number} bytes - Memory it holds, for the cache budget
 */

function swap16(words) {
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    words[i] = ((v & 0xff) << 8) | (v >>> 8);
  }
}

function swap32(words) {
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    words[i] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
  }
}

function swap64(words) {
  for (let i = 0; i < words.length; i += 2) {
    const a = words[i];
    const b = words[i + 1];
    words[i] = ((b & 0xff) << 24) | ((b & 0xff00) << 8) | ((b >>> 8) & 0xff00) | (b >>> 24);
    words[i + 1] = ((a & 0xff) << 24) | ((a & 0xff00) << 8) | ((a >>> 8) & 0xff00) | (a >>> 24);
  }
}

/** Elements of `bytes` as a typed array, copying only when the bytes are misaligned or must change. */
function numericValues(bytes, owned, type, count) {
  const size = type.itemSize;
  const Values = type.valueClass;
  const swap = !type.littleEndian && size > 1;
  let buffer = bytes;
  let own = owned;
  if (bytes.byteOffset % size !== 0 || (swap && !owned)) {
    buffer = bytes.slice();
    own = true;
  }
  if (swap) {
    if (size === 2) swap16(new Uint16Array(buffer.buffer, buffer.byteOffset, count));
    else if (size === 4) swap32(new Uint32Array(buffer.buffer, buffer.byteOffset, count));
    else swap64(new Uint32Array(buffer.buffer, buffer.byteOffset, count * 2));
  }
  return { data: new Values(buffer.buffer, buffer.byteOffset, count), owned: own };
}

function float16Values32(bytes, type, count) {
  const table = float16Values();
  const out = new Float32Array(count);
  if (type.littleEndian) {
    for (let i = 0, at = 0; i < count; i++, at += 2) out[i] = table[bytes[at] | (bytes[at + 1] << 8)];
  } else {
    for (let i = 0, at = 0; i < count; i++, at += 2) out[i] = table[(bytes[at] << 8) | bytes[at + 1]];
  }
  return out;
}

/** Run a pipeline's decoders over `stored` in this thread. */
async function runDecoders(stored, decoders, sizes) {
  let bytes = stored;
  for (let i = 0; i < decoders.length; i++) bytes = await decoders[i].decode(bytes, sizes[i]);
  return bytes;
}

/**
 * Decode one stored chunk. Its codecs run on a decode worker when they
 * decompress or rearrange bytes (`io/decode-pool.js`), otherwise here.
 *
 * @param {Uint8Array} stored - The chunk's stored bytes (may be a view of a shared buffer)
 * @param {import('./codecs/pipeline.js').Pipeline} pipeline
 * @param {number} count - Elements in the chunk
 * @param {string} what - The array, for messages
 * @param {AbortSignal|null} [signal] - Stops waiting for the decode
 * @returns {Promise<Decoded>}
 */
export async function decodeChunk(stored, pipeline, count, what, signal = null) {
  const type = pipeline.type;
  const decodedSize = pipeline.serializer.kind === 'vlen' ? null : count * type.itemSize;
  const decoders = pipeline.decoders;
  const sizes = expectedSizes(decoders, decodedSize);
  let bytes;
  // Some decoder allocates its output, so the bytes are this chunk's own
  // wherever they were decoded; otherwise they are a view of `stored`.
  const owned = decodesOffThread(pipeline);
  if (owned) {
    bytes = await decodeChunkBytes({
      kind: 'zarr',
      description: { codecs: codecsOf(pipeline), sizes },
      input: stored,
      size: decodedSize ?? stored.length,
      signal,
      revive: reviveZarrError,
      inThread: () => runDecoders(stored, decoders, sizes),
    });
  } else {
    bytes = await runDecoders(stored, decoders, sizes);
  }
  if (pipeline.serializer.kind === 'vlen') {
    const data = vlenDecode(bytes, count, what);
    return { data, owned: true, bytes: bytes.length + 16 * count };
  }
  if (bytes.length !== decodedSize) {
    throw new ZarrFormatError(`${what}: a chunk decodes to ${formatCountOf(bytes.length, 'byte')}, not the ${decodedSize} its shape and type declare.`);
  }
  switch (type.form) {
    case 'numeric': {
      const { data, owned: own } = numericValues(bytes, owned, type, count);
      return { data, owned: own, bytes: data.byteLength };
    }
    case 'float16': {
      const data = float16Values32(bytes, type, count);
      return { data, owned: true, bytes: data.byteLength };
    }
    case 'bool':
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] > 1) throw new ZarrFormatError(`${what} holds a boolean byte that is neither 0 nor 1 (${bytes[i]}).`);
      }
      return { data: bytes, owned, bytes: bytes.length };
    default:
      return { data: bytes, owned, bytes: bytes.length };
  }
}

/** A copy of decoded data that owns its buffer. */
export function ownedCopy(decoded) {
  if (decoded.owned) return decoded;
  return { data: decoded.data.slice(), owned: true, bytes: decoded.bytes };
}

/**
 * The array a copy loop moves elements through: typed arrays are viewed as
 * unsigned words (bit-exact, and BigInt elements become pairs of 32-bit
 * words), `width` words per element; plain Arrays move one item per element.
 */
export function wordsOf(data, elementBytes) {
  if (Array.isArray(data)) return { words: data, width: 1 };
  const bytes = data.BYTES_PER_ELEMENT === 1 && elementBytes !== undefined ? elementBytes : data.BYTES_PER_ELEMENT;
  const offset = data.byteOffset;
  const length = data.byteLength;
  if (bytes % 4 === 0 && offset % 4 === 0) return { words: new Uint32Array(data.buffer, offset, length / 4), width: bytes / 4 };
  if (bytes % 2 === 0 && offset % 2 === 0) return { words: new Uint16Array(data.buffer, offset, length / 2), width: bytes / 2 };
  return { words: new Uint8Array(data.buffer, offset, length), width: bytes };
}

/** Row-major strides of `shape`, in elements. */
export function cStrides(shape) {
  const strides = new Array(shape.length);
  let stride = 1;
  for (let axis = shape.length - 1; axis >= 0; axis--) {
    strides[axis] = stride;
    stride *= shape[axis];
  }
  return strides;
}

/**
 * Strides, per array axis, of a chunk stored with `permutation` (storage
 * axis k is array axis `permutation[k]`), or C order when null.
 */
export function storageStrides(chunkShape, permutation) {
  if (permutation === null) return cStrides(chunkShape);
  const storedShape = permutation.map(axis => chunkShape[axis]);
  const stored = cStrides(storedShape);
  const strides = new Array(chunkShape.length);
  permutation.forEach((axis, k) => {
    strides[axis] = stored[k];
  });
  return strides;
}

/** Shortest run worth a block move instead of an element loop. */
const BLOCK_MOVE_WORDS = 24;

/**
 * A box as few axes as walk it: axes of extent 1 dropped, and each axis
 * merged into the one before it wherever both sides lay the two out as one
 * (the outer stride is the inner stride times the inner extent), so a box of
 * whole rows is one run, and one column of a row-major chunk is one strided
 * run, not a run of one element per row.
 *
 * @param {number[][]} stridesList - Strides per axis of each side
 * @param {number[]} extents
 * @returns {{strides: number[][], extents: number[]}}
 */
export function mergeAxes(stridesList, extents) {
  const strides = stridesList.map(() => []);
  const merged = [];
  for (let axis = 0; axis < extents.length; axis++) {
    const extent = extents[axis];
    if (extent === 1) continue;
    const k = merged.length - 1;
    if (k >= 0 && stridesList.every((side, i) => strides[i][k] === side[axis] * extent)) {
      merged[k] *= extent;
      stridesList.forEach((side, i) => {
        strides[i][k] = side[axis];
      });
    } else {
      merged.push(extent);
      stridesList.forEach((side, i) => strides[i].push(side[axis]));
    }
  }
  return { strides, extents: merged };
}

/**
 * Copy a box of elements from `src` to `dst`.
 *
 * @param {ArrayLike<unknown>} src - Words (see `wordsOf`)
 * @param {number} srcStart - First element, in elements
 * @param {number[]} srcStrides
 * @param {ArrayLike<unknown>} dst
 * @param {number} dstStart
 * @param {number[]} dstStrides
 * @param {number[]} boxExtents - Box size per axis
 * @param {number} width - Words per element
 */
export function copyBox(src, srcStart, srcStrides, dst, dstStart, dstStrides, boxExtents, width) {
  const { strides: [srcSteps, dstSteps], extents } = mergeAxes([srcStrides, dstStrides], boxExtents);
  const rank = extents.length;
  if (rank === 0) {
    for (let w = 0; w < width; w++) dst[dstStart * width + w] = src[srcStart * width + w];
    return;
  }
  const last = rank - 1;
  const run = extents[last];
  const srcStep = srcSteps[last];
  const dstStep = dstSteps[last];
  const contiguous = srcStep === 1 && dstStep === 1;
  const runWords = run * width;
  const typed = !Array.isArray(dst);
  const index = new Array(last).fill(0);
  let s = srcStart;
  let d = dstStart;
  for (;;) {
    if (contiguous) {
      const from = s * width;
      const to = d * width;
      if (typed && runWords >= BLOCK_MOVE_WORDS) {
        dst.set(src.subarray(from, from + runWords), to);
      } else {
        for (let k = 0; k < runWords; k++) dst[to + k] = src[from + k];
      }
    } else if (width === 1) {
      for (let k = 0, a = s, b = d; k < run; k++, a += srcStep, b += dstStep) dst[b] = src[a];
    } else {
      for (let k = 0, a = s * width, b = d * width; k < run; k++, a += srcStep * width, b += dstStep * width) {
        for (let w = 0; w < width; w++) dst[b + w] = src[a + w];
      }
    }
    // Advance the outer axes (odometer).
    let axis = last - 1;
    while (axis >= 0) {
      index[axis]++;
      s += srcSteps[axis];
      d += dstSteps[axis];
      if (index[axis] < extents[axis]) break;
      s -= srcSteps[axis] * extents[axis];
      d -= dstSteps[axis] * extents[axis];
      index[axis] = 0;
      axis--;
    }
    if (axis < 0) return;
  }
}

/**
 * Fill a box of `dst` (C order) with one element: `value` for typed arrays
 * of values and Arrays, or the raw element bytes `pattern` for raw output.
 */
export function fillBox(dst, dstStart, dstStrides, boxExtents, value, pattern) {
  const { strides: [dstSteps], extents } = mergeAxes([dstStrides], boxExtents);
  const rank = extents.length;
  const last = rank - 1;
  const run = rank === 0 ? 1 : extents[last];
  const step = rank === 0 ? 1 : dstSteps[last];
  const index = new Array(Math.max(0, last)).fill(0);
  let d = dstStart;
  for (;;) {
    if (pattern !== null) {
      const size = pattern.length;
      for (let k = 0; k < run; k++) dst.set(pattern, (d + k * step) * size);
    } else if (step === 1) {
      dst.fill(value, d, d + run);
    } else {
      for (let k = 0, at = d; k < run; k++, at += step) dst[at] = value;
    }
    let axis = last - 1;
    while (axis >= 0) {
      index[axis]++;
      d += dstSteps[axis];
      if (index[axis] < extents[axis]) break;
      d -= dstSteps[axis] * extents[axis];
      index[axis] = 0;
      axis--;
    }
    if (axis < 0) return;
  }
}
