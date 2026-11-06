/**
 * @fileoverview The control inventory: every stable control of the sidebar
 * and the floating panels, its value, how it is put back, and which state
 * domain holds it (`controlDomainOf`). The `settings` and `layout` domains
 * take their part of it; `setting.set` and `settings.list` read and set it.
 * A record is validated completely before any control is changed
 * (`README.md` in this folder).
 *
 * @module state-serializer/ui-controls
 */

import { isStableId } from '../utils/stable-id.js';
import { isGeneratedDomId } from '../ui/components/dom-id.js';
import { requireExactKeys, requirePlainRecord } from '../../utils/exact-record.js';
import { throwIfAborted } from '../../utils/abort.js';

const SERIALIZABLE_INPUT_TYPES = new Set([
  'checkbox',
  'range',
  'number',
  'color',
  'text',
  'search',
]);

/**
 * A control whose choices follow the embedding the active view shows (the
 * vector-field controls: a field is bound to one embedding, so the select
 * lists different fields, or none, per view layout). Its record is checked
 * for shape with every other control up front, but its value is checked and
 * applied only once the restore has put the embeddings and the active view
 * back: checked earlier, a session saved on one embedding was refused on a
 * page showing another ("option is not available"), and applied earlier its
 * value was overwritten when the embedding changed under it.
 */
const AFTER_EMBEDDING_SELECTOR = '[data-state-serializer-after-embedding]';

// Not in the inventory: another domain's owner reads their state from the
// state it shows, or they are not a preference (README.md lists each with why).
const DOMAIN_OWNED_IDS = new Set([
  'navigation-mode',
  'categorical-field',
  'continuous-field',
  'outlier-filter',
  'gene-expression-search',
  'view-representation-select',
  // The views domain holds the layout; `view.layout.set` changes it.
  'view-layout-mode',
  'dataset-select',
  'pointer-lock',
  'data-address',
]);

function getUiRoots(sidebar) {
  if (!sidebar || typeof sidebar.querySelectorAll !== 'function') {
    throw new TypeError('Session UI serialization requires the current sidebar root.');
  }
  const roots = [sidebar];
  const floatingRoot = document.getElementById('floating-panels-root');
  if (floatingRoot !== null) {
    if (typeof floatingRoot.querySelectorAll !== 'function') {
      throw new TypeError('The floating-panels root must support DOM queries.');
    }
    roots.push(floatingRoot);
  }
  return roots;
}

function queryAll(sidebar, selector) {
  const out = [];
  for (const root of getUiRoots(sidebar)) {
    out.push(...root.querySelectorAll(selector));
  }
  return out;
}

/**
 * Whether a control stays out of the session's control inventory: anything
 * inside a `data-state-serializer-skip` subtree, and any control whose id was
 * minted on this page (`createDomId`). A minted id names nothing on another
 * page, so a session that recorded one could not be loaded there; what such
 * a control shows (a legend's range sliders, for one) is saved by the state
 * that renders it.
 */
function isStateSerializerSkipped(element) {
  if (typeof element.closest !== 'function') {
    throw new TypeError('Every serialized UI element must support ancestor lookup.');
  }
  return (
    element.closest('[data-state-serializer-skip]') !== null
    || isGeneratedDomId(element.id)
  );
}

/**
 * A floating analysis window (`analysis/ui/analysis-window-manager.js`): an
 * accordion section the `analysis` domain holds, window and place, not the
 * layout.
 *
 * @param {Element} details
 */
export function isAnalysisWindowSection(details) {
  return details.classList?.contains('analysis-window-panel') === true
    || Object.hasOwn(details.dataset ?? {}, 'analysisWindowId');
}

function assertStableId(id, context) {
  if (!isStableId(id)) {
    throw new TypeError(`${context} must have a stable nonempty DOM id.`);
  }
  return id;
}

function registerInventoryEntry(inventory, key, entry) {
  if (inventory.has(key)) {
    throw new TypeError(`Session UI control id "${key}" is not unique.`);
  }
  inventory.set(key, {
    ...entry,
    afterEmbedding: entry.element.closest(AFTER_EMBEDDING_SELECTOR) !== null,
  });
}

/** The ids of the controls restored after the embeddings, in inventory order. */
function afterEmbeddingControlIds(inventory) {
  const ids = [];
  for (const [id, entry] of inventory) {
    if (entry.afterEmbedding) ids.push(id);
  }
  return ids;
}

