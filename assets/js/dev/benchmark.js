/**
 * PERFORMANCE BENCHMARK MODULE
 * ============================
 * Simple benchmark for testing scatterplot rendering limits.
 * Integrates with the existing viewer for easy testing.
 *
 * Uses HighPerfRenderer (WebGL2) for all benchmarking:
 * - Interleaved vertex buffers
 * - Level-of-Detail (LOD) with octree
 * - Frustum culling
 * - Lightweight shaders
 * - GPU-only fog
 */

import { HighPerfRenderer, RendererConfig, Octree } from '../rendering/high-perf-renderer.js';

/**
 * Benchmark configuration for high-performance renderer tests
 */
export const BenchmarkConfig = {
  // Quality presets
  QUALITY_FULL: 'full',           // Full lighting and fog
  QUALITY_LIGHT: 'light',         // Simplified lighting
  QUALITY_ULTRALIGHT: 'ultralight', // Maximum performance
  
  // Test scenarios
  TEST_LOD: 'lod',
  TEST_FRUSTUM_CULLING: 'frustum',
  TEST_INTERLEAVED: 'interleaved',
  TEST_SHADER_QUALITY: 'shader'
};

/**
 * High-Performance Renderer Benchmark Manager
 */
export class HighPerfBenchmark {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.isActive = false;
    this.testResults = [];
    
    // Configuration state
    this.config = {
      useLOD: true,
      useFrustumCulling: false,
      useInterleavedBuffers: true,
      shaderQuality: 'full',
      forceLODLevel: -1  // -1 = auto
    };
  }
  
  /**
   * Initialize the high-performance renderer
   * @param {Object} options - Optional configuration including gl context
   */
  init(options = {}) {
    if (this.renderer) {
      this.renderer.dispose();
    }
    
    this.renderer = new HighPerfRenderer(this.canvas, {
      gl: options.gl,  // Allow passing existing GL context
      USE_LOD: this.config.useLOD,
      USE_FRUSTUM_CULLING: this.config.useFrustumCulling,
      USE_INTERLEAVED_BUFFERS: this.config.useInterleavedBuffers
    });
    
    this.renderer.setQuality(this.config.shaderQuality);
    this.isActive = true;
    
    console.log('[HighPerfBenchmark] Renderer initialized:', {
      isWebGL2: this.renderer.isWebGL2,
      quality: this.config.shaderQuality
    });
    
    return this.renderer;
  }
  
  /**
   * Load data into the high-performance renderer
   */
  loadData(positions, colors) {
    if (!this.renderer) {
      this.init();
    }

    // Alpha is packed in colors as RGBA uint8 - no separate array needed
    const stats = this.renderer.loadData(positions, colors, {
      buildOctree: this.config.useLOD
    });

    console.log('[HighPerfBenchmark] Data loaded:', stats);
    return stats;
  }
  
  /**
   * Configure LOD settings
   */
  setLODEnabled(enabled) {
    this.config.useLOD = enabled;
    if (this.renderer) {
      this.renderer.setAdaptiveLOD(enabled);
    }
  }
  
  /**
   * Force a specific LOD level (-1 = auto)
   */
  setForceLODLevel(level) {
    this.config.forceLODLevel = level;
  }
  
  /**
   * Configure frustum culling
   */
  setFrustumCullingEnabled(enabled) {
    this.config.useFrustumCulling = enabled;
    if (this.renderer) {
      this.renderer.setFrustumCulling(enabled);
    }
  }
  
  /**
   * Set shader quality level
   */
  setShaderQuality(quality) {
    this.config.shaderQuality = quality;
    if (this.renderer) {
      this.renderer.setQuality(quality);
    }
  }
  
  /**
   * Render a frame using the high-performance renderer
   */
  render(params) {
    if (!this.renderer || !this.isActive) {
      return null;
    }
    
    // Add force LOD level to params
    const renderParams = {
      ...params,
      forceLOD: this.config.forceLODLevel,
      quality: this.config.shaderQuality
    };
    
    return this.renderer.render(renderParams);
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    if (!this.renderer) {
      return null;
    }
    return this.renderer.getStats();
  }
  
  /**
   * Get LOD level information
   */
  getLODInfo() {
    if (!this.renderer || !this.renderer.octree) {
      return null;
    }
    
    return {
      levelCount: this.renderer.getLODLevelCount(),
      levels: this.renderer.lodBuffers.map((lod, i) => ({
        level: i,
        pointCount: lod.pointCount,
        depth: lod.depth
      }))
    };
  }
  
  /**
   * Run a comprehensive benchmark test
   */
  async runBenchmarkSuite(pointCount, onProgress) {
    const results = [];
    
    // Test 1: Standard quality
    if (onProgress) onProgress('Testing full quality...');
    this.setShaderQuality('full');
    results.push(await this._runTimedTest('Full Quality', 60));
    
    // Test 2: Light quality
    if (onProgress) onProgress('Testing light quality...');
    this.setShaderQuality('light');
    results.push(await this._runTimedTest('Light Quality', 60));
    
    // Test 3: Ultralight quality
    if (onProgress) onProgress('Testing ultralight quality...');
    this.setShaderQuality('ultralight');
    results.push(await this._runTimedTest('Ultralight Quality', 60));
    
    // Test 4: LOD disabled
    if (onProgress) onProgress('Testing without LOD...');
    this.setLODEnabled(false);
    this.setShaderQuality('full');
    results.push(await this._runTimedTest('No LOD', 60));
    
    // Test 5: LOD enabled
    if (onProgress) onProgress('Testing with LOD...');
    this.setLODEnabled(true);
    results.push(await this._runTimedTest('With LOD', 60));
    
    this.testResults = results;
    return results;
  }
  
  async _runTimedTest(name, frames) {
    return new Promise((resolve) => {
      const frameTimes = [];
      let frameCount = 0;
      
      const measure = () => {
        if (frameCount >= frames) {
          const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
          const fps = 1000 / avg;
          resolve({
            name,
            avgFrameTime: avg.toFixed(2),
            fps: Math.round(fps),
            frames: frameCount
          });
          return;
        }
        
        const stats = this.getStats();
        if (stats) {
          frameTimes.push(stats.lastFrameTime);
        }
        frameCount++;
        requestAnimationFrame(measure);
      };
      
      requestAnimationFrame(measure);
    });
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.isActive = false;
  }
}

/**
 * GLB (GLTF Binary) Parser for extracting mesh geometry
 */
export class GLBParser {
  /**
   * Parse a GLB file and extract mesh data
   * @param {ArrayBuffer} buffer - The GLB file data
   * @returns {Object} - { positions: Float32Array, indices: Uint32Array, normals?: Float32Array }
   */
  static parse(buffer) {
    const view = new DataView(buffer);

    // GLB Header (12 bytes)
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) { // 'glTF'
      throw new Error('Invalid GLB magic number');
    }

    const version = view.getUint32(4, true);
    if (version !== 2) {
      throw new Error(`Unsupported GLB version: ${version}`);
    }

    // Parse chunks
    let offset = 12;
    let jsonChunk = null;
    let binChunk = null;

    while (offset < buffer.byteLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const chunkData = buffer.slice(offset + 8, offset + 8 + chunkLength);

      if (chunkType === 0x4E4F534A) { // 'JSON'
        const decoder = new TextDecoder('utf-8');
        jsonChunk = JSON.parse(decoder.decode(chunkData));
      } else if (chunkType === 0x004E4942) { // 'BIN\0'
        binChunk = chunkData;
      }

      offset += 8 + chunkLength;
    }

