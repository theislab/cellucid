/**
 * PERFORMANCE BENCHMARK MODULE
 * ============================
 * Simple benchmark for testing scatterplot rendering limits.
 * Integrates with the existing viewer for easy testing.
 *
 * Uses HighPerfRenderer (WebGL2) for all benchmarking:
 * - Interleaved vertex buffers
 * - Level-of-Detail (LOD) with spatial index
 * - Frustum culling
 * - Lightweight shaders
 * - GPU-only fog
 */

import { HighPerfRenderer, RendererConfig } from '../rendering/high-perf-renderer.js';
import { formatCellCount as formatNumber } from '../data/data-source.js';

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
  TEST_SHADER_QUALITY: 'shader',

  // Default test parameters
  DEFAULT_FRAMES_PER_TEST: 60,
  DEFAULT_WARMUP_FRAMES: 10,
  DEFAULT_MULTI_RUN_COUNT: 3,
  DEFAULT_COOLDOWN_MS: 500,

  // Thresholds for performance classification
  THRESHOLDS: {
    FPS: {
      EXCELLENT: 60,    // >= 60 FPS
      GOOD: 45,         // >= 45 FPS
      ACCEPTABLE: 30,   // >= 30 FPS
      POOR: 15          // >= 15 FPS, below is critical
    },
    FRAME_TIME: {
      EXCELLENT: 16.67, // <= 16.67ms (60 FPS)
      GOOD: 22.22,      // <= 22.22ms (45 FPS)
      ACCEPTABLE: 33.33, // <= 33.33ms (30 FPS)
      POOR: 66.67       // <= 66.67ms (15 FPS)
    },
    JANK_PERCENT: {
      GOOD: 2,          // <= 2% jank frames
      ACCEPTABLE: 5,    // <= 5%
      POOR: 10          // <= 10%, above is critical
    },
    CV: {
      STABLE: 10,       // CV <= 10% is stable
      MODERATE: 25,     // CV <= 25% is moderate
      UNSTABLE: 50      // CV <= 50% is unstable, above is highly unstable
    }
  },

  // Test suite configurations
  TEST_SUITE: {
    STANDARD: [
      { name: 'Full Quality', quality: 'full', lod: true },
      { name: 'Light Quality', quality: 'light', lod: true },
      { name: 'Ultralight Quality', quality: 'ultralight', lod: true },
      { name: 'No LOD', quality: 'full', lod: false },
      { name: 'With LOD', quality: 'full', lod: true }
    ],
    EXTENDED: [
      { name: 'Full Quality', quality: 'full', lod: true },
      { name: 'Light Quality', quality: 'light', lod: true },
      { name: 'Ultralight Quality', quality: 'ultralight', lod: true },
      { name: 'No LOD', quality: 'full', lod: false },
      { name: 'With LOD', quality: 'full', lod: true },
      { name: 'With Frustum Culling', quality: 'full', lod: true, frustumCulling: true }
    ],
    MINIMAL: [
      { name: 'Standard', quality: 'full', lod: true },
      { name: 'Performance', quality: 'ultralight', lod: true }
    ]
  },

  /**
   * Classify performance based on FPS
   * @param {number} fps - Frames per second
   * @returns {string} Performance classification
   */
  classifyFPS(fps) {
    const t = this.THRESHOLDS.FPS;
    if (fps >= t.EXCELLENT) return 'excellent';
    if (fps >= t.GOOD) return 'good';
    if (fps >= t.ACCEPTABLE) return 'acceptable';
    if (fps >= t.POOR) return 'poor';
    return 'critical';
  },

  /**
   * Classify stability based on coefficient of variation
   * @param {number} cv - Coefficient of variation (percentage)
   * @returns {string} Stability classification
   */
  classifyStability(cv) {
    const t = this.THRESHOLDS.CV;
    if (cv <= t.STABLE) return 'stable';
    if (cv <= t.MODERATE) return 'moderate';
    if (cv <= t.UNSTABLE) return 'unstable';
    return 'highly_unstable';
  }
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
      forceLODLevel: -1,  // -1 = auto
      dimensionLevel: 3   // 1=1D, 2=2D, 3=3D
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

    // HighPerfRenderer expects a WebGL2 context as first argument
    // Get context from options or create from canvas
    const gl = options.gl || this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance'
    });

    if (!gl) {
      throw new Error('[HighPerfBenchmark] Failed to get WebGL2 context');
    }

    this.gl = gl;  // Store for reference

    this.renderer = new HighPerfRenderer(gl, {
      USE_LOD: this.config.useLOD,
      USE_FRUSTUM_CULLING: this.config.useFrustumCulling,
      USE_INTERLEAVED_BUFFERS: this.config.useInterleavedBuffers
    });

    this.renderer.setQuality(this.config.shaderQuality);
    this.isActive = true;

    console.log('[HighPerfBenchmark] Renderer initialized:', {
      quality: this.config.shaderQuality
    });

    return this.renderer;
  }
  
  /**
   * Load data into the high-performance renderer
   * @param {Float32Array} positions - Position data (n * 3)
   * @param {Uint8Array} colors - Color data (RGBA)
   * @param {number} [dimensionLevel] - Optional dimension level override (1, 2, or 3)
   */
  loadData(positions, colors, dimensionLevel = undefined) {
    if (!this.renderer) {
      this.init();
    }

    const dimLevel = dimensionLevel ?? this.config.dimensionLevel;

    // Alpha is packed in colors as RGBA uint8 - no separate array needed
    // Build spatial index if either LOD or frustum culling is enabled
    const stats = this.renderer.loadData(positions, colors, {
      buildSpatialIndex: this.config.useLOD || this.config.useFrustumCulling,
      dimensionLevel: dimLevel
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
   * Get default render parameters for benchmarking.
   * Uses identity matrices and sensible defaults for GPU activity measurement.
   * @private
   */
  _getDefaultRenderParams() {
    // Identity matrices for benchmarking (render all points without culling/transformation)
    const identityMatrix = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    return {
      mvpMatrix: identityMatrix,
      viewMatrix: identityMatrix,
      modelMatrix: identityMatrix,
      projectionMatrix: identityMatrix,
      pointSize: 4.0,
      sizeAttenuation: 0.0,
      viewportWidth: this.canvas.width || 800,
      viewportHeight: this.canvas.height || 600,
      fov: Math.PI / 4,
      fogDensity: 0.0,
      fogNear: 0.0,
      fogFar: 100.0,
      fogColor: new Float32Array([0, 0, 0]),
      bgColor: new Float32Array([0, 0, 0]),
      lightDir: new Float32Array([0, 0, 1]),
      lightingStrength: 0.0,
      cameraPosition: [0, 0, 5],
      cameraDistance: 5.0,
      forceLOD: this.config.forceLODLevel,
      quality: this.config.shaderQuality,
      dimensionLevel: this.config.dimensionLevel
    };
  }

  /**
   * Render a frame using the high-performance renderer
   */
  render(params) {
    if (!this.renderer || !this.isActive) {
      return null;
    }

    // Merge provided params with defaults, then add force LOD and quality
    const renderParams = {
      ...this._getDefaultRenderParams(),
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
    const dimLevel = this.renderer?.currentDimensionLevel ?? this.config.dimensionLevel;
    if (!this.renderer || !this.renderer.hasSpatialIndex(dimLevel)) {
      return null;
    }

    const lodBuffers = this.renderer.getLodBuffersForDimension(dimLevel);
    return {
      levelCount: this.renderer.getLODLevelCount(dimLevel),
      levels: lodBuffers.map((lod, i) => ({
        level: i,
        pointCount: lod.pointCount,
        depth: lod.depth
      }))
    };
  }
  
  /**
   * Run a comprehensive benchmark test suite
   * @param {number} pointCount - Number of points being tested (for reference)
   * @param {Function} onProgress - Progress callback
   * @param {Object} options - Test options
   * @returns {Promise<Array>} Array of test results
   */
  async runBenchmarkSuite(pointCount, onProgress, options = {}) {
    const {
      framesPerTest = BenchmarkConfig.DEFAULT_FRAMES_PER_TEST,
      warmupFrames = BenchmarkConfig.DEFAULT_WARMUP_FRAMES,
      includeExtended = false,
      testSuite = null,  // Custom test suite override
      validateResults = true
    } = options;

    // Select test suite: custom, extended, or standard
    const suite = testSuite ||
      (includeExtended ? BenchmarkConfig.TEST_SUITE.EXTENDED : BenchmarkConfig.TEST_SUITE.STANDARD);

    const results = [];

    // Save original settings to restore later
    const originalConfig = {
      useLOD: this.config.useLOD,
      useFrustumCulling: this.config.useFrustumCulling,
      shaderQuality: this.config.shaderQuality,
      forceLODLevel: this.config.forceLODLevel
    };

    try {
      // Run each test in the suite
      for (let i = 0; i < suite.length; i++) {
        const test = suite[i];
        const progress = i / suite.length;

        if (onProgress) {
          onProgress({
            test: test.name.toLowerCase().replace(/\s+/g, '_'),
            status: 'running',
            progress,
            testIndex: i,
            totalTests: suite.length
          });
        }

        // Apply test configuration
        this.setShaderQuality(test.quality || BenchmarkConfig.QUALITY_FULL);
        this.setLODEnabled(test.lod !== false);
        if (test.frustumCulling !== undefined) {
          this.setFrustumCullingEnabled(test.frustumCulling);
        }

        // Run the test
        const result = await this._runTimedTest(test.name, framesPerTest, warmupFrames);

        // Add performance classification
        result.classification = {
          performance: BenchmarkConfig.classifyFPS(result.fps),
          stability: result.stdDev && result.avgFrameTime
            ? BenchmarkConfig.classifyStability((result.stdDev / result.avgFrameTime) * 100)
            : 'unknown'
        };

        // Validate if requested
        if (validateResults) {
          result.validation = this.validateResults(result);
        }

        results.push(result);
      }

      // Add metadata to results
      const metadata = {
        pointCount,
        timestamp: new Date().toISOString(),
        testCount: results.length,
        framesPerTest,
        warmupFrames,
        suiteType: testSuite ? 'custom' : (includeExtended ? 'extended' : 'standard')
      };

      // Calculate suite-level summary
      const summary = {
        bestFPS: Math.max(...results.map(r => r.fps)),
        worstFPS: Math.min(...results.map(r => r.fps)),
        avgFPS: results.reduce((sum, r) => sum + r.fps, 0) / results.length,
        bestTest: results.reduce((best, r) => r.fps > best.fps ? r : best).name,
        worstTest: results.reduce((worst, r) => r.fps < worst.fps ? r : worst).name,
        overallClassification: BenchmarkConfig.classifyFPS(
          results.reduce((sum, r) => sum + r.fps, 0) / results.length
        )
      };

      this.testResults = { results, metadata, summary };

      if (onProgress) {
        onProgress({
          test: 'complete',
          status: 'done',
          progress: 1,
          summary
        });
      }

      return { results, metadata, summary };
    } finally {
      // Restore original settings
      this.config.useLOD = originalConfig.useLOD;
      this.config.useFrustumCulling = originalConfig.useFrustumCulling;
      this.config.shaderQuality = originalConfig.shaderQuality;
      this.config.forceLODLevel = originalConfig.forceLODLevel;

      if (this.renderer) {
        this.renderer.setAdaptiveLOD(originalConfig.useLOD);
        this.renderer.setFrustumCulling(originalConfig.useFrustumCulling);
        this.renderer.setQuality(originalConfig.shaderQuality);
      }
    }
  }

  /**
   * Run a timed test with proper warmup and rendering trigger
   * @param {string} name - Test name
   * @param {number} frames - Number of frames to measure
   * @param {number} warmupFrames - Number of warmup frames to skip
   * @returns {Promise<Object>} Test results with all metrics as numbers
   */
  async _runTimedTest(name, frames, warmupFrames = 10) {
    return new Promise((resolve) => {
      const frameTimes = [];
      let totalFrameAttempts = 0;
      let skippedFrames = 0;
      let warmupCount = 0;
      let lastFrameStart = performance.now();

      const measure = () => {
        const now = performance.now();
        const frameTime = now - lastFrameStart;
        lastFrameStart = now;

        // Warmup phase - skip these frames
        if (warmupCount < warmupFrames) {
          warmupCount++;
          // Force a render during warmup to stabilize GPU state
          this.render();  // Uses default render params
          requestAnimationFrame(measure);
          return;
        }

        // Measurement phase - continue until we have enough valid frames
        if (frameTimes.length >= frames) {
          // Calculate comprehensive statistics (all as numbers)
          const sorted = [...frameTimes].sort((a, b) => a - b);
          const n = sorted.length;
          const sum = sorted.reduce((a, b) => a + b, 0);
          const avg = sum / n;
          const fps = 1000 / avg;

          // Calculate standard deviation
          const sumSquares = sorted.reduce((a, b) => a + b * b, 0);
          const variance = (sumSquares / n) - (avg * avg);
          const stdDev = Math.sqrt(Math.max(0, variance));

          // Percentiles with bounds checking and interpolation
          const getPercentile = (p) => {
            if (n === 0) return 0;
            if (n === 1) return sorted[0];
            const idx = p * (n - 1);
            const lower = Math.floor(idx);
            const upper = Math.ceil(idx);
            if (lower === upper) return sorted[lower];
            // Linear interpolation for more accurate percentiles
            const frac = idx - lower;
            return sorted[lower] * (1 - frac) + sorted[upper] * frac;
          };

          const medianFrameTime = getPercentile(0.50);
          const p95FrameTime = getPercentile(0.95);
          const p99FrameTime = getPercentile(0.99);

          // Jank detection (frames > 1.5x average)
          const jankThreshold = avg * 1.5;
          const jankFrames = frameTimes.filter(t => t > jankThreshold).length;

          // Use actual measured frame count for accuracy
          const measuredFrames = frameTimes.length;

          resolve({
            name,
            // All values as numbers for consistency
            avgFrameTime: avg,
            fps: Math.round(fps),
            fpsRaw: fps, // Keep unrounded FPS for accurate comparisons
            minFrameTime: sorted[0],
            maxFrameTime: sorted[n - 1],
            medianFrameTime,
            p95FrameTime,
            p99FrameTime,
            stdDev,
            frames: measuredFrames,
            totalFrameAttempts,
            skippedFrames,
            warmupFrames,
            jankFrames,
            jankPercent: (jankFrames / measuredFrames) * 100,
            // Raw data for further analysis
            rawFrameTimes: frameTimes
          });
          return;
        }

        // Force a render to get accurate frame timing
        this.render();  // Uses default render params

        totalFrameAttempts++;

        // Only record valid frame times (skip first frame which may include setup)
        // Also skip obviously invalid frames (tab hidden, extreme outliers)
        if (totalFrameAttempts > 1 && frameTime > 0.1 && frameTime < 1000) {
          frameTimes.push(frameTime);
        } else if (totalFrameAttempts > 1) {
          skippedFrames++;
        }

        requestAnimationFrame(measure);
      };

      requestAnimationFrame(measure);
    });
  }

  /**
   * Compare two benchmark runs and identify regressions/improvements
   * @param {Object} baseline - Baseline benchmark results
   * @param {Object} current - Current benchmark results
   * @param {Object} options - Comparison options
   * @returns {Object} Comparison analysis
   */
  compareBenchmarks(baseline, current, options = {}) {
    const {
      regressionThreshold = 5,  // % FPS drop to consider regression
      improvementThreshold = 5,  // % FPS gain to consider improvement
      criticalThreshold = 20,    // % FPS drop for critical severity
      warningThreshold = 10      // % FPS drop for warning severity
    } = options;

    const comparisons = [];

    for (const currentTest of current.results) {
      const baselineTest = baseline.results.find(b => b.name === currentTest.name);
      if (!baselineTest) continue;

      // Use raw (unrounded) FPS for accurate comparison, fall back to rounded if unavailable
      const baselineFps = baselineTest.fpsRaw ?? baselineTest.fps;
      const currentFps = currentTest.fpsRaw ?? currentTest.fps;

      // Calculate changes using raw values for precision
      const fpsChange = baselineFps > 0
        ? ((currentFps - baselineFps) / baselineFps) * 100
        : 0;
      const frameTimeChange = baselineTest.avgFrameTime > 0
        ? ((currentTest.avgFrameTime - baselineTest.avgFrameTime) / baselineTest.avgFrameTime) * 100
        : 0;

      // Calculate statistical significance (basic approach using stdDev)
      const baselineStdDev = baselineTest.stdDev ?? 0;
      const currentStdDev = currentTest.stdDev ?? 0;
      const pooledStdDev = Math.sqrt((baselineStdDev ** 2 + currentStdDev ** 2) / 2);
      const frameTimeDiff = Math.abs(currentTest.avgFrameTime - baselineTest.avgFrameTime);
      const isStatisticallySignificant = pooledStdDev > 0
        ? frameTimeDiff > (pooledStdDev * 2) // > 2 standard deviations
        : true;

      comparisons.push({
        name: currentTest.name,
        baseline: {
          fps: baselineTest.fps,
          fpsRaw: baselineFps,
          avgFrameTime: baselineTest.avgFrameTime,
          stdDev: baselineStdDev
        },
        current: {
          fps: currentTest.fps,
          fpsRaw: currentFps,
          avgFrameTime: currentTest.avgFrameTime,
          stdDev: currentStdDev
        },
        changes: {
          fpsChange,
          frameTimeChange,
          absoluteFpsDiff: currentFps - baselineFps,
          absoluteFrameTimeDiff: currentTest.avgFrameTime - baselineTest.avgFrameTime,
          isRegression: fpsChange < -regressionThreshold,
          isImprovement: fpsChange > improvementThreshold,
          isStatisticallySignificant,
          severity: fpsChange < -criticalThreshold ? 'critical'
            : fpsChange < -warningThreshold ? 'warning'
            : fpsChange > improvementThreshold ? 'improved'
            : 'ok'
        }
      });
    }

    // Calculate overall summary statistics
    const avgFpsChange = comparisons.length > 0
      ? comparisons.reduce((sum, c) => sum + c.changes.fpsChange, 0) / comparisons.length
      : 0;

    return {
      comparisons,
      summary: {
        regressions: comparisons.filter(c => c.changes.isRegression).length,
        improvements: comparisons.filter(c => c.changes.isImprovement).length,
        stable: comparisons.filter(c => !c.changes.isRegression && !c.changes.isImprovement).length,
        significantChanges: comparisons.filter(c => c.changes.isStatisticallySignificant &&
          (c.changes.isRegression || c.changes.isImprovement)).length,
        avgFpsChange,
        overallStatus: avgFpsChange < -criticalThreshold ? 'critical'
          : avgFpsChange < -warningThreshold ? 'warning'
          : avgFpsChange > improvementThreshold ? 'improved'
          : 'stable'
      }
    };
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    if (this.gpuTimer) {
      this.gpuTimer.dispose();
      this.gpuTimer = null;
    }
    this.isActive = false;
  }

  /**
   * Initialize GPU timer for precise GPU timing measurements
   * @returns {GPUTimer|null} GPU timer instance or null if unavailable
   */
  initGPUTimer() {
    if (!this.renderer) {
      console.warn('[HighPerfBenchmark] Renderer not initialized, cannot create GPU timer');
      return null;
    }
    const gl = this.renderer.gl;
    if (!gl) return null;

    this.gpuTimer = new GPUTimer(gl);
    return this.gpuTimer;
  }

  /**
   * Run a benchmark multiple times and average the results for reliability
   * @param {string} name - Test name
   * @param {number} runs - Number of runs to average
   * @param {number} frames - Frames per run
   * @param {number} warmupFrames - Warmup frames per run
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Averaged results with statistical analysis
   */
  async runMultiRunBenchmark(name, runs = 3, frames = 60, warmupFrames = 10, options = {}) {
    const {
      cooldownMs = 500,      // Time between runs to let GPU cool
      removeOutliers = true,  // Remove statistical outliers
      outlierThreshold = 2.5  // IQR multiplier for outlier detection
    } = options;

    const allResults = [];
    const memorySnapshots = [];

    console.log(`[Benchmark] Starting ${runs}-run benchmark: ${name}`);

    for (let run = 0; run < runs; run++) {
      // Track memory before run
      const memBefore = this._getMemorySnapshot();

      // Wait for cooldown between runs (except first)
      if (run > 0 && cooldownMs > 0) {
        await new Promise(resolve => setTimeout(resolve, cooldownMs));
      }

      const result = await this._runTimedTest(`${name} (run ${run + 1})`, frames, warmupFrames);
      allResults.push(result);

      // Track memory after run
      const memAfter = this._getMemorySnapshot();
      memorySnapshots.push({
        run: run + 1,
        before: memBefore,
        after: memAfter,
        delta: memAfter && memBefore ? memAfter.usedMB - memBefore.usedMB : null
      });

      console.log(`[Benchmark] Run ${run + 1}/${runs}: ${result.fps} FPS, ${result.avgFrameTime.toFixed(2)}ms avg`);
    }

    // Collect all frame times across runs
    let allFrameTimes = allResults.flatMap(r => r.rawFrameTimes);

    // Detect and optionally remove outliers
    const outlierAnalysis = this._detectOutliers(allFrameTimes, outlierThreshold);

    if (removeOutliers && outlierAnalysis.outliers.length > 0) {
      allFrameTimes = outlierAnalysis.filtered;
      console.log(`[Benchmark] Removed ${outlierAnalysis.outliers.length} outliers`);
    }

    // Calculate combined statistics
    const sorted = [...allFrameTimes].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const fps = 1000 / avg;

    // Standard deviation
    const sumSquares = sorted.reduce((a, b) => a + b * b, 0);
    const variance = (sumSquares / n) - (avg * avg);
    const stdDev = Math.sqrt(Math.max(0, variance));

    // Confidence interval (95%)
    const standardError = stdDev / Math.sqrt(n);
    const marginOfError = 1.96 * standardError; // 95% CI
    const confidenceInterval = {
      lower: avg - marginOfError,
      upper: avg + marginOfError,
      marginOfError,
      confidenceLevel: 0.95
    };

    // Percentiles
    const getPercentile = (p) => {
      if (n === 0) return 0;
      if (n === 1) return sorted[0];
      const idx = p * (n - 1);
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      if (lower === upper) return sorted[lower];
      const frac = idx - lower;
      return sorted[lower] * (1 - frac) + sorted[upper] * frac;
    };

    // Detect thermal throttling (performance degradation across runs)
    const thermalAnalysis = this._detectThermalThrottling(allResults);

    // Jank analysis
    const jankThreshold = avg * 1.5;
    const jankFrames = allFrameTimes.filter(t => t > jankThreshold).length;

    return {
      name,
      runs,
      // Combined metrics
      fps: Math.round(fps),
      fpsRaw: fps,
      avgFrameTime: avg,
      minFrameTime: sorted[0],
      maxFrameTime: sorted[n - 1],
      medianFrameTime: getPercentile(0.50),
      p95FrameTime: getPercentile(0.95),
      p99FrameTime: getPercentile(0.99),
      stdDev,
      variance,

      // Statistical reliability
      confidenceInterval,
      coefficientOfVariation: (stdDev / avg) * 100, // CV as percentage

      // Outlier info
      outlierAnalysis: {
        detected: outlierAnalysis.outliers.length,
        removed: removeOutliers ? outlierAnalysis.outliers.length : 0,
        threshold: outlierThreshold
      },

      // Jank
      jankFrames,
      jankPercent: (jankFrames / n) * 100,

      // Thermal throttling
      thermalThrottling: thermalAnalysis,

      // Memory
      memoryAnalysis: {
        snapshots: memorySnapshots,
        avgDelta: memorySnapshots.filter(m => m.delta != null).reduce((s, m) => s + m.delta, 0) /
          memorySnapshots.filter(m => m.delta != null).length || null
      },

      // Per-run breakdown
      perRunResults: allResults.map(r => ({
        fps: r.fps,
        avgFrameTime: r.avgFrameTime,
        stdDev: r.stdDev
      })),

      // Raw data
      totalFrames: n,
      rawFrameTimes: allFrameTimes
    };
  }

  /**
   * Detect statistical outliers using IQR method
   * @private
   */
  _detectOutliers(frameTimes, threshold = 2.5) {
    if (frameTimes.length < 4) {
      return { outliers: [], filtered: frameTimes, bounds: null };
    }

    const sorted = [...frameTimes].sort((a, b) => a - b);
    const n = sorted.length;

    // Calculate quartiles
    const q1Idx = Math.floor(n * 0.25);
    const q3Idx = Math.floor(n * 0.75);
    const q1 = sorted[q1Idx];
    const q3 = sorted[q3Idx];
    const iqr = q3 - q1;

    // Define outlier bounds
    const lowerBound = q1 - threshold * iqr;
    const upperBound = q3 + threshold * iqr;

    const outliers = [];
    const filtered = [];

    for (const value of frameTimes) {
      if (value < lowerBound || value > upperBound) {
        outliers.push(value);
      } else {
        filtered.push(value);
      }
    }

    return {
      outliers,
      filtered,
      bounds: { lower: lowerBound, upper: upperBound, q1, q3, iqr }
    };
  }

  /**
   * Detect thermal throttling by analyzing performance degradation across runs
   * @private
   */
  _detectThermalThrottling(runResults) {
    if (runResults.length < 2) {
      return { detected: false, severity: 'none', message: 'Insufficient runs for analysis' };
    }

    // Compare first run vs last run FPS
    const firstRun = runResults[0];
    const lastRun = runResults[runResults.length - 1];
    const fpsDropPercent = ((firstRun.fps - lastRun.fps) / firstRun.fps) * 100;

    // Calculate trend across all runs
    const fpsTrend = runResults.map((r, i) => ({ run: i + 1, fps: r.fps }));
    const avgFpsChange = runResults.slice(1).reduce((sum, r, i) => {
      return sum + (r.fps - runResults[i].fps);
    }, 0) / (runResults.length - 1);

    let severity = 'none';
    let detected = false;
    let message = 'No thermal throttling detected';

    if (fpsDropPercent > 15) {
      severity = 'severe';
      detected = true;
      message = `Severe throttling: ${fpsDropPercent.toFixed(1)}% FPS drop from first to last run`;
    } else if (fpsDropPercent > 8) {
      severity = 'moderate';
      detected = true;
      message = `Moderate throttling: ${fpsDropPercent.toFixed(1)}% FPS drop`;
    } else if (fpsDropPercent > 3) {
      severity = 'mild';
      detected = true;
      message = `Mild throttling: ${fpsDropPercent.toFixed(1)}% FPS drop`;
    }

    return {
      detected,
      severity,
      message,
      fpsDropPercent,
      avgFpsChange,
      trend: fpsTrend,
      recommendation: detected
        ? 'Consider adding longer cooldown between runs or reducing test duration'
        : null
    };
  }

  /**
   * Get current memory snapshot (Chrome only)
   * @private
   */
  _getMemorySnapshot() {
    if (typeof performance !== 'undefined' && performance.memory) {
      return {
        usedMB: performance.memory.usedJSHeapSize / (1024 * 1024),
        totalMB: performance.memory.totalJSHeapSize / (1024 * 1024),
        limitMB: performance.memory.jsHeapSizeLimit / (1024 * 1024)
      };
    }
    return null;
  }

  /**
   * Validate benchmark results for sanity
   * @param {Object} results - Benchmark results to validate
   * @returns {Object} Validation result with issues array
   */
  validateResults(results) {
    const issues = [];

    // Check FPS is reasonable
    if (results.fps <= 0) {
      issues.push({ severity: 'error', field: 'fps', message: 'FPS is zero or negative' });
    } else if (results.fps > 1000) {
      issues.push({ severity: 'warning', field: 'fps', message: 'FPS unrealistically high (>1000)' });
    }

    // Check frame times are positive
    if (results.avgFrameTime <= 0) {
      issues.push({ severity: 'error', field: 'avgFrameTime', message: 'Average frame time is zero or negative' });
    }

    // Check min/max relationship
    if (results.minFrameTime > results.maxFrameTime) {
      issues.push({ severity: 'error', field: 'minMaxFrameTime', message: 'Min frame time > max frame time' });
    }

    // Check percentile ordering
    if (results.medianFrameTime > results.p95FrameTime) {
      issues.push({ severity: 'warning', field: 'percentiles', message: 'Median > P95 (unexpected)' });
    }
    if (results.p95FrameTime > results.p99FrameTime) {
      issues.push({ severity: 'warning', field: 'percentiles', message: 'P95 > P99 (unexpected)' });
    }

    // Check standard deviation is non-negative
    if (results.stdDev < 0) {
      issues.push({ severity: 'error', field: 'stdDev', message: 'Standard deviation is negative' });
    }

    // Check jank percentage is in valid range
    if (results.jankPercent < 0 || results.jankPercent > 100) {
      issues.push({ severity: 'error', field: 'jankPercent', message: 'Jank percentage out of range [0, 100]' });
    }

    // Check frame count matches raw data
    if (results.rawFrameTimes && results.frames !== results.rawFrameTimes.length) {
      issues.push({
        severity: 'warning',
        field: 'frames',
        message: `Frame count (${results.frames}) doesn't match raw data length (${results.rawFrameTimes.length})`
      });
    }

    // Check coefficient of variation (high = unstable)
    if (results.coefficientOfVariation && results.coefficientOfVariation > 50) {
      issues.push({
        severity: 'warning',
        field: 'stability',
        message: `High coefficient of variation (${results.coefficientOfVariation.toFixed(1)}%) indicates unstable performance`
      });
    }

    return {
      valid: issues.filter(i => i.severity === 'error').length === 0,
      issues,
      errorCount: issues.filter(i => i.severity === 'error').length,
      warningCount: issues.filter(i => i.severity === 'warning').length
    };
  }

  /**
   * Save benchmark results to localStorage as a baseline
   * @param {Object} results - Benchmark results
   * @param {string} key - Storage key
   */
  saveBaseline(results, key = 'benchmark-baseline') {
    if (typeof localStorage === 'undefined') {
      console.warn('[HighPerfBenchmark] localStorage not available');
      return false;
    }

    const baseline = {
      results,
      savedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null
    };

    try {
      localStorage.setItem(key, JSON.stringify(baseline));
      console.log(`[HighPerfBenchmark] Baseline saved to "${key}"`);
      return true;
    } catch (e) {
      console.error('[HighPerfBenchmark] Failed to save baseline:', e);
      return false;
    }
  }

  /**
   * Load baseline from localStorage
   * @param {string} key - Storage key
   * @returns {Object|null} Baseline data or null
   */
  loadBaseline(key = 'benchmark-baseline') {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    try {
      const data = localStorage.getItem(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (e) {
      console.error('[HighPerfBenchmark] Failed to load baseline:', e);
      return null;
    }
  }

  /**
   * Delete baseline from localStorage
   * @param {string} key - Storage key
   */
  deleteBaseline(key = 'benchmark-baseline') {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  }

  /**
   * Run benchmark with GPU timing (if available)
   * @param {string} name - Test name
   * @param {number} frames - Number of frames
   * @param {number} warmupFrames - Warmup frames
   * @returns {Promise<Object>} Results including GPU timing
   */
  async runTimedTestWithGPU(name, frames = 60, warmupFrames = 10) {
    // Initialize GPU timer if not already done
    if (!this.gpuTimer) {
      this.initGPUTimer();
    }

    const result = await this._runTimedTestWithGPUTiming(name, frames, warmupFrames);
    return result;
  }

  /**
   * Internal method to run timed test with GPU timing
   * @private
   */
  async _runTimedTestWithGPUTiming(name, frames, warmupFrames = 10) {
    return new Promise((resolve) => {
      const frameTimes = [];
      const gpuFrameTimes = [];
      let totalFrameAttempts = 0;
      let warmupCount = 0;
      let lastFrameStart = performance.now();

      const measure = () => {
        const now = performance.now();
        const frameTime = now - lastFrameStart;
        lastFrameStart = now;

        // Poll GPU timer for completed results
        if (this.gpuTimer) {
          const gpuResults = this.gpuTimer.poll();
          for (const result of gpuResults) {
            gpuFrameTimes.push(result.gpuTimeMs);
          }
        }

        // Warmup phase
        if (warmupCount < warmupFrames) {
          warmupCount++;
          if (this.gpuTimer) {
            const query = this.gpuTimer.begin('warmup');
            this.render();  // Uses default render params
            this.gpuTimer.end(query);
          } else {
            this.render();  // Uses default render params
          }
          requestAnimationFrame(measure);
          return;
        }

        // Measurement phase
        if (frameTimes.length >= frames) {
          // Final poll for remaining GPU timings
          if (this.gpuTimer) {
            // Give GPU time to finish
            setTimeout(() => {
              const finalResults = this.gpuTimer.poll();
              for (const result of finalResults) {
                gpuFrameTimes.push(result.gpuTimeMs);
              }

              resolve(this._buildResultsWithGPU(name, frameTimes, gpuFrameTimes, totalFrameAttempts, warmupFrames));
            }, 50);
            return;
          }

          resolve(this._buildResultsWithGPU(name, frameTimes, gpuFrameTimes, totalFrameAttempts, warmupFrames));
          return;
        }

        // Render with GPU timing
        if (this.gpuTimer) {
          const query = this.gpuTimer.begin('frame');
          this.render();  // Uses default render params
          this.gpuTimer.end(query);
        } else {
          this.render();  // Uses default render params
        }

        totalFrameAttempts++;

        if (totalFrameAttempts > 1 && frameTime > 0.1 && frameTime < 1000) {
          frameTimes.push(frameTime);
        }

        requestAnimationFrame(measure);
      };

      requestAnimationFrame(measure);
    });
  }

  /**
   * Build results object including GPU timing data
   * @private
   */
  _buildResultsWithGPU(name, frameTimes, gpuFrameTimes, totalFrameAttempts, warmupFrames) {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const fps = 1000 / avg;

    const sumSquares = sorted.reduce((a, b) => a + b * b, 0);
    const variance = (sumSquares / n) - (avg * avg);
    const stdDev = Math.sqrt(Math.max(0, variance));

    const getPercentile = (p) => {
      if (n === 0) return 0;
      if (n === 1) return sorted[0];
      const idx = p * (n - 1);
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      if (lower === upper) return sorted[lower];
      const frac = idx - lower;
      return sorted[lower] * (1 - frac) + sorted[upper] * frac;
    };

    // GPU timing statistics
    let gpuStats = null;
    if (gpuFrameTimes.length > 0) {
      const gpuSorted = [...gpuFrameTimes].sort((a, b) => a - b);
      const gpuSum = gpuSorted.reduce((a, b) => a + b, 0);
      const gpuAvg = gpuSum / gpuSorted.length;
      gpuStats = {
        avgGpuTime: gpuAvg,
        minGpuTime: gpuSorted[0],
        maxGpuTime: gpuSorted[gpuSorted.length - 1],
        samples: gpuSorted.length,
        gpuBoundRatio: gpuAvg / avg // Ratio of GPU time to total frame time
      };
    }

    const jankThreshold = avg * 1.5;
    const jankFrames = frameTimes.filter(t => t > jankThreshold).length;

    return {
      name,
      avgFrameTime: avg,
      fps: Math.round(fps),
      fpsRaw: fps,
      minFrameTime: sorted[0],
      maxFrameTime: sorted[n - 1],
      medianFrameTime: getPercentile(0.50),
      p95FrameTime: getPercentile(0.95),
      p99FrameTime: getPercentile(0.99),
      stdDev,
      frames: n,
      totalFrameAttempts,
      warmupFrames,
      jankFrames,
      jankPercent: (jankFrames / n) * 100,
      gpuTiming: gpuStats,
      rawFrameTimes: frameTimes,
      rawGpuFrameTimes: gpuFrameTimes.length > 0 ? gpuFrameTimes : null
    };
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
  static octopus(count, numTentacles = 10) {
    console.log(`Generating ${count.toLocaleString()} points (octopus with ${numTentacles} tentacles)...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    // Body parameters - denser core to force overdraw
    const bodyRadius = 0.36;
    const bodyCenter = [0, 0.28, 0];
    const bodyFreq = 0.4; // 40% of points in body to create dense cluster
    const bodyHotspots = Array.from({ length: 5 }, () => ({
      theta: Math.random() * Math.PI * 2,
      phi: Math.PI * 0.5 + (Math.random() - 0.5) * 0.4,
      boost: 0.4 + Math.random() * 0.7
    }));

    // Tentacle parameters - tighter curls with self-intersections
    const tentacleLength = 1.1;
    const tentacleThickness = 0.055;
    const tentacleWave = 0.18; // wave amplitude
    const tentacleFreq = (1 - bodyFreq) / numTentacles;

    // Body color (reddish-orange)
    const bodyColor = [0.9, 0.4, 0.3];

    // Generate tentacle base angles
    const tentacles = [];
    for (let t = 0; t < numTentacles; t++) {
      const baseAngle = (t / numTentacles) * Math.PI * 2 + (Math.random() - 0.5) * 0.28;
      const tiltAngle = Math.PI * 0.58 + (Math.random() - 0.5) * 0.32; // angle from vertical
      const hue = 0.02 + t * 0.015; // slight color variation per tentacle
      const wrapTurns = 2.5 + Math.random() * 2.5; // coils around body
      const wrapRadius = 0.35 + Math.random() * 0.35;
      const wrapPhase = Math.random() * Math.PI * 2;
      const wobblePhase = Math.random() * Math.PI * 2;
      const suctionBands = 3 + Math.floor(Math.random() * 4);
      tentacles.push({ baseAngle, tiltAngle, hue, wrapTurns, wrapRadius, wrapPhase, wobblePhase, suctionBands });
    }

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const r = Math.random();

      if (r < bodyFreq) {
        // Body point - lumpy ellipsoid with dense core
        const hotspot = bodyHotspots[Math.floor(Math.random() * bodyHotspots.length)];
        const useHotspot = Math.random() < 0.65;
        const theta = useHotspot ? hotspot.theta + (Math.random() - 0.5) * 0.35 : Math.random() * Math.PI * 2;
        const phi = useHotspot ? hotspot.phi + (Math.random() - 0.5) * 0.35 : Math.acos(2 * Math.random() - 1);
        const radiusScale = useHotspot ? hotspot.boost : 1;
        const radius = bodyRadius * (0.3 + Math.pow(Math.random(), useHotspot ? 1.35 : 1.8) * 0.9) * radiusScale;

        positions[idx] = bodyCenter[0] + radius * Math.sin(phi) * Math.cos(theta) * 1.35;
        positions[idx + 1] = bodyCenter[1] + radius * Math.cos(phi) * 0.9;
        positions[idx + 2] = bodyCenter[2] + radius * Math.sin(phi) * Math.sin(theta) * 1.35;

        // Body color with variation (convert to uint8)
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, bodyColor[0] + (Math.random() - 0.5) * 0.12)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, bodyColor[1] + (Math.random() - 0.5) * 0.12)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, bodyColor[2] + (Math.random() - 0.5) * 0.12)) * 255);
        colors[cidx + 3] = 255; // full alpha
      } else {
        // Tentacle point
        const tentacleIdx = Math.floor((r - bodyFreq) / tentacleFreq);
        const tent = tentacles[Math.min(tentacleIdx, numTentacles - 1)];

        // Position along tentacle (0 = base, 1 = tip), biased toward base for density
        const t = Math.pow(Math.random(), 1.35);
        const thickness = tentacleThickness * (1.1 - t * 0.5); // thicker near base

        // Base position where tentacle attaches to body
        const baseX = bodyCenter[0] + bodyRadius * 0.85 * Math.sin(tent.tiltAngle) * Math.cos(tent.baseAngle);
        const baseY = bodyCenter[1] - bodyRadius * 0.55 + this._gaussianRandom() * 0.015;
        const baseZ = bodyCenter[2] + bodyRadius * 0.85 * Math.sin(tent.tiltAngle) * Math.sin(tent.baseAngle);

        // Tentacle curls around body with high-frequency wobble
        const wave1 = Math.sin(t * Math.PI * 4 + tent.wobblePhase) * tentacleWave * t * 1.2;
        const wave2 = Math.cos(t * Math.PI * 3.5 + tent.wobblePhase * 0.8) * tentacleWave * t;

        const wrapAngle = tent.wrapPhase + t * tent.wrapTurns * Math.PI * 2;
        const wrapR = tent.wrapRadius * (1 - t * 0.35);
        const swirlX = Math.cos(wrapAngle) * wrapR;
        const swirlZ = Math.sin(wrapAngle) * wrapR;

        const bend = Math.sin(t * Math.PI * tent.suctionBands) * 0.25;

        const tentX = baseX + t * tentacleLength * Math.sin(tent.tiltAngle + bend * 0.35) * Math.cos(tent.baseAngle + bend) + wave1 + swirlX;
        const tentY = baseY - t * tentacleLength * (0.95 - 0.25 * t) + Math.sin(t * Math.PI * 2) * 0.05;
        const tentZ = baseZ + t * tentacleLength * Math.sin(tent.tiltAngle + bend * 0.35) * Math.sin(tent.baseAngle + bend) + wave2 + swirlZ;

        // Add thickness with suction-band clumping
        const thickAngle = Math.random() * Math.PI * 2;
        const ring = (Math.sin(t * tent.suctionBands * Math.PI * 2 + tent.wobblePhase) + 1) * 0.5;
        const thickR = Math.sqrt(Math.random()) * thickness * (1 + ring * 0.65);

        positions[idx] = tentX + thickR * Math.cos(thickAngle);
        positions[idx + 1] = tentY + thickR * Math.sin(thickAngle) * 0.6;
        positions[idx + 2] = tentZ + thickR * Math.sin(thickAngle);

        // Tentacle color - gradient with darker tips and band highlights (convert to uint8)
        const tentColor = this._hslToRgb(tent.hue, 0.72, 0.48 - t * 0.22 + ring * 0.08);
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, tentColor[0] + (Math.random() - 0.5) * 0.08)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, tentColor[1] + (Math.random() - 0.5) * 0.08)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, tentColor[2] + (Math.random() - 0.5) * 0.08)) * 255);
        colors[cidx + 3] = 255; // full alpha
      }
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }

  /**
   * Generate 3D spiral/helix structures
   */
  static spirals(count, numSpirals = 7) {
    console.log(`Generating ${count.toLocaleString()} points (${numSpirals} spirals)...`);
    const startTime = performance.now();

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4); // RGBA packed as uint8

    // Generate spiral configurations
    const spiralConfigs = [];
    const globalBraidPhase = Math.random() * Math.PI * 2;
    for (let s = 0; s < numSpirals; s++) {
      spiralConfigs.push({
        // Starting position
        startX: (Math.random() - 0.5) * 0.8,
        startY: (Math.random() - 0.5) * 0.8,
        startZ: (Math.random() - 0.5) * 0.8,
        // Direction (normalized)
        dirTheta: Math.random() * Math.PI * 2,
        dirPhi: Math.PI * 0.35 + Math.random() * Math.PI * 0.6,
        // Spiral parameters
        radius: 0.18 + Math.random() * 0.18,
        length: 0.9 + Math.random() * 1.1,
        turns: 4 + Math.random() * 4,
        thickness: 0.035 + Math.random() * 0.035,
        // Color
        hue: s / Math.max(1, numSpirals - 1),
        // Taper
        taper: Math.random() < 0.65,
        orbitRadius: 0.25 + Math.random() * 0.25,
        orbitTurns: 2 + Math.random() * 3,
        strandCount: 2 + Math.floor(Math.random() * 3),
        kink: 0.06 + Math.random() * 0.08,
        noiseFreq: 2 + Math.random() * 4,
        orbitPhase: globalBraidPhase + (Math.random() - 0.5) * Math.PI
      });
    }

    const pointsPerSpiral = Math.max(1, Math.floor(count / numSpirals));

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const spiralIdx = Math.min(Math.floor(i / pointsPerSpiral), numSpirals - 1);
      const sp = spiralConfigs[spiralIdx];

      // Position along spiral (0-1), biased to start for heavier overlap
      const t = Math.pow(Math.random(), 1.25);

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

      // Spiral angle with added turbulence and braiding
      const orbitAngle = sp.orbitPhase + t * sp.orbitTurns * Math.PI * 2;
      const orbitR = sp.orbitRadius * (1 - t * 0.3);

      const strandPhase = (Math.floor(Math.random() * sp.strandCount) / sp.strandCount) * Math.PI * 2;
      const wobble = Math.sin(t * sp.noiseFreq * Math.PI * 2 + sp.orbitPhase) * sp.kink +
        Math.cos(t * sp.noiseFreq * Math.PI + sp.orbitPhase * 0.5) * sp.kink * 0.5;

      const angle = t * sp.turns * Math.PI * 2 + strandPhase + wobble;
      const radius = sp.taper ? sp.radius * (1 - t * 0.6) : sp.radius;

      // Position on spiral with braiding around a shared core
      const spiralX = sp.startX + t * sp.length * dirX + radius * (Math.cos(angle) * perpX + Math.sin(angle) * perp2X);
      const spiralY = sp.startY + t * sp.length * dirY + radius * (Math.sin(angle) * perp2Y + Math.cos(angle) * 0.05);
      const spiralZ = sp.startZ + t * sp.length * dirZ + radius * (Math.cos(angle) * perpZ + Math.sin(angle) * perp2Z);

      const braidedX = spiralX + Math.cos(orbitAngle) * orbitR;
      const braidedY = spiralY + Math.sin(orbitAngle * 0.5) * sp.kink * 0.8;
      const braidedZ = spiralZ + Math.sin(orbitAngle) * orbitR;

      // Add thickness
      const thick = sp.thickness * (1.25 - t * 0.35);
      positions[idx] = braidedX + this._gaussianRandom() * thick;
      positions[idx + 1] = braidedY + this._gaussianRandom() * thick * 0.9;
      positions[idx + 2] = braidedZ + this._gaussianRandom() * thick;

      // Color gradient along spiral (convert to uint8)
      const band = (Math.sin(angle * 0.5 + sp.orbitPhase) + 1) * 0.12;
      const color = this._hslToRgb((sp.hue + t * 0.12 + band * 0.1) % 1, 0.78, 0.42 + t * 0.18 + band * 0.15);
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, color[0] + (Math.random() - 0.5) * 0.08)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, color[1] + (Math.random() - 0.5) * 0.08)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, color[2] + (Math.random() - 0.5) * 0.08)) * 255);
      colors[cidx + 3] = 255; // full alpha
    }

    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
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
    return { positions, colors, dimensionLevel: 2 };
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
    return { positions, colors, dimensionLevel: 3 };
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

    return { positions, colors, dimensionLevel: 3 };
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

    return { positions, colors, dimensionLevel: 3 };
  }

  /**
   * Generate points by sampling from a GLB mesh surface
   * @param {number} count - Number of points to generate
   * @param {ArrayBuffer} glbBuffer - The loaded GLB file as ArrayBuffer
   * @returns {Object} - { positions: Float32Array, colors: Uint8Array (RGBA), dimensionLevel: number }
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

    return { positions, colors, dimensionLevel: 3 };
  }

  /**
   * Load GLB file from URL and sample points
   * @param {number} count - Number of points to generate
   * @param {string} url - URL to the GLB file
   * @returns {Promise<Object>} - { positions: Float32Array, colors: Uint8Array (RGBA), dimensionLevel: number }
   */
  static async fromGLBUrl(count, url = 'assets/img/kemal-inecik.glb') {
    const resolvedUrl = typeof window !== 'undefined'
      ? new URL(url, window.location.href).toString()
      : url;
    console.log(`Loading GLB from: ${resolvedUrl}`);
    const response = await fetch(resolvedUrl, { cache: 'no-store' });
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
 * GPU Timer using EXT_disjoint_timer_query_webgl2 extension
 *
 * Provides precise GPU timing measurements using async query objects.
 * Falls back gracefully when the extension is unavailable.
 */
export class GPUTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = null;
    this.available = false;
    this.pendingQueries = [];
    this.completedTimings = [];
    this.maxCompletedTimings = 120;

    this._init();
  }

  _init() {
    if (!this.gl) return;

    // Try to get the timer query extension
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!this.ext) {
      // Try WebGL1 version as fallback
      this.ext = this.gl.getExtension('EXT_disjoint_timer_query');
    }

    this.available = !!this.ext;

    if (this.available) {
      console.log('[GPUTimer] EXT_disjoint_timer_query available');
    } else {
      console.log('[GPUTimer] GPU timing extension not available; using fallback');
    }
  }

  /**
   * Check if GPU timing is available
   */
  isAvailable() {
    return this.available;
  }

  /**
   * Begin a GPU timing measurement
   * @param {string} label - Label for this measurement
   * @returns {Object|null} Query object or null if unavailable
   */
  begin(label = 'frame') {
    if (!this.available) return null;

    const gl = this.gl;
    const query = gl.createQuery();

    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);

    return { query, label, startTime: performance.now() };
  }

  /**
   * End a GPU timing measurement
   * @param {Object} queryInfo - Query object from begin()
   */
  end(queryInfo) {
    if (!this.available || !queryInfo) return;

    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);

    queryInfo.endCPUTime = performance.now();
    this.pendingQueries.push(queryInfo);
  }

  /**
   * Poll for completed query results (non-blocking)
   * Call this periodically (e.g., each frame) to collect results
   * @returns {Array} Array of completed timing results
   */
  poll() {
    if (!this.available || this.pendingQueries.length === 0) {
      return [];
    }

    const gl = this.gl;
    const completed = [];

    // Check for GPU disjoint (timer was interrupted)
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);

    // Process pending queries
    const stillPending = [];
    for (const queryInfo of this.pendingQueries) {
      const available = gl.getQueryParameter(queryInfo.query, gl.QUERY_RESULT_AVAILABLE);

      if (available) {
        if (disjoint) {
          // Timer was interrupted, discard this result
          gl.deleteQuery(queryInfo.query);
          continue;
        }

        // Get the result (in nanoseconds)
        const gpuTimeNs = gl.getQueryParameter(queryInfo.query, gl.QUERY_RESULT);
        const gpuTimeMs = gpuTimeNs / 1_000_000;

        const result = {
          label: queryInfo.label,
          gpuTimeMs,
          cpuTimeMs: queryInfo.endCPUTime - queryInfo.startTime,
          timestamp: queryInfo.startTime
        };

        completed.push(result);
        this.completedTimings.push(result);

        // Trim completed timings
        if (this.completedTimings.length > this.maxCompletedTimings) {
          this.completedTimings.shift();
        }

        gl.deleteQuery(queryInfo.query);
      } else {
        stillPending.push(queryInfo);
      }
    }

    this.pendingQueries = stillPending;
    return completed;
  }

  /**
   * Get statistics from completed GPU timings
   * @returns {Object} GPU timing statistics
   */
  getStats() {
    if (this.completedTimings.length === 0) {
      return {
        available: this.available,
        samples: 0,
        avgGpuTimeMs: 0,
        minGpuTimeMs: 0,
        maxGpuTimeMs: 0,
        avgCpuTimeMs: 0,
        gpuCpuRatio: 0
      };
    }

    const gpuTimes = this.completedTimings.map(t => t.gpuTimeMs);
    const cpuTimes = this.completedTimings.map(t => t.cpuTimeMs);

    const avgGpu = gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length;
    const avgCpu = cpuTimes.reduce((a, b) => a + b, 0) / cpuTimes.length;

    return {
      available: this.available,
      samples: this.completedTimings.length,
      avgGpuTimeMs: avgGpu,
      minGpuTimeMs: Math.min(...gpuTimes),
      maxGpuTimeMs: Math.max(...gpuTimes),
      avgCpuTimeMs: avgCpu,
      gpuCpuRatio: avgCpu > 0 ? avgGpu / avgCpu : 0
    };
  }

  /**
   * Clear all timings and pending queries
   */
  reset() {
    // Clean up pending queries
    if (this.available) {
      for (const queryInfo of this.pendingQueries) {
        this.gl.deleteQuery(queryInfo.query);
      }
    }
    this.pendingQueries = [];
    this.completedTimings = [];
  }

  /**
   * Dispose of resources
   */
  dispose() {
    this.reset();
    this.ext = null;
    this.available = false;
  }
}

/**
 * Performance Statistics Tracker
 *
 * Tracks frame timing statistics using a circular buffer for O(1) insertions.
 * Provides comprehensive metrics including percentiles, jank detection,
 * standard deviation, and performance budget tracking.
 */
export class PerformanceTracker {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.maxSamples - Maximum samples to keep (default: 120)
   * @param {number} options.targetFrameTime - Target frame time in ms for budget tracking (default: 16.67 for 60fps)
   * @param {number} options.jankThreshold - Multiplier for detecting jank frames (default: 1.5x average)
   * @param {number} options.warmupFrames - Number of initial frames to skip (default: 3)
   */
  constructor(options = {}) {
    this.maxSamples = options.maxSamples ?? 120;
    this.targetFrameTime = options.targetFrameTime ?? 16.67; // 60fps target
    this.jankThreshold = options.jankThreshold ?? 1.5;
    this.warmupFrames = options.warmupFrames ?? 3;

    // Circular buffer for O(1) insertions
    this._buffer = new Float64Array(this.maxSamples);
    this._head = 0;
    this._count = 0;

    // Frame tracking
    this.lastTime = 0;
    this.running = false;
    this._frameNumber = 0;
    this._warmupComplete = false;

    // Cumulative stats (for efficiency)
    this._sum = 0;
    this._sumSquares = 0;
    this._min = Infinity;
    this._max = -Infinity;

    // Jank tracking
    this._jankFrames = 0;
    this._consecutiveJanks = 0;
    this._maxConsecutiveJanks = 0;

    // Budget tracking
    this._overBudgetFrames = 0;

    // Historical snapshots for trend analysis
    this._history = [];
    this._historyMaxSize = 60; // Keep last 60 snapshots
    this._lastSnapshotTime = 0;
    this._snapshotInterval = 1000; // Snapshot every 1 second
  }

  /**
   * Start tracking frames
   */
  start() {
    this.reset();
    this.lastTime = performance.now();
    this.running = true;
  }

  /**
   * Reset all statistics
   */
  reset() {
    this._buffer.fill(0);
    this._head = 0;
    this._count = 0;
    this._sum = 0;
    this._sumSquares = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._frameNumber = 0;
    this._warmupComplete = false;
    this._jankFrames = 0;
    this._consecutiveJanks = 0;
    this._maxConsecutiveJanks = 0;
    this._overBudgetFrames = 0;
    this._history = [];
    this._lastSnapshotTime = 0;
  }

  /**
   * Record a frame and return current statistics
   * @returns {Object|null} Current statistics or null if not running
   */
  recordFrame() {
    if (!this.running) return null;

    const now = performance.now();
    const frameTime = now - this.lastTime;
    this.lastTime = now;
    this._frameNumber++;

    // Skip warmup frames (usually have initialization overhead)
    if (this._frameNumber <= this.warmupFrames) {
      return this.getStats();
    }
    this._warmupComplete = true;

    // Skip obviously invalid frames (e.g., tab was hidden)
    if (frameTime > 1000 || frameTime < 0.1) {
      return this.getStats();
    }

    // Calculate jank threshold BEFORE adding the current frame
    // This prevents the current frame from affecting its own jank detection
    const prevCount = this._count;
    const prevAvg = prevCount > 0 ? this._sum / prevCount : this.targetFrameTime;
    const jankThreshold = prevAvg * this.jankThreshold;

    // Add to circular buffer
    this._addSample(frameTime);

    // Update budget tracking
    if (frameTime > this.targetFrameTime) {
      this._overBudgetFrames++;
    }

    // Detect jank using the previous average (before this frame was added)
    const isJank = frameTime > jankThreshold;
    if (isJank) {
      this._jankFrames++;
      this._consecutiveJanks++;
      this._maxConsecutiveJanks = Math.max(this._maxConsecutiveJanks, this._consecutiveJanks);
    } else {
      this._consecutiveJanks = 0;
    }

    // Take periodic snapshots for trend analysis
    if (now - this._lastSnapshotTime > this._snapshotInterval && this._count >= 10) {
      this._takeSnapshot(now);
    }

    return this.getStats();
  }

  /**
   * Add a sample to the circular buffer
   * @private
   */
  _addSample(frameTime) {
    // Track if we need to recalculate min/max
    let needsMinMaxRecalc = false;

    // Remove oldest value from cumulative stats if buffer is full
    if (this._count === this.maxSamples) {
      const oldValue = this._buffer[this._head];
      this._sum -= oldValue;
      this._sumSquares -= oldValue * oldValue;

      // If we're removing the current min or max, we need to recalculate
      // Use small epsilon for floating point comparison
      if (Math.abs(oldValue - this._min) < 0.001 || Math.abs(oldValue - this._max) < 0.001) {
        needsMinMaxRecalc = true;
      }
    } else {
      this._count++;
    }

    // Add new value
    this._buffer[this._head] = frameTime;
    this._head = (this._head + 1) % this.maxSamples;

    // Update cumulative stats
    this._sum += frameTime;
    this._sumSquares += frameTime * frameTime;

    // Recalculate min/max if needed, otherwise just update incrementally
    if (needsMinMaxRecalc) {
      this._recalculateMinMax();
    } else {
      if (frameTime < this._min) this._min = frameTime;
      if (frameTime > this._max) this._max = frameTime;
    }
  }

  /**
   * Recalculate min/max from current buffer contents
   * @private
   */
  _recalculateMinMax() {
    this._min = Infinity;
    this._max = -Infinity;

    const start = this._count === this.maxSamples ? this._head : 0;
    for (let i = 0; i < this._count; i++) {
      const value = this._buffer[(start + i) % this.maxSamples];
      if (value < this._min) this._min = value;
      if (value > this._max) this._max = value;
    }
  }

  /**
   * Get all samples as a sorted array
   * @private
   */
  _getSortedSamples() {
    const samples = [];
    const start = this._count === this.maxSamples ? this._head : 0;
    for (let i = 0; i < this._count; i++) {
      samples.push(this._buffer[(start + i) % this.maxSamples]);
    }
    return samples.sort((a, b) => a - b);
  }

  /**
   * Take a snapshot for trend analysis
   * @private
   */
  _takeSnapshot(now) {
    const stats = this.getStats();
    this._history.push({
      timestamp: now,
      fps: stats.fps,
      avgFrameTime: stats.avgFrameTime,
      p95FrameTime: stats.p95FrameTime,
      jankPercent: stats.jankPercent
    });

    // Trim history
    if (this._history.length > this._historyMaxSize) {
      this._history.shift();
    }

    this._lastSnapshotTime = now;
  }

  /**
   * Stop tracking
   */
  stop() {
    this.running = false;
  }

  /**
   * Get comprehensive statistics (all values as numbers for consistency)
   * @returns {Object} Statistics object
   */
  getStats() {
    if (this._count === 0) {
      return {
        fps: 0,
        avgFrameTime: 0,
        minFrameTime: 0,
        maxFrameTime: 0,
        medianFrameTime: 0,
        p95FrameTime: 0,
        p99FrameTime: 0,
        stdDev: 0,
        variance: 0,
        samples: 0,
        jankFrames: 0,
        jankPercent: 0,
        maxConsecutiveJanks: 0,
        overBudgetFrames: 0,
        overBudgetPercent: 0,
        budgetMs: this.targetFrameTime,
        warmupComplete: this._warmupComplete
      };
    }

    const sorted = this._getSortedSamples();
    const avg = this._sum / this._count;

    // Calculate standard deviation
    const variance = (this._sumSquares / this._count) - (avg * avg);
    const stdDev = Math.sqrt(Math.max(0, variance));

    // Recalculate accurate min/max from samples
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // Percentiles
    const p50Idx = Math.floor(sorted.length * 0.50);
    const p95Idx = Math.floor(sorted.length * 0.95);
    const p99Idx = Math.floor(sorted.length * 0.99);

    return {
      // Primary metrics (all numbers)
      fps: Math.round(1000 / avg),
      avgFrameTime: avg,
      minFrameTime: min,
      maxFrameTime: max,
      medianFrameTime: sorted[p50Idx] ?? 0,
      p95FrameTime: sorted[p95Idx] ?? max,
      p99FrameTime: sorted[p99Idx] ?? max,

      // Statistical measures
      stdDev: stdDev,
      variance: variance,

      // Sample info
      samples: this._count,
      warmupComplete: this._warmupComplete,

      // Jank metrics
      jankFrames: this._jankFrames,
      jankPercent: this._count > 0 ? (this._jankFrames / this._count) * 100 : 0,
      maxConsecutiveJanks: this._maxConsecutiveJanks,

      // Budget metrics
      overBudgetFrames: this._overBudgetFrames,
      overBudgetPercent: this._count > 0 ? (this._overBudgetFrames / this._count) * 100 : 0,
      budgetMs: this.targetFrameTime,

      // Trend data
      history: this._history.length > 0 ? this._history : null
    };
  }

  /**
   * Get a formatted stats object with string values for display
   * @returns {Object} Formatted statistics
   */
  getFormattedStats() {
    const stats = this.getStats();
    return {
      fps: stats.fps,
      avgFrameTime: stats.avgFrameTime.toFixed(2),
      minFrameTime: stats.minFrameTime.toFixed(2),
      maxFrameTime: stats.maxFrameTime.toFixed(2),
      medianFrameTime: stats.medianFrameTime.toFixed(2),
      p95FrameTime: stats.p95FrameTime.toFixed(2),
      p99FrameTime: stats.p99FrameTime.toFixed(2),
      stdDev: stats.stdDev.toFixed(2),
      samples: stats.samples,
      jankPercent: stats.jankPercent.toFixed(1) + '%',
      overBudgetPercent: stats.overBudgetPercent.toFixed(1) + '%'
    };
  }

  /**
   * Get histogram data for frame time distribution
   * @param {number} bucketCount - Number of buckets (default: 10)
   * @returns {Array} Array of {min, max, count, percent}
   */
  getHistogram(bucketCount = 10) {
    if (this._count === 0) return [];

    const sorted = this._getSortedSamples();
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const range = max - min;

    // Handle edge case where all samples are identical (or nearly identical)
    if (range < 0.001) {
      // All samples are essentially the same value - return single bucket
      return [{
        min: min - 0.5,
        max: max + 0.5,
        count: this._count,
        percent: 100,
        label: `${min.toFixed(2)}ms`
      }];
    }

    // Use actual range for bucket size calculation
    const bucketSize = range / bucketCount;

    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      min: min + i * bucketSize,
      max: min + (i + 1) * bucketSize,
      count: 0,
      percent: 0,
      label: `${(min + i * bucketSize).toFixed(1)}-${(min + (i + 1) * bucketSize).toFixed(1)}ms`
    }));

    for (const value of sorted) {
      const bucketIdx = Math.min(
        Math.floor((value - min) / bucketSize),
        bucketCount - 1
      );
      buckets[bucketIdx].count++;
    }

    for (const bucket of buckets) {
      bucket.percent = (bucket.count / this._count) * 100;
    }

    return buckets;
  }

  /**
   * Detect performance trend (improving, stable, degrading)
   * @returns {Object} Trend analysis
   */
  getTrend() {
    if (this._history.length < 5) {
      return { trend: 'insufficient_data', confidence: 0 };
    }

    const recent = this._history.slice(-5);
    const older = this._history.slice(-10, -5);

    if (older.length === 0) {
      return { trend: 'insufficient_data', confidence: 0 };
    }

    const recentAvgFps = recent.reduce((s, h) => s + h.fps, 0) / recent.length;
    const olderAvgFps = older.reduce((s, h) => s + h.fps, 0) / older.length;

    const change = (recentAvgFps - olderAvgFps) / olderAvgFps;

    if (Math.abs(change) < 0.05) {
      return { trend: 'stable', change, confidence: 0.8 };
    } else if (change > 0) {
      return { trend: 'improving', change, confidence: Math.min(change * 10, 1) };
    } else {
      return { trend: 'degrading', change, confidence: Math.min(-change * 10, 1) };
    }
  }
}

/**
 * Build a copy-ready situation report with environment + renderer state.
 * Designed to work for both real data and synthetic benchmarks.
 *
 * Collects comprehensive information about:
 * - Hardware: CPU, GPU, memory, screen, input devices
 * - Browser: version, features, APIs, extensions
 * - Network: connection type, speed, online status
 * - Performance: memory, timings, frame rates
 * - Website state: DOM, resources, storage, visibility
 * - WebGL: capabilities, extensions, limits
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

  /**
   * Collect comprehensive hardware information
   */
  _collectHardware(nav, scr) {
    const hardware = {
      // CPU
      cpu: {
        cores: nav.hardwareConcurrency || null,
        architecture: this._detectArchitecture(nav)
      },
      // Memory
      memory: {
        deviceMemoryGB: nav.deviceMemory || null,
        jsHeap: this._collectJSHeap()
      },
      // Screen
      screen: {
        width: scr.width || null,
        height: scr.height || null,
        availWidth: scr.availWidth || null,
        availHeight: scr.availHeight || null,
        colorDepth: scr.colorDepth || null,
        pixelDepth: scr.pixelDepth || null,
        orientation: scr.orientation ? {
          type: scr.orientation.type,
          angle: scr.orientation.angle
        } : null
      },
      // Window/Viewport
      viewport: typeof window !== 'undefined' ? {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      } : null,
      // Input devices
      input: {
        maxTouchPoints: nav.maxTouchPoints || 0,
        pointerEnabled: typeof window !== 'undefined' && 'PointerEvent' in window,
        touchEnabled: 'ontouchstart' in (typeof window !== 'undefined' ? window : {}) ||
          (nav.maxTouchPoints || 0) > 0,
        gamepadSupport: 'getGamepads' in nav
      }
    };

    return hardware;
  }

  /**
   * Detect CPU architecture from user agent and platform hints
   */
  _detectArchitecture(nav) {
    const ua = (nav.userAgent || '').toLowerCase();
    const platform = (nav.userAgentData?.platform || nav.platform || '').toLowerCase();
    const combined = ua + ' ' + platform;

    const isArmLike = /arm|aarch64/.test(combined);
    const isApple = /mac/.test(platform) || /macintosh/.test(ua);
    const appleSiliconHint = /apple\s*m[0-9]/i.test(ua) ||
      (nav.userAgentData?.platform === 'macOS' && isArmLike);

    return {
      detected: isArmLike ? 'arm64' : /win64|x86_64|x64|amd64|intel/.test(combined) ? 'x86_64' :
                /win32|x86|i[3-6]86/.test(combined) ? 'x86' : 'unknown',
      isApple,
      appleSiliconHint: Boolean(appleSiliconHint),
      platform: nav.userAgentData?.platform || nav.platform || 'unknown',
      bitness: nav.userAgentData?.bitness || null,
      mobile: nav.userAgentData?.mobile || /mobile|android|iphone|ipad/i.test(ua)
    };
  }

  /**
   * Collect JS heap memory information (Chrome only)
   */
  _collectJSHeap() {
    if (typeof performance !== 'undefined' && performance.memory) {
      const mem = performance.memory;
      return {
        usedMB: mem.usedJSHeapSize ? +(mem.usedJSHeapSize / 1024 / 1024).toFixed(2) : null,
        totalMB: mem.totalJSHeapSize ? +(mem.totalJSHeapSize / 1024 / 1024).toFixed(2) : null,
        limitMB: mem.jsHeapSizeLimit ? +(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(2) : null,
        usagePercent: mem.usedJSHeapSize && mem.jsHeapSizeLimit
          ? +((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1)
          : null,
        available: true
      };
    }
    return { available: false };
  }

  /**
   * Collect comprehensive browser information
   */
  _collectBrowser(nav) {
    const ua = nav.userAgent || '';
    const brands = nav.userAgentData?.brands || [];

    // Parse browser version
    const browserInfo = this._parseBrowserInfo(ua, brands);

    return {
      // Basic info
      ...browserInfo,
      userAgent: ua,
      platform: nav.userAgentData?.platform || nav.platform || 'unknown',
      language: nav.language || null,
      languages: nav.languages ? [...nav.languages] : [],

      // Flags & preferences
      cookiesEnabled: nav.cookieEnabled ?? null,
      doNotTrack: nav.doNotTrack || null,
      pdfViewerEnabled: nav.pdfViewerEnabled ?? null,
      webdriver: nav.webdriver ?? false,

      // Feature detection
      features: {
        serviceWorker: 'serviceWorker' in nav,
        webWorker: typeof Worker !== 'undefined',
        sharedWorker: typeof SharedWorker !== 'undefined',
        webAssembly: typeof WebAssembly !== 'undefined',
        webGL: this._checkWebGLSupport(),
        webGL2: this._checkWebGL2Support(),
        webGPU: 'gpu' in nav,
        indexedDB: 'indexedDB' in (typeof window !== 'undefined' ? window : {}),
        localStorage: this._checkLocalStorage(),
        sessionStorage: this._checkSessionStorage(),
        webSocket: typeof WebSocket !== 'undefined',
        webRTC: typeof RTCPeerConnection !== 'undefined',
        geolocation: 'geolocation' in nav,
        notifications: 'Notification' in (typeof window !== 'undefined' ? window : {}),
        pushManager: 'PushManager' in (typeof window !== 'undefined' ? window : {}),
        bluetooth: 'bluetooth' in nav,
        usb: 'usb' in nav,
        serial: 'serial' in nav,
        hid: 'hid' in nav,
        midi: 'requestMIDIAccess' in nav,
        mediaDevices: 'mediaDevices' in nav,
        mediaSession: 'mediaSession' in nav,
        clipboard: 'clipboard' in nav,
        share: 'share' in nav,
        vibrate: 'vibrate' in nav,
        wakeLock: 'wakeLock' in nav,
        batteryAPI: 'getBattery' in nav,
        credentials: 'credentials' in nav,
        payment: 'PaymentRequest' in (typeof window !== 'undefined' ? window : {}),
        presentation: 'presentation' in nav,
        permissions: 'permissions' in nav,
        locks: 'locks' in nav,
        scheduling: 'scheduling' in nav,
        storageManager: 'storage' in nav && 'estimate' in (nav.storage || {}),
        canvas2D: this._checkCanvas2D(),
        offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
        imageCapture: typeof ImageCapture !== 'undefined',
        intersectionObserver: typeof IntersectionObserver !== 'undefined',
        resizeObserver: typeof ResizeObserver !== 'undefined',
        mutationObserver: typeof MutationObserver !== 'undefined',
        performanceObserver: typeof PerformanceObserver !== 'undefined',
        requestIdleCallback: 'requestIdleCallback' in (typeof window !== 'undefined' ? window : {}),
        requestAnimationFrame: 'requestAnimationFrame' in (typeof window !== 'undefined' ? window : {}),
        fetch: typeof fetch !== 'undefined',
        streams: typeof ReadableStream !== 'undefined',
        intl: typeof Intl !== 'undefined',
        bigInt: typeof BigInt !== 'undefined',
        proxy: typeof Proxy !== 'undefined',
        weakRef: typeof WeakRef !== 'undefined',
        finalizationRegistry: typeof FinalizationRegistry !== 'undefined'
      },

      // Media capabilities
      media: {
        audioContext: typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined',
        mediaRecorder: typeof MediaRecorder !== 'undefined',
        mediaSource: typeof MediaSource !== 'undefined',
        speechSynthesis: 'speechSynthesis' in (typeof window !== 'undefined' ? window : {}),
        speechRecognition: typeof SpeechRecognition !== 'undefined' || typeof webkitSpeechRecognition !== 'undefined'
      }
    };
  }

  /**
   * Parse browser name and version from user agent
   */
  _parseBrowserInfo(ua, brands) {
    // Try userAgentData first (more accurate)
    if (brands && brands.length > 0) {
      const significant = brands.find(b =>
        !b.brand.includes('Not') && !b.brand.includes('Chromium')
      ) || brands.find(b => b.brand === 'Chromium') || brands[0];

      return {
        name: significant?.brand || 'Unknown',
        version: significant?.version || null,
        brands: brands.map(b => `${b.brand} ${b.version}`).join(', ')
      };
    }

    // Fallback to user agent parsing
    const browsers = [
      { regex: /Firefox\/(\d+(\.\d+)?)/, name: 'Firefox' },
      { regex: /Edg\/(\d+(\.\d+)?)/, name: 'Edge' },
      { regex: /OPR\/(\d+(\.\d+)?)/, name: 'Opera' },
      { regex: /Chrome\/(\d+(\.\d+)?)/, name: 'Chrome' },
      { regex: /Safari\/(\d+(\.\d+)?)/, name: 'Safari' },
      { regex: /Version\/(\d+(\.\d+)?).*Safari/, name: 'Safari' }
    ];

    for (const { regex, name } of browsers) {
      const match = ua.match(regex);
      if (match) {
        return { name, version: match[1], brands: null };
      }
    }

    return { name: 'Unknown', version: null, brands: null };
  }

  /**
   * Check WebGL support
   */
  _checkWebGLSupport() {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
    } catch {
      return false;
    }
  }

  /**
   * Check WebGL2 support
   */
  _checkWebGL2Support() {
    try {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('webgl2');
    } catch {
      return false;
    }
  }

  /**
   * Check localStorage availability
   */
  _checkLocalStorage() {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check sessionStorage availability
   */
  _checkSessionStorage() {
    try {
      const test = '__storage_test__';
      sessionStorage.setItem(test, test);
      sessionStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check Canvas 2D support
   */
  _checkCanvas2D() {
    try {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('2d');
    } catch {
      return false;
    }
  }

  /**
   * Collect network information
   */
  _collectNetwork(nav) {
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;

    const network = {
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      connection: connection ? {
        effectiveType: connection.effectiveType || null,
        type: connection.type || null,
        downlink: connection.downlink || null,
        downlinkMax: connection.downlinkMax || null,
        rtt: connection.rtt || null,
        saveData: connection.saveData || false
      } : null
    };

    return network;
  }

  /**
   * Collect comprehensive WebGL information
   */
  _collectWebGL(gl) {
    if (!gl) return null;

    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');

    // Get all parameters
    const params = {
      // Renderer info
      renderer: debugExt ? gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: debugExt ? gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),

      // Texture limits
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
      maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),

      // Vertex limits
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
      maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),

      // Fragment limits
      maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),

      // Viewport
      maxViewportDims: gl.getParameter(gl.MAX_VIEWPORT_DIMS),

      // Renderbuffer
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),

      // Aliased limits
      aliasedLineWidthRange: gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE),
      aliasedPointSizeRange: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE),

      // Precision formats
      vertexShaderPrecision: this._getShaderPrecision(gl, gl.VERTEX_SHADER),
      fragmentShaderPrecision: this._getShaderPrecision(gl, gl.FRAGMENT_SHADER)
    };

    // WebGL2 specific parameters
    if (isWebGL2) {
      params.webgl2 = {
        max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
        maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
        maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
        maxElementIndex: gl.getParameter(gl.MAX_ELEMENT_INDEX),
        maxFragmentInputComponents: gl.getParameter(gl.MAX_FRAGMENT_INPUT_COMPONENTS),
        maxFragmentUniformBlocks: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS),
        maxFragmentUniformComponents: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_COMPONENTS),
        maxSamples: gl.getParameter(gl.MAX_SAMPLES),
        maxServerWaitTimeout: gl.getParameter(gl.MAX_SERVER_WAIT_TIMEOUT),
        maxTransformFeedbackInterleavedComponents: gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS),
        maxTransformFeedbackSeparateAttribs: gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS),
        maxTransformFeedbackSeparateComponents: gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS),
        maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE),
        maxUniformBufferBindings: gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS),
        maxVaryingComponents: gl.getParameter(gl.MAX_VARYING_COMPONENTS),
        maxVertexOutputComponents: gl.getParameter(gl.MAX_VERTEX_OUTPUT_COMPONENTS),
        maxVertexUniformBlocks: gl.getParameter(gl.MAX_VERTEX_UNIFORM_BLOCKS),
        maxVertexUniformComponents: gl.getParameter(gl.MAX_VERTEX_UNIFORM_COMPONENTS),
        minProgramTexelOffset: gl.getParameter(gl.MIN_PROGRAM_TEXEL_OFFSET),
        maxProgramTexelOffset: gl.getParameter(gl.MAX_PROGRAM_TEXEL_OFFSET),
        uniformBufferOffsetAlignment: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)
      };
    }

    // Collect extensions
    const extensions = this._collectWebGLExtensions(gl);

    return {
      version: isWebGL2 ? 'WebGL2' : 'WebGL1',
      params,
      extensions,
      contextAttributes: gl.getContextAttributes()
    };
  }

  /**
   * Get shader precision format
   */
  _getShaderPrecision(gl, shaderType) {
    const precisions = {};
    for (const precision of ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT']) {
      try {
        const format = gl.getShaderPrecisionFormat(shaderType, gl[precision]);
        if (format) {
          precisions[precision] = {
            rangeMin: format.rangeMin,
            rangeMax: format.rangeMax,
            precision: format.precision
          };
        }
      } catch {
        // Ignore errors
      }
    }
    return precisions;
  }

  /**
   * Collect WebGL extensions
   */
  _collectWebGLExtensions(gl) {
    const supported = gl.getSupportedExtensions() || [];

    // Key extensions with status
    const keyExtensions = [
      'WEBGL_debug_renderer_info',
      'WEBGL_lose_context',
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_astc',
      'WEBGL_compressed_texture_etc',
      'WEBGL_compressed_texture_pvrtc',
      'EXT_texture_filter_anisotropic',
      'OES_texture_float',
      'OES_texture_float_linear',
      'OES_texture_half_float',
      'OES_texture_half_float_linear',
      'OES_standard_derivatives',
      'OES_vertex_array_object',
      'OES_element_index_uint',
      'WEBGL_draw_buffers',
      'ANGLE_instanced_arrays',
      'EXT_blend_minmax',
      'EXT_frag_depth',
      'EXT_shader_texture_lod',
      'EXT_color_buffer_float',
      'EXT_color_buffer_half_float',
      'WEBGL_color_buffer_float',
      'EXT_disjoint_timer_query',
      'EXT_disjoint_timer_query_webgl2',
      'KHR_parallel_shader_compile',
      'WEBGL_multi_draw',
      'OVR_multiview2'
    ];

    const extensionStatus = {};
    for (const ext of keyExtensions) {
      extensionStatus[ext] = supported.includes(ext);
    }

    // Get anisotropic filtering info
    let maxAnisotropy = null;
    const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
    if (anisoExt) {
      maxAnisotropy = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    }

    return {
      supported,
      count: supported.length,
      keyExtensions: extensionStatus,
      maxAnisotropy
    };
  }

  /**
   * Collect website/document state
   */
  _collectWebsiteState() {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return null;
    }

    const doc = document;
    const win = window;

    return {
      // Document info
      document: {
        title: doc.title || null,
        URL: win.location?.href || null,
        origin: win.location?.origin || null,
        pathname: win.location?.pathname || null,
        hash: win.location?.hash || null,
        search: win.location?.search || null,
        protocol: win.location?.protocol || null,
        host: win.location?.host || null,
        referrer: doc.referrer || null,
        readyState: doc.readyState,
        visibilityState: doc.visibilityState,
        hidden: doc.hidden,
        hasFocus: doc.hasFocus?.() ?? null,
        characterSet: doc.characterSet || null,
        contentType: doc.contentType || null,
        compatMode: doc.compatMode || null,
        designMode: doc.designMode || null,
        lastModified: doc.lastModified || null,
        domain: doc.domain || null
      },

      // DOM statistics
      dom: {
        elementCount: doc.getElementsByTagName('*').length,
        bodyChildCount: doc.body?.childElementCount || 0,
        headChildCount: doc.head?.childElementCount || 0,
        scriptCount: doc.getElementsByTagName('script').length,
        styleCount: doc.getElementsByTagName('style').length,
        linkCount: doc.getElementsByTagName('link').length,
        imgCount: doc.getElementsByTagName('img').length,
        canvasCount: doc.getElementsByTagName('canvas').length,
        videoCount: doc.getElementsByTagName('video').length,
        audioCount: doc.getElementsByTagName('audio').length,
        iframeCount: doc.getElementsByTagName('iframe').length,
        formCount: doc.getElementsByTagName('form').length,
        inputCount: doc.getElementsByTagName('input').length,
        buttonCount: doc.getElementsByTagName('button').length,
        svgCount: doc.getElementsByTagName('svg').length,
        divCount: doc.getElementsByTagName('div').length,
        spanCount: doc.getElementsByTagName('span').length,
        tableCount: doc.getElementsByTagName('table').length
      },

      // Scroll state
      scroll: {
        x: win.scrollX,
        y: win.scrollY,
        maxX: doc.documentElement.scrollWidth - win.innerWidth,
        maxY: doc.documentElement.scrollHeight - win.innerHeight,
        documentWidth: doc.documentElement.scrollWidth,
        documentHeight: doc.documentElement.scrollHeight
      },

      // Storage usage
      storage: this._collectStorageInfo(),

      // Active features
      activeFeatures: {
        fullscreen: !!doc.fullscreenElement,
        pointerLock: !!doc.pointerLockElement,
        pictureInPicture: !!doc.pictureInPictureElement,
        activeElement: doc.activeElement?.tagName || null
      },

      // CSS info
      css: {
        stylesheetCount: doc.styleSheets?.length || 0,
        computedStylesSupported: !!win.getComputedStyle,
        cssSupportsSupported: !!CSS?.supports,
        prefersColorScheme: win.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        prefersReducedMotion: win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
        prefersContrast: win.matchMedia?.('(prefers-contrast: more)').matches ? 'more' : 'no-preference'
      },

      // History state
      history: {
        length: win.history?.length || 0,
        scrollRestoration: win.history?.scrollRestoration || null
      },

      // Selection
      selection: {
        hasSelection: !!win.getSelection?.()?.toString(),
        selectionLength: win.getSelection?.()?.toString()?.length || 0
      }
    };
  }

  /**
   * Collect storage information
   */
  _collectStorageInfo() {
    const storage = {
      localStorage: { available: false },
      sessionStorage: { available: false },
      cookies: { available: false },
      indexedDB: { available: 'indexedDB' in (typeof window !== 'undefined' ? window : {}) }
    };

    // localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        storage.localStorage = {
          available: true,
          length: localStorage.length,
          keys: Array.from({ length: Math.min(localStorage.length, 50) }, (_, i) => localStorage.key(i)),
          estimatedSizeKB: this._estimateStorageSize(localStorage)
        };
      }
    } catch {
      storage.localStorage.error = 'Access denied or unavailable';
    }

    // sessionStorage
    try {
      if (typeof sessionStorage !== 'undefined') {
        storage.sessionStorage = {
          available: true,
          length: sessionStorage.length,
          keys: Array.from({ length: Math.min(sessionStorage.length, 50) }, (_, i) => sessionStorage.key(i)),
          estimatedSizeKB: this._estimateStorageSize(sessionStorage)
        };
      }
    } catch {
      storage.sessionStorage.error = 'Access denied or unavailable';
    }

    // Cookies
    try {
      if (typeof document !== 'undefined') {
        const cookies = document.cookie;
        storage.cookies = {
          available: true,
          count: cookies ? cookies.split(';').filter(c => c.trim()).length : 0,
          estimatedSizeBytes: cookies ? new Blob([cookies]).size : 0
        };
      }
    } catch {
      storage.cookies.error = 'Access denied or unavailable';
    }

    return storage;
  }

  /**
   * Estimate storage size in KB
   */
  _estimateStorageSize(storage) {
    try {
      let total = 0;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const value = storage.getItem(key);
        total += (key?.length || 0) + (value?.length || 0);
      }
      return +(total / 1024).toFixed(2);
    } catch {
      return null;
    }
  }

  /**
   * Collect performance timing information
   */
  _collectPerformanceTimings() {
    if (typeof performance === 'undefined') {
      return null;
    }

    const timings = {
      now: performance.now(),
      timeOrigin: performance.timeOrigin || null
    };

    // Navigation timing
    if (performance.timing) {
      const t = performance.timing;
      timings.navigation = {
        // DNS
        dnsLookup: t.domainLookupEnd - t.domainLookupStart,
        // TCP connection
        tcpConnect: t.connectEnd - t.connectStart,
        // SSL/TLS
        sslHandshake: t.secureConnectionStart > 0 ? t.connectEnd - t.secureConnectionStart : 0,
        // Request/Response
        requestTime: t.responseStart - t.requestStart,
        responseTime: t.responseEnd - t.responseStart,
        // DOM processing
        domInteractive: t.domInteractive - t.navigationStart,
        domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
        domComplete: t.domComplete - t.navigationStart,
        // Total load time
        loadComplete: t.loadEventEnd - t.navigationStart,
        // TTFB
        ttfb: t.responseStart - t.navigationStart,
        // Redirect time
        redirectTime: t.redirectEnd - t.redirectStart,
        // Unload time
        unloadTime: t.unloadEventEnd - t.unloadEventStart
      };
    }

    // Navigation timing API v2
    const navEntries = performance.getEntriesByType?.('navigation') || [];
    if (navEntries.length > 0) {
      const nav = navEntries[0];
      timings.navigationV2 = {
        type: nav.type,
        redirectCount: nav.redirectCount,
        domContentLoadedEventStart: nav.domContentLoadedEventStart,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        domComplete: nav.domComplete,
        loadEventStart: nav.loadEventStart,
        loadEventEnd: nav.loadEventEnd,
        domInteractive: nav.domInteractive,
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize,
        serverTiming: nav.serverTiming?.map(st => ({
          name: st.name,
          duration: st.duration,
          description: st.description
        })) || []
      };
    }

    // Paint timing
    const paintEntries = performance.getEntriesByType?.('paint') || [];
    timings.paint = {};
    for (const entry of paintEntries) {
      timings.paint[entry.name] = entry.startTime;
    }

    // Largest Contentful Paint
    const lcpEntries = performance.getEntriesByType?.('largest-contentful-paint') || [];
    if (lcpEntries.length > 0) {
      const lcp = lcpEntries[lcpEntries.length - 1];
      timings.largestContentfulPaint = {
        startTime: lcp.startTime,
        element: lcp.element?.tagName || null,
        url: lcp.url || null,
        size: lcp.size
      };
    }

    // First Input Delay (if available)
    const fidEntries = performance.getEntriesByType?.('first-input') || [];
    if (fidEntries.length > 0) {
      const fid = fidEntries[0];
      timings.firstInputDelay = {
        processingStart: fid.processingStart,
        processingEnd: fid.processingEnd,
        duration: fid.duration,
        name: fid.name
      };
    }

    // Long tasks
    const longTasks = performance.getEntriesByType?.('longtask') || [];
    timings.longTasks = {
      count: longTasks.length,
      totalDuration: longTasks.reduce((sum, t) => sum + t.duration, 0),
      tasks: longTasks.slice(-10).map(t => ({
        startTime: t.startTime,
        duration: t.duration,
        name: t.name
      }))
    };

    // Resource summary
    const resources = performance.getEntriesByType?.('resource') || [];
    timings.resources = {
      count: resources.length,
      totalTransferSize: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
      totalEncodedSize: resources.reduce((sum, r) => sum + (r.encodedBodySize || 0), 0),
      totalDecodedSize: resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
      byType: this._groupResourcesByType(resources),
      slowest: resources
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map(r => ({
          name: r.name?.split('/').pop()?.substring(0, 50) || 'unknown',
          duration: +r.duration.toFixed(2),
          transferSize: r.transferSize,
          initiatorType: r.initiatorType
        }))
    };

    // Marks and measures
    const marks = performance.getEntriesByType?.('mark') || [];
    const measures = performance.getEntriesByType?.('measure') || [];
    timings.userMarks = marks.map(m => ({ name: m.name, startTime: m.startTime }));
    timings.userMeasures = measures.map(m => ({ name: m.name, startTime: m.startTime, duration: m.duration }));

    return timings;
  }

  /**
   * Group resources by initiator type
   */
  _groupResourcesByType(resources) {
    const groups = {};
    for (const r of resources) {
      const type = r.initiatorType || 'other';
      if (!groups[type]) {
        groups[type] = { count: 0, totalSize: 0, totalDuration: 0 };
      }
      groups[type].count++;
      groups[type].totalSize += r.transferSize || 0;
      groups[type].totalDuration += r.duration || 0;
    }
    return groups;
  }

  /**
   * Collect battery information (if available)
   */
  async _collectBatteryInfo() {
    if (typeof navigator === 'undefined' || !navigator.getBattery) {
      return null;
    }

    try {
      const battery = await navigator.getBattery();
      return {
        charging: battery.charging,
        level: battery.level,
        levelPercent: +(battery.level * 100).toFixed(0),
        chargingTime: battery.chargingTime === Infinity ? 'Infinity' : battery.chargingTime,
        dischargingTime: battery.dischargingTime === Infinity ? 'Infinity' : battery.dischargingTime
      };
    } catch {
      return null;
    }
  }

  /**
   * Collect storage quota information (if available)
   */
  async _collectStorageQuota() {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      return null;
    }

    try {
      const estimate = await navigator.storage.estimate();
      return {
        quota: estimate.quota,
        quotaMB: estimate.quota ? +(estimate.quota / 1024 / 1024).toFixed(2) : null,
        quotaGB: estimate.quota ? +(estimate.quota / 1024 / 1024 / 1024).toFixed(2) : null,
        usage: estimate.usage,
        usageMB: estimate.usage ? +(estimate.usage / 1024 / 1024).toFixed(2) : null,
        usagePercent: estimate.quota && estimate.usage
          ? +((estimate.usage / estimate.quota) * 100).toFixed(2)
          : null,
        usageDetails: estimate.usageDetails || null
      };
    } catch {
      return null;
    }
  }

  /**
   * Collect frame/animation timing info
   */
  _collectFrameInfo() {
    return {
      rafSupported: typeof requestAnimationFrame !== 'undefined',
      ricSupported: typeof requestIdleCallback !== 'undefined',
      timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now()
    };
  }

  /**
   * Legacy method for backward compatibility
   */
  _collectEnvironment(gl) {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const scr = typeof screen !== 'undefined' ? screen : {};

    const hardware = this._collectHardware(nav, scr);
    const browser = this._collectBrowser(nav);
    const network = this._collectNetwork(nav);
    const webgl = this._collectWebGL(gl);

    // Build legacy-compatible env object
    const env = {
      browser: browser.brands || browser.userAgent || 'unknown',
      browserUA: browser.userAgent || null,
      platform: browser.platform,
      language: browser.language,
      hardwareConcurrency: hardware.cpu.cores,
      deviceMemory: hardware.memory.deviceMemoryGB,
      pixelRatio: hardware.viewport?.devicePixelRatio || null,
      screen: hardware.screen,
      connection: network.connection?.effectiveType || network.connection?.type || null,
      maxTouchPoints: hardware.input.maxTouchPoints,
      timezone: (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          return null;
        }
      })(),
      arch: hardware.cpu.architecture.detected,
      isApple: hardware.cpu.architecture.isApple,
      appleSiliconHint: hardware.cpu.architecture.appleSiliconHint,
      jsHeap: hardware.memory.jsHeap,
      // Extended info
      hardware,
      browser: { ...browser },
      network,
      webgl: webgl ? {
        version: webgl.version,
        renderer: webgl.params.renderer,
        vendor: webgl.params.vendor,
        shadingLanguage: webgl.params.shadingLanguageVersion,
        maxTextureSize: webgl.params.maxTextureSize,
        supportsFloatTextures: webgl.extensions.keyExtensions['OES_texture_float'] ||
          webgl.extensions.keyExtensions['OES_texture_half_float'],
        supportsColorBufferFloat: webgl.extensions.keyExtensions['EXT_color_buffer_float'] ||
          webgl.extensions.keyExtensions['WEBGL_color_buffer_float'],
        maxAnisotropy: webgl.extensions.maxAnisotropy,
        // Full WebGL info
        full: webgl
      } : null
    };

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
    const rendererStats = context.rendererStats ??
      (this.viewer && typeof this.viewer.getRendererStats === 'function' ? this.viewer.getRendererStats() : null) ??
      {};
    const perfStats = context.perfStats ?? null;
    const rendererConfig = context.rendererConfig || {};
    const renderMode = rendererConfig.renderMode || context.renderMode || null;
    const viewport = gl
      ? { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight }
      : {
          width: typeof window !== 'undefined' ? window.innerWidth : null,
          height: typeof window !== 'undefined' ? window.innerHeight : null
        };

    const fps = perfStats?.fps ?? rendererStats.fps ?? null;
    const frameTime = perfStats?.avgFrameTime ?? rendererStats.lastFrameTime ?? null;
    const renderFrameMs = rendererStats.lastFrameTime ?? null;

    const estimatedMemoryMB = rendererStats.gpuMemoryMB ??
      (context.dataset && context.dataset.pointCount
        ? (context.dataset.pointCount * 28) / (1024 * 1024)
        : null);

    return {
      fps,
      frameTime,
      renderFrameMs,
      rendererStats,
      perfStats,
      rendererConfig,
      renderMode,
      viewport,
      estimatedMemoryMB
    };
  }

  /**
   * Issue severity levels
   */
  static SEVERITY = {
    CRITICAL: 'critical',  // Performance is severely impacted, likely unusable
    WARNING: 'warning',    // Performance is degraded but usable
    INFO: 'info',          // Informational, may affect some use cases
    SUGGESTION: 'suggestion' // Optimization opportunity
  };

  /**
   * Default thresholds for issue detection (can be overridden via constructor)
   */
  static DEFAULT_THRESHOLDS = {
    fps: {
      critical: 15,
      warning: 30,
      target: 60
    },
    frameTime: {
      critical: 50,   // 20 FPS
      warning: 33,    // 30 FPS
      target: 16.67   // 60 FPS
    },
    memory: {
      critical: 1000, // 1GB GPU memory
      warning: 700,   // 700MB
      high: 500       // 500MB (info)
    },
    pointCount: {
      requiresLOD: 1000000,      // 1M points
      requiresCulling: 500000,  // 500K points
      large: 5000000             // 5M points
    },
    cpu: {
      limited: 4,
      adequate: 6
    },
    deviceMemory: {
      critical: 2,  // 2GB
      warning: 4    // 4GB
    },
    jank: {
      critical: 10, // 10% jank frames
      warning: 5    // 5% jank frames
    }
  };

  /**
   * Detect performance issues with severity levels and detailed metadata
   * @param {Object} env - Environment information
   * @param {Object} renderer - Renderer statistics
   * @param {Object} data - Data snapshot
   * @param {Object} perfStats - Performance tracker stats (optional)
   * @param {Object} thresholds - Custom thresholds (optional)
   * @returns {Array<Object>} Array of issue objects with severity and metadata
   */
  _detectIssues(env, renderer, data, perfStats = null, thresholds = null) {
    const issues = [];
    const t = thresholds || BenchmarkReporter.DEFAULT_THRESHOLDS;
    const S = BenchmarkReporter.SEVERITY;

    // Helper to add issues
    const addIssue = (severity, category, message, details = {}) => {
      issues.push({
        severity,
        category,
        message,
        details,
        timestamp: Date.now()
      });
    };

    // FPS Issues
    if (renderer.fps != null) {
      if (renderer.fps < t.fps.critical) {
        addIssue(S.CRITICAL, 'performance', `Critical: FPS is ${renderer.fps} (below ${t.fps.critical})`, {
          current: renderer.fps,
          threshold: t.fps.critical,
          recommendation: 'Enable LOD, reduce point count, or use ultralight shader'
        });
      } else if (renderer.fps < t.fps.warning) {
        addIssue(S.WARNING, 'performance', `FPS is ${renderer.fps} (target: ${t.fps.target})`, {
          current: renderer.fps,
          threshold: t.fps.warning,
          recommendation: 'Consider enabling LOD or using light/ultralight shader'
        });
      }
    }

    // Frame time issues
    if (renderer.frameTime != null) {
      if (renderer.frameTime > t.frameTime.critical) {
        addIssue(S.CRITICAL, 'performance', `Frame time ${renderer.frameTime.toFixed(1)}ms exceeds ${t.frameTime.critical}ms`, {
          current: renderer.frameTime,
          threshold: t.frameTime.critical,
          recommendation: 'GPU or CPU bottleneck detected; reduce workload'
        });
      } else if (renderer.frameTime > t.frameTime.warning) {
        addIssue(S.WARNING, 'performance', `Frame time ${renderer.frameTime.toFixed(1)}ms exceeds ${t.frameTime.warning}ms target`, {
          current: renderer.frameTime,
          threshold: t.frameTime.warning
        });
      }
    }

    // Jank detection (from PerformanceTracker stats)
    if (perfStats?.jankPercent != null) {
      if (perfStats.jankPercent > t.jank.critical) {
        addIssue(S.WARNING, 'stability', `High jank rate: ${perfStats.jankPercent.toFixed(1)}% of frames`, {
          current: perfStats.jankPercent,
          threshold: t.jank.critical,
          maxConsecutiveJanks: perfStats.maxConsecutiveJanks,
          recommendation: 'Reduce workload variance; check for GC pressure'
        });
      } else if (perfStats.jankPercent > t.jank.warning) {
        addIssue(S.INFO, 'stability', `Moderate jank: ${perfStats.jankPercent.toFixed(1)}% of frames`, {
          current: perfStats.jankPercent,
          threshold: t.jank.warning
        });
      }
    }

    // Memory issues
    if (renderer.estimatedMemoryMB != null) {
      if (renderer.estimatedMemoryMB > t.memory.critical) {
        addIssue(S.CRITICAL, 'memory', `GPU memory ~${renderer.estimatedMemoryMB.toFixed(0)}MB exceeds safe limit`, {
          current: renderer.estimatedMemoryMB,
          threshold: t.memory.critical,
          recommendation: 'Risk of driver eviction; reduce point count or resolution'
        });
      } else if (renderer.estimatedMemoryMB > t.memory.warning) {
        addIssue(S.WARNING, 'memory', `GPU memory ~${renderer.estimatedMemoryMB.toFixed(0)}MB is high`, {
          current: renderer.estimatedMemoryMB,
          threshold: t.memory.warning
        });
      }
    }

    // LOD configuration issues
    if (data.pointCount > t.pointCount.large) {
      if (renderer.rendererConfig?.lodEnabled === false) {
        addIssue(S.CRITICAL, 'config', 'LOD disabled on very large dataset', {
          pointCount: data.pointCount,
          threshold: t.pointCount.large,
          recommendation: 'Enable LOD for datasets over 5M points'
        });
      }
    } else if (data.pointCount > t.pointCount.requiresLOD) {
      if (renderer.rendererConfig?.lodEnabled === false) {
        addIssue(S.WARNING, 'config', 'LOD disabled on large dataset', {
          pointCount: data.pointCount,
          threshold: t.pointCount.requiresLOD,
          recommendation: 'Enable LOD for better performance'
        });
      }
    }

    // Frustum culling configuration
    if (data.pointCount > t.pointCount.requiresCulling && renderer.rendererConfig?.frustumCulling === false) {
      addIssue(S.SUGGESTION, 'config', 'Frustum culling disabled', {
        pointCount: data.pointCount,
        threshold: t.pointCount.requiresCulling,
        recommendation: 'Enable frustum culling to reduce fill rate'
      });
    }

    // Hardware issues
    if (env.pixelRatio != null && env.pixelRatio > 2) {
      addIssue(S.INFO, 'hardware', `High DPI display (${env.pixelRatio}x) increases fill cost`, {
        current: env.pixelRatio,
        recommendation: 'Consider browser zoom <100% or canvas resolution scaling'
      });
    }

    if (env.hardwareConcurrency != null && env.hardwareConcurrency < t.cpu.limited) {
      addIssue(S.WARNING, 'hardware', `Limited CPU cores (${env.hardwareConcurrency})`, {
        current: env.hardwareConcurrency,
        threshold: t.cpu.limited,
        recommendation: 'Expect slower data loading and filter updates'
      });
    } else if (env.hardwareConcurrency != null && env.hardwareConcurrency < t.cpu.adequate) {
      addIssue(S.INFO, 'hardware', `Moderate CPU cores (${env.hardwareConcurrency})`, {
        current: env.hardwareConcurrency,
        threshold: t.cpu.adequate
      });
    }

    if (env.deviceMemory != null && env.deviceMemory < t.deviceMemory.critical) {
      addIssue(S.CRITICAL, 'hardware', `Very low device memory (${env.deviceMemory}GB)`, {
        current: env.deviceMemory,
        threshold: t.deviceMemory.critical,
        recommendation: 'Large datasets may fail to load'
      });
    } else if (env.deviceMemory != null && env.deviceMemory < t.deviceMemory.warning) {
      addIssue(S.WARNING, 'hardware', `Low device memory (${env.deviceMemory}GB)`, {
        current: env.deviceMemory,
        threshold: t.deviceMemory.warning
      });
    }

    // WebGL capability issues
    if (env.webgl) {
      if (env.webgl.maxTextureSize && env.webgl.maxTextureSize < 4096) {
        addIssue(S.WARNING, 'webgl', `Low MAX_TEXTURE_SIZE (${env.webgl.maxTextureSize})`, {
          current: env.webgl.maxTextureSize,
          threshold: 4096,
          recommendation: 'Texture-heavy effects may degrade'
        });
      }
      if (env.webgl.supportsColorBufferFloat === false) {
        addIssue(S.INFO, 'webgl', 'Color buffer float not supported', {
          recommendation: 'Fallback precision may apply for some effects'
        });
      }
    }

    // Sort by severity (critical first)
    const severityOrder = { critical: 0, warning: 1, info: 2, suggestion: 3 };
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return issues;
  }

  /**
   * Get issues filtered by severity
   * @param {Array} issues - Array of issues
   * @param {string} minSeverity - Minimum severity to include
   * @returns {Array} Filtered issues
   */
  static filterIssuesBySeverity(issues, minSeverity = 'info') {
    const severityOrder = { critical: 0, warning: 1, info: 2, suggestion: 3 };
    const minLevel = severityOrder[minSeverity] ?? 2;
    return issues.filter(i => severityOrder[i.severity] <= minLevel);
  }

  /**
   * Get issue summary counts by severity
   * @param {Array} issues - Array of issues
   * @returns {Object} Counts by severity
   */
  static getIssueSummary(issues) {
    const summary = { critical: 0, warning: 0, info: 0, suggestion: 0, total: issues.length };
    for (const issue of issues) {
      if (summary[issue.severity] !== undefined) {
        summary[issue.severity]++;
      }
    }
    return summary;
  }

  /**
   * Format issues as simple strings (legacy format)
   * @param {Array} issues - Array of issue objects
   * @returns {Array<string>} Array of message strings
   */
  static formatIssuesAsStrings(issues) {
    return issues.map(i => `[${i.severity.toUpperCase()}] ${i.message}`);
  }

  /**
   * Build a comprehensive report with all available information.
   * Returns structured JSON data with helper methods for export.
   * @param {Object} context - Context data (perfStats, rendererStats, etc.)
   * @returns {Object} Report object with data and export methods
   */
  buildReport(context = {}) {
    const gl = this._getGL();
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const scr = typeof screen !== 'undefined' ? screen : {};

    // Collect all information (avoiding duplicate collection)
    const hardware = this._collectHardware(nav, scr);
    const browser = this._collectBrowser(nav);
    const network = this._collectNetwork(nav);
    const webgl = this._collectWebGL(gl);
    const websiteState = this._collectWebsiteState();
    const performanceTimings = this._collectPerformanceTimings();
    const frameInfo = this._collectFrameInfo();

    const data = this._collectDataSnapshot(context);
    const renderer = this._collectRendererSnapshot(gl, { ...context, dataset: data });

    // Build compact env object for issue detection (avoiding full re-collection)
    const env = {
      pixelRatio: hardware.viewport?.devicePixelRatio || null,
      hardwareConcurrency: hardware.cpu.cores,
      deviceMemory: hardware.memory.deviceMemoryGB,
      webgl: webgl ? {
        maxTextureSize: webgl.params.maxTextureSize,
        supportsColorBufferFloat: webgl.extensions.keyExtensions['EXT_color_buffer_float'] ||
          webgl.extensions.keyExtensions['WEBGL_color_buffer_float']
      } : null,
      timezone: (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
        catch { return null; }
      })()
    };

    // Detect issues with new severity system (pass perfStats for jank detection)
    const issues = this._detectIssues(env, renderer, data, context.perfStats);
    const issueSummary = BenchmarkReporter.getIssueSummary(issues);
    const now = new Date();

    // Build structured report
    const report = {
      meta: {
        generated: now.toISOString(),
        generatedLocal: now.toLocaleString(),
        timezone: env.timezone,
        version: '3.0' // Bumped version for new issue format
      },
      hardware,
      browser,
      network,
      webgl,
      websiteState,
      performanceTimings,
      frameInfo,
      renderer,
      data,
      issues,
      issueSummary
    };

    // Minimal text summary with severity breakdown
    const issueText = issueSummary.total === 0 ? 'none' :
      `${issueSummary.total} (${issueSummary.critical} critical, ${issueSummary.warning} warning)`;

    const summary = [
      `Cellucid Report | ${now.toISOString()}`,
      `CPU: ${hardware.cpu.cores || '?'} cores, ${hardware.cpu.architecture.detected}`,
      `GPU: ${webgl?.params?.renderer || 'n/a'} (${webgl?.version || 'no WebGL'})`,
      `Screen: ${hardware.screen.width}x${hardware.screen.height} @ ${hardware.viewport?.devicePixelRatio || 1}x`,
      `Browser: ${browser.name} ${browser.version || ''} | ${browser.platform}`,
      `Network: ${network.online ? 'online' : 'offline'}${network.connection ? ` (${network.connection.effectiveType})` : ''}`,
      `Memory: ${hardware.memory.deviceMemoryGB || '?'}GB device${hardware.memory.jsHeap.available ? `, ${hardware.memory.jsHeap.usedMB}MB heap` : ''}`,
      `Points: ${formatNumber(data.pointCount)} total, ${formatNumber(data.visiblePoints)} visible`,
      `FPS: ${renderer.fps ?? 'n/a'}${renderer.frameTime != null ? ` (${typeof renderer.frameTime === 'number' ? renderer.frameTime.toFixed(1) : renderer.frameTime}ms)` : ''}`,
      `Issues: ${issueText}`
    ].join('\n');

    return {
      ...report,
      text: summary,
      json: () => JSON.stringify(report, null, 2),
      yaml: () => this._toYaml(report)
    };
  }

  /**
   * Convert object to YAML format
   */
  _toYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    const lines = [];

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        lines.push(`${pad}${key}: null`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${pad}${key}: []`);
        } else if (typeof value[0] === 'object') {
          lines.push(`${pad}${key}:`);
          for (const item of value) {
            lines.push(`${pad}- ${this._toYaml(item, indent + 1).trim().replace(/^/, '').replace(/\n/g, `\n${pad}  `)}`);
          }
        } else {
          lines.push(`${pad}${key}:`);
          for (const item of value) {
            lines.push(`${pad}- ${this._yamlValue(item)}`);
          }
        }
      } else if (typeof value === 'object') {
        lines.push(`${pad}${key}:`);
        lines.push(this._toYaml(value, indent + 1));
      } else {
        lines.push(`${pad}${key}: ${this._yamlValue(value)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format a primitive value for YAML
   */
  _yamlValue(val) {
    if (typeof val === 'string') {
      if (val.includes('\n') || val.includes(':') || val.includes('#') || val.includes("'") || val.includes('"') || /^[\[\]{}&*!|>%@`]/.test(val)) {
        return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
      }
      return val || '""';
    }
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') return String(val);
    return String(val);
  }

  /**
   * Async version that includes battery and storage quota info
   */
  async buildReportAsync(context = {}) {
    const report = this.buildReport(context);

    // Collect async data
    const [battery, storageQuota] = await Promise.all([
      this._collectBatteryInfo(),
      this._collectStorageQuota()
    ]);

    // Add to report data
    report.battery = battery;
    report.storageQuota = storageQuota;

    // Add minimal text lines for async data
    const asyncLines = [];
    if (battery) {
      asyncLines.push(`Battery: ${battery.levelPercent}% ${battery.charging ? '(charging)' : ''}`);
    }
    if (storageQuota) {
      asyncLines.push(`Storage: ${storageQuota.usageMB}MB / ${storageQuota.quotaGB}GB (${storageQuota.usagePercent}%)`);
    }
    if (asyncLines.length > 0) {
      report.text += '\n' + asyncLines.join('\n');
    }

    // Update json/yaml methods to include async data
    const fullReport = { ...report };
    delete fullReport.text;
    delete fullReport.json;
    delete fullReport.yaml;
    report.json = () => JSON.stringify(fullReport, null, 2);
    report.yaml = () => this._toYaml(fullReport);

    return report;
  }
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return 'n/a';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Benchmark Data Exporter
 *
 * Provides utilities to export benchmark results to various formats
 * including CSV, JSON Lines, and structured JSON.
 */
export class BenchmarkExporter {
  /**
   * Export benchmark results to CSV format
   * @param {Object} benchmarkResults - Results from runBenchmarkSuite
   * @returns {string} CSV formatted string
   */
  static toCSV(benchmarkResults) {
    const { results, metadata } = benchmarkResults;
    if (!results || results.length === 0) return '';

    // Define columns
    const columns = [
      'name', 'fps', 'avgFrameTime', 'minFrameTime', 'maxFrameTime',
      'medianFrameTime', 'p95FrameTime', 'p99FrameTime', 'stdDev',
      'frames', 'jankFrames', 'jankPercent'
    ];

    // Header row
    const header = columns.join(',');

    // Data rows
    const rows = results.map(result => {
      return columns.map(col => {
        const value = result[col];
        if (value == null) return '';
        if (typeof value === 'string') return `"${value.replace(/"/g, '""')}"`;
        if (typeof value === 'number') return value.toFixed ? value.toFixed(4) : value;
        return value;
      }).join(',');
    });

    // Add metadata as comment header
    const metaLines = [
      `# Benchmark Export`,
      `# Generated: ${metadata?.timestamp || new Date().toISOString()}`,
      `# Point Count: ${metadata?.pointCount || 'unknown'}`,
      `# Frames Per Test: ${metadata?.framesPerTest || 'unknown'}`,
      `# Warmup Frames: ${metadata?.warmupFrames || 'unknown'}`,
      ''
    ];

    return metaLines.join('\n') + header + '\n' + rows.join('\n');
  }

  /**
   * Export benchmark results to JSON Lines format (one JSON object per line)
   * Useful for streaming and appending to log files
   * @param {Object} benchmarkResults - Results from runBenchmarkSuite
   * @returns {string} JSON Lines formatted string
   */
  static toJSONLines(benchmarkResults) {
    const { results, metadata } = benchmarkResults;
    if (!results || results.length === 0) return '';

    const timestamp = metadata?.timestamp || new Date().toISOString();

    return results.map(result => {
      const entry = {
        timestamp,
        pointCount: metadata?.pointCount,
        ...result
      };
      // Remove rawFrameTimes to keep lines manageable
      delete entry.rawFrameTimes;
      return JSON.stringify(entry);
    }).join('\n');
  }

  /**
   * Export performance tracker history to CSV
   * @param {Array} history - History from PerformanceTracker
   * @returns {string} CSV formatted string
   */
  static historyToCSV(history) {
    if (!history || history.length === 0) return '';

    const columns = ['timestamp', 'fps', 'avgFrameTime', 'p95FrameTime', 'jankPercent'];
    const header = columns.join(',');

    const rows = history.map(entry => {
      return columns.map(col => {
        const value = entry[col];
        if (value == null) return '';
        if (typeof value === 'number') return value.toFixed(4);
        return value;
      }).join(',');
    });

    return header + '\n' + rows.join('\n');
  }

  /**
   * Export frame times as raw data for external analysis
   * @param {Array} frameTimes - Array of frame times in ms
   * @param {Object} options - Export options
   * @returns {string} Formatted string based on options.format
   */
  static frameTimesToFormat(frameTimes, options = {}) {
    const { format = 'json', includeStats = true } = options;

    if (!frameTimes || frameTimes.length === 0) return '';

    const data = {
      frameTimes,
      count: frameTimes.length
    };

    if (includeStats) {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const avg = sum / sorted.length;
      const sumSquares = sorted.reduce((a, b) => a + b * b, 0);
      const variance = (sumSquares / sorted.length) - (avg * avg);

      data.stats = {
        avg,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        median: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        stdDev: Math.sqrt(Math.max(0, variance))
      };
    }

    switch (format) {
      case 'csv':
        return frameTimes.join('\n');
      case 'json':
        return JSON.stringify(data, null, 2);
      case 'jsonl':
        return frameTimes.map((t, i) => JSON.stringify({ frame: i, timeMs: t })).join('\n');
      default:
        return JSON.stringify(data);
    }
  }

  /**
   * Create a downloadable file from export data
   * @param {string} data - Export data string
   * @param {string} filename - Filename for download
   * @param {string} mimeType - MIME type
   */
  static download(data, filename, mimeType = 'text/plain') {
    if (typeof document === 'undefined') {
      console.warn('[BenchmarkExporter] download() requires browser environment');
      return;
    }

    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Convenience method to export and download benchmark results
   * @param {Object} benchmarkResults - Results from runBenchmarkSuite
   * @param {string} format - 'csv', 'json', or 'jsonl'
   */
  static exportAndDownload(benchmarkResults, format = 'csv') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let data, filename, mimeType;

    switch (format) {
      case 'csv':
        data = this.toCSV(benchmarkResults);
        filename = `benchmark-${timestamp}.csv`;
        mimeType = 'text/csv';
        break;
      case 'jsonl':
        data = this.toJSONLines(benchmarkResults);
        filename = `benchmark-${timestamp}.jsonl`;
        mimeType = 'application/x-ndjson';
        break;
      case 'json':
      default:
        data = JSON.stringify(benchmarkResults, null, 2);
        filename = `benchmark-${timestamp}.json`;
        mimeType = 'application/json';
        break;
    }

    this.download(data, filename, mimeType);
  }
}

// Re-export formatNumber for backward compatibility (imported at top of file)
export { formatNumber };

// Export for global access
if (typeof window !== 'undefined') {
  window.SyntheticDataGenerator = SyntheticDataGenerator;
  window.PerformanceTracker = PerformanceTracker;
  window.HighPerfBenchmark = HighPerfBenchmark;
  window.BenchmarkConfig = BenchmarkConfig;
  window.formatNumber = formatNumber;
  window.formatBytes = formatBytes;
  window.GLBParser = GLBParser;
  window.MeshSurfaceSampler = MeshSurfaceSampler;
  window.BenchmarkReporter = BenchmarkReporter;
  window.GPUTimer = GPUTimer;
  window.BenchmarkExporter = BenchmarkExporter;
}
