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
import { ICONS, createButton, createDisclosure, createIconButton } from '../components/controls.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { requireExactKeys } from '../../../utils/exact-record.js';
import { dispatchFromControl } from '../../actions/control-dispatch.js';

const INIT_KEYS = new Set(['state', 'deletedFieldsSection']);

function requireMethod(owner, methodName, label) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
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
    'getVarFields'
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

  function createText(tagName, className, textContent) {
    const element = ownerDocument.createElement(tagName);
    element.className = className;
    element.textContent = textContent;
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

    deletedFieldsSection.hidden = false;
    const wrapper = ownerDocument.createElement('div');
    wrapper.className = 'disclosure-list deleted-fields-wrapper';
    const disclosure = createDisclosure({
      title: 'Deleted fields',
      description: `${formatCountOf(total, 'restorable item')}`,
      tip: 'deleted-fields',
      expanded: readPanelOpen(deletedFieldsSection),
      onToggle: expanded => {
        deletedFieldsSection.dataset.open = expanded ? 'true' : 'false';
      }
    });
    disclosure.root.id = 'deleted-fields-accordion-item';
    const list = ownerDocument.createElement('div');
    list.className = 'deleted-fields-list';
    list.id = 'deleted-fields-list';
    disclosure.content.appendChild(list);
    wrapper.appendChild(disclosure.root);

    function addGroup(title, entries, source) {
      if (entries.length === 0) return;
      list.appendChild(createText('h3', 'section-title', title));
      // Several rows of one name (a field deleted, another renamed to its
      // name and deleted too): each row's actions name its own by its place
      // among them (`which`), as the list shows them.
      const ofName = new Map();
      for (const { field } of entries) ofName.set(field.key, (ofName.get(field.key) ?? 0) + 1);
      const seen = new Map();
      for (const { field, index } of entries) {
        const place = (seen.get(field.key) ?? 0) + 1;
        seen.set(field.key, place);
        const which = ofName.get(field.key) > 1 ? String(place) : null;
        const row = ownerDocument.createElement('div');
        row.className = 'deleted-field-row';
        let fieldLabel = field.key;
        if (Object.hasOwn(field, '_originalKey')) {
          StateValidator.validateFieldKey(field._originalKey);
          fieldLabel = `${field.key} *`;
        }
        // Rows of one name are told apart by their place, the `which` their actions name.
        if (which !== null) fieldLabel = `${fieldLabel} (${which} of ${ofName.get(field.key)})`;
        const name = createText('span', 'deleted-field-name', fieldLabel);
        name.title = Object.hasOwn(field, '_originalKey')
          ? `${fieldLabel} (original: ${field._originalKey})`
          : fieldLabel;
        const buttons = ownerDocument.createElement('div');
        buttons.className = 'deleted-field-actions';
        // A row of the list: its actions are quiet, Restore the main one.
        const restoreButton = createButton({
          label: 'Restore',
          variant: 'quiet-primary',
          ariaLabel: `Restore ${field.key}`
        });
        restoreButton.dataset.action = 'restore-field';
        restoreButton.dataset.source = source;
        restoreButton.dataset.index = String(index);
        // A bin, as every delete of the sidebar's rows: the row's width is
        // its name's (a worded button left "S_s…").
        const purgeButton = createIconButton({
          label: `Delete ${field.key} for good…`,
          icon: ICONS.delete,
          tone: 'danger'
        });
        purgeButton.dataset.action = 'purge-field';
        purgeButton.dataset.source = source;
        purgeButton.dataset.index = String(index);
        if (which !== null) {
          restoreButton.dataset.which = which;
          purgeButton.dataset.which = which;
        }
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
        userDefinedId: null,
        which: readWhich(button)
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
    return { source, index, field, userDefinedId, which: readWhich(button) };
  }

  /** The row's place among the deleted fields of its name, when several share it. */
  function readWhich(button) {
    const which = button.dataset.which;
    if (which === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(which)) {
      throw new TypeError('Deleted field place must be a canonical positive integer');
    }
    return Number(which);
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
      userDefinedId,
      which
    } = readAction(button);
    // The deleted field as the actions name it: its name, and its place
    // among the deleted fields of that name when several share it.
    const named = which === undefined
      ? { field: { source, key: field.key } }
      : { field: { source, key: field.key }, which };
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
        title: `Delete "${field.key}" for good?`,
        message:
          'It leaves Deleted fields and can no longer be restored there, nor from a session saved after. Undo still brings it back.',
        confirmText: 'Delete for good',
        onConfirm: () => {
          const ownsInteraction = retired === false;
          retired = true;
          releaseTransient();
          if (!ownsInteraction || !isCapturedFieldCurrent()) return;
          void dispatchFromControl(
            'field.purge',
            named,
            { failure: 'Deleting the field for good failed', category: 'filter' }
          ).then(done => {
            if (done === null) return;
            getNotificationCenter().success(
              `Deleted "${field.key}" for good`,
              { category: 'filter', duration: 2500 }
            );
          });
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

    void dispatchFromControl(
      'field.restore',
      named,
      { failure: 'Could not restore the field', category: 'filter' }
    ).then(done => {
      if (done === null) return;
      getNotificationCenter().success(
        `Restored "${done.outcome.name}"`,
        { category: 'filter', duration: 2500 }
      );
    });
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
