/**
 * Every key the page answers everywhere, in one table: the Keyboard
 * shortcuts panel is drawn from it (`renderShortcutPanel`), the page's key
 * listener answers the presses it binds (`keyboard-shortcuts.js`), and the
 * camera keys it lists are the ones the viewer moves by
 * (`rendering/navigation-keys.js`). A key cannot be answered without being
 * listed, nor listed without being answered (round 9, R9K-4: the panel was
 * hand-written HTML beside five separate key listeners, held together by a
 * test reading both).
 *
 * A row is one line of the panel: its words, the keys it shows, and what
 * serves them:
 * - `presses`: plain key presses the page's key listener answers, each with
 *   the command it runs (provided by the module that owns it,
 *   `provideShortcut`) and that command's argument;
 * - `movements`: camera keys, held (the viewer, `NAVIGATION_KEYS`);
 * - `handles`: keys a focused widget answers, as `KeyboardEvent.key` values
 *   (the history list, `state/graph.js`; the move grammar,
 *   `ui/keyboard-move.js`, whose keys are its `MOVE_KEYS`); a test reads
 *   each widget's handler and fails on a key it answers that no row lists;
 * - `combos` only: keys served where they act (Ctrl+Z and Ctrl+Y by the
 *   history, `state/keyboard.js`; Esc by the selection tools and the pointer
 *   lock; Alt+click and Alt+drag by the selection gesture,
 *   `rendering/select-mode.js`).
 *
 * @module ui/onboarding/shortcut-table
 */

import { NAVIGATION_KEYS, keyLabelOf } from '../../../rendering/navigation-keys.js';
import { MOVE_KEYS } from '../keyboard-move.js';

/**
 * @typedef {{keys: string[], gesture?: string}} ShortcutCombo - Keys pressed together, then a pointer gesture (`click`, `drag`)
 * @typedef {{key: string, command: string, arg?: unknown}} ShortcutPress - `key`: `KeyboardEvent.key`, lowercase
 * @typedef {{label: string, title?: string, combos: ShortcutCombo[], presses?: ShortcutPress[], movements?: string[], handles?: string[], modes?: string[]}} ShortcutRow - `modes`: the navigation modes a camera row other than held keys acts in
 * @typedef {{id: string, title: string, rows: ShortcutRow[]}} ShortcutGroup
 */

/** One key pressed alone, which runs `command` with `arg`. */
const press = (key, command, arg) => ({ key, command, ...(arg === undefined ? {} : { arg }) });

/** The label a pressed key is shown with: letters in capitals, the rest as typed. */
const labelOfPress = key => (/^[a-z]$/.test(key) ? key.toUpperCase() : key);

/** A row of keys pressed alone. */
function pressRow(label, presses, extra = {}) {
  return { label, ...extra, combos: presses.map(each => ({ keys: [labelOfPress(each.key)] })), presses };
}

/** A row of camera keys (`NAVIGATION_KEYS`), each shown once. */
function movementRow(label, movements) {
  const labels = [...new Set(movements.flatMap(movement => NAVIGATION_KEYS[movement].map(keyLabelOf)))];
  return { label, combos: labels.map(key => ({ keys: [key] })), movements };
}

/** A row served where it acts. */
function comboRow(label, keys, gesture) {
  return { label, combos: [{ keys, ...(gesture === undefined ? {} : { gesture }) }] };
}

/** A row of a focused widget's keys: `combos` as shown, `handles` the `KeyboardEvent.key` values it answers. */
function widgetRow(label, combos, handles, extra = {}) {
  return { label, ...extra, combos: combos.map(keys => ({ keys })), handles };
}

/** How a `KeyboardEvent.key` is shown. */
const KEY_SYMBOLS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space', Escape: 'Esc' };
const shownKey = key => KEY_SYMBOLS[key] ?? key;

