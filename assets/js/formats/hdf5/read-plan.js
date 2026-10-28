/**
 * Reading a selection of a dataset's elements: which bytes to fetch, and
 * where each fetched byte goes.
 *
 * The result is the selection's element bytes in row-major order, in one
 * buffer allocated once; every source writes straight into it.
 *
 * - **Compact** data is in the object header already: copied out.
 * - **Contiguous** data is read as the runs of bytes the selection covers
 *   (a block of rows is one run; a column of a row-major matrix is one run
 *   per row). Runs closer than the link's merge gap are fetched as one
 *   request (never longer than its maximum request), so a column becomes a
 *   handful of large reads, and each request's bytes are copied out and
 *   dropped as it arrives.
 * - **Chunked** data: the chunk index (read once, on the first read) gives
 *   the chunks the selection intersects. Chunks already decoded come from the
 *   file's decoded-chunk cache; the rest are fetched at once (the byte reader
 *   merges neighbours), decoded as they arrive, and their intersecting part
 *   copied into place. Fetching stays within a memory budget, so reading a
 *   column through thousands of large chunks never holds them all at once.
 *   Concurrent reads needing the same chunk share one fetch and decode.
 *   An unfiltered chunk (anndata's default `.h5ad` stores sparse matrices
 *   so) whose part in the selection is one run of its bytes is not fetched
 *   whole: only that run is, as from contiguous data (a cell's row of a CSR
 *   matrix, a gene's entries of a CSC one), and the byte reader decides
 *   which neighbouring runs are worth one request.
 *
 * Elements never written read as the fill value.
 *
 * @module formats/hdf5/read-plan
 */

import { loadChunkTable } from './chunk-index.js';
import { unfilter, unsupportedFilters, filterName, reviveHdf5Error } from './filters.js';
import { decodeChunkBytes } from '../io/decode-pool.js';
import { SharedWork, onAbort } from '../io/abort.js';
import { Hdf5FormatError, Hdf5UnsupportedError, throwIfAborted } from './errors.js';
import { selectionSize } from '../store.js';
import { CHUNK_GROUP_BYTES } from './context.js';
import { formatCountOf } from '../../utils/format-units.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';

const MiB = 1024 * 1024;

/**
 * Stored bytes of neighbouring chunks decoded as one group: a group's fetched
 * bytes stay alive until all its chunks are decoded, so groups stay small.
 * (The byte reader still merges neighbouring groups into larger requests.)
 * Chunks are grouped within the link's merge gap, as measured.
 */
const GROUP_BYTES = shaping => Math.min(shaping.maxRequestBytes, CHUNK_GROUP_BYTES);

/** Row-major strides (in elements) of `shape`. */
function stridesOf(shape) {
  const strides = new Array(shape.length);
  let stride = 1;
  for (let d = shape.length - 1; d >= 0; d--) {
    strides[d] = stride;
    stride *= shape[d];
  }
  return strides;
}

/**
 * Copy the part of a block (`source`, of `blockShape` elements starting at
 * global coordinates `blockStart`) inside the selection into `target` (the
 * selection's row-major bytes).
 */
