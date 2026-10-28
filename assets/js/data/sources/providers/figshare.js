/**
 * Figshare items: a dataset file (any single-file input format: an `.h5ad`,
 * a Zarr ZIP, a `.loom`, …) published on figshare.com or an institution's
 * Figshare portal, read in place. Figshare's API and its file
 * host answer other sites (CORS): the item comes from `api.figshare.com`, and
 * each file from `ndownloader.figshare.com`, which redirects to a signed S3
 * link that serves ranges for ten seconds.
 *
 * `ndownloader` sits behind an AWS WAF that answers some requests with a bot
 * challenge (HTTP 202, `x-amzn-waf-action: challenge`) instead of the
 * redirect, and no other site's page can answer it. Measured on 2026-10-23:
 * Chromium's page passes and its workers do not (a worker's request carries
 * no client hints), WebKit passes from both, headless Chromium never passes.
 * So the page asks `ndownloader` for the signed link and hands it to the
 * reader (`sources/access.js`); the reader reads S3 only, which has no such
 * check, and asks the page for a new link when the old one's stated lifetime
 * (`X-Amz-Expires`) is over or S3 refuses it (403): one small request per
 * ten seconds of reading, shared by every read under way.
 *
 * Accepts `figshare:<item>[v<version>][/<file>]` (a file by name, or by its
 * Figshare file id), an item page (`figshare.com/articles/<type>/<slug>/<id>
 * [/<version>][?file=<file id>]`, also on `<institution>.figshare.com`), an
 * API address, a Figshare DOI (`10.6084/m9.figshare.<id>[.v<n>]`), and any
 * other DOI, which `doi.org` resolves to the item it names.
 *
 * The file's first read is made here, as the opening's second request (or
 * beside the item when the link names the file by id): it brings the first
 * signed link, and a bot challenge is said for what it is.
 *
 * A published version of an item never changes, so its files need no check
 * for changes. Private links (`figshare.com/s/…`) have no public API and sit
 * behind a bot challenge: they are refused with that reason, as are bare file
 * download links (an item names a file's size and name).
 *
 * @module data/sources/providers/figshare
 */

import { DataSourceError, DataSourceErrorCode } from '../../data-source.js';
import { chooseOpenableFile, describeRemoteFile } from '../remote-file.js';
import { requestJson } from '../api-request.js';
import { registerSourceAccess } from '../access.js';
import { HEAD_BYTES, headOfFile, readFileHead, statedLifetimeMs } from '../../../formats/io/byte-source.js';

const API = 'https://api.figshare.com/v2';
const DOWNLOADER = 'https://ndownloader.figshare.com/files/';
const ITEM = /^([1-9][0-9]*)(?:v([1-9][0-9]*))?(?:\/(.+))?$/;
const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.[0-9]{4,9}\/[^\s]+)$/i;
const FIGSHARE_DOI = /^10\.6084\/m9\.figshare\.([1-9][0-9]*)(?:\.v([1-9][0-9]*))?$/i;

function safeFileName(name) {
  return typeof name === 'string' && name.length > 0 && !/[\u0000-\u001f\u007f/]/.test(name);
}

function item(id, version = null, file = null) {
  return `${id}${version === null ? '' : `v${version}`}${file === null ? '' : `/${file}`}`;
}

function isFigshareHost(host) {
  return host === 'figshare.com' || host.endsWith('.figshare.com');
}

/**
 * The canonical value of a Figshare reference, or null: `<item>[v<n>][/<file>]`,
 * `doi:<doi>` (resolved when opened), `private:<link>`, `file:<id>`.
 */
export function parseFigshare(input, explicit = true) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (explicit) {
    const plain = ITEM.exec(text);
    if (plain !== null) {
      if (plain[3] !== undefined && !safeFileName(plain[3])) return null;
      return item(plain[1], plain[2] ?? null, plain[3] ?? null);
    }
    if (/^(doi|private|file):/.test(text)) return text;
  }
  const doi = DOI.exec(text);
  if (doi !== null) {
    const figshare = FIGSHARE_DOI.exec(doi[1]);
    if (figshare !== null) return item(figshare[1], figshare[2] ?? null);
    // Zenodo's DOIs are Zenodo's (`zenodo.js`, matched before this one).
    if (/^10\.5281\//.test(doi[1])) return null;
    return `doi:${doi[1]}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!isFigshareHost(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 's' && parts.length === 2) return `private:${parts[1]}`;
  const downloader = host === 'ndownloader.figshare.com' ? parts : parts[0] === 'ndownloader' ? parts.slice(1) : null;
  if (downloader !== null) {
    return downloader[0] === 'files' && /^[1-9][0-9]*$/.test(downloader[1] ?? '') ? `file:${downloader[1]}` : null;
  }
  let id = null;
  let version = null;
  if (host === 'api.figshare.com') {
    const api = /^\/v2\/articles\/([1-9][0-9]*)(?:\/versions\/([1-9][0-9]*))?\/?$/.exec(url.pathname);
    if (api === null) return null;
    [, id, version = null] = api;
  } else {
    if (parts[0] !== 'articles') return null;
    // /articles/<id>, /articles/<type>/<slug>/<id>[/<version>]
    const numbers = parts.slice(1).map(part => (/^[1-9][0-9]*$/.test(part) ? part : null));
    const at = numbers.findIndex(value => value !== null);
    if (at < 0) return null;
    id = numbers[at];
    version = numbers[at + 1] ?? null;
  }
  const file = url.searchParams.get('file');
  return item(id, version, file !== null && /^[1-9][0-9]*$/.test(file) ? file : null);
}

function refusal(message, code, details) {
  return new DataSourceError(message, code, 'link', details);
}

/** Whether `ndownloader` answered with its bot challenge instead of the file. */
function isChallenge(response) {
  return response.status === 202 || response.headers.has('x-amzn-waf-action');
}

function challengeRefusal(name) {
  return refusal(
    `Figshare's file host refused this browser with a bot check, so ${name} cannot be read here. ` +
    'Try again in a minute, open it in another browser, or download it from Figshare and open it from your computer.',
    DataSourceErrorCode.NETWORK_ERROR,
    { reason: 'bot-check' }
  );
}

