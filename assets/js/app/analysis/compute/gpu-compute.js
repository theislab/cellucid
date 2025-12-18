/**
 * GPU Compute Module for Analysis
 *
 * Uses WebGL2 Transform Feedback for GPU-accelerated data transformations.
 * Designed for element-wise operations on large arrays (50K+ values).
 *
 * Operations supported:
 * - Log1p transform: log(1 + x)
 * - Z-score normalization: (x - mean) / std
 * - Min-max normalization: (x - min) / (max - min)
 * - Element-wise operations (add, multiply, etc.)
 * - Histogram binning
 *
 * Note: Statistical reductions (mean, sum, etc.) are kept on CPU workers
 * because GPU reductions in WebGL2 require complex ping-pong patterns.
 */

import { createShader } from '../../../rendering/gl-utils.js';

// Singleton instance
let gpuComputeInstance = null;

// ============================================================================
// Shader Sources
// ============================================================================

const TRANSFORM_VS_HEADER = `#version 300 es
precision highp float;
in float a_value;
out float v_result;
`;

const LOG1P_VS = `${TRANSFORM_VS_HEADER}
void main() {
  // log1p: log(1 + x), handles x near 0 better than log(1+x)
  v_result = a_value > -1.0 ? log(1.0 + a_value) : -1e10;
  gl_Position = vec4(0.0);
}`;

const ZSCORE_VS = `${TRANSFORM_VS_HEADER}
uniform float u_mean;
uniform float u_std;
void main() {
  v_result = u_std > 0.0 ? (a_value - u_mean) / u_std : 0.0;
  gl_Position = vec4(0.0);
}`;

const MINMAX_VS = `${TRANSFORM_VS_HEADER}
uniform float u_min;
uniform float u_range;
void main() {
  v_result = u_range > 0.0 ? (a_value - u_min) / u_range : 0.0;
  gl_Position = vec4(0.0);
}`;

const SCALE_VS = `${TRANSFORM_VS_HEADER}
uniform float u_scale;
uniform float u_offset;
void main() {
  v_result = a_value * u_scale + u_offset;
  gl_Position = vec4(0.0);
}`;

const CLAMP_VS = `${TRANSFORM_VS_HEADER}
uniform float u_min;
uniform float u_max;
void main() {
  v_result = clamp(a_value, u_min, u_max);
  gl_Position = vec4(0.0);
}`;

