/**
 * The draw order of a spatial tree, as pure functions of the positions and
 * the tree, so it is computed the same way on the main thread
 * (`SpatialIndex`) and off it (`spatial-tree-worker.js`).
 *
 * The order the GPU stores and draws a geometry's points in is: LOD band
 * (the level that first admits the point), then draw unit (a tree leaf, or a
 * coarse node in 1D/2D), then ascending source id. A reduced LOD level is a
 * prefix of it; a run of units is one range per band.
 */

import { formatCountOf } from '../../utils/format-units.js';

const HIERARCHICAL_RADIX_BITS = 11;
export const HIERARCHICAL_RADIX_SIZE = 1 << HIERARCHICAL_RADIX_BITS;
const HIERARCHICAL_RADIX_MASK = HIERARCHICAL_RADIX_SIZE - 1;
export const LOD_FULL_DETAIL_ADMISSION_LEVEL = 0xff;

/**
 * Quantization bits per axis for the locality code, by dimension level.
 *
 * Every code has to fit one Uint32 so the ordering can be produced by a typed
 * radix sort, which caps the product at 32 bits. Within that cap the finest
 * available grid is the right choice: the grid cell is the unit inside which
 * the ordering has nothing left to say about position, so a coarse grid is a
 * coarse sample. 2D uses the whole budget because 2D embeddings are what
 * projections are almost always viewed in.
 */
export const LOCALITY_BITS_BY_DIMENSION = Object.freeze([0, 30, 16, 10]);

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
 * Interleave one 16-bit coordinate with a single zero between bits (2D Morton).
 *
 * @param {number} coordinate
 * @returns {number}
 */
function spreadPairwise(coordinate) {
  let bits = coordinate & 0xffff;
  bits = (bits | (bits << 8)) & 0x00ff00ff;
  bits = (bits | (bits << 4)) & 0x0f0f0f0f;
  bits = (bits | (bits << 2)) & 0x33333333;
  bits = (bits | (bits << 1)) & 0x55555555;
  return bits >>> 0;
}

/**
 * Interleave one 10-bit coordinate with two zeros between bits (3D Morton).
 *
 * @param {number} coordinate
 * @returns {number}
 */
function spreadTriplewise(coordinate) {
  let bits = coordinate & 0x3ff;
  bits = (bits | (bits << 16)) & 0x030000ff;
  bits = (bits | (bits << 8)) & 0x0300f00f;
  bits = (bits | (bits << 4)) & 0x030c30c3;
  bits = (bits | (bits << 2)) & 0x09249249;
  return bits >>> 0;
}

/**
 * Build a stable hierarchical ordering of all points.
 *
 * Points are ranked so that coarser LOD levels are always strict subsets of
 * finer levels, which is what stops points popping in and out across a level
 * transition. The requirement on top of nesting is that *every* prefix reads
 * as the same cloud at lower density: proportional to the local density
 * everywhere, and carrying no structure of its own.
 *
 * Two steps, in this order.
 *
 * 1. Sort by the plain interleaved Morton code of the quantized position, so
 *    rank is a space-filling-curve walk of the cloud. Rank density along that
 *    walk is exactly point density.
 * 2. Emit ranks in bit-reversed (van der Corput) order. A prefix of that
 *    sequence is an evenly spaced set of *ranks* — every k-th point along the
 *    curve — so it takes the same fraction of points out of every
 *    neighbourhood the curve passes through.
 *
 * Step 2 is the whole fix for the reported square patches, and its absence
 * was the defect. Reversing the bits of the Morton code instead — sorting by
 * `reverse(morton)` — makes the sort key a bijection of the grid cell, so all
 * points of a cell are contiguous and a prefix is a complete set of cells on
 * an axis-aligned sublattice: every point of an admitted cell and none of a
 * skipped one. At 18.1M 2D points and a 44x reduction that is a ~6 px lattice
 * of ~1 px clumps, which is what a viewer sees as blocks with gaps between
 * them. Reversing the *rank* instead decimates along the curve, where the
 * spacing is measured in points rather than in pixels, so nothing lands on a
 * lattice and there is nothing to see.
 *
 * Ties — points sharing a grid cell — keep ascending source order through
 * every stable radix pass, and step 2 spreads a cell's own points across the
 * ladder rather than admitting or dropping them together.
 *
 * Dimension-aware: 1D/2D/3D codes, at the finest per-axis resolution that
 * still fits one Uint32 (see `LOCALITY_BITS_BY_DIMENSION`).
 *
 * @param {Float32Array} positions - `dimensionLevel` components a point.
 * @param {{minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number}} bounds
 * @param {number} dimensionLevel
 * @returns {Uint32Array} Source ids in hierarchical order.
 */
