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
 *   - Raw file download cache + sha index (IndexedDB + localStorage)
 *
 * Notes
 * -----
 * - Only the current exact scope representation is accepted.
 * - If any scope dimension is missing, no persistent scope key exists.
 */

import { parseCanonicalGitHubRepositoryReference } from './github-reference.js';

const CACHE_ROOT_PREFIX = 'cellucid:community-annotations:cache:';

function normalizeDatasetIdOrNull(datasetId) {
  if (datasetId === null || datasetId === undefined || datasetId === '') return null;
  if (
    typeof datasetId !== 'string' ||
    !/\S/.test(datasetId) ||
    /^\s|\s$/.test(datasetId) ||
    Array.from(datasetId).length > 256
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

export function toFileShaIndexKey(scope) {
  const key = toCacheScopeKey(scope);
  if (!key) return null;
  return `${CACHE_ROOT_PREFIX}${key}:files:shas`;
}

export function toFileRecordKey(scope, path) {
  const key = toCacheScopeKey(scope);
  const p =
    typeof path === 'string' &&
    path &&
    !/^\s|\s$/.test(path)
      ? path
      : null;
  if (!key || !p) return null;
  return `${key}::${p}`;
}