/**
 * Page chrome kept in sessions and saved states but outside the history
 * (CEL-0249, History v2 §3.3.8): a toolbelt, several buttons of which
 * exactly one is pressed at a time, marked with this attribute. Its value
 * is the id of its `aria-pressed="true"` button. The selection tool
 * (`#highlight-mode`: Annotation, KNN drag, Proximity drag, Lasso) is one: it
 * decides what the next drag on the canvas does, so a session reopened in
 * another tool would do something the person did not ask for. It is never a
 * history step and never moved by undo or a jump; a save and the autosave
 * keep it (`capturePageChrome`), a load and Continue put it back after the
 * head is shown (`applyPageChrome`).
 *
 * An explicit marker rather than every `role="group"` of pressed buttons:
 * the field-action toolbars are such groups of momentary actions with no
 * value. A second toolbelt marked the same way is carried with no edit here.
 */
const PRESSED_GROUP_SELECTOR = '[data-state-serializer-pressed-group]';

/** The identified buttons of one pressed group, in document order. */
function pressedGroupButtons(group, id) {
  if (typeof group.querySelectorAll !== 'function') throw new TypeError(`Page chrome group "${id}" must support DOM queries.`);
  const buttons = [...group.querySelectorAll('button[id]')];
  if (buttons.length === 0) throw new TypeError(`Page chrome group "${id}" has no identified buttons.`);
  const seen = new Set();
  for (const button of buttons) {
    const buttonId = assertStableId(button.id, `Every button of page chrome group "${id}"`);
    if (seen.has(buttonId)) throw new TypeError(`Page chrome group "${id}" button id "${buttonId}" is not unique.`);
    seen.add(buttonId);
    if (typeof button.getAttribute !== 'function') throw new TypeError(`Page chrome group "${id}" button "${buttonId}" must expose its attributes.`);
  }
  return buttons;
}

/**
 * The id of the one pressed button of a group. A group with none pressed,
 * or several, is refused rather than guessed at: it is the mode every later
 * gesture is read in.
 */
function pressedButtonId(buttons, id) {
  let pressedId = null;
  for (const button of buttons) {
    const pressed = button.getAttribute('aria-pressed');
    if (pressed !== null && pressed !== 'true' && pressed !== 'false') {
      throw new TypeError(`Page chrome group "${id}" button "${button.id}" aria-pressed must be "true", "false", or absent.`);
    }
    if (pressed !== 'true') continue;
    if (pressedId !== null) throw new TypeError(`Page chrome group "${id}" has more than one pressed button.`);
    pressedId = button.id;
  }
  if (pressedId === null) throw new TypeError(`Page chrome group "${id}" requires exactly one pressed button.`);
  return pressedId;
}

/** The page's pressed groups not skipped, by id. */
function pressedGroups(root) {
  const groups = new Map();
  if (!root || typeof root.querySelectorAll !== 'function') throw new TypeError('Page chrome is read from the page (a root that supports DOM queries).');
  for (const group of root.querySelectorAll(PRESSED_GROUP_SELECTOR)) {
    if (isStateSerializerSkipped(group)) continue;
    const id = assertStableId(group.id, 'Every page chrome group');
    if (groups.has(id)) throw new TypeError(`Page chrome group id "${id}" is not unique.`);
    groups.set(id, group);
  }
  return groups;
}

/**
 * The page chrome kept outside the history: `{pressed: {[groupId]: buttonId}}`
 * (the `data-state-serializer-pressed-group` id, the id of its pressed button).
 * @param {ParentNode} [root] - the page (the document by default)
 */
export function capturePageChrome(root = globalThis.document) {
  const pressed = {};
  for (const [id, group] of pressedGroups(root)) pressed[id] = pressedButtonId(pressedGroupButtons(group, id), id);
  return { pressed };
}

/**
 * What putting page chrome back (`capturePageChrome`'s record) will do on
 * this page, checked whole first: a malformed record is refused before
 * anything changes. A group this page lacks, or a button its group lacks (a
 * file of another Cellucid), is left out and said in `notes`; `apply()`
 * then sets each group by the `click` its owner listens for, as a person's
 * click, and makes no history step (it is no action and no domain holds it).
 * A load takes the plan before the history is replaced and applies it once
 * its head is shown.
 * @param {{pressed: Record<string, string>}} chrome
 * @param {ParentNode} [root]
 * @returns {{notes: string[], apply: () => void}}
 */
