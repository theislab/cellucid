/**
 * @fileoverview Community annotation runtime cache-context helpers.
 *
 * Why this exists
 * ---------------
 * Multiple UI modules (sidebar controls, field selector, legend) need to ensure
 * the community-annotation session is scoped correctly so local state and raw
 * downloads never leak across:
 * - datasetId
 * - repo (owner/repo)
 * - branch
 * - user.id (GitHub numeric id; NOT username/login)
 *
 * Historically, each UI module re-implemented this derivation, which is easy to
 * drift and can cause transient "wrong scope" loads (flicker, confusing UI).
 *
 * This module centralizes the derivation so all callers agree on the same rules.
 *
 * Notes
 * -----
 * - This module is UI-agnostic (no DOM writes).
 * - It does not perform network calls; if the GitHub user object is not yet
 *   loaded, it falls back to the last-known `ghid_<id>` key when available.
 *
 * @module community-annotations/runtime-context
 */

import { getCommunityAnnotationSession } from './session.js';
import { isSimulateRepoConnectedEnabled } from './access-store.js';
import { getAnnotationRepoForDataset, getLastAnnotationRepoForDataset } from './repo-store.js';
import { getGitHubAuthSession, getLastGitHubUserKey, toGitHubUserKey } from './github-auth.js';

function toCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeUsername(value) {
  return toCleanString(value).replace(/^@+/, '').toLowerCase();
}

function parseGitHubUserIdFromKey(userKey) {
  const raw = normalizeUsername(userKey);
  const m = raw.match(/^ghid_(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/**
 * Compute the active community-annotation cache context.
 *
 * @param {object} [options]
 * @param {import('../../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
 * @param {string|null} [options.datasetId] - Overrides `dataSourceManager.getCurrentDatasetId()`.
 * @returns {{
 *   datasetId: string|null,
 *   userKey: string,
 *   userId: number|null,
 *   repoRef: string|null,
 *   simulated: boolean
 * }}
 */
export function getCommunityAnnotationCacheContext({ dataSourceManager = null, datasetId = null } = {}) {
  const session = getCommunityAnnotationSession();
  const auth = getGitHubAuthSession();
  const simulated = isSimulateRepoConnectedEnabled();

  const did = toCleanString(datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? '') || null;

  // Prefer the authenticated GitHub numeric id (stable, required for scoping).
  const authIdRaw = auth.getUser?.()?.id ?? null;
  const authId = Number.isFinite(Number(authIdRaw)) ? Math.max(0, Math.floor(Number(authIdRaw))) : null;

  // Repo-map key: prefer `ghid_<id>`. If the auth user object is not loaded yet,
  // use the last-known key to avoid transient "no repo" scope.
  const lastKey = getLastGitHubUserKey();
  const authedKey = toGitHubUserKey(auth.getUser?.());
  const userKey = normalizeUsername(
    authedKey ||
    (auth.isAuthenticated?.() ? lastKey : null) ||
    (simulated ? lastKey : null) ||
    session.getProfile?.()?.username ||
    'local'
  ) || 'local';

  const userId = authId || parseGitHubUserIdFromKey(userKey) || null;

  let repoRef = did ? (getAnnotationRepoForDataset(did, userKey) || null) : null;
  if (!repoRef && simulated && did) {
    repoRef = getLastAnnotationRepoForDataset(did, userKey) || null;
  }

  return { datasetId: did, userKey, userId, repoRef, simulated };
}

/**
 * Apply the computed cache context to the session (idempotent if unchanged).
 *
 * @param {object} [options]
 * @param {import('../../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
 * @param {string|null} [options.datasetId]
 * @returns {ReturnType<typeof getCommunityAnnotationCacheContext>}
 */
export function syncCommunityAnnotationCacheContext({ dataSourceManager = null, datasetId = null } = {}) {
  const session = getCommunityAnnotationSession();
  const ctx = getCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
  session.setCacheContext?.({ datasetId: ctx.datasetId, repoRef: ctx.repoRef, userId: ctx.userId });
  return ctx;
}

