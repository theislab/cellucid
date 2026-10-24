/**
 * Zenodo records: an `.h5ad` or a Zarr ZIP deposited
 * in a record, read in place from Zenodo's file API (which allows cross-origin
 * range reads; the website's download links do not). A record id names one
 * version; a concept DOI or concept record id opens the latest version.
 *
 * Accepts `zenodo:<record>[/<file>]`, a record page
 * (`zenodo.org/records/<id>`), a DOI (`10.5281/zenodo.<id>`, `doi.org/...`),
 * or a file link (`zenodo.org/records/<id>/files/<file>`). Zenodo limits
 * anonymous requests per minute, so the record's own listing gives each file's
 * size and checksum and no probe request is made.
 *
 * A link that names its file opens in one round trip: the file's first bytes
 * (an `.h5ad`'s first read) are asked for beside the record, which opening
 * needs anyway, and are used when the record is the version the link names.
 * Zenodo does not show its `Content-Range` to other sites, so the size always
 * comes from the record.
 *
 * @module data/sources/providers/zenodo
 */

import { DataSourceError, DataSourceErrorCode, fetchWhenNotBusy } from '../../data-source.js';
import { chooseOpenableFile, describeRemoteFile, fileFormatOf } from '../remote-file.js';
import { HEAD_BYTES, headOfFile, readFileHead } from '../../../formats/io/byte-source.js';

const API = 'https://zenodo.org/api/records/';
const RECORD = /^[1-9][0-9]*$/;

function safeFileName(name) {
  return typeof name === 'string' && name.length > 0 && !/[\u0000-\u001f\u007f]/.test(name);
}

/**
 * `<record>` or `<record>/<file>`, or null. A bare record number is only
 * Zenodo's after `zenodo:` (`explicit`); a DOI or zenodo.org link always is.
 */
function parseZenodo(input, explicit = true) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const plain = explicit ? /^([1-9][0-9]*)(?:\/(.+))?$/.exec(text) : null;
  if (plain !== null) {
    return plain[2] === undefined ? plain[1] : (safeFileName(plain[2]) ? `${plain[1]}/${plain[2]}` : null);
  }
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.5281\/zenodo\.([1-9][0-9]*)$/i.exec(text);
  if (doi !== null) return doi[1];
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'zenodo.org' && host !== 'www.zenodo.org') return null;
  const match = /^\/(?:api\/)?records?\/([1-9][0-9]*)(?:\/files\/([^/]+)(?:\/content)?)?\/?$/
    .exec(url.pathname);
  if (match === null) return null;
  if (match[2] === undefined) return match[1];
  const file = decodeURIComponent(match[2]);
  return safeFileName(file) ? `${match[1]}/${file}` : null;
}

export default Object.freeze({
  id: 'zenodo',
  label: 'Zenodo',
  capabilities: Object.freeze({
    folders: false,
    private: 'none',
    versions: true,
    write: false,
  }),
  match(input, { explicit = true } = {}) {
    return parseZenodo(input, explicit);
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const parsed = parseZenodo(value);
    if (parsed === null) {
      throw new DataSourceError(
        `"${value}" is not a Zenodo record, DOI or file link.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    const [recordId, requested = null] = parsed.split(/\/(.*)/s);
    const fileUrl = (version, name) => `${API}${version}/files/${encodeURIComponent(name)}/content`;
    // The named file's first read goes out with the record request.
    const early = new AbortController();
    const earlySignal = signal === null ? early.signal : AbortSignal.any([signal, early.signal]);
    const headRead = requested !== null && fileFormatOf(requested) === 'h5ad'
      ? readFileHead(fileUrl(recordId, requested), HEAD_BYTES, { signal: earlySignal })
      : null;
    headRead?.catch(() => {});
    // A concept record redirects to its latest version, so the record read
    // here names the exact version that opens.
    let response;
    try {
      response = await fetchWhenNotBusy(`${API}${recordId}`, { signal });
    } catch (error) {
      early.abort(error);
      throw error;
    }
    if (!response.ok) {
      early.abort(new DOMException('The record could not be read.', 'AbortError'));
      throw new DataSourceError(
        response.status === 404 || response.status === 410
          ? `Zenodo record ${recordId} does not exist or is not public.`
          : `Zenodo record ${recordId} could not be read (HTTP ${response.status}). ` +
            'Check the record number on zenodo.org, or try again later.',
        response.status === 404 || response.status === 410
          ? DataSourceErrorCode.NOT_FOUND
          : DataSourceErrorCode.NETWORK_ERROR,
        'link',
        { recordId, status: response.status }
      );
    }
    const record = await response.json();
    const version = String(record.id);
    if (!RECORD.test(version) || !Array.isArray(record.files)) {
      throw new DataSourceError(
        `Zenodo record ${recordId} has no file listing.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { recordId }
      );
    }
    const files = new Map(record.files.map(file => [file.key, file]));
    const name = chooseOpenableFile(
      [...files.keys()],
      requested,
      `Zenodo record ${version}`,
      fileName => `zenodo:${version}/${fileName}`
    );
    const entry = files.get(name);
    const size = Number.isSafeInteger(entry.size) ? entry.size : null;
    // The early read is this file's head when the link named this version.
    let head = null;
    if (headRead !== null && version === recordId && name === requested && size !== null) {
      try {
        head = headOfFile(await headRead, size, HEAD_BYTES);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    } else {
      early.abort(new DOMException('Another version is read instead.', 'AbortError'));
    }
    const metadata = record.metadata ?? {};
    const title = typeof metadata.title === 'string' && metadata.title.trim()
      ? metadata.title.trim()
      : `Zenodo ${version}`;
    const file = await describeRemoteFile({
      url: fileUrl(version, name),
      // The concept id names the deposit across versions, so sessions and
      // annotations follow a dataset to its next version; the version id and
      // checksum say which one is open.
      id: `zenodo:${record.conceptrecid ?? version}:${encodeURIComponent(name)}`,
      name,
      title,
      size,
      head,
      version: `zenodo:${version}:${entry.checksum ?? ''}`,
      attribution: {
        title,
        url: `https://zenodo.org/records/${version}`,
        ...(typeof record.doi === 'string' ? { citation: `doi:${record.doi}` } : {}),
        ...(typeof metadata.license?.id === 'string' ? { licence: metadata.license.id } : {}),
      },
      signal,
      onStep,
    });
    return { title, file, attribution: file.attribution };
  },
});
