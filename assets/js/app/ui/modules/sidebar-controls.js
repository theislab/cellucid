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
 * Showing, hiding and resizing the sidebar are actions
 * (`layout.sidebar.show`, `layout.sidebar.width`, provided here): the toggle
 * dispatches, and a resize drag is recorded when it ends.
 *
 * The phone sheet is page chrome, not state (History v2 §3.3.8): on the
 * phone layout the toggle, the peek bar and the H key open and close the
 * sheet and record nothing, and the sidebar shown or hidden (the `layout`
 * state, `isShownChosen`) is not the sheet. An action, an undo or a session
 * changes that choice there without touching the sheet, so Undo pressed
 * inside the sheet never closes it; the choice shows again once the window
 * is wider than the phone layout.
 *
 * @module ui/modules/sidebar-controls
 */

import { rememberPhoneSheet } from '../core/phone-sheet-memory.js';
import { clampSidebarWidthPx } from '../../sidebar-metrics.js';
import { StyleManager } from '../../../utils/style-manager.js';
import { computeLeftOcclusionRatio } from '../../../rendering/viewport-center.js';
import { ActionRefused } from '../../actions/dispatcher.js';

/** The sidebar a reveal is waiting for, and the promise every caller gets. */
let pendingReveal = null;

/**
 * Open the sidebar for a control outside it that leads to one inside it
 * (Data mapping's way to its checklist, a gene sample's way to Genes read
 * for, `?`'s way to the Keyboard shortcuts). It works from the first frame:
 * until the controls below take the phone's peek state over, that state is
 * still the root's mark (`viewport-init.js`), which is dropped so the panel
 * starts open; afterwards the toggle opens it, through the one path that
 * keeps its state, ARIA and the presented area.
 *
 * The toggle asks through an action (`layout.sidebar.show`), so the sidebar
 * opens after this returns, and until it does it is `inert`: a control in it
 * cannot take focus. The promise resolves once the sidebar is shown, and the
 * caller focuses then (found 2026-11-11, lens-a11y: `?` pressed with the
 * sidebar hidden opened the shortcuts but focus never reached them; Genes
 * read for and Data mapping's focus had the same gap). A refused action
 * leaves the sidebar hidden and the promise pending: there is nothing to
 * focus. One reveal waits at a time; a second call shares it.
 *
 * Open the sections to show (a panel, a Session section) once it resolves,
 * not before: a section opened in the same moment reaches the history (its
 * `toggle`, recorded as `layout.section.open`) while the sidebar's action is
 * starting, which keeps it as a change made outside the history (R9K-2).
 *
 * @param {Document} ownerDocument
 * @returns {Promise<void>}
 */
export function revealSidebar(ownerDocument) {
  return showSidebar(ownerDocument);
}

/**
 * Bring something in the sidebar into view, in the one order the history
 * keeps whole: the sidebar shown first (its step, `layout.sidebar.show`),
 * then `open` (the panels and sections to open, the control to focus) once
 * it is. Every way to a control inside the sidebar from outside it takes
 * this path (Genes read for, Data mapping, `?`), so none opens a section in
 * the moment the sidebar's action starts (R9K-2). Resolves with what `open`
 * returns; a refused show leaves it pending, as `revealSidebar`.
 *
 * @template T
 * @param {Document} ownerDocument
 * @param {() => T} open
 * @returns {Promise<T>}
 */
export function revealInSidebar(ownerDocument, open) {
  return showSidebar(ownerDocument).then(() => open());
}

function showSidebar(ownerDocument) {
  const root = ownerDocument.documentElement;
  if (root.dataset.phoneSheet === 'peek') {
    delete root.dataset.phoneSheet;
    rememberPhoneSheet(ownerDocument.defaultView, 'open');
    return Promise.resolve();
  }
  const sidebar = ownerDocument.getElementById('sidebar');
  if (sidebar === null || !sidebar.classList.contains('hidden')) return Promise.resolve();
  if (pendingReveal?.sidebar === sidebar) return pendingReveal.shown;
  const View = ownerDocument.defaultView;
  const shown = new Promise(resolve => {
    const observer = new View.MutationObserver(() => {
      if (sidebar.classList.contains('hidden')) return;
      observer.disconnect();
      pendingReveal = null;
      resolve();
    });
    observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  });
  pendingReveal = { sidebar, shown };
  ownerDocument.getElementById('sidebar-toggle')?.click();
  return shown;
}

