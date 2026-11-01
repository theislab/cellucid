/**
 * @fileoverview Sidebar toggle + resize wiring.
 *
 * Keeps sidebar open/close state, updates ARIA attributes, makes the hidden
 * sidebar `inert` (nothing in it is focusable or tabbable), and manages the
 * resize drag handle by updating the desktop `--sidebar-user-width` input.
 *
 * It is also the one owner of the presented area: the part of the canvas the
 * sidebar does not cover. It publishes that area as the fraction of the
 * canvas covered from the left (`onViewportOcclusionChange(ratio)`), and the
 * viewer lays every view out inside the rest. The ratio is republished on
 * every geometry change: a toggle (and again when its slide animation ends;
 * while it slides, the area stays the one beside the open sidebar), a live
 * resize drag, a window or canvas resize, and a responsive breakpoint. On
 * the phone layout the open sidebar is a full-screen sheet the user closes
 * to reach the plot, not a panel beside it, so it occludes nothing.
 *
 * @module ui/modules/sidebar-controls
 */

import { rememberPhoneSheet } from '../core/phone-sheet-memory.js';
import { clampSidebarWidthPx } from '../../sidebar-metrics.js';
import { StyleManager } from '../../../utils/style-manager.js';
import { computeLeftOcclusionRatio } from '../../../rendering/viewport-center.js';

/**
 * Open the sidebar for a control outside it that leads to one inside it
 * (Data mapping's way to its checklist, a gene sample's way to Genes read
 * for). It works from the first frame: until the controls below take the
 * phone's peek state over, that state is still the root's mark
 * (`viewport-init.js`), which is dropped so the panel starts open; afterwards
 * the toggle opens it, through the one path that keeps its state, ARIA and
 * the presented area.
 *
 * @param {Document} ownerDocument
 */
