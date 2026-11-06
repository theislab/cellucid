/**
 * @fileoverview Where the agents' dock sits: along the bottom of the part of
 * the plot the sidebar does not cover (the viewer's presented area, the
 * rectangle the views are laid out in, as the selection bar is placed),
 * above the selection bar. Its height is published as
 * `--agent-dock-block-size` on the root, so the notifications, which share
 * the bottom edge, stack above it as they do above the selection bar.
 *
 * @module app/agent/dock
 */

/**
 * Centre the dock in the presented area of one resolved layout.
 * @param {HTMLElement} dock
 * @param {{presentedArea: {cssLeft: number, cssWidth: number}}} layout
 */
export function placeAgentDock(dock, layout) {
  const area = layout?.presentedArea;
  if (!area || !Number.isFinite(area.cssLeft) || !Number.isFinite(area.cssWidth) || area.cssLeft < 0 || area.cssWidth <= 0) {
    throw new TypeError('The agent dock is placed in one presented layout.');
  }
  dock.style.setProperty('--agent-dock-left', `${area.cssLeft}px`);
  dock.style.setProperty('--agent-dock-width', `${area.cssWidth}px`);
}

/**
 * @param {{dock: HTMLElement, viewer: {onPresentedLayoutChange: (listener: (layout: object) => void) => () => void}}} options
 */
export function initAgentDock({ dock, viewer }) {
  if (!(dock instanceof HTMLElement)) throw new TypeError('The agent dock needs its element.');
  if (typeof ResizeObserver !== 'function') throw new Error('The agent dock needs ResizeObserver support.');
  const root = dock.ownerDocument.documentElement;
  let destroyed = false;
  const publish = () => {
    if (destroyed) return;
    const box = dock.getBoundingClientRect();
    const reserved = box.height > 0 ? Math.max(0, root.clientHeight - box.bottom) + box.height : 0;
    root.style.setProperty('--agent-dock-block-size', `${Math.ceil(reserved)}px`);
  };
  const observer = new ResizeObserver(publish);
  observer.observe(dock);
  const unsubscribe = viewer.onPresentedLayoutChange(layout => {
    if (destroyed) return;
    placeAgentDock(dock, layout);
    publish();
  });
  publish();
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      observer.disconnect();
      root.style.removeProperty('--agent-dock-block-size');
    },
  };
}
