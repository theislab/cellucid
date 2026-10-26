/**
 * The fixed array chunk index ("FAHD" / "FADB").
 *
 * Datasets with a fixed maximum shape in the newer format index their chunks
 * with one array of entries (chunk address, plus size and filter mask when
 * filtered), one per chunk of the maximum shape. Large arrays are split into
 * pages laid out right after the data block, with a bitmap of which pages
 * were ever written. The header, the data block and all its pages are read
 * in three round trips whatever the number of chunks.
 *
 * @module formats/hdf5/fixed-array
 */

import { readUintLE } from './binary.js';
import { formatError } from './errors.js';

/**
 * Visit every allocated entry: `onEntry(index, address, size, mask)`, where
 * `index` is the chunk's position in the array (row-major over the maximum
 * shape's chunk grid).
 *
 * @param {import('./context.js').FileContext} file
 * @param {number} address - Fixed array header
 * @param {{filtered: boolean, chunkBytes: number}} chunking
 */
export async function readFixedArray(file, address, { filtered, chunkBytes }, onEntry, signal = null) {
  const O = file.offsetSize;
  const L = file.lengthSize;
  const what = 'Fixed array header';
  const headerBytes = await file.meta(address, 4 + 4 + L + O + 4, what, signal);
  const header = file.cursor(headerBytes, address, what);
  header.signature('FAHD');
  const version = header.u8();
  if (version !== 0) throw header.error(`version ${version} is unknown`);
  const client = header.u8();
  const entrySize = header.u8();
  const pageBits = header.u8();
  const maxEntries = header.length();
  const dataBlock = header.address();
  file.checkChecksum(headerBytes, address, what);
  if (client !== (filtered ? 1 : 0)) throw header.error(`client ${client} does not match a ${filtered ? '' : 'non-'}filtered dataset`);
  const expectedEntry = filtered ? null : O;
  if ((expectedEntry !== null && entrySize !== expectedEntry) || (filtered && entrySize <= O + 4)) {
    throw header.error(`entry size ${entrySize} does not fit a chunk address`);
  }
  if (dataBlock === null || maxEntries === 0) return;

  const pageEntries = 2 ** pageBits;
  const paged = maxEntries > pageEntries;
  const pageCount = paged ? Math.ceil(maxEntries / pageEntries) : 0;
  const bitmapBytes = paged ? Math.ceil(pageCount / 8) : 0;
  const prefix = 4 + 1 + 1 + O + bitmapBytes;
  const blockWhat = 'Fixed array data block';
  const blockSize = prefix + (paged ? 0 : maxEntries * entrySize) + 4;
  // A paged block is followed by its pages: read them in the same request,
  // exactly (the block can be large; it is read once, into the chunk table).
  const pagesSize = paged ? maxEntries * entrySize + pageCount * 4 : 0;
  const bytes = await file.data(dataBlock, blockSize + pagesSize, blockWhat, signal);
  const block = file.cursor(bytes, dataBlock, blockWhat);
  block.signature('FADB');
  if (block.u8() !== 0) throw block.error('its version is unknown');
  if (block.u8() !== client) throw block.error('its client differs from the header\'s');
  const owner = block.address();
  if (owner !== address) throw block.error(`it belongs to the fixed array at ${owner}, not ${address}`);
  file.checkChecksum(bytes.subarray(0, blockSize), dataBlock, blockWhat);

  const fail = problem => {
    throw formatError(blockWhat, file.absolute(dataBlock), problem);
  };
  const sizeBytes = entrySize - O - 4;
  const readEntries = (start, first, count) => {
    for (let i = 0; i < count; i++) {
      const at = start + i * entrySize;
      const chunkAddress = readUintLE(bytes, at, O, fail);
      if (chunkAddress === null) continue;
      if (filtered) {
        onEntry(first + i, chunkAddress, readUintLE(bytes, at + O, sizeBytes, fail), readUintLE(bytes, at + O + sizeBytes, 4, fail));
      } else {
        onEntry(first + i, chunkAddress, chunkBytes, 0);
      }
    }
  };
  if (!paged) {
    readEntries(prefix, 0, maxEntries);
    return;
  }
  const bitmap = bytes.subarray(4 + 1 + 1 + O, prefix);
  let pageStart = blockSize;
  for (let page = 0; page < pageCount; page++) {
    const first = page * pageEntries;
    const count = Math.min(pageEntries, maxEntries - first);
    const pageSize = count * entrySize + 4;
    if (bitmap[page >> 3] & (0x80 >> (page & 7))) {
      file.checkChecksum(bytes.subarray(pageStart, pageStart + pageSize), dataBlock + pageStart, 'Fixed array data block page');
      readEntries(pageStart, first, count);
    }
    pageStart += pageSize;
  }
}
