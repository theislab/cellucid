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
 * - No backward compatibility is provided intentionally (development phase).
 * - If any scope dimension is missing, persistence is disabled (in-memory only).
 */

import { parseOwnerRepo } from './github-sync.js';

const CACHE_ROOT_PREFIX = 'cellucid:community-annotations:cache:';

function toCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeDatasetIdOrNull(datasetId) {
  const did = toCleanString(datasetId);
  return did ? did : null;
}

function normalizeGitHubUserIdOrNull(userId) {
  const n = Number(userId);
  if (!Number.isFinite(n)) return null;
  const safe = Math.max(0, Math.floor(n));
  return safe ? String(safe) : null;
}

function parseRepoRefStrictOrNull(repoRef) {
  const parsed = parseOwnerRepo(repoRef);
  if (!parsed?.ownerRepo || !parsed?.ref) return null;
  return { ownerRepo: parsed.ownerRepo, branch: parsed.ref };
}

function enc(value) {
  return encodeURIComponent(toCleanString(value));
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
  const p = toCleanString(path).replace(/^\/+/, '');
  if (!key || !p) return null;
  return `${key}::${p}`;
}