export function planPageChrome(chrome, root = globalThis.document) {
  requirePlainRecord(chrome, 'Page chrome');
  requireExactKeys(chrome, ['pressed'], 'Page chrome');
  requirePlainRecord(chrome.pressed, 'Page chrome pressed');
  const groups = pressedGroups(root);
  const plan = [];
  const notes = [];
  for (const [id, buttonId] of Object.entries(chrome.pressed)) {
    assertStableId(id, 'Page chrome group');
    assertStableId(buttonId, `Page chrome group "${id}" pressed button`);
    const group = groups.get(id);
    if (group === undefined) {
      notes.push(`This page has no "${id}" buttons, so the one the session pressed there is left out.`);
      continue;
    }
    const buttons = pressedGroupButtons(group, id);
    pressedButtonId(buttons, id);
    const target = buttons.find(button => button.id === buttonId);
    if (target === undefined) {
      notes.push(`This page has no "${buttonId}" button in "${id}", so that choice of the session is left out.`);
      continue;
    }
    plan.push({ id, group, target });
  }
  return {
    notes,
    apply() {
      for (const { id, group, target } of plan) {
        if (pressedButtonId(pressedGroupButtons(group, id), id) === target.id) continue;
        // The owner's own click listener tells the viewer which tool is live; writing aria-pressed would not.
        dispatchControlEvent(id, target, 'click');
        if (pressedButtonId(pressedGroupButtons(group, id), id) !== target.id) throw new Error(`Page chrome group "${id}" rejected button "${target.id}".`);
      }
    },
  };
}

/**
 * Put page chrome back at once (`planPageChrome`, then its `apply`).
 * @param {{pressed: Record<string, string>}} chrome
 * @param {ParentNode} [root]
 * @returns {string[]} what was left out, said
 */
export function applyPageChrome(chrome, root = globalThis.document) {
  const plan = planPageChrome(chrome, root);
  plan.apply();
  return plan.notes;
}

/**
 * Controls that describe the machine, not the session: neither saved nor
 * restored.
 *
 * `#hp-antialias` is a device capability its owner keeps in `localStorage` and
 * persists on every `change` event — including one a restore dispatches. A
 * session that carried it was the last writer of a device preference: a
 * sample's published view turned antialiasing back on after you turned it off.
 * The stored preference also has a third state, `auto`, that a checkbox cannot
 * express.
 *
 * The app theme (`#theme-select`) is part of how a shared session looks and is
 * restored like any other control: its `change` reaches the ThemeManager, which
 * shows and stores it exactly as a choice made by hand.
 */
const DEVICE_PREFERENCE_CONTROL_IDS = new Set(['hp-antialias']);

function isSessionControlId(elementId) {
  return !DOMAIN_OWNED_IDS.has(elementId) && !DEVICE_PREFERENCE_CONTROL_IDS.has(elementId);
}

/**
 * The state domain (`app/actions/domains.js`) whose value holds each control
 * of the inventory: the one map that splits the inventory between domains.
 * Every control is a setting unless listed here: the open sections and the
 * theme are the layout's; the centroid toggles show the focused view's own
 * flags, which the views' value holds view by view. Each control's value is
 * captured and restored by exactly one domain, so a settings value never
 * changes when a panel opens or another view is focused. A control added to
 * the markup is a setting with no edit here.
 *
 * Controls whose state their feature owner saves (`DOMAIN_OWNED_IDS`: the
 * multiview layout, the navigation mode, the field pickers, …) are not in the
 * inventory at all.
 */
const CONTROL_DOMAINS = new Map([
  ['theme-select', 'layout'],
  ['toggle-centroid-points', 'views'],
  ['toggle-centroid-labels', 'views'],
]);

/** The domains `controlDomainOf` names. */
export const CONTROL_DOMAIN_IDS = Object.freeze(['settings', 'layout', 'views']);

/**
 * @param {string} key An inventory key (a control id, or `accordion:<id>`)
 * @param {string} type The inventory type
 * @returns {'settings'|'layout'|'views'}
 */
export function controlDomainOf(key, type) {
  if (type === 'details') return 'layout';
  return CONTROL_DOMAINS.get(key) ?? 'settings';
}

/**
 * The controls `setting.set` sets and `settings.list` lists: every control
 * of the inventory but the layout's, which the layout actions change.
 */
export const SETTING_CONTROL_DOMAINS = Object.freeze(['settings', 'views']);

