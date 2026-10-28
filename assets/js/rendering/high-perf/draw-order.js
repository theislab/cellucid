/**
 * The draw order of a spatial tree, as pure functions of the positions and
 * the tree, so it is computed the same way on the main thread
 * (`SpatialIndex`) and off it (`spatial-tree-worker.js`).
 *
 * The order the GPU stores and draws a geometry's points in is: band (a run
 * of consecutive priority ranks, `drawBands`), then draw unit (a tree leaf,
 * or a coarse node in 1D/2D), then ascending source id. A reduced LOD level
 * is a prefix of it; a run of units is one range per band.
 *
 * ## Levels of detail: fixed counts in priority order
 *
 * A level of detail is the first `m` cells of the **priority order**
 * (`data/cell-priority.js`), the uniform rank of the subsampling
 * specification: rank = the 32-bit hash of (seed, original position), under
 * the file's own seed for a priority-ordered file, else the subsample's seed
 * (the default seed for a whole file Cellucid did not write). So every
 * reduced level is a uniform random sample of the open cells: it draws the
 * cloud's density and its mix of categories as all cells do, up to sampling
 * noise, and nothing about where a cell is decides whether it is drawn. A
 * level of `m` cells draws the `m` cells a uniform subsample of that size
 * with the same seed would open.
 *
 * The level counts are a fixed geometric ladder (`lodLadder`), the same
 * counts whatever the number of open cells, capped by it: 1,000 cells, then
 * each level 5/4 of the one before (rounded down), and last every open cell.
 * A level's cells therefore do not depend on how many cells are open, which
 * is what lets cells be added and removed in place: raising the open cells
 * from `n` to `n'` appends ranks `[n, n')` and adds levels above `n`;
 * lowering them drops the ranks past `n'`; every level below both counts is
 * the same cells either way.
 *
 * Bands are the ladder's steps, each split further at every multiple of
 * `DRAW_BAND_POINTS` (`drawBands`). A band boundary is therefore a fixed
 * rank, and every tree order of the same cells puts exactly the cells of
 * ranks `[start, end)` in the slots `[start, end)` of each band, only in
 * another order. That is what lets a store change order one band at a time
 * while it is drawn (`HighPerfRenderer`, "Store orders").
 *
 * With frustum culling the units in view draw their own share of each band,
 * so a culled level is the same sample restricted to the view.
 */

import { formatCountOf } from '../../utils/format-units.js';
import { buildPriorityOrder } from '../../data/cell-priority.js';

export const LOD_FULL_DETAIL_ADMISSION_LEVEL = 0xff;

/**
 * Depth of the draw units the stored point order is grouped by, per
 * dimension level (see `numberDrawUnits` and `buildDrawOrder`).
 *
 * In 3D the units are the tree's leaves: neighbouring points stored next to
 * each other are drawn next to each other, which with the depth test makes a
 * 10M-point full-detail frame about 4x cheaper than source order.
 *
 * A 1D or 2D view draws without depth and blends every point, and there
 * leaf order is the slowest order there is: with multisampling, points drawn
 * back to back over the same pixels serialize their blends, and leaf order
 * drew 10M 2D points in 300-500 ms against 145-195 ms in source order
 * (Chromium, Apple M1 Pro, harness). So 1D and 2D group points only into 64
 * coarse units (a quadtree at depth 3, a binary tree at depth 6) and keep
 * source order inside each, while frustum culling still draws whole unit
 * ranges. In the app that order draws a 10M-point 2D full-detail frame in
 * 21 ms against 67 ms in source order (no vsync, GPU-bound), so a 2D store
 * adopts it whenever its tree exists, as a 3D store does.
 */
export const DRAW_UNIT_DEPTH_BY_DIMENSION = Object.freeze([0, 6, 3, Infinity]);

