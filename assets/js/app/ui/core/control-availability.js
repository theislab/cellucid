/**
 * @fileoverview Whether an input or a select can be used now, and if not,
 * why: the one way the app turns such a control off.
 *
 * A control turned off carries its reason, in the words a person reads: on
 * its `title` (the tooltip on the dimmed control) and for the code that
 * refuses a change to it (`unavailableReasonOf`: `setting.set` and a restored
 * session say the reason, `state-serializer/ui-controls.js`). Each reason
 * names the cause and what to do. The control's own title comes back when
 * it is available again. Buttons are outside it: a dimmed button's purpose
 * says why (nothing to undo, no next page).
 *
 * Contract: `tests/control-availability-contract.test.mjs` (no input or
 * select is disabled any other way).
 *
 * @module ui/core/control-availability
 */

/** @type {WeakMap<object, string>} the title a control has while available */
const availableTitles = new WeakMap();
/** @type {WeakMap<object, string>} why a control is off, while it is */
const reasons = new WeakMap();

/**
 * Turn `control` on (`reason` null) or off with `reason`.
 *
 * @param {{disabled: boolean, title?: string}} control
 * @param {string|null} reason
 */
export function setControlAvailability(control, reason) {
  if (control === null || typeof control !== 'object') {
    throw new TypeError('Control availability needs a control.');
  }
  if (reason !== null && (typeof reason !== 'string' || reason.trim().length === 0)) {
    throw new TypeError('A control turned off says why: a non-empty reason, or null to turn it on.');
  }
  const shown = reasons.get(control);
  if (reason === null) {
    control.disabled = false;
    if (shown === undefined) return;
    reasons.delete(control);
    // The control's own title back, unless its owner has set another since.
    if (control.title === shown) control.title = availableTitles.get(control) ?? '';
    availableTitles.delete(control);
    return;
  }
  if (shown === undefined) {
    availableTitles.set(control, typeof control.title === 'string' ? control.title : '');
  }
  reasons.set(control, reason);
  control.title = reason;
  control.disabled = true;
}

/**
 * Why `control` is off now, or null (it is on, or no reason was given).
 *
 * @param {{disabled: boolean}} control
 * @returns {string|null}
 */
export function unavailableReasonOf(control) {
  if (control?.disabled !== true) return null;
  return reasons.get(control) ?? null;
}
