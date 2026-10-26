/**
 * Reading HDF5 files (`.h5ad`, `.loom`, a 10x `.h5`, `.h5mu`, `.h5seurat`) in
 * the browser, asynchronously, from a local file or a remote one read with
 * HTTP range requests.
 *
 *     import { openHdf5 } from './formats/hdf5/index.js';
 *     const root = await openHdf5(createByteReader(source));
 *     const x = root.get('obsm/X_umap');
 *     const values = await x.read([[0, 1000]]);
 *
 * `openHdf5` reads the superblock, then the whole object tree (every
 * group's links, every object's header and attributes) with as many reads
 * in flight at once as the tree allows; navigation afterwards is
 * synchronous. Array values are read on demand. The result implements the
 * array store (formats/store.js).
 *
 * The package, by module:
 *
 * | module | reads |
 * | --- | --- |
 * | superblock.js | the superblock (versions 0-3, user block) |
 * | object-header.js | object headers (versions 1, 2) and continuation blocks |
 * | messages.js | header messages: dataspace, layout, filters, links, attributes, … |
 * | datatype.js | datatype messages, and their store `Dtype` |
 * | decode.js | element bytes into values |
 * | heaps.js | local heaps, global heap collections |
 * | fractal-heap.js | fractal heaps (dense links and attributes) |
 * | btree-v1.js, btree-v2.js | version 1 and 2 B-trees, symbol table nodes |
 * | chunk-index.js, fixed-array.js, extensible-array.js | every chunk index |
 * | filters.js, lzf.js | deflate, shuffle, fletcher32, LZF |
 * | read-plan.js | selections into fetches and copies |
 * | load.js | the object tree at open |
 * | nodes.js | the store's groups and arrays |
 * | context.js, binary.js, checksum.js, lru.js, errors.js | shared plumbing |
 *
 * @module formats/hdf5
 */

import { FileContext } from './context.js';
import { readSuperblock } from './superblock.js';
import { loadTree } from './load.js';
import { Hdf5Tree } from './nodes.js';
import { Hdf5FormatError, Hdf5UnsupportedError, throwIfAborted } from './errors.js';
import { releaseIdleDecodeWorkers } from '../io/decode-pool.js';

export { Hdf5FormatError, Hdf5UnsupportedError };

const MiB = 1024 * 1024;

/**
 * @typedef {Object} OpenOptions
 * @property {AbortSignal|null} [signal]
 * @property {number} [decodedChunkCacheBytes] - Budget of the decoded-chunk cache (default 64 MiB)
 * @property {boolean} [verifyChecksums] - Check newer-format metadata checksums (default true)
 * @property {import('../io/activity.js').ReadActivity|null} [activity] - Counts what opening reads
 */

/**
 * Open an HDF5 file.
 *
 * @param {import('../io/byte-reader.js').ByteReader} reader
 * @param {OpenOptions} [options]
 * @returns {Promise<import('./nodes.js').Hdf5Group & {close: () => void, stats: () => Object}>}
 */
export async function openHdf5(reader, { signal = null, activity = null, decodedChunkCacheBytes = 64 * MiB, verifyChecksums = true } = {}) {
  if (reader === null || typeof reader !== 'object' || typeof reader.read !== 'function') {
    throw new TypeError('openHdf5 needs a byte reader (formats/io/byte-reader.js).');
  }
  const started = performance.now();
  const before = reader.stats();
  const file = new FileContext(reader, { decodedChunkCacheBytes, verifyChecksums });
  const superblock = await readSuperblock(reader, signal, activity);
  file.base = superblock.offset;
  file.offsetSize = superblock.offsetSize;
  file.lengthSize = superblock.lengthSize;
  file.btreeK = superblock.btreeK;
  file.superblock = superblock;
  const objects = await loadTree(file.withActivity(activity), superblock, signal);
  throwIfAborted(signal);
  const tree = new Hdf5Tree(file, objects, superblock.rootAddress);
  const root = tree.root;
  if (root === null || root.kind !== 'group') {
    throw new Hdf5FormatError(`${reader.name}: the root object is not a group.`);
  }
  const after = reader.stats();
  const openStats = Object.freeze({
    milliseconds: performance.now() - started,
    requests: after.requests - before.requests,
    bytes: after.bytes - before.bytes,
    objects: objects.size,
  });
  root.close = () => {
    file.closed = true;
    file.cache.clear();
    file.inflight.clear();
    reader.clear();
    releaseIdleDecodeWorkers();
  };
  root.stats = () => ({
    open: openStats,
    reader: reader.stats(),
    decodedCache: file.cache.stats(),
    superblockVersion: superblock.version,
  });
  return root;
}
