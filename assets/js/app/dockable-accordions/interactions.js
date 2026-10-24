import {
  FLOATING_MARGIN,
  RESIZE_EDGES,
  clampFloatingPosition,
  floatingSnapTargets,
  keyboardResizeTravel,
  maximizedFloatingRect,
  resizeFloatingRect
} from './geometry.js';
import { announceKeyboardMove } from '../ui/keyboard-move.js';
import { capturePointer, releasePointer } from '../ui/pointer-capture.js';
/**
 * @fileoverview Interaction helpers for dockable accordions.
 *
 * Extracted from `dockable-accordions.js` so the main module can stay focused
 * on layout/state while drag/resize logic lives in a dedicated unit.
 *
 * Every gesture starts on a panel's `<details>` (its summary, its width
 * handle) and moves, measures and restyles the panel's frame, which is the box
 * that floats (see `panelFrame` in `dockable-accordions.js`).
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

function setGlobalResizeState(isResizing, cursor = 'ew-resize') {
  document.body.classList.toggle('dock-resizing', isResizing);
  if (isResizing) {
    document.body.style.setProperty('--dock-resize-cursor', cursor);
    document.addEventListener('selectstart', preventSelect, { capture: true });
  } else {
    document.body.style.removeProperty('--dock-resize-cursor');
    document.removeEventListener('selectstart', preventSelect, { capture: true });
  }
}

export function createAccordionInteractions({
  sidebar,
  StyleManager,
  getState,
  panelFrame,
  isFloating,
  raiseToTop,
  undock,
  dock,
  constants
}) {
  const {
    DRAG_THRESHOLD_PX,
    DETACH_DISTANCE_PX,
    DOCK_HIT_PADDING_PX,
    FLOAT_MIN_WIDTH_PX
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

  // ═════════════════════════════════════════════════════════════════════════
  // Resizing a floating panel: eight handles (four edges, four corners), by
  // pointer — mouse, pen or finger — and by keyboard.
  //
  // The handles are children of the frame, not of the `<details>`: a closed
  // `<details>` renders only its summary, and the card clips what overhangs
  // it, so handles inside it could neither straddle the border nor exist
  // while the panel is collapsed.
  // ═════════════════════════════════════════════════════════════════════════

  const HANDLE_NAMES = {
    n: 'top edge',
    ne: 'top-right corner',
    e: 'right edge',
    se: 'bottom-right corner',
    s: 'bottom edge',
    sw: 'bottom-left corner',
    w: 'left edge',
    nw: 'top-left corner'
  };
  const HANDLE_CURSORS = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
  };
  const KEY_STEP_PX = 16;
  const KEY_STEP_LARGE_PX = 64;
  const SNAP_DISTANCE_PX = 12;
  const SNAP_DISTANCE_COARSE_PX = 20;
  const READOUT_LINGER_MS = 900;
  const FIRST_CONTROL_SELECTOR = 'select, input:not([type="hidden"]), textarea, button';

  /**
   * How much of a panel's content shows its first control: from the top of
   * the content to the bottom of its first select, field or button (its
   * label and the padding above included).
   */
  function firstControlHeight(details) {
    const content = details.querySelector(':scope > .accordion-content');
    const first = content?.querySelector(FIRST_CONTROL_SELECTOR) ?? null;
    if (first === null) return 0;
    const top = content.getBoundingClientRect().top - content.scrollTop;
    return Math.max(0, Math.ceil(first.getBoundingClientRect().bottom - top));
  }

  function handlesOf(frame) {
    return frame.querySelectorAll(':scope > .accordion-resize-handle');
  }

  function isSheet(frame) {
    return frame.classList.contains('floating-sheet');
  }

  /**
   * The panel's box as the dockable owner wrote it (`--pos-*`): not a
   * measurement, which would be scaled while the panel lifts in and clipped
   * on a viewport smaller than the panel.
   */
  function frameRect(frame) {
    const read = name => Number.parseFloat(frame.style.getPropertyValue(name));
    return { left: read('--pos-x'), top: read('--pos-y'), width: read('--pos-width'), height: read('--pos-height') };
  }

  /**
   * The height that shows all of the panel's content: its header plus the
   * content's own extent (its scroll height while it overflows, else the
   * bottom of its last child).
   */
  function contentHeight(details) {
    const summary = details.querySelector(':scope > summary');
    const content = details.querySelector(':scope > .accordion-content');
    const header = summary?.offsetHeight ?? 0;
    if (content === null || !details.open) return header;
    let extent = content.scrollHeight;
    if (!(content.scrollHeight > content.clientHeight + 1)) {
      const box = content.getBoundingClientRect();
      let bottom = box.top;
      for (const child of content.children) {
        bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
      }
      const padding = Number.parseFloat(getComputedStyle(content).paddingBottom) || 0;
      extent = bottom - box.top + padding;
    }
    // The card's top and bottom border.
    return Math.ceil(header + extent + 2);
  }

  /**
   * The smallest box that still works: as narrow as the panel's minimum
   * width, as short as its header and the first control of its content (the
   * rest scrolls).
   */
  function sizeLimits(details, state) {
    const summary = details.querySelector(':scope > summary');
    const header = summary?.offsetHeight ?? 0;
    // The header can change height (a pointer of another kind, a longer
    // title); the content's height follows it (`_accordion.css`).
    StyleManager.setVariable(panelFrame(details), '--floating-header-height', `${header}px`);
    const firstRow = details.open ? firstControlHeight(details) : 0;
    const contentMin = header + firstRow + 2;
    return {
      minWidth: state.widthConstraints?.min ?? FLOAT_MIN_WIDTH_PX,
      minHeight: Math.max(state.minHeight ?? 0, contentMin)
    };
  }

  function viewport() {
    return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  }

  function sidebarBox() {
    if (sidebar.classList.contains('hidden')) return { right: 0, width: 0 };
    const rect = sidebar.getBoundingClientRect();
    return { right: rect.right, width: rect.width };
  }

  function snapTargetsFor(details, frame, distance) {
    const others = [];
    for (const sibling of frame.parentElement?.children ?? []) {
      if (sibling === frame || !sibling.classList.contains('accordion-floating')) continue;
      others.push(sibling.getBoundingClientRect());
    }
    const side = sidebarBox();
    return floatingSnapTargets({
      ...viewport(),
      sidebarRight: side.right,
      sidebarWidth: side.width,
      others,
      contentHeight: contentHeight(details),
      distance
    });
  }

  /**
   * Write a box and keep the drag origin in step. It reads no layout, so a
   * drag can write once a frame without forcing one; the handles' values are
   * brought up to date when the gesture or key is done.
   */
  function applyRect(details, rect) {
    const state = getState(details);
    const frame = panelFrame(details);
    StyleManager.setPosition(frame, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    state.floatLeft = rect.left;
    state.floatTop = rect.top;
  }

  function notifyGeometry(details) {
    const state = getState(details);
    if (typeof state.onGeometryChange !== 'function') return;
    const frame = panelFrame(details);
    const width = Number.parseFloat(frame.style.getPropertyValue('--pos-width'));
    const height = Number.parseFloat(frame.style.getPropertyValue('--pos-height'));
    if (!(width > 0) || !(height > 0)) return;
    state.onGeometryChange({ width, height });
  }

  function readoutOf(frame) {
    return frame.querySelector(':scope > .floating-size-readout');
  }

  function showReadout(details, rect, linger) {
    const frame = panelFrame(details);
    const readout = readoutOf(frame);
    if (readout === null) return;
    readout.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    frame.classList.add('size-readout-visible');
    const state = getState(details);
    clearTimeout(state.readoutTimer);
    state.readoutTimer = linger
      ? setTimeout(() => frame.classList.remove('size-readout-visible'), READOUT_LINGER_MS)
      : null;
  }

  function hideReadout(details) {
    const frame = panelFrame(details);
    const state = getState(details);
    clearTimeout(state.readoutTimer);
    state.readoutTimer = null;
    frame.classList.remove('size-readout-visible');
  }

  /** The 1 px guides shown while an edge sits on a snap line. */
  function showGuides(frame, guides) {
    const root = frame.parentElement;
    if (root === null) return;
    for (const axis of ['x', 'y']) {
      let guide = root.querySelector(`:scope > .floating-snap-guide[data-axis="${axis}"]`);
      if (guides[axis] === null) {
        if (guide !== null) guide.hidden = true;
        continue;
      }
      if (guide === null) {
        guide = document.createElement('div');
        guide.className = 'floating-snap-guide';
        guide.setAttribute('data-axis', axis);
        guide.setAttribute('aria-hidden', 'true');
        root.appendChild(guide);
      }
      guide.hidden = false;
      StyleManager.setVariable(guide, '--guide-at', `${Math.round(guides[axis])}px`);
    }
  }

  function hideGuides(frame) {
    showGuides(frame, { x: null, y: null });
  }

  /**
   * Keep every handle's `aria-value*` on the box. A focusable `separator` is
   * the window-splitter role: assistive technology reads the size off it on
   * every key, so resizing needs no announcement of its own.
   *
   * `knownRect` is a box the caller has just written; measuring right after a
   * style write would force a synchronous layout.
   */
  function syncHandles(details, knownRect = null) {
    if (!isFloating(details)) return;
    const frame = panelFrame(details);
    const handles = handlesOf(frame);
    if (handles.length === 0) return;
    const state = getState(details);
    const rect = knownRect ?? frameRect(frame);
    const { minWidth, minHeight } = sizeLimits(details, state);
    const { viewportWidth, viewportHeight } = viewport();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    for (const handle of handles) {
      const edge = handle.dataset.edge;
      const vertical = edge === 'n' || edge === 's';
      const value = vertical ? height : width;
      const min = vertical ? minHeight : minWidth;
      const max = vertical
        ? viewportHeight - 2 * FLOATING_MARGIN
        : viewportWidth - 2 * FLOATING_MARGIN;
      handle.setAttribute('aria-valuemin', String(Math.round(Math.min(min, max))));
      handle.setAttribute('aria-valuemax', String(Math.round(Math.max(min, max))));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', `${width} × ${height} pixels`);
    }
  }

  function clearMaximized(details) {
    const state = getState(details);
    if (state.restoreRect === null || state.restoreRect === undefined) return;
    state.restoreRect = null;
    syncMaximized(details);
  }

  function syncMaximized(details) {
    const frame = panelFrame(details);
    const maximized = getState(details).restoreRect != null;
    frame.classList.toggle('maximized', maximized);
    const button = frame.querySelector(':scope > .accordion-panel-actions > .accordion-maximize-btn');
    if (button === null) return;
    const label = maximized ? 'Restore window size' : 'Maximize window';
    button.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  /**
   * Maximize a floating panel to the free area beside the sidebar, or give it
   * back the box it had. Moving or resizing a maximized panel keeps its box
   * and forgets the one to restore.
   *
   * @param {HTMLElement} details
   * @returns {boolean} Whether the panel is maximized now.
   */
  function toggleMaximize(details) {
    if (!isFloating(details)) return false;
    const frame = panelFrame(details);
    if (isSheet(frame)) return false;
    const state = getState(details);
    if (state.restoreRect != null) {
      const back = state.restoreRect;
      state.restoreRect = null;
      applyRect(details, back);
    } else {
      state.restoreRect = frameRect(frame);
      const { minWidth } = sizeLimits(details, state);
      applyRect(details, maximizedFloatingRect({
        sidebarRight: sidebarBox().right,
        minWidth,
        ...viewport()
      }));
    }
    raiseToTop(frame);
    syncMaximized(details);
    syncHandles(details);
    notifyGeometry(details);
    return state.restoreRect != null;
  }

  /** Fit an edge to the content: height to all of it, width to the opening width. */
  function fitToContent(details, edge) {
    const frame = panelFrame(details);
    const state = getState(details);
    const start = frameRect(frame);
    const { minWidth, minHeight } = sizeLimits(details, state);
    const { viewportWidth, viewportHeight } = viewport();
    let dx = 0;
    let dy = 0;
    if (edge.includes('n') || edge.includes('s')) {
      const delta = contentHeight(details) - start.height;
      dy = edge.includes('s') ? delta : -delta;
    }
    if (edge.includes('e') || edge.includes('w')) {
      const target = state.baseFloatSize?.width ?? start.width;
      const delta = target - start.width;
      dx = edge.includes('e') ? delta : -delta;
    }
    const { rect } = resizeFloatingRect({
      start, edge, dx, dy, minWidth, minHeight, viewportWidth, viewportHeight
    });
    clearMaximized(details);
    applyRect(details, rect);
    syncHandles(details, rect);
    showReadout(details, rect, true);
    notifyGeometry(details);
  }

  /**
   * Move a floating panel by keyboard (Alt+Arrow on its header or a handle).
   *
   * @param {HTMLElement} details
   * @param {KeyboardEvent} event
   * @returns {boolean} Whether the key was a move.
   */
  function moveByKeyboard(details, event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return false;
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    const travel = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]
    }[event.key];
    if (travel === undefined || !isFloating(details)) return false;
    const frame = panelFrame(details);
    if (isSheet(frame)) return false;
    event.preventDefault();
    event.stopPropagation();
    const state = getState(details);
    const rect = frameRect(frame);
    const { x, y } = clampFloatingPosition({
      left: state.floatLeft + travel[0],
      top: state.floatTop + travel[1],
      width: rect.width,
      height: rect.height,
      ...viewport()
    });
    clearMaximized(details);
    StyleManager.setPosition(frame, { x, y });
    state.floatLeft = x;
    state.floatTop = y;
    announceKeyboardMove(document, `Window moved to ${Math.round(x)}, ${Math.round(y)}.`);
    return true;
  }

  function onHandleKeydown(details, handle, e) {
    if (!isFloating(details)) return;
    if (moveByKeyboard(details, e)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const frame = panelFrame(details);
    if (isSheet(frame)) return;
    const travel = keyboardResizeTravel(
      handle.dataset.edge,
      e.key,
      e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX,
      viewport()
    );
    if (travel === null) return;
    e.preventDefault();
    e.stopPropagation();
    const state = getState(details);
    const { rect } = resizeFloatingRect({
      start: frameRect(frame),
      edge: handle.dataset.edge,
      ...travel,
      ...sizeLimits(details, state),
      ...viewport()
    });
    clearMaximized(details);
    applyRect(details, rect);
    syncHandles(details, rect);
    showReadout(details, rect, true);
    notifyGeometry(details);
  }

  function onHandlePointerdown(details, handle, e) {
    if (e.button !== 0) return;
    if (!isFloating(details)) return;
    const frame = panelFrame(details);
    if (isSheet(frame)) return;
    e.preventDefault();
    e.stopPropagation();

    const state = getState(details);
    const edge = handle.dataset.edge;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const start = frameRect(frame);
    const limits = sizeLimits(details, state);
    const { viewportWidth, viewportHeight } = viewport();
    const snap = snapTargetsFor(
      details,
      frame,
      e.pointerType === 'mouse' ? SNAP_DISTANCE_PX : SNAP_DISTANCE_COARSE_PX
    );

    setGlobalResizeState(true, HANDLE_CURSORS[edge]);
    frame.classList.add('resizing');
    clearMaximized(details);
    raiseToTop(frame);
    showReadout(details, start, false);
    capturePointer(handle, pointerId);

    let rafId = null;
    let pending = null;
    const flush = () => {
      rafId = null;
      if (pending === null) return;
      applyRect(details, pending.rect);
      showGuides(frame, pending.guides);
      showReadout(details, pending.rect, false);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      pending = resizeFloatingRect({
        start,
        edge,
        dx: ev.clientX - startX,
        dy: ev.clientY - startY,
        ...limits,
        viewportWidth,
        viewportHeight,
        snap
      });
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      if (rafId !== null) { cancelAnimationFrame(rafId); flush(); }
      releasePointer(handle, pointerId);
      setGlobalResizeState(false);
      frame.classList.remove('resizing');
      hideGuides(frame);
      hideReadout(details);
      syncHandles(details);
      if (pending !== null) notifyGeometry(details);
    };
    const signal = state.controller?.signal;
    handle.addEventListener('pointermove', onMove, { signal });
    handle.addEventListener('pointerup', onUp, { signal });
    handle.addEventListener('pointercancel', onUp, { signal });
  }

  /**
   * Give a panel its resize handles, readout and keyboard reach, once.
   *
   * The handles are focusable only while focus is inside the panel, so Tab
   * through the page does not stop eight times at every window.
   *
   * @param {HTMLElement} details
   * @param {AbortSignal} signal
   */
  function ensureResizeHandles(details, signal) {
    const frame = panelFrame(details);
    if (frame === null || handlesOf(frame).length > 0) return;
    for (const edge of RESIZE_EDGES) {
      const handle = document.createElement('div');
      handle.className = 'accordion-resize-handle';
      handle.setAttribute('data-edge', edge);
      handle.setAttribute('role', 'separator');
      if (edge === 'e' || edge === 'w') handle.setAttribute('aria-orientation', 'vertical');
      if (edge === 'n' || edge === 's') handle.setAttribute('aria-orientation', 'horizontal');
      handle.setAttribute('aria-label', `Resize window from its ${HANDLE_NAMES[edge]}`);
      handle.setAttribute(
        'aria-keyshortcuts',
        'ArrowLeft ArrowRight ArrowUp ArrowDown Home End Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown'
      );
      handle.tabIndex = -1;
      handle.addEventListener('pointerdown', e => onHandlePointerdown(details, handle, e), { signal });
      handle.addEventListener('keydown', e => onHandleKeydown(details, handle, e), { signal });
      handle.addEventListener('dblclick', (e) => {
        if (!isFloating(details) || isSheet(frame)) return;
        e.preventDefault();
        fitToContent(details, edge);
      }, { signal });
      handle.addEventListener('focus', () => syncHandles(details), { signal });
      frame.appendChild(handle);
    }
    const readout = document.createElement('div');
    readout.className = 'floating-size-readout';
    readout.setAttribute('aria-hidden', 'true');
    frame.appendChild(readout);

    frame.addEventListener('focusin', () => {
      for (const handle of handlesOf(frame)) handle.tabIndex = 0;
    }, { signal });
    frame.addEventListener('focusout', (e) => {
      if (e.relatedTarget != null && frame.contains(e.relatedTarget)) return;
      for (const handle of handlesOf(frame)) handle.tabIndex = -1;
    }, { signal });
  }

  /**
   * Take back the handles and readout this module put on the panel's frame.
   *
   * `ensureResizeHandles` recognises its handles by their presence, so a panel
   * unregistered with them attached would be re-registered with handles whose
   * listeners had already been aborted.
   *
   * @param {HTMLElement} details
   */
  function removeResizeHandles(details) {
    const frame = panelFrame(details);
    if (frame === null) return;
    for (const handle of handlesOf(frame)) handle.remove();
    readoutOf(frame)?.remove();
  }

  // Drag handler for DOCKED panels (undocking)
  function setupDockedDrag(summary, details, signal) {
    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') return;

      if (isFloating(details)) return;
      const state = getState(details);
      if (!state.dockable) return;
      const frame = panelFrame(details);

      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      const preRect = frame.getBoundingClientRect();
      const title = summary.textContent?.trim() || 'Panel';
      const sidebarRect = sidebar.getBoundingClientRect();

      const offsetX = startX - preRect.left;
      const offsetY = startY - preRect.top;

      let didDrag = false;
      let ghost = null;
      let willDetach = false;

      capturePointer(summary, pointerId);

      function onMove(ev) {
        ev.preventDefault();
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!didDrag) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          didDrag = true;

          setGlobalDragState(true);
          ghost = createGhost(StyleManager, title, preRect.width);
          frame.classList.add('drag-source');
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

        releasePointer(summary, pointerId);

        if (!didDrag) return;

        setGlobalDragState(false);
        frame.classList.remove('drag-source');
        removeGhost(ghost);

        if (willDetach) {
          const targetLeft = ev.clientX - offsetX;
          const targetTop = ev.clientY - offsetY;
          undock(details, targetLeft, targetTop);
          state.suppressNextClick = true;
        }
      }

      summary.addEventListener('pointermove', onMove, { signal });
      summary.addEventListener('pointerup', onUp, { signal });
      summary.addEventListener('pointercancel', onUp, { signal });
    }, { signal });
  }

  // Drag handler for FLOATING panels (re-docking or repositioning). Unlike a
  // docked header, which sits in the scrolling sidebar and must leave a touch
  // drag to the scroll, a floating header has nothing to scroll: a finger moves
  // the panel exactly as a mouse does (`touch-action: none` on the header), and
  // a tap still opens or closes it because a drag shorter than the threshold
  // is not a drag.
  function setupFloatingDrag(summary, details, signal) {
    summary.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;

      if (!isFloating(details)) return;
      const state = getState(details);
      const allowDock = !!state.dockable;
      const frame = panelFrame(details);
      // A phone sheet keeps its place at the bottom; its header only toggles.
      if (isSheet(frame)) return;

      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      const preRect = frame.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const offsetX = startX - preRect.left;
      const offsetY = startY - preRect.top;


      let didDrag = false;
      let baseLeft = state.floatLeft;
      let baseTop = state.floatTop;
      let currentX = baseLeft;
      let currentY = baseTop;
      let rafId = null;
      let lastTransform = '';
      let cachedSidebarRect = null;
      let isHoveringDock = false;

      capturePointer(summary, pointerId);

      function clamp(targetLeft, targetTop) {
        return clampFloatingPosition({
          left: targetLeft,
          top: targetTop,
          width: preRect.width,
          height: preRect.height,
          viewportWidth,
          viewportHeight
        });
      }

      function applyTransform() {
        const clamped = clamp(currentX, currentY);
        const tx = clamped.x - baseLeft;
        const ty = clamped.y - baseTop;
        const newTransform = `translate3d(${tx}px, ${ty}px, 0)`;
        if (newTransform !== lastTransform) {
          lastTransform = newTransform;
          frame.style.transform = newTransform;
        }
        rafId = null;
      }

      function commitPosition() {
        const clamped = clamp(currentX, currentY);
        frame.style.transform = 'translateZ(0)';
        StyleManager.setPosition(frame, { x: clamped.x, y: clamped.y });
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
          raiseToTop(frame);
          clearMaximized(details);
          frame.classList.add('dragging');
          frame.style.willChange = 'transform';
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

        releasePointer(summary, pointerId);

        if (!didDrag) return;

        commitPosition();

        frame.style.willChange = '';
        setGlobalDragState(false);
        frame.classList.remove('dragging');
        if (allowDock) setDockIndicator(false, false);
        state.suppressNextClick = true;

        if (allowDock) {
          const finalSidebarRect = sidebar.getBoundingClientRect();
          if (isInSidebarZone(ev.clientX, ev.clientY, finalSidebarRect)) {
            dock(details);
          }
        }
      }

      summary.addEventListener('pointermove', onMove, { signal });
      summary.addEventListener('pointerup', onUp, { signal });
      summary.addEventListener('pointercancel', onUp, { signal });
    }, { signal });
  }

  return {
    ensureResizeHandles,
    removeResizeHandles,
    setupDockedDrag,
    setupFloatingDrag,
    syncResizeHandles: syncHandles,
    firstControlHeight,
    toggleMaximize,
    moveByKeyboard,
    syncMaximized,
  };
}

