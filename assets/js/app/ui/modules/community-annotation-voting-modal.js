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

function describeErrorMessage(err) {
  if (!(err instanceof Error)) {
    throw new TypeError('Community annotation operations must reject with an Error instance');
  }
  if (typeof err.message !== 'string' || err.message.length === 0 || err.message !== err.message.trim()) {
    throw new TypeError('Community annotation errors require a non-empty trimmed message');
  }
  return err.message;
}

function truncateForUi(value, maxLen) {
  const s = toCleanString(value);
  const max = Number.isFinite(maxLen) ? Math.max(1, Math.floor(maxLen)) : 12;
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function formatCommentAuthorHandle(session, username, { maxLen = 12 } = {}) {
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    username !== username.trim() ||
    username.startsWith('@')
  ) {
    throw new TypeError('Comment author username must be an exact handle');
  }
  if (!session || typeof session.getKnownUserProfile !== 'function') {
    throw new TypeError('Comment author formatting requires getKnownUserProfile()');
  }
  const prof = session.getKnownUserProfile(username);
  const login = prof?.login ?? '';
  if (typeof login !== 'string' || login !== login.trim()) {
    throw new TypeError('Known comment author login must be an exact string');
  }
  const handle = login || username;
  return `@${truncateForUi(handle, maxLen)}`;
}

function bucketKey(session, fieldKey, catIdx) {
  if (!session || typeof session.toBucketKey !== 'function') {
    throw new TypeError('Community annotation session must expose toBucketKey()');
  }
  const key = session.toBucketKey(fieldKey, catIdx);
  if (typeof key !== 'string' || key.length === 0 || key !== key.trim()) {
    throw new TypeError('Community annotation bucket key must be an exact string');
  }
  return key;
}

function requireSuggestionId(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

/**
 * Validate and deterministically order the exact merge edges that terminate at
 * one suggestion bundle. Each included edge is returned once.
 *
 * @param {{ targetSuggestionId: string, merges: object[] }} input
 * @returns {{ targetSuggestionId: string, steps: Array<{fromSuggestionId: string, intoSuggestionId: string, merge: object}> }}
 */
export function buildMergeTraversal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Merge traversal input must be an object');
  }
  const targetSuggestionId = requireSuggestionId(
    input.targetSuggestionId,
    'Merge traversal targetSuggestionId'
  );
  if (!Array.isArray(input.merges)) {
    throw new TypeError('Merge traversal merges must be an array');
  }

  const fromTo = new Map();
  const mergeByFrom = new Map();
  for (let index = 0; index < input.merges.length; index++) {
    const merge = input.merges[index];
    if (!merge || typeof merge !== 'object' || Array.isArray(merge)) {
      throw new TypeError(`Merge traversal entry ${index} must be an object`);
    }
    const fromSuggestionId = requireSuggestionId(
      merge.fromSuggestionId,
      `Merge traversal entry ${index} fromSuggestionId`
    );
    const intoSuggestionId = requireSuggestionId(
      merge.intoSuggestionId,
      `Merge traversal entry ${index} intoSuggestionId`
    );
    if (fromSuggestionId === intoSuggestionId) {
      throw new Error(`Merge traversal entry ${index} cannot merge a suggestion into itself`);
    }
    if (fromTo.has(fromSuggestionId)) {
      throw new Error(`Merge traversal has duplicate source "${fromSuggestionId}"`);
    }
    fromTo.set(fromSuggestionId, intoSuggestionId);
    mergeByFrom.set(fromSuggestionId, merge);
  }

  if (fromTo.has(targetSuggestionId)) {
    throw new Error(`Merge traversal target "${targetSuggestionId}" must be terminal`);
  }

  const terminalByFrom = new Map();
  for (const start of fromTo.keys()) {
    let current = start;
    const path = new Set();
    while (fromTo.has(current)) {
      if (path.has(current)) {
        throw new Error(`Merge traversal contains a cycle at "${current}"`);
      }
      path.add(current);
      current = fromTo.get(current);
    }
    terminalByFrom.set(start, current);
  }

  const includedFromIds = [...fromTo.keys()].filter(
    (fromSuggestionId) => terminalByFrom.get(fromSuggestionId) === targetSuggestionId
  );
  const includedFromSet = new Set(includedFromIds);
  const includedIntoSet = new Set(
    includedFromIds.map((fromSuggestionId) => fromTo.get(fromSuggestionId))
  );
  const roots = includedFromIds
    .filter((fromSuggestionId) => !includedIntoSet.has(fromSuggestionId))
    .sort((left, right) => left.localeCompare(right));

  const emitted = new Set();
  const steps = [];
  for (const root of roots) {
    let current = root;
    while (current !== targetSuggestionId && includedFromSet.has(current)) {
      if (emitted.has(current)) break;
      emitted.add(current);
      steps.push({
        fromSuggestionId: current,
        intoSuggestionId: fromTo.get(current),
        merge: mergeByFrom.get(current)
      });
      current = fromTo.get(current);
    }
  }

  if (emitted.size !== includedFromIds.length) {
    throw new Error('Merge traversal could not reach every included merge from an exact root');
  }

  return { targetSuggestionId, steps };
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
  if (isoString === null || isoString === undefined || isoString === '') return '';
  if (
    typeof isoString !== 'string' ||
    isoString !== isoString.trim()
  ) {
    throw new TypeError('Comment timestamp must be an exact string');
  }
  const date = new Date(isoString);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new RangeError('Comment timestamp must be a valid date');
  }
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function createDomId(prefix = 'id') {
  if (
    typeof prefix !== 'string' ||
    prefix.length === 0 ||
    prefix !== prefix.trim()
  ) {
    throw new TypeError('DOM id prefix must be an exact string');
  }
  if (
    typeof globalThis.crypto !== 'object' ||
    typeof globalThis.crypto.randomUUID !== 'function'
  ) {
    throw new TypeError('Community annotation modals require crypto.randomUUID()');
  }
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function listFocusableElements(root) {
  const container = root;
  if (!container || typeof container.querySelectorAll !== 'function') {
    throw new TypeError('Modal focus root must expose querySelectorAll()');
  }
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
    if (typeof window.getComputedStyle !== 'function') {
      throw new TypeError('Modal focus management requires getComputedStyle()');
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return node.getClientRects().length > 0;
  });
}