/**
 * Number the tree's draw units in traversal (child) order and give every
 * node down to them the half-open range of unit ordinals under it,
 * `[leafStart, leafEnd)`. A subtree is therefore one contiguous run of
 * units, which lets frustum culling emit unit runs without visiting the
 * units of a subtree that is wholly inside. A draw unit is a node at
 * `DRAW_UNIT_DEPTH_BY_DIMENSION[dimension]`, or a leaf above that depth;
 * nodes below a unit are not numbered, and the unit is marked `drawUnit`.
 *
 * @param {object} root - The tree's root node; its nodes are annotated.
 * @param {number} dimensionLevel
 * @returns {object[]} The units, by ordinal.
 */
export function numberDrawUnits(root, dimensionLevel) {
  const unitDepth = DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel];
  const units = [];
  const visit = (node, depth) => {
    node.leafStart = units.length;
    if (node.indices !== null || node.children === null || depth >= unitDepth) {
      if (node.indices !== null && !(node.indices instanceof Uint32Array)) {
        throw new TypeError('Spatial tree leaf membership must be an exact Uint32Array.');
      }
      node.drawUnit = true;
      units.push(node);
    } else if (node.children) {
      node.drawUnit = false;
      for (const child of node.children) {
        if (child) visit(child, depth + 1);
      }
    }
    node.leafEnd = units.length;
  };
  visit(root, 0);
  return units;
}

/**
 * Whether a tree's leaf ids can be read from its draw order: its draw units
 * are its leaves (3D, `DRAW_UNIT_DEPTH_BY_DIMENSION`), so leaf `u`'s cells
 * are, in every band `b`, the order's slots `[leafOffsets[b * (leafCount +
 * 1) + u], leafOffsets[b * (leafCount + 1) + u + 1])`. A 1D or 2D unit is a
 * coarse node whose cells keep source order, so its leaves keep their ids.
 *
 * @param {number} dimensionLevel
 * @returns {boolean}
 */
export function leafIdsFollowDrawOrder(dimensionLevel) {
  return DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel] === Infinity;
}

/**
 * Let go of a tree's leaf ids where its draw order holds them
 * (`leafIdsFollowDrawOrder`): 4 bytes a cell, as many as the order's own
 * indices. Call it once the order is computed (`buildDrawOrder` numbers the
 * leaves from their ids); `forEachLeafRun` reads them from the order after.
 *
 * @param {object} root
 * @param {number} dimensionLevel
 */
export function dropDerivableLeafIds(root, dimensionLevel) {
  if (!leafIdsFollowDrawOrder(dimensionLevel)) return;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    if (node.children === null) {
      if (node.drawUnit !== true) throw new Error('A tree\'s leaf ids are dropped only after its draw order numbered its leaves.');
      node.indices = null;
    } else {
      for (const child of node.children) stack.push(child);
    }
  }
}

/**
 * Visit the cells of one leaf as runs of an array: `visit(array, start,
 * end)` for `array[start..end)`, its own ids in one run, or (ids dropped,
 * `dropDerivableLeafIds`) one run of the draw order's indices per band, in
 * band order, ascending cell within each. A `visit` that returns true stops
 * the walk; the function then returns true.
 *
 * @param {object} leaf
 * @param {{indices: Uint32Array, bandCount: number, leafCount: number, leafOffsets: Uint32Array}|null} drawOrder
 * @param {(array: Uint32Array, start: number, end: number) => boolean|void} visit
 * @returns {boolean} Whether `visit` stopped the walk.
 */
export function forEachLeafRun(leaf, drawOrder, visit) {
  if (leaf.indices !== null) return visit(leaf.indices, 0, leaf.indices.length) === true;
  if (leaf.pointCount === 0) return false;
  if (drawOrder === null || !Number.isSafeInteger(leaf.leafStart)) {
    throw new Error('A leaf without its ids reads them from the draw order that numbered it.');
  }
  const stride = drawOrder.leafCount + 1;
  const offsets = drawOrder.leafOffsets;
  for (let band = 0, at = leaf.leafStart; band < drawOrder.bandCount; band++, at += stride) {
    const start = offsets[at];
    const end = offsets[at + 1];
    if (end > start && visit(drawOrder.indices, start, end) === true) return true;
  }
  return false;
}

