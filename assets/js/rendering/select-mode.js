/**
 * @fileoverview Select mode: the on-screen stand-in for a held Alt key.
 *
 * Every highlight tool starts from a primary press that Alt has armed, and
 * Shift or Ctrl/Cmd on that press choose how the gesture combines with the
 * selection already in progress. A touch screen has neither key, so without a
 * stand-in a phone or tablet could not select anything at all.
 *
 * Select mode is that stand-in, and only that. While it is on, an unmodified
 * primary press is armed exactly as an Alt press is and goes down the same
 * renderer path; `combine` supplies the Shift/Ctrl choice a finger cannot make.
 * A modifier that is physically held still wins, so a keyboard user who turns
 * the mode on keeps every chord they already know.
 *
 * @module rendering/select-mode
 */

/** How one gesture folds into the selection in progress. */
export const SELECT_MODE_COMBINES = Object.freeze([
  'intersect',
  'union',
  'subtract'
]);

/** The state the viewer starts in: no stand-in, Alt alone arms a gesture. */
export const SELECT_MODE_OFF = Object.freeze({
  enabled: false,
  combine: 'intersect'
});

/**
 * Validate and freeze one select-mode record.
 *
 * @param {unknown} value
 * @returns {Readonly<{enabled: boolean, combine: 'intersect'|'union'|'subtract'}>}
 */
export function requireSelectMode(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('Select mode must be one plain record.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'combine' || keys[1] !== 'enabled') {
    throw new TypeError('Select mode must contain exactly combine, enabled.');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new TypeError('Select mode enabled must be an exact boolean.');
  }
  if (!SELECT_MODE_COMBINES.includes(value.combine)) {
    throw new TypeError(
      'Select mode combine must be exactly "intersect", "union", or "subtract".'
    );
  }
  return Object.freeze({ enabled: value.enabled, combine: value.combine });
}

/**
 * Decide whether one press starts a selection gesture, and how it combines.
 *
 * This is the only place the renderer reads Alt, Shift, Ctrl, or Cmd off a
 * press, so every tool arms and combines identically whether the press came
 * from a mouse, a pen, or a finger.
 *
 * @param {{button: number, altKey: boolean, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean}} event
 * @param {Readonly<{enabled: boolean, combine: string}>} selectMode
 * @returns {null|'intersect'|'union'|'subtract'} null when the press is camera input
 */
export function resolveSelectionGestureCombine(event, selectMode) {
  if (event.button !== 0) return null;
  if (event.altKey !== true && selectMode.enabled !== true) return null;
  if (event.ctrlKey === true || event.metaKey === true) return 'subtract';
  if (event.shiftKey === true) return 'union';
  return selectMode.enabled ? selectMode.combine : 'intersect';
}
