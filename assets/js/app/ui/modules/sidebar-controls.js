/**
 * @fileoverview Sidebar toggle + resize wiring.
 *
 * Keeps sidebar open/close state, updates ARIA attributes, and manages the
 * resize drag handle by updating the `--sidebar-width` CSS variable.
 *
 * @module ui/modules/sidebar-controls
 */

import { clampSidebarWidthPx } from '../../sidebar-metrics.js';
import { StyleManager } from '../../../utils/style-manager.js';

export function initSidebarControls({ dom }) {
  if (dom === null || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Sidebar controls require one DOM reference object.');
  }
  const { el: sidebar, toggleBtn: sidebarToggle, resizeHandle: sidebarResizeHandle } = dom;
  for (const [label, element] of [
    ['sidebar', sidebar],
    ['sidebar toggle', sidebarToggle],
    ['sidebar resize handle', sidebarResizeHandle],
  ]) {
    if (!(element instanceof HTMLElement)) {
      throw new TypeError(`Sidebar controls require the ${label} HTMLElement.`);
    }
  }
  const ownerDocument = sidebar.ownerDocument;
  if (
    sidebarToggle.ownerDocument !== ownerDocument ||
    sidebarResizeHandle.ownerDocument !== ownerDocument
  ) {
    throw new TypeError('Sidebar controls require elements from one document.');
  }
  if (!(ownerDocument.documentElement instanceof HTMLElement)) {
    throw new TypeError('Sidebar controls require an HTML document root.');
  }

  const syncSidebarToggleState = () => {
    const isHidden = sidebar.classList.contains('hidden');
    sidebarToggle.classList.toggle('sidebar-open', !isHidden);
    sidebarToggle.textContent = isHidden ? '☰' : '✕';
    sidebarToggle.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
    sidebarToggle.setAttribute('aria-label', isHidden ? 'Show sidebar' : 'Hide sidebar');
    sidebarToggle.title = isHidden ? 'Show sidebar' : 'Hide sidebar';
  };

  sidebarToggle.type = 'button';
  if (sidebar.id.length === 0) {
    throw new TypeError('Sidebar controls require a non-empty sidebar id.');
  }
  sidebarToggle.setAttribute('aria-controls', sidebar.id);

  const initialWidth = sidebar.getBoundingClientRect().width;
  if (!Number.isFinite(initialWidth) || initialWidth <= 0) {
    throw new RangeError('Sidebar width must be positive before initialization.');
  }
  StyleManager.setVariable(
    ownerDocument.documentElement,
    '--sidebar-width',
    `${Math.round(initialWidth)}px`
  );
  syncSidebarToggleState();

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    syncSidebarToggleState();
  });

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  const updateSidebarWidth = (width) => {
    const clampedWidth = clampSidebarWidthPx(width);
    StyleManager.setVariable(
      ownerDocument.documentElement,
      '--sidebar-width',
      `${clampedWidth}px`
    );
  };

  sidebarResizeHandle.addEventListener('mousedown', (event) => {
    if (!(event instanceof MouseEvent)) {
      throw new TypeError('Sidebar resize start requires a MouseEvent.');
    }
    if (!Number.isFinite(sidebar.offsetWidth) || sidebar.offsetWidth <= 0) {
      throw new RangeError('Sidebar resize requires a positive current width.');
    }
    isResizing = true;
    startX = event.clientX;
    startWidth = sidebar.offsetWidth;
    sidebar.classList.add('resizing');
    ownerDocument.body.style.cursor = 'ew-resize';
    ownerDocument.body.style.userSelect = 'none';
    event.preventDefault();
  });

  ownerDocument.addEventListener('mousemove', (event) => {
    if (!isResizing) return;
    updateSidebarWidth(startWidth + event.clientX - startX);
  });

  ownerDocument.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove('resizing');
    ownerDocument.body.style.cursor = '';
    ownerDocument.body.style.userSelect = '';
  });

  return { syncSidebarToggleState };
}
