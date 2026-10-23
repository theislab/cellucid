/**
 * Object header messages: what an object is, decoded from its header.
 *
 * Each function reads one message type's data (every version the format
 * defines) from a cursor over exactly that message, and returns a plain
 * description. Nothing here reads the file; messages that point elsewhere
 * (a link to an object header, a B-tree, a heap) return the addresses for the
 * loader to fetch.
 *
 * @module formats/hdf5/messages
 */

import { decodeText } from './binary.js';

/** Header message type numbers. */
export const MESSAGE = Object.freeze({
  NIL: 0x00,
  DATASPACE: 0x01,
  LINK_INFO: 0x02,
  DATATYPE: 0x03,
  FILL_VALUE_OLD: 0x04,
  FILL_VALUE: 0x05,
  LINK: 0x06,
  EXTERNAL_FILES: 0x07,
  LAYOUT: 0x08,
  BOGUS: 0x09,
  GROUP_INFO: 0x0a,
  FILTER_PIPELINE: 0x0b,
  ATTRIBUTE: 0x0c,
  COMMENT: 0x0d,
  MODIFICATION_TIME_OLD: 0x0e,
  SHARED_MESSAGE_TABLE: 0x0f,
  CONTINUATION: 0x10,
  SYMBOL_TABLE: 0x11,
  MODIFICATION_TIME: 0x12,
  BTREE_K: 0x13,
  DRIVER_INFO: 0x14,
  ATTRIBUTE_INFO: 0x15,
  REFERENCE_COUNT: 0x16,
  FILE_SPACE_INFO: 0x17,
});

/** Message types whose data may be stored shared (in another place). */
export const SHAREABLE = new Set([MESSAGE.DATASPACE, MESSAGE.DATATYPE, MESSAGE.FILL_VALUE, MESSAGE.FILTER_PIPELINE, MESSAGE.ATTRIBUTE]);

/**
 * @typedef {Object} Dataspace
 * @property {'scalar'|'simple'|'null'} kind
 * @property {number[]} dims
 * @property {Array<number|null>} maxDims - `null` for an unlimited dimension
 */

/** @returns {Dataspace} */
export function parseDataspace(cursor) {
  const version = cursor.u8();
  const rank = cursor.u8();
  const flags = cursor.u8();
  let kind;
  if (version === 1) {
    cursor.skip(5);
    kind = rank === 0 ? 'scalar' : 'simple';
  } else if (version === 2) {
    const type = cursor.u8();
    if (type > 2) throw cursor.error(`dataspace type ${type} is unknown`);
    kind = ['scalar', 'simple', 'null'][type];
  } else {
    throw cursor.error(`dataspace message version ${version} is unknown`);
  }
  const dims = [];
  for (let i = 0; i < rank; i++) {
    const extent = cursor.lengthOrUnlimited();
    if (extent === null) throw cursor.error(`dimension ${i} has every bit set`);
    dims.push(extent);
  }
  const maxDims = dims.slice();
  if (flags & 1) {
    for (let i = 0; i < rank; i++) maxDims[i] = cursor.lengthOrUnlimited();
  }
  if (kind === 'null') return { kind, dims: [], maxDims: [] };
  return { kind, dims, maxDims };
}

/** A shared message's pointer: a committed message in another header, or a shared-message heap ID. */
export function parseSharedMessage(cursor) {
  const version = cursor.u8();
  const type = cursor.u8();
  if (version === 1) {
    cursor.skip(6);
    return { kind: 'header', address: cursor.address() };
  }
  if (version === 2) {
    return { kind: 'header', address: cursor.address() };
  }
  if (version === 3) {
    if (type === 1) return { kind: 'heap', heapId: cursor.take(8).slice() };
    if (type === 2) return { kind: 'header', address: cursor.address() };
    throw cursor.error(`shared message type ${type} does not point to a stored message`);
  }
  throw cursor.error(`shared message version ${version} is unknown`);
}

