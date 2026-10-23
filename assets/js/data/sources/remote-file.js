/**
 * One AnnData file on a web host, described without downloading it: its
 * format from the file name, its exact size and the identity the host
 * reports. Providers that open single files (`.h5ad`, Zarr ZIP) build their
 * entries with this, so every provider names formats and failures the same
 * way.
 *
 * @module data/sources/remote-file
 */

import { DataSourceError, DataSourceErrorCode } from '../data-source.js';
import { HEAD_BYTES, probeHttpResource } from '../../formats/io/byte-source.js';

/**
 * The file format a name declares, or null. A `.zip` is a zipped Zarr store
 * (`.zarr.zip`).
 *
 * @param {string} name
 * @returns {'h5ad'|'zip'|null}
 */
export function fileFormatOf(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.h5ad')) return 'h5ad';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
}

/**
 * What a file is called when it does not name itself: its name without the
 * format's extension (`atlas.zarr.zip` is "atlas").
 *
 * @param {string} name
 * @returns {string}
 */
export function fileTitleOf(name) {
  return String(name).replace(/\.(h5ad|zarr\.zip|zip)$/i, '');
}

/**
 * The size and identity a host reports for one file, or the refusal that
 * names why it cannot be read. The head of an `.h5ad` (its first read,
 * `HEAD_BYTES`) is read in the same round trip.
 */
async function probeRemoteFile(url, name, format, signal) {
  try {
    return await probeHttpResource(url, { signal, headBytes: format === 'h5ad' ? HEAD_BYTES : 0 });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const status = error?.status;
    throw new DataSourceError(
      status === 404 || status === 403
        ? `${name} was not found at ${new URL(url).host} (HTTP ${status}).`
        : `${name} could not be read from ${new URL(url).host}: ` +
          `${error?.message ?? error}. The host must allow cross-origin reads ` +
          'from this site (CORS).',
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
 *   is opened from, and without '/' (it becomes `h5ad://<id>/`)
 * @param {string} options.name - File name, which also declares the format
 * @param {string} [options.title] - What the dataset is called when the file
 *   does not name itself (`uns['title']`); its name without the extension
 *   by default
 * @param {Object} options.attribution - `{title, url, licence?, citation?}`
 * @param {string|null} [options.version] - A provider version; else the
 *   host's ETag or size
 * @param {number|null} [options.size] - The exact size, when the provider's
 *   listing gives it: no probe request is made (rate-limited hosts)
 * @param {{bytes: Uint8Array, etag: string|null, ms: number}|null} [options.head]
 *   The file's first bytes, when the provider read them beside its own probe
 *   of the size (`readFileHead`): opening starts from them
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Object>}
 */
export async function describeRemoteFile({
  url,
  id,
  name,
  title = fileTitleOf(name),
  attribution,
  version = null,
  size = null,
  head = null,
  signal = null,
}) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
    throw new TypeError('A remote file id must be a non-empty string without "/".');
  }
  const format = fileFormatOf(name);
  if (format === null) {
    throw new DataSourceError(
      `${name} is not a file Cellucid opens from a link. Links open an .h5ad ` +
      'file, a zipped Zarr store (.zarr.zip), a Zarr store folder, or a ' +
      'dataset catalog folder holding datasets.json (a URL ending in "/").',
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { url, name }
    );
  }
  const probed = Number.isSafeInteger(size) && size >= 0
    ? { size, etag: null, rangeSupported: null, head }
    : await probeRemoteFile(url, name, format, signal);
  if (probed.rangeSupported === false) {
    throw new DataSourceError(
      `${new URL(url).host} ignores range requests, so ${name} cannot be ` +
      'read in place.',
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { url }
    );
  }
  return Object.freeze({
    id,
    name,
    title,
    format,
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
      ...(probed.head === null ? {} : { head: Object.freeze({ ...probed.head }) }),
    }),
  });
}

/**
 * The one file a link opens from a listing: the requested one, or the only
 * openable one (`.h5ad`, `.zip`). Several openable files are named back, each
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
  const openable = names.filter(name => fileFormatOf(name) !== null);
  if (openable.length === 1) return openable[0];
  if (openable.length === 0) {
    throw new DataSourceError(
      `${where} holds no file Cellucid opens (an .h5ad, or a zipped Zarr ` +
      `store)${names.length > 0 ? `; it has: ${names.join(', ')}` : ''}.`,
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { where, files: names }
    );
  }
  throw new DataSourceError(
    `${where} has ${openable.length} files Cellucid opens. Open one of them: ` +
    `${openable.map(locatorFor).join(', ')}.`,
    DataSourceErrorCode.VALIDATION_ERROR,
    'link',
    { where, files: openable }
  );
}