export function buildHierarchicalOrder(positions, bounds, dimensionLevel) {
  const dimLevel = dimensionLevel;
  const n = positions.length / dimLevel;

  const axisBits = LOCALITY_BITS_BY_DIMENSION[dimLevel];
  const axisMaximum = (1 << axisBits) - 1;
  const localityBits = axisBits * dimLevel;
  const scaleX = axisMaximum / Math.max(bounds.maxX - bounds.minX, 0.0001);
  const scaleY = axisMaximum / Math.max(bounds.maxY - bounds.minY, 0.0001);
  const scaleZ = axisMaximum / Math.max(bounds.maxZ - bounds.minZ, 0.0001);

  // Clamping rather than masking: a coordinate exactly at the upper bound can
  // quantize one step past the axis maximum through float rounding, and a
  // mask would wrap that point to the very start of the curve.
  const quantize = (value, minimum, scale) => {
    const bin = Math.floor((value - minimum) * scale);
    return bin < 0 ? 0 : (bin > axisMaximum ? axisMaximum : bin);
  };

  // One priority array plus two ID arrays bounds peak working memory to
  // 12 bytes per point. Initial ascending IDs preserve the stable reference
  // tie order through every least-significant-digit radix pass.
  let priorities = new Uint32Array(n);
  let sourceIds = new Uint32Array(n);
  let targetIds = new Uint32Array(n);
  let radixOffsets = new Uint32Array(HIERARCHICAL_RADIX_SIZE);

  if (dimLevel === 1) {
    for (let pointIndex = 0; pointIndex < n; pointIndex++) {
      const positionOffset = pointIndex;
      priorities[pointIndex] = quantize(
        positions[positionOffset],
        bounds.minX,
        scaleX
      );
      sourceIds[pointIndex] = pointIndex;
    }
  } else if (dimLevel === 2) {
    for (let pointIndex = 0; pointIndex < n; pointIndex++) {
      const positionOffset = pointIndex * 2;
      const x = quantize(positions[positionOffset], bounds.minX, scaleX);
      const y = quantize(positions[positionOffset + 1], bounds.minY, scaleY);
      priorities[pointIndex] =
        (spreadPairwise(x) | (spreadPairwise(y) << 1)) >>> 0;
      sourceIds[pointIndex] = pointIndex;
    }
  } else {
    for (let pointIndex = 0; pointIndex < n; pointIndex++) {
      const positionOffset = pointIndex * 3;
      const x = quantize(positions[positionOffset], bounds.minX, scaleX);
      const y = quantize(positions[positionOffset + 1], bounds.minY, scaleY);
      const z = quantize(positions[positionOffset + 2], bounds.minZ, scaleZ);
      priorities[pointIndex] =
        (
          spreadTriplewise(x)
          | (spreadTriplewise(y) << 1)
          | (spreadTriplewise(z) << 2)
        ) >>> 0;
      sourceIds[pointIndex] = pointIndex;
    }
  }

  // Locality codes are at most 32 bits wide, so three stable 11-bit passes
  // completely order the IDs for every dimension level.
  for (
    let shift = 0;
    shift < localityBits;
    shift += HIERARCHICAL_RADIX_BITS
  ) {
    radixOffsets.fill(0);
    for (let index = 0; index < n; index++) {
      const pointId = sourceIds[index];
      const digit =
        (priorities[pointId] >>> shift) & HIERARCHICAL_RADIX_MASK;
      radixOffsets[digit]++;
    }

    let offset = 0;
    for (
      let digit = 0;
      digit < HIERARCHICAL_RADIX_SIZE;
      digit++
    ) {
      const count = radixOffsets[digit];
      radixOffsets[digit] = offset;
      offset += count;
    }

    for (let index = 0; index < n; index++) {
      const pointId = sourceIds[index];
      const digit =
        (priorities[pointId] >>> shift) & HIERARCHICAL_RADIX_MASK;
      targetIds[radixOffsets[digit]++] = pointId;
    }

    const previousSource = sourceIds;
    sourceIds = targetIds;
    targetIds = previousSource;
  }

  // Step 2. `targetIds` is spent radix scratch of exactly the right length,
  // so the rank permutation is written in place of another N allocation.
  const reversalBits = n <= 1 ? 0 : 32 - Math.clz32(n - 1);
  if (reversalBits > 30) {
    throw new RangeError(
      `Hierarchical ordering supports at most ${formatCountOf((1 << 30), 'point')}.`
    );
  }
  const reversalSpan = 1 << reversalBits;
  const highestBit = reversalSpan >>> 1;
  let rank = 0;
  let emitted = 0;
  for (let step = 0; step < reversalSpan; step++) {
    if (rank < n) targetIds[emitted++] = sourceIds[rank];
    // Increment the bit-reversed counter: carry propagates from the top bit
    // down, which is the mirror image of an ordinary binary increment.
    let carry = highestBit;
    while (carry !== 0 && (rank & carry) !== 0) {
      rank ^= carry;
      carry >>>= 1;
    }
    rank |= carry;
  }
  if (emitted !== n) {
    throw new Error(
      `Hierarchical ordering emitted ${emitted} of ${formatCountOf(n, 'point')}.`
    );
  }

  // Only the final ID generation escapes. Explicitly release all build
  // scratch references. The order is not retained: `buildDrawOrder`
  // rewrites it in place into the draw order the levels are views of.
  const hierarchicalOrder = targetIds;
  priorities = null;
  sourceIds = null;
  targetIds = null;
  radixOffsets = null;
  return hierarchicalOrder;
}

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
    if (node.indices !== null || depth >= unitDepth) {
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
 * Publish the order the GPU draws this tree's points in, as indices into
 * the original-order point buffers.
 *
 * The points are grouped by band, then by draw unit (a leaf, or a coarse
 * node in 1D/2D, see `DRAW_UNIT_DEPTH_BY_DIMENSION`). Band `b` holds the points
 * the hierarchical order first admits at LOD level `b`; the last band holds
 * the full-detail remainder. A reduced level is therefore one prefix (bands
 * `0..b`), and within a band one run of consecutive leaves is one contiguous
 * range, so frustum culling draws whole node ranges instead of rewriting
 * per-point indices. Within a unit, points keep ascending source order.
 *
 * `leafOffsets[band * (leafCount + 1) + leaf]` is where `leaf`'s points in
 * `band` start; the leaf's range ends where the next leaf's starts.
 *
 * Without LOD there is one band: the leaves in order.
 *
 * @param {object} root - The tree's root node (draw units are numbered on it).
 * @param {number} dimensionLevel
 * @param {number} pointCount
 * @param {Uint32Array|null} hierarchy - The hierarchical order, consumed
 *   (rewritten in place); null without LOD.
 * @param {number[]|null} prefixCounts - Each level's point count, coarse to
 *   fine, the last being every point; null without LOD.
 * @returns {{
 *   indices: Uint32Array,
 *   bandCount: number,
 *   bandEnds: Uint32Array,
 *   leafCount: number,
 *   leafOffsets: Uint32Array,
 *   pointCount: number,
 * }}
 */
export function buildDrawOrder(root, dimensionLevel, pointCount, hierarchy, prefixCounts) {
  const n = pointCount;
  const leaves = numberDrawUnits(root, dimensionLevel);
  const leafCount = leaves.length;
  const bandCount = prefixCounts === null ? 1 : prefixCounts.length;
  if (bandCount > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
    throw new RangeError('Draw order supports at most 255 LOD bands.');
  }
  const bandEnds = new Uint32Array(bandCount);
  if (prefixCounts === null) {
    bandEnds[0] = n;
  } else {
    let previous = 0;
    for (let band = 0; band < bandCount; band++) {
      const end = prefixCounts[band];
      if (!Number.isSafeInteger(end) || end < previous || end > n) {
        throw new RangeError(`Draw order: LOD ${band} is not one monotonic prefix.`);
      }
      bandEnds[band] = end;
      previous = end;
    }
    if (previous !== n) {
      throw new RangeError('Draw order: LOD bands must end with every point.');
    }
  }

  // The band of every point, from its rank in the hierarchical order.
  let bandOf = null;
  if (hierarchy !== null) {
    if (!(hierarchy instanceof Uint32Array) || hierarchy.length !== n) {
      throw new Error('Draw order requires one exact full point hierarchy.');
    }
    bandOf = new Uint8Array(n);
    let rank = 0;
    for (let band = 0; band < bandCount; band++) {
      const end = bandEnds[band];
      for (; rank < end; rank++) bandOf[hierarchy[rank]] = band;
    }
  }

  // The unit of every point: units are leaves, or the subtrees under a
  // coarse node (see `_numberLeaves`).
  const unitOf = new Uint32Array(n);
  let placed = 0;
  const assign = (node, unit) => {
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
      throw new Error(`Draw order: units place ${formatCountOf(running, 'point')} in LOD band ${band}, not ${bandEnds[band]}.`);
    }
  }

  // Fill in ascending source order, so each (band, unit) segment holds its
  // points in source order.
  const indices = hierarchy ?? new Uint32Array(n);
  const cursors = leafOffsets.slice();
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    indices[cursors[band * stride + unitOf[id]]++] = id;
  }

  return { indices, bandCount, bandEnds, leafCount, leafOffsets, pointCount: n };
}

