/**
 * When two captures count as the same picture: when every byte of every
 * pixel is equal.
 *
 * Two draws of identical inputs (data, camera, viewport, draw order, GPU
 * stores) through the same drawing path give identical pixels, so a parity
 * spec asserts exactly that and allows no tolerance. A pixel that differs is
 * a defect, reported with how many differ, by how much, and where.
 */

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
 * Null when `report` ({lit, mismatched, maxDelta, first}) shows no pixel that
 * differs, otherwise one line saying how many differ, by how much at most and
 * the first few with both values.
 */
export function pixelParityVerdict(report, label = 'capture') {
  const { lit, mismatched, maxDelta } = report;
  if (mismatched === 0) return null;
  return (
    `${label}: ${mismatched} of ${lit} lit pixels differ, max delta ${maxDelta}, ` +
    `first ${JSON.stringify(report.first ?? [])}`
  );
}