/**
 * @typedef {Object} FillValue
 * @property {boolean} defined
 * @property {Uint8Array|null} bytes - A copy of the value's bytes
 * @property {number} allocationTime - 1 early, 2 late, 3 incremental
 */

/** The "old" fill value message: just the value. */
export function parseFillValueOld(cursor) {
  const size = cursor.u32();
  return { defined: size > 0, bytes: size > 0 ? cursor.take(size).slice() : null, allocationTime: 0 };
}

/** @returns {FillValue} */
export function parseFillValue(cursor) {
  const version = cursor.u8();
  if (version === 1 || version === 2) {
    const allocationTime = cursor.u8();
    cursor.u8(); // write time
    const defined = cursor.u8() === 1;
    if (version === 1 || defined) {
      const size = cursor.u32();
      return { defined: defined && size > 0, bytes: size > 0 ? cursor.take(size).slice() : null, allocationTime };
    }
    return { defined: false, bytes: null, allocationTime };
  }
  if (version === 3) {
    const flags = cursor.u8();
    const allocationTime = flags & 3;
    if (flags & 0x20) {
      const size = cursor.u32();
      return { defined: size > 0, bytes: size > 0 ? cursor.take(size).slice() : null, allocationTime };
    }
    return { defined: false, bytes: null, allocationTime };
  }
  throw cursor.error(`fill value message version ${version} is unknown`);
}

/**
 * @typedef {Object} Link
 * @property {string} name
 * @property {'hard'|'soft'|'external'|'user'} type
 * @property {number|null} [address] - Hard links
 * @property {string} [target] - Soft links
 * @property {string} [file] - External links
 * @property {string} [path] - External links
 * @property {number|null} creationOrder
 */

/** @returns {Link} */
export function parseLink(cursor) {
  const version = cursor.u8();
  if (version !== 1) throw cursor.error(`link message version ${version} is unknown`);
  const flags = cursor.u8();
  const linkType = flags & 0x08 ? cursor.u8() : 0;
  const creationOrder = flags & 0x04 ? cursor.u64() : null;
  if (flags & 0x10) cursor.u8(); // name character set: ASCII or UTF-8, both decoded as UTF-8
  const nameLength = cursor.uint(1 << (flags & 3));
  const name = decodeText(cursor.take(nameLength));
  if (linkType === 0) return { name, type: 'hard', address: cursor.address(), creationOrder };
  const valueLength = cursor.u16();
  const value = cursor.take(valueLength);
  if (linkType === 1) return { name, type: 'soft', target: decodeText(value), creationOrder };
  if (linkType === 64) {
    // One byte of version and flags, then file name and object path.
    let split = 1;
    while (split < value.length && value[split] !== 0) split++;
    let end = split + 1;
    while (end < value.length && value[end] !== 0) end++;
    return {
      name,
      type: 'external',
      file: decodeText(value.subarray(1, split)),
      path: decodeText(value.subarray(split + 1, end)),
      creationOrder,
    };
  }
  return { name, type: 'user', linkType, creationOrder };
}

/** Link info: where a new-style group keeps links that are not in its header. */
export function parseLinkInfo(cursor) {
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`link info message version ${version} is unknown`);
  const flags = cursor.u8();
  if (flags & 1) cursor.skip(8);
  const heapAddress = cursor.address();
  const nameIndexAddress = cursor.address();
  const orderIndexAddress = flags & 2 ? cursor.address() : null;
  return { heapAddress, nameIndexAddress, orderIndexAddress };
}

/** Attribute info: where an object keeps attributes that are not in its header. */
export function parseAttributeInfo(cursor) {
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`attribute info message version ${version} is unknown`);
  const flags = cursor.u8();
  if (flags & 1) cursor.skip(2);
  const heapAddress = cursor.address();
  const nameIndexAddress = cursor.address();
  const orderIndexAddress = flags & 2 ? cursor.address() : null;
  return { heapAddress, nameIndexAddress, orderIndexAddress };
}

