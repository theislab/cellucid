/**
 * @fileoverview Sidebar toggle + resize wiring.
 *
 * Keeps sidebar open/close state, updates ARIA attributes, and manages the
 * resize drag handle by updating the `--sidebar-width` CSS variable.
 *
 * @module ui/modules/sidebar-controls
 */

import { SIDEBAR_MIN_WIDTH_PX, clampSidebarWidthPx } from '../../sidebar-metrics.js';
import { StyleManager } from '../../../utils/style-manager.js';

export function initSidebarControls({ dom }) {
  const sidebar = dom?.el || null;
  const sidebarToggle = dom?.toggleBtn || null;
  const sidebarResizeHandle = dom?.resizeHandle || null;

  if (!sidebar || !sidebarToggle) return {};

  const syncSidebarToggleState = () => {
    const isHidden = sidebar.classList.contains('hidden');
    sidebarToggle.classList.toggle('sidebar-open', !isHidden);
    sidebarToggle.textContent = isHidden ? '☰' : '✕';
    sidebarToggle.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
    sidebarToggle.setAttribute('aria-label', isHidden ? 'Show sidebar' : 'Hide sidebar');
    sidebarToggle.title = isHidden ? 'Show sidebar' : 'Hide sidebar';
  };

  sidebarToggle.type = 'button';
  sidebarToggle.setAttribute('aria-controls', sidebar.id || 'sidebar');

  try {
    StyleManager.setVariable(
      document.documentElement,
      '--sidebar-width',
      `${Math.round(sidebar.getBoundingClientRect().width)}px`
    );
  } catch {
    // ignore: running outside browser
  }
  syncSidebarToggleState();

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    syncSidebarToggleState();
  });

  if (sidebarResizeHandle) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const updateSidebarWidth = (width) => {
      const clampedWidth = clampSidebarWidthPx(width);
      StyleManager.setVariable(document.documentElement, '--sidebar-width', `${clampedWidth}px`);
    };

    sidebarResizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      if (startWidth < SIDEBAR_MIN_WIDTH_PX) startWidth = SIDEBAR_MIN_WIDTH_PX;
      sidebar.classList.add('resizing');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const deltaX = e.clientX - startX;
      updateSidebarWidth(startWidth + deltaX);
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      sidebar.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  return { syncSidebarToggleState };
}

