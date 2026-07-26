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

function dispatchControlEvent(element, type) {
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

function restoreValidatedControl(entry, data) {
  const { element, type } = entry;
  if (type === 'checkbox') {
    if (element.checked !== data.checked) {
      element.checked = data.checked;
      dispatchControlEvent(element, 'change');
    }
    return;
  }
  if (type === 'details') {
    element.open = data.open;
    return;
  }
  if (element.value === data.value) return;
  element.value = data.value;
  dispatchControlEvent(element, type === 'select' ? 'change' : 'input');
}

function assertRestoreOptions(options) {
  assertPlainRecord(options, 'Session UI restore options');
  assertExactKeys(
    options,
    Object.hasOwn(options, 'abortSignal') ? ['abortSignal'] : [],
    'Session UI restore options',
  );
  if (
    Object.hasOwn(options, 'abortSignal')
    && options.abortSignal !== null
    && typeof options.abortSignal?.aborted !== 'boolean'
  ) {
    throw new TypeError('Session UI abortSignal must expose a boolean aborted state.');
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
      } else {
        controls[id] = { type, value: element.value };
      }
    }
    return controls;
  }

  function restoreUIControls(controls, options = {}) {
    assertRestoreOptions(options);
    const abortSignal = Object.hasOwn(options, 'abortSignal')
      ? options.abortSignal
      : null;
    if (abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const inventory = buildCurrentInventory(sidebar);
    validateCompleteControls(controls, inventory);

    const restoreOrder = ['details', 'checkbox', 'select', 'range', 'number', 'color', 'text'];
    for (const type of restoreOrder) {
      for (const [id, entry] of inventory) {
        if (entry.type !== type) continue;
        if (abortSignal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        restoreValidatedControl(entry, controls[id]);
      }
    }
  }

  return { collectUIControls, restoreUIControls };
}
