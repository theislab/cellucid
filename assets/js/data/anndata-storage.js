/**
 * Where one open AnnData dataset is stored, as the Dataset box in the
 * Session panel says it: the format, how it is packaged, whether it is read
 * from this computer or in place from a host, its address, and its size when
 * the host or the file system states one.
 *
 * Every fact is read from the source the reader opened (`{file}`: a `File`
 * or a remote file `{url, size}`; `{files, rootName}`: a picked folder;
 * `{url}`: a store folder on a web host) and from what the reader found it
 * to be (its input format, layout and Zarr version); nothing is guessed from
 * a dataset's name.
 *
 * @module data/anndata-storage
 */

import { isInputFormatId } from './input-formats.js';

/**
 * @typedef {Object} AnnDataStorage
 * @property {string} format - The input format id (`data/input-formats.js`)
 * @property {2|3|null} zarrVersion - The Zarr format version, null for any other container
 * @property {'file'|'zip'|'folder'} layout - How the dataset arrived
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
 * @param {Object} source - What `AnnDataReaderClient.open()` was given
 * @param {{format: string, layout: 'file'|'zip'|'folder', name: string, zarrVersion?: 2|3|null}} opened -
 *   What the reader found the source to be and the name it gave it
 * @returns {Readonly<AnnDataStorage>}
 */
export function describeAnnDataStorage(source, { format, layout, name, zarrVersion = null }) {
  if (!isInputFormatId(format)) throw new TypeError(`Unknown input format '${String(format)}'.`);
  const version = zarrVersion === 2 || zarrVersion === 3 ? zarrVersion : null;
  if (source?.file !== undefined) {
    if (layout !== 'file' && layout !== 'zip') throw new TypeError(`One file cannot arrive in a ${String(layout)} layout.`);
    const remote = isRemote(source.file);
    return Object.freeze({
      format,
      zarrVersion: version,
      layout,
      remote,
      url: remote ? withoutQuery(source.file.url) : null,
      name,
      bytes: sizeOf(source.file),
    });
  }
  if (layout !== 'folder') throw new TypeError(`A folder cannot arrive in a ${String(layout)} layout.`);
  if (source?.files instanceof Map) {
    let bytes = 0;
    for (const file of source.files.values()) bytes += sizeOf(file) ?? 0;
    return Object.freeze({
      format,
      zarrVersion: version,
      layout,
      remote: false,
      url: null,
      name,
      bytes,
    });
  }
  if (typeof source?.url === 'string') {
    return Object.freeze({
      format,
      zarrVersion: version,
      layout,
      remote: true,
      url: withoutQuery(source.url),
      name,
      bytes: null,
    });
  }
  throw new TypeError('A dataset source is a file {file}, a folder {files, rootName} or a folder URL {url}.');
}
