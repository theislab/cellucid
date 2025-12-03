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

import { HighPerfRenderer, RendererConfig, Octree } from './high-perf-renderer.js';

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
  loadData(positions, colors, alphas) {
    if (!this.renderer) {
      this.init();
    }
    
    const stats = this.renderer.loadData(positions, colors, alphas, {
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
    const colors = new Float32Array(count * 3);

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

        // Body color with variation
        colors[idx] = bodyColor[0] + (Math.random() - 0.5) * 0.1;
        colors[idx + 1] = bodyColor[1] + (Math.random() - 0.5) * 0.1;
        colors[idx + 2] = bodyColor[2] + (Math.random() - 0.5) * 0.1;
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

        // Tentacle color - gradient from body color to darker at tips
        const tentColor = this._hslToRgb(tent.hue, 0.7, 0.5 - t * 0.2);
        colors[idx] = Math.max(0, Math.min(1, tentColor[0] + (Math.random() - 0.5) * 0.08));
        colors[idx + 1] = Math.max(0, Math.min(1, tentColor[1] + (Math.random() - 0.5) * 0.08));
        colors[idx + 2] = Math.max(0, Math.min(1, tentColor[2] + (Math.random() - 0.5) * 0.08));
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
    const colors = new Float32Array(count * 3);

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

      // Color gradient along spiral
      const color = this._hslToRgb(sp.hue + t * 0.1, 0.75, 0.45 + t * 0.15);
      colors[idx] = Math.max(0, Math.min(1, color[0] + (Math.random() - 0.5) * 0.08));
      colors[idx + 1] = Math.max(0, Math.min(1, color[1] + (Math.random() - 0.5) * 0.08));
      colors[idx + 2] = Math.max(0, Math.min(1, color[2] + (Math.random() - 0.5) * 0.08));
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
    const colors = new Float32Array(count * 3);

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
      positions[idx + 2] = this._gaussianRandom() * zScale;

      // Color
      colors[idx] = Math.max(0, Math.min(1, cluster.color[0] + (Math.random() - 0.5) * 0.06));
      colors[idx + 1] = Math.max(0, Math.min(1, cluster.color[1] + (Math.random() - 0.5) * 0.06));
      colors[idx + 2] = Math.max(0, Math.min(1, cluster.color[2] + (Math.random() - 0.5) * 0.06));
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors };
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
    const colors = new Float32Array(count * 3);

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

      colors[idx] = Math.max(0, Math.min(1, cluster.color[0] + (Math.random() - 0.5) * 0.1));
      colors[idx + 1] = Math.max(0, Math.min(1, cluster.color[1] + (Math.random() - 0.5) * 0.1));
      colors[idx + 2] = Math.max(0, Math.min(1, cluster.color[2] + (Math.random() - 0.5) * 0.1));
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
    const colors = new Float32Array(count * 3);
    
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      
      positions[idx] = (Math.random() - 0.5) * scale * 2;
      positions[idx + 1] = (Math.random() - 0.5) * scale * 2;
      positions[idx + 2] = (Math.random() - 0.5) * scale * 2;
      
      colors[idx] = Math.random();
      colors[idx + 1] = Math.random();
      colors[idx + 2] = Math.random();
    }
    
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    
    return { positions, colors };
  }
  
  /**
   * Generate points by sampling from a GLB mesh surface
   * @param {number} count - Number of points to generate
   * @param {ArrayBuffer} glbBuffer - The loaded GLB file as ArrayBuffer
   * @returns {Object} - { positions: Float32Array, colors: Float32Array }
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
    const colors = new Float32Array(count * 3);
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

      // Add slight noise for visual interest
      colors[idx] = Math.max(0, Math.min(1, color[0] + (Math.random() - 0.5) * 0.05));
      colors[idx + 1] = Math.max(0, Math.min(1, color[1] + (Math.random() - 0.5) * 0.05));
      colors[idx + 2] = Math.max(0, Math.min(1, color[2] + (Math.random() - 0.5) * 0.05));
    }

    const elapsed = performance.now() - startTime;
    console.log(`[GLB] Done! Sampled ${count.toLocaleString()} points in ${elapsed.toFixed(0)}ms`);

    return { positions, colors };
  }

  /**
   * Load GLB file from URL and sample points
   * @param {number} count - Number of points to generate
   * @param {string} url - URL to the GLB file
   * @returns {Promise<Object>} - { positions: Float32Array, colors: Float32Array }
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
}