/**
 * The signed S3 link of one file, from `ndownloader` (a range read of
 * `length` bytes that follows the redirect): `{read, target}`, `target`
 * `{url, expiresAt?}` with the link's stated lifetime counted from when it
 * was asked for, less the time the answer took.
 */
async function signedRead(fileId, name, length, signal) {
  const sentAt = Date.now();
  const read = await readFileHead(`${DOWNLOADER}${fileId}`, length, { signal });
  if (isChallenge(read.response)) throw challengeRefusal(name);
  const url = read.response.url;
  if (read.response.status !== 206 || typeof url !== 'string' || url === '') {
    throw refusal(
      `Figshare did not send ${name} (HTTP ${read.response.status}). Try again in a minute.`,
      DataSourceErrorCode.NETWORK_ERROR,
      { fileId, status: read.response.status }
    );
  }
  const lifetime = statedLifetimeMs(url);
  return {
    read,
    target: { url, ...(lifetime === null ? {} : { expiresAt: sentAt + lifetime - (Date.now() - sentAt) }) },
  };
}

/** The reader's access to one file: the signed link, renewed by the page when it runs out. */
function signedAccess(fileId, name, first) {
  let current = first;
  return registerSourceAccess({
    provider: 'figshare',
    // S3 refuses an expired signature with 403.
    stale: [403],
    target: async ({ refresh }) => {
      const usable = current !== null && !(Number.isFinite(current.expiresAt) && Date.now() >= current.expiresAt);
      if (!refresh && usable) return current;
      current = (await signedRead(fileId, name, 1, null)).target;
      return current;
    },
  });
}

/** The item a DOI names, resolved by doi.org (one request, which allows other sites). */
async function resolveDoi(doi, signal) {
  const answer = await requestJson(`https://doi.org/api/handles/${encodeURI(doi)}`, {
    label: `doi.org (${doi})`,
    signal,
  });
  if (answer.status === 404 || answer.body?.responseCode === 100) {
    throw refusal(`The DOI ${doi} does not exist.`, DataSourceErrorCode.NOT_FOUND, { doi });
  }
  const landing = answer.body?.values?.find(value => value.type === 'URL')?.data?.value ?? null;
  const value = typeof landing === 'string' ? parseFigshare(landing, false) : null;
  if (value === null || !ITEM.test(value)) {
    let host = 'its landing page';
    try {
      host = new URL(landing).host;
    } catch {
      // as named
    }
    throw refusal(
      `The DOI ${doi} names a record on ${host}, which is not a Figshare item. ` +
      'Cellucid opens DOIs of Zenodo records and Figshare items, or a link to the file itself.',
      DataSourceErrorCode.UNSUPPORTED,
      { doi }
    );
  }
  return value;
}

