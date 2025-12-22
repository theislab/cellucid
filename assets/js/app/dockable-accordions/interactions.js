/**
 * @fileoverview Interaction helpers for dockable accordions.
 *
 * Extracted from `dockable-accordions.js` so the main module can stay focused
 * on layout/state while drag/resize logic lives in a dedicated unit.
 *
 * @module dockable-accordions/interactions
 */

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

function isInteractiveTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('button, a, input, select, textarea, [role=\"button\"]');
}

function createGhost(StyleManager, title, width) {
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = title;
  StyleManager.setVariable(ghost, '--ghost-width', `${width}px`);
  document.body.appendChild(ghost);
  return ghost;
}

function positionGhost(ghost, x, y, offsetX, offsetY) {
  ghost.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
}

function removeGhost(ghost) {
  ghost?.remove();
}

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

export function createAccordionInteractions({
  sidebar,
  StyleManager,
  isFiniteNumber,
  getState,
  bumpZIndex,
  undock,
  dock,
  constants
}) {
  const {
    DRAG_THRESHOLD_PX,
    DETACH_DISTANCE_PX,
    DOCK_HIT_PADDING_PX,
    FLOAT_MIN_WIDTH_PX,
    FLOAT_MAX_SCALE
  } = constants || {};

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

  // Resize handles (for floating panels)
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
      const minWidth = state.widthConstraints?.min ?? FLOAT_MIN_WIDTH_PX;
      const maxWidthConstraint = state.widthConstraints?.max;
      const baseWidth = state.baseFloatSize?.width ?? startWidth;
      const maxWidthByScale = Math.max(minWidth, baseWidth * FLOAT_MAX_SCALE);
      const maxWidth = isFiniteNumber(maxWidthConstraint)
        ? Math.max(minWidth, maxWidthConstraint)
        : maxWidthByScale;
      const viewportWidth = window.innerWidth;
      const startLeft = rect.left;

      setGlobalResizeState(true);
      details.classList.add('resizing');
      bumpZIndex(details);

      try { widthHandle.setPointerCapture(pointerId); } catch {}

      let rafId = null;
      let pendingWidth = startWidth;

      function applyResize() {
        StyleManager.setPosition(details, { width: Math.round(pendingWidth) });
        rafId = null;
      }

      function onMove(ev) {
        ev.preventDefault();
        const dx = ev.clientX - startX;
        const maxWidthByViewport = Math.max(minWidth, viewportWidth - startLeft - 8);
        pendingWidth = Math.min(
          Math.max(minWidth, startWidth + dx),
          Math.min(maxWidth, maxWidthByViewport)
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

  // Drag handler for DOCKED panels (undocking)
  function setupDockedDrag(summary, details) {
    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;
      if (isInteractiveTarget(e.target)) return;

      const state = getState(details);
      if (state.isFloating) return;
      if (!state.dockable) return;

      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      const preRect = details.getBoundingClientRect();
      const title = summary.textContent?.trim() || 'Panel';
      const sidebarRect = sidebar.getBoundingClientRect();

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

          setGlobalDragState(true);
          ghost = createGhost(StyleManager, title, preRect.width);
          details.classList.add('drag-source');
        }

        positionGhost(ghost, ev.clientX, ev.clientY, offsetX, offsetY);

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

        setGlobalDragState(false);
        details.classList.remove('drag-source');
        removeGhost(ghost);

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

  // Drag handler for FLOATING panels (re-docking or repositioning)
  function setupFloatingDrag(summary, details) {
    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;
      if (isInteractiveTarget(e.target)) return;

      const state = getState(details);
      if (!state.isFloating) return;
      const allowDock = !!state.dockable;

      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      const preRect = details.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const offsetX = startX - preRect.left;
      const offsetY = startY - preRect.top;

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
        StyleManager.setPosition(details, { x: clamped.x, y: clamped.y });
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

          if (allowDock) setDockIndicator(true, false);
        }

        currentX = ev.clientX - offsetX;
        currentY = ev.clientY - offsetY;

        if (!rafId) rafId = requestAnimationFrame(applyTransform);

        if (allowDock) {
          const hovering = isInSidebarZone(ev.clientX, ev.clientY, cachedSidebarRect);
          if (hovering !== isHoveringDock) {
            isHoveringDock = hovering;
            setDockIndicator(true, hovering);
          }
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
        if (allowDock) setDockIndicator(false, false);
        state.suppressNextClick = true;

        if (allowDock) {
          const finalSidebarRect = sidebar.getBoundingClientRect();
          if (isInSidebarZone(ev.clientX, ev.clientY, finalSidebarRect)) {
            dock(details);
          }
        }
      }

      summary.addEventListener('pointermove', onMove);
      summary.addEventListener('pointerup', onUp);
      summary.addEventListener('pointercancel', onUp);
    });
  }

  return { ensureResizeHandles, setupDockedDrag, setupFloatingDrag };
}

