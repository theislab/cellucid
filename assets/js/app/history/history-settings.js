/**
 * @fileoverview The history's preferences in this browser (History settings):
 * what is recorded, what is kept, and how the person is
 * named. Every switch is on by default; the name is unset.
 *
 * - `recordCamera`, `recordLayout`: the two detail switches. Off, changes of
 *   that domain (`camera`: each view's camera and the navigation mode;
 *   `layout`: panels, windows, the sidebar and the theme) make no step and
 *   the history never moves it; steps still hold its value
 *   (`offDomainsOf`, the history's `offDomains`). Nothing else can be
 *   switched off: everything else is the analysis.
 * - `recordNewDatasets`: a newly opened dataset's first tracker records
 *   (off: it starts paused, `recordNewTrackers`).
 * - `askWhilePaused`: going back while paused asks to keep what changed as
 *   one step first (Keep, Discard, Cancel).
 * - `personName`: the person's name in the histories they share (`By.person`);
 *   unset (null) by default, so nobody is named.
 * - `autosave`: every step is kept in this browser a moment after it is
 *   made (`autosave.js`), so a crash or a closed tab loses at most the
 *   change of its last moment, and reopening the dataset offers to continue. Off, nothing is written; named saves
 *   still are.
 * - `reportPictures`: the printable report draws a picture of the view after
 *   each step chosen for one (each step shown in turn, drawn by the figure
 *   export: `view.picture`). Off, the report is the steps and their
 *   parameters only.
 *
 * There is no snapshot setting: the history keeps every value of every step
 * by content (`value-pool.js`), so any step is shown by putting its values
 * back, never by replaying actions, and there is no cadence to choose.
 *
 * These say what this browser keeps, not what the person did, so they are a
 * per-browser preference in localStorage, never part of a session or a
 * step; a browser without localStorage keeps every default.
 *
 * @module app/history/history-settings
 */

import { webStorage } from '../../utils/web-storage.js';
import { createListenerSet } from '../../utils/listener-set.js';

const STORAGE_KEY = 'cellucid:history-settings';

/** Every setting, its label and its default. */
export const HISTORY_SETTINGS = Object.freeze({
  recordCamera: Object.freeze({ label: 'Camera moves', kind: 'boolean', default: true }),
  recordLayout: Object.freeze({ label: 'Panels, windows and theme', kind: 'boolean', default: true }),
  recordNewDatasets: Object.freeze({ label: 'Record history for new datasets', kind: 'boolean', default: true }),
  askWhilePaused: Object.freeze({ label: 'Ask before going back while paused', kind: 'boolean', default: true }),
  personName: Object.freeze({ label: 'Your name in shared histories', kind: 'name', default: null }),
  autosave: Object.freeze({ label: 'Autosave in this browser', kind: 'boolean', default: true }),
  reportPictures: Object.freeze({ label: 'Pictures of the steps chosen', kind: 'boolean', default: true }),
});

/** The domain each detail switch covers. */
const DETAIL_DOMAINS = Object.freeze({ recordCamera: 'camera', recordLayout: 'layout' });

/** A stored value of a setting, or its default when it is not one. */
function valueOf(setting, stored) {
  if (setting.kind === 'boolean') return typeof stored === 'boolean' ? stored : setting.default;
  if (typeof stored !== 'string') return setting.default;
  const name = stored.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return name.length === 0 ? null : name;
}

/**
 * The domains the detail switches leave out of the history (the history's
 * `offDomains`): `camera` and `layout` when switched off.
 *
 * @param {{recordCamera: boolean, recordLayout: boolean}} settings
 * @returns {string[]}
 */
export function offDomainsOf(settings) {
  return Object.entries(DETAIL_DOMAINS).filter(([key]) => settings[key] === false).map(([, domain]) => domain);
}

const listeners = createListenerSet('the history settings');

/**
 * The settings set on this page that this browser did not keep (it keeps
 * nothing for this site, or refused the write): they hold for this page.
 */
const unkept = {};

function read(storage) {
  let stored = {};
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) ?? 'null');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = {};
  }
  return { ...stored, ...unkept };
}

/**
 * The settings as this browser keeps them: every switch a boolean, the name
 * text or null.
 *
 * @param {Storage|null|undefined} [storage]
 * @returns {{recordCamera: boolean, recordLayout: boolean, recordNewDatasets: boolean, askWhilePaused: boolean,
 *   personName: string|null, autosave: boolean, reportPictures: boolean}}
 */
export function historySettings(storage = webStorage('localStorage')) {
  const stored = read(storage);
  return Object.freeze(Object.fromEntries(Object.entries(HISTORY_SETTINGS).map(([key, setting]) => [
    key, valueOf(setting, stored[key]),
  ])));
}

/**
 * Set one setting in this browser: a switch on or off, the name to text
 * (empty or null: unset).
 *
 * @param {keyof typeof HISTORY_SETTINGS} key
 * @param {boolean|string|null} value
 * @param {Storage|null|undefined} [storage]
 */
export function setHistorySetting(key, value, storage = webStorage('localStorage')) {
  if (!Object.hasOwn(HISTORY_SETTINGS, key)) throw new RangeError(`There is no history setting "${key}"`);
  const setting = HISTORY_SETTINGS[key];
  if (setting.kind === 'boolean' && typeof value !== 'boolean') throw new TypeError(`The history setting "${key}" is on or off`);
  if (setting.kind === 'name' && value !== null && typeof value !== 'string') throw new TypeError(`The history setting "${key}" is a name or nothing`);
  value = valueOf(setting, value);
  const next = { ...read(storage), [key]: value };
  delete unkept[key];
  try {
    if (storage === null || storage === undefined) throw new Error('This browser keeps nothing for this site.');
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A browser that keeps no localStorage keeps the setting for this page only.
    unkept[key] = value;
  }
  const settings = { ...historySettings(storage), [key]: value };
  listeners.notify(settings);
}

/**
 * Hear every change of a setting in this page. Returns what stops it.
 *
 * @param {(settings: ReturnType<typeof historySettings>) => void} listener
 * @returns {() => void}
 */
export function onHistorySettingsChange(listener) {
  return listeners.add(listener);
}
