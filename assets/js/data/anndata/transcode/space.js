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
 * - `listKeptStores` lists what is kept for later visits, an item per
 *   converted store, download and gene index, each with what its manifest's
 *   `about` says it is (the file's name and host, never a link:
 *   `keptAbout`), its size, when it was last opened and whether an open tab
 *   uses it; `removeKeptStores` removes the items chosen, or everything, that
 *   no open tab holds (the Session panel's Stored dialog).
 *
 * A **kept journal** (`openKeptJournal`: the downloaded parts of a remote
 * file, `formats/io/kept-parts.js`) is the one kind kept as it is written:
 * its manifest is written first, and its contents are the records of its
 * `j.bin` (each appended after the bytes it names in `d.bin`, framed by its
 * length and CRC-32 with its bytes' page checksums), read as far as they are
 * whole (`parseKeptJournal`); its writer holds a writing lock, and another
 * reader reads it only once that lock is free.
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
  CHECK_PAGE_BYTES, PageChecksums, checkedRead, checksumBytes, checksumOf, checksumsFit, checksumsFromBytes, pageChecksumsOf,
} from '../../../formats/io/page-checks.js';
import { formatBytes, formatCountOf } from '../../../utils/format-units.js';
import { createOpaqueId } from '../../../app/utils/opaque-id.js';
import { linkIdentity } from '../../sources/link-credentials.js';
import { addressOf, fileIdentityOf, persistsAcrossVisits } from '../../sources/identity.js';
import { ARRAY_PIECE_BYTES } from '../../../utils/large-arrays.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { KeptBytesMissing, readWhole, requireHeld, writeAt, writeWhole } from '../../../formats/io/sync-access.js';

export const TRANSCODED_DIRECTORY = 'cellucid-transcoded';

/**
 * Bytes `[start, end)` of a Blob or File. `arrayBuffer()` makes one
 * `ArrayBuffer`, and a region (a whole per-cell array) can be larger than an
 * engine allows one, so a region larger than one piece is read piece by
 * piece into one array (`allocateTypedArray`).
 */
async function blobBytes(blob, start, end) {
  // A kept file shorter than its region is refused, never read as zeros.
  const piece = async (from, to) => {
    const bytes = new Uint8Array(await blob.slice(from, to).arrayBuffer());
    if (bytes.length !== to - from) throw new KeptBytesMissing(bytes.length, to - from, from);
    return bytes;
  };
  if (end - start <= ARRAY_PIECE_BYTES) return piece(start, end);
  const out = allocateTypedArray(Uint8Array, end - start, 'Converted bytes');
  for (let at = start; at < end; at += ARRAY_PIECE_BYTES) {
    const to = Math.min(end, at + ARRAY_PIECE_BYTES);
    out.set(await piece(at, to), at - start);
  }
  return out;
}
const MANIFEST = 'manifest.json';
const DERIVED = 'd.bin';
/** The file whose text is when a directory was last opened (ms since the epoch). */
const LAST_USED = 'used';
/** The file a kept download is. */
const DOWNLOADED = 'source';
/** The records of a kept journal (`openKeptJournal`): where each piece of its bytes (`d.bin`) is of its file. */
const JOURNAL = 'j.bin';

/**
 * The revision of what the transcoders write. A kept store of another
 * revision is removed, never read: raise it whenever a transcoder's output
 * changes (`tests/transcode-cache-contract.test.mjs` fails until it is).
 */
export const KEPT_STORE_REVISION = 5;

/**
 * The revision of what a gene index kept in this browser holds
 * (`../kept-column-index.js`, manifests of kind `column-index`): a kept index
 * of another revision is removed, never read. Raise it whenever the code
 * that decides what an index holds changes: the index and its kept form,
 * the matrix reads and conversions it is built from, the layouts and the
 * chunk decoders (`tests/kept-column-index-contract.test.mjs` pins the
 * digest of that code, comments aside, and fails until it is raised).
 */
export const KEPT_INDEX_REVISION = 5;

/**
 * The revision of the raw bytes of remote files kept in this browser: a
 * file downloaded whole (`kind: download`) and the downloaded parts of one
 * read in place (`kind: parts`, `formats/io/kept-parts.js`, kept as a
 * journal: `openKeptJournal`). They are the file's own bytes, so no reader,
 * converter or decoder change touches them: only a change of how they are
 * laid out and checked (the manifest, the journal's records, the page
 * checksums) does. Raise it then: the golden bytes in
 * `tests/kept-parts-contract.test.mjs` change with any such change, and a
 * release that does not change them keeps every download. 2: files named
 * by the one version rule (`writeVersion`), with their address in the
 * manifest; downloads kept at 1 (0.9.6) are removed, never read.
 */
export const KEPT_BYTES_REVISION = 2;

/** The revision a manifest of its kind is read at. */
function revisionOf(manifest) {
  if (manifest?.kind === 'column-index') return KEPT_INDEX_REVISION;
  return manifest?.kind === 'download' || manifest?.kind === 'parts' ? KEPT_BYTES_REVISION : KEPT_STORE_REVISION;
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
  const bytes = new TextEncoder().encode(canonicalJson(cacheKey(identity)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What every kept directory's manifest says of the file it is of, besides
 * the digest of what it is filed under (`key`): the file's digest
 * (`fileKey`: its identity, version included) and its address's
 * (`address`: `addressOf`, null for a file on this computer), so that the
 * kept copies of every kind of another version of the same file are found
 * (`forgetOtherVersions`).
 */
async function fileFields(identity) {
  const file = fileIdentityOf(identity);
  const address = addressOf(file);
  return { fileKey: await identityDigest(file), address: address === null ? null : await identityDigest(address) };
}

/** How much of an address's digest a directory name carries (`keptAtAddress`). */
const ADDRESS_NAME_DIGITS = 12;

/**
 * A directory name for a source: its digest's start, its file's address's
 * (`addressOf`; `local` for a file on this computer), then a random part.
 */
async function directoryFor(identity) {
  const address = addressOf(identity);
  const at = address === null ? 'local' : (await identityDigest(address)).slice(0, ADDRESS_NAME_DIGITS);
  return `${(await identityDigest(identity)).slice(0, 24)}-${at}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Whether anything is kept in this browser of the file at `address` (an
 * identity without its version: `{kind: 'remote', key}`), of any version,
 * from the directory names alone (nothing is read or held). A hint, not a
 * promise: what is kept is checked when it is used. Opening a remote file
 * asks it before probing the file (`data/sources/remote-file.js`): when
 * something is kept, the probe asks only for the version, and the file's
 * first bytes come from what is kept when the version is the same. False
 * without OPFS; never throws.
 *
 * @param {Object|null} address
 * @param {Object} [environment]
 * @returns {Promise<boolean>}
 */
export async function keptAtAddress(address, environment = globalThis) {
  try {
    const at = addressOf(address);
    if (at === null) return false;
    const marker = `-${(await identityDigest(at)).slice(0, ADDRESS_NAME_DIGITS)}-`;
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    if (parent === null) return false;
    for (const { name } of await directoriesOf(parent)) if (name.slice(24).startsWith(marker)) return true;
    return false;
  } catch {
    return false;
  }
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
      writeWhole(access, bytes, 0);
      access.truncate(bytes.length);
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    // Its lock goes with it, and the file keeps what it held before.
    await writable.abort(error).catch(() => {});
    throw error;
  }
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
function checkedBlob(file, sums, label, forget) {
  const reader = blobReader(file);
  return {
    size: reader.size,
    read: checkedRead(reader.read, { size: reader.size, sums, label, onDamage: forget }),
  };
}

/** Whether a manifest's blobs are read through page checksums: a gene index checks each gene's piece instead. */
const pageChecked = manifest => manifest?.kind !== 'column-index';

/** What a kept directory is, in a message about it. */
const keptLabel = manifest => (manifest?.kind === 'download' ? 'A file downloaded whole'
  : manifest?.kind === 'parts' ? 'The downloaded parts of a file' : 'The converted copy of a file');

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

/**
 * The lock a kept directory's files are read and removed under: shared by
 * whoever reads them (the Stored listing, room making, a sweep, a reader
 * finding what is kept), exclusive for the removal of the directory or of
 * its manifest. A directory's own lock (`lockName`) says who uses it, and a
 * removal waits for nobody to: it is let go of while used. This one makes a
 * removal wait for the reads in flight, and a read for the removal: WebKit
 * logs a read of a file removed after the read began as a failed load
 * ("WebKitBlobResource error 1", whatever the caller does with the error),
 * and the Stored listing read directories a reader's opening removed (Web
 * contracts runs 41213981681 and 41255961977, macOS WebKit,
 * `kept-parts.spec.mjs`). Taken after the directory's own lock, never
 * before, and held only for the reads or the removal.
 */
const filesOf = directory => `${directory}#files`;

/** Run `read` of a kept directory's files while no removal of them runs. */
function readingFiles(locks, name, read) {
  if (typeof locks?.request !== 'function') return read();
  return locks.request(lockName(filesOf(name)), { mode: 'shared' }, read);
}

/** Run `remove` (of a kept directory or its manifest) once no read of its files runs. */
function removingFiles(locks, name, remove) {
  if (typeof locks?.request !== 'function') return remove();
  return locks.request(lockName(filesOf(name)), { mode: 'exclusive' }, remove);
}

/** Remove a kept directory, once no read of its files runs. Never throws. */
function removeDirectory(parent, name, locks) {
  return removingFiles(locks, name, () => parent.removeEntry(name, { recursive: true })).catch(() => {});
}

/** Remove a kept directory's manifest (it is forgotten), once no read of its files runs. Never throws. */
function removeManifest(folder, name, locks) {
  return removingFiles(locks, name, () => folder.removeEntry(MANIFEST)).catch(() => {});
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
    if (keptForLater(await readingFiles(locks, name, () => manifestOf(folder)))) continue;
    await whileUnheld(locks, name, () => removeDirectory(parent, name, locks));
  }
}

/**
 * What making a kept directory again costs, as a rank: a gene index run
 * (`../kept-column-index.js`) is built again from the rows of its file it
 * covers, read in parts, and a file's downloaded parts
 * (`formats/io/kept-parts.js`) are downloaded again as they are read; a
 * converted store or a file downloaded whole only by reading or downloading
 * its whole file again (and converting it).
 */
function rebuildRank(manifest) {
  return manifest.kind === 'column-index' || manifest.kind === 'parts' ? 0 : 1;
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
    const candidate = await readingFiles(locks, name, async () => {
      const manifest = await manifestOf(folder);
      if (!keptForLater(manifest) || rebuildRank(manifest) > upTo) return null;
      return { name, bytes: await directoryBytes(folder, manifest), rank: rebuildRank(manifest), used: await lastUsedOf(folder) };
    });
    if (candidate !== null) candidates.push(candidate);
  }
  candidates.sort((a, b) => a.rank - b.rank || a.used - b.used || (a.name < b.name ? -1 : 1));
  let freed = 0;
  for (const { name, bytes } of candidates) {
    if (freed >= deficit) break;
    const removed = dryRun
      ? typeof locks?.request === 'function' && !(await isHeld(locks, name))
      : await whileUnheld(locks, name, () => removeDirectory(parent, name, locks));
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
  return manifest.kind === 'download' || manifest.kind === 'column-index' || manifest.kind === 'parts' ? manifest.source : manifest.key;
}

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

/** What a kept item is, by its manifest's kind. */
function itemKind(manifest) {
  if (manifest.kind === 'column-index') return 'gene-index';
  if (manifest.kind === 'parts') return 'parts';
  return manifest.kind === 'download' ? 'download' : 'converted';
}

/**
 * What a kept directory spares the next opening, in bytes not downloaded,
 * where its manifest says: a file downloaded whole, the file. Null for a
 * kind that does not know (a file's downloaded parts say it in their
 * journal: `journalSizes`).
 */
function savesOf(manifest) {
  if (manifest.kind === 'download') return Number(manifest.blobs?.source) || 0;
  return null;
}

/**
 * The item a kept directory belongs to: a converted store, a file
 * downloaded whole, or a gene index (every run of rows of one file's matrix
 * for one cell order: the group it is filed under). An id is a kind and a
 * digest, never a name or a link.
 */
const itemIdOf = manifest => `${itemKind(manifest)}:${manifest.key}`;

/** The bytes every file a manifest lists takes. */
const manifestBytes = manifest => Object.values(manifest.blobs ?? {}).reduce((sum, size) => sum + (Number(size) || 0), 0);

/** The kept directories, each with its manifest; none without OPFS. */
async function keptDirectories(environment) {
  const root = await opfsRoot(environment);
  const parent = root === null ? null : await parentDirectory(root, false);
  if (parent === null) return { parent: null, entries: [] };
  const entries = [];
  const locks = environment.navigator?.locks;
  for (const { name, folder } of await directoriesOf(parent)) {
    entries.push({ name, folder, manifest: await readingFiles(locks, name, () => manifestOf(folder)) });
  }
  return { parent, entries };
}

/**
 * Where what is kept lives, as this browser says it: this site's private
 * storage in the browser profile (the origin private file system of
 * `origin`), managed by the browser, not a folder of the computer's file
 * system. `available`: whether this browser window gives the site such
 * storage at all (a private window, or a browser without it, keeps data only
 * until the tab closes), found by asking for it, never by the browser's
 * name. `estimate`: the browser's own figures for this site (bytes used and
 * the most it allows), null when it gives none. `persisted`: whether the
 * browser keeps the site's storage when the disk runs low (true), may clear
 * it then (false), or does not say (null); `canPersist`: whether it can be
 * asked to keep it (`keepKeptStoresWhenSpaceIsLow`). Never throws.
 *
 * @param {Object} [environment]
 * @returns {Promise<{origin: string|null, available: boolean, estimate: {usage: number, quota: number}|null,
 *   persisted: boolean|null, canPersist: boolean}>}
 */
export async function keptStoragePlace(environment = globalThis) {
  const storage = environment?.navigator?.storage;
  const origin = typeof environment?.location?.origin === 'string' && environment.location.origin !== 'null' ? environment.location.origin : null;
  const available = (await opfsRoot(environment)) !== null;
  let estimate = null;
  try {
    const figures = typeof storage?.estimate === 'function' ? await storage.estimate() : null;
    if (Number.isFinite(figures?.usage) && Number.isFinite(figures?.quota)) estimate = { usage: figures.usage, quota: figures.quota };
  } catch {
    estimate = null;
  }
  let persisted = null;
  try {
    if (typeof storage?.persisted === 'function') persisted = (await storage.persisted()) === true;
  } catch {
    persisted = null;
  }
  return { origin, available, estimate, persisted, canPersist: available && typeof storage?.persist === 'function' };
}

/**
 * Ask the browser to keep this site's storage when the disk runs low
 * (`navigator.storage.persist()`; Firefox asks the person, others decide by
 * how the site is used). Only on the person's request. Whether it is kept
 * now; false when the browser refused or cannot be asked. Never throws.
 *
 * @param {Object} [environment]
 * @returns {Promise<boolean>}
 */
export async function keepKeptStoresWhenSpaceIsLow(environment = globalThis) {
  try {
    return (await environment.navigator.storage.persist()) === true;
  } catch {
    return false;
  }
}

/**
 * Listing and removal run one at a time in a page: whether a tab holds a
 * directory is asked by requesting its lock if it is free (`isHeld`,
 * `whileUnheld`), and such a request of one is, for as long as it lasts, a
 * holder to the other, which would then call the directory in use.
 */
let keptQueue = Promise.resolve();
function oneAtATime(work) {
  const run = keptQueue.then(work);
  keptQueue = run.catch(() => {});
  return run;
}

/**
 * @typedef {Object} KeptItem - One thing kept in this browser for later
 *   visits, as the Session panel lists it
 * @property {string} id - Its kind and its identity's digest (what
 *   `removeKeptStores` takes)
 * @property {string} kind - What it is: `converted` (a file converted once:
 *   an R object, a MatrixMarket folder), `download` (a file a host serves
 *   only whole), `gene-index` (the gene index of a matrix stored cell by
 *   cell, for one cell order), `parts` (the parts of a file read in place
 *   that readers downloaded: `formats/io/kept-parts.js`, every journal of
 *   them one item); the list is open to other kinds
 * @property {string} file - The file it is of (`fileOf`, a digest): a
 *   converted store and its download, and every gene index of one file, are
 *   one file, listed as one dataset
 * @property {number} [saves] - What it spares the next opening, in bytes not
 *   downloaded, for a kind that knows it (`parts`: every byte kept;
 *   `download`: the file)
 * @property {string|null} name - The file's name (`keptAbout`), null when
 *   its keeper did not say
 * @property {string|null} host - Its host, null for a file on this computer
 * @property {string|null} matrix - A gene index: its matrix (`X`,
 *   `layers/counts`, …)
 * @property {Object|null} order - A gene index: the cells it indexes (`order`
 *   `file`: every cell; else the subsample's method, seed and settings)
 * @property {number} bytes - What it takes
 * @property {number} used - When it was last opened (ms since the epoch; 0
 *   when not known)
 * @property {'none'|'this-tab'|'other-tab'} held - Whether an open tab uses
 *   it (then it cannot be removed until that tab closes)
 */

/**
 * Everything kept for later visits, an item per converted store, download,
 * file's downloaded parts and gene index (a gene index's runs of rows, and
 * a file's journals of parts, are one item), most recently
 * used first. What is kept for one tab only, and incomplete passes, are not
 * listed: they go with their tab. Empty without OPFS; never throws.
 *
 * @param {Object} [environment]
 * @returns {Promise<KeptItem[]>}
 */
export function listKeptStores(environment = globalThis) {
  return oneAtATime(() => listKept(environment));
}

async function listKept(environment) {
  /** @type {Map<string, KeptItem>} */
  const items = new Map();
  try {
    const { entries } = await keptDirectories(environment);
    const locks = environment.navigator?.locks;
    for (const { name, folder, manifest } of entries) {
      if (!keptForLater(manifest)) continue;
      const id = itemIdOf(manifest);
      const about = manifest.about ?? null;
      let item = items.get(id);
      if (item === undefined) {
        item = {
          id,
          kind: itemKind(manifest),
          file: fileOf(name, manifest),
          name: typeof about?.name === 'string' ? about.name : null,
          host: typeof about?.host === 'string' ? about.host : null,
          matrix: typeof about?.matrix === 'string' ? about.matrix : null,
          order: about?.order ?? null,
          bytes: 0,
          used: 0,
          held: 'none',
        };
        items.set(id, item);
      }
      const { sizes, used } = await readingFiles(locks, name, async () => ({
        sizes: isJournal(manifest) ? await journalSizes(folder, manifest) : { bytes: manifestBytes(manifest), saves: savesOf(manifest) },
        used: await lastUsedOf(folder),
      }));
      item.bytes += sizes.bytes;
      if (sizes.saves !== null) item.saves = (item.saves ?? 0) + sizes.saves;
      item.used = Math.max(item.used, used);
      if (await isHeld(locks, name)) item.held = heldByPage.has(name) || item.held === 'this-tab' ? 'this-tab' : 'other-tab';
    }
  } catch {
    // Storage that cannot be listed: what was listed so far.
  }
  return [...items.values()].sort((a, b) => b.used - a.used || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Remove kept items no open tab uses: those named by `ids`
 * (`listKeptStores`), or every directory nobody holds (`ids` null: every
 * item, and what incomplete or tab-only passes left). An item an open tab
 * uses stays until that tab closes; of an item some of whose directories a
 * tab holds (a gene index's runs), the others go. Never throws.
 * `removed`: the items removed whole; `held`: the items that stay, in use.
 *
 * @param {Iterable<string>|null} ids
 * @param {Object} [environment]
 * @returns {Promise<{removed: number, held: number}>}
 */
export async function removeKeptStores(ids, environment = globalThis) {
  const result = await oneAtATime(() => removeKept(ids === null ? null : new Set(ids), environment));
  announceKeptStores();
  return result;
}

async function removeKept(wanted, environment) {
  const gone = new Set();
  const stayed = new Set();
  try {
    const { parent, entries } = await keptDirectories(environment);
    if (parent === null) return { removed: 0, held: 0 };
    const locks = environment.navigator?.locks;
    for (const { name, manifest } of entries) {
      const item = keptForLater(manifest) ? itemIdOf(manifest) : null;
      if (wanted !== null && (item === null || !wanted.has(item))) continue;
      const removed = typeof locks?.request === 'function'
        ? await whileUnheld(locks, name, () => removingFiles(locks, name, () => parent.removeEntry(name, { recursive: true })))
        : await parent.removeEntry(name, { recursive: true }).then(() => true);
      if (item === null) continue;
      (removed ? gone : stayed).add(item);
    }
  } catch {
    // What could not be removed stays for the next start's sweep or removal.
  }
  return { removed: [...gone].filter(item => !stayed.has(item)).length, held: stayed.size };
}

/**
 * Opening a version of a file makes what is kept of its other versions
 * stale: every kept directory of every kind (converted store, download,
 * downloaded parts, gene index runs) of the same address (`addressOf`) and
 * another version is forgotten -- its manifest removed, so no opening finds
 * it again, and the directory removed once no tab holds it (a tab still
 * showing that version keeps reading what it opened). Called before
 * anything kept of the file is used (`data/anndata/open.js`), and only
 * under a version that is known (`persistsAcrossVisits`): an opening whose
 * version cannot be told removes nothing. Resolves to how many were
 * forgotten; never throws.
 *
 * @param {Object|null} identity - The file's identity, as this opening established it
 * @param {Object} [environment]
 * @returns {Promise<number>}
 */
export function forgetOtherVersions(identity, environment = globalThis) {
  return forgetKept(identity, environment, { current: false });
}

/**
 * The file changed on its source while it was open (its host answered
 * with another version: `byte-source.js` `CHANGED`): every kept directory
 * of it, of this version and every other, is forgotten as
 * `forgetOtherVersions` forgets the others. Never throws.
 *
 * @param {Object|null} identity
 * @param {Object} [environment]
 * @returns {Promise<number>}
 */
export function forgetKeptFile(identity, environment = globalThis) {
  return forgetKept(identity, environment, { current: true });
}

async function forgetKept(identity, environment, { current }) {
  const file = fileIdentityOf(identity);
  if (file === null) return 0;
  // A version that cannot be told (`size:<n>`, a provider that could not be
  // asked) says nothing of what is kept under another: nothing is removed
  // for it; it is only never used.
  if (!current && !persistsAcrossVisits(file)) return 0;
  let forgotten = 0;
  try {
    const { fileKey, address } = await fileFields(file);
    // A file on this computer has no other versions to tell apart.
    if (!current && address === null) return 0;
    const { parent, entries } = await keptDirectories(environment);
    if (parent === null) return 0;
    const locks = environment.navigator?.locks;
    for (const { name, folder, manifest } of entries) {
      if (manifest === null) continue;
      const sameFile = manifest.fileKey === fileKey;
      const otherVersion = address !== null && manifest.address === address && !sameFile;
      if (!(otherVersion || (current && sameFile))) continue;
      await removeManifest(folder, name, locks);
      forgotten++;
      if (typeof locks?.request === 'function') await whileUnheld(locks, name, () => removeDirectory(parent, name, locks));
    }
  } catch {
    // Storage that cannot be listed: nothing more is forgotten now.
  }
  if (forgotten > 0) announceKeptStores();
  return forgotten;
}

/** Whoever shows what is kept hears when the page starts holding a newly kept directory (`onKeptStoresChange`). */
const keptStoreListeners = new Set();

/**
 * Hear when what is kept changed in this page: a directory kept since (a
 * gene index run kept in the background after its opening ended), or items
 * removed (`removeKeptStores`). The Session panel's Stored line and dialog.
 * Returns what stops it.
 *
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onKeptStoresChange(listener) {
  keptStoreListeners.add(listener);
  return () => keptStoreListeners.delete(listener);
}

/** Tell whoever shows what is kept that it changed (`onKeptStoresChange`). */
function announceKeptStores() {
  for (const listener of keptStoreListeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }
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
    announceKeptStores();
  }
  await heldByPage.get(directory)?.catch(() => {});
}

/**
 * Let go of a complete directory this page holds that a newer one replaced
 * (a matrix share a larger share replaced, `matrix-market.js`
 * `MatrixStream.letGo`; the worker let its own hold go first): the page's
 * hold goes, and the directory is removed at once when nobody else holds
 * it. Another tab reading it keeps it; that folder's next opening removes
 * it then (`matrix-market.js` `keptShare` keeps the largest share only).
 * Never throws.
 *
 * @param {string} directory
 * @param {Object} [environment]
 */
export async function letGoTranscodedStore(directory, environment = globalThis) {
  if (typeof directory !== 'string') return;
  const held = heldByPage.get(directory);
  heldByPage.delete(directory);
  if (held !== undefined) (await held.catch(() => () => {}))();
  // The lock goes once its callback settles: after this task.
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    const root = await opfsRoot(environment);
    const parent = root === null ? null : await parentDirectory(root, false);
    if (parent !== null) await whileUnheld(environment.navigator?.locks, directory, () => removeDirectory(parent, directory, environment.navigator?.locks));
  } catch {
    // Left for that folder's next opening.
  }
  announceKeptStores();
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
    const remove = () => removeDirectory(parent, directory, locks);
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
async function checkedBlobs(folder, manifest, digest, tab, locks, directory) {
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
    blobs.set(name, checkedBlob(file, sums, keptLabel(manifest), () => removeManifest(folder, directory, locks)));
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
    let journal = null;
    let manifest = null;
    try {
      ({ manifest, blobs, journal } = await readingFiles(locks, name, async () => {
        const read = await manifestOf(folder);
        if (!isJournal(read)) {
          return { manifest: read, blobs: read === null ? null : await checkedBlobs(folder, read, digest, tab, locks, name), journal: null };
        }
        const checked = await checkedJournal(folder, read, digest, tab, locks, name);
        return { manifest: read, blobs: checked?.blobs ?? checked, journal: checked?.journal ?? null };
      }));
    } catch {
      blobs = null;
    }
    if (blobs === 'writing') {
      // Its writer still appends to it (another tab, or a reader leaving):
      // left alone, and found by the next opening.
      release();
      continue;
    }
    if (blobs !== null && blobs !== 'other-tab') {
      await touch(folder);
      found.push({
        directory: name,
        manifest,
        blobs,
        ...(journal === null ? {} : { journal }),
        release,
        // Remove it (it is damaged): once this reader's lock goes, if nobody else holds it.
        discard: async () => {
          release();
          await new Promise(resolve => setTimeout(resolve, 0));
          await whileUnheld(locks, name, () => removeDirectory(parent, name, locks));
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
      await whileUnheld(locks, name, () => removeDirectory(parent, name, locks));
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
    const folder = await parent.getDirectoryHandle(directory);
    await removingFiles(environment.navigator?.locks, directory, () => folder.removeEntry(MANIFEST));
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
 * @param {{name: string, url?: string|null, size?: number|null, environment?: Object}} options -
 *   `url`: where it is downloaded from (its host, never the link, is kept in
 *   the manifest: `keptAbout`); `size`: the bytes the host says it sends,
 *   when it says (room is made for them first)
 * @returns {Promise<{file: File, checks: {pageBytes: number, sums: Uint32Array, directory: string}|null, kept: 'opfs'|'memory', persistent: boolean}>}
 *   `checks`: the page checksums taken as it was written (null in memory)
 */
export async function keepDownload(identity, pieces, { name, url = null, size = null, environment = globalThis }) {
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
      revision: KEPT_BYTES_REVISION,
      persist: persistent,
      ...(persistent ? {} : { tab: THIS_TAB }),
      key: await identityDigest(filed),
      ...await fileFields(filed),
      source: await identityDigest(identity),
      about: keptAbout({ name, url }),
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
    await removeDirectory(parent, directory, locks);
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
    await whileUnheld(environment.navigator?.locks, directory, () => removeDirectory(parent, directory, environment.navigator?.locks));
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
      writeAt(access, piece, written);
      written += piece.byteLength;
      onWritten(written);
    }
    // The file holds what was written (`formats/io/sync-access.js`: a
    // private window's storage may keep less than it reports).
    requireHeld(access, written);
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
    await removeDirectory(parent, directory, locks);
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
            try {
              writeAt(handle, view, at);
            } catch (error) {
              throw quotaError(error, written);
            }
            pageSums.add(view);
            at += view.length;
          },
          close: () => {
            // The payload is all in its file (`formats/io/sync-access.js`:
            // a private window's storage may keep less than it reports).
            try {
              requireHeld(handle, at);
            } catch (error) {
              throw quotaError(error, written);
            }
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
      try {
        writeWhole(derived, bytes, offset);
      } catch (error) {
        throw quotaError(error, written);
      }
      sums.get(DERIVED).add(bytes);
      derivedEnd += bytes.length;
      return { store: DERIVED, offset, byteLength: bytes.length };
    },
    async read(region) {
      if (region.store === DERIVED && open.has(derived)) {
        return readWhole(derived, allocateTypedArray(Uint8Array, region.byteLength, 'Converted bytes'), region.offset);
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
        readers.set(name, checkedBlob(file, table, keptLabel(manifest), () => removeManifest(folder, directory, locks)));
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
        ...await fileFields(identity),
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
      await removeDirectory(parent, directory, locks);
      release();
    },
    release() {
      release();
    },
  };
  return space;
}

// ---------------------------------------------------------------------------
// Kept journals: bytes kept as they arrive (`formats/io/kept-parts.js`)
// ---------------------------------------------------------------------------

/** What a record of a kept journal is (its first byte). */
const RECORD_RANGE = 1;
const RECORD_OBJECT = 2;
const RECORD_CONFIRMED = 3;
const RECORD_ABSENT = 4;

/** A record's frame: its body's length and its body's CRC-32, before the body. */
const RECORD_FRAME_BYTES = 8;

/**
 * The lock a journal's writer holds (exclusive) for as long as it writes:
 * another reader reads a journal only once it is free (its writer closed,
 * or its worker ended, which lets every lock it held go).
 */
const writingOf = directory => `${directory}#writing`;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** One framed record of `type`, its body written by `write(view, at)` after the type byte. */
function framedRecord(type, bodyBytes, write) {
  const out = allocateTypedArray(Uint8Array, RECORD_FRAME_BYTES + bodyBytes, 'A kept journal record');
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, bodyBytes, true);
  out[RECORD_FRAME_BYTES] = type;
  write(view, RECORD_FRAME_BYTES + 1);
  view.setUint32(4, checksumOf(out.subarray(RECORD_FRAME_BYTES)), true);
  return out;
}

/**
 * The record of a piece of an object's bytes kept: the object (`''`, a
 * file), where the piece starts in it, where its bytes are in `d.bin`, how
 * many there are, and the CRC-32 of each `CHECK_PAGE_BYTES` of them (from
 * the piece's first byte), against which every read of them is checked.
 */
function rangeRecord(key, start, offset, bytes) {
  const name = utf8.encode(key);
  const sums = pageChecksumsOf(bytes);
  return framedRecord(RECORD_RANGE, 1 + 24 + 4 + name.length + 4 * sums.length, (view, at) => {
    view.setFloat64(at, start, true);
    view.setFloat64(at + 8, offset, true);
    view.setFloat64(at + 16, bytes.length, true);
    view.setUint32(at + 24, name.length, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 28, name.length).set(name);
    for (let i = 0, to = at + 28 + name.length; i < sums.length; i++, to += 4) view.setUint32(to, sums[i], true);
  });
}

/** The record of what an object's host said of it: its exact size (−1: not known) and validator (its ETag or date). */
function objectRecord(key, { size = null, validator = null }) {
  const name = utf8.encode(key);
  const tag = utf8.encode(validator ?? '');
  return framedRecord(RECORD_OBJECT, 1 + 4 + name.length + 8 + 1 + 4 + tag.length, (view, at) => {
    view.setUint32(at, name.length, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 4, name.length).set(name);
    const to = at + 4 + name.length;
    view.setFloat64(to, Number.isSafeInteger(size) && size >= 0 ? size : -1, true);
    view.setUint8(to + 8, validator === null ? 0 : 1);
    view.setUint32(to + 9, tag.length, true);
    new Uint8Array(view.buffer, view.byteOffset + to + 13, tag.length).set(tag);
  });
}

/** The record of an object of a folder its host answered as absent (404, 410): under a content name, it stays absent. */
function absentRecord(key) {
  const name = utf8.encode(key);
  return framedRecord(RECORD_ABSENT, 1 + 4 + name.length, (view, at) => {
    view.setUint32(at, name.length, true);
    new Uint8Array(view.buffer, view.byteOffset + at + 4, name.length).set(name);
  });
}

/**
 * The records of a kept journal, read from its bytes in order, as far as
 * they are whole and what they say holds: reading stops at the first record
 * that is cut short (a write the browser or the machine stopped), does not
 * match its CRC-32, or names bytes `d.bin` (of `dataSize` bytes) does not
 * hold. `confirmed`: how many of the first ranges a confirmation follows
 * (`appendConfirmed`); `absent`: the objects of a folder its host answered
 * as absent (`appendAbsent`).
 *
 * @param {Uint8Array} bytes - The journal's records
 * @param {number} dataSize - The bytes of its `d.bin`
 * @returns {{ranges: Array<{key: string, start: number, offset: number, length: number, sums: Uint32Array}>,
 *   objects: Map<string, {size: number|null, validator: string|null}>, absent: Set<string>, confirmed: number}}
 */
export function parseKeptJournal(bytes, dataSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges = [];
  const objects = new Map();
  const absent = new Set();
  let confirmed = 0;
  let at = 0;
  const safe = value => Number.isSafeInteger(value) && value >= 0;
  while (at + RECORD_FRAME_BYTES < bytes.length) {
    const bodyBytes = view.getUint32(at, true);
    const end = at + RECORD_FRAME_BYTES + bodyBytes;
    if (bodyBytes < 1 || end > bytes.length) break;
    const body = bytes.subarray(at + RECORD_FRAME_BYTES, end);
    if (checksumOf(body) !== view.getUint32(at + 4, true)) break;
    const type = body[0];
    const from = at + RECORD_FRAME_BYTES + 1;
    if (type === RECORD_RANGE) {
      if (bodyBytes < 29) break;
      const start = view.getFloat64(from, true);
      const offset = view.getFloat64(from + 8, true);
      const length = view.getFloat64(from + 16, true);
      const nameBytes = view.getUint32(from + 24, true);
      const pages = Math.ceil(length / CHECK_PAGE_BYTES);
      if (!safe(start) || !safe(offset) || !safe(length) || length === 0 || offset + length > dataSize ||
          29 + nameBytes + 4 * pages !== bodyBytes) break;
      const key = fromUtf8.decode(bytes.subarray(from + 28, from + 28 + nameBytes));
      const sums = allocateTypedArray(Uint32Array, pages, 'A kept piece\'s page checksums');
      for (let i = 0, to = from + 28 + nameBytes; i < pages; i++, to += 4) sums[i] = view.getUint32(to, true);
      ranges.push({ key, start, offset, length, sums });
    } else if (type === RECORD_OBJECT) {
      if (bodyBytes < 18) break;
      const nameBytes = view.getUint32(from, true);
      if (1 + 4 + nameBytes + 13 > bodyBytes) break;
      const key = fromUtf8.decode(bytes.subarray(from + 4, from + 4 + nameBytes));
      const to = from + 4 + nameBytes;
      const size = view.getFloat64(to, true);
      const hasValidator = view.getUint8(to + 8) === 1;
      const tagBytes = view.getUint32(to + 9, true);
      if (1 + 4 + nameBytes + 13 + tagBytes !== bodyBytes) break;
      objects.set(key, {
        size: safe(size) ? size : null,
        validator: hasValidator ? fromUtf8.decode(bytes.subarray(to + 13, to + 13 + tagBytes)) : null,
      });
    } else if (type === RECORD_CONFIRMED && bodyBytes === 1) {
      confirmed = ranges.length;
    } else if (type === RECORD_ABSENT && bodyBytes >= 5 && 5 + view.getUint32(from, true) === bodyBytes) {
      absent.add(fromUtf8.decode(bytes.subarray(from + 4, from + 4 + view.getUint32(from, true))));
    } else {
      break;
    }
    at = end;
  }
  return { ranges, objects, absent, confirmed };
}

/**
 * A kept journal's records and bytes, checked against its manifest (as
 * `checkedBlobs` checks a directory's), each range readable only through its
 * page checksums (a damaged page forgets the directory: its manifest goes),
 * or null when it is not what its manifest says; `'other-tab'` for another
 * tab's, `'writing'` while its writer writes it (its records still grow).
 */
async function checkedJournal(folder, manifest, digest, tab, locks, name) {
  if (manifest.revision !== revisionOf(manifest) || manifest.key !== digest) return null;
  if (manifest.persist !== true && manifest.tab !== tab) return 'other-tab';
  if (await isHeld(locks, writingOf(name))) return 'writing';
  let records;
  let data;
  try {
    // Its records before its bytes: a record names only bytes written before it.
    records = new Uint8Array(await (await (await folder.getFileHandle(JOURNAL)).getFile()).arrayBuffer());
    data = await (await folder.getFileHandle(DERIVED)).getFile();
  } catch {
    return null;
  }
  const journal = parseKeptJournal(records, data.size);
  const raw = blobReader(data);
  const label = keptLabel(manifest);
  const onDamage = () => removeManifest(folder, name, locks);
  const ranges = journal.ranges.map(range => ({
    key: range.key,
    start: range.start,
    length: range.length,
    read: checkedRead((offset, length) => raw.read(range.offset + offset, length), { size: range.length, sums: range.sums, label, onDamage }),
  }));
  return { blobs: new Map([[DERIVED, raw]]), journal: { ranges, objects: journal.objects, absent: journal.absent, confirmed: journal.confirmed } };
}

/**
 * What a kept journal takes (its files' sizes) and what it spares the next
 * opening (`saves`: every byte its ranges hold, those confirmed only when
 * its source needs confirming), from its files. Zeros when they cannot be read.
 */
async function journalSizes(folder, manifest) {
  try {
    const records = await (await folder.getFileHandle(JOURNAL)).getFile();
    const data = await (await folder.getFileHandle(DERIVED)).getFile();
    const journal = parseKeptJournal(new Uint8Array(await records.arrayBuffer()), data.size);
    const ranges = manifest.confirms === true ? journal.ranges.slice(0, journal.confirmed) : journal.ranges;
    return { bytes: records.size + data.size, saves: ranges.reduce((sum, range) => sum + range.length, 0) };
  } catch {
    return { bytes: 0, saves: 0 };
  }
}

/** Whether a manifest is a kept journal's (its contents are its records, not a list of files). */
const isJournal = manifest => manifest?.journal === true;

/** The bytes a kept directory takes: the files its manifest lists, or a journal's files. */
async function directoryBytes(folder, manifest) {
  return isJournal(manifest) ? (await journalSizes(folder, manifest)).bytes : manifestBytes(manifest);
}

/**
 * @typedef {Object} KeptJournal - Bytes kept as they arrive: each piece
 *   appended to `d.bin`, then its record appended to `j.bin`
 * @property {string} directory
 * @property {(key: string, start: number, bytes: Uint8Array) => Promise<number>} appendRange - Keep a
 *   piece of an object's bytes; where they are in `d.bin`
 * @property {(key: string, info: {size?: number|null, validator?: string|null}) => Promise<void>} appendObject -
 *   Record what an object's host said of it
 * @property {(key: string) => Promise<void>} appendAbsent - Record an object of a folder its
 *   host answered as absent
 * @property {() => Promise<void>} appendConfirmed - Every range recorded so
 *   far is confirmed (a source whose reads name no version: its provider
 *   confirmed the version still holds)
 * @property {(offset: number, length: number) => Uint8Array} read - Bytes of `d.bin` written here
 * @property {() => void} flush - Ask the disk to hold what is written (a page hidden or left)
 * @property {() => void} close - Stop writing for good: its files and its writing lock go (its
 *   records are whole), and another reader may read it from then on; it is never appended to again
 * @property {() => Promise<{read: (offset: number, length: number) => Promise<Uint8Array>}>} reader - Once
 *   closed, its bytes read from its file
 * @property {() => Promise<void>} discard - Remove it
 * @property {() => void} release - Let the writer's hold on the directory go
 */

/**
 * Open a kept journal for `identity`: a directory of the kept-store
 * machinery whose manifest is written **first**, so it is kept from its
 * first byte on, and whose contents are its records (`j.bin`): each piece of
 * bytes kept is appended to `d.bin` through a synchronous access handle
 * (the write is the operating system's once it returns: a tab closed, a
 * worker ended or a browser that crashes a moment later loses nothing
 * written), then its record, framed by its length and CRC-32, with the
 * piece's page checksums. Whoever opens it later (`findKeptStores`) reads
 * its records as far as they are whole and check, so a browser or machine
 * that stops loses at most the piece being written. The writer holds the
 * directory (shared, as every user does) and its writing lock (exclusive)
 * until it closes; another reader reads it only once that lock is free.
 * An optional copy: it makes room only from copies as cheap to make again
 * (`OPTIONAL_COPY_RANK`). Null where this context keeps nothing across
 * visits (no OPFS, no synchronous access handles, a lock refused, a
 * storage failure).
 *
 * @param {Object} identity - What it is filed under
 * @param {{environment?: Object, tab?: string, manifest?: Object}} [options] - `manifest`: what it
 *   says of itself besides what every kept directory's says (`kind`, `source`, `about`, …)
 * @returns {Promise<KeptJournal|null>}
 */
export async function openKeptJournal(identity, { environment = globalThis, tab = THIS_TAB, manifest = {} } = {}) {
  const root = await opfsRoot(environment);
  const parent = root === null ? null : await parentDirectory(root, true);
  if (parent === null) return null;
  const locks = environment.navigator?.locks;
  let release = () => {};
  let releaseWriting = () => {};
  let directory = null;
  let data = null;
  let records = null;
  let dataHandle = null;
  const persistent = persistsAcrossVisits(identity);
  try {
    // No sweep of abandoned directories here (a journal is begun at every
    // burst of reads; the app's start and every conversion sweep them).
    directory = await directoryFor(identity);
    release = await holdShared(locks, directory);
    releaseWriting = await holdLock(locks, lockName(writingOf(directory)), { mode: 'exclusive' });
    const folder = await parent.getDirectoryHandle(directory, { create: true });
    dataHandle = await folder.getFileHandle(DERIVED, { create: true });
    const recordHandle = await folder.getFileHandle(JOURNAL, { create: true });
    if (typeof dataHandle.createSyncAccessHandle !== 'function') throw new TypeError('No synchronous access handles.');
    data = await dataHandle.createSyncAccessHandle();
    records = await recordHandle.createSyncAccessHandle();
    await touch(folder);
    // First: the manifest keeps the directory; what it holds is what its records say.
    await writeSmallFile(folder, MANIFEST, utf8.encode(JSON.stringify({
      ...manifest,
      journal: true,
      revision: revisionOf(manifest),
      persist: persistent,
      ...(persistent ? {} : { tab }),
      key: await identityDigest(identity),
      ...await fileFields(identity),
      createdAt: Date.now(),
    })));
  } catch {
    for (const handle of [data, records]) {
      try {
        handle?.close();
      } catch {
        // Closed already.
      }
    }
    releaseWriting();
    release();
    if (directory !== null) await removeDirectory(parent, directory, locks);
    return null;
  }
  // What the browser says is left now, less what is written since (the estimate lags behind writes).
  let left = await storageLeft(environment);
  let written = 0;
  let dataEnd = 0;
  let recordEnd = 0;
  let open = true;
  const fits = bytes => left === null || written + bytes <= left;
  const ensureRoom = async bytes => {
    if (fits(bytes)) return;
    left += await makeRoom(parent, environment, written + bytes - left, OPTIONAL_COPY_RANK);
    if (!fits(bytes)) throw storageFullError(written + bytes, left);
  };
  const append = async record => {
    if (!open) throw new Error('The kept journal is closed.');
    await ensureRoom(record.length);
    try {
      writeWhole(records, record, recordEnd);
    } catch (error) {
      throw quotaError(error, written);
    }
    recordEnd += record.length;
    written += record.length;
  };
  const closeHandles = () => {
    if (!open) return;
    open = false;
    for (const handle of [data, records]) {
      try {
        handle.flush();
        handle.close();
      } catch {
        // Closed already.
      }
    }
  };
  return {
    directory,
    async appendRange(key, start, bytes) {
      if (!open) throw new Error('The kept journal is closed.');
      const offset = dataEnd;
      const record = rangeRecord(key, start, offset, bytes);
      await ensureRoom(bytes.length + record.length);
      try {
        // Its bytes are in the file before a record names them.
        writeWhole(data, bytes, offset);
      } catch (error) {
        throw quotaError(error, written);
      }
      dataEnd += bytes.length;
      written += bytes.length;
      // After its bytes: a record names only bytes written.
      await append(record);
      return offset;
    },
    appendObject: (key, info) => append(objectRecord(key, info)),
    appendConfirmed: () => append(framedRecord(RECORD_CONFIRMED, 1, () => {})),
    appendAbsent: key => append(absentRecord(key)),
    read(offset, length) {
      return readWhole(data, allocateTypedArray(Uint8Array, length, 'Kept bytes'), offset);
    },
    flush() {
      if (!open) return;
      data.flush();
      records.flush();
    },
    close() {
      closeHandles();
      releaseWriting();
    },
    async reader() {
      // Closed: its bytes no longer change, so a File of them stays readable.
      return blobReader(await dataHandle.getFile());
    },
    async discard() {
      closeHandles();
      releaseWriting();
      release();
      await removeDirectory(parent, directory, locks);
    },
    release() {
      release();
    },
  };
}
