/**
 * ZIP archives, read in place.
 *
 * `openZipArchive(reader)` opens an archive through a byte reader
 * (`formats/io`), so a local `File` and a remote archive read with HTTP range
 * requests are the same to it: opening reads the end of the file, and each
 * entry is read (one range for header and data, many entries in parallel)
 * and checked when asked for. `entryMap` and `singleRootFolder` address the
 * entries of a zipped folder by their path inside it.
 *
 * Used by the Zarr store reader (`formats/zarr`, a `.zarr.zip`), by the
 * AnnData opener (`data/anndata/open.js`) and, for its CRC-32, by the
 * figure export.
 *
 * @module formats/zip
 */

export { openZipArchive, entryMap, singleRootFolder } from './archive.js';
export { ZipFormatError, ZipUnsupportedError } from './errors.js';
export { crc32 } from './crc32.js';
export { isMacOSMetadata } from './names.js';
