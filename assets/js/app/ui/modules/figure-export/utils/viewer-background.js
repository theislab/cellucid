/**
 * @fileoverview Active viewer-background reader and reference-grid appearance.
 *
 * The viewer's `Background` control decides two things at once: the colour the
 * canvas is cleared to, and whether the matplotlib-style reference grid box is
 * drawn behind the data. `viewer.setBackground()` (`rendering/viewer.js`) sets
 * every grid scalar from that one enum and the viewer exposes no reader for
 * them, so figure export resolves the appearance the same way
 * `utils/render-mode.js` resolves the render mode: from the control that owns
 * it.
 *
 * The constants below mirror `setBackground()` exactly. `tests/
 * figure-export-reference-grid.test.mjs` reads `rendering/viewer.js` and fails
 * when either side drifts, so this file can never quietly describe a grid the
 * viewer no longer draws.
 *
 * @module ui/modules/figure-export/utils/viewer-background
 */

/** Element id of the control that owns the viewer background. */
export const VIEWER_BACKGROUND_CONTROL_ID = 'background-select';

/** Backgrounds the viewer accepts. Mirrors `rendering/viewer.js`. */
const VIEWER_BACKGROUNDS = Object.freeze([
  'grid',
  'grid-dark',
  'white',
  'black',
]);

/** Reader-facing names, matching the `#background-select` option text. */
export const VIEWER_BACKGROUND_LABELS = Object.freeze({
  grid: 'Grid (light)',
  'grid-dark': 'Grid (dark)',
  white: 'White',
  black: 'Black',
});

/**
 * Half-extent of the viewer's reference grid box (`GRID_SIZE`).
 * `rendering/viewer.js` builds all six planes at ±2.0.
 */
export const REFERENCE_GRID_SIZE = 2.0;

/**
 * The exact grid scalars `setBackground()` publishes for each background.
 *
 * `opacity` is the mode's `targetGridOpacity`. The viewer ramps `gridOpacity`
 * toward it at 3.0/second, so an export taken within ~0.3 s of switching
 * background can show a slightly fainter grid than the file; every settled
 * frame matches exactly.
 *
 * @type {Readonly<Record<string, Readonly<{
 *   mode: string;
 *   opacity: number;
 *   spacing: number;
 *   lineWidth: number;
 *   size: number;
 *   lineColor: readonly number[];
 *   surfaceColor: readonly number[];
 *   axisColors: Readonly<{ x: readonly number[]; y: readonly number[]; z: readonly number[] }>;
 * }>>>}
 */
const REFERENCE_GRID_APPEARANCE_BY_MODE = Object.freeze({
  grid: Object.freeze({
    mode: 'grid',
    opacity: 0.85,
    spacing: 0.2,
    lineWidth: 0.010,
    size: REFERENCE_GRID_SIZE,
    lineColor: Object.freeze([0.56, 0.56, 0.57]),
    surfaceColor: Object.freeze([0.965, 0.965, 0.970]),
    axisColors: Object.freeze({
      x: Object.freeze([0.48, 0.46, 0.46]),
      y: Object.freeze([0.46, 0.48, 0.46]),
      z: Object.freeze([0.46, 0.46, 0.48]),
    }),
  }),
  'grid-dark': Object.freeze({
    mode: 'grid-dark',
    opacity: 0.75,
    spacing: 0.2,
    lineWidth: 0.008,
    size: REFERENCE_GRID_SIZE,
    lineColor: Object.freeze([0.38, 0.38, 0.42]),
    surfaceColor: Object.freeze([0.08, 0.09, 0.10]),
    axisColors: Object.freeze({
      x: Object.freeze([0.62, 0.58, 0.58]),
      y: Object.freeze([0.58, 0.62, 0.58]),
      z: Object.freeze([0.58, 0.58, 0.62]),
    }),
  }),
});

/**
 * Read the background the viewer is currently drawing with.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {'grid'|'grid-dark'|'white'|'black'|null} Null when unreadable.
 */
export function readActiveViewerBackground(documentRef) {
  if (
    documentRef === null ||
    typeof documentRef !== 'object' ||
    typeof documentRef.getElementById !== 'function'
  ) {
    return null;
  }
  const control = documentRef.getElementById(VIEWER_BACKGROUND_CONTROL_ID);
  if (
    control === null ||
    typeof control !== 'object' ||
    typeof control.value !== 'string'
  ) {
    return null;
  }
  return VIEWER_BACKGROUNDS.includes(control.value) ? control.value : null;
}

/**
 * The reference-grid appearance for one background, or null when that
 * background draws no grid (`White` and `Black` set `showGrid = false`).
 *
 * @param {string|null} mode
 * @returns {ReturnType<typeof readReferenceGridAppearance>}
 */
export function readReferenceGridAppearance(mode) {
  if (mode === null) return null;
  return REFERENCE_GRID_APPEARANCE_BY_MODE[mode] ?? null;
}

/**
 * The reference-grid appearance the viewer is drawing right now, or null when
 * it is drawing no grid or the background cannot be read.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 */
export function readActiveReferenceGridAppearance(documentRef) {
  return readReferenceGridAppearance(readActiveViewerBackground(documentRef));
}

/**
 * Reject anything that is not one of the appearances published above.
 *
 * The renderers derive line colours and widths from these scalars, so a
 * hand-built lookalike would paint a grid the viewer never drew.
 *
 * @param {unknown} appearance
 * @param {string} context
 * @returns {object|null}
 */
export function assertReferenceGridAppearance(appearance, context) {
  if (appearance === null) return null;
  const published = Object.values(REFERENCE_GRID_APPEARANCE_BY_MODE);
  if (!published.includes(appearance)) {
    throw new TypeError(
      `${context} must be null or a published viewer reference-grid appearance.`
    );
  }
  return appearance;
}

/**
 * Build the fidelity blockers raised by an unreadable viewer background.
 *
 * A background that cannot be read cannot be reproduced: the export would
 * either omit a grid the viewer draws or draw one it does not.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {{ title: string; detail: string }[]}
 */
export function buildViewerBackgroundFidelityWarnings(documentRef) {
  if (readActiveViewerBackground(documentRef) !== null) return [];
  return [{
    title: 'Active viewer background unavailable',
    detail:
      'The background control could not be read, so whether the viewer is '
      + 'drawing its reference grid — and in which theme — cannot be confirmed. '
      + 'Restore the rendering controls before exporting.',
  }];
}
