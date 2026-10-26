/**
 * The extensible array chunk index ("EAHD" / "EAIB" / "EASB" / "EADB").
 *
 * Datasets with one unlimited dimension in the newer format index their
 * chunks with an extensible array: an index block holding the first few
 * entries and the addresses of the first data blocks and of super blocks
 * ("secondary blocks"), which hold the addresses of further data blocks.
 * Data blocks double in size every second super block; data blocks larger
 * than a page are split into pages laid out after them, with a bitmap of
 * written pages in their secondary block.
 *
 * The geometry follows the library (`H5EA__hdr_init`): with `m` the minimum
 * data block elements, super block `u` holds `2^floor(u/2)` data blocks of
 * `2^floor((u+1)/2) * m` entries; there are `1 + maxBits - log2(m)` super
 * blocks; the index block addresses the data blocks of the first
 * `2 log2(minPointers)` super blocks directly.
 *
 * The whole array is read level by level: header, index block, secondary
 * blocks with the directly addressed data blocks, then the remaining data
 * blocks (each with its pages in one request).
 *
 * @module formats/hdf5/extensible-array
 */

import { log2Exact, readUintLE } from './binary.js';
import { formatError } from './errors.js';

/**
 * Visit every allocated entry: `onEntry(index, address, size, mask)`.
 *
 * @param {import('./context.js').FileContext} file
 * @param {number} address - Extensible array header
 * @param {{filtered: boolean, chunkBytes: number}} chunking
 */
