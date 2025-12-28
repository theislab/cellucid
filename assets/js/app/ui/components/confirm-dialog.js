/**
 * Confirm dialog (lightweight modal) for destructive actions.
 *
 * The dialog is intentionally dependency-free and uses existing CSS tokens.
 */

import { escapeHtml } from '../utils.js';

let activeKeydownHandler = null;

function createDomId(prefix = 'id') {
  const p = String(prefix || 'id').trim() || 'id';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${p}-${crypto.randomUUID()}`;
    }
  } catch {
    // ignore
  }
  return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  const prevFocus = document.activeElement;
  const titleId = createDomId('confirm-dialog-title');
  overlay.setAttribute('aria-labelledby', titleId);

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
    if (closed) return;
    closed = true;
    if (activeKeydownHandler) {
      document.removeEventListener('keydown', activeKeydownHandler);
      activeKeydownHandler = null;
    }
    try {
      overlay.removeEventListener('keydown', onTrapKeyDown, true);
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
