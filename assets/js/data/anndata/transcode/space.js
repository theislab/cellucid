/**
 * Where a transcoded store's bytes live: one directory of the origin-private
 * file system (OPFS) per transcoded file, written through synchronous access
 * handles (dedicated workers have them), or memory where this browser has no
 * OPFS (a Firefox private window), with no other bound than memory itself.
 *
 * **Lifetime (kept across visits).** A directory is
 * `cellucid-transcoded/<key>-<random>`, `<key>` the start of the digest of
 * the source file's identity (`cacheKey`: a local file's name, size and
 * modification time; a remote file's provider id and the version its host
 * reports: its ETag, its provider's revision or checksum; a link's
 * signature and token query parameters left out, so a link signed again is
 * the same file and no credential is stored). Its `manifest.json`, written
 * last, makes it complete, and names the identity's whole digest (never the
 * identity itself), the store revision (`KEPT_STORE_REVISION`), whether it is
 * kept for later visits (else the tab it belongs to), and the size of every
 * file it refers to.
 *
 * - A file whose identity names a version (`persistsAcrossVisits`) is kept
 *   for later visits: opening it again, in this tab or another one, a day
 *   later, opens its directory without reading the file (`findKeptStore`),
 *   once the manifest is checked against the identity, the revision and the
 *   files it lists (any mismatch removes the directory, and the file is read
 *   again). A file known only by its size (a host that reports no
 *   version) is kept for the tab's life, as it may change
 *   under the same name and size, and only that tab opens it again
 *   (`THIS_TAB`).
 * - Whoever uses a directory holds a shared Web Lock named after it: the
 *   reader worker while it writes and reads it, and the page, once the pass
 *   completed, until the tab closes (`holdTranscodedStore`). A held
 *   directory is never removed.
 * - A directory nobody holds is removed when it is incomplete (a closed or
 *   crashed tab's pass, a cancelled one), kept for one tab only, or written
 *   by another store revision: when the app starts
 *   (`sweepAbandonedTranscodes`), before a new pass begins, and at once
 *   after a cancelled pass (`removeTranscodedStore`, which waits for the
 *   stopped worker's lock to go).
 * - Room is made under the browser's real quota
 *   (`navigator.storage.estimate()`, read when a pass starts): when a
 *   payload of a pass does not fit in what the browser said was left, less
 *   what the pass wrote since, the kept directories nobody holds are
 *   removed, the cheapest to make again first (a gene index run before a
 *   converted store or a download: `rebuildRank`), least recently used
 *   first among those (each records when it was last opened, `used`), until
 *   what they freed makes it fit; only then is the pass refused as
 *   storage-full. A copy kept only to spare later work (a gene index run,
 *   `optional`) removes only copies as cheap to make again, never a
 *   converted store; work under way (a pass, a download, a gene index being
 *   built: `column-store-placement.js`) removes any. There is no other
 *   bound.
 * - `clearKeptStores` removes every directory no open tab holds (the
 *   Session panel's storage control); `keptStoresUsage` says what the ones
 *   kept for later visits take.
 *
 * Kept payloads arrive while the file streams, each into a file of its own
 * (`p<n>.bin`), so one that turns out not to be wanted is deleted: at once
 * when the parser gives it back (a Seurat v5 layer that is `scale.data`,
 * known only by the layer names that follow it), else when the store is
 * complete (what the transcoder did not use); arrays the transcoder derives
 * (codes, masks, converted columns) go to one file (`d.bin`) appended to.
 *
 * @module data/anndata/transcode/space
 */

import { blobReader } from '../../../formats/zarr/stores/mapped.js';
import {
  CHECK_PAGE_BYTES, PageChecksums, checkedRead, checksumBytes, checksumOf, checksumsFit, checksumsFromBytes,
} from '../../../formats/io/page-checks.js';
import { formatBytes, formatCountOf } from '../../../utils/format-units.js';
import { createOpaqueId } from '../../../app/utils/opaque-id.js';
import { ARRAY_PIECE_BYTES } from '../../../utils/large-arrays.js';
import { allocateTypedArray } from '../../sparse-column-index.js';

export const TRANSCODED_DIRECTORY = 'cellucid-transcoded';

/**
 * Bytes `[start, end)` of a Blob or File. `arrayBuffer()` makes one
 * `ArrayBuffer`, and a region (a whole per-cell array) can be larger than an
 * engine allows one, so a region larger than one piece is read piece by
 * piece into one array (`allocateTypedArray`).
 */
async function blobBytes(blob, start, end) {
  if (end - start <= ARRAY_PIECE_BYTES) return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const out = allocateTypedArray(Uint8Array, end - start, 'Converted bytes');
  for (let at = start; at < end; at += ARRAY_PIECE_BYTES) {
    const to = Math.min(end, at + ARRAY_PIECE_BYTES);
    out.set(new Uint8Array(await blob.slice(at, to).arrayBuffer()), at - start);
  }
  return out;
}
const MANIFEST = 'manifest.json';
const DERIVED = 'd.bin';
/** The file whose text is when a directory was last opened (ms since the epoch). */
const LAST_USED = 'used';
/** The file a kept download is. */
const DOWNLOADED = 'source';

/**
 * The revision of what the transcoders write. A kept store of another
 * revision is removed, never read: raise it whenever a transcoder's output
 * changes (`tests/transcode-cache-contract.test.mjs` fails until it is).
 */
export const KEPT_STORE_REVISION = 1;

/**
 * The revision of what a gene index kept in this browser holds
 * (`../kept-column-index.js`, manifests of kind `column-index`): a kept index
 * of another revision is removed, never read. Raise it whenever the code
 * that decides what an index holds changes: the index and its kept form,
 * the matrix reads and conversions it is built from, the layouts and the
 * chunk decoders (`tests/kept-column-index-contract.test.mjs` pins the
 * digest of that code, comments aside, and fails until it is raised).
 */
export const KEPT_INDEX_REVISION = 1;

/** The revision a manifest of its kind is read at. */
function revisionOf(manifest) {
  return manifest?.kind === 'column-index' ? KEPT_INDEX_REVISION : KEPT_STORE_REVISION;
}

function lockName(directory) {
  return `${TRANSCODED_DIRECTORY}/${directory}`;
}

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
 * Whether a source's identity names its version, so that the same identity
 * later is the same bytes: a local file's modification time, a remote
 * file's ETag or its provider's revision or checksum (`version` not merely
 * `size:<n>`), every file of a set. A store of such a source is kept for
 * later visits; any other only for the tab's life.
 *
 * @param {Object|null} identity
 * @returns {boolean}
 */
