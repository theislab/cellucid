/**
 * The camera's field of view, fitted to the shape of the presented area.
 *
 * Every camera — the default one of each dimension, a sample's published
 * preset, a saved session's — is a distance from a target. What that distance
 * shows depends on the field of view: 45° vertically. On a landscape screen
 * the width shows more than that, so a camera framed to the data's height
 * shows all of it. On a portrait screen (a phone held upright) the width
 * shows less, so the same camera cut the data off at both sides.
 *
 * The 45° therefore applies to the presented area's shorter side: vertically
 * on a landscape area, exactly as before, and horizontally on a portrait one,
 * where the vertical angle widens to match. A camera then frames the same
 * data on every screen shape, and nothing changes on a landscape screen.
 *
 * @module rendering/viewer/field-of-view
 */

/** The vertical field of view of a landscape (or square) presented area. */
export const BASE_FIELD_OF_VIEW = 45 * Math.PI / 180;

/**
 * The vertical field of view, in radians, for a presented area of this
 * aspect (CSS width over CSS height).
 *
 * @param {number} aspect
 * @returns {number}
 */
export function fieldOfViewFor(aspect) {
  if (!(Number.isFinite(aspect) && aspect > 0)) {
    throw new RangeError('The presented area aspect must be a positive finite number.');
  }
  if (aspect >= 1) return BASE_FIELD_OF_VIEW;
  return 2 * Math.atan(Math.tan(BASE_FIELD_OF_VIEW / 2) / aspect);
}
