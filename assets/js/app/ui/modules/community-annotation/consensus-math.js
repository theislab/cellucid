/**
 * @fileoverview Consensus threshold arithmetic for the community annotation UI.
 *
 * The stored consensus threshold is a signed fraction in [-1, 1]; the slider
 * that edits it works in whole percent. Keeping both conversions and the clamp
 * in one place means the slider, the readout, and the persisted value can never
 * disagree about the range.
 *
 * @module ui/modules/community-annotation/consensus-math
 */

export function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, n));
}

export function formatPctSigned11(value) {
  const v = Number.isFinite(value) ? value : 0;
  const pct = Math.round(v * 100);
  return `${pct}%`;
}

export function clampConsensusThreshold11(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(-1, Math.min(1, value));
}

export function thresholdToSliderValue(threshold11) {
  const v = clampConsensusThreshold11(Number(threshold11));
  return String(Math.round(v * 100));
}

export function sliderValueToThreshold(sliderValue) {
  const pct = Number(sliderValue);
  if (!Number.isFinite(pct)) return 0.5;
  return clampConsensusThreshold11(pct / 100);
}
