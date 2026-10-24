/**
 * Modal System for Analysis
 *
 * Provides the analysis popup/modal component with:
 * - Resizable grid layout with plot, options panel, and statistical panel
 * - Resize from every edge and corner, by pointer (mouse, pen, touch) and keyboard
 * - Internal panel splitters, by pointer and keyboard
 * - Moving by the header; a double-click on it maximizes
 * - Size and splits remembered per analysis (shared/analysis-view-sizes.js)
 * - Full screen on a narrow screen, with a touch grip on its split
 * - Lifecycle management (open/close)
 */

import { purgePlot } from '../../plots/plotly-loader.js';
import { createExportToolbar } from './export.js';
import { coalesceToFrame } from '../../../ui/components/controls.js';
import {
  RESIZE_EDGES,
  clampFloatingPosition,
  keyboardResizeTravel,
  maximizedFloatingRect,
  resizeFloatingRect
} from '../../../dockable-accordions/geometry.js';
import { analysisViewSizes } from '../../shared/analysis-view-sizes.js';
import { capturePointer } from '../../../ui/pointer-capture.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MIN_SIZES = {
  optionsWidth: 200,      // Right panel min width
  plotWidth: 250,         // Left plot area min width
  footerHeight: 200,      // Bottom panels min height
  bodyHeight: 200,        // Main body min height
  statsWidth: 200,        // Stats panel min width
  annotationsWidth: 200,  // Annotations panel min width
};

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
let analysisModalIdCounter = 0;

function getFocusableElements(modal) {
  return [...modal.querySelectorAll(FOCUSABLE_SELECTOR)].filter(element => {
    if (
      element.disabled === true ||
      element.hidden === true ||
      element.getAttribute?.('aria-hidden') === 'true' ||
      element.getAttribute?.('tabindex') === '-1'
    ) {
      return false;
    }
    if (
      typeof element.getClientRects === 'function' &&
      element.getClientRects().length === 0
    ) {
      return false;
    }
    return true;
  });
}

function isTopmostOpenAnalysisModal(modal) {
  if (typeof document.querySelectorAll !== 'function') return true;
  const openModals = document.querySelectorAll('.analysis-modal.open');
  return openModals.length === 0 || openModals[openModals.length - 1] === modal;
}

function restoreModalFocus(modal) {
  const previous = modal._previouslyFocusedElement ?? null;
  modal._previouslyFocusedElement = null;
  if (
    previous === null ||
    typeof previous.focus !== 'function' ||
    previous.isConnected === false
  ) {
    return;
  }
  try {
    previous.focus({ preventScroll: true });
  } catch {
    previous.focus();
  }
}

function captureInlineStyle(style, property) {
  return {
    priority: style.getPropertyPriority(property),
    value: style.getPropertyValue(property)
  };
}

function restoreInlineStyle(style, property, snapshot) {
  style.removeProperty(property);
  if (snapshot.value !== '') {
    style.setProperty(property, snapshot.value, snapshot.priority);
  }
}

function captureUserSelectStyles(style) {
  return {
    standard: captureInlineStyle(style, 'user-select'),
    webkit: captureInlineStyle(style, '-webkit-user-select')
  };
}

function setUserSelect(style, value) {
  style.setProperty('user-select', value);
  style.setProperty('-webkit-user-select', value);
}

function restoreUserSelectStyles(style, snapshots) {
  restoreInlineStyle(style, 'user-select', snapshots.standard);
  restoreInlineStyle(style, '-webkit-user-select', snapshots.webkit);
}

/**
 * An internal splitter: a focusable separator, moved by pointer or arrows.
 *
 * @param {string} className
 * @param {'vertical'|'horizontal'|null} orientation - null for the corner
 *   where two splitters cross, which moves both.
 * @param {string} label
 * @returns {HTMLDivElement}
 */
function createSplitter(className, orientation, label) {
  const splitter = document.createElement('div');
  splitter.className = className;
  splitter.setAttribute('role', 'separator');
  if (orientation !== null) splitter.setAttribute('aria-orientation', orientation);
  splitter.setAttribute('aria-label', label);
  splitter.setAttribute(
    'aria-keyshortcuts',
    orientation === 'vertical'
      ? 'ArrowLeft ArrowRight'
      : orientation === 'horizontal' ? 'ArrowUp ArrowDown' : 'ArrowLeft ArrowRight ArrowUp ArrowDown'
  );
  splitter.tabIndex = 0;
  return splitter;
}

// =============================================================================
// MODAL CREATION
// =============================================================================

/**
 * Create the analysis popup/modal component
 * The output area is a popup following the design principles of the website
 * Features:
 * - Resizable grid layout with plot, options panel, and statistical panel
 * - Summary statistics and statistical annotations
 * @param {Object} options
 * @param {Function} [options.beforeClose] - Awaited teardown before Plotly/DOM cleanup
 * @param {Function} options.onClose - Callback when modal is closed
 * @param {Function} [options.onCloseError] - Observer for event-triggered close failures
 * @param {Function} options.onExportPNG - Export PNG callback
 * @param {Function} options.onExportSVG - Export SVG callback
 * @param {Function} options.onExportCSV - Export CSV callback
 * @returns {HTMLElement}
 */
