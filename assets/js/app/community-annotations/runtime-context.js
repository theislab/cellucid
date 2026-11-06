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
import { toCacheScopeKey } from './cache-scope.js';
import { getCommunityAnnotationScopeLock } from './scope-lock.js';

// ---------------------------------------------------------------- Paused here
//
// One tab at a time annotates a scope (dataset + repository@branch + GitHub
// user): the scope lock (`scope-lock.js`). Another tab on the same scope is
// not an error. Its annotation is paused here: its session stays unscoped
// (nothing read, nothing written, nothing published), the dataset controls
// work as ever, and the panel says "Open in another tab — annotation paused
// here" with Use here (`useAnnotationScopeHere`), which takes the lock over;
// the other tab then pauses in turn.

/** What a tab says while another tab annotates the same scope. */
export const ANNOTATION_PAUSED_HERE = 'Open in another tab — annotation paused here';

/** What the scope lock refuses because another tab holds the scope. */
const HELD_ELSEWHERE = new Set(['LOCK_HELD', 'LOCK_VERIFY_FAILED', 'LOCK_LOST']);

/** Scope keys paused in this tab. */
const pausedScopes = new Set();
const pauseListeners = new Set();

function pauseChanged() {
  for (const listener of [...pauseListeners]) {
    try { listener(); } catch (error) { console.error('[community annotation] a pause listener failed', error); }
  }
}

/** Whether `error` is the scope lock saying another tab holds the scope. */
export function isHeldElsewhere(error) {
  return HELD_ELSEWHERE.has(error?.code);
}

/**
 * Pause annotation of a scope in this tab (another tab holds it).
 * @param {string} scopeKey - `toCacheScopeKey`
 */
export function pauseAnnotationScopeHere(scopeKey) {
  if (typeof scopeKey !== 'string' || scopeKey === '' || pausedScopes.has(scopeKey)) return;
  pausedScopes.add(scopeKey);
  pauseChanged();
}

/**
 * Hear when a scope is paused or used here again. Returns the unsubscribe.
 * @param {() => void} listener
 */
export function onAnnotationPauseChange(listener) {
  pauseListeners.add(listener);
  return () => pauseListeners.delete(listener);
}

/**
 * The connected scope of the dataset shown when it is paused in this tab,
 * else null: `{datasetId, repoRef, userId, scopeKey}`.
 * @param {{dataSourceManager?: object|null, datasetId?: string|null}} [options]
 */
export function annotationPauseOf({ dataSourceManager = null, datasetId = undefined } = {}) {
  const ctx = connectedScopeOf({ dataSourceManager, datasetId });
  return ctx !== null && pausedScopes.has(ctx.scopeKey) ? ctx : null;
}

/**
 * Use annotation of the paused scope here (the person's Use here): take the
 * lock over from the other tab, then scope the session to it.
 * @param {{dataSourceManager?: object|null, datasetId?: string|null}} [options]
 * @returns {ReturnType<typeof getCommunityAnnotationCacheContext>}
 */
export function useAnnotationScopeHere({ dataSourceManager = null, datasetId = undefined } = {}) {
  const pause = annotationPauseOf({ dataSourceManager, datasetId });
  if (pause === null) return syncCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
  const taken = getCommunityAnnotationScopeLock().takeOver(pause.scopeKey);
  if (!taken?.ok) {
    const error = new Error(taken?.message || 'Annotation could not be taken over from the other tab');
    error.code = taken?.code || 'LOCK_TAKEOVER_FAILED';
    throw error;
  }
  pausedScopes.delete(pause.scopeKey);
  pauseChanged();
  return syncCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
}

/** The fully connected scope of the dataset (a repository and a GitHub user), or null. */
function connectedScopeOf({ dataSourceManager, datasetId }) {
  const ctx = computeContext({ dataSourceManager, datasetId });
  const scopeKey = toCacheScopeKey(ctx);
  return scopeKey === null ? null : { datasetId: ctx.datasetId, repoRef: ctx.repoRef, userId: ctx.userId, scopeKey };
}

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
 * The id community annotation files a dataset's suggestions and votes under:
 * the dataset's identity id, whatever route opened it. A file that states its
 * id (`uns['cellucid']['id']`) has that id from a sample catalog, a link, a
 * server or a local file, so a repository's annotations follow the dataset,
 * not the way it was opened.
 *
 * @param {{getCurrentIdentityId?: Function}|null} dataSourceManager
 * @returns {string|null}
 */
export function annotationDatasetIdOf(dataSourceManager) {
  return dataSourceManager?.getCurrentIdentityId?.() ?? null;
}

/**
 * Compute the active community-annotation cache context.
 *
 * @param {object} [options]
 * @param {import('../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
 * @param {string|null} [options.datasetId] - Overrides `annotationDatasetIdOf(dataSourceManager)`.
 * @returns {{
 *   datasetId: string|null,
 *   userKey: string,
 *   userId: number|null,
 *   repoRef: string|null,
 *   simulated: boolean
 * }} `repoRef` is null while another tab annotates the scope
 *   (`annotationPauseOf`), until the person chooses Use here
 */
export function getCommunityAnnotationCacheContext({ dataSourceManager = null, datasetId = undefined } = {}) {
  const ctx = computeContext({ dataSourceManager, datasetId });
  const scopeKey = toCacheScopeKey(ctx);
  // Paused here (another tab annotates the scope): unscoped, so this tab
  // reads and writes nothing of it.
  // reads and writes nothing of it (`annotationPauseOf` says so).
  if (scopeKey !== null && pausedScopes.has(scopeKey)) return { ...ctx, repoRef: null };
  return ctx;
}

function computeContext({ dataSourceManager, datasetId }) {
  const auth = getGitHubAuthSession();
  const simulated = isSimulateRepoConnectedEnabled();

  const rawDatasetId =
    datasetId === undefined
      ? annotationDatasetIdOf(dataSourceManager)
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
 * @param {import('../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
 * @param {string|null} [options.datasetId]
 * @returns {ReturnType<typeof getCommunityAnnotationCacheContext>}
 */
export function syncCommunityAnnotationCacheContext({ dataSourceManager = null, datasetId = undefined } = {}) {
  const session = getCommunityAnnotationSession();
  const ctx = getCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
  try {
    session.setCacheContext({
      datasetId: ctx.datasetId,
      repoRef: ctx.repoRef,
      userId: ctx.userId,
    });
    return ctx;
  } catch (error) {
    // Another tab annotates this scope: pause it here, never fail the caller
    // (the dataset controls, the legend, the field list run through here).
    const scopeKey = toCacheScopeKey(ctx);
    if (!isHeldElsewhere(error) || scopeKey === null) throw error;
    pauseAnnotationScopeHere(scopeKey);
    session.setCacheContext({ datasetId: ctx.datasetId, repoRef: null, userId: null });
    return { ...ctx, repoRef: null };
  }
}