/** Cells of the coarsest level of detail (fewer cells open: one level, all of them). */
export const LOD_LADDER_FIRST_COUNT = 1000;

/**
 * Most ranks one band holds: the ladder's steps are split at every multiple
 * of it (`drawBands`). It bounds the work of one step when a store changes
 * order band by band while it is drawn, and the slots a removal of cells
 * rewrites (`HighPerfRenderer#resizeLiveCells`).
 */
export const DRAW_BAND_POINTS = 2 ** 21;

/**
 * The level-of-detail ladder of `pointCount` open cells: each level's cell
 * count, coarse to fine, the last being every cell. The counts are fixed
 * (`LOD_LADDER_FIRST_COUNT`, then 5/4 of the one before, rounded down) and
 * only capped by the open cells, so a level's count, and so its cells, does
 * not depend on how many cells are open (see the module comment).
 *
 * @param {number} pointCount
 * @returns {number[]}
 */
export function lodLadder(pointCount) {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError(`A level-of-detail ladder needs a cell count, not ${pointCount}.`);
  }
  const counts = [];
  for (let count = LOD_LADDER_FIRST_COUNT; count < pointCount; count = Math.floor((count * 5) / 4)) {
    counts.push(count);
  }
  counts.push(pointCount);
  return counts;
}

/**
 * The bands of a draw order over `pointCount` cells: each band's end rank
 * (exclusive), ascending, the last being `pointCount`, and for each level
 * of `lodLadder(pointCount)` the band it ends with. A band boundary is a
 * ladder count or a multiple of `bandPoints`, so it is a fixed rank,
 * whatever the cell count (see the module comment).
 *
 * @param {number} pointCount
 * @param {number} [bandPoints=DRAW_BAND_POINTS]
 * @returns {{bandEnds: Uint32Array, levelBands: Uint8Array, ladder: number[]}}
 */
export function drawBands(pointCount, bandPoints = DRAW_BAND_POINTS) {
  if (!Number.isSafeInteger(bandPoints) || bandPoints <= 0) {
    throw new RangeError(`A draw band holds a positive number of cells, not ${bandPoints}.`);
  }
  const ladder = lodLadder(pointCount);
  const ends = [];
  const levelBands = new Uint8Array(ladder.length);
  let previous = 0;
  for (let level = 0; level < ladder.length; level++) {
    const end = ladder[level];
    for (let split = (Math.floor(previous / bandPoints) + 1) * bandPoints; split < end; split += bandPoints) {
      ends.push(split);
    }
    if (end > previous || ends.length === 0) ends.push(end);
    if (ends.length > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
      throw new RangeError(`A draw order of ${formatCountOf(pointCount, 'cell')} needs more than ${LOD_FULL_DETAIL_ADMISSION_LEVEL} bands.`);
    }
    levelBands[level] = ends.length - 1;
    previous = end;
  }
  return { bandEnds: Uint32Array.from(ends), levelBands, ladder };
}

/**
 * The first rank of the band that holds rank `rank` (a band boundary at or
 * below it): ranks below it are whole bands of every draw order of more
 * than `rank` cells.
 *
 * @param {number} rank
 * @param {number} [bandPoints=DRAW_BAND_POINTS]
 * @returns {number}
 */
export function bandStartAtOrBelow(rank, bandPoints = DRAW_BAND_POINTS) {
  let start = Math.floor(rank / bandPoints) * bandPoints;
  for (let count = LOD_LADDER_FIRST_COUNT; count <= rank; count = Math.floor((count * 5) / 4)) {
    if (count > start) start = count;
  }
  return start;
}