export function createAnalysisModal(options = {}) {
  const {
    beforeClose,
    onClose,
    onCloseError,
    onExportPNG,
    onExportSVG,
    onExportCSV
  } = options;
  for (const [name, callback] of [
    ['beforeClose', beforeClose],
    ['onClose', onClose],
    ['onCloseError', onCloseError]
  ]) {
    if (callback !== undefined && typeof callback !== 'function') {
      throw new TypeError(`Analysis modal ${name} must be a function`);
    }
  }

  // Create modal backdrop
  const modal = document.createElement('div');
  modal.className = 'analysis-modal';
  const modalId = ++analysisModalIdCounter;
  const titleId = `analysis-modal-title-${modalId}`;
  modal.setAttribute('aria-labelledby', titleId);
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('role', 'dialog');
  modal.tabIndex = -1;
  modal._cleanupFns = [];
  modal._cleanupDone = false;
  modal._beforeClose = beforeClose ?? null;
  modal._onClose = onClose ?? null;
  modal._onCloseError = onCloseError ?? null;
  modal._closePromise = null;
  modal._previouslyFocusedElement = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'analysis-modal-backdrop';
  backdrop.addEventListener('click', () => {
    requestModalClose(modal);
  });
  modal.appendChild(backdrop);

  // Create modal content with resizable grid
  const content = document.createElement('div');
  content.className = 'analysis-modal-content';

  // Header with title and close button
  const header = document.createElement('div');
  header.className = 'analysis-modal-header';

  const title = document.createElement('h3');
  title.className = 'analysis-modal-title';
  title.id = titleId;
  title.textContent = 'Page analysis';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'analysis-modal-close';
  closeBtn.innerHTML = '×';
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close analysis');
  closeBtn.addEventListener('click', () => {
    requestModalClose(modal);
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  content.appendChild(header);

  // Main body with resizable grid: plot + options
  const body = document.createElement('div');
  body.className = 'analysis-modal-body';

  // Left side: Plot container
  const plotSection = document.createElement('div');
  plotSection.className = 'analysis-modal-plot-section';

  const plotContainer = document.createElement('div');
  plotContainer.className = 'analysis-modal-plot';
  plotSection.appendChild(plotContainer);
  body.appendChild(plotSection);

  // Vertical resizer between plot and options
  const verticalResizer = createSplitter(
    'analysis-modal-resizer analysis-modal-resizer-vertical',
    'vertical',
    'Plot and plot options split'
  );
  body.appendChild(verticalResizer);

  // Right side: Options panel
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'analysis-modal-options';

  const optionsTitle = document.createElement('div');
  optionsTitle.className = 'analysis-options-title';
  const exportToolbar = createExportToolbar({ onExportPNG, onExportSVG, onExportCSV });
  if (exportToolbar.childElementCount > 0) {
    exportToolbar.classList.add('analysis-options-export-toolbar');

    const exportRow = document.createElement('div');
    exportRow.className = 'analysis-options-export-row';

    // The caption names the group of export buttons.
    const exportLabel = document.createElement('span');
    exportLabel.className = 'analysis-options-export-label';
    exportLabel.id = `${titleId}-export`;
    exportLabel.textContent = 'Export';
    exportToolbar.setAttribute('role', 'group');
    exportToolbar.setAttribute('aria-labelledby', exportLabel.id);

    exportRow.appendChild(exportLabel);
    exportRow.appendChild(exportToolbar);
    optionsTitle.appendChild(exportRow);
  }

  const optionsTitleText = document.createElement('span');
  optionsTitleText.className = 'analysis-options-title-text';
  optionsTitleText.textContent = 'Plot options';
  optionsTitle.appendChild(optionsTitleText);
  optionsPanel.appendChild(optionsTitle);

  const optionsContent = document.createElement('div');
  optionsContent.className = 'analysis-options-content';
  optionsPanel.appendChild(optionsContent);

  body.appendChild(optionsPanel);
  content.appendChild(body);

  // Horizontal resizer between body and footer
  const horizontalResizer = createSplitter(
    'analysis-modal-resizer analysis-modal-resizer-horizontal',
    'horizontal',
    'Plot and statistics split'
  );
  content.appendChild(horizontalResizer);

  // Intersection resizer (corner handle for both vertical and horizontal resize)
  const intersectionResizer = createSplitter(
    'analysis-modal-resizer-intersection',
    null,
    'Plot, plot options and statistics split'
  );
  content.appendChild(intersectionResizer);

  // Footer area with two panels: Summary Stats (left) + Statistical Annotations (right)
  const footerArea = document.createElement('div');
  footerArea.className = 'analysis-modal-footer-area';

  // Summary stats panel (left)
  const statsPanel = document.createElement('div');
  statsPanel.className = 'analysis-modal-stats-panel';

  const statsTitle = document.createElement('div');
  statsTitle.className = 'analysis-panel-title';
  statsTitle.textContent = 'Summary statistics';
  statsPanel.appendChild(statsTitle);

  const statsContent = document.createElement('div');
  statsContent.className = 'analysis-stats-content';
  statsPanel.appendChild(statsContent);

  footerArea.appendChild(statsPanel);

  // Footer panel resizer
  const footerResizer = createSplitter(
    'analysis-modal-resizer analysis-modal-resizer-vertical',
    'vertical',
    'Summary statistics and statistical analysis split'
  );
  footerArea.appendChild(footerResizer);

  // Statistical annotations panel (right)
  const annotationsPanel = document.createElement('div');
  annotationsPanel.className = 'analysis-modal-annotations-panel';

  const annotationsTitle = document.createElement('div');
  annotationsTitle.className = 'analysis-panel-title';
  annotationsTitle.textContent = 'Statistical analysis';
  annotationsPanel.appendChild(annotationsTitle);

  const annotationsContent = document.createElement('div');
  annotationsContent.className = 'analysis-annotations-content';
  annotationsPanel.appendChild(annotationsContent);

  footerArea.appendChild(annotationsPanel);
  content.appendChild(footerArea);

  // Resize handles on every edge and corner, after the content in the Tab
  // order. Only the bottom-right corner is a Tab stop: it moves both edges.
  const handles = RESIZE_EDGES.map(edge => {
    const handle = document.createElement('div');
    handle.className = `analysis-modal-edge-resize analysis-modal-edge-resize-${edge}`;
    handle.setAttribute('data-edge', edge);
    handle.setAttribute('role', 'separator');
    if (edge === 'e' || edge === 'w') handle.setAttribute('aria-orientation', 'vertical');
    if (edge === 'n' || edge === 's') handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', `Resize from the ${MODAL_EDGE_NAMES[edge]}`);
    handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End');
    handle.tabIndex = edge === 'se' ? 0 : -1;
    content.appendChild(handle);
    return handle;
  });

  modal.appendChild(content);

  // Initialize modal edge resize
  modal._cleanupFns.push(initializeModalResize(modal, content, handles));

  // Initialize internal panel resizers
  modal._cleanupFns.push(
    initializeResizers(content, body, footerArea, verticalResizer, horizontalResizer, footerResizer, intersectionResizer, optionsPanel, () => rememberModalSizes(modal))
  );

  // Initialize modal dragging
  modal._cleanupFns.push(initializeModalDrag(modal, content, header));

  // Store references
  modal._plotContainer = plotContainer;
  modal._optionsContent = optionsContent;
  modal._statsContent = statsContent;
  modal._annotationsContent = annotationsContent;
  modal._title = title;
  // The region every expanded-view render replaces (plot, stats, annotations).
  modal._body = body;

  return modal;
}

// =============================================================================
// MODAL RESIZE
// =============================================================================

/** Below this width the expanded view fills the screen (_modals.css). */
const FULL_SCREEN_QUERY = '(max-width: 768px)';
const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 64;
const MODAL_EDGE_NAMES = {
  n: 'top edge',
  ne: 'top-right corner',
  e: 'right edge',
  se: 'bottom-right corner',
  s: 'bottom edge',
  sw: 'bottom-left corner',
  w: 'left edge',
  nw: 'top-left corner'
};
const MODAL_EDGE_CURSORS = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
};

function isFullScreenLayout() {
  return window.matchMedia(FULL_SCREEN_QUERY).matches;
}

function modalViewport() {
  return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
}

/**
 * The least size the content still lays out in: the plot's and the options'
 * least widths beside each other, and the header, the plot's least height
 * and the footer's least height above each other.
 *
 * @param {HTMLElement} content
 */
function contentMinimum(content) {
  const header = content.querySelector('.analysis-modal-header');
  const vertical = content.querySelector('.analysis-modal-resizer-vertical');
  const horizontal = content.querySelector('.analysis-modal-resizer-horizontal');
  return {
    minWidth: MIN_SIZES.plotWidth + MIN_SIZES.optionsWidth + (vertical?.offsetWidth ?? 0) + 2,
    minHeight: (header?.offsetHeight ?? 0) + MIN_SIZES.bodyHeight
      + (horizontal?.offsetHeight ?? 0) + MIN_SIZES.footerHeight + 2
  };
}

/** The content's box in layout pixels, which the open transition never scales. */
function contentBox(content) {
  return {
    left: content.offsetLeft,
    top: content.offsetTop,
    width: content.offsetWidth,
    height: content.offsetHeight
  };
}

function writeContentBox(content, rect) {
  content.style.left = `${Math.round(rect.left)}px`;
  content.style.top = `${Math.round(rect.top)}px`;
  content.style.width = `${Math.round(rect.width)}px`;
  content.style.height = `${Math.round(rect.height)}px`;
  content.style.maxWidth = 'none';
  content.style.maxHeight = 'none';
}

/**
 * Keep the handles' `aria-value*` on the box: the separator role reads the
 * size off them on every key.
 */
function syncModalHandles(content, handles) {
  const box = contentBox(content);
  const { minWidth, minHeight } = contentMinimum(content);
  for (const handle of handles) {
    const edge = handle.getAttribute('data-edge');
    const vertical = edge === 'n' || edge === 's';
    handle.setAttribute('aria-valuenow', String(Math.round(vertical ? box.height : box.width)));
    handle.setAttribute('aria-valuemin', String(Math.round(vertical ? minHeight : minWidth)));
    handle.setAttribute('aria-valuetext', `${Math.round(box.width)} × ${Math.round(box.height)} pixels`);
  }
}

/**
 * Remember this view's size and splits for the next expanded view of the
 * same analysis. A full-screen phone layout is not a size the user chose.
 *
 * @param {HTMLElement} modal
 */
function rememberModalSizes(modal) {
  const key = modal._sizeKey ?? null;
  if (key === null || isFullScreenLayout()) return;
  const content = modal.querySelector('.analysis-modal-content');
  const options = modal.querySelector('.analysis-modal-options');
  const footer = modal.querySelector('.analysis-modal-footer-area');
  const stats = modal.querySelector('.analysis-modal-stats-panel');
  const size = {
    width: content?.offsetWidth ?? 0,
    height: content?.offsetHeight ?? 0,
    optionsWidth: options?.offsetWidth ?? 0,
    footerHeight: footer?.offsetHeight ?? 0,
    statsWidth: stats?.offsetWidth ?? 0
  };
  if (Object.values(size).some(value => !(value > 0))) return;
  analysisViewSizes.rememberExpandedViewSize(key, size);
}

/**
 * Maximize the expanded view to the viewport (less the margin), or give it
 * back its size.
 *
 * @param {HTMLElement} modal
 * @param {HTMLElement} content
 */
function toggleModalMaximize(modal, content) {
  if (isFullScreenLayout()) return;
  if (modal._restoreRect) {
    writeContentBox(content, modal._restoreRect);
    modal._restoreRect = null;
  } else {
    modal._restoreRect = contentBox(content);
    const { viewportWidth, viewportHeight } = modalViewport();
    writeContentBox(content, maximizedFloatingRect({
      sidebarRight: 0,
      minWidth: 0,
      viewportWidth,
      viewportHeight
    }));
  }
  content.classList.toggle('maximized', modal._restoreRect != null);
  rememberModalSizes(modal);
}

/**
 * Resize the expanded view from any edge or corner, by mouse, pen, finger or
 * keyboard. Each handle is a focusable separator; the bottom-right corner is
 * in the Tab order and moves both edges, the others answer arrows once
 * pressed.
 *
 * @param {HTMLElement} modal
 * @param {HTMLElement} content
 * @param {HTMLElement[]} handles
 * @returns {() => void} Teardown.
 */
function initializeModalResize(modal, content, handles) {
  let active = null;
  let previousBodyCursor = null;
  let previousBodyUserSelect = null;

  const finishResize = () => {
    if (active === null) return;
    const { handle, pointerId, rafId } = active;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      if (active.pending !== null) writeContentBox(content, active.pending);
    }
    const moved = active.pending !== null;
    active = null;
    restoreInlineStyle(document.body.style, 'cursor', previousBodyCursor);
    restoreUserSelectStyles(document.body.style, previousBodyUserSelect);
    previousBodyCursor = null;
    previousBodyUserSelect = null;
    content.classList.remove('resizing');
    if (
      typeof handle.releasePointerCapture === 'function' &&
      (typeof handle.hasPointerCapture !== 'function' || handle.hasPointerCapture(pointerId))
    ) {
      handle.releasePointerCapture(pointerId);
    }
    syncModalHandles(content, handles);
    if (moved) rememberModalSizes(modal);
  };

  const onPointerDown = (e) => {
    if (active !== null || e.button !== 0 || isFullScreenLayout()) return;
    const handle = e.currentTarget;
    e.preventDefault();
    e.stopPropagation();
    previousBodyCursor = captureInlineStyle(document.body.style, 'cursor');
    previousBodyUserSelect = captureUserSelectStyles(document.body.style);
    document.body.style.setProperty('cursor', MODAL_EDGE_CURSORS[handle.getAttribute('data-edge')]);
    setUserSelect(document.body.style, 'none');
    content.classList.add('resizing');
    modal._restoreRect = null;
    content.classList.remove('maximized');
    active = {
      handle,
      pointerId: e.pointerId,
      edge: handle.getAttribute('data-edge'),
      startX: e.clientX,
      startY: e.clientY,
      start: contentBox(content),
      limits: contentMinimum(content),
      pending: null,
      rafId: null
    };
    // Capture keeps the drag when the pointer leaves the handle.
    capturePointer(handle, e.pointerId);
  };

  const onPointerMove = (e) => {
    if (active === null || e.pointerId !== active.pointerId) return;
    const { rect } = resizeFloatingRect({
      start: active.start,
      edge: active.edge,
      dx: e.clientX - active.startX,
      dy: e.clientY - active.startY,
      ...active.limits,
      ...modalViewport()
    });
    active.pending = rect;
    if (active.rafId === null) {
      active.rafId = requestAnimationFrame(() => {
        if (active === null) return;
        active.rafId = null;
        writeContentBox(content, active.pending);
      });
    }
  };

  const onPointerUp = (e) => {
    if (active === null || e.pointerId !== active.pointerId) return;
    finishResize();
  };

  const onKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || isFullScreenLayout()) return;
    const handle = e.currentTarget;
    const travel = keyboardResizeTravel(
      handle.getAttribute('data-edge'),
      e.key,
      e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX,
      modalViewport()
    );
    if (travel === null) return;
    e.preventDefault();
    e.stopPropagation();
    const { rect } = resizeFloatingRect({
      start: contentBox(content),
      edge: handle.getAttribute('data-edge'),
      ...travel,
      ...contentMinimum(content),
      ...modalViewport()
    });
    modal._restoreRect = null;
    content.classList.remove('maximized');
    writeContentBox(content, rect);
    syncModalHandles(content, handles);
    rememberModalSizes(modal);
  };

  const onFocus = () => syncModalHandles(content, handles);

  for (const handle of handles) {
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
    handle.addEventListener('keydown', onKeyDown);
    handle.addEventListener('focus', onFocus);
  }
  window.addEventListener('blur', finishResize);

  return () => {
    finishResize();
    for (const handle of handles) {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      handle.removeEventListener('keydown', onKeyDown);
      handle.removeEventListener('focus', onFocus);
    }
    window.removeEventListener('blur', finishResize);
  };
}

