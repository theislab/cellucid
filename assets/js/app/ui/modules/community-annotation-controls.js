/**
 * @fileoverview Community annotation (offline-first) sidebar section.
 *
 * Phase 1-2 implementation:
 * - Local session (localStorage) for annotated fields, suggestions, votes
 * - Lightweight UI to manage profile + per-cluster voting/suggestions
 *
 * GitHub sync (fine-grained PAT) is implemented here as a lightweight UI wrapper
 * around the GitHub sync module.
 *
 * @module ui/modules/community-annotation-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { getUrlAnnotationRepo, setUrlAnnotationRepo } from '../../url-state.js';
import {
  clearAnnotationRepoForDataset,
  clearPatForRepo,
  clearSessionPatForRepo,
  getEffectivePatForRepo,
  getAnnotationRepoForDataset,
  setAnnotationRepoForDataset,
  setSessionPatForRepo,
  setPatForRepo
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
    else if (v != null) node.setAttribute(k, String(v));
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

  const notifications = getNotificationCenter();

  let selectedFieldKey = null;
  let consensusThreshold = 0.7;
  let minAnnotators = 3;
  let consensusColumnKey = 'community_cell_type';

  let syncBusy = false;
  let syncError = null;

  const setDatasetContextFromManager = () => {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    session.setDatasetId(datasetId);

    const paramRepo = getUrlAnnotationRepo();
    if (paramRepo) {
      try {
        setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue: paramRepo });
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

  function destroy() {
    unsubscribe?.();
  }

  async function applyConsensusColumn() {
    if (!selectedFieldKey) return;

    const fields = state.getFields?.() || [];
    const fieldIndex = fields.findIndex((f) => f?.kind === 'category' && f?.key === selectedFieldKey && f?._isDeleted !== true);
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
      const c = session.computeConsensus(selectedFieldKey, i, { minAnnotators, threshold: consensusThreshold });
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
      key: consensusColumnKey,
      categories: outCategories,
      codes: outCodes,
      meta: {
        _sourceField: {
          kind: 'community-annotation',
          sourceKey: selectedFieldKey,
          sourceIndex: fieldIndex
        },
        _operation: {
          type: 'community-consensus',
          fieldKey: selectedFieldKey,
          builtAt: Date.now()
        }
      }
    });

    if (result) {
      const suffix = result.updatedInPlace ? '' : ` (created as "${result.key}")`;
      notifications.success(`Updated consensus column: ${result.key}${suffix}`, { category: 'annotation', duration: 2600 });
    }
  }

  async function connectRepoFlow({
    requireToken = false,
    reason = null,
    initialOwnerRepo = null,
    defaultPullNow = null
  } = {}) {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const existingRepo = initialOwnerRepo || getAnnotationRepoForDataset(datasetId) || null;
    const existingToken = existingRepo ? getEffectivePatForRepo(existingRepo) : null;

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const modalRef = showClusterModal({
        title: 'Connect annotation repository',
        buildContent: (content) => {
          const intro = el('div', {
            className: 'legend-help',
            text:
              'Connect a GitHub repo that contains annotations/ (config + users). For private repos, paste a fine-grained PAT (Contents: read/write).'
          });
          content.appendChild(intro);

          if (reason) {
            content.appendChild(el('div', { className: 'legend-help', text: `⚠ ${String(reason)}` }));
          }

          const status = el('div', { className: 'legend-help', text: '' });
          content.appendChild(status);

          const repoInput = el('input', {
            type: 'text',
            className: 'obs-select community-annotation-input',
            placeholder: 'owner/repo (or owner/repo@branch)',
            value: existingRepo || getUrlAnnotationRepo() || ''
          });
          content.appendChild(repoInput);

          const tokenInput = el('input', {
            type: 'password',
            className: 'obs-select community-annotation-input',
            placeholder: requireToken ? 'GitHub token required' : 'GitHub token (optional for public pull)',
            value: ''
          });
          content.appendChild(tokenInput);

          const rememberRow = el('label', { className: 'legend-help' });
          const remember = el('input', { type: 'checkbox' });
          remember.checked = false;
          rememberRow.appendChild(remember);
          rememberRow.appendChild(document.createTextNode(' Remember token in this browser (localStorage)'));
          content.appendChild(rememberRow);

          const pullRow = el('label', { className: 'legend-help' });
          const pullNow = el('input', { type: 'checkbox' });
          pullNow.checked = defaultPullNow == null ? !requireToken : Boolean(defaultPullNow);
          pullRow.appendChild(pullNow);
          pullRow.appendChild(document.createTextNode(' Pull now after connecting'));
          content.appendChild(pullRow);

          if (existingToken && !requireToken) {
            const hint = el('div', { className: 'legend-help', text: 'A token exists for this repo (not shown).' });
            content.appendChild(hint);
          }

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const connectBtn = el('button', { type: 'button', className: 'btn-small', text: 'Connect' });
          const clearTokenBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear saved token' });
          actions.appendChild(connectBtn);
          actions.appendChild(clearTokenBtn);
          content.appendChild(actions);

          clearTokenBtn.addEventListener('click', () => {
            const parsed = parseOwnerRepo(repoInput.value);
            if (!parsed) {
              status.textContent = 'Enter a valid owner/repo to clear token.';
              return;
            }
            clearSessionPatForRepo(parsed.ownerRepoRef);
            clearPatForRepo(parsed.ownerRepoRef);
            status.textContent = 'Saved token cleared for this repo.';
          });

          connectBtn.addEventListener('click', async () => {
            const parsed = parseOwnerRepo(repoInput.value);
            if (!parsed) {
              status.textContent = 'Invalid repo. Use: owner/repo';
              return;
            }

            const savedForRepo = getEffectivePatForRepo(parsed.ownerRepoRef);
            const token = String(tokenInput.value || '').trim() || (savedForRepo || null);
            if (requireToken && !token) {
              status.textContent = 'Token required.';
              return;
            }

            status.textContent = 'Validating repository...';
            try {
              const sync = new CommunityAnnotationGitHubSync({
                datasetId,
                owner: parsed.owner,
                repo: parsed.repo,
                token,
                branch: parsed.ref || null
              });

              const { config, datasetConfig, datasetId: did } = await sync.validateAndLoadConfig({ datasetId });

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

              setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef);
              setUrlAnnotationRepo(parsed.ownerRepoRef);

              if (token) setSessionPatForRepo(parsed.ownerRepoRef, token);
              if (remember.checked && token) setPatForRepo(parsed.ownerRepoRef, token);

              if (token) {
                const me = await sync.getAuthenticatedUser();
                const login = String(me?.login || '').trim();
                const profile = session.getProfile();
                if (login && (!profile?.username || profile.username === 'local')) {
                  session.setProfile({ ...profile, username: login });
                }
              }

              status.textContent = `Connected to ${parsed.ownerRepoRef}`;
              resolveOnce({ ownerRepo: parsed.ownerRepoRef, token, remembered: remember.checked });

              if (pullNow.checked) {
                content.closest('.community-annotation-modal-overlay')?.remove?.();
                await pullFromGitHub({ tokenOverride: token, repoOverride: parsed.ownerRepoRef, allowReauth: false });
              } else {
                content.closest('.community-annotation-modal-overlay')?.remove?.();
                render();
              }
            } catch (err) {
              const msg = err?.message || 'Failed to connect';
              if (isAuthError(err)) {
                status.textContent = token
                  ? `Access denied (token may be missing repo permissions): ${msg}`
                  : `Repo not found or access denied. If this is a private repo, paste a fine-grained PAT. (${msg})`;
              } else {
                status.textContent = msg;
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
          resolveOnce(null);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function pullFromGitHub({ tokenOverride = null, repoOverride = null, allowReauth = true } = {}) {
    if (syncBusy) return;
    syncBusy = true;
    syncError = null;
    render();

    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const repo = repoOverride || getAnnotationRepoForDataset(datasetId);
    if (!repo) {
      syncBusy = false;
      syncError = 'No annotation repo connected.';
      render();
      return;
    }

    if (repoOverride) {
      // Keep stored mapping consistent with the repo we're about to pull from.
      setAnnotationRepoForDataset(datasetId, repoOverride);
    }

    const trackerId = notifications.loading(`Pulling annotations from ${repo}...`, { category: 'annotation' });

    try {
      if (tokenOverride) setSessionPatForRepo(repo, tokenOverride);
      const sync = getGitHubSyncForDataset({ datasetId, tokenOverride });
      if (!sync) throw new Error('Invalid annotation repo');

      const { datasetConfig } = await sync.validateAndLoadConfig({ datasetId });
      const docs = await sync.pullAllUsers();
      const invalidCount = docs.filter((d) => d && d.__invalid).length;
      const usable = docs.filter((d) => d && !d.__invalid);
      session.mergeFromUserFiles(usable, { preferLocalVotes: true });

      // Optional: auto-enable configured fields for this dataset.
      const fieldsToAnnotate = Array.isArray(datasetConfig?.fieldsToAnnotate) ? datasetConfig.fieldsToAnnotate : [];
      for (const fieldKey of fieldsToAnnotate.slice(0, 50)) {
        session.setFieldAnnotated(fieldKey, true);
      }

      await applyConsensusColumn();

      if (invalidCount) {
        notifications.complete(trackerId, `Pulled with ${invalidCount} invalid user file(s) skipped`);
      } else {
        notifications.complete(trackerId, 'Pulled latest annotations');
      }
    } catch (err) {
      const msg = err?.message || 'Pull failed';
      if (allowReauth && isAuthError(err)) {
        syncError = msg;
        notifications.fail(trackerId, msg);
        syncBusy = false;
        render();
        await connectRepoFlow({
          requireToken: true,
          reason: msg,
          initialOwnerRepo: repo,
          defaultPullNow: true
        });
        return;
      }
      syncError = msg;
      notifications.fail(trackerId, msg);
    } finally {
      syncBusy = false;
      render();
    }
  }

  async function pushToGitHub() {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const repo = getAnnotationRepoForDataset(datasetId);
    if (!repo) {
      syncError = 'No annotation repo connected.';
      render();
      return;
    }

    if (syncBusy) return;
    syncBusy = true;
    syncError = null;
    render();

    let token = getEffectivePatForRepo(repo);
    if (!token) {
      syncBusy = false;
      syncError = 'Token required to push.';
      render();
      const result = await connectRepoFlow({
        requireToken: true,
        reason: 'A fine-grained PAT is required to push your file.',
        initialOwnerRepo: repo,
        defaultPullNow: false
      });
      token = result?.token || getEffectivePatForRepo(repo);
      if (!token) return;

      // Resume after successful token entry.
      syncBusy = true;
      syncError = null;
      render();
    }

    const trackerId = notifications.loading(`Pushing your annotations to ${repo}...`, { category: 'annotation' });

    try {
      const sync = getGitHubSyncForDataset({ datasetId, tokenOverride: token });
      if (!sync) throw new Error('Invalid annotation repo');
      // Ensure branch/config resolves early with auth.
      await sync.validateAndLoadConfig({ datasetId });

      const profile = session.getProfile();
      if (!profile?.username || profile.username === 'local') {
        const me = await sync.getAuthenticatedUser();
        const login = String(me?.login || '').trim();
        if (login) session.setProfile({ ...profile, username: login });
      }

      const updatedProfile = session.getProfile();
      if (!updatedProfile?.username || updatedProfile.username === 'local') {
        throw new Error('Set your handle (GitHub username) before pushing.');
      }

      const doc = session.buildUserFileDocument();
      const lastSyncAt = session.getStateSnapshot()?.lastSyncAt || null;
      try {
        await sync.pushMyUserFile({ userDoc: doc, conflictIfRemoteNewerThan: lastSyncAt });
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
          if (!ok) throw new Error('Push cancelled.');
          await sync.pushMyUserFile({ userDoc: doc, force: true });
        } else {
          throw err;
        }
      }
      session.markSyncedNow();
      notifications.complete(trackerId, 'Pushed your votes/suggestions');
    } catch (err) {
      const msg = err?.message || 'Push failed';
      if (isAuthError(err)) {
        syncError = msg;
        notifications.fail(trackerId, msg);
        syncBusy = false;
        render();
        await connectRepoFlow({
          requireToken: true,
          reason: msg,
          initialOwnerRepo: repo,
          defaultPullNow: false
        });
        return;
      }
      syncError = msg;
      notifications.fail(trackerId, msg);
    } finally {
      syncBusy = false;
      render();
    }
  }

  function render() {
    container.innerHTML = '';

    const hint = el('div', {
      className: 'legend-help',
      text: 'Offline-first voting. Right-click the categorical dropdown to enable/disable fields.'
    });
    container.appendChild(hint);

    // GitHub sync
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const repo = getAnnotationRepoForDataset(datasetId);
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const syncBlock = el('div', { className: 'control-block' });
    syncBlock.appendChild(el('label', { text: 'GitHub sync (PAT):' }));

    const repoLine = el('div', {
      className: 'legend-help',
      text: repo ? `Repo: ${repo}` : 'No annotation repo connected.'
    });
    syncBlock.appendChild(repoLine);

    const syncHelp = el('div', {
      className: 'community-annotation-inline-help',
      text:
        'Connect an annotation repo (annotations/config.json + annotations/users/). ' +
        'For private repos and Push, use a fine-grained PAT (Contents: read/write). ' +
        'Tokens are kept in-memory unless you explicitly choose to save them in this browser.'
    });
    syncBlock.appendChild(syncHelp);

    if (!online) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: 'Offline: GitHub actions are disabled.' }));
    }

    const lastSync = session.getStateSnapshot()?.lastSyncAt || null;
    syncBlock.appendChild(el('div', { className: 'legend-help', text: `Last sync: ${formatTimeLabel(lastSync)}` }));

    if (syncError) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: `⚠ ${syncError}` }));
    }

    const syncActions = el('div', { className: 'community-annotation-sync-actions' });
    const connectBtn = el('button', { type: 'button', className: 'btn-small', text: repo ? 'Change repo' : 'Connect repo' });
    const disconnectBtn = el('button', { type: 'button', className: 'btn-small', text: 'Disconnect' });
    const pullBtn = el('button', { type: 'button', className: 'btn-small', text: syncBusy ? 'Working...' : 'Pull' });
    const pushBtn = el('button', { type: 'button', className: 'btn-small', text: syncBusy ? 'Working...' : 'Push' });
    syncActions.appendChild(connectBtn);
    syncActions.appendChild(disconnectBtn);
    syncActions.appendChild(pullBtn);
    syncActions.appendChild(pushBtn);

    disconnectBtn.disabled = !repo || syncBusy;
    pullBtn.disabled = !repo || syncBusy || !online;
    pushBtn.disabled = !repo || syncBusy || !online;

    connectBtn.title = 'Connect an annotation repo (owner/repo or owner/repo@branch).';
    disconnectBtn.title = repo ? 'Disconnect this dataset from the annotation repo.' : 'Connect a repo first.';
    pullBtn.title = !repo ? 'Connect a repo first.' : (!online ? 'Offline.' : 'Fetch latest user files from GitHub and merge into your session.');
    pushBtn.title = !repo ? 'Connect a repo first.' : (!online ? 'Offline.' : 'Upload your user file to GitHub (requires PAT + write access).');

    connectBtn.addEventListener('click', () => connectRepoFlow({ requireToken: false }));
    disconnectBtn.addEventListener('click', () => {
      clearAnnotationRepoForDataset(datasetId);
      if (repo) clearSessionPatForRepo(repo);
      if (repo) setUrlAnnotationRepo(null);
      syncError = null;
      render();
    });
    pullBtn.addEventListener('click', () => pullFromGitHub());
    pushBtn.addEventListener('click', () => pushToGitHub());

    syncBlock.appendChild(syncActions);

    const consensusBlock = el('div', { className: 'control-block' });
    consensusBlock.appendChild(el('label', { text: 'Consensus column key:' }));
    const consensusKeyInput = el('input', { type: 'text', className: 'obs-select community-annotation-input', value: consensusColumnKey });
    consensusKeyInput.addEventListener('change', () => {
      consensusColumnKey = String(consensusKeyInput.value || '').trim() || 'community_cell_type';
      consensusKeyInput.value = consensusColumnKey;
    });
    consensusBlock.appendChild(consensusKeyInput);
    const applyBtn = el('button', { type: 'button', className: 'btn-small', text: 'Apply consensus to dataset' });
    applyBtn.disabled = syncBusy;
    applyBtn.addEventListener('click', () => applyConsensusColumn());
    consensusBlock.appendChild(applyBtn);
    consensusBlock.appendChild(el('div', {
      className: 'community-annotation-inline-help',
      text: 'Creates/updates a derived categorical obs column based on current consensus status (Consensus/Disputed/Pending).'
    }));

    container.appendChild(syncBlock);
    container.appendChild(consensusBlock);

    // Profile
    const profile = session.getProfile();
    const profileBlock = el('div', { className: 'control-block' });
    profileBlock.appendChild(el('label', { text: 'Your handle:' }));
    const usernameInput = el('input', {
      type: 'text',
      className: 'obs-select community-annotation-input',
      value: profile.username || 'local',
      placeholder: 'local'
    });
    usernameInput.addEventListener('change', () => {
      const next = String(usernameInput.value || '').trim() || 'local';
      session.setProfile({ ...profile, username: next });
      notifications.success(`Using @${next}`, { category: 'annotation', duration: 2000 });
    });
    profileBlock.appendChild(usernameInput);
    container.appendChild(profileBlock);

    // Controls: annotated field selector
    const annotated = session.getAnnotatedFields();
    const fields = (state.getFields?.() || []).filter((f) => f?.kind === 'category');
    const availableKeys = new Set(fields.map((f) => f.key));
    const eligible = annotated.filter((k) => availableKeys.has(k));

    const fieldBlock = el('div', { className: 'control-block' });
    fieldBlock.appendChild(el('label', { text: 'Annotating field:' }));
    const select = el('select', { className: 'obs-select' });
    select.appendChild(el('option', { value: '', text: eligible.length ? '(select)' : '(none enabled)' }));
    for (const key of eligible) {
      select.appendChild(el('option', { value: key, text: key }));
    }
    if (selectedFieldKey && eligible.includes(selectedFieldKey)) select.value = selectedFieldKey;
    else if (eligible.length === 1) select.value = eligible[0];

    select.addEventListener('change', () => {
      selectedFieldKey = select.value || null;
      render();
    });
    fieldBlock.appendChild(select);

    const active = state.getActiveField?.() || null;
    const enableBtn = el('button', {
      type: 'button',
      className: 'btn-small',
      text: active?.kind === 'category' ? 'Enable for active categorical field' : 'Select a categorical field first',
    });
    enableBtn.disabled = !(active?.kind === 'category' && active?.key);
    enableBtn.addEventListener('click', () => {
      if (!(active?.kind === 'category' && active?.key)) return;
      session.setFieldAnnotated(active.key, true);
      selectedFieldKey = active.key;
      notifications.success(`Enabled annotation for "${active.key}"`, { category: 'annotation', duration: 2500 });
    });
    fieldBlock.appendChild(enableBtn);
    container.appendChild(fieldBlock);

    // Consensus settings
    const settings = el('div', { className: 'control-block community-annotation-settings' });
    settings.appendChild(el('label', { text: 'Consensus threshold:' }));
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
      render();
    });
    const thresholdRow = el('div', { className: 'slider-row' }, [thresholdInput, thresholdDisplay]);
    settings.appendChild(thresholdRow);

    settings.appendChild(el('label', { text: 'Min annotators:' }));
    const minInput = el('input', { type: 'number', className: 'obs-select', value: String(minAnnotators), min: '1', max: '50', step: '1' });
    minInput.addEventListener('change', () => {
      minAnnotators = clampInt(Number(minInput.value), 1, 50);
      minInput.value = String(minAnnotators);
      render();
    });
    settings.appendChild(minInput);
    container.appendChild(settings);

    if (!selectedFieldKey) {
      const empty = el('div', { className: 'legend-help', text: 'Enable at least one categorical field to begin.' });
      container.appendChild(empty);
      return;
    }

    const field = findCategoricalFieldByKey(state, selectedFieldKey);
    if (!field) {
      container.appendChild(el('div', { className: 'legend-help', text: 'Selected field not available in this dataset.' }));
      return;
    }

    const categories = field.categories || [];
    const progress = computeProgress(session, selectedFieldKey, categories);

    const progressRow = el('div', { className: 'community-annotation-progress' });
    progressRow.appendChild(el('div', { className: 'community-annotation-progress-label', text: `Progress: ${progress.done}/${progress.total}` }));
    const bar = el('div', { className: 'community-annotation-progress-bar' });
    const fill = el('div', { className: 'community-annotation-progress-fill' });
    const pct = progress.total > 0 ? progress.done / progress.total : 0;
    fill.style.width = `${Math.round(pct * 100)}%`;
    bar.appendChild(fill);
    progressRow.appendChild(bar);
    container.appendChild(progressRow);

    // Cluster list
    const list = el('div', { className: 'community-annotation-cluster-list' });
    for (let catIdx = 0; catIdx < categories.length; catIdx++) {
      const catLabel = String(categories[catIdx] ?? `cluster_${catIdx}`);
      const consensus = session.computeConsensus(selectedFieldKey, catIdx, { minAnnotators, threshold: consensusThreshold });

      const row = el('div', { className: 'community-annotation-cluster-row' });
      row.appendChild(el('div', { className: 'community-annotation-cluster-name', text: catLabel }));

      const statusText =
        consensus.status === 'consensus'
          ? `${consensus.label || 'Consensus'} ✓`
          : consensus.status === 'disputed'
            ? 'Disputed ⚠'
            : 'Pending';
      row.appendChild(el('div', { className: `community-annotation-cluster-status status-${consensus.status}`, text: statusText }));

      const meta = el('div', {
        className: 'community-annotation-cluster-meta',
        text: `net ${consensus.netVotes} • voters ${consensus.voters}`
      });
      row.appendChild(meta);

      const manageBtn = el('button', { type: 'button', className: 'btn-small', text: 'Vote' });
      manageBtn.addEventListener('click', () => {
        const title = `${selectedFieldKey} • ${catLabel}`;
        showClusterModal({
          title,
          buildContent: (content) => {
            const header = el('div', { className: 'legend-help', text: 'Add suggestions and vote. All changes are local-only.' });
            content.appendChild(header);

            const suggestionsContainer = el('div', { className: 'community-annotation-suggestions' });

            const renderSuggestions = () => {
              suggestionsContainer.innerHTML = '';
              const suggestions = session.getSuggestions(selectedFieldKey, catIdx);
              if (!suggestions.length) {
                suggestionsContainer.appendChild(el('div', { className: 'legend-help', text: 'No suggestions yet.' }));
                return;
              }

              suggestions
                .slice()
                .sort((a, b) => ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0)))
                .forEach((s) => {
                  const up = s.upvotes?.length || 0;
                  const down = s.downvotes?.length || 0;
                  const net = up - down;

                  const card = el('div', { className: 'community-annotation-suggestion-card' });
                  const top = el('div', { className: 'community-annotation-suggestion-top' });
                  top.appendChild(el('div', { className: 'community-annotation-suggestion-label', text: s.label }));
                  top.appendChild(el('div', { className: 'community-annotation-suggestion-net', text: `net ${net}` }));
                  card.appendChild(top);

                  if (s.ontologyId) {
                    card.appendChild(el('div', { className: 'community-annotation-suggestion-ontology', text: s.ontologyId }));
                  }
                  if (s.evidence) {
                    card.appendChild(el('div', { className: 'community-annotation-suggestion-evidence', text: s.evidence }));
                  }

                  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
                  const upBtn = el('button', { type: 'button', className: 'btn-small', text: `▲ ${up}` });
                  const downBtn = el('button', { type: 'button', className: 'btn-small', text: `▼ ${down}` });
                  upBtn.addEventListener('click', () => session.vote(selectedFieldKey, catIdx, s.id, 'up'));
                  downBtn.addEventListener('click', () => session.vote(selectedFieldKey, catIdx, s.id, 'down'));
                  actions.appendChild(upBtn);
                  actions.appendChild(downBtn);
                  card.appendChild(actions);

                  const by = el('div', { className: 'legend-help', text: `Proposed by @${s.proposedBy}` });
                  card.appendChild(by);

                  suggestionsContainer.appendChild(card);
                });
            };

            const unsubscribeLocal = session.on('changed', renderSuggestions);
            renderSuggestions();

            content.appendChild(suggestionsContainer);

            const form = el('div', { className: 'community-annotation-new' });
            form.appendChild(el('div', { className: 'community-annotation-new-title', text: 'New suggestion' }));

            const labelInput = el('input', { type: 'text', className: 'obs-select community-annotation-input', placeholder: 'Cell type label (required)' });
            const ontInput = el('input', { type: 'text', className: 'obs-select community-annotation-input', placeholder: 'Ontology id (optional, e.g. CL:0000625)' });
            const evidenceInput = el('textarea', { className: 'obs-select community-annotation-textarea', placeholder: 'Evidence / reasoning (optional)' });
            const submitBtn = el('button', { type: 'button', className: 'btn-small', text: 'Submit suggestion' });

            submitBtn.addEventListener('click', () => {
              try {
                session.addSuggestion(selectedFieldKey, catIdx, {
                  label: labelInput.value,
                  ontologyId: ontInput.value,
                  evidence: evidenceInput.value
                });
                labelInput.value = '';
                ontInput.value = '';
                evidenceInput.value = '';
                notifications.success('Suggestion added', { category: 'annotation', duration: 2000 });
              } catch (err) {
                notifications.error(err?.message || 'Failed to add suggestion', { category: 'annotation' });
              }
            });

            form.appendChild(labelInput);
            form.appendChild(ontInput);
            form.appendChild(evidenceInput);
            form.appendChild(submitBtn);

            content.appendChild(form);

            // Ensure cleanup if modal removed (best-effort).
            const observer = new MutationObserver(() => {
              if (!document.body.contains(content)) {
                unsubscribeLocal?.();
                observer.disconnect();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
          }
        });
      });
      row.appendChild(manageBtn);

      list.appendChild(row);
    }
    container.appendChild(list);
  }

  render();

  return { render, destroy };
}
