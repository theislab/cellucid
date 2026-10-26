/**
 * @fileoverview The cell queries behind the drag-selection tools: which cells
 * a lasso encloses, which lie within a proximity radius, and which a k-NN
 * expansion reaches. Each is built once per gesture and then answers every
 * pointer move from what changed since the last one, so a move costs the
 * cells near the change, not a pass over the dataset.
 *
 * - Lasso: the camera is captured when the gesture starts, so every cell is
 *   projected once and bucketed by screen tile. Appending vertex v_n to a
 *   path v_0..v_{n-1} replaces the closing edge (v_{n-1}, v_0) with (v_{n-1},
 *   v_n) and (v_n, v_0); a cell's even-odd parity therefore flips exactly
 *   when the crossing tests of those three edges XOR to one, which can only
 *   happen inside the triangle (v_0, v_{n-1}, v_n). Each move tests the cells
 *   of the tiles that triangle covers, with the very crossing expression the
 *   full even-odd test evaluates, so the result is the full test's result
 *   bit for bit, at any number of vertices.
 * - Proximity: the centre is fixed for the gesture, so every cell's squared
 *   distance is bucketed once by a monotone function of it; a radius change
 *   re-tests only the buckets between the old and the new radius.
 * - k-NN: a breadth-first expansion over the reader worker's adjacency, with
 *   typed frontiers, kept between moves so a deeper degree continues where
 *   the last one stopped.
 *
 * Every pass over the cells runs in slices against a deadline
 * (`prepare(deadline)` / `expandTo(degree, deadline)`), so the caller can
 * keep each main-thread task short and finish the remainder later; a query
 * is answered only once its pass is complete.
 *
 * A cell is selectable only while it is drawn: its transparency byte is at
 * or above POINT_VISIBILITY_THRESHOLD when the query is built. Transparency
 * is updated in place, so a caller rebuilds the query when the view's
 * transparency generation changes.
 *
 * @module rendering/selection-gesture-queries
 */

import { CellSet } from '../app/utils/cell-set.js';
import { POINT_VISIBILITY_THRESHOLD } from './alpha-visibility.js';

/**
 * The longest stretch, in milliseconds, one slice of a selection pass keeps
 * the main thread: half a 60 Hz frame, so input and drawing keep their turn.
 */
export const SELECTION_SLICE_MS = 8;

/** Cells processed between two deadline checks. */
const CELLS_PER_DEADLINE_CHECK = 16_384;

/** Screen tile edge of the lasso's cell buckets, in CSS pixels. */
const LASSO_TILE_PX = 4;

/** Margin, in CSS pixels, around a lasso triangle's rows and columns. */
const LASSO_TILE_MARGIN_PX = 1;

const NOT_A_CANDIDATE = 0xffff_ffff;

function now() {
  return performance.now();
}

function requirePositions(positions, dimensionLevel, label) {
  if (
    !(positions instanceof Float32Array) ||
    !Number.isSafeInteger(dimensionLevel) ||
    dimensionLevel < 1 ||
    dimensionLevel > 3 ||
    positions.length % dimensionLevel !== 0
  ) {
    throw new TypeError(
      `${label} needs Float32Array positions of 1, 2 or 3 components a cell.`
    );
  }
  return positions.length / dimensionLevel;
}

function requireTransparency(transparency, pointCount, label) {
  if (!(transparency instanceof Uint8Array) || transparency.length !== pointCount) {
    throw new TypeError(`${label} needs one Uint8Array transparency byte a cell.`);
  }
  return transparency;
}

function requireDeadline(deadline) {
  if (typeof deadline !== 'number' || Number.isNaN(deadline)) {
    throw new TypeError('A selection pass deadline must be a number (Infinity to finish).');
  }
  return deadline;
}

/**
 * Cells grouped by bucket: `order[start[b] .. start[b + 1]]` are the cells
 * of bucket `b`. Built from a per-cell bucket key in two sliced passes
 * (count, then place).
 */
class CellBuckets {
  constructor(pointCount, bucketCount) {
    this.keys = new Uint32Array(pointCount);
    this.start = new Uint32Array(bucketCount + 1);
    this.order = null;
    this.candidateCount = 0;
    this._fill = null;
    this._placeCursor = 0;
  }

