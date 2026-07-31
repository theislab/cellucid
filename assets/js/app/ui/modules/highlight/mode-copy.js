/**
 * @fileoverview Highlight mode help text strings.
 *
 * Centralized copy used by the highlight mode toolbelt and step UI panels.
 *
 * @module ui/modules/highlight/mode-copy
 */

export const HIGHLIGHT_MODE_COPY = {
  annotation:
    'Alt+click a cell to select. Shift+Alt to add, Ctrl+Alt to subtract. For continuous: Alt intersects.',
  knn:
    'Alt+click and drag up to expand along neighbors. Shift+Alt to add, Ctrl+Alt to subtract. Neighbor graph status appears in notifications.',
  proximity: 'Alt+click and drag to select by 3D proximity. Shift+Alt to add, Ctrl+Alt to subtract.',
  lasso:
    'Hold Alt and draw to select. Rotate and draw again: Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract.'
};

/**
 * Replaces the annotation help text while no field is coloured.
 *
 * The annotation tool reads the clicked cell's value on the active field, so
 * with no active field the viewer never even starts a gesture. Saying
 * "Alt+click a cell to select" in that state is a promise the app cannot keep,
 * so the panel names the missing precondition and the control that supplies it
 * instead.
 */
export const ANNOTATION_NEEDS_FIELD_COPY =
  'Annotation selection needs an active field. Choose a Categorical obs or '
  + 'Continuous obs field under Coloring & Filtering, then Alt+click a cell.';

/**
 * Why a completed gesture left the selection exactly as it was.
 *
 * A gesture that changes nothing must not be recorded as a step — it would
 * inflate the step counter and cost an undo for an action that did nothing —
 * but it must not be silent either, or it reads as the tool being broken.
 */
export const SELECTION_NOTICE = Object.freeze({
  noFieldValue:
    'That cell has no value on the active field, so there is nothing to select.',
  noCellUnderPointer:
    'That click did not land on a cell, so there is nothing to select. Zoom '
    + 'in, or raise Point size under Visualization, to make cells easier to '
    + 'hit.',
  releasedOffView:
    'That gesture ended outside the view, so nothing was selected.',
  unchanged: 'That gesture did not change the selection.'
});

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
  'released-off-view': SELECTION_NOTICE.releasedOffView
});

/** Every reason a selection tool will accept from the renderer. */
export const ABANDONED_GESTURE_REASONS = Object.freeze(
  Object.keys(ABANDONED_GESTURE_NOTICE)
);

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
export function selectionNoticeHtml(notice) {
  if (notice === '') return '';
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
  return `<br><small>${notice}</small>`;
}
