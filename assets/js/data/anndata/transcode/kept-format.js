/**
 * What a directory kept in this browser is: the names of its files, what it
 * is filed under, what its manifest says, and how the page checksums of its
 * files are kept beside them. Every function here is pure: none reads or
 * writes storage or holds a lock. `space.js` does that with them (it keeps
 * the directories: locks, room, listing, removal), so what a kept directory
 * holds is decided here and in the modules this one imports, and nowhere
 * else.
 *
 * **Every kind's code fingerprint covers this module**
 * (`scripts/kept-code-fingerprints.mjs`): a change to its code (comments
 * aside) makes this browser remove what it kept of every kind (converted
 * stores, gene indexes, files downloaded whole, the downloaded parts of
 * files) and make it again. Keep here only what decides a kept directory's
 * bytes or how they are checked; a kind's own contents are its own
 * module's (`kept-journal.js`: a journal's records; the transcoders; the
 * gene index).
 *
 * @module data/anndata/transcode/kept-format
 */

import { CHECK_PAGE_BYTES, checksumBytes, checksumOf, checksumsFit, checksumsFromBytes } from '../../../formats/io/page-checks.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { linkIdentity } from '../../sources/link-credentials.js';
import { addressOf, fileIdentityOf } from '../../sources/identity.js';

/** The file whose presence makes a directory complete: what it is, filed under what, listing which files. */
export const MANIFEST = 'manifest.json';
/** The file arrays derived by a pass are appended to; a journal's bytes. */
export const DERIVED = 'd.bin';
/** The file whose text is when a directory was last opened (ms since the epoch). */
export const LAST_USED = 'used';
/** The file a kept download is. */
export const DOWNLOADED = 'source';
/** The records of a kept journal (`kept-journal.js`): where each piece of its bytes (`d.bin`) is of its file. */
export const JOURNAL = 'j.bin';

/** JSON of a value with every object's keys in order: one text per identity. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * One field of an identity as it is filed: a link, in any of the forms an
 * identity names one (a remote file's `url`, a provider key that is a link,
 * `url:<encoded address>`), as its identity (`linkIdentity`: no credential).
 */
function filedField(name, value) {
  if (typeof value !== 'string') return value;
  if (name === 'url') return linkIdentity(value);
  if (name === 'key' && value.startsWith('url:')) {
    let href;
    try {
      href = decodeURIComponent(value.slice(4));
    } catch {
      return value;
    }
    return `url:${encodeURIComponent(linkIdentity(href))}`;
  }
  return value;
}

/**
 * What a kept store is filed under: the source's identity, every link in it
 * without its credential parameters (a link signed again is the same file).
 */
export function cacheKey(identity) {
  if (identity === null || typeof identity !== 'object') return identity ?? null;
  if (Array.isArray(identity)) return identity.map(cacheKey);
  const out = {};
  for (const [name, value] of Object.entries(identity)) {
    out[name] = value !== null && typeof value === 'object' ? cacheKey(value) : filedField(name, value);
  }
  return out;
}

/** Hex SHA-256 of a source's cache key: the manifest names it whole, a directory by its start. */
export async function identityDigest(identity) {
  return sha256Hex(new TextEncoder().encode(canonicalJson(cacheKey(identity))));
}

/** What a kept download is filed under: apart from the store of the same file, filed under the file's own identity. */
export const downloadIdentity = identity => ({ download: identity });

/**
 * What every kept directory's manifest says of the file it is of, besides
 * the digest of what it is filed under (`key`): the file's digest
 * (`fileKey`: its identity, version included) and its address's
 * (`address`: `addressOf`, null for a file on this computer), so that the
 * kept copies of every kind of another version of the same file are found
 * (`space.js` `forgetOtherVersions`).
 */
export async function fileFields(identity) {
  const file = fileIdentityOf(identity);
  const address = addressOf(file);
  return { fileKey: await identityDigest(file), address: address === null ? null : await identityDigest(address) };
}

/** How much of an identity's digest a directory name starts with. */
const KEY_NAME_DIGITS = 24;

/** How much of an address's digest a directory name carries (`namedForAddress`). */
const ADDRESS_NAME_DIGITS = 12;

/**
 * A directory name for a source: its digest's start, its file's address's
 * (`addressOf`; `local` for a file on this computer), then a random part.
 */