export function copyIntersection(source, blockStart, blockShape, target, selection, elementSize) {
  const rank = blockShape.length;
  if (rank === 0) {
    target.set(source.subarray(0, elementSize), 0);
    return;
  }
  if (rank === 1) {
    const lo = Math.max(blockStart[0], selection[0][0]);
    const hi = Math.min(blockStart[0] + blockShape[0], selection[0][1]);
    if (hi <= lo) return;
    const from = (lo - blockStart[0]) * elementSize;
    const bytes = (hi - lo) * elementSize;
    const to = (lo - selection[0][0]) * elementSize;
    if (bytes >= 64) target.set(source.subarray(from, from + bytes), to);
    else for (let b = 0; b < bytes; b++) target[to + b] = source[from + b];
    return;
  }
  const lo = new Array(rank);
  const hi = new Array(rank);
  for (let d = 0; d < rank; d++) {
    lo[d] = Math.max(blockStart[d], selection[d][0]);
    hi[d] = Math.min(blockStart[d] + blockShape[d], selection[d][1]);
    if (hi[d] <= lo[d]) return;
  }
  const selectionShape = selection.map(([start, stop]) => stop - start);
  const sourceStrides = stridesOf(blockShape);
  const targetStrides = stridesOf(selectionShape);
  // Trailing dimensions covered whole by both the block and the selection
  // join the innermost run.
  let inner = rank - 1;
  while (inner > 0 &&
    lo[inner] === blockStart[inner] && hi[inner] === blockStart[inner] + blockShape[inner] &&
    lo[inner] === selection[inner][0] && hi[inner] === selection[inner][1]) {
    inner--;
  }
  const runElements = (hi[inner] - lo[inner]) * sourceStrides[inner];
  const runBytes = runElements * elementSize;
  let sourceOffset = 0;
  let targetOffset = 0;
  for (let d = 0; d <= inner; d++) {
    sourceOffset += (lo[d] - blockStart[d]) * sourceStrides[d];
    targetOffset += (lo[d] - selection[d][0]) * targetStrides[d];
  }
  sourceOffset *= elementSize;
  targetOffset *= elementSize;
  // Short runs (a column-chunked embedding copies one element per row) go
  // word by word through aligned views instead of byte by byte.
  if (runBytes < 64) {
    const word = elementSize % 4 === 0 ? 4 : elementSize % 2 === 0 ? 2 : 1;
    if (word > 1 && source.byteOffset % word === 0 && target.byteOffset % word === 0) {
      const View = word === 4 ? Uint32Array : Uint16Array;
      const from = new View(source.buffer, source.byteOffset, Math.floor(source.byteLength / word));
      const to = new View(target.buffer, target.byteOffset, Math.floor(target.byteLength / word));
      const runWords = runBytes / word;
      if (rank === 2 && inner === 1) {
        // Two dimensions, rows of one run each: one tight loop.
        const sourceRow = sourceStrides[0] * elementSize / word;
        const targetRow = targetStrides[0] * elementSize / word;
        let s = sourceOffset / word;
        let t = targetOffset / word;
        for (let row = lo[0]; row < hi[0]; row++, s += sourceRow, t += targetRow) {
          for (let k = 0; k < runWords; k++) to[t + k] = from[s + k];
        }
        return;
      }
      copyRuns(lo, hi, inner, sourceStrides, targetStrides, elementSize, sourceOffset, targetOffset, (sOffset, tOffset) => {
        const sw = sOffset / word;
        const tw = tOffset / word;
        for (let k = 0; k < runWords; k++) to[tw + k] = from[sw + k];
      });
      return;
    }
  }
  copyRuns(lo, hi, inner, sourceStrides, targetStrides, elementSize, sourceOffset, targetOffset, (sOffset, tOffset) => {
    if (runBytes >= 64) target.set(source.subarray(sOffset, sOffset + runBytes), tOffset);
    else for (let b = 0; b < runBytes; b++) target[tOffset + b] = source[sOffset + b];
  });
}

/** Visit every run of a block intersection: an odometer over the dimensions before `inner`. */
function copyRuns(lo, hi, inner, sourceStrides, targetStrides, elementSize, sourceOffset, targetOffset, copyRun) {
  const coords = lo.slice(0, inner);
  const sourceStep = sourceStrides.map(stride => stride * elementSize);
  const targetStep = targetStrides.map(stride => stride * elementSize);
  for (;;) {
    copyRun(sourceOffset, targetOffset);
    // Advance the outer coordinates (odometer over dimensions before `inner`).
    let d = inner - 1;
    for (; d >= 0; d--) {
      coords[d]++;
      sourceOffset += sourceStep[d];
      targetOffset += targetStep[d];
      if (coords[d] < hi[d]) break;
      const span = hi[d] - lo[d];
      sourceOffset -= span * sourceStep[d];
      targetOffset -= span * targetStep[d];
      coords[d] = lo[d];
    }
    if (d < 0) return;
  }
}

