// Dockable accordions: drag a section header to tear it off into a floating window.
// REDESIGN v2: Drag ghost pattern for zero-lag dragging.

import { clampFloatingPosition, clearOfOpenHeaders } from './dockable-accordions/geometry.js';
import { StyleManager } from '../utils/style-manager.js';
import { isFiniteNumber } from './utils/number-utils.js';
import { createAccordionInteractions } from './dockable-accordions/interactions.js';
import { announceKeyboardMove } from './ui/keyboard-move.js';

const DRAG_THRESHOLD_PX = 6;
const DETACH_DISTANCE_PX = 30;     // Distance from sidebar right edge to detach
const DOCK_HIT_PADDING_PX = 20;
const FLOAT_MIN_WIDTH_PX = 220;
const FLOAT_MIN_HEIGHT_PX = 100;
const FLOAT_MAX_HEIGHT_PX = 500;
const FLOAT_MAX_SCALE = 2;

/**
 * The layer a floating panel takes when there is nothing above it.
 *
 * `--z-layer` is read back off the panels themselves rather than tracked in a
 * counter here. A counter is a private copy of "what is currently on top", and
 * the DOM is the thing that actually holds that: a session restore writes
 * `--z-layer` straight onto the panels it reopens
 * (`session/contributors/dockable-layout.js`), so a counter that only ever
 * counted this module's own calls came back from a restore believing the stack
 * was empty. Every panel torn off after that got a layer below the restored
 * ones and could never be clicked to the front again, because clicking raised
 * it by one from the same stale base.
 */
const FLOAT_BASE_LAYER = 90;

/** `--z-layer` carries a bare integer; anything else is not a layer. */
const LAYER_PATTERN = /^-?(?:0|[1-9]\d*)$/;

/**
 * The layer this element currently declares, or `null` when it declares none.
 *
 * Read from the inline declaration `StyleManager.setLayer()` writes rather than
 * from the computed style, so raising a panel costs no style resolution.
 *
 * @param {Element} element
 * @returns {number|null}
 */
function readLayer(element) {
  const raw = element?.style?.getPropertyValue?.('--z-layer');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!LAYER_PATTERN.test(trimmed)) return null;
  const layer = Number(trimmed);
  return Number.isSafeInteger(layer) ? layer : null;
}

/**
 * The frame a panel stands in.
 *
 * A `<summary>` is itself the disclosure button, so the window controls a panel
 * carries in its header (undock, dock, copy, close) cannot live inside it: a
 * button nested in a button is announced badly, and its clicks and keys reach
 * the toggle as well. They cannot live elsewhere in the `<details>` either,
 * because a closed `<details>` renders nothing but its summary — and a closed
 * panel still has to be undockable, a closed floating panel still dockable.
 *
 * So every panel is a frame: an `.accordion-panel` holding an
 * `.accordion-panel-actions` bar and the `<details>`, with the bar laid over
 * the right end of the summary row (`css/components/_accordion.css`). The frame
 * is the unit that floats — it carries `accordion-floating`, the `--pos-*` box
 * and `--z-layer`, and it is what moves between the sidebar and the floating
 * root. The `<details>` keeps the panel's identity (its id), its open state and
 * its card.
 *
 * The frame is read off the DOM rather than remembered, so nothing here can
 * disagree with what the page shows.
 *
 * @param {HTMLElement} details
 * @returns {HTMLElement|null}
 */
function panelFrame(details) {
  const frame = details?.parentElement ?? null;
  return frame !== null && frame.classList.contains('accordion-panel')
    ? frame
    : null;
}

/**
 * The header action bar of a frame.
 *
 * @param {HTMLElement} frame
 * @returns {HTMLElement|null}
 */
function panelActions(frame) {
  return frame.querySelector(':scope > .accordion-panel-actions');
}

/**
 * Whether this panel is floating.
 *
 * The frame's class is the owner. The stylesheet keys the entire floating
 * presentation off it, and the session contributor reads it as the truth about
 * what is in the floating root (`session/contributors/dockable-layout.js`). A
 * `state.isFloating` field beside it was a second copy of the same fact, and
 * `unregister()` could drop the record while the class stayed on the element —
 * leaving a panel that was visibly floating and that `dock()` refused to bring
 * back, because the copy it consulted had been replaced with a default.
 *
 * @param {HTMLElement} details
 * @returns {boolean}
 */