/**
 * Publish the order the GPU draws this tree's points in, as indices into
 * the original-order point buffers.
 *
 * The points are grouped by band, then by draw unit (a leaf, or a coarse
 * node in 1D/2D, see `DRAW_UNIT_DEPTH_BY_DIMENSION`). Band `b` holds the
 * points of priority ranks `[bandEnds[b - 1], bandEnds[b])` (`drawBands`).
 * A reduced level is therefore one prefix (its bands), and within a band one
 * run of consecutive leaves is one contiguous range, so frustum culling
 * draws whole node ranges instead of rewriting per-point indices. Within a
 * unit, points keep ascending source order.
 *
 * `leafOffsets[band * (leafCount + 1) + leaf]` is where `leaf`'s points in
 * `band` start; the leaf's range ends where the next leaf's starts.
 *
 * Without bands there is one: the leaves in order.
 *
 * @param {object} root - The tree's root node (draw units are numbered on it).
 * @param {number} dimensionLevel
 * @param {number} pointCount
 * @param {{bandEnds: Uint32Array, levelBands: Uint8Array}|null} bands - `drawBands(pointCount)`;
 *   null for one band.
 * @param {Uint32Array|null} priorityOrder - The cells in priority order
 *   (`buildPriorityOrder`), consumed (rewritten in place); null when the
 *   open cells are in priority order already (cell `i` has rank `i`), or
 *   without bands.
 * @returns {{
 *   indices: Uint32Array,
 *   bandCount: number,
 *   bandEnds: Uint32Array,
 *   levelBands: Uint8Array|null,
 *   leafCount: number,
 *   leafOffsets: Uint32Array,
 *   pointCount: number,
 * }}
 */
export function buildDrawOrder(root, dimensionLevel, pointCount, bands, priorityOrder) {
  const n = pointCount;
  const leaves = numberDrawUnits(root, dimensionLevel);
  const leafCount = leaves.length;
  const bandEnds = bands === null ? Uint32Array.of(n) : bands.bandEnds;
  const bandCount = bandEnds.length;
  if (bandCount > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
    throw new RangeError(`Draw order supports at most ${LOD_FULL_DETAIL_ADMISSION_LEVEL} bands.`);
  }
  let previousEnd = 0;
  for (let band = 0; band < bandCount; band++) {
    const end = bandEnds[band];
    if (end < previousEnd || end > n || (end === previousEnd && band > 0)) {
      throw new RangeError(`Draw order: band ${band} is not one monotonic run of ranks.`);
    }
    previousEnd = end;
  }
  if (previousEnd !== n) {
    throw new RangeError('Draw order: bands must end with every point.');
  }

  // The band of every point, from its rank.
  let bandOf = null;
  if (bands !== null && bandCount > 1) {
    bandOf = new Uint8Array(n);
    if (priorityOrder === null) {
      let rank = 0;
      for (let band = 0; band < bandCount; band++) {
        bandOf.fill(band, rank, bandEnds[band]);
        rank = bandEnds[band];
      }
    } else {
      if (!(priorityOrder instanceof Uint32Array) || priorityOrder.length !== n) {
        throw new Error('Draw order requires one exact priority order of every point.');
      }
      let rank = 0;
      for (let band = 0; band < bandCount; band++) {
        const end = bandEnds[band];
        for (; rank < end; rank++) bandOf[priorityOrder[rank]] = band;
      }
    }
  }

  // The unit of every point: units are leaves, or the subtrees under a
  // coarse node (see `numberDrawUnits`).
  const unitOf = new Uint32Array(n);
  let placed = 0;
  const assign = (node, unit) => {
    if (node.children === null && node.indices === null && node.pointCount > 0) {
      throw new Error('Draw order: the tree\'s leaf ids follow its published draw order (`dropDerivableLeafIds`); a new order needs a new tree.');
    }
    if (node.indices !== null) {
      const leafIndices = node.indices;
      for (let i = 0; i < leafIndices.length; i++) {
        const id = leafIndices[i];
        if (id >= n) {
          throw new RangeError(`Draw order: leaf contains source ID ${id} outside ${formatCountOf(n, 'point')}.`);
        }
        unitOf[id] = unit;
      }
      placed += leafIndices.length;
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        if (child) assign(child, unit);
      }
    }
  };
  for (let unit = 0; unit < leafCount; unit++) assign(leaves[unit], unit);
  if (placed !== n) {
    throw new Error(`Draw order: leaves own ${placed} source IDs but the dataset contains ${n}.`);
  }

  // Count each unit's points per band, then turn the counts into starts.
  const stride = leafCount + 1;
  const leafOffsets = new Uint32Array(bandCount * stride);
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    leafOffsets[band * stride + unitOf[id] + 1]++;
  }
  for (let band = 0; band < bandCount; band++) {
    const base = band * stride;
    let running = band === 0 ? 0 : bandEnds[band - 1];
    leafOffsets[base] = running;
    for (let unit = 1; unit <= leafCount; unit++) {
      running += leafOffsets[base + unit];
      leafOffsets[base + unit] = running;
    }
    if (running !== bandEnds[band]) {
      throw new Error(`Draw order: units place ${formatCountOf(running, 'point')} in band ${band}, not ${bandEnds[band]}.`);
    }
  }

  // Fill in ascending source order, so each (band, unit) segment holds its
  // points in source order.
  const indices = priorityOrder ?? new Uint32Array(n);
  const cursors = leafOffsets.slice();
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    indices[cursors[band * stride + unitOf[id]]++] = id;
  }

  return {
    indices,
    bandCount,
    bandEnds,
    levelBands: bands === null ? null : bands.levelBands,
    leafCount,
    leafOffsets,
    pointCount: n,
  };
}

