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

  overlay.innerHTML = `
    <div class="confirm-dialog" role="document">
      <div class="confirm-dialog-header">
        <span class="confirm-dialog-title">${escapeHtml(title || 'Confirm')}</span>
      </div>
      <div class="confirm-dialog-body">${escapeHtml(message || '')}</div>
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

  cancelBtn?.addEventListener('click', () => {
    close();
    onCancel?.();
  });
  confirmBtn?.addEventListener('click', () => {
    close();
    onConfirm?.();
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
  confirmBtn?.focus?.();
}
