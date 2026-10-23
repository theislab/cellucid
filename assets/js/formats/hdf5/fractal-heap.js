/**
 * Fractal heaps ("FRHP" / "FHIB" / "FHDB").
 *
 * Newer-format groups with many links, and objects with many or large
 * attributes, keep those links and attribute messages in a fractal heap,
 * addressed by heap IDs found in a v2 B-tree. A heap ID names one of:
 *
 * - a *managed* object: a range of the heap's linear address space, stored
 *   in a direct block reached through a doubling table of indirect blocks;
 * - a *tiny* object: the bytes are inside the ID itself;
 * - a *huge* object: stored on its own in the file, located either by the
 *   address and length inside the ID or through the heap's own v2 B-tree.
 *
 * Opening a heap reads its header and its indirect blocks (level by level),
 * which gives the file address of every direct block. Objects are then read
 * straight from their direct blocks, all at once.
 *
 * @module formats/hdf5/fractal-heap
 */

import { log2Exact, readUintLE } from './binary.js';
import { walkBtreeV2 } from './btree-v2.js';
import { Hdf5UnsupportedError, formatError } from './errors.js';

/**
 * @typedef {Object} FractalHeap
 * @property {number} address
 * @property {number} idLength
 * @property {number} offsetBytes - Bytes of a managed ID's offset
 * @property {number} lengthBytes - Bytes of a managed ID's length
 * @property {Float64Array} blockOffsets - Heap offsets of the direct blocks, ascending
 * @property {Float64Array} blockAddresses
 * @property {Float64Array} blockSizes
 * @property {number|null} hugeBtree
 * @property {boolean} hugeDirect
 * @property {Map<number, {address: number, length: number}>|null} huge
 */

/**
 * Read a fractal heap's header and its block map.
 *
 * @param {import('./context.js').FileContext} file
 * @returns {Promise<FractalHeap>}
 */
export async function openFractalHeap(file, address, signal = null) {
  const what = 'Fractal heap header';
  const O = file.offsetSize;
  const L = file.lengthSize;
  const fixed = 4 + 1 + 2 + 2 + 1 + 4 + L + O + L + O + 8 * L + 2 + L + L + 2 + 2 + O + 2;
  const first = await file.metaUpTo(address, fixed + L + 4 + 4 + 256, what, signal);
  const cursor = file.cursor(first, address, what);
  cursor.signature('FRHP');
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`version ${version} is unknown`);
  const idLength = cursor.u16();
  const filterLength = cursor.u16();
  const flags = cursor.u8();
  const maxManagedSize = cursor.u32();
  cursor.length(); // next huge object ID
  const hugeBtree = cursor.address();
  cursor.length(); // free space in managed blocks
  cursor.address(); // free space manager
  cursor.length(); // managed space
  cursor.length(); // allocated managed space
  cursor.length(); // direct block allocation iterator
  cursor.length(); // managed object count
  cursor.length(); // huge object size
  cursor.length(); // huge object count
  cursor.length(); // tiny object size
  cursor.length(); // tiny object count
  const tableWidth = cursor.u16();
  const startBlockSize = cursor.length();
  const maxDirectBlockSize = cursor.length();
  const maxHeapBits = cursor.u16();
  cursor.u16(); // starting rows of the root indirect block
  const root = cursor.address();
  const rootRows = cursor.u16();
  if (filterLength > 0) {
    throw new Hdf5UnsupportedError('filtered-fractal-heap',
      `${file.name} compresses the heap that stores a group's links or an object's attributes, which this reader does not read.`);
  }
  const headerEnd = cursor.position + 4;
  const bytes = headerEnd <= first.length ? first.subarray(0, headerEnd) : await file.meta(address, headerEnd, what, signal);
  file.checkChecksum(bytes, address, what);
  if (log2Exact(tableWidth) < 0 || log2Exact(startBlockSize) < 0 || log2Exact(maxDirectBlockSize) < 0) {
    throw formatError(what, file.absolute(address), 'its doubling table sizes are not powers of two');
  }

  const offsetBytes = Math.ceil(maxHeapBits / 8);
  const maxDirectOffsetBytes = Math.ceil(log2Exact(maxDirectBlockSize) / 8);
  const managedLimitBytes = Math.floor(Math.log2(Math.max(1, maxManagedSize)) / 8) + 1;
  const heap = {
    address,
    idLength,
    offsetBytes,
    lengthBytes: Math.min(maxDirectOffsetBytes, managedLimitBytes),
    checksummedBlocks: (flags & 2) !== 0,
    tableWidth,
    startBlockSize,
    maxDirectBlockSize,
    maxDirectRows: log2Exact(maxDirectBlockSize) - log2Exact(startBlockSize) + 2,
    hugeBtree,
    hugeDirect: O + L <= idLength - 1,
    huge: null,
    blockOffsets: new Float64Array(0),
    blockAddresses: new Float64Array(0),
    blockSizes: new Float64Array(0),
  };

  // The block map: direct blocks reached from the root.
  const direct = [];
  if (root !== null) {
    if (rootRows === 0) {
      direct.push([0, root, startBlockSize]);
    } else {
      let level = [{ address: root, rows: rootRows, heapOffset: 0 }];
      const seen = new Set();
      while (level.length > 0) {
        for (const block of level) {
          if (seen.has(block.address)) throw formatError('Fractal heap indirect block', file.absolute(block.address), 'it is reached twice; the heap is corrupt');
          seen.add(block.address);
        }
        const blocks = await Promise.all(level.map(block => file.meta(block.address, indirectBlockSize(heap, file, block.rows), 'Fractal heap indirect block', signal)));
        const next = [];
        level.forEach((block, index) => readIndirectBlock(file, heap, block, blocks[index], direct, next));
        level = next;
      }
    }
  }
  direct.sort((a, b) => a[0] - b[0]);
  heap.blockOffsets = Float64Array.from(direct, entry => entry[0]);
  heap.blockAddresses = Float64Array.from(direct, entry => entry[1]);
  heap.blockSizes = Float64Array.from(direct, entry => entry[2]);
  return heap;
}

