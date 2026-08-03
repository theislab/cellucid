/**
 * @module rendering/point-size-scale
 *
 * The one point-size scale: the slider curve, its bounds, and the size a
 * dataset opens at.
 *
 * This existed twice before, as a `0.25` in the sidebar module that was the base
 * of the logarithmic slider curve and a second `0.25` in the viewer's
 * `setPointSize` bound. Two copies of one number is one copy too many when the
 * number is load-bearing at both ends: lowering the reachable minimum in the UI
 * without lowering the viewer's bound makes the slider throw at its own new low
 * end, and there is no version of that failure a user can act on.
 *
 * ## Why the slider runs below zero
 *
 * A slider position is not a percentage here, it is the exponent of a curve:
 * position 0 is `POINT_SIZE_AT_SLIDER_ZERO`, position 100 is
 * `MAXIMUM_POINT_SIZE`, and every position in between is the geometric
 * interpolation. Reaching smaller points by re-basing the curve — making
 * position 0 mean 0.05 — would leave every position meaning something new, and
 * positions are exactly what gets stored: the session serializer records the raw
 * slider string for every range control, validated only against the element's
 * live bounds, with no migration hook. A session or one of the five published
 * dataset presets carrying `16.5` would silently stop meaning 0.75 and start
 * meaning 0.196.
 *
 * Extending the domain below zero instead leaves the curve alone. Nothing that
 * was ever stored changes meaning, and the reach below 0.25 is added where there
 * was none.
 *
 * ## Why a dataset gets a size rather than a constant
 *
 * One amount of ink is right for one number of cells. Total drawn area is
 * `cellCount * diameter^2`, so holding it roughly constant means the diameter
 * falls with the square root of the count: four times the cells, half the dot.
 * A single shipped default cannot be right for both a 3,696-cell trajectory and
 * an 18-million-cell atlas — at 0.75 the first is nearly invisible and the
 * second is a solid mass — so the default is derived instead of fixed.
 */

/** The point size at slider position 0. The curve's anchor, not its minimum. */
export const POINT_SIZE_AT_SLIDER_ZERO = 0.25;

/** The point size at slider position 100. */
export const MAXIMUM_POINT_SIZE = 200;

/** The lowest slider position. Negative on purpose — see the module docstring. */
export const POINT_SIZE_SLIDER_MINIMUM = -24;

/** The highest slider position. */
export const POINT_SIZE_SLIDER_MAXIMUM = 100;

/** The slider's step, in slider positions. */
export const POINT_SIZE_SLIDER_STEP = 0.5;

/**
 * The cell count and size that fix the automatic curve.
 *
 * 100,000 cells at 1.5 reproduces the size this control shipped with — 0.75 —
 * for a dataset of around 400,000 cells, and scales in both directions from
 * there.
 */
export const POINT_SIZE_REFERENCE_CELLS = 100_000;
export const POINT_SIZE_REFERENCE_SIZE = 1.5;

/**
 * The largest size the automatic curve may choose.
 *
 * Constant ink is the right law in the middle of the range and the wrong one at
 * the small end: it answers 43 pixels for a hundred and twenty cells, which is
 * arithmetically the same amount of ink and visually a field of overlapping
 * discs with the background hidden behind them. Past this size a point has
 * stopped being a mark for a cell and become a shape in its own right.
 *
 * It bounds only the automatic choice. The slider still reaches
 * `MAXIMUM_POINT_SIZE`, because a person asking for a 200-pixel point has a
 * reason and is looking at the result.
 *
 * The value is where the curve already is for the smallest dataset anyone
 * ships: 3,696 cells asks for 7.8. So no dataset of a few thousand cells or
 * more is affected by this bound at all — it only stops the toy end running
 * away.
 */
export const MAXIMUM_AUTOMATIC_POINT_SIZE = 8;

const POINT_SIZE_SPAN = MAXIMUM_POINT_SIZE / POINT_SIZE_AT_SLIDER_ZERO;

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be one finite number.`);
  }
  return value;
}

/**
 * The point size at one slider position.
 *
 * Defined for every finite position so the bounds themselves can be derived
 * from it; callers that accept user input validate the range first.
 *
 * @param {number} position
 * @returns {number}
 */
export function sliderPositionToPointSize(position) {
  requireFinite(position, 'Point size slider position');
  return POINT_SIZE_AT_SLIDER_ZERO
    * Math.pow(POINT_SIZE_SPAN, position / 100);
}

/**
 * The slider position that renders one point size.
 *
 * @param {number} size
 * @returns {number}
 */
export function pointSizeToSliderPosition(size) {
  requireFinite(size, 'Point size');
  if (size < MINIMUM_POINT_SIZE || size > MAXIMUM_POINT_SIZE) {
    throw new RangeError(
      `Point size must be between ${formatPointSize(MINIMUM_POINT_SIZE)} `
      + `and ${MAXIMUM_POINT_SIZE}.`
    );
  }
  return (
    Math.log(size / POINT_SIZE_AT_SLIDER_ZERO) / Math.log(POINT_SIZE_SPAN)
  ) * 100;
}

/** The smallest point size the slider can reach. */
export const MINIMUM_POINT_SIZE =
  sliderPositionToPointSize(POINT_SIZE_SLIDER_MINIMUM);

/**
 * Render one point size the way the sidebar displays it.
 *
 * Three decimals below 0.1 so the bottom of the range reads as distinct values
 * rather than as a row of zeroes.
 *
 * @param {number} size
 * @returns {string}
 */
export function formatPointSize(size) {
  requireFinite(size, 'Point size');
  if (size < 0.1) return size.toFixed(3);
  return size < 10 ? size.toFixed(2) : size.toFixed(1);
}

/**
 * The slider position a dataset of this many cells should open at.
 *
 * Snapped to the slider's own step, so the position published here is exactly
 * the position the control validates on its next read, and clamped to the
 * reachable domain so a very small or very large dataset lands on the end of the
 * curve rather than off it.
 *
 * @param {number} cellCount
 * @returns {number}
 */
export function pointSizeSliderPositionForCellCount(cellCount) {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new RangeError(
      'Automatic point size requires one positive safe integer cell count.'
    );
  }
  const size = POINT_SIZE_REFERENCE_SIZE
    * Math.sqrt(POINT_SIZE_REFERENCE_CELLS / cellCount);
  const reachable = Math.min(
    MAXIMUM_AUTOMATIC_POINT_SIZE,
    Math.max(MINIMUM_POINT_SIZE, size)
  );
  const snapped =
    Math.round(pointSizeToSliderPosition(reachable) / POINT_SIZE_SLIDER_STEP)
    * POINT_SIZE_SLIDER_STEP;
  // Snapping rounds to the nearer step, which can land just above the ceiling.
  // A bound that the value it bounds can exceed is not a bound, so the ceiling
  // is expressed as a position and the snap is held under it.
  const ceilingPosition =
    Math.floor(
      pointSizeToSliderPosition(MAXIMUM_AUTOMATIC_POINT_SIZE)
      / POINT_SIZE_SLIDER_STEP
    ) * POINT_SIZE_SLIDER_STEP;
  return Math.min(
    POINT_SIZE_SLIDER_MAXIMUM,
    ceilingPosition,
    Math.max(POINT_SIZE_SLIDER_MINIMUM, snapped)
  );
}
