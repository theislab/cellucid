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
const FLOATING_MARGIN = 8;

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

/**
 * Place a new window so it covers no open window's header.
 *
 * Every window opened at one spot: a panel torn off beside its row and an
 * analysis window opened from a row a little above it landed on each other,
 * and the newer one covered the older one's header, where its dock, copy and
 * close buttons are. The new window steps down and to the right one header
 * at a time. On a short screen, where clamping stops the walk, it starts
 * under the lowest header it would cover and is made shorter to fit, as long
 * as it keeps its minimum height; otherwise the last position is used.
 *
 * @param {object} box - As for {@link clampFloatingPosition}, plus:
 * @param {Array<{left: number, top: number, right: number, bottom: number}>} box.headers
 *   Header rectangles of the windows already open.
 * @param {number} box.step - The distance of one step, in pixels.
 * @param {number} box.minHeight - The least height the window may shrink to
 *   (never below one step).
 * @returns {{x: number, y: number, height: number}}
 */
export function clearOfOpenHeaders({
  left,
  top,
  width,
  height,
  minHeight,
  viewportWidth,
  viewportHeight,
  headers,
  step
}) {
  if (!Array.isArray(headers) || !(step > 0) || !(minHeight >= 0)) {
    throw new TypeError(
      'Window placement requires the open headers, a positive step and a minimum height'
    );
  }
  const clamp = (x, y, h) => clampFloatingPosition({
    left: x, top: y, width, height: h, viewportWidth, viewportHeight
  });
  const covered = ({ x, y }, h) => headers.filter(header =>
    x < header.right && x + width > header.left
    && y < header.bottom && y + h > header.top
  );
  let position = clamp(left, top, height);
  for (let attempt = 0; attempt < 16 && covered(position, height).length > 0; attempt += 1) {
    const next = clamp(position.x + step, position.y + step, height);
    if (next.x === position.x && next.y === position.y) break;
    position = next;
  }
  const stillCovered = covered(position, height);
  if (stillCovered.length === 0) return { ...position, height };
  const below = Math.max(...stillCovered.map(header => header.bottom)) + FLOATING_MARGIN;
  const room = viewportHeight - below - FLOATING_MARGIN;
  // Never shorter than one header, whatever the window's own minimum.
  if (room < Math.max(minHeight, step)) return { ...position, height };
  return { x: position.x, y: below, height: Math.min(height, room) };
}