  /** Close the counting pass: turn counts into bucket starts. */
  finishCounting() {
    // start[b + 1] holds bucket b's count; the running sum makes start[b] ..
    // start[b + 1] its range.
    const start = this.start;
    for (let index = 1; index < start.length; index++) start[index] += start[index - 1];
    const total = start[start.length - 1];
    this.candidateCount = total;
    this.order = new Uint32Array(total);
    this._fill = start.slice(0, start.length - 1);
  }

  /** Place cells into `order`; returns true once every cell is placed. */
  place(deadline) {
    const keys = this.keys;
    const order = this.order;
    const fill = this._fill;
    let cell = this._placeCursor;
    while (cell < keys.length) {
      const end = Math.min(keys.length, cell + CELLS_PER_DEADLINE_CHECK);
      for (; cell < end; cell++) {
        const key = keys[cell];
        if (key !== NOT_A_CANDIDATE) order[fill[key]++] = cell;
      }
      if (cell < keys.length && now() >= deadline) {
        this._placeCursor = cell;
        return false;
      }
    }
    this._placeCursor = cell;
    this.keys = null;
    this._fill = null;
    return true;
  }
}

/**
 * The cells a lasso encloses on one pane, under the camera captured when the
 * gesture started.
 *
 * Membership is the even-odd rule over the path's vertices in drawing order
 * (the last vertex joins the first), evaluated on each drawn cell's projected
 * pane-local position, for cells that project in front of the camera
 * (|clip w| >= 1e-10, NDC z in [-1, 1]) and inside the pane's presented
 * rectangle. A path of fewer than three vertices encloses nothing.
 */
export class LassoHitTest {
  /**
   * @param {object} options
   * @param {Float32Array} options.positions - Cell positions, `dimensionLevel` a cell.
   * @param {number} options.dimensionLevel
   * @param {Uint8Array} options.transparency - Drawn cells are >= POINT_VISIBILITY_THRESHOLD.
   * @param {Float32Array} options.mvpMatrix - Column-major projection * view * model.
   * @param {object} options.viewport - The pane: `vpOffsetX`, `vpOffsetY`,
   *   `vpWidth`, `vpHeight` (its full projection rectangle on the canvas) and
   *   `visibleOffsetX`, `visibleOffsetY`, `visibleWidth`, `visibleHeight`
   *   (the part of it the layout presents).
   */
  constructor({ positions, dimensionLevel, transparency, mvpMatrix, viewport }) {
    const pointCount = requirePositions(positions, dimensionLevel, 'Lasso hit test');
    requireTransparency(transparency, pointCount, 'Lasso hit test');
    if (!(mvpMatrix instanceof Float32Array) || mvpMatrix.length !== 16) {
      throw new TypeError('Lasso hit test needs a 16-entry Float32Array MVP matrix.');
    }
    const numbers = [
      'vpOffsetX', 'vpOffsetY', 'vpWidth', 'vpHeight',
      'visibleOffsetX', 'visibleOffsetY', 'visibleWidth', 'visibleHeight',
    ];
    for (const key of numbers) {
      if (!Number.isFinite(viewport?.[key])) {
        throw new TypeError(`Lasso hit test viewport ${key} must be finite.`);
      }
    }
    this.positions = positions;
    this.dimensionLevel = dimensionLevel;
    this.transparency = transparency;
    this.mvp = mvpMatrix;
    this.pointCount = pointCount;
    this.vpOffsetX = viewport.vpOffsetX;
    this.vpOffsetY = viewport.vpOffsetY;
    this.vpWidth = viewport.vpWidth;
    this.vpHeight = viewport.vpHeight;
    // The pane's presented rectangle in pane-local pixels.
    this.visibleMinX = viewport.visibleOffsetX - viewport.vpOffsetX;
    this.visibleMinY = viewport.visibleOffsetY - viewport.vpOffsetY;
    this.visibleMaxX = this.visibleMinX + viewport.visibleWidth;
    this.visibleMaxY = this.visibleMinY + viewport.visibleHeight;
    this.tileColumns = Math.max(1, Math.ceil(viewport.visibleWidth / LASSO_TILE_PX));
    this.tileRows = Math.max(1, Math.ceil(viewport.visibleHeight / LASSO_TILE_PX));
    this._buckets = new CellBuckets(pointCount, this.tileColumns * this.tileRows);
    this._projectCursor = 0;
    this._phase = 'project';
    // Pane-local vertices, in drawing order.
    this._xs = [];
    this._ys = [];
    this._applied = 0;
    this._parity = new CellSet(pointCount);
    this._screen = new Float64Array(2);
  }

