import { test } from '@playwright/test';

import { isHostedMacosFirefox } from './hosted-gl.mjs';

/**
 * When two captures count as the same picture.
 *
 * Two draws of identical data give identical pixels on every hardware
 * rasterizer this suite runs on, and the suite asserts exactly that. One
 * hosted renderer does not: Firefox on GitHub's macOS runner draws WebGL
 * through a software path (about 2,500 times slower than Metal) that rounds
 * the last bit of a few edge pixels differently from one GPU object to the
 * next. Measured there on 2026-10-21: 3 of 1.4 million pixels off by 1 after
 * a kept view's stores were rebuilt from identical bytes; 11 pixels between
 * two views of one geometry drawn with equal cameras; a PNG export that
 * differed from an identical export while the SVG of the same figure was
 * byte-identical. The same bytes drawn twice from the same objects stayed
 * identical every time. That is rounding, not data: a wrong point, colour,
 * order or camera moves whole points, dozens of pixels with deltas far
 * above one.
 *
 * So a capture is the same picture as another when no channel of any pixel
 * differs by more than one unit and no more than one pixel in twenty
 * thousand of the lit pixels differs at all. Anything else is a defect and
 * is reported with where and by how much. The inputs a draw depends on
 * (camera, viewport, draw order, GPU stores) are asserted equal, exactly, by
 * each spec on its own.
 *
 * That renderer also went past this measure with the asserted inputs equal
 * (13 of 921,600 pixels, a delta of 2: `snapshot-compact-lod-parity`, nightly
 * run 41382954122), so there a capture is the same picture while no more
 * than one lit pixel in a thousand differs, by any amount
 * (`helpers/hosted-gl.mjs`, which also says what that bound cannot show):
 * the most measured is 13 in a million; a wrong order, colour, camera or
 * missing cells moves far more. Every other cell holds the measure above.
 */
export const ROUNDING_SHARE_ON_HOSTED_MACOS_FIREFOX = 1 / 1000;

export const RASTERIZER_ROUNDING = Object.freeze({
  maxDelta: 1,
  // One pixel in twenty thousand of the lit pixels, at least one.
  pixelsPerLitPixel: 1 / 20_000,
});

/**
 * Compare two RGBA buffers of the same size: how many pixels differ, by how
 * much at most, and the first few with their position and both values.
 */
export function comparePixels(left, right, width) {
  if (left.length !== right.length) {
    throw new RangeError(`Pixel buffers differ in size: ${left.length} vs ${right.length}`);
  }
  let lit = 0;
  let mismatched = 0;
  let maxDelta = 0;
  const first = [];
  for (let index = 0; index < left.length; index += 4) {
    if (left[index + 3] !== 0) lit += 1;
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) {
      delta = Math.max(delta, Math.abs(left[index + channel] - right[index + channel]));
    }
    if (delta === 0) continue;
    mismatched += 1;
    if (delta > maxDelta) maxDelta = delta;
    if (first.length < 8) {
      const pixel = index / 4;
      first.push([
        pixel % width,
        Math.floor(pixel / width),
        Array.from(left.subarray(index, index + 4)),
        Array.from(right.subarray(index, index + 4)),
      ]);
    }
  }
  return { lit, mismatched, maxDelta, first };
}

/**
 * Null when `report` ({lit, mismatched, maxDelta, first}) is within the
 * rasterizer's rounding, otherwise one line saying what exceeded it. A
 * report with any mismatch is also printed, so a CI log shows where rounding
 * occurred even when the capture passed.
 */
export function pixelParityVerdict(report, label = 'capture') {
  const { lit, mismatched, maxDelta } = report;
  if (mismatched === 0) return null;
  if (isHostedMacosFirefox(test.info().project.name)) {
    const detail = `${label}: ${mismatched} of ${lit} lit pixels differ, max delta ${maxDelta}`;
    console.log(`[pixel-parity] ${detail}`);
    return mismatched > lit * ROUNDING_SHARE_ON_HOSTED_MACOS_FIREFOX ? `${detail}: too many for rounding on this renderer` : null;
  }
  const allowed = Math.max(1, Math.ceil(lit * RASTERIZER_ROUNDING.pixelsPerLitPixel));
  const detail =
    `${label}: ${mismatched} of ${lit} lit pixels differ, max delta ${maxDelta}, ` +
    `first ${JSON.stringify(report.first ?? [])}`;
  console.log(`[pixel-parity] ${detail}`);
  if (maxDelta > RASTERIZER_ROUNDING.maxDelta) {
    return `${detail}: a channel differs by more than ${RASTERIZER_ROUNDING.maxDelta}, which is not rasterizer rounding`;
  }
  if (mismatched > allowed) {
    return `${detail}: more than ${allowed} pixels differ, which is not rasterizer rounding`;
  }
  return null;
}
