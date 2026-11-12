/**
 * @fileoverview Undo and redo from the keyboard: Ctrl+Z / ⌘Z undoes the
 * last step, Ctrl+Shift+Z / ⇧⌘Z (and Ctrl+Y off a Mac) redoes it.
 *
 * The keys stay with whatever owns them first:
 * - a text field (a text, search, number, … input, a textarea, anything
 *   content-editable) keeps its own undo; a slider, a checkbox, a radio, a
 *   select or a button has none, so the history's undo works from them;
 * - an open dialog or a menu keeps its keys;
 * - a selection in progress (the selection bar's steps are shown) undoes its
 *   own last step, exactly as the bar's Undo button, and is not redone by
 *   the history: the confirmed selection is what the history records.
 * A key the history does not use (nothing to undo) is left alone.
 *
 * @module ui/modules/state/keyboard
 */

import { isApplePlatform } from './shared.js';
import { isInKeyKeepingWidget, isTextEntry } from '../../../../utils/key-ownership.js';

/**
 * Which history command a key press asks for, or null. Ctrl or Command with
 * Z undoes, with Shift too redoes; Ctrl+Y redoes off a Mac. Either modifier
 * is taken on every platform: the keyboard, not the page's guess of the
 * platform, decides which one the person pressed.
 *
 * @param {{key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean}} event
 * @param {boolean} apple - A Mac, where Ctrl+Y is no shortcut
 * @returns {'undo'|'redo'|null}
 */
export function historyKeyOf(event, apple) {
  if (event.altKey || event.ctrlKey === event.metaKey) return null;
  const key = String(event.key).toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !apple && !event.shiftKey) return 'redo';
  return null;
}

function ownedElsewhere(event, ownerDocument) {
  if (event.defaultPrevented) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null) {
    // A text field keeps its own undo; a menu or a dialog keeps its keys.
    if (isTextEntry(target) || isInKeyKeepingWidget(target)) return true;
  }
  return ownerDocument.querySelector('dialog[open], [aria-modal="true"]:not([hidden]):not(.hidden)') !== null;
}

/**
 * @param {object} options
 * @param {Document} options.ownerDocument
 * @param {(command: 'undo'|'redo') => boolean} options.perform - Runs it; false when there is nothing to do
 * @param {Navigator} [options.navigatorOwner]
 * @returns {{destroy: () => void}}
 */
export function bindHistoryKeys({ ownerDocument, perform, navigatorOwner = globalThis.navigator }) {
  const apple = isApplePlatform(navigatorOwner);
  const controller = new AbortController();
  ownerDocument.addEventListener('keydown', event => {
    const command = historyKeyOf(event, apple);
    if (command === null) return;
    if (ownedElsewhere(event, ownerDocument)) return;
    const selectionSteps = ownerDocument.getElementById('select-bar-steps');
    if (selectionSteps !== null && !selectionSteps.hidden) {
      // A selection in progress keeps its own steps until it is confirmed.
      event.preventDefault();
      if (command === 'undo') {
        const undo = ownerDocument.getElementById('select-bar-undo');
        if (undo instanceof HTMLButtonElement && !undo.disabled) undo.click();
      }
      return;
    }
    if (perform(command)) event.preventDefault();
  }, { signal: controller.signal });
  return { destroy: () => controller.abort() };
}
