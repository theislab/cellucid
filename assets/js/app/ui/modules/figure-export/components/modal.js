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
 * @param {() => void} options.onClose
 * @returns {{ close: () => void }}
 */
export function showFigureExportModal({ title, content, onClose }) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new TypeError('Figure export modal title must be a non-empty string.');
  }
  if (!(content instanceof HTMLElement)) {
    throw new TypeError('Figure export modal content must be an HTMLElement.');
  }
  if (typeof onClose !== 'function') {
    throw new TypeError('Figure export modal onClose must be a function.');
  }
  if (activeKeydownHandler) {
    throw new Error('A figure export modal is already active.');
  }

  const existing = document.querySelector('.figure-export-modal');
  if (existing) {
    throw new Error('A figure export modal already exists in the document.');
  }

  const modal = createElement('div', {
    className: 'figure-export-modal',
    role: 'dialog',
    ariaModal: 'true',
    ariaLabel: title
  });

  const backdrop = createElement('div', { className: 'figure-export-modal-backdrop' });
  const contentEl = createElement('div', { className: 'figure-export-modal-content', role: 'document' });
  const titleEl = createElement('div', { className: 'figure-export-modal-title' }, [title]);

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
    onClose();
  };

  backdrop.addEventListener('click', close);

  activeKeydownHandler = onKeyDown;
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(modal);

  const firstButton = contentEl.querySelector('button');
  if (!(firstButton instanceof HTMLButtonElement)) {
    document.removeEventListener('keydown', onKeyDown);
    activeKeydownHandler = null;
    modal.remove();
    throw new Error('Figure export modal content must contain a button.');
  }
  firstButton.focus();

  return { close };
}
