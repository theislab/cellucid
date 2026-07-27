/**
 * @fileoverview Community annotation (offline-first) sidebar section.
 *
 * Phase 1-2 implementation:
 * - Local session (localStorage) for annotated fields, suggestions, votes
 * - Lightweight UI to manage profile + per-cluster voting/suggestions
 *
 * GitHub App auth + sync is implemented here as a lightweight UI wrapper around
 * the GitHub sync module.
 *
 * @module ui/modules/community-annotation-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import { getCommunityAnnotationFileCache } from '../../community-annotations/file-cache.js';
import { describeCacheScope, toCacheScopeKey, toSessionStorageKey } from '../../community-annotations/cache-scope.js';
import { getCommunityAnnotationCacheContext, syncCommunityAnnotationCacheContext } from '../../community-annotations/runtime-context.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
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
  CommunityAnnotationGitHubSync,
  getGitHubSyncForDataset,
  parseOwnerRepo,
  selectAnnotationPublicationMode,
  setDatasetAnnotationRepoFromUrlParam,
  setDatasetAnnotationRepoFromUrlParamAsync
} from '../../community-annotations/github-sync.js';
import {
  assertConfigDocument,
  assertMergesDocument,
  assertUserDocument,
} from '../../community-annotations/wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubRepositoryFullName,
} from '../../community-annotations/github-reference.js';
import {
  assertExactLinkedInHandle,
  assertExactOptionalProfileText,
  assertExactOrcidId,
  isExactOrcidId,
  parseOrcidExpandedSearch,
  parseOrcidPersonName,
} from '../../community-annotations/profile-identifiers.js';
import {
  AUTO_PULL_INTERVALS_MS,
  DEFAULT_AUTO_PULL_INTERVAL_MS,
  assertAutoPullIntervalMs,
  autoPullIntervalFromSelectValue,
  parseAutoPullPreferences,
  serializeAutoPullPreferences,
} from '../../community-annotations/auto-pull-preferences.js';

const CONSENSUS_SNAPSHOT_FILENAME = 'cellucid-consensus.json';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'checked' || k === 'readonly') {
      // Boolean HTML attributes: presence = true, absence = false
      if (v) node.setAttribute(k, '');
      // Don't set attribute if false (absence means not disabled/checked/readonly)
    } else if (v != null && v !== false) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function toCleanString(value) {
  return String(value ?? '').trim();
}

function runExactCleanup(context, entries) {
  const errors = [];
  for (const [label, operation] of entries) {
    if (operation === null || operation === undefined) continue;
    if (typeof operation !== 'function') {
      errors.push(new TypeError(`${label} cleanup must be a function`));
      continue;
    }
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${context} failed in ${errors.length} cleanup operations`
    );
  }
}

function removeOwningCommunityModal(content) {
  if (!content || typeof content.closest !== 'function') {
    throw new TypeError('Community annotation modal content must expose closest()');
  }
  const overlay = content.closest('.community-annotation-modal-overlay');
  if (!overlay || typeof overlay.remove !== 'function') {
    throw new Error('Community annotation modal overlay is unavailable');
  }
  overlay.remove();
}

function assertExactGitHubLogin(value, label) {
  if (
    typeof value !== 'string' ||
    !isCanonicalGitHubAccount(value)
  ) {
    throw new Error(`${label} must be an exact GitHub account login`);
  }
  return value;
}

function assertExactAnnotationUserKey(value, label) {
  if (
    value !== 'local' &&
    (
      typeof value !== 'string' ||
      !/^ghid_[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value.slice(5))) ||
      value !== `ghid_${Number(value.slice(5))}`
    )
  ) {
    throw new Error(`${label} must be "local" or an exact ghid identity`);
  }
  return value;
}

function requireResolvedAnnotationBranch(sync) {
  const branch = sync?.branch;
  if (
    typeof branch !== 'string' ||
    !branch ||
    /^\s|\s$/.test(branch)
  ) {
    throw new Error(
      'GitHub did not provide an exact resolved branch for the annotation repository'
    );
  }
  return branch;
}

function requireAnnotationBranchMode(meta) {
  if (
    meta === null ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    Object.keys(meta).length !== 1 ||
    !Object.hasOwn(meta, 'branchMode') ||
    (meta.branchMode !== 'default' && meta.branchMode !== 'explicit')
  ) {
    throw new Error(
      'Stored annotation repository metadata must contain exactly branchMode'
    );
  }
  return meta.branchMode;
}

function requireGitHubRepositoryFullName(repoInfo) {
  const value = repoInfo?.full_name;
  if (!isCanonicalGitHubRepositoryFullName(value)) {
    throw new Error(
      'GitHub repository metadata must include an exact full_name'
    );
  }
  return value;
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, n));
}

function formatPctSigned11(value) {
  const v = Number.isFinite(value) ? value : 0;
  const pct = Math.round(v * 100);
  return `${pct}%`;
}

function clampConsensusThreshold11(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(-1, Math.min(1, value));
}

function thresholdToSliderValue(threshold11) {
  const v = clampConsensusThreshold11(Number(threshold11));
  return String(Math.round(v * 100));
}

function sliderValueToThreshold(sliderValue) {
  const pct = Number(sliderValue);
  if (!Number.isFinite(pct)) return 0.5;
  return clampConsensusThreshold11(pct / 100);
}

function findCategoricalFieldByKey(state, fieldKey) {
  const fields = state.getFields?.() || [];
  return fields.find((f) => f?.kind === 'category' && f?.key === fieldKey) || null;
}

function computeProgress(session, fieldKey, categories) {
  const n = Array.isArray(categories) ? categories.length : 0;
  if (!fieldKey || n <= 0) return { done: 0, total: Math.max(0, n) };
  session.setFieldCategories(fieldKey, categories);
  const settings = session.getAnnotatableConsensusSettings(fieldKey);
  if (settings === null) {
    throw new Error(
      `Consensus settings are missing for ${JSON.stringify(fieldKey)}`
    );
  }
  let done = 0;
  for (let i = 0; i < n; i++) {
    const c = session.computeConsensus(fieldKey, i, settings);
    if (c.status === 'consensus') done++;
  }
  return { done, total: n };
}

function downloadJsonAsFile(filename, json) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    /^\s|\s$/.test(filename) ||
    /[\\/:*?"<>|]/.test(filename)
  ) {
    throw new Error('Download filename must be an exact portable filename');
  }
  const payload = JSON.stringify(json, null, 2) + '\n';
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1500);
}

  function showClusterModal({ title, buildContent, modalClassName = '' }) {
    if (typeof buildContent !== 'function') {
      throw new TypeError('Community annotation modal requires a content builder');
    }
    const existing = document.querySelector('.community-annotation-modal-overlay');
    if (existing) existing.remove();

    const overlay = el('div', { className: 'community-annotation-modal-overlay', role: 'dialog', 'aria-modal': 'true' });
    const cls = String(modalClassName || '').trim();
    const modal = el('div', { className: `community-annotation-modal${cls ? ` ${cls}` : ''}`, role: 'document' });

    const header = el('div', { className: 'community-annotation-modal-header' });
    const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Community annotation' });
    titleEl.id = `community-annotation-modal-title-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    overlay.setAttribute('aria-labelledby', titleEl.id);
    header.appendChild(titleEl);
    const closeBtn = el('button', { type: 'button', className: 'btn-small community-annotation-modal-close', text: 'Close' });
    header.appendChild(closeBtn);

    const content = el('div', { className: 'community-annotation-modal-body' });
    buildContent(content);

    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);

    const prevFocus = document.activeElement;
    let closed = false;
    const listFocusable = () => {
      const selectors = [
        'a[href]',
        'area[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(',');
      const nodes = Array.from(modal.querySelectorAll(selectors));
      return nodes.filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (typeof window.getComputedStyle !== 'function') {
          throw new TypeError('Community annotation focus management requires getComputedStyle()');
        }
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return node.getClientRects().length > 0;
      });
    };

    const close = () => {
      if (closed) return;
      closed = true;
      runExactCleanup('Community annotation modal teardown', [
        ['modal keydown listener', () => overlay.removeEventListener('keydown', onKeyDown, true)],
        ['modal overlay', () => overlay.remove()],
        [
          'previous focus target',
          prevFocus === null
            ? null
            : () => {
                if (typeof prevFocus.focus !== 'function') {
                  throw new TypeError('Previous focus target must expose focus()');
                }
                prevFocus.focus();
              }
        ]
      ]);
    };

    const onKeyDown = (e) => {
      if (!e || typeof e.preventDefault !== 'function' || typeof e.stopPropagation !== 'function') {
        throw new TypeError('Community annotation modal key events require exact event methods');
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = listFocusable();
      if (!focusables.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const containsActive = active && modal.contains(active);
      if (e.shiftKey) {
        if (!containsActive || active === first) {
          if (typeof last.focus !== 'function') {
            throw new TypeError('Community annotation focus target must expose focus()');
          }
          e.preventDefault();
          last.focus();
        }
        return;
      }
      if (!containsActive || active === last) {
        if (typeof first.focus !== 'function') {
          throw new TypeError('Community annotation focus target must expose focus()');
        }
        e.preventDefault();
        first.focus();
      }
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener('keydown', onKeyDown, true);

    document.body.appendChild(overlay);
    closeBtn.focus();

    return { close, overlay, modal, content };
  }

function confirmAsync({ title, message, confirmText }) {
  return new Promise((resolve) => {
    showConfirmDialog({
      title,
      message,
      confirmText,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false)
    });
  });
}

function httpStatusOrNull(err) {
  const n = Number(err?.status);
  return Number.isFinite(n) ? n : null;
}

function lowerMessage(err) {
  return String(err?.message || '').trim().toLowerCase();
}

function gitHubApiPath(err) {
  return String(err?.github?.path || '').trim();
}

function workerPath(err) {
  return String(err?.worker?.path || '').trim();
}

function isRepoInfoApiPath(path) {
  return /^\/repos\/[^/]+\/[^/]+$/i.test(String(path || ''));
}

function isTokenAuthFailure(err) {
  if (!err) return false;
  const statusCode = httpStatusOrNull(err);
  const msg = lowerMessage(err);
  if (statusCode === 401) return true;
  if (statusCode === 403) {
    return (
      msg.includes('bad credentials') ||
      msg.includes('invalid token') ||
      msg.includes('requires authentication') ||
      msg.includes('unauthorized') ||
      msg.includes('token expired') ||
      msg.includes('jwt expired')
    );
  }
  return (
    msg.includes('bad credentials') ||
    msg.includes('invalid token') ||
    msg.includes('requires authentication') ||
    msg.includes('unauthorized')
  );
}

function isRateLimitError(err) {
  const statusCode = httpStatusOrNull(err);
  if (statusCode === 429) return true;
  if (statusCode !== 403) return false;
  const msg = lowerMessage(err);
  return msg.includes('rate limit') || msg.includes('secondary rate limit') || msg.includes('abuse detection');
}

function isWorkerOriginSecurityError(err) {
  const code = String(err?.code || '').trim();
  return code === 'GITHUB_WORKER_ORIGIN_INVALID' || code === 'GITHUB_WORKER_ORIGIN_UNTRUSTED';
}

function isNetworkFetchFailure(err) {
  const msg = String(err?.message || '').trim();
  if (err instanceof TypeError) return true;
  return /failed to fetch|load failed|networkerror/i.test(msg);
}

function isRepoNotFoundOrNoAccess(err) {
  const statusCode = httpStatusOrNull(err);
  if (statusCode !== 404) return false;
  const path = gitHubApiPath(err);
  // Private repos may appear as 404 when access is lost; treat the repo as not accessible.
  return isRepoInfoApiPath(path);
}

function isAnnotationRepoStructureError(err) {
  const statusCode = httpStatusOrNull(err);
  const path = gitHubApiPath(err);
  const msg = String(err?.message || '').trim();

  // Required template paths under the repo:
  // - annotations/users/ (directory)
  // - annotations/schema.json (file)
  // - annotations/config.json (file)
  if (statusCode === 404 && /\/contents\/annotations\/(users|schema\.json|config\.json)(?:\/|$)/i.test(path)) {
    return true;
  }
  if (/Expected directory listing at annotations\/users/i.test(msg)) return true;
  if (/Expected file at annotations\/(schema\.json|config\.json)/i.test(msg)) return true;
  if (/Invalid JSON at annotations\/(schema\.json|config\.json)/i.test(msg)) return true;
  return false;
}

function getPublishCapability(repoInfo) {
  const publicationMode = selectAnnotationPublicationMode(repoInfo);
  return {
    publicationMode,
    canDirectPush: publicationMode === 'direct',
    allowForking: publicationMode === 'fork-pull-request',
    canPublish: publicationMode !== null,
  };
}

function describeCannotPublishMessage(repoLabel) {
  return (
    `You do not have permission to publish annotations to ${repoLabel}.\n\n` +
    'GitHub reports you cannot push, and this repo disables forking, so Pull Request publishing is not possible.\n\n' +
    'Ask an author to grant you Write access (or higher), or enable forking for this repo.'
  );
}

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

  let selectedFieldKey = null;
  // Derived consensus column (manual, optional).
  let consensusColumnThreshold = 0.5;
  let consensusColumnMinAnnotators = 1;
  let consensusColumnKey = 'community_cell_type';
  let consensusSourceFieldKey = null;
  // Community annotation internal accordions: closed by default; only one may be open at a time.
  /** @type {'consensus-column'|'manage'|'exports-cache'|null} */
  let openAccordionKey = null;

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
  /** @type {Record<string, {minAnnotators:number, threshold:number}>} */
  const annotatableSettingsDraft = {};
  const annotatableSettingsDirty = new Set();

  const lifecycleAbort = new AbortController();

  // Keep this accordion in sync when other modules connect/disconnect the repo,
  // or when dev simulation toggles are changed from the console.
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    throw new TypeError('Community annotation controls require window.addEventListener()');
  }
  window.addEventListener(
    ANNOTATION_CONNECTION_CHANGED_EVENT,
    () => {
      applySessionCacheContext({});
      render();
    },
    { signal: lifecycleAbort.signal }
  );

  let infoPopoverSequence = 0;

  function createInfoTooltip(label, steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new TypeError(
        'Community annotation information requires at least one exact step'
      );
    }
    const btn = el(
      'button',
      { className: 'info-btn' },
      [el('span', { 'aria-hidden': 'true', text: 'i' })]
    );
    const tooltip = el('div', { className: 'info-tooltip' });
    const content = el('div', { className: 'info-tooltip-content' });
    for (const step of steps) {
      if (
        typeof step !== 'string'
        || !step
        || step.trim() !== step
      ) {
        throw new TypeError(
          'Community annotation information steps must be exact strings'
        );
      }
      content.appendChild(el('div', { className: 'info-step', text: step }));
    }
    tooltip.appendChild(content);
    infoPopoverSequence += 1;
    infoPopovers.configurePair(btn, tooltip, {
      id: `community-annotation-info-${infoPopoverSequence}`,
      label
    });

    return { btn, tooltip };
  }

  function createInfoLabel(text, info) {
    return el('div', { className: 'd-flex items-center gap-1' }, [
      el('label', { text }),
      info.btn
    ]);
  }

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
  let resolvingConnectedRole = false;
  let lastRoleResolveContext = '';

  function notifyCacheScopeIfConnected({ datasetId, repoRef, userId } = {}) {
    const desc = describeCacheScope({ datasetId, repoRef, userId });
    if (!desc) return;
    const scopeId = `${desc.datasetId}::${desc.repo}@${desc.branch}::${desc.userId}`;
    if (scopeId === lastNotifiedCacheScope) return;
    lastNotifiedCacheScope = scopeId;

    const sessionKey = toSessionStorageKey({ datasetId, repoRef, userId });
    if (sessionKey === null) {
      throw new Error('Connected annotation cache scope has no session key');
    }
    if (typeof localStorage === 'undefined') {
      throw new Error('localStorage is required for annotation cache status');
    }
    const raw = localStorage.getItem(sessionKey);
    const sessionStatus = raw === null ? 'empty' : 'found';
    const shas = fileCache.getKnownShas({ datasetId, repoRef, userId });
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

    notifications.success(message, { category: 'annotation', duration: 8000 });
  }

  function applySessionCacheContext({ datasetId = undefined } = {}) {
    const ctx = syncCommunityAnnotationCacheContext({ dataSourceManager, datasetId });
    notifyCacheScopeIfConnected({ datasetId: ctx.datasetId, repoRef: ctx.repoRef, userId: ctx.userId });

    // Prevent stale role/perms from a different repo/user context.
    const nextRoleContext = `${ctx.userKey}::${ctx.repoRef ?? ''}`;
    if (nextRoleContext !== lastRoleContext) {
      lastRoleContext = nextRoleContext;
      lastRoleResolveContext = '';
      lastRepoInfo = null;
      access.clearRole?.();
    }

    // Role must be known (author/annotator) while connected.
    // If we just changed cache context to a connected repo and the role is unknown,
    // attempt to resolve permissions from GitHub immediately; on failure, disconnect.
    if (ctx.repoRef && !ctx.simulated) {
      scheduleResolveConnectedRole({ datasetId: ctx.datasetId });
    }
  }

  function scheduleResolveConnectedRole({ datasetId = undefined } = {}) {
    if (resolvingConnectedRole) return;
    const did =
      datasetId === undefined
        ? dataSourceManager?.getCurrentDatasetId?.()
        : datasetId;
    if (!did) return;
    if (!githubAuth.isAuthenticated?.()) return;
    const userKey = getCacheUserKey();
    const repoRef = getAnnotationRepoForDataset(did, userKey);
    if (!repoRef) return;
    if (!isAnnotationRepoConnected(did, userKey)) return;
    const role = access.getRole();
    if (role !== 'unknown') return;
    const ctx = `${userKey}::${repoRef}`;
    if (ctx === lastRoleResolveContext) return;
    lastRoleResolveContext = ctx;
    if (typeof queueMicrotask !== 'function') {
      throw new Error('queueMicrotask is required for annotation role resolution');
    }
    // Defer so we don't re-enter applySessionCacheContext via sync events.
    queueMicrotask(() => {
      void resolveConnectedRoleOrDisconnect({ datasetId: did });
    });
  }

  async function resolveConnectedRoleOrDisconnect({ datasetId = undefined } = {}) {
    if (resolvingConnectedRole) return false;
    if (syncBusy) return false;
    const did =
      datasetId === undefined
        ? dataSourceManager?.getCurrentDatasetId?.()
        : datasetId;
    if (!did) return false;
    if (!githubAuth.isAuthenticated?.()) return false;
    if (isSimulateRepoConnectedEnabled()) return false;

    resolvingConnectedRole = true;
    try {
      const userId = getCacheUserId();
      if (!userId) {
        disconnectGitHubAndAnnotationRepo({
          datasetId: did,
          message: 'GitHub identity unavailable (missing numeric id). Signed out and disconnected. Please sign in again.',
          notify: 'error'
        });
        return false;
      }

      const userKey = getCacheUserKey();
      const repo = getAnnotationRepoForDataset(did, userKey);
      if (!repo) return false;
      if (!isAnnotationRepoConnected(did, userKey)) return false;

      // If another action already resolved the role, stop.
      const roleNow = access.getRole();
      if (roleNow !== 'unknown') return true;

      const sync = getGitHubSyncForDataset({ datasetId: did, username: userKey });
      if (!sync) throw new Error('Unable to create GitHub sync session.');

      const meta = getAnnotationRepoMetaForDataset(did, userKey);
      const branchMode = requireAnnotationBranchMode(meta);

      const { repoInfo } = await sync.validateAndLoadConfig({ datasetId: did });
      lastRepoInfo = repoInfo;
      access.setRoleFromRepoInfo(lastRepoInfo);

      const finalRole = access.getRole();
      const parsed = parseOwnerRepo(repo);
      if (!parsed) {
        throw new Error('Stored annotation repository reference is invalid');
      }
      const repoLabel = parsed.ownerRepo;
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

      if (!getPublishCapability(repoInfo).canPublish) {
        disconnectAnnotationRepo({
          datasetId: did,
          userKey,
          message: `${describeCannotPublishMessage(repoLabel)}\nDisconnected annotation repo.`,
          notify: 'error'
        });
        return false;
      }

      // Keep repoRef canonicalized to the resolved branch so cache keys remain stable.
      const branch = requireResolvedAnnotationBranch(sync);
      const canonicalRepoRef = `${repoLabel}@${branch}`;
      if (canonicalRepoRef && canonicalRepoRef !== repo) {
        lastRoleContext = `${userKey}::${canonicalRepoRef}`;
        setAnnotationRepoForDataset(
          did,
          canonicalRepoRef,
          userKey,
          { branchMode }
        );
        setUrlAnnotationRepo(canonicalRepoRef);
      }
      session.setCacheContext({ datasetId: did, repoRef: canonicalRepoRef, userId });

      return true;
    } catch (err) {
      const msg =
        err instanceof Error &&
        typeof err.message === 'string' &&
        err.message &&
        !/^\s|\s$/.test(err.message)
          ? err.message
          : 'Annotation role resolution failed with a non-Error value';
      const didSafe =
        datasetId === undefined
          ? dataSourceManager?.getCurrentDatasetId?.()
          : datasetId;
      const userKey = getCacheUserKey();
      const repo = didSafe
        ? getAnnotationRepoForDataset(didSafe, userKey)
        : null;
      const parsedRepo = repo === null ? null : parseOwnerRepo(repo);
      const repoLabel = parsedRepo === null ? 'the annotation repository' : parsedRepo.ownerRepo;
      disconnectAnnotationRepo({
        datasetId: didSafe,
        userKey,
        message: `Unable to determine your role for ${repoLabel}.\n${msg}\nDisconnected annotation repo.`,
        notify: 'error'
      });
      return false;
    } finally {
      resolvingConnectedRole = false;
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

  async function loadMyProfileFromGitHub({ datasetId } = {}) {
    const did =
      datasetId === undefined
        ? dataSourceManager?.getCurrentDatasetId?.()
        : datasetId;
    const userId = getCacheUserId();
    const key = toGitHubUserKey(githubAuth.getUser());
    if (key === null) return false;
    const cacheUser = key;
    const repo = getAnnotationRepoForDataset(did, cacheUser);
    if (!repo) return false;
    if (!githubAuth.isAuthenticated?.()) return false;
    if (!key || !userId) return false;
    try {
	      const sync = getGitHubSyncForDataset({ datasetId: did, username: cacheUser });
	      if (!sync) return false;
	      const meta = getAnnotationRepoMetaForDataset(did, cacheUser);
		      const branchMode = requireAnnotationBranchMode(meta);
	      const { repoInfo, datasetConfig, config, datasetId: didResolved } = await sync.validateAndLoadConfig({ datasetId: did });
	      const parsed = parseOwnerRepo(repo);
		      lastRepoInfo = repoInfo;
		      access.setRoleFromRepoInfo(lastRepoInfo);
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
		      {
		        if (!parsed) {
		          throw new Error('Stored annotation repository reference is invalid');
		        }
		        const repoLabel = parsed.ownerRepo;
	        if (!getPublishCapability(repoInfo).canPublish) {
	          disconnectAnnotationRepo({
	            datasetId: did,
	            userKey: cacheUser,
	            message: `${describeCannotPublishMessage(repoLabel)}\nDisconnected annotation repo.`,
	            notify: 'error'
	          });
	          return false;
	        }
	      }
	      const isDatasetMismatch =
	        didResolved &&
	        Array.isArray(config?.supportedDatasets) &&
	        config.supportedDatasets.length &&
	        !datasetConfig;
		      if (isDatasetMismatch && !access.isAuthor()) {
		        if (!parsed) {
		          throw new Error('Stored annotation repository reference is invalid');
		        }
		        const repoLabel = parsed.ownerRepo;
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
		      if (!parsed) {
		        throw new Error('Stored annotation repository reference is invalid');
		      }
		      const ownerRepo = parsed.ownerRepo;
      const branch = requireResolvedAnnotationBranch(sync);
      const canonicalRepoRef = `${ownerRepo}@${branch}`;
      if (canonicalRepoRef !== repo) {
        // Avoid wiping the role we just inferred when the repo-map dispatches
        // the connection-changed event (which calls applySessionCacheContext()).
        lastRoleContext = `${cacheUser}::${canonicalRepoRef}`;
        setAnnotationRepoForDataset(
          did,
          canonicalRepoRef,
          cacheUser,
          { branchMode }
        );
        setUrlAnnotationRepo(canonicalRepoRef);
      }
      session.setCacheContext({ datasetId: did, repoRef: canonicalRepoRef, userId });
      const mine = await sync.pullUserFile({ userKey: cacheUser });
      if (!mine?.doc) return false;
      session.mergeFromUserFiles([mine.doc], { preferLocalVotes: true });
      if (mine?.path && mine?.sha) session.setRemoteFileSha(mine.path, mine.sha);
      return true;
    } catch (error) {
      const message = String(error?.message || 'Failed to load your annotation profile');
      syncError = message;
      notifications.error(message, { category: 'annotation', duration: 10000 });
      return false;
    }
  }

		  async function editIdentityFlow({
	    suggestedUsername = null,
	    reason = null
		  } = {}) {
		    const current = session.getProfile();
    const authenticatedKey = toGitHubUserKey(githubAuth.getUser());
    const userKey = authenticatedKey === null ? 'local' : authenticatedKey;
    const rawSuggested =
      suggestedUsername === null
        ? current.login
        : suggestedUsername;
    const suggested =
      rawSuggested === ''
        ? ''
        : assertExactGitHubLogin(rawSuggested, 'Suggested GitHub login');
    const remoteFields = userKey ? session.getKnownUserProfile(userKey) : null;

	    return new Promise((resolve) => {
	      let resolved = false;
	      const resolveOnce = (value) => {
	        if (resolved) return;
	        resolved = true;
	        resolve(value);
	      };

	      let orcidSuggestPopupEl = null;
	      let orcidSuggestAnchorEl = null;

	      const modalRef = showClusterModal({
	        title: 'Your identity',
	        modalClassName: 'community-annotation-modal--narrow',
	        buildContent: (content) => {
	          const note = el('div', { className: 'legend-help' });
	          note.appendChild(document.createTextNode('Saved locally (like votes) until you Publish; Publish writes it into your GitHub user file. '));
	          const optionalEm = document.createElement('em');
	          optionalEm.textContent = 'All fields are optional.';
	          note.appendChild(optionalEm);
	          content.appendChild(note);

          if (reason) content.appendChild(el('div', { className: 'legend-help', text: `⚠ ${String(reason)}` }));

          const status = el('div', { className: 'legend-help', text: '' });
          content.appendChild(status);

	          if (suggested) {
	            content.appendChild(el('div', { className: 'legend-help', text: `GitHub: @${suggested}` }));
	          } else {
	            content.appendChild(el('div', {
	              className: 'legend-help',
	              text: 'GitHub account not available. Sign in to set identity.'
            }));
          }

          async function lookupOrcidName(orcidId, { signal } = {}) {
            const id = assertExactOrcidId(orcidId);
            const url = `https://pub.orcid.org/v3.0/${encodeURIComponent(id)}/person`;
            const res = await fetch(url, {
              method: 'GET',
              headers: { Accept: 'application/vnd.orcid+json' },
              signal,
              cache: 'no-store',
              mode: 'cors'
            });
            if (!res.ok) {
              throw new Error(`ORCID lookup failed (HTTP ${res.status})`);
            }
            const data = await res.json();
            return { name: parseOrcidPersonName(data), orcid: id };
          }

          content.appendChild(el('label', { className: 'legend-help', text: 'Name:' }));
          const nameInput = el('input', {
            type: 'text',
            className: 'community-annotation-text-input',
            name: 'cellucid_identity_display_name',
            autocomplete: 'off',
            placeholder: 'e.g. Alice Smith',
            value: current?.displayName || remoteFields?.displayName || ''
          });
          content.appendChild(nameInput);

          content.appendChild(el('label', { className: 'legend-help', text: 'Affiliation / role:' }));
          const titleInput = el('input', {
            type: 'text',
            className: 'community-annotation-text-input',
            name: 'cellucid_identity_affiliation',
            autocomplete: 'off',
            placeholder: 'e.g. Theis Lab, Postdoc',
            value: current?.title || remoteFields?.title || ''
          });
          content.appendChild(titleInput);

          content.appendChild(el('label', { className: 'legend-help', text: 'LinkedIn:' }));
          const linkedinInput = el('input', {
            type: 'text',
            className: 'community-annotation-text-input',
            name: 'cellucid_identity_linkedin',
            autocomplete: 'off',
            autocorrect: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
            inputmode: 'text',
            placeholder: 'Handle only (no URL). Example: username',
            value: current?.linkedin || remoteFields?.linkedin || ''
          });
          content.appendChild(linkedinInput);

	          content.appendChild(el('label', { className: 'legend-help', text: 'ORCID:' }));
	          const orcidInputName = `cellucid_identity_orcid_${Math.random().toString(36).slice(2)}`;
	          const orcidInput = el('input', {
	            type: 'text',
	            className: 'community-annotation-text-input',
	            name: orcidInputName,
	            autocomplete: 'off',
	            autocorrect: 'off',
	            autocapitalize: 'off',
	            spellcheck: 'false',
	            inputmode: 'text',
	            placeholder: 'Type a name or ORCID ID (auto-suggest)',
	            value: current?.orcid || remoteFields?.orcid || ''
	          });
	          content.appendChild(orcidInput);

	          const suggestionBox = el('div', {
	            className: 'community-annotation-suggest community-annotation-suggest--popup',
	            role: 'listbox'
	          });
	          orcidSuggestPopupEl = suggestionBox;
	          orcidSuggestAnchorEl = orcidInput;

	          const positionSuggest = () => {
	            if (!orcidSuggestPopupEl || !orcidSuggestAnchorEl) return;
	            const anchorRect = orcidSuggestAnchorEl.getBoundingClientRect();
	            const maxH = 180;
	            const gap = 6;

	            orcidSuggestPopupEl.style.width = `${Math.max(160, Math.floor(anchorRect.width))}px`;
	            orcidSuggestPopupEl.style.left = `${Math.floor(anchorRect.left)}px`;

	            const spaceBelow = window.innerHeight - anchorRect.bottom;
	            const preferAbove = spaceBelow < maxH + gap && anchorRect.top > maxH + gap;
	            if (preferAbove) {
	              orcidSuggestPopupEl.style.top = `${Math.floor(anchorRect.top - gap)}px`;
	              orcidSuggestPopupEl.style.transform = 'translateY(-100%)';
	            } else {
	              orcidSuggestPopupEl.style.top = `${Math.floor(anchorRect.bottom + gap)}px`;
	              orcidSuggestPopupEl.style.transform = '';
	            }
	          };

	          const renderSuggestions = (items, { loading = false, emptyMessage = '' } = {}) => {
	            suggestionBox.innerHTML = '';
	            suggestionBox.style.display = 'none';
	            if (loading) {
	              // Keep silent: show nothing while searching.
	              return;
	            }
	            if (!Array.isArray(items)) {
	              throw new Error('ORCID suggestions must be an array');
	            }
	            const list = items;
	            if (!list.length) {
	              return;
	            }
	            for (const item of list) {
              const orcid = assertExactOrcidId(item?.orcid);
              const name =
                item?.name === null
                  ? ''
                  : assertExactOptionalProfileText(item?.name, 'ORCID result name', 240);
              const label = name ? `${name} — ${orcid}` : orcid;
	              const row = el('div', { className: 'community-annotation-suggest-item', role: 'option', text: label });
	              row.addEventListener('click', () => {
	                if (orcid) orcidInput.value = orcid;
	                if (name) nameInput.value = name;
	                suggestionBox.style.display = 'none';
	              });
	              suggestionBox.appendChild(row);
	            }
	            suggestionBox.style.display = 'block';
	            requestAnimationFrame(positionSuggest);
	            setTimeout(positionSuggest, 60);
	          };

	          async function searchOrcid(query, { signal } = {}) {
	            const q = assertExactOptionalProfileText(query, 'ORCID search query', 240);
	            if (!q) return [];

	            // Small in-memory cache for snappy UX (per modal open).
	            const key = q;
	            const cached = orcidSearchCache.get(key);
	            if (cached && Date.now() - cached.at < 60_000) return cached.items;

	            if (isExactOrcidId(q)) {
	              const direct = await lookupOrcidName(q, { signal });
	              const items = [{ orcid: direct.orcid, name: direct.name }];
	              orcidSearchCache.set(key, { at: Date.now(), items });
	              return items;
	            }

	            const url =
	              `https://pub.orcid.org/v3.0/expanded-search/?q=${encodeURIComponent(q)}&rows=8`;
	            const res = await fetch(url, {
	              method: 'GET',
	              headers: { Accept: 'application/vnd.orcid+json' },
	              signal,
	              cache: 'no-store',
	              mode: 'cors'
	            });
	            if (!res.ok) {
	              throw new Error(`ORCID search failed (HTTP ${res.status})`);
	            }
	            const out = parseOrcidExpandedSearch(await res.json(), {
	              maximumResults: 8,
	            });
	            orcidSearchCache.set(key, { at: Date.now(), items: out });
	            return out;
	          }

	          let searchTimer = null;
	          let activeSearch = null;
	          let lastQuery = '';
	          const orcidSearchCache = new Map();
		          const scheduleSearch = (query) => {
		            const q = query;
		            if (q === lastQuery) return;
		            lastQuery = q;
            if (searchTimer) clearTimeout(searchTimer);
            if (activeSearch !== null) {
              if (typeof activeSearch.abort !== 'function') {
                throw new TypeError('ORCID search controller must expose abort()');
              }
              activeSearch.abort();
            }

	            if (typeof q !== 'string' || !q || q.length < 3) {
	              renderSuggestions([], { loading: false, emptyMessage: '' });
	              return;
	            }

	            searchTimer = setTimeout(async () => {
	              const ctrl = new AbortController();
	              activeSearch = ctrl;
	              renderSuggestions([], { loading: true });
	              const timeout = setTimeout(() => ctrl.abort(), 6500);
	              try {
	                const items = await searchOrcid(q, { signal: ctrl.signal });
	                if (!items.length) {
	                  renderSuggestions([], { loading: false, emptyMessage: '' });
	                  status.textContent = 'No ORCID records matched the exact query.';
	                  return;
	                }
	                status.textContent = '';
	                renderSuggestions(items, { loading: false });
	              } catch (err) {
	                if (err?.name === 'AbortError') {
	                  renderSuggestions([], { loading: false, emptyMessage: '' });
	                } else {
	                  renderSuggestions([], { loading: false, emptyMessage: '' });
	                  status.textContent =
	                    typeof err?.message === 'string' && err.message
	                      ? err.message
	                      : 'ORCID lookup failed';
	                }
	              } finally {
	                clearTimeout(timeout);
	              }
		            }, 250);
		          };

          const onAnyInput = () => {
            const qId = orcidInput.value;
            const qName = nameInput.value;
            const query = qId.length >= qName.length ? qId : qName;
            scheduleSearch(query);
          };

          nameInput.addEventListener('input', onAnyInput);
          orcidInput.addEventListener('input', onAnyInput);
          let hideTimer = null;
          const scheduleHide = () => {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
              suggestionBox.style.display = 'none';
            }, 150);
          };
          const cancelHide = () => {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = null;
          };
	          nameInput.addEventListener('focus', cancelHide);
	          orcidInput.addEventListener('focus', cancelHide);
	          nameInput.addEventListener('blur', scheduleHide);
	          orcidInput.addEventListener('blur', scheduleHide);
	          suggestionBox.addEventListener('pointerdown', cancelHide);
	          const scroller = content.closest('.community-annotation-modal-body');
	          scroller.addEventListener('scroll', () => {
	            if (suggestionBox.style.display !== 'none') positionSuggest();
	          }, { passive: true });
	          window.addEventListener('resize', () => {
	            if (suggestionBox.style.display !== 'none') positionSuggest();
	          }, { passive: true });

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const saveBtn = el('button', { type: 'button', className: 'btn-small', text: 'Save' });
          const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });
          actions.appendChild(saveBtn);
          actions.appendChild(cancelBtn);
          content.appendChild(actions);

		          cancelBtn.addEventListener('click', () => {
		            removeOwningCommunityModal(content);
		            resolveOnce(null);
		          });

          saveBtn.addEventListener('click', () => {
            try {
              const login = assertExactGitHubLogin(
                suggested,
                'Authenticated GitHub login'
              );
              const nextProfile = {
                ...current,
                username: assertExactAnnotationUserKey(
                  userKey,
                  'Authenticated annotation identity'
                ),
                login,
                displayName: assertExactOptionalProfileText(
                  nameInput.value,
                  'Name',
                  120
                ),
                title: assertExactOptionalProfileText(
                  titleInput.value,
                  'Affiliation / role',
                  120
                ),
                orcid: assertExactOrcidId(orcidInput.value, {
                  allowEmpty: true,
                }),
                linkedin: assertExactLinkedInHandle(linkedinInput.value, {
                  allowEmpty: true,
                })
              };
              session.setProfile(nextProfile);
              removeOwningCommunityModal(content);
              resolveOnce({ username: userKey, dismissed: false });
            } catch (error) {
              status.textContent =
                typeof error?.message === 'string' && error.message
                  ? error.message
                  : 'Profile validation failed';
            }
          });
	        }
	      });

	      const overlay = modalRef?.overlay || null;
	      if (!overlay) return;
	      if (orcidSuggestPopupEl) {
	        overlay.appendChild(orcidSuggestPopupEl);
	      }
	      const observer = new MutationObserver(() => {
	        if (resolved) {
	          observer.disconnect();
	          return;
	        }
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          resolveOnce(null);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

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

  const setDatasetContextFromManager = () => {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    applySessionCacheContext({ datasetId });

    const paramRepo = getUrlAnnotationRepo();
    if (paramRepo && (githubAuth.isAuthenticated?.() || isSimulateRepoConnectedEnabled())) {
      const username = getCacheUserKey();
      const parsed = parseOwnerRepo(paramRepo);
      // Resolve a missing branch once before persisting the canonical reference.
      if (parsed && !parsed.ref) {
        (async () => {
          const ok = await setDatasetAnnotationRepoFromUrlParamAsync({
            datasetId,
            urlParamValue: paramRepo,
            username,
          });
          if (!ok) {
            throw new Error(
              'The annotation_repo URL parameter is not a canonical owner/repo reference'
            );
          }
          applySessionCacheContext({ datasetId });
          render();
        })().catch((error) => {
          syncError = String(
            error?.message || 'Unable to apply annotation_repo URL parameter'
          );
          notifications.error(syncError, {
            category: 'annotation',
            duration: 10_000,
          });
          render();
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

  if (dataSourceManager?.onDatasetChange) {
    dataSourceManager.onDatasetChange(() => {
      setDatasetContextFromManager();
      render();
    });
  }
  setDatasetContextFromManager();

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
    // Clear auth-related errors and update identity UI quickly.
    syncError = null;
    if (!githubAuth.isAuthenticated?.()) {
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
      lastRepoInfo = null;
      access.clearRole?.();
      applySessionCacheContext({});
      render();
      return;
    }
    syncIdentityFromAuth({ promptIfMissing: false })
      .then(() => loadMyProfileFromGitHub({}))
      .catch((error) => {
        syncError =
          typeof error?.message === 'string' && error.message
            ? error.message
            : 'Unable to synchronize the authenticated GitHub identity';
        notifications.error(syncError, {
          category: 'annotation',
          duration: 10000,
        });
      })
      .finally(() => {
        applySessionCacheContext({});
        render();
      });
  }) || null;
  const unsubscribeAccess = access.on?.('changed', () => render()) || null;

  function destroy() {
    runExactCleanup('Community annotation controls teardown', [
      ['session change subscription', unsubscribe],
      ['session lock-lost subscription', unsubscribeSessionLockLost],
      ['session lock-error subscription', unsubscribeSessionLockError],
      ['session persistence-error subscription', unsubscribeSessionPersistenceError],
      ['session integrity-error subscription', unsubscribeSessionIntegrityError],
      ['authentication subscription', unsubscribeAuth],
      ['access subscription', unsubscribeAccess],
      ['annotation connection listener', () => lifecycleAbort.abort()],
      ['information popover', () => infoPopovers.closeWithin(container)]
    ]);
  }

  async function applyConsensusColumn() {
    const sourceFieldKey = consensusSourceFieldKey || selectedFieldKey || null;
    if (!sourceFieldKey) return;
    const targetKey = String(consensusColumnKey || '').trim();
    if (!targetKey) {
      notifications.error('Consensus column key is required', { category: 'annotation', duration: 2600 });
      return;
    }

    const fields = state.getFields?.() || [];
    const fieldIndex = fields.findIndex((f) => f?.kind === 'category' && f?.key === sourceFieldKey && f?._isDeleted !== true);
    if (fieldIndex < 0) return;

    try {
      await state.ensureFieldLoaded?.(fieldIndex, { silent: true });
    } catch (err) {
      notifications.error(err?.message || 'Failed to load field for consensus', { category: 'annotation' });
      return;
    }

    const field = state.getFields?.()?.[fieldIndex] || null;
    const categories = Array.isArray(field?.categories) ? field.categories : [];
    const codes = field?.codes;
    if (!categories.length || !codes || typeof codes.length !== 'number') return;
    session.setFieldCategories(sourceFieldKey, categories);

    const labelToIndex = new Map();
    const outCategories = [];

    const getLabelIndex = (label) => {
      if (
        typeof label !== 'string' ||
        !/\S/.test(label) ||
        /^\s|\s$/.test(label)
      ) {
        throw new Error('Consensus labels must be exact nonblank strings');
      }
      const k = label;
      if (labelToIndex.has(k)) return labelToIndex.get(k);
      const idx = outCategories.length;
      outCategories.push(k);
      labelToIndex.set(k, idx);
      return idx;
    };

    const oldToNew = new Array(categories.length);
    for (let i = 0; i < categories.length; i++) {
      const c = session.computeConsensus(sourceFieldKey, i, { minAnnotators: consensusColumnMinAnnotators, threshold: consensusColumnThreshold });
      const label =
        c.status === 'consensus' && c.label
          ? c.label
          : c.status === 'disputed'
            ? 'Disputed'
            : 'Pending';
      oldToNew[i] = getLabelIndex(label);
    }

    const maxCat = outCategories.length;
    const OutArray = maxCat <= 255 ? Uint8Array : Uint16Array;
    const outCodes = new OutArray(codes.length);
    const missingIndex = getLabelIndex('Pending');
    const missingSourceCode =
      codes instanceof Uint8Array
        ? 255
        : codes instanceof Uint16Array
          ? 65535
          : null;
    for (let i = 0; i < codes.length; i++) {
      const oldIdx = codes[i];
      if (missingSourceCode !== null && oldIdx === missingSourceCode) {
        outCodes[i] = missingIndex;
        continue;
      }
      if (!Number.isInteger(oldIdx) || oldIdx < 0 || oldIdx >= oldToNew.length) {
        throw new Error(
          `Consensus source code at cell ${i} is outside the exact category range`
        );
      }
      outCodes[i] = oldToNew[oldIdx];
    }

    const result = state.upsertUserDefinedCategoricalField({
      key: targetKey,
      categories: outCategories,
      codes: outCodes,
      meta: {
        _sourceField: {
          kind: 'community-annotation',
          sourceKey: sourceFieldKey,
          sourceIndex: fieldIndex
        },
        _operation: {
          type: 'community-consensus',
          fieldKey: sourceFieldKey,
          builtAt: Date.now()
        }
      }
    });

    const suffix = result.updatedInPlace ? '' : ` (created as "${result.key}")`;
    notifications.success(`Updated consensus column: ${result.key}${suffix}`, { category: 'annotation', duration: 2600 });
  }

  function openExternal(url) {
    if (
      typeof url !== 'string' ||
      !url ||
      /^\s|\s$/.test(url)
    ) {
      return false;
    }
    if (typeof URL.canParse !== 'function') {
      throw new TypeError('External navigation requires URL.canParse()');
    }
    if (!URL.canParse(url)) {
      return false;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.toString() !== url) return false;
    if (typeof window.open !== 'function') {
      throw new TypeError('External navigation requires window.open()');
    }
    return window.open(parsed.toString(), '_blank', 'noopener,noreferrer') !== null;
  }

  async function copyTextToClipboard(text) {
    if (
      typeof text !== 'string' ||
      !text ||
      /^\s|\s$/.test(text)
    ) {
      return false;
    }
    const value = text;
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    throw new TypeError('Community annotation copying requires navigator.clipboard.writeText()');
  }

  function describeGitHubAuthReachabilityError(err) {
    const msg = String(err?.message || '').trim();
    const origin = String(window.location.origin || '').trim();
    const looksLikeCors =
      err instanceof TypeError ||
      /failed to fetch|load failed/i.test(msg);
    if (!looksLikeCors) return msg || 'Request failed';
    return `Couldn’t reach the GitHub sign-in server from ${origin || 'this site'}. If you recently changed domains, update your Cloudflare Worker allowlist (ALLOWED_ORIGINS) to include ${origin || 'this origin'}, then reload.`;
  }

  async function openGitHubConnectionFlow({
    mode = 'repo',
    focus = 'overview',
    reason = null,
    datasetId = null,
    cacheUser = null,
    login = null,
    currentRepo = null,
    defaultPullNow = true
  } = {}) {
    const appInstallUrl = 'https://github.com/apps/cellucid-community-annotations/installations/new';
    const settingsUrl = 'https://github.com/settings/installations';

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const modalRef = showClusterModal({
        title: 'GitHub sync',
        buildContent: (content) => {
          const modalAbort = new AbortController();
          // Allow outer scope to stop listeners when modal closes.
          content.__cellucidCleanup = () => modalAbort.abort();

          const did =
            datasetId !== null
              ? datasetId
              : (dataSourceManager?.getCurrentDatasetId?.() ?? null);
          const initialUserKey =
            cacheUser !== null ? cacheUser : getCacheUserKey();
          assertExactAnnotationUserKey(
            initialUserKey,
            'GitHub sync initial user'
          );
          const getEffectiveUserKey = () => {
            const key = toGitHubUserKey(githubAuth.getUser?.());
            return key === null ? initialUserKey : key;
          };
          const initialRepoRef = currentRepo;

          let connectedRepoRef = initialRepoRef;
          let repoListLoaded = false;
          let installationsLoaded = false;
          let isReloadingRepos = false;
          /** @type {{full_name:string, private?:boolean}[]} */
          let allRepos = [];
          /** @type {{id:number, account:{login:string}}[]} */
          let installations = [];
          /** @type {string} */
          let selectedRepoFullName = '';

          const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
          const icon = (d, { viewBox = '0 0 24 24' } = {}) => {
            const svg = svgEl('svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('aria-hidden', 'true');
            svg.classList.add('community-annotation-status-icon');
            const path = svgEl('path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', 'currentColor');
            path.setAttribute('stroke-width', '1.8');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(path);
            return svg;
          };

          const statusList = el('div', { className: 'community-annotation-status-list' });
          const makeStatusRow = ({ iconEl, tone = 'warn', key = '', value = '', actions = [] } = {}) => {
            const keyEl = el('span', { className: 'community-annotation-status-key', text: key || '' });
            const valueEl = el('span', { className: 'community-annotation-status-val', text: value || '' });
            const textEl = el('div', { className: 'community-annotation-status-text' }, [keyEl, valueEl]);
            const chip = el('div', { className: `community-annotation-status-chip community-annotation-status-chip--${tone}` }, [
              iconEl || null,
              textEl
            ]);
            const actionsWrap = el('div', { className: 'community-annotation-status-actions' }, actions);
            const row = el('div', { className: 'community-annotation-status-row' }, [chip, actionsWrap]);
            return { row, chip, actionsWrap, keyEl, valueEl };
          };

          const datasetIcon = icon('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 6c0 1.7 3.6 3 8 3s8-1.3 8-3m-16 6c0 1.7 3.6 3 8 3s8-1.3 8-3');
          const githubIcon = icon('M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 9a8 8 0 0 1 16 0');
          const repoIcon = icon('M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM8 8h8M8 12h8M8 16h6');
          const gearIcon = icon('M12 15.5a3.5 3.5 0 1 0-3.5-3.5 3.5 3.5 0 0 0 3.5 3.5zm7-3.5a7.8 7.8 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8.4 8.4 0 0 0-1.7-1l-.3-2.6H9.5L9.2 6.1a8.4 8.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8.4 8.4 0 0 0 1.7 1l.3 2.6h5l.3-2.6a8.4 8.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5a7.8 7.8 0 0 0 .1-1z');
          const disconnectIcon = icon('M10 17l5-5-5-5M15 12H3M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3');

          const githubSettingsBtn = el('button', { type: 'button', className: 'community-annotation-status-action', title: 'GitHub settings', 'aria-label': 'GitHub settings' }, [gearIcon]);
          const disconnectGitHubBtn = el('button', { type: 'button', className: 'community-annotation-status-action', title: 'Disconnect GitHub', 'aria-label': 'Disconnect GitHub' }, [disconnectIcon.cloneNode(true)]);
          const disconnectRepoBtn = el('button', { type: 'button', className: 'community-annotation-status-action', title: 'Disconnect repository', 'aria-label': 'Disconnect repository' }, [disconnectIcon.cloneNode(true)]);

          const datasetRow = makeStatusRow({ iconEl: datasetIcon, tone: 'warn', key: 'Dataset', value: '' });
          const githubRow = makeStatusRow({ iconEl: githubIcon, tone: 'warn', key: 'GitHub', value: '', actions: [githubSettingsBtn, disconnectGitHubBtn] });
          const repoRow = makeStatusRow({ iconEl: repoIcon, tone: 'warn', key: 'Repo', value: '', actions: [disconnectRepoBtn] });

          statusList.appendChild(datasetRow.row);
          statusList.appendChild(githubRow.row);
          statusList.appendChild(repoRow.row);
          content.appendChild(statusList);

          const step1Desc = [
            'This redirects you to GitHub to sign you in. ',
            el('strong', { text: 'Cellucid does not get access to your repositories by default.' }),
            ' You decide later whether to install the GitHub App and which repositories to enable.'
          ];

          const stepDefs = [
            {
              title: 'Sign in with GitHub',
              descParts: step1Desc
            },
            {
              title: 'Install the GitHub App',
              descParts: [
                'Install the GitHub App on your account/org and select which repositories it can access. ',
                'Use “Add repo” to open GitHub, then come back and click “Reload”.'
              ]
            },
            {
              title: 'Select an annotation repository',
              descParts: [
                'Pick a repository where the app is installed. ',
                'This connection is saved locally per dataset (',
                el('code', { text: String(did || 'default') }),
                ') and per GitHub account. ',
                'Cellucid will validate the repo, connect it to this dataset, and pull the latest annotations.'
              ]
            },
            {
              title: 'Sync (pull / publish)',
              descParts: [
                'Use Pull to fetch updates from GitHub. ',
                'Cellucid selects one publication route from the repository permissions before publishing: a direct write for writers, or a fork Pull Request for contributors. A failed route is reported and is never replaced by another route. ',
                'Optional: enable Auto pull to periodically refresh from GitHub.'
              ]
            }
          ];

          const stepEls = stepDefs.map((s, i) => {
            const n = i + 1;
            const node = el('div', { className: 'community-annotation-step', role: 'listitem', 'data-step': String(n) }, [
              el('div', { className: 'community-annotation-step-num', text: String(n) }),
              el('div', { className: 'community-annotation-step-title', text: s.title })
            ]);
            return node;
          });

          const stepper = el('div', { className: 'community-annotation-stepper', role: 'list' }, stepEls);
          content.appendChild(stepper);

          const stepIntro = el('div', { className: 'community-annotation-step-intro' });
          const stepIntroTitle = el('div', { className: 'community-annotation-step-intro-title', text: '' });
          const stepIntroDesc = el('div', { className: 'community-annotation-step-intro-desc' });
          stepIntro.appendChild(stepIntroTitle);
          stepIntro.appendChild(stepIntroDesc);
          content.appendChild(stepIntro);

          const step1Panel = el('div', { className: 'community-annotation-step-panel' });
          const step1Help = el('div', { className: 'legend-help', text: '' });
          step1Panel.appendChild(step1Help);
          const step1Actions = el('div', { className: 'community-annotation-step1-actions' });
          const step1SignInBtn = el('button', { type: 'button', className: 'btn-small', text: 'Continue with GitHub' });
          step1Actions.appendChild(step1SignInBtn);
          step1Panel.appendChild(step1Actions);
          content.appendChild(step1Panel);

          // Step 2: add/refresh repos (no selection).
          const step2Panel = el('div', { className: 'community-annotation-step-panel' });
          const step2Help = el('div', { className: 'legend-help', text: '' });
          step2Panel.appendChild(step2Help);
          const step2Actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const addRepoBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add repo' });
          const reloadReposBtn = el('button', { type: 'button', className: 'btn-small community-annotation-reload-btn', text: 'Reload' });
          step2Actions.appendChild(addRepoBtn);
          step2Actions.appendChild(reloadReposBtn);
          step2Panel.appendChild(step2Actions);
          const repoGridStep2 = el('div', { className: 'community-annotation-repo-grid' });
          step2Panel.appendChild(repoGridStep2);
          content.appendChild(step2Panel);

          // Step 3: pick repo (selection + connect).
          const step3Panel = el('div', { className: 'community-annotation-step-panel' });
          const step3Help = el('div', { className: 'legend-help', text: 'Select an annotation repository to connect.' });
          step3Panel.appendChild(step3Help);

          const filterRow = el('div', { className: 'legend-help', text: '' });
          const filterInput = el('input', {
            type: 'text',
            className: 'community-annotation-text-input',
            autocomplete: 'off',
            placeholder: 'Filter repositories…',
            value: ''
          });
          filterRow.appendChild(filterInput);
          step3Panel.appendChild(filterRow);

          const repoGridStep3 = el('div', { className: 'community-annotation-repo-grid' });
          step3Panel.appendChild(repoGridStep3);

          const step3Selection = el('div', { className: 'legend-help', text: '' });
          step3Panel.appendChild(step3Selection);
          content.appendChild(step3Panel);

          const syncBlock = el('div', { className: 'community-annotation-step-panel' });
          syncBlock.appendChild(el('div', { className: 'legend-help', text: 'Sync' }));
          const syncTopRow = el('div', { className: 'community-annotation-sync-toprow' });
          const syncActions = el('div', { className: 'community-annotation-suggestion-actions' });
          const pullBtn = el('button', { type: 'button', className: 'btn-small', text: 'Pull latest' });
          const publishBtn = el('button', { type: 'button', className: 'btn-small', text: 'Publish' });
          syncActions.appendChild(pullBtn);
          syncActions.appendChild(publishBtn);
          syncTopRow.appendChild(syncActions);

          const autoPullRow = el('div', { className: 'community-annotation-auto-pull-row' });
          const autoPullToggle = el('label', { className: 'community-annotation-auto-pull-toggle' });
          const autoPullCheckbox = el('input', { type: 'checkbox' });
          autoPullToggle.appendChild(autoPullCheckbox);
          autoPullToggle.appendChild(el('span', { text: 'Auto pull' }));
	          const autoPullSelect = el('select', { className: 'community-annotation-auto-pull-select' });
	          const autoPullOptions = [
	            { ms: AUTO_PULL_INTERVALS_MS[0], label: 'Every 10 minutes' },
	            { ms: AUTO_PULL_INTERVALS_MS[1], label: 'Every 15 minutes' },
	            { ms: AUTO_PULL_INTERVALS_MS[2], label: 'Every 60 minutes' }
	          ];
	          for (const opt of autoPullOptions) {
	            autoPullSelect.appendChild(el('option', { value: String(opt.ms), text: opt.label }));
	          }
          autoPullRow.appendChild(autoPullToggle);
          autoPullRow.appendChild(autoPullSelect);
          syncTopRow.appendChild(autoPullRow);
          syncBlock.appendChild(syncTopRow);
          content.appendChild(syncBlock);

          const status = el('div', {
            className: 'community-annotation-wizard-status',
            role: 'status',
            'aria-live': 'polite',
            text: String(reason || '')
          });
          content.appendChild(status);

          const wizardNav = el('div', { className: 'community-annotation-wizard-nav' });
          const prevBtn = el('button', { type: 'button', className: 'btn-small community-annotation-wizard-prev', text: 'Back' });
          const stepCount = el('div', { className: 'community-annotation-wizard-stepcount', text: '' });
          const nextBtn = el('button', { type: 'button', className: 'btn-small community-annotation-wizard-next', text: 'Next' });
          wizardNav.appendChild(prevBtn);
          wizardNav.appendChild(stepCount);
          wizardNav.appendChild(nextBtn);
          content.appendChild(wizardNav);

	          let isSigningIn = false;
	          let isConnectingRepo = false;
	          let autoPullEnabled = false;
	          let autoPullIntervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS;
          /** @type {string} */
          let autoPullScopeKey = '';
          /** @type {ReturnType<typeof setInterval>|null} */
          let autoPullTimer = null;
          let autoPullTimerMs = 0;

          const AUTO_PULL_STORAGE_KEY = 'cellucid:community-annotations:auto-pull:v1';

          const readAutoPullPrefs = () => {
            if (typeof localStorage === 'undefined') {
              throw new Error('Auto-pull preferences require localStorage');
            }
            return parseAutoPullPreferences(
              localStorage.getItem(AUTO_PULL_STORAGE_KEY)
            );
          };

          const writeAutoPullPrefs = (prefs) => {
            if (typeof localStorage === 'undefined') {
              throw new Error('Auto-pull preferences require localStorage');
            }
            localStorage.setItem(
              AUTO_PULL_STORAGE_KEY,
              serializeAutoPullPreferences(prefs)
            );
          };

	          const computeAutoPullScopeKey = () => {
	            if (!did || !githubAuth.isAuthenticated()) return null;
	            const effectiveUserKey = getEffectiveUserKey();
	            const userId = getCacheUserId();
	            if (
	              !Number.isSafeInteger(userId) ||
	              userId < 1 ||
	              effectiveUserKey !== `ghid_${userId}`
	            ) {
	              throw new Error(
	                'Auto-pull requires the exact current authenticated GitHub identity'
	              );
	            }
	            const repoRef = getAnnotationRepoForDataset(did, effectiveUserKey);
	            if (repoRef === null) return null;
	            const key = toCacheScopeKey({ datasetId: did, repoRef, userId });
	            if (key === null) {
	              throw new Error(
	                'Auto-pull requires a repository with an exact resolved branch'
	              );
	            }
	            return key;
	          };

	          const syncAutoPullFromStorage = () => {
	            const nextKey = computeAutoPullScopeKey();
	            if (!nextKey) {
	              autoPullScopeKey = '';
	              autoPullEnabled = false;
	              autoPullIntervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS;
	              return;
	            }
	            if (nextKey === autoPullScopeKey) return;
	            autoPullScopeKey = nextKey;
	            const prefs = readAutoPullPrefs();
	            const entry = prefs[autoPullScopeKey];
	            if (entry === undefined) {
	              autoPullEnabled = false;
	              autoPullIntervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS;
	              return;
	            }
	            autoPullEnabled = entry.enabled;
	            autoPullIntervalMs = assertAutoPullIntervalMs(entry.intervalMs);
	          };

	          const persistAutoPullToStorage = () => {
	            const key = computeAutoPullScopeKey();
	            if (key === null || key !== autoPullScopeKey) {
	              throw new Error(
	                'Auto-pull preferences require the current exact cache scope'
	              );
	            }
	            const prefs = readAutoPullPrefs();
	            prefs[key] = {
	              enabled: autoPullEnabled,
	              intervalMs: assertAutoPullIntervalMs(autoPullIntervalMs)
	            };
	            writeAutoPullPrefs(prefs);
	          };

          const stopAutoPull = () => {
            if (!autoPullTimer) return;
            clearInterval(autoPullTimer);
            autoPullTimer = null;
            autoPullTimerMs = 0;
          };

          const toRepoFullName = (repoRef) => {
            if (repoRef === null) return null;
            const parsed = parseOwnerRepo(repoRef);
            if (parsed === null) {
              throw new Error(
                'Connected annotation repository must use the exact owner/repo[@branch] representation'
              );
            }
            return parsed.ownerRepo;
          };

          const tickAutoPull = async () => {
            if (!autoPullEnabled) return;
            if (uiStep !== 4) return;
            if (syncBusy) return;
            if (isSigningIn || isConnectingRepo || isReloadingRepos) return;
            const online = navigator.onLine !== false;
            if (!online) return;
            const authed = githubAuth.isAuthenticated();
            const repoRef =
              did && authed
                ? getAnnotationRepoForDataset(did, getEffectiveUserKey())
                : null;
            const connectedName = toRepoFullName(repoRef);
            if (!authed || !connectedName) return;
            await pullFromGitHub({ repoOverride: repoRef, quiet: true });
          };

          const ensureAutoPullTimer = () => {
            const authed = githubAuth.isAuthenticated();
            const repoRef =
              did && authed
                ? getAnnotationRepoForDataset(did, getEffectiveUserKey())
                : null;
            const connectedName = toRepoFullName(repoRef);
            const shouldRun = Boolean(autoPullEnabled && authed && connectedName && uiStep === 4);
            if (!shouldRun) {
              stopAutoPull();
              return;
            }
            const desired = assertAutoPullIntervalMs(autoPullIntervalMs);
            if (autoPullTimer && autoPullTimerMs === desired) return;
            stopAutoPull();
            autoPullTimerMs = desired;
            autoPullTimer = setInterval(() => {
              void tickAutoPull().catch((error) => {
                autoPullEnabled = false;
                autoPullCheckbox.checked = false;
                stopAutoPull();
                const message =
                  typeof error?.message === 'string' && error.message
                    ? error.message
                    : 'Automatic annotation pull failed';
                status.textContent = message;
                notifications.error(message, {
                  category: 'annotation',
                  duration: 10000,
                });
              });
            }, desired);
          };

          modalAbort.signal.addEventListener('abort', () => stopAutoPull());

          const isStepLocked = (step, { authed, connectedName }) => {
            if (step === 1) return false;
            if (!authed) return true;
            if (step === 4) return !connectedName;
            return false; // steps 2 & 3 unlocked once authed
          };

          const computeRecommendedStep = ({ authed, connectedName }) => {
            if (!authed) return 1;
            if (connectedName) return 4;
            return 2;
          };

          /** @type {number|null} */
          let uiStep = null;
          /** @type {number|null} */
          let lastUiStep = null;
          let canGoNext = false;
          let clearStatusOnStepChange = false;

          const setActiveStep = (n) => {
            const active = Math.max(1, Math.min(4, Number(n) || 1));
            for (let i = 0; i < stepEls.length; i++) {
              const elStep = stepEls[i];
              const isActive = i === active - 1;
              elStep.classList.toggle('community-annotation-step--active', isActive);
              if (isActive) elStep.setAttribute('aria-current', 'step');
              else elStep.removeAttribute('aria-current');
            }
          };

          const setStepStates = ({ authed, connectedName, activeStep }) => {
            const current = Math.max(1, Math.min(4, Number(activeStep) || 1));
            const done = (step) => {
              if (step >= current) return false;
              if (step === 1) return authed;
              if (step === 2) return authed;
              if (step === 3) return authed && Boolean(connectedName);
              return false;
            };
            for (let i = 0; i < stepEls.length; i++) {
              const step = i + 1;
              const elStep = stepEls[i];
              const isLocked = isStepLocked(step, { authed, connectedName });
              const isDone = done(step);
              elStep.classList.toggle('community-annotation-step--locked', isLocked);
              elStep.classList.toggle('community-annotation-step--done', isDone);
              elStep.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
              const num = elStep.querySelector?.('.community-annotation-step-num') || null;
              if (num) {
                const isActive = elStep.classList.contains('community-annotation-step--active');
                num.textContent = isDone && !isActive ? '✓' : String(step);
              }
            }
          };

          const disconnectGitHubSession = ({ message, notify = 'error' } = {}) => {
            const msg = String(message || 'GitHub disconnected.').trim() || 'GitHub disconnected.';
            disconnectGitHubAndAnnotationRepo({
              datasetId: did,
              message: msg,
              notify,
            });
            connectedRepoRef = null;
            lastRepoInfo = null;
            access.clearRole?.();
            repoListLoaded = false;
            installationsLoaded = false;
            installations = [];
            allRepos = [];
            selectedRepoFullName = '';
            repoGridStep2.innerHTML = '';
            repoGridStep3.innerHTML = '';
            status.textContent = msg;
            uiStep = 1;
            updateUi();
          };

          const renderRepoCards = () => {
            const base = Array.isArray(allRepos) ? allRepos : [];
            const q = String(filterInput.value || '').trim().toLowerCase();
            const reposStep2 = base;
            const reposStep3 = q ? base.filter((r) => String(r.full_name || '').toLowerCase().includes(q)) : base;
            const connected = toRepoFullName(connectedRepoRef);

            const renderGrid = (grid, { selectable }) => {
              grid.innerHTML = '';
              const source = selectable ? reposStep3 : reposStep2;
              if (!source.length) {
                grid.appendChild(el('div', { className: 'legend-help', text: '(no repos found)' }));
                return;
              }
              for (const r of source) {
                const full = String(r.full_name || '').trim();
                if (!full) continue;
                const isConnected = connected && full === connected;
                const isSelected = selectable && selectedRepoFullName && full === selectedRepoFullName;
                const cls = [
                  'community-annotation-repo-card',
                  selectable ? '' : 'community-annotation-repo-card--static',
                  isSelected ? 'community-annotation-repo-card--selected' : '',
                  isConnected ? 'community-annotation-repo-card--connected' : ''
                ].filter(Boolean).join(' ');

                const card = el('div', { className: cls, role: selectable ? 'button' : undefined, tabIndex: selectable ? '0' : undefined });
                const title = el('div', { className: 'community-annotation-repo-title', text: full });
                const meta = el('div', { className: 'community-annotation-repo-meta' });
                meta.appendChild(el('span', { className: 'community-annotation-repo-meta-main', text: r.private ? 'Private' : 'Public' }));
                const pills = el('span', { className: 'community-annotation-repo-meta-pills' });
                if (isSelected) pills.appendChild(el('span', { className: 'community-annotation-repo-meta-pill', text: 'Selected' }));
                if (isConnected) pills.appendChild(el('span', { className: 'community-annotation-repo-meta-pill', text: 'Connected' }));
                if (pills.childNodes.length) meta.appendChild(pills);
                card.appendChild(title);
                card.appendChild(meta);

                if (selectable) {
                  const select = () => {
                    selectedRepoFullName = (selectedRepoFullName === full) ? '' : full;
                    updateUi();
                  };
                  card.addEventListener('click', select);
                  card.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    select();
                  });
                }

                grid.appendChild(card);
              }
            };

            renderGrid(repoGridStep2, { selectable: false });
            renderGrid(repoGridStep3, { selectable: true });
          };

          const updateUi = () => {
            const authed = Boolean(githubAuth.isAuthenticated?.());
            const user = githubAuth.getUser?.() || null;
            const who = String(user?.login || '').trim();
            const effectiveUserKey = getEffectiveUserKey();
            const storedRepoRef = did
              ? getAnnotationRepoForDataset(did, effectiveUserKey)
              : null;
            const repoRef =
              storedRepoRef !== null ? storedRepoRef : connectedRepoRef;
            connectedRepoRef = repoRef;
            const storedRepoName = toRepoFullName(repoRef);
            const connectedName = authed ? storedRepoName : '';
            const busy = Boolean(isSigningIn || isConnectingRepo || isReloadingRepos || syncBusy);
            syncAutoPullFromStorage();

            if (selectedRepoFullName) {
              const stillExists = (Array.isArray(allRepos) ? allRepos : []).some((r) => String(r?.full_name || '').trim() === selectedRepoFullName);
              if (!stillExists) selectedRepoFullName = '';
            }

            const recommended = computeRecommendedStep({ authed, connectedName });
            if (uiStep == null) uiStep = recommended;
            uiStep = Math.max(1, Math.min(4, uiStep));
            if (isStepLocked(uiStep, { authed, connectedName })) uiStep = recommended;
            setActiveStep(uiStep);
            setStepStates({ authed, connectedName, activeStep: uiStep });

            if (clearStatusOnStepChange && uiStep !== lastUiStep && !busy) {
              status.textContent = '';
              clearStatusOnStepChange = false;
            }

            if (uiStep !== lastUiStep) {
              lastUiStep = uiStep;
              if (authed && uiStep === 2 && !isReloadingRepos) {
                // Step 2 auto-refreshes repository list.
                loadRepoList();
              }
              if (authed && uiStep === 3 && !repoListLoaded && !isReloadingRepos) {
                // Step 3 triggers a refresh only if step 2 was skipped.
                loadRepoList();
              }
            }

            const toneToClass = (tone) => {
              const t = String(tone || '').trim();
              if (t === 'ok') return 'community-annotation-status-chip--ok';
              if (t === 'danger') return 'community-annotation-status-chip--danger';
              return 'community-annotation-status-chip--warn';
            };

            datasetRow.chip.className = `community-annotation-status-chip ${toneToClass(did ? 'ok' : 'warn')}`;
            datasetRow.valueEl.textContent = did ? ` ${did}` : ' —';

            githubRow.chip.className = `community-annotation-status-chip ${toneToClass(authed ? 'ok' : 'warn')}`;
            githubRow.valueEl.textContent = authed ? (who ? ` @${who}` : ' signed in') : ' not connected';
            githubSettingsBtn.disabled = !authed;
            disconnectGitHubBtn.disabled = !authed;

            const repoTone = connectedName ? 'ok' : (storedRepoName ? 'warn' : 'warn');
            repoRow.chip.className = `community-annotation-status-chip ${toneToClass(repoTone)}`;
            repoRow.valueEl.textContent =
              connectedName ? ` ${connectedName}` : (storedRepoName && !authed ? ` ${storedRepoName} (sign in)` : ' not connected');
            disconnectRepoBtn.disabled = !(authed && connectedName);

            const showFilter = repoListLoaded && allRepos.length > 20;
            filterRow.style.display = authed && uiStep === 3 && showFilter ? '' : 'none';

            addRepoBtn.disabled = !authed;
            reloadReposBtn.disabled = !authed || isReloadingRepos;
            reloadReposBtn.setAttribute('data-loading', isReloadingRepos ? 'true' : 'false');
            reloadReposBtn.textContent = isReloadingRepos ? 'Reloading…' : 'Reload';

            const canSync = Boolean(authed && connectedName && !syncBusy);
            pullBtn.disabled = !canSync;
            publishBtn.disabled = !canSync;
            autoPullCheckbox.checked = autoPullEnabled;
            autoPullCheckbox.disabled = busy || !canSync;
            autoPullSelect.value = `${assertAutoPullIntervalMs(autoPullIntervalMs)}`;
            autoPullSelect.disabled = busy || !canSync || !autoPullEnabled;

            step1Panel.style.display = uiStep === 1 ? '' : 'none';
            step2Panel.style.display = authed && uiStep === 2 ? '' : 'none';
            step3Panel.style.display = authed && uiStep === 3 ? '' : 'none';
            syncBlock.style.display = authed && uiStep === 4 ? '' : 'none';

            if (uiStep === 1) {
              step1Help.textContent = authed
                ? 'You’re already signed in. Click Next to continue.'
                : 'Click “Continue with GitHub” to sign in. You will be redirected to GitHub and then returned here.';
              step1Actions.style.display = authed ? 'none' : '';
              step1SignInBtn.disabled = busy;
              step1SignInBtn.textContent = isSigningIn ? 'Redirecting…' : 'Continue with GitHub';
            } else {
              step1Actions.style.display = 'none';
            }

            if (authed && uiStep === 2) {
              const n = allRepos.length;
              step2Help.textContent = n
                ? `${n} repos available. Click Next to choose one, or Add repo to enable more.`
                : 'No repos available yet. Click Add repo, choose repos in GitHub, then come back (or click Reload).';
            }

            if (authed && uiStep === 3) {
              if (isReloadingRepos) {
                step3Help.textContent = 'Loading repositories…';
              } else if (repoListLoaded && allRepos.length === 0) {
                step3Help.textContent = 'No repositories available yet. Go back to step 2 to add repos, then reload.';
              } else {
                step3Help.textContent = 'Select an annotation repository to connect.';
              }
            }

            if (authed && uiStep === 3) {
              step3Selection.textContent = connectedName ? `Connected: ${connectedName}` : '';
              step3Selection.style.display = connectedName ? '' : 'none';
            }

            // Step intro content.
            const def = stepDefs[Math.max(0, Math.min(stepDefs.length - 1, uiStep - 1))] || null;
            stepIntroTitle.textContent = def?.title || '';
            stepIntroDesc.innerHTML = '';
            const parts = Array.isArray(def?.descParts) ? def.descParts : [];
            for (const part of parts) {
              if (part == null) continue;
              stepIntroDesc.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
            }

            // Wizard nav.
            stepCount.textContent = `Step ${uiStep} of ${stepDefs.length}`;
            prevBtn.disabled = busy || uiStep <= 1;

            let nextText = 'Next';
            let nextEnabled = !busy;
            if (uiStep === 1) {
              nextText = 'Next';
              nextEnabled = nextEnabled && authed;
            } else if (uiStep === 2) {
              nextText = 'Next';
              nextEnabled = nextEnabled && (Boolean(connectedName) || (repoListLoaded && allRepos.length > 0));
            } else if (uiStep === 3) {
              const selected = String(selectedRepoFullName || '').trim();
              const wantsSwitch = Boolean(connectedName && selected && selected !== connectedName);
              const needsConnect = Boolean(!connectedName);
              if (wantsSwitch || needsConnect) {
                nextText = isConnectingRepo ? (wantsSwitch ? 'Switching…' : 'Connecting…') : (wantsSwitch ? 'Switch repo' : 'Connect');
                nextEnabled = nextEnabled && Boolean(selected) && (!connectedName || selected !== connectedName);
              } else {
                nextText = 'Next';
              }
            } else if (uiStep === 4) {
              nextText = 'Done';
            }

            nextBtn.textContent = nextText;
            nextBtn.disabled = !nextEnabled;
            canGoNext = Boolean(nextEnabled);

            ensureAutoPullTimer();
            renderRepoCards();
          };

          const loadRepoList = async () => {
            if (!githubAuth.isAuthenticated()) {
              repoListLoaded = false;
              installationsLoaded = false;
              installations = [];
              allRepos = [];
              selectedRepoFullName = '';
              repoGridStep2.innerHTML = '';
              repoGridStep3.innerHTML = '';
              updateUi();
              return;
            }
            isReloadingRepos = true;
            updateUi();
            status.textContent = uiStep === 3 ? 'Loading repositories…' : '';
            try {
              const instData = await githubAuth.listInstallations();
              installations = instData.installations;
              installationsLoaded = true;
              if (!installations.length) {
                repoListLoaded = true;
                allRepos = [];
                status.textContent = 'No installations found. Install the app, choose repos, then reload.';
                return;
              }

              const repos = [];
              const seenRepoIds = new Set();
              const seenRepoNames = new Set();
              for (const inst of installations) {
                const repoData = await githubAuth.listInstallationRepos(inst.id);
                for (const repo of repoData.repositories) {
                  const nameKey = repo.full_name.toLowerCase();
                  if (
                    seenRepoIds.has(repo.id) ||
                    seenRepoNames.has(nameKey)
                  ) {
                    throw new Error(
                      `GitHub returned duplicate repository ${repo.full_name}`
                    );
                  }
                  seenRepoIds.add(repo.id);
                  seenRepoNames.add(nameKey);
                  repos.push({
                    id: repo.id,
                    full_name: repo.full_name,
                    private: repo.private,
                  });
                }
              }

              allRepos = repos.sort((a, b) => {
                if (a.full_name < b.full_name) return -1;
                if (a.full_name > b.full_name) return 1;
                return 0;
              });
              repoListLoaded = true;
              status.textContent = allRepos.length ? '' : 'No repositories available yet. Install the app and select repos, then reload.';
            } catch (err) {
              repoListLoaded = false;
              installationsLoaded = false;
              installations = [];
              allRepos = [];
              if (isWorkerOriginSecurityError(err)) {
                disconnectGitHubSession({ message: err?.message || 'Invalid GitHub worker origin.', notify: 'error' });
                return;
              }
              if (isTokenAuthFailure(err)) {
                disconnectGitHubSession({ message: 'GitHub session expired or was revoked. Please connect again.', notify: 'error' });
                return;
              }
              status.textContent = describeGitHubAuthReachabilityError(err);
            } finally {
              isReloadingRepos = false;
              updateUi();
            }
          };

          const connectSelectedRepo = async () => {
            if (!githubAuth.isAuthenticated?.()) {
              status.textContent = 'Sign in first.';
              updateUi();
              return;
            }
            if (!did) {
              status.textContent = 'Missing dataset context.';
              updateUi();
              return;
            }
            const selected = String(selectedRepoFullName || '').trim();
            const parts = selected.split('/');
            if (!selected || parts.length !== 2) {
              status.textContent = 'Select a valid repository.';
              updateUi();
              return;
            }

            status.textContent = 'Connecting…';
            isConnectingRepo = true;
            updateUi();
            try {
              const authedUserKey = toGitHubUserKey(githubAuth.getUser?.()) || null;
              const authedLogin = login || getGitHubLogin() || '';
              if (authedUserKey) {
                await ensureIdentityForUserKey({
                  userKey: authedUserKey,
                  login: authedLogin,
                  githubUserId: githubAuth.getUser?.()?.id ?? null,
                  promptIfMissing: false
                });
              }

              status.textContent = 'Pulling latest annotations…';
              const result = await pullFromGitHub({ repoOverride: selected, confirmDatasetMismatch: true });
              if (result?.ok) {
                selectedRepoFullName = '';
                status.textContent = 'Connected and up to date.';
                uiStep = 4;
              } else if (result?.cancelled) {
                status.textContent = 'Cancelled.';
              } else {
                status.textContent = syncError ? `⚠ ${syncError}` : 'Failed to connect.';
              }
            } finally {
              isConnectingRepo = false;
              updateUi();
            }
          };

          const signIn = async () => {
            if (isSigningIn) return;
            isSigningIn = true;
            status.textContent = 'Redirecting to GitHub sign-in…';
            updateUi();
            try {
              githubAuth.signIn?.();
            } catch (err) {
              isSigningIn = false;
              status.textContent = String(err?.message || 'Sign-in failed');
              updateUi();
            }
          };

          const closeModal = () => removeOwningCommunityModal(content);

          prevBtn.addEventListener('click', () => {
            const step = Number(uiStep) || 1;
            if (step === 3 || step === 4) selectedRepoFullName = '';
            if (step === 4) {
              try {
                const authedUserKey = toGitHubUserKey(githubAuth.getUser?.());
                if (did && authedUserKey) {
                  const repoRef = getAnnotationRepoForDataset(did, authedUserKey);
                  const connectedName = toRepoFullName(repoRef);
                  if (connectedName) {
                    clearAnnotationRepoForDataset(did, authedUserKey);
                    setUrlAnnotationRepo(null);
                    connectedRepoRef = null;
                    lastRepoInfo = null;
                    access.clearRole?.();
                    session.setCacheContext({ datasetId: did, repoRef: null, userId: getCacheUserId() });
                    notifications.success('Disconnected annotation repository.', { category: 'annotation', duration: 2200 });
                    render();
                  }
                }
              } catch (error) {
                status.textContent =
                  typeof error?.message === 'string' && error.message
                    ? error.message
                    : 'Unable to disconnect the annotation repository.';
                notifications.error(status.textContent, {
                  category: 'annotation',
                  duration: 8_000,
                });
                updateUi();
                return;
              }
            }
            clearStatusOnStepChange = true;
            uiStep = Math.max(1, (Number(uiStep) || 1) - 1);
            updateUi();
          });

          nextBtn.addEventListener('click', async () => {
            const step = Number(uiStep) || 1;
            const authed = Boolean(githubAuth.isAuthenticated?.());
            const storedRepoRef = did
              ? getAnnotationRepoForDataset(did, getEffectiveUserKey())
              : null;
            const repoRef =
              storedRepoRef !== null ? storedRepoRef : connectedRepoRef;
            const connectedName = toRepoFullName(repoRef);

            if (step === 1) {
              if (!authed) return;
              clearStatusOnStepChange = true;
              uiStep = 2;
              updateUi();
              return;
            }

            if (step === 2) {
              selectedRepoFullName = '';
              clearStatusOnStepChange = true;
              uiStep = 3;
              updateUi();
              return;
            }

            if (step === 3) {
              const selected = String(selectedRepoFullName || '').trim();
              if (connectedName && (!selected || selected === connectedName)) {
                selectedRepoFullName = '';
                clearStatusOnStepChange = true;
                uiStep = 4;
                updateUi();
                return;
              }
              await connectSelectedRepo();
              return;
            }

            closeModal();
          });

          step1SignInBtn.addEventListener('click', () => signIn());

          addRepoBtn.addEventListener('click', () => {
            if (!installationsLoaded) {
              if (!openExternal(appInstallUrl)) {
                status.textContent = 'Unable to open the GitHub App installation page.';
              }
              return;
            }
            const whoLogin = assertExactGitHubLogin(
              githubAuth.getUser?.()?.login,
              'Authenticated GitHub login'
            ).toLowerCase();
            const preferred =
              installations.find(
                (inst) =>
                  inst.account.login.toLowerCase() ===
                  whoLogin
              ) ?? null;
            const selectedUrl =
              preferred === null ? appInstallUrl : settingsUrl;
            if (!openExternal(selectedUrl)) {
              status.textContent = 'Unable to open the GitHub App repository settings.';
            }
          });
          reloadReposBtn.addEventListener('click', () => loadRepoList());
          filterInput.addEventListener('input', () => renderRepoCards());

          autoPullCheckbox.addEventListener('change', () => {
            try {
              syncAutoPullFromStorage();
              autoPullEnabled = autoPullCheckbox.checked;
              persistAutoPullToStorage();
              status.textContent = '';
              ensureAutoPullTimer();
              updateUi();
            } catch (error) {
              autoPullEnabled = false;
              autoPullCheckbox.checked = false;
              stopAutoPull();
              status.textContent =
                typeof error?.message === 'string' && error.message
                  ? error.message
                  : 'Unable to save auto-pull preferences';
            }
          });

          autoPullSelect.addEventListener('change', () => {
            try {
              syncAutoPullFromStorage();
              autoPullIntervalMs =
                autoPullIntervalFromSelectValue(autoPullSelect.value);
              persistAutoPullToStorage();
              status.textContent = '';
              ensureAutoPullTimer();
              updateUi();
            } catch (error) {
              autoPullEnabled = false;
              autoPullCheckbox.checked = false;
              stopAutoPull();
              status.textContent =
                typeof error?.message === 'string' && error.message
                  ? error.message
                  : 'Unable to save auto-pull preferences';
            }
          });

          pullBtn.addEventListener('click', async () => {
            pullBtn.disabled = true;
            status.textContent = 'Pulling latest annotations…';
            try {
              const promise = pullFromGitHub({});
              updateUi();
              await promise;
              status.textContent = syncError ? `⚠ ${syncError}` : 'Pulled latest annotations.';
            } finally {
              pullBtn.disabled = false;
              updateUi();
            }
          });
          publishBtn.addEventListener('click', async () => {
            publishBtn.disabled = true;
            status.textContent = 'Publishing…';
            try {
              const promise = pushToGitHub();
              updateUi();
              await promise;
              status.textContent = syncError ? `⚠ ${syncError}` : 'Publish complete.';
            } finally {
              publishBtn.disabled = false;
              updateUi();
            }
          });

          githubSettingsBtn.addEventListener('click', () => {
            if (!openExternal(settingsUrl)) {
              status.textContent = 'Unable to open GitHub App settings.';
            }
          });
          disconnectRepoBtn.addEventListener('click', () => {
            const authedUserKey = toGitHubUserKey(githubAuth.getUser?.());
            if (!did || !authedUserKey) return;
            const repoRef = getAnnotationRepoForDataset(did, authedUserKey);
            const connectedName = toRepoFullName(repoRef);
            if (!connectedName) return;
            disconnectAnnotationRepo({
              datasetId: did,
              userKey: authedUserKey,
              message: 'Disconnected annotation repository.',
              notify: 'success'
            });
            connectedRepoRef = null;
            selectedRepoFullName = '';
            lastRepoInfo = null;
            access.clearRole?.();
            status.textContent = 'Repository disconnected.';
            uiStep = 2;
            updateUi();
          });
          disconnectGitHubBtn.addEventListener('click', () => {
            disconnectGitHubSession({ message: 'GitHub disconnected.', notify: 'success' });
          });

          // Initial state.
          updateUi();

          // Convenience: after returning from GitHub (Add repo), refresh list automatically.
          window.addEventListener('focus', () => {
            if (!githubAuth.isAuthenticated?.()) return;
            if (uiStep !== 2) return;
            if (isReloadingRepos) return;
            loadRepoList();
          }, { signal: modalAbort.signal });
        }
      });

      const overlay = modalRef?.overlay || null;
      if (!overlay) return;
      const cleanup = () => {
        modalRef?.content?.__cellucidCleanup?.();
      };
      const observer = new MutationObserver(() => {
        if (resolved) {
          observer.disconnect();
          cleanup();
          return;
        }
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          cleanup();
          resolveOnce(mode === 'auth' ? Boolean(githubAuth.isAuthenticated?.()) : null);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function connectRepoFlow({ reason = null, defaultPullNow = true } = {}) {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const login = getGitHubLogin();
    const cacheUser = getCacheUserKey();
    const currentRepo = getAnnotationRepoForDataset(datasetId, cacheUser);
    return openGitHubConnectionFlow({
      mode: 'repo',
      focus: 'repo',
      reason,
      datasetId,
      cacheUser,
      login,
      currentRepo,
      defaultPullNow
    });
  }

		  async function pullFromGitHub({ repoOverride = null, quiet = false, confirmDatasetMismatch = false } = {}) {
		    if (syncBusy) return { ok: false, skipped: true };
		    syncBusy = true;
		    syncError = null;
		    const opAbort = beginActiveSyncAbortScope();
		    render();

		    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
		    if (!datasetId) {
		      syncBusy = false;
		      syncError = 'Missing dataset context.';
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
	      endActiveSyncAbortScope(opAbort);
	      render();
	      return { ok: false, error: syncError };
	    }

	    if (!githubAuth.isAuthenticated?.()) {
	      syncBusy = false;
	      syncError = 'Sign in required.';
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
	    let preserveExisting = Boolean(overrideForDifferentRepo && storedRepoRef);

		    try {
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
      const { repoInfo, datasetConfig, config, configSha, datasetId: didResolved } = await sync.validateAndLoadConfig({ datasetId });
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

      // Select one publication route before any repository mutation.
      {
        const repoLabel = requireGitHubRepositoryFullName(repoInfo);
        if (!getPublishCapability(repoInfo).canPublish) {
          const base = describeCannotPublishMessage(repoLabel);
          if (preserveExisting) {
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
            message: `${base}\nDisconnected annotation repo.`,
            notify: 'error'
          });
          fail(base);
          return { ok: false, error: base, blocked: true };
        }
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
          confirmText: 'Connect anyway'
        });
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

      const ownerRepo = requireGitHubRepositoryFullName(repoInfo);
      const branch = requireResolvedAnnotationBranch(sync);
      canonicalRepoRef = `${ownerRepo}@${branch}`;

		      // Ensure local cache key uses (datasetId, repo, branch, user) with the resolved branch.
		      session.setCacheContext({ datasetId, repoRef: canonicalRepoRef, userId });
		      throwIfActiveSyncAborted(opAbort);

		      await fileCache.init();
		      throwIfActiveSyncAborted(opAbort);

	      // -------------------------------------------------------------------
	      // 1) Pull + cache raw user + moderation files (download only changed via SHA)
	      // -------------------------------------------------------------------
		      const cacheScope = { datasetId, repoRef: canonicalRepoRef, userId };
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
		        sync.pullAllUsers({ knownShas: knownUserShas }),
		        sync.pullModerationMerges({ knownShas: knownMergeShas }),
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
	      for (const record of fetchedUserRecords) {
	        const p = record.path;
	        const sha = record.sha;
	        await fileCache.setJson({
            datasetId,
            repoRef: canonicalRepoRef,
            userId,
            path: p,
            sha,
            json: record.doc,
          });
	      }
	      throwIfActiveSyncAborted(opAbort);

      // Moderation merges (author-maintained, optional).
      const keepPaths = new Set(userPaths);
      updateProgress(60, { message: 'Checking `annotations/moderation/` (SHA)…' });
      if (moderationResult.sha) {
        keepPaths.add(moderationResult.path);
      }
      if (moderationResult.doc !== null) {
        await fileCache.setJson({
          datasetId,
          repoRef: canonicalRepoRef,
          userId,
          path: moderationResult.path,
          sha: moderationResult.sha,
          json: moderationResult.doc,
        });
      }
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

      // Repository field names are exact dataset field keys. A mismatch is a
      // contract failure, never an instruction to prune or ignore config data.
      const configuredList = datasetConfig?.fieldsToAnnotate || [];
      const configSettingsRaw = datasetConfig?.annotatableSettings || {};
      const configClosedRaw = datasetConfig?.closedFields || [];
      const catFields = (state.getFields?.() || []).filter(
        (field) => field?.kind === 'category' && field?._isDeleted !== true
      );
      const allKeys = catFields.map((field) => field.key).filter(Boolean);
      const available = new Set(allKeys);
      const missingConfigured = configuredList.filter((key) => !available.has(key));
      if (missingConfigured.length) {
        throw new Error(
          'annotations/config.json references categorical field(s) absent from this dataset: ' +
          missingConfigured.join(', ')
        );
      }
      const enabled = new Set(configuredList);

      // Apply cached moderation merges first.
      //
      // Important: do not clobber local author edits. If the user has local
      // merges in this session, treat them as authoritative until published.
      const mergesPath = 'annotations/moderation/merges.json';
      const localMerges = session.getModerationMerges();
      const hasLocalMerges = Array.isArray(localMerges) && localMerges.length > 0;
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
        if (!hasLocalMerges) {
          session.setModerationMergesFromDoc(cachedMergeEntry.json);
        }
      }

	      // Rebuild deterministically from the complete raw-file set.
	      session.rebuildMergedViewFromUserFiles(allUserDocsForSession, { preferLocalVotes: true });
	      throwIfActiveSyncAborted(opAbort);

      // Apply configured fields for this dataset (author-controlled).
      for (const key of allKeys) {
        session.setFieldAnnotated(key, enabled.has(key));
      }

      session.setAnnotatableConsensusSettingsMap(configSettingsRaw);
      session.setClosedAnnotatableFields(configClosedRaw);

      // Record (informational) which dataset + annotatable fields the user accessed.
      // This does not affect any behavior; it is just metadata in `annotations/users/ghid_<id>.json`.
      session.recordDatasetAccess({
        datasetId: didResolved || datasetId,
        fieldsToAnnotate: session.getAnnotatedFields()
      });

      session.setRemoteFileShas(remoteUserShas);
      if (configSha) session.setRemoteFileSha('annotations/config.json', configSha);
      if (moderationResult?.sha) {
        session.setRemoteFileSha(
          moderationResult.path || 'annotations/moderation/merges.json',
          moderationResult.sha
        );
      }

	      updateProgress(100, { message: 'Pull complete' });
	      throwIfActiveSyncAborted(opAbort);

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
	          lastRoleContext = `${assertExactAnnotationUserKey(
              cacheUser,
              'Role cache user'
            )}::${canonicalRepoRef}`;
	          setAnnotationRepoForDataset(
	            datasetId,
	            canonicalRepoRef,
	            cacheUser,
	            { branchMode }
	          );
	        }
	        setUrlAnnotationRepo(canonicalRepoRef);
	      }

      complete('Pulled latest annotations');
      return { ok: true, repoRef: canonicalRepoRef };
	    } catch (err) {
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

	      if (err?.code === 'ANNOTATION_SYNC_ABORTED') {
	        syncError = msg;
	        fail(msg);
	        return { ok: false, error: msg, aborted: true };
	      }

	      if (
	        err?.code === 'LOCAL_RAW_CACHE_CORRUPT' ||
	        err?.code === 'LOCAL_RAW_CACHE_UNAVAILABLE'
	      ) {
	        disconnectAnnotationRepo({
	          datasetId,
	          userKey: cacheUser,
	          message: msg,
	          notify: 'error',
	          preserveSession: true
	        });
	        fail(msg);
	        return { ok: false, error: msg, corruptedCache: true };
	      }

	      if (isWorkerOriginSecurityError(err)) {
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
	      if (!preserveExisting && (access.getRole?.() || 'unknown') === 'unknown') {
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

	      fail(msg);
	      return { ok: false, error: msg };
		    } finally {
		      endActiveSyncAbortScope(opAbort);
		      syncBusy = false;
		      render();
	    }
	  }

  async function pushToGitHub() {
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
    syncBusy = true;
    syncError = null;
    const opAbort = beginActiveSyncAbortScope();
    render();

    const trackerId = notifications.loading(`Publishing your annotations to ${repo}...`, { category: 'annotation' });

    try {
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
		      const { repoInfo } = await sync.validateAndLoadConfig({ datasetId });
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
          disconnectAnnotationRepo({
            datasetId,
            userKey: cacheUser,
            message: `${msg}\nDisconnected annotation repo.`,
            notify: 'none'
          });
          notifications.fail(trackerId, msg);
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
	          lastRoleContext = `${assertExactAnnotationUserKey(
              cacheUser,
              'Role cache user'
            )}::${canonicalRepoRef}`;
	          setAnnotationRepoForDataset(
	            datasetId,
	            canonicalRepoRef,
	            cacheUser,
	            { branchMode }
	          );
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

      let authorPayload = null;
      if (access.isAuthor()) {
        const fieldsToAnnotate = session.getAnnotatedFields();
        const annotatableSettings = session.getAnnotatableConsensusSettingsMap();
        const closedFields = session.getClosedAnnotatableFields();
        const datasetName = dataSourceManager?.getCurrentMetadata?.()?.name;
        assertConfigDocument(
          {
            version: 1,
            supportedDatasets: [
              {
                datasetId,
                name: datasetName,
                fieldsToAnnotate,
                annotatableSettings,
                closedFields,
              },
            ],
          },
          { path: '$ author config publish payload' }
        );
        const mergesDoc = session.buildModerationMergesDocument();
        assertMergesDocument(mergesDoc, {
          path: '$ author merges publish payload',
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
        });
        if (config.mode === 'direct' && config.changed) {
          session.setRemoteFileSha(config.path, config.sha);
        }

        const merges = await sync.pushModerationMerges({
          mergesDoc: authorPayload.mergesDoc,
          conflictIfRemoteShaNotEqual: expectedMergesSha,
          publicationMode,
        });
        if (merges.mode === 'direct' && merges.changed) {
          session.setRemoteFileSha(merges.path, merges.sha);
        }

        return { config, merges };
      };

      const handlePublishResult = async (result) => {
        throwIfActiveSyncAborted(opAbort);
        session.markSyncedNow();
        if (result.mode === 'direct') {
          session.setRemoteFileSha(result.path, result.sha);
        }

        const extras = await publishAuthorExtras();
        throwIfActiveSyncAborted(opAbort);

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
        });
        await handlePublishResult(result);
        return;
    } catch (err) {
      const statusCode = httpStatusOrNull(err);
      const apiPath = gitHubApiPath(err) || workerPath(err);
      let msg = String(err?.message || 'Publish failed').trim() || 'Publish failed';
      const apiSuffix = apiPath ? ` (${apiPath})` : '';

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

      if (isWorkerOriginSecurityError(err)) {
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
	      if ((access.getRole?.() || 'unknown') === 'unknown') {
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
      endActiveSyncAbortScope(opAbort);
      syncBusy = false;
      render();
    }
  }

  function render() {
    infoPopovers.closeWithin(container);
    container.innerHTML = '';
    infoPopoverSequence = 0;

    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const cacheUsername = getCacheUserKey();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUsername);
    const repoConnectedForGating = isAnnotationRepoConnected(datasetId, cacheUsername);
    if (!repoConnectedForGating) {
      const introBlock = el('div', { className: 'control-block relative' });
      const introInfo = createInfoTooltip('About community annotation', [
        'Connect an annotation repo to enable community voting and GitHub sync.',
        'Voting UI is hidden elsewhere until a repo is connected.'
      ]);
      introBlock.appendChild(createInfoLabel('Community annotation', introInfo));
      introBlock.appendChild(introInfo.tooltip);
      introBlock.appendChild(el('div', { className: 'legend-help', text: 'No annotation repo connected.' }));

      const actions = el('div', { className: 'community-annotation-suggestion-actions' });
      const connectBtn = el('button', { type: 'button', className: 'btn-small', text: 'Connect repo' });
      connectBtn.addEventListener('click', () => connectRepoFlow({ reason: null, defaultPullNow: true }));
      actions.appendChild(connectBtn);
      introBlock.appendChild(actions);
      container.appendChild(introBlock);
      return;
    }

    const introBlock = el('div', { className: 'control-block relative' });
    const introInfo = createInfoTooltip('About community voting', [
      'Offline-first: votes/suggestions are saved locally first.',
      'Annotatable columns are chosen by repo authors (maintain/admin) via the annotation repo config.',
      'Connecting an annotation repo is required to participate (voting UI is hidden otherwise).',
      'Pull/Publish to GitHub is optional after connecting.'
    ]);
    introBlock.appendChild(createInfoLabel('Community voting', introInfo));
    introBlock.appendChild(introInfo.tooltip);
    container.appendChild(introBlock);

    // GitHub sync
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const isAuthed = githubAuth.isAuthenticated();
    const authedUser = githubAuth.getUser();
    const login =
      authedUser === null
        ? ''
        : assertExactGitHubLogin(authedUser.login, 'Authenticated GitHub login');
    const syncBlock = el('div', { className: 'control-block relative' });
    const syncInfo = createInfoTooltip('About GitHub annotation sync', [
      'Open GitHub sync to sign in, install the app, pick a repo, and pull/publish.',
      'Your sign-in token is stored only in sessionStorage (clears on tab close).',
      'The GitHub App has no repo access by default; you choose which repos to enable.'
    ]);
    syncBlock.appendChild(createInfoLabel('GitHub sync', syncInfo));
    syncBlock.appendChild(syncInfo.tooltip);

    const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
    const icon = (d, { viewBox = '0 0 24 24' } = {}) => {
      const svg = svgEl('svg');
      svg.setAttribute('viewBox', viewBox);
      svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('community-annotation-status-icon');
      const path = svgEl('path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      return svg;
    };

    const datasetIcon = icon('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 6c0 1.7 3.6 3 8 3s8-1.3 8-3m-16 6c0 1.7 3.6 3 8 3s8-1.3 8-3');
    const githubIcon = icon('M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 9a8 8 0 0 1 16 0');
    const repoIcon = icon('M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM8 8h8M8 12h8M8 16h6');
    const copyIcon = icon('M8 8h12v12H8zM4 4h12v12H4z');

    const toneClass = (tone) => {
      if (tone === 'ok') return 'community-annotation-status-chip community-annotation-status-chip--ok';
      if (tone === 'danger') return 'community-annotation-status-chip community-annotation-status-chip--danger';
      return 'community-annotation-status-chip community-annotation-status-chip--warn';
    };

    const makeStatusRow = ({ iconEl, tone = 'warn', key = '', value = '', actions = [] } = {}) => {
      const keyEl = el('span', { className: 'community-annotation-status-key', text: key || '' });
      const valueEl = el('span', { className: 'community-annotation-status-val', text: value || '' });
      const textEl = el('div', { className: 'community-annotation-status-text' }, [keyEl, valueEl]);
      const chip = el('div', { className: toneClass(tone) }, [iconEl || null, textEl]);
      const rowChildren = [chip];
      if (Array.isArray(actions) && actions.length) {
        rowChildren.push(el('div', { className: 'community-annotation-status-actions' }, actions));
      }
      return el('div', { className: 'community-annotation-status-row' }, rowChildren);
    };

    const storedRepoName = repo ? String(repo).split('@')[0] : '';
    const connectedName = isAuthed ? storedRepoName : '';

    const copyShareLinkBtn = (() => {
      if (!repo) return null;
      const btn = el('button', {
        type: 'button',
        className: 'community-annotation-status-action',
        title: 'Copy share link (includes @branch)',
        'aria-label': 'Copy share link'
      }, [copyIcon]);
      btn.disabled = syncBusy;
      btn.addEventListener('click', async () => {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('annotations', String(repo).trim());
          const ok = await copyTextToClipboard(url.toString());
          if (ok) notifications.success('Share link copied.', { category: 'annotation', duration: 2200 });
          else notifications.error('Unable to copy share link.', { category: 'annotation', duration: 3500 });
        } catch (error) {
          notifications.error('Unable to copy share link.', { category: 'annotation', duration: 3500 });
          throw error;
        }
      });
      return btn;
    })();

    const statusList = el('div', { className: 'community-annotation-status-list community-annotation-status-panel community-annotation-dashed-box community-annotation-dashed-box--prose' });
    statusList.appendChild(makeStatusRow({
      iconEl: datasetIcon,
      tone: datasetId ? 'ok' : 'warn',
      key: 'Dataset',
      value: datasetId ? ` ${datasetId}` : ' —',
      actions: []
    }));
    statusList.appendChild(makeStatusRow({
      iconEl: githubIcon,
      tone: isAuthed ? 'ok' : 'warn',
      key: 'GitHub',
      value: isAuthed ? (login ? ` @${login}` : ' signed in') : ' not connected',
      actions: []
    }));
    statusList.appendChild(makeStatusRow({
      iconEl: repoIcon,
      tone: connectedName ? 'ok' : 'warn',
      key: 'Repo',
      value: connectedName ? ` ${connectedName}` : (storedRepoName && !isAuthed ? ` ${storedRepoName} (sign in)` : ' not connected'),
      actions: copyShareLinkBtn ? [copyShareLinkBtn] : []
    }));

    syncBlock.appendChild(statusList);

    if (!online) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: 'Offline: GitHub actions are disabled.' }));
    }

    if (syncError) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: `⚠ ${syncError}` }));
    }

    const syncActions = el('div', { className: 'community-annotation-sync-actions' });
    const openBtnText = !isAuthed ? 'Connect GitHub…' : (!repo ? 'Choose repo…' : 'GitHub sync…');
    const openSyncBtn = el('button', { type: 'button', className: 'btn-small', text: openBtnText });
    openSyncBtn.disabled = syncBusy || !online;
    openSyncBtn.addEventListener('click', () => {
      openGitHubConnectionFlow({
        mode: 'repo',
        focus: 'overview',
        reason: null,
        datasetId,
        cacheUser: cacheUsername,
        login,
        currentRepo: repo,
        defaultPullNow: true
      });
    });
    syncActions.appendChild(openSyncBtn);
    syncBlock.appendChild(syncActions);

    // Keep the panel minimal unless a repo is connected (or dev-simulated).
    // This avoids showing lots of offline controls that depend on repo config/roles.
    if (!repoConnectedForGating) {
      container.appendChild(syncBlock);
      return;
    }

    // Community annotation internal accordions:
    // - closed by default
    // - only one open at a time
    const accordionPeers = [];
    const registerAccordionPeer = (key, itemEl, headerEl) => {
      if (!key || !itemEl || !headerEl) return;
      accordionPeers.push({ key, itemEl, headerEl });
    };
    const syncAccordionPeers = () => {
      for (const { key, itemEl, headerEl } of accordionPeers) {
        const isOpen = openAccordionKey === key;
        itemEl.classList.toggle('open', isOpen);
        headerEl.setAttribute('aria-expanded', String(isOpen));
      }
    };
    const toggleAccordionPeer = (key) => {
      openAccordionKey = (openAccordionKey === key) ? null : key;
      syncAccordionPeers();
    };

    container.appendChild(syncBlock);

    const consensusBlock = el('div', { className: 'control-block relative' });

    const catFieldsForConsensus = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
    const allKeysForConsensus = catFieldsForConsensus.map((f) => f.key).filter(Boolean);
    const annotatableKeysForConsensus = session.getAnnotatedFields().filter((k) => allKeysForConsensus.includes(k));
    if (!consensusSourceFieldKey || !annotatableKeysForConsensus.includes(consensusSourceFieldKey)) {
      consensusSourceFieldKey = annotatableKeysForConsensus[0] || null;
    }

    const accordion = el('div', { className: 'analysis-accordion' });
    const consensusAccordionKey = 'consensus-column';
    const item = el('div', { className: `analysis-accordion-item${openAccordionKey === consensusAccordionKey ? ' open' : ''}` });
    const header = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(openAccordionKey === consensusAccordionKey)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'DERIVED CONSENSUS COLUMN' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Optional: build an obs column from current votes' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const content = el('div', { className: 'analysis-accordion-content' });

    registerAccordionPeer(consensusAccordionKey, item, header);
    const toggleOpen = () => toggleAccordionPeer(consensusAccordionKey);
    header.addEventListener('click', () => toggleOpen());
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleOpen();
      }
    });

    // Source annotatable column selector
    const srcWrap = el('div', { className: 'field-select relative' });
    const consensusInfo = createInfoTooltip('About derived consensus columns', [
      'This does not change the voting rules or publish anything to GitHub.',
      'It only creates/updates a local derived obs column in the dataset for visualization.',
      'Each cluster becomes: a consensus label, Disputed, or Pending.'
    ]);
    srcWrap.appendChild(createInfoLabel('Annotatable column:', consensusInfo));
    srcWrap.appendChild(consensusInfo.tooltip);
    const srcSelect = el('select', { className: 'obs-select' });
    if (!annotatableKeysForConsensus.length) {
      srcSelect.appendChild(el('option', { value: '', text: '(no annotatable columns)' }));
      srcSelect.disabled = true;
    } else {
      for (const k of annotatableKeysForConsensus) srcSelect.appendChild(el('option', { value: k, text: k }));
      srcSelect.value = consensusSourceFieldKey || annotatableKeysForConsensus[0];
      srcSelect.addEventListener('change', () => {
        consensusSourceFieldKey = toCleanString(srcSelect.value) || null;
      });
    }
    srcWrap.appendChild(srcSelect);
    content.appendChild(srcWrap);

    // Consensus column key
    const consensusKeyWrap = el('div', { className: 'field-select' });
    consensusKeyWrap.appendChild(el('label', { text: 'New column key:' }));
    const consensusKeyInput = el('input', {
      type: 'text',
      className: 'community-annotation-text-input community-annotation-input',
      placeholder: 'community_cell_type'
    });
    consensusKeyInput.value = consensusColumnKey;
    consensusKeyInput.addEventListener('change', () => {
      consensusColumnKey = String(consensusKeyInput.value || '').trim();
    });
    consensusKeyWrap.appendChild(consensusKeyInput);
    content.appendChild(consensusKeyWrap);

    // Consensus threshold + min annotators
    const consensusSettings = el('div', { className: 'control-block community-annotation-settings' });
    const thresholdLabel = el('label', { text: 'Consensus threshold:' });
    const thresholdInput = el('input', {
      type: 'range',
      min: '-100',
      max: '100',
      step: '1',
      value: thresholdToSliderValue(consensusColumnThreshold)
    });
    const thresholdDisplay = el('span', { className: 'slider-value', text: formatPctSigned11(consensusColumnThreshold) });
    thresholdInput.addEventListener('input', () => {
      consensusColumnThreshold = sliderValueToThreshold(thresholdInput.value);
      thresholdDisplay.textContent = formatPctSigned11(consensusColumnThreshold);
    });
    const thresholdRow = el('div', { className: 'slider-row' }, [thresholdInput, thresholdDisplay]);
    consensusSettings.appendChild(thresholdLabel);
    consensusSettings.appendChild(thresholdRow);

    const minLabel = el('label', { text: 'Min annotators:' });
    const minInput = el('input', {
      type: 'number',
      className: 'obs-select',
      value: String(consensusColumnMinAnnotators),
      min: '0',
      max: '50',
      step: '1'
    });
    minInput.addEventListener('change', () => {
      consensusColumnMinAnnotators = clampInt(Number(minInput.value), 0, 50);
      minInput.value = String(consensusColumnMinAnnotators);
    });
    consensusSettings.appendChild(minLabel);
    consensusSettings.appendChild(minInput);
    content.appendChild(consensusSettings);

    const applyActions = el('div', { className: 'community-annotation-consensus-actions' });
    const applyBtn = el('button', { type: 'button', className: 'btn-small', text: 'Build derived column' });
    applyBtn.disabled = syncBusy || !consensusSourceFieldKey;
    applyBtn.addEventListener('click', () => applyConsensusColumn());
    applyActions.appendChild(applyBtn);
    content.appendChild(applyActions);

    item.appendChild(header);
    item.appendChild(content);
    accordion.appendChild(item);
    consensusBlock.appendChild(accordion);

    // Profile (asked once per GitHub username; editable)
    const profile = session.getProfile();
	    const identityBlock = el('div', { className: 'control-block relative' });
	    const identityInfo = createInfoTooltip('About annotation profiles', [
	      'Profile fields are optional and saved locally (like votes) until you Publish.',
	      'Publish writes them into your GitHub user file; Pull reloads them from GitHub.',
	      'Your GitHub username comes from sign-in.'
	    ]);
    identityBlock.appendChild(createInfoLabel('Profile (optional)', identityInfo));
    identityBlock.appendChild(identityInfo.tooltip);

    const authedLogin = getGitHubLogin();
    // Allow editing when signed in OR when dev override is enabled
    const canEdit = Boolean(githubAuth.isAuthenticated?.() && authedLogin) || isSimulateRepoConnectedEnabled();
    const profileBox = el('div', { className: 'community-annotation-dashed-box community-annotation-profile-box' });
    const addProfileRow = (key, value) => {
      profileBox.appendChild(el('div', { className: 'community-annotation-profile-row' }, [
        el('span', { className: 'community-annotation-profile-key', text: String(key || '') }),
        el('span', { className: 'community-annotation-profile-val', text: String(value || '') })
      ]));
    };
    addProfileRow('GitHub', githubAuth.isAuthenticated?.() ? 'connected' : 'not connected');
    addProfileRow('User', `@${authedLogin || 'local'}`);
    if (profile?.displayName) addProfileRow('Name', profile.displayName);
    if (profile?.title) addProfileRow('Title', profile.title);
    if (profile?.orcid) addProfileRow('ORCID', profile.orcid);
    if (profile?.linkedin) addProfileRow('LinkedIn', profile.linkedin);
    identityBlock.appendChild(profileBox);

    const identityActions = el('div', { className: 'community-annotation-identity-actions' });
    const editBtn = el('button', { type: 'button', className: 'btn-small', text: 'Edit' });
    const clearBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear' });
    identityActions.appendChild(editBtn);
    identityActions.appendChild(clearBtn);
    identityBlock.appendChild(identityActions);

    editBtn.disabled = !canEdit || syncBusy;
    clearBtn.disabled = !canEdit || syncBusy;
    editBtn.title = editBtn.disabled ? 'Sign in first.' : 'Edit your attribution info (published in your GitHub user file).';
    clearBtn.title = clearBtn.disabled ? 'Sign in first.' : 'Clear your profile fields (Publish to update GitHub).';

	    editBtn.addEventListener('click', async () => {
	      if (!canEdit) return;
	      const loginOrLocal = authedLogin || 'local';
	      await ensureIdentityForUserKey({ userKey: getCacheUserKey(), login: loginOrLocal, githubUserId: githubAuth.getUser?.()?.id ?? null, promptIfMissing: false });
	      await editIdentityFlow({ suggestedUsername: loginOrLocal });
	      render();
	    });

    clearBtn.addEventListener('click', async () => {
      if (!canEdit) return;
      const loginOrLocal = authedLogin || 'local';
      const ok = await confirmAsync({
        title: 'Clear profile?',
        message: `Clear your profile fields for @${loginOrLocal} in this session?\n\nPublish to update your GitHub user file.`,
        confirmText: 'Clear'
      });
      if (!ok) return;
      session.setProfile({ ...profile, login: loginOrLocal, displayName: '', title: '', orcid: '', linkedin: '' });
      render();
	    });

	    container.appendChild(identityBlock);
	    // Collapsibles are appended at the bottom of this section.

	    // ─────────────────────────────────────────────────────────────────────────
	    // MANAGE ANNOTATION - author-only when connected to a repo
	    // ─────────────────────────────────────────────────────────────────────────
	    const annotated = session.getAnnotatedFields();
    const catFields = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
    const allKeys = catFields.map((f) => f.key).filter(Boolean);
    if (!selectedFieldKey || !allKeys.includes(selectedFieldKey)) {
      const active = state.getActiveField?.() || null;
      selectedFieldKey = active?.kind === 'category' && active?.key ? active.key : (allKeys[0] || null);
    }

    const hasSelection = Boolean(selectedFieldKey);
    const canManageAnnotatable = hasSelection && access.isAuthor();
    const role = access.getEffectiveRole?.() || access.getRole?.() || 'unknown';

    const manageBlock = el('div', { className: 'control-block relative' });

    const manageAccordionKey = 'manage';
    const manageAccordion = el('div', { className: 'analysis-accordion' });
    const manageItem = el('div', { className: `analysis-accordion-item${openAccordionKey === manageAccordionKey ? ' open' : ''}` });
    const manageHeaderBtn = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(openAccordionKey === manageAccordionKey)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'MANAGE ANNOTATION' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Add/remove columns from annotation (author)' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const manageContent = el('div', { className: 'analysis-accordion-content' });

    registerAccordionPeer(manageAccordionKey, manageItem, manageHeaderBtn);

    const toggleManageOpen = () => toggleAccordionPeer(manageAccordionKey);
    manageHeaderBtn.addEventListener('click', () => toggleManageOpen());
    manageHeaderBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleManageOpen();
      }
    });

	    if (role !== 'author') {
	      const msg = role === 'unknown'
	        ? 'Role: unknown (checking repo permissions). If this cannot be resolved, the repo will be disconnected.'
	        : `Role: ${role}. Only authors (maintain/admin) can change repo annotation settings.`;
	      manageContent.appendChild(el('div', { className: 'legend-help', text: msg }));
	    }

    manageContent.appendChild(el('div', {
      className: 'legend-help',
      text: 'Add or remove categorical columns from the annotation list. When connected to a repo, only authors can change this.'
    }));

      // Field selector dropdown
      const fieldSelectWrap = el('div', { className: 'field-select' });
      fieldSelectWrap.appendChild(el('label', { text: 'Categorical obs:' }));
      const fieldSelect = el('select', { className: 'obs-select' });
      fieldSelect.appendChild(el('option', { value: '', text: allKeys.length ? 'None' : '(no categorical obs fields)' }));
      for (const key of allKeys) {
        const enabled = annotated.includes(key);
        const closed = enabled ? Boolean(session.isFieldClosed(key)) : false;
        const prefix = enabled ? (closed ? '🗳️🏁 ' : '🗳️ ') : '';
        fieldSelect.appendChild(el('option', { value: key, text: prefix ? `${prefix}${key}` : key }));
      }
      if (selectedFieldKey) fieldSelect.value = selectedFieldKey;
      fieldSelect.addEventListener('change', () => {
        selectedFieldKey = fieldSelect.value || null;
        render();
      });
      fieldSelectWrap.appendChild(fieldSelect);
      manageContent.appendChild(fieldSelectWrap);

      const manageActions = el('div', { className: 'community-annotation-consensus-actions', 'aria-label': 'Manage annotation actions' });

      const lockedReason = !hasSelection
        ? 'Select a categorical obs field first.'
        : (repoConnectedForGating && !access.isAuthor() ? 'Author (maintain/admin) required.' : '');
      const addBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add', title: lockedReason || 'Mark this column as annotatable', disabled: !canManageAnnotatable });
      const removeBtn = el('button', { type: 'button', className: 'btn-small', text: 'Remove', title: lockedReason || 'Remove this column from annotation', disabled: !canManageAnnotatable });
      const isAnnotatable = hasSelection && annotated.includes(selectedFieldKey);
      const isClosed = isAnnotatable ? Boolean(session.isFieldClosed(selectedFieldKey)) : false;
      const closeBtn = isAnnotatable
        ? el('button', {
          type: 'button',
          className: 'btn-small',
          text: isClosed ? 'Reopen' : 'Close',
          title: isClosed ? 'Reopen this annotatable column for community voting.' : 'Close this annotatable column (voting disabled for annotators).',
          disabled: repoConnectedForGating && !access.isAuthor()
        })
        : null;

      addBtn.addEventListener('click', () => {
        if (!selectedFieldKey) return;
        if (repoConnectedForGating && !access.isAuthor()) return;
        if (annotated.includes(selectedFieldKey)) {
          notifications.error(`"${selectedFieldKey}" is already in annotation list`, { category: 'annotation', duration: 2200 });
          return;
        }
        session.setFieldAnnotated(selectedFieldKey, true);
        notifications.success(`Added "${selectedFieldKey}" to annotation`, { category: 'annotation', duration: 2200 });
        render();
      });

      removeBtn.addEventListener('click', () => {
        if (!selectedFieldKey) return;
        if (repoConnectedForGating && !access.isAuthor()) return;
        if (!annotated.includes(selectedFieldKey)) {
          notifications.error(`"${selectedFieldKey}" is not in annotation list`, { category: 'annotation', duration: 2200 });
          return;
        }
        session.setFieldAnnotated(selectedFieldKey, false);
        notifications.success(`Removed "${selectedFieldKey}" from annotation`, { category: 'annotation', duration: 2200 });
        render();
      });

      manageActions.appendChild(addBtn);
      manageActions.appendChild(removeBtn);
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          if (!selectedFieldKey) return;
          if (repoConnectedForGating && !access.isAuthor()) return;
          const next = !Boolean(session.isFieldClosed(selectedFieldKey));
          session.setFieldClosed(selectedFieldKey, next);
          notifications.success(next ? `Closed "${selectedFieldKey}"` : `Reopened "${selectedFieldKey}"`, { category: 'annotation', duration: 2200 });
          render();
        });
        manageActions.appendChild(closeBtn);
      }
      manageContent.appendChild(manageActions);

      // Per-annotatable voting consensus settings (author-controlled, per field; only shown once the field is annotatable).
      if (isAnnotatable) {
        const info = createInfoTooltip('About consensus settings', [
          'These settings control the voting consensus for this annotatable column (per column).',
          'Changes are staged locally until you click Apply; Publish (as author) writes them to annotations/config.json.'
        ]);

        const block = el('div', { className: 'control-block community-annotation-settings relative' });
        block.appendChild(el('div', { className: 'd-flex items-center gap-1' }, [
          el('div', { className: 'legend-help', text: 'Annotatable consensus settings' }),
          info.btn
        ]));
        block.appendChild(info.tooltip);

        const canEditSettings = !repoConnectedForGating || access.isAuthor();
        const applied = session.getAnnotatableConsensusSettings(selectedFieldKey);
        if (!applied) {
          throw new Error(
            `Missing consensus settings for annotatable field ${JSON.stringify(selectedFieldKey)}`
          );
        }
        if (!annotatableSettingsDraft[selectedFieldKey]) {
          annotatableSettingsDraft[selectedFieldKey] = { ...applied };
        }
        const draft = annotatableSettingsDraft[selectedFieldKey];

        const thLabel = el('label', { text: 'Threshold:' });
        const thInput = el('input', {
          type: 'range',
          min: '-100',
          max: '100',
          step: '1',
          value: thresholdToSliderValue(draft.threshold),
          disabled: !canEditSettings
        });
        const thDisplay = el('span', { className: 'slider-value', text: formatPctSigned11(clampConsensusThreshold11(Number(draft.threshold))) });
        thInput.addEventListener('input', () => {
          const v = sliderValueToThreshold(thInput.value);
          thDisplay.textContent = formatPctSigned11(v);
        });
        thInput.addEventListener('change', () => {
          if (!canEditSettings) return;
          const v = sliderValueToThreshold(thInput.value);
          annotatableSettingsDraft[selectedFieldKey] = { ...annotatableSettingsDraft[selectedFieldKey], threshold: v };
          annotatableSettingsDirty.add(selectedFieldKey);
          render();
        });
        block.appendChild(thLabel);
        block.appendChild(el('div', { className: 'slider-row' }, [thInput, thDisplay]));

        const minLabel = el('label', { text: 'Min annotators:' });
        const minInput = el('input', {
          type: 'number',
          className: 'obs-select',
          value: String(draft.minAnnotators),
          min: '0',
          max: '50',
          step: '1',
          disabled: !canEditSettings
        });
        minInput.addEventListener('change', () => {
          if (!canEditSettings) return;
          const nextMin = clampInt(Number(minInput.value), 0, 50);
          minInput.value = String(nextMin);
          annotatableSettingsDraft[selectedFieldKey] = { ...annotatableSettingsDraft[selectedFieldKey], minAnnotators: nextMin };
          annotatableSettingsDirty.add(selectedFieldKey);
          render();
        });
        block.appendChild(minLabel);
        block.appendChild(minInput);

        const actions = el('div', { className: 'community-annotation-consensus-actions', 'aria-label': 'Annotatable consensus settings actions' });
        const apply = el('button', { type: 'button', className: 'btn-small', text: 'Apply', disabled: !canEditSettings || !annotatableSettingsDirty.has(selectedFieldKey) });
        const reset = el('button', { type: 'button', className: 'btn-small', text: 'Reset', disabled: !canEditSettings || !annotatableSettingsDirty.has(selectedFieldKey) });
        apply.addEventListener('click', () => {
          if (!canEditSettings) return;
          const next = annotatableSettingsDraft[selectedFieldKey] || applied;
          session.setAnnotatableConsensusSettings(selectedFieldKey, next);
          annotatableSettingsDirty.delete(selectedFieldKey);
          notifications.success('Consensus settings applied (local)', { category: 'annotation', duration: 1800 });
          render();
        });
        reset.addEventListener('click', () => {
          if (!canEditSettings) return;
          annotatableSettingsDraft[selectedFieldKey] = { ...applied };
          annotatableSettingsDirty.delete(selectedFieldKey);
          render();
        });
        actions.appendChild(apply);
        actions.appendChild(reset);
        block.appendChild(actions);

        manageContent.appendChild(block);
      }

    manageItem.appendChild(manageHeaderBtn);
    manageItem.appendChild(manageContent);
    manageAccordion.appendChild(manageItem);
    manageBlock.appendChild(manageAccordion);

    // ─────────────────────────────────────────────────────────────────────────
    // CONSENSUS SNAPSHOT + LOCAL CACHE (one collapsible)
    // ─────────────────────────────────────────────────────────────────────────
    const exportsCacheBlock = el('div', { className: 'control-block relative' });

    const exportsAccordionKey = 'exports-cache';
    const exportsAccordion = el('div', { className: 'analysis-accordion' });
    const exportsItem = el('div', { className: `analysis-accordion-item${openAccordionKey === exportsAccordionKey ? ' open' : ''}` });
    const exportsHeaderBtn = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(openAccordionKey === exportsAccordionKey)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'CONSENSUS SNAPSHOT + LOCAL CACHE' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Download cellucid-consensus.json and manage local cache' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const exportsContent = el('div', { className: 'analysis-accordion-content' });

    registerAccordionPeer(exportsAccordionKey, exportsItem, exportsHeaderBtn);
    const toggleExportsOpen = () => toggleAccordionPeer(exportsAccordionKey);
    exportsHeaderBtn.addEventListener('click', () => toggleExportsOpen());
    exportsHeaderBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleExportsOpen();
      }
    });

    // Consensus snapshot (cellucid-consensus.json)
    const consensusDownloadBlock = el('div', { className: 'control-block relative' });
    const consensusDownloadInfo = createInfoTooltip('About consensus snapshots', [
      'Downloads a cellucid-consensus.json snapshot of the current merged view.',
      'Tip: Pull first to refresh the locally cached raw files from GitHub.',
      'This is generated in your browser and is never written back to GitHub.'
    ]);
    consensusDownloadBlock.appendChild(createInfoLabel(
      'Consensus snapshot (cellucid-consensus.json)',
      consensusDownloadInfo
    ));
    consensusDownloadBlock.appendChild(consensusDownloadInfo.tooltip);
    const consensusDownloadActions = el('div', { className: 'community-annotation-cache-actions', 'aria-label': 'Consensus snapshot actions' });
    const downloadBtn = el('button', { type: 'button', className: 'btn-small', text: 'Download', disabled: syncBusy });
    downloadBtn.title = 'Download cellucid-consensus.json';
    downloadBtn.addEventListener('click', () => {
      try {
        const doc = session.buildConsensusDocument({ includeComments: false, includeMergedFrom: false });
        if (!doc) throw new Error('Consensus snapshot unavailable');
        downloadJsonAsFile(CONSENSUS_SNAPSHOT_FILENAME, doc);
        notifications.success(
          `Downloaded ${CONSENSUS_SNAPSHOT_FILENAME}`,
          { category: 'annotation', duration: 2200 }
        );
      } catch (err) {
        notifications.error(err?.message || 'Failed to build cellucid-consensus.json', { category: 'annotation', duration: 6000 });
      }
    });
    consensusDownloadActions.appendChild(downloadBtn);
    consensusDownloadBlock.appendChild(consensusDownloadActions);
    exportsContent.appendChild(consensusDownloadBlock);

    // Local cache
    const cacheBlock = el('div', { className: 'control-block relative' });
    const cacheInfo = createInfoTooltip('About local annotation data', [
      'Session state stores your local votes/suggestions/comments until you Publish.',
      'Downloaded files cache stores raw GitHub files (annotations/users/* and optional annotations/moderation/merges.json) to speed up Pull.',
      'Clearing caches never writes anything to GitHub.'
    ]);
    cacheBlock.appendChild(createInfoLabel('Local cache', cacheInfo));
    cacheBlock.appendChild(cacheInfo.tooltip);

    const cacheActions = el('div', { className: 'community-annotation-cache-actions', 'aria-label': 'Local cache actions' });
    const clearSessionBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear session', disabled: syncBusy });
    clearSessionBtn.addEventListener('click', async () => {
      const ok = await confirmAsync({
        title: 'Clear local session?',
        message: 'This clears your local session state (votes, suggestions, comments, and annotatable-column selections) for the current dataset/repo/branch in this browser.',
        confirmText: 'Clear session'
      });
      if (!ok) return;
      session.clearLocalCache({ keepVotingMode: false });
      notifications.success('Local session cleared', { category: 'annotation', duration: 2200 });
      render();
    });

    const cacheDatasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const cacheUser = getCacheUserKey();
    const cacheUserId = getCacheUserId();
    const repoRef = getAnnotationRepoForDataset(cacheDatasetId, cacheUser) || null;
    const clearFilesBtn = el('button', {
      type: 'button',
      className: 'btn-small',
      text: 'Clear downloads',
      disabled: syncBusy || !(cacheDatasetId && repoRef && cacheUserId)
    });
    clearFilesBtn.addEventListener('click', async () => {
      if (!cacheDatasetId || !repoRef || !cacheUserId) return;
      const ok = await confirmAsync({
        title: 'Clear downloaded files?',
        message:
          `This clears locally cached copies of raw files under annotations/users/ and annotations/moderation/.\n\n` +
          `Tip: Pull again to re-download what you need.`,
        confirmText: 'Clear downloads'
      });
      if (!ok) return;
      await fileCache.clearRepo({ datasetId: cacheDatasetId, repoRef, userId: cacheUserId });
      notifications.success('Downloaded file cache cleared', { category: 'annotation', duration: 2200 });
      render();
    });

    cacheActions.appendChild(clearSessionBtn);
    cacheActions.appendChild(clearFilesBtn);
    cacheBlock.appendChild(cacheActions);
    exportsContent.appendChild(cacheBlock);

    exportsItem.appendChild(exportsHeaderBtn);
    exportsItem.appendChild(exportsContent);
    exportsAccordion.appendChild(exportsItem);
    exportsCacheBlock.appendChild(exportsAccordion);

    // Collapsibles: always at the bottom of the section.
    container.appendChild(manageBlock);
    container.appendChild(consensusBlock);
    container.appendChild(exportsCacheBlock);
    syncAccordionPeers();

    // Popup handles per-category voting/suggestions; keep the sidebar compact.
  }

  render();

  return { render, destroy };
}
