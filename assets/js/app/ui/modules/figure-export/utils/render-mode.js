/**
 * @fileoverview Active render-mode fidelity gate for figure export.
 *
 * The viewer branches its whole draw pass on the render mode: `points` draws
 * the point layer, `smoke` ray-marches a volumetric density field. Figure
 * export only ever draws the point layer, so exporting while the viewer is in
 * any other mode produces an image of something the user never saw, carrying
 * metadata that claims it is the current view.
 *
 * The `#render-mode` control is the owner of that mode in the UI layer:
 * `ui/modules/render-controls.js` publishes every mode change through
 * `viewer.setRenderMode()` and `syncRenderModeUi()` together, including the
 * path that settles back to `points` after a smoke render failure, so the
 * control value tracks the viewer exactly. The viewer exposes no reader.
 *
 * @module ui/modules/figure-export/utils/render-mode
 */

/** The one render mode figure export is able to reproduce. */
export const EXPORTABLE_RENDER_MODE = 'points';

/** Element id of the control that owns the active render mode. */
export const RENDER_MODE_CONTROL_ID = 'render-mode';

/** Render modes the viewer accepts. Mirrors `ui/modules/render-controls.js`. */
const RENDER_MODES = Object.freeze(['points', 'smoke']);

/** Reader-facing names, matching the `#render-mode` option text. */
const RENDER_MODE_LABELS = Object.freeze({
  points: 'Points',
  smoke: 'Volumetric smoke cloud'
});

/**
 * Read the render mode the viewer is currently drawing with.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {'points'|'smoke'|null} Null when the mode cannot be established.
 */
export function readActiveRenderMode(documentRef) {
  if (
    documentRef === null ||
    typeof documentRef !== 'object' ||
    typeof documentRef.getElementById !== 'function'
  ) {
    return null;
  }
  const control = documentRef.getElementById(RENDER_MODE_CONTROL_ID);
  if (
    control === null ||
    typeof control !== 'object' ||
    typeof control.value !== 'string'
  ) {
    return null;
  }
  return RENDER_MODES.includes(control.value) ? control.value : null;
}

/**
 * Build the fidelity blockers raised by the active render mode.
 *
 * An unreadable mode blocks as well: an export that cannot confirm what the
 * viewer is drawing cannot promise to reproduce it.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {{ title: string; detail: string }[]}
 */
export function buildRenderModeFidelityWarnings(documentRef) {
  const mode = readActiveRenderMode(documentRef);
  if (mode === EXPORTABLE_RENDER_MODE) return [];
  if (mode === null) {
    return [{
      title: 'Active render mode unavailable',
      detail:
        'Figure export reproduces the Points render mode only, and the render-mode '
        + 'control could not be read, so the mode the viewer is drawing with cannot '
        + 'be confirmed. Reload the page and export again.'
    }];
  }
  const label = RENDER_MODE_LABELS[mode];
  return [{
    title: `${label} render mode not exported`,
    detail:
      `The viewer is drawing in ${label} mode, but figure export renders the point `
      + 'layer only, so the exported figure would show different data from the '
      + 'active view. Set "Render mode" to Points before exporting.'
  }];
}
