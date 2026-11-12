/**
 * Community Annotation - Cache scope helpers.
 *
 * Requirement
 * -----------
 * All local cache for a single annotation project must be isolated by:
 *   - datasetId
 *   - repo (owner/repo)
 *   - branch
 *   - user.id (GitHub numeric id; NOT username/login)
 *
 * We use the same scope key for:
 *   - Local session persistence (localStorage)
 *   - The Pull's file cache (IndexedDB, `file-cache.js`)
 *
 * Notes
 * -----
 * - Only the current exact scope representation is accepted.
 * - If any scope dimension is missing, no persistent scope key exists.
 */

import { parseCanonicalGitHubRepositoryReference } from './github-reference.js';
import { webStorage } from '../../utils/web-storage.js';

const CACHE_ROOT_PREFIX = 'cellucid:community-annotations:cache:';

function normalizeDatasetIdOrNull(datasetId) {
  if (datasetId === null || datasetId === undefined || datasetId === '') return null;
  if (
    typeof datasetId !== 'string' ||
    !/\S/.test(datasetId) ||
    /^\s|\s$/.test(datasetId)
  ) {
    return null;
  }
  return datasetId;
}

function normalizeGitHubUserIdOrNull(userId) {
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  return String(userId);
}

function parseRepoRefStrictOrNull(repoRef) {
  if (
    typeof repoRef !== 'string' ||
    !repoRef ||
    /^\s|\s$/.test(repoRef)
  ) {
    return null;
  }
  const parsed = parseCanonicalGitHubRepositoryReference(repoRef);
  if (!parsed?.ownerRepo || !parsed?.ref) return null;
  return { ownerRepo: parsed.ownerRepo, branch: parsed.ref };
}

function enc(value) {
  return encodeURIComponent(value);
}

/**
 * Build the stable cache scope key.
 *
 * Format (URL-encoded segments):
 *   <datasetId>|<owner/repo>|<branch>|<userId>
 *
 * @param {object} scope
 * @param {string} scope.datasetId
 * @param {string} scope.repoRef - must include "@branch"
 * @param {number|string} scope.userId - GitHub numeric user id
 * @returns {string|null}
 */
export function toCacheScopeKey({ datasetId, repoRef, userId } = {}) {
  const did = normalizeDatasetIdOrNull(datasetId);
  const repo = parseRepoRefStrictOrNull(repoRef);
  const uid = normalizeGitHubUserIdOrNull(userId);
  if (!did || !repo || !uid) return null;
  return `${enc(did)}|${enc(repo.ownerRepo)}|${enc(repo.branch)}|${enc(uid)}`;
}

export function describeCacheScope({ datasetId, repoRef, userId } = {}) {
  const did = normalizeDatasetIdOrNull(datasetId);
  const repo = parseRepoRefStrictOrNull(repoRef);
  const uid = normalizeGitHubUserIdOrNull(userId);
  if (!did || !repo || !uid) return null;
  return { datasetId: did, repo: repo.ownerRepo, branch: repo.branch, userId: uid };
}

export function toSessionStorageKey(scope) {
  const key = toCacheScopeKey(scope);
  if (!key) return null;
  return `${CACHE_ROOT_PREFIX}${key}:session`;
}

/**
 * Where this browser keeps the person's own file as last published or pulled
 * (`ui/modules/community-annotation/published-baseline.js`).
 */
export function toPublishedViewKey(scope) {
  const key = toCacheScopeKey(scope);
  if (!key) return null;
  return `${CACHE_ROOT_PREFIX}${key}:published`;
}

/**
 * The suffix of a key the file cache no longer writes: Cellucid 0.9.6 and
 * earlier mirrored each cache scope's path → SHA index of a Pull into
 * localStorage (`<prefix><scope>:files:shas`, up to megabytes for a large
 * repository); the index now lives in IndexedDB alone (`file-cache.js`).
 */
const RETIRED_FILE_SHA_INDEX_SUFFIX = ':files:shas';

/**
 * Remove the retired SHA indexes from `storage` (the page's localStorage):
 * nothing reads them, and each one counts against the origin's storage
 * budget, which the session and the published views share. This deletes
 * dead data, it migrates nothing: only keys under this module's prefix that
 * end in the retired suffix (a session `:session` or published view
 * `:published` key never does). Runs once when community annotation starts.
 *
 * @param {Storage|null} [storage] - the page's localStorage when not given
 * @returns {number} how many keys were removed
 */
export function removeRetiredFileShaIndexes(storage = undefined) {
  const retired = [];
  try {
    storage = storage === undefined ? webStorage('localStorage') : storage;
    if (!storage) return 0;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (
        typeof key === 'string' &&
        key.startsWith(CACHE_ROOT_PREFIX) &&
        key.endsWith(RETIRED_FILE_SHA_INDEX_SUFFIX)
      ) {
        retired.push(key);
      }
    }
    for (const key of retired) storage.removeItem(key);
  } catch {
    // A browser that keeps no site data, or refuses access: nothing to free.
    return 0;
  }
  return retired.length;
}
