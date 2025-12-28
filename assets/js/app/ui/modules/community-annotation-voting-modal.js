/**
 * @fileoverview Community annotation voting modal.
 *
 * Centralizes the voting/suggestion UX in a modal so we don't render voting UI
 * inline in sidebar accordions/legends.
 *
 * @module ui/modules/community-annotation-voting-modal
 */

import { getNotificationCenter } from '../../notification-center.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import { getCommunityAnnotationAccessStore, isAnnotationRepoConnected } from '../../community-annotations/access-store.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import * as capApi from '../../community-annotations/cap-api.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import { syncCommunityAnnotationCacheContext } from '../../community-annotations/runtime-context.js';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'checked' || k === 'readonly') {
      // Boolean HTML attributes: presence = true, absence = false
      if (v) node.setAttribute(k, '');
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

function describeErrorMessage(err) {
  const msg = toCleanString(err?.message || '');
  if (msg) return msg;
  const fallback = toCleanString(err);
  if (fallback && fallback !== '[object Object]') return fallback;
  return 'Request failed';
}

function truncateForUi(value, maxLen) {
  const s = toCleanString(value);
  const max = Number.isFinite(maxLen) ? Math.max(1, Math.floor(maxLen)) : 12;
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function formatCommentAuthorHandle(session, username, { maxLen = 12 } = {}) {
  const raw = toCleanString(username).replace(/^@+/, '');
  let handle = raw || 'local';
  try {
    const prof = session?.getKnownUserProfile?.(raw);
    const login = toCleanString(prof?.login);
    if (login) handle = login;
  } catch {
    // ignore
  }
  handle = toCleanString(handle).replace(/^@+/, '') || 'local';
  if (/^ghid_\d+$/i.test(handle)) handle = 'unknown';
  return `@${truncateForUi(handle, maxLen)}`;
}

function bucketKey(session, fieldKey, catIdx) {
  try {
    const key = session?.toBucketKey?.(fieldKey, catIdx);
    if (key) return key;
  } catch {
    // ignore
  }
  const f = toCleanString(fieldKey);
  const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
  return `${f}:${idx}`;
}

function resolveMergeTarget(fromId, fromToMap) {
  const start = toCleanString(fromId);
  if (!start) return null;
  let cur = start;
  const seen = new Set([cur]);
  while (fromToMap.has(cur)) {
    const next = toCleanString(fromToMap.get(cur));
    if (!next) break;
    if (seen.has(next)) return null;
    seen.add(next);
    cur = next;
  }
  return cur;
}

function normalizeLabelForCompare(value) {
  return toCleanString(value).toLowerCase().replace(/\s+/g, ' ');
}

function parseMarkerGenesInput(text) {
  const raw = toCleanString(text);
  if (!raw) return null;
  const parts = raw.split(',').map((s) => toCleanString(s)).filter(Boolean);
  if (!parts.length) return null;
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const gene = p.replace(/\s+/g, '');
    if (!gene) continue;
    const cleaned = gene.slice(0, 40);
    const key = cleaned.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 50) break;
  }
  return out.length ? out : null;
}

function markersToGeneList(markers) {
  const list = Array.isArray(markers) ? markers : [];
  const out = [];
  const seen = new Set();
  for (const m of list.slice(0, 200)) {
    let gene = '';
    if (typeof m === 'string') gene = toCleanString(m);
    else if (m && typeof m === 'object') gene = toCleanString(m.gene);
    gene = gene.replace(/\s+/g, '');
    if (!gene) continue;
    const key = gene.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gene);
    if (out.length >= 50) break;
  }
  return out;
}

function markersToDisplayText(markers) {
  const genes = markersToGeneList(markers);
  if (!genes.length) return '';
  const shown = genes.slice(0, 8);
  const suffix = genes.length > shown.length ? ` +${genes.length - shown.length}` : '';
  return `Markers: ${shown.join(', ')}${suffix}`;
}

function markersToInputText(markers) {
  const genes = markersToGeneList(markers);
  return genes.length ? genes.slice(0, 20).join(', ') : '';
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHrs = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHrs / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return '';
  }
}

