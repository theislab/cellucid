/**
 * @fileoverview Exact UI-control save/restore helpers for session bundles.
 *
 * The current session format owns one closed inventory of stable DOM ids. A
 * candidate is validated completely before any control is changed.
 *
 * @module state-serializer/ui-controls
 */

const SERIALIZABLE_INPUT_TYPES = new Set([
  'checkbox',
  'range',
  'number',
  'color',
  'text',
  'search',
]);

/**
 * A toolbelt: several buttons of which exactly one is pressed at a time.
 *
 * A group marked with this attribute is one serialized control whose value is
 * the id of its `aria-pressed="true"` button. Marking it is what puts it in the
 * inventory — there is no list of group ids here, so a second toolbelt is
 * carried the day its markup lands.
 *
 * The alternative considered and rejected was to inventory every
 * `role="group"` holding pressed buttons. `index.html` already uses
 * `role="group"` for the field-action toolbars, whose buttons are momentary
 * actions with ids, so that rule would have swept in controls that have no
 * value to save. An explicit marker is also what makes a group visible to
 * `tests/session-preset-control-inventory-contract.test.mjs`, which reads the
 * static markup: a group recognized only by a runtime-set attribute would be
 * invisible there and would read as a preset carrying a key the markup lacks.
 */
const PRESSED_GROUP_SELECTOR = '[data-state-serializer-pressed-group]';

// These controls are serialized by their feature owners, never by the generic
// DOM-control contributor.
const DOMAIN_OWNED_IDS = new Set([
  'navigation-mode',
  'categorical-field',
  'continuous-field',
  'outlier-filter',
  'gene-expression-search',
  'dimension-select',
  'dataset-select',
  'pointer-lock',
  'remote-server-url',
  'github-repo-url',
]);

