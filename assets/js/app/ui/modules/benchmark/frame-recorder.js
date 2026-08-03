/**
 * @fileoverview Full-window frame recorder with honest tail statistics.
 *
 * The live `PerformanceTracker` in `performance-tracker.js` keeps a rolling
 * window of 120 samples, which is the right shape for an on-screen frame-rate
 * readout and the wrong shape for a tail measurement: a "p99" from 120 samples
 * is the second-worst frame of a two-second window, not a p99. This recorder keeps
 * every frame of the measurement window instead, and refuses to print a
 * percentile it cannot support.
 *
 * A percentile is reported only when the window holds at least
 * `MIN_TAIL_SAMPLES` frames strictly beyond it — twenty frames above p95 needs
 * 400 samples, twenty above p99 needs 2000. Below that the recorder reports
 * `null` together with the sample count it would have needed, so an
 * under-powered run reads as "not measured" rather than as a number.
 *
 * Recording is allocation-free. Every channel is a typed array sized once at
 * construction; `record()` performs stores only. Statistics are computed after
 * the window closes, where allocation cannot perturb the measurement.
 *
 * @module app/ui/modules/benchmark/frame-recorder
 */

/** Frames that must sit beyond a percentile before it is reported. */
export const MIN_TAIL_SAMPLES = 20;

/** Level at which a frame counts as jank, as a multiple of the median. */
export const JANK_MEDIAN_MULTIPLE = 1.5;

