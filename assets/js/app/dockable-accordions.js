// Dockable accordions: drag a section header to tear it off into a floating window.
// Fully GPU-accelerated with compositor layer optimization for smooth 60fps dragging.
// Uses translate3d transforms for paint-only updates during drag operations.

const DRAG_THRESHOLD_PX = 6;
const DOCK_HIT_PADDING_PX = 12;
const FLOAT_MIN_WIDTH_PX = 220;
const FLOAT_MIN_HEIGHT_PX = 140;
const FLOAT_MAX_HEIGHT_PX = 800; // Maximum height for floating panels (scrollbar appears above this)
const FLOAT_MAX_SCALE = 2;

// Pre-computed styles for GPU acceleration - avoids style recalculation
const GPU_LAYER_STYLES = {
  willChange: 'transform',
  backfaceVisibility: 'hidden',
  WebkitBackfaceVisibility: 'hidden',
  transformStyle: 'preserve-3d',
  perspective: '1000px',
};

function ensureFloatingRoot() {
  let root = document.getElementById('floating-panels-root');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'floating-panels-root';
  // GPU layer for floating root
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '90',
    transform: 'translateZ(0)',
    contain: 'layout style',
  });
  document.body.appendChild(root);
  return root;
}

function isInteractiveTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('button, a, input, select, textarea, [role="button"]');
}

function expandedRect(rect, paddingPx) {
  return {
    left: rect.left - paddingPx,
    top: rect.top - paddingPx,
    right: rect.right + paddingPx,
    bottom: rect.bottom + paddingPx,
  };
}

function pointInRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Optimized RAF scheduler - ensures only one frame per update
let pendingRAF = null;
let rafCallbacks = [];

function scheduleRAF(callback) {
  rafCallbacks.push(callback);
  if (pendingRAF === null) {
    pendingRAF = requestAnimationFrame(() => {
      const callbacks = rafCallbacks;
      rafCallbacks = [];
      pendingRAF = null;
      for (let i = 0; i < callbacks.length; i++) {
        callbacks[i]();
      }
    });
  }
}

