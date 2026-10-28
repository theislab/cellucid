/**
 * Typed arrays larger than one `ArrayBuffer`, and how a typed array of any
 * size crosses between threads in pieces.
 *
 * Every engine caps one `ArrayBuffer` (measured 2026-10-28, Playwright builds
 * on macOS arm64): Chromium at 2,145,386,496 bytes (earlier builds
 * 2,080,374,783), WebKit at 2^32, Firefox at 2^34. A 3-D position array (12
 * bytes a cell) therefore stops at 178.8M cells on Chromium. A
 * `WebAssembly.Memory` holds up to 2^32 bytes (65,536 pages of 64 KiB) on all
 * three, and an ordinary typed array views it whole: reads, writes, `set`,
 * `subarray` and `slice` behave as on any buffer (measured on each engine at
 * 2^31, 2.6, 3 and 4 GiB). So `allocateLargeArray` gives an `ArrayBuffer`
 * when the engine allocates one and a memory's buffer when it refuses, and
 * every consumer sees the same kind of typed array either way.
 *
 * A memory is used only where an `ArrayBuffer` is refused: Chromium keeps
 * about 120 memories alive in one page (each reserves address space far
 * beyond its size; the 121st is refused), while arrays above the cap are each
 * gigabytes, so only a few can ever exist.
 *
 * A memory's buffer cannot be detached: it never moves by transfer (engines
 * throw), and cloning a typed array copies its whole buffer. Such an array
 * crosses threads in pieces (`arrayPieces`, `ArrayAssembly`) of at most
 * `ARRAY_PIECE_BYTES`, each in its own buffer and transferred, assembled at
 * the other end by `allocateLargeArray`. Two rules follow for every holder of
 * a per-cell array: never put its buffer in a transfer list unless
 * `canTransfer` says so, and never post it whole.
 *
 * @module utils/large-arrays
 */

import { formatCountOf } from './format-units.js';

/** Bytes of one WebAssembly page. */
const MEMORY_PAGE_BYTES = 65536;

/** The most a 32-bit WebAssembly memory holds: 65,536 pages (every engine refuses one page more). */
export const MEMORY_MAX_BYTES = 2 ** 32;

/**
 * The most one piece of an array holds: 2^24 three-dimensional positions
 * (192 MiB), the point store's segment (`point-store-segments.js`), so a
 * piece of positions is a whole number of cells at every dimension and one
 * piece copies in tens of milliseconds.
 */
export const ARRAY_PIECE_BYTES = 2 ** 24 * 3 * 4;

/** The typed array constructors a piece names, by name. */
const TYPED_ARRAYS = Object.freeze({
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
});

/** Buffers that belong to a WebAssembly memory this thread made. */
const memoryBuffers = new WeakSet();

/**
 * One typed array of `length` elements in a WebAssembly memory (no larger
 * than it needs, never grown, so its buffer stays attached).
 *
 * @template T
 * @param {new (buffer: ArrayBuffer, byteOffset: number, length: number) => T} ArrayType
 * @param {number} length
 * @returns {T}
 */
export function allocateInMemory(ArrayType, length) {
  const bytes = length * ArrayType.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`A typed array holds a non-negative whole number of elements, not ${length}.`);
  }
  if (bytes > MEMORY_MAX_BYTES) {
    throw new RangeError(
      `${formatCountOf(bytes, 'byte')} is more than one WebAssembly memory holds (${formatCountOf(MEMORY_MAX_BYTES, 'byte')}), the largest array a browser page can allocate.`
    );
  }
  const pages = Math.ceil(bytes / MEMORY_PAGE_BYTES);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  memoryBuffers.add(memory.buffer);
  return new ArrayType(memory.buffer, 0, length);
}

/**
 * A zeroed typed array of `length` elements: an `ArrayBuffer` when the engine
 * allocates one, else a WebAssembly memory (`allocateInMemory`). Throws the
 * engine's `RangeError` when neither can be had.
 *
 * @template T
 * @param {new (length: number) => T} ArrayType
 * @param {number} length
 * @returns {T}
 */
export function allocateLargeArray(ArrayType, length) {
  try {
    return new ArrayType(length);
  } catch (refused) {
    if (!(refused instanceof RangeError) || typeof WebAssembly?.Memory !== 'function' ||
        !(length * ArrayType.BYTES_PER_ELEMENT <= MEMORY_MAX_BYTES)) throw refused;
    try {
      return allocateInMemory(ArrayType, length);
    } catch {
      throw refused;
    }
  }
}

/**
 * A copy of `view` of its own (`allocateLargeArray`): what `new
 * view.constructor(view)` makes, at any size the page can hold.
 *
 * @template {ArrayBufferView} T
 * @param {T} view
 * @returns {T}
 */
