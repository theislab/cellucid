/**
 * @fileoverview Rolling frame-time statistics for the live benchmark panel.
 *
 * This module is intentionally independent of the optional report, analyzer,
 * GPU-timer, and synthetic-generator graph in `dev/benchmark.js`. A live
 * renderer must be able to activate measurement without asking its busy main
 * thread to parse every developer-only benchmark facility first.
 *
 * @module app/ui/modules/benchmark/performance-tracker
 */

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
    this._paused = false;
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
    this._paused = false;
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
    if (this._paused) return this.getStats();

    const now = performance.now();
    const frameTime = now - this.lastTime;
    this.lastTime = now;
    this._frameNumber++;

    // Skip warmup frames (usually have initialization overhead)
    if (this._frameNumber <= this.warmupFrames) {
      return this.getStats();
    }
    this._warmupComplete = true;

    // Only finite, positive browser-rendered intervals are measurements.
    // Slow visible frames remain truthful measurements at any duration.
    if (!Number.isFinite(frameTime) || frameTime < 0.1) {
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
   * Pause without discarding collected measurements.
   *
   * Call this when rendering is suspended, such as while the document is
   * hidden, so the suspension interval is not reported as frame time.
   */
  pause() {
    if (!this.running) return;
    this._paused = true;
  }

  /**
   * Resume after a suspension without recording the elapsed suspension gap.
   */
  resume() {
    if (!this.running || !this._paused) return;
    this.lastTime = performance.now();
    this._paused = false;
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
    this._paused = false;
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