function buildCurrentInventory(sidebar, domains = null) {
  const inventory = new Map();

  for (const input of queryAll(sidebar, 'input[id]')) {
    if (isStateSerializerSkipped(input)) continue;
    if (!SERIALIZABLE_INPUT_TYPES.has(input.type)) continue;
    const elementId = assertStableId(input.id, 'Every serialized input');
    if (!isSessionControlId(elementId)) continue;
    registerInventoryEntry(inventory, elementId, {
      element: input,
      type: input.type === 'search' ? 'text' : input.type,
    });
  }

  for (const select of queryAll(sidebar, 'select[id]')) {
    if (isStateSerializerSkipped(select)) continue;
    const elementId = assertStableId(select.id, 'Every serialized select');
    if (!isSessionControlId(elementId)) continue;
    registerInventoryEntry(inventory, elementId, {
      element: select,
      type: 'select',
    });
  }

  // Every sidebar section's open state is the layout's: a section marked
  // `data-state-serializer-skip` keeps its controls out, not itself. An
  // analysis window is the `analysis` domain's.
  for (const details of queryAll(sidebar, 'details.accordion-section')) {
    if (isAnalysisWindowSection(details)) continue;
    const marked = details.closest('[data-state-serializer-skip]');
    const markedAround = marked === details ? details.parentElement?.closest?.('[data-state-serializer-skip]') ?? null : marked;
    if (markedAround !== null || isGeneratedDomId(details.id)) continue;
    const elementId = assertStableId(
      details.id,
      'Every serialized accordion',
    );
    registerInventoryEntry(inventory, `accordion:${elementId}`, {
      element: details,
      type: 'details',
    });
  }

  if (domains !== null) {
    for (const [id, entry] of inventory) if (!domains.includes(controlDomainOf(id, entry.type))) inventory.delete(id);
  }
  return inventory;
}

/**
 * Whether a slider's session value is a preference its owner keeps
 * (`data-session-preference`): one whose range follows data that may not be
 * read when a session is restored (the edge-count slider's, a graph's
 * visible edges). The session records the preference; restoring it hands it
 * to the owner (`session-preference`), which shows what the data allows of
 * it, so a range not known yet never refuses the session.
 */
function holdsPreference(element) {
  return typeof element?.dataset?.sessionPreference === 'string';
}

function assertFiniteNumericControlValue(element, value, id) {
  if (value.length === 0 || !Number.isFinite(Number(value))) {
    throw new TypeError(`Session UI control "${id}" value must be a finite numeric string.`);
  }
  const numericValue = Number(value);
  if (typeof element.min === 'string' && element.min.length > 0) {
    const minimum = Number(element.min);
    if (!Number.isFinite(minimum) || numericValue < minimum) {
      throw new RangeError(`Session UI control "${id}" value is below its current minimum.`);
    }
  }
  if (typeof element.max === 'string' && element.max.length > 0) {
    const maximum = Number(element.max);
    if (!Number.isFinite(maximum) || numericValue > maximum) {
      throw new RangeError(`Session UI control "${id}" value is above its current maximum.`);
    }
  }
}

/**
 * Check one control's record against the current interface. With
 * `valueAgainstCurrent` false only the record's shape is checked: a select's
 * option, a slider's range, are compared to the control later, once the
 * state its choices follow has been restored.
 */
function validateControlRecord(id, record, inventoryEntry, valueAgainstCurrent = true) {
  requirePlainRecord(record, `Session UI control "${id}"`);
  const { element, type } = inventoryEntry;

  if (record.type !== type) {
    throw new TypeError(
      `Session UI control "${id}" must declare current type "${type}".`,
    );
  }

  if (type === 'checkbox') {
    requireExactKeys(record, ['type', 'checked'], `Session UI control "${id}"`);
    if (typeof record.checked !== 'boolean') {
      throw new TypeError(`Session UI control "${id}" checked must be boolean.`);
    }
    return;
  }

  if (type === 'details') {
    requireExactKeys(record, ['type', 'open'], `Session UI control "${id}"`);
    if (typeof record.open !== 'boolean') {
      throw new TypeError(`Session UI control "${id}" open must be boolean.`);
    }
    return;
  }

  requireExactKeys(record, ['type', 'value'], `Session UI control "${id}"`);
  if (typeof record.value !== 'string') {
    throw new TypeError(`Session UI control "${id}" value must be a string.`);
  }

  if ((type === 'range' || type === 'number') && holdsPreference(element)) {
    // A preference, whatever the data's range is now (`holdsPreference`), so
    // its record is checked here in full, before any current value: a count
    // a person can choose, at least one (the slider's smallest stop is one
    // edge or more wherever there is an edge to show).
    if (!/^[1-9][0-9]*$/.test(record.value) || !Number.isSafeInteger(Number(record.value))) {
      throw new TypeError(`Session UI control "${id}" preference must be a positive whole number.`);
    }
    return;
  }

  if (!valueAgainstCurrent) return;
  if (type === 'select') {
    const options = Array.from(element.options);
    const optionExists = options.some(
      option => option.value === record.value,
    );
    const exactUnavailableState = options.length === 0 && record.value === '';
    if (!optionExists && !exactUnavailableState) {
      throw new RangeError(
        `Session UI select option "${record.value}" is not available in current control "${id}".`,
      );
    }
  } else if (type === 'range' || type === 'number') {
    assertFiniteNumericControlValue(element, record.value, id);
  } else if (type === 'color' && !/^#[0-9a-f]{6}$/.test(record.value)) {
    throw new TypeError(
      `Session UI control "${id}" color must be an exact lowercase six-digit hex value.`,
    );
  }
}