  /** True once the projection pass is complete. */
  get ready() {
    return this._phase === 'ready';
  }

  /** Vertices appended so far. */
  get vertexCount() {
    return this._xs.length;
  }

  /**
   * Project `cell` exactly as the full test does; writes pane-local x, y into
   * `this._screen` and returns true when the cell is on the presented pane.
   */
  _project(cell) {
    const mvp = this.mvp;
    const dimension = this.dimensionLevel;
    const positions = this.positions;
    const base = cell * dimension;
    const px = positions[base];
    const py = dimension > 1 ? positions[base + 1] : 0;
    const pz = dimension > 2 ? positions[base + 2] : 0;
    const clipX = mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12];
    const clipY = mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13];
    const clipZ = mvp[2] * px + mvp[6] * py + mvp[10] * pz + mvp[14];
    const clipW = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15];
    if (Math.abs(clipW) < 1e-10) return false;
    const ndcZ = clipZ / clipW;
    if (ndcZ < -1 || ndcZ > 1) return false;
    const screenX = (clipX / clipW + 1) * 0.5 * this.vpWidth;
    const screenY = (1 - clipY / clipW) * 0.5 * this.vpHeight;
    // A point the pane does not present (under the sidebar, or projected past
    // the pane edge into a neighbour's cell) is not on screen there. Written
    // as a negation so a cell without a position (NaN) is off screen too: no
    // crossing test can enclose it.
    if (!(
      screenX >= this.visibleMinX &&
      screenX <= this.visibleMaxX &&
      screenY >= this.visibleMinY &&
      screenY <= this.visibleMaxY
    )) {
      return false;
    }
    this._screen[0] = screenX;
    this._screen[1] = screenY;
    return true;
  }

  /**
   * Advance the projection pass until `deadline` (a `performance.now()`
   * time; Infinity finishes it). Vertices appended meanwhile are applied as
   * soon as it completes.
   *
   * @param {number} deadline
   * @returns {boolean} true when the hit test is ready
   */
  prepare(deadline) {
    requireDeadline(deadline);
    if (this._phase === 'project') {
      const buckets = this._buckets;
      const keys = buckets.keys;
      const counts = buckets.start;
      const transparency = this.transparency;
      const positions = this.positions;
      const dimension = this.dimensionLevel;
      const pointCount = this.pointCount;
      const m = this.mvp;
      const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
      const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
      const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
      const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
      const vpWidth = this.vpWidth;
      const vpHeight = this.vpHeight;
      const minX = this.visibleMinX;
      const minY = this.visibleMinY;
      const maxX = this.visibleMaxX;
      const maxY = this.visibleMaxY;
      const columns = this.tileColumns;
      const lastColumn = columns - 1;
      const lastRow = this.tileRows - 1;
      let cell = this._projectCursor;
      while (cell < pointCount) {
        const end = Math.min(pointCount, cell + CELLS_PER_DEADLINE_CHECK);
        for (; cell < end; cell++) {
          keys[cell] = NOT_A_CANDIDATE;
          if (!(transparency[cell] >= POINT_VISIBILITY_THRESHOLD)) continue;
          // The arithmetic of `_project`, written out for the pass over
          // every cell.
          const base = cell * dimension;
          const px = positions[base];
          const py = dimension > 1 ? positions[base + 1] : 0;
          const pz = dimension > 2 ? positions[base + 2] : 0;
          const clipW = m3 * px + m7 * py + m11 * pz + m15;
          if (Math.abs(clipW) < 1e-10) continue;
          const ndcZ = (m2 * px + m6 * py + m10 * pz + m14) / clipW;
          if (ndcZ < -1 || ndcZ > 1) continue;
          const screenX = ((m0 * px + m4 * py + m8 * pz + m12) / clipW + 1) * 0.5 * vpWidth;
          const screenY = (1 - (m1 * px + m5 * py + m9 * pz + m13) / clipW) * 0.5 * vpHeight;
          if (!(screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY)) {
            continue;
          }
          const column = Math.min(lastColumn, Math.floor((screenX - minX) / LASSO_TILE_PX));
          const row = Math.min(lastRow, Math.floor((screenY - minY) / LASSO_TILE_PX));
          const key = row * columns + column;
          keys[cell] = key;
          counts[key + 1]++;
        }
        if (cell < pointCount && now() >= deadline) {
          this._projectCursor = cell;
          return false;
        }
      }
      this._projectCursor = cell;
      buckets.finishCounting();
      this._phase = 'place';
      if (now() >= deadline) return false;
    }
    if (this._phase === 'place') {
      if (!this._buckets.place(deadline)) return false;
      this._phase = 'ready';
      this._applyPending();
    }
    return true;
  }

  /**
   * Append one vertex in canvas-local CSS pixels (the pane's offset is
   * removed here, as the pointer reports canvas coordinates).
   *
   * @param {number} canvasX
   * @param {number} canvasY
   */
  appendVertex(canvasX, canvasY) {
    if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) {
      throw new TypeError('Lasso vertices must be finite.');
    }
    this._xs.push(canvasX - this.vpOffsetX);
    this._ys.push(canvasY - this.vpOffsetY);
    if (this.ready) this._applyPending();
  }

  _applyPending() {
    while (this._applied < this._xs.length) {
      const n = this._applied;
      if (n > 0) this._applyTriangle(n);
      this._applied = n + 1;
    }
  }

  /**
   * Flip the parity of every cell whose even-odd crossing count changes when
   * vertex `n` is appended to vertices 0 .. n-1.
   */
  _applyTriangle(n) {
    const xs = this._xs;
    const ys = this._ys;
    // a = v_0, b = v_{n-1} (previous last), c = v_n (new last).
    const ax = xs[0], ay = ys[0];
    const bx = xs[n - 1], by = ys[n - 1];
    const cx = xs[n], cy = ys[n];
    const bandMin = Math.min(ay, by, cy) - LASSO_TILE_MARGIN_PX;
    const bandMax = Math.max(ay, by, cy) + LASSO_TILE_MARGIN_PX;
    const minX = this.visibleMinX;
    const minY = this.visibleMinY;
    if (bandMax < minY || bandMin > this.visibleMaxY) return;
    const columns = this.tileColumns;
    const lastColumn = columns - 1;
    const lastRow = this.tileRows - 1;
    const firstRow = Math.max(0, Math.floor((bandMin - minY) / LASSO_TILE_PX));
    const finalRow = Math.min(lastRow, Math.floor((bandMax - minY) / LASSO_TILE_PX));
    const { start, order } = this._buckets;
    const words = this._parity.words;
    const screen = this._screen;
    let sizeChange = 0;
    for (let row = firstRow; row <= finalRow; row++) {
      // The row's cells lie in [rowTop, rowTop + tile) up to rounding; the
      // margin covers that, and a last row also holds cells clamped from
      // the presented rectangle's bottom edge.
      const top = minY + row * LASSO_TILE_PX - LASSO_TILE_MARGIN_PX;
      const bottom = minY + (row + 1) * LASSO_TILE_PX + LASSO_TILE_MARGIN_PX;
      let left = Infinity;
      let right = -Infinity;
      // The x extent of each edge over the row. Outside the union of these
      // extents every crossing test of the three edges agrees with every
      // other's side, so their XOR is zero there.
      for (let edge = 0; edge < 3; edge++) {
        const px = edge === 2 ? cx : ax;
        const py = edge === 2 ? cy : ay;
        const qx = edge === 0 ? bx : (edge === 1 ? cx : bx);
        const qy = edge === 0 ? by : (edge === 1 ? cy : by);
        if (py === qy) continue; // A horizontal edge never crosses.
        const low = Math.max(top, Math.min(py, qy));
        const high = Math.min(bottom, Math.max(py, qy));
        if (low > high) continue;
        const xLow = px + (qx - px) * (low - py) / (qy - py);
        const xHigh = px + (qx - px) * (high - py) / (qy - py);
        left = Math.min(left, xLow, xHigh);
        right = Math.max(right, xLow, xHigh);
      }
      if (left > right) continue;
      const firstColumn = Math.max(
        0,
        Math.floor((left - LASSO_TILE_MARGIN_PX - minX) / LASSO_TILE_PX)
      );
      const finalColumn = Math.min(
        lastColumn,
        Math.floor((right + LASSO_TILE_MARGIN_PX - minX) / LASSO_TILE_PX)
      );
      if (firstColumn > finalColumn) continue;
      const end = start[row * columns + finalColumn + 1];
      for (let k = start[row * columns + firstColumn]; k < end; k++) {
        const cell = order[k];
        this._project(cell);
        const x = screen[0];
        const y = screen[1];
        // The full test's crossing expression, for edges (i, j) taken as
        // (v_0, v_{n-1}), (v_n, v_{n-1}) and (v_0, v_n).
        const closedBefore =
          ((ay > y) !== (by > y)) && (x < (bx - ax) * (y - ay) / (by - ay) + ax);
        const newEdge =
          ((cy > y) !== (by > y)) && (x < (bx - cx) * (y - cy) / (by - cy) + cx);
        const closedAfter =
          ((ay > y) !== (cy > y)) && (x < (cx - ax) * (y - ay) / (cy - ay) + ax);
        if ((closedBefore !== newEdge) !== closedAfter) {
          const word = cell >>> 5;
          const bit = 1 << (cell & 31);
          words[word] ^= bit;
          sizeChange += (words[word] & bit) !== 0 ? 1 : -1;
        }
      }
    }
    this._parity.size += sizeChange;
  }

  /**
   * The enclosed cells, live (the caller copies what it keeps). Only once
   * `ready`.
   *
   * @returns {CellSet}
   */
  hits() {
    if (!this.ready) {
      throw new Error('Lasso hit test is still projecting; call prepare() first.');
    }
    if (this._xs.length < 3) return new CellSet(this.pointCount);
    return this._parity;
  }
}