function assertPlainRecord(value, context) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${context} must be a plain object.`);
  }
}

function assertExactKeys(record, expectedKeys, context) {
  const actualKeys = Object.keys(record).sort();
  const exactKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== exactKeys.length
    || actualKeys.some((key, index) => key !== exactKeys[index])
  ) {
    throw new TypeError(
      `${context} must contain the exact keys ${exactKeys.join(', ')}.`,
    );
  }
}

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

function isStateSerializerSkipped(element) {
  if (typeof element.closest !== 'function') {
    throw new TypeError('Every serialized UI element must support ancestor lookup.');
  }
  return element.closest('[data-state-serializer-skip]') !== null;
}

function assertStableId(id, context) {
  if (typeof id !== 'string' || id.length === 0 || id !== id.trim()) {
    throw new TypeError(`${context} must have a stable nonempty DOM id.`);
  }
  return id;
}

function registerInventoryEntry(inventory, key, entry) {
  if (inventory.has(key)) {
    throw new TypeError(`Session UI control id "${key}" is not unique.`);
  }
  inventory.set(key, entry);
}

/**
 * The identified buttons of one pressed group, in document order.
 *
 * @param {object} group
 * @param {string} id
 * @returns {object[]}
 */
function pressedGroupButtons(group, id) {
  if (typeof group.querySelectorAll !== 'function') {
    throw new TypeError(
      `Session UI pressed group "${id}" must support DOM queries.`,
    );
  }
  const buttons = [...group.querySelectorAll('button[id]')];
  if (buttons.length === 0) {
    throw new TypeError(
      `Session UI pressed group "${id}" has no identified buttons.`,
    );
  }
  const seen = new Set();
  for (const button of buttons) {
    const buttonId = assertStableId(
      button.id,
      `Every button of session UI pressed group "${id}"`,
    );
    if (seen.has(buttonId)) {
      throw new TypeError(
        `Session UI pressed group "${id}" button id "${buttonId}" is not unique.`,
      );
    }
    seen.add(buttonId);
    if (typeof button.getAttribute !== 'function') {
      throw new TypeError(
        `Session UI pressed group "${id}" button "${buttonId}" must expose its `
          + 'attributes.',
      );
    }
  }
  return buttons;
}

/**
 * The id of the one pressed button of a group.
 *
 * A group with no pressed button, or with several, is refused rather than
 * resolved to a guess: the value it would restore is the mode every later
 * gesture is interpreted in.
 *
 * @param {object[]} buttons
 * @param {string} id
 * @returns {string}
 */
function pressedButtonId(buttons, id) {
  let pressedId = null;
  for (const button of buttons) {
    const pressed = button.getAttribute('aria-pressed');
    if (pressed !== null && pressed !== 'true' && pressed !== 'false') {
      throw new TypeError(
        `Session UI pressed group "${id}" button "${button.id}" aria-pressed `
          + 'must be "true", "false", or absent.',
      );
    }
    if (pressed !== 'true') continue;
    if (pressedId !== null) {
      throw new TypeError(
        `Session UI pressed group "${id}" has more than one pressed button.`,
      );
    }
    pressedId = button.id;
  }
  if (pressedId === null) {
    throw new TypeError(
      `Session UI pressed group "${id}" requires exactly one pressed button.`,
    );
  }
  return pressedId;
}

function buildCurrentInventory(sidebar) {
  const inventory = new Map();

  for (const input of queryAll(sidebar, 'input[id]')) {
    if (isStateSerializerSkipped(input)) continue;
    if (!SERIALIZABLE_INPUT_TYPES.has(input.type)) continue;
    const elementId = assertStableId(input.id, 'Every serialized input');
    if (DOMAIN_OWNED_IDS.has(elementId)) continue;
    registerInventoryEntry(inventory, elementId, {
      element: input,
      type: input.type === 'search' ? 'text' : input.type,
    });
  }

  for (const select of queryAll(sidebar, 'select[id]')) {
    if (isStateSerializerSkipped(select)) continue;
    const elementId = assertStableId(select.id, 'Every serialized select');
    if (DOMAIN_OWNED_IDS.has(elementId)) continue;
    registerInventoryEntry(inventory, elementId, {
      element: select,
      type: 'select',
    });
  }

  for (const details of queryAll(sidebar, 'details.accordion-section')) {
    if (isStateSerializerSkipped(details)) continue;
    const elementId = assertStableId(
      details.id,
      'Every serialized accordion',
    );
    registerInventoryEntry(inventory, `accordion:${elementId}`, {
      element: details,
      type: 'details',
    });
  }

  for (const group of queryAll(sidebar, PRESSED_GROUP_SELECTOR)) {
    if (isStateSerializerSkipped(group)) continue;
    const elementId = assertStableId(
      group.id,
      'Every serialized pressed group',
    );
    if (DOMAIN_OWNED_IDS.has(elementId)) continue;
    registerInventoryEntry(inventory, elementId, {
      element: group,
      type: 'pressed-group',
    });
  }

  return inventory;
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

function validateControlRecord(id, record, inventoryEntry) {
  assertPlainRecord(record, `Session UI control "${id}"`);
  const { element, type } = inventoryEntry;

  if (record.type !== type) {
    throw new TypeError(
      `Session UI control "${id}" must declare current type "${type}".`,
    );
  }

  if (type === 'checkbox') {
    assertExactKeys(record, ['type', 'checked'], `Session UI control "${id}"`);
    if (typeof record.checked !== 'boolean') {
      throw new TypeError(`Session UI control "${id}" checked must be boolean.`);
    }
    return;
  }

  if (type === 'details') {
    assertExactKeys(record, ['type', 'open'], `Session UI control "${id}"`);
    if (typeof record.open !== 'boolean') {
      throw new TypeError(`Session UI control "${id}" open must be boolean.`);
    }
    return;
  }

  if (type === 'pressed-group') {
    assertExactKeys(
      record,
      ['type', 'pressedId'],
      `Session UI control "${id}"`,
    );
    assertStableId(
      record.pressedId,
      `Session UI control "${id}" pressedId`,
    );
    const buttons = pressedGroupButtons(element, id);
    // Reading the current pressed button here is what makes a malformed group
    // fail during validation rather than half-way through the restore.
    pressedButtonId(buttons, id);
    if (!buttons.some(button => button.id === record.pressedId)) {
      throw new RangeError(
        `Session UI pressed group "${id}" button "${record.pressedId}" is not `
          + 'available in the current interface.',
      );
    }
    return;
  }

  assertExactKeys(record, ['type', 'value'], `Session UI control "${id}"`);
  if (typeof record.value !== 'string') {
    throw new TypeError(`Session UI control "${id}" value must be a string.`);
  }

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

function validateCompleteControls(controls, inventory) {
  assertPlainRecord(controls, 'Session UI controls');
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
    validateControlRecord(key, controls[key], inventory.get(key));
  }
}

function dispatchControlEvent(id, element, type) {
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

/**
 * Controls that describe the machine, not the session.
 *
 * `#hp-antialias` is stored in `localStorage` because the preference describes
 * the machine that is drawing rather than the view being described. Its owner
 * therefore persists on every `change` event - including the synthetic one a
 * restore dispatches.
 *
 * That made a session the last writer of a device preference. Every sample
 * publishes an advertised default state, so switching antialiasing off and
 * reloading re-applied the saved `on` and stored it, and the setting could
 * never stay off. A shared session did the same to whoever opened it.
 *
 * The stored preference also has a third state, `auto`, that a checkbox cannot
 * express: replaying a captured tick would turn "let the dataset decide" into a
 * choice the user never made.
 *
 * These are still captured, and still required to be present, so the published
 * presets stay valid and a control that disappears from the markup is still
 * caught. They are simply not applied: the machine that is drawing keeps its
 * own answer.
 */
