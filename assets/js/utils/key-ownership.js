/**
 * Who a key press belongs to: the control that has focus, or the page.
 *
 * The page answers keys everywhere: its shortcuts (F, H, R, 1–3, O/P/G, X,
 * ?, /), the camera keys (W A S D Q E = - [ ] and Shift), Alt (which arms
 * the selection tools), Escape (which cancels a selection) and undo/redo.
 * A key is the page's unless what has focus uses it itself:
 *
 * - a text field types it (a text-like `<input>`, a `<textarea>`, anything
 *   content-editable), and keeps its own undo;
 * - a `<select>` jumps to the option a typed letter starts;
 * - a menu, a list box, a combo box or a dialog (a modal window included)
 *   keeps the keys pressed in it;
 * - a control's own handler took it already (`defaultPrevented`).
 *
 * Every other control leaves the letters to the page: a slider takes the
 * arrow, Home, End and Page keys, a checkbox or a radio Space, a button
 * Enter and Space. Treating every `<input>` as a text field would leave the
 * keys dead after a slider or a checkbox was used.
 *
 * One rule for every page-wide key listener (`app/ui/onboarding/keyboard-shortcuts.js`,
 * `rendering/viewer.js`, `app/ui/modules/highlight/mode-ui.js`,
 * `app/ui/modules/state/keyboard.js`, the chat's `/`); none keeps a copy.
 *
 * @module utils/key-ownership
 */

/**
 * The `<input>` types a person types text into, each with the browser's own
 * undo of that text. Every other input (range, checkbox, radio, color, file,
 * button, …) types nothing.
 */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'time', 'datetime-local', 'month', 'week',
]);

/**
 * Widgets that keep the keys pressed inside them: menus, lists and combo
 * boxes (their own arrows and letters), dialogs and modal windows (a key
 * pressed in one never acts on the page behind it).
 */
const KEY_KEEPING_WIDGETS = [
  '[role="menu"]', '[role="menubar"]', '[role="listbox"]', '[role="combobox"]',
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog',
].join(', ');

/**
 * Whether `target` is a text field: it types characters and undoes them
 * itself.
 *
 * @param {unknown} target - A key event's target
 * @returns {boolean}
 */
export function isTextEntry(target) {
  if (target === null || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tagName = String(target.tagName ?? '');
  if (tagName === 'TEXTAREA') return true;
  if (tagName !== 'INPUT') return false;
  const type = typeof target.getAttribute === 'function'
    ? (target.getAttribute('type') ?? 'text')
    : (target.type ?? 'text');
  return TEXT_INPUT_TYPES.has(String(type).toLowerCase());
}

/**
 * Whether `target` is a control the person gives a value by typing or
 * choosing in it (a text field, a select): one in focus is being edited.
 *
 * @param {unknown} target - A key event's target, or the focused element
 * @returns {boolean}
 */
export function isValueEntry(target) {
  return isTextEntry(target) || String(target?.tagName ?? '') === 'SELECT';
}

/**
 * Whether `target` sits in a widget that keeps its keys (a menu, a list, a
 * combo box, a dialog).
 *
 * @param {unknown} target - A key event's target
 * @returns {boolean}
 */
export function isInKeyKeepingWidget(target) {
  return target !== null && typeof target === 'object' && typeof target.closest === 'function'
    && target.closest(KEY_KEEPING_WIDGETS) !== null;
}

/**
 * Whether a key press is the page's to answer: not taken by the focused
 * control's own handler, not typed into a field or a select, not pressed in
 * a menu, a list, a combo box or a dialog. Modifiers and repeats are each
 * listener's own rule.
 *
 * @param {{target?: unknown, defaultPrevented?: boolean}} event
 * @returns {boolean}
 */
export function isPageKey(event) {
  if (event.defaultPrevented === true) return false;
  const target = event.target ?? null;
  if (isValueEntry(target)) return false;
  return !isInKeyKeepingWidget(target);
}
