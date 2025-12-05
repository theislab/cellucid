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
  constructor(positions, colors, alphas, maxPointsPerNode = 1000, maxDepth = 8) {
    this.maxPointsPerNode = maxPointsPerNode;
    this.maxDepth = maxDepth;
    this.positions = positions;
    this.colors = colors;
    this.alphas = alphas;
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
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i] * 3;
      sr += colors[idx];
      sg += colors[idx + 1];
      sb += colors[idx + 2];
    }
    const n = indices.length;
    return [sr / n, sg / n, sb / n];
  }

  _computeAvgAlpha(indices) {
    let sum = 0;
    const alphas = this.alphas;
    for (let i = 0; i < indices.length; i++) {
      sum += alphas[indices[i]];
    }
    return sum / indices.length;
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

    const reductionFactors = [64, 16, 4, 1];

    for (let levelIdx = 0; levelIdx < reductionFactors.length; levelIdx++) {
      const factor = reductionFactors[levelIdx];
      const targetCount = Math.max(1000, Math.ceil(totalPoints / factor));

      if (factor === 1) {
        levels.push({
          depth: levelIdx,
          pointCount: totalPoints,
          positions: this.positions,
          colors: this.colors,
          alphas: this.alphas,
          sizes: null,
          isFullDetail: true
        });
        continue;
      }

      const sampledIndices = this._stratifiedSample(targetCount);
      const pointCount = sampledIndices.length;

      const positions = new Float32Array(pointCount * 3);
      const colors = new Float32Array(pointCount * 3);
      const alphas = new Float32Array(pointCount);

      for (let i = 0; i < pointCount; i++) {
        const srcIdx = sampledIndices[i];
        const dstIdx = i * 3;
        const srcPosIdx = srcIdx * 3;

        positions[dstIdx] = this.positions[srcPosIdx];
        positions[dstIdx + 1] = this.positions[srcPosIdx + 1];
        positions[dstIdx + 2] = this.positions[srcPosIdx + 2];

        colors[dstIdx] = this.colors[srcPosIdx];
        colors[dstIdx + 1] = this.colors[srcPosIdx + 1];
        colors[dstIdx + 2] = this.colors[srcPosIdx + 2];

        alphas[i] = this.alphas[srcIdx];
      }

      levels.push({
        depth: levelIdx,
        pointCount,
        positions,
        colors,
        alphas,
        indices: sampledIndices, // Store indices for color/alpha updates
        sizes: null,
        isFullDetail: false,
        sizeMultiplier: Math.sqrt(factor) * 0.5 + 0.5
      });
    }

    console.log(`[Octree] Generated ${levels.length} LOD levels:`,
      levels.map(l => `${l.pointCount.toLocaleString()} pts`).join(', '));

    return levels;
  }

  _stratifiedSample(targetCount) {
    const sampledIndices = [];

    const leafNodes = [];
    const collectLeaves = (node) => {
      if (!node) return;
      if (node.indices !== null) {
        leafNodes.push(node);
      } else if (node.children) {
        for (const child of node.children) {
          collectLeaves(child);
        }
      }
    };
    collectLeaves(this.root);

    if (leafNodes.length === 0) {
      const step = Math.max(1, Math.floor(this.pointCount / targetCount));
      for (let i = 0; i < this.pointCount && sampledIndices.length < targetCount; i += step) {
        sampledIndices.push(i);
      }
      return sampledIndices;
    }

    const totalNodePoints = leafNodes.reduce((sum, n) => sum + n.indices.length, 0);

    for (const node of leafNodes) {
      const nodeShare = node.indices.length / totalNodePoints;
      const nodeSampleCount = Math.max(1, Math.round(targetCount * nodeShare));
      const step = Math.max(1, Math.floor(node.indices.length / nodeSampleCount));

      for (let i = 0; i < node.indices.length && sampledIndices.length < targetCount; i += step) {
        sampledIndices.push(node.indices[i]);
      }
    }

    return sampledIndices;
  }

  getLODLevel(distance, viewportHeight, targetPointsOnScreen = 500000) {
    if (this.lodLevels.length === 0) return -1;

    const pixelsPerUnit = viewportHeight / (distance * 2);

    if (pixelsPerUnit > 1.0) {
      return this.lodLevels.length - 1;
    } else if (pixelsPerUnit > 0.3) {
      return Math.min(this.lodLevels.length - 1, Math.max(0, this.lodLevels.length - 2));
    } else if (pixelsPerUnit > 0.1) {
      return Math.min(this.lodLevels.length - 1, Math.max(0, this.lodLevels.length - 3));
    } else {
      return 0;
    }
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
  USE_LOD: true,
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
      culled: null,
    };

    // LOD system
    this.octree = null;
    this.lodBuffers = [];

    // State
    this.pointCount = 0;
    this.currentLOD = -1;
    this.useAdaptiveLOD = this.options.USE_LOD;
    this.useFrustumCulling = this.options.USE_FRUSTUM_CULLING;
    this.useInterleavedBuffers = this.options.USE_INTERLEAVED_BUFFERS;

    // VAO for WebGL2
    this.vao = null;
    this.lodVaos = [];

    // Performance stats
    this.stats = {
      lastFrameTime: 0,
      fps: 0,
      visiblePoints: 0,
      lodLevel: -1,
      gpuMemoryMB: 0,
      drawCalls: 0,
    };

    // Fog bounds
    this.fogNear = 0;
    this.fogFar = 10;

    this._init();
  }

  _init() {
    const gl = this.gl;

    // Create shader programs
    this._createPrograms();

    // Create VAO
    this.vao = gl.createVertexArray();

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
      'u_fogColor', 'u_lightDir'
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

  loadData(positions, colors, alphas, options = {}) {
    const gl = this.gl;
    const {
      buildOctree = this.options.USE_LOD || this.options.USE_FRUSTUM_CULLING,
      maxPointsPerNode = this.options.LOD_MAX_POINTS_PER_NODE,
    } = options;

    this.pointCount = positions.length / 3;
    console.log(`[HighPerfRenderer] Loading ${this.pointCount.toLocaleString()} points...`);

    // Store references to original data for frustum culling
    this._positions = positions;
    this._colors = colors;
    this._alphas = alphas;

    this._firstRenderDone = false;

    const startTime = performance.now();

    // Build octree for LOD and/or frustum culling
    if (buildOctree && this.pointCount > 10000) {
      console.log('[HighPerfRenderer] Building octree for LOD/frustum culling...');
      this.octree = new Octree(positions, colors, alphas, maxPointsPerNode);
      console.log(`[HighPerfRenderer] Octree built with ${this.octree.lodLevels.length} LOD levels`);

      if (this.options.USE_LOD) {
        this._createLODBuffers();
      }
    }

    // Create main data buffers
    this._createInterleavedBuffer(positions, colors, alphas);

    const elapsed = performance.now() - startTime;
    console.log(`[HighPerfRenderer] Data loaded in ${elapsed.toFixed(1)}ms`);

    // Calculate GPU memory usage
    const bytesPerPoint = 28; // interleaved
    this.stats.gpuMemoryMB = (this.pointCount * bytesPerPoint) / (1024 * 1024);

    for (const lod of this.lodBuffers) {
      this.stats.gpuMemoryMB += (lod.pointCount * 32) / (1024 * 1024);
    }

    return this.stats;
  }

  _createInterleavedBuffer(positions, colors, alphas) {
    const gl = this.gl;
    const pointCount = positions.length / 3;

    // Create interleaved buffer: [x,y,z, r,g,b, a] per point (28 bytes)
    const interleavedData = new Float32Array(pointCount * 7);

    for (let i = 0; i < pointCount; i++) {
      const srcIdx = i * 3;
      const dstIdx = i * 7;

      interleavedData[dstIdx] = positions[srcIdx];
      interleavedData[dstIdx + 1] = positions[srcIdx + 1];
      interleavedData[dstIdx + 2] = positions[srcIdx + 2];
      interleavedData[dstIdx + 3] = colors[srcIdx];
      interleavedData[dstIdx + 4] = colors[srcIdx + 1];
      interleavedData[dstIdx + 5] = colors[srcIdx + 2];
      interleavedData[dstIdx + 6] = alphas[i];
    }

    if (!this.buffers.interleaved) {
      this.buffers.interleaved = gl.createBuffer();
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, interleavedData, gl.STATIC_DRAW);

    // Setup VAO
    gl.bindVertexArray(this.vao);
    this._setupInterleavedAttributes();
    gl.bindVertexArray(null);
  }

  _setupInterleavedAttributes() {
    const gl = this.gl;
    const STRIDE = 28; // 7 floats * 4 bytes

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);

    // Position (location 0)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);

    // Color (location 1)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12);

    // Alpha (location 2)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 24);
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

      // Interleaved buffer: [x,y,z, r,g,b, a] - 28 bytes per point
      const data = new Float32Array(pointCount * 7);

      for (let i = 0; i < pointCount; i++) {
        const dstIdx = i * 7;
        const srcIdx = i * 3;

        data[dstIdx] = level.positions[srcIdx];
        data[dstIdx + 1] = level.positions[srcIdx + 1];
        data[dstIdx + 2] = level.positions[srcIdx + 2];
        data[dstIdx + 3] = level.colors[srcIdx];
        data[dstIdx + 4] = level.colors[srcIdx + 1];
        data[dstIdx + 5] = level.colors[srcIdx + 2];
        data[dstIdx + 6] = level.alphas[i];
      }

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

      // Create VAO for this LOD level
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      const STRIDE = 28;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 24);

      gl.bindVertexArray(null);
      this.lodVaos.push(vao);

      this.lodBuffers.push({
        buffer,
        vao,
        pointCount,
        depth: level.depth,
        isFullDetail: false,
        sizeMultiplier: level.sizeMultiplier || 1.0
      });
    }
  }

  updateColors(colors) {
    this._colors = colors;

    // Rebuild entire interleaved buffer (fast single upload)
    this._rebuildInterleavedBuffer();

    // Also rebuild LOD buffers if they exist
    if (this.octree && this.lodBuffers.length > 0) {
      this._rebuildLODBuffersWithCurrentData();
    }
  }

  updateAlphas(alphas) {
    this._alphas = alphas;

    // Rebuild entire interleaved buffer (fast single upload)
    this._rebuildInterleavedBuffer();

    // Also rebuild LOD buffers if they exist
    if (this.octree && this.lodBuffers.length > 0) {
      this._rebuildLODBuffersWithCurrentData();
    }
  }

  _rebuildInterleavedBuffer() {
    const gl = this.gl;
    const n = this.pointCount;
    const positions = this._positions;
    const colors = this._colors;
    const alphas = this._alphas;

    // Build interleaved data in one pass
    const interleavedData = new Float32Array(n * 7);
    for (let i = 0; i < n; i++) {
      const srcIdx = i * 3;
      const dstIdx = i * 7;
      interleavedData[dstIdx] = positions[srcIdx];
      interleavedData[dstIdx + 1] = positions[srcIdx + 1];
      interleavedData[dstIdx + 2] = positions[srcIdx + 2];
      interleavedData[dstIdx + 3] = colors[srcIdx];
      interleavedData[dstIdx + 4] = colors[srcIdx + 1];
      interleavedData[dstIdx + 5] = colors[srcIdx + 2];
      interleavedData[dstIdx + 6] = alphas[i];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.interleaved);
    gl.bufferData(gl.ARRAY_BUFFER, interleavedData, gl.DYNAMIC_DRAW);
  }

  _rebuildLODBuffersWithCurrentData() {
    const gl = this.gl;
    const colors = this._colors;
    const alphas = this._alphas;

    // Update each non-full-detail LOD buffer
    for (let lvlIdx = 0; lvlIdx < this.lodBuffers.length; lvlIdx++) {
      const lodBuf = this.lodBuffers[lvlIdx];
      if (lodBuf.isFullDetail) continue;

      const level = this.octree.lodLevels[lvlIdx];
      if (!level || !level.indices) continue;

      const pointCount = level.pointCount;
      const data = new Float32Array(pointCount * 7);

      // Use the indices to sample from current colors/alphas
      for (let i = 0; i < pointCount; i++) {
        const origIdx = level.indices[i];
        const srcIdx3 = origIdx * 3;
        const dstIdx = i * 7;

        data[dstIdx] = level.positions[i * 3];
        data[dstIdx + 1] = level.positions[i * 3 + 1];
        data[dstIdx + 2] = level.positions[i * 3 + 2];
        data[dstIdx + 3] = colors[srcIdx3];
        data[dstIdx + 4] = colors[srcIdx3 + 1];
        data[dstIdx + 5] = colors[srcIdx3 + 2];
        data[dstIdx + 6] = alphas[origIdx];
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, lodBuf.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    }
  }

  setFogRange(near, far) {
    this.fogNear = near;
    this.fogFar = far;
  }

  autoComputeFogRange(cameraPosition) {
    if (!this.octree) {
      this.fogNear = 0;
      this.fogFar = 10;
      return;
    }

    const sphere = this.octree.getBoundingSphere();
    const dx = cameraPosition[0] - sphere.center[0];
    const dy = cameraPosition[1] - sphere.center[1];
    const dz = cameraPosition[2] - sphere.center[2];
    const distToCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);

    this.fogNear = Math.max(0, distToCenter - sphere.radius);
    this.fogFar = distToCenter + sphere.radius;
  }

  extractFrustumPlanes(mvpMatrix) {
    const m = mvpMatrix;
    const planes = [];

    planes.push([m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]]);
    planes.push([m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]]);
    planes.push([m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]]);
    planes.push([m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]]);
    planes.push([m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]]);
    planes.push([m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]]);

    for (const plane of planes) {
      const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
      if (len > 0) {
        plane[0] /= len;
        plane[1] /= len;
        plane[2] /= len;
        plane[3] /= len;
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
        useFrustumCulling: this.useFrustumCulling
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

    // Frustum culling path
    if (this.useFrustumCulling && this.octree) {
      const frustumPlanes = this.extractFrustumPlanes(mvpMatrix);
      this._renderWithFrustumCulling(params, frustumPlanes);
      this.stats.lastFrameTime = performance.now() - frameStart;
      this.stats.fps = Math.round(1000 / Math.max(this.stats.lastFrameTime, 1));
      return this.stats;
    }

    // Select LOD level
    let lodLevel = forceLOD;
    if (lodLevel < 0 && this.useAdaptiveLOD && this.octree) {
      lodLevel = this.octree.getLODLevel(cameraDistance, viewportHeight);
    }

    const useFullDetail = lodLevel < 0 || !this.lodBuffers.length ||
      lodLevel >= this.lodBuffers.length;

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
        this._cachedCulledCount = 0;
        return;
      }

      const visibleIndices = [];
      for (const node of visibleNodes) {
        if (node.indices) {
          for (let i = 0; i < node.indices.length; i++) {
            visibleIndices.push(node.indices[i]);
          }
        }
      }

      // If >85% visible, just render everything
      if (visibleIndices.length > this.pointCount * 0.85) {
        this._renderFullDetail(params);
        return;
      }

      this._frustumCullFrameCount = (this._frustumCullFrameCount || 0) + 1;
      if (this._frustumCullFrameCount % 120 === 1) {
        const cullPercent = ((1 - visibleIndices.length / this.pointCount) * 100).toFixed(1);
        console.log(`[FrustumCulling] Visible: ${visibleIndices.length.toLocaleString()}/${this.pointCount.toLocaleString()} (${cullPercent}% culled)`);
      }

      this._updateCulledBuffer(visibleIndices);
      this._cachedCulledCount = visibleIndices.length;
    }

    if (!this._cachedCulledCount || this._cachedCulledCount === 0) {
      this._renderFullDetail(params);
      return;
    }

    const program = this.activeProgram;
    const uniforms = this.uniformLocations.get(this.activeQuality);

    if (!program || !uniforms) {
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

    // Bind culled buffer and setup attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.culled);

    const STRIDE = 28;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 24);

    gl.drawArrays(gl.POINTS, 0, this._cachedCulledCount);

    this.stats.visiblePoints = this._cachedCulledCount;
    this.stats.lodLevel = -1;
    this.stats.drawCalls = 1;
  }

  _checkFrustumCacheValid(mvpMatrix) {
    if (!this._lastFrustumMVP) {
      this._lastFrustumMVP = new Float32Array(mvpMatrix);
      return true;
    }

    let maxDiff = 0;
    for (let i = 0; i < 16; i++) {
      const diff = Math.abs(mvpMatrix[i] - this._lastFrustumMVP[i]);
      if (diff > maxDiff) maxDiff = diff;
    }

    const threshold = 0.001;

    if (maxDiff > threshold) {
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

  _updateCulledBuffer(visibleIndices) {
    const gl = this.gl;

    if (!this.buffers.culled) {
      this.buffers.culled = gl.createBuffer();
    }

    const pointCount = visibleIndices.length;
    const data = new Float32Array(pointCount * 7);

    const positions = this._positions;
    const colors = this._colors;
    const alphas = this._alphas;

    for (let i = 0; i < pointCount; i++) {
      const srcIdx = visibleIndices[i];
      const srcPosIdx = srcIdx * 3;
      const dstIdx = i * 7;

      data[dstIdx] = positions[srcPosIdx];
      data[dstIdx + 1] = positions[srcPosIdx + 1];
      data[dstIdx + 2] = positions[srcPosIdx + 2];
      data[dstIdx + 3] = colors[srcPosIdx];
      data[dstIdx + 4] = colors[srcPosIdx + 1];
      data[dstIdx + 5] = colors[srcPosIdx + 2];
      data[dstIdx + 6] = alphas[srcIdx];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.culled);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);

    this._culledPointCount = pointCount;
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

    // Bind VAO
    gl.bindVertexArray(this.vao);

    // Draw
    gl.drawArrays(gl.POINTS, 0, this.pointCount);

    gl.bindVertexArray(null);

    this.stats.visiblePoints = this.pointCount;
    this.stats.lodLevel = -1;
    this.stats.drawCalls = 1;
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

    // Bind VAO
    gl.bindVertexArray(lod.vao);

    gl.drawArrays(gl.POINTS, 0, lod.pointCount);

    gl.bindVertexArray(null);

    this.stats.visiblePoints = lod.pointCount;
    this.stats.lodLevel = lodLevel;
    this.stats.drawCalls = 1;
  }

  setAdaptiveLOD(enabled) {
    this.useAdaptiveLOD = enabled;
  }

  setFrustumCulling(enabled) {
    this.useFrustumCulling = enabled;
    console.log(`[HighPerfRenderer] Frustum culling ${enabled ? 'enabled' : 'disabled'}`);

    this._lastFrustumMVP = null;
    this._cachedCulledCount = 0;

    if (enabled && !this.octree && this.pointCount > 0 && this._positions) {
      console.log('[HighPerfRenderer] Building octree for frustum culling...');
      this.octree = new Octree(
        this._positions,
        this._colors,
        this._alphas,
        this.options.LOD_MAX_POINTS_PER_NODE
      );
      console.log(`[HighPerfRenderer] Octree built with ${this.octree.lodLevels.length} LOD levels`);
    }
  }

  getStats() {
    return { ...this.stats };
  }

  getLODLevelCount() {
    return this.lodBuffers.length;
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
    for (const vao of this.lodVaos) {
      gl.deleteVertexArray(vao);
    }

    for (const program of Object.values(this.programs)) {
      if (program) gl.deleteProgram(program);
    }

    this.buffers = {};
    this.lodBuffers = [];
    this.lodVaos = [];
    this.programs = {};
    this.octree = null;
  }
}

export default HighPerfRenderer;
