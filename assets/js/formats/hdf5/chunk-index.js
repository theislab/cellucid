/**
 * Where a chunked dataset's chunks are: every chunk index HDF5 writes, read
 * into one table.
 *
 * | layout | index | read as |
 * | --- | --- | --- |
 * | older format | version 1 B-tree | level by level, keys give chunk offsets; leaves as their chunks are needed |
 * | newer format, one chunk | single chunk | address in the layout message |
 * | newer, fixed size, early allocation, no filters | implicit | computed: no reads |
 * | newer, fixed maximum shape | fixed array | fixed-array.js |
 * | newer, one unlimited dimension | extensible array | extensible-array.js |
 * | newer, several unlimited dimensions | version 2 B-tree (types 10, 11) | level by level |
 *
 * Whatever the index, the result is a `ChunkTable`: for each chunk of the
 * current chunk grid (row-major over `ceil(shape / chunks)`), its file
 * address, stored size and filter mask. Dense indexes become dense typed
 * arrays (20 bytes per chunk); B-tree indexes of sparsely written datasets
 * stay sorted arrays searched by chunk number, so memory follows the chunks
 * written, not the grid.
 *
 * @module formats/hdf5/chunk-index
 */

import { readUintLE } from './binary.js';
import { readBtreeV1Nodes, readChunkKey } from './btree-v1.js';
import { walkBtreeV2 } from './btree-v2.js';
import { readExtensibleArray } from './extensible-array.js';
import { readFixedArray } from './fixed-array.js';
import { formatError } from './errors.js';
import { ReadActivity } from '../io/activity.js';
import { SharedWork } from '../io/abort.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';

/**
 * @typedef {Object} ChunkTable
 * @property {number[]} grid - Chunks per dimension (current shape)
 * @property {(linear: number) => number} find - Slot of a chunk, or -1 when never written
 * @property {Float64Array} address
 * @property {Float64Array} size
 * @property {Uint32Array} mask
 * @property {number} count - Chunks written (read so far, for a table read as it is needed)
 * @property {(first: number, last: number, reader?: Object, signal?: AbortSignal|null) => Promise<unknown>} [cover] - Read the
 *   index entries of chunks `first..last` (grid numbers) before they are looked up, for a table read
 *   as it is needed, waiting with `signal` (a leaf read stops once every read waiting for it withdrew)
 * @property {(first: number, last: number) => boolean} [covered] - Whether the entries of chunks
 *   `first..last` are read (a table read as it is needed)
 * @property {(linear: number) => number} [storedSizeOf] - A chunk's stored size without reading
 *   more of the index: exact once its entry is read, else its index node's first chunk's size
 *   (a table read as it is needed)
 */

/** Chunks per dimension for `dims` (a dimension of unlimited maximum has none: null). */
export function chunkGrid(dims, chunkDims) {
  return dims.map((extent, d) => (extent === null ? null : Math.ceil(extent / chunkDims[d])));
}

/** A table over every chunk of the grid. */
function denseTable(grid, count) {
  const address = allocateTypedArray(Float64Array, count, 'HDF5 chunk index').fill(-1);
  const size = allocateTypedArray(Float64Array, count, 'HDF5 chunk index');
  const mask = allocateTypedArray(Uint32Array, count, 'HDF5 chunk index');
  return {
    grid,
    address,
    size,
    mask,
    count: 0,
    find: linear => (linear >= 0 && linear < count && address[linear] >= 0 ? linear : -1),
    put(linear, chunkAddress, chunkSize, chunkMask) {
      if (linear < 0 || linear >= count) return;
      if (address[linear] < 0) this.count++;
      address[linear] = chunkAddress;
      size[linear] = chunkSize;
      mask[linear] = chunkMask;
    },
  };
}

