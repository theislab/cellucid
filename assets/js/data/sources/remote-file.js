/**
 * One dataset file on a web host, described without downloading it: its
 * format from the file name (`data/input-formats.js`; the reader confirms it
 * from the content), its exact size and the identity the host reports.
 * Providers that open single files (any single-file format: `.h5ad`, Zarr
 * ZIP, `.loom`, `.rds`, …) build their entries with this, so every provider names formats and failures the same way.
 *
 * A file is read in place with range requests. A host that ignores range
 * requests serves only the whole file, and so does one that content-codes
 * the file even in a range (`contentCoded`: a part of it cannot be decoded,
 * `probeHttpResource`): its entry says so (`transport: 'download'`), and
 * the link source downloads it once, showing how much has arrived, then
 * reads it from memory (`downloadRemoteFile`). A host that does
 * not let other sites read its files (CORS) cannot be read at all, and the
 * refusal says so and what to do instead.
 *
 * @module data/sources/remote-file
 */

import { DataSourceError, DataSourceErrorCode, explainedFailure } from '../data-source.js';
import { HEAD_BYTES, probeHttpResource } from '../../formats/io/byte-source.js';
import { fileFormatOfName, inputFormat, openableNamesText, readsFromHead, titleOfName } from '../input-formats.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * The size and identity a host reports for one file, or the refusal that
 * names why it cannot be read. The head of a file whose structure starts at
 * byte 0 (an `.h5ad`: its first read, `HEAD_BYTES`) is read in the same
 * round trip (`readsFromHead`).
 */
async function probeRemoteFile(url, name, format, signal) {
  try {
    return await probeHttpResource(url, {
      signal,
      headBytes: readsFromHead(format) ? HEAD_BYTES : 0,
      // A file read from its start as a stream (an R file is gzip) may be
      // content-coded by its host: that a range of it can be read is proven.
      checkRange: format !== null && inputFormat(format.format).access === 'stream',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const status = error?.status;
    const host = new URL(url).host;
    // Written for the person: the file, its host and what to do.
    throw explainedFailure(
      status === 404 || status === 403
        ? `${name} was not found at ${host} (HTTP ${status}). Check the link, or ask its owner whether it moved.`
        : Number.isInteger(status)
          ? `${host} answered HTTP ${status} for ${name}. Try again later.`
          : `${host} did not let this site read ${name}: it does not allow ` +
            'other websites to read its files (CORS), or it could not be ' +
            'reached. Download the file and open it from your computer instead.',
      status === 404 || status === 403
        ? DataSourceErrorCode.NOT_FOUND
        : DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url, status }
    );
  }
}

/**
 * Probe one remote file and return the entry a link source opens.
 *
 * @param {Object} options
 * @param {string} options.url - Where the bytes are
 * @param {string} options.id - Dataset id; stable for this file wherever it
 *   is opened from, and without '/' (it becomes `anndata://<id>/`)
 * @param {string} options.name - File name, which also declares the format
 *   (`fileFormatOfName`): the entry's `format` is `{format, layout}`
 * @param {string} [options.title] - What the dataset is called when the file
 *   does not name itself (`uns['title']`); its name without the extension
 *   by default (`titleOfName`)
 * @param {Object} options.attribution - `{title, url, licence?, citation?}`
 * @param {string|null} [options.version] - A provider version; else the
 *   host's ETag or size
 * @param {number|null} [options.size] - The exact size, when the provider's
 *   listing gives it: no probe request is made (rate-limited hosts)
 * @param {{bytes: Uint8Array, etag: string|null, ms: number}|null} [options.head]
 *   The file's first bytes, when the provider read them beside its own probe
 *   of the size (`readFileHead`): opening starts from them
 * @param {AbortSignal|null} [options.signal]
 * @param {((step: string) => void)|null} [options.onStep] - Told what is
 *   being done, for the opening progress
 * @returns {Promise<Object>}
 */
export async function describeRemoteFile({
  url,
  id,
  name,
  title = titleOfName(name),
  attribution,
  version = null,
  size = null,
  head = null,
  signal = null,
  onStep = null,
}) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
    throw new TypeError('A remote file id must be a non-empty string without "/".');
  }
  const format = fileFormatOfName(name);
  if (format === null) {
    throw new DataSourceError(
      `${name} is not a file Cellucid opens from a link. Links open ` +
      `${openableNamesText({ layouts: ['file', 'zip'] })}, a Zarr store folder, or a ` +
      'dataset catalog folder holding datasets.json (a URL ending in "/").',
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { url, name }
    );
  }
  const known = Number.isSafeInteger(size) && size >= 0;
  if (!known) onStep?.(`Checking ${name} on ${new URL(url).host}`);
  const probed = known
    ? { size, etag: null, rangeSupported: null, head }
    : await probeRemoteFile(url, name, format, signal);
  return Object.freeze({
    id,
    name,
    title,
    format,
    // A host that ignores range requests, or content-codes the file, serves only the whole file.
    transport: probed.rangeSupported === false ? 'download' : 'ranges',
    attribution: Object.freeze({ ...attribution }),
    resource: Object.freeze({
      url,
      size: probed.size,
      name,
      identity: Object.freeze({
        kind: 'remote',
        key: id,
        version: version ?? probed.etag ?? `size:${probed.size}`,
      }),
      // The file's first bytes, read with the probe: opening starts from them.
      ...(probed.head == null ? {} : { head: Object.freeze({ ...probed.head }) }),
      // Sent content-coded: what arrives is decoded, its size known once it has.
      ...(probed.contentCoded === true ? { contentCoded: true } : {}),
    }),
  });
}

