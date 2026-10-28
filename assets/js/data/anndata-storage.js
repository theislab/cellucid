/**
 * Where one open AnnData dataset is stored, as the Dataset box in the
 * Session panel says it: the format, how it is packaged, whether it is read
 * from this computer or in place from a host, its address, and its size when
 * the host or the file system states one.
 *
 * Every fact is read from the source the reader opened (`{file}`: a `File`
 * or a remote file `{url, size}`; `{files, rootName}`: a picked folder, or
 * remote files that make one dataset;
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
 * @property {Readonly<{kept: 'opfs'|'memory', persistent: boolean, whole: boolean, reused: boolean, notes: readonly string[]}>|null} conversion -
 *   For a format read once into this browser (`anndata/transcode/`): where
 *   the store is kept for the tab's life, whether an earlier opening in the
 *   tab had kept it, and what was not read; null for every other format
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

/** A reader's conversion facts, checked and frozen (null when there are none). */
function conversionOf(conversion) {
  if (conversion === null || conversion === undefined) return null;
  const { kept, persistent, whole, reused, notes } = conversion;
  if ((kept !== 'opfs' && kept !== 'memory') || typeof persistent !== 'boolean' || typeof whole !== 'boolean' ||
    typeof reused !== 'boolean' || !Array.isArray(notes) || notes.some(note => typeof note !== 'string')) {
    throw new TypeError(
      'A conversion says where it is kept (opfs or memory), whether for later visits, whether the file was read whole, ' +
      'whether it was reused, and its notes.'
    );
  }
  return Object.freeze({ kept, persistent, whole, reused, notes: Object.freeze([...notes]) });
}

function sizeOf(value) {
  return Number.isSafeInteger(value?.size) && value.size >= 0 ? value.size : null;
}

/**
 * Describe the storage of one dataset from the source its reader opened.
 *
 * @param {Object} source - What `AnnDataReaderClient.open()` was given
 * @param {{format: string, layout: 'file'|'zip'|'folder', name: string, zarrVersion?: 2|3|null,
 *   conversion?: Object|null}} opened - What the reader found the source to
 *   be, the name it gave it, and, for a format read once, its conversion
 * @returns {Readonly<AnnDataStorage>}
 */
export function describeAnnDataStorage(source, { format, layout, name, zarrVersion = null, conversion = null }) {
  if (!isInputFormatId(format)) throw new TypeError(`Unknown input format '${String(format)}'.`);
  const version = zarrVersion === 2 || zarrVersion === 3 ? zarrVersion : null;
  const converted = conversionOf(conversion);
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
      conversion: converted,
    });
  }
  if (layout !== 'folder') throw new TypeError(`A folder cannot arrive in a ${String(layout)} layout.`);
  if (source?.files instanceof Map) {
    let bytes = 0;
    for (const file of source.files.values()) bytes += sizeOf(file) ?? 0;
    // Files on a host that make one dataset (`loadRemoteFileSet`): the
    // address is the folder the first of them is in.
    const [first] = source.files.values();
    const remote = isRemote(first);
    return Object.freeze({
      format,
      zarrVersion: version,
      layout,
      remote,
      url: remote ? withoutQuery(new URL('.', first.url).href) : null,
      name,
      bytes,
      conversion: converted,
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
      conversion: converted,
    });
  }
  throw new TypeError('A dataset source is a file {file}, a folder {files, rootName} or a folder URL {url}.');
}
