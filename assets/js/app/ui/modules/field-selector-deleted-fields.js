/**
 * @fileoverview Exact deleted-field restore/purge panel contract.
 *
 * @module ui/modules/field-selector-deleted-fields
 */

import { getNotificationCenter } from '../../notification-center.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { FieldSource } from '../../utils/field-constants.js';
import { StateValidator } from '../../utils/state-validator.js';

const INIT_KEYS = new Set(['state', 'deletedFieldsSection']);

function requirePlainRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  requirePlainRecord(value, label);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new TypeError(`${label} contains unknown key "${key}"`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} requires key "${key}"`);
    }
  }
  return value;
}

function requireMethod(owner, methodName, label) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be exactly boolean`);
  }
  return value;
}

function requireTrue(value, label) {
  requireBoolean(value, label);
  if (value !== true) {
    throw new Error(`${label} did not complete`);
  }
  return true;
}

function requireError(value, label) {
  if (!(value instanceof Error)) {
    throw new TypeError(`${label} must fail with an Error`);
  }
  if (typeof value.message !== 'string' || value.message.length === 0) {
    throw new TypeError(`${label} Error must own a non-empty message`);
  }
  return value;
}

function requireIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseDeletedIndex(value) {
  if (value === '-1') return -1;
  if (
    typeof value !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new TypeError(
      'Deleted field index must be -1 or a canonical non-negative integer'
    );
  }
  return requireIndex(Number(value), 'Deleted field index');
}