/**
 * The drawn cells within a radius of a fixed centre: squared Euclidean
 * distance over the cell's components (absent ones read as 0) at most the
 * squared radius, and nothing for a radius of 0.
 */
export class ProximityHitTest {
  /**
   * @param {object} options
   * @param {Float32Array} options.positions
   * @param {number} options.dimensionLevel
   * @param {Uint8Array} options.transparency
   * @param {ArrayLike<number>} options.center - Three finite numbers.
   */
  constructor({ positions, dimensionLevel, transparency, center }) {
    const pointCount = requirePositions(positions, dimensionLevel, 'Proximity hit test');
    requireTransparency(transparency, pointCount, 'Proximity hit test');
    if (
      center === null ||
      typeof center !== 'object' ||
      center.length !== 3 ||
      !Number.isFinite(center[0]) ||
      !Number.isFinite(center[1]) ||
      !Number.isFinite(center[2])
    ) {
      throw new TypeError('Proximity hit test needs a centre of three finite numbers.');
    }
    this.positions = positions;
    this.dimensionLevel = dimensionLevel;
    this.transparency = transparency;
    this.pointCount = pointCount;
    this.cx = center[0];
    this.cy = center[1];
    this.cz = center[2];
    this._phase = 'extent';
    this._cursor = 0;
    this._maximumSquared = 0;
    this._candidates = 0;
    this._buckets = null;
    this._scale = 0;
    this._bucketCount = 0;
    // The squared radius the hits answer; -1 is "radius 0": nothing.
    this._radiusSquared = -1;
    this._pendingRadius = 0;
    this._hits = new CellSet(pointCount);
  }

