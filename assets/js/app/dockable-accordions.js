// Dockable accordions: drag a section header to tear it off into a floating window.
// REDESIGN v2: Drag ghost pattern for zero-lag dragging.

import { StyleManager } from '../utils/style-manager.js';
import { isFiniteNumber } from './utils/number-utils.js';
import { createAccordionInteractions } from './dockable-accordions/interactions.js';

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
  document.body.appendChild(root);
  return root;
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
      dockable: true,
      registered: false,
      widthConstraints: null,
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
    StyleManager.setLayer(details, zIndexCounter);
  }

  function setFloating(details, floating) {
    const state = getState(details);
    state.isFloating = floating;
    details.classList.toggle('accordion-floating', floating);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dock button
  // ═══════════════════════════════════════════════════════════════════════════

  function syncDockButton(summary, details) {
    const state = getState(details);
    const existing = summary.querySelector('.accordion-dock-btn');
    if (!state.dockable) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'accordion-dock-btn';
    btn.setAttribute('aria-label', 'Dock panel back into sidebar');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dock(details);
    });
    summary.appendChild(btn);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Undock - runs ONCE on drop, not during drag
  // ═══════════════════════════════════════════════════════════════════════════

  function applyFloatingLayout(details, targetLeft, targetTop, options = {}) {
    const { createPlaceholder = true, preferredSize = null, constraints = null } = options;
    const state = getState(details);
    if (state.isFloating) return;

    const rect = details.getBoundingClientRect();
    const summary = details.querySelector(':scope > summary');
    const content = details.querySelector('.accordion-content');

    // Viewport constraints
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const minWidth = isFiniteNumber(constraints?.minWidth) ? constraints.minWidth : FLOAT_MIN_WIDTH_PX;
    const maxWidth = isFiniteNumber(constraints?.maxWidth) ? constraints.maxWidth : Infinity;
    const minHeight = isFiniteNumber(constraints?.minHeight) ? constraints.minHeight : FLOAT_MIN_HEIGHT_PX;
    const maxHeight = isFiniteNumber(constraints?.maxHeight) ? constraints.maxHeight : FLOAT_MAX_HEIGHT_PX;

    const viewportMaxWidth = Math.max(minWidth, viewportWidth - 16);
    const viewportMaxHeight = Math.max(minHeight, viewportHeight - 16);

    // Measure dimensions
    const headerHeight = summary ? summary.offsetHeight : 40;
    const contentScrollHeight = content ? content.scrollHeight : 0;

    const requestedWidth = isFiniteNumber(preferredSize?.width) ? preferredSize.width : rect.width;
    const naturalHeight = headerHeight + contentScrollHeight + 24;
    const requestedHeight = isFiniteNumber(preferredSize?.height) ? preferredSize.height : naturalHeight;

    // Calculate panel dimensions
    const initialWidth = Math.min(
      Math.max(minWidth, requestedWidth),
      Math.min(maxWidth, viewportMaxWidth)
    );
    const initialHeight = Math.min(
      Math.max(minHeight, requestedHeight),
      Math.min(maxHeight, viewportMaxHeight)
    );
    const contentMaxHeight = Math.max(0, initialHeight - headerHeight - 12);

    // Clamp position
    const margin = 8;
    const maxLeft = Math.max(margin, viewportWidth - initialWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - initialHeight - margin);
    const clampedLeft = Math.min(Math.max(targetLeft, margin), maxLeft);
    const clampedTop = Math.min(Math.max(targetTop, margin), maxTop);

    // Store position
    state.floatLeft = clampedLeft;
    state.floatTop = clampedTop;

    // Setup placeholder (docked panels only)
    if (createPlaceholder) {
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
    } else {
      state.dockPlaceholder?.remove();
      state.dockPlaceholder = null;
      state.dockParent = null;
    }

    // Apply floating styles
    setFloating(details, true);
    StyleManager.setPosition(details, {
      x: clampedLeft,
      y: clampedTop,
      width: Math.round(initialWidth),
      height: Math.round(initialHeight),
    });
    StyleManager.setLayer(details, ++zIndexCounter);
    StyleManager.setVariable(details, '--floating-header-height', `${headerHeight}px`);
    StyleManager.setVariable(details, '--floating-content-max-height', `${contentMaxHeight}px`);

    // Set content scroll containment
    if (content) {
      if (contentScrollHeight > contentMaxHeight) {
        content.classList.add('has-overflow');
      }
    }

    // Move to floating root
    floatingRoot.appendChild(details);
    details.open = true;

    state.baseFloatSize = { width: initialWidth, height: initialHeight };
    state.widthConstraints = {
      min: minWidth,
      max: isFiniteNumber(constraints?.maxWidth) ? constraints.maxWidth : (initialWidth * FLOAT_MAX_SCALE)
    };
    details.style.visibility = '';

    // Trigger lift animation
    details.classList.add('floating-enter');
    details.addEventListener('animationend', () => {
      details.classList.remove('floating-enter');
    }, { once: true });

    if (createPlaceholder) {
      // Hide placeholder after layout settles
      requestAnimationFrame(() => {
        if (state.dockPlaceholder) {
          state.dockPlaceholder.hidden = true;
          state.dockPlaceholder.style.height = '';
        }
      });
    }
  }

  function undock(details, targetLeft, targetTop) {
    const state = getState(details);
    if (state.isFloating) return;
    if (!state.dockable) return;
    applyFloatingLayout(details, targetLeft, targetTop, { createPlaceholder: true });
  }

  function floatPanel(details, targetLeft, targetTop, options = {}) {
    const state = getState(details);
    if (state.isFloating) return;
    applyFloatingLayout(details, targetLeft, targetTop, { ...options, createPlaceholder: false });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dock - return floating panel to sidebar
  // ═══════════════════════════════════════════════════════════════════════════

  function dock(details) {
    const state = getState(details);
    if (!state.isFloating) return;
    if (!state.dockable) return;

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
    StyleManager.clearPosition(details);
    StyleManager.removeVariable(details, '--z-layer');
    StyleManager.removeVariable(details, '--floating-header-height');
    StyleManager.removeVariable(details, '--floating-content-max-height');

    // Trigger settle animation
    details.classList.add('dock-settle');
    details.addEventListener('animationend', () => {
      details.classList.remove('dock-settle');
    }, { once: true });
  }

  const interactions = createAccordionInteractions({
    sidebar,
    StyleManager,
    isFiniteNumber,
    getState,
    bumpZIndex,
    undock,
    dock,
    constants: {
      DRAG_THRESHOLD_PX,
      DETACH_DISTANCE_PX,
      DOCK_HIT_PADDING_PX,
      FLOAT_MIN_WIDTH_PX,
      FLOAT_MAX_SCALE
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Initialize
  // ═══════════════════════════════════════════════════════════════════════════

  function register(details, options = {}) {
    if (!(details instanceof HTMLElement)) return;
    if (!details.matches?.('details.accordion-section')) return;

    const summary = details.querySelector(':scope > summary');
    if (!summary) return;

    const state = getState(details);
    state.dockable = options.dockable !== false;
    syncDockButton(summary, details);
    interactions.ensureResizeHandles(details);

    if (state.registered) return;
    state.registered = true;

    // Z-index bump on any pointer interaction with floating panel
    details.addEventListener('pointerdown', () => {
      const s = stateByDetails.get(details);
      if (!s?.isFloating) return;
      bumpZIndex(details);
    }, { capture: true });

    // Suppress click after drag
    summary.addEventListener('click', (e) => {
      const s = stateByDetails.get(details);
      if (!s?.suppressNextClick) return;
      s.suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    // Drag handlers - both check state to determine which behavior to use
    interactions.setupDockedDrag(summary, details);
    interactions.setupFloatingDrag(summary, details);
  }

  function unregister(details) {
    const state = stateByDetails.get(details);
    if (!state) return;
    try { state.dockPlaceholder?.remove(); } catch {}
    stateByDetails.delete(details);
  }

  sidebar.querySelectorAll('details.accordion-section').forEach((details) => {
    register(details, { dockable: true });
  });

  return {
    dock,
    undock: (details) => {
      const rect = details.getBoundingClientRect();
      undock(details, rect.left, rect.top);
    },
    float: (details, leftOrOptions, top, options = {}) => {
      const rect = details.getBoundingClientRect();
      if (isFiniteNumber(leftOrOptions)) {
        floatPanel(details, leftOrOptions ?? rect.left, top ?? rect.top, options);
        return;
      }
      const opts = leftOrOptions && typeof leftOrOptions === 'object' ? leftOrOptions : {};
      floatPanel(
        details,
        isFiniteNumber(opts.left) ? opts.left : rect.left,
        isFiniteNumber(opts.top) ? opts.top : rect.top,
        opts
      );
    },
    register,
    unregister,
    floatingRoot
  };
}