function validateCompleteControls(controls, inventory, laterValueIds = new Set()) {
  requirePlainRecord(controls, 'Session UI controls');
  const candidateKeys = Object.keys(controls).sort();
  const currentKeys = [...inventory.keys()].sort();

  for (const key of candidateKeys) {
    if (!inventory.has(key)) {
      throw new TypeError(
        `Session UI control "${key}" does not exist in the current interface.`,
      );
    }
  }
  for (const key of currentKeys) {
    if (!Object.hasOwn(controls, key)) {
      throw new TypeError(`Session UI state is missing current control "${key}".`);
    }
  }
  if (candidateKeys.length !== currentKeys.length) {
    throw new TypeError('Session UI state must match the complete current control inventory.');
  }

  for (const key of currentKeys) {
    validateControlRecord(key, controls[key], inventory.get(key), !laterValueIds.has(key));
  }
}

/**
 * How many control events a restore or `setSetting` is dispatching now: a
 * change heard meanwhile is the app putting a value back, not a person's
 * (`ui/modules/settings-actions.js` records only a person's).
 */
let applyingDepth = 0;

/** Whether the change event being heard was dispatched by a restore or `setSetting`. */
export function isApplyingControls() {
  return applyingDepth > 0;
}

function dispatchControlEvent(id, element, type) {
  applyingDepth++;
  try {
    dispatchControlEventNow(id, element, type);
  } finally {
    applyingDepth--;
  }
}

function dispatchControlEventNow(id, element, type) {
  const ownerWindow = element?.ownerDocument?.defaultView ?? null;
  if (
    ownerWindow === null
    || typeof ownerWindow.addEventListener !== 'function'
    || typeof ownerWindow.removeEventListener !== 'function'
  ) {
    element.dispatchEvent(new Event(type, { bubbles: true }));
    return;
  }

  let listenerFailure = null;
  const captureListenerFailure = (event) => {
    if (listenerFailure === null) {
      listenerFailure = event.error instanceof Error
        ? event.error
        : new Error(
          typeof event.message === 'string' && event.message.length > 0
            ? event.message
            : `Session UI control "${id}" listener failed.`,
        );
    }
    if (event.cancelable) event.preventDefault();
  };
  ownerWindow.addEventListener('error', captureListenerFailure, true);
  let dispatchFailure = null;
  try {
    const EventConstructor = typeof ownerWindow.Event === 'function'
      ? ownerWindow.Event
      : Event;
    element.dispatchEvent(new EventConstructor(type, { bubbles: true }));
  } catch (error) {
    dispatchFailure = error instanceof Error
      ? error
      : new Error(
        `Session UI control "${id}" dispatch failed with a non-Error value.`,
      );
  } finally {
    ownerWindow.removeEventListener('error', captureListenerFailure, true);
  }
  if (dispatchFailure !== null) throw dispatchFailure;
  if (listenerFailure !== null) throw listenerFailure;
}


function restoreValidatedControl(id, entry, data) {
  const { element, type } = entry;
  if (type === 'checkbox') {
    if (element.checked !== data.checked) {
      element.checked = data.checked;
      dispatchControlEvent(id, element, 'change');
      if (element.checked !== data.checked) {
        throw new Error(
          `Session UI control "${id}" rejected its restored checked state.`,
        );
      }
    }
    return;
  }
  if (type === 'details') {
    element.open = data.open;
    return;
  }
  if (holdsPreference(element)) {
    // The owner takes the preference and shows what the data allows of it.
    if (element.dataset.sessionPreference === data.value) return;
    element.dataset.sessionPreference = data.value;
    dispatchControlEvent(id, element, 'session-preference');
    if (element.dataset.sessionPreference !== data.value) {
      throw new Error(`Session UI control "${id}" rejected restored preference "${data.value}".`);
    }
    return;
  }
  if (element.value === data.value) return;
  element.value = data.value;
  dispatchControlEvent(
    id,
    element,
    type === 'select' ? 'change' : 'input',
  );
  if (element.value !== data.value) {
    throw new Error(
      `Session UI control "${id}" rejected restored value "${data.value}".`,
    );
  }
}