/** A table of the chunks written, sorted by chunk number. */
function sortedTable(grid, entries) {
  entries.sort((a, b) => a[0] - b[0]);
  const linear = Float64Array.from(entries, entry => entry[0]);
  const table = {
    grid,
    address: Float64Array.from(entries, entry => entry[1]),
    size: Float64Array.from(entries, entry => entry[2]),
    mask: Uint32Array.from(entries, entry => entry[3]),
    count: entries.length,
    find(target) {
      let low = 0;
      let high = linear.length - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const value = linear[middle];
        if (value === target) return middle;
        if (value < target) low = middle + 1;
        else high = middle - 1;
      }
      return -1;
    },
  };
  return table;
}

/** Row-major number of the chunk at scaled `coords` in `grid`, or -1 outside it. */
function linearIndex(coords, grid) {
  let linear = 0;
  for (let d = 0; d < grid.length; d++) {
    if (coords[d] >= grid[d]) return -1;
    linear = linear * grid[d] + coords[d];
  }
  return linear;
}

/**
 * Read a chunked dataset's chunk index.
 *
 * @param {import('./context.js').FileContext} file
 * @param {{dims: number[], maxDims: Array<number|null>, layout: Object, filtered: boolean, chunkBytes: number}} dataset
 * @returns {Promise<ChunkTable>}
 */
export async function loadChunkTable(file, { dims, maxDims, layout, filtered, chunkBytes }, signal = null) {
  const chunkDims = layout.chunkDims;
  const rank = chunkDims.length;
  const grid = chunkGrid(dims, chunkDims);
  const gridCount = grid.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(gridCount)) {
    throw formatError('Chunked dataset', NaN, `its ${grid.join(' × ')} chunk grid has too many chunks to number`);
  }
  if (layout.address === null || gridCount === 0) return denseTable(grid, 0);

  switch (layout.index) {
    case 'single': {
      const table = denseTable(grid, gridCount);
      const info = layout.indexInfo;
      table.put(0, layout.address, info.filteredSize ?? chunkBytes, info.filterMask ?? 0);
      return table;
    }
    case 'implicit': {
      // Chunks are allocated in order over the maximum shape's grid.
      const table = denseTable(grid, gridCount);
      const maxGrid = chunkGrid(maxDims.map((max, d) => max ?? dims[d]), chunkDims);
      forEachChunk(grid, (linear, coords) => {
        table.put(linear, layout.address + linearIndex(coords, maxGrid) * chunkBytes, chunkBytes, 0);
      });
      return table;
    }
    case 'fixed-array': {
      const table = denseTable(grid, gridCount);
      const maxGrid = chunkGrid(maxDims.map((max, d) => max ?? dims[d]), chunkDims);
      const coords = new Array(rank);
      await readFixedArray(file, layout.address, { filtered, chunkBytes }, (index, address, size, mask) => {
        unravel(index, maxGrid, coords);
        table.put(linearIndex(coords, grid), address, size, mask);
      }, signal);
      return table;
    }
    case 'extensible-array': {
      const table = denseTable(grid, gridCount);
      // Entries are numbered with the unlimited dimension slowest, the others
      // row-major over their maximum chunk counts.
      const unlimited = maxDims.findIndex(max => max === null);
      const order = [unlimited, ...chunkDims.map((_, d) => d).filter(d => d !== unlimited)];
      const swizzledGrid = order.map((d, i) => (i === 0 ? Infinity : Math.ceil(maxDims[d] / chunkDims[d])));
      const swizzled = new Array(rank);
      const coords = new Array(rank);
      await readExtensibleArray(file, layout.address, { filtered, chunkBytes }, (index, address, size, mask) => {
        unravel(index, swizzledGrid, swizzled);
        for (let i = 0; i < rank; i++) coords[order[i]] = swizzled[i];
        table.put(linearIndex(coords, grid), address, size, mask);
      }, signal);
      return table;
    }
    case 'btree-v1':
      return btreeV1Table(file, layout, grid, gridCount, signal);
    case 'btree-v2': {
      const entries = [];
      const O = file.offsetSize;
      const fail = problem => {
        throw formatError('Chunk B-tree', file.absolute(layout.address), problem);
      };
      const scaled = new Array(rank);
      await walkBtreeV2(file, layout.address, (bytes, offset, header) => {
        const address = readUintLE(bytes, offset, O, fail);
        let at = offset + O;
        let size = chunkBytes;
        let mask = 0;
        if (header.type === 11) {
          const sizeBytes = header.recordSize - O - 4 - 8 * rank;
          size = readUintLE(bytes, at, sizeBytes, fail);
          mask = readUintLE(bytes, at + sizeBytes, 4, fail);
          at += sizeBytes + 4;
        }
        for (let d = 0; d < rank; d++) scaled[d] = readUintLE(bytes, at + 8 * d, 8, fail);
        const linear = linearIndex(scaled, grid);
        if (linear >= 0 && address !== null) entries.push([linear, address, size, mask]);
      }, { signal, expectType: filtered ? 11 : 10, exact: true });
      return tableFromEntries(grid, gridCount, entries);
    }
    default:
      throw formatError('Chunked dataset', NaN, `chunk index '${layout.index}' is unknown`);
  }
}

