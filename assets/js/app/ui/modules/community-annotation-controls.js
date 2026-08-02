/**
 * @fileoverview Community annotation (offline-first) sidebar section.
 *
 * - Local session (localStorage) for annotated fields, suggestions, votes
 * - GitHub App auth and repository sync as a UI wrapper around the sync module
 *
 * This module is the controller. It owns everything that must exist exactly
 * once per controls instance and that more than one screen reads: the cache
 * context and its ownership generation, role resolution and its retries, the
 * automatic-pull scheduler, background-task reporting, the single owned modal,
 * the sync status (`syncBusy`, `syncError`, `lastRepoInfo`, `lastRoleContext`),
 * and the Pull and Publish transactions that move that status. It also owns
 * teardown.
 *
 * The screens live in `./community-annotation/` and are built here, each given
 * only what it needs:
 *
 * - `controls-panel.js` — the sidebar itself and all of its view state
 * - `github-connection-flow.js` — the sign-in and repository wizard
 * - `identity-profile-modal.js` — the contributor profile dialog
 * - `consensus-column.js` — the derived consensus column
 *
 * plus leaf helpers with no controller state at all: `dom.js`, `cleanup.js`,
 * `modal-shell.js`, `identity-assertions.js`, `consensus-math.js`,
 * `github-error-classification.js`, and `browser-integration.js`.
 *
 * @module ui/modules/community-annotation-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import { getCommunityAnnotationFileCache } from '../../community-annotations/file-cache.js';
import { describeCacheScope, toCacheScopeKey, toSessionStorageKey } from '../../community-annotations/cache-scope.js';
import { getCommunityAnnotationCacheContext, syncCommunityAnnotationCacheContext } from '../../community-annotations/runtime-context.js';
import { getUrlAnnotationRepo, setUrlAnnotationRepo } from '../../url-state.js';
import { getGitHubAuthSession, toGitHubUserKey } from '../../community-annotations/github-auth.js';
import {
  getCommunityAnnotationAccessStore,
  isAnnotationRepoConnected,
  isSimulateRepoConnectedEnabled
} from '../../community-annotations/access-store.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import {
  clearAnnotationRepoForDataset,
  getAnnotationRepoForDataset,
  getAnnotationRepoMetaForDataset,
  setAnnotationRepoForDataset
} from '../../community-annotations/repo-store.js';
import {
  buildUpdatedAnnotationConfig,
  CommunityAnnotationGitHubSync,
  getGitHubSyncForDataset,
  parseOwnerRepo,
  resolveAnnotationRepositoryFromUrlParam,
  setDatasetAnnotationRepoFromUrlParam,
} from '../../community-annotations/github-sync.js';
import {
  assertMergesDocument,
  assertUserDocument,
  toAnnotationPublicationBytes,
} from '../../community-annotations/wire-contract.js';
import { assertAutoPullIntervalMs } from '../../community-annotations/auto-pull-preferences.js';
import { readAutoPullPreferences } from './community-annotation/auto-pull-storage.js';
import { toCleanString } from './community-annotation/dom.js';
import { runExactCleanup } from './community-annotation/cleanup.js';
import {
  confirmAsync,
  showClusterModal,
} from './community-annotation/modal-shell.js';
import {
  assertExactAnnotationUserKey,
  assertExactGitHubLogin,
  requireAnnotationBranchMode,
  requireGitHubRepositoryFullName,
  requireResolvedAnnotationBranch,
} from './community-annotation/identity-assertions.js';
import { createIdentityProfileModal } from './community-annotation/identity-profile-modal.js';
import { createConsensusColumnApplier } from './community-annotation/consensus-column.js';
import { createGitHubConnectionFlow } from './community-annotation/github-connection-flow.js';
import { createControlsPanel } from './community-annotation/controls-panel.js';
import { describeGitHubAuthReachabilityError } from './community-annotation/browser-integration.js';
import {
  describeCannotPublishMessage,
  getPublishCapability,
  gitHubApiPath,
  httpStatusOrNull,
  isAnnotationRepoStructureError,
  isNetworkFetchFailure,
  isRateLimitError,
  isRepoNotFoundOrNoAccess,
  isTokenAuthFailure,
  isTransientRoleResolutionFailure,
  isWorkerCompatibilityFailure,
  isWorkerOriginSecurityError,
  workerPath,
} from './community-annotation/github-error-classification.js';

export function initCommunityAnnotationControls({
  state,
  dom,
  dataSourceManager,
  infoPopovers
}) {
  const container = dom?.container || null;
  if (!container) return {};
  if (
    infoPopovers === null
    || typeof infoPopovers !== 'object'
    || typeof infoPopovers.closeWithin !== 'function'
    || typeof infoPopovers.configurePair !== 'function'
  ) {
    throw new TypeError(
      'Community annotation controls require the shared information popover controller'
    );
  }

  const session = getCommunityAnnotationSession();
  const access = getCommunityAnnotationAccessStore();
  const fileCache = getCommunityAnnotationFileCache();

  const notifications = getNotificationCenter();
  const githubAuth = getGitHubAuthSession();

  let syncBusy = false;
  let syncError = null;
  let lastRepoInfo = null;
  /** @type {AbortController|null} */
  let activeSyncAbort = null;
  let activeSyncAbortReason = null;
  let activeSyncFatalMessage = null;

  function beginActiveSyncAbortScope() {
    activeSyncFatalMessage = null;
    activeSyncAbortReason = null;
    if (activeSyncAbort !== null) {
      if (typeof activeSyncAbort.abort !== 'function') {
        throw new TypeError('Active annotation sync controller must expose abort()');
      }
      activeSyncAbort.abort();
    }
    if (typeof AbortController !== 'function') {
      throw new TypeError('Community annotation sync requires AbortController');
    }
    activeSyncAbort = new AbortController();
    return activeSyncAbort;
  }

  function bindActiveSyncOwnerSignal(controller, signal) {
    if (
      !controller ||
      typeof controller.abort !== 'function' ||
      !controller.signal
    ) {
      throw new TypeError(
        'Active annotation sync signal binding requires an AbortController'
      );
    }
    if (
      !signal ||
      typeof signal !== 'object' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function' ||
      typeof signal.aborted !== 'boolean'
    ) {
      throw new TypeError(
        'Active annotation sync owner must expose an AbortSignal'
      );
    }
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  }

  function endActiveSyncAbortScope(controller) {
    if (activeSyncAbort !== controller) return;
    activeSyncAbort = null;
    activeSyncAbortReason = null;
    activeSyncFatalMessage = null;
  }

  function abortActiveSync(reason) {
    const msg =
      reason === null || reason === undefined
        ? 'Annotation sync aborted.'
        : reason;
    if (
      typeof msg !== 'string' ||
      !msg ||
      /^\s|\s$/.test(msg)
    ) {
      throw new Error('Annotation sync abort reason must be an exact string');
    }
    activeSyncFatalMessage = msg;
    activeSyncAbortReason = msg;
    if (activeSyncAbort !== null) {
      if (typeof activeSyncAbort.abort !== 'function') {
        throw new TypeError('Active annotation sync controller must expose abort()');
      }
      activeSyncAbort.abort();
    }
  }

  function throwIfActiveSyncAborted(controller) {
    if (!controller || !controller.signal) {
      throw new TypeError('Annotation sync abort checks require an active controller');
    }
    if (activeSyncFatalMessage) {
      const err = new Error(activeSyncFatalMessage);
      err.code = 'ANNOTATION_SYNC_ABORTED';
      throw err;
    }
    if (controller.signal.aborted) {
      const err = new Error(activeSyncAbortReason || 'Annotation sync aborted.');
      err.code = 'ANNOTATION_SYNC_ABORTED';
      throw err;
    }
  }

  function normalizeActiveSyncError(error, controller) {
    if (error?.operation?.outcome === 'unknown') return error;
    if (!controller?.signal?.aborted) return error;
    try {
      throwIfActiveSyncAborted(controller);
    } catch (abortError) {
      return abortError;
    }
    return error;
  }

  /** @type {Record<string, {minAnnotators:number, threshold:number}>} */
  const annotatableSettingsDraft = Object.create(null);
  const annotatableSettingsDirty = new Set();

  function clearAnnotatableSettingsDraft() {
    for (const key of Object.keys(annotatableSettingsDraft)) {
      delete annotatableSettingsDraft[key];
    }
    annotatableSettingsDirty.clear();
  }

  const lifecycleAbort = new AbortController();

  // Keep this accordion in sync when other modules connect/disconnect the repo,
  // or when dev simulation toggles are changed from the console.
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    throw new TypeError('Community annotation controls require window.addEventListener()');
  }
  const reconcileContext = ({ retryRoleIfBusy = false } = {}) => {
    try {
      const owner = applySessionCacheContext({ retryRoleIfBusy });
      render();
      return owner;
    } catch (error) {
      syncError =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Unable to apply the community annotation context';
      notifications.error(syncError, {
        category: 'annotation',
        duration: 10_000,
      });
      render();
      return null;
    }
  };
  const reconcileContextEvent = () => reconcileContext({});
  const reconcileOnlineEvent = () => {
    reconcileContext({ retryRoleIfBusy: true });
  };
  const reconcileOfflineEvent = () => {
    stopAutoPullScheduler();
    if (activeSyncAbort !== null) {
      abortActiveSync('Network connection was lost.');
    }
    closeActiveGitHubConnectionModal();
    render();
  };
  window.addEventListener(
    ANNOTATION_CONNECTION_CHANGED_EVENT,
    reconcileContextEvent,
    { signal: lifecycleAbort.signal }
  );
  window.addEventListener(
    'online',
    reconcileOnlineEvent,
    { signal: lifecycleAbort.signal }
  );
  window.addEventListener(
    'offline',
    reconcileOfflineEvent,
    { signal: lifecycleAbort.signal }
  );

  function getGitHubLogin() {
    const user = githubAuth.getUser();
    return user === null ? '' : user.login;
  }

  function getCacheContext({ datasetId = undefined } = {}) {
    return getCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
  }

  function getCacheUserId() {
    return getCacheContext({}).userId;
  }

  function getCacheUserKey() {
    return getCacheContext({}).userKey;
  }

  let lastRoleContext = '';
  let lastNotifiedCacheScope = '';
  let contextGeneration = 0;
  let authenticationGeneration = 0;
  let publishedContextIdentity = null;
  /** @type {AbortController|null} */
  let publishedContextAbort = null;
  let contextDestroyed = false;
  let activeRoleResolutionOwner = null;
  let pendingOnlineRoleRetryOwner = null;
  let pendingSyncBusyRoleRetryOwner = null;
  let activeCommunityModalClose = null;
  let activeGitHubConnectionClose = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let autoPullTimer = null;
  let autoPullRuntime = null;
  let lastAutoPullPreferenceError = null;

  function showOwnedCommunityModal(options) {
    if (contextDestroyed) return null;
    if (options?.onClosed !== undefined) {
      throw new Error(
        'Owned community annotation modals reserve their close settlement'
      );
    }
    if (activeCommunityModalClose !== null) {
      const closePrevious = activeCommunityModalClose;
      closePrevious();
      if (activeCommunityModalClose === closePrevious) {
        throw new Error(
          'Previous community annotation modal did not settle before replacement'
        );
      }
    }
    let ownedClose = null;
    let settled = false;
    const modalRef = showClusterModal({
      ...options,
      onClosed: () => {
        settled = true;
        if (activeCommunityModalClose === ownedClose) {
          activeCommunityModalClose = null;
        }
      }
    });
    ownedClose = modalRef.close;
    if (settled) return null;
    activeCommunityModalClose = ownedClose;
    if (contextDestroyed) {
      closeOwnedCommunityModal();
      return null;
    }
    return modalRef;
  }

  function closeOwnedCommunityModal() {
    const close = activeCommunityModalClose;
    if (close === null) return;
    if (typeof close !== 'function') {
      throw new TypeError(
        'Owned community annotation modal close handle must be a function'
      );
    }
    close({ restoreFocus: false });
  }

  function closeActiveGitHubConnectionModal() {
    const close = activeGitHubConnectionClose;
    if (close === null) return false;
    if (typeof close !== 'function') {
      throw new TypeError(
        'GitHub connection modal close handle must be a function or null'
      );
    }
    close({ restoreFocus: false });
    if (activeGitHubConnectionClose === close) {
      activeGitHubConnectionClose = null;
    }
    return true;
  }

  let roleRetryState = null;
  let suppressActiveSyncContextAbort = false;
  const roleRetryDelaysMs = Object.freeze([500, 1000, 2000, 4000, 8000]);
  const maxRetryAfterMs = 30_000;

  function contextIdentity(ctx) {
    return JSON.stringify([
      authenticationGeneration,
      ctx.datasetId,
      ctx.repoRef,
      ctx.userKey,
      ctx.userId,
      ctx.simulated,
    ]);
  }

  function publishContextOwner(ctx) {
    const identity = contextIdentity(ctx);
    if (identity !== publishedContextIdentity) {
      const hadPublishedContext = publishedContextIdentity !== null;
      if (publishedContextAbort !== null) {
        publishedContextAbort.abort();
      }
      if (typeof AbortController !== 'function') {
        throw new TypeError(
          'Community annotation context ownership requires AbortController'
        );
      }
      publishedContextAbort = new AbortController();
      publishedContextIdentity = identity;
      contextGeneration += 1;
      cancelScheduledRoleRetry();
      pendingOnlineRoleRetryOwner = null;
      pendingSyncBusyRoleRetryOwner = null;
      clearAnnotatableSettingsDraft();
      stopAutoPullScheduler();
      if (hadPublishedContext) {
        closeOwnedCommunityModal();
      }
      if (
        hadPublishedContext &&
        activeSyncAbort !== null &&
        !suppressActiveSyncContextAbort
      ) {
        abortActiveSync(
          'Annotation dataset, repository, or authenticated user changed.'
        );
      }
    }
    return Object.freeze({
      generation: contextGeneration,
      identity,
      datasetId: ctx.datasetId,
      repoRef: ctx.repoRef,
      userKey: ctx.userKey,
      userId: ctx.userId,
      simulated: ctx.simulated,
      signal: publishedContextAbort.signal,
    });
  }

  function commitExpectedActiveSyncRepoTransition(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(
        'Expected annotation repository transition requires a callback'
      );
    }
    if (suppressActiveSyncContextAbort) {
      throw new Error(
        'Expected annotation repository transitions must not be nested'
      );
    }
    suppressActiveSyncContextAbort = true;
    try {
      return callback();
    } finally {
      suppressActiveSyncContextAbort = false;
    }
  }

  function isContextOwnerCurrent(owner) {
    if (
      contextDestroyed ||
      !owner ||
      typeof owner !== 'object' ||
      owner.generation !== contextGeneration ||
      owner.identity !== publishedContextIdentity ||
      owner.signal !== publishedContextAbort?.signal ||
      owner.signal.aborted
    ) {
      return false;
    }
    let current;
    try {
      current = getCacheContext({});
    } catch {
      return false;
    }
    return contextIdentity(current) === owner.identity;
  }

  function isSameContextOwner(left, right) {
    return Boolean(
      left &&
      right &&
      left.generation === right.generation &&
      left.identity === right.identity &&
      left.signal === right.signal
    );
  }

  function stopAutoPullScheduler() {
    if (autoPullTimer !== null) {
      clearInterval(autoPullTimer);
      autoPullTimer = null;
    }
    autoPullRuntime = null;
  }

  function currentAutoPullRuntime() {
    if (
      contextDestroyed ||
      navigator.onLine === false ||
      !githubAuth.isAuthenticated?.()
    ) {
      return null;
    }
    const ctx = getCacheContext({});
    if (
      !ctx.datasetId ||
      !ctx.repoRef ||
      !Number.isSafeInteger(ctx.userId) ||
      ctx.userId < 1 ||
      ctx.userKey !== `ghid_${ctx.userId}` ||
      ctx.simulated
    ) {
      return null;
    }
    const scopeKey = toCacheScopeKey({
      datasetId: ctx.datasetId,
      repoRef: ctx.repoRef,
      userId: ctx.userId,
    });
    if (scopeKey === null) return null;
    const preference = readAutoPullPreferences()[scopeKey];
    if (preference === undefined || preference.enabled !== true) return null;
    const owner = publishContextOwner(ctx);
    return Object.freeze({
      scopeKey,
      intervalMs: assertAutoPullIntervalMs(preference.intervalMs),
      owner,
      repoRef: ctx.repoRef,
    });
  }

  async function tickAutoPull(runtime) {
    if (
      autoPullRuntime !== runtime ||
      syncBusy ||
      navigator.onLine === false ||
      !isContextOwnerCurrent(runtime.owner)
    ) {
      return;
    }
    await pullFromGitHub({
      repoOverride: runtime.repoRef,
      quiet: true,
      signal: runtime.owner.signal,
    });
  }

  function refreshAutoPullScheduler() {
    let runtime;
    try {
      runtime = currentAutoPullRuntime();
      lastAutoPullPreferenceError = null;
    } catch (error) {
      stopAutoPullScheduler();
      const message =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Unable to load automatic annotation pull preferences';
      if (message !== lastAutoPullPreferenceError) {
        lastAutoPullPreferenceError = message;
        notifications.error(message, {
          category: 'annotation',
          duration: 10_000,
        });
      }
      return false;
    }
    if (runtime === null) {
      stopAutoPullScheduler();
      return false;
    }
    if (
      autoPullTimer !== null &&
      autoPullRuntime !== null &&
      autoPullRuntime.scopeKey === runtime.scopeKey &&
      autoPullRuntime.intervalMs === runtime.intervalMs &&
      isSameContextOwner(autoPullRuntime.owner, runtime.owner)
    ) {
      return true;
    }
    const previousTimer = autoPullTimer;
    const previousRuntime = autoPullRuntime;
    let replacementTimer = null;
    try {
      replacementTimer = setInterval(() => {
        const task = tickAutoPull(runtime);
        observeBackgroundTask(task, {
          label: 'Automatic annotation pull failed',
          owner: runtime.owner,
        });
      }, runtime.intervalMs);
    } catch (error) {
      autoPullTimer = previousTimer;
      autoPullRuntime = previousRuntime;
      throw error;
    }
    if (previousTimer !== null) clearInterval(previousTimer);
    autoPullTimer = replacementTimer;
    autoPullRuntime = runtime;
    return true;
  }

  function reportBackgroundTaskFailure(label, error, owner = null) {
    try {
      if (
        contextDestroyed ||
        (owner !== null && !isContextOwnerCurrent(owner))
      ) {
        return;
      }
      const detail =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'unknown failure';
      syncError = `${label}: ${detail}`;
      notifications.error(syncError, {
        category: 'annotation',
        duration: 10_000,
      });
      render();
    } catch (reportError) {
      try {
        console.error(
          'Unable to report a community annotation background failure',
          reportError,
          error
        );
      } catch (consoleError) {
        const terminalError = new AggregateError(
          [reportError, consoleError, error],
          'Community annotation background failure reporting failed'
        );
        syncError = terminalError.message;
        if (typeof globalThis.reportError === 'function') {
          globalThis.reportError(terminalError);
        }
      }
    }
  }

  function observeBackgroundTask(task, { label, owner = null } = {}) {
    if (
      typeof label !== 'string' ||
      !label ||
      label !== label.trim()
    ) {
      throw new TypeError(
        'Community annotation background task labels must be exact strings'
      );
    }
    try {
      void Promise.resolve(task).catch((error) => {
        reportBackgroundTaskFailure(label, error, owner);
      });
    } catch (error) {
      reportBackgroundTaskFailure(label, error, owner);
    }
  }

  function startBackgroundTask(taskFactory, options) {
    try {
      observeBackgroundTask(taskFactory(), options);
    } catch (error) {
      reportBackgroundTaskFailure(
        options?.label || 'Community annotation background task failed',
        error,
        options?.owner ?? null,
      );
    }
  }

  function cancelScheduledRoleRetry(owner = null) {
    if (
      roleRetryState === null ||
      (
        owner !== null &&
        !isSameContextOwner(roleRetryState.owner, owner)
      )
    ) {
      return false;
    }
    if (roleRetryState.timer !== null) {
      clearTimeout(roleRetryState.timer);
    }
    roleRetryState = null;
    return true;
  }

  function roleRetryDelayMs(error, attempt) {
    const defaultDelayMs =
      roleRetryDelaysMs[
        Math.min(attempt, roleRetryDelaysMs.length - 1)
      ];
    let retryAfterMs = null;
    const rawRetryAfter = error?.retryAfter;
    if (
      typeof rawRetryAfter === 'string' &&
      rawRetryAfter &&
      rawRetryAfter === rawRetryAfter.trim()
    ) {
      if (/^(?:0|[1-9][0-9]*)$/.test(rawRetryAfter)) {
        const seconds = Number(rawRetryAfter);
        if (Number.isSafeInteger(seconds)) {
          retryAfterMs = seconds * 1000;
        }
      } else {
        const timestamp = Date.parse(rawRetryAfter);
        if (Number.isFinite(timestamp)) {
          retryAfterMs = Math.max(0, timestamp - Date.now());
        }
      }
    } else if (
      Number.isSafeInteger(error?.rateLimitResetEpochSeconds) &&
      error.rateLimitResetEpochSeconds >= 0
    ) {
      retryAfterMs = Math.max(
        0,
        error.rateLimitResetEpochSeconds * 1000 - Date.now(),
      );
    }
    if (!Number.isFinite(retryAfterMs)) return defaultDelayMs;
    return Math.min(maxRetryAfterMs, retryAfterMs);
  }

  function scheduleTransientRoleRetry(owner, error) {
    if (!isContextOwnerCurrent(owner)) {
      cancelScheduledRoleRetry(owner);
      return { scheduled: false, exhausted: false, delayMs: null };
    }
    const existing =
      roleRetryState !== null &&
      isSameContextOwner(roleRetryState.owner, owner)
        ? roleRetryState
        : null;
    if (roleRetryState !== null && existing === null) {
      cancelScheduledRoleRetry();
    }
    const attempt = existing === null ? 0 : existing.attempt + 1;
    if (attempt >= roleRetryDelaysMs.length) {
      cancelScheduledRoleRetry(owner);
      return { scheduled: false, exhausted: true, delayMs: null };
    }
    if (existing?.timer !== null && existing?.timer !== undefined) {
      clearTimeout(existing.timer);
    }
    const delayMs = roleRetryDelayMs(error, attempt);
    const scheduled = {
      owner,
      attempt,
      timer: null,
    };
    scheduled.timer = setTimeout(() => {
      if (roleRetryState !== scheduled) return;
      scheduled.timer = null;
      if (!isContextOwnerCurrent(owner)) {
        roleRetryState = null;
        return;
      }
      scheduleResolveConnectedRole(owner);
    }, delayMs);
    roleRetryState = scheduled;
    return {
      scheduled: true,
      exhausted: false,
      delayMs,
      attempt: attempt + 1,
    };
  }

  function retryConnectedRoleImmediately(owner) {
    if (!isContextOwnerCurrent(owner)) return false;
    cancelScheduledRoleRetry(owner);
    if (
      activeRoleResolutionOwner !== null &&
      isSameContextOwner(activeRoleResolutionOwner, owner)
    ) {
      pendingOnlineRoleRetryOwner = owner;
      return true;
    }
    scheduleResolveConnectedRole(owner, { retryIfBusy: true });
    return true;
  }

  function queueRoleRetryAfterActiveSync(owner) {
    if (!isContextOwnerCurrent(owner)) return false;
    pendingSyncBusyRoleRetryOwner = owner;
    return true;
  }

  function flushRoleRetryAfterActiveSync() {
    if (syncBusy || pendingSyncBusyRoleRetryOwner === null) return false;
    const owner = pendingSyncBusyRoleRetryOwner;
    pendingSyncBusyRoleRetryOwner = null;
    if (!isContextOwnerCurrent(owner)) {
      cancelScheduledRoleRetry(owner);
      return false;
    }
    if (access.getRole() !== 'unknown') {
      cancelScheduledRoleRetry(owner);
      return false;
    }
    scheduleResolveConnectedRole(owner);
    return true;
  }

  function adoptAuthenticatedIdentity(ctx) {
    if (ctx.userKey === 'local') return;
    const user = githubAuth.getUser();
    if (
      user === null ||
      user.id !== ctx.userId ||
      `ghid_${user.id}` !== ctx.userKey
    ) {
      throw new Error(
        'Authenticated GitHub identity changed while applying annotation context'
      );
    }
    const login = assertExactGitHubLogin(
      user.login,
      'Authenticated GitHub login'
    );
    const current = session.getProfile();
    const sameGitHubIdentity =
      current?.githubUserId === user.id;
    session.setProfile({
      username: ctx.userKey,
      login,
      githubUserId: user.id,
      displayName: sameGitHubIdentity ? current.displayName : '',
      title: sameGitHubIdentity ? current.title : '',
      orcid: sameGitHubIdentity ? current.orcid : '',
      linkedin: sameGitHubIdentity ? current.linkedin : '',
    });
  }

  async function prepareConnectedContext(
    owner,
    {
      resolveRole = true,
      retryRoleIfBusy = false,
    } = {},
  ) {
    if (
      typeof resolveRole !== 'boolean' ||
      typeof retryRoleIfBusy !== 'boolean'
    ) {
      throw new TypeError(
        'Connected annotation context options must be boolean'
      );
    }
    if (!owner.repoRef || owner.simulated) return false;
    try {
      await fileCache.init();
      if (!isContextOwnerCurrent(owner)) return false;

      const desc = describeCacheScope({
        datasetId: owner.datasetId,
        repoRef: owner.repoRef,
        userId: owner.userId,
      });
      if (!desc) {
        throw new Error('Connected annotation cache scope is incomplete');
      }
      const sessionKey = toSessionStorageKey({
        datasetId: owner.datasetId,
        repoRef: owner.repoRef,
        userId: owner.userId,
      });
      if (sessionKey === null) {
        throw new Error('Connected annotation cache scope has no session key');
      }
      if (typeof localStorage === 'undefined') {
        throw new Error('localStorage is required for annotation cache status');
      }
      const raw = localStorage.getItem(sessionKey);
      const sessionStatus = raw === null ? 'empty' : 'found';
      const shas = fileCache.getKnownShas({
        datasetId: owner.datasetId,
        repoRef: owner.repoRef,
        userId: owner.userId,
      });
      if (!isContextOwnerCurrent(owner)) return false;

      const notificationScope =
        `${owner.generation}:${owner.identity}`;
      if (notificationScope !== lastNotifiedCacheScope) {
        lastNotifiedCacheScope = notificationScope;
        const rawFileCount = Object.keys(shas).length;
        const who = getGitHubLogin();
        const whoLabel = who ? `@${who}` : 'local';
        const message = [
          'Annotation repo connected (local cache scope)',
          `datasetId: ${desc.datasetId}`,
          `repo: ${desc.repo}`,
          `branch: ${desc.branch}`,
          `user: ${whoLabel}`,
          `local cache: session=${sessionStatus} • raw-files=` +
            `${rawFileCount} path(s)`
        ].join('\n');
        notifications.success(message, {
          category: 'annotation',
          duration: 8000,
        });
      }
    } catch (error) {
      if (!isContextOwnerCurrent(owner)) return false;
      const message =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Community annotation raw-file cache initialization failed';
      disconnectAnnotationRepo({
        datasetId: owner.datasetId,
        userKey: owner.userKey,
        message:
          `${message}\nDisconnected annotation repo to protect the local cache scope.`,
        notify: 'error',
        preserveSession: true,
      });
      return false;
    }

    if (!isContextOwnerCurrent(owner)) return false;
    if (resolveRole) {
      scheduleResolveConnectedRole(owner, { retryIfBusy: retryRoleIfBusy });
    }
    return true;
  }

  function applySessionCacheContext({
    datasetId = undefined,
    resolveRole = true,
    retryRoleIfBusy = false,
  } = {}) {
    if (
      typeof resolveRole !== 'boolean' ||
      typeof retryRoleIfBusy !== 'boolean'
    ) {
      throw new TypeError(
        'Annotation cache context options must be boolean'
      );
    }
    const ctx = syncCommunityAnnotationCacheContext({
      dataSourceManager,
      datasetId,
    });
    adoptAuthenticatedIdentity(ctx);
    const owner = publishContextOwner(ctx);

    // Prevent stale role/perms from a different dataset/repo/user context.
    const nextRoleContext =
      `${ctx.datasetId ?? ''}::${ctx.userKey}::${ctx.repoRef ?? ''}`;
    if (nextRoleContext !== lastRoleContext) {
      lastRoleContext = nextRoleContext;
      lastRepoInfo = null;
      access.clearRole?.();
    }

    if (ctx.repoRef && !ctx.simulated) {
      observeBackgroundTask(
        prepareConnectedContext(owner, {
          resolveRole,
          retryRoleIfBusy,
        }),
        {
          label: 'Unable to prepare the connected annotation context',
          owner,
        },
      );
    }
    refreshAutoPullScheduler();
    return owner;
  }

  function scheduleResolveConnectedRole(
    owner,
    { retryIfBusy = false } = {},
  ) {
    if (typeof retryIfBusy !== 'boolean') {
      throw new TypeError(
        'Annotation role retry ownership must be boolean'
      );
    }
    if (!isContextOwnerCurrent(owner)) return;
    if (!owner.datasetId || !owner.repoRef) return;
    if (!githubAuth.isAuthenticated?.()) return;
    if (!isAnnotationRepoConnected(owner.datasetId, owner.userKey)) return;
    if (retryIfBusy) cancelScheduledRoleRetry(owner);
    if (access.getRole() !== 'unknown') {
      cancelScheduledRoleRetry(owner);
      return;
    }
    if (
      !retryIfBusy &&
      roleRetryState !== null &&
      isSameContextOwner(roleRetryState.owner, owner) &&
      roleRetryState.timer !== null
    ) {
      return;
    }
    if (
      activeRoleResolutionOwner !== null &&
      isSameContextOwner(activeRoleResolutionOwner, owner)
    ) {
      if (retryIfBusy) {
        pendingOnlineRoleRetryOwner = owner;
      }
      return;
    }
    if (typeof queueMicrotask !== 'function') {
      throw new Error('queueMicrotask is required for annotation role resolution');
    }
    activeRoleResolutionOwner = owner;
    // Defer so repository-map events cannot re-enter their own dispatch.
    queueMicrotask(() => {
      observeBackgroundTask(
        resolveConnectedRoleOrDisconnect(owner),
        {
          label: 'Unable to settle the connected annotation role',
          owner,
        },
      );
    });
  }

  async function resolveConnectedRoleOrDisconnect(owner) {
    const did = owner?.datasetId ?? null;
    const userId = owner?.userId ?? null;
    const userKey = owner?.userKey ?? 'local';
    const repo = owner?.repoRef ?? null;
    try {
      if (!isContextOwnerCurrent(owner)) return false;
      if (syncBusy) {
        queueRoleRetryAfterActiveSync(owner);
        return false;
      }
      if (
        !did ||
        !repo ||
        !userId ||
        userKey === 'local' ||
        owner.simulated
      ) {
        return false;
      }
      if (
        getAnnotationRepoForDataset(did, userKey) !== repo ||
        !isAnnotationRepoConnected(did, userKey)
      ) {
        return false;
      }
      if (access.getRole() !== 'unknown') return true;

      await githubAuth.ensureWorkerCompatible({ signal: owner.signal });
      if (!isContextOwnerCurrent(owner)) return false;
      const sync = getGitHubSyncForDataset({ datasetId: did, username: userKey });
      if (!sync) throw new Error('Unable to create GitHub sync session.');

      const meta = getAnnotationRepoMetaForDataset(did, userKey);
      const branchMode = requireAnnotationBranchMode(meta);

      const { repoInfo } = await sync.validateAndLoadConfig({
        datasetId: did,
        signal: owner.signal,
      });
      if (!isContextOwnerCurrent(owner)) return false;
      if (getAnnotationRepoForDataset(did, userKey) !== repo) return false;

      const parsed = parseOwnerRepo(repo);
      if (!parsed) {
        throw new Error('Stored annotation repository reference is invalid');
      }
      const repoLabel = parsed.ownerRepo;
      lastRepoInfo = repoInfo;
      access.setRoleFromRepoInfo(repoInfo);
      const finalRole = access.getRole();
      if (finalRole === 'unknown') {
        disconnectAnnotationRepo({
          datasetId: did,
          userKey,
          message:
            `Cannot determine your role for ${repoLabel}.\n` +
            'GitHub did not return repository permissions for your account. Disconnected annotation repo.',
          notify: 'error'
        });
        return false;
      }

      // Keep repoRef canonicalized to the resolved branch so cache keys remain stable.
      const branch = requireResolvedAnnotationBranch(sync);
      const canonicalRepoRef = `${repoLabel}@${branch}`;
      if (!isContextOwnerCurrent(owner)) return false;
      if (canonicalRepoRef !== repo) {
        lastRoleContext =
          `${did}::${userKey}::${canonicalRepoRef}`;
        setAnnotationRepoForDataset(
          did,
          canonicalRepoRef,
          userKey,
          { branchMode }
        );
        setUrlAnnotationRepo(canonicalRepoRef);
      } else {
        session.setCacheContext({
          datasetId: did,
          repoRef: canonicalRepoRef,
          userId,
        });
      }

      cancelScheduledRoleRetry(owner);
      if (
        isSameContextOwner(pendingSyncBusyRoleRetryOwner, owner)
      ) {
        pendingSyncBusyRoleRetryOwner = null;
      }
      return true;
    } catch (err) {
      if (!isContextOwnerCurrent(owner)) return false;
      const msg =
        err instanceof Error &&
        typeof err.message === 'string' &&
        err.message &&
        !/^\s|\s$/.test(err.message)
          ? err.message
          : 'Annotation role resolution failed with a non-Error value';
      const parsedRepo = parseOwnerRepo(repo);
      const repoLabel =
        parsedRepo === null
          ? 'the annotation repository'
          : parsedRepo.ownerRepo;
      if (isWorkerCompatibilityFailure(err)) {
        cancelScheduledRoleRetry(owner);
        access.clearRole();
        syncError =
          `${msg}\nThe repository connection was preserved. ` +
          'Deploy the matching Cellucid Worker, then retry GitHub sync.';
        notifications.error(syncError, {
          category: 'annotation',
          duration: 10_000,
        });
        render();
        return false;
      }
      if (isTransientRoleResolutionFailure(err)) {
        access.clearRole();
        const retry = scheduleTransientRoleRetry(owner, err);
        const retryDescription = retry.scheduled
          ? `Cellucid will retry in ${Math.max(
            0,
            Math.ceil(retry.delayMs / 1000)
          )}s (attempt ${retry.attempt}/${roleRetryDelaysMs.length}).`
          : (
            retry.exhausted
              ? 'Automatic retries are exhausted; reconnect or come online to retry immediately.'
              : 'Cellucid will retry when this context becomes available.'
          );
        syncError =
          `Unable to verify your role for ${repoLabel} while GitHub is ` +
          `unreachable.\n${msg}\nThe repository connection was preserved; ` +
          retryDescription;
        notifications.warning(syncError, {
          category: 'annotation',
          duration: 10_000,
        });
        render();
        return false;
      }
      cancelScheduledRoleRetry(owner);
      if (
        isSameContextOwner(pendingSyncBusyRoleRetryOwner, owner)
      ) {
        pendingSyncBusyRoleRetryOwner = null;
      }
      disconnectAnnotationRepo({
        datasetId: did,
        userKey,
        message: `Unable to determine your role for ${repoLabel}.\n${msg}\nDisconnected annotation repo.`,
        notify: 'error'
      });
      return false;
    } finally {
      const retryAfterSettlement =
        isSameContextOwner(pendingOnlineRoleRetryOwner, owner);
      if (retryAfterSettlement) {
        pendingOnlineRoleRetryOwner = null;
      }
      if (
        activeRoleResolutionOwner !== null &&
        isSameContextOwner(activeRoleResolutionOwner, owner)
      ) {
        activeRoleResolutionOwner = null;
      }
      if (
        retryAfterSettlement &&
        isContextOwnerCurrent(owner) &&
        access.getRole() === 'unknown'
      ) {
        if (syncBusy) queueRoleRetryAfterActiveSync(owner);
        else retryConnectedRoleImmediately(owner);
      }
    }
  }

  function disconnectAnnotationRepo({
    datasetId = null,
    userKey = null,
    message = null,
    notify = 'error',
    preserveSession = true
  } = {}) {
    if (typeof preserveSession !== 'boolean') {
      throw new Error('preserveSession must be boolean');
    }
    if (!['error', 'warning', 'success', 'none'].includes(notify)) {
      throw new Error('Annotation disconnect notification mode is invalid');
    }
    const did =
      datasetId === null
        ? dataSourceManager?.getCurrentDatasetId?.()
        : datasetId;
    const currentAuthKey = toGitHubUserKey(githubAuth.getUser());
    const key = userKey === null ? currentAuthKey : userKey;
    if (!did || !key) return false;
    if (currentAuthKey !== null && currentAuthKey !== key) {
      throw new Error(
        'Annotation disconnect user does not match the authenticated GitHub user'
      );
    }

    abortActiveSync(
      message === null ? 'Annotation repo disconnected.' : message
    );

    clearAnnotationRepoForDataset(did, key);
    setUrlAnnotationRepo(null);

    lastRepoInfo = null;
    access.clearRole();
    if (!preserveSession) {
      session.setCacheContext({
        datasetId: did,
        repoRef: null,
        userId: getCacheUserId(),
      });
    }
    lastNotifiedCacheScope = '';

    const msg = message === null ? '' : message;
    if (
      typeof msg !== 'string' ||
      (msg && /^\s|\s$/.test(msg))
    ) {
      throw new Error('Annotation disconnect message must be exact');
    }
    if (msg && notify !== 'none') {
      const fn = notify === 'success'
        ? notifications.success
        : (notify === 'warning' ? notifications.warning : notifications.error);
      fn.call(notifications, msg, { category: 'annotation', duration: notify === 'success' ? 2600 : 8000 });
    }

    syncError = msg || null;
    render();
    return true;
  }

  function disconnectGitHubAndAnnotationRepo({ datasetId = null, message = null, notify = 'error' } = {}) {
    disconnectAnnotationRepo({ datasetId, message: null });
    githubAuth.signOut();
    const msg = message === null ? 'GitHub disconnected.' : message;
    if (
      typeof msg !== 'string' ||
      !msg ||
      /^\s|\s$/.test(msg)
    ) {
      throw new Error('GitHub disconnect message must be exact');
    }
    const fn = notify === 'success'
      ? notifications.success
      : (notify === 'warning' ? notifications.warning : notifications.error);
    fn.call(notifications, msg, { category: 'annotation', duration: notify === 'success' ? 2600 : 8000 });

    syncError = msg;
    render();
    return true;
  }

  async function syncIdentityFromAuth({ promptIfMissing = false } = {}) {
    if (!githubAuth.isAuthenticated()) {
      throw new Error('GitHub authentication is required to synchronize identity');
    }
    const login = assertExactGitHubLogin(
      getGitHubLogin(),
      'Authenticated GitHub login'
    );
    const authUser = githubAuth.getUser();
    const key = toGitHubUserKey(authUser);
    const id = authUser.id;
    if (key === null) {
      throw new Error('Authenticated GitHub identity is missing');
    }
    await ensureIdentityForUserKey({ userKey: key, login, githubUserId: id, promptIfMissing });
    return true;
  }

  async function loadMyProfileFromGitHub(owner) {
    if (!isContextOwnerCurrent(owner)) return false;
    const did = owner.datasetId;
    const userId = owner.userId;
    const cacheUser = owner.userKey;
    const repo = owner.repoRef;
    if (
      !did ||
      !userId ||
      cacheUser === 'local' ||
      !repo ||
      !githubAuth.isAuthenticated?.()
    ) {
      return false;
    }
    let currentOwner = owner;
    try {
      await githubAuth.ensureWorkerCompatible({
        signal: currentOwner.signal,
      });
      if (!isContextOwnerCurrent(currentOwner)) return false;
      const sync = getGitHubSyncForDataset({
        datasetId: did,
        username: cacheUser,
      });
      if (!sync) return false;
      const meta = getAnnotationRepoMetaForDataset(did, cacheUser);
      const branchMode = requireAnnotationBranchMode(meta);
      const {
        repoInfo,
        datasetConfig,
        config,
        datasetId: didResolved,
      } = await sync.validateAndLoadConfig({
        datasetId: did,
        signal: currentOwner.signal,
      });
      if (!isContextOwnerCurrent(currentOwner)) return false;
      if (getAnnotationRepoForDataset(did, cacheUser) !== repo) return false;

      const parsed = parseOwnerRepo(repo);
      lastRepoInfo = repoInfo;
      access.setRoleFromRepoInfo(repoInfo);
      if (access.getRole() === 'unknown') {
        if (!parsed) {
          throw new Error('Stored annotation repository reference is invalid');
        }
        const repoLabel = parsed.ownerRepo;
        disconnectAnnotationRepo({
          datasetId: did,
          userKey: cacheUser,
          message:
            `Cannot determine your role for ${repoLabel}.\n` +
            'GitHub did not return repository permissions for your account. Disconnected annotation repo.',
          notify: 'error'
        });
        return false;
      }
      if (!parsed) {
        throw new Error('Stored annotation repository reference is invalid');
      }
      const repoLabel = parsed.ownerRepo;
      const isDatasetMismatch =
        didResolved &&
        Array.isArray(config?.supportedDatasets) &&
        config.supportedDatasets.length &&
        !datasetConfig;
      if (isDatasetMismatch && !access.isAuthor()) {
        disconnectAnnotationRepo({
          datasetId: did,
          userKey: cacheUser,
          message:
            `Dataset mismatch for ${repoLabel}.\n\n` +
            `This repo does not list the current dataset id "${didResolved}" in annotations/config.json.\n\n` +
            'Ask an author (maintain/admin) to Publish updated settings, then reconnect.',
          notify: 'error'
        });
        return false;
      }

      const ownerRepo = parsed.ownerRepo;
      const branch = requireResolvedAnnotationBranch(sync);
      const canonicalRepoRef = `${ownerRepo}@${branch}`;
      if (!isContextOwnerCurrent(currentOwner)) return false;
      if (canonicalRepoRef !== repo) {
        // Avoid wiping the role we just inferred when the repo-map dispatches
        // the connection-changed event (which calls applySessionCacheContext()).
        lastRoleContext =
          `${did}::${cacheUser}::${canonicalRepoRef}`;
        setAnnotationRepoForDataset(
          did,
          canonicalRepoRef,
          cacheUser,
          { branchMode }
        );
        setUrlAnnotationRepo(canonicalRepoRef);
        currentOwner = applySessionCacheContext({ datasetId: did });
      } else {
        session.setCacheContext({
          datasetId: did,
          repoRef: canonicalRepoRef,
          userId,
        });
      }
      const mine = await sync.pullUserFile({
        userKey: cacheUser,
        signal: currentOwner.signal,
      });
      if (!isContextOwnerCurrent(currentOwner)) return false;
      if (!mine?.doc) return false;
      session.mergeFromUserFiles([mine.doc], { preferLocalVotes: true });
      if (mine?.path && mine?.sha) session.setRemoteFileSha(mine.path, mine.sha);
      return true;
    } catch (error) {
      if (!isContextOwnerCurrent(currentOwner)) return false;
      const message = String(error?.message || 'Failed to load your annotation profile');
      syncError = message;
      const notify = isTransientRoleResolutionFailure(error)
        ? notifications.warning
        : notifications.error;
      notify.call(notifications, message, {
        category: 'annotation',
        duration: 10000,
      });
      return false;
    }
  }

  const editIdentityFlow = createIdentityProfileModal({
    session,
    githubAuth,
    showOwnedCommunityModal,
  });

  const applyConsensusColumn = createConsensusColumnApplier({
    state,
    session,
    notifications,
  });

  async function ensureIdentityForUserKey({ userKey, login, githubUserId = null, promptIfMissing = false } = {}) {
    const u = assertExactAnnotationUserKey(userKey, 'Identity user key');
    let l;
    if (u === 'local') {
      if (login !== 'local' || githubUserId !== null) {
        throw new Error(
          'Local identity requires login "local" and a null GitHub user id'
        );
      }
      l = login;
    } else {
      l = assertExactGitHubLogin(login, 'Identity GitHub login');
      if (
        !Number.isSafeInteger(githubUserId) ||
        githubUserId < 1 ||
        u !== `ghid_${githubUserId}`
      ) {
        throw new Error(
          'Identity GitHub user id must match the exact ghid user key'
        );
      }
    }
    const current = session.getProfile();
    const sameGitHubIdentity =
      Number.isSafeInteger(githubUserId) &&
      current?.githubUserId === githubUserId;
    session.setProfile({
      username: u,
      login: l,
      githubUserId,
      displayName: sameGitHubIdentity ? current.displayName : '',
      title: sameGitHubIdentity ? current.title : '',
      orcid: sameGitHubIdentity ? current.orcid : '',
      linkedin: sameGitHubIdentity ? current.linkedin : '',
    });
    if (promptIfMissing) {
      const after = session.getProfile();
      const hasAny = Boolean(after.displayName || after.title || after.orcid || after.linkedin);
      if (!hasAny) await editIdentityFlow({ suggestedUsername: l });
    }
    return true;
  }

  async function ensureIdentityForPush() {
    // Identity is authoritative from GitHub sign-in.
    return syncIdentityFromAuth({ promptIfMissing: true });
  }

  // The wizard and the panel must both be built before the first statement
  // that can reach render(): setDatasetContextFromManager() below renders
  // synchronously during initialization, and `render` is a binding rather than
  // a hoisted declaration. The wizard comes first because the panel opens it.
  const {
    openGitHubConnectionFlow,
    connectRepoFlow,
  } = createGitHubConnectionFlow({
    access,
    githubAuth,
    dataSourceManager,
    isSyncBusy: () => syncBusy,
    getSyncError: () => syncError,
    getLastRepoInfo: () => lastRepoInfo,
    setLastRepoInfo: (repoInfo) => {
      lastRepoInfo = repoInfo;
    },
    getLastAutoPullPreferenceError: () => lastAutoPullPreferenceError,
    setActiveConnectionClose: (close) => {
      activeGitHubConnectionClose = close;
    },
    releaseActiveConnectionClose: (close) => {
      if (activeGitHubConnectionClose === close) {
        activeGitHubConnectionClose = null;
      }
    },
    disconnectAnnotationRepo,
    disconnectGitHubAndAnnotationRepo,
    ensureIdentityForUserKey,
    getCacheContext,
    getCacheUserId,
    getCacheUserKey,
    getGitHubLogin,
    isContextOwnerCurrent,
    publishContextOwner,
    pullFromGitHub,
    pushToGitHub,
    refreshAutoPullScheduler,
    showOwnedCommunityModal,
    startBackgroundTask,
  });

  const { render } = createControlsPanel({
    container,
    state,
    dataSourceManager,
    infoPopovers,
    session,
    access,
    fileCache,
    notifications,
    githubAuth,
    annotatableSettingsDraft,
    annotatableSettingsDirty,
    isContextDestroyed: () => contextDestroyed,
    isSyncBusy: () => syncBusy,
    getSyncError: () => syncError,
    applyConsensusColumn,
    connectRepoFlow,
    editIdentityFlow,
    ensureIdentityForUserKey,
    getCacheContext,
    getCacheUserId,
    getCacheUserKey,
    getGitHubLogin,
    isContextOwnerCurrent,
    observeBackgroundTask,
    openGitHubConnectionFlow,
    publishContextOwner,
    startBackgroundTask,
  });

  const setDatasetContextFromManager = () => {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const owner = applySessionCacheContext({ datasetId });

    const paramRepo = getUrlAnnotationRepo();
    if (paramRepo && (githubAuth.isAuthenticated?.() || isSimulateRepoConnectedEnabled())) {
      const username = owner.userKey;
      const parsed = parseOwnerRepo(paramRepo);
      // Resolve a missing branch once before persisting the canonical reference.
      if (parsed && !parsed.ref) {
        const resolutionTask = (async () => {
          await githubAuth.ensureWorkerCompatible({
            signal: owner.signal,
          });
          if (!isContextOwnerCurrent(owner)) return;
          const resolved = await resolveAnnotationRepositoryFromUrlParam({
            urlParamValue: paramRepo,
            signal: owner.signal,
          });
          if (resolved === null) {
            throw new Error(
              'The annotation_repo URL parameter is not a canonical owner/repo reference'
            );
          }
          if (resolved === false) {
            throw new Error(
              'GitHub sign-in is required to resolve the annotation repository default branch'
            );
          }
          if (
            !isContextOwnerCurrent(owner) ||
            getUrlAnnotationRepo() !== paramRepo
          ) {
            return;
          }
          setAnnotationRepoForDataset(
            datasetId,
            resolved.repoRef,
            username,
            { branchMode: resolved.branchMode },
          );
          setUrlAnnotationRepo(resolved.repoRef);
          applySessionCacheContext({ datasetId });
          render();
        })().catch((error) => {
          if (
            !isContextOwnerCurrent(owner) ||
            getUrlAnnotationRepo() !== paramRepo
          ) {
            return;
          }
          throw error;
        });
        observeBackgroundTask(resolutionTask, {
          label: 'Unable to apply the annotation_repo URL parameter',
          owner,
        });
      } else {
        try {
          const ok = setDatasetAnnotationRepoFromUrlParam({
            datasetId,
            urlParamValue: paramRepo,
            username,
          });
          if (!ok) {
            throw new Error(
              'The annotation_repo URL parameter is not a canonical owner/repo@branch reference'
            );
          }
          applySessionCacheContext({ datasetId });
        } catch (error) {
          syncError = String(
            error?.message || 'Unable to apply annotation_repo URL parameter'
          );
          notifications.error(syncError, {
            category: 'annotation',
            duration: 10_000,
          });
        }
      }
    }
  };

  const handleDatasetChange = () => {
    if (contextDestroyed) return;
    setDatasetContextFromManager();
    render();
  };
  let datasetChangeSubscribed = false;
  setDatasetContextFromManager();
  if (typeof dataSourceManager?.onDatasetChange === 'function') {
    if (typeof dataSourceManager.offDatasetChange !== 'function') {
      throw new TypeError(
        'Community annotation controls require dataSourceManager.offDatasetChange()'
      );
    }
    dataSourceManager.onDatasetChange(handleDatasetChange);
    datasetChangeSubscribed = true;
  }

  const unsubscribe = session.on('changed', () => {
    render();
  });

  const unsubscribeSessionLockLost = session.on('lock:lost', (evt) => {
    const msg = toCleanString(evt?.message || '') || 'Lost cross-tab lock. Disconnected annotation repo.';
    abortActiveSync(msg);
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeSessionLockError = session.on('lock:error', (evt) => {
    const msg = toCleanString(evt?.message || '') || 'Unable to acquire cross-tab lock. Disconnected annotation repo.';
    abortActiveSync(msg);
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeSessionPersistenceError = session.on('persistence:error', (evt) => {
    const msg = toCleanString(evt?.message || '') || 'Local persistence failed. Disconnected annotation repo.';
    abortActiveSync(msg);
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeSessionIntegrityError = session.on('integrity:error', (evt) => {
    const msg = toCleanString(evt?.message || '') || 'Annotation data integrity error. Disconnected annotation repo.';
    abortActiveSync(msg);
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeAuth = githubAuth.on?.('changed', () => {
    authenticationGeneration += 1;
    syncError = null;
    if (!githubAuth.isAuthenticated?.()) {
      lastRepoInfo = null;
      access.clearRole?.();
      try {
        // Move to the local cache scope before publishing a local profile.
        // Session change listeners render synchronously and enforce that the
        // profile identity matches the active scope.
        applySessionCacheContext({});
        const current = session.getProfile();
        session.setProfile({
          ...current,
          username: 'local',
          login: '',
          githubUserId: null,
          displayName: '',
          title: '',
          orcid: '',
          linkedin: '',
        });
      } catch (error) {
        syncError =
          typeof error?.message === 'string' && error.message
            ? error.message
            : 'Unable to apply the signed-out annotation context';
        notifications.error(syncError, {
          category: 'annotation',
          duration: 10_000,
        });
      }
      render();
      return;
    }

    let owner;
    try {
      // Synchronize the exact authenticated cache identity before any async
      // repository work. A restored auth session does not emit "changed", so
      // startup uses this same path through applySessionCacheContext().
      owner = applySessionCacheContext({ resolveRole: false });
    } catch (error) {
      syncError =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Unable to apply the authenticated annotation context';
      notifications.error(syncError, {
        category: 'annotation',
        duration: 10_000,
      });
      render();
      return;
    }

    const authenticationTask = (async () => {
      if (!owner.repoRef || owner.simulated) return;
      // Profile/config reads share the raw-file cache scope. Do not begin
      // network work until IndexedDB is ready for that exact owner.
      await fileCache.init();
      if (!isContextOwnerCurrent(owner)) return;
      await loadMyProfileFromGitHub(owner);
    })()
      .finally(() => {
        if (isContextOwnerCurrent(owner)) render();
      });
    observeBackgroundTask(authenticationTask, {
      label: 'Unable to synchronize the authenticated GitHub identity',
      owner,
    });
  }) || null;
  const unsubscribeAccess = access.on?.('changed', () => render()) || null;

  function destroy() {
    contextDestroyed = true;
    stopAutoPullScheduler();
    cancelScheduledRoleRetry();
    publishedContextIdentity = null;
    if (publishedContextAbort !== null) {
      publishedContextAbort.abort();
      publishedContextAbort = null;
    }
    contextGeneration += 1;
    activeRoleResolutionOwner = null;
    pendingOnlineRoleRetryOwner = null;
    pendingSyncBusyRoleRetryOwner = null;
    clearAnnotatableSettingsDraft();
    if (activeSyncAbort !== null) {
      abortActiveSync('Community annotation controls were destroyed.');
    }
    runExactCleanup('Community annotation controls teardown', [
      ['active community annotation modal', closeOwnedCommunityModal],
      ['session change subscription', unsubscribe],
      ['session lock-lost subscription', unsubscribeSessionLockLost],
      ['session lock-error subscription', unsubscribeSessionLockError],
      ['session persistence-error subscription', unsubscribeSessionPersistenceError],
      ['session integrity-error subscription', unsubscribeSessionIntegrityError],
      ['authentication subscription', unsubscribeAuth],
      ['access subscription', unsubscribeAccess],
      [
        'dataset change subscription',
        datasetChangeSubscribed
          ? () => {
            dataSourceManager.offDatasetChange(handleDatasetChange);
            datasetChangeSubscribed = false;
          }
          : null,
      ],
      ['annotation connection listener', () => lifecycleAbort.abort()],
      ['information popover', () => infoPopovers.closeWithin(container)]
    ]);
  }

      async function pullFromGitHub({
        repoOverride = null,
        quiet = false,
        confirmDatasetMismatch = false,
        signal = null,
      } = {}) {
        if (syncBusy) return { ok: false, skipped: true };
        const entryOwner = publishContextOwner(getCacheContext({}));
        syncBusy = true;
        syncError = null;
        const opAbort = beginActiveSyncAbortScope();
        const releaseEntryOwnerSignal =
          bindActiveSyncOwnerSignal(opAbort, entryOwner.signal);
        const releaseCallerSignal =
          signal === null
            ? null
            : bindActiveSyncOwnerSignal(opAbort, signal);
        render();

        const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
        if (!datasetId) {
          syncBusy = false;
          syncError = 'Missing dataset context.';
          releaseCallerSignal?.();
          releaseEntryOwnerSignal();
          endActiveSyncAbortScope(opAbort);
          render();
          return { ok: false, error: syncError };
        }

      const prevRepoInfo = lastRepoInfo;
      const prevRole = access.getRole?.() || 'unknown';
      const prevRoleContext = lastRoleContext;

      const cacheUser = getCacheUserKey();
      const storedRepoRef = getAnnotationRepoForDataset(datasetId, cacheUser);
        const repoInput =
          repoOverride !== null ? repoOverride : storedRepoRef;
        if (!repoInput) {
          syncBusy = false;
        syncError = 'No annotation repo connected.';
        releaseCallerSignal?.();
        releaseEntryOwnerSignal();
        endActiveSyncAbortScope(opAbort);
        render();
        return { ok: false, error: syncError };
      }

      if (!githubAuth.isAuthenticated?.()) {
        syncBusy = false;
        syncError = 'Sign in required.';
        releaseCallerSignal?.();
        releaseEntryOwnerSignal();
        endActiveSyncAbortScope(opAbort);
        render();
        return { ok: false, error: syncError };
      }

    const trackerId = quiet ? null : notifications.progress(`Pulling annotations from ${repoInput}...`, 0, { category: 'annotation' });
    const updateProgress = (pct, opts) => {
      if (quiet || trackerId == null) return;
      notifications.updateProgress(trackerId, pct, opts);
    };
    const complete = (msg) => {
      if (quiet || trackerId == null) return;
      notifications.complete(trackerId, msg);
    };
    const fail = (msg) => {
      if (quiet || trackerId == null) return;
      notifications.fail(trackerId, msg);
    };

    /** @type {import('../../community-annotations/github-sync.js').CommunityAnnotationGitHubSync|null} */
    let sync = null;
    /** @type {'default'|'explicit'} */
    let branchMode = 'default';
    // If the user is attempting to connect/switch to a different repo (repoOverride),
    // do not destroy the existing stored connection on failure.
      let overrideForDifferentRepo =
        repoOverride !== null &&
        (storedRepoRef === null || repoOverride !== storedRepoRef);
      /** @type {string|null} */
      let canonicalRepoRef = null;
      /** @type {{datasetId:string,repoRef:string,userId:number}|null} */
      let resolvedCacheScope = null;
      let preserveExisting = Boolean(overrideForDifferentRepo && storedRepoRef);

        try {
        await githubAuth.ensureWorkerCompatible({
          signal: opAbort.signal,
        });
        throwIfActiveSyncAborted(opAbort);
        // Cache scoping requires the current authenticated GitHub identity.
          const userId = getCacheUserId();
        if (!userId) throw new Error('Missing GitHub numeric user id. Disconnect GitHub and sign in again.');
        const authUserKey = toGitHubUserKey(githubAuth.getUser?.());
        const authLogin = getGitHubLogin();
        if (!authUserKey || !authLogin) {
          throw new Error('GitHub identity is incomplete. Disconnect GitHub and sign in again.');
        }
        await ensureIdentityForUserKey({
          userKey: authUserKey,
          login: authLogin,
          githubUserId: userId,
          promptIfMissing: false,
        });
        throwIfActiveSyncAborted(opAbort);

      const parsed = parseOwnerRepo(repoInput);
      if (!parsed) throw new Error('Invalid annotation repo');

      // Branch mode:
      // - URL / connect repoOverride: infer from input (owner/repo@branch => explicit)
      // - Stored mapping: read meta (default vs explicit)
      const meta = getAnnotationRepoMetaForDataset(datasetId, cacheUser);
      const storedParsed = storedRepoRef ? parseOwnerRepo(storedRepoRef) : null;
      if (storedRepoRef !== null && storedParsed === null) {
        throw new Error('Stored annotation repository reference is invalid');
      }
        if (repoOverride !== null) {
          overrideForDifferentRepo =
            storedRepoRef === null || repoOverride !== storedRepoRef;
        }
        preserveExisting = Boolean(overrideForDifferentRepo && storedRepoRef);
      if (overrideForDifferentRepo) {
        branchMode = parsed.ref === null ? 'default' : 'explicit';
      } else {
        branchMode = requireAnnotationBranchMode(meta);
      }
      if (branchMode === 'explicit' && parsed.ref === null) {
        throw new Error(
          'Explicit annotation repository connection is missing its branch'
        );
      }

      const token = githubAuth.getToken?.() || null;
      if (!token) throw new Error('GitHub sign-in required');

      sync = new CommunityAnnotationGitHubSync({
        datasetId,
        owner: parsed.owner,
        repo: parsed.repo,
        token,
        branch: branchMode === 'explicit' ? parsed.ref : null,
        workerOrigin: githubAuth.getWorkerOrigin?.() || null
      });

      updateProgress(5, { message: `Validating repo: ${parsed.ownerRepo}...` });
      const {
        repoInfo,
        datasetConfig,
        config,
        configSha,
        datasetId: didResolved,
      } = await sync.validateAndLoadConfig({
        datasetId,
        signal: opAbort.signal,
      });
      throwIfActiveSyncAborted(opAbort);

          lastRepoInfo = repoInfo;
        access.setRoleFromRepoInfo(lastRepoInfo);
        if ((access.getRole?.() || 'unknown') === 'unknown') {
          const repoLabel = requireGitHubRepositoryFullName(repoInfo);
          const base =
            `Cannot determine your role for ${repoLabel}.\n` +
            'GitHub did not return repository permissions for your account.';
          if (preserveExisting) {
            // The user attempted to switch repos; keep the existing connection + role.
            lastRepoInfo = prevRepoInfo;
            access.setRole(prevRole);
            lastRoleContext = prevRoleContext;
            syncError = `${base}\nExisting repo connection preserved.`;
            notifications.error(syncError, { category: 'annotation', duration: 10000 });
            fail(base);
            return { ok: false, error: base, preservedExisting: true };
          }
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base}\nDisconnected annotation repo.`,
            notify: 'error'
          });
          fail(base);
          return { ok: false, error: base };
        }

      const isDatasetMismatch =
        didResolved &&
        Array.isArray(config?.supportedDatasets) &&
        config.supportedDatasets.length &&
        !datasetConfig;

      if (isDatasetMismatch) {
        const repoLabel = requireGitHubRepositoryFullName(repoInfo);
        const didLabel = didResolved || datasetId;

        if (!access.isAuthor()) {
          const base =
            `Dataset mismatch for ${repoLabel}.\n\n` +
            `This repo does not list the current dataset id "${didLabel}" in annotations/config.json.\n\n` +
            `Ask an author (maintain/admin) to connect and Publish updated settings, then start a new Pull.`;
          if (preserveExisting) {
            // The user attempted to switch repos; keep the existing connection + role.
            lastRepoInfo = prevRepoInfo;
            access.setRole(prevRole);
            lastRoleContext = prevRoleContext;
            syncError = `${base}\nExisting repo connection preserved.`;
            notifications.error(syncError, { category: 'annotation', duration: 10000 });
            fail(base);
            return { ok: false, error: base, blocked: true, preservedExisting: true };
          }
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: base,
            notify: 'error'
          });
          fail(base);
          return { ok: false, error: base, blocked: true };
        }

        const ok = await confirmAsync({
          title: 'Dataset mismatch (author)',
          message:
            `This repo does not list the current dataset id "${didLabel}" in annotations/config.json.\n\n` +
            `As an author, you can connect anyway to update settings.\n\n` +
            `After Pull:\n` +
            `- Select annotatable obs columns (and consensus thresholds) in the Manage panel\n` +
            `- Click Publish to write a new supportedDatasets entry for "${didLabel}" to annotations/config.json\n\n` +
            `Annotators are blocked until you publish.`,
          confirmText: 'Connect anyway',
          signal: opAbort.signal,
        });
        throwIfActiveSyncAborted(opAbort);
        if (!ok) {
          lastRepoInfo = prevRepoInfo;
          access.setRole(prevRole);
          lastRoleContext = prevRoleContext;
          syncError = 'Cancelled.';
          complete('Cancelled.');
          return { ok: false, cancelled: true };
        }
        if (!quiet) {
          notifications.warning(
            `Connected with a dataset mismatch for "${didLabel}".\nPublish annotatable settings ASAP to unblock annotators.`,
            { category: 'annotation', duration: 10000 }
          );
        }
      }

      // Repository field names are exact dataset field keys. Reject a
      // guaranteed mismatch before selecting the raw-cache scope or downloading
      // any user/moderation files.
      const configuredList = datasetConfig?.fieldsToAnnotate || [];
      const configSettingsRaw = datasetConfig?.annotatableSettings || {};
      const configClosedRaw = datasetConfig?.closedFields || [];
      const catFields = (state.getFields?.() || []).filter(
        (field) => field?.kind === 'category' && field?._isDeleted !== true
      );
      const allKeys = catFields.map((field) => field.key).filter(Boolean);
      const available = new Set(allKeys);
      const missingConfigured = configuredList.filter(
        (key) => !available.has(key)
      );
      if (missingConfigured.length) {
        throw new Error(
          'annotations/config.json references categorical field(s) absent from this dataset: ' +
          missingConfigured.join(', ')
        );
      }

      const ownerRepo = requireGitHubRepositoryFullName(repoInfo);
      const branch = requireResolvedAnnotationBranch(sync);
      canonicalRepoRef = `${ownerRepo}@${branch}`;

          // Ensure local cache key uses (datasetId, repo, branch, user) with the resolved branch.
          session.setCacheContext({ datasetId, repoRef: canonicalRepoRef, userId });
          await ensureIdentityForUserKey({
            userKey: authUserKey,
            login: authLogin,
            githubUserId: userId,
            promptIfMissing: false,
          });
          throwIfActiveSyncAborted(opAbort);

          resolvedCacheScope = {
            datasetId,
            repoRef: canonicalRepoRef,
            userId,
          };
          await fileCache.init();
          throwIfActiveSyncAborted(opAbort);

        // -------------------------------------------------------------------
        // 1) Pull + cache raw user + moderation files (download only changed via SHA)
        // -------------------------------------------------------------------
          const cacheScope = resolvedCacheScope;
          const knownUserShas = fileCache.getKnownShas(
            cacheScope,
            { prefixes: ['annotations/users/'] }
          );
          const knownMergeShas = fileCache.getKnownShas(
            cacheScope,
            { prefixes: ['annotations/moderation/'] }
          );
          updateProgress(15, { message: 'Checking `annotations/users/` (SHA)…' });
          const [pullResult, moderationResult] = await Promise.all([
            sync.pullAllUsers({
              knownShas: knownUserShas,
              signal: opAbort.signal,
            }),
            sync.pullModerationMerges({
              knownShas: knownMergeShas,
              signal: opAbort.signal,
            }),
          ]);
          throwIfActiveSyncAborted(opAbort);

        if (
          !pullResult ||
          typeof pullResult !== 'object' ||
          Array.isArray(pullResult) ||
          !Array.isArray(pullResult.docs) ||
          !pullResult.shas ||
          typeof pullResult.shas !== 'object' ||
          Array.isArray(pullResult.shas) ||
          !Number.isSafeInteger(pullResult.fetchedCount) ||
          !Number.isSafeInteger(pullResult.totalCount) ||
          !Number.isSafeInteger(pullResult.concurrency)
        ) {
          throw new Error('GitHub user pull returned an invalid result shape');
        }
        const fetchedUserRecords = pullResult.docs;
        const remoteUserShas = pullResult.shas;
        if (
          pullResult.fetchedCount !== fetchedUserRecords.length ||
          pullResult.totalCount !== Object.keys(remoteUserShas).length ||
          pullResult.concurrency < 1
        ) {
          throw new Error('GitHub user pull returned inconsistent counts');
        }

      const userPaths = Object.keys(remoteUserShas);
      const fetchedPaths = new Set();
      for (const record of fetchedUserRecords) {
        if (
          !record ||
          typeof record !== 'object' ||
          Array.isArray(record) ||
          Object.keys(record).sort().join(',') !== 'doc,path,sha' ||
          typeof record.path !== 'string' ||
          typeof record.sha !== 'string' ||
          !record.sha ||
          record.sha !== remoteUserShas[record.path] ||
          fetchedPaths.has(record.path)
        ) {
          throw new Error('GitHub user pull returned an invalid file record');
        }
        const filename = record.path.split('/').pop();
        assertUserDocument(record.doc, { path: record.path, filename });
        fetchedPaths.add(record.path);
      }
      for (const [path, sha] of Object.entries(remoteUserShas)) {
        if (
          !/^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(path) ||
          typeof sha !== 'string' ||
          !sha
        ) {
          throw new Error('GitHub user pull returned an invalid path/SHA map');
        }
      }
      if (
        !moderationResult ||
        typeof moderationResult !== 'object' ||
        Array.isArray(moderationResult) ||
        Object.keys(moderationResult).sort().join(',') !== 'doc,fetched,path,sha' ||
        moderationResult.path !== 'annotations/moderation/merges.json' ||
        typeof moderationResult.fetched !== 'boolean' ||
        (moderationResult.sha !== null &&
          (typeof moderationResult.sha !== 'string' || !moderationResult.sha)) ||
        (moderationResult.fetched
          ? (moderationResult.doc === null || moderationResult.sha === null)
          : moderationResult.doc !== null)
      ) {
        throw new Error('GitHub moderation pull returned an invalid result shape');
      }
      if (moderationResult.doc !== null) {
        assertMergesDocument(moderationResult.doc, {
          path: moderationResult.path,
        });
      }

      updateProgress(55, {
        message:
          `Downloaded ${pullResult.fetchedCount} changed user file(s) ` +
          `(cached ${pullResult.totalCount - pullResult.fetchedCount})`
      });

      // Every fetched record is already contract-validated by the GitHub boundary.
      // Moderation merges (author-maintained, optional).
      const keepPaths = new Set(userPaths);
      updateProgress(60, { message: 'Checking `annotations/moderation/` (SHA)…' });
      if (moderationResult.sha) {
        keepPaths.add(moderationResult.path);
      }
      const changedCacheRecords = fetchedUserRecords.map(record => ({
        path: record.path,
        sha: record.sha,
        json: record.doc,
      }));
      if (moderationResult.doc !== null) {
        changedCacheRecords.push({
          path: moderationResult.path,
          sha: moderationResult.sha,
          json: moderationResult.doc,
        });
      }
      await fileCache.setManyJson({
        datasetId,
        repoRef: canonicalRepoRef,
        userId,
        records: changedCacheRecords,
        signal: opAbort.signal,
      });
        throwIfActiveSyncAborted(opAbort);

        // Prune cached files that no longer exist remotely.
        await fileCache.pruneToPaths({ datasetId, repoRef: canonicalRepoRef, userId, keepPaths });
        throwIfActiveSyncAborted(opAbort);

      // -------------------------------------------------------------------
        // 2) Compile merged view from cached raw files (no cached compiled output)
        // -------------------------------------------------------------------
        updateProgress(75, { message: 'Compiling merged view from cached raw files…' });

        const cached = await fileCache.getAllJsonForRepo({
          datasetId,
          repoRef: canonicalRepoRef,
          userId,
          prefixes: ['annotations/users/', 'annotations/moderation/'],
        });
        throwIfActiveSyncAborted(opAbort);

      const allUserDocsForSession = userPaths.map((path) => {
        const entry = cached[path];
        if (!entry?.json) {
          const error = new Error(`Local cache is missing ${path}`);
          error.code = 'LOCAL_RAW_CACHE_CORRUPT';
          throw error;
        }
        if (entry.sha !== remoteUserShas[path]) {
          const error = new Error(`Local cache SHA does not match the remote SHA for ${path}`);
          error.code = 'LOCAL_RAW_CACHE_CORRUPT';
          throw error;
        }
        const filename = path.split('/').pop();
        assertUserDocument(entry.json, { path, filename });
        return entry.json;
      });

      // Resolve the exact cached moderation document before the session
      // transaction. Local author edits remain authoritative inside that
      // transaction until they are published.
      const mergesPath = 'annotations/moderation/merges.json';
      const remoteMergesKnown = keepPaths.has(mergesPath);
      const cachedMergeEntry = remoteMergesKnown ? cached[mergesPath] : null;

      if (remoteMergesKnown) {
        if (!cachedMergeEntry?.json) {
          const error = new Error(`Local cache is missing ${mergesPath}`);
          error.code = 'LOCAL_RAW_CACHE_CORRUPT';
          throw error;
        }
        if (cachedMergeEntry.sha !== moderationResult.sha) {
          const error = new Error(
            `Local cache SHA does not match the remote SHA for ${mergesPath}`
          );
          error.code = 'LOCAL_RAW_CACHE_CORRUPT';
          throw error;
        }
        assertMergesDocument(cachedMergeEntry.json, { path: mergesPath });
      }

      const pulledFileShas = { ...remoteUserShas };
      if (configSha) {
        pulledFileShas['annotations/config.json'] = configSha;
      }
      if (moderationResult?.sha) {
        pulledFileShas[
          moderationResult.path || 'annotations/moderation/merges.json'
        ] = moderationResult.sha;
      }

      // This synchronous call is the visible-session commit point. It publishes
      // moderation, the complete rebuilt view, settings/access metadata, and
      // remote SHAs through one notification or restores the prior session
      // without scheduling persistence.
      throwIfActiveSyncAborted(opAbort);
      session.applyPulledRepositoryState({
        remoteUserDocs: allUserDocsForSession,
        moderationDocument:
          remoteMergesKnown ? cachedMergeEntry.json : null,
        categoricalFieldKeys: allKeys,
        fieldsToAnnotate: configuredList,
        annotatableSettings: configSettingsRaw,
        closedFields: configClosedRaw,
        datasetId: didResolved || datasetId,
        remoteFileShas: pulledFileShas,
        signal: opAbort.signal,
      });

        updateProgress(100, { message: 'Pull complete' });

        // Commit the repo connection only after a successful Pull.
        if (canonicalRepoRef) {
          if (!repoOverride && storedRepoRef && storedRepoRef !== canonicalRepoRef) {
            const prev = parseOwnerRepo(storedRepoRef);
            const next = parseOwnerRepo(canonicalRepoRef);
          const bits = [];
          if (prev?.ownerRepo && next?.ownerRepo && prev.ownerRepo.toLowerCase() !== next.ownerRepo.toLowerCase()) {
            bits.push(`Repo moved: ${prev.ownerRepo} → ${next.ownerRepo}`);
          }
          if (prev?.ref && next?.ref && prev.ref !== next.ref && branchMode === 'default') {
            bits.push(`Default branch updated: ${prev.ref} → ${next.ref}`);
          }
          if (bits.length) {
            notifications.info(bits.join('\n'), { category: 'annotation', duration: 8000 });
          }
          }
          if (!storedRepoRef || storedRepoRef !== canonicalRepoRef) {
            // Avoid wiping the role we just inferred when the repo-map dispatches
            // the connection-changed event (which calls applySessionCacheContext()).
            lastRoleContext = `${datasetId}::${assertExactAnnotationUserKey(
              cacheUser,
              'Role cache user'
            )}::${canonicalRepoRef}`;
            commitExpectedActiveSyncRepoTransition(() => {
              setAnnotationRepoForDataset(
                datasetId,
                canonicalRepoRef,
                cacheUser,
                { branchMode }
              );
            });
          }
          setUrlAnnotationRepo(canonicalRepoRef);
        }

      complete('Pulled latest annotations');
      return { ok: true, repoRef: canonicalRepoRef };
      } catch (caughtError) {
          const err = normalizeActiveSyncError(caughtError, opAbort);
          const statusCode = httpStatusOrNull(err);
        const apiPath = gitHubApiPath(err) || workerPath(err);
        const msg = String(err?.message || 'Pull failed').trim() || 'Pull failed';

      const repoLabel = (() => {
        const p = parseOwnerRepo(repoInput);
        return p?.ownerRepo || String(repoInput || '').split('@')[0].trim() || 'repo';
      })();
        const branchLabel = toCleanString(sync?.branch || '') || null;
        const apiSuffix = apiPath ? ` (${apiPath})` : '';
          preserveExisting = Boolean(overrideForDifferentRepo && storedRepoRef);
          const workerCompatibilityFailure =
            isWorkerCompatibilityFailure(err);

        if (err?.code === 'ANNOTATION_SYNC_ABORTED') {
          syncError = msg;
          fail(msg);
          return { ok: false, error: msg, aborted: true };
        }

        if (
          err?.code === 'LOCAL_RAW_CACHE_CORRUPT' ||
          err?.code === 'LOCAL_RAW_CACHE_UNAVAILABLE'
        ) {
          let cacheRecoveryMessage = msg;
          let cacheRecoveryError = err;
          let cacheCleared = false;
          if (
            err?.code === 'LOCAL_RAW_CACHE_CORRUPT' &&
            resolvedCacheScope !== null
          ) {
            try {
              await fileCache.clearRepo(resolvedCacheScope);
              cacheCleared = true;
              cacheRecoveryMessage =
                `${msg}\n\nThe exact local raw-file cache was cleared. ` +
                'Reconnect and Pull again to download a clean copy.';
            } catch (clearError) {
              cacheRecoveryMessage =
                `${msg}\n\nCellucid could not fully clear the exact local ` +
                `raw-file cache: ${String(
                  clearError?.message || clearError
                )}. Clear local annotation data, then reconnect and Pull again.`;
              cacheRecoveryError = new AggregateError(
                [err, clearError],
                cacheRecoveryMessage,
                { cause: err }
              );
              cacheRecoveryError.code =
                'LOCAL_RAW_CACHE_RECOVERY_FAILED';
              cacheRecoveryError.clearError = clearError;
            }
          }
          let ownershipError = null;
          try {
            throwIfActiveSyncAborted(opAbort);
          } catch (error) {
            ownershipError = error;
          }
          if (
            ownershipError !== null ||
            !isContextOwnerCurrent(entryOwner)
          ) {
            const abortedMessage =
              ownershipError?.message ||
              'Annotation context changed while recovering the exact local raw-file cache.';
            syncError = abortedMessage;
            fail(abortedMessage);
            return {
              ok: false,
              error: abortedMessage,
              cause: ownershipError ?? cacheRecoveryError,
              aborted: true,
              corruptedCache: true,
              cacheCleared,
            };
          }
          if (preserveExisting) {
            if (cacheCleared) {
              cacheRecoveryMessage =
                `${msg}\n\nThe exact candidate repository cache was cleared. ` +
                'The existing repository connection was preserved; retry this ' +
                'repository switch to download a clean copy.';
            } else if (cacheRecoveryError !== err) {
              cacheRecoveryMessage =
                `${cacheRecoveryMessage}\n\nThe existing repository connection ` +
                'was preserved. Clear the candidate repository cache before ' +
                'retrying this switch.';
            } else {
              cacheRecoveryMessage =
                `${msg}\n\nThe existing repository connection was preserved. ` +
                'Retry this repository switch after local cache storage is available.';
            }
            lastRepoInfo = prevRepoInfo;
            lastRoleContext = prevRoleContext;
            access.setRole(prevRole);
            session.setCacheContext({
              datasetId,
              repoRef: storedRepoRef,
              userId: entryOwner.userId,
            });
            syncError = cacheRecoveryMessage;
            fail(cacheRecoveryMessage);
            return {
              ok: false,
              error: cacheRecoveryMessage,
              cause: cacheRecoveryError,
              corruptedCache: true,
              cacheCleared,
              preservedExisting: true,
            };
          }
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: cacheRecoveryMessage,
            notify: quiet ? 'error' : 'none',
            preserveSession: true
          });
          fail(cacheRecoveryMessage);
          return {
            ok: false,
            error: cacheRecoveryMessage,
            cause: cacheRecoveryError,
            corruptedCache: true,
            cacheCleared,
          };
        }

          if (workerCompatibilityFailure) {
            syncError =
              `${msg}\nThe repository connection was preserved. ` +
              'Deploy the matching Cellucid Worker, then retry GitHub sync.';
            notifications.error(syncError, {
              category: 'annotation',
              duration: 10_000,
            });
          } else if (isWorkerOriginSecurityError(err)) {
            disconnectGitHubAndAnnotationRepo({
            datasetId,
            message: err?.message || `Invalid GitHub worker origin.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isTokenAuthFailure(err)) {
        disconnectGitHubAndAnnotationRepo({
          datasetId,
          message: `GitHub session expired or was revoked. Signed out and disconnected. Please connect again.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isRateLimitError(err)) {
        syncError = `GitHub rate limit: ${msg}`;
        notifications.warning(syncError, { category: 'annotation', duration: 8000 });
      } else if (isNetworkFetchFailure(err)) {
        syncError = describeGitHubAuthReachabilityError(err);
        notifications.error(syncError, { category: 'annotation', duration: 10000 });
      } else if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        const base = `Repo ${repoLabel} redirected (HTTP ${statusCode}). It may have been moved or renamed.${apiSuffix}`;
        if (preserveExisting) {
          syncError = `${base}\nExisting repo connection preserved.`;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base} Disconnected annotation repo.`,
            notify: 'error'
          });
        }
      } else if (statusCode === 403) {
        const base = `Lost access to ${repoLabel}. GitHub returned 403 (forbidden).${apiSuffix}`;
        if (preserveExisting) {
          syncError = `${base}\nExisting repo connection preserved.`;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base} Disconnected annotation repo.`,
            notify: 'error'
          });
        }
      } else if (isRepoNotFoundOrNoAccess(err)) {
        const base = `Annotation repo not accessible (deleted/renamed or access removed): ${repoLabel}.${apiSuffix}`;
        if (preserveExisting) {
          syncError = `${base}\nExisting repo connection preserved.`;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base} Disconnected.`,
            notify: 'error'
          });
        }
      } else if (isAnnotationRepoStructureError(err)) {
        let missing = 'required template files';
        const p = String(gitHubApiPath(err) || '');
        if (/\/contents\/annotations\/users(?:\/|$)/i.test(p)) missing = '`annotations/users/`';
        if (/\/contents\/annotations\/schema\.json(?:\/|$)/i.test(p)) missing = '`annotations/schema.json`';
        if (/\/contents\/annotations\/config\.json(?:\/|$)/i.test(p)) missing = '`annotations/config.json`';
        const where = branchLabel ? ` on branch "${branchLabel}"` : '';
        const base = `Repo ${repoLabel} is missing ${missing}${where}.${apiSuffix}`;
        if (preserveExisting) {
          syncError = `${base}\nExisting repo connection preserved.`;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base} Disconnected annotation repo.`,
            notify: 'error'
          });
        }
        } else {
          syncError = msg;
          notifications.error(syncError, { category: 'annotation', duration: 8000 });
        }

        // Never leave a connected repo in an unknown role state.
        // If the pull failed before we could resolve permissions, disconnect.
          if (
            !preserveExisting &&
            !workerCompatibilityFailure &&
            (access.getRole?.() || 'unknown') === 'unknown'
          ) {
          const stillConnected = Boolean(getAnnotationRepoForDataset(datasetId, cacheUser));
          if (stillConnected) {
            disconnectAnnotationRepo({
              datasetId,
              userKey: cacheUser,
              message: `Unable to determine your role for ${repoLabel}.\n${syncError || msg}\nDisconnected annotation repo.`,
              notify: 'error'
            });
          }
        }

        if (preserveExisting) {
          // Failed attempt to switch repos: restore the previous connection UI state.
          lastRepoInfo = prevRepoInfo;
          lastRoleContext = prevRoleContext;
          access.setRole(prevRole);
          const userId = getCacheUserId();
          session.setCacheContext({ datasetId, repoRef: storedRepoRef, userId });
        }

          fail(syncError || msg);
          return { ok: false, error: syncError || msg };
          } finally {
            releaseCallerSignal?.();
            releaseEntryOwnerSignal();
            endActiveSyncAbortScope(opAbort);
            syncBusy = false;
            flushRoleRetryAfterActiveSync();
            render();
      }
    }

  async function pushToGitHub({ signal = null } = {}) {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    if (!datasetId) {
      syncError = 'Missing dataset context.';
      render();
      return;
    }
    const cacheUser = getCacheUserKey();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUser);
    if (!repo) {
      syncError = 'No annotation repo connected.';
      render();
      return;
    }

    if (!githubAuth.isAuthenticated?.()) {
      syncError = 'Sign in required.';
      render();
      return;
    }

    if (syncBusy) return;
    const entryOwner = publishContextOwner(getCacheContext({}));
    syncBusy = true;
    syncError = null;
    const opAbort = beginActiveSyncAbortScope();
    const releaseEntryOwnerSignal =
      bindActiveSyncOwnerSignal(opAbort, entryOwner.signal);
    const releaseCallerSignal =
      signal === null
        ? null
        : bindActiveSyncOwnerSignal(opAbort, signal);
    render();

    const trackerId = notifications.loading(`Publishing your annotations to ${repo}...`, { category: 'annotation' });
    const completedPublicationSteps = [];
    let activePublicationPath = null;

    try {
      await githubAuth.ensureWorkerCompatible({
        signal: opAbort.signal,
      });
      throwIfActiveSyncAborted(opAbort);
      const parsed = parseOwnerRepo(repo);
      if (!parsed) throw new Error('Invalid annotation repo');

      const meta = getAnnotationRepoMetaForDataset(datasetId, cacheUser);
      const branchMode = requireAnnotationBranchMode(meta);
      if (branchMode === 'explicit' && parsed.ref === null) {
        throw new Error(
          'Explicit annotation repository connection is missing its branch'
        );
      }

      const token = githubAuth.getToken?.() || null;
      if (!token) throw new Error('GitHub sign-in required');

      const sync = new CommunityAnnotationGitHubSync({
        datasetId,
        owner: parsed.owner,
        repo: parsed.repo,
        token,
        branch: branchMode === 'explicit' ? parsed.ref : null,
        workerOrigin: githubAuth.getWorkerOrigin?.() || null
      });

          // Ensure branch/config resolves early with auth.
          const { config, repoInfo } = await sync.validateAndLoadConfig({
            datasetId,
            signal: opAbort.signal,
          });
          throwIfActiveSyncAborted(opAbort);
          lastRepoInfo = repoInfo;
        access.setRoleFromRepoInfo(lastRepoInfo);
        if ((access.getRole?.() || 'unknown') === 'unknown') {
          const repoLabel = requireGitHubRepositoryFullName(repoInfo);
          const msg =
            `Cannot determine your role for ${repoLabel}.\n` +
            'GitHub did not return repository permissions for your account.';
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${msg}\nDisconnected annotation repo.`,
            notify: 'none'
          });
          notifications.fail(trackerId, msg);
          return;
        }

      const publishCapability = getPublishCapability(repoInfo);
      const publicationMode = publishCapability.publicationMode;
      {
        const repoLabel = requireGitHubRepositoryFullName(repoInfo);
        if (!publishCapability.canPublish || publicationMode === null) {
          const msg = describeCannotPublishMessage(repoLabel);
          notifications.fail(trackerId, msg);
          syncError = msg;
          return;
        }
      }
        const ownerRepo = requireGitHubRepositoryFullName(repoInfo);
        const branch = requireResolvedAnnotationBranch(sync);
        const canonicalRepoRef = `${ownerRepo}@${branch}`;

        const commitRepoRefIfChanged = () => {
          if (repo !== canonicalRepoRef) {
            const prev = parseOwnerRepo(repo);
            const next = parseOwnerRepo(canonicalRepoRef);
            const bits = [];
          if (prev?.ownerRepo && next?.ownerRepo && prev.ownerRepo.toLowerCase() !== next.ownerRepo.toLowerCase()) {
            bits.push(`Repo moved: ${prev.ownerRepo} → ${next.ownerRepo}`);
          }
          if (prev?.ref && next?.ref && prev.ref !== next.ref && branchMode === 'default') {
            bits.push(`Default branch updated: ${prev.ref} → ${next.ref}`);
          }
            if (bits.length) {
              notifications.info(bits.join('\n'), { category: 'annotation', duration: 8000 });
            }
            // Avoid wiping the role we just inferred when the repo-map dispatches
            // the connection-changed event (which calls applySessionCacheContext()).
            lastRoleContext = `${datasetId}::${assertExactAnnotationUserKey(
              cacheUser,
              'Role cache user'
            )}::${canonicalRepoRef}`;
            commitExpectedActiveSyncRepoTransition(() => {
              setAnnotationRepoForDataset(
                datasetId,
                canonicalRepoRef,
                cacheUser,
                { branchMode }
              );
            });
          }
          setUrlAnnotationRepo(canonicalRepoRef);
        };
      // Ensure local cache key uses (datasetId, repo, branch, user) with the resolved default branch.
        const userId = getCacheUserId();
        if (!userId) throw new Error('Missing GitHub numeric user id. Disconnect GitHub and sign in again.');
        throwIfActiveSyncAborted(opAbort);
        session.setCacheContext({ datasetId, repoRef: canonicalRepoRef, userId });
        throwIfActiveSyncAborted(opAbort);
        const okIdentity = await ensureIdentityForPush();
        throwIfActiveSyncAborted(opAbort);
        if (!okIdentity) {
          throw new Error('Unable to determine your GitHub username.');
        }

      const remoteShas = session.getRemoteFileShas();
      const doc = session.buildUserFileDocument({ githubUserId: userId });
      const userPath = `annotations/users/ghid_${doc.githubUserId}.json`;
      const expectedRemoteUserSha = remoteShas[userPath] ?? null;
      activePublicationPath = userPath;

      const persistUpstreamPublicationBaseline = (
        result,
        expectedPath,
        label,
      ) => {
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error(`${label} publication result must be an object`);
        }
        if (result.mode === 'fork-pull-request') return false;
        if (result.mode !== 'direct' && result.mode !== 'none') {
          throw new Error(
            `${label} publication result mode must equal direct, none, or fork-pull-request`
          );
        }
        if (result.path !== expectedPath) {
          throw new Error(
            `${label} publication result path must equal ${expectedPath}`
          );
        }
        if (
          typeof result.sha !== 'string' ||
          !/^[0-9a-f]{40}$/.test(result.sha)
        ) {
          throw new Error(
            `${label} publication result must contain a canonical GitHub SHA`
          );
        }
        session.setRemoteFileSha(expectedPath, result.sha);
        return true;
      };

      let authorPayload = null;
      if (access.isAuthor()) {
        const fieldsToAnnotate = session.getAnnotatedFields();
        const annotatableSettings = session.getAnnotatableConsensusSettingsMap();
        const closedFields = session.getClosedAnnotatableFields();
        const datasetName = dataSourceManager?.getCurrentMetadata?.()?.name;
        const { config: proposedConfigDocument } =
          buildUpdatedAnnotationConfig({
            currentConfig: config,
            datasetId,
            datasetName,
            fieldsToAnnotate,
            annotatableSettings,
            closedFields,
          });
        toAnnotationPublicationBytes(proposedConfigDocument, {
          path: 'annotations/config.json',
        });
        const mergesDoc = session.buildModerationMergesDocument();
        assertMergesDocument(mergesDoc, {
          path: '$ author merges publish payload',
        });
        toAnnotationPublicationBytes(mergesDoc, {
          path: 'annotations/moderation/merges.json',
        });
        authorPayload = {
          datasetName,
          fieldsToAnnotate,
          annotatableSettings,
          closedFields,
          mergesDoc,
        };
      }

      const publishAuthorExtras = async () => {
        const empty = () => ({
          changed: false,
          mode: 'none',
          prUrl: null,
          reused: false,
        });
        if (!authorPayload) return { config: empty(), merges: empty() };

        const expectedConfigSha = remoteShas['annotations/config.json'] ?? null;
        const expectedMergesSha =
          remoteShas['annotations/moderation/merges.json'] ?? null;

        const config = await sync.updateDatasetFieldsToAnnotate({
          datasetId,
          datasetName: authorPayload.datasetName,
          fieldsToAnnotate: authorPayload.fieldsToAnnotate,
          annotatableSettings: authorPayload.annotatableSettings,
          closedFields: authorPayload.closedFields,
          conflictIfRemoteShaNotEqual: expectedConfigSha,
          publicationMode,
          signal: opAbort.signal,
        });
        completedPublicationSteps.push({
          path: 'annotations/config.json',
          mode: config.mode,
        });
        persistUpstreamPublicationBaseline(
          config,
          'annotations/config.json',
          'Annotation config',
        );

        activePublicationPath = 'annotations/moderation/merges.json';
        const merges = await sync.pushModerationMerges({
          mergesDoc: authorPayload.mergesDoc,
          conflictIfRemoteShaNotEqual: expectedMergesSha,
          publicationMode,
          signal: opAbort.signal,
        });
        completedPublicationSteps.push({
          path: 'annotations/moderation/merges.json',
          mode: merges.mode,
        });
        persistUpstreamPublicationBaseline(
          merges,
          'annotations/moderation/merges.json',
          'Annotation merges',
        );

        return { config, merges };
      };

      const handlePublishResult = async (result) => {
        completedPublicationSteps.push({
          path: userPath,
          mode: result.mode,
        });
        activePublicationPath = authorPayload
          ? 'annotations/config.json'
          : null;
        throwIfActiveSyncAborted(opAbort);
        persistUpstreamPublicationBaseline(
          result,
          userPath,
          'Annotation user file',
        );
        const extras = await publishAuthorExtras();
        activePublicationPath = null;
        throwIfActiveSyncAborted(opAbort);
        session.markSyncedNow();

        const configPrLabel =
          extras.config.mode === 'fork-pull-request' && extras.config.changed
          ? `Config PR: ${extras.config.prUrl}`
          : null;
        const mergesPrLabel =
          extras.merges.mode === 'fork-pull-request' && extras.merges.changed
          ? `Merges PR: ${extras.merges.prUrl}`
          : null;

        if (result.mode === 'fork-pull-request') {
          const label = result.reused ? 'Updated Pull Request' : 'Opened Pull Request';
          const parts = [`${label}: ${result.prUrl}`];
          if (configPrLabel) parts.push(configPrLabel);
          else if (extras.config.mode === 'direct' && extras.config.changed) parts.push('updated annotatable columns');
          if (mergesPrLabel) parts.push(mergesPrLabel);
          else if (extras.merges.mode === 'direct' && extras.merges.changed) parts.push('published merges');
          notifications.complete(trackerId, parts.join(' • '));
          throwIfActiveSyncAborted(opAbort);
          commitRepoRefIfChanged();
          return;
        }

        const bits = ['Published your votes/suggestions'];
        if (configPrLabel) bits.push(configPrLabel);
        else if (extras.config.mode === 'direct' && extras.config.changed) bits.push('updated annotatable columns');
        if (mergesPrLabel) bits.push(mergesPrLabel);
        else if (extras.merges.mode === 'direct' && extras.merges.changed) bits.push('published merges');
        notifications.complete(trackerId, bits.join(' • '));
        throwIfActiveSyncAborted(opAbort);
        commitRepoRefIfChanged();
      };

        const result = await sync.pushMyUserFile({
          userDoc: doc,
          conflictIfRemoteShaNotEqual: expectedRemoteUserSha,
          publicationMode,
          signal: opAbort.signal,
        });
        await handlePublishResult(result);
        return;
    } catch (caughtError) {
      const err = normalizeActiveSyncError(caughtError, opAbort);
      const statusCode = httpStatusOrNull(err);
      const apiPath = gitHubApiPath(err) || workerPath(err);
      let msg = String(err?.message || 'Publish failed').trim() || 'Publish failed';
      const apiSuffix = apiPath ? ` (${apiPath})` : '';
      const workerCompatibilityFailure =
        isWorkerCompatibilityFailure(err);
      if (
        activePublicationPath !== null &&
        completedPublicationSteps.length > 0
      ) {
        const completedPaths = completedPublicationSteps
          .map(step => step.path)
          .join(', ');
        msg =
          'Publication was only partially completed. GitHub already accepted ' +
          `or confirmed unchanged: ${completedPaths}. The next step, ` +
          `${activePublicationPath}, did not complete.\n` +
          'Pull from the same annotation repository before publishing again. ' +
          'Completed exact bytes are detected as a no-op, so the retry will ' +
          `not duplicate them.\n${msg}`;
      }

      if (err?.operation?.outcome === 'unknown') {
        msg =
          `${msg}\n` +
          'GitHub may already have applied this change. Pull from the same ' +
          'annotation repository before publishing again; do not retry until ' +
          'that Pull completes.';
        syncError = msg;
        notifications.fail(trackerId, msg);
        return;
      }

      if (err?.code === 'ANNOTATION_SYNC_ABORTED') {
        syncError = msg;
        notifications.fail(trackerId, msg);
        return;
      }

      if (msg.toLowerCase().includes('cancelled')) {
        syncError = 'Cancelled.';
        notifications.complete(trackerId, 'Cancelled.');
        return;
      }

      const repoLabel = (() => {
        const p = parseOwnerRepo(repo);
        return p?.ownerRepo || String(repo || '').split('@')[0].trim() || 'repo';
      })();

      if (workerCompatibilityFailure) {
        msg =
          `${msg}\nThe repository connection was preserved. ` +
          'Deploy the matching Cellucid Worker, then retry GitHub sync.';
        syncError = msg;
      } else if (isWorkerOriginSecurityError(err)) {
        disconnectGitHubAndAnnotationRepo({
          datasetId,
          message: err?.message || `Invalid GitHub worker origin.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isTokenAuthFailure(err)) {
        disconnectGitHubAndAnnotationRepo({
          datasetId,
          message: `GitHub session expired or was revoked. Signed out and disconnected. Please connect again.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isRateLimitError(err)) {
        syncError = `GitHub rate limit: ${msg}`;
        notifications.warning(syncError, { category: 'annotation', duration: 8000 });
      } else if (isNetworkFetchFailure(err)) {
        syncError = describeGitHubAuthReachabilityError(err);
        notifications.error(syncError, { category: 'annotation', duration: 10000 });
      } else if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Repo ${repoLabel} redirected (HTTP ${statusCode}). It may have been moved or renamed. Disconnected annotation repo.${apiSuffix}`,
          notify: 'error'
        });
      } else if (statusCode === 403) {
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Lost access to ${repoLabel}. GitHub returned 403 (forbidden). Disconnected annotation repo.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isRepoNotFoundOrNoAccess(err)) {
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Annotation repo not accessible (deleted/renamed or access removed): ${repoLabel}. Disconnected.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isAnnotationRepoStructureError(err)) {
        let missing = 'required template files';
        const p = String(gitHubApiPath(err) || '');
        if (/\/contents\/annotations\/users(?:\/|$)/i.test(p)) missing = '`annotations/users/`';
        if (/\/contents\/annotations\/schema\.json(?:\/|$)/i.test(p)) missing = '`annotations/schema.json`';
        if (/\/contents\/annotations\/config\.json(?:\/|$)/i.test(p)) missing = '`annotations/config.json`';
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Repo ${repoLabel} is missing ${missing}. Disconnected annotation repo.${apiSuffix}`,
          notify: 'error'
        });
        } else {
          syncError = msg;
        }

        // Never leave a connected repo in an unknown role state.
        // If publish failed before permissions could be resolved, disconnect.
          if (
            !workerCompatibilityFailure &&
            (access.getRole?.() || 'unknown') === 'unknown'
          ) {
          const stillConnected = Boolean(getAnnotationRepoForDataset(datasetId, cacheUser));
          if (stillConnected) {
            const disconnectMsg = `Unable to determine your role for ${repoLabel}.\n${syncError || msg}\nDisconnected annotation repo.`;
            disconnectAnnotationRepo({
              datasetId,
              userKey: cacheUser,
              message: disconnectMsg,
              notify: 'none'
            });
            msg = disconnectMsg;
          }
        }

      notifications.fail(trackerId, msg);
    } finally {
      releaseCallerSignal?.();
      releaseEntryOwnerSignal();
      endActiveSyncAbortScope(opAbort);
      syncBusy = false;
      flushRoleRetryAfterActiveSync();
      render();
    }
  }

  render();

  return { render, destroy };
}
