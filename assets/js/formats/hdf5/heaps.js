/**
 * Local and global heaps.
 *
 * - A local heap ("HEAP") holds the link names of an older-format group.
 * - The global heap is a set of collections ("GCOL") holding variable-length
 *   data: every variable-length string or sequence element is a pointer
 *   (collection address, object index) into one. Reading a column of strings
 *   means fetching every collection its elements point to; they are fetched
 *   together, each once, and kept parsed in the file's cache.
 *
 * @module formats/hdf5/heaps
 */

import { formatError } from './errors.js';
import { formatCountOf } from '../../utils/format-units.js';

/** The library's default collection size, for callers that cannot count. */
const DEFAULT_COLLECTION_BYTES = 4096;

/** An object past the bytes read of a collection: load it whole and decode again. */
export class IncompleteCollectionError extends Error {
  constructor(address) {
    super(`Global heap collection ${address} was read in part.`);
    this.name = 'IncompleteCollectionError';
    this.address = address;
  }
}

/**
 * Read a local heap's data segment.
 *
 * @returns {Promise<{data: Uint8Array, address: number}>}
 */
export async function readLocalHeap(file, address, signal) {
  const what = 'Local heap';
  const headerSize = 8 + 2 * file.lengthSize + file.offsetSize;
  const bytes = await file.meta(address, headerSize, what, signal);
  const cursor = file.cursor(bytes, address, what);
  cursor.signature('HEAP');
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`local heap version ${version} is unknown`);
  cursor.skip(3);
  const dataSize = cursor.length();
  cursor.length(); // free list head
  const dataAddress = cursor.address();
  const data = await file.meta(dataAddress, dataSize, 'Local heap data segment', signal);
  return { data, address: dataAddress };
}

/** The NUL-terminated string at `offset` of a local heap's data. */
export function localHeapString(heap, offset, file, decode) {
  const data = heap.data;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.length) {
    throw formatError('Local heap', file.absolute(heap.address), `name offset ${offset} is outside its ${data.length}-byte data segment`);
  }
  let end = offset;
  while (end < data.length && data[end] !== 0) end++;
  return decode(data.subarray(offset, end));
}

/**
 * A parsed global heap collection.
 *
 * @typedef {Object} Collection
 * @property {Uint8Array} bytes - The whole collection (an owned copy)
 * @property {Int32Array} starts - Object index -> data offset in `bytes` (-1: absent)
 * @property {Int32Array} sizes - Object index -> data size
 */

/**
 * Parse a collection's bytes (an owned copy) read from `address`. When the
 * bytes are only the start of the collection (`complete` false), the objects
 * they hold are indexed and the rest are missing.
 */
function parseCollection(file, bytes, address, complete) {
  const what = 'Global heap collection';
  const cursor = file.cursor(bytes, address, what);
  cursor.signature('GCOL');
  const version = cursor.u8();
  if (version !== 1) throw cursor.error(`global heap collection version ${version} is unknown`);
  cursor.skip(3);
  cursor.length();
  const found = [];
  let maxIndex = 0;
  const objectHeader = 8 + file.lengthSize;
  while (cursor.position + objectHeader <= bytes.length) {
    const index = cursor.u16();
    cursor.skip(6);
    const size = cursor.length();
    if (index === 0) break; // free space: the rest of the collection
    const start = cursor.position;
    if (start + size > bytes.length) {
      if (!complete) break;
      throw cursor.error(`object ${index} of ${formatCountOf(size, 'byte')} runs past the end of the ${bytes.length}-byte collection`);
    }
    found.push(index, start, size);
    if (index > maxIndex) maxIndex = index;
    cursor.position = start + Math.ceil(size / 8) * 8;
    if (cursor.position > bytes.length) break;
  }
  // Object indexes are 16-bit: plain arrays indexed by them.
  const starts = new Int32Array(maxIndex + 1).fill(-1);
  const sizes = new Int32Array(maxIndex + 1);
  for (let i = 0; i < found.length; i += 3) {
    starts[found[i]] = found[i + 1];
    sizes[found[i]] = found[i + 2];
  }
  return { bytes, starts, sizes, complete };
}

/** The size declared in a collection header, checked. */
function collectionSize(file, bytes, address) {
  const cursor = file.cursor(bytes, address, 'Global heap collection');
  cursor.signature('GCOL');
  cursor.skip(4);
  const size = cursor.length();
  if (size < 8 + file.lengthSize) throw cursor.error(`collection size ${size} is smaller than its header`);
  return size;
}

