/**
 * The superblock: where an HDF5 file starts.
 *
 * The superblock is found by its signature at offset 0, 512, 1024, 2048 and
 * so on (a "user block" may come first). It declares the sizes of addresses
 * and lengths, the base all addresses are relative to, and where the root
 * group's object header is. Versions 0 and 1 also carry the B-tree 'K'
 * values; versions 2 and 3 carry a checksum and may point to a superblock
 * extension (an object header holding the 'K' values and the shared message
 * table).
 *
 * @module formats/hdf5/superblock
 */

import { Cursor } from './binary.js';
import { hasValidChecksum } from './checksum.js';
import { Hdf5FormatError, Hdf5UnsupportedError, formatError } from './errors.js';
import { HEAD_BYTES } from '../io/byte-source.js';
import { formatCountOf } from '../../utils/format-units.js';

const SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
/** Where the signature is looked for after offsets 0 to 2048: 4096, 8192 and so on. */
const FIRST_SEARCH_BYTES = 4096;

function hasSignature(bytes, offset) {
  if (offset + 8 > bytes.length) return false;
  for (let i = 0; i < 8; i++) if (bytes[offset + i] !== SIGNATURE[i]) return false;
  return true;
}

/**
 * @typedef {Object} Superblock
 * @property {number} version
 * @property {number} offset - Absolute file offset of the superblock (the base address)
 * @property {number} offsetSize
 * @property {number} lengthSize
 * @property {number|null} rootAddress - Root group object header (relative)
 * @property {{btreeAddress: number|null, heapAddress: number|null}|null} rootSymbolTable - Cached in the root's symbol table entry
 * @property {number|null} extensionAddress
 * @property {number|null} endOfFile - Absolute end-of-file address
 * @property {{groupLeaf: number, groupInternal: number, chunk: number}} btreeK
 */

/**
 * Find and read the superblock.
 *
 * @param {import('../io/byte-reader.js').ByteReader} reader
 * @param {AbortSignal|null} signal
 * @returns {Promise<Superblock>}
 */
export async function readSuperblock(reader, signal = null, activity = null) {
  const options = activity ? { cache: true, signal, activity } : { cache: true, signal };
  const size = reader.size;
  if (size < 8) throw new Hdf5FormatError(`${reader.name} is not an HDF5 file: it is only ${formatCountOf(size, 'byte')} long.`);
  // The first read is the file's head (`HEAD_BYTES`): offsets 0, 512, 1024
  // and 2048, and in a file that gathers its metadata at its start,
  // everything opening reads.
  const head = await reader.read(0, Math.min(size, HEAD_BYTES), options);
  let offset = -1;
  for (const candidate of [0, 512, 1024, 2048]) {
    if (hasSignature(head, candidate)) {
      offset = candidate;
      break;
    }
  }
  for (let candidate = FIRST_SEARCH_BYTES; offset < 0 && candidate + 8 <= size; candidate *= 2) {
    const bytes = await reader.read(candidate, 8, options);
    if (hasSignature(bytes, 0)) offset = candidate;
  }
  if (offset < 0) {
    throw new Hdf5FormatError(`${reader.name} is not an HDF5 file: no HDF5 signature was found.`);
  }
  // The largest superblock (version 0/1 with 8-byte sizes) is under 128 bytes.
  const bytes = offset + 8 < head.length
    ? head.subarray(offset, Math.min(head.length, offset + 256))
    : await reader.read(offset, Math.min(256, size - offset), options);
  const cursor = new Cursor(bytes, { fileOffset: offset, label: 'Superblock' });
  cursor.skip(8);
  const version = cursor.u8();
  if (version > 3) {
    throw new Hdf5UnsupportedError('superblock-version', `${reader.name} uses superblock version ${version}, which this reader does not know.`);
  }
  const btreeK = { groupLeaf: 4, groupInternal: 16, chunk: 32 };
  let offsetSize;
  let lengthSize;
  let rootAddress;
  let extensionAddress = null;
  let rootSymbolTable = null;
  let endOfFile;
  if (version <= 1) {
    cursor.skip(3);
    cursor.u8(); // shared header message format version
    offsetSize = cursor.u8();
    lengthSize = cursor.u8();
    cursor.skip(1);
    btreeK.groupLeaf = cursor.u16();
    btreeK.groupInternal = cursor.u16();
    cursor.skip(4);
    if (version === 1) {
      btreeK.chunk = cursor.u16();
      cursor.skip(2);
    }
    requireSizes(offsetSize, lengthSize, offset);
    cursor.offsetSize = offsetSize;
    cursor.lengthSize = lengthSize;
    cursor.address(); // base address: the superblock's position is used, as the library does
    cursor.address(); // free space info
    endOfFile = cursor.address();
    cursor.address(); // driver info block
    // Root group symbol table entry.
    cursor.address(); // link name offset
    rootAddress = cursor.address();
    // Cache type 1: the root group's B-tree and local heap addresses, so its
    // links can be read in the same round as its object header.
    if (cursor.u32() === 1) {
      cursor.skip(4);
      rootSymbolTable = { btreeAddress: cursor.address(), heapAddress: cursor.address() };
    }
  } else {
    offsetSize = cursor.u8();
    lengthSize = cursor.u8();
    cursor.u8(); // consistency flags
    requireSizes(offsetSize, lengthSize, offset);
    cursor.offsetSize = offsetSize;
    cursor.lengthSize = lengthSize;
    cursor.address(); // base address
    extensionAddress = cursor.address();
    endOfFile = cursor.address();
    rootAddress = cursor.address();
    const checked = bytes.subarray(0, cursor.position + 4);
    if (checked.length < cursor.position + 4 || !hasValidChecksum(checked)) {
      throw formatError('Superblock', offset, 'its checksum does not match; the file is corrupt');
    }
  }
  if (rootAddress === null) throw formatError('Superblock', offset, 'the root group address is undefined');
  // The end-of-file address is absolute (it counts the user block).
  if (endOfFile !== null && endOfFile > size) {
    throw new Hdf5FormatError(
      `${reader.name} is truncated: the superblock says it is ${formatCountOf(endOfFile, 'byte')} long, but it is ${size}.`
    );
  }
  return { version, offset, offsetSize, lengthSize, rootAddress, rootSymbolTable, extensionAddress, endOfFile, btreeK };
}

function requireSizes(offsetSize, lengthSize, offset) {
  for (const [what, value] of [['offsets', offsetSize], ['lengths', lengthSize]]) {
    if (![2, 4, 8].includes(value)) {
      throw formatError('Superblock', offset, `its size of ${what} is ${value}; it must be 2, 4 or 8`);
    }
  }
}