/** Fill `target` with the repeated `pattern` (one element). */
function fillWith(target, pattern) {
  if (pattern === null) return;
  let nonzero = false;
  for (const byte of pattern) if (byte !== 0) nonzero = true;
  if (!nonzero) return;
  const size = pattern.length;
  if (target.length < size) return;
  target.set(pattern, 0);
  // Doubling copies: log(n) set() calls.
  let filled = size;
  while (filled < target.length) {
    const length = Math.min(filled, target.length - filled);
    target.copyWithin(filled, 0, length);
    filled += length;
  }
}

/**
 * `promise`, rejected at once when `signal` aborts (calling `onAborted`, so
 * this read withdraws from the shared fetches it was waiting for).
 */
function abortable(promise, signal, onAborted) {
  if (signal === null) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAborted();
      reject(signal.reason ?? new DOMException('The read was aborted.', 'AbortError'));
    };
    if (signal.aborted) {
      // Nobody waits for `promise` now: its failure (the fetch just
      // released) is not left unobserved.
      promise.catch(() => {});
      abort();
      return;
    }
    const stopWaiting = onAbort(signal, abort);
    promise.then(
      value => {
        stopWaiting();
        resolve(value);
      },
      error => {
        stopWaiting();
        reject(error);
      }
    );
  });
}

/**
 * Call `visit(linear, coords)` for every chunk from grid coordinates `first`
 * to `last` (inclusive, row-major), `linear` its number in `grid`.
 */
function forEachChunkIn(first, last, grid, visit) {
  const rank = grid.length;
  const coords = first.slice();
  for (;;) {
    let linear = 0;
    for (let d = 0; d < rank; d++) linear = linear * grid[d] + coords[d];
    visit(linear, coords);
    let d = rank - 1;
    for (; d >= 0; d--) {
      if (++coords[d] <= last[d]) break;
      coords[d] = first[d];
    }
    if (d < 0) return;
  }
}

/**
 * Reads element bytes of one dataset.
 */
export class DatasetReader {
  /**
   * @param {import('./context.js').FileContext} file
   * @param {import('./load.js').ObjectInfo} info
   * @param {string} label - The dataset's path, for messages
   */
  constructor(file, info, label) {
    this.file = file;
    this.info = info;
    this.label = label;
    this.shape = info.space.kind === 'null' ? [0] : info.space.dims;
    this.elementSize = info.type.size;
    this.layout = info.layout;
    this.filters = info.filters;
    this.table = null;
  }

  /** The bytes of one fill element (null: zeros). */
  fillPattern() {
    const fill = this.info.fill;
    if (fill?.defined && fill.bytes !== null && fill.bytes.length === this.elementSize) return fill.bytes;
    return null;
  }

  requireReadable() {
    this.file.requireOpen();
    if (this.info.unsupported) throw this.info.unsupported;
    if (this.layout.class === 'virtual') {
      throw new Hdf5UnsupportedError('virtual-dataset',
        `${this.label} is a virtual dataset (its data is mapped from other datasets), which this reader does not read.`);
    }
    if (this.info.externalStorage) {
      throw new Hdf5UnsupportedError('external-storage',
        `${this.label} keeps its data in separate external files, which this reader does not read.`);
    }
  }

  /**
   * The chunk table, read once and shared by every read asking for it
   * meanwhile (`SharedWork`): its reads stop only once every one of them
   * withdrew, and the next read then reads it anew.
   */
  chunkTable(signal, activity = null) {
    if (this.table === null || this.table.abandoned) {
      const layout = this.layout;
      const chunkBytes = layout.chunkDims.reduce((a, b) => a * b, 1) * layout.elementSize;
      const table = new SharedWork(tableSignal => loadChunkTable(this.file.withActivity(activity), {
        dims: this.shape,
        maxDims: this.info.space.maxDims,
        layout,
        filtered: this.filters.length > 0,
        chunkBytes,
      }, tableSignal));
      this.table = table;
      table.promise.catch(() => {
        if (this.table === table) this.table = null;
      });
    }
    return this.table.join(signal);
  }