function assertRestoreOptions(options) {
  requirePlainRecord(options, 'Session UI restore options');
  const expectedKeys = [];
  if (Object.hasOwn(options, 'abortSignal')) expectedKeys.push('abortSignal');
  if (Object.hasOwn(options, 'deferControlIds')) {
    expectedKeys.push('deferControlIds');
  }
  if (Object.hasOwn(options, 'withholdControlIds')) {
    expectedKeys.push('withholdControlIds');
  }
  requireExactKeys(
    options,
    expectedKeys,
    'Session UI restore options',
  );
  if (
    Object.hasOwn(options, 'abortSignal')
    && options.abortSignal !== null
    && typeof options.abortSignal?.aborted !== 'boolean'
  ) {
    throw new TypeError('Session UI abortSignal must expose a boolean aborted state.');
  }
  for (const [key, label] of [
    ['deferControlIds', 'deferred'],
    ['withholdControlIds', 'withheld'],
  ]) {
    if (!Object.hasOwn(options, key)) continue;
    if (!Array.isArray(options[key])) {
      throw new TypeError(`Session UI ${key} must be an array.`);
    }
    const ids = new Set();
    for (const id of options[key]) {
      assertStableId(id, `Every ${label} session UI control id`);
      if (ids.has(id)) {
        throw new TypeError(
          `Session UI ${key} contains duplicate id "${id}".`,
        );
      }
      ids.add(id);
    }
  }
}

/** The order controls are restored in. */
const RESTORE_ORDER = Object.freeze([
  'details', 'checkbox', 'select', 'range', 'number', 'color', 'text',
]);

/**
 * The serializer over the stable-id control inventory.
 *
 * @param {{sidebar: HTMLElement, domains?: string[]|null}} options -
 *   `domains` keeps the controls whose value those state domains hold
 *   (`controlDomainOf`): the `settings` and `layout` domains each take their
 *   part of the one inventory (`app/state/domains/settings.js`, `layout.js`),
 *   and the settings actions every control `setting.set` sets
 *   (`SETTING_CONTROL_DOMAINS`). Null: the whole inventory.
 */
