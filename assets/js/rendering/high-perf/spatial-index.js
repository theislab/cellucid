/**
 * Unified 1D/2D/3D spatial index for LOD and frustum culling.
 *
 * Moved verbatim out of high-perf-renderer.js. Depends on the renderer
 * contracts and on notification settlement; the renderer depends on it. The
 * dependency is strictly one-directional -- nothing in this module references
 * HighPerfRenderer.
 */
import { getNotificationCenter } from '../../app/notification-center.js';
import {
  requireDimensionLevel,
  requireFiniteNumber,
  requireNumericVector,
} from './renderer-contracts.js';
import {
  describeError,
  settleCalculationNotification,
} from './calculation-notifications.js';

const HIERARCHICAL_RADIX_BITS = 11;
const HIERARCHICAL_RADIX_SIZE = 1 << HIERARCHICAL_RADIX_BITS;
const HIERARCHICAL_RADIX_MASK = HIERARCHICAL_RADIX_SIZE - 1;
const LOD_MAPPING_SENTINEL = 0xffffffff;
const LOD_MAPPING_VISITED_BIT = 0x80000000;
const LOD_FULL_DETAIL_ADMISSION_LEVEL = 0xff;

/**
 * The point count an adaptive LOD level is allowed to fall to.
 *
 * Adaptive selection is a frame-rate control, not a data-reduction policy, so
 * its coarsest useful answer is a point budget rather than a ratio. A fixed
 * ratio is what made a large dataset unusable: at 18.1M cells the coarsest
 * ladder step is a 44x reduction, which the selector reaches on any pull-back
 * and which discards 97.7% of the cells whether or not the frame needed it. A
 * budget stops at the point where drawing is already comfortable and no
 * further reduction buys anything a viewer can see, and it scales itself: a
 * dataset under the budget is never reduced by adaptive selection at all,
 * which is the correct answer for one that already draws in a single frame.
 *
 * The forced-level slider is deliberately not bounded by this. Asking for a
 * coarser level explicitly is a legitimate request on hardware that needs it.
 */
const ADAPTIVE_LOD_POINT_BUDGET = 2_000_000;

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
const LOCALITY_BITS_BY_DIMENSION = Object.freeze([0, 30, 16, 10]);

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
// ============================================================================
// SPATIAL INDEX FOR LOD AND FRUSTUM CULLING (1D/2D/3D)
// ============================================================================

/**
 * Unified spatial index that adapts to data dimensionality:
 * - 1D: Binary tree (2 children) - for 1D layouts/histograms
 * - 2D: Quadtree (4 children) - for 2D projections (UMAP, t-SNE)
 * - 3D: Octree (8 children) - for 3D embeddings (PCA, etc.)
 *
 * Enables frustum culling and spatially-uniform LOD sampling in the
 * appropriate dimension space.
 */
export class SpatialIndex {
  /**
   * @param {Float32Array} positions - Position data (x,y,z per point)
   * @param {Uint8Array} colors - RGBA color data
   * @param {number} dimensionLevel - 1, 2, or 3 for tree type
   * @param {number} maxPointsPerNode - Max points before subdivision
   * @param {number} maxDepth - Maximum tree depth
   * @param {Object} options
   * @param {boolean} options.buildLOD - Whether to generate LOD levels.
   * @param {boolean} options.buildLodNodeMappings - Whether to precompute per-node LOD index mappings for fast LOD+frustum culling.
   * @param {boolean} options.computeNodeStats - Whether to compute node centroid/avgColor/avgAlpha.
   */
  constructor(positions, colors, dimensionLevel, maxPointsPerNode, maxDepth, options) {
    if (
      !(positions instanceof Float32Array) ||
      positions.length === 0 ||
      positions.length % 3 !== 0
    ) {
      throw new TypeError(
        'SpatialIndex positions must be a non-empty Float32Array with exactly three values per point.'
      );
    }
    const pointCount = positions.length / 3;
    if (!Number.isInteger(maxPointsPerNode) || maxPointsPerNode <= 0) {
      throw new TypeError('SpatialIndex maxPointsPerNode must be a positive integer.');
    }
    if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
      throw new TypeError('SpatialIndex maxDepth must be a positive integer.');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('SpatialIndex options must be an object.');
    }
    const { buildLOD, buildLodNodeMappings, computeNodeStats } = options;
    if (
      typeof buildLOD !== 'boolean' ||
      typeof buildLodNodeMappings !== 'boolean' ||
      typeof computeNodeStats !== 'boolean'
    ) {
      throw new TypeError(
        'SpatialIndex buildLOD, buildLodNodeMappings, and computeNodeStats options must be booleans.'
      );
    }
    if (
      colors !== null &&
      (
        !(colors instanceof Uint8Array) ||
        colors.length !== pointCount * 4
      )
    ) {
      throw new TypeError(
        `SpatialIndex colors must be null or an RGBA Uint8Array with exactly ${pointCount * 4} bytes.`
      );
    }
    if (colors === null && computeNodeStats) {
      throw new TypeError(
        'SpatialIndex colors are required when computeNodeStats is enabled.'
      );
    }

    this._buildLOD = buildLOD;
    this._computeNodeStats = computeNodeStats;
    this._lodNodeMappingsBuilt = false;
    this._lodNodeMapping = null;
    this._buildLodNodeMappings = buildLodNodeMappings;
    // Built lazily only when a CPU consumer needs random-access LOD
    // membership (highlights, connectivity, or export). All reduced LODs are
    // nested prefixes of `_hierarchicalOrder`, so one byte per source point is
    // sufficient for every level and every view sharing this spatial owner.
    this._lodMembershipOwner = null;
    // The coarsest level adaptive selection may return, published by
    // `_generateLODLevels`. Zero imposes no bound, which is unreachable before
    // generation: `getLODLevel` answers -1 while there is no inventory.
    this._adaptiveMinimumLevel = 0;

