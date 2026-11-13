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
 * `openHdf5` reads the superblock, then the root group and the paths its
 * caller names (`load`, as `Group.load` takes them); anything deeper is
 * read when a reader loads it (`root.load(paths)`), each object once, so
 * opening never waits for objects nobody reads. Navigation is synchronous
 * over what is loaded; array values are read on demand. The result
 * implements the array store (formats/store.js).
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
 * | load.js | objects and group links as they are loaded |
 * | nodes.js | the store's groups and arrays |
 * | context.js, binary.js, checksum.js, errors.js | shared plumbing |
 *
 * @module formats/hdf5
 */

import { FileContext } from './context.js';
import { readSuperblock } from './superblock.js';
import { ObjectLoader } from './load.js';
import { Hdf5Tree } from './nodes.js';
import { Hdf5FormatError, Hdf5UnsupportedError } from './errors.js';
import { cancelled, throwIfAborted } from '../../utils/abort.js';
import { loadSpecsOf } from '../store.js';
import { releaseIdleDecodeWorkers } from '../io/decode-pool.js';

export { Hdf5FormatError, Hdf5UnsupportedError };

const MiB = 1024 * 1024;

/**
 * @typedef {Object} OpenOptions
 * @property {AbortSignal|null} [signal]
 * @property {number|import('../io/decoded-budget.js').DecodedBudget} [decodedChunkCacheBytes] - Budget of the
 *   decoded-chunk cache (default 64 MiB), or one shared with the other caches of the file's decoded chunks
 * @property {boolean} [verifyChecksums] - Check newer-format metadata checksums (default true)
 * @property {import('../io/activity.js').ReadActivity|null} [activity] - Counts what opening reads
 * @property {ReadonlyArray<string|{path: string, depth?: number}>} [load] - Paths loaded with the root
 *   (`Group.load`), each the moment the links naming it are known: what the caller reads first
 */

/**
 * Open an HDF5 file.
 *
 * @param {import('../io/byte-reader.js').ByteReader} reader
 * @param {OpenOptions} [options]
 * @returns {Promise<import('./nodes.js').Hdf5Group & {close: (reason?: Error) => void, stats: () => Object}>}
 */
export async function openHdf5(reader, { signal = null, activity = null, decodedChunkCacheBytes = 64 * MiB, verifyChecksums = true, load = [] } = {}) {
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
  const loader = new ObjectLoader(file, superblock.rootAddress);
  const options = { signal, activity };
  if (superblock.rootSymbolTable?.btreeAddress != null && superblock.rootSymbolTable.heapAddress != null) {
    // The superblock caches the root group's B-tree and heap: its links are
    // asked for with its header.
    loader.cachedTables.set(superblock.rootAddress, superblock.rootSymbolTable);
  }
  if (superblock.extensionAddress !== null) await loader.readExtension(superblock.extensionAddress, options);
  await loader.loadPaths(superblock.rootAddress, loadSpecsOf([{ path: '', depth: 1 }, ...load]), options);
  throwIfAborted(signal);
  const tree = new Hdf5Tree(file, loader);
  const root = tree.root;
  if (root === null || root.kind !== 'group') {
    throw new Hdf5FormatError(`${reader.name}: the root object is not a group.`);
  }
  const after = reader.stats();
  const openStats = Object.freeze({
    milliseconds: performance.now() - started,
    requests: after.requests - before.requests,
    bytes: after.bytes - before.bytes,
    objects: loader.objects.size,
  });
  // `reason`: what the reads still under way reject with (a `closed` cancellation by default).
  root.close = (reason = cancelled('closed', `${file.name} was closed.`)) => {
    file.closed = true;
    // Every read still under way stops (`FileContext` `lifetime`).
    file.lifetime.abort(reason);
    file.cache.clear();
    file.inflight.clear();
    reader.clear();
    // What is being kept of the file (`io/kept-parts.js`) is completed now.
    void reader.close?.();
    releaseIdleDecodeWorkers();
  };
  root.stats = () => ({
    open: openStats,
    // Objects loaded so far: at open, and by every load since.
    objects: loader.objects.size,
    reader: reader.stats(),
    decodedCache: file.cache.stats(),
    superblockVersion: superblock.version,
  });
  return root;
}
