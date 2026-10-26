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

/** The eight places a window is resized from: four edges and four corners. */
export const RESIZE_EDGES = Object.freeze(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);

/**
 * The candidate within `distance` of `value` that lies nearest to it, or null.
 *
 * @param {number} value
 * @param {number[]} candidates
 * @param {number} distance
 * @returns {number|null}
 */
function nearestWithin(value, candidates, distance) {
  let best = null;
  let bestGap = distance;
  for (const candidate of candidates) {
    const gap = Math.abs(candidate - value);
    if (gap <= bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The rectangle a window takes when one of its edges or corners moves.
 *
 * Only the edges named by `edge` move: `e` moves the right edge, `nw` the top
 * and left edges, and so on. A moving edge stops where the window would fall
 * below its minimum size or leave the viewport (less the margin), so the
 * opposite edge never moves. Then, within `snap.distance`, the moving edge
 * lands on the nearest snap line — another window's edge, the sidebar, the
 * middle of the free area — or at a snap size measured from the fixed edge.
 * `guides` names the line it landed on, for the 1 px guide.
 *
 * @param {object} args
 * @param {{left: number, top: number, width: number, height: number}} args.start
 * @param {string} args.edge - One of {@link RESIZE_EDGES}.
 * @param {number} args.dx - Horizontal pointer travel since the start.
 * @param {number} args.dy - Vertical pointer travel since the start.
 * @param {number} args.minWidth
 * @param {number} args.minHeight
 * @param {number} args.viewportWidth
 * @param {number} args.viewportHeight
 * @param {{xs?: number[], ys?: number[], widths?: number[], heights?: number[], distance: number}|null} [args.snap]
 * @returns {{rect: {left: number, top: number, width: number, height: number}, guides: {x: number|null, y: number|null}}}
 */
export function resizeFloatingRect({
  start,
  edge,
  dx,
  dy,
  minWidth,
  minHeight,
  viewportWidth,
  viewportHeight,
  snap = null
}) {
  if (!RESIZE_EDGES.includes(edge)) {
    throw new TypeError(`Unknown resize edge "${edge}"`);
  }
  const lowX = FLOATING_MARGIN;
  const highX = Math.max(lowX, viewportWidth - FLOATING_MARGIN);
  const lowY = FLOATING_MARGIN;
  const highY = Math.max(lowY, viewportHeight - FLOATING_MARGIN);
  let left = start.left;
  let top = start.top;
  let right = start.left + start.width;
  let bottom = start.top + start.height;
  const guides = { x: null, y: null };
  const distance = snap?.distance ?? 0;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

  if (edge.includes('e')) {
    let next = clamp(right + dx, left + minWidth, highX);
    if (distance > 0) {
      const lines = [...(snap.xs ?? []), ...(snap.widths ?? []).map(w => left + w)]
        .filter(x => x >= left + minWidth && x <= highX);
      const snapped = nearestWithin(next, lines, distance);
      if (snapped !== null) { next = snapped; guides.x = snapped; }
    }
    right = next;
  } else if (edge.includes('w')) {
    let next = clamp(left + dx, lowX, right - minWidth);
    if (distance > 0) {
      const lines = [...(snap.xs ?? []), ...(snap.widths ?? []).map(w => right - w)]
        .filter(x => x >= lowX && x <= right - minWidth);
      const snapped = nearestWithin(next, lines, distance);
      if (snapped !== null) { next = snapped; guides.x = snapped; }
    }
    left = next;
  }
  if (edge.includes('s')) {
    let next = clamp(bottom + dy, top + minHeight, highY);
    if (distance > 0) {
      const lines = [...(snap.ys ?? []), ...(snap.heights ?? []).map(h => top + h)]
        .filter(y => y >= top + minHeight && y <= highY);
      const snapped = nearestWithin(next, lines, distance);
      if (snapped !== null) { next = snapped; guides.y = snapped; }
    }
    bottom = next;
  } else if (edge.includes('n')) {
    let next = clamp(top + dy, lowY, bottom - minHeight);
    if (distance > 0) {
      const lines = [...(snap.ys ?? []), ...(snap.heights ?? []).map(h => bottom - h)]
        .filter(y => y >= lowY && y <= bottom - minHeight);
      const snapped = nearestWithin(next, lines, distance);
      if (snapped !== null) { next = snapped; guides.y = snapped; }
    }
    top = next;
  }
  return {
    rect: { left, top, width: right - left, height: bottom - top },
    guides
  };
}

/**
 * The pointer travel an arrow key stands for on a resize handle.
 *
 * An arrow moves the handle in its own direction, along the axes the handle
 * moves on: ArrowRight on the right edge widens, on the left edge narrows.
 * Home shrinks to the minimum and End grows to the viewport; the travel is
 * the viewport size, which the clamp in {@link resizeFloatingRect} cuts to
 * what is possible.
 *
 * @param {string} edge
 * @param {string} key
 * @param {number} step
 * @param {{viewportWidth: number, viewportHeight: number}} viewport
 * @returns {{dx: number, dy: number}|null} null for a key that does not resize.
 */
export function keyboardResizeTravel(edge, key, step, { viewportWidth, viewportHeight }) {
  const horizontal = edge.includes('e') || edge.includes('w');
  const vertical = edge.includes('n') || edge.includes('s');
  const outX = edge.includes('e') ? 1 : -1;
  const outY = edge.includes('s') ? 1 : -1;
  switch (key) {
    case 'ArrowLeft': return horizontal ? { dx: -step, dy: 0 } : null;
    case 'ArrowRight': return horizontal ? { dx: step, dy: 0 } : null;
    case 'ArrowUp': return vertical ? { dx: 0, dy: -step } : null;
    case 'ArrowDown': return vertical ? { dx: 0, dy: step } : null;
    case 'Home':
      return {
        dx: horizontal ? -outX * viewportWidth : 0,
        dy: vertical ? -outY * viewportHeight : 0
      };
    case 'End':
      return {
        dx: horizontal ? outX * viewportWidth : 0,
        dy: vertical ? outY * viewportHeight : 0
      };
    default: return null;
  }
}

/**
 * The rectangle of a maximized window: the free area beside a visible
 * sidebar, inside the margin. When the free area is narrower than the
 * window's minimum, the whole viewport is used.
 *
 * @param {{sidebarRight: number, minWidth: number, viewportWidth: number, viewportHeight: number}} args
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function maximizedFloatingRect({ sidebarRight, minWidth, viewportWidth, viewportHeight }) {
  const besideSidebar = sidebarRight + FLOATING_MARGIN;
  const freeWidth = viewportWidth - besideSidebar - FLOATING_MARGIN;
  const left = sidebarRight > 0 && freeWidth >= minWidth ? besideSidebar : FLOATING_MARGIN;
  return {
    left,
    top: FLOATING_MARGIN,
    width: Math.max(0, viewportWidth - left - FLOATING_MARGIN),
    height: Math.max(0, viewportHeight - 2 * FLOATING_MARGIN)
  };
}

/**
 * Snap lines for resizing one window: the viewport inside the margin, the
 * sidebar's edge and the middle of the free area beside it, and every other
 * window's edges; snap sizes: the sidebar's width and the content's height.
 *
 * @param {object} args
 * @param {number} args.viewportWidth
 * @param {number} args.viewportHeight
 * @param {number} args.sidebarRight - 0 when the sidebar is hidden.
 * @param {number} args.sidebarWidth - 0 when the sidebar is hidden.
 * @param {Array<{left: number, top: number, right: number, bottom: number}>} args.others
 * @param {number} args.contentHeight - The height that shows all content; 0 when unknown.
 * @param {number} args.distance
 * @returns {{xs: number[], ys: number[], widths: number[], heights: number[], distance: number}}
 */
export function floatingSnapTargets({
  viewportWidth,
  viewportHeight,
  sidebarRight,
  sidebarWidth,
  others,
  contentHeight,
  distance
}) {
  const freeLeft = sidebarRight > 0 ? sidebarRight + FLOATING_MARGIN : FLOATING_MARGIN;
  const freeRight = viewportWidth - FLOATING_MARGIN;
  const xs = [FLOATING_MARGIN, freeRight, (freeLeft + freeRight) / 2];
  if (sidebarRight > 0) xs.push(freeLeft);
  const ys = [FLOATING_MARGIN, viewportHeight - FLOATING_MARGIN, viewportHeight / 2];
  for (const other of others) {
    xs.push(other.left, other.right);
    ys.push(other.top, other.bottom);
  }
  return {
    xs,
    ys,
    widths: sidebarWidth > 0 ? [sidebarWidth] : [],
    heights: contentHeight > 0 ? [contentHeight] : [],
    distance
  };
}
