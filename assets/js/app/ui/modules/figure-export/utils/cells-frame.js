/**
 * @fileoverview "Fit the cells": the frame (`crop.js`) that holds every cell a
 * view draws, with a small margin, so the plot takes the cells' shape instead
 * of the pane's. A figure keeps exactly what the screen frames,
 * so a pane narrowed by the chat or a grid gives narrow plots of a wide
 * embedding, the cells in a band with empty space above and below; the frame
 * cuts that space away without the screen being rearranged. It never widens
 * the view: only cells the pane shows count, and the frame stays inside the viewport.
 *
 * For several panels (Export all views) the frame is the union of each
 * panel's, in each panel's own viewport fractions: one frame applies to every
 * panel (`opts.crop`), so none of them loses a cell.
 *
 * @module ui/modules/figure-export/utils/cells-frame
 */

import { readPositionXYZ } from '../../../../../rendering/position-layout.js';
import { MIN_NORM_SIZE } from './crop.js';

/**
 * The margin around the cells, as a share of their extent's larger side on
 * screen: the outermost cells stand clear of the axes.
 */
export const CELLS_FRAME_MARGIN = 0.03;

/**
 * The normalized viewport rectangle (top-left origin) of the cells one view
 * draws: every shown cell (`transparency` above 0) in front of the camera and
 * inside the viewport, each with its sprite's radius, plus
 * `CELLS_FRAME_MARGIN`; clamped to the viewport, never smaller than a frame
 * can be. Null when the view draws no cell.
 *
 * @param {object} view
 * @param {Float32Array} view.positions - `dimension` values a cell
 * @param {number} view.dimension - 1, 2 or 3
 * @param {Uint8Array} view.transparency - 0 for a cell the view hides
 * @param {ArrayLike<number>} view.mvpMatrix - column-major
 * @param {number} view.viewportWidth - px
 * @param {number} view.viewportHeight - px
 * @param {number} view.pointRadius - px: half the sprite the view draws a cell as
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function cellsFrameRect01({ positions, dimension, transparency, mvpMatrix, viewportWidth, viewportHeight, pointRadius }) {
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    throw new TypeError('Fitting the cells needs the view\'s viewport size.');
  }
  if (!(pointRadius >= 0)) throw new TypeError('Fitting the cells needs the cells\' drawn radius.');
  const count = transparency.length;
  if (positions.length !== count * dimension) {
    throw new TypeError('Fitting the cells needs one position a cell.');
  }
  const m = mvpMatrix;
  const p = [0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let cell = 0; cell < count; cell++) {
    if (transparency[cell] === 0) continue;
    readPositionXYZ(positions, dimension, cell, p);
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (!(w > 0) || w === Infinity) continue;
    const ndcX = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    const ndcY = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    const ndcZ = (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w;
    if (!(ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && ndcZ >= -1 && ndcZ <= 1)) continue;
    const x = (ndcX * 0.5 + 0.5) * viewportWidth;
    const y = (0.5 - ndcY * 0.5) * viewportHeight;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  const margin = pointRadius + CELLS_FRAME_MARGIN * Math.max(maxX - minX, maxY - minY);
  return clampedRect01(
    (minX - margin) / viewportWidth,
    (minY - margin) / viewportHeight,
    (maxX + margin) / viewportWidth,
    (maxY + margin) / viewportHeight
  );
}

/** A rectangle from its corners, inside the viewport and at least a frame's least size. */
function clampedRect01(left, top, right, bottom) {
  const grow = (low, high) => {
    let a = Math.max(0, low);
    let b = Math.min(1, high);
    if (b - a < MIN_NORM_SIZE) {
      const middle = (a + b) / 2;
      a = Math.min(Math.max(0, middle - MIN_NORM_SIZE / 2), 1 - MIN_NORM_SIZE);
      b = a + MIN_NORM_SIZE;
    }
    // The size as the frame's check adds it (`crop.js`: origin + size within
    // 1), never a rounding past the viewport's edge.
    let size = b - a;
    while (a + size > 1) size -= Number.EPSILON;
    return [a, size];
  };
  const [x, width] = grow(left, right);
  const [y, height] = grow(top, bottom);
  return { x, y, width, height };
}

/**
 * The union of several views' cell frames (each in its own viewport's
 * fractions), or null when no view draws a cell.
 *
 * @param {Array<{x: number, y: number, width: number, height: number}|null>} frames
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function unionCellsFrames(frames) {
  const drawn = frames.filter(frame => frame !== null);
  if (drawn.length === 0) return null;
  const left = Math.min(...drawn.map(frame => frame.x));
  const top = Math.min(...drawn.map(frame => frame.y));
  const right = Math.max(...drawn.map(frame => frame.x + frame.width));
  const bottom = Math.max(...drawn.map(frame => frame.y + frame.height));
  return clampedRect01(left, top, right, bottom);
}

/**
 * How far a plot's shape may be from its cells' before the preview says so:
 * 1.5, the cells filling at most two thirds of the plot's other side.
 */
export const SHAPE_FAR = 1.5;

/**
 * Whether the figure's panels are far from the shape of the cells they draw:
 * each panel's source aspect (its pane's, or the frame's) against its cells'
 * (the frame that holds them on that pane, `cellsFrameRect01`, in its pane's
 * pixels), and the farthest one's side. A plot takes its pane's shape
 * and the figure fills its width at the height that shape gives
 * (`utils/figure-size.js`), so a narrow pane of a wide embedding is a tall
 * figure with the cells in a band: Fit the cells frames them instead.
 * @param {Array<{source: number, cells: number}>} panels - each panel's source
 *   and cells' width / height
 * @returns {{far: boolean, narrower: boolean, ratio: number}} `ratio`: the
 *   farthest panel's source aspect over its cells' (below 1: the plot is
 *   narrower than its cells, the cells in a band across it)
 */
export function panelShapeAgainstCells(panels) {
  let ratio = 1;
  for (const { source, cells } of panels) {
    if (!(source > 0) || !(cells > 0)) throw new TypeError('A panel\'s shape and its cells\' are positive aspects.');
    const each = source / cells;
    if (Math.max(each, 1 / each) > Math.max(ratio, 1 / ratio)) ratio = each;
  }
  return { far: Math.max(ratio, 1 / ratio) >= SHAPE_FAR, narrower: ratio < 1, ratio };
}
