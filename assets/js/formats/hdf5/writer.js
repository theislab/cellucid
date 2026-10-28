/**
 * A minimal HDF5 writer: the subset of the format an AnnData `.h5ad` needs,
 * written as h5py and libhdf5 read it.
 *
 * - superblock version 2 (offsets and lengths of 8 bytes);
 * - version 2 object headers, groups with their links in the header
 *   (Link Info, Group Info and Link messages), attributes in the header
 *   (Attribute message version 3, names UTF-8) -- or, when one of an
 *   object's attributes is larger than a header message holds (65,535
 *   bytes: a `column-order` of thousands of columns), all of its attributes
 *   in dense storage, as libhdf5 keeps a large attribute: an Attribute Info
 *   message naming a fractal heap whose objects are the attribute messages
 *   (each a "huge" object, indexed by a version 2 B-tree) and a version 2
 *   B-tree of their names' hashes;
 * - contiguous datasets of little-endian integers, IEEE floats, the boolean
 *   enum h5py writes for a NumPy `bool`, and variable-length UTF-8 strings,
 *   whose bytes live in global heap collections (as h5py writes `str`);
 * - every metadata block checksummed (Jenkins lookup3, `checksum.js`).
 *
 * The file is laid out in one pass and returned as a Blob of parts: the
 * superblock, every dataset's bytes (a dataset's data may itself be a Blob,
 * so millions of rows are never held twice), the global heaps, then the
 * object headers, children before their parents. Nothing is compressed or
 * chunked: a reader reads any range of a dataset directly.
 *
 * @module formats/hdf5/writer
 */

import { lookup3 } from './checksum.js';
import { formatCountOf } from '../../utils/format-units.js';

const UNDEFINED_ADDRESS = 0xffff_ffff_ffff_ffffn;
const SUPERBLOCK_BYTES = 48;
const HEAP_HEADER_BYTES = 16;
const HEAP_OBJECT_HEADER_BYTES = 16;
const HEAP_MIN_BYTES = 4096;
/** The largest object index of a global heap collection (a uint16, 0 the free space). */
const HEAP_MAX_OBJECTS = 65_535;
const VLEN_ELEMENT_BYTES = 16;

const TEXT = new TextEncoder();

/** The element types a dataset or attribute holds. */
const NUMERIC_TYPES = Object.freeze({
  int8: { size: 1, kind: 'int', signed: true, ArrayType: Int8Array },
  int16: { size: 2, kind: 'int', signed: true, ArrayType: Int16Array },
  int32: { size: 4, kind: 'int', signed: true, ArrayType: Int32Array },
  int64: { size: 8, kind: 'int', signed: true, ArrayType: BigInt64Array },
  uint8: { size: 1, kind: 'int', signed: false, ArrayType: Uint8Array },
  uint32: { size: 4, kind: 'int', signed: false, ArrayType: Uint32Array },
  float32: { size: 4, kind: 'float', ArrayType: Float32Array },
  float64: { size: 8, kind: 'float', ArrayType: Float64Array },
  bool: { size: 1, kind: 'bool', ArrayType: Uint8Array },
});

/** A growable little-endian byte buffer. */
class Bytes {
  constructor(capacity = 256) {
    this.buffer = new Uint8Array(capacity);
    this.view = new DataView(this.buffer.buffer);
    this.length = 0;
  }

  _reserve(count) {
    if (this.length + count <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + count) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value) { this._reserve(1); this.view.setUint8(this.length, value); this.length += 1; return this; }
  u16(value) { this._reserve(2); this.view.setUint16(this.length, value, true); this.length += 2; return this; }
  u32(value) { this._reserve(4); this.view.setUint32(this.length, value, true); this.length += 4; return this; }
  u64(value) {
    this._reserve(8);
    this.view.setBigUint64(this.length, typeof value === 'bigint' ? value : BigInt(value), true);
    this.length += 8;
    return this;
  }
  bytes(values) { this._reserve(values.length); this.buffer.set(values, this.length); this.length += values.length; return this; }
  zeros(count) { this._reserve(count); this.buffer.fill(0, this.length, this.length + count); this.length += count; return this; }
  done() { return this.buffer.slice(0, this.length); }
}

// ---------------------------------------------------------------------------
// The tree a caller builds
// ---------------------------------------------------------------------------