  /**
   * The selection's element bytes, row-major, in a new buffer.
   *
   * @param {Array<[number, number]>} selection - Normalized
   * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
   *   `activity`: passed to every byte reader read; its `decoded(chunks, bytes)`
   *   is told how many chunks this read decoded
   * @returns {Promise<Uint8Array>}
   */
  async read(selection, { signal = null, activity = null } = {}) {
    this.requireReadable();
    throwIfAborted(signal);
    const count = selectionSize(selection);
    const target = allocateTypedArray(Uint8Array, count * this.elementSize, this.label);
    if (count === 0) return target;
    switch (this.layout.class) {
      case 'compact':
        this.readCompact(selection, target);
        break;
      case 'contiguous':
        await this.readContiguous(selection, target, signal, activity);
        break;
      case 'chunked':
        await this.readChunked(selection, target, signal, activity);
        break;
      default:
        throw new Hdf5UnsupportedError(`layout:${this.layout.class}`, `${this.label} uses the ${this.layout.class} storage layout, which this reader does not read.`);
    }
    return target;
  }

  readCompact(selection, target) {
    const data = this.layout.data;
    const needed = this.shape.reduce((a, b) => a * b, 1) * this.elementSize;
    if (data.length < needed) {
      fillWith(target, this.fillPattern());
      if (data.length === 0) return;
    }
    const block = data.length >= needed ? data : new Uint8Array(needed);
    if (block !== data) block.set(data.subarray(0, needed));
    copyIntersection(block, this.shape.map(() => 0), this.shape, target, selection, this.elementSize);
  }

  /** The byte runs of a contiguous selection, merged into requests. */
  contiguousPlan(selection) {
    const shape = this.shape;
    const rank = shape.length;
    const size = this.elementSize;
    const strides = stridesOf(shape);
    // Axis of the innermost run: everything after it is selected whole.
    let axis = Math.max(0, rank - 1);
    while (axis > 0 && selection[axis][0] === 0 && selection[axis][1] === shape[axis]) axis--;
    const runBytes = rank === 0 ? size : (selection[axis][1] - selection[axis][0]) * strides[axis] * size;
    const outer = selection.slice(0, Math.max(0, axis)).map(([start, stop]) => stop - start);
    const runCount = outer.reduce((a, b) => a * b, 1);
    const base = this.layout.address;
    const shaping = this.file.shaping;
    const gap = shaping.mergeGapBytes;
    const maxRequest = Math.max(shaping.maxRequestBytes, runBytes);
    const offsetOf = coords => {
      let element = rank === 0 ? 0 : selection[axis][0] * strides[axis];
      for (let d = 0; d < axis; d++) element += (selection[d][0] + coords[d]) * strides[d];
      return base + element * size;
    };
    // Walk the runs in file order, opening a new request when the next run is
    // too far from the current one or would make it too long.
    const windows = [];
    const coords = new Array(axis).fill(0);
    let current = null;
    for (let run = 0; run < runCount; run++) {
      const offset = offsetOf(coords);
      if (current !== null && offset - current.end <= gap && offset + runBytes - current.start <= maxRequest) {
        current.end = offset + runBytes;
        current.runs++;
      } else {
        current = { start: offset, end: offset + runBytes, firstRun: run, runs: 1, coords: coords.slice() };
        windows.push(current);
      }
      for (let d = axis - 1; d >= 0; d--) {
        if (++coords[d] < outer[d]) break;
        coords[d] = 0;
      }
    }
    return { windows, runBytes, offsetOf, outer, axis };
  }

  async readContiguous(selection, target, signal, activity) {
    if (this.layout.address === null) {
      fillWith(target, this.fillPattern());
      return;
    }
    const expected = this.shape.reduce((a, b) => a * b, 1) * this.elementSize;
    this.file.requireRange(this.layout.address, expected, `Data of ${this.label}`);
    const { windows, runBytes, offsetOf, outer, axis } = this.contiguousPlan(selection);
    const file = this.file.withActivity(activity);
    await Promise.all(windows.map(window => file.data(window.start, window.end - window.start, `Data of ${this.label}`, signal)
      .then(bytes => {
        const coords = window.coords.slice();
        let targetOffset = window.firstRun * runBytes;
        for (let run = 0; run < window.runs; run++) {
          const from = offsetOf(coords) - window.start;
          if (runBytes >= 64) target.set(bytes.subarray(from, from + runBytes), targetOffset);
          else for (let b = 0; b < runBytes; b++) target[targetOffset + b] = bytes[from + b];
          targetOffset += runBytes;
          for (let d = axis - 1; d >= 0; d--) {
            if (++coords[d] < outer[d]) break;
            coords[d] = 0;
          }
        }
      })));
  }