    if (!jsonChunk || !binChunk) {
      throw new Error('GLB missing JSON or BIN chunk');
    }

    return this._extractMeshData(jsonChunk, binChunk);
  }

  static _extractMeshData(gltf, binBuffer) {
    const accessors = gltf.accessors;
    const bufferViews = gltf.bufferViews;

    // Helper to copy data to aligned buffer (avoids alignment issues)
    const copyToAligned = (srcBuffer, byteOffset, byteLength, TypedArrayClass) => {
      const srcView = new Uint8Array(srcBuffer, byteOffset, byteLength);
      const alignedBuffer = new ArrayBuffer(byteLength);
      new Uint8Array(alignedBuffer).set(srcView);
      return new TypedArrayClass(alignedBuffer);
    };

    // Collect all positions and indices from all meshes and primitives
    const allPositions = [];
    const allIndices = [];
    let vertexOffset = 0;

    for (const mesh of (gltf.meshes || [])) {
      for (const primitive of (mesh.primitives || [])) {
        const posAccessorIdx = primitive.attributes?.POSITION;
        if (posAccessorIdx === undefined) continue;

        const posAccessor = accessors[posAccessorIdx];
        const posView = bufferViews[posAccessor.bufferView];
        const posOffset = (posView.byteOffset || 0) + (posAccessor.byteOffset || 0);
        const posByteLength = posAccessor.count * 3 * 4;
        const positions = copyToAligned(binBuffer, posOffset, posByteLength, Float32Array);
        allPositions.push(positions);

        // Extract indices
        if (primitive.indices !== undefined) {
          const idxAccessor = accessors[primitive.indices];
          const idxView = bufferViews[idxAccessor.bufferView];
          const idxOffset = (idxView.byteOffset || 0) + (idxAccessor.byteOffset || 0);

          let indices;
          if (idxAccessor.componentType === 5123) { // UNSIGNED_SHORT
            const idxByteLength = idxAccessor.count * 2;
            const shortIndices = copyToAligned(binBuffer, idxOffset, idxByteLength, Uint16Array);
            indices = new Uint32Array(shortIndices);
          } else if (idxAccessor.componentType === 5125) { // UNSIGNED_INT
            const idxByteLength = idxAccessor.count * 4;
            indices = copyToAligned(binBuffer, idxOffset, idxByteLength, Uint32Array);
          } else if (idxAccessor.componentType === 5121) { // UNSIGNED_BYTE
            const byteIndices = new Uint8Array(binBuffer, idxOffset, idxAccessor.count);
            indices = new Uint32Array(byteIndices);
          }

          if (indices) {
            // Offset indices for merged mesh
            const offsetIndices = new Uint32Array(indices.length);
            for (let i = 0; i < indices.length; i++) {
              offsetIndices[i] = indices[i] + vertexOffset;
            }
            allIndices.push(offsetIndices);
          }
        }

        vertexOffset += posAccessor.count;
      }
    }

    if (allPositions.length === 0) {
      throw new Error('No meshes with positions found in GLB');
    }

    // Merge all positions
    const totalVertices = allPositions.reduce((sum, p) => sum + p.length, 0);
    const positions = new Float32Array(totalVertices);
    let offset = 0;
    for (const p of allPositions) {
      positions.set(p, offset);
      offset += p.length;
    }

    // Merge all indices
    let indices = null;
    if (allIndices.length > 0) {
      const totalIndices = allIndices.reduce((sum, i) => sum + i.length, 0);
      indices = new Uint32Array(totalIndices);
      offset = 0;
      for (const i of allIndices) {
        indices.set(i, offset);
        offset += i.length;
      }
    }

    console.log(`[GLBParser] Merged ${allPositions.length} primitives: ${positions.length / 3} vertices, ${indices ? indices.length / 3 : 0} triangles`);

    return { positions, indices, normals: null };
  }
}

/**
 * Surface sampler for generating points on mesh triangles
 */
export class MeshSurfaceSampler {
  constructor(positions, indices) {
    this.positions = positions;
    this.indices = indices;
    this.triangleCount = indices ? indices.length / 3 : positions.length / 9;

    // Compute triangle areas for weighted sampling
    this.areas = new Float32Array(this.triangleCount);
    this.cumulativeAreas = new Float32Array(this.triangleCount);
    this.totalArea = 0;

    this._computeAreas();
  }

  _computeAreas() {
    for (let i = 0; i < this.triangleCount; i++) {
      const [v0, v1, v2] = this._getTriangleVertices(i);

      // Cross product to get area
      const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
      const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;

      this.areas[i] = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
      this.totalArea += this.areas[i];
      this.cumulativeAreas[i] = this.totalArea;
    }
  }

  _getTriangleVertices(triIdx) {
    let i0, i1, i2;
    if (this.indices) {
      i0 = this.indices[triIdx * 3];
      i1 = this.indices[triIdx * 3 + 1];
      i2 = this.indices[triIdx * 3 + 2];
    } else {
      i0 = triIdx * 3;
      i1 = triIdx * 3 + 1;
      i2 = triIdx * 3 + 2;
    }

    return [
      [this.positions[i0 * 3], this.positions[i0 * 3 + 1], this.positions[i0 * 3 + 2]],
      [this.positions[i1 * 3], this.positions[i1 * 3 + 1], this.positions[i1 * 3 + 2]],
      [this.positions[i2 * 3], this.positions[i2 * 3 + 1], this.positions[i2 * 3 + 2]]
    ];
  }

  /**
   * Binary search to find triangle index
   */
  _binarySearchTriangle(r) {
    let lo = 0, hi = this.triangleCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cumulativeAreas[mid] < r) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Sample a random point on the mesh surface
   * @returns {Object} - { position: [x,y,z], normal: [nx,ny,nz] }
   */
  sample() {
    // Pick triangle weighted by area (binary search for speed)
    const r = Math.random() * this.totalArea;
    const triIdx = this._binarySearchTriangle(r);

    const [v0, v1, v2] = this._getTriangleVertices(triIdx);

    // Random barycentric coordinates
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;

    // Interpolate position
    const position = [
      w * v0[0] + u * v1[0] + v * v2[0],
      w * v0[1] + u * v1[1] + v * v2[1],
      w * v0[2] + u * v1[2] + v * v2[2]
    ];

    // Compute face normal
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const normal = [nx / len, ny / len, nz / len];

    return { position, normal };
  }
}

/**
 * Generate synthetic point cloud data
 */
export class SyntheticDataGenerator {