  get ready() {
    return this._phase === 'ready';
  }

  _distanceSquared(cell) {
    const dimension = this.dimensionLevel;
    const positions = this.positions;
    const base = cell * dimension;
    const dx = positions[base] - this.cx;
    const dy = (dimension > 1 ? positions[base + 1] : 0) - this.cy;
    const dz = (dimension > 2 ? positions[base + 2] : 0) - this.cz;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Bucket of a squared distance: monotone non-decreasing in it. */
  _bucketOf(distanceSquared) {
    if (!(distanceSquared > 0)) return 0;
    return Math.min(
      this._bucketCount - 1,
      Math.floor(Math.sqrt(distanceSquared) * this._scale)
    );
  }

  /**
   * Advance the distance pass until `deadline`; Infinity finishes it.
   *
   * @param {number} deadline
   * @returns {boolean} true when the hit test is ready
   */
  prepare(deadline) {
    requireDeadline(deadline);
    const pointCount = this.pointCount;
    const transparency = this.transparency;
    const positions = this.positions;
    const dimension = this.dimensionLevel;
    const cx = this.cx;
    const cy = this.cy;
    const cz = this.cz;
    if (this._phase === 'extent') {
      let cell = this._cursor;
      let maximum = this._maximumSquared;
      let candidates = this._candidates;
      while (cell < pointCount) {
        const end = Math.min(pointCount, cell + CELLS_PER_DEADLINE_CHECK);
        for (; cell < end; cell++) {
          if (!(transparency[cell] >= POINT_VISIBILITY_THRESHOLD)) continue;
          candidates++;
          // The arithmetic of `_distanceSquared`, written out.
          const base = cell * dimension;
          const dx = positions[base] - cx;
          const dy = (dimension > 1 ? positions[base + 1] : 0) - cy;
          const dz = (dimension > 2 ? positions[base + 2] : 0) - cz;
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          if (distanceSquared > maximum) maximum = distanceSquared;
        }
        if (cell < pointCount && now() >= deadline) break;
      }
      this._cursor = cell;
      this._maximumSquared = maximum;
      this._candidates = candidates;
      if (cell < pointCount) return false;
      // About one cell a bucket, evenly spread over distance.
      this._bucketCount = Math.max(1, candidates);
      this._scale = maximum > 0 ? this._bucketCount / Math.sqrt(maximum) : 0;
      this._buckets = new CellBuckets(pointCount, this._bucketCount);
      this._cursor = 0;
      this._phase = 'key';
      if (now() >= deadline) return false;
    }
    if (this._phase === 'key') {
      const buckets = this._buckets;
      const keys = buckets.keys;
      const counts = buckets.start;
      let cell = this._cursor;
      while (cell < pointCount) {
        const end = Math.min(pointCount, cell + CELLS_PER_DEADLINE_CHECK);
        for (; cell < end; cell++) {
          if (!(transparency[cell] >= POINT_VISIBILITY_THRESHOLD)) {
            keys[cell] = NOT_A_CANDIDATE;
            continue;
          }
          const base = cell * dimension;
          const dx = positions[base] - cx;
          const dy = (dimension > 1 ? positions[base + 1] : 0) - cy;
          const dz = (dimension > 2 ? positions[base + 2] : 0) - cz;
          const key = this._bucketOf(dx * dx + dy * dy + dz * dz);
          keys[cell] = key;
          counts[key + 1]++;
        }
        if (cell < pointCount && now() >= deadline) {
          this._cursor = cell;
          return false;
        }
      }
      this._cursor = cell;
      buckets.finishCounting();
      this._phase = 'place';
      if (now() >= deadline) return false;
    }
    if (this._phase === 'place') {
      if (!this._buckets.place(deadline)) return false;
      this._phase = 'ready';
      this._applyRadius(this._pendingRadius);
    }
    return true;
  }

  /**
   * Set the radius; applied at once when ready, otherwise when the pass
   * completes.
   *
   * @param {number} radius - Finite, non-negative.
   */
  setRadius(radius) {
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError('Proximity radius must be a finite non-negative number.');
    }
    this._pendingRadius = radius;
    if (this.ready) this._applyRadius(radius);
  }