export function parseSymbolTable(cursor) {
  return { btreeAddress: cursor.address(), heapAddress: cursor.address() };
}

export function parseContinuation(cursor) {
  return { address: cursor.address(), length: cursor.length() };
}

/**
 * @typedef {Object} Filter
 * @property {number} id
 * @property {string} name
 * @property {boolean} optional
 * @property {number[]} clientData
 */

/** @returns {Filter[]} */
export function parseFilterPipeline(cursor) {
  const version = cursor.u8();
  const count = cursor.u8();
  if (version === 1) cursor.skip(6);
  else if (version !== 2) throw cursor.error(`filter pipeline message version ${version} is unknown`);
  const filters = [];
  for (let i = 0; i < count; i++) {
    const id = cursor.u16();
    const nameLength = version === 1 || id >= 256 ? cursor.u16() : 0;
    const flags = cursor.u16();
    const valueCount = cursor.u16();
    let name = '';
    if (nameLength > 0) {
      const bytes = cursor.take(nameLength);
      let end = 0;
      while (end < bytes.length && bytes[end] !== 0) end++;
      name = decodeText(bytes.subarray(0, end));
    }
    const clientData = [];
    for (let v = 0; v < valueCount; v++) clientData.push(cursor.u32());
    if (version === 1 && valueCount % 2 === 1) cursor.skip(4);
    filters.push({ id, name, optional: (flags & 1) !== 0, clientData });
  }
  return filters;
}

/**
 * @typedef {Object} Layout
 * @property {'compact'|'contiguous'|'chunked'|'virtual'} class
 * @property {number} version
 * @property {number|null} [address]
 * @property {number} [size] - Contiguous storage bytes
 * @property {Uint8Array} [data] - Compact data (a copy)
 * @property {number[]} [chunkDims] - Chunk shape (dataset rank)
 * @property {number} [elementSize] - Chunked: bytes per element
 * @property {'btree-v1'|'single'|'implicit'|'fixed-array'|'extensible-array'|'btree-v2'} [index]
 * @property {Object} [indexInfo]
 * @property {number} [flags]
 */