export function createUiControlSerializer({ sidebar, domains = null }) {
  if (domains !== null && (!Array.isArray(domains) || domains.length === 0
    || domains.some(domain => !CONTROL_DOMAIN_IDS.includes(domain)))) {
    throw new TypeError(`A UI control inventory is selected by state domains (${CONTROL_DOMAIN_IDS.join(', ')}).`);
  }
  getUiRoots(sidebar);

  function collectUIControls() {
    const controls = {};
    const inventory = buildCurrentInventory(sidebar, domains);
    for (const [id, { element, type }] of inventory) {
      if (type === 'checkbox') {
        controls[id] = { type, checked: element.checked };
      } else if (type === 'details') {
        controls[id] = { type, open: element.open };
      } else {
        controls[id] = { type, value: holdsPreference(element) ? element.dataset.sessionPreference : element.value };
      }
    }
    return controls;
  }

  function validateUIControls(controls) {
    const inventory = buildCurrentInventory(sidebar, domains);
    validateCompleteControls(
      controls,
      inventory,
      new Set(afterEmbeddingControlIds(inventory)),
    );
  }

  /** The ids of the controls whose choices follow the embedding, in order. */
  function embeddingDependentControlIds() {
    return afterEmbeddingControlIds(buildCurrentInventory(sidebar, domains));
  }

  /**
   * Apply every control now except the deferred ones, and return the function
   * that applies those: the caller's `deferControlIds`, and every control
   * whose choices follow the embedding, whose values are checked against the
   * interface only then. `withholdControlIds` are checked now and never
   * applied (a mode the device cannot run, reported instead).
   */
  function restoreUIControls(controls, options = {}) {
    assertRestoreOptions(options);
    const abortSignal = Object.hasOwn(options, 'abortSignal')
      ? options.abortSignal
      : null;
    const withheldIds = new Set(options.withholdControlIds ?? []);
    throwIfAborted(abortSignal);

    const inventory = buildCurrentInventory(sidebar, domains);
    const deferredIds = new Set([
      ...(options.deferControlIds ?? []),
      ...afterEmbeddingControlIds(inventory),
    ]);
    for (const id of deferredIds) {
      if (withheldIds.has(id)) {
        throw new TypeError(
          `Session UI control "${id}" cannot be both deferred and withheld.`,
        );
      }
    }
    const laterValueIds = new Set(
      [...deferredIds].filter(id => inventory.get(id)?.afterEmbedding === true),
    );
    validateCompleteControls(controls, inventory, laterValueIds);
    for (const id of [...deferredIds, ...withheldIds]) {
      if (!inventory.has(id)) {
        throw new RangeError(
          `Deferred session UI control "${id}" does not exist in the current interface.`,
        );
      }
    }
    const stagedControls = new Map();
    for (const [id, entry] of inventory) {
      stagedControls.set(id, {
        entry,
        data: { ...controls[id] },
      });
    }

    function restoreMatchingControls(restoreDeferred) {
      for (const type of RESTORE_ORDER) {
        for (const [id, staged] of stagedControls) {
          if (staged.entry.type !== type) continue;
          if (deferredIds.has(id) !== restoreDeferred) continue;
          // Validated, but not applied: see `withholdControlIds`.
          if (withheldIds.has(id)) continue;
          throwIfAborted(abortSignal);
          restoreValidatedControl(id, staged.entry, staged.data);
        }
      }
    }
    restoreMatchingControls(false);
    return () => {
      // The embedding-dependent values are checked against the controls as
      // they are now, after the embeddings and the active view came back,
      // before any of the deferred controls is touched.
      for (const id of laterValueIds) {
        validateControlRecord(id, controls[id], stagedControls.get(id).entry);
      }
      restoreMatchingControls(true);
    };
  }

  /**
   * The key of the control of this inventory a user event on `target`
   * changes, or null when the target is none of its controls.
   * @param {EventTarget|null} target
   * @returns {string|null}
   */
  function settingKeyOf(target) {
    if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return null;
    const element = target;
    if (typeof element.id !== 'string' || element.id.length === 0) return null;
    const entry = buildCurrentInventory(sidebar, domains).get(element.id);
    return entry !== undefined && entry.element === element ? element.id : null;
  }

  /** One control of this inventory described for a person or an agent (`describeSetting`). */
  function readSetting(key) {
    const entry = buildCurrentInventory(sidebar, domains).get(key);
    if (entry === undefined) return null;
    return describeSetting(key, entry);
  }

  /** Every control of this inventory described, in inventory order. */
  function listSettings() {
    return [...buildCurrentInventory(sidebar, domains)].map(([key, entry]) => describeSetting(key, entry));
  }

  /**
   * Set one setting to `value` (the typed value `describeSetting` reports:
   * a number for a slider, a boolean for a switch, an option value,
   * `#rrggbb`), through the restore path: the
   * control is set and its event dispatched, so its owner applies it as if
   * a person had changed it. Returns the setting as it is afterwards.
   * @param {string} key
   * @param {string|number|boolean} value
   */
  function setSetting(key, value) {
    const entry = buildCurrentInventory(sidebar, domains).get(key);
    if (entry === undefined) throw new RangeError(`There is no setting "${key}"`);
    const record = settingRecordOf(entry, value);
    validateControlRecord(key, record, entry);
    const before = describeSetting(key, entry).value;
    try {
      restoreValidatedControl(key, entry, record);
    } catch (error) {
      // Its owner put the old value back: what it needs is not there (a
      // graph not read, a field not shown), so it cannot be changed now.
      if (describeSetting(key, entry).value !== before) throw error;
      throw new RangeError(`"${labelOf(entry.element)}" cannot be changed now: it keeps its value until what it needs is there`);
    }
    return describeSetting(key, entry);
  }

  return {
    collectUIControls,
    embeddingDependentControlIds,
    listSettings,
    readSetting,
    restoreUIControls,
    setSetting,
    settingKeyOf,
    validateUIControls,
  };
}

/** Visible text of an element, whitespace collapsed. */
function textOf(element) {
  return typeof element?.textContent === 'string' ? element.textContent.replace(/\s+/g, ' ').trim() : '';
}

/**
 * A control's name as a person reads it: its `<label>`, else what its
 * `aria-labelledby` names, its `aria-label`, its title, else its id.
 */
function labelOf(element) {
  const labels = element.labels ? [...element.labels] : [];
  for (const label of labels) {
    const text = textOf(label);
    if (text.length > 0) return text;
  }
  const labelledBy = element.getAttribute?.('aria-labelledby');
  if (typeof labelledBy === 'string' && labelledBy.length > 0) {
    const text = labelledBy.split(/\s+/)
      .map(id => textOf(element.ownerDocument?.getElementById(id))).filter(Boolean).join(' ');
    if (text.length > 0) return text;
  }
  for (const attribute of ['aria-label', 'title']) {
    const text = element.getAttribute?.(attribute)?.trim();
    if (text) return text;
  }
  return element.id;
}