  /** The chunks a selection intersects: written ones, and whether any are not. */
  async chunksFor(selection, signal, activity) {
    const table = await this.chunkTable(signal, activity);
    const chunkDims = this.layout.chunkDims;
    const first = selection.map(([start], d) => Math.floor(start / chunkDims[d]));
    const last = selection.map(([, stop], d) => Math.ceil(stop / chunkDims[d]) - 1);
    const grid = table.grid;
    if (table.cover) {
      // A chunk index read as it is needed: the entries of these chunks first.
      const number = coords => coords.reduce((linear, c, d) => linear * grid[d] + c, 0);
      await table.cover(number(first), number(last), this.file.withActivity(activity), signal);
    }
    const chunks = [];
    let missing = false;
    forEachChunkIn(first, last, grid, (linear, coords) => {
      const slot = table.find(linear);
      if (slot < 0) missing = true;
      else chunks.push({ linear, slot, coords: coords.slice(), address: table.address[slot], size: table.size[slot], mask: table.mask[slot] });
    });
    return { chunks, missing };
  }

  /**
   * The part of an unfiltered chunk inside `selection` as one run of its
   * bytes, when it is one and is less than the whole chunk: the run's byte
   * range within the chunk and the block of elements it holds. Null when
   * the chunk must be read whole (filtered, or its part is not one run).
   */
  chunkRun(chunk, selection) {
    if (this.filters.length > 0) return null;
    const chunkDims = this.layout.chunkDims;
    const rank = chunkDims.length;
    if (rank === 0) return null;
    const blockStart = chunk.coords.map((c, d) => c * chunkDims[d]);
    const lo = Math.max(blockStart[0], selection[0][0]);
    const hi = Math.min(blockStart[0] + chunkDims[0], selection[0][1]);
    if (hi <= lo) return null;
    // Rows of the chunk are one run only when every later dimension is
    // selected over the chunk's whole extent (an edge chunk's padding
    // included, as it is stored).
    for (let d = 1; d < rank; d++) {
      if (selection[d][0] > blockStart[d] || selection[d][1] < blockStart[d] + chunkDims[d]) return null;
    }
    if (lo === blockStart[0] && hi === blockStart[0] + chunkDims[0]) return null;
    let rowBytes = this.layout.elementSize;
    for (let d = 1; d < rank; d++) rowBytes *= chunkDims[d];
    return {
      start: (lo - blockStart[0]) * rowBytes,
      end: (hi - blockStart[0]) * rowBytes,
      blockStart: [lo, ...blockStart.slice(1)],
      blockShape: [hi - lo, ...chunkDims.slice(1)],
    };
  }