/**
 * Load the collections in `needs` (collection address -> bytes of it the
 * caller's elements need, or an iterable of addresses), each once, parsed.
 *
 * Each collection is read once, from its address for the bytes its
 * referenced objects take (the caller counts them from the elements'
 * lengths): one request per collection, and neighbouring collections merge
 * into one in the byte reader. When that is only the start of a collection
 * (the elements read are some of many), the objects it holds are indexed;
 * decoding an object past them raises `IncompleteCollectionError`, and the
 * caller loads those collections again with `complete: true`.
 *
 * `cache: true` (attributes) reads through the metadata block cache.
 *
 * @param {import('./context.js').FileContext} file
 * @param {Map<number, number>|Iterable<number>} needs
 * @param {{cache?: boolean, complete?: boolean, signal?: AbortSignal|null}} [options]
 * @returns {Promise<Map<number, Collection>>}
 */
export async function loadCollections(file, needs, { cache = false, complete = false, signal = null } = {}) {
  const wanted = needs instanceof Map ? needs : new Map([...needs].map(address => [address, DEFAULT_COLLECTION_BYTES]));
  const sorted = [...wanted.keys()].sort((a, b) => a - b);
  const result = new Map();
  const loads = [];
  for (let i = 0; i < sorted.length; i++) {
    const address = sorted[i];
    const key = `gcol:${address}`;
    const cached = file.cache.get(key);
    if (cached !== undefined && (cached.complete || !complete)) {
      result.set(address, cached);
      continue;
    }
    // Never past the next collection asked for: requests do not overlap. At
    // least what one round trip of the link is worth is read (its bytes take
    // no longer than the round trip a second read would cost): the rest of a
    // collection then comes with the bytes the elements need, instead of a
    // second, dependent round trip when an object lies past them.
    // Bytes held already (a file's head) are read only as far as they go
    // when they hold what the elements need: reading on for a round trip's
    // worth would cost the round trip it saves.
    const next = i + 1 < sorted.length ? sorted[i + 1] : Infinity;
    const need = Math.max(wanted.get(address), 8 + file.lengthSize);
    const roundTrip = file.reader.link?.roundTripBytes ?? file.shaping.mergeGapBytes;
    const held = (file.reader.cachedEnd?.(file.absolute(address)) ?? 0) - file.absolute(address);
    const length = Math.min(next - address, held >= need ? held : Math.max(need, Math.floor(roundTrip)));
    const memoKey = complete ? `${key}:complete` : key;
    // A collection read in part before: only its remaining bytes are fetched.
    const partial = cached !== undefined && !cached.complete ? cached : null;
    loads.push(file.once(memoKey, () => loadCollection(file, address, length, cache, complete, signal, partial)).then(collection => {
      file.memo.delete(memoKey);
      file.cache.set(key, collection, collection.bytes.length + 64);
      result.set(address, collection);
    }));
  }
  await Promise.all(loads);
  return result;
}

/**
 * Load the collections `needs` names and run `decode(collections)`; when the
 * collections read in part miss an object, load them whole and decode again.
 */
export async function withCollections(file, needs, options, decode) {
  if (needs.size === 0) return decode(new Map());
  const collections = await loadCollections(file, needs, options);
  try {
    return decode(collections);
  } catch (error) {
    if (!(error instanceof IncompleteCollectionError)) throw error;
  }
  return decode(await loadCollections(file, needs, { ...options, complete: true }));
}

/** Bytes a collection holding objects of `dataBytes` needs for one more of them. */
export function collectionEntryBytes(file, dataBytes) {
  return 8 + file.lengthSize + Math.ceil(dataBytes / 8) * 8;
}

async function loadCollection(file, address, length, cache, complete, signal, partial = null) {
  const what = 'Global heap collection';
  const available = file.size - file.absolute(address);
  const read = (offset, count) => (cache
    ? file.meta(offset, count, what, signal)
    : file.data(offset, count, what, signal));
  const first = partial?.bytes ?? await read(address, Math.min(available, length));
  const size = collectionSize(file, first, address);
  if (size <= first.length) return parseCollection(file, first.slice(0, size), address, true);
  if (!complete) return parseCollection(file, first.slice(), address, false);
  file.requireRange(address, size, what);
  const rest = await read(address + first.length, size - first.length);
  const bytes = new Uint8Array(size);
  bytes.set(first, 0);
  bytes.set(rest, first.length);
  return parseCollection(file, bytes, address, true);
}

/**
 * The collection at `address` among loaded `collections`, or null for a
 * pointer to nothing (the undefined or zero address: an empty value).
 */
export function findCollection(file, collections, address, label) {
  if (address === null || address === 0) return null;
  const collection = collections.get(address);
  if (collection === undefined) {
    throw formatError(label, file.absolute(address), 'its global heap collection was not loaded');
  }
  return collection;
}

/** Offset of object `index` in `collection.bytes`, checked. */
export function objectStart(file, collection, address, index, label) {
  const start = index < collection.starts.length ? collection.starts[index] : -1;
  if (start < 0 && !collection.complete) throw new IncompleteCollectionError(address);
  if (start < 0) {
    throw formatError(label, file.absolute(address), `global heap object ${index} does not exist in its collection`);
  }
  return start;
}
