/**
 * Zarr stores, read in the browser: Zarr v2 and v3, as the store contract
 * (`formats/store.js`) describes them.
 *
 * ```js
 * const root = await openZarr(zipStore(await openZipArchive(createByteReader(blobByteSource(file)))));
 * const X = root.get('X');           // synchronous: the tree is read at open
 * const column = await X.read([[0, X.shape[0]], [5, 6]]);
 * ```
 *
 * Store backends say where keys come from: `directoryStore` (a picked
 * folder), `zipStore` (a `.zarr.zip`, local or remote), `httpStore` (a Zarr
 * folder on a web host, opened from consolidated metadata), `memoryStore`.
 *
 * Codecs: gzip, zlib, Blosc (blosclz, lz4, lz4hc, zlib, zstd; byte and bit
 * shuffle), LZ4, Zstandard, numcodecs shuffle, CRC-32C, variable-length
 * strings and bytes, Zarr v3 `bytes` (either byte order), `transpose` and
 * `sharding_indexed`.
 *
 * @module formats/zarr
 */

export { openZarr } from './open.js';
export { ZarrFormatError, ZarrUnsupportedError } from './errors.js';
export { directoryStore } from './stores/directory.js';
export { zipStore } from './stores/zip.js';
export { httpStore } from './stores/http.js';
export { memoryStore } from './stores/memory.js';
export { blobReader, mappedStore } from './stores/mapped.js';
