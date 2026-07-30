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
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

function getFocusableElements(owner) {
  return Array.from(owner.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    element => (
      element instanceof HTMLElement &&
      element.tabIndex >= 0 &&
      element.getAttribute('aria-hidden') !== 'true' &&
      !('disabled' in element && element.disabled)
    )
  );
}

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

  const invokingElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const modal = createElement('div', {
    className: 'figure-export-modal',
    role: 'dialog',
    ariaModal: 'true',
    ariaLabel: title
  });

  const backdrop = createElement('div', { className: 'figure-export-modal-backdrop' });
  const contentEl = createElement('div', {
    className: 'figure-export-modal-content',
    role: 'document',
    tabIndex: -1,
  });
  const titleEl = createElement('div', { className: 'figure-export-modal-title' }, [title]);

  contentEl.appendChild(titleEl);
  contentEl.appendChild(content);
  modal.appendChild(backdrop);
  modal.appendChild(contentEl);

  let closed = false;
  const backgroundOwners = Array.from(document.body.children)
    .filter(element => element instanceof HTMLElement)
    .map(element => ({
      element,
      inert: element.inert,
    }));

  const restoreBackgroundAndFocus = () => {
    for (const owner of backgroundOwners) {
      owner.element.inert = owner.inert;
    }
    if (
      invokingElement?.isConnected &&
      !('disabled' in invokingElement && invokingElement.disabled)
    ) {
      invokingElement.focus();
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = getFocusableElements(contentEl);
    if (focusable.length === 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      contentEl.focus();
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement);
    const nextIndex = e.shiftKey
      ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
      : (
          activeIndex < 0 || activeIndex === focusable.length - 1
            ? 0
            : activeIndex + 1
        );
    e.preventDefault();
    e.stopImmediatePropagation();
    focusable[nextIndex].focus();
  };

  const close = () => {
    if (closed) return;
    closed = true;

    document.removeEventListener('keydown', onKeyDown, true);
    if (activeKeydownHandler === onKeyDown) {
      activeKeydownHandler = null;
    }
    modal.remove();
    restoreBackgroundAndFocus();
    onClose();
  };

  backdrop.addEventListener('click', close);

  activeKeydownHandler = onKeyDown;
  document.addEventListener('keydown', onKeyDown, true);

  for (const owner of backgroundOwners) {
    owner.element.inert = true;
  }
  document.body.appendChild(modal);

  const firstButton = getFocusableElements(contentEl).find(
    element => element instanceof HTMLButtonElement
  );
  if (!(firstButton instanceof HTMLButtonElement)) {
    document.removeEventListener('keydown', onKeyDown, true);
    activeKeydownHandler = null;
    modal.remove();
    restoreBackgroundAndFocus();
    throw new Error(
      'Figure export modal content must contain an enabled focusable button.'
    );
  }
  firstButton.focus();

  return { close };
}