  async readChunked(selection, target, signal, activity) {
    const { chunks, missing } = await this.chunksFor(selection, signal, activity);
    if (missing) fillWith(target, this.fillPattern());
    if (chunks.length === 0) return;
    const layout = this.layout;
    const chunkDims = layout.chunkDims;
    const chunkBytes = chunkDims.reduce((a, b) => a * b, 1) * layout.elementSize;
    const size = this.elementSize;
    const file = this.file;
    const place = (chunk, bytes) => {
      copyIntersection(bytes, chunk.coords.map((c, d) => c * chunkDims[d]), chunkDims, target, selection, size);
    };

    // Chunks already decoded, chunks another read is fetching, chunks to
    // fetch, and runs of unfiltered chunks to fetch alone.
    const own = [];
    const others = [];
    const runs = [];
    // A group every read left (being stopped) is not joined: its chunks are fetched again.
    const sharedGroup = address => {
      const group = file.inflight.get(address);
      return group !== undefined && !group.work.abandoned ? group : undefined;
    };
    for (const chunk of chunks) {
      const cached = file.cache.get(chunk.address);
      if (cached !== undefined) place(chunk, cached);
      else if (sharedGroup(chunk.address) !== undefined) others.push(chunk);
      else {
        const run = this.chunkRun(chunk, selection);
        if (run !== null) runs.push({ chunk, run });
        else own.push(chunk);
      }
    }
    const runsDone = runs.length === 0 ? null : this.readChunkRuns(runs, target, selection, signal, activity);
    runsDone?.catch(() => {});
    if (own.length === 0 && others.length === 0) {
      await runsDone;
      return;
    }
    own.sort((a, b) => a.address - b.address);

    // Neighbouring chunks are fetched as one request, within the link's
    // merge gap and maximum request size.
    const shaping = file.shaping;
    const mergeGapBytes = shaping.mergeGapBytes;
    const groupBytes = GROUP_BYTES(shaping);
    const groups = [];
    let group = null;
    for (const chunk of own) {
      const end = chunk.address + chunk.size;
      if (group !== null && chunk.address - group.end <= mergeGapBytes && end - group.start <= groupBytes) {
        group.end = Math.max(group.end, end);
        group.chunks.push(chunk);
      } else {
        group = { start: chunk.address, end, chunks: [chunk], work: null };
        groups.push(group);
      }
    }

    // Decoded chunks are kept for reads that may want them again: a chunk
    // this read used only part of (the rest of a gene strip, the next slab's
    // first rows). Not a chunk it used whole (its caller now holds all of
    // it: a streamed field or index pass never fills the cache), nor when the
    // read's chunks would fill the cache on their own (they would only evict
    // each other and everything else).
    const shape = this.shape;
    const partial = chunk => chunk.coords.some((c, d) =>
      c * chunkDims[d] < selection[d][0] || Math.min((c + 1) * chunkDims[d], shape[d]) > selection[d][1]);
    const counts = {
      chunks: 0,
      bytes: 0,
      cache: chunks.length * chunkBytes <= file.cache.budget,
      keep: partial,
      // A pass no one waits for (a gene index building) decodes behind every other read.
      background: activity?.background === true,
      activity,
    };
    const fetcher = file.withActivity(activity);
    /**
     * Register `group` at once (concurrent reads asking for its chunks from
     * now on share it), to be fetched as one request and decoded when the
     * memory budget has room. One shared work per group, not per chunk:
     * reads of many small chunks stay cheap. Its fetch and decodes stop once
     * every read waiting for it withdrew (`SharedWork`), never before.
     */
    const register = group => {
      group.slots = new Map(group.chunks.map((chunk, index) => [chunk.address, index]));
      group.done = new Promise((resolve, reject) => {
        group.settle = { resolve, reject };
      });
      group.work = new SharedWork(() => group.done);
      const forget = () => {
        for (const chunk of group.chunks) {
          if (file.inflight.get(chunk.address) === group) file.inflight.delete(chunk.address);
        }
      };
      group.done.catch(() => {}).finally(forget);
      // Every read left: the next read of these chunks fetches them anew.
      onAbort(group.work.signal, forget);
      for (const chunk of group.chunks) file.inflight.set(chunk.address, group);
    };
    const start = group => {
      fetcher.data(group.start, group.end - group.start, `Chunks of ${this.label}`, group.work.signal)
        .then(fetched => {
          const decoded = group.chunks.map(chunk => this.decodeChunk(chunk,
            fetched.subarray(chunk.address - group.start, chunk.address - group.start + chunk.size), chunkBytes, counts,
            group.work.signal));
          return this.filters.length > 0 ? Promise.all(decoded) : decoded;
        })
        .then(group.settle.resolve, group.settle.reject);
    };
    /** Place `chunks` once their groups are decoded. */
    const placeFrom = (sourceGroup, chunks) => sourceGroup.done.then(decoded => {
      for (const chunk of chunks) place(chunk, decoded[sourceGroup.slots.get(chunk.address)]);
    });

    // Fetch groups in address order within the file's memory budget, so
    // reads through thousands of large chunks never hold them all at once.
    const byGroup = new Map();
    for (const chunk of others) {
      const sourceGroup = sharedGroup(chunk.address);
      if (!byGroup.has(sourceGroup)) byGroup.set(sourceGroup, []);
      byGroup.get(sourceGroup).push(chunk);
    }
    // This read waits for each group once: it withdraws from all of them
    // when its signal aborts, or when it fails.
    const leaves = [];
    for (const sourceGroup of byGroup.keys()) leaves.push(sourceGroup.work.hold());
    const ownLeaves = [];
    for (const next of groups) {
      register(next);
      ownLeaves.push(next.work.hold());
    }
    const withdraw = () => {
      for (const leave of leaves) leave();
      for (const leave of ownLeaves) leave();
    };
    const othersDone = abortable(Promise.all([...byGroup].map(([sourceGroup, list]) => placeFrom(sourceGroup, list))),
      signal, withdraw);
    othersDone.catch(() => {});
    const placements = groups.map(next => abortable(placeFrom(next, next.chunks), signal, withdraw));
    // Start the groups in address order as the budget allows; nothing awaits
    // this loop but the groups themselves.
    (async () => {
      for (let i = 0; i < groups.length; i++) {
        // Dropped from the list once started: a placed group's decoded chunks
        // are then free to go, whatever the rest of the read still holds.
        const next = groups[i];
        groups[i] = null;
        const weight = (next.end - next.start) + next.chunks.length * chunkBytes;
        file.noteGroup(weight, weight / next.chunks.length);
        // A pass no one waits for yet takes its room after every read someone waits for.
        const giveBack = await file.decodeBudget.acquire(weight, () => activity?.background === true);
        next.done.catch(() => {}).finally(giveBack);
        if (next.work.abandoned) {
          // Every read waiting for it gave up before it started.
          next.settle.reject(next.work.signal.reason);
        } else {
          start(next);
        }
      }
    })();
    try {
      await Promise.all([othersDone, ...placements, runsDone]);
    } catch (error) {
      // This read failed: it no longer waits for any group (withdrawing
      // twice does nothing).
      withdraw();
      throw error;
    }
    if (counts.chunks > 0) activity?.decoded?.(counts.chunks, counts.bytes);
  }

