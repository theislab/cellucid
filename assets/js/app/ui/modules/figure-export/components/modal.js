/**
 * @fileoverview Shared modal helpers for figure export.
 *
 * Uses lightweight DOM construction (no framework) and relies on CSS tokens
 * defined in `assets/css/components/_figure-export.css`.
 *
 * @module ui/modules/figure-export/components/modal
 */

import { createElement } from '../../../../utils/dom-utils.js';

let activeKeydownHandler = null;

/**
 * @param {object} options
 * @param {string} options.title
 * @param {HTMLElement} options.content
 * @param {() => void} [options.onClose]
 * @returns {{ close: () => void }}
 */
export function showFigureExportModal({ title, content, onClose }) {
  if (activeKeydownHandler) {
    document.removeEventListener('keydown', activeKeydownHandler);
    activeKeydownHandler = null;
  }

  const existing = document.querySelector('.figure-export-modal');
  if (existing) existing.remove();

  const modal = createElement('div', {
    className: 'figure-export-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Dialog'
  });

  const backdrop = createElement('div', { className: 'figure-export-modal-backdrop' });
  const contentEl = createElement('div', { className: 'figure-export-modal-content', role: 'document' });
  const titleEl = createElement('div', { className: 'figure-export-modal-title' }, [title || '']);

  contentEl.appendChild(titleEl);
  contentEl.appendChild(content);
  modal.appendChild(backdrop);
  modal.appendChild(contentEl);

  let closed = false;

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    close();
  };

  const close = () => {
    if (closed) return;
    closed = true;

    document.removeEventListener('keydown', onKeyDown);
    if (activeKeydownHandler === onKeyDown) {
      activeKeydownHandler = null;
    }
    modal.remove();
    onClose?.();
  };

  backdrop.addEventListener('click', close);

  activeKeydownHandler = onKeyDown;
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(modal);

  // Focus first button if present.
  contentEl.querySelector('button')?.focus?.();

  return { close };
}
