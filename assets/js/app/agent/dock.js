/**
 * @fileoverview Where the agents' dock sits, in one of two layouts.
 *
 * - **Side panel** (`data-layout="side"`): while the chat is open on a
 *   window wide enough to keep a plot beside it ({@link sideLayoutFits}),
 *   the chat is a full-height column on the right, and the plot gives that
 *   width up: `--agent-panel-inline-size` on the root narrows the canvas
 *   (`base/_global.css`), so the viewer lays its views out in what is left
 *   and the chat covers no cell; what is anchored to the window's right
 *   edge (notifications, the camera path's transport, the history tour)
 *   moves in by the same width. The column's left edge is a grip: drag it,
 *   or use ←/→ on it, to set the width (remembered in this browser,
 *   `cellucid:agent-panel-width`); a double click restores the default.
 * - **Bar** (`data-layout="bar"`): the collapsed chat's button, or the open
 *   chat on a narrow window (a phone), along the bottom of the part of the
 *   plot the sidebar does not cover (the viewer's presented area, as the
 *   selection bar is placed), above the selection bar. Its height is
 *   published as `--agent-dock-block-size`, so the notifications, which
 *   share the bottom edge, stack above it.
 *
 * The agents' presence (notices, questions, other agents' activity) goes
 * with the dock: under the chat in the side panel, above it in the bar.
 *
 * While a camera path plays, the open chat in the bar folds to its button,
 * so the film is not played under it, and comes back when the path stops or
 * pauses ({@link chatFoldsForFilm}; the chat applies it, `chat/index.js`). The
 * side panel stays: it covers no cell, and folding it would widen the plot
 * mid-shot.
 *
 * @module app/agent/dock
 */

import { webStorage } from '../../utils/web-storage.js';

/**
 * The side panel's width by default, and the narrowest it gets (CSS
 * pixels): a message, a tool row and the composer's Send fit at 320. Its
 * widest is not a number of its own: half the window, and never so wide
 * that the plot beside it is narrower than {@link PLOT_MIN_WIDTH}.
 */
const PANEL_WIDTH = Object.freeze({ default: 400, min: 320 });

/** The narrowest plot the side panel leaves beside itself and the sidebar. */
const PLOT_MIN_WIDTH = 480;

/** One arrow key on the grip moves the edge this far. */
const KEY_STEP = 24;

const PANEL_WIDTH_STORAGE_KEY = 'cellucid:agent-panel-width';

/**
 * The panel's width for a window: at least its minimum, never more than half
 * the window, and never so wide that the plot beside it and the sidebar is
 * narrower than {@link PLOT_MIN_WIDTH} (widening stops there rather than
 * turning the panel into the bar).
 * @param {number} asked
 * @param {number} windowWidth
 * @param {number} [sidebarWidth] - what the sidebar covers of the window's left
 */
function clampPanelWidth(asked, windowWidth, sidebarWidth = 0) {
  const room = windowWidth - sidebarWidth - PLOT_MIN_WIDTH;
  const max = Math.max(PANEL_WIDTH.min, Math.min(Math.floor(windowWidth / 2), Math.floor(room)));
  const value = Number.isFinite(asked) ? Math.round(asked) : PANEL_WIDTH.default;
  return Math.min(max, Math.max(PANEL_WIDTH.min, value));
}

/**
 * Whether the open chat is a side panel: the window keeps a plot at least
 * {@link PLOT_MIN_WIDTH} wide beside the panel and the sidebar (`sidebarWidth`:
 * what the sidebar covers of the window's left, 0 when it is closed).
 * @param {{windowWidth: number, panelWidth: number, sidebarWidth: number}} sizes
 */
function sideLayoutFits({ windowWidth, panelWidth, sidebarWidth }) {
  return windowWidth - panelWidth - sidebarWidth >= PLOT_MIN_WIDTH;
}

/**
 * Whether the open chat folds to its button while a camera path plays: only
 * as the bar over the plot (`sidePanel` false), and not while the person is
 * writing a message (`drafting`), a question of the chat waits for an answer
 * (`asking`), or the person opened it again during this play (`kept`).
 * @param {{playing: boolean, sidePanel: boolean, drafting: boolean, asking: boolean, kept: boolean}} state
 */
export function chatFoldsForFilm({ playing, sidePanel, drafting, asking, kept }) {
  return playing && !sidePanel && !drafting && !asking && !kept;
}

/**
 * Center the bar in the presented area of one resolved layout.
 * @param {HTMLElement} dock
 * @param {{presentedArea: {cssLeft: number, cssWidth: number}}} layout
 */
function placeAgentDock(dock, layout) {
  const area = layout?.presentedArea;
  if (!area || !Number.isFinite(area.cssLeft) || !Number.isFinite(area.cssWidth) || area.cssLeft < 0 || area.cssWidth <= 0) {
    throw new TypeError('The agent dock is placed in one presented layout.');
  }
  dock.style.setProperty('--agent-dock-left', `${area.cssLeft}px`);
  dock.style.setProperty('--agent-dock-width', `${area.cssWidth}px`);
}