function createDomId(prefix = 'id') {
  const p = toCleanString(prefix) || 'id';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${p}-${crypto.randomUUID()}`;
    }
  } catch {
    // ignore
  }
  return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function listFocusableElements(root) {
  const container = root || null;
  if (!container || typeof container.querySelectorAll !== 'function') return [];
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
  const nodes = Array.from(container.querySelectorAll(selectors));
  return nodes.filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    try {
      const style = window.getComputedStyle?.(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      return node.getClientRects().length > 0;
    } catch {
      return true;
    }
  });
}

function trapModalFocus({ overlay, modal, close, escCancelSelector = null } = {}) {
  const o = overlay || null;
  const m = modal || null;
  if (!o || !m || typeof o.addEventListener !== 'function') return () => {};

  const onKeyDown = (e) => {
    if (!e) return;
    if (e.key === 'Escape') {
      try {
        if (escCancelSelector) {
          const target = e?.target || null;
          if (target && typeof target.closest === 'function' && target.closest(escCancelSelector)) return;
        }
      } catch {
        // ignore
      }
      try {
        e.preventDefault?.();
        e.stopPropagation?.();
      } catch {
        // ignore
      }
      close?.();
      return;
    }

    if (e.key !== 'Tab') return;

    const focusables = listFocusableElements(m);
    if (!focusables.length) {
      try {
        e.preventDefault?.();
      } catch {
        // ignore
      }
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const containsActive = active && m.contains(active);

    if (e.shiftKey) {
      if (!containsActive || active === first) {
        try {
          e.preventDefault?.();
          last.focus?.();
        } catch {
          // ignore
        }
      }
      return;
    }

    if (!containsActive || active === last) {
      try {
        e.preventDefault?.();
        first.focus?.();
      } catch {
        // ignore
      }
    }
  };

  o.addEventListener('keydown', onKeyDown, true);
  return () => {
    try {
      o.removeEventListener('keydown', onKeyDown, true);
    } catch {
      // ignore
    }
  };
}

// =============================================================================
// CAP Integration UI Components
// =============================================================================

/**
 * Render CAP search results dropdown
 */
function renderCapSearchResults({ results, onSelect, onClose }) {
  const container = el('div', { className: 'cap-search-results' });
  const maxRender = 25;

  if (!results?.length) {
    container.appendChild(el('div', { className: 'cap-search-empty', text: 'No results found in CAP database' }));
  } else {
    for (const result of results.slice(0, maxRender)) {
      const item = el('div', { className: 'cap-search-item' });

      const displayName = toCleanString(result.fullName) || toCleanString(result.ontologyTerm) || toCleanString(result.name);
      const nameRow = el('div', { className: 'cap-search-item-name' });
      nameRow.appendChild(el('span', { text: displayName || '—' }));
      if (result.ontologyTermId) {
        nameRow.appendChild(el('span', { className: 'cap-ontology-id', text: result.ontologyTermId }));
      }
      item.appendChild(nameRow);

      if (result.synonyms?.length) {
        item.appendChild(el('div', { className: 'cap-search-item-synonyms', text: `Synonyms: ${result.synonyms.slice(0, 3).join(', ')}${result.synonyms.length > 3 ? '...' : ''}` }));
      }

      if (result.markerGenes?.length) {
        item.appendChild(el('div', { className: 'cap-search-item-markers', text: `Markers: ${result.markerGenes.slice(0, 5).join(', ')}${result.markerGenes.length > 5 ? '...' : ''}` }));
      }

      item.addEventListener('click', () => {
        onSelect?.(result);
        onClose?.();
      });

      container.appendChild(item);
    }
  }

  const closeBtn = el('button', { type: 'button', className: 'btn-small cap-search-close', text: 'Close' });
  closeBtn.addEventListener('click', () => onClose?.());
  container.appendChild(closeBtn);

  return container;
}

function truncateText(text, maxLen) {
  const s = toCleanString(text);
  if (!s) return '';
  const max = Number.isFinite(maxLen) ? Math.max(0, Math.floor(maxLen)) : 160;
  if (s.length <= max) return s;
  return `${s.slice(0, max).trim()}…`;
}

function autoSizeTextarea(textarea, { minHeightPx = null, maxHeightPx = null } = {}) {
  const el = textarea || null;
  if (!el) return;
  try {
    el.style.height = 'auto';
    const next = Math.max(minHeightPx ?? 0, el.scrollHeight || 0);
    const capped = maxHeightPx != null ? Math.min(next, maxHeightPx) : next;
    el.style.height = `${capped}px`;
    el.style.overflowY = maxHeightPx != null && next > maxHeightPx ? 'auto' : 'hidden';
  } catch {
    // ignore
  }
}

function renderComment({ session, fieldKey, catIdx, suggestionId, comment, canInteract = true, onUpdate }) {
  const isOwn = session.isMyComment(comment?.authorUsername);
  const commentEl = el('div', { className: `community-annotation-comment${isOwn ? ' is-own' : ''}` });

  const header = el('div', { className: 'community-annotation-comment-header' });
  const author = el('span', { className: 'community-annotation-comment-author', text: formatCommentAuthorHandle(session, comment?.authorUsername || '') });
  const time = el('span', { className: 'community-annotation-comment-time' });
  const edited = comment?.editedAt ? ' (edited)' : '';
  time.textContent = formatRelativeTime(comment?.editedAt || comment?.createdAt) + edited;
  header.appendChild(author);
  header.appendChild(time);
  commentEl.appendChild(header);

  const textEl = el('div', { className: 'community-annotation-comment-text', text: comment?.text || '' });
  commentEl.appendChild(textEl);

  if (isOwn && canInteract) {
    const actions = el('div', { className: 'community-annotation-comment-actions' });
    const editBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Edit' });
    const deleteBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Delete' });

    editBtn.addEventListener('click', () => {
      const form = el('div', { className: 'community-annotation-comment-form' });
      const input = el('textarea', {
        className: 'community-annotation-comment-input',
        placeholder: 'Edit comment...',
        maxlength: '500'
      });
      input.value = comment?.text || '';

      const charCounter = el('div', { className: 'community-annotation-char-counter', text: `${input.value.length}/500` });
      input.addEventListener('input', () => {
        charCounter.textContent = `${input.value.length}/500`;
      });

      const formActions = el('div', { className: 'community-annotation-comment-form-actions' });
      const saveBtn = el('button', { type: 'button', className: 'btn-small', text: 'Save' });
      const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });

      saveBtn.addEventListener('click', () => {
        const newText = input.value.trim();
        if (!newText) return;
        const ok = session.editComment(fieldKey, catIdx, suggestionId, comment.id, newText);
        if (ok) {
          getNotificationCenter().success('Comment updated', { category: 'annotation', duration: 1500 });
          onUpdate?.();
        } else {
          getNotificationCenter().error('Failed to update comment', { category: 'annotation' });
        }
      });

      cancelBtn.addEventListener('click', () => onUpdate?.());

      formActions.appendChild(saveBtn);
      formActions.appendChild(cancelBtn);
      form.appendChild(input);
      form.appendChild(charCounter);
      form.appendChild(formActions);

      commentEl.innerHTML = '';
      commentEl.appendChild(form);
      input.focus();
    });

    deleteBtn.addEventListener('click', () => {
      showConfirmDialog({
        title: 'Delete comment?',
        message: 'This will remove your comment. This action cannot be undone.',
        confirmText: 'Delete',
        onConfirm: () => {
          const ok = session.deleteComment(fieldKey, catIdx, suggestionId, comment.id);
          if (ok) {
            getNotificationCenter().success('Comment deleted', { category: 'annotation', duration: 1500 });
            onUpdate?.();
          } else {
            getNotificationCenter().error('Failed to delete comment', { category: 'annotation' });
          }
        }
      });
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    commentEl.appendChild(actions);
  }

  return commentEl;
}

function showModal({ title, buildContent }) {
  const existing = document.querySelector('.community-annotation-modal-overlay');
  if (existing) existing.remove();

  const overlay = el('div', { className: 'community-annotation-modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const modal = el('div', { className: 'community-annotation-modal', role: 'document' });

  const header = el('div', { className: 'community-annotation-modal-header' });
  const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Community voting' });
  const titleId = createDomId('community-annotation-voting-title');
  titleEl.id = titleId;
  overlay.setAttribute('aria-labelledby', titleId);
  header.appendChild(titleEl);
  const closeBtn = el('button', { type: 'button', className: 'btn-small community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });
  buildContent?.(content);

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  const prevFocus = document.activeElement;
  let closed = false;
  let cleanupTrap = null;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      cleanupTrap?.();
    } catch {
      // ignore
    }
    overlay.remove();
    try {
      prevFocus?.focus?.();
    } catch {
      // ignore
    }
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  cleanupTrap = trapModalFocus({ overlay, modal, close });
  closeBtn.focus?.();

  return { close, overlay, modal, content };
}

/** @type {{close?: Function} | null} */
let activeSecondaryModal = null;

/** @type {null | {fieldKey:string, catIdx:number, suggestionId:string}} */
let activeSuggestionMergeDrag = null;

function renderMergeRow({ session, fieldKey, catIdx, merge, idToLabel, canDetach }) {
  const fromId = toCleanString(merge?.fromSuggestionId);
  const intoId = toCleanString(merge?.intoSuggestionId);
  const fromLabel = idToLabel?.get(fromId) || fromId || '—';
  const intoLabel = idToLabel?.get(intoId) || intoId || '—';
  const byKey = toCleanString(merge?.by);
  const at = toCleanString(merge?.at);
  const editedAt = toCleanString(merge?.editedAt);
  const noteText = toCleanString(merge?.note);
  const isOwn = byKey ? session.isMyComment(byKey) : false;
  let currentNote = noteText;
  const buildMeta = () => [
    byKey ? session.formatUserAttribution(byKey) : null,
    (() => {
      const t = editedAt || at;
      if (!t) return null;
      const rel = formatRelativeTime(t) || t;
      return `${rel}${editedAt ? ' (edited)' : ''}`;
    })(),
    currentNote ? `“${currentNote}”` : null
  ].filter(Boolean).join(' • ');

  const row = el('div', { className: 'community-annotation-merge-row' });
  row.appendChild(el('div', { className: 'community-annotation-merge-desc', text: `${fromLabel} → ${intoLabel}` }));
  const metaEl = buildMeta() || (canDetach && isOwn)
    ? el('div', { className: 'community-annotation-merge-meta', text: buildMeta() || '' })
    : null;
  if (metaEl) row.appendChild(metaEl);

  if (canDetach && fromId) {
    const actions = el('div', { className: 'community-annotation-merge-actions' });

    const renderMetaDisplay = () => {
      if (!metaEl) return;
      metaEl.innerHTML = '';
      metaEl.textContent = buildMeta() || '';
      metaEl.dataset.mode = 'display';

      if (isOwn) {
        const editBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Edit' });
        editBtn.addEventListener('click', () => enterNoteEdit());
        const deleteBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Delete' });
        deleteBtn.style.display = currentNote ? '' : 'none';
        deleteBtn.addEventListener('click', () => {
          showConfirmDialog({
            title: 'Delete merge note?',
            message: 'This will remove the note text, but keep the merge.',
            confirmText: 'Delete',
            onConfirm: () => {
              const ok = session.editModerationMergeNote?.({ fieldKey, catIdx, fromSuggestionId: fromId, note: null });
              if (ok) {
                currentNote = '';
                getNotificationCenter().success('Merge note deleted (local moderation)', { category: 'annotation', duration: 1800 });
                renderMetaDisplay();
              } else {
                getNotificationCenter().error('Unable to delete merge note', { category: 'annotation' });
              }
            }
          });
        });
        const links = el('span', { className: 'community-annotation-inline-action-links' }, [editBtn, deleteBtn]);
        metaEl.appendChild(links);
      }
    };

    const enterNoteEdit = () => {
      if (!metaEl) return;
      if (metaEl.dataset.mode === 'edit') {
        renderMetaDisplay();
        return;
      }

      metaEl.dataset.mode = 'edit';
      metaEl.innerHTML = '';
      const inputWrap = el('div', { className: 'community-annotation-comment-bar-wrap community-annotation-comment-bar-wrap--edit' });
      const input = el('textarea', {
        className: 'community-annotation-comment-bar community-annotation-comment-bar--edit',
        maxlength: '512',
        rows: '1',
        placeholder: 'Merge note (optional)…',
        'data-esc-cancel': 'true',
        title: 'Enter to save • Esc to cancel'
      });
      input.value = currentNote;

      const charCounter = el('div', {
        className: 'community-annotation-char-counter community-annotation-char-counter--overlay',
        text: `${input.value.length}/512`
      });

      const resize = () => {
        const cs = getComputedStyle(input);
        const minHeight = Number.parseFloat(cs.minHeight || '') || null;
        const maxHeight = Number.parseFloat(cs.maxHeight || '') || null;
        autoSizeTextarea(input, { minHeightPx: minHeight, maxHeightPx: maxHeight });
      };

      const save = () => {
        const nextNote = toCleanString(input.value) || null;
        const ok = session.editModerationMergeNote?.({ fieldKey, catIdx, fromSuggestionId: fromId, note: nextNote });
        if (ok) {
          currentNote = toCleanString(nextNote || '');
          getNotificationCenter().success('Merge note updated (local moderation)', { category: 'annotation', duration: 1800 });
          renderMetaDisplay();
        } else {
          getNotificationCenter().error('Unable to update merge note', { category: 'annotation' });
        }
      };

      input.addEventListener('input', () => {
        charCounter.textContent = `${input.value.length}/512`;
        resize();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          try {
            e.preventDefault?.();
            e.stopPropagation?.();
          } catch {
            // ignore
          }
          renderMetaDisplay();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          try {
            e.preventDefault?.();
            e.stopPropagation?.();
          } catch {
            // ignore
          }
          save();
        }
      });

      inputWrap.appendChild(input);
      inputWrap.appendChild(charCounter);
      metaEl.appendChild(inputWrap);
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resize);
        else setTimeout(resize, 0);
      } catch {
        // ignore
      }
      input.focus?.();
    };

    const detachBtn = el('button', { type: 'button', className: 'btn-small', text: 'Detach' });
    detachBtn.addEventListener('click', () => {
      showConfirmDialog({
        title: 'Detach merge?',
        message: `Detach "${fromLabel}" from its merged bundle?`,
        confirmText: 'Detach',
        onConfirm: () => {
          const ok = session.detachModerationMerge?.({ fieldKey, catIdx, fromSuggestionId: fromId });
          if (ok) getNotificationCenter().success('Detached (local moderation)', { category: 'annotation', duration: 2200 });
          else getNotificationCenter().error('Unable to detach', { category: 'annotation' });
        }
      });
    });
    actions.appendChild(detachBtn);
    row.appendChild(actions);

    renderMetaDisplay();
  }

  return row;
}

function showSecondaryModal({ title, buildContent, session = null }) {
  try {
    activeSecondaryModal?.close?.();
  } catch {
    // ignore
  }
  activeSecondaryModal = null;

  const overlay = el('div', { className: 'community-annotation-secondary-overlay', role: 'dialog', 'aria-modal': 'true' });
  const modal = el('div', { className: 'community-annotation-modal community-annotation-secondary-modal', role: 'document' });

  const header = el('div', { className: 'community-annotation-modal-header' });
  const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Details' });
  const titleId = createDomId('community-annotation-secondary-title');
  titleEl.id = titleId;
  overlay.setAttribute('aria-labelledby', titleId);
  header.appendChild(titleEl);
  const closeBtn = el('button', { type: 'button', className: 'btn-small community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  let unsubscribe = null;
  let ownerObserver = null;
  const ownerOverlay = document.querySelector('.community-annotation-modal-overlay');

  const render = () => {
    content.innerHTML = '';
    try {
      buildContent?.(content, { close });
    } catch {
      // ignore
    }
  };

  const close = () => {
    try {
      unsubscribe?.();
    } catch {
      // ignore
    }
    try {
      ownerObserver?.disconnect?.();
    } catch {
      // ignore
    }
    try { cleanupTrap?.(); } catch { /* ignore */ }
    overlay.remove();
    if (activeSecondaryModal?.close === close) activeSecondaryModal = null;
    try { prevFocus?.focus?.(); } catch { /* ignore */ }
  };

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const prevFocus = document.activeElement;
  const cleanupTrap = trapModalFocus({ overlay, modal, close, escCancelSelector: '[data-esc-cancel="true"]' });

  document.body.appendChild(overlay);
  closeBtn.focus?.();

  if (session && typeof session.on === 'function') {
    unsubscribe = session.on('changed', () => render());
  }

  try {
    if (ownerOverlay && typeof MutationObserver !== 'undefined') {
      ownerObserver = new MutationObserver(() => {
        if (!document.body.contains(ownerOverlay)) close();
      });
      ownerObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch {
    // ignore
  }

  render();

  activeSecondaryModal = { close };
  return { close, overlay, modal, content };
}

function openMergedSuggestionsModal({ session, fieldKey, catIdx, targetSuggestionId }) {
  const access = getCommunityAnnotationAccessStore();
  const isClosed = session.isFieldClosed?.(fieldKey) === true;
  const canInteract = !isClosed || access.isAuthor();

  showSecondaryModal({
    title: 'Merged suggestions',
    session,
    buildContent: (content) => {
      const bucket = bucketKey(session, fieldKey, catIdx);
      const mergesAll = session.getModerationMerges?.() || [];
      const merges = Array.isArray(mergesAll) ? mergesAll.filter((m) => toCleanString(m?.bucket) === bucket) : [];

      const all = session.getSuggestions?.(fieldKey, catIdx) || [];
      const target = (Array.isArray(all) ? all : []).find((s) => toCleanString(s?.id) === toCleanString(targetSuggestionId)) || null;
      const mergedFrom = Array.isArray(target?.mergedFrom) ? target.mergedFrom : [];

      if (!target || !mergedFrom.length) {
        content.appendChild(el('div', { className: 'legend-help', text: 'No merged suggestions for this bundle.' }));
        return;
      }

      const canDetach = access.isAuthor();

      const idToLabel = new Map();
      try {
        const tid = toCleanString(target?.id);
        if (tid) idToLabel.set(tid, toCleanString(target?.label) || tid);
        for (const s of mergedFrom) {
          const id = toCleanString(s?.id);
          if (!id) continue;
          idToLabel.set(id, toCleanString(s?.label) || id);
        }
      } catch {
        // ignore
      }
      try {
        const snap = session.getStateSnapshot?.() || null;
        const raw = snap?.suggestions?.[bucket] || [];
        for (const s of (Array.isArray(raw) ? raw : []).slice(0, 5000)) {
          const id = toCleanString(s?.id);
          if (!id || idToLabel.has(id)) continue;
          idToLabel.set(id, toCleanString(s?.label) || id);
        }
      } catch {
        // ignore
      }

      const targetId = toCleanString(target?.id);
      content.appendChild(el('div', { className: 'community-annotation-inline-help', text: `Bundle: ${toCleanString(target?.label) || '—'}` }));
      content.appendChild(el('div', {
        className: 'legend-help',
        text:
          `Bundle total (de-duplicated per user): ▲${target.upvotes?.length || 0} ▼${target.downvotes?.length || 0}. ` +
          'Cards below keep their own comments; merge rows show the chain and optional notes.'
      }));
      content.appendChild(el('div', {
        className: 'legend-help',
        text: 'If you have no direct vote on the bundle main card, your bundle vote is delegated from member votes (majority; ties = none) and shown with a dashed badge.'
      }));

      // Effective mapping (one active merge per from id).
      const fromTo = new Map();
      const mergeByFrom = new Map();
      for (const m of merges) {
        const from = toCleanString(m?.fromSuggestionId);
        const into = toCleanString(m?.intoSuggestionId);
        if (!from || !into || from === into) continue;
        fromTo.set(from, into);
        mergeByFrom.set(from, m);
      }

      // Which "from" ids resolve into this bundle target?
      const includedFromIds = [];
      for (const fromId of fromTo.keys()) {
        const resolved = resolveMergeTarget(fromId, fromTo) || fromId;
        if (resolved === targetId) includedFromIds.push(fromId);
      }
      const includedFromSet = new Set(includedFromIds);

      // Roots: merged suggestions that aren't the "into" of another included merge.
      const intoSet = new Set();
      for (const fromId of includedFromIds) {
        const into = toCleanString(fromTo.get(fromId));
        if (into) intoSet.add(into);
      }
      const roots = includedFromIds.filter((fromId) => !intoSet.has(fromId));
      roots.sort((a, b) => String(idToLabel.get(a) || a).localeCompare(String(idToLabel.get(b) || b)));

      const suggestionById = new Map();
      if (targetId) suggestionById.set(targetId, target);
      for (const s of mergedFrom) {
        const id = toCleanString(s?.id);
        if (!id) continue;
        suggestionById.set(id, s);
      }

      const list = el('div', { className: 'community-annotation-suggestions' });
      const renderedCards = new Set();
      const renderedMergeFrom = new Set();

      const renderCard = (id) => {
        const sid = toCleanString(id);
        if (!sid || renderedCards.has(sid)) return;
        const s = suggestionById.get(sid) || null;
        if (!s) return;
        renderedCards.add(sid);
        list.appendChild(renderSuggestionCard({
          session,
          fieldKey,
          catIdx,
          suggestion: s,
          canInteract,
          duplicateLabelKeys: null,
          variant: 'full',
          showMergedBundleRow: false,
          allowModerationDrag: false,
          voteDisplayMode: sid === targetId ? 'bundle' : 'direct'
        }));
      };

      const renderChainFrom = (rootId) => {
        let cur = toCleanString(rootId);
        const seen = new Set();
        while (cur && !seen.has(cur) && cur !== targetId && includedFromSet.has(cur)) {
          seen.add(cur);
          renderCard(cur);

          const merge = mergeByFrom.get(cur) || null;
          if (merge) {
            renderedMergeFrom.add(cur);
            list.appendChild(renderMergeRow({ session, fieldKey, catIdx, merge, idToLabel, canDetach }));
          }

          cur = toCleanString(fromTo.get(cur));
        }
        if (cur && cur !== targetId) renderCard(cur);
      };

      for (const root of roots) renderChainFrom(root);

      // Fallback: any included merges not reached by roots (cycles/odd graphs).
      for (const fromId of includedFromIds) {
        const from = toCleanString(fromId);
        if (from) renderCard(from);
        const merge = mergeByFrom.get(fromId) || null;
        if (merge && !renderedMergeFrom.has(fromId)) {
          list.appendChild(renderMergeRow({ session, fieldKey, catIdx, merge, idToLabel, canDetach }));
          renderedMergeFrom.add(fromId);
        }
        const into = toCleanString(fromTo.get(fromId));
        if (into && into !== targetId) renderCard(into);
      }

      // Always render the target card last for context.
      renderCard(targetId);

      content.appendChild(list);
    }
  });
}

function renderSuggestionCard({
  session,
  fieldKey,
  catIdx,
  suggestion,
  canInteract = true,
  duplicateLabelKeys = null,
  variant = 'full',
  showMergedBundleRow = true,
  allowModerationDrag = true,
  voteDisplayMode = 'bundle'
}) {
  const isCompact = variant === 'compact';
  const up = suggestion?.upvotes?.length || 0;
  const down = suggestion?.downvotes?.length || 0;
  const net = up - down;
  const directVote = session.getMyVoteDirect?.(fieldKey, catIdx, suggestion?.id) ?? session.getMyVote?.(fieldKey, catIdx, suggestion?.id) ?? null;
  const bundleInfo = voteDisplayMode === 'bundle' && session.getMyBundleVoteInfo
    ? session.getMyBundleVoteInfo(fieldKey, catIdx, suggestion?.id)
    : { vote: directVote, source: directVote ? 'direct' : 'none', delegatedUp: 0, delegatedDown: 0 };
  const myVote = bundleInfo?.vote || null;
  const isDelegated = bundleInfo?.source === 'delegated';
  const delegatedUp = Number(bundleInfo?.delegatedUp || 0);
  const delegatedDown = Number(bundleInfo?.delegatedDown || 0);
  const isDelegationTie = bundleInfo?.source === 'none' && !myVote && (delegatedUp + delegatedDown) > 0;
  const access = getCommunityAnnotationAccessStore();
  const canModerate = access.isAuthor();
  const myUser = toCleanString(session.getProfile?.()?.username || '').replace(/^@+/, '').toLowerCase();
  const proposer = toCleanString(suggestion?.proposedBy || '').replace(/^@+/, '').toLowerCase();
  const isMine = Boolean(myUser && proposer && myUser === proposer);

  const card = el('div', { className: 'community-annotation-suggestion-card' });
  const labelKey = normalizeLabelForCompare(suggestion?.label || '');
  const isDuplicate = Boolean(labelKey && duplicateLabelKeys && duplicateLabelKeys.has(labelKey));
  if (isDuplicate) card.classList.add('is-duplicate-label');
  const top = el('div', { className: 'community-annotation-suggestion-top' });
  top.appendChild(el('div', { className: 'community-annotation-suggestion-label', text: suggestion?.label || '' }));
  top.appendChild(el('div', { className: 'community-annotation-suggestion-net', text: `net ${net}` }));
  card.appendChild(top);

  if ((isDelegated && (myVote === 'up' || myVote === 'down')) || isDelegationTie) {
    const icon = isDelegationTie ? '±' : (myVote === 'up' ? '▲' : '▼');
    const label = isDelegationTie ? 'Delegation tie' : (myVote === 'up' ? 'Delegated upvote' : 'Delegated downvote');
    const detail = (delegatedUp || delegatedDown) ? ` (${delegatedUp}▲ / ${delegatedDown}▼)` : '';
    card.appendChild(el('div', {
      className: `community-annotation-delegated-vote ${isDelegationTie ? 'delegated-tie' : `delegated-${myVote}`}`,
      text: `${icon} ${label}${detail}`
    }));
  }

  if (isDuplicate) {
    card.appendChild(el('div', {
      className: 'community-annotation-dup-note',
      text: canModerate ? 'Duplicate label (drag to merge if needed).' : 'Duplicate label (votes may be split).'
    }));
  }

  const meta = el('div', { className: 'community-annotation-suggestion-meta' });
  const ontologyId = toCleanString(suggestion?.ontologyId || '');
  meta.appendChild(el('div', { className: 'community-annotation-suggestion-ontology', text: `Ontology: ${ontologyId || '—'}` }));

  const markers = markersToGeneList(suggestion?.markers);
  const markerSummary = markers.length ? `${markers.slice(0, 10).join(', ')}${markers.length > 10 ? ` +${markers.length - 10}` : ''}` : '—';
  meta.appendChild(el('div', { className: 'legend-help', text: `Markers: ${markerSummary}` }));

  const evidence = toCleanString(suggestion?.evidence || '');
  const evidenceShort = evidence ? truncateText(evidence, 220) : '';
  const evidenceText = evidenceShort || '—';
  const evidenceRow = el('div', { className: 'community-annotation-suggestion-evidence', text: `Evidence: ${evidenceText}` });
  meta.appendChild(evidenceRow);
  if (evidence && evidenceShort !== evidence) {
    const moreBtn = el('button', { type: 'button', className: 'community-annotation-merged-comment-btn', text: 'View full evidence' });
    moreBtn.addEventListener('click', () => {
      showSecondaryModal({
        title: 'Evidence',
        session: null,
        buildContent: (content) => {
          content.appendChild(el('div', { className: 'community-annotation-inline-help', text: toCleanString(suggestion?.label) || 'Suggestion' }));
          content.appendChild(el('div', { className: 'community-annotation-dashed-box', text: evidence }));
        }
      });
    });
    meta.appendChild(moreBtn);
  }

  card.appendChild(meta);

  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
  const upBtn = el('button', { type: 'button', className: 'btn-small community-annotation-vote-btn vote-up', text: `▲ ${up}`, disabled: !canInteract });
  const downBtn = el('button', { type: 'button', className: 'btn-small community-annotation-vote-btn vote-down', text: `▼ ${down}`, disabled: !canInteract });
  if (myVote === 'up') upBtn.classList.add('is-mine');
  if (myVote === 'down') downBtn.classList.add('is-mine');
  if (isDelegated) {
    if (myVote === 'up') upBtn.classList.add('is-delegated');
    if (myVote === 'down') downBtn.classList.add('is-delegated');
  }

  if (canInteract) {
    upBtn.addEventListener('click', () => {
      session.vote(fieldKey, catIdx, suggestion.id, 'up');
    });
    downBtn.addEventListener('click', () => {
      session.vote(fieldKey, catIdx, suggestion.id, 'down');
    });
  }
  actions.appendChild(upBtn);
  actions.appendChild(downBtn);

  let editBox = null;
  if (!isCompact && isMine && canInteract) {
    const editBtn = el('button', { type: 'button', className: 'btn-small', text: 'Edit' });

    editBox = el('div', { className: 'community-annotation-dashed-box', style: 'display: none; margin-top: 8px;' });
    editBox.appendChild(el('div', { className: 'community-annotation-new-title', text: 'Edit suggestion' }));

    const editForm = el('div', { className: 'community-annotation-new community-annotation-new-vertical' });
    const labelInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Label (required)', maxlength: '120' });
    const ontInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Ontology id (optional, e.g. CL:0000625)', maxlength: '64' });
    const markerGenesInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Marker genes (optional, comma-separated)' });
    const evidenceInput = el('textarea', { className: 'community-annotation-text-input community-annotation-textarea', placeholder: 'Evidence (optional)', maxlength: '2000' });

    const populateFromSuggestion = () => {
      labelInput.value = suggestion?.label || '';
      ontInput.value = suggestion?.ontologyId || '';
      markerGenesInput.value = markersToInputText(suggestion?.markers);
      evidenceInput.value = suggestion?.evidence || '';
    };

    const editActions = el('div', { className: 'community-annotation-suggestion-actions' });
    const saveBtn = el('button', { type: 'button', className: 'btn-small', text: 'Save' });
    const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });
    editActions.appendChild(saveBtn);
    editActions.appendChild(cancelBtn);

    saveBtn.addEventListener('click', () => {
      try {
        const markers = parseMarkerGenesInput(markerGenesInput.value);
        session.editMySuggestion?.(fieldKey, catIdx, suggestion?.id, {
          label: labelInput.value,
          ontologyId: ontInput.value,
          evidence: evidenceInput.value,
          markers
        });
        getNotificationCenter().success('Suggestion updated', { category: 'annotation', duration: 1500 });
        editBox.style.display = 'none';
        editBtn.textContent = 'Edit';
      } catch (err) {
        getNotificationCenter().error(err?.message || 'Failed to update suggestion', { category: 'annotation' });
      }
    });

    cancelBtn.addEventListener('click', () => {
      editBox.style.display = 'none';
      editBtn.textContent = 'Edit';
      populateFromSuggestion();
    });

    editBtn.addEventListener('click', () => {
      const open = editBox.style.display === 'none';
      if (open) populateFromSuggestion();
      editBox.style.display = open ? '' : 'none';
      editBtn.textContent = open ? 'Hide edit' : 'Edit';
      if (open) labelInput.focus?.();
    });

    editForm.appendChild(labelInput);
    editForm.appendChild(ontInput);
    editForm.appendChild(markerGenesInput);
    editForm.appendChild(evidenceInput);
    editForm.appendChild(editActions);
    editBox.appendChild(editForm);

    actions.appendChild(editBtn);

    const delBtn = el('button', { type: 'button', className: 'btn-small', text: 'Delete' });
    delBtn.addEventListener('click', () => {
      showConfirmDialog({
        title: 'Delete your suggestion?',
        message:
          `This will remove your suggestion "${toCleanString(suggestion?.label) || ''}" from the community list once you Publish.\n\n` +
          `Your local vote/comment data for this suggestion will also be removed.`,
        confirmText: 'Delete',
        onConfirm: () => {
          const ok = session.deleteMySuggestion?.(fieldKey, catIdx, suggestion?.id);
          if (ok) {
            getNotificationCenter().success('Suggestion deleted (local)', { category: 'annotation', duration: 1800 });
          } else {
            getNotificationCenter().error('Unable to delete this suggestion', { category: 'annotation' });
          }
        }
      });
    });
    actions.appendChild(delBtn);
  }

  card.appendChild(actions);
  if (editBox) card.appendChild(editBox);

  const by = el('div', { className: 'legend-help', text: session.formatUserAttribution(suggestion?.proposedBy || '') });
  card.appendChild(by);

  const mergedFrom = Array.isArray(suggestion?.mergedFrom) ? suggestion.mergedFrom : [];
  if (!isCompact && showMergedBundleRow && mergedFrom.length && suggestion?.id) {
    const bundleRow = el('div', { className: 'community-annotation-bundle-row' });
    bundleRow.appendChild(el('div', {
      className: 'legend-help',
      text: `Merged bundle (${mergedFrom.length + 1} suggestions) • votes de-duplicated`
    }));
    const mergedBtn = el('button', {
      type: 'button',
      className: 'community-annotation-merged-comment-btn',
      text: `View merged (${mergedFrom.length})`,
      title: 'View original votes and comments for merged suggestions'
    });
    mergedBtn.addEventListener('click', () => {
      openMergedSuggestionsModal({ session, fieldKey, catIdx, targetSuggestionId: suggestion.id });
    });
    bundleRow.appendChild(mergedBtn);
    card.appendChild(bundleRow);
  }

  const comments = (() => {
    try {
      const list = session.getComments?.(fieldKey, catIdx, suggestion?.id) || [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  })();
  if (!isCompact && suggestion?.id) {
    const commentsBox = el('div', { className: 'community-annotation-comments-inline' });

    const input = el('textarea', {
      className: 'community-annotation-comment-bar',
      placeholder: canInteract ? 'Write a comment and press Enter…' : 'Comments are disabled (closed by author).',
      maxlength: '500',
      rows: '1',
      disabled: !canInteract
    });
    const charCounter = el('div', {
      className: 'community-annotation-char-counter community-annotation-char-counter--overlay',
      text: `${input.value.length}/500`
    });
    const resizeInput = () => {
      const cs = getComputedStyle(input);
      const minHeight = Number.parseFloat(cs.minHeight || '') || null;
      const maxHeight = Number.parseFloat(cs.maxHeight || '') || null;
      autoSizeTextarea(input, { minHeightPx: minHeight, maxHeightPx: maxHeight });
    };
    input.addEventListener('input', () => {
      charCounter.textContent = `${input.value.length}/500`;
      resizeInput();
    });
    input.addEventListener('keydown', (e) => {
      if (!canInteract) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const text = toCleanString(input.value);
      if (!text) return;
      const id = session.addComment?.(fieldKey, catIdx, suggestion.id, text);
      if (id) {
        input.value = '';
        charCounter.textContent = '0/500';
        resizeInput();
        getNotificationCenter().success('Comment added', { category: 'annotation', duration: 1200 });
      } else {
        getNotificationCenter().error('Failed to add comment', { category: 'annotation' });
      }
    });
    const inputWrap = el('div', { className: 'community-annotation-comment-bar-wrap' });
    inputWrap.appendChild(input);
    inputWrap.appendChild(charCounter);
    commentsBox.appendChild(inputWrap);
    try {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resizeInput);
      else setTimeout(resizeInput, 0);
    } catch {
      // ignore
    }

    const sorted = comments
      .slice()
      .sort((a, b) => toCleanString(b?.createdAt || '').localeCompare(toCleanString(a?.createdAt || '')));

    const scroll = el('div', { className: 'community-annotation-comments-scroll' });
    for (const c of sorted.slice(0, 1000)) {
      const author = toCleanString(c?.authorUsername || '') || 'local';
      const time = toCleanString(c?.editedAt || c?.createdAt || '');
      const metaText = `${formatCommentAuthorHandle(session, author)}${time ? ` • ${formatRelativeTime(time)}` : ''}`;
      const isOwn = session.isMyComment(author);

      const item = el('div', { className: 'community-annotation-comment-preview-item' });
      item.appendChild(el('span', { className: 'community-annotation-comment-preview-meta', text: metaText }));

      const body = el('div', { style: 'flex: 1; min-width: 0;' });
      let currentText = toCleanString(c?.text || '');
      let isEditing = false;

      const editBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Edit' });
      const deleteBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Delete' });
      const inlineActions = el('span', { className: 'community-annotation-inline-action-links' }, [
        editBtn,
        deleteBtn
      ]);

      const renderPreview = () => {
        isEditing = false;
        body.innerHTML = '';
        const textWrap = el('span', { className: 'community-annotation-comment-preview-text' }, [currentText]);
        if (isOwn && canInteract) textWrap.appendChild(inlineActions);
        body.appendChild(textWrap);
      };

      const renderEdit = () => {
        isEditing = true;
        body.innerHTML = '';

        const inputWrap = el('div', { className: 'community-annotation-comment-bar-wrap community-annotation-comment-bar-wrap--edit' });
        const input = el('textarea', {
          className: 'community-annotation-comment-bar community-annotation-comment-bar--edit',
          placeholder: 'Edit comment…',
          maxlength: '500',
          rows: '1',
          'data-esc-cancel': 'true',
          title: 'Enter to save • Esc to cancel'
        });
        input.value = currentText;
        const counter = el('div', {
          className: 'community-annotation-char-counter community-annotation-char-counter--overlay',
          text: `${input.value.length}/500`
        });

        const resize = () => {
          const cs = getComputedStyle(input);
          const minHeight = Number.parseFloat(cs.minHeight || '') || null;
          const maxHeight = Number.parseFloat(cs.maxHeight || '') || null;
          autoSizeTextarea(input, { minHeightPx: minHeight, maxHeightPx: maxHeight });
        };

        const save = () => {
          const nextText = toCleanString(input.value);
          if (!nextText) return;
          const ok = session.editComment?.(fieldKey, catIdx, suggestion.id, c?.id, nextText);
          if (ok) {
            currentText = nextText;
            getNotificationCenter().success('Comment updated', { category: 'annotation', duration: 1500 });
            renderPreview();
          } else {
            getNotificationCenter().error('Failed to update comment', { category: 'annotation' });
          }
        };

        input.addEventListener('input', () => {
          counter.textContent = `${input.value.length}/500`;
          resize();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            try {
              e.preventDefault?.();
              e.stopPropagation?.();
            } catch {
              // ignore
            }
            renderPreview();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            try {
              e.preventDefault?.();
              e.stopPropagation?.();
            } catch {
              // ignore
            }
            save();
          }
        });

        inputWrap.appendChild(input);
        inputWrap.appendChild(counter);
        body.appendChild(inputWrap);
        try {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resize);
          else setTimeout(resize, 0);
        } catch {
          // ignore
        }
        input.focus?.();
      };

      if (isOwn && canInteract) {
        editBtn.addEventListener('click', () => {
          if (isEditing) return;
          renderEdit();
        });

        deleteBtn.addEventListener('click', () => {
          if (isEditing) return;
          showConfirmDialog({
            title: 'Delete comment?',
            message: 'This will remove your comment. This action cannot be undone.',
            confirmText: 'Delete',
            onConfirm: () => {
              const ok = session.deleteComment?.(fieldKey, catIdx, suggestion.id, c?.id);
              if (ok) {
                getNotificationCenter().success('Comment deleted', { category: 'annotation', duration: 1500 });
              } else {
                getNotificationCenter().error('Failed to delete comment', { category: 'annotation' });
              }
            }
          });
        });
      }

      renderPreview();
      item.appendChild(body);
      scroll.appendChild(item);
    }
    const updateScrollFade = () => {
      try {
        const scrollable = scroll.scrollHeight > scroll.clientHeight + 1;
        scroll.classList.toggle('is-scrollable', scrollable);
        if (!scrollable) {
          scroll.classList.remove('is-at-bottom');
          return;
        }
        const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
        scroll.classList.toggle('is-at-bottom', atBottom);
      } catch {
        // ignore
      }
    };
    scroll.addEventListener('scroll', updateScrollFade, { passive: true });
    try {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(updateScrollFade);
      else setTimeout(updateScrollFade, 0);
      setTimeout(updateScrollFade, 60);
    } catch {
      // ignore
    }
    commentsBox.appendChild(scroll);
    card.appendChild(commentsBox);
  }

  if (!isCompact && allowModerationDrag && canModerate && suggestion?.id) {
    card.draggable = true;
    card.classList.add('community-annotation-moderation-draggable');
    card.title = 'Drag this suggestion onto another suggestion to merge (author-only).';
    card.addEventListener('dragstart', (e) => {
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(
          'application/x-cellucid-suggestion-merge',
          JSON.stringify({ fieldKey, catIdx, suggestionId: suggestion.id, label: suggestion?.label || '' })
        );
        activeSuggestionMergeDrag = { fieldKey: toCleanString(fieldKey), catIdx: Number(catIdx), suggestionId: String(suggestion.id) };
      } catch {
        // ignore
      }
    });
    card.addEventListener('dragend', () => {
      activeSuggestionMergeDrag = null;
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('is-merge-target');
      try {
        e.dataTransfer.dropEffect = 'move';
      } catch {
        // ignore
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('is-merge-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('is-merge-target');
      let payload = null;
      try {
        payload = JSON.parse(e.dataTransfer.getData('application/x-cellucid-suggestion-merge') || 'null');
      } catch {
        payload = null;
      }
      const fromId = toCleanString(payload?.suggestionId || '');
      const fromLabel = toCleanString(payload?.label || '');
      const intoId = toCleanString(suggestion?.id || '');
      const intoLabel = toCleanString(suggestion?.label || '');
      if (!fromId || !intoId || fromId === intoId) return;
      if (toCleanString(payload?.fieldKey || '') !== toCleanString(fieldKey) || Number(payload?.catIdx) !== Number(catIdx)) return;

      showConfirmDialog({
        title: 'Merge suggestions?',
        message:
          `Merge "${fromLabel || fromId}" into "${intoLabel || intoId}"?\n\n` +
          `Votes will be combined (1 per user). Comments stay separate and can be reviewed via “View merged”.`,
        inputLabel: 'Optional merge note',
        inputPlaceholder: 'Why are these equivalent? (optional)',
        inputMaxLength: 512,
        confirmText: 'Merge',
        onConfirm: (note) => {
          const mergeNote = toCleanString(note || '');
          const ok = session.addModerationMerge({
            fieldKey,
            catIdx,
            fromSuggestionId: fromId,
            intoSuggestionId: intoId,
            note: mergeNote || null
          });
          if (ok) {
            getNotificationCenter().success('Merged suggestions (local moderation)', { category: 'annotation', duration: 2400 });
          } else {
            getNotificationCenter().error('Failed to merge suggestions', { category: 'annotation' });
          }
        }
      });
    });
  }

  return card;
}

function buildVotingDetail({ session, fieldKey, catIdx }) {
  const panel = el('div', { className: 'community-annotation-voting-detail' });

  const access = getCommunityAnnotationAccessStore();
  const isClosed = session.isFieldClosed?.(fieldKey) === true;
  const canInteract = !isClosed || access.isAuthor();
  if (isClosed && !access.isAuthor()) {
    panel.appendChild(el('div', { className: 'legend-help', text: 'Closed by the author (voting disabled).' }));
  }

  const consensusSettings = session.getAnnotatableConsensusSettings?.(fieldKey) || null;
  const consensus = session.computeConsensus(fieldKey, catIdx, consensusSettings || undefined);
  const consensusLine = el('div', { className: `community-annotation-consensus status-${consensus.status}` });
  const label = consensus.label ? `"${consensus.label}"` : '—';
  consensusLine.textContent =
    consensus.status === 'consensus'
      ? `Consensus: ${label} (${Math.round(consensus.confidence * 100)}% • ${consensus.voters} voters)`
      : consensus.status === 'disputed'
        ? `Disputed: ${label} (${Math.round(consensus.confidence * 100)}% • ${consensus.voters} voters)`
        : `Pending (${consensus.voters} voters)`;
  panel.appendChild(consensusLine);

  const suggestions = session
    .getSuggestions(fieldKey, catIdx)
    .slice()
    .sort(
      (a, b) =>
        ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0))
    );

  // Detect duplicate labels (multi-user/offline): votes/comments can be split across duplicate suggestions.
  const labelCounts = new Map();
  for (const s of suggestions) {
    const key = normalizeLabelForCompare(s?.label || '');
    if (!key) continue;
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const duplicateLabelKeys = new Set();
  for (const [k, count] of labelCounts.entries()) {
    if (count > 1) duplicateLabelKeys.add(k);
  }
  if (duplicateLabelKeys.size) {
    const dupSuggestionCount = suggestions.filter((s) => duplicateLabelKeys.has(normalizeLabelForCompare(s?.label || ''))).length;
    panel.appendChild(el('div', {
      className: 'legend-help',
      text:
        `Duplicate labels detected (${dupSuggestionCount} suggestions). ` +
        (access.isAuthor()
          ? 'Drag one duplicate onto the other to merge.'
          : 'Ask the dataset author to merge duplicates so votes combine.')
    }));
  }

  const list = el('div', { className: 'community-annotation-suggestions' });
  if (!suggestions.length) {
    list.appendChild(el('div', { className: 'legend-help', text: 'No suggestions yet.' }));
  } else {
    for (const s of suggestions.slice(0, 25)) {
      list.appendChild(renderSuggestionCard({ session, fieldKey, catIdx, suggestion: s, canInteract, duplicateLabelKeys }));
    }
  }
  panel.appendChild(list);

  const formBox = el('div', { className: 'community-annotation-dashed-box' });
  formBox.appendChild(el('div', { className: 'community-annotation-new-title', text: 'New suggestion' }));
  if (!canInteract) {
    formBox.appendChild(el('div', { className: 'legend-help', text: 'New suggestions are disabled while closed by the author.' }));
  }

  const form = el('div', { className: 'community-annotation-new community-annotation-new-vertical' });

  // Label input with CAP search
  const labelRow = el('div', { className: 'community-annotation-label-row' });
  const labelInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Label (required)', maxlength: '120', disabled: !canInteract });
  const searchCapBtn = el('button', { type: 'button', className: 'btn-small cap-btn', text: 'Search CAP', title: 'Search Cell Annotation Platform for cell types', disabled: !canInteract });

  let capSearchPanel = null;
  const closeCapSearch = () => {
    if (capSearchPanel) {
      capSearchPanel.remove();
      capSearchPanel = null;
    }
  };

  searchCapBtn.addEventListener('click', async () => {
    const searchTerm = labelInput.value.trim();
    if (!searchTerm) {
      getNotificationCenter().info('Enter a cell type name to search', { category: 'annotation', duration: 2000 });
      labelInput.focus();
      return;
    }

	    closeCapSearch();
	    closeOntSearch();
	    closeMarkersSearch();
	    searchCapBtn.disabled = true;
	    searchCapBtn.textContent = 'Searching...';

    try {
      const results = await capApi.searchCellTypes(searchTerm, 20);
      capSearchPanel = renderCapSearchResults({
        results,
        onSelect: (result) => {
          labelInput.value = result.fullName || result.ontologyTerm || result.name || '';
          ontInput.value = result.ontologyTermId || '';
          if (result.markerGenes?.length) {
            markerGenesInput.value = result.markerGenes.slice(0, 10).join(', ');
          }
        },
        onClose: closeCapSearch
      });
      formBox.appendChild(capSearchPanel);
	    } catch (err) {
	      getNotificationCenter().error(`CAP search failed: ${describeErrorMessage(err)}`, { category: 'annotation' });
	    } finally {
	      searchCapBtn.disabled = false;
	      searchCapBtn.textContent = 'Search CAP';
	    }
	  });

  labelRow.appendChild(labelInput);
  labelRow.appendChild(searchCapBtn);

  // Ontology input with search button
  const ontRow = el('div', { className: 'community-annotation-label-row' });
  const ontInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Ontology id (optional, e.g. CL:0000625)', maxlength: '64', disabled: !canInteract });
  const searchOntBtn = el('button', { type: 'button', className: 'btn-small cap-btn', text: 'Search Ontology', title: 'Search CAP by ontology ID', disabled: !canInteract });

  let ontSearchPanel = null;
  const closeOntSearch = () => {
    if (ontSearchPanel) {
      ontSearchPanel.remove();
      ontSearchPanel = null;
    }
  };

  searchOntBtn.addEventListener('click', async () => {
    const searchTerm = ontInput.value.trim();
    if (!searchTerm) {
      getNotificationCenter().info('Enter an ontology ID to search', { category: 'annotation', duration: 2000 });
      ontInput.focus();
      return;
    }

    closeOntSearch();
    closeCapSearch();
    searchOntBtn.disabled = true;
    searchOntBtn.textContent = 'Searching...';

    try {
	      const result = await capApi.lookupByOntologyId(searchTerm);
	      if (result) {
	        ontSearchPanel = renderCapSearchResults({
	          results: [result],
	          onSelect: (r) => {
	            labelInput.value = r.fullName || r.ontologyTerm || r.name || '';
	            ontInput.value = r.ontologyTermId || '';
	            if (r.markerGenes?.length) {
	              markerGenesInput.value = r.markerGenes.slice(0, 10).join(', ');
	            }
	          },
	          onClose: closeOntSearch
	        });
	      } else {
	        ontSearchPanel = renderCapSearchResults({
	          results: [],
	          onSelect: () => {},
          onClose: closeOntSearch
        });
      }
      formBox.appendChild(ontSearchPanel);
	    } catch (err) {
	      getNotificationCenter().error(`CAP ontology search failed: ${describeErrorMessage(err)}`, { category: 'annotation' });
	    } finally {
	      searchOntBtn.disabled = false;
	      searchOntBtn.textContent = 'Search Ontology';
	    }
	  });

  ontRow.appendChild(ontInput);
  ontRow.appendChild(searchOntBtn);

  // Marker genes input with search button
  const markerGenesRow = el('div', { className: 'community-annotation-label-row' });
  const markerGenesInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Marker genes (optional, comma-separated)', disabled: !canInteract });
  const searchMarkersBtn = el('button', { type: 'button', className: 'btn-small cap-btn', text: 'Search Markers', title: 'Search CAP by marker genes', disabled: !canInteract });

  let markersSearchPanel = null;
  const closeMarkersSearch = () => {
    if (markersSearchPanel) {
      markersSearchPanel.remove();
      markersSearchPanel = null;
    }
  };

  searchMarkersBtn.addEventListener('click', async () => {
    const markers = parseMarkerGenesInput(markerGenesInput.value);
    if (!markers?.length) {
      getNotificationCenter().info('Enter marker gene(s) to search', { category: 'annotation', duration: 2000 });
      markerGenesInput.focus();
      return;
    }

    closeMarkersSearch();
    closeCapSearch();
    closeOntSearch();
    searchMarkersBtn.disabled = true;
    searchMarkersBtn.textContent = 'Searching...';

    try {
      // Use the first marker gene as the primary CAP query, but re-rank/filter results using all entered markers.
      const firstMarker = markers[0];
      const results = await capApi.searchCellTypes(firstMarker, 20, { markerGenes: markers });
      markersSearchPanel = renderCapSearchResults({
        results,
        onSelect: (r) => {
          labelInput.value = r.fullName || r.ontologyTerm || r.name || '';
          ontInput.value = r.ontologyTermId || '';
          if (r.markerGenes?.length) {
            markerGenesInput.value = r.markerGenes.slice(0, 10).join(', ');
          }
        },
        onClose: closeMarkersSearch
      });
      formBox.appendChild(markersSearchPanel);
	    } catch (err) {
	      getNotificationCenter().error(`CAP marker search failed: ${describeErrorMessage(err)}`, { category: 'annotation' });
	    } finally {
	      searchMarkersBtn.disabled = false;
	      searchMarkersBtn.textContent = 'Search Markers';
	    }
	  });

  markerGenesRow.appendChild(markerGenesInput);
  markerGenesRow.appendChild(searchMarkersBtn);

  const evidenceInput = el('textarea', { className: 'community-annotation-text-input community-annotation-textarea', placeholder: 'Evidence (optional)', maxlength: '2000', disabled: !canInteract });

  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
  const addBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add', disabled: !canInteract });
  const clearBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear', disabled: !canInteract });
  actions.appendChild(addBtn);
  actions.appendChild(clearBtn);

  if (canInteract) {
    addBtn.addEventListener('click', () => {
      try {
        const markers = parseMarkerGenesInput(markerGenesInput.value);
        session.addSuggestion(fieldKey, catIdx, { label: labelInput.value, ontologyId: ontInput.value, evidence: evidenceInput.value, markers });
        labelInput.value = '';
        ontInput.value = '';
        markerGenesInput.value = '';
        evidenceInput.value = '';
      } catch (err) {
        getNotificationCenter().error(err?.message || 'Failed to add suggestion', { category: 'annotation' });
      }
    });
  }
  clearBtn.addEventListener('click', () => {
    if (!canInteract) return;
    labelInput.value = '';
    ontInput.value = '';
    markerGenesInput.value = '';
    evidenceInput.value = '';
  });

  form.appendChild(labelRow);
  form.appendChild(ontRow);
  form.appendChild(markerGenesRow);
  form.appendChild(evidenceInput);
  form.appendChild(actions);
  formBox.appendChild(form);
  panel.appendChild(formBox);

  return panel;
}

export function openCommunityAnnotationVotingModal({
  state,
  defaultFieldKey = null,
  defaultCatIdx = null
} = {}) {
  if (!state) return null;

  const focusField = toCleanString(defaultFieldKey) || null;
  const focusCatIdx = Number.isInteger(defaultCatIdx) && defaultCatIdx >= 0 ? defaultCatIdx : null;

  if (!focusField || focusCatIdx == null) {
    getNotificationCenter().error('No category selected for voting', { category: 'annotation' });
    return null;
  }

  const session = getCommunityAnnotationSession();
  try {
    const datasetId = session.getDatasetId?.() || null;
    const ctx = syncCommunityAnnotationCacheContext({ datasetId });
    // Hide the entire voting UX unless a repo is connected (or dev simulate is enabled).
    if (!isAnnotationRepoConnected(ctx.datasetId, ctx.userKey)) return null;
  } catch {
    return null;
  }

  /** @type {{close?: Function, overlay?: HTMLElement, modal?: HTMLElement, content?: HTMLElement} | null} */
  let ref = null;
  ref = showModal({
    title: 'Community voting',
    buildContent: (content) => {
      const status = el('div', { className: 'legend-help', text: '' });
      content.appendChild(status);

      const lifecycle = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const autoScrollMargin = 48;
      const autoScrollMaxPx = 28;
      const autoScrollMinPx = 6;
      const dragAutoScroll = (clientY) => {
        try {
          if (!activeSuggestionMergeDrag) return;
          if (!getCommunityAnnotationAccessStore().isAuthor()) return;
          if (!Number.isFinite(clientY)) return;
          if (content.scrollHeight <= content.clientHeight) return;
          const rect = content.getBoundingClientRect();
          if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return;
          const topZone = rect.top + autoScrollMargin;
          const bottomZone = rect.bottom - autoScrollMargin;
          let delta = 0;
          if (clientY < topZone) {
            const t = Math.min(1, Math.max(0, (topZone - clientY) / autoScrollMargin));
            delta = -Math.ceil(autoScrollMinPx + t * (autoScrollMaxPx - autoScrollMinPx));
          } else if (clientY > bottomZone) {
            const t = Math.min(1, Math.max(0, (clientY - bottomZone) / autoScrollMargin));
            delta = Math.ceil(autoScrollMinPx + t * (autoScrollMaxPx - autoScrollMinPx));
          }
          if (delta) content.scrollTop += delta;
        } catch {
          // ignore
        }
      };
      try {
        if (lifecycle?.signal) {
          let latestY = null;
          let rafPending = false;
          const onDragOver = (e) => {
            latestY = e?.clientY;
            if (rafPending) return;
            rafPending = true;
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => {
                rafPending = false;
                dragAutoScroll(latestY);
              });
              return;
            }
            rafPending = false;
            dragAutoScroll(latestY);
          };
          const onDropOrLeave = () => {
            latestY = null;
          };
          content.addEventListener('dragover', onDragOver, { signal: lifecycle.signal });
          content.addEventListener('drop', onDropOrLeave, { signal: lifecycle.signal });
          content.addEventListener('dragleave', onDropOrLeave, { signal: lifecycle.signal });
        }
      } catch {
        // ignore
      }

      let renderVersion = 0;
      let isFirstRender = true;
      const renderFocused = async () => {
        const myVersion = ++renderVersion;

        // Only show loading state on first render - subsequent renders keep old content visible
        if (isFirstRender) {
          content.innerHTML = '';
          content.appendChild(status);
          status.textContent = 'Loading…';
        }

        const fields = state.getFields?.() || [];
        const fieldIndex = fields.findIndex((f) => f && f._isDeleted !== true && f.kind === 'category' && toCleanString(f.key) === focusField);
        if (fieldIndex < 0) {
          content.innerHTML = '';
          content.appendChild(status);
          status.textContent = 'Field not found in current dataset.';
          return;
        }
        try {
          await state.ensureFieldLoaded?.(fieldIndex, { silent: true });
        } catch (err) {
          content.innerHTML = '';
          content.appendChild(status);
          status.textContent = err?.message || 'Failed to load field';
          return;
        }

        // Bail if a newer render started while we were loading
        if (myVersion !== renderVersion) return;

        isFirstRender = false;

        const field = state.getFields?.()?.[fieldIndex] || null;
        const categories = Array.isArray(field?.categories) ? field.categories : [];
        try {
          session.setFieldCategories?.(focusField, categories);
        } catch {
          // ignore
        }
        const catLabel = categories[focusCatIdx] != null ? String(categories[focusCatIdx]) : `Category ${focusCatIdx}`;

        // Build new content then swap atomically to avoid flashing
        const newContent = document.createDocumentFragment();
        newContent.appendChild(el('div', { className: 'community-annotation-inline-help', text: `${focusField} • ${catLabel}` }));
        newContent.appendChild(buildVotingDetail({ session, fieldKey: focusField, catIdx: focusCatIdx }));

        content.innerHTML = '';
        content.appendChild(newContent);
      };

      const unsubscribe = session.on('changed', () => {
        renderFocused();
      });

      renderFocused();

      const observer = new MutationObserver(() => {
        if (!document.body.contains(content)) {
          unsubscribe?.();
          lifecycle?.abort?.();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // If repo is disconnected (or dev simulate toggles turn off), close this modal.
      const closeIfDisconnected = () => {
        try {
          const datasetId = session.getDatasetId?.() || null;
          const ctx = syncCommunityAnnotationCacheContext({ datasetId });
          if (!isAnnotationRepoConnected(ctx.datasetId, ctx.userKey)) ref?.close?.();
        } catch {
          ref?.close?.();
        }
      };
      try {
        if (typeof window !== 'undefined' && lifecycle?.signal) {
          window.addEventListener(ANNOTATION_CONNECTION_CHANGED_EVENT, closeIfDisconnected, { signal: lifecycle.signal });
        }
      } catch {
        // ignore
      }
    }
  });

  return ref;
}