function requireName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name === '.') {
    throw new TypeError(`An HDF5 link name must be non-empty text without "/", not ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * A group: its attributes and its children, by name, in order.
 *
 * @param {Record<string, unknown>} [attributes]
 * @param {Array<[string, object]>} [children]
 */
export function group(attributes = {}, children = []) {
  for (const [name] of children) requireName(name);
  const names = new Set(children.map(([name]) => name));
  if (names.size !== children.length) throw new TypeError('A group names each child once');
  return { node: 'group', attributes, children };
}

/**
 * A dataset of numbers: `data` its little-endian bytes (a typed array, or a
 * Blob of them), `shape` its dimensions (row-major).
 *
 * @param {keyof NUMERIC_TYPES} type
 * @param {number[]} shape
 * @param {ArrayBufferView|Blob} data
 * @param {Record<string, unknown>} [attributes]
 */
export function numericDataset(type, shape, data, attributes = {}) {
  const info = NUMERIC_TYPES[type];
  if (info === undefined) throw new TypeError(`Unknown dataset type ${type}`);
  const count = shape.reduce((product, size) => product * size, 1);
  const bytes = data instanceof Blob ? data.size : data.byteLength;
  if (bytes !== count * info.size) {
    throw new RangeError(`A ${type} dataset of shape [${shape.join(', ')}] holds ${formatCountOf(count * info.size, 'byte')}, not ${bytes}`);
  }
  return { node: 'dataset', type, shape, data, attributes };
}

/**
 * A one-dimensional dataset of variable-length UTF-8 strings.
 *
 * @param {ArrayLike<string>} strings
 * @param {Record<string, unknown>} [attributes]
 */
export function stringDataset(strings, attributes = {}) {
  return { node: 'dataset', type: 'vlen-string', shape: [strings.length], data: strings, attributes };
}

/** An attribute value written as a boolean (h5py's enum of a NumPy bool). */
export function booleanAttribute(value) {
  return { attribute: 'bool', value: value === true };
}

// ---------------------------------------------------------------------------
// Datatypes and dataspaces
// ---------------------------------------------------------------------------

function fixedPointType(size, signed) {
  const bytes = new Bytes(12);
  bytes.u8((1 << 4) | 0).u8(signed ? 0x08 : 0x00).u8(0).u8(0).u32(size);
  bytes.u16(0).u16(size * 8);
  return bytes.done();
}

function floatType(size) {
  const bytes = new Bytes(20);
  const double = size === 8;
  // Byte order little-endian, implied mantissa MSB (bits 4-5 = 2), sign bit.
  bytes.u8((1 << 4) | 1).u8(0x20).u8(double ? 63 : 31).u8(0).u32(size);
  bytes.u16(0).u16(size * 8);
  bytes.u8(double ? 52 : 23).u8(double ? 11 : 8).u8(0).u8(double ? 52 : 23).u32(double ? 1023 : 127);
  return bytes.done();
}

/** h5py's NumPy bool: an enum of int8 with FALSE = 0 and TRUE = 1 (version 3). */
function boolType() {
  const bytes = new Bytes(32);
  bytes.u8((3 << 4) | 8).u16(2).u8(0).u32(1);
  bytes.bytes(fixedPointType(1, true));
  bytes.bytes(TEXT.encode('FALSE')).u8(0).bytes(TEXT.encode('TRUE')).u8(0);
  bytes.u8(0).u8(1);
  return bytes.done();
}

/** A variable-length UTF-8 string, its base a 1-byte unsigned character. */
function vlenStringType() {
  const bytes = new Bytes(24);
  // Type 1 (string), padding 0 (null terminated), character set 1 (UTF-8).
  bytes.u8((1 << 4) | 9).u8(0x01).u8(0x01).u8(0).u32(VLEN_ELEMENT_BYTES);
  bytes.bytes(fixedPointType(1, false));
  return bytes.done();
}

function datatypeOf(type) {
  if (type === 'vlen-string') return vlenStringType();
  if (type === 'bool') return boolType();
  const info = NUMERIC_TYPES[type];
  return info.kind === 'float' ? floatType(info.size) : fixedPointType(info.size, info.signed);
}

function dataspace(shape) {
  const bytes = new Bytes(8 + shape.length * 8);
  // Version 2; a scalar (shape []) is type 0, every other type 1 (simple).
  bytes.u8(2).u8(shape.length).u8(0).u8(shape.length === 0 ? 0 : 1);
  for (const size of shape) bytes.u64(size);
  return bytes.done();
}

// ---------------------------------------------------------------------------
// Global heap: the bytes of every variable-length string
// ---------------------------------------------------------------------------

function align8(value) {
  return Math.ceil(value / 8) * 8;
}

/**
 * Every string's bytes in global heap collections, at most 65,535 per
 * collection. Returns the collections (to place in the file) and a function
 * that writes a string's 16-byte element (length, collection address,
 * object index) once the collections have addresses.
 */
function createStringHeap() {
  const collections = [];
  let current = null;
  const start = () => {
    current = { objects: [], bytes: HEAP_HEADER_BYTES, address: null };
    collections.push(current);
  };
  return {
    /** @returns {{collection: object, index: number, length: number}} */
    add(text) {
      const encoded = TEXT.encode(text);
      if (current === null || current.objects.length === HEAP_MAX_OBJECTS) start();
      current.objects.push(encoded);
      current.bytes += HEAP_OBJECT_HEADER_BYTES + align8(encoded.length);
      return { collection: current, index: current.objects.length, length: encoded.length };
    },
    collections,
  };
}

function collectionSize(collection) {
  // The free-space object (index 0) closes the collection: its size counts
  // its own header, and a collection is at least 4096 bytes.
  return Math.max(HEAP_MIN_BYTES, collection.bytes + HEAP_OBJECT_HEADER_BYTES);
}

function encodeCollection(collection) {
  const size = collectionSize(collection);
  const bytes = new Bytes(size);
  bytes.bytes(TEXT.encode('GCOL')).u8(1).zeros(3).u64(size);
  collection.objects.forEach((encoded, index) => {
    bytes.u16(index + 1).u16(1).zeros(4).u64(encoded.length);
    bytes.bytes(encoded).zeros(align8(encoded.length) - encoded.length);
  });
  const free = size - bytes.length;
  bytes.u16(0).u16(0).zeros(4).u64(free).zeros(free - HEAP_OBJECT_HEADER_BYTES);
  return bytes.done();
}

function writeVlenElement(bytes, reference) {
  bytes.u32(reference.length).u64(reference.collection.address).u32(reference.index);
}

// ---------------------------------------------------------------------------
// Object headers
// ---------------------------------------------------------------------------

const MESSAGE = Object.freeze({
  dataspace: 0x0001,
  linkInfo: 0x0002,
  datatype: 0x0003,
  fillValue: 0x0005,
  link: 0x0006,
  layout: 0x0008,
  groupInfo: 0x000a,
  attribute: 0x000c,
  attributeInfo: 0x0015,
});

/** The largest message a version 2 object header holds (its size is a uint16). */
const MESSAGE_MAX_BYTES = 0xffff;

function objectHeader(messages) {
  const body = new Bytes(256);
  for (const { type, data } of messages) {
    if (data.length > MESSAGE_MAX_BYTES) {
      throw new RangeError(`An HDF5 object header message holds at most ${MESSAGE_MAX_BYTES} bytes, not ${data.length}`);
    }
    body.u8(type).u16(data.length).u8(0).bytes(data);
  }
  const bytes = new Bytes(body.length + 16);
  // Version 2, flags 2: the size of chunk 0 is 4 bytes; no times, no
  // attribute phase change values.
  bytes.bytes(TEXT.encode('OHDR')).u8(2).u8(0x02).u32(body.length).bytes(body.done());
  const block = bytes.done();
  const checksum = lookup3(block);
  const out = new Uint8Array(block.length + 4);
  out.set(block);
  new DataView(out.buffer).setUint32(block.length, checksum, true);
  return out;
}

function linkMessage(name, address) {
  const encoded = TEXT.encode(name);
  const bytes = new Bytes(encoded.length + 16);
  // Version 1; flags: length field of 4 bytes (bits 0-1 = 2), character set
  // present (bit 4); a hard link, so no link type field.
  bytes.u8(1).u8(0x02 | 0x10).u8(1).u32(encoded.length).bytes(encoded).u64(address);
  return bytes.done();
}

function linkInfoMessage() {
  const bytes = new Bytes(18);
  // Version 0, no creation order: no fractal heap, no name index (the links
  // are in the header).
  bytes.u8(0).u8(0).u64(UNDEFINED_ADDRESS).u64(UNDEFINED_ADDRESS);
  return bytes.done();
}

function groupInfoMessage() {
  return Uint8Array.of(0, 0);
}

function fillValueMessage() {
  // Version 3: space allocated late, fill value written if set, none set.
  return Uint8Array.of(3, 0x0a);
}

function layoutMessage(address, size) {
  const bytes = new Bytes(18);
  bytes.u8(3).u8(1).u64(size === 0 ? UNDEFINED_ADDRESS : address).u64(size);
  return bytes.done();
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * An attribute value as its datatype, dataspace and bytes: text (a
 * variable-length string), a list of text (an empty list is an empty float
 * array, as AnnData writes an empty `column-order`), an integer list or
 * BigInt64Array (int64), or `booleanAttribute()`.
 */
function attributeParts(name, value, heap) {
  if (typeof value === 'string') {
    return { type: 'vlen-string', shape: [], strings: [value] };
  }
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    if (value.length === 0) return { type: 'float64', shape: [0], data: new Uint8Array(0) };
    return { type: 'vlen-string', shape: [value.length], strings: value };
  }
  if (value instanceof BigInt64Array) {
    return { type: 'int64', shape: [value.length], data: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  }
  if (value !== null && typeof value === 'object' && value.attribute === 'bool') {
    return { type: 'bool', shape: [], data: Uint8Array.of(value.value ? 1 : 0) };
  }
  throw new TypeError(`Attribute "${name}" must be text, a list of text, a BigInt64Array or a boolean`);
}

function attributeMessage(name, parts, references) {
  const encodedName = TEXT.encode(name);
  const type = datatypeOf(parts.type);
  const space = dataspace(parts.shape);
  let data;
  if (parts.type === 'vlen-string') {
    const bytes = new Bytes(references.length * VLEN_ELEMENT_BYTES);
    for (const reference of references) writeVlenElement(bytes, reference);
    data = bytes.done();
  } else {
    data = parts.data;
  }
  const bytes = new Bytes(16 + encodedName.length + type.length + space.length + data.length);
  // Version 3: name, datatype and dataspace sizes; the name's character set
  // (UTF-8); the name with its terminating null, nothing padded.
  bytes.u8(3).u8(0).u16(encodedName.length + 1).u16(type.length).u16(space.length).u8(1);
  bytes.bytes(encodedName).u8(0).bytes(type).bytes(space).bytes(data);
  return bytes.done();
}

// ---------------------------------------------------------------------------
// Dense attribute storage
// ---------------------------------------------------------------------------

/** A metadata block with its lookup3 checksum appended. */
function checksummed(block) {
  const out = new Uint8Array(block.length + 4);
  out.set(block);
  new DataView(out.buffer).setUint32(block.length, lookup3(block), true);
  return out;
}

/** The fractal heap parameters libhdf5 gives an object's attribute heap. */
const ATTRIBUTE_HEAP = Object.freeze({
  idLength: 8,
  maxManagedBytes: 4096,
  tableWidth: 4,
  startBlockBytes: 512,
  maxDirectBlockBytes: 65536,
  maxHeapBits: 40,
  startRootRows: 1,
});
/** A huge object's heap ID: its type byte, then its B-tree key in 7 bytes. */
const HEAP_ID_HUGE = 0x10;
const HUGE_ID_BYTES = ATTRIBUTE_HEAP.idLength - 1;
const BTREE_NODE_BYTES = 512;
/** A v2 B-tree leaf: signature, version, type, then records, then checksum. */
const BTREE_LEAF_OVERHEAD = 4 + 1 + 1 + 4;
/** The most records one leaf names (its record count is a uint16). */
const BTREE_LEAF_MAX_RECORDS = 0xffff;
const BTREE_TYPE_HUGE_INDIRECT = 1;
const BTREE_TYPE_ATTRIBUTE_NAMES = 8;

/**
 * A version 2 B-tree of one leaf: its header and its leaf (padded to the node
 * size the header names), placed by `place`, which returns each block's
 * address. Returns the header's address.
 */
function oneLeafBtree(type, recordBytes, records, place) {
  if (records.length > BTREE_LEAF_MAX_RECORDS) {
    throw new RangeError(`One HDF5 object holds at most ${BTREE_LEAF_MAX_RECORDS} attributes in dense storage`);
  }
  const nodeBytes = Math.max(BTREE_NODE_BYTES, BTREE_LEAF_OVERHEAD + recordBytes * records.length);
  const leaf = new Bytes(nodeBytes);
  leaf.bytes(TEXT.encode('BTLF')).u8(0).u8(type);
  for (const record of records) leaf.bytes(record);
  const leafBlock = checksummed(leaf.done());
  const padded = new Uint8Array(nodeBytes);
  padded.set(leafBlock);
  const leafAddress = place(padded);
  const header = new Bytes(48);
  // Version 0; depth 0 (the root is the leaf); split 100 %, merge 40 %, as libhdf5 creates them.
  header.bytes(TEXT.encode('BTHD')).u8(0).u8(type).u32(nodeBytes).u16(recordBytes).u16(0).u8(100).u8(40);
  header.u64(leafAddress).u16(records.length).u64(records.length);
  return place(checksummed(header.done()));
}

/**
 * Put an object's attribute messages in dense storage: each message a huge
 * object of a fractal heap (read through the heap's B-tree of huge objects),
 * and a B-tree of the names' hashes. `place(bytes)` appends a block to the
 * file and returns its address. Returns the Attribute Info message.
 *
 * @param {Array<{name: string, message: Uint8Array}>} attributes
 * @param {(bytes: Uint8Array) => number} place
 */
function denseAttributes(attributes, place) {
  const huge = [];
  const names = [];
  attributes.forEach(({ name, message }, index) => {
    const id = index + 1;
    const address = place(message);
    const record = new Bytes(24);
    record.u64(address).u64(message.length).u64(id);
    huge.push(record.done());
    const heapId = new Uint8Array(ATTRIBUTE_HEAP.idLength);
    heapId[0] = HEAP_ID_HUGE;
    for (let byte = 0, rest = id; byte < HUGE_ID_BYTES; byte++, rest = Math.floor(rest / 256)) heapId[1 + byte] = rest % 256;
    const hash = lookup3(TEXT.encode(name));
    const entry = new Bytes(17);
    // The heap ID, the message flags (none), the creation order (not tracked), the name's hash.
    entry.bytes(heapId).u8(0).u32(0).u32(hash);
    names.push({ hash, name, record: entry.done() });
  });
  names.sort((a, b) => (a.hash - b.hash) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hugeTree = oneLeafBtree(BTREE_TYPE_HUGE_INDIRECT, 24, huge, place);
  const nameTree = oneLeafBtree(BTREE_TYPE_ATTRIBUTE_NAMES, 17, names.map(entry => entry.record), place);
  const totalBytes = attributes.reduce((sum, { message }) => sum + message.length, 0);
  const heap = new Bytes(160);
  heap.bytes(TEXT.encode('FRHP')).u8(0).u16(ATTRIBUTE_HEAP.idLength).u16(0)
    // Flags: direct blocks checksummed (it has none: every object is huge).
    .u8(0x02).u32(ATTRIBUTE_HEAP.maxManagedBytes)
    .u64(attributes.length).u64(hugeTree)
    // No managed space: free space, its manager, managed and allocated
    // space, the allocation iterator, managed objects.
    .u64(0).u64(UNDEFINED_ADDRESS).u64(0).u64(0).u64(0).u64(0)
    .u64(totalBytes).u64(attributes.length)
    .u64(0).u64(0)
    .u16(ATTRIBUTE_HEAP.tableWidth).u64(ATTRIBUTE_HEAP.startBlockBytes).u64(ATTRIBUTE_HEAP.maxDirectBlockBytes)
    .u16(ATTRIBUTE_HEAP.maxHeapBits).u16(ATTRIBUTE_HEAP.startRootRows).u64(UNDEFINED_ADDRESS).u16(0);
  const heapAddress = place(checksummed(heap.done()));
  const info = new Bytes(18);
  // Version 0, no creation order: the heap and the name index.
  info.u8(0).u8(0).u64(heapAddress).u64(nameTree);
  return info.done();
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * The HDF5 file of a tree of groups and datasets, as a Blob.
 *
 * @param {ReturnType<typeof group>} root
 * @param {{type?: string}} [options] - The Blob's media type
 * @returns {Blob}
 */
export function writeHdf5(root, { type = 'application/x-hdf5' } = {}) {
  if (root?.node !== 'group') throw new TypeError('An HDF5 file has a group at its root');
  const heap = createStringHeap();
  const datasets = [];
  const attributesOf = new Map();

  // First pass: every string to the heap, every dataset's bytes in order.
  const visit = node => {
    const attributes = [];
    for (const [name, value] of Object.entries(node.attributes ?? {})) {
      const parts = attributeParts(name, value, heap);
      const references = parts.type === 'vlen-string' ? parts.strings.map(text => heap.add(text)) : [];
      attributes.push({ name, parts, references });
    }
    attributesOf.set(node, attributes);
    if (node.node === 'group') {
      for (const [, child] of node.children) visit(child);
      return;
    }
    if (node.type === 'vlen-string') {
      node.references = Array.from(node.data, text => heap.add(String(text)));
    }
    datasets.push(node);
  };
  visit(root);

  const parts = [];
  let offset = SUPERBLOCK_BYTES;
  // Numeric data first, as given (a Blob is never copied here).
  for (const dataset of datasets) {
    if (dataset.type === 'vlen-string') continue;
    const size = dataset.data instanceof Blob ? dataset.data.size : dataset.data.byteLength;
    dataset.address = offset;
    dataset.size = size;
    if (size > 0) {
      parts.push(dataset.data instanceof Blob ? dataset.data : new Uint8Array(dataset.data.buffer, dataset.data.byteOffset, size));
    }
    offset += size;
  }
  // The heap collections, then every string dataset's elements.
  for (const collection of heap.collections) {
    collection.address = BigInt(offset);
    const encoded = encodeCollection(collection);
    parts.push(encoded);
    offset += encoded.length;
  }
  for (const dataset of datasets) {
    if (dataset.type !== 'vlen-string') continue;
    const bytes = new Bytes(dataset.references.length * VLEN_ELEMENT_BYTES + 1);
    for (const reference of dataset.references) writeVlenElement(bytes, reference);
    const encoded = bytes.done();
    dataset.address = offset;
    dataset.size = encoded.length;
    if (encoded.length > 0) parts.push(encoded);
    offset += encoded.length;
  }

  /** Append a block to the file; its address. */
  const place = bytes => {
    const address = offset;
    parts.push(bytes);
    offset += bytes.length;
    return address;
  };

  // Object headers, children before their parents.
  const headerOf = node => {
    const messages = [];
    if (node.node === 'group') {
      const links = node.children.map(([name, child]) => [name, headerOf(child)]);
      messages.push({ type: MESSAGE.linkInfo, data: linkInfoMessage() });
      messages.push({ type: MESSAGE.groupInfo, data: groupInfoMessage() });
      for (const [name, address] of links) messages.push({ type: MESSAGE.link, data: linkMessage(name, address) });
    } else {
      messages.push({ type: MESSAGE.dataspace, data: dataspace(node.shape) });
      messages.push({ type: MESSAGE.datatype, data: datatypeOf(node.type) });
      messages.push({ type: MESSAGE.fillValue, data: fillValueMessage() });
      messages.push({ type: MESSAGE.layout, data: layoutMessage(node.address, node.size) });
    }
    const attributes = attributesOf.get(node).map(({ name, parts: value, references }) => ({
      name,
      message: attributeMessage(name, value, references),
    }));
    if (attributes.some(({ message }) => message.length > MESSAGE_MAX_BYTES)) {
      messages.push({ type: MESSAGE.attributeInfo, data: denseAttributes(attributes, place) });
    } else {
      for (const { message } of attributes) messages.push({ type: MESSAGE.attribute, data: message });
    }
    const header = objectHeader(messages);
    const address = offset;
    parts.push(header);
    offset += header.length;
    return address;
  };
  const rootAddress = headerOf(root);

  const superblock = new Bytes(SUPERBLOCK_BYTES);
  superblock.bytes(Uint8Array.of(0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a));
  superblock.u8(2).u8(8).u8(8).u8(0);
  superblock.u64(0).u64(UNDEFINED_ADDRESS).u64(offset).u64(rootAddress);
  const block = superblock.done();
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, lookup3(block), true);
  return new Blob([block, checksum, ...parts], { type });
}