  _applyRadius(radius) {
    const next = radius === 0 ? -1 : radius * radius;
    const previous = this._radiusSquared;
    if (next === previous) return;
    // Only cells with a squared distance in (low, high] change side, and
    // the bucket key is monotone, so they all lie in these buckets.
    const low = Math.min(previous, next);
    const high = Math.max(previous, next);
    const firstBucket = this._bucketOf(low);
    const finalBucket = this._bucketOf(high);
    const { start, order } = this._buckets;
    const words = this._hits.words;
    let sizeChange = 0;
    const end = start[finalBucket + 1];
    for (let k = start[firstBucket]; k < end; k++) {
      const cell = order[k];
      const inside = this._distanceSquared(cell) <= next;
      const word = cell >>> 5;
      const bit = 1 << (cell & 31);
      const was = (words[word] & bit) !== 0;
      if (inside !== was) {
        words[word] ^= bit;
        sizeChange += inside ? 1 : -1;
      }
    }
    this._hits.size += sizeChange;
    this._radiusSquared = next;
  }

  /**
   * The cells within the radius, live (the caller copies what it keeps).
   *
   * @returns {CellSet}
   */
  hits() {
    if (!this.ready) {
      throw new Error('Proximity hit test is still measuring; call prepare() first.');
    }
    return this._hits;
  }
}