function trapModalFocus({ overlay, modal, close, escCancelSelector = null } = {}) {
  const o = overlay;
  const m = modal;
  if (
    !o ||
    typeof o.addEventListener !== 'function' ||
    typeof o.removeEventListener !== 'function'
  ) {
    throw new TypeError('Modal overlay must expose exact event listener methods');
  }
  if (!m || typeof m.contains !== 'function') {
    throw new TypeError('Modal focus container must expose contains()');
  }
  if (typeof close !== 'function') {
    throw new TypeError('Modal focus trap requires a close callback');
  }

  const onKeyDown = (e) => {
    if (!e || typeof e.preventDefault !== 'function' || typeof e.stopPropagation !== 'function') {
      throw new TypeError('Modal focus trap requires exact keyboard event methods');
    }
    if (e.key === 'Escape') {
      if (escCancelSelector) {
        const target = e.target;
        if (target && typeof target.closest === 'function' && target.closest(escCancelSelector)) return;
      }
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (e.key !== 'Tab') return;

    const focusables = listFocusableElements(m);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const containsActive = active && m.contains(active);

    if (e.shiftKey) {
      if (!containsActive || active === first) {
        if (typeof last.focus !== 'function') {
          throw new TypeError('Modal focus target must expose focus()');
        }
        e.preventDefault();
        last.focus();
      }
      return;
    }

    if (!containsActive || active === last) {
      if (typeof first.focus !== 'function') {
        throw new TypeError('Modal focus target must expose focus()');
      }
      e.preventDefault();
      first.focus();
    }
  };

  o.addEventListener('keydown', onKeyDown, true);
  return () => o.removeEventListener('keydown', onKeyDown, true);
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
  const element = textarea;
  if (!element || !element.style) {
    throw new TypeError('Textarea autosizing requires an exact rendered textarea');
  }
  element.style.height = 'auto';
  const scrollHeight = element.scrollHeight;
  if (!Number.isFinite(scrollHeight)) {
    throw new TypeError('Textarea autosizing requires a finite scrollHeight');
  }
  const next = Math.max(minHeightPx ?? 0, scrollHeight);
  const capped = maxHeightPx != null ? Math.min(next, maxHeightPx) : next;
  element.style.height = `${capped}px`;
  element.style.overflowY = maxHeightPx != null && next > maxHeightPx ? 'auto' : 'hidden';
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
  if (typeof buildContent !== 'function') {
    throw new TypeError('Community annotation modal requires a content builder');
  }
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
  buildContent(content);

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  const prevFocus = document.activeElement;
  let closed = false;
  let cleanupTrap = null;
  const close = () => {
    if (closed) return;
    closed = true;
    runExactCleanup('Community annotation voting modal teardown', [
      ['focus trap', cleanupTrap],
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
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  cleanupTrap = trapModalFocus({ overlay, modal, close });
  closeBtn.focus();

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
          e.preventDefault();
          e.stopPropagation();
          renderMetaDisplay();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          save();
        }
      });

      inputWrap.appendChild(input);
      inputWrap.appendChild(charCounter);
      metaEl.appendChild(inputWrap);
      if (typeof requestAnimationFrame !== 'function') {
        throw new TypeError('Merge note editing requires requestAnimationFrame()');
      }
      requestAnimationFrame(resize);
      input.focus();
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
  if (typeof buildContent !== 'function') {
    throw new TypeError('Secondary modal requires a content builder');
  }
  if (activeSecondaryModal !== null) {
    activeSecondaryModal.close();
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
  let closed = false;
  const ownerOverlay = document.querySelector('.community-annotation-modal-overlay');

  const render = () => {
    content.innerHTML = '';
    buildContent(content, { close });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (activeSecondaryModal !== null && activeSecondaryModal.close === close) {
      activeSecondaryModal = null;
    }
    runExactCleanup('Community annotation secondary modal teardown', [
      ['session subscription', unsubscribe],
      [
        'owner observer',
        ownerObserver === null
          ? null
          : () => {
              if (typeof ownerObserver.disconnect !== 'function') {
                throw new TypeError('Secondary modal observer must expose disconnect()');
              }
              ownerObserver.disconnect();
            }
      ],
      ['focus trap', cleanupTrap],
      ['secondary modal overlay', () => overlay.remove()],
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

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const prevFocus = document.activeElement;
  const cleanupTrap = trapModalFocus({ overlay, modal, close, escCancelSelector: '[data-esc-cancel="true"]' });

  document.body.appendChild(overlay);
  closeBtn.focus();

  if (session && typeof session.on === 'function') {
    unsubscribe = session.on('changed', () => render());
    if (typeof unsubscribe !== 'function') {
      throw new TypeError('Secondary modal session subscription must return an unsubscribe function');
    }
  }

  if (ownerOverlay) {
    ownerObserver = new MutationObserver(() => {
      if (!document.body.contains(ownerOverlay)) close();
    });
    ownerObserver.observe(document.body, { childList: true, subtree: true });
  }

  try {
    render();
  } catch (primaryError) {
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'Secondary modal rendering and teardown both failed'
      );
    }
    throw primaryError;
  }

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
      const tid = toCleanString(target?.id);
      if (tid) idToLabel.set(tid, toCleanString(target?.label) || tid);
      for (const s of mergedFrom) {
        const id = toCleanString(s?.id);
        if (!id) continue;
        idToLabel.set(id, toCleanString(s?.label) || id);
      }
      if (typeof session.getStateSnapshot !== 'function') {
        throw new TypeError('Merged suggestion rendering requires getStateSnapshot()');
      }
      const snap = session.getStateSnapshot();
      const raw = snap?.suggestions?.[bucket] || [];
      if (!Array.isArray(raw)) {
        throw new TypeError('Merged suggestion snapshot bucket must be an array');
      }
      for (const s of raw.slice(0, 5000)) {
        const id = toCleanString(s?.id);
        if (!id || idToLabel.has(id)) continue;
        idToLabel.set(id, toCleanString(s?.label) || id);
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

      const traversal = buildMergeTraversal({
        targetSuggestionId: targetId,
        merges
      });

      const suggestionById = new Map();
      if (targetId) suggestionById.set(targetId, target);
      for (const s of mergedFrom) {
        const id = toCleanString(s?.id);
        if (!id) continue;
        suggestionById.set(id, s);
      }

      const list = el('div', { className: 'community-annotation-suggestions' });
      const renderedCards = new Set();

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

      for (const step of traversal.steps) {
        renderCard(step.fromSuggestionId);
        list.appendChild(renderMergeRow({
          session,
          fieldKey,
          catIdx,
          merge: step.merge,
          idToLabel,
          canDetach
        }));
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
        getNotificationCenter().error(describeErrorMessage(err), { category: 'annotation' });
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

  if (typeof session.getComments !== 'function') {
    throw new TypeError('Comment rendering requires session.getComments()');
  }
  const comments = session.getComments(fieldKey, catIdx, suggestion?.id);
  if (!Array.isArray(comments)) {
    throw new TypeError('Comment rendering requires an exact comments array');
  }
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
    if (typeof requestAnimationFrame !== 'function') {
      throw new TypeError('Comment textarea rendering requires requestAnimationFrame()');
    }
    requestAnimationFrame(resizeInput);

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
            e.preventDefault();
            e.stopPropagation();
            renderPreview();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            save();
          }
        });

        inputWrap.appendChild(input);
        inputWrap.appendChild(counter);
        body.appendChild(inputWrap);
        if (typeof requestAnimationFrame !== 'function') {
          throw new TypeError('Comment editing requires requestAnimationFrame()');
        }
        requestAnimationFrame(resize);
        input.focus();
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
      const scrollable = scroll.scrollHeight > scroll.clientHeight + 1;
      scroll.classList.toggle('is-scrollable', scrollable);
      if (!scrollable) {
        scroll.classList.remove('is-at-bottom');
        return;
      }
      const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
      scroll.classList.toggle('is-at-bottom', atBottom);
    };
    scroll.addEventListener('scroll', updateScrollFade, { passive: true });
    if (typeof requestAnimationFrame !== 'function') {
      throw new TypeError('Comment scrolling requires requestAnimationFrame()');
    }
    requestAnimationFrame(updateScrollFade);
    setTimeout(updateScrollFade, 60);
    commentsBox.appendChild(scroll);
    card.appendChild(commentsBox);
  }

  if (!isCompact && allowModerationDrag && canModerate && suggestion?.id) {
    card.draggable = true;
    card.classList.add('community-annotation-moderation-draggable');
    card.title = 'Drag this suggestion onto another suggestion to merge (author-only).';
    card.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer || typeof e.dataTransfer.setData !== 'function') {
        throw new TypeError('Suggestion merging requires an exact DataTransfer');
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(
        'application/x-cellucid-suggestion-merge',
        JSON.stringify({ fieldKey, catIdx, suggestionId: suggestion.id, label: suggestion?.label || '' })
      );
      activeSuggestionMergeDrag = { fieldKey: toCleanString(fieldKey), catIdx: Number(catIdx), suggestionId: String(suggestion.id) };
    });
    card.addEventListener('dragend', () => {
      activeSuggestionMergeDrag = null;
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('is-merge-target');
      if (!e.dataTransfer) {
        throw new TypeError('Suggestion merging requires an exact DataTransfer');
      }
      e.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('dragleave', () => card.classList.remove('is-merge-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('is-merge-target');
      if (!e.dataTransfer || typeof e.dataTransfer.getData !== 'function') {
        throw new TypeError('Suggestion merging requires an exact DataTransfer');
      }
      const payload = JSON.parse(
        e.dataTransfer.getData('application/x-cellucid-suggestion-merge')
      );
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
        getNotificationCenter().error(describeErrorMessage(err), { category: 'annotation' });
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
  if (typeof session.getDatasetId !== 'function') {
    throw new TypeError('Community voting requires session.getDatasetId()');
  }
  const datasetId = session.getDatasetId();
  const ctx = syncCommunityAnnotationCacheContext({ datasetId });
  // Hide the entire voting UX unless a repo is connected (or dev simulate is enabled).
  if (!isAnnotationRepoConnected(ctx.datasetId, ctx.userKey)) return null;

  /** @type {{close?: Function, overlay?: HTMLElement, modal?: HTMLElement, content?: HTMLElement} | null} */
  let ref = null;
  ref = showModal({
    title: 'Community voting',
    buildContent: (content) => {
      const status = el('div', { className: 'legend-help', text: '' });
      content.appendChild(status);

      if (typeof AbortController !== 'function') {
        throw new TypeError('Community voting requires AbortController');
      }
      const lifecycle = new AbortController();
      const autoScrollMargin = 48;
      const autoScrollMaxPx = 28;
      const autoScrollMinPx = 6;
      const dragAutoScroll = (clientY) => {
        if (!activeSuggestionMergeDrag) return;
        if (!getCommunityAnnotationAccessStore().isAuthor()) return;
        if (!Number.isFinite(clientY)) return;
        if (content.scrollHeight <= content.clientHeight) return;
        const rect = content.getBoundingClientRect();
        if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
          throw new TypeError('Community voting drag scrolling requires exact bounds');
        }
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
      };
      if (typeof requestAnimationFrame !== 'function') {
        throw new TypeError('Community voting drag scrolling requires requestAnimationFrame()');
      }
      let latestY = null;
      let rafPending = false;
      const onDragOver = (e) => {
        latestY = e.clientY;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          try {
            dragAutoScroll(latestY);
          } finally {
            rafPending = false;
          }
        });
      };
      const onDropOrLeave = () => {
        latestY = null;
      };
      content.addEventListener('dragover', onDragOver, { signal: lifecycle.signal });
      content.addEventListener('drop', onDropOrLeave, { signal: lifecycle.signal });
      content.addEventListener('dragleave', onDropOrLeave, { signal: lifecycle.signal });

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
          status.textContent = describeErrorMessage(err);
          return;
        }

        // Bail if a newer render started while we were loading
        if (myVersion !== renderVersion) return;

        isFirstRender = false;

        const field = state.getFields?.()?.[fieldIndex] || null;
        const categories = Array.isArray(field?.categories) ? field.categories : [];
        if (typeof session.setFieldCategories !== 'function') {
          throw new TypeError('Community voting requires session.setFieldCategories()');
        }
        session.setFieldCategories(focusField, categories);
        const catLabel = categories[focusCatIdx] != null ? String(categories[focusCatIdx]) : `Category ${focusCatIdx}`;

        // Build new content then swap atomically to avoid flashing
        const newContent = document.createDocumentFragment();
        newContent.appendChild(el('div', { className: 'community-annotation-inline-help', text: `${focusField} • ${catLabel}` }));
        newContent.appendChild(buildVotingDetail({ session, fieldKey: focusField, catIdx: focusCatIdx }));

        content.innerHTML = '';
        content.appendChild(newContent);
      };

      if (typeof session.on !== 'function') {
        throw new TypeError('Community voting requires session.on()');
      }
      const unsubscribe = session.on('changed', () => {
        renderFocused();
      });
      if (typeof unsubscribe !== 'function') {
        throw new TypeError('Community voting subscription must return an unsubscribe function');
      }

      renderFocused();

      const observer = new MutationObserver(() => {
        if (!document.body.contains(content)) {
          runExactCleanup('Community voting detached-modal teardown', [
            ['session subscription', unsubscribe],
            ['modal lifecycle', () => lifecycle.abort()],
            ['modal observer', () => observer.disconnect()]
          ]);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // If repo is disconnected (or dev simulate toggles turn off), close this modal.
      const closeIfDisconnected = () => {
        const currentDatasetId = session.getDatasetId();
        const currentContext = syncCommunityAnnotationCacheContext({
          datasetId: currentDatasetId
        });
        if (!isAnnotationRepoConnected(currentContext.datasetId, currentContext.userKey)) {
          if (!ref || typeof ref.close !== 'function') {
            throw new TypeError('Community voting modal reference must expose close()');
          }
          ref.close();
        }
      };
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        throw new TypeError('Community voting requires window.addEventListener()');
      }
      window.addEventListener(
        ANNOTATION_CONNECTION_CHANGED_EVENT,
        closeIfDisconnected,
        { signal: lifecycle.signal }
      );
    }
  });

  return ref;
}
