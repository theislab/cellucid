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
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { getUrlAnnotationRepo, setUrlAnnotationRepo } from '../../url-state.js';
import { getGitHubAuthSession, getGitHubLoginUrl } from '../../community-annotations/github-auth.js';
import { getCommunityAnnotationAccessStore, isSimulateRepoConnectedEnabled } from '../../community-annotations/access-store.js';
import {
  clearAnnotationRepoForDataset,
  getAnnotationRepoForDataset,
  setAnnotationRepoForDataset
} from '../../community-annotations/repo-store.js';
import {
  CommunityAnnotationGitHubSync,
  getGitHubSyncForDataset,
  parseOwnerRepo,
  setDatasetAnnotationRepoFromUrlParam
} from '../../community-annotations/github-sync.js';

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

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, n));
}

function formatPct01(value) {
  const v = Number.isFinite(value) ? value : 0;
  return `${Math.round(v * 100)}%`;
}

function findCategoricalFieldByKey(state, fieldKey) {
  const fields = state.getFields?.() || [];
  return fields.find((f) => f?.kind === 'category' && f?.key === fieldKey) || null;
}

function computeProgress(session, fieldKey, categories) {
  const n = Array.isArray(categories) ? categories.length : 0;
  if (!fieldKey || n <= 0) return { done: 0, total: Math.max(0, n) };
  let done = 0;
  for (let i = 0; i < n; i++) {
    const c = session.computeConsensus(fieldKey, i);
    if (c.status === 'consensus') done++;
  }
  return { done, total: n };
}