function requireIdentifier(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireField(field, label) {
  if (
    field === null
    || typeof field !== 'object'
    || Array.isArray(field)
  ) {
    throw new TypeError(`${label} must be one field metadata object`);
  }
  StateValidator.validateFieldKey(field.key);
  return field;
}

function requireInventory(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  value.forEach((field, index) => {
    requireField(field, `${label}[${index}]`);
  });
  return value;
}

function requireDeletedEntries(value, inventory, source) {
  if (!Array.isArray(value)) {
    throw new TypeError(`Deleted ${source} fields must be an array`);
  }
  return value.map((entry, entryIndex) => {
    requireExactKeys(
      entry,
      new Set(['field', 'index']),
      `Deleted ${source} fields[${entryIndex}]`
    );
    const field = requireField(
      entry.field,
      `Deleted ${source} fields[${entryIndex}].field`
    );
    if (field._isDeleted !== true || field._isPurged === true) {
      throw new Error(
        `Deleted ${source} fields[${entryIndex}] must be restorable`
      );
    }
    const index = entry.index;
    if (index === -1) {
      requireIdentifier(
        field._userDefinedId,
        `Deleted ${source} virtual field identifier`
      );
    } else {
      requireIndex(index, `Deleted ${source} field index`);
      if (index >= inventory.length || inventory[index] !== field) {
        throw new Error(
          `Deleted ${source} field must reference its exact inventory slot`
        );
      }
    }
    return { field, index };
  });
}

function readPanelOpen(section) {
  const value = section.dataset.open;
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(
    'Deleted fields panel open state must be exactly true or false'
  );
}

function requireRestoreFieldResult(value) {
  requireExactKeys(
    value,
    new Set(['ok', 'originalKey', 'key', 'userDefinedId']),
    'Restore field result'
  );
  requireTrue(value.ok, 'Restore field result.ok');
  StateValidator.validateFieldKey(value.originalKey);
  StateValidator.validateFieldKey(value.key);
  if (value.userDefinedId !== null) {
    requireIdentifier(
      value.userDefinedId,
      'Restore field result.userDefinedId'
    );
  }
  return value;
}

function requireRestoreVirtualResult(value) {
  requireExactKeys(
    value,
    new Set(['ok', 'key', 'userDefinedId']),
    'Restore virtual field result'
  );
  requireTrue(value.ok, 'Restore virtual field result.ok');
  StateValidator.validateFieldKey(value.key);
  requireIdentifier(
    value.userDefinedId,
    'Restore virtual field result.userDefinedId'
  );
  return value;
}

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {HTMLElement} options.deletedFieldsSection
 */
export function initDeletedFieldsPanel(options) {
  requireExactKeys(options, INIT_KEYS, 'Deleted fields panel options');
  const { state, deletedFieldsSection } = options;
  for (const methodName of [
    'getDatasetGeneration',
    'getFields',
    'getUserDefinedFieldsRegistry',
    'getVarFields',
    'purgeDeletedField',
    'purgeUserDefinedField',
    'restoreField',
    'restoreUserDefinedField'
  ]) {
    requireMethod(state, methodName, 'Deleted fields panel state');
  }
  const ownerDocument = deletedFieldsSection?.ownerDocument;
  const view = ownerDocument?.defaultView;
  if (
    view === null
    || view === undefined
    || !(deletedFieldsSection instanceof view.HTMLElement)
  ) {
    throw new TypeError(
      'Deleted fields panel requires one document-owned HTMLElement'
    );
  }
  const registry = getFieldRegistry();
  for (const methodName of ['getDeletedFields']) {
    requireMethod(registry, methodName, 'Field registry');
  }
  const userDefinedRegistry = state.getUserDefinedFieldsRegistry();
  requireMethod(
    userDefinedRegistry,
    'getField',
    'User-defined field registry'
  );

  const lifecycle = new view.AbortController();
  const transientClosers = new Set();
  let destroyed = false;

  function assertAlive() {
    if (destroyed) {
      throw new Error('Deleted fields panel has been destroyed');
    }
  }

  function readDatasetGeneration() {
    const generation = state.getDatasetGeneration();
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError(
        'Deleted fields dataset generation must be a non-negative safe integer'
      );
    }
    return generation;
  }

  function ownTransient(close) {
    if (typeof close !== 'function') {
      throw new TypeError('Deleted field transient closer must be a function');
    }
    transientClosers.add(close);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      transientClosers.delete(close);
    };
  }

  function closeTransientInteractions() {
    const closers = [...transientClosers];
    transientClosers.clear();
    const failures = [];
    for (const close of closers) {
      try {
        close();
      } catch (error) {
        failures.push(requireError(
          error,
          'Deleted field transient cleanup'
        ));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Deleted field transient cleanup failed'
      );
    }
  }

  function reportActionFailure(error, action) {
    const exactError = requireError(error, `Deleted field ${action}`);
    console.error(exactError);
    getNotificationCenter().error(
      `Failed to ${action} field: ${exactError.message}`,
      { category: 'filter' }
    );
  }

  function readInventories() {
    return {
      obs: requireInventory(state.getFields(), 'Obs field inventory'),
      var: requireInventory(state.getVarFields(), 'Var field inventory')
    };
  }

  function getDeletedFields() {
    const inventories = readInventories();
    return {
      obs: requireDeletedEntries(
        registry.getDeletedFields(FieldSource.OBS),
        inventories.obs,
        FieldSource.OBS
      ),
      var: requireDeletedEntries(
        registry.getDeletedFields(FieldSource.VAR),
        inventories.var,
        FieldSource.VAR
      )
    };
  }

  function createElement(tagName, className, textContent = null) {
    const element = ownerDocument.createElement(tagName);
    if (className.length > 0) element.className = className;
    if (textContent !== null) element.textContent = textContent;
    return element;
  }

  function renderDeletedFieldsSection() {
    assertAlive();
    closeTransientInteractions();
    const deleted = getDeletedFields();
    const total = deleted.obs.length + deleted.var.length;
    if (total === 0) {
      deletedFieldsSection.hidden = true;
      deletedFieldsSection.replaceChildren();
      return;
    }

    const open = readPanelOpen(deletedFieldsSection);
    deletedFieldsSection.hidden = false;
    const wrapper = createElement(
      'div',
      'analysis-accordion deleted-fields-wrapper'
    );
    const item = createElement(
      'div',
      `analysis-accordion-item${open ? ' open' : ''}`
    );
    item.id = 'deleted-fields-accordion-item';
    const toggle = createElement(
      'button',
      'analysis-accordion-header'
    );
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.appendChild(
      createElement('span', 'analysis-accordion-title', 'Deleted Fields')
    );
    toggle.appendChild(
      createElement(
        'span',
        'analysis-accordion-desc',
        `${total} restorable item${total === 1 ? '' : 's'}`
      )
    );
    const chevron = createElement(
      'span',
      'analysis-accordion-chevron'
    );
    chevron.setAttribute('aria-hidden', 'true');
    toggle.appendChild(chevron);

    const content = createElement('div', 'analysis-accordion-content');
    content.appendChild(
      createElement(
        'div',
        'deleted-fields-hint',
        'Restore soft-deleted fields, or confirm deletion to remove restore capability.'
      )
    );
    const list = createElement('div', 'deleted-fields-list');
    list.id = 'deleted-fields-list';
    content.appendChild(list);
    item.appendChild(toggle);
    item.appendChild(content);
    wrapper.appendChild(item);

    toggle.addEventListener('click', () => {
      const next = !readPanelOpen(deletedFieldsSection);
      deletedFieldsSection.dataset.open = next ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      item.classList.toggle('open', next);
    }, { signal: lifecycle.signal });

    function addGroup(title, entries, source) {
      if (entries.length === 0) return;
      list.appendChild(
        createElement('div', 'deleted-fields-group-title', title)
      );
      for (const { field, index } of entries) {
        const row = createElement('div', 'deleted-field-row');
        let fieldLabel = field.key;
        if (Object.hasOwn(field, '_originalKey')) {
          StateValidator.validateFieldKey(field._originalKey);
          fieldLabel = `${field.key} *`;
        }
        const name = createElement(
          'span',
          'deleted-field-name',
          fieldLabel
        );
        if (Object.hasOwn(field, '_originalKey')) {
          name.title = `Original: ${field._originalKey}`;
        }
        const buttons = createElement('div', 'deleted-field-actions');
        const restoreButton = createElement(
          'button',
          'deleted-field-restore-btn',
          'Restore'
        );
        restoreButton.type = 'button';
        restoreButton.dataset.action = 'restore-field';
        restoreButton.dataset.source = source;
        restoreButton.dataset.index = String(index);
        const purgeButton = createElement(
          'button',
          'deleted-field-confirm-btn',
          'Confirm'
        );
        purgeButton.type = 'button';
        purgeButton.dataset.action = 'purge-field';
        purgeButton.dataset.source = source;
        purgeButton.dataset.index = String(index);
        purgeButton.title = (
          'Permanently confirm deletion (cannot be restored)'
        );
        if (index === -1) {
          const userDefinedId = requireIdentifier(
            field._userDefinedId,
            'Deleted virtual field identifier'
          );
          restoreButton.dataset.userDefinedId = userDefinedId;
          purgeButton.dataset.userDefinedId = userDefinedId;
        }
        buttons.appendChild(restoreButton);
        buttons.appendChild(purgeButton);
        row.appendChild(name);
        row.appendChild(buttons);
        list.appendChild(row);
      }
    }

    addGroup('Obs', deleted.obs, FieldSource.OBS);
    addGroup('Genes', deleted.var, FieldSource.VAR);
    deletedFieldsSection.replaceChildren(wrapper);
  }

  function readAction(button) {
    const source = button.dataset.source;
    if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
      throw new TypeError(
        'Deleted field action source must be exactly obs or var'
      );
    }
    const index = parseDeletedIndex(button.dataset.index);
    const inventories = readInventories();
    if (index >= 0) {
      const inventory = source === FieldSource.VAR
        ? inventories.var
        : inventories.obs;
      if (index >= inventory.length) {
        throw new RangeError(
          'Deleted field action index is outside its inventory'
        );
      }
      return {
        source,
        index,
        field: inventory[index],
        userDefinedId: null
      };
    }
    const userDefinedId = requireIdentifier(
      button.dataset.userDefinedId,
      'Deleted virtual field identifier'
    );
    const field = requireField(
      userDefinedRegistry.getField(userDefinedId),
      'Deleted virtual field'
    );
    return { source, index, field, userDefinedId };
  }

  deletedFieldsSection.addEventListener('click', (event) => {
    assertAlive();
    if (!(event.target instanceof view.Element)) {
      throw new TypeError('Deleted field click target must be an Element');
    }
    const button = event.target.closest(
      'button[data-action="purge-field"], button[data-action="restore-field"]'
    );
    if (button === null) return;
    if (!(button instanceof view.HTMLButtonElement)) {
      throw new TypeError(
        'Deleted field action must originate from a button'
      );
    }
    const action = button.dataset.action;
    if (action !== 'purge-field' && action !== 'restore-field') {
      throw new TypeError('Deleted field action is unsupported');
    }
    const {
      source,
      index,
      field,
      userDefinedId
    } = readAction(button);
    const datasetGeneration = readDatasetGeneration();

    const isCapturedFieldCurrent = () => {
      if (
        destroyed
        || readDatasetGeneration() !== datasetGeneration
      ) {
        return false;
      }
      if (index >= 0) {
        const fields = source === FieldSource.VAR
          ? state.getVarFields()
          : state.getFields();
        return Array.isArray(fields) && fields[index] === field;
      }
      return userDefinedRegistry.getField(userDefinedId) === field;
    };

    if (action === 'purge-field') {
      let releaseTransient = () => {};
      let retired = false;
      const closeDialog = showConfirmDialog({
        title: 'Confirm deletion',
        message:
          `Permanently confirm deletion of "${field.key}"?\n\n`
          + 'This removes restore capability for this field in the current session and in saved states.',
        confirmText: 'Confirm delete',
        onConfirm: () => {
          const ownsInteraction = retired === false;
          retired = true;
          releaseTransient();
          if (!ownsInteraction || !isCapturedFieldCurrent()) return;
          try {
            requireTrue(
              index >= 0
                ? state.purgeDeletedField(source, index)
                : state.purgeUserDefinedField(userDefinedId, source),
              'Deleted field purge result'
            );
            getNotificationCenter().success(
              `Confirmed deletion of "${field.key}"`,
              { category: 'filter', duration: 2500 }
            );
          } catch (error) {
            reportActionFailure(error, 'confirm deletion of');
          }
        },
        onCancel: () => {
          retired = true;
          releaseTransient();
        }
      });
      releaseTransient = ownTransient(() => {
        retired = true;
        closeDialog();
      });
      return;
    }

    try {
      const result = index >= 0
        ? requireRestoreFieldResult(state.restoreField(source, index))
        : requireRestoreVirtualResult(
            state.restoreUserDefinedField(userDefinedId, source)
          );
      getNotificationCenter().success(
        `Restored "${result.key}"`,
        { category: 'filter', duration: 2500 }
      );
    } catch (error) {
      reportActionFailure(error, 'restore');
    }
  }, { signal: lifecycle.signal });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const failures = [];
    for (const cleanup of [
      closeTransientInteractions,
      () => lifecycle.abort(),
      () => deletedFieldsSection.replaceChildren()
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(requireError(error, 'Deleted fields panel cleanup'));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Deleted fields panel cleanup failed'
      );
    }
  }

  return { destroy, renderDeletedFieldsSection };
}