/** The single percentile estimator used by this module. */
const PERCENTILE_ESTIMATOR = 'linear-interpolation-on-sorted-samples';

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be one positive safe integer.`);
  }
  return value;
}

/**
 * Minimum sample count for a percentile to be reportable.
 *
 * @param {number} quantile - Quantile in (0, 1).
 * @returns {number} Required sample count.
 */
export function requiredSamplesForQuantile(quantile) {
  if (
    typeof quantile !== 'number' ||
    !Number.isFinite(quantile) ||
    quantile <= 0 ||
    quantile >= 1
  ) {
    throw new RangeError(
      'Percentile quantile must be one finite number strictly between 0 and 1.'
    );
  }
  return Math.ceil(MIN_TAIL_SAMPLES / (1 - quantile));
}

/**
 * Linear-interpolated percentile over an ascending-sorted array.
 *
 * @param {ArrayLike<number>} sorted - Ascending samples.
 * @param {number} count - Number of valid entries.
 * @param {number} quantile - Quantile in (0, 1).
 * @returns {number} Interpolated percentile.
 */
export function percentileOfSorted(sorted, count, quantile) {
  requirePositiveInteger(count, 'Percentile sample count');
  if (count === 1) return sorted[0];
  const position = quantile * (count - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

/**
 * One measurement window. Fixed capacity, no growth, no allocation while
 * recording; the window ends when capacity is reached.
 */
export class FrameRecorder {
  /**
   * @param {Object} options - Exact recorder description.
   * @param {number} options.capacity - Frames the window can hold.
   */
  constructor(options = {}) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('Frame recorder options must be one plain object.');
    }
    this.capacity = requirePositiveInteger(
      options.capacity,
      'Frame recorder capacity'
    );
    this.frameTimes = new Float64Array(this.capacity);
    this.uploadCalls = new Int32Array(this.capacity);
    this.uploadBytes = new Float64Array(this.capacity);
    this.elementUploadCalls = new Int32Array(this.capacity);
    this.syncStallCalls = new Int32Array(this.capacity);
    this.lodLevels = new Int16Array(this.capacity);
    this.count = 0;
    this._sortScratch = new Float64Array(this.capacity);
  }

  /** Discard every recorded frame without releasing the buffers. */
  reset() {
    this.count = 0;
  }

  /** @returns {boolean} True when the window has no room left. */
  isFull() {
    return this.count >= this.capacity;
  }

  /**
   * Record one frame. Stores only — safe to call inside the measured window.
   *
   * @param {number} frameTimeMs - Interval since the previous frame, ms.
   * @param {number} uploadCalls - Buffer/texture upload calls this frame.
   * @param {number} uploadBytes - Bytes uploaded this frame.
   * @param {number} elementUploadCalls - Element-buffer upload calls.
   * @param {number} syncStallCalls - Synchronous GL query calls this frame.
   * @param {number} lodLevel - Published LOD level, or -1 when unavailable.
   * @returns {boolean} True when the frame was stored.
   */
  record(
    frameTimeMs,
    uploadCalls,
    uploadBytes,
    elementUploadCalls,
    syncStallCalls,
    lodLevel
  ) {
    const index = this.count;
    if (index >= this.capacity) return false;
    this.frameTimes[index] = frameTimeMs;
    this.uploadCalls[index] = uploadCalls;
    this.uploadBytes[index] = uploadBytes;
    this.elementUploadCalls[index] = elementUploadCalls;
    this.syncStallCalls[index] = syncStallCalls;
    this.lodLevels[index] = lodLevel;
    this.count = index + 1;
    return true;
  }

  /**
   * Close the window and compute its statistics.
   *
   * Percentiles that the sample count cannot support are reported as `null`
   * with the count that would have been required. Nothing is extrapolated.
   *
   * @returns {Object} Frozen summary of the window.
   */
  summarize() {
    const count = this.count;
    if (count === 0) {
      return Object.freeze({
        samples: 0,
        capacity: this.capacity,
        windowFilled: false,
        percentileEstimator: PERCENTILE_ESTIMATOR,
        frameTimeMs: Object.freeze({
          mean: null,
          min: null,
          max: null,
          stdDev: null,
          median: null,
          p95: null,
          p99: null
        }),
        percentileSupport: Object.freeze({
          median: Object.freeze({
            reported: false,
            requiredSamples: requiredSamplesForQuantile(0.5)
          }),
          p95: Object.freeze({
            reported: false,
            requiredSamples: requiredSamplesForQuantile(0.95)
          }),
          p99: Object.freeze({
            reported: false,
            requiredSamples: requiredSamplesForQuantile(0.99)
          })
        }),
        jank: Object.freeze({
          frames: 0,
          percent: null,
          thresholdMs: null
        }),
        uploads: Object.freeze({
          totalCalls: 0,
          totalBytes: 0,
          totalElementCalls: 0,
          totalSyncStallCalls: 0,
          framesWithUpload: 0,
          framesWithUploadPercent: null,
          meanCallsPerFrame: null,
          meanBytesPerFrame: null,
          maxCallsInOneFrame: 0,
          maxBytesInOneFrame: 0
        }),
        lod: Object.freeze({
          minLevel: null,
          maxLevel: null,
          transitions: 0,
          distinctLevels: 0
        })
      });
    }

    const sorted = this._sortScratch.subarray(0, count);
    sorted.set(this.frameTimes.subarray(0, count));
    sorted.sort();

    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      const value = sorted[i];
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / count;
    const variance = sumSquares / count - mean * mean;
    const stdDev = Math.sqrt(Math.max(0, variance));

    const support = quantile => {
      const requiredSamples = requiredSamplesForQuantile(quantile);
      const reported = count >= requiredSamples;
      return {
        value: reported ? percentileOfSorted(sorted, count, quantile) : null,
        support: Object.freeze({ reported, requiredSamples })
      };
    };
    const median = support(0.5);
    const p95 = support(0.95);
    const p99 = support(0.99);

    // Jank is measured against the median, not the mean: a window with a heavy
    // tail drags its own mean upward and would under-report its own jank.
    const medianValue = percentileOfSorted(sorted, count, 0.5);
    const jankThreshold = medianValue * JANK_MEDIAN_MULTIPLE;
    let jankFrames = 0;
    for (let i = count - 1; i >= 0; i--) {
      if (sorted[i] <= jankThreshold) break;
      jankFrames++;
    }

    let totalCalls = 0;
    let totalBytes = 0;
    let totalElementCalls = 0;
    let totalSyncStallCalls = 0;
    let framesWithUpload = 0;
    let maxCallsInOneFrame = 0;
    let maxBytesInOneFrame = 0;
    let minLevel = Number.POSITIVE_INFINITY;
    let maxLevel = Number.NEGATIVE_INFINITY;
    let transitions = 0;
    let previousLevel = this.lodLevels[0];
    const seenLevels = new Set();
    for (let i = 0; i < count; i++) {
      const calls = this.uploadCalls[i];
      const bytes = this.uploadBytes[i];
      totalCalls += calls;
      totalBytes += bytes;
      totalElementCalls += this.elementUploadCalls[i];
      totalSyncStallCalls += this.syncStallCalls[i];
      if (calls > 0) framesWithUpload++;
      if (calls > maxCallsInOneFrame) maxCallsInOneFrame = calls;
      if (bytes > maxBytesInOneFrame) maxBytesInOneFrame = bytes;
      const level = this.lodLevels[i];
      if (level < minLevel) minLevel = level;
      if (level > maxLevel) maxLevel = level;
      if (i > 0 && level !== previousLevel) transitions++;
      previousLevel = level;
      seenLevels.add(level);
    }

    return Object.freeze({
      samples: count,
      capacity: this.capacity,
      windowFilled: count === this.capacity,
      percentileEstimator: PERCENTILE_ESTIMATOR,
      frameTimeMs: Object.freeze({
        mean,
        min: sorted[0],
        max: sorted[count - 1],
        stdDev,
        median: median.value,
        p95: p95.value,
        p99: p99.value
      }),
      percentileSupport: Object.freeze({
        median: median.support,
        p95: p95.support,
        p99: p99.support
      }),
      jank: Object.freeze({
        frames: jankFrames,
        percent: (jankFrames / count) * 100,
        thresholdMs: jankThreshold
      }),
      uploads: Object.freeze({
        totalCalls,
        totalBytes,
        totalElementCalls,
        totalSyncStallCalls,
        framesWithUpload,
        framesWithUploadPercent: (framesWithUpload / count) * 100,
        meanCallsPerFrame: totalCalls / count,
        meanBytesPerFrame: totalBytes / count,
        maxCallsInOneFrame,
        maxBytesInOneFrame
      }),
      lod: Object.freeze({
        minLevel,
        maxLevel,
        transitions,
        distinctLevels: seenLevels.size
      })
    });
  }
}
