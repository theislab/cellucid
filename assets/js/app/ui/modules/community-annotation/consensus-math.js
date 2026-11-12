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

import { formatPercent } from '../../../../utils/format-units.js';

/**
 * The minimum-annotator count an input field holds: a non-negative whole
 * number of voters. The contract bounds it only by what JSON numbers carry
 * exactly (a safe integer, `config.schema.json` `maximum`); anything else the
 * field holds (empty, negative, fractional, too large) keeps `previous`, so a
 * stray keystroke never rewrites a published setting.
 *
 * @param {string} raw - The input's value
 * @param {number} previous - The count in force
 * @returns {number}
 */
export function minAnnotatorsFromInput(raw, previous) {
  const text = String(raw ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return previous;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : previous;
}

export function formatPctSigned11(value) {
  const v = Number.isFinite(value) ? value : 0;
  return formatPercent(Math.round(v * 100));
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
