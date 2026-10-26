/**
 * Version 1 B-trees ("TREE") and the symbol table nodes ("SNOD") they lead
 * to.
 *
 * Older-format files index a group's links (node type 0, leaves pointing at
 * symbol table nodes) and a chunked dataset's chunks (node type 1, leaves
 * pointing at chunks) with them. A tree is read level by level, all nodes of
 * a level fetched together: whole (`walkBtreeV1`), or a chunk tree down to
 * its leaves' parents, its leaves read as their chunks are needed
 * (`chunk-index.js`).
 *
 * A node's allocated size depends on the tree's 'K' (from the superblock);
 * only the entries in use are parsed, and a node whose entries do not fit
 * the size expected is simply read again at its real size.
 *
 * @module formats/hdf5/btree-v1
 */

import { readUintLE } from './binary.js';
import { formatError } from './errors.js';

/**
 * Read and parse one level of v1 B-tree nodes, all at once: each node's
 * level and its entries (the offset of each entry's left key in the node's
 * bytes, and its child's address). A node's `level` is checked when the
 * parent said what it should be.
 *
 * @param {import('./context.js').FileContext} file
 * @param {Array<{address: number, level: number|null}>} nodes
 * @param {0|1} nodeType
 * @param {{rank?: number, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Array<{address: number, level: number, bytes: Uint8Array, entries: Array<{keyOffset: number, child: number}>, endKeyOffset: number}>>}
 */
export async function readBtreeV1Nodes(file, nodes, nodeType, { rank = 0, signal = null } = {}) {
  const O = file.offsetSize;
  const keySize = nodeType === 0 ? file.lengthSize : 8 + 8 * (rank + 1);
  const K = nodeType === 0 ? file.btreeK.groupInternal : file.btreeK.chunk;
  const fullSize = 8 + 2 * O + 2 * K * O + (2 * K + 1) * keySize;
  const what = nodeType === 0 ? 'Group B-tree node' : 'Chunk B-tree node';
  // A chunk tree's nodes lie among the chunks they index: read exactly, not
  // as cached blocks that would be mostly chunk bytes.
  const readUpTo = nodeType === 0 ? file.metaUpTo.bind(file) : file.dataUpTo.bind(file);
  const readExactly = nodeType === 0 ? file.meta.bind(file) : file.data.bind(file);
  const read = await Promise.all(nodes.map(async node => {
    let bytes = await readUpTo(node.address, fullSize, what, signal);
    const used = bytes.length >= 8 ? bytes[6] | (bytes[7] << 8) : 0;
    const needed = 8 + 2 * O + used * O + (used + 1) * keySize;
    if (needed > bytes.length) bytes = await readExactly(node.address, needed, what, signal);
    return bytes;
  }));
  return nodes.map((node, index) => {
    const bytes = read[index];
    const cursor = file.cursor(bytes, node.address, what);
    cursor.signature('TREE');
    const type = cursor.u8();
    if (type !== nodeType) throw cursor.error(`node type ${type} where type ${nodeType} was expected`);
    const level = cursor.u8();
    const used = cursor.u16();
    if (node.level !== null && level !== node.level) {
      throw cursor.error(`node level ${level} where level ${node.level} was expected`);
    }
    cursor.skip(2 * O); // siblings
    const entries = [];
    for (let i = 0; i < used; i++) {
      const keyOffset = cursor.position;
      cursor.skip(keySize);
      const child = cursor.address();
      if (child === null) throw cursor.error(`child ${i} has an undefined address`);
      entries.push({ keyOffset, child });
    }
    return { address: node.address, level, bytes, entries, endKeyOffset: cursor.position };
  });
}

/**
 * Visit every leaf entry of the v1 B-tree at `address`. Every caller wants
 * every leaf entry, so the tree is read level by level, all nodes of a level
 * fetched together.
 *
 * For node type 1 (chunks), `onEntry(bytes, keyOffset, childAddress)` gets
 * the node bytes with the offset of the entry's left key (chunk size, filter
 * mask, chunk offsets). For type 0 (groups) it gets the symbol table node
 * address as `childAddress`.
 *
 * @param {import('./context.js').FileContext} file
 * @param {number} address
 * @param {0|1} nodeType
 * @param {(bytes: Uint8Array, keyOffset: number, childAddress: number) => void} onEntry
 * @param {{rank?: number, signal?: AbortSignal|null}} [options] - `rank`: dataset rank for chunk trees
 */
export async function walkBtreeV1(file, address, nodeType, onEntry, { rank = 0, signal = null } = {}) {
  const what = nodeType === 0 ? 'Group B-tree node' : 'Chunk B-tree node';
  let level = [{ address, level: null }];
  const seen = new Set();
  while (level.length > 0) {
    for (const node of level) {
      if (seen.has(node.address)) throw formatError(what, file.absolute(node.address), 'it is reached twice; the tree is corrupt');
      seen.add(node.address);
    }
    const nodes = await readBtreeV1Nodes(file, level, nodeType, { rank, signal });
    const next = [];
    for (const node of nodes) {
      for (const { keyOffset, child } of node.entries) {
        if (node.level > 0) next.push({ address: child, level: node.level - 1 });
        else onEntry(node.bytes, keyOffset, child);
      }
    }
    level = next;
  }
}

/**
 * Read symbol table nodes, all together; calls `onSymbol` for each entry
 * with (nameOffset, objectAddress, cacheType, scratch view).
 */
export async function readSymbolNodes(file, addresses, onSymbol, signal = null) {
  const O = file.offsetSize;
  const entrySize = 2 * O + 8 + 16;
  const fullSize = 8 + 2 * file.btreeK.groupLeaf * entrySize;
  const what = 'Symbol table node';
  const nodes = await Promise.all(addresses.map(async address => {
    let bytes = await file.metaUpTo(address, fullSize, what, signal);
    const count = bytes.length >= 8 ? bytes[6] | (bytes[7] << 8) : 0;
    if (8 + count * entrySize > bytes.length) bytes = await file.meta(address, 8 + count * entrySize, what, signal);
    return bytes;
  }));
  addresses.forEach((address, index) => {
    const bytes = nodes[index];
    const cursor = file.cursor(bytes, address, what);
    cursor.signature('SNOD');
    const version = cursor.u8();
    if (version !== 1) throw cursor.error(`version ${version} is unknown`);
    cursor.skip(1);
    const count = cursor.u16();
    for (let i = 0; i < count; i++) {
      const nameOffset = cursor.uint(O);
      const objectAddress = cursor.address();
      const cacheType = cursor.u32();
      cursor.skip(4);
      const scratch = cursor.take(16);
      onSymbol(nameOffset, objectAddress, cacheType, scratch);
    }
  });
}

/** Chunk key fields at `offset` of a chunk B-tree node. */
export function readChunkKey(bytes, offset, rank, fail) {
  const size = readUintLE(bytes, offset, 4, fail);
  const mask = readUintLE(bytes, offset + 4, 4, fail);
  const coords = new Array(rank);
  for (let d = 0; d < rank; d++) coords[d] = readUintLE(bytes, offset + 8 + 8 * d, 8, fail);
  return { size, mask, coords };
}