/**
 * Point counts of the LOD levels, coarse to fine, the last being every
 * point: 1.25x steps, so a transition is below what a viewer notices.
 */
export const LOD_REDUCTION_FACTORS = Object.freeze([
  44, 35, 28, 23, 18, 14.5, 11.5, 9.3, 7.5, 6, 4.8, 3.8, 3, 2.4, 1.95, 1.55, 1.25, 1,
]);

/**
 * @param {number} pointCount
 * @returns {number[]} Each LOD level's point count, coarse to fine.
 */
export function lodPrefixCounts(pointCount) {
  return LOD_REDUCTION_FACTORS.map(factor => (
    factor === 1
      ? pointCount
      : Math.min(Math.max(1000, Math.ceil(pointCount / factor)), pointCount)
  ));
}

/**
 * The whole draw order of a tree: banded by LOD when `buildLOD`, else one
 * band. Annotates the tree's nodes with their draw-unit ranges.
 *
 * @param {Float32Array} positions
 * @param {{bounds: object, root: object}} tree
 * @param {number} dimensionLevel
 * @param {boolean} buildLOD
 * @returns {{indices: Uint32Array, bandCount: number, bandEnds: Uint32Array, leafCount: number, leafOffsets: Uint32Array, pointCount: number}}
 */
export function computeTreeDrawOrder(positions, tree, dimensionLevel, buildLOD) {
  const pointCount = positions.length / dimensionLevel;
  if (!buildLOD) return buildDrawOrder(tree.root, dimensionLevel, pointCount, null, null);
  const hierarchy = buildHierarchicalOrder(positions, tree.bounds, dimensionLevel);
  return buildDrawOrder(tree.root, dimensionLevel, pointCount, hierarchy, lodPrefixCounts(pointCount));
}

/**
 * The buffers a draw order can be transferred with.
 * @param {{indices: Uint32Array, bandEnds: Uint32Array, leafOffsets: Uint32Array}} order
 * @returns {ArrayBuffer[]}
 */
export function drawOrderTransferList(order) {
  return [order.indices.buffer, order.bandEnds.buffer, order.leafOffsets.buffer];
}