function isFloating(details) {
  return panelFrame(details)?.classList.contains('accordion-floating') === true;
}

/**
 * Run the frame's own keyframe animation that `className` names, and drop the
 * class once that animation is over.
 *
 * `animationend` bubbles, and the card inside the frame runs a shadow
 * animation of its own, so only an event whose target is the frame itself
 * ends it; a `{ once: true }` listener took whichever event came first, a
 * descendant's included. A cancelled animation (a dock replacing the lift)
 * ends it as well, so the class never outlives the motion it stands for.
 *
 * @param {HTMLElement} frame
 * @param {string} className
 */
function playFrameAnimation(frame, className) {
  frame.classList.add(className);
  const finish = event => {
    if (event.target !== frame) return;
    frame.classList.remove(className);
    frame.removeEventListener('animationend', finish);
    frame.removeEventListener('animationcancel', finish);
  };
  frame.addEventListener('animationend', finish);
  frame.addEventListener('animationcancel', finish);
}

/**
 * Stand a panel in its frame, building the frame the first time.
 *
 * The frame takes the panel's place in the DOM, so a docked panel keeps its
 * position in the sidebar and a window built into the floating root stays
 * there.
 *
 * @param {HTMLElement} details
 * @returns {HTMLElement}
 */
function ensurePanelFrame(details) {
  const existing = panelFrame(details);
  if (existing !== null) {
    if (panelActions(existing) === null) {
      throw new TypeError('Accordion panel frame is missing its header action bar.');
    }
    return existing;
  }
  const parent = details.parentElement;
  if (parent === null) {
    throw new TypeError('An accordion panel must be in the document to be framed.');
  }
  const frame = document.createElement('div');
  frame.className = 'accordion-panel';
  const actions = document.createElement('div');
  actions.className = 'accordion-panel-actions';
  parent.insertBefore(frame, details);
  // The bar comes first so its controls are reached by Tab before the panel's
  // own contents, which can be long; each control names its panel.
  frame.appendChild(actions);
  frame.appendChild(details);
  return frame;
}

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

  // ═══════════════════════════════════════════════════════════════════════════
  // State management
  // ═══════════════════════════════════════════════════════════════════════════

  function getState(details) {
    let state = stateByDetails.get(details);
    if (state) return state;
    state = {
      dockPlaceholder: null,
      dockable: true,
      controller: null,
      widthConstraints: null,
      suppressNextClick: false,
      baseFloatSize: null,
      floatLeft: 0,
      floatTop: 0,
    };
    stateByDetails.set(details, state);
    return state;
  }

  /**
   * The highest layer any *other* floating frame declares.
   *
   * Analysis windows share the floating root with torn-off sidebar panels, so
   * they share one stack; asking the root is what keeps both kinds ordered
   * against each other.
   *
   * @param {Element} exclude
   * @returns {number}
   */
  function highestLayerBelow(exclude) {
    let highest = FLOAT_BASE_LAYER;
    for (const child of floatingRoot.children) {
      if (child === exclude) continue;
      const layer = readLayer(child);
      if (layer !== null && layer > highest) highest = layer;
    }
    return highest;
  }

  /**
   * Put this panel's frame above every other floating frame.
   *
   * A panel that is already above all of them is left untouched, so repeatedly
   * clicking inside the front window writes nothing and the layer numbers stay
   * bounded by the number of panels instead of by the number of clicks.
   *
   * @param {HTMLElement} frame
   */
  function raiseToTop(frame) {
    const highest = highestLayerBelow(frame);
    const current = readLayer(frame);
    if (current !== null && current > highest) return;
    StyleManager.setLayer(frame, highest + 1);
  }

  function panelTitle(summary) {
    const title = summary.textContent?.trim();
    return title && title.length > 0 ? title : 'Panel';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Undock / dock buttons
  //
  // Tearing a panel off used to be reachable only by dragging its header with a
  // mouse, while putting it back was a button — so the affordance existed in
  // one direction and not the other, and the direction that was missing was the
  // one you needed first. Both directions are buttons now. That is what makes
  // the feature reachable by keyboard, by touch, and by anyone who never
  // discovers that a header can be dragged at all.
  //
  // A panel is either docked or floating, so its current state already names
  // the only place it can go: this is the degenerate case of the shared
  // "pick up, aim, drop" grammar (see `ui/keyboard-move.js`) where there is one
  // destination and the control commits on activation.
  //
  // Both buttons live in the frame's header action bar, beside the summary
  // rather than inside it (see `panelFrame`). Which one shows is the
  // stylesheet's call, keyed off the frame's `accordion-floating` class.
  // ═══════════════════════════════════════════════════════════════════════════

  function ensurePanelButton(actions, selector, className, label, signal, onActivate) {
    const existing = actions.querySelector(selector);
    if (existing) return existing;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.addEventListener('click', () => onActivate(), { signal });
    actions.appendChild(btn);
    return btn;
  }

  function removePanelWindowButtons(actions) {
    actions.querySelector('.accordion-dock-btn')?.remove();
    actions.querySelector('.accordion-undock-btn')?.remove();
  }

  function syncPanelWindowButtons(summary, details, actions) {
    const state = getState(details);
    if (!state.dockable) {
      removePanelWindowButtons(actions);
      return;
    }

    // `.accordion-copy-btn` is this app's existing "show this panel as its own
    // floating window" control — the analysis accordions already use it for
    // exactly that, and it carries the ⧉ glyph. `.accordion-undock-btn` is the
    // behavioural hook.
    const signal = state.controller?.signal;
    const title = panelTitle(summary);
    ensurePanelButton(
      actions,
      '.accordion-undock-btn',
      'accordion-copy-btn accordion-undock-btn',
      `Undock ${title} panel into a floating window`,
      signal,
      () => undockFromButton(summary, details)
    );
    ensurePanelButton(
      actions,
      '.accordion-dock-btn',
      'accordion-dock-btn',
      `Dock ${title} panel back into sidebar`,
      signal,
      () => dockFromButton(summary, details)
    );
  }

  function undockFromButton(summary, details) {
    const state = getState(details);
    if (isFloating(details) || !state.dockable) return;
    const frame = panelFrame(details);
    const rect = frame.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    undock(details, sidebarRect.right + 24, rect.top, { besideOpenWindows: true });
    // The control that was activated is hidden now; focus moves to the one
    // that reverses it, in the same bar.
    panelActions(frame)?.querySelector('.accordion-dock-btn')?.focus();
    announceKeyboardMove(
      document,
      `${panelTitle(summary)} is now a floating window. `
      + 'Use the dock button in its header to put it back in the sidebar.'
    );
  }

  function dockFromButton(summary, details) {
    const state = getState(details);
    if (!isFloating(details) || !state.dockable) return;
    dock(details);
    panelActions(panelFrame(details))?.querySelector('.accordion-undock-btn')?.focus();
    announceKeyboardMove(
      document,
      `${panelTitle(summary)} is docked in the sidebar again.`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Undock - runs ONCE on drop, not during drag
  // ═══════════════════════════════════════════════════════════════════════════

  function applyFloatingLayout(details, targetLeft, targetTop, options = {}) {
    // `besideOpenWindows`: a window the user opens now (not one restored to a
    // saved place) keeps clear of the sidebar where the viewport allows and
    // never covers the header of a window already open.
    const { preferredSize = null, constraints = null, besideOpenWindows = false } = options;
    const state = getState(details);
    if (isFloating(details)) return;
    const frame = panelFrame(details);
    if (frame === null) {
      throw new TypeError('Only a registered accordion panel can float.');
    }

    // Where the panel sits right now is what says whether it has a slot to go
    // back to: a docked accordion is a child of the sidebar, and a window built
    // straight into the floating root never had one. Reading that instead of
    // being told it by the caller is what lets a session-restored panel dock
    // back into the position it was torn from — the restore path floats a
    // panel that is standing in the sidebar, and passing "no placeholder"
    // because that path happens to share an entry point with analysis windows
    // dropped the panel at the end of the sidebar the first time it was docked.
    const dockHome = frame.parentElement;
    const hasDockHome = dockHome !== null && dockHome !== floatingRoot;

    // Measuring forces a layout, and both callers that matter — a session
    // restore and an analysis window — already know the geometry they want. So
    // the panel is measured only for the questions its own measurements answer.
    let measuredRect = null;
    const measure = () => {
      if (measuredRect === null) measuredRect = frame.getBoundingClientRect();
      return measuredRect;
    };
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

    const requestedWidth = isFiniteNumber(preferredSize?.width)
      ? preferredSize.width
      : measure().width;
    const naturalHeight = headerHeight + contentScrollHeight + 24;
    const requestedHeight = isFiniteNumber(preferredSize?.height) ? preferredSize.height : naturalHeight;

    // A new window goes beside a visible sidebar, narrowed (never below its
    // minimum) when the viewport leaves less room than it asked for.
    const sidebarRight = besideOpenWindows && !sidebar.classList.contains('hidden')
      ? sidebar.getBoundingClientRect().right
      : 0;
    const roomBesideSidebar = viewportWidth - sidebarRight - 16;
    const widthLimit = roomBesideSidebar >= minWidth
      ? Math.min(viewportMaxWidth, roomBesideSidebar)
      : viewportMaxWidth;

    // Calculate panel dimensions
    const initialWidth = Math.min(
      Math.max(minWidth, requestedWidth),
      Math.min(maxWidth, widthLimit)
    );
    let initialHeight = Math.min(
      Math.max(minHeight, requestedHeight),
      Math.min(maxHeight, viewportMaxHeight)
    );

    // Clamp position through the one owner, so tearing off, dragging and a
    // viewport resize cannot disagree about where a panel may sit.
    const placement = {
      left: besideOpenWindows && roomBesideSidebar >= minWidth
        ? Math.max(targetLeft, sidebarRight + 8)
        : targetLeft,
      top: targetTop,
      width: initialWidth,
      height: initialHeight,
      viewportWidth,
      viewportHeight
    };
    let clampedLeft;
    let clampedTop;
    if (besideOpenWindows) {
      const placed = clearOfOpenHeaders({
        ...placement,
        minHeight,
        headers: [...floatingRoot.querySelectorAll(
          ':scope > .accordion-floating > .accordion-section > summary'
        )].map(header => header.getBoundingClientRect()),
        step: Math.max(headerHeight, 24)
      });
      clampedLeft = placed.x;
      clampedTop = placed.y;
      initialHeight = placed.height;
    } else {
      ({ x: clampedLeft, y: clampedTop } = clampFloatingPosition(placement));
    }
    const contentMaxHeight = Math.max(0, initialHeight - headerHeight - 12);

    // Store position
    state.floatLeft = clampedLeft;
    state.floatTop = clampedTop;

    // Setup placeholder (panels that have a docked slot to hold open)
    if (hasDockHome) {
      if (!state.dockPlaceholder) {
        state.dockPlaceholder = document.createElement('div');
        state.dockPlaceholder.className = 'accordion-dock-placeholder';
      }
      state.dockPlaceholder.style.height = `${measure().height}px`;
      state.dockPlaceholder.hidden = false;
      dockHome.insertBefore(state.dockPlaceholder, frame);
    } else {
      state.dockPlaceholder?.remove();
      state.dockPlaceholder = null;
    }

    // Apply floating styles
    frame.classList.add('accordion-floating');
    StyleManager.setPosition(frame, {
      x: clampedLeft,
      y: clampedTop,
      width: Math.round(initialWidth),
      height: Math.round(initialHeight),
    });
    raiseToTop(frame);
    StyleManager.setVariable(frame, '--floating-content-max-height', `${contentMaxHeight}px`);

    // Set content scroll containment
    if (content) {
      if (contentScrollHeight > contentMaxHeight) {
        content.classList.add('has-overflow');
      }
    }

    // Move to floating root
    floatingRoot.appendChild(frame);
    details.open = true;

    state.baseFloatSize = { width: initialWidth, height: initialHeight };
    state.widthConstraints = {
      min: minWidth,
      max: isFiniteNumber(constraints?.maxWidth) ? constraints.maxWidth : (initialWidth * FLOAT_MAX_SCALE)
    };

    // Trigger lift animation
    playFrameAnimation(frame, 'floating-enter');

    interactions.syncResizeHandles(details, {
      left: clampedLeft,
      width: Math.round(initialWidth)
    });

    if (hasDockHome) {
      // Hide placeholder after layout settles
      requestAnimationFrame(() => {
        if (state.dockPlaceholder) {
          state.dockPlaceholder.hidden = true;
          state.dockPlaceholder.style.height = '';
        }
      });
    }
  }

  function undock(details, targetLeft, targetTop, options = {}) {
    if (isFloating(details)) return;
    if (!getState(details).dockable) return;
    applyFloatingLayout(details, targetLeft, targetTop, options);
  }

  function floatPanel(details, targetLeft, targetTop, options = {}) {
    if (isFloating(details)) return;
    applyFloatingLayout(details, targetLeft, targetTop, options);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dock - return floating panel to sidebar
  // ═══════════════════════════════════════════════════════════════════════════

  function dock(details) {
    if (!isFloating(details)) return;
    const state = getState(details);
    if (!state.dockable) return;

    // Reset content styles
    const content = details.querySelector('.accordion-content');
    if (content) {
      content.style.maxHeight = '';
      content.style.overflowY = '';
      content.style.overflowX = '';
      content.classList.remove('has-overflow');
    }

    // The placeholder *is* the slot: it is the only thing that knows where in
    // the sidebar this panel belongs, so it is asked directly rather than
    // through a remembered parent reference that could outlive it.
    const placeholder = state.dockPlaceholder;
    const parent = placeholder?.parentElement ?? null;
    const accordion = parent?.closest?.('.accordion') || sidebar.querySelector('.accordion');

    const frame = panelFrame(details);
    const targetParent = parent || accordion || sidebar;
    if (targetParent) {
      const beforeNode = placeholder?.parentElement === targetParent ? placeholder : null;
      if (beforeNode) targetParent.insertBefore(frame, beforeNode);
      else targetParent.appendChild(frame);
    }

    placeholder?.remove();
    state.dockPlaceholder = null;

    frame.classList.remove('accordion-floating', 'dragging');
    StyleManager.clearPosition(frame);
    StyleManager.removeVariable(frame, '--z-layer');
    StyleManager.removeVariable(frame, '--floating-content-max-height');

    // Trigger settle animation
    playFrameAnimation(frame, 'dock-settle');
  }

  const interactions = createAccordionInteractions({
    sidebar,
    StyleManager,
    isFiniteNumber,
    getState,
    panelFrame,
    isFloating,
    raiseToTop,
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

  /**
   * Make a panel dockable, floatable and draggable.
   *
   * `options.actions` are the caller's own header controls (an analysis
   * window's copy and close buttons), placed in the frame's header action bar
   * beside the summary. They stay with the frame for its lifetime.
   *
   * @param {HTMLElement} details
   * @param {{ dockable?: boolean, actions?: Element[] }} [options]
   */
  function register(details, options = {}) {
    if (!(details instanceof HTMLElement)) return;
    if (!details.matches?.('details.accordion-section')) return;

    const summary = details.querySelector(':scope > summary');
    if (!summary) return;

    const frame = ensurePanelFrame(details);
    const actions = panelActions(frame);
    for (const action of options.actions ?? []) actions.appendChild(action);

    const state = getState(details);
    state.dockable = options.dockable !== false;

    // One controller per registration owns every listener and every element
    // this module attaches to the panel, so `unregister()` is a real teardown
    // rather than a note that one happened. Before, unregistering dropped the
    // state record and left the handlers installed: the next pointer press on
    // a closing analysis window ran the drag handler, which rebuilt the state
    // record it had just dropped, and the panel stayed draggable — and the
    // rebuilt record held the removed element in this map for good.
    if (state.controller === null) {
      state.controller = new AbortController();
      const { signal } = state.controller;

      // On the frame, so a press on a header action raises its window too.
      frame.addEventListener('pointerdown', () => {
        const s = stateByDetails.get(details);
        if (!s) return;
        // A suppression armed by the previous gesture belongs to that gesture.
        // A cancelled pointer produces no click to consume it, so without this
        // it survived to swallow the user's next real click on the header.
        s.suppressNextClick = false;
        if (!isFloating(details)) return;
        raiseToTop(frame);
      }, { capture: true, signal });

      // Suppress click after drag
      summary.addEventListener('click', (e) => {
        const s = stateByDetails.get(details);
        if (!s?.suppressNextClick) return;
        s.suppressNextClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }, { capture: true, signal });

      // Drag handlers - both check state to determine which behavior to use
      interactions.setupDockedDrag(summary, details, signal);
      interactions.setupFloatingDrag(summary, details, signal);
    }

    syncPanelWindowButtons(summary, details, actions);
    interactions.ensureResizeHandles(details, state.controller.signal);
  }

  function unregister(details) {
    const state = stateByDetails.get(details);
    if (!state) return;
    state.controller?.abort();
    try { state.dockPlaceholder?.remove(); } catch {}
    // The handle and the two window buttons are this module's own elements and
    // carry its listeners; leaving them behind would leave a re-registered
    // panel with controls nothing is listening to. The frame itself stays: a
    // floating panel is floating by its frame, and must still be dockable.
    try { interactions.removeResizeHandles(details); } catch {}
    const frame = panelFrame(details);
    const actions = frame === null ? null : panelActions(frame);
    if (actions !== null) {
      try { removePanelWindowButtons(actions); } catch {}
    }
    stateByDetails.delete(details);
  }

  sidebar.querySelectorAll('details.accordion-section').forEach((details) => {
    register(details, { dockable: true });
  });

  // A floating panel is positioned against the viewport it was placed in. Make
  // the window smaller and it can end up entirely outside the new one, with its
  // header - and so the drag handle, the dock button and the close button - out
  // of reach, leaving no way to recover it but clearing the saved layout. A
  // restore already clamps; a live resize did not, so the same panel was
  // recoverable by reloading and not by resizing back.
  //
  // Panels are re-clamped rather than restored to where they were: the user may
  // have wanted them at an edge, and moving them back on a later resize would
  // fight their placement.
  // This module owns the floating root for the life of the page and exposes no
  // teardown, so the listener is page-scoped too rather than carrying a
  // controller nothing would ever abort.
  // A window resize fires many times per frame; the panels are re-clamped
  // once per frame. Every panel is measured before any is moved, so one
  // panel's write never forces the next panel's read to lay out again.
  let resizeFrame = null;
  window.addEventListener('resize', () => {
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const measured = [];
      for (const frame of [...floatingRoot.children]) {
        const details = frame.querySelector(':scope > details.accordion-section');
        const state = details === null ? undefined : stateByDetails.get(details);
        if (!state) continue;
        measured.push({ frame, state, rect: frame.getBoundingClientRect() });
      }
      for (const { frame, state, rect } of measured) {
        const clamped = clampFloatingPosition({
          left: state.floatLeft,
          top: state.floatTop,
          width: rect.width,
          height: rect.height,
          viewportWidth,
          viewportHeight
        });
        if (clamped.x === state.floatLeft && clamped.y === state.floatTop) continue;
        state.floatLeft = clamped.x;
        state.floatTop = clamped.y;
        StyleManager.setPosition(frame, { x: clamped.x, y: clamped.y });
      }
    });
  });

  return {
    dock,
    undock: (details) => {
      const rect = panelFrame(details).getBoundingClientRect();
      undock(details, rect.left, rect.top);
    },
    float: (details, leftOrOptions, top, options = {}) => {
      // Measuring is a forced layout, so it happens only for a coordinate the
      // caller did not supply. A restore and an analysis window both supply
      // both, and neither should pay for a measurement it throws away.
      let measuredRect = null;
      const measure = () => {
        if (measuredRect === null) measuredRect = panelFrame(details).getBoundingClientRect();
        return measuredRect;
      };
      if (isFiniteNumber(leftOrOptions)) {
        floatPanel(
          details,
          leftOrOptions,
          isFiniteNumber(top) ? top : measure().top,
          options
        );
        return;
      }
      const opts = leftOrOptions && typeof leftOrOptions === 'object' ? leftOrOptions : {};
      floatPanel(
        details,
        isFiniteNumber(opts.left) ? opts.left : measure().left,
        isFiniteNumber(opts.top) ? opts.top : measure().top,
        opts
      );
    },
    register,
    unregister,
    panelFrame,
    floatingRoot
  };
}