export function revealSidebar(ownerDocument) {
  const root = ownerDocument.documentElement;
  if (root.dataset.phoneSheet === 'peek') {
    delete root.dataset.phoneSheet;
    rememberPhoneSheet(ownerDocument.defaultView, 'open');
    return;
  }
  if (ownerDocument.getElementById('sidebar')?.classList.contains('hidden')) {
    ownerDocument.getElementById('sidebar-toggle')?.click();
  }
}

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
  if (typeof sidebar.getAnimations !== 'function') {
    throw new Error('Sidebar controls require Web Animations getAnimations().');
  }
  const responsiveResizeMedia = ownerWindow.matchMedia('(max-width: 900px)');
  let destroyed = false;
  const occlusionGeometry = {
    canvasLeft: 0,
    canvasWidth: 0,
    sidebarLeft: 0,
    sidebarWidth: 0,
    sidebarVisible: false,
  };

  // The open/close slide is a CSS transform, which no ResizeObserver sees.
  // While it runs, the presented area stays the one beside the *open*
  // sidebar: on opening it shrinks at once, before the sidebar slides into
  // the space; on closing it grows only when the sidebar has finished
  // sliding away. The panes are therefore never under the moving sidebar,
  // every pane keeps the same visible area in every frame, and nothing is
  // republished per frame. One rAF poll per frame watches for the end.
  let transitionFrame = 0;
  const isSidebarTransitionRunning = () => sidebar.getAnimations().length > 0;

  // A sidebar at least as wide as the canvas is the phone sheet: it hides the
  // plot instead of sitting beside it, and the plot is used with it closed.
  const captureSidebarGeometry = () => {
    occlusionGeometry.sidebarLeft = sidebar.offsetLeft;
    occlusionGeometry.sidebarWidth = sidebar.offsetWidth;
    occlusionGeometry.sidebarVisible =
      sidebar.offsetWidth < occlusionGeometry.canvasWidth &&
      (!sidebar.classList.contains('hidden') || isSidebarTransitionRunning());
  };

  const publishOcclusionGeometry = () => {
    onViewportOcclusionChange(
      computeLeftOcclusionRatio(occlusionGeometry)
    );
  };

  const publishViewportOcclusion = () => {
    if (destroyed) return;
    const canvasRect = canvas.getBoundingClientRect();
    occlusionGeometry.canvasLeft = canvasRect.left;
    occlusionGeometry.canvasWidth = canvasRect.width;
    captureSidebarGeometry();
    publishOcclusionGeometry();
  };

  const publishCachedViewportOcclusion = (sidebarWidth) => {
    if (destroyed) return;
    occlusionGeometry.sidebarWidth = sidebarWidth;
    publishOcclusionGeometry();
  };

  const awaitSidebarTransitionEnd = () => {
    transitionFrame = 0;
    if (destroyed) return;
    if (isSidebarTransitionRunning()) {
      transitionFrame = ownerWindow.requestAnimationFrame(
        awaitSidebarTransitionEnd
      );
      return;
    }
    publishViewportOcclusion();
  };

  const syncSidebarToggleState = () => {
    if (destroyed) return;
    const isHidden = sidebar.classList.contains('hidden');
    // A hidden sidebar is off screen: none of its controls may take focus,
    // be tabbed to, or be reached by assistive technology until it reopens.
    sidebar.inert = isHidden;
    sidebarToggle.classList.toggle('sidebar-open', !isHidden);
    sidebarToggle.textContent = isHidden ? '☰' : '✕';
    sidebarToggle.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
    sidebarToggle.setAttribute('aria-label', isHidden ? 'Show sidebar' : 'Hide sidebar');
    sidebarToggle.title = isHidden ? 'Show sidebar' : 'Hide sidebar';
    ownerDocument.getElementById('phone-sheet-bar')?.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
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
  // The phone layout starts with the plot (`viewport-init.js` marked the root
  // before the stylesheet applied): the panel waits as the peek bar, a state
  // the sidebar's own `hidden` holds from here.
  const root = ownerDocument.documentElement;
  if (root.dataset.phoneSheet === 'peek') {
    sidebar.classList.add('hidden');
    delete root.dataset.phoneSheet;
  }
  syncSidebarToggleState();
  publishViewportOcclusion();

  // Whether this tab left the phone panel open or as the peek bar, kept for
  // the next load of the tab (session storage: never in the address).
  const phoneLayout = ownerWindow.matchMedia?.('(max-width: 720px)') ?? null;
  const rememberSheet = () => {
    if (phoneLayout?.matches !== true) return;
    rememberPhoneSheet(ownerWindow, sidebar.classList.contains('hidden') ? 'peek' : 'open');
  };

  const handleSidebarToggle = () => {
    if (destroyed) return;
    sidebar.classList.toggle('hidden');
    rememberSheet();
    syncSidebarToggleState();
    publishViewportOcclusion();
    if (transitionFrame === 0) {
      transitionFrame = ownerWindow.requestAnimationFrame(
        awaitSidebarTransitionEnd
      );
    }
  };
  sidebarToggle.addEventListener('click', handleSidebarToggle);

  // The phone panel's peek bar: the dataset's name and a handle; a tap or an
  // upward swipe opens the panel.
  const phoneSheetBar = ownerDocument.getElementById('phone-sheet-bar');
  const phoneSheetName = ownerDocument.getElementById('phone-sheet-name');
  const datasetName = ownerDocument.getElementById('dataset-name');
  const openFromBar = () => {
    if (!destroyed && sidebar.classList.contains('hidden')) handleSidebarToggle();
  };
  let swipeFrom = null;
  const onBarPointerDown = event => { swipeFrom = event.clientY; };
  const onBarPointerUp = event => {
    const from = swipeFrom;
    swipeFrom = null;
    if (from !== null && from - event.clientY > 24) openFromBar();
  };
  const nameObserver = datasetName === null || phoneSheetName === null
    ? null
    : new MutationObserver(() => { phoneSheetName.textContent = datasetName.textContent; });
  if (phoneSheetBar !== null) {
    phoneSheetBar.addEventListener('click', openFromBar);
    phoneSheetBar.addEventListener('pointerdown', onBarPointerDown);
    phoneSheetBar.addEventListener('pointerup', onBarPointerUp);
  }
  if (nameObserver !== null) {
    phoneSheetName.textContent = datasetName.textContent;
    nameObserver.observe(datasetName, { childList: true, characterData: true, subtree: true });
  }

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  const finishSidebarResize = () => {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove('resizing');
    ownerDocument.body.style.cursor = '';
    ownerDocument.body.style.userSelect = '';
    ownerDocument.body.style.webkitUserSelect = '';
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

  const handleSidebarResizeStart = (event) => {
    if (destroyed) return;
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
    // Safari honours only the -webkit- property.
    ownerDocument.body.style.userSelect = 'none';
    ownerDocument.body.style.webkitUserSelect = 'none';
    event.preventDefault();
  };
  sidebarResizeHandle.addEventListener(
    'mousedown',
    handleSidebarResizeStart
  );

  const handleSidebarResizeMove = (event) => {
    if (destroyed) return;
    if (!isResizing) return;
    if (responsiveResizeMedia.matches) {
      finishSidebarResize();
      return;
    }
    updateSidebarWidth(startWidth + event.clientX - startX);
  };
  ownerDocument.addEventListener('mousemove', handleSidebarResizeMove);

  ownerDocument.addEventListener('mouseup', finishSidebarResize);
  const handleResponsiveResizeChange = event => {
    if (destroyed) return;
    if (event.matches) finishSidebarResize();
  };
  responsiveResizeMedia.addEventListener(
    'change',
    handleResponsiveResizeChange
  );

  const geometryObserver = new ResizeObserver(publishViewportOcclusion);
  geometryObserver.observe(sidebar);
  geometryObserver.observe(canvas);

  return {
    syncSidebarToggleState,
    disconnectGeometryObserver() {
      geometryObserver.disconnect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (transitionFrame !== 0) {
        ownerWindow.cancelAnimationFrame(transitionFrame);
        transitionFrame = 0;
      }
      finishSidebarResize();
      sidebarToggle.removeEventListener('click', handleSidebarToggle);
      if (phoneSheetBar !== null) {
        phoneSheetBar.removeEventListener('click', openFromBar);
        phoneSheetBar.removeEventListener('pointerdown', onBarPointerDown);
        phoneSheetBar.removeEventListener('pointerup', onBarPointerUp);
      }
      nameObserver?.disconnect();
      sidebarResizeHandle.removeEventListener(
        'mousedown',
        handleSidebarResizeStart
      );
      ownerDocument.removeEventListener(
        'mousemove',
        handleSidebarResizeMove
      );
      ownerDocument.removeEventListener('mouseup', finishSidebarResize);
      responsiveResizeMedia.removeEventListener(
        'change',
        handleResponsiveResizeChange
      );
      geometryObserver.disconnect();
    },
  };
}