function growUint32(buffer, needed) {
  if (needed <= buffer.length) return buffer;
  const grown = new Uint32Array(Math.max(needed, buffer.length * 2));
  grown.set(buffer);
  return grown;
}

/**
 * A breadth-first expansion from one seed cell over the neighbour graph,
 * through drawn cells only: degree d holds the cells at most d hops away.
 * The seed must be drawn, or the expansion is empty.
 *
 * The graph is the edge payload's adjacency (`ConnectivityEdges` of
 * `data/connectivity-edges.js`): a cell's neighbours are one range,
 * `neighbors[neighborOffsets[c] .. neighborOffsets[c + 1]]`.
 *
 * Reached cells are kept in discovery order with the count reached by each
 * degree, so the cells at exactly degree d are one range of that list (the
 * next degree's frontier), and going back to a smaller degree clears only
 * the cells beyond it.
 */
export class KnnExpansion {
  /**
   * @param {object} options
   * @param {import('../data/connectivity-edges.js').ConnectivityEdges} options.graph
   * @param {number} options.seed
   * @param {Uint8Array} options.transparency
   */
  constructor({ graph, seed, transparency }) {
    requireKnnGraph(graph);
    const cellCount = graph.nCells;
    requireTransparency(transparency, cellCount, 'KNN expansion');
    if (!Number.isSafeInteger(seed) || seed < 0 || seed >= cellCount) {
      throw new RangeError(`KNN seed must be a cell in [0, ${cellCount}).`);
    }
    this.graph = graph;
    this.transparency = transparency;
    this.seed = seed;
    this._visited = new CellSet(cellCount);
    // One bit a cell, set while the cell is drawn and not yet reached: the
    // expansion's per-neighbour test is one load from a bitset small enough
    // to stay in the first-level cache (70 KB for 562k cells).
    this._open = new Uint32Array(Math.ceil(cellCount / 32));
    for (let cell = 0; cell < cellCount; cell++) {
      if (transparency[cell] >= POINT_VISIBILITY_THRESHOLD) {
        this._open[cell >>> 5] |= 1 << (cell & 31);
      }
    }
    this._order = new Uint32Array(1);
    this._length = 0;
    // _reachedBy[d]: cells within d hops, for every completed degree d.
    this._reachedBy = [];
    // Position in the frontier (cells at exactly the last completed degree)
    // of an expansion interrupted by its deadline.
    this._cursor = 0;
    this._exhausted = false;
    if ((this._open[seed >>> 5] & (1 << (seed & 31))) !== 0) {
      this._open[seed >>> 5] ^= 1 << (seed & 31);
      this._visited.add(seed);
      this._order[0] = seed;
      this._length = 1;
      this._reachedBy.push(1);
    } else {
      this._reachedBy.push(0);
      this._exhausted = true;
    }
  }

  /** Degrees completed so far (0 is the seed alone). */
  get completedDegree() {
    return this._reachedBy.length - 1;
  }