  /**
   * Generate octopus-like structure with body and tentacles
   */
  static octopus(count, numTentacles = 8) {
    console.log(`Generating ${count.toLocaleString()} points (octopus with ${numTentacles} tentacles)...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    // Body parameters
    const bodyRadius = 0.3;
    const bodyCenter = [0, 0.3, 0];
    const bodyFreq = 0.25; // 25% of points in body

    // Tentacle parameters
    const tentacleLength = 1.2;
    const tentacleThickness = 0.04;
    const tentacleWave = 0.15; // wave amplitude
    const tentacleFreq = (1 - bodyFreq) / numTentacles;

    // Body color (reddish-orange)
    const bodyColor = [0.9, 0.4, 0.3];

    // Generate tentacle base angles
    const tentacles = [];
    for (let t = 0; t < numTentacles; t++) {
      const baseAngle = (t / numTentacles) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const tiltAngle = Math.PI * 0.6 + (Math.random() - 0.5) * 0.3; // angle from vertical
      const hue = 0.02 + t * 0.02; // slight color variation per tentacle
      tentacles.push({ baseAngle, tiltAngle, hue });
    }

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const r = Math.random();

      if (r < bodyFreq) {
        // Body point - ellipsoid shape
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const radius = bodyRadius * Math.pow(Math.random(), 0.33);

        positions[idx] = bodyCenter[0] + radius * Math.sin(phi) * Math.cos(theta) * 1.2;
        positions[idx + 1] = bodyCenter[1] + radius * Math.cos(phi) * 0.8;
        positions[idx + 2] = bodyCenter[2] + radius * Math.sin(phi) * Math.sin(theta) * 1.2;

        // Body color with variation (convert to uint8)
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, bodyColor[0] + (Math.random() - 0.5) * 0.1)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, bodyColor[1] + (Math.random() - 0.5) * 0.1)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, bodyColor[2] + (Math.random() - 0.5) * 0.1)) * 255);
        colors[cidx + 3] = 255; // full alpha
      } else {
        // Tentacle point
        const tentacleIdx = Math.floor((r - bodyFreq) / tentacleFreq);
        const tent = tentacles[Math.min(tentacleIdx, numTentacles - 1)];

        // Position along tentacle (0 = base, 1 = tip)
        const t = Math.pow(Math.random(), 0.7); // more points near base
        const thickness = tentacleThickness * (1 - t * 0.7); // thinner at tip

        // Base position where tentacle attaches to body
        const baseX = bodyCenter[0] + bodyRadius * 0.8 * Math.sin(tent.tiltAngle) * Math.cos(tent.baseAngle);
        const baseY = bodyCenter[1] - bodyRadius * 0.5;
        const baseZ = bodyCenter[2] + bodyRadius * 0.8 * Math.sin(tent.tiltAngle) * Math.sin(tent.baseAngle);

        // Tentacle curves downward and outward with wave
        const wave1 = Math.sin(t * Math.PI * 3) * tentacleWave * t;
        const wave2 = Math.cos(t * Math.PI * 2.5) * tentacleWave * t * 0.5;

        const tentX = baseX + t * tentacleLength * Math.sin(tent.tiltAngle) * Math.cos(tent.baseAngle) + wave1;
        const tentY = baseY - t * tentacleLength * 0.8;
        const tentZ = baseZ + t * tentacleLength * Math.sin(tent.tiltAngle) * Math.sin(tent.baseAngle) + wave2;

        // Add thickness
        const thickAngle = Math.random() * Math.PI * 2;
        const thickR = Math.sqrt(Math.random()) * thickness;

        positions[idx] = tentX + thickR * Math.cos(thickAngle);
        positions[idx + 1] = tentY + thickR * Math.sin(thickAngle) * 0.5;
        positions[idx + 2] = tentZ + thickR * Math.sin(thickAngle);

        // Tentacle color - gradient from body color to darker at tips (convert to uint8)
        const tentColor = this._hslToRgb(tent.hue, 0.7, 0.5 - t * 0.2);
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, tentColor[0] + (Math.random() - 0.5) * 0.08)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, tentColor[1] + (Math.random() - 0.5) * 0.08)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, tentColor[2] + (Math.random() - 0.5) * 0.08)) * 255);
        colors[cidx + 3] = 255; // full alpha
      }
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors };
  }

  /**
   * Generate 3D spiral/helix structures
   */
  static spirals(count, numSpirals = 5) {
    console.log(`Generating ${count.toLocaleString()} points (${numSpirals} spirals)...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    // Generate spiral configurations
    const spiralConfigs = [];
    for (let s = 0; s < numSpirals; s++) {
      spiralConfigs.push({
        // Starting position
        startX: (Math.random() - 0.5) * 1.5,
        startY: (Math.random() - 0.5) * 1.5,
        startZ: (Math.random() - 0.5) * 1.5,
        // Direction (normalized)
        dirTheta: Math.random() * Math.PI * 2,
        dirPhi: Math.random() * Math.PI,
        // Spiral parameters
        radius: 0.1 + Math.random() * 0.2,
        length: 0.8 + Math.random() * 1.2,
        turns: 2 + Math.random() * 4,
        thickness: 0.02 + Math.random() * 0.03,
        // Color
        hue: s / numSpirals,
        // Taper
        taper: Math.random() < 0.5
      });
    }

    const pointsPerSpiral = Math.floor(count / numSpirals);

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const spiralIdx = Math.min(Math.floor(i / pointsPerSpiral), numSpirals - 1);
      const sp = spiralConfigs[spiralIdx];

      // Position along spiral (0-1)
      const t = Math.random();

      // Direction vectors
      const dirX = Math.sin(sp.dirPhi) * Math.cos(sp.dirTheta);
      const dirY = Math.cos(sp.dirPhi);
      const dirZ = Math.sin(sp.dirPhi) * Math.sin(sp.dirTheta);

      // Perpendicular vectors for spiral
      const perpX = -Math.sin(sp.dirTheta);
      const perpZ = Math.cos(sp.dirTheta);
      const perp2X = -Math.cos(sp.dirPhi) * Math.cos(sp.dirTheta);
      const perp2Y = Math.sin(sp.dirPhi);
      const perp2Z = -Math.cos(sp.dirPhi) * Math.sin(sp.dirTheta);

      // Spiral angle
      const angle = t * sp.turns * Math.PI * 2;
      const radius = sp.taper ? sp.radius * (1 - t * 0.5) : sp.radius;

      // Position on spiral
      const spiralX = sp.startX + t * sp.length * dirX + radius * (Math.cos(angle) * perpX + Math.sin(angle) * perp2X);
      const spiralY = sp.startY + t * sp.length * dirY + radius * Math.sin(angle) * perp2Y;
      const spiralZ = sp.startZ + t * sp.length * dirZ + radius * (Math.cos(angle) * perpZ + Math.sin(angle) * perp2Z);

      // Add thickness
      const thick = sp.thickness * (sp.taper ? (1 - t * 0.3) : 1);
      positions[idx] = spiralX + this._gaussianRandom() * thick;
      positions[idx + 1] = spiralY + this._gaussianRandom() * thick;
      positions[idx + 2] = spiralZ + this._gaussianRandom() * thick;

      // Color gradient along spiral (convert to uint8)
      const color = this._hslToRgb(sp.hue + t * 0.1, 0.75, 0.45 + t * 0.15);
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, color[0] + (Math.random() - 0.5) * 0.08)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, color[1] + (Math.random() - 0.5) * 0.08)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, color[2] + (Math.random() - 0.5) * 0.08)) * 255);
      colors[cidx + 3] = 255; // full alpha
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors };
  }

  /**
   * Generate 2D UMAP-like flat structure with clusters
   */
  static flatUMAP(count, numClusters = 25) {
    console.log(`Generating ${count.toLocaleString()} points (2D UMAP, ${numClusters} clusters)...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    // Z-axis scale (nearly flat)
    const zScale = 0.02;

    // Generate cluster configurations
    const clusters = [];
    for (let c = 0; c < numClusters; c++) {
      // Use force-directed-like placement to avoid overlap
      let cx, cy, attempts = 0;
      do {
        cx = (Math.random() - 0.5) * 1.8;
        cy = (Math.random() - 0.5) * 1.8;
        attempts++;
      } while (attempts < 50 && clusters.some(cl =>
        Math.hypot(cl.center[0] - cx, cl.center[1] - cy) < 0.2
      ));

      const isElongated = Math.random() < 0.4;
      const angle = Math.random() * Math.PI;

      clusters.push({
        center: [cx, cy],
        spread: 0.04 + Math.random() * 0.08,
        elongation: isElongated ? [1.5 + Math.random(), 0.4 + Math.random() * 0.3] : [1, 1],
        angle: angle,
        color: this._hslToRgb(c / numClusters, 0.7, 0.5),
        weight: 0.5 + Math.random() * 1.5
      });
    }

    // Add some bridge/stream populations
    const numBridges = Math.floor(numClusters * 0.2);
    for (let b = 0; b < numBridges; b++) {
      const c1 = clusters[Math.floor(Math.random() * numClusters)];
      const c2 = clusters[Math.floor(Math.random() * numClusters)];
      if (c1 !== c2) {
        clusters.push({
          center: [(c1.center[0] + c2.center[0]) / 2, (c1.center[1] + c2.center[1]) / 2],
          spread: 0.02,
          isBridge: true,
          bridgeFrom: c1.center,
          bridgeTo: c2.center,
          color: [
            (c1.color[0] + c2.color[0]) / 2,
            (c1.color[1] + c2.color[1]) / 2,
            (c1.color[2] + c2.color[2]) / 2
          ],
          weight: 0.2
        });
      }
    }

    // Normalize weights
    const totalWeight = clusters.reduce((s, c) => s + c.weight, 0);
    clusters.forEach(c => c.weight /= totalWeight);

    // Build cumulative distribution
    let cumulative = 0;
    const cumDist = clusters.map(c => {
      cumulative += c.weight;
      return cumulative;
    });

    for (let i = 0; i < count; i++) {
      const idx = i * 3;

      // Sample cluster
      const r = Math.random();
      let clusterIdx = cumDist.findIndex(c => r <= c);
      if (clusterIdx < 0) clusterIdx = clusters.length - 1;
      const cluster = clusters[clusterIdx];

      let x, y;

      if (cluster.isBridge) {
        // Bridge point
        const t = Math.random();
        x = cluster.bridgeFrom[0] + t * (cluster.bridgeTo[0] - cluster.bridgeFrom[0]);
        y = cluster.bridgeFrom[1] + t * (cluster.bridgeTo[1] - cluster.bridgeFrom[1]);
        x += this._gaussianRandom() * cluster.spread;
        y += this._gaussianRandom() * cluster.spread;
      } else {
        // Regular cluster point with elongation
        let dx = this._gaussianRandom() * cluster.spread * cluster.elongation[0];
        let dy = this._gaussianRandom() * cluster.spread * cluster.elongation[1];
        // Rotate by cluster angle
        const cos = Math.cos(cluster.angle);
        const sin = Math.sin(cluster.angle);
        x = cluster.center[0] + dx * cos - dy * sin;
        y = cluster.center[1] + dx * sin + dy * cos;
      }

      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = 0; // Keep perfectly flat for true 2D

      // Color (convert to uint8)
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, cluster.color[0] + (Math.random() - 0.5) * 0.06)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, cluster.color[1] + (Math.random() - 0.5) * 0.06)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, cluster.color[2] + (Math.random() - 0.5) * 0.06)) * 255);
      colors[cidx + 3] = 255; // full alpha
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors };
  }

  /**
   * Generate atlas-like data with multiscale clusters, bridges, and batches.
   * Designed to look closer to real embeddings while stressing LOD/culling.
   */
  static atlasLike(count, options = {}) {
    const {
      batches = 3,
      cellTypes = Math.max(16, Math.floor(count / 3500)),
      trajectoryFraction = 0.22,
      rareFraction = 0.05,
      layerDepth = 0.35,
      strongBatchEffects = false,
      label = 'Atlas-like (multiscale clusters)'
    } = options;

    console.log(`Generating ${count.toLocaleString()} points (${label})...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const safeCellTypes = Math.max(12, Math.min(45, Math.floor(cellTypes)));
    const trajFrac = clamp01(Math.min(0.35, trajectoryFraction));
    const rareFrac = clamp01(Math.min(0.12, rareFraction));
    const anchorFrac = clamp01(1 - trajFrac - rareFrac);
    const goldenAngle = 2.399963229728653; // Poisson-disc-ish polar layout

    // Batch offsets to simulate lab/batch shifts
    const batchOffsets = Array.from({ length: Math.max(1, Math.floor(batches)) }, () => ({
      offset: [
        (Math.random() - 0.5) * (strongBatchEffects ? 0.45 : 0.18),
        (Math.random() - 0.5) * (strongBatchEffects ? 0.35 : 0.14),
        (Math.random() - 0.5) * (strongBatchEffects ? 0.55 : 0.22)
      ],
      tint: (Math.random() - 0.5) * (strongBatchEffects ? 0.18 : 0.08)
    }));

    // Build anchor clusters arranged on a loose ring
    const anchors = [];
    for (let i = 0; i < safeCellTypes; i++) {
      const angle = i * goldenAngle + (Math.random() - 0.5) * 0.1;
      const radius = 0.25 + Math.random() * 1.15;
      const layer = ((i % 3) - 1) * layerDepth * 0.5;
      const center = [
        Math.cos(angle) * radius + (Math.random() - 0.5) * 0.1,
        Math.sin(angle) * radius + (Math.random() - 0.5) * 0.1,
        layer
      ];
      const major = 0.025 + Math.random() * 0.05;
      const minor = major * (0.55 + Math.random() * 0.9);
      const theta = Math.random() * Math.PI;
      const color = this._hslToRgb(i / safeCellTypes, 0.68, 0.52);
      const weight = 0.6 + Math.random() * 1.6;

      anchors.push({
        center,
        spread: [major, minor],
        angle: theta,
        color,
        weight,
        layerOffset: layer + (Math.random() - 0.5) * 0.08,
        sin: Math.sin(theta),
        cos: Math.cos(theta)
      });
    }

    const anchorWeightTotal = anchors.reduce((s, a) => s + a.weight, 0);
    let anchorCum = 0;
    const anchorCumDist = anchors.map((a) => {
      anchorCum += a.weight / anchorWeightTotal;
      return anchorCum;
    });

    // Trajectories between anchors (branchy manifolds)
    const trajectoryCount = Math.max(5, Math.floor(safeCellTypes * 0.45));
    const trajectories = [];
    for (let t = 0; t < trajectoryCount; t++) {
      const a = anchors[Math.floor(Math.random() * anchors.length)];
      let b = anchors[Math.floor(Math.random() * anchors.length)];
      if (a === b) b = anchors[(anchors.indexOf(a) + 1) % anchors.length];

      const midX = (a.center[0] + b.center[0]) / 2 + (Math.random() - 0.5) * 0.25;
      const midY = (a.center[1] + b.center[1]) / 2 + (Math.random() - 0.5) * 0.25;
      const arch = (Math.random() - 0.5) * 0.25;

      const spread = 0.015 + Math.random() * 0.03;
      const weight = 0.4 + Math.random() * 1.1;

      trajectories.push({
        from: a,
        to: b,
        control: [midX, midY, (a.layerOffset + b.layerOffset) / 2 + arch],
        spread,
        weight
      });
    }

    const trajWeightTotal = trajectories.reduce((s, tr) => s + tr.weight, 0);
    let trajCum = 0;
    const trajCumDist = trajectories.map((tr) => {
      trajCum += tr.weight / trajWeightTotal;
      return trajCum;
    });

    const pickAnchor = () => {
      const r = Math.random();
      let idx = anchorCumDist.findIndex((c) => r <= c);
      if (idx < 0) idx = anchors.length - 1;
      return anchors[idx];
    };

    const pickTrajectory = () => {
      const r = Math.random();
      let idx = trajCumDist.findIndex((c) => r <= c);
      if (idx < 0) idx = trajectories.length - 1;
      return trajectories[idx];
    };

    const anchorPoints = Math.floor(count * anchorFrac);
    const trajectoryPoints = Math.floor(count * trajFrac);
    const rarePoints = count - anchorPoints - trajectoryPoints;

    // Anchor clusters
    for (let i = 0; i < anchorPoints; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(Math.random() * batchOffsets.length)];
      const anchor = pickAnchor();

      const dx = this._gaussianRandom() * anchor.spread[0];
      const dy = this._gaussianRandom() * anchor.spread[1];

      positions[idx] = anchor.center[0] + dx * anchor.cos - dy * anchor.sin + batch.offset[0];
      positions[idx + 1] = anchor.center[1] + dx * anchor.sin + dy * anchor.cos + batch.offset[1];
      positions[idx + 2] = anchor.layerOffset + this._gaussianRandom() * 0.03 + batch.offset[2];

      const baseColor = anchor.color;
      const shade = (Math.random() - 0.5) * 0.08 + batch.tint;
      const cidx = i * 4;
      colors[cidx] = Math.round(clamp01(baseColor[0] + shade) * 255);
      colors[cidx + 1] = Math.round(clamp01(baseColor[1] + shade * 0.6) * 255);
      colors[cidx + 2] = Math.round(clamp01(baseColor[2] - shade * 0.6) * 255);
      colors[cidx + 3] = 255;
    }

    // Trajectory / bridge populations
    for (let i = anchorPoints; i < anchorPoints + trajectoryPoints; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(Math.random() * batchOffsets.length)];
      const traj = pickTrajectory();
      const t = Math.random();
      const eased = t * t * (3 - 2 * t); // smoothstep for nicer density
      const inv = 1 - eased;

      const px = inv * inv * traj.from.center[0] + 2 * inv * eased * traj.control[0] + eased * eased * traj.to.center[0];
      const py = inv * inv * traj.from.center[1] + 2 * inv * eased * traj.control[1] + eased * eased * traj.to.center[1];
      const pz = inv * inv * traj.from.layerOffset + 2 * inv * eased * traj.control[2] + eased * eased * traj.to.layerOffset;

      positions[idx] = px + this._gaussianRandom() * traj.spread + batch.offset[0] * 0.6;
      positions[idx + 1] = py + this._gaussianRandom() * traj.spread + batch.offset[1] * 0.6;
      positions[idx + 2] = pz + this._gaussianRandom() * traj.spread * 0.6 + batch.offset[2] * 0.8;

      const mixColor = [
        traj.from.color[0] * (1 - eased) + traj.to.color[0] * eased,
        traj.from.color[1] * (1 - eased) + traj.to.color[1] * eased,
        traj.from.color[2] * (1 - eased) + traj.to.color[2] * eased
      ];
      const shade = (Math.random() - 0.5) * 0.06 + batch.tint * 0.6;
      const cidx = i * 4;
      colors[cidx] = Math.round(clamp01(mixColor[0] + shade) * 255);
      colors[cidx + 1] = Math.round(clamp01(mixColor[1] + shade * 0.6) * 255);
      colors[cidx + 2] = Math.round(clamp01(mixColor[2] - shade * 0.4) * 255);
      colors[cidx + 3] = 255;
    }

    // Rare micro-clusters and outliers to stress LOD/culling
    for (let i = anchorPoints + trajectoryPoints; i < count; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(Math.random() * batchOffsets.length)];

      if (Math.random() < 0.7) {
        const anchor = pickAnchor();
        const radius = anchor.spread[0] * (0.2 + Math.random() * 0.4);
        const theta = Math.random() * Math.PI * 2;
        positions[idx] = anchor.center[0] + Math.cos(theta) * radius + batch.offset[0] * (strongBatchEffects ? 1 : 0.4);
        positions[idx + 1] = anchor.center[1] + Math.sin(theta) * radius + batch.offset[1] * (strongBatchEffects ? 1 : 0.4);
        positions[idx + 2] = anchor.layerOffset + this._gaussianRandom() * 0.02 + batch.offset[2];

        const cidx = i * 4;
        const shade = 0.1 + (Math.random() - 0.5) * 0.08 + batch.tint;
        colors[cidx] = Math.round(clamp01(anchor.color[0] + shade) * 255);
        colors[cidx + 1] = Math.round(clamp01(anchor.color[1] + shade * 0.5) * 255);
        colors[cidx + 2] = Math.round(clamp01(anchor.color[2] - shade * 0.5) * 255);
        colors[cidx + 3] = 255;
      } else {
        // Far outlier
        positions[idx] = (Math.random() - 0.5) * 3 + batch.offset[0] * 0.5;
        positions[idx + 1] = (Math.random() - 0.5) * 3 + batch.offset[1] * 0.5;
        positions[idx + 2] = (Math.random() - 0.5) * (strongBatchEffects ? 2 : 1) + batch.offset[2] * 0.7;

        const cidx = i * 4;
        const base = this._hslToRgb(Math.random(), 0.2, 0.55);
        colors[cidx] = Math.round(clamp01(base[0]) * 255);
        colors[cidx + 1] = Math.round(clamp01(base[1]) * 255);
        colors[cidx + 2] = Math.round(clamp01(base[2]) * 255);
        colors[cidx + 3] = 200 + Math.floor(Math.random() * 55); // slight transparency variance
      }
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors };
  }

  /**
   * Variant of atlasLike with intentionally strong batch shifts for stress tests.
   */
  static batchEffects(count, batches = 4) {
    return this.atlasLike(count, {
      batches,
      strongBatchEffects: true,
      trajectoryFraction: 0.18,
      rareFraction: 0.06,
      layerDepth: 0.65,
      label: 'Batch effects (misaligned batches)'
    });
  }

  /**
   * Generate Gaussian clusters (100-200 clusters by default)
   */
  static gaussianClusters(count, numClusters = 150, clusterSpread = 0.06) {
    // Random number of clusters between 100-200 if using default
    const actualClusters = numClusters === 150 ? 100 + Math.floor(Math.random() * 100) : numClusters;
    console.log(`Generating ${count.toLocaleString()} points in ${actualClusters} clusters...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    // Generate cluster centers with varying sizes
    const clusters = [];
    for (let c = 0; c < actualClusters; c++) {
      // Random position in 3D space
      const center = [
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2
      ];
      // Random cluster size (some big, some small)
      const size = clusterSpread * (0.5 + Math.random() * 1.5);
      // Random elongation
      const elongation = [
        0.5 + Math.random() * 1.0,
        0.5 + Math.random() * 1.0,
        0.5 + Math.random() * 1.0
      ];
      // Color based on position for spatial coherence
      const hue = (Math.atan2(center[1], center[0]) / Math.PI + 1) / 2;
      const sat = 0.5 + center[2] * 0.25;
      const color = this._hslToRgb(hue, Math.max(0.4, Math.min(0.9, sat)), 0.5);
      // Random weight (frequency)
      const weight = 0.5 + Math.random() * 1.5;

      clusters.push({ center, size, elongation, color, weight });
    }

    // Normalize weights
    const totalWeight = clusters.reduce((s, c) => s + c.weight, 0);
    clusters.forEach(c => c.weight /= totalWeight);

    // Build cumulative distribution
    let cumulative = 0;
    const cumDist = clusters.map(c => {
      cumulative += c.weight;
      return cumulative;
    });

    for (let i = 0; i < count; i++) {
      const idx = i * 3;

      // Sample cluster based on weight
      const r = Math.random();
      let clusterIdx = cumDist.findIndex(c => r <= c);
      if (clusterIdx < 0) clusterIdx = actualClusters - 1;

      const cluster = clusters[clusterIdx];

      positions[idx] = cluster.center[0] + this._gaussianRandom() * cluster.size * cluster.elongation[0];
      positions[idx + 1] = cluster.center[1] + this._gaussianRandom() * cluster.size * cluster.elongation[1];
      positions[idx + 2] = cluster.center[2] + this._gaussianRandom() * cluster.size * cluster.elongation[2];

      // Convert to uint8
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, cluster.color[0] + (Math.random() - 0.5) * 0.1)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, cluster.color[1] + (Math.random() - 0.5) * 0.1)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, cluster.color[2] + (Math.random() - 0.5) * 0.1)) * 255);
      colors[cidx + 3] = 255; // full alpha
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);

    return { positions, colors };
  }

  /**
   * Generate uniform random distribution
   */
  static uniformRandom(count, scale = 2.0) {
    console.log(`Generating ${count.toLocaleString()} random points...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    for (let i = 0; i < count; i++) {
      const idx = i * 3;

      positions[idx] = (Math.random() - 0.5) * scale * 2;
      positions[idx + 1] = (Math.random() - 0.5) * scale * 2;
      positions[idx + 2] = (Math.random() - 0.5) * scale * 2;

      const cidx = i * 4;
      colors[cidx] = Math.floor(Math.random() * 256);
      colors[cidx + 1] = Math.floor(Math.random() * 256);
      colors[cidx + 2] = Math.floor(Math.random() * 256);
      colors[cidx + 3] = 255; // full alpha
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);

    return { positions, colors };
  }
  
  /**
   * Generate points by sampling from a GLB mesh surface
   * @param {number} count - Number of points to generate
   * @param {ArrayBuffer} glbBuffer - The loaded GLB file as ArrayBuffer
   * @returns {Object} - { positions: Float32Array, colors: Uint8Array (RGBA) }
   */
  static fromGLB(count, glbBuffer) {
    console.log(`[GLB] Sampling ${count.toLocaleString()} points from GLB mesh...`);
    const startTime = performance.now();

    // Parse GLB
    console.log('[GLB] Parsing GLB file...');
    const meshData = GLBParser.parse(glbBuffer);
    console.log(`[GLB] Parsed: ${meshData.positions.length / 3} vertices, ${meshData.indices ? meshData.indices.length / 3 : 'no'} triangles (${(performance.now() - startTime).toFixed(0)}ms)`);

    // Create sampler
    console.log('[GLB] Building surface sampler...');
    const sampler = new MeshSurfaceSampler(meshData.positions, meshData.indices);
    console.log(`[GLB] Sampler ready: ${sampler.triangleCount} triangles, area=${sampler.totalArea.toFixed(4)} (${(performance.now() - startTime).toFixed(0)}ms)`);

    // Compute bounding box for normalization
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (let i = 0; i < meshData.positions.length; i += 3) {
      minX = Math.min(minX, meshData.positions[i]);
      maxX = Math.max(maxX, meshData.positions[i]);
      minY = Math.min(minY, meshData.positions[i + 1]);
      maxY = Math.max(maxY, meshData.positions[i + 1]);
      minZ = Math.min(minZ, meshData.positions[i + 2]);
      maxZ = Math.max(maxZ, meshData.positions[i + 2]);
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const scale = 2.0 / Math.max(maxX - minX, maxY - minY, maxZ - minZ);

    // Sample points
    console.log('[GLB] Sampling points...');
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8
    const logInterval = Math.max(100000, Math.floor(count / 10));

    for (let i = 0; i < count; i++) {
      if (i > 0 && i % logInterval === 0) {
        console.log(`[GLB] Sampled ${(i / 1000).toFixed(0)}K / ${(count / 1000).toFixed(0)}K points...`);
      }

      const sample = sampler.sample();
      const idx = i * 3;

      // Center and scale to fit in [-1, 1] range
      positions[idx] = (sample.position[0] - centerX) * scale;
      positions[idx + 1] = (sample.position[1] - centerY) * scale;
      positions[idx + 2] = (sample.position[2] - centerZ) * scale;

      // Color based on normal direction (hemisphere coloring)
      const nx = sample.normal[0];
      const ny = sample.normal[1];
      const nz = sample.normal[2];

      // Convert normal to color (warm/cool scheme)
      const warmCool = (ny + 1) * 0.5;
      const hue = 0.55 - warmCool * 0.4;
      const sat = 0.6 + Math.abs(nz) * 0.2;
      const light = 0.45 + Math.abs(nx) * 0.15;

      const color = this._hslToRgb(hue, sat, light);

      // Add slight noise for visual interest (convert to uint8)
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, color[0] + (Math.random() - 0.5) * 0.05)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, color[1] + (Math.random() - 0.5) * 0.05)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, color[2] + (Math.random() - 0.5) * 0.05)) * 255);
      colors[cidx + 3] = 255; // full alpha
    }

    const elapsed = performance.now() - startTime;
    console.log(`[GLB] Done! Sampled ${count.toLocaleString()} points in ${elapsed.toFixed(0)}ms`);

    return { positions, colors };
  }

  /**
   * Load GLB file from URL and sample points
   * @param {number} count - Number of points to generate
   * @param {string} url - URL to the GLB file
   * @returns {Promise<Object>} - { positions: Float32Array, colors: Uint8Array (RGBA) }
   */
  static async fromGLBUrl(count, url = 'assets/img/kemal-inecik.glb') {
    console.log(`Loading GLB from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load GLB: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    console.log(`GLB loaded: ${(buffer.byteLength / 1024).toFixed(1)} KB`);
    return this.fromGLB(count, buffer);
  }

  static _gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  static _hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [r, g, b];
  }
}

/**
 * Performance Statistics Tracker
 */
export class PerformanceTracker {
  constructor() {
    this.frameTimes = [];
    this.maxSamples = 120;
    this.lastTime = 0;
    this.running = false;
  }
  
  start() {
    this.frameTimes = [];
    this.lastTime = performance.now();
    this.running = true;
  }
  
  recordFrame() {
    if (!this.running) return null;
    
    const now = performance.now();
    const frameTime = now - this.lastTime;
    this.lastTime = now;
    
    // Skip first frame (usually longer)
    if (this.frameTimes.length > 0 || frameTime < 100) {
      this.frameTimes.push(frameTime);
      if (this.frameTimes.length > this.maxSamples) {
        this.frameTimes.shift();
      }
    }
    
    return this.getStats();
  }
  
  stop() {
    this.running = false;
  }
  
  getStats() {
    if (this.frameTimes.length === 0) {
      return { fps: 0, avgFrameTime: 0, minFrameTime: 0, maxFrameTime: 0, samples: 0 };
    }
    
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    
    return {
      fps: Math.round(1000 / avg),
      avgFrameTime: avg.toFixed(2),
      minFrameTime: sorted[0].toFixed(2),
      maxFrameTime: sorted[sorted.length - 1].toFixed(2),
      p95FrameTime: sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2) || '0',
      samples: sorted.length
    };
  }
}

/**
 * Build a copy-ready situation report with environment + renderer state.
 * Designed to work for both real data and synthetic benchmarks.
 */
export class BenchmarkReporter {
  constructor({ viewer, state, canvas } = {}) {
    this.viewer = viewer;
    this.state = state;
    this.canvas = canvas;
  }

  _getGL() {
    if (this.viewer && typeof this.viewer.getGLContext === 'function') {
      return this.viewer.getGLContext();
    }
    if (this.canvas && typeof this.canvas.getContext === 'function') {
      return this.canvas.getContext('webgl2') || this.canvas.getContext('webgl');
    }
    return null;
  }

  _collectEnvironment(gl) {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const scr = typeof screen !== 'undefined' ? screen : {};
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    const timezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return null;
      }
    })();
    const brands = nav.userAgentData?.brands?.map((b) => b.brand).join(', ');
    const ua = nav.userAgent || '';

    // Heuristic architecture detection
    const uaLower = ua.toLowerCase();
    const platformLower = (nav.userAgentData?.platform || nav.platform || '').toLowerCase();
    const isArmLike = /arm|aarch64/.test(uaLower) || /arm|aarch64/.test(platformLower);
    const isApple = /mac/.test(platformLower) || /mac/.test(uaLower);
    const appleSiliconHint = /apple\s*m[0-9]/i.test(ua) ||
      (nav.userAgentData?.platform === 'macOS' && isArmLike);
    const arch = isArmLike ? 'arm64' : /win|intel|x86|amd64/.test(uaLower + platformLower) ? 'x86_64' : 'unknown';

    // JS heap usage (Chrome only)
    let jsHeap = null;
    if (typeof performance !== 'undefined' && performance.memory) {
      const mem = performance.memory;
      jsHeap = {
        usedMB: mem.usedJSHeapSize ? +(mem.usedJSHeapSize / 1024 / 1024).toFixed(1) : null,
        totalMB: mem.totalJSHeapSize ? +(mem.totalJSHeapSize / 1024 / 1024).toFixed(1) : null,
        limitMB: mem.jsHeapSizeLimit ? +(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(1) : null,
        source: 'performance.memory'
      };
    }

    const env = {
      browser: brands || nav.userAgent || 'unknown',
      browserUA: nav.userAgent || null,
      platform: nav.userAgentData?.platform || nav.platform || 'unknown',
      language: nav.language || (nav.languages && nav.languages[0]) || null,
      hardwareConcurrency: nav.hardwareConcurrency || null,
      deviceMemory: nav.deviceMemory || null,
      pixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
      screen: { width: scr.width, height: scr.height },
      connection: connection ? (connection.effectiveType || connection.type || null) : null,
      maxTouchPoints: nav.maxTouchPoints || 0,
      timezone: timezone || null,
      arch,
      isApple,
      appleSiliconHint: Boolean(appleSiliconHint),
      jsHeap
    };

    if (gl) {
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugExt ? gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const vendor = debugExt ? gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const shadingLanguage = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('WEBGL_color_buffer_float');
      const floatTextures = colorBufferFloat || gl.getExtension('OES_texture_float') || gl.getExtension('OES_texture_half_float');
      const anisoExt =
        gl.getExtension('EXT_texture_filter_anisotropic') ||
        gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
        gl.getExtension('MOZ_EXT_texture_filter_anisotropic');

      env.webgl = {
        version: (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) ? 'WebGL2' : 'WebGL1',
        renderer: renderer || null,
        vendor: vendor || null,
        shadingLanguage: shadingLanguage || null,
        maxTextureSize: maxTextureSize || null,
        supportsFloatTextures: Boolean(floatTextures),
        supportsColorBufferFloat: Boolean(colorBufferFloat),
        maxAnisotropy: anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null
      };
    }

    return env;
  }

  _collectDataSnapshot(context = {}) {
    const fromState = this.state || null;
    const filteredCount = context.filteredCount ||
      (fromState && typeof fromState.getFilteredCount === 'function' ? fromState.getFilteredCount() : null);
    const activeField = context.activeField ||
      (fromState && typeof fromState.getActiveField === 'function' ? fromState.getActiveField() : null);
    const filters = context.filters ||
      (fromState && typeof fromState.getActiveFiltersStructured === 'function'
        ? fromState.getActiveFiltersStructured()
        : []);

    const dataset = context.dataset || {};
    const pointCount = dataset.pointCount ??
      (fromState ? fromState.pointCount : null) ??
      0;
    const visiblePoints = dataset.visiblePoints ??
      (filteredCount ? filteredCount.shown : null) ??
      pointCount;

    return {
      mode: dataset.mode || 'real',
      pattern: dataset.pattern || null,
      generationMs: dataset.generationMs || null,
      pointCount,
      visiblePoints,
      filters,
      activeFieldKey: dataset.activeFieldKey || activeField?.key || null,
      activeFieldKind: dataset.activeFieldKind || activeField?.kind || null
    };
  }

  _collectRendererSnapshot(gl, context = {}) {
    const rendererStats = context.rendererStats ||
      (this.viewer && typeof this.viewer.getRendererStats === 'function' ? this.viewer.getRendererStats() : null) ||
      {};
    const perfStats = context.perfStats || null;
    const rendererConfig = context.rendererConfig || {};
    const renderMode = rendererConfig.renderMode || context.renderMode || null;
    const viewport = gl
      ? { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight }
      : {
          width: typeof window !== 'undefined' ? window.innerWidth : null,
          height: typeof window !== 'undefined' ? window.innerHeight : null
        };

    const fps = rendererStats.fps || perfStats?.fps || null;
    const frameTime = rendererStats.lastFrameTime || perfStats?.avgFrameTime || null;

    const estimatedMemoryMB = rendererStats.gpuMemoryMB ||
      (context.dataset && context.dataset.pointCount
        ? (context.dataset.pointCount * 28) / (1024 * 1024)
        : null);

    return {
      fps,
      frameTime,
      rendererStats,
      perfStats,
      rendererConfig,
      renderMode,
      viewport,
      estimatedMemoryMB
    };
  }

  _detectIssues(env, renderer, data) {
    const issues = [];

    if (renderer.fps && renderer.fps < 30) {
      issues.push('FPS below 30 (verify LOD and resolution).');
    }
    if (renderer.frameTime && renderer.frameTime > 25) {
      issues.push('High frame time (>25ms) indicates GPU/CPU bottleneck.');
    }
    if (renderer.estimatedMemoryMB && renderer.estimatedMemoryMB > 700) {
      issues.push('GPU memory estimate exceeds ~700MB; risk of driver eviction.');
    }
    if (data.pointCount > 5000000 && renderer.rendererConfig && renderer.rendererConfig.lodEnabled === false) {
      issues.push('LOD disabled on multi-million point dataset.');
    }
    if (data.pointCount > 3000000 && renderer.rendererConfig && renderer.rendererConfig.frustumCulling === false) {
      issues.push('Frustum culling off for large dataset; enable to reduce fill rate.');
    }
    if (env.pixelRatio && env.pixelRatio > 2) {
      issues.push('High devicePixelRatio (>2) increases fill cost; try browser zoom <100% or lower resolution.');
    }
    if (env.hardwareConcurrency && env.hardwareConcurrency < 6) {
      issues.push('Limited CPU threads (<6); expect slower load or filter updates.');
    }
    if (env.deviceMemory && env.deviceMemory < 4) {
      issues.push('Low device memory (<4GB); large allocations may fail.');
    }
    if (env.webgl && env.webgl.maxTextureSize && env.webgl.maxTextureSize < 4096) {
      issues.push('Low MAX_TEXTURE_SIZE (<4096); texture-heavy effects may degrade.');
    }
    if (env.webgl && env.webgl.supportsColorBufferFloat === false) {
      issues.push('No color_buffer_float; fallback precision may apply.');
    }

    return issues;
  }

  buildReport(context = {}) {
    const gl = this._getGL();
    const env = this._collectEnvironment(gl);
    const data = this._collectDataSnapshot(context);
    const renderer = this._collectRendererSnapshot(gl, { ...context, dataset: data });
    const issues = this._detectIssues(env, renderer, data);
    const now = new Date();

    const pctVisible = data.pointCount && data.visiblePoints != null
      ? ((data.visiblePoints / data.pointCount) * 100).toFixed(1)
      : null;
    const filtersActive = data.filters && data.filters.length > 0;
    const filterLines = filtersActive
      ? data.filters.slice(0, 5).map(f => f.text || f.id || 'filter')
      : [];
    const perf = renderer.perfStats || null;
    const perfLine = perf
      ? `FPS ${renderer.fps ?? 'n/a'} • Frame ms avg/p95/min/max: ${perf.avgFrameTime || 'n/a'}/${perf.p95FrameTime || 'n/a'}/${perf.minFrameTime || 'n/a'}/${perf.maxFrameTime || 'n/a'} (samples ${perf.samples || 0})`
      : `FPS ${renderer.fps ?? 'n/a'} • Frame ms: ${renderer.frameTime != null ? (renderer.frameTime.toFixed ? renderer.frameTime.toFixed(2) : renderer.frameTime) : 'n/a'}`;

    const lines = [];
    lines.push('cellucid situation report');
    lines.push('-------------------------');
    lines.push(`Timestamp: ${now.toISOString()}`);

    lines.push('');
    lines.push('Data');
    lines.push(`- Mode: ${data.mode === 'synthetic' ? 'Synthetic' : 'Real'}${data.pattern ? ` (${data.pattern})` : ''}`);
    lines.push(`- Points: ${formatNumber(data.pointCount)}${pctVisible ? ` • Visible: ${formatNumber(data.visiblePoints)} (${pctVisible}%)` : ''}`);
    if (data.generationMs != null) {
      lines.push(`- Synthetic generation: ${data.generationMs} ms`);
    }
    if (data.activeFieldKey) {
      lines.push(`- Active field: ${data.activeFieldKey}${data.activeFieldKind ? ` [${data.activeFieldKind}]` : ''}`);
    }
    if (filtersActive) {
      lines.push(`- Filters (${data.filters.length}): ${filterLines.join(' | ')}${data.filters.length > filterLines.length ? ` (+${data.filters.length - filterLines.length} more)` : ''}`);
    } else {
      lines.push('- Filters: none');
    }

    lines.push('');
    lines.push('Renderer');
    lines.push(`- Quality: ${renderer.rendererConfig.shaderQuality || 'auto'} • LOD: ${renderer.rendererConfig.lodEnabled === false ? 'off' : 'on'} • Frustum: ${renderer.rendererConfig.frustumCulling ? 'on' : 'off'} • Mode: ${renderer.renderMode || 'n/a'}`);
    lines.push(`- ${perfLine}`);
    lines.push(`- Visible now: ${renderer.rendererStats.visiblePoints != null ? formatNumber(renderer.rendererStats.visiblePoints) : 'n/a'} • LOD level: ${renderer.rendererStats.lodLevel != null ? renderer.rendererStats.lodLevel : '-'}`);
    lines.push(`- GPU memory est: ${renderer.estimatedMemoryMB ? renderer.estimatedMemoryMB.toFixed(1) : 'n/a'} MB • Draw calls: ${renderer.rendererStats.drawCalls ?? '-'}`);
    lines.push(`- Viewport: ${renderer.viewport.width || '?'}x${renderer.viewport.height || '?'} @ DPR ${env.pixelRatio || '?'}`);

    lines.push('');
    lines.push('Environment');
    lines.push(`- Browser: ${env.browser}`);
    if (env.browserUA) lines.push(`- User agent: ${env.browserUA}`);
    lines.push(`- Platform: ${env.platform}${env.timezone ? ` • TZ: ${env.timezone}` : ''} • Arch: ${env.arch || 'n/a'}${env.appleSiliconHint ? ' (Apple Silicon hint)' : ''}`);
    lines.push(`- Locale: ${env.language || 'n/a'} • Cores: ${env.hardwareConcurrency || 'n/a'} • Device memory: ${env.deviceMemory ? `${env.deviceMemory} GB` : 'n/a'}`);
    lines.push(`- Screen: ${env.screen.width || '?'}×${env.screen.height || '?'} • DPR: ${env.pixelRatio || 'n/a'} • Connection: ${env.connection || 'n/a'} • Touch points: ${env.maxTouchPoints || 0}`);
    if (env.jsHeap) {
      lines.push(`- JS heap: used ${env.jsHeap.usedMB ?? 'n/a'} MB / total ${env.jsHeap.totalMB ?? 'n/a'} MB / limit ${env.jsHeap.limitMB ?? 'n/a'} MB (${env.jsHeap.source})`);
    }
    if (env.webgl) {
      lines.push(`- GPU: ${env.webgl.renderer || 'n/a'} (${env.webgl.vendor || 'vendor n/a'})`);
      lines.push(`- GPU cores: not exposed to browsers (WebGL hides core counts)`);
      lines.push(`- WebGL: ${env.webgl.version} • GLSL: ${env.webgl.shadingLanguage || 'n/a'} • Max texture: ${env.webgl.maxTextureSize || 'n/a'} • Float RT: ${env.webgl.supportsColorBufferFloat ? 'yes' : 'no'} • Aniso: ${env.webgl.maxAnisotropy ?? 'n/a'}`);
    } else {
      lines.push('- WebGL: unavailable');
    }

    lines.push('');
    lines.push('Potential issues');
    if (issues.length === 0) {
      lines.push('- None detected');
    } else {
      issues.forEach((issue) => lines.push(`- ${issue}`));
    }

    return {
      text: lines.join('\n'),
      env,
      data,
      renderer,
      issues
    };
  }
}

// Format numbers nicely
export function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}

// Export for global access
if (typeof window !== 'undefined') {
  window.SyntheticDataGenerator = SyntheticDataGenerator;
  window.PerformanceTracker = PerformanceTracker;
  window.HighPerfBenchmark = HighPerfBenchmark;
  window.BenchmarkConfig = BenchmarkConfig;
  window.formatNumber = formatNumber;
  window.GLBParser = GLBParser;
  window.MeshSurfaceSampler = MeshSurfaceSampler;
  window.BenchmarkReporter = BenchmarkReporter;
}