    this.maxPointsPerNode = maxPointsPerNode;
    this.maxDepth = maxDepth;
    this.positions = positions;
    this.colors = colors;
    this.dimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'SpatialIndex dimensionLevel'
    );
    this.childCount = 1 << this.dimensionLevel; // 2, 4, or 8

    this.pointCount = pointCount;

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel];

    // Calculate bounds
    this.bounds = this._calculateBounds();

    // Build tree
    console.time(`${treeName} build`);
    this.root = this._buildNode(
      this._createIndexArray(this.pointCount),
      this.bounds,
      0
    );
    console.timeEnd(`${treeName} build`);

    // LOD is optional (many consumers just need the tree for queries/picking).
    if (this._buildLOD) {
      // Generate LOD levels
      console.time('LOD generation');
      this.lodLevels = this._generateLODLevels();
      console.timeEnd('LOD generation');

      if (this._buildLodNodeMappings) {
        // Pre-compute LOD indices per node for fast frustum culling
        this._buildLODNodeMappings();
        this._lodNodeMappingsBuilt = true;
      }
    } else {
      this.lodLevels = [];
    }
  }

  ensureLODLevels() {
    if (this.lodLevels && this.lodLevels.length > 0) return;

    const notifications = getNotificationCenter();
    const notifId = notifications.startCalculation(
      `Generating LOD levels for ${this.pointCount.toLocaleString()} cells`,
      'calculation'
    );
    const startTime = performance.now();

    try {
      console.time('LOD generation');
      this.lodLevels = this._generateLODLevels();
      console.timeEnd('LOD generation');
      this._buildLOD = true;
    } catch (error) {
      console.timeEnd('LOD generation');
      settleCalculationNotification(
        notifications,
        notifId,
        'failCalculation',
        `LOD generation failed: ${describeError(error)}`
      );
      throw error;
    }

    const elapsed = performance.now() - startTime;
    settleCalculationNotification(
      notifications,
      notifId,
      'completeCalculation',
      `LOD ready (${this.lodLevels.length} levels)`,
      elapsed
    );
  }

  ensureLodNodeMappings() {
    if (this._lodNodeMappingsBuilt) return;
    this.ensureLODLevels();

    const notifications = getNotificationCenter();
    const notifId = notifications.startCalculation('Building LOD node mappings', 'calculation');
    const startTime = performance.now();

    try {
      this._buildLODNodeMappings();
      this._lodNodeMappingsBuilt = true;
    } catch (error) {
      settleCalculationNotification(
        notifications,
        notifId,
        'failCalculation',
        `LOD node mappings failed: ${describeError(error)}`
      );
      throw error;
    }

    const elapsed = performance.now() - startTime;
    settleCalculationNotification(
      notifications,
      notifId,
      'completeCalculation',
      'LOD node mappings ready',
      elapsed
    );
  }

  _createIndexArray(count) {
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    return indices;
  }

  _calculateBounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const positions = this.positions;
    const count = this.pointCount;

    const CHUNK_SIZE = 10000;
    for (let start = 0; start < count; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, count);
      for (let i = start; i < end; i++) {
        const idx = i * 3;
        const x = positions[idx];
        const y = positions[idx + 1];
        const z = positions[idx + 2];

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    // Calculate extents
    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;

    // Use dynamic padding based on max extent - ensures flat dimensions get meaningful padding
    // This is critical for 1D/2D data where one or more dimensions are essentially zero
    const maxExtent = Math.max(extentX, extentY, extentZ, 0.001);
    const basePad = maxExtent * 0.001; // 0.1% of largest extent

    // For flat dimensions (extent < 1% of max), use LARGE padding (50% of max extent)
    // This ensures frustum culling doesn't clip quadtree nodes at different Z depths
    // causing grid artifacts in 2D views. The large Z padding ensures all nodes
    // span the full camera near-to-far range.
    const flatThreshold = maxExtent * 0.01;
    const flatPad = maxExtent * 0.5; // 50% padding for flat dimensions

    const padX = extentX < flatThreshold ? flatPad : basePad;
    const padY = extentY < flatThreshold ? flatPad : basePad;
    const padZ = extentZ < flatThreshold ? flatPad : basePad;

    return {
      minX: minX - padX, minY: minY - padY, minZ: minZ - padZ,
      maxX: maxX + padX, maxY: maxY + padY, maxZ: maxZ + padZ
    };
  }

  _buildNode(indices, bounds, depth) {
    const node = {
      bounds,
      indices: null,
      children: null,
      centroid: null,
      avgColor: null,
      avgAlpha: 0,
      pointCount: indices.length
    };

    if (indices.length <= this.maxPointsPerNode || depth >= this.maxDepth) {
      node.indices = indices;
      if (this._computeNodeStats) {
        node.centroid = this._computeCentroid(indices);
        node.avgColor = this._computeAvgColor(indices);
        node.avgAlpha = this._computeAvgAlpha(indices);
      }
      return node;
    }

    const midX = (bounds.minX + bounds.maxX) * 0.5;
    const midY = (bounds.minY + bounds.maxY) * 0.5;
    const midZ = (bounds.minZ + bounds.maxZ) * 0.5;

    const dimLevel = this.dimensionLevel;
    const numChildren = this.childCount; // 2, 4, or 8

    // Generate child bounds based on dimension level
    // 1D: 2 children (left/right on X)
    // 2D: 4 children (quadtree on XY)
    // 3D: 8 children (octree on XYZ)
    const childBounds = [];
    for (let c = 0; c < numChildren; c++) {
      const xSplit = (c & 1) !== 0;
      const ySplit = dimLevel >= 2 ? ((c & 2) !== 0) : false;
      const zSplit = dimLevel >= 3 ? ((c & 4) !== 0) : false;

      // For dimensions being split: divide at mid point (upper/lower halves)
      // For dimensions NOT being split: children inherit FULL parent range
      // This is critical for correct frustum culling in lower dimensions
      //
      // When splitting a dimension (e.g., Y in 2D mode):
      //   - split=true means upper half: [mid, max]
      //   - split=false means lower half: [min, mid]
      // When NOT splitting a dimension (e.g., Y in 1D mode):
      //   - full range: [min, max]
      childBounds.push({
        minX: xSplit ? midX : bounds.minX,
        maxX: xSplit ? bounds.maxX : midX,
        // Y bounds: split into halves if dimLevel >= 2, otherwise inherit full range
        minY: ySplit ? midY : bounds.minY,
        maxY: (dimLevel >= 2) ? (ySplit ? bounds.maxY : midY) : bounds.maxY,
        // Z bounds: split into halves if dimLevel >= 3, otherwise inherit full range
        minZ: zSplit ? midZ : bounds.minZ,
        maxZ: (dimLevel >= 3) ? (zSplit ? bounds.maxZ : midZ) : bounds.maxZ
      });
    }

    const positions = this.positions;
    const n = indices.length;

    // Count first, then recompute the child during distribution. Retaining one
    // byte per point at every recursive level creates a large transient-memory
    // multiplier, especially for degenerate inputs.
    const childCounts = new Uint32Array(numChildren);
    let occupiedChildCount = 0;
    let onlyOccupiedChild = -1;

    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      const base = idx * 3;
      const x = positions[base];
      const y = positions[base + 1];
      const z = positions[base + 2];

      // Compute child index based on dimension level (branchless for perf)
      let childIdx = (x >= midX) | 0;
      if (dimLevel >= 2) childIdx += ((y >= midY) | 0) << 1;
      if (dimLevel >= 3) childIdx += ((z >= midZ) | 0) << 2;

      if (childCounts[childIdx] === 0) {
        occupiedChildCount++;
        onlyOccupiedChild = childIdx;
      }
      childCounts[childIdx]++;
    }

    // A unary partition must preserve the exact index owner. Allocating and
    // copying N indices at every depth turns identical-coordinate datasets
    // into O(N * maxDepth) allocation/copy work for no semantic benefit.
    if (occupiedChildCount === 1) {
      node.children = new Array(numChildren).fill(null);
      node.children[onlyOccupiedChild] = this._buildNode(
        indices,
        childBounds[onlyOccupiedChild],
        depth + 1
      );

      if (this._computeNodeStats) {
        node.centroid = this._computeCentroidFromChildren(node);
        node.avgColor = this._computeAvgColorFromChildren(node);
        node.avgAlpha = this._computeAvgAlphaFromChildren(node);
      }
      return node;
    }

    // Pre-allocate child arrays based on counts
    const childIndices = childBounds.map((_, i) =>
      childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
    );
    const childOffsets = new Uint32Array(numChildren);

    // Second pass: recompute the child and distribute into exact-size owners.
    // The additional sequential position reads are cheaper than allocating,
    // filling, and collecting an N-byte routing owner per internal node.
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      const base = idx * 3;
      let childIdx = (positions[base] >= midX) | 0;
      if (dimLevel >= 2) {
        childIdx += ((positions[base + 1] >= midY) | 0) << 1;
      }
      if (dimLevel >= 3) {
        childIdx += ((positions[base + 2] >= midZ) | 0) << 2;
      }
      childIndices[childIdx][childOffsets[childIdx]++] = idx;
    }

    node.children = childBounds.map((cb, i) =>
      childIndices[i] !== null
        ? this._buildNode(childIndices[i], cb, depth + 1)
        : null
    );

    if (this._computeNodeStats) {
      node.centroid = this._computeCentroidFromChildren(node);
      node.avgColor = this._computeAvgColorFromChildren(node);
      node.avgAlpha = this._computeAvgAlphaFromChildren(node);
    }

    return node;
  }

  _computeCentroid(indices) {
    let sx = 0, sy = 0, sz = 0;
    const positions = this.positions;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i] * 3;
      sx += positions[idx];
      sy += positions[idx + 1];
      sz += positions[idx + 2];
    }
    const n = indices.length;
    return [sx / n, sy / n, sz / n];
  }

  _computeAvgColor(indices) {
    let sr = 0, sg = 0, sb = 0;
    const colors = this.colors;
    const stride = colors.length === this.pointCount * 4 ? 4 : 3;
    const scale = colors.BYTES_PER_ELEMENT === 1 ? (1 / 255) : 1;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i] * stride;
      sr += colors[idx] * scale;
      sg += colors[idx + 1] * scale;
      sb += colors[idx + 2] * scale;
    }
    const n = indices.length;
    return [sr / n, sg / n, sb / n];
  }

  _computeAvgAlpha(indices) {
    if (!indices.length) return 1.0;
    let sum = 0;
    const colors = this.colors;
    for (let i = 0; i < indices.length; i++) {
      sum += colors[indices[i] * 4 + 3];
    }
    return sum / (indices.length * 255);
  }

  _computeCentroidFromChildren(node) {
    let sx = 0, sy = 0, sz = 0, totalCount = 0;
    for (const child of node.children) {
      if (child && child.centroid) {
        sx += child.centroid[0] * child.pointCount;
        sy += child.centroid[1] * child.pointCount;
        sz += child.centroid[2] * child.pointCount;
        totalCount += child.pointCount;
      }
    }
    return totalCount > 0 ? [sx / totalCount, sy / totalCount, sz / totalCount] : [0, 0, 0];
  }

  _computeAvgColorFromChildren(node) {
    let sr = 0, sg = 0, sb = 0, totalCount = 0;
    for (const child of node.children) {
      if (child && child.avgColor) {
        sr += child.avgColor[0] * child.pointCount;
        sg += child.avgColor[1] * child.pointCount;
        sb += child.avgColor[2] * child.pointCount;
        totalCount += child.pointCount;
      }
    }
    return totalCount > 0 ? [sr / totalCount, sg / totalCount, sb / totalCount] : [0.5, 0.5, 0.5];
  }

  _computeAvgAlphaFromChildren(node) {
    let sum = 0, totalCount = 0;
    for (const child of node.children) {
      if (child) {
        sum += child.avgAlpha * child.pointCount;
        totalCount += child.pointCount;
      }
    }
    return totalCount > 0 ? sum / totalCount : 1.0;
  }

  _generateLODLevels() {
    const levels = [];
    const totalPoints = this.pointCount;

    // Smooth LOD with 1.25x steps for imperceptible transitions (18 levels)
    // Each step increases points by 25%, below human perception threshold
    const reductionFactors = [44, 35, 28, 23, 18, 14.5, 11.5, 9.3, 7.5, 6, 4.8, 3.8, 3, 2.4, 1.95, 1.55, 1.25, 1];

    for (let levelIdx = 0; levelIdx < reductionFactors.length; levelIdx++) {
      const factor = reductionFactors[levelIdx];
      const targetCount = Math.max(1000, Math.ceil(totalPoints / factor));

      if (factor === 1) {
        levels.push({
          depth: levelIdx,
          pointCount: totalPoints,
          positions: this.positions,
          colors: this.colors, // RGBA uint8 with alpha packed
          sizes: null,
          isFullDetail: true
        });
        continue;
      }

      const sampledIndices = this._stratifiedSample(targetCount);
      const pointCount = sampledIndices.length;

      levels.push({
        depth: levelIdx,
        pointCount,
        indices: sampledIndices, // Exact original IDs for source-data lookup
        sizes: null,
        isFullDetail: false,
        sizeMultiplier: Math.sqrt(factor) * 0.2 + 0.8
      });
    }

    // The coarsest level adaptive selection may choose. Levels are ordered
    // coarse-to-fine and their counts are non-decreasing, so the first level
    // that meets the budget is that bound. A dataset at or under the budget
    // resolves to terminal full detail, which is the honest answer: adaptive
    // selection has no work to do for a cloud that already draws in one frame.
    const adaptiveFloorCount = Math.min(
      totalPoints,
      ADAPTIVE_LOD_POINT_BUDGET
    );
    let adaptiveMinimumLevel = levels.length - 1;
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      if (levels[levelIdx].pointCount >= adaptiveFloorCount) {
        adaptiveMinimumLevel = levelIdx;
        break;
      }
    }
    this._adaptiveMinimumLevel = adaptiveMinimumLevel;

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel] || 'Octree';
    console.log(`[${treeName}] Generated ${levels.length} LOD levels (dim=${this.dimensionLevel}):`,
      levels.map(l => `${l.pointCount.toLocaleString()} pts`).join(', '),
      `| adaptive floor: level ${adaptiveMinimumLevel} `
      + `(${levels[adaptiveMinimumLevel].pointCount.toLocaleString()} pts)`);

    return levels;
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
   */
  _buildHierarchicalOrder() {
    if (this._hierarchicalOrder) return this._hierarchicalOrder;

    const n = this.pointCount;
    const positions = this.positions;
    const bounds = this.bounds;
    const dimLevel = this.dimensionLevel;

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
        const positionOffset = pointIndex * 3;
        priorities[pointIndex] = quantize(
          positions[positionOffset],
          bounds.minX,
          scaleX
        );
        sourceIds[pointIndex] = pointIndex;
      }
    } else if (dimLevel === 2) {
      for (let pointIndex = 0; pointIndex < n; pointIndex++) {
        const positionOffset = pointIndex * 3;
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
        `SpatialIndex hierarchical ordering supports at most ${(1 << 30).toLocaleString()} points.`
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
        `SpatialIndex hierarchical ordering emitted ${emitted} of ${n} points.`
      );
    }

    // Only the final ID generation escapes. Explicitly release all build
    // scratch references before atomically publishing the shared LOD owner.
    const hierarchicalOrder = targetIds;
    priorities = null;
    sourceIds = null;
    targetIds = null;
    radixOffsets = null;
    this._hierarchicalOrder = hierarchicalOrder;
    return this._hierarchicalOrder;
  }

  _stratifiedSample(targetCount) {
    // Use hierarchical ordering for stable, subset-based sampling
    const order = this._buildHierarchicalOrder();

    // Return a stable prefix view into the single typed hierarchical order.
    // Each LOD keeps its own Uint32Array view identity without another backing
    // allocation.
    const count = Math.min(targetCount, order.length);
    return order.subarray(0, count);
  }

  /**
   * Build one exact, shared admission-level owner for every reduced LOD.
   *
   * `admissionLevels[originalId]` is the first reduced LOD level that admits
   * the source point. `0xff` means the point appears only at terminal full
   * detail. Because the LOD index arrays are nested views into one hierarchy,
   * this replaces every per-view Float32 membership mask with one immutable
   * byte owner per spatial generation.
   *
   * Publication is transactional: allocation and complete prefix validation
   * finish off-state before `_lodMembershipOwner` changes.
   *
   * @private
   * @returns {Object}
   */
  _ensureLodMembershipOwner() {
    if (this._lodMembershipOwner !== null) {
      return this._lodMembershipOwner;
    }
    if (
      !Array.isArray(this.lodLevels) ||
      this.lodLevels.length < 1
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires a published LOD inventory.'
      );
    }

    const terminalLevel = this.lodLevels.length - 1;
    if (terminalLevel >= LOD_FULL_DETAIL_ADMISSION_LEVEL) {
      throw new RangeError(
        'SpatialIndex LOD membership exceeds the Uint8 admission-level contract.'
      );
    }
    const fullDetail = this.lodLevels[terminalLevel];
    if (
      fullDetail?.isFullDetail !== true ||
      fullDetail.pointCount !== this.pointCount
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires one exact terminal full-detail level.'
      );
    }

    const hierarchy = this._buildHierarchicalOrder();
    if (
      !(hierarchy instanceof Uint32Array) ||
      hierarchy.length !== this.pointCount
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires one exact full point hierarchy.'
      );
    }

    const admissionLevels = new Uint8Array(this.pointCount);
    admissionLevels.fill(LOD_FULL_DETAIL_ADMISSION_LEVEL);
    const generationToken = Object.freeze({});
    const descriptorsByLevel = new Array(this.lodLevels.length);
    let previousCount = 0;

    for (let lodLevel = 0; lodLevel < terminalLevel; lodLevel++) {
      const level = this.lodLevels[lodLevel];
      const indices = level?.indices;
      if (
        level?.isFullDetail !== false ||
        !(indices instanceof Uint32Array) ||
        !Number.isSafeInteger(level.pointCount) ||
        level.pointCount !== indices.length ||
        level.pointCount < previousCount ||
        level.pointCount > this.pointCount
      ) {
        throw new Error(
          `SpatialIndex LOD ${lodLevel} is not one exact monotonic reduced prefix.`
        );
      }
      if (
        indices.buffer !== hierarchy.buffer ||
        indices.byteOffset !== hierarchy.byteOffset
      ) {
        throw new Error(
          `SpatialIndex LOD ${lodLevel} does not share the exact hierarchical prefix owner.`
        );
      }

      for (
        let compactRank = previousCount;
        compactRank < level.pointCount;
        compactRank++
      ) {
        const originalId = hierarchy[compactRank];
        if (originalId >= this.pointCount) {
          throw new RangeError(
            `SpatialIndex LOD ${lodLevel} contains source ID ${originalId} outside ${this.pointCount} points.`
          );
        }
        if (
          admissionLevels[originalId] !==
          LOD_FULL_DETAIL_ADMISSION_LEVEL
        ) {
          throw new Error(
            `SpatialIndex LOD hierarchy repeats source ID ${originalId}.`
          );
        }
        admissionLevels[originalId] = lodLevel;
      }

      descriptorsByLevel[lodLevel] = Object.freeze({
        admissionLevels,
        dimensionLevel: this.dimensionLevel,
        generationToken,
        indices,
        lodLevel,
        pointCount: this.pointCount,
      });
      previousCount = level.pointCount;
    }

    // Reduced descriptors only expose hierarchy prefixes, but the backing
    // hierarchy must still be one exact full-point permutation. Validate the
    // terminal tail without retaining another point-count allocation: use the
    // unpublished admission candidate as a temporary visited table, then
    // restore terminal-only points to the canonical 0xff sentinel.
    for (
      let compactRank = previousCount;
      compactRank < this.pointCount;
      compactRank++
    ) {
      const originalId = hierarchy[compactRank];
      if (originalId >= this.pointCount) {
        throw new RangeError(
          `SpatialIndex LOD hierarchy tail contains source ID ${originalId} outside ${this.pointCount} points.`
        );
      }
      if (
        admissionLevels[originalId] !==
        LOD_FULL_DETAIL_ADMISSION_LEVEL
      ) {
        throw new Error(
          `SpatialIndex LOD hierarchy repeats source ID ${originalId} in its full-detail tail.`
        );
      }
      admissionLevels[originalId] = terminalLevel;
    }
    for (
      let compactRank = previousCount;
      compactRank < this.pointCount;
      compactRank++
    ) {
      admissionLevels[hierarchy[compactRank]] =
        LOD_FULL_DETAIL_ADMISSION_LEVEL;
    }
    descriptorsByLevel[terminalLevel] = null;

    const candidate = Object.freeze({
      admissionLevels,
      descriptorsByLevel: Object.freeze(descriptorsByLevel),
      generationToken,
    });
    this._lodMembershipOwner = candidate;
    return candidate;
  }

  /**
   * Return the exact shared membership descriptor for one LOD level.
   * Terminal full detail is represented by null (all points admitted).
   *
   * @param {number} lodLevel
   * @returns {Object|null}
   */
  getLodMembership(lodLevel) {
    if (lodLevel === -1) return null;
    if (
      !Number.isInteger(lodLevel) ||
      lodLevel < 0 ||
      lodLevel >= this.lodLevels.length
    ) {
      throw new RangeError(
        `SpatialIndex LOD membership level ${String(lodLevel)} is outside the published inventory.`
      );
    }
    if (this.lodLevels[lodLevel]?.isFullDetail === true) {
      return null;
    }
    const owner = this._ensureLodMembershipOwner();
    const descriptor = owner.descriptorsByLevel[lodLevel];
    if (descriptor === null || descriptor === undefined) {
      throw new Error(
        `SpatialIndex LOD ${lodLevel} has no exact membership descriptor.`
      );
    }
    return descriptor;
  }

  /**
   * Get LOD level for a given camera distance.
   * @param {number} distance - Camera distance from target
   * @param {number} previousLevel - Previous LOD level for this view (for hysteresis). Pass -1 or undefined for first call.
   * @param {number} dimensionLevel - Current dimension level (1, 2, or 3).
   * @param {Object} [overrideBounds] - Optional bounds override for view-specific positions.
   *   When positions differ from octree (e.g., 2D projection), pass actual bounds to get
   *   correct LOD selection. Format: { minX, maxX, minY, maxY, minZ, maxZ }
   * @returns {number} LOD level (0 = coarsest, `lodLevels.length - 1` = full
   *   detail). The answer is never coarser than the adaptive point budget
   *   allows; a forced level bypasses this selector entirely.
   */
  getLODLevel(distance, previousLevel, dimensionLevel, overrideBounds = null) {
    if (this.lodLevels.length === 0) return -1;

    const validDimLevel = requireDimensionLevel(
      dimensionLevel,
      'SpatialIndex LOD dimensionLevel'
    );

    const numLevels = this.lodLevels.length;

    // Calculate data diagonal size for scale-independent LOD selection
    // Use override bounds if provided (for view-specific positions), otherwise use octree bounds
    // This handles cases where the octree was built from 3D-padded positions but we're viewing in 2D
    const bounds = overrideBounds || this.bounds;
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    // For lower dimensions, use only the significant extents (data may be along any axis)
    // Sort extents to find the largest ones regardless of which axis they're on
    let dataSize;
    if (validDimLevel === 1) {
      // 1D: use the largest extent (data could be along X, Y, or Z)
      dataSize = Math.max(dx, dy, dz) || 1;
	    } else if (validDimLevel === 2) {
	      // 2D: use the two largest extents (handles XY, XZ, or YZ planes)
	      // Avoid allocation/sort in a hot helper (used when adaptive LOD is enabled).
	      const maxExtent = Math.max(dx, dy, dz);
	      const minExtent = Math.min(dx, dy, dz);
	      const midExtent = dx + dy + dz - maxExtent - minExtent;
	      dataSize = Math.sqrt(maxExtent * maxExtent + midExtent * midExtent) || 1;
	    } else {
	      dataSize = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;  // 3D+: full diagonal
	    }

    // Normalize distance relative to data size
    const distanceRatio = distance / dataSize;

    // Map distance ratio to LOD level
    const minRatio = 0.3;
    const maxRatio = 3.0;
    const clampedRatio = Math.max(minRatio, Math.min(maxRatio, distanceRatio));

    const t = 1.0 - (Math.log(clampedRatio / minRatio) / Math.log(maxRatio / minRatio));
    const targetLevel = t * (numLevels - 1);

    // Apply hysteresis with large dead zone to prevent oscillation
    const HYSTERESIS = 0.7;

    // Use passed previousLevel for per-view hysteresis (instead of global state)
    const currentLevel = previousLevel >= 0 ? previousLevel : Math.round(targetLevel);
    let newLevel = currentLevel;

    if (targetLevel > currentLevel + HYSTERESIS && currentLevel < numLevels - 1) {
      newLevel = currentLevel + 1;
    } else if (targetLevel < currentLevel - HYSTERESIS && currentLevel > 0) {
      newLevel = currentLevel - 1;
    }

    const floorLevel = Math.min(
      numLevels - 1,
      Math.max(0, this._adaptiveMinimumLevel)
    );
    return Math.max(floorLevel, Math.min(numLevels - 1, newLevel));
  }

  getVisibleIndices(frustumPlanes, maxPoints = Infinity) {
    const visibleIndices = [];

    const traverse = (node) => {
      if (!node || visibleIndices.length >= maxPoints) return;

      if (!this._boundsInFrustum(node.bounds, frustumPlanes)) {
        return;
      }

      if (node.indices !== null) {
        for (let i = 0; i < node.indices.length && visibleIndices.length < maxPoints; i++) {
          visibleIndices.push(node.indices[i]);
        }
      } else if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(this.root);
    return visibleIndices;
  }

  _boundsInFrustum(bounds, planes) {
    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i];
      const px = plane[0] >= 0 ? bounds.maxX : bounds.minX;
      const py = plane[1] >= 0 ? bounds.maxY : bounds.minY;
      const pz = plane[2] >= 0 ? bounds.maxZ : bounds.minZ;

      if (plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0) {
        return false;
      }
    }
    return true;
  }

  _boundsIntersectsSphere(bounds, center, radius) {
    // Clamp point to AABB and measure distance to sphere center
    const cx = Math.max(bounds.minX, Math.min(center[0], bounds.maxX));
    const cy = Math.max(bounds.minY, Math.min(center[1], bounds.maxY));
    const cz = Math.max(bounds.minZ, Math.min(center[2], bounds.maxZ));
    const dx = cx - center[0];
    const dy = cy - center[1];
    const dz = cz - center[2];
    return (dx * dx + dy * dy + dz * dz) <= radius * radius;
  }

  /**
   * Visit every point in leaves whose bounds intersect a sphere. Node
   * rejection is conservative; the caller owns the exact point-level
   * predicate. Unlike queryRadius(), this traversal has no result cap.
   * Each original point ID is visited at most once.
   *
   * @param {ArrayLike<number>} center
   * @param {number} radius
   * @param {(cellIndex: number) => void} visitor
   */
  visitRadiusCandidates(center, radius, visitor) {
    requireNumericVector(center, 3, 'SpatialIndex radius center');
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError(
        'SpatialIndex radius must be a finite non-negative number.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError('SpatialIndex radius visitor must be a function.');
    }
    if (!this.root) return;

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsSphere(node.bounds, center, radius)
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  _boundsIntersectsProjectedRect(bounds, mvpMatrix, clipPlanes) {
    // Screen-space division reverses inequalities behind the eye. Only prune
    // boxes proven wholly in front of the clip-W singularity; boxes touching
    // or crossing it are traversed so the caller's exact projection predicate
    // remains authoritative.
    const wa = mvpMatrix[3];
    const wb = mvpMatrix[7];
    const wc = mvpMatrix[11];
    const wd = mvpMatrix[15];
    const minimumClipW =
      wd +
      wa * (wa >= 0 ? bounds.minX : bounds.maxX) +
      wb * (wb >= 0 ? bounds.minY : bounds.maxY) +
      wc * (wc >= 0 ? bounds.minZ : bounds.maxZ);
    if (minimumClipW <= 1e-10) return true;

    for (let planeOffset = 0; planeOffset < 24; planeOffset += 4) {
      const a = clipPlanes[planeOffset];
      const b = clipPlanes[planeOffset + 1];
      const c = clipPlanes[planeOffset + 2];
      const d = clipPlanes[planeOffset + 3];
      const maximum =
        d +
        a * (a >= 0 ? bounds.maxX : bounds.minX) +
        b * (b >= 0 ? bounds.maxY : bounds.minY) +
        c * (c >= 0 ? bounds.maxZ : bounds.minZ);
      if (maximum < 0) return false;
    }
    return true;
  }

  /**
   * Visit every point in leaves that can project into an NDC rectangle while
   * passing the canonical near/far clip planes. The six object-space planes
   * are derived exactly from the captured MVP matrix and rectangle. Boxes
   * crossing clip-W=0 are deliberately retained for exact point testing.
   *
   * @param {ArrayLike<number>} mvpMatrix Column-major MVP matrix.
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} ndcBounds
   * @param {(cellIndex: number) => void} visitor
   */
  visitProjectedRectCandidates(mvpMatrix, ndcBounds, visitor) {
    requireNumericVector(
      mvpMatrix,
      16,
      'SpatialIndex projected-rectangle MVP matrix'
    );
    if (
      ndcBounds === null ||
      typeof ndcBounds !== 'object' ||
      Array.isArray(ndcBounds)
    ) {
      throw new TypeError(
        'SpatialIndex projected-rectangle NDC bounds must be an object.'
      );
    }
    const minX = requireFiniteNumber(
      ndcBounds.minX,
      'SpatialIndex projected-rectangle minX'
    );
    const maxX = requireFiniteNumber(
      ndcBounds.maxX,
      'SpatialIndex projected-rectangle maxX'
    );
    const minY = requireFiniteNumber(
      ndcBounds.minY,
      'SpatialIndex projected-rectangle minY'
    );
    const maxY = requireFiniteNumber(
      ndcBounds.maxY,
      'SpatialIndex projected-rectangle maxY'
    );
    if (minX > maxX || minY > maxY) {
      throw new RangeError(
        'SpatialIndex projected-rectangle NDC bounds must be ordered.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError(
        'SpatialIndex projected-rectangle visitor must be a function.'
      );
    }
    if (!this.root) return;

    // Column-major clip rows: X=(0,4,8,12), Y=(1,5,9,13),
    // Z=(2,6,10,14), W=(3,7,11,15).
    const planes = new Float64Array(24);
    const setPlane = (offset, xFactor, yFactor, zFactor, wFactor) => {
      planes[offset] =
        xFactor * mvpMatrix[0] +
        yFactor * mvpMatrix[1] +
        zFactor * mvpMatrix[2] +
        wFactor * mvpMatrix[3];
      planes[offset + 1] =
        xFactor * mvpMatrix[4] +
        yFactor * mvpMatrix[5] +
        zFactor * mvpMatrix[6] +
        wFactor * mvpMatrix[7];
      planes[offset + 2] =
        xFactor * mvpMatrix[8] +
        yFactor * mvpMatrix[9] +
        zFactor * mvpMatrix[10] +
        wFactor * mvpMatrix[11];
      planes[offset + 3] =
        xFactor * mvpMatrix[12] +
        yFactor * mvpMatrix[13] +
        zFactor * mvpMatrix[14] +
        wFactor * mvpMatrix[15];
    };
    setPlane(0, 1, 0, 0, -minX);   // clipX >= minX * clipW
    setPlane(4, -1, 0, 0, maxX);   // clipX <= maxX * clipW
    setPlane(8, 0, 1, 0, -minY);   // clipY >= minY * clipW
    setPlane(12, 0, -1, 0, maxY);  // clipY <= maxY * clipW
    setPlane(16, 0, 0, 1, 1);      // clipZ >= -clipW
    setPlane(20, 0, 0, -1, 1);     // clipZ <= clipW

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsProjectedRect(
          node.bounds,
          mvpMatrix,
          planes
        )
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  _boundsIntersectsExpandedRaySegment(
    bounds,
    origin,
    direction,
    maxDistance,
    radius
  ) {
    let minimumDistance = 0;
    let maximumDistance = maxDistance;

    for (let axis = 0; axis < 3; axis++) {
      const axisOrigin = origin[axis];
      const axisDirection = direction[axis];
      let axisMinimum;
      let axisMaximum;
      if (axis === 0) {
        axisMinimum = bounds.minX - radius;
        axisMaximum = bounds.maxX + radius;
      } else if (axis === 1) {
        axisMinimum = bounds.minY - radius;
        axisMaximum = bounds.maxY + radius;
      } else {
        axisMinimum = bounds.minZ - radius;
        axisMaximum = bounds.maxZ + radius;
      }
      if (axisDirection === 0) {
        if (
          axisOrigin < axisMinimum ||
          axisOrigin > axisMaximum
        ) {
          return false;
        }
        continue;
      }

      const inverseDirection = 1 / axisDirection;
      let entryDistance =
        (axisMinimum - axisOrigin) * inverseDirection;
      let exitDistance =
        (axisMaximum - axisOrigin) * inverseDirection;
      if (entryDistance > exitDistance) {
        const swap = entryDistance;
        entryDistance = exitDistance;
        exitDistance = swap;
      }
      minimumDistance = Math.max(minimumDistance, entryDistance);
      maximumDistance = Math.min(maximumDistance, exitDistance);
      if (minimumDistance > maximumDistance) return false;
    }
    return true;
  }

  /**
   * Visit every point in leaves that can intersect a radius-expanded finite
   * ray segment. Node rejection is conservative; the caller owns the exact
   * point-level predicate. Each original point ID is visited at most once.
   *
   * @param {ArrayLike<number>} origin
   * @param {ArrayLike<number>} direction
   * @param {number} maxDistance
   * @param {number} radius
   * @param {(cellIndex: number) => void} visitor
   */
  visitRaySegmentCandidates(
    origin,
    direction,
    maxDistance,
    radius,
    visitor
  ) {
    requireNumericVector(origin, 3, 'SpatialIndex ray origin');
    requireNumericVector(direction, 3, 'SpatialIndex ray direction');
    if (!Number.isFinite(maxDistance) || maxDistance < 0) {
      throw new RangeError(
        'SpatialIndex ray maxDistance must be a finite non-negative number.'
      );
    }
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError(
        'SpatialIndex ray radius must be a finite non-negative number.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError('SpatialIndex ray visitor must be a function.');
    }
    if (!this.root) return;

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsExpandedRaySegment(
          node.bounds,
          origin,
          direction,
          maxDistance,
          radius
        )
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  queryRadius(center, radius, maxResults = 64) {
    if (!this.root || radius <= 0) return [];
    const results = [];
    const stack = [this.root];
    const r2 = radius * radius;

    while (stack.length && results.length < maxResults) {
      const node = stack.pop();
      if (!node) continue;
      if (!this._boundsIntersectsSphere(node.bounds, center, radius)) continue;

      if (node.indices) {
        for (let i = 0; i < node.indices.length && results.length < maxResults; i++) {
          const idx = node.indices[i];
          const px = this.positions[idx * 3];
          const py = this.positions[idx * 3 + 1];
          const pz = this.positions[idx * 3 + 2];
          const dx = px - center[0];
          const dy = py - center[1];
          const dz = pz - center[2];
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 <= r2) {
            results.push(idx);
          }
        }
      } else if (node.children) {
        for (const child of node.children) {
          if (child) stack.push(child);
        }
      }
    }

    return results;
  }

  /**
   * Query points within radius at a specific LOD level.
   * Each result's lodIndex is its compact LOD-prefix position, while
   * originalIndex is the exact source-data point ID.
   * @param {Array} center - [x, y, z] center point
   * @param {number} radius - Search radius
   * @param {number} lodLevel - LOD level to query (0 = lowest detail, max = full detail)
   * @param {number} maxResults - Maximum results to return
   * @param {Float32Array} [customPositions] - Optional custom positions array for view-specific queries
   *   (e.g., 2D projected positions). If provided, queries against these positions instead of
   *   the spatial index's source positions. Must have same point count as original data.
   * @returns {Array} Array of { lodIndex, position, originalIndex }
   */
  queryRadiusAtLOD(center, radius, lodLevel, maxResults, customPositions = null) {
    if (radius <= 0) return [];

    const numLevels = this.lodLevels.length;
    if (!Number.isInteger(lodLevel) || lodLevel < 0 || lodLevel >= numLevels) {
      throw new RangeError(
        `SpatialIndex LOD level must be an integer in [0, ${numLevels - 1}].`
      );
    }
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new TypeError('SpatialIndex maxResults must be a positive integer.');
    }
    if (
      customPositions !== null &&
      (!(customPositions instanceof Float32Array) ||
        customPositions.length !== this.positions.length)
    ) {
      throw new TypeError(
        `SpatialIndex customPositions must be null or a Float32Array with exactly ${this.positions.length} values.`
      );
    }

    const level = this.lodLevels[lodLevel];
    const pointCount = level.pointCount;
    const isFullDetail = level.isFullDetail;
    const sourcePositions = customPositions ?? this.positions;

    const results = [];
    const r2 = radius * radius;

    // Simple brute force over the LOD candidate IDs (reduced levels are small enough).
    for (let i = 0; i < pointCount && results.length < maxResults; i++) {
      const originalIdx = isFullDetail ? i : level.indices[i];
      const sourceOffset = originalIdx * 3;
      const px = sourcePositions[sourceOffset];
      const py = sourcePositions[sourceOffset + 1];
      const pz = sourcePositions[sourceOffset + 2];

      const dx = px - center[0];
      const dy = py - center[1];
      const dz = pz - center[2];
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 <= r2) {
        results.push({
          lodIndex: i,
          originalIndex: originalIdx,
          position: [px, py, pz]
        });
      }
    }

    return results;
  }

  getBoundingSphere() {
    const b = this.bounds;
    const centerX = (b.minX + b.maxX) * 0.5;
    const centerY = (b.minY + b.maxY) * 0.5;
    const centerZ = (b.minZ + b.maxZ) * 0.5;

    const dx = b.maxX - b.minX;
    const dy = b.maxY - b.minY;
    const dz = b.maxZ - b.minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;

    return { center: [centerX, centerY, centerZ], radius };
  }

  /**
   * Publish one exact compact-rank-to-leaf mapping shared by every reduced
   * LOD. A query marks its visible leaf ordinals, then scans only [0, K) for
   * the requested prefix. The emitted EBO is therefore globally ordered by
   * compact rank and costs O(visible leaves + K), independent of Kmax.
   */
  _buildLODNodeMappings() {
    console.time('LOD node mapping');
    try {
      if (
        !Array.isArray(this.lodLevels) ||
        this.lodLevels.length === 0 ||
        this.lodLevels.at(-1)?.isFullDetail !== true
      ) {
        throw new Error(
          'SpatialIndex LOD node mapping requires one terminal full-detail level.'
        );
      }

      const reducedLevels = this.lodLevels.slice(0, -1);
      const maximumIndices =
        reducedLevels.at(-1)?.indices ?? null;
      if (
        maximumIndices !== null &&
        !(maximumIndices instanceof Uint32Array)
      ) {
        throw new TypeError(
          'SpatialIndex LOD node mapping requires exact Uint32Array prefix indices.'
        );
      }
      const maximumCount = maximumIndices?.length ?? 0;

      // Staging is deliberately detached from both the tree and this owner.
      // A late leaf read/allocation/publication failure therefore leaves the
      // accepted generation byte-for-byte untouched and retryable.
      const leaves = [];
      const collectLeaves = node => {
        if (!node) return;
        const indices = node.indices;
        if (indices !== null) {
          if (!(indices instanceof Uint32Array)) {
            throw new TypeError(
              'SpatialIndex leaf membership must be an exact Uint32Array.'
            );
          }
          leaves.push({ indices, node });
          return;
        }
        if (node.children) {
          for (const child of node.children) collectLeaves(child);
        }
      };
      collectLeaves(this.root);
      if (leaves.length >= LOD_MAPPING_VISITED_BIT) {
        throw new RangeError(
          'SpatialIndex LOD node mapping exceeds the Uint32 leaf-ordinal contract.'
        );
      }

      // This point-count owner is temporary build scratch. It first proves
      // that the leaves are one exact source-ID partition, then lends its high
      // bit to validate maximum-prefix uniqueness without another N owner.
      const leafOrdinalByOriginalId =
        new Uint32Array(this.pointCount);
      leafOrdinalByOriginalId.fill(LOD_MAPPING_SENTINEL);
      let mappedPointCount = 0;
      for (
        let leafOrdinal = 0;
        leafOrdinal < leaves.length;
        leafOrdinal++
      ) {
        const { indices } = leaves[leafOrdinal];
        for (let index = 0; index < indices.length; index++) {
          const originalId = indices[index];
          if (originalId >= this.pointCount) {
            throw new RangeError(
              `SpatialIndex leaf contains source ID ${originalId} outside ${this.pointCount} points.`
            );
          }
          if (
            leafOrdinalByOriginalId[originalId] !==
            LOD_MAPPING_SENTINEL
          ) {
            throw new Error(
              `SpatialIndex leaves repeat source ID ${originalId}.`
            );
          }
          leafOrdinalByOriginalId[originalId] =
            leafOrdinal;
          mappedPointCount++;
        }
      }
      if (mappedPointCount !== this.pointCount) {
        throw new Error(
          `SpatialIndex leaves own ${mappedPointCount} source IDs but the dataset contains ${this.pointCount}.`
        );
      }

      const leafOrdinalsByCompactRank =
        new Uint32Array(maximumCount);
      for (
        let compactRank = 0;
        compactRank < maximumCount;
        compactRank++
      ) {
        const originalId = maximumIndices[compactRank];
        if (originalId >= this.pointCount) {
          throw new RangeError(
            `SpatialIndex maximum LOD prefix contains source ID ${originalId} outside ${this.pointCount} points.`
          );
        }
        const encodedOrdinal =
          leafOrdinalByOriginalId[originalId];
        if (encodedOrdinal === LOD_MAPPING_SENTINEL) {
          throw new Error(
            `SpatialIndex maximum LOD prefix source ID ${originalId} has no leaf owner.`
          );
        }
        if (
          (encodedOrdinal & LOD_MAPPING_VISITED_BIT) !== 0
        ) {
          throw new Error(
            `SpatialIndex maximum LOD prefix repeats source ID ${originalId}.`
          );
        }
        leafOrdinalsByCompactRank[compactRank] =
          encodedOrdinal;
        leafOrdinalByOriginalId[originalId] =
          encodedOrdinal | LOD_MAPPING_VISITED_BIT;
      }

      const generationToken = Object.freeze({});
      const leafNodes = Object.freeze(
        leaves.map(entry => entry.node)
      );
      const visibleLeafMarks =
        new Uint32Array(leaves.length);
      const queryState = Object.seal({
        generation: 0,
        lastExaminedRanks: 0,
        lastMarkedLeafCount: 0,
      });
      const metadata = leaves.map(
        ({ node }, ordinal) => ({
          descriptor: Object.freeze({
            generationToken,
            ordinal,
          }),
          node,
          previousDescriptor:
            Object.getOwnPropertyDescriptor(
              node,
              'lodMapping'
            ),
        })
      );
      const candidateOwner = Object.freeze({
        generationToken,
        leafNodes,
        leafOrdinalsByCompactRank,
        maximumIndices,
        pointCount: this.pointCount,
        queryState,
        visibleLeafMarks,
      });

      let publishedMetadataCount = 0;
      try {
        for (const entry of metadata) {
          const published = Reflect.defineProperty(
            entry.node,
            'lodMapping',
            {
              configurable: true,
              enumerable: true,
              value: entry.descriptor,
              writable: true,
            }
          );
          if (!published) {
            throw new TypeError(
              'SpatialIndex leaf rejected LOD mapping publication.'
            );
          }
          publishedMetadataCount++;
        }
        this._lodNodeMapping = candidateOwner;
      } catch (error) {
        for (
          let index = publishedMetadataCount - 1;
          index >= 0;
          index--
        ) {
          const entry = metadata[index];
          if (entry.previousDescriptor === undefined) {
            Reflect.deleteProperty(
              entry.node,
              'lodMapping'
            );
          } else {
            Reflect.defineProperty(
              entry.node,
              'lodMapping',
              entry.previousDescriptor
            );
          }
        }
        throw error;
      }
    } finally {
      console.timeEnd('LOD node mapping');
    }
  }

  _validateLodNodeMapping() {
    const owner = this._lodNodeMapping;
    const maximumIndices =
      this.lodLevels.at(-2)?.indices ?? null;
    if (
      owner === null ||
      typeof owner !== 'object' ||
      owner.maximumIndices !== maximumIndices ||
      owner.pointCount !== this.pointCount ||
      !Array.isArray(owner.leafNodes) ||
      !Object.isFrozen(owner.leafNodes) ||
      !(owner.leafOrdinalsByCompactRank instanceof Uint32Array) ||
      owner.leafOrdinalsByCompactRank.length !==
        (maximumIndices?.length ?? 0) ||
      !(owner.visibleLeafMarks instanceof Uint32Array) ||
      owner.visibleLeafMarks.length !==
        owner.leafNodes.length ||
      owner.queryState === null ||
      typeof owner.queryState !== 'object' ||
      !Object.isSealed(owner.queryState) ||
      !Number.isInteger(owner.queryState.generation) ||
      owner.queryState.generation < 0 ||
      owner.queryState.generation > LOD_MAPPING_SENTINEL ||
      owner.generationToken === null ||
      typeof owner.generationToken !== 'object' ||
      !Object.isFrozen(owner.generationToken)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has inconsistent generation ownership.'
      );
    }

    let expectedOrdinal = 0;
    const validateLeaves = node => {
      if (!node) return;
      if (node.indices !== null) {
        const metadata = node.lodMapping;
        if (
          metadata === null ||
          typeof metadata !== 'object' ||
          !Object.isFrozen(metadata) ||
          metadata.generationToken !== owner.generationToken ||
          metadata.ordinal !== expectedOrdinal ||
          owner.leafNodes[expectedOrdinal] !== node
        ) {
          throw new Error(
            'SpatialIndex leaf has inconsistent LOD mapping metadata.'
          );
        }
        expectedOrdinal++;
        return;
      }
      if (node.children) {
        for (const child of node.children) validateLeaves(child);
      }
    };
    validateLeaves(this.root);
    if (expectedOrdinal !== owner.leafNodes.length) {
      throw new Error(
        `SpatialIndex tree contains ${expectedOrdinal} leaves but the mapping owns ${owner.leafNodes.length}.`
      );
    }
    for (
      let compactRank = 0;
      compactRank < owner.leafOrdinalsByCompactRank.length;
      compactRank++
    ) {
      if (
        owner.leafOrdinalsByCompactRank[compactRank] >=
        owner.leafNodes.length
      ) {
        throw new RangeError(
          `SpatialIndex compact rank ${compactRank} has an invalid leaf ordinal.`
        );
      }
    }
    return owner.generationToken;
  }

  _reserveLodMappingMarkGeneration(owner, span = 1) {
    if (
      owner !== this._lodNodeMapping ||
      !(owner?.visibleLeafMarks instanceof Uint32Array) ||
      !Number.isInteger(span) ||
      span < 1 ||
      span > 2
    ) {
      throw new Error(
        'SpatialIndex LOD query requires the exact published mark owner.'
      );
    }
    const queryState = owner.queryState;
    let firstGeneration = queryState.generation + 1;
    if (
      firstGeneration >
      LOD_MAPPING_SENTINEL - span + 1
    ) {
      owner.visibleLeafMarks.fill(0);
      firstGeneration = 1;
    }
    queryState.generation =
      firstGeneration + span - 1;
    return firstGeneration;
  }

  _requireLodLeafOrdinal(owner, leaf) {
    const metadata = leaf?.lodMapping;
    const ordinal = metadata?.ordinal;
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      metadata.generationToken !== owner.generationToken ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= owner.leafNodes.length ||
      owner.leafNodes[ordinal] !== leaf
    ) {
      throw new Error(
        'SpatialIndex visible leaf does not belong to the exact LOD mapping.'
      );
    }
    return ordinal;
  }

  _markLodVisibleLeaves(owner, visibleLeaves) {
    const generation =
      this._reserveLodMappingMarkGeneration(owner);
    const marks = owner.visibleLeafMarks;
    for (const leaf of visibleLeaves) {
      const ordinal =
        this._requireLodLeafOrdinal(owner, leaf);
      if (marks[ordinal] === generation) {
        throw new Error(
          'SpatialIndex visible LOD leaves contain a duplicate leaf.'
        );
      }
      marks[ordinal] = generation;
    }
    owner.queryState.lastMarkedLeafCount =
      visibleLeaves.length;
    return generation;
  }

  /**
   * LOD EBO order is globally compact-rank ordered, so traversal order is not
   * semantic. Compare exact leaf identity as a set without allocating a Set.
   */
  hasSameLodVisibleLeafSet(accepted, candidate) {
    if (
      !Array.isArray(accepted) ||
      !Array.isArray(candidate) ||
      accepted.length !== candidate.length
    ) {
      return false;
    }
    const owner = this._lodNodeMapping;
    if (
      owner === null ||
      typeof owner !== 'object' ||
      !(owner.visibleLeafMarks instanceof Uint32Array)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has not been published.'
      );
    }
    if (accepted.length === 0) return true;

    const acceptedGeneration =
      this._reserveLodMappingMarkGeneration(owner, 2);
    const candidateGeneration = acceptedGeneration + 1;
    const marks = owner.visibleLeafMarks;
    for (const leaf of accepted) {
      const ordinal =
        this._requireLodLeafOrdinal(owner, leaf);
      if (marks[ordinal] === acceptedGeneration) {
        return false;
      }
      marks[ordinal] = acceptedGeneration;
    }
    for (const leaf of candidate) {
      const ordinal =
        this._requireLodLeafOrdinal(owner, leaf);
      if (marks[ordinal] !== acceptedGeneration) {
        return false;
      }
      marks[ordinal] = candidateGeneration;
    }
    owner.queryState.lastExaminedRanks = 0;
    owner.queryState.lastMarkedLeafCount =
      accepted.length + candidate.length;
    return true;
  }

  _requireReducedLodPrefixCount(lodLevel) {
    if (
      !Number.isInteger(lodLevel) ||
      lodLevel < 0 ||
      lodLevel >= this.lodLevels.length - 1
    ) {
      throw new RangeError(
        `SpatialIndex reduced LOD level must be an integer in [0, ${this.lodLevels.length - 2}].`
      );
    }
    const level = this.lodLevels[lodLevel];
    if (
      level?.isFullDetail === true ||
      !(level?.indices instanceof Uint32Array) ||
      level.indices.length !== level.pointCount
    ) {
      throw new Error(
        `SpatialIndex LOD ${lodLevel} is not an exact reduced prefix.`
      );
    }
    return level.pointCount;
  }

  countLodMappedIndices(visibleLeaves, lodLevel) {
    if (!Array.isArray(visibleLeaves)) {
      throw new TypeError(
        'SpatialIndex visible LOD leaves must be an exact array.'
      );
    }
    const prefixCount =
      this._requireReducedLodPrefixCount(lodLevel);
    const owner = this._lodNodeMapping;
    const leafOrdinalsByCompactRank =
      owner?.leafOrdinalsByCompactRank;
    if (
      !(leafOrdinalsByCompactRank instanceof Uint32Array) ||
      !(owner.visibleLeafMarks instanceof Uint32Array)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has not been published.'
      );
    }
    if (visibleLeaves.length === 0) {
      owner.queryState.lastExaminedRanks = 0;
      owner.queryState.lastMarkedLeafCount = 0;
      return 0;
    }

    const generation =
      this._markLodVisibleLeaves(owner, visibleLeaves);
    const marks = owner.visibleLeafMarks;
    let visibleCount = 0;
    for (
      let compactRank = 0;
      compactRank < prefixCount;
      compactRank++
    ) {
      if (
        marks[leafOrdinalsByCompactRank[compactRank]] ===
        generation
      ) {
        visibleCount++;
      }
    }
    owner.queryState.lastExaminedRanks = prefixCount;
    return visibleCount;
  }

  writeLodMappedIndices(
    visibleLeaves,
    lodLevel,
    target
  ) {
    if (!(target instanceof Uint32Array)) {
      throw new TypeError(
        'SpatialIndex visible LOD target must be an exact Uint32Array.'
      );
    }
    const prefixCount =
      this._requireReducedLodPrefixCount(lodLevel);
    const owner = this._lodNodeMapping;
    const leafOrdinalsByCompactRank =
      owner?.leafOrdinalsByCompactRank;
    if (
      !(leafOrdinalsByCompactRank instanceof Uint32Array) ||
      !(owner.visibleLeafMarks instanceof Uint32Array)
    ) {
      throw new Error(
        'SpatialIndex LOD node mapping has not been published.'
      );
    }
    if (visibleLeaves.length === 0) {
      owner.queryState.lastExaminedRanks = 0;
      owner.queryState.lastMarkedLeafCount = 0;
      return 0;
    }

    const generation =
      this._markLodVisibleLeaves(owner, visibleLeaves);
    const marks = owner.visibleLeafMarks;
    let writeOffset = 0;
    for (
      let compactRank = 0;
      compactRank < prefixCount;
      compactRank++
    ) {
      if (
        marks[leafOrdinalsByCompactRank[compactRank]] ===
        generation
      ) {
        if (writeOffset >= target.length) {
          throw new RangeError(
            'SpatialIndex visible LOD target capacity is too small.'
          );
        }
        target[writeOffset++] = compactRank;
      }
    }
    owner.queryState.lastExaminedRanks = prefixCount;
    return writeOffset;
  }

  /**
   * Validate that spatial index contains all original points.
   * Returns the total count of points in all leaf nodes.
   */
  validatePointCount() {
    let count = 0;
    const countLeaves = (node) => {
      if (!node) return;
      if (node.indices) {
        count += node.indices.length;
      } else if (node.children) {
        for (const child of node.children) {
          countLeaves(child);
        }
      }
    };
    countLeaves(this.root);
    const valid = count === this.pointCount;
    if (!valid) {
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      console.error(`[${treeNames[this.dimensionLevel]}] Point count mismatch: tree has ${count}, expected ${this.pointCount}`);
    }
    return { count, expected: this.pointCount, valid };
  }
}

export {
  HIERARCHICAL_RADIX_BITS,
  HIERARCHICAL_RADIX_SIZE,
  HIERARCHICAL_RADIX_MASK,
  LOD_MAPPING_SENTINEL,
  LOD_MAPPING_VISITED_BIT,
  LOD_FULL_DETAIL_ADMISSION_LEVEL,
  ADAPTIVE_LOD_POINT_BUDGET,
  LOCALITY_BITS_BY_DIMENSION,
  spreadPairwise,
  spreadTriplewise,
};
