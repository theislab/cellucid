/**
 * @fileoverview Highlight mode help text strings.
 *
 * Centralized copy used by the highlight mode toolbelt and step UI panels.
 *
 * @module ui/modules/highlight/mode-copy
 */

import { PLACES } from '../../place-names.js';

/**
 * One line per tool: the gesture and nothing else, shown first in the
 * Selection (i) tip (`publishToolHint`), above the modifier keys (Shift adds,
 * Ctrl subtracts), Select mode for screens with no Alt key and each tool's
 * details (`ui/components/info-tips.js`). The panel under the Tool buttons
 * shows only what a gesture did, so the sidebar stays short.
 */
export const HIGHLIGHT_MODE_COPY = {
  annotation: 'Alt+click a cell to select its group.',
  knn: 'Alt+drag up from a cell to grow along neighbors.',
  proximity: 'Alt+drag from a cell to select nearby cells.',
  lasso: 'Alt+draw around cells to select them.'
};

/**
 * Replaces the annotation tool's line in the Selection (i) while no presented
 * pane is colored by a field.
 *
 * An annotation press is read on the field of the pane it lands in, and a
 * pane colored by none selects nothing (the press is answered with
 * `SELECTION_NOTICE.noPanelField`). So "Alt+click a cell to select" is a
 * promise the app cannot keep only when no pane on screen has a field — in a
 * grid, the focused view having none is not enough — and only then does the
 * panel name the missing precondition and the control that supplies it.
 */
export const ANNOTATION_NEEDS_FIELD_COPY =
  `Color by a field first (${PLACES.coloringFiltering.name}), then Alt+click a cell.`;

/**
 * Why a completed gesture left the selection exactly as it was.
 *
 * A gesture that changes nothing must not be recorded as a step — it would
 * inflate the step counter and cost an undo for an action that did nothing —
 * but it must not be silent either, or it reads as the tool being broken.
 *
 * `noCellUnderPointer` names the two remedies hit testing responds to. A click
 * hits the dot drawn under the pointer, sized exactly as the shader sizes it
 * (`findScreenSpacePick` in `rendering/picking.js`), so Point size widens what
 * is hittable. Zoom does too: a nearer camera draws larger dots under
 * perspective and selects a finer LOD level, and picking rejects every cell the
 * active level has not admitted.
 *
 * `noFieldValue` and `noPanelField` name the panel, not the focused view: in a
 * grid of views an annotation gesture is read on the field of the panel it
 * landed in, and the gesture never moves focus.
 */
export const SELECTION_NOTICE = Object.freeze({
  noFieldValue:
    'That cell has no value on that panel\'s field, so there is nothing to select.',
  noPanelField:
    'That panel is not colored by a field, so there is nothing to select.',
  noCellUnderPointer:
    'That click did not land on a cell, so there is nothing to select. Zoom '
    + 'in or raise Point size to make cells easier to hit: only the cells the '
    + 'viewer is currently drawing can be clicked.',
  releasedOffView:
    'That gesture ended outside the view, so nothing was selected.',
  interrupted:
    'That gesture was interrupted before it ended, by a second finger or by '
    + 'the browser, so nothing was selected.',
  unchanged: 'That gesture did not change the selection.'
});

/**
 * The selection bar's one-line invitation for each tool while Select mode is
 * on and nothing is being selected. The bar sits over the plot, where the
 * panel's longer copy (which is about Alt) cannot fit and is not visible on a
 * phone, so it names the tool and the gesture a finger or a plain click makes.
 */
export const SELECT_BAR_HINT = Object.freeze({
  annotation: 'Annotation: tap or click a cell to select its group.',
  knn: 'KNN: press a cell and drag up to grow along neighbors.',
  proximity: 'Proximity: press a cell and drag to select nearby cells.',
  lasso: 'Lasso: draw around cells to select them.'
});

/**
 * The selection bar's annotation invitation while no presented pane is
 * colored by a field, when a tap could not select anything (see
 * ANNOTATION_NEEDS_FIELD_COPY).
 */
export const SELECT_BAR_ANNOTATION_NEEDS_FIELD_HINT =
  'Annotation: color by a field in the menu first, then tap a cell.';

/**
 * The selection bar's short form of each SELECTION_NOTICE. The panel keeps the
 * full sentence; the bar has one line, and it must still say that a tap that
 * missed changed nothing, or an empty-space tap reads as a broken tool.
 */
