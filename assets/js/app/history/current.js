/**
 * @fileoverview The page's open history and this browser's saved histories,
 * published once for everything that shows or reads them: the State panel,
 * the agent's history reads, the keyboard's undo and redo.
 *
 * The dataset lifecycle publishes the history it creates for the dataset
 * shown (`setCurrentHistory(history)`) and withdraws it when the dataset
 * goes (`setCurrentHistory(null)`); the autosave publishes the store of
 * saved histories (`setSavedHistories(store)`). Readers subscribe and read
 * the current values; none of them keeps a history of its own.
 *
 * @module app/history/current
 */

/**
 * The saved histories of this browser (autosaved and named), as the State
 * panel's Saved states dialog uses them.
 *
 * @typedef {object} SavedHistoryEntry
 * @property {string} id
 * @property {string|null} name - Null for an autosave
 * @property {'autosave'|'named'} kind
 * @property {{id: string, name: string|null}} dataset
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} steps
 * @property {number} bytes
 * @property {boolean} [current] - The history of the dataset shown now
 *
 * @typedef {object} SavedHistories
 * @property {() => Promise<SavedHistoryEntry[]>} list
 * @property {(id: string) => Promise<void>} open - Reopen it (its dataset first when another one is shown)
 * @property {(id: string, options?: {signal?: AbortSignal|null, onStep?: Function|null}) => Promise<{tracker: string, report: object[]}>} replay -
 *   Apply its steps again, by name, on the dataset shown, in a new tracker linked to it (`dataset-history.js` `replay`)
 * @property {(id: string, name: string) => Promise<void>} rename
 * @property {(id: string) => Promise<void>} remove
 * @property {(name: string) => Promise<void>} saveAs - Keep the history shown under this name
 * @property {(listener: () => void) => () => void} [subscribe] - Told when the list changes
 */

let history = null;
/** @type {SavedHistories|null} */
let saved = null;
const listeners = new Set();

function notify() {
  for (const listener of [...listeners]) {
    try { listener(); } catch (error) { console.error('[history] current-history listener failed', error); }
  }
}

function requireSavedHistories(store) {
  if (store === null) return null;
  for (const name of ['list', 'open', 'replay', 'rename', 'remove', 'saveAs']) {
    if (typeof store?.[name] !== 'function') throw new TypeError(`Saved histories need ${name}()`);
  }
  return store;
}

/** @param {object|null} next - The history of the dataset shown (`createHistory`), or null */
export function setCurrentHistory(next) {
  if (next !== null && (typeof next?.subscribe !== 'function' || typeof next?.undo !== 'function')) {
    throw new TypeError('The current history must be a history (createHistory)');
  }
  if (next === history) return;
  history = next;
  notify();
}

/** The history of the dataset shown, or null. */
export function getCurrentHistory() {
  return history;
}

/** @param {SavedHistories|null} store */
export function setSavedHistories(store) {
  const exact = requireSavedHistories(store);
  if (exact === saved) return;
  saved = exact;
  notify();
}

/** This browser's saved histories, or null while none are kept. */
export function getSavedHistories() {
  return saved;
}

/**
 * Be told when the current history or the saved-history store is replaced.
 * @param {() => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeCurrentHistory(listener) {
  if (typeof listener !== 'function') throw new TypeError('A current-history listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}