export function copyLargeArray(view) {
  const copy = allocateLargeArray(view.constructor, view.length);
  copy.set(view);
  return copy;
}

/** Whether `view` lies in a WebAssembly memory this thread made (`allocateInMemory`). */
export function isMemoryBacked(view) {
  return ArrayBuffer.isView(view) && memoryBuffers.has(view.buffer);
}

/**
 * Whether `view` can move to another thread by transferring its buffer: it
 * views the whole of an `ArrayBuffer` that is not a memory's. A view of part
 * of a buffer would move (or clone) the rest of it with it.
 */
export function canTransfer(view) {
  return ArrayBuffer.isView(view) &&
    view.buffer instanceof ArrayBuffer &&
    !memoryBuffers.has(view.buffer) &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength;
}

/**
 * Elements in one piece of an array of `ArrayType`: as many whole groups of
 * `width` (a cell's values) as `ARRAY_PIECE_BYTES` holds.
 *
 * @param {{BYTES_PER_ELEMENT: number}} ArrayType
 * @param {number} [width=1]
 * @returns {number}
 */
export function pieceElements(ArrayType, width = 1) {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError(`A piece holds whole groups of 1 or more elements, not ${width}.`);
  return Math.floor(ARRAY_PIECE_BYTES / ArrayType.BYTES_PER_ELEMENT / width) * width;
}

/**
 * The pieces of `view` in order, each a copy in its own buffer:
 * `{offset, values}`, `offset` in elements. An empty array has none.
 *
 * @param {ArrayBufferView} view
 * @param {number} [width=1] - Elements a piece keeps together (a cell's).
 * @returns {Generator<{offset: number, values: ArrayBufferView}>}
 */
export function* arrayPieces(view, width = 1) {
  const step = pieceElements(view.constructor, width);
  for (let offset = 0; offset < view.length; offset += step) {
    yield { offset, values: view.slice(offset, Math.min(view.length, offset + step)) };
  }
}

/** The constructor a piece message names. */
export function typedArrayOf(name) {
  const ArrayType = Object.hasOwn(TYPED_ARRAYS, name) ? TYPED_ARRAYS[name] : undefined;
  if (ArrayType === undefined) throw new TypeError(`'${String(name)}' is not a typed array a piece can hold.`);
  return ArrayType;
}

/**
 * One array put together from its pieces, in any order: the array is
 * allocated whole (`allocateLargeArray`) at the first piece and each piece is
 * copied in and let go, so the pieces never all wait at once. A piece that
 * is the whole array is taken as it is, not copied.
 */