/** @returns {Layout} */
export function parseLayout(cursor) {
  const version = cursor.u8();
  if (version === 1 || version === 2) {
    const dimensionality = cursor.u8();
    const layoutClass = cursor.u8();
    cursor.skip(5);
    const address = layoutClass === 0 ? null : cursor.address();
    const dims = [];
    for (let i = 0; i < dimensionality; i++) dims.push(cursor.u32());
    if (layoutClass === 0) {
      const size = cursor.u32();
      return { class: 'compact', version, data: cursor.take(size).slice() };
    }
    if (layoutClass === 1) return { class: 'contiguous', version, address, size: null };
    if (layoutClass === 2) {
      // The last dimension is the element size.
      return {
        class: 'chunked', version, address, index: 'btree-v1',
        chunkDims: dims.slice(0, -1), elementSize: dims[dims.length - 1], flags: 0,
      };
    }
    throw cursor.error(`layout class ${layoutClass} is unknown`);
  }
  // Version 5 (HDF5 2.0) differs from 4 only inside chunk index records,
  // whose sizes are read from the index structures themselves.
  if (version < 3 || version > 5) throw cursor.error(`layout message version ${version} is unknown`);
  const layoutClass = cursor.u8();
  if (layoutClass === 0) {
    const size = cursor.u16();
    return { class: 'compact', version, data: cursor.take(size).slice() };
  }
  if (layoutClass === 1) {
    const address = cursor.address();
    const size = cursor.length();
    return { class: 'contiguous', version, address, size };
  }
  if (layoutClass === 2) {
    if (version === 3) {
      const dimensionality = cursor.u8();
      const address = cursor.address();
      const dims = [];
      for (let i = 0; i < dimensionality; i++) dims.push(cursor.u32());
      // The dimensionality counts one extra dimension: the element size.
      return {
        class: 'chunked', version, address, index: 'btree-v1',
        chunkDims: dims.slice(0, -1), elementSize: dims[dims.length - 1], flags: 0,
      };
    }
    const flags = cursor.u8();
    const dimensionality = cursor.u8();
    const encodedLength = cursor.u8();
    const dims = [];
    for (let i = 0; i < dimensionality; i++) dims.push(cursor.uint(encodedLength));
    const indexType = cursor.u8();
    const layout = {
      class: 'chunked', version, flags,
      chunkDims: dims.slice(0, -1), elementSize: dims[dims.length - 1],
    };
    switch (indexType) {
      case 1:
        layout.index = 'single';
        layout.indexInfo = flags & 2 ? { filteredSize: cursor.length(), filterMask: cursor.u32() } : {};
        break;
      case 2:
        layout.index = 'implicit';
        layout.indexInfo = {};
        break;
      case 3:
        layout.index = 'fixed-array';
        layout.indexInfo = { pageBits: cursor.u8() };
        break;
      case 4:
        layout.index = 'extensible-array';
        layout.indexInfo = {
          maxBits: cursor.u8(),
          indexElements: cursor.u8(),
          minPointers: cursor.u8(),
          minElements: cursor.u8(),
          pageBits: cursor.u8(),
        };
        break;
      case 5:
        layout.index = 'btree-v2';
        layout.indexInfo = { nodeSize: cursor.u32(), splitPercent: cursor.u8(), mergePercent: cursor.u8() };
        break;
      default:
        throw cursor.error(`chunk index type ${indexType} is unknown`);
    }
    layout.address = cursor.address();
    return layout;
  }
  if (layoutClass === 3 && version >= 4) {
    return { class: 'virtual', version, address: cursor.address(), heapIndex: cursor.u32() };
  }
  throw cursor.error(`layout class ${layoutClass} is unknown`);
}

/**
 * The parts of an attribute message. The datatype and dataspace fields may
 * be shared-message pointers (`typeShared`, `spaceShared`), which the loader
 * resolves before decoding.
 */
export function parseAttribute(cursor) {
  const version = cursor.u8();
  if (version < 1 || version > 3) throw cursor.error(`attribute message version ${version} is unknown`);
  const flags = cursor.u8();
  const nameSize = cursor.u16();
  const typeSize = cursor.u16();
  const spaceSize = cursor.u16();
  if (version === 3) cursor.u8(); // name character set
  const pad = size => (version === 1 ? Math.ceil(size / 8) * 8 : size);
  const nameBytes = cursor.take(pad(nameSize));
  let nameEnd = 0;
  while (nameEnd < nameSize && nameBytes[nameEnd] !== 0) nameEnd++;
  const name = decodeText(nameBytes.subarray(0, nameEnd));
  const typeStart = cursor.position;
  const typeBytes = cursor.take(pad(typeSize));
  const spaceStart = cursor.position;
  const spaceBytes = cursor.take(pad(spaceSize));
  const data = cursor.bytes.subarray(cursor.position);
  return {
    name,
    typeShared: (flags & 1) !== 0,
    spaceShared: (flags & 2) !== 0,
    typeBytes,
    typeOffset: cursor.fileOffset + typeStart,
    spaceBytes,
    spaceOffset: cursor.fileOffset + spaceStart,
    data,
    dataOffset: cursor.fileOffset + cursor.position,
  };
}

/** B-tree 'K' values (superblock extension). */
export function parseBtreeK(cursor) {
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`B-tree K values message version ${version} is unknown`);
  return { chunk: cursor.u16(), groupInternal: cursor.u16(), groupLeaf: cursor.u16() };
}

/** Where the shared-message table is (superblock extension). */
export function parseSharedMessageTable(cursor) {
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`shared message table message version ${version} is unknown`);
  return { address: cursor.address(), indexCount: cursor.u8() };
}