export function initDockableAccordions({ sidebar } = {}) {
  if (!sidebar) {
    console.warn('[DockableAccordions] Missing sidebar element; skipping.');
    return { dock: () => {}, undock: () => {} };
  }

  const floatingRoot = ensureFloatingRoot();
  const stateByDetails = new Map();
  let zIndexCounter = 90;

  // Cached sidebar rect for drag operations
  let cachedSidebarRect = null;

  function getState(details) {
    let state = stateByDetails.get(details);
    if (state) return state;
    state = {
      dockPlaceholder: null,
      dockParent: null,
      isFloating: false,
      suppressNextClick: false,
      baseFloatSize: null,
      baseLeft: 0,
      baseTop: 0,
    };
    stateByDetails.set(details, state);
    return state;
  }

  function triggerTransientClass(el, className, durationMs) {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    window.setTimeout(() => el.classList.remove(className), durationMs);
  }

  function bumpZIndex(details) {
    zIndexCounter += 1;
    details.style.zIndex = String(zIndexCounter);
  }

  function setFloating(details, floating) {
    const state = getState(details);
    state.isFloating = floating;
    details.classList.toggle('accordion-floating', floating);
  }

  // GPU optimization: prepare element for dragging - creates compositor layer
  function prepareDragLayer(details) {
    // Apply GPU layer styles directly for immediate effect
    Object.assign(details.style, GPU_LAYER_STYLES);
    details.classList.add('drag-prepared');

    // Freeze content to avoid expensive repaints during drag
    const content = details.querySelector('.accordion-content');
    if (content) {
      content.style.contentVisibility = 'hidden';
      content.style.containIntrinsicSize = 'auto 300px';
    }
  }

  // GPU optimization: pre-warm layer on pointerdown (before drag starts)
  function prewarmDragLayer(details) {
    // Light preparation - just hint to compositor without full freeze
    details.style.willChange = 'transform';
    details.style.backfaceVisibility = 'hidden';
  }

  // GPU optimization: cleanup after drag
  function cleanupDragLayer(details) {
    details.classList.remove('drag-prepared');
    // Remove inline GPU styles
    details.style.willChange = '';
    details.style.backfaceVisibility = '';
    details.style.WebkitBackfaceVisibility = '';
    details.style.transformStyle = '';
    details.style.perspective = '';

    // Unfreeze content
    const content = details.querySelector('.accordion-content');
    if (content) {
      content.style.contentVisibility = '';
      content.style.containIntrinsicSize = '';
    }
  }

  function ensureDockButton(summary) {
    if (summary.querySelector('.accordion-dock-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'accordion-dock-btn';
    btn.setAttribute('aria-label', 'Dock panel back into sidebar');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const details = summary.closest('details.accordion-section');
      if (details) dock(details);
    });
    summary.appendChild(btn);
  }

  // Fast undock for drag - uses pre-measured rect to avoid layout thrashing
  function undockFast(details, preRect) {
    const state = getState(details);
    if (state.isFloating) return null;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportMaxWidth = Math.max(FLOAT_MIN_WIDTH_PX, viewportWidth - 16);
    const viewportMaxHeight = Math.max(FLOAT_MIN_HEIGHT_PX, viewportHeight - 16);

    const initialWidth = Math.min(Math.max(FLOAT_MIN_WIDTH_PX, preRect.width), viewportMaxWidth);

    // Better height calculation for tall content:
    // - Use natural height up to FLOAT_MAX_HEIGHT_PX
    // - Content will scroll if it exceeds this height
    const naturalHeight = preRect.height;
    const maxAllowedHeight = Math.min(FLOAT_MAX_HEIGHT_PX, viewportMaxHeight);
    const initialHeight = Math.min(
      Math.max(FLOAT_MIN_HEIGHT_PX, naturalHeight),
      maxAllowedHeight
    );

    // Track if content needs scrollbar (height was clamped)
    const needsScroll = naturalHeight > initialHeight;

    // Create placeholder with matching height to prevent sidebar reflow
    if (!state.dockPlaceholder) {
      state.dockPlaceholder = document.createElement('div');
      state.dockPlaceholder.className = 'accordion-dock-placeholder';
    }
    state.dockPlaceholder.style.height = `${preRect.height}px`;
    state.dockPlaceholder.hidden = false;

    const parent = details.parentElement;
    if (parent) {
      state.dockParent = parent;
      parent.insertBefore(state.dockPlaceholder, details);
    }

    // Calculate clamped position
    const margin = 8;
    const maxLeft = Math.max(margin, viewportWidth - initialWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - initialHeight - margin);
    const clampedLeft = Math.min(Math.max(preRect.left, margin), maxLeft);
    const clampedTop = Math.min(Math.max(preRect.top, margin), maxTop);

    // Store base position for transform-based dragging
    state.baseLeft = clampedLeft;
    state.baseTop = clampedTop;

    // Set position with left/top (base position) - GPU optimized
    // Using transform: translateZ(0) to promote to compositor layer immediately
    details.style.cssText = `
      position: fixed;
      width: ${Math.round(initialWidth)}px;
      height: ${Math.round(initialHeight)}px;
      left: ${clampedLeft}px;
      top: ${clampedTop}px;
      z-index: ${++zIndexCounter};
      contain: layout style;
      will-change: transform;
      transform: translateZ(0);
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    `;

    // Move to floating root
    floatingRoot.appendChild(details);

    // Setup scrollbar for tall content
    const content = details.querySelector('.accordion-content');
    if (content && needsScroll) {
      content.classList.add('needs-scroll');
    }

    // Hide placeholder after a frame using optimized scheduler
    scheduleRAF(() => {
      if (state.dockPlaceholder) {
        state.dockPlaceholder.hidden = true;
        state.dockPlaceholder.style.height = '';
      }
    });

    details.open = true;
    setFloating(details, true);
    state.baseFloatSize = { width: initialWidth, height: initialHeight };

    return { left: clampedLeft, top: clampedTop, width: initialWidth, height: initialHeight };
  }

  // Standard undock with animation (for programmatic undock)
  function undock(details, { skipAnimation = false } = {}) {
    const rect = details.getBoundingClientRect();
    const result = undockFast(details, rect);
    if (result && !skipAnimation) {
      triggerTransientClass(details, 'floating-enter', 300);
    }
    return result;
  }

  function dock(details) {
    const state = getState(details);
    if (!state.isFloating) return;

    // Clean up GPU optimization
    cleanupDragLayer(details);

    const placeholder = state.dockPlaceholder;
    const parent = placeholder?.parentElement || state.dockParent;
    const accordion = parent?.closest?.('.accordion') || sidebar.querySelector('.accordion');

    const targetParent = parent || accordion || sidebar;
    if (targetParent) {
      const beforeNode = placeholder?.parentElement === targetParent ? placeholder : null;
      if (beforeNode) targetParent.insertBefore(details, beforeNode);
      else targetParent.appendChild(details);
    }

    placeholder?.remove();
    state.dockPlaceholder = null;
    state.dockParent = null;

    setFloating(details, false);
    details.classList.remove('dragging');
    details.style.cssText = '';

    triggerTransientClass(details, 'dock-flash', 350);
  }

  function shouldDockAtPointer(clientX, clientY, sidebarRect) {
    if (!sidebarRect) return false;
    if (sidebar.classList.contains('hidden')) return false;
    const rect = expandedRect(sidebarRect, DOCK_HIT_PADDING_PX);
    return pointInRect(clientX, clientY, rect);
  }

  function setDockIndicator(isActive, isHover) {
    sidebar.classList.toggle('dock-drop-active', isActive);
    sidebar.classList.toggle('dock-drop-hover', isActive && isHover);
  }

  function preventSelect(e) {
    e.preventDefault();
  }

  function setGlobalDragState(isDragging) {
    document.body.classList.toggle('dock-dragging', isDragging);
    if (isDragging) {
      cachedSidebarRect = sidebar.getBoundingClientRect();
      try {
        document.getSelection()?.removeAllRanges?.();
      } catch {
        // ignore
      }
      document.addEventListener('selectstart', preventSelect, { capture: true });
    } else {
      cachedSidebarRect = null;
      document.removeEventListener('selectstart', preventSelect, { capture: true });
    }
  }

  function setGlobalResizeState(isResizing) {
    document.body.classList.toggle('dock-resizing', isResizing);
    if (isResizing) {
      document.addEventListener('selectstart', preventSelect, { capture: true });
    } else {
      document.removeEventListener('selectstart', preventSelect, { capture: true });
    }
  }

  function ensureResizeHandles(details) {
    if (!details.querySelector('.accordion-width-handle')) {
      const widthHandle = document.createElement('div');
      widthHandle.className = 'accordion-width-handle';
      widthHandle.setAttribute('aria-hidden', 'true');
      details.appendChild(widthHandle);

      widthHandle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.pointerType === 'touch') return;
        e.preventDefault();
        e.stopPropagation();

        const state = getState(details);
        if (!state.isFloating) return;

        const pointerId = e.pointerId;
        const startX = e.clientX;
        const rect = details.getBoundingClientRect();
        const startWidth = rect.width;
        const startLeft = rect.left;
        const baseWidth = state.baseFloatSize?.width ?? startWidth;
        const maxWidthByScale = Math.max(FLOAT_MIN_WIDTH_PX, baseWidth * FLOAT_MAX_SCALE);
        const viewportWidth = window.innerWidth;

        setGlobalResizeState(true);
        details.classList.add('resizing');
        bumpZIndex(details);

        try {
          widthHandle.setPointerCapture(pointerId);
        } catch {
          // Ignore
        }

        let rafId = null;
        let pendingWidth = startWidth;

        function applyResize() {
          details.style.width = `${Math.round(pendingWidth)}px`;
          rafId = null;
        }

        function onMove(ev) {
          ev.preventDefault();
          const dx = ev.clientX - startX;

          const maxWidthByViewport = Math.max(
            FLOAT_MIN_WIDTH_PX,
            viewportWidth - startLeft - 8
          );

          pendingWidth = Math.min(
            Math.max(FLOAT_MIN_WIDTH_PX, startWidth + dx),
            Math.min(maxWidthByScale, maxWidthByViewport)
          );

          if (!rafId) {
            rafId = requestAnimationFrame(applyResize);
          }
        }

        function onUp() {
          widthHandle.removeEventListener('pointermove', onMove);
          widthHandle.removeEventListener('pointerup', onUp);
          widthHandle.removeEventListener('pointercancel', onUp);

          if (rafId) {
            cancelAnimationFrame(rafId);
            applyResize();
          }

          try {
            widthHandle.releasePointerCapture(pointerId);
          } catch {
            // Ignore
          }

          setGlobalResizeState(false);
          details.classList.remove('resizing');
        }

        widthHandle.addEventListener('pointermove', onMove);
        widthHandle.addEventListener('pointerup', onUp);
        widthHandle.addEventListener('pointercancel', onUp);
      });
    }
  }

  // Initialize summaries for all existing accordion sections.
  sidebar.querySelectorAll('details.accordion-section > summary').forEach((summary) => {
    const detailsForSummary = summary.closest('details.accordion-section');
    if (!detailsForSummary) return;
    getState(detailsForSummary);

    ensureDockButton(summary);
    ensureResizeHandles(detailsForSummary);

    detailsForSummary.addEventListener('pointerdown', () => {
      const state = stateByDetails.get(detailsForSummary);
      if (!state?.isFloating) return;
      bumpZIndex(detailsForSummary);
    }, { capture: true });

    summary.addEventListener('click', (e) => {
      const details = summary.closest('details.accordion-section');
      if (!details) return;
      const state = stateByDetails.get(details);
      if (!state?.suppressNextClick) return;
      state.suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;
      if (isInteractiveTarget(e.target)) return;

      const details = summary.closest('details.accordion-section');
      if (!details) return;

      e.preventDefault();

      const state = getState(details);
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      // PRE-MEASURE on pointerdown - before any visual changes
      const preRect = details.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // IMMEDIATELY pre-warm GPU layer on pointerdown - before drag threshold
      // This gives the compositor time to create the layer before we need it
      prewarmDragLayer(details);

      let didDrag = false;
      let grabOffsetX = 0;
      let grabOffsetY = 0;
      let rafId = null;
      let cachedWidth = 0;
      let cachedHeight = 0;

      // For GPU-accelerated dragging
      let baseLeft = 0;
      let baseTop = 0;
      let currentX = 0;
      let currentY = 0;

      // Throttle dock indicator updates - reduce to every 80ms for smoother feedback
      let lastDockCheck = 0;
      let lastDockResult = false;

      try {
        summary.setPointerCapture(pointerId);
      } catch {
        // Ignore
      }

      // Pre-calculate clamp bounds once (avoid recalculating every frame)
      let clampMargin = 8;
      let maxLeft = 0;
      let maxTop = 0;

      function updateClampBounds() {
        maxLeft = Math.max(clampMargin, viewportWidth - cachedWidth - clampMargin);
        maxTop = Math.max(clampMargin, viewportHeight - cachedHeight - clampMargin);
      }

      function clampPosition(targetLeft, targetTop) {
        return {
          x: Math.min(Math.max(targetLeft, clampMargin), maxLeft),
          y: Math.min(Math.max(targetTop, clampMargin), maxTop),
        };
      }

      function applyTransform() {
        // Pure GPU transform - no layout recalculation
        const clamped = clampPosition(currentX, currentY);
        const tx = clamped.x - baseLeft;
        const ty = clamped.y - baseTop;
        // Use translate3d for guaranteed GPU acceleration
        details.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        rafId = null;
      }

      function commitPosition() {
        // Convert transform to left/top position in a single write
        const clamped = clampPosition(currentX, currentY);
        // Batch style writes to avoid multiple reflows
        details.style.cssText = details.style.cssText.replace(
          /transform:[^;]+;?/,
          ''
        ) + `left: ${clamped.x}px; top: ${clamped.y}px;`;
        // Update state base position
        state.baseLeft = clamped.x;
        state.baseTop = clamped.y;
      }

      function startDrag(ev) {
        setGlobalDragState(true);

        if (!state.isFloating) {
          // Prepare full GPU layer for undock
          prepareDragLayer(details);

          const pos = undockFast(details, preRect);
          if (pos) {
            cachedWidth = pos.width;
            cachedHeight = pos.height;
            baseLeft = pos.left;
            baseTop = pos.top;
            grabOffsetX = startX - pos.left;
            grabOffsetY = startY - pos.top;
            currentX = pos.left;
            currentY = pos.top;
            updateClampBounds();
          }
        } else {
          bumpZIndex(details);
          prepareDragLayer(details);

          cachedWidth = preRect.width;
          cachedHeight = preRect.height;
          baseLeft = state.baseLeft || preRect.left;
          baseTop = state.baseTop || preRect.top;
          grabOffsetX = startX - preRect.left;
          grabOffsetY = startY - preRect.top;
          currentX = baseLeft;
          currentY = baseTop;
          updateClampBounds();
        }

        details.classList.add('dragging');
        lastDockResult = shouldDockAtPointer(ev.clientX, ev.clientY, cachedSidebarRect);
        setDockIndicator(true, lastDockResult);
      }

      function onMove(ev) {
        ev.preventDefault();

        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!didDrag) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          didDrag = true;
          startDrag(ev);
        }

        // Update target position
        currentX = ev.clientX - grabOffsetX;
        currentY = ev.clientY - grabOffsetY;

        // Schedule GPU transform using optimized RAF scheduler
        if (!rafId) {
          rafId = requestAnimationFrame(applyTransform);
        }

        // Throttle dock indicator checks - 80ms interval
        const now = performance.now();
        if (now - lastDockCheck > 80) {
          lastDockCheck = now;
          const hovering = shouldDockAtPointer(ev.clientX, ev.clientY, cachedSidebarRect);
          if (hovering !== lastDockResult) {
            lastDockResult = hovering;
            setDockIndicator(true, hovering);
          }
        }
      }

      function onUp(ev) {
        summary.removeEventListener('pointermove', onMove);
        summary.removeEventListener('pointerup', onUp);
        summary.removeEventListener('pointercancel', onUp);

        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }

        try {
          summary.releasePointerCapture(pointerId);
        } catch {
          // Ignore
        }

        // Clean up prewarm if drag never started
        if (!didDrag) {
          cleanupDragLayer(details);
          return;
        }

        // Commit final position
        commitPosition();

        // Cleanup GPU optimization
        cleanupDragLayer(details);

        setGlobalDragState(false);
        state.suppressNextClick = true;
        details.classList.remove('dragging');

        // Fresh sidebar rect for final dock check
        const finalSidebarRect = sidebar.getBoundingClientRect();
        const hoveringDock = shouldDockAtPointer(ev.clientX, ev.clientY, finalSidebarRect);
        setDockIndicator(false, false);

        if (state.isFloating && hoveringDock) {
          dock(details);
        }
      }

      summary.addEventListener('pointermove', onMove);
      summary.addEventListener('pointerup', onUp);
      summary.addEventListener('pointercancel', onUp);
    });
  });

  return { dock, undock, floatingRoot };
}
