/**
 * @fileoverview Overlay fidelity gates and disclosures for figure export.
 *
 * The viewer draws three kinds of thing on top of the point layer:
 *
 * 1. **Data overlays** — connectivity edges and the velocity vector field.
 *    These carry measurements. Figure export cannot draw them, so exporting
 *    while one is on would publish a figure that omits data the user was
 *    looking at. Those are blockers.
 * 2. **Interaction chrome** — the orbit compass, lasso and selection
 *    indicators, the projectile sandbox, the multiview title chips. These are
 *    navigation aids, not measurements, and no figure should carry them.
 *    Blocking on those would make ordinary exports impossible; instead they are
 *    disclosed in the dialog so nothing is discovered only after the fact.
 * 3. **Viewer background layers** — the reference grid, which figure export
 *    now reproduces (`components/reference-grid.js`).
 *
 * @module ui/modules/figure-export/utils/overlay-fidelity
 */

/** Element id of the control that owns the velocity overlay. */
export const VELOCITY_OVERLAY_CONTROL_ID = 'velocity-overlay-enabled';

/**
 * Read whether the velocity vector-field overlay is currently rendering.
 *
 * `ui/modules/velocity-overlay-controls.js` is the single publisher: it clears
 * and disables this checkbox whenever the overlay stops rendering, including
 * every failure path, so the control tracks the viewer exactly.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {boolean|null} Null when the control cannot be read.
 */
export function readVelocityOverlayEnabled(documentRef) {
  if (
    documentRef === null ||
    typeof documentRef !== 'object' ||
    typeof documentRef.getElementById !== 'function'
  ) {
    return null;
  }
  const control = documentRef.getElementById(VELOCITY_OVERLAY_CONTROL_ID);
  if (
    control === null ||
    typeof control !== 'object' ||
    typeof control.checked !== 'boolean'
  ) {
    return null;
  }
  return control.checked;
}

/**
 * Build the fidelity blockers raised by data overlays the export cannot draw.
 *
 * @param {object} options
 * @param {{ getElementById: (id: string) => unknown }|null} options.documentRef
 * @param {boolean} options.connectivityVisible - viewer is drawing edges
 * @returns {{ title: string; detail: string }[]}
 */
export function buildOverlayFidelityWarnings({
  documentRef,
  connectivityVisible,
}) {
  if (typeof connectivityVisible !== 'boolean') {
    throw new TypeError(
      'Figure export overlay fidelity requires an exact connectivity visibility boolean.'
    );
  }
  const warnings = [];

  if (connectivityVisible) {
    warnings.push({
      title: 'Connectivity overlay not exported',
      detail:
        'Connectivity lines are enabled in the viewer, but figure export currently exports the point layer only (no edges).',
    });
  }

  const velocityEnabled = readVelocityOverlayEnabled(documentRef);
  if (velocityEnabled === null) {
    warnings.push({
      title: 'Velocity overlay state unavailable',
      detail:
        'Figure export draws the point layer only, and the velocity-overlay '
        + 'control could not be read, so whether the viewer is drawing a vector '
        + 'field cannot be confirmed. Restore the rendering controls before exporting.',
    });
  } else if (velocityEnabled) {
    warnings.push({
      title: 'Velocity overlay not exported',
      detail:
        'The velocity vector field is enabled in the viewer, but figure export '
        + 'renders the point layer only, so the exported figure would omit the '
        + 'flow the active view shows. Turn the velocity overlay off before exporting.',
    });
  }

  return warnings;
}

/**
 * Viewer chrome a figure never carries, stated up front in the dialog.
 *
 * These are interaction aids rather than measurements: dropping them is the
 * correct figure, but it should never be a surprise.
 */
export const NON_EXPORTED_VIEWER_CHROME = Object.freeze([
  'orbit compass',
  'lasso and selection radius indicators',
  'multiview panel title chips',
  'projectile sandbox',
]);
