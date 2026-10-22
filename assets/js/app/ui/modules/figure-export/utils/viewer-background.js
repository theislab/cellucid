/**
 * @fileoverview Active viewer-background reader and reference-layer appearance.
 *
 * The viewer's `Background` control decides two things at once: the colour the
 * canvas is cleared to, and which reference layer is drawn behind the data —
 * the matplotlib-style grid box (`Grid`), the floor and dot surface
 * (`Studio`), or nothing (`White`, `Black`). `viewer.setBackground()`
 * (`rendering/viewer.js`) sets every layer scalar from that one enum and the
 * viewer exposes no reader for them, so figure export resolves the appearance
 * the same way `utils/render-mode.js` resolves the render mode: from the
 * control that owns it.
 *
 * The grid constants below mirror `setBackground()` exactly;
 * `tests/figure-export-viewer-layer-fidelity.test.mjs` reads
 * `rendering/viewer.js` and fails when either side drifts. The studio
 * appearance is not mirrored at all: it is the viewer's own palette,
 * imported from `rendering/studio-backdrop.js`.
 *
 * @module ui/modules/figure-export/utils/viewer-background
 */

import {
  STUDIO_PALETTES,
  studioColor01,
} from '../../../../../rendering/studio-backdrop.js';
import {
  LOOK_VIEWER_BACKGROUNDS,
  STUDIO_VIEWER_BACKGROUNDS,
  isViewerBackground,
} from '../../../../../rendering/viewer-backgrounds.js';
import { backdropLookSurface01 } from '../../../../../rendering/backdrops/backdrop-looks.js';

export { VIEWER_BACKGROUND_LABELS } from '../../../../../rendering/viewer-backgrounds.js';

/** Element id of the control that owns the viewer background. */
const VIEWER_BACKGROUND_CONTROL_ID = 'background-select';

/**
 * Half-extent of the viewer's reference grid box (`GRID_SIZE`).
 * `rendering/viewer.js` builds all six planes at ±2.0.
 */
export const REFERENCE_GRID_SIZE = 2.0;

/**
 * The exact reference-layer appearance `setBackground()` publishes for each
 * background that draws one.
 *
 * `kind: 'grid'` records carry the grid scalars. `opacity` is the mode's
 * `targetGridOpacity`; the viewer ramps `gridOpacity` toward it at
 * 3.0/second, so an export taken within ~0.3 s of switching background can
 * show a slightly fainter grid than the file; every settled frame matches
 * exactly.
 *
 * `kind: 'studio'` records carry the studio palette the viewer draws with and
 * its surface (clear) colour. The viewer fades the backdrop in at the same
 * rate, with the same settled-frame guarantee.
 *
 * `kind: 'look'` records name a baked backdrop look and its surface colour;
 * the look itself travels per pane in `renderState.backdrop.look` and is
 * redrawn by `components/backdrop-look-export.js`.
 *
 * @type {Readonly<Record<string, Readonly<{
 *   kind: 'grid';
 *   mode: string;
 *   opacity: number;
 *   spacing: number;
 *   lineWidth: number;
 *   size: number;
 *   lineColor: readonly number[];
 *   surfaceColor: readonly number[];
 *   axisColors: Readonly<{ x: readonly number[]; y: readonly number[]; z: readonly number[] }>;
 * }> | Readonly<{
 *   kind: 'studio';
 *   mode: string;
 *   palette: object;
 *   surfaceColor: readonly number[];
 * }>>>}
 */
const REFERENCE_GRID_APPEARANCE_BY_MODE = Object.freeze({
  grid: Object.freeze({
    kind: 'grid',
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
    kind: 'grid',
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
  ...Object.fromEntries(STUDIO_VIEWER_BACKGROUNDS.map((mode) => [
    mode,
    Object.freeze({
      kind: 'studio',
      mode,
      palette: STUDIO_PALETTES[mode],
      surfaceColor: Object.freeze(studioColor01(STUDIO_PALETTES[mode].surface)),
    }),
  ])),
  ...Object.fromEntries(LOOK_VIEWER_BACKGROUNDS.map((mode) => [
    mode,
    Object.freeze({
      kind: 'look',
      mode,
      surfaceColor: Object.freeze(backdropLookSurface01(mode)),
    }),
  ])),
});

/**
 * Read the background the viewer is currently drawing with.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {string|null} One of `VIEWER_BACKGROUNDS`, or null when unreadable.
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
  return isViewerBackground(control.value) ? control.value : null;
}

/**
 * The reference-layer appearance for one background, or null when that
 * background draws none (`White` and `Black`).
 *
 * @param {string|null} mode
 * @returns {ReturnType<typeof readReferenceGridAppearance>}
 */
function readReferenceGridAppearance(mode) {
  if (mode === null) return null;
  return REFERENCE_GRID_APPEARANCE_BY_MODE[mode] ?? null;
}

/**
 * The reference-layer appearance the viewer is drawing right now, or null
 * when it is drawing none or the background cannot be read.
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
 * hand-built lookalike would paint a layer the viewer never drew.
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
      `${context} must be null or a published viewer reference-layer appearance.`
    );
  }
  return appearance;
}

/**
 * Build the fidelity blockers raised by an unreadable viewer background.
 *
 * A background that cannot be read cannot be reproduced: the export would
 * either omit a reference layer the viewer draws or draw one it does not.
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
      + 'drawing a reference layer — and which one, in which theme — cannot be confirmed. '
      + 'Reload the page and export again.',
  }];
}