export async function readExtensibleArray(file, address, { filtered, chunkBytes }, onEntry, signal = null) {
  const O = file.offsetSize;
  const L = file.lengthSize;
  const what = 'Extensible array header';
  const headerBytes = await file.meta(address, 4 + 8 + 6 * L + O + 4, what, signal);
  const header = file.cursor(headerBytes, address, what);
  header.signature('EAHD');
  if (header.u8() !== 0) throw header.error('its version is unknown');
  const client = header.u8();
  const entrySize = header.u8();
  const maxBits = header.u8();
  const indexElements = header.u8();
  const minElements = header.u8();
  const minPointers = header.u8();
  const pageBits = header.u8();
  header.skip(6 * L);
  const indexBlock = header.address();
  file.checkChecksum(headerBytes, address, what);
  if (client !== (filtered ? 1 : 0)) throw header.error(`client ${client} does not match a ${filtered ? '' : 'non-'}filtered dataset`);
  const log2Min = log2Exact(minElements);
  const log2Pointers = log2Exact(minPointers);
  if (log2Min < 0 || log2Pointers < 0 || maxBits < log2Min) throw header.error('its block sizes are not powers of two');
  if (indexBlock === null) return;

  const superBlocks = 1 + maxBits - log2Min;
  const arrayOffsetBytes = Math.ceil(maxBits / 8);
  const pageElements = 2 ** pageBits;
  const fail = problem => {
    throw formatError('Extensible array', file.absolute(address), problem);
  };
  const sizeBytes = entrySize - O - 4;
  const readEntries = (bytes, start, first, count) => {
    for (let i = 0; i < count; i++) {
      const at = start + i * entrySize;
      const chunkAddress = readUintLE(bytes, at, O, fail);
      if (chunkAddress === null) continue;
      if (filtered) onEntry(first + i, chunkAddress, readUintLE(bytes, at + O, sizeBytes, fail), readUintLE(bytes, at + O + sizeBytes, 4, fail));
      else onEntry(first + i, chunkAddress, chunkBytes, 0);
    }
  };
  // Super block u: data block count, entries per data block, first entry.
  const blocksIn = u => 2 ** Math.floor(u / 2);
  const entriesPerBlock = u => 2 ** Math.floor((u + 1) / 2) * minElements;
  const firstEntry = u => indexElements + minElements * (2 ** u - 1);

  // Index block.
  const directBlocks = 2 * (minPointers - 1);
  const directSuperBlocks = 2 * log2Pointers;
  const indirectSuperBlocks = Math.max(0, superBlocks - directSuperBlocks);
  const indexWhat = 'Extensible array index block';
  const indexSize = 4 + 1 + 1 + O + indexElements * entrySize + directBlocks * O + indirectSuperBlocks * O + 4;
  const indexBytes = await file.meta(indexBlock, indexSize, indexWhat, signal);
  const index = file.cursor(indexBytes, indexBlock, indexWhat);
  index.signature('EAIB');
  if (index.u8() !== 0) throw index.error('its version is unknown');
  if (index.u8() !== client) throw index.error('its client differs from the header\'s');
  if (index.address() !== address) throw index.error('it belongs to another extensible array');
  readEntries(indexBytes, index.position, 0, indexElements);
  index.skip(indexElements * entrySize);
  file.checkChecksum(indexBytes, indexBlock, indexWhat);

  /** Data blocks to read: {address, first entry, entries, page bitmap or null}. */
  const dataBlocks = [];
  let u = 0;
  let inSuper = 0;
  for (let i = 0; i < directBlocks; i++) {
    const blockAddress = index.address();
    if (blockAddress !== null) {
      dataBlocks.push({ address: blockAddress, first: firstEntry(u) + inSuper * entriesPerBlock(u), entries: entriesPerBlock(u), pages: null });
    }
    if (++inSuper === blocksIn(u)) {
      u++;
      inSuper = 0;
    }
  }
  const secondary = [];
  for (let s = 0; s < indirectSuperBlocks; s++) {
    const blockAddress = index.address();
    if (blockAddress !== null) secondary.push({ address: blockAddress, u: directSuperBlocks + s });
  }

  // Secondary blocks.
  const secondaryWhat = 'Extensible array secondary block';
  const secondaryBytes = await Promise.all(secondary.map(block => {
    const entries = entriesPerBlock(block.u);
    const pagesPerBlock = entries > pageElements ? entries / pageElements : 0;
    block.pagesPerBlock = pagesPerBlock;
    // One page bitmap per data block, each a whole number of bytes.
    block.bitmapBytes = pagesPerBlock > 0 ? Math.ceil(pagesPerBlock / 8) : 0;
    const size = 4 + 1 + 1 + O + arrayOffsetBytes + (block.bitmapBytes + O) * blocksIn(block.u) + 4;
    // Secondary and data blocks lie among the chunks: read exactly, not as cached blocks.
    return file.data(block.address, size, secondaryWhat, signal);
  }));
  secondary.forEach((block, i) => {
    const bytes = secondaryBytes[i];
    const cursor = file.cursor(bytes, block.address, secondaryWhat);
    cursor.signature('EASB');
    if (cursor.u8() !== 0) throw cursor.error('its version is unknown');
    if (cursor.u8() !== client) throw cursor.error('its client differs from the header\'s');
    if (cursor.address() !== address) throw cursor.error('it belongs to another extensible array');
    cursor.skip(arrayOffsetBytes);
    const bitmap = cursor.take(block.bitmapBytes * blocksIn(block.u));
    const entries = entriesPerBlock(block.u);
    for (let d = 0; d < blocksIn(block.u); d++) {
      const blockAddress = cursor.address();
      if (blockAddress === null) continue;
      let pages = null;
      if (block.pagesPerBlock > 0) {
        pages = new Uint8Array(block.pagesPerBlock);
        for (let p = 0; p < block.pagesPerBlock; p++) {
          // Bits are numbered across data blocks, though each block is
          // allotted whole bytes (as the library does).
          const bit = d * block.pagesPerBlock + p;
          pages[p] = bitmap[bit >> 3] & (0x80 >> (bit & 7)) ? 1 : 0;
        }
      }
      dataBlocks.push({ address: blockAddress, first: firstEntry(block.u) + d * entries, entries, pages });
    }
    file.checkChecksum(bytes, block.address, secondaryWhat);
  });

  // Data blocks, each with its pages in one request.
  const dataWhat = 'Extensible array data block';
  const blockBytes = await Promise.all(dataBlocks.map(block => {
    const prefix = 4 + 1 + 1 + O + arrayOffsetBytes;
    const paged = block.entries > pageElements;
    const size = paged
      ? prefix + 4 + (block.entries / pageElements) * (pageElements * entrySize + 4)
      : prefix + block.entries * entrySize + 4;
    return file.data(block.address, size, dataWhat, signal);
  }));
  dataBlocks.forEach((block, i) => {
    const bytes = blockBytes[i];
    const cursor = file.cursor(bytes, block.address, dataWhat);
    cursor.signature('EADB');
    if (cursor.u8() !== 0) throw cursor.error('its version is unknown');
    if (cursor.u8() !== client) throw cursor.error('its client differs from the header\'s');
    if (cursor.address() !== address) throw cursor.error('it belongs to another extensible array');
    cursor.skip(arrayOffsetBytes);
    const prefix = cursor.position;
    if (block.entries <= pageElements) {
      file.checkChecksum(bytes, block.address, dataWhat);
      readEntries(bytes, prefix, block.first, block.entries);
      return;
    }
    file.checkChecksum(bytes.subarray(0, prefix + 4), block.address, dataWhat);
    const pageCount = block.entries / pageElements;
    const pageSize = pageElements * entrySize + 4;
    for (let p = 0; p < pageCount; p++) {
      // Pages of a data block addressed from the index block have no bitmap.
      if (block.pages !== null && !block.pages[p]) continue;
      const start = prefix + 4 + p * pageSize;
      file.checkChecksum(bytes.subarray(start, start + pageSize), block.address + start, 'Extensible array data block page');
      readEntries(bytes, start, block.first + p * pageElements, pageElements);
    }
  });
}
