/**
 * What a source is, and which version of it: the rules every place that
 * files something under a source's identity follows (kept stores, kept
 * parts and downloads, `data/anndata/transcode/space.js`; the page's memory
 * of bytes, `formats/io/range-cache.js`; a Zarr store's version,
 * `formats/zarr/stores/http.js`; the providers' versions, `remote-file.js`).
 *
 * - `strongEtag`: the one rule for an `ETag`: only a strong one names bytes
 *   (a weak one, `W/…`, says two answers mean the same, not that their
 *   bytes are the same: a host that compresses a whole answer on the way
 *   marks it weak).
 * - `writeVersion`: the version a host's validators give a file.
 * - `persistsAcrossVisits`: whether an identity names a version, so what is
 *   kept under it may be used by a later visit.
 * - `addressOf`: where a source is, whatever its version.
 *
 * @module data/sources/identity
 */

/**
 * A response's `ETag` when it is strong (it names the answer's exact
 * bytes), else null: weak (`W/…`), empty or absent.
 *
 * @param {string|null|undefined} etag
 * @returns {string|null}
 */
export function strongEtag(etag) {
  return typeof etag === 'string' && etag !== '' && !/^W\//i.test(etag) ? etag : null;
}

/**
 * The version a host's validators give a file that names no content: its
 * exact size with its Last-Modified date and its strong ETag, each that
 * the host sends (`written:<size> modified:<date> etag:<tag>`), or null
 * when it sends neither (a weak ETag, `W/…`, says only that two versions
 * mean the same, never that their bytes are the same, and adds nothing).
 * The one rule for a version stated by a host (`data/sources/remote-file.js`
 * for files by link); a version a source names by its content (a
 * checksum, a commit or revision, a release, `data/sources/providers/*`)
 * stands instead of it. What it cannot tell: a file replaced by other
 * bytes of exactly the same size within the same second (Last-Modified's
 * resolution), on a host that sends no ETag that changes with them.
 *
 * @param {{size: number, lastModified?: string|null, etag?: string|null}} validators
 * @returns {string|null}
 */
export function writeVersion({ size, lastModified = null, etag = null }) {
  const modified = typeof lastModified === 'string' && lastModified !== '' ? lastModified : null;
  const strong = strongEtag(etag);
  if (modified === null && strong === null) return null;
  return [`written:${size}`, ...(modified === null ? [] : [`modified:${modified}`]), ...(strong === null ? [] : [`etag:${strong}`])].join(' ');
}

/**
 * The file an identity a kept directory is filed under is of: a download's,
 * a file's kept parts', a gene index's file and the matrix share of a
 * stream read map first (`{download}`, `{parts}`, `{columnIndex: {file}}`,
 * `{matrixShare}`: `anndata/transcode/matrix-market.js`), else the identity
 * itself.
 *
 * @param {Object|null} identity
 * @returns {Object|null}
 */
export function fileIdentityOf(identity) {
  if (identity === null || typeof identity !== 'object') return null;
  if (identity.download !== undefined) return fileIdentityOf(identity.download);
  if (identity.parts !== undefined) return fileIdentityOf(identity.parts);
  if (identity.columnIndex !== undefined) return fileIdentityOf(identity.columnIndex?.file ?? null);
  if (identity.matrixShare !== undefined) return fileIdentityOf(identity.matrixShare);
  return identity;
}

/**
 * Whether a source's identity names its version, so that the same identity
 * later is the same bytes: a local file's size and modification time; a
 * remote file's content name (its provider's checksum, commit, revision or
 * release) or its host's validators (`writeVersion`: its size with its
 * Last-Modified date and strong ETag), or a served file's strong ETag --
 * any `version` but `size:<n>`, which names none; every file of a set.
 * What is kept of such a source is kept for later visits and used under
 * that version only; of any other, nothing is used by a later opening.
 *
 * @param {Object|null} identity
 * @returns {boolean}
 */
export function persistsAcrossVisits(identity) {
  const file = fileIdentityOf(identity);
  if (file === null) return false;
  if (file.kind === 'file') return Number.isFinite(file.lastModified) && Number.isSafeInteger(file.size);
  if (file.kind === 'remote') return typeof file.version === 'string' && file.version !== '' && !file.version.startsWith('size:');
  if (Array.isArray(file.files)) return file.files.length > 0 && file.files.every(persistsAcrossVisits);
  return false;
}

/**
 * Where a source is, whatever its version: a remote file's identity without
 * its version (its provider's key; `cacheKey` leaves credentials out), a
 * set's files' addresses; null for a file on this computer (two files of
 * the same name are two files, and nothing tells one's versions apart from
 * the other). What is kept of another version of the same address is stale
 * once a version is opened (`forgetOtherVersions`).
 *
 * @param {Object|null} identity
 * @returns {Object|null}
 */
export function addressOf(identity) {
  const file = fileIdentityOf(identity);
  if (file === null) return null;
  if (file.kind === 'remote') return typeof file.key === 'string' ? { kind: 'remote', key: file.key } : null;
  if (Array.isArray(file.files)) {
    const addresses = file.files.map(addressOf);
    return addresses.length > 0 && addresses.every(address => address !== null)
      ? { files: addresses.map((address, i) => ({ path: file.files[i].path ?? file.files[i].name ?? null, address })) }
      : null;
  }
  return null;
}
