/**
 * @fileoverview Where a floating panel is allowed to sit.
 *
 * Three places need this answer: tearing a panel off, dragging it, and the
 * viewport changing size underneath it. The first two each had their own copy
 * of the arithmetic, which is how they could have come to disagree about
 * whether a panel is reachable.
 *
 * @module dockable-accordions/geometry
 */

/**
 * How much of a panel must remain inside the viewport, in pixels.
 *
 * The header carries the drag handle and the dock and close buttons, so a panel
 * whose header cannot be reached cannot be moved, docked, or closed. This margin
 * is what keeps it recoverable.
 */
export const FLOATING_MARGIN = 8;

/**
 * Clamp a floating panel's top-left so its header stays reachable.
 *
 * When the viewport is smaller than the panel the maximum collapses to the
 * margin itself, which keeps the top-left corner - and therefore the header -
 * on screen rather than pushing it off the opposite edge.
 *
 * @param {object} box
 * @param {number} box.left
 * @param {number} box.top
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.viewportWidth
 * @param {number} box.viewportHeight
 * @returns {{x: number, y: number}}
 */
export function clampFloatingPosition({
  left,
  top,
  width,
  height,
  viewportWidth,
  viewportHeight
}) {
  const maxLeft = Math.max(FLOATING_MARGIN, viewportWidth - width - FLOATING_MARGIN);
  const maxTop = Math.max(FLOATING_MARGIN, viewportHeight - height - FLOATING_MARGIN);
  return {
    x: Math.min(Math.max(left, FLOATING_MARGIN), maxLeft),
    y: Math.min(Math.max(top, FLOATING_MARGIN), maxTop)
  };
}
