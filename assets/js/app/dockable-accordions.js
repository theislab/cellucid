// Dockable accordions: drag a section header to tear it off into a floating window.
// REDESIGN v2: Drag ghost pattern for zero-lag dragging.

const DRAG_THRESHOLD_PX = 6;
const DETACH_DISTANCE_PX = 30;     // Distance from sidebar right edge to detach
const DOCK_HIT_PADDING_PX = 20;
const FLOAT_MIN_WIDTH_PX = 220;
const FLOAT_MIN_HEIGHT_PX = 100;
const FLOAT_MAX_HEIGHT_PX = 500;
const FLOAT_MAX_SCALE = 2;

function ensureFloatingRoot() {
  let root = document.getElementById('floating-panels-root');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'floating-panels-root';
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

export function initDockableAccordions({ sidebar } = {}) {
  if (!sidebar) {
    console.warn('[DockableAccordions] Missing sidebar element; skipping.');
    return { dock: () => {}, undock: () => {} };
  }

  const floatingRoot = ensureFloatingRoot();
  const stateByDetails = new Map();
  let zIndexCounter = 90;

  // ═══════════════════════════════════════════════════════════════════════════
  // State management
  // ═══════════════════════════════════════════════════════════════════════════

  function getState(details) {
    let state = stateByDetails.get(details);
    if (state) return state;
    state = {
      dockPlaceholder: null,
      dockParent: null,
      isFloating: false,
      suppressNextClick: false,
      baseFloatSize: null,
      floatLeft: 0,
      floatTop: 0,
    };
    stateByDetails.set(details, state);
    return state;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Dock button
  // ═══════════════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Undock - runs ONCE on drop, not during drag
  // ═══════════════════════════════════════════════════════════════════════════

  function undock(details, targetLeft, targetTop) {
    const state = getState(details);
    if (state.isFloating) return;

    const rect = details.getBoundingClientRect();
    const summary = details.querySelector(':scope > summary');
    const content = details.querySelector('.accordion-content');

    // Viewport constraints
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportMaxWidth = Math.max(FLOAT_MIN_WIDTH_PX, viewportWidth - 16);
    const viewportMaxHeight = Math.max(FLOAT_MIN_HEIGHT_PX, viewportHeight - 16);

    // Measure dimensions
    const headerHeight = summary ? summary.offsetHeight : 40;
    const contentScrollHeight = content ? content.scrollHeight : 0;

    // Calculate panel dimensions
    const initialWidth = Math.min(Math.max(FLOAT_MIN_WIDTH_PX, rect.width), viewportMaxWidth);
    const naturalHeight = headerHeight + contentScrollHeight + 24;
    const maxAllowedHeight = Math.min(FLOAT_MAX_HEIGHT_PX, viewportMaxHeight);
    const initialHeight = Math.min(Math.max(FLOAT_MIN_HEIGHT_PX, naturalHeight), maxAllowedHeight);
    const contentMaxHeight = initialHeight - headerHeight - 12;

    // Clamp position
    const margin = 8;
    const maxLeft = Math.max(margin, viewportWidth - initialWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - initialHeight - margin);
    const clampedLeft = Math.min(Math.max(targetLeft, margin), maxLeft);
    const clampedTop = Math.min(Math.max(targetTop, margin), maxTop);

    // Store position
    state.floatLeft = clampedLeft;
    state.floatTop = clampedTop;

    // Setup placeholder
    if (!state.dockPlaceholder) {
      state.dockPlaceholder = document.createElement('div');
      state.dockPlaceholder.className = 'accordion-dock-placeholder';
    }
    state.dockPlaceholder.style.height = `${rect.height}px`;
    state.dockPlaceholder.hidden = false;

    const parent = details.parentElement;
    if (parent) {
      state.dockParent = parent;
      parent.insertBefore(state.dockPlaceholder, details);
    }

    // Apply floating styles
    details.style.position = 'fixed';
    details.style.width = `${Math.round(initialWidth)}px`;
    details.style.height = `${Math.round(initialHeight)}px`;
    details.style.left = `${clampedLeft}px`;
    details.style.top = `${clampedTop}px`;
    details.style.zIndex = String(++zIndexCounter);
    details.style.contain = 'layout style';
    details.style.transform = 'translateZ(0)';
    details.style.backfaceVisibility = 'hidden';
    details.style.setProperty('--floating-header-height', `${headerHeight}px`);
    details.style.setProperty('--floating-content-max-height', `${contentMaxHeight}px`);

    // Set content scroll containment
    if (content) {
      content.style.maxHeight = `${contentMaxHeight}px`;
      content.style.overflowY = 'auto';
      content.style.overflowX = 'hidden';
      if (contentScrollHeight > contentMaxHeight) {
        content.classList.add('has-overflow');
      }
    }

    // Move to floating root
    floatingRoot.appendChild(details);
    details.open = true;

    setFloating(details, true);
    state.baseFloatSize = { width: initialWidth, height: initialHeight };

    // Trigger lift animation
    details.classList.add('floating-enter');
    details.addEventListener('animationend', () => {
      details.classList.remove('floating-enter');
    }, { once: true });

    // Hide placeholder after layout settles
    requestAnimationFrame(() => {
      if (state.dockPlaceholder) {
        state.dockPlaceholder.hidden = true;
        state.dockPlaceholder.style.height = '';
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dock - return floating panel to sidebar
  // ═══════════════════════════════════════════════════════════════════════════

  function dock(details) {
    const state = getState(details);
    if (!state.isFloating) return;

    // Reset content styles
    const content = details.querySelector('.accordion-content');
    if (content) {
      content.style.maxHeight = '';
      content.style.overflowY = '';
      content.style.overflowX = '';
      content.classList.remove('has-overflow');
    }

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

    // Trigger settle animation
    details.classList.add('dock-settle');
    details.addEventListener('animationend', () => {
      details.classList.remove('dock-settle');
    }, { once: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dock zone detection
  // ═══════════════════════════════════════════════════════════════════════════

  function isInSidebarZone(clientX, clientY, sidebarRect) {
    if (!sidebarRect) return true;
    if (sidebar.classList.contains('hidden')) return false;
    const rect = expandedRect(sidebarRect, DOCK_HIT_PADDING_PX);
    return pointInRect(clientX, clientY, rect);
  }

  function isOutsideDetachZone(clientX, sidebarRect) {
    if (!sidebarRect) return false;
    return clientX > sidebarRect.right + DETACH_DISTANCE_PX;
  }

  function setDockIndicator(isActive, isHover) {
    sidebar.classList.toggle('dock-drop-active', isActive);
    sidebar.classList.toggle('dock-drop-hover', isActive && isHover);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ghost element for drag preview
  // ═══════════════════════════════════════════════════════════════════════════

  function createGhost(title, width) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = title;
    ghost.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: ${width}px;
      pointer-events: none;
      z-index: 9999;
    `;
    document.body.appendChild(ghost);
    return ghost;
  }

  function positionGhost(ghost, x, y, offsetX, offsetY) {
    ghost.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
  }

  function removeGhost(ghost) {
    ghost?.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Global drag state
  // ═══════════════════════════════════════════════════════════════════════════

  function preventSelect(e) {
    e.preventDefault();
  }

  function setGlobalDragState(isDragging) {
    document.body.classList.toggle('dock-dragging', isDragging);
    if (isDragging) {
      try { document.getSelection()?.removeAllRanges?.(); } catch {}
      document.addEventListener('selectstart', preventSelect, { capture: true });
    } else {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Resize handles (for floating panels)
  // ═══════════════════════════════════════════════════════════════════════════

  function ensureResizeHandles(details) {
    if (details.querySelector('.accordion-width-handle')) return;

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
      const baseWidth = state.baseFloatSize?.width ?? startWidth;
      const maxWidthByScale = Math.max(FLOAT_MIN_WIDTH_PX, baseWidth * FLOAT_MAX_SCALE);
      const viewportWidth = window.innerWidth;
      const startLeft = rect.left;

      setGlobalResizeState(true);
      details.classList.add('resizing');
      bumpZIndex(details);

      try { widthHandle.setPointerCapture(pointerId); } catch {}

      let rafId = null;
      let pendingWidth = startWidth;

      function applyResize() {
        details.style.width = `${Math.round(pendingWidth)}px`;
        rafId = null;
      }

      function onMove(ev) {
        ev.preventDefault();
        const dx = ev.clientX - startX;
        const maxWidthByViewport = Math.max(FLOAT_MIN_WIDTH_PX, viewportWidth - startLeft - 8);
        pendingWidth = Math.min(
          Math.max(FLOAT_MIN_WIDTH_PX, startWidth + dx),
          Math.min(maxWidthByScale, maxWidthByViewport)
        );
        if (!rafId) rafId = requestAnimationFrame(applyResize);
      }

      function onUp() {
        widthHandle.removeEventListener('pointermove', onMove);
        widthHandle.removeEventListener('pointerup', onUp);
        widthHandle.removeEventListener('pointercancel', onUp);
        if (rafId) { cancelAnimationFrame(rafId); applyResize(); }
        try { widthHandle.releasePointerCapture(pointerId); } catch {}
        setGlobalResizeState(false);
        details.classList.remove('resizing');
      }

      widthHandle.addEventListener('pointermove', onMove);
      widthHandle.addEventListener('pointerup', onUp);
      widthHandle.addEventListener('pointercancel', onUp);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Drag handler for DOCKED panels (undocking)
  // ═══════════════════════════════════════════════════════════════════════════

  function setupDockedDrag(summary, details) {
    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;
      if (isInteractiveTarget(e.target)) return;

      const state = getState(details);
      if (state.isFloating) return; // Use floating drag handler instead

      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      // PRE-MEASURE on pointerdown (no DOM changes yet)
      const preRect = details.getBoundingClientRect();
      const title = summary.textContent?.trim() || 'Panel';
      const sidebarRect = sidebar.getBoundingClientRect();

      // Offset from pointer to panel top-left
      const offsetX = startX - preRect.left;
      const offsetY = startY - preRect.top;

      let didDrag = false;
      let ghost = null;
      let willDetach = false;

      try { summary.setPointerCapture(pointerId); } catch {}

      function onMove(ev) {
        ev.preventDefault();
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!didDrag) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          didDrag = true;

          // START DRAG: Create ghost, dim original
          setGlobalDragState(true);
          ghost = createGhost(title, preRect.width);
          details.classList.add('drag-source');
        }

        // Update ghost position
        positionGhost(ghost, ev.clientX, ev.clientY, offsetX, offsetY);

        // Check if outside detach zone
        const nowOutside = isOutsideDetachZone(ev.clientX, sidebarRect);
        if (nowOutside !== willDetach) {
          willDetach = nowOutside;
          ghost.classList.toggle('will-detach', willDetach);
        }
      }

      function onUp(ev) {
        summary.removeEventListener('pointermove', onMove);
        summary.removeEventListener('pointerup', onUp);
        summary.removeEventListener('pointercancel', onUp);

        try { summary.releasePointerCapture(pointerId); } catch {}

        if (!didDrag) return;

        // Cleanup
        setGlobalDragState(false);
        details.classList.remove('drag-source');
        removeGhost(ghost);

        // If dragged outside sidebar: undock at ghost position
        if (willDetach) {
          const targetLeft = ev.clientX - offsetX;
          const targetTop = ev.clientY - offsetY;
          undock(details, targetLeft, targetTop);
          state.suppressNextClick = true;
        }
      }

      summary.addEventListener('pointermove', onMove);
      summary.addEventListener('pointerup', onUp);
      summary.addEventListener('pointercancel', onUp);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Drag handler for FLOATING panels (re-docking or repositioning)
  // ═══════════════════════════════════════════════════════════════════════════

  function setupFloatingDrag(summary, details) {
    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;
      if (isInteractiveTarget(e.target)) return;

      const state = getState(details);
      if (!state.isFloating) return; // Use docked drag handler instead

      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      // PRE-MEASURE
      const preRect = details.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const offsetX = startX - preRect.left;
      const offsetY = startY - preRect.top;

      // For position clamping
      const clampMargin = 8;
      const maxLeft = Math.max(clampMargin, viewportWidth - preRect.width - clampMargin);
      const maxTop = Math.max(clampMargin, viewportHeight - preRect.height - clampMargin);

      let didDrag = false;
      let baseLeft = state.floatLeft;
      let baseTop = state.floatTop;
      let currentX = baseLeft;
      let currentY = baseTop;
      let rafId = null;
      let lastTransform = '';
      let cachedSidebarRect = null;
      let isHoveringDock = false;

      try { summary.setPointerCapture(pointerId); } catch {}

      function clamp(targetLeft, targetTop) {
        return {
          x: Math.min(Math.max(targetLeft, clampMargin), maxLeft),
          y: Math.min(Math.max(targetTop, clampMargin), maxTop),
        };
      }

      function applyTransform() {
        const clamped = clamp(currentX, currentY);
        const tx = clamped.x - baseLeft;
        const ty = clamped.y - baseTop;
        const newTransform = `translate3d(${tx}px, ${ty}px, 0)`;
        if (newTransform !== lastTransform) {
          lastTransform = newTransform;
          details.style.transform = newTransform;
        }
        rafId = null;
      }

      function commitPosition() {
        const clamped = clamp(currentX, currentY);
        details.style.transform = 'translateZ(0)';
        details.style.left = `${clamped.x}px`;
        details.style.top = `${clamped.y}px`;
        state.floatLeft = clamped.x;
        state.floatTop = clamped.y;
        lastTransform = '';
      }

      function onMove(ev) {
        ev.preventDefault();

        if (!didDrag) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          didDrag = true;

          setGlobalDragState(true);
          bumpZIndex(details);
          details.classList.add('dragging');
          details.style.willChange = 'transform';
          cachedSidebarRect = sidebar.getBoundingClientRect();

          // Show dock indicator
          setDockIndicator(true, false);
        }

        // Update position
        currentX = ev.clientX - offsetX;
        currentY = ev.clientY - offsetY;

        if (!rafId) rafId = requestAnimationFrame(applyTransform);

        // Check dock hover
        const hovering = isInSidebarZone(ev.clientX, ev.clientY, cachedSidebarRect);
        if (hovering !== isHoveringDock) {
          isHoveringDock = hovering;
          setDockIndicator(true, hovering);
        }
      }

      function onUp(ev) {
        summary.removeEventListener('pointermove', onMove);
        summary.removeEventListener('pointerup', onUp);
        summary.removeEventListener('pointercancel', onUp);

        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

        try { summary.releasePointerCapture(pointerId); } catch {}

        if (!didDrag) return;

        commitPosition();

        details.style.willChange = '';
        setGlobalDragState(false);
        details.classList.remove('dragging');
        setDockIndicator(false, false);
        state.suppressNextClick = true;

        // If hovering sidebar: dock
        const finalSidebarRect = sidebar.getBoundingClientRect();
        if (isInSidebarZone(ev.clientX, ev.clientY, finalSidebarRect)) {
          dock(details);
        }
      }

      summary.addEventListener('pointermove', onMove);
      summary.addEventListener('pointerup', onUp);
      summary.addEventListener('pointercancel', onUp);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Initialize
  // ═══════════════════════════════════════════════════════════════════════════

  sidebar.querySelectorAll('details.accordion-section > summary').forEach((summary) => {
    const details = summary.closest('details.accordion-section');
    if (!details) return;

    getState(details);
    ensureDockButton(summary);
    ensureResizeHandles(details);

    // Z-index bump on any pointer interaction with floating panel
    details.addEventListener('pointerdown', () => {
      const state = stateByDetails.get(details);
      if (!state?.isFloating) return;
      bumpZIndex(details);
    }, { capture: true });

    // Suppress click after drag
    summary.addEventListener('click', (e) => {
      const state = stateByDetails.get(details);
      if (!state?.suppressNextClick) return;
      state.suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    // Drag handlers - both check state to determine which behavior to use
    setupDockedDrag(summary, details);
    setupFloatingDrag(summary, details);
  });

  return { dock, undock: (details) => {
    const rect = details.getBoundingClientRect();
    undock(details, rect.left, rect.top);
  }, floatingRoot };
}