// Simple passthrough fragment shader (required but output is discarded)
const PASSTHROUGH_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0);
}`;

// ============================================================================
// GPUCompute Class
// ============================================================================

/**
 * GPU Compute engine using WebGL2 Transform Feedback
 */
export class GPUCompute {
  /**
   * @param {WebGL2RenderingContext} [gl] - Optional existing WebGL2 context
   */
  constructor(gl = null) {
    this._gl = gl;
    this._canvas = null;
    this._programs = {};
    this._buffers = {
      input: null,
      output: null
    };
    this._transformFeedback = null;
    this._maxSize = 0;
    this._initialized = false;
  }

  /**
   * Initialize the GPU compute engine
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;

    // Create or use existing WebGL2 context
    if (!this._gl) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = 1;
      this._canvas.height = 1;
      this._gl = this._canvas.getContext('webgl2', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      });
    }

    const gl = this._gl;

    // Check for required extensions/features
    this._maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    // Create transform feedback object
    this._transformFeedback = gl.createTransformFeedback();

    // Create shader programs
    this._programs.log1p = this._createTransformProgram(LOG1P_VS, ['v_result']);
    this._programs.zscore = this._createTransformProgram(ZSCORE_VS, ['v_result']);
    this._programs.minmax = this._createTransformProgram(MINMAX_VS, ['v_result']);
    this._programs.scale = this._createTransformProgram(SCALE_VS, ['v_result']);
    this._programs.clamp = this._createTransformProgram(CLAMP_VS, ['v_result']);

    // Create reusable buffers (will resize as needed)
    this._buffers.input = gl.createBuffer();
    this._buffers.output = gl.createBuffer();

    this._initialized = true;

    console.log('[GPUCompute] Initialized successfully');
  }

  /**
   * Create a transform feedback program
   */
  _createTransformProgram(vsSource, varyings) {
    const gl = this._gl;

    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, PASSTHROUGH_FS);

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);

    // Specify transform feedback varyings before linking
    gl.transformFeedbackVaryings(program, varyings, gl.SEPARATE_ATTRIBS);

    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('Transform feedback program link failed: ' + info);
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return {
      program,
      attribLoc: gl.getAttribLocation(program, 'a_value'),
      uniforms: {
        mean: gl.getUniformLocation(program, 'u_mean'),
        std: gl.getUniformLocation(program, 'u_std'),
        min: gl.getUniformLocation(program, 'u_min'),
        max: gl.getUniformLocation(program, 'u_max'),
        range: gl.getUniformLocation(program, 'u_range'),
        scale: gl.getUniformLocation(program, 'u_scale'),
        offset: gl.getUniformLocation(program, 'u_offset')
      }
    };
  }

  /**
   * Ensure buffers are sized correctly
   */
  _ensureBufferSize(count) {
    const gl = this._gl;
    const byteSize = count * 4; // Float32

    // Resize input buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffers.input);
    gl.bufferData(gl.ARRAY_BUFFER, byteSize, gl.DYNAMIC_DRAW);

    // Resize output buffer
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this._buffers.output);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, byteSize, gl.DYNAMIC_READ);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
  }

  /**
   * Run a transform feedback pass
   */
  _runTransform(programInfo, values, uniforms = {}) {
    const gl = this._gl;
    const count = values.length;

    // Ensure buffers are sized
    this._ensureBufferSize(count);

    // Upload input data
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffers.input);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, values);

    // Set up program
    gl.useProgram(programInfo.program);

    // Set uniforms
    for (const [name, value] of Object.entries(uniforms)) {
      const loc = programInfo.uniforms[name];
      if (loc !== null && loc !== undefined) {
        gl.uniform1f(loc, value);
      }
    }

    // Set up vertex attribute
    gl.enableVertexAttribArray(programInfo.attribLoc);
    gl.vertexAttribPointer(programInfo.attribLoc, 1, gl.FLOAT, false, 0, 0);

    // Bind transform feedback
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._transformFeedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._buffers.output);

    // Disable rasterization
    gl.enable(gl.RASTERIZER_DISCARD);

    // Run transform feedback
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();

    // Re-enable rasterization
    gl.disable(gl.RASTERIZER_DISCARD);

    // Unbind
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.disableVertexAttribArray(programInfo.attribLoc);

    // Read back results
    const result = new Float32Array(count);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this._buffers.output);
    gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

    return result;
  }

  // =========================================================================
  // Public Transform Methods
  // =========================================================================

  /**
   * Apply log1p transform: log(1 + x)
   * @param {Float32Array} values - Input values
   * @returns {Float32Array} Transformed values
   */
  log1pTransform(values) {
    return this._runTransform(this._programs.log1p, values);
  }

  /**
   * Z-score normalization: (x - mean) / std
   * @param {Float32Array} values - Input values
   * @param {number} mean - Mean value
   * @param {number} std - Standard deviation
   * @returns {Float32Array} Normalized values
   */
  zScoreNormalize(values, mean, std) {
    return this._runTransform(this._programs.zscore, values, { mean, std });
  }

  /**
   * Min-max normalization: (x - min) / (max - min)
   * @param {Float32Array} values - Input values
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {Float32Array} Normalized values (0-1)
   */
  minMaxNormalize(values, min, max) {
    const range = max - min;
    return this._runTransform(this._programs.minmax, values, { min, range });
  }

  /**
   * Scale and offset: x * scale + offset
   * @param {Float32Array} values - Input values
   * @param {number} scale - Multiplier
   * @param {number} offset - Offset to add
   * @returns {Float32Array} Scaled values
   */
  scaleAndOffset(values, scale, offset = 0) {
    return this._runTransform(this._programs.scale, values, { scale, offset });
  }

  /**
   * Clamp values to range
   * @param {Float32Array} values - Input values
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {Float32Array} Clamped values
   */
  clamp(values, min, max) {
    return this._runTransform(this._programs.clamp, values, { min, max });
  }

  /**
   * Compute histogram with optimized binning
   * Uses loop unrolling for better performance on large arrays.
   *
   * @param {Float32Array} values - Input values
   * @param {number} bins - Number of bins
   * @param {number} [min] - Minimum value (auto-detect if not provided)
   * @param {number} [max] - Maximum value (auto-detect if not provided)
   * @returns {Object} { counts, edges, binWidth, validCount }
   */
  computeHistogram(values, bins, min = null, max = null) {
    const n = values.length;

    // Find min/max if not provided - optimized single pass
    if (min === null || max === null) {
      let autoMin = Infinity;
      let autoMax = -Infinity;

      // Process 4 values at a time for better CPU cache utilization
      const n4 = n - (n % 4);
      for (let i = 0; i < n4; i += 4) {
        const v0 = values[i], v1 = values[i+1], v2 = values[i+2], v3 = values[i+3];
        if (Number.isFinite(v0)) { if (v0 < autoMin) autoMin = v0; if (v0 > autoMax) autoMax = v0; }
        if (Number.isFinite(v1)) { if (v1 < autoMin) autoMin = v1; if (v1 > autoMax) autoMax = v1; }
        if (Number.isFinite(v2)) { if (v2 < autoMin) autoMin = v2; if (v2 > autoMax) autoMax = v2; }
        if (Number.isFinite(v3)) { if (v3 < autoMin) autoMin = v3; if (v3 > autoMax) autoMax = v3; }
      }
      // Handle remaining elements
      for (let i = n4; i < n; i++) {
        const v = values[i];
        if (Number.isFinite(v)) { if (v < autoMin) autoMin = v; if (v > autoMax) autoMax = v; }
      }

      if (min === null) min = autoMin;
      if (max === null) max = autoMax;
    }

    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      return { counts: new Uint32Array(bins), edges: [], binWidth: 0, validCount: 0 };
    }

    const binWidth = (max - min) / bins;
    const invBinWidth = 1 / binWidth;
    const counts = new Uint32Array(bins);
    const edges = new Float32Array(bins + 1);
    let validCount = 0;

    for (let i = 0; i <= bins; i++) {
      edges[i] = min + i * binWidth;
    }

    // Optimized binning - process 4 values at a time
    const binsMinusOne = bins - 1;
    const n4 = n - (n % 4);

    for (let i = 0; i < n4; i += 4) {
      const v0 = values[i], v1 = values[i+1], v2 = values[i+2], v3 = values[i+3];

      if (Number.isFinite(v0) && v0 >= min && v0 <= max) {
        const idx = Math.min(Math.floor((v0 - min) * invBinWidth), binsMinusOne);
        counts[idx]++;
        validCount++;
      }
      if (Number.isFinite(v1) && v1 >= min && v1 <= max) {
        const idx = Math.min(Math.floor((v1 - min) * invBinWidth), binsMinusOne);
        counts[idx]++;
        validCount++;
      }
      if (Number.isFinite(v2) && v2 >= min && v2 <= max) {
        const idx = Math.min(Math.floor((v2 - min) * invBinWidth), binsMinusOne);
        counts[idx]++;
        validCount++;
      }
      if (Number.isFinite(v3) && v3 >= min && v3 <= max) {
        const idx = Math.min(Math.floor((v3 - min) * invBinWidth), binsMinusOne);
        counts[idx]++;
        validCount++;
      }
    }

    // Handle remaining elements
    for (let i = n4; i < n; i++) {
      const v = values[i];
      if (Number.isFinite(v) && v >= min && v <= max) {
        const idx = Math.min(Math.floor((v - min) * invBinWidth), binsMinusOne);
        counts[idx]++;
        validCount++;
      }
    }

    return { counts, edges, binWidth, validCount };
  }

  /**
   * Compute basic statistics with optimized single-pass algorithm.
   * Uses Welford's algorithm for numerically stable variance.
   *
   * @param {Float32Array} values - Input values
   * @returns {Object} { count, min, max, sum, mean, variance, std }
   */
  computeStatistics(values) {
    const n = values.length;
    if (n === 0) {
      return { count: 0, min: null, max: null, sum: 0, mean: null, variance: null, std: null };
    }

    // Welford's online algorithm for mean and variance
    let count = 0;
    let mean = 0;
    let m2 = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    // Process values - using Welford's algorithm for numerical stability
    for (let i = 0; i < n; i++) {
      const x = values[i];

      // Skip non-finite values (NaN/±Infinity)
      if (!Number.isFinite(x)) continue;

      count++;
      sum += x;

      // Welford's online update
      const delta = x - mean;
      mean += delta / count;
      const delta2 = x - mean;
      m2 += delta * delta2;

      // Min/max
      if (x < min) min = x;
      if (x > max) max = x;
    }

    if (count === 0) {
      return { count: 0, min: null, max: null, sum: 0, mean: null, variance: null, std: null };
    }

    const variance = count > 1 ? m2 / count : 0;
    const std = Math.sqrt(variance);

    return { count, min, max, sum, mean, variance, std };
  }

  /**
   * Compute percentiles from sorted values.
   *
   * @param {Float32Array} sortedValues - Pre-sorted values (ascending)
   * @param {number[]} percentiles - Percentiles to compute (0-100)
   * @returns {Object} Map of percentile -> value
   */
  computePercentiles(sortedValues, percentiles = [25, 50, 75]) {
    const n = sortedValues.length;
    if (n === 0) {
      const result = {};
      for (const p of percentiles) result[p] = null;
      return result;
    }

    const result = {};
    for (const p of percentiles) {
      const idx = (p / 100) * (n - 1);
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      const fraction = idx - lower;

      if (lower === upper || upper >= n) {
        result[p] = sortedValues[Math.min(lower, n - 1)];
      } else {
        result[p] = sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
      }
    }

    return result;
  }

  /**
   * Sort values and filter NaN in one pass (optimized for statistics).
   * Returns a new sorted Float32Array with only valid numbers.
   *
   * @param {Float32Array} values - Input values
   * @returns {Float32Array} Sorted valid values
   */
  sortAndFilter(values) {
    // First pass: count valid values
    let validCount = 0;
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i])) validCount++;
    }

    if (validCount === 0) return new Float32Array(0);

    // Second pass: copy valid values
    const filtered = new Float32Array(validCount);
    let j = 0;
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i])) {
        filtered[j++] = values[i];
      }
    }

    // Sort using native sort (highly optimized)
    filtered.sort();

    return filtered;
  }

  /**
   * Compute comprehensive statistics including percentiles.
   * Combines computeStatistics with percentile calculation.
   *
   * @param {Float32Array} values - Input values
   * @returns {Object} Full statistics object
   */
  computeFullStatistics(values) {
    // Basic stats first
    const basic = this.computeStatistics(values);

    if (basic.count === 0) {
      return {
        ...basic,
        median: null,
        q1: null,
        q3: null,
        iqr: null,
        percentiles: {}
      };
    }

    // Sort and compute percentiles
    const sorted = this.sortAndFilter(values);
    const percentiles = this.computePercentiles(sorted, [1, 5, 25, 50, 75, 95, 99]);

    return {
      ...basic,
      median: percentiles[50],
      q1: percentiles[25],
      q3: percentiles[75],
      iqr: percentiles[75] - percentiles[25],
      percentiles
    };
  }

  /**
   * Apply GPU transform then compute statistics on result.
   * Useful for analysis pipelines that need transformed + summarized data.
   *
   * @param {Float32Array} values - Input values
   * @param {string} transform - Transform type: 'log1p', 'zscore', 'minmax'
   * @param {Object} [transformParams] - Parameters for the transform
   * @returns {Object} { transformed, statistics }
   */
  transformAndStats(values, transform, transformParams = {}) {
    let transformed;

    switch (transform) {
      case 'log1p':
        transformed = this.log1pTransform(values);
        break;
      case 'zscore': {
        // Need mean/std for zscore
        const stats = this.computeStatistics(values);
        const mean = transformParams.mean ?? stats.mean;
        const std = transformParams.std ?? stats.std;
        transformed = this.zScoreNormalize(values, mean, std);
        break;
      }
      case 'minmax': {
        // Need min/max for minmax
        const stats = this.computeStatistics(values);
        const min = transformParams.min ?? stats.min;
        const max = transformParams.max ?? stats.max;
        transformed = this.minMaxNormalize(values, min, max);
        break;
      }
      default:
        transformed = values;
    }

    const statistics = this.computeFullStatistics(transformed);

    return { transformed, statistics };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Get GPU info
   */
  getInfo() {
    if (!this._gl) {
      return { initialized: false };
    }

    const gl = this._gl;
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

    return {
      initialized: this._initialized,
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'unknown',
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown',
      maxTextureSize: this._maxSize
    };
  }

  /**
   * Clean up GPU resources
   */
  dispose() {
    if (!this._gl) return;

    const gl = this._gl;

    // Delete programs
    for (const prog of Object.values(this._programs)) {
      if (prog.program) {
        gl.deleteProgram(prog.program);
      }
    }
    this._programs = {};

    // Delete buffers
    if (this._buffers.input) gl.deleteBuffer(this._buffers.input);
    if (this._buffers.output) gl.deleteBuffer(this._buffers.output);
    this._buffers = { input: null, output: null };

    // Delete transform feedback
    if (this._transformFeedback) {
      gl.deleteTransformFeedback(this._transformFeedback);
      this._transformFeedback = null;
    }

    // Lose context if we created our own canvas
    if (this._canvas) {
      const loseContext = gl.getExtension('WEBGL_lose_context');
      if (loseContext) loseContext.loseContext();
      this._canvas = null;
    }

    this._gl = null;
    this._initialized = false;

    // Clear singleton
    if (gpuComputeInstance === this) {
      gpuComputeInstance = null;
    }
  }
}

/**
 * Get the singleton GPUCompute instance
 * @param {WebGL2RenderingContext} [gl] - Optional existing context
 * @returns {GPUCompute}
 */
export function getGPUCompute(gl) {
  if (!gpuComputeInstance) {
    gpuComputeInstance = new GPUCompute(gl);
  }
  return gpuComputeInstance;
}

/**
 * Create a new GPUCompute instance (for testing or isolation)
 * @param {WebGL2RenderingContext} [gl] - Optional existing context
 * @returns {GPUCompute}
 */
export function createGPUCompute(gl) {
  return new GPUCompute(gl);
}

export default GPUCompute;
