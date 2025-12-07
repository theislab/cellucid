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
// OCTREE FOR SPATIAL INDEXING AND LOD
// ============================================================================

/**
 * Octree for spatial indexing and LOD generation
 * Enables frustum culling and adaptive level-of-detail
 */
export class Octree {
  constructor(positions, colors, maxPointsPerNode = 1000, maxDepth = 8) {
    this.maxPointsPerNode = maxPointsPerNode;
    this.maxDepth = maxDepth;
    this.positions = positions;
    this.colors = colors;
    // Alpha is packed in colors as RGBA uint8 - no separate array needed
    this.hasPackedAlpha = colors.length === (positions.length / 3) * 4 && colors.BYTES_PER_ELEMENT === 1;
    this.pointCount = positions.length / 3;

    // Calculate bounds
    this.bounds = this._calculateBounds();

    // Build tree
    console.time('Octree build');
    this.root = this._buildNode(
      this._createIndexArray(this.pointCount),
      this.bounds,
      0
    );
    console.timeEnd('Octree build');

    // Generate LOD levels
    console.time('LOD generation');
    this.lodLevels = this._generateLODLevels();
    console.timeEnd('LOD generation');
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

    const pad = 0.001;
    return {
      minX: minX - pad, minY: minY - pad, minZ: minZ - pad,
      maxX: maxX + pad, maxY: maxY + pad, maxZ: maxZ + pad
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

    const childBounds = [
      { minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ, maxX: midX, maxY: midY, maxZ: midZ },
      { minX: midX, minY: bounds.minY, minZ: bounds.minZ, maxX: bounds.maxX, maxY: midY, maxZ: midZ },
      { minX: bounds.minX, minY: midY, minZ: bounds.minZ, maxX: midX, maxY: bounds.maxY, maxZ: midZ },
      { minX: midX, minY: midY, minZ: bounds.minZ, maxX: bounds.maxX, maxY: bounds.maxY, maxZ: midZ },
      { minX: bounds.minX, minY: bounds.minY, minZ: midZ, maxX: midX, maxY: midY, maxZ: bounds.maxZ },
      { minX: midX, minY: bounds.minY, minZ: midZ, maxX: bounds.maxX, maxY: midY, maxZ: bounds.maxZ },
      { minX: bounds.minX, minY: midY, minZ: midZ, maxX: midX, maxY: bounds.maxY, maxZ: bounds.maxZ },
      { minX: midX, minY: midY, minZ: midZ, maxX: bounds.maxX, maxY: bounds.maxY, maxZ: bounds.maxZ }
    ];

    const childCounts = new Uint32Array(8);
    const positions = this.positions;

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const x = positions[idx * 3];
      const y = positions[idx * 3 + 1];
      const z = positions[idx * 3 + 2];

      const octant =
        (x >= midX ? 1 : 0) +
        (y >= midY ? 2 : 0) +
        (z >= midZ ? 4 : 0);

      childCounts[octant]++;
    }

    const childIndices = childBounds.map((_, i) =>
      childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
    );
    const childOffsets = new Uint32Array(8);

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const x = positions[idx * 3];
      const y = positions[idx * 3 + 1];
      const z = positions[idx * 3 + 2];

      const octant =
        (x >= midX ? 1 : 0) +
        (y >= midY ? 2 : 0) +
        (z >= midZ ? 4 : 0);

      childIndices[octant][childOffsets[octant]++] = idx;
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

    // Smooth LOD with ~1.4x steps for imperceptible transitions (17 levels)
    // Each step increases points by ~40%, below human perception threshold
    const reductionFactors = [256, 180, 128, 90, 64, 45, 32, 22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4, 1];

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

    console.log(`[Octree] Generated ${levels.length} LOD levels:`,
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
   */
  _buildHierarchicalOrder() {
    if (this._hierarchicalOrder) return this._hierarchicalOrder;

    const n = this.pointCount;
    const positions = this.positions;
    const bounds = this.bounds;

    // Normalize positions to 0-1023 range for 10-bit Morton codes
    const scaleX = 1023 / Math.max(bounds.maxX - bounds.minX, 0.0001);
    const scaleY = 1023 / Math.max(bounds.maxY - bounds.minY, 0.0001);
    const scaleZ = 1023 / Math.max(bounds.maxZ - bounds.minZ, 0.0001);

    // Create array of (index, morton code) pairs
    const ranked = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.floor((positions[i * 3] - bounds.minX) * scaleX) & 1023;
      const y = Math.floor((positions[i * 3 + 1] - bounds.minY) * scaleY) & 1023;
      const z = Math.floor((positions[i * 3 + 2] - bounds.minZ) * scaleZ) & 1023;

      // Compute 30-bit Morton code (interleave x, y, z bits)
      let morton = 0;
      for (let bit = 0; bit < 10; bit++) {
        morton |= ((x >> bit) & 1) << (bit * 3);
        morton |= ((y >> bit) & 1) << (bit * 3 + 1);
        morton |= ((z >> bit) & 1) << (bit * 3 + 2);
      }

      // Bit-reverse the Morton code for hierarchical ordering
      // This ensures points at index 0, 2, 4... are evenly distributed
      // while points at 1, 3, 5... fill in the gaps
      let reversed = 0;
      let temp = morton;
      for (let bit = 0; bit < 30; bit++) {
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

  getLODLevel(distance, viewportHeight, targetPointsOnScreen = 500000) {
    if (this.lodLevels.length === 0) return -1;

    const numLevels = this.lodLevels.length;

    // Calculate data diagonal size for scale-independent LOD selection
    const bounds = this.bounds;
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    const dataSize = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

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

    if (this._lastLODLevel === undefined) {
      this._lastLODLevel = Math.round(targetLevel);
    }

    const currentLevel = this._lastLODLevel;
    let newLevel = currentLevel;

    if (targetLevel > currentLevel + HYSTERESIS && currentLevel < numLevels - 1) {
      newLevel = currentLevel + 1;
    } else if (targetLevel < currentLevel - HYSTERESIS && currentLevel > 0) {
      newLevel = currentLevel - 1;
    }

    this._lastLODLevel = newLevel;
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

    // LOD system
    this.octree = null;
    this.lodBuffers = [];

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
      'u_mvpMatrix', 'u_viewMatrix', 'u_modelMatrix',
      'u_pointSize', 'u_sizeAttenuation', 'u_viewportHeight', 'u_fov',
      'u_lightingStrength', 'u_fogDensity', 'u_fogNear', 'u_fogFar',
      'u_fogColor', 'u_lightDir',
      // Alpha texture uniforms for efficient alpha-only updates
      'u_alphaTex', 'u_alphaTexWidth', 'u_useAlphaTex',
      // LOD index texture uniforms (for mapping LOD vertex to original index)
      'u_lodIndexTex', 'u_lodIndexTexWidth', 'u_useLodIndexTex'
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
    const {
      buildOctree = this.options.USE_LOD || this.options.USE_FRUSTUM_CULLING,
      maxPointsPerNode = this.options.LOD_MAX_POINTS_PER_NODE,
    } = options;

    this.pointCount = positions.length / 3;
    console.log(`[HighPerfRenderer] Loading ${this.pointCount.toLocaleString()} points...`);

    // Store references to original data for frustum culling
    // Alpha is packed in colors as RGBA uint8 - no separate array needed
    this._positions = positions;
    this._colors = colors;

    this._firstRenderDone = false;

    const startTime = performance.now();

    // Build octree for LOD and/or frustum culling
    if (buildOctree && this.pointCount > 10000) {
      console.log('[HighPerfRenderer] Building octree for LOD/frustum culling...');
      this.octree = new Octree(positions, colors, maxPointsPerNode);
      // Reset LOD state when new data is loaded
      this.octree._lastLODLevel = undefined;
      console.log(`[HighPerfRenderer] Octree built with ${this.octree.lodLevels.length} LOD levels (hierarchical sampling)`);

      // Reuse octree's bounding sphere (avoids duplicate bounds computation)
      this._boundingSphere = this.octree.getBoundingSphere();

      if (this.options.USE_LOD) {
        this._createLODBuffers();
      }
    } else {
      // No octree - compute bounding sphere directly for consistent fog
      this._boundingSphere = this._computeBoundingSphere(positions);
    }

    // Create main data buffers
    this._createInterleavedBuffer(positions, colors);

    // Create alpha texture for efficient alpha-only updates
    this._createAlphaTexture(this.pointCount);

    // Create LOD index textures if using LOD
    if (this.options.USE_LOD && this.octree) {
      this._createLODIndexTextures();
    }

    const elapsed = performance.now() - startTime;
    console.log(`[HighPerfRenderer] Data loaded in ${elapsed.toFixed(1)}ms`);

    // Calculate GPU memory usage
    const bytesPerPoint = 16; // interleaved (12 bytes position + 4 bytes RGBA)
    this.stats.gpuMemoryMB = (this.pointCount * bytesPerPoint) / (1024 * 1024);

    for (const lod of this.lodBuffers) {
      this.stats.gpuMemoryMB += (lod.pointCount * 16) / (1024 * 1024);
    }

    return this.stats;
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

    if (!this.octree || !this.octree.lodLevels) return;

    const maxWidth = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));

    for (let lvlIdx = 0; lvlIdx < this.octree.lodLevels.length; lvlIdx++) {
      const level = this.octree.lodLevels[lvlIdx];

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

  _createLODBuffers() {
    const gl = this.gl;

    // Clear existing buffers
    for (const buf of this.lodBuffers) {
      if (buf.buffer) gl.deleteBuffer(buf.buffer);
    }
    this.lodBuffers = [];

    // Clear existing VAOs
    for (const vao of this.lodVaos) {
      gl.deleteVertexArray(vao);
    }
    this.lodVaos = [];

    for (const level of this.octree.lodLevels) {
      if (level.isFullDetail) {
        this.lodBuffers.push({
          buffer: null,
          vao: null,
          pointCount: level.pointCount,
          depth: level.depth,
          isFullDetail: true,
          sizeMultiplier: 1.0
        });
        continue;
      }

      const pointCount = level.pointCount;

      // Interleaved buffer: [x,y,z (float32), r,g,b,a (uint8)] - 16 bytes per point
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
      this.lodVaos.push(vao);

      this.lodBuffers.push({
        buffer: glBuffer,
        vao,
        pointCount,
        depth: level.depth,
        isFullDetail: false,
        sizeMultiplier: level.sizeMultiplier || 1.0
      });
    }
  }

  updateColors(colors) {
    // Note: Reference check removed - callers often modify arrays in-place,
    // so same reference doesn't mean same content.
    if (!colors) return;

    this._colors = colors; // Now Uint8Array with RGBA packed
    this._currentAlphas = null; // Reset alpha tracking since colors changed

    // Mark buffers as dirty - actual rebuild deferred to render() to avoid double rebuilds
    this._bufferDirty = true;
    if (this.octree && this.lodBuffers.length > 0) {
      this._lodBuffersDirty = true;
    }
  }

  updateAlphas(alphas) {
    // Note: Reference check removed - callers often modify arrays in-place,
    // so same reference doesn't mean same content.
    if (!alphas) return;

    this._currentAlphas = alphas; // Track current alphas reference

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
      if (this.octree && this.lodBuffers.length > 0) {
        this._lodAlphaOnlyDirty = true;
      }
    } else {
      this._bufferDirty = true;
      if (this.octree && this.lodBuffers.length > 0) {
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

    for (let lvlIdx = 0; lvlIdx < this.lodBuffers.length; lvlIdx++) {
      const lodBuf = this.lodBuffers[lvlIdx];
      if (lodBuf.isFullDetail) continue;

      const level = this.octree.lodLevels[lvlIdx];
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

    // Update each non-full-detail LOD buffer
    for (let lvlIdx = 0; lvlIdx < this.lodBuffers.length; lvlIdx++) {
      const lodBuf = this.lodBuffers[lvlIdx];
      if (lodBuf.isFullDetail) continue;

      const level = this.octree.lodLevels[lvlIdx];
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

  autoComputeFogRange(cameraPosition) {
    // Use cached bounding sphere (computed in loadData), fall back to octree or defaults
    const sphere = this._boundingSphere || (this.octree ? this.octree.getBoundingSphere() : null);

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

  extractFrustumPlanes(mvpMatrix, margin = 0.05) {
    const m = mvpMatrix;
    // Reuse pre-allocated planes array to avoid GC allocations every frame
    const planes = this._frustumPlanes;

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

    // Normalize planes and apply margin
    for (let i = 0; i < 6; i++) {
      const plane = planes[i];
      const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
      if (len > 0) {
        plane[0] /= len;
        plane[1] /= len;
        plane[2] /= len;
        plane[3] /= len;
      }
      // Expand left/right/top/bottom planes outward (indices 0-3)
      // Positive margin pushes planes away from center, enlarging the frustum
      if (i < 4 && margin > 0) {
        plane[3] += margin;
      }
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
      quality = this.activeQuality
    } = params;

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
        hasOctree: !!this.octree
      });
      this._firstRenderDone = true;
    }

    // Auto-compute fog range
    if (params.autoFog !== false) {
      this.autoComputeFogRange(cameraPosition);
    }

    // Set quality if changed
    if (quality !== this.activeQuality) {
      this.setQuality(quality);
    }

    // Select LOD level first (determines whether to use frustum culling)
    // Priority: this.forceLODLevel > params.forceLOD > adaptive
    let lodLevel = this.forceLODLevel >= 0 ? this.forceLODLevel : forceLOD;
    if (lodLevel < 0 && this.useAdaptiveLOD && this.octree) {
      lodLevel = this.octree.getLODLevel(cameraDistance, viewportHeight);
    }

    const useFullDetail = lodLevel < 0 || !this.lodBuffers.length ||
      lodLevel >= this.lodBuffers.length ||
      (this.lodBuffers[lodLevel] && this.lodBuffers[lodLevel].isFullDetail);

    // Debug LOD selection - only log when level changes
    if (this._prevLodLevel !== lodLevel && this.octree && (this.useAdaptiveLOD || this.forceLODLevel >= 0)) {
      const lodBuf = this.lodBuffers[lodLevel];
      const pointCount = lodBuf ? lodBuf.pointCount : this.pointCount;
      const mode = this.forceLODLevel >= 0 ? 'forced' : 'auto';
      console.log(`[LOD] Transition: level ${this._prevLodLevel ?? 'init'} → ${lodLevel} (${pointCount.toLocaleString()} pts, ${mode})`);
      this._prevLodLevel = lodLevel;
    }

    // Frustum culling only applies when at full detail (highest LOD or LOD disabled)
    // At reduced LOD levels, the point count is already reduced so frustum culling has less benefit
    if (this.useFrustumCulling && this.octree && useFullDetail) {
      const frustumPlanes = this.extractFrustumPlanes(mvpMatrix);
      this._renderWithFrustumCulling(params, frustumPlanes);
      this.stats.lastFrameTime = performance.now() - frameStart;
      this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));
      return this.stats;
    }

    // Reset frustum culling stats when not using it
    if (!this.useFrustumCulling || !useFullDetail) {
      this.stats.frustumCulled = false;
      this.stats.cullPercent = 0;
    }

    if (useFullDetail) {
      this._renderFullDetail(params);
    } else {
      this._renderLOD(lodLevel, params);
    }

    this.stats.lastFrameTime = performance.now() - frameStart;
    this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));

    return this.stats;
  }

  _renderWithFrustumCulling(params, frustumPlanes) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    const needsUpdate = this._checkFrustumCacheValid(mvpMatrix);

    if (needsUpdate) {
      const visibleNodes = [];
      this._collectVisibleNodes(this.octree.root, frustumPlanes, visibleNodes);

      if (visibleNodes.length === 0) {
        this.stats.visiblePoints = 0;
        this.stats.drawCalls = 0;
        this.stats.frustumCulled = true;
        this.stats.cullPercent = 100;
        this._cachedCulledCount = 0;
        return;
      }

      // Count total visible points first to determine buffer size
      let totalVisible = 0;
      for (const node of visibleNodes) {
        if (node.indices) totalVisible += node.indices.length;
      }

      // Reuse pooled buffer, only grow when capacity exceeded (avoids GC allocations)
      if (!this._visibleIndicesBuffer || this._visibleIndicesCapacity < totalVisible) {
        // Grow with 25% headroom to reduce future reallocations
        this._visibleIndicesCapacity = Math.ceil(totalVisible * 1.25);
        this._visibleIndicesBuffer = new Uint32Array(this._visibleIndicesCapacity);
      }

      // Fill the pooled buffer with visible indices
      let writeOffset = 0;
      for (const node of visibleNodes) {
        if (node.indices) {
          this._visibleIndicesBuffer.set(node.indices, writeOffset);
          writeOffset += node.indices.length;
        }
      }

      // Create a view of only the used portion (no allocation, just a view)
      const visibleIndices = this._visibleIndicesBuffer.subarray(0, totalVisible);

      const visibleRatio = totalVisible / this.pointCount;
      const cullPercent = ((1 - visibleRatio) * 100);
      const visibleCount = visibleIndices.length;

      // If >98% visible, render everything (building culled buffer not worth it)
      if (visibleRatio > 0.98) {
        if (this._lastVisibleCount !== this.pointCount) {
          console.log(`[FrustumCulling] ${this.pointCount.toLocaleString()} visible (full detail, ${cullPercent.toFixed(1)}% culled)`);
          this._lastVisibleCount = this.pointCount;
        }
        this._cachedCulledCount = 0;
        this.stats.frustumCulled = false;
        this.stats.cullPercent = cullPercent;
        this._renderFullDetail(params);
        return;
      }

      // Log whenever visible count changes
      if (this._lastVisibleCount !== visibleCount) {
        console.log(`[FrustumCulling] ${visibleCount.toLocaleString()}/${this.pointCount.toLocaleString()} visible (${cullPercent.toFixed(1)}% culled)`);
        this._lastVisibleCount = visibleCount;
      }

      this._updateCulledIndexBuffer(visibleIndices);
      this._cachedCulledCount = visibleIndices.length;
      this.stats.frustumCulled = true;
      this.stats.cullPercent = cullPercent;
    }

    if (!this._cachedCulledCount || this._cachedCulledCount === 0) {
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

    // Bind alpha texture for efficient alpha lookups
    // Note: With indexed drawing (drawElements), gl_VertexID is the index value,
    // which correctly maps to the original point index in our alpha texture
    this._bindAlphaTexture(gl, uniforms);

    // Bind the main VAO (vertex data) and the index buffer for indexed drawing
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    // Draw using indexed rendering - much faster than copying vertex data
    gl.drawElements(gl.POINTS, this._cachedCulledCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);

    // Unbind alpha texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.stats.visiblePoints = this._cachedCulledCount;
    this.stats.lodLevel = -1;
    this.stats.drawCalls = 1;
  }

  _checkFrustumCacheValid(mvpMatrix) {
    if (!this._lastFrustumMVP) {
      this._lastFrustumMVP = new Float32Array(mvpMatrix);
      return true;
    }

    // Use sum of squared differences for more stable detection
    let sumSqDiff = 0;
    for (let i = 0; i < 16; i++) {
      const diff = mvpMatrix[i] - this._lastFrustumMVP[i];
      sumSqDiff += diff * diff;
    }

    // Higher threshold to avoid rebuilding on tiny movements
    // sqrt(0.01) ≈ 0.1 total change across the matrix
    const threshold = 0.01;

    if (sumSqDiff > threshold) {
      for (let i = 0; i < 16; i++) {
        this._lastFrustumMVP[i] = mvpMatrix[i];
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

  _updateCulledIndexBuffer(visibleIndices) {
    const gl = this.gl;

    // visibleIndices is already a Uint32Array - upload directly to GPU
    // This avoids any CPU-side copying, making frustum culling much faster
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, visibleIndices, gl.DYNAMIC_DRAW);

    this._culledPointCount = visibleIndices.length;
  }

  _renderFullDetail(params) {
    const gl = this.gl;
    const {
      mvpMatrix, viewMatrix, modelMatrix,
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

    gl.uniform1f(uniforms.u_pointSize, pointSize);

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
    const lod = this.lodBuffers[lodLevel];

    if (lod.isFullDetail) {
      this._renderFullDetail(params);
      return;
    }

    const {
      mvpMatrix, viewMatrix, modelMatrix,
      pointSize, sizeAttenuation, viewportHeight, fov,
      lightingStrength, fogDensity, fogColor, lightDir
    } = params;

    const adjustedPointSize = pointSize * (lod.sizeMultiplier || 1.0);

    const program = this.programs.full;
    let uniforms = this.uniformLocations.get('full');

    if (!uniforms || !program) {
      console.error('[HighPerfRenderer] No valid program for LOD rendering');
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

  setAdaptiveLOD(enabled) {
    this.useAdaptiveLOD = enabled;
    console.log(`[HighPerfRenderer] Adaptive LOD ${enabled ? 'enabled' : 'disabled'}`);

    if (enabled && this.pointCount > 0 && this._positions) {
      // Build octree if needed
      if (!this.octree) {
        console.log('[HighPerfRenderer] Building octree for LOD...');
        this.octree = new Octree(
          this._positions,
          this._colors,
          this.options.LOD_MAX_POINTS_PER_NODE
        );
        console.log(`[HighPerfRenderer] Octree built with ${this.octree.lodLevels.length} LOD levels`);
      }

      // Create LOD buffers if needed
      if (this.lodBuffers.length === 0) {
        console.log('[HighPerfRenderer] Creating LOD buffers...');
        this._createLODBuffers();
        console.log(`[HighPerfRenderer] Created ${this.lodBuffers.length} LOD buffer levels`);
      }
    }
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

    // Reset frustum culling state
    this._lastFrustumMVP = null;
    this._cachedCulledCount = 0;
    this._lastVisibleCount = undefined;
    this.stats.frustumCulled = false;
    this.stats.cullPercent = 0;

    if (enabled && !this.octree && this.pointCount > 0 && this._positions) {
      console.log('[HighPerfRenderer] Building octree for frustum culling...');
      this.octree = new Octree(
        this._positions,
        this._colors,
        this.options.LOD_MAX_POINTS_PER_NODE
      );
      console.log(`[HighPerfRenderer] Octree built with ${this.octree.lodLevels.length} LOD levels`);
    }
  }

  ensureOctree() {
    if (!this.octree && this.pointCount > 0 && this._positions) {
      console.log('[HighPerfRenderer] Building octree for collision detection...');
      this.octree = new Octree(
        this._positions,
        this._colors,
        this.options.LOD_MAX_POINTS_PER_NODE
      );
      console.log(`[HighPerfRenderer] Octree built with ${this.octree.lodLevels.length} LOD levels`);
    }
  }

  getStats() {
    return { ...this.stats };
  }

  getPositions() {
    return this._positions;
  }

  getLODLevelCount() {
    return this.lodBuffers.length;
  }

  /**
   * Get the current LOD level being rendered (-1 = full detail)
   */
  getCurrentLODLevel() {
    return this.stats.lodLevel;
  }

  /**
   * Get visibility array for current LOD level.
   * Returns Float32Array where 1.0 = visible at current LOD, 0.0 = hidden by LOD.
   * When LOD is disabled or at full detail, returns null (meaning all visible).
   *
   * Performance: Reuses cached array, only rebuilds when LOD level changes.
   */
  getLodVisibilityArray() {
    const n = this.pointCount;
    if (n === 0) return null;

    // If no octree or LOD disabled, all points visible - return null to signal "all visible"
    if (!this.octree || !this.useAdaptiveLOD || this.stats.lodLevel < 0) {
      return null;
    }

    const lodLevel = this.stats.lodLevel;
    const lodBuffer = this.lodBuffers[lodLevel];

    // Full detail level - all visible
    if (!lodBuffer || lodBuffer.isFullDetail) {
      return null;
    }

    // Return cached array if LOD level hasn't changed
    if (this._cachedLodVisibility && this._cachedLodVisibilityLevel === lodLevel) {
      return this._cachedLodVisibility;
    }

    // Get the LOD level's indices (which original points are included)
    const level = this.octree.lodLevels[lodLevel];
    if (!level || !level.indices) {
      return null;
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
    return this._cachedLodVisibility;
  }

  // ===========================================================================
  // SNAPSHOT BUFFER MANAGEMENT (for multi-view rendering without re-uploads)
  // ===========================================================================

  /**
   * Create a GPU buffer for a snapshot view. Call this once when snapshot is created.
   * The buffer stores interleaved position+color data and is only uploaded once.
   * @param {string} id - Unique snapshot identifier
   * @param {Uint8Array} colors - RGBA colors (4 bytes per point)
   * @param {Float32Array} [alphas] - Optional alpha values (0-1), merged into colors
   * @returns {boolean} Success
   */
  createSnapshotBuffer(id, colors, alphas = null) {
    if (!this._positions || this.pointCount === 0) {
      console.warn('[HighPerfRenderer] Cannot create snapshot buffer: no data loaded');
      return false;
    }

    const gl = this.gl;
    const n = this.pointCount;
    const positions = this._positions;

    // Create a copy of colors to avoid modifying the original
    const snapshotColors = new Uint8Array(colors);

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

    this.snapshotBuffers.set(id, {
      vao,
      buffer: glBuffer,
      pointCount: n
    });

    console.log(`[HighPerfRenderer] Created snapshot buffer "${id}" (${n.toLocaleString()} points, ${(n * 16 / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  }

  /**
   * Update an existing snapshot buffer with new colors/alphas.
   * More efficient than delete+create as it reuses the GPU buffer.
   * @param {string} id - Snapshot identifier
   * @param {Uint8Array} colors - RGBA colors
   * @param {Float32Array} [alphas] - Optional alpha values
   * @returns {boolean} Success
   */
  updateSnapshotBuffer(id, colors, alphas = null) {
    const snapshot = this.snapshotBuffers.get(id);
    if (!snapshot) {
      // Create new buffer if it doesn't exist
      return this.createSnapshotBuffer(id, colors, alphas);
    }

    const gl = this.gl;
    const n = this.pointCount;
    const positions = this._positions;

    // Create merged colors
    const snapshotColors = new Uint8Array(colors);
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

    return true;
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
   * @param {string} id - Snapshot identifier
   * @param {Object} params - Render parameters (same as render())
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
      mvpMatrix, viewMatrix, modelMatrix,
      pointSize = 5.0, sizeAttenuation = 0.0, viewportHeight, fov,
      lightingStrength = 0.6, fogDensity = 0.5,
      fogColor = [1, 1, 1], lightDir = [0.5, 0.7, 0.5],
      cameraPosition = [0, 0, 3], quality = this.activeQuality
    } = params;

    const frameStart = performance.now();

    // Auto-compute fog range
    if (params.autoFog !== false) {
      this.autoComputeFogRange(cameraPosition);
    }

    // Set quality if changed
    if (quality !== this.activeQuality) {
      this.setQuality(quality);
    }

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
      console.error('[HighPerfRenderer] No program/uniforms for snapshot render');
      return this.stats;
    }

    gl.useProgram(program);

    // Set uniforms
    if (uniforms.u_mvpMatrix !== null) gl.uniformMatrix4fv(uniforms.u_mvpMatrix, false, mvpMatrix);
    if (uniforms.u_viewMatrix !== null) gl.uniformMatrix4fv(uniforms.u_viewMatrix, false, viewMatrix);
    if (uniforms.u_modelMatrix !== null) gl.uniformMatrix4fv(uniforms.u_modelMatrix, false, modelMatrix);
    if (uniforms.u_pointSize !== null) gl.uniform1f(uniforms.u_pointSize, pointSize);
    if (uniforms.u_sizeAttenuation !== null) gl.uniform1f(uniforms.u_sizeAttenuation, sizeAttenuation);
    if (uniforms.u_viewportHeight !== null) gl.uniform1f(uniforms.u_viewportHeight, viewportHeight);
    if (uniforms.u_fov !== null) gl.uniform1f(uniforms.u_fov, fov);
    if (uniforms.u_lightingStrength !== null) gl.uniform1f(uniforms.u_lightingStrength, lightingStrength);
    if (uniforms.u_fogDensity !== null) gl.uniform1f(uniforms.u_fogDensity, fogDensity);
    if (uniforms.u_fogNear !== null) gl.uniform1f(uniforms.u_fogNear, this.fogNear);
    if (uniforms.u_fogFar !== null) gl.uniform1f(uniforms.u_fogFar, this.fogFar);
    if (uniforms.u_fogColor !== null) gl.uniform3fv(uniforms.u_fogColor, fogColor);
    if (uniforms.u_lightDir !== null) gl.uniform3fv(uniforms.u_lightDir, lightDir);

    // Bind snapshot's VAO (no data upload!)
    gl.bindVertexArray(snapshot.vao);
    gl.drawArrays(gl.POINTS, 0, snapshot.pointCount);
    gl.bindVertexArray(null);

    this.stats.visiblePoints = snapshot.pointCount;
    this.stats.lodLevel = -1;
    this.stats.drawCalls = 1;
    this.stats.lastFrameTime = performance.now() - frameStart;
    this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));

    return this.stats;
  }

  dispose() {
    const gl = this.gl;

    for (const buffer of Object.values(this.buffers)) {
      if (buffer) gl.deleteBuffer(buffer);
    }

    for (const lod of this.lodBuffers) {
      if (lod.buffer) gl.deleteBuffer(lod.buffer);
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
    this.lodBuffers = [];
    this.lodVaos = [];
    this.programs = {};
    this.octree = null;

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
