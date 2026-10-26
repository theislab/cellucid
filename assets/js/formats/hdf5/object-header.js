/**
 * Object headers: the list of messages that says what an object is.
 *
 * Version 1 headers (written by default) have a 16-byte prefix and messages
 * aligned to 8 bytes; version 2 headers ("OHDR", written for the newer
 * format) are packed and end with a checksum. Either may continue in
 * continuation blocks elsewhere in the file; all continuation blocks found in
 * one block are fetched together, so a header costs one round trip per level
 * of continuation, not one per block.
 *
 * Messages come back as views of the fetched bytes; the loader decodes them
 * straight away and keeps only what it decodes.
 *
 * @module formats/hdf5/object-header
 */

import { MESSAGE, parseContinuation } from './messages.js';
import { formatError } from './errors.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * @typedef {Object} HeaderMessage
 * @property {number} type
 * @property {number} flags
 * @property {Uint8Array} data - View of the message data
 * @property {number} address - Relative address of the message data
 * @property {number|null} creationOrder
 */

/**
 * @typedef {Object} ObjectHeader
 * @property {number} address
 * @property {number} version
 * @property {HeaderMessage[]} messages
 * @property {number|null} unknownRequired - A message type the header requires readers to understand
 */

/**
 * Read the object header at `address` with all its continuation blocks.
 *
 * `onFirstBlock(header)` is called as soon as the first block is parsed,
 * before continuation blocks are fetched: a group's symbol table message is
 * usually there, and its links can be asked for in the same round as the
 * continuation blocks.
 *
 * @param {import('./context.js').FileContext} file
 * @param {number} address
 * @param {AbortSignal|null} signal
 * @param {((header: ObjectHeader) => void)|null} [onFirstBlock]
 * @returns {Promise<ObjectHeader>}
 */
export async function readObjectHeader(file, address, signal = null, onFirstBlock = null) {
  const what = 'Object header';
  const prefix = await file.metaUpTo(address, 64, what, signal);
  const header = { address, version: 0, messages: [], unknownRequired: null };
  const continuations = [];
  const isVersion2 = prefix.length >= 4 && prefix[0] === 0x4f && prefix[1] === 0x48 && prefix[2] === 0x44 && prefix[3] === 0x52;
  if (isVersion2) {
    const cursor = file.cursor(prefix, address, what);
    cursor.skip(4);
    const version = cursor.u8();
    if (version !== 2) throw cursor.error(`object header version ${version} is unknown`);
    const flags = cursor.u8();
    if (flags & 0x20) cursor.skip(16);
    if (flags & 0x10) cursor.skip(4);
    const chunkSize = cursor.uint(1 << (flags & 3));
    const start = cursor.position;
    const total = start + chunkSize + 4;
    const bytes = total <= prefix.length ? prefix.subarray(0, total) : await file.meta(address, total, what, signal);
    file.checkChecksum(bytes, address, what);
    header.version = 2;
    header.trackOrder = (flags & 0x04) !== 0;
    parseMessages(file, header, bytes, address, start, start + chunkSize, true, continuations);
  } else {
    const cursor = file.cursor(prefix, address, what);
    const version = cursor.u8();
    if (version !== 1) {
      throw cursor.error(`expected an object header (version 1, or the signature "OHDR"), found version byte ${version}`);
    }
    cursor.skip(1);
    cursor.u16(); // number of messages, continuation messages included
    cursor.u32(); // reference count
    const chunkSize = cursor.u32();
    // Messages start after the 16-byte prefix (12 bytes plus alignment).
    const total = 16 + chunkSize;
    const bytes = total <= prefix.length ? prefix.subarray(0, total) : await file.meta(address, total, what, signal);
    header.version = 1;
    header.trackOrder = false;
    parseMessages(file, header, bytes, address, 16, total, false, continuations);
  }

  onFirstBlock?.(header);

  // Continuation blocks: fetch every block known so far together.
  const seen = new Set([address]);
  while (continuations.length > 0) {
    const batch = continuations.splice(0);
    for (const block of batch) {
      if (seen.has(block.address)) {
        throw formatError(what, file.absolute(address), 'its continuation blocks form a loop');
      }
      seen.add(block.address);
    }
    const blocks = await Promise.all(batch.map(block => file.meta(block.address, block.length, 'Object header continuation block', signal)));
    batch.forEach((block, index) => {
      const bytes = blocks[index];
      if (header.version === 2) {
        const cursor = file.cursor(bytes, block.address, 'Object header continuation block');
        cursor.signature('OCHK');
        file.checkChecksum(bytes, block.address, 'Object header continuation block');
        parseMessages(file, header, bytes, block.address, 4, bytes.length - 4, true, continuations);
      } else {
        parseMessages(file, header, bytes, block.address, 0, bytes.length, false, continuations);
      }
    });
  }
  return header;
}

/**
 * Append the messages in `bytes[start, end)` (a header chunk read from
 * `blockAddress`) to `header.messages`; continuation messages are queued.
 */
function parseMessages(file, header, bytes, blockAddress, start, end, version2, continuations) {
  const what = 'Object header message';
  const prefixSize = version2 ? (header.trackOrder ? 6 : 4) : 8;
  let position = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (end - position >= prefixSize) {
    let type;
    let size;
    let flags;
    let creationOrder = null;
    if (version2) {
      type = bytes[position];
      size = view.getUint16(position + 1, true);
      flags = bytes[position + 3];
      if (header.trackOrder) creationOrder = view.getUint16(position + 4, true);
    } else {
      type = view.getUint16(position, true);
      size = view.getUint16(position + 2, true);
      flags = bytes[position + 4];
    }
    const dataStart = position + prefixSize;
    if (dataStart + size > end) {
      throw formatError(what, file.absolute(blockAddress) + position,
        `message type ${type} of ${formatCountOf(size, 'byte')} runs past the end of its ${end - start}-byte header block`);
    }
    const data = bytes.subarray(dataStart, dataStart + size);
    const address = blockAddress + dataStart;
    if (type === MESSAGE.CONTINUATION) {
      continuations.push(parseContinuation(file.cursor(data, address, 'Continuation message')));
    } else if (type !== MESSAGE.NIL) {
      if (type > MESSAGE.FILE_SPACE_INFO && (flags & 0x80) && header.unknownRequired === null) {
        header.unknownRequired = type;
      }
      header.messages.push({ type, flags, data, address, creationOrder });
    }
    position = dataStart + size;
  }
}