/**
 * Several files on one host that make one dataset together (a MatrixMarket
 * matrix and its feature and barcode lists, listed apart by GEO), as the
 * entry a link source opens: `{id, rootName, title, format, attribution,
 * files}`, `files` a `Map` from each file's name to its remote file
 * (`{url, size, name, identity}`), the source `{files, rootName}` the reader
 * opens. A size the listing states exactly is taken as it is; the others
 * are probed at once, together.
 *
 * @param {Object} options
 * @param {Array<{url: string, name: string, size?: number|null}>} options.files
 * @param {string} options.id - Dataset id, without '/'
 * @param {string} options.rootName - The name of the set, as a folder's
 * @param {string} options.title
 * @param {{format: string, layout: 'folder'}} options.format
 * @param {Object} options.attribution
 * @param {AbortSignal|null} [options.signal]
 * @param {((step: string) => void)|null} [options.onStep]
 * @returns {Promise<Object>}
 */
export async function describeRemoteFileSet({ files, id, rootName, title, format, attribution, signal = null, onStep = null }) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
    throw new TypeError('A remote file set id must be a non-empty string without "/".');
  }
  const unknown = files.filter(file => !(Number.isSafeInteger(file.size) && file.size >= 0));
  if (unknown.length > 0) onStep?.(`Checking ${unknown.map(file => file.name).join(', ')} on ${new URL(unknown[0].url).host}`);
  const described = await Promise.all(files.map(async file => {
    const known = Number.isSafeInteger(file.size) && file.size >= 0;
    const probed = known ? { size: file.size, etag: null } : await probeRemoteFile(file.url, file.name, format, signal);
    return [file.name, Object.freeze({
      url: file.url,
      size: probed.size,
      name: file.name,
      identity: Object.freeze({ kind: 'remote', key: `${id}:${file.name}`, version: probed.etag ?? `size:${probed.size}` }),
      // Sent content-coded: downloaded whole before the set opens.
      ...(probed.contentCoded === true ? { contentCoded: true } : {}),
    })];
  }));
  return Object.freeze({
    id,
    rootName,
    title,
    format: Object.freeze({ ...format }),
    attribution: Object.freeze({ ...attribution }),
    files: new Map(described),
  });
}

/**
 * The one file a link opens from a listing: the requested one, or the only
 * openable one (a name `fileFormatOfName` knows: `.h5ad`, `.zip`). Several openable files are named back, each
 * with the exact locator that opens it, so the person can choose.
 *
 * @param {string[]} names - Every file name the listing holds
 * @param {string|null} requested - The file the link names, if any
 * @param {string} where - The record, series or folder, as the person knows it
 * @param {(name: string) => string} locatorFor - The `?data=` value of a file
 * @returns {string}
 */
export function chooseOpenableFile(names, requested, where, locatorFor) {
  if (requested !== null) {
    if (!names.includes(requested)) {
      throw new DataSourceError(
        `${where} has no file named ${requested}.`,
        DataSourceErrorCode.NOT_FOUND,
        'link',
        { where, requested }
      );
    }
    return requested;
  }
  const openable = names.filter(name => fileFormatOfName(name) !== null);
  if (openable.length === 1) return openable[0];
  if (openable.length === 0) {
    throw new DataSourceError(
      `${where} holds no file Cellucid opens (${openableNamesText({ layouts: ['file', 'zip'] })})` +
      `${names.length > 0 ? `; it has: ${names.join(', ')}` : ''}.`,
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { where, files: names }
    );
  }
  throw new DataSourceError(
    `${where} has ${formatCountOf(openable.length, 'file')} Cellucid opens. Open one of them: ` +
    `${openable.map(locatorFor).join(', ')}.`,
    DataSourceErrorCode.VALIDATION_ERROR,
    'link',
    { where, files: openable }
  );
}

/**
 * Download a whole file from a host that serves no part of it (it ignores
 * range requests, or content-codes the file), as a `File` the AnnData
 * reader then reads from memory. `onBytes(received)` hears each piece as it
 * arrives. A content-coded file arrives decoded, so its length is not the
 * size the host stated.
 *
 * @param {{url: string, name: string, size: number, contentCoded?: boolean}} resource
 * @param {{signal?: AbortSignal|null, onBytes?: (received: number) => void}} [options]
 * @returns {Promise<File>}
 */
export async function downloadRemoteFile(resource, { signal = null, onBytes = () => {} } = {}) {
  const host = new URL(resource.url).host;
  let response;
  try {
    response = await fetch(resource.url, { signal, cache: 'no-store' });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new DataSourceError(
      `${resource.name} could not be downloaded from ${host}: ${error?.message ?? error}.`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url: resource.url }
    );
  }
  if (!response.ok || response.body === null) {
    throw new DataSourceError(
      `${host} answered HTTP ${response.status} for ${resource.name}.`,
      response.status === 404 || response.status === 403
        ? DataSourceErrorCode.NOT_FOUND
        : DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url: resource.url, status: response.status }
    );
  }
  const parts = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onBytes(received);
  }
  if (resource.contentCoded !== true && Number.isSafeInteger(resource.size) && received !== resource.size) {
    throw new DataSourceError(
      `${host} sent ${formatCountOf(received, 'byte')} of ${resource.name}, not the ${resource.size} it reported.`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url: resource.url }
    );
  }
  return new File(parts, resource.name, { type: 'application/octet-stream' });
}