const SELECT_BAR_NOTICE = new Map([
  [SELECTION_NOTICE.noFieldValue, 'That cell has no value here. Nothing changed.'],
  [SELECTION_NOTICE.noPanelField, 'That panel has no field. Nothing changed.'],
  [SELECTION_NOTICE.noCellUnderPointer, 'No cell there. Nothing changed; zoom in to hit cells.'],
  [SELECTION_NOTICE.releasedOffView, 'Ended outside the view. Nothing changed.'],
  [SELECTION_NOTICE.interrupted, 'Gesture interrupted. Nothing changed.'],
  [SELECTION_NOTICE.unchanged, 'That gesture changed nothing.']
]);

/**
 * @param {string} notice "" or one SELECTION_NOTICE value
 * @returns {string} the selection bar's line for it ("" for none)
 */
export function selectBarNotice(notice) {
  if (notice === '') return '';
  if (!SELECT_BAR_NOTICE.has(notice)) {
    throw new TypeError(
      'Selection notice must be exactly "" or one SELECTION_NOTICE value.'
    );
  }
  return SELECT_BAR_NOTICE.get(notice);
}

/**
 * The wording for each reason the renderer abandons a gesture.
 *
 * The renderer reports what happened — a pick that found no cell, a release
 * that landed off the view — and nothing about what the user is told; the
 * sentence is the tool's. Both notices ride the same one-line slot as every
 * other `SELECTION_NOTICE`, so repeating the gesture repaints an identical
 * panel rather than stacking a second line, and the readout directly above
 * them already distinguishes the two cases the user cares about: the idle mode
 * copy when nothing was in progress, and "Step N: X cells — current selection"
 * when the miss interrupted an add, subtract, or intersect that stands
 * untouched.
 */
const ABANDONED_GESTURE_NOTICE = Object.freeze({
  'no-cell-under-pointer': SELECTION_NOTICE.noCellUnderPointer,
  'no-field-in-pane': SELECTION_NOTICE.noPanelField,
  'released-off-view': SELECTION_NOTICE.releasedOffView,
  interrupted: SELECTION_NOTICE.interrupted
});

/** Every reason any selection tool will accept from the renderer. */
export const ABANDONED_GESTURE_REASONS = Object.freeze([
  'no-cell-under-pointer',
  'released-off-view',
  'interrupted'
]);

/**
 * The reasons the annotation tool accepts: the shared ones, plus a press in a
 * pane colored by no field, which only the annotation tool reads a field for.
 */
export const ANNOTATION_ABANDONED_GESTURE_REASONS = Object.freeze([
  ...ABANDONED_GESTURE_REASONS,
  'no-field-in-pane'
]);

/**
 * @param {string} reason
 * @returns {string} the notice one abandoned gesture is explained with
 */
export function abandonedGestureNotice(reason) {
  if (!Object.hasOwn(ABANDONED_GESTURE_NOTICE, reason)) {
    throw new TypeError(
      `Unknown abandoned gesture reason: ${reason}.`
    );
  }
  return ABANDONED_GESTURE_NOTICE[reason];
}

/**
 * Render one selection notice as the extra line under a step readout.
 *
 * Notices are module constants, never user text, so they are interpolated
 * directly; the guard exists so a future caller cannot quietly start feeding
 * arbitrary strings into `innerHTML` through this door.
 *
 * @param {string} notice
 * @returns {string}
 */
function requireSelectionNotice(notice) {
  if (
    typeof notice !== 'string'
    || notice.length === 0
    || notice !== notice.trim()
    || !Object.values(SELECTION_NOTICE).includes(notice)
  ) {
    throw new TypeError(
      'Selection notice must be exactly "" or one SELECTION_NOTICE value.'
    );
  }
  return notice;
}

export function selectionNoticeHtml(notice) {
  if (notice === '') return '';
  return `<br><small>${requireSelectionNotice(notice)}</small>`;
}

/**
 * The panel line of a tool with nothing in progress: the notice alone, or
 * nothing (the tool's gesture is in the Selection (i): `publishToolHint`).
 *
 * @param {string} notice
 * @returns {string}
 */
export function idleSelectionNoticeHtml(notice) {
  if (notice === '') return '';
  return `<small>${requireSelectionNotice(notice)}</small>`;
}