function readWidth(storage) {
  try {
    const value = Number(storage?.getItem(PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : PANEL_WIDTH.default;
  } catch {
    return PANEL_WIDTH.default;
  }
}

function writeWidth(storage, width) {
  try {
    if (width === PANEL_WIDTH.default) storage?.removeItem(PANEL_WIDTH_STORAGE_KEY);
    else storage?.setItem(PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // A browser that keeps no site data: the width lasts for this page.
  }
}

/**
 * @param {{
 *   dock: HTMLElement,
 *   grip: HTMLElement,
 *   sidebar?: HTMLElement|null,
 *   viewer: {onPresentedLayoutChange: (listener: (layout: object) => void) => () => void},
 *   storage?: Storage|null,
 * }} options
 */
export function initAgentDock({ dock, grip, sidebar = null, viewer, storage = webStorage('localStorage') }) {
  if (!(dock instanceof HTMLElement) || !(grip instanceof HTMLElement)) throw new TypeError('The agent dock needs its element and its grip.');
  if (typeof ResizeObserver !== 'function') throw new Error('The agent dock needs ResizeObserver support.');
  const doc = dock.ownerDocument;
  const win = doc.defaultView;
  const root = doc.documentElement;
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  let destroyed = false;
  let asked = readWidth(storage);
  let side = false;

  const sidebarWidth = () => {
    if (sidebar === null || sidebar.classList.contains('hidden')) return 0;
    const box = sidebar.getBoundingClientRect();
    // The phone sheet covers the whole window: it is closed to reach the plot.
    return box.width >= win.innerWidth ? 0 : Math.max(0, box.right);
  };

  const layout = () => {
    if (destroyed) return;
    const covered = sidebarWidth();
    const width = clampPanelWidth(asked, win.innerWidth, covered);
    const open = dock.dataset.chatOpen === 'true';
    side = open && sideLayoutFits({ windowWidth: win.innerWidth, panelWidth: width, sidebarWidth: covered });
    dock.dataset.layout = side ? 'side' : 'bar';
    grip.hidden = !side;
    root.style.setProperty('--agent-panel-width', `${width}px`);
    root.style.setProperty('--agent-panel-inline-size', side ? `${width}px` : '0px');
    grip.setAttribute('aria-valuenow', String(width));
    grip.setAttribute('aria-valuemax', String(clampPanelWidth(Infinity, win.innerWidth, covered)));
    publishBlock();
  };

  const publishBlock = () => {
    if (destroyed) return;
    if (side) {
      root.style.setProperty('--agent-dock-block-size', '0px');
      return;
    }
    const box = dock.getBoundingClientRect();
    const reserved = box.height > 0 ? Math.max(0, root.clientHeight - box.bottom) + box.height : 0;
    root.style.setProperty('--agent-dock-block-size', `${Math.ceil(reserved)}px`);
  };

  const setWidth = width => {
    asked = clampPanelWidth(width, win.innerWidth, sidebarWidth());
    writeWidth(storage, asked);
    layout();
  };

  // The edge follows the pointer as a guide line; the panel and the plot take
  // the new width once, on release (the canvas is resized once, not per frame).
  grip.addEventListener('pointerdown', event => {
    if (!side || event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    dock.dataset.resizing = 'true';
    const covered = sidebarWidth();
    const guideAt = x => {
      const width = clampPanelWidth(win.innerWidth - x, win.innerWidth, covered);
      dock.style.setProperty('--agent-panel-guide', `${width}px`);
      return width;
    };
    let width = guideAt(event.clientX);
    const move = moved => { width = guideAt(moved.clientX); };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      delete dock.dataset.resizing;
      dock.style.removeProperty('--agent-panel-guide');
      setWidth(width);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end, { once: true });
    grip.addEventListener('pointercancel', end, { once: true });
  }, { signal });
  grip.addEventListener('keydown', event => {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const current = clampPanelWidth(asked, win.innerWidth, sidebarWidth());
    if (event.key === 'ArrowLeft') setWidth(current + step);
    else if (event.key === 'ArrowRight') setWidth(current - step);
    else if (event.key === 'Home') setWidth(PANEL_WIDTH.default);
    else return;
    event.preventDefault();
  }, { signal });
  grip.addEventListener('dblclick', () => setWidth(PANEL_WIDTH.default), { signal });

  const observer = new ResizeObserver(publishBlock);
  observer.observe(dock);
  const opened = new MutationObserver(layout);
  opened.observe(dock, { attributes: true, attributeFilter: ['data-chat-open'] });
  const sidebarObserver = sidebar === null ? null : new MutationObserver(layout);
  sidebarObserver?.observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] });
  win.addEventListener('resize', layout, { signal });
  const unsubscribe = viewer.onPresentedLayoutChange(presented => {
    if (destroyed) return;
    placeAgentDock(dock, presented);
    publishBlock();
  });
  layout();
  return {
    /** Whether the open chat stands as the side panel on this window (else as the bar). */
    opensAsSide() {
      const covered = sidebarWidth();
      return sideLayoutFits({ windowWidth: win.innerWidth, panelWidth: clampPanelWidth(asked, win.innerWidth, covered), sidebarWidth: covered });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycle.abort();
      unsubscribe();
      observer.disconnect();
      opened.disconnect();
      sidebarObserver?.disconnect();
      for (const name of ['--agent-dock-block-size', '--agent-panel-width', '--agent-panel-inline-size']) root.style.removeProperty(name);
    },
  };
}