function showClusterModal({ title, buildContent }) {
  const existing = document.querySelector('.community-annotation-modal-overlay');
  if (existing) existing.remove();

  const overlay = el('div', { className: 'community-annotation-modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const modal = el('div', { className: 'community-annotation-modal', role: 'document' });

  const header = el('div', { className: 'community-annotation-modal-header' });
  header.appendChild(el('div', { className: 'community-annotation-modal-title', text: title || 'Community annotation' }));
  const closeBtn = el('button', { type: 'button', className: 'btn-small community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });
  buildContent?.(content);

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    close();
  };
  document.addEventListener('keydown', onKeyDown, { once: true });

  document.body.appendChild(overlay);
  closeBtn.focus?.();

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

function formatTimeLabel(iso) {
  const t = String(iso || '').trim();
  if (!t) return '—';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return t;
  }
}

function isAuthError(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return true;
  if (status !== 404) return false;
  const path = String(err?.github?.path || '');
  // GitHub hides private repos from anonymous requests by returning 404 on the repo itself.
  // Only treat "GET /repos/{owner}/{repo}" as an auth/access signal; 404s under /contents/* are more likely missing files.
  return /^\/repos\/[^/]+\/[^/]+$/i.test(path);
}

export function initCommunityAnnotationControls({ state, dom, dataSourceManager }) {
  const container = dom?.container || null;
  if (!container) return {};

  const session = getCommunityAnnotationSession();
  const access = getCommunityAnnotationAccessStore();

  const notifications = getNotificationCenter();
  const githubAuth = getGitHubAuthSession();

  let selectedFieldKey = null;
  let consensusThreshold = 0.7;
  let minAnnotators = 3;
  let consensusColumnKey = 'community_cell_type';
  let consensusSourceFieldKey = null;
  let consensusAccordionOpen = false;

  let syncBusy = false;
  let syncError = null;
  let lastRepoInfo = null;

  const tooltipAbort = new AbortController();
  document.addEventListener('click', (e) => {
    const target = e?.target || null;
    try {
      if (target && container.contains(target)) {
        const insideTooltip = typeof target.closest === 'function' && (
          target.closest('.info-tooltip') || target.closest('.info-btn')
        );
        if (insideTooltip) return;
      }
    } catch {
      // ignore
    }
    try {
      container.querySelectorAll('.info-tooltip').forEach((node) => {
        node.style.display = 'none';
      });
    } catch {
      // ignore
    }
  }, { signal: tooltipAbort.signal });

  function createInfoTooltip(steps) {
    const btn = el('button', { type: 'button', className: 'info-btn', text: 'i', 'aria-label': 'Info' });
    const tooltip = el('div', { className: 'info-tooltip' });
    const content = el('div', { className: 'info-tooltip-content' });
    const list = Array.isArray(steps) ? steps : [];
    for (const step of list) {
      content.appendChild(el('div', { className: 'info-step', text: String(step) }));
    }
    tooltip.appendChild(content);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = getComputedStyle(tooltip).display !== 'none';
      container.querySelectorAll('.info-tooltip').forEach((node) => {
        node.style.display = 'none';
      });
      tooltip.style.display = isVisible ? 'none' : 'block';
    });

    return { btn, tooltip };
  }

  function getGitHubLogin() {
    const u = githubAuth.getUser?.() || null;
    return normalizeGitHubUsername(u?.login || '');
  }

  function getCacheUsername() {
    const login = getGitHubLogin();
    if (login) return login;
    const profile = session.getProfile?.() || null;
    return normalizeGitHubUsername(profile?.username || '') || 'local';
  }

  function applySessionCacheContext({ datasetId = null } = {}) {
    const did = datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null;
    const username = getCacheUsername();
    const repoRef = getAnnotationRepoForDataset(did, username) || null;
    session.setCacheContext?.({ datasetId: did, repoRef, username });
  }

  function ensureRepoRefHasBranch(repoRef, branch) {
    const parsed = parseOwnerRepo(repoRef);
    if (!parsed) return toCleanString(repoRef) || null;
    const b = toCleanString(branch);
    if (!b || parsed.ref) return parsed.ownerRepoRef;
    return `${parsed.ownerRepo}@${b}`;
  }

  async function syncIdentityFromAuth({ promptIfMissing = false } = {}) {
    if (!githubAuth.isAuthenticated?.()) return false;
    if (!githubAuth.getUser?.()) {
      try {
        await githubAuth.fetchUser?.();
      } catch {
        return false;
      }
    }
    const login = getGitHubLogin();
    if (!login) return false;
    await ensureIdentityForUsername({ username: login, promptIfMissing });
    return true;
  }

  async function loadMyProfileFromGitHub({ datasetId } = {}) {
    const did = datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null;
    const login = getGitHubLogin();
    const repo = getAnnotationRepoForDataset(did, login || 'local');
    if (!repo) return false;
    if (!githubAuth.isAuthenticated?.()) return false;
    if (!login) return false;
    try {
      const sync = getGitHubSyncForDataset({ datasetId: did, username: login });
      if (!sync) return false;
      await sync.validateAndLoadConfig({ datasetId: did });
      const resolvedRepoRef = ensureRepoRefHasBranch(repo, sync.branch);
      if (resolvedRepoRef && resolvedRepoRef !== repo) {
        setAnnotationRepoForDataset(did, resolvedRepoRef, login);
        setUrlAnnotationRepo(resolvedRepoRef);
        session.setCacheContext?.({ datasetId: did, repoRef: resolvedRepoRef, username: login });
      }
      const mine = await sync.pullUserFile({ username: login });
      if (!mine?.doc) return false;
      session.mergeFromUserFiles([mine.doc], { preferLocalVotes: true });
      if (mine?.path && mine?.sha) session.setRemoteFileSha?.(mine.path, mine.sha);
      return true;
    } catch {
      return false;
    }
  }

  function normalizeGitHubUsername(value) {
    return String(value ?? '').trim().replace(/^@+/, '');
  }

  async function editIdentityFlow({
    suggestedUsername = null,
    reason = null
  } = {}) {
    const current = session.getProfile();
    const suggested = normalizeGitHubUsername(suggestedUsername || current?.username || '');
    const remoteFields = suggested ? session.getKnownUserProfile?.(suggested) : null;

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const modalRef = showClusterModal({
        title: 'Your identity (optional)',
        buildContent: (content) => {
          content.appendChild(el('div', {
            className: 'legend-help',
            text:
              'Used for attribution in annotations. Saved locally (like votes) until you Publish; Publish writes it into your GitHub user file. Pull reloads it from GitHub.'
          }));

          if (reason) content.appendChild(el('div', { className: 'legend-help', text: `⚠ ${String(reason)}` }));

          const status = el('div', { className: 'legend-help', text: '' });
          content.appendChild(status);

          if (suggested) {
            content.appendChild(el('div', { className: 'legend-help', text: `GitHub: @${suggested}` }));
            content.appendChild(el('div', {
              className: 'community-annotation-inline-help',
              text: 'GitHub username comes from your GitHub sign-in and cannot be edited here. Sign out to switch accounts.'
            }));
          } else {
            content.appendChild(el('div', {
              className: 'legend-help',
              text: 'GitHub account not available. Sign in to set identity.'
            }));
          }

          content.appendChild(el('label', { className: 'legend-help', text: 'Name (optional):' }));
          const nameInput = el('input', {
            type: 'text',
            className: 'obs-select community-annotation-input',
            placeholder: 'e.g. Alice Smith',
            value: current?.displayName || remoteFields?.displayName || ''
          });
          content.appendChild(nameInput);

          content.appendChild(el('label', { className: 'legend-help', text: 'Affiliation / role (optional):' }));
          const titleInput = el('input', {
            type: 'text',
            className: 'obs-select community-annotation-input',
            placeholder: 'e.g. Theis Lab, Postdoc',
            value: current?.title || remoteFields?.title || ''
          });
          content.appendChild(titleInput);

          content.appendChild(el('label', { className: 'legend-help', text: 'ORCID (optional):' }));
          const orcidInput = el('input', {
            type: 'text',
            className: 'obs-select community-annotation-input',
            placeholder: '0000-0000-0000-0000',
            value: current?.orcid || remoteFields?.orcid || ''
          });
          content.appendChild(orcidInput);

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const saveBtn = el('button', { type: 'button', className: 'btn-small', text: 'Save' });
          const skipBtn = el('button', { type: 'button', className: 'btn-small', text: 'Skip' });
          actions.appendChild(saveBtn);
          actions.appendChild(skipBtn);
          content.appendChild(actions);

          saveBtn.addEventListener('click', () => {
            const username = suggested;
            if (!username) {
              status.textContent = 'Sign in with GitHub first.';
              return;
            }
            const nextProfile = {
              ...current,
              username,
              displayName: String(nameInput.value || '').trim(),
              title: String(titleInput.value || '').trim(),
              orcid: String(orcidInput.value || '').trim()
            };
            session.setProfile(nextProfile);
            content.closest('.community-annotation-modal-overlay')?.remove?.();
            resolveOnce({ username, dismissed: false });
          });

          skipBtn.addEventListener('click', () => {
            const username = suggested;
            if (username) {
              session.setProfile({ ...current, username, displayName: '', title: '', orcid: '' });
            }
            content.closest('.community-annotation-modal-overlay')?.remove?.();
            resolveOnce({ username: username || null, dismissed: true });
          });
        }
      });

      const overlay = modalRef?.overlay || null;
      if (!overlay) return;
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

  async function ensureIdentityForUsername({ username, promptIfMissing = false } = {}) {
    const u = normalizeGitHubUsername(username);
    if (!u) return false;
    const current = session.getProfile();
    session.setProfile({ ...current, username: u });
    if (promptIfMissing) {
      const after = session.getProfile();
      const hasAny = Boolean(after.displayName || after.title || after.orcid);
      if (!hasAny) await editIdentityFlow({ suggestedUsername: u });
    }
    return true;
  }

  async function ensureIdentityForPush({ sync } = {}) {
    // Identity is authoritative from GitHub sign-in.
    return syncIdentityFromAuth({ promptIfMissing: true });
  }

  const setDatasetContextFromManager = () => {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    applySessionCacheContext({ datasetId });

    const paramRepo = getUrlAnnotationRepo();
    if (paramRepo) {
      try {
        const username = getCacheUsername();
        setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue: paramRepo, username });
        applySessionCacheContext({ datasetId });
      } catch {
        // ignore
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

  const unsubscribeAuth = githubAuth.on?.('changed', () => {
    // Clear auth-related errors and update identity UI quickly.
    syncError = null;
    if (!githubAuth.isAuthenticated?.()) {
      const current = session.getProfile();
      session.setProfile({ ...current, username: 'local', displayName: '', title: '', orcid: '' });
      applySessionCacheContext({});
      render();
      return;
    }
    syncIdentityFromAuth({ promptIfMissing: false })
      .then(() => loadMyProfileFromGitHub({}))
      .finally(() => {
        applySessionCacheContext({});
        render();
      });
  }) || null;
  const unsubscribeAccess = access.on?.('changed', () => render()) || null;

  function destroy() {
    unsubscribe?.();
    unsubscribeAuth?.();
    unsubscribeAccess?.();
    tooltipAbort.abort();
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

    const labelToIndex = new Map();
    const outCategories = [];

    const getLabelIndex = (label) => {
      const k = String(label || '').trim() || 'Pending';
      if (labelToIndex.has(k)) return labelToIndex.get(k);
      const idx = outCategories.length;
      outCategories.push(k);
      labelToIndex.set(k, idx);
      return idx;
    };

    const oldToNew = new Array(categories.length);
    for (let i = 0; i < categories.length; i++) {
      const c = session.computeConsensus(sourceFieldKey, i, { minAnnotators, threshold: consensusThreshold });
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
    const fallback = getLabelIndex('Pending');
    for (let i = 0; i < codes.length; i++) {
      const oldIdx = codes[i];
      outCodes[i] = Number.isInteger(oldIdx) && oldIdx >= 0 && oldIdx < oldToNew.length ? oldToNew[oldIdx] : fallback;
    }

    const result = state.upsertUserDefinedCategoricalField?.({
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

    if (result) {
      const suffix = result.updatedInPlace ? '' : ` (created as "${result.key}")`;
      notifications.success(`Updated consensus column: ${result.key}${suffix}`, { category: 'annotation', duration: 2600 });
    }
  }

  function openExternal(url) {
    const href = String(url || '').trim();
    if (!href) return false;
    try {
      window.open(href, '_blank', 'noopener,noreferrer');
      return true;
    } catch {
      return false;
    }
  }

  async function manageGitHubAccessFlow() {
    if (!githubAuth.isAuthenticated?.()) {
      await ensureSignedInFlow({ reason: 'Sign in to manage GitHub App access.' });
    }

    const appInstallUrl = 'https://github.com/apps/cellucid-community-annotations/installations/new';
    const settingsUrl = 'https://github.com/settings/installations';

    return new Promise((resolve) => {
      const modalRef = showClusterModal({
        title: 'GitHub App access',
        buildContent: (content) => {
          content.appendChild(el('div', {
            className: 'legend-help',
            text: 'Manage which repositories the Cellucid GitHub App can access.'
          }));

          const status = el('div', { className: 'legend-help', text: '' });
          content.appendChild(status);

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const openInstall = el('button', { type: 'button', className: 'btn-small', text: 'Install / add repos…' });
          const openSettings = el('button', { type: 'button', className: 'btn-small', text: 'GitHub settings…' });
          actions.appendChild(openInstall);
          actions.appendChild(openSettings);
          content.appendChild(actions);

          openInstall.addEventListener('click', () => openExternal(appInstallUrl));
          openSettings.addEventListener('click', () => openExternal(settingsUrl));

          const list = el('div', { className: 'legend-help', text: '' });
          content.appendChild(list);

          const load = async () => {
            list.textContent = '';
            if (!githubAuth.isAuthenticated?.()) {
              status.textContent = 'Sign in to view your installations.';
              return;
            }
            status.textContent = 'Loading installations…';
            try {
              const data = await githubAuth.listInstallations?.();
              const installs = Array.isArray(data?.installations) ? data.installations : [];
              status.textContent = installs.length ? `Installations: ${installs.length}` : 'No installations found.';
              if (!installs.length) {
                list.appendChild(el('div', { className: 'legend-help', text: 'Install the app on an account and select repos, then return and refresh.' }));
                return;
              }
              for (const inst of installs.slice(0, 50)) {
                const account = inst?.account?.login || inst?.account?.name || 'unknown';
                const row = el('div', { className: 'community-annotation-inline-help', text: `• ${account}` });
                const url = inst?.html_url || null;
                if (url) {
                  const btn = el('button', { type: 'button', className: 'btn-small', text: 'Open' });
                  btn.addEventListener('click', () => openExternal(url));
                  row.appendChild(document.createTextNode(' '));
                  row.appendChild(btn);
                }
                list.appendChild(row);
              }
            } catch (err) {
              status.textContent = err?.message || 'Failed to load installations';
            }
          };

          load();
        }
      });

      const overlay = modalRef?.overlay || null;
      if (!overlay) return;
      const observer = new MutationObserver(() => {
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          resolve(null);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function ensureSignedInFlow({ reason = null } = {}) {
    if (githubAuth.isAuthenticated?.()) return true;
    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const modalRef = showClusterModal({
        title: 'Sign in with GitHub',
        buildContent: (content) => {
          content.appendChild(el('div', {
            className: 'legend-help',
            text:
              'Cellucid uses a GitHub App sign-in (opens a GitHub window). ' +
              'Your access token is stored only in sessionStorage (cleared on tab close).'
          }));
          if (reason) content.appendChild(el('div', { className: 'legend-help', text: `⚠ ${String(reason)}` }));

          const status = el('div', { className: 'legend-help', text: '' });
          content.appendChild(status);

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const signInBtn = el('button', { type: 'button', className: 'btn-small', text: 'Sign in with GitHub' });
          const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });
          actions.appendChild(signInBtn);
          actions.appendChild(cancelBtn);
          content.appendChild(actions);

          const fallback = el('div', { className: 'community-annotation-inline-help', text: '' });
          content.appendChild(fallback);

          cancelBtn.addEventListener('click', () => {
            content.closest('.community-annotation-modal-overlay')?.remove?.();
            resolveOnce(false);
          });

          signInBtn.addEventListener('click', async () => {
            signInBtn.disabled = true;
            cancelBtn.disabled = true;
            fallback.textContent = '';
            status.textContent = 'Opening GitHub sign-in…';
            try {
              await githubAuth.signIn?.({ mode: 'auto' });
              await syncIdentityFromAuth({ promptIfMissing: false });
              await loadMyProfileFromGitHub({});
              content.closest('.community-annotation-modal-overlay')?.remove?.();
              resolveOnce(true);
            } catch (err) {
              signInBtn.disabled = false;
              cancelBtn.disabled = false;
              const msg = err?.message || 'Sign-in failed';
              status.textContent = msg;
              if (err?.code === 'POPUP_BLOCKED') {
                const link = getGitHubLoginUrl(githubAuth.getWorkerOrigin?.());
                fallback.textContent = '';
                fallback.appendChild(el('div', { className: 'legend-help', text: 'If your browser blocks popups/new tabs, allow them for Cellucid and try again.' }));
                fallback.appendChild(el('div', { className: 'legend-help', text: 'Alternative: click this link (starts sign-in in a new tab):' }));
                const manualLink = el('a', { href: link, target: '_blank', text: 'Open GitHub sign-in' });
                manualLink.addEventListener('click', () => {
                  status.textContent = 'Waiting for GitHub sign-in…';
                  fallback.textContent = '';
                  signInBtn.disabled = true;
                  cancelBtn.disabled = true;
                  githubAuth.completeSignInFromMessage?.()
                    .then(() => syncIdentityFromAuth({ promptIfMissing: false }))
                    .then(() => loadMyProfileFromGitHub({}))
                    .then(() => {
                      content.closest('.community-annotation-modal-overlay')?.remove?.();
                      resolveOnce(true);
                    })
                    .catch((listenErr) => {
                      signInBtn.disabled = false;
                      cancelBtn.disabled = false;
                      status.textContent = listenErr?.message || 'Sign-in failed';
                    });
                });
                fallback.appendChild(manualLink);
              }
            }
          });
        }
      });

      const overlay = modalRef?.overlay || null;
      if (!overlay) return;
      const observer = new MutationObserver(() => {
        if (resolved) {
          observer.disconnect();
          return;
        }
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          resolveOnce(false);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function connectRepoFlow({ reason = null, defaultPullNow = true } = {}) {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const okAuth = await ensureSignedInFlow({ reason: reason || 'Sign in to choose an annotation repository.' });
    if (!okAuth) return null;

    const login = getGitHubLogin();
    const currentRepo = getAnnotationRepoForDataset(datasetId, login || 'local') || getUrlAnnotationRepo() || null;

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const modalRef = showClusterModal({
        title: 'Choose annotation repository',
        buildContent: (content) => {
          content.appendChild(el('div', {
            className: 'legend-help',
            text: 'Select a repo where the Cellucid GitHub App is installed (annotations/ config + users).'
          }));
          if (reason) content.appendChild(el('div', { className: 'legend-help', text: `⚠ ${String(reason)}` }));

          const status = el('div', { className: 'legend-help', text: '' });
          content.appendChild(status);

          const searchInput = el('input', {
            type: 'text',
            className: 'obs-select community-annotation-input',
            placeholder: 'Search repos…',
            value: ''
          });
          content.appendChild(searchInput);

          const repoSelect = el('select', { className: 'obs-select' });
          repoSelect.appendChild(el('option', { value: '', text: '(loading…)'}));
          content.appendChild(repoSelect);

          const pullRow = el('label', { className: 'legend-help' });
          const pullNow = el('input', { type: 'checkbox' });
          pullNow.checked = Boolean(defaultPullNow);
          pullRow.appendChild(pullNow);
          pullRow.appendChild(document.createTextNode(' Pull now after connecting'));
          content.appendChild(pullRow);

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const refreshBtn = el('button', { type: 'button', className: 'btn-small', text: 'Refresh list' });
          const manageBtn = el('button', { type: 'button', className: 'btn-small', text: 'Manage access…' });
          const connectBtn = el('button', { type: 'button', className: 'btn-small', text: 'Connect' });
          actions.appendChild(refreshBtn);
          actions.appendChild(manageBtn);
          actions.appendChild(connectBtn);
          content.appendChild(actions);

          /** @type {{full_name:string, private?:boolean, html_url?:string}[]} */
          let allRepos = [];

          const renderOptions = () => {
            const q = String(searchInput.value || '').trim().toLowerCase();
            repoSelect.innerHTML = '';
            const filtered = q
              ? allRepos.filter((r) => String(r.full_name || '').toLowerCase().includes(q))
              : allRepos;
            repoSelect.appendChild(el('option', { value: '', text: filtered.length ? '(select a repo)' : '(no repos found)' }));
            for (const r of filtered.slice(0, 400)) {
              const name = String(r.full_name || '').trim();
              if (!name) continue;
              const label = r.private ? `${name} (private)` : name;
              repoSelect.appendChild(el('option', { value: name, text: label }));
            }
            if (currentRepo) repoSelect.value = currentRepo;
          };

          const loadRepos = async () => {
            status.textContent = 'Loading installations…';
            refreshBtn.disabled = true;
            connectBtn.disabled = true;
            repoSelect.disabled = true;
            try {
              const instData = await githubAuth.listInstallations?.();
              const installations = Array.isArray(instData?.installations) ? instData.installations : [];
              if (!installations.length) {
                allRepos = [];
                renderOptions();
                status.textContent = 'No installations found. Install the app on an account, then refresh.';
                return;
              }

              const repos = [];
              for (const inst of installations.slice(0, 50)) {
                status.textContent = `Loading repos… (${repos.length})`;
                const id = inst?.id;
                if (!id) continue;
                try {
                  const repoData = await githubAuth.listInstallationRepos?.(id);
                  const list = Array.isArray(repoData?.repositories) ? repoData.repositories : [];
                  for (const r of list) {
                    const full = String(r?.full_name || '').trim();
                    if (!full) continue;
                    repos.push({ full_name: full, private: Boolean(r?.private), html_url: r?.html_url || null });
                  }
                } catch (err) {
                  // Skip installations that error; user can manage access and retry.
                  status.textContent = err?.message || 'Failed to load some installations';
                }
              }

              const unique = new Map();
              for (const r of repos) unique.set(r.full_name, r);
              allRepos = Array.from(unique.values()).sort((a, b) => a.full_name.localeCompare(b.full_name));
              status.textContent = allRepos.length ? `Repos available: ${allRepos.length}` : 'No repos available via the app.';
              renderOptions();
            } finally {
              refreshBtn.disabled = false;
              connectBtn.disabled = false;
              repoSelect.disabled = false;
            }
          };

          searchInput.addEventListener('input', () => renderOptions());
          refreshBtn.addEventListener('click', () => loadRepos());
          manageBtn.addEventListener('click', () => manageGitHubAccessFlow());

          connectBtn.addEventListener('click', async () => {
            const selected = String(repoSelect.value || '').trim();
            if (!selected) {
              status.textContent = 'Select a repo first.';
              return;
            }
            const parts = selected.split('/');
            if (parts.length !== 2) {
              status.textContent = 'Invalid repo selection.';
              return;
            }

            status.textContent = 'Validating repository…';
            try {
              const token = githubAuth.getToken?.() || null;
              const sync = new CommunityAnnotationGitHubSync({
                datasetId,
                owner: parts[0],
                repo: parts[1],
                token,
                branch: null,
                workerOrigin: githubAuth.getWorkerOrigin?.() || null
              });
              const { repoInfo, config, datasetConfig, datasetId: did } = await sync.validateAndLoadConfig({ datasetId });
              lastRepoInfo = repoInfo || null;
              access.setRoleFromRepoInfo(lastRepoInfo);
              if (did && Array.isArray(config?.supportedDatasets) && config.supportedDatasets.length && !datasetConfig) {
                const ok = await confirmAsync({
                  title: 'Dataset mismatch',
                  message:
                    `This repo does not list the current dataset id "${did}" in annotations/config.json.\n\nConnect anyway?`,
                  confirmText: 'Connect anyway'
                });
                if (!ok) {
                  status.textContent = 'Cancelled.';
                  return;
                }
              }

              const resolvedRepoRef = ensureRepoRefHasBranch(selected, sync.branch);
              setAnnotationRepoForDataset(datasetId, resolvedRepoRef, login || 'local');
              session.setCacheContext?.({ datasetId, repoRef: resolvedRepoRef, username: login || 'local' });
              setUrlAnnotationRepo(resolvedRepoRef);
              await syncIdentityFromAuth({ promptIfMissing: true });
              await loadMyProfileFromGitHub({ datasetId });

              // Apply configured fields for this dataset on connect (author-controlled).
              const configured = new Set(Array.isArray(datasetConfig?.fieldsToAnnotate) ? datasetConfig.fieldsToAnnotate : []);
              const catFields = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
              const allKeys = catFields.map((f) => f.key).filter(Boolean);
              for (const key of allKeys) {
                session.setFieldAnnotated(key, configured.has(key));
              }

              resolveOnce({ ownerRepo: selected, pullNow: pullNow.checked });
              content.closest('.community-annotation-modal-overlay')?.remove?.();
              if (pullNow.checked) {
                await pullFromGitHub({ repoOverride: selected });
              } else {
                render();
              }
            } catch (err) {
              status.textContent = err?.message || 'Failed to connect';
            }
          });

          loadRepos();
        }
      });

      const overlay = modalRef?.overlay || null;
      if (!overlay) return;
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

  async function pullFromGitHub({ repoOverride = null } = {}) {
    if (syncBusy) return;
    syncBusy = true;
    syncError = null;
    render();

    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const login = getGitHubLogin();
    const cacheUser = login || getCacheUsername();
    const repo = repoOverride || getAnnotationRepoForDataset(datasetId, cacheUser);
    if (!repo) {
      syncBusy = false;
      syncError = 'No annotation repo connected.';
      render();
      await connectRepoFlow({ reason: 'Choose a repo to Pull from.', defaultPullNow: true });
      return;
    }

    if (repoOverride) {
      // Keep stored mapping consistent with the repo we're about to pull from.
      setAnnotationRepoForDataset(datasetId, repoOverride, cacheUser);
    }
    session.setCacheContext?.({ datasetId, repoRef: repo, username: cacheUser });

    const okAuth = await ensureSignedInFlow({ reason: 'Sign in required to Pull annotations.' });
    if (!okAuth) {
      syncBusy = false;
      render();
      return;
    }

    const trackerId = notifications.loading(`Pulling annotations from ${repo}...`, { category: 'annotation' });

    try {
      const sync = getGitHubSyncForDataset({ datasetId, username: cacheUser });
      if (!sync) throw new Error('Invalid annotation repo');

      const { repoInfo, datasetConfig } = await sync.validateAndLoadConfig({ datasetId });
      lastRepoInfo = repoInfo || null;
      access.setRoleFromRepoInfo(lastRepoInfo);
      const resolvedRepoRef = ensureRepoRefHasBranch(repo, sync.branch);
      if (resolvedRepoRef && resolvedRepoRef !== repo) {
        setAnnotationRepoForDataset(datasetId, resolvedRepoRef, cacheUser);
        setUrlAnnotationRepo(resolvedRepoRef);
        session.setCacheContext?.({ datasetId, repoRef: resolvedRepoRef, username: cacheUser });
      }
      const knownShas = session.getRemoteFileShas?.() || null;
      const pullResult = await sync.pullAllUsers({ knownShas });
      const docs = pullResult?.docs || [];
      if (pullResult?.shas) session.setRemoteFileShas?.(pullResult.shas);
      const invalidCount = docs.filter((d) => d && d.__invalid).length;
      const usable = docs.filter((d) => d && !d.__invalid);
      session.mergeFromUserFiles(usable, { preferLocalVotes: true });

      // Optional: moderation merges (author-maintained) - incremental via sha cache.
      try {
        const known = session.getRemoteFileShas?.() || null;
        const res = await sync.pullModerationMerges({ knownShas: known });
        if (res?.sha) session.setRemoteFileSha?.(res.path || 'annotations/moderation/merges.json', res.sha);
        if (res?.doc) session.setModerationMergesFromDoc(res.doc);
      } catch {
        // ignore
      }

      // Apply configured fields for this dataset (author-controlled).
      const configured = new Set(Array.isArray(datasetConfig?.fieldsToAnnotate) ? datasetConfig.fieldsToAnnotate : []);
      const catFields = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
      const allKeys = catFields.map((f) => f.key).filter(Boolean);
      for (const key of allKeys) {
        session.setFieldAnnotated(key, configured.has(key));
      }

      await applyConsensusColumn();

      if (invalidCount) {
        notifications.complete(trackerId, `Pulled with ${invalidCount} invalid user file(s) skipped`);
      } else {
        notifications.complete(trackerId, 'Pulled latest annotations');
      }
    } catch (err) {
      const msg = err?.message || 'Pull failed';
      if (isAuthError(err)) {
        githubAuth.signOut?.();
        syncError = `${msg} (sign in again)`;
      } else {
        syncError = msg;
      }
      notifications.fail(trackerId, msg);
    } finally {
      syncBusy = false;
      render();
    }
  }

  async function pushToGitHub() {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const login = getGitHubLogin();
    const cacheUser = login || getCacheUsername();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUser);
    const repoConnectedForGating = Boolean(repo) || isSimulateRepoConnectedEnabled();
    if (!repo) {
      syncError = 'No annotation repo connected.';
      render();
      await connectRepoFlow({ reason: 'Choose a repo to Publish to.', defaultPullNow: false });
      return;
    }

    if (syncBusy) return;
    syncBusy = true;
    syncError = null;
    render();

    const okAuth = await ensureSignedInFlow({ reason: 'Sign in required to Publish your annotations.' });
    if (!okAuth) {
      syncBusy = false;
      render();
      return;
    }

    const trackerId = notifications.loading(`Publishing your annotations to ${repo}...`, { category: 'annotation' });

    try {
      session.setCacheContext?.({ datasetId, repoRef: repo, username: cacheUser });
      const sync = getGitHubSyncForDataset({ datasetId, username: cacheUser });
      if (!sync) throw new Error('Invalid annotation repo');
      // Ensure branch/config resolves early with auth.
      const { repoInfo } = await sync.validateAndLoadConfig({ datasetId });
      lastRepoInfo = repoInfo || null;
      access.setRoleFromRepoInfo(lastRepoInfo);
      const resolvedRepoRef = ensureRepoRefHasBranch(repo, sync.branch);
      if (resolvedRepoRef && resolvedRepoRef !== repo) {
        setAnnotationRepoForDataset(datasetId, resolvedRepoRef, cacheUser);
        setUrlAnnotationRepo(resolvedRepoRef);
        session.setCacheContext?.({ datasetId, repoRef: resolvedRepoRef, username: cacheUser });
      }

      const okIdentity = await ensureIdentityForPush({ sync });
      if (!okIdentity) {
        throw new Error('Unable to determine your GitHub username.');
      }

      const publishAuthorExtras = async () => {
        if (!access.isAuthor()) return { configUpdated: false, mergesPublished: false, errors: [] };
        /** @type {string[]} */
        const errors = [];
        let configUpdated = false;
        let mergesPublished = false;

        try {
          const fieldsToAnnotate = session.getAnnotatedFields?.() || [];
          await sync.updateDatasetFieldsToAnnotate({ datasetId, fieldsToAnnotate });
          configUpdated = true;
        } catch (err) {
          errors.push(err?.message || 'Failed to publish annotatable columns');
        }

        try {
          const merges = session.getModerationMerges?.() || [];
          if (Array.isArray(merges) && merges.length) {
            const res = await sync.pushModerationMerges({ mergesDoc: session.buildModerationMergesDocument() });
            if (res?.path && res?.sha) session.setRemoteFileSha?.(res.path, res.sha);
            mergesPublished = true;
          }
        } catch (err) {
          errors.push(err?.message || 'Failed to publish merges');
        }

        return { configUpdated, mergesPublished, errors };
      };

      const doc = session.buildUserFileDocument();
      const lastSyncAt = session.getStateSnapshot()?.lastSyncAt || null;
      try {
        const result = await sync.pushMyUserFile({ userDoc: doc, conflictIfRemoteNewerThan: lastSyncAt });
        session.markSyncedNow();
        if (result?.mode === 'push' && result?.path && result?.sha) session.setRemoteFileSha?.(result.path, result.sha);
        if (result?.mode === 'pr') {
          const prUrl = String(result?.prUrl || '').trim();
          notifications.complete(trackerId, prUrl ? `Opened Pull Request: ${prUrl}` : 'Opened Pull Request');
        } else {
          const extras = await publishAuthorExtras();
          const bits = ['Published your votes/suggestions'];
          if (extras.configUpdated) bits.push('updated annotatable columns');
          if (extras.mergesPublished) bits.push('published merges');
          notifications.complete(trackerId, bits.join(' • '));
          if (extras.errors.length) {
            notifications.error(`Author publish extras: ${extras.errors.join(' • ')}`, { category: 'annotation', duration: 6000 });
          }
        }
        return;
      } catch (err) {
        if (err?.code === 'COMMUNITY_ANNOTATION_CONFLICT') {
          const ok = await confirmAsync({
            title: 'Possible conflict',
            message:
              `Your remote user file appears to have been updated since your last sync.\n\n` +
              `Remote updatedAt: ${String(err?.remoteUpdatedAt || 'unknown')}\n\n` +
              `Recommendation: Pull first to merge changes. Overwrite anyway?`,
            confirmText: 'Overwrite remote'
          });
          if (!ok) throw new Error('Publish cancelled.');
          const result = await sync.pushMyUserFile({ userDoc: doc, force: true });
          session.markSyncedNow();
          if (result?.mode === 'push' && result?.path && result?.sha) session.setRemoteFileSha?.(result.path, result.sha);
          if (result?.mode === 'pr') {
            const prUrl = String(result?.prUrl || '').trim();
            notifications.complete(trackerId, prUrl ? `Opened Pull Request: ${prUrl}` : 'Opened Pull Request');
          } else {
            const extras = await publishAuthorExtras();
            const bits = ['Published your votes/suggestions'];
            if (extras.configUpdated) bits.push('updated annotatable columns');
            if (extras.mergesPublished) bits.push('published merges');
            notifications.complete(trackerId, bits.join(' • '));
            if (extras.errors.length) {
              notifications.error(`Author publish extras: ${extras.errors.join(' • ')}`, { category: 'annotation', duration: 6000 });
            }
          }
          return;
        } else {
          throw err;
        }
      }
    } catch (err) {
      const msg = err?.message || 'Publish failed';
      if (isAuthError(err)) {
        githubAuth.signOut?.();
        syncError = `${msg} (sign in again)`;
      } else {
        syncError = msg;
      }
      notifications.fail(trackerId, msg);
    } finally {
      syncBusy = false;
      render();
    }
  }

  function render() {
    container.innerHTML = '';

    const introBlock = el('div', { className: 'control-block relative' });
    const introInfo = createInfoTooltip([
      'Offline-first: votes/suggestions are saved locally first.',
      'Annotatable columns are chosen by repo authors (maintain/admin) via the annotation repo config.',
      'GitHub sync is optional: sign in to Pull/Publish.'
    ]);
    introBlock.appendChild(el('label', { className: 'd-flex items-center gap-1' }, [
      'Community voting',
      introInfo.btn
    ]));
    introBlock.appendChild(introInfo.tooltip);
    introBlock.appendChild(el('div', { className: 'legend-help', text: 'Votes and suggestions are saved locally; GitHub sync is optional.' }));
    container.appendChild(introBlock);

    // GitHub sync
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const cacheUsername = getCacheUsername();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUsername);
    const repoConnectedForGating = Boolean(repo) || isSimulateRepoConnectedEnabled();
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const isAuthed = Boolean(githubAuth.isAuthenticated?.());
    const authedUser = githubAuth.getUser?.() || null;
    const login = normalizeGitHubUsername(authedUser?.login || '');
    const syncBlock = el('div', { className: 'control-block relative' });
    const syncInfo = createInfoTooltip([
      'Sign in: authenticate via GitHub App (token stored in sessionStorage; cleared on tab close).',
      'Manage access: install the app on more repos, or revoke it in GitHub settings.',
      'Choose repo: pick from repos where the app is installed for you (no manual entry).',
      'Pull: fetch latest `annotations/users/*.json` from GitHub and merge locally.',
      'Publish: push your `annotations/users/{you}.json` (direct push if allowed, otherwise a fork + PR).',
      'Author tools require maintain/admin (not just write).'
    ]);
    syncBlock.appendChild(el('label', { className: 'd-flex items-center gap-1' }, ['GitHub sync', syncInfo.btn]));
    syncBlock.appendChild(syncInfo.tooltip);

    const repoLine = el('div', {
      className: 'legend-help',
      text: repo ? `Repo: ${repo}` : 'No annotation repo connected.'
    });
    syncBlock.appendChild(repoLine);

    const userRow = el('div', { className: 'community-annotation-github-user' });
    if (isAuthed && authedUser?.avatar_url) {
      userRow.appendChild(el('img', {
        className: 'community-annotation-github-avatar',
        src: String(authedUser.avatar_url),
        alt: login ? `@${login}` : 'GitHub user'
      }));
    }
    userRow.appendChild(el('div', {
      className: 'legend-help',
      text: isAuthed ? (login ? `Signed in as @${login}` : 'Signed in') : 'Not signed in'
    }));
    syncBlock.appendChild(userRow);

    if (!online) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: 'Offline: GitHub actions are disabled.' }));
    }

    const lastSync = session.getStateSnapshot()?.lastSyncAt || null;
    syncBlock.appendChild(el('div', { className: 'legend-help', text: `Last sync: ${formatTimeLabel(lastSync)}` }));

    const role = access.getEffectiveRole();
    const roleLabel =
      role === 'author'
        ? 'Access: Author (maintain/admin)'
        : role === 'annotator'
          ? 'Access: Annotator (contributors)'
          : 'Access: Unknown (Pull to detect permissions)';
    syncBlock.appendChild(el('div', { className: 'legend-help', text: roleLabel }));

    const perms = lastRepoInfo?.permissions || null;
    const canDirectPush = perms ? Boolean(perms.push || perms.maintain || perms.admin) : null;
    if (canDirectPush != null) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: `Publish mode: ${canDirectPush ? 'Direct push' : 'Fork + Pull Request'}` }));
    }

    if (syncError) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: `⚠ ${syncError}` }));
    }

    const syncActions = el('div', { className: 'community-annotation-sync-actions' });
    const signInOutBtn = el('button', { type: 'button', className: 'btn-small', text: isAuthed ? 'Sign out' : 'Sign in' });
    const manageBtn = el('button', { type: 'button', className: 'btn-small', text: 'Manage access' });
    const connectBtn = el('button', { type: 'button', className: 'btn-small', text: repo ? 'Change repo' : 'Choose repo' });
    const disconnectBtn = el('button', { type: 'button', className: 'btn-small', text: 'Disconnect' });
    const pullBtn = el('button', { type: 'button', className: 'btn-small', text: syncBusy ? 'Working...' : 'Pull' });
    const publishBtn = el('button', { type: 'button', className: 'btn-small', text: syncBusy ? 'Working...' : 'Publish' });

    syncActions.appendChild(signInOutBtn);
    syncActions.appendChild(manageBtn);
    syncActions.appendChild(connectBtn);
    syncActions.appendChild(disconnectBtn);
    syncActions.appendChild(pullBtn);
    syncActions.appendChild(publishBtn);

    // In dev mode with _simulate_repo_connected, allow buttons without actual repo/auth
    const devBypassAuth = repoConnectedForGating && !repo;

    signInOutBtn.disabled = syncBusy || !online;
    manageBtn.disabled = syncBusy || !online;
    connectBtn.disabled = syncBusy || !online;
    disconnectBtn.disabled = !repo || syncBusy;
    pullBtn.disabled = !repoConnectedForGating || (!isAuthed && !devBypassAuth) || syncBusy || !online;
    publishBtn.disabled = !repoConnectedForGating || (!isAuthed && !devBypassAuth) || syncBusy || !online;

    signInOutBtn.title = isAuthed ? 'Clear session token and sign out.' : 'Sign in with GitHub App authentication.';
    manageBtn.title = 'Install the app on more repos, or revoke access.';
    connectBtn.title = 'Choose a repo where the app is installed.';
    disconnectBtn.title = repo ? 'Disconnect this dataset from the annotation repo.' : 'Choose a repo first.';
    pullBtn.title = devBypassAuth
      ? 'Dev mode: simulated repo connected.'
      : (!repoConnectedForGating ? 'Choose a repo first.' : (!online ? 'Offline.' : (!isAuthed ? 'Sign in first.' : 'Fetch latest user files from GitHub and merge into your session.')));
    publishBtn.title = devBypassAuth
      ? 'Dev mode: simulated repo connected.'
      : (!repoConnectedForGating
        ? 'Choose a repo first.'
        : (!online
          ? 'Offline.'
          : (!isAuthed
            ? 'Sign in first.'
            : 'Publish pushes directly if you have write access; otherwise it creates a Pull Request from your fork.')));

    signInOutBtn.addEventListener('click', async () => {
      if (isAuthed) {
        const ok = await confirmAsync({
          title: 'Sign out?',
          message: 'This clears your session token (you can sign in again anytime).',
          confirmText: 'Sign out'
        });
        if (!ok) return;
        githubAuth.signOut?.();
        render();
        return;
      }
      await ensureSignedInFlow({ reason: null });
      render();
    });

    manageBtn.addEventListener('click', () => manageGitHubAccessFlow());
    connectBtn.addEventListener('click', () => connectRepoFlow({ reason: null, defaultPullNow: false }));
    disconnectBtn.addEventListener('click', () => {
      clearAnnotationRepoForDataset(datasetId, cacheUsername);
      if (repo) setUrlAnnotationRepo(null);
      syncError = null;
      session.setCacheContext?.({ datasetId, repoRef: null, username: cacheUsername });
      render();
    });
    pullBtn.addEventListener('click', () => pullFromGitHub());
    publishBtn.addEventListener('click', () => pushToGitHub());
    syncBlock.appendChild(syncActions);

    const consensusBlock = el('div', { className: 'control-block relative' });

    const catFieldsForConsensus = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
    const allKeysForConsensus = catFieldsForConsensus.map((f) => f.key).filter(Boolean);
    const annotatableKeysForConsensus = session.getAnnotatedFields().filter((k) => allKeysForConsensus.includes(k));
    if (!consensusSourceFieldKey || !annotatableKeysForConsensus.includes(consensusSourceFieldKey)) {
      consensusSourceFieldKey = annotatableKeysForConsensus[0] || null;
    }

    const accordion = el('div', { className: 'analysis-accordion' });
    const item = el('div', { className: `analysis-accordion-item${consensusAccordionOpen ? ' open' : ''}` });
    const header = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(consensusAccordionOpen)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'CONSENSUS COLUMN KEY' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Threshold, min annotators, and source column' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const content = el('div', { className: 'analysis-accordion-content' });

    const toggleOpen = () => {
      consensusAccordionOpen = !consensusAccordionOpen;
      item.classList.toggle('open', consensusAccordionOpen);
      header.setAttribute('aria-expanded', String(consensusAccordionOpen));
    };
    header.addEventListener('click', () => toggleOpen());
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleOpen();
      }
    });

    // Source annotatable column selector
    const srcWrap = el('div', { className: 'field-select' });
    const consensusInfo = createInfoTooltip([
      'Builds a derived categorical obs column based on current community consensus.',
      'Choose which annotatable column to summarize; then apply to create/update a new obs column.',
      'Each cluster becomes: a consensus label, Disputed, or Pending.'
    ]);
    srcWrap.appendChild(el('label', { className: 'd-flex items-center gap-1' }, ['Annotatable column:', consensusInfo.btn]));
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
        render();
      });
    }
    srcWrap.appendChild(srcSelect);
    content.appendChild(srcWrap);

    // Consensus column key
    const consensusKeyWrap = el('div', { className: 'field-select' });
    consensusKeyWrap.appendChild(el('label', { text: 'Consensus column key:' }));
    const consensusKeyInput = el('input', { type: 'text', className: 'community-annotation-text-input community-annotation-input', placeholder: 'community_cell_type' });
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
      min: '0.5',
      max: '0.95',
      step: '0.05',
      value: String(consensusThreshold)
    });
    const thresholdDisplay = el('span', { className: 'slider-value', text: formatPct01(consensusThreshold) });
    thresholdInput.addEventListener('input', () => {
      consensusThreshold = Number(thresholdInput.value);
      thresholdDisplay.textContent = formatPct01(consensusThreshold);
    });
    const thresholdRow = el('div', { className: 'slider-row' }, [thresholdInput, thresholdDisplay]);
    consensusSettings.appendChild(thresholdLabel);
    consensusSettings.appendChild(thresholdRow);

    const minLabel = el('label', { text: 'Min annotators:' });
    const minInput = el('input', {
      type: 'number',
      className: 'obs-select',
      value: String(minAnnotators),
      min: '1',
      max: '50',
      step: '1'
    });
    minInput.addEventListener('change', () => {
      minAnnotators = clampInt(Number(minInput.value), 1, 50);
      minInput.value = String(minAnnotators);
    });
    consensusSettings.appendChild(minLabel);
    consensusSettings.appendChild(minInput);
    content.appendChild(consensusSettings);

    const applyActions = el('div', { className: 'community-annotation-consensus-actions' });
    const applyBtn = el('button', { type: 'button', className: 'btn-small', text: 'Apply' });
    applyBtn.disabled = syncBusy || !consensusSourceFieldKey;
    applyBtn.addEventListener('click', () => applyConsensusColumn());
    applyActions.appendChild(applyBtn);
    content.appendChild(applyActions);

    item.appendChild(header);
    item.appendChild(content);
    accordion.appendChild(item);
    consensusBlock.appendChild(accordion);

    container.appendChild(syncBlock);

    // Profile (asked once per GitHub username; editable)
    const profile = session.getProfile();
    const identityBlock = el('div', { className: 'control-block relative' });
    const identityInfo = createInfoTooltip([
      'Profile fields are optional and saved locally (like votes) until you Publish.',
      'Publish writes them into your GitHub user file; Pull reloads them from GitHub.',
      'Your GitHub username comes from sign-in and cannot be edited here.'
    ]);
    identityBlock.appendChild(el('label', { className: 'd-flex items-center gap-1' }, ['Profile (optional)', identityInfo.btn]));
    identityBlock.appendChild(identityInfo.tooltip);

    const authedLogin = getGitHubLogin();
    const canEdit = Boolean(githubAuth.isAuthenticated?.() && authedLogin);
    const identityText = canEdit
      ? session.formatUserAttribution(authedLogin)
      : 'Sign in with GitHub to set your identity and publish.';
    identityBlock.appendChild(el('div', { className: 'legend-help', text: identityText }));

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
      await ensureIdentityForUsername({ username: authedLogin, promptIfMissing: false });
      await editIdentityFlow({ suggestedUsername: authedLogin });
      render();
    });

    clearBtn.addEventListener('click', async () => {
      if (!canEdit) return;
      const ok = await confirmAsync({
        title: 'Clear profile?',
        message: `Clear your profile fields for @${authedLogin} in this session?\n\nPublish to update your GitHub user file.`,
        confirmText: 'Clear'
      });
      if (!ok) return;
      session.setProfile({ ...profile, username: authedLogin, displayName: '', title: '', orcid: '' });
      render();
    });

    container.appendChild(identityBlock);
    container.appendChild(consensusBlock);

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
    const canManageAnnotatable = hasSelection && (!repoConnectedForGating || access.isAuthor());
    const showManageSection = !repoConnectedForGating || access.isAuthor();

    if (showManageSection) {
      const manageBlock = el('div', { className: 'control-block relative' });

      const manageAccordion = el('div', { className: 'analysis-accordion' });
      const manageItem = el('div', { className: 'analysis-accordion-item' });
      const manageHeaderBtn = el('div', {
        className: 'analysis-accordion-header',
        role: 'button',
        tabIndex: '0',
        'aria-expanded': 'false'
      }, [
        el('span', { className: 'analysis-accordion-title', text: 'MANAGE ANNOTATION' }),
        el('span', { className: 'analysis-accordion-desc', text: 'Add/remove columns from annotation (author)' }),
        el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
      ]);
      const manageContent = el('div', { className: 'analysis-accordion-content' });

      const toggleManageOpen = () => {
        const isOpen = manageItem.classList.toggle('open');
        manageHeaderBtn.setAttribute('aria-expanded', String(isOpen));
      };
      manageHeaderBtn.addEventListener('click', () => toggleManageOpen());
      manageHeaderBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleManageOpen();
        }
      });

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
        fieldSelect.appendChild(el('option', { value: key, text: enabled ? `🗳️ ${key}` : key }));
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
      const addBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add to annotation', title: lockedReason || 'Mark this column as annotatable', disabled: !canManageAnnotatable });
      const removeBtn = el('button', { type: 'button', className: 'btn-small', text: 'Remove from annotation', title: lockedReason || 'Remove this column from annotation', disabled: !canManageAnnotatable });

      addBtn.addEventListener('click', () => {
        if (!selectedFieldKey) return;
        if (repoConnectedForGating && !access.isAuthor()) return;
        session.setFieldAnnotated(selectedFieldKey, true);
        notifications.success(`Added "${selectedFieldKey}" as annotation`, { category: 'annotation', duration: 2200 });
        render();
      });

      removeBtn.addEventListener('click', () => {
        if (!selectedFieldKey) return;
        if (repoConnectedForGating && !access.isAuthor()) return;
        session.setFieldAnnotated(selectedFieldKey, false);
        notifications.success(`Removed "${selectedFieldKey}" from annotation`, { category: 'annotation', duration: 2200 });
        render();
      });

      manageActions.appendChild(addBtn);
      manageActions.appendChild(removeBtn);
      manageContent.appendChild(manageActions);

      manageItem.appendChild(manageHeaderBtn);
      manageItem.appendChild(manageContent);
      manageAccordion.appendChild(manageItem);
      manageBlock.appendChild(manageAccordion);
      container.appendChild(manageBlock);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cache management
    // ─────────────────────────────────────────────────────────────────────────
    const cacheBlock = el('div', { className: 'control-block' });
    const cacheRow = el('div', { className: 'community-annotation-consensus-actions', 'aria-label': 'Annotation cache actions' });
    const clearCacheBtn = el('button', { type: 'button', className: 'btn-small', text: 'Remove local cache' });
    clearCacheBtn.addEventListener('click', async () => {
      const ok = await confirmAsync({
        title: 'Remove local annotation cache?',
        message: 'This clears local community-annotation data only for the current dataset + repo + branch + user in this browser (votes, suggestions, voting-enabled fields).',
        confirmText: 'Remove local cache'
      });
      if (!ok) return;
      session.clearLocalCache?.({ keepVotingMode: false });
      notifications.success('Local annotation cache cleared', { category: 'annotation', duration: 2200 });
      render();
    });
    cacheRow.appendChild(clearCacheBtn);
    cacheBlock.appendChild(cacheRow);
    container.appendChild(cacheBlock);

    // Popup handles per-category voting/suggestions; keep the sidebar compact.
  }

  render();

  return { render, destroy };
}
