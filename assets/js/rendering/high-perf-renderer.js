/**
 * HIGH-PERFORMANCE SCATTERPLOT RENDERER (WebGL2 Only)
 * ====================================================
 * Optimized for 20-30+ million points using:
 *
 * 1. WebGL2 with VAOs and GLSL ES 3.0
 * 2. Interleaved vertex buffers (better GPU cache coherency)
 * 3. Level-of-Detail (LOD) with octree spatial indexing
 * 4. Frustum culling - only render visible points
 * 5. GPU-only fog (no CPU distance calculations)
 * 6. Lightweight shader variants
 */

import {
  HP_VS_FULL, HP_FS_FULL,
  HP_VS_LIGHT, HP_FS_LIGHT, HP_FS_ULTRALIGHT
} from './shaders/high-perf-shaders.js';
import { getNotificationCenter } from '../app/notification-center.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Dimension threshold for disabling depth testing.
 * For 2D data (dimensionLevel <= this value), depth testing is disabled
 * to prevent draw-order artifacts when all points have the same Z.
 */
const DEPTH_TEST_DIMENSION_THRESHOLD = 2;

/**
 * Sentinel value indicating that a full LOD re-upload is pending.
 * Used instead of -1 to make the intent clearer and avoid confusion with valid LOD levels.
 */
const LOD_PENDING_REUPLOAD = -999;

/**
 * Debug flag for LOD and frustum culling logs.
 * Set to true to enable verbose console output during rendering.
 * This should be false in production to avoid performance impact.
 */