  /** Forget every cell beyond `degree` hops. */
  _truncate(degree) {
    const keep = this._reachedBy[degree];
    const words = this._visited.words;
    const open = this._open;
    const order = this._order;
    for (let index = keep; index < this._length; index++) {
      const cell = order[index];
      words[cell >>> 5] &= ~(1 << (cell & 31));
      // Reached cells were drawn when reached, so they reopen.
      open[cell >>> 5] |= 1 << (cell & 31);
    }
    this._visited.size = keep;
    this._length = keep;
    this._reachedBy.length = degree + 1;
    this._cursor = 0;
    this._exhausted = this._reachedBy[degree] === 0;
  }

  /**
   * Hold exactly the cells within `degree` hops, expanding until done or
   * until `deadline` passes; Infinity finishes.
   *
   * @param {number} degree
   * @param {number} deadline
   * @returns {boolean} true when the expansion holds `degree`
   */
  expandTo(degree, deadline) {
    if (!Number.isSafeInteger(degree) || degree < 0) {
      throw new RangeError('KNN degree must be a non-negative integer.');
    }
    requireDeadline(deadline);
    // Back to a smaller degree, or the same one with a deeper expansion
    // interrupted part way.
    if (degree <= this.completedDegree && this._length !== this._reachedBy[degree]) {
      this._truncate(degree);
    }
    const { neighborOffsets, neighbors } = this.graph;
    const open = this._open;
    while (this.completedDegree < degree && !this._exhausted) {
      const reachedBy = this._reachedBy;
      const frontierEnd = reachedBy[reachedBy.length - 1];
      const frontierStart = reachedBy.length > 1 ? reachedBy[reachedBy.length - 2] : 0;
      let order = this._order;
      let length = this._length;
      let index = frontierStart + this._cursor;
      let checked = 0;
      for (; index < frontierEnd; index++) {
        const cell = order[index];
        const start = neighborOffsets[cell];
        const end = neighborOffsets[cell + 1];
        const reach = end - start;
        if (length + reach > order.length) order = growUint32(order, length + reach);
        for (let j = start; j < end; j++) {
          const neighbor = neighbors[j];
          const word = neighbor >>> 5;
          const bit = 1 << (neighbor & 31);
          if ((open[word] & bit) === 0) continue;
          open[word] ^= bit;
          order[length++] = neighbor;
        }
        checked += reach;
        if (checked >= CELLS_PER_DEADLINE_CHECK) {
          checked = 0;
          if (index + 1 < frontierEnd && now() >= deadline) {
            index++;
            break;
          }
        }
      }
      // The reached cells' bits, once each.
      const words = this._visited.words;
      for (let index = this._length; index < length; index++) {
        const cell = order[index];
        words[cell >>> 5] |= 1 << (cell & 31);
      }
      this._order = order;
      this._visited.size = length;
      this._length = length;
      if (index < frontierEnd) {
        this._cursor = index - frontierStart;
        return false;
      }
      this._cursor = 0;
      if (length === frontierEnd) {
        // Nothing new: every further degree holds these same cells.
        this._exhausted = true;
        break;
      }
      reachedBy.push(length);
      if (this.completedDegree < degree && now() >= deadline) return false;
    }
    return true;
  }

  /**
   * The cells reached, live (the caller copies what it keeps). Exactly the
   * cells within the degree of the last `expandTo` that returned true.
   *
   * @returns {CellSet}
   */
  cells() {
    return this._visited;
  }
}

/**
 * Check the edge payload's adjacency arrays: their shapes, not their
 * contents (the reader worker built and checked them with the edges).
 *
 * @param {unknown} graph
 * @returns {import('../data/connectivity-edges.js').ConnectivityEdges}
 */
export function requireKnnGraph(graph) {
  const { neighborOffsets, neighbors, nCells } = graph ?? {};
  if (
    !Number.isSafeInteger(nCells) ||
    nCells <= 0 ||
    nCells > 0xffff_ffff ||
    !(neighborOffsets instanceof Uint32Array) ||
    !(neighbors instanceof Uint32Array) ||
    neighborOffsets.length !== nCells + 1 ||
    neighborOffsets[nCells] !== neighbors.length
  ) {
    throw new TypeError(
      'The KNN graph needs the edge payload\'s Uint32 neighbour offsets over its cells and its neighbours.'
    );
  }
  return graph;
}