/**
 * The chunk table of a version 1 chunk B-tree. The tree is read down to the
 * parents of its leaves; the leaves (one node per 2K chunks, scattered among
 * the chunks) are read when a read first needs their chunks (`cover`), all
 * the leaves one read needs at once. A read of the first rows then waits for
 * one leaf, not for every leaf of the dataset, and a scan in row order reads
 * the leaves as it goes. A tree whose leaves cannot be placed on the grid
 * (keys outside it), or that indexes a small part of a large grid, is read
 * whole at once.
 */
async function btreeV1Table(file, layout, grid, gridCount, signal) {
  const chunkDims = layout.chunkDims;
  const rank = chunkDims.length;
  const fail = problem => {
    throw formatError('Chunk B-tree', file.absolute(layout.address), problem);
  };
  const scaled = new Array(rank);
  /** The grid number of the chunk whose key is at `keyOffset` (-1 outside the grid). */
  const keyLinear = (bytes, keyOffset) => {
    const key = readChunkKey(bytes, keyOffset, rank, fail);
    for (let d = 0; d < rank; d++) {
      if (key.coords[d] % chunkDims[d] !== 0) fail(`chunk offset ${key.coords.join(',')} is not on a chunk boundary`);
      scaled[d] = key.coords[d] / chunkDims[d];
    }
    return { linear: linearIndex(scaled, grid), key };
  };
  const seen = new Set();
  const visit = nodes => {
    for (const node of nodes) {
      if (seen.has(node.address)) throw formatError('Chunk B-tree node', file.absolute(node.address), 'it is reached twice; the tree is corrupt');
      seen.add(node.address);
    }
  };

  // Internal levels, down to the leaves' parents.
  let level = [{ address: layout.address, level: null }];
  let leaves = null;
  const leafEntries = [];
  while (leaves === null) {
    visit(level);
    const nodes = await readBtreeV1Nodes(file, level, 1, { rank, signal });
    if (nodes.every(node => node.level === 0)) {
      // The root is a leaf: the table is complete.
      for (const node of nodes) leafEntries.push(node);
      break;
    }
    if (nodes.some(node => node.level === 0)) fail('its leaves lie at different depths');
    if (nodes[0].level === 1) {
      leaves = [];
      for (const node of nodes) {
        for (const { keyOffset, child } of node.entries) {
          // A parent's key of a leaf is the key of the leaf's first chunk:
          // its number and its stored size.
          const { linear, key } = keyLinear(node.bytes, keyOffset);
          leaves.push({ address: child, start: linear, firstSize: key.size });
        }
      }
    } else {
      level = nodes.flatMap(node => node.entries.map(({ child }) => ({ address: child, level: node.level - 1 })));
    }
  }

  const place = (table, nodes) => {
    for (const node of nodes) {
      for (const { keyOffset, child } of node.entries) {
        const { linear, key } = keyLinear(node.bytes, keyOffset);
        if (linear >= 0) table.put(linear, child, key.size, key.mask);
      }
    }
  };
  const leafCapacity = 2 * file.btreeK.chunk;
  const placeable = leaves !== null && leaves.every((leaf, i) => leaf.start >= 0 && (i === 0 || leaf.start >= leaves[i - 1].start));
  if (leaves === null || !placeable || gridCount > Math.max(1024, 4 * leaves.length * leafCapacity)) {
    if (leaves !== null) {
      visit(leaves);
      // Appended one by one: a spread of every leaf node into one call would
      // exceed the engine's argument limit on a file of millions of chunks.
      for (const node of await readBtreeV1Nodes(file, leaves.map(leaf => ({ address: leaf.address, level: 0 })), 1, { rank, signal })) {
        leafEntries.push(node);
      }
    }
    const entries = [];
    for (const node of leafEntries) {
      for (const { keyOffset, child } of node.entries) {
        const { linear, key } = keyLinear(node.bytes, keyOffset);
        if (linear >= 0) entries.push([linear, child, key.size, key.mask]);
      }
    }
    return tableFromEntries(grid, gridCount, entries);
  }

  visit(leaves);
  const table = denseTable(grid, gridCount);
  // A leaf's size on disk: its header and 2K + 1 keys (a chunk size, a filter
  // mask and rank + 1 offsets) around 2K child addresses.
  const leafBytes = 24 + (2 * file.btreeK.chunk + 1) * (8 + 8 * (rank + 1)) + 2 * file.btreeK.chunk * file.offsetSize;
  const loading = new Array(leaves.length).fill(null);
  /** Leaves read ahead in the background, and leaves placed in the table. */
  const ahead = allocateTypedArray(Uint8Array, leaves.length, 'HDF5 chunk index leaves');
  const placed = allocateTypedArray(Uint8Array, leaves.length, 'HDF5 chunk index leaves');
  /** The last leaf starting at or before chunk `linear` (the first leaf for one before it). */
  const leafOf = linear => {
    let low = 0;
    let high = leaves.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (leaves[middle].start <= linear) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  table.covered = (first, last) => {
    for (let i = leafOf(first); i < leaves.length && leaves[i].start <= last; i++) if (!placed[i]) return false;
    return true;
  };
  /**
   * A chunk's stored size without reading its leaf: once the leaf is read,
   * its entry's (0 when it was never written); before, the size of the
   * leaf's first chunk, which its parent's key holds. What a whole dataset
   * stores is then known from the levels read at open (one key in every 2K
   * chunks; the chunks of one dataset compress alike), not from a request
   * for every leaf: the 12,382 leaves of a 2.3M-cell atlas's `X`, 850 KB
   * apart, are as many round trips.
   */
  table.storedSizeOf = linear => {
    const slot = table.find(linear);
    if (slot >= 0) return table.size[slot];
    const i = leafOf(linear);
    return placed[i] ? 0 : leaves[i].firstSize;
  };
  /** Where the reads of this table have reached in leaf order (the last leaf a read covered). */
  let scanEnd = -1;
  /** Whether leaf `i` is being read, or was, for reads that may still wait for it. */
  const asked = i => loading[i] !== null && !loading[i].abandoned;
  /**
   * Read the leaves holding chunks `first..last` (grid numbers) that are not
   * read yet, all at once, through `reader` (the file as the read sees it),
   * waiting with `signal`. A leaf read is shared by every read waiting for
   * it (`SharedWork`): it stops only once every one of them withdrew, and is
   * read again by the next read that needs it.
   */
  table.cover = (first, last, reader = file, signal = null) => {
    const low = leafOf(first);
    const high = leafOf(last);
    // A leaf wanted now: not read yet, or, for a read a view waits for,
    // being read ahead in the background (which it must not wait behind: it
    // is read again in the read's own right, a request of a few kilobytes).
    // Background work waits for a leaf read ahead, never asks for it twice.
    const wanted = [];
    for (let i = low; i <= high; i++) {
      if (!asked(i) || (ahead[i] && !placed[i] && reader.background !== true)) wanted.push(i);
    }
    /** `unwaited`: read ahead of need, to the end whether or not a read comes to wait for it. */
    const readLeaves = (indices, through = reader, background = false, unwaited = false) => {
      const read = new SharedWork(leafSignal => readBtreeV1Nodes(through, indices.map(i => ({ address: leaves[i].address, level: 0 })), 1, { rank, signal: leafSignal })
        .then(nodes => {
          // A leaf read twice (ahead, then for a read) is placed once.
          const fresh = nodes.filter((node, k) => !placed[indices[k]]);
          place(table, fresh);
          indices.forEach(i => {
            placed[i] = true;
          });
        }));
      if (unwaited) read.hold();
      indices.forEach(i => {
        loading[i] = read;
        ahead[i] = background;
      });
      read.promise.catch(() => {
        // A failed read is asked for again by the next read that needs it.
        indices.forEach(i => {
          if (loading[i] === read) loading[i] = null;
        });
      });
    };
    if (wanted.length > 0) {
      readLeaves(wanted);
      // Every other leaf not read yet follows, unwaited for, when all of them
      // transfer in less time than a round trip of the link and go out in
      // one wave of background requests (the link's background concurrency:
      // over HTTP/1.1 more would hold five of six connections for many round
      // trips): later reads of other chunks then wait for no index (a gene
      // is one round trip, not two). They are read as background work, so a
      // read a view waits for (the next gene's chunks) is never queued behind
      // them; a read that needs one of them before it lands reads it in its
      // own right.
      const needed = Promise.all(wanted.map(i => loading[i].promise));
      needed.then(() => setTimeout(() => {
        const unread = [];
        for (let i = 0; i < leaves.length; i++) if (!asked(i)) unread.push(i);
        // One read per leaf (planned together, so fetched together): a later
        // read waits for its own leaf, not for all of them.
        const link = file.reader?.link;
        if (unread.length > 0 && unread.length * leafBytes <= roundTripBytes(file) &&
            unread.length <= (link?.backgroundConcurrency ?? 0)) {
          const through = file.withActivity(new ReadActivity({ kind: 'index', label: 'chunk index leaves, read ahead', background: true }));
          for (const i of unread) readLeaves([i], through, true, true);
        }
      }, 0), () => {});
    }
    const leafReads = new Set();
    for (let i = low; i <= high; i++) if (!placed[i]) leafReads.add(loading[i]);
    const pending = new Set([...leafReads].map(read => read.join(signal)));
    // Every read asked for in this task waits for the leaves of all of them
    // (`indexBurst`): their chunks then go out together, as one plan the
    // byte reader merges, not wave by wave as each read's own leaves land
    // (a burst of 100 Loom genes: 44 leaf requests, then each read's few
    // chunks alone, ~36 requests in seven turns).
    const covered = pending.size === 0 ? Promise.resolve() : indexBurst(file, reader.background === true, pending);
    // A read that goes on where the last one ended (rows in file order: a
    // matrix read slab by slab, the kept rows of a subsample wave by wave)
    // has the leaves after its own read ahead, as many as it needed: the
    // next read's chunk addresses are then known when it starts, and it
    // waits one round trip for its chunks, not two. They are asked for now,
    // with this read's own leaves and as its own (not as background work):
    // background requests wait while any other request waits, so leaves
    // asked for behind this read's chunks came only once those chunks had
    // arrived, and every slab of a scan waited a round trip more for its
    // index (a CSR matrix's first gene over 150 ms at 5 MB/s: a 10 MB scan
    // took 3.1 s, its floor 2.2 s). A leaf is a few kilobytes: going out
    // first, it holds a connection one round trip. A read elsewhere (a gene
    // of a gene-major matrix) reads nothing ahead.
    if (low <= scanEnd + 1 && high > scanEnd && scanEnd >= 0) {
      const count = high - low + 1;
      const next = [];
      for (let i = high + 1; i < leaves.length && i <= high + count; i++) if (!asked(i)) next.push(i);
      for (const i of next) readLeaves([i], reader, false, true);
    }
    // A read within what was covered leaves the scan where it was.
    scanEnd = low > scanEnd + 1 ? high : Math.max(high, scanEnd);
    return covered;
  };
  return table;
}

/**
 * Run `callback` on a later macrotask: after the current task and every
 * promise continuation of it, so every read asked for in one task (the
 * genes of one call, the arrays of one sparse gene) has joined the burst.
 */
const scheduleMacrotask = typeof setImmediate === 'function' ? callback => setImmediate(callback) : callback => setTimeout(callback, 0);

/**
 * The chunk index leaves the reads asked for in one task wait for, together:
 * every read of the task (of any dataset of the file; reads a view waits for
 * apart from background work) resolves when the leaves of all of them are
 * placed. `pending` are this read's leaf reads (joined with its signal);
 * the result rejects as soon as one of them fails.
 */
function indexBurst(file, background, pending) {
  const root = file.unscoped ?? file;
  root.indexBursts ??= new Map();
  let burst = root.indexBursts.get(background);
  if (burst === undefined) {
    burst = { reads: new Set(), done: null };
    root.indexBursts.set(background, burst);
    const closing = burst;
    closing.done = new Promise(resolve => scheduleMacrotask(() => {
      if (root.indexBursts.get(background) === closing) root.indexBursts.delete(background);
      resolve(Promise.allSettled(closing.reads));
    }));
  }
  for (const read of pending) burst.reads.add(read);
  const own = Promise.all(pending);
  const together = burst.done.then(() => own);
  // A read whose own leaves fail (it withdrew: its signal aborted) learns it
  // at once, not once the other reads' leaves are in.
  return Promise.race([together, own.then(() => together)]);
}

/**
 * What one round trip to the file is worth in bytes: measured on its link
 * (`formats/io/link.js`), else the link's prior (a merge gap per request in
 * flight).
 */
function roundTripBytes(file) {
  const link = file.reader?.link;
  if (!link) return 0;
  return link.roundTripBytes ?? link.mergeGapBytes * link.concurrency;
}

/** Dense when the written chunks fill a good part of the grid, sorted otherwise. */
function tableFromEntries(grid, gridCount, entries) {
  if (gridCount <= Math.max(1024, 4 * entries.length)) {
    const table = denseTable(grid, gridCount);
    for (const [linear, address, size, mask] of entries) table.put(linear, address, size, mask);
    return table;
  }
  return sortedTable(grid, entries);
}

/** Coordinates of chunk `index` in `grid` (row-major; the first extent may be Infinity). */
function unravel(index, grid, out) {
  let rest = index;
  for (let d = grid.length - 1; d > 0; d--) {
    out[d] = rest % grid[d];
    rest = Math.floor(rest / grid[d]);
  }
  out[0] = rest;
  return out;
}

/** Call `visit(linear, coords)` for every chunk of `grid`, row-major. */
export function forEachChunk(grid, visit) {
  const rank = grid.length;
  const count = grid.reduce((a, b) => a * b, 1);
  const coords = new Array(rank).fill(0);
  for (let linear = 0; linear < count; linear++) {
    visit(linear, coords);
    for (let d = rank - 1; d >= 0; d--) {
      if (++coords[d] < grid[d]) break;
      coords[d] = 0;
    }
  }
}