  /**
   * Fetch the runs of unfiltered chunks (`chunkRun`), all asked for at once
   * (the byte reader merges them as the link makes worth it), each copied
   * into place as it arrives, within the file's memory budget.
   */
  async readChunkRuns(runs, target, selection, signal, activity) {
    const file = this.file;
    const fetcher = file.withActivity(activity);
    const background = () => activity?.background === true;
    const size = this.elementSize;
    await Promise.all(runs.map(async ({ chunk, run }) => {
      const bytes = run.end - run.start;
      const giveBack = await file.decodeBudget.acquire(bytes, background);
      try {
        throwIfAborted(signal);
        const fetched = await fetcher.data(chunk.address + run.start, bytes, `Chunks of ${this.label}`, signal);
        copyIntersection(fetched, run.blockStart, run.blockShape, target, selection, size);
      } finally {
        giveBack();
      }
    }));
    activity?.decoded?.(runs.length, runs.reduce((sum, { run }) => sum + run.end - run.start, 0));
  }

  /**
   * Undo the filters of one stored chunk, check its size, and cache it.
   * Unfiltered chunks are handled synchronously (no promise per chunk).
   * `signal` (the chunk's fetch group's) stops waiting for the decode once
   * no read wants the chunk.
   */
  decodeChunk(chunk, stored, chunkBytes, counts, signal = null) {
    if (this.filters.length === 0) return this.keepChunk(chunk, stored, chunkBytes, counts);
    // A few chunks are decompressed at a time: each decompressor holds its
    // own buffers, and thousands at once would hold them all.
    const slots = this.file.decodeSlots;
    let giveBack = () => {};
    return slots.acquire(1, () => counts.activity?.background === true)
      .then(release => {
        giveBack = release;
        return this.unfilterChunk(chunk, stored, chunkBytes, signal, counts.background === true);
      })
      .finally(() => giveBack())
      .then(decoded => this.keepChunk(chunk, decoded, chunkBytes, counts));
  }

