/**
 * HIGH-PERFORMANCE SCATTERPLOT RENDERER (WebGL2 Only)
 * ====================================================
 * Optimized for 5-10+ million points using:
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
  HP_VS_LIGHT, HP_FS_LIGHT, HP_FS_ULTRALIGHT,
  HP_VS_LOD,
  getShaders
} from './high-perf-shaders.js';

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
   */
  constructor(positions, colors, dimensionLevel = 3, maxPointsPerNode = 1000, maxDepth = 8) {
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

    // Generate LOD levels
    console.time('LOD generation');
    this.lodLevels = this._generateLODLevels();
    console.timeEnd('LOD generation');

    // Pre-compute LOD indices per node for fast frustum culling
    this._buildLODNodeMappings();
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
      node.centroid = this._computeCentroid(indices);
      node.avgColor = this._computeAvgColor(indices);
      node.avgAlpha = this._computeAvgAlpha(indices);
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

      childBounds.push({
        minX: xSplit ? midX : bounds.minX,
        maxX: xSplit ? bounds.maxX : midX,
        minY: ySplit ? midY : bounds.minY,
        maxY: ySplit ? bounds.maxY : midY,
        // For dimensions not being split, children inherit full parent range
        // This is critical for 2D/1D data where Z (and Y for 1D) should not subdivide
        minZ: zSplit ? midZ : bounds.minZ,
        maxZ: zSplit ? bounds.maxZ : bounds.maxZ  // Keep full Z range when not splitting Z
      });
    }

    const childCounts = new Uint32Array(numChildren);
    const positions = this.positions;

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const x = positions[idx * 3];
      const y = positions[idx * 3 + 1];
      const z = positions[idx * 3 + 2];

      // Compute child index based on dimension level
      let childIdx = (x >= midX ? 1 : 0);
      if (dimLevel >= 2) childIdx += (y >= midY ? 2 : 0);
      if (dimLevel >= 3) childIdx += (z >= midZ ? 4 : 0);

      childCounts[childIdx]++;
    }

    const childIndices = childBounds.map((_, i) =>
      childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
    );
    const childOffsets = new Uint32Array(numChildren);

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const x = positions[idx * 3];
      const y = positions[idx * 3 + 1];
      const z = positions[idx * 3 + 2];

      let childIdx = (x >= midX ? 1 : 0);
      if (dimLevel >= 2) childIdx += (y >= midY ? 2 : 0);
      if (dimLevel >= 3) childIdx += (z >= midZ ? 4 : 0);

      childIndices[childIdx][childOffsets[childIdx]++] = idx;
    }

    node.children = childBounds.map((cb, i) =>
      childIndices[i] !== null
        ? this._buildNode(childIndices[i], cb, depth + 1)
        : null
    );

    node.centroid = this._computeCentroidFromChildren(node);
    node.avgColor = this._computeAvgColorFromChildren(node);
    node.avgAlpha = this._computeAvgAlphaFromChildren(node);

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
        sizeMultiplier: Math.sqrt(factor) * 0.5 + 0.5
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
    const sampledIndices = new Array(count);
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

/**
 * Backward compatibility alias - Octree is now SpatialIndex with dimensionLevel=3
 */
