/**
 * Modal System for Analysis
 *
 * Provides the analysis popup/modal component with:
 * - Resizable grid layout with plot, options panel, and statistical panel
 * - Edge resize handles
 * - Internal panel resizers
 * - Modal dragging from header
 * - Lifecycle management (open/close)
 */

import { purgePlot } from '../../plots/plotly-loader.js';

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
  modalWidth: 600,        // Modal min width
  modalHeight: 500        // Modal min height
};

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
 * @param {Function} options.onClose - Callback when modal is closed
 * @param {Function} options.onExportPNG - Export PNG callback
 * @param {Function} options.onExportSVG - Export SVG callback
 * @param {Function} options.onExportCSV - Export CSV callback
 * @returns {HTMLElement}
 */
export function createAnalysisModal(options = {}) {
  const { onClose, onExportPNG, onExportSVG, onExportCSV } = options;

  // Create modal backdrop
  const modal = document.createElement('div');
  modal.className = 'analysis-modal';
  modal._cleanupFns = [];
  modal._cleanupDone = false;

  const backdrop = document.createElement('div');
  backdrop.className = 'analysis-modal-backdrop';
  backdrop.addEventListener('click', () => {
    if (onClose) onClose();
    closeModal(modal);
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
  title.textContent = 'Page Analysis';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'analysis-modal-close';
  closeBtn.innerHTML = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => {
    if (onClose) onClose();
    closeModal(modal);
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
  plotContainer.id = 'analysis-modal-plot-container';
  plotSection.appendChild(plotContainer);

  // Export toolbar below plot
  const exportToolbar = document.createElement('div');
  exportToolbar.className = 'analysis-modal-export';

  const createExportBtn = (label, title, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  };

  if (onExportPNG) exportToolbar.appendChild(createExportBtn('PNG', 'Download as PNG', onExportPNG));
  if (onExportSVG) exportToolbar.appendChild(createExportBtn('SVG', 'Download as SVG', onExportSVG));
  if (onExportCSV) exportToolbar.appendChild(createExportBtn('CSV', 'Download data', onExportCSV));

  plotSection.appendChild(exportToolbar);
  body.appendChild(plotSection);

  // Vertical resizer between plot and options
  const verticalResizer = document.createElement('div');
  verticalResizer.className = 'analysis-modal-resizer analysis-modal-resizer-vertical';
  verticalResizer.title = 'Drag to resize';
  body.appendChild(verticalResizer);

  // Right side: Options panel
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'analysis-modal-options';
  optionsPanel.id = 'analysis-modal-options';

  const optionsTitle = document.createElement('div');
  optionsTitle.className = 'analysis-options-title';
  optionsTitle.textContent = 'Plot Options';
  optionsPanel.appendChild(optionsTitle);

  const optionsContent = document.createElement('div');
  optionsContent.className = 'analysis-options-content';
  optionsContent.id = 'analysis-options-content';
  optionsPanel.appendChild(optionsContent);

  body.appendChild(optionsPanel);
  content.appendChild(body);

  // Horizontal resizer between body and footer
  const horizontalResizer = document.createElement('div');
  horizontalResizer.className = 'analysis-modal-resizer analysis-modal-resizer-horizontal';
  horizontalResizer.title = 'Drag to resize vertically';
  content.appendChild(horizontalResizer);

  // Intersection resizer (corner handle for both vertical and horizontal resize)
  const intersectionResizer = document.createElement('div');
  intersectionResizer.className = 'analysis-modal-resizer-intersection';
  intersectionResizer.title = 'Drag to resize both directions';
  content.appendChild(intersectionResizer);

  // Footer area with two panels: Summary Stats (left) + Statistical Annotations (right)
  const footerArea = document.createElement('div');
  footerArea.className = 'analysis-modal-footer-area';

  // Summary stats panel (left)
  const statsPanel = document.createElement('div');
  statsPanel.className = 'analysis-modal-stats-panel';
  statsPanel.id = 'analysis-modal-stats';

  const statsTitle = document.createElement('div');
  statsTitle.className = 'analysis-panel-title';
  statsTitle.textContent = 'Summary Statistics';
  statsPanel.appendChild(statsTitle);

  const statsContent = document.createElement('div');
  statsContent.className = 'analysis-stats-content';
  statsContent.id = 'analysis-stats-content';
  statsPanel.appendChild(statsContent);

  footerArea.appendChild(statsPanel);

  // Footer panel resizer
  const footerResizer = document.createElement('div');
  footerResizer.className = 'analysis-modal-resizer analysis-modal-resizer-vertical';
  footerResizer.title = 'Drag to resize';
  footerArea.appendChild(footerResizer);

  // Statistical annotations panel (right)
  const annotationsPanel = document.createElement('div');
  annotationsPanel.className = 'analysis-modal-annotations-panel';
  annotationsPanel.id = 'analysis-modal-annotations';

  const annotationsTitle = document.createElement('div');
  annotationsTitle.className = 'analysis-panel-title';
  annotationsTitle.textContent = 'Statistical Analysis';
  annotationsPanel.appendChild(annotationsTitle);

  const annotationsContent = document.createElement('div');
  annotationsContent.className = 'analysis-annotations-content';
  annotationsContent.id = 'analysis-annotations-content';
  annotationsPanel.appendChild(annotationsContent);

  footerArea.appendChild(annotationsPanel);
  content.appendChild(footerArea);

  // Add edge resize handles for modal resizing (right and bottom only)
  const edgeRight = document.createElement('div');
  edgeRight.className = 'analysis-modal-edge-resize analysis-modal-edge-resize-right';
  content.appendChild(edgeRight);

  const edgeBottom = document.createElement('div');
  edgeBottom.className = 'analysis-modal-edge-resize analysis-modal-edge-resize-bottom';
  content.appendChild(edgeBottom);

  modal.appendChild(content);

  // Initialize modal edge resize
  modal._cleanupFns.push(initializeModalResize(content, edgeRight, edgeBottom));

  // Initialize internal panel resizers
  modal._cleanupFns.push(
    initializeResizers(content, body, footerArea, verticalResizer, horizontalResizer, footerResizer, intersectionResizer, optionsPanel)
  );

  // Initialize modal dragging
  modal._cleanupFns.push(initializeModalDrag(modal, content, header));

  // Store references
  modal._plotContainer = plotContainer;
  modal._optionsContent = optionsContent;
  modal._footer = statsContent; // For backwards compatibility
  modal._statsContent = statsContent;
  modal._annotationsContent = annotationsContent;
  modal._title = title;

  return modal;
}

// =============================================================================
// MODAL RESIZE
// =============================================================================

/**
 * Initialize modal edge resize behavior (right and bottom edges only)
 * @param {HTMLElement} content - Modal content element
 * @param {HTMLElement} edgeRight - Right edge handle
 * @param {HTMLElement} edgeBottom - Bottom edge handle
 */
function initializeModalResize(content, edgeRight, edgeBottom) {
  let isResizing = false;
  let resizeType = null; // 'right' or 'bottom'
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  const startResize = (e, type) => {
    isResizing = true;
    resizeType = type;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = content.offsetWidth;
    startHeight = content.offsetHeight;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = type === 'right' ? 'ew-resize' : 'ns-resize';

    e.preventDefault();
    e.stopPropagation();
  };

  const onMouseDownRight = (e) => startResize(e, 'right');
  const onMouseDownBottom = (e) => startResize(e, 'bottom');

  edgeRight.addEventListener('mousedown', onMouseDownRight);
  edgeBottom.addEventListener('mousedown', onMouseDownBottom);

  const handleMouseMove = (e) => {
    if (!isResizing) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    if (resizeType === 'right') {
      const newWidth = Math.max(MIN_SIZES.modalWidth, startWidth + deltaX);
      content.style.width = `${newWidth}px`;
      content.style.maxWidth = 'none';
    }

    if (resizeType === 'bottom') {
      const newHeight = Math.max(MIN_SIZES.modalHeight, startHeight + deltaY);
      content.style.height = `${newHeight}px`;
      content.style.maxHeight = 'none';
    }
  };

  const handleMouseUp = () => {
    if (isResizing) {
      isResizing = false;
      resizeType = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  return () => {
    edgeRight.removeEventListener('mousedown', onMouseDownRight);
    edgeBottom.removeEventListener('mousedown', onMouseDownBottom);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
}

// =============================================================================
// INTERNAL PANEL RESIZERS
// =============================================================================

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
 */
function initializeResizers(content, body, footerArea, verticalResizer, horizontalResizer, footerResizer, intersectionResizer, optionsPanel) {
  // State tracking
  let activeResizer = null; // 'vertical' | 'horizontal' | 'footer' | 'intersection'
  let startX = 0;
  let startY = 0;
  let startOptionsWidth = 0;
  let startFooterHeight = 0;
  let startStatsWidth = 0;

  // Get elements
  const statsPanel = footerArea.querySelector('.analysis-modal-stats-panel');

  // Position the intersection resizer at the corner of vertical and horizontal resizers
  const updateIntersectionPosition = () => {
    const contentRect = content.getBoundingClientRect();
    const verticalResizerRect = verticalResizer.getBoundingClientRect();
    const horizontalResizerRect = horizontalResizer.getBoundingClientRect();
    const intersectionSize = 16;

    // Get the center point of each resizer
    const verticalResizerCenterX = verticalResizerRect.left + (verticalResizerRect.width / 2);
    const horizontalResizerCenterY = horizontalResizerRect.top + (horizontalResizerRect.height / 2);

    // Position intersection centered on both resizers (relative to content)
    const leftPos = verticalResizerCenterX - contentRect.left - (intersectionSize / 2);
    const topPos = horizontalResizerCenterY - contentRect.top - (intersectionSize / 2);

    intersectionResizer.style.left = `${leftPos}px`;
    intersectionResizer.style.top = `${topPos}px`;
    intersectionResizer.style.right = 'auto';
  };

  // Start resize handler using pointer events
  const startResize = (e, type) => {
    e.preventDefault();
    e.stopPropagation();

    activeResizer = type;
    startX = e.clientX;
    startY = e.clientY;
    startOptionsWidth = optionsPanel.offsetWidth;
    startFooterHeight = footerArea.offsetHeight;
    startStatsWidth = statsPanel ? statsPanel.offsetWidth : 0;

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
    document.body.style.cursor = cursors[type];
    document.body.style.userSelect = 'none';

    // Capture pointer for reliable tracking
    e.target.setPointerCapture(e.pointerId);
  };

  // Pointer move handler
  const handlePointerMove = (e) => {
    if (!activeResizer) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    // Handle vertical resizer (options panel width)
    if (activeResizer === 'vertical' || activeResizer === 'intersection') {
      const bodyRect = body.getBoundingClientRect();
      const resizerWidth = verticalResizer.offsetWidth;
      const maxOptionsWidth = bodyRect.width - MIN_SIZES.plotWidth - resizerWidth;

      // Negative deltaX = dragging left = increasing options width
      let newOptionsWidth = startOptionsWidth - deltaX;
      newOptionsWidth = Math.max(MIN_SIZES.optionsWidth, Math.min(newOptionsWidth, maxOptionsWidth));

      optionsPanel.style.width = `${newOptionsWidth}px`;
    }

    // Handle horizontal resizer (footer height)
    if (activeResizer === 'horizontal' || activeResizer === 'intersection') {
      const contentRect = content.getBoundingClientRect();
      const headerEl = content.querySelector('.analysis-modal-header');
      const headerHeight = headerEl ? headerEl.offsetHeight : 0;
      const hResizerHeight = horizontalResizer.offsetHeight;
      const maxFooterHeight = contentRect.height - headerHeight - MIN_SIZES.bodyHeight - hResizerHeight;

      // Negative deltaY = dragging up = increasing footer height
      let newFooterHeight = startFooterHeight - deltaY;
      newFooterHeight = Math.max(MIN_SIZES.footerHeight, Math.min(newFooterHeight, maxFooterHeight));

      footerArea.style.height = `${newFooterHeight}px`;
    }

    // Handle footer resizer (stats/annotations split)
    if (activeResizer === 'footer') {
      const footerRect = footerArea.getBoundingClientRect();
      const fResizerWidth = footerResizer.offsetWidth;
      const maxStatsWidth = footerRect.width - MIN_SIZES.annotationsWidth - fResizerWidth;

      let newStatsWidth = startStatsWidth + deltaX;
      newStatsWidth = Math.max(MIN_SIZES.statsWidth, Math.min(newStatsWidth, maxStatsWidth));

      if (statsPanel) {
        statsPanel.style.flex = 'none';
        statsPanel.style.width = `${newStatsWidth}px`;
      }
    }

    // Update intersection position during resize
    if (activeResizer === 'vertical' || activeResizer === 'horizontal' || activeResizer === 'intersection') {
      requestAnimationFrame(updateIntersectionPosition);
    }
  };

  // Pointer up handler
  const handlePointerUp = (e) => {
    if (!activeResizer) return;

    // Remove resizing classes
    verticalResizer.classList.remove('resizing');
    horizontalResizer.classList.remove('resizing');
    footerResizer.classList.remove('resizing');
    intersectionResizer.classList.remove('resizing');

    activeResizer = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Release pointer capture
    if (e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) {
      e.target.releasePointerCapture(e.pointerId);
    }

    // Final position update for intersection
    updateIntersectionPosition();
  };

  // Attach pointer event handlers to resizers
  const onVerticalDown = (e) => startResize(e, 'vertical');
  const onHorizontalDown = (e) => startResize(e, 'horizontal');
  const onFooterDown = (e) => startResize(e, 'footer');
  const onIntersectionDown = (e) => startResize(e, 'intersection');

  verticalResizer.addEventListener('pointerdown', onVerticalDown);
  horizontalResizer.addEventListener('pointerdown', onHorizontalDown);
  footerResizer.addEventListener('pointerdown', onFooterDown);
  intersectionResizer.addEventListener('pointerdown', onIntersectionDown);

  // Global pointer move/up handlers
  document.addEventListener('pointermove', handlePointerMove);
  document.addEventListener('pointerup', handlePointerUp);

  // Update intersection position on window resize
  const onWindowResize = () => requestAnimationFrame(updateIntersectionPosition);
  window.addEventListener('resize', onWindowResize);

  // Create a ResizeObserver to update intersection position when content changes
  // This will also fire when the modal is first added to DOM and laid out
  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(updateIntersectionPosition);
  });
  resizeObserver.observe(content);
  resizeObserver.observe(body);
  resizeObserver.observe(footerArea);

  // Also update after modal open animation completes (200ms + buffer)
  const intersectionTimeout = setTimeout(() => {
    updateIntersectionPosition();
  }, 250);

  return () => {
    verticalResizer.removeEventListener('pointerdown', onVerticalDown);
    horizontalResizer.removeEventListener('pointerdown', onHorizontalDown);
    footerResizer.removeEventListener('pointerdown', onFooterDown);
    intersectionResizer.removeEventListener('pointerdown', onIntersectionDown);

    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('resize', onWindowResize);

    try {
      resizeObserver.disconnect();
    } catch (_err) {
      // Ignore
    }

    clearTimeout(intersectionTimeout);
  };
}

// =============================================================================
// MODAL DRAG
// =============================================================================

/**
 * Initialize modal dragging from header
 * @param {HTMLElement} modal - Modal element
 * @param {HTMLElement} content - Modal content element
 * @param {HTMLElement} header - Modal header element
 */
function initializeModalDrag(modal, content, header) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  const onMouseDownHeader = (e) => {
    // Don't drag if clicking close button
    if (e.target.closest('.analysis-modal-close')) return;

    isDragging = true;

    // Get current position from styles (already absolute positioned after open)
    initialLeft = parseFloat(content.style.left) || 0;
    initialTop = parseFloat(content.style.top) || 0;

    startX = e.clientX;
    startY = e.clientY;

    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  header.addEventListener('mousedown', onMouseDownHeader);

  const handleMouseMove = (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    const newLeft = initialLeft + deltaX;
    const newTop = initialTop + deltaY;

    // Keep modal within viewport bounds
    const modalRect = modal.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    const maxLeft = modalRect.width - contentRect.width - 20;
    const maxTop = modalRect.height - contentRect.height - 20;

    content.style.left = `${Math.max(20, Math.min(newLeft, maxLeft))}px`;
    content.style.top = `${Math.max(20, Math.min(newTop, maxTop))}px`;
  };

  const handleMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  return () => {
    header.removeEventListener('mousedown', onMouseDownHeader);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
}

// =============================================================================
// MODAL LIFECYCLE
// =============================================================================

/**
 * Open the analysis modal
 * @param {HTMLElement} modal - Modal element to open
 */
export function openModal(modal) {
  document.body.appendChild(modal);
  // Force reflow for animation
  modal.offsetHeight;
  modal.classList.add('open');

  // After animation, switch to absolute positioning so resize anchors top-left
  const content = modal.querySelector('.analysis-modal-content');
  if (content) {
    // Wait for open animation to complete
    modal._openPositionTimeout = setTimeout(() => {
      const rect = content.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();

      // Switch to absolute positioning anchored at top-left
      content.style.position = 'absolute';
      content.style.left = `${rect.left - modalRect.left}px`;
      content.style.top = `${rect.top - modalRect.top}px`;
      content.style.margin = '0';
    }, 200);
  }

  // Trap focus
  const focusableEls = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusableEls.length > 0) {
    focusableEls[0].focus();
  }

  // Close on Escape
  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      closeModal(modal);
    }
  };
  modal._escapeHandler = handleEscape;
  document.addEventListener('keydown', handleEscape);
}

/**
 * Close the analysis modal
 * @param {HTMLElement} modal - Modal element to close
 */
export function closeModal(modal) {
  if (!modal || modal._cleanupDone) return;
  modal._cleanupDone = true;

  // Stop Escape handler (important: openModal doesn't always remove it).
  if (modal._escapeHandler) {
    document.removeEventListener('keydown', modal._escapeHandler);
    modal._escapeHandler = null;
  }

  // Cancel deferred positioning if the modal is closed quickly.
  if (modal._openPositionTimeout) {
    clearTimeout(modal._openPositionTimeout);
    modal._openPositionTimeout = null;
  }

  // Purge Plotly/WebGL resources before detaching from DOM.
  if (modal._plotContainer) {
    purgePlot(modal._plotContainer);
  }

  // Remove any global listeners/observers registered during initialization.
  if (Array.isArray(modal._cleanupFns)) {
    for (const cleanup of modal._cleanupFns) {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch (_err) {
        // Ignore teardown errors
      }
    }
    modal._cleanupFns.length = 0;
  }

  modal.classList.remove('open');
  setTimeout(() => {
    if (modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  }, 200);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  createAnalysisModal,
  openModal,
  closeModal
};