/** Size of one row's blocks. */
function rowBlockSize(heap, row) {
  return row < 2 ? heap.startBlockSize : heap.startBlockSize * 2 ** (row - 1);
}

function indirectBlockSize(heap, file, rows) {
  const directRows = Math.min(rows, heap.maxDirectRows);
  const indirectRows = Math.max(0, rows - heap.maxDirectRows);
  return 4 + 1 + file.offsetSize + heap.offsetBytes +
    (directRows + indirectRows) * heap.tableWidth * file.offsetSize + 4;
}

function readIndirectBlock(file, heap, block, bytes, direct, next) {
  const what = 'Fractal heap indirect block';
  const cursor = file.cursor(bytes, block.address, what);
  cursor.signature('FHIB');
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`version ${version} is unknown`);
  const owner = cursor.address();
  if (owner !== heap.address) throw cursor.error(`it belongs to the heap at ${owner}, not ${heap.address}`);
  cursor.uint(heap.offsetBytes);
  file.checkChecksum(bytes, block.address, what);
  let rowStart = block.heapOffset;
  for (let row = 0; row < block.rows; row++) {
    const size = rowBlockSize(heap, row);
    for (let column = 0; column < heap.tableWidth; column++) {
      const child = cursor.address();
      const heapOffset = rowStart + column * size;
      if (child === null) continue;
      if (row < heap.maxDirectRows) {
        direct.push([heapOffset, child, size]);
      } else {
        const rows = log2Exact(size) - log2Exact(heap.startBlockSize) + 1;
        next.push({ address: child, rows, heapOffset });
      }
    }
    rowStart += size * heap.tableWidth;
  }
}

/** Load the huge object index (indirectly addressed huge objects). */
async function loadHugeObjects(file, heap, signal) {
  const huge = new Map();
  if (heap.hugeBtree !== null) {
    const O = file.offsetSize;
    const L = file.lengthSize;
    await walkBtreeV2(file, heap.hugeBtree, (bytes, offset, header) => {
      const fail = problem => {
        throw formatError('Huge object record', file.absolute(heap.hugeBtree), problem);
      };
      if (header.type !== 1) {
        throw new Hdf5UnsupportedError('filtered-fractal-heap', `${file.name} stores a compressed huge object in a heap, which this reader does not read.`);
      }
      const address = readUintLE(bytes, offset, O, fail);
      const length = readUintLE(bytes, offset + O, L, fail);
      const id = readUintLE(bytes, offset + O + L, L, fail);
      huge.set(id, { address, length });
    }, { signal, expectType: [1, 2] });
  }
  return huge;
}

/**
 * Read heap objects by ID, all at once. Returns one view per ID.
 *
 * @param {import('./context.js').FileContext} file
 * @param {FractalHeap} heap
 * @param {Uint8Array[]} ids
 * @returns {Promise<Uint8Array[]>}
 */
export async function readHeapObjects(file, heap, ids, signal = null) {
  const what = 'Fractal heap object';
  const needsHuge = !heap.hugeDirect && ids.some(id => ((id[0] >> 4) & 3) === 1);
  if (needsHuge && heap.huge === null) heap.huge = await loadHugeObjects(file, heap, signal);
  const fail = problem => {
    throw formatError(what, file.absolute(heap.address), problem);
  };
  return Promise.all(ids.map(id => {
    const kind = (id[0] >> 4) & 3;
    if ((id[0] >> 6) !== 0) fail(`heap ID version ${id[0] >> 6} is unknown`);
    if (kind === 0) {
      const offset = readUintLE(id, 1, heap.offsetBytes, fail);
      const length = readUintLE(id, 1 + heap.offsetBytes, heap.lengthBytes, fail);
      const block = findBlock(heap.blockOffsets, offset);
      if (block < 0 || offset + length > heap.blockOffsets[block] + heap.blockSizes[block]) {
        fail(`managed object at heap offset ${offset} (${length} bytes) is in no direct block`);
      }
      return file.meta(heap.blockAddresses[block] + (offset - heap.blockOffsets[block]), length, what, signal);
    }
    if (kind === 2) {
      if (heap.idLength <= 18) {
        const length = (id[0] & 0x0f) + 1;
        return Promise.resolve(id.subarray(1, 1 + length));
      }
      const length = (((id[0] & 0x0f) << 8) | id[1]) + 1;
      return Promise.resolve(id.subarray(2, 2 + length));
    }
    if (kind === 1) {
      if (heap.hugeDirect) {
        const address = readUintLE(id, 1, file.offsetSize, fail);
        const length = readUintLE(id, 1 + file.offsetSize, file.lengthSize, fail);
        return file.meta(address, length, what, signal);
      }
      const key = readUintLE(id, 1, Math.min(8, heap.idLength - 1), fail);
      const entry = heap.huge.get(key);
      if (entry === undefined) fail(`huge object ${key} is not in the heap's index`);
      return file.meta(entry.address, entry.length, what, signal);
    }
    return fail(`heap ID type ${kind} is unknown`);
  }));
}

/** Index of the last block starting at or before `offset`, or -1. */
function findBlock(offsets, offset) {
  let low = 0;
  let high = offsets.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