const DEVICE_PREFERENCE_CONTROL_IDS = new Set(['hp-antialias']);

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
  if (type === 'pressed-group') {
    const buttons = pressedGroupButtons(element, id);
    if (pressedButtonId(buttons, id) === data.pressedId) return;
    const target = buttons.find(button => button.id === data.pressedId);
    if (target === undefined) {
      throw new RangeError(
        `Session UI pressed group "${id}" button "${data.pressedId}" is not `
          + 'available in the current interface.',
      );
    }
    // Same publication rule as every other control: the owner's own `click`
    // listener is what tells the viewer which tool is live. Writing
    // `aria-pressed` here instead would repaint the toolbelt and leave the next
    // gesture in the previous mode.
    dispatchControlEvent(id, target, 'click');
    if (pressedButtonId(pressedGroupButtons(element, id), id) !== data.pressedId) {
      throw new Error(
        `Session UI control "${id}" rejected restored button "${data.pressedId}".`,
      );
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
  assertPlainRecord(options, 'Session UI restore options');
  const expectedKeys = [];
  if (Object.hasOwn(options, 'abortSignal')) expectedKeys.push('abortSignal');
  if (Object.hasOwn(options, 'deferControlIds')) {
    expectedKeys.push('deferControlIds');
  }
  assertExactKeys(
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
  if (Object.hasOwn(options, 'deferControlIds')) {
    if (!Array.isArray(options.deferControlIds)) {
      throw new TypeError('Session UI deferControlIds must be an array.');
    }
    const ids = new Set();
    for (const id of options.deferControlIds) {
      assertStableId(id, 'Every deferred session UI control id');
      if (ids.has(id)) {
        throw new TypeError(
          `Session UI deferControlIds contains duplicate id "${id}".`,
        );
      }
      ids.add(id);
    }
  }
}

export function createUiControlSerializer({ sidebar }) {
  getUiRoots(sidebar);

  function collectUIControls() {
    const controls = {};
    const inventory = buildCurrentInventory(sidebar);
    for (const [id, { element, type }] of inventory) {
      if (type === 'checkbox') {
        controls[id] = { type, checked: element.checked };
      } else if (type === 'details') {
        controls[id] = { type, open: element.open };
      } else if (type === 'pressed-group') {
        controls[id] = {
          type,
          pressedId: pressedButtonId(pressedGroupButtons(element, id), id),
        };
      } else {
        controls[id] = { type, value: element.value };
      }
    }
    return controls;
  }

  function validateUIControls(controls) {
    const inventory = buildCurrentInventory(sidebar);
    validateCompleteControls(controls, inventory);
  }

  function restoreUIControls(controls, options = {}) {
    assertRestoreOptions(options);
    const abortSignal = Object.hasOwn(options, 'abortSignal')
      ? options.abortSignal
      : null;
    const deferredIds = new Set(options.deferControlIds ?? []);
    if (abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const inventory = buildCurrentInventory(sidebar);
    validateCompleteControls(controls, inventory);
    for (const id of deferredIds) {
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

    // Pressed groups run last: switching the highlight toolbelt reads the
    // viewer's unified selection state and republishes the tool flags, so it
    // belongs after every value control has settled.
    const restoreOrder = [
      'details',
      'checkbox',
      'select',
      'range',
      'number',
      'color',
      'text',
      'pressed-group',
    ];
    function restoreMatchingControls(restoreDeferred) {
      for (const type of restoreOrder) {
        for (const [id, staged] of stagedControls) {
          if (staged.entry.type !== type) continue;
          if (deferredIds.has(id) !== restoreDeferred) continue;
          // Captured and validated, but never applied - see
          // DEVICE_PREFERENCE_CONTROL_IDS.
          if (DEVICE_PREFERENCE_CONTROL_IDS.has(id)) continue;
          if (abortSignal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          restoreValidatedControl(id, staged.entry, staged.data);
        }
      }
    }
    restoreMatchingControls(false);
    return () => restoreMatchingControls(true);
  }

  return {
    collectUIControls,
    restoreUIControls,
    validateUIControls,
  };
}
