/**
 * @fileoverview Sidebar toggle + resize wiring.
 *
 * Keeps sidebar open/close state, updates ARIA attributes, and manages the
 * resize drag handle by updating the desktop `--sidebar-user-width` input.
 *
 * @module ui/modules/sidebar-controls
 */

import { clampSidebarWidthPx } from '../../sidebar-metrics.js';
import { StyleManager } from '../../../utils/style-manager.js';
import { computeLeftOcclusionRatio } from '../../../rendering/viewport-center.js';

export function initSidebarControls({ dom, onViewportOcclusionChange }) {
  if (dom === null || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Sidebar controls require one DOM reference object.');
  }
  if (typeof onViewportOcclusionChange !== 'function') {
    throw new TypeError(
      'Sidebar controls require one viewport-occlusion callback.',
    );
  }
  const {
    el: sidebar,
    toggleBtn: sidebarToggle,
    resizeHandle: sidebarResizeHandle,
    canvas,
  } = dom;
  for (const [label, element] of [
    ['sidebar', sidebar],
    ['sidebar toggle', sidebarToggle],
    ['sidebar resize handle', sidebarResizeHandle],
    ['canvas', canvas],
  ]) {
    if (!(element instanceof HTMLElement)) {
      throw new TypeError(`Sidebar controls require the ${label} HTMLElement.`);
    }
  }
  const ownerDocument = sidebar.ownerDocument;
  if (
    sidebarToggle.ownerDocument !== ownerDocument ||
    sidebarResizeHandle.ownerDocument !== ownerDocument ||
    canvas.ownerDocument !== ownerDocument
  ) {
    throw new TypeError('Sidebar controls require elements from one document.');
  }
  if (!(ownerDocument.documentElement instanceof HTMLElement)) {
    throw new TypeError('Sidebar controls require an HTML document root.');
  }
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null || typeof ownerWindow.matchMedia !== 'function') {
    throw new TypeError('Sidebar controls require a window with matchMedia.');
  }
  if (typeof ResizeObserver !== 'function') {
    throw new Error('Sidebar controls require ResizeObserver support.');
  }
  const responsiveResizeMedia = ownerWindow.matchMedia('(max-width: 900px)');
  const occlusionGeometry = {
    canvasLeft: 0,
    canvasWidth: 0,
    sidebarLeft: 0,
    sidebarWidth: 0,
    sidebarVisible: false,
  };

  const publishViewportOcclusion = () => {
    const canvasRect = canvas.getBoundingClientRect();
    occlusionGeometry.canvasLeft = canvasRect.left;
    occlusionGeometry.canvasWidth = canvasRect.width;
    occlusionGeometry.sidebarLeft = sidebar.offsetLeft;
    occlusionGeometry.sidebarWidth = sidebar.offsetWidth;
    occlusionGeometry.sidebarVisible = !sidebar.classList.contains('hidden');
    onViewportOcclusionChange(
      computeLeftOcclusionRatio(occlusionGeometry)
    );
  };

  const publishCachedViewportOcclusion = (sidebarWidth) => {
    occlusionGeometry.sidebarWidth = sidebarWidth;
    occlusionGeometry.sidebarVisible = !sidebar.classList.contains('hidden');
    onViewportOcclusionChange(
      computeLeftOcclusionRatio(occlusionGeometry)
    );
  };

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
  syncSidebarToggleState();
  publishViewportOcclusion();

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    syncSidebarToggleState();
    publishViewportOcclusion();
  });

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  const finishSidebarResize = () => {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove('resizing');
    ownerDocument.body.style.cursor = '';
    ownerDocument.body.style.userSelect = '';
  };

  const updateSidebarWidth = (width) => {
    const clampedWidth = clampSidebarWidthPx(width);
    StyleManager.setVariable(
      ownerDocument.documentElement,
      '--sidebar-user-width',
      `${clampedWidth}px`
    );
    // The drag path reuses the last observed canvas geometry, so the camera
    // follows immediately without a layout read or per-event object.
    publishCachedViewportOcclusion(clampedWidth);
  };

  sidebarResizeHandle.addEventListener('mousedown', (event) => {
    if (!(event instanceof MouseEvent)) {
      throw new TypeError('Sidebar resize start requires a MouseEvent.');
    }
    if (responsiveResizeMedia.matches) {
      event.preventDefault();
      return;
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
    if (responsiveResizeMedia.matches) {
      finishSidebarResize();
      return;
    }
    updateSidebarWidth(startWidth + event.clientX - startX);
  });

  ownerDocument.addEventListener('mouseup', finishSidebarResize);
  responsiveResizeMedia.addEventListener('change', event => {
    if (event.matches) finishSidebarResize();
  });

  const geometryObserver = new ResizeObserver(publishViewportOcclusion);
  geometryObserver.observe(sidebar);
  geometryObserver.observe(canvas);

  return {
    syncSidebarToggleState,
    disconnectGeometryObserver() {
      geometryObserver.disconnect();
    },
  };
}
