/**
 * @fileoverview The page's key listener: the plain key presses the shortcut
 * table binds (`shortcut-table.js`: F, H, R, 1–3, O/P/G, X, ?, /), each run
 * by the module that owns its command (`provideShortcut`), and the Keyboard
 * shortcuts panel drawn from the same table. Each that changes state goes
 * through its action, so a key records exactly the step its control would,
 * and a key that is no shortcut here changes nothing (`isShortcutPress`).
 * Keys pressed in an open dialog never reach it: the dialog keeps its keys
 * (`ui/components/app-dialog.js`).
 * @module ui/onboarding/keyboard-shortcuts
 */

import { isPageKey } from '../../../utils/key-ownership.js';
import { revealInSidebar } from '../modules/sidebar-controls.js';
import { SHORTCUT_COMMANDS, SHORTCUT_PRESSES, renderShortcutPanel } from './shortcut-table.js';

/** command → the function that runs it (`provideShortcut`). */
const shortcutHandlers = new Map();

let shortcutsListenerAttached = false;

/**
 * Run `command` (a command of the shortcut table) with `handler` when its key
 * is pressed. One module owns each command.
 *
 * @param {string} command
 * @param {(arg: unknown) => void} handler - Takes the key's argument (the dimension, the mode)
 * @returns {() => void} Withdraw it.
 */
export function provideShortcut(command, handler) {
  if (!SHORTCUT_COMMANDS.has(command)) throw new RangeError(`No key of the shortcut table runs "${command}".`);
  if (typeof handler !== 'function') throw new TypeError(`The shortcut "${command}" needs a function.`);
  if (shortcutHandlers.has(command)) throw new Error(`The shortcut "${command}" is already provided.`);
  shortcutHandlers.set(command, handler);
  return () => {
    if (shortcutHandlers.get(command) === handler) shortcutHandlers.delete(command);
  };
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('Fullscreen request failed:', err);
    });
    return;
  }
  document.exitFullscreen();
}

/**
 * ? : the Keyboard shortcuts panel, opened, in view and focused, so Tab goes
 * on inside it. The sidebar is shown first when the panel is in it (pressed
 * with the sidebar hidden, the panel opened inside a hidden, inert sidebar:
 * nothing to see). The scroll is instant, as every move to a control is
 * (`revealGeneReadControl`): an explicit smooth scroll overrode the reduced
 * motion setting (`scroll-behavior` in CSS does not apply to it).
 *
 * The sidebar is shown (its step, `layout.sidebar.show`) before the panel
 * opens (its own, `layout.section.open`): opened first, the panel's opening
 * would reach the history while the sidebar's action was starting and be kept
 * as a change made outside the history.
 */
function showShortcutsHelp(ownerDocument = document) {
  const section = ownerDocument.getElementById('shortcuts-section');
  if (section === null) return;
  const open = () => {
    section.open = true;
    section.scrollIntoView({ block: 'start' });
    section.querySelector(':scope > summary')?.focus({ preventScroll: true });
  };
  if (section.closest('#sidebar') === null) open();
  else void revealInSidebar(ownerDocument, open);
}

/**
 * Whether a key press is one of these shortcuts' to take: a key the page
 * answers (`isPageKey`: not typed into a field or a select, not pressed in a
 * menu or a dialog, not taken by the focused control), not a chord with
 * Ctrl, ⌘ or Alt (⌘P prints, ⌘F finds, ⌘1 picks a browser tab: the
 * browser's and the system's keys, never a navigation mode, the fullscreen
 * or a view), and not the auto-repeat of a key held down (H held would hide
 * and show the sidebar over and over, a step each).
 *
 * @param {{target?: object|null, defaultPrevented?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean}} event
 * @returns {boolean}
 */
export function isShortcutPress(event) {
  return isPageKey(event) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat;
}

/**
 * The page's key listener: a shortcut press runs its command, once its
 * module has provided it.
 *
 * @param {KeyboardEvent} e
 */
export function answerShortcutKey(e) {
  if (!isShortcutPress(e)) return;
  const binding = SHORTCUT_PRESSES.get(String(e.key || '').toLowerCase());
  if (binding === undefined) return;
  const handler = shortcutHandlers.get(binding.command);
  if (handler === undefined) return;
  e.preventDefault();
  handler(binding.arg);
}

/**
 * Draw the Keyboard shortcuts panel from the table and answer its keys from
 * here on. Fullscreen and Show shortcuts are this module's own.
 *
 * @param {{ownerDocument?: Document}} [options]
 */
export function initKeyboardShortcuts({ ownerDocument = document } = {}) {
  if (shortcutsListenerAttached) return;
  shortcutsListenerAttached = true;
  renderShortcutPanel(ownerDocument);
  provideShortcut('fullscreen.toggle', () => toggleFullscreen());
  provideShortcut('shortcuts.show', () => showShortcutsHelp(ownerDocument));
  ownerDocument.addEventListener('keydown', answerShortcutKey);
}
