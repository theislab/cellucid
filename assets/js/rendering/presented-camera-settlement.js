const DEFAULT_SETTLE_MILLISECONDS = 120;
const MINIMUM_UNCHANGED_FRAMES = 2;
const MAXIMUM_UNCHANGED_FRAMES = 12;

export const PRESENTED_CAMERA_SETTLEMENT_CONTRACT = Object.freeze({
  maximumUnchangedFrames: MAXIMUM_UNCHANGED_FRAMES,
  minimumUnchangedFrames: MINIMUM_UNCHANGED_FRAMES,
  settleMilliseconds: DEFAULT_SETTLE_MILLISECONDS,
});

/**
 * Own the changing/settled boundary for camera frames.
 *
 * Wall-clock silence alone is not a frame boundary: on a slow renderer, an
 * animation callback can publish the next camera state immediately after the
 * renderer observes one apparently unchanged frame. Requiring two consecutive
 * unchanged render frames prevents that scheduling gap from splitting one
 * logical motion burst. The maximum unchanged-frame count is a liveness fence
 * for throttled, quantized, or test-controlled clocks that do not advance far
 * enough to reach the time threshold.
 */
export class PresentedCameraSettlementTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this._lastChangeTime = 0;
    this._pending = false;
    this._unchangedFrameCount = 0;
  }

  /**
   * Observe one renderer-owned frame.
   *
   * @param {boolean} changed whether the presented camera scalars changed
   * @param {number} now the renderer's monotonic frame time
   * @param {boolean} burstEligible false only while establishing a baseline
   * @returns {'camera-changing'|'camera-settled'|null}
   */
  observeFrame(changed, now, burstEligible) {
    if (typeof changed !== 'boolean') {
      throw new TypeError(
        'Presented camera frame change state must be an exact boolean.',
      );
    }
    if (!Number.isFinite(now) || now < 0) {
      throw new TypeError(
        'Presented camera frame time must be a finite non-negative number.',
      );
    }
    if (typeof burstEligible !== 'boolean') {
      throw new TypeError(
        'Presented camera burst eligibility must be an exact boolean.',
      );
    }

    if (changed) {
      this._lastChangeTime = now;
      this._unchangedFrameCount = 0;
      if (!burstEligible) {
        this._pending = false;
        return null;
      }
      if (this._pending) return null;
      this._pending = true;
      return 'camera-changing';
    }

    if (!this._pending) return null;
    this._unchangedFrameCount = Math.min(
      MAXIMUM_UNCHANGED_FRAMES,
      this._unchangedFrameCount + 1,
    );
    if (
      this._unchangedFrameCount < MINIMUM_UNCHANGED_FRAMES
      || (
        now - this._lastChangeTime < DEFAULT_SETTLE_MILLISECONDS
        && this._unchangedFrameCount < MAXIMUM_UNCHANGED_FRAMES
      )
    ) {
      return null;
    }

    this._pending = false;
    this._unchangedFrameCount = 0;
    return 'camera-settled';
  }
}
