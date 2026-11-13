/**
 * @fileoverview Community annotation (offline-first) sidebar section.
 *
 * - Local session (localStorage) for annotated fields, suggestions, votes
 * - GitHub App auth and repository sync as a UI wrapper around the sync module
 *
 * This module is the controller. It owns everything that must exist exactly
 * once per controls instance and that more than one screen reads: the cache
 * context and its ownership generation, role resolution (asked again on
 * coming online and with each Pull), the automatic-pull scheduler, background-task reporting, the single owned modal,
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
 * `github-error-classification.js`, `browser-integration.js`,
 * `published-baseline.js` (what the person has published, what is not
 * published yet, and a vote published alone), and `sync-stop.js` (how the
 * Pull or Publish under way is stopped: a cancellation is never said as a
 * failure).
 *
 * Three rules hold everywhere here:
 *
 * - **Names.** A field and its categories are keyed in the repository on the
 *   dataset's names (`community-annotations/field-names.js`); a local rename
 *   is a display name.
 * - **One tab.** Another tab annotating the same scope pauses annotation here
 *   (`runtime-context.js`: "Open in another tab — annotation paused here",
 *   Use here); it never fails the dataset controls or disconnects.
 * - **An agent's votes and suggestions** (`annotation.publish`) are published
 *   together as one commit and nothing else of the person's, asked once with
 *   where they go, never open a dialog, wait for a Pull under way, and say
 *   honestly what happened when stopped or the connection drops (a Pull
 *   follows an outcome GitHub may or may not have applied).
 *
 * @module ui/modules/community-annotation-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import { getCommunityAnnotationFileCache } from '../../community-annotations/file-cache.js';
import { describeCacheScope, toCacheScopeKey } from '../../community-annotations/cache-scope.js';
import { annotationCategories, annotationFieldKey, annotationKeyable } from '../../community-annotations/field-names.js';
import {
  clearPublishedBaseline,
  differingMerges,
  ownUserFilePath,
  pendingChangesOf,
  publishedBaseline,
  sameJson,
  setPublishedBaseline,
  withChanges,
} from './community-annotation/published-baseline.js';
import {
  ANNOTATION_PAUSED_HERE,
  annotationDatasetIdOf,
  annotationPauseOf,
  getCommunityAnnotationCacheContext,
  isHeldElsewhere,
  onAnnotationPauseChange,
  pauseAnnotationScopeHere,
  syncCommunityAnnotationCacheContext,
  useAnnotationScopeHere,
} from '../../community-annotations/runtime-context.js';
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
  foldCachedFiles,
  getGitHubSyncForDataset,
  parseOwnerRepo,
  resolveAnnotationRepositoryFromUrlParam,
  setDatasetAnnotationRepoFromUrlParam,
} from '../../community-annotations/github-sync.js';
import {
  assertMergesDocument,
  exactLabelForCompare,
  toAnnotationPublicationBytes,
} from '../../community-annotations/wire-contract.js';
import { assertAutoPullIntervalMs } from '../../community-annotations/auto-pull-preferences.js';
import { readAutoPullPreferences } from './community-annotation/auto-pull-storage.js';
import { toCleanString } from '../../../utils/clean-string.js';
import { countNoun, formatCountOf } from '../../../utils/format-units.js';
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
import { GITHUB_APP_INSTALL_URL, createGitHubConnectionFlow } from './community-annotation/github-connection-flow.js';
import { createControlsPanel } from './community-annotation/controls-panel.js';
import { describeGitHubAuthReachabilityError } from './community-annotation/browser-integration.js';
import {
  describeCannotPublishMessage,
  getPublishCapability,
  gitHubApiPath,
  httpStatusOrNull,
  isAnnotationContractError,
  isAnnotationRepoStructureError,
  isRateLimitError,
  isRepoNotFoundOrNoAccess,
  isTokenAuthFailure,
  isTransientRoleResolutionFailure,
  isWorkerCompatibilityFailure,
  isWorkerOriginSecurityError,
  isWorkerUnreachable,
  workerPath,
} from './community-annotation/github-error-classification.js';
import { PLACES } from '../place-names.js';
import { abortReason, cancel, cancelled, isCancellation, onAbort, throwIfAborted } from '../../../utils/abort.js';
import { bindSyncOwner, createSyncStop, isStoppedForFailure, stoppedSyncOutcome, syncFailureOf } from './community-annotation/sync-stop.js';
import { realmHosts } from '../../../formats/io/hosts.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { resolveCategory, resolveLoadedField } from '../../actions/targets/fields.js';
import { categoryLabel, listNames, quoteName } from '../../actions/targets/names.js';
import { RESULT_TEXT_CHARS } from '../../agent/bridge/relay-protocol.js';
import { createListenerSet } from '../../../utils/listener-set.js';

/**
 * @param {object} options
 * @param {{provide: (type: string, handler: Function) => () => void}|null} [options.actions] - the
 *   page's dispatcher, on which the voting dialog's reads and votes are provided as
 *   `annotation.suggestions` and `annotation.publish`; null (another instance than the page's own)
 *   provides nothing, as the page's dispatcher takes one implementation per action
 */