  /** Undo the filters of one chunk, on a decode worker when it is large enough (`io/decode-pool.js`). */
  async unfilterChunk(chunk, stored, chunkBytes, signal = null, background = false) {
    const layout = this.layout;
    const chunkDims = layout.chunkDims;
    let mask = chunk.mask;
    // Partial edge chunks may be stored unfiltered (layout flag bit 0).
    if (layout.flags & 1 && chunk.coords.some((c, d) => (c + 1) * chunkDims[d] > this.shape[d])) mask = 0xffffffff;
    for (const filter of unsupportedFilters(this.filters)) {
      if (!(mask & (1 << this.filters.indexOf(filter)))) {
        throw new Hdf5UnsupportedError(`filter:${filterName(filter)}`,
          `${this.label} is compressed with the ${filterName(filter)} filter (HDF5 filter id ${filter.id}), which this reader cannot decompress.`);
      }
    }
    const label = `Chunk [${chunk.coords.join(', ')}] of ${this.label}`;
    return decodeChunkBytes({
      kind: 'hdf5',
      description: { filters: this.filters, mask, chunkBytes, label },
      input: stored,
      size: chunkBytes,
      signal,
      background,
      revive: reviveHdf5Error,
      inThread: () => unfilter(stored, this.filters, mask, chunkBytes, label),
    });
  }

  keepChunk(chunk, decoded, chunkBytes, counts) {
    if (decoded.length !== chunkBytes) {
      throw new Hdf5FormatError(`Chunk [${chunk.coords.join(', ')}] of ${this.label} holds ${formatCountOf(decoded.length, 'byte')}, not the ${chunkBytes} of a chunk.`);
    }
    counts.chunks++;
    counts.bytes += decoded.length;
    // The cache keeps an owned copy: a view would hold a whole request buffer alive.
    if (counts.cache && counts.keep(chunk) && chunkBytes <= this.file.cache.budget) {
      if (decoded.byteOffset !== 0 || decoded.buffer.byteLength !== decoded.length) decoded = decoded.slice();
      this.file.cache.set(chunk.address, decoded, chunkBytes);
    }
    return decoded;
  }

  /**
   * Stored bytes a read of `selection` fetches. Exact, except over a chunk
   * index read as it is needed (a version 1 chunk B-tree) whose entries for
   * the selection are not read yet: then each chunk not read yet counts the
   * size its index node's parent key gives (`storedSizeOf`), and no more of
   * the index is read. Asking what a whole matrix stores costs no request.
   */
  async storedBytes(selection, { signal = null, activity = null } = {}) {
    this.requireReadable();
    if (selectionSize(selection) === 0) return 0;
    if (this.layout.class === 'compact') return 0;
    if (this.layout.class === 'contiguous') {
      if (this.layout.address === null) return 0;
      return this.contiguousPlan(selection).windows.reduce((sum, window) => sum + window.end - window.start, 0);
    }
    const table = await this.chunkTable(signal, activity);
    const chunkDims = this.layout.chunkDims;
    const first = selection.map(([start], d) => Math.floor(start / chunkDims[d]));
    const last = selection.map(([, stop], d) => Math.ceil(stop / chunkDims[d]) - 1);
    const number = coords => coords.reduce((linear, c, d) => linear * table.grid[d] + c, 0);
    if (table.covered && !table.covered(number(first), number(last))) {
      let total = 0;
      forEachChunkIn(first, last, table.grid, (linear, coords) => {
        const size = table.storedSizeOf(linear);
        if (size === 0) return;
        const run = this.chunkRun({ coords }, selection);
        total += run === null ? size : run.end - run.start;
      });
      return total;
    }
    const { chunks } = await this.chunksFor(selection, signal, activity);
    return chunks.reduce((sum, chunk) => {
      const run = this.chunkRun(chunk, selection);
      return sum + (run === null ? chunk.size : run.end - run.start);
    }, 0);
  }
}