export function initSidebarControls({ dom, onViewportOcclusionChange, actions }) {
  if (dom === null || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Sidebar controls require one DOM reference object.');
  }
  for (const method of ['dispatch', 'provide', 'recordObserved']) {
    if (typeof actions?.[method] !== 'function') {
      throw new TypeError(`Sidebar controls require the action dispatcher (${method}).`);
    }
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
    // Taken while the sidebar slides (a toggle, or a window turned from a
    // phone's width to a desktop's, whose hidden sidebar slides to its new
    // place), the area beside it is published again once it has stopped:
    // the slide counts as shown, and a hidden sidebar left the panes beside
    // a gap where it had been (found 2026-11-11: a phone turned sideways kept
    // three panes in 574 of its 844 px, a 270 px empty band at the left).
    if (transitionFrame === 0 && isSidebarTransitionRunning()) {
      transitionFrame = ownerWindow.requestAnimationFrame(awaitSidebarTransitionEnd);
    }
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

  // The phone layout (layouts/_responsive.css): the open sidebar is a sheet
  // over the whole screen.
  const phoneLayout = ownerWindow.matchMedia('(max-width: 720px)');
  const onPhone = () => phoneLayout.matches;
  // Whether this tab left the phone panel open or as the peek bar, kept for
  // the next load of the tab (session storage: never in the address).
  const rememberSheet = () => {
    if (!onPhone()) return;
    rememberPhoneSheet(ownerWindow, sidebar.classList.contains('hidden') ? 'peek' : 'open');
  };

  const handleSidebarToggle = () => {
    if (destroyed) return;
    sidebar.classList.toggle('hidden');
    rememberSheet();
    syncSidebarToggleState();
    publishViewportOcclusion();
    // The slide may start a frame after the class changes: wait for its end.
    if (transitionFrame === 0) {
      transitionFrame = ownerWindow.requestAnimationFrame(
        awaitSidebarTransitionEnd
      );
    }
  };
  const isShown = () => !sidebar.classList.contains('hidden');
  /**
   * The sidebar shown or hidden as the `layout` state holds it. Beside the
   * plot it is what shows; on the phone layout the sheet opens and closes
   * apart from it, and the phone layout starts with it shown.
   */
  let shownChosen = onPhone() ? true : isShown();
  /** Show what was chosen, beside the plot; the phone sheet is left as it is. */
  const showChosen = () => {
    if (!destroyed && !onPhone() && isShown() !== shownChosen) handleSidebarToggle();
  };
  /** Choose the sidebar shown or hidden; false when it already was. */
  const choose = shown => {
    if (destroyed || shownChosen === shown) return false;
    shownChosen = shown;
    showChosen();
    return true;
  };
  /**
   * The toggle, the phone bar and the links that reveal the sidebar: beside
   * the plot they ask through the action (a failure reaches the page's
   * unhandled-rejection report like any other); on the phone layout they
   * open or close the sheet, which is no step.
   */
  const requestShown = shown => {
    if (destroyed) return;
    if (onPhone()) {
      if (isShown() !== shown) handleSidebarToggle();
      return;
    }
    void actions.dispatch('layout.sidebar.show', { shown });
  };
  // Wider than the phone layout again, the sidebar is as it was chosen.
  const handlePhoneLayoutChange = () => showChosen();
  phoneLayout.addEventListener('change', handlePhoneLayoutChange);
  const requestToggle = () => requestShown(!isShown());
  sidebarToggle.addEventListener('click', requestToggle);

  // The phone panel's peek bar: the dataset's name and a handle; a tap or an
  // upward swipe opens the panel.
  const phoneSheetBar = ownerDocument.getElementById('phone-sheet-bar');
  const phoneSheetName = ownerDocument.getElementById('phone-sheet-name');
  const datasetName = ownerDocument.getElementById('dataset-name');
  const openFromBar = () => {
    if (!destroyed && !isShown()) requestShown(true);
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
  /** The width the person or an action chose last, or null while the stylesheet's holds. */
  let chosenWidth = null;
  let resizedWidth = null;

  const finishSidebarResize = () => {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove('resizing');
    ownerDocument.body.style.cursor = '';
    ownerDocument.body.style.userSelect = '';
    ownerDocument.body.style.webkitUserSelect = '';
    // One step per drag, with the width it ended at.
    if (resizedWidth !== null && resizedWidth !== startWidth) {
      void actions.recordObserved('layout.sidebar.width', { width: resizedWidth }, {}, null, { person: true });
    }
    resizedWidth = null;
  };

  const updateSidebarWidth = (width) => {
    const clampedWidth = clampSidebarWidthPx(width);
    chosenWidth = clampedWidth;
    resizedWidth = isResizing ? clampedWidth : null;
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
    // Safari honors only the -webkit- property.
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

  const removeShowAction = actions.provide('layout.sidebar.show', ({ shown }) => (choose(shown) ? { shown } : null));
  const removeWidthAction = actions.provide('layout.sidebar.width', ({ width }) => {
    if (destroyed) return null;
    if (responsiveResizeMedia.matches) {
      throw new ActionRefused('On a window this narrow the sidebar takes the width the screen gives it; widen the window to set it.', {
        code: 'refused',
      });
    }
    const before = chosenWidth;
    updateSidebarWidth(width);
    return chosenWidth === before ? null : { width: chosenWidth };
  });

  return {
    syncSidebarToggleState,
    /**
     * Whether the sidebar is shown (as chosen: on the phone layout, not
     * whether its sheet is open), and its width (the one a person or an
     * action chose, else the stylesheet's).
     */
    describe: () => ({ shown: shownChosen, width: chosenWidth ?? sidebar.offsetWidth }),
    /** Whether the sidebar is shown as the `layout` state holds it (not the phone sheet). */
    isShownChosen: () => shownChosen,
    /**
     * Show or hide the sidebar the way the action does, without a step: what
     * a restore of the `layout` state domain calls (the toggle itself
     * dispatches `layout.sidebar.show`). The phone sheet is left as it is.
     */
    show(shown) {
      choose(shown);
    },
    /** Give the sidebar a width (null: the stylesheet's), without a step: the `layout` domain's restore. */
    setWidth(width) {
      if (destroyed) return;
      if (width === null) {
        chosenWidth = null;
        StyleManager.removeVariable(ownerDocument.documentElement, '--sidebar-user-width');
        publishViewportOcclusion();
        return;
      }
      updateSidebarWidth(width);
    },
    disconnectGeometryObserver() {
      geometryObserver.disconnect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeShowAction();
      removeWidthAction();
      if (transitionFrame !== 0) {
        ownerWindow.cancelAnimationFrame(transitionFrame);
        transitionFrame = 0;
      }
      finishSidebarResize();
      sidebarToggle.removeEventListener('click', requestToggle);
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
      phoneLayout.removeEventListener('change', handlePhoneLayoutChange);
      geometryObserver.disconnect();
    },
  };
}