export class ArrayAssembly {
  /**
   * @param {new (length: number) => ArrayBufferView} ArrayType
   * @param {number} length
   */
  constructor(ArrayType, length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`An assembled array holds a non-negative whole number of elements, not ${length}.`);
    }
    this.ArrayType = ArrayType;
    this.length = length;
    /** @type {ArrayBufferView|null} */
    this.array = null;
    this.filled = 0;
  }

  /**
   * Copy one piece in.
   *
   * @param {number} offset - Its first element in the whole array
   * @param {ArrayBufferView} values
   */
  put(offset, values) {
    if (!(values instanceof this.ArrayType)) {
      throw new TypeError(`A piece of a ${this.ArrayType.name} is one too, not ${values?.constructor?.name}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + values.length > this.length) {
      throw new RangeError(`A piece at ${offset} of ${formatCountOf(values.length, 'element')} lies outside an array of ${formatCountOf(this.length, 'element')}.`);
    }
    if (this.array === null && offset === 0 && values.length === this.length) {
      this.array = values;
    } else {
      this.array ??= allocateLargeArray(this.ArrayType, this.length);
      this.array.set(values, offset);
    }
    this.filled += values.length;
  }

  /** The whole array, once every element arrived. */
  get result() {
    if (this.filled !== this.length) {
      throw new RangeError(`An array of ${formatCountOf(this.length, 'element')} was assembled from ${formatCountOf(this.filled, 'element')}.`);
    }
    return this.array ?? new this.ArrayType(0);
  }
}

/**
 * What stands for an array sent in pieces inside a message (`placeArrays`),
 * replaced by the assembled array at the other end (`assembledArrays`).
 *
 * @param {number} index
 */
function placeholder(index) {
  return { arrayPieces: index };
}

/** `items` mapped by `map`, the same array when no item changed (copied only once one does). */
function mapChanged(items, map) {
  let out = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null || typeof item !== 'object') continue;
    const mapped = map(item);
    if (mapped !== item) {
      out ??= items.slice();
      out[i] = mapped;
    }
  }
  return out ?? items;
}

function isPlaceholder(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 && Number.isSafeInteger(value.arrayPieces);
}

/**
 * `value` with every array that cannot be transferred and may not be cloned
 * (a memory's, `isMemoryBacked`) replaced by a placeholder, each such array
 * handed to `send(index, view)` to cross in pieces before the message. The
 * walk covers what a reply carries: plain records and arrays of them, a few
 * levels deep. Records are copied with their property descriptors, so a
 * lazy getter is never run.
 *
 * @param {*} value
 * @param {(view: ArrayBufferView) => {arrayPieces: number}} send - Sends the
 *   array's pieces; returns its placeholder.
 * @returns {*}
 */
export function placeArrays(value, send, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (ArrayBuffer.isView(value)) return isMemoryBacked(value) ? send(value) : value;
  if (Array.isArray(value)) return mapChanged(value, item => placeArrays(item, send, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let copy = null;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!('value' in descriptor)) continue;
    const placed = placeArrays(descriptor.value, send, depth + 1);
    if (placed !== descriptor.value) {
      copy ??= Object.defineProperties({}, Object.getOwnPropertyDescriptors(value));
      Object.defineProperty(copy, key, { ...descriptor, value: placed });
    }
  }
  return copy ?? value;
}

/**
 * `value` with every placeholder (`placeArrays`, `PieceSender`) replaced by
 * its assembled array.
 *
 * @param {*} value
 * @param {Map<number, ArrayAssembly>} assemblies
 * @returns {*}
 */
export function assembledArrays(value, assemblies, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4 || ArrayBuffer.isView(value)) return value;
  if (isPlaceholder(value)) {
    const assembly = assemblies.get(value.arrayPieces);
    if (assembly === undefined) throw new RangeError(`The pieces of array ${value.arrayPieces} never arrived.`);
    // Each array is handed out once: the receiver lets go of it.
    assemblies.delete(value.arrayPieces);
    return assembly.result;
  }
  if (Array.isArray(value)) return mapChanged(value, item => assembledArrays(item, assemblies, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let copy = null;
  for (const key of Object.keys(value)) {
    const resolved = assembledArrays(value[key], assemblies, depth + 1);
    if (resolved !== value[key]) {
      copy ??= { ...value };
      copy[key] = resolved;
    }
  }
  return copy ?? value;
}

/**
 * Sends arrays in pieces for one message: each array gets an index, its
 * pieces go out as `post(piece)` messages `{array, type, length, offset,
 * values}` (values transferred), and its placeholder goes in the message.
 * An array can also be sent as it is made (`begin`): its pieces are posted
 * as they are put, so the whole array never exists on this side.
 */
export class PieceSender {
  /** @param {(piece: Object, transfer: ArrayBuffer[]) => void} post */
  constructor(post) {
    this._post = post;
    this._next = 0;
  }

  /**
   * Start an array of `length` elements of `ArrayType` sent as it is made:
   * `put(offset, values)` posts one piece (`values` is transferred, so the
   * caller lets it go); `result` is its placeholder.
   *
   * @param {new (length: number) => ArrayBufferView} ArrayType
   * @param {number} length
   * @returns {{put: (offset: number, values: ArrayBufferView) => void, result: {arrayPieces: number}}}
   */
  begin(ArrayType, length) {
    const array = this._next++;
    const type = ArrayType.name;
    typedArrayOf(type);
    return {
      put: (offset, values) => {
        if (!canTransfer(values)) throw new TypeError('A piece is a whole buffer of its own.');
        this._post({ array, type, length, offset, values }, [values.buffer]);
      },
      result: placeholder(array),
    };
  }

  /**
   * Send a whole array in pieces of at most `ARRAY_PIECE_BYTES`; its placeholder.
   *
   * @param {ArrayBufferView} view
   * @returns {{arrayPieces: number}}
   */
  send(view) {
    const sink = this.begin(view.constructor, view.length);
    for (const { offset, values } of arrayPieces(view)) sink.put(offset, values);
    // An empty array still sends one (empty) piece, so its placeholder resolves.
    if (view.length === 0) sink.put(0, new view.constructor(0));
    return sink.result;
  }
}

/**
 * Receives the pieces a `PieceSender` posted for one message.
 */
export class PieceReceiver {
  constructor() {
    /** @type {Map<number, ArrayAssembly>} */
    this.assemblies = new Map();
  }

  /** Take one piece message (`{array, type, length, offset, values}`). */
  receive({ array, type, length, offset, values }) {
    let assembly = this.assemblies.get(array);
    if (assembly === undefined) {
      assembly = new ArrayAssembly(typedArrayOf(type), length);
      this.assemblies.set(array, assembly);
    }
    assembly.put(offset, values);
  }

  /** `value` with its placeholders replaced by the assembled arrays, which the receiver then lets go of. */
  resolve(value) {
    return assembledArrays(value, this.assemblies);
  }
}