// =============================================================================
// INTERNAL PANEL RESIZERS
// =============================================================================

/**
 * An element's layout offset inside one of its offset ancestors.
 *
 * Sums `offsetLeft`/`offsetTop` up the offset-parent chain, which CSS
 * transforms do not affect. Throws when `ancestor` is not on that chain, since
 * a partial sum would be a position relative to some other box.
 *
 * @param {HTMLElement} element
 * @param {HTMLElement} ancestor
 * @returns {{ left: number, top: number }}
 */
function layoutOffsetWithin(element, ancestor) {
  let left = 0;
  let top = 0;
  let node = element;
  while (node !== ancestor) {
    if (node === null || node === undefined) {
      throw new TypeError(
        'Analysis modal layout offset requires an offset ancestor on the chain.'
      );
    }
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return { left, top };
}

/**
 * Initialize internal panel resizable behavior using flexbox and direct pixel manipulation
 * This approach is more predictable than CSS Grid fr units for resizing
 * @param {HTMLElement} content - Modal content element
 * @param {HTMLElement} body - Modal body element
 * @param {HTMLElement} footerArea - Footer area element
 * @param {HTMLElement} verticalResizer - Vertical resizer between plot and options
 * @param {HTMLElement} horizontalResizer - Horizontal resizer between body and footer
 * @param {HTMLElement} footerResizer - Footer panel resizer
 * @param {HTMLElement} intersectionResizer - Corner intersection resizer
 * @param {HTMLElement} optionsPanel - Options panel element
 * @param {() => void} onCommit - Runs when a drag or a key has changed a split.
 */
function initializeResizers(content, body, footerArea, verticalResizer, horizontalResizer, footerResizer, intersectionResizer, optionsPanel, onCommit) {
  // State tracking
  let activeResizer = null; // 'vertical' | 'horizontal' | 'footer' | 'intersection'
  let startX = 0;
  let startY = 0;
  let startOptionsWidth = 0;
  let startFooterHeight = 0;
  let startStatsWidth = 0;
  /** Sizes measured once at pointerdown; see `startResize`. */
  let resizeBounds = null;
  let capturedPointerId = null;
  let capturedPointerTarget = null;
  let intersectionFrame = null;
  let previousBodyCursor = null;
  let previousBodyUserSelect = null;

  // Get elements
  const statsPanel = footerArea.querySelector('.analysis-modal-stats-panel');

  // Position the intersection resizer at the corner of vertical and horizontal
  // resizers. Layout offsets, not client rectangles: the content box is under
  // a `scale()` open transition, and a rectangle read while it runs is scaled
  // about the box centre, so the corner landed somewhere different on every
  // open depending on how far the transition had got.
  const updateIntersectionPosition = () => {
    // The narrow layout hides every internal resizer (`display: none`), and a
    // box that is not rendered has no offset parent and no corner to mark.
    if (
      verticalResizer.offsetParent === null ||
      horizontalResizer.offsetParent === null
    ) {
      return;
    }
    const intersectionSize = 16;
    const vertical = layoutOffsetWithin(verticalResizer, content);
    const horizontal = layoutOffsetWithin(horizontalResizer, content);
    const leftPos =
      vertical.left + (verticalResizer.offsetWidth / 2) - (intersectionSize / 2);
    const topPos =
      horizontal.top + (horizontalResizer.offsetHeight / 2) - (intersectionSize / 2);

    intersectionResizer.style.left = `${leftPos}px`;
    intersectionResizer.style.top = `${topPos}px`;
    intersectionResizer.style.right = 'auto';
  };

  const scheduleIntersectionPosition = () => {
    if (intersectionFrame !== null) return;
    intersectionFrame = requestAnimationFrame(() => {
      intersectionFrame = null;
      updateIntersectionPosition();
    });
  };

  // Everything a resize measures is fixed for its duration, so it is
  // measured once at its start; moves then only compute and write.
  const measureStart = () => {
    startOptionsWidth = optionsPanel.offsetWidth;
    startFooterHeight = footerArea.offsetHeight;
    startStatsWidth = statsPanel ? statsPanel.offsetWidth : 0;
    const headerEl = content.querySelector('.analysis-modal-header');
    resizeBounds = {
      bodyWidth: body.getBoundingClientRect().width,
      verticalResizerWidth: verticalResizer.offsetWidth,
      contentHeight: content.getBoundingClientRect().height,
      headerHeight: headerEl ? headerEl.offsetHeight : 0,
      horizontalResizerHeight: horizontalResizer.offsetHeight,
      footerWidth: footerArea.getBoundingClientRect().width,
      footerResizerWidth: footerResizer.offsetWidth
    };
  };

  // Each splitter reports the size of the panel it moves.
  const syncSplitterValues = () => {
    verticalResizer.setAttribute('aria-valuenow', String(Math.round(optionsPanel.offsetWidth)));
    verticalResizer.setAttribute('aria-valuetext', `Plot options ${Math.round(optionsPanel.offsetWidth)} pixels wide`);
    horizontalResizer.setAttribute('aria-valuenow', String(Math.round(footerArea.offsetHeight)));
    horizontalResizer.setAttribute('aria-valuetext', `Statistics ${Math.round(footerArea.offsetHeight)} pixels tall`);
    if (statsPanel) {
      footerResizer.setAttribute('aria-valuenow', String(Math.round(statsPanel.offsetWidth)));
      footerResizer.setAttribute('aria-valuetext', `Summary statistics ${Math.round(statsPanel.offsetWidth)} pixels wide`);
    }
  };

  // Start resize handler using pointer events
  const startResize = (e, type) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeResizer !== null) return;

    activeResizer = type;
    startX = e.clientX;
    startY = e.clientY;
    measureStart();

    // Add resizing class for visual feedback
    if (type === 'vertical' || type === 'intersection') {
      verticalResizer.classList.add('resizing');
    }
    if (type === 'horizontal' || type === 'intersection') {
      horizontalResizer.classList.add('resizing');
    }
    if (type === 'footer') {
      footerResizer.classList.add('resizing');
    }
    if (type === 'intersection') {
      intersectionResizer.classList.add('resizing');
    }

    // Set cursor based on resize type
    const cursors = {
      vertical: 'col-resize',
      horizontal: 'row-resize',
      footer: 'col-resize',
      intersection: 'nwse-resize'
    };
    previousBodyCursor = captureInlineStyle(
      document.body.style,
      'cursor'
    );
    previousBodyUserSelect = captureUserSelectStyles(document.body.style);
    document.body.style.setProperty('cursor', cursors[type]);
    setUserSelect(document.body.style, 'none');

    // Capture pointer for reliable tracking
    capturedPointerTarget = e.currentTarget ?? e.target;
    capturedPointerId = e.pointerId;
    try {
      capturedPointerTarget.setPointerCapture(capturedPointerId);
    } catch (error) {
      activeResizer = null;
      capturedPointerTarget = null;
      capturedPointerId = null;
      verticalResizer.classList.remove('resizing');
      horizontalResizer.classList.remove('resizing');
      footerResizer.classList.remove('resizing');
      intersectionResizer.classList.remove('resizing');
      restoreInlineStyle(
        document.body.style,
        'cursor',
        previousBodyCursor
      );
      restoreUserSelectStyles(
        document.body.style,
        previousBodyUserSelect
      );
      previousBodyCursor = null;
      previousBodyUserSelect = null;
      throw error;
    }
  };

  // Pointer moves arrive several times per frame. Each one only computes the
  // target sizes from the bounds measured at pointerdown; the sizes are
  // written once per frame, followed by the intersection handle's position.
  const applyResize = coalesceToFrame((deltaX, deltaY, type) => {
    const bounds = resizeBounds;
    if (bounds === null) return;

    // Vertical resizer (options panel width). Dragging left (negative deltaX)
    // widens the options panel.
    if (type === 'vertical' || type === 'intersection') {
      const maxOptionsWidth = bounds.bodyWidth - MIN_SIZES.plotWidth - bounds.verticalResizerWidth;
      const newOptionsWidth = Math.max(
        MIN_SIZES.optionsWidth,
        Math.min(startOptionsWidth - deltaX, maxOptionsWidth)
      );
      optionsPanel.style.width = `${newOptionsWidth}px`;
    }

    // Horizontal resizer (footer height). Dragging up raises the footer.
    if (type === 'horizontal' || type === 'intersection') {
      const maxFooterHeight = bounds.contentHeight - bounds.headerHeight
        - MIN_SIZES.bodyHeight - bounds.horizontalResizerHeight;
      const newFooterHeight = Math.max(
        MIN_SIZES.footerHeight,
        Math.min(startFooterHeight - deltaY, maxFooterHeight)
      );
      footerArea.style.height = `${newFooterHeight}px`;
    }

    // Footer resizer (stats/annotations split)
    if (type === 'footer' && statsPanel) {
      const maxStatsWidth = bounds.footerWidth - MIN_SIZES.annotationsWidth - bounds.footerResizerWidth;
      const newStatsWidth = Math.max(
        MIN_SIZES.statsWidth,
        Math.min(startStatsWidth + deltaX, maxStatsWidth)
      );
      statsPanel.style.flex = 'none';
      statsPanel.style.width = `${newStatsWidth}px`;
    }

    if (type === 'vertical' || type === 'horizontal' || type === 'intersection') {
      updateIntersectionPosition();
    }
  });

  // Pointer move handler
  const handlePointerMove = (e) => {
    if (!activeResizer) return;
    applyResize(e.clientX - startX, e.clientY - startY, activeResizer);
  };

  const finishResize = ({ updatePosition = true } = {}) => {
    if (
      activeResizer === null &&
      capturedPointerTarget === null
    ) {
      return;
    }

    // The last move of the drag is applied before the drag ends.
    applyResize.flush();
    resizeBounds = null;

    // Remove resizing classes
    verticalResizer.classList.remove('resizing');
    horizontalResizer.classList.remove('resizing');
    footerResizer.classList.remove('resizing');
    intersectionResizer.classList.remove('resizing');

    const pointerTarget = capturedPointerTarget;
    const pointerId = capturedPointerId;
    activeResizer = null;
    capturedPointerTarget = null;
    capturedPointerId = null;
    restoreInlineStyle(
      document.body.style,
      'cursor',
      previousBodyCursor
    );
    restoreUserSelectStyles(
      document.body.style,
      previousBodyUserSelect
    );
    previousBodyCursor = null;
    previousBodyUserSelect = null;

    if (
      pointerTarget !== null &&
      pointerId !== null &&
      typeof pointerTarget.releasePointerCapture === 'function' &&
      (
        typeof pointerTarget.hasPointerCapture !== 'function' ||
        pointerTarget.hasPointerCapture(pointerId)
      )
    ) {
      pointerTarget.releasePointerCapture(pointerId);
    }

    // Final position update for intersection
    if (updatePosition) {
      updateIntersectionPosition();
      syncSplitterValues();
      onCommit();
    }
  };
  const handlePointerUp = () => finishResize();
  const handlePointerCancel = () => finishResize();
  const handleWindowBlur = () => finishResize();

  // Attach pointer event handlers to resizers
  const onVerticalDown = (e) => startResize(e, 'vertical');
  const onHorizontalDown = (e) => startResize(e, 'horizontal');
  const onFooterDown = (e) => startResize(e, 'footer');
  const onIntersectionDown = (e) => startResize(e, 'intersection');

  // Arrows move a splitter as a drag would: left or up moves it left or up.
  const keyResize = (type) => (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || activeResizer !== null) return;
    const step = e.shiftKey ? 64 : 16;
    const horizontalKeys = type !== 'horizontal';
    const verticalKeys = type === 'horizontal' || type === 'intersection';
    let dx = 0;
    let dy = 0;
    if (horizontalKeys && e.key === 'ArrowLeft') dx = -step;
    else if (horizontalKeys && e.key === 'ArrowRight') dx = step;
    else if (verticalKeys && e.key === 'ArrowUp') dy = -step;
    else if (verticalKeys && e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    e.stopPropagation();
    measureStart();
    applyResize(dx, dy, type);
    applyResize.flush();
    resizeBounds = null;
    syncSplitterValues();
    onCommit();
  };
  const onVerticalKey = keyResize('vertical');
  const onHorizontalKey = keyResize('horizontal');
  const onFooterKey = keyResize('footer');
  const onIntersectionKey = keyResize('intersection');
  verticalResizer.addEventListener('keydown', onVerticalKey);
  horizontalResizer.addEventListener('keydown', onHorizontalKey);
  footerResizer.addEventListener('keydown', onFooterKey);
  intersectionResizer.addEventListener('keydown', onIntersectionKey);
  verticalResizer.addEventListener('focus', syncSplitterValues);
  horizontalResizer.addEventListener('focus', syncSplitterValues);
  footerResizer.addEventListener('focus', syncSplitterValues);

  verticalResizer.addEventListener('pointerdown', onVerticalDown);
  horizontalResizer.addEventListener('pointerdown', onHorizontalDown);
  footerResizer.addEventListener('pointerdown', onFooterDown);
  intersectionResizer.addEventListener('pointerdown', onIntersectionDown);

  // Global pointer move/up handlers
  document.addEventListener('pointermove', handlePointerMove);
  document.addEventListener('pointerup', handlePointerUp);
  document.addEventListener('pointercancel', handlePointerCancel);
  window.addEventListener('blur', handleWindowBlur);

  // Update intersection position on window resize
  const onWindowResize = scheduleIntersectionPosition;
  window.addEventListener('resize', onWindowResize);

  // Create a ResizeObserver to update intersection position when content changes.
  // It also fires when the modal is first added to the DOM and laid out, and
  // because the position is read from layout offsets, that first layout is
  // final: the open transition cannot move it afterwards.
  const resizeObserver = new ResizeObserver(() => {
    scheduleIntersectionPosition();
  });
  resizeObserver.observe(content);
  resizeObserver.observe(body);
  resizeObserver.observe(footerArea);

  return () => {
    const errors = [];
    const run = operation => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };

    run(() => finishResize({ updatePosition: false }));
    run(() => verticalResizer.removeEventListener('pointerdown', onVerticalDown));
    run(() => horizontalResizer.removeEventListener('pointerdown', onHorizontalDown));
    run(() => footerResizer.removeEventListener('pointerdown', onFooterDown));
    run(() => intersectionResizer.removeEventListener('pointerdown', onIntersectionDown));
    run(() => verticalResizer.removeEventListener('keydown', onVerticalKey));
    run(() => horizontalResizer.removeEventListener('keydown', onHorizontalKey));
    run(() => footerResizer.removeEventListener('keydown', onFooterKey));
    run(() => intersectionResizer.removeEventListener('keydown', onIntersectionKey));
    run(() => verticalResizer.removeEventListener('focus', syncSplitterValues));
    run(() => horizontalResizer.removeEventListener('focus', syncSplitterValues));
    run(() => footerResizer.removeEventListener('focus', syncSplitterValues));

    run(() => document.removeEventListener('pointermove', handlePointerMove));
    run(() => document.removeEventListener('pointerup', handlePointerUp));
    run(() => document.removeEventListener('pointercancel', handlePointerCancel));
    run(() => window.removeEventListener('blur', handleWindowBlur));
    run(() => window.removeEventListener('resize', onWindowResize));

    if (typeof resizeObserver.disconnect !== 'function') {
      errors.push(new TypeError('Analysis modal ResizeObserver must expose disconnect()'));
    } else {
      run(() => resizeObserver.disconnect());
    }

    if (intersectionFrame !== null) {
      run(() => cancelAnimationFrame(intersectionFrame));
      intersectionFrame = null;
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Analysis modal resize teardown failed in ${errors.length} operations`
      );
    }
  };
}

// =============================================================================
// MODAL DRAG
// =============================================================================

/**
 * Move the expanded view by its header, by mouse, pen or finger; a
 * double-click on the header maximizes it or gives it back its size. The
 * header always stays inside the viewport, so the view can be moved back.
 *
 * @param {HTMLElement} modal - Modal element
 * @param {HTMLElement} content - Modal content element
 * @param {HTMLElement} header - Modal header element
 * @returns {() => void} Teardown.
 */
function initializeModalDrag(modal, content, header) {
  let active = null;
  let previousBodyCursor = null;
  let previousBodyUserSelect = null;

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    // The close button is a button, not a grip.
    if (e.target.closest('.analysis-modal-close')) return;
    if (active !== null || isFullScreenLayout()) return;
    const box = contentBox(content);
    active = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      moved: false
    };
    previousBodyCursor = captureInlineStyle(document.body.style, 'cursor');
    previousBodyUserSelect = captureUserSelectStyles(document.body.style);
    document.body.style.setProperty('cursor', 'move');
    setUserSelect(document.body.style, 'none');
    capturePointer(header, e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (active === null || e.pointerId !== active.pointerId) return;
    const { x, y } = clampFloatingPosition({
      left: active.left + e.clientX - active.startX,
      top: active.top + e.clientY - active.startY,
      width: active.width,
      // Only the header has to stay in reach.
      height: header.offsetHeight,
      ...modalViewport()
    });
    active.moved = true;
    content.style.left = `${Math.round(x)}px`;
    content.style.top = `${Math.round(y)}px`;
  };

  const finishDrag = () => {
    if (active === null) return;
    const { pointerId, moved } = active;
    active = null;
    restoreInlineStyle(document.body.style, 'cursor', previousBodyCursor);
    restoreUserSelectStyles(document.body.style, previousBodyUserSelect);
    previousBodyCursor = null;
    previousBodyUserSelect = null;
    if (
      typeof header.hasPointerCapture !== 'function' || header.hasPointerCapture(pointerId)
    ) {
      header.releasePointerCapture(pointerId);
    }
    if (moved) {
      modal._restoreRect = null;
      content.classList.remove('maximized');
    }
  };

  const onPointerUp = (e) => {
    if (active === null || e.pointerId !== active.pointerId) return;
    finishDrag();
  };

  const onDoubleClick = (e) => {
    if (e.target.closest('.analysis-modal-close')) return;
    toggleModalMaximize(modal, content);
  };

  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', onPointerUp);
  header.addEventListener('pointercancel', onPointerUp);
  header.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('blur', finishDrag);

  return () => {
    finishDrag();
    header.removeEventListener('pointerdown', onPointerDown);
    header.removeEventListener('pointermove', onPointerMove);
    header.removeEventListener('pointerup', onPointerUp);
    header.removeEventListener('pointercancel', onPointerUp);
    header.removeEventListener('dblclick', onDoubleClick);
    window.removeEventListener('blur', finishDrag);
  };
}

/**
 * Give a new expanded view the size and splits the last one of its analysis
 * was given, within the viewport.
 *
 * @param {HTMLElement} modal
 * @param {HTMLElement} content
 * @param {{width: number, height: number, optionsWidth: number, footerHeight: number, statsWidth: number}} size
 */
function applyRememberedSizes(modal, content, size) {
  const { viewportWidth, viewportHeight } = modalViewport();
  content.style.width = `${Math.round(Math.min(size.width, viewportWidth - 16))}px`;
  content.style.height = `${Math.round(Math.min(size.height, viewportHeight - 16))}px`;
  content.style.maxWidth = 'none';
  content.style.maxHeight = 'none';
  const options = modal.querySelector('.analysis-modal-options');
  const footer = modal.querySelector('.analysis-modal-footer-area');
  const stats = modal.querySelector('.analysis-modal-stats-panel');
  if (options) options.style.width = `${Math.round(size.optionsWidth)}px`;
  if (footer) footer.style.height = `${Math.round(size.footerHeight)}px`;
  if (stats) {
    stats.style.flex = 'none';
    stats.style.width = `${Math.round(size.statsWidth)}px`;
  }
}

// =============================================================================
// MODAL LIFECYCLE
// =============================================================================

/**
 * Open the analysis modal
 * @param {HTMLElement} modal - Modal element to open
 */
export function openModal(modal) {
  if (!modal || typeof modal !== 'object') {
    throw new TypeError('openModal requires a modal element');
  }
  if (modal._cleanupDone === true || modal._closePromise != null) {
    throw new Error('Cannot reopen an analysis modal after close has begun');
  }
  if (modal.isConnected === true || modal.classList?.contains?.('open')) {
    throw new Error('Analysis modal is already open');
  }
  const previousFocus = document.activeElement;
  modal._previouslyFocusedElement =
    previousFocus &&
    previousFocus !== document.body &&
    typeof previousFocus.focus === 'function'
      ? previousFocus
      : null;

  // The analysis this view belongs to, read off the control that opened it:
  // a docked analysis's region or a window's panel carries its id. Its last
  // size and splits are this view's starting size.
  const scope = modal._previouslyFocusedElement?.closest?.(
    '[data-analysis-mode], .analysis-mode-content[data-mode]'
  ) ?? null;
  modal._sizeKey = scope?.getAttribute('data-analysis-mode')
    ?? scope?.getAttribute('data-mode')
    ?? null;

  document.body.appendChild(modal);
  const content = modal.querySelector('.analysis-modal-content');
  const remembered = modal._sizeKey === null
    ? null
    : analysisViewSizes.expandedViewSize(modal._sizeKey);
  if (content && remembered !== null && !isFullScreenLayout()) {
    applyRememberedSizes(modal, content, remembered);
  }
  // Force reflow for animation
  modal.offsetHeight;

  // Anchor the content at its centred layout position so a resize grows from
  // the top-left corner. The position is the layout offset, which a transform
  // never changes, so it is read now rather than after the `scale()` open
  // transition: a client rectangle read while that transition runs is scaled
  // about the box centre, and a timer cannot know when it has finished.
  if (content) {
    const { minWidth, minHeight } = contentMinimum(content);
    content.style.setProperty('--modal-min-width', `${minWidth}px`);
    content.style.setProperty('--modal-min-height', `${minHeight}px`);
    const { left, top } = layoutOffsetWithin(content, modal);
    content.style.position = 'absolute';
    content.style.left = `${left}px`;
    content.style.top = `${top}px`;
    content.style.margin = '0';
  }
  modal.classList.add('open');

  const focusableEls = getFocusableElements(modal);
  (focusableEls[0] ?? modal).focus();

  // Own Escape and keyboard focus while this is the topmost analysis dialog.
  const handleEscape = (e) => {
    if (!isTopmostOpenAnalysisModal(modal)) return;
    const activeElement = document.activeElement;
    const activeDialog = activeElement?.closest?.('[role="dialog"]') ?? null;
    if (activeDialog !== null && activeDialog !== modal) return;

    if (e.key === 'Escape') {
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      e.stopPropagation?.();
      requestModalClose(modal);
      return;
    }
    if (e.key !== 'Tab') return;

    const currentFocusable = getFocusableElements(modal);
    if (currentFocusable.length === 0) {
      e.preventDefault?.();
      modal.focus();
      return;
    }
    const first = currentFocusable[0];
    const last = currentFocusable[currentFocusable.length - 1];
    if (!modal.contains(activeElement)) {
      e.preventDefault?.();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && activeElement === first) {
      e.preventDefault?.();
      last.focus();
    } else if (!e.shiftKey && activeElement === last) {
      e.preventDefault?.();
      first.focus();
    }
  };
  modal._escapeHandler = handleEscape;
  document.addEventListener('keydown', handleEscape, true);
}

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

function requireCloseError(error) {
  if (error instanceof Error) return error;
  return new TypeError('Analysis modal close rejected with a non-Error value');
}

function reportEventCloseFailure(modal, error) {
  const exactError = requireCloseError(error);
  if (typeof modal._onCloseError !== 'function') {
    console.error('[AnalysisModal] Close failed:', exactError);
    return;
  }
  try {
    modal._onCloseError(exactError);
  } catch (reportError) {
    console.error(
      '[AnalysisModal] Close and failure reporting both failed:',
      new AggregateError(
        [exactError, requireCloseError(reportError)],
        'Analysis modal close and failure reporting both failed'
      )
    );
  }
}

function requestModalClose(modal) {
  try {
    const result = closeModal(modal);
    if (result && typeof result.then === 'function') {
      void result.catch(error => {
        reportEventCloseFailure(modal, error);
      });
    }
  } catch (error) {
    reportEventCloseFailure(modal, error);
  }
}

function beginModalCleanup(modal) {
  if (modal._cleanupDone === true) {
    return { errors: [], tasks: [] };
  }
  const errors = [];
  const tasks = [];
  const run = operation => {
    try {
      return operation();
    } catch (error) {
      errors.push(error);
      return undefined;
    }
  };
  modal._cleanupDone = true;

  // Stop Escape handler (important: openModal doesn't always remove it).
  if (modal._escapeHandler) {
    run(() => {
      document.removeEventListener('keydown', modal._escapeHandler, true);
    });
    modal._escapeHandler = null;
  }

  // Slot-owning callers retire their exact child before this parent purge
  // runs. Directly owned modal plots retain synchronous cleanup here.
  if (modal._plotContainer) {
    run(() => purgePlot(modal._plotContainer));
  }

  // Remove any global listeners/observers registered during initialization.
  if (Array.isArray(modal._cleanupFns)) {
    for (const cleanup of modal._cleanupFns) {
      if (typeof cleanup !== 'function') {
        errors.push(
          new TypeError('Modal cleanup entries must be functions')
        );
      } else {
        run(cleanup);
      }
    }
    modal._cleanupFns.length = 0;
  }

  run(() => modal.classList.remove('open'));
  let detachTask = Promise.resolve();
  if (modal.parentNode) {
    detachTask = new Promise((resolve, reject) => {
      modal._detachTimeout = setTimeout(() => {
        modal._detachTimeout = null;
        try {
          if (modal.parentNode) {
            modal.parentNode.removeChild(modal);
          }
          resolve();
        } catch (error) {
          reject(requireCloseError(error));
        }
      }, 200);
    });
    tasks.push(detachTask);
  }
  tasks.push(detachTask.then(
    () => restoreModalFocus(modal),
    () => restoreModalFocus(modal)
  ));

  if (typeof modal._onClose === 'function') {
    const onCloseResult = run(() => modal._onClose());
    if (onCloseResult && typeof onCloseResult.then === 'function') {
      tasks.push(Promise.resolve(onCloseResult));
    }
  }

  return { errors, tasks };
}

async function settleModalCleanup(
  { errors, tasks },
  closePromise
) {
  const outcomes = await Promise.allSettled(
    tasks.filter(task => task !== closePromise)
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      errors.push(requireCloseError(outcome.reason));
    }
  }
  const failure = combineErrors(errors, 'Analysis modal teardown failed');
  if (failure) throw failure;
}

function createClosePromiseOwner(modal) {
  let rejectClose;
  let resolveClose;
  const closePromise = new Promise((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });
  modal._closePromise = closePromise;
  // Some event-driven close callers cannot observe a returned Promise. Keep
  // the rejection handled here while preserving it for every explicit await.
  void closePromise.catch(() => {});
  return { closePromise, rejectClose, resolveClose };
}

/**
 * Close the analysis modal
 * @param {HTMLElement} modal - Modal element to close
 * @returns {Promise<void>} Stable Promise for the complete close lifecycle
 */
export function closeModal(modal) {
  if (!modal || typeof modal !== 'object') {
    throw new TypeError('closeModal requires a modal element');
  }
  if (modal._closePromise !== null && modal._closePromise !== undefined) {
    return modal._closePromise;
  }
  if (modal._cleanupDone === true) return Promise.resolve();

  const {
    closePromise,
    rejectClose,
    resolveClose
  } = createClosePromiseOwner(modal);

  if (typeof modal._beforeClose !== 'function') {
    const cleanup = beginModalCleanup(modal);
    const synchronousFailure = combineErrors(
      cleanup.errors,
      'Analysis modal teardown failed'
    );
    if (synchronousFailure) {
      rejectClose(synchronousFailure);
      void Promise.allSettled(cleanup.tasks);
      throw synchronousFailure;
    }
    void settleModalCleanup(cleanup, closePromise).then(
      resolveClose,
      rejectClose
    );
    return closePromise;
  }

  // Defer invocation until after `_closePromise` is published. A reentrant
  // close from `beforeClose` therefore observes this exact Promise and cannot
  // start a second teardown.
  void Promise.resolve().then(async () => {
    const errors = [];
    try {
      const beforeCloseResult = modal._beforeClose();
      if (beforeCloseResult !== closePromise) {
        await beforeCloseResult;
      }
    } catch (error) {
      errors.push(requireCloseError(error));
    }
    const cleanup = beginModalCleanup(modal);
    errors.push(...cleanup.errors.map(requireCloseError));
    const outcomes = await Promise.allSettled(
      cleanup.tasks.filter(task => task !== closePromise)
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        errors.push(requireCloseError(outcome.reason));
      }
    }
    const failure = combineErrors(
      errors,
      'Analysis modal pre-close and teardown failed'
    );
    if (failure) throw failure;
  }).then(resolveClose, rejectClose);
  return closePromise;
}
