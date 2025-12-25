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
import { getGitHubAuthSession, getGitHubLoginUrl, getLastGitHubUserKey, toGitHubUserKey } from '../../community-annotations/github-auth.js';
import {
  getCommunityAnnotationAccessStore,
  isAnnotationRepoConnected,
  isSimulateRepoConnectedEnabled
} from '../../community-annotations/access-store.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import {
  clearAnnotationRepoForDataset,
  getAnnotationRepoForDataset,
  getLastAnnotationRepoForDataset,
  setAnnotationRepoForDataset
} from '../../community-annotations/repo-store.js';
import {
  CommunityAnnotationGitHubSync,
  getGitHubSyncForDataset,
  parseOwnerRepo,
  setDatasetAnnotationRepoFromUrlParam,
  setDatasetAnnotationRepoFromUrlParamAsync
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

function toCleanString(value) {
  return String(value ?? '').trim();
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
  const settings = session.getAnnotatableConsensusSettings?.(fieldKey) || null;
  let done = 0;
  for (let i = 0; i < n; i++) {
    const c = session.computeConsensus(fieldKey, i, settings || undefined);
    if (c.status === 'consensus') done++;
  }
  return { done, total: n };
}

  function showClusterModal({ title, buildContent, modalClassName = '' }) {
    const existing = document.querySelector('.community-annotation-modal-overlay');
    if (existing) existing.remove();

    const overlay = el('div', { className: 'community-annotation-modal-overlay', role: 'dialog', 'aria-modal': 'true' });
    const cls = String(modalClassName || '').trim();
    const modal = el('div', { className: `community-annotation-modal${cls ? ` ${cls}` : ''}`, role: 'document' });

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
  // These settings are ONLY for building the derived "consensus column key" (see CONSENSUS COLUMN KEY accordion).
  // They are independent from per-annotatable voting consensus settings (author-controlled per annotatable field).
  let consensusColumnThreshold = 0.5;
  let consensusColumnMinAnnotators = 1;
  let consensusColumnKey = 'community_cell_type';
  let consensusSourceFieldKey = null;
  let consensusAccordionOpen = false;
  let manageAccordionOpen = false;

  let syncBusy = false;
  let syncError = null;
  let lastRepoInfo = null;
  /** @type {Record<string, {minAnnotators:number, threshold:number}>} */
  const annotatableSettingsDraft = {};
  const annotatableSettingsDirty = new Set();

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

  // Keep this accordion in sync when other modules connect/disconnect the repo,
  // or when dev simulation toggles are changed from the console.
  try {
    if (typeof window !== 'undefined') {
      window.addEventListener(
        ANNOTATION_CONNECTION_CHANGED_EVENT,
        () => {
          applySessionCacheContext({});
          render();
        },
        { signal: tooltipAbort.signal }
      );
    }
  } catch {
    // ignore
  }


  function positionTooltip(button, tooltip) {
    if (!button || !tooltip) return;
    const rect = button.getBoundingClientRect();
    const tooltipHeight = tooltip.offsetHeight || 120;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const gap = 4;

    // Position below button if space, otherwise above
    if (spaceBelow >= tooltipHeight + gap || spaceBelow >= spaceAbove) {
      tooltip.style.top = `${rect.bottom + gap}px`;
      tooltip.style.bottom = 'auto';
    } else {
      tooltip.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      tooltip.style.top = 'auto';
    }

    // Align left with button, constrain to viewport (240px width + 8px margin)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 248));
    tooltip.style.left = `${left}px`;
  }

  /** @type {Array<{btn: HTMLElement, tooltip: HTMLElement}>} */
  const tooltipPairs = [];

  function createInfoTooltip(steps) {
    const btn = el('span', { className: 'info-btn', text: 'i' });
    const tooltip = el('div', { className: 'info-tooltip' });
    const content = el('div', { className: 'info-tooltip-content' });
    const list = Array.isArray(steps) ? steps : [];
    for (const step of list) {
      content.appendChild(el('div', { className: 'info-step', text: String(step) }));
    }
    tooltip.appendChild(content);

    // Track this pair for scroll repositioning
    tooltipPairs.push({ btn, tooltip });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = getComputedStyle(tooltip).display !== 'none';
      // Close other tooltips in the container
      container.querySelectorAll('.info-tooltip').forEach((node) => {
        node.style.display = 'none';
      });
      // Also close any tooltips that were portaled to body
      document.body.querySelectorAll('.info-tooltip').forEach((node) => {
        node.style.display = 'none';
      });
      if (isVisible) {
        tooltip.style.display = 'none';
      } else {
        // Portal to body to escape transform containment
        if (tooltip.parentElement !== document.body) {
          document.body.appendChild(tooltip);
        }
        // Position and show
        positionTooltip(btn, tooltip);
        tooltip.style.display = 'block';
        // Refine position after layout is computed
        requestAnimationFrame(() => positionTooltip(btn, tooltip));
      }
    });

    return { btn, tooltip };
  }

  // Close tooltips on scroll for cleaner UX
  window.addEventListener('scroll', () => {
    for (const { tooltip } of tooltipPairs) {
      if (tooltip) tooltip.style.display = 'none';
    }
  }, { passive: true, capture: true, signal: tooltipAbort.signal });

  function getGitHubLogin() {
    const u = githubAuth.getUser?.() || null;
    return normalizeGitHubUsername(u?.login || '');
  }

  function getCacheUserKey() {
    const key = toGitHubUserKey(githubAuth.getUser?.());
    if (key) return key;
    if (isSimulateRepoConnectedEnabled()) return getLastGitHubUserKey() || 'local';
    const profile = session.getProfile?.() || null;
    return normalizeGitHubUsername(profile?.username || '') || 'local';
  }

  let lastRoleContext = '';
  function applySessionCacheContext({ datasetId = null } = {}) {
    const did = datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null;
    const username = getCacheUserKey();
    let repoRef = getAnnotationRepoForDataset(did, username) || null;
    if (!repoRef && isSimulateRepoConnectedEnabled()) {
      repoRef = getLastAnnotationRepoForDataset(did, username) || null;
    }
    session.setCacheContext?.({ datasetId: did, repoRef, username });

    // Prevent stale role/perms from a different repo/user context.
    const nextRoleContext = `${String(username || 'local').toLowerCase()}::${String(repoRef || '')}`;
    if (nextRoleContext !== lastRoleContext) {
      lastRoleContext = nextRoleContext;
      lastRepoInfo = null;
      access.clearRole?.();
    }
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
    const key = toGitHubUserKey(githubAuth.getUser?.());
    const id = githubAuth.getUser?.()?.id ?? null;
    if (!login || !key) return false;
    await ensureIdentityForUserKey({ userKey: key, login, githubUserId: id, promptIfMissing });
    return true;
  }

  async function loadMyProfileFromGitHub({ datasetId } = {}) {
    const did = datasetId ?? dataSourceManager?.getCurrentDatasetId?.() ?? null;
    const key = toGitHubUserKey(githubAuth.getUser?.());
    const cacheUser = key || 'local';
    const repo = getAnnotationRepoForDataset(did, cacheUser);
    if (!repo) return false;
    if (!githubAuth.isAuthenticated?.()) return false;
    if (!key) return false;
    try {
      const sync = getGitHubSyncForDataset({ datasetId: did, username: cacheUser });
      if (!sync) return false;
      await sync.validateAndLoadConfig({ datasetId: did });
      const resolvedRepoRef = ensureRepoRefHasBranch(repo, sync.branch);
      if (resolvedRepoRef && resolvedRepoRef !== repo) {
        setAnnotationRepoForDataset(did, resolvedRepoRef, cacheUser);
        setUrlAnnotationRepo(resolvedRepoRef);
        session.setCacheContext?.({ datasetId: did, repoRef: resolvedRepoRef, username: cacheUser });
      }
      const mine = await sync.pullUserFile({ userKey: cacheUser });
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

  function normalizeEmail(value) {
    return String(value ?? '').trim();
  }

  function isValidEmailAddress(value) {
    const email = normalizeEmail(value);
    if (!email) return true;
    if (email.length > 254) return false;
    // Pragmatic validation (good UX, avoids false negatives).
    if (/\s/.test(email)) return false;
    const re = /^[^@]+@[^@]+\.[^@]+$/;
    return re.test(email);
  }

	  async function editIdentityFlow({
	    suggestedUsername = null,
	    reason = null
	  } = {}) {
	    const current = session.getProfile();
    const userKey = toGitHubUserKey(githubAuth.getUser?.()) || normalizeGitHubUsername(current?.username || '') || 'local';
    const suggested = normalizeGitHubUsername(suggestedUsername || current?.login || '');
    const remoteFields = userKey ? session.getKnownUserProfile?.(userKey) : null;

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

          function normalizeOrcidId(value) {
            const raw = String(value ?? '').trim().replace(/^https?:\/\/orcid\.org\//i, '');
            const compact = raw.replace(/[\s-]+/g, '').toUpperCase();
            if (!/^\d{15}[\dX]$/.test(compact)) return null;
            const parts = [compact.slice(0, 4), compact.slice(4, 8), compact.slice(8, 12), compact.slice(12, 16)];
            return parts.join('-');
          }

          function isValidOrcidId(orcid) {
            const compact = String(orcid || '').replace(/-/g, '').toUpperCase();
            if (!/^\d{15}[\dX]$/.test(compact)) return false;
            let total = 0;
            for (let i = 0; i < 15; i++) {
              const d = Number(compact[i]);
              if (!Number.isFinite(d)) return false;
              total = (total + d) * 2;
            }
            const remainder = total % 11;
            const result = (12 - remainder) % 11;
            const expected = result === 10 ? 'X' : String(result);
            return expected === compact[15];
          }

          async function lookupOrcidName(orcidId, { signal } = {}) {
            const id = normalizeOrcidId(orcidId);
            if (!id) return { ok: false, message: 'Enter a valid ORCID iD (0000-0000-0000-0000).' };
            if (!isValidOrcidId(id)) return { ok: false, message: 'ORCID iD checksum is invalid.' };
            const url = `https://pub.orcid.org/v3.0/${encodeURIComponent(id)}/person`;
            const res = await fetch(url, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal,
              cache: 'no-store',
              mode: 'cors'
            });
            if (!res.ok) return { ok: false, message: `ORCID lookup failed (HTTP ${res.status}).` };
            const data = await res.json().catch(() => null);
            const given = String(data?.name?.['given-names']?.value || '').trim();
            const family = String(data?.name?.['family-name']?.value || '').trim();
            const full = [given, family].filter(Boolean).join(' ').trim();
            return { ok: true, name: full || null, orcid: id };
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

          content.appendChild(el('label', { className: 'legend-help', text: 'Email:' }));
          const emailInput = el('input', {
            type: 'email',
            className: 'community-annotation-text-input',
            name: 'email',
            autocomplete: 'email',
            autocorrect: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
            inputmode: 'email',
            placeholder: 'name@domain.com',
            value: current?.email || remoteFields?.email || ''
          });
          content.appendChild(emailInput);

          function normalizeLinkedInHandle(value) {
            const raw = String(value ?? '').trim();
            if (!raw) return '';
            const noAt = raw.replace(/^@+/, '').trim();
            if (/linkedin\.com/i.test(noAt)) {
              try {
                const url = new URL(noAt.startsWith('http') ? noAt : `https://${noAt.replace(/^\/+/, '')}`);
                const host = String(url.hostname || '').toLowerCase();
                if (!host.endsWith('linkedin.com')) return '';
                const parts = String(url.pathname || '')
                  .split('/')
                  .map((p) => p.trim())
                  .filter(Boolean);
                const idx = parts.findIndex((p) => p === 'in' || p === 'pub');
                const handle = idx >= 0 ? (parts[idx + 1] || '') : '';
                return normalizeLinkedInHandle(handle);
              } catch {
                return '';
              }
            }
            const handle = noAt.replace(/\/+$/, '').trim().toLowerCase();
            if (!handle) return '';
            if (!/^[a-z0-9-]{3,120}$/.test(handle)) return '';
            return handle;
          }

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
	            try {
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
	            } catch {
	              // ignore
	            }
	          };

	          const renderSuggestions = (items, { loading = false, emptyMessage = '' } = {}) => {
	            suggestionBox.innerHTML = '';
	            suggestionBox.style.display = 'none';
	            if (loading) {
	              // Keep silent: show nothing while searching.
	              return;
	            }
	            const list = Array.isArray(items) ? items : [];
	            if (!list.length) {
	              return;
	            }
	            for (const item of list.slice(0, 8)) {
              const name = String(item?.name || '').trim();
              const orcid = String(item?.orcid || '').trim();
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
	            try {
	              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(positionSuggest);
	              else setTimeout(positionSuggest, 0);
	              setTimeout(positionSuggest, 60);
	            } catch { /* ignore */ }
	          };

          const parseExpandedSearch = (data) => {
            const results = Array.isArray(data?.['expanded-result']) ? data['expanded-result'] : [];
            const out = [];
            for (const r of results.slice(0, 20)) {
              const orcid = normalizeOrcidId(r?.['orcid-id'] || r?.orcid || r?.orcidId || '');
              if (!orcid) continue;
              const given = String(r?.['given-names'] || r?.givenNames || '').trim();
              const family = String(r?.['family-names'] || r?.familyNames || '').trim();
              const name = [given, family].filter(Boolean).join(' ').trim() || null;
              out.push({ orcid, name });
            }
            return out;
          };

          const parseSearch = (data) => {
            const results = Array.isArray(data?.result) ? data.result : [];
            const out = [];
            for (const r of results.slice(0, 20)) {
              const path = toCleanString(r?.['orcid-identifier']?.path || r?.orcidIdentifier?.path || '');
              const orcid = normalizeOrcidId(path);
              if (!orcid) continue;
              const given = toCleanString(r?.person?.name?.['given-names']?.value || r?.person?.name?.givenNames?.value || '');
              const family = toCleanString(r?.person?.name?.['family-name']?.value || r?.person?.name?.familyName?.value || '');
              const name = [given, family].filter(Boolean).join(' ').trim() || null;
              out.push({ orcid, name });
            }
            return out;
          };

	          async function searchOrcid(query, { signal } = {}) {
	            const q = String(query || '').trim();
	            if (!q) return [];

	            // Small in-memory cache for snappy UX (per modal open).
	            const key = q.toLowerCase();
	            const cached = orcidSearchCache.get(key);
	            if (cached && Date.now() - cached.at < 60_000) return cached.items;

	            // If the query looks like an ORCID iD (even partial), prefer direct lookup when it's complete & valid.
	            const asId = normalizeOrcidId(q);
	            if (asId && isValidOrcidId(asId)) {
	              const direct = await lookupOrcidName(asId, { signal });
	              if (direct?.ok) {
	                const items = [{ orcid: direct.orcid, name: direct.name || null }];
	                orcidSearchCache.set(key, { at: Date.now(), items });
	                return items;
	              }
	              return [];
	            }

	            // Otherwise, do a public search.
	            const base = 'https://pub.orcid.org/v3.0';
	            const candidates = [
	              `${base}/expanded-search/?q=${encodeURIComponent(q)}`,
	              `${base}/expanded-search/?q=${encodeURIComponent(`"${q}"`)}`,
	              `${base}/search/?q=${encodeURIComponent(q)}`
	            ];

	            /** @type {{orcid:string, name:string|null}[]} */
	            const seen = new Set();
	            const merged = [];
	            const settled = await Promise.allSettled(
	              candidates.map(async (url) => {
	                const res = await fetch(url, {
	                  method: 'GET',
	                  headers: { Accept: 'application/json' },
	                  signal,
	                  cache: 'no-store',
	                  mode: 'cors'
	                });
	                if (!res.ok) return [];
	                const data = await res.json().catch(() => null);
	                return (data && typeof data === 'object' && data['expanded-result'])
	                  ? parseExpandedSearch(data)
	                  : parseSearch(data);
	              })
	            );
	            for (const s of settled) {
	              if (s.status !== 'fulfilled') continue;
	              const list = Array.isArray(s.value) ? s.value : [];
	              for (const item of list) {
	                const k = `${item.orcid}`;
	                if (seen.has(k)) continue;
	                seen.add(k);
	                merged.push(item);
	                if (merged.length >= 8) break;
	              }
	              if (merged.length >= 8) break;
	            }
	            const out = merged.slice(0, 8);
	            orcidSearchCache.set(key, { at: Date.now(), items: out });
	            return out;
	          }

	          let searchTimer = null;
	          let activeSearch = null;
	          let lastQuery = '';
	          const orcidSearchCache = new Map();
		          const scheduleSearch = (query) => {
		            const q = String(query || '').trim();
		            if (q === lastQuery) return;
		            lastQuery = q;
            if (searchTimer) clearTimeout(searchTimer);
            try { activeSearch?.abort?.(); } catch { /* ignore */ }

	            if (!q || q.length < 3) {
	              renderSuggestions([], { loading: false, emptyMessage: '' });
	              return;
	            }

	            searchTimer = setTimeout(async () => {
	              const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
	              activeSearch = ctrl;
	              renderSuggestions([], { loading: true });
	              const timeout = setTimeout(() => ctrl?.abort?.(), 6500);
	              try {
	                const items = await searchOrcid(q, { signal: ctrl?.signal });
	                if (!items.length) {
	                  renderSuggestions([], { loading: false, emptyMessage: '' });
	                  return;
	                }
	                renderSuggestions(items, { loading: false });
	              } catch (err) {
	                if (err?.name === 'AbortError') {
	                  renderSuggestions([], { loading: false, emptyMessage: '' });
	                } else {
	                  renderSuggestions([], { loading: false, emptyMessage: '' });
	                }
	              } finally {
	                clearTimeout(timeout);
	              }
		            }, 250);
		          };

          const onAnyInput = () => {
            const qId = String(orcidInput.value || '').trim();
            const qName = String(nameInput.value || '').trim();
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
	          try {
	            const scroller = content.closest('.community-annotation-modal-body');
	            scroller?.addEventListener?.('scroll', () => {
	              if (suggestionBox.style.display !== 'none') positionSuggest();
	            }, { passive: true });
	            window.addEventListener('resize', () => {
	              if (suggestionBox.style.display !== 'none') positionSuggest();
	            }, { passive: true });
	          } catch {
	            // ignore
	          }
	          orcidInput.addEventListener('blur', () => {
	            const normalized = normalizeOrcidId(orcidInput.value || '');
	            if (normalized) orcidInput.value = normalized;
	          });

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const saveBtn = el('button', { type: 'button', className: 'btn-small', text: 'Save' });
          const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });
          actions.appendChild(saveBtn);
          actions.appendChild(cancelBtn);
          content.appendChild(actions);

	          cancelBtn.addEventListener('click', () => {
	            content.closest('.community-annotation-modal-overlay')?.remove?.();
	            resolveOnce(null);
	          });

          saveBtn.addEventListener('click', () => {
            const login = suggested;
            if (!login) {
              status.textContent = 'Sign in with GitHub first.';
              return;
            }
            const email = normalizeEmail(emailInput.value || '');
            if (email && !isValidEmailAddress(email)) {
              status.textContent = 'Email looks invalid.';
              try { emailInput.focus(); } catch { /* ignore */ }
              return;
            }
            const normalizedOrcid = normalizeOrcidId(orcidInput.value || '') || String(orcidInput.value || '').trim();
            const normalizedLinkedin = normalizeLinkedInHandle(linkedinInput.value || '');
            if (linkedinInput.value && !normalizedLinkedin) {
              status.textContent = 'LinkedIn username must be a handle like "kemalinecik" (no URL).';
              try { linkedinInput.focus(); } catch { /* ignore */ }
              return;
            }
            const nextProfile = {
              ...current,
              username: userKey,
              login,
              displayName: String(nameInput.value || '').trim(),
              title: String(titleInput.value || '').trim(),
              orcid: normalizedOrcid,
              linkedin: normalizedLinkedin,
              email
            };
            session.setProfile(nextProfile);
            content.closest('.community-annotation-modal-overlay')?.remove?.();
            resolveOnce({ username: userKey, dismissed: false });
          });

          // Normalize linkedin on blur (handle only).
	          linkedinInput.addEventListener('blur', () => {
	            const normalized = normalizeLinkedInHandle(linkedinInput.value || '');
	            if (normalized || !String(linkedinInput.value || '').trim()) linkedinInput.value = normalized;
	          });
	        }
	      });

	      const overlay = modalRef?.overlay || null;
	      if (!overlay) return;
	      if (orcidSuggestPopupEl) {
	        try {
	          overlay.appendChild(orcidSuggestPopupEl);
	        } catch {
	          // ignore
	        }
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
    const u = normalizeGitHubUsername(userKey);
    const l = normalizeGitHubUsername(login);
    if (!u) return false;
    const current = session.getProfile();
    session.setProfile({ ...current, username: u, login: l, githubUserId });
    if (promptIfMissing) {
      const after = session.getProfile();
      const hasAny = Boolean(after.displayName || after.title || after.orcid || after.linkedin || after.email);
      if (!hasAny) await editIdentityFlow({ suggestedUsername: l });
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
    if (paramRepo && (githubAuth.isAuthenticated?.() || isSimulateRepoConnectedEnabled())) {
      const username = getCacheUserKey();
      const parsed = parseOwnerRepo(paramRepo);
      // If no @branch is provided, resolve "HEAD" (default branch) using GitHub API before persisting.
      if (parsed && !parsed.ref) {
        (async () => {
          try {
            const ok = await setDatasetAnnotationRepoFromUrlParamAsync({ datasetId, urlParamValue: paramRepo, username });
            if (!ok) return;
            applySessionCacheContext({ datasetId });
            render();
          } catch {
            // ignore
          }
        })();
      } else {
        try {
          setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue: paramRepo, username });
          applySessionCacheContext({ datasetId });
        } catch {
          // ignore
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

  const unsubscribeAuth = githubAuth.on?.('changed', () => {
    // Clear auth-related errors and update identity UI quickly.
    syncError = null;
    if (!githubAuth.isAuthenticated?.()) {
      const current = session.getProfile();
      const fallbackUserKey = isSimulateRepoConnectedEnabled() ? (getLastGitHubUserKey() || 'local') : 'local';
      session.setProfile({ ...current, username: fallbackUserKey, login: '', githubUserId: null, displayName: '', title: '', orcid: '', linkedin: '', email: '' });
      lastRepoInfo = null;
      access.clearRole?.();
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
    const cacheUser = getCacheUserKey();
    const currentRepo = getAnnotationRepoForDataset(datasetId, cacheUser) || getUrlAnnotationRepo() || null;

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
            className: 'community-annotation-text-input',
            autocomplete: 'off',
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
              setAnnotationRepoForDataset(datasetId, resolvedRepoRef, cacheUser);
              session.setCacheContext?.({ datasetId, repoRef: resolvedRepoRef, username: cacheUser });
              setUrlAnnotationRepo(resolvedRepoRef);
              await ensureIdentityForUserKey({ userKey: cacheUser, login, githubUserId: githubAuth.getUser?.()?.id ?? null, promptIfMissing: true });
              await loadMyProfileFromGitHub({ datasetId });

      // Apply configured fields for this dataset on connect (author-controlled).
      const configured = new Set(Array.isArray(datasetConfig?.fieldsToAnnotate) ? datasetConfig.fieldsToAnnotate : []);
      const configSettings = (datasetConfig?.annotatableSettings && typeof datasetConfig.annotatableSettings === 'object')
        ? datasetConfig.annotatableSettings
        : null;
      const configClosed = Array.isArray(datasetConfig?.closedFields) ? datasetConfig.closedFields : [];
      const catFields = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
      const allKeys = catFields.map((f) => f.key).filter(Boolean);
      for (const key of allKeys) {
        session.setFieldAnnotated(key, configured.has(key));
      }
      if (configSettings && session.setAnnotatableConsensusSettingsMap) {
        session.setAnnotatableConsensusSettingsMap(configSettings);
      }
      session.setClosedAnnotatableFields?.(configClosed);

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
    const cacheUser = getCacheUserKey();
    const repo = repoOverride || getAnnotationRepoForDataset(datasetId, cacheUser);
    if (!repo) {
      syncBusy = false;
      syncError = 'No annotation repo connected.';
      render();
      await connectRepoFlow({ reason: 'Choose a repo to Pull from.', defaultPullNow: true });
      return;
    }

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
      const resolvedRepoRef = ensureRepoRefHasBranch(repo, sync.branch) || repo;
      if (resolvedRepoRef !== repo) {
        setAnnotationRepoForDataset(datasetId, resolvedRepoRef, cacheUser);
        setUrlAnnotationRepo(resolvedRepoRef);
      } else if (repoOverride) {
        // Keep stored mapping consistent with the repo we're pulling from.
        setAnnotationRepoForDataset(datasetId, resolvedRepoRef, cacheUser);
      }
      // Ensure local cache key uses (datasetId, repo, branch, user) with the resolved default branch.
      session.setCacheContext?.({ datasetId, repoRef: resolvedRepoRef, username: cacheUser });
      const knownShas = session.getRemoteFileShas?.() || null;
      const pullResult = await sync.pullAllUsers({ knownShas });
      const docs = pullResult?.docs || [];
      if (pullResult?.shas) session.setRemoteFileShas?.(pullResult.shas);
      const invalidCount = docs.filter((d) => d && d.__invalid).length;
      const usable = docs.filter((d) => d && !d.__invalid);

      // Optional: moderation merges (author-maintained) - load before merging user docs so
      // vote/comment "family" logic uses the latest merge mapping.
      try {
        const known = session.getRemoteFileShas?.() || null;
        const localMerges = session.getModerationMerges?.() || [];
        const allowCacheSkip = Array.isArray(localMerges) && localMerges.length > 0;
        const res = await sync.pullModerationMerges({ knownShas: allowCacheSkip ? known : null });
        if (res?.sha) session.setRemoteFileSha?.(res.path || 'annotations/moderation/merges.json', res.sha);
        if (res?.doc) session.setModerationMergesFromDoc(res.doc);
      } catch {
        // ignore
      }

      session.mergeFromUserFiles(usable, { preferLocalVotes: true });

      // Apply configured fields for this dataset (author-controlled).
      const configured = new Set(Array.isArray(datasetConfig?.fieldsToAnnotate) ? datasetConfig.fieldsToAnnotate : []);
      const configSettings = (datasetConfig?.annotatableSettings && typeof datasetConfig.annotatableSettings === 'object')
        ? datasetConfig.annotatableSettings
        : null;
      const configClosed = Array.isArray(datasetConfig?.closedFields) ? datasetConfig.closedFields : [];
      const catFields = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
      const allKeys = catFields.map((f) => f.key).filter(Boolean);
      for (const key of allKeys) {
        session.setFieldAnnotated(key, configured.has(key));
      }
      if (configSettings && session.setAnnotatableConsensusSettingsMap) {
        session.setAnnotatableConsensusSettingsMap(configSettings);
      }
      session.setClosedAnnotatableFields?.(configClosed);

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
	    const cacheUser = getCacheUserKey();
	    const repo = getAnnotationRepoForDataset(datasetId, cacheUser);
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
      const sync = getGitHubSyncForDataset({ datasetId, username: cacheUser });
      if (!sync) throw new Error('Invalid annotation repo');
      // Ensure branch/config resolves early with auth.
      const { repoInfo } = await sync.validateAndLoadConfig({ datasetId });
      lastRepoInfo = repoInfo || null;
      access.setRoleFromRepoInfo(lastRepoInfo);
      const resolvedRepoRef = ensureRepoRefHasBranch(repo, sync.branch) || repo;
      if (resolvedRepoRef !== repo) {
        setAnnotationRepoForDataset(datasetId, resolvedRepoRef, cacheUser);
        setUrlAnnotationRepo(resolvedRepoRef);
      }
      // Ensure local cache key uses (datasetId, repo, branch, user) with the resolved default branch.
      session.setCacheContext?.({ datasetId, repoRef: resolvedRepoRef, username: cacheUser });

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
          const annotatableSettings = session.getAnnotatableConsensusSettingsMap?.() || {};
          const closedFields = session.getClosedAnnotatableFields?.() || [];
          const res = await sync.updateDatasetFieldsToAnnotate({ datasetId, fieldsToAnnotate, annotatableSettings, closedFields });
          configUpdated = Boolean(res?.changed);
        } catch (err) {
          errors.push(err?.message || 'Failed to publish annotatable columns');
        }

        try {
          const merges = session.getModerationMerges?.() || [];
          if (Array.isArray(merges)) {
            const res = await sync.pushModerationMerges({ mergesDoc: session.buildModerationMergesDocument() });
            if (res?.path && res?.sha) session.setRemoteFileSha?.(res.path, res.sha);
            mergesPublished = Boolean(res?.changed);
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
          const label = result?.reused ? 'Updated Pull Request' : 'Opened Pull Request';
          notifications.complete(trackerId, prUrl ? `${label}: ${prUrl}` : label);
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
            const label = result?.reused ? 'Updated Pull Request' : 'Opened Pull Request';
            notifications.complete(trackerId, prUrl ? `${label}: ${prUrl}` : label);
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

    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const cacheUsername = getCacheUserKey();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUsername);
    const repoConnectedForGating = isAnnotationRepoConnected(datasetId, cacheUsername);
    if (!repoConnectedForGating) {
      const introBlock = el('div', { className: 'control-block relative' });
      const introInfo = createInfoTooltip([
        'Connect an annotation repo to enable community voting and GitHub sync.',
        'Voting UI is hidden elsewhere until a repo is connected.'
      ]);
      introBlock.appendChild(el('label', { className: 'd-flex items-center gap-1' }, [
        'Community annotation',
        introInfo.btn
      ]));
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
    const introInfo = createInfoTooltip([
      'Offline-first: votes/suggestions are saved locally first.',
      'Annotatable columns are chosen by repo authors (maintain/admin) via the annotation repo config.',
      'Connecting an annotation repo is required to participate (voting UI is hidden otherwise).',
      'Pull/Publish to GitHub is optional after connecting.'
    ]);
    introBlock.appendChild(el('label', { className: 'd-flex items-center gap-1' }, [
      'Community voting',
      introInfo.btn
    ]));
    introBlock.appendChild(introInfo.tooltip);
    introBlock.appendChild(el('div', { className: 'legend-help', text: 'Votes and suggestions are saved locally; connecting a repo is required (GitHub Pull/Publish is optional).' }));
    container.appendChild(introBlock);

    // GitHub sync
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const isAuthed = Boolean(githubAuth.isAuthenticated?.());
    const authedUser = githubAuth.getUser?.() || null;
    const login = normalizeGitHubUsername(authedUser?.login || '');
    const syncBlock = el('div', { className: 'control-block relative' });
    const syncInfo = createInfoTooltip([
      'Sign in: authenticate via GitHub App (token stored in sessionStorage; cleared on tab close).',
      'Manage access: install the app on more repos, or revoke it in GitHub settings.',
      'Choose repo: pick from repos where the app is installed for you (no manual entry).',
      'Pull: fetch latest `annotations/users/ghid_*.json` from GitHub and merge locally.',
      'Publish: push your `annotations/users/ghid_<id>.json` (direct push if allowed, otherwise a fork + PR).',
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
          ? 'Access: Annotator (non-admin)'
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

    signInOutBtn.disabled = syncBusy || !online;
    manageBtn.disabled = syncBusy || !online;
    connectBtn.disabled = syncBusy || !online;
    disconnectBtn.disabled = !repo || syncBusy;
    pullBtn.disabled = !repo || !isAuthed || syncBusy || !online;
    publishBtn.disabled = !repo || !isAuthed || syncBusy || !online;

    signInOutBtn.title = isAuthed ? 'Clear session token and sign out.' : 'Sign in with GitHub App authentication.';
    manageBtn.title = 'Install the app on more repos, or revoke access.';
    connectBtn.title = 'Choose a repo where the app is installed.';
    disconnectBtn.title = repo ? 'Disconnect this dataset from the annotation repo.' : 'Choose a repo first.';
    pullBtn.title = !repo
      ? 'Choose a repo first.'
      : (!online ? 'Offline.' : (!isAuthed ? 'Sign in first.' : 'Fetch latest user files from GitHub and merge into your session.'));
    publishBtn.title = !repo
      ? 'Choose a repo first.'
      : (!online ? 'Offline.' : (!isAuthed
        ? 'Sign in first.'
        : 'Publish pushes directly if you have write access; otherwise it creates a Pull Request from your fork.'));

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
      lastRepoInfo = null;
      access.clearRole?.();
      render();
    });
    pullBtn.addEventListener('click', () => pullFromGitHub());
    publishBtn.addEventListener('click', () => pushToGitHub());
    syncBlock.appendChild(syncActions);

    // Keep the panel minimal unless a repo is connected (or dev-simulated).
    // This avoids showing lots of offline controls that depend on repo config/roles.
    if (!repoConnectedForGating) {
      container.appendChild(syncBlock);
      return;
    }

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
    const srcWrap = el('div', { className: 'field-select relative' });
    const consensusInfo = createInfoTooltip([
      'Builds a derived categorical obs column based on current voting results (visualization convenience).',
      'These threshold/min settings only affect this derived column, not the voting rules.',
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
	      'Your GitHub username comes from sign-in.'
	    ]);
    identityBlock.appendChild(el('label', { className: 'd-flex items-center gap-1' }, ['Profile (optional)', identityInfo.btn]));
    identityBlock.appendChild(identityInfo.tooltip);

    const authedLogin = getGitHubLogin();
    // Allow editing when signed in OR when dev override is enabled
    const canEdit = Boolean(githubAuth.isAuthenticated?.() && authedLogin) || isSimulateRepoConnectedEnabled();
    const identityText = canEdit
      ? session.formatUserAttribution(authedLogin || 'local')
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
      session.setProfile({ ...profile, login: loginOrLocal, displayName: '', title: '', orcid: '', linkedin: '', email: '' });
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
    const canManageAnnotatable = hasSelection && access.isAuthor();
    const showManageSection = access.isAuthor();

    if (showManageSection) {
      const manageBlock = el('div', { className: 'control-block relative' });

      const manageAccordion = el('div', { className: 'analysis-accordion' });
      const manageItem = el('div', { className: manageAccordionOpen ? 'analysis-accordion-item open' : 'analysis-accordion-item' });
      const manageHeaderBtn = el('div', {
        className: 'analysis-accordion-header',
        role: 'button',
        tabIndex: '0',
        'aria-expanded': String(manageAccordionOpen)
      }, [
        el('span', { className: 'analysis-accordion-title', text: 'MANAGE ANNOTATION' }),
        el('span', { className: 'analysis-accordion-desc', text: 'Add/remove columns from annotation (author)' }),
        el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
      ]);
      const manageContent = el('div', { className: 'analysis-accordion-content' });

      const toggleManageOpen = () => {
        const isOpen = manageItem.classList.toggle('open');
        manageAccordionOpen = isOpen;
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
        const closed = enabled ? Boolean(session.isFieldClosed?.(key)) : false;
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
      const isClosed = isAnnotatable ? Boolean(session.isFieldClosed?.(selectedFieldKey)) : false;
      const closeBtn = isAnnotatable
        ? el('button', {
          type: 'button',
          className: 'btn-small',
          text: isClosed ? 'Reopen' : 'Close',
          title: isClosed ? 'Reopen this annotatable column for community voting.' : 'Close this annotatable column (read-only for annotators).',
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
          const next = !Boolean(session.isFieldClosed?.(selectedFieldKey));
          session.setFieldClosed?.(selectedFieldKey, next);
          notifications.success(next ? `Closed "${selectedFieldKey}"` : `Reopened "${selectedFieldKey}"`, { category: 'annotation', duration: 2200 });
          render();
        });
        manageActions.appendChild(closeBtn);
      }
      manageContent.appendChild(manageActions);

      // Per-annotatable voting consensus settings (author-controlled, per field; only shown once the field is annotatable).
      if (isAnnotatable) {
        const info = createInfoTooltip([
          'These settings control the voting consensus for this annotatable column (per column).',
          'They are independent from the CONSENSUS COLUMN KEY settings (which only build a derived obs column).',
          'Changes are staged locally until you click Apply; Publish (as author) writes them to annotations/config.json.'
        ]);

        const block = el('div', { className: 'control-block community-annotation-settings relative' });
        block.appendChild(el('div', { className: 'd-flex items-center gap-1' }, [
          el('div', { className: 'legend-help', text: 'Annotatable consensus settings' }),
          info.btn
        ]));
        block.appendChild(info.tooltip);

        const canEditSettings = !repoConnectedForGating || access.isAuthor();
        const applied = session.getAnnotatableConsensusSettings?.(selectedFieldKey) || { minAnnotators: 1, threshold: 0.5 };
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
          session.setAnnotatableConsensusSettings?.(selectedFieldKey, next);
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
