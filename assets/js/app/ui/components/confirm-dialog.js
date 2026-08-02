/**
 * Confirm dialog (lightweight modal) for destructive actions.
 *
 * The dialog is intentionally dependency-free and uses existing CSS tokens.
 */

import { escapeHtml } from '../utils.js';
import { claimModalDocumentLayer } from './modal-background-owner.js';
import { createDomId } from './dom-id.js';

let activeKeydownHandler = null;
let activeDialogCancel = null;

function releaseExactModalDocumentLayer(release) {
  if (typeof release !== 'function') {
    throw new TypeError(
      'Confirm dialog document-layer release owner must be a function'
    );
  }
  try {
    if (release() !== true) {
      throw new Error(
        'Confirm dialog lost its exact document-layer owner'
      );
    }
    return true;
  } catch (primaryError) {
    try {
      if (release() !== true) {
        throw new Error(
          'Confirm dialog document-layer retry lost ownership'
        );
      }
      return true;
    } catch (retryError) {
      throw new AggregateError(
        [primaryError, retryError],
        'Confirm dialog document-layer release failed twice'
      );
    }
  }
}


export function showConfirmDialog({
  title,
  message,
  confirmText = 'Delete',
  inputLabel = null,
  inputPlaceholder = null,
  inputDefaultValue = '',
  inputMaxLength = 512,
  onConfirm,
  onCancel
}) {
  if (activeDialogCancel !== null) {
    activeDialogCancel();
  } else if (activeKeydownHandler) {
    document.removeEventListener('keydown', activeKeydownHandler, true);
    activeKeydownHandler = null;
  }

  const existing = document.querySelector('.confirm-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const prevFocus = document.activeElement;
  const titleId = createDomId('confirm-dialog-title');
  const inputId = createDomId('confirm-dialog-input');
  overlay.setAttribute('aria-labelledby', titleId);

  const wantsInput = Boolean(inputLabel || inputPlaceholder);
  const inputBlock = wantsInput
    ? `
      <div class="confirm-dialog-input">
        ${inputLabel ? `<label class="confirm-dialog-input-label" for="${escapeHtml(inputId)}">${escapeHtml(inputLabel)}</label>` : ''}
        <div class="confirm-dialog-textarea-wrap">
          <textarea
            id="${escapeHtml(inputId)}"
            class="confirm-dialog-textarea"
            rows="3"
            maxlength="${escapeHtml(String(inputMaxLength))}"
            placeholder="${escapeHtml(inputPlaceholder || '')}"
            ${inputLabel ? '' : `aria-label="${escapeHtml(inputPlaceholder || 'Note')}"`}
          >${escapeHtml(inputDefaultValue || '')}</textarea>
          <div class="confirm-dialog-char-counter confirm-dialog-char-counter--overlay"></div>
        </div>
      </div>
    `
    : '';

  overlay.innerHTML = `
    <div class="confirm-dialog" role="document">
      <div class="confirm-dialog-header">
        <span class="confirm-dialog-title" id="${escapeHtml(titleId)}">${escapeHtml(title || 'Confirm')}</span>
      </div>
      <div class="confirm-dialog-body">
        ${escapeHtml(message || '')}
        ${inputBlock}
      </div>
      <div class="confirm-dialog-actions">
        <button type="button" class="confirm-dialog-btn confirm-dialog-cancel">Cancel</button>
        <button type="button" class="confirm-dialog-btn confirm-dialog-confirm">${escapeHtml(confirmText)}</button>
      </div>
    </div>
  `;

  let closed = false;
  let releaseModalLayer = null;
  const releaseDocumentOwnership = () => {
    if (releaseModalLayer === null) return;
    const exactRelease = releaseModalLayer;
    releaseExactModalDocumentLayer(exactRelease);
    if (releaseModalLayer === exactRelease) {
      releaseModalLayer = null;
    }
  };
  const listFocusable = () => {
    const root = overlay.querySelector('.confirm-dialog');
    if (!root) return [];
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
    return Array.from(root.querySelectorAll(selectors)).filter((node) => {
      if (!(node instanceof HTMLElement)) return false;
      try {
        const style = window.getComputedStyle?.(node);
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
        return node.getClientRects().length > 0;
      } catch {
        return true;
      }
    });
  };

  const onTrapKeyDown = (e) => {
    if (e.key === 'Escape') {
      try {
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
      } catch {
        // The dialog still closes when a synthetic event method throws.
      }
      cancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = listFocusable();
    if (!focusables.length) {
      try { e.preventDefault?.(); } catch { /* ignore */ }
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const root = overlay.querySelector('.confirm-dialog');
    const containsActive = active && root && root.contains(active);

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

  overlay.addEventListener('keydown', onTrapKeyDown, true);

  const close = () => {
    if (closed) {
      releaseDocumentOwnership();
      if (
        releaseModalLayer === null &&
        activeDialogCancel === cancel
      ) {
        activeDialogCancel = null;
      }
      return;
    }
    closed = true;
    if (activeKeydownHandler === onKeyDown) {
      document.removeEventListener('keydown', onKeyDown, true);
      activeKeydownHandler = null;
    }
    const cleanupErrors = [];
    for (const cleanup of [
      () => overlay.removeEventListener('keydown', onTrapKeyDown, true),
      () => overlay.remove(),
      releaseDocumentOwnership,
      () => prevFocus?.focus?.()
    ]) {
      if (cleanup === null) continue;
      try {
        cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (
      releaseModalLayer === null &&
      activeDialogCancel === cancel
    ) {
      activeDialogCancel = null;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        `Confirm dialog teardown failed in ${cleanupErrors.length} operations`
      );
    }
  };
  const cancel = () => {
    if (closed) {
      close();
      return;
    }
    close();
    onCancel?.();
  };

  const cancelBtn = overlay.querySelector('.confirm-dialog-cancel');
  const confirmBtn = overlay.querySelector('.confirm-dialog-confirm');
  const textarea = overlay.querySelector('.confirm-dialog-textarea');
  const charCounter = overlay.querySelector('.confirm-dialog-char-counter');

  if (wantsInput && textarea && charCounter) {
    const maxLen = Number.parseInt(textarea.getAttribute('maxlength') || '', 10);
    const maxLabel = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : null;
    const updateCounter = () => {
      const cur = String(textarea.value || '').length;
      charCounter.textContent = `${cur}/${maxLabel ?? '—'}`;
    };
    textarea.addEventListener('input', updateCounter, { passive: true });
    updateCounter();
  }

  cancelBtn?.addEventListener('click', () => {
    cancel();
  });
  confirmBtn?.addEventListener('click', () => {
    const note = wantsInput ? String(textarea?.value || '') : null;
    close();
    onConfirm?.(note);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cancel();
    }
  });

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    try {
      e.preventDefault?.();
      e.stopPropagation?.();
      e.stopImmediatePropagation?.();
    } catch {
      // The dialog still closes when a synthetic event method throws.
    }
    cancel();
  };
  activeDialogCancel = cancel;
  activeKeydownHandler = onKeyDown;
  document.addEventListener('keydown', onKeyDown, true);

  try {
    releaseModalLayer = claimModalDocumentLayer(overlay);
    document.body.appendChild(overlay);
    if (wantsInput) textarea?.focus?.();
    else confirmBtn?.focus?.();
  } catch (primaryError) {
    const rollbackErrors = [primaryError];
    try {
      close();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length === 1) throw primaryError;
    throw new AggregateError(
      rollbackErrors,
      'Confirm dialog creation and rollback failed'
    );
  }
  return cancel;
}