export class Octree extends SpatialIndex {
  constructor(positions, colors, maxPointsPerNode = 1000, maxDepth = 8) {
    super(positions, colors, 3, maxPointsPerNode, maxDepth);
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
      ultralight: null,
      lod: null
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
    this._lodIndexTextures = [];

    // LOD system - dimension-aware spatial indexing
    this.spatialIndices = new Map();  // Per-dimension spatial indices: Map<dimensionLevel, SpatialIndex>
    this.lodBuffersByDimension = new Map();  // Per-dimension LOD buffers: Map<dimensionLevel, lodBuffers[]>
    this.currentDimensionLevel = 3;  // Current active dimension level for live view

    // State
    this.pointCount = 0;
    this.currentLOD = -1;
    this.forceLODLevel = -1; // -1 = auto, 0+ = forced level
    this.useAdaptiveLOD = this.options.USE_LOD;
    this.useFrustumCulling = this.options.USE_FRUSTUM_CULLING;
    this.useInterleavedBuffers = this.options.USE_INTERLEAVED_BUFFERS;

    // VAO for WebGL2
    this.vao = null;
    this.lodVaos = [];

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
        cachedLodIsCulled: false,        // Whether cached indices are frustum-culled (vs full LOD)
        cachedVisibleNodes: null,        // Cached octree nodes from frustum culling (reused across LOD level changes)
        prevLodLevel: undefined,         // For logging LOD changes
        lastLodLevel: -1,                // For per-view LOD hysteresis
        lastVisibleCount: undefined,     // For logging visible count changes
        lastDimensionLevel: undefined,   // For cache invalidation on dimension change
        indexBuffer: indexBuffer,        // Per-view index buffer (avoids shared buffer conflicts)
        indexBufferSize: 0,              // Current size of uploaded index buffer
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

  _createPrograms() {
    const gl = this.gl;

    console.log('[HighPerfRenderer] Creating WebGL2 shader programs');

    this.programs.full = this._createProgram(HP_VS_FULL, HP_FS_FULL, 'full');
    this.programs.light = this._createProgram(HP_VS_LIGHT, HP_FS_LIGHT, 'light');
    this.programs.ultralight = this._createProgram(HP_VS_LIGHT, HP_FS_ULTRALIGHT, 'ultralight');
    this.programs.lod = this._createProgram(HP_VS_LOD, HP_FS_FULL, 'lod');

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
    // Support both buildSpatialIndex and deprecated buildOctree option
    const buildSpatialIndex = options.buildSpatialIndex ?? options.buildOctree ?? defaultBuildSpatialIndex;
    const { dimensionLevel } = options;  // Caller should specify dimension level

    // Clear per-dimension spatial indices cache when loading new data
    this.spatialIndices.clear();
    this.lodBuffersByDimension.clear();
    // Use provided dimensionLevel, or keep current if not specified
    if (dimensionLevel !== undefined) {
      this.currentDimensionLevel = Math.max(1, Math.min(3, dimensionLevel));
    }

    this.pointCount = positions.length / 3;
    console.log(`[HighPerfRenderer] Loading ${this.pointCount.toLocaleString()} points...`);

    // Normalize colors to RGBA Uint8Array format
    // This ensures all downstream code can safely assume 4-component colors
    const expectedRGBA = this.pointCount * 4;
    const expectedRGB = this.pointCount * 3;
    let normalizedColors = colors;

    if (colors.length === expectedRGB) {
      // Convert RGB to RGBA (add alpha = 255)
      console.log('[HighPerfRenderer] Converting RGB colors to RGBA');
      normalizedColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < this.pointCount; i++) {
        normalizedColors[i * 4]     = colors[i * 3];
        normalizedColors[i * 4 + 1] = colors[i * 3 + 1];
        normalizedColors[i * 4 + 2] = colors[i * 3 + 2];
        normalizedColors[i * 4 + 3] = 255; // Fully opaque
      }
    } else if (colors.length !== expectedRGBA) {
      console.error(`[HighPerfRenderer] Invalid colors array length: ${colors.length}, expected ${expectedRGBA} (RGBA) or ${expectedRGB} (RGB)`);
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
      this._createLODIndexTextures();
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

    if (!pos || !col) {
      return null;
    }

    // Check if we have a cached spatial index for this dimension
    if (this.spatialIndices.has(dim)) {
      const cached = this.spatialIndices.get(dim);
      // Validate cache - check if point count matches
      if (cached.pointCount === pos.length / 3) {
        return cached;
      }
      // Stale cache - remove it
      console.log(`[HighPerfRenderer] Spatial index for ${dim}D is stale, rebuilding...`);
      this.spatialIndices.delete(dim);
    }

    // Build new spatial index for this dimension
    console.log(`[HighPerfRenderer] Building ${dim}D spatial index...`);
    const startTime = performance.now();
    const spatialIndex = new SpatialIndex(pos, col, dim, this.options.LOD_MAX_POINTS_PER_NODE);
    const elapsed = performance.now() - startTime;
    console.log(`[HighPerfRenderer] ${dim}D spatial index built in ${elapsed.toFixed(1)}ms`);

    // Cache it
    this.spatialIndices.set(dim, spatialIndex);

    // Also create LOD buffers for this dimension if LOD is enabled
    if (this.useAdaptiveLOD || this.options.USE_LOD) {
      this._createLODBuffersForDimension(dim, spatialIndex);
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
        lodBuffers.push({
          vao: this.vao,
          buffer: this.buffers.interleaved,
          pointCount: level.pointCount,
          depth: level.depth,
          isFullDetail: true,
          sizeMultiplier: 1.0
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

      lodBuffers.push({
        vao,
        buffer: glBuffer,
        pointCount,
        depth: level.depth,
        isFullDetail: false,
        sizeMultiplier: level.sizeMultiplier || 1.0
      });
    }

    this.lodBuffersByDimension.set(dimensionLevel, lodBuffers);
    console.log(`[HighPerfRenderer] Created ${lodBuffers.length} LOD buffers for ${dimensionLevel}D`);
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
    this.lodBuffersByDimension.clear();

    // Update bounding sphere
    this._boundingSphere = this._computeBoundingSphere(positions);

    // Rebuild interleaved buffer with new positions (keeps existing colors)
    if (this._colors) {
      this._createInterleavedBuffer(positions, this._colors);
    }

    // Rebuild spatial index only if LOD/frustum culling is currently enabled at runtime
    // Don't check initial options - only rebuild if feature is actually active
    const needsSpatialIndex = this.useAdaptiveLOD || this.useFrustumCulling;
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
            this._createLODIndexTextures();
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
    const needsSpatialIndex = this.useAdaptiveLOD || this.useFrustumCulling;
    if (needsSpatialIndex && this.pointCount > 10000) {
      console.log(`[HighPerfRenderer] Rebuilding ${this.currentDimensionLevel}D spatial index...`);

      // Clear spatial indices cache - will rebuild for current dimension
      this.spatialIndices.clear();
      this.lodBuffersByDimension.clear();

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
          this._createLODIndexTextures();
        }
      }
    }
  }

  _createInterleavedBuffer(positions, colors) {
    const gl = this.gl;
    const pointCount = positions.length / 3;

    // Create interleaved buffer: [x,y,z (float32), r,g,b,a (uint8)] per point (16 bytes)
    // colors is Uint8Array with RGBA packed (4 bytes per point) - alpha is in 4th byte
    const buffer = new ArrayBuffer(pointCount * 16);
    const positionView = new Float32Array(buffer);
    const colorView = new Uint8Array(buffer);

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
    const maxWidth = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this._alphaTexWidth = Math.min(pointCount, maxWidth);
    this._alphaTexHeight = Math.ceil(pointCount / this._alphaTexWidth);

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
    for (let i = 0; i < n; i++) {
      this._alphaTexData[i] = (alphas[i] * 255 + 0.5) | 0;
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
   * Create LOD index textures for alpha lookup.
   * Each LOD level needs a texture mapping its vertex indices to original point indices.
   */
  _createLODIndexTextures() {
    const gl = this.gl;

    // Clean up existing textures
    for (const tex of this._lodIndexTextures) {
      if (tex.texture) gl.deleteTexture(tex.texture);
    }
    this._lodIndexTextures = [];

    // Get spatial index for current dimension
    const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
    if (!spatialIndex || !spatialIndex.lodLevels) return;

    const maxWidth = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));

    for (let lvlIdx = 0; lvlIdx < spatialIndex.lodLevels.length; lvlIdx++) {
      const level = spatialIndex.lodLevels[lvlIdx];

      if (level.isFullDetail || !level.indices) {
        // Full detail uses gl_VertexID directly, no index texture needed
        this._lodIndexTextures.push({ texture: null, width: 0, height: 0 });
        continue;
      }

      const pointCount = level.indices.length;
      const texWidth = Math.min(pointCount, maxWidth);
      const texHeight = Math.ceil(pointCount / texWidth);
      const texSize = texWidth * texHeight;

      // Create Float32 texture to store indices (R32F format)
      // Using float because indices can be large (> 65535)
      const indexData = new Float32Array(texSize);
      for (let i = 0; i < pointCount; i++) {
        indexData[i] = level.indices[i];
      }

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R32F,
        texWidth, texHeight, 0,
        gl.RED, gl.FLOAT, indexData
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      this._lodIndexTextures.push({ texture, width: texWidth, height: texHeight });
    }

    console.log(`[HighPerfRenderer] Created ${this._lodIndexTextures.filter(t => t.texture).length} LOD index textures`);
  }

  /**
   * @deprecated Use _createLODBuffersForDimension() instead.
   * This method now delegates to the dimension-aware version.
   */
  _createLODBuffers() {
    const spatialIndex = this.spatialIndices.get(this.currentDimensionLevel);
    if (spatialIndex) {
      this._createLODBuffersForDimension(this.currentDimensionLevel, spatialIndex);
    }
  }

  updateColors(colors) {
    // Note: Reference check removed - callers often modify arrays in-place,
    // so same reference doesn't mean same content.
    if (!colors) return;

    // Normalize colors to RGBA if needed (same logic as loadData)
    const expectedRGBA = this.pointCount * 4;
    const expectedRGB = this.pointCount * 3;
    let normalizedColors = colors;

    if (colors.length === expectedRGB) {
      // Convert RGB to RGBA (add alpha = 255)
      normalizedColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < this.pointCount; i++) {
        normalizedColors[i * 4]     = colors[i * 3];
        normalizedColors[i * 4 + 1] = colors[i * 3 + 1];
        normalizedColors[i * 4 + 2] = colors[i * 3 + 2];
        normalizedColors[i * 4 + 3] = 255;
      }
    }

    this._colors = normalizedColors; // Uint8Array with RGBA packed
    this._currentAlphas = null; // Reset alpha tracking since colors changed

    // Invalidate LOD visibility cache since colors (including alpha) changed
    // This is critical for correct filtering/transparency handling in LOD mode
    this.invalidateLodVisibilityCache();

    // Mark buffers as dirty - actual rebuild deferred to render() to avoid double rebuilds
    this._bufferDirty = true;
    if (this._hasLodBuffers()) {
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

  updateAlphas(alphas) {
    // Note: Reference check removed - callers often modify arrays in-place,
    // so same reference doesn't mean same content.
    if (!alphas) return;

    this._currentAlphas = alphas; // Track current alphas reference

    // Invalidate LOD visibility cache since filter/transparency changed
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
      this._colors[i * 4 + 3] = Math.round(alphas[i] * 255);
    }

    // Use alpha-only fast path if buffer already exists (skip position repacking)
    if (this._interleavedArrayBuffer) {
      this._alphaOnlyDirty = true;
      if (this._hasLodBuffers()) {
        this._lodAlphaOnlyDirty = true;
      }
    } else {
      this._bufferDirty = true;
      if (this._hasLodBuffers()) {
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
    const needsSpatialIndex = this.useAdaptiveLOD || this.useFrustumCulling;
    const spatialIndex = needsSpatialIndex ? this.getSpatialIndexForDimension(dimensionLevel) : null;
    const lodBuffersForDim = this.getLodBuffersForDimension(dimensionLevel);

    // Select LOD level first (determines whether to use frustum culling)
    // Priority: this.forceLODLevel > params.forceLOD > adaptive
    let lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
    if (lodLevel < 0 && this.useAdaptiveLOD && spatialIndex) {
      // Pass per-view lastLodLevel for hysteresis (prevents oscillation per-view)
      // Also pass dimensionLevel and overrideBounds for correct 2D/3D diagonal calculation
      lodLevel = spatialIndex.getLODLevel(cameraDistance, viewportHeight, viewState.lastLodLevel, dimensionLevel, overrideBounds);
    }

    // Safeguard: if LOD is disabled, ensure lodLevel stays -1
    if (!this.useAdaptiveLOD && this.forceLODLevel < 0 && forceLOD < 0) {
      lodLevel = -1;
    }

    // Always update per-view LOD level for highlight rendering and other consumers
    // This must happen after all LOD selection logic (forced, adaptive, or disabled)
    viewState.lastLodLevel = lodLevel;

    const useFullDetail = lodLevel < 0 || !lodBuffersForDim.length ||
      lodLevel >= lodBuffersForDim.length ||
      (lodBuffersForDim[lodLevel] && lodBuffersForDim[lodLevel].isFullDetail);

    // Debug LOD selection - only log when level changes (per-view tracking)
    if (viewState.prevLodLevel !== lodLevel && spatialIndex && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const lodBuf = lodBuffersForDim[lodLevel];
      const pointCount = lodBuf ? lodBuf.pointCount : this.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      console.log(`[LOD] View ${viewId}: level ${viewState.prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode})`);
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
        console.log(`[Render] View ${viewId}: ${renderPath} (lodLevel=${lodLevel}, useAdaptiveLOD=${this.useAdaptiveLOD}, lodBuffers=${lodBuffersForDim.length}, dim=${dimensionLevel})`);
        viewState._lastRenderPath = renderPath;
      }

      // For 2D data (dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD), disable depth testing
      // entirely to prevent draw-order artifacts. When all points have the same Z, depth testing
      // causes visual differences at quadtree boundaries because frustum culling changes the
      // draw order (spatially grouped vs original). Disabling depth writes alone is insufficient.
      const disableDepth = dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
      if (disableDepth) {
        gl.disable(gl.DEPTH_TEST);
      }

      if (useFullDetail) {
        // Full detail: standard frustum culling
        this._renderWithFrustumCulling(params, frustumPlanes, viewState, spatialIndex);
      } else {
        // LOD active: combined LOD + frustum culling for maximum performance
        this._renderLODWithFrustumCulling(lodLevel, params, frustumPlanes, viewState, spatialIndex, lodBuffersForDim);
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
    const disableDepth = dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD;
    if (disableDepth) {
      gl.disable(gl.DEPTH_TEST);
    }

    if (useFullDetail) {
      this._renderFullDetail(params);
    } else {
      this._renderLOD(lodLevel, params);
    }

    // Restore depth testing
    if (disableDepth) {
      gl.enable(gl.DEPTH_TEST);
    }

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
      dimensionLevel = 3  // For cache invalidation on dimension change
    } = params;

    // One-time validation: ensure spatial index contains all points
    if (!this._octreeValidated && spatialIndex) {
      const validation = spatialIndex.validatePointCount();
      if (!validation.valid) {
        console.error(`[FrustumCulling] Spatial index validation failed - some points may be missing`);
      }
      this._octreeValidated = true;
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
      if (this._isSignificantChange(viewState.lastVisibleCount, visibleCount, this.pointCount)) {
        console.log(`[FrustumCulling] View ${viewId}: ${visibleCount.toLocaleString()}/${this.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleCount;
      }

      // Store visible indices in per-view state (for cache validation)
      viewState.cachedVisibleIndices = new Uint32Array(visibleIndices);
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

    // Very low threshold to catch even small camera movements
    // In multi-view mode, each view has different frustum, so we need to be sensitive
    // 0.0001 means even tiny changes (0.001 per element average) trigger update
    const threshold = 0.0001;

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

  // Legacy method for backward compatibility
  _updateCulledIndexBuffer(visibleIndices) {
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, visibleIndices, gl.DYNAMIC_DRAW);
    this._culledPointCount = visibleIndices.length;
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
   */
  _bindAlphaTexture(gl, uniforms, lodLevel = -1) {
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
      if (lodLevel >= 0 && this._lodIndexTextures[lodLevel]?.texture) {
        const lodIdxTex = this._lodIndexTextures[lodLevel];
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
        // No LOD index texture needed
        if (uniforms.u_useLodIndexTex !== null) {
          gl.uniform1i(uniforms.u_useLodIndexTex, 0); // false
        }
      }
    } else {
      // Alpha texture not active - use vertex attribute alpha
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 0); // false
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
    this._bindAlphaTexture(gl, uniforms, lodLevel);

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
      // Pre-calculate total count to avoid array resizing (significant perf improvement)
      let visibleCount = 0;
      for (let i = 0; i < visibleNodes.length; i++) {
        const nodeLodIndices = visibleNodes[i].lodIndices?.[lodLevel];
        if (nodeLodIndices) visibleCount += nodeLodIndices.length;
      }

      // Pre-allocate typed array and bulk copy (avoids O(n) array.push resizes)
      const visibleLodIndices = new Uint32Array(visibleCount);
      let offset = 0;
      for (let i = 0; i < visibleNodes.length; i++) {
        const nodeLodIndices = visibleNodes[i].lodIndices?.[lodLevel];
        if (nodeLodIndices) {
          visibleLodIndices.set(nodeLodIndices, offset);
          offset += nodeLodIndices.length;
        }
      }
      const totalLodPoints = lod.pointCount;
      const visibleRatio = visibleCount / totalLodPoints;
      const cullPercent = ((1 - visibleRatio) * 100);

      // If >98% visible, render full LOD without culling
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

      // Log only on significant change (>10% of total points)
      if (this._isSignificantChange(viewState.lastVisibleCount, visibleCount, totalLodPoints)) {
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
    this._bindAlphaTexture(gl, uniforms, lodLevel);

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
          this.lodBuffersByDimension.clear();
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index for LOD...`);
        }
        // Use dimension-aware spatial index (will also create LOD buffers)
        const spatialIndex = this.getSpatialIndexForDimension(dimLevel);
        if (spatialIndex) {
          // Clear per-view caches since spatial index changed
          this.clearAllViewState();
          // Invalidate all snapshot spatial indices (they reference stale positions)
          for (const [id, snapshot] of this.snapshotBuffers) {
            if (snapshot.spatialIndex) {
              snapshot.spatialIndex = null;
              console.log(`[HighPerfRenderer] Invalidated spatial index for snapshot "${id}"`);
            }
          }
        }
      } else {
        // Spatial index exists and is not stale, but LOD buffers may not exist
        // (e.g., frustum culling was enabled first without LOD)
        const existingLodBuffers = this.lodBuffersByDimension.get(dimLevel);
        if (!existingLodBuffers || existingLodBuffers.length === 0) {
          console.log(`[HighPerfRenderer] Creating LOD buffers for existing ${dimLevel}D spatial index...`);
          this._createLODBuffersForDimension(dimLevel, existingIndex);
        }
      }

      // Create LOD index textures if needed
      const lodBuffers = this.getLodBuffersForDimension(dimLevel);
      const spatialIndex = this.spatialIndices.get(dimLevel);
      if (spatialIndex && lodBuffers.length > 0) {
        if (!this._lodIndexTextures || this._lodIndexTextures.length === 0) {
          console.log('[HighPerfRenderer] Creating LOD index textures...');
          this._createLODIndexTextures();
          console.log(`[HighPerfRenderer] Created ${lodBuffers.length} LOD buffer levels`);
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
          this.lodBuffersByDimension.clear();
        } else {
          console.log(`[HighPerfRenderer] Building ${dimLevel}D spatial index for frustum culling...`);
        }
        this.getSpatialIndexForDimension(dimLevel);
      }
    }
  }

  /**
   * @deprecated Use getSpatialIndex(dimensionLevel) instead.
   * Backward compatibility getter - returns the 3D spatial index (octree).
   * @returns {SpatialIndex|null} The 3D spatial index, or null if not built
   */
  get octree() {
    return this.spatialIndices.get(3) || null;
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
          this.lodBuffersByDimension.clear();
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

    // Use override if provided, otherwise fall back to global stats
    const lodLevel = overrideLodLevel !== undefined ? overrideLodLevel : this.stats.lodLevel;

    // Get spatial index for the dimension
    const spatialIndex = this.spatialIndices.get(dimensionLevel);

    // If no spatial index or LOD disabled, all points visible - return null to signal "all visible"
    if (!spatialIndex || !this.useAdaptiveLOD || lodLevel < 0) {
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
      if (!viewState.cachedLodVisibility || viewState.cachedLodVisibility.length !== n) {
        viewState.cachedLodVisibility = new Float32Array(n);
      }

      // Clear and mark only the points in this LOD level as visible
      viewState.cachedLodVisibility.fill(0);
      const indices = level.indices;
      for (let i = 0, len = indices.length; i < len; i++) {
        viewState.cachedLodVisibility[indices[i]] = 1.0;
      }

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
    if (!this._cachedLodVisibility || this._cachedLodVisibility.length !== n) {
      this._cachedLodVisibility = new Float32Array(n);
    }

    // Clear and mark only the points in this LOD level as visible
    this._cachedLodVisibility.fill(0);
    const indices = level.indices;
    for (let i = 0, len = indices.length; i < len; i++) {
      this._cachedLodVisibility[indices[i]] = 1.0;
    }

    this._cachedLodVisibilityLevel = lodLevel;
    this._cachedLodVisibilityFilterGen = currentFilterGen;
    return this._cachedLodVisibility;
  }

  /**
   * Get visibility mask for a specific view based on LOD level.
   * This is used for highlight rendering to ensure highlights match what's rendered.
   *
   * NOTE: We intentionally use LOD-only visibility (not frustum) because:
   * 1. GPU automatically clips cells outside the frustum (no need to exclude from buffer)
   * 2. Using frustum visibility would require rebuilding on every camera move (expensive)
   * 3. With LOD-only visibility, cells entering the frustum are immediately highlighted
   *
   * @param {string|number} viewId - View ID for per-view LOD level lookup
   * @returns {Float32Array|null} Visibility mask (1.0 = visible, 0.0 = hidden), or null if all visible
   */
  getCombinedVisibilityForView(viewId) {
    const vid = String(viewId);
    const viewState = this._perViewState.get(vid);

    // Get LOD level for this view
    const lodLevel = viewState?.lastLodLevel ?? this.stats.lodLevel ?? -1;

    // Delegate to LOD visibility (GPU handles frustum clipping automatically)
    return this.getLodVisibilityArray(lodLevel, viewId);
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

    // Normalize colors to RGBA if needed
    const expectedRGBA = n * 4;
    const expectedRGB = n * 3;
    let snapshotColors;

    if (colors.length === expectedRGB) {
      // Convert RGB to RGBA
      snapshotColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < n; i++) {
        snapshotColors[i * 4]     = colors[i * 3];
        snapshotColors[i * 4 + 1] = colors[i * 3 + 1];
        snapshotColors[i * 4 + 2] = colors[i * 3 + 2];
        snapshotColors[i * 4 + 3] = 255;
      }
    } else {
      // Create a copy of colors to avoid modifying the original
      snapshotColors = new Uint8Array(colors);
    }

    // Merge alphas into the color array if provided
    if (alphas) {
      const alphaCount = Math.min(n, alphas.length);
      for (let i = 0; i < alphaCount; i++) {
        snapshotColors[i * 4 + 3] = Math.round(alphas[i] * 255);
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

    // Build spatial index for custom positions (enables fast frustum culling for 2D/1D views)
    // This replaces brute-force O(n) culling with O(log n) hierarchical culling
    let spatialIndex = null;
    if (hasCustomPositions && n > 10000) {
      const dimensionLevel = HighPerfRenderer.detectDimensionLevel(customBounds);
      console.log(`[HighPerfRenderer] Building ${dimensionLevel}D spatial index for snapshot "${id}"...`);
      spatialIndex = new SpatialIndex(viewPositions, snapshotColors, dimensionLevel, this.options.LOD_MAX_POINTS_PER_NODE);
      console.log(`[HighPerfRenderer] Built ${dimensionLevel}D spatial index with ${spatialIndex.lodLevels.length} LOD levels`);
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
      spatialIndex: spatialIndex
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

    // Normalize colors to RGBA if needed
    const expectedRGBA = n * 4;
    const expectedRGB = n * 3;
    let snapshotColors;

    if (colors.length === expectedRGB) {
      // Convert RGB to RGBA
      snapshotColors = new Uint8Array(expectedRGBA);
      for (let i = 0; i < n; i++) {
        snapshotColors[i * 4]     = colors[i * 3];
        snapshotColors[i * 4 + 1] = colors[i * 3 + 1];
        snapshotColors[i * 4 + 2] = colors[i * 3 + 2];
        snapshotColors[i * 4 + 3] = 255;
      }
    } else {
      snapshotColors = new Uint8Array(colors);
    }

    if (alphas) {
      const alphaCount = Math.min(n, alphas.length);
      for (let i = 0; i < alphaCount; i++) {
        snapshotColors[i * 4 + 3] = Math.round(alphas[i] * 255);
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
      const hasCustomPositions = positions !== this._positions;
      if (hasCustomPositions && n > 10000) {
        const customBounds = HighPerfRenderer.computeBoundsFromPositions(positions);
        const dimensionLevel = HighPerfRenderer.detectDimensionLevel(customBounds);
        snapshot.bounds = customBounds;
        snapshot.spatialIndex = new SpatialIndex(positions, snapshotColors, dimensionLevel, this.options.LOD_MAX_POINTS_PER_NODE);
        console.log(`[HighPerfRenderer] Rebuilt ${dimensionLevel}D spatial index for snapshot "${id}"`);
      } else {
        snapshot.bounds = null;
        snapshot.spatialIndex = null;
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

    // Rebuild spatial index for the new positions (enables fast frustum culling)
    const hasCustomPositions = viewPositions !== this._positions;
    if (hasCustomPositions && n > 10000 && snapshot.colors) {
      const dimensionLevel = HighPerfRenderer.detectDimensionLevel(snapshot.bounds);
      snapshot.spatialIndex = new SpatialIndex(viewPositions, snapshot.colors, dimensionLevel, this.options.LOD_MAX_POINTS_PER_NODE);
      console.log(`[HighPerfRenderer] Rebuilt ${dimensionLevel}D spatial index for snapshot "${id}"`);
    } else {
      snapshot.spatialIndex = null;
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
      quality = this.activeQuality,
      viewId,  // Per-view state identifier (required for multi-view rendering!)
      dimensionLevel = 3,  // Current dimension level (1, 2, 3, or 4) for LOD/frustum calculations
      useAlphaTexture = false  // If true, use alpha texture for real-time filter updates
    } = params;

    const frameStart = performance.now();

    // Get per-view state for frustum culling and LOD caching
    const viewState = this._getViewState(viewId);

    // Check if snapshot has custom positions (different dimension)
    // The octree is built from main positions, so its bounds don't match custom positions
    const hasCustomPositions = snapshot.positions && snapshot.positions !== this._positions;

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
    const needsSpatialIndex = this.useAdaptiveLOD || this.useFrustumCulling;
    const mainSpatialIndex = (!hasCustomPositions && needsSpatialIndex) ? this.getSpatialIndexForDimension(dimensionLevel) : null;
    const lodBuffersForDim = this.getLodBuffersForDimension(dimensionLevel);

    // Select LOD level - priority: forceLODLevel > params.forceLOD > adaptive
    // Same logic as render() to ensure slider affects all views
    let lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : (params.forceLOD ?? -1);
    if (lodLevel < 0 && this.useAdaptiveLOD && mainSpatialIndex) {
      // Pass dimensionLevel for correct 2D/3D diagonal calculation
      // Pass snapshot bounds when available (for custom positions that differ from octree)
      lodLevel = mainSpatialIndex.getLODLevel(cameraDistance, viewportHeight, viewState.lastLodLevel, dimensionLevel, snapshot.bounds);
    }

    // Always update per-view LOD level for highlight rendering and other consumers
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
    if (viewState.prevLodLevel !== lodLevel && mainSpatialIndex && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const pointCount = mainSpatialIndex.lodLevels[lodLevel]?.pointCount || this.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      console.log(`[LOD] Snapshot ${viewId}: level ${viewState.prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode}, dim=${dimensionLevel})`);
      viewState.prevLodLevel = lodLevel;
    }

    // Determine if we should use full detail or LOD
    const useFullDetail = lodLevel < 0 || !lodBuffersForDim.length ||
      lodLevel >= lodBuffersForDim.length ||
      (lodBuffersForDim[lodLevel] && lodBuffersForDim[lodLevel].isFullDetail);

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
        // For 2D data (dimensionLevel <= 2), disable depth testing entirely to prevent draw-order artifacts.
        // When all points have the same Z, depth testing causes visual differences at quadtree
        // boundaries because frustum culling changes the draw order (spatially grouped vs original).
        // Disabling depth writes alone is insufficient - we must also disable depth testing.
        const disableDepth = dimensionLevel <= 2;
        if (disableDepth) {
          gl.disable(gl.DEPTH_TEST);
        }

        // Use spatial index for hierarchical frustum culling (O(log n))
        if (useFullDetail) {
          this._renderSnapshotWithFrustumCulling(snapshot, params, frustumPlanes, viewState, sizeMultiplier, useAlphaTexture, spatialIndex);
        } else {
          this._renderSnapshotLODWithFrustumCulling(snapshot, lodLevel, params, frustumPlanes, viewState, useAlphaTexture, spatialIndex, lodBuffersForDim);
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

    // No frustum culling - check if we should use LOD
    if (!useFullDetail) {
      // Render with LOD using indexed drawing into snapshot buffer
      this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, mainSpatialIndex, lodBuffersForDim);
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
      if (this._isSignificantChange(viewState.lastVisibleCount, visibleIndices.length, snapshot.pointCount)) {
        console.log(`[FrustumCulling] Snapshot ${viewId}: ${visibleIndices.length.toLocaleString()}/${snapshot.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleIndices.length;
      }

      viewState.cachedVisibleIndices = new Uint32Array(visibleIndices);
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
    const lod = lodBuffers[lodLevel];

    if (!lod || lod.isFullDetail) {
      this._renderSnapshotFullDetail(snapshot, params, lod?.sizeMultiplier || 1.0, useAlphaTexture);
      return;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix, projectionMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    // Check if LOD level changed and we need to rebuild the index buffer
    const lodLevelChanged = viewState.cachedLodLevel !== lodLevel;

    if (lodLevelChanged && tree && tree.lodLevels && tree.lodLevels[lodLevel]) {
      // Get the LOD level's original indices (which points to render)
      const lodOriginalIndices = tree.lodLevels[lodLevel].indices;

      // Upload LOD indices to per-view index buffer
      const indicesArray = new Uint32Array(lodOriginalIndices);
      this._uploadToViewIndexBuffer(viewState, indicesArray);
      viewState.cachedCulledCount = lodOriginalIndices.length;
      viewState.cachedLodLevel = lodLevel;
      viewState.cachedLodIsCulled = false;  // Mark as full LOD indices (not culled)

      // Note: LOD level change is already logged by renderSnapshot at line ~2809
      // Only log here if this is called directly (not from frustum culling fallback)
      // We use prevLodLevel to avoid duplicate logging
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
    // For LOD with alpha texture, we need the LOD index texture to map LOD vertex to original index
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, lodLevel);
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
      if (uniforms.u_useLodIndexTex !== null) gl.uniform1i(uniforms.u_useLodIndexTex, 0);
    }

    // Bind snapshot VAO and per-view index buffer for indexed drawing
    gl.bindVertexArray(snapshot.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
    gl.drawElements(gl.POINTS, viewState.cachedCulledCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    // Unbind textures if they were used
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
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
      const visibleOriginalSet = new Set();
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
      // Pre-allocate max size to avoid array resizing (significant perf improvement)
      const lodOriginalIndices = tree.lodLevels[lodLevel].indices;
      const visibleLodIndices = new Uint32Array(lodOriginalIndices.length);
      let visibleCount = 0;
      for (let i = 0; i < lodOriginalIndices.length; i++) {
        if (visibleOriginalSet.has(lodOriginalIndices[i])) {
          visibleLodIndices[visibleCount++] = lodOriginalIndices[i];
        }
      }
      // Create a view of just the filled portion
      const visibleLodIndicesView = visibleLodIndices.subarray(0, visibleCount);
      const totalLodPoints = lodOriginalIndices.length;
      const visibleRatio = visibleCount / totalLodPoints;
      const cullPercent = ((1 - visibleRatio) * 100);

      // If >98% visible, render full LOD without frustum culling
      if (visibleRatio > 0.98) {
        // Only force re-upload if LOD level changed OR we were in culled mode
        // This prevents repeated uploads/logs when staying in >98% visible state
        if (viewState.cachedLodLevel !== lodLevel || viewState.cachedLodIsCulled) {
          viewState.cachedLodLevel = LOD_PENDING_REUPLOAD;  // Force _renderSnapshotWithLOD to upload full LOD indices
          // Note: cachedCulledCount will be set correctly by _renderSnapshotWithLOD
        }
        // When NOT re-uploading, cachedCulledCount retains the correct full LOD count from previous upload
        this.stats.frustumCulled = false;
        this.stats.cullPercent = cullPercent;
        this._renderSnapshotWithLOD(snapshot, lodLevel, params, viewState, useAlphaTexture, tree, lodBuffers);
        return;
      }

      // Log only on significant change (>10% of total points)
      if (this._isSignificantChange(viewState.lastVisibleCount, visibleCount, totalLodPoints)) {
        console.log(`[LOD+Frustum] Snapshot ${viewId}: LOD ${lodLevel} - ${visibleCount.toLocaleString()}/${totalLodPoints.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        viewState.lastVisibleCount = visibleCount;
      }

      // Upload filtered indices to per-view buffer (use subarray view, no copy needed)
      this._uploadToViewIndexBuffer(viewState, visibleLodIndicesView);
      viewState.cachedCulledCount = visibleCount;
      viewState.cachedLodLevel = lodLevel;
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
    // For LOD with alpha texture, we need the LOD index texture to map LOD vertex to original index
    if (useAlphaTexture && this._useAlphaTexture && this._alphaTexture) {
      this._bindAlphaTexture(gl, uniforms, lodLevel);
    } else {
      if (uniforms.u_useAlphaTex !== null) gl.uniform1i(uniforms.u_useAlphaTex, 0);
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
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
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

    for (const buffer of Object.values(this.buffers)) {
      if (buffer) gl.deleteBuffer(buffer);
    }

    // Clean up all per-dimension LOD buffers
    for (const lodBuffers of this.lodBuffersByDimension.values()) {
      for (const lod of lodBuffers) {
        if (lod.buffer) gl.deleteBuffer(lod.buffer);
      }
    }

    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    for (const vao of this.lodVaos) {
      gl.deleteVertexArray(vao);
    }

    // Clean up snapshot buffers
    this.deleteAllSnapshotBuffers();

    for (const program of Object.values(this.programs)) {
      if (program) gl.deleteProgram(program);
    }

    this.buffers = {};
    this.lodBuffersByDimension.clear();
    this.lodVaos = [];
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

    // Clean up LOD index textures
    for (const tex of this._lodIndexTextures) {
      if (tex.texture) gl.deleteTexture(tex.texture);
    }
    this._lodIndexTextures = [];
  }
}

export default HighPerfRenderer;
