/**
 * Where a chunked dataset's chunks are: every chunk index HDF5 writes, read
 * into one table.
 *
 * | layout | index | read as |
 * | --- | --- | --- |
 * | older format | version 1 B-tree | the root, then each node (internal or leaf) as the chunks below it are needed; keys give chunk offsets |
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
import { roundTripBytesOf } from '../io/link.js';
import { SharedWork } from '../../utils/abort.js';
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
 * @property {(runs: Iterable<[number, number]>) => {nodes: number, levels: number, steps: number[]}} [indexReadsFor] - The
 *   index nodes a read of chunk runs `[first, last]` would read before its chunks, each once, and the
 *   dependent round trips they take, nodes per trip (a table read as it is needed)
 * @property {(linear: number) => number} [storedSizeOf] - A chunk's stored size without reading
 *   more of the index: exact once its entry is read, else the size of the first chunk below the
 *   deepest index node read above it (a table read as it is needed)
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
 * The chunk table of a version 1 chunk B-tree, read as reads need it: the
 * root when the table is made, every other node -- internal or leaf -- when
 * a read first needs chunks below it (`cover`), the nodes of all the reads of
 * one task together, a level a round trip. Making the table costs one node
 * whatever the dataset's chunk count, and a read pays only the nodes on its
 * paths: the parents of the leaves of an 11.4M-cell atlas's `X/indices`
 * (2.26M chunks) are 552 nodes, 13.5 s of requests over S3 before its first
 * view when they were read with the table; a gene sample's 170 blocks need
 * about 170 of them. Every key of a node holds the stored size of the first
 * chunk below it, so what the dataset stores is estimated from the nodes read
 * so far (`storedSizeOf`: the chunks of one dataset compress alike), from the
 * root alone at first. A tree whose keys cannot be placed on the grid, or
 * that indexes a small part of a large grid, is read whole at once.
 *
 * The tree is kept as its frontier: the nodes known and not yet read, in
 * chunk order (each with the grid number of its first chunk), leaves and
 * internal nodes alike; reading an internal node replaces it with its
 * children.
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
  const place = (table, nodes) => {
    for (const node of nodes) {
      for (const { keyOffset, child } of node.entries) {
        const { linear, key } = keyLinear(node.bytes, keyOffset);
        if (linear >= 0) table.put(linear, child, key.size, key.mask);
      }
    }
  };
  /** Every leaf below `nodes` (read level by level), placed in `table`. */
  const readWhole = async (nodes, table, through = file, readSignal = signal) => {
    let level = nodes;
    while (level.length > 0) {
      visit(level);
      const read = await readBtreeV1Nodes(through, level, 1, { rank, signal: readSignal });
      place(table, read.filter(node => node.level === 0));
      level = read.filter(node => node.level > 0).flatMap(node => node.entries.map(({ child }) => ({ address: child, level: node.level - 1 })));
    }
  };
  /** A node's children as frontier entries, in order; null when their keys cannot be placed on the grid in order. */
  const childrenOf = (node, from) => {
    const children = [];
    for (const { keyOffset, child } of node.entries) {
      const { linear, key } = keyLinear(node.bytes, keyOffset);
      if (linear < from || (children.length > 0 && linear < children[children.length - 1].start)) return null;
      children.push({ address: child, level: node.level - 1, start: linear, firstSize: key.size, placed: false, loading: null, ahead: false, expanding: null });
    }
    return children;
  };

  const [root] = await readBtreeV1Nodes(file, [{ address: layout.address, level: null }], 1, { rank, signal });
  visit([root]);
  const table = denseTable(grid, gridCount);
  if (root.level === 0) {
    // The root is a leaf: the table is complete.
    const entries = [];
    for (const { keyOffset, child } of root.entries) {
      const { linear, key } = keyLinear(root.bytes, keyOffset);
      if (linear >= 0) entries.push([linear, child, key.size, key.mask]);
    }
    return tableFromEntries(grid, gridCount, entries);
  }
  const leafCapacity = 2 * file.btreeK.chunk;
  /** @type {Array<{address: number, level: number, start: number, firstSize: number, placed: boolean, loading: SharedWork|null, ahead: boolean, expanding: SharedWork|null}>} */
  let frontier = childrenOf(root, 0);
  // The chunks the tree can index at most (every node full).
  const most = root.entries.length * leafCapacity ** root.level;
  if (frontier === null || gridCount > Math.max(1024, 4 * most)) {
    const entries = [];
    await readWhole(root.entries.map(({ child }) => ({ address: child, level: root.level - 1 })), {
      put: (linear, address, size, mask) => entries.push([linear, address, size, mask]),
    });
    return tableFromEntries(grid, gridCount, entries);
  }
  visit(frontier);

  // A node's size on disk, whatever its level: its header and 2K + 1 keys
  // (a chunk size, a filter mask and rank + 1 offsets) around 2K child addresses.
  const nodeBytes = 24 + (2 * file.btreeK.chunk + 1) * (8 + 8 * (rank + 1)) + 2 * file.btreeK.chunk * file.offsetSize;
  /**
   * Whether `count` nodes transfer in less time than a round trip of the link
   * and go out in one wave of background requests: then reading them now
   * costs a reader of the table nothing it would notice, and saves every
   * later read a round trip (the rule leaves are read ahead by, below).
   */
  const oneWave = count => count > 0 && count * nodeBytes <= roundTripBytes(file) && count <= (file.reader?.link?.backgroundConcurrency ?? 0);
  // The levels below the root are read now while a level is one wave: a
  // small tree is then known down to its leaves (its later reads wait for a
  // leaf alone), a large one stops at the first level that is not (the
  // 552 parents of 35,000 leaves).
  for (let internal = frontier; internal.length > 0 && internal.every(entry => entry.level > 0) && oneWave(internal.length);) {
    const nodes = await readBtreeV1Nodes(file, internal.map(entry => ({ address: entry.address, level: entry.level })), 1, { rank, signal });
    const next = [];
    for (let k = 0; k < nodes.length; k++) {
      const children = childrenOf(nodes[k], internal[k].start);
      if (children !== null) {
        visit(children);
        next.push(...children);
        continue;
      }
      // Children that cannot be placed in order: that subtree is read whole.
      await readWhole(nodes[k].entries.map(({ child }) => ({ address: child, level: nodes[k].level - 1 })), table, file, signal);
      next.push({ ...internal[k], level: 0, placed: true });
    }
    frontier = next;
    internal = frontier;
  }
  /** The frontier entry holding chunk `linear` (the first one for a chunk before it). */
  const entryAt = linear => {
    let low = 0;
    let high = frontier.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (frontier[middle].start <= linear) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  /** The frontier entries holding chunks `first..last`, as `[low, high]` positions. */
  const spanOf = (first, last) => {
    const low = entryAt(first);
    let high = low;
    while (high + 1 < frontier.length && frontier[high + 1].start <= last) high++;
    return [low, high];
  };
  /**
   * Read internal nodes `entries` through `through` (the file as a read sees
   * it), shared by every read waiting for them, and put their children in
   * their place. A subtree whose children cannot be placed in order is read
   * whole and placed, and stands in the frontier as one leaf read.
   */
  const expand = (entries, through) => {
    const fresh = entries.filter(entry => entry.expanding === null || entry.expanding.abandoned);
    if (fresh.length > 0) {
      const work = new SharedWork(async nodeSignal => {
        const nodes = await readBtreeV1Nodes(through, fresh.map(entry => ({ address: entry.address, level: entry.level })), 1, { rank, signal: nodeSignal });
        const replaced = new Map();
        for (let k = 0; k < nodes.length; k++) {
          const children = childrenOf(nodes[k], fresh[k].start);
          if (children !== null) {
            visit(children);
            replaced.set(fresh[k], children);
            continue;
          }
          await readWhole(nodes[k].entries.map(({ child }) => ({ address: child, level: nodes[k].level - 1 })), table, through, nodeSignal);
          replaced.set(fresh[k], [{ ...fresh[k], level: 0, placed: true, expanding: null }]);
        }
        frontier = frontier.flatMap(entry => replaced.get(entry) ?? [entry]);
      });
      for (const entry of fresh) entry.expanding = work;
    }
    return entries.map(entry => entry.expanding);
  };
  /** Whether frontier entry `entry`, a leaf, is being read, or was, for reads that may still wait for it. */
  const asked = entry => entry.loading !== null && !entry.loading.abandoned;
  table.covered = (first, last) => {
    const [low, high] = spanOf(first, last);
    for (let i = low; i <= high; i++) if (frontier[i].level > 0 || !frontier[i].placed) return false;
    return true;
  };
  /**
   * A chunk's stored size without reading more of the index: once its leaf
   * is read, its entry's (0 when it was never written); before, the size of
   * the first chunk below the deepest node read above it, which that node's
   * key holds. What a whole dataset stores is then known from the root
   * alone (one key for each of its children; the chunks of one dataset
   * compress alike), not from a request for every node.
   */
  table.storedSizeOf = linear => {
    const slot = table.find(linear);
    if (slot >= 0) return table.size[slot];
    const entry = frontier[entryAt(linear)];
    return entry.level === 0 && entry.placed ? 0 : entry.firstSize;
  };
  /**
   * The index reads a read of chunk runs `runs` (`[first, last]` grid
   * numbers) would make before its chunks: `nodes`, the nodes neither read
   * nor being read on the paths to them, each counted once however many
   * runs share it (a gene sample's blocks a few chunks apart share their
   * level-1 node and often their leaf); `steps`, those nodes level by level
   * from the top, each level a round trip after the one above (a node, then
   * its child, down to the leaves); `levels`, how many.
   * Below a node not read yet, a leaf is taken to address `2K` chunks and a
   * node of level `l` `(2K)^l`: a price, not a promise
   * (`subsample-plan.js` `firstGeneReadCost`).
   */
  table.indexReadsFor = runs => {
    const seen = new Set();
    // Nodes by tree level (0: leaves): each level a round trip after the one above.
    const byLevel = [];
    const add = (key, level) => {
      if (seen.has(key)) return;
      seen.add(key);
      while (byLevel.length <= level) byLevel.push(0);
      byLevel[level]++;
    };
    for (const [first, last] of runs) {
      if (last < first) continue;
      const [low, high] = spanOf(first, last);
      for (let i = low; i <= high; i++) {
        const entry = frontier[i];
        if (entry.level === 0) {
          if (!entry.placed && !asked(entry)) add(`${i}`, 0);
          continue;
        }
        if (entry.expanding !== null && !entry.expanding.abandoned) continue;
        const from = Math.max(first, entry.start) - entry.start;
        const to = Math.min(last, i + 1 < frontier.length ? frontier[i + 1].start - 1 : last) - entry.start;
        if (to < from) continue;
        add(`${i}:${entry.level}`, entry.level);
        for (let level = 0, span = leafCapacity; level < entry.level; level++, span *= leafCapacity) {
          for (let node = Math.floor(from / span); node <= Math.floor(to / span); node++) add(`${i}:${level}:${node}`, level);
        }
      }
    }
    // The round trips from the top: the highest level first, the leaves last.
    const steps = byLevel.slice().reverse().filter(count => count > 0);
    return { nodes: seen.size, levels: steps.length, steps };
  };
  /** Where the reads of this table have reached in chunk order (the first chunk of the last leaf a read covered), or -1. */
  let scanEnd = -1;
  /**
   * Read leaves `entries` through `through` (the file as a read sees it);
   * `unwaited`: read ahead of need, to the end whether or not a read comes
   * to wait for it.
   */
  const readLeavesThrough = (entries, through, background = false, unwaited = false) => {
    const read = new SharedWork(leafSignal => readBtreeV1Nodes(through, entries.map(entry => ({ address: entry.address, level: 0 })), 1, { rank, signal: leafSignal })
      .then(nodes => {
        // A leaf read twice (ahead, then for a read) is placed once.
        place(table, nodes.filter((node, k) => !entries[k].placed));
        for (const entry of entries) entry.placed = true;
      }));
    if (unwaited) read.hold();
    for (const entry of entries) {
      entry.loading = read;
      entry.ahead = background;
    }
    read.promise.catch(() => {
      // A failed read is asked for again by the next read that needs it.
      for (const entry of entries) if (entry.loading === read) entry.loading = null;
    });
  };
  /**
   * Read every node not read yet whose bytes this browser holds already
   * (`held(start, end)`: kept parts of the file, `io/kept-parts.js`, or the
   * reader's cache), internal nodes first, level by level: a read of this
   * machine's disk, never a request. What a read of chunks would fetch is
   * then known exactly where an earlier reading of the file kept its index
   * (`read-plan.js` `storedBytes` `toFetch`). Resolves once they are placed;
   * never rejects.
   */
  table.coverHeld = async held => {
    const isHeld = entry => held(entry.address, entry.address + nodeBytes);
    for (;;) {
      const internal = frontier.filter(entry => entry.level > 0 && entry.expanding === null && isHeld(entry));
      if (internal.length === 0) break;
      try {
        await Promise.all(expand(internal, file).map(work => work.join()));
      } catch {
        break;
      }
    }
    const leaves = frontier.filter(entry => entry.level === 0 && !entry.placed && !asked(entry) && isHeld(entry));
    if (leaves.length === 0) return;
    readLeavesThrough(leaves, file);
    await Promise.all(leaves.map(entry => entry.loading.promise)).catch(() => {});
  };
  /**
   * Read the nodes holding chunks `first..last` (grid numbers) that are not
   * read yet, through `reader` (the file as the read sees it), waiting with
   * `signal`: the internal nodes above them a level at a time, then their
   * leaves, all at once. A node read is shared by every read waiting for it
   * (`SharedWork`): it stops only once every one of them withdrew, and is
   * read again by the next read that needs it.
   */
  table.cover = (first, last, reader = file, signal = null) => {
    const [spanLow, spanHigh] = spanOf(first, last);
    const internal = [];
    for (let i = spanLow; i <= spanHigh; i++) if (frontier[i].level > 0) internal.push(frontier[i]);
    if (internal.length > 0) {
      const works = [...new Set(expand(internal, reader))];
      return Promise.all(works.map(work => work.join(signal))).then(() => table.cover(first, last, reader, signal));
    }
    /** Read leaves for this read (`readLeavesThrough`), through `reader` unless said. */
    const readLeaves = (entries, through = reader, background = false, unwaited = false) => readLeavesThrough(entries, through, background, unwaited);
    const low = spanLow;
    const high = spanHigh;
    // A leaf wanted now: not read yet, or, for a read a view waits for,
    // being read ahead in the background (which it must not wait behind: it
    // is read again in the read's own right, a request of a few kilobytes).
    // Background work waits for a leaf read ahead, never asks for it twice.
    const wanted = [];
    for (let i = low; i <= high; i++) {
      const entry = frontier[i];
      if (!entry.placed && (!asked(entry) || (entry.ahead && reader.background !== true))) wanted.push(entry);
    }
    if (wanted.length > 0) {
      readLeaves(wanted);
      // Every other leaf known and not read yet follows, unwaited for, when
      // all of them transfer in less time than a round trip of the link and
      // go out in one wave of background requests (the link's background
      // concurrency: over HTTP/1.1 more would hold five of six connections
      // for many round trips): later reads of other chunks then wait for no
      // index (a gene is one round trip, not two). They are read as
      // background work, so a read a view waits for (the next gene's chunks)
      // is never queued behind them; a read that needs one of them before it
      // lands reads it in its own right. They are asked for in the task the
      // needed leaves land in, with the chunks of the reads that waited for
      // those leaves alone: the byte reader plans every read of a task
      // together and starts the ones a view waits for first, the same on
      // every engine and machine (a timer let them go before those chunks or
      // after them, as its delay and the machine's speed fell).
      const needed = Promise.all(wanted.map(entry => entry.loading.promise));
      needed.then(() => {
        if (frontier.some(entry => entry.level > 0)) return;
        const unread = frontier.filter(entry => !entry.placed && !asked(entry));
        // One read per leaf (planned together, so fetched together): a later
        // read waits for its own leaf, not for all of them.
        const link = file.reader?.link;
        if (unread.length > 0 && unread.length * nodeBytes <= roundTripBytes(file) &&
            unread.length <= (link?.backgroundConcurrency ?? 0)) {
          const through = file.withActivity(new ReadActivity({ kind: 'index', label: 'chunk index leaves, read ahead', background: true }));
          for (const entry of unread) readLeaves([entry], through, true, true);
        }
      }, () => {});
    }
    const leafReads = new Set();
    for (let i = low; i <= high; i++) if (!frontier[i].placed) leafReads.add(frontier[i].loading);
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
    // of a gene-major matrix) reads nothing ahead. Leaves under an internal
    // node not read yet are not read ahead (the node is a round trip first).
    const scanned = scanEnd < 0 ? -1 : entryAt(scanEnd);
    if (scanned >= 0 && low <= scanned + 1 && high > scanned) {
      const count = high - low + 1;
      for (let i = high + 1; i < frontier.length && i <= high + count && frontier[i].level === 0; i++) {
        if (!frontier[i].placed && !asked(frontier[i])) readLeaves([frontier[i]], reader, false, true);
      }
    }
    // A read within what was covered leaves the scan where it was.
    if (scanned < 0 || low > scanned + 1 || high > scanned) scanEnd = frontier[high].start;
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
 * What one round trip to the file is worth in bytes (`roundTripBytesOf`:
 * measured on its link, else a merge gap per request that runs at once).
 */
function roundTripBytes(file) {
  return roundTripBytesOf(file.reader?.link ?? null);
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