export function persistsAcrossVisits(identity) {
  if (identity === null || typeof identity !== 'object') return false;
  if (identity.kind === 'file') return Number.isFinite(identity.lastModified);
  if (identity.kind === 'remote') return typeof identity.version === 'string' && identity.version !== '' && !identity.version.startsWith('size:');
  if (Array.isArray(identity.files)) return identity.files.length > 0 && identity.files.every(persistsAcrossVisits);
  if (identity.download !== undefined) return persistsAcrossVisits(identity.download);
  // A gene index (`../kept-column-index.js`) is kept as long as its file.
  if (identity.columnIndex !== undefined) return persistsAcrossVisits(identity.columnIndex?.file ?? null);
  return false;
}

/**
 * The versions a provider states that name a file's content, not when it
 * was last written (`sources/providers/*`): a checksum or content hash
 * (Google Drive `md5:`, Figshare's md5, Zenodo's checksum, a Git LFS
 * object's SHA-256), a commit or revision that never changes once made
 * (Hugging Face `hf:<commit>`, a Drive revision), a release that never
 * changes (`census:<build>`), a tag the provider changes with every write of
 * the content (OneDrive `ctag:`). Every other version only says when or how
 * big the file was when last written, and two writes can leave it the same:
 * a host's ETag (often its modification time and size), `modified:` (a
 * Last-Modified date, to the second), a local file's name, size and
 * modification time (FAT keeps it to 2 s; `cp -p` and `rsync -t` copy it),
 * a served file's ETag (`cellucid serve` / `cellucid_serve()`: its size and
 * modification and change times, which two writes of the same size within
 * the file system's time resolution leave as they were).
 */
const CONTENT_VERSIONS = [
  /^md5:[0-9a-f]{32}:/i,
  /^revision:[^:]+:/,
  /^figshare:[^:]*:[0-9a-f]{32}$/i,
  /^zenodo:[^:]*:.+$/,
  /^hf:[0-9a-f]{7,64}:/i,
  /^census:.+$/,
  /^ctag:.+$/,
  /^[0-9a-f]{64}$/i,
];

/**
 * Whether an identity names its file's content (`CONTENT_VERSIONS`): the
 * same identity is then the same bytes, and what is kept of the file is
 * used without reading any of it again. Any other identity's kept gene
 * index is checked against the file's content first
 * (`../kept-column-index.js`, its fingerprint).
 *
 * @param {Object|null} identity
 * @returns {boolean}
 */
export function namesContent(identity) {
  if (identity === null || typeof identity !== 'object') return false;
  if (identity.kind === 'remote') return typeof identity.version === 'string' && CONTENT_VERSIONS.some(form => form.test(identity.version));
  if (Array.isArray(identity.files)) return identity.files.length > 0 && identity.files.every(namesContent);
  if (identity.columnIndex !== undefined) return namesContent(identity.columnIndex?.file ?? null);
  return false;
}

/**
 * Query parameters of a link that sign it or carry a credential (S3, Google
 * Cloud Storage and Azure signed URLs, CloudFront, bearer tokens): never
 * part of what a file is, never stored.
 */
const CREDENTIAL_PARAMETER = /^(x-amz-.*|x-goog-.*|signature|sig|se|sp|sv|sr|st|spr|srt|ss|skoid|sktid|skt|ske|sks|skv|key-pair-id|policy|expires|token|access_token|auth|authorization)$/i;

/** A link's address without its credential parameters (itself when it is no URL). */
export function linkWithoutCredentials(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  for (const name of [...url.searchParams.keys()]) if (CREDENTIAL_PARAMETER.test(name)) url.searchParams.delete(name);
  return url.href;
}

/**
 * One field of an identity as it is filed: a link, in any of the forms an
 * identity names one (a remote file's `url`, a provider key that is a link,
 * `url:<encoded address>`), without its credential parameters.
 */
