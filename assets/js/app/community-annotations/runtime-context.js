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
 * This module centralizes the derivation so all callers agree on the same rules.
 *
 * Notes
 * -----
 * - This module is UI-agnostic (no DOM writes).
 * - It does not perform network calls. A connected scope requires the current
 *   authenticated GitHub identity; prior identities are never substituted.
 *
 * @module community-annotations/runtime-context
 */

import { getCommunityAnnotationSession } from './session.js';
import { isSimulateRepoConnectedEnabled } from './access-store.js';
import { getAnnotationRepoForDataset } from './repo-store.js';
import { getGitHubAuthSession, toGitHubUserKey } from './github-auth.js';

function parseGitHubUserIdFromKey(userKey) {
  if (typeof userKey !== 'string') return null;
  const m = userKey.match(/^ghid_([1-9][0-9]*)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return (
    Number.isSafeInteger(n) &&
    n > 0 &&
    userKey === `ghid_${n}`
  ) ? n : null;
}

function normalizeGitHubUserIdOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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
export function getCommunityAnnotationCacheContext({ dataSourceManager = null, datasetId = undefined } = {}) {
  const auth = getGitHubAuthSession();
  const simulated = isSimulateRepoConnectedEnabled();

  const rawDatasetId =
    datasetId === undefined
      ? dataSourceManager?.getCurrentDatasetId?.()
      : datasetId;
  let did = null;
  if (rawDatasetId !== null && rawDatasetId !== undefined) {
    if (
      typeof rawDatasetId !== 'string' ||
      !/\S/.test(rawDatasetId) ||
      /^\s|\s$/.test(rawDatasetId) ||
      Array.from(rawDatasetId).length > 256
    ) {
      throw new Error(
        'Community annotation datasetId must be an exact nonblank string or null'
      );
    }
    did = rawDatasetId;
  }

  const authUser = auth.getUser();
  const authId = normalizeGitHubUserIdOrNull(authUser?.id);
  const authedKey = toGitHubUserKey(authUser);
  const userKey = authedKey === null ? 'local' : authedKey;
  const userId =
    authedKey === null
      ? null
      : parseGitHubUserIdFromKey(authedKey);
  if (authId !== userId) {
    throw new Error(
      'Authenticated GitHub identity does not match its exact cache key'
    );
  }

  const repoRef = did && authedKey
    ? getAnnotationRepoForDataset(did, authedKey)
    : null;

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
export function syncCommunityAnnotationCacheContext({ dataSourceManager = null, datasetId = undefined } = {}) {
  const session = getCommunityAnnotationSession();
  const ctx = getCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
  session.setCacheContext({
    datasetId: ctx.datasetId,
    repoRef: ctx.repoRef,
    userId: ctx.userId,
  });
  return ctx;
}
