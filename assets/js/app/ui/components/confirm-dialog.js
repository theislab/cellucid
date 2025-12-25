/**
 * Confirm dialog (lightweight modal) for destructive actions.
 *
 * The dialog is intentionally dependency-free and uses existing CSS tokens.
 */

import { escapeHtml } from '../utils.js';

let activeKeydownHandler = null;

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
  if (activeKeydownHandler) {
    document.removeEventListener('keydown', activeKeydownHandler);
    activeKeydownHandler = null;
  }

  const existing = document.querySelector('.confirm-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const wantsInput = Boolean(inputLabel || inputPlaceholder);
  const inputBlock = wantsInput
    ? `
      <div class="confirm-dialog-input">
        ${inputLabel ? `<div class="confirm-dialog-input-label">${escapeHtml(inputLabel)}</div>` : ''}
        <div class="confirm-dialog-textarea-wrap">
          <textarea
            class="confirm-dialog-textarea"
            rows="3"
            maxlength="${escapeHtml(String(inputMaxLength))}"
            placeholder="${escapeHtml(inputPlaceholder || '')}"
          >${escapeHtml(inputDefaultValue || '')}</textarea>
          <div class="confirm-dialog-char-counter confirm-dialog-char-counter--overlay"></div>
        </div>
      </div>
    `
    : '';

  overlay.innerHTML = `
    <div class="confirm-dialog" role="document">
      <div class="confirm-dialog-header">
        <span class="confirm-dialog-title">${escapeHtml(title || 'Confirm')}</span>
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
  const close = () => {
    if (closed) return;
    closed = true;
    if (activeKeydownHandler) {
      document.removeEventListener('keydown', activeKeydownHandler);
      activeKeydownHandler = null;
    }
    overlay.remove();
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
    close();
    onCancel?.();
  });
  confirmBtn?.addEventListener('click', () => {
    const note = wantsInput ? String(textarea?.value || '') : null;
    close();
    onConfirm?.(note);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
      onCancel?.();
    }
  });

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    close();
    onCancel?.();
  };
  activeKeydownHandler = onKeyDown;
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(overlay);
  if (wantsInput) textarea?.focus?.();
  else confirmBtn?.focus?.();
}