let DEBUG_LOD_FRUSTUM = false;

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
   * @param {Object} [options]
   * @param {boolean} [options.buildLOD=true] - Whether to generate LOD levels.
   * @param {boolean} [options.buildLodNodeMappings=true] - Whether to precompute per-node LOD index mappings for fast LOD+frustum culling.
   * @param {boolean} [options.computeNodeStats=true] - Whether to compute node centroid/avgColor/avgAlpha (currently unused by renderer paths).
   */
  constructor(positions, colors, dimensionLevel = 3, maxPointsPerNode = 1000, maxDepth = 8, options = {}) {
    const {
      buildLOD = true,
      buildLodNodeMappings = true,
      computeNodeStats = true
    } = options || {};

    this._buildLOD = !!buildLOD;
    this._computeNodeStats = !!computeNodeStats;
    this._lodNodeMappingsBuilt = false;
    this._buildLodNodeMappings = !!buildLodNodeMappings;

    this.maxPointsPerNode = maxPointsPerNode;
    this.maxDepth = maxDepth;
    this.positions = positions;
    this.colors = colors;
    this.dimensionLevel = Math.max(1, Math.min(3, dimensionLevel));
    this.childCount = 1 << this.dimensionLevel; // 2, 4, or 8

    // Alpha is packed in colors as RGBA uint8 - no separate array needed
    this.hasPackedAlpha = colors.length === (positions.length / 3) * 4 && colors.BYTES_PER_ELEMENT === 1;
    this.pointCount = positions.length / 3;

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

    console.time('LOD generation');
    this.lodLevels = this._generateLODLevels();
    console.timeEnd('LOD generation');
    this._buildLOD = true;

    const elapsed = performance.now() - startTime;
    notifications.completeCalculation(notifId, `LOD ready (${this.lodLevels.length} levels)`, elapsed);
  }

  ensureLodNodeMappings() {
    if (this._lodNodeMappingsBuilt) return;
    this.ensureLODLevels();

    const notifications = getNotificationCenter();
    const notifId = notifications.startCalculation('Building LOD node mappings', 'calculation');
    const startTime = performance.now();

    this._buildLODNodeMappings();
    this._lodNodeMappingsBuilt = true;

    const elapsed = performance.now() - startTime;
    notifications.completeCalculation(notifId, 'LOD node mappings ready', elapsed);
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

    // Single-pass partitioning: compute child index for each point and store in temp array
    // This avoids redundant position lookups and improves cache locality
    const pointChildren = new Uint8Array(n);
    const childCounts = new Uint32Array(numChildren);

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

      pointChildren[i] = childIdx;
      childCounts[childIdx]++;
    }

    // Pre-allocate child arrays based on counts
    const childIndices = childBounds.map((_, i) =>
      childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
    );
    const childOffsets = new Uint32Array(numChildren);

    // Second pass: distribute points using cached child indices (no position lookups)
    for (let i = 0; i < n; i++) {
      const childIdx = pointChildren[i];
      childIndices[childIdx][childOffsets[childIdx]++] = indices[i];
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
    // Read alpha from packed RGBA colors (4th byte)
    if (this.hasPackedAlpha) {
      let sum = 0;
      const colors = this.colors;
      for (let i = 0; i < indices.length; i++) {
        sum += colors[indices[i] * 4 + 3]; // Alpha is 4th byte (0-255)
      }
      return sum / (indices.length * 255); // Normalize to 0-1
    }
    return 1.0; // No alpha data, default to fully opaque
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

      const positions = new Float32Array(pointCount * 3);
      // Always use RGBA uint8 format - alpha is packed in 4th byte
      const colors = new Uint8Array(pointCount * 4);

      for (let i = 0; i < pointCount; i++) {
        const srcIdx = sampledIndices[i];
        const srcPosIdx = srcIdx * 3;
        const dstPosIdx = i * 3;

        positions[dstPosIdx] = this.positions[srcPosIdx];
        positions[dstPosIdx + 1] = this.positions[srcPosIdx + 1];
        positions[dstPosIdx + 2] = this.positions[srcPosIdx + 2];

        // Copy RGBA directly - alpha is already packed
        const colorSrcIdx = srcIdx * 4;
        const colorDstIdx = i * 4;
        colors[colorDstIdx] = this.colors[colorSrcIdx];
        colors[colorDstIdx + 1] = this.colors[colorSrcIdx + 1];
        colors[colorDstIdx + 2] = this.colors[colorSrcIdx + 2];
        colors[colorDstIdx + 3] = this.colors[colorSrcIdx + 3];
      }

      levels.push({
        depth: levelIdx,
        pointCount,
        positions,
        colors, // RGBA uint8 with alpha packed
        indices: sampledIndices, // Store indices for color updates
        sizes: null,
        isFullDetail: false,
        sizeMultiplier: Math.sqrt(factor) * 0.2 + 0.8
      });
    }

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel] || 'Octree';
    console.log(`[${treeName}] Generated ${levels.length} LOD levels (dim=${this.dimensionLevel}):`,
      levels.map(l => `${l.pointCount.toLocaleString()} pts`).join(', '));

    return levels;
  }

  /**
   * Build a stable hierarchical ordering of all points.
   * Points are ranked so that coarser LOD levels are always strict subsets of finer levels.
   * This prevents "popping" when transitioning between LOD levels.
   *
   * Uses Morton code (Z-order curve) + bit-reversal for optimal spatial distribution:
   * - Morton code groups spatially close points together
   * - Bit-reversal ensures coarse samples are evenly distributed across space
   *
   * Dimension-aware: Uses 1D/2D/3D Morton codes based on dimensionLevel.
   */
  _buildHierarchicalOrder() {
    if (this._hierarchicalOrder) return this._hierarchicalOrder;

    const n = this.pointCount;
    const positions = this.positions;
    const bounds = this.bounds;
    const dimLevel = this.dimensionLevel;

    // Normalize positions to 0-1023 range for 10-bit Morton codes
    const scaleX = 1023 / Math.max(bounds.maxX - bounds.minX, 0.0001);
    const scaleY = 1023 / Math.max(bounds.maxY - bounds.minY, 0.0001);
    const scaleZ = 1023 / Math.max(bounds.maxZ - bounds.minZ, 0.0001);

    // Morton code bit width depends on dimension level:
    // 1D: 10 bits (just x)
    // 2D: 20 bits (x,y interleaved)
    // 3D: 30 bits (x,y,z interleaved)
    const mortonBits = dimLevel * 10;

    // Create array of (index, morton code) pairs
    const ranked = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.floor((positions[i * 3] - bounds.minX) * scaleX) & 1023;
      const y = Math.floor((positions[i * 3 + 1] - bounds.minY) * scaleY) & 1023;
      const z = Math.floor((positions[i * 3 + 2] - bounds.minZ) * scaleZ) & 1023;

      // Compute Morton code based on dimension level
      let morton = 0;
      if (dimLevel === 1) {
        // 1D: Just use x coordinate (10 bits)
        morton = x;
      } else if (dimLevel === 2) {
        // 2D: Interleave x and y bits (20 bits total)
        for (let bit = 0; bit < 10; bit++) {
          morton |= ((x >> bit) & 1) << (bit * 2);
          morton |= ((y >> bit) & 1) << (bit * 2 + 1);
        }
      } else {
        // 3D: Interleave x, y, z bits (30 bits total)
        for (let bit = 0; bit < 10; bit++) {
          morton |= ((x >> bit) & 1) << (bit * 3);
          morton |= ((y >> bit) & 1) << (bit * 3 + 1);
          morton |= ((z >> bit) & 1) << (bit * 3 + 2);
        }
      }

      // Bit-reverse the Morton code for hierarchical ordering
      // This ensures points at index 0, 2, 4... are evenly distributed
      // while points at 1, 3, 5... fill in the gaps
      let reversed = 0;
      let temp = morton;
      for (let bit = 0; bit < mortonBits; bit++) {
        reversed = (reversed << 1) | (temp & 1);
        temp >>= 1;
      }

      ranked[i] = { idx: i, priority: reversed };
    }

    // Sort by bit-reversed Morton code
    ranked.sort((a, b) => a.priority - b.priority);

    // Extract just the indices in priority order
    this._hierarchicalOrder = ranked.map(r => r.idx);
    return this._hierarchicalOrder;
  }

  _stratifiedSample(targetCount) {
    // Use hierarchical ordering for stable, subset-based sampling
    const order = this._buildHierarchicalOrder();

    // Take the first targetCount points from the hierarchical order
    // This ensures coarser LODs are always subsets of finer LODs
    const count = Math.min(targetCount, order.length);
    // Return Uint32Array directly to avoid conversion allocations on LOD level changes
    const sampledIndices = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      sampledIndices[i] = order[i];
    }

    return sampledIndices;
  }

  /**
   * Get LOD level for a given camera distance.
   * @param {number} distance - Camera distance from target
   * @param {number} viewportHeight - Viewport height in pixels
   * @param {number} previousLevel - Previous LOD level for this view (for hysteresis). Pass -1 or undefined for first call.
   * @param {number} dimensionLevel - Current dimension level (1, 2, 3, or 4). Defaults to 3 for backwards compatibility.
   * @param {Object} [overrideBounds] - Optional bounds override for view-specific positions.
   *   When positions differ from octree (e.g., 2D projection), pass actual bounds to get
   *   correct LOD selection. Format: { minX, maxX, minY, maxY, minZ, maxZ }
   * @returns {number} LOD level (0 = highest detail)
   */
  getLODLevel(distance, viewportHeight, previousLevel = -1, dimensionLevel = 3, overrideBounds = null) {
    if (this.lodLevels.length === 0) return -1;

    // Validate dimensionLevel (1=1D, 2=2D, 3=3D+) - clamp to 1-3 range
    // SpatialIndex only supports 1D/2D/3D, so 4D+ is treated as 3D
    const validDimLevel = Math.max(1, Math.min(3, Math.floor(dimensionLevel) || 3));

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
      const extents = [dx, dy, dz].sort((a, b) => b - a);
      dataSize = Math.sqrt(extents[0] * extents[0] + extents[1] * extents[1]) || 1;
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

    return Math.max(0, Math.min(numLevels - 1, newLevel));
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
   * Returns indices into the LOD level's positions array (not original indices).
   * @param {Array} center - [x, y, z] center point
   * @param {number} radius - Search radius
   * @param {number} lodLevel - LOD level to query (0 = lowest detail, max = full detail)
   * @param {number} maxResults - Maximum results to return
   * @param {Float32Array} [customPositions] - Optional custom positions array for view-specific queries
   *   (e.g., 2D projected positions). If provided, queries against these positions instead of
   *   the LOD level's stored positions. Must have same point count as original data.
   * @returns {Array} Array of { lodIndex, position, originalIndex }
   */
  queryRadiusAtLOD(center, radius, lodLevel, maxResults = 64, customPositions = null) {
    if (radius <= 0) return [];

    // Clamp LOD level to valid range
    const numLevels = this.lodLevels.length;
    if (numLevels === 0) {
      // Fall back to full positions query
      const posArray = customPositions || this.positions;
      return this.queryRadius(center, radius, maxResults).map(idx => ({
        lodIndex: idx,
        originalIndex: idx,
        position: [posArray[idx * 3], posArray[idx * 3 + 1], posArray[idx * 3 + 2]]
      }));
    }

    const level = this.lodLevels[Math.max(0, Math.min(lodLevel, numLevels - 1))];
    const pointCount = level.pointCount;
    const isFullDetail = level.isFullDetail;

    // Use custom positions if provided (for 2D/1D view queries), otherwise use LOD level positions
    // When using custom positions, we need to look up by original index, not LOD index
    const useCustomPositions = customPositions !== null;

    const results = [];
    const r2 = radius * radius;

    // Simple brute force over LOD positions (LOD levels are small enough)
    for (let i = 0; i < pointCount && results.length < maxResults; i++) {
      const originalIdx = isFullDetail ? i : level.indices[i];
      let px, py, pz;

      if (useCustomPositions) {
        // Look up position from custom positions array using original index
        px = customPositions[originalIdx * 3];
        py = customPositions[originalIdx * 3 + 1];
        pz = customPositions[originalIdx * 3 + 2];
      } else {
        // Use LOD level's pre-sampled positions
        px = level.positions[i * 3];
        py = level.positions[i * 3 + 1];
        pz = level.positions[i * 3 + 2];
      }

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
   * Pre-compute which LOD buffer vertices belong to each octree leaf node.
   * This eliminates O(LOD points) iteration during frustum culling.
   */
  _buildLODNodeMappings() {
    console.time('LOD node mapping');

    for (let levelIdx = 0; levelIdx < this.lodLevels.length; levelIdx++) {
      const level = this.lodLevels[levelIdx];
      if (level.isFullDetail) continue;

      // Build reverse map: originalIndex -> lodVertexIndex
      const reverseMap = new Map();
      for (let lodVertexIdx = 0; lodVertexIdx < level.indices.length; lodVertexIdx++) {
        reverseMap.set(level.indices[lodVertexIdx], lodVertexIdx);
      }

      // Attach LOD indices to each leaf node
      this._attachLODIndicesToNodes(this.root, levelIdx, reverseMap);
    }

    console.timeEnd('LOD node mapping');
  }

  _attachLODIndicesToNodes(node, levelIdx, reverseMap) {
    if (!node) return;

    if (node.indices) {
      // Leaf node - compute LOD vertex indices for this node
      const lodIndices = [];
      for (let i = 0; i < node.indices.length; i++) {
        const lodVertexIdx = reverseMap.get(node.indices[i]);
        if (lodVertexIdx !== undefined) {
          lodIndices.push(lodVertexIdx);
        }
      }
      // Store as typed array for efficiency
      if (!node.lodIndices) node.lodIndices = {};
      node.lodIndices[levelIdx] = lodIndices.length > 0
        ? new Uint32Array(lodIndices)
        : null;
    } else if (node.children) {
      for (const child of node.children) {
        this._attachLODIndicesToNodes(child, levelIdx, reverseMap);
      }
    }
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

// ============================================================================
// HIGH PERFORMANCE RENDERER (WebGL2 Only)
// ============================================================================

/**
 * Configuration options for the renderer
 */
export const RendererConfig = {
  // Quality levels
  QUALITY_ULTRALIGHT: 'ultralight',
  QUALITY_LIGHT: 'light',
  QUALITY_FULL: 'full',

  // Feature flags
  USE_INTERLEAVED_BUFFERS: true,
  USE_LOD: false,
  USE_FRUSTUM_CULLING: false,

  // LOD settings
  LOD_MAX_POINTS_PER_NODE: 1000,
  LOD_MAX_DEPTH: 8,
};

/**
 * High-Performance Renderer Class (WebGL2 Only)
 */
export class HighPerfRenderer {
  constructor(gl, options = {}) {
    this.options = { ...RendererConfig, ...options };

    // Must be WebGL2
    if (!gl || typeof gl.createVertexArray !== 'function') {
      throw new Error('WebGL2 context required for HighPerfRenderer');
    }

    this.gl = gl;
    console.log('[HighPerfRenderer] Using WebGL2');

    // Shader programs
    this.programs = {
      full: null,
      light: null,
      ultralight: null
    };

    // Current active program
    this.activeProgram = null;
    this.activeQuality = 'full';

    // Uniform locations cache
    this.uniformLocations = new Map();

    // Data buffers
    this.buffers = {
      interleaved: null,
      positions: null,
      colors: null,
      alphas: null,
    };

    // Alpha texture for efficient alpha-only updates (avoids full buffer rebuild)
    // Using a texture allows updating alpha with texSubImage2D instead of bufferData
    this._alphaTexture = null;
    this._alphaTexWidth = 0;
    this._alphaTexHeight = 0;
    this._alphaTexData = null; // Uint8Array for texture upload
    this._useAlphaTexture = false; // Whether alpha texture is active

    // LOD index textures for alpha lookup (maps LOD vertex index to original index)
    // Dimension-aware: Map<dimensionLevel, Array<{texture, width, height}>>
    this._lodIndexTexturesByDimension = new Map();

    // Dummy 1x1 R32UI texture for when LOD index texture is not used
    // Required because usampler2D uniforms must have a valid unsigned int texture bound
    this._dummyLodIndexTexture = null;

    // LOD system - dimension-aware spatial indexing
    this.spatialIndices = new Map();  // Per-dimension spatial indices: Map<dimensionLevel, SpatialIndex>
    this.lodBuffersByDimension = new Map();  // Per-dimension LOD buffers: Map<dimensionLevel, lodBuffers[]>
    this.currentDimensionLevel = 3;  // Current active dimension level for live view

    // State
    this.pointCount = 0;
    this.forceLODLevel = -1; // -1 = auto, 0+ = forced level
    this.useAdaptiveLOD = this.options.USE_LOD;
    this.useFrustumCulling = this.options.USE_FRUSTUM_CULLING;
    this.useInterleavedBuffers = this.options.USE_INTERLEAVED_BUFFERS;

    // VAO for WebGL2
    this.vao = null;

    // Snapshot buffers for multi-view rendering (avoids re-uploading per frame)
    // Map<snapshotId, { vao, buffer, pointCount }>
    this.snapshotBuffers = new Map();

    // Index buffer for frustum culling (uses element array instead of copying vertex data)
    // Much faster than copying vertex data: 4 bytes/point vs 16 bytes/point
    this.indexBuffer = null;

    // Performance stats
    this.stats = {
      lastFrameTime: 0,
      fps: 0,
      visiblePoints: 0,
      lodLevel: -1,
      gpuMemoryMB: 0,
      drawCalls: 0,
      frustumCulled: false,
      cullPercent: 0,
    };

    // Fog bounds
    this.fogNear = 0;
    this.fogFar = 10;

    // Cached bounding sphere (computed from positions, independent of octree)
    this._boundingSphere = null;

    // Dirty flags for lazy buffer rebuilds (avoids double rebuilds)
    this._bufferDirty = false;
    this._lodBuffersDirty = false;
    // Fast-path flag: when only alpha changed, skip position repacking
    this._alphaOnlyDirty = false;
    this._lodAlphaOnlyDirty = false;

    // Reusable ArrayBuffer to reduce GC pressure
    this._interleavedArrayBuffer = null;
    this._interleavedPositionView = null;
    this._interleavedColorView = null;

    // Pooled frustum planes array (6 planes × 4 components = 24 floats) to avoid allocations
    this._frustumPlanes = [
      new Float32Array(4), new Float32Array(4), new Float32Array(4),
      new Float32Array(4), new Float32Array(4), new Float32Array(4)
    ];

    // Pooled visible indices buffer for frustum culling (grows as needed)
    this._visibleIndicesBuffer = null;
    this._visibleIndicesCapacity = 0;

    // Per-view state for multi-view rendering (frustum culling and LOD)
    // Each view needs its own cache to avoid cross-view interference
    this._perViewState = new Map(); // viewId -> { lastFrustumMVP, cachedCulledCount, prevLodLevel }

    this._init();
  }

  _init() {
    const gl = this.gl;

    // Create shader programs
    this._createPrograms();

    // Create VAOs
    this.vao = gl.createVertexArray();

    // Create index buffer for frustum culling (element array buffer)
    // Uses indexed drawing instead of copying vertex data for much better performance
    this.indexBuffer = gl.createBuffer();

    // GL state
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Set default quality
    this.setQuality(this.activeQuality);
  }

  /**
   * Get or create per-view state for multi-view rendering.
   * Each view maintains its own frustum cache, LOD state, index buffer, AND frustum planes to avoid cross-view interference.
   * @param {string|number} viewId - View identifier (defaults to 'default' for single-view mode)
   * @returns {Object} Per-view state object with lastFrustumMVP, cachedCulledCount, prevLodLevel, indexBuffer, frustumPlanes
   */
  _getViewState(viewId = 'default') {
    // Normalize viewId to string to prevent type mismatches between callers
    const vid = String(viewId);
    if (!this._perViewState.has(vid)) {
      // Create per-view index buffer for frustum culling
      const gl = this.gl;
      const indexBuffer = gl.createBuffer();
      this._perViewState.set(vid, {
        lastFrustumMVP: null,
        cachedCulledCount: 0,
        cachedVisibleIndices: null,
        cachedLodVisibleIndices: null,  // For LOD + frustum culling combined
        cachedLodLevel: -1,              // LOD level for which indices were cached
        cachedLodDimension: -1,          // Dimension level for which LOD indices were cached
        cachedLodIsCulled: false,        // Whether cached indices are frustum-culled (vs full LOD)
        cachedVisibleNodes: null,        // Cached octree nodes from frustum culling (reused across LOD level changes)
        prevLodLevel: undefined,         // For logging LOD changes
        lastLodLevel: -1,                // For per-view LOD hysteresis
        lastVisibleCount: undefined,     // For logging visible count changes
        lastDimensionLevel: undefined,   // For cache invalidation on dimension change
        indexBuffer: indexBuffer,        // Per-view index buffer (avoids shared buffer conflicts)
        indexBufferSize: 0,              // Current size of uploaded index buffer
        // Pre-cached index buffer support (eliminates upload on LOD level change)
        usePreCachedIndexBuffer: false,  // Whether to use pre-cached buffer vs per-view buffer
        preCachedIndexBuffer: null,      // Reference to pre-cached buffer from lodBuffers
        // Per-view frustum planes to avoid shared state issues in multi-view rendering
        frustumPlanes: [
          new Float32Array(4), new Float32Array(4), new Float32Array(4),
          new Float32Array(4), new Float32Array(4), new Float32Array(4)
        ],
        // Per-view filter generation for LOD visibility cache invalidation
        // Each view may have different filters (e.g., snapshot views with baked alpha)
        filterGeneration: 0,
        // Per-view LOD visibility cache (avoids cross-view interference in multiview)
        cachedLodVisibility: null,
        cachedLodVisibilityLevel: -1,
        cachedLodVisibilityFilterGen: -1,
        // Per-view visible indices buffer pool (avoids shared buffer issues in multi-view rendering)
        visibleIndicesBuffer: null,
        visibleIndicesCapacity: 0,
        // Per-view stats (avoids stats being overwritten by last rendered view in multiview)
        stats: {
          visiblePoints: 0,
          lodLevel: -1,
          drawCalls: 0,
          frustumCulled: false,
          cullPercent: 0
        }
      });
    }
    return this._perViewState.get(vid);
  }

  /**
   * Clear per-view state for a specific view (call when view is removed)
   * @param {string|number} viewId - View identifier to clear
   */
  clearViewState(viewId) {
    // Normalize viewId to string to prevent type mismatches between callers
    const vid = String(viewId);
    const viewState = this._perViewState.get(vid);
    if (viewState) {
      // Clean up the per-view index buffer
      const gl = this.gl;
      if (viewState.indexBuffer) {
        gl.deleteBuffer(viewState.indexBuffer);
      }
      this._perViewState.delete(vid);
    }
  }

  /**
   * Clear all per-view state (call on data reload or major state reset)
   */
  clearAllViewState() {
    // Clean up all per-view index buffers before clearing
    const gl = this.gl;
    for (const viewState of this._perViewState.values()) {
      if (viewState.indexBuffer) {
        gl.deleteBuffer(viewState.indexBuffer);
      }
    }
    this._perViewState.clear();

    // Also reset global LOD visibility cache (becomes stale with new data/positions)
    this._cachedLodVisibility = null;
    this._cachedLodVisibilityLevel = -1;
    this._cachedLodVisibilityFilterGen = -1;
  }

  /**
   * Compute bounds from a positions array.
   * Used for view-specific positions that differ from octree bounds.
   * @param {Float32Array} positions - XYZ positions (length = n * 3)
   * @returns {Object} Bounds object { minX, maxX, minY, maxY, minZ, maxZ }
   */
  static computeBoundsFromPositions(positions) {
    if (!positions || positions.length < 3) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    }
    let minX = positions[0], maxX = positions[0];
    let minY = positions[1], maxY = positions[1];
    let minZ = positions[2], maxZ = positions[2];

    for (let i = 3; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (y < minY) minY = y; else if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  /**
   * Detect the effective dimension level from bounds.
   * If an axis has very small extent relative to others, the data is lower-dimensional.
   * @param {Object} bounds - Bounds object { minX, maxX, minY, maxY, minZ, maxZ }
   * @returns {number} 1, 2, or 3 for the effective dimension level
   */
  static detectDimensionLevel(bounds) {
    if (!bounds) return 3;

    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    const maxExtent = Math.max(dx, dy, dz);

    if (maxExtent === 0) return 1;

    // Threshold: if an axis is <1% of max extent, consider it flat
    const threshold = maxExtent * 0.01;

    const xFlat = dx < threshold;
    const yFlat = dy < threshold;
    const zFlat = dz < threshold;

    const flatCount = (xFlat ? 1 : 0) + (yFlat ? 1 : 0) + (zFlat ? 1 : 0);

    // flatCount=0 → 3D, flatCount=1 → 2D, flatCount>=2 → 1D
    return Math.max(1, 3 - flatCount);
  }

  _needsLodResources(forceLOD = -1) {
    return (
      this.useAdaptiveLOD ||
      this.forceLODLevel >= 0 ||
      (typeof forceLOD === 'number' && forceLOD >= 0)
    );
  }

  _needsSpatialIndex(forceLOD = -1) {
    // Keep this strictly tied to runtime feature flags.
    // A spatial index is needed for frustum culling or adaptive LOD; forced LOD can use
    // prebuilt buffers without requiring a spatial index build.
    void forceLOD; // Reserved for future per-call logic.
    return this.useFrustumCulling || this.useAdaptiveLOD;
  }

  _createPrograms() {
    console.log('[HighPerfRenderer] Creating WebGL2 shader programs');

    this.programs.full = this._createProgram(HP_VS_FULL, HP_FS_FULL, 'full');
    this.programs.light = this._createProgram(HP_VS_LIGHT, HP_FS_LIGHT, 'light');
    this.programs.ultralight = this._createProgram(HP_VS_LIGHT, HP_FS_ULTRALIGHT, 'ultralight');

    const createdPrograms = Object.entries(this.programs)
      .filter(([_, prog]) => prog !== null)
      .map(([name, _]) => name);
    console.log('[HighPerfRenderer] Created programs:', createdPrograms);

    if (createdPrograms.length === 0) {
      console.error('[HighPerfRenderer] FATAL: No shader programs could be created!');
    }

    for (const [name, program] of Object.entries(this.programs)) {
      if (program) {
        this._cacheUniformLocations(name, program);
      }
    }

    // Create dummy 1x1 R32UI texture for usampler2D when LOD index texture is not used
    // This prevents "Two textures of different types use the same sampler location" error
    this._createDummyLodIndexTexture();
  }

  /**
   * Create a dummy 1x1 R32UI texture to bind when LOD index texture is not in use.
   * Required because usampler2D uniforms must have a valid unsigned integer texture bound,
   * even when the shader doesn't use it (u_useLodIndexTex = false).
   * @private
   */
  _createDummyLodIndexTexture() {
    const gl = this.gl;

    // Delete existing dummy texture if any
    if (this._dummyLodIndexTexture) {
      gl.deleteTexture(this._dummyLodIndexTexture);
    }

    this._dummyLodIndexTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);

    // Create 1x1 R32UI texture with a dummy value
    const dummyData = new Uint32Array([0]);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32UI,
      1, 1, 0,
      gl.RED_INTEGER, gl.UNSIGNED_INT, dummyData
    );

    // Set filtering to NEAREST (required for integer textures)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _createProgram(vsSource, fsSource, name = 'unknown') {
    const gl = this.gl;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error(`[HighPerfRenderer] Vertex shader error (${name}):`, gl.getShaderInfoLog(vs));
      gl.deleteShader(vs);
      return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error(`[HighPerfRenderer] Fragment shader error (${name}):`, gl.getShaderInfoLog(fs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(`[HighPerfRenderer] Program link error (${name}):`, gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return program;
  }

  _cacheUniformLocations(programName, program) {
    const gl = this.gl;
    const uniforms = {};

    const uniformNames = [
      'u_mvpMatrix', 'u_viewMatrix', 'u_modelMatrix', 'u_projectionMatrix',
      'u_pointSize', 'u_sizeAttenuation', 'u_viewportHeight', 'u_fov',
      'u_lightingStrength', 'u_fogDensity', 'u_fogNear', 'u_fogFar',
      'u_fogColor', 'u_lightDir',
      // Alpha texture uniforms for efficient alpha-only updates
      'u_alphaTex', 'u_alphaTexWidth', 'u_invAlphaTexWidth', 'u_useAlphaTex',
      // LOD index texture uniforms (for mapping LOD vertex to original index)
      'u_lodIndexTex', 'u_lodIndexTexWidth', 'u_invLodIndexTexWidth', 'u_useLodIndexTex'
    ];

    for (const name of uniformNames) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.uniformLocations.set(programName, uniforms);
  }

  setQuality(quality) {
    const validQualities = ['full', 'light', 'ultralight'];
    if (!validQualities.includes(quality)) {
      console.warn(`Invalid quality "${quality}", using "full"`);
      quality = 'full';
    }

    this.activeQuality = quality;
    this.activeProgram = this.programs[quality];

    if (this.activeProgram) {
      this.gl.useProgram(this.activeProgram);
    }
  }

  loadData(positions, colors, options = {}) {
    const gl = this.gl;
    // Only build spatial index if LOD/frustum culling is currently enabled at runtime
    const defaultBuildSpatialIndex = this.useAdaptiveLOD || this.useFrustumCulling;
    const buildSpatialIndex = options.buildSpatialIndex ?? defaultBuildSpatialIndex;
    const { dimensionLevel } = options;  // Caller should specify dimension level

    // Clear per-dimension spatial indices cache when loading new data
    this.spatialIndices.clear();
    this._clearLodBuffers();  // Properly delete GL buffers before clearing
    this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures
    // Use provided dimensionLevel, or keep current if not specified
    if (dimensionLevel !== undefined) {
      this.currentDimensionLevel = Math.max(1, Math.min(3, dimensionLevel));
    }

    this.pointCount = positions.length / 3;
    console.log(`[HighPerfRenderer] Loading ${this.pointCount.toLocaleString()} points...`);

    // Normalize colors to RGBA Uint8Array format
    // This ensures all downstream code can safely assume 4-component colors
    // Handle both Uint8Array (0-255) and Float32Array (0-1) inputs
    const expectedRGBA = this.pointCount * 4;
    const expectedRGB = this.pointCount * 3;
    let normalizedColors = colors;

    // Detect float colors (Float32Array or values in 0-1 range)
    const isFloatArray = colors.BYTES_PER_ELEMENT === 4 && colors instanceof Float32Array;
    const scale = isFloatArray ? 255 : 1;  // Scale 0-1 float to 0-255 uint8

    if (isFloatArray && scale !== 1) {
      console.log('[HighPerfRenderer] Detected float colors (0-1 range), converting to uint8 (0-255)');
    }

    if (colors.length === expectedRGB) {
      // Convert RGB to RGBA (add alpha = 255)
      console.log('[HighPerfRenderer] Converting RGB colors to RGBA');
      normalizedColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < this.pointCount; i++) {
        // Clamp to 0-255 to prevent wrap-around for out-of-range values
        const r = Math.round(colors[i * 3] * scale);
        const g = Math.round(colors[i * 3 + 1] * scale);
        const b = Math.round(colors[i * 3 + 2] * scale);
        normalizedColors[i * 4]     = r > 255 ? 255 : (r < 0 ? 0 : r);
        normalizedColors[i * 4 + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
        normalizedColors[i * 4 + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
        normalizedColors[i * 4 + 3] = 255; // Fully opaque
      }
    } else if (colors.length === expectedRGBA) {
      // RGBA - may need to convert from float to uint8
      if (isFloatArray) {
        normalizedColors = new Uint8Array(expectedRGBA);
        for (let i = 0; i < expectedRGBA; i++) {
          // Clamp to 0-255 to prevent wrap-around for out-of-range values
          const val = Math.round(colors[i] * scale);
          normalizedColors[i] = val > 255 ? 255 : (val < 0 ? 0 : val);
        }
      }
      // else: already Uint8Array RGBA, use as-is
    } else {
      console.error(`[HighPerfRenderer] Invalid colors array length: ${colors.length}, expected ${expectedRGBA} (RGBA) or ${expectedRGB} (RGB)`);
      // Return early to prevent downstream errors from mismatched data
      return this.stats;
    }

    // Store references to original data for frustum culling
    // Alpha is packed in colors as RGBA uint8 - no separate array needed
    this._positions = positions;
    this._colors = normalizedColors;

    this._firstRenderDone = false;

    // Clear all per-view state (cached frustum culling indices become invalid with new data)
    this.clearAllViewState();

    const startTime = performance.now();

    // Build spatial index for LOD and/or frustum culling
    // Use dimension-aware spatial index (1D=BinaryTree, 2D=Quadtree, 3D=Octree)
    if (buildSpatialIndex && this.pointCount > 10000) {
      console.log(`[HighPerfRenderer] Building ${this.currentDimensionLevel}D spatial index for LOD/frustum culling...`);

      // Use the dimension-aware spatial index system
      // This creates the correct tree structure (BinaryTree/Quadtree/Octree) based on dimension
      const spatialIndex = this.getSpatialIndexForDimension(this.currentDimensionLevel, positions, normalizedColors);

      // Reset LOD state when new data is loaded
      if (spatialIndex) {
        spatialIndex._lastLODLevel = undefined;

        // Reuse spatial index's bounding sphere (avoids duplicate bounds computation)
        this._boundingSphere = spatialIndex.getBoundingSphere();
      }
    } else {
      // No spatial index - compute bounding sphere directly for consistent fog
      this._boundingSphere = this._computeBoundingSphere(positions);
    }

    // Create main data buffers
    this._createInterleavedBuffer(positions, normalizedColors);

    // Create alpha texture for efficient alpha-only updates
    this._createAlphaTexture(this.pointCount);

    // Create LOD index textures if using LOD (check runtime state)
    const currentSpatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
    if ((this.useAdaptiveLOD || this.options.USE_LOD) && currentSpatialIndex) {
      this._createLODIndexTextures(this.currentDimensionLevel);
    }

    const elapsed = performance.now() - startTime;
    console.log(`[HighPerfRenderer] Data loaded in ${elapsed.toFixed(1)}ms`);

    // Calculate GPU memory usage
    const bytesPerPoint = 16; // interleaved (12 bytes position + 4 bytes RGBA)
    this.stats.gpuMemoryMB = (this.pointCount * bytesPerPoint) / (1024 * 1024);

    const lodBuffers = this.getLodBuffersForDimension(this.currentDimensionLevel);
    for (const lod of lodBuffers) {
      this.stats.gpuMemoryMB += (lod.pointCount * 16) / (1024 * 1024);
    }

    return this.stats;
  }

  /**
   * Get or create a spatial index for a specific dimension level.
   * Spatial indices are cached per dimension for efficient multiview rendering.
   * @param {number} dimensionLevel - Dimension level (1, 2, or 3)
   * @param {Float32Array} [positions] - Positions to use (defaults to _positions)
   * @param {Uint8Array} [colors] - Colors to use (defaults to _colors)
   * @returns {SpatialIndex|null} Spatial index for the dimension, or null if data not available
   */
  getSpatialIndexForDimension(dimensionLevel, positions = null, colors = null) {
    const dim = Math.max(1, Math.min(3, dimensionLevel));
    const pos = positions || this._positions;
    const col = colors || this._colors;
    const needsLOD = this._needsLodResources();

    if (!pos || !col) {
      return null;
    }

    // Check if we have a cached spatial index for this dimension
    if (this.spatialIndices.has(dim)) {
      const cached = this.spatialIndices.get(dim);
      // Validate cache - check if point count matches
      if (cached.pointCount === pos.length / 3) {
        // If LOD was previously skipped (e.g., built for picking/frustum-only), generate it lazily when needed.
        if (needsLOD && (!cached.lodLevels || cached.lodLevels.length === 0)) {
          cached.ensureLODLevels();
        }

        // Ensure LOD GPU resources exist when LOD is enabled.
        if (needsLOD) {
          const existingLodBuffers = this.lodBuffersByDimension.get(dim);
          if (!existingLodBuffers || existingLodBuffers.length === 0) {
            this._createLODBuffersForDimension(dim, cached);
          }
          const lodIndexTextures = this._getLodIndexTexturesForDimension(dim);
          if (!lodIndexTextures || lodIndexTextures.length === 0) {
            this._createLODIndexTextures(dim);
          }
        }

        return cached;
      }
      // Stale cache - remove it
      console.log(`[HighPerfRenderer] Spatial index for ${dim}D is stale, rebuilding...`);
      this.spatialIndices.delete(dim);
    }

    // Build new spatial index for this dimension
    console.log(`[HighPerfRenderer] Building ${dim}D spatial index...`);
    const notifications = getNotificationCenter();
    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const cellCount = pos.length / 3;
    const notifId = notifications.startCalculation(
      `Building ${dim}D ${treeNames[dim]} for live view (${cellCount.toLocaleString()} cells)`,
      'spatial'
    );

    const startTime = performance.now();
    const spatialIndex = new SpatialIndex(
      pos,
      col,
      dim,
      this.options.LOD_MAX_POINTS_PER_NODE,
      this.options.LOD_MAX_DEPTH,
      {
        buildLOD: needsLOD,
        buildLodNodeMappings: false,
        computeNodeStats: false
      }
    );
    const elapsed = performance.now() - startTime;
    console.log(`[HighPerfRenderer] ${dim}D spatial index built in ${elapsed.toFixed(1)}ms`);
    notifications.completeCalculation(notifId, `${dim}D ${treeNames[dim]} ready (live view)`, elapsed);

    // Cache it
    this.spatialIndices.set(dim, spatialIndex);

    // Also create LOD buffers and index textures for this dimension if LOD is enabled
    if (needsLOD) {
      this._createLODBuffersForDimension(dim, spatialIndex);
      // CRITICAL: Also create LOD index textures for this dimension
      // These are needed for alpha lookup in LOD mode (maps LOD vertex → original index)
      this._createLODIndexTextures(dim);
    }

    return spatialIndex;
  }

  /**
   * Create LOD buffers for a specific dimension's spatial index.
   * @param {number} dimensionLevel - Dimension level
   * @param {SpatialIndex} spatialIndex - The spatial index to create buffers for
   */
  _createLODBuffersForDimension(dimensionLevel, spatialIndex) {
    if (!spatialIndex || !spatialIndex.lodLevels) return;

    const gl = this.gl;
    const lodBuffers = [];

    for (let lvlIdx = 0; lvlIdx < spatialIndex.lodLevels.length; lvlIdx++) {
      const level = spatialIndex.lodLevels[lvlIdx];

      if (level.isFullDetail) {
        // Full detail level uses main buffers
        // Pre-create index buffer for snapshot indexed drawing (contains all point indices 0..n-1)
        const fullDetailIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, fullDetailIndexBuffer);
        // Create sequential indices for full detail (0, 1, 2, ..., pointCount-1)
        const fullDetailIndices = new Uint32Array(level.pointCount);
        for (let i = 0; i < level.pointCount; i++) {
          fullDetailIndices[i] = i;
        }
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, fullDetailIndices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

        lodBuffers.push({
          vao: this.vao,
          buffer: this.buffers.interleaved,
          pointCount: level.pointCount,
          depth: level.depth,
          isFullDetail: true,
          sizeMultiplier: 1.0,
          // Pre-cached index buffer for snapshot rendering (eliminates upload on LOD change)
          originalIndexBuffer: fullDetailIndexBuffer,
          originalIndexCount: level.pointCount
        });
        continue;
      }

      const pointCount = level.pointCount;

      // Interleaved buffer: [x,y,z (float32), r,g,b,a (uint8)] - 16 bytes per point
      // Use ArrayBuffer with two views to correctly pack float positions and uint8 colors
      const buffer = new ArrayBuffer(pointCount * 16);
      const positionView = new Float32Array(buffer);
      const colorView = new Uint8Array(buffer);

      // LOD colors are always RGBA uint8 with alpha packed
      for (let i = 0; i < pointCount; i++) {
        const srcPosIdx = i * 3;
        const floatOffset = i * 4;
        const byteOffset = i * 16 + 12;

        positionView[floatOffset] = level.positions[srcPosIdx];
        positionView[floatOffset + 1] = level.positions[srcPosIdx + 1];
        positionView[floatOffset + 2] = level.positions[srcPosIdx + 2];

        // Copy RGBA directly - alpha is already packed in 4th byte
        const colorSrcIdx = i * 4;
        colorView[byteOffset] = level.colors[colorSrcIdx];
        colorView[byteOffset + 1] = level.colors[colorSrcIdx + 1];
        colorView[byteOffset + 2] = level.colors[colorSrcIdx + 2];
        colorView[byteOffset + 3] = level.colors[colorSrcIdx + 3];
      }

      const glBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);

      // Create VAO for this LOD level
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      const STRIDE = 16;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);

      gl.bindVertexArray(null);

      // Pre-create index buffer for snapshot indexed drawing
      // Contains original point indices from level.indices for drawElements calls
      // This eliminates the need to upload indices on every LOD level change
      let originalIndexBuffer = null;
      let originalIndexCount = 0;
      if (level.indices && level.indices.length > 0) {
        originalIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, originalIndexBuffer);
        // level.indices contains original point indices (Uint32Array)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, level.indices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        originalIndexCount = level.indices.length;
      }

      lodBuffers.push({
        vao,
        buffer: glBuffer,
        pointCount,
        depth: level.depth,
        isFullDetail: false,
        sizeMultiplier: level.sizeMultiplier || 1.0,
        // Pre-cached index buffer for snapshot rendering (eliminates upload on LOD change)
        originalIndexBuffer,
        originalIndexCount
      });
    }

    this.lodBuffersByDimension.set(dimensionLevel, lodBuffers);
    console.log(`[HighPerfRenderer] Created ${lodBuffers.length} LOD buffers for ${dimensionLevel}D (with pre-cached index buffers)`);
  }

  /**
   * Get LOD buffers for a specific dimension level.
   * Creates them if they don't exist and spatial index is available.
   * @param {number} dimensionLevel - Dimension level (1, 2, or 3)
   * @returns {Array} LOD buffers array for the dimension (may be empty)
   */
  getLodBuffersForDimension(dimensionLevel) {
    const dim = Math.max(1, Math.min(3, dimensionLevel));

    // Check if we already have LOD buffers for this dimension
    if (this.lodBuffersByDimension.has(dim)) {
      return this.lodBuffersByDimension.get(dim);
    }

    // Try to create them if spatial index exists
    const spatialIndex = this.spatialIndices.get(dim);
    if (spatialIndex && (this.useAdaptiveLOD || this.options.USE_LOD)) {
      this._createLODBuffersForDimension(dim, spatialIndex);
      // Also create LOD index textures for this dimension if not already present
      const lodIndexTextures = this._getLodIndexTexturesForDimension(dim);
      if (!lodIndexTextures || lodIndexTextures.length === 0) {
        this._createLODIndexTextures(dim);
      }
      return this.lodBuffersByDimension.get(dim) || [];
    }

    return [];
  }

  /**
   * Set the current dimension level for the live view.
   * This determines which spatial index is used for rendering.
   * @param {number} dimensionLevel - Dimension level (1, 2, or 3)
   */
  setDimensionLevel(dimensionLevel) {
    const dim = Math.max(1, Math.min(3, dimensionLevel));
    if (dim !== this.currentDimensionLevel) {
      console.log(`[HighPerfRenderer] Switching from ${this.currentDimensionLevel}D to ${dim}D`);
      this.currentDimensionLevel = dim;
      // Spatial index will be created lazily when needed (LOD/frustum culling enabled)
    }
  }

  /**
   * Update positions only (for dimension switching) - keeps existing colors and transparency
   * More efficient than full loadData when only positions change
   * @param {Float32Array} positions - New positions array (n_points * 3)
   * @param {number} [dimensionLevel] - Optional dimension level (1, 2, or 3). Defaults to current.
   */
  updatePositions(positions, dimensionLevel = null) {
    if (!positions) return;

    const expectedLength = this.pointCount * 3;
    if (positions.length !== expectedLength) {
      console.error(`[HighPerfRenderer] updatePositions: expected ${expectedLength} floats, got ${positions.length}`);
      return;
    }

    // Update dimension level if provided
    const newDimLevel = dimensionLevel ? Math.max(1, Math.min(3, dimensionLevel)) : this.currentDimensionLevel;
    const dimensionChanged = newDimLevel !== this.currentDimensionLevel;
    this.currentDimensionLevel = newDimLevel;

    console.log(`[HighPerfRenderer] Updating positions for ${this.pointCount.toLocaleString()} points (dim=${newDimLevel})...`);
    const startTime = performance.now();

    // Store new positions
    this._positions = positions;

    // Clear per-view frustum cache (positions changed)
    this.clearAllViewState();
    this._firstRenderDone = false;

    // Clear spatial indices cache - positions changed, all cached indices are stale
    // We'll rebuild lazily when needed
    this.spatialIndices.clear();
    this._clearLodBuffers();  // Properly delete GL buffers before clearing
    this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures

    // Update bounding sphere
    this._boundingSphere = this._computeBoundingSphere(positions);

    // Rebuild interleaved buffer with new positions (keeps existing colors)
    if (this._colors) {
      this._createInterleavedBuffer(positions, this._colors);
    }

    // Rebuild spatial index only if LOD/frustum culling is currently enabled at runtime
    // Don't check initial options - only rebuild if feature is actually active
    const needsSpatialIndex = this._needsSpatialIndex();
    if (needsSpatialIndex && this.pointCount > 10000) {
      if (this._colors) {
        console.log(`[HighPerfRenderer] Rebuilding ${newDimLevel}D spatial index for new positions...`);
        // Use dimension-aware spatial index
        const spatialIndex = this.getSpatialIndexForDimension(newDimLevel, positions, this._colors);
        if (spatialIndex) {
          spatialIndex._lastLODLevel = undefined;
          this._boundingSphere = spatialIndex.getBoundingSphere();

          // Rebuild LOD index textures if LOD is enabled
          if (this.useAdaptiveLOD || this.options.USE_LOD) {
            this._createLODIndexTextures(newDimLevel);
          }
        }
      }
    }
    // Note: spatialIndices cache was already cleared above, so stale indices are already gone

    const elapsed = performance.now() - startTime;
    console.log(`[HighPerfRenderer] Positions updated in ${elapsed.toFixed(1)}ms`);
  }

  /**
   * Rebuild spatial index for all dimensions (called when positions change or on demand)
   */
  rebuildSpatialIndex() {
    if (!this._positions || !this._colors) return;

    // Only rebuild if LOD/frustum culling is currently enabled at runtime
    const needsSpatialIndex = this._needsSpatialIndex();
    if (needsSpatialIndex && this.pointCount > 10000) {
      console.log(`[HighPerfRenderer] Rebuilding ${this.currentDimensionLevel}D spatial index...`);

      // Clear spatial indices cache - will rebuild for current dimension
      this.spatialIndices.clear();
      this._clearLodBuffers();  // Properly delete GL buffers before clearing
      this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures

      // Use dimension-aware spatial index
      const spatialIndex = this.getSpatialIndexForDimension(this.currentDimensionLevel);
      if (spatialIndex) {
        spatialIndex._lastLODLevel = undefined;
        this._boundingSphere = spatialIndex.getBoundingSphere();

        // Clear all per-view caches since spatial index structure changed
        this.clearAllViewState();

        // Reset forced LOD level when spatial index changes - old level may be invalid
        if (this.forceLODLevel >= 0) {
          console.log('[HighPerfRenderer] Resetting forceLODLevel to auto (-1) after spatial index rebuild');
          this.forceLODLevel = -1;
        }

        // Rebuild LOD index textures if LOD is enabled
        if (this.useAdaptiveLOD || this.options.USE_LOD) {
          this._createLODIndexTextures(this.currentDimensionLevel);
        }
      }
    }
  }

  _createInterleavedBuffer(positions, colors) {
    const gl = this.gl;
    const pointCount = positions.length / 3;
    const requiredSize = pointCount * 16; // 16 bytes per point

    // Reuse pooled ArrayBuffer if size matches, otherwise allocate new one
    // This reduces GC pressure during frequent dimension switching / reloads
    let buffer, positionView, colorView;
    if (this._interleavedArrayBuffer && this._interleavedArrayBuffer.byteLength === requiredSize) {
      buffer = this._interleavedArrayBuffer;
      positionView = this._interleavedPositionView;
      colorView = this._interleavedColorView;
    } else {
      // Create interleaved buffer: [x,y,z (float32), r,g,b,a (uint8)] per point (16 bytes)
      buffer = new ArrayBuffer(requiredSize);
      positionView = new Float32Array(buffer);
      colorView = new Uint8Array(buffer);
      // Cache for reuse
      this._interleavedArrayBuffer = buffer;
      this._interleavedPositionView = positionView;
      this._interleavedColorView = colorView;
    }

    // colors is Uint8Array with RGBA packed (4 bytes per point) - alpha is in 4th byte
    for (let i = 0; i < pointCount; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4; // 16 bytes / 4 = 4 floats per point
      const byteOffset = i * 16 + 12; // color starts at byte 12 within each 16-byte block

      // Position (3 floats = 12 bytes)
      positionView[floatOffset] = positions[srcIdx];
      positionView[floatOffset + 1] = positions[srcIdx + 1];
      positionView[floatOffset + 2] = positions[srcIdx + 2];

      // Color RGBA (4 uint8 = 4 bytes) - colors is already Uint8Array with RGBA
      const colorSrcIdx = i * 4;
      colorView[byteOffset] = colors[colorSrcIdx];
      colorView[byteOffset + 1] = colors[colorSrcIdx + 1];
      colorView[byteOffset + 2] = colors[colorSrcIdx + 2];
      colorView[byteOffset + 3] = colors[colorSrcIdx + 3];
    }

    if (!this.buffers.interleaved) {
      this.buffers.interleaved = gl.createBuffer();
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);

    // Setup VAO
    gl.bindVertexArray(this.vao);
    this._setupInterleavedAttributes();
    gl.bindVertexArray(null);
  }

  _setupInterleavedAttributes() {
    const gl = this.gl;
    const STRIDE = 16; // 12 bytes position + 4 bytes color

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);

    // Position (location 0): 3 floats at offset 0
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);

    // Color RGBA (location 1): 4 uint8 at offset 12, normalized to 0.0-1.0
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);

    // Note: Alpha is now packed in color as the 4th component, no separate attribute needed
  }

  /**
   * Create or resize the alpha texture for efficient alpha-only updates.
   * Uses R8 format (1 byte per point) instead of rebuilding the 16-byte interleaved buffer.
   * @param {number} pointCount - Number of points to allocate for
   */
  _createAlphaTexture(pointCount) {
    const gl = this.gl;

    // Calculate texture dimensions (use power-of-2 width for better GPU compatibility)
    // Max texture size is typically 4096-16384, so we use a 2D layout
    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxWidth = Math.min(4096, maxTexSize);
    this._alphaTexWidth = Math.min(pointCount, maxWidth);
    this._alphaTexHeight = Math.ceil(pointCount / this._alphaTexWidth);

    // Check if the required height exceeds GPU limits
    // If so, disable alpha texture and fall back to buffer-based alpha
    if (this._alphaTexHeight > maxTexSize) {
      console.warn(`[HighPerfRenderer] Point count ${pointCount.toLocaleString()} exceeds alpha texture capacity (max ${maxTexSize}x${maxTexSize}). Falling back to buffer-based alpha.`);
      // Delete existing texture to prevent VRAM leak (e.g., smaller dataset → larger dataset overflow)
      if (this._alphaTexture) {
        gl.deleteTexture(this._alphaTexture);
      }
      this._useAlphaTexture = false;
      this._alphaTexture = null;
      this._alphaTexData = null;
      return;
    }

    // Allocate texture data buffer (reuse if same size)
    const requiredSize = this._alphaTexWidth * this._alphaTexHeight;
    if (!this._alphaTexData || this._alphaTexData.length !== requiredSize) {
      this._alphaTexData = new Uint8Array(requiredSize);
      // Initialize to fully opaque
      this._alphaTexData.fill(255);
    }

    // Create or reuse texture
    if (!this._alphaTexture) {
      this._alphaTexture = gl.createTexture();
    }

    gl.bindTexture(gl.TEXTURE_2D, this._alphaTexture);

    // Use R8 format (single channel, 1 byte per texel) - WebGL2 only
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8,
      this._alphaTexWidth, this._alphaTexHeight, 0,
      gl.RED, gl.UNSIGNED_BYTE, this._alphaTexData
    );

    // Use NEAREST filtering for exact texel fetch (no interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, null);

    console.log(`[HighPerfRenderer] Created alpha texture: ${this._alphaTexWidth}x${this._alphaTexHeight} (${pointCount} points)`);
  }

  /**
   * Update the alpha texture with new alpha values.
   * Uses texSubImage2D for efficient partial updates (much faster than bufferData).
   * @param {Float32Array} alphas - Alpha values (0.0-1.0) for each point
   */
  _updateAlphaTexture(alphas) {
    const gl = this.gl;
    const n = Math.min(this.pointCount, alphas.length);

    // Convert float alphas to uint8 and store in texture data
    // Using bitwise OR for fast rounding (avoids Math.round() overhead on millions of points)
    // Clamp to 0-255 to prevent wrap-around for out-of-range values (e.g., alpha > 1.0)
    for (let i = 0; i < n; i++) {
      const val = (alphas[i] * 255 + 0.5) | 0;
      this._alphaTexData[i] = val > 255 ? 255 : (val < 0 ? 0 : val);
    }

    // Upload to texture using texSubImage2D (faster than full texImage2D)
    gl.bindTexture(gl.TEXTURE_2D, this._alphaTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      0, 0, this._alphaTexWidth, this._alphaTexHeight,
      gl.RED, gl.UNSIGNED_BYTE, this._alphaTexData
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._useAlphaTexture = true;
  }

  /**
   * Create LOD index textures for alpha lookup for a specific dimension.
   * Each LOD level needs a texture mapping its vertex indices to original point indices.
   * @param {number} [dimensionLevel] - Dimension level to create textures for (defaults to currentDimensionLevel)
   */
  _createLODIndexTextures(dimensionLevel = this.currentDimensionLevel) {
    const gl = this.gl;
    const dim = dimensionLevel;

    // Clean up existing textures for this dimension only
    const existingTextures = this._lodIndexTexturesByDimension.get(dim);
    if (existingTextures) {
      for (const tex of existingTextures) {
        if (tex.texture) gl.deleteTexture(tex.texture);
      }
    }

    // Get spatial index for the specified dimension
    const spatialIndex = this.spatialIndices.get(dim);
    if (!spatialIndex || !spatialIndex.lodLevels) {
      this._lodIndexTexturesByDimension.set(dim, []);
      return;
    }

    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxWidth = Math.min(4096, maxTexSize);  // Clamp width to 4096 for better GPU compatibility
    const lodIndexTextures = [];

    for (let lvlIdx = 0; lvlIdx < spatialIndex.lodLevels.length; lvlIdx++) {
      const level = spatialIndex.lodLevels[lvlIdx];

      if (level.isFullDetail || !level.indices) {
        // Full detail uses gl_VertexID directly, no index texture needed
        lodIndexTextures.push({ texture: null, width: 0, height: 0 });
        continue;
      }

      const pointCount = level.indices.length;
      const texWidth = Math.min(pointCount, maxWidth);
      const texHeight = Math.ceil(pointCount / texWidth);

      // Check if texture height exceeds GPU limits (use actual MAX_TEXTURE_SIZE, not clamped width)
      if (texHeight > maxTexSize) {
        console.warn(`[HighPerfRenderer] LOD level ${lvlIdx} index count ${pointCount.toLocaleString()} exceeds texture capacity (${maxTexSize}x${maxTexSize}). Skipping index texture.`);
        lodIndexTextures.push({ texture: null, width: 0, height: 0 });
        continue;
      }

      const texSize = texWidth * texHeight;

      // Create Uint32 texture to store indices (R32UI format)
      // Using unsigned integer for exact representation of indices up to 4 billion
      // Float32 only has 24-bit mantissa, losing precision for indices > 16,777,216
      const indexData = new Uint32Array(texSize);
      for (let i = 0; i < pointCount; i++) {
        indexData[i] = level.indices[i];
      }

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R32UI,
        texWidth, texHeight, 0,
        gl.RED_INTEGER, gl.UNSIGNED_INT, indexData
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      lodIndexTextures.push({ texture, width: texWidth, height: texHeight });
    }

    this._lodIndexTexturesByDimension.set(dim, lodIndexTextures);
    console.log(`[HighPerfRenderer] Created ${lodIndexTextures.filter(t => t.texture).length} LOD index textures for ${dim}D`);
  }

  /**
   * Get LOD index textures for a specific dimension level.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3)
   * @returns {Array} LOD index textures array for the dimension (may be empty)
   */
  _getLodIndexTexturesForDimension(dimensionLevel) {
    return this._lodIndexTexturesByDimension.get(dimensionLevel) || [];
  }

  /**
   * Clear all LOD index textures (all dimensions).
   * Call this when spatial indices or LOD buffers are cleared.
   */
  _clearLodIndexTextures() {
    const gl = this.gl;
    for (const lodIndexTextures of this._lodIndexTexturesByDimension.values()) {
      for (const tex of lodIndexTextures) {
        if (tex.texture) gl.deleteTexture(tex.texture);
      }
    }
    this._lodIndexTexturesByDimension.clear();
  }

  /**
   * Clear all LOD buffers (all dimensions), properly deleting GL resources.
   * Call this before clearing spatial indices or when data changes.
   * @private
   */
  _clearLodBuffers() {
    const gl = this.gl;
    for (const lodBuffers of this.lodBuffersByDimension.values()) {
      for (const lod of lodBuffers) {
        // CRITICAL: Don't delete buffer for full-detail LOD entries!
        // Full-detail LOD stores a reference to this.buffers.interleaved (the main VBO).
        // Deleting it here would corrupt the main buffer, causing subsequent renders to fail.
        if (lod.buffer && !lod.isFullDetail) {
          gl.deleteBuffer(lod.buffer);
        }
        // Full-detail LOD also uses the main VAO (this.vao), so don't delete it either.
        // Only delete VAOs created specifically for reduced LOD levels.
        if (lod.vao && !lod.isFullDetail) {
          gl.deleteVertexArray(lod.vao);
        }
        // Index buffers are always LOD-specific, safe to delete for all levels
        if (lod.originalIndexBuffer) {
          gl.deleteBuffer(lod.originalIndexBuffer);
        }
      }
    }
    this.lodBuffersByDimension.clear();
  }

  updateColors(colors) {
    // Note: Reference check removed - callers often modify arrays in-place,
    // so same reference doesn't mean same content.
    if (!colors) return;

    // Normalize colors to RGBA Uint8Array format (same logic as loadData)
    // Handle both Uint8Array (0-255) and Float32Array (0-1) inputs
    const expectedRGBA = this.pointCount * 4;
    const expectedRGB = this.pointCount * 3;
    let normalizedColors = colors;

    // Detect float colors (Float32Array or values in 0-1 range)
    const isFloatArray = colors.BYTES_PER_ELEMENT === 4 && colors instanceof Float32Array;
    const scale = isFloatArray ? 255 : 1;  // Scale 0-1 float to 0-255 uint8

    if (colors.length === expectedRGB) {
      // Convert RGB to RGBA (add alpha = 255)
      normalizedColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < this.pointCount; i++) {
        // Clamp to 0-255 to prevent wrap-around for out-of-range values
        const r = Math.round(colors[i * 3] * scale);
        const g = Math.round(colors[i * 3 + 1] * scale);
        const b = Math.round(colors[i * 3 + 2] * scale);
        normalizedColors[i * 4]     = r > 255 ? 255 : (r < 0 ? 0 : r);
        normalizedColors[i * 4 + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
        normalizedColors[i * 4 + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
        normalizedColors[i * 4 + 3] = 255;
      }
    } else if (colors.length === expectedRGBA) {
      // RGBA - may need to convert from float to uint8
      if (isFloatArray) {
        normalizedColors = new Uint8Array(expectedRGBA);
        for (let i = 0; i < expectedRGBA; i++) {
          // Clamp to 0-255 to prevent wrap-around for out-of-range values
          const val = Math.round(colors[i] * scale);
          normalizedColors[i] = val > 255 ? 255 : (val < 0 ? 0 : val);
        }
      }
      // else: already Uint8Array RGBA, use as-is
    } else {
      console.error(`[HighPerfRenderer] updateColors: Invalid array length: ${colors.length}, expected ${expectedRGBA} (RGBA) or ${expectedRGB} (RGB)`);
      return;  // Early return on invalid input
    }

    this._colors = normalizedColors; // Uint8Array with RGBA packed
    this._currentAlphas = null; // Reset alpha tracking since colors changed

    // Invalidate LOD visibility cache since colors (including alpha) changed
    // This is critical for correct filtering/transparency handling in LOD mode
    this.invalidateLodVisibilityCache();

    // Mark buffers as dirty - actual rebuild deferred to render() to avoid double rebuilds
    this._bufferDirty = true;
    // Mark ALL dimensions' LOD buffers as dirty, not just current dimension
    // This ensures switching dimensions or rendering multi-dimension views shows correct colors
    if (this._hasAnyLodBuffers()) {
      this._lodBuffersDirty = true;
    }
  }

  /**
   * Check if any LOD buffers exist for the current dimension
   * @private
   */
  _hasLodBuffers() {
    const lodBuffers = this.lodBuffersByDimension.get(this.currentDimensionLevel);
    return lodBuffers && lodBuffers.length > 0;
  }

  /**
   * Check if any LOD buffers exist across ALL dimensions
   * Used when marking buffers dirty during color/alpha updates
   * @private
   */
  _hasAnyLodBuffers() {
    for (const lodBuffers of this.lodBuffersByDimension.values()) {
      if (lodBuffers && lodBuffers.length > 0) return true;
    }
    return false;
  }

  updateAlphas(alphas) {
    // Note: Reference check removed - callers often modify arrays in-place,
    // so same reference doesn't mean same content.
    if (!alphas) return;

    this._currentAlphas = alphas; // Track current alphas reference

    // Invalidate combined visibility caches since alpha values changed.
    // NOTE: This bumps _filterGeneration which is used by both getLodVisibilityArray()
    // and getCombinedVisibilityForView(). While LOD visibility is purely spatial and
    // doesn't actually depend on alpha values, the shared _filterGeneration counter
    // is necessary for getCombinedVisibilityForView() cache validity. The minor
    // overhead of LOD visibility cache rebuild (O(n) fill) is acceptable compared
    // to the critical bug of returning stale combined visibility data.
    this.invalidateLodVisibilityCache();

    // Use alpha texture for efficient updates (avoids full buffer rebuild)
    // This is ~16x faster: uploading N bytes vs N*16 bytes
    if (this._alphaTexture) {
      this._updateAlphaTexture(alphas);
      // No need to set buffer dirty flags - texture handles alpha now
      return;
    }

    // Fallback: pack into colors array if no alpha texture (shouldn't happen normally)
    if (!this._colors) return;

    const n = Math.min(this.pointCount, alphas.length);
    for (let i = 0; i < n; i++) {
      // Clamp to 0-255 to prevent wrap-around for out-of-range values
      const val = Math.round(alphas[i] * 255);
      this._colors[i * 4 + 3] = val > 255 ? 255 : (val < 0 ? 0 : val);
    }

    // Use alpha-only fast path if buffer already exists (skip position repacking)
    // Mark ALL dimensions' LOD buffers as dirty (not just current) for consistent multi-view rendering
    if (this._interleavedArrayBuffer) {
      this._alphaOnlyDirty = true;
      if (this._hasAnyLodBuffers()) {
        this._lodAlphaOnlyDirty = true;
      }
    } else {
      this._bufferDirty = true;
      if (this._hasAnyLodBuffers()) {
        this._lodBuffersDirty = true;
      }
    }
  }

  /** Get current colors array reference (for comparison) */
  getCurrentColors() {
    return this._colors;
  }

  /** Get current alphas array reference (for comparison) */
  getCurrentAlphas() {
    return this._currentAlphas;
  }

  /**
   * Force immediate buffer rebuild (use sparingly, prefer letting render() handle it)
   */
  flushBufferUpdates() {
    // Full rebuild takes precedence over alpha-only
    if (this._bufferDirty) {
      this._rebuildInterleavedBuffer();
      this._bufferDirty = false;
      this._alphaOnlyDirty = false; // Clear alpha flag since full rebuild includes it
    } else if (this._alphaOnlyDirty) {
      // Fast path: only update alpha bytes, skip position repacking
      this._updateAlphaOnly();
      this._alphaOnlyDirty = false;
    }

    if (this._lodBuffersDirty) {
      this._rebuildLODBuffersWithCurrentData();
      this._lodBuffersDirty = false;
      this._lodAlphaOnlyDirty = false;
    } else if (this._lodAlphaOnlyDirty) {
      this._updateLODAlphaOnly();
      this._lodAlphaOnlyDirty = false;
    }
  }

  /**
   * LEGACY FALLBACK: update only alpha bytes in existing interleaved buffer.
   * Only used if alpha texture is not available.
   * Prefer _updateAlphaTexture() for better performance.
   */
  _updateAlphaOnly() {
    const gl = this.gl;
    const n = this.pointCount;
    const colors = this._colors;
    const colorView = this._interleavedColorView;

    if (!colorView || !colors) return;

    // Only update the alpha byte at offset 15 in each 16-byte stride
    for (let i = 0; i < n; i++) {
      colorView[i * 16 + 15] = colors[i * 4 + 3];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, this._interleavedArrayBuffer, gl.DYNAMIC_DRAW);
  }

  /**
   * LEGACY FALLBACK: update only alpha bytes in LOD buffers.
   * Only used if alpha texture is not available.
   * Prefer _updateAlphaTexture() for better performance.
   */
  _updateLODAlphaOnly() {
    const gl = this.gl;
    const colors = this._colors;

    if (!this._lodArrayBuffers) return;

    const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
    const lodBuffers = this.getLodBuffersForDimension(this.currentDimensionLevel);
    if (!spatialIndex || !lodBuffers.length) return;

    for (let lvlIdx = 0; lvlIdx < lodBuffers.length; lvlIdx++) {
      const lodBuf = lodBuffers[lvlIdx];
      if (lodBuf.isFullDetail) continue;

      const level = spatialIndex.lodLevels[lvlIdx];
      if (!level || !level.indices) continue;

      const cached = this._lodArrayBuffers[lvlIdx];
      if (!cached) continue;

      const colorView = cached.colorView;
      const pointCount = level.pointCount;

      // Only update the alpha byte using original indices
      for (let i = 0; i < pointCount; i++) {
        const origIdx = level.indices[i];
        colorView[i * 16 + 15] = colors[origIdx * 4 + 3];
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, lodBuf.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, cached.buffer, gl.DYNAMIC_DRAW);
    }
  }

  _rebuildInterleavedBuffer() {
    const gl = this.gl;
    const n = this.pointCount;
    const positions = this._positions;
    const colors = this._colors; // Now Uint8Array with RGBA
    const requiredSize = n * 16;

    // Reuse ArrayBuffer if same size, otherwise allocate new one (reduces GC pressure)
    if (!this._interleavedArrayBuffer || this._interleavedArrayBuffer.byteLength !== requiredSize) {
      this._interleavedArrayBuffer = new ArrayBuffer(requiredSize);
      this._interleavedPositionView = new Float32Array(this._interleavedArrayBuffer);
      this._interleavedColorView = new Uint8Array(this._interleavedArrayBuffer);
    }

    const positionView = this._interleavedPositionView;
    const colorView = this._interleavedColorView;

    // Build interleaved data: [x,y,z (float32), r,g,b,a (uint8)] - 16 bytes per point
    for (let i = 0; i < n; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4;
      const byteOffset = i * 16 + 12;

      positionView[floatOffset] = positions[srcIdx];
      positionView[floatOffset + 1] = positions[srcIdx + 1];
      positionView[floatOffset + 2] = positions[srcIdx + 2];

      // Colors already in uint8 RGBA format
      const colorSrcIdx = i * 4;
      colorView[byteOffset] = colors[colorSrcIdx];
      colorView[byteOffset + 1] = colors[colorSrcIdx + 1];
      colorView[byteOffset + 2] = colors[colorSrcIdx + 2];
      colorView[byteOffset + 3] = colors[colorSrcIdx + 3];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, this._interleavedArrayBuffer, gl.DYNAMIC_DRAW);
  }

  _rebuildLODBuffersWithCurrentData() {
    const gl = this.gl;
    const colors = this._colors; // Now Uint8Array with RGBA

    // Initialize LOD array buffer cache if needed
    if (!this._lodArrayBuffers) {
      this._lodArrayBuffers = [];
    }

    const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
    const lodBuffers = this.getLodBuffersForDimension(this.currentDimensionLevel);
    if (!spatialIndex || !lodBuffers.length) return;

    // Update each non-full-detail LOD buffer
    for (let lvlIdx = 0; lvlIdx < lodBuffers.length; lvlIdx++) {
      const lodBuf = lodBuffers[lvlIdx];
      if (lodBuf.isFullDetail) continue;

      const level = spatialIndex.lodLevels[lvlIdx];
      if (!level || !level.indices) continue;

      const pointCount = level.pointCount;
      const requiredSize = pointCount * 16;

      // Reuse ArrayBuffer if same size (reduces GC pressure)
      let cached = this._lodArrayBuffers[lvlIdx];
      if (!cached || cached.buffer.byteLength !== requiredSize) {
        const buffer = new ArrayBuffer(requiredSize);
        cached = {
          buffer,
          positionView: new Float32Array(buffer),
          colorView: new Uint8Array(buffer)
        };
        this._lodArrayBuffers[lvlIdx] = cached;
      }

      const positionView = cached.positionView;
      const colorView = cached.colorView;

      // Use the indices to sample from current colors
      for (let i = 0; i < pointCount; i++) {
        const origIdx = level.indices[i];
        const floatOffset = i * 4;
        const byteOffset = i * 16 + 12;

        positionView[floatOffset] = level.positions[i * 3];
        positionView[floatOffset + 1] = level.positions[i * 3 + 1];
        positionView[floatOffset + 2] = level.positions[i * 3 + 2];

        // Colors already in uint8 RGBA format
        const colorSrcIdx = origIdx * 4;
        colorView[byteOffset] = colors[colorSrcIdx];
        colorView[byteOffset + 1] = colors[colorSrcIdx + 1];
        colorView[byteOffset + 2] = colors[colorSrcIdx + 2];
        colorView[byteOffset + 3] = colors[colorSrcIdx + 3];
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, lodBuf.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, cached.buffer, gl.DYNAMIC_DRAW);
    }
  }

  setFogRange(near, far) {
    this.fogNear = near;
    this.fogFar = far;
  }

  _computeBoundingSphere(positions) {
    const count = positions.length / 3;
    if (count === 0) return { center: [0, 0, 0], radius: 1 };

    // Compute bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
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

    // Compute center and radius from bounding box
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;

    return { center: [centerX, centerY, centerZ], radius };
  }

  /**
   * Auto-compute fog range based on camera position and bounding sphere.
   * @param {Array} cameraPosition - Camera position [x, y, z]
   * @param {Object} [overrideBounds] - Optional bounds to use instead of global (for snapshot views with custom positions)
   */
  autoComputeFogRange(cameraPosition, overrideBounds = null) {
    let sphere;

    // Use override bounds if provided (e.g., snapshot with custom positions)
    if (overrideBounds) {
      const dx = overrideBounds.maxX - overrideBounds.minX;
      const dy = overrideBounds.maxY - overrideBounds.minY;
      const dz = overrideBounds.maxZ - overrideBounds.minZ;
      const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
      sphere = {
        center: [
          (overrideBounds.minX + overrideBounds.maxX) * 0.5,
          (overrideBounds.minY + overrideBounds.maxY) * 0.5,
          (overrideBounds.minZ + overrideBounds.maxZ) * 0.5
        ],
        radius
      };
    } else {
      // Use cached bounding sphere (computed in loadData), fall back to spatial index or defaults
      if (!this._boundingSphere) {
        const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
        sphere = spatialIndex ? spatialIndex.getBoundingSphere() : null;
      } else {
        sphere = this._boundingSphere;
      }
    }

    if (!sphere) {
      this.fogNear = 0;
      this.fogFar = 10;
      return;
    }

    const dx = cameraPosition[0] - sphere.center[0];
    const dy = cameraPosition[1] - sphere.center[1];
    const dz = cameraPosition[2] - sphere.center[2];
    const distToCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);

    this.fogNear = Math.max(0, distToCenter - sphere.radius);
    this.fogFar = distToCenter + sphere.radius;
  }

  /**
   * Extract frustum planes from MVP matrix.
   * @param {Float32Array} mvpMatrix - Model-View-Projection matrix
   * @param {Array<Float32Array>} [targetPlanes] - Optional per-view planes array to write to (for multi-view rendering)
   * @param {Object} [overrideBounds] - Optional bounds override for view-specific positions (e.g., 2D views).
   *   Format: { minX, maxX, minY, maxY, minZ, maxZ }. When provided, frustum margins use these bounds
   *   instead of global bounding sphere.
   * @returns {Array<Float32Array>} The 6 frustum planes
   */
  extractFrustumPlanes(mvpMatrix, targetPlanes = null, overrideBounds = null) {
    const m = mvpMatrix;
    // Use per-view planes if provided, otherwise fall back to shared planes
    const planes = targetPlanes || this._frustumPlanes;

    // Left plane
    planes[0][0] = m[3] + m[0];
    planes[0][1] = m[7] + m[4];
    planes[0][2] = m[11] + m[8];
    planes[0][3] = m[15] + m[12];

    // Right plane
    planes[1][0] = m[3] - m[0];
    planes[1][1] = m[7] - m[4];
    planes[1][2] = m[11] - m[8];
    planes[1][3] = m[15] - m[12];

    // Bottom plane
    planes[2][0] = m[3] + m[1];
    planes[2][1] = m[7] + m[5];
    planes[2][2] = m[11] + m[9];
    planes[2][3] = m[15] + m[13];

    // Top plane
    planes[3][0] = m[3] - m[1];
    planes[3][1] = m[7] - m[5];
    planes[3][2] = m[11] - m[9];
    planes[3][3] = m[15] - m[13];

    // Near plane
    planes[4][0] = m[3] + m[2];
    planes[4][1] = m[7] + m[6];
    planes[4][2] = m[11] + m[10];
    planes[4][3] = m[15] + m[14];

    // Far plane
    planes[5][0] = m[3] - m[2];
    planes[5][1] = m[7] - m[6];
    planes[5][2] = m[11] - m[10];
    planes[5][3] = m[15] - m[14];

    // Compute scale-aware margin based on bounding sphere or override bounds
    // This ensures the margin is appropriate regardless of scene scale
    // For views with custom positions (different dimensions), use overrideBounds
    let sceneScale;
    if (overrideBounds) {
      // Compute radius from override bounds (handles 1D/2D views correctly)
      const dx = overrideBounds.maxX - overrideBounds.minX;
      const dy = overrideBounds.maxY - overrideBounds.minY;
      const dz = overrideBounds.maxZ - overrideBounds.minZ;
      sceneScale = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
    } else {
      let sphere = this._boundingSphere;
      if (!sphere) {
        const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
        sphere = spatialIndex ? spatialIndex.getBoundingSphere() : null;
      }
      sceneScale = sphere ? sphere.radius : 1.0;
    }
    // Base margin of 2% of scene scale, minimum 0.1 for small scenes
    // Keep margins small for effective culling
    const baseMargin = Math.max(0.1, sceneScale * 0.02);

    // Normalize planes and apply scale-aware margin
    for (let i = 0; i < 6; i++) {
      const plane = planes[i];
      const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
      if (len > 0) {
        plane[0] /= len;
        plane[1] /= len;
        plane[2] /= len;
        plane[3] /= len;
      }
      // Expand planes outward - positive margin pushes planes away from center, enlarging the frustum
      // Use small margins to allow effective culling while preventing edge-case popping
      let planeMargin;
      if (i === 5) {
        // Far plane: small margin to prevent popping at distance
        planeMargin = baseMargin * 0.5;
      } else if (i === 4) {
        // Near plane: tiny margin
        planeMargin = baseMargin * 0.3;
      } else {
        // Side planes (left, right, top, bottom): tiny margin for edge cases
        planeMargin = baseMargin * 0.2;
      }
      plane[3] += planeMargin;
    }

    return planes;
  }

  render(params) {
    if (!this.pointCount || this.pointCount === 0) {
      if (!this._noDataWarned) {
        console.warn('[HighPerfRenderer] No data loaded, skipping render');
        this._noDataWarned = true;
      }
      return this.stats;
    }
    this._noDataWarned = false;

    if (!this.activeProgram) {
      console.error('[HighPerfRenderer] No active shader program');
      return this.stats;
    }

    if (!this.buffers.interleaved) {
      console.error('[HighPerfRenderer] No buffers available');
      return this.stats;
    }

    // Flush any pending buffer updates (deferred from updateColors/updateAlphas)
    // This ensures we only rebuild once even if both were called
    if (this._bufferDirty || this._lodBuffersDirty || this._alphaOnlyDirty || this._lodAlphaOnlyDirty) {
      this.flushBufferUpdates();
    }

    const {
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      projectionMatrix,
      pointSize = 5.0,
      sizeAttenuation = 0.0,
      viewportHeight,
      fov,
      lightingStrength = 0.6,
      fogDensity = 0.5,
      fogColor = [1, 1, 1],
      lightDir = [0.5, 0.7, 0.5],
      cameraDistance = 3.0,
      cameraPosition = [0, 0, 3],
      forceLOD = -1,
      quality = this.activeQuality,
      viewId = 'default',  // Per-view state identifier for multi-view rendering
      dimensionLevel = 3,  // Current dimension level (1, 2, 3, or 4) for LOD/frustum calculations
      overrideBounds = null  // Optional bounds override for view-specific positions (e.g., 2D views)
    } = params;

    // Clamp dimension level to valid range [1, 3] - prevents invalid spatial index lookups
    // and ensures depth test logic works correctly (dimensionLevel 0 would wrongly trigger 2D mode)
    const clampedDimLevel = Math.max(1, Math.min(3, dimensionLevel));

    // Create modified params for helper functions if dimension level was clamped
    // This ensures _checkFrustumCacheValid and other helpers use the valid dimension for cache invalidation
    const effectiveParams = (clampedDimLevel !== dimensionLevel)
      ? { ...params, dimensionLevel: clampedDimLevel }
      : params;

    // Get per-view state for frustum culling and LOD caching
    const viewState = this._getViewState(viewId);

    const gl = this.gl;
    const frameStart = performance.now();

    if (!this._firstRenderDone) {
      console.log('[HighPerfRenderer] First render frame:', {
        pointCount: this.pointCount,
        activeQuality: this.activeQuality,
        pointSize: pointSize,
        viewportHeight: viewportHeight,
        useFrustumCulling: this.useFrustumCulling,
        useAdaptiveLOD: this.useAdaptiveLOD,
        hasSpatialIndex: this.spatialIndices.size > 0
      });
      this._firstRenderDone = true;
    }

    // Auto-compute fog range (use overrideBounds for correct fog in non-3D views)
    if (params.autoFog !== false) {
      this.autoComputeFogRange(cameraPosition, overrideBounds);
    }

    // Set quality if changed
    if (quality !== this.activeQuality) {
      this.setQuality(quality);
    }

    // Get the correct spatial index for this view's dimension level
    // Each dimension (1D, 2D, 3D) needs its own spatial index for correct LOD/frustum culling
    const needsSpatialIndex = this._needsSpatialIndex(forceLOD);
    const spatialIndex = needsSpatialIndex ? this.getSpatialIndexForDimension(clampedDimLevel) : null;
    const lodBuffersForDim = this.getLodBuffersForDimension(clampedDimLevel);

    // Select LOD level based on whether LOD is enabled
    // When LOD is disabled, forceLODLevel is ignored - only params.forceLOD is respected
    // This ensures disabling LOD always returns to full detail (unless explicitly overridden per-render)
    let lodLevel;
    if (this.useAdaptiveLOD) {
      // LOD enabled: Priority is this.forceLODLevel > params.forceLOD > adaptive
      lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
      if (lodLevel < 0 && spatialIndex) {
        // Pass per-view lastLodLevel for hysteresis (prevents oscillation per-view)
        // Also pass clampedDimLevel and overrideBounds for correct 2D/3D diagonal calculation
        lodLevel = spatialIndex.getLODLevel(cameraDistance, viewportHeight, viewState.lastLodLevel, clampedDimLevel, overrideBounds);
      }
    } else {
      // LOD disabled: only respect explicit per-render forceLOD, otherwise full detail
      lodLevel = forceLOD >= 0 ? forceLOD : -1;
    }

    // Always update per-view LOD level for highlight rendering and other consumers
    // This must happen after all LOD selection logic (forced, adaptive, or disabled)
    // NOTE: lastDimensionLevel is NOT set here - it's handled inside _checkFrustumCacheValid
    // to properly detect dimension changes and invalidate the frustum cache
    viewState.lastLodLevel = lodLevel;

    const useFullDetail = lodLevel < 0 || !lodBuffersForDim.length ||
      lodLevel >= lodBuffersForDim.length ||
      (lodBuffersForDim[lodLevel] && lodBuffersForDim[lodLevel].isFullDetail);

    // Debug LOD selection - only log when level changes (per-view tracking)
    if (viewState.prevLodLevel !== lodLevel && spatialIndex && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const lodBuf = lodBuffersForDim[lodLevel];
      const pointCount = lodBuf ? lodBuf.pointCount : this.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      if (DEBUG_LOD_FRUSTUM) console.log(`[LOD] View ${viewId}: level ${viewState.prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode})`);
      viewState.prevLodLevel = lodLevel;
    }

    // Frustum culling can be combined with LOD for maximum performance
    // Each view gets independent frustum culling via its own per-view state and frustum planes
    if (this.useFrustumCulling && spatialIndex) {
      // Use per-view frustum planes to avoid shared state issues in multi-view rendering
      // Pass overrideBounds for correct margin calculation in 1D/2D views
      const frustumPlanes = this.extractFrustumPlanes(mvpMatrix, viewState.frustumPlanes, overrideBounds);

      // Debug: log render path on first frame or when path changes
      const renderPath = useFullDetail ? 'frustum-only' : 'LOD+frustum';
      if (viewState._lastRenderPath !== renderPath) {
        console.log(`[Render] View ${viewId}: ${renderPath} (lodLevel=${lodLevel}, useAdaptiveLOD=${this.useAdaptiveLOD}, lodBuffers=${lodBuffersForDim.length}, dim=${clampedDimLevel})`);
        viewState._lastRenderPath = renderPath;
      }

      // For 2D data (clampedDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD), disable depth testing
      // entirely to prevent draw-order artifacts. When all points have the same Z, depth testing
      // causes visual differences at quadtree boundaries because frustum culling changes the
      // draw order (spatially grouped vs original). Disabling depth writes alone is insufficient.
      const disableDepth = clampedDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
      if (disableDepth) {
        gl.disable(gl.DEPTH_TEST);
      }

      if (useFullDetail) {
        // Full detail: standard frustum culling (use effectiveParams for correct dimension in cache invalidation)
        this._renderWithFrustumCulling(effectiveParams, frustumPlanes, viewState, spatialIndex);
      } else {
        // LOD active: combined LOD + frustum culling for maximum performance
        // Ensure the spatial index has per-node LOD mappings before the fast path.
        spatialIndex.ensureLodNodeMappings();
        this._renderLODWithFrustumCulling(lodLevel, effectiveParams, frustumPlanes, viewState, spatialIndex, lodBuffersForDim);
      }

      // Restore depth testing
      if (disableDepth) {
        gl.enable(gl.DEPTH_TEST);
      }

      this.stats.lastFrameTime = performance.now() - frameStart;
      this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));
      return this.stats;
    }

    // Reset frustum culling stats when not using it
    this.stats.frustumCulled = false;
    this.stats.cullPercent = 0;

    // For 2D data, disable depth testing to prevent draw-order artifacts
    // (consistent with frustum culling path)
    const disableDepth = clampedDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
    if (disableDepth) {
      gl.disable(gl.DEPTH_TEST);
    }

    if (useFullDetail) {
      // Use effectiveParams to ensure consistent dimensionLevel handling with frustum culling path
      // This is critical for correct LOD alpha texture lookups when dimensionLevel was clamped
      this._renderFullDetail(effectiveParams);
    } else {
      // Use effectiveParams to ensure _renderLOD gets the clamped dimensionLevel
      // This prevents incorrect spatial index lookups when dimensionLevel > 3 or < 1
      this._renderLOD(lodLevel, effectiveParams);
    }

    // Restore depth testing
    if (disableDepth) {
      gl.enable(gl.DEPTH_TEST);
    }

    // Update dimension level for non-frustum path (for getCombinedVisibilityForView and other consumers)
    // This is done after rendering to ensure accurate per-view tracking without breaking cache invalidation
    viewState.lastDimensionLevel = clampedDimLevel;

    this.stats.lastFrameTime = performance.now() - frameStart;
    this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));

    return this.stats;
  }

  _renderWithFrustumCulling(params, frustumPlanes, viewState, spatialIndex) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId = 'default',
      dimensionLevel = 3  // For cache invalidation on dimension change (already clamped by caller)
    } = params;

    // One-time validation: ensure spatial index contains all points
    if (!this._spatialIndexValidated && spatialIndex) {
      const validation = spatialIndex.validatePointCount();
      if (!validation.valid) {
        console.error(`[FrustumCulling] Spatial index validation failed - some points may be missing`);
      }
      this._spatialIndexValidated = true;
    }

    const needsUpdate = this._checkFrustumCacheValid(mvpMatrix, viewState, dimensionLevel);

    if (needsUpdate) {
      const visibleNodes = [];
      this._collectVisibleNodes(spatialIndex.root, frustumPlanes, visibleNodes);

      if (visibleNodes.length === 0) {
        // Frustum culling says nothing is visible - this likely means the frustum
        // calculation has edge cases. Fall back to full detail rather than showing nothing.
        // Only log once per view (not every frame)
        if (!viewState._noVisibleNodesWarned) {
          console.warn(`[FrustumCulling] View ${viewId}: No visible nodes - falling back to full detail`);
          viewState._noVisibleNodesWarned = true;
        }
        viewState.cachedCulledCount = 0;
        viewState.cachedVisibleIndices = null;
        this.stats.frustumCulled = false;
        this.stats.cullPercent = 0;
        this._renderFullDetail(params);
        return;
      }

      // Count total visible points first to determine buffer size
      let totalVisible = 0;
      for (const node of visibleNodes) {
        if (node.indices) totalVisible += node.indices.length;
      }

      // Reuse per-view pooled buffer, only grow when capacity exceeded (avoids GC allocations)
      // Using per-view buffer prevents cross-view interference in multi-view rendering
      if (!viewState.visibleIndicesBuffer || viewState.visibleIndicesCapacity < totalVisible) {
        // Grow with 25% headroom to reduce future reallocations
        viewState.visibleIndicesCapacity = Math.ceil(totalVisible * 1.25);
        viewState.visibleIndicesBuffer = new Uint32Array(viewState.visibleIndicesCapacity);
      }

      // Fill the pooled buffer with visible indices
      let writeOffset = 0;
      for (const node of visibleNodes) {
        if (node.indices) {
          viewState.visibleIndicesBuffer.set(node.indices, writeOffset);
          writeOffset += node.indices.length;
        }
      }

      // Create a view of only the used portion (no allocation, just a view)
      const visibleIndices = viewState.visibleIndicesBuffer.subarray(0, totalVisible);

      const visibleRatio = totalVisible / this.pointCount;
      const cullPercent = ((1 - visibleRatio) * 100);
      const visibleCount = visibleIndices.length;

      // If >98% visible, render everything (building culled buffer not worth it)
      if (visibleRatio > 0.98) {
        viewState.cachedCulledCount = 0;
        viewState.cachedVisibleIndices = null;
        viewState._noVisibleNodesWarned = false;  // Reset warning flag
        this.stats.frustumCulled = false;
        this.stats.cullPercent = cullPercent;
        this._renderFullDetail(params);
        return;
      }

      // Log only on significant change (>10% of total points)
      if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleCount, this.pointCount)) {
        console.log(`[FrustumCulling] View ${viewId}: ${visibleCount.toLocaleString()}/${this.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleCount;
      }

      // Store count for cache validation - no need to copy indices since they're uploaded to GPU
      // The indices data is in viewState.indexBuffer (GPU) and visibleIndicesBuffer (pooled CPU buffer)
      viewState.cachedCulledCount = visibleIndices.length;
      viewState._noVisibleNodesWarned = false;  // Reset warning flag since we have visible nodes

      // Upload to per-view index buffer (each view has its own buffer to avoid conflicts)
      this._uploadToViewIndexBuffer(viewState, visibleIndices);
      this.stats.frustumCulled = true;
      this.stats.cullPercent = cullPercent;
    }

    if (!viewState.cachedCulledCount || viewState.cachedCulledCount === 0) {
      this._renderFullDetail(params);
      return;
    }

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      console.warn('[FrustumCulling] No program/uniforms available');
      return;
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    }
    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    }
    if (uniforms.u_modelMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    }
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) {
      gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    }
    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, pointSize);
    }
    if (uniforms.u_sizeAttenuation !== null) {
      gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    }
    if (uniforms.u_viewportHeight !== null) {
      gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    }
    if (uniforms.u_fov !== null) {
      gl.uniform1f(uniforms.u_fov, fov);
    }
    if (uniforms.u_lightingStrength !== null) {
      gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    }
    if (uniforms.u_fogDensity !== null) {
      gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    }
    if (uniforms.u_fogNear !== null) {
      gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    }
    if (uniforms.u_fogFar !== null) {
      gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    }
    if (uniforms.u_fogColor !== null) {
      gl.uniform3fv(uniforms.u_fogColor, fogColor);
    }
    if (uniforms.u_lightDir !== null) {
      gl.uniform3fv(uniforms.u_lightDir, lightDir);
    }

    // Defensive check: ensure index buffer is valid before drawing
    // If indexBufferSize doesn't match cachedCulledCount, the buffer might be stale
    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      console.warn(`[FrustumCulling] View ${viewId}: Index buffer size mismatch (${viewState.indexBufferSize} vs ${viewState.cachedCulledCount}) - falling back to full detail`);
      this._renderFullDetail(params);
      return;
    }

    // Bind alpha texture for efficient alpha lookups
    // Note: With indexed drawing (drawElements), gl_VertexID is the index value,
    // which correctly maps to the original point index in our alpha texture
    this._bindAlphaTexture(gl, uniforms);

    // Bind the main VAO (vertex data) and the per-view index buffer for indexed drawing
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);

    // Draw using indexed rendering - much faster than copying vertex data
    gl.drawElements(gl.POINTS, viewState.cachedCulledCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);

    // Unbind alpha texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Update both global and per-view stats
    this._updateStats(viewState, {
      visiblePoints: viewState.cachedCulledCount,
      lodLevel: -1,
      drawCalls: 1
    });
  }

  /**
   * Check if frustum cache is valid and needs update.
   * @param {Float32Array} mvpMatrix - Current MVP matrix
   * @param {Object} viewState - Per-view state object
   * @param {number} [dimensionLevel] - Current dimension level (triggers invalidation when changed)
   * @returns {boolean} True if cache needs update
   */
  _checkFrustumCacheValid(mvpMatrix, viewState, dimensionLevel = undefined) {
    // Check if dimension changed - this invalidates the cache because positions changed
    if (dimensionLevel !== undefined && viewState.lastDimensionLevel !== undefined &&
        viewState.lastDimensionLevel !== dimensionLevel) {
      viewState.lastDimensionLevel = dimensionLevel;
      // Update MVP copy since we're invalidating
      if (!viewState.lastFrustumMVP) {
        viewState.lastFrustumMVP = new Float32Array(16);
      }
      for (let i = 0; i < 16; i++) {
        viewState.lastFrustumMVP[i] = mvpMatrix[i];
      }
      return true;  // Force recalculation
    }
    // Update dimension level tracking (only if not already updated above)
    if (dimensionLevel !== undefined) {
      viewState.lastDimensionLevel = dimensionLevel;
    }

    if (!viewState.lastFrustumMVP) {
      // First time for this view - create a COPY of the mvpMatrix (not a reference)
      viewState.lastFrustumMVP = new Float32Array(16);
      for (let i = 0; i < 16; i++) {
        viewState.lastFrustumMVP[i] = mvpMatrix[i];
      }
      return true;
    }

    // Use sum of squared differences for more stable detection
    let sumSqDiff = 0;
    for (let i = 0; i < 16; i++) {
      const diff = mvpMatrix[i] - viewState.lastFrustumMVP[i];
      sumSqDiff += diff * diff;
    }

    // Threshold for detecting meaningful camera changes (sum of squared differences)
    // 0.0005 balances sensitivity vs avoiding unnecessary recalculations from floating point noise
    // Too low: wastes CPU recalculating when nothing visually changed
    // Too high: frustum culling lags behind camera movement
    const threshold = 0.0005;

    if (sumSqDiff > threshold) {
      for (let i = 0; i < 16; i++) {
        viewState.lastFrustumMVP[i] = mvpMatrix[i];
      }
      return true;
    }

    return false;
  }

  _collectVisibleNodes(node, frustumPlanes, result) {
    if (!node) return;

    const visibility = this._classifyNodeVisibility(node.bounds, frustumPlanes);

    if (visibility === 'outside') {
      return;
    }

    if (visibility === 'inside' || node.indices !== null) {
      if (node.indices !== null) {
        result.push(node);
      } else if (node.children) {
        this._collectAllLeaves(node, result);
      }
      return;
    }

    if (node.children) {
      for (const child of node.children) {
        this._collectVisibleNodes(child, frustumPlanes, result);
      }
    }
  }

  _collectAllLeaves(node, result) {
    if (!node) return;
    if (node.indices !== null) {
      result.push(node);
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        this._collectAllLeaves(child, result);
      }
    }
  }

  _classifyNodeVisibility(bounds, planes) {
    let allInside = true;

    for (const plane of planes) {
      const px = plane[0] >= 0 ? bounds.maxX : bounds.minX;
      const py = plane[1] >= 0 ? bounds.maxY : bounds.minY;
      const pz = plane[2] >= 0 ? bounds.maxZ : bounds.minZ;

      const nx = plane[0] >= 0 ? bounds.minX : bounds.maxX;
      const ny = plane[1] >= 0 ? bounds.minY : bounds.maxY;
      const nz = plane[2] >= 0 ? bounds.minZ : bounds.maxZ;

      const pDist = plane[0] * px + plane[1] * py + plane[2] * pz + plane[3];
      if (pDist < 0) {
        return 'outside';
      }

      const nDist = plane[0] * nx + plane[1] * ny + plane[2] * nz + plane[3];
      if (nDist < 0) {
        allInside = false;
      }
    }

    return allInside ? 'inside' : 'partial';
  }

  /**
   * Upload indices to the per-view index buffer for frustum culling.
   * Each view has its own index buffer to avoid cross-view conflicts.
   * @param {Object} viewState - Per-view state object containing indexBuffer
   * @param {Uint32Array} visibleIndices - Array of visible point indices
   */
  _uploadToViewIndexBuffer(viewState, visibleIndices) {
    const gl = this.gl;
    // Unbind any VAO first to ensure we're modifying global element buffer state
    // This prevents accidentally modifying a VAO's element buffer binding
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, visibleIndices, gl.DYNAMIC_DRAW);
    viewState.indexBufferSize = visibleIndices.length;
    // Unbind element buffer to clean state
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  /**
   * Check if visible count change is significant enough to log.
   * Logs on first call and when cull percentage changes by >10 percentage points.
   */
  _isSignificantChange(lastCount, newCount, totalCount) {
    if (lastCount === undefined || lastCount === null) return true;
    if (totalCount === 0) return false;
    const lastPercent = (lastCount / totalCount) * 100;
    const newPercent = (newCount / totalCount) * 100;
    return Math.abs(newPercent - lastPercent) > 10;
  }

  _renderFullDetail(params) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program) {
      console.error('[HighPerfRenderer] No program available for rendering');
      return;
    }
    if (!uniforms) {
      console.error('[HighPerfRenderer] No uniform locations cached for quality:', this.activeQuality);
      return;
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    }

    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    }
    if (uniforms.u_modelMatrix) {
      gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    }
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) {
      gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    }

    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, pointSize);
    }

    if (uniforms.u_sizeAttenuation) {
      gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    }
    if (uniforms.u_viewportHeight) {
      gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    }
    if (uniforms.u_fov) {
      gl.uniform1f(uniforms.u_fov, fov);
    }
    if (uniforms.u_lightingStrength) {
      gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    }
    if (uniforms.u_fogDensity) {
      gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    }
    if (uniforms.u_fogNear) {
      gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    }
    if (uniforms.u_fogFar) {
      gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    }
    if (uniforms.u_fogColor) {
      gl.uniform3fv(uniforms.u_fogColor, fogColor);
    }
    if (uniforms.u_lightDir) {
      gl.uniform3fv(uniforms.u_lightDir, lightDir);
    }

    // Bind alpha texture for efficient alpha lookups (texture unit 0)
    this._bindAlphaTexture(gl, uniforms);

    // Bind VAO
    gl.bindVertexArray(this.vao);

    // Draw
    gl.drawArrays(gl.POINTS, 0, this.pointCount);

    gl.bindVertexArray(null);

    // Unbind alpha texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.stats.visiblePoints = this.pointCount;
    this.stats.lodLevel = -1;
    this.stats.drawCalls = 1;
  }

  /**
   * Bind alpha texture and set uniforms for alpha texture lookup.
   * @param {WebGL2RenderingContext} gl
   * @param {Object} uniforms - Cached uniform locations
   * @param {number} [lodLevel=-1] - LOD level for index texture binding (-1 for full detail)
   * @param {number} [dimensionLevel] - Dimension level for LOD index texture lookup (defaults to currentDimensionLevel)
   */
  _bindAlphaTexture(gl, uniforms, lodLevel = -1, dimensionLevel = this.currentDimensionLevel) {
    // Bind alpha texture to texture unit 0
    if (this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._alphaTexture);
      if (uniforms.u_alphaTex !== null) {
        gl.uniform1i(uniforms.u_alphaTex, 0); // Texture unit 0
      }
      if (uniforms.u_alphaTexWidth !== null) {
        gl.uniform1i(uniforms.u_alphaTexWidth, this._alphaTexWidth);
      }
      if (uniforms.u_invAlphaTexWidth !== null && this._alphaTexWidth > 0) {
        gl.uniform1f(uniforms.u_invAlphaTexWidth, 1.0 / this._alphaTexWidth);
      }
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 1); // true
      }

      // Bind LOD index texture if rendering LOD level (texture unit 1)
      // Use dimension-aware LOD index textures to match LOD buffers
      const lodIndexTextures = this._getLodIndexTexturesForDimension(dimensionLevel);
      if (lodLevel >= 0 && lodIndexTextures[lodLevel]?.texture) {
        const lodIdxTex = lodIndexTextures[lodLevel];
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lodIdxTex.texture);
        if (uniforms.u_lodIndexTex !== null) {
          gl.uniform1i(uniforms.u_lodIndexTex, 1); // Texture unit 1
        }
        if (uniforms.u_lodIndexTexWidth !== null) {
          gl.uniform1i(uniforms.u_lodIndexTexWidth, lodIdxTex.width);
        }
        if (uniforms.u_invLodIndexTexWidth !== null && lodIdxTex.width > 0) {
          gl.uniform1f(uniforms.u_invLodIndexTexWidth, 1.0 / lodIdxTex.width);
        }
        if (uniforms.u_useLodIndexTex !== null) {
          gl.uniform1i(uniforms.u_useLodIndexTex, 1); // true
        }
      } else {
        // No LOD index texture needed, but must bind dummy R32UI texture to satisfy usampler2D
        // Without this, WebGL throws "Two textures of different types use the same sampler location"
        if (this._dummyLodIndexTexture) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
          if (uniforms.u_lodIndexTex !== null) {
            gl.uniform1i(uniforms.u_lodIndexTex, 1); // Texture unit 1
          }
        }
        if (uniforms.u_useLodIndexTex !== null) {
          gl.uniform1i(uniforms.u_useLodIndexTex, 0); // false
        }
      }
    } else {
      // Alpha texture not active - use vertex attribute alpha
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 0); // false
      }
      // Still need to bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) {
          gl.uniform1i(uniforms.u_lodIndexTex, 1); // Texture unit 1
        }
      }
      if (uniforms.u_useLodIndexTex !== null) {
        gl.uniform1i(uniforms.u_useLodIndexTex, 0); // false
      }
    }
  }

  _renderLOD(lodLevel, params) {
    const gl = this.gl;
    const dimensionLevel = params.dimensionLevel || this.currentDimensionLevel;
    const lodBuffers = this.getLodBuffersForDimension(dimensionLevel);
    const lod = lodBuffers[lodLevel];

    if (!lod || lod.isFullDetail) {
      this._renderFullDetail(params);
      return;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    const adjustedPointSize = pointSize * (lod.sizeMultiplier || 1.0);

    const program = this.activeProgram;
    let uniforms = this.uniformLocations.get(this.activeQuality);

    if (!uniforms || !program) {
      console.error('[HighPerfRenderer] No valid program for LOD rendering, quality:', this.activeQuality);
      return;
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    }
    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    }
    if (uniforms.u_modelMatrix !== null) {
      gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    }
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) {
      gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    }
    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    }
    if (uniforms.u_sizeAttenuation !== null) {
      gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    }
    if (uniforms.u_viewportHeight !== null) {
      gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    }
    if (uniforms.u_fov !== null) {
      gl.uniform1f(uniforms.u_fov, fov);
    }
    if (uniforms.u_lightingStrength !== null) {
      gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    }
    if (uniforms.u_fogDensity !== null) {
      gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    }
    if (uniforms.u_fogNear !== null) {
      gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    }
    if (uniforms.u_fogFar !== null) {
      gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    }
    if (uniforms.u_fogColor !== null) {
      gl.uniform3fv(uniforms.u_fogColor, fogColor);
    }
    if (uniforms.u_lightDir !== null) {
      gl.uniform3fv(uniforms.u_lightDir, lightDir);
    }

    // Bind alpha texture with LOD index texture for proper alpha lookup
    // Pass dimensionLevel to get the correct LOD index textures for this dimension
    this._bindAlphaTexture(gl, uniforms, lodLevel, dimensionLevel);

    // Bind VAO
    gl.bindVertexArray(lod.vao);

    gl.drawArrays(gl.POINTS, 0, lod.pointCount);

    gl.bindVertexArray(null);

    // Unbind textures
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.stats.visiblePoints = lod.pointCount;
    this.stats.lodLevel = lodLevel;
    this.stats.drawCalls = 1;
  }

  /**
   * Render with combined LOD and frustum culling.
   * This provides maximum performance by both reducing point count (LOD) and
   * culling out-of-view points (frustum culling) simultaneously.
   * Uses per-view index buffer to avoid cross-view conflicts.
   * @private
   */
  _renderLODWithFrustumCulling(lodLevel, params, frustumPlanes, viewState, spatialIndex, lodBuffersForDim) {
    const gl = this.gl;
    const lod = lodBuffersForDim[lodLevel];

    if (!lod || lod.isFullDetail) {
      // Fall back to standard frustum culling at full detail
      this._renderWithFrustumCulling(params, frustumPlanes, viewState, spatialIndex);
      return;
    }

    // One-time validation: ensure LOD indices are properly initialized
    if (!this._lodIndicesValidated?.[lodLevel] && spatialIndex) {
      let totalLodIndices = 0;
      const countLodIndices = (node) => {
        if (!node) return;
        if (node.indices && node.lodIndices?.[lodLevel]) {
          totalLodIndices += node.lodIndices[lodLevel].length;
        } else if (node.children) {
          for (const child of node.children) countLodIndices(child);
        }
      };
      countLodIndices(spatialIndex.root);
      const expectedCount = lod.pointCount;
      if (totalLodIndices !== expectedCount) {
        console.warn(`[LOD+Frustum] LOD ${lodLevel} indices mismatch: nodes have ${totalLodIndices}, LOD buffer has ${expectedCount}`);
      }
      if (!this._lodIndicesValidated) this._lodIndicesValidated = {};
      this._lodIndicesValidated[lodLevel] = true;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId = 'default',
      dimensionLevel = 3  // For cache invalidation on dimension change
    } = params;

    // Check if we need to recompute the frustum-culled LOD indices
    // Two-tier caching: visible nodes cached separately from LOD indices
    // - frustumChanged: need to re-traverse octree to find visible nodes
    // - lodLevelChanged: can reuse cached visible nodes, just rebuild LOD indices
    const frustumChanged = this._checkFrustumCacheValid(mvpMatrix, viewState, dimensionLevel);
    const lodLevelChanged = viewState.cachedLodLevel !== lodLevel;

    // Step 1: Only collect visible nodes when frustum changes (expensive octree traversal)
    if (frustumChanged) {
      const visibleNodes = [];
      this._collectVisibleNodes(spatialIndex.root, frustumPlanes, visibleNodes);
      viewState.cachedVisibleNodes = visibleNodes;  // Cache for reuse across LOD changes
    }

    // Step 2: Rebuild LOD indices when frustum OR LOD level changes
    // PERFORMANCE NOTE: This block is the main source of lag when zooming with LOD+Frustum enabled.
    // Unlike LOD-only (which uses gl.drawArrays with pre-built VAOs) or Frustum-only (which only
    // updates when camera moves), LOD+Frustum must rebuild index buffers on EVERY LOD level change.
    // Pre-caching is NOT possible here because:
    //   - Pre-cached originalIndexBuffer contains ALL LOD indices for a level
    //   - Frustum culling requires only the SUBSET visible in current frustum
    //   - This subset is view-dependent (each view has different frustum) and LOD-dependent
    //   - When LOD changes during zoom, we must: iterate visible nodes → collect lodIndices[newLevel]
    //     → upload via gl.bufferData() (synchronous GPU stall)
    // With N views, this happens N times per LOD transition. The >98% visibility early-exit helps
    // by falling back to gl.drawArrays when most points are visible.
    if (frustumChanged || lodLevelChanged) {
      const visibleNodes = viewState.cachedVisibleNodes;

      if (!visibleNodes || visibleNodes.length === 0) {
        // Fallback to LOD without frustum culling when no visible nodes
        // Only log once per view (not every frame)
        if (!viewState._noVisibleNodesWarned) {
          console.warn(`[LOD+Frustum] View ${viewId}: No visible nodes - falling back to LOD without frustum`);
          viewState._noVisibleNodesWarned = true;
        }
        viewState.cachedCulledCount = 0;
        viewState.cachedLodVisibleIndices = null;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodIsCulled = false;
        this.stats.frustumCulled = false;
        this.stats.cullPercent = 0;
        this.stats.lodLevel = lodLevel;
        this._renderLOD(lodLevel, params);
        return;
      }

      // Collect pre-computed LOD indices from visible nodes - O(visible nodes)
      // Each node has pre-computed lodIndices[level] mapping to LOD buffer vertices
      // Pre-calculate total count FIRST to check visibility ratio before expensive copy
      let visibleCount = 0;
      for (let i = 0; i < visibleNodes.length; i++) {
        const nodeLodIndices = visibleNodes[i].lodIndices?.[lodLevel];
        if (nodeLodIndices) visibleCount += nodeLodIndices.length;
      }

      const totalLodPoints = lod.pointCount;
      const visibleRatio = visibleCount / totalLodPoints;
      const cullPercent = ((1 - visibleRatio) * 100);

      // EARLY EXIT OPTIMIZATION: If >98% visible, skip index copying entirely
      // This eliminates the expensive buffer allocation and copy when most points are visible
      if (visibleRatio > 0.98) {
        viewState.cachedCulledCount = 0;
        viewState.cachedLodVisibleIndices = null;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodIsCulled = false;
        viewState._noVisibleNodesWarned = false;  // Reset warning flag
        this.stats.frustumCulled = false;
        this.stats.cullPercent = cullPercent;
        this._renderLOD(lodLevel, params);
        return;
      }

      // Only allocate and copy indices when actually needed (<98% visible)
      // Reuse per-view pooled buffer for LOD indices (avoids GC pressure)
      if (!viewState.visibleLodIndicesBuffer || viewState.visibleLodIndicesCapacity < visibleCount) {
        viewState.visibleLodIndicesCapacity = Math.ceil(visibleCount * 1.5);
        viewState.visibleLodIndicesBuffer = new Uint32Array(viewState.visibleLodIndicesCapacity);
      }

      // Fill pooled buffer with visible LOD indices
      let offset = 0;
      for (let i = 0; i < visibleNodes.length; i++) {
        const nodeLodIndices = visibleNodes[i].lodIndices?.[lodLevel];
        if (nodeLodIndices) {
          viewState.visibleLodIndicesBuffer.set(nodeLodIndices, offset);
          offset += nodeLodIndices.length;
        }
      }
      // Create view of used portion (no allocation, just a view)
      const visibleLodIndices = viewState.visibleLodIndicesBuffer.subarray(0, visibleCount);

      // Log only on significant change (>10% of total points)
      if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleCount, totalLodPoints)) {
        console.log(`[LOD+Frustum] View ${viewId}: LOD ${lodLevel} - ${visibleCount.toLocaleString()}/${totalLodPoints.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleCount;
      }

      // Store the filtered indices for this view (already a Uint32Array, no copy needed)
      viewState.cachedLodVisibleIndices = visibleLodIndices;
      viewState.cachedCulledCount = visibleCount;
      viewState.cachedLodLevel = lodLevel;
      viewState.cachedLodIsCulled = true;  // Mark as culled indices (not full LOD)
      viewState._noVisibleNodesWarned = false;  // Reset warning flag since we have visible nodes

      // Upload to per-view index buffer
      this._uploadToViewIndexBuffer(viewState, visibleLodIndices);
      this.stats.frustumCulled = true;
      this.stats.cullPercent = cullPercent;
    }

    // If no visible points after culling, skip rendering
    if (!viewState.cachedCulledCount || viewState.cachedCulledCount === 0) {
      this._renderLOD(lodLevel, params);
      return;
    }

    // Render using LOD buffer with indexed drawing
    const adjustedPointSize = pointSize * (lod.sizeMultiplier || 1.0);

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!uniforms || !program) {
      console.error('[HighPerfRenderer] No valid program for LOD+Frustum rendering, quality:', this.activeQuality);
      return;
    }

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Defensive check: ensure index buffer is valid before drawing
    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      console.warn(`[LOD+Frustum] View ${viewId}: Index buffer size mismatch - falling back to LOD without frustum`);
      this._renderLOD(lodLevel, params);
      return;
    }

    // Bind alpha texture with LOD index texture for proper alpha lookup
    // Pass dimensionLevel to get the correct LOD index textures for this dimension
    this._bindAlphaTexture(gl, uniforms, lodLevel, dimensionLevel);

    // Bind LOD VAO and per-view index buffer for indexed drawing
    gl.bindVertexArray(lod.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);

    // Draw using indexed rendering into the LOD buffer
    gl.drawElements(gl.POINTS, viewState.cachedCulledCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);

    // Unbind textures
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Update both global and per-view stats
    this._updateStats(viewState, {
      visiblePoints: viewState.cachedCulledCount,
      lodLevel: lodLevel,
      drawCalls: 1
    });
  }

  setAdaptiveLOD(enabled) {
    this.useAdaptiveLOD = enabled;
    console.log(`[HighPerfRenderer] Adaptive LOD ${enabled ? 'enabled' : 'disabled'}`);

    // When disabling LOD, reset forceLODLevel to -1 (auto/full detail)
    // This ensures the scatterplot returns to full detail when LOD is turned off
    if (!enabled && this.forceLODLevel >= 0) {
      console.log('[HighPerfRenderer] Resetting forceLODLevel to -1 (LOD disabled)');
      this.forceLODLevel = -1;
    }

    if (enabled && this.pointCount > 0 && this._positions) {
      const dimLevel = this.currentDimensionLevel;

      // Check if spatial index exists and is not stale
      const existingIndex = this.spatialIndices.get(dimLevel);
      const indexStale = existingIndex && existingIndex.pointCount !== this.pointCount;

      if (!existingIndex || indexStale) {
        if (indexStale) {
          console.log(`[HighPerfRenderer] ${dimLevel}D spatial index stale (point count mismatch), rebuilding...`);
          // Clear all cached spatial indices
          this.spatialIndices.clear();
          this._clearLodBuffers();  // Properly delete GL buffers before clearing
          this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index for LOD...`);
        }
        // Use dimension-aware spatial index (will also create LOD buffers)
        const spatialIndex = this.getSpatialIndexForDimension(dimLevel);
        if (spatialIndex) {
          // Clear per-view caches since spatial index changed
          this.clearAllViewState();
          // Rebuild snapshot spatial indices if they have custom positions
          // This ensures LOD/frustum culling continues to work for snapshots
          for (const [id, snapshot] of this.snapshotBuffers) {
            if (snapshot.spatialIndex) {
              // If snapshot has custom positions, rebuild its spatial index
              if (snapshot.positions && snapshot.positions !== this._positions) {
                const snapshotDimLevel = snapshot.dimensionLevel || dimLevel;
                console.log(`[HighPerfRenderer] Ensuring LOD levels for snapshot "${id}" (${snapshotDimLevel}D)...`);
                snapshot.spatialIndex.ensureLODLevels();
              } else {
                // Snapshot uses main positions - invalidate its index (will use main index)
                snapshot.spatialIndex = null;
                console.log(`[HighPerfRenderer] Invalidated spatial index for snapshot "${id}" (uses main positions)`);
              }
            }
          }
        }
      } else {
        // Spatial index exists and is not stale, but LOD buffers may not exist
        // (e.g., frustum culling was enabled first without LOD)
        // If the spatial index was built without LOD levels (for picking/frustum-only),
        // generate LOD levels lazily now that LOD is enabled.
        if (!existingIndex.lodLevels || existingIndex.lodLevels.length === 0) {
          existingIndex.ensureLODLevels();
        }
        const existingLodBuffers = this.lodBuffersByDimension.get(dimLevel);
        if (!existingLodBuffers || existingLodBuffers.length === 0) {
          console.log(`[HighPerfRenderer] Creating LOD buffers for existing ${dimLevel}D spatial index...`);
          this._createLODBuffersForDimension(dimLevel, existingIndex);
        }
      }

      // Create LOD index textures if needed for this dimension
      const lodBuffers = this.getLodBuffersForDimension(dimLevel);
      const spatialIndex = this.spatialIndices.get(dimLevel);
      if (spatialIndex && lodBuffers.length > 0) {
        const lodIndexTextures = this._getLodIndexTexturesForDimension(dimLevel);
        if (!lodIndexTextures || lodIndexTextures.length === 0) {
          console.log(`[HighPerfRenderer] Creating LOD index textures for ${dimLevel}D...`);
          this._createLODIndexTextures(dimLevel);
        }
      }
    }
  }

  /**
   * Print current renderer status to console for debugging.
   * Call this from console: renderer.debugStatus()
   */
  debugStatus() {
    const dimLevel = this.currentDimensionLevel;
    const spatialIndex = this.spatialIndices.get(dimLevel);
    const lodBuffers = this.getLodBuffersForDimension(dimLevel);

    const status = {
      pointCount: this.pointCount,
      currentDimensionLevel: dimLevel,
      useAdaptiveLOD: this.useAdaptiveLOD,
      useFrustumCulling: this.useFrustumCulling,
      forceLODLevel: this.forceLODLevel,
      lodBuffersCount: lodBuffers.length,
      spatialIndicesCount: this.spatialIndices.size,
      hasSpatialIndex: !!spatialIndex,
      spatialIndexPointCount: spatialIndex?.pointCount,
      stats: { ...this.stats }
    };
    console.log('[HighPerfRenderer] Current Status:', status);
    if (spatialIndex) {
      const validation = spatialIndex.validatePointCount();
      console.log('[HighPerfRenderer] Spatial Index Validation:', validation);
    }
    return status;
  }

  setForceLOD(level) {
    this.forceLODLevel = level;
    if (level >= 0) {
      console.log(`[HighPerfRenderer] Force LOD level: ${level}`);
    } else {
      console.log('[HighPerfRenderer] LOD mode: Auto');
    }
  }

  setFrustumCulling(enabled) {
    this.useFrustumCulling = enabled;
    console.log(`[HighPerfRenderer] Frustum culling ${enabled ? 'enabled' : 'disabled'}`);

    // Reset frustum culling state (per-view state and stats)
    this.clearAllViewState();
    this.stats.frustumCulled = false;
    this.stats.cullPercent = 0;

    if (enabled && this.pointCount > 0 && this._positions) {
      // Build spatial index if needed, or rebuild if positions changed since it was built
      const dimLevel = this.currentDimensionLevel;
      const existingIndex = this.spatialIndices.get(dimLevel);
      const indexStale = existingIndex && existingIndex.pointCount !== this.pointCount;

      if (!existingIndex || indexStale) {
        if (indexStale) {
          console.log(`[HighPerfRenderer] ${dimLevel}D spatial index stale, rebuilding for frustum culling...`);
          this.spatialIndices.clear();
          this._clearLodBuffers();  // Properly delete GL buffers before clearing
          this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index for frustum culling...`);
        }
        this.getSpatialIndexForDimension(dimLevel);
      }
    }
  }

  /**
   * Get spatial index for a specific dimension level.
   * Returns null if not yet built - use ensureSpatialIndex() to build first.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3)
   * @returns {SpatialIndex|null} The spatial index for the dimension, or null if not built
   */
  getSpatialIndex(dimensionLevel) {
    if (dimensionLevel === undefined) {
      console.warn('[HighPerfRenderer] getSpatialIndex called without dimensionLevel');
      return null;
    }
    const dim = Math.max(1, Math.min(3, dimensionLevel));
    return this.spatialIndices.get(dim) || null;
  }

  /**
   * Check if spatial index exists for a specific dimension level.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3)
   * @returns {boolean} True if spatial index exists for the dimension
   */
  hasSpatialIndex(dimensionLevel) {
    if (dimensionLevel === undefined) return false;
    const dim = Math.max(1, Math.min(3, dimensionLevel));
    return this.spatialIndices.has(dim);
  }

  /**
   * Ensure spatial index exists for the specified dimension.
   * Creates it if needed. Use for collision detection or other features that need spatial index.
   * @param {number} dimensionLevel - The dimension level (1, 2, or 3) - REQUIRED
   */
  ensureSpatialIndex(dimensionLevel) {
    if (dimensionLevel === undefined) {
      console.warn('[HighPerfRenderer] ensureSpatialIndex called without dimensionLevel - defaulting to 3D');
      dimensionLevel = 3;
    }
    const dimLevel = Math.max(1, Math.min(3, dimensionLevel));

    if (this.pointCount > 0 && this._positions) {
      const existingIndex = this.spatialIndices.get(dimLevel);
      const indexStale = existingIndex && existingIndex.pointCount !== this.pointCount;

      if (!existingIndex || indexStale) {
        if (indexStale) {
          console.log(`[HighPerfRenderer] ${dimLevel}D spatial index stale, rebuilding...`);
          this.clearAllViewState();
          this.spatialIndices.clear();
          this._clearLodBuffers();  // Properly delete GL buffers before clearing
          this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index...`);
        }
        this.getSpatialIndexForDimension(dimLevel);
      }
    }
  }

  getStats() {
    return { ...this.stats };
  }

  /**
   * Get per-view stats for a specific view (for multiview rendering).
   * Returns view-specific stats if viewId is provided, otherwise returns global stats.
   * @param {string|number} [viewId] - Optional view ID for per-view stats
   * @returns {Object} Stats object with visiblePoints, lodLevel, drawCalls, frustumCulled, cullPercent
   */
  getViewStats(viewId) {
    if (viewId !== undefined) {
      const vid = String(viewId);
      const viewState = this._perViewState.get(vid);
      if (viewState && viewState.stats) {
        return { ...viewState.stats };
      }
    }
    return { ...this.stats };
  }

  /**
   * Update render stats for both global and per-view tracking.
   * @param {Object} viewState - Per-view state object (or null for global-only)
   * @param {Object} statsUpdate - Object with stats to update (visiblePoints, lodLevel, drawCalls, frustumCulled, cullPercent)
   * @private
   */
  _updateStats(viewState, statsUpdate) {
    // Update global stats (for backwards compatibility)
    Object.assign(this.stats, statsUpdate);
    // Update per-view stats if viewState provided
    if (viewState && viewState.stats) {
      Object.assign(viewState.stats, statsUpdate);
    }
  }

  /**
   * Get aggregated stats across all views (for multiview rendering).
   * Returns sum/average of per-view stats plus a views array with individual stats.
   * @returns {Object} Aggregated stats: { totalVisiblePoints, totalDrawCalls, avgCullPercent, viewCount, views: [...] }
   */
  getAggregatedStats() {
    const views = [];
    let totalVisiblePoints = 0;
    let totalDrawCalls = 0;
    let totalCullPercent = 0;
    let culledViewCount = 0;

    for (const [viewId, viewState] of this._perViewState) {
      if (viewState.stats) {
        const vs = viewState.stats;
        views.push({
          viewId,
          visiblePoints: vs.visiblePoints,
          lodLevel: vs.lodLevel,
          drawCalls: vs.drawCalls,
          frustumCulled: vs.frustumCulled,
          cullPercent: vs.cullPercent
        });
        totalVisiblePoints += vs.visiblePoints || 0;
        totalDrawCalls += vs.drawCalls || 0;
        if (vs.frustumCulled) {
          totalCullPercent += vs.cullPercent || 0;
          culledViewCount++;
        }
      }
    }

    return {
      totalVisiblePoints,
      totalDrawCalls,
      avgCullPercent: culledViewCount > 0 ? totalCullPercent / culledViewCount : 0,
      viewCount: views.length,
      views,
      // Include last frame time and FPS from global stats
      lastFrameTime: this.stats.lastFrameTime,
      fps: this.stats.fps,
      gpuMemoryMB: this.stats.gpuMemoryMB
    };
  }

  getPositions() {
    return this._positions;
  }

  /**
   * Get the number of LOD levels for the current dimension.
   * @param {number} [dimensionLevel] - Optional dimension level. Defaults to current.
   * @returns {number} Number of LOD levels
   */
  getLODLevelCount(dimensionLevel = this.currentDimensionLevel) {
    const lodBuffers = this.getLodBuffersForDimension(dimensionLevel);
    return lodBuffers.length;
  }

  /**
   * Get the current LOD level being rendered (-1 = full detail)
   * @param {string|number} [viewId] - Optional view ID for per-view LOD level in multi-view rendering.
   *   If not provided, returns the global stats.lodLevel (last rendered view).
   * @returns {number} LOD level (-1 = full detail or LOD disabled)
   */
  getCurrentLODLevel(viewId) {
    if (viewId !== undefined) {
      // Normalize viewId to string to prevent type mismatches between callers
      const vid = String(viewId);
      const viewState = this._perViewState.get(vid);
      if (viewState && viewState.lastLodLevel !== undefined) {
        return viewState.lastLodLevel;
      }
      // When viewId is specified but state not yet initialized, return -1 (full detail)
      // instead of falling back to global state which could be from a different view
      return -1;
    }
    return this.stats.lodLevel;
  }

  /**
   * Get the size multiplier for the current LOD level (1.0 for full detail).
   * @param {string|number} [viewId] - Optional view ID for per-view LOD level in multi-view rendering.
   *   If not provided, uses the global stats.lodLevel (last rendered view).
   * @param {number} [dimensionLevel] - Optional dimension level. Defaults to current.
   * @returns {number} Size multiplier (1.0 for full detail)
   */
  getCurrentLODSizeMultiplier(viewId, dimensionLevel = this.currentDimensionLevel) {
    // Use per-view LOD level if viewId is provided
    const lodLevel = viewId !== undefined
      ? this.getCurrentLODLevel(viewId)
      : this.stats.lodLevel;
    if (lodLevel == null || lodLevel < 0) return 1.0;
    const lodBuffers = this.getLodBuffersForDimension(dimensionLevel);
    const lodBuf = lodBuffers?.[lodLevel];
    if (!lodBuf || lodBuf.isFullDetail) return 1.0;
    return lodBuf.sizeMultiplier || 1.0;
  }

  /**
   * Get visibility array for a specific LOD level.
   * Returns Float32Array where 1.0 = visible at current LOD, 0.0 = hidden by LOD.
   * When LOD is disabled or at full detail, returns null (meaning all visible).
   *
   * @param {number} [overrideLodLevel] - Optional LOD level to use instead of global stats.lodLevel.
   *   Use this for per-view LOD in multi-view rendering.
   * @param {string|number} [viewId] - Optional view ID for per-view caching in multi-view rendering.
   *   When provided, uses view-specific cache to avoid cross-view interference.
   * @param {number} [dimensionLevel] - Optional dimension level. Defaults to current.
   * @returns {Float32Array|null} Visibility array or null if all visible
   *
   * Performance: Reuses cached array per-view, only rebuilds when LOD level or filter generation changes.
   */
  getLodVisibilityArray(overrideLodLevel = undefined, viewId = undefined, dimensionLevel = this.currentDimensionLevel) {
    const n = this.pointCount;
    if (n === 0) return null;

    // Use override if provided, otherwise use per-view LOD level (if viewId provided), else global
    // This ensures each view uses its own LOD level in multiview mode
    let lodLevel;
    if (overrideLodLevel !== undefined) {
      lodLevel = overrideLodLevel;
    } else if (viewId !== undefined) {
      const viewState = this._getViewState(viewId);
      lodLevel = viewState.lastLodLevel ?? this.stats.lodLevel;
    } else {
      lodLevel = this.stats.lodLevel;
    }

    // Get spatial index for the dimension
    const spatialIndex = this.spatialIndices.get(dimensionLevel);

    // If no spatial index or lodLevel is not set, all points visible - return null to signal "all visible"
    // Note: We check lodLevel directly, NOT useAdaptiveLOD, because forced LOD (forceLODLevel >= 0)
    // should work even when adaptive LOD is disabled. The lodLevel parameter already incorporates
    // the decision from render() about whether LOD is active (adaptive or forced).
    if (!spatialIndex || lodLevel < 0) {
      return null;
    }

    const lodBuffers = this.getLodBuffersForDimension(dimensionLevel);
    const lodBuffer = lodBuffers[lodLevel];

    // Full detail level - all visible
    if (!lodBuffer || lodBuffer.isFullDetail) {
      return null;
    }

    // Get the LOD level's indices (which original points are included)
    const level = spatialIndex.lodLevels[lodLevel];
    if (!level || !level.indices) {
      return null;
    }

    // Use per-view cache if viewId provided, otherwise use global cache
    // This prevents cross-view interference when different views have different LOD levels
    if (viewId !== undefined) {
      const viewState = this._getViewState(viewId);
      const currentFilterGen = viewState.filterGeneration || 0;

      // Return cached array if LOD level AND filter generation haven't changed
      if (viewState.cachedLodVisibility &&
          viewState.cachedLodVisibilityLevel === lodLevel &&
          viewState.cachedLodVisibilityFilterGen === currentFilterGen) {
        return viewState.cachedLodVisibility;
      }

      // Reuse or create visibility array
      const needsFullClear = !viewState.cachedLodVisibility || viewState.cachedLodVisibility.length !== n;
      if (needsFullClear) {
        viewState.cachedLodVisibility = new Float32Array(n);
        // New array is already zero-filled by Float32Array constructor
      } else {
        // SPARSE CLEAR OPTIMIZATION: Instead of .fill(0) which is O(N),
        // only clear the previously marked indices. This is O(prev_LOD_points)
        // which is much smaller than O(N) for large datasets.
        const prevIndices = viewState.cachedLodVisibilityIndices;
        if (prevIndices) {
          const vis = viewState.cachedLodVisibility;
          for (let i = 0, len = prevIndices.length; i < len; i++) {
            vis[prevIndices[i]] = 0;
          }
        }
      }

      // Mark only the points in this LOD level as visible
      const indices = level.indices;
      const vis = viewState.cachedLodVisibility;
      for (let i = 0, len = indices.length; i < len; i++) {
        vis[indices[i]] = 1.0;
      }

      // Store indices for next sparse clear
      viewState.cachedLodVisibilityIndices = indices;
      viewState.cachedLodVisibilityLevel = lodLevel;
      viewState.cachedLodVisibilityFilterGen = currentFilterGen;
      return viewState.cachedLodVisibility;
    }

    // Global cache fallback for backwards compatibility
    const currentFilterGen = this._filterGeneration || 0;
    if (this._cachedLodVisibility &&
        this._cachedLodVisibilityLevel === lodLevel &&
        this._cachedLodVisibilityFilterGen === currentFilterGen) {
      return this._cachedLodVisibility;
    }

    // Reuse or create visibility array
    const needsFullClear = !this._cachedLodVisibility || this._cachedLodVisibility.length !== n;
    if (needsFullClear) {
      this._cachedLodVisibility = new Float32Array(n);
      // New array is already zero-filled by Float32Array constructor
    } else {
      // SPARSE CLEAR OPTIMIZATION: Instead of .fill(0) which is O(N),
      // only clear the previously marked indices. This is O(prev_LOD_points)
      // which is much smaller than O(N) for large datasets.
      const prevIndices = this._cachedLodVisibilityIndices;
      if (prevIndices) {
        const vis = this._cachedLodVisibility;
        for (let i = 0, len = prevIndices.length; i < len; i++) {
          vis[prevIndices[i]] = 0;
        }
      }
    }

    // Mark only the points in this LOD level as visible
    const indices = level.indices;
    const vis = this._cachedLodVisibility;
    for (let i = 0, len = indices.length; i < len; i++) {
      vis[indices[i]] = 1.0;
    }

    // Store indices for next sparse clear
    this._cachedLodVisibilityIndices = indices;
    this._cachedLodVisibilityLevel = lodLevel;
    this._cachedLodVisibilityFilterGen = currentFilterGen;
    return this._cachedLodVisibility;
  }

  /**
   * Get visibility mask for a specific view combining LOD level AND alpha/filter visibility.
   * This is used for highlight rendering to ensure highlights match what's rendered.
   *
   * NOTE: We intentionally use LOD-only visibility (not frustum) because:
   * 1. GPU automatically clips cells outside the frustum (no need to exclude from buffer)
   * 2. Using frustum visibility would require rebuilding on every camera move (expensive)
   * 3. With LOD-only visibility, cells entering the frustum are immediately highlighted
   *
   * @param {string|number} viewId - View ID for per-view LOD level lookup
   * @param {number} [alphaThreshold=0.01] - Minimum alpha to be considered visible
   * @param {number} [dimensionLevel] - Dimension level for the view (1D/2D/3D). If not provided,
   *   uses the view's cached dimension or falls back to currentDimensionLevel.
   * @returns {Float32Array|null} Visibility mask (1.0 = visible, 0.0 = hidden), or null if all visible
   */
  getCombinedVisibilityForView(viewId, alphaThreshold = 0.01, dimensionLevel = undefined) {
    const vid = String(viewId);
    const viewState = this._perViewState.get(vid);

    // Get LOD level for this view
    const lodLevel = viewState?.lastLodLevel ?? this.stats.lodLevel ?? -1;

    // Get dimension level: explicit param > view state cache > current dimension
    const dimLevel = dimensionLevel ?? viewState?.lastDimensionLevel ?? this.currentDimensionLevel;

    // Get LOD visibility (which points are in this LOD level) for the correct dimension
    const lodVis = this.getLodVisibilityArray(lodLevel, viewId, dimLevel);
    const alphas = this._currentAlphas;
    const n = this.pointCount;

    // If no LOD filtering and no alpha filtering, return null (all visible)
    if (!lodVis && !alphas) return null;

    // LOD only - no alpha filtering active
    if (!alphas) return lodVis;

    // Check cache validity - skip rebuild if inputs haven't changed
    // Track: LOD level, dimension, alpha threshold, filter generation (incremented on alpha changes)
    const filterGen = this._filterGeneration || 0;
    if (viewState) {
      const cacheValid = viewState.cachedCombinedVisibility &&
        viewState.cachedCombinedVisibility.length === n &&
        viewState.cachedCombinedVisLod === lodLevel &&
        viewState.cachedCombinedVisDim === dimLevel &&
        viewState.cachedCombinedVisThreshold === alphaThreshold &&
        viewState.cachedCombinedVisFilterGen === filterGen &&
        viewState.cachedCombinedVisHasAlpha === !!alphas &&
        viewState.cachedCombinedVisHasLod === !!lodVis;

      if (cacheValid) {
        return viewState.cachedCombinedVisibility;
      }
    }

    // Alpha only - no LOD filtering (full detail)
    if (!lodVis) {
      // Quick check: are any points actually filtered out?
      let hasFiltered = false;
      for (let i = 0; i < n; i++) {
        if (alphas[i] < alphaThreshold) {
          hasFiltered = true;
          break;
        }
      }
      if (!hasFiltered) return null;

      // Build alpha-only visibility array
      // Reuse per-view cache to avoid allocation
      if (!viewState) {
        // No view state, create temporary array
        const vis = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          vis[i] = alphas[i] >= alphaThreshold ? 1.0 : 0.0;
        }
        return vis;
      }

      // Reuse cached array if possible
      if (!viewState.cachedCombinedVisibility || viewState.cachedCombinedVisibility.length !== n) {
        viewState.cachedCombinedVisibility = new Float32Array(n);
      }
      for (let i = 0; i < n; i++) {
        viewState.cachedCombinedVisibility[i] = alphas[i] >= alphaThreshold ? 1.0 : 0.0;
      }
      // Update cache keys
      viewState.cachedCombinedVisLod = lodLevel;
      viewState.cachedCombinedVisDim = dimLevel;
      viewState.cachedCombinedVisThreshold = alphaThreshold;
      viewState.cachedCombinedVisFilterGen = filterGen;
      viewState.cachedCombinedVisHasAlpha = true;
      viewState.cachedCombinedVisHasLod = false;
      return viewState.cachedCombinedVisibility;
    }

    // Both LOD and alpha filtering active - combine them
    // A point is visible only if it's in the LOD level AND passes alpha threshold
    const vs = viewState || this._getViewState(viewId);
    if (!vs.cachedCombinedVisibility || vs.cachedCombinedVisibility.length !== n) {
      vs.cachedCombinedVisibility = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      vs.cachedCombinedVisibility[i] = (lodVis[i] > 0 && alphas[i] >= alphaThreshold) ? 1.0 : 0.0;
    }
    // Update cache keys
    vs.cachedCombinedVisLod = lodLevel;
    vs.cachedCombinedVisDim = dimLevel;
    vs.cachedCombinedVisThreshold = alphaThreshold;
    vs.cachedCombinedVisFilterGen = filterGen;
    vs.cachedCombinedVisHasAlpha = true;
    vs.cachedCombinedVisHasLod = true;
    return vs.cachedCombinedVisibility;
  }

  /**
   * Invalidate LOD visibility cache due to filter/transparency change.
   * Call this whenever the transparency array is modified.
   * @param {string|number} [viewId] - Optional view ID to invalidate only that view's cache.
   *   If not provided, invalidates all caches (global and all per-view).
   */
  invalidateLodVisibilityCache(viewId = undefined) {
    if (viewId !== undefined) {
      // Invalidate only specific view's cache
      const vid = String(viewId);
      const viewState = this._perViewState.get(vid);
      if (viewState) {
        viewState.filterGeneration = (viewState.filterGeneration || 0) + 1;
      }
    } else {
      // Invalidate global cache
      this._filterGeneration = (this._filterGeneration || 0) + 1;
      // Also invalidate all per-view caches
      for (const viewState of this._perViewState.values()) {
        viewState.filterGeneration = (viewState.filterGeneration || 0) + 1;
      }
    }
  }

  // ===========================================================================
  // SNAPSHOT BUFFER MANAGEMENT (for multi-view rendering without re-uploads)
  // ===========================================================================

  /**
   * Create a GPU buffer for a snapshot view. Call this once when snapshot is created.
   * The buffer stores interleaved position+color data and is only uploaded once.
   * @param {string} id - Unique snapshot identifier
   * @param {Uint8Array} colors - RGB (3 bytes) or RGBA (4 bytes) colors per point
   * @param {Float32Array} [alphas] - Optional alpha values (0-1), merged into colors
   * @param {Float32Array} [viewPositions] - Optional per-view positions (for multi-dimensional support)
   * @returns {boolean} Success
   */
  createSnapshotBuffer(id, colors, alphas = null, viewPositions = null) {
    if (!this._positions || this.pointCount === 0) {
      console.warn('[HighPerfRenderer] Cannot create snapshot buffer: no data loaded');
      return false;
    }

    const gl = this.gl;
    const n = this.pointCount;
    // Use view-specific positions if provided, otherwise use global positions
    const positions = viewPositions || this._positions;

    // Normalize colors to RGBA Uint8 if needed
    const expectedRGBA = n * 4;
    const expectedRGB = n * 3;
    let snapshotColors;

    // Detect Float32Array colors (normalized 0-1 range) and convert to Uint8 (0-255)
    // Float32Array with values in 0-1 range needs conversion; direct Uint8Array copy would produce garbage
    const isFloat32Colors = colors instanceof Float32Array ||
      (colors.length > 0 && colors[0] !== undefined && colors[0] <= 1.0 && !(colors instanceof Uint8Array || colors instanceof Uint8ClampedArray));

    if (isFloat32Colors) {
      // Convert Float32 normalized colors (0-1) to Uint8 (0-255)
      if (colors.length === expectedRGB) {
        snapshotColors = new Uint8Array(expectedRGBA);
        for (let i = 0; i < n; i++) {
          // Clamp to 0-255 to prevent wrap-around for out-of-range values
          const r = Math.round(colors[i * 3] * 255);
          const g = Math.round(colors[i * 3 + 1] * 255);
          const b = Math.round(colors[i * 3 + 2] * 255);
          snapshotColors[i * 4]     = r > 255 ? 255 : (r < 0 ? 0 : r);
          snapshotColors[i * 4 + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
          snapshotColors[i * 4 + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
          snapshotColors[i * 4 + 3] = 255;
        }
      } else {
        snapshotColors = new Uint8Array(expectedRGBA);
        for (let i = 0; i < n; i++) {
          // Clamp to 0-255 to prevent wrap-around for out-of-range values
          const r = Math.round(colors[i * 4] * 255);
          const g = Math.round(colors[i * 4 + 1] * 255);
          const b = Math.round(colors[i * 4 + 2] * 255);
          const a = Math.round((colors[i * 4 + 3] ?? 1.0) * 255);
          snapshotColors[i * 4]     = r > 255 ? 255 : (r < 0 ? 0 : r);
          snapshotColors[i * 4 + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
          snapshotColors[i * 4 + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
          snapshotColors[i * 4 + 3] = a > 255 ? 255 : (a < 0 ? 0 : a);
        }
      }
    } else if (colors.length === expectedRGB) {
      // Convert RGB to RGBA (Uint8 input)
      snapshotColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < n; i++) {
        snapshotColors[i * 4]     = colors[i * 3];
        snapshotColors[i * 4 + 1] = colors[i * 3 + 1];
        snapshotColors[i * 4 + 2] = colors[i * 3 + 2];
        snapshotColors[i * 4 + 3] = 255;
      }
    } else {
      // Create a copy of colors to avoid modifying the original (Uint8 RGBA input)
      snapshotColors = new Uint8Array(colors);
    }

    // Merge alphas into the color array if provided
    if (alphas) {
      const alphaCount = Math.min(n, alphas.length);
      for (let i = 0; i < alphaCount; i++) {
        // Clamp to 0-255 to prevent wrap-around for out-of-range values
        const val = Math.round(alphas[i] * 255);
        snapshotColors[i * 4 + 3] = val > 255 ? 255 : (val < 0 ? 0 : val);
      }
    }

    // Build interleaved buffer: [x,y,z (float32), r,g,b,a (uint8)] = 16 bytes per point
    const buffer = new ArrayBuffer(n * 16);
    const positionView = new Float32Array(buffer);
    const colorView = new Uint8Array(buffer);

    for (let i = 0; i < n; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4;
      const byteOffset = i * 16 + 12;

      positionView[floatOffset] = positions[srcIdx];
      positionView[floatOffset + 1] = positions[srcIdx + 1];
      positionView[floatOffset + 2] = positions[srcIdx + 2];

      const colorSrcIdx = i * 4;
      colorView[byteOffset] = snapshotColors[colorSrcIdx];
      colorView[byteOffset + 1] = snapshotColors[colorSrcIdx + 1];
      colorView[byteOffset + 2] = snapshotColors[colorSrcIdx + 2];
      colorView[byteOffset + 3] = snapshotColors[colorSrcIdx + 3];
    }

    // Delete existing buffer if updating
    if (this.snapshotBuffers.has(id)) {
      this.deleteSnapshotBuffer(id);
    }

    // Create GPU buffer
    const glBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);

    // Create VAO for this snapshot
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const STRIDE = 16;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);

    gl.bindVertexArray(null);

    // Compute bounds for custom positions (needed for correct LOD calculation)
    // Only compute if positions differ from main buffer (custom dimension)
    const hasCustomPositions = viewPositions && viewPositions !== this._positions;
    const customBounds = hasCustomPositions
      ? HighPerfRenderer.computeBoundsFromPositions(viewPositions)
      : null;

    const needsSpatialIndex = this._needsSpatialIndex();

    // Build spatial index for custom positions (enables fast frustum culling/LOD for 2D/1D views)
    // This replaces brute-force O(n) culling with O(log n) hierarchical culling.
    // IMPORTANT: Only build when frustum culling or LOD is enabled; otherwise this is wasted work
    // (especially during 3D↔2D switching in multiview).
    let spatialIndex = null;
    let snapshotDimensionLevel = null;
    if (hasCustomPositions && needsSpatialIndex && n > 10000) {
      // Clamp to valid range [1, 3] - consistent with render() and renderWithSnapshot()
      snapshotDimensionLevel = Math.max(1, Math.min(3, HighPerfRenderer.detectDimensionLevel(customBounds)));
      console.log(`[HighPerfRenderer] Building ${snapshotDimensionLevel}D spatial index for snapshot "${id}"...`);

      const notifications = getNotificationCenter();
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      const treeName = treeNames[snapshotDimensionLevel];
      const notifId = notifications.startCalculation(
        `Building ${snapshotDimensionLevel}D ${treeName} for view "${id}" (${n.toLocaleString()} cells)`,
        'spatial'
      );
      const startTime = performance.now();

      const needsLOD = this._needsLodResources();
      spatialIndex = new SpatialIndex(
        viewPositions,
        snapshotColors,
        snapshotDimensionLevel,
        this.options.LOD_MAX_POINTS_PER_NODE,
        this.options.LOD_MAX_DEPTH,
        {
          buildLOD: needsLOD,
          buildLodNodeMappings: false,
          computeNodeStats: false
        }
      );
      const elapsed = performance.now() - startTime;
      notifications.completeCalculation(notifId, `${snapshotDimensionLevel}D ${treeName} ready (view "${id}")`, elapsed);
      console.log(`[HighPerfRenderer] Built ${snapshotDimensionLevel}D spatial index${needsLOD ? ` with ${spatialIndex.lodLevels.length} LOD levels` : ''}`);
    }

    this.snapshotBuffers.set(id, {
      id,
      vao,
      buffer: glBuffer,
      pointCount: n,
      // Store positions reference for future updates (dimension switching)
      positions: viewPositions || this._positions,
      // Store colors to avoid expensive GPU readback in updateSnapshotPositions
      colors: snapshotColors,
      // Store bounds for custom positions (used for correct LOD diagonal calculation)
      bounds: customBounds,
      // Spatial index for fast frustum culling on custom positions (null if using main octree)
      spatialIndex: spatialIndex,
      // Store dimension level used to build the spatial index (for correct LOD/frustum calculations)
      dimensionLevel: snapshotDimensionLevel
    });

    console.log(`[HighPerfRenderer] Created snapshot buffer "${id}" (${n.toLocaleString()} points, ${(n * 16 / 1024 / 1024).toFixed(1)} MB${spatialIndex ? ', with spatial index' : ''})`);
    return true;
  }

  /**
   * Update an existing snapshot buffer with new colors/alphas.
   * More efficient than delete+create as it reuses the GPU buffer.
   * @param {string} id - Snapshot identifier
   * @param {Uint8Array} colors - RGB (3 bytes) or RGBA (4 bytes) colors per point
   * @param {Float32Array} [alphas] - Optional alpha values
   * @param {Float32Array} [viewPositions] - Optional per-view positions (for multi-dimensional support)
   * @returns {boolean} Success
   */
  updateSnapshotBuffer(id, colors, alphas = null, viewPositions = null) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) {
      // Create new buffer if it doesn't exist
      return this.createSnapshotBuffer(id, colors, alphas, viewPositions);
    }

    const gl = this.gl;
    const n = this.pointCount;
    // Use view-specific positions if provided, otherwise use stored snapshot positions, or global positions
    const positions = viewPositions || snapshot.positions || this._positions;

    // Normalize colors to RGBA Uint8 if needed
    const expectedRGBA = n * 4;
    const expectedRGB = n * 3;
    let snapshotColors;

    // Detect Float32Array colors (normalized 0-1 range) and convert to Uint8 (0-255)
    const isFloat32Colors = colors instanceof Float32Array ||
      (colors.length > 0 && colors[0] !== undefined && colors[0] <= 1.0 && !(colors instanceof Uint8Array || colors instanceof Uint8ClampedArray));

    if (isFloat32Colors) {
      // Convert Float32 normalized colors (0-1) to Uint8 (0-255)
      // Clamp values to prevent wrap-around for out-of-range inputs (consistent with createSnapshotBuffer)
      if (colors.length === expectedRGB) {
        snapshotColors = new Uint8Array(expectedRGBA);
        for (let i = 0; i < n; i++) {
          const r = Math.round(colors[i * 3] * 255);
          const g = Math.round(colors[i * 3 + 1] * 255);
          const b = Math.round(colors[i * 3 + 2] * 255);
          snapshotColors[i * 4]     = r > 255 ? 255 : (r < 0 ? 0 : r);
          snapshotColors[i * 4 + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
          snapshotColors[i * 4 + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
          snapshotColors[i * 4 + 3] = 255;
        }
      } else {
        snapshotColors = new Uint8Array(expectedRGBA);
        for (let i = 0; i < n; i++) {
          const r = Math.round(colors[i * 4] * 255);
          const g = Math.round(colors[i * 4 + 1] * 255);
          const b = Math.round(colors[i * 4 + 2] * 255);
          const a = Math.round((colors[i * 4 + 3] ?? 1.0) * 255);
          snapshotColors[i * 4]     = r > 255 ? 255 : (r < 0 ? 0 : r);
          snapshotColors[i * 4 + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
          snapshotColors[i * 4 + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
          snapshotColors[i * 4 + 3] = a > 255 ? 255 : (a < 0 ? 0 : a);
        }
      }
    } else if (colors.length === expectedRGB) {
      // Convert RGB to RGBA (Uint8 input)
      snapshotColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < n; i++) {
        snapshotColors[i * 4]     = colors[i * 3];
        snapshotColors[i * 4 + 1] = colors[i * 3 + 1];
        snapshotColors[i * 4 + 2] = colors[i * 3 + 2];
        snapshotColors[i * 4 + 3] = 255;
      }
    } else {
      // Create a copy of colors to avoid modifying the original (Uint8 RGBA input)
      snapshotColors = new Uint8Array(colors);
    }

    if (alphas) {
      const alphaCount = Math.min(n, alphas.length);
      for (let i = 0; i < alphaCount; i++) {
        // Clamp to 0-255 to prevent wrap-around for out-of-range values
        const val = Math.round(alphas[i] * 255);
        snapshotColors[i * 4 + 3] = val > 255 ? 255 : (val < 0 ? 0 : val);
      }
    }

    // Rebuild interleaved data
    const buffer = new ArrayBuffer(n * 16);
    const positionView = new Float32Array(buffer);
    const colorView = new Uint8Array(buffer);

    for (let i = 0; i < n; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4;
      const byteOffset = i * 16 + 12;

      positionView[floatOffset] = positions[srcIdx];
      positionView[floatOffset + 1] = positions[srcIdx + 1];
      positionView[floatOffset + 2] = positions[srcIdx + 2];

      const colorSrcIdx = i * 4;
      colorView[byteOffset] = snapshotColors[colorSrcIdx];
      colorView[byteOffset + 1] = snapshotColors[colorSrcIdx + 1];
      colorView[byteOffset + 2] = snapshotColors[colorSrcIdx + 2];
      colorView[byteOffset + 3] = snapshotColors[colorSrcIdx + 3];
    }

    // Update existing buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, snapshot.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);

    // Update stored positions reference if provided
    const positionsChanged = viewPositions && viewPositions !== snapshot.positions;
    if (viewPositions) {
      snapshot.positions = viewPositions;
    }
    // Update stored colors to avoid GPU readback in updateSnapshotPositions
    snapshot.colors = snapshotColors;

    // Rebuild spatial index if positions changed
    if (positionsChanged) {
      const needsSpatialIndex = this._needsSpatialIndex();
      const hasCustomPositions = positions !== this._positions;

      if (hasCustomPositions) {
        // Keep bounds up-to-date for correct fog/scale even when we skip spatial index rebuild.
        const customBounds = HighPerfRenderer.computeBoundsFromPositions(positions);
        // Clamp to valid range [1, 3] - consistent with render() and renderWithSnapshot()
        const dimensionLevel = Math.max(1, Math.min(3, HighPerfRenderer.detectDimensionLevel(customBounds)));
        snapshot.bounds = customBounds;

        // Only build a spatial index when frustum culling or LOD is enabled; otherwise skip to
        // avoid expensive quadtree builds during 3D↔2D switching in multiview.
        if (needsSpatialIndex && n > 10000) {
          const notifications = getNotificationCenter();
          const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
          const treeName = treeNames[dimensionLevel];
          const notifId = notifications.startCalculation(
            `Rebuilding ${dimensionLevel}D ${treeName} for view "${id}" (${n.toLocaleString()} cells)`,
            'spatial'
          );
          const startTime = performance.now();

          const needsLOD = this._needsLodResources();
          snapshot.spatialIndex = new SpatialIndex(
            positions,
            snapshotColors,
            dimensionLevel,
            this.options.LOD_MAX_POINTS_PER_NODE,
            this.options.LOD_MAX_DEPTH,
            {
              buildLOD: needsLOD,
              buildLodNodeMappings: false,
              computeNodeStats: false
            }
          );
          snapshot.dimensionLevel = dimensionLevel;
          const elapsed = performance.now() - startTime;
          notifications.completeCalculation(notifId, `${dimensionLevel}D ${treeName} ready (view "${id}")`, elapsed);
          console.log(`[HighPerfRenderer] Rebuilt ${dimensionLevel}D spatial index for snapshot "${id}"`);
        } else {
          snapshot.spatialIndex = null;
          snapshot.dimensionLevel = null;
        }
      } else {
        snapshot.bounds = null;
        snapshot.spatialIndex = null;
        snapshot.dimensionLevel = null;
      }
    }

    return true;
  }

  /**
   * Update only the positions for a snapshot buffer (for dimension switching).
   * Preserves existing colors using stored color array (no GPU readback needed).
   * @param {string} id - Snapshot identifier
   * @param {Float32Array} viewPositions - New positions for the view
   * @param {Object} [options] - Optional settings
   * @param {boolean} [options.syncColors=false] - If true, sync colors with current main buffer colors
   *   instead of using the stored snapshot colors. Use this when main colors have changed via
   *   updateColors() and you want the snapshot to reflect those changes.
   * @returns {boolean} Success
   */
  updateSnapshotPositions(id, viewPositions, options = {}) {
    const { syncColors = false } = options;

    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) {
      console.warn(`[HighPerfRenderer] Cannot update positions: snapshot "${id}" not found`);
      return false;
    }

    if (!viewPositions || viewPositions.length !== this.pointCount * 3) {
      console.warn(`[HighPerfRenderer] Invalid positions array for snapshot "${id}"`);
      return false;
    }

    // Determine which colors to use
    let colorsToUse;
    if (syncColors && this._colors) {
      // Use current main buffer colors
      colorsToUse = this._colors;
    } else if (snapshot.colors) {
      // Use stored snapshot colors
      colorsToUse = snapshot.colors;
    } else {
      console.warn(`[HighPerfRenderer] No colors available for snapshot "${id}" - cannot update positions`);
      return false;
    }

    const gl = this.gl;
    const n = this.pointCount;
    const storedColors = colorsToUse;

    // Build new interleaved buffer with new positions and stored colors
    const newBuffer = new ArrayBuffer(n * 16);
    const newPositionView = new Float32Array(newBuffer);
    const newColorView = new Uint8Array(newBuffer);

    for (let i = 0; i < n; i++) {
      const srcIdx = i * 3;
      const floatOffset = i * 4;
      const byteOffset = i * 16 + 12;
      const colorIdx = i * 4;

      // New positions
      newPositionView[floatOffset] = viewPositions[srcIdx];
      newPositionView[floatOffset + 1] = viewPositions[srcIdx + 1];
      newPositionView[floatOffset + 2] = viewPositions[srcIdx + 2];

      // Copy stored colors (RGBA)
      newColorView[byteOffset] = storedColors[colorIdx];
      newColorView[byteOffset + 1] = storedColors[colorIdx + 1];
      newColorView[byteOffset + 2] = storedColors[colorIdx + 2];
      newColorView[byteOffset + 3] = storedColors[colorIdx + 3];
    }

    // Upload new buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, snapshot.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, newBuffer, gl.STATIC_DRAW);

    // Update stored positions reference
    snapshot.positions = viewPositions;

    // If we synced colors from main buffer, update stored colors so future updates use them
    if (syncColors && this._colors) {
      snapshot.colors = new Uint8Array(this._colors);
    }

    // Update bounds for the new positions (needed for correct LOD calculation)
    snapshot.bounds = HighPerfRenderer.computeBoundsFromPositions(viewPositions);

    // Rebuild spatial index for the new positions (enables fast frustum culling/LOD)
    const needsSpatialIndex = this._needsSpatialIndex();
    const hasCustomPositions = viewPositions !== this._positions;
    if (hasCustomPositions && needsSpatialIndex && n > 10000 && snapshot.colors) {
      // Clamp to valid range [1, 3] - consistent with render() and renderWithSnapshot()
      const detectedDimLevel = Math.max(1, Math.min(3, HighPerfRenderer.detectDimensionLevel(snapshot.bounds)));

      const notifications = getNotificationCenter();
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      const treeName = treeNames[detectedDimLevel];
      const notifId = notifications.startCalculation(
        `Rebuilding ${detectedDimLevel}D ${treeName} for view "${id}" (${n.toLocaleString()} cells)`,
        'spatial'
      );
      const startTime = performance.now();

      const needsLOD = this._needsLodResources();
      snapshot.spatialIndex = new SpatialIndex(
        viewPositions,
        snapshot.colors,
        detectedDimLevel,
        this.options.LOD_MAX_POINTS_PER_NODE,
        this.options.LOD_MAX_DEPTH,
        {
          buildLOD: needsLOD,
          buildLodNodeMappings: false,
          computeNodeStats: false
        }
      );
      snapshot.dimensionLevel = detectedDimLevel;  // Store for consistent LOD/frustum calculations
      const elapsed = performance.now() - startTime;
      notifications.completeCalculation(notifId, `${detectedDimLevel}D ${treeName} ready (view "${id}")`, elapsed);
      console.log(`[HighPerfRenderer] Rebuilt ${detectedDimLevel}D spatial index for snapshot "${id}"`);
    } else {
      snapshot.spatialIndex = null;
      snapshot.dimensionLevel = null;  // Clear since using main spatial index
    }

    // IMPORTANT: Clear per-view cache for this snapshot to force frustum re-culling
    // When positions change, the old frustum indices are invalid for the new positions
    // Normalize id to string to match how _getViewState stores keys
    const viewState = this._perViewState.get(String(id));
    if (viewState) {
      viewState.lastFrustumMVP = null;  // Force full frustum recalculation
      viewState.cachedVisibleIndices = null;
      viewState.cachedLodVisibleIndices = null;
      viewState.cachedLodLevel = -1;
    }

    console.log(`[HighPerfRenderer] Updated positions for snapshot "${id}"${syncColors ? ' (colors synced)' : ''}`);
    return true;
  }

  /**
   * Sync a snapshot's colors with the current main buffer colors.
   * Use this when colors have changed via updateColors() and snapshots need to reflect the changes.
   * @param {string} id - Snapshot identifier
   * @returns {boolean} Success
   */
  syncSnapshotColors(id) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) {
      console.warn(`[HighPerfRenderer] Cannot sync colors: snapshot "${id}" not found`);
      return false;
    }

    if (!this._colors) {
      console.warn(`[HighPerfRenderer] Cannot sync colors: no main buffer colors available`);
      return false;
    }

    // Use updateSnapshotBuffer with current positions and new colors
    const positions = snapshot.positions || this._positions;
    return this.updateSnapshotBuffer(id, this._colors, null, positions);
  }

  /**
   * Sync all snapshots' colors with the current main buffer colors.
   * Use this after updateColors() to ensure all snapshot views show the updated colors.
   * @returns {number} Number of snapshots successfully updated
   */
  syncAllSnapshotColors() {
    let count = 0;
    for (const id of this.snapshotBuffers.keys()) {
      if (this.syncSnapshotColors(id)) {
        count++;
      }
    }
    if (count > 0) {
      console.log(`[HighPerfRenderer] Synced colors for ${count} snapshot(s)`);
    }
    return count;
  }

  /**
   * Delete a snapshot's GPU resources.
   * @param {string} id - Snapshot identifier
   */
  deleteSnapshotBuffer(id) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) return;

    const gl = this.gl;
    if (snapshot.buffer) gl.deleteBuffer(snapshot.buffer);
    if (snapshot.vao) gl.deleteVertexArray(snapshot.vao);

    this.snapshotBuffers.delete(id);
    console.log(`[HighPerfRenderer] Deleted snapshot buffer "${id}"`);
  }

  /**
   * Delete all snapshot buffers. Call when clearing all snapshots.
   */
  deleteAllSnapshotBuffers() {
    for (const id of this.snapshotBuffers.keys()) {
      this.deleteSnapshotBuffer(id);
    }
  }

  /**
   * Check if a snapshot buffer exists.
   * @param {string} id - Snapshot identifier
   * @returns {boolean}
   */
  hasSnapshotBuffer(id) {
    return this.snapshotBuffers.has(id);
  }

  /**
   * Get a snapshot's spatial index for picking/queries.
   * Returns null if snapshot doesn't exist or uses the main spatial index.
   * @param {string} id - Snapshot identifier
   * @returns {SpatialIndex|null}
   */
  getSnapshotSpatialIndex(id) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) return null;
    // Only return snapshot's own spatial index if it has custom positions
    if (snapshot.positions && snapshot.positions !== this._positions && snapshot.spatialIndex) {
      return snapshot.spatialIndex;
    }
    return null;
  }

  /**
   * Rebuild a snapshot's spatial index for a new dimension level.
   * Call this when changing a view's dimension to ensure LOD/frustum culling works correctly.
   * @param {string} id - Snapshot identifier
   * @param {number} dimensionLevel - New dimension level (1, 2, or 3)
   * @returns {boolean} Success
   */
  rebuildSnapshotSpatialIndex(id, dimensionLevel) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) return false;

    // If spatial indexing isn't active (no frustum culling and no LOD), do not rebuild here.
    // This avoids expensive quadtree builds during 3D↔2D switching in multiview when the
    // index would not be used by the render paths.
    if (!this._needsSpatialIndex()) {
      snapshot.spatialIndex = null;
      snapshot.dimensionLevel = null;
      return true;
    }

    // Only rebuild if snapshot has custom positions (otherwise uses main spatial index)
    if (!snapshot.positions || snapshot.positions === this._positions) {
      // Clear any existing spatial index since it should use main index
      snapshot.spatialIndex = null;
      snapshot.dimensionLevel = null;
      return true;
    }

    // Check if we have enough points to warrant a spatial index
    const n = snapshot.positions.length / 3;
    if (n <= 10000) {
      snapshot.spatialIndex = null;
      snapshot.dimensionLevel = null;
      return true;
    }

    // Rebuild spatial index for the new dimension
    const clampedDim = Math.max(1, Math.min(3, dimensionLevel));

    // If we already have a valid spatial index for this positions array and dimension, don't rebuild.
    // This prevents duplicate quadtree builds when a dimension change updates positions first and then
    // calls rebuildSnapshotSpatialIndex() (common in multiview switching flows).
    if (snapshot.spatialIndex &&
        snapshot.spatialIndex.positions === snapshot.positions &&
        snapshot.dimensionLevel === clampedDim) {
      const needsLOD = this._needsLodResources();
      if (needsLOD && (!snapshot.spatialIndex.lodLevels || snapshot.spatialIndex.lodLevels.length === 0)) {
        snapshot.spatialIndex.ensureLODLevels();
      }
      return true;
    }

    console.log(`[HighPerfRenderer] Rebuilding ${clampedDim}D spatial index for snapshot "${id}"...`);

    const notifications = getNotificationCenter();
    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[clampedDim];
    const cellCount = snapshot.pointCount || this.pointCount;
    const notifId = notifications.startCalculation(
      `Rebuilding ${clampedDim}D ${treeName} for view "${id}" (${cellCount.toLocaleString()} cells)`,
      'spatial'
    );
    const startTime = performance.now();

    const needsLOD = this._needsLodResources();
    snapshot.spatialIndex = new SpatialIndex(
      snapshot.positions,
      snapshot.colors || this._colors,
      clampedDim,
      this.options.LOD_MAX_POINTS_PER_NODE,
      this.options.LOD_MAX_DEPTH,
      {
        buildLOD: needsLOD,
        buildLodNodeMappings: false,
        computeNodeStats: false
      }
    );
    snapshot.dimensionLevel = clampedDim;
    const elapsed = performance.now() - startTime;
    notifications.completeCalculation(notifId, `${clampedDim}D ${treeName} ready (view "${id}")`, elapsed);
    console.log(`[HighPerfRenderer] Built ${clampedDim}D spatial index${needsLOD ? ` with ${snapshot.spatialIndex.lodLevels.length} LOD levels` : ''}`);
    return true;
  }

  /**
   * Render using a snapshot's pre-uploaded buffer. No data upload occurs.
   * Supports frustum culling and LOD for all views (not just the live view).
   * @param {string} id - Snapshot identifier
   * @param {Object} params - Render parameters (same as render())
   * @param {boolean} [params.useAlphaTexture=false] - If true, use the alpha texture for real-time
   *   filter/transparency updates instead of baked snapshot alpha. This allows snapshots to reflect
   *   filter changes immediately without rebuilding the snapshot buffer.
   * @returns {Object} Stats
   */
  renderWithSnapshot(id, params) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) {
      console.warn(`[HighPerfRenderer] Snapshot buffer "${id}" not found, falling back to main buffer`);
      return this.render(params);
    }

    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize = 5.0, sizeAttenuation = 0.0, viewportHeight, fov,
      lightingStrength = 0.6, fogDensity = 0.5,
      fogColor = [1, 1, 1], lightDir = [0.5, 0.7, 0.5],
      cameraPosition = [0, 0, 3], cameraDistance = 3.0,
      forceLOD = -1,
      quality = this.activeQuality,
      viewId,  // Per-view state identifier (required for multi-view rendering!)
      dimensionLevel = 3,  // Current dimension level (1, 2, 3, or 4) for LOD/frustum calculations
      useAlphaTexture = false  // If true, use alpha texture for real-time filter updates
    } = params;

    const frameStart = performance.now();

    // Clamp dimension level to valid range [1, 3] - prevents invalid spatial index lookups
    const clampedParamDimLevel = Math.max(1, Math.min(3, dimensionLevel));

    // Get per-view state for frustum culling and LOD caching
    const viewState = this._getViewState(viewId);

    // Check if snapshot has custom positions (different dimension)
    // The octree is built from main positions, so its bounds don't match custom positions
    const hasCustomPositions = snapshot.positions && snapshot.positions !== this._positions;

    const needsSpatialIndex = this._needsSpatialIndex(forceLOD);
    const needsLOD = this._needsLodResources(forceLOD);

    // Ensure bounds for custom-position snapshots (fog + LOD/frustum calculations).
    if (hasCustomPositions && !snapshot.bounds) {
      snapshot.bounds = HighPerfRenderer.computeBoundsFromPositions(snapshot.positions);
    }

    // Lazily build/refresh spatial index for custom-position snapshots only when needed.
    // This avoids expensive quadtree builds during 3D↔2D switching when frustum culling/LOD are off.
    if (hasCustomPositions && needsSpatialIndex && snapshot.positions && snapshot.colors && snapshot.pointCount > 10000) {
      const snapshotDimLevel = Math.max(1, Math.min(3, HighPerfRenderer.detectDimensionLevel(snapshot.bounds)));
      const indexStale =
        !snapshot.spatialIndex ||
        snapshot.spatialIndex.positions !== snapshot.positions ||
        snapshot.dimensionLevel !== snapshotDimLevel;

      if (indexStale) {
        console.log(`[HighPerfRenderer] Building ${snapshotDimLevel}D spatial index for snapshot "${id}"...`);

        const notifications = getNotificationCenter();
        const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
        const treeName = treeNames[snapshotDimLevel];
        const notifId = notifications.startCalculation(
          `Building ${snapshotDimLevel}D ${treeName} for view "${id}" (${snapshot.pointCount.toLocaleString()} cells)`,
          'spatial'
        );
        const startTime = performance.now();

        snapshot.spatialIndex = new SpatialIndex(
          snapshot.positions,
          snapshot.colors,
          snapshotDimLevel,
          this.options.LOD_MAX_POINTS_PER_NODE,
          this.options.LOD_MAX_DEPTH,
          {
            buildLOD: needsLOD,
            buildLodNodeMappings: false,
            computeNodeStats: false
          }
        );
        snapshot.dimensionLevel = snapshotDimLevel;
        const elapsed = performance.now() - startTime;
        notifications.completeCalculation(notifId, `${snapshotDimLevel}D ${treeName} ready (view "${id}")`, elapsed);
        console.log(`[HighPerfRenderer] Built ${snapshotDimLevel}D spatial index${needsLOD ? ` with ${snapshot.spatialIndex.lodLevels.length} LOD levels` : ''}`);
      } else if (needsLOD && (!snapshot.spatialIndex.lodLevels || snapshot.spatialIndex.lodLevels.length === 0)) {
        snapshot.spatialIndex.ensureLODLevels();
      }
    }

    // Use snapshot's stored dimension level when it has custom positions with a spatial index
    // This ensures consistency between the spatial index and the dimension used for LOD/frustum calculations
    // Fall back to clamped params.dimensionLevel for snapshots using main positions (which use main spatial index)
    const effectiveDimLevel = (hasCustomPositions && snapshot.spatialIndex && snapshot.dimensionLevel !== null)
      ? snapshot.dimensionLevel  // Already clamped when stored
      : clampedParamDimLevel;

    // Create modified params for helper functions if dimension level differs from original params
    // This ensures _checkFrustumCacheValid and other helpers use the correct dimension for cache invalidation
    const effectiveParams = (effectiveDimLevel !== dimensionLevel)
      ? { ...params, dimensionLevel: effectiveDimLevel }
      : params;

    // Auto-compute fog range using snapshot bounds when available (for correct fog in custom dimension views)
    if (params.autoFog !== false) {
      this.autoComputeFogRange(cameraPosition, hasCustomPositions ? snapshot.bounds : null);
    }

    // Set quality if changed
    if (quality !== this.activeQuality) {
      this.setQuality(quality);
    }

    // Get the correct spatial index for this view's dimension level (for non-custom positions)
    // Custom positions use snapshot.spatialIndex instead
    const mainSpatialIndex = (!hasCustomPositions && needsSpatialIndex) ? this.getSpatialIndexForDimension(effectiveDimLevel) : null;

    // For adaptive LOD, use snapshot's spatial index for custom positions (if available)
    // This enables LOD for 1D/2D views that have their own spatial index built from custom positions
    const lodSpatialIndex = hasCustomPositions ? snapshot.spatialIndex : mainSpatialIndex;
    const lodBuffersForDim = this.getLodBuffersForDimension(effectiveDimLevel);

    // Select LOD level based on whether LOD is enabled (consistent with render())
    // When LOD is disabled, forceLODLevel is ignored - only params.forceLOD is respected
    // This ensures disabling LOD always returns to full detail (unless explicitly overridden per-render)
    let lodLevel;
    if (this.useAdaptiveLOD) {
      // LOD enabled: Priority is this.forceLODLevel > params.forceLOD > adaptive
      lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
      if (lodLevel < 0 && lodSpatialIndex) {
        // Pass effectiveDimLevel for correct 2D/3D diagonal calculation (uses snapshot's stored dimension for custom positions)
        // Pass snapshot bounds when available (for custom positions that differ from octree)
        lodLevel = lodSpatialIndex.getLODLevel(cameraDistance, viewportHeight, viewState.lastLodLevel, effectiveDimLevel, snapshot.bounds);
      }
    } else {
      // LOD disabled: only respect explicit per-render forceLOD, otherwise full detail
      lodLevel = forceLOD >= 0 ? forceLOD : -1;
    }

    // Always update per-view LOD level for highlight rendering and other consumers
    // NOTE: lastDimensionLevel is NOT set here - it's handled inside _checkFrustumCacheValid
    // to properly detect dimension changes and invalidate the frustum cache
    viewState.lastLodLevel = lodLevel;

    // Get size multiplier from LOD level for visual consistency
    let sizeMultiplier = 1.0;
    if (lodLevel >= 0 && lodLevel < lodBuffersForDim.length) {
      const lod = lodBuffersForDim[lodLevel];
      if (lod && !lod.isFullDetail) {
        sizeMultiplier = lod.sizeMultiplier || 1.0;
      }
    }

    // Debug LOD selection for snapshots - only log when level changes (per-view)
    if (viewState.prevLodLevel !== lodLevel && lodSpatialIndex && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const pointCount = lodSpatialIndex.lodLevels[lodLevel]?.pointCount || this.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      if (DEBUG_LOD_FRUSTUM) console.log(`[LOD] Snapshot ${viewId}: level ${viewState.prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode}, dim=${effectiveDimLevel})`);
      viewState.prevLodLevel = lodLevel;
    }

    // Determine if we should use full detail or LOD
    // Check both global LOD buffers AND the spatial index's LOD levels
    // This allows snapshots with custom positions (and their own spatial index) to use LOD
    // even if no global LOD buffers exist for that dimension
    const hasGlobalLodBuffer = lodBuffersForDim.length > 0 && lodLevel < lodBuffersForDim.length && lodBuffersForDim[lodLevel];
    const hasLocalLodLevel = lodSpatialIndex?.lodLevels?.[lodLevel]?.indices?.length > 0;
    const isGlobalFullDetail = hasGlobalLodBuffer && lodBuffersForDim[lodLevel].isFullDetail;

    const useFullDetail = lodLevel < 0 ||
      (!hasGlobalLodBuffer && !hasLocalLodLevel) ||
      isGlobalFullDetail;

    // Frustum culling for snapshots:
    // - When positions match main buffer: use main octree for culling
    // - When positions are custom (2D/1D views): use snapshot's spatial index (quadtree/binary tree)
    if (this.useFrustumCulling) {
      // Pass snapshot bounds for correct frustum margin calculation in 2D/1D views
      const boundsForFrustum = hasCustomPositions ? snapshot.bounds : null;
      const frustumPlanes = this.extractFrustumPlanes(mvpMatrix, viewState.frustumPlanes, boundsForFrustum);

      // Determine which spatial index to use
      // Validate that spatial index is not stale (positions match)
      let spatialIndex = null;
      if (hasCustomPositions) {
        // Use snapshot's spatial index only if it exists and was built from current positions
        if (snapshot.spatialIndex && snapshot.spatialIndex.positions === snapshot.positions) {
          spatialIndex = snapshot.spatialIndex;
        }
      } else {
        // Use the dimension-appropriate spatial index (quadtree for 2D, octree for 3D)
        spatialIndex = mainSpatialIndex;
      }

      if (spatialIndex) {
        // For 2D data (effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD), disable depth testing entirely
        // to prevent draw-order artifacts. When all points have the same Z, depth testing causes visual
        // differences at quadtree boundaries because frustum culling changes the draw order (spatially
        // grouped vs original). Disabling depth writes alone is insufficient - we must also disable depth testing.
        const disableDepth = effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
        if (disableDepth) {
          gl.disable(gl.DEPTH_TEST);
        }

        // Use spatial index for hierarchical frustum culling (O(log n))
        // Pass effectiveParams to ensure helper functions use correct dimensionLevel for cache invalidation
        if (useFullDetail) {
          this._renderSnapshotWithFrustumCulling(snapshot, effectiveParams, frustumPlanes, viewState, sizeMultiplier, useAlphaTexture, spatialIndex);
        } else {
          this._renderSnapshotLODWithFrustumCulling(snapshot, lodLevel, effectiveParams, frustumPlanes, viewState, useAlphaTexture, spatialIndex, lodBuffersForDim);
        }

        // Restore depth testing
        if (disableDepth) {
          gl.enable(gl.DEPTH_TEST);
        }
      } else {
        // No spatial index available, fall through to render all
        this.stats.frustumCulled = false;
        this.stats.cullPercent = 0;
      }

      if (this.stats.frustumCulled || spatialIndex) {
        this.stats.lastFrameTime = performance.now() - frameStart;
        this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));
        return this.stats;
      }
    }

    // For 2D data (effectiveDimLevel <= 2), disable depth testing to prevent draw-order artifacts
    // This is consistent with the frustum culling path and the main render() function
    const disableDepth = effectiveDimLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
    if (disableDepth) {
      gl.disable(gl.DEPTH_TEST);
    }

    // No frustum culling - check if we should use LOD
    if (!useFullDetail) {
      // Render with LOD using indexed drawing into snapshot buffer
      // Use lodSpatialIndex for custom positions (snapshot.spatialIndex) or main spatial index
      // Pass effectiveParams to ensure correct dimensionLevel is used
      this._renderSnapshotWithLOD(snapshot, lodLevel, effectiveParams, viewState, useAlphaTexture, lodSpatialIndex, lodBuffersForDim);

      // Restore depth testing
      if (disableDepth) {
        gl.enable(gl.DEPTH_TEST);
      }

      this.stats.lastFrameTime = performance.now() - frameStart;
      this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));
      return this.stats;
    }

    // No frustum culling - render all points with snapshot VAO
    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      console.error('[HighPerfRenderer] No program/uniforms for snapshot render');
      return this.stats;
    }

    gl.useProgram(program);

    // Set uniforms
    const adjustedPointSize = pointSize * sizeMultiplier;
    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Alpha texture handling: if useAlphaTexture is true, use real-time alpha from texture
    // Otherwise use baked alpha from snapshot's interleaved buffer
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, -1);  // -1 for full detail (no LOD index texture)
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
      // Bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_useLodIndexTex !== null) gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }

    // Reset frustum culling stats
    this.stats.frustumCulled = false;
    this.stats.cullPercent = 0;

    // Bind snapshot's VAO (no data upload!)
    gl.bindVertexArray(snapshot.vao);
    gl.drawArrays(gl.POINTS, 0, snapshot.pointCount);
    gl.bindVertexArray(null);

    // Unbind alpha texture if it was used
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Restore depth testing (matches the disable at line 4308)
    if (disableDepth) {
      gl.enable(gl.DEPTH_TEST);
    }

    // Update dimension level for non-frustum path (for getCombinedVisibilityForView and other consumers)
    // This is done after rendering to ensure accurate per-view tracking without breaking cache invalidation
    viewState.lastDimensionLevel = effectiveDimLevel;

    this.stats.visiblePoints = snapshot.pointCount;
    this.stats.lodLevel = lodLevel;
    this.stats.drawCalls = 1;
    this.stats.lastFrameTime = performance.now() - frameStart;
    this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));

    return this.stats;
  }

  /**
   * Render snapshot with frustum culling using indexed drawing.
   * Snapshots share positions with main buffer, so the same octree/indices work.
   * Uses per-view index buffer to avoid cross-view conflicts.
   * @param {boolean} [useAlphaTexture=false] - If true, use alpha texture for real-time filter updates
   * @param {SpatialIndex} [spatialIndex] - Spatial index to use (snapshot's own or main octree)
   * @private
   */
  _renderSnapshotWithFrustumCulling(snapshot, params, frustumPlanes, viewState, sizeMultiplier = 1.0, useAlphaTexture = false, spatialIndex = null) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId = snapshot.id,
      dimensionLevel = 3  // For cache invalidation on dimension change
    } = params;

    // Use provided spatial index or fall back to dimension-appropriate spatial index
    const tree = spatialIndex || this.spatialIndices.get(dimensionLevel);
    if (!tree) {
      this._renderSnapshotFullDetail(snapshot, params, sizeMultiplier, useAlphaTexture);
      return;
    }

    const needsUpdate = this._checkFrustumCacheValid(mvpMatrix, viewState, dimensionLevel);

    if (needsUpdate) {
      const visibleNodes = [];
      this._collectVisibleNodes(tree.root, frustumPlanes, visibleNodes);

      if (visibleNodes.length === 0) {
        // Fallback to full detail when no visible nodes (e.g., camera too distant)
        // Only log once per view (not every frame)
        if (!viewState._noVisibleNodesWarned) {
          console.warn(`[FrustumCulling] Snapshot ${viewId}: No visible nodes - falling back to full detail`);
          viewState._noVisibleNodesWarned = true;
        }
        viewState.cachedCulledCount = 0;
        viewState.cachedVisibleIndices = null;
        this.stats.frustumCulled = false;
        this.stats.cullPercent = 0;
        this._renderSnapshotFullDetail(snapshot, params, sizeMultiplier, useAlphaTexture);
        return;
      }

      // Count total visible points
      let totalVisible = 0;
      for (const node of visibleNodes) {
        if (node.indices) totalVisible += node.indices.length;
      }

      // Reuse per-view pooled buffer (avoids cross-view interference in multi-view rendering)
      if (!viewState.visibleIndicesBuffer || viewState.visibleIndicesCapacity < totalVisible) {
        viewState.visibleIndicesCapacity = Math.ceil(totalVisible * 1.25);
        viewState.visibleIndicesBuffer = new Uint32Array(viewState.visibleIndicesCapacity);
      }

      let writeOffset = 0;
      for (const node of visibleNodes) {
        if (node.indices) {
          viewState.visibleIndicesBuffer.set(node.indices, writeOffset);
          writeOffset += node.indices.length;
        }
      }

      const visibleIndices = viewState.visibleIndicesBuffer.subarray(0, totalVisible);
      const visibleRatio = totalVisible / snapshot.pointCount;
      const cullPercent = ((1 - visibleRatio) * 100);

      // If >98% visible, render everything
      if (visibleRatio > 0.98) {
        viewState.cachedCulledCount = 0;
        viewState.cachedVisibleIndices = null;
        viewState._noVisibleNodesWarned = false;  // Reset warning flag
        this.stats.frustumCulled = false;
        this.stats.cullPercent = cullPercent;
        this._renderSnapshotFullDetail(snapshot, params, sizeMultiplier, useAlphaTexture);
        return;
      }

      // Log only on significant change (>10% of total points)
      if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleIndices.length, snapshot.pointCount)) {
        console.log(`[FrustumCulling] Snapshot ${viewId}: ${visibleIndices.length.toLocaleString()}/${snapshot.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleIndices.length;
      }

      // Store count for cache validation - no need to copy indices since they're uploaded to GPU
      // The indices data is in viewState.indexBuffer (GPU) and visibleIndicesBuffer (pooled CPU buffer)
      viewState.cachedCulledCount = visibleIndices.length;
      viewState._noVisibleNodesWarned = false;  // Reset warning flag since we have visible nodes

      // Upload to per-view index buffer (each view has its own buffer)
      this._uploadToViewIndexBuffer(viewState, visibleIndices);
      this.stats.frustumCulled = true;
      this.stats.cullPercent = cullPercent;
    }

    if (!viewState.cachedCulledCount || viewState.cachedCulledCount === 0) {
      this._renderSnapshotFullDetail(snapshot, params, sizeMultiplier, useAlphaTexture);
      return;
    }

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      console.warn('[FrustumCulling] No program/uniforms for snapshot render');
      return;
    }

    gl.useProgram(program);

    const adjustedPointSize = pointSize * sizeMultiplier;
    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Alpha texture handling: if useAlphaTexture is true, use real-time alpha from texture
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, -1);  // -1 for full detail
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
      // Bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_useLodIndexTex !== null) gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }

    // Defensive check: ensure index buffer is valid before drawing
    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      console.warn(`[FrustumCulling] Snapshot ${viewId}: Index buffer size mismatch - falling back to full detail`);
      this._renderSnapshotFullDetail(snapshot, params, sizeMultiplier, useAlphaTexture);
      return;
    }

    // Bind snapshot VAO and per-view index buffer for indexed drawing
    gl.bindVertexArray(snapshot.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
    gl.drawElements(gl.POINTS, viewState.cachedCulledCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    // Unbind alpha texture if it was used
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Update both global and per-view stats
    this._updateStats(viewState, {
      visiblePoints: viewState.cachedCulledCount,
      lodLevel: -1,
      drawCalls: 1
    });
  }

  /**
   * Render snapshot at full detail (no frustum culling).
   * @param {boolean} [useAlphaTexture=false] - If true, use alpha texture for real-time filter updates
   * @private
   */
  _renderSnapshotFullDetail(snapshot, params, sizeMultiplier = 1.0, useAlphaTexture = false) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) return;

    gl.useProgram(program);

    const adjustedPointSize = pointSize * sizeMultiplier;
    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Alpha texture handling: if useAlphaTexture is true, use real-time alpha from texture
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, -1);  // -1 for full detail
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
      // Bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_useLodIndexTex !== null) gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }

    gl.bindVertexArray(snapshot.vao);
    gl.drawArrays(gl.POINTS, 0, snapshot.pointCount);
    gl.bindVertexArray(null);

    // Unbind alpha texture if it was used
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    this.stats.visiblePoints = snapshot.pointCount;
    this.stats.lodLevel = -1;
    this.stats.drawCalls = 1;
  }

  /**
   * Render snapshot with LOD (no frustum culling).
   * Uses indexed drawing into the snapshot buffer with LOD-selected indices.
   * @param {boolean} [useAlphaTexture=false] - If true, use alpha texture for real-time filter updates
   * @param {SpatialIndex} [spatialIndex] - Spatial index to use (for LOD levels)
   * @param {Array} [lodBuffersForDim] - LOD buffers for the view's dimension level
   * @private
   */
  _renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture = false, spatialIndex = null, lodBuffersForDim = null) {
    const gl = this.gl;
    const dimensionLevel = params.dimensionLevel || this.currentDimensionLevel;
    const lodBuffers = lodBuffersForDim || this.getLodBuffersForDimension(dimensionLevel);
    const tree = spatialIndex || this.spatialIndices.get(dimensionLevel);

    // Get LOD buffer info (may be null for custom-position snapshots without global LOD buffers)
    const lod = lodBuffers?.[lodLevel];

    // Check if the tree has LOD levels we can use for indexed drawing
    const hasTreeLodLevel = tree?.lodLevels?.[lodLevel]?.indices?.length > 0;

    // Fall back to full detail if:
    // - No LOD buffer AND no tree LOD level available
    // - LOD buffer exists but is marked as full detail
    if ((!lod && !hasTreeLodLevel) || (lod && lod.isFullDetail)) {
      this._renderSnapshotFullDetail(snapshot, params, lod?.sizeMultiplier || 1.0, useAlphaTexture);
      return;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    // Check if we need to update the LOD buffer:
    // 1. LOD level changed - need different LOD data
    // 2. Coming from frustum-culled mode - need full LOD instead of filtered subset
    // 3. Dimension changed - need LOD buffer from different dimension's spatial index
    const lodLevelChanged = viewState.cachedLodLevel !== lodLevel;
    const wasFrustumCulled = viewState.cachedLodIsCulled;
    const dimensionChanged = viewState.cachedLodDimension !== -1 && viewState.cachedLodDimension !== dimensionLevel;
    const needsBufferUpdate = lodLevelChanged || wasFrustumCulled || dimensionChanged;

    // Determine if we can use pre-cached index buffer (main spatial index, not snapshot-specific)
    // Pre-cached buffers are stored in lodBuffers and match the main spatial index
    const usingMainSpatialIndex = !spatialIndex || spatialIndex === this.spatialIndices.get(dimensionLevel);
    const hasPreCachedBuffer = lod && lod.originalIndexBuffer && lod.originalIndexCount > 0;
    const canUsePreCachedBuffer = usingMainSpatialIndex && hasPreCachedBuffer;

    if (needsBufferUpdate) {
      if (canUsePreCachedBuffer) {
        // USE PRE-CACHED INDEX BUFFER: No upload needed, just bind directly during draw
        // This eliminates the expensive gl.bufferData call on LOD level change
        viewState.cachedCulledCount = lod.originalIndexCount;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = false;
        viewState.usePreCachedIndexBuffer = true;  // Flag to use pre-cached buffer during draw
        viewState.preCachedIndexBuffer = lod.originalIndexBuffer;
      } else if (tree && tree.lodLevels && tree.lodLevels[lodLevel]) {
        // FALLBACK: Upload LOD indices for snapshots with custom positions
        // This is needed when snapshot has its own spatial index with different LOD indices
        const lodOriginalIndices = tree.lodLevels[lodLevel].indices;
        this._uploadToViewIndexBuffer(viewState, lodOriginalIndices);
        viewState.cachedCulledCount = lodOriginalIndices.length;
        viewState.cachedLodLevel = lodLevel;
        viewState.cachedLodDimension = dimensionLevel;
        viewState.cachedLodIsCulled = false;
        viewState.usePreCachedIndexBuffer = false;
        viewState.preCachedIndexBuffer = null;
      }
    }

    // Size multiplier from LOD buffer if available, otherwise estimate from tree's LOD level
    // Note: When using tree LOD levels without global LOD buffers, we estimate the size multiplier
    // based on the ratio of LOD point count to total point count
    let sizeMultiplier = 1.0;
    if (lod?.sizeMultiplier) {
      sizeMultiplier = lod.sizeMultiplier;
    } else if (tree?.lodLevels?.[lodLevel]) {
      // Estimate size multiplier based on point density reduction
      const lodPointCount = tree.lodLevels[lodLevel].pointCount || tree.lodLevels[lodLevel].indices?.length || 0;
      const totalPoints = tree.pointCount || snapshot.pointCount;
      if (lodPointCount > 0 && totalPoints > 0) {
        const reduction = totalPoints / lodPointCount;
        // Point size should scale roughly with sqrt of density reduction to maintain visual consistency
        sizeMultiplier = Math.sqrt(reduction);
      }
    }
    const adjustedPointSize = pointSize * sizeMultiplier;

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) return;

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Alpha texture handling: if useAlphaTexture is true, use real-time alpha from texture
    // IMPORTANT: For snapshot LOD with indexed drawing, the index buffer contains ORIGINAL indices
    // (from tree.lodLevels[level].indices), so gl_VertexID is already the original index.
    // We must NOT use the LOD index texture (pass -1) because:
    // - LOD index texture maps LOD vertex index (0 to lodPointCount-1) → original index
    // - But here gl_VertexID is already the original index from the element array buffer
    // Using LOD index texture would produce garbage lookups (e.g., u_lodIndexTex[originalIdx] is undefined)
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, -1);  // -1 = no LOD index texture, gl_VertexID is already original
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
      // Bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_useLodIndexTex !== null) gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }

    // Bind snapshot VAO and appropriate index buffer for indexed drawing
    gl.bindVertexArray(snapshot.vao);

    // Use pre-cached index buffer if available (eliminates upload on LOD change)
    // Otherwise fall back to per-view index buffer (for frustum-culled or custom-position snapshots)
    if (viewState.usePreCachedIndexBuffer && viewState.preCachedIndexBuffer) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.preCachedIndexBuffer);
    } else {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
    }

    gl.drawElements(gl.POINTS, viewState.cachedCulledCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    // Unbind textures if they were used
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Update both global and per-view stats
    this._updateStats(viewState, {
      visiblePoints: viewState.cachedCulledCount,
      lodLevel: lodLevel,
      drawCalls: 1,
      frustumCulled: false,
      cullPercent: 0
    });
  }

  /**
   * Render snapshot with combined LOD and frustum culling.
   * Uses indexed drawing into the snapshot buffer with filtered indices.
   * @param {boolean} [useAlphaTexture=false] - If true, use alpha texture for real-time filter updates
   * @param {SpatialIndex} [spatialIndex] - Spatial index to use (snapshot's own or main octree)
   * @param {Array} [lodBuffersForDim] - LOD buffers for the view's dimension level
   * @private
   */
  _renderSnapshotLODWithFrustumCulling(snapshot, lodLevel, params, frustumPlanes, viewState, useAlphaTexture = false, spatialIndex = null, lodBuffersForDim = null) {
    const gl = this.gl;
    const dimLevel = params.dimensionLevel || this.currentDimensionLevel;
    const lodBuffers = lodBuffersForDim || this.getLodBuffersForDimension(dimLevel);

    // Use provided spatial index or fall back to dimension-aware spatial index
    const tree = spatialIndex || this.spatialIndices.get(dimLevel);
    if (!tree) {
      this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, null, lodBuffers);
      return;
    }

    // Validate lodLevel bounds before accessing arrays
    if (lodLevel < 0 || lodLevel >= lodBuffers.length) {
      this._renderSnapshotWithFrustumCulling(snapshot, params, frustumPlanes, viewState, 1.0, useAlphaTexture, tree);
      return;
    }

    const lod = lodBuffers[lodLevel];

    if (!lod || lod.isFullDetail) {
      this._renderSnapshotWithFrustumCulling(snapshot, params, frustumPlanes, viewState, 1.0, useAlphaTexture, tree);
      return;
    }

    // Validate that tree has LOD levels for the requested level
    if (!tree.lodLevels || !tree.lodLevels[lodLevel] || !tree.lodLevels[lodLevel].indices) {
      // Fall back to frustum culling without LOD if tree doesn't have matching LOD levels
      this._renderSnapshotWithFrustumCulling(snapshot, params, frustumPlanes, viewState, 1.0, useAlphaTexture, tree);
      return;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir,
      viewId = snapshot.id,
      dimensionLevel = 3  // For cache invalidation on dimension change
    } = params;

    // Check if we need to recompute the frustum-culled LOD indices
    // Two-tier caching: visible nodes/Set cached separately from LOD indices
    // - frustumChanged: need to re-traverse octree to find visible nodes
    // - lodLevelChanged: can reuse cached visible Set, just rebuild LOD indices
    const frustumChanged = this._checkFrustumCacheValid(mvpMatrix, viewState, dimensionLevel);
    const lodLevelChanged = viewState.cachedLodLevel !== lodLevel;

    // Step 1: Only collect visible nodes and build Set when frustum changes (expensive)
    if (frustumChanged) {
      const visibleNodes = [];
      this._collectVisibleNodes(tree.root, frustumPlanes, visibleNodes);
      viewState.cachedVisibleNodes = visibleNodes;

      // Build Set of visible original point indices
      // Reuse existing Set if available to reduce GC pressure (clear instead of allocate)
      let visibleOriginalSet = viewState.cachedVisibleOriginalSet;
      if (visibleOriginalSet) {
        visibleOriginalSet.clear();
      } else {
        visibleOriginalSet = new Set();
      }
      for (let i = 0; i < visibleNodes.length; i++) {
        const nodeIndices = visibleNodes[i].indices;
        if (nodeIndices) {
          for (let j = 0; j < nodeIndices.length; j++) {
            visibleOriginalSet.add(nodeIndices[j]);
          }
        }
      }
      viewState.cachedVisibleOriginalSet = visibleOriginalSet;
    }

    // Step 2: Rebuild LOD indices when frustum OR LOD level changes
    if (frustumChanged || lodLevelChanged) {
      const visibleNodes = viewState.cachedVisibleNodes;

      if (!visibleNodes || visibleNodes.length === 0) {
        // Fallback to LOD without frustum culling when no visible nodes
        // Only log once per view (not every frame)
        if (!viewState._noVisibleNodesWarned) {
          console.warn(`[LOD+Frustum] Snapshot ${viewId}: No visible nodes - falling back to LOD without frustum`);
          viewState._noVisibleNodesWarned = true;
        }
        // Only force re-upload if LOD level changed OR we were in culled mode
        if (viewState.cachedLodLevel !== lodLevel || viewState.cachedLodIsCulled) {
          viewState.cachedLodLevel = LOD_PENDING_REUPLOAD;  // Force _renderSnapshotWithLOD to re-upload full LOD indices
          viewState.cachedLodIsCulled = false;  // Reset culled flag
        }
        // When NOT re-uploading, cachedCulledCount retains the correct full LOD count from previous upload
        this.stats.frustumCulled = false;
        this.stats.cullPercent = 0;
        this.stats.lodLevel = lodLevel;
        this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, tree, lodBuffers);
        return;
      }

      const visibleOriginalSet = viewState.cachedVisibleOriginalSet;

      // Get LOD level's indices and filter by visibility
      const lodOriginalIndices = tree.lodLevels[lodLevel].indices;
      const totalLodPoints = lodOriginalIndices.length;

      // STEP 1: Count visible indices FIRST (without copying) to check ratio early
      let visibleCount = 0;
      for (let i = 0; i < lodOriginalIndices.length; i++) {
        if (visibleOriginalSet.has(lodOriginalIndices[i])) {
          visibleCount++;
        }
      }

      const visibleRatio = visibleCount / totalLodPoints;
      const cullPercent = ((1 - visibleRatio) * 100);

      // EARLY EXIT OPTIMIZATION: If >98% visible, skip index copying entirely
      // _renderSnapshotWithLOD will use pre-cached index buffers (no upload needed)
      if (visibleRatio > 0.98) {
        // Only force re-upload if LOD level changed OR we were in culled mode
        // This prevents repeated uploads/logs when staying in >98% visible state
        if (viewState.cachedLodLevel !== lodLevel || viewState.cachedLodIsCulled) {
          viewState.cachedLodLevel = LOD_PENDING_REUPLOAD;  // Force _renderSnapshotWithLOD to handle LOD change
          viewState.cachedLodIsCulled = false;  // Reset culled flag since we're using full LOD
        }
        // When NOT re-uploading, cachedCulledCount retains the correct full LOD count from previous upload
        this.stats.frustumCulled = false;
        this.stats.cullPercent = cullPercent;
        this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, tree, lodBuffers);
        return;
      }

      // STEP 2: Only allocate and copy indices when actually needed (<98% visible)
      // Reuse pooled buffer in viewState to avoid GC pressure from repeated allocations
      const requiredCapacity = lodOriginalIndices.length;
      if (!viewState.visibleLodIndicesBuffer || viewState.visibleLodIndicesCapacity < requiredCapacity) {
        viewState.visibleLodIndicesCapacity = Math.ceil(requiredCapacity * 1.5);
        viewState.visibleLodIndicesBuffer = new Uint32Array(viewState.visibleLodIndicesCapacity);
      }

      const visibleLodIndices = viewState.visibleLodIndicesBuffer;
      let copyIndex = 0;
      for (let i = 0; i < lodOriginalIndices.length; i++) {
        if (visibleOriginalSet.has(lodOriginalIndices[i])) {
          visibleLodIndices[copyIndex++] = lodOriginalIndices[i];
        }
      }
      // Create a view of just the filled portion
      const visibleLodIndicesView = visibleLodIndices.subarray(0, visibleCount);

      // Log only on significant change (>10% of total points)
      if (DEBUG_LOD_FRUSTUM && this._isSignificantChange(viewState.lastVisibleCount, visibleCount, totalLodPoints)) {
        console.log(`[LOD+Frustum] Snapshot ${viewId}: LOD ${lodLevel} - ${visibleCount.toLocaleString()}/${totalLodPoints.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleCount;
      }

      // Upload filtered indices to per-view buffer (use subarray view, no copy needed)
      this._uploadToViewIndexBuffer(viewState, visibleLodIndicesView);
      viewState.cachedCulledCount = visibleCount;
      viewState.cachedLodLevel = lodLevel;
      viewState.cachedLodDimension = dimLevel;
      viewState.cachedLodIsCulled = true;  // Mark as culled indices (not full LOD)
      viewState._noVisibleNodesWarned = false;  // Reset warning flag since we have visible nodes
      this.stats.frustumCulled = true;
      this.stats.cullPercent = cullPercent;
    }

    if (!viewState.cachedCulledCount || viewState.cachedCulledCount === 0) {
      this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, tree, lodBuffers);
      return;
    }

    const adjustedPointSize = pointSize * (lod.sizeMultiplier || 1.0);

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) return;

    gl.useProgram(program);

    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_projectionMatrix !== null && projectionMatrix) gl.uniformMatrix4fv(uniforms.u_projectionMatrix, false, projectionMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, adjustedPointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Alpha texture handling: if useAlphaTexture is true, use real-time alpha from texture
    // IMPORTANT: For snapshot LOD+frustum with indexed drawing, the index buffer contains ORIGINAL indices
    // (filtered subset of lodOriginalIndices), so gl_VertexID is already the original index.
    // We must NOT use the LOD index texture (pass -1) - same reasoning as _renderSnapshotWithLOD.
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, -1);  // -1 = no LOD index texture, gl_VertexID is already original
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
      // Bind dummy R32UI texture to satisfy usampler2D uniform
      if (this._dummyLodIndexTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._dummyLodIndexTexture);
        if (uniforms.u_lodIndexTex !== null) gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_useLodIndexTex !== null) gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }

    // Defensive check: ensure index buffer is valid before drawing
    if (viewState.indexBufferSize !== viewState.cachedCulledCount) {
      console.warn(`[LOD+Frustum] Snapshot ${viewId}: Index buffer size mismatch - falling back to LOD without frustum`);
      this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, tree, lodBuffers);
      return;
    }

    // Bind snapshot VAO and per-view index buffer
    gl.bindVertexArray(snapshot.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
    gl.drawElements(gl.POINTS, viewState.cachedCulledCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    // Unbind textures if they were used
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Update both global and per-view stats
    this._updateStats(viewState, {
      visiblePoints: viewState.cachedCulledCount,
      lodLevel: lodLevel,
      drawCalls: 1
    });
  }

  dispose() {
    const gl = this.gl;

    // Clean up per-view index buffers first
    this.clearAllViewState();

    // Clean up main buffers (interleaved VBO, etc.)
    for (const buffer of Object.values(this.buffers)) {
      if (buffer) gl.deleteBuffer(buffer);
    }

    // Clean up all per-dimension LOD buffers and VAOs
    // CRITICAL: Skip full-detail entries - they reference main buffer/VAO which we already deleted above.
    // Deleting them again would cause WebGL errors (double-delete).
    for (const lodBuffers of this.lodBuffersByDimension.values()) {
      for (const lod of lodBuffers) {
        // Only delete buffers/VAOs for reduced LOD levels, not full-detail
        if (!lod.isFullDetail) {
          if (lod.buffer) gl.deleteBuffer(lod.buffer);
          if (lod.vao) gl.deleteVertexArray(lod.vao);
        }
        // Index buffers are always LOD-specific (even full-detail has its own), safe to delete
        if (lod.originalIndexBuffer) gl.deleteBuffer(lod.originalIndexBuffer);
      }
    }

    // Clean up main VAO and index buffer
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);

    // Clean up snapshot buffers
    this.deleteAllSnapshotBuffers();

    for (const program of Object.values(this.programs)) {
      if (program) gl.deleteProgram(program);
    }

    this.buffers = {};
    this.lodBuffersByDimension.clear();
    this._clearLodIndexTextures();  // Clear dimension-aware LOD index textures
    // Clean up dummy LOD index texture
    if (this._dummyLodIndexTexture) {
      gl.deleteTexture(this._dummyLodIndexTexture);
      this._dummyLodIndexTexture = null;
    }
    this.programs = {};
    this.spatialIndices.clear();

    // Clear cached ArrayBuffers
    this._interleavedArrayBuffer = null;
    this._interleavedPositionView = null;
    this._interleavedColorView = null;
    this._lodArrayBuffers = null;

    // Clean up alpha texture
    if (this._alphaTexture) {
      gl.deleteTexture(this._alphaTexture);
      this._alphaTexture = null;
    }
    this._alphaTexData = null;
    this._useAlphaTexture = false;
    // LOD index textures already cleared by _clearLodIndexTextures() above
  }
}

export default HighPerfRenderer;