export async function directoryFor(identity) {
  const address = addressOf(identity);
  const at = address === null ? 'local' : (await identityDigest(address)).slice(0, ADDRESS_NAME_DIGITS);
  return `${(await identityDigest(identity)).slice(0, KEY_NAME_DIGITS)}-${at}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** What the name of every directory filed under the identity whose digest is `digest` starts with (`directoryFor`). */
export const directoryPrefix = digest => `${digest.slice(0, KEY_NAME_DIGITS)}-`;

/** Whether a directory's name says it is of the file at the address whose digest is `address` (`directoryFor`). */
export const namedForAddress = (name, address) => name.slice(KEY_NAME_DIGITS).startsWith(`-${address.slice(0, ADDRESS_NAME_DIGITS)}-`);

/**
 * What a kept directory is, for the person who manages what is kept: the
 * file's name (a file's or a folder's, else the last part of a link's path)
 * and its host (null for a file on this computer). Never a link: a signed
 * link's query (its credentials) and its path are not kept. Recorded in the
 * manifest as `about` by whoever keeps a directory.
 *
 * @param {{name?: string|null, url?: string|null}} [source]
 * @returns {{name: string|null, host: string|null}}
 */
export function keptAbout({ name = null, url = null } = {}) {
  // A name that is itself a link says only what a link does.
  const nameIsLink = typeof name === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(name);
  let host = null;
  let last = null;
  try {
    const parsed = new URL(url ?? (nameIsLink ? name : null));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      host = parsed.host;
      const part = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
      try {
        last = decodeURIComponent(part) || null;
      } catch {
        last = part || null;
      }
    }
  } catch {
    // Not a link: a file on this computer.
  }
  return { name: typeof name === 'string' && name !== '' && !nameIsLink ? name : last, host };
}

/**
 * A kept directory's manifest: what its keeper says of it (`said`: its
 * kind, the file it is of, what it holds), the fingerprint of the code that
 * wrote it (`codeFingerprint`: a directory stamped by other code is removed,
 * never read), whether it is kept for later visits (`persist`; else the
 * `tab` it belongs to), the digests it is filed under (`key`, never the
 * identity itself; `fileKey` and `address`: `fileFields`), when it was made,
 * and, for a directory whose contents are files it lists (a journal's are
 * its records), the size of every one (`blobs`) and what is recorded of
 * their page checksums (`checks`: `checkTables`).
 *
 * @param {Object} said
 * @param {Object|null} identity - What it is filed under
 * @param {{codeFingerprint: string, persistent: boolean, tab: string, blobs?: Object<string, number>,
 *   checks?: {pageBytes: number, files: Object<string, number>}}} filed
 * @returns {Promise<Object>}
 */
export async function keptManifest(said, identity, { codeFingerprint, persistent, tab, blobs, checks }) {
  return {
    ...said,
    codeFingerprint,
    persist: persistent,
    ...(persistent ? {} : { tab }),
    key: await identityDigest(identity),
    ...await fileFields(identity),
    createdAt: Date.now(),
    ...(blobs === undefined ? {} : { blobs }),
    ...(checks === undefined ? {} : { checks }),
  };
}

/** Whether a manifest's blobs are read through page checksums: a gene index checks each gene's piece instead. */
export const pageChecked = manifest => manifest?.kind !== 'column-index';

/** The file a kept blob's page checksums are in (`formats/io/page-checks.js`). */
const sumsFileOf = name => `${name}.sums`;

/**
 * The page checksums of a directory's blobs as they are kept beside them:
 * each table in a file of its own (`files`: its name and bytes), and what
 * the manifest records of them (`checks`): the page size, and each table's
 * own CRC-32.
 *
 * @param {Map<string, Uint32Array>} sums - Each blob's page checksums, by name
 * @returns {{files: Map<string, Uint8Array>, checks: {pageBytes: number, files: Object<string, number>}}}
 */
export function checkTables(sums) {
  const files = new Map();
  const recorded = {};
  for (const [name, table] of sums) {
    const bytes = checksumBytes(table);
    files.set(sumsFileOf(name), bytes);
    recorded[name] = checksumOf(bytes);
  }
  return { files, checks: { pageBytes: CHECK_PAGE_BYTES, files: recorded } };
}

/** The file the table of one kept blob's page checksums is read from, or null when the manifest records none of it. */
export function checkTableFile(checks, name) {
  return checks?.pageBytes === CHECK_PAGE_BYTES && Number.isInteger(checks.files?.[name]) ? sumsFileOf(name) : null;
}

/**
 * The page checksums of one kept blob of `size` bytes, from the bytes of
 * its table's file (`checkTableFile`), checked against the manifest's
 * record of them; null when they do not match (damage).
 *
 * @param {{pageBytes: number, files: Object<string, number>}} checks
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {number} size
 * @returns {Uint32Array|null}
 */
export function checkTableFrom(checks, name, bytes, size) {
  if (checkTableFile(checks, name) === null || checksumOf(bytes) !== checks.files[name]) return null;
  const sums = checksumsFromBytes(bytes);
  return checksumsFit(sums, size) ? sums : null;
}
