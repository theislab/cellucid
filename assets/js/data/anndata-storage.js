/**
 * Where one open AnnData dataset is stored, as the Dataset box in the
 * Session panel says it: the format, how it is packaged, whether it is read
 * from this computer or in place from a host, its address, and its size when
 * the host or the file system states one.
 *
 * Every fact is read from the source the reader opened (a `File`, a picked
 * folder, a `.zarr.zip`, a remote file `{url, size}`, a remote Zarr folder
 * `{url}`); nothing is guessed from a dataset's name.
 *
 * @module data/anndata-storage
 */

/**
 * @typedef {Object} AnnDataStorage
 * @property {'h5ad'|'zarr'} format
 * @property {2|3|null} zarrVersion - The Zarr format version, null for h5ad
 * @property {'file'|'zip'|'folder'} container
 * @property {boolean} remote - Read in place from a host, not from this computer
 * @property {string|null} url - The address read from (remote only), without a query string
 * @property {string} name - The file or folder name
 * @property {number|null} bytes - Size of the file, archive or folder, when known
 */

function isRemote(file) {
  return file !== null && typeof file === 'object' && typeof file.url === 'string' &&
    !(typeof Blob !== 'undefined' && file instanceof Blob);
}

function withoutQuery(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

function sizeOf(value) {
  return Number.isSafeInteger(value?.size) && value.size >= 0 ? value.size : null;
}

/**
 * Describe the storage of one dataset from the source its reader opened.
 *
 * @param {'h5ad'|'zarr'} format
 * @param {Object} source - What `AnnDataReaderClient.open()` was given
 * @param {{name: string, zarrVersion?: 2|3|null}} opened - The name the reader
 *   gave the store and, for Zarr, the version it read
 * @returns {Readonly<AnnDataStorage>}
 */
export function describeAnnDataStorage(format, source, { name, zarrVersion = null }) {
  if (format === 'h5ad') {
    const remote = isRemote(source);
    return Object.freeze({
      format,
      zarrVersion: null,
      container: 'file',
      remote,
      url: remote ? withoutQuery(source.url) : null,
      name,
      bytes: sizeOf(source),
    });
  }
  if (format !== 'zarr') throw new TypeError(`Unknown AnnData format '${String(format)}'.`);
  const version = zarrVersion === 2 || zarrVersion === 3 ? zarrVersion : null;
  if (source?.files instanceof Map) {
    let bytes = 0;
    for (const file of source.files.values()) bytes += sizeOf(file) ?? 0;
    return Object.freeze({
      format,
      zarrVersion: version,
      container: 'folder',
      remote: false,
      url: null,
      name,
      bytes,
    });
  }
  if (source?.archive) {
    const remote = isRemote(source.archive);
    return Object.freeze({
      format,
      zarrVersion: version,
      container: 'zip',
      remote,
      url: remote ? withoutQuery(source.archive.url) : null,
      name,
      bytes: sizeOf(source.archive),
    });
  }
  if (typeof source?.url === 'string') {
    return Object.freeze({
      format,
      zarrVersion: version,
      container: 'folder',
      remote: true,
      url: withoutQuery(source.url),
      name,
      bytes: null,
    });
  }
  throw new TypeError('A Zarr store source must be a folder, an archive or a URL.');
}