/** The sidebar section a control stands in, by its title. */
function sectionOf(element) {
  const details = element.closest?.('details.accordion-section') ?? null;
  const summary = details?.querySelector?.(':scope > summary') ?? null;
  const title = summary?.querySelector?.('.accordion-title') ?? summary;
  return title === null ? null : (textOf(title) || null);
}

/**
 * What a slider shows beside it (`aria-valuetext`, or the `.slider-value`
 * of its row): a log-scaled slider's position is not the value it means.
 */
function shownOf(element) {
  const valueText = element.getAttribute?.('aria-valuetext');
  if (typeof valueText === 'string' && valueText.length > 0) return valueText;
  const shown = element.closest?.('.slider-row')?.querySelector?.('.slider-value') ?? null;
  const text = textOf(shown);
  return text.length > 0 ? text : null;
}

function decimalsOf(step) {
  const text = String(step);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent !== null) return Number(exponent[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A setting as a person or an agent reads it: id, label, section, kind,
 * the value (typed), what it shows, its range or choices, and whether it
 * can be changed now.
 */
function describeSetting(key, { element, type }) {
  const out = { id: key, label: labelOf(element), section: sectionOf(element) };
  const disabled = element.disabled === true;
  if (type === 'checkbox') {
    Object.assign(out, { kind: 'switch', value: element.checked === true });
  } else if (type === 'select') {
    const options = Array.from(element.options);
    const chosen = options.find(option => option.value === element.value);
    Object.assign(out, {
      kind: 'choice',
      value: element.value,
      options: options.map(option => ({ value: option.value, label: textOf(option) || option.value })),
    });
    if (chosen !== undefined) out.shown = textOf(chosen) || chosen.value;
  } else if (type === 'range' || type === 'number') {
    const preference = holdsPreference(element);
    const raw = preference ? element.dataset.sessionPreference : element.value;
    Object.assign(out, { kind: preference ? 'count' : 'number', value: Number(raw) });
    if (!preference) {
      for (const bound of ['min', 'max']) {
        if (typeof element[bound] === 'string' && element[bound].length > 0) out[bound] = Number(element[bound]);
      }
      const step = element.step;
      if (typeof step === 'string' && step.length > 0 && step !== 'any') out.step = Number(step);
      const shown = shownOf(element);
      if (shown !== null) out.shown = shown;
    } else {
      out.min = 1;
    }
  } else if (type === 'color') {
    Object.assign(out, { kind: 'colour', value: element.value });
  } else {
    Object.assign(out, { kind: 'text', value: element.value });
  }
  out.available = !disabled;
  return out;
}

/**
 * The session record a typed setting value stands for, or a TypeError /
 * RangeError naming what is wrong with the value in words a person reads.
 */
function settingRecordOf({ element, type }, value) {
  const label = labelOf(element);
  if (element.disabled === true) {
    throw new RangeError(`"${label}" cannot be changed now: it is switched off by another setting`);
  }
  if (type === 'checkbox') {
    if (typeof value !== 'boolean') throw new TypeError(`"${label}" is a switch: give true or false`);
    return { type, checked: value };
  }
  if (type === 'select') {
    const options = Array.from(element.options);
    if (typeof value !== 'string' || !options.some(option => option.value === value)) {
      throw new RangeError(`"${label}" has no choice ${JSON.stringify(value)}; its choices are ${
        options.map(option => option.value).join(', ') || 'none now'}`);
    }
    return { type, value };
  }
  if (type === 'range' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`"${label}" takes a number`);
    if (holdsPreference(element)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`"${label}" takes a whole number of at least 1`);
      return { type, value: String(value) };
    }
    const min = element.min === '' ? null : Number(element.min);
    const max = element.max === '' ? null : Number(element.max);
    if ((min !== null && value < min) || (max !== null && value > max)) {
      throw new RangeError(`"${label}" goes from ${min ?? '−∞'} to ${max ?? '∞'}; ${value} is outside`);
    }
    const step = element.step === '' || element.step === 'any' ? null : Number(element.step);
    if (step !== null && Number.isFinite(step) && step > 0) {
      const base = min ?? 0;
      const steps = (value - base) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) {
        throw new RangeError(`"${label}" moves in steps of ${step} from ${base}; ${value} is between two steps`);
      }
      const decimals = decimalsOf(step);
      return { type, value: String(Number((base + Math.round(steps) * step).toFixed(decimals))) };
    }
    return { type, value: String(value) };
  }
  if (type === 'color') {
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      throw new TypeError(`"${label}" takes a colour as #rrggbb`);
    }
    return { type, value: value.toLowerCase() };
  }
  if (typeof value !== 'string') throw new TypeError(`"${label}" takes text`);
  return { type, value };
}