function filedField(name, value) {
  if (typeof value !== 'string') return value;
  if (name === 'url') return linkWithoutCredentials(value);
  if (name === 'key' && value.startsWith('url:')) {
    let href;
    try {
      href = decodeURIComponent(value.slice(4));
    } catch {
      return value;
    }
    return `url:${encodeURIComponent(linkWithoutCredentials(href))}`;
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
  const bytes = new TextEncoder().encode(canonicalJson(cacheKey(identity)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A directory name for a source: its digest's start, then a random part. */
async function directoryFor(identity) {
  return `${(await identityDigest(identity)).slice(0, 24)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * This page's tab: a store kept for one tab only (`persistsAcrossVisits`
 * false) names it, and only this tab opens it again. The page hands it to
 * its reader worker (`anndata-reader-client.js`), which writes and opens the
 * stores.
 */
export const THIS_TAB = createOpaqueId();

/** The storage this browser says it has left, in bytes, or null. */
async function storageLeft(environment) {
  try {
    const estimate = await environment.navigator?.storage?.estimate?.();
    if (!estimate || !(estimate.quota > 0)) return null;
    return Math.max(0, estimate.quota - (estimate.usage ?? 0));
  } catch {
    return null;
  }
}

/**
 * The error a pass stops with when the browser's storage is full: `madeRoom`
 * once the kept files nobody holds were removed for it (else a later step
 * may still remove them and try again: `session.js`).
 */
export function storageFullError(needed, left, { madeRoom = true } = {}) {
  const error = new Error(
    `This browser's storage has room for ${formatBytes(left)} more` +
    `${madeRoom ? ', after removing every file kept from an earlier opening that no tab has open,' : ''} ` +
    `and this object needs more than that (${formatBytes(needed)} so far). ` +
    'Close other tabs with a file read whole open, free space on the disk, or write the object as a ' +
    'Cellucid-ready AnnData once (cellucid.prepare() in Python, cellucid_prepare() in R) and open that, ' +
    'which is read in place.'
  );
  error.code = 'UNSUPPORTED';
  error.details = { explained: true, reason: 'storage-full', written: needed };
  return error;
}

/**
 * The error a pass stops with when a write is refused for the site's quota
 * (`QuotaExceededError`): the browser's real bound, which its estimate may
 * not show (a private window's storage is small and held in memory, while
 * its estimate reports gigabytes). Any other error is returned as it is.
 */
function quotaError(error, written, { freed = null } = {}) {
  if (error?.name !== 'QuotaExceededError') return error;
  const full = new Error(
    `This browser's storage for this site is full after ${formatBytes(written)} of this file were written ` +
    '(a private window gives a site little). Open it in a normal window, free space on the disk, or write it as a ' +
    'Cellucid-ready AnnData once (cellucid.prepare() in Python, cellucid_prepare() in R) and open that, which is ' +
    'read in place.',
    { cause: error }
  );
  full.code = 'UNSUPPORTED';
  full.details = { explained: true, reason: 'storage-full', written, ...(freed === null ? {} : { freed }) };
  return full;
}

async function opfsRoot(environment) {
  const storage = environment?.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return null;
  try {
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

async function parentDirectory(root, create) {
  try {
    return await root.getDirectoryHandle(TRANSCODED_DIRECTORY, { create });
  } catch {
    return null;
  }
}

/**
 * Hold a Web Lock until the returned `release()` is called: resolves once it
 * is granted, and rejects with the browser's reason when the request is
 * refused (a document that is not fully active, a context denied storage),
 * so the caller keeps its data in memory instead of waiting forever. Where
 * there are no Web Locks, nothing is held.
 *
 * @param {LockManager|undefined} locks
 * @param {string} name
 * @param {LockOptions} [options]
 * @returns {Promise<() => void>}
 */
export function holdLock(locks, name, options = {}) {
  if (typeof locks?.request !== 'function') return Promise.resolve(() => {});
  return new Promise((granted, refused) => {
    locks.request(name, options, () => new Promise(release => granted(release))).catch(refused);
  });
}

/** Hold a shared lock on one directory until `release()` is called (`holdLock`). */
function holdShared(locks, directory) {
  return holdLock(locks, lockName(directory), { mode: 'shared' });
}

/** A directory's manifest, or null when it has none that reads (an incomplete pass). */
async function manifestOf(folder) {
  try {
    const file = await (await folder.getFileHandle(MANIFEST)).getFile();
    const manifest = JSON.parse(await file.text());
    return manifest !== null && typeof manifest === 'object' ? manifest : null;
  } catch {
    return null;
  }
}

/** When a directory was last opened (ms since the epoch); 0 when it does not say. */
async function lastUsedOf(folder) {
  try {
    const value = Number(await (await (await folder.getFileHandle(LAST_USED)).getFile()).text());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Write a small file whole: through a synchronous access handle (a worker), else a writable stream (a page). */
async function writeSmallFile(folder, name, bytes) {
  const handle = await folder.getFileHandle(name, { create: true });
  if (typeof handle.createSyncAccessHandle === 'function') {
    const access = await handle.createSyncAccessHandle();
    try {
      access.write(bytes, { at: 0 });
      access.truncate(bytes.length);
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** The file a kept blob's page checksums are in (`formats/io/page-checks.js`). */
const sumsFileOf = name => `${name}.sums`;

/**
 * Keep the page checksums of a directory's blobs beside them, each table in
 * its own file: what the manifest records of them (`checks`), the table's
 * own CRC-32 with it.
 *
 * @param {FileSystemDirectoryHandle} folder
 * @param {Map<string, Uint32Array>} sums - Each blob's page checksums, by name
 */
async function writeChecks(folder, sums) {
  const files = {};
  for (const [name, table] of sums) {
    const bytes = checksumBytes(table);
    await writeSmallFile(folder, sumsFileOf(name), bytes);
    files[name] = checksumOf(bytes);
  }
  return { pageBytes: CHECK_PAGE_BYTES, files };
}

/**
 * The page checksums of one kept blob, checked against the manifest's
 * record of them; null when they are missing or do not match (damage).
 */
async function readChecks(folder, checks, name, size) {
  if (checks?.pageBytes !== CHECK_PAGE_BYTES || !Number.isInteger(checks.files?.[name])) return null;
  let bytes;
  try {
    bytes = new Uint8Array(await (await (await folder.getFileHandle(sumsFileOf(name))).getFile()).arrayBuffer());
  } catch {
    return null;
  }
  if (checksumOf(bytes) !== checks.files[name]) return null;
  const sums = checksumsFromBytes(bytes);
  return checksumsFit(sums, size) ? sums : null;
}

/**
 * A kept blob read only through its page checksums: a read of damaged bytes
 * fails (`KeptCopyDamage`), and the directory loses its manifest, so it is
 * removed once nobody holds it and the file is read again on its next open.
 */
function checkedBlob(file, sums, folder, label) {
  const reader = blobReader(file);
  return {
    size: reader.size,
    read: checkedRead(reader.read, {
      size: reader.size,
      sums,
      label,
      onDamage: () => folder.removeEntry(MANIFEST).catch(() => {}),
    }),
  };
}

/** Whether a manifest's blobs are read through page checksums: a gene index checks each gene's piece instead. */
const pageChecked = manifest => manifest?.kind !== 'column-index';

/** What a kept directory is, in a message about it. */
const keptLabel = manifest => (manifest?.kind === 'download' ? 'A file downloaded whole' : 'The converted copy of a file');

/** Record that a directory was opened now (for least-recently-used removal). Never throws. */
async function touch(folder) {
  try {
    await writeSmallFile(folder, LAST_USED, new TextEncoder().encode(String(Date.now())));
  } catch {
    // Another tab writing it at the same moment: its time stands.
  }
}

/** Whether a manifest is one this revision reads and keeps for later visits. */
function keptForLater(manifest) {
  return manifest !== null && manifest.revision === revisionOf(manifest) && manifest.persist === true;
}

/**
 * Run `remove` on a directory only if nobody holds it (ifAvailable grants
 * the lock only then); true when it ran.
 */
async function whileUnheld(locks, name, remove) {
  if (typeof locks?.request !== 'function') return false;
  let ran = false;
  await locks.request(lockName(name), { ifAvailable: true }, async lock => {
    if (lock === null) return;
    ran = true;
    await remove();
  });
  return ran;
}

/** Every directory: its name and handle. */
async function directoriesOf(parent) {
  const found = [];
  if (typeof parent.entries !== 'function') return found;
  for await (const [name, handle] of parent.entries()) if (handle.kind === 'directory') found.push({ name, folder: handle });
  return found;
}

/**
 * Remove every directory nobody holds that is not kept for later visits:
 * incomplete, kept for one tab, or of another revision.
 */
async function removeAbandoned(parent, locks) {
  if (typeof locks?.request !== 'function') return;
  for (const { name, folder } of await directoriesOf(parent)) {
    if (keptForLater(await manifestOf(folder))) continue;
    await whileUnheld(locks, name, () => parent.removeEntry(name, { recursive: true }).catch(() => {}));
  }
}

/**
 * What making a kept directory again costs, as a rank: a gene index run
 * (`../kept-column-index.js`) is built again from the rows of its file it
 * covers, read in parts; a converted store or a file downloaded whole only by
 * reading or downloading its whole file again (and converting it).
 */
function rebuildRank(manifest) {
  return manifest.kind === 'column-index' ? 0 : 1;
}

/** The rank of what an optional copy may remove to make room for itself: other copies as cheap to make again. */
export const OPTIONAL_COPY_RANK = 0;

/**
 * Remove the kept directories nobody holds until they freed `deficit` bytes
 * (the sizes their manifests list) or none is left to remove: the cheapest
 * to make again first (`rebuildRank`), least recently opened first among
 * those, and none ranked above `upTo` (an optional copy makes room only from
 * copies as cheap as itself; work under way, from all). Returns the bytes
 * freed.
 */
async function makeRoom(parent, environment, deficit, upTo = Infinity, { dryRun = false } = {}) {
  if (!(deficit > 0)) return 0;
  const locks = environment.navigator?.locks;
  const candidates = [];
  for (const { name, folder } of await directoriesOf(parent)) {
    const manifest = await manifestOf(folder);
    if (!keptForLater(manifest) || rebuildRank(manifest) > upTo) continue;
    const bytes = Object.values(manifest.blobs ?? {}).reduce((sum, size) => sum + (Number(size) || 0), 0);
    candidates.push({ name, bytes, rank: rebuildRank(manifest), used: await lastUsedOf(folder) });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.used - b.used || (a.name < b.name ? -1 : 1));
  let freed = 0;
  for (const { name, bytes } of candidates) {
    if (freed >= deficit) break;
    const removed = dryRun
      ? typeof locks?.request === 'function' && !(await isHeld(locks, name))
      : await whileUnheld(locks, name, () => parent.removeEntry(name, { recursive: true }).catch(() => {}));
    if (removed) freed += bytes;
  }
  return freed;
}

/**
 * Room for work the browser refused for its quota, made once: the kept
 * directories nobody holds are removed, cheapest to make again first and
 * least recently opened first among those (`makeRoom`), until they freed
 * `deficit` bytes (what the refused work had written: the browser does not
 * say how much more it needs, and the work needs at least that again). The
 * bytes freed; 0 when there was nothing to remove, or no OPFS.
 *
 * @param {Object} [environment]
 * @param {number} [deficit]
 * @param {{upTo?: number}} [options] - `upTo`: the costliest rank it may
 *   remove (`OPTIONAL_COPY_RANK` for an optional copy; every rank for work
 *   under way)
 * @returns {Promise<number>}
 */
export async function makeRoomForRetry(environment = globalThis, deficit = Infinity, { upTo = Infinity } = {}) {
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    return parent === null ? 0 : await makeRoom(parent, environment, Math.max(1, deficit), upTo);
  } catch {
    return 0;
  }
}

/**
 * The bytes `makeRoomForRetry` would free for `deficit` now, without
 * removing anything: what a plan of work (a gene index's placement, asked
 * before it is built) may count as free.
 *
 * @param {Object} [environment]
 * @param {number} [deficit]
 * @returns {Promise<number>}
 */
export async function roomToMake(environment = globalThis, deficit = Infinity) {
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    return parent === null ? 0 : await makeRoom(parent, environment, Math.max(1, deficit), Infinity, { dryRun: true });
  } catch {
    return 0;
  }
}

/**
 * Remove every transcoded directory nobody holds that is not kept for later
 * visits. Run when the app starts; never throws, and does nothing without
 * OPFS.
 *
 * @param {Object} [environment]
 */
export async function sweepAbandonedTranscodes(environment = globalThis) {
  try {
    const root = await opfsRoot(environment);
    if (root === null) return;
    const parent = await parentDirectory(root, false);
    if (parent === null) return;
    await removeAbandoned(parent, environment.navigator.locks);
  } catch {
    // A storage failure leaves the directories for the next start.
  }
}

/** Whether anybody holds a directory's lock. */
async function isHeld(locks, name) {
  if (typeof locks?.request !== 'function') return false;
  let held = false;
  await locks.request(lockName(name), { ifAvailable: true }, async lock => {
    held = lock === null;
  });
  return held;
}

/**
 * The file a kept directory is of, as the Session panel counts files: a
 * converted store and the download it was converted from are one file, and
 * every run of one file's gene index is that file.
 */
function fileOf(name, manifest) {
  if (manifest === null) return `directory:${name}`;
  return manifest.kind === 'download' || manifest.kind === 'column-index' ? manifest.source : manifest.key;
}

/**
 * What is kept for later visits: how many files (a store and the download
 * it reads its arrays from count once), the bytes they take (every file
 * their manifests list), and how many an open tab holds now; and apart from
 * them, the files whose gene index is kept (`indexes`, a file counted once
 * however many runs of rows its index is kept in: `../kept-column-index.js`),
 * their bytes and how many an open tab holds (any of their runs); and
 * `clearable`, the kept directories no open tab holds (what Clear removes).
 * What is kept for one tab only, and incomplete passes, are not counted:
 * they go with their tab. Zeros without OPFS.
 *
 * @param {Object} [environment]
 * @returns {Promise<{stores: number, bytes: number, held: number, indexes: number, indexBytes: number, indexesHeld: number, clearable: number}>}
 */
export async function keptStoresUsage(environment = globalThis) {
  const usage = { stores: 0, bytes: 0, held: 0, indexes: 0, indexBytes: 0, indexesHeld: 0, clearable: 0 };
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    if (parent === null) return usage;
    const locks = environment.navigator?.locks;
    const kept = [];
    for (const { name, folder } of await directoriesOf(parent)) {
      const manifest = await manifestOf(folder);
      if (keptForLater(manifest)) kept.push({ name, manifest, held: await isHeld(locks, name) });
    }
    /** @type {Map<string, boolean>} Each file counted (`fileOf`): whether a tab holds any of its directories. */
    const storeFiles = new Map();
    const indexed = new Map();
    for (const { name, manifest, held } of kept) {
      if (!held) usage.clearable++;
      const bytes = Object.values(manifest.blobs ?? {}).reduce((sum, size) => sum + (Number(size) || 0), 0);
      const files = manifest.kind === 'column-index' ? indexed : storeFiles;
      if (manifest.kind === 'column-index') usage.indexBytes += bytes;
      else usage.bytes += bytes;
      const file = fileOf(name, manifest);
      files.set(file, (files.get(file) ?? false) || held);
    }
    usage.stores = storeFiles.size;
    usage.held = [...storeFiles.values()].filter(Boolean).length;
    usage.indexes = indexed.size;
    usage.indexesHeld = [...indexed.values()].filter(Boolean).length;
  } catch {
    // Storage that cannot be listed: what was counted so far.
  }
  return usage;
}

/**
 * Remove every kept directory no open tab holds (those that are open stay
 * until their tab closes). Never throws. `removed`: the directories removed;
 * `held`: the files whose kept copies stay because an open tab holds them (a
 * file counted once however many of its directories stay: `fileOf`).
 *
 * @param {Object} [environment]
 * @returns {Promise<{removed: number, held: number}>}
 */
export async function clearKeptStores(environment = globalThis) {
  const result = { removed: 0, held: 0 };
  const held = new Set();
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    if (parent === null) return result;
    const locks = environment.navigator?.locks;
    for (const { name, folder } of await directoriesOf(parent)) {
      const manifest = await manifestOf(folder);
      const removed = typeof locks?.request === 'function'
        ? await whileUnheld(locks, name, () => parent.removeEntry(name, { recursive: true }))
        : await parent.removeEntry(name, { recursive: true }).then(() => true);
      if (removed) result.removed++;
      else held.add(fileOf(name, manifest));
    }
  } catch {
    // What could not be removed stays for the next start's sweep or clear.
  }
  result.held = held.size;
  return result;
}

/** Whoever shows what is kept hears when the page starts holding a newly kept directory (`onKeptStoresChange`). */
const keptStoreListeners = new Set();

/**
 * Hear when a directory was kept since (a gene index run kept in the
 * background after its opening ended): the Session panel's Stored line.
 * Returns what stops it.
 *
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onKeptStoresChange(listener) {
  keptStoreListeners.add(listener);
  return () => keptStoreListeners.delete(listener);
}

/** The directories this page holds for the tab's life, each with what lets it go. */
const heldByPage = new Map();

/**
 * The page keeps a completed directory for the tab's life: a shared lock
 * held until the page goes (or `releaseKeptDownload`). Idempotent. Resolves
 * once the lock is held: the worker that wrote the directory lets its own
 * lock go only then (`kept-column-index.js` `keepRun`), so no moment passes
 * with the directory held by nobody.
 *
 * @param {string} directory
 * @param {Object} [environment]
 * @returns {Promise<void>}
 */
export async function holdTranscodedStore(directory, environment = globalThis) {
  if (typeof directory !== 'string') return;
  if (!heldByPage.has(directory)) {
    const held = holdShared(environment?.navigator?.locks, directory);
    heldByPage.set(directory, held);
    void held.catch(() => heldByPage.delete(directory));
    for (const listener of keptStoreListeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
  await heldByPage.get(directory)?.catch(() => {});
}

/**
 * Remove one directory a pass left unfinished (Cancel, a failure), once the
 * worker that wrote it has stopped and let its lock go. Never throws.
 *
 * @param {string} directory
 * @param {Object} [environment]
 */
export async function removeTranscodedStore(directory, environment = globalThis) {
  if (typeof directory !== 'string' || heldByPage.has(directory)) return;
  try {
    const root = await opfsRoot(environment);
    if (root === null) return;
    const parent = await parentDirectory(root, false);
    if (parent === null) return;
    const locks = environment.navigator?.locks;
    const remove = () => parent.removeEntry(directory, { recursive: true }).catch(() => {});
    if (typeof locks?.request !== 'function') await remove();
    else await locks.request(lockName(directory), { mode: 'exclusive' }, remove);
  } catch {
    // Left for the next start's sweep.
  }
}

/**
 * Whether a complete directory is what its manifest says, for the source
 * whose digest is `digest`: this revision, the same digest, kept for later
 * visits or written for `tab`, every file it lists there at its size. Its
 * blob readers when it is, else null; `'other-tab'` for another tab's store.
 */
async function checkedBlobs(folder, manifest, digest, tab) {
  if (manifest === null || manifest.revision !== revisionOf(manifest)) return null;
  if (manifest.key !== digest) return null;
  if (manifest.persist !== true && manifest.tab !== tab) return 'other-tab';
  const sizes = manifest.blobs;
  if (sizes === null || typeof sizes !== 'object' || Array.isArray(sizes)) return null;
  const blobs = new Map();
  for (const [name, size] of Object.entries(sizes)) {
    let file;
    try {
      file = await (await folder.getFileHandle(name)).getFile();
    } catch {
      return null;
    }
    if (file.size !== size) return null;
    if (!pageChecked(manifest)) {
      blobs.set(name, blobReader(file));
      continue;
    }
    const sums = await readChecks(folder, manifest.checks, name, size);
    if (sums === null) return null;
    blobs.set(name, checkedBlob(file, sums, folder, keptLabel(manifest)));
  }
  return blobs;
}

/**
 * The complete store of a file transcoded before in this browser (in this
 * tab, another one, or an earlier visit), checked against its manifest, or
 * null: its manifest and blobs, and the lock this reader now holds on it. A
 * store kept for one tab only is opened by that tab alone. A directory whose
 * check fails is removed (when nobody else holds it).
 *
 * @param {Object} identity
 * @param {Object} [environment]
 * @param {{tab?: string}} [options] - `tab`: whose tab asks (`THIS_TAB`)
 * @returns {Promise<{directory: string, manifest: Object, blobs: Map<string, Object>, release: () => void}|null>}
 */
export async function findKeptStore(identity, environment = globalThis, { tab = THIS_TAB } = {}) {
  const found = await findKeptStores(identity, environment, { tab, first: true });
  return found[0] ?? null;
}

/**
 * Every complete directory kept under one identity (`findKeptStore`), each
 * checked against its manifest and held (`release` lets it go): a gene
 * index is kept as several directories under its file's identity, one per
 * run of rows (`../kept-column-index.js`). `first`: stop at the first.
 *
 * @param {Object} identity
 * @param {Object} [environment]
 * @param {{tab?: string, first?: boolean}} [options]
 * @returns {Promise<Array<{directory: string, manifest: Object, blobs: Map<string, Object>, release: () => void, discard: () => Promise<void>}>>}
 */
export async function findKeptStores(identity, environment = globalThis, { tab = THIS_TAB, first = false } = {}) {
  const found = [];
  const root = await opfsRoot(environment);
  if (root === null || identity === null || identity === undefined) return found;
  const parent = await parentDirectory(root, false);
  if (parent === null) return found;
  const digest = await identityDigest(identity);
  const prefix = `${digest.slice(0, 24)}-`;
  const locks = environment.navigator?.locks;
  let candidates;
  try {
    candidates = (await directoriesOf(parent)).filter(({ name }) => name.startsWith(prefix));
  } catch {
    return found;
  }
  for (const { name, folder } of candidates) {
    let release;
    try {
      release = await holdShared(locks, name);
    } catch {
      // This context may hold no lock: nothing more kept can be read here.
      return found;
    }
    let blobs = null;
    let manifest = null;
    try {
      manifest = await manifestOf(folder);
      blobs = manifest === null ? null : await checkedBlobs(folder, manifest, digest, tab);
    } catch {
      blobs = null;
    }
    if (blobs !== null && blobs !== 'other-tab') {
      await touch(folder);
      found.push({
        directory: name,
        manifest,
        blobs,
        release,
        // Remove it (it is damaged): once this reader's lock goes, if nobody else holds it.
        discard: async () => {
          release();
          await new Promise(resolve => setTimeout(resolve, 0));
          await whileUnheld(locks, name, () => parent.removeEntry(name, { recursive: true }).catch(() => {}));
        },
      });
      if (first) return found;
      continue;
    }
    release();
    // Another tab's, or incomplete (a pass under way in another tab holds
    // it): left alone. Not what it says: removed if nobody holds it (the
    // lock just let go goes after this task).
    if (manifest !== null && blobs === null) {
      await new Promise(resolve => setTimeout(resolve, 0));
      await whileUnheld(locks, name, () => parent.removeEntry(name, { recursive: true }).catch(() => {}));
    }
  }
  return found;
}

/** Whether files here can be written as a stream: a writable stream (a page) or a synchronous access handle (a worker). */
function canWrite(handle) {
  return typeof handle?.createWritable === 'function' || typeof handle?.createSyncAccessHandle === 'function';
}

/** Per storage: whether this context can write its files (Safari before 26 gives a page neither way). */
const writableStorages = new WeakMap();

/** Whether this context can write files under `parent` (asked once per storage, with an empty probe file). */
async function writesFiles(environment, parent) {
  const storage = environment.navigator.storage;
  if (writableStorages.has(storage)) return writableStorages.get(storage);
  let writable = false;
  try {
    writable = canWrite(await parent.getFileHandle('.probe', { create: true }));
    await parent.removeEntry('.probe').catch(() => {});
  } catch {
    writable = false;
  }
  writableStorages.set(storage, writable);
  return writable;
}

/**
 * Where a file downloaded whole would be kept: this browser's storage (for
 * later visits when its identity names its version), or memory where this
 * browser gives the page no storage it can write. Said before anything is
 * downloaded.
 *
 * @param {Object|null} identity
 * @param {Object} [environment]
 * @returns {Promise<{kept: 'opfs'|'memory', persistent: boolean}>}
 */
export async function keptWhere(identity, environment = globalThis) {
  const root = await opfsRoot(environment);
  const parent = root === null ? null : await parentDirectory(root, true);
  if (parent === null || !(await writesFiles(environment, parent))) return { kept: 'memory', persistent: false };
  return { kept: 'opfs', persistent: persistsAcrossVisits(identity) };
}

/** What a kept download is filed under: apart from the store of the same file, filed under the file's own identity. */
const downloadIdentity = identity => ({ download: identity });

/**
 * Whether the complete store of a source is kept (`findKeptStore`), as a
 * page asks before it downloads the source whole: its manifest, or null.
 * Holds nothing.
 *
 * @param {Object|null} identity
 * @param {Object} [environment]
 * @returns {Promise<Object|null>}
 */
export async function keptStoreManifest(identity, environment = globalThis) {
  const found = await findKeptStore(identity, environment);
  if (found === null) return null;
  found.release();
  return found.manifest;
}

/**
 * A file this browser downloaded whole before (a host that serves no parts
 * of files) and kept, checked against its manifest, or null. The page holds
 * its directory for the tab's life (`releaseKeptDownload` lets it go).
 *
 * @param {Object|null} identity - The remote file's identity
 * @param {string} name - Its name
 * @param {Object} [environment]
 * @returns {Promise<{file: File, checks: {pageBytes: number, sums: Uint32Array, directory: string}}|null>}
 *   `checks`: its page checksums, which every read of it is checked
 *   against (a kept download without them is not found)
 */
export async function findKeptDownload(identity, name, environment = globalThis) {
  if (identity === null || identity === undefined) return null;
  const found = await findKeptStore(downloadIdentity(identity), environment);
  if (found === null) return null;
  holdTranscodedStore(found.directory, environment);
  found.release();
  const root = await opfsRoot(environment);
  const folder = await (await parentDirectory(root, false)).getDirectoryHandle(found.directory);
  const stored = await (await folder.getFileHandle(DOWNLOADED)).getFile();
  const sums = await readChecks(folder, found.manifest.checks, DOWNLOADED, stored.size);
  if (sums === null) return null;
  keptDownloads.set(await identityDigest(identity), found.directory);
  return { file: new File([stored], name, { lastModified: stored.lastModified }), checks: { pageBytes: CHECK_PAGE_BYTES, sums, directory: found.directory } };
}

/**
 * Forget a kept copy found damaged (`formats/io/page-checks.js`): its
 * manifest goes, so it is removed once nobody holds it and the file is read
 * again on its next open. From the page or a worker. Never throws.
 *
 * @param {string} directory
 * @param {Object} [environment]
 */
export async function forgetKeptCopy(directory, environment = globalThis) {
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    if (parent === null) return;
    await (await parent.getDirectoryHandle(directory)).removeEntry(MANIFEST);
  } catch {
    // Already gone.
  }
}

/** The directory of each download this page kept, by the digest of its identity. */
const keptDownloads = new Map();

/** The bytes a download gathers in memory before they join the file's Blob, without OPFS. */
const MEMORY_DOWNLOAD_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * Keep a file downloaded whole as it arrives: written to this browser's
 * storage (OPFS, through a writable stream or a synchronous access handle),
 * never gathered in memory, and kept like a transcoded store (for later
 * visits when its identity names its version; `persistsAcrossVisits`).
 * Where this context cannot write that storage (no OPFS, a private window,
 * Safari before 26 on a page, a lock on it refused) its pieces join one Blob a batch at a time,
 * which the browser may keep on disk.
 *
 * When the browser refuses a write for its quota, the kept directories
 * nobody holds are removed (least recently opened first) and the download
 * stops with `details.freed`, the bytes they took: the caller may download
 * it again (`downloadRemoteFile` does, once).
 *
 * @param {Object|null} identity - The remote file's identity
 * @param {AsyncIterable<Uint8Array>} pieces - The response body
 * @param {{name: string, size?: number|null, environment?: Object}} options -
 *   `size`: the bytes the host says it sends, when it says (room is made for
 *   them first)
 * @returns {Promise<{file: File, checks: {pageBytes: number, sums: Uint32Array, directory: string}|null, kept: 'opfs'|'memory', persistent: boolean}>}
 *   `checks`: the page checksums taken as it was written (null in memory)
 */
export async function keepDownload(identity, pieces, { name, size = null, environment = globalThis }) {
  const inMemory = async () => ({ file: await gatherInMemory(pieces, name), checks: null, kept: 'memory', persistent: false });
  const root = await opfsRoot(environment);
  const parent = root === null ? null : await parentDirectory(root, true);
  if (parent === null || !(await writesFiles(environment, parent))) return inMemory();
  const locks = environment.navigator?.locks;
  await removeAbandoned(parent, locks);
  const filed = downloadIdentity(identity);
  const directory = await directoryFor(filed);
  const held = holdShared(locks, directory);
  heldByPage.set(directory, held);
  try {
    await held;
  } catch {
    // A directory this context may not lock is not kept in its storage.
    heldByPage.delete(directory);
    return inMemory();
  }
  const persistent = persistsAcrossVisits(filed);
  let folder = null;
  let written = 0;
  try {
    folder = await parent.getDirectoryHandle(directory, { create: true });
    const left = Number.isFinite(size) ? await storageLeft(environment) : null;
    if (left !== null && left < size) {
      const room = left + await makeRoom(parent, environment, size - left);
      if (room < size) throw storageFullError(size, room);
    }
    const handle = await folder.getFileHandle(DOWNLOADED, { create: true });
    const pageSums = new PageChecksums();
    written = await writeStream(handle, summed(pieces, pageSums), count => { written = count; });
    const stored = await handle.getFile();
    if (stored.size !== written) throw new Error(`${name}: ${formatCountOf(written, 'byte')} arrived, ${formatCountOf(stored.size, 'byte')} were kept.`);
    const sums = pageSums.finish();
    const checks = await writeChecks(folder, new Map([[DOWNLOADED, sums]]));
    await touch(folder);
    await writeSmallFile(folder, MANIFEST, new TextEncoder().encode(JSON.stringify({
      kind: 'download',
      whole: true,
      revision: KEPT_STORE_REVISION,
      persist: persistent,
      ...(persistent ? {} : { tab: THIS_TAB }),
      key: await identityDigest(filed),
      source: await identityDigest(identity),
      createdAt: Date.now(),
      blobs: { [DOWNLOADED]: written },
      checks,
    })));
    keptDownloads.set(await identityDigest(identity), directory);
    return {
      file: new File([stored], name, { lastModified: stored.lastModified }),
      checks: { pageBytes: CHECK_PAGE_BYTES, sums, directory },
      kept: 'opfs',
      persistent,
    };
  } catch (error) {
    heldByPage.delete(directory);
    (await held)();
    await parent.removeEntry(directory, { recursive: true }).catch(() => {});
    if (error?.name !== 'QuotaExceededError') throw error;
    // The browser's real bound: what nobody holds makes room, and the
    // caller may download it again.
    throw quotaError(error, written, { freed: await makeRoom(parent, environment, Number.isFinite(size) ? size : Math.max(1, written)) });
  }
}

/**
 * Remove a kept download once nothing needs it (the store transcoded from
 * it is kept on its own). Never throws.
 *
 * @param {Object|null} identity
 * @param {Object} [environment]
 */
export async function releaseKeptDownload(identity, environment = globalThis) {
  const key = await identityDigest(identity ?? null);
  const directory = keptDownloads.get(key);
  if (directory === undefined) return;
  keptDownloads.delete(key);
  const held = heldByPage.get(directory);
  heldByPage.delete(directory);
  if (held !== undefined) (await held.catch(() => () => {}))();
  // The lock goes once its callback settles: after this task.
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    if (parent === null) return;
    await whileUnheld(environment.navigator?.locks, directory, () => parent.removeEntry(directory, { recursive: true }).catch(() => {}));
  } catch {
    // Left for least-recently-used removal.
  }
}

/** The pieces as they pass, their page checksums taken on the way. */
async function* summed(pieces, sums) {
  for await (const piece of pieces) {
    sums.add(piece);
    yield piece;
  }
}

/**
 * Write a stream of pieces to one file: a writable stream (a page) or a
 * synchronous access handle (a worker). `onWritten(bytes)` hears how much is
 * written so far.
 */
async function writeStream(handle, pieces, onWritten) {
  let written = 0;
  if (typeof handle.createWritable === 'function') {
    const writable = await handle.createWritable();
    try {
      for await (const piece of pieces) {
        await writable.write(piece);
        written += piece.byteLength;
        onWritten(written);
      }
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => {});
      throw error;
    }
    return written;
  }
  const access = await handle.createSyncAccessHandle();
  try {
    for await (const piece of pieces) {
      let done = 0;
      while (done < piece.byteLength) done += access.write(piece.subarray(done), { at: written + done });
      written += piece.byteLength;
      onWritten(written);
    }
    access.truncate(written);
    access.flush();
  } finally {
    access.close();
  }
  return written;
}

async function gatherInMemory(pieces, name) {
  let blob = new Blob([]);
  let batch = [];
  let batchBytes = 0;
  for await (const piece of pieces) {
    batch.push(piece);
    batchBytes += piece.byteLength;
    if (batchBytes >= MEMORY_DOWNLOAD_BATCH_BYTES) {
      blob = new Blob([blob, ...batch]);
      batch = [];
      batchBytes = 0;
    }
  }
  return new File([blob, ...batch], name);
}

/**
 * @typedef {Object} Region
 * @property {string} store - The blob it is in (`file`: the source file itself)
 * @property {number} offset
 * @property {number} byteLength
 */

/**
 * @typedef {Object} TranscodeSpace
 * @property {'opfs'|'memory'} kind
 * @property {string|null} directory
 * @property {boolean} persistent - Kept for later visits once complete
 *   (`persistsAcrossVisits`), else for the tab's life
 * @property {import('../../../formats/rds/parse.js').RdsSink} sink - Where
 *   the parser writes kept payloads (each its own blob)
 * @property {(bytes: Uint8Array) => Promise<Region>} put - Keep derived bytes
 * @property {(region: Region) => Promise<Uint8Array>} read - Read a region back
 * @property {(manifest: Object, used: Set<string>) => Promise<Map<string, Object>>} finish -
 *   Delete the blobs not in `used`, write the manifest last (OPFS: with the
 *   identity, the revision, whether it is kept for later visits and every
 *   blob's size), and the blob readers by name
 * @property {() => Promise<void>} discard - Remove everything written (the
 *   reader's lock goes with the worker; a complete store stays held)
 * @property {() => void} release - Let go of the writer's lock on a complete
 *   store that is not read from here (a kept gene index: whoever opens it
 *   later holds it then, and the page holds it for its tab's life)
 */

/**
 * Open a space for one pass.
 *
 * @param {Object|null} identity - The source file's identity (`byte-source.js`)
 * @param {{environment?: Object, memory?: boolean, onDirectory?: ((directory: string) => void)|null, tab?: string, optional?: boolean}} [options]
 *   `memory`: keep everything in memory (tests, and where OPFS is absent);
 *   `onDirectory(name)`: told the directory's name before anything is
 *   written to it; `tab`: the tab a store kept for one tab only belongs to
 *   (`THIS_TAB`); `optional`: a copy kept only to spare later work (a gene
 *   index run), which makes room only from copies as cheap to make again
 *   (`OPTIONAL_COPY_RANK`), never from a converted store or a download
 * @returns {Promise<TranscodeSpace>}
 */
export async function openTranscodeSpace(identity, { environment = globalThis, memory = false, onDirectory = null, tab = THIS_TAB, optional = false } = {}) {
  const root = memory ? null : await opfsRoot(environment);
  const parent = root === null ? null : await parentDirectory(root, true);
  if (parent !== null) {
    try {
      return await opfsSpace(parent, identity, environment, onDirectory, tab, optional ? OPTIONAL_COPY_RANK : Infinity);
    } catch (error) {
      if (error?.code === 'UNSUPPORTED') throw error;
      // No synchronous access handles here: the store is kept in memory.
    }
  }
  return memorySpace();
}

function memorySpace() {
  const blobs = new Map();
  let next = 0;
  const space = {
    kind: 'memory',
    directory: null,
    persistent: false,
    sink: {
      open() {
        // Each piece is copied once, into a Blob; the payload's Blob is made
        // of those, not a second copy.
        const parts = [];
        return {
          write: view => {
            parts.push(new Blob([view]));
          },
          close: () => {
            const name = `p${next++}`;
            const blob = new Blob(parts);
            blobs.set(name, blob);
            return { store: name, offset: 0, byteLength: blob.size };
          },
        };
      },
      release(region) {
        blobs.delete(region.store);
      },
    },
    async put(bytes) {
      const name = `m${next++}`;
      blobs.set(name, new Blob([bytes]));
      return { store: name, offset: 0, byteLength: bytes.length };
    },
    async read(region) {
      const blob = blobs.get(region.store);
      if (blob === undefined) throw new Error(`The kept bytes '${region.store}' are missing.`);
      return blobBytes(blob, region.offset, region.offset + region.byteLength);
    },
    async finish(_manifest, used) {
      const readers = new Map();
      for (const [name, blob] of [...blobs]) {
        if (used.has(name)) readers.set(name, blobReader(blob));
        else blobs.delete(name);
      }
      return readers;
    },
    async discard() {
      blobs.clear();
    },
    release() {},
  };
  return space;
}

async function opfsSpace(parent, identity, environment, onDirectory, tab, upTo) {
  const locks = environment.navigator?.locks;
  await removeAbandoned(parent, locks);
  const directory = await directoryFor(identity);
  const release = await holdShared(locks, directory);
  onDirectory?.(directory);
  let folder;
  let derived;
  try {
    folder = await parent.getDirectoryHandle(directory, { create: true });
    const derivedHandle = await folder.getFileHandle(DERIVED, { create: true });
    if (typeof derivedHandle.createSyncAccessHandle !== 'function') throw new TypeError('No synchronous access handles.');
    derived = await derivedHandle.createSyncAccessHandle();
  } catch (error) {
    release();
    await parent.removeEntry(directory, { recursive: true }).catch(() => {});
    throw error;
  }
  // What the browser says is left when the pass starts, less what the pass
  // has written since (the estimate itself lags behind writes).
  let left = await storageLeft(environment);
  let written = 0;
  let derivedEnd = 0;
  let next = 0;
  const open = new Set([derived]);
  const files = [];
  // Each blob's page checksums, taken as it is written (in order).
  const sums = new Map([[DERIVED, new PageChecksums()]]);
  const fits = bytes => left === null || written + bytes <= left;
  /** Room for `bytes` more: kept stores nobody holds go, cheapest to make again and least recently used first. */
  const ensureRoom = async bytes => {
    if (fits(bytes)) return;
    left += await makeRoom(parent, environment, written + bytes - left, upTo);
    if (!fits(bytes)) throw storageFullError(written + bytes, left);
  };
  const charge = bytes => {
    // A write of unknown length cannot make room here (it is synchronous):
    // the pass stops, and makes room once (`session.js`).
    if (!fits(bytes)) throw storageFullError(written + bytes, left, { madeRoom: false });
    written += bytes;
  };
  const space = {
    kind: 'opfs',
    directory,
    persistent: persistsAcrossVisits(identity),
    sink: {
      async open(byteLength) {
        // A payload whose length is known makes room for itself before
        // anything of it is written, and is refused when room cannot be
        // made; what is written is counted as it is.
        if (Number.isFinite(byteLength)) await ensureRoom(byteLength);
        const name = `p${next++}.bin`;
        let handle;
        try {
          handle = await (await folder.getFileHandle(name, { create: true })).createSyncAccessHandle();
        } catch (error) {
          throw quotaError(error, written);
        }
        open.add(handle);
        files.push(name);
        const pageSums = new PageChecksums();
        sums.set(name, pageSums);
        let at = 0;
        return {
          write: view => {
            charge(view.length);
            let done = 0;
            try {
              while (done < view.length) done += handle.write(view.subarray(done), { at: at + done });
            } catch (error) {
              throw quotaError(error, written);
            }
            pageSums.add(view);
            at += view.length;
          },
          close: () => {
            handle.flush();
            handle.close();
            open.delete(handle);
            return { store: name, offset: 0, byteLength: at };
          },
        };
      },
      async release(region) {
        const at = files.indexOf(region.store);
        if (at < 0) return;
        files.splice(at, 1);
        sums.delete(region.store);
        written -= region.byteLength;
        await folder.removeEntry(region.store).catch(() => {});
      },
    },
    async put(bytes) {
      await ensureRoom(bytes.length);
      charge(bytes.length);
      const offset = derivedEnd;
      let done = 0;
      try {
        while (done < bytes.length) done += derived.write(bytes.subarray(done), { at: offset + done });
      } catch (error) {
        throw quotaError(error, written);
      }
      sums.get(DERIVED).add(bytes);
      derivedEnd += bytes.length;
      return { store: DERIVED, offset, byteLength: bytes.length };
    },
    async read(region) {
      if (region.store === DERIVED && open.has(derived)) {
        const out = allocateTypedArray(Uint8Array, region.byteLength, 'Converted bytes');
        derived.read(out, { at: region.offset });
        return out;
      }
      const file = await (await folder.getFileHandle(region.store)).getFile();
      return blobBytes(file, region.offset, region.offset + region.byteLength);
    },
    async finish(manifest, used) {
      for (const handle of open) {
        handle.flush();
        handle.close();
      }
      open.clear();
      const readers = new Map();
      const sizes = {};
      const kept = new Map();
      const checked = pageChecked(manifest);
      for (const name of [DERIVED, ...files]) {
        if (!used.has(name)) {
          await folder.removeEntry(name).catch(() => {});
          continue;
        }
        const file = await (await folder.getFileHandle(name)).getFile();
        sizes[name] = file.size;
        if (!checked) {
          readers.set(name, blobReader(file));
          continue;
        }
        const table = sums.get(name).finish();
        kept.set(name, table);
        readers.set(name, checkedBlob(file, table, folder, keptLabel(manifest)));
      }
      let checks;
      try {
        checks = checked ? await writeChecks(folder, kept) : undefined;
      } catch (error) {
        throw quotaError(error, written);
      }
      await touch(folder);
      // Last: the manifest makes the directory complete.
      const bytes = new TextEncoder().encode(JSON.stringify({
        ...manifest,
        revision: revisionOf(manifest),
        persist: space.persistent,
        ...(space.persistent ? {} : { tab }),
        key: await identityDigest(identity),
        createdAt: Date.now(),
        blobs: sizes,
        ...(checks === undefined ? {} : { checks }),
      }));
      try {
        await writeSmallFile(folder, MANIFEST, bytes);
      } catch (error) {
        throw quotaError(error, written + bytes.length);
      }
      return readers;
    },
    async discard() {
      for (const handle of open) {
        try {
          handle.close();
        } catch {
          // Closed already.
        }
      }
      open.clear();
      await parent.removeEntry(directory, { recursive: true }).catch(() => {});
      release();
    },
    release() {
      release();
    },
  };
  return space;
}
