/**
 * @fileoverview Overlay fidelity gates and disclosures for figure export.
 *
 * The viewer draws three kinds of thing on top of the point layer:
 *
 * 1. **Data overlays** — connectivity edges and the velocity vector field.
 *    These carry measurements. Figure export cannot draw the edges, so
 *    exporting while they are on would publish a figure that omits data the
 *    user was looking at: a blocker. The vector field is drawn as a still
 *    picture of its flow, arrows on a grid
 *    (`components/vector-field-figure.js`); only a switch that cannot be read
 *    blocks.
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
/** Element id of the control that shows the connectivity edges. */
const CONNECTIVITY_CONTROL_ID = 'toggle-connectivity';

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

/** Element id of the select that names the vector field shown. */
const VELOCITY_FIELD_CONTROL_ID = 'velocity-field';
/** Element id of the overlay's color scheme. */
const VELOCITY_COLORMAP_CONTROL_ID = 'velocity-colormap';

/**
 * What a figure draws of the vector field: the field the overlay shows and
 * its color scheme, or null when no field is shown
 * (`components/vector-field-figure.js` draws it as arrows on a grid).
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {{fieldId: string, colormapId: string}|null}
 */
export function readShownVectorFieldOverlay(documentRef) {
  const fieldId = readShownVectorFieldId(documentRef);
  if (fieldId === null) return null;
  const colormap = documentRef.getElementById(VELOCITY_COLORMAP_CONTROL_ID);
  if (colormap === null || typeof colormap !== 'object' || typeof colormap.value !== 'string' || colormap.value.length === 0) {
    throw new TypeError('The vector field\'s color scheme control cannot be read.');
  }
  return { fieldId, colormapId: colormap.value };
}

/**
 * The vector field the overlay shows now (the id `Vector field` names while
 * `Show overlay` is on), or null when none is shown or the controls cannot be
 * read. What `vector-field.summary` reads when it is not told a field: the
 * one the person is looking at.
 *
 * @param {{ getElementById: (id: string) => unknown }|null} documentRef
 * @returns {string|null}
 */
export function readShownVectorFieldId(documentRef) {
  if (readVelocityOverlayEnabled(documentRef) !== true) return null;
  const select = documentRef.getElementById(VELOCITY_FIELD_CONTROL_ID);
  if (select === null || typeof select !== 'object' || typeof select.value !== 'string') return null;
  return select.value.length > 0 ? select.value : null;
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
        'Connectivity edges are enabled in the viewer, but figure export '
        + 'renders the point layer only, so the exported figure would omit the '
        + 'edges the active view shows. Turn "Show connectivity edges" off '
        + 'before exporting.',
      // One step: the dialog turns it off and exports (`confirmExportFidelityWarnings`).
      fix: { label: 'edges', controlId: CONNECTIVITY_CONTROL_ID },
    });
  }

  const velocityEnabled = readVelocityOverlayEnabled(documentRef);
  if (velocityEnabled === null) {
    warnings.push({
      title: 'Velocity overlay state unavailable',
      detail:
        'Figure export draws the point layer only, and the velocity-overlay '
        + 'control could not be read, so whether the viewer is drawing a vector '
        + 'field cannot be confirmed. Reload the page and export again.',
    });
  }

  return warnings;
}