/**
 * The whole draw order of a tree: banded (`drawBands`) when it has levels of
 * detail (`buildLOD`), or whenever the open cells are in priority order
 * already (banding them costs nothing then, and every store of them keeps
 * its bands in any order), else one band. Annotates the tree's nodes with
 * their draw-unit ranges.
 *
 * @param {number} pointCount - The points the tree was built over.
 * @param {{bounds: object, root: object}} tree
 * @param {number} dimensionLevel
 * @param {boolean} buildLOD
 * @param {Readonly<{seed: number|null, originals: Uint32Array|null}>} priority - The
 *   cells' priority (`data/cell-priority.js`).
 * @returns {{indices: Uint32Array, bandCount: number, bandEnds: Uint32Array, levelBands: Uint8Array|null, leafCount: number, leafOffsets: Uint32Array, pointCount: number, ranked: boolean}}
 */
export function computeTreeDrawOrder(pointCount, tree, dimensionLevel, buildLOD, priority) {
  const inPriorityOrder = priority.seed === null;
  if (!buildLOD && !inPriorityOrder) return { ...buildDrawOrder(tree.root, dimensionLevel, pointCount, null, null), ranked: false };
  const order = buildDrawOrder(
    tree.root,
    dimensionLevel,
    pointCount,
    drawBands(pointCount),
    inPriorityOrder ? null : buildPriorityOrder(pointCount, priority)
  );
  // Bands by open position: each band's slots hold the cells of its own
  // positions (`ranked`), so a store can take the order band by band.
  return { ...order, ranked: inPriorityOrder };
}

/**
 * The buffers a draw order can be transferred with.
 * @param {{indices: Uint32Array, bandEnds: Uint32Array, leafOffsets: Uint32Array, levelBands: Uint8Array|null}} order
 * @returns {ArrayBuffer[]}
 */
export function drawOrderTransferList(order) {
  const list = [order.indices.buffer, order.bandEnds.buffer, order.leafOffsets.buffer];
  if (order.levelBands !== null) list.push(order.levelBands.buffer);
  return list;
}