export default Object.freeze({
  id: 'figshare',
  label: 'Figshare',
  capabilities: Object.freeze({
    folders: false,
    private: 'none',
    versions: true,
    write: false,
  }),
  match(input, { explicit = true } = {}) {
    return parseFigshare(input, explicit);
  },
  async open(value, { signal = null, onStep = null } = {}) {
    let parsed = parseFigshare(value);
    if (parsed === null) {
      throw refusal(`"${value}" is not a Figshare item, DOI or file link.`, DataSourceErrorCode.INVALID_FORMAT, { input: value });
    }
    if (parsed.startsWith('private:')) {
      throw refusal(
        'This is a private Figshare link (figshare.com/s/…). Figshare offers no way for a browser to read a ' +
        'private link, so Cellucid opens published items only. Publish the item, or download the file and ' +
        'open it from your computer.',
        DataSourceErrorCode.PERMISSION_DENIED,
        { input: value }
      );
    }
    if (parsed.startsWith('file:')) {
      throw refusal(
        'This is a Figshare file download link. Paste the item\'s page or DOI instead: the item names the ' +
        'file\'s size and name, which Cellucid needs to read it in place.',
        DataSourceErrorCode.UNSUPPORTED,
        { input: value }
      );
    }
    // Another publisher's DOI is named, once resolved, by the item it names.
    const fromDoi = parsed.startsWith('doi:');
    if (fromDoi) {
      onStep?.(`Resolving ${parsed.slice(4)}`);
      parsed = await resolveDoi(parsed.slice(4), signal);
    }
    const [, id, version = null, requested = null] = ITEM.exec(parsed);
    const fileId = requested !== null && /^[1-9][0-9]*$/.test(requested) ? requested : null;
    // A file named by its id is read beside the item: its first bytes are
    // the file's first read (an `.h5ad` opens from them).
    const early = new AbortController();
    const earlySignal = signal === null ? early.signal : AbortSignal.any([signal, early.signal]);
    const headRead = fileId === null ? null : signedRead(fileId, `file ${fileId}`, HEAD_BYTES, earlySignal);
    headRead?.catch(() => {});
    const answer = await requestJson(`${API}/articles/${id}${version === null ? '' : `/versions/${version}`}`, {
      label: `Figshare item ${id}`,
      signal,
    }).catch(error => {
      early.abort(error);
      throw error;
    });
    if (!answer.ok) {
      early.abort(new DOMException('The item could not be read.', 'AbortError'));
      throw refusal(
        answer.status === 404
          ? `Figshare item ${id}${version === null ? '' : ` version ${version}`} does not exist or is not public.`
          : `Figshare item ${id} could not be read (HTTP ${answer.status}).`,
        answer.status === 404 ? DataSourceErrorCode.NOT_FOUND : DataSourceErrorCode.NETWORK_ERROR,
        { id, status: answer.status }
      );
    }
    const record = answer.body ?? {};
    const files = (Array.isArray(record.files) ? record.files : [])
      .filter(file => file?.is_link_only !== true && safeFileName(file?.name) && Number.isSafeInteger(file?.id));
    const where = `Figshare item ${id}`;
    const opened = Number.isSafeInteger(record.version) ? record.version : version;
    const byId = fileId === null ? null : files.find(file => String(file.id) === fileId) ?? null;
    if (fileId !== null && byId === null) {
      early.abort(new DOMException('Another file is read instead.', 'AbortError'));
      throw refusal(`${where} has no file with id ${fileId}.`, DataSourceErrorCode.NOT_FOUND, { id, fileId });
    }
    const name = byId?.name ?? chooseOpenableFile(
      files.map(file => file.name),
      fileId === null ? requested : null,
      where,
      fileName => `figshare:${item(id, version, fileName)}`
    );
    const entry = byId ?? files.find(file => file.name === name);
    // The file's first read, here rather than in the reader (the same round
    // trip): it brings the signed link the reader reads from.
    onStep?.(`Reading the start of ${name} from Figshare`);
    let first;
    try {
      first = await (headRead ?? signedRead(entry.id, name, HEAD_BYTES, signal));
    } catch (error) {
      if (signal?.aborted || error instanceof DataSourceError) {
        throw error instanceof DataSourceError && error.details?.reason === 'bot-check' ? challengeRefusal(name) : error;
      }
      throw refusal(
        `Figshare's file host could not be reached for ${name}. Check your connection and try again.`,
        DataSourceErrorCode.NETWORK_ERROR,
        { id, fileId: entry.id }
      );
    }
    const head = headOfFile(first.read, entry.size, HEAD_BYTES);
    const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : `Figshare ${id}`;
    const file = await describeRemoteFile({
      url: `${DOWNLOADER}${entry.id}`,
      // The item and the file's name, across versions: sessions and
      // annotations follow a dataset to its next version; the version and
      // checksum say which one is open.
      id: `figshare:${id}:${encodeURIComponent(name)}`,
      name,
      title,
      size: Number.isSafeInteger(entry.size) ? entry.size : null,
      head,
      // A validator only where Figshare states one (the version opened, the
      // file's checksum): without either the file is known by its size alone.
      version: opened == null && !entry.computed_md5 ? null : `figshare:${id}v${opened ?? ''}:${entry.computed_md5 ?? ''}`,
      attribution: {
        title,
        url: typeof record.figshare_url === 'string' ? record.figshare_url : `https://figshare.com/articles/${id}`,
        ...(typeof record.doi === 'string' && record.doi ? { citation: `doi:${record.doi}` } : {}),
        ...(typeof record.license?.name === 'string' ? { licence: record.license.name } : {}),
      },
      signal,
      onStep,
    });
    const readable = { ...file, resource: Object.freeze({ ...file.resource, access: signedAccess(entry.id, name, first.target) }) };
    return { title, file: readable, attribution: readable.attribution, ...(fromDoi ? { locator: parsed } : {}) };
  },
});