/** @type {readonly ShortcutGroup[]} */
export const SHORTCUT_GROUPS = Object.freeze([
  {
    id: 'general',
    title: 'General',
    rows: [
      pressRow('Reset camera', [press('r', 'camera.reset')]),
      pressRow('Fullscreen', [press('f', 'fullscreen.toggle')]),
      pressRow('Toggle sidebar', [press('h', 'sidebar.toggle')]),
      pressRow('Embedding · again: next', [
        press('1', 'representation.cycle', 1),
        press('2', 'representation.cycle', 2),
        press('3', 'representation.cycle', 3),
      ], { title: "1D, 2D or 3D: that dimension's default embedding in the selected view; press again for its next embedding" }),
      pressRow('Navigation mode', [
        press('o', 'navigation.set', 'orbit'),
        press('p', 'navigation.set', 'planar'),
        press('g', 'navigation.set', 'free'),
      ]),
      pressRow('Show shortcuts', [press('?', 'shortcuts.show')]),
      pressRow('Open the chat', [press('/', 'chat.open')]),
      comboRow('Undo the last step', ['Ctrl', 'Z']),
      {
        label: 'Redo',
        title: 'Ctrl+Y redoes too, except on a Mac; on a Mac, ⌘ stands for Ctrl',
        combos: [{ keys: ['Shift', 'Ctrl', 'Z'] }, { keys: ['Ctrl', 'Y'] }],
      },
    ],
  },
  {
    id: 'navigation',
    title: 'Navigation',
    rows: [
      movementRow('Orbit / pan / move', ['forward', 'left', 'back', 'right']),
      movementRow('Move faster', ['faster']),
    ],
  },
  {
    id: 'zoom',
    title: 'Zoom',
    rows: [
      movementRow('Zoom in', ['zoomIn']),
      movementRow('Zoom out', ['zoomOut']),
    ],
  },
  {
    id: 'free-fly',
    title: 'Free-fly',
    rows: [
      movementRow('Up / down', ['up', 'down']),
      { ...comboRow('Release pointer', ['Esc']), modes: ['free'] },
    ],
  },
  {
    id: 'selection',
    title: 'Selection',
    rows: [
      comboRow('Highlight group', ['Alt'], 'click'),
      comboRow('Drag with the active tool', ['Alt'], 'drag'),
      comboRow('Add to selection', ['Shift', 'Alt'], 'click'),
      { ...comboRow('Subtract', ['Ctrl', 'Alt'], 'click'), title: 'Subtract from the selection' },
      comboRow('Cancel selection', ['Esc']),
      comboRow('Leave Select mode', ['Esc']),
      pressRow('Clear highlights', [press('x', 'highlights.clear')]),
    ],
  },
  {
    // A focused row of the history (`state/graph.js`, History v2 §3.9, §3.13).
    id: 'history',
    title: 'History list',
    rows: [
      widgetRow('Next or previous row', [['↑'], ['↓']], ['ArrowUp', 'ArrowDown'], { title: 'With Shift, select several' }),
      widgetRow('First or last row', [['Home'], ['End']], ['Home', 'End'], { title: 'With Shift, select them' }),
      widgetRow('A page up or down', [['PgUp'], ['PgDn']], ['PageUp', 'PageDown'], { title: 'With Shift, select them' }),
      widgetRow('Open or close a row', [['→'], ['←']], ['ArrowRight', 'ArrowLeft'], { title: 'A branch, a turn, a group or a run' }),
      widgetRow('Show the step', [['Enter']], ['Enter'], { title: 'Or double-click the row' }),
      widgetRow('Open its details', [['Space']], [' '], { title: 'Or its ›' }),
      widgetRow('Before or after', [['Alt', '↑'], ['Alt', '↓']], [], { title: 'Show the step before or after, without its details' }),
      widgetRow('Rename', [['F2']], ['F2']),
      widgetRow('Delete (asks first)', [['Delete'], ['Backspace']], ['Delete', 'Backspace']),
      widgetRow('The row’s menu', [['Shift', 'F10'], ['Menu']], ['F10', 'ContextMenu']),
      widgetRow('The previous or next fork', [['['], [']']], ['[', ']']),
      widgetRow('Group the steps selected', [['Ctrl', 'G']], ['g']),
      widgetRow('Branch from here', [['Ctrl', 'Shift', 'B']], ['b'], { title: 'Branch from the step selected' }),
      widgetRow('Search the history', [['/']], ['/']),
      widgetRow('Close the details', [['Esc']], ['Escape'], { title: 'With no details open, keep only this row selected' }),
      // Anywhere while a tour of the history plays (`state/tour.js`).
      comboRow('Stop a tour of the history', ['Esc']),
    ],
  },
  {
    // One grammar for moving a thing to a place by keys (`ui/keyboard-move.js`):
    // a panel floated or docked, a page into Create categorical and its order,
    // a legend category onto another.
    id: 'move',
    title: 'Moving by keys',
    rows: [
      widgetRow('Pick up, then drop', [['Enter'], ['Space']], [...MOVE_KEYS.activate]),
      widgetRow('Choose where it goes', [...MOVE_KEYS.backward, ...MOVE_KEYS.forward].map(key => [shownKey(key)]),
        [...MOVE_KEYS.backward, ...MOVE_KEYS.forward], { title: 'Each place is announced' }),
      widgetRow('First or last place', [...MOVE_KEYS.first, ...MOVE_KEYS.last].map(key => [shownKey(key)]),
        [...MOVE_KEYS.first, ...MOVE_KEYS.last]),
      widgetRow('Cancel', MOVE_KEYS.cancel.map(key => [shownKey(key)]), [...MOVE_KEYS.cancel]),
    ],
  },
].map(group => Object.freeze({ ...group, rows: Object.freeze(group.rows.map(row => Object.freeze(row))) })));