export function initCommunityAnnotationControls({
  state,
  dom,
  dataSourceManager,
  infoPopovers,
  actions = null,
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

  /**
   * A Pull's or Publish's outcome: `cancelled` when it was stopped (`kind`
   * and `words` of the cancellation: `sync-stop.js`), `failed` with the
   * error said.
   * @typedef {{status: 'done'|'skipped'|'cancelled'|'failed'|'unknown', error?: string, kind?: string, words?: string}} SyncOutcome
   */
  let syncBusy = false;
  const syncBusyListeners = createListenerSet('community annotation sync busy');
  let syncError = null;
  /** A link that acts on the sync error it was made for (`getSyncErrorLink`): fork on GitHub, install the app. */
  let syncErrorLink = null;

  function notifySyncBusyChange() {
    syncBusyListeners.notify();
  }

  /**
   * Observe every `syncBusy` transition, including ones started by the
   * automatic-pull scheduler while a dialog is open.
   *
   * @param {() => void} listener
   * @returns {() => void} unsubscribe
   */
  function subscribeSyncBusy(listener) {
    return syncBusyListeners.add(listener);
  }
  let lastRepoInfo = null;
  /**
   * An author's repository settings and merges as the last Pull or Publish
   * left them, for the scope `scopeKey`: what "not published" compares with
   * (`pendingChanges`). Kept for this page only.
   * @type {{scopeKey: string, config: object|null, merges: object[]}|null}
   */
  let authorBaseline = null;
  /** The Pull or Publish under way, stopped with why (`community-annotation/sync-stop.js`). */
  const syncStop = createSyncStop();

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
    // Not a cancellation: the Pull or Publish failed, and says why.
    syncStop.stop(new Error('Network connection was lost.'));
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
  /**
   * The Pull this session last applied: its cache scope, `annotations` tree
   * and SHAs (`key`), the context it ran in, and the files it left out. A
   * Pull that finds the same tree, while the session still holds those SHAs,
   * has nothing to fold again.
   */
  let lastAppliedPull = null;
  /** What the last exclusion report said, so an automatic Pull repeats none. */
  let lastReportedExclusions = null;

  /**
   * Open a community annotation modal this controls instance owns.
   *
   * `options.onClosed`, when given, runs after the owner has released the
   * modal, on every close path (Close, Escape, backdrop, replacement, context
   * teardown). It is how a flow learns its dialog is gone; watching the
   * document for the overlay to disappear would see every mutation in the
   * page while the dialog is open.
   */
  function showOwnedCommunityModal(options) {
    if (contextDestroyed) return null;
    const { onClosed: callerOnClosed = null, ...modalOptions } = options ?? {};
    if (callerOnClosed !== null && typeof callerOnClosed !== 'function') {
      throw new TypeError(
        'Owned community annotation modal close callback must be a function'
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
      ...modalOptions,
      onClosed: () => {
        settled = true;
        if (activeCommunityModalClose === ownedClose) {
          activeCommunityModalClose = null;
        }
        callerOnClosed?.();
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
    close();
  }

  function closeActiveGitHubConnectionModal() {
    const close = activeGitHubConnectionClose;
    if (close === null) return false;
    if (typeof close !== 'function') {
      throw new TypeError(
        'GitHub connection modal close handle must be a function or null'
      );
    }
    close();
    if (activeGitHubConnectionClose === close) {
      activeGitHubConnectionClose = null;
    }
    return true;
  }

  let suppressActiveSyncContextAbort = false;

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
      pendingOnlineRoleRetryOwner = null;
      pendingSyncBusyRoleRetryOwner = null;
      clearAnnotatableSettingsDraft();
      stopAutoPullScheduler();
      if (hadPublishedContext) {
        closeOwnedCommunityModal();
      }
      if (
        hadPublishedContext &&
        syncStop.running &&
        !suppressActiveSyncContextAbort
      ) {
        syncStop.stop(cancelled(
          'closed',
          'Annotation dataset, repository, or authenticated user changed.'
        ));
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
      !realmHosts.online() ||
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
      !realmHosts.online() ||
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

  function retryConnectedRoleImmediately(owner) {
    if (!isContextOwnerCurrent(owner)) return false;
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
    if (!isContextOwnerCurrent(owner)) return false;
    if (access.getRole() !== 'unknown') return false;
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
      // Connected: the panel says so in its status rows (no notice of its own).
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
    if (access.getRole() !== 'unknown') return;
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
        access.clearRole();
        syncError = `${msg}\nThe repository connection was preserved.`;
        notifications.error(syncError, {
          category: 'annotation',
          duration: 10_000,
        });
        render();
        return false;
      }
      if (isTransientRoleResolutionFailure(err)) {
        // Each request was already asked again as long as that could help
        // (`worker-request.js`: the transport's one retry policy, at the pace
        // the host named): the failure is said, not asked again on a timer of
        // its own. A Pull (the person's or an automatic one) reads the role
        // again, and so does this computer coming back online.
        access.clearRole();
        syncError =
          `Unable to verify your role for ${repoLabel} while GitHub is ` +
          `unreachable.\n${msg}\nThe repository connection was preserved; ` +
          'Cellucid asks again with the next Pull, and at once when this computer comes back online.';
        notifications.warning(syncError, {
          category: 'annotation',
          duration: 10_000,
        });
        render();
        return false;
      }
      if (
        isSameContextOwner(pendingSyncBusyRoleRetryOwner, owner)
      ) {
        pendingSyncBusyRoleRetryOwner = null;
      }
      if (isTokenAuthFailure(err)) {
        forgetRefusedSignIn();
        return false;
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
        ? annotationDatasetIdOf(dataSourceManager)
        : datasetId;
    const currentAuthKey = toGitHubUserKey(githubAuth.getUser());
    const key = userKey === null ? currentAuthKey : userKey;
    if (!did || !key) return false;
    if (currentAuthKey !== null && currentAuthKey !== key) {
      throw new Error(
        'Annotation disconnect user does not match the authenticated GitHub user'
      );
    }

    syncStop.stop(cancelled(
      'closed',
      message === null || message === '' ? 'Annotation repo disconnected.' : message
    ));

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

  /**
   * GitHub refused the sign-in (it expired or was revoked): forget it here
   * and say so. The repository stays connected (it comes back with the next
   * sign-in of the same GitHub user) and the person's unpublished work stays
   * in this browser.
   */
  function forgetRefusedSignIn() {
    const msg = 'Your GitHub sign-in expired or was revoked. Sign in again to Pull or Publish; your unpublished changes stay in this browser.';
    syncStop.stop(cancelled('closed', msg));
    githubAuth.forgetRefused();
    notifications.error(msg, { category: 'annotation', duration: 8000 });
    syncError = msg;
    render();
  }

  function disconnectGitHubAndAnnotationRepo({ datasetId = null, message = null, notify = 'error' } = {}) {
    disconnectAnnotationRepo({ datasetId, message: null });
    // Forgotten here at once; GitHub's revocation answers later. A sign-in
    // GitHub could not revoke is said, never left silent.
    void githubAuth.signOut().then(revoked => {
      if (revoked) return;
      notifications.warning(
        'Signed out of GitHub here, but GitHub could not revoke the sign-in now: it stops working when it expires, within 8 hours.',
        { category: 'annotation', duration: 8000 }
      );
    });
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
      session.mergeFromUserFiles([mine.doc], {
        preferLocalVotes: true,
        hydrateFromOwnFile: mine?.path && mine?.sha
          ? session.ownUserFileNeedsHydration({ [mine.path]: mine.sha })
          : true,
      });
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
    actions,
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

  /**
   * What of the person's own work is not published in the connected
   * repository (`published-baseline.js`), or null when not known (no Pull
   * since this browser's cache was cleared, not signed in, paused here).
   */
  function pendingChanges() {
    const ctx = getCacheContext({});
    if (!ctx.datasetId || !ctx.repoRef || !Number.isSafeInteger(ctx.userId)) return null;
    const scope = { datasetId: ctx.datasetId, repoRef: ctx.repoRef, userId: ctx.userId };
    let local;
    try {
      local = session.buildUserFileDocument({ githubUserId: ctx.userId });
    } catch {
      return null;
    }
    let settingsChanged = false;
    let mergesChanged = 0;
    if (access.isAuthor() && authorBaseline !== null && authorBaseline.scopeKey === toCacheScopeKey(scope)) {
      if (authorBaseline.config !== null) {
        try {
          const { config: proposed } = buildUpdatedAnnotationConfig({
            currentConfig: authorBaseline.config,
            datasetId: ctx.datasetId,
            datasetName: dataSourceManager?.getCurrentMetadata?.()?.name,
            fieldsToAnnotate: session.getAnnotatedFields(),
            annotatableSettings: session.getAnnotatableConsensusSettingsMap(),
            closedFields: session.getClosedAnnotatableFields(),
          });
          settingsChanged = !sameJson(proposed, authorBaseline.config);
        } catch {
          settingsChanged = false;
        }
      }
      mergesChanged = differingMerges(session.getModerationMerges?.() ?? [], authorBaseline.merges);
    }
    return pendingChangesOf({
      local,
      published: publishedBaseline(scope, session.getRemoteFileShas()),
      settingsChanged,
      mergesChanged,
    });
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
    subscribeSyncBusy,
    resolveConnectionTrigger: () => {
      const trigger = container.querySelector(
        '[data-community-annotation-action="github-connection"]'
      );
      return trigger instanceof HTMLButtonElement && !trigger.disabled
        ? trigger
        : null;
    },
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
    forgetRefusedSignIn,
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
    lifecycleSignal: lifecycleAbort.signal,
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
    getSyncErrorLink: () => (syncErrorLink !== null && syncErrorLink.syncError === syncError
      ? { label: syncErrorLink.label, url: syncErrorLink.url }
      : null),
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
    getAnnotationPause: () => annotationPauseOf({ dataSourceManager }),
    useAnnotationHere,
    pendingChanges,
    publishNow: () => startBackgroundTask(() => pushToGitHub(), { label: 'Unable to publish community annotations' }),
  });

  /**
   * The link's `annotations` repository and the dataset it was applied to: a
   * link names one dataset's repository, so the same repository is not
   * connected to another dataset shown later (the parameter leaves the
   * address); a repository the address names anew applies to the dataset
   * shown next.
   * @type {{repository: string, datasetId: string}|null}
   */
  let urlRepositoryApplied = null;
  /** A link's `annotations` that names no repository, said with the parameter's real name. */
  const LINK_REPOSITORY_REFUSED =
    'This link\'s "annotations" is not a repository: it is owner/repo or owner/repo@branch.';
  const linkedRepository = value => (parseOwnerRepo(value)?.ownerRepo ?? String(value)).toLowerCase();

  const setDatasetContextFromManager = () => {
    const datasetId = annotationDatasetIdOf(dataSourceManager) || null;
    const owner = applySessionCacheContext({ datasetId });

    let paramRepo = getUrlAnnotationRepo();
    if (paramRepo && datasetId !== null) {
      const repository = linkedRepository(paramRepo);
      if (urlRepositoryApplied !== null && urlRepositoryApplied.repository === repository && urlRepositoryApplied.datasetId !== datasetId) {
        setUrlAnnotationRepo(null);
        paramRepo = null;
      } else {
        urlRepositoryApplied = { repository, datasetId };
      }
    }
    // An annotation repository is bound to one dataset. While no dataset is
    // open — including while the startup dataset is still loading — there is
    // nothing to bind the URL's repository to; it is applied when a dataset
    // is published, which calls this again.
    if (
      paramRepo &&
      datasetId !== null &&
      (githubAuth.isAuthenticated?.() || isSimulateRepoConnectedEnabled())
    ) {
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
            throw new Error(LINK_REPOSITORY_REFUSED);
          }
          if (resolved === false) {
            throw new Error(
              'Sign in with GitHub to connect the repository this link names ("annotations"): its default branch is read from GitHub.'
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
          label: 'The repository this link names ("annotations") could not be connected',
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
            throw new Error(LINK_REPOSITORY_REFUSED);
          }
          applySessionCacheContext({ datasetId });
        } catch (error) {
          syncError = String(
            error?.message || 'The repository this link names ("annotations") could not be connected.'
          );
          notifications.error(syncError, {
            category: 'annotation',
            duration: 10_000,
          });
        }
      }
    }
  };

  // The dataset-change listener is shared by every dataset control
  // (`data-source-manager.js`): annotation never fails it. Its own failure is
  // said in the panel, and the dataset controls go on.
  const handleDatasetChange = () => {
    if (contextDestroyed) return;
    try {
      setDatasetContextFromManager();
    } catch (error) {
      syncError =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Unable to apply the community annotation context';
      notifications.error(syncError, { category: 'annotation', duration: 10_000 });
    }
    render();
  };
  let datasetChangeSubscribed = false;
  handleDatasetChange();
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

  // Another tab took the scope over (its Use here): annotation pauses here,
  // and the connection stays (it is shared by both tabs).
  const unsubscribeSessionLockLost = session.on('lock:lost', (evt) => {
    if (isHeldElsewhere(evt) && typeof evt?.scopeKey === 'string') {
      syncStop.stop(cancelled('closed', 'Annotation moved to another tab.'));
      pauseAnnotationScopeHere(evt.scopeKey);
      reconcileContext({});
      return;
    }
    const msg = toCleanString(evt?.message || '') || 'Lost cross-tab lock. Disconnected annotation repo.';
    syncStop.stop(cancelled('closed', msg));
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? annotationDatasetIdOf(dataSourceManager) ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeSessionLockError = session.on('lock:error', (evt) => {
    // Another tab holds the scope: `syncCommunityAnnotationCacheContext`
    // pauses annotation here; nothing is disconnected.
    if (isHeldElsewhere(evt)) return;
    const msg = toCleanString(evt?.message || '') || 'Unable to acquire cross-tab lock. Disconnected annotation repo.';
    syncStop.stop(cancelled('closed', msg));
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? annotationDatasetIdOf(dataSourceManager) ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeSessionPersistenceError = session.on('persistence:error', (evt) => {
    const msg = toCleanString(evt?.message || '') || 'Local persistence failed. Disconnected annotation repo.';
    syncStop.stop(cancelled('closed', msg));
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? annotationDatasetIdOf(dataSourceManager) ?? null,
      userKey: getCacheUserKey(),
      message: msg,
      notify: 'error',
      preserveSession: true
    });
  }) || null;

  const unsubscribeSessionIntegrityError = session.on('integrity:error', (evt) => {
    const msg = toCleanString(evt?.message || '') || 'Annotation data integrity error. Disconnected annotation repo.';
    syncStop.stop(cancelled('closed', msg));
    disconnectAnnotationRepo({
      datasetId: evt?.datasetId ?? annotationDatasetIdOf(dataSourceManager) ?? null,
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
  const unsubscribePause = onAnnotationPauseChange(() => render());

  /** The person's Use here, in a tab where annotation is paused: take it over from the other tab. */
  function useAnnotationHere() {
    try {
      useAnnotationScopeHere({ dataSourceManager });
      reconcileContext({});
    } catch (error) {
      syncError =
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Annotation could not be taken over from the other tab';
      render();
    }
  }

  function destroy() {
    contextDestroyed = true;
    syncBusyListeners.clear();
    stopAutoPullScheduler();
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
    syncStop.stop(cancelled('closed', 'Community annotation controls were destroyed.'));
    runExactCleanup('Community annotation controls teardown', [
      ['active community annotation modal', closeOwnedCommunityModal],
      ['session change subscription', unsubscribe],
      ['session lock-lost subscription', unsubscribeSessionLockLost],
      ['session lock-error subscription', unsubscribeSessionLockError],
      ['session persistence-error subscription', unsubscribeSessionPersistenceError],
      ['session integrity-error subscription', unsubscribeSessionIntegrityError],
      ['authentication subscription', unsubscribeAuth],
      ['access subscription', unsubscribeAccess],
      ['annotation pause subscription', unsubscribePause],
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

  /**
   * Run one Pull or Publish transaction while it exclusively owns `syncBusy`.
   *
   * The flag, the abort scope, and the owner-signal bindings are all acquired
   * inside one try block and released in its finally, so no exception between
   * acquisition and the operation can leave the controls permanently busy.
   * Every caller receives an explicit outcome: `skipped` when another
   * transaction already owns the flag, otherwise whatever the operation
   * returns (`done`, `cancelled`, or `failed` with an exact error message).
   *
   * @param {AbortSignal|null} signal
   * @param {(scope: {entryOwner: object, opAbort: AbortController}) => Promise<SyncOutcome>} operation
   * @returns {Promise<SyncOutcome>}
   */
  async function runExclusiveSync(signal, operation) {
    if (syncBusy) return Object.freeze({ status: 'skipped' });
    if (annotationPauseOf({ dataSourceManager }) !== null) {
      return Object.freeze({ status: 'failed', error: ANNOTATION_PAUSED_HERE, paused: true });
    }
    let opAbort = null;
    let releaseEntryOwnerSignal = null;
    let releaseCallerSignal = null;
    try {
      syncBusy = true;
      syncError = null;
      const entryOwner = publishContextOwner(getCacheContext({}));
      opAbort = syncStop.begin();
      releaseEntryOwnerSignal =
        bindSyncOwner(opAbort, entryOwner.signal);
      releaseCallerSignal =
        signal === null
          ? null
          : bindSyncOwner(opAbort, signal);
      notifySyncBusyChange();
      render();
      return await operation({ entryOwner, opAbort });
    } finally {
      releaseCallerSignal?.();
      releaseEntryOwnerSignal?.();
      if (opAbort !== null) syncStop.end(opAbort);
      syncBusy = false;
      notifySyncBusyChange();
      flushRoleRetryAfterActiveSync();
      render();
    }
  }

  /**
   * @param {{repoOverride?: string|null, quiet?: boolean, confirmDatasetMismatch?: boolean, signal?: AbortSignal|null}} [options]
   * @returns {Promise<SyncOutcome>}
   */
  /**
   * Say what a Pull left out, once per change of it (a manual Pull says it
   * every time): one warning, the files and reasons under its Details. The
   * contributor's own file is named first and plainly: Publish will not
   * overwrite it.
   *
   * @param {{excluded: Array<{path: string, sha: string, reason: string}>,
   *   ignored: Array<{path: string, reason: string}>, ownPath: string, quiet: boolean}} report
   */
  function reportPullExclusions({ excluded, ignored, ownPath, quiet }) {
    const signature = JSON.stringify([
      excluded.map((entry) => [entry.path, entry.sha]),
      ignored.map((entry) => entry.path),
    ]);
    if (quiet && signature === lastReportedExclusions) return;
    lastReportedExclusions = signature;
    if (excluded.length === 0 && ignored.length === 0) return;
    const own = excluded.find((entry) => entry.path === ownPath) ?? null;
    const others = excluded.length - (own === null ? 0 : 1);
    const lines = [];
    if (own !== null) {
      lines.push(
        `Your published file ${ownPath} is not a valid annotation file and was left out. ` +
        'Publish will not overwrite it: fix or remove it on GitHub first.'
      );
    }
    if (others > 0) {
      lines.push(`${formatCountOf(others, 'contributor file')} ${others === 1 ? 'was' : 'were'} left out of the consensus: not valid annotation files.`);
    }
    if (ignored.length > 0) {
      lines.push(`${formatCountOf(ignored.length, 'path')} under annotations/ ${ignored.length === 1 ? 'is' : 'are'} not annotation files and ${ignored.length === 1 ? 'was' : 'were'} ignored.`);
    }
    notifications.warning(lines.join('\n'), {
      category: 'annotation',
      duration: 15_000,
      details: [...excluded, ...ignored].map((entry) => `${entry.path} — ${entry.reason}`).join('\n'),
    });
  }

  async function pullFromGitHub({ signal = null, ...options } = {}) {
    return runExclusiveSync(signal, (scope) => pullExclusive(options, scope));
  }

  async function pullExclusive(
    { repoOverride = null, quiet = false, confirmDatasetMismatch = false },
    { entryOwner, opAbort },
  ) {
    const datasetId = annotationDatasetIdOf(dataSourceManager) || null;
    if (!datasetId) {
      syncError = 'Missing dataset context.';
      return { status: 'failed', error: syncError };
    }

    const prevRepoInfo = lastRepoInfo;
    const prevRole = access.getRole?.() || 'unknown';
    const prevRoleContext = lastRoleContext;

    const cacheUser = getCacheUserKey();
    const storedRepoRef = getAnnotationRepoForDataset(datasetId, cacheUser);
    const repoInput =
      repoOverride !== null ? repoOverride : storedRepoRef;
    if (!repoInput) {
      syncError = 'No annotation repo connected.';
      return { status: 'failed', error: syncError };
    }

    if (!githubAuth.isAuthenticated?.()) {
      syncError = 'Sign in required.';
      return { status: 'failed', error: syncError };
    }

    // Cancel stops the Pull; what it read is kept, and the next Pull goes on from there.
    const trackerId = quiet ? null : notifications.progress(`Pulling annotations from ${repoInput}…`, 0, {
      category: 'annotation',
      onCancel: () => {
        cancel(opAbort, 'user', 'Pull canceled; what it read is kept for the next Pull.');
      },
    });
    const updateProgress = (pct, opts) => {
      if (quiet || trackerId == null) return;
      notifications.updateProgress(trackerId, pct, opts);
    };
    const complete = (msg) => {
      if (quiet || trackerId == null) return;
      notifications.complete(trackerId, msg, { announce: true });
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
        throwIfAborted(opAbort.signal);
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
        throwIfAborted(opAbort.signal);

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

      // A wait GitHub names (a rate limit's reset) is said in the progress
      // notification; its Cancel stops the Pull, and what was read is kept.
      let progressPct = 5;
      let progressMessage = `Checking the repository ${parsed.ownerRepo}…`;
      const setProgress = (pct, message) => {
        progressPct = pct;
        progressMessage = message;
        updateProgress(pct, { message });
      };
      sync = new CommunityAnnotationGitHubSync({
        datasetId,
        owner: parsed.owner,
        repo: parsed.repo,
        token,
        branch: branchMode === 'explicit' ? parsed.ref : null,
        workerOrigin: githubAuth.getWorkerOrigin?.() || null,
        onWait: (wait) => updateProgress(progressPct, { message: wait === null ? progressMessage : wait.text }),
      });

      setProgress(5, progressMessage);
      const {
        repoInfo,
        datasetConfig,
        config,
        configSha,
        datasetId: didResolved,
        snapshot,
      } = await sync.validateAndLoadConfig({
        datasetId,
        signal: opAbort.signal,
      });
      throwIfAborted(opAbort.signal);

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
            return { status: 'failed', error: base, preservedExisting: true };
          }
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base}\nDisconnected annotation repo.`,
            notify: 'error'
          });
          fail(base);
          return { status: 'failed', error: base };
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
            return { status: 'failed', error: base, blocked: true, preservedExisting: true };
          }
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: base,
            notify: 'error'
          });
          fail(base);
          return { status: 'failed', error: base, blocked: true };
        }

        const ok = await confirmAsync({
          title: 'Dataset mismatch (author)',
          message:
            `This repo does not list the current dataset id "${didLabel}" in annotations/config.json.\n\n` +
            `As an author, you can connect anyway to update settings.\n\n` +
            `After Pull:\n` +
            `- Select annotatable obs columns (and consensus thresholds) under ${PLACES.annotatedColumns.name}\n` +
            `- Click Publish to write a new supportedDatasets entry for "${didLabel}" to annotations/config.json\n\n` +
            `Annotators are blocked until you publish.`,
          confirmText: 'Connect anyway',
          tone: 'primary',
          signal: opAbort.signal,
        });
        throwIfAborted(opAbort.signal);
        if (!ok) {
          lastRepoInfo = prevRepoInfo;
          access.setRole(prevRole);
          lastRoleContext = prevRoleContext;
          syncError = 'Canceled.';
          complete('Canceled.');
          return { status: 'cancelled' };
        }
        if (!quiet) {
          notifications.warning(
            `Connected with a dataset mismatch for "${didLabel}".\nPublish annotatable settings ASAP to unblock annotators.`,
            { category: 'annotation', duration: 10000 }
          );
        }
      }

      // Repository field names are exact dataset field keys. Reject a
      // guaranteed mismatch before selecting the file-cache scope or reading
      // any user/moderation files.
      const configuredList = datasetConfig?.fieldsToAnnotate || [];
      const configSettingsRaw = datasetConfig?.annotatableSettings || {};
      const configClosedRaw = datasetConfig?.closedFields || [];
      const catFields = (state.getFields?.() || []).filter(
        (field) => field?.kind === 'category' && field?._isDeleted !== true
      );
      // The repository names fields by the dataset's keys, never a local rename.
      const allKeys = catFields.map(annotationFieldKey).filter(Boolean);
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
          throwIfAborted(opAbort.signal);

          resolvedCacheScope = {
            datasetId,
            repoRef: canonicalRepoRef,
            userId,
          };
          await fileCache.init();
          throwIfAborted(opAbort.signal);

        // -------------------------------------------------------------------
        // 1) Read what changed since the last Pull into the file cache, by
        //    blob id. Each batch is kept as it arrives, so an interrupted
        //    Pull resumes where it stopped.
        // -------------------------------------------------------------------
        const cacheScope = resolvedCacheScope;
        const ownPath = `annotations/users/${authUserKey}.json`;
        setProgress(15, 'Reading what changed in `annotations/`…');
        const filesResult = await sync.pullFiles({
          snapshot,
          fileCache,
          cacheScope,
          ownUserKey: authUserKey,
          signal: opAbort.signal,
          onProgress: ({ done, total }) => {
            if (total === 0) return;
            setProgress(
              15 + Math.round((55 * done) / total),
              `Read ${done} of ${total} changed annotation file(s)…`
            );
          },
        });
        throwIfAborted(opAbort.signal);

        // The SHAs the session keeps: the files it publishes onto.
        const pulledFileShas = { 'annotations/config.json': configSha };
        if (filesResult.ownSha !== null) pulledFileShas[ownPath] = filesResult.ownSha;
        if (filesResult.mergesSha !== null) {
          pulledFileShas['annotations/moderation/merges.json'] = filesResult.mergesSha;
        }
        const appliedKey =
          `${toCacheScopeKey(cacheScope)}|${snapshot.annotationsOid}|${JSON.stringify(pulledFileShas)}`;
        let excluded;
        let pulledMerges;
        if (
          filesResult.unchanged &&
          lastAppliedPull !== null &&
          lastAppliedPull.key === appliedKey &&
          lastAppliedPull.identity === entryOwner.identity &&
          JSON.stringify(session.getRemoteFileShas()) === JSON.stringify(pulledFileShas)
        ) {
          // Nothing under annotations/ changed since the Pull this session
          // already shows: nothing to fold again.
          // The published view was kept when that Pull was folded.
          excluded = lastAppliedPull.excluded;
          pulledMerges = lastAppliedPull.merges;
        } else {
          // -----------------------------------------------------------------
          // 2) Fold the merged view from the cached files, one at a time. A
          //    file excluded when it was read, or refused when folded (an id
          //    another contributor owns), is left out on its own.
          // -----------------------------------------------------------------
          setProgress(75, 'Compiling merged view from cached files…');
          const remoteUserFiles = session.createRemoteUserFiles();
          const folded = await foldCachedFiles({ fileCache, cacheScope, remoteUserFiles });
          excluded = folded.excluded;
          const moderationDocument = folded.moderationDocument;
          throwIfAborted(opAbort.signal);

          // This synchronous call is the visible-session commit point. It
          // publishes moderation, the complete rebuilt view, settings/access
          // metadata, and the SHAs of the files the session publishes onto
          // through one notification, or restores the prior session without
          // scheduling persistence.
          session.applyPulledRepositoryState({
            remoteUserFiles,
            moderationDocument,
            categoricalFieldKeys: allKeys,
            fieldsToAnnotate: configuredList,
            annotatableSettings: configSettingsRaw,
            closedFields: configClosedRaw,
            datasetId: didResolved || datasetId,
            remoteFileShas: pulledFileShas,
            signal: opAbort.signal,
          });
          // The open dataset's merges as the repository holds them (none: no merges file).
          pulledMerges = moderationDocument?.merges ?? [];
          lastAppliedPull = { key: appliedKey, identity: entryOwner.identity, excluded, merges: pulledMerges };
          // What the person has published, as GitHub holds it now: what
          // "not published" compares with, and what a single vote is added
          // to. An own file the Pull left out is not known.
          if (excluded.some((entry) => entry.path === ownPath)) {
            clearPublishedBaseline(resolvedCacheScope);
          } else {
            setPublishedBaseline(resolvedCacheScope, {
              sha: filesResult.ownSha ?? null,
              view: remoteUserFiles.ownDoc,
            });
          }
        }
        reportPullExclusions({
          excluded,
          ignored: filesResult.ignored,
          ownPath,
          quiet,
        });

        authorBaseline = {
          scopeKey: toCacheScopeKey(resolvedCacheScope),
          config,
          merges: pulledMerges,
        };

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
      return {
        status: 'done',
        repoRef: canonicalRepoRef,
        excluded: lastAppliedPull?.excluded ?? [],
      };
      } catch (caughtError) {
          const err = syncFailureOf(caughtError, opAbort);
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

        if (isCancellation(err)) return stoppedSyncOutcome(err, notifications, trackerId);
        if (isStoppedForFailure(err, opAbort)) {
          // Stopped for a failure of its own (the connection lost): said as it.
          syncError = msg;
          fail(msg);
          return { status: 'failed', error: msg, aborted: true };
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
            throwIfAborted(opAbort.signal);
          } catch (error) {
            ownershipError = error;
          }
          if (isCancellation(ownershipError)) return stoppedSyncOutcome(ownershipError, notifications, trackerId);
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
              status: 'failed',
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
              status: 'failed',
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
            status: 'failed',
            error: cacheRecoveryMessage,
            cause: cacheRecoveryError,
            corruptedCache: true,
            cacheCleared,
          };
        }

          // Each branch that tells the person in its own sentence is that failure said
          // once: the Pull's card is then dismissed, not failed again.
          let said = false;
          if (workerCompatibilityFailure) {
            // The error says the remedy: redeploy an older Worker, or reload
            // Cellucid for a newer one.
            syncError = `${msg}\nThe repository connection was preserved.`;
            said = true;
            notifications.error(syncError, {
              category: 'annotation',
              duration: 10_000,
            });
          } else if (isWorkerOriginSecurityError(err)) {
            said = true;
            disconnectGitHubAndAnnotationRepo({
            datasetId,
            message: err?.message || `Invalid GitHub worker origin.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isTokenAuthFailure(err)) {
        said = true;
        forgetRefusedSignIn();
      } else if (isRateLimitError(err)) {
        syncError = `GitHub rate limit: ${msg}`;
        said = true;
        notifications.warning(syncError, { category: 'annotation', duration: 8000 });
      } else if (isWorkerUnreachable(err)) {
        syncError = describeGitHubAuthReachabilityError(err);
        said = true;
        notifications.error(syncError, { category: 'annotation', duration: 10000 });
      } else if (statusCode === 403) {
        const base = `Lost access to ${repoLabel}. GitHub returned 403 (forbidden).${apiSuffix}`;
        if (preserveExisting) {
          syncError = `${base}\nExisting repo connection preserved.`;
          said = true;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          said = true;
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
          said = true;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          said = true;
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base} Disconnected.`,
            notify: 'error'
          });
        }
      } else if (isAnnotationRepoStructureError(err)) {
        // The error names the path and the remedy.
        const where = branchLabel ? ` (branch "${branchLabel}")` : '';
        const base = `Repo ${repoLabel}${where}: ${msg}`;
        if (preserveExisting) {
          syncError = `${base}\nExisting repo connection preserved.`;
          said = true;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          said = true;
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${base} Disconnected annotation repo.`,
            notify: 'error'
          });
        }
        } else if (isAnnotationContractError(err)) {
          // A repository file its authors fix (annotations/config.json): the
          // connection stays.
          syncError = `Repo ${repoLabel}: ${msg}`;
          said = true;
          notifications.error(syncError, { category: 'annotation', duration: 10000 });
        } else {
          syncError = msg;
          said = true;
          notifications.error(syncError, { category: 'annotation', duration: 8000 });
        }

        // Never leave a connected repo in an unknown role state: a Pull that
        // failed before permissions were read disconnects, unless the failure
        // may pass (the Worker unreachable, a limit): then the role is asked
        // again later.
          if (
            !preserveExisting &&
            !workerCompatibilityFailure &&
            !isTransientRoleResolutionFailure(err) &&
            !isTokenAuthFailure(err) &&
            (access.getRole?.() || 'unknown') === 'unknown'
          ) {
          const stillConnected = Boolean(getAnnotationRepoForDataset(datasetId, cacheUser));
          if (stillConnected) {
            said = true;
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

          if (said) {
            if (!quiet && trackerId != null) notifications.dismiss(trackerId);
          } else {
            fail(syncError || msg);
          }
          return { status: 'failed', error: syncError || msg };
      }
    }

  /**
   * Publish the person's own work (the panel's Publish), or only some changes
   * (`only`: an agent's `annotation.publish`, one commit).
   *
   * - A Publish writes the person's file with every change of theirs not
   *   published, and for an author the repository settings and merges.
   * - Some changes are written on top of the person's file as published now
   *   (`only.compose(publishedView, {githubUserId, login})`, `withChanges`):
   *   the rest of their unpublished work stays in this browser, an author's
   *   settings and merges too, and changes that change nothing write nothing
   *   (`changed` false). `only.what` names them ("vote", "3 votes and 1
   *   suggestion").
   *
   * `interactive` false (an agent's call): never opens a dialog; the
   * profile's optional fields stay as they are and the GitHub login names
   * the file. An outcome GitHub may or may not have applied (`unknown`: a
   * Stop or a dropped connection while a write was under way) is followed by
   * a Pull, so what this browser knows of the person's file is GitHub's again.
   * A person's file changed on GitHub since the last Pull (another device or
   * tab published) is pulled (merged with what is here) and published again,
   * once; for the person's own Publish only while no author settings or
   * merges are staged (`publishExclusive`).
   *
   * @param {{signal?: AbortSignal|null, only?: {what: string, compose: (published: object|null, who: {githubUserId: number, login: string}) => object}|null, interactive?: boolean}} [options]
   * @returns {Promise<SyncOutcome & {mode?: string, prUrl?: string|null, changed?: boolean, pulled?: SyncOutcome}>}
   */
  async function pushToGitHub({ signal = null, only = null, interactive = true } = {}) {
    let outcome = await runExclusiveSync(signal, (scope) => publishExclusive(scope, { only, interactive }));
    if (outcome.status === 'failed' && outcome.conflict === true) {
      // The person's file changed on GitHub since the last Pull: Pull (it
      // merges that file with what is here), then publish again, once.
      await whenSyncIdle(signal);
      const pulled = await pullFromGitHub({ signal, quiet: !interactive });
      if (pulled.status === 'cancelled') return pulled;
      if (pulled.status !== 'done') return { status: 'failed', error: pulled.error ?? outcome.error, pulled };
      await whenSyncIdle(signal);
      outcome = await runExclusiveSync(signal, (scope) => publishExclusive(scope, { only, interactive }));
    }
    if (outcome.status !== 'unknown') return outcome;
    const pulled = await pullFromGitHub({ quiet: true });
    return { ...outcome, pulled };
  }

  /**
   * Wait until no Pull or Publish runs (an automatic Pull, the person's own),
   * then run `operation` exclusively: an agent's vote waits its turn rather
   * than being skipped.
   */
  async function whenSyncIdle(signal) {
    while (syncBusy) {
      await new Promise((resolve, reject) => {
        const unsubscribe = subscribeSyncBusy(() => {
          if (syncBusy) return;
          unsubscribe();
          removeAbort();
          resolve();
        });
        const removeAbort = onAbort(signal, () => {
          unsubscribe();
          reject(abortReason(signal));
        });
      });
    }
  }

  async function publishExclusive({ opAbort }, { only = null, interactive = true } = {}) {
    const datasetId = annotationDatasetIdOf(dataSourceManager) || null;
    if (!datasetId) {
      syncError = 'Missing dataset context.';
      return { status: 'failed', error: syncError };
    }
    const cacheUser = getCacheUserKey();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUser);
    if (!repo) {
      syncError = 'No annotation repo connected.';
      return { status: 'failed', error: syncError };
    }

    if (!githubAuth.isAuthenticated?.()) {
      syncError = 'Sign in required.';
      return { status: 'failed', error: syncError };
    }

    const trackerId = notifications.loading(`Publishing your annotations to ${repo}…`, { category: 'annotation' });
    const completedPublicationSteps = [];
    let activePublicationPath = null;

    try {
      await githubAuth.ensureWorkerCompatible({
        signal: opAbort.signal,
      });
      throwIfAborted(opAbort.signal);
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
      throwIfAborted(opAbort.signal);
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
        return { status: 'failed', error: syncError || msg };
      }

      const publishCapability = getPublishCapability(repoInfo);
      const publicationMode = publishCapability.publicationMode;
      {
        const repoLabel = requireGitHubRepositoryFullName(repoInfo);
        if (!publishCapability.canPublish || publicationMode === null) {
          const msg = describeCannotPublishMessage(repoLabel);
          notifications.fail(trackerId, msg);
          syncError = msg;
          return { status: 'failed', error: msg };
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
      throwIfAborted(opAbort.signal);
      session.setCacheContext({ datasetId, repoRef: canonicalRepoRef, userId });
      throwIfAborted(opAbort.signal);
      // An agent's call never opens a dialog: the profile's fields are optional.
      const okIdentity = interactive
        ? await ensureIdentityForPush()
        : await syncIdentityFromAuth({ promptIfMissing: false });
      throwIfAborted(opAbort.signal);
      if (!okIdentity) {
        throw new Error('Unable to determine your GitHub username.');
      }

      const remoteShas = session.getRemoteFileShas();
      const publishedScope = { datasetId, repoRef: canonicalRepoRef, userId };
      // One change alone: on top of the file as published, nothing else of the person's.
      const doc = only === null
        ? session.buildUserFileDocument({ githubUserId: userId })
        : published => only.compose(published, { githubUserId: userId, login: getGitHubLogin() });
      const userPath = ownUserFilePath(userId);
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
      if (only === null && access.isAuthor()) {
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
          configDocument: proposedConfigDocument,
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
        // GitHub has the file: what this browser knows of it is kept before
        // anything else, so a Stop now never reports a written file as not written.
        if (persistUpstreamPublicationBaseline(result, userPath, 'Annotation user file')) {
          setPublishedBaseline(publishedScope, { sha: result.sha, view: result.view });
        }
        // An author's settings and merges are a next step a Stop still prevents.
        if (authorPayload) throwIfAborted(opAbort.signal);
        const extras = await publishAuthorExtras();
        activePublicationPath = null;

        const configPrLabel =
          extras.config.mode === 'fork-pull-request' && extras.config.changed
            ? `Config PR: ${extras.config.prUrl}`
            : null;
        const mergesPrLabel =
          extras.merges.mode === 'fork-pull-request' && extras.merges.changed
            ? `Merges PR: ${extras.merges.prUrl}`
            : null;
        const parts = [];
        if (result.mode === 'fork-pull-request') {
          // Only a pull request: the repository has it once its authors merge it.
          const what = only === null ? 'changes' : only.what;
          parts.push(result.changed === false
            ? `The pull request already has your ${what}: ${result.prUrl}`
            : `${result.reused ? 'Updated the pull request' : 'Opened a pull request'} with your ${what}: ${result.prUrl}`);
        } else if (result.mode === 'none') {
          parts.push(only === null ? 'Your file on GitHub already holds these changes' : `Your ${only.what} was already published`);
        } else {
          parts.push(only === null ? 'Published your votes and suggestions' : `Published your ${only.what}`);
        }
        if (configPrLabel) parts.push(configPrLabel);
        else if (extras.config.mode === 'direct' && extras.config.changed) parts.push('updated annotatable columns');
        if (mergesPrLabel) parts.push(mergesPrLabel);
        else if (extras.merges.mode === 'direct' && extras.merges.changed) parts.push('published merges');
        notifications.complete(trackerId, parts.join(' • '), { announce: true });
        // Written: a Stop now changes nothing of it (the stored reference waits for the next run).
        if (!opAbort.signal.aborted) commitRepoRefIfChanged();
        if (
          authorPayload !== null
          && extras.config.mode !== 'fork-pull-request'
          && extras.merges.mode !== 'fork-pull-request'
        ) {
          authorBaseline = {
            scopeKey: toCacheScopeKey(publishedScope),
            config: authorPayload.configDocument,
            merges: authorPayload.mergesDoc.merges,
          };
        }
        return extras;
      };

      const result = await sync.pushMyUserFile({
        userDoc: doc,
        githubUserId: userId,
        conflictIfRemoteShaNotEqual: expectedRemoteUserSha,
        publicationMode,
        signal: opAbort.signal,
      });
      const extras = await handlePublishResult(result);
      return {
        status: 'done',
        mode: result.mode,
        prUrl: result.mode === 'fork-pull-request' ? result.prUrl : null,
        // Anything written: the person's file, or an author's settings or merges.
        changed: result.mode !== 'none' || extras.config.changed || extras.merges.changed,
      };
    } catch (caughtError) {
      const err = syncFailureOf(caughtError, opAbort);
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
        // Not known whether GitHub applied it: never said as not published.
        // `pushToGitHub` pulls next, so this browser knows again.
        msg =
          `${msg}\n` +
          'GitHub may already have applied this change; Cellucid pulls now to see.';
        syncError = msg;
        notifications.fail(trackerId, msg);
        return { status: 'unknown', error: msg };
      }

      // Stopped: what was already published is still said (`msg`).
      if (isCancellation(err)) return stoppedSyncOutcome(err, notifications, trackerId, msg);

      if (isStoppedForFailure(err, opAbort)) {
        // Stopped for a failure of its own (the connection lost): said as it.
        syncError = msg;
        notifications.fail(trackerId, msg);
        return { status: 'failed', error: msg };
      }

      const repoLabel = (() => {
        const p = parseOwnerRepo(repo);
        return p?.ownerRepo || String(repo || '').split('@')[0].trim() || 'repo';
      })();

      // A branch that tells the person in its own sentence (a notification of
      // its own) is that failure said once: the publication's card is then
      // dismissed, never failed again with the raw error beside it ("GitHub PUT …
      // failed with HTTP 401" beside "Your GitHub sign-in expired…").
      let said = false;
      if (workerCompatibilityFailure) {
        msg = `${msg}\nThe repository connection was preserved.`;
        syncError = msg;
      } else if (isWorkerOriginSecurityError(err)) {
        said = true;
        disconnectGitHubAndAnnotationRepo({
          datasetId,
          message: err?.message || `Invalid GitHub worker origin.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isTokenAuthFailure(err)) {
        said = true;
        forgetRefusedSignIn();
      } else if (isRateLimitError(err)) {
        said = true;
        syncError = `GitHub rate limit: ${msg}`;
        notifications.warning(syncError, { category: 'annotation', duration: 8000 });
      } else if (isWorkerUnreachable(err)) {
        said = true;
        syncError = describeGitHubAuthReachabilityError(err);
        notifications.error(syncError, { category: 'annotation', duration: 10000 });
      } else if (statusCode === 403) {
        said = true;
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Lost access to ${repoLabel}. GitHub returned 403 (forbidden). Disconnected annotation repo.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isRepoNotFoundOrNoAccess(err)) {
        said = true;
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Annotation repo not accessible (deleted/renamed or access removed): ${repoLabel}. Disconnected.${apiSuffix}`,
          notify: 'error'
        });
      } else if (isAnnotationRepoStructureError(err)) {
        said = true;
        disconnectAnnotationRepo({
          datasetId,
          userKey: cacheUser,
          message: `Repo ${repoLabel}: ${msg} Disconnected annotation repo.`,
          notify: 'error'
        });
      } else {
        syncError = msg;
        // The contributor's fork is missing, or the app cannot write to it: the place to fix it.
        if (err?.code === 'GITHUB_FORK_MISSING') {
          syncErrorLink = { syncError: msg, label: 'Fork on GitHub', url: err.forkUrl };
        } else if (err?.code === 'GITHUB_FORK_NOT_WRITABLE') {
          syncErrorLink = { syncError: msg, label: 'Install the app', url: GITHUB_APP_INSTALL_URL };
        }
      }

      // Never leave a connected repo in an unknown role state: a Publish
      // that failed before permissions were read disconnects, unless the
      // failure may pass. A sign-in GitHub refused keeps the repository: it
      // comes back with the next sign-in.
      if (
        !workerCompatibilityFailure &&
        !isTransientRoleResolutionFailure(err) &&
        !isTokenAuthFailure(err) &&
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

      // The person's own file changed on GitHub since the last Pull (another
      // device or tab published): a Pull merges it, then the same publication
      // is made again (`pushToGitHub`), so the card is not failed with "Pull
      // first". Not when an author's staged settings or
      // merges wait: a Pull would bring the repository's over them, so the
      // person is told to Pull themselves.
      const ownFileConflict = err?.code === 'COMMUNITY_ANNOTATION_CONFLICT'
        && completedPublicationSteps.length === 0
        && err?.path === ownUserFilePath(getCacheUserId());
      const staged = pendingChanges();
      const retry = ownFileConflict && (only !== null || staged === null || (staged.settings === 0 && staged.merges === 0));
      if (said || retry) notifications.dismiss(trackerId);
      else notifications.fail(trackerId, msg);
      return {
        status: 'failed',
        error: syncError || msg,
        ...(retry ? { conflict: true } : {}),
      };
    }
  }

  // ------------------------------------------------------------- as actions
  // `annotation.suggestions` reads what the voting dialog shows; `annotation.publish` is its ▲ ▼
  // and New suggestion, published together as one commit (`pushToGitHub` with `only`): the
  // person's file as published plus these changes, nothing else of theirs. Connecting the
  // repository and signing in stay the person's.
  // A field and its categories are named as the app shows them and keyed on the dataset's
  // names in the repository (`field-names.js`).

  /** The repository the dataset shown is annotated in, or a refusal saying what the person does first. */
  function connectedRepository(type) {
    if (annotationPauseOf({ dataSourceManager }) !== null) {
      throw new ActionRefused(
        'Community annotation of this dataset is open in another Cellucid tab, so this tab neither reads nor publishes it: '
        + 'the person chooses Use here in Community annotation first.',
        { code: 'unavailable', type },
      );
    }
    const datasetId = annotationDatasetIdOf(dataSourceManager) || null;
    const repo = datasetId === null ? null : getAnnotationRepoForDataset(datasetId, getCacheUserKey());
    if (!repo) {
      throw new ActionRefused(
        `Community annotation is not connected for the dataset shown: the person connects a GitHub repository in Community annotation first.`,
        { code: 'unavailable', type },
      );
    }
    return parseOwnerRepo(repo)?.ownerRepoRef ?? String(repo);
  }

  /**
   * A categorical column named as shown, with its keys in the repository:
   * `key` the dataset's field key, `categories` the dataset's labels (each at
   * its shown label's position), registered with the session as the voting
   * dialog registers them.
   */
  async function annotatedField(ref, signal) {
    const { field } = await resolveLoadedField(state, ref, { kind: 'category', signal });
    const key = annotationFieldKey(field);
    const categories = annotationCategories(field);
    if (!annotationKeyable(categories)) {
      throw new ActionRefused(
        `${quoteName(field.key)} cannot be annotated by the community: a category is blank, has spaces at its ends, or is named twice, and the repository keys categories by name.`,
        { code: 'refused' },
      );
    }
    session.setFieldCategories(key, categories);
    return { field, key, categories };
  }

  /** A suggestion as the voting dialog shows it: votes de-duplicated over a merged bundle, the person's vote, delegated or direct. */
  function suggestionFacts(fieldKey, category, suggestion) {
    const mine = session.getMyBundleVoteInfo(fieldKey, category, suggestion.id);
    const by = toCleanString(suggestion.proposedBy);
    return {
      id: suggestion.id,
      label: toCleanString(suggestion.label),
      by: by ? session.formatUserAttribution(by) : null,
      ontology_id: toCleanString(suggestion.ontologyId) || null,
      up: suggestion.upvotes.length,
      down: suggestion.downvotes.length,
      mine: mine.vote === 'up' || mine.vote === 'down' ? mine.vote : null,
      mine_delegated: mine.source === 'delegated',
    };
  }

  /** A category's consensus as the voting dialog and the legend show it, under the repository's settings for the field. */
  function consensusFacts(fieldKey, category) {
    const result = session.computeConsensus(fieldKey, category, session.getAnnotatableConsensusSettings(fieldKey) ?? {});
    return {
      status: result.status,
      label: result.label === null ? null : toCleanString(result.label) || null,
      voters: result.voters,
      confidence: result.confidence,
    };
  }

  /**
   * About half of what a tool result carries (`RESULT_TEXT_CHARS`): a page
   * of `annotation.suggestions` fills up to it, so every page arrives whole
   * however many categories and suggestions there are. Splits the work into
   * pages; never limits what can be read.
   */
  const SUGGESTIONS_PAGE_CHARS = Math.floor(RESULT_TEXT_CHARS / 2);

  /** The person's GitHub identity in the session, set from their sign-in when it is not yet (never a dialog). */
  async function requireIdentity(type) {
    const userId = getCacheUserId();
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new ActionRefused('The person is not signed in to GitHub in Community annotation, so nothing can be published: they sign in there first.', { code: 'unavailable', type });
    }
    if (session.getProfile()?.username !== `ghid_${userId}`) {
      await syncIdentityFromAuth({ promptIfMissing: false });
    }
    if (session.getProfile()?.username !== `ghid_${userId}`) {
      throw new ActionRefused('The person\'s GitHub identity is not set up in Community annotation yet: they open it there and Pull first.', { code: 'unavailable', type });
    }
    return userId;
  }

  /**
   * The suggestion `wanted` names (its id, else its label), or a refusal
   * naming the ones there are. Suggestions with one label (Unicode NFC,
   * nothing folded) are one suggestion of the category (the session bundles
   * them under the earliest), so a label names at most one.
   */
  function targetSuggestion(type, shownCategory, suggestions, wanted) {
    const byId = suggestions.find(entry => entry.id === wanted);
    if (byId !== undefined) return byId;
    const label = exactLabelForCompare(toCleanString(wanted));
    const byLabel = suggestions.find(entry => exactLabelForCompare(toCleanString(entry.label)) === label);
    if (byLabel !== undefined) return byLabel;
    throw new ActionRefused(
      `${quoteName(shownCategory)} has no suggestion ${quoteName(wanted)}; ${suggestions.length === 0 ? 'none is suggested yet' : `the suggestions are ${listNames(suggestions.map(entry => toCleanString(entry.label)))}`}.`,
      { code: 'no-target', type },
    );
  }

  /** Where a vote goes: the repository, or a pull request when the person cannot write to it. */
  function publicationRoute() {
    const capability = lastRepoInfo === null ? null : getPublishCapability(lastRepoInfo);
    return capability?.publicationMode === 'fork-pull-request' ? 'pull-request' : 'repository';
  }

  /**
   * Publish some changes alone (`only`), waiting for any Pull or Publish under
   * way (an automatic Pull) rather than being skipped; a file changed on
   * GitHub since the last Pull is pulled, then the changes are published on
   * it (`pushToGitHub`).
   */
  async function publishOne(only, signal) {
    for (;;) {
      await whenSyncIdle(signal);
      const outcome = await pushToGitHub({ signal, only, interactive: false });
      if (outcome.status !== 'skipped') return outcome;
    }
  }

  const unprovideActions = actions === null ? [] : [
    actions.provide('annotation.suggestions', async ({ field: ref, category, cursor, pull }, { signal }) => {
      const type = 'annotation.suggestions';
      const repository = connectedRepository(type);
      // Never pulled, the browser holds none of the others' suggestions: a
      // read of it would say "none suggested" of a repository full of them. It is
      // pulled first, as Pull latest does.
      if (pull === true || (pull === undefined && session.getLastPullAt() === null)) {
        await whenSyncIdle(signal);
        const pulled = await pullFromGitHub({ signal, quiet: true });
        throwIfAborted(signal);
        if (pulled.status === 'failed') {
          throw new ActionRefused(
            `Pulling ${repository} failed: ${pulled.error ?? 'GitHub did not answer'} Nothing was read; the person can try Pull latest in Community annotation › GitHub sync.`,
            { code: 'unavailable', type },
          );
        }
        if (pulled.status === 'cancelled') {
          // Stopped by the person or a change of context, not by this call.
          throw new ActionRefused(
            `Pulling ${repository} was stopped: ${pulled.words} Nothing was read.`,
            { code: 'unavailable', type },
          );
        }
      }
      const target = await annotatedField(ref, signal);
      const indices = category === undefined
        ? target.field.categories.map((_label, index) => index)
        : [resolveCategory(target.field, category)];
      const start = cursor ?? 0;
      if (start > indices.length) {
        throw new ActionRefused(`The field has ${formatCountOf(indices.length, 'category', 'categories')}; a page starts at ${indices.length} at most.`, { code: 'no-target', type });
      }
      const categories = [];
      let chars = 0;
      let next = null;
      for (let at = start; at < indices.length; at++) {
        const index = indices[at];
        const repositoryLabel = categoryLabel(target.categories[index]);
        const shown = categoryLabel(target.field.categories[index]);
        const entry = {
          category: shown,
          ...(shown === repositoryLabel ? {} : { repository_category: repositoryLabel }),
          consensus: consensusFacts(target.key, repositoryLabel),
          suggestions: session.getSuggestions(target.key, repositoryLabel).map(suggestion => suggestionFacts(target.key, repositoryLabel, suggestion)),
        };
        const size = JSON.stringify(entry).length;
        if (categories.length > 0 && chars + size > SUGGESTIONS_PAGE_CHARS) {
          next = at;
          break;
        }
        categories.push(entry);
        chars += size;
      }
      return {
        repository,
        pulled_at: session.getLastPullAt(),
        annotated: session.isFieldAnnotated(target.key),
        closed: session.isFieldClosed(target.key),
        consensus_rule: (() => {
          const rule = session.getAnnotatableConsensusSettings(target.key);
          return rule === null ? null : { voters_needed: rule.minAnnotators, threshold: rule.threshold };
        })(),
        ...(target.key === target.field.key ? {} : { repository_field: target.key }),
        categories,
        total_categories: indices.length,
        next,
      };
    }),
    actions.provide('annotation.publish', async ({ votes = [], suggestions = [] }, { signal, confirm }) => {
      const type = 'annotation.publish';
      const repository = connectedRepository(type);
      if (votes.length + suggestions.length === 0) {
        throw new ActionRefused('Nothing to publish: the call gives no votes and no suggestions.', { code: 'refused', type });
      }
      if (!githubAuth.isAuthenticated?.()) {
        throw new ActionRefused(`The person is not signed in to GitHub in Community annotation, so nothing can be published: they sign in there first.`, { code: 'unavailable', type });
      }
      // An automatic Pull under way finishes first: every change is checked against what it brings.
      await whenSyncIdle(signal);
      const userId = await requireIdentity(type);
      const scope = { datasetId: annotationDatasetIdOf(dataSourceManager), repoRef: getCacheContext({}).repoRef, userId };
      const published = publishedBaseline(scope, session.getRemoteFileShas());

      // Every change is checked before the person is asked: one refused, none is published.
      const problems = [];
      const refusedAt = (what, error) => {
        if (!(error instanceof ActionRefused)) throw error;
        problems.push({ what, error });
      };
      /** Each field named, resolved once: its target, or the refusal said once. */
      const fields = new Map();
      const fieldOf = async ref => {
        const key = `${ref.source}\u0000${ref.key}`;
        if (!fields.has(key)) {
          fields.set(key, (async () => {
            const target = await annotatedField(ref, signal);
            if (!session.isFieldAnnotated(target.key)) {
              throw new ActionRefused(`${quoteName(target.field.key)} is not open to community annotation in this repository.`, { code: 'unavailable', type });
            }
            if (session.isFieldClosed(target.key) && !access.isAuthor()) {
              throw new ActionRefused(`Voting and suggesting on ${quoteName(target.field.key)} are closed; only its repository's authors still take part.`, { code: 'unavailable', type });
            }
            return target;
          })().then(target => ({ target }), error => ({ error })));
        }
        const known = await fields.get(key);
        if ('error' in known) {
          if (!(known.error instanceof ActionRefused)) throw known.error;
          if (!known.told) {
            known.told = true;
            problems.push({ what: null, error: known.error });
          }
          return null;
        }
        return known.target;
      };
      /** Where a change goes: its field, the category as shown, and its name in the repository. */
      const placeOf = async (change, what) => {
        const target = await fieldOf(change.field);
        if (target === null) return null;
        try {
          const index = resolveCategory(target.field, change.category);
          return { target, shown: categoryLabel(target.field.categories[index]), label: categoryLabel(target.categories[index]) };
        } catch (error) {
          refusedAt(what, error);
          return null;
        }
      };

      const planned = { votes: [], suggestions: [] };
      for (const [at, change] of suggestions.entries()) {
        const what = `suggestion ${at + 1} (${quoteName(toCleanString(change.label))})`;
        const place = await placeOf(change, what);
        if (place === null) continue;
        const label = toCleanString(change.label);
        const compared = exactLabelForCompare(label);
        const existing = session.getSuggestions(place.target.key, place.label)
          .find(entry => exactLabelForCompare(toCleanString(entry.label)) === compared);
        if (existing !== undefined) {
          refusedAt(what, new ActionRefused(
            `${quoteName(place.shown)} already has the suggestion ${quoteName(label)} (id ${quoteName(existing.id)}); vote on it instead.`,
            { code: 'exists', type },
          ));
          continue;
        }
        if (planned.suggestions.some(other => other.target.key === place.target.key && other.label === place.label && other.compared === compared)) {
          refusedAt(what, new ActionRefused(`${quoteName(label)} is suggested twice for ${quoteName(place.shown)} in this call.`, { code: 'refused', type }));
          continue;
        }
        planned.suggestions.push({ ...place, text: label, compared, ontologyId: change.ontology_id ?? null, evidence: change.evidence ?? null });
      }
      for (const [at, change] of votes.entries()) {
        const what = `vote ${at + 1} (${quoteName(toCleanString(change.suggestion))})`;
        const place = await placeOf(change, what);
        if (place === null) continue;
        const wanted = exactLabelForCompare(toCleanString(change.suggestion));
        if (planned.suggestions.some(entry => entry.target.key === place.target.key && entry.label === place.label && entry.compared === wanted)) {
          refusedAt(what, new ActionRefused(
            `${quoteName(toCleanString(change.suggestion))} is suggested in this call and comes with the person's upvote; leave its vote out.`,
            { code: 'refused', type },
          ));
          continue;
        }
        let chosen;
        try {
          chosen = targetSuggestion(type, place.shown, session.getSuggestions(place.target.key, place.label), change.suggestion);
        } catch (error) {
          refusedAt(what, error);
          continue;
        }
        const chosenLabel = toCleanString(chosen.label);
        const ownDraft = chosen.proposedBy === `ghid_${userId}`
          && published !== undefined
          && !Object.values(published?.suggestions ?? {}).some(list => list.some(entry => entry.id === chosen.id));
        if (ownDraft) {
          refusedAt(what, new ActionRefused(
            `${quoteName(chosenLabel)} is the person's own suggestion and is not published yet, so a vote on it cannot be published without it: they Publish in Community annotation first.`,
            { code: 'unavailable', type },
          ));
          continue;
        }
        const direction = change.vote === 'none' ? null : change.vote;
        const twice = planned.votes.find(other => other.chosen.id === chosen.id);
        if (twice !== undefined) {
          if (twice.direction !== direction) {
            refusedAt(what, new ActionRefused(`${quoteName(chosenLabel)} of ${quoteName(place.shown)} is voted twice in this call, differently.`, { code: 'refused', type }));
          }
          continue;
        }
        const publishedVote = published === undefined ? undefined : (published?.votes?.[chosen.id] ?? null);
        const localVote = session.getMyVoteDirect(place.target.key, place.label, chosen.id) ?? null;
        planned.votes.push({ ...place, chosen, direction, publishedVote, localVote, settled: publishedVote === direction && localVote === direction });
      }
      if (problems.length > 0) {
        const codes = new Set(problems.map(problem => problem.error.code));
        const said = problems.map(problem => (problem.what === null ? problem.error.marked : `${problem.what}: ${problem.error.marked}`));
        throw new ActionRefused(
          `${said.join(' ')}${votes.length + suggestions.length > 1 ? ' Nothing of this call was published.' : ''}`,
          { code: codes.size === 1 ? [...codes][0] : 'refused', type },
        );
      }

      const factsOf = vote => suggestionFacts(vote.target.key, vote.label, session.getSuggestions(vote.target.key, vote.label).find(entry => entry.id === vote.chosen.id) ?? vote.chosen);
      const answer = (route, pullRequest, ids = []) => {
        const pending = pendingChanges();
        return {
          repository,
          published: route,
          pull_request: pullRequest,
          votes: planned.votes.map(vote => {
            const facts = factsOf(vote);
            return { category: vote.shown, suggestion: facts.label, vote: facts.mine ?? 'none', up: facts.up, down: facts.down };
          }),
          suggestions: planned.suggestions.map((entry, index) => ({ category: entry.shown, id: ids[index], label: entry.text })),
          not_published: pending === null ? null : pending.total,
        };
      };
      // Nothing to change (as published, and here): nothing is asked, nothing is written.
      const changing = planned.votes.filter(vote => !vote.settled);
      if (changing.length === 0 && planned.suggestions.length === 0) return answer('unchanged', null);

      const route = publicationRoute();
      const pending = pendingChanges();
      // Pending votes this publication settles are not "other" changes; the rest stays.
      const settledHere = changing.filter(vote => vote.localVote !== vote.publishedVote).length;
      const others = pending === null ? 0 : Math.max(0, pending.total - settledHere);
      const counted = [
        changing.length > 0 ? formatCountOf(changing.length, 'vote') : null,
        planned.suggestions.length > 0 ? `${formatCountOf(planned.suggestions.length, 'suggestion')} (each with your upvote)` : null,
      ].filter(Boolean).join(' and ');
      await confirm(
        `It publishes ${counted} to ${repository} as one commit${route === 'pull-request' ? ', in a pull request the repository\'s authors merge' : ''}, `
        + 'where others see them on their next Pull; the history cannot take it back.'
        + (others > 0 ? ` Nothing else is published: your other ${formatCountOf(others, 'unpublished change')} ${countNoun(others, 'stays', 'stay')} in this browser.` : ''),
      );
      // Here as the dialog's ▲ ▼ and New suggestion leave them, then published together.
      for (const vote of changing) {
        if (vote.localVote === vote.direction) continue;
        if (vote.localVote !== null) session.vote(vote.target.key, vote.label, vote.chosen.id, vote.localVote);
        if (vote.direction !== null) session.vote(vote.target.key, vote.label, vote.chosen.id, vote.direction);
      }
      const ids = planned.suggestions.map(entry => session.addSuggestion(entry.target.key, entry.label, {
        label: entry.text, ontologyId: entry.ontologyId, evidence: entry.evidence,
      }));
      // Each suggestion as the person's file holds it, with its bucket there.
      const own = ids.length === 0 ? null : session.buildUserFileDocument({ githubUserId: userId });
      const held = own === null ? [] : Object.entries(own.suggestions).flatMap(([bucket, list]) => list.map(entry => ({ bucket, suggestion: entry })));
      const composedSuggestions = ids.map(id => held.find(entry => entry.suggestion.id === id));
      const composedVotes = changing.map(vote => ({ suggestionId: vote.chosen.id, direction: vote.direction }));
      const what = changing.length + ids.length === 1
        ? (ids.length === 1 ? 'suggestion' : 'vote')
        : counted.replace(' (each with your upvote)', '');
      const outcome = await publishOne({
        what,
        compose: (publishedNow, who) => withChanges(publishedNow, { ...who, votes: composedVotes, suggestions: composedSuggestions }),
      }, signal);
      if (outcome.status === 'done') {
        return answer(outcome.mode === 'fork-pull-request' ? 'pull-request' : outcome.changed ? 'repository' : 'unchanged', outcome.prUrl ?? null, ids);
      }
      if (outcome.status === 'unknown') {
        // GitHub may have them: the Pull after it says what GitHub holds now.
        const after = publishedBaseline(scope, session.getRemoteFileShas());
        const there = after !== undefined
          && composedVotes.every(vote => (after?.votes?.[vote.suggestionId] ?? null) === vote.direction)
          && ids.every(id => Object.values(after?.suggestions ?? {}).some(list => list.some(entry => entry.id === id)));
        if (there) return answer('repository', null, ids);
        throw new ActionRefused(
          `Publishing was interrupted and the ${what} may already be published to ${repository}; `
          + (outcome.pulled?.status === 'done'
            ? 'the Pull after it does not show them, so they are kept in this browser, not published.'
            : 'the person Pulls in Community annotation to see.'),
          { code: 'may-be-published', type },
        );
      }
      throw new ActionRefused(
        `The ${what} ${changing.length + ids.length === 1 ? 'is' : 'are'} kept in this browser but not published (${outcome.status === 'cancelled' ? 'cancelled' : outcome.error ?? outcome.status}); the person can Publish from Community annotation.`,
        { code: 'not-published', type },
      );
    }),
  ];

  render();

  return {
    render,
    destroy() {
      for (const remove of unprovideActions) remove();
      destroy();
    },
  };
}
