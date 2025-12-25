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
import { getCommunityAnnotationAccessStore } from '../../community-annotations/access-store.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';

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

function renderComment({ session, fieldKey, catIdx, suggestionId, comment, onUpdate }) {
  const isOwn = session.isMyComment(comment?.authorUsername);
  const commentEl = el('div', { className: `community-annotation-comment${isOwn ? ' is-own' : ''}` });

  const header = el('div', { className: 'community-annotation-comment-header' });
  const author = el('span', { className: 'community-annotation-comment-author', text: `@${comment?.authorUsername || 'unknown'}` });
  const time = el('span', { className: 'community-annotation-comment-time' });
  const edited = comment?.editedAt ? ' (edited)' : '';
  time.textContent = formatRelativeTime(comment?.editedAt || comment?.createdAt) + edited;
  header.appendChild(author);
  header.appendChild(time);
  commentEl.appendChild(header);

  const textEl = el('div', { className: 'community-annotation-comment-text', text: comment?.text || '' });
  commentEl.appendChild(textEl);

  if (isOwn) {
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
  header.appendChild(el('div', { className: 'community-annotation-modal-title', text: title || 'Community voting' }));
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

function renderSuggestionCard({ session, fieldKey, catIdx, suggestion }) {
  const up = suggestion?.upvotes?.length || 0;
  const down = suggestion?.downvotes?.length || 0;
  const net = up - down;
  const myVote = session.getMyVote(fieldKey, catIdx, suggestion?.id);
  const access = getCommunityAnnotationAccessStore();
  const canModerate = access.isAuthor();

  const card = el('div', { className: 'community-annotation-suggestion-card' });
  const top = el('div', { className: 'community-annotation-suggestion-top' });
  top.appendChild(el('div', { className: 'community-annotation-suggestion-label', text: suggestion?.label || '' }));
  top.appendChild(el('div', { className: 'community-annotation-suggestion-net', text: `net ${net}` }));
  card.appendChild(top);

  if (suggestion?.ontologyId) card.appendChild(el('div', { className: 'community-annotation-suggestion-ontology', text: suggestion.ontologyId }));
  if (suggestion?.evidence) card.appendChild(el('div', { className: 'community-annotation-suggestion-evidence', text: suggestion.evidence }));
  const mergeNotes = Array.isArray(suggestion?.mergeNotes) ? suggestion.mergeNotes : [];
  if (mergeNotes.length) {
    for (const note of mergeNotes.slice(0, 3)) {
      card.appendChild(el('div', { className: 'community-annotation-suggestion-evidence', text: note }));
    }
  }

  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
  const upBtn = el('button', { type: 'button', className: 'btn-small community-annotation-vote-btn vote-up', text: `▲ ${up}` });
  const downBtn = el('button', { type: 'button', className: 'btn-small community-annotation-vote-btn vote-down', text: `▼ ${down}` });
  if (myVote === 'up') upBtn.classList.add('is-mine');
  if (myVote === 'down') downBtn.classList.add('is-mine');
  upBtn.addEventListener('click', () => session.vote(fieldKey, catIdx, suggestion.id, 'up'));
  downBtn.addEventListener('click', () => session.vote(fieldKey, catIdx, suggestion.id, 'down'));
  actions.appendChild(upBtn);
  actions.appendChild(downBtn);
  card.appendChild(actions);

  const by = el('div', { className: 'legend-help', text: session.formatUserAttribution(suggestion?.proposedBy || '') });
  card.appendChild(by);

  // Comments section
  const commentsSection = el('div', { className: 'community-annotation-comments-section' });
  const commentsList = el('div', { className: 'community-annotation-comments-list' });

  const renderCommentsList = () => {
    commentsList.innerHTML = '';
    const comments = session.getComments(fieldKey, catIdx, suggestion?.id);
    for (const c of comments.slice(0, 10)) {
      commentsList.appendChild(
        renderComment({
          session,
          fieldKey,
          catIdx,
          suggestionId: suggestion?.id,
          comment: c,
          onUpdate: renderCommentsList
        })
      );
    }
    if (comments.length > 10) {
      commentsList.appendChild(el('div', { className: 'community-annotation-comment-overflow', text: `+${comments.length - 10} more comments` }));
    }
  };
  renderCommentsList();

  commentsSection.appendChild(commentsList);

  // Add comment form (collapsible)
  const addCommentBtn = el('button', { type: 'button', className: 'community-annotation-add-comment-btn', text: 'Add comment' });
  const commentFormContainer = el('div', { className: 'community-annotation-comment-form', style: 'display: none;' });

  const commentInput = el('textarea', {
    className: 'community-annotation-comment-input',
    placeholder: 'Write a comment...',
    maxlength: '500'
  });
  const charCounter = el('div', { className: 'community-annotation-char-counter', text: '0/500' });
  commentInput.addEventListener('input', () => {
    charCounter.textContent = `${commentInput.value.length}/500`;
  });

  const formActions = el('div', { className: 'community-annotation-comment-form-actions' });
  const submitBtn = el('button', { type: 'button', className: 'btn-small', text: 'Post' });
  const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });

  submitBtn.addEventListener('click', () => {
    const text = commentInput.value.trim();
    if (!text) return;
    const id = session.addComment(fieldKey, catIdx, suggestion?.id, text);
    if (id) {
      commentInput.value = '';
      charCounter.textContent = '0/500';
      commentFormContainer.style.display = 'none';
      addCommentBtn.style.display = '';
      renderCommentsList();
      getNotificationCenter().success('Comment added', { category: 'annotation', duration: 1500 });
    } else {
      getNotificationCenter().error('Failed to add comment', { category: 'annotation' });
    }
  });

  cancelBtn.addEventListener('click', () => {
    commentInput.value = '';
    charCounter.textContent = '0/500';
    commentFormContainer.style.display = 'none';
    addCommentBtn.style.display = '';
  });

  formActions.appendChild(submitBtn);
  formActions.appendChild(cancelBtn);
  commentFormContainer.appendChild(commentInput);
  commentFormContainer.appendChild(charCounter);
  commentFormContainer.appendChild(formActions);

  addCommentBtn.addEventListener('click', () => {
    addCommentBtn.style.display = 'none';
    commentFormContainer.style.display = '';
    commentInput.focus();
  });

  commentsSection.appendChild(addCommentBtn);
  commentsSection.appendChild(commentFormContainer);
  card.appendChild(commentsSection);

  if (canModerate && suggestion?.id) {
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
      } catch {
        // ignore
      }
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
          `This sums votes and adds a history note (author-only).`,
        confirmText: 'Merge',
        onConfirm: () => {
          const note = `Merged "${fromLabel || fromId}" into "${intoLabel || intoId}" by @${session.getProfile?.()?.username || 'local'}`;
          const ok = session.addModerationMerge({
            fieldKey,
            catIdx,
            fromSuggestionId: fromId,
            intoSuggestionId: intoId,
            note
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

function buildVotingDetail({ session, fieldKey, catIdx, catLabel }) {
  const panel = el('div', { className: 'community-annotation-voting-detail' });
  panel.appendChild(el('div', { className: 'community-annotation-panel-title', text: catLabel || '(category)' }));
  panel.appendChild(el('div', { className: 'community-annotation-panel-subtitle', text: 'Votes are saved locally until you Publish via GitHub sync.' }));

  const consensus = session.computeConsensus(fieldKey, catIdx);
  const consensusLine = el('div', { className: `community-annotation-consensus status-${consensus.status}` });
  const label = consensus.label ? `"${consensus.label}"` : '—';
  consensusLine.textContent =
    consensus.status === 'consensus'
      ? `Consensus: ${label} (${Math.round(consensus.confidence * 100)}% • voters ${consensus.voters})`
      : consensus.status === 'disputed'
        ? `Disputed: top ${label} (${Math.round(consensus.confidence * 100)}% • voters ${consensus.voters})`
        : `Pending: voters ${consensus.voters}`;
  panel.appendChild(consensusLine);

  const suggestions = session
    .getSuggestions(fieldKey, catIdx)
    .slice()
    .sort(
      (a, b) =>
        ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0))
    );

  const list = el('div', { className: 'community-annotation-suggestions' });
  if (!suggestions.length) {
    list.appendChild(el('div', { className: 'legend-help', text: 'No suggestions yet.' }));
  } else {
    for (const s of suggestions.slice(0, 25)) list.appendChild(renderSuggestionCard({ session, fieldKey, catIdx, suggestion: s }));
  }
  panel.appendChild(list);

  const formBox = el('div', { className: 'community-annotation-dashed-box' });
  formBox.appendChild(el('div', { className: 'community-annotation-new-title', text: 'New suggestion' }));

  const form = el('div', { className: 'community-annotation-new community-annotation-new-vertical' });

  const labelInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Label (required)' });
  const ontInput = el('input', { type: 'text', className: 'community-annotation-text-input', placeholder: 'Ontology id (optional, e.g. CL:0000625)' });
  const evidenceInput = el('textarea', { className: 'community-annotation-text-input community-annotation-textarea', placeholder: 'Evidence (optional)' });

  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
  const addBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add' });
  const clearBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear' });
  actions.appendChild(addBtn);
  actions.appendChild(clearBtn);

  addBtn.addEventListener('click', () => {
    try {
      session.addSuggestion(fieldKey, catIdx, { label: labelInput.value, ontologyId: ontInput.value, evidence: evidenceInput.value });
      labelInput.value = '';
      ontInput.value = '';
      evidenceInput.value = '';
    } catch (err) {
      getNotificationCenter().error(err?.message || 'Failed to add suggestion', { category: 'annotation' });
    }
  });
  clearBtn.addEventListener('click', () => {
    labelInput.value = '';
    ontInput.value = '';
    evidenceInput.value = '';
  });

  form.appendChild(labelInput);
  form.appendChild(ontInput);
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

  const ref = showModal({
    title: 'Community voting',
    buildContent: (content) => {
      const status = el('div', { className: 'legend-help', text: '' });
      content.appendChild(status);

      let renderVersion = 0;
      const renderFocused = async () => {
        const myVersion = ++renderVersion;
        content.innerHTML = '';
        content.appendChild(status);
        status.textContent = 'Loading…';

        const fields = state.getFields?.() || [];
        const fieldIndex = fields.findIndex((f) => f && f._isDeleted !== true && f.kind === 'category' && toCleanString(f.key) === focusField);
        if (fieldIndex < 0) {
          status.textContent = 'Field not found in current dataset.';
          return;
        }
        try {
          await state.ensureFieldLoaded?.(fieldIndex, { silent: true });
        } catch (err) {
          status.textContent = err?.message || 'Failed to load field';
          return;
        }

        // Bail if a newer render started while we were loading
        if (myVersion !== renderVersion) return;

        const field = state.getFields?.()?.[fieldIndex] || null;
        const categories = Array.isArray(field?.categories) ? field.categories : [];
        const catLabel = categories[focusCatIdx] != null ? String(categories[focusCatIdx]) : `Category ${focusCatIdx}`;

        status.textContent = '';
        content.appendChild(el('div', { className: 'community-annotation-inline-help', text: `${focusField} • ${catLabel}` }));
        content.appendChild(buildVotingDetail({ session, fieldKey: focusField, catIdx: focusCatIdx, catLabel }));
      };

      const unsubscribe = session.on('changed', () => {
        renderFocused();
      });

      renderFocused();

      const observer = new MutationObserver(() => {
        if (!document.body.contains(content)) {
          unsubscribe?.();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  });

  return ref;
}