/** Every key press the page's key listener answers: `KeyboardEvent.key` (lowercase) → its command. */
export const SHORTCUT_PRESSES = (() => {
  const presses = new Map();
  for (const group of SHORTCUT_GROUPS) {
    for (const row of group.rows) {
      for (const each of row.presses ?? []) {
        if (presses.has(each.key)) throw new Error(`The key ${each.key} is listed twice in the shortcut table.`);
        presses.set(each.key, Object.freeze(each));
      }
    }
  }
  return presses;
})();

/**
 * A row's keys as one line of text ("Shift+Ctrl+Z Ctrl+Y"), for a tip.
 *
 * @param {ShortcutRow} row
 * @returns {string}
 */
export function shortcutKeysText(row) {
  const spaced = row.combos.some(combo => combo.keys.length > 1 || combo.gesture !== undefined);
  return row.combos.map(combo => combo.keys.join('+') + (combo.gesture === undefined ? '' : `+${combo.gesture}`)).join(spaced ? ' / ' : ' ');
}

/** The group `id` of the table. */
export function shortcutGroup(id) {
  const group = SHORTCUT_GROUPS.find(each => each.id === id);
  if (group === undefined) throw new RangeError(`No shortcut group "${id}".`);
  return group;
}

/** Every command a key press runs. */
export const SHORTCUT_COMMANDS = Object.freeze(new Set([...SHORTCUT_PRESSES.values()].map(each => each.command)));

/**
 * Draw the rows of every group into the panel's lists
 * (`[data-shortcut-group="<id>"]` in `#shortcuts-section`; each list keeps
 * its heading and its (i)). A list the page does not have is skipped.
 *
 * @param {Document} ownerDocument
 */
export function renderShortcutPanel(ownerDocument) {
  for (const group of SHORTCUT_GROUPS) {
    const list = ownerDocument.querySelector(`#shortcuts-section [data-shortcut-group="${group.id}"]`);
    if (list === null) continue;
    for (const old of list.querySelectorAll(':scope > .shortcut-item')) old.remove();
    for (const row of group.rows) list.append(shortcutItem(ownerDocument, row));
  }
}

function shortcutItem(ownerDocument, row) {
  const item = ownerDocument.createElement('div');
  item.className = 'shortcut-item';
  const desc = ownerDocument.createElement('span');
  desc.className = 'shortcut-desc';
  desc.textContent = row.label;
  if (row.title !== undefined) desc.title = row.title;
  const keys = ownerDocument.createElement('span');
  keys.className = 'shortcut-keys';
  // Combos of several keys are told apart ("Shift+Ctrl+Z / Ctrl+Y");
  // single keys sit side by side ("W A S D").
  const spaced = row.combos.length > 1 && row.combos.some(combo => combo.keys.length > 1 || combo.gesture !== undefined);
  row.combos.forEach((combo, comboIndex) => {
    if (spaced && comboIndex > 0) keys.append(' / ');
    combo.keys.forEach((key, index) => {
      if (index > 0) keys.append('+');
      const kbd = ownerDocument.createElement('kbd');
      kbd.textContent = key;
      keys.append(kbd);
    });
    if (combo.gesture !== undefined) keys.append(`+${combo.gesture}`);
  });
  item.append(desc, keys);
  return item;
}
