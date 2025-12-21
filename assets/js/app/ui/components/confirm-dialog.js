/**
 * Confirm dialog (lightweight modal) for destructive actions.
 *
 * The dialog is intentionally dependency-free and uses existing CSS tokens.
 */

import { escapeHtml } from '../utils.js';

export function showConfirmDialog({
  title,
  message,
  confirmText = 'Delete',
  onConfirm,
  onCancel
}) {
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

  const close = () => overlay.remove();

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
    document.removeEventListener('keydown', onKeyDown);
  };
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(overlay);
  confirmBtn?.focus?.();
}

